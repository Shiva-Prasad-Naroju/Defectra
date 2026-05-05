"""Live inspection upload endpoints."""

import json
import logging
import os
import re
import uuid
from pathlib import Path

import aiofiles
from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile, status

from config import get_settings
from models import Defect, User, UserLog
from utils.deps import get_current_user

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/defects", tags=["defects"])

REPO_ROOT = Path(__file__).resolve().parent.parent.parent
UPLOADS_DIR = REPO_ROOT / "uploads"

_CHUNK_SIZE = 1024 * 1024


async def _read_upload_with_limit(upload: UploadFile, max_bytes: int) -> bytes:
    """Read multipart file in chunks; abort above max_bytes (413)."""
    chunks: list[bytes] = []
    total = 0
    while True:
        chunk = await upload.read(_CHUNK_SIZE)
        if not chunk:
            break
        total += len(chunk)
        if total > max_bytes:
            raise HTTPException(
                status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
                detail=(
                    f"Image exceeds server limit ({max_bytes // (1024 * 1024)} MB). "
                    "The app should optimize before upload — try again or contact support."
                ),
            )
        chunks.append(chunk)
    return b"".join(chunks)


async def _store_defect_upload(
    *,
    user: User,
    image: UploadFile,
    tower: str,
    floor: str,
    flat: str,
    room: str,
    description: str,
) -> dict[str, str]:
    if not tower.strip() or not floor.strip() or not flat.strip() or not room.strip():
        raise HTTPException(status_code=400, detail="All metadata fields are required")

    if not image.content_type or not image.content_type.startswith("image/"):
        raise HTTPException(status_code=400, detail="Uploaded file must be an image")

    user_id = str(user.id)
    email_prefix = user.email.split("@")[0]
    folder_name = re.sub(r"[^\w.\-]", "_", email_prefix)

    user_dir = UPLOADS_DIR / folder_name
    user_dir.mkdir(parents=True, exist_ok=True)

    settings = get_settings()
    max_bytes = settings.defect_upload_max_mb * 1024 * 1024

    ext = os.path.splitext(image.filename or "img.jpg")[1] or ".jpg"
    filename = f"{uuid.uuid4()}{ext}"
    file_path = user_dir / filename

    content = await _read_upload_with_limit(image, max_bytes)

    async with aiofiles.open(file_path, "wb") as f:
        await f.write(content)

    if not file_path.exists() or file_path.stat().st_size == 0:
        logger.error("upload: file write failed for user %s → %s", user.email, file_path)
        raise HTTPException(status_code=500, detail="File storage failed — please retry")

    relative_path = f"uploads/{folder_name}/{filename}"

    defect = Defect(
        user_id=user_id,
        image_path=relative_path,
        tower=tower.strip(),
        floor=floor.strip(),
        flat=flat.strip(),
        room=room.strip(),
        description=description.strip(),
    )
    await defect.insert()
    await UserLog(user_id=user_id, action="upload").insert()

    logger.info(
        "upload: user=%s defect=%s path=%s size=%d bytes",
        user.email,
        defect.id,
        relative_path,
        file_path.stat().st_size,
    )

    return {"defect_id": str(defect.id), "image_path": relative_path}


@router.post("/upload", status_code=status.HTTP_201_CREATED)
async def upload_defect(
    tower: str = Form(...),
    floor: str = Form(...),
    flat: str = Form(...),
    room: str = Form(...),
    description: str = Form(""),
    image: UploadFile = File(...),
    user: User = Depends(get_current_user),
):
    return await _store_defect_upload(
        user=user,
        image=image,
        tower=tower,
        floor=floor,
        flat=flat,
        room=room,
        description=description,
    )


@router.post("/upload-batch", status_code=status.HTTP_201_CREATED)
async def upload_defects_batch(
    items_json: str = Form(...),
    images: list[UploadFile] = File(...),
    user: User = Depends(get_current_user),
):
    try:
        items = json.loads(items_json)
    except json.JSONDecodeError as exc:
        raise HTTPException(status_code=400, detail=f"Invalid items_json payload: {exc.msg}") from exc

    if not isinstance(items, list) or not items:
        raise HTTPException(status_code=400, detail="items_json must be a non-empty array")

    if len(items) != len(images):
        raise HTTPException(
            status_code=400,
            detail="items_json and images length mismatch",
        )

    results: list[dict[str, object]] = []
    success_count = 0

    for idx, (item, image) in enumerate(zip(items, images)):
        if not isinstance(item, dict):
            results.append({"index": idx, "ok": False, "error": "Invalid item object"})
            continue
        try:
            saved = await _store_defect_upload(
                user=user,
                image=image,
                tower=str(item.get("tower", "")),
                floor=str(item.get("floor", "")),
                flat=str(item.get("flat", "")),
                room=str(item.get("room", "")),
                description=str(item.get("description", "")),
            )
            success_count += 1
            results.append({"index": idx, "ok": True, **saved})
        except HTTPException as exc:
            results.append({"index": idx, "ok": False, "error": exc.detail})
        except Exception as exc:
            logger.exception("upload-batch: unexpected error at index=%d", idx)
            results.append({"index": idx, "ok": False, "error": str(exc)})

    return {
        "total": len(items),
        "success_count": success_count,
        "failure_count": len(items) - success_count,
        "results": results,
    }


@router.get("/my")
async def my_defects(user: User = Depends(get_current_user)):
    defects = await Defect.find(Defect.user_id == str(user.id)).sort("-created_at").to_list()
    return [
        {
            "id": str(d.id),
            "image_path": d.image_path,
            "tower": d.tower,
            "floor": d.floor,
            "flat": d.flat,
            "room": d.room,
            "description": d.description,
            "created_at": d.created_at.isoformat(),
        }
        for d in defects
    ]
