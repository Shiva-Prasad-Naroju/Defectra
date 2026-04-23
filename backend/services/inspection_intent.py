"""Keyword-based intent for construction inspection vision + follow-up chat."""

from __future__ import annotations

from typing import Literal

InspectionIntent = Literal[
    "defect_query",
    "safety_query",
    "action_query",
    "specific_query",
    "full_analysis",
]


def classify_inspection_intent(message: str | None) -> InspectionIntent:
    """
    Classify the engineer's text into a response mode.
    Order: explicit full-report asks → safety → action → defect → default full.
    """
    m = (message or "").strip().lower()
    if not m:
        return "full_analysis"

    full_needles = (
        "full report",
        "full analysis",
        "complete report",
        "complete inspection",
        "pmo report",
        "full assessment",
        "detailed inspection",
        "comprehensive",
        "inspect thoroughly",
        "everything you can see",
        "everything you see",
        "full breakdown",
    )
    if any(x in m for x in full_needles):
        return "full_analysis"

    # Broad “tell me about this photo” asks → full PMO-style report (same as empty message).
    general_needles = (
        "what do you see",
        "what can you see",
        "what do you notice",
        "tell me what you see",
        "describe what you see",
        "describe this image",
        "describe this photo",
        "describe the image",
        "describe the photo",
        "overview",
        "overall condition",
        "overall assessment",
        "inspect this",
        "review this image",
        "review this photo",
        "analyze this image",
        "analyze this photo",
        "your observations",
        "your analysis",
        "anything you can see",
        "everything visible",
    )
    if any(x in m for x in general_needles):
        return "full_analysis"

    safety_needles = (
        "safe",
        "unsafe",
        "safety",
        "hazard",
        "hazards",
        "at risk",
        "risky",
        "risk ",
        " risks",
        "danger",
        "harmful",
        "okay to",
        "ok to ",
        "electrocut",
        "trip hazard",
        "fire risk",
        "will it fail",
        "collapse risk",
        "compliant",
        "code violation",
        "violates code",
    )
    if any(x in m for x in safety_needles):
        return "safety_query"

    action_needles = (
        "what should i",
        "what do i do",
        "what can i do",
        "how do i fix",
        "how to fix",
        "how should i",
        "how can we fix",
        "next step",
        "next steps",
        "remediation",
        "remediate",
        "repair",
        "fix this",
        "mitigate",
        "address this",
        "recommended action",
        "what to do",
    )
    if any(x in m for x in action_needles):
        return "action_query"

    defect_needles = (
        "what defect",
        "what defects",
        "any defect",
        "any defects",
        "what issues",
        "what issue",
        "what is wrong",
        "what's wrong",
        "whats wrong",
        "wrong with",
        "problems",
        "problem with",
        "issues do you",
        "issues you see",
        "see any",
        "do you see",
        "observations",
        "what's visible",
        "whats visible",
        "anything wrong",
    )
    if any(x in m for x in defect_needles):
        return "defect_query"

    # Any other non-empty message: answer the question directly; do not assume full PMO report.
    return "specific_query"


def followup_intent_system_suffix(message: str) -> str:
    """Short system add-on so text follow-ups match the same intent shape."""
    intent = classify_inspection_intent(message)
    if intent == "defect_query":
        return (
            "\n\n**Latest user intent — defects/issues:** Answer their question in the **first 1–3 lines** "
            "(concrete defects or “none visible for X”). Then expand with Markdown only if it helps; "
            "do not start with a generic recap of the entire prior analysis."
        )
    if intent == "safety_query":
        return (
            "\n\n**Latest user intent — safety/risk:** Start with an explicit **verdict line** "
            "(Safe / Unsafe / Needs verification — pick one, brief justification). "
            "Then reasoning and bullets; do not bury the verdict below a long introduction."
        )
    if intent == "action_query":
        return (
            "\n\n**Latest user intent — actions:** Lead with **numbered or bulleted immediate steps** "
            "they can take. Then optional deeper explanation grounded in the prior analysis only."
        )
    if intent == "specific_query":
        return (
            "\n\n**Latest user intent — specific question:** Answer that question **first** in plain, "
            "direct language. Do not replace it with a generic full-site recap or a long templated report "
            "unless they asked for one."
        )
    return ""
