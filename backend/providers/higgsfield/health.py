# providers/higgsfield/health.py
"""
Capture health: tracks the latest known state of each extension install's
local Higgsfield retry queue. Mirrors providers/heygen/health.py exactly.
"""
from datetime import datetime
from typing import Optional

from sqlalchemy.orm import Session

from providers.higgsfield.constants import (
    HEALTH_BACKLOG_QUEUE_LENGTH_THRESHOLD,
    HEALTH_STALE_PING_THRESHOLD_SECONDS,
    HEALTH_STATUS_BACKLOGGED,
    HEALTH_STATUS_DEGRADED,
    HEALTH_STATUS_HEALTHY,
    HEALTH_STATUS_OFFLINE,
    PROVIDER,
)
from providers.higgsfield.models import HiggsfieldCaptureHealth


def _parse_iso_datetime(value: Optional[str]) -> Optional[datetime]:
    if not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00")).replace(tzinfo=None)
    except (TypeError, ValueError):
        return None


def record_health_ping(
    db: Session,
    *,
    user_id: int,
    tool_id: Optional[int],
    credential_id: Optional[int],
    extension_session_id: Optional[str],
    extension_version: Optional[str],
    queue_length: int,
    events_waiting: int,
    oldest_pending_event_at: Optional[str],
    retry_count: int,
    last_capture_event_at: Optional[str],
    last_successful_upload_at: Optional[str],
    last_failed_upload_at: Optional[str],
    average_upload_time_ms: Optional[int],
    offline_since: Optional[str],
) -> HiggsfieldCaptureHealth:
    if extension_session_id:
        existing = (
            db.query(HiggsfieldCaptureHealth)
            .filter(
                HiggsfieldCaptureHealth.provider == PROVIDER,
                HiggsfieldCaptureHealth.extension_session_id == extension_session_id,
            )
            .first()
        )
    else:
        existing = (
            db.query(HiggsfieldCaptureHealth)
            .filter(
                HiggsfieldCaptureHealth.provider == PROVIDER,
                HiggsfieldCaptureHealth.user_id == user_id,
                HiggsfieldCaptureHealth.extension_session_id.is_(None),
            )
            .order_by(HiggsfieldCaptureHealth.reported_at.desc())
            .first()
        )

    record = existing or HiggsfieldCaptureHealth(provider=PROVIDER, user_id=user_id)
    record.tool_id = tool_id
    record.credential_id = credential_id
    record.user_id = user_id
    record.extension_session_id = extension_session_id
    record.extension_version = extension_version
    record.queue_length = max(0, int(queue_length or 0))
    record.events_waiting = max(0, int(events_waiting or 0))
    record.oldest_pending_event_at = _parse_iso_datetime(oldest_pending_event_at)
    record.retry_count = max(0, int(retry_count or 0))
    record.last_capture_event_at = _parse_iso_datetime(last_capture_event_at)
    record.last_successful_upload_at = _parse_iso_datetime(last_successful_upload_at)
    record.last_failed_upload_at = _parse_iso_datetime(last_failed_upload_at)
    record.average_upload_time_ms = average_upload_time_ms
    record.offline_since = _parse_iso_datetime(offline_since)
    record.reported_at = datetime.utcnow()

    if not existing:
        db.add(record)
    db.commit()
    db.refresh(record)
    return record


def get_capture_health_for_user(db: Session, *, user_id: int) -> list[HiggsfieldCaptureHealth]:
    return (
        db.query(HiggsfieldCaptureHealth)
        .filter(HiggsfieldCaptureHealth.provider == PROVIDER, HiggsfieldCaptureHealth.user_id == user_id)
        .order_by(HiggsfieldCaptureHealth.reported_at.desc())
        .all()
    )


def compute_capture_health_status(record: HiggsfieldCaptureHealth, *, now: Optional[datetime] = None) -> str:
    """Priority when multiple rules match: OFFLINE > BACKLOGGED > DEGRADED > HEALTHY."""
    now = now or datetime.utcnow()

    ping_age_seconds = (now - record.reported_at).total_seconds() if record.reported_at else float("inf")
    if record.offline_since is not None or ping_age_seconds > HEALTH_STALE_PING_THRESHOLD_SECONDS:
        return HEALTH_STATUS_OFFLINE

    if (record.queue_length or 0) >= HEALTH_BACKLOG_QUEUE_LENGTH_THRESHOLD:
        return HEALTH_STATUS_BACKLOGGED

    has_unresolved_queue = (record.queue_length or 0) > 0
    has_recent_failure = record.last_failed_upload_at is not None and (
        record.last_successful_upload_at is None or record.last_failed_upload_at > record.last_successful_upload_at
    )
    is_capturing_without_delivery = record.last_capture_event_at is not None and (
        record.last_successful_upload_at is None or record.last_capture_event_at > record.last_successful_upload_at
    )
    if has_unresolved_queue or has_recent_failure or is_capturing_without_delivery:
        return HEALTH_STATUS_DEGRADED

    return HEALTH_STATUS_HEALTHY


def capture_health_to_dict(record: HiggsfieldCaptureHealth, *, now: Optional[datetime] = None) -> dict:
    data = record.to_dict()
    data["status"] = compute_capture_health_status(record, now=now)
    return data
