# providers/cursor/csv_import.py
"""
Parses Cursor's usage export (cursor.com -> Dashboard -> Usage -> Export CSV).

Confirmed real header (2026-10-29):

  Date,Cloud Agent ID,Automation ID,Kind,Model,Max Mode,Input (w/ Cache Write),
  Input (w/o Cache Write),Cache Read,Output Tokens,Total Tokens,Cost

  "2026-10-29T05:44:08.933Z","","","free","cursor-grok-4.6-medium","No","0","46637","98304","2557","147498","0.16"

Columns are found by name rather than position so small changes to Cursor's
export (a column added or reordered) don't break uploads.
"""
import csv
import io
import re
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Optional


@dataclass
class ParsedUsageRow:
    occurred_at: datetime  # naive UTC
    model: str
    kind: Optional[str]
    max_mode: bool
    input_tokens: int
    output_tokens: int
    cache_read_tokens: int
    cache_write_tokens: int
    cost_cents: Optional[float]
    cloud_agent_id: Optional[str]
    automation_id: Optional[str]

    @property
    def event_uid(self) -> str:
        ms = int(self.occurred_at.replace(tzinfo=timezone.utc).timestamp() * 1000)
        return f"{ms}:{self.model}:{self.input_tokens}:{self.output_tokens}:{self.cache_read_tokens}"


@dataclass
class ParsedUsageFile:
    rows: list[ParsedUsageRow] = field(default_factory=list)
    skipped: list[str] = field(default_factory=list)  # unreadable dates, first few kept for the error message
    skipped_count: int = 0
    columns: dict[str, str] = field(default_factory=dict)


class UsageCsvError(ValueError):
    pass


def _number(value) -> Optional[float]:
    cleaned = re.sub(r"[$,\s]", "", str(value or ""))
    if not cleaned:
        return None
    try:
        return float(cleaned)
    except ValueError:
        return None


def _int(value) -> int:
    number = _number(value)
    return int(round(number)) if number is not None else 0


def _parse_time(value: str) -> Optional[datetime]:
    raw = (value or "").strip()
    if not raw:
        return None
    try:
        parsed = datetime.fromisoformat(raw.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is not None:
        parsed = parsed.astimezone(timezone.utc).replace(tzinfo=None)
    return parsed


def _find(headers: list[str], pattern: str, exclude: Optional[str] = None) -> int:
    for index, header in enumerate(headers):
        if re.search(pattern, header) and not (exclude and re.search(exclude, header)):
            return index
    return -1


def parse_usage_csv(text: str) -> ParsedUsageFile:
    reader = csv.reader(io.StringIO(text.lstrip("﻿")))
    rows = [row for row in reader if any(cell.strip() for cell in row)]
    if not rows:
        raise UsageCsvError("The file is empty.")

    header = rows[0]
    lowered = [h.strip().lower() for h in header]
    col = {
        "date": _find(lowered, r"date|time"),
        "cloud_agent": _find(lowered, r"cloud agent"),
        "automation": _find(lowered, r"automation"),
        "kind": _find(lowered, r"kind|type"),
        "model": _find(lowered, r"model"),
        "max_mode": _find(lowered, r"max"),
        "input_with_cache": _find(lowered, r"input.*(w/|with)\s*cache", r"w/o|without"),
        "input_without_cache": _find(lowered, r"input.*(w/o|without)"),
        "input": _find(lowered, r"input"),
        "cache_read": _find(lowered, r"cache\s*read"),
        "cache_write": _find(lowered, r"cache\s*write", r"input"),
        "output": _find(lowered, r"output"),
        "cost": _find(lowered, r"cost|charge|\$"),
    }
    if col["date"] < 0 or col["model"] < 0:
        raise UsageCsvError(
            "This doesn't look like a Cursor usage export (columns found: " + ", ".join(header) + ")."
        )

    parsed = ParsedUsageFile(columns={key: header[index] for key, index in col.items() if index >= 0})

    for line in rows[1:]:
        def get(key):
            index = col[key]
            return line[index] if 0 <= index < len(line) else None

        occurred_at = _parse_time(get("date"))
        if occurred_at is None:
            parsed.skipped_count += 1
            if len(parsed.skipped) < 3:
                parsed.skipped.append(str(get("date")))
            continue

        if col["input_without_cache"] >= 0:
            input_tokens = _int(get("input_without_cache"))
            cache_write = (
                _int(get("cache_write"))
                if col["cache_write"] >= 0
                else max(0, _int(get("input_with_cache")) - input_tokens)
            )
        else:
            input_tokens = _int(get("input"))
            cache_write = _int(get("cache_write"))

        cost = _number(get("cost"))  # "Included" / blank -> unknown, not free
        parsed.rows.append(
            ParsedUsageRow(
                occurred_at=occurred_at,
                model=(get("model") or "unknown").strip() or "unknown",
                kind=(get("kind") or "").strip() or None,
                max_mode=(get("max_mode") or "").strip().lower() in {"yes", "true", "1"},
                input_tokens=input_tokens,
                output_tokens=_int(get("output")),
                cache_read_tokens=_int(get("cache_read")),
                cache_write_tokens=cache_write,
                cost_cents=None if cost is None else round(cost * 100, 4),
                cloud_agent_id=(get("cloud_agent") or "").strip() or None,
                automation_id=(get("automation") or "").strip() or None,
            )
        )
    return parsed
