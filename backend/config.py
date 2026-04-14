"""Application settings (override with environment variables)."""

from __future__ import annotations

import os
from pathlib import Path


def _load_dotenv() -> None:
    try:
        from dotenv import load_dotenv
    except ImportError:
        return
    root = Path(__file__).resolve().parent.parent
    load_dotenv(root / ".env")


_load_dotenv()
from dataclasses import dataclass


@dataclass(frozen=True)
class Settings:
    """vLLM OpenAI-compatible API (chat completions + vision)."""

    vllm_base_url: str
    vllm_model: str
    vllm_api_key: str
    vllm_temperature: float
    vllm_max_tokens: int
    http_timeout_s: float

    def chat_completions_url(self) -> str:
        base = self.vllm_base_url.rstrip("/")
        return f"{base}/v1/chat/completions"

    @classmethod
    def from_env(cls) -> Settings:
        return cls(
            vllm_base_url=os.getenv(
                "VLLM_BASE_URL",
                "http://172.20.7.22:8000",
            ).rstrip("/"),
            vllm_model=os.getenv("VLLM_MODEL", "gemma4-31b"),
            vllm_api_key=os.getenv("VLLM_API_KEY", ""),
            vllm_temperature=float(os.getenv("VLLM_TEMPERATURE", "0.3")),
            vllm_max_tokens=int(os.getenv("VLLM_MAX_TOKENS", "10000")),
            http_timeout_s=float(os.getenv("VLLM_HTTP_TIMEOUT_S", "300")),
        )


def get_settings() -> Settings:
    """Fresh read each call so .env / environment changes apply without stale cache."""
    return Settings.from_env()
