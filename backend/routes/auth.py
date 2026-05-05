"""Registration, login, and profile endpoints."""

import logging
import re
import uuid
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile, status
from pydantic import BaseModel, EmailStr

from models import User, UserLog
from utils.deps import get_current_user
from utils.security import hash_password, verify_password, create_access_token

logger = logging.getLogger(__name__)
REPO_ROOT = Path(__file__).resolve().parent.parent.parent
UPLOADS_DIR = REPO_ROOT / "uploads"
PROFILE_DIR = UPLOADS_DIR / "profiles"
PROFILE_DIR.mkdir(parents=True, exist_ok=True)

router = APIRouter(prefix="/api/auth", tags=["auth"])

MSG_ADMIN_USE_USER_PORTAL = "Please sign in via the Login as Admin to access the Admin Portal."
MSG_ADMIN_PORTAL_USER_ONLY = "This sign-in is for administrator accounts only. Use the standard login for your account."
PROFILE_NAME_MAX_LENGTH = 80
PROFILE_SITE_MAX_LENGTH = 80
PROFILE_LOCATION_MAX_LENGTH = 120
PROFILE_AGE_MIN = 1
PROFILE_AGE_MAX = 89
PROFILE_GENDERS = {"Male", "Female", "Other"}


def _normalize_email(email: EmailStr | str) -> str:
    """Lowercase + strip for uniqueness and login lookup (RFC 5321 local-part case semantics)."""
    return str(email).strip().lower()


class RegisterRequest(BaseModel):
    email: EmailStr
    password: str
    name: str
    mobile: str


class LoginRequest(BaseModel):
    email: EmailStr
    password: str


@router.post("/register", status_code=status.HTTP_201_CREATED)
async def register(body: RegisterRequest):
    if not body.password or len(body.password) < 4:
        raise HTTPException(status_code=400, detail="Password must be at least 4 characters")
    if not body.name or len(body.name.strip()) < 2:
        raise HTTPException(status_code=400, detail="Full name must be at least 2 characters")
    mobile = body.mobile.strip()
    if not re.fullmatch(r"\+?[0-9][0-9\s\-]{7,14}", mobile):
        raise HTTPException(status_code=400, detail="Enter a valid mobile number")

    email_key = _normalize_email(body.email)
    existing = await User.find_one(User.email == email_key)
    if existing:
        raise HTTPException(status_code=409, detail="Email already registered")

    user = User(
        email=email_key,
        password=hash_password(body.password),
        name=body.name.strip(),
        mobile=mobile,
    )
    await user.insert()
    logger.info("user registered: %s (id=%s)", user.email, user.id)

    await UserLog(user_id=str(user.id), action="register").insert()

    return {
        "user_id": str(user.id),
        "email": user.email,
        "role": user.role,
    }


@router.post("/login")
async def login(body: LoginRequest):
    user = await User.find_one(User.email == _normalize_email(body.email))
    if not user or not verify_password(body.password, user.password):
        logger.warning("failed login attempt for email: %s", body.email)
        raise HTTPException(status_code=401, detail="Invalid email or password")

    if user.is_disabled:
        logger.warning("disabled user attempted login: %s", body.email)
        raise HTTPException(status_code=403, detail="This account has been disabled.")

    if user.role == "admin":
        logger.warning("admin user blocked from user login: %s", user.email)
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=MSG_ADMIN_USE_USER_PORTAL)

    token = create_access_token({"sub": str(user.id), "role": user.role})

    await UserLog(user_id=str(user.id), action="login").insert()
    logger.info("user logged in: %s (id=%s)", user.email, user.id)

    return {
        "access_token": token,
        "token_type": "bearer",
        "user_id": str(user.id),
        "role": user.role,
        "email": user.email,
        "name": user.name,
        "profile_photo": user.profile_photo,
    }


@router.post("/admin-login")
async def admin_login(body: LoginRequest):
    user = await User.find_one(User.email == _normalize_email(body.email))
    if not user or not verify_password(body.password, user.password):
        logger.warning("failed admin login attempt for email: %s", body.email)
        raise HTTPException(status_code=401, detail="Invalid email or password")

    if user.is_disabled:
        logger.warning("disabled admin attempted login: %s", body.email)
        raise HTTPException(status_code=403, detail="This administrator account has been disabled.")

    if user.role != "admin":
        logger.warning("non-admin blocked from admin login: %s", user.email)
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=MSG_ADMIN_PORTAL_USER_ONLY)

    token = create_access_token({"sub": str(user.id), "role": user.role})

    await UserLog(user_id=str(user.id), action="admin_login").insert()
    logger.info("admin logged in: %s (id=%s)", user.email, user.id)

    return {
        "access_token": token,
        "token_type": "bearer",
        "user_id": str(user.id),
        "role": user.role,
        "email": user.email,
        "name": user.name,
        "profile_photo": user.profile_photo,
    }


class ProfileUpdate(BaseModel):
    name: Optional[str] = None
    mobile: Optional[str] = None
    gender: Optional[str] = None
    age: Optional[int] = None
    site: Optional[str] = None
    location: Optional[str] = None


def _profile_dict(user: User) -> dict:
    return {
        "email": user.email,
        "name": user.name,
        "mobile": user.mobile,
        "gender": user.gender,
        "age": user.age,
        "role": user.role,
        "site": user.site,
        "location": user.location,
        "profile_photo": user.profile_photo,
        "created_at": user.created_at.isoformat(),
    }


@router.get("/profile")
async def get_profile(user: User = Depends(get_current_user)):
    return _profile_dict(user)


@router.put("/profile")
async def update_profile(body: ProfileUpdate, user: User = Depends(get_current_user)):
    if body.name is not None:
        name = body.name.strip()
        if name and len(name) < 2:
            raise HTTPException(status_code=400, detail="Full name must be at least 2 characters")
        if len(name) > PROFILE_NAME_MAX_LENGTH:
            raise HTTPException(status_code=400, detail="Full name is too long")
        user.name = name or None
    if body.mobile is not None:
        mobile = body.mobile.strip()
        if mobile and not re.fullmatch(r"\+[0-9]{8,15}", mobile):
            raise HTTPException(status_code=400, detail="Enter a valid mobile number")
        user.mobile = mobile or None
    if body.gender is not None:
        gender = body.gender.strip()
        if gender and gender not in PROFILE_GENDERS:
            raise HTTPException(status_code=400, detail="Select a valid gender")
        user.gender = gender or None
    if body.age is not None:
        if body.age < PROFILE_AGE_MIN or body.age > PROFILE_AGE_MAX:
            raise HTTPException(status_code=400, detail="Age must be between 1 and 89")
        user.age = body.age
    if body.site is not None:
        site = body.site.strip()
        if len(site) > PROFILE_SITE_MAX_LENGTH:
            raise HTTPException(status_code=400, detail="Site is too long")
        user.site = site or None
    if body.location is not None:
        location = body.location.strip()
        if len(location) > PROFILE_LOCATION_MAX_LENGTH:
            raise HTTPException(status_code=400, detail="Location is too long")
        user.location = location or None

    await user.save()
    logger.info("profile updated: %s", user.email)

    return _profile_dict(user)


@router.post("/profile-photo")
async def upload_profile_photo(
    photo: UploadFile = File(...),
    user: User = Depends(get_current_user),
):
    if not photo.content_type or not photo.content_type.startswith("image/"):
        raise HTTPException(status_code=400, detail="Only image files are allowed")

    content = await photo.read()
    if not content:
        raise HTTPException(status_code=400, detail="Empty file")
    if len(content) > 5 * 1024 * 1024:
        raise HTTPException(status_code=400, detail="Image size must be <= 5MB")

    ext = ".jpg"
    if photo.filename and "." in photo.filename:
        suffix = "." + photo.filename.rsplit(".", 1)[-1].lower()
        if re.fullmatch(r"\.[a-z0-9]{2,5}", suffix):
            ext = suffix

    file_name = f"{uuid.uuid4().hex}{ext}"
    out_path = PROFILE_DIR / file_name
    out_path.write_bytes(content)

    old_path = user.profile_photo
    user.profile_photo = f"uploads/profiles/{file_name}"
    await user.save()

    if old_path and old_path.startswith("uploads/profiles/"):
        try:
            (REPO_ROOT / old_path).unlink(missing_ok=True)
        except OSError:
            logger.warning("failed to remove old profile photo for %s", user.email)

    logger.info("profile photo updated: %s", user.email)
    return {"profile_photo": user.profile_photo}
