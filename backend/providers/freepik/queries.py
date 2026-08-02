# providers/freepik/queries.py
"""
Read-side query logic backing router.py's GET endpoints - rich,
Freepik-specific views over FreepikGeneration/FreepikCaptureEvent that go
beyond what the generic generation_records_router.py browse/search UI
exposes (that router already surfaces the projected GenerationRecord rows
for cross-tool use; this module is for the Freepik-specific detail/analytics
surface - Capture Center style, same split ChatGPT's queries.py makes).
"""
from dataclasses import dataclass
from datetime import date
from typing import Optional

from sqlalchemy import func
from sqlalchemy.orm import Session

from models_new import User
from providers.freepik.capture import get_ingest_stats_snapshot
from providers.freepik.constants import OWNERSHIP_STATUS_RESOLVED, PROVIDER
from providers.freepik.models import FreepikCaptureEvent, FreepikGeneration

DEFAULT_LIMIT = 50
MAX_LIMIT = 200


@dataclass
class GenerationFilters:
    owner_user_id: Optional[int] = None
    ownership_status: Optional[str] = None
    family_id: Optional[str] = None
    tool: Optional[str] = None
    status: Optional[str] = None
    date_from: Optional[date] = None
    date_to: Optional[date] = None
    q: Optional[str] = None
    linked_task_id: Optional[int] = None
    linked_client_id: Optional[int] = None


def _apply_generation_filters(query, filters: GenerationFilters):
    query = query.filter(FreepikGeneration.provider == PROVIDER)
    if filters.owner_user_id is not None:
        query = query.filter(FreepikGeneration.owner_user_id == filters.owner_user_id)
    if filters.ownership_status:
        query = query.filter(FreepikGeneration.ownership_status == filters.ownership_status)
    if filters.family_id:
        query = query.filter(FreepikGeneration.family_id == filters.family_id)
    if filters.tool:
        query = query.filter(FreepikGeneration.tool == filters.tool)
    if filters.status:
        query = query.filter(FreepikGeneration.status == filters.status)
    if filters.date_from:
        query = query.filter(func.date(FreepikGeneration.created_at) >= filters.date_from)
    if filters.date_to:
        query = query.filter(func.date(FreepikGeneration.created_at) <= filters.date_to)
    if filters.linked_task_id is not None:
        query = query.filter(FreepikGeneration.linked_task_id == filters.linked_task_id)
    if filters.linked_client_id is not None:
        query = query.filter(FreepikGeneration.linked_client_id == filters.linked_client_id)
    if filters.q:
        like = f"%{filters.q}%"
        query = query.filter(
            (FreepikGeneration.prompt.ilike(like))
            | (FreepikGeneration.name_field.ilike(like))
            | (FreepikGeneration.creation_id.ilike(like))
            | (FreepikGeneration.linked_task_name.ilike(like))
            | (FreepikGeneration.linked_client_name.ilike(like))
        )
    return query


def list_generations(db: Session, *, filters: GenerationFilters, limit: int = DEFAULT_LIMIT, offset: int = 0):
    query = _apply_generation_filters(db.query(FreepikGeneration), filters)
    total = query.count()
    items = query.order_by(FreepikGeneration.created_at.desc()).offset(offset).limit(limit).all()
    return items, total


def get_generation(db: Session, generation_id: int) -> Optional[FreepikGeneration]:
    return (
        db.query(FreepikGeneration)
        .filter(FreepikGeneration.provider == PROVIDER, FreepikGeneration.id == generation_id)
        .first()
    )


def list_linked_tasks(db: Session) -> list[dict]:
    """Distinct (task_id, task_name) pairs actually referenced by a Freepik
    generation - populates the RMW Data Task filter dropdown without needing
    the full live tasks_router.py listing (which is scoped to the *current*
    user's active tasks, not "every task any generation has ever linked to")."""
    # Grouped by id, not DISTINCT over (id, name): linked_task_name is a
    # snapshot of the title at capture time, so a renamed task would otherwise
    # appear once per name it has ever had. max() picks one deterministically.
    rows = (
        db.query(FreepikGeneration.linked_task_id, func.max(FreepikGeneration.linked_task_name))
        .filter(FreepikGeneration.provider == PROVIDER, FreepikGeneration.linked_task_id.isnot(None))
        .group_by(FreepikGeneration.linked_task_id)
        .order_by(func.max(FreepikGeneration.linked_task_name).asc())
        .all()
    )
    return [{"id": row[0], "name": row[1]} for row in rows]


def list_linked_clients(db: Session) -> list[dict]:
    """Distinct (client_id, client_name) pairs actually referenced by a
    Freepik generation - populates the RMW Data Client filter dropdown."""
    # Grouped by id for the same reason as list_linked_tasks above - a renamed
    # client would otherwise show up once per historical name.
    rows = (
        db.query(FreepikGeneration.linked_client_id, func.max(FreepikGeneration.linked_client_name))
        .filter(FreepikGeneration.provider == PROVIDER, FreepikGeneration.linked_client_id.isnot(None))
        .group_by(FreepikGeneration.linked_client_id)
        .order_by(func.max(FreepikGeneration.linked_client_name).asc())
        .all()
    )
    return [{"id": row[0], "name": row[1]} for row in rows]


def attach_owner_summaries(db: Session, dicts: list[dict]) -> list[dict]:
    """Merges ownerName/ownerEmployeeId/ownerDepartment into each already-
    serialized generation dict (batch-loaded, not per-row) - the card grid
    needs an owner name/avatar to render, same as Kling's cards, and
    FreepikGeneration itself only stores owner_user_id (no cached display
    fields, to avoid staleness if an employee's name changes)."""
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
    creation_id: Optional[str] = None,
    client_event_id: Optional[str] = None,
    event_type: Optional[str] = None,
    user_id: Optional[int] = None,
    date_from: Optional[date] = None,
    date_to: Optional[date] = None,
    limit: int = DEFAULT_LIMIT,
    offset: int = 0,
):
    query = db.query(FreepikCaptureEvent).filter(FreepikCaptureEvent.provider == PROVIDER)
    if creation_id:
        query = query.filter(FreepikCaptureEvent.provider_creation_id == creation_id)
    if client_event_id:
        query = query.filter(FreepikCaptureEvent.client_event_id == client_event_id)
    if event_type:
        query = query.filter(FreepikCaptureEvent.event_type == event_type)
    if user_id:
        query = query.filter(FreepikCaptureEvent.user_id == user_id)
    if date_from:
        query = query.filter(FreepikCaptureEvent.event_date >= date_from)
    if date_to:
        query = query.filter(FreepikCaptureEvent.event_date <= date_to)
    total = query.count()
    items = query.order_by(FreepikCaptureEvent.created_at.desc()).offset(offset).limit(limit).all()
    return items, total


def get_event(db: Session, event_id: int) -> Optional[FreepikCaptureEvent]:
    return (
        db.query(FreepikCaptureEvent)
        .filter(FreepikCaptureEvent.provider == PROVIDER, FreepikCaptureEvent.id == event_id)
        .first()
    )


def get_metrics(db: Session) -> dict:
    """Snapshot for the Capture Center's Freepik tile: ingest counters (this
    process only - see capture.py's docstring), plus durable DB aggregates
    that survive a restart."""
    total_generations = db.query(func.count(FreepikGeneration.id)).filter(FreepikGeneration.provider == PROVIDER).scalar() or 0
    resolved_count = (
        db.query(func.count(FreepikGeneration.id))
        .filter(FreepikGeneration.provider == PROVIDER, FreepikGeneration.ownership_status == OWNERSHIP_STATUS_RESOLVED)
        .scalar()
        or 0
    )
    credits_total = (
        db.query(func.coalesce(func.sum(FreepikGeneration.credits_charged), 0.0))
        .filter(FreepikGeneration.provider == PROVIDER)
        .scalar()
        or 0.0
    )
    return {
        "ingest": get_ingest_stats_snapshot(),
        "totalGenerations": int(total_generations),
        "resolvedOwnershipCount": int(resolved_count),
        "unknownOwnershipCount": int(total_generations - resolved_count),
        "creditsChargedTotal": float(credits_total),
    }


def credits_by_owner(db: Session, *, date_from: Optional[date] = None, date_to: Optional[date] = None) -> list[dict]:
    """Phase 7 analytics: credits burned per employee. Joins User purely for
    display name/employee_id/department - the aggregation itself is keyed on
    owner_user_id, exactly what Phase 7's "credit usage by employee/department"
    report needs."""
    query = (
        db.query(
            FreepikGeneration.owner_user_id,
            func.count(FreepikGeneration.id).label("generation_count"),
            func.coalesce(func.sum(FreepikGeneration.credits_charged), 0.0).label("credits_charged_total"),
            func.coalesce(func.sum(FreepikGeneration.credits_estimated), 0.0).label("credits_estimated_total"),
        )
        .filter(FreepikGeneration.provider == PROVIDER, FreepikGeneration.owner_user_id.isnot(None))
    )
    if date_from:
        query = query.filter(func.date(FreepikGeneration.created_at) >= date_from)
    if date_to:
        query = query.filter(func.date(FreepikGeneration.created_at) <= date_to)
    rows = query.group_by(FreepikGeneration.owner_user_id).all()

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
                "creditsChargedTotal": float(row.credits_charged_total),
                "creditsEstimatedTotal": float(row.credits_estimated_total),
            }
        )
    results.sort(key=lambda item: item["creditsChargedTotal"], reverse=True)
    return results


def list_users(db: Session, *, q: Optional[str] = None, limit: int = DEFAULT_LIMIT, offset: int = 0):
    """Capture Center "Users" sidebar: every employee who has at least one
    resolved-ownership Freepik generation, with aggregate counts - built on
    the same aggregation as credits_by_owner() but paginated/searchable, the
    shape the frontend's user list actually needs (mirrors ChatGPT's
    /users endpoint)."""
    query = (
        db.query(
            FreepikGeneration.owner_user_id,
            func.count(FreepikGeneration.id).label("generation_count"),
            func.coalesce(func.sum(FreepikGeneration.credits_charged), 0.0).label("credits_charged_total"),
            func.max(FreepikGeneration.created_at).label("last_generation_at"),
        )
        .filter(FreepikGeneration.provider == PROVIDER, FreepikGeneration.owner_user_id.isnot(None))
        .group_by(FreepikGeneration.owner_user_id)
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
                "creditsChargedTotal": float(row.credits_charged_total),
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
            func.count(FreepikGeneration.id).label("generation_count"),
            func.coalesce(func.sum(FreepikGeneration.credits_charged), 0.0).label("credits_charged_total"),
            func.coalesce(func.sum(FreepikGeneration.credits_estimated), 0.0).label("credits_estimated_total"),
        )
        .filter(FreepikGeneration.provider == PROVIDER, FreepikGeneration.owner_user_id == user_id)
        .first()
    )
    return {
        "userId": user.id,
        "name": user.name,
        "email": user.email,
        "employeeId": user.employee_id,
        "department": user.department,
        "generationCount": int(stats.generation_count or 0),
        "creditsChargedTotal": float(stats.credits_charged_total or 0.0),
        "creditsEstimatedTotal": float(stats.credits_estimated_total or 0.0),
    }
