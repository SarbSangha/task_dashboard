# providers/higgsfield/queries.py
"""
Read-side query logic backing router.py's GET endpoints - mirrors
providers/heygen/queries.py. No dashboard UI consumes these yet (deferred to
a follow-up pass, see the implementation plan) but the API surface is built
now so it's ready when that lands, and so it can be exercised manually/via
admin tooling in the meantime.
"""
from dataclasses import dataclass
from datetime import date
from typing import Optional

from sqlalchemy import func
from sqlalchemy.orm import Session

from models_new import User
from providers.higgsfield.capture import get_ingest_stats_snapshot
from providers.higgsfield.constants import OWNERSHIP_STATUS_RESOLVED, PROVIDER
from providers.higgsfield.models import HiggsfieldCaptureEvent, HiggsfieldGeneration

DEFAULT_LIMIT = 50
MAX_LIMIT = 200


@dataclass
class GenerationFilters:
    owner_user_id: Optional[int] = None
    ownership_status: Optional[str] = None
    project_id: Optional[str] = None
    status: Optional[str] = None
    date_from: Optional[date] = None
    date_to: Optional[date] = None
    q: Optional[str] = None
    linked_task_id: Optional[int] = None
    linked_client_id: Optional[int] = None


def _apply_generation_filters(query, filters: GenerationFilters):
    query = query.filter(HiggsfieldGeneration.provider == PROVIDER)
    if filters.owner_user_id is not None:
        query = query.filter(HiggsfieldGeneration.owner_user_id == filters.owner_user_id)
    if filters.ownership_status:
        query = query.filter(HiggsfieldGeneration.ownership_status == filters.ownership_status)
    if filters.project_id:
        query = query.filter(HiggsfieldGeneration.project_id == filters.project_id)
    if filters.status:
        query = query.filter(HiggsfieldGeneration.status == filters.status)
    if filters.date_from:
        query = query.filter(func.date(HiggsfieldGeneration.created_at) >= filters.date_from)
    if filters.date_to:
        query = query.filter(func.date(HiggsfieldGeneration.created_at) <= filters.date_to)
    if filters.linked_task_id is not None:
        query = query.filter(HiggsfieldGeneration.linked_task_id == filters.linked_task_id)
    if filters.linked_client_id is not None:
        query = query.filter(HiggsfieldGeneration.linked_client_id == filters.linked_client_id)
    if filters.q:
        like = f"%{filters.q}%"
        query = query.filter(
            (HiggsfieldGeneration.prompt_text.ilike(like))
            | (HiggsfieldGeneration.generation_id.ilike(like))
            | (HiggsfieldGeneration.preset_name.ilike(like))
            | (HiggsfieldGeneration.linked_task_name.ilike(like))
            | (HiggsfieldGeneration.linked_client_name.ilike(like))
        )
    return query


def list_generations(db: Session, *, filters: GenerationFilters, limit: int = DEFAULT_LIMIT, offset: int = 0):
    query = _apply_generation_filters(db.query(HiggsfieldGeneration), filters)
    total = query.count()
    # Sort by the generation's real-world date (provider_created_at), not our
    # own row's insert time (created_at) - they diverge badly for
    # reconciliation-imported rows, which can all get inserted in the same
    # bulk-backfill run (same created_at, give or take milliseconds)
    # regardless of how old the actual Higgsfield video is. created_at is
    # only a fallback for the brief window before a submitted-click row has
    # any provider timestamp yet. Built in from day one - this is the exact
    # ordering bug this session already found and fixed twice (HeyGen, then
    # Freepik) on the same query shape.
    sort_key = func.coalesce(HiggsfieldGeneration.provider_created_at, HiggsfieldGeneration.created_at)
    items = query.order_by(sort_key.desc()).offset(offset).limit(limit).all()
    return items, total


def get_generation(db: Session, generation_id: int) -> Optional[HiggsfieldGeneration]:
    return (
        db.query(HiggsfieldGeneration)
        .filter(HiggsfieldGeneration.provider == PROVIDER, HiggsfieldGeneration.id == generation_id)
        .first()
    )


def list_linked_tasks(db: Session) -> list[dict]:
    rows = (
        db.query(HiggsfieldGeneration.linked_task_id, func.max(HiggsfieldGeneration.linked_task_name))
        .filter(HiggsfieldGeneration.provider == PROVIDER, HiggsfieldGeneration.linked_task_id.isnot(None))
        .group_by(HiggsfieldGeneration.linked_task_id)
        .order_by(func.max(HiggsfieldGeneration.linked_task_name).asc())
        .all()
    )
    return [{"id": row[0], "name": row[1]} for row in rows]


def list_linked_clients(db: Session) -> list[dict]:
    rows = (
        db.query(HiggsfieldGeneration.linked_client_id, func.max(HiggsfieldGeneration.linked_client_name))
        .filter(HiggsfieldGeneration.provider == PROVIDER, HiggsfieldGeneration.linked_client_id.isnot(None))
        .group_by(HiggsfieldGeneration.linked_client_id)
        .order_by(func.max(HiggsfieldGeneration.linked_client_name).asc())
        .all()
    )
    return [{"id": row[0], "name": row[1]} for row in rows]


def attach_owner_summaries(db: Session, dicts: list[dict]) -> list[dict]:
    owner_ids = {item.get("ownerUserId") for item in dicts if item.get("ownerUserId")}
    if not owner_ids:
        return dicts
    users_by_id = {user.id: user for user in db.query(User).filter(User.id.in_(owner_ids)).all()}
    for item in dicts:
        user = users_by_id.get(item.get("ownerUserId"))
        item["ownerName"] = user.name if user else None
        item["ownerEmployeeId"] = user.employee_id if user else None
        item["ownerDepartment"] = user.department if user else None
    return dicts


def list_events(
    db: Session,
    *,
    generation_id: Optional[str] = None,
    client_event_id: Optional[str] = None,
    event_type: Optional[str] = None,
    user_id: Optional[int] = None,
    date_from: Optional[date] = None,
    date_to: Optional[date] = None,
    limit: int = DEFAULT_LIMIT,
    offset: int = 0,
):
    query = db.query(HiggsfieldCaptureEvent).filter(HiggsfieldCaptureEvent.provider == PROVIDER)
    if generation_id:
        query = query.filter(HiggsfieldCaptureEvent.provider_generation_id == generation_id)
    if client_event_id:
        query = query.filter(HiggsfieldCaptureEvent.client_event_id == client_event_id)
    if event_type:
        query = query.filter(HiggsfieldCaptureEvent.event_type == event_type)
    if user_id:
        query = query.filter(HiggsfieldCaptureEvent.user_id == user_id)
    if date_from:
        query = query.filter(HiggsfieldCaptureEvent.event_date >= date_from)
    if date_to:
        query = query.filter(HiggsfieldCaptureEvent.event_date <= date_to)
    total = query.count()
    items = query.order_by(HiggsfieldCaptureEvent.created_at.desc()).offset(offset).limit(limit).all()
    return items, total


def get_event(db: Session, event_id: int) -> Optional[HiggsfieldCaptureEvent]:
    return (
        db.query(HiggsfieldCaptureEvent)
        .filter(HiggsfieldCaptureEvent.provider == PROVIDER, HiggsfieldCaptureEvent.id == event_id)
        .first()
    )


def get_metrics(db: Session) -> dict:
    total_generations = db.query(func.count(HiggsfieldGeneration.id)).filter(HiggsfieldGeneration.provider == PROVIDER).scalar() or 0
    resolved_count = (
        db.query(func.count(HiggsfieldGeneration.id))
        .filter(HiggsfieldGeneration.provider == PROVIDER, HiggsfieldGeneration.ownership_status == OWNERSHIP_STATUS_RESOLVED)
        .scalar()
        or 0
    )
    credits_total = (
        db.query(func.coalesce(func.sum(HiggsfieldGeneration.credits_used), 0.0))
        .filter(HiggsfieldGeneration.provider == PROVIDER)
        .scalar()
        or 0.0
    )
    return {
        "ingest": get_ingest_stats_snapshot(),
        "totalGenerations": int(total_generations),
        "resolvedOwnershipCount": int(resolved_count),
        "unknownOwnershipCount": int(total_generations - resolved_count),
        "creditsUsedTotal": float(credits_total),
    }


def credits_by_owner(db: Session, *, date_from: Optional[date] = None, date_to: Optional[date] = None) -> list[dict]:
    query = (
        db.query(
            HiggsfieldGeneration.owner_user_id,
            func.count(HiggsfieldGeneration.id).label("generation_count"),
            func.coalesce(func.sum(HiggsfieldGeneration.credits_used), 0.0).label("credits_used_total"),
        )
        .filter(HiggsfieldGeneration.provider == PROVIDER, HiggsfieldGeneration.owner_user_id.isnot(None))
    )
    if date_from:
        query = query.filter(func.date(HiggsfieldGeneration.created_at) >= date_from)
    if date_to:
        query = query.filter(func.date(HiggsfieldGeneration.created_at) <= date_to)
    rows = query.group_by(HiggsfieldGeneration.owner_user_id).all()

    user_ids = [row.owner_user_id for row in rows]
    users_by_id = {user.id: user for user in db.query(User).filter(User.id.in_(user_ids)).all()} if user_ids else {}

    results = []
    for row in rows:
        user = users_by_id.get(row.owner_user_id)
        results.append(
            {
                "ownerUserId": row.owner_user_id,
                "employeeId": getattr(user, "employee_id", None),
                "name": getattr(user, "name", None),
                "department": getattr(user, "department", None),
                "generationCount": int(row.generation_count),
                "creditsUsedTotal": float(row.credits_used_total),
            }
        )
    results.sort(key=lambda item: item["creditsUsedTotal"], reverse=True)
    return results


def list_users(db: Session, *, q: Optional[str] = None, limit: int = DEFAULT_LIMIT, offset: int = 0):
    query = (
        db.query(
            HiggsfieldGeneration.owner_user_id,
            func.count(HiggsfieldGeneration.id).label("generation_count"),
            func.coalesce(func.sum(HiggsfieldGeneration.credits_used), 0.0).label("credits_used_total"),
            func.max(HiggsfieldGeneration.created_at).label("last_generation_at"),
        )
        .filter(HiggsfieldGeneration.provider == PROVIDER, HiggsfieldGeneration.owner_user_id.isnot(None))
        .group_by(HiggsfieldGeneration.owner_user_id)
    )
    rows = query.all()

    user_ids = [row.owner_user_id for row in rows]
    users_by_id = {user.id: user for user in db.query(User).filter(User.id.in_(user_ids)).all()} if user_ids else {}

    items = []
    for row in rows:
        user = users_by_id.get(row.owner_user_id)
        if not user:
            continue
        if q:
            haystack = " ".join(filter(None, [user.name, user.email, user.employee_id, user.department])).lower()
            if q.lower() not in haystack:
                continue
        items.append(
            {
                "userId": user.id,
                "name": user.name,
                "email": user.email,
                "employeeId": user.employee_id,
                "department": user.department,
                "generationCount": int(row.generation_count),
                "creditsUsedTotal": float(row.credits_used_total),
                "lastGenerationAt": row.last_generation_at.isoformat() if row.last_generation_at else None,
            }
        )
    items.sort(key=lambda item: item["lastGenerationAt"] or "", reverse=True)
    total = len(items)
    return items[offset : offset + limit], total


def get_user_detail(db: Session, user_id: int) -> Optional[dict]:
    user = db.query(User).filter(User.id == user_id).first()
    if not user:
        return None
    stats = (
        db.query(
            func.count(HiggsfieldGeneration.id).label("generation_count"),
            func.coalesce(func.sum(HiggsfieldGeneration.credits_used), 0.0).label("credits_used_total"),
        )
        .filter(HiggsfieldGeneration.provider == PROVIDER, HiggsfieldGeneration.owner_user_id == user_id)
        .first()
    )
    return {
        "userId": user.id,
        "name": user.name,
        "email": user.email,
        "employeeId": user.employee_id,
        "department": user.department,
        "generationCount": int(stats.generation_count or 0),
        "creditsUsedTotal": float(stats.credits_used_total or 0.0),
    }
