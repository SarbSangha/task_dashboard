# providers/grammarly_docs/router.py
"""
API surface for the Grammarly Docs provider. Mirrors providers/splice/router.py's
structure, minus capture-health and asset-mirroring (this provider has
neither yet - see CAPTURE_CONTRACT.md's known-gaps section).

Confirmed route set this pass: POST /capture/events, GET /sessions,
GET /sessions/{session_id}, GET /events, GET /events/{event_id}.
"""
import logging
from datetime import date
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from sqlalchemy.orm import Session

from database_config import get_operational_db
from models_new import User
from providers.grammarly_docs import queries as grammarly_queries
from providers.grammarly_docs.capture import (
    ingest_capture_event,
    resolve_grammarly_docs_actor,
    resolve_grammarly_docs_credential,
    resolve_grammarly_docs_tool,
)
from providers.grammarly_docs.constants import INGEST_COMMIT_CHUNK_SIZE
from providers.grammarly_docs.normalization import normalize_capture_events_batch
from providers.grammarly_docs.queries import SessionFilters
from providers.grammarly_docs.schemas import (
    CaptureEventResult,
    CaptureEventsRequest,
    CaptureEventsResponse,
    EventDetailOut,
    EventListOut,
    PaginationOut,
    SessionDetailOut,
    SessionListOut,
)
from utils.permissions import require_admin

router = APIRouter(prefix="/api/providers/grammarly-docs", tags=["grammarly-docs"])
logger = logging.getLogger("grammarly_docs_router")


def _ownership_confidence(*, has_ticket: bool) -> str:
    return "ticket" if has_ticket else "session"


@router.post("/capture/events", response_model=CaptureEventsResponse)
def capture_events(
    payload: CaptureEventsRequest,
    request: Request,
    db: Session = Depends(get_operational_db),
):
    tool = resolve_grammarly_docs_tool(db)
    if not tool:
        return CaptureEventsResponse(
            success=False,
            results=[
                CaptureEventResult(client_event_id=item.client_event_id, status="rejected", reason="grammarly tool is not configured")
                for item in payload.events
            ],
        )

    results = []
    newly_created_events = []
    pending_since_commit = 0
    # Memoized per unique ticket triple within the batch, not once per
    # request - same reasoning as every other provider's identical comment
    # (this queue is shared across the whole browser, a single flush batch
    # can legitimately mix events from different tabs/tickets).
    resolution_cache: dict[tuple, tuple] = {}

    for item in payload.events:
        cache_key = (item.usage_ticket, item.extension_ticket, item.credential_id)
        cached = resolution_cache.get(cache_key)
        if cached is not None:
            current_user, credential_id, cached_error = cached
            if cached_error is not None:
                results.append(
                    CaptureEventResult(client_event_id=item.client_event_id, status="rejected", reason=cached_error)
                )
                continue
        else:
            try:
                current_user = resolve_grammarly_docs_actor(
                    request=request,
                    db=db,
                    tool=tool,
                    usage_ticket=item.usage_ticket,
                    extension_ticket=item.extension_ticket,
                )
            except HTTPException as error:
                resolution_cache[cache_key] = (None, None, str(error.detail))
                results.append(
                    CaptureEventResult(client_event_id=item.client_event_id, status="rejected", reason=str(error.detail))
                )
                continue

            credential = resolve_grammarly_docs_credential(
                db,
                tool_id=tool.id,
                user_id=current_user.id,
                explicit_credential_id=item.credential_id,
            )
            credential_id = credential.id if credential else None
            resolution_cache[cache_key] = (current_user, credential_id, None)

        outcome = ingest_capture_event(
            db,
            tool=tool,
            credential_id=credential_id,
            user=current_user,
            event_type=item.event_type,
            client_event_id=item.client_event_id,
            session_key=item.session_key,
            doc_id=item.doc_id,
            payload=item.payload,
            capture_version=item.capture_version,
            extension_version=item.extension_version,
            browser=item.browser,
            tab_id=item.tab_id,
            session_id=item.session_id,
            extension_session_id=item.extension_session_id,
            event_date=item.event_date,
            task_id=item.linked_task_id,
            client_id=item.linked_client_id,
            ownership_confidence=_ownership_confidence(
                has_ticket=bool(item.usage_ticket or item.extension_ticket),
            ),
        )
        if outcome.status == "created" and outcome.event is not None:
            newly_created_events.append(outcome.event)
        results.append(
            CaptureEventResult(
                client_event_id=item.client_event_id,
                status=outcome.status,
                id=outcome.event.id if outcome.event else None,
                reason=outcome.reason,
            )
        )

        pending_since_commit += 1
        if pending_since_commit >= INGEST_COMMIT_CHUNK_SIZE:
            db.commit()
            pending_since_commit = 0

    if pending_since_commit:
        db.commit()

    if newly_created_events:
        try:
            normalize_capture_events_batch(db, newly_created_events)
        except Exception:
            logger.exception("grammarly normalization batch failed for %d event(s)", len(newly_created_events))
            db.rollback()

    return CaptureEventsResponse(success=True, results=results)


@router.get("/sessions", response_model=SessionListOut)
def list_sessions(
    doc_id: Optional[str] = None,
    status: Optional[str] = None,
    owner_user_id: Optional[int] = None,
    linked_task_id: Optional[int] = None,
    linked_client_id: Optional[int] = None,
    date_from: Optional[date] = None,
    date_to: Optional[date] = None,
    q: Optional[str] = None,
    limit: int = Query(default=grammarly_queries.DEFAULT_LIMIT, ge=1, le=grammarly_queries.MAX_LIMIT),
    offset: int = Query(default=0, ge=0),
    db: Session = Depends(get_operational_db),
    current_user: User = Depends(require_admin),
):
    filters = SessionFilters(
        doc_id=doc_id,
        status=status,
        owner_user_id=owner_user_id,
        linked_task_id=linked_task_id,
        linked_client_id=linked_client_id,
        date_from=date_from,
        date_to=date_to,
        q=q,
    )
    items, total = grammarly_queries.list_sessions(db, filters=filters, limit=limit, offset=offset)
    # include_content=False - see GrammarlyDocSession.to_dict's own comment:
    # the browse list can be up to MAX_LIMIT rows, each potentially carrying
    # a large contentText - the detail endpoint below is where a single
    # session's full text is actually fetched.
    data = grammarly_queries.attach_owner_summaries(db, [item.to_dict(include_content=False) for item in items])
    return SessionListOut(
        data=data,
        pagination=PaginationOut(limit=limit, offset=offset, total=total),
    )


@router.get("/sessions/{doc_session_id}", response_model=SessionDetailOut)
def get_session_detail(
    doc_session_id: int,
    db: Session = Depends(get_operational_db),
    current_user: User = Depends(require_admin),
):
    # Path param deliberately NOT named "session_id" - require_admin's own
    # dependency chain resolves a `session_id` Cookie param, and FastAPI
    # merges dependant params by name: a path param sharing that exact name
    # collides with the cookie one and fails at route-registration time
    # ("Cannot use Cookie for path param 'session_id'"), not at request time.
    row = grammarly_queries.get_session(db, doc_session_id)
    if not row:
        raise HTTPException(status_code=404, detail="Session not found")
    # attach_owner_summaries() was only ever wired into list_sessions above -
    # the detail endpoint returned ownerName/ownerEmployeeId/ownerDepartment
    # as None on every row, even though the list view (which drives the
    # "by person" grouping) always had them right.
    data = grammarly_queries.attach_owner_summaries(db, [row.to_dict()])[0]
    return SessionDetailOut(data=data)


@router.get("/events", response_model=EventListOut)
def list_capture_events(
    client_event_id: Optional[str] = None,
    session_key: Optional[str] = None,
    event_type: Optional[str] = None,
    user_id: Optional[int] = None,
    date_from: Optional[date] = None,
    date_to: Optional[date] = None,
    limit: int = Query(default=grammarly_queries.DEFAULT_LIMIT, ge=1, le=grammarly_queries.MAX_LIMIT),
    offset: int = Query(default=0, ge=0),
    db: Session = Depends(get_operational_db),
    current_user: User = Depends(require_admin),
):
    items, total = grammarly_queries.list_events(
        db,
        client_event_id=client_event_id,
        session_key=session_key,
        event_type=event_type,
        user_id=user_id,
        date_from=date_from,
        date_to=date_to,
        limit=limit,
        offset=offset,
    )
    return EventListOut(
        data=[item.to_dict() for item in items],
        pagination=PaginationOut(limit=limit, offset=offset, total=total),
    )


@router.get("/events/{event_id}", response_model=EventDetailOut)
def get_capture_event(
    event_id: int,
    db: Session = Depends(get_operational_db),
    current_user: User = Depends(require_admin),
):
    row = grammarly_queries.get_event(db, event_id)
    if not row:
        raise HTTPException(status_code=404, detail="Event not found")
    return EventDetailOut(data=row.to_dict())
