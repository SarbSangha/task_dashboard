"""
Usage Intelligence aggregations.

Grain matches the existing AI-usage workbook so the live dashboard and Excel
never disagree:

  * ChatGPT volume  = ConversationRecord.prompt_count (IST-dated created_at)
  * Kling volume    = ITPortalToolUsageEvent (IST event_date), credits clamped
  * Other tools     = provider generation tables, owner-attributed rows only

Privacy: prompt/response text is never selected into this snapshot. Generation
"category" is derived from the tool (and, for Envato, item_type).
"""

from __future__ import annotations

import re
from collections import defaultdict
from datetime import date, datetime, timedelta
from typing import Optional

from sqlalchemy import Date, case, cast, func, literal, or_
from sqlalchemy.orm import Session, joinedload

from models_new import (
    ITPortalTool,
    ITPortalToolAudit,
    ITPortalToolCredential,
    ITPortalToolUsageEvent,
    ToolCreditRate,
    User,
    UserActivity,
)
from providers.chatgpt.models import ConversationRecord
from providers.elevenlabs.models import ElevenlabsGeneration
from providers.envato.models import EnvatoGeneration
from providers.flow.models import FlowGeneration
from providers.freepik.models import FreepikGeneration
from providers.heygen.models import HeygenGeneration
from providers.higgsfield.models import HiggsfieldGeneration
from utils.credential_crypto import decrypt_secret
from utils.permissions import resolve_roles
from utils.tool_renewal_service import (
    DEFAULT_RENEWAL_TYPE,
    STATUS_NOT_APPLICABLE,
    calculate_renewal_status,
    normalize_renewal_type,
    resolve_remaining_credits,
)

# --------------------------------------------------------------------------- #
# Constants
# --------------------------------------------------------------------------- #
LOCAL_TZ_OFFSET = timedelta(minutes=330)
MAX_SANE_KLING_CREDITS = 3000
KLING_TOOL_SLUGS = ("kling", "kling-ai", "klingai")
# Exact separator-stripped keys that mean ChatGPT but contain no "chatgpt"
# substring -- the dashboard has both a "gpt" and a "CHAT GPT" tool.
CHATGPT_TOOL_KEYS = frozenset({"gpt", "chatgpt", "openai"})
FREEPIK_VIDEO_TOOL = "video-generator"
TOOL_SESSION_CAP = timedelta(hours=2)
FAIL_STATUSES = frozenset({"failed", "error", "cancelled", "canceled", "rejected", "timeout"})
# Terminal success states. "settled" is Kling's ledger-settled event. A status
# in neither set (draft, processing, submitted, generating_music, ...) is still
# in flight and counts as neither success nor failure -- a still-running
# generation is not a success yet.
SUCCESS_STATUSES = frozenset({
    "active", "completed", "captured", "success", "succeeded", "done", "settled",
})
TIMELINE_CAP = 4_000
INACTIVE_BAND = "Inactive"
LOW_BAND = "Low"
MID_BAND = "Medium"
HIGH_BAND = "High"

METHODOLOGY = {
    "team": "A team is a User.department. Users with a blank department are Unassigned.",
    "teamLead": "Department lead is the first HOD (role or position) in that department. There is no reporting-manager column.",
    "session": "One user_activities row per user per calendar day. A session is a row with a login or heartbeat_count > 0.",
    "usageTime": "Person-report tool time is measured from dashboard launches (ITPortalToolAudit tool_launched): a session runs until the user's next launch or 2 hours, clipped to the report window. Platform presence still uses user_activities for org-level hours.",
    "generations": "ChatGPT = captured prompt_count; Kling = usage events; other tools = owner-attributed provider rows.",
    "success": "Success = a terminal success status (active, completed, captured, success, succeeded, done, settled), or a provider that exposes no status field at all (Flow, ElevenLabs) where the capture itself is the only signal. Failed/cancelled are failures. Anything still in flight (draft, processing, submitted, generating_music) is neither, so success + failed can be less than total generations. ChatGPT captures completed prompts only, so its failure rate is unobserved.",
    "credits": "Sum of captured credit fields. Kling values outside 0–3000 are treated as 0. Envato credits are a UI badge (best-effort). ChatGPT/Flow have no credit ledger.",
    "engagement": "0–100 consistency score: 40% active-day ratio, 25% tool diversity vs org tools in use, 25% success rate, 10% recency. This is engagement, not productivity. Usage ≠ productivity.",
    "creditEfficiency": "credits / successful generations. Lower is more efficient. Undefined when successful generations = 0.",
    "category": "Derived from the tool (and Envato item_type). Prompts are never returned.",
    "client": "Client is the generate-time picker (linked_client_name). Blank picker = Not linked. ChatGPT conversations are not client-mapped.",
    "anomalies": "Flags for review, not a determination of misuse.",
}

NO_CLIENT = "Not linked"
PERSON_GEN_CAP = 5_000


# --------------------------------------------------------------------------- #
# Period
# --------------------------------------------------------------------------- #
def _parse_date(value: Optional[str]) -> Optional[date]:
    if not value:
        return None
    try:
        return datetime.strptime(str(value).strip()[:10], "%Y-%m-%d").date()
    except (ValueError, TypeError, AttributeError):
        return None


def resolve_period(
    preset: Optional[str] = None,
    start: Optional[str] = None,
    end: Optional[str] = None,
    today: Optional[date] = None,
) -> dict:
    today = today or date.today()
    key = (preset or "").strip().lower()

    if key == "today":
        s = e = today
    elif key == "yesterday":
        s = e = today - timedelta(days=1)
    elif key in {"7d", "last_7_days"}:
        e = today
        s = today - timedelta(days=6)
    elif key in {"30d", "last_30_days"}:
        e = today
        s = today - timedelta(days=29)
    elif key in {"month", "current_month"}:
        s = today.replace(day=1)
        e = today
    elif key in {"prev_month", "previous_month"}:
        first = today.replace(day=1)
        e = first - timedelta(days=1)
        s = e.replace(day=1)
    elif key in {"quarter", "current_quarter"}:
        q_month = ((today.month - 1) // 3) * 3 + 1
        s = date(today.year, q_month, 1)
        e = today
    elif start or end:
        e = _parse_date(end) or today
        s = _parse_date(start) or (e - timedelta(days=29))
    else:
        e = today
        s = today - timedelta(days=29)

    if s > e:
        s, e = e, s
    days = max((e - s).days + 1, 1)
    start_dt = datetime(s.year, s.month, s.day)
    end_exclusive = datetime(e.year, e.month, e.day) + timedelta(days=1)
    prev_end_exclusive = start_dt
    prev_start_dt = start_dt - timedelta(days=days)
    prev_start = prev_start_dt.date()
    prev_end = (prev_end_exclusive - timedelta(days=1)).date()
    return {
        "start": s,
        "end": e,
        "days": days,
        "label": f"{s:%d %b %Y} – {e:%d %b %Y}",
        "start_dt": start_dt,
        "end_exclusive": end_exclusive,
        "prev_start": prev_start,
        "prev_end": prev_end,
        "prev_start_dt": prev_start_dt,
        "prev_end_exclusive": prev_end_exclusive,
        "utc_start": start_dt - LOCAL_TZ_OFFSET,
        "utc_end": end_exclusive - LOCAL_TZ_OFFSET,
        "prev_utc_start": prev_start_dt - LOCAL_TZ_OFFSET,
        "prev_utc_end": prev_end_exclusive - LOCAL_TZ_OFFSET,
    }


def _metric(current, previous) -> dict:
    current = float(current or 0)
    previous = float(previous or 0)
    if previous == 0:
        delta_pct = 100.0 if current > 0 else 0.0
    else:
        delta_pct = round(((current - previous) / previous) * 100.0, 1)
    if current > previous:
        direction = "up"
    elif current < previous:
        direction = "down"
    else:
        direction = "flat"
    def _n(v):
        if abs(v - round(v)) < 1e-9:
            return int(round(v))
        return round(v, 2)
    return {
        "value": _n(current),
        "previous": _n(previous),
        "deltaPct": delta_pct,
        "direction": direction,
    }


def _hours(seconds: float) -> float:
    return round(float(seconds or 0) / 3600.0, 2)


def _dept(value: Optional[str]) -> str:
    name = (value or "").strip()
    return name if name else "Unassigned"


def _is_fail(status: Optional[str]) -> bool:
    return (status or "").strip().lower() in FAIL_STATUSES


def _is_success(status: Optional[str]) -> bool:
    raw = (status or "").strip().lower()
    if not raw:
        # Flow and ElevenLabs carry no status field on any captured payload, so
        # the capture itself is the only completion signal available.
        return True
    return raw in SUCCESS_STATUSES


def _norm_status(col):
    """Status values are provider-supplied; normalise before matching."""
    return func.lower(func.trim(func.coalesce(col, "")))


def _success_case(col):
    norm = _norm_status(col)
    return case((norm == "", 1), (norm.in_(tuple(SUCCESS_STATUSES)), 1), else_=0)


def _fail_case(col):
    return case((_norm_status(col).in_(tuple(FAIL_STATUSES)), 1), else_=0)


def _sane_kling_credits():
    return case(
        (
            ITPortalToolUsageEvent.credits_burned.between(0, MAX_SANE_KLING_CREDITS),
            ITPortalToolUsageEvent.credits_burned,
        ),
        else_=0.0,
    )


def _rate_case_expr(rates_by_credential: dict[int, float], default_rate: float, credential_col):
    """SQL CASE that resolves a per-credit rupee rate from a credential_id column.

    Mirrors reports_router._credit_rate_context's resolution: a configured
    per-credential rate wins, everything else falls back to the org default rate.
    """
    whens = [(credential_col == cid, rate) for cid, rate in rates_by_credential.items()]
    return case(*whens, else_=default_rate) if whens else literal(default_rate)


def _envato_category(item_type: Optional[str]) -> str:
    raw = (item_type or "").lower()
    if "video" in raw:
        return "Video"
    if "voice" in raw or "music" in raw or "sound" in raw:
        return "Audio"
    if "image" in raw or "vector" in raw:
        return "Image"
    return "Other"


# --------------------------------------------------------------------------- #
# Directory
# --------------------------------------------------------------------------- #
def _role_label(user: User) -> str:
    roles = resolve_roles(user)
    for name in ("admin", "hod", "faculty", "spoc", "employee"):
        if name in roles:
            return name
    return "user"


def _load_people(db: Session) -> list[dict]:
    rows = (
        db.query(User)
        .options(joinedload(User.role_assignments))
        .filter(User.is_deleted.is_(False))
        .order_by(User.name.asc())
        .all()
    )
    people = []
    for user in rows:
        people.append({
            "userId": user.id,
            "employeeId": user.employee_id or f"U{user.id}",
            "name": user.name or "Unknown",
            "email": user.email or "",
            "department": _dept(user.department),
            "position": (user.position or "").strip() or "Not set",
            "role": _role_label(user),
            "isActive": bool(user.is_active),
            "accountStatus": "active" if user.is_active else "inactive",
            "createdAt": user.created_at.isoformat() if user.created_at else None,
        })
    return people


def _team_leads(people: list[dict]) -> dict[str, str]:
    leads: dict[str, str] = {}
    for person in people:
        if person["role"] != "hod":
            continue
        leads.setdefault(person["department"], person["name"])
    return leads


def directory(db: Session) -> dict:
    people = _load_people(db)
    leads = _team_leads(people)
    teams = []
    by_dept: dict[str, int] = defaultdict(int)
    for person in people:
        by_dept[person["department"]] += 1
    for name, count in sorted(by_dept.items(), key=lambda x: x[0].lower()):
        teams.append({
            "name": name,
            "userCount": count,
            "lead": leads.get(name) or "Not set",
        })
    return {
        "success": True,
        "users": [
            {"userId": p["userId"], "name": p["name"], "employeeId": p["employeeId"], "department": p["department"]}
            for p in people
        ],
        "teams": teams,
    }


# --------------------------------------------------------------------------- #
# Activity
# --------------------------------------------------------------------------- #
_ACTIVE_ROW = or_(UserActivity.login_time.isnot(None), UserActivity.heartbeat_count > 0)


def _load_activity(db: Session, start: date, end: date) -> dict[int, dict]:
    duration = func.coalesce(UserActivity.active_time, 0)
    fallback = func.coalesce(UserActivity.total_session_duration, 0)
    seconds_expr = case((duration > 0, duration), else_=fallback)
    rows = (
        db.query(
            UserActivity.user_id,
            func.count(UserActivity.id),
            func.coalesce(func.sum(seconds_expr), 0),
            func.min(UserActivity.date),
            func.max(UserActivity.date),
            func.max(UserActivity.last_seen),
        )
        .filter(_ACTIVE_ROW, UserActivity.date >= start, UserActivity.date <= end)
        .group_by(UserActivity.user_id)
        .all()
    )
    out = {}
    for uid, sessions, seconds, first_d, last_d, last_seen in rows:
        out[int(uid)] = {
            "sessions": int(sessions or 0),
            "activeDays": int(sessions or 0),
            "seconds": float(seconds or 0),
            "firstActivity": str(first_d) if first_d else None,
            "lastActivity": str(last_d) if last_d else None,
            "lastSeen": last_seen.isoformat() if last_seen else None,
        }
    return out


def _daily_activity(db: Session, start: date, end: date, user_ids: Optional[set] = None) -> list[dict]:
    duration = func.coalesce(UserActivity.active_time, 0)
    fallback = func.coalesce(UserActivity.total_session_duration, 0)
    seconds_expr = case((duration > 0, duration), else_=fallback)
    q = (
        db.query(
            UserActivity.date,
            func.count(func.distinct(UserActivity.user_id)),
            func.coalesce(func.sum(seconds_expr), 0),
        )
        .filter(_ACTIVE_ROW, UserActivity.date >= start, UserActivity.date <= end)
    )
    if user_ids is not None:
        q = q.filter(UserActivity.user_id.in_(list(user_ids) or [-1]))
    rows = (
        q.group_by(UserActivity.date)
        .order_by(UserActivity.date.asc())
        .all()
    )
    return [
        {"date": str(d), "activeUsers": int(c), "usageHours": _hours(sec)}
        for d, c, sec in rows
    ]


def _canonical_tool_name(name: Optional[str], slug: Optional[str]) -> str:
    slug_l = (slug or "").lower().replace("_", "-")
    name_l = (name or "").lower()
    blob = f"{slug_l} {name_l}"
    # Dashboard tools are named freehand ("CHAT GPT", "chat-gpt", "gpt"), so
    # also match against a separator-stripped form of each field.
    keys = (re.sub(r"[^a-z0-9]", "", slug_l), re.sub(r"[^a-z0-9]", "", name_l))

    def has(*needles: str) -> bool:
        return any(x in blob for x in needles) or any(x in k for k in keys for x in needles)

    if slug_l in KLING_TOOL_SLUGS or has("kling"):
        return "Kling"
    if has("chatgpt", "openai") or any(k in CHATGPT_TOOL_KEYS for k in keys):
        return "ChatGPT"
    if "freepik" in blob:
        return "Freepik"
    if "envato" in blob:
        return "Envato"
    if "heygen" in blob:
        return "HeyGen"
    if "higgsfield" in blob:
        return "Higgsfield"
    if "eleven" in blob:
        return "ElevenLabs"
    if slug_l in {"flow", "google-flow"} or "google flow" in name_l:
        return "Flow"
    return (name or slug or "Other").strip() or "Other"


def _tool_time_label(seconds: float) -> str:
    secs = int(round(float(seconds or 0)))
    if secs <= 0:
        return "0 min"
    hours, rem = divmod(secs, 3600)
    mins, _ = divmod(rem, 60)
    if hours and mins:
        return f"{hours}h {mins}m"
    if hours:
        return f"{hours}h"
    return f"{mins}m"


def _load_dashboard_tool_seconds(db: Session, utc_start: datetime, utc_end: datetime) -> dict[int, dict[str, dict]]:
    """Time spent in tools launched from the dashboard.

    A launch session starts at ``tool_launched`` and ends at that user's next
    launch (any tool) or 2 hours, then is clipped to the report window.
    """
    lookback = utc_start - TOOL_SESSION_CAP
    rows = (
        db.query(
            ITPortalToolAudit.actor_id,
            ITPortalToolAudit.created_at,
            ITPortalTool.name,
            ITPortalTool.slug,
        )
        .join(ITPortalTool, ITPortalTool.id == ITPortalToolAudit.tool_id)
        .filter(
            ITPortalToolAudit.action == "tool_launched",
            ITPortalToolAudit.created_at >= lookback,
            ITPortalToolAudit.created_at < utc_end,
            ITPortalToolAudit.actor_id.isnot(None),
        )
        .order_by(ITPortalToolAudit.actor_id.asc(), ITPortalToolAudit.created_at.asc())
        .all()
    )
    by_user: dict[int, list[tuple]] = defaultdict(list)
    for uid, started, name, slug in rows:
        if not started:
            continue
        by_user[int(uid)].append((started, _canonical_tool_name(name, slug)))

    out: dict[int, dict[str, dict]] = defaultdict(lambda: defaultdict(lambda: {"seconds": 0.0, "launches": 0}))
    for uid, launches in by_user.items():
        for i, (started, tool) in enumerate(launches):
            next_start = launches[i + 1][0] if i + 1 < len(launches) else None
            raw_end = started + TOOL_SESSION_CAP
            if next_start and next_start < raw_end:
                raw_end = next_start
            session_start = max(started, utc_start)
            session_end = min(raw_end, utc_end)
            seconds = (session_end - session_start).total_seconds()
            if seconds <= 0:
                continue
            slot = out[uid][tool]
            slot["seconds"] += seconds
            if started >= utc_start:
                slot["launches"] += 1
    return out


def _load_tool_login_attempts(db: Session, period: dict, user_ids: Optional[set] = None) -> list[dict]:
    """Every dashboard tool launch ("login try") in the window: who tried to
    log in to which tool, using which assigned account, and when.

    Launch = ``ITPortalToolAudit`` action ``tool_launched``, the same event
    that seeds per-tool time-on-tool for the person report. The account shown
    is whichever credential the launch actually resolved to (personal or a
    shared company login) -- no ownership chain is re-walked here.
    """
    utc_s, utc_e = period["utc_start"], period["utc_end"]
    q = (
        db.query(
            ITPortalToolAudit.actor_id,
            ITPortalToolAudit.created_at,
            ITPortalToolAudit.credential_id,
            ITPortalTool.name,
            ITPortalTool.slug,
        )
        .join(ITPortalTool, ITPortalTool.id == ITPortalToolAudit.tool_id)
        .filter(
            ITPortalToolAudit.action == "tool_launched",
            ITPortalToolAudit.created_at >= utc_s,
            ITPortalToolAudit.created_at < utc_e,
            ITPortalToolAudit.actor_id.isnot(None),
        )
    )
    if user_ids is not None:
        q = q.filter(ITPortalToolAudit.actor_id.in_(user_ids))
    rows = q.order_by(ITPortalToolAudit.created_at.desc()).limit(TIMELINE_CAP).all()

    cred_ids = {cred_id for _uid, _created, cred_id, _name, _slug in rows if cred_id is not None}
    accounts: dict[int, str] = {}
    if cred_ids:
        creds = (
            db.query(ITPortalToolCredential.id, ITPortalToolCredential.login_identifier_encrypted)
            .filter(ITPortalToolCredential.id.in_(cred_ids))
            .all()
        )
        for cid, login_enc in creds:
            accounts[cid] = (decrypt_secret(login_enc) or "").strip() or "Not set"

    out = []
    for uid, created_at, cred_id, tool_name, slug in rows:
        out.append({
            "userId": int(uid),
            "dateTimeSort": created_at.isoformat() if created_at else "",
            "dateTime": _ist_datetime_label(created_at),
            "tool": _canonical_tool_name(tool_name, slug),
            "assignedAccount": accounts.get(cred_id, "Not set") if cred_id is not None else "Not set",
        })
    return out


def _assemble_tool_logins(raw_rows: list[dict], scoped_users: list[dict]) -> list[dict]:
    names = {u["userId"]: u["name"] for u in scoped_users}
    depts = {u["userId"]: u["department"] for u in scoped_users}
    rows = []
    for r in raw_rows:
        uid = r["userId"]
        if uid not in names:
            continue
        rows.append({
            "dateTime": r["dateTime"],
            "userName": names[uid],
            "department": depts.get(uid, "Unassigned"),
            "tool": r["tool"],
            "assignedAccount": r["assignedAccount"],
        })
    rows.sort(key=lambda r: r["dateTime"], reverse=True)
    return rows[:TIMELINE_CAP]


# --------------------------------------------------------------------------- #
# Generation facts (no prompt text)
# --------------------------------------------------------------------------- #
def _kling_tool_ids(db: Session) -> list[int]:
    rows = (
        db.query(ITPortalTool.id)
        .filter(func.lower(func.coalesce(ITPortalTool.slug, "")).in_(KLING_TOOL_SLUGS))
        .all()
    )
    return [r[0] for r in rows]


def _push_fact(bucket: dict, uid, tool, category, day, gens, success, failed, credits, last_day, cost=0.0):
    if not uid:
        return
    uid = int(uid)
    key = (uid, tool)
    row = bucket[key]
    row["tool"] = tool
    row["category"] = category
    row["generations"] += int(gens or 0)
    row["success"] += int(success or 0)
    row["failed"] += int(failed or 0)
    row["credits"] += float(credits or 0)
    row["costRupees"] += float(cost or 0)
    if last_day and (row["lastUsed"] is None or str(last_day) > row["lastUsed"]):
        row["lastUsed"] = str(last_day)
    if day:
        row["days"][str(day)] = row["days"].get(str(day), 0) + int(gens or 0)


def _empty_tool():
    return {
        "tool": "",
        "category": "Other",
        "generations": 0,
        "success": 0,
        "failed": 0,
        "credits": 0.0,
        "costRupees": 0.0,
        "lastUsed": None,
        "days": {},
    }


def _load_generation_facts(db: Session, period: dict, previous: bool = False) -> dict:
    """Return {(user_id, tool): stats} for one window."""
    if previous:
        start, end = period["prev_start"], period["prev_end"]
        utc_s, utc_e = period["prev_utc_start"], period["prev_utc_end"]
    else:
        start, end = period["start"], period["end"]
        utc_s, utc_e = period["utc_start"], period["utc_end"]

    bucket: dict[tuple, dict] = defaultdict(_empty_tool)
    rates_by_credential, default_rate, _rate_currency = _load_credit_rates(db)

    # ChatGPT — conversation prompt_count, IST via UTC shift
    prompts = func.coalesce(ConversationRecord.prompt_count, 0)
    success_case = case((_success_case(ConversationRecord.capture_status) == 1, prompts), else_=0)
    fail_case = case((_fail_case(ConversationRecord.capture_status) == 1, prompts), else_=0)
    day_expr = cast(ConversationRecord.created_at + LOCAL_TZ_OFFSET, Date)
    cg_rows = (
        db.query(
            ConversationRecord.owner_user_id,
            day_expr,
            func.coalesce(func.sum(ConversationRecord.prompt_count), 0),
            func.coalesce(func.sum(success_case), 0),
            func.coalesce(func.sum(fail_case), 0),
            func.max(ConversationRecord.created_at),
        )
        .filter(
            ConversationRecord.archived_at.is_(None),
            ConversationRecord.provider == "chatgpt",
            ConversationRecord.created_at >= utc_s,
            ConversationRecord.created_at < utc_e,
            ConversationRecord.owner_user_id.isnot(None),
        )
        .group_by(ConversationRecord.owner_user_id, day_expr)
        .all()
    )
    for uid, day, gens, succ, fail, last in cg_rows:
        last_day = (last + LOCAL_TZ_OFFSET).date() if last else day
        _push_fact(bucket, uid, "ChatGPT", "Chat / Text", day, gens, succ, fail, 0, last_day)

    # Kling usage events
    tool_ids = _kling_tool_ids(db)
    if tool_ids:
        k_succ = _success_case(ITPortalToolUsageEvent.status)
        k_fail = _fail_case(ITPortalToolUsageEvent.status)
        k_credits_expr = _sane_kling_credits()
        k_rate = _rate_case_expr(rates_by_credential, default_rate, ITPortalToolUsageEvent.credential_id)
        k_rows = (
            db.query(
                ITPortalToolUsageEvent.user_id,
                ITPortalToolUsageEvent.event_date,
                func.count(ITPortalToolUsageEvent.id),
                func.coalesce(func.sum(k_succ), 0),
                func.coalesce(func.sum(k_fail), 0),
                func.coalesce(func.sum(k_credits_expr), 0.0),
                func.coalesce(func.sum(k_credits_expr * k_rate), 0.0),
            )
            .filter(
                ITPortalToolUsageEvent.tool_id.in_(tool_ids),
                ITPortalToolUsageEvent.event_date >= start,
                ITPortalToolUsageEvent.event_date <= end,
            )
            .group_by(ITPortalToolUsageEvent.user_id, ITPortalToolUsageEvent.event_date)
            .all()
        )
        for uid, day, gens, succ, fail, credits, cost in k_rows:
            _push_fact(bucket, uid, "Kling", "Video", day, gens, succ, fail, credits, day, cost)

    def _provider_rows(model, tool, category, credit_col, status_col, extra_category=None):
        day_col = cast(func.coalesce(model.provider_created_at, model.created_at) + LOCAL_TZ_OFFSET, Date)
        last_col = func.max(func.coalesce(model.provider_created_at, model.created_at))
        gens = func.count(model.id)
        if status_col is not None:
            succ = func.coalesce(func.sum(_success_case(status_col)), 0)
            fail = func.coalesce(func.sum(_fail_case(status_col)), 0)
        else:
            succ = gens
            fail = literal(0)
        credit = func.coalesce(func.sum(credit_col), 0.0) if credit_col is not None else literal(0.0)
        if credit_col is not None:
            rate_expr = _rate_case_expr(rates_by_credential, default_rate, model.credential_id)
            cost = func.coalesce(func.sum(credit_col * rate_expr), 0.0)
        else:
            cost = literal(0.0)
        group = [model.owner_user_id, day_col]
        entities = [model.owner_user_id, day_col, gens, succ, fail, credit, cost, last_col]
        if extra_category is not None:
            entities.insert(2, extra_category)
            group.append(extra_category)
        q = (
            db.query(*entities)
            .filter(
                model.owner_user_id.isnot(None),
                func.coalesce(model.provider_created_at, model.created_at) >= utc_s,
                func.coalesce(model.provider_created_at, model.created_at) < utc_e,
            )
            .group_by(*group)
        )
        for row in q.all():
            if extra_category is not None:
                uid, day, cat, g, s, f, cred, cost_val, last = row
                cat_label = str(cat) if cat else category
            else:
                uid, day, g, s, f, cred, cost_val, last = row
                cat_label = category
            last_day = (last + LOCAL_TZ_OFFSET).date() if last else day
            _push_fact(bucket, uid, tool, cat_label, day, g, s, f, cred, last_day, cost_val)

    fp_cat = case((FreepikGeneration.tool == FREEPIK_VIDEO_TOOL, "Video"), else_="Image")
    _provider_rows(FreepikGeneration, "Freepik", "Image", FreepikGeneration.credits_charged, FreepikGeneration.status, fp_cat)

    env_cat = case(
        (func.lower(func.coalesce(EnvatoGeneration.item_type, "")).like("%video%"), "Video"),
        (func.lower(func.coalesce(EnvatoGeneration.item_type, "")).like("%voice%"), "Audio"),
        (func.lower(func.coalesce(EnvatoGeneration.item_type, "")).like("%music%"), "Audio"),
        (func.lower(func.coalesce(EnvatoGeneration.item_type, "")).like("%sound%"), "Audio"),
        (func.lower(func.coalesce(EnvatoGeneration.item_type, "")).like("%image%"), "Image"),
        else_="Other",
    )
    _provider_rows(EnvatoGeneration, "Envato", "Image", EnvatoGeneration.credits_badge, None, env_cat)
    _provider_rows(HeygenGeneration, "HeyGen", "Video", HeygenGeneration.credits_used, HeygenGeneration.status)
    _provider_rows(HiggsfieldGeneration, "Higgsfield", "Mixed", HiggsfieldGeneration.credits_used, HiggsfieldGeneration.status)
    _provider_rows(ElevenlabsGeneration, "ElevenLabs", "Audio", ElevenlabsGeneration.credits_used, ElevenlabsGeneration.status)
    _provider_rows(FlowGeneration, "Flow", "Image", None, FlowGeneration.status)

    return bucket


def _purpose_label(category: Optional[str]) -> str:
    """Collapse a generation category down to what it was for: Audio, Video
    or Image, plus Text/Mixed/Other for the tools that don't produce media."""
    cat = (category or "").strip().lower()
    if cat == "video":
        return "Video"
    if cat == "audio":
        return "Audio"
    if cat == "image":
        return "Image"
    if "chat" in cat or "text" in cat:
        return "Text"
    if cat == "mixed":
        return "Mixed"
    return "Other"


def _load_client_tool_usage(db: Session, period: dict, user_ids: Optional[set] = None) -> list[dict]:
    """Return [{client, userId, tool, category, credentialId, generations, credits}],
    org-wide (or scoped to user_ids).

    Client falls back to the linked task, same rule as _client_label. ChatGPT
    carries no client/task columns so it always reports as "Not linked".
    credentialId is the tool account the generation was captured under -- it
    feeds ToolCreditRate-based cost conversion downstream. ConversationRecord
    carries no credential linkage either, so ChatGPT rows always report None
    and fall back to the default rate.

    category mirrors _load_generation_facts' tool -> category mapping so
    "Purpose" (Audio/Video/Image) can be read straight off it; Freepik and
    Envato vary by item type, so those are grouped by category too, which can
    split a person's usage of one tool/account into more than one row.
    """
    utc_s, utc_e = period["utc_start"], period["utc_end"]
    start, end = period["start"], period["end"]
    rows: list[dict] = []

    def _client_expr(client_col, task_col):
        return func.coalesce(
            func.nullif(func.trim(client_col), ""),
            func.nullif(func.trim(task_col), ""),
        )

    cg_q = (
        db.query(
            ConversationRecord.owner_user_id,
            func.coalesce(func.sum(ConversationRecord.prompt_count), 0),
        )
        .filter(
            ConversationRecord.archived_at.is_(None),
            ConversationRecord.provider == "chatgpt",
            ConversationRecord.created_at >= utc_s,
            ConversationRecord.created_at < utc_e,
            ConversationRecord.owner_user_id.isnot(None),
        )
    )
    if user_ids is not None:
        cg_q = cg_q.filter(ConversationRecord.owner_user_id.in_(user_ids))
    for uid, gens in cg_q.group_by(ConversationRecord.owner_user_id).all():
        if gens:
            rows.append({"client": NO_CLIENT, "userId": uid, "tool": "ChatGPT", "category": "Chat / Text", "credentialId": None, "generations": int(gens), "credits": 0.0})

    tool_ids = _kling_tool_ids(db)
    if tool_ids:
        client_expr = _client_expr(ITPortalToolUsageEvent.linked_client_name, ITPortalToolUsageEvent.linked_task_name)
        k_q = (
            db.query(
                ITPortalToolUsageEvent.user_id,
                ITPortalToolUsageEvent.credential_id,
                client_expr,
                func.count(ITPortalToolUsageEvent.id),
                func.coalesce(func.sum(_sane_kling_credits()), 0.0),
            )
            .filter(
                ITPortalToolUsageEvent.tool_id.in_(tool_ids),
                ITPortalToolUsageEvent.event_date >= start,
                ITPortalToolUsageEvent.event_date <= end,
            )
        )
        if user_ids is not None:
            k_q = k_q.filter(ITPortalToolUsageEvent.user_id.in_(user_ids))
        for uid, cred_id, client, gens, credits in k_q.group_by(
            ITPortalToolUsageEvent.user_id, ITPortalToolUsageEvent.credential_id, client_expr
        ).all():
            rows.append({"client": client or NO_CLIENT, "userId": uid, "tool": "Kling", "category": "Video", "credentialId": cred_id, "generations": int(gens or 0), "credits": round(float(credits or 0), 2)})

    def _provider_rows(model, tool, credit_col, category=None, extra_category=None):
        client_expr = _client_expr(model.linked_client_name, model.linked_task_name)
        credit = func.coalesce(func.sum(credit_col), 0.0) if credit_col is not None else literal(0.0)
        entities = [model.owner_user_id, model.credential_id, client_expr, func.count(model.id), credit]
        group = [model.owner_user_id, model.credential_id, client_expr]
        if extra_category is not None:
            entities.insert(2, extra_category)
            group.append(extra_category)
        q = (
            db.query(*entities)
            .filter(
                model.owner_user_id.isnot(None),
                func.coalesce(model.provider_created_at, model.created_at) >= utc_s,
                func.coalesce(model.provider_created_at, model.created_at) < utc_e,
            )
        )
        if user_ids is not None:
            q = q.filter(model.owner_user_id.in_(user_ids))
        for row in q.group_by(*group).all():
            if extra_category is not None:
                uid, cred_id, cat, client, gens, credits = row
                cat_label = str(cat) if cat else category
            else:
                uid, cred_id, client, gens, credits = row
                cat_label = category
            rows.append({"client": client or NO_CLIENT, "userId": uid, "tool": tool, "category": cat_label, "credentialId": cred_id, "generations": int(gens or 0), "credits": round(float(credits or 0), 2)})

    fp_cat = case((FreepikGeneration.tool == FREEPIK_VIDEO_TOOL, "Video"), else_="Image")
    _provider_rows(FreepikGeneration, "Freepik", FreepikGeneration.credits_charged, "Image", fp_cat)

    env_cat = case(
        (func.lower(func.coalesce(EnvatoGeneration.item_type, "")).like("%video%"), "Video"),
        (func.lower(func.coalesce(EnvatoGeneration.item_type, "")).like("%voice%"), "Audio"),
        (func.lower(func.coalesce(EnvatoGeneration.item_type, "")).like("%music%"), "Audio"),
        (func.lower(func.coalesce(EnvatoGeneration.item_type, "")).like("%sound%"), "Audio"),
        (func.lower(func.coalesce(EnvatoGeneration.item_type, "")).like("%image%"), "Image"),
        else_="Other",
    )
    _provider_rows(EnvatoGeneration, "Envato", EnvatoGeneration.credits_badge, "Image", env_cat)
    _provider_rows(HeygenGeneration, "HeyGen", HeygenGeneration.credits_used, "Video")
    _provider_rows(HiggsfieldGeneration, "Higgsfield", HiggsfieldGeneration.credits_used, "Mixed")
    _provider_rows(ElevenlabsGeneration, "ElevenLabs", ElevenlabsGeneration.credits_used, "Audio")
    _provider_rows(FlowGeneration, "Flow", None, "Image")

    return rows


def _clients_by_user(
    usage_rows: list[dict], rates_by_credential: dict[int, float], default_rate: float,
) -> dict[int, list[dict]]:
    """{userId: [{"client", "generations", "credits", "costRupees"}, ...]}, heaviest
    client first. Built from the same client-attribution rows _load_client_tool_usage
    uses for the Consolidated report's Client Usage tab, so "clients worked on" here
    can never disagree with that report. NO_CLIENT ("Not linked") is dropped
    entirely -- it isn't a real client, so it never appears in these Clients
    columns/tables (person, team, or org level)."""
    by_user: dict[int, dict[str, dict]] = defaultdict(lambda: defaultdict(lambda: {"generations": 0, "credits": 0.0, "costRupees": 0.0}))
    for r in usage_rows:
        if r["client"] == NO_CLIENT:
            continue
        cred_id = r.get("credentialId")
        rate = rates_by_credential.get(cred_id, default_rate) if cred_id is not None else default_rate
        slot = by_user[r["userId"]][r["client"]]
        slot["generations"] += r["generations"]
        slot["credits"] += r["credits"]
        slot["costRupees"] += (r.get("credits") or 0) * rate
    out: dict[int, list[dict]] = {}
    for uid, counts in by_user.items():
        ordered = sorted(counts.items(), key=lambda kv: (-kv[1]["generations"], kv[0]))
        out[uid] = [
            {"client": name, "generations": vals["generations"], "credits": round(vals["credits"], 2), "costRupees": round(vals["costRupees"], 2)}
            for name, vals in ordered
        ]
    return out


def _org_clients(users_scope: list[dict]) -> list[dict]:
    """Org/team-scoped client rollup: [{"client", "generations", "credits",
    "costRupees", "users"}, ...] across every user in ``users_scope`` (each of
    which already carries its own "clientRows" from _clients_by_user, which
    never contains NO_CLIENT), heaviest credits first."""
    totals: dict[str, dict] = defaultdict(lambda: {"generations": 0, "credits": 0.0, "costRupees": 0.0, "users": set()})
    for u in users_scope:
        for c in u.get("clientRows") or []:
            slot = totals[c["client"]]
            slot["generations"] += c["generations"]
            slot["credits"] += c.get("credits") or 0
            slot["costRupees"] += c.get("costRupees") or 0
            slot["users"].add(u["userId"])
    rows = [
        {
            "client": name,
            "generations": v["generations"],
            "credits": round(v["credits"], 2),
            "costRupees": round(v["costRupees"], 2),
            "users": len(v["users"]),
        }
        for name, v in totals.items()
    ]
    rows.sort(key=lambda r: (-r["credits"], r["client"]))
    return rows


def _load_credit_rates(db: Session) -> tuple[dict[int, float], float, str]:
    """Return ({credentialId: rupees per credit}, defaultRatePerCredit, currency).

    Mirrors reports_router._credit_rate_context but returns plain Python
    structures for use in report code that aggregates credits in Python
    rather than SQL. A credit-less rate row (rate_per_credit is null) is
    skipped; the newest row per key wins.

    An account with Credit System disabled (Admin Queue -> Tool Renew) is
    forced to 0 here -- explicitly present in the dict, not merely absent --
    so every ``rates_by_credential.get(cred_id, default_rate)`` call site
    below finds the 0 instead of silently falling through to the global
    default rate. See utils/tool_renewal_service.py.
    """
    today = datetime.utcnow().date()
    rows = (
        db.query(ToolCreditRate)
        .filter(
            ToolCreditRate.effective_from <= today,
            or_(ToolCreditRate.effective_to.is_(None), ToolCreditRate.effective_to >= today),
        )
        .order_by(ToolCreditRate.effective_from.desc(), ToolCreditRate.id.desc())
        .all()
    )
    default_rate = 0.0
    currency = "INR"
    rates_by_credential: dict[int, float] = {}
    global_seen = False
    for r in rows:
        if r.rate_per_credit is None:
            continue
        rate = float(r.rate_per_credit)
        if r.credential_id is not None:
            rates_by_credential.setdefault(r.credential_id, rate)
        elif r.provider is None and r.tool_id is None and not global_seen:
            default_rate = rate
            currency = r.currency or "INR"
            global_seen = True

    disabled_ids = (
        db.query(ITPortalToolCredential.id)
        .filter(ITPortalToolCredential.credit_enabled.is_(False))
        .all()
    )
    for (cid,) in disabled_ids:
        rates_by_credential[cid] = 0.0

    return rates_by_credential, default_rate, currency


def _resolve_account_labels(db: Session, credential_ids: set[int]) -> dict[int, str]:
    """{credentialId: decrypted login identifier}, for tagging usage rows with
    which account they were captured under."""
    if not credential_ids:
        return {}
    labels: dict[int, str] = {}
    rows = (
        db.query(ITPortalToolCredential.id, ITPortalToolCredential.login_identifier_encrypted)
        .filter(ITPortalToolCredential.id.in_(credential_ids))
        .all()
    )
    for cid, login_enc in rows:
        labels[cid] = (decrypt_secret(login_enc) or "").strip() or "Not set"
    return labels


_RENEWAL_STATUS_LABELS = {
    STATUS_NOT_APPLICABLE: "Not Applicable",
    "ok": "OK",
    "renewal_required": "Renewal Required",
}


def _format_credit_enabled(value: bool) -> str:
    return "Yes" if value else "No"


def _format_renewal_status(status: str) -> str:
    return _RENEWAL_STATUS_LABELS.get(status, status)


def _load_tool_accounts(db: Session) -> list[dict]:
    """Tool -> every distinct login account currently active for it, tagged
    Current/Old by whether anyone is actually assigned to it right now.

    A tool can carry more than one shared account (e.g. two ChatGPT logins),
    so this lists every distinct one rather than picking a single "the"
    account. A scope='user' row that merely links to a shared company
    credential is skipped here -- it is an assignment, not a distinct
    account, and is already covered by the company row it points at.

    Status mirrors the IT Portal's own "N users assigned" count: a
    company-scope account is Current only while at least one active
    scope='user' row links to it; a standalone personal account is Current
    by definition (it belongs to the one person holding it). Only the login
    identifier is decrypted -- passwords, API keys and TOTP secrets are
    never touched here.
    """
    tools = (
        db.query(ITPortalTool.id, ITPortalTool.name)
        .filter(ITPortalTool.is_active.is_(True))
        .order_by(ITPortalTool.name)
        .all()
    )
    creds = (
        db.query(ITPortalToolCredential)
        .filter(ITPortalToolCredential.is_active.is_(True))
        .all()
    )
    assigned_counts: dict[int, int] = defaultdict(int)
    for c in creds:
        if c.scope == "user" and c.linked_credential_id:
            assigned_counts[c.linked_credential_id] += 1

    accounts_by_tool: dict[int, list[tuple[str, str, ITPortalToolCredential]]] = defaultdict(list)
    for c in creds:
        if c.scope == "user" and c.linked_credential_id:
            continue
        account = (decrypt_secret(c.login_identifier_encrypted) or "").strip()
        if not account:
            continue
        is_current = assigned_counts.get(c.id, 0) > 0 if c.scope == "company" else True
        accounts_by_tool[c.tool_id].append((account, "Current" if is_current else "Old", c))

    out = []
    for tool_id, name in tools:
        seen: set[str] = set()
        distinct = []
        for account, status, credential in accounts_by_tool.get(tool_id, []):
            key = account.lower()
            if key in seen:
                continue
            seen.add(key)
            distinct.append((account, status, credential))
        if not distinct:
            out.append({
                "tool": name, "account": "Not set", "status": "Old", "renewalDate": "Not set",
                "purchaseDate": "Not set", "creditEnabled": _format_credit_enabled(False),
                "renewalType": DEFAULT_RENEWAL_TYPE, "remainingCredits": "Not applicable",
                "renewalStatus": _format_renewal_status(STATUS_NOT_APPLICABLE), "cost": "Not set",
            })
        else:
            for account, status, credential in sorted(distinct, key=lambda x: (x[1] != "Current", x[0].lower())):
                remaining_credits = resolve_remaining_credits(db, credential)
                renewal_status = calculate_renewal_status(credential, remaining_credits)["status"]
                out.append({
                    "tool": name,
                    "account": account,
                    "status": status,
                    "renewalDate": credential.renewal_date.isoformat() if credential.renewal_date else "Not set",
                    "purchaseDate": credential.purchase_date.isoformat() if credential.purchase_date else "Not set",
                    "creditEnabled": _format_credit_enabled(credential.credit_enabled),
                    "renewalType": normalize_renewal_type(credential.renewal_type),
                    "remainingCredits": round(remaining_credits, 2) if remaining_credits is not None else "Not applicable",
                    "renewalStatus": _format_renewal_status(renewal_status),
                    "cost": float(credential.tool_cost) if credential.tool_cost is not None else "Not set",
                })
    return out


def _load_tool_assignments(db: Session, people: list[dict]) -> list[dict]:
    """Every employee currently assigned a tool credential, and the account it
    resolves to -- whether or not they have generated anything with it yet.

    Assignment = an active scope='user' credential row. If it links to a
    shared company credential, the account shown is that shared login;
    otherwise it is the employee's own login identifier.
    """
    by_uid = {p["userId"]: p for p in people}
    tools = {
        t.id: t.name
        for t in db.query(ITPortalTool.id, ITPortalTool.name).filter(ITPortalTool.is_active.is_(True)).all()
    }
    creds = db.query(ITPortalToolCredential).filter(ITPortalToolCredential.is_active.is_(True)).all()
    by_id = {c.id: c for c in creds}

    rows = []
    for c in creds:
        if c.scope != "user" or not c.user_id:
            continue
        tool_name = tools.get(c.tool_id)
        person = by_uid.get(c.user_id)
        if not tool_name or not person:
            continue
        effective = by_id.get(c.linked_credential_id) if c.linked_credential_id else c
        account = ((decrypt_secret(effective.login_identifier_encrypted) if effective else None) or "").strip()
        renewal = effective.renewal_date.isoformat() if effective and effective.renewal_date else "Not set"
        purchase_date = effective.purchase_date.isoformat() if effective and effective.purchase_date else "Not set"
        # created_at on this scope='user' row is when the link to the employee
        # was made, not when the underlying (possibly shared) credential was
        # first set up -- that's the actual "assigned" moment.
        assigned = c.created_at.date().isoformat() if c.created_at else "Not set"
        rows.append({
            "tool": tool_name,
            "name": person["name"],
            "department": person["department"],
            "account": account or "Not set",
            "renewalDate": renewal,
            "purchaseDate": purchase_date,
            "creditEnabled": _format_credit_enabled(bool(effective.credit_enabled) if effective else False),
            "renewalType": normalize_renewal_type(effective.renewal_type) if effective else DEFAULT_RENEWAL_TYPE,
            "assignedDate": assigned,
        })
    rows.sort(key=lambda r: (r["tool"] or "", r["name"] or ""))
    return rows


def _client_label(name: Optional[str], task: Optional[str] = None) -> str:
    """Client for a generation row, falling back to the task it was filed under.

    The client picker was optional for most of the captured history, so a lot of
    real work carries only a task. Reporting all of it as "Not linked" buried
    it in one meaningless bucket; the task is the next best answer to "what was
    this for", so it stands in when no client was picked.
    """
    value = (name or "").strip()
    if value:
        return value
    fallback = (task or "").strip()
    return fallback if fallback else NO_CLIENT


def _ist_day(value) -> str:
    if value is None:
        return ""
    if hasattr(value, "hour"):
        return (value + LOCAL_TZ_OFFSET).date().isoformat()
    return str(value)[:10]


def _ist_datetime_label(value) -> str:
    if value is None:
        return ""
    return (value + LOCAL_TZ_OFFSET).strftime("%Y-%m-%d %H:%M")


def _gen_row(*, day, client, tool, category, credits, status, task, generations=1, cost=0.0):
    return {
        "date": _ist_day(day),
        "client": _client_label(client, task),
        "tool": tool,
        "category": category or "Uncategorised",
        "generations": int(generations or 0),
        "credits": round(float(credits or 0), 2),
        "costRupees": round(float(cost or 0), 2),
        "status": (status or "captured").replace("_", " ").title(),
        "task": (task or "").strip() or "None",
    }


def _load_person_generation_log(db: Session, period: dict, user_id: int) -> dict:
    """One row per captured generation for a single person. Prompt text is never selected."""
    utc_s, utc_e = period["utc_start"], period["utc_end"]
    start, end = period["start"], period["end"]
    rows: list[dict] = []
    rates_by_credential, default_rate, _rate_currency = _load_credit_rates(db)

    cg = (
        db.query(
            ConversationRecord.created_at,
            ConversationRecord.prompt_count,
            ConversationRecord.capture_status,
        )
        .filter(
            ConversationRecord.archived_at.is_(None),
            ConversationRecord.provider == "chatgpt",
            ConversationRecord.owner_user_id == user_id,
            ConversationRecord.created_at >= utc_s,
            ConversationRecord.created_at < utc_e,
        )
        .all()
    )
    for created_at, prompt_count, status in cg:
        rows.append(_gen_row(
            day=created_at, client=None, tool="ChatGPT", category="Chat / Text",
            credits=0, status=status, task=None, generations=int(prompt_count or 0),
        ))

    tool_ids = _kling_tool_ids(db)
    if tool_ids:
        kling = (
            db.query(
                ITPortalToolUsageEvent.event_date,
                ITPortalToolUsageEvent.linked_client_name,
                ITPortalToolUsageEvent.linked_task_name,
                ITPortalToolUsageEvent.credits_burned,
                ITPortalToolUsageEvent.status,
                ITPortalToolUsageEvent.credential_id,
            )
            .filter(
                ITPortalToolUsageEvent.user_id == user_id,
                ITPortalToolUsageEvent.tool_id.in_(tool_ids),
                ITPortalToolUsageEvent.event_date >= start,
                ITPortalToolUsageEvent.event_date <= end,
            )
            .all()
        )
        for event_date, client, task, credits, status, cred_id in kling:
            burned = float(credits or 0)
            if not (0 <= burned <= MAX_SANE_KLING_CREDITS):
                burned = 0.0
            rate = rates_by_credential.get(cred_id, default_rate) if cred_id is not None else default_rate
            rows.append(_gen_row(
                day=event_date, client=client, tool="Kling", category="Video",
                credits=burned, status=status, task=task, cost=burned * rate,
            ))

    def _provider(model, tool, category, credit_col, status_col, category_fn=None):
        cols = [
            func.coalesce(model.provider_created_at, model.created_at),
            model.linked_client_name,
            model.linked_task_name,
        ]
        cols.append(credit_col if credit_col is not None else literal(0.0))
        cols.append(status_col if status_col is not None else literal("captured"))
        cols.append(model.credential_id)
        if category_fn == "freepik":
            cols.append(model.tool)
        elif category_fn == "envato":
            cols.append(model.item_type)
        q = (
            db.query(*cols)
            .filter(
                model.owner_user_id == user_id,
                func.coalesce(model.provider_created_at, model.created_at) >= utc_s,
                func.coalesce(model.provider_created_at, model.created_at) < utc_e,
            )
        )
        for rec in q.all():
            when, client, task, credits, status, cred_id = rec[0], rec[1], rec[2], rec[3], rec[4], rec[5]
            cat = category
            if category_fn == "freepik":
                cat = "Video" if rec[6] == FREEPIK_VIDEO_TOOL else "Image"
            elif category_fn == "envato":
                cat = _envato_category(rec[6])
            rate = rates_by_credential.get(cred_id, default_rate) if cred_id is not None else default_rate
            rows.append(_gen_row(
                day=when, client=client, tool=tool, category=cat,
                credits=credits, status=status, task=task, cost=float(credits or 0) * rate,
            ))

    _provider(FreepikGeneration, "Freepik", "Image", FreepikGeneration.credits_charged, FreepikGeneration.status, "freepik")
    _provider(EnvatoGeneration, "Envato", "Image", EnvatoGeneration.credits_badge, None, "envato")
    _provider(HeygenGeneration, "HeyGen", "Video", HeygenGeneration.credits_used, HeygenGeneration.status)
    _provider(HiggsfieldGeneration, "Higgsfield", "Mixed", HiggsfieldGeneration.credits_used, HiggsfieldGeneration.status)
    _provider(ElevenlabsGeneration, "ElevenLabs", "Audio", ElevenlabsGeneration.credits_used, ElevenlabsGeneration.status)
    _provider(FlowGeneration, "Flow", "Image", None, FlowGeneration.status)

    rows.sort(key=lambda r: (r["date"], r["tool"], r["client"]), reverse=True)
    truncated = len(rows) > PERSON_GEN_CAP
    log = rows[:PERSON_GEN_CAP]

    by_client: dict[str, dict] = defaultdict(lambda: {"generations": 0, "credits": 0.0, "costRupees": 0.0, "tools": set()})
    by_pair: dict[tuple, dict] = defaultdict(lambda: {"generations": 0, "credits": 0.0, "costRupees": 0.0})
    for row in rows:
        slot = by_client[row["client"]]
        slot["generations"] += row["generations"]
        slot["credits"] += row["credits"]
        slot["costRupees"] += row["costRupees"]
        slot["tools"].add(row["tool"])
        pair = by_pair[(row["client"], row["tool"])]
        pair["generations"] += row["generations"]
        pair["credits"] += row["credits"]
        pair["costRupees"] += row["costRupees"]

    total_credits = sum(v["credits"] for v in by_client.values()) or 0.0
    clients = []
    for name, slot in by_client.items():
        clients.append({
            "client": name,
            "generations": slot["generations"],
            "credits": round(slot["credits"], 2),
            "costRupees": round(slot["costRupees"], 2),
            "share": round((slot["credits"] / total_credits) * 100.0, 1) if total_credits else 0.0,
            "tools": ", ".join(sorted(slot["tools"])),
        })
    clients.sort(key=lambda c: (c["client"] == NO_CLIENT, -c["credits"], c["client"]))

    client_tools = [
        {
            "client": client,
            "tool": tool,
            "generations": slot["generations"],
            "credits": round(slot["credits"], 2),
            "costRupees": round(slot["costRupees"], 2),
        }
        for (client, tool), slot in by_pair.items()
    ]
    client_tools.sort(key=lambda r: (r["client"] == NO_CLIENT, r["client"], -r["credits"]))

    linked = [c for c in clients if c["client"] != NO_CLIENT]
    unlinked = next((c for c in clients if c["client"] == NO_CLIENT), None)
    primary = linked[0] if linked else None
    return {
        "rows": log,
        "truncated": truncated,
        "limit": PERSON_GEN_CAP,
        "totalRows": len(rows),
        "clients": clients,
        "clientTools": client_tools,
        "primaryClient": primary["client"] if primary else None,
        "primaryClientCredits": primary["credits"] if primary else 0,
        "primaryClientCostRupees": primary["costRupees"] if primary else 0,
        "unlinkedGenerations": unlinked["generations"] if unlinked else 0,
        "unlinkedCredits": unlinked["credits"] if unlinked else 0,
        "unlinkedCostRupees": unlinked["costRupees"] if unlinked else 0,
    }


# --------------------------------------------------------------------------- #
# Assembly
# --------------------------------------------------------------------------- #
def _success_rate(success: int, total: int) -> float:
    if total <= 0:
        return 0.0
    return round((success / total) * 100.0, 1)


def _efficiency(credits: float, success: int) -> Optional[float]:
    if success <= 0:
        return None
    return round(credits / success, 2)


def _engagement(active_days: int, period_days: int, tools_used: int, org_tools: int, success_rate: float, last_activity: Optional[str], end: date) -> int:
    consistency = (active_days / period_days) * 40 if period_days else 0
    diversity = min((tools_used / org_tools) if org_tools else 0, 1) * 25
    reliability = (success_rate / 100.0) * 25
    recency = 0
    if last_activity:
        try:
            last = datetime.strptime(last_activity[:10], "%Y-%m-%d").date()
            gap = (end - last).days
            recency = 10 if gap <= 2 else 5 if gap <= 7 else 2 if gap <= 14 else 0
        except ValueError:
            recency = 0
    return int(max(0, min(100, round(consistency + diversity + reliability + recency))))


def _usage_band(hours: float, gens: int, org_hours_avg: float, org_gens_avg: float) -> str:
    if hours <= 0 and gens <= 0:
        return INACTIVE_BAND
    if org_hours_avg <= 0 and org_gens_avg <= 0:
        return MID_BAND
    score = 0.0
    if org_hours_avg > 0:
        score = max(score, hours / org_hours_avg)
    if org_gens_avg > 0:
        score = max(score, gens / org_gens_avg)
    if score >= 1.5:
        return HIGH_BAND
    if score <= 0.4:
        return LOW_BAND
    return MID_BAND


def _primary_tool(tools: list[dict]) -> str:
    if not tools:
        return "None"
    return max(tools, key=lambda t: (t["generations"], t["credits"]))["tool"]


def _primary_category(tools: list[dict]) -> str:
    if not tools:
        return "None"
    by_cat: dict[str, int] = defaultdict(int)
    for t in tools:
        by_cat[t["category"]] += t["generations"]
    return max(by_cat.items(), key=lambda x: x[1])[0] if by_cat else "None"


def build_snapshot(
    db: Session,
    *,
    preset: Optional[str] = None,
    start: Optional[str] = None,
    end: Optional[str] = None,
    department: Optional[str] = None,
    user_id: Optional[int] = None,
    report_type: Optional[str] = None,
    include_clients: bool = True,
) -> dict:
    period = resolve_period(preset, start, end)
    people = _load_people(db)
    leads = _team_leads(people)
    dept_filter = _dept(department) if department and department not in {"all", "*", ""} else None
    if user_id:
        user_id = int(user_id)

    activity = _load_activity(db, period["start"], period["end"])
    prev_activity = _load_activity(db, period["prev_start"], period["prev_end"])
    facts = _load_generation_facts(db, period, previous=False)
    prev_facts = _load_generation_facts(db, period, previous=True)
    tool_seconds = _load_dashboard_tool_seconds(db, period["utc_start"], period["utc_end"])
    rates_by_credential, default_rate, _rate_currency = _load_credit_rates(db)
    # _load_client_tool_usage is a bulk scan across every provider (ChatGPT,
    # Kling, Freepik, Envato, HeyGen, Higgsfield, ElevenLabs, Flow) for the
    # whole period -- the heaviest query this function runs. It feeds the
    # Clients columns (Team/User Overview, Executive Dashboard) and the
    # Consolidated report's Client Usage tab, but an individual report never
    # reads it (it builds its own client breakdown from
    # _load_person_generation_log), and callers that only want a lightweight
    # slice (e.g. /tools, /preview) can skip it via include_clients=False.
    # "consolidated" always needs it regardless of the flag.
    raw_report_type = (report_type or "").strip().lower()
    compute_clients = not user_id and (include_clients or raw_report_type == "consolidated")
    if compute_clients:
        usage_rows_all = _load_client_tool_usage(db, period)
        clients_by_user = _clients_by_user(usage_rows_all, rates_by_credential, default_rate)
    else:
        usage_rows_all = []
        clients_by_user = {}

    tools_by_user: dict[int, list[dict]] = defaultdict(list)
    org_tool_names: set[str] = set()
    for (uid, _tool), row in facts.items():
        org_tool_names.add(row["tool"])
        tools_by_user[uid].append({
            "tool": row["tool"],
            "category": row["category"],
            "usageCount": row["generations"],
            "generations": row["generations"],
            "success": row["success"],
            "failed": row["failed"],
            "successRate": _success_rate(row["success"], row["generations"]),
            "credits": round(row["credits"], 2),
            "costRupees": round(row["costRupees"], 2),
            "lastUsed": row["lastUsed"] or "None",
            "timeSpentHours": 0.0,
            "timeSpentSeconds": 0,
            "launches": 0,
            "timeSpentNote": "0 min",
        })

    for uid, by_tool in tool_seconds.items():
        existing = {t["tool"]: t for t in tools_by_user[uid]}
        for tool, slot in by_tool.items():
            seconds = float(slot.get("seconds") or 0)
            hours = round(seconds / 3600.0, 2)
            note = _tool_time_label(seconds)
            launches = int(slot.get("launches") or 0)
            if tool in existing:
                existing[tool]["timeSpentHours"] = hours
                existing[tool]["timeSpentSeconds"] = int(round(seconds))
                existing[tool]["launches"] = launches
                existing[tool]["timeSpentNote"] = note
            else:
                org_tool_names.add(tool)
                tools_by_user[uid].append({
                    "tool": tool,
                    "category": "Uncategorised",
                    "usageCount": 0,
                    "generations": 0,
                    "success": 0,
                    "failed": 0,
                    "successRate": 0.0,
                    "credits": 0.0,
                    "costRupees": 0.0,
                    "lastUsed": "None",
                    "timeSpentHours": hours,
                    "timeSpentSeconds": int(round(seconds)),
                    "launches": launches,
                    "timeSpentNote": note,
                })

    prev_gens_by_user: dict[int, int] = defaultdict(int)
    prev_credits_by_user: dict[int, float] = defaultdict(float)
    prev_cost_by_user: dict[int, float] = defaultdict(float)
    for (uid, _tool), row in prev_facts.items():
        prev_gens_by_user[uid] += row["generations"]
        prev_credits_by_user[uid] += row["credits"]
        prev_cost_by_user[uid] += row["costRupees"]

    users = []
    for person in people:
        uid = person["userId"]
        act = activity.get(uid, {})
        tools = sorted(
            tools_by_user.get(uid, []),
            key=lambda t: (t.get("timeSpentHours") or 0, t["generations"]),
            reverse=True,
        )
        gens = sum(t["generations"] for t in tools)
        success = sum(t["success"] for t in tools)
        failed = sum(t["failed"] for t in tools)
        credits = sum(t["credits"] for t in tools)
        cost = sum(t["costRupees"] for t in tools)
        hours = _hours(act.get("seconds", 0))
        tool_time_seconds = sum(float(t.get("timeSpentSeconds") or 0) for t in tools)
        tool_time_hours = round(tool_time_seconds / 3600.0, 2)
        users.append({
            **person,
            "team": person["department"],
            "teamLead": leads.get(person["department"]) or "Not set",
            "reportingManager": leads.get(person["department"]) or "Not set",
            "activeDays": act.get("activeDays", 0),
            "sessions": act.get("sessions", 0),
            "usageSeconds": act.get("seconds", 0),
            "usageHours": hours,
            "toolTimeSeconds": int(round(tool_time_seconds)),
            "toolTimeHours": tool_time_hours,
            "toolTimeLabel": _tool_time_label(tool_time_seconds),
            "avgDailyHours": round(hours / period["days"], 2) if period["days"] else 0,
            "avgSessionMinutes": round((act.get("seconds", 0) / 60.0) / act["sessions"], 1) if act.get("sessions") else 0,
            "firstActivity": act.get("firstActivity"),
            "lastActivity": act.get("lastActivity"),
            "toolsUsed": len(tools),
            "primaryTool": _primary_tool(tools),
            "primaryCategory": _primary_category(tools),
            "generations": gens,
            "successfulGenerations": success,
            "failedGenerations": failed,
            "successRate": _success_rate(success, gens),
            "credits": round(credits, 2),
            "costRupees": round(cost, 2),
            "creditsPerGeneration": _efficiency(credits, success),
            "creditsPerActiveDay": round(credits / act["activeDays"], 2) if act.get("activeDays") else None,
            "outputsPerCredit": round(success / credits, 4) if credits else None,
            "prevGenerations": prev_gens_by_user.get(uid, 0),
            "prevCredits": round(prev_credits_by_user.get(uid, 0), 2),
            "prevCostRupees": round(prev_cost_by_user.get(uid, 0), 2),
            "prevHours": _hours(prev_activity.get(uid, {}).get("seconds", 0)),
            "tools": tools,
            "clientRows": clients_by_user.get(uid) or [],
            "clientsWorked": ", ".join(c["client"] for c in (clients_by_user.get(uid) or [])) or "—",
        })

    org_tools_in_use = max(len(org_tool_names), 1)
    active_people = [u for u in users if u["isActive"]]
    n_active_people = max(len(active_people), 1)
    org_hours_avg = sum(u["usageHours"] for u in active_people) / n_active_people
    org_gens_avg = sum(u["generations"] for u in active_people) / n_active_people
    org_credits_avg = sum(u["credits"] for u in active_people) / n_active_people

    for user in users:
        user["engagementScore"] = _engagement(
            user["activeDays"], period["days"], user["toolsUsed"], org_tools_in_use,
            user["successRate"], user["lastActivity"], period["end"],
        )
        user["usageBand"] = _usage_band(user["usageHours"], user["generations"], org_hours_avg, org_gens_avg)
        user["creditFlag"] = bool(user["credits"] > org_credits_avg * 1.5 and user["credits"] >= 50)

    # Scope only after scoring: a usage band or a credit flag is always
    # org-relative, otherwise a filtered report compares a person to themselves.
    scoped = users
    if dept_filter:
        scoped = [u for u in scoped if u["department"] == dept_filter]
    if user_id:
        scoped = [u for u in scoped if u["userId"] == user_id]

    # Rollups follow the filter. org_tool_names stays org-wide above because
    # engagement diversity is measured against the tools the org actually uses.
    if dept_filter or user_id:
        scoped_ids = {u["userId"] for u in scoped}
        scoped_facts = {k: v for k, v in facts.items() if k[0] in scoped_ids}
        scoped_prev_facts = {k: v for k, v in prev_facts.items() if k[0] in scoped_ids}
        activity_ids = scoped_ids
    else:
        scoped_facts, scoped_prev_facts, activity_ids = facts, prev_facts, None

    teams = _assemble_teams(users, leads, period)
    if dept_filter:
        teams = [t for t in teams if t["name"] == dept_filter]

    org_clients = _org_clients(scoped)

    tools = _assemble_tools(scoped_facts, scoped_prev_facts, scoped, period)
    categories = _assemble_categories(scoped_facts)
    trends = _assemble_trends(db, period, scoped_facts, activity_ids)
    tool_logins = _assemble_tool_logins(_load_tool_login_attempts(db, period, activity_ids), scoped)
    anomalies = _assemble_anomalies(scoped, org_credits_avg, org_gens_avg, period)
    actions = _assemble_actions(scoped, teams, tools, anomalies, period)
    findings = _assemble_findings(scoped, teams, tools, anomalies)

    kpis = _assemble_kpis(scoped, tools, period, scoped_prev_facts, prev_activity, dept_filter, user_id, users)

    report_type = (report_type or "organisation").strip().lower()
    if user_id:
        report_type = "individual"
    elif dept_filter:
        report_type = report_type if report_type in {"team", "organisation", "consolidated"} else "team"

    client_usage: list[dict] = []
    department_usage: list[dict] = []
    if report_type == "consolidated":
        by_uid = {u["userId"]: u for u in scoped}
        scope_ids = set(by_uid) if (dept_filter or user_id) else None
        # Reuse the org-wide rows already fetched above for clientRows/topClients
        # instead of a second _load_client_tool_usage round trip.
        usage_rows = usage_rows_all if scope_ids is None else [r for r in usage_rows_all if r["userId"] in scope_ids]

        def _row_cost(r: dict) -> float:
            cred_id = r.get("credentialId")
            rate = rates_by_credential.get(cred_id, default_rate) if cred_id is not None else default_rate
            return round((r.get("credits") or 0) * rate, 2)

        # _load_client_tool_usage groups per provider by credential_id (each
        # Kling/Freepik/... account has its own rate), so the same person can
        # show up more than once for the same tool + client if they used more
        # than one account for it in the period. Rather than merging those
        # away, surface the account on each row so the split is self-explaining.
        account_ids = {r["credentialId"] for r in usage_rows if r.get("credentialId") is not None}
        account_labels = _resolve_account_labels(db, account_ids)

        def _row_account(r: dict) -> str:
            cred_id = r.get("credentialId")
            return account_labels.get(cred_id, "Not set") if cred_id is not None else "Not set"

        by_client: dict[str, list[dict]] = defaultdict(list)
        by_department: dict[str, list[dict]] = defaultdict(list)
        for r in usage_rows:
            person = by_uid.get(r["userId"])
            if person is None:
                continue
            cost = _row_cost(r)
            account = _row_account(r)
            purpose = _purpose_label(r.get("category"))
            by_client[r["client"]].append({
                "name": person["name"],
                "department": person["department"],
                "tool": r["tool"],
                "purpose": purpose,
                "account": account,
                "generations": r["generations"],
                "credits": r["credits"],
                "costRupees": cost,
            })
            by_department[person["department"]].append({
                "name": person["name"],
                "tool": r["tool"],
                "purpose": purpose,
                "client": r["client"],
                "account": account,
                "generations": r["generations"],
                "credits": r["credits"],
                "costRupees": cost,
            })
        for name, entries in by_client.items():
            entries.sort(key=lambda x: x["credits"], reverse=True)
            client_usage.append({
                "client": name,
                "rows": entries,
                "totalCredits": round(sum(x["credits"] for x in entries), 2),
                "totalGenerations": sum(x["generations"] for x in entries),
                "totalCostRupees": round(sum(x["costRupees"] for x in entries), 2),
            })
        client_usage.sort(key=lambda c: (c["client"] == NO_CLIENT, -c["totalCredits"], c["client"]))

        for name, entries in by_department.items():
            entries.sort(key=lambda x: (x["name"] or "", x["tool"] or ""))
            department_usage.append({
                "department": name,
                "rows": entries,
                "totalCredits": round(sum(x["credits"] for x in entries), 2),
                "totalGenerations": sum(x["generations"] for x in entries),
                "totalCostRupees": round(sum(x["costRupees"] for x in entries), 2),
            })
        department_usage.sort(key=lambda d: (-d["totalCredits"], d["department"] or ""))

    tool_accounts = _load_tool_accounts(db) if report_type == "consolidated" else []
    # scoped, not people: people is org-wide, and this report's Tool
    # Assignments sheet needs to follow the same department/user filter as
    # everything else above (client_usage, department_usage) or a filtered
    # download would list every employee company-wide regardless.
    tool_assignments = _load_tool_assignments(db, scoped) if report_type == "consolidated" else []

    snapshot = {
        "success": True,
        "reportType": report_type,
        "period": {
            "start": str(period["start"]),
            "end": str(period["end"]),
            "days": period["days"],
            "label": period["label"],
            "previousStart": str(period["prev_start"]),
            "previousEnd": str(period["prev_end"]),
        },
        "filters": {"department": dept_filter, "userId": user_id},
        "methodology": METHODOLOGY,
        "kpis": kpis,
        "users": scoped,
        "teams": teams,
        "tools": tools,
        "categories": categories,
        "trends": trends,
        "anomalies": anomalies,
        "actions": actions,
        "findings": findings,
        "timeline": _assemble_timeline(scoped_facts, scoped),
        "toolLogins": tool_logins,
        "preview": _assemble_preview(kpis, findings, actions, period, scoped, teams),
        "clientUsage": client_usage,
        "departmentUsage": department_usage,
        "topClients": org_clients,
        "toolAccounts": tool_accounts,
        "toolAssignments": tool_assignments,
    }
    if user_id and scoped:
        pack = _load_person_generation_log(db, period, user_id)
        person = scoped[0]
        person["clients"] = pack["clients"]
        person["clientTools"] = pack["clientTools"]
        person["generationLog"] = pack["rows"]
        person["generationLogTruncated"] = pack["truncated"]
        person["generationLogLimit"] = pack["limit"]
        person["generationLogTotal"] = pack["totalRows"]
        person["primaryClient"] = pack["primaryClient"]
        person["primaryClientCredits"] = pack["primaryClientCredits"]
        person["primaryClientCostRupees"] = pack["primaryClientCostRupees"]
        person["unlinkedGenerations"] = pack["unlinkedGenerations"]
        person["unlinkedCredits"] = pack["unlinkedCredits"]
        person["unlinkedCostRupees"] = pack["unlinkedCostRupees"]
        person["toolLogins"] = tool_logins
        snapshot["individual"] = person
        snapshot["generationLog"] = pack["rows"]
        snapshot["clients"] = pack["clients"]
        snapshot["clientTools"] = pack["clientTools"]
    if dept_filter and teams:
        snapshot["team"] = teams[0]
    return snapshot


# --------------------------------------------------------------------------- #
# Standalone Tool Logins report (its own date range, not tied to the
# organisation/team/individual snapshot above)
# --------------------------------------------------------------------------- #
def build_tool_login_report(
    db: Session,
    *,
    preset: Optional[str] = None,
    start: Optional[str] = None,
    end: Optional[str] = None,
    department: Optional[str] = None,
    user_id: Optional[int] = None,
) -> dict:
    """Every dashboard tool launch ("login try") in the window: user, tool,
    the assigned account it used, and when. Standalone from build_snapshot so
    it can be pulled on its own date range."""
    period = resolve_period(preset, start, end)
    people = _load_people(db)
    dept_filter = _dept(department) if department and department not in {"all", "*", ""} else None
    if user_id:
        user_id = int(user_id)

    scoped = people
    if dept_filter:
        scoped = [p for p in scoped if p["department"] == dept_filter]
    if user_id:
        scoped = [p for p in scoped if p["userId"] == user_id]

    user_ids = {p["userId"] for p in scoped} if (dept_filter or user_id) else None
    raw = _load_tool_login_attempts(db, period, user_ids)
    rows = _assemble_tool_logins(raw, scoped)

    by_tool: dict[str, int] = defaultdict(int)
    by_user: dict[str, int] = defaultdict(int)
    for r in rows:
        by_tool[r["tool"]] += 1
        by_user[r["userName"]] += 1

    return {
        "success": True,
        "period": {
            "start": str(period["start"]),
            "end": str(period["end"]),
            "days": period["days"],
            "label": period["label"],
        },
        "filters": {"department": dept_filter, "userId": user_id},
        "toolLogins": rows,
        "totalRows": len(rows),
        "capped": len(rows) >= TIMELINE_CAP,
        "uniqueUsers": len(by_user),
        "uniqueTools": len(by_tool),
        "topTools": [{"tool": t, "count": c} for t, c in sorted(by_tool.items(), key=lambda x: -x[1])[:10]],
    }


def _assemble_teams(users: list[dict], leads: dict, period: dict) -> list[dict]:
    grouped: dict[str, list[dict]] = defaultdict(list)
    for user in users:
        grouped[user["department"]].append(user)
    teams = []
    for name, members in grouped.items():
        active = [m for m in members if m["activeDays"] > 0 or m["generations"] > 0]
        gens = sum(m["generations"] for m in members)
        success = sum(m["successfulGenerations"] for m in members)
        credits = sum(m["credits"] for m in members)
        cost = sum(m.get("costRupees") or 0 for m in members)
        hours = sum(m["usageHours"] for m in members)
        sessions = sum(m["sessions"] for m in members)
        n = max(len(members), 1)
        team_client_totals: dict[str, int] = defaultdict(int)
        for m in members:
            for c in m.get("clientRows") or []:
                team_client_totals[c["client"]] += c["generations"]
        team_clients_ordered = sorted(team_client_totals.items(), key=lambda kv: (-kv[1], kv[0]))
        teams.append({
            "name": name,
            "lead": leads.get(name) or "Not set",
            "users": len(members),
            "activeUsers": len(active),
            "inactiveUsers": len(members) - len(active),
            "usageHours": round(hours, 2),
            "sessions": sessions,
            "generations": gens,
            "credits": round(credits, 2),
            "costRupees": round(cost, 2),
            "avgCreditsPerUser": round(credits / n, 2),
            "avgCostPerUser": round(cost / n, 2),
            "avgHoursPerUser": round(hours / n, 2),
            "avgGenerationsPerUser": round(gens / n, 1),
            "successRate": _success_rate(success, gens),
            "clientsWorked": ", ".join(name for name, _n in team_clients_ordered) or "—",
            "members": [
                {
                    "userId": m["userId"],
                    "name": m["name"],
                    "isActiveInPeriod": bool(m["activeDays"] > 0 or m["generations"] > 0),
                    "activeDays": m["activeDays"],
                    "usageHours": m["usageHours"],
                    "sessions": m["sessions"],
                    "generations": m["generations"],
                    "credits": m["credits"],
                    "costRupees": m.get("costRupees") or 0,
                    "creditsPerActiveDay": m.get("creditsPerActiveDay"),
                    "costPerActiveDay": round(m.get("costRupees") / m["activeDays"], 2) if m.get("costRupees") and m["activeDays"] else None,
                    "hoursPerActiveDay": round(m["usageHours"] / m["activeDays"], 2) if m["usageHours"] and m["activeDays"] else None,
                    "successRate": m["successRate"],
                    "toolsUsed": m["toolsUsed"],
                    "engagementScore": m["engagementScore"],
                    "usageBand": m["usageBand"],
                    "clientsWorked": m.get("clientsWorked") or "—",
                }
                for m in sorted(members, key=lambda x: x["credits"], reverse=True)
            ],
        })
    teams.sort(key=lambda t: t["credits"], reverse=True)
    return teams


def _assemble_tools(facts, prev_facts, users, period) -> list[dict]:
    cur: dict[str, dict] = defaultdict(lambda: {
        "generations": 0, "success": 0, "failed": 0, "credits": 0.0, "costRupees": 0.0,
        "users": set(), "lastUsed": None, "category": "Other",
    })
    prev: dict[str, dict] = defaultdict(lambda: {"generations": 0, "credits": 0.0})
    for (uid, tool), row in facts.items():
        slot = cur[tool]
        slot["generations"] += row["generations"]
        slot["success"] += row["success"]
        slot["failed"] += row["failed"]
        slot["credits"] += row["credits"]
        slot["costRupees"] += row["costRupees"]
        slot["users"].add(uid)
        slot["category"] = row["category"]
        if row["lastUsed"] and (slot["lastUsed"] is None or row["lastUsed"] > slot["lastUsed"]):
            slot["lastUsed"] = row["lastUsed"]
    for (uid, tool), row in prev_facts.items():
        prev[tool]["generations"] += row["generations"]
        prev[tool]["credits"] += row["credits"]

    workforce = max(len(users), 1)
    tools = []
    for name, slot in cur.items():
        gens = slot["generations"]
        prev_g = prev[name]["generations"]
        growth = None
        if prev_g == 0:
            growth = 100.0 if gens else 0.0
        else:
            growth = round(((gens - prev_g) / prev_g) * 100.0, 1)
        tools.append({
            "tool": name,
            "category": slot["category"],
            "generations": gens,
            "success": slot["success"],
            "failed": slot["failed"],
            "successRate": _success_rate(slot["success"], gens),
            "credits": round(slot["credits"], 2),
            "costRupees": round(slot["costRupees"], 2),
            "users": len(slot["users"]),
            "adoptionPct": round((len(slot["users"]) / workforce) * 100.0, 1),
            "lastUsed": slot["lastUsed"],
            "prevGenerations": prev_g,
            "growthPct": growth,
            "creditsPerSuccess": _efficiency(slot["credits"], slot["success"]),
        })
    # include tools that vanished this period
    for name, slot in prev.items():
        if name not in cur and slot["generations"]:
            tools.append({
                "tool": name,
                "category": "Other",
                "generations": 0,
                "success": 0,
                "failed": 0,
                "successRate": 0,
                "credits": 0,
                "costRupees": 0,
                "users": 0,
                "adoptionPct": 0,
                "lastUsed": None,
                "prevGenerations": slot["generations"],
                "growthPct": -100.0,
                "creditsPerSuccess": None,
            })
    tools.sort(key=lambda t: t["generations"], reverse=True)
    return tools


def _assemble_categories(facts) -> list[dict]:
    by_cat: dict[str, dict] = defaultdict(lambda: {"generations": 0, "credits": 0.0, "costRupees": 0.0})
    for row in facts.values():
        by_cat[row["category"]]["generations"] += row["generations"]
        by_cat[row["category"]]["credits"] += row["credits"]
        by_cat[row["category"]]["costRupees"] += row["costRupees"]
    out = [
        {"category": k, "generations": v["generations"], "credits": round(v["credits"], 2), "costRupees": round(v["costRupees"], 2)}
        for k, v in by_cat.items()
    ]
    out.sort(key=lambda x: x["generations"], reverse=True)
    return out


def _assemble_trends(db, period, facts, user_ids: Optional[set] = None) -> dict:
    daily_activity = _daily_activity(db, period["start"], period["end"], user_ids)
    by_day: dict[str, dict] = defaultdict(lambda: {"generations": 0, "credits": 0.0, "costRupees": 0.0, "byTool": defaultdict(int)})
    for row in facts.values():
        for day, count in row["days"].items():
            by_day[day]["generations"] += count
            # spread credits/cost proportionally by day count
            total = row["generations"] or 1
            by_day[day]["credits"] += row["credits"] * (count / total)
            by_day[day]["costRupees"] += row["costRupees"] * (count / total)
            by_day[day]["byTool"][row["tool"]] += count
    usage = {d["date"]: d for d in daily_activity}
    cursor = period["start"]
    series = []
    while cursor <= period["end"]:
        key = str(cursor)
        slot = by_day.get(key, {"generations": 0, "credits": 0.0, "costRupees": 0.0, "byTool": {}})
        act = usage.get(key, {"activeUsers": 0, "usageHours": 0})
        series.append({
            "date": key,
            "generations": int(slot["generations"]),
            "credits": round(float(slot["credits"]), 2),
            "costRupees": round(float(slot["costRupees"]), 2),
            "activeUsers": act.get("activeUsers", 0),
            "usageHours": act.get("usageHours", 0),
            "byTool": dict(slot["byTool"]),
        })
        cursor += timedelta(days=1)
    return {"daily": series, "activity": daily_activity}


def _assemble_timeline(facts, scoped_users) -> list[dict]:
    allowed = {u["userId"] for u in scoped_users}
    names = {u["userId"]: u["name"] for u in scoped_users}
    depts = {u["userId"]: u["department"] for u in scoped_users}
    rows = []
    for (uid, tool), row in facts.items():
        if uid not in allowed:
            continue
        for day, count in row["days"].items():
            total = row["generations"] or 1
            rows.append({
                "date": day,
                "userId": uid,
                "userName": names.get(uid, f"User {uid}"),
                "department": depts.get(uid, "Unassigned"),
                "tool": tool,
                "category": row["category"],
                "generations": count,
                "credits": round(row["credits"] * (count / total), 2),
                "costRupees": round(row["costRupees"] * (count / total), 2),
                "status": "captured",
            })
    rows.sort(key=lambda r: (r["date"], r["userName"], r["tool"]), reverse=True)
    return rows[:TIMELINE_CAP]


def _assemble_anomalies(users, org_credits_avg, org_gens_avg, period) -> list[dict]:
    flags = []
    for user in users:
        if user["credits"] > org_credits_avg * 1.5 and user["credits"] >= 50:
            flags.append(_flag("credit_heavy", "review", user,
                f"{user['name']} consumed {user['credits']} credits, {round(((user['credits'] / org_credits_avg) - 1) * 100) if org_credits_avg else 0}% above the group average.",
                "Review generation patterns and determine whether high usage is business-critical."))
        if user["activeDays"] == 0 and user["generations"] == 0 and user["isActive"]:
            flags.append(_flag("inactive", "review", user,
                f"{user['name']} had no recorded activity in {period['label']}.",
                "Confirm whether the inactivity is expected (leave, role change) or an adoption issue."))
        elif user["usageBand"] == LOW_BAND and user["isActive"]:
            flags.append(_flag("low_usage", "info", user,
                f"{user['name']} is in the low-usage band ({user['generations']} generations, {user['usageHours']}h).",
                "Check whether the workflow still requires these tools."))
        if user["generations"] >= 10 and user["successRate"] < 70:
            flags.append(_flag("high_failure", "review", user,
                f"{user['name']} has a {user['successRate']}% success rate across {user['generations']} generations.",
                "Inspect failed generation patterns and tool reliability for this user."))
        if user["prevGenerations"] >= 8:
            change = (user["generations"] - user["prevGenerations"]) / user["prevGenerations"]
            if change <= -0.38:
                flags.append(_flag("declining", "review", user,
                    f"{user['name']}'s generations declined {round(abs(change) * 100)}% vs the previous period.",
                    "Check whether the decline is expected or whether there is an adoption/workflow issue."))
            elif change >= 1.0 and user["generations"] >= 10:
                flags.append(_flag("usage_spike", "info", user,
                    f"{user['name']}'s generations rose {round(change * 100)}% vs the previous period.",
                    "Confirm the spike maps to planned work rather than unattended automation."))
        if user["avgSessionMinutes"] >= 12 * 60:
            flags.append(_flag("long_session", "info", user,
                f"{user['name']} averaged {user['avgSessionMinutes']} minutes per recorded session day.",
                "Unusually long presence — verify the heartbeat is reflecting real work."))
        if user["engagementScore"] >= 70 and user["creditsPerGeneration"] is not None:
            peer_eff = [u["creditsPerGeneration"] for u in users if u["creditsPerGeneration"]]
            if peer_eff:
                avg_eff = sum(peer_eff) / len(peer_eff)
                if user["creditsPerGeneration"] < avg_eff * 0.7 and user["successfulGenerations"] >= 8:
                    flags.append(_flag("efficient", "positive", user,
                        f"{user['name']} produces more successful outputs per credit than the group average.",
                        "Consider documenting or sharing their workflow with the team."))
    severity = {"review": 0, "info": 1, "positive": 2}
    flags.sort(key=lambda f: (severity.get(f["severity"], 9), -f.get("credits", 0)))
    return flags[:80]


def _flag(kind, severity, user, finding, action):
    return {
        "kind": kind,
        "severity": severity,
        "userId": user["userId"],
        "userName": user["name"],
        "department": user["department"],
        "finding": finding,
        "recommendedAction": action,
        "credits": user["credits"],
        "costRupees": user.get("costRupees") or 0,
        "generations": user["generations"],
    }


def _assemble_actions(users, teams, tools, anomalies, period) -> list[dict]:
    actions = []
    seen = set()
    for flag in anomalies:
        if flag["severity"] == "review":
            key = (flag["kind"], flag["userId"])
            if key in seen:
                continue
            seen.add(key)
            actions.append({
                "priority": 1 if flag["kind"] in {"credit_heavy", "high_failure"} else 2,
                "title": flag["finding"],
                "action": flag["recommendedAction"],
                "kind": flag["kind"],
                "target": flag["userName"],
                "department": flag["department"],
            })
    unused = [t for t in tools if t["generations"] == 0 or t["adoptionPct"] < 10]
    for tool in unused[:3]:
        actions.append({
            "priority": 2,
            "title": f"{tool['tool']} is underutilised ({tool['adoptionPct']}% adoption).",
            "action": "Evaluate whether training, workflow integration, or licence reduction is required.",
            "kind": "low_adoption",
            "target": tool["tool"],
            "department": None,
        })
    if teams:
        top = teams[0]
        actions.append({
            "priority": 3,
            "title": f"{top['name']} consumed the most credits ({top['credits']}).",
            "action": "Review whether this spend maps to delivery-critical work.",
            "kind": "team_spend",
            "target": top["name"],
            "department": top["name"],
        })
    growing = [t for t in tools if (t.get("growthPct") or 0) >= 40 and t["generations"] >= 10]
    growing.sort(key=lambda t: t["growthPct"], reverse=True)
    for tool in growing[:2]:
        actions.append({
            "priority": 2,
            "title": f"{tool['tool']} usage grew {tool['growthPct']}% vs the previous period.",
            "action": "Analyse cost growth and confirm capacity/licences keep pace.",
            "kind": "growth",
            "target": tool["tool"],
            "department": None,
        })
    actions.sort(key=lambda a: a["priority"])
    return actions[:25]


def _assemble_findings(users, teams, tools, anomalies) -> list[str]:
    findings = []
    if teams:
        findings.append(f"{teams[0]['name']} consumed the highest number of credits ({teams[0]['credits']}).")
    growing = [t for t in tools if (t.get("growthPct") or 0) >= 25]
    if growing:
        findings.append(f"{growing[0]['tool']} usage increased {growing[0]['growthPct']}% vs the previous period.")
    heavy = [a for a in anomalies if a["kind"] == "credit_heavy"]
    if heavy:
        findings.append(f"{len(heavy)} user(s) showed unusually high credit consumption.")
    inactive = [a for a in anomalies if a["kind"] == "inactive"]
    if inactive:
        findings.append(f"{len(inactive)} active account(s) were unused during the selected period.")
    if not findings:
        findings.append("No material outliers versus the previous equivalent period.")
    return findings[:6]


def _assemble_kpis(scoped, tools, period, prev_facts, prev_activity, dept_filter, user_id, all_users) -> dict:
    workforce = [u for u in scoped if u["isActive"]]
    active_now = [u for u in scoped if u["activeDays"] > 0 or u["generations"] > 0]
    gens = sum(u["generations"] for u in scoped)
    success = sum(u["successfulGenerations"] for u in scoped)
    credits = sum(u["credits"] for u in scoped)
    cost = sum(u.get("costRupees") or 0 for u in scoped)
    hours = sum(u["usageHours"] for u in scoped)
    sessions = sum(u["sessions"] for u in scoped)

    prev_gens = sum(u["prevGenerations"] for u in scoped)
    prev_credits = sum(u["prevCredits"] for u in scoped)
    prev_cost = sum(u.get("prevCostRupees") or 0 for u in scoped)
    prev_hours = sum(u["prevHours"] for u in scoped)
    prev_active = sum(1 for u in scoped if u["prevGenerations"] > 0 or u["prevHours"] > 0)
    scoped_ids = {u["userId"] for u in scoped}
    prev_success = sum(r["success"] for (uid, _t), r in prev_facts.items() if uid in scoped_ids)
    prev_total = sum(r["generations"] for (uid, _t), r in prev_facts.items() if uid in scoped_ids)
    prev_sessions = 0  # sessions are not stored on the user row for the prior window
    n = max(len(workforce), 1)

    most_used = tools[0]["tool"] if tools else "None"
    least_used = min(tools, key=lambda t: t["generations"])["tool"] if tools else "None"
    fastest = max(tools, key=lambda t: (t.get("growthPct") or -999)) if tools else None
    expensive = max(tools, key=lambda t: t["credits"]) if tools else None
    top_consumer = max(scoped, key=lambda u: u["credits"]) if scoped else None

    teams_count = len({u["department"] for u in scoped})

    return {
        "totalUsers": {"value": len(scoped), "previous": len(scoped), "deltaPct": 0, "direction": "flat"},
        "activeUsers": _metric(len(active_now), prev_active),
        "activeUserCount": len(active_now),
        "workforce": len(workforce),
        "teams": teams_count,
        "usageHours": {**_metric(hours, prev_hours), "unit": "h"},
        "sessions": {"value": sessions, "previous": prev_sessions, "deltaPct": 0, "direction": "flat"},
        "generations": _metric(gens, prev_gens),
        "credits": _metric(credits, prev_credits),
        "cost": _metric(cost, prev_cost),
        "avgHoursPerUser": {**_metric(hours / n, prev_hours / n), "unit": "h"},
        "avgCreditsPerUser": _metric(credits / n, prev_credits / n),
        "avgCostPerUser": _metric(cost / n, prev_cost / n),
        "avgGenerationsPerUser": _metric(gens / n, prev_gens / n),
        "successRate": {**_metric(_success_rate(success, gens), _success_rate(prev_success, prev_total)), "unit": "%"},
        "mostUsedTool": most_used,
        "leastUsedTool": least_used,
        "fastestGrowingTool": fastest["tool"] if fastest else "None",
        "fastestGrowingPct": fastest.get("growthPct") if fastest else None,
        "mostExpensiveTool": expensive["tool"] if expensive else "None",
        "highestCreditConsumer": top_consumer["name"] if top_consumer else "None",
        "highestCreditConsumerValue": top_consumer["credits"] if top_consumer else 0,
        "adoptionPct": round((len(active_now) / n) * 100.0, 1) if n else 0,
    }


def _assemble_preview(kpis, findings, actions, period, scoped, teams) -> dict:
    return {
        "title": "Report generated successfully",
        "period": period["label"],
        "users": len(scoped),
        "teams": len(teams),
        "activeUsers": kpis["activeUserCount"],
        "generations": kpis["generations"]["value"],
        "credits": kpis["credits"]["value"],
        "usageHours": kpis["usageHours"]["value"],
        "successRate": kpis["successRate"]["value"],
        "findings": findings,
        "recommendedActions": [a["action"] for a in actions[:5]],
        "actionTitles": [a["title"] for a in actions[:5]],
    }
