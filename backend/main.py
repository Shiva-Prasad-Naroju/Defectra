"""FastAPI entrypoint.

Run from the backend directory:

    uvicorn main:app --reload --port 8000

If the dev machine uses WSL/Docker for the API, point Vite at it with VITE_API_PROXY_TARGET
(see frontend/.env.example). Use --host 0.0.0.0 only when you need other devices to call
this API directly (default 127.0.0.1 is enough for the Vite /api proxy on the same host).
"""

from __future__ import annotations

import sys
from pathlib import Path

# When started as `uvicorn backend.main:app` from the repo root, imports like `routers` and
# `services` must resolve against this directory (same as `uvicorn main:app` from `backend/`).
_backend_dir = str(Path(__file__).resolve().parent)
if _backend_dir not in sys.path:
    sys.path.insert(0, _backend_dir)

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from routers import ai_analysis

app = FastAPI(title="Defectra API", version="0.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(ai_analysis.router, prefix="/api/ai-analysis", tags=["ai-analysis"])


@app.get("/api/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}
