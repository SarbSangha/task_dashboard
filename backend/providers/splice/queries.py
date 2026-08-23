# providers/splice/queries.py
"""
Read-side query logic backing router.py's GET endpoints. Mirrors
providers/epidemicsound/queries.py's structure, minus the Adapt-equivalent
filters/functions (this provider has only the downloads surface - see
router.py's own docstring for the confirmed route set)."""
from dataclasses import dataclass
from datetime import date
from typing import Optional

from sqlalchemy import func
from sqlalchemy.orm import Session

from models_new import User
from providers.splice.constants import PROVIDER
from providers.splice.models import SpliceCaptureEvent, SpliceDownload

DEFAULT_LIMIT = 50
MAX_LIMIT = 200


@dataclass
class DownloadFilters:
    linked_task_id: Optional[int] = None
    linked_client_id: Optional[int] = None
    date_from: Optional[date] = None
    date_to: Optional[date] = None
    q: Optional[str] = None


def _apply_download_filters(query, filters: DownloadFilters):
    query = query.filter(SpliceDownload.provider == PROVIDER)
    if filters.linked_task_id is not None:
        query = query.filter(SpliceDownload.linked_task_id == filters.linked_task_id)
    if filters.linked_client_id is not None:
        query = query.filter(SpliceDownload.linked_client_id == filters.linked_client_id)
    if filters.date_from:
        query = query.filter(func.date(SpliceDownload.created_at) >= filters.date_from)
    if filters.date_to:
        query = query.filter(func.date(SpliceDownload.created_at) <= filters.date_to)
    if filters.q:
        like = f"%{filters.q}%"
        query = query.filter(
            (SpliceDownload.asset_title.ilike(like))
            | (SpliceDownload.sample_hash.ilike(like))
            | (SpliceDownload.linked_task_name.ilike(like))
            | (SpliceDownload.linked_client_name.ilike(like))
        )
    return query


def list_downloads(db: Session, *, filters: DownloadFilters, limit: int = DEFAULT_LIMIT, offset: int = 0):
    query = _apply_download_filters(db.query(SpliceDownload), filters)
    total = query.count()
    sort_key = func.coalesce(SpliceDownload.downloaded_at, SpliceDownload.created_at)
    items = query.order_by(sort_key.desc()).offset(offset).limit(limit).all()
    return items, total


def get_download(db: Session, download_id: int) -> Optional[SpliceDownload]:
    return (
        db.query(SpliceDownload)
        .filter(SpliceDownload.provider == PROVIDER, SpliceDownload.id == download_id)
        .first()
    )


def list_events(
    db: Session,
    *,
    client_event_id: Optional[str] = None,
    event_type: Optional[str] = None,
    user_id: Optional[int] = None,
    date_from: Optional[date] = None,
    date_to: Optional[date] = None,
    limit: int = DEFAULT_LIMIT,
    offset: int = 0,
):
    """Mirrors providers/epidemicsound/queries.py's list_events - no
    identity-uuid filter here (Splice has no generation-identity concept;
    use client_event_id/event_type/date range instead)."""
    query = db.query(SpliceCaptureEvent).filter(SpliceCaptureEvent.provider == PROVIDER)
    if client_event_id:
        query = query.filter(SpliceCaptureEvent.client_event_id == client_event_id)
    if event_type:
        query = query.filter(SpliceCaptureEvent.event_type == event_type)
    if user_id:
        query = query.filter(SpliceCaptureEvent.user_id == user_id)
    if date_from:
        query = query.filter(SpliceCaptureEvent.event_date >= date_from)
    if date_to:
        query = query.filter(SpliceCaptureEvent.event_date <= date_to)
    total = query.count()
    items = query.order_by(SpliceCaptureEvent.created_at.desc()).offset(offset).limit(limit).all()
    return items, total


def get_event(db: Session, event_id: int) -> Optional[SpliceCaptureEvent]:
    return (
        db.query(SpliceCaptureEvent)
        .filter(SpliceCaptureEvent.provider == PROVIDER, SpliceCaptureEvent.id == event_id)
        .first()
    )


def attach_owner_summaries(db: Session, dicts: list[dict]) -> list[dict]:
    """Merges ownerName/ownerEmployeeId/ownerDepartment into each already-
    serialized download dict - mirrors providers/epidemicsound/queries.py's
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
