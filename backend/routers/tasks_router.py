from fastapi import APIRouter, HTTPException, Depends, Query, Cookie, WebSocket, WebSocketDisconnect
from sqlalchemy.orm import Session
from sqlalchemy import or_
from sqlalchemy.exc import SQLAlchemyError
from typing import Optional, List, Set
from pydantic import BaseModel, Field
from datetime import datetime
import asyncio
import hashlib
import re

from database_config import get_operational_db
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
from auth import verify_session_token
from task_helpers import TaskHelpers

router = APIRouter(prefix="/api/tasks", tags=["Tasks"])


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
    db: Session = Depends(get_operational_db),
):
    if not session_id:
        return None
    try:
        user_id = verify_session_token(session_id)
        return db.query(User).filter(User.id == user_id).first()
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


def compute_available_actions(task: Task, user: User, db: Session) -> List[str]:
    roles = role_set(user)
    actions = ["chat"]
    is_creator = user.id == task.creator_id
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
        if task.status in {TaskStatus.PENDING, TaskStatus.NEED_IMPROVEMENT, TaskStatus.FORWARDED}:
            actions.append("edit_task")
        if task.status in {TaskStatus.SUBMITTED, TaskStatus.APPROVED}:
            actions.extend(["approve", "need_improvement"])

    deduped = []
    for action in actions:
        if action not in deduped:
            deduped.append(action)
    return deduped


def serialize_task(task: Task, db: Session, current_user: Optional[User] = None) -> dict:
    task_dict = task.to_dict()
    meta = task.metadata_json or {}
    task_dict["customerName"] = meta.get("customerName")
    task_dict["reference"] = meta.get("reference")
    task_dict["links"] = meta.get("links", [])
    task_dict["attachments"] = meta.get("attachments", [])
    task_dict["resultText"] = task.result_text
    task_dict["resultLinks"] = meta.get("resultLinks", [])
    task_dict["resultAttachments"] = meta.get("resultAttachments", [])
    creator = db.query(User).filter(User.id == task.creator_id).first()
    task_dict["creator"] = {
        "id": creator.id if creator else None,
        "name": creator.name if creator else "Unknown",
        "department": creator.department if creator else None,
    }

    participants = db.query(TaskParticipant).join(User, User.id == TaskParticipant.user_id).filter(
        TaskParticipant.task_id == task.id,
        TaskParticipant.is_active == True,
    ).all()
    task_dict["assignedTo"] = [
        {
            "id": p.user.id,
            "name": p.user.name,
            "department": p.user.department,
            "role": p.role.value,
        }
        for p in participants
        if p.role == ParticipantRole.ASSIGNEE
    ]

    comments_count = db.query(TaskComment).filter(TaskComment.task_id == task.id).count()
    forwards = (
        db.query(TaskForward)
        .filter(TaskForward.task_id == task.id)
        .order_by(TaskForward.created_at.asc())
        .all()
    )
    forward_history = []
    for fwd in forwards:
        from_user = db.query(User).filter(User.id == fwd.from_user_id).first()
        to_user = db.query(User).filter(User.id == fwd.to_user_id).first() if fwd.to_user_id else None
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
        my_participation = db.query(TaskParticipant).filter(
            TaskParticipant.task_id == task.id,
            TaskParticipant.user_id == current_user.id,
            TaskParticipant.is_active == True,
        ).first()
        task_dict["isRead"] = my_participation.is_read if my_participation else False
        task_dict["myRole"] = my_participation.role.value if my_participation else "creator"
        task_dict["availableActions"] = compute_available_actions(task, current_user, db)
        task_dict["mySystemRoles"] = sorted(list(role_set(current_user)))

    return task_dict


@router.get("/project-id/validate")
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


@router.post("/project-id/generate")
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


@router.get("/task-id/validate")
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


@router.post("/task-id/generate")
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


@router.post("/create")
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


@router.get("/inbox")
async def get_inbox(
    include_read: bool = Query(True),
    q: Optional[str] = Query(None),
    status: Optional[str] = Query(None),
    db: Session = Depends(get_operational_db),
    current_user: User = Depends(get_current_user_from_session),
):
    if not current_user:
        raise HTTPException(status_code=401, detail="Not authenticated")

    review_statuses_for_creator = [
        TaskStatus.SUBMITTED,
        TaskStatus.NEED_IMPROVEMENT,
        TaskStatus.APPROVED,
        TaskStatus.COMPLETED,
    ]
    tasks = (
        db.query(Task)
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

    task_rows = tasks.distinct().order_by(Task.updated_at.desc()).all()

    result = []
    for task in task_rows:
        try:
            mark_seen(db, task.id, current_user.id)
        except SQLAlchemyError:
            pass
        participation = db.query(TaskParticipant).filter(
            TaskParticipant.task_id == task.id,
            TaskParticipant.user_id == current_user.id,
            TaskParticipant.is_active == True,
        ).first()
        if participation and not participation.is_read:
            participation.is_read = True
            participation.read_at = datetime.utcnow()
        result.append(serialize_task(task, db, current_user))

    db.commit()

    return {
        "success": True,
        "count": len(result),
        "unreadCount": TaskHelpers.get_unread_count(current_user.id, db),
        "data": result,
    }


@router.get("/outbox")
async def get_outbox(
    q: Optional[str] = Query(None),
    db: Session = Depends(get_operational_db),
    current_user: User = Depends(get_current_user_from_session),
):
    if not current_user:
        raise HTTPException(status_code=401, detail="Not authenticated")

    query = db.query(Task).filter(
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

    tasks = query.order_by(Task.updated_at.desc()).all()
    return {
        "success": True,
        "count": len(tasks),
        "data": [serialize_task(t, db, current_user) for t in tasks],
    }


@router.get("/all")
async def get_all_user_tasks(
    status: Optional[str] = Query(None),
    q: Optional[str] = Query(None),
    task_id: Optional[str] = Query(None),
    project_id: Optional[str] = Query(None),
    db: Session = Depends(get_operational_db),
    current_user: User = Depends(get_current_user_from_session),
):
    if not current_user:
        raise HTTPException(status_code=401, detail="Not authenticated")

    query = db.query(Task).filter(
        Task.is_deleted == False,
        or_(Task.creator_id == current_user.id, Task.participants.any(TaskParticipant.user_id == current_user.id)),
    )

    if status:
        query = query.filter(Task.status == status)
    if task_id:
        query = query.filter(Task.task_number.ilike(f"%{task_id}%"))
    if project_id:
        query = query.filter(Task.project_id.ilike(f"%{project_id}%"))
    if q:
        like_q = f"%{q}%"
        query = query.filter(
            or_(
                Task.title.ilike(like_q),
                Task.description.ilike(like_q),
                Task.task_number.ilike(like_q),
                Task.project_id.ilike(like_q),
                Task.project_name.ilike(like_q),
                Task.from_department.ilike(like_q),
                Task.to_department.ilike(like_q),
                Task.creator.has(User.name.ilike(like_q)),
                Task.participants.any(TaskParticipant.user.has(User.name.ilike(like_q))),
            )
        )

    tasks = query.order_by(Task.updated_at.desc()).all()
    return {
        "success": True,
        "count": len(tasks),
        "tasks": [serialize_task(t, db, current_user) for t in tasks],
    }


@router.get("/inbox/unread-count")
async def get_unread_count(
    db: Session = Depends(get_operational_db),
    current_user: User = Depends(get_current_user_from_session),
):
    if not current_user:
        raise HTTPException(status_code=401, detail="Not authenticated")
    return {"success": True, "unreadCount": TaskHelpers.get_unread_count(current_user.id, db)}


@router.get("/users/forward-targets")
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


@router.websocket("/ws/notifications")
async def notifications_ws(websocket: WebSocket):
    session_id = websocket.cookies.get("session_id")
    if not session_id:
        await websocket.close(code=1008)
        return
    try:
        user_id = verify_session_token(session_id)
    except Exception:
        await websocket.close(code=1008)
        return

    await notification_hub.connect(user_id, websocket)
    try:
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        notification_hub.disconnect(user_id, websocket)


@router.post("/{task_id}/actions/assign")
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

    return {
        "success": True,
        "message": "Task assigned",
        "assignedUserIds": added,
        "taskNumber": task.task_number,
        "projectId": task.project_id,
    }


@router.post("/{task_id}/actions/submit")
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
    return {"success": True, "message": "Task submitted for SPOC review"}


@router.post("/{task_id}/actions/start")
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
    return {"success": True, "message": "Task marked as in progress"}


@router.post("/{task_id}/actions/approve")
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
    return {"success": True, "message": "Task approved", "status": task.status.value}


@router.post("/{task_id}/actions/need-improvement")
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
    return {"success": True, "message": "Task marked as Need Improvement"}


@router.post("/{task_id}/actions/forward")
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

    if not payload.to_department and not payload.to_user_id:
        raise HTTPException(status_code=400, detail="to_department or to_user_id required")

    target_users: List[User] = []
    if payload.to_user_id:
        user = db.query(User).filter(User.id == payload.to_user_id, User.is_active == True).first()
        if not user:
            raise HTTPException(status_code=404, detail="Target user not found")
        target_users = [user]
    elif payload.to_department:
        query = db.query(User).filter(User.department == payload.to_department, User.is_active == True)
        if "hod" in roles:
            query = query.filter(User.position.ilike("%hod%"))
        else:
            query = query.filter(or_(User.position.ilike("%hod%"), User.position.ilike("%spoc%")))
        target_users = query.all()

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
        {"toDepartment": payload.to_department, "toUserId": payload.to_user_id},
    )

    db.commit()
    return {"success": True, "message": "Task forwarded", "recipientCount": len(target_users)}


@router.put("/{task_id}/edit-task")
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

    db.commit()
    return {"success": True, "message": "Task updated", "data": serialize_task(task, db, current_user)}


@router.put("/{task_id}/edit-result")
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

    db.commit()
    return {"success": True, "message": "Result updated"}


@router.post("/{task_id}/comments")
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
        },
    }


@router.get("/{task_id}/comments")
async def get_comments(
    task_id: int,
    page: int = Query(1, ge=1),
    page_size: int = Query(25, ge=1, le=100),
    include_history: bool = Query(True),
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

    comments_query = db.query(TaskComment).filter(TaskComment.task_id == task_id).order_by(TaskComment.created_at.asc())
    total_comments = comments_query.count()
    comments = comments_query.offset((page - 1) * page_size).limit(page_size).all()

    response = []
    for c in comments:
        user = db.query(User).filter(User.id == c.user_id).first()
        response.append(
            {
                "id": c.id,
                "taskId": c.task_id,
                "comment": c.comment,
                "commentType": c.comment_type or "general",
                "isInternal": c.is_internal,
                "createdAt": c.created_at.isoformat() if c.created_at else None,
                "user": {
                    "id": user.id if user else None,
                    "name": user.name if user else "Unknown",
                    "role": ", ".join(sorted(role_set(user))) if user else "unknown",
                    "department": user.department if user else None,
                },
            }
        )

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
    if include_history:
        try:
            history_rows = db.query(TaskEditLog).filter(TaskEditLog.task_id == task_id).order_by(TaskEditLog.created_at.desc()).limit(100).all()
        except SQLAlchemyError:
            history_rows = []
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
            for editor in [db.query(User).filter(User.id == h.user_id).first()]
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


@router.get("/notifications/me")
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


@router.post("/notifications/{notification_id}/read")
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


@router.get("/debug/current-user")
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
