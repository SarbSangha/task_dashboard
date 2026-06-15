from datetime import datetime, timedelta
import logging
from typing import Protocol

from sqlalchemy.orm import Session

from models_new import NotificationOutbox


logger = logging.getLogger(__name__)


class NotificationEnqueuer(Protocol):
    def enqueue(self, user_id: int, payload: dict) -> bool:
        ...


def record_notification_outbox_failure(
    db: Session,
    *,
    user_id: int,
    event_type: str,
    payload: dict,
    error: str = "",
) -> None:
    row = NotificationOutbox(
        user_id=user_id,
        event_type=event_type,
        payload_json=payload,
        status="pending",
        attempts=0,
        max_attempts=10,
        last_error=(error or "")[:1000],
        created_at=datetime.utcnow(),
        next_attempt_at=datetime.utcnow() + timedelta(seconds=30),
    )
    db.add(row)


def dispatch_notification_outbox_batch(
    db: Session,
    dispatcher: NotificationEnqueuer,
    *,
    limit: int = 100,
) -> int:
    now = datetime.utcnow()
    rows = (
        db.query(NotificationOutbox)
        .filter(
            NotificationOutbox.status == "pending",
            NotificationOutbox.next_attempt_at <= now,
        )
        .order_by(NotificationOutbox.next_attempt_at.asc(), NotificationOutbox.id.asc())
        .limit(max(1, limit))
        .all()
    )

    dispatched = 0
    for row in rows:
        try:
            queued = dispatcher.enqueue(row.user_id, row.payload_json or {})
            row.attempts = int(row.attempts or 0) + 1
            if queued:
                row.status = "dispatched"
                row.dispatched_at = datetime.utcnow()
                row.last_error = None
                dispatched += 1
                continue

            row.last_error = "Notification dispatcher queue full"
        except Exception as exc:
            row.attempts = int(row.attempts or 0) + 1
            row.last_error = str(exc)[:1000]
            logger.exception("Notification outbox dispatch failed for row_id=%s", row.id)

        if row.attempts >= row.max_attempts:
            row.status = "failed"
        else:
            delay_seconds = min(3600, 30 * (2 ** max(0, row.attempts - 1)))
            row.next_attempt_at = datetime.utcnow() + timedelta(seconds=delay_seconds)

    db.commit()
    return dispatched
