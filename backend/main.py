"""FastAPI entrypoint.

Run from the backend directory:

    uvicorn main:app --reload --host 0.0.0.0 --port 8010

Use port **8010** for Defectra when vLLM already uses **8000** on the same machine
(`VLLM_BASE_URL=http://127.0.0.1:8000` in `.env`). If vLLM is on another port, set
`VLLM_BASE_URL` and match `VITE_API_PROXY_TARGET` to this app’s port.

Point Vite at this API with `VITE_API_PROXY_TARGET` (see repo root `.env`).
"""

from __future__ import annotations

import json
import logging
import os
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

# When started as `uvicorn backend.main:app` from the repo root, imports like `services`
# must resolve against this directory (same as `uvicorn main:app` from `backend/`).
_backend_dir = str(Path(__file__).resolve().parent)
if _backend_dir not in sys.path:
    sys.path.insert(0, _backend_dir)

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response, StreamingResponse
from pydantic import BaseModel, Field

from config import get_settings
from services import inspection_chat_service
from services import inspection_sessions
from services import landing_assistant_service
from services.generate_client import (
    generate_inspection_report,
    stream_inspection_report_deltas,
)
from services.image_format import normalize_upload_image_bytes

logger = logging.getLogger(__name__)

app = FastAPI(title="Defectra API", version="0.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

def _max_upload_bytes() -> int:
    return get_settings().max_image_upload_mb * 1024 * 1024


def _normalize_image_bytes_or_400(
    data: bytes,
    content_type: str | None,
    filename: str | None,
) -> tuple[bytes, str]:
    try:
        return normalize_upload_image_bytes(data, content_type, filename)
    except RuntimeError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e


# --- /api/ai-analysis (tags: ai-analysis) ---
@app.post("/api/ai-analysis/analyze", tags=["ai-analysis"])
async def analyze_image(file: UploadFile = File(...)) -> dict[str, str]:
    data = await file.read()
    if len(data) == 0:
        raise HTTPException(status_code=400, detail="Empty file.")
    max_b = _max_upload_bytes()
    if len(data) > max_b:
        raise HTTPException(
            status_code=400,
            detail=f"Image too large (max {max_b // (1024 * 1024)} MB).",
        )

    data, mime = _normalize_image_bytes_or_400(data, file.content_type, file.filename)
    if not mime.startswith("image/"):
        raise HTTPException(
            status_code=400,
            detail="Upload an image file (e.g. PNG, JPEG, HEIC, WebP).",
        )

    try:
        report = await generate_inspection_report(
            image_bytes=data,
            mime_type=mime,
        )
    except RuntimeError as e:
        logger.warning("vLLM inspection failed: %s", e)
        raise HTTPException(status_code=502, detail=str(e)) from e
    except Exception as e:
        logger.exception("Unexpected error during analysis")
        raise HTTPException(
            status_code=500,
            detail="Analysis failed. Check server logs.",
        ) from e

    return {"report": report}


@app.post("/api/ai-analysis/analyze-stream", tags=["ai-analysis"])
async def analyze_image_stream(file: UploadFile = File(...)) -> StreamingResponse:
    data = await file.read()
    if len(data) == 0:
        raise HTTPException(status_code=400, detail="Empty file.")
    max_b = _max_upload_bytes()
    if len(data) > max_b:
        raise HTTPException(
            status_code=400,
            detail=f"Image too large (max {max_b // (1024 * 1024)} MB).",
        )

    data, mime = _normalize_image_bytes_or_400(data, file.content_type, file.filename)
    if not mime.startswith("image/"):
        raise HTTPException(
            status_code=400,
            detail="Upload an image file (e.g. PNG, JPEG, HEIC, WebP).",
        )

    async def event_gen():
        try:
            async for chunk in stream_inspection_report_deltas(
                image_bytes=data,
                mime_type=mime,
            ):
                line = json.dumps({"d": chunk}, ensure_ascii=False)
                yield f"data: {line}\n\n".encode("utf-8")
        except RuntimeError as e:
            logger.warning("vLLM stream failed: %s", e)
            err_line = json.dumps({"error": str(e)}, ensure_ascii=False)
            yield f"data: {err_line}\n\n".encode("utf-8")
        except Exception:
            logger.exception("Unexpected error during stream")
            err_line = json.dumps(
                {"error": "Analysis failed. Check server logs."},
                ensure_ascii=False,
            )
            yield f"data: {err_line}\n\n".encode("utf-8")
        yield b"data: [DONE]\n\n"

    return StreamingResponse(
        event_gen(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


# --- /api/chat (tags: inspection-chat) ---
@app.post("/api/chat/session", tags=["inspection-chat"])
async def create_session() -> dict[str, str]:
    s = await inspection_sessions.create_session()
    return {"session_id": s.session_id}


@app.delete("/api/chat/session/{session_id}", tags=["inspection-chat"])
async def delete_session(session_id: str) -> dict[str, bool]:
    ok = await inspection_sessions.delete_session(session_id)
    if not ok:
        raise HTTPException(status_code=404, detail="Session not found.")
    return {"ok": True}


@app.post("/api/chat/message", tags=["inspection-chat"])
async def chat_message(
    session_id: str = Form(...),
    message: str = Form(""),
    site_context: str = Form(""),
    image: UploadFile | None = File(None),
) -> dict:
    data = b""
    mime: str | None = None
    if image is not None and getattr(image, "filename", None):
        data = await image.read()
        if len(data) > 0:
            max_b = _max_upload_bytes()
            if len(data) > max_b:
                raise HTTPException(
                    status_code=400,
                    detail=f"Image too large (max {max_b // (1024 * 1024)} MB).",
                )
            data, mime = _normalize_image_bytes_or_400(
                data,
                image.content_type,
                image.filename,
            )
            if not mime.startswith("image/"):
                raise HTTPException(
                    status_code=400,
                    detail="Upload an image file (e.g. PNG, JPEG, HEIC, WebP).",
                )

    try:
        return await inspection_chat_service.handle_chat_turn(
            session_id=session_id.strip(),
            message=message or "",
            site_json=site_context or None,
            image_bytes=data if len(data) > 0 else None,
            image_mime=mime,
        )
    except HTTPException:
        raise
    except RuntimeError as e:
        logger.warning("Chat model error: %s", e)
        raise HTTPException(status_code=502, detail=str(e)) from e
    except Exception:
        logger.exception("Chat message failed")
        raise HTTPException(status_code=500, detail="Chat failed.") from None


@app.post("/api/chat/message/stream", tags=["inspection-chat"])
async def chat_message_stream(
    session_id: str = Form(...),
    message: str = Form(""),
    site_context: str = Form(""),
    image: UploadFile | None = File(None),
) -> StreamingResponse:
    """SSE stream: `data: {"type":"chunk","text":"..."}` then `{"type":"done",...}` then `[DONE]`."""
    data = b""
    mime: str | None = None
    if image is not None and getattr(image, "filename", None):
        data = await image.read()
        if len(data) > 0:
            max_b = _max_upload_bytes()
            if len(data) > max_b:
                raise HTTPException(
                    status_code=400,
                    detail=f"Image too large (max {max_b // (1024 * 1024)} MB).",
                )
            data, mime = _normalize_image_bytes_or_400(
                data,
                image.content_type,
                image.filename,
            )
            if not mime.startswith("image/"):
                raise HTTPException(
                    status_code=400,
                    detail="Upload an image file (e.g. PNG, JPEG, HEIC, WebP).",
                )

    async def gen():
        try:
            async for chunk in inspection_chat_service.iter_inspection_chat_sse(
                session_id=session_id.strip(),
                message=message or "",
                site_json=site_context or None,
                image_bytes=data if len(data) > 0 else None,
                image_mime=mime,
            ):
                yield chunk
        except Exception:
            logger.exception("Chat message stream failed")
            yield b'data: {"type":"error","detail":"Chat stream failed."}\n\n'
            yield b"data: [DONE]\n\n"

    return StreamingResponse(
        gen(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


class InspectionPdfTurnModel(BaseModel):
    role: str = Field(..., min_length=1, max_length=32)
    text: str = Field("", max_length=600_000)
    image: str | None = Field(None, max_length=45_000_000)


class InspectionPdfRequestModel(BaseModel):
    session_id: str = Field("", max_length=200)
    transcript: list[InspectionPdfTurnModel] = Field(..., min_length=1, max_length=150)


@app.post("/api/chat/inspection-pdf", tags=["inspection-chat"])
async def inspection_chat_pdf(body: InspectionPdfRequestModel) -> Response:
    """Build HTML with inlined JPEG data URLs, render with Puppeteer (Node), return PDF bytes."""
    from services import inspection_pdf_html
    from services import inspection_pdf_puppeteer

    for t in body.transcript:
        r = (t.role or "").strip().lower()
        if r not in ("user", "assistant"):
            raise HTTPException(
                status_code=400,
                detail=f"Invalid transcript role {t.role!r} (expected user or assistant).",
            )

    rows = [m.model_dump() for m in body.transcript]
    html, _n_inlined = inspection_pdf_html.build_inspection_pdf_html(
        transcript=rows,
        session_id=body.session_id.strip(),
    )
    if os.getenv("INSPECTION_PDF_LOG_HTML", "").lower() in ("1", "true", "yes"):
        logger.info("inspection_pdf full HTML (truncated to 300k): %s", html[:300_000])

    try:
        pdf_bytes = inspection_pdf_puppeteer.render_html_to_pdf_bytes(html)
    except RuntimeError as e:
        logger.warning("inspection PDF render failed: %s", e)
        raise HTTPException(
            status_code=503,
            detail=str(e),
        ) from e

    sid_short = (body.session_id or "local").strip()[:8] or "local"
    stamp = datetime.now(timezone.utc).date().isoformat()
    fname = f"SiteSureLabs-Inspection-Report-{sid_short}-{stamp}.pdf"
    return Response(
        content=pdf_bytes,
        media_type="application/pdf",
        headers={
            "Content-Disposition": f'attachment; filename="{fname}"',
        },
    )


# --- /api/assistant (tags: landing-assistant) ---
class LandingStreamBody(BaseModel):
    messages: list[dict[str, Any]] = Field(
        default_factory=list,
        description="Chat history: alternating user/assistant; last must be user.",
    )


@app.post("/api/assistant/landing/stream", tags=["landing-assistant"])
async def landing_assistant_stream(body: LandingStreamBody) -> StreamingResponse:
    """SSE: same chunk schema as inspection chat (`chunk` / `done` / `error`, then `[DONE]`)."""

    async def gen():
        try:
            async for chunk in landing_assistant_service.iter_landing_assistant_sse(
                body.messages,
            ):
                yield chunk
        except Exception:
            logger.exception("Landing assistant stream failed")
            yield b'data: {"type":"error","detail":"Assistant temporarily unavailable."}\n\n'
            yield b"data: [DONE]\n\n"

    return StreamingResponse(
        gen(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


@app.get("/api/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}
