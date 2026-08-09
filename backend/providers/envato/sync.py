# providers/envato/sync.py
"""
Reconciliation sync bookkeeping. Mirrors providers/freepik/sync.py exactly -
see that file's docstring. The actual page-fetching happens in the browser
extension (content-envato.js), authenticated as the tab's own logged-in
Envato session via `POST /generation-history.data` with
`actionType=loadMore` - there is no server-side Envato credential.
"""
from datetime import datetime
from typing import Optional

from sqlalchemy.orm import Session

from providers.envato.constants import SYNC_STATUS_FAILED, SYNC_STATUS_IDLE, SYNC_STATUS_RUNNING
from providers.envato.models import EnvatoSyncCursor


def get_or_create_cursor(db: Session, *, credential_id: int) -> EnvatoSyncCursor:
    cursor = (
        db.query(EnvatoSyncCursor)
        .filter(EnvatoSyncCursor.credential_id == credential_id)
        .first()
    )
    if cursor:
        return cursor
    cursor = EnvatoSyncCursor(credential_id=credential_id, status=SYNC_STATUS_IDLE)
    db.add(cursor)
    db.commit()
    db.refresh(cursor)
    return cursor


def report_sync_progress(
    db: Session,
    *,
    credential_id: int,
    last_seen_item_uuid: Optional[str],
    last_synced_page: int,
    is_full_reconciliation: bool,
    status: str,
    error: Optional[str],
    run_by_user_id: Optional[int],
) -> EnvatoSyncCursor:
    cursor = get_or_create_cursor(db, credential_id=credential_id)

    if is_full_reconciliation or last_synced_page >= (cursor.last_synced_page or 0):
        cursor.last_synced_page = last_synced_page
        if last_seen_item_uuid:
            cursor.last_seen_item_uuid = last_seen_item_uuid
    if is_full_reconciliation and status == SYNC_STATUS_IDLE:
        cursor.last_full_reconciliation_at = datetime.utcnow()

    cursor.last_run_at = datetime.utcnow()
    cursor.last_run_by_user_id = run_by_user_id
    cursor.status = status if status in (SYNC_STATUS_IDLE, SYNC_STATUS_RUNNING, SYNC_STATUS_FAILED) else SYNC_STATUS_IDLE
    cursor.last_error = error

    db.commit()
    db.refresh(cursor)
    return cursor
