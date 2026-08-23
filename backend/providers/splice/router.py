# providers/splice/router.py
"""
API surface for the Splice provider. Mirrors providers/epidemicsound/router.py's
structure, minus the Adapt-equivalent capture/read endpoints (this provider
has only the downloads surface - see providers/splice/models.py's
SpliceDownload docstring). Also carries a raw-events listing (backs the
dashboard's Developer Tools drawer, same as every other provider) and a
capture-health ping (background-splice-capture.js pings this on a timer, same
pattern as every other provider's background script) so those calls have
somewhere real to land instead of 404ing.

Confirmed exact route set: POST /capture/events, POST /capture/download-media,
POST /capture/health, GET /health, GET /downloads,
GET /downloads/{download_id}, GET /events, GET /events/{event_id} -
NOT /sync/cursor (no reconciliation walker for this provider).
"""
import base64
import logging
from datetime import date, datetime
from mimetypes import guess_extension
from typing import Optional
from uuid import uuid4

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from sqlalchemy.orm import Session

from database_config import get_operational_db
from models_new import User
from providers.splice import queries as splice_queries
from providers.splice.capture import (
    ingest_capture_event,
    resolve_splice_actor,
    resolve_splice_credential,
    resolve_splice_tool,
)
from providers.splice.constants import INGEST_COMMIT_CHUNK_SIZE
from providers.splice.health import capture_health_to_dict, get_capture_health_for_user, record_health_ping
from providers.splice.models import SpliceCaptureEvent, SpliceDownload
from providers.splice.normalization import normalize_capture_events_batch
from providers.splice.queries import DownloadFilters
from providers.splice.schemas import (
    CaptureDownloadMediaIn,
    CaptureDownloadMediaResult,
    CaptureEventResult,
    CaptureEventsRequest,
    CaptureEventsResponse,
    CaptureHealthOut,
    CaptureHealthPingIn,
    DownloadDetailOut,
    DownloadListOut,
    EventDetailOut,
    EventListOut,
    PaginationOut,
)
from utils import r2_storage
from utils.permissions import require_admin

router = APIRouter(prefix="/api/providers/splice", tags=["splice"])
logger = logging.getLogger("splice_router")


def _ownership_confidence(*, has_ticket: bool) -> str:
    return "ticket" if has_ticket else "session"


@router.post("/capture/events", response_model=CaptureEventsResponse)
def capture_events(
    payload: CaptureEventsRequest,
    request: Request,
    db: Session = Depends(get_operational_db),
):
    tool = resolve_splice_tool(db)
    if not tool:
        return CaptureEventsResponse(
            success=False,
            results=[
                CaptureEventResult(client_event_id=item.client_event_id, status="rejected", reason="splice tool is not configured")
                for item in payload.events
            ],
        )

    results = []
    newly_created_events = []
    pending_since_commit = 0
    # Memoized per unique ticket triple within the batch, not once per
    # request - same reasoning as providers/epidemicsound/router.py's
    # identical comment (this queue is shared across the whole browser, a
    # single flush batch can legitimately mix events from different
    # tabs/tickets).
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
                current_user = resolve_splice_actor(
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

            credential = resolve_splice_credential(
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
            download_id=item.download_id,
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
            logger.exception("splice normalization batch failed for %d event(s)", len(newly_created_events))
            db.rollback()

    return CaptureEventsResponse(success=True, results=results)


MAX_DOWNLOAD_MEDIA_BYTES = 100 * 1024 * 1024  # generous for a single sample/loop audio file


@router.post("/capture/download-media", response_model=CaptureDownloadMediaResult)
def capture_download_media(
    payload: CaptureDownloadMediaIn,
    db: Session = Depends(get_operational_db),
):
    """Mirrors providers/epidemicsound/router.py's capture_download_media -
    see CaptureDownloadMediaIn's own docstring for why client_event_id, not a
    per-item id, is the correlation key here. Not queued/retried the
    durable-outbox way capture_events is: the extension itself already
    retries a few times on download_not_found, and a miss here is
    self-healing - the exact same media gets re-observed and re-pushed if
    the same sample is downloaded again. The source URL's 119-second expiry
    means the extension pushes bytes here almost immediately - an
    extension-side timing concern, not a backend one."""
    event = (
        db.query(SpliceCaptureEvent)
        .filter(SpliceCaptureEvent.client_event_id == payload.client_event_id)
        .order_by(SpliceCaptureEvent.id.desc())
        .first()
    )
    if not event:
        # The download_click event itself hasn't landed/committed yet (the
        # extension's own capture queue can flush after this push fires) -
        # not an error, the extension retries shortly.
        return CaptureDownloadMediaResult(success=False, status="download_not_found")

    download = (
        db.query(SpliceDownload)
        .filter(SpliceDownload.source_capture_event_id == event.id)
        .first()
    )
    if not download:
        # The event landed but normalization hasn't produced the
        # SpliceDownload row yet - same retry-shortly posture.
        return CaptureDownloadMediaResult(success=False, status="download_not_found")

    if download.asset_mirror_status == "mirrored" and download.mirrored_asset_key:
        return CaptureDownloadMediaResult(success=True, status="already_mirrored")

    if not r2_storage.is_configured():
        return CaptureDownloadMediaResult(success=False, status="not_configured")

    try:
        media_bytes = base64.b64decode(payload.media_base64, validate=True)
    except Exception:
        return CaptureDownloadMediaResult(success=False, status="invalid_media")

    if not media_bytes or len(media_bytes) > MAX_DOWNLOAD_MEDIA_BYTES:
        return CaptureDownloadMediaResult(success=False, status="invalid_media")

    content_type = payload.content_type or "application/octet-stream"
    extension = guess_extension(content_type.split(";")[0].strip()) or ".bin"
    download_id = download.id
    key = f"splice-mirror/{download_id}/{uuid4().hex[:8]}-asset{extension}"

    # Release the connection for the upload - same reasoning as
    # providers/epidemicsound/router.py's identical comment: everything
    # above only READ from the database, so holding the connection open
    # across a put_object of up to MAX_DOWNLOAD_MEDIA_BYTES would leave a
    # Postgres connection idle-in-transaction for the length of a remote
    # upload.
    #
    # `download` is detached by the close, so the write below re-queries by
    # id rather than mutating the stale instance.
    db.close()
    r2_storage.put_object(key, media_bytes, content_type=content_type)

    download = db.query(SpliceDownload).filter(SpliceDownload.id == download_id).first()
    if not download:
        # Deleted while the upload was in flight - the object is in R2 but
        # has no row to hang off. Nothing to report as mirrored.
        return CaptureDownloadMediaResult(success=False, status="download_not_found")

    download.mirrored_asset_key = key
    download.asset_mirror_status = "mirrored"
    download.asset_mirror_attempted_at = datetime.utcnow()
    download.asset_mirror_error = None
    db.commit()

    return CaptureDownloadMediaResult(success=True, status="mirrored")


@router.post("/capture/health", response_model=CaptureHealthOut)
def report_capture_health(
    payload: CaptureHealthPingIn,
    request: Request,
    db: Session = Depends(get_operational_db),
):
    tool = resolve_splice_tool(db)
    current_user: Optional[User] = None
    try:
        if tool:
            current_user = resolve_splice_actor(
                request=request,
                db=db,
                tool=tool,
                usage_ticket=payload.usage_ticket,
                extension_ticket=payload.extension_ticket,
            )
    except HTTPException:
        return CaptureHealthOut(success=False, data={"reason": "actor_unresolved"})

    if not current_user:
        return CaptureHealthOut(success=False, data={"reason": "splice tool is not configured"})

    credential_id = payload.credential_id
    if tool and not credential_id:
        credential = resolve_splice_credential(db, tool_id=tool.id, user_id=current_user.id)
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


@router.get("/downloads", response_model=DownloadListOut)
def list_downloads(
    linked_task_id: Optional[int] = None,
    linked_client_id: Optional[int] = None,
    date_from: Optional[date] = None,
    date_to: Optional[date] = None,
    q: Optional[str] = None,
    limit: int = Query(default=splice_queries.DEFAULT_LIMIT, ge=1, le=splice_queries.MAX_LIMIT),
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
    items, total = splice_queries.list_downloads(db, filters=filters, limit=limit, offset=offset)
    data = splice_queries.attach_owner_summaries(db, [item.to_dict() for item in items])
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
    row = splice_queries.get_download(db, download_id)
    if not row:
        raise HTTPException(status_code=404, detail="Download not found")
    return DownloadDetailOut(data=row.to_dict())


@router.get("/events", response_model=EventListOut)
def list_capture_events(
    client_event_id: Optional[str] = None,
    event_type: Optional[str] = None,
    user_id: Optional[int] = None,
    date_from: Optional[date] = None,
    date_to: Optional[date] = None,
    limit: int = Query(default=splice_queries.DEFAULT_LIMIT, ge=1, le=splice_queries.MAX_LIMIT),
    offset: int = Query(default=0, ge=0),
    db: Session = Depends(get_operational_db),
    current_user: User = Depends(require_admin),
):
    items, total = splice_queries.list_events(
        db,
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
    event = splice_queries.get_event(db, event_id)
    if not event:
        raise HTTPException(status_code=404, detail="Capture event not found")
    return EventDetailOut(data=event.to_dict())
