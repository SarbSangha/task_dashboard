# providers/epidemicsound/queries.py
"""
Read-side query logic backing router.py's GET endpoints. Mirrors
providers/envato/queries.py's structure, covering both this provider's
capture surfaces: downloads (EpidemicDownload) and Adapt generations
(EpidemicAdaptation) - see router.py's own docstring for the confirmed
route set."""
from dataclasses import dataclass
from datetime import date
from typing import Optional

from sqlalchemy import func
from sqlalchemy.orm import Session

from models_new import User
from providers.epidemicsound.constants import PROVIDER
from providers.epidemicsound.models import EpidemicAdaptation, EpidemicCaptureEvent, EpidemicDownload

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
    query = query.filter(EpidemicDownload.provider == PROVIDER)
    if filters.linked_task_id is not None:
        query = query.filter(EpidemicDownload.linked_task_id == filters.linked_task_id)
    if filters.linked_client_id is not None:
        query = query.filter(EpidemicDownload.linked_client_id == filters.linked_client_id)
    if filters.date_from:
        query = query.filter(func.date(EpidemicDownload.created_at) >= filters.date_from)
    if filters.date_to:
        query = query.filter(func.date(EpidemicDownload.created_at) <= filters.date_to)
    if filters.q:
        like = f"%{filters.q}%"
        query = query.filter(
            (EpidemicDownload.asset_title.ilike(like))
            | (EpidemicDownload.sound_id.ilike(like))
            | (EpidemicDownload.download_id.ilike(like))
            | (EpidemicDownload.linked_task_name.ilike(like))
            | (EpidemicDownload.linked_client_name.ilike(like))
        )
    return query


def list_downloads(db: Session, *, filters: DownloadFilters, limit: int = DEFAULT_LIMIT, offset: int = 0):
    query = _apply_download_filters(db.query(EpidemicDownload), filters)
    total = query.count()
    sort_key = func.coalesce(EpidemicDownload.downloaded_at, EpidemicDownload.created_at)
    items = query.order_by(sort_key.desc()).offset(offset).limit(limit).all()
    return items, total


def get_download(db: Session, download_id: int) -> Optional[EpidemicDownload]:
    return (
        db.query(EpidemicDownload)
        .filter(EpidemicDownload.provider == PROVIDER, EpidemicDownload.id == download_id)
        .first()
    )


@dataclass
class AdaptationFilters:
    linked_task_id: Optional[int] = None
    linked_client_id: Optional[int] = None
    date_from: Optional[date] = None
    date_to: Optional[date] = None
    q: Optional[str] = None


def _apply_adaptation_filters(query, filters: AdaptationFilters):
    query = query.filter(EpidemicAdaptation.provider == PROVIDER)
    if filters.linked_task_id is not None:
        query = query.filter(EpidemicAdaptation.linked_task_id == filters.linked_task_id)
    if filters.linked_client_id is not None:
        query = query.filter(EpidemicAdaptation.linked_client_id == filters.linked_client_id)
    if filters.date_from:
        query = query.filter(func.date(EpidemicAdaptation.created_at) >= filters.date_from)
    if filters.date_to:
        query = query.filter(func.date(EpidemicAdaptation.created_at) <= filters.date_to)
    if filters.q:
        like = f"%{filters.q}%"
        query = query.filter(
            (EpidemicAdaptation.prompt.ilike(like))
            | (EpidemicAdaptation.version_id.ilike(like))
            | (EpidemicAdaptation.recording_id.ilike(like))
            | (EpidemicAdaptation.original_track_title.ilike(like))
            | (EpidemicAdaptation.linked_task_name.ilike(like))
            | (EpidemicAdaptation.linked_client_name.ilike(like))
        )
    return query


def list_adaptations(db: Session, *, filters: AdaptationFilters, limit: int = DEFAULT_LIMIT, offset: int = 0):
    query = _apply_adaptation_filters(db.query(EpidemicAdaptation), filters)
    total = query.count()
    sort_key = func.coalesce(EpidemicAdaptation.updated_at, EpidemicAdaptation.created_at)
    items = query.order_by(sort_key.desc()).offset(offset).limit(limit).all()
    return items, total


def get_adaptation(db: Session, adaptation_id: int) -> Optional[EpidemicAdaptation]:
    return (
        db.query(EpidemicAdaptation)
        .filter(EpidemicAdaptation.provider == PROVIDER, EpidemicAdaptation.id == adaptation_id)
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
    """Mirrors providers/envato/queries.py's list_events - no item_uuid
    filter here (Epidemic Sound has no generation-identity concept; use
    client_event_id/event_type/date range instead)."""
    query = db.query(EpidemicCaptureEvent).filter(EpidemicCaptureEvent.provider == PROVIDER)
    if client_event_id:
        query = query.filter(EpidemicCaptureEvent.client_event_id == client_event_id)
    if event_type:
        query = query.filter(EpidemicCaptureEvent.event_type == event_type)
    if user_id:
        query = query.filter(EpidemicCaptureEvent.user_id == user_id)
    if date_from:
        query = query.filter(EpidemicCaptureEvent.event_date >= date_from)
    if date_to:
        query = query.filter(EpidemicCaptureEvent.event_date <= date_to)
    total = query.count()
    items = query.order_by(EpidemicCaptureEvent.created_at.desc()).offset(offset).limit(limit).all()
    return items, total


def get_event(db: Session, event_id: int) -> Optional[EpidemicCaptureEvent]:
    return (
        db.query(EpidemicCaptureEvent)
        .filter(EpidemicCaptureEvent.provider == PROVIDER, EpidemicCaptureEvent.id == event_id)
        .first()
    )


def attach_owner_summaries(db: Session, dicts: list[dict]) -> list[dict]:
    """Merges ownerName/ownerEmployeeId/ownerDepartment into each already-
    serialized download dict - mirrors providers/envato/queries.py's
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
