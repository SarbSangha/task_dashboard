# utils/task_gate.py
"""
Shared validation for the "must have an active task selected before
generating" gate (currently used by the Freepik pre-generation task picker).
Kept in one place so the /api/tasks/my-active listing endpoint and the
capture-ingestion revalidation (providers/freepik/capture.py) can never drift
apart on what "active" / "assigned to this user" means - the whole point of
revalidating server-side is that both checks must agree.
"""
from typing import Optional

from sqlalchemy import or_
from sqlalchemy.orm import Session

from models_new import ParticipantRole, Task, TaskParticipant, TaskStage, TaskStageAssignee, TaskStatus

# Statuses where the assignee still has to act on the task. Deliberately
# excludes SUBMITTED/UNDER_REVIEW (actionable for a reviewer/approver, not the
# assignee who'd be clicking Generate) and every terminal status.
ACTIVE_TASK_STATUSES = (
    TaskStatus.PENDING,
    TaskStatus.FORWARDED,
    TaskStatus.ASSIGNED,
    TaskStatus.IN_PROGRESS,
    TaskStatus.NEED_IMPROVEMENT,
)

# Matches TaskStageAssignee.role's default value - workflow-stage assignment
# uses a plain string column, not the ParticipantRole enum.
WORKFLOW_ASSIGNEE_ROLE = "assignee"


def _assigned_task_ids_query(db: Session, user_id: int):
    """Task ids where `user_id` is an active, non-creator participant or an
    active stage-assignee - the same visibility get_all_user_tasks()
    (tasks_router.py) grants, narrowed here to "must act", not "involved"."""
    participant_task_ids = db.query(TaskParticipant.task_id).filter(
        TaskParticipant.user_id == user_id,
        TaskParticipant.is_active == True,  # noqa: E712
        TaskParticipant.role != ParticipantRole.CREATOR,
    )
    stage_assignee_task_ids = (
        db.query(TaskStage.task_id)
        .join(TaskStageAssignee, TaskStageAssignee.stage_id == TaskStage.id)
        .filter(
            TaskStageAssignee.user_id == user_id,
            TaskStageAssignee.is_active == True,  # noqa: E712
            TaskStageAssignee.role == WORKFLOW_ASSIGNEE_ROLE,
        )
    )
    return participant_task_ids, stage_assignee_task_ids


def get_active_tasks_for_user(db: Session, user_id: int, limit: int = 200) -> list[Task]:
    """Tasks `user_id` is currently expected to act on - populates the
    pre-generation task picker."""
    participant_task_ids, stage_assignee_task_ids = _assigned_task_ids_query(db, user_id)
    return (
        db.query(Task)
        .filter(
            Task.is_deleted == False,  # noqa: E712
            Task.status.in_(ACTIVE_TASK_STATUSES),
            or_(Task.id.in_(participant_task_ids), Task.id.in_(stage_assignee_task_ids)),
        )
        .order_by(Task.updated_at.desc())
        .limit(limit)
        .all()
    )


def validate_task_for_generation(db: Session, task_id: Optional[int], user_id: int) -> Optional[Task]:
    """Re-check, server-side, that `task_id` is still an active task the user
    is actually assigned to - never trust a task_id handed back by a client
    (extension, browser, or otherwise) at face value. Returns the Task if
    valid, None otherwise (caller decides whether that's a hard error or a
    silently-dropped attribution, depending on context)."""
    if not task_id:
        return None

    task = (
        db.query(Task)
        .filter(
            Task.id == task_id,
            Task.is_deleted == False,  # noqa: E712
            Task.status.in_(ACTIVE_TASK_STATUSES),
        )
        .first()
    )
    if not task:
        return None

    participant_task_ids, stage_assignee_task_ids = _assigned_task_ids_query(db, user_id)
    is_assigned = (
        db.query(Task.id)
        .filter(Task.id == task_id, Task.id.in_(participant_task_ids))
        .first()
        or db.query(Task.id).filter(Task.id == task_id, Task.id.in_(stage_assignee_task_ids)).first()
    )
    return task if is_assigned else None
