"""
Reports / Business Intelligence aggregation endpoints.

Powers the frontend "AI Intelligence Command Center" (Reports module).
All endpoints are faculty/admin gated (same policy as generation analytics)
and read-only. They reuse existing SQLAlchemy models — no schema changes.

Metric philosophy: only real, derivable numbers are returned. Metrics that
require an external baseline (productivity lift, ROI) are returned as null with
`baselineRequired: true` so the UI can render them honestly instead of
fabricating a value.
"""

import json
import math
from collections import Counter, defaultdict
from datetime import date, datetime, timedelta
from typing import Optional

from fastapi import APIRouter, Depends, Query
from sqlalchemy import case, func, literal, or_, text
from sqlalchemy.orm import Session

from database_config import get_operational_db
from models_new import ActivityStatus, GenerationRecord, GenerationTag, ITPortalTool, ITPortalToolUsageEvent, Task, TaskStatus, TaskStatusHistory, ToolCreditRate, User, UserActivity
from providers.chatgpt.models import ConversationPrompt, ConversationRecord
from utils.permissions import require_faculty

router = APIRouter(prefix="/api/reports", tags=["Reports"])

# capture_status values treated as a successful generation outcome.
SUCCESS_STATUSES = ("active", "completed")
DEFAULT_WINDOW_DAYS = 30
KLING_PROVIDER = "kling"
CHATGPT_PROVIDER = "chatgpt"


# ---------------------------------------------------------------------------
# Period helpers
# ---------------------------------------------------------------------------
def _parse_date(value: Optional[str]) -> Optional[date]:
    if not value:
        return None
    try:
        return datetime.strptime(value.strip(), "%Y-%m-%d").date()
    except (ValueError, AttributeError):
        return None


def _resolve_period(start: Optional[str], end: Optional[str]):
    """Return (start_dt, end_exclusive_dt, prev_start_dt, prev_end_exclusive_dt, days)."""
    end_date = _parse_date(end) or date.today()
    start_date = _parse_date(start) or (end_date - timedelta(days=DEFAULT_WINDOW_DAYS - 1))
    if start_date > end_date:
        start_date, end_date = end_date, start_date

    start_dt = datetime(start_date.year, start_date.month, start_date.day)
    end_exclusive = datetime(end_date.year, end_date.month, end_date.day) + timedelta(days=1)
    days = max((end_date - start_date).days + 1, 1)

    prev_end_exclusive = start_dt
    prev_start_dt = start_dt - timedelta(days=days)
    return start_dt, end_exclusive, prev_start_dt, prev_end_exclusive, days


def _metric(current, previous, *, baseline_required: bool = False):
    if baseline_required:
        return {
            "value": None,
            "previous": None,
            "deltaPct": None,
            "direction": "flat",
            "baselineRequired": True,
        }
    current = float(current or 0)
    previous = float(previous or 0)
    if previous == 0:
        delta_pct = 100.0 if current > 0 else 0.0
    else:
        delta_pct = round(((current - previous) / previous) * 100.0, 1)
    direction = "up" if current > previous else "down" if current < previous else "flat"
    return {
        "value": round(current, 2) if current % 1 else int(current),
        "previous": round(previous, 2) if previous % 1 else int(previous),
        "deltaPct": delta_pct,
        "direction": direction,
    }


# ---------------------------------------------------------------------------
# Query building blocks
# ---------------------------------------------------------------------------
def _gen_query(db: Session, start_dt, end_exclusive, department: Optional[str], provider: Optional[str] = None):
    q = (
        db.query(GenerationRecord)
        .filter(
            GenerationRecord.archived_at.is_(None),
            GenerationRecord.created_at >= start_dt,
            GenerationRecord.created_at < end_exclusive,
        )
    )
    if provider:
        q = q.filter(GenerationRecord.provider == provider)
    if department and department != "all":
        q = q.join(User, GenerationRecord.owner_user_id == User.id).filter(User.department == department)
    return q


def _count(query) -> int:
    return int(query.with_entities(func.count(GenerationRecord.id)).scalar() or 0)


def _credits(query) -> float:
    return float(query.with_entities(func.coalesce(func.sum(GenerationRecord.credits_burned), 0)).scalar() or 0)


# ---------------------------------------------------------------------------
# Credit -> currency cost (Tier 1)
# ---------------------------------------------------------------------------
# Rates are keyed by Kling account (it_portal_tool_credentials.id). A generation
# record reaches its account via source_usage_event_id -> usage event ->
# credential_id, so cost queries LEFT JOIN the usage event and the rate CASE keys
# on ITPortalToolUsageEvent.credential_id. Records with no linkable account (or an
# account without a configured rate) fall back to the global default rate. The
# board assumes a single currency (the global default row's).
def _credit_rate_context(db: Session):
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
    default_rate = 1.0
    currency = "INR"
    credential_rates: dict[int, float] = {}
    global_seen = False
    for r in rows:
        if r.rate_per_credit is None:
            continue
        rate = float(r.rate_per_credit)
        if r.credential_id is not None:
            credential_rates.setdefault(r.credential_id, rate)  # newest row per account wins
        elif r.provider is None and r.tool_id is None:
            if not global_seen:  # newest global row wins
                default_rate = rate
                currency = r.currency or "INR"
                global_seen = True
    whens = [
        (ITPortalToolUsageEvent.credential_id == cid, rate)
        for cid, rate in credential_rates.items()
    ]
    rate_expr = case(*whens, else_=default_rate) if whens else literal(default_rate)
    return rate_expr, currency, default_rate


# LEFT JOIN a GenerationRecord query to its source usage event so the rate CASE
# (keyed on credential_id) can be evaluated. The FK is to-one, so no row fan-out.
def _with_cost_join(query):
    return query.outerjoin(
        ITPortalToolUsageEvent,
        GenerationRecord.source_usage_event_id == ITPortalToolUsageEvent.id,
    )


def _cost_sum_expr(rate_expr):
    return func.coalesce(func.sum(GenerationRecord.credits_burned * rate_expr), 0)


def _cost(query, rate_expr) -> float:
    return float(_with_cost_join(query).with_entities(_cost_sum_expr(rate_expr)).scalar() or 0)


def _success_count(query) -> int:
    return int(
        query.with_entities(func.count(GenerationRecord.id))
        .filter(GenerationRecord.capture_status.in_(SUCCESS_STATUSES))
        .scalar()
        or 0
    )


def _active_users(db: Session, start_dt, end_exclusive, department: Optional[str]) -> int:
    q = db.query(func.count(func.distinct(User.id))).filter(
        User.is_deleted.is_(False),
        User.last_login.isnot(None),
        User.last_login >= start_dt,
        User.last_login < end_exclusive,
    )
    if department and department != "all":
        q = q.filter(User.department == department)
    return int(q.scalar() or 0)


def _total_users(db: Session, department: Optional[str]) -> int:
    q = db.query(func.count(User.id)).filter(User.is_deleted.is_(False))
    if department and department != "all":
        q = q.filter(User.department == department)
    return int(q.scalar() or 0)


# A generation is treated as a "video" when it carries a duration label,
# otherwise it is counted as an image. Kling clips always carry a duration.
def _is_video_filter(query):
    return query.filter(
        GenerationRecord.duration_label.isnot(None),
        GenerationRecord.duration_label != "",
    )


def _is_image_filter(query):
    from sqlalchemy import or_

    return query.filter(
        or_(GenerationRecord.duration_label.is_(None), GenerationRecord.duration_label == "")
    )


# ---------------------------------------------------------------------------
# Filter options
# ---------------------------------------------------------------------------
@router.get("/filters")
def report_filters(
    db: Session = Depends(get_operational_db),
    current_user: User = Depends(require_faculty),
):
    departments = [
        row[0]
        for row in db.query(User.department)
        .filter(User.is_deleted.is_(False), User.department.isnot(None), User.department != "")
        .distinct()
        .order_by(User.department.asc())
        .all()
    ]
    providers = [
        row[0]
        for row in db.query(GenerationRecord.provider)
        .filter(GenerationRecord.provider.isnot(None))
        .distinct()
        .order_by(GenerationRecord.provider.asc())
        .all()
    ]
    models = [
        row[0]
        for row in db.query(GenerationRecord.model_label)
        .filter(GenerationRecord.model_label.isnot(None), GenerationRecord.model_label != "")
        .distinct()
        .order_by(GenerationRecord.model_label.asc())
        .limit(100)
        .all()
    ]
    # Kling accounts (credential -> person name / email) for the account filter.
    wide_start = datetime(2000, 1, 1)
    wide_end = datetime.utcnow() + timedelta(days=1)
    label_map = _kling_account_label_map(db, wide_start, wide_end)
    emails = {e.lower() for e in label_map.values() if e and "@" in e}
    email_to_name = {}
    if emails:
        for name, email in db.query(User.name, User.email).filter(func.lower(User.email).in_(list(emails))).all():
            if email and name:
                email_to_name[email.lower()] = name
    kling_accounts = sorted(
        [
            {"credentialId": cid, "label": (email_to_name.get((e or "").lower()) or e or f"Account #{cid}")}
            for cid, e in label_map.items()
        ],
        key=lambda a: a["label"].lower(),
    )
    return {
        "success": True,
        "departments": departments,
        "providers": providers,
        "models": models,
        "klingAccounts": kling_accounts,
    }


# ---------------------------------------------------------------------------
# Executive Command Center
# ---------------------------------------------------------------------------
@router.get("/executive")
def executive_summary(
    start: Optional[str] = Query(None),
    end: Optional[str] = Query(None),
    department: Optional[str] = Query(None),
    db: Session = Depends(get_operational_db),
    current_user: User = Depends(require_faculty),
):
    start_dt, end_exclusive, prev_start, prev_end, days = _resolve_period(start, end)

    def block(s, e):
        base = _gen_query(db, s, e, department)
        gens = _count(base)
        videos = _count(_is_video_filter(_gen_query(db, s, e, department)))
        images = _count(_is_image_filter(_gen_query(db, s, e, department)))
        credits = _credits(_gen_query(db, s, e, department))
        active = _active_users(db, s, e, department)
        return {"gens": gens, "videos": videos, "images": images, "credits": credits, "active": active}

    cur = block(start_dt, end_exclusive)
    prv = block(prev_start, prev_end)

    total_users = _total_users(db, department)
    adoption_cur = round((cur["active"] / total_users) * 100.0, 1) if total_users else 0.0
    prev_total = total_users  # headcount is treated as stable across the comparison window
    adoption_prev = round((prv["active"] / prev_total) * 100.0, 1) if prev_total else 0.0

    # Task productivity (real completion signal; lift % needs a baseline).
    tasks_created = int(
        db.query(func.count(Task.id))
        .filter(Task.created_at >= start_dt, Task.created_at < end_exclusive)
        .scalar()
        or 0
    )
    tasks_completed = int(
        db.query(func.count(Task.id))
        .filter(
            Task.status == TaskStatus.COMPLETED,
            Task.completed_at.isnot(None),
            Task.completed_at >= start_dt,
            Task.completed_at < end_exclusive,
        )
        .scalar()
        or 0
    )

    # Daily sparkline series (generations + credits) across the current window.
    daily_rows = (
        _gen_query(db, start_dt, end_exclusive, department)
        .with_entities(
            func.date(GenerationRecord.created_at).label("day"),
            func.count(GenerationRecord.id).label("count"),
            func.coalesce(func.sum(GenerationRecord.credits_burned), 0).label("credits"),
        )
        .group_by(func.date(GenerationRecord.created_at))
        .order_by(func.date(GenerationRecord.created_at).asc())
        .all()
    )
    series_generations = [{"date": str(d), "value": int(c)} for d, c, _cr in daily_rows]
    series_credits = [{"date": str(d), "value": float(cr)} for d, _c, cr in daily_rows]

    return {
        "success": True,
        "period": {"start": str(start_dt.date()), "end": str((end_exclusive - timedelta(days=1)).date()), "days": days},
        "kpis": {
            "activeUsers": _metric(cur["active"], prv["active"]),
            "aiGenerations": {**_metric(cur["gens"], prv["gens"]), "series": series_generations},
            "videosGenerated": _metric(cur["videos"], prv["videos"]),
            "imagesGenerated": _metric(cur["images"], prv["images"]),
            "aiCost": {**_metric(cur["credits"], prv["credits"]), "unit": "credits", "series": series_credits},
            "productivityImprovement": _metric(None, None, baseline_required=True),
            "aiAdoptionRate": {**_metric(adoption_cur, adoption_prev), "unit": "%"},
            "roi": _metric(None, None, baseline_required=True),
        },
        "tasks": {
            "created": tasks_created,
            "completed": tasks_completed,
            "completionRate": round((tasks_completed / tasks_created) * 100.0, 1) if tasks_created else 0.0,
        },
        "context": {"totalUsers": total_users},
    }


# ---------------------------------------------------------------------------
# Kling Intelligence
# ---------------------------------------------------------------------------
@router.get("/kling/summary")
def kling_summary(
    start: Optional[str] = Query(None),
    end: Optional[str] = Query(None),
    department: Optional[str] = Query(None),
    db: Session = Depends(get_operational_db),
    current_user: User = Depends(require_faculty),
):
    start_dt, end_exclusive, prev_start, prev_end, days = _resolve_period(start, end)

    def block(s, e):
        base = _gen_query(db, s, e, department, provider=KLING_PROVIDER)
        total = _count(base)
        success = _success_count(_gen_query(db, s, e, department, provider=KLING_PROVIDER))
        credits = _credits(_gen_query(db, s, e, department, provider=KLING_PROVIDER))
        unique_users = int(
            _gen_query(db, s, e, department, provider=KLING_PROVIDER)
            .with_entities(func.count(func.distinct(GenerationRecord.owner_user_id)))
            .scalar()
            or 0
        )
        return {"total": total, "success": success, "credits": credits, "users": unique_users}

    cur = block(start_dt, end_exclusive)
    prv = block(prev_start, prev_end)

    avg_cur = round(cur["total"] / cur["users"], 1) if cur["users"] else 0.0
    avg_prv = round(prv["total"] / prv["users"], 1) if prv["users"] else 0.0
    success_rate_cur = round((cur["success"] / cur["total"]) * 100.0, 1) if cur["total"] else 0.0
    success_rate_prv = round((prv["success"] / prv["total"]) * 100.0, 1) if prv["total"] else 0.0

    # Status breakdown for an honest success/failure view.
    status_rows = (
        _gen_query(db, start_dt, end_exclusive, department, provider=KLING_PROVIDER)
        .with_entities(GenerationRecord.capture_status, func.count(GenerationRecord.id))
        .group_by(GenerationRecord.capture_status)
        .all()
    )
    status_breakdown = [{"status": s or "unknown", "count": int(c)} for s, c in status_rows]

    return {
        "success": True,
        "period": {"start": str(start_dt.date()), "end": str((end_exclusive - timedelta(days=1)).date()), "days": days},
        "kpis": {
            "totalVideos": _metric(cur["total"], prv["total"]),
            "uniqueUsers": _metric(cur["users"], prv["users"]),
            "avgVideosPerUser": _metric(avg_cur, avg_prv),
            "successRate": {**_metric(success_rate_cur, success_rate_prv), "unit": "%"},
            "creditsConsumed": {**_metric(cur["credits"], prv["credits"]), "unit": "credits"},
        },
        "statusBreakdown": status_breakdown,
    }


@router.get("/kling/trends")
def kling_trends(
    start: Optional[str] = Query(None),
    end: Optional[str] = Query(None),
    department: Optional[str] = Query(None),
    db: Session = Depends(get_operational_db),
    current_user: User = Depends(require_faculty),
):
    start_dt, end_exclusive, _ps, _pe, _days = _resolve_period(start, end)

    # Daily generation trend.
    daily_rows = (
        _gen_query(db, start_dt, end_exclusive, department, provider=KLING_PROVIDER)
        .with_entities(
            func.date(GenerationRecord.created_at).label("day"),
            func.count(GenerationRecord.id).label("count"),
            func.coalesce(func.sum(GenerationRecord.credits_burned), 0).label("credits"),
        )
        .group_by(func.date(GenerationRecord.created_at))
        .order_by(func.date(GenerationRecord.created_at).asc())
        .all()
    )
    daily = [{"date": str(d), "videos": int(c), "credits": float(cr)} for d, c, cr in daily_rows]

    # By department.
    dept_rows = (
        db.query(User.department, func.count(GenerationRecord.id))
        .join(GenerationRecord, GenerationRecord.owner_user_id == User.id)
        .filter(
            GenerationRecord.archived_at.is_(None),
            GenerationRecord.provider == KLING_PROVIDER,
            GenerationRecord.created_at >= start_dt,
            GenerationRecord.created_at < end_exclusive,
            User.department.isnot(None),
        )
        .group_by(User.department)
        .order_by(func.count(GenerationRecord.id).desc())
        .all()
    )
    by_department = [{"department": d or "Unassigned", "videos": int(c)} for d, c in dept_rows]

    # Peak usage hour (DB-agnostic: bucket created_at in Python).
    created_rows = (
        _gen_query(db, start_dt, end_exclusive, department, provider=KLING_PROVIDER)
        .with_entities(GenerationRecord.created_at, GenerationRecord.capture_status)
        .all()
    )
    hour_buckets = defaultdict(int)
    success_total = 0
    failure_total = 0
    for created_at, status in created_rows:
        if created_at is not None:
            hour_buckets[created_at.hour] += 1
        if status in SUCCESS_STATUSES:
            success_total += 1
        else:
            failure_total += 1
    by_hour = [{"hour": h, "videos": hour_buckets.get(h, 0)} for h in range(24)]

    return {
        "success": True,
        "daily": daily,
        "byDepartment": by_department,
        "byHour": by_hour,
        "successVsFailure": [
            {"label": "Success", "count": success_total},
            {"label": "Failure", "count": failure_total},
        ],
    }


@router.get("/kling/users")
def kling_users(
    start: Optional[str] = Query(None),
    end: Optional[str] = Query(None),
    department: Optional[str] = Query(None),
    limit: int = Query(50, ge=1, le=200),
    db: Session = Depends(get_operational_db),
    current_user: User = Depends(require_faculty),
):
    start_dt, end_exclusive, _ps, _pe, _days = _resolve_period(start, end)

    rows = (
        db.query(
            User.id,
            User.name,
            User.avatar,
            User.department,
            func.count(GenerationRecord.id).label("videos"),
            func.coalesce(func.sum(GenerationRecord.credits_burned), 0).label("credits"),
        )
        .join(GenerationRecord, GenerationRecord.owner_user_id == User.id)
        .filter(
            GenerationRecord.archived_at.is_(None),
            GenerationRecord.provider == KLING_PROVIDER,
            GenerationRecord.created_at >= start_dt,
            GenerationRecord.created_at < end_exclusive,
        )
    )
    if department and department != "all":
        rows = rows.filter(User.department == department)
    rows = (
        rows.group_by(User.id, User.name, User.avatar, User.department)
        .order_by(func.count(GenerationRecord.id).desc())
        .limit(limit)
        .all()
    )

    # Success counts per user (separate pass keeps the query portable).
    user_ids = [r[0] for r in rows]
    success_map = {}
    if user_ids:
        success_rows = (
            db.query(GenerationRecord.owner_user_id, func.count(GenerationRecord.id))
            .filter(
                GenerationRecord.archived_at.is_(None),
                GenerationRecord.provider == KLING_PROVIDER,
                GenerationRecord.created_at >= start_dt,
                GenerationRecord.created_at < end_exclusive,
                GenerationRecord.owner_user_id.in_(user_ids),
                GenerationRecord.capture_status.in_(SUCCESS_STATUSES),
            )
            .group_by(GenerationRecord.owner_user_id)
            .all()
        )
        success_map = {uid: int(c) for uid, c in success_rows}

    users = []
    for rank, (uid, name, avatar, dept, videos, credits) in enumerate(rows, start=1):
        videos = int(videos)
        success = success_map.get(uid, 0)
        users.append({
            "rank": rank,
            "userId": uid,
            "name": name or "Unknown",
            "avatar": avatar,
            "department": dept or "Unassigned",
            "videos": videos,
            "successRate": round((success / videos) * 100.0, 1) if videos else 0.0,
            "credits": float(credits),
        })

    return {"success": True, "users": users}


# ---------------------------------------------------------------------------
# Kling Account & Usage Intelligence
# ---------------------------------------------------------------------------
# Built on it_portal_tool_usage_events (the raw capture) rather than the
# de-duplicated generation_records. Rationale from the data: all Kling activity is
# captured under a single shared company login, so per-employee attribution does
# not exist — the real cost/usage entity is the Kling ACCOUNT (credential_id). The
# usage-event layer also carries event_type/status, model_label and per-event
# credits that generation_records lacks. IST (+05:30) is used for hour-of-day so
# "peak hours" reflect the working day, not UTC.
KLING_TOOL_SLUGS = ("kling", "kling-ai", "klingai")
IST_INTERVAL = text("interval '330 minutes'")
KLING_GENERATION_EVENT = "network_generation"  # the observed, settled generation


def _kling_usage_query(db: Session, start_dt, end_exclusive, account=None):
    q = (
        db.query(ITPortalToolUsageEvent)
        .join(ITPortalTool, ITPortalToolUsageEvent.tool_id == ITPortalTool.id)
        .filter(
            func.lower(func.coalesce(ITPortalTool.slug, "")).in_(KLING_TOOL_SLUGS),
            ITPortalToolUsageEvent.created_at >= start_dt,
            ITPortalToolUsageEvent.created_at < end_exclusive,
        )
    )
    if account not in (None, "", "all"):
        try:
            q = q.filter(ITPortalToolUsageEvent.credential_id == int(account))
        except (TypeError, ValueError):
            pass
    return q


def _kling_account_label_map(db: Session, start_dt, end_exclusive) -> dict:
    """Resolve each Kling credential_id to its captured human label
    (klingAccountLabel — typically the account's email).

    Read in Python rather than via SQL ``->>`` because some captured metadata
    contains a NUL char (\\u0000) that Postgres cannot convert to text. DISTINCT ON
    keeps this to one (most-recent) metadata row per credential in the window.
    """
    rows = (
        _kling_usage_query(db, start_dt, end_exclusive)
        .filter(ITPortalToolUsageEvent.credential_id.isnot(None))
        .with_entities(ITPortalToolUsageEvent.credential_id, ITPortalToolUsageEvent.metadata_json)
        .order_by(ITPortalToolUsageEvent.credential_id, ITPortalToolUsageEvent.created_at.desc())
        .distinct(ITPortalToolUsageEvent.credential_id)
        .all()
    )
    label_map: dict = {}
    for cid, md in rows:
        if isinstance(md, str):
            try:
                md = json.loads(md)
            except Exception:
                md = None
        if isinstance(md, dict):
            label = md.get("klingAccountLabel")
            if label:
                label_map[cid] = label
    return label_map


@router.get("/kling/accounts")
def kling_accounts(
    start: Optional[str] = Query(None),
    end: Optional[str] = Query(None),
    account: Optional[str] = Query(None),
    db: Session = Depends(get_operational_db),
    current_user: User = Depends(require_faculty),
):
    """Per Kling account (credential): usage, credits and real ₹ cost.

    Answers 'which account is burning the most credits / money', account efficiency
    and share of spend — the meaningful cost-centre cut given single-login capture.
    When ``account`` (a credential id) is given, restricts to that one account.
    """
    start_dt, end_exclusive, _ps, _pe, days = _resolve_period(start, end)
    rate_expr, currency, _default_rate = _credit_rate_context(db)  # keys on credential_id
    cost_expr = func.coalesce(func.sum(ITPortalToolUsageEvent.credits_burned * rate_expr), 0)
    gen_filter = ITPortalToolUsageEvent.event_type == KLING_GENERATION_EVENT

    # Each Kling account is a login (usually a person's email); resolve its
    # human label from the captured metadata so the cut reads "by account/user".
    label_map = _kling_account_label_map(db, start_dt, end_exclusive)
    # Map account email -> the platform user's name (case-insensitive), so the
    # table shows the person (e.g. "mansi gupta") wherever the account email
    # matches a real user; otherwise it falls back to the email.
    emails = {e.lower() for e in label_map.values() if e and "@" in e}
    email_to_name = {}
    if emails:
        for name, email in (
            db.query(User.name, User.email).filter(func.lower(User.email).in_(list(emails))).all()
        ):
            if email and name:
                email_to_name[email.lower()] = name

    rows = (
        _kling_usage_query(db, start_dt, end_exclusive, account=account)
        .with_entities(
            ITPortalToolUsageEvent.credential_id,
            func.count(ITPortalToolUsageEvent.id),
            func.count(ITPortalToolUsageEvent.id).filter(gen_filter),
            func.coalesce(func.sum(ITPortalToolUsageEvent.credits_burned), 0),
            cost_expr,
        )
        .group_by(ITPortalToolUsageEvent.credential_id)
        .all()
    )

    total_credits = sum(float(r[3]) for r in rows)
    accounts = []
    for cid, events, gens, credits, cost in rows:
        credits = float(credits)
        gens = int(gens or 0)
        email = label_map.get(cid)
        person = email_to_name.get(email.lower()) if email else None
        label = person or email or (f"Account #{cid}" if cid is not None else "Unlinked")
        accounts.append({
            "credentialId": cid,
            "label": label,
            "personName": person,
            "accountEmail": email,
            "events": int(events),
            "generations": gens,
            "credits": round(credits, 1),
            "cost": round(float(cost), 2),
            "avgCreditsPerGeneration": round(credits / gens, 1) if gens else 0.0,
            "creditSharePct": round(credits / total_credits * 100.0, 1) if total_credits else 0.0,
        })
    accounts.sort(key=lambda a: a["cost"], reverse=True)

    return {
        "success": True,
        "currency": currency,
        "period": {"start": str(start_dt.date()), "end": str((end_exclusive - timedelta(days=1)).date()), "days": days},
        "totals": {
            "accounts": len(accounts),
            "credits": round(total_credits, 1),
            "cost": round(sum(a["cost"] for a in accounts), 2),
            "generations": sum(a["generations"] for a in accounts),
        },
        "accounts": accounts,
    }


@router.get("/kling/timing")
def kling_timing(
    start: Optional[str] = Query(None),
    end: Optional[str] = Query(None),
    db: Session = Depends(get_operational_db),
    current_user: User = Depends(require_faculty),
):
    """When Kling generations happen: hour-of-day, day-of-week and a day×hour heatmap (IST)."""
    start_dt, end_exclusive, _ps, _pe, days = _resolve_period(start, end)
    ist_ts = ITPortalToolUsageEvent.created_at + IST_INTERVAL
    hour_col = func.extract("hour", ist_ts)
    dow_col = func.extract("dow", ist_ts)  # 0=Sunday .. 6=Saturday (Postgres)
    base = _kling_usage_query(db, start_dt, end_exclusive).filter(
        ITPortalToolUsageEvent.event_type == KLING_GENERATION_EVENT
    )

    hour_rows = base.with_entities(hour_col, func.count(ITPortalToolUsageEvent.id)).group_by(hour_col).all()
    hour_map = {int(h): int(c) for h, c in hour_rows if h is not None}
    by_hour = [{"hour": h, "count": hour_map.get(h, 0)} for h in range(24)]

    dow_rows = base.with_entities(dow_col, func.count(ITPortalToolUsageEvent.id)).group_by(dow_col).all()
    dow_names = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
    dow_map = {int(d): int(c) for d, c in dow_rows if d is not None}
    by_day_of_week = [{"day": dow_names[d], "dow": d, "count": dow_map.get(d, 0)} for d in range(7)]

    heat_rows = base.with_entities(dow_col, hour_col, func.count(ITPortalToolUsageEvent.id)).group_by(dow_col, hour_col).all()
    heatmap = [
        {"dow": int(d), "day": dow_names[int(d)], "hour": int(h), "count": int(c)}
        for d, h, c in heat_rows if d is not None and h is not None
    ]

    peak = max(by_hour, key=lambda x: x["count"]) if any(x["count"] for x in by_hour) else None
    peak_day = max(by_day_of_week, key=lambda x: x["count"]) if any(x["count"] for x in by_day_of_week) else None

    return {
        "success": True,
        "timezone": "IST (+05:30)",
        "period": {"start": str(start_dt.date()), "end": str((end_exclusive - timedelta(days=1)).date()), "days": days},
        "byHour": by_hour,
        "byDayOfWeek": by_day_of_week,
        "heatmap": heatmap,
        "peakHour": peak,
        "peakDay": peak_day,
    }


@router.get("/kling/funnel")
def kling_funnel(
    start: Optional[str] = Query(None),
    end: Optional[str] = Query(None),
    db: Session = Depends(get_operational_db),
    current_user: User = Depends(require_faculty),
):
    """Capture funnel and model mix: attempts vs settled generations, and which Kling models are used."""
    start_dt, end_exclusive, _ps, _pe, days = _resolve_period(start, end)
    base = _kling_usage_query(db, start_dt, end_exclusive)

    event_rows = (
        base.with_entities(
            ITPortalToolUsageEvent.event_type,
            ITPortalToolUsageEvent.status,
            func.count(ITPortalToolUsageEvent.id),
        )
        .group_by(ITPortalToolUsageEvent.event_type, ITPortalToolUsageEvent.status)
        .all()
    )
    events = [{"eventType": et or "unknown", "status": st or "unknown", "count": int(c)} for et, st, c in event_rows]

    clicks = sum(e["count"] for e in events if e["eventType"] == "generate_click")
    generations = sum(e["count"] for e in events if e["eventType"] == KLING_GENERATION_EVENT)
    # Generations can exceed captured clicks (re-runs, or clicks the extension missed),
    # so this is reported as a ratio + a click-capture coverage %, not a >100% "conversion".
    generations_per_click = round(generations / clicks, 2) if clicks else None
    click_capture_pct = round(min(clicks / generations, 1.0) * 100.0, 1) if generations else None

    model_rows = (
        base.filter(ITPortalToolUsageEvent.model_label.isnot(None))
        .with_entities(ITPortalToolUsageEvent.model_label, func.count(ITPortalToolUsageEvent.id))
        .group_by(ITPortalToolUsageEvent.model_label)
        .order_by(func.count(ITPortalToolUsageEvent.id).desc())
        .all()
    )
    model_mix = [{"model": m, "count": int(c)} for m, c in model_rows]

    return {
        "success": True,
        "period": {"start": str(start_dt.date()), "end": str((end_exclusive - timedelta(days=1)).date()), "days": days},
        "funnel": {
            "capturedClicks": clicks,
            "generations": generations,
            "generationsPerClick": generations_per_click,
            "clickCapturePct": click_capture_pct,
        },
        "events": events,
        "modelMix": model_mix,
    }


# ---------------------------------------------------------------------------
# ChatGPT Intelligence  (reads the normalized conversation_records table)
# ---------------------------------------------------------------------------
def _conv_query(db: Session, start_dt, end_exclusive, department: Optional[str]):
    q = db.query(ConversationRecord).filter(
        ConversationRecord.archived_at.is_(None),
        ConversationRecord.provider == CHATGPT_PROVIDER,
        ConversationRecord.created_at >= start_dt,
        ConversationRecord.created_at < end_exclusive,
    )
    if department and department != "all":
        q = q.join(User, ConversationRecord.owner_user_id == User.id).filter(User.department == department)
    return q


@router.get("/chatgpt/summary")
def chatgpt_summary(
    start: Optional[str] = Query(None),
    end: Optional[str] = Query(None),
    department: Optional[str] = Query(None),
    db: Session = Depends(get_operational_db),
    current_user: User = Depends(require_faculty),
):
    start_dt, end_exclusive, prev_start, prev_end, days = _resolve_period(start, end)

    def block(s, e):
        base = _conv_query(db, s, e, department)
        conversations = int(base.with_entities(func.count(ConversationRecord.id)).scalar() or 0)
        prompts = int(_conv_query(db, s, e, department).with_entities(func.coalesce(func.sum(ConversationRecord.prompt_count), 0)).scalar() or 0)
        responses = int(_conv_query(db, s, e, department).with_entities(func.coalesce(func.sum(ConversationRecord.response_count), 0)).scalar() or 0)
        users = int(_conv_query(db, s, e, department).with_entities(func.count(func.distinct(ConversationRecord.owner_user_id))).scalar() or 0)
        return {"conversations": conversations, "prompts": prompts, "responses": responses, "users": users}

    cur = block(start_dt, end_exclusive)
    prv = block(prev_start, prev_end)

    avg_cur = round(cur["prompts"] / cur["conversations"], 1) if cur["conversations"] else 0.0
    avg_prv = round(prv["prompts"] / prv["conversations"], 1) if prv["conversations"] else 0.0

    daily_rows = (
        _conv_query(db, start_dt, end_exclusive, department)
        .with_entities(func.date(ConversationRecord.created_at), func.count(ConversationRecord.id))
        .group_by(func.date(ConversationRecord.created_at))
        .order_by(func.date(ConversationRecord.created_at).asc())
        .all()
    )
    series = [{"date": str(d), "value": int(c)} for d, c in daily_rows]

    return {
        "success": True,
        "period": {"start": str(start_dt.date()), "end": str((end_exclusive - timedelta(days=1)).date()), "days": days},
        "kpis": {
            "uniqueUsers": {**_metric(cur["users"], prv["users"]), "series": series},
            "conversations": {**_metric(cur["conversations"], prv["conversations"]), "series": series},
            "prompts": _metric(cur["prompts"], prv["prompts"]),
            "responses": _metric(cur["responses"], prv["responses"]),
            "avgPromptsPerConversation": _metric(avg_cur, avg_prv),
        },
        "messages": {
            "total": cur["prompts"] + cur["responses"],
            "avgPerConversation": round((cur["prompts"] + cur["responses"]) / cur["conversations"], 1) if cur["conversations"] else 0.0,
            "tokensBilled": None,  # ChatGPT billed tokens are not captured by the extension
        },
    }


@router.get("/chatgpt/trends")
def chatgpt_trends(
    start: Optional[str] = Query(None),
    end: Optional[str] = Query(None),
    department: Optional[str] = Query(None),
    db: Session = Depends(get_operational_db),
    current_user: User = Depends(require_faculty),
):
    start_dt, end_exclusive, _ps, _pe, _days = _resolve_period(start, end)

    daily_rows = (
        _conv_query(db, start_dt, end_exclusive, department)
        .with_entities(
            func.date(ConversationRecord.created_at),
            func.count(ConversationRecord.id),
            func.coalesce(func.sum(ConversationRecord.prompt_count), 0),
        )
        .group_by(func.date(ConversationRecord.created_at))
        .order_by(func.date(ConversationRecord.created_at).asc())
        .all()
    )
    daily = [{"date": str(d), "conversations": int(c), "prompts": int(p)} for d, c, p in daily_rows]

    model_label = func.coalesce(
        func.nullif(ConversationRecord.model_label, ""),
        func.nullif(ConversationRecord.gpt_version, ""),
        "Unknown",
    )
    model_rows = (
        _conv_query(db, start_dt, end_exclusive, department)
        .with_entities(model_label, func.count(ConversationRecord.id))
        .group_by(model_label)
        .order_by(func.count(ConversationRecord.id).desc())
        .limit(8)
        .all()
    )
    by_model = [{"model": m or "Unknown", "conversations": int(c)} for m, c in model_rows]

    dept_rows = (
        db.query(User.department, func.count(ConversationRecord.id))
        .join(ConversationRecord, ConversationRecord.owner_user_id == User.id)
        .filter(
            ConversationRecord.archived_at.is_(None),
            ConversationRecord.provider == CHATGPT_PROVIDER,
            ConversationRecord.created_at >= start_dt,
            ConversationRecord.created_at < end_exclusive,
            User.department.isnot(None),
        )
        .group_by(User.department)
        .order_by(func.count(ConversationRecord.id).desc())
        .limit(8)
        .all()
    )
    by_department = [{"department": d or "Unassigned", "conversations": int(c)} for d, c in dept_rows]

    created_rows = (
        _conv_query(db, start_dt, end_exclusive, department)
        .with_entities(ConversationRecord.created_at)
        .all()
    )
    hour_buckets = defaultdict(int)
    for (created_at,) in created_rows:
        if created_at is not None:
            hour_buckets[created_at.hour] += 1
    by_hour = [{"hour": h, "conversations": hour_buckets.get(h, 0)} for h in range(24)]

    return {"success": True, "daily": daily, "byModel": by_model, "byDepartment": by_department, "byHour": by_hour}


@router.get("/chatgpt/users")
def chatgpt_users(
    start: Optional[str] = Query(None),
    end: Optional[str] = Query(None),
    department: Optional[str] = Query(None),
    limit: int = Query(50, ge=1, le=200),
    db: Session = Depends(get_operational_db),
    current_user: User = Depends(require_faculty),
):
    start_dt, end_exclusive, _ps, _pe, _days = _resolve_period(start, end)

    rows = (
        db.query(
            User.id,
            User.name,
            User.avatar,
            User.department,
            func.count(ConversationRecord.id).label("conversations"),
            func.coalesce(func.sum(ConversationRecord.prompt_count), 0).label("prompts"),
            func.max(ConversationRecord.created_at).label("last_active"),
        )
        .join(ConversationRecord, ConversationRecord.owner_user_id == User.id)
        .filter(
            ConversationRecord.archived_at.is_(None),
            ConversationRecord.provider == CHATGPT_PROVIDER,
            ConversationRecord.created_at >= start_dt,
            ConversationRecord.created_at < end_exclusive,
        )
    )
    if department and department != "all":
        rows = rows.filter(User.department == department)
    rows = (
        rows.group_by(User.id, User.name, User.avatar, User.department)
        .order_by(func.count(ConversationRecord.id).desc())
        .limit(limit)
        .all()
    )

    users = []
    for rank, (uid, name, avatar, dept, conversations, prompts, last_active) in enumerate(rows, start=1):
        conversations = int(conversations)
        prompts = int(prompts)
        users.append({
            "rank": rank,
            "userId": uid,
            "name": name or "Unknown",
            "avatar": avatar,
            "department": dept or "Unassigned",
            "conversations": conversations,
            "prompts": prompts,
            "avgDepth": round(prompts / conversations, 1) if conversations else 0.0,
            "lastActive": last_active.isoformat() if last_active else None,
        })

    return {"success": True, "users": users}


# ---------------------------------------------------------------------------
# Cost Intelligence  (credits are the platform's real spend signal)
# ---------------------------------------------------------------------------
@router.get("/cost/summary")
def cost_summary(
    start: Optional[str] = Query(None),
    end: Optional[str] = Query(None),
    department: Optional[str] = Query(None),
    db: Session = Depends(get_operational_db),
    current_user: User = Depends(require_faculty),
):
    start_dt, end_exclusive, prev_start, prev_end, days = _resolve_period(start, end)
    rate_expr, currency, _default_rate = _credit_rate_context(db)

    def block(s, e):
        total_credits = _credits(_gen_query(db, s, e, department))
        total_cost = _cost(_gen_query(db, s, e, department), rate_expr)
        success = _success_count(_gen_query(db, s, e, department))
        success_query = _gen_query(db, s, e, department).filter(
            GenerationRecord.capture_status.in_(SUCCESS_STATUSES)
        )
        success_credits = _credits(success_query)
        success_cost = _cost(success_query, rate_expr)
        return {
            "credits": total_credits,
            "cost": total_cost,
            "success": success,
            "success_credits": success_credits,
            "success_cost": success_cost,
        }

    cur = block(start_dt, end_exclusive)
    prv = block(prev_start, prev_end)

    wasted_cur = max(cur["credits"] - cur["success_credits"], 0.0)
    wasted_prv = max(prv["credits"] - prv["success_credits"], 0.0)
    wasted_cost_cur = max(cur["cost"] - cur["success_cost"], 0.0)
    wasted_cost_prv = max(prv["cost"] - prv["success_cost"], 0.0)
    cpo_cur = round(cur["credits"] / cur["success"], 2) if cur["success"] else 0.0
    cpo_prv = round(prv["credits"] / prv["success"], 2) if prv["success"] else 0.0
    cost_po_cur = round(cur["cost"] / cur["success"], 2) if cur["success"] else 0.0
    cost_po_prv = round(prv["cost"] / prv["success"], 2) if prv["success"] else 0.0
    wasted_pct = round((wasted_cur / cur["credits"]) * 100.0, 1) if cur["credits"] else 0.0

    return {
        "success": True,
        "currency": currency,
        "period": {"start": str(start_dt.date()), "end": str((end_exclusive - timedelta(days=1)).date()), "days": days},
        "kpis": {
            "totalCredits": {**_metric(cur["credits"], prv["credits"]), "unit": "credits"},
            "totalCost": {**_metric(cur["cost"], prv["cost"]), "unit": currency},
            "costPerOutput": {**_metric(cpo_cur, cpo_prv), "unit": "cr/output"},
            "costPerOutputCurrency": {**_metric(cost_po_cur, cost_po_prv), "unit": f"{currency}/output"},
            "wastedCredits": {**_metric(wasted_cur, wasted_prv), "unit": "credits"},
            "wastedCost": {**_metric(wasted_cost_cur, wasted_cost_prv), "unit": currency},
            "roi": _metric(None, None, baseline_required=True),
        },
        "wastedPct": wasted_pct,
        "spend": [
            {"label": "Productive", "credits": round(cur["success_credits"], 2), "cost": round(cur["success_cost"], 2)},
            {"label": "Wasted", "credits": round(wasted_cur, 2), "cost": round(wasted_cost_cur, 2)},
        ],
    }


@router.get("/cost/breakdown")
def cost_breakdown(
    start: Optional[str] = Query(None),
    end: Optional[str] = Query(None),
    department: Optional[str] = Query(None),
    limit: int = Query(50, ge=1, le=200),
    db: Session = Depends(get_operational_db),
    current_user: User = Depends(require_faculty),
):
    start_dt, end_exclusive, _ps, _pe, _days = _resolve_period(start, end)
    rate_expr, currency, _default_rate = _credit_rate_context(db)
    cost_sum = _cost_sum_expr(rate_expr)

    daily_rows = (
        _with_cost_join(_gen_query(db, start_dt, end_exclusive, department))
        .with_entities(
            func.date(GenerationRecord.created_at),
            func.coalesce(func.sum(GenerationRecord.credits_burned), 0),
            cost_sum,
            func.count(GenerationRecord.id),
        )
        .group_by(func.date(GenerationRecord.created_at))
        .order_by(func.date(GenerationRecord.created_at).asc())
        .all()
    )
    daily = [{"date": str(d), "credits": float(cr), "cost": round(float(cost), 2), "generations": int(g)}
             for d, cr, cost, g in daily_rows]

    dept_rows = (
        db.query(
            User.department,
            func.coalesce(func.sum(GenerationRecord.credits_burned), 0),
            cost_sum,
            func.count(GenerationRecord.id),
        )
        .join(GenerationRecord, GenerationRecord.owner_user_id == User.id)
        .outerjoin(ITPortalToolUsageEvent, GenerationRecord.source_usage_event_id == ITPortalToolUsageEvent.id)
        .filter(
            GenerationRecord.archived_at.is_(None),
            GenerationRecord.created_at >= start_dt,
            GenerationRecord.created_at < end_exclusive,
            User.department.isnot(None),
        )
        .group_by(User.department)
        .order_by(func.coalesce(func.sum(GenerationRecord.credits_burned), 0).desc())
        .limit(12)
        .all()
    )
    by_department = [
        {"department": d or "Unassigned", "credits": float(cr), "cost": round(float(cost), 2), "generations": int(g),
         "creditsPerOutput": round(float(cr) / int(g), 2) if g else 0.0,
         "costPerOutput": round(float(cost) / int(g), 2) if g else 0.0}
        for d, cr, cost, g in dept_rows
    ]

    provider_rows = (
        _with_cost_join(_gen_query(db, start_dt, end_exclusive, department))
        .with_entities(
            GenerationRecord.provider,
            func.coalesce(func.sum(GenerationRecord.credits_burned), 0),
            cost_sum,
        )
        .group_by(GenerationRecord.provider)
        .order_by(func.coalesce(func.sum(GenerationRecord.credits_burned), 0).desc())
        .all()
    )
    by_provider = [{"provider": p or "unknown", "credits": float(cr), "cost": round(float(cost), 2)}
                   for p, cr, cost in provider_rows]

    user_rows = (
        db.query(
            User.id, User.name, User.avatar, User.department,
            func.coalesce(func.sum(GenerationRecord.credits_burned), 0).label("credits"),
            cost_sum.label("cost"),
            func.count(GenerationRecord.id).label("generations"),
        )
        .join(GenerationRecord, GenerationRecord.owner_user_id == User.id)
        .outerjoin(ITPortalToolUsageEvent, GenerationRecord.source_usage_event_id == ITPortalToolUsageEvent.id)
        .filter(
            GenerationRecord.archived_at.is_(None),
            GenerationRecord.created_at >= start_dt,
            GenerationRecord.created_at < end_exclusive,
        )
    )
    if department and department != "all":
        user_rows = user_rows.filter(User.department == department)
    user_rows = (
        user_rows.group_by(User.id, User.name, User.avatar, User.department)
        .order_by(func.coalesce(func.sum(GenerationRecord.credits_burned), 0).desc())
        .limit(limit)
        .all()
    )
    top_users = []
    for rank, (uid, name, avatar, dept, credits, cost, generations) in enumerate(user_rows, start=1):
        generations = int(generations)
        top_users.append({
            "rank": rank,
            "userId": uid,
            "name": name or "Unknown",
            "avatar": avatar,
            "department": dept or "Unassigned",
            "credits": float(credits),
            "cost": round(float(cost), 2),
            "generations": generations,
            "creditsPerOutput": round(float(credits) / generations, 2) if generations else 0.0,
            "costPerOutput": round(float(cost) / generations, 2) if generations else 0.0,
        })

    return {
        "success": True,
        "currency": currency,
        "daily": daily,
        "byDepartment": by_department,
        "byProvider": by_provider,
        "topUsers": top_users,
    }


# ---------------------------------------------------------------------------
# User Intelligence  (real presence data from user_activities)
# ---------------------------------------------------------------------------
# A user is "active on a day" when a row exists with a login or heartbeats.
_ACTIVE_ROW = or_(UserActivity.login_time.isnot(None), UserActivity.heartbeat_count > 0)


def _active_users_between(db: Session, d_start, d_end_inclusive, department: Optional[str]) -> int:
    q = (
        db.query(func.count(func.distinct(UserActivity.user_id)))
        .join(User, UserActivity.user_id == User.id)
        .filter(
            User.is_deleted.is_(False),
            UserActivity.date >= d_start,
            UserActivity.date <= d_end_inclusive,
            _ACTIVE_ROW,
        )
    )
    if department and department != "all":
        q = q.filter(User.department == department)
    return int(q.scalar() or 0)


@router.get("/users/summary")
def users_summary(
    start: Optional[str] = Query(None),
    end: Optional[str] = Query(None),
    department: Optional[str] = Query(None),
    db: Session = Depends(get_operational_db),
    current_user: User = Depends(require_faculty),
):
    start_dt, end_exclusive, prev_start, prev_end, days = _resolve_period(start, end)
    d_start = start_dt.date()
    d_end = (end_exclusive - timedelta(days=1)).date()
    p_start = prev_start.date()
    p_end = (prev_end - timedelta(days=1)).date()

    active_cur = _active_users_between(db, d_start, d_end, department)
    active_prv = _active_users_between(db, p_start, p_end, department)

    dau = _active_users_between(db, d_end, d_end, department)
    wau = _active_users_between(db, d_end - timedelta(days=6), d_end, department)
    mau = _active_users_between(db, d_end - timedelta(days=29), d_end, department)

    def avg_session_minutes(a, b):
        q = (
            db.query(func.avg(UserActivity.total_session_duration))
            .join(User, UserActivity.user_id == User.id)
            .filter(User.is_deleted.is_(False), UserActivity.date >= a, UserActivity.date <= b, _ACTIVE_ROW)
        )
        if department and department != "all":
            q = q.filter(User.department == department)
        val = q.scalar() or 0
        return round(float(val) / 60.0, 1)

    avg_cur = avg_session_minutes(d_start, d_end)
    avg_prv = avg_session_minutes(p_start, p_end)

    daily_rows = (
        db.query(UserActivity.date, func.count(func.distinct(UserActivity.user_id)))
        .join(User, UserActivity.user_id == User.id)
        .filter(User.is_deleted.is_(False), UserActivity.date >= d_start, UserActivity.date <= d_end, _ACTIVE_ROW)
    )
    if department and department != "all":
        daily_rows = daily_rows.filter(User.department == department)
    daily_rows = daily_rows.group_by(UserActivity.date).order_by(UserActivity.date.asc()).all()
    series = [{"date": str(d), "value": int(c)} for d, c in daily_rows]

    stickiness = round((dau / mau) * 100.0, 1) if mau else 0.0

    return {
        "success": True,
        "period": {"start": str(d_start), "end": str(d_end), "days": days},
        "kpis": {
            "activeUsers": {**_metric(active_cur, active_prv), "series": series},
            "avgSessionMinutes": {**_metric(avg_cur, avg_prv), "unit": "min"},
        },
        "dau": dau,
        "wau": wau,
        "mau": mau,
        "stickiness": stickiness,
    }


@router.get("/users/activity-trends")
def users_activity_trends(
    start: Optional[str] = Query(None),
    end: Optional[str] = Query(None),
    department: Optional[str] = Query(None),
    db: Session = Depends(get_operational_db),
    current_user: User = Depends(require_faculty),
):
    start_dt, end_exclusive, _ps, _pe, _days = _resolve_period(start, end)
    d_start = start_dt.date()
    d_end = (end_exclusive - timedelta(days=1)).date()

    base = (
        db.query(UserActivity)
        .join(User, UserActivity.user_id == User.id)
        .filter(User.is_deleted.is_(False), UserActivity.date >= d_start, UserActivity.date <= d_end, _ACTIVE_ROW)
    )
    if department and department != "all":
        base = base.filter(User.department == department)

    daily_rows = (
        base.with_entities(
            UserActivity.date,
            func.count(func.distinct(UserActivity.user_id)),
            func.avg(UserActivity.total_session_duration),
        )
        .group_by(UserActivity.date)
        .order_by(UserActivity.date.asc())
        .all()
    )
    daily = [
        {"date": str(d), "activeUsers": int(c), "avgSessionMin": round(float(s or 0) / 60.0, 1)}
        for d, c, s in daily_rows
    ]

    dept_rows = (
        db.query(User.department, func.count(func.distinct(UserActivity.user_id)))
        .join(UserActivity, UserActivity.user_id == User.id)
        .filter(
            User.is_deleted.is_(False),
            User.department.isnot(None),
            UserActivity.date >= d_start,
            UserActivity.date <= d_end,
            _ACTIVE_ROW,
        )
        .group_by(User.department)
        .order_by(func.count(func.distinct(UserActivity.user_id)).desc())
        .limit(12)
        .all()
    )
    by_department = [{"department": d or "Unassigned", "activeUsers": int(c)} for d, c in dept_rows]

    status_rows = (
        db.query(UserActivity.status, func.count(UserActivity.id))
        .filter(UserActivity.date == d_end)
        .group_by(UserActivity.status)
        .all()
    )
    status_mix = [
        {"status": (s.value if hasattr(s, "value") else str(s)) if s else "offline", "count": int(c)}
        for s, c in status_rows
    ]

    return {"success": True, "daily": daily, "byDepartment": by_department, "statusMix": status_mix}


@router.get("/users/retention")
def users_retention(
    weeks: int = Query(8, ge=2, le=16),
    department: Optional[str] = Query(None),
    db: Session = Depends(get_operational_db),
    current_user: User = Depends(require_faculty),
):
    today = date.today()
    lookback_start = today - timedelta(weeks=weeks)

    user_q = db.query(User.id, User.created_at).filter(
        User.is_deleted.is_(False),
        User.created_at.isnot(None),
        User.created_at >= datetime(lookback_start.year, lookback_start.month, lookback_start.day),
    )
    if department and department != "all":
        user_q = user_q.filter(User.department == department)
    users = user_q.limit(5000).all()

    if not users:
        return {"success": True, "cohorts": [], "windows": {"d1": None, "d7": None, "d30": None}, "churnRisk": 0, "maxWeeks": weeks}

    user_ids = [u[0] for u in users]
    signup_by_user = {u[0]: u[1].date() for u in users if u[1]}

    act_rows = (
        db.query(UserActivity.user_id, UserActivity.date)
        .filter(UserActivity.user_id.in_(user_ids), UserActivity.date >= lookback_start, _ACTIVE_ROW)
        .all()
    )
    active_by_user = defaultdict(set)
    for uid, d in act_rows:
        active_by_user[uid].add(d)

    # Weekly cohorts anchored on Monday of signup week.
    cohorts_map = defaultdict(list)
    for uid, signup in signup_by_user.items():
        week_start = signup - timedelta(days=signup.weekday())
        cohorts_map[week_start].append(uid)

    cohorts = []
    for week_start in sorted(cohorts_map.keys()):
        members = cohorts_map[week_start]
        size = len(members)
        week_cells = []
        for w in range(weeks):
            win_start = week_start + timedelta(days=7 * w)
            win_end = win_start + timedelta(days=6)
            if win_start > today:
                week_cells.append({"w": w, "retentionPct": None})
                continue
            retained = sum(
                1 for uid in members
                if any(win_start <= ad <= win_end for ad in active_by_user.get(uid, ()))
            )
            week_cells.append({"w": w, "retentionPct": round((retained / size) * 100.0, 1) if size else 0.0})
        cohorts.append({"cohort": str(week_start), "size": size, "weeks": week_cells})

    # D1 / D7 / D30 windows (active within N days of signup, excluding signup day).
    def window_retention(n):
        eligible = 0
        retained = 0
        for uid, signup in signup_by_user.items():
            if signup + timedelta(days=n) > today:
                continue
            eligible += 1
            days_active = active_by_user.get(uid, ())
            if any(signup + timedelta(days=1) <= ad <= signup + timedelta(days=n) for ad in days_active):
                retained += 1
        return round((retained / eligible) * 100.0, 1) if eligible else None

    windows = {"d1": window_retention(1), "d7": window_retention(7), "d30": window_retention(30)}

    # Churn risk: users whose most recent activity is 15–90 days ago (went quiet).
    last_rows = (
        db.query(UserActivity.user_id, func.max(UserActivity.date))
        .join(User, UserActivity.user_id == User.id)
        .filter(User.is_deleted.is_(False), _ACTIVE_ROW)
    )
    if department and department != "all":
        last_rows = last_rows.filter(User.department == department)
    last_rows = last_rows.group_by(UserActivity.user_id).all()
    churn_risk = sum(1 for _uid, last_d in last_rows if last_d and (today - timedelta(days=90)) <= last_d <= (today - timedelta(days=15)))

    return {"success": True, "cohorts": cohorts, "windows": windows, "churnRisk": churn_risk, "maxWeeks": weeks}


# ---- AI Maturity Score components (all inputs real; formula documented in mapping doc) ----
def _diversity_score(tool_count: int) -> float:
    if tool_count <= 0:
        return 0.0
    return {1: 25.0, 2: 55.0, 3: 80.0}.get(tool_count, 100.0)


def _maturity_level(score: float) -> str:
    if score >= 75:
        return "AI Champion"
    if score >= 50:
        return "Practitioner"
    if score >= 25:
        return "Explorer"
    return "Beginner"


@router.get("/users/power-users")
def users_power_users(
    start: Optional[str] = Query(None),
    end: Optional[str] = Query(None),
    department: Optional[str] = Query(None),
    limit: int = Query(50, ge=1, le=200),
    db: Session = Depends(get_operational_db),
    current_user: User = Depends(require_faculty),
):
    start_dt, end_exclusive, _ps, _pe, days = _resolve_period(start, end)
    d_start = start_dt.date()
    d_end = (end_exclusive - timedelta(days=1)).date()
    period_days = max(days, 1)
    total_weeks = max((period_days + 6) // 7, 1)

    # Candidate pool: users with generation activity in the window.
    gen_rows = (
        db.query(
            User.id, User.name, User.avatar, User.department,
            func.count(GenerationRecord.id).label("gens"),
            func.coalesce(func.sum(GenerationRecord.credits_burned), 0).label("credits"),
            func.count(func.distinct(GenerationRecord.provider)).label("providers"),
        )
        .join(GenerationRecord, GenerationRecord.owner_user_id == User.id)
        .filter(
            User.is_deleted.is_(False),
            GenerationRecord.archived_at.is_(None),
            GenerationRecord.created_at >= start_dt,
            GenerationRecord.created_at < end_exclusive,
        )
    )
    if department and department != "all":
        gen_rows = gen_rows.filter(User.department == department)
    gen_rows = (
        gen_rows.group_by(User.id, User.name, User.avatar, User.department)
        .order_by(func.count(GenerationRecord.id).desc())
        .limit(200)
        .all()
    )
    if not gen_rows:
        return {"success": True, "users": [], "distribution": [], "concentration": {"top10SharePct": 0.0}, "totalGenerations": 0}

    candidate_ids = [r[0] for r in gen_rows]

    # Success counts per candidate.
    success_rows = (
        db.query(GenerationRecord.owner_user_id, func.count(GenerationRecord.id))
        .filter(
            GenerationRecord.owner_user_id.in_(candidate_ids),
            GenerationRecord.archived_at.is_(None),
            GenerationRecord.created_at >= start_dt,
            GenerationRecord.created_at < end_exclusive,
            GenerationRecord.capture_status.in_(SUCCESS_STATUSES),
        )
        .group_by(GenerationRecord.owner_user_id)
        .all()
    )
    success_map = {uid: int(c) for uid, c in success_rows}

    # Active days per candidate (and weeks with activity).
    act_rows = (
        db.query(UserActivity.user_id, UserActivity.date)
        .filter(UserActivity.user_id.in_(candidate_ids), UserActivity.date >= d_start, UserActivity.date <= d_end, _ACTIVE_ROW)
        .all()
    )
    active_days = defaultdict(set)
    active_weeks = defaultdict(set)
    for uid, d in act_rows:
        active_days[uid].add(d)
        active_weeks[uid].add(d.isocalendar()[1])

    # ChatGPT usage per candidate (tool diversity input).
    cg_rows = (
        db.query(ConversationRecord.owner_user_id, func.count(ConversationRecord.id))
        .filter(
            ConversationRecord.owner_user_id.in_(candidate_ids),
            ConversationRecord.archived_at.is_(None),
            ConversationRecord.provider == CHATGPT_PROVIDER,
            ConversationRecord.created_at >= start_dt,
            ConversationRecord.created_at < end_exclusive,
        )
        .group_by(ConversationRecord.owner_user_id)
        .all()
    )
    cg_map = {uid: int(c) for uid, c in cg_rows}

    total_generations = sum(int(r[4]) for r in gen_rows)

    users = []
    for uid, name, avatar, dept, gens, credits, providers in gen_rows:
        gens = int(gens)
        providers = int(providers)
        success = success_map.get(uid, 0)
        adays = len(active_days.get(uid, ()))
        aweeks = len(active_weeks.get(uid, ()))
        tool_count = providers + (1 if cg_map.get(uid, 0) > 0 else 0)

        freq = min(100.0, (adays / period_days) * 100.0)
        volume = min(100.0, (gens ** 0.6) * 8.0)
        diversity = _diversity_score(tool_count)
        success_rate = (success / gens) * 100.0 if gens else 0.0
        consistency = min(100.0, (aweeks / total_weeks) * 100.0)

        score = round(0.25 * freq + 0.20 * volume + 0.15 * diversity + 0.20 * success_rate + 0.20 * consistency, 1)

        users.append({
            "userId": uid,
            "name": name or "Unknown",
            "avatar": avatar,
            "department": dept or "Unassigned",
            "generations": gens,
            "credits": float(credits),
            "activeDays": adays,
            "toolCount": tool_count,
            "successRate": round(success_rate, 1),
            "maturityScore": score,
            "level": _maturity_level(score),
            "components": {
                "frequency": round(freq, 1),
                "volume": round(volume, 1),
                "diversity": round(diversity, 1),
                "success": round(success_rate, 1),
                "consistency": round(consistency, 1),
            },
        })

    users.sort(key=lambda u: u["maturityScore"], reverse=True)
    for rank, u in enumerate(users, start=1):
        u["rank"] = rank

    # Level distribution (across the candidate pool).
    dist_order = ["Beginner", "Explorer", "Practitioner", "AI Champion"]
    dist_counts = defaultdict(int)
    for u in users:
        dist_counts[u["level"]] += 1
    distribution = [{"level": lvl, "count": dist_counts.get(lvl, 0)} for lvl in dist_order]

    # Output concentration: share of generations from the top 10 producers.
    top10 = sorted((u["generations"] for u in users), reverse=True)[:10]
    top10_share = round((sum(top10) / total_generations) * 100.0, 1) if total_generations else 0.0

    return {
        "success": True,
        "users": users[:limit],
        "distribution": distribution,
        "concentration": {"top10SharePct": top10_share},
        "totalGenerations": total_generations,
    }


# ---------------------------------------------------------------------------
# Prompt Intelligence
#   Primary signal: generation_records.prompt_text + capture_status (real
#   prompt -> output success). ChatGPT prompts add volume only (no success).
# ---------------------------------------------------------------------------
PROMPT_MIN_USES = 3
GOLDEN_MIN_SUCCESS = 80.0
GOLDEN_FETCH_CAP = 30000
_SUCCESS_CASE = case((GenerationRecord.capture_status.in_(SUCCESS_STATUSES), 1), else_=0)


def _norm_prompt(text: Optional[str]) -> str:
    if not text:
        return ""
    return " ".join(str(text).lower().split())[:400]


def _gen_prompt_query(db: Session, start_dt, end_exclusive, department: Optional[str]):
    """Generation records that carry a prompt, in-window, non-archived."""
    q = (
        db.query(GenerationRecord)
        .filter(
            GenerationRecord.archived_at.is_(None),
            GenerationRecord.created_at >= start_dt,
            GenerationRecord.created_at < end_exclusive,
            GenerationRecord.prompt_text.isnot(None),
            GenerationRecord.prompt_text != "",
        )
    )
    if department and department != "all":
        q = q.join(User, GenerationRecord.owner_user_id == User.id).filter(User.department == department)
    return q


@router.get("/prompts/summary")
def prompts_summary(
    start: Optional[str] = Query(None),
    end: Optional[str] = Query(None),
    department: Optional[str] = Query(None),
    db: Session = Depends(get_operational_db),
    current_user: User = Depends(require_faculty),
):
    start_dt, end_exclusive, prev_start, prev_end, days = _resolve_period(start, end)
    norm_expr = func.lower(func.trim(GenerationRecord.prompt_text))

    def block(s, e):
        total = int(_gen_prompt_query(db, s, e, department).with_entities(func.count(GenerationRecord.id)).scalar() or 0)
        success = int(
            _gen_prompt_query(db, s, e, department)
            .with_entities(func.count(GenerationRecord.id))
            .filter(GenerationRecord.capture_status.in_(SUCCESS_STATUSES))
            .scalar()
            or 0
        )
        distinct_norm = int(_gen_prompt_query(db, s, e, department).with_entities(func.count(func.distinct(norm_expr))).scalar() or 0)
        return {"total": total, "success": success, "distinct": distinct_norm}

    cur = block(start_dt, end_exclusive)
    prv = block(prev_start, prev_end)

    def success_pct(b):
        return round((b["success"] / b["total"]) * 100.0, 1) if b["total"] else 0.0

    def reuse_pct(b):
        return round((1 - (b["distinct"] / b["total"])) * 100.0, 1) if b["total"] else 0.0

    avg_length = float(
        _gen_prompt_query(db, start_dt, end_exclusive, department)
        .with_entities(func.avg(func.length(GenerationRecord.prompt_text)))
        .scalar()
        or 0
    )

    # ChatGPT prompt volume (no success signal).
    cg_q = (
        db.query(func.count(ConversationPrompt.id))
        .join(ConversationRecord, ConversationPrompt.conversation_id == ConversationRecord.id)
        .filter(
            ConversationRecord.provider == CHATGPT_PROVIDER,
            ConversationRecord.archived_at.is_(None),
            ConversationPrompt.created_at >= start_dt,
            ConversationPrompt.created_at < end_exclusive,
        )
    )
    if department and department != "all":
        cg_q = cg_q.join(User, ConversationRecord.owner_user_id == User.id).filter(User.department == department)
    chatgpt_prompts = int(cg_q.scalar() or 0)

    daily_rows = (
        _gen_prompt_query(db, start_dt, end_exclusive, department)
        .with_entities(func.date(GenerationRecord.created_at), func.count(GenerationRecord.id))
        .group_by(func.date(GenerationRecord.created_at))
        .order_by(func.date(GenerationRecord.created_at).asc())
        .all()
    )
    series = [{"date": str(d), "value": int(c)} for d, c in daily_rows]

    return {
        "success": True,
        "period": {"start": str(start_dt.date()), "end": str((end_exclusive - timedelta(days=1)).date()), "days": days},
        "kpis": {
            "totalPrompts": {**_metric(cur["total"], prv["total"]), "series": series},
            "successfulPct": {**_metric(success_pct(cur), success_pct(prv)), "unit": "%"},
            "reuseRate": {**_metric(reuse_pct(cur), reuse_pct(prv)), "unit": "%"},
            "uniquePrompts": _metric(cur["distinct"], prv["distinct"]),
            "avgLength": {**_metric(round(avg_length, 0), None), "unit": "chars"},
        },
        "chatgptPrompts": chatgpt_prompts,
    }


@router.get("/prompts/trends")
def prompts_trends(
    start: Optional[str] = Query(None),
    end: Optional[str] = Query(None),
    department: Optional[str] = Query(None),
    db: Session = Depends(get_operational_db),
    current_user: User = Depends(require_faculty),
):
    start_dt, end_exclusive, _ps, _pe, _days = _resolve_period(start, end)

    daily_rows = (
        _gen_prompt_query(db, start_dt, end_exclusive, department)
        .with_entities(
            func.date(GenerationRecord.created_at),
            func.count(GenerationRecord.id),
            func.sum(_SUCCESS_CASE),
            func.avg(func.length(GenerationRecord.prompt_text)),
        )
        .group_by(func.date(GenerationRecord.created_at))
        .order_by(func.date(GenerationRecord.created_at).asc())
        .all()
    )
    daily = [
        {
            "date": str(d),
            "prompts": int(c),
            "successRate": round((int(s or 0) / int(c)) * 100.0, 1) if c else 0.0,
            "avgLength": round(float(ln or 0), 0),
        }
        for d, c, s, ln in daily_rows
    ]

    tag_rows = (
        db.query(GenerationTag.normalized_tag, func.count(GenerationTag.id))
        .join(GenerationRecord, GenerationRecord.id == GenerationTag.generation_id)
        .filter(
            GenerationRecord.archived_at.is_(None),
            GenerationRecord.created_at >= start_dt,
            GenerationRecord.created_at < end_exclusive,
        )
        .group_by(GenerationTag.normalized_tag)
        .order_by(func.count(GenerationTag.id).desc())
        .limit(10)
        .all()
    )
    top_themes = [{"theme": t or "untagged", "count": int(c)} for t, c in tag_rows]

    # Build the grouping expression once and reuse the same object, so SELECT and
    # GROUP BY render identical bind params (otherwise Postgres raises GroupingError).
    model_label_expr = func.coalesce(func.nullif(GenerationRecord.model_label, ""), "Unknown")
    model_rows = (
        _gen_prompt_query(db, start_dt, end_exclusive, department)
        .with_entities(
            model_label_expr,
            func.count(GenerationRecord.id),
            func.sum(_SUCCESS_CASE),
        )
        .group_by(model_label_expr)
        .order_by(func.count(GenerationRecord.id).desc())
        .limit(8)
        .all()
    )
    success_by_model = [
        {"model": m or "Unknown", "prompts": int(c), "successRate": round((int(s or 0) / int(c)) * 100.0, 1) if c else 0.0}
        for m, c, s in model_rows
    ]

    return {"success": True, "daily": daily, "topThemes": top_themes, "successByModel": success_by_model}


@router.get("/prompts/golden")
def prompts_golden(
    start: Optional[str] = Query(None),
    end: Optional[str] = Query(None),
    department: Optional[str] = Query(None),
    limit: int = Query(60, ge=1, le=120),
    db: Session = Depends(get_operational_db),
    current_user: User = Depends(require_faculty),
):
    from collections import Counter

    start_dt, end_exclusive, _ps, _pe, _days = _resolve_period(start, end)

    q = (
        db.query(
            GenerationRecord.prompt_text,
            GenerationRecord.capture_status,
            GenerationRecord.owner_user_id,
            GenerationRecord.credits_burned,
            GenerationRecord.model_label,
            User.name,
            User.avatar,
            User.department,
        )
        .join(User, GenerationRecord.owner_user_id == User.id)
        .filter(
            GenerationRecord.archived_at.is_(None),
            GenerationRecord.created_at >= start_dt,
            GenerationRecord.created_at < end_exclusive,
            GenerationRecord.prompt_text.isnot(None),
            GenerationRecord.prompt_text != "",
        )
    )
    if department and department != "all":
        q = q.filter(User.department == department)
    rows = q.order_by(GenerationRecord.created_at.asc()).limit(GOLDEN_FETCH_CAP).all()

    agg = {}
    for prompt_text, status, owner_id, credits, model_label, name, avatar, dept in rows:
        norm = _norm_prompt(prompt_text)
        if not norm:
            continue
        a = agg.get(norm)
        if a is None:
            a = {
                "uses": 0, "success": 0, "owners": set(), "credits": 0.0,
                "creator": {"name": name or "Unknown", "avatar": avatar, "userId": owner_id},
                "model": model_label, "depts": Counter(), "sample": (prompt_text or "")[:280],
            }
            agg[norm] = a
        a["uses"] += 1
        if status in SUCCESS_STATUSES:
            a["success"] += 1
        a["owners"].add(owner_id)
        a["credits"] += float(credits or 0)
        a["depts"][dept or "Unassigned"] += 1

    total_unique = len(agg)
    total_rows = len(rows)
    reuse_rate = round((1 - (total_unique / total_rows)) * 100.0, 1) if total_rows else 0.0

    golden = []
    for norm, a in agg.items():
        if a["uses"] < PROMPT_MIN_USES:
            continue
        success_rate = round((a["success"] / a["uses"]) * 100.0, 1)
        if success_rate < GOLDEN_MIN_SUCCESS:
            continue
        top_dept = a["depts"].most_common(1)[0][0] if a["depts"] else "Unassigned"
        golden.append({
            "prompt": a["sample"],
            "uses": a["uses"],
            "successRate": success_rate,
            "uniqueUsers": len(a["owners"]),
            "credits": round(a["credits"], 2),
            "creator": a["creator"],
            "category": a["model"] or "General",
            "recommendedFor": top_dept,
            "rankScore": round(a["uses"] * success_rate, 1),
        })

    golden.sort(key=lambda g: g["rankScore"], reverse=True)
    golden = golden[:limit]
    for i, g in enumerate(golden, start=1):
        g["id"] = i

    return {
        "success": True,
        "golden": golden,
        "stats": {"uniquePrompts": total_unique, "goldenCount": len(golden), "reuseRate": reuse_rate, "scanned": total_rows},
    }


@router.get("/prompts/engineers")
def prompts_engineers(
    start: Optional[str] = Query(None),
    end: Optional[str] = Query(None),
    department: Optional[str] = Query(None),
    limit: int = Query(50, ge=1, le=200),
    db: Session = Depends(get_operational_db),
    current_user: User = Depends(require_faculty),
):
    start_dt, end_exclusive, _ps, _pe, _days = _resolve_period(start, end)
    norm_expr = func.lower(func.trim(GenerationRecord.prompt_text))

    rows = (
        db.query(
            User.id, User.name, User.avatar, User.department,
            func.count(GenerationRecord.id).label("prompts"),
            func.sum(_SUCCESS_CASE).label("successes"),
            func.count(func.distinct(norm_expr)).label("unique_prompts"),
            func.coalesce(func.sum(GenerationRecord.credits_burned), 0).label("credits"),
        )
        .join(GenerationRecord, GenerationRecord.owner_user_id == User.id)
        .filter(
            User.is_deleted.is_(False),
            GenerationRecord.archived_at.is_(None),
            GenerationRecord.created_at >= start_dt,
            GenerationRecord.created_at < end_exclusive,
            GenerationRecord.prompt_text.isnot(None),
            GenerationRecord.prompt_text != "",
        )
    )
    if department and department != "all":
        rows = rows.filter(User.department == department)
    rows = (
        rows.group_by(User.id, User.name, User.avatar, User.department)
        .order_by(func.count(GenerationRecord.id).desc())
        .limit(200)
        .all()
    )

    engineers = []
    for uid, name, avatar, dept, prompts, successes, unique_prompts, credits in rows:
        prompts = int(prompts)
        successes = int(successes or 0)
        unique_prompts = int(unique_prompts or 0)
        success_rate = (successes / prompts) * 100.0 if prompts else 0.0
        volume = min(100.0, (prompts ** 0.6) * 8.0)
        uniqueness = (unique_prompts / prompts) * 100.0 if prompts else 0.0
        score = round(0.5 * success_rate + 0.3 * volume + 0.2 * uniqueness, 1)
        engineers.append({
            "userId": uid,
            "name": name or "Unknown",
            "avatar": avatar,
            "department": dept or "Unassigned",
            "prompts": prompts,
            "uniquePrompts": unique_prompts,
            "successRate": round(success_rate, 1),
            "uniquenessPct": round(uniqueness, 1),
            "credits": float(credits),
            "performanceScore": score,
            "topEngineer": score >= 75,
        })

    engineers.sort(key=lambda e: e["performanceScore"], reverse=True)
    for rank, e in enumerate(engineers, start=1):
        e["rank"] = rank

    return {"success": True, "engineers": engineers[:limit]}


# ---------------------------------------------------------------------------
# Task Intelligence
#   Task lifecycle is fully real. There is NO task<->AI foreign key, so AI value
#   is measured as a user-level cohort *correlation* (labelled), never per-task.
# ---------------------------------------------------------------------------
TASK_FAILED = (TaskStatus.REJECTED, TaskStatus.CANCELLED)
TASK_OPEN_EXCLUDE = (TaskStatus.COMPLETED, TaskStatus.REJECTED, TaskStatus.CANCELLED)
TASK_FETCH_CAP = 50000


def _enum_val(v):
    return v.value if hasattr(v, "value") else (str(v) if v is not None else "unknown")


def _hours_between(a, b):
    if not a or not b:
        return None
    return (b - a).total_seconds() / 3600.0


def _task_dept(q, department):
    if department and department != "all":
        return q.filter(Task.to_department == department)
    return q


@router.get("/tasks/summary")
def tasks_summary(
    start: Optional[str] = Query(None),
    end: Optional[str] = Query(None),
    department: Optional[str] = Query(None),
    db: Session = Depends(get_operational_db),
    current_user: User = Depends(require_faculty),
):
    start_dt, end_exclusive, prev_start, prev_end, days = _resolve_period(start, end)

    def created_count(s, e):
        q = db.query(func.count(Task.id)).filter(Task.is_deleted.is_(False), Task.created_at >= s, Task.created_at < e)
        return int(_task_dept(q, department).scalar() or 0)

    def completed_count(s, e):
        q = db.query(func.count(Task.id)).filter(
            Task.is_deleted.is_(False), Task.status == TaskStatus.COMPLETED,
            Task.completed_at.isnot(None), Task.completed_at >= s, Task.completed_at < e,
        )
        return int(_task_dept(q, department).scalar() or 0)

    created_cur, created_prv = created_count(start_dt, end_exclusive), created_count(prev_start, prev_end)
    completed_cur, completed_prv = completed_count(start_dt, end_exclusive), completed_count(prev_start, prev_end)

    comp_rate_cur = round((completed_cur / created_cur) * 100.0, 1) if created_cur else 0.0
    comp_rate_prv = round((completed_prv / created_prv) * 100.0, 1) if created_prv else 0.0

    # Cycle time + on-time from completed-in-range tasks (bounded fetch).
    comp_q = db.query(Task.created_at, Task.completed_at, Task.deadline).filter(
        Task.is_deleted.is_(False), Task.status == TaskStatus.COMPLETED,
        Task.completed_at.isnot(None), Task.completed_at >= start_dt, Task.completed_at < end_exclusive,
    )
    comp_rows = _task_dept(comp_q, department).limit(TASK_FETCH_CAP).all()
    cycle_hours = [h for h in (_hours_between(c, d) for c, d, _dl in comp_rows) if h is not None and h >= 0]
    avg_cycle = round(sum(cycle_hours) / len(cycle_hours), 1) if cycle_hours else 0.0
    with_deadline = [(d, dl) for _c, d, dl in comp_rows if dl is not None]
    on_time = sum(1 for d, dl in with_deadline if d and dl and d <= dl)
    on_time_rate = round((on_time / len(with_deadline)) * 100.0, 1) if with_deadline else 0.0

    # Estimation accuracy: actual / estimated where both present.
    est_q = db.query(func.avg(Task.actual_hours * 1.0 / Task.estimated_hours)).filter(
        Task.is_deleted.is_(False), Task.estimated_hours.isnot(None), Task.estimated_hours > 0,
        Task.actual_hours.isnot(None), Task.completed_at >= start_dt, Task.completed_at < end_exclusive,
    )
    est_ratio = _task_dept(est_q, department).scalar()
    est_accuracy = round(float(est_ratio) * 100.0, 1) if est_ratio else None

    completed_daily = (
        _task_dept(
            db.query(func.date(Task.completed_at), func.count(Task.id)).filter(
                Task.is_deleted.is_(False), Task.status == TaskStatus.COMPLETED,
                Task.completed_at.isnot(None), Task.completed_at >= start_dt, Task.completed_at < end_exclusive,
            ), department,
        )
        .group_by(func.date(Task.completed_at)).order_by(func.date(Task.completed_at).asc()).all()
    )
    series = [{"date": str(d), "value": int(c)} for d, c in completed_daily]

    return {
        "success": True,
        "period": {"start": str(start_dt.date()), "end": str((end_exclusive - timedelta(days=1)).date()), "days": days},
        "kpis": {
            "tasksCompleted": {**_metric(completed_cur, completed_prv), "series": series},
            "completionRate": {**_metric(comp_rate_cur, comp_rate_prv), "unit": "%"},
            "avgCycleHours": {**_metric(avg_cycle, None), "unit": "h"},
            "onTimeRate": {**_metric(on_time_rate, None), "unit": "%"},
            "estimationAccuracy": ({**_metric(est_accuracy, None), "unit": "%"} if est_accuracy is not None else _metric(None, None, baseline_required=True)),
        },
        "tasksCreated": created_cur,
    }


@router.get("/tasks/trends")
def tasks_trends(
    start: Optional[str] = Query(None),
    end: Optional[str] = Query(None),
    department: Optional[str] = Query(None),
    db: Session = Depends(get_operational_db),
    current_user: User = Depends(require_faculty),
):
    start_dt, end_exclusive, _ps, _pe, _days = _resolve_period(start, end)

    created_daily = dict(
        _task_dept(
            db.query(func.date(Task.created_at), func.count(Task.id)).filter(
                Task.is_deleted.is_(False), Task.created_at >= start_dt, Task.created_at < end_exclusive,
            ), department,
        ).group_by(func.date(Task.created_at)).all()
    )
    completed_daily = dict(
        _task_dept(
            db.query(func.date(Task.completed_at), func.count(Task.id)).filter(
                Task.is_deleted.is_(False), Task.status == TaskStatus.COMPLETED,
                Task.completed_at.isnot(None), Task.completed_at >= start_dt, Task.completed_at < end_exclusive,
            ), department,
        ).group_by(func.date(Task.completed_at)).all()
    )
    all_days = sorted(set(list(created_daily.keys()) + list(completed_daily.keys())))
    daily = [{"date": str(d), "created": int(created_daily.get(d, 0)), "completed": int(completed_daily.get(d, 0))} for d in all_days]

    # By department: created + completed.
    dept_created = dict(
        db.query(Task.to_department, func.count(Task.id)).filter(
            Task.is_deleted.is_(False), Task.to_department.isnot(None),
            Task.created_at >= start_dt, Task.created_at < end_exclusive,
        ).group_by(Task.to_department).all()
    )
    dept_completed = dict(
        db.query(Task.to_department, func.count(Task.id)).filter(
            Task.is_deleted.is_(False), Task.to_department.isnot(None), Task.status == TaskStatus.COMPLETED,
            Task.completed_at >= start_dt, Task.completed_at < end_exclusive,
        ).group_by(Task.to_department).all()
    )
    by_department = sorted(
        [
            {"department": d or "Unassigned", "created": int(dept_created.get(d, 0)), "completed": int(c),
             "completionRate": round((int(c) / int(dept_created.get(d, 0))) * 100.0, 1) if dept_created.get(d) else 0.0}
            for d, c in dept_completed.items()
        ],
        key=lambda x: x["completed"], reverse=True,
    )[:10]

    # By priority.
    pri_rows = _task_dept(
        db.query(
            Task.priority,
            func.count(Task.id),
            func.sum(case((Task.status == TaskStatus.COMPLETED, 1), else_=0)),
        ).filter(Task.is_deleted.is_(False), Task.created_at >= start_dt, Task.created_at < end_exclusive),
        department,
    ).group_by(Task.priority).all()
    by_priority = [
        {"priority": _enum_val(p), "created": int(c), "completed": int(done or 0),
         "completionRate": round((int(done or 0) / int(c)) * 100.0, 1) if c else 0.0}
        for p, c, done in pri_rows
    ]

    # Status distribution (of tasks created in range).
    status_rows = _task_dept(
        db.query(Task.status, func.count(Task.id)).filter(
            Task.is_deleted.is_(False), Task.created_at >= start_dt, Task.created_at < end_exclusive,
        ), department,
    ).group_by(Task.status).all()
    status_distribution = [{"status": _enum_val(s), "count": int(c)} for s, c in status_rows]

    return {"success": True, "daily": daily, "byDepartment": by_department, "byPriority": by_priority, "statusDistribution": status_distribution}


@router.get("/tasks/bottlenecks")
def tasks_bottlenecks(
    start: Optional[str] = Query(None),
    end: Optional[str] = Query(None),
    department: Optional[str] = Query(None),
    db: Session = Depends(get_operational_db),
    current_user: User = Depends(require_faculty),
):
    start_dt, end_exclusive, _ps, _pe, _days = _resolve_period(start, end)
    now = datetime.utcnow()

    # Aging backlog: open tasks bucketed by age.
    open_q = db.query(Task.created_at).filter(
        Task.is_deleted.is_(False), Task.status.notin_(TASK_OPEN_EXCLUDE),
    )
    open_rows = _task_dept(open_q, department).limit(TASK_FETCH_CAP).all()
    buckets = {"0-1d": 0, "1-3d": 0, "3-7d": 0, "7-14d": 0, "14d+": 0}
    for (created,) in open_rows:
        if not created:
            continue
        age = (now - created).total_seconds() / 86400.0
        if age <= 1:
            buckets["0-1d"] += 1
        elif age <= 3:
            buckets["1-3d"] += 1
        elif age <= 7:
            buckets["3-7d"] += 1
        elif age <= 14:
            buckets["7-14d"] += 1
        else:
            buckets["14d+"] += 1
    aging_backlog = [{"bucket": k, "count": v} for k, v in buckets.items()]
    open_total = len(open_rows)

    # Overdue open tasks.
    overdue_q = db.query(func.count(Task.id)).filter(
        Task.is_deleted.is_(False), Task.status.notin_(TASK_OPEN_EXCLUDE),
        Task.deadline.isnot(None), Task.deadline < now,
    )
    overdue = int(_task_dept(overdue_q, department).scalar() or 0)

    # Dwell time by status (from status history within window).
    hist_rows = (
        db.query(TaskStatusHistory.task_id, TaskStatusHistory.status_to, TaskStatusHistory.timestamp)
        .filter(TaskStatusHistory.timestamp >= start_dt)
        .order_by(TaskStatusHistory.task_id.asc(), TaskStatusHistory.timestamp.asc())
        .limit(TASK_FETCH_CAP)
        .all()
    )
    dwell_sums = defaultdict(float)
    dwell_counts = defaultdict(int)
    prev_task = None
    prev_status = None
    prev_ts = None
    for task_id, status_to, ts in hist_rows:
        if task_id == prev_task and prev_ts is not None and ts is not None:
            hours = (ts - prev_ts).total_seconds() / 3600.0
            if hours >= 0:
                dwell_sums[_enum_val(prev_status)] += hours
                dwell_counts[_enum_val(prev_status)] += 1
        prev_task, prev_status, prev_ts = task_id, status_to, ts
    dwell_by_status = sorted(
        [{"status": s, "avgHours": round(dwell_sums[s] / dwell_counts[s], 1), "transitions": dwell_counts[s]} for s in dwell_counts],
        key=lambda x: x["avgHours"], reverse=True,
    )[:10]

    # Slowest task types (avg cycle among completed in range).
    comp_q = db.query(Task.task_type, Task.created_at, Task.completed_at).filter(
        Task.is_deleted.is_(False), Task.status == TaskStatus.COMPLETED,
        Task.completed_at.isnot(None), Task.completed_at >= start_dt, Task.completed_at < end_exclusive,
    )
    comp_rows = _task_dept(comp_q, department).limit(TASK_FETCH_CAP).all()
    type_sums = defaultdict(float)
    type_counts = defaultdict(int)
    for ttype, c, done in comp_rows:
        h = _hours_between(c, done)
        if h is not None and h >= 0:
            key = ttype or "task"
            type_sums[key] += h
            type_counts[key] += 1
    slowest_types = sorted(
        [{"type": t, "avgCycleHours": round(type_sums[t] / type_counts[t], 1), "count": type_counts[t]} for t in type_counts],
        key=lambda x: x["avgCycleHours"], reverse=True,
    )[:8]

    # Rework / rejection rate.
    created_total = int(_task_dept(
        db.query(func.count(Task.id)).filter(Task.is_deleted.is_(False), Task.created_at >= start_dt, Task.created_at < end_exclusive),
        department,
    ).scalar() or 0)
    rework = int(_task_dept(
        db.query(func.count(Task.id)).filter(
            Task.is_deleted.is_(False), Task.created_at >= start_dt, Task.created_at < end_exclusive,
            Task.status.in_((TaskStatus.NEED_IMPROVEMENT, TaskStatus.REJECTED)),
        ),
        department,
    ).scalar() or 0)
    rework_rate = round((rework / created_total) * 100.0, 1) if created_total else 0.0

    return {
        "success": True,
        "agingBacklog": aging_backlog,
        "openTotal": open_total,
        "overdue": overdue,
        "dwellByStatus": dwell_by_status,
        "slowestTypes": slowest_types,
        "reworkRate": rework_rate,
    }


@router.get("/tasks/ai-impact")
def tasks_ai_impact(
    start: Optional[str] = Query(None),
    end: Optional[str] = Query(None),
    department: Optional[str] = Query(None),
    db: Session = Depends(get_operational_db),
    current_user: User = Depends(require_faculty),
):
    """User-level correlation between AI usage and task productivity. NOT causal, NOT per-task."""
    start_dt, end_exclusive, _ps, _pe, days = _resolve_period(start, end)

    # AI-active users = owned a generation or a ChatGPT conversation in the window.
    gen_owner_rows = (
        db.query(func.distinct(GenerationRecord.owner_user_id))
        .filter(GenerationRecord.archived_at.is_(None), GenerationRecord.owner_user_id.isnot(None),
                GenerationRecord.created_at >= start_dt, GenerationRecord.created_at < end_exclusive)
        .all()
    )
    cg_owner_rows = (
        db.query(func.distinct(ConversationRecord.owner_user_id))
        .filter(ConversationRecord.archived_at.is_(None), ConversationRecord.owner_user_id.isnot(None),
                ConversationRecord.provider == CHATGPT_PROVIDER,
                ConversationRecord.created_at >= start_dt, ConversationRecord.created_at < end_exclusive)
        .all()
    )
    ai_users = {r[0] for r in gen_owner_rows} | {r[0] for r in cg_owner_rows}

    # Tasks created in window, attributed to creator.
    task_q = db.query(Task.creator_id, Task.to_department, Task.status, Task.created_at, Task.completed_at).filter(
        Task.is_deleted.is_(False), Task.creator_id.isnot(None),
        Task.created_at >= start_dt, Task.created_at < end_exclusive,
    )
    task_rows = _task_dept(task_q, department).limit(TASK_FETCH_CAP).all()

    def new_cohort():
        return {"users": set(), "tasks": 0, "completed": 0, "cycle_hours": []}

    cohorts = {"ai": new_cohort(), "non": new_cohort()}
    dept_stats = defaultdict(lambda: {"ai_users": set(), "users": set(), "completed": 0})

    for creator_id, dept, status, created, completed in task_rows:
        key = "ai" if creator_id in ai_users else "non"
        c = cohorts[key]
        c["users"].add(creator_id)
        c["tasks"] += 1
        is_done = status == TaskStatus.COMPLETED
        if is_done:
            c["completed"] += 1
            h = _hours_between(created, completed)
            if h is not None and h >= 0:
                c["cycle_hours"].append(h)
        d = dept_stats[dept or "Unassigned"]
        d["users"].add(creator_id)
        if creator_id in ai_users:
            d["ai_users"].add(creator_id)
        if is_done:
            d["completed"] += 1

    def summarize(c):
        n = len(c["users"])
        return {
            "users": n,
            "tasks": c["tasks"],
            "completed": c["completed"],
            "completedPerUser": round(c["completed"] / n, 2) if n else 0.0,
            "completionRate": round((c["completed"] / c["tasks"]) * 100.0, 1) if c["tasks"] else 0.0,
            "avgCycleHours": round(sum(c["cycle_hours"]) / len(c["cycle_hours"]), 1) if c["cycle_hours"] else 0.0,
        }

    ai_s = summarize(cohorts["ai"])
    non_s = summarize(cohorts["non"])

    def delta_pct(a, b):
        if not b:
            return None
        return round(((a - b) / b) * 100.0, 1)

    throughput_delta = delta_pct(ai_s["completedPerUser"], non_s["completedPerUser"])
    # For cycle time, lower is better — express as % faster.
    cycle_delta = None
    if non_s["avgCycleHours"] and ai_s["avgCycleHours"]:
        cycle_delta = round(((non_s["avgCycleHours"] - ai_s["avgCycleHours"]) / non_s["avgCycleHours"]) * 100.0, 1)

    dept_scatter = []
    for dept, d in dept_stats.items():
        n = len(d["users"])
        if n < 1:
            continue
        dept_scatter.append({
            "department": dept,
            "aiAdoptionPct": round((len(d["ai_users"]) / n) * 100.0, 1),
            "completedPerUser": round(d["completed"] / n, 2),
            "users": n,
        })
    dept_scatter.sort(key=lambda x: x["users"], reverse=True)

    return {
        "success": True,
        "period": {"days": days},
        "cohorts": {"aiActive": ai_s, "nonAI": non_s},
        "deltas": {"throughputPct": throughput_delta, "cycleFasterPct": cycle_delta},
        "departmentScatter": dept_scatter[:20],
        "caveat": "User-level correlation, not causation. No task-to-AI link exists; attribution is by task creator.",
    }


# ---------------------------------------------------------------------------
# AI Recommendations
#   A transparent, rules-based engine over the real aggregates. Every card
#   carries evidence + a heuristic confidence (data volume x effect size).
#   No causation is claimed; acceptance/outcome tracking is future architecture.
# ---------------------------------------------------------------------------
def _confidence(sample_size: float, effect: float):
    effect = max(0.0, min(1.0, effect))
    volume = min(45.0, 15.0 * math.log10(max(sample_size, 0) + 1))
    eff = min(45.0, effect * 45.0)
    score = int(max(0, min(99, round(10 + volume + eff))))
    band = "High" if score >= 75 else "Medium" if score >= 50 else "Low"
    return score, band


def _rec(rid, rtype, title, action, reason, evidence, impact, sample, effect, targets, priority=2):
    conf, band = _confidence(sample, effect)
    return {
        "id": rid, "type": rtype, "title": title, "action": action,
        "reason": reason, "evidence": evidence, "expectedImpact": impact,
        "confidence": conf, "confidenceBand": band, "targets": targets, "priority": priority,
    }


@router.get("/recommendations")
def recommendations(
    start: Optional[str] = Query(None),
    end: Optional[str] = Query(None),
    department: Optional[str] = Query(None),
    type: Optional[str] = Query(None),
    db: Session = Depends(get_operational_db),
    current_user: User = Depends(require_faculty),
):
    start_dt, end_exclusive, _ps, _pe, days = _resolve_period(start, end)
    period_days = max(days, 1)
    total_weeks = max((period_days + 6) // 7, 1)
    recs = []

    # ---- Cost + Tool: per-provider efficiency ----
    prov_rows = (
        _gen_query(db, start_dt, end_exclusive, department)
        .with_entities(
            GenerationRecord.provider,
            func.count(GenerationRecord.id),
            func.sum(_SUCCESS_CASE),
            func.coalesce(func.sum(GenerationRecord.credits_burned), 0),
        )
        .group_by(GenerationRecord.provider)
        .all()
    )
    tools = []
    total_credits = 0.0
    total_success_credits = 0.0
    for prov, cnt, succ, cred in prov_rows:
        cnt = int(cnt); succ = int(succ or 0); cred = float(cred or 0)
        total_credits += cred
        sr = round((succ / cnt) * 100.0, 1) if cnt else 0.0
        cpo = round(cred / succ, 2) if succ else 0.0
        tools.append({"tool": prov or "unknown", "gens": cnt, "successRate": sr, "costPerOutput": cpo})
    tools.sort(key=lambda t: t["gens"], reverse=True)

    if len(tools) >= 2:
        # best value = high success, low cost/output (min cost among those with decent success & volume)
        eligible = [t for t in tools if t["gens"] >= 10]
        if eligible:
            best = min(eligible, key=lambda t: (t["costPerOutput"] if t["costPerOutput"] else 1e9, -t["successRate"]))
            worst = max(eligible, key=lambda t: (t["costPerOutput"] if t["costPerOutput"] else 0, -t["successRate"]))
            if best["tool"] != worst["tool"] and worst["costPerOutput"] > best["costPerOutput"] * 1.3:
                gap = (worst["costPerOutput"] - best["costPerOutput"]) / worst["costPerOutput"] if worst["costPerOutput"] else 0
                recs.append(_rec(
                    "tool-standardise", "Tool",
                    f"Route more routine work to {best['tool'].title()}",
                    f"Standardise routine generations on {best['tool'].title()} where suitable.",
                    [
                        f"{best['tool'].title()}: {best['successRate']}% success at {best['costPerOutput']} credits/output",
                        f"{worst['tool'].title()}: {worst['successRate']}% success at {worst['costPerOutput']} credits/output",
                    ],
                    {"bestTool": best["tool"], "bestCostPerOutput": best["costPerOutput"], "worstTool": worst["tool"], "worstCostPerOutput": worst["costPerOutput"]},
                    "Medium", best["gens"], gap, "All AI users", priority=2,
                ))

    # ---- Cost: wasted-credit reliability ----
    success_credits = float(
        _gen_query(db, start_dt, end_exclusive, department)
        .with_entities(func.coalesce(func.sum(GenerationRecord.credits_burned), 0))
        .filter(GenerationRecord.capture_status.in_(SUCCESS_STATUSES))
        .scalar() or 0
    )
    wasted = max(total_credits - success_credits, 0.0)
    wasted_pct = (wasted / total_credits) if total_credits else 0.0
    gens_total = _count(_gen_query(db, start_dt, end_exclusive, department))
    if total_credits > 0 and wasted_pct > 0.10:
        recs.append(_rec(
            "cost-waste", "Cost",
            f"Recover {round(wasted_pct * 100, 1)}% of AI spend lost to failed generations",
            "Prioritise reliability fixes on the highest-failure workflows and models.",
            [
                f"{round(wasted, 0):.0f} credits ({round(wasted_pct * 100, 1)}%) were spent on generations that did not succeed",
                f"Total spend in period: {round(total_credits, 0):.0f} credits",
            ],
            {"wastedCredits": round(wasted, 2), "wastedPct": round(wasted_pct * 100, 1), "totalCredits": round(total_credits, 2)},
            "High", gens_total, wasted_pct, "Platform / tool owners", priority=1,
        ))

    # ---- Model routing (success by model) ----
    # Same object in SELECT and GROUP BY to avoid Postgres GroupingError.
    model_label_expr = func.coalesce(func.nullif(GenerationRecord.model_label, ""), "Unknown")
    model_rows = (
        _gen_prompt_query(db, start_dt, end_exclusive, department)
        .with_entities(
            model_label_expr,
            func.count(GenerationRecord.id),
            func.sum(_SUCCESS_CASE),
        )
        .group_by(model_label_expr)
        .all()
    )
    models = [
        {"model": m, "gens": int(c), "successRate": round((int(s or 0) / int(c)) * 100.0, 1) if c else 0.0}
        for m, c, s in model_rows if int(c) >= 10 and m and m != "Unknown"
    ]
    if len(models) >= 2:
        best_m = max(models, key=lambda x: x["successRate"])
        worst_m = min(models, key=lambda x: x["successRate"])
        if best_m["model"] != worst_m["model"] and (best_m["successRate"] - worst_m["successRate"]) >= 10:
            eff = (best_m["successRate"] - worst_m["successRate"]) / 100.0
            recs.append(_rec(
                "model-routing", "Tool",
                f"Prefer {best_m['model']} for higher success",
                f"Guide users toward {best_m['model']} where the use case fits.",
                [
                    f"{best_m['model']}: {best_m['successRate']}% success ({best_m['gens']} prompts)",
                    f"{worst_m['model']}: {worst_m['successRate']}% success ({worst_m['gens']} prompts)",
                ],
                {"bestModel": best_m["model"], "bestSuccess": best_m["successRate"], "worstModel": worst_m["model"], "worstSuccess": worst_m["successRate"]},
                "Medium", best_m["gens"], eff, "All AI users", priority=3,
            ))

    # ---- Golden prompt promotion (compact) ----
    g_q = (
        db.query(GenerationRecord.prompt_text, GenerationRecord.capture_status, GenerationRecord.owner_user_id, User.department)
        .join(User, GenerationRecord.owner_user_id == User.id)
        .filter(
            GenerationRecord.archived_at.is_(None), GenerationRecord.created_at >= start_dt,
            GenerationRecord.created_at < end_exclusive,
            GenerationRecord.prompt_text.isnot(None), GenerationRecord.prompt_text != "",
        )
    )
    if department and department != "all":
        g_q = g_q.filter(User.department == department)
    g_rows = g_q.order_by(GenerationRecord.created_at.asc()).limit(12000).all()
    g_agg = {}
    for ptext, status, owner, dept in g_rows:
        norm = _norm_prompt(ptext)
        if not norm:
            continue
        a = g_agg.get(norm)
        if a is None:
            a = {"uses": 0, "success": 0, "depts": Counter(), "sample": (ptext or "")[:200]}
            g_agg[norm] = a
        a["uses"] += 1
        if status in SUCCESS_STATUSES:
            a["success"] += 1
        a["depts"][dept or "Unassigned"] += 1
    golden = []
    for a in g_agg.values():
        if a["uses"] >= 3 and (a["success"] / a["uses"]) >= 0.8:
            golden.append({"uses": a["uses"], "successRate": round(a["success"] / a["uses"] * 100.0, 1),
                           "dept": a["depts"].most_common(1)[0][0], "sample": a["sample"]})
    golden.sort(key=lambda x: x["uses"] * x["successRate"], reverse=True)
    for i, g in enumerate(golden[:2], start=1):
        recs.append(_rec(
            f"prompt-golden-{i}", "Prompt",
            f"Promote a proven prompt to {g['dept']}",
            "Publish this golden prompt to the shared library and route the team to it.",
            [
                f"{g['successRate']}% success across {g['uses']} uses",
                f"Most used by {g['dept']}",
                f"Prompt: \"{g['sample'][:120]}{'…' if len(g['sample']) > 120 else ''}\"",
            ],
            {"uses": g["uses"], "successRate": g["successRate"], "topDepartment": g["dept"]},
            "Medium", g["uses"], g["successRate"] / 100.0, g["dept"], priority=2,
        ))

    # ---- Department adoption gap ----
    head_rows = (
        db.query(User.department, func.count(User.id))
        .filter(User.is_deleted.is_(False), User.department.isnot(None), User.department != "")
        .group_by(User.department).all()
    )
    headcount = {d: int(c) for d, c in head_rows}
    ai_dept_rows = (
        db.query(User.department, func.count(func.distinct(User.id)))
        .join(GenerationRecord, GenerationRecord.owner_user_id == User.id)
        .filter(User.is_deleted.is_(False), User.department.isnot(None),
                GenerationRecord.archived_at.is_(None),
                GenerationRecord.created_at >= start_dt, GenerationRecord.created_at < end_exclusive)
        .group_by(User.department).all()
    )
    ai_by_dept = {d: int(c) for d, c in ai_dept_rows}
    total_head = sum(headcount.values())
    total_ai = sum(ai_by_dept.get(d, 0) for d in headcount)
    org_avg = (total_ai / total_head) if total_head else 0.0
    dept_gaps = []
    for d, hc in headcount.items():
        if hc < 3:
            continue
        adopt = ai_by_dept.get(d, 0) / hc
        if org_avg > 0 and adopt < org_avg * 0.6:
            dept_gaps.append({"dept": d, "adoptPct": round(adopt * 100, 1), "headcount": hc, "gap": (org_avg - adopt) / org_avg})
    dept_gaps.sort(key=lambda x: x["gap"], reverse=True)
    for i, dg in enumerate(dept_gaps[:2], start=1):
        recs.append(_rec(
            f"dept-adoption-{i}", "Department",
            f"Run an AI enablement drive in {dg['dept']}",
            f"Targeted onboarding + champion support for {dg['dept']}.",
            [
                f"{dg['dept']} AI adoption is {dg['adoptPct']}% vs org average {round(org_avg * 100, 1)}%",
                f"{dg['headcount']} people in the department",
                "AI-active users show higher task throughput (correlation)",
            ],
            {"adoptionPct": dg["adoptPct"], "orgAvgPct": round(org_avg * 100, 1), "headcount": dg["headcount"]},
            "High", dg["headcount"], dg["gap"], dg["dept"], priority=1,
        ))

    # ---- Maturity-derived: users + training ----
    mg = (
        db.query(User.id, User.name, User.department,
                 func.count(GenerationRecord.id), func.sum(_SUCCESS_CASE),
                 func.count(func.distinct(GenerationRecord.provider)))
        .join(GenerationRecord, GenerationRecord.owner_user_id == User.id)
        .filter(User.is_deleted.is_(False), GenerationRecord.archived_at.is_(None),
                GenerationRecord.created_at >= start_dt, GenerationRecord.created_at < end_exclusive)
    )
    if department and department != "all":
        mg = mg.filter(User.department == department)
    mg = mg.group_by(User.id, User.name, User.department).order_by(func.count(GenerationRecord.id).desc()).limit(200).all()
    cand_ids = [r[0] for r in mg]
    act_days = defaultdict(set)
    act_weeks = defaultdict(set)
    if cand_ids:
        for uid, d in (
            db.query(UserActivity.user_id, UserActivity.date)
            .filter(UserActivity.user_id.in_(cand_ids), UserActivity.date >= start_dt.date(),
                    UserActivity.date <= (end_exclusive - timedelta(days=1)).date(), _ACTIVE_ROW).all()
        ):
            act_days[uid].add(d); act_weeks[uid].add(d.isocalendar()[1])
    cg_map = {}
    if cand_ids:
        cg_map = {uid: int(c) for uid, c in (
            db.query(ConversationRecord.owner_user_id, func.count(ConversationRecord.id))
            .filter(ConversationRecord.owner_user_id.in_(cand_ids), ConversationRecord.archived_at.is_(None),
                    ConversationRecord.provider == CHATGPT_PROVIDER,
                    ConversationRecord.created_at >= start_dt, ConversationRecord.created_at < end_exclusive)
            .group_by(ConversationRecord.owner_user_id).all()
        )}

    champions = 0
    explorers_near = 0
    single_tool = []
    low_success = []
    gens_list = []
    for uid, name, dept, gens, succ, providers in mg:
        gens = int(gens); succ = int(succ or 0); providers = int(providers)
        gens_list.append(gens)
        adays = len(act_days.get(uid, ()))
        aweeks = len(act_weeks.get(uid, ()))
        tool_count = providers + (1 if cg_map.get(uid, 0) > 0 else 0)
        sr = (succ / gens) * 100.0 if gens else 0.0
        freq = min(100.0, (adays / period_days) * 100.0)
        volume = min(100.0, (gens ** 0.6) * 8.0)
        diversity = _diversity_score(tool_count)
        consistency = min(100.0, (aweeks / total_weeks) * 100.0)
        score = 0.25 * freq + 0.20 * volume + 0.15 * diversity + 0.20 * sr + 0.20 * consistency
        if score >= 75:
            champions += 1
        elif 40 <= score < 50:
            explorers_near += 1
        if tool_count <= 1 and gens >= 10:
            single_tool.append((name, dept))
        if gens >= 5 and sr < 60:
            low_success.append((name, dept))

    cand_n = len(mg)
    if champions >= 2:
        recs.append(_rec(
            "user-mentors", "User",
            f"Deploy {champions} AI Champions as mentors",
            "Stand up a champions/mentor program pairing them with lower-maturity teams.",
            [f"{champions} users score in the AI Champion band (75+)", "Champions concentrate proven, high-success usage"],
            {"champions": champions, "candidatePool": cand_n},
            "High", champions, min(1.0, champions / 10.0), f"{champions} champions", priority=2,
        ))
    if len(single_tool) >= 3:
        names = ", ".join(n for n, _d in single_tool[:3])
        recs.append(_rec(
            "user-second-tool", "User",
            f"Introduce a second AI tool to {len(single_tool)} single-tool power users",
            "Cross-introduce complementary tools (e.g. ChatGPT to Kling-only users) to broaden fluency.",
            [f"{len(single_tool)} high-volume users rely on a single tool", f"Examples: {names}"],
            {"count": len(single_tool)},
            "Medium", len(single_tool), min(1.0, len(single_tool) / (cand_n or 1)), f"{len(single_tool)} users", priority=3,
        ))
    if len(low_success) >= 3:
        names = ", ".join(n for n, _d in low_success[:3])
        recs.append(_rec(
            "training-prompt", "Training",
            f"Prompt-craft training for {len(low_success)} active users",
            "Run a targeted prompt-engineering cohort for active users with low output success.",
            [f"{len(low_success)} active users have <60% prompt success", f"Examples: {names}", "Surface Golden Prompts in-product to reinforce"],
            {"count": len(low_success)},
            "Medium", len(low_success), min(1.0, len(low_success) / (cand_n or 1)), f"{len(low_success)} users", priority=2,
        ))
    if explorers_near >= 3:
        recs.append(_rec(
            "training-explorers", "Training",
            f"Coach {explorers_near} Explorers toward Practitioner",
            "Targeted coaching on their weakest maturity component to advance a level.",
            [f"{explorers_near} users sit just below the Practitioner threshold", "Small, focused coaching yields a level jump"],
            {"count": explorers_near},
            "Low", explorers_near, min(1.0, explorers_near / (cand_n or 1)), f"{explorers_near} users", priority=3,
        ))

    # ---- Churn re-engagement ----
    today = date.today()
    last_rows = (
        db.query(UserActivity.user_id, func.max(UserActivity.date))
        .join(User, UserActivity.user_id == User.id)
        .filter(User.is_deleted.is_(False), _ACTIVE_ROW)
    )
    if department and department != "all":
        last_rows = last_rows.filter(User.department == department)
    last_rows = last_rows.group_by(UserActivity.user_id).all()
    churn = sum(1 for _uid, last_d in last_rows if last_d and (today - timedelta(days=90)) <= last_d <= (today - timedelta(days=15)))
    if churn >= 3:
        recs.append(_rec(
            "user-reengage", "User",
            f"Re-engage {churn} users who have gone quiet",
            "Launch a win-back nudge to users active in the last 90 days but not the last 15.",
            [f"{churn} previously-active users have no activity in 15–90 days", "Reactivation is cheaper than new adoption"],
            {"churnRisk": churn},
            "Medium", churn, min(1.0, churn / 20.0), f"{churn} users", priority=2,
        ))

    # Sort by (priority asc, confidence desc)
    recs.sort(key=lambda r: (r["priority"], -r["confidence"]))
    if type and type.lower() != "all":
        recs = [r for r in recs if r["type"].lower() == type.lower()]

    by_type = Counter(r["type"] for r in recs)
    summary = {
        "total": len(recs),
        "highConfidence": sum(1 for r in recs if r["confidenceBand"] == "High"),
        "byType": [{"type": t, "count": c} for t, c in by_type.items()],
    }
    return {"success": True, "recommendations": recs, "summary": summary,
            "note": "Evidence-based suggestions from real aggregates. Confidence is heuristic (data volume x effect size), not statistical. Acceptance/outcome tracking is future architecture."}
