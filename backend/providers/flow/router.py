# providers/flow/router.py
"""
API surface for the Flow (labs.google/fx/tools/flow) provider. Raw capture
ingestion mirrors providers/freepik/router.py's ticket-based per-event actor
resolution (not ChatGPT's plain-session one - see CAPTURE_CONTRACT.md for
why), inline normalization, and a minimal admin-gated read surface for manual
verification. No sync-cursor/reconciliation endpoints or health-ping endpoint
in this first pass - see CAPTURE_CONTRACT.md's scope note.
"""
import logging
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from sqlalchemy import desc
from sqlalchemy.orm import Session

from database_config import get_operational_db
from models_new import User
from providers.flow.capture import (
    ingest_capture_event,
    resolve_flow_actor,
    resolve_flow_credential,
    resolve_flow_tool,
)
from providers.flow.constants import INGEST_COMMIT_CHUNK_SIZE, PROVIDER
from providers.flow.models import FlowCaptureEvent, FlowGeneration
from providers.flow.normalization import normalize_capture_events_batch
from providers.flow.schemas import (
    CaptureEventResult,
    CaptureEventsRequest,
    CaptureEventsResponse,
    EventDetailOut,
    EventListOut,
    GenerationDetailOut,
    GenerationListOut,
    PaginationOut,
)
from utils.permissions import require_admin

router = APIRouter(prefix="/api/providers/flow", tags=["flow"])
logger = logging.getLogger("flow_router")

DEFAULT_LIMIT = 50
MAX_LIMIT = 200


def _attach_owner_names(db: Session, dicts: list[dict]) -> list[dict]:
    """Merges ownerName into each already-serialized generation dict (batch-
    loaded, not per-row) - mirrors providers/freepik/queries.py's
    attach_owner_summaries. FlowGeneration itself only stores owner_user_id
    (no cached display field, to avoid staleness if an employee is renamed),
    so the dashboard card/detail views need this or they fall back to
    "User #<id>"."""
    owner_ids = {item.get("ownerUserId") for item in dicts if item.get("ownerUserId")}
    if not owner_ids:
        return dicts
    users_by_id = {user.id: user for user in db.query(User).filter(User.id.in_(owner_ids)).all()}
    for item in dicts:
        user = users_by_id.get(item.get("ownerUserId"))
        item["ownerName"] = user.name if user else None
    return dicts


def _attach_event_user_names(db: Session, dicts: list[dict]) -> list[dict]:
    """Same idea as _attach_owner_names, for the raw event feed's userId
    (the actor who triggered/reported the event, not necessarily the same
    row as a generation's owner_user_id - e.g. media_url_resolved events)."""
    user_ids = {item.get("userId") for item in dicts if item.get("userId")}
    if not user_ids:
        return dicts
    users_by_id = {user.id: user for user in db.query(User).filter(User.id.in_(user_ids)).all()}
    for item in dicts:
        user = users_by_id.get(item.get("userId"))
        item["userName"] = user.name if user else None
    return dicts


def _ownership_confidence(*, is_reconciliation: bool, has_ticket: bool) -> str:
    if is_reconciliation:
        return "reconciliation"
    return "ticket" if has_ticket else "session"


@router.post("/capture/events", response_model=CaptureEventsResponse)
def capture_events(
    payload: CaptureEventsRequest,
    request: Request,
    db: Session = Depends(get_operational_db),
):
    tool = resolve_flow_tool(db)
    if not tool:
        return CaptureEventsResponse(
            success=False,
            results=[
                CaptureEventResult(client_event_id=item.client_event_id, status="rejected", reason="flow tool is not configured")
                for item in payload.events
            ],
        )

    results = []
    newly_created_events = []
    pending_since_commit = 0
    # Memoized per unique (usage_ticket, extension_ticket, explicit_credential_id)
    # triple, NOT resolved once for the whole request - see
    # providers/freepik/router.py's identical comment for why a shared
    # multi-tab queue makes per-request resolution unsafe here (unlike
    # ChatGPT's session-based router, where it's safe).
    resolution_cache: dict = {}

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
                current_user = resolve_flow_actor(
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

            credential = resolve_flow_credential(
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
            creation_id=item.creation_id,
            family_id=item.family_id,
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
                is_reconciliation=item.is_reconciliation,
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

        # ingest_capture_event flushes inside a savepoint but never commits -
        # the transaction is ours. Commit a chunk at a time.
        pending_since_commit += 1
        if pending_since_commit >= INGEST_COMMIT_CHUNK_SIZE:
            db.commit()
            pending_since_commit = 0

    if pending_since_commit:
        db.commit()

    if newly_created_events:
        # Normalization failure must never turn a successful, lossless
        # ingest into an error response - every event above is already
        # committed at this point, so nothing here can lose raw data.
        try:
            normalize_capture_events_batch(db, newly_created_events)
        except Exception:
            logger.exception("flow normalization batch failed for %d event(s)", len(newly_created_events))
            db.rollback()

    return CaptureEventsResponse(success=True, results=results)


# ==================== Minimal admin read surface ====================
# For manual verification only in this first pass (no dashboard viewer UI
# yet - see CAPTURE_CONTRACT.md's scope note). Deliberately plain
# limit/offset queries rather than providers/freepik/queries.py's full
# filter framework, which this pass doesn't need yet.

@router.get("/generations", response_model=GenerationListOut)
def list_generations(
    owner_user_id: Optional[int] = None,
    batch_id: Optional[str] = None,
    linked_task_id: Optional[int] = None,
    linked_client_id: Optional[int] = None,
    limit: int = Query(default=DEFAULT_LIMIT, ge=1, le=MAX_LIMIT),
    offset: int = Query(default=0, ge=0),
    db: Session = Depends(get_operational_db),
    current_user: User = Depends(require_admin),
):
    query = db.query(FlowGeneration).filter(FlowGeneration.provider == PROVIDER)
    if owner_user_id is not None:
        query = query.filter(FlowGeneration.owner_user_id == owner_user_id)
    if batch_id:
        query = query.filter(FlowGeneration.batch_id == batch_id)
    if linked_task_id is not None:
        query = query.filter(FlowGeneration.linked_task_id == linked_task_id)
    if linked_client_id is not None:
        query = query.filter(FlowGeneration.linked_client_id == linked_client_id)

    total = query.count()
    items = query.order_by(desc(FlowGeneration.created_at)).offset(offset).limit(limit).all()
    data = _attach_owner_names(db, [item.to_dict() for item in items])
    return GenerationListOut(
        data=data,
        pagination=PaginationOut(limit=limit, offset=offset, total=total),
    )


@router.get("/generations/{generation_id}", response_model=GenerationDetailOut)
def get_generation(
    generation_id: int,
    db: Session = Depends(get_operational_db),
    current_user: User = Depends(require_admin),
):
    generation = (
        db.query(FlowGeneration)
        .filter(FlowGeneration.provider == PROVIDER, FlowGeneration.id == generation_id)
        .first()
    )
    if not generation:
        raise HTTPException(status_code=404, detail="Flow generation not found")
    data = _attach_owner_names(db, [generation.to_dict()])[0]
    return GenerationDetailOut(data=data)


@router.get("/events", response_model=EventListOut)
def list_events(
    event_type: Optional[str] = None,
    user_id: Optional[int] = None,
    limit: int = Query(default=DEFAULT_LIMIT, ge=1, le=MAX_LIMIT),
    offset: int = Query(default=0, ge=0),
    db: Session = Depends(get_operational_db),
    current_user: User = Depends(require_admin),
):
    query = db.query(FlowCaptureEvent).filter(FlowCaptureEvent.provider == PROVIDER)
    if event_type:
        query = query.filter(FlowCaptureEvent.event_type == event_type)
    if user_id is not None:
        query = query.filter(FlowCaptureEvent.user_id == user_id)

    total = query.count()
    items = query.order_by(desc(FlowCaptureEvent.created_at)).offset(offset).limit(limit).all()
    data = _attach_event_user_names(db, [item.to_dict() for item in items])
    return EventListOut(
        data=data,
        pagination=PaginationOut(limit=limit, offset=offset, total=total),
    )


@router.get("/events/{event_id}", response_model=EventDetailOut)
def get_event(
    event_id: int,
    db: Session = Depends(get_operational_db),
    current_user: User = Depends(require_admin),
):
    event = (
        db.query(FlowCaptureEvent)
        .filter(FlowCaptureEvent.provider == PROVIDER, FlowCaptureEvent.id == event_id)
        .first()
    )
    if not event:
        raise HTTPException(status_code=404, detail="Flow capture event not found")
    data = _attach_event_user_names(db, [event.to_dict()])[0]
    return EventDetailOut(data=data)
