# providers/envato/router.py
"""
API surface for the Envato provider. Mirrors providers/freepik/router.py's
structure and endpoint set, minus the search/download endpoints Envato
doesn't have.
"""
import logging
from datetime import date
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from sqlalchemy.orm import Session

from database_config import get_operational_db
from models_new import User
from providers.envato import queries as envato_queries
from providers.envato.capture import (
    ingest_capture_event,
    resolve_envato_actor,
    resolve_envato_credential,
    resolve_envato_tool,
)
from providers.envato.constants import INGEST_COMMIT_CHUNK_SIZE
from providers.envato.health import capture_health_to_dict, get_capture_health_for_user, record_health_ping
from providers.envato.normalization import normalize_capture_events_batch
from providers.envato.queries import DownloadFilters, GenerationFilters
from providers.envato.schemas import (
    CaptureEventResult,
    CaptureEventsRequest,
    CaptureEventsResponse,
    CaptureHealthOut,
    CaptureHealthPingIn,
    DownloadDetailOut,
    DownloadListOut,
    EventDetailOut,
    EventListOut,
    GenerationDetailOut,
    GenerationListOut,
    MetricsOut,
    PaginationOut,
    SyncCursorIn,
    SyncCursorOut,
    UserDetailOut,
    UserListOut,
)
from providers.envato.sync import get_or_create_cursor, report_sync_progress
from utils.permissions import require_admin

router = APIRouter(prefix="/api/providers/envato", tags=["envato"])
logger = logging.getLogger("envato_router")


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
    tool = resolve_envato_tool(db)
    if not tool:
        return CaptureEventsResponse(
            success=False,
            results=[
                CaptureEventResult(client_event_id=item.client_event_id, status="rejected", reason="envato tool is not configured")
                for item in payload.events
            ],
        )

    results = []
    newly_created_events = []
    pending_since_commit = 0
    # Memoized per unique ticket triple within the batch, not once per
    # request - same reasoning as providers/freepik/router.py's identical
    # comment (this queue is shared across the whole browser, a single flush
    # batch can legitimately mix events from different tabs/tickets).
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
                current_user = resolve_envato_actor(
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

            credential = resolve_envato_credential(
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
            item_uuid=item.item_uuid,
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
            logger.exception("envato normalization batch failed for %d event(s)", len(newly_created_events))
            db.rollback()

    return CaptureEventsResponse(success=True, results=results)


@router.post("/capture/health", response_model=CaptureHealthOut)
def report_capture_health(
    payload: CaptureHealthPingIn,
    request: Request,
    db: Session = Depends(get_operational_db),
):
    tool = resolve_envato_tool(db)
    current_user: Optional[User] = None
    try:
        if tool:
            current_user = resolve_envato_actor(
                request=request,
                db=db,
                tool=tool,
                usage_ticket=payload.usage_ticket,
                extension_ticket=payload.extension_ticket,
            )
    except HTTPException:
        return CaptureHealthOut(success=False, data={"reason": "actor_unresolved"})

    if not current_user:
        return CaptureHealthOut(success=False, data={"reason": "envato tool is not configured"})

    credential_id = payload.credential_id
    if tool and not credential_id:
        credential = resolve_envato_credential(db, tool_id=tool.id, user_id=current_user.id)
        credential_id = credential.id if credential else None

    record = record_health_ping(
        db,
        user_id=current_user.id,
        tool_id=tool.id if tool else None,
        credential_id=credential_id,
        extension_session_id=payload.extension_session_id,
        extension_version=payload.extension_version,
        queue_length=payload.queue_length,
        events_waiting=payload.events_waiting,
        oldest_pending_event_at=payload.oldest_pending_event_at,
        retry_count=payload.retry_count,
        last_capture_event_at=payload.last_capture_event_at,
        last_successful_upload_at=payload.last_successful_upload_at,
        last_failed_upload_at=payload.last_failed_upload_at,
        average_upload_time_ms=payload.average_upload_time_ms,
        offline_since=payload.offline_since,
    )
    return CaptureHealthOut(success=True, data=capture_health_to_dict(record))


@router.post("/sync/cursor", response_model=SyncCursorOut)
def report_sync_cursor(
    payload: SyncCursorIn,
    request: Request,
    db: Session = Depends(get_operational_db),
):
    tool = resolve_envato_tool(db)
    run_by_user_id = None
    credential_id = payload.credential_id
    if tool:
        try:
            actor = resolve_envato_actor(
                request=request, db=db, tool=tool,
                usage_ticket=payload.usage_ticket, extension_ticket=payload.extension_ticket,
            )
            run_by_user_id = actor.id
            if not credential_id:
                credential = resolve_envato_credential(db, tool_id=tool.id, user_id=actor.id)
                credential_id = credential.id if credential else None
        except HTTPException:
            run_by_user_id = None

    if not credential_id:
        raise HTTPException(status_code=400, detail="Could not resolve an Envato credential for this sync report")

    cursor = report_sync_progress(
        db,
        credential_id=credential_id,
        last_seen_item_uuid=payload.last_seen_item_uuid,
        last_synced_page=payload.last_synced_page,
        is_full_reconciliation=payload.is_full_reconciliation,
        status=payload.status,
        error=payload.error,
        run_by_user_id=run_by_user_id,
    )
    return SyncCursorOut(success=True, data=cursor.to_dict())


@router.get("/sync/cursor/{credential_id}", response_model=SyncCursorOut)
def get_sync_cursor(
    credential_id: int,
    db: Session = Depends(get_operational_db),
    current_user: User = Depends(require_admin),
):
    cursor = get_or_create_cursor(db, credential_id=credential_id)
    return SyncCursorOut(success=True, data=cursor.to_dict())


# ==================== CAPTURE CENTER (admin, read-only) ====================

@router.get("/generations", response_model=GenerationListOut)
def list_generations(
    owner_user_id: Optional[int] = None,
    ownership_status: Optional[str] = None,
    item_type: Optional[str] = None,
    date_from: Optional[date] = None,
    date_to: Optional[date] = None,
    q: Optional[str] = None,
    linked_task_id: Optional[int] = None,
    linked_client_id: Optional[int] = None,
    limit: int = Query(default=envato_queries.DEFAULT_LIMIT, ge=1, le=envato_queries.MAX_LIMIT),
    offset: int = Query(default=0, ge=0),
    db: Session = Depends(get_operational_db),
    current_user: User = Depends(require_admin),
):
    filters = GenerationFilters(
        owner_user_id=owner_user_id,
        ownership_status=ownership_status,
        item_type=item_type,
        date_from=date_from,
        date_to=date_to,
        q=q,
        linked_task_id=linked_task_id,
        linked_client_id=linked_client_id,
    )
    items, total = envato_queries.list_generations(db, filters=filters, limit=limit, offset=offset)
    data = envato_queries.attach_owner_summaries(db, [item.to_dict() for item in items])
    return GenerationListOut(
        data=data,
        pagination=PaginationOut(limit=limit, offset=offset, total=total),
    )


@router.get("/generations/linked-tasks")
def list_generation_linked_tasks(
    db: Session = Depends(get_operational_db),
    current_user: User = Depends(require_admin),
):
    return {"success": True, "tasks": envato_queries.list_linked_tasks(db)}


@router.get("/generations/linked-clients")
def list_generation_linked_clients(
    db: Session = Depends(get_operational_db),
    current_user: User = Depends(require_admin),
):
    return {"success": True, "clients": envato_queries.list_linked_clients(db)}


@router.get("/generations/{generation_id}", response_model=GenerationDetailOut)
def get_generation_detail(
    generation_id: int,
    db: Session = Depends(get_operational_db),
    current_user: User = Depends(require_admin),
):
    generation = envato_queries.get_generation(db, generation_id)
    if not generation:
        raise HTTPException(status_code=404, detail="Generation not found")
    return GenerationDetailOut(data=generation.to_dict())


@router.get("/downloads", response_model=DownloadListOut)
def list_downloads(
    linked_task_id: Optional[int] = None,
    linked_client_id: Optional[int] = None,
    date_from: Optional[date] = None,
    date_to: Optional[date] = None,
    q: Optional[str] = None,
    limit: int = Query(default=envato_queries.DEFAULT_LIMIT, ge=1, le=envato_queries.MAX_LIMIT),
    offset: int = Query(default=0, ge=0),
    db: Session = Depends(get_operational_db),
    current_user: User = Depends(require_admin),
):
    filters = DownloadFilters(
        linked_task_id=linked_task_id,
        linked_client_id=linked_client_id,
        date_from=date_from,
        date_to=date_to,
        q=q,
    )
    items, total = envato_queries.list_downloads(db, filters=filters, limit=limit, offset=offset)
    data = envato_queries.attach_owner_summaries(db, [item.to_dict() for item in items])
    return DownloadListOut(
        data=data,
        pagination=PaginationOut(limit=limit, offset=offset, total=total),
    )


@router.get("/downloads/{download_id}", response_model=DownloadDetailOut)
def get_download_detail(
    download_id: int,
    db: Session = Depends(get_operational_db),
    current_user: User = Depends(require_admin),
):
    row = envato_queries.get_download(db, download_id)
    if not row:
        raise HTTPException(status_code=404, detail="Download not found")
    return DownloadDetailOut(data=row.to_dict())


@router.get("/metrics", response_model=MetricsOut)
def get_capture_metrics(
    db: Session = Depends(get_operational_db),
    current_user: User = Depends(require_admin),
):
    return MetricsOut(data=envato_queries.get_metrics(db))


@router.get("/analytics/credits-by-owner", response_model=MetricsOut)
def get_credits_by_owner(
    date_from: Optional[date] = None,
    date_to: Optional[date] = None,
    db: Session = Depends(get_operational_db),
    current_user: User = Depends(require_admin),
):
    return MetricsOut(data={"items": envato_queries.credits_by_owner(db, date_from=date_from, date_to=date_to)})


@router.get("/health", response_model=CaptureHealthOut)
def get_capture_health(
    user_id: int,
    db: Session = Depends(get_operational_db),
    current_user: User = Depends(require_admin),
):
    records = get_capture_health_for_user(db, user_id=user_id)
    return CaptureHealthOut(
        success=True,
        data={"installs": [capture_health_to_dict(record) for record in records]},
    )


@router.get("/events", response_model=EventListOut)
def list_capture_events(
    item_uuid: Optional[str] = None,
    client_event_id: Optional[str] = None,
    event_type: Optional[str] = None,
    user_id: Optional[int] = None,
    date_from: Optional[date] = None,
    date_to: Optional[date] = None,
    limit: int = Query(default=envato_queries.DEFAULT_LIMIT, ge=1, le=envato_queries.MAX_LIMIT),
    offset: int = Query(default=0, ge=0),
    db: Session = Depends(get_operational_db),
    current_user: User = Depends(require_admin),
):
    items, total = envato_queries.list_events(
        db,
        item_uuid=item_uuid,
        client_event_id=client_event_id,
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
    event = envato_queries.get_event(db, event_id)
    if not event:
        raise HTTPException(status_code=404, detail="Capture event not found")
    return EventDetailOut(data=event.to_dict())


@router.get("/users", response_model=UserListOut)
def list_capture_users(
    q: Optional[str] = None,
    limit: int = Query(default=envato_queries.DEFAULT_LIMIT, ge=1, le=envato_queries.MAX_LIMIT),
    offset: int = Query(default=0, ge=0),
    db: Session = Depends(get_operational_db),
    current_user: User = Depends(require_admin),
):
    items, total = envato_queries.list_users(db, q=q, limit=limit, offset=offset)
    return UserListOut(data=items, pagination=PaginationOut(limit=limit, offset=offset, total=total))


@router.get("/users/{user_id}", response_model=UserDetailOut)
def get_capture_user(
    user_id: int,
    db: Session = Depends(get_operational_db),
    current_user: User = Depends(require_admin),
):
    detail = envato_queries.get_user_detail(db, user_id)
    if not detail:
        raise HTTPException(status_code=404, detail="User not found")
    return UserDetailOut(data=detail)
