"""Admin-only dashboard endpoints."""

import logging
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Literal, Optional

from beanie import PydanticObjectId
from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel, Field

from models import Defect, User, UserLog
from utils.deps import require_admin
from utils.security import hash_password

logger = logging.getLogger(__name__)

REPO_ROOT = Path(__file__).resolve().parent.parent.parent
UPLOADS_DIR = REPO_ROOT / "uploads"

router = APIRouter(prefix="/api/admin", tags=["admin"])


class AdminResetPasswordBody(BaseModel):
    new_password: str = Field(..., min_length=8, max_length=128)


class AdminRoleBody(BaseModel):
    role: Literal["user", "admin"]


async def _get_user_or_404(user_id: str) -> User:
    try:
        user = await User.get(PydanticObjectId(user_id))
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid user ID") from None
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    return user


async def _log_admin_action(
    admin: User,
    action: str,
    *,
    target: User,
) -> None:
    await UserLog(
        user_id=str(admin.id),
        action=action,
        target_user_id=str(target.id),
        target_email=target.email,
    ).insert()


async def _purge_user_defect_files(user_id: str) -> int:
    """Delete defect rows and image files for a user. Returns number of defects removed."""
    defects = await Defect.find(Defect.user_id == user_id).to_list()
    removed = 0
    for defect in defects:
        file_path = REPO_ROOT / defect.image_path
        if file_path.exists():
            try:
                file_path.unlink()
            except OSError as e:
                logger.error("admin: could not delete file %s: %s", file_path, e)
        await defect.delete()
        removed += 1
    return removed


async def _delete_user_profile_photo(user: User) -> None:
    if not user.profile_photo or not user.profile_photo.startswith("uploads/"):
        return
    path = REPO_ROOT / user.profile_photo
    try:
        path.unlink(missing_ok=True)
    except OSError as e:
        logger.warning("admin: profile photo unlink failed %s: %s", path, e)


def _is_user_enabled(u: User) -> bool:
    return not bool(getattr(u, "is_disabled", False))


async def _count_enabled_admins() -> int:
    admins = await User.find(User.role == "admin").to_list()
    return sum(1 for u in admins if _is_user_enabled(u))


async def _count_total_admins() -> int:
    return await User.find(User.role == "admin").count()


def _as_utc_aware(dt: datetime | None) -> datetime | None:
    """Mongo often returns naive datetimes that are UTC; JS needs an offset or Z to parse correctly."""
    if dt is None:
        return None
    if dt.tzinfo is None:
        return dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


def _iso_utc(dt: datetime | None) -> str | None:
    d = _as_utc_aware(dt)
    if d is None:
        return None
    # e.g. 2026-04-28T12:00:00.123+00:00 — works with new Date() in browsers
    return d.isoformat(timespec="milliseconds")


def _defect_to_dict(d: Defect, *, email: str | None = None, name: str | None = None) -> dict:
    out = {
        "id": str(d.id),
        "user_id": d.user_id,
        "image_path": d.image_path,
        "tower": d.tower,
        "floor": d.floor,
        "flat": d.flat,
        "room": d.room,
        "description": d.description,
        "created_at": d.created_at.isoformat(),
    }
    if email is not None:
        out["email"] = email
    if name is not None:
        out["name"] = name
    return out


@router.get("/users")
async def get_all_users(_: User = Depends(require_admin)):
    users = await User.find_all().sort("-created_at").to_list()

    user_ids = [str(u.id) for u in users]

    pipeline = [
        {"$match": {"user_id": {"$in": user_ids}}},
        {"$group": {"_id": "$user_id", "count": {"$sum": 1}}},
    ]
    upload_counts: dict[str, int] = {}
    async for doc in Defect.get_motor_collection().aggregate(pipeline):
        upload_counts[doc["_id"]] = doc["count"]

    log_pipeline = [
        {"$match": {"user_id": {"$in": user_ids}}},
        {"$group": {"_id": "$user_id", "last": {"$max": "$timestamp"}}},
    ]
    last_seen: dict[str, datetime] = {}
    async for doc in UserLog.get_motor_collection().aggregate(log_pipeline):
        uid = str(doc["_id"])
        ts = _as_utc_aware(doc.get("last"))
        if ts:
            last_seen[uid] = ts

    defect_last_pipeline = [
        {"$match": {"user_id": {"$in": user_ids}}},
        {"$group": {"_id": "$user_id", "last_upload": {"$max": "$created_at"}}},
    ]
    async for doc in Defect.get_motor_collection().aggregate(defect_last_pipeline):
        uid = str(doc["_id"])
        ts = _as_utc_aware(doc.get("last_upload"))
        if ts:
            prev = last_seen.get(uid)
            if prev is None or ts > prev:
                last_seen[uid] = ts

    logger.info("admin: fetched %d users", len(users))
    return [
        {
            "id": str(u.id),
            "email": u.email,
            "name": u.name,
            "role": u.role,
            "is_disabled": bool(u.is_disabled),
            "upload_count": upload_counts.get(str(u.id), 0),
            "last_activity": _iso_utc(last_seen.get(str(u.id)))
            or _iso_utc(_as_utc_aware(u.created_at)),
            "created_at": _iso_utc(_as_utc_aware(u.created_at)),
            "profile_photo": u.profile_photo,
        }
        for u in users
    ]


@router.post("/users/{user_id}/disable", status_code=status.HTTP_200_OK)
async def admin_disable_user_account(user_id: str, admin: User = Depends(require_admin)):
    if str(admin.id) == user_id:
        raise HTTPException(status_code=400, detail="You cannot disable your own account.")

    target = await _get_user_or_404(user_id)
    if target.is_disabled:
        raise HTTPException(status_code=400, detail="This account is already disabled.")

    if target.role == "admin" and _is_user_enabled(target):
        if await _count_enabled_admins() <= 1:
            raise HTTPException(
                status_code=400,
                detail="Cannot disable the last active administrator.",
            )

    target.is_disabled = True
    await target.save()
    await _log_admin_action(admin, "admin_disable_user", target=target)
    logger.info("admin: %s disabled user %s (%s)", admin.email, target.id, target.email)
    return {"ok": True, "is_disabled": True, "id": str(target.id)}


@router.post("/users/{user_id}/enable", status_code=status.HTTP_200_OK)
async def admin_enable_user_account(user_id: str, admin: User = Depends(require_admin)):
    target = await _get_user_or_404(user_id)
    if not target.is_disabled:
        raise HTTPException(status_code=400, detail="This account is already active.")

    target.is_disabled = False
    await target.save()
    await _log_admin_action(admin, "admin_enable_user", target=target)
    logger.info("admin: %s re-enabled user %s (%s)", admin.email, target.id, target.email)
    return {"ok": True, "is_disabled": False, "id": str(target.id)}


@router.delete("/users/{user_id}", status_code=status.HTTP_200_OK)
async def admin_delete_user_permanently(user_id: str, admin: User = Depends(require_admin)):
    if str(admin.id) == user_id:
        raise HTTPException(status_code=400, detail="You cannot delete your own account.")

    target = await _get_user_or_404(user_id)

    if target.role == "admin":
        if await _count_total_admins() <= 1:
            raise HTTPException(
                status_code=400,
                detail="Cannot delete the only administrator account.",
            )

    await _log_admin_action(admin, "admin_delete_user", target=target)

    n_defects = await _purge_user_defect_files(user_id)
    await _delete_user_profile_photo(target)

    # Remove activity logs where this user was the actor (not audit rows that reference them as target).
    await UserLog.get_motor_collection().delete_many({"user_id": user_id})

    await target.delete()

    logger.info(
        "admin: %s permanently deleted user %s (%s), defects_removed=%d",
        admin.email, user_id, target.email, n_defects,
    )
    return {"ok": True, "deleted_id": user_id, "defects_removed": n_defects}


@router.get("/users/{user_id}")
async def get_user_detail(user_id: str, _: User = Depends(require_admin)):
    user = await _get_user_or_404(user_id)
    return {
        "id": str(user.id),
        "email": user.email,
        "name": user.name,
        "role": user.role,
        "is_disabled": bool(user.is_disabled),
        "created_at": user.created_at.isoformat(),
        "mobile": user.mobile,
        "gender": user.gender,
        "age": user.age,
        "site": user.site,
        "location": user.location,
        "profile_photo": user.profile_photo,
    }


@router.post("/users/{user_id}/reset-password", status_code=status.HTTP_200_OK)
async def admin_reset_user_password(
    user_id: str,
    body: AdminResetPasswordBody,
    admin: User = Depends(require_admin),
):
    if str(admin.id) == user_id:
        raise HTTPException(
            status_code=400,
            detail="Change your own password from account settings, not from the admin console.",
        )
    target = await _get_user_or_404(user_id)
    target.password = hash_password(body.new_password)
    await target.save()
    await _log_admin_action(admin, "admin_reset_password", target=target)
    logger.info("admin: %s reset password for user %s", admin.email, target.email)
    return {"ok": True}


@router.patch("/users/{user_id}/role", status_code=status.HTTP_200_OK)
async def admin_set_user_role(user_id: str, body: AdminRoleBody, admin: User = Depends(require_admin)):
    if str(admin.id) == user_id:
        raise HTTPException(status_code=400, detail="You cannot change your own role.")

    target = await _get_user_or_404(user_id)
    new_role = body.role
    if new_role == target.role:
        return {"ok": True, "role": target.role}

    if target.role == "admin" and new_role == "user":
        if await _count_total_admins() <= 1:
            raise HTTPException(
                status_code=400,
                detail="Cannot demote the only administrator account.",
            )

    target.role = new_role
    await target.save()
    await _log_admin_action(admin, "admin_change_role", target=target)
    logger.info(
        "admin: %s set role for %s → %s",
        admin.email, target.email, new_role,
    )
    return {"ok": True, "role": target.role}


@router.get("/users/{user_id}/uploads")
async def get_user_uploads(user_id: str, _: User = Depends(require_admin)):
    defects = await Defect.find(Defect.user_id == user_id).sort("-created_at").to_list()
    logger.info("admin: fetched %d uploads for user %s", len(defects), user_id)
    return [_defect_to_dict(d) for d in defects]


@router.get("/uploads")
async def get_all_uploads(_: User = Depends(require_admin)):
    """Return every upload across all users, enriched with uploader identity."""
    defects = await Defect.find_all().sort("-created_at").to_list()
    user_ids = list({d.user_id for d in defects})
    users = await User.find(
        {"_id": {"$in": [PydanticObjectId(uid) for uid in user_ids]}}
    ).to_list()
    email_map = {str(u.id): u.email for u in users}
    name_map = {str(u.id): u.name for u in users}
    logger.info("admin: fetched all uploads (%d total)", len(defects))
    return [
        _defect_to_dict(
            d,
            email=email_map.get(d.user_id, "unknown"),
            name=name_map.get(d.user_id),
        )
        for d in defects
    ]


@router.get("/logs")
async def get_logs(
    date_from: Optional[str] = Query(None, description="ISO date, e.g. 2025-01-01"),
    date_to: Optional[str] = Query(None, description="ISO date, e.g. 2025-12-31"),
    _: User = Depends(require_admin),
):
    query = {}

    if date_from or date_to:
        ts_filter = {}
        if date_from:
            try:
                ts_filter["$gte"] = datetime.fromisoformat(date_from).replace(tzinfo=timezone.utc)
            except ValueError:
                raise HTTPException(status_code=400, detail="Invalid date_from format")
        if date_to:
            try:
                end = datetime.fromisoformat(date_to).replace(
                    hour=23, minute=59, second=59, tzinfo=timezone.utc,
                )
                ts_filter["$lte"] = end
            except ValueError:
                raise HTTPException(status_code=400, detail="Invalid date_to format")
        query["timestamp"] = ts_filter

    logs = await UserLog.find(query).sort("-timestamp").to_list()

    user_ids = list({log.user_id for log in logs})
    users = await User.find({"_id": {"$in": [PydanticObjectId(uid) for uid in user_ids]}}).to_list()
    email_map = {str(u.id): u.email for u in users}
    name_map = {str(u.id): u.name for u in users}

    logger.info("admin: fetched %d log entries", len(logs))
    return [
        {
            "id": str(log.id),
            "user_id": log.user_id,
            "email": email_map.get(log.user_id, "unknown"),
            "name": name_map.get(log.user_id),
            "action": log.action,
            "timestamp": log.timestamp.isoformat(),
            "target_user_id": log.target_user_id,
            "target_email": log.target_email,
        }
        for log in logs
    ]


@router.delete("/uploads/{upload_id}")
async def delete_upload(upload_id: str, admin: User = Depends(require_admin)):
    try:
        defect = await Defect.get(PydanticObjectId(upload_id))
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid upload ID")
    if not defect:
        raise HTTPException(status_code=404, detail="Upload not found")

    file_path = REPO_ROOT / defect.image_path
    file_deleted = False

    if file_path.exists():
        try:
            file_path.unlink()
            file_deleted = True
        except OSError as e:
            logger.error(
                "admin: failed to delete file %s for upload %s: %s",
                file_path, upload_id, e,
            )
            raise HTTPException(
                status_code=500,
                detail="Failed to delete file from storage. Database record preserved.",
            )
    else:
        file_deleted = True

    await defect.delete()

    await UserLog(
        user_id=str(admin.id),
        action=f"delete_upload:{upload_id}",
    ).insert()

    logger.info(
        "admin: deleted upload %s (file_deleted=%s, by=%s)",
        upload_id, file_deleted, admin.email,
    )
    return {"deleted": True, "id": upload_id}


def _start_of_utc_today() -> datetime:
    now = datetime.now(timezone.utc)
    return now.replace(hour=0, minute=0, second=0, microsecond=0)


@router.get("/stats")
async def get_stats(_: User = Depends(require_admin)):
    total_users = await User.count()
    disabled_users = await User.find(User.is_disabled == True).count()
    total_uploads = await Defect.count()
    total_logs = await UserLog.count()

    start_today = _start_of_utc_today()
    week_ago = datetime.now(timezone.utc) - timedelta(days=7)

    users_today = await User.find(User.created_at >= start_today).count()
    users_week = await User.find(User.created_at >= week_ago).count()
    uploads_today = await Defect.find(Defect.created_at >= start_today).count()
    uploads_week = await Defect.find(Defect.created_at >= week_ago).count()
    logs_today = await UserLog.find(UserLog.timestamp >= start_today).count()
    logs_week = await UserLog.find(UserLog.timestamp >= week_ago).count()

    return {
        "total_users": total_users,
        "disabled_users": disabled_users,
        "total_uploads": total_uploads,
        "total_logs": total_logs,
        "users_today": users_today,
        "users_week": users_week,
        "uploads_today": uploads_today,
        "uploads_week": uploads_week,
        "logs_today": logs_today,
        "logs_week": logs_week,
    }


@router.get("/debug/uploads")
async def debug_uploads(_: User = Depends(require_admin)):
    """Temporary debug endpoint: returns every Defect with file-existence check."""
    defects = await Defect.find_all().sort("-created_at").to_list()
    result = []
    for d in defects:
        file_abs = UPLOADS_DIR.parent / d.image_path
        result.append({
            "id": str(d.id),
            "user_id": d.user_id,
            "image_path": d.image_path,
            "file_exists": file_abs.exists(),
            "file_size": file_abs.stat().st_size if file_abs.exists() else None,
            "created_at": d.created_at.isoformat(),
        })
    return result


@router.get("/debug/storage")
async def debug_storage(_: User = Depends(require_admin)):
    """Temporary debug endpoint: lists physical files on disk under uploads/."""
    files = []
    for p in sorted(UPLOADS_DIR.rglob("*")):
        if p.is_file():
            files.append({
                "path": str(p.relative_to(UPLOADS_DIR.parent)),
                "size": p.stat().st_size,
            })
    return {"upload_dir": str(UPLOADS_DIR), "file_count": len(files), "files": files}
