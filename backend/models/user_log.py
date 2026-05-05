from datetime import datetime, timezone
from typing import Optional

from beanie import Document
from pydantic import Field


class UserLog(Document):
    """user_id is the actor (e.g. admin). For admin actions, target_* identify the subject."""

    user_id: str
    action: str
    target_user_id: Optional[str] = None
    target_email: Optional[str] = None
    timestamp: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))

    class Settings:
        name = "user_logs"
