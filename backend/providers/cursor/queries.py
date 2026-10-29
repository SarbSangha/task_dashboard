# providers/cursor/queries.py
"""
Read-side query logic backing router.py's GET endpoints.

Usage is matched to prompts at read time (matching.py), never stored, so a new
CSV upload or a late-arriving prompt re-attributes correctly without any
backfill. Matching is local in time - a request can only belong to a prompt
from at most MAX_PROMPT_SPAN_MS before it or EARLY_EVENT_MS after it - so any
page/period only needs the prompts and requests in a padded window around it.
"""
from collections import defaultdict
from dataclasses import dataclass
from datetime import date, datetime, time, timedelta, timezone
from typing import Optional

from sqlalchemy import func, or_
from sqlalchemy.orm import Session

from models_new import User
from providers.cursor.constants import EARLY_EVENT_MS, MAX_PROMPT_SPAN_MS, PROVIDER
from providers.cursor.matching import PromptSlot, UsageSlot, match_usage, summarize_prompt
from providers.cursor.models import CursorPrompt, CursorUsageEvent, CursorUsageUpload

DEFAULT_LIMIT = 24
MAX_LIMIT = 200

# Events can belong to prompts up to MAX_PROMPT_SPAN_MS earlier; prompts that
# could claim those events reach back another span.
EVENT_PAD = timedelta(milliseconds=MAX_PROMPT_SPAN_MS + EARLY_EVENT_MS)
PROMPT_PAD = timedelta(milliseconds=2 * MAX_PROMPT_SPAN_MS + EARLY_EVENT_MS)


def _ms(value: Optional[datetime]) -> Optional[int]:
    if value is None:
        return None
    return int(value.replace(tzinfo=timezone.utc).timestamp() * 1000)


def _day_start(value: Optional[date]) -> Optional[datetime]:
    return datetime.combine(value, time.min) if value else None


def _day_end(value: Optional[date]) -> Optional[datetime]:
    return datetime.combine(value + timedelta(days=1), time.min) if value else None


@dataclass
class PromptFilters:
    q: Optional[str] = None
    owner_user_id: Optional[int] = None
    account_email: Optional[str] = None
    date_from: Optional[date] = None
    date_to: Optional[date] = None


def _apply_prompt_filters(query, filters: PromptFilters):
    query = query.filter(CursorPrompt.provider == PROVIDER)
    if filters.owner_user_id is not None:
        query = query.filter(CursorPrompt.owner_user_id == filters.owner_user_id)
    if filters.account_email:
        query = query.filter(CursorPrompt.cursor_account_email == filters.account_email)
    if filters.date_from:
        query = query.filter(CursorPrompt.prompted_at >= _day_start(filters.date_from))
    if filters.date_to:
        query = query.filter(CursorPrompt.prompted_at < _day_end(filters.date_to))
    if filters.q:
        like = f"%{filters.q}%"
        query = query.filter(
            or_(
                CursorPrompt.prompt_text.ilike(like),
                CursorPrompt.conversation_name.ilike(like),
                CursorPrompt.device_name.ilike(like),
            )
        )
    return query


# ---------------- matching over a time window ----------------

@dataclass
class MatchedWindow:
    slots: dict  # CursorPrompt.id -> PromptSlot
    unmatched: list  # [(account_email, UsageSlot)]


def _match_window(db: Session, start: datetime, end: datetime, account_email: Optional[str] = None) -> MatchedWindow:
    prompt_query = db.query(CursorPrompt).filter(
        CursorPrompt.provider == PROVIDER,
        CursorPrompt.prompted_at >= start - PROMPT_PAD,
        CursorPrompt.prompted_at < end + PROMPT_PAD,
    )
    event_query = db.query(CursorUsageEvent).filter(
        CursorUsageEvent.provider == PROVIDER,
        CursorUsageEvent.occurred_at >= start - EVENT_PAD,
        CursorUsageEvent.occurred_at < end + EVENT_PAD,
    )
    if account_email:
        prompt_query = prompt_query.filter(CursorPrompt.cursor_account_email.in_([account_email, ""]))
        event_query = event_query.filter(CursorUsageEvent.cursor_account_email.in_([account_email, ""]))

    prompts = prompt_query.all()
    slots = {
        p.id: PromptSlot(
            id=p.id,
            person=p.owner_user_id,
            ts=_ms(p.prompted_at),
            end_ts=_ms(p.completed_at),
            models=list(p.models_json or []),
            steps=p.steps or 0,
            local_tokens=(p.local_input_tokens or 0) + (p.local_output_tokens or 0),
        )
        for p in prompts
    }
    account_of = {p.id: p.cursor_account_email or "" for p in prompts}

    events_by_account: dict[str, list[UsageSlot]] = defaultdict(list)
    for ev in event_query.all():
        events_by_account[ev.cursor_account_email or ""].append(
            UsageSlot(
                id=ev.id,
                ts=_ms(ev.occurred_at),
                model=ev.model or "",
                input_tokens=ev.input_tokens or 0,
                output_tokens=ev.output_tokens or 0,
                cache_read_tokens=ev.cache_read_tokens or 0,
                cache_write_tokens=ev.cache_write_tokens or 0,
                cost_cents=ev.cost_cents,
            )
        )

    # A CSV only matches prompts from computers signed in to that account. Prompts
    # whose account the extension couldn't read ("") can match any account's rows.
    unmatched = []
    for account, events in events_by_account.items():
        candidates = [
            slot for pid, slot in slots.items()
            if not account or account_of[pid] in (account, "")
        ]
        for leftover in match_usage(candidates, events):
            unmatched.append((account, leftover))
    return MatchedWindow(slots=slots, unmatched=unmatched)


def _latest_upload_end_by_account(db: Session) -> dict[str, datetime]:
    rows = (
        db.query(CursorUsageUpload.cursor_account_email, func.max(CursorUsageUpload.range_end))
        .group_by(CursorUsageUpload.cursor_account_email)
        .all()
    )
    return {account or "": end for account, end in rows if end}


def _usage_status(prompt: CursorPrompt, summary: dict, upload_ends: dict[str, datetime]) -> str:
    """matched | pending (no CSV covers this prompt yet) | unmatched (a CSV covers it, no request tied)."""
    if summary["requests"]:
        return "matched"
    account = prompt.cursor_account_email or ""
    covered_until = upload_ends.get(account) or (max(upload_ends.values()) if upload_ends else None)
    if covered_until is None or prompt.prompted_at > covered_until:
        return "pending"
    return "unmatched"


def attach_owner_summaries(db: Session, dicts: list[dict], key: str = "ownerUserId") -> list[dict]:
    owner_ids = {item.get(key) for item in dicts if item.get(key)}
    users_by_id = {user.id: user for user in db.query(User).filter(User.id.in_(owner_ids)).all()} if owner_ids else {}
    for item in dicts:
        user = users_by_id.get(item.get(key))
        item["ownerName"] = user.name if user else None
        item["ownerEmployeeId"] = user.employee_id if user else None
        item["ownerDepartment"] = user.department if user else None
    return dicts


# ---------------- public read functions ----------------

def list_prompts(db: Session, *, filters: PromptFilters, limit: int = DEFAULT_LIMIT, offset: int = 0):
    query = _apply_prompt_filters(db.query(CursorPrompt), filters)
    total = query.count()
    page = query.order_by(CursorPrompt.prompted_at.desc(), CursorPrompt.id.desc()).offset(offset).limit(limit).all()
    if not page:
        return [], total

    window = _match_window(
        db,
        min(p.prompted_at for p in page),
        max(p.prompted_at for p in page),
        account_email=filters.account_email,
    )
    upload_ends = _latest_upload_end_by_account(db)
    items = []
    for prompt in page:
        usage = summarize_prompt(window.slots[prompt.id])
        item = prompt.to_dict()
        item.update(usage)
        item["usageStatus"] = _usage_status(prompt, usage, upload_ends)
        items.append(item)
    return attach_owner_summaries(db, items), total


def get_prompt(db: Session, prompt_id: int) -> Optional[dict]:
    prompt = db.query(CursorPrompt).filter(CursorPrompt.provider == PROVIDER, CursorPrompt.id == prompt_id).first()
    if not prompt:
        return None
    window = _match_window(db, prompt.prompted_at, prompt.prompted_at, account_email=prompt.cursor_account_email or None)
    usage = summarize_prompt(window.slots[prompt.id])
    item = prompt.to_dict()
    item.update(usage)
    item["usageStatus"] = _usage_status(prompt, usage, _latest_upload_end_by_account(db))
    return attach_owner_summaries(db, [item])[0]


def summarize_period(
    db: Session,
    *,
    date_from: Optional[date],
    date_to: Optional[date],
    account_email: Optional[str] = None,
) -> dict:
    """Per-person token share for the period, plus an "Unassigned" bucket for
    requests no one had a prompt running for, so the rows add up to the
    account's total in Cursor's CSV."""
    bounds = db.query(func.min(CursorPrompt.prompted_at), func.max(CursorPrompt.prompted_at)).filter(
        CursorPrompt.provider == PROVIDER
    ).one()
    event_bounds = db.query(func.min(CursorUsageEvent.occurred_at), func.max(CursorUsageEvent.occurred_at)).one()
    known = [value for value in (*bounds, *event_bounds) if value is not None]
    start = _day_start(date_from) or (min(known) if known else datetime.utcnow())
    end = _day_end(date_to) or ((max(known) + timedelta(seconds=1)) if known else datetime.utcnow())

    window = _match_window(db, start, end, account_email=account_email)
    prompts = (
        db.query(CursorPrompt)
        .filter(CursorPrompt.provider == PROVIDER, CursorPrompt.prompted_at >= start, CursorPrompt.prompted_at < end)
    )
    if account_email:
        prompts = prompts.filter(CursorPrompt.cursor_account_email == account_email)

    people: dict[int, dict] = {}
    for prompt in prompts.all():
        usage = summarize_prompt(window.slots[prompt.id])
        row = people.setdefault(prompt.owner_user_id, {
            "ownerUserId": prompt.owner_user_id, "prompts": 0, "tokens": 0, "costCents": 0.0,
            "pendingPrompts": 0, "sharedPrompts": 0, "lastActiveAt": None,
        })
        row["prompts"] += 1
        if usage["tokens"]:
            row["tokens"] += usage["tokens"]["total"]
            row["costCents"] += usage["costCents"] or 0
        else:
            row["pendingPrompts"] += 1
        if usage["shared"]:
            row["sharedPrompts"] += 1
        if row["lastActiveAt"] is None or prompt.prompted_at > row["lastActiveAt"]:
            row["lastActiveAt"] = prompt.prompted_at

    start_ms, end_ms = _ms(start), _ms(end)
    unassigned = [e for _, e in window.unmatched if start_ms <= e.ts < end_ms]
    unassigned_tokens = sum(e.total_tokens for e in unassigned)
    unassigned_cost = sum(e.cost_cents or 0 for e in unassigned)

    rows = sorted(people.values(), key=lambda r: (r["tokens"], r["prompts"]), reverse=True)
    for row in rows:
        row["costCents"] = round(row["costCents"], 4)
        row["lastActiveAt"] = row["lastActiveAt"].isoformat() + "Z" if row["lastActiveAt"] else None
    attach_owner_summaries(db, rows)

    total_tokens = sum(r["tokens"] for r in rows) + unassigned_tokens
    return {
        "periodStart": start.isoformat() + "Z",
        "periodEnd": end.isoformat() + "Z",
        "people": rows,
        "unassigned": {
            "requests": len(unassigned),
            "tokens": unassigned_tokens,
            "costCents": round(unassigned_cost, 4),
        },
        "totalTokens": total_tokens,
        "totalCostCents": round(sum(r["costCents"] for r in rows) + unassigned_cost, 4),
        "totalPrompts": sum(r["prompts"] for r in rows),
    }


VIEW_TEXT_PREVIEW_CHARS = 300


def build_view(db: Session, *, start: datetime, end: datetime, account_email: Optional[str] = None) -> dict:
    """Everything the Cursor tab's usage page draws for one period, in one call
    (tiles, by person, daily burn, by model, the prompt table): every prompt in
    [start, end) with its matched usage, plus the requests nobody claimed.
    Prompt text is cut to a preview - the full text loads per row via get_prompt."""
    window = _match_window(db, start, end, account_email=account_email)
    query = db.query(CursorPrompt).filter(
        CursorPrompt.provider == PROVIDER,
        CursorPrompt.prompted_at >= start,
        CursorPrompt.prompted_at < end,
    )
    if account_email:
        query = query.filter(CursorPrompt.cursor_account_email == account_email)
    upload_ends = _latest_upload_end_by_account(db)

    prompts = []
    for prompt in query.order_by(CursorPrompt.prompted_at.asc()).all():
        usage = summarize_prompt(window.slots[prompt.id])
        text = prompt.prompt_text or ""
        prompts.append({
            "id": prompt.id,
            "ownerUserId": prompt.owner_user_id,
            "promptedAt": prompt.to_dict()["promptedAt"],
            "completedAt": prompt.to_dict()["completedAt"],
            "conversationName": prompt.conversation_name,
            "mode": prompt.mode,
            "text": text[:VIEW_TEXT_PREVIEW_CHARS],
            "textTruncated": bool(prompt.text_truncated) or len(text) > VIEW_TEXT_PREVIEW_CHARS,
            "localModels": list(prompt.models_json or []),
            "steps": prompt.steps or 0,
            "deviceName": prompt.device_name,
            "cursorAccountEmail": prompt.cursor_account_email or None,
            "usageStatus": _usage_status(prompt, usage, upload_ends),
            **usage,
        })
    attach_owner_summaries(db, prompts)

    start_ms, end_ms = _ms(start), _ms(end)
    unmatched = [
        {
            "occurredAt": datetime.fromtimestamp(e.ts / 1000, tz=timezone.utc).isoformat().replace("+00:00", "Z"),
            "model": e.model,
            "tokens": {
                "input": e.input_tokens, "output": e.output_tokens,
                "cacheRead": e.cache_read_tokens, "cacheWrite": e.cache_write_tokens,
                "total": e.total_tokens,
            },
            "costCents": e.cost_cents,
        }
        for _, e in window.unmatched
        if start_ms <= e.ts < end_ms
    ]

    uploads = db.query(CursorUsageUpload).order_by(CursorUsageUpload.created_at.desc())
    if account_email:
        uploads = uploads.filter(CursorUsageUpload.cursor_account_email == account_email)
    latest_upload = uploads.first()
    last_ingest = db.query(func.max(CursorPrompt.updated_at)).filter(CursorPrompt.provider == PROVIDER).scalar()

    return {
        "prompts": prompts,
        "unmatched": unmatched,
        "latestUpload": latest_upload.to_dict() if latest_upload else None,
        "lastIngestAt": last_ingest.isoformat() + "Z" if last_ingest else None,
    }


def list_accounts(db: Session) -> list[dict]:
    """Every Cursor login seen from extensions or uploads, newest activity first."""
    prompt_rows = (
        db.query(CursorPrompt.cursor_account_email, func.count(CursorPrompt.id), func.max(CursorPrompt.prompted_at))
        .filter(CursorPrompt.provider == PROVIDER)
        .group_by(CursorPrompt.cursor_account_email)
        .all()
    )
    upload_rows = (
        db.query(CursorUsageUpload.cursor_account_email, func.max(CursorUsageUpload.created_at), func.max(CursorUsageUpload.range_end))
        .group_by(CursorUsageUpload.cursor_account_email)
        .all()
    )
    accounts: dict[str, dict] = {}
    for email, count, last in prompt_rows:
        accounts.setdefault(email or "", {"email": email or None})
        accounts[email or ""].update({"prompts": count, "lastPromptAt": last.isoformat() + "Z" if last else None})
    for email, uploaded_at, range_end in upload_rows:
        accounts.setdefault(email or "", {"email": email or None})
        accounts[email or ""].update({
            "lastUploadAt": uploaded_at.isoformat() + "Z" if uploaded_at else None,
            "csvCoversUntil": range_end.isoformat() + "Z" if range_end else None,
        })
    return sorted(accounts.values(), key=lambda a: a.get("lastPromptAt") or a.get("lastUploadAt") or "", reverse=True)


def list_uploads(db: Session, *, limit: int = 20) -> list[dict]:
    uploads = db.query(CursorUsageUpload).order_by(CursorUsageUpload.created_at.desc()).limit(limit).all()
    return attach_owner_summaries(db, [u.to_dict() for u in uploads], key="uploadedByUserId")


def count_unmatched_in_range(db: Session, start: datetime, end: datetime, account_email: str) -> tuple[int, int]:
    """(matched, unassigned) request counts for an upload's own range - shown right after upload."""
    window = _match_window(db, start, end + timedelta(seconds=1), account_email=account_email or None)
    start_ms, end_ms = _ms(start), _ms(end + timedelta(seconds=1))
    unassigned = sum(1 for account, e in window.unmatched if start_ms <= e.ts < end_ms and account == (account_email or ""))
    total = (
        db.query(func.count(CursorUsageEvent.id))
        .filter(
            CursorUsageEvent.cursor_account_email == (account_email or ""),
            CursorUsageEvent.occurred_at >= start,
            CursorUsageEvent.occurred_at <= end,
        )
        .scalar()
    )
    return total - unassigned, unassigned

