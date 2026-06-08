from __future__ import annotations

import re
from typing import Any

_MATH_SEGMENT_RE = re.compile(r"\$\$[\s\S]*?\$\$|\$[^$\n]+?\$|\\\([\s\S]*?\\\)|\\\[[\s\S]*?\\\]")
_CONTROL_ESCAPE_MAP = {
    "\x08": "\\b",
    "\x09": "\\t",
    "\x0a": "\\n",
    "\x0b": "\\v",
    "\x0c": "\\f",
    "\x0d": "\\r",
}


def _repair_math_segment(segment: str) -> str:
    return "".join(_CONTROL_ESCAPE_MAP.get(char, char) for char in segment)


def _normalize_plain_text(segment: str) -> str:
    return segment.replace("\\n", "\n").replace("\u2014", "-")


def repair_latex_text(text: str) -> str:
    if not isinstance(text, str) or not text:
        return text if isinstance(text, str) else text

    repaired: list[str] = []
    last_index = 0
    math_regex = re.compile(_MATH_SEGMENT_RE.pattern)

    for match in math_regex.finditer(text):
        start, end = match.span()
        if start > last_index:
            repaired.append(_normalize_plain_text(text[last_index:start]))
        repaired.append(_repair_math_segment(match.group(0)))
        last_index = end

    if last_index < len(text):
        repaired.append(_normalize_plain_text(text[last_index:]))

    return "".join(repaired)


def repair_latex_value(value: Any) -> Any:
    if isinstance(value, str):
        return repair_latex_text(value)
    if isinstance(value, list):
        return [repair_latex_value(item) for item in value]
    if isinstance(value, tuple):
        return tuple(repair_latex_value(item) for item in value)
    if isinstance(value, dict):
        return {key: repair_latex_value(item) for key, item in value.items()}
    return value
