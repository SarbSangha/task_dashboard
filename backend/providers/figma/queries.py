# providers/figma/queries.py
"""
Read side for the Figma tab: every prompt in a period with its credits, plus
per-person, per-day and per-file totals, and each Figma account's latest
balance next to the credits captured in that account's own billing month.
"""
from datetime import datetime, timedelta
from typing import Any, Optional

from sqlalchemy import func
from sqlalchemy.orm import Session

from models_new import User
from providers.figma.capture import readable_prompt
from providers.figma.constants import STATUS_COMPLETED, STATUS_FAILED, STATUS_PENDING
from providers.figma.models import FigmaBalanceSnapshot, FigmaPrompt
from utils.datetime_utils import serialize_utc_datetime

SORT_KEYS = {
    "ts": lambda i: i["_sort"],
    "credits": lambda i: i["credits"] if i["credits"] is not None else -1,
    "person": lambda i: (i["ownerName"] or "").lower(),
    "file": lambda i: (i["fileName"] or "").lower(),
}


def _item(p: FigmaPrompt, names: dict[int, str]) -> dict[str, Any]:
    return {
        "id": p.id,
        "userActionUuid": p.user_action_uuid,
        "ownerUserId": p.owner_user_id,
        "ownerName": names.get(p.owner_user_id),
        "promptText": readable_prompt(p.prompt_text) or None,
        "promptLength": p.prompt_length or 0,
        "fileKey": p.file_key,
        "fileName": p.file_name,
        "fileUrl": p.file_url,
        "threadId": p.thread_id,
        "origin": p.origin,
        "status": p.status,
        "credits": p.credits_used,
        "toolCalls": p.tool_calls,
        "workMs": p.work_ms,
        "figmaEmail": p.figma_email,
        "planTier": p.plan_tier,
        "linkedTaskName": p.linked_task_name,
        "linkedClientName": p.linked_client_name,
        "promptedAt": serialize_utc_datetime(p.prompted_at),
        "_sort": p.prompted_at,
    }


def _summarize_people(items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    people: dict[Optional[int], dict[str, Any]] = {}
    for item in items:
        person = people.setdefault(item["ownerUserId"], {
            "userId": item["ownerUserId"], "name": item["ownerName"], "prompts": 0, "credits": 0.0,
            "pending": 0, "failed": 0, "files": set(), "lastActiveAt": None,
        })
        person["prompts"] += 1
        person["credits"] += item["credits"] or 0.0
        person["pending"] += 1 if item["status"] == STATUS_PENDING else 0
        person["failed"] += 1 if item["status"] == STATUS_FAILED else 0
        if item["fileKey"]:
            person["files"].add(item["fileKey"])
        person["lastActiveAt"] = max(filter(None, [person["lastActiveAt"], item["promptedAt"]]))
    out = []
    for person in people.values():
        person["files"] = len(person["files"])
        person["credits"] = round(person["credits"], 4)
        out.append(person)
    return sorted(out, key=lambda p: (-p["credits"], (p["name"] or "").lower()))


def _matches(item: dict[str, Any], needle: str) -> bool:
    haystack = " ".join(filter(None, [
        item["promptText"], item["ownerName"], item["fileName"], item["figmaEmail"],
        item["linkedClientName"], item["linkedTaskName"], item["userActionUuid"],
    ])).lower()
    return needle in haystack


def accounts(db: Session) -> list[dict[str, Any]]:
    """Each Figma login's latest balance, and the credits captured from it in
    that billing month - Figma's "consumed" minus those is AI used where the
    extension wasn't watching (another browser, the desktop app, other AI
    features)."""
    latest_ids = (
        db.query(func.max(FigmaBalanceSnapshot.id))
        .group_by(FigmaBalanceSnapshot.figma_user_id)
        .all()
    )
    ids = [row[0] for row in latest_ids if row[0]]
    if not ids:
        return []
    snapshots = db.query(FigmaBalanceSnapshot).filter(FigmaBalanceSnapshot.id.in_(ids)).all()
    out = []
    for s in sorted(snapshots, key=lambda s: s.captured_at, reverse=True):
        item = s.to_dict()
        captured = None
        if s.period_start:
            end = s.period_end or (s.period_start + timedelta(days=31))
            captured = (
                db.query(func.coalesce(func.sum(FigmaPrompt.credits_used), 0.0))
                .filter(FigmaPrompt.figma_user_id == s.figma_user_id,
                        FigmaPrompt.prompted_at >= s.period_start, FigmaPrompt.prompted_at < end)
                .scalar()
            )
        item["capturedCredits"] = round(float(captured), 4) if captured is not None else None
        item["notCapturedCredits"] = (
            round(max(0.0, (s.monthly_consumed or 0.0) - float(captured)), 4) if captured is not None else None
        )
        out.append(item)
    return out


def build_view(
    db: Session,
    start: datetime,
    end: datetime,
    owner_user_id: Optional[int] = None,
    q: Optional[str] = None,
    sort: str = "ts",
    descending: bool = True,
    limit: int = 200,
    offset: int = 0,
    tz_offset_min: int = 0,
) -> dict[str, Any]:
    """The Figma tab for [start, end). Same shape as the Claude Code tab:
    people is everyone (so the table can dim the others while one person is
    picked); totals/daily/byFile are the picked person or everyone and never
    narrowed by the search; prompts is the searched, sorted page."""
    rows = (
        db.query(FigmaPrompt)
        .filter(FigmaPrompt.prompted_at >= start, FigmaPrompt.prompted_at < end)
        .order_by(FigmaPrompt.prompted_at.asc())
        .all()
    )
    owner_ids = {r.owner_user_id for r in rows if r.owner_user_id}
    names = dict(db.query(User.id, User.name).filter(User.id.in_(owner_ids)).all()) if owner_ids else {}
    items = [_item(r, names) for r in rows]
    people = _summarize_people(items)
    scoped = [i for i in items if not owner_user_id or i["ownerUserId"] == owner_user_id]

    to_local = timedelta(minutes=-tz_offset_min)
    daily: dict[str, dict[str, Any]] = {}
    by_file: dict[str, dict[str, Any]] = {}
    for item in scoped:
        day = (item["_sort"] + to_local).date().isoformat()
        bucket = daily.setdefault(day, {"date": day, "credits": 0.0, "prompts": 0})
        bucket["credits"] += item["credits"] or 0.0
        bucket["prompts"] += 1
        key = item["fileKey"] or "-"
        entry = by_file.setdefault(key, {"fileKey": item["fileKey"], "fileName": item["fileName"],
                                         "fileUrl": item["fileUrl"], "credits": 0.0, "prompts": 0, "people": set()})
        entry["fileName"] = entry["fileName"] or item["fileName"]
        entry["credits"] += item["credits"] or 0.0
        entry["prompts"] += 1
        entry["people"].add(item["ownerUserId"])
    for bucket in daily.values():
        bucket["credits"] = round(bucket["credits"], 4)
    files = []
    for entry in by_file.values():
        entry["credits"] = round(entry["credits"], 4)
        entry["people"] = len(entry["people"])
        files.append(entry)

    costed = [i for i in scoped if i["status"] == STATUS_COMPLETED]
    credits = sum(i["credits"] or 0.0 for i in scoped)
    top = max(costed, key=lambda i: i["credits"] or 0.0, default=None)
    totals = {
        "prompts": len(scoped),
        "credits": round(credits, 4),
        "costedPrompts": len(costed),
        "pendingPrompts": sum(1 for i in scoped if i["status"] == STATUS_PENDING),
        "failedPrompts": sum(1 for i in scoped if i["status"] == STATUS_FAILED),
        "avgCredits": round(credits / len(costed), 2) if costed else None,
        "topPromptCredits": top["credits"] if top else None,
        "files": len({i["fileKey"] for i in scoped if i["fileKey"]}),
        "activeDays": len(daily),
    }

    needle = (q or "").strip().lower()
    listed = [i for i in scoped if _matches(i, needle)] if needle else list(scoped)
    listed.sort(key=SORT_KEYS.get(sort, SORT_KEYS["ts"]), reverse=descending)
    page = [{k: v for k, v in item.items() if not k.startswith("_")} for item in listed[offset:offset + limit]]

    last_ingest = db.query(func.max(FigmaPrompt.updated_at)).scalar()
    return {
        "prompts": page,
        "pagination": {"limit": limit, "offset": offset, "total": len(listed)},
        "people": people,
        "totals": totals,
        "daily": sorted(daily.values(), key=lambda d: d["date"]),
        "byFile": sorted(files, key=lambda f: f["credits"], reverse=True),
        "accounts": accounts(db),
        "lastIngestAt": serialize_utc_datetime(last_ingest),
    }
