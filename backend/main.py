"""Defectra API — FastAPI entry-point.

Start from repo root:
    uvicorn main:app --reload --host 0.0.0.0 --port 8010
"""

from __future__ import annotations

import logging
import re
import shutil
import sys
from contextlib import asynccontextmanager
from pathlib import Path

_backend_dir = str(Path(__file__).resolve().parent)
if _backend_dir not in sys.path:
    sys.path.insert(0, _backend_dir)

from beanie import PydanticObjectId
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from config import get_settings

from db import init_db
from models import Defect, User
from utils.security import hash_password

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(levelname)-8s  %(name)s  %(message)s",
)
logger = logging.getLogger(__name__)

REPO_ROOT = Path(__file__).resolve().parent.parent
UPLOADS_DIR = REPO_ROOT / "uploads"
UPLOADS_DIR.mkdir(exist_ok=True)

_HEX_RE = re.compile(r"^[0-9a-f]{24}$")

_settings = get_settings()
_cors_origins = list(_settings.cors_origins)
_cors_allow_credentials = "*" not in _cors_origins


async def _seed_admin() -> None:
    cfg = get_settings()
    existing = await User.find_one(User.email == cfg.admin_email)
    if existing:
        return
    user = User(
        email=cfg.admin_email,
        password=hash_password(cfg.admin_password),
        role="admin",
    )
    await user.insert()
    logger.info("Default admin created  →  %s", cfg.admin_email)


async def _migrate_image_paths() -> None:
    """One-time migration: fix Defect records whose image_path uses
    a raw MongoDB ObjectId as the folder instead of the email prefix.

    For each affected record the function:
      1. Looks up the owning User to derive the correct email-prefix folder.
      2. If the file exists in the OLD (ObjectId) directory, moves it to the
         correct email-prefix directory and updates the DB record.
      3. If the file already exists at the CORRECT path (moved manually), just
         updates the DB record.
      4. If the file is truly missing at both locations, marks the record with
         image_path = "missing/<original>" so the UI can show a placeholder
         instead of a broken image.
    """
    all_defects = await Defect.find_all().to_list()
    fixed = 0
    missing = 0

    for defect in all_defects:
        parts = defect.image_path.split("/")
        if len(parts) < 3 or parts[0] != "uploads":
            continue
        folder = parts[1]
        if not _HEX_RE.match(folder):
            continue

        try:
            owner = await User.get(PydanticObjectId(defect.user_id))
        except Exception:
            owner = None

        if not owner:
            logger.warning(
                "migration: defect %s references unknown user %s — skipping",
                defect.id, defect.user_id,
            )
            continue

        email_prefix = owner.email.split("@")[0]
        safe_folder = re.sub(r"[^\w.\-]", "_", email_prefix)
        filename = parts[-1]
        correct_path = f"uploads/{safe_folder}/{filename}"

        old_file = UPLOADS_DIR / folder / filename
        new_dir = UPLOADS_DIR / safe_folder
        new_file = new_dir / filename

        if new_file.exists():
            defect.image_path = correct_path
            await defect.save()
            fixed += 1
            logger.info("migration: updated path for defect %s → %s", defect.id, correct_path)
        elif old_file.exists():
            new_dir.mkdir(parents=True, exist_ok=True)
            shutil.move(str(old_file), str(new_file))
            defect.image_path = correct_path
            await defect.save()
            fixed += 1
            logger.info("migration: moved file and updated defect %s → %s", defect.id, correct_path)
        else:
            defect.image_path = f"missing/{folder}/{filename}"
            await defect.save()
            missing += 1
            logger.warning(
                "migration: file missing for defect %s (old path: %s)", defect.id, defect.image_path,
            )

    if fixed or missing:
        logger.info("migration complete: %d fixed, %d marked missing", fixed, missing)
    else:
        logger.info("migration: no orphaned image paths found")


async def _migrate_unverified_users() -> None:
    """One-time migration: mark pre-existing users as verified.
    Targets users who have is_verified=false but no verification_code
    (i.e. they registered before the OTP feature existed)."""
    result = await User.find(
        {"is_verified": False, "verification_code": None}
    ).update_many({"$set": {"is_verified": True}})
    if result.modified_count:
        logger.info("migration: marked %d pre-existing users as verified", result.modified_count)


@asynccontextmanager
async def lifespan(_app: FastAPI):
    await init_db()
    await _seed_admin()
    await _migrate_image_paths()
    await _migrate_unverified_users()
    yield


app = FastAPI(title="Defectra API", version="1.0.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=_cors_origins,
    allow_credentials=_cors_allow_credentials,
    allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type", "Accept"],
)

app.mount("/uploads", StaticFiles(directory=str(UPLOADS_DIR)), name="uploads")

from routes.auth import router as auth_router
from routes.defect import router as defect_router
from routes.admin import router as admin_router
from routes.chat import router as chat_router
from routes.assistant import router as assistant_router

app.include_router(auth_router)
app.include_router(defect_router)
app.include_router(admin_router)
app.include_router(chat_router)
app.include_router(assistant_router)


@app.get("/api/health")
async def health():
    return {"status": "ok"}
