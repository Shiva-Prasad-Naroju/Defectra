"""Build self-contained HTML for inspection chat PDFs (inlined JPEG data URLs only)."""

from __future__ import annotations

import base64
import html as html_module
import logging
import re
from datetime import datetime, timezone
from io import BytesIO
from typing import Any

from PIL import Image

logger = logging.getLogger(__name__)

_MAX_IMAGE_BYTES = 25 * 1024 * 1024
_MAX_RAW_DECODE = 30 * 1024 * 1024
_JPEG_MAX_SIDE = 1920


def _ensure_heif_opener() -> None:
    try:
        from pillow_heif import register_heif_opener

        register_heif_opener()
    except ImportError:
        pass


def _escape_html(s: str) -> str:
    return html_module.escape(str(s or ""), quote=True)


def _parse_data_url(s: str) -> tuple[bytes, str] | None:
    s = (s or "").strip()
    if not s.startswith("data:"):
        return None
    try:
        header, b64 = s.split(",", 1)
    except ValueError:
        return None
    if ";base64" not in header.lower():
        return None
    mime_m = re.search(r"data:([^;\s]+)", header, re.I)
    mime = (mime_m.group(1).strip() if mime_m else "application/octet-stream").lower()
    try:
        raw = base64.b64decode(b64, validate=False)
    except Exception:
        return None
    if len(raw) > _MAX_RAW_DECODE:
        return None
    return raw, mime


def image_field_to_jpeg_data_url(image_field: str | None) -> str | None:
    """
    Normalize any supported chat image to ``data:image/jpeg;base64,...`` for Puppeteer.
    Rejects blob: URLs and empty payloads.
    """
    if not image_field or not isinstance(image_field, str):
        return None
    s = image_field.strip()
    if s.startswith("blob:"):
        logger.warning("inspection_pdf: skip blob URL (must be data URL on client)")
        return None

    raw: bytes | None = None
    mime = "image/jpeg"

    if s.startswith("data:"):
        parsed = _parse_data_url(s)
        if not parsed:
            logger.warning("inspection_pdf: could not parse data URL (prefix len=%s)", len(s))
            return None
        raw, mime = parsed
    else:
        # Raw base64 only (no data: prefix)
        cleaned = re.sub(r"\s+", "", s)
        if not re.fullmatch(r"[A-Za-z0-9+/=]+", cleaned) or len(cleaned) < 80:
            return None
        try:
            raw = base64.b64decode(cleaned, validate=False)
        except Exception:
            return None

    if not raw or len(raw) > _MAX_IMAGE_BYTES:
        logger.warning("inspection_pdf: image bytes empty or too large (%s)", len(raw or b""))
        return None

    _ensure_heif_opener()
    try:
        im = Image.open(BytesIO(raw))
        im = im.convert("RGB")
        w, h = im.size
        if max(w, h) > _JPEG_MAX_SIDE:
            scale = _JPEG_MAX_SIDE / max(w, h)
            im = im.resize(
                (max(1, int(w * scale)), max(1, int(h * scale))),
                Image.Resampling.LANCZOS,
            )
        out = BytesIO()
        im.save(out, format="JPEG", quality=88, optimize=True)
        jpeg_b64 = base64.b64encode(out.getvalue()).decode("ascii")
    except Exception as e:
        logger.warning("inspection_pdf: Pillow rasterize failed: %s", e)
        return None

    data_url = f"data:image/jpeg;base64,{jpeg_b64}"
    if not jpeg_b64:
        logger.warning("inspection_pdf: empty JPEG after encode")
        return None
    logger.info(
        "inspection_pdf: inlined JPEG ok src_mime=%s out_len=%s",
        mime,
        len(data_url),
    )
    return data_url


# List lines: preserve leading whitespace for nesting (do not use strip() for structure).
_UL_RAW = re.compile(r"^(\s*)[-*+]\s+(.+)$")
_OL_RAW = re.compile(r"^(\s*)\d+\.\s+(.+)$")


def _leading_indent_width(line: str) -> int:
    m = re.match(r"^(\s*)", line)
    return len(m.group(1).expandtabs(4)) if m else 0


def _collect_list_entries(lines: list[str], start_i: int) -> tuple[list[tuple[int, str, str]], int]:
    """Collect (indent_px, 'ul'|'ol', content) for a contiguous list block. Returns (entries, next_index)."""
    i = start_i
    entries: list[tuple[int, str, str]] = []
    while i < len(lines):
        raw = lines[i]
        if not raw.strip():
            j = i + 1
            while j < len(lines) and not lines[j].strip():
                j += 1
            if j < len(lines) and (_UL_RAW.match(lines[j]) or _OL_RAW.match(lines[j])):
                i += 1
                continue
            break
        um = _UL_RAW.match(raw)
        om = _OL_RAW.match(raw) if not um else None
        if not um and not om:
            break
        ind = _leading_indent_width(raw)
        if um:
            entries.append((ind, "ul", um.group(2).strip()))
        else:
            entries.append((ind, "ol", om.group(2).strip()))
        i += 1
    return entries, i


def _build_list_tree(entries: list[tuple[int, str, str]]) -> list[dict[str, Any]]:
    """Nest list nodes by leading indent (same rules as chat / CommonMark-style UI)."""
    root: list[dict[str, Any]] = []
    stack: list[tuple[int, dict[str, Any]]] = []
    for indent, kind, content in entries:
        node: dict[str, Any] = {"kind": kind, "content": content, "children": []}
        while stack and stack[-1][0] >= indent:
            stack.pop()
        if not stack:
            root.append(node)
        else:
            stack[-1][1]["children"].append(node)
        stack.append((indent, node))
    return root


def _render_list_tree(nodes: list[dict[str, Any]]) -> str:
    """Render grouped consecutive siblings that share the same list type (ul vs ol)."""
    if not nodes:
        return ""
    parts: list[str] = []
    idx = 0
    while idx < len(nodes):
        tag = nodes[idx]["kind"]
        end = idx
        while end < len(nodes) and nodes[end]["kind"] == tag:
            end += 1
        group = nodes[idx:end]
        parts.append(f"<{tag}>")
        for n in group:
            parts.append("<li>")
            parts.append(_inline_md_to_html(n["content"]))
            if n["children"]:
                parts.append(_render_list_tree(n["children"]))
            parts.append("</li>")
        parts.append(f"</{tag}>")
        idx = end
    return "".join(parts)


def _expand_list_indents_for_commonmark(md: str) -> str:
    """Python-Markdown nests lists on 4-space steps; widen 2-space indents from models/chat."""
    out: list[str] = []
    for line in md.splitlines():
        m = re.match(r"^(\s*)([-*+]|\d+\.)\s", line)
        if m:
            sp = len(m.group(1).expandtabs(4))
            if sp > 0:
                new_sp = ((sp + 3) // 4) * 4
                line = (" " * new_sp) + line.lstrip()
        out.append(line)
    return "\n".join(out)


def _inline_md_to_html(s: str) -> str:
    """Escape-safe inline: ``**bold**``, `` `code` `` (single-line segments)."""
    parts: list[str] = []
    i = 0
    n = len(s)
    while i < n:
        if s.startswith("**", i):
            j = s.find("**", i + 2)
            if j != -1:
                parts.append(f"<strong>{html_module.escape(s[i + 2 : j])}</strong>")
                i = j + 2
                continue
        if s[i] == "`":
            j = s.find("`", i + 1)
            if j != -1:
                parts.append(f"<code>{html_module.escape(s[i + 1 : j])}</code>")
                i = j + 1
                continue
        parts.append(html_module.escape(s[i]))
        i += 1
    return "".join(parts)


def _fallback_markdown_to_html(md: str) -> str:
    """
    Inspection-style Markdown → HTML without external deps.
    Covers ## headings, - / * / + lists, numbered lists, **bold**, `code`, --- rules.
    """
    raw = (md or "").strip()
    if not raw:
        return '<p class="report-prose__empty">—</p>'
    lines = raw.splitlines()
    html_chunks: list[str] = []
    i = 0
    para_buf: list[str] = []

    def flush_para() -> None:
        nonlocal para_buf
        if not para_buf:
            return
        inner = "<br />".join(_inline_md_to_html(p.strip()) for p in para_buf if p.strip())
        para_buf = []
        if inner:
            html_chunks.append(f"<p>{inner}</p>")

    while i < len(lines):
        line = lines[i]
        stripped = line.strip()
        if not stripped:
            flush_para()
            i += 1
            continue
        if set(stripped) <= {"-"} and len(stripped) >= 3:
            flush_para()
            html_chunks.append("<hr />")
            i += 1
            continue
        m = re.match(r"^(#{1,6})\s+(.+)$", stripped)
        if m:
            flush_para()
            level = min(len(m.group(1)), 6)
            title = m.group(2).strip()
            tag = f"h{level}"
            html_chunks.append(f"<{tag}>{_inline_md_to_html(title)}</{tag}>")
            i += 1
            continue
        if _UL_RAW.match(line) or _OL_RAW.match(line):
            flush_para()
            entries, next_i = _collect_list_entries(lines, i)
            if entries:
                tree = _build_list_tree(entries)
                html_chunks.append(_render_list_tree(tree))
            i = next_i
            continue
        para_buf.append(line)
        i += 1
    flush_para()
    return "".join(html_chunks)


def _looks_like_unprocessed_markdown(html: str, raw: str) -> bool:
    """True if common Markdown syntax appears unconverted in the HTML body."""
    if re.search(r"\*\*[^*<]{1,400}\*\*", html):
        return True
    if "##" in raw and not re.search(r"<h[1-6]", html, re.I):
        return True
    return False


def _render_markdown(md: str) -> str:
    raw = (md or "").strip()
    if not raw:
        return '<p class="report-prose__empty">—</p>'
    try:
        import markdown as markdown_lib
    except ImportError:
        logger.info("inspection_pdf: using built-in Markdown renderer (pip install markdown optional)")
        return _fallback_markdown_to_html(raw)
    raw_for_md = _expand_list_indents_for_commonmark(raw)
    try:
        html = markdown_lib.markdown(
            raw_for_md,
            extensions=[
                "markdown.extensions.nl2br",
                "markdown.extensions.sane_lists",
            ],
            output_format="html5",
        )
    except Exception:
        try:
            html = markdown_lib.markdown(
                raw_for_md,
                extensions=["markdown.extensions.nl2br"],
                output_format="html5",
            )
        except Exception as e:
            logger.warning("inspection_pdf: markdown library failed (%s); using built-in renderer", e)
            return _fallback_markdown_to_html(raw)
    if _looks_like_unprocessed_markdown(html, raw):
        logger.warning(
            "inspection_pdf: markdown library output looks unprocessed; using built-in renderer"
        )
        return _fallback_markdown_to_html(raw)
    return html


# Offline-safe: system fonts only (no Google Fonts @import).
REPORT_CSS = """
:root {
  --s: 8px;
  --font: system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  --text: #0f172a;
  --text-muted: #64748b;
  --surface: #f8fafc;
  --surface-user: #eff6ff;
  --surface-ai: #f8fafc;
  --border: #e2e8f0;
  --user-accent: #2563eb;
  --ai-accent: #0f766e;
}
body { margin: 0; background: #fff; }
.report-doc {
  box-sizing: border-box;
  width: 794px;
  margin: 0 auto;
  padding: calc(var(--s) * 6) calc(var(--s) * 6) calc(var(--s) * 8);
  background: #fff;
  color: var(--text);
  font-family: var(--font);
  font-size: 11px;
  line-height: 1.65;
  -webkit-font-smoothing: antialiased;
}
.report-doc *, .report-doc *::before, .report-doc *::after { box-sizing: border-box; }
.report-doc-header {
  margin-bottom: calc(var(--s) * 5);
  padding-bottom: calc(var(--s) * 3);
  border-bottom: 1px solid var(--border);
}
.report-doc-title-brand {
  font-size: 28px;
  font-weight: 700;
  letter-spacing: -0.02em;
  line-height: 1.2;
  margin: 0 0 calc(var(--s) * 1.5);
  color: var(--text);
}
.report-doc-subtitle {
  font-size: 13px;
  font-weight: 500;
  color: var(--text-muted);
  margin: 0 0 calc(var(--s) * 2.5);
  letter-spacing: 0.01em;
}
.report-doc-meta {
  display: flex;
  flex-wrap: wrap;
  gap: calc(var(--s) * 2);
  font-size: 10px;
  color: var(--text-muted);
}
.report-doc-meta span strong { color: #475569; font-weight: 500; }
.report-thread { margin-top: calc(var(--s) * 2); }
.msg-turn { margin-bottom: calc(var(--s) * 5); }
.msg-turn:last-child { margin-bottom: 0; }
.msg-turn--user {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  width: 100%;
}
.msg-turn--ai {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  width: 100%;
}
.msg-turn__role {
  display: flex;
  align-items: center;
  gap: calc(var(--s) * 1);
  margin-bottom: calc(var(--s) * 1.5);
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.04em;
  text-transform: uppercase;
}
.msg-turn--user .msg-turn__role { align-self: flex-end; }
.msg-turn--ai .msg-turn__role { align-self: flex-start; }
.msg-turn__role--you { color: var(--user-accent); }
.msg-turn__role--ai { color: var(--ai-accent); }
.msg-turn__role::before {
  content: "";
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: currentColor;
}
.msg-card {
  border: 1px solid var(--border);
  border-radius: calc(var(--s) * 1.5);
  padding: calc(var(--s) * 3);
  background: var(--surface-ai);
  width: fit-content;
  max-width: min(420px, 62%);
}
.msg-card--user {
  background: var(--surface-user);
  border-color: #bfdbfe;
  max-width: min(380px, 56%);
}
.msg-card--ai { max-width: min(520px, 78%); }
.report-prose {
  font-size: 11px;
  line-height: 1.7;
  color: var(--text);
  word-wrap: break-word;
  overflow-wrap: anywhere;
}
.report-prose__empty { color: var(--text-muted); font-style: italic; margin: 0; }
.report-prose strong, .report-prose b { font-weight: 600; color: #0f172a; }
.report-prose p { margin: 0 0 calc(var(--s) * 2); }
.report-prose p:last-child { margin-bottom: 0; }
.report-prose h1 {
  font-size: 16px;
  font-weight: 700;
  margin: calc(var(--s) * 2) 0 calc(var(--s) * 1.5);
  color: #0f172a;
}
.report-prose h2 {
  font-size: 13px;
  font-weight: 600;
  margin: calc(var(--s) * 3) 0 calc(var(--s) * 1.5);
  padding-bottom: var(--s);
  border-bottom: 1px solid var(--border);
  color: #0f172a;
}
.report-prose h3 {
  font-size: 12px;
  font-weight: 600;
  margin: calc(var(--s) * 2) 0 var(--s);
  color: #0f172a;
}
.report-prose h4, .report-prose h5, .report-prose h6 {
  font-size: 11px;
  font-weight: 600;
  margin: calc(var(--s) * 1.5) 0 var(--s);
  color: #0f172a;
}
.report-prose em { font-style: italic; }
.report-prose hr {
  border: none;
  border-top: 1px solid var(--border);
  margin: calc(var(--s) * 3) 0;
}
.report-prose code {
  font-family: ui-monospace, Consolas, "Cascadia Code", monospace;
  font-size: 10px;
  background: #f1f5f9;
  padding: 0.15em 0.35em;
  border-radius: 4px;
  border: 1px solid #e2e8f0;
}
.report-prose ul, .report-prose ol {
  margin: 0 0 calc(var(--s) * 2);
  padding-left: calc(var(--s) * 3);
}
.report-prose ul { list-style-type: disc; }
.report-prose ol { list-style-type: decimal; }
.report-prose li { margin-bottom: calc(var(--s) * 1); }
.report-prose li::marker { color: var(--text-muted); }
.report-prose ul ul {
  list-style-type: circle;
  margin-top: calc(var(--s) * 1);
  margin-bottom: calc(var(--s) * 1);
  padding-left: calc(var(--s) * 4);
}
.report-prose ul ul ul { list-style-type: square; }
.report-prose ol ol {
  list-style-type: lower-alpha;
  margin-top: calc(var(--s) * 1);
  padding-left: calc(var(--s) * 4);
}
.report-prose li > ul,
.report-prose li > ol {
  margin-top: calc(var(--s) * 1.5);
  margin-bottom: calc(var(--s) * 0.5);
}
.report-figure {
  margin: 0 auto calc(var(--s) * 3);
  max-width: 100%;
  text-align: center;
}
.report-figure__frame {
  display: inline-block;
  max-width: 100%;
  padding: calc(var(--s) * 1.5);
  background: #fff;
  border: 1px solid var(--border);
  border-radius: calc(var(--s) * 1.5);
  box-shadow: 0 1px 3px rgba(15, 23, 42, 0.06);
}
.report-figure img {
  display: block;
  max-width: min(340px, 100%);
  width: 100%;
  height: auto;
  max-height: 320px;
  object-fit: contain;
  border-radius: calc(var(--s) * 0.75);
  margin-top: 12px;
}
.msg-card--user .report-figure img {
  max-width: min(300px, 100%);
  max-height: 260px;
}
.report-figure figcaption {
  margin-top: calc(var(--s) * 1.5);
  font-size: 9px;
  color: var(--text-muted);
}
"""


def build_inspection_pdf_html(
    *,
    transcript: list[dict[str, Any]],
    session_id: str,
) -> tuple[str, int]:
    """Return (full HTML document, count of user images successfully inlined as JPEG)."""
    generated_at = datetime.now(timezone.utc).astimezone().strftime("%Y-%m-%d %H:%M:%S %Z")
    sid = (session_id or "")[:16] or "—"
    user_n = sum(1 for t in transcript if (t.get("role") or "").lower() == "user")
    ai_n = len(transcript) - user_n

    parts: list[str] = [
        "<!DOCTYPE html><html lang=\"en\"><head><meta charset=\"utf-8\"/>",
        f"<title>{_escape_html('Site Sure Labs — Inspection report')}</title>",
        "<style>",
        REPORT_CSS,
        "</style></head><body>",
        "<div class=\"report-doc\">",
        "<header class=\"report-doc-header\">",
        "<h1 class=\"report-doc-title-brand\">Site Sure Labs</h1>",
        "<p class=\"report-doc-subtitle\">AI inspection report</p>",
        "<div class=\"report-doc-meta\">",
        f"<span><strong>Generated</strong> {_escape_html(generated_at)}</span>",
        f"<span><strong>Session</strong> {_escape_html(sid)}</span>",
        f"<span><strong>Conversation</strong> {len(transcript)} messages "
        f"({user_n} from you · {ai_n} from assistant)</span>",
        "</div></header>",
        "<section class=\"report-thread\" aria-label=\"Conversation\">",
    ]

    img_inlined = 0
    index = 0
    for m in transcript:
        index += 1
        role = (m.get("role") or "").lower()
        text = m.get("text") or ""
        if role == "user":
            jpeg_src = image_field_to_jpeg_data_url(m.get("image"))
            if jpeg_src:
                img_inlined += 1
            parts.append('<div class="msg-turn msg-turn--user">')
            parts.append('<div class="msg-turn__role msg-turn__role--you">You</div>')
            parts.append('<div class="msg-card msg-card--user">')
            if jpeg_src:
                parts.append("<figure class=\"report-figure\">")
                parts.append("<div class=\"report-figure__frame\">")
                parts.append(
                    "<img src=\""
                    + jpeg_src
                    + "\" alt=\"Reference photo\" "
                    "style=\"max-width:100%;height:auto;border-radius:8px;margin-top:12px;\" />"
                )
                parts.append("</div>")
                parts.append(
                    f"<figcaption>Reference image · message {index}</figcaption>"
                )
                parts.append("</figure>")
            if text.strip():
                parts.append('<div class="report-prose">')
                parts.append(_render_markdown(text))
                parts.append("</div>")
            elif not jpeg_src:
                parts.append(
                    '<div class="report-prose"><p class="report-prose__empty">(no text)</p></div>'
                )
            parts.append("</div></div>")
        else:
            parts.append('<div class="msg-turn msg-turn--ai">')
            parts.append('<div class="msg-turn__role msg-turn__role--ai">AI Assistant</div>')
            parts.append('<div class="msg-card msg-card--ai">')
            parts.append('<div class="report-prose">')
            parts.append(_render_markdown(text))
            parts.append("</div></div></div>")

    parts.extend(["</section>", "</div></body></html>"])
    full = "".join(parts)

    preview = full[:800] + ("…" if len(full) > 800 else "")
    logger.info(
        "inspection_pdf: html_len=%s jpeg_images=%s preview=%r",
        len(full),
        img_inlined,
        preview,
    )
    if img_inlined == 0 and any(
        (t.get("role") or "").lower() == "user" and t.get("image") for t in transcript
    ):
        logger.warning(
            "inspection_pdf: user rows had image fields but none inlined as JPEG "
            "(check data URL / decode)."
        )

    return full, img_inlined
