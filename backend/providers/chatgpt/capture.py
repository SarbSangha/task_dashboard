# providers/chatgpt/capture.py
"""
Raw capture ingestion (Phase 2A). Validates just enough to route/dedupe an
event, then stores it losslessly in ConversationCaptureEvent. No parsing, no
business logic, no assumptions about payload content - see README.md.

Normalization into ConversationRecord/ConversationPrompt/ConversationResponse
is a separate, later step (Phase 3) that reads from this table; it does not
happen here.
"""
import json
import logging
import time
from dataclasses import dataclass
from datetime import date, datetime
from typing import Optional

from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from models_new import ITPortalTool, ITPortalToolCredential, User
from providers.chatgpt.constants import ALL_EVENT_TYPES, CAPTURE_SCHEMA_VERSION, PROVIDER, TOOL_SLUGS
from providers.chatgpt.models import ConversationCaptureEvent
from routers.it_tools_router import _resolve_tool_credential

logger = logging.getLogger("chatgpt_capture")

# Process-local ingest outcome counters for the Capture Center's metrics
# endpoint. Deliberately in-memory (not a DB table): it's a debugging signal
# ("how is this server doing since it started"), not an audit trail - resets
# on restart, which is an acceptable tradeoff for a read-only diagnostics
# view rather than adding write load to every ingest call.
_INGEST_STATS = {"created": 0, "duplicate": 0, "rejected": 0}


def get_ingest_stats_snapshot() -> dict:
    return dict(_INGEST_STATS)


def _record_stat(status: str) -> None:
    if status in _INGEST_STATS:
        _INGEST_STATS[status] += 1


@dataclass
class CaptureIngestResult:
    status: str  # "created" | "duplicate" | "rejected"
    event: Optional[ConversationCaptureEvent] = None
    reason: Optional[str] = None


def resolve_chatgpt_tool(db: Session) -> Optional[ITPortalTool]:
    return (
        db.query(ITPortalTool)
        .filter(ITPortalTool.slug.in_(TOOL_SLUGS))
        .filter(ITPortalTool.is_active == True)  # noqa: E712 (SQLAlchemy comparison, not a Python bool check)
        .first()
    )


def resolve_chatgpt_credential(
    db: Session,
    *,
    tool_id: int,
    user_id: int,
    explicit_credential_id: Optional[int] = None,
) -> Optional[ITPortalToolCredential]:
    if explicit_credential_id:
        explicit = (
            db.query(ITPortalToolCredential)
            .filter(
                ITPortalToolCredential.id == explicit_credential_id,
                ITPortalToolCredential.tool_id == tool_id,
            )
            .first()
        )
        if explicit:
            return explicit
    return _resolve_tool_credential(db, tool_id, user_id)


def _parse_event_date(value: Optional[str]) -> date:
    if value:
        try:
            return datetime.strptime(value, "%Y-%m-%d").date()
        except ValueError:
            pass
    return datetime.utcnow().date()


def _payload_size(payload: Optional[dict]) -> int:
    try:
        return len(json.dumps(payload or {}))
    except (TypeError, ValueError):
        return 0


def _elapsed_ms(started: float) -> float:
    return round((time.perf_counter() - started) * 1000, 2)


def _log(*, event_type: str, status: str, duration_ms: float, payload_size: int, reason: Optional[str] = None) -> None:
    logger.info(
        "chatgpt_capture_event provider=%s event_type=%s status=%s duration_ms=%s payload_size=%s reason=%s",
        PROVIDER,
        event_type,
        status,
        duration_ms,
        payload_size,
        reason or "",
    )


def ingest_capture_event(
    db: Session,
    *,
    tool: ITPortalTool,
    credential_id: Optional[int],
    user: User,
    event_type: str,
    client_event_id: str,
    conversation_id: Optional[str],
    message_id: Optional[str],
    payload: Optional[dict],
    capture_version: Optional[int],
    extension_version: Optional[str],
    browser: Optional[str],
    tab_id: Optional[int],
    session_id: Optional[str],
    extension_session_id: Optional[str],
    event_date: Optional[str],
) -> CaptureIngestResult:
    """Idempotent insert: retrying the same (provider, credential, client_event_id) is always a
    no-op "duplicate" response - never a second row, never an error."""
    started = time.perf_counter()
    payload_size = _payload_size(payload)

    normalized_event_type = (event_type or "").strip().lower()
    if normalized_event_type not in ALL_EVENT_TYPES:
        reason = f"unknown event_type: {event_type!r}"
        _log(event_type=event_type or "", status="rejected", duration_ms=_elapsed_ms(started), payload_size=payload_size, reason=reason)
        _record_stat("rejected")
        return CaptureIngestResult(status="rejected", reason=reason)

    normalized_client_event_id = (client_event_id or "").strip()
    if not normalized_client_event_id:
        reason = "client_event_id is required"
        _log(event_type=normalized_event_type, status="rejected", duration_ms=_elapsed_ms(started), payload_size=payload_size, reason=reason)
        _record_stat("rejected")
        return CaptureIngestResult(status="rejected", reason=reason)

    existing_query = db.query(ConversationCaptureEvent).filter(
        ConversationCaptureEvent.provider == PROVIDER,
        ConversationCaptureEvent.client_event_id == normalized_client_event_id,
    )
    existing_query = (
        existing_query.filter(ConversationCaptureEvent.credential_id == credential_id)
        if credential_id is not None
        else existing_query.filter(ConversationCaptureEvent.credential_id.is_(None))
    )
    existing = existing_query.first()
    if existing:
        _log(event_type=normalized_event_type, status="duplicate", duration_ms=_elapsed_ms(started), payload_size=payload_size)
        _record_stat("duplicate")
        return CaptureIngestResult(status="duplicate", event=existing)

    event = ConversationCaptureEvent(
        tool_id=tool.id,
        credential_id=credential_id,
        user_id=user.id,
        provider=PROVIDER,
        event_type=normalized_event_type,
        client_event_id=normalized_client_event_id,
        provider_conversation_id=(conversation_id or None),
        provider_message_id=(message_id or None),
        payload_json=payload or {},
        capture_version=int(capture_version or CAPTURE_SCHEMA_VERSION),
        extension_version=extension_version,
        browser=browser,
        tab_id=tab_id,
        session_id=session_id,
        extension_session_id=extension_session_id,
        event_date=_parse_event_date(event_date),
    )
    db.add(event)
    try:
        db.commit()
    except IntegrityError:
        # Race: a concurrent request inserted the same client_event_id first.
        db.rollback()
        existing = existing_query.first()
        if existing:
            _log(event_type=normalized_event_type, status="duplicate", duration_ms=_elapsed_ms(started), payload_size=payload_size)
            _record_stat("duplicate")
            return CaptureIngestResult(status="duplicate", event=existing)
        raise
    db.refresh(event)
    _log(event_type=normalized_event_type, status="created", duration_ms=_elapsed_ms(started), payload_size=payload_size)
    _record_stat("created")
    return CaptureIngestResult(status="created", event=event)
