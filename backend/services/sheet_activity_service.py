"""Google Sheet edit history: validation, idempotent storage and queries.

Events come from apps-script/Code.gs (installable onEdit / onChange
triggers). Each carries an eventId minted by the script, so retries, resends
from the _AuditLog backup tab and backfills are stored exactly once.

Dates in filters and the per-day summary are IST calendar days, like the
rest of the dashboard; timestamps are stored and returned in UTC.
"""

from __future__ import annotations

import csv
import io
import json
import re
from collections import defaultdict
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from typing import Iterable, Iterator, Optional

from pydantic import BaseModel, Field, field_validator
from sqlalchemy import func, or_
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from models_new import SheetActivity

IST = timedelta(minutes=330)
UNKNOWN_USER = "unknown"            # filter value / CSV label for events with no email
CHANGE_TYPES = (
    "EDIT", "INSERT_ROW", "REMOVE_ROW", "INSERT_COLUMN", "REMOVE_COLUMN",
    "INSERT_GRID", "REMOVE_GRID", "FORMAT", "OTHER",
)
MAX_BATCH = 200
MAX_VALUE_CHARS = 10_000            # per stored value; the script already trims to ~2,000
MAX_INCOMING_VALUE_CHARS = 100_000  # anything bigger is rejected as malformed
EVENT_ID_RE = re.compile(r"^[A-Za-z0-9_-]{8,64}$")
SOURCES = ("webhook", "resend", "backfill")


# --------------------------------------------------------------------------- #
# Payload
# --------------------------------------------------------------------------- #
class SheetEventIn(BaseModel):
    """One captured change. Field names match Code.gs's payload."""

    eventId: str
    timestamp: datetime
    userEmail: Optional[str] = Field(None, max_length=320)
    spreadsheetId: str = Field(..., min_length=1, max_length=128)
    sheetName: Optional[str] = Field(None, max_length=255)
    range: Optional[str] = Field(None, max_length=64)
    row: Optional[int] = Field(None, ge=0, le=10_000_000)
    column: Optional[int] = Field(None, ge=0, le=100_000)
    numRows: Optional[int] = Field(None, ge=0, le=10_000_000)
    numColumns: Optional[int] = Field(None, ge=0, le=100_000)
    changeType: str
    oldValue: Optional[str] = Field(None, max_length=MAX_INCOMING_VALUE_CHARS)
    newValue: Optional[str] = Field(None, max_length=MAX_INCOMING_VALUE_CHARS)
    newValues: Optional[list] = None
    formula: Optional[str] = Field(None, max_length=MAX_INCOMING_VALUE_CHARS)
    truncated: bool = False

    model_config = {"extra": "ignore"}

    @field_validator("eventId")
    @classmethod
    def _event_id(cls, v: str) -> str:
        if not EVENT_ID_RE.match(v or ""):
            raise ValueError("eventId must be 8-64 letters, digits, '-' or '_'")
        return v

    @field_validator("changeType")
    @classmethod
    def _change_type(cls, v: str) -> str:
        value = (v or "").strip().upper()
        if value not in CHANGE_TYPES:
            raise ValueError(f"changeType must be one of {', '.join(CHANGE_TYPES)}")
        return value

    @field_validator("userEmail")
    @classmethod
    def _email(cls, v: Optional[str]) -> Optional[str]:
        value = (v or "").strip().lower()
        return None if value in ("", UNKNOWN_USER) else value

    @field_validator("timestamp")
    @classmethod
    def _utc(cls, v: datetime) -> datetime:
        if v.tzinfo is not None:
            v = v.astimezone(timezone.utc).replace(tzinfo=None)
        return v


def _trim(value: Optional[str]) -> tuple:
    if value is None:
        return None, False
    if len(value) <= MAX_VALUE_CHARS:
        return value, False
    return value[: MAX_VALUE_CHARS - 1] + "…", True


def _row_from_event(ev: SheetEventIn, source: str) -> SheetActivity:
    new_value = ev.newValue
    # Only a cell edit can be "multiple cells"; structural changes carry the
    # selection's size merely as a location hint.
    is_multi = ev.changeType == "EDIT" and bool(
        ev.numRows and ev.numColumns and (ev.numRows > 1 or ev.numColumns > 1)
    )
    if ev.newValues is not None:
        new_value = json.dumps(ev.newValues, ensure_ascii=False, default=str)
        is_multi = True
    old_value, t1 = _trim(ev.oldValue)
    new_value, t2 = _trim(new_value)
    formula, t3 = _trim(ev.formula)
    return SheetActivity(
        event_id=ev.eventId,
        timestamp=ev.timestamp,
        received_at=datetime.utcnow(),
        user_email=ev.userEmail,
        spreadsheet_id=ev.spreadsheetId.strip(),
        sheet_name=(ev.sheetName or "").strip() or None,
        range_a1=(ev.range or "").strip() or None,
        row=ev.row,
        column=ev.column,
        num_rows=ev.numRows,
        num_columns=ev.numColumns,
        change_type=ev.changeType,
        old_value=old_value,
        new_value=new_value,
        formula=formula,
        is_multi_cell=is_multi,
        truncated=bool(ev.truncated or t1 or t2 or t3),
        source=source if source in SOURCES else "webhook",
    )


def ingest(db: Session, events: list, source: str = "webhook") -> dict:
    """Store events once each; returns {"stored", "duplicates"}."""
    by_id: dict = {}
    for ev in events:
        by_id.setdefault(ev.eventId, ev)          # duplicates inside one batch
    in_batch_dupes = len(events) - len(by_id)
    existing = {
        eid for (eid,) in db.query(SheetActivity.event_id).filter(SheetActivity.event_id.in_(list(by_id))).all()
    } if by_id else set()
    fresh = [ev for eid, ev in by_id.items() if eid not in existing]
    stored = 0
    try:
        db.add_all([_row_from_event(ev, source) for ev in fresh])
        db.commit()
        stored = len(fresh)
    except IntegrityError:
        # A concurrent request stored some of these first: retry one by one.
        db.rollback()
        for ev in fresh:
            try:
                with db.begin_nested():
                    db.add(_row_from_event(ev, source))
                stored += 1
            except IntegrityError:
                pass
        db.commit()
    return {"stored": stored, "duplicates": in_batch_dupes + len(by_id) - stored}


# --------------------------------------------------------------------------- #
# Filters
# --------------------------------------------------------------------------- #
@dataclass
class ActivityFilters:
    user: Optional[str] = None          # email, or UNKNOWN_USER
    sheet: Optional[str] = None
    change_type: Optional[str] = None
    start: Optional[date] = None        # IST calendar days, inclusive
    end: Optional[date] = None
    q: Optional[str] = None
    # None = every spreadsheet (admins); otherwise only these (the sheets a
    # non-admin is assigned to in the Sheets section).
    spreadsheet_ids: Optional[frozenset] = None


def ist_day_bounds(day: date) -> datetime:
    """UTC instant at which an IST calendar day starts."""
    return datetime(day.year, day.month, day.day) - IST


def apply_filters(query, f: ActivityFilters):
    if f.spreadsheet_ids is not None:
        query = query.filter(SheetActivity.spreadsheet_id.in_(list(f.spreadsheet_ids) or ["-"]))
    if f.user:
        if f.user.strip().lower() == UNKNOWN_USER:
            query = query.filter(SheetActivity.user_email.is_(None))
        else:
            query = query.filter(SheetActivity.user_email == f.user.strip().lower())
    if f.sheet:
        query = query.filter(SheetActivity.sheet_name == f.sheet)
    if f.change_type:
        query = query.filter(SheetActivity.change_type == f.change_type.strip().upper())
    if f.start:
        query = query.filter(SheetActivity.timestamp >= ist_day_bounds(f.start))
    if f.end:
        query = query.filter(SheetActivity.timestamp < ist_day_bounds(f.end + timedelta(days=1)))
    if f.q and f.q.strip():
        like = f"%{f.q.strip()}%"
        query = query.filter(or_(
            SheetActivity.old_value.ilike(like),
            SheetActivity.new_value.ilike(like),
            SheetActivity.formula.ilike(like),
            SheetActivity.range_a1.ilike(like),
            SheetActivity.sheet_name.ilike(like),
            SheetActivity.user_email.ilike(like),
        ))
    return query


def list_events(db: Session, f: ActivityFilters, page: int, page_size: int) -> dict:
    query = apply_filters(db.query(SheetActivity), f)
    total = query.count()
    rows = (
        query.order_by(SheetActivity.timestamp.desc(), SheetActivity.id.desc())
        .offset((page - 1) * page_size)
        .limit(page_size)
        .all()
    )
    return {"items": [r.to_dict() for r in rows], "total": total, "page": page, "pageSize": page_size}


def _ist_date(value: datetime) -> date:
    return (value + IST).date()


def summary(db: Session, f: ActivityFilters, *, now: Optional[datetime] = None, default_days: int = 30) -> dict:
    """Cards, per-user breakdown, top tabs and edits per IST day per user."""
    now = now or datetime.utcnow()
    base = apply_filters(db.query(SheetActivity), f)
    total = base.count()

    per_user_rows = (
        apply_filters(db.query(SheetActivity.user_email, func.count(SheetActivity.id), func.max(SheetActivity.timestamp)), f)
        .group_by(SheetActivity.user_email)
        .all()
    )
    per_user = sorted(
        ({"userEmail": email, "edits": int(n), "lastActivity": _iso(last)} for email, n, last in per_user_rows),
        key=lambda r: (-r["edits"], r["userEmail"] or "~"),
    )
    top_tabs = [
        {"sheetName": name, "edits": int(n)}
        for name, n in apply_filters(db.query(SheetActivity.sheet_name, func.count(SheetActivity.id)), f)
        .group_by(SheetActivity.sheet_name)
        .order_by(func.count(SheetActivity.id).desc())
        .limit(10)
        .all()
    ]
    last = apply_filters(db.query(SheetActivity), f).order_by(SheetActivity.timestamp.desc(), SheetActivity.id.desc()).first()

    today = _ist_date(now)

    def active_since(day: date) -> int:
        q = apply_filters(db.query(func.count(func.distinct(func.coalesce(SheetActivity.user_email, UNKNOWN_USER)))), f)
        return int(q.filter(SheetActivity.timestamp >= ist_day_bounds(day)).scalar() or 0)

    # Per-day series: bucket in Python on (timestamp, user) pairs inside the
    # window, so IST day boundaries are exact on every database.
    window_start = f.start or (today - timedelta(days=default_days - 1))
    window_end = f.end or today
    series_filters = ActivityFilters(**{**f.__dict__, "start": window_start, "end": window_end})
    counts: dict = defaultdict(int)
    for ts, email in apply_filters(db.query(SheetActivity.timestamp, SheetActivity.user_email), series_filters).yield_per(5000):
        counts[(_ist_date(ts).isoformat(), email)] += 1
    daily = [{"day": d, "userEmail": e, "edits": n} for (d, e), n in sorted(counts.items(), key=lambda kv: (kv[0][0], kv[0][1] or "~"))]

    return {
        "totalEdits": total,
        "activeUsersToday": active_since(today),
        "activeUsers7d": active_since(today - timedelta(days=6)),
        "lastEdit": {"timestamp": _iso(last.timestamp), "userEmail": last.user_email} if last else None,
        "perUser": per_user,
        "topTabs": top_tabs,
        "daily": daily,
        "window": {"start": window_start.isoformat(), "end": window_end.isoformat()},
    }


def options(db: Session, scope: Optional[ActivityFilters] = None) -> dict:
    scope = scope or ActivityFilters()
    users = [e for (e,) in apply_filters(db.query(SheetActivity.user_email), scope).distinct().all()]
    sheets = [s for (s,) in apply_filters(db.query(SheetActivity.sheet_name), scope).distinct().all() if s]
    return {
        "users": sorted([u for u in users if u]) + ([UNKNOWN_USER] if None in users else []),
        "sheets": sorted(sheets, key=str.lower),
        "changeTypes": list(CHANGE_TYPES),
    }


def _iso(value: Optional[datetime]) -> Optional[str]:
    return value.replace(microsecond=0).isoformat() + "Z" if value else None


# --------------------------------------------------------------------------- #
# CSV
# --------------------------------------------------------------------------- #
CSV_HEADERS = ["Timestamp (UTC)", "Timestamp (IST)", "User", "Tab", "Range", "Row", "Column", "Change type",
               "Old value", "New value", "Formula", "Multiple cells", "Truncated", "Spreadsheet ID", "Event ID"]


def _csv_safe(value) -> str:
    """Neutralise spreadsheet formula injection (=, +, -, @, tab, CR)."""
    text = "" if value is None else str(value)
    return "'" + text if text[:1] in ("=", "+", "-", "@", "\t", "\r") else text


def csv_rows(db: Session, f: ActivityFilters) -> Iterator[str]:
    buf = io.StringIO()
    writer = csv.writer(buf)

    def flush() -> str:
        data = buf.getvalue()
        buf.seek(0)
        buf.truncate(0)
        return data

    writer.writerow(CSV_HEADERS)
    yield "﻿" + flush()       # BOM so Excel opens UTF-8 correctly
    query = apply_filters(db.query(SheetActivity), f).order_by(SheetActivity.timestamp.desc(), SheetActivity.id.desc())
    for r in query.yield_per(1000):
        writer.writerow([_csv_safe(v) for v in (
            _iso(r.timestamp), (r.timestamp + IST).strftime("%Y-%m-%d %H:%M:%S"), r.user_email or "Unknown user",
            r.sheet_name, r.range_a1, r.row, r.column, r.change_type, r.old_value, r.new_value, r.formula,
            "yes" if r.is_multi_cell else "no", "yes" if r.truncated else "no", r.spreadsheet_id, r.event_id,
        )])
        yield flush()


def parse_events(payload) -> list:
    """Accept one event object or {"events": [...]}; raise ValueError when malformed."""
    if isinstance(payload, dict) and "events" in payload:
        raw = payload["events"]
        if not isinstance(raw, list):
            raise ValueError("events must be a list")
    elif isinstance(payload, dict):
        raw = [payload]
    else:
        raise ValueError("body must be a JSON object")
    if not raw:
        raise ValueError("no events")
    if len(raw) > MAX_BATCH:
        raise ValueError(f"at most {MAX_BATCH} events per request")
    return [SheetEventIn.model_validate(item) for item in raw]


def import_audit_log_rows(db: Session, rows: Iterable[dict]) -> dict:
    """Backfill from an exported _AuditLog tab (CSV with Code.gs's AUDIT_HEADERS)."""
    events, bad = [], 0
    for row in rows:
        try:
            item = {k: (v if v != "" else None) for k, v in row.items() if k}
            if item.get("newValues"):
                item["newValues"] = json.loads(item["newValues"])
            for key in ("row", "column", "numRows", "numColumns"):
                if item.get(key) is not None:
                    item[key] = int(float(item[key]))
            item["truncated"] = str(item.get("truncated") or "").strip().lower() in ("true", "1", "yes")
            events.append(SheetEventIn.model_validate(item))
        except Exception:  # noqa: BLE001 - one unreadable row must not stop the import
            bad += 1
    result = {"stored": 0, "duplicates": 0}
    for i in range(0, len(events), MAX_BATCH):
        part = ingest(db, events[i:i + MAX_BATCH], source="backfill")
        result["stored"] += part["stored"]
        result["duplicates"] += part["duplicates"]
    result["invalid"] = bad
    return result
