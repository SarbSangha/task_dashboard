from fastapi import Depends, HTTPException
from sqlalchemy.orm import Session

from database_config import get_operational_db
from models_new import ParticipantRole, Task, TaskParticipant, TaskStatus, User
from utils.permissions import get_current_user, has_any_role, require_admin

ACTIVE_WORKPLACE_TOOL_STATUSES = (
    TaskStatus.PENDING,
    TaskStatus.IN_PROGRESS,
    TaskStatus.NEED_IMPROVEMENT,
)

WORKPLACE_TOOLS_ACCESS_DENIED_MESSAGE = (
    "You don't have any active inbox tasks right now. "
    "Workplace tools become available automatically when you receive a pending, in-progress, or need-improvement task."
)


def has_active_inbox_task(user_id: int, db: Session) -> bool:
    active_task_query = (
        db.query(TaskParticipant.id)
        .join(Task, Task.id == TaskParticipant.task_id)
        .filter(
            TaskParticipant.user_id == int(user_id),
            TaskParticipant.is_active == True,
            TaskParticipant.role != ParticipantRole.CREATOR,
            Task.creator_id != int(user_id),
            Task.is_deleted == False,
            Task.status.in_(ACTIVE_WORKPLACE_TOOL_STATUSES),
        )
        .limit(1)
    )
    return bool(db.query(active_task_query.exists()).scalar())


def can_access_workplace_tools(user: User, db: Session) -> bool:
    if has_any_role(user, {"admin"}):
        return True
    if not bool(getattr(user, "enforce_active_task_policy", False)):
        return True
    return has_active_inbox_task(user.id, db)


def get_workplace_tools_access_status(user: User, db: Session) -> dict:
    policy_enabled = bool(getattr(user, "enforce_active_task_policy", False))
    is_admin = has_any_role(user, {"admin"})
    if is_admin or not policy_enabled:
        return {
            "canAccessTools": True,
            "hasActiveInboxTask": True,
            "policyEnabled": policy_enabled,
            "activeStatuses": [status.value for status in ACTIVE_WORKPLACE_TOOL_STATUSES],
            "message": None,
        }
    has_task = has_active_inbox_task(user.id, db)
    return {
        "canAccessTools": has_task,
        "hasActiveInboxTask": has_task,
        "policyEnabled": policy_enabled,
        "activeStatuses": [status.value for status in ACTIVE_WORKPLACE_TOOL_STATUSES],
        "message": None if has_task else WORKPLACE_TOOLS_ACCESS_DENIED_MESSAGE,
    }


def enforce_workplace_tools_access(user: User, db: Session) -> None:
    if can_access_workplace_tools(user, db):
        return
    raise HTTPException(status_code=403, detail=WORKPLACE_TOOLS_ACCESS_DENIED_MESSAGE)


def get_current_user_with_workplace_tools_access(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_operational_db),
) -> User:
    enforce_workplace_tools_access(current_user, db)
    return current_user


def require_admin_with_workplace_tools_access(
    current_user: User = Depends(require_admin),
) -> User:
    # Admins always have workplace tools access; no inbox task check needed
    return current_user
