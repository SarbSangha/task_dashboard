# providers/higgsfield/capture.py
"""
Raw capture ingestion. Validates just enough to route/dedupe an event, then
stores it losslessly in HiggsfieldCaptureEvent. No parsing of the Higgsfield
payload happens here - see normalization.py for that. Mirrors
providers/heygen/capture.py (this package's template) near-verbatim.

Identity/ownership resolution is the one piece of business logic this layer
owns (rather than deferring to normalization.py), because it must happen
before the row is even written: _resolve_usage_event_actor is the exact same
function Kling/Freepik/HeyGen's capture paths use to answer "who is the
logged-in employee right now" from a launch ticket, reused verbatim rather
than reimplemented.
"""
import json
import logging
import time
from dataclasses import dataclass
from datetime import date, datetime
from typing import Optional

from fastapi import Request
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from models_new import ITPortalTool, ITPortalToolCredential, User
from providers.higgsfield.constants import ALL_EVENT_TYPES, CAPTURE_SCHEMA_VERSION, PROVIDER, TOOL_SLUGS
from providers.higgsfield.models import HiggsfieldCaptureEvent
from utils.client_gate import validate_client_for_generation
from utils.task_gate import validate_task_for_generation

# routers.it_tools_router is imported lazily inside the two wrappers below,
# NOT at module scope - see providers/freepik/capture.py's docstring for the
# import-cycle this avoids; the same cycle exists here.

logger = logging.getLogger("higgsfield_capture")

_INGEST_STATS = {"created": 0, "duplicate": 0, "rejected": 0}


def get_ingest_stats_snapshot() -> dict:
    return dict(_INGEST_STATS)


def _record_stat(status: str) -> None:
    if status in _INGEST_STATS:
        _INGEST_STATS[status] += 1


@dataclass
class CaptureIngestResult:
    status: str  # "created" | "duplicate" | "rejected"
    event: Optional[HiggsfieldCaptureEvent] = None
    reason: Optional[str] = None


def resolve_higgsfield_tool(db: Session) -> Optional[ITPortalTool]:
    return (
        db.query(ITPortalTool)
        .filter(ITPortalTool.slug.in_(TOOL_SLUGS))
        .filter(ITPortalTool.is_active == True)  # noqa: E712
        .first()
    )


def resolve_higgsfield_actor(
    *,
    request: Request,
    db: Session,
    tool: ITPortalTool,
    usage_ticket: Optional[str],
    extension_ticket: Optional[str],
) -> User:
    """Thin, provider-named wrapper around _resolve_usage_event_actor - kept
    here (rather than calling the shared function directly from router.py)
    so every provider-specific caller goes through one place if Higgsfield
    ever needs its own attribution wrinkle later."""
    from routers.it_tools_router import _resolve_usage_event_actor

    return _resolve_usage_event_actor(
        request=request,
        db=db,
        tool=tool,
        usage_ticket=usage_ticket or "",
        extension_ticket=extension_ticket or "",
    )


def resolve_higgsfield_credential(
    db: Session,
    *,
    tool_id: int,
    user_id: int,
    explicit_credential_id: Optional[int] = None,
) -> Optional[ITPortalToolCredential]:
    from routers.it_tools_router import _resolve_usage_event_credential

    return _resolve_usage_event_credential(
        db,
        tool_id=tool_id,
        user_id=user_id,
        explicit_credential_id=explicit_credential_id,
    )


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
        "higgsfield_capture_event provider=%s event_type=%s status=%s duration_ms=%s payload_size=%s reason=%s",
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
    generation_id: Optional[str],
    project_id: Optional[str],
    payload: Optional[dict],
    capture_version: Optional[int],
    extension_version: Optional[str],
    browser: Optional[str],
    tab_id: Optional[int],
    session_id: Optional[str],
    extension_session_id: Optional[str],
    event_date: Optional[str],
    ownership_confidence: Optional[str] = None,
    task_id: Optional[int] = None,
    client_id: Optional[int] = None,
) -> CaptureIngestResult:
    """Idempotent insert: retrying the same (provider, credential, client_event_id)
    is always a no-op "duplicate" response - never a second row, never an error.

    Flushes inside a SAVEPOINT and does NOT commit - the caller owns the
    transaction and commits a chunk of events at a time (see
    constants.INGEST_COMMIT_CHUNK_SIZE).
    """
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

    existing_query = db.query(HiggsfieldCaptureEvent).filter(
        HiggsfieldCaptureEvent.provider == PROVIDER,
        HiggsfieldCaptureEvent.client_event_id == normalized_client_event_id,
    )
    existing_query = (
        existing_query.filter(HiggsfieldCaptureEvent.credential_id == credential_id)
        if credential_id is not None
        else existing_query.filter(HiggsfieldCaptureEvent.credential_id.is_(None))
    )
    existing = existing_query.first()
    if existing:
        _log(event_type=normalized_event_type, status="duplicate", duration_ms=_elapsed_ms(started), payload_size=payload_size)
        _record_stat("duplicate")
        return CaptureIngestResult(status="duplicate", event=existing)

    validated_task_id: Optional[int] = None
    validated_task_name: Optional[str] = None
    if task_id is not None:
        # Never trust the client's task_id at face value - re-check it's
        # still an active task this user is actually assigned to. A stale/
        # tampered/deleted task degrades to "captured without task
        # attribution" rather than failing the whole capture.
        task = validate_task_for_generation(db, task_id, user.id)
        if task:
            validated_task_id = task.id
            validated_task_name = task.title
        else:
            logger.warning(
                "higgsfield_capture_event dropped invalid task attribution user_id=%s task_id=%s",
                user.id, task_id,
            )

    validated_client_id: Optional[int] = None
    validated_client_name: Optional[str] = None
    if client_id is not None:
        client = validate_client_for_generation(db, client_id)
        if client:
            validated_client_id = client.id
            validated_client_name = client.name
        else:
            logger.warning(
                "higgsfield_capture_event dropped invalid client attribution user_id=%s client_id=%s",
                user.id, client_id,
            )

    event = HiggsfieldCaptureEvent(
        tool_id=tool.id,
        credential_id=credential_id,
        user_id=user.id,
        provider=PROVIDER,
        event_type=normalized_event_type,
        client_event_id=normalized_client_event_id,
        provider_generation_id=(generation_id or None),
        provider_project_id=(project_id or None),
        ownership_confidence=ownership_confidence,
        linked_task_id=validated_task_id,
        linked_task_name=validated_task_name,
        linked_client_id=validated_client_id,
        linked_client_name=validated_client_name,
        payload_json=payload or {},
        capture_version=int(capture_version or CAPTURE_SCHEMA_VERSION),
        extension_version=extension_version,
        browser=browser,
        tab_id=tab_id,
        session_id=session_id,
        extension_session_id=extension_session_id,
        event_date=_parse_event_date(event_date),
    )
    savepoint = db.begin_nested()
    try:
        db.add(event)
        # Populates event.id and the Python-side created_at default that
        # normalization's freshness gate reads - no COMMIT or refresh needed.
        db.flush()
        savepoint.commit()
    except IntegrityError:
        # Race: a concurrent request inserted the same client_event_id first.
        # Unwinds this event only; siblings already flushed in this
        # transaction keep their work.
        savepoint.rollback()
        existing = existing_query.first()
        if existing:
            _log(event_type=normalized_event_type, status="duplicate", duration_ms=_elapsed_ms(started), payload_size=payload_size)
            _record_stat("duplicate")
            return CaptureIngestResult(status="duplicate", event=existing)
        raise
    _log(event_type=normalized_event_type, status="created", duration_ms=_elapsed_ms(started), payload_size=payload_size)
    _record_stat("created")
    return CaptureIngestResult(status="created", event=event)
