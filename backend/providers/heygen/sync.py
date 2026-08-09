# providers/heygen/sync.py
"""
Reconciliation sync bookkeeping. Mirrors providers/freepik/sync.py's cursor
design.

Update 2026-08-04: the listing endpoint itself is now confirmed
(api2.heygen.com/v1/project/items, an item's shape documented in
normalization.py's _extract_fields) and content-heygen.js DOES now report
rows from it (event_type="generation_listing_row", always
is_reconciliation=true) - see content-heygen.js's onHeygenNetworkListingMessage
and content-heygen-network.js's extractListingRows. That path is PASSIVE
though (it only captures pages the user's own browsing happens to trigger) -
this module's cursor bookkeeping is still for the ACTIVE, Freepik-style
paginated crawl (content-freepik.js's runFreepikReconciliationWalk), which
HeyGen does not have yet. Unlike Freepik's simple `?page=N`, this endpoint
paginates via an opaque `token` cursor whose "next page" response field has
not been confirmed against real traffic - build the active walk once that
field is known, mirroring Freepik's design; until then nothing calls
report_sync_progress and every cursor stays at its created idle state, same
graceful degradation as before.
"""
from datetime import datetime
from typing import Optional

from sqlalchemy.orm import Session

from providers.heygen.constants import SYNC_STATUS_FAILED, SYNC_STATUS_IDLE, SYNC_STATUS_RUNNING
from providers.heygen.models import HeygenSyncCursor


def get_or_create_cursor(db: Session, *, credential_id: int) -> HeygenSyncCursor:
    cursor = (
        db.query(HeygenSyncCursor)
        .filter(HeygenSyncCursor.credential_id == credential_id)
        .first()
    )
    if cursor:
        return cursor
    cursor = HeygenSyncCursor(credential_id=credential_id, status=SYNC_STATUS_IDLE)
    db.add(cursor)
    db.commit()
    db.refresh(cursor)
    return cursor


def report_sync_progress(
    db: Session,
    *,
    credential_id: int,
    last_seen_video_id: Optional[str],
    last_synced_page: int,
    is_full_reconciliation: bool,
    status: str,
    error: Optional[str],
    run_by_user_id: Optional[int],
) -> HeygenSyncCursor:
    """Idempotent progress report from the extension after walking one batch
    of reconciliation pages. Only ever moves last_synced_page forward for an
    incremental walk; a full reconciliation report always wins since it is
    authoritative for the entire history."""
    cursor = get_or_create_cursor(db, credential_id=credential_id)

    if is_full_reconciliation or last_synced_page >= (cursor.last_synced_page or 0):
        cursor.last_synced_page = last_synced_page
        if last_seen_video_id:
            cursor.last_seen_video_id = last_seen_video_id
    if is_full_reconciliation and status == SYNC_STATUS_IDLE:
        cursor.last_full_reconciliation_at = datetime.utcnow()

    cursor.last_run_at = datetime.utcnow()
    cursor.last_run_by_user_id = run_by_user_id
    cursor.status = status if status in (SYNC_STATUS_IDLE, SYNC_STATUS_RUNNING, SYNC_STATUS_FAILED) else SYNC_STATUS_IDLE
    cursor.last_error = error

    db.commit()
    db.refresh(cursor)
    return cursor
