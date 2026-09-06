# providers/claude/router.py
"""
API surface for the Claude provider. Raw capture ingestion, plus
normalization triggered inline after each ingest - see
providers/chatgpt/router.py, which this mirrors closely (same envelope,
same idempotent-batch posture). Also carries a best-effort binary-attachment
capture endpoint (input images/files a prompt was submitted with) - see
providers/claude/attachments.py; no /capture/media (generated-output-image
capture) yet, since normal Claude responses don't produce a separate
generated-asset URL the way ChatGPT's image tool does.
"""
import logging
from datetime import date
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from database_config import get_operational_db
from models_new import User
from providers.claude import queries as claude_queries
from providers.claude.attachments import AttachmentCaptureError, store_attachment
from providers.claude.capture import ingest_capture_event, resolve_claude_credential, resolve_claude_tool
from providers.claude.health import capture_health_to_dict, get_capture_health_for_user, record_health_ping
from providers.claude.normalization import normalize_capture_events_batch
from providers.claude.queries import EventFilters
from providers.claude.schemas import (
    CaptureAttachmentIn,
    CaptureAttachmentOut,
    CaptureEventDetailOut,
    CaptureEventListOut,
    CaptureEventResult,
    CaptureEventsRequest,
    CaptureEventsResponse,
    CaptureHealthOut,
    CaptureHealthPingIn,
    CaptureMetricsOut,
    ConversationAttachmentsOut,
    ConversationDetailOut,
    ConversationListOut,
    ConversationMessagesOut,
    PaginationOut,
    UserDetailOut,
    UserListOut,
)
from utils.permissions import require_admin, require_user

router = APIRouter(prefix="/api/providers/claude", tags=["claude"])
logger = logging.getLogger("claude_router")


@router.post("/capture/events", response_model=CaptureEventsResponse)
def capture_events(
    payload: CaptureEventsRequest,
    db: Session = Depends(get_operational_db),
    current_user: User = Depends(require_user),
):
    tool = resolve_claude_tool(db)
    if not tool:
        return CaptureEventsResponse(
            success=False,
            results=[
                CaptureEventResult(client_event_id=item.client_event_id, status="rejected", reason="claude tool is not configured")
                for item in payload.events
            ],
        )

    explicit_credential_id = next((item.credential_id for item in payload.events if item.credential_id), None)
    credential = resolve_claude_credential(
        db,
        tool_id=tool.id,
        user_id=current_user.id,
        explicit_credential_id=explicit_credential_id,
    )
    credential_id = credential.id if credential else None

    results = []
    newly_created_events = []
    for item in payload.events:
        # See providers/chatgpt/router.py's identical try/except - isolates
        # one poison event (e.g. a stray NUL byte Postgres' JSONB rejects)
        # from 500-ing the entire batch and blocking every event queued
        # behind it on the extension's FIFO retry queue.
        try:
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
        except Exception:
            logger.exception(
                "claude capture event ingest failed unexpectedly, rejecting this event only client_event_id=%s event_type=%s",
                item.client_event_id,
                item.event_type,
            )
            db.rollback()
            results.append(
                CaptureEventResult(
                    client_event_id=item.client_event_id,
                    status="rejected",
                    id=None,
                    reason="internal error while storing this event - see server logs",
                )
            )
            continue

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

    if newly_created_events:
        # Normalization is best-effort relative to raw capture (each event
        # above is already durably committed) - a normalization failure
        # here must never turn a successful, lossless ingest into an error
        # response. See providers/chatgpt/router.py's identical guard.
        #
        # One retry, not zero: confirmed live that a batch's final db.commit()
        # can fail for reasons that have nothing to do with the events
        # themselves (a remote-Postgres connection hiccup mid-commit, a
        # transient lock) - a real capture (raw event durably stored,
        # response text intact) was left permanently stuck as "missing
        # response" in the dashboard until someone thought to run
        # scripts/backfill_claude_normalization.py by hand. Without a
        # SECOND raw event ever arriving for the same client_event_id
        # (ingest_capture_event's own dedup means a retried upload from the
        # extension is just silently marked "duplicate", never renormalized),
        # nothing else was ever going to retry this. A single immediate
        # retry, after rolling back whatever the failed attempt left dirty,
        # costs nothing on the (overwhelmingly common) success path and
        # turns a real fraction of these into a non-event instead of a
        # standing dashboard gap - the manual backfill script remains the
        # backstop for whatever this retry doesn't catch.
        try:
            normalize_capture_events_batch(db, newly_created_events)
        except Exception:
            logger.exception(
                "claude normalization batch failed for %d event(s) - retrying once",
                len(newly_created_events),
            )
            db.rollback()
            try:
                normalize_capture_events_batch(db, newly_created_events)
            except Exception:
                logger.exception("claude normalization retry also failed for %d event(s)", len(newly_created_events))
                db.rollback()

    return CaptureEventsResponse(success=True, results=results)


@router.post("/capture/health", response_model=CaptureHealthOut)
def report_capture_health(
    payload: CaptureHealthPingIn,
    db: Session = Depends(get_operational_db),
    current_user: User = Depends(require_user),
):
    tool = resolve_claude_tool(db)
    credential_id = payload.credential_id
    if tool and not credential_id:
        credential = resolve_claude_credential(db, tool_id=tool.id, user_id=current_user.id)
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
    """Best-effort binary upload (image/file a prompt was submitted with),
    separate from the lossless /capture/events batch - see
    providers/claude/attachments.py. Mirrors providers/chatgpt/router.py's
    identical endpoint, including releasing the pooled DB connection before
    the R2 upload (a real network round-trip) so it isn't parked idle under
    NullPool for the duration."""
    db.close()
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


# ==================== CAPTURE CENTER (read-only) ====================
# Admin-gated: raw captured events/conversations expose usage across every
# user's Claude sessions, not just the caller's own - same posture as
# providers/chatgpt/router.py's identical section.

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
    limit: int = Query(default=claude_queries.DEFAULT_EVENTS_LIMIT, ge=1, le=claude_queries.MAX_EVENTS_LIMIT),
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
    items, total = claude_queries.list_events(db, filters=filters, limit=limit, offset=offset)
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
    event = claude_queries.get_event(db, event_id)
    if not event:
        raise HTTPException(status_code=404, detail="Capture event not found")
    return CaptureEventDetailOut(data=event.to_dict())


@router.get("/conversations", response_model=ConversationListOut)
def list_capture_conversations(
    conversation_id: Optional[str] = None,
    date_from: Optional[date] = None,
    date_to: Optional[date] = None,
    q: Optional[str] = None,
    limit: int = Query(default=claude_queries.DEFAULT_CONVERSATIONS_LIMIT, ge=1, le=claude_queries.MAX_CONVERSATIONS_LIMIT),
    offset: int = Query(default=0, ge=0),
    db: Session = Depends(get_operational_db),
    current_user: User = Depends(require_admin),
):
    filters = EventFilters(conversation_id=conversation_id, date_from=date_from, date_to=date_to, q=q)
    items, total = claude_queries.list_conversations(db, filters=filters, limit=limit, offset=offset)
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
    detail = claude_queries.get_conversation_detail(db, conversation_id)
    if not detail:
        raise HTTPException(status_code=404, detail="Conversation not found")
    return ConversationDetailOut(data=detail)


@router.get("/conversations/{conversation_id}/messages", response_model=ConversationMessagesOut)
def get_conversation_messages(
    conversation_id: str,
    limit: int = Query(default=200, ge=1, le=claude_queries.MAX_EVENTS_LIMIT),
    db: Session = Depends(get_operational_db),
    current_user: User = Depends(require_admin),
):
    result = claude_queries.list_conversation_messages(db, conversation_id, limit=limit)
    if result is None:
        raise HTTPException(status_code=404, detail="Conversation not found")
    return ConversationMessagesOut(data=result)


@router.get("/conversations/{conversation_id}/attachments", response_model=ConversationAttachmentsOut)
def get_conversation_attachments(
    conversation_id: str,
    db: Session = Depends(get_operational_db),
    current_user: User = Depends(require_admin),
):
    return ConversationAttachmentsOut(data=claude_queries.list_conversation_attachments(db, conversation_id))


@router.get("/metrics", response_model=CaptureMetricsOut)
def get_capture_metrics(
    db: Session = Depends(get_operational_db),
    current_user: User = Depends(require_admin),
):
    return CaptureMetricsOut(data=claude_queries.get_metrics(db))


@router.get("/users", response_model=UserListOut)
def list_capture_users(
    q: Optional[str] = None,
    health: Optional[str] = None,
    department: Optional[str] = None,
    sort: str = "recent",
    limit: int = Query(default=claude_queries.DEFAULT_CONVERSATIONS_LIMIT, ge=1, le=claude_queries.MAX_CONVERSATIONS_LIMIT),
    offset: int = Query(default=0, ge=0),
    db: Session = Depends(get_operational_db),
    current_user: User = Depends(require_admin),
):
    items, total = claude_queries.list_users(
        db, q=q, health_filter=health, department=department, sort=sort, limit=limit, offset=offset
    )
    return UserListOut(data=items, pagination=PaginationOut(limit=limit, offset=offset, total=total))


@router.get("/users/{user_id}", response_model=UserDetailOut)
def get_capture_user(
    user_id: int,
    db: Session = Depends(get_operational_db),
    current_user: User = Depends(require_admin),
):
    detail = claude_queries.get_user_detail(db, user_id)
    if not detail:
        raise HTTPException(status_code=404, detail="User not found")
    return UserDetailOut(data=detail)
