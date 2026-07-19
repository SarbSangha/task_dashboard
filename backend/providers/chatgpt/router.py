# providers/chatgpt/router.py
"""
API surface for the ChatGPT provider. Phase 2A raw capture ingestion, plus
Phase 3 normalization triggered inline after each ingest (see
providers.chatgpt.normalization).
"""
import logging
from datetime import date
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from database_config import get_operational_db
from models_new import User
from providers.chatgpt import queries as chatgpt_queries
from providers.chatgpt.attachments import AttachmentCaptureError, store_attachment
from providers.chatgpt.capture import ingest_capture_event, resolve_chatgpt_credential, resolve_chatgpt_tool
from providers.chatgpt.health import capture_health_to_dict, get_capture_health_for_user, record_health_ping
from providers.chatgpt.media import MediaCaptureError, store_media_asset
from providers.chatgpt.normalization import normalize_capture_events_batch
from providers.chatgpt.queries import EventFilters
from providers.chatgpt.schemas import (
    CaptureAttachmentIn,
    CaptureAttachmentOut,
    CaptureEventDetailOut,
    CaptureEventListOut,
    CaptureEventResult,
    CaptureEventsRequest,
    CaptureEventsResponse,
    CaptureHealthOut,
    CaptureHealthPingIn,
    CaptureMediaIn,
    CaptureMediaOut,
    CaptureMetricsOut,
    ConversationAttachmentsOut,
    ConversationDetailOut,
    ConversationListOut,
    ConversationMediaOut,
    ConversationMessagesOut,
    PaginationOut,
    UserDetailOut,
    UserListOut,
)
from utils.permissions import require_admin, require_user

router = APIRouter(prefix="/api/providers/chatgpt", tags=["chatgpt"])
logger = logging.getLogger("chatgpt_router")


@router.post("/capture/events", response_model=CaptureEventsResponse)
def capture_events(
    payload: CaptureEventsRequest,
    db: Session = Depends(get_operational_db),
    current_user: User = Depends(require_user),
):
    tool = resolve_chatgpt_tool(db)
    if not tool:
        return CaptureEventsResponse(
            success=False,
            results=[
                CaptureEventResult(client_event_id=item.client_event_id, status="rejected", reason="chatgpt tool is not configured")
                for item in payload.events
            ],
        )

    explicit_credential_id = next((item.credential_id for item in payload.events if item.credential_id), None)
    credential = resolve_chatgpt_credential(
        db,
        tool_id=tool.id,
        user_id=current_user.id,
        explicit_credential_id=explicit_credential_id,
    )
    credential_id = credential.id if credential else None

    results = []
    newly_created_events = []
    for item in payload.events:
        outcome = ingest_capture_event(
            db,
            tool=tool,
            credential_id=credential_id,
            user=current_user,
            event_type=item.event_type,
            client_event_id=item.client_event_id,
            conversation_id=item.conversation_id,
            message_id=item.message_id,
            payload=item.payload,
            capture_version=item.capture_version,
            extension_version=item.extension_version,
            browser=item.browser,
            tab_id=item.tab_id,
            session_id=item.session_id,
            extension_session_id=item.extension_session_id,
            event_date=item.event_date,
        )
        if outcome.status == "created" and outcome.event is not None:
            # Duplicates are skipped: they were already normalized on their
            # first "created" pass.
            newly_created_events.append(outcome.event)
        results.append(
            CaptureEventResult(
                client_event_id=item.client_event_id,
                status=outcome.status,
                id=outcome.event.id if outcome.event else None,
                reason=outcome.reason,
            )
        )

    if newly_created_events:
        # Phase 3 normalization is best-effort relative to raw capture (each
        # event above is already durably committed by ingest_capture_event)
        # - batched into one commit for the whole request rather than one
        # per event, since a request can carry up to 200 events and the
        # operational database is a remote Postgres; see
        # normalize_capture_events_batch's docstring for why that matters.
        # A normalization failure here must never turn a successful,
        # lossless ingest into an error response.
        try:
            normalize_capture_events_batch(db, newly_created_events)
        except Exception:
            logger.exception("chatgpt normalization batch failed for %d event(s)", len(newly_created_events))
            db.rollback()

    return CaptureEventsResponse(success=True, results=results)


@router.post("/capture/health", response_model=CaptureHealthOut)
def report_capture_health(
    payload: CaptureHealthPingIn,
    db: Session = Depends(get_operational_db),
    current_user: User = Depends(require_user),
):
    tool = resolve_chatgpt_tool(db)
    credential_id = payload.credential_id
    if tool and not credential_id:
        credential = resolve_chatgpt_credential(db, tool_id=tool.id, user_id=current_user.id)
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


@router.get("/capture/health", response_model=CaptureHealthOut)
def get_capture_health(
    db: Session = Depends(get_operational_db),
    current_user: User = Depends(require_user),
):
    records = get_capture_health_for_user(db, user_id=current_user.id)
    return CaptureHealthOut(
        success=True,
        data={"installs": [capture_health_to_dict(record) for record in records]},
    )


@router.post("/capture/attachments", response_model=CaptureAttachmentOut)
def capture_attachment(
    payload: CaptureAttachmentIn,
    db: Session = Depends(get_operational_db),
    current_user: User = Depends(require_user),
):
    """Best-effort binary upload (image/file), separate from the lossless
    /capture/events batch - see providers/chatgpt/attachments.py."""
    try:
        record = store_attachment(
            db,
            user=current_user,
            conversation_id=payload.conversation_id,
            client_event_id=payload.client_event_id,
            kind=payload.kind,
            file_name=payload.file_name,
            mime_type=payload.mime_type,
            data_url=payload.data_url,
        )
    except AttachmentCaptureError as error:
        raise HTTPException(status_code=error.status_code, detail=str(error)) from error
    return CaptureAttachmentOut(data=record.to_dict())


@router.post("/capture/media", response_model=CaptureMediaOut)
def capture_media(
    payload: CaptureMediaIn,
    db: Session = Depends(get_operational_db),
    current_user: User = Depends(require_user),
):
    """Additive media-asset capture (generated/response images and videos),
    separate from both the lossless /capture/events batch and the
    /capture/attachments binary-upload path - see providers/chatgpt/media.py.
    Does not read or write anything the text-capture pipeline
    (capture.py/normalization.py) touches."""
    try:
        asset = store_media_asset(
            db,
            user=current_user,
            provider_conversation_id=payload.provider_conversation_id,
            message_id=payload.message_id,
            assistant_message_id=payload.assistant_message_id,
            correlation_id=payload.correlation_id,
            media_type=payload.media_type,
            generated=payload.generated,
            data_url=payload.data_url,
            source_url=payload.source_url,
            thumbnail_url=payload.thumbnail_url,
            file_name=payload.file_name,
            mime_type=payload.mime_type,
            width=payload.width,
            height=payload.height,
            duration_ms=payload.duration_ms,
            provider_asset_id=payload.provider_asset_id,
            prompt=payload.prompt,
            alt_text=payload.alt_text,
            source=payload.source,
            display_order=payload.display_order,
            metadata=payload.metadata,
        )
    except MediaCaptureError as error:
        raise HTTPException(status_code=error.status_code, detail=str(error)) from error
    return CaptureMediaOut(data=asset.to_dict())


# ==================== CAPTURE CENTER (read-only) ====================
# Everything below is admin-gated: raw captured events/conversations expose
# usage across every user's ChatGPT sessions, not just the caller's own -
# same posture as generation_recovery_router's Capture Center for Kling.

@router.get("/events", response_model=CaptureEventListOut)
def list_capture_events(
    conversation_id: Optional[str] = None,
    event_type: Optional[str] = None,
    client_event_id: Optional[str] = None,
    capture_version: Optional[int] = None,
    extension_version: Optional[str] = None,
    date_from: Optional[date] = None,
    date_to: Optional[date] = None,
    q: Optional[str] = None,
    user_id: Optional[int] = None,
    limit: int = Query(default=chatgpt_queries.DEFAULT_EVENTS_LIMIT, ge=1, le=chatgpt_queries.MAX_EVENTS_LIMIT),
    offset: int = Query(default=0, ge=0),
    db: Session = Depends(get_operational_db),
    current_user: User = Depends(require_admin),
):
    filters = EventFilters(
        conversation_id=conversation_id,
        event_type=event_type,
        client_event_id=client_event_id,
        capture_version=capture_version,
        extension_version=extension_version,
        date_from=date_from,
        date_to=date_to,
        q=q,
        user_id=user_id,
    )
    items, total = chatgpt_queries.list_events(db, filters=filters, limit=limit, offset=offset)
    return CaptureEventListOut(
        data=[item.to_dict() for item in items],
        pagination=PaginationOut(limit=limit, offset=offset, total=total),
    )


@router.get("/events/{event_id}", response_model=CaptureEventDetailOut)
def get_capture_event(
    event_id: int,
    db: Session = Depends(get_operational_db),
    current_user: User = Depends(require_admin),
):
    event = chatgpt_queries.get_event(db, event_id)
    if not event:
        raise HTTPException(status_code=404, detail="Capture event not found")
    return CaptureEventDetailOut(data=event.to_dict())


@router.get("/conversations", response_model=ConversationListOut)
def list_capture_conversations(
    conversation_id: Optional[str] = None,
    event_type: Optional[str] = None,
    date_from: Optional[date] = None,
    date_to: Optional[date] = None,
    q: Optional[str] = None,
    limit: int = Query(default=chatgpt_queries.DEFAULT_CONVERSATIONS_LIMIT, ge=1, le=chatgpt_queries.MAX_CONVERSATIONS_LIMIT),
    offset: int = Query(default=0, ge=0),
    db: Session = Depends(get_operational_db),
    current_user: User = Depends(require_admin),
):
    filters = EventFilters(conversation_id=conversation_id, event_type=event_type, date_from=date_from, date_to=date_to, q=q)
    items, total = chatgpt_queries.list_conversations(db, filters=filters, limit=limit, offset=offset)
    return ConversationListOut(
        data=items,
        pagination=PaginationOut(limit=limit, offset=offset, total=total),
    )


@router.get("/conversations/{conversation_id}", response_model=ConversationDetailOut)
def get_conversation_detail(
    conversation_id: str,
    db: Session = Depends(get_operational_db),
    current_user: User = Depends(require_admin),
):
    detail = chatgpt_queries.get_conversation_detail(db, conversation_id)
    if not detail:
        raise HTTPException(status_code=404, detail="Conversation not found")
    return ConversationDetailOut(data=detail)


@router.get("/conversations/{conversation_id}/messages", response_model=ConversationMessagesOut)
def get_conversation_messages(
    conversation_id: str,
    limit: int = Query(default=200, ge=1, le=chatgpt_queries.MAX_EVENTS_LIMIT),
    db: Session = Depends(get_operational_db),
    current_user: User = Depends(require_admin),
):
    result = chatgpt_queries.list_conversation_messages(db, conversation_id, limit=limit)
    if result is None:
        raise HTTPException(status_code=404, detail="Conversation not found")
    return ConversationMessagesOut(data=result)


@router.get("/conversations/{conversation_id}/attachments", response_model=ConversationAttachmentsOut)
def get_conversation_attachments(
    conversation_id: str,
    db: Session = Depends(get_operational_db),
    current_user: User = Depends(require_admin),
):
    return ConversationAttachmentsOut(data=chatgpt_queries.list_conversation_attachments(db, conversation_id))


@router.get("/conversations/{conversation_id}/media", response_model=ConversationMediaOut)
def get_conversation_media(
    conversation_id: str,
    db: Session = Depends(get_operational_db),
    current_user: User = Depends(require_admin),
):
    """Generated/response media assets (ConversationMediaAsset) for one
    conversation - the read side of the media capture layer (see media.py).
    Separate from /attachments (uploaded files); the dashboard renders these
    as a gallery via /api/files/open?url=."""
    return ConversationMediaOut(data=chatgpt_queries.list_conversation_media(db, conversation_id))


@router.get("/metrics", response_model=CaptureMetricsOut)
def get_capture_metrics(
    db: Session = Depends(get_operational_db),
    current_user: User = Depends(require_admin),
):
    return CaptureMetricsOut(data=chatgpt_queries.get_metrics(db))


@router.get("/users", response_model=UserListOut)
def list_capture_users(
    q: Optional[str] = None,
    health: Optional[str] = None,
    department: Optional[str] = None,
    sort: str = "recent",
    limit: int = Query(default=chatgpt_queries.DEFAULT_CONVERSATIONS_LIMIT, ge=1, le=chatgpt_queries.MAX_CONVERSATIONS_LIMIT),
    offset: int = Query(default=0, ge=0),
    db: Session = Depends(get_operational_db),
    current_user: User = Depends(require_admin),
):
    items, total = chatgpt_queries.list_users(
        db, q=q, health_filter=health, department=department, sort=sort, limit=limit, offset=offset
    )
    return UserListOut(data=items, pagination=PaginationOut(limit=limit, offset=offset, total=total))


@router.get("/users/{user_id}", response_model=UserDetailOut)
def get_capture_user(
    user_id: int,
    db: Session = Depends(get_operational_db),
    current_user: User = Depends(require_admin),
):
    detail = chatgpt_queries.get_user_detail(db, user_id)
    if not detail:
        raise HTTPException(status_code=404, detail="User not found")
    return UserDetailOut(data=detail)


@router.get("/users/{user_id}/conversations", response_model=ConversationListOut)
def list_user_capture_conversations(
    user_id: int,
    event_type: Optional[str] = None,
    date_from: Optional[date] = None,
    date_to: Optional[date] = None,
    q: Optional[str] = None,
    limit: int = Query(default=chatgpt_queries.DEFAULT_CONVERSATIONS_LIMIT, ge=1, le=chatgpt_queries.MAX_CONVERSATIONS_LIMIT),
    offset: int = Query(default=0, ge=0),
    db: Session = Depends(get_operational_db),
    current_user: User = Depends(require_admin),
):
    # Thin wrapper around the existing list_conversations - user_id is just
    # another EventFilters field, so pagination/health/preview logic isn't
    # duplicated here at all.
    filters = EventFilters(user_id=user_id, event_type=event_type, date_from=date_from, date_to=date_to, q=q)
    items, total = chatgpt_queries.list_conversations(db, filters=filters, limit=limit, offset=offset)
    return ConversationListOut(
        data=items,
        pagination=PaginationOut(limit=limit, offset=offset, total=total),
    )
