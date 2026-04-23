"""vLLM OpenAI-compatible chat completions (multimodal PMO inspection)."""

from __future__ import annotations

import base64
import json
import logging
from collections.abc import AsyncIterator
from typing import Any

import httpx

from config import get_settings
from prompt import PMO_DEFECT_INSPECTION_PROMPT

logger = logging.getLogger(__name__)


def _data_url(image_bytes: bytes, mime_type: str) -> str:
    b64 = base64.standard_b64encode(image_bytes).decode("ascii")
    return f"data:{mime_type};base64,{b64}"


def _vllm_404_hint(status_code: int, url: str) -> str:
    """404 on /v1/chat/completions usually means VLLM_BASE_URL points at FastAPI (wrong port)."""
    if status_code != 404:
        return ""
    if "/v1/chat/completions" not in url:
        return ""
    return (
        " — Likely cause: Defectra (uvicorn) and vLLM share the same port, so POST /v1/chat/completions "
        "hits FastAPI (404). Fix: run vLLM on one port and Defectra on another (e.g. vLLM :8000 with "
        "VLLM_BASE_URL=http://127.0.0.1:8000, uvicorn on :8010 and VITE_API_PROXY_TARGET=http://127.0.0.1:8010), "
        "or run vLLM on :8001 and set VLLM_BASE_URL=http://127.0.0.1:8001."
    )


def _format_http_error(resp: httpx.Response) -> str:
    try:
        err: Any = resp.json()
    except json.JSONDecodeError:
        body = (resp.text or "").strip()
        if not body:
            return f"vLLM returned HTTP {resp.status_code} with no parseable body."
        return f"vLLM HTTP {resp.status_code}: {body[:2000]}"

    if isinstance(err, dict):
        nested = err.get("error")
        if isinstance(nested, dict):
            msg = nested.get("message")
            if isinstance(msg, str) and msg.strip():
                return f"vLLM error ({resp.status_code}): {msg.strip()}"
        detail = err.get("detail")
        if detail is not None:
            if isinstance(detail, str):
                return f"vLLM error ({resp.status_code}): {detail}"
            return f"vLLM error ({resp.status_code}): {json.dumps(detail)[:1500]}"
        return f"vLLM error ({resp.status_code}): {json.dumps(err)[:1500]}"
    return f"vLLM error ({resp.status_code}): {str(err)[:1500]}"


def _message_content_to_string(content: Any) -> str:
    if content is None:
        return ""
    if isinstance(content, str):
        return content.strip()
    if isinstance(content, list):
        parts: list[str] = []
        for part in content:
            if not isinstance(part, dict):
                continue
            if part.get("type") == "text":
                t = part.get("text")
                if isinstance(t, str) and t.strip():
                    parts.append(t.strip())
        return "\n\n".join(parts).strip()
    return str(content).strip()


def _extract_assistant_text(data: dict[str, Any]) -> str:
    choices = data.get("choices")
    if not isinstance(choices, list) or not choices:
        raise RuntimeError(
            "The model response had no choices. Check VLLM_MODEL matches --served-model-name."
        )
    first = choices[0]
    if not isinstance(first, dict):
        raise RuntimeError("The model response choices[0] was not an object.")
    msg = first.get("message")
    if not isinstance(msg, dict):
        raise RuntimeError("The model response had no choices[0].message object.")
    text = _message_content_to_string(msg.get("content"))
    if not text:
        raise RuntimeError(
            "The model returned an empty choices[0].message.content. "
            "Try lowering image size or increasing VLLM_MAX_TOKENS."
        )
    return text


def _build_chat_body(
    *,
    model: str,
    instructions: str,
    data_url: str,
    temperature: float,
    max_tokens: int,
    stream: bool = False,
) -> dict[str, Any]:
    body: dict[str, Any] = {
        "model": model,
        "messages": [
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": instructions},
                    {"type": "image_url", "image_url": {"url": data_url}},
                ],
            }
        ],
        "temperature": temperature,
        "max_tokens": max_tokens,
    }
    if stream:
        body["stream"] = True
    return body


def _delta_content_from_sse_payload(obj: dict[str, Any]) -> str:
    choices = obj.get("choices")
    if not isinstance(choices, list) or not choices:
        return ""
    first = choices[0]
    if not isinstance(first, dict):
        return ""
    delta = first.get("delta")
    if not isinstance(delta, dict):
        return ""
    content = delta.get("content")
    if isinstance(content, str):
        return content
    return ""


async def generate_inspection_report(
    *,
    image_bytes: bytes,
    mime_type: str,
    prompt: str | None = None,
) -> str:
    settings = get_settings()
    url = settings.chat_completions_url()
    body = _build_chat_body(
        model=settings.vllm_model,
        instructions=prompt or PMO_DEFECT_INSPECTION_PROMPT,
        data_url=_data_url(image_bytes, mime_type),
        temperature=settings.vllm_temperature,
        max_tokens=settings.vllm_max_tokens,
    )

    headers: dict[str, str] = {"Content-Type": "application/json"}
    if settings.vllm_api_key.strip():
        headers["Authorization"] = f"Bearer {settings.vllm_api_key.strip()}"

    async with httpx.AsyncClient(timeout=settings.http_timeout_s) as client:
        try:
            resp = await client.post(url, json=body, headers=headers)
        except httpx.RequestError as e:
            logger.exception("vLLM request failed")
            raise RuntimeError(
                f"Could not reach vLLM at {url}. Is the server running and reachable? ({e})"
            ) from e

        if resp.status_code >= 400:
            raise RuntimeError(_format_http_error(resp) + _vllm_404_hint(resp.status_code, url))

        try:
            data = resp.json()
        except json.JSONDecodeError as e:
            raw = (resp.text or "")[:2000]
            logger.warning("vLLM non-JSON body: %s", raw)
            raise RuntimeError(
                "The vision server returned a response that was not valid JSON. "
                f"First bytes: {raw[:500]!r}"
            ) from e

        if not isinstance(data, dict):
            raise RuntimeError(
                "The vision server returned JSON that was not an object; cannot read choices."
            )

        return _extract_assistant_text(data)


async def stream_inspection_report_deltas(
    *,
    image_bytes: bytes,
    mime_type: str,
    prompt: str | None = None,
) -> AsyncIterator[str]:
    """Yield assistant text fragments from vLLM OpenAI-compatible SSE stream."""
    settings = get_settings()
    url = settings.chat_completions_url()
    body = _build_chat_body(
        model=settings.vllm_model,
        instructions=prompt or PMO_DEFECT_INSPECTION_PROMPT,
        data_url=_data_url(image_bytes, mime_type),
        temperature=settings.vllm_temperature,
        max_tokens=settings.vllm_max_tokens,
        stream=True,
    )

    headers: dict[str, str] = {"Content-Type": "application/json"}
    if settings.vllm_api_key.strip():
        headers["Authorization"] = f"Bearer {settings.vllm_api_key.strip()}"

    async with httpx.AsyncClient(timeout=settings.http_timeout_s) as client:
        try:
            async with client.stream("POST", url, json=body, headers=headers) as resp:
                if resp.status_code >= 400:
                    err_bytes = await resp.aread()
                    try:
                        err_json = json.loads(err_bytes.decode("utf-8"))
                        detail = err_json.get("error", err_json)
                        if isinstance(detail, dict) and "message" in detail:
                            detail = detail["message"]
                    except Exception:
                        detail = err_bytes.decode("utf-8", errors="replace")[:2000]
                    raise RuntimeError(
                        f"vLLM error ({resp.status_code}): {detail}"
                        + _vllm_404_hint(resp.status_code, url)
                    )

                async for line in resp.aiter_lines():
                    raw = line.strip()
                    if not raw or raw.startswith(":"):
                        continue
                    if not raw.startswith("data:"):
                        continue
                    payload = raw[5:].lstrip()
                    if payload == "[DONE]":
                        break
                    try:
                        obj: Any = json.loads(payload)
                    except json.JSONDecodeError:
                        continue
                    if not isinstance(obj, dict):
                        continue
                    err = obj.get("error")
                    if isinstance(err, dict):
                        msg = err.get("message", json.dumps(err))
                        raise RuntimeError(f"vLLM stream error: {msg}")
                    piece = _delta_content_from_sse_payload(obj)
                    if piece:
                        yield piece
        except httpx.RequestError as e:
            logger.exception("vLLM stream request failed")
            raise RuntimeError(
                f"Could not reach vLLM at {url}. Is the server running and reachable? ({e})"
            ) from e


async def stream_text_chat_completion_deltas(
    *,
    messages: list[dict[str, Any]],
    max_tokens: int | None = None,
    temperature: float | None = None,
) -> AsyncIterator[str]:
    """Yield assistant text fragments from vLLM OpenAI-compatible SSE (text-only chat)."""
    settings = get_settings()
    url = settings.chat_completions_url()
    cap = max_tokens if max_tokens is not None else settings.vllm_max_tokens
    body: dict[str, Any] = {
        "model": settings.vllm_model,
        "messages": messages,
        "temperature": (
            settings.vllm_temperature if temperature is None else temperature
        ),
        "max_tokens": cap,
        "stream": True,
    }

    headers: dict[str, str] = {"Content-Type": "application/json"}
    if settings.vllm_api_key.strip():
        headers["Authorization"] = f"Bearer {settings.vllm_api_key.strip()}"

    async with httpx.AsyncClient(timeout=settings.http_timeout_s) as client:
        try:
            async with client.stream("POST", url, json=body, headers=headers) as resp:
                if resp.status_code >= 400:
                    err_bytes = await resp.aread()
                    try:
                        err_json = json.loads(err_bytes.decode("utf-8"))
                        detail = err_json.get("error", err_json)
                        if isinstance(detail, dict) and "message" in detail:
                            detail = detail["message"]
                    except Exception:
                        detail = err_bytes.decode("utf-8", errors="replace")[:2000]
                    raise RuntimeError(
                        f"vLLM error ({resp.status_code}): {detail}"
                        + _vllm_404_hint(resp.status_code, url)
                    )

                async for line in resp.aiter_lines():
                    raw = line.strip()
                    if not raw or raw.startswith(":"):
                        continue
                    if not raw.startswith("data:"):
                        continue
                    payload = raw[5:].lstrip()
                    if payload == "[DONE]":
                        break
                    try:
                        obj: Any = json.loads(payload)
                    except json.JSONDecodeError:
                        continue
                    if not isinstance(obj, dict):
                        continue
                    err = obj.get("error")
                    if isinstance(err, dict):
                        msg = err.get("message", json.dumps(err))
                        raise RuntimeError(f"vLLM stream error: {msg}")
                    piece = _delta_content_from_sse_payload(obj)
                    if piece:
                        yield piece
        except httpx.RequestError as e:
            logger.exception("vLLM text stream request failed")
            raise RuntimeError(
                f"Could not reach vLLM at {url}. Is the server running and reachable? ({e})"
            ) from e


async def generate_text_chat_completion(
    *,
    messages: list[dict[str, Any]],
    max_tokens: int | None = None,
    temperature: float | None = None,
) -> str:
    """Text-only OpenAI-style chat (follow-up questions; no image re-send)."""
    settings = get_settings()
    url = settings.chat_completions_url()
    cap = max_tokens if max_tokens is not None else settings.vllm_max_tokens
    body: dict[str, Any] = {
        "model": settings.vllm_model,
        "messages": messages,
        "temperature": (
            settings.vllm_temperature if temperature is None else temperature
        ),
        "max_tokens": cap,
        "stream": False,
    }

    headers: dict[str, str] = {"Content-Type": "application/json"}
    if settings.vllm_api_key.strip():
        headers["Authorization"] = f"Bearer {settings.vllm_api_key.strip()}"

    async with httpx.AsyncClient(timeout=settings.http_timeout_s) as client:
        try:
            resp = await client.post(url, json=body, headers=headers)
        except httpx.RequestError as e:
            logger.exception("vLLM text chat request failed")
            raise RuntimeError(
                f"Could not reach vLLM at {url}. Is the server running and reachable? ({e})"
            ) from e

        if resp.status_code >= 400:
            raise RuntimeError(_format_http_error(resp) + _vllm_404_hint(resp.status_code, url))

        try:
            data = resp.json()
        except json.JSONDecodeError as e:
            raw = (resp.text or "")[:2000]
            raise RuntimeError(
                "The model server returned a response that was not valid JSON. "
                f"First bytes: {raw[:500]!r}"
            ) from e

        if not isinstance(data, dict):
            raise RuntimeError("The model returned JSON that was not an object.")
        return _extract_assistant_text(data)
