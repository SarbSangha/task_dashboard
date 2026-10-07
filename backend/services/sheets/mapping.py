"""Header-name column mapping for registered sheets.

Nothing here knows column positions: every rule matches a header's text, so
a sheet can reorder or add columns and an admin can correct any guess in the
dashboard (TrackedSheet.mapping_json).
"""

from __future__ import annotations

import re
from typing import Optional

ROLES = ("topic", "input", "structure", "status", "final_link", "output", "row_number", "request_id", "ignore")
SIDES = ("input", "output", "ignore")
REQUEST_ID_HEADER = "Request ID"

DEFAULT_STATUSES = {
    "awaiting": "Awaiting Approval",
    "approved": "Approved",
    "in_progress": "In Progress",
    "delivered": "Delivered",
}
DEFAULT_CONFIG = {
    "keyColumn": None,              # header whose value identifies a row; None = auto
    "headerRow": 1,
    "skipExampleRows": True,
    "stuckAwaitingHours": 48,
    "stuckInProgressHours": 24,
}


def _norm(header: str) -> str:
    return re.sub(r"\s+", " ", (header or "").strip().lower())


def guess_role(header: str) -> tuple:
    """(role, side) for one header."""
    h = _norm(header)
    if h == REQUEST_ID_HEADER.lower():
        return "request_id", "ignore"
    if h in ("no", "no.", "#", "s.no", "s.no.", "sr no", "sr. no.", "sl no", "row"):
        return "row_number", "ignore"
    if "optimi" in h and "structure" in h:
        return "structure", "output"
    if h == "status" or h.endswith(" status"):
        return "status", "output"
    if "final" in h and ("doc" in h or "link" in h or "url" in h):
        return "final_link", "output"
    if h in ("topic", "title") or h.startswith("topic"):
        return "topic", "input"
    return "input", "input"


def auto_mapping(headers: list) -> dict:
    mapping = {}
    for header in headers:
        if not header:
            continue
        role, side = guess_role(header)
        mapping[header] = {"role": role, "side": side}
    return mapping


def merged_headers(tabs: dict, tracked: list) -> list:
    """Union of header names across the tracked tabs, in first-seen order."""
    seen, out = set(), []
    for name in tracked:
        tab = tabs.get(name)
        for header in (tab.headers if tab else []):
            if header and header not in seen:
                seen.add(header)
                out.append(header)
    return out


def headers_with_role(mapping: dict, role: str) -> list:
    return [h for h, m in (mapping or {}).items() if (m or {}).get("role") == role]


def first_header(mapping: dict, role: str) -> Optional[str]:
    found = headers_with_role(mapping, role)
    return found[0] if found else None


def side_of(mapping: dict, header: str) -> str:
    return ((mapping or {}).get(header) or {}).get("side", "ignore")


def role_of(mapping: dict, header: str) -> str:
    return ((mapping or {}).get(header) or {}).get("role", "ignore")


def is_link_header(mapping: dict, header: str) -> bool:
    role = role_of(mapping, header)
    h = _norm(header)
    return role == "final_link" or (role == "input" and any(k in h for k in ("link", "doc", "url")))


def pick_key_column(mapping: dict, config: dict) -> Optional[str]:
    """The header whose value identifies a row across polls: an explicit
    choice, else the Apps Script's hidden "Request ID", else a row-number
    column such as "No.". None means the sheet row number."""
    explicit = (config or {}).get("keyColumn")
    if explicit and explicit in (mapping or {}):
        return explicit
    return first_header(mapping, "request_id") or first_header(mapping, "row_number")


def validate_mapping(mapping) -> dict:
    if not isinstance(mapping, dict) or not mapping:
        raise ValueError("mapping must map at least one header")
    clean = {}
    for header, spec in mapping.items():
        if not isinstance(header, str) or not header.strip() or not isinstance(spec, dict):
            raise ValueError("each mapping entry needs a header name and {role, side}")
        role, side = spec.get("role"), spec.get("side")
        if role not in ROLES or side not in SIDES:
            raise ValueError(f"'{header}': role must be one of {', '.join(ROLES)}; side one of {', '.join(SIDES)}")
        clean[header.strip()] = {"role": role, "side": side}
    if not headers_with_role(clean, "topic"):
        raise ValueError("map one column as the Topic (it marks when a request is created)")
    if not headers_with_role(clean, "status"):
        raise ValueError("map one column as the Status")
    return clean


def validate_statuses(statuses) -> dict:
    out = dict(DEFAULT_STATUSES)
    for key in DEFAULT_STATUSES:
        value = (statuses or {}).get(key)
        if isinstance(value, str) and value.strip():
            out[key] = value.strip()
    return out


def validate_config(config) -> dict:
    out = dict(DEFAULT_CONFIG)
    config = config or {}
    if config.get("keyColumn") is None or isinstance(config.get("keyColumn"), str):
        out["keyColumn"] = (config.get("keyColumn") or None)
    for key in ("stuckAwaitingHours", "stuckInProgressHours"):
        if key in config:
            out[key] = max(1, min(int(config[key]), 24 * 90))
    if "headerRow" in config:
        out["headerRow"] = max(1, min(int(config["headerRow"]), 50))
    if "skipExampleRows" in config:
        out["skipExampleRows"] = bool(config["skipExampleRows"])
    return out
