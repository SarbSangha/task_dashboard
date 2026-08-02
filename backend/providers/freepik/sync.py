# providers/freepik/sync.py
"""
Reconciliation sync bookkeeping (Phase 5). The actual page-fetching happens
in the browser extension (content-freepik-network.js), authenticated as the
tab's own logged-in Freepik session - there is no server-side Freepik
credential, so this module never calls out to Freepik itself. Its job is
purely to track *where an extension-driven walk left off*, so:

  - a normal (incremental) walk resumes from last_seen_creation_id instead of
    re-reading all ~819 pages every time a tab happens to be open;
  - an admin-triggered full reconciliation (see FreepikRecoveryAudit) can
    force a walk of every page regardless of the cursor, for the initial
    backlog import.

One row per credential (the shared Freepik account), not per user - the
cursor describes how far *that account's* history has been walked,
independent of who happens to be running the scan.
"""
from datetime import datetime
from typing import Optional

from sqlalchemy.orm import Session

from providers.freepik.constants import SYNC_STATUS_FAILED, SYNC_STATUS_IDLE, SYNC_STATUS_RUNNING
from providers.freepik.models import FreepikSyncCursor


def get_or_create_cursor(db: Session, *, credential_id: int) -> FreepikSyncCursor:
    cursor = (
        db.query(FreepikSyncCursor)
        .filter(FreepikSyncCursor.credential_id == credential_id)
        .first()
    )
    if cursor:
        return cursor
    cursor = FreepikSyncCursor(credential_id=credential_id, status=SYNC_STATUS_IDLE)
    db.add(cursor)
    db.commit()
    db.refresh(cursor)
    return cursor


def report_sync_progress(
    db: Session,
    *,
    credential_id: int,
    last_seen_creation_id: Optional[str],
    last_synced_page: int,
    is_full_reconciliation: bool,
    status: str,
    error: Optional[str],
    run_by_user_id: Optional[int],
) -> FreepikSyncCursor:
    """Idempotent progress report from the extension after walking one batch
    of reconciliation pages. Only ever moves last_synced_page forward for an
    incremental walk (a stale/out-of-order report from a slower tab can't
    regress a cursor another tab already advanced); a full reconciliation
    report always wins since it is authoritative for the entire history."""
    cursor = get_or_create_cursor(db, credential_id=credential_id)

    if is_full_reconciliation or last_synced_page >= (cursor.last_synced_page or 0):
        cursor.last_synced_page = last_synced_page
        if last_seen_creation_id:
            cursor.last_seen_creation_id = last_seen_creation_id
    if is_full_reconciliation and status == SYNC_STATUS_IDLE:
        cursor.last_full_reconciliation_at = datetime.utcnow()

    cursor.last_run_at = datetime.utcnow()
    cursor.last_run_by_user_id = run_by_user_id
    cursor.status = status if status in (SYNC_STATUS_IDLE, SYNC_STATUS_RUNNING, SYNC_STATUS_FAILED) else SYNC_STATUS_IDLE
    cursor.last_error = error

    db.commit()
    db.refresh(cursor)
    return cursor
