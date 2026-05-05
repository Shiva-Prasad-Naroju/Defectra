from datetime import datetime, timezone
from typing import Optional

from beanie import Document, Indexed
from pydantic import EmailStr, Field


class User(Document):
    email: Indexed(EmailStr, unique=True)
    password: str
    role: str = "user"
    name: Optional[str] = None
    mobile: Optional[str] = None
    gender: Optional[str] = None
    age: Optional[int] = None
    site: Optional[str] = None
    location: Optional[str] = None
    profile_photo: Optional[str] = None
    is_disabled: bool = Field(default=False)
    created_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))

    class Settings:
        name = "users"
