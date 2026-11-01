# providers/claude_code/queries.py
"""
Read side: one row per prompt with the requests it caused, plus per-person
totals, daily cost and cost by model, for a period.

A request belongs to the prompt with the same prompt.id. Claude Code versions
without prompt.id at all fall back to the latest prompt in the same session
that started before the request. Requests left over become one row per
session: Claude Code's own background calls (it makes small model calls with
no prompt.id, e.g. at session start - seen on 2.1.312), or a prompt that fell
just before the period. So the period's totals always equal the sum of its
requests' cost.
"""
from collections import defaultdict
from datetime import datetime, timedelta
from typing import Any, Optional

from sqlalchemy import func
from sqlalchemy.orm import Session

from models_new import User
from providers.claude_code.constants import SESSION_FALLBACK_MS
from providers.claude_code.models import ClaudeCodePrompt, ClaudeCodeRequest, ClaudeCodeToken
from utils.datetime_utils import serialize_utc_datetime


def surface_of(terminal_type: Optional[str]) -> str:
    t = (terminal_type or "").lower()
    if not t:
        return "Claude Code"
    if t == "non-interactive":  # claude -p, scripts and CI
        return "Claude Code · Non-interactive"
    if t.startswith("sdk"):  # app.entrypoint sdk-cli / sdk-ts / sdk-py
        return "Claude Code · SDK"
    if "slack" in t:
        return "Claude Code · Slack"
    if "cursor" in t:
        return "Claude Code · Cursor"
    if any(k in t for k in ("jetbrains", "intellij", "pycharm", "webstorm")):
        return "Claude Code · JetBrains"
    if "vscode" in t or "code" in t:
        return "Claude Code · VS Code"
    return "Claude Code · Terminal"


def _empty_tokens() -> dict[str, int]:
    return {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0}


SORT_KEYS = {
    "ts": lambda i: i["_sort"],
    "cost": lambda i: i["costUsd"],
    "tokens": lambda i: i["totalTokens"],
    "requests": lambda i: i["requests"],
    "person": lambda i: (i["ownerName"] or "").lower(),
    "model": lambda i: ",".join(i["models"]),
}


def _rows(db: Session, start: datetime, end: datetime) -> list[dict[str, Any]]:
    """Every prompt row (and background-request row) in [start, end), everyone's."""
    prompts = (
        db.query(ClaudeCodePrompt)
        .filter(ClaudeCodePrompt.prompted_at >= start, ClaudeCodePrompt.prompted_at < end)
        .order_by(ClaudeCodePrompt.prompted_at.asc())
        .all()
    )
    # Requests run after their prompt, so look a little past the end for the
    # last prompts' requests (they're only counted if their prompt is in range).
    requests = (
        db.query(ClaudeCodeRequest)
        .filter(
            ClaudeCodeRequest.occurred_at >= start,
            ClaudeCodeRequest.occurred_at < end + timedelta(milliseconds=SESSION_FALLBACK_MS),
        )
        .order_by(ClaudeCodeRequest.occurred_at.asc())
        .all()
    )

    rows: dict[tuple[int, str], dict[str, Any]] = {}
    by_session: dict[tuple[int, Optional[str]], list[ClaudeCodePrompt]] = defaultdict(list)
    for p in prompts:
        rows[(p.owner_user_id, p.prompt_uid)] = {"prompt": p, "requests": []}
        by_session[(p.owner_user_id, p.session_id)].append(p)

    fallback = timedelta(milliseconds=SESSION_FALLBACK_MS)
    for r in requests:
        key = (r.owner_user_id, r.prompt_uid) if r.prompt_uid else None
        if key is None:
            # Only prompts that had no prompt.id themselves (older Claude Code,
            # keyed "<session>:<ms>"). In a session that has prompt.id, a request
            # without one is a background call, not part of the prompt before it.
            candidates = [
                p for p in by_session.get((r.owner_user_id, r.session_id), [])
                if p.prompt_uid.startswith(f"{p.session_id}:")
                and p.prompted_at <= r.occurred_at and r.occurred_at - p.prompted_at <= fallback
            ]
            if candidates:
                key = (r.owner_user_id, candidates[-1].prompt_uid)
        if key is not None and key in rows:
            rows[key]["requests"].append(r)
        elif r.occurred_at < end:
            orphan_key = (r.owner_user_id, f"orphan:{r.prompt_uid or 'session:' + str(r.session_id)}")
            rows.setdefault(orphan_key, {"prompt": None, "requests": []})["requests"].append(r)

    owner_ids = {owner for owner, _ in rows}
    names = dict(db.query(User.id, User.name).filter(User.id.in_(owner_ids)).all()) if owner_ids else {}

    items: list[dict[str, Any]] = []
    for (owner, uid), row in rows.items():
        p: Optional[ClaudeCodePrompt] = row["prompt"]
        reqs: list[ClaudeCodeRequest] = row["requests"]
        tokens = _empty_tokens()
        cost = 0.0
        priced = True
        models: list[str] = []
        by_model: dict[str, list] = {}  # model -> [cost, requests, tokens]
        for r in reqs:
            tokens["input"] += r.input_tokens or 0
            tokens["output"] += r.output_tokens or 0
            tokens["cacheRead"] += r.cache_read_tokens or 0
            tokens["cacheWrite"] += r.cache_write_tokens or 0
            if r.cost_usd is None:
                priced = False
            else:
                cost += r.cost_usd
            model = r.model or "unknown"
            if model not in models:
                models.append(model)
            entry = by_model.setdefault(model, [0.0, 0, 0])
            entry[0] += r.cost_usd or 0.0
            entry[1] += 1
            entry[2] += (r.input_tokens or 0) + (r.output_tokens or 0) + (r.cache_read_tokens or 0) + (r.cache_write_tokens or 0)
        first = p.prompted_at if p else reqs[0].occurred_at
        last = max([r.occurred_at for r in reqs], default=first)
        terminal = (p.terminal_type if p else None) or next((r.terminal_type for r in reqs if r.terminal_type), None)
        items.append({
            "id": f"{owner}:{uid}",
            "promptUid": None if p is None else p.prompt_uid,
            "ownerUserId": owner,
            "ownerName": names.get(owner),
            "sessionId": p.session_id if p else reqs[0].session_id,
            "promptText": (p.prompt_text or None) if p else None,
            "promptLength": p.prompt_length if p else 0,
            "commandName": p.command_name if p else None,
            "hasPrompt": p is not None,
            "surface": surface_of(terminal),
            "claudeAccountEmail": (p.account_email if p else None) or next((r.account_email for r in reqs if r.account_email), None),
            "claudeVersion": (p.claude_version if p else None) or next((r.claude_version for r in reqs if r.claude_version), None),
            "promptedAt": serialize_utc_datetime(first),
            "lastActivityAt": serialize_utc_datetime(last),
            "models": models,
            "requests": len(reqs),
            "tokens": tokens,
            "totalTokens": sum(tokens.values()),
            # Partly priced rows still show what was reported; costComplete says so.
            "costUsd": round(cost, 8),
            "costComplete": priced,
            "_sort": first,
            "_byModel": by_model,
        })
    return items


def _summarize_people(items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    people: dict[int, dict[str, Any]] = {}
    for item in items:
        person = people.setdefault(item["ownerUserId"], {
            "userId": item["ownerUserId"], "name": item["ownerName"], "prompts": 0, "requests": 0,
            "costUsd": 0.0, "backgroundCostUsd": 0.0, "tokens": _empty_tokens(), "lastActiveAt": None,
        })
        person["prompts"] += 1 if item["hasPrompt"] else 0
        person["requests"] += item["requests"]
        person["costUsd"] += item["costUsd"]
        if not item["hasPrompt"]:
            person["backgroundCostUsd"] += item["costUsd"]
        for k, v in item["tokens"].items():
            person["tokens"][k] += v
        person["lastActiveAt"] = max(filter(None, [person["lastActiveAt"], item["lastActivityAt"]]))
    for person in people.values():
        person["costUsd"] = round(person["costUsd"], 8)
        person["backgroundCostUsd"] = round(person["backgroundCostUsd"], 8)
        person["totalTokens"] = sum(person["tokens"].values())
    return sorted(people.values(), key=lambda p: (-p["costUsd"], (p["name"] or "").lower()))


def _matches(item: dict[str, Any], needle: str) -> bool:
    haystack = " ".join(filter(None, [
        item["promptText"], item["commandName"], item["ownerName"], item["surface"],
        item["sessionId"], item["claudeAccountEmail"], *item["models"],
    ])).lower()
    return needle in haystack


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
    """The Claude Code tab for [start, end).

    people     everyone active in the period, so the table can dim the others
               while one person is picked
    totals, daily, byModel
               the picked person (or everyone) - never narrowed by the search
    prompts    the search-filtered, sorted page of rows

    tz_offset_min is the viewer's JS getTimezoneOffset(), so "daily" buckets
    fall on their own local days.
    """
    items = _rows(db, start, end)
    people = _summarize_people(items)
    scoped = [i for i in items if not owner_user_id or i["ownerUserId"] == owner_user_id]

    to_local = timedelta(minutes=-tz_offset_min)
    daily: dict[str, dict[str, Any]] = {}
    by_model: dict[str, dict[str, Any]] = {}
    for item in scoped:
        day = (item["_sort"] + to_local).date().isoformat()
        bucket = daily.setdefault(day, {"date": day, "costUsd": 0.0, "prompts": 0, "requests": 0})
        bucket["costUsd"] += item["costUsd"]
        bucket["prompts"] += 1 if item["hasPrompt"] else 0
        bucket["requests"] += item["requests"]
        # Per model call, not per prompt: one prompt can use several models.
        for model, (cost, n, tok) in item["_byModel"].items():
            entry = by_model.setdefault(model, {"model": model, "costUsd": 0.0, "requests": 0, "prompts": 0, "totalTokens": 0})
            entry["costUsd"] += cost
            entry["requests"] += n
            entry["totalTokens"] += tok
            entry["prompts"] += 1 if item["hasPrompt"] else 0
    for bucket in daily.values():
        bucket["costUsd"] = round(bucket["costUsd"], 8)
    for entry in by_model.values():
        entry["costUsd"] = round(entry["costUsd"], 8)

    typed = [i for i in scoped if i["hasPrompt"]]
    top = max(typed, key=lambda i: i["costUsd"], default=None)
    totals = {
        "prompts": len(typed),
        "requests": sum(i["requests"] for i in scoped),
        "costUsd": round(sum(i["costUsd"] for i in scoped), 8),
        "promptCostUsd": round(sum(i["costUsd"] for i in typed), 8),
        "backgroundCostUsd": round(sum(i["costUsd"] for i in scoped if not i["hasPrompt"]), 8),
        "totalTokens": sum(i["totalTokens"] for i in scoped),
        "cacheReadTokens": sum(i["tokens"]["cacheRead"] for i in scoped),
        "topPromptCostUsd": top["costUsd"] if top else None,
        "costComplete": all(i["costComplete"] for i in scoped),
        "activeDays": len(daily),
    }

    needle = (q or "").strip().lower()
    listed = [i for i in scoped if _matches(i, needle)] if needle else list(scoped)
    listed.sort(key=SORT_KEYS.get(sort, SORT_KEYS["ts"]), reverse=descending)
    page = [{k: v for k, v in item.items() if not k.startswith("_")} for item in listed[offset:offset + limit]]

    last_seen = db.query(func.max(ClaudeCodeToken.last_seen_at)).scalar()
    return {
        "prompts": page,
        "pagination": {"limit": limit, "offset": offset, "total": len(listed)},
        "people": people,
        "totals": totals,
        "daily": sorted(daily.values(), key=lambda d: d["date"]),
        "byModel": sorted(by_model.values(), key=lambda m: m["costUsd"], reverse=True),
        "lastIngestAt": serialize_utc_datetime(last_seen),
    }
