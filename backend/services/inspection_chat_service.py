"""Orchestrate vision (once per session) vs text follow-ups."""

from __future__ import annotations

import json
from collections.abc import AsyncIterator
from typing import Any

from fastapi import HTTPException

from config import get_settings
from prompt import INSPECTION_ASSISTANT_SYSTEM, build_vision_instruction_prompt
from services.generate_client import (
    classify_construction_site_image,
    generate_inspection_report,
    generate_text_chat_completion,
    stream_inspection_report_deltas,
    stream_text_chat_completion_deltas,
)
from services import inspection_sessions
from services.inspection_intent import (
    classify_inspection_intent,
    followup_intent_system_suffix,
)
from services.inspection_markdown import parse_inspection_sections

def _max_image_bytes() -> int:
    return get_settings().max_image_upload_mb * 1024 * 1024


NON_CONSTRUCTION_SITE_IMAGE_MESSAGE = (
    "This image does not appear to contain any construction-related elements.\n"
    "Upload a site image showing structural components or defects for analysis."
)


def site_from_json(raw: str | None) -> dict[str, str]:
    if not raw or not str(raw).strip():
        return {}
    try:
        obj = json.loads(raw)
        if not isinstance(obj, dict):
            return {}
        out: dict[str, str] = {}
        for k in ("description", "location", "issue_type"):
            v = obj.get(k)
            if isinstance(v, str) and v.strip():
                out[k] = v.strip()
        return out
    except json.JSONDecodeError:
        return {}


def _vision_instructions(*, site: dict[str, str], message: str) -> str:
    """Build image-turn instructions: intent-aware (see ``build_vision_instruction_prompt``)."""
    intent = classify_inspection_intent(message)
    return build_vision_instruction_prompt(
        intent=intent,
        message=message,
        site=site,
    )


async def _vision_turn(
    sess: inspection_sessions.InspectionSession,
    *,
    message: str,
    site: dict[str, str],
    image_bytes: bytes,
    image_mime: str,
) -> dict[str, Any]:
    max_b = _max_image_bytes()
    if len(image_bytes) > max_b:
        raise HTTPException(
            400,
            detail=f"Image too large (max {max_b // (1024 * 1024)} MB).",
        )
    if not image_mime.startswith("image/"):
        raise HTTPException(400, detail="Upload an image file (e.g. PNG or JPEG).")

    # New photo in the same session replaces prior analysis and follow-up history.
    if sess.analysis_markdown:
        sess.analysis_markdown = ""
        sess.structured = None
        sess.conversation_after_analysis.clear()

    sess.image_mime = image_mime
    sess.image_bytes = image_bytes
    sess.site_notes = dict(site)

    try:
        if not await classify_construction_site_image(
            image_bytes=image_bytes,
            mime_type=image_mime,
        ):
            report = NON_CONSTRUCTION_SITE_IMAGE_MESSAGE
        else:
            instructions = _vision_instructions(site=site, message=message)
            report = await generate_inspection_report(
                image_bytes=image_bytes,
                mime_type=image_mime,
                prompt=instructions,
            )
    except Exception:
        sess.image_mime = None
        sess.image_bytes = None
        sess.site_notes = {}
        raise
        

    sess.analysis_markdown = report
    sess.structured = parse_inspection_sections(report)
    sess.conversation_after_analysis.clear()

    return {
        "session_id": sess.session_id,
        "reply_markdown": report,
        "structured": sess.structured,
        "used_vision": True,
        "inspection_intent": classify_inspection_intent(message),
    }


async def _followup_turn(sess: inspection_sessions.InspectionSession, *, message: str) -> dict[str, Any]:
    msg = message.strip()
    if not sess.analysis_markdown:
        raise HTTPException(
            status_code=400,
            detail="Attach a site photo in the chat first, then you can ask follow-up questions.",
        )
    if not msg:
        raise HTTPException(400, detail="Type a message or attach a photo to analyze.")

    hist = sess.conversation_after_analysis
    intent_suffix = followup_intent_system_suffix(msg)
    messages: list[dict[str, Any]] = [
        {
            "role": "system",
            "content": (
                f"{INSPECTION_ASSISTANT_SYSTEM}{intent_suffix}\n\n"
                "--- PRIOR IMAGE ANALYSIS (authoritative) ---\n"
                f"{sess.analysis_markdown}"
            ),
        },
    ]
    for turn in hist[-20:]:
        messages.append({"role": turn["role"], "content": turn["content"]})

    messages.append({"role": "user", "content": msg})
    answer = await generate_text_chat_completion(
        messages=messages,
        temperature=get_settings().inspection_chat_temperature,
    )
    hist.append({"role": "user", "content": msg})
    hist.append({"role": "assistant", "content": answer})

    return {
        "session_id": sess.session_id,
        "reply_markdown": answer,
        "structured": None,
        "used_vision": False,
        "inspection_intent": classify_inspection_intent(msg),
    }


async def handle_chat_turn(
    *,
    session_id: str,
    message: str,
    site_json: str | None,
    image_bytes: bytes | None,
    image_mime: str | None,
) -> dict[str, Any]:
    site = site_from_json(site_json)

    async def _fn(sess: inspection_sessions.InspectionSession) -> dict[str, Any]:
        if image_bytes and len(image_bytes) > 0 and image_mime:
            return await _vision_turn(
                sess,
                message=message,
                site=site,
                image_bytes=image_bytes,
                image_mime=image_mime,
            )
        return await _followup_turn(sess, message=message)

    result, err = await inspection_sessions.run_with_session(session_id, _fn)
    if err == "not_found":
        raise HTTPException(
            status_code=404,
            detail="Unknown session. Refresh the page and try again.",
        )
    if err:
        raise HTTPException(status_code=500, detail=err)
    assert result is not None
    return result


def _sse(data: dict[str, Any]) -> bytes:
    return f"data: {json.dumps(data, ensure_ascii=False)}\n\n".encode("utf-8")


async def iter_inspection_chat_sse(
    *,
    session_id: str,
    message: str,
    site_json: str | None,
    image_bytes: bytes | None,
    image_mime: str | None,
) -> AsyncIterator[bytes]:
    """Server-Sent Events: chunk objects, then done; duplicates JSON /message fields without double render."""
    site = site_from_json(site_json)
    try:
        async with inspection_sessions.locked_session(session_id) as sess:
            if image_bytes and len(image_bytes) > 0 and image_mime:
                if len(image_bytes) > _max_image_bytes():
                    yield _sse(
                        {
                            "type": "error",
                            "detail": f"Image too large (max {get_settings().max_image_upload_mb} MB).",
                        },
                    )
                    yield b"data: [DONE]\n\n"
                    return
                if not image_mime.startswith("image/"):
                    yield _sse(
                        {
                            "type": "error",
                            "detail": "Upload an image file (e.g. PNG or JPEG).",
                        }
                    )
                    yield b"data: [DONE]\n\n"
                    return

                if sess.analysis_markdown:
                    sess.analysis_markdown = ""
                    sess.structured = None
                    sess.conversation_after_analysis.clear()

                sess.image_mime = image_mime
                sess.image_bytes = image_bytes
                sess.site_notes = dict(site)
                vision_intent = classify_inspection_intent(message)
                try:
                    if not await classify_construction_site_image(
                        image_bytes=image_bytes,
                        mime_type=image_mime,
                    ):
                        text = NON_CONSTRUCTION_SITE_IMAGE_MESSAGE
                        yield _sse({"type": "chunk", "text": text})
                    else:
                        instructions = _vision_instructions(site=site, message=message)
                        pieces: list[str] = []
                        async for piece in stream_inspection_report_deltas(
                            image_bytes=image_bytes,
                            mime_type=image_mime,
                            prompt=instructions,
                        ):
                            pieces.append(piece)
                            yield _sse({"type": "chunk", "text": piece})
                        text = "".join(pieces)
                    sess.analysis_markdown = text
                    sess.structured = parse_inspection_sections(text)
                    sess.conversation_after_analysis.clear()
                    yield _sse(
                        {"type": "done", "used_vision": True, "inspection_intent": vision_intent}
                    )
                except Exception as e:
                    sess.image_mime = None
                    sess.image_bytes = None
                    sess.site_notes = {}
                    sess.analysis_markdown = ""
                    sess.structured = None
                    yield _sse({"type": "error", "detail": str(e)})
                yield b"data: [DONE]\n\n"
                return

            msg = message.strip()
            if not sess.analysis_markdown:
                yield _sse(
                    {
                        "type": "error",
                        "detail": (
                            "Attach a site photo in the chat first, then you can ask "
                            "follow-up questions."
                        ),
                    }
                )
                yield b"data: [DONE]\n\n"
                return
            if not msg:
                yield _sse(
                    {
                        "type": "error",
                        "detail": "Type a message or attach a photo to analyze.",
                    }
                )
                yield b"data: [DONE]\n\n"
                return

            hist = sess.conversation_after_analysis
            follow_suffix = followup_intent_system_suffix(msg)
            messages: list[dict[str, Any]] = [
                {
                    "role": "system",
                    "content": (
                        f"{INSPECTION_ASSISTANT_SYSTEM}{follow_suffix}\n\n"
                        "--- PRIOR IMAGE ANALYSIS (authoritative) ---\n"
                        f"{sess.analysis_markdown}"
                    ),
                },
            ]
            for turn in hist[-20:]:
                messages.append({"role": turn["role"], "content": turn["content"]})
            messages.append({"role": "user", "content": msg})

            follow_buf: list[str] = []
            try:
                async for piece in stream_text_chat_completion_deltas(
                    messages=messages,
                    temperature=get_settings().inspection_chat_temperature,
                ):
                    follow_buf.append(piece)
                    yield _sse({"type": "chunk", "text": piece})
                answer = "".join(follow_buf)
                hist.append({"role": "user", "content": msg})
                hist.append({"role": "assistant", "content": answer})
                yield _sse(
                    {
                        "type": "done",
                        "used_vision": False,
                        "inspection_intent": classify_inspection_intent(msg),
                    }
                )
            except Exception as e:
                yield _sse({"type": "error", "detail": str(e)})
            yield b"data: [DONE]\n\n"
    except inspection_sessions.SessionNotFoundError:
        yield _sse(
            {
                "type": "error",
                "detail": "Unknown session. Refresh the page and try again.",
            }
        )
        yield b"data: [DONE]\n\n"
