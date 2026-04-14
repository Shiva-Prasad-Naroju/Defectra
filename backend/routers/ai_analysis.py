"""AI Analysis: image upload → PMO report via vLLM OpenAI chat completions."""

from __future__ import annotations

import json
import logging

from fastapi import APIRouter, File, HTTPException, UploadFile
from fastapi.responses import StreamingResponse

from services.generate_client import (
    generate_inspection_report,
    stream_inspection_report_deltas,
)

logger = logging.getLogger(__name__)

router = APIRouter()

MAX_BYTES = 20 * 1024 * 1024


@router.post("/analyze")
async def analyze_image(file: UploadFile = File(...)) -> dict[str, str]:
    if not file.content_type or not file.content_type.startswith("image/"):
        raise HTTPException(
            status_code=400,
            detail="Upload an image file (e.g. PNG or JPEG).",
        )

    data = await file.read()
    if len(data) == 0:
        raise HTTPException(status_code=400, detail="Empty file.")
    if len(data) > MAX_BYTES:
        raise HTTPException(
            status_code=400,
            detail=f"Image too large (max {MAX_BYTES // (1024 * 1024)} MB).",
        )

    try:
        report = await generate_inspection_report(
            image_bytes=data,
            mime_type=file.content_type,
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


@router.post("/analyze-stream")
async def analyze_image_stream(file: UploadFile = File(...)) -> StreamingResponse:
    if not file.content_type or not file.content_type.startswith("image/"):
        raise HTTPException(
            status_code=400,
            detail="Upload an image file (e.g. PNG or JPEG).",
        )

    data = await file.read()
    if len(data) == 0:
        raise HTTPException(status_code=400, detail="Empty file.")
    if len(data) > MAX_BYTES:
        raise HTTPException(
            status_code=400,
            detail=f"Image too large (max {MAX_BYTES // (1024 * 1024)} MB).",
        )

    mime = file.content_type

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
