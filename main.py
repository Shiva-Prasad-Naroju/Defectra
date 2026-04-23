"""Re-export FastAPI `app` so ``uvicorn main:app`` works from the repo root."""

from backend.main import app

__all__ = ["app"]
