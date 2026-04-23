"""Parse structured inspection sections from model markdown."""

from __future__ import annotations

import re
from typing import Any


def _norm_title(s: str) -> str:
    return re.sub(r"\s+", " ", s.strip()).lower()


def parse_inspection_sections(markdown: str) -> dict[str, Any]:
    text = (markdown or "").strip()
    out: dict[str, Any] = {
        "summary": "",
        "key_defects": [],
        "severity": "",
        "recommended_actions": [],
        "raw_markdown": text,
    }
    if not text:
        return out

    pattern = re.compile(r"^##\s+(.+?)\s*$", re.MULTILINE)
    matches = list(pattern.finditer(text))
    if not matches:
        out["summary"] = text[:2000]
        return out

    preamble = text[: matches[0].start()].strip()

    sections: dict[str, str] = {}
    for i, m in enumerate(matches):
        title = m.group(1).strip()
        start = m.end()
        end = matches[i + 1].start() if i + 1 < len(matches) else len(text)
        sections[_norm_title(title)] = text[start:end].strip()

    def pick(*keys: str) -> str:
        for k in keys:
            nk = _norm_title(k)
            for sk, body in sections.items():
                if nk in sk or sk.startswith(nk):
                    return body
        return ""

    summary = pick("summary", "executive summary", "overview")
    defects = pick("key defects", "defects", "findings")
    # Avoid matching `## Risk Assessment` when resolving severity.
    severity = pick("severity assessment", "severity", "overall severity")
    actions = pick("recommended actions", "recommendations", "actions", "next steps")

    summary_body = summary
    if summary_body and preamble:
        out["summary"] = f"{preamble}\n\n{summary_body}".strip()
    elif summary_body:
        out["summary"] = summary_body
    else:
        out["summary"] = preamble or text[:1500]

    if defects:
        bullets = [ln.strip().lstrip("-•*").strip() for ln in defects.splitlines() if ln.strip()]
        out["key_defects"] = [b for b in bullets if len(b) > 2][:40]

    sev_line = severity.splitlines()[0] if severity else ""
    for label in ("High", "Medium", "Low"):
        if label.lower() in sev_line.lower():
            out["severity"] = label
            break
    if not out["severity"] and severity:
        out["severity"] = severity[:120]

    if actions:
        act_lines = [
            ln.strip().lstrip("-•*0123456789.)").strip() for ln in actions.splitlines() if ln.strip()
        ]
        out["recommended_actions"] = [a for a in act_lines if len(a) > 2][:24]

    return out
