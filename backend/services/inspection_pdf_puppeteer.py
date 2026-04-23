"""Render HTML to PDF bytes using local Node + Puppeteer (Chromium)."""

from __future__ import annotations

import logging
import os
import subprocess
import tempfile
from pathlib import Path

logger = logging.getLogger(__name__)

_RENDER_SCRIPT = Path(__file__).resolve().parent.parent / "pdf_puppeteer" / "render.mjs"


def render_html_to_pdf_bytes(html: str) -> bytes:
    if not _RENDER_SCRIPT.is_file():
        raise RuntimeError(
            f"Puppeteer script not found at {_RENDER_SCRIPT}. "
            "Run: cd backend/pdf_puppeteer && npm install"
        )

    node = os.environ.get("INSPECTION_PDF_NODE_BINARY", os.environ.get("NODE_BINARY", "node"))

    fd_h, html_path = tempfile.mkstemp(suffix=".html", prefix="inspection-pdf-")
    with os.fdopen(fd_h, "w", encoding="utf-8") as fh:
        fh.write(html)

    fd_p, pdf_path = tempfile.mkstemp(suffix=".pdf", prefix="inspection-pdf-")
    os.close(fd_p)
    Path(pdf_path).unlink(missing_ok=True)

    try:
        proc = subprocess.run(
            [node, str(_RENDER_SCRIPT), html_path, pdf_path],
            capture_output=True,
            text=True,
            timeout=int(os.environ.get("INSPECTION_PDF_RENDER_TIMEOUT_S", "120")),
            check=False,
        )
        if proc.returncode != 0:
            logger.error(
                "puppeteer failed rc=%s stderr=%s stdout=%s",
                proc.returncode,
                proc.stderr,
                proc.stdout,
            )
            raise RuntimeError(
                proc.stderr.strip()
                or proc.stdout.strip()
                or "Puppeteer PDF render failed (see server logs)."
            )
        out = Path(pdf_path).read_bytes()
        if not out:
            raise RuntimeError("Puppeteer produced an empty PDF file.")
        logger.info("inspection_pdf: puppeteer ok pdf_bytes=%s", len(out))
        return out
    finally:
        Path(html_path).unlink(missing_ok=True)
        Path(pdf_path).unlink(missing_ok=True)
