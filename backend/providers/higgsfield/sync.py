# providers/higgsfield/sync.py
"""
Reconciliation sync bookkeeping. Mirrors providers/heygen/sync.py's cursor
design.

No real Higgsfield history/listing endpoint has been confirmed yet (see
constants.py's module docstring - only one UI screenshot was available while
building this), so nothing calls report_sync_progress in this pass and every
cursor stays at its created idle state. This module exists so the bookkeeping
is ready the moment such an endpoint is confirmed and content-higgsfield.js
grows an active paginated crawl (mirroring content-freepik.js's
runFreepikReconciliationWalk), without a schema change at that point -
same graceful degradation HeyGen shipped with before its own listing
endpoint (api2.heygen.com/v1/project/items) was confirmed.
"""
from datetime import datetime
from typing import Optional

from sqlalchemy.orm import Session

from providers.higgsfield.constants import SYNC_STATUS_FAILED, SYNC_STATUS_IDLE, SYNC_STATUS_RUNNING
from providers.higgsfield.models import HiggsfieldSyncCursor


def get_or_create_cursor(db: Session, *, credential_id: int) -> HiggsfieldSyncCursor:
    cursor = (
        db.query(HiggsfieldSyncCursor)
        .filter(HiggsfieldSyncCursor.credential_id == credential_id)
        .first()
    )
    if cursor:
        return cursor
    cursor = HiggsfieldSyncCursor(credential_id=credential_id, status=SYNC_STATUS_IDLE)
    db.add(cursor)
    db.commit()
    db.refresh(cursor)
    return cursor


def report_sync_progress(
    db: Session,
    *,
    credential_id: int,
    last_seen_generation_id: Optional[str],
    last_synced_page: int,
    is_full_reconciliation: bool,
    status: str,
    error: Optional[str],
    run_by_user_id: Optional[int],
) -> HiggsfieldSyncCursor:
    """Idempotent progress report from the extension after walking one batch
    of reconciliation pages. Only ever moves last_synced_page forward for an
    incremental walk; a full reconciliation report always wins since it is
    authoritative for the entire history."""
    cursor = get_or_create_cursor(db, credential_id=credential_id)

    if is_full_reconciliation or last_synced_page >= (cursor.last_synced_page or 0):
        cursor.last_synced_page = last_synced_page
        if last_seen_generation_id:
            cursor.last_seen_generation_id = last_seen_generation_id
    if is_full_reconciliation and status == SYNC_STATUS_IDLE:
        cursor.last_full_reconciliation_at = datetime.utcnow()

    cursor.last_run_at = datetime.utcnow()
    cursor.last_run_by_user_id = run_by_user_id
    cursor.status = status if status in (SYNC_STATUS_IDLE, SYNC_STATUS_RUNNING, SYNC_STATUS_FAILED) else SYNC_STATUS_IDLE
    cursor.last_error = error

    db.commit()
    db.refresh(cursor)
    return cursor
