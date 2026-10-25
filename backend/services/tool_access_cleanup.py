"""Tool access a deleted user leaves behind.

Deleting a user only closes the account. Their tool seats (the per-user
ITPortalToolCredential rows that assign them a company login) and any
single-seat lock they hold stayed live: they kept showing under the login in
the IT portal, and saving that login's assignments failed because the deleted
user came back in the list and was refused. This frees both.
"""

from datetime import datetime

from sqlalchemy.orm import Session

from models_new import ITPortalTool, ITPortalToolAudit, ITPortalToolCredential, User


def release_tool_access(db: Session, user_id: int, actor_id: int) -> int:
    """Deactivate the user's tool seats and free any single-seat lock they
    hold. Returns how many seats were closed. Does not commit."""
    now = datetime.utcnow()
    seats = (
        db.query(ITPortalToolCredential)
        .filter(
            ITPortalToolCredential.scope == "user",
            ITPortalToolCredential.user_id == user_id,
            ITPortalToolCredential.is_active == True,
        )
        .all()
    )
    for seat in seats:
        seat.is_active = False
        seat.updated_by = actor_id
        seat.updated_at = now
        db.add(
            ITPortalToolAudit(
                actor_id=actor_id,
                action="credential_unassigned_user_deleted",
                tool_id=seat.tool_id,
                credential_id=seat.linked_credential_id or seat.id,
                target_user_id=user_id,
                details_json={"seatId": seat.id},
            )
        )
    for tool in db.query(ITPortalTool).filter(ITPortalTool.active_session_user_id == user_id).all():
        tool.active_session_user_id = None
        tool.active_session_started_at = None
        tool.active_session_heartbeat_at = None
    db.flush()
    return len(seats)


def release_deleted_users_tool_access(db: Session) -> int:
    """Free whatever users deleted before this cleanup existed still hold.
    Returns how many seats were closed. Does not commit."""
    seat_holders = (
        db.query(ITPortalToolCredential.user_id)
        .join(User, User.id == ITPortalToolCredential.user_id)
        .filter(
            User.is_deleted == True,
            ITPortalToolCredential.scope == "user",
            ITPortalToolCredential.is_active == True,
        )
    )
    lock_holders = (
        db.query(ITPortalTool.active_session_user_id)
        .join(User, User.id == ITPortalTool.active_session_user_id)
        .filter(User.is_deleted == True)
    )
    user_ids = {uid for (uid,) in seat_holders.union(lock_holders).all() if uid}
    closed = 0
    for user in db.query(User).filter(User.id.in_(user_ids)).all() if user_ids else []:
        closed += release_tool_access(db, user.id, user.deleted_by or user.id)
    return closed
