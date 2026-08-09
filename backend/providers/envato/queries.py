# providers/envato/queries.py
"""
Read-side query logic backing router.py's GET endpoints. Mirrors
providers/freepik/queries.py's structure, minus the search/download tables
Envato doesn't have.
"""
from dataclasses import dataclass
from datetime import date
from typing import Optional

from sqlalchemy import func
from sqlalchemy.orm import Session

from models_new import User
from providers.envato.capture import get_ingest_stats_snapshot
from providers.envato.constants import OWNERSHIP_STATUS_RESOLVED, PROVIDER
from providers.envato.models import EnvatoCaptureEvent, EnvatoDownload, EnvatoGeneration

DEFAULT_LIMIT = 50
MAX_LIMIT = 200


@dataclass
class GenerationFilters:
    owner_user_id: Optional[int] = None
    ownership_status: Optional[str] = None
    item_type: Optional[str] = None
    date_from: Optional[date] = None
    date_to: Optional[date] = None
    q: Optional[str] = None
    linked_task_id: Optional[int] = None
    linked_client_id: Optional[int] = None


def _apply_generation_filters(query, filters: GenerationFilters):
    query = query.filter(EnvatoGeneration.provider == PROVIDER)
    if filters.owner_user_id is not None:
        query = query.filter(EnvatoGeneration.owner_user_id == filters.owner_user_id)
    if filters.ownership_status:
        query = query.filter(EnvatoGeneration.ownership_status == filters.ownership_status)
    if filters.item_type:
        query = query.filter(EnvatoGeneration.item_type == filters.item_type)
    if filters.date_from:
        query = query.filter(func.date(EnvatoGeneration.created_at) >= filters.date_from)
    if filters.date_to:
        query = query.filter(func.date(EnvatoGeneration.created_at) <= filters.date_to)
    if filters.linked_task_id is not None:
        query = query.filter(EnvatoGeneration.linked_task_id == filters.linked_task_id)
    if filters.linked_client_id is not None:
        query = query.filter(EnvatoGeneration.linked_client_id == filters.linked_client_id)
    if filters.q:
        like = f"%{filters.q}%"
        query = query.filter(
            (EnvatoGeneration.prompt.ilike(like))
            | (EnvatoGeneration.title.ilike(like))
            | (EnvatoGeneration.item_uuid.ilike(like))
            | (EnvatoGeneration.linked_task_name.ilike(like))
            | (EnvatoGeneration.linked_client_name.ilike(like))
        )
    return query


def list_generations(db: Session, *, filters: GenerationFilters, limit: int = DEFAULT_LIMIT, offset: int = 0):
    query = _apply_generation_filters(db.query(EnvatoGeneration), filters)
    total = query.count()
    # Sort by the generation's real-world date (provider_created_at), falling
    # back to our own row's insert time - same reasoning as
    # providers/freepik/queries.py's list_generations (reconciliation-imported
    # rows can all share one insert timestamp regardless of how old the
    # actual Envato item is).
    sort_key = func.coalesce(EnvatoGeneration.provider_created_at, EnvatoGeneration.created_at)
    items = query.order_by(sort_key.desc()).offset(offset).limit(limit).all()
    return items, total


def get_generation(db: Session, generation_id: int) -> Optional[EnvatoGeneration]:
    return (
        db.query(EnvatoGeneration)
        .filter(EnvatoGeneration.provider == PROVIDER, EnvatoGeneration.id == generation_id)
        .first()
    )


@dataclass
class DownloadFilters:
    linked_task_id: Optional[int] = None
    linked_client_id: Optional[int] = None
    date_from: Optional[date] = None
    date_to: Optional[date] = None
    q: Optional[str] = None


def _apply_download_filters(query, filters: DownloadFilters):
    query = query.filter(EnvatoDownload.provider == PROVIDER)
    if filters.linked_task_id is not None:
        query = query.filter(EnvatoDownload.linked_task_id == filters.linked_task_id)
    if filters.linked_client_id is not None:
        query = query.filter(EnvatoDownload.linked_client_id == filters.linked_client_id)
    if filters.date_from:
        query = query.filter(func.date(EnvatoDownload.created_at) >= filters.date_from)
    if filters.date_to:
        query = query.filter(func.date(EnvatoDownload.created_at) <= filters.date_to)
    if filters.q:
        like = f"%{filters.q}%"
        query = query.filter(
            (EnvatoDownload.asset_title.ilike(like))
            | (EnvatoDownload.search_term.ilike(like))
            | (EnvatoDownload.item_uuid.ilike(like))
            | (EnvatoDownload.linked_task_name.ilike(like))
            | (EnvatoDownload.linked_client_name.ilike(like))
        )
    return query


def list_downloads(db: Session, *, filters: DownloadFilters, limit: int = DEFAULT_LIMIT, offset: int = 0):
    query = _apply_download_filters(db.query(EnvatoDownload), filters)
    total = query.count()
    sort_key = func.coalesce(EnvatoDownload.downloaded_at, EnvatoDownload.created_at)
    items = query.order_by(sort_key.desc()).offset(offset).limit(limit).all()
    return items, total


def get_download(db: Session, download_id: int) -> Optional[EnvatoDownload]:
    return (
        db.query(EnvatoDownload)
        .filter(EnvatoDownload.provider == PROVIDER, EnvatoDownload.id == download_id)
        .first()
    )


def list_linked_tasks(db: Session) -> list[dict]:
    """Distinct (task_id, task_name) pairs actually referenced by an Envato
    generation - populates the RMW Data Task filter dropdown."""
    rows = (
        db.query(EnvatoGeneration.linked_task_id, func.max(EnvatoGeneration.linked_task_name))
        .filter(EnvatoGeneration.provider == PROVIDER, EnvatoGeneration.linked_task_id.isnot(None))
        .group_by(EnvatoGeneration.linked_task_id)
        .order_by(func.max(EnvatoGeneration.linked_task_name).asc())
        .all()
    )
    return [{"id": row[0], "name": row[1]} for row in rows]


def list_linked_clients(db: Session) -> list[dict]:
    """Distinct (client_id, client_name) pairs actually referenced by an
    Envato generation - populates the RMW Data Client filter dropdown."""
    rows = (
        db.query(EnvatoGeneration.linked_client_id, func.max(EnvatoGeneration.linked_client_name))
        .filter(EnvatoGeneration.provider == PROVIDER, EnvatoGeneration.linked_client_id.isnot(None))
        .group_by(EnvatoGeneration.linked_client_id)
        .order_by(func.max(EnvatoGeneration.linked_client_name).asc())
        .all()
    )
    return [{"id": row[0], "name": row[1]} for row in rows]


def attach_owner_summaries(db: Session, dicts: list[dict]) -> list[dict]:
    """Merges ownerName/ownerEmployeeId/ownerDepartment into each already-
    serialized generation dict - mirrors providers/freepik/queries.py's
    identical helper."""
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
    item_uuid: Optional[str] = None,
    client_event_id: Optional[str] = None,
    event_type: Optional[str] = None,
    user_id: Optional[int] = None,
    date_from: Optional[date] = None,
    date_to: Optional[date] = None,
    limit: int = DEFAULT_LIMIT,
    offset: int = 0,
):
    query = db.query(EnvatoCaptureEvent).filter(EnvatoCaptureEvent.provider == PROVIDER)
    if item_uuid:
        query = query.filter(EnvatoCaptureEvent.provider_item_uuid == item_uuid)
    if client_event_id:
        query = query.filter(EnvatoCaptureEvent.client_event_id == client_event_id)
    if event_type:
        query = query.filter(EnvatoCaptureEvent.event_type == event_type)
    if user_id:
        query = query.filter(EnvatoCaptureEvent.user_id == user_id)
    if date_from:
        query = query.filter(EnvatoCaptureEvent.event_date >= date_from)
    if date_to:
        query = query.filter(EnvatoCaptureEvent.event_date <= date_to)
    total = query.count()
    items = query.order_by(EnvatoCaptureEvent.created_at.desc()).offset(offset).limit(limit).all()
    return items, total


def get_event(db: Session, event_id: int) -> Optional[EnvatoCaptureEvent]:
    return (
        db.query(EnvatoCaptureEvent)
        .filter(EnvatoCaptureEvent.provider == PROVIDER, EnvatoCaptureEvent.id == event_id)
        .first()
    )


def get_metrics(db: Session) -> dict:
    """Snapshot for the Capture Center's Envato tile: ingest counters (this
    process only), plus durable DB aggregates."""
    total_generations = db.query(func.count(EnvatoGeneration.id)).filter(EnvatoGeneration.provider == PROVIDER).scalar() or 0
    resolved_count = (
        db.query(func.count(EnvatoGeneration.id))
        .filter(EnvatoGeneration.provider == PROVIDER, EnvatoGeneration.ownership_status == OWNERSHIP_STATUS_RESOLVED)
        .scalar()
        or 0
    )
    credits_total = (
        db.query(func.coalesce(func.sum(EnvatoGeneration.credits_badge), 0.0))
        .filter(EnvatoGeneration.provider == PROVIDER)
        .scalar()
        or 0.0
    )
    total_downloads = db.query(func.count(EnvatoDownload.id)).filter(EnvatoDownload.provider == PROVIDER).scalar() or 0
    return {
        "ingest": get_ingest_stats_snapshot(),
        "totalGenerations": int(total_generations),
        "resolvedOwnershipCount": int(resolved_count),
        "unknownOwnershipCount": int(total_generations - resolved_count),
        "creditsChargedTotal": float(credits_total),
        "totalDownloads": int(total_downloads),
    }


def credits_by_owner(db: Session, *, date_from: Optional[date] = None, date_to: Optional[date] = None) -> list[dict]:
    """Credits burned per employee - same shape as
    providers/freepik/queries.py's identical function, joined for display
    fields only."""
    query = (
        db.query(
            EnvatoGeneration.owner_user_id,
            func.count(EnvatoGeneration.id).label("generation_count"),
            func.coalesce(func.sum(EnvatoGeneration.credits_badge), 0.0).label("credits_charged_total"),
        )
        .filter(EnvatoGeneration.provider == PROVIDER, EnvatoGeneration.owner_user_id.isnot(None))
    )
    if date_from:
        query = query.filter(func.date(EnvatoGeneration.created_at) >= date_from)
    if date_to:
        query = query.filter(func.date(EnvatoGeneration.created_at) <= date_to)
    rows = query.group_by(EnvatoGeneration.owner_user_id).all()

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
            }
        )
    results.sort(key=lambda item: item["creditsChargedTotal"], reverse=True)
    return results


def list_users(db: Session, *, q: Optional[str] = None, limit: int = DEFAULT_LIMIT, offset: int = 0):
    """Capture Center "Users" sidebar: every employee with at least one
    resolved-ownership Envato generation, with aggregate counts."""
    query = (
        db.query(
            EnvatoGeneration.owner_user_id,
            func.count(EnvatoGeneration.id).label("generation_count"),
            func.coalesce(func.sum(EnvatoGeneration.credits_badge), 0.0).label("credits_charged_total"),
            func.max(EnvatoGeneration.created_at).label("last_generation_at"),
        )
        .filter(EnvatoGeneration.provider == PROVIDER, EnvatoGeneration.owner_user_id.isnot(None))
        .group_by(EnvatoGeneration.owner_user_id)
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
            func.count(EnvatoGeneration.id).label("generation_count"),
            func.coalesce(func.sum(EnvatoGeneration.credits_badge), 0.0).label("credits_charged_total"),
        )
        .filter(EnvatoGeneration.provider == PROVIDER, EnvatoGeneration.owner_user_id == user_id)
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
    }
