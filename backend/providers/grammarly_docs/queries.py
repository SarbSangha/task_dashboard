# providers/grammarly_docs/queries.py
"""Read-side query logic backing router.py's GET endpoints. Mirrors
providers/splice/queries.py's structure, with GrammarlyDocSession's
session/doc-shaped filters (doc_id, status, date range on started_at) in
place of SpliceDownload's asset-shaped ones."""
from dataclasses import dataclass
from datetime import date
from typing import Optional

from sqlalchemy import func
from sqlalchemy.orm import Session

from models_new import User
from providers.grammarly_docs.constants import PROVIDER
from providers.grammarly_docs.models import GrammarlyCaptureEvent, GrammarlyDocSession

DEFAULT_LIMIT = 50
MAX_LIMIT = 200


@dataclass
class SessionFilters:
    doc_id: Optional[str] = None
    status: Optional[str] = None
    owner_user_id: Optional[int] = None
    linked_task_id: Optional[int] = None
    linked_client_id: Optional[int] = None
    date_from: Optional[date] = None
    date_to: Optional[date] = None
    q: Optional[str] = None


def _apply_session_filters(query, filters: SessionFilters):
    query = query.filter(GrammarlyDocSession.provider == PROVIDER)
    if filters.doc_id:
        query = query.filter(GrammarlyDocSession.doc_id == filters.doc_id)
    if filters.status:
        query = query.filter(GrammarlyDocSession.status == filters.status)
    if filters.owner_user_id is not None:
        query = query.filter(GrammarlyDocSession.owner_user_id == filters.owner_user_id)
    if filters.linked_task_id is not None:
        query = query.filter(GrammarlyDocSession.linked_task_id == filters.linked_task_id)
    if filters.linked_client_id is not None:
        query = query.filter(GrammarlyDocSession.linked_client_id == filters.linked_client_id)
    if filters.date_from:
        query = query.filter(func.date(GrammarlyDocSession.started_at) >= filters.date_from)
    if filters.date_to:
        query = query.filter(func.date(GrammarlyDocSession.started_at) <= filters.date_to)
    if filters.q:
        like = f"%{filters.q}%"
        query = query.filter(
            (GrammarlyDocSession.doc_title.ilike(like))
            | (GrammarlyDocSession.doc_author.ilike(like))
            | (GrammarlyDocSession.linked_task_name.ilike(like))
            | (GrammarlyDocSession.linked_client_name.ilike(like))
        )
    return query


def list_sessions(db: Session, *, filters: SessionFilters, limit: int = DEFAULT_LIMIT, offset: int = 0):
    query = _apply_session_filters(db.query(GrammarlyDocSession), filters)
    total = query.count()
    items = query.order_by(GrammarlyDocSession.started_at.desc()).offset(offset).limit(limit).all()
    return items, total


def get_session(db: Session, session_id: int) -> Optional[GrammarlyDocSession]:
    return (
        db.query(GrammarlyDocSession)
        .filter(GrammarlyDocSession.provider == PROVIDER, GrammarlyDocSession.id == session_id)
        .first()
    )


def list_events(
    db: Session,
    *,
    client_event_id: Optional[str] = None,
    session_key: Optional[str] = None,
    event_type: Optional[str] = None,
    user_id: Optional[int] = None,
    date_from: Optional[date] = None,
    date_to: Optional[date] = None,
    limit: int = DEFAULT_LIMIT,
    offset: int = 0,
):
    query = db.query(GrammarlyCaptureEvent).filter(GrammarlyCaptureEvent.provider == PROVIDER)
    if client_event_id:
        query = query.filter(GrammarlyCaptureEvent.client_event_id == client_event_id)
    if session_key:
        query = query.filter(GrammarlyCaptureEvent.session_key == session_key)
    if event_type:
        query = query.filter(GrammarlyCaptureEvent.event_type == event_type)
    if user_id:
        query = query.filter(GrammarlyCaptureEvent.user_id == user_id)
    if date_from:
        query = query.filter(GrammarlyCaptureEvent.event_date >= date_from)
    if date_to:
        query = query.filter(GrammarlyCaptureEvent.event_date <= date_to)
    total = query.count()
    items = query.order_by(GrammarlyCaptureEvent.created_at.desc()).offset(offset).limit(limit).all()
    return items, total


def get_event(db: Session, event_id: int) -> Optional[GrammarlyCaptureEvent]:
    return (
        db.query(GrammarlyCaptureEvent)
        .filter(GrammarlyCaptureEvent.provider == PROVIDER, GrammarlyCaptureEvent.id == event_id)
        .first()
    )


def attach_owner_summaries(db: Session, dicts: list[dict]) -> list[dict]:
    """Merges ownerName/ownerEmployeeId/ownerDepartment into each already-
    serialized session dict - mirrors providers/splice/queries.py's identical
    helper."""
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
