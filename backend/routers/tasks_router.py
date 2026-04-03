from collections import defaultdict

from fastapi import HTTPException, Depends, Query, Cookie, Header, Request, WebSocket, WebSocketDisconnect
from sqlalchemy.orm import Session, aliased, joinedload, selectinload, load_only
from sqlalchemy import or_, and_, func, case, inspect
from sqlalchemy.exc import SQLAlchemyError
from typing import Optional, List, Set
from pydantic import BaseModel, Field
from datetime import datetime
import asyncio
import hashlib
import os
import re
from time import perf_counter

from database_config import get_operational_db, OperationalSessionLocal
from models_new import (
    Task,
    TaskParticipant,
    TaskStatusHistory,
    TaskComment,
    TaskForward,
    TaskNotification,
    TaskView,
    TaskEditLog,
    User,
    TaskStatus,
    Priority,
    ParticipantRole,
)
from auth import verify_session_token, get_request_session_token, resolve_session_user
from task_helpers import TaskHelpers
from utils.cache import cache_response, invalidate_pattern
from utils.edge_cache import queue_edge_cache_purge

TASK_ALL_CACHE_PATTERN = "cache:tasks_all:*"
TASK_ASSETS_CACHE_PATTERN = "cache:tasks_assets:*"
TASK_UNREAD_CACHE_PATTERN = "cache:tasks_unread:*"
EDGE_TASK_CACHE_PATTERNS = ("tasks_all:", "tasks_assets:")


async def invalidate_task_lane_b_cache():
    await invalidate_pattern(TASK_ALL_CACHE_PATTERN)
    await invalidate_pattern(TASK_ASSETS_CACHE_PATTERN)
    await invalidate_pattern(TASK_UNREAD_CACHE_PATTERN)
    queue_edge_cache_purge(EDGE_TASK_CACHE_PATTERNS)


def _inbox_profile_logging_enabled() -> bool:
    return (os.getenv("INBOX_PROFILE_LOGGING") or "").strip().lower() in {"1", "true", "yes", "on"}


class NotificationHub:
    def __init__(self):
        self.connections: dict[int, set[WebSocket]] = {}

    async def connect(self, user_id: int, websocket: WebSocket):
        await websocket.accept()
        self.connections.setdefault(user_id, set()).add(websocket)

    def disconnect(self, user_id: int, websocket: WebSocket):
        if user_id in self.connections:
            self.connections[user_id].discard(websocket)
            if not self.connections[user_id]:
                self.connections.pop(user_id, None)

    async def push(self, user_id: int, payload: dict):
        sockets = list(self.connections.get(user_id, set()))
        for socket in sockets:
            try:
                await socket.send_json(payload)
            except Exception:
                self.disconnect(user_id, socket)


notification_hub = NotificationHub()


class TaskCreate(BaseModel):
    title: str = Field(..., min_length=1, max_length=200)
    description: Optional[str] = None
    projectName: Optional[str] = None
    projectId: Optional[str] = None
    taskId: Optional[str] = None
    projectIdRaw: Optional[str] = None
    projectIdHex: Optional[str] = None
    customerName: Optional[str] = None
    taskType: str = Field(default="task")
    taskTag: Optional[str] = None
    priority: str = Field(default="medium")
    toDepartment: Optional[str] = None
    deadline: Optional[str] = None
    assigneeIds: List[int] = Field(default_factory=list)
    reference: Optional[str] = None
    links: List[str] = Field(default_factory=list)
    attachments: List[dict] = Field(default_factory=list)


class TaskUpdate(BaseModel):
    title: Optional[str] = None
    description: Optional[str] = None
    priority: Optional[str] = None
    deadline: Optional[str] = None


class TaskActionPayload(BaseModel):
    comments: Optional[str] = None
    result_text: Optional[str] = None
    result_links: List[str] = Field(default_factory=list)
    result_attachments: List[dict] = Field(default_factory=list)


class TaskAssignPayload(BaseModel):
    assignee_ids: List[int] = Field(default_factory=list)
    comments: Optional[str] = None


class TaskForwardPayload(BaseModel):
    to_department: Optional[str] = None
    to_user_id: Optional[int] = None
    to_user_ids: List[int] = Field(default_factory=list)
    comments: Optional[str] = None


class TaskCommentPayload(BaseModel):
    comment: str = Field(..., min_length=1)
    comment_type: str = Field(default="general")
    is_internal: bool = False


class ProjectIdGeneratePayload(BaseModel):
    project_name: str = Field(..., min_length=1)
    customer_name: str = Field(..., min_length=1)
    date: Optional[str] = None


class TaskIdGeneratePayload(BaseModel):
    project_name: str = Field(..., min_length=1)
    customer_name: str = Field(..., min_length=1)
    date: Optional[str] = None


class ResultEditPayload(BaseModel):
    result_text: str = Field(..., min_length=1)


def parse_deadline(deadline_str: Optional[str]) -> Optional[datetime]:
    if not deadline_str:
        return None
    for parser in (
        lambda x: datetime.fromisoformat(x.replace("Z", "+00:00")),
        lambda x: datetime.strptime(x, "%Y-%m-%dT%H:%M"),
    ):
        try:
            return parser(deadline_str)
        except Exception:
            continue
    return None


def slug_text(value: str) -> str:
    return re.sub(r"[^A-Za-z0-9]", "", value or "")


def to_hex4(value: str) -> str:
    cleaned = slug_text(value)[:4] or "NONE"
    return cleaned.encode("utf-8").hex().upper()[:4]


def role_set(user: User) -> Set[str]:
    roles = set()
    if user and user.roles_json and isinstance(user.roles_json, list):
        roles = {str(r).strip().lower() for r in user.roles_json if str(r).strip()}

    position = (user.position or "").lower() if user else ""
    mapped = {
        "super admin": "super_admin",
        "admin": "super_admin",
        "head of department": "hod",
        "hod": "hod",
        "spoc": "spoc",
        "faculty": "faculty",
        "employee": "employee",
        "normal employee": "employee",
    }
    for key, value in mapped.items():
        if key in position:
            roles.add(value)

    if not roles:
        roles.add("employee")
    return roles


def has_any_role(user: User, allowed: Set[str]) -> bool:
    return len(role_set(user).intersection(allowed)) > 0


def can_approve(user: User, task: Task) -> bool:
    roles = role_set(user)
    if "super_admin" in roles:
        return True
    if user.id == task.creator_id and task.status in {TaskStatus.APPROVED, TaskStatus.SUBMITTED, TaskStatus.NEED_IMPROVEMENT}:
        return True
    if "spoc" in roles and user.department == task.to_department:
        return True
    if "hod" in roles:
        return True
    return False


def can_assign(user: User, task: Task) -> bool:
    roles = role_set(user)
    return "super_admin" in roles or ("hod" in roles and user.department == task.to_department)


def get_current_user_from_session(
    session_id: Optional[str] = Cookie(None, alias="session_id"),
    x_session_id: Optional[str] = Header(None, alias="X-Session-Id"),
    db: Session = Depends(get_operational_db),
):
    resolved_session_id = get_request_session_token(session_id, x_session_id)
    if not resolved_session_id:
        return None
    try:
        return resolve_session_user(resolved_session_id, db, raise_on_missing=False)
    except Exception:
        return None


def add_history(
    db: Session,
    task: Task,
    user_id: int,
    action: str,
    status_to: str,
    comments: Optional[str] = None,
    metadata_json: Optional[dict] = None,
):
    db.add(
        TaskStatusHistory(
            task_id=task.id,
            user_id=user_id,
            status_from=task.status.value if task.status else None,
            status_to=status_to,
            action=action,
            comments=comments,
            metadata_json=metadata_json,
            timestamp=datetime.utcnow(),
        )
    )


def create_notification(
    db: Session,
    task: Task,
    user_id: int,
    event_type: str,
    title: str,
    message: str,
    actor: Optional[User] = None,
    metadata_json: Optional[dict] = None,
):
    meta = dict(metadata_json or {})
    meta.setdefault("taskNumber", task.task_number)
    meta.setdefault("projectId", task.project_id)
    meta.setdefault("taskType", task.task_type)
    if actor:
        actor_roles = ", ".join(sorted(role_set(actor)))
        meta.setdefault("actorName", actor.name)
        meta.setdefault("actorRole", actor_roles)
        meta.setdefault("actorDepartment", actor.department)
    db.add(
        TaskNotification(
            task_id=task.id,
            user_id=user_id,
            event_type=event_type,
            title=title,
            message=message,
            task_number=task.task_number,
            project_id=task.project_id,
            metadata_json=meta,
            created_at=datetime.utcnow(),
        )
    )
    if actor:
        actor_desc = f"{actor.name} ({', '.join(sorted(role_set(actor)))}, {actor.department or 'N/A'})"
        meta.setdefault("actorDescription", actor_desc)

    try:
        asyncio.create_task(
            notification_hub.push(
                user_id,
                {
                    "eventType": event_type,
                    "title": title,
                    "message": message,
                    "taskId": task.id,
                    "taskNumber": task.task_number,
                    "projectId": task.project_id,
                    "metadata": meta,
                },
            )
        )
    except RuntimeError:
        pass


def post_system_comment(db: Session, task: Task, user_id: int, comment: str, comment_type: str):
    db.add(
        TaskComment(
            task_id=task.id,
            user_id=user_id,
            comment=comment,
            comment_type=comment_type,
            is_internal=False,
            created_at=datetime.utcnow(),
        )
    )


def mark_seen(db: Session, task_id: int, user_id: int):
    seen = db.query(TaskView).filter(TaskView.task_id == task_id, TaskView.user_id == user_id).first()
    if seen:
        seen.seen_at = datetime.utcnow()
    else:
        db.add(TaskView(task_id=task_id, user_id=user_id, seen_at=datetime.utcnow()))


def user_is_participant(task_id: int, user_id: int, role: Optional[ParticipantRole], db: Session) -> bool:
    q = db.query(TaskParticipant).filter(
        TaskParticipant.task_id == task_id,
        TaskParticipant.user_id == user_id,
        TaskParticipant.is_active == True,
    )
    if role is not None:
        q = q.filter(TaskParticipant.role == role)
    return q.first() is not None


def ensure_participant(db: Session, task_id: int, user_id: int, role: ParticipantRole):
    p = db.query(TaskParticipant).filter(
        TaskParticipant.task_id == task_id,
        TaskParticipant.user_id == user_id,
        TaskParticipant.role == role,
    ).first()
    if p:
        p.is_active = True
        return
    db.add(
        TaskParticipant(
            task_id=task_id,
            user_id=user_id,
            role=role,
            is_read=False,
            is_active=True,
            added_at=datetime.utcnow(),
        )
    )


def compute_available_actions(
    task: Task,
    user: User,
    db: Session,
    my_participation: Optional[TaskParticipant] = None,
) -> List[str]:
    if task.status == TaskStatus.CANCELLED:
        return []

    roles = role_set(user)
    actions = ["chat"]
    is_creator = user.id == task.creator_id
    if my_participation is not None:
        is_assignee = (
            my_participation.is_active == True
            and my_participation.role == ParticipantRole.ASSIGNEE
        )
    else:
        is_assignee = user_is_participant(task.id, user.id, ParticipantRole.ASSIGNEE, db)

    if has_any_role(user, {"hod", "super_admin"}):
        if task.status in {TaskStatus.PENDING, TaskStatus.FORWARDED, TaskStatus.NEED_IMPROVEMENT, TaskStatus.SUBMITTED}:
            actions.extend(["approve", "need_improvement", "forward"])
        if can_assign(user, task):
            actions.append("assign")

    if "spoc" in roles and user.department == task.to_department:
        if task.status in {TaskStatus.SUBMITTED, TaskStatus.UNDER_REVIEW, TaskStatus.NEED_IMPROVEMENT}:
            actions.extend(["approve", "need_improvement", "forward"])

    if is_assignee:
        if task.status in {TaskStatus.PENDING, TaskStatus.FORWARDED, TaskStatus.ASSIGNED, TaskStatus.NEED_IMPROVEMENT}:
            actions.append("start")
        if task.status in {TaskStatus.IN_PROGRESS, TaskStatus.NEED_IMPROVEMENT}:
            actions.append("submit")
        if task.status == TaskStatus.NEED_IMPROVEMENT:
            actions.append("edit_result")

    if is_creator:
        if task.status not in {TaskStatus.COMPLETED, TaskStatus.CANCELLED, TaskStatus.REJECTED}:
            actions.append("revoke_task")
        if task.status in {TaskStatus.PENDING, TaskStatus.NEED_IMPROVEMENT, TaskStatus.FORWARDED}:
            actions.append("edit_task")
        if task.status in {TaskStatus.SUBMITTED, TaskStatus.APPROVED}:
            actions.extend(["approve", "need_improvement"])

    deduped = []
    for action in actions:
        if action not in deduped:
            deduped.append(action)
    return deduped


def _task_list_loader_options():
    return (
        load_only(
            Task.id,
            Task.task_number,
            Task.task_id_project_hex,
            Task.task_id_customer_hex,
            Task.project_id,
            Task.project_id_raw,
            Task.project_id_hex,
            Task.title,
            Task.description,
            Task.project_name,
            Task.task_type,
            Task.task_tag,
            Task.priority,
            Task.creator_id,
            Task.from_department,
            Task.to_department,
            Task.status,
            Task.workflow_stage,
            Task.deadline,
            Task.created_at,
            Task.updated_at,
            Task.started_at,
            Task.completed_at,
            Task.submitted_at,
            Task.submitted_by,
            Task.metadata_json,
            Task.task_version,
            Task.result_version,
            Task.result_text,
            Task.is_deleted,
        ),
        joinedload(Task.creator).load_only(User.id, User.name, User.department),
        selectinload(Task.participants)
        .load_only(
            TaskParticipant.id,
            TaskParticipant.task_id,
            TaskParticipant.user_id,
            TaskParticipant.role,
            TaskParticipant.is_read,
            TaskParticipant.is_active,
        )
        .joinedload(TaskParticipant.user)
        .load_only(User.id, User.name, User.department),
    )


def serialize_task(task: Task, db: Session, current_user: Optional[User] = None) -> dict:
    return serialize_task_with_context(task, db, current_user=current_user, context=None)


def _serialize_task_list_base(task: Task) -> dict:
    return {
        "id": task.id,
        "taskNumber": task.task_number,
        "taskIdProjectHex": task.task_id_project_hex,
        "taskIdCustomerHex": task.task_id_customer_hex,
        "projectId": task.project_id,
        "projectIdRaw": task.project_id_raw,
        "projectIdHex": task.project_id_hex,
        "title": task.title,
        "description": task.description,
        "projectName": task.project_name,
        "taskType": task.task_type,
        "taskTag": task.task_tag,
        "priority": task.priority.value if task.priority else None,
        "creatorId": task.creator_id,
        "fromDepartment": task.from_department,
        "toDepartment": task.to_department,
        "status": task.status.value if task.status else None,
        "workflowStage": task.workflow_stage,
        "deadline": task.deadline.isoformat() if task.deadline else None,
        "createdAt": task.created_at.isoformat() if task.created_at else None,
        "updatedAt": task.updated_at.isoformat() if task.updated_at else None,
        "startedAt": task.started_at.isoformat() if task.started_at else None,
        "completedAt": task.completed_at.isoformat() if task.completed_at else None,
        "submittedAt": task.submitted_at.isoformat() if task.submitted_at else None,
        "submittedBy": task.submitted_by,
        "taskVersion": task.task_version,
        "resultVersion": task.result_version,
        "resultText": task.result_text,
        "isDeleted": task.is_deleted,
    }


def build_task_serialization_context(
    tasks: List[Task],
    db: Session,
    current_user: Optional[User] = None,
    *,
    include_comment_counts: bool = True,
    include_forward_history: bool = True,
    include_seen_by: bool = True,
) -> dict:
    task_ids = [task.id for task in tasks]
    if not task_ids:
        return {
            "creators": {},
            "participants_by_task": {},
            "comment_counts": {},
            "forwards_by_task": {},
            "user_lookup": {},
            "seen_by_by_task": {},
            "my_participation_by_task": {},
        }

    creators = {}
    creator_ids = set()
    for task in tasks:
        if "creator" not in inspect(task).unloaded:
            if task.creator:
                creators[task.creator.id] = task.creator
        elif task.creator_id:
            creator_ids.add(task.creator_id)

    if creator_ids:
        creators.update(
            {
                user.id: user
                for user in db.query(User)
                .options(load_only(User.id, User.name, User.department))
                .filter(User.id.in_(creator_ids))
                .all()
            }
        )

    participants_by_task = defaultdict(list)
    user_lookup = dict(creators)
    missing_participant_task_ids = []
    for task in tasks:
        if "participants" in inspect(task).unloaded:
            missing_participant_task_ids.append(task.id)
            continue
        for participant in task.participants or []:
            if not participant.is_active:
                continue
            participant_user = None
            if "user" not in inspect(participant).unloaded:
                participant_user = participant.user
            participants_by_task[participant.task_id].append((participant, participant_user))
            if participant_user:
                user_lookup[participant_user.id] = participant_user

    if missing_participant_task_ids:
        participant_rows = (
            db.query(TaskParticipant, User)
            .join(User, User.id == TaskParticipant.user_id)
            .filter(
                TaskParticipant.task_id.in_(missing_participant_task_ids),
                TaskParticipant.is_active == True,
            )
            .all()
        )
        for participant, user in participant_rows:
            participants_by_task[participant.task_id].append((participant, user))
            user_lookup[user.id] = user

    comment_counts = {}
    if include_comment_counts:
        comment_counts = {
            task_id: count
            for task_id, count in (
                db.query(TaskComment.task_id, func.count(TaskComment.id))
                .filter(TaskComment.task_id.in_(task_ids))
                .group_by(TaskComment.task_id)
                .all()
            )
        }

    forward_rows = []
    if include_forward_history:
        forward_rows = (
            db.query(TaskForward)
            .options(
                load_only(
                    TaskForward.id,
                    TaskForward.task_id,
                    TaskForward.from_user_id,
                    TaskForward.to_user_id,
                    TaskForward.from_department,
                    TaskForward.to_department,
                    TaskForward.reason,
                    TaskForward.created_at,
                )
            )
            .filter(TaskForward.task_id.in_(task_ids))
            .order_by(TaskForward.task_id.asc(), TaskForward.created_at.asc(), TaskForward.id.asc())
            .all()
        )
    forwards_by_task = defaultdict(list)
    forward_user_ids = set()
    for forward in forward_rows:
        forwards_by_task[forward.task_id].append(forward)
        if forward.from_user_id:
            forward_user_ids.add(forward.from_user_id)
        if forward.to_user_id:
            forward_user_ids.add(forward.to_user_id)

    missing_user_ids = [user_id for user_id in forward_user_ids if user_id not in user_lookup]
    if include_forward_history and missing_user_ids:
        for user in (
            db.query(User)
            .options(load_only(User.id, User.name, User.department))
            .filter(User.id.in_(missing_user_ids))
            .all()
        ):
            user_lookup[user.id] = user

    seen_by_rows = []
    if include_seen_by:
        try:
            seen_by_rows = (
                db.query(TaskView, User)
                .join(User, User.id == TaskView.user_id)
                .filter(TaskView.task_id.in_(task_ids))
                .all()
            )
        except SQLAlchemyError:
            seen_by_rows = []

    seen_by_by_task = defaultdict(list)
    for view, user in seen_by_rows:
        seen_by_by_task[view.task_id].append((view, user))
        user_lookup[user.id] = user

    my_participation_by_task = {}
    if current_user:
        for task_id, participants in participants_by_task.items():
            for participation, _participant_user in participants:
                if participation.user_id == current_user.id:
                    my_participation_by_task[task_id] = participation
                    break

    return {
        "creators": creators,
        "participants_by_task": participants_by_task,
        "comment_counts": comment_counts,
        "forwards_by_task": forwards_by_task,
        "user_lookup": user_lookup,
        "seen_by_by_task": seen_by_by_task,
        "my_participation_by_task": my_participation_by_task,
    }


def serialize_task_with_context(
    task: Task,
    db: Session,
    current_user: Optional[User] = None,
    context: Optional[dict] = None,
) -> dict:
    has_context = context is not None
    task_dict = _serialize_task_list_base(task)
    meta = task.metadata_json or {}
    task_dict["customerName"] = meta.get("customerName")
    task_dict["reference"] = meta.get("reference")
    task_dict["links"] = meta.get("links", [])
    task_dict["attachments"] = meta.get("attachments", [])
    task_dict["resultText"] = task.result_text
    task_dict["resultLinks"] = meta.get("resultLinks", [])
    task_dict["resultAttachments"] = meta.get("resultAttachments", [])
    task_dict["revocation"] = meta.get("revocation")
    creators = (context or {}).get("creators") or {}
    creator = creators.get(task.creator_id)
    if creator is None and "creator" not in inspect(task).unloaded:
        creator = task.creator
    if creator is None:
        creator = db.query(User).filter(User.id == task.creator_id).first()
    task_dict["creator"] = {
        "id": creator.id if creator else None,
        "name": creator.name if creator else "Unknown",
        "department": creator.department if creator else None,
    }

    participants_by_task = (context or {}).get("participants_by_task") or {}
    participants = participants_by_task.get(task.id, []) if has_context else None
    if not has_context:
        if "participants" not in inspect(task).unloaded:
            participants = []
            for participant in task.participants or []:
                if not participant.is_active:
                    continue
                participant_user = participant.user if "user" not in inspect(participant).unloaded else None
                participants.append((participant, participant_user))
        else:
            participants = db.query(TaskParticipant).join(User, User.id == TaskParticipant.user_id).filter(
                TaskParticipant.task_id == task.id,
                TaskParticipant.is_active == True,
            ).all()
    assigned_to = []
    for participant_row in participants:
        participant = participant_row if isinstance(participant_row, TaskParticipant) else participant_row[0]
        participant_user = None
        if isinstance(participant_row, TaskParticipant):
            participant_user = participant.user
        else:
            participant_user = participant_row[1]
        if participant.role != ParticipantRole.ASSIGNEE or not participant_user:
            continue
        assigned_to.append(
            {
                "id": participant_user.id,
                "name": participant_user.name,
                "department": participant_user.department,
                "role": participant.role.value,
            }
        )
    task_dict["assignedTo"] = assigned_to

    comment_counts = (context or {}).get("comment_counts") or {}
    comments_count = comment_counts.get(task.id, 0) if has_context else None
    if not has_context:
        comments_count = db.query(TaskComment).filter(TaskComment.task_id == task.id).count()

    forwards_by_task = (context or {}).get("forwards_by_task") or {}
    forwards = forwards_by_task.get(task.id, []) if has_context else None
    if not has_context:
        forwards = (
            db.query(TaskForward)
            .filter(TaskForward.task_id == task.id)
            .order_by(TaskForward.created_at.asc())
            .all()
        )
    forward_history = []
    user_lookup = (context or {}).get("user_lookup") or {}
    for fwd in forwards:
        from_user = user_lookup.get(fwd.from_user_id)
        to_user = user_lookup.get(fwd.to_user_id) if fwd.to_user_id else None
        if from_user is None and fwd.from_user_id:
            from_user = db.query(User).filter(User.id == fwd.from_user_id).first()
        if to_user is None and fwd.to_user_id:
            to_user = db.query(User).filter(User.id == fwd.to_user_id).first()
        forward_history.append(
            {
                "id": fwd.id,
                "fromUser": from_user.name if from_user else "Unknown",
                "toUser": to_user.name if to_user else None,
                "fromDepartment": fwd.from_department,
                "toDepartment": fwd.to_department,
                "reason": fwd.reason,
                "createdAt": fwd.created_at.isoformat() if fwd.created_at else None,
            }
        )
    seen_by_by_task = (context or {}).get("seen_by_by_task") or {}
    seen_by_rows = seen_by_by_task.get(task.id, []) if has_context else None
    if not has_context:
        try:
            seen_by_rows = (
                db.query(TaskView, User)
                .join(User, User.id == TaskView.user_id)
                .filter(TaskView.task_id == task.id)
                .all()
            )
        except SQLAlchemyError:
            # Backward compatibility if migration has not run yet.
            seen_by_rows = []
    task_dict["chatCount"] = comments_count
    task_dict["forwardHistory"] = forward_history
    task_dict["lastForwardedBy"] = forward_history[-1]["fromUser"] if forward_history else None
    task_dict["editCount"] = max(0, (task.task_version or 1) - 1)
    task_dict["seenBy"] = [
        {
            "id": user.id,
            "name": user.name,
            "department": user.department,
            "seenAt": view.seen_at.isoformat() if view.seen_at else None,
        }
        for view, user in seen_by_rows
    ]

    if current_user:
        my_participation_by_task = (context or {}).get("my_participation_by_task") or {}
        my_participation = my_participation_by_task.get(task.id) if has_context else None
        if not has_context:
            my_participation = db.query(TaskParticipant).filter(
                TaskParticipant.task_id == task.id,
                TaskParticipant.user_id == current_user.id,
                TaskParticipant.is_active == True,
            ).first()
        task_dict["isRead"] = my_participation.is_read if my_participation else False
        task_dict["myRole"] = my_participation.role.value if my_participation else "creator"
        task_dict["availableActions"] = compute_available_actions(
            task,
            current_user,
            db,
            my_participation=my_participation,
        )
        task_dict["mySystemRoles"] = sorted(list(role_set(current_user)))

    return task_dict


def serialize_task_list(
    tasks: List[Task],
    db: Session,
    current_user: Optional[User] = None,
    **context_options,
) -> List[dict]:
    context = build_task_serialization_context(tasks, db, current_user=current_user, **context_options)
    return [
        serialize_task_with_context(task, db, current_user=current_user, context=context)
        for task in tasks
    ]


ASSET_MEDIA_TYPES = {"all", "text", "image", "video", "music", "link", "pdf"}
ASSET_SORT_OPTIONS = {"latest", "top"}
ASSET_PRIORITY_RANK = {
    "urgent": 4,
    "high": 3,
    "medium": 2,
    "low": 1,
}
ASSET_EXTENSION_MAP = {
    "image": {"jpg", "jpeg", "png", "gif", "webp", "svg", "bmp"},
    "video": {"mp4", "mov", "avi", "mkv", "webm"},
    "music": {"mp3", "wav", "m4a", "aac", "ogg", "flac"},
    "text": {"txt", "pdf", "doc", "docx", "csv", "md", "json", "xml"},
}


def _detect_asset_media_type(item: dict) -> str:
    mime = f"{item.get('mimetype') or ''}".lower()
    if mime == "text/link":
        return "link"
    if mime == "application/pdf":
        return "pdf"
    if mime.startswith("image/"):
        return "image"
    if mime.startswith("video/"):
        return "video"
    if mime.startswith("audio/"):
        return "music"
    if mime.startswith("text/"):
        return "text"

    source = f"{item.get('url') or item.get('filename') or item.get('originalName') or ''}".lower()
    ext = source.split(".")[-1] if "." in source else ""
    if ext == "pdf":
        return "pdf"
    if ext in ASSET_EXTENSION_MAP["image"]:
        return "image"
    if ext in ASSET_EXTENSION_MAP["video"]:
        return "video"
    if ext in ASSET_EXTENSION_MAP["music"]:
        return "music"
    return "text"


def _build_task_assets(task: Task, creator: Optional[User], submitter: Optional[User]) -> List[dict]:
    meta = task.metadata_json or {}
    task_title = task.title or "Untitled task"
    task_number = task.task_number or "N/A"
    task_description = task.description or ""
    task_result_text = task.result_text or ""
    task_reference = meta.get("reference") or ""
    customer_name = meta.get("customerName") or ""
    project_name = task.project_name or ""
    priority = task.priority.value if task.priority else "medium"
    created_at = task.created_at.isoformat() if task.created_at else None
    updated_at = task.updated_at.isoformat() if task.updated_at else None
    created_by_name = creator.name if creator else None
    created_by_department = creator.department if creator else None
    submitted_by_name = submitter.name if submitter else None

    assets = []

    def append_asset(raw_asset: dict, stage: str):
        item = raw_asset or {}
        filename = item.get("filename") or item.get("originalName") or item.get("url") or "Untitled"
        asset = {
            "id": f"{task.id}-{stage}-{item.get('path') or item.get('url') or item.get('filename') or len(assets)}",
            "taskId": task.id,
            "taskTitle": task_title,
            "taskNumber": task_number,
            "taskDescription": task_description,
            "taskResultText": task_result_text,
            "taskReference": task_reference,
            "customerName": customer_name,
            "stage": stage,
            "filename": filename,
            "originalName": item.get("originalName") or item.get("filename") or filename,
            "relativePath": item.get("relativePath"),
            "path": item.get("path"),
            "url": item.get("url"),
            "mimetype": item.get("mimetype"),
            "size": item.get("size"),
            "createdAt": created_at,
            "updatedAt": updated_at,
            "priority": priority,
            "projectName": project_name,
            "createdByName": created_by_name,
            "createdByDepartment": created_by_department,
            "fromDepartment": task.from_department,
            "toDepartment": task.to_department,
            "submittedByName": submitted_by_name,
        }
        asset["mediaType"] = _detect_asset_media_type(asset)
        assets.append(asset)

    input_attachments = meta.get("attachments") if isinstance(meta.get("attachments"), list) else []
    result_attachments = meta.get("resultAttachments") if isinstance(meta.get("resultAttachments"), list) else []
    input_links = meta.get("links") if isinstance(meta.get("links"), list) else []
    result_links = meta.get("resultLinks") if isinstance(meta.get("resultLinks"), list) else []

    for attachment in input_attachments:
        if isinstance(attachment, str):
            append_asset({"url": attachment}, "input")
        elif isinstance(attachment, dict):
            append_asset(attachment, "input")

    for attachment in result_attachments:
        if isinstance(attachment, str):
            append_asset({"url": attachment}, "result")
        elif isinstance(attachment, dict):
            append_asset(attachment, "result")

    for url in input_links:
        if url:
            append_asset({"url": url, "mimetype": "text/link"}, "input-link")

    for url in result_links:
        if url:
            append_asset({"url": url, "mimetype": "text/link"}, "result-link")

    if task_description:
        append_asset({"filename": "Task description", "mimetype": "text/plain"}, "input-text")
    if task_result_text:
        append_asset({"filename": "Result text", "mimetype": "text/plain"}, "result-text")

    return assets


def _asset_matches_filters(
    asset: dict,
    media_type: str,
    department: Optional[str],
    query: Optional[str],
) -> bool:
    if media_type != "all" and asset.get("mediaType") != media_type:
        return False

    if department:
        target = department.strip().lower()
        if target and not any(
            f"{value or ''}".strip().lower() == target
            for value in (
                asset.get("createdByDepartment"),
                asset.get("fromDepartment"),
                asset.get("toDepartment"),
            )
        ):
            return False

    q = f"{query or ''}".strip().lower()
    if not q:
        return True

    haystacks = [
        asset.get("filename"),
        asset.get("originalName"),
        asset.get("taskTitle"),
        asset.get("taskNumber"),
        asset.get("projectName"),
        asset.get("taskDescription"),
        asset.get("taskResultText"),
        asset.get("taskReference"),
        asset.get("customerName"),
        asset.get("createdByName"),
        asset.get("submittedByName"),
        asset.get("url"),
    ]
    return any(q in f"{value or ''}".lower() for value in haystacks)


def _task_asset_order_clause(sort_by: str):
    if sort_by == "top":
        return (
            case(
                (Task.priority == Priority.URGENT, 4),
                (Task.priority == Priority.HIGH, 3),
                (Task.priority == Priority.MEDIUM, 2),
                else_=1,
            ).desc(),
            Task.updated_at.desc(),
            Task.id.desc(),
        )
    return (Task.updated_at.desc(), Task.id.desc())


def _list_assets_from_tasks(
    db: Session,
    *,
    offset: int,
    limit: int,
    media_type: str,
    department: Optional[str],
    query: Optional[str],
    sort_by: str,
) -> dict:
    creator_alias = aliased(User)
    submitter_alias = aliased(User)
    base_query = (
        db.query(Task, creator_alias, submitter_alias)
        .join(creator_alias, creator_alias.id == Task.creator_id)
        .outerjoin(submitter_alias, submitter_alias.id == Task.submitted_by)
        .filter(Task.is_deleted == False)
        .order_by(*_task_asset_order_clause(sort_by))
    )

    if department and department != "all_departments":
        base_query = base_query.filter(
            or_(
                creator_alias.department == department,
                Task.from_department == department,
                Task.to_department == department,
            )
        )

    page_assets = []
    matched_assets = 0
    task_offset = 0
    chunk_size = max(limit, 40)
    has_more = False

    while True:
        rows = base_query.offset(task_offset).limit(chunk_size).all()
        if not rows:
            break

        task_offset += len(rows)
        for task, creator, submitter in rows:
            for asset in _build_task_assets(task, creator, submitter):
                if not _asset_matches_filters(asset, media_type, department, query):
                    continue

                if matched_assets < offset:
                    matched_assets += 1
                    continue

                if len(page_assets) < limit:
                    page_assets.append(asset)
                    matched_assets += 1
                    continue

                has_more = True
                break

            if has_more:
                break

        if has_more:
            break

    return {
        "data": page_assets,
        "count": len(page_assets),
        "offset": offset,
        "limit": limit,
        "hasMore": has_more,
        "nextOffset": offset + len(page_assets) if has_more else None,
    }


async def validate_project_id(
    project_id: str = Query(..., min_length=4),
    db: Session = Depends(get_operational_db),
    current_user: User = Depends(get_current_user_from_session),
):
    if not current_user:
        raise HTTPException(status_code=401, detail="Not authenticated")

    existing = (
        db.query(Task)
        .filter(Task.project_id == project_id.strip(), Task.is_deleted == False)
        .order_by(Task.created_at.desc())
        .first()
    )
    return {
        "success": True,
        "exists": existing is not None,
        "message": "Project ID found" if existing else "Project ID not found. Generate a new one or check the ID.",
        "project": {
            "projectId": existing.project_id,
            "projectName": existing.project_name,
        }
        if existing
        else None,
    }


async def generate_project_id(
    payload: ProjectIdGeneratePayload,
    db: Session = Depends(get_operational_db),
    current_user: User = Depends(get_current_user_from_session),
):
    if not current_user:
        raise HTTPException(status_code=401, detail="Not authenticated")

    date_part = payload.date or datetime.utcnow().strftime("%Y%m%d")
    prefix = f"PROJ-{to_hex4(payload.project_name)}-{date_part}-{to_hex4(payload.customer_name)}"

    candidate = prefix
    suffix = 1
    while db.query(Task).filter(Task.project_id == candidate).first():
        candidate = f"{prefix}-{suffix:02d}"
        suffix += 1

    raw = f"{payload.project_name}{date_part}{payload.customer_name}"
    raw_hex = hashlib.sha1(raw.encode("utf-8")).hexdigest().upper()[:16]

    return {
        "success": True,
        "projectId": candidate,
        "projectIdRaw": raw,
        "projectIdHex": raw_hex,
    }


async def validate_task_id(
    task_id: str = Query(..., min_length=4),
    db: Session = Depends(get_operational_db),
    current_user: User = Depends(get_current_user_from_session),
):
    if not current_user:
        raise HTTPException(status_code=401, detail="Not authenticated")
    existing = db.query(Task).filter(Task.task_number == task_id.strip(), Task.is_deleted == False).first()
    return {
        "success": True,
        "exists": existing is not None,
        "message": "Task ID found" if existing else "Task ID not found. Generate a new one or check the ID.",
    }


async def generate_task_id(
    payload: TaskIdGeneratePayload,
    db: Session = Depends(get_operational_db),
    current_user: User = Depends(get_current_user_from_session),
):
    if not current_user:
        raise HTTPException(status_code=401, detail="Not authenticated")

    date_part = payload.date or datetime.utcnow().strftime("%Y%m%d")
    project_hex = to_hex4(payload.project_name)
    customer_hex = to_hex4(payload.customer_name)
    prefix = f"TASK-{project_hex}-{date_part}-{customer_hex}"
    candidate = prefix
    suffix = 1
    while db.query(Task).filter(Task.task_number == candidate).first():
        candidate = f"{prefix}-{suffix:02d}"
        suffix += 1

    return {
        "success": True,
        "taskId": candidate,
        "taskIdProjectHex": project_hex,
        "taskIdCustomerHex": customer_hex,
    }


async def create_task(
    task_data: TaskCreate,
    db: Session = Depends(get_operational_db),
    current_user: User = Depends(get_current_user_from_session),
):
    if not current_user:
        raise HTTPException(status_code=401, detail="Not authenticated")

    try:
        deadline = parse_deadline(task_data.deadline)

        priority_map = {
            "low": Priority.LOW,
            "medium": Priority.MEDIUM,
            "high": Priority.HIGH,
            "urgent": Priority.URGENT,
        }
        priority = priority_map.get((task_data.priority or "medium").lower(), Priority.MEDIUM)

        if task_data.projectId and not (task_data.projectIdRaw or task_data.projectIdHex):
            existing = db.query(Task).filter(Task.project_id == task_data.projectId).first()
            if not existing:
                raise HTTPException(status_code=400, detail="Project ID not found. Generate a new one or check the ID.")

        if task_data.taskId:
            exists_task_id = db.query(Task).filter(Task.task_number == task_data.taskId).first()
            if exists_task_id:
                raise HTTPException(status_code=400, detail="Task ID already exists. Use a different ID.")
        else:
            date_part = datetime.utcnow().strftime("%Y%m%d")
            task_project_hex = to_hex4(task_data.projectName or task_data.title)
            task_customer_hex = to_hex4(task_data.customerName or current_user.name or "user")
            candidate = f"TASK-{task_project_hex}-{date_part}-{task_customer_hex}"
            suffix = 1
            while db.query(Task).filter(Task.task_number == candidate).first():
                candidate = f"TASK-{task_project_hex}-{date_part}-{task_customer_hex}-{suffix:02d}"
                suffix += 1
            task_data.taskId = candidate

        new_task = Task(
            task_number=task_data.taskId,
            task_id_project_hex=to_hex4(task_data.projectName or task_data.title),
            task_id_customer_hex=to_hex4(task_data.customerName or current_user.name or "user"),
            title=task_data.title,
            description=task_data.description,
            project_name=task_data.projectName,
            project_id=(task_data.projectId or "").strip() or None,
            project_id_raw=task_data.projectIdRaw,
            project_id_hex=task_data.projectIdHex,
            task_type=task_data.taskType,
            task_tag=task_data.taskTag,
            priority=priority,
            creator_id=current_user.id,
            from_department=current_user.department,
            to_department=task_data.toDepartment,
            status=TaskStatus.PENDING,
            workflow_stage="pending_creator_hod",
            deadline=deadline,
            task_edit_locked=False,
            result_edit_locked=True,
            metadata_json={
                "customerName": task_data.customerName,
                "suggestedAssigneeIds": task_data.assigneeIds,
                "reference": (task_data.reference or "").strip() or None,
                "links": [str(x).strip() for x in (task_data.links or []) if str(x).strip()],
                "attachments": [
                    {
                        "filename": item.get("filename"),
                        "originalName": item.get("originalName"),
                        "relativePath": item.get("relativePath"),
                        "path": item.get("path"),
                        "url": item.get("url"),
                        "mimetype": item.get("mimetype"),
                        "size": item.get("size"),
                        "storage": item.get("storage"),
                    }
                    for item in (task_data.attachments or [])
                    if isinstance(item, dict)
                ],
            },
            created_at=datetime.utcnow(),
            updated_at=datetime.utcnow(),
        )

        db.add(new_task)
        db.flush()

        ensure_participant(db, new_task.id, current_user.id, ParticipantRole.CREATOR)

        # Add selected receivers so they can see this in Inbox immediately.
        # They remain passive until approval/assignment actions progress workflow.
        for receiver_id in (task_data.assigneeIds or []):
            receiver = db.query(User).filter(User.id == receiver_id, User.is_active == True).first()
            if not receiver:
                continue
            ensure_participant(db, new_task.id, receiver.id, ParticipantRole.ASSIGNEE)
            create_notification(
                db,
                new_task,
                receiver.id,
                "task_received",
                f"New task received: {new_task.title}",
                "You have been included in a newly created task.",
                actor=current_user,
            )

        creator_hods = db.query(User).filter(
            User.is_active == True,
            User.department == current_user.department,
            User.position.ilike("%hod%"),
            User.id != current_user.id,
        ).all()
        for hod in creator_hods:
            ensure_participant(db, new_task.id, hod.id, ParticipantRole.HOD)
            create_notification(
                db,
                new_task,
                hod.id,
                "pending_hod_approval",
                f"HOD approval required: {new_task.title}",
                "A new task requires your approval before forwarding.",
                actor=current_user,
            )

        add_history(
            db,
            new_task,
            current_user.id,
            "created",
            TaskStatus.PENDING.value,
            "Task created",
        )

        db.commit()
        await invalidate_task_lane_b_cache()
        db.refresh(new_task)

        return {
            "success": True,
            "message": "Task created successfully",
            "data": serialize_task(new_task, db, current_user),
        }

    except HTTPException:
        db.rollback()
        raise
    except Exception as exc:
        db.rollback()
        raise HTTPException(status_code=400, detail=str(exc))


async def get_inbox(
    include_read: bool = Query(True),
    q: Optional[str] = Query(None),
    status: Optional[str] = Query(None),
    page: int = Query(0, ge=0),
    limit: int = Query(50, ge=1, le=50),
    db: Session = Depends(get_operational_db),
    current_user: User = Depends(get_current_user_from_session),
):
    if not current_user:
        raise HTTPException(status_code=401, detail="Not authenticated")

    profile_enabled = _inbox_profile_logging_enabled()
    started_at = perf_counter()

    review_statuses_for_creator = [
        TaskStatus.SUBMITTED,
        TaskStatus.NEED_IMPROVEMENT,
        TaskStatus.APPROVED,
        TaskStatus.COMPLETED,
    ]
    tasks = (
        db.query(Task)
        .options(*_task_list_loader_options())
        .outerjoin(
            TaskParticipant,
            (TaskParticipant.task_id == Task.id) & (TaskParticipant.user_id == current_user.id),
        )
        .filter(
            Task.is_deleted == False,
            or_(
                # Standard inbox visibility for participants (excluding creator role-only rows)
                (
                    (TaskParticipant.user_id == current_user.id)
                    & (TaskParticipant.is_active == True)
                    & (TaskParticipant.role != ParticipantRole.CREATOR)
                ),
                # Creator inbox visibility only for review/result states
                (
                    (Task.creator_id == current_user.id)
                    & (Task.status.in_(review_statuses_for_creator))
                ),
            ),
        )
    )

    if not include_read:
        tasks = tasks.filter(TaskParticipant.is_read == False)
    if status:
        tasks = tasks.filter(Task.status == status)
    if q:
        like_q = f"%{q}%"
        tasks = tasks.filter(
            or_(
                Task.title.ilike(like_q),
                Task.description.ilike(like_q),
                Task.task_number.ilike(like_q),
                Task.project_id.ilike(like_q),
            )
        )

    task_rows = (
        tasks.distinct()
        .order_by(Task.updated_at.desc())
        .offset(page * limit)
        .limit(limit + 1)
        .all()
    )
    query_ms = (perf_counter() - started_at) * 1000
    has_more = len(task_rows) > limit
    if has_more:
        task_rows = task_rows[:limit]

    # Keep inbox fetch read-only. Marking tasks seen/read is handled by the
    # dedicated action endpoint when the user explicitly opens a task.
    write_ms = 0.0

    serialize_started_at = perf_counter()
    result = serialize_task_list(task_rows, db, current_user)
    serialize_ms = (perf_counter() - serialize_started_at) * 1000

    unread_started_at = perf_counter()
    unread_count = TaskHelpers.get_unread_count(current_user.id, db)
    unread_ms = (perf_counter() - unread_started_at) * 1000

    total_ms = (perf_counter() - started_at) * 1000
    if profile_enabled:
        print(
            "[INBOX_PROFILE] "
            f"user_id={current_user.id} "
            f"page={page} limit={limit} tasks={len(task_rows)} has_more={has_more} "
            f"query_ms={query_ms:.2f} write_ms={write_ms:.2f} "
            f"serialize_ms={serialize_ms:.2f} unread_ms={unread_ms:.2f} total_ms={total_ms:.2f}"
        )

    return {
        "success": True,
        "count": len(result),
        "unreadCount": unread_count,
        "page": page,
        "limit": limit,
        "hasMore": has_more,
        "data": result,
    }


async def get_outbox(
    q: Optional[str] = Query(None),
    page: int = Query(0, ge=0),
    limit: int = Query(50, ge=1, le=50),
    db: Session = Depends(get_operational_db),
    current_user: User = Depends(get_current_user_from_session),
):
    if not current_user:
        raise HTTPException(status_code=401, detail="Not authenticated")

    query = db.query(Task).options(*_task_list_loader_options()).filter(
        Task.is_deleted == False,
        or_(
            Task.creator_id == current_user.id,
            Task.submitted_by == current_user.id,
        ),
    )
    if q:
        like_q = f"%{q}%"
        query = query.filter(
            or_(
                Task.title.ilike(like_q),
                Task.task_number.ilike(like_q),
                Task.project_id.ilike(like_q),
            )
        )

    tasks = (
        query.order_by(Task.updated_at.desc())
        .offset(page * limit)
        .limit(limit + 1)
        .all()
    )
    has_more = len(tasks) > limit
    if has_more:
        tasks = tasks[:limit]
    return {
        "success": True,
        "count": len(tasks),
        "page": page,
        "limit": limit,
        "hasMore": has_more,
        "data": serialize_task_list(
            tasks,
            db,
            current_user,
            include_comment_counts=False,
            include_forward_history=False,
            include_seen_by=False,
        ),
    }


@cache_response(ttl=60, vary_by_user=True, namespace="tasks_all")
async def get_all_user_tasks(
    request: Request,
    status: Optional[str] = Query(None),
    q: Optional[str] = Query(None),
    task_id: Optional[str] = Query(None),
    project_id: Optional[str] = Query(None),
    user_id: Optional[int] = Query(None),
    page: int = Query(0, ge=0),
    limit: int = Query(50, ge=1, le=50),
    db: Session = Depends(get_operational_db),
    current_user: User = Depends(get_current_user_from_session),
):
    if not current_user:
        raise HTTPException(status_code=401, detail="Not authenticated")

    # Global visibility: return all tasks for any authenticated user.
    # Trendings/Databank needs cross-user media visibility.
    query = db.query(Task).options(*_task_list_loader_options()).filter(Task.is_deleted == False)

    if status:
        query = query.filter(Task.status == status)
    if task_id:
        query = query.filter(Task.task_number.ilike(f"%{task_id}%"))
    if project_id:
        query = query.filter(Task.project_id.ilike(f"%{project_id}%"))
    if user_id is not None:
        scope_participant = aliased(TaskParticipant)
        query = (
            query.outerjoin(
                scope_participant,
                and_(
                    scope_participant.task_id == Task.id,
                    scope_participant.user_id == user_id,
                    scope_participant.is_active == True,
                ),
            )
            .filter(
                or_(
                    Task.creator_id == user_id,
                    Task.submitted_by == user_id,
                    scope_participant.id.isnot(None),
                )
            )
            .distinct()
        )
    if q:
        like_q = f"%{q}%"
        creator_user = aliased(User)
        search_participant = aliased(TaskParticipant)
        participant_user = aliased(User)
        query = (
            query.join(creator_user, creator_user.id == Task.creator_id)
            .outerjoin(search_participant, search_participant.task_id == Task.id)
            .outerjoin(participant_user, participant_user.id == search_participant.user_id)
            .filter(
                or_(
                    Task.title.ilike(like_q),
                    Task.description.ilike(like_q),
                    Task.task_number.ilike(like_q),
                    Task.project_id.ilike(like_q),
                    Task.project_name.ilike(like_q),
                    Task.from_department.ilike(like_q),
                    Task.to_department.ilike(like_q),
                    creator_user.name.ilike(like_q),
                    participant_user.name.ilike(like_q),
                )
            )
            .distinct()
        )

    tasks = (
        query.order_by(Task.updated_at.desc())
        .offset(page * limit)
        .limit(limit + 1)
        .all()
    )
    has_more = len(tasks) > limit
    if has_more:
        tasks = tasks[:limit]
    return {
        "success": True,
        "count": len(tasks),
        "page": page,
        "limit": limit,
        "hasMore": has_more,
        "tasks": serialize_task_list(tasks, db, current_user),
    }


@cache_response(ttl=90, vary_by_user=False, namespace="tasks_assets")
async def get_task_assets(
    request: Request,
    offset: int = Query(0, ge=0),
    limit: int = Query(60, ge=1, le=120),
    media_type: str = Query("all"),
    department: Optional[str] = Query(None),
    q: Optional[str] = Query(None),
    sort: str = Query("latest"),
    db: Session = Depends(get_operational_db),
    current_user: User = Depends(get_current_user_from_session),
):
    if not current_user:
        raise HTTPException(status_code=401, detail="Not authenticated")

    normalized_media_type = (media_type or "all").strip().lower()
    if normalized_media_type not in ASSET_MEDIA_TYPES:
        raise HTTPException(status_code=400, detail="Invalid media type")

    normalized_sort = (sort or "latest").strip().lower()
    if normalized_sort not in ASSET_SORT_OPTIONS:
        raise HTTPException(status_code=400, detail="Invalid sort option")

    normalized_department = (department or "").strip() or None

    asset_payload = _list_assets_from_tasks(
        db,
        offset=offset,
        limit=limit,
        media_type=normalized_media_type,
        department=normalized_department,
        query=q,
        sort_by=normalized_sort,
    )
    return {"success": True, **asset_payload}


@cache_response(ttl=30, vary_by_user=True, namespace="tasks_unread")
async def get_unread_count(
    request: Request,
    db: Session = Depends(get_operational_db),
    current_user: User = Depends(get_current_user_from_session),
):
    if not current_user:
        raise HTTPException(status_code=401, detail="Not authenticated")
    started_at = perf_counter()
    unread_count = TaskHelpers.get_unread_count(current_user.id, db)
    if _inbox_profile_logging_enabled():
        elapsed_ms = (perf_counter() - started_at) * 1000
        print(f"[INBOX_PROFILE] unread_count user_id={current_user.id} total_ms={elapsed_ms:.2f}")
    return {"success": True, "unreadCount": unread_count}


async def mark_task_seen(
    task_id: int,
    db: Session = Depends(get_operational_db),
    current_user: User = Depends(get_current_user_from_session),
):
    if not current_user:
        raise HTTPException(status_code=401, detail="Not authenticated")

    task = db.query(Task).filter(Task.id == task_id, Task.is_deleted == False).first()
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")

    is_visible = task.creator_id == current_user.id or user_is_participant(task_id, current_user.id, None, db)
    if not is_visible:
        raise HTTPException(status_code=403, detail="Permission denied")

    mark_seen(db, task_id, current_user.id)

    participation = (
        db.query(TaskParticipant)
        .filter(
            TaskParticipant.task_id == task_id,
            TaskParticipant.user_id == current_user.id,
            TaskParticipant.is_active == True,
        )
        .first()
    )
    if participation and not participation.is_read:
        participation.is_read = True
        participation.read_at = datetime.utcnow()

    db.commit()
    await invalidate_pattern(TASK_UNREAD_CACHE_PATTERN)
    return {"success": True, "taskId": task_id}


async def get_forward_targets(
    task_id: Optional[int] = Query(None),
    db: Session = Depends(get_operational_db),
    current_user: User = Depends(get_current_user_from_session),
):
    if not current_user:
        raise HTTPException(status_code=401, detail="Not authenticated")

    users_query = db.query(User).filter(
        User.is_active == True,
        User.id != current_user.id,
    )

    # When forwarding from a task, do not suggest already-active participants.
    if task_id is not None:
        existing_participants = (
            db.query(TaskParticipant.user_id)
            .filter(
                TaskParticipant.task_id == task_id,
                TaskParticipant.is_active == True,
            )
            .all()
        )
        existing_ids = {row[0] for row in existing_participants}
        if existing_ids:
            users_query = users_query.filter(~User.id.in_(existing_ids))

    users = users_query.order_by(User.department.asc(), User.name.asc()).all()
    return {
        "success": True,
        "count": len(users),
        "users": [
            {
                "id": u.id,
                "name": u.name,
                "department": u.department,
                "position": u.position,
                "roles": sorted(list(role_set(u))),
            }
            for u in users
        ],
    }


async def notifications_ws(websocket: WebSocket):
    session_id = (
        websocket.cookies.get("session_id")
        or websocket.query_params.get("session_token")
        or websocket.query_params.get("session_id")
    )
    if not session_id:
        await websocket.close(code=1008)
        return
    db = OperationalSessionLocal()
    try:
        user_id = verify_session_token(session_id, db)
    except Exception:
        await websocket.close(code=1008)
        return
    finally:
        db.close()

    await notification_hub.connect(user_id, websocket)
    try:
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        notification_hub.disconnect(user_id, websocket)


async def assign_task_members(
    task_id: int,
    payload: TaskAssignPayload,
    db: Session = Depends(get_operational_db),
    current_user: User = Depends(get_current_user_from_session),
):
    if not current_user:
        raise HTTPException(status_code=401, detail="Not authenticated")

    task = db.query(Task).filter(Task.id == task_id, Task.is_deleted == False).first()
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")
    if not can_assign(current_user, task):
        raise HTTPException(status_code=403, detail="Permission denied")

    if not task.task_number:
        date_part = datetime.utcnow().strftime("%Y%m%d")
        project_hex = to_hex4(task.project_name or task.title)
        customer_hex = to_hex4(((task.metadata_json or {}).get("customerName")) or (task.to_department or "dept"))
        candidate = f"TASK-{project_hex}-{date_part}-{customer_hex}"
        suffix = 1
        while db.query(Task).filter(Task.task_number == candidate).first():
            candidate = f"TASK-{project_hex}-{date_part}-{customer_hex}-{suffix:02d}"
            suffix += 1
        task.task_number = candidate
        task.task_id_project_hex = project_hex
        task.task_id_customer_hex = customer_hex

    if not task.project_id:
        project_name = task.project_name or "Project"
        customer = (task.metadata_json or {}).get("customerName") or (task.to_department or "Dept")
        date_part = datetime.utcnow().strftime("%Y%m%d")
        task.project_id = f"PROJ-{to_hex4(project_name)}-{date_part}-{to_hex4(customer)}"
        task.project_id_raw = f"{project_name}{date_part}{customer}"
        task.project_id_hex = hashlib.sha1(task.project_id_raw.encode("utf-8")).hexdigest().upper()[:16]

    added = []
    for user_id in payload.assignee_ids:
        user = db.query(User).filter(User.id == user_id, User.is_active == True).first()
        if not user:
            continue
        if task.to_department and user.department != task.to_department:
            continue

        ensure_participant(db, task.id, user.id, ParticipantRole.ASSIGNEE)
        added.append(user.id)
        create_notification(
            db,
            task,
            user.id,
            "assigned",
            f"Task Assigned: {task.title}",
            payload.comments or "You have been assigned a task",
            actor=current_user,
        )

    task.current_assignee_ids_json = added
    task.status = TaskStatus.ASSIGNED
    task.workflow_stage = "assigned"
    task.result_edit_locked = False
    task.updated_at = datetime.utcnow()

    add_history(
        db,
        task,
        current_user.id,
        "assigned",
        TaskStatus.ASSIGNED.value,
        payload.comments or f"Assigned to {len(added)} member(s)",
        {"assigneeIds": added, "taskNumber": task.task_number, "projectId": task.project_id},
    )

    db.commit()
    await invalidate_task_lane_b_cache()

    return {
        "success": True,
        "message": "Task assigned",
        "assignedUserIds": added,
        "taskNumber": task.task_number,
        "projectId": task.project_id,
    }


async def submit_task(
    task_id: int,
    payload: TaskActionPayload,
    db: Session = Depends(get_operational_db),
    current_user: User = Depends(get_current_user_from_session),
):
    if not current_user:
        raise HTTPException(status_code=401, detail="Not authenticated")

    task = db.query(Task).filter(Task.id == task_id, Task.is_deleted == False).first()
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")

    is_assignee = user_is_participant(task.id, current_user.id, ParticipantRole.ASSIGNEE, db)
    if not is_assignee:
        raise HTTPException(status_code=403, detail="Only assignee can submit")

    has_result_update = bool(payload.result_text or payload.result_links or payload.result_attachments)
    if has_result_update:
        meta = dict(task.metadata_json or {})
        before = {
            "resultText": task.result_text,
            "resultVersion": task.result_version,
            "resultLinks": meta.get("resultLinks", []),
            "resultAttachments": meta.get("resultAttachments", []),
        }
        task.result_text = payload.result_text
        # Store structured result artifacts in task metadata for receiver-side preview.
        if payload.result_links:
            meta["resultLinks"] = [str(x).strip() for x in payload.result_links if str(x).strip()]
        if payload.result_attachments:
            normalized_attachments = []
            for item in payload.result_attachments:
                if not isinstance(item, dict):
                    continue
                normalized_attachments.append(
                    {
                        "filename": item.get("filename"),
                        "originalName": item.get("originalName"),
                        "relativePath": item.get("relativePath"),
                        "path": item.get("path"),
                        "url": item.get("url"),
                        "mimetype": item.get("mimetype"),
                        "size": item.get("size"),
                        "storage": item.get("storage"),
                    }
                )
            meta["resultAttachments"] = normalized_attachments
        task.metadata_json = meta
        task.result_version = (task.result_version or 0) + 1
        db.add(
            TaskEditLog(
                task_id=task.id,
                user_id=current_user.id,
                edit_scope="result",
                before_json=before,
                after_json={
                    "resultText": task.result_text,
                    "resultVersion": task.result_version,
                    "resultLinks": meta.get("resultLinks", []),
                    "resultAttachments": meta.get("resultAttachments", []),
                },
                created_at=datetime.utcnow(),
            )
        )

    task.status = TaskStatus.SUBMITTED
    task.workflow_stage = "submitted_to_spoc"
    task.submitted_at = datetime.utcnow()
    task.submitted_by = current_user.id
    task.result_edit_locked = True
    task.updated_at = datetime.utcnow()

    add_history(db, task, current_user.id, "submitted", TaskStatus.SUBMITTED.value, payload.comments)

    spocs = db.query(User).filter(
        User.is_active == True,
        User.department == task.to_department,
        User.position.ilike("%spoc%"),
    ).all()
    for spoc in spocs:
        ensure_participant(db, task.id, spoc.id, ParticipantRole.SPOC)
        create_notification(
            db,
            task,
            spoc.id,
            "submitted",
            f"Task Submitted: {task.title}",
            "A task is awaiting your review.",
            actor=current_user,
        )

    # Creator should always receive submitted results for final review.
    create_notification(
        db,
        task,
        task.creator_id,
        "submitted",
        f"Task Submitted: {task.title}",
        "A submitted task is ready for your review.",
        actor=current_user,
    )

    db.commit()
    await invalidate_task_lane_b_cache()
    return {"success": True, "message": "Task submitted for SPOC review"}


async def start_task_work(
    task_id: int,
    payload: TaskActionPayload,
    db: Session = Depends(get_operational_db),
    current_user: User = Depends(get_current_user_from_session),
):
    if not current_user:
        raise HTTPException(status_code=401, detail="Not authenticated")

    task = db.query(Task).filter(Task.id == task_id, Task.is_deleted == False).first()
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")

    is_assignee = user_is_participant(task.id, current_user.id, ParticipantRole.ASSIGNEE, db)
    if not is_assignee:
        raise HTTPException(status_code=403, detail="Only assignee can start work")

    if task.status not in {TaskStatus.PENDING, TaskStatus.FORWARDED, TaskStatus.ASSIGNED, TaskStatus.NEED_IMPROVEMENT}:
        raise HTTPException(status_code=400, detail="Task cannot be started in current state")

    task.status = TaskStatus.IN_PROGRESS
    task.workflow_stage = "in_progress"
    task.started_at = datetime.utcnow()
    task.result_edit_locked = False
    task.updated_at = datetime.utcnow()

    add_history(
        db,
        task,
        current_user.id,
        "started",
        TaskStatus.IN_PROGRESS.value,
        payload.comments or "Work started",
    )

    notified_users = {task.creator_id}
    participants = db.query(TaskParticipant).filter(
        TaskParticipant.task_id == task.id,
        TaskParticipant.is_active == True,
    ).all()
    for participant in participants:
        if participant.user_id != current_user.id:
            notified_users.add(participant.user_id)

    for user_id in notified_users:
        create_notification(
            db,
            task,
            user_id,
            "started",
            f"Task Started: {task.title}",
            payload.comments or f"{current_user.name} started working on this task.",
            actor=current_user,
        )

    db.commit()
    await invalidate_task_lane_b_cache()
    return {"success": True, "message": "Task marked as in progress"}


async def approve_task(
    task_id: int,
    payload: TaskActionPayload,
    db: Session = Depends(get_operational_db),
    current_user: User = Depends(get_current_user_from_session),
):
    if not current_user:
        raise HTTPException(status_code=401, detail="Not authenticated")

    task = db.query(Task).filter(Task.id == task_id, Task.is_deleted == False).first()
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")
    if not can_approve(current_user, task):
        raise HTTPException(status_code=403, detail="Permission denied")

    actor_roles = role_set(current_user)
    if current_user.id == task.creator_id and task.status in {TaskStatus.SUBMITTED, TaskStatus.APPROVED}:
        task.status = TaskStatus.COMPLETED
        task.workflow_stage = "creator_approved"
        task.task_edit_locked = True
        task.result_edit_locked = True
    elif "spoc" in actor_roles:
        task.status = TaskStatus.APPROVED
        task.workflow_stage = "spoc_approved"
        create_notification(
            db,
            task,
            task.creator_id,
            "approved",
            f"Task ready for final creator approval: {task.title}",
            payload.comments or "SPOC has approved the submitted result.",
            actor=current_user,
        )
    elif "hod" in actor_roles:
        task.status = TaskStatus.FORWARDED
        task.workflow_stage = "hod_approved"
    else:
        task.status = TaskStatus.APPROVED
        task.workflow_stage = "approved"

    task.updated_at = datetime.utcnow()
    add_history(db, task, current_user.id, "approved", task.status.value, payload.comments)
    post_system_comment(db, task, current_user.id, payload.comments or "Approved", "approved")

    participants = db.query(TaskParticipant).filter(TaskParticipant.task_id == task.id, TaskParticipant.is_active == True).all()
    notified = {task.creator_id}
    for participant in participants:
        notified.add(participant.user_id)
    for user_id in notified:
        create_notification(
            db,
            task,
            user_id,
            "approved",
            f"Task Approved: {task.title}",
            payload.comments or f"Approved by {current_user.name}",
            actor=current_user,
        )

    db.commit()
    await invalidate_task_lane_b_cache()
    return {"success": True, "message": "Task approved", "status": task.status.value}


async def request_improvement(
    task_id: int,
    payload: TaskActionPayload,
    db: Session = Depends(get_operational_db),
    current_user: User = Depends(get_current_user_from_session),
):
    if not current_user:
        raise HTTPException(status_code=401, detail="Not authenticated")

    task = db.query(Task).filter(Task.id == task_id, Task.is_deleted == False).first()
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")
    if not can_approve(current_user, task):
        raise HTTPException(status_code=403, detail="Permission denied")

    previous_status = task.status
    task.status = TaskStatus.NEED_IMPROVEMENT
    task.workflow_stage = "need_improvement"
    task.updated_at = datetime.utcnow()
    if previous_status in {TaskStatus.PENDING, TaskStatus.FORWARDED}:
        task.task_edit_locked = False
    task.result_edit_locked = False

    add_history(
        db,
        task,
        current_user.id,
        "need_improvement",
        TaskStatus.NEED_IMPROVEMENT.value,
        payload.comments,
    )
    post_system_comment(db, task, current_user.id, payload.comments or "Need improvement", "need_improvement")

    assignees = db.query(TaskParticipant).filter(
        TaskParticipant.task_id == task.id,
        TaskParticipant.role == ParticipantRole.ASSIGNEE,
        TaskParticipant.is_active == True,
    ).all()

    recipients = {a.user_id for a in assignees}
    if not recipients:
        recipients.add(task.creator_id)

    for user_id in recipients:
        create_notification(
            db,
            task,
            user_id,
            "need_improvement",
            f"Need Improvement: {task.title}",
            payload.comments or "Please revise and resubmit.",
            actor=current_user,
        )

    db.commit()
    await invalidate_task_lane_b_cache()
    return {"success": True, "message": "Task marked as Need Improvement"}


async def forward_task(
    task_id: int,
    payload: TaskForwardPayload,
    db: Session = Depends(get_operational_db),
    current_user: User = Depends(get_current_user_from_session),
):
    if not current_user:
        raise HTTPException(status_code=401, detail="Not authenticated")

    task = db.query(Task).filter(Task.id == task_id, Task.is_deleted == False).first()
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")

    roles = role_set(current_user)
    is_assignee = user_is_participant(task.id, current_user.id, ParticipantRole.ASSIGNEE, db)
    if not ("super_admin" in roles or "hod" in roles or "spoc" in roles or (is_assignee and task.status == TaskStatus.APPROVED)):
        raise HTTPException(status_code=403, detail="Permission denied")

    normalized_user_ids = sorted({uid for uid in (payload.to_user_ids or []) if uid})
    if payload.to_user_id and payload.to_user_id not in normalized_user_ids:
        normalized_user_ids.append(payload.to_user_id)

    if not payload.to_department and not normalized_user_ids:
        raise HTTPException(status_code=400, detail="to_department or to_user_id(s) required")

    target_users: List[User] = []
    if normalized_user_ids:
        users = db.query(User).filter(User.id.in_(normalized_user_ids), User.is_active == True).all()
        existing_ids = {u.id for u in users}
        missing_ids = [uid for uid in normalized_user_ids if uid not in existing_ids]
        if missing_ids:
            raise HTTPException(status_code=404, detail=f"Target user(s) not found: {missing_ids}")
        user_map = {u.id: u for u in users}
        target_users = [user_map[uid] for uid in normalized_user_ids if uid in user_map]
    elif payload.to_department:
        query = db.query(User).filter(User.department == payload.to_department, User.is_active == True)
        if "hod" in roles:
            query = query.filter(User.position.ilike("%hod%"))
        else:
            query = query.filter(or_(User.position.ilike("%hod%"), User.position.ilike("%spoc%")))
        target_users = query.all()

    if not target_users:
        raise HTTPException(status_code=404, detail="No eligible target users found")

    for target in target_users:
        role = ParticipantRole.APPROVER
        position = (target.position or "").lower()
        if "hod" in position:
            role = ParticipantRole.HOD
        elif "spoc" in position:
            role = ParticipantRole.SPOC

        ensure_participant(db, task.id, target.id, role)
        db.add(
            TaskForward(
                task_id=task.id,
                from_user_id=current_user.id,
                to_user_id=target.id,
                from_department=current_user.department,
                to_department=target.department,
                reason=payload.comments,
                created_at=datetime.utcnow(),
            )
        )
        create_notification(
            db,
            task,
            target.id,
            "forwarded",
            f"Task Forwarded: {task.title}",
            payload.comments or "A task has been forwarded to you.",
            actor=current_user,
        )

    if payload.to_department:
        task.to_department = payload.to_department
    elif target_users:
        task.to_department = target_users[0].department
    task.status = TaskStatus.FORWARDED
    task.workflow_stage = "forwarded"
    task.updated_at = datetime.utcnow()

    add_history(
        db,
        task,
        current_user.id,
        "forwarded",
        TaskStatus.FORWARDED.value,
        payload.comments,
        {
            "toDepartment": payload.to_department,
            "toUserId": payload.to_user_id,
            "toUserIds": normalized_user_ids,
        },
    )

    db.commit()
    await invalidate_task_lane_b_cache()
    return {"success": True, "message": "Task forwarded", "recipientCount": len(target_users)}


async def revoke_task(
    task_id: int,
    payload: TaskActionPayload,
    db: Session = Depends(get_operational_db),
    current_user: User = Depends(get_current_user_from_session),
):
    if not current_user:
        raise HTTPException(status_code=401, detail="Not authenticated")

    task = db.query(Task).filter(Task.id == task_id, Task.is_deleted == False).first()
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")

    if current_user.id != task.creator_id:
        raise HTTPException(status_code=403, detail="Only task creator can revoke this task")

    if task.status in {TaskStatus.COMPLETED, TaskStatus.CANCELLED, TaskStatus.REJECTED}:
        raise HTTPException(status_code=400, detail="Task cannot be revoked in current state")

    revoke_note = (payload.comments or "").strip()
    now = datetime.utcnow()
    meta = dict(task.metadata_json or {})
    revocation = {
        "regularised": True,
        "revokedById": current_user.id,
        "revokedBy": current_user.name,
        "revokedAt": now.isoformat(),
        "reason": revoke_note or None,
    }
    meta["revocation"] = revocation
    task.metadata_json = meta

    task.status = TaskStatus.CANCELLED
    task.workflow_stage = "revoked_regularised"
    task.task_edit_locked = True
    task.result_edit_locked = True
    task.updated_at = now

    history_comment = revoke_note or "Task revoked (regularised) by creator"
    add_history(
        db,
        task,
        current_user.id,
        "revoked",
        TaskStatus.CANCELLED.value,
        history_comment,
        {"revocation": revocation},
    )
    post_system_comment(db, task, current_user.id, history_comment, "revoked")

    participants = db.query(TaskParticipant).filter(
        TaskParticipant.task_id == task.id,
        TaskParticipant.is_active == True,
    ).all()

    notify_message = "This task has been revoked (regularised) by the creator."
    if revoke_note:
        notify_message = f"{notify_message} Reason: {revoke_note}"

    notified_users = set()
    for participant in participants:
        if participant.user_id == current_user.id:
            continue
        participant.is_read = False
        participant.read_at = None
        notified_users.add(participant.user_id)

    for user_id in notified_users:
        create_notification(
            db,
            task,
            user_id,
            "revoked",
            f"Task Revoked: {task.title}",
            notify_message,
            actor=current_user,
            metadata_json={"revocation": revocation},
        )

    db.commit()
    await invalidate_task_lane_b_cache()
    return {
        "success": True,
        "message": "Task revoked successfully",
        "status": task.status.value,
        "revocation": revocation,
    }


async def edit_task_details(
    task_id: int,
    payload: TaskUpdate,
    db: Session = Depends(get_operational_db),
    current_user: User = Depends(get_current_user_from_session),
):
    if not current_user:
        raise HTTPException(status_code=401, detail="Not authenticated")

    task = db.query(Task).filter(Task.id == task_id, Task.is_deleted == False).first()
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")
    if current_user.id != task.creator_id:
        raise HTTPException(status_code=403, detail="Only creator can edit task details")
    if task.task_edit_locked:
        raise HTTPException(status_code=400, detail="Task editing is locked")

    before = {
        "title": task.title,
        "description": task.description,
        "priority": task.priority.value if task.priority else None,
        "deadline": task.deadline.isoformat() if task.deadline else None,
        "taskVersion": task.task_version,
    }

    if payload.title is not None:
        task.title = payload.title
    if payload.description is not None:
        task.description = payload.description
    if payload.priority is not None:
        task.priority = Priority[payload.priority.upper()]
    if payload.deadline is not None:
        task.deadline = parse_deadline(payload.deadline)

    task.task_version = (task.task_version or 1) + 1
    task.updated_at = datetime.utcnow()

    db.add(
        TaskEditLog(
            task_id=task.id,
            user_id=current_user.id,
            edit_scope="task",
            before_json=before,
            after_json={
                "title": task.title,
                "description": task.description,
                "priority": task.priority.value if task.priority else None,
                "deadline": task.deadline.isoformat() if task.deadline else None,
                "taskVersion": task.task_version,
            },
            created_at=datetime.utcnow(),
        )
    )
    add_history(db, task, current_user.id, "task_edited", task.status.value, "Task details edited")

    participants = db.query(TaskParticipant).filter(
        TaskParticipant.task_id == task.id,
        TaskParticipant.is_active == True,
    ).all()
    recipients = {task.creator_id}
    recipients.update({p.user_id for p in participants})
    recipients.discard(current_user.id)
    edit_no = max(1, (task.task_version or 1) - 1)
    for participant in participants:
        if participant.user_id == current_user.id:
            continue
        participant.is_read = False
        participant.read_at = None
    for user_id in recipients:
        create_notification(
            db,
            task,
            user_id,
            "task_edited",
            f"Task Updated (Edit #{edit_no}): {task.title}",
            f"Task details were updated. Edit #{edit_no}.",
            actor=current_user,
            metadata_json={"editCount": edit_no, "taskVersion": task.task_version},
        )

    db.commit()
    await invalidate_task_lane_b_cache()
    return {"success": True, "message": "Task updated", "data": serialize_task(task, db, current_user)}


async def edit_task_result(
    task_id: int,
    payload: ResultEditPayload,
    db: Session = Depends(get_operational_db),
    current_user: User = Depends(get_current_user_from_session),
):
    if not current_user:
        raise HTTPException(status_code=401, detail="Not authenticated")

    task = db.query(Task).filter(Task.id == task_id, Task.is_deleted == False).first()
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")
    if not user_is_participant(task.id, current_user.id, ParticipantRole.ASSIGNEE, db):
        raise HTTPException(status_code=403, detail="Only assignee can edit result")
    if task.result_edit_locked:
        raise HTTPException(status_code=400, detail="Result editing is locked")

    before = {"resultText": task.result_text, "resultVersion": task.result_version}
    task.result_text = payload.result_text
    task.result_version = (task.result_version or 0) + 1
    task.updated_at = datetime.utcnow()

    db.add(
        TaskEditLog(
            task_id=task.id,
            user_id=current_user.id,
            edit_scope="result",
            before_json=before,
            after_json={"resultText": task.result_text, "resultVersion": task.result_version},
            created_at=datetime.utcnow(),
        )
    )
    add_history(db, task, current_user.id, "result_edited", task.status.value, "Result edited")

    participants = db.query(TaskParticipant).filter(
        TaskParticipant.task_id == task.id,
        TaskParticipant.is_active == True,
    ).all()
    recipients = {task.creator_id}
    recipients.update({p.user_id for p in participants})
    recipients.discard(current_user.id)
    for participant in participants:
        if participant.user_id == current_user.id:
            continue
        participant.is_read = False
        participant.read_at = None
    for user_id in recipients:
        create_notification(
            db,
            task,
            user_id,
            "result_edited",
            f"Result Updated: {task.title}",
            "Task result has been edited.",
            actor=current_user,
            metadata_json={"resultVersion": task.result_version},
        )

    db.commit()
    await invalidate_task_lane_b_cache()
    return {"success": True, "message": "Result updated"}


async def add_comment(
    task_id: int,
    payload: TaskCommentPayload,
    db: Session = Depends(get_operational_db),
    current_user: User = Depends(get_current_user_from_session),
):
    if not current_user:
        raise HTTPException(status_code=401, detail="Not authenticated")

    task = db.query(Task).filter(Task.id == task_id, Task.is_deleted == False).first()
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")

    is_participant = user_is_participant(task.id, current_user.id, None, db)
    if current_user.id != task.creator_id and not is_participant:
        raise HTTPException(status_code=403, detail="Permission denied")

    new_comment = TaskComment(
        task_id=task.id,
        user_id=current_user.id,
        comment=payload.comment,
        comment_type=(payload.comment_type or "general")[:40],
        is_internal=payload.is_internal,
        created_at=datetime.utcnow(),
    )
    db.add(new_comment)
    try:
        mark_seen(db, task.id, current_user.id)
    except SQLAlchemyError:
        pass
    add_history(db, task, current_user.id, "commented", task.status.value, payload.comment)
    db.flush()

    participants = db.query(TaskParticipant).filter(
        TaskParticipant.task_id == task.id,
        TaskParticipant.is_active == True,
    ).all()
    recipients = {task.creator_id}
    recipients.update({p.user_id for p in participants})
    recipients.discard(current_user.id)
    comment_meta = {
        "taskId": task.id,
        "taskNumber": task.task_number,
        "projectId": task.project_id,
        "commentId": new_comment.id,
        "senderId": current_user.id,
        "senderName": current_user.name,
        "createdAt": new_comment.created_at.isoformat() if new_comment.created_at else None,
        "commentType": new_comment.comment_type,
    }
    for user_id in recipients:
        create_notification(
            db,
            task,
            user_id,
            "task_comment",
            f"New comment on {task.title}",
            payload.comment[:180],
            actor=current_user,
            metadata_json=comment_meta,
        )
    db.commit()
    db.refresh(new_comment)

    return {
        "success": True,
        "comment": {
            "id": new_comment.id,
            "taskId": new_comment.task_id,
            "userId": new_comment.user_id,
            "comment": new_comment.comment,
            "commentType": new_comment.comment_type,
            "isInternal": new_comment.is_internal,
            "createdAt": new_comment.created_at.isoformat(),
            "user": {
                "id": current_user.id,
                "name": current_user.name,
                "role": ", ".join(sorted(role_set(current_user))),
                "department": current_user.department,
            },
        },
    }


async def get_comments(
    task_id: int,
    page: int = Query(1, ge=1),
    page_size: int = Query(40, ge=1, le=100),
    include_history: bool = Query(False),
    include_seen_by: bool = Query(True),
    include_total: bool = Query(False),
    db: Session = Depends(get_operational_db),
    current_user: User = Depends(get_current_user_from_session),
):
    if not current_user:
        raise HTTPException(status_code=401, detail="Not authenticated")

    task = db.query(Task).filter(Task.id == task_id, Task.is_deleted == False).first()
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")

    if current_user.id != task.creator_id and not user_is_participant(task.id, current_user.id, None, db):
        raise HTTPException(status_code=403, detail="Permission denied")

    try:
        mark_seen(db, task.id, current_user.id)
    except SQLAlchemyError:
        pass

    comments_query = (
        db.query(TaskComment, User)
        .join(User, User.id == TaskComment.user_id)
        .filter(TaskComment.task_id == task_id)
        .order_by(TaskComment.created_at.asc(), TaskComment.id.asc())
    )
    total_comments = None
    if include_total:
        total_comments = (
            db.query(func.count(TaskComment.id))
            .filter(TaskComment.task_id == task_id)
            .scalar()
            or 0
        )
    comment_rows = comments_query.offset((page - 1) * page_size).limit(page_size).all()

    response = [
        {
            "id": comment.id,
            "taskId": comment.task_id,
            "comment": comment.comment,
            "commentType": comment.comment_type or "general",
            "isInternal": comment.is_internal,
            "createdAt": comment.created_at.isoformat() if comment.created_at else None,
            "user": {
                "id": user.id if user else None,
                "name": user.name if user else "Unknown",
                "role": ", ".join(sorted(role_set(user))) if user else "unknown",
                "department": user.department if user else None,
            },
        }
        for comment, user in comment_rows
    ]

    seen_by_rows = []
    if include_seen_by:
        try:
            seen_by_rows = (
                db.query(TaskView, User)
                .join(User, User.id == TaskView.user_id)
                .filter(TaskView.task_id == task_id)
                .all()
            )
        except SQLAlchemyError:
            seen_by_rows = []
    history_rows = []
    history_user_lookup = {}
    if include_history:
        try:
            history_rows = db.query(TaskEditLog).filter(TaskEditLog.task_id == task_id).order_by(TaskEditLog.created_at.desc()).limit(100).all()
        except SQLAlchemyError:
            history_rows = []
        history_user_ids = list({row.user_id for row in history_rows if row.user_id})
        if history_user_ids:
            history_user_lookup = {
                user.id: user
                for user in db.query(User).filter(User.id.in_(history_user_ids)).all()
            }
    db.commit()

    return {
        "success": True,
        "task": {
            "id": task.id,
            "taskNumber": task.task_number,
            "projectId": task.project_id,
            "title": task.title,
        },
        "comments": response,
        "pagination": {
            "page": page,
            "pageSize": page_size,
            "total": total_comments,
        },
        "history": [
            {
                "id": h.id,
                "scope": h.edit_scope,
                "before": h.before_json,
                "after": h.after_json,
                "timestamp": h.created_at.isoformat() if h.created_at else None,
                "editor": {
                    "id": editor.id if editor else None,
                    "name": editor.name if editor else "Unknown",
                    "role": ", ".join(sorted(role_set(editor))) if editor else "unknown",
                    "department": editor.department if editor else None,
                },
            }
            for h in history_rows
            for editor in [history_user_lookup.get(h.user_id)]
        ],
        "seenBy": [
            {
                "id": user.id,
                "name": user.name,
                "role": ", ".join(sorted(role_set(user))),
                "department": user.department,
                "seenAt": view.seen_at.isoformat() if view.seen_at else None,
            }
            for view, user in seen_by_rows
        ],
    }


async def get_my_notifications(
    unread_only: bool = Query(False),
    db: Session = Depends(get_operational_db),
    current_user: User = Depends(get_current_user_from_session),
):
    if not current_user:
        raise HTTPException(status_code=401, detail="Not authenticated")

    query = db.query(TaskNotification).filter(TaskNotification.user_id == current_user.id)
    if unread_only:
        query = query.filter(TaskNotification.is_read == False)
    items = query.order_by(TaskNotification.created_at.desc()).limit(200).all()

    return {
        "success": True,
        "count": len(items),
        "notifications": [
            {
                "id": n.id,
                "taskId": n.task_id,
                "taskNumber": n.task_number,
                "projectId": n.project_id,
                "eventType": n.event_type,
                "title": n.title,
                "message": n.message,
                "actorName": (n.metadata_json or {}).get("actorName"),
                "actorRole": (n.metadata_json or {}).get("actorRole"),
                "actorDepartment": (n.metadata_json or {}).get("actorDepartment"),
                "summary": (
                    f"{(n.metadata_json or {}).get('actorDescription', 'Someone')} {n.message or n.title}"
                ).strip(),
                "isRead": n.is_read,
                "createdAt": n.created_at.isoformat() if n.created_at else None,
                "metadata": n.metadata_json,
            }
            for n in items
        ],
    }


async def get_outbox_unread_count(
    db: Session = Depends(get_operational_db),
    current_user: User = Depends(get_current_user_from_session),
):
    if not current_user:
        raise HTTPException(status_code=401, detail="Not authenticated")

    count = (
        db.query(func.count(TaskNotification.id))
        .join(Task, Task.id == TaskNotification.task_id)
        .filter(
            TaskNotification.user_id == current_user.id,
            TaskNotification.is_read == False,
            Task.creator_id == current_user.id,
            Task.is_deleted == False,
        )
        .scalar()
        or 0
    )
    return {"success": True, "unreadCount": count}


async def mark_notification_read(
    notification_id: int,
    db: Session = Depends(get_operational_db),
    current_user: User = Depends(get_current_user_from_session),
):
    if not current_user:
        raise HTTPException(status_code=401, detail="Not authenticated")

    n = db.query(TaskNotification).filter(
        TaskNotification.id == notification_id,
        TaskNotification.user_id == current_user.id,
    ).first()
    if not n:
        raise HTTPException(status_code=404, detail="Notification not found")

    n.is_read = True
    n.read_at = datetime.utcnow()
    db.commit()
    return {"success": True, "message": "Notification marked as read"}


async def delete_notification(
    notification_id: int,
    db: Session = Depends(get_operational_db),
    current_user: User = Depends(get_current_user_from_session),
):
    if not current_user:
        raise HTTPException(status_code=401, detail="Not authenticated")

    n = db.query(TaskNotification).filter(
        TaskNotification.id == notification_id,
        TaskNotification.user_id == current_user.id,
    ).first()
    if not n:
        raise HTTPException(status_code=404, detail="Notification not found")

    db.delete(n)
    db.commit()
    return {"success": True, "message": "Notification removed"}


async def debug_current_user(
    db: Session = Depends(get_operational_db),
    current_user: User = Depends(get_current_user_from_session),
):
    if not current_user:
        return {"authenticated": False, "message": "No user logged in"}

    return {
        "authenticated": True,
        "user": {
            "id": current_user.id,
            "name": current_user.name,
            "email": current_user.email,
            "department": current_user.department,
            "position": current_user.position,
            "resolvedRoles": sorted(list(role_set(current_user))),
        },
        "stats": TaskHelpers.get_task_statistics(current_user.id, db),
    }
