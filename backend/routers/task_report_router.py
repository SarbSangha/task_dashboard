"""Task Report (Analytics -> Task Report).

Who assigned what to whom, where it stands, and whether it met its deadline:
a filterable task listing with KPIs, a per-task detail view (participants,
status timeline, comments, workflow stages) and an Excel workbook built from
the same filters.

One filter set (TaskReportFilters) drives the listing, the option counts and
the export, so the screen and the workbook always agree. The older
/api/reports/tasks/detail endpoints in reports_router.py are left as they
were for anything still calling them.
"""

from __future__ import annotations

import io
from collections import Counter, defaultdict
from datetime import date, datetime, time, timedelta, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import Response
from sqlalchemy import and_, case, func, or_, select
from sqlalchemy.orm import Session

from database_config import get_operational_db
from models_new import (
    ParticipantRole,
    Priority,
    Task,
    TaskComment,
    TaskParticipant,
    TaskStage,
    TaskStatus,
    TaskStatusHistory,
    User,
)
from utils.datetime_utils import serialize_utc_datetime
from utils.permissions import require_admin

router = APIRouter(prefix="/api/reports/task-report", tags=["Task Report"])

IST = timezone(timedelta(hours=5, minutes=30))
DONE = (TaskStatus.COMPLETED, TaskStatus.APPROVED)
CLOSED = (TaskStatus.CANCELLED, TaskStatus.REJECTED)
NOT_OPEN = DONE + CLOSED
STATUS_LABELS = {
    "pending": "Pending", "forwarded": "Forwarded", "assigned": "Assigned", "in_progress": "In progress",
    "submitted": "Submitted", "under_review": "Under review", "need_improvement": "Needs improvement",
    "approved": "Approved", "rejected": "Rejected", "completed": "Completed", "cancelled": "Cancelled",
}
STATUS_ORDER = list(STATUS_LABELS)
DEADLINE_STATES = {
    "overdue": "Overdue (open, past deadline)",
    "due_soon": "Due in the next 7 days",
    "on_track": "Open, deadline ahead",
    "met": "Finished on time",
    "missed": "Finished late",
    "no_deadline": "No deadline",
}
DATE_FIELDS = {"created": "Created", "deadline": "Deadline", "completed": "Completed", "updated": "Last updated"}
SORTS = {"newest", "oldest", "deadline", "priority", "updated", "status"}
EXPORT_CAP = 50_000


# ── Expressions ──────────────────────────────────────────────────────────────

def completed_at_expr():
    """Completion time, falling back to the status-history row that moved the
    task to completed (Task.completed_at is often unset on older rows)."""
    hist = (
        select(func.min(TaskStatusHistory.timestamp))
        .where(TaskStatusHistory.task_id == Task.id, func.lower(TaskStatusHistory.status_to) == "completed")
        .correlate(Task)
        .scalar_subquery()
    )
    return func.coalesce(Task.completed_at, hist)


def _now():
    return datetime.now(timezone.utc)


def deadline_state_expr():
    done_at = completed_at_expr()
    now = _now()
    return case(
        (Task.deadline.is_(None), "no_deadline"),
        (and_(Task.status.in_(DONE), done_at.isnot(None), done_at <= Task.deadline), "met"),
        (Task.status.in_(DONE), "missed"),
        (Task.status.in_(CLOSED), "closed"),
        (Task.deadline < now, "overdue"),
        (Task.deadline < now + timedelta(days=7), "due_soon"),
        else_="on_track",
    )


def _assignee_ids_subquery(user_id: int):
    return select(TaskParticipant.task_id).where(
        TaskParticipant.user_id == user_id,
        TaskParticipant.role == ParticipantRole.ASSIGNEE,
        TaskParticipant.is_active.is_(True),
    )


def _any_assignee_subquery():
    return select(TaskParticipant.task_id).where(
        TaskParticipant.role == ParticipantRole.ASSIGNEE, TaskParticipant.is_active.is_(True),
    )


def _ist_bounds(start: Optional[date], end: Optional[date]):
    low = datetime.combine(start, time.min, tzinfo=IST) if start else None
    high = datetime.combine(end + timedelta(days=1), time.min, tzinfo=IST) if end else None
    return low, high


# ── Filters ──────────────────────────────────────────────────────────────────

def _csv(value: Optional[str]) -> list[str]:
    return [part.strip() for part in (value or "").split(",") if part.strip()]


class TaskReportFilters:
    def __init__(
        self,
        start: Optional[date] = Query(None),
        end: Optional[date] = Query(None),
        date_field: str = Query("created"),
        q: Optional[str] = Query(None, max_length=200),
        status: Optional[str] = Query(None, description="One status or several, comma-separated"),
        priority: Optional[str] = Query(None),
        category: Optional[str] = Query(None),
        project: Optional[str] = Query(None),
        to_department: Optional[str] = Query(None),
        from_department: Optional[str] = Query(None),
        creator_id: Optional[int] = Query(None),
        assignee_id: Optional[str] = Query(None, description="User id, or 'none' for unassigned"),
        deadline_state: Optional[str] = Query(None),
        has_result: Optional[str] = Query(None, pattern="^(yes|no)$"),
        stage: Optional[str] = Query(None, pattern="^(open|done|closed)$"),
    ):
        if start and end and start > end:
            raise HTTPException(status_code=400, detail="The start date is after the end date.")
        if date_field not in DATE_FIELDS:
            raise HTTPException(status_code=400, detail=f"date_field must be one of {list(DATE_FIELDS)}")
        statuses = _csv(status)
        for value in statuses:
            if value not in STATUS_LABELS:
                raise HTTPException(status_code=400, detail=f"Unknown status: {value}")
        if priority and priority not in {p.value for p in Priority}:
            raise HTTPException(status_code=400, detail="Unknown priority")
        if deadline_state and deadline_state not in DEADLINE_STATES:
            raise HTTPException(status_code=400, detail=f"deadline_state must be one of {list(DEADLINE_STATES)}")
        self.start, self.end, self.date_field = start, end, date_field
        self.q = (q or "").strip() or None
        self.statuses = statuses
        self.priority, self.category, self.project = priority or None, category or None, project or None
        self.to_department, self.from_department = to_department or None, from_department or None
        self.creator_id = creator_id
        self.unassigned = assignee_id == "none"
        try:
            self.assignee_id = int(assignee_id) if assignee_id and assignee_id != "none" else None
        except ValueError:
            raise HTTPException(status_code=400, detail="assignee_id must be a user id or 'none'")
        self.deadline_state, self.has_result, self.stage = deadline_state or None, has_result, stage

    def describe(self, db: Session) -> list[str]:
        fmt = "%d %b %Y"
        out = []
        if self.start or self.end:
            out.append(f"{DATE_FIELDS[self.date_field]}: {self.start.strftime(fmt) if self.start else 'start'} – "
                       f"{self.end.strftime(fmt) if self.end else 'today'}")
        names = lambda uid: db.query(User.name).filter(User.id == uid).scalar() or f"User {uid}"
        if self.to_department:
            out.append(f"Department: {self.to_department}")
        if self.from_department:
            out.append(f"From department: {self.from_department}")
        if self.creator_id:
            out.append(f"Assigned by: {names(self.creator_id)}")
        if self.unassigned:
            out.append("Assignee: nobody")
        elif self.assignee_id:
            out.append(f"Assignee: {names(self.assignee_id)}")
        if self.stage:
            out.append({"open": "Open tasks", "done": "Finished tasks", "closed": "Cancelled / rejected"}[self.stage])
        if self.statuses:
            out.append("Status: " + ", ".join(STATUS_LABELS[s] for s in self.statuses))
        if self.priority:
            out.append(f"Priority: {self.priority.title()}")
        if self.category:
            out.append(f"Category: {self.category}")
        if self.project:
            out.append(f"Project: {self.project}")
        if self.deadline_state:
            out.append(DEADLINE_STATES[self.deadline_state])
        if self.has_result:
            out.append("Has a written result" if self.has_result == "yes" else "No written result")
        if self.q:
            out.append(f'Search: "{self.q}"')
        return out


def apply_filters(query, f: TaskReportFilters, *, skip: tuple = ()):
    query = query.filter(Task.is_deleted.is_(False), Task.status != TaskStatus.DRAFT)
    low, high = _ist_bounds(f.start, f.end)
    if "date" not in skip and (low or high):
        column = {
            "created": Task.created_at, "deadline": Task.deadline,
            "completed": completed_at_expr(), "updated": Task.updated_at,
        }[f.date_field]
        if low:
            query = query.filter(column >= low)
        if high:
            query = query.filter(column < high)
    if f.stage and "stage" not in skip:
        if f.stage == "open":
            query = query.filter(Task.status.notin_(NOT_OPEN))
        else:
            query = query.filter(Task.status.in_(DONE if f.stage == "done" else CLOSED))
    if f.statuses and "status" not in skip:
        query = query.filter(Task.status.in_([TaskStatus(s) for s in f.statuses]))
    if f.priority and "priority" not in skip:
        query = query.filter(Task.priority == Priority(f.priority))
    if f.category and "category" not in skip:
        query = query.filter(Task.task_tag == f.category)
    if f.project and "project" not in skip:
        query = query.filter(Task.project_name == f.project)
    if f.to_department and "to_department" not in skip:
        query = query.filter(Task.to_department == f.to_department)
    if f.from_department and "from_department" not in skip:
        query = query.filter(Task.from_department == f.from_department)
    if f.creator_id and "creator" not in skip:
        query = query.filter(Task.creator_id == f.creator_id)
    if "assignee" not in skip:
        if f.unassigned:
            query = query.filter(Task.id.notin_(_any_assignee_subquery()))
        elif f.assignee_id:
            query = query.filter(Task.id.in_(_assignee_ids_subquery(f.assignee_id)))
    if f.deadline_state and "deadline" not in skip:
        query = query.filter(deadline_state_expr() == f.deadline_state)
    if f.has_result and "result" not in skip:
        has = and_(Task.result_text.isnot(None), func.trim(Task.result_text) != "")
        query = query.filter(has if f.has_result == "yes" else ~has)
    if f.q and "q" not in skip:
        like = f"%{f.q}%"
        query = query.filter(or_(
            Task.title.ilike(like), Task.task_number.ilike(like), Task.project_name.ilike(like),
            Task.description.ilike(like), Task.task_tag.ilike(like),
        ))
    return query


def _order(query, sort: str):
    if sort == "oldest":
        return query.order_by(Task.created_at.asc(), Task.id.asc())
    if sort == "deadline":
        return query.order_by(Task.deadline.asc().nullslast(), Task.created_at.desc())
    if sort == "priority":
        rank = case((Task.priority == Priority.HIGH, 0), (Task.priority == Priority.MEDIUM, 1), else_=2)
        return query.order_by(rank, Task.created_at.desc())
    if sort == "updated":
        return query.order_by(Task.updated_at.desc().nullslast(), Task.id.desc())
    if sort == "status":
        rank = case(*[(Task.status == TaskStatus(s), i) for i, s in enumerate(STATUS_ORDER)], else_=99)
        return query.order_by(rank, Task.created_at.desc())
    return query.order_by(Task.created_at.desc(), Task.id.desc())


# ── Row building ─────────────────────────────────────────────────────────────

def _people_for(db: Session, tasks: list) -> tuple[dict, dict]:
    """({user_id: {id,name,department}}, {task_id: {role: [user_id]}})."""
    ids = [t.id for t in tasks]
    roles_by_task: dict = defaultdict(lambda: defaultdict(list))
    user_ids = {t.creator_id for t in tasks if t.creator_id}
    if ids:
        for task_id, user_id, role in (
            db.query(TaskParticipant.task_id, TaskParticipant.user_id, TaskParticipant.role)
            .filter(TaskParticipant.task_id.in_(ids), TaskParticipant.is_active.is_(True),
                    TaskParticipant.role.in_([ParticipantRole.ASSIGNEE, ParticipantRole.APPROVER, ParticipantRole.HOD,
                                              ParticipantRole.REVIEWER]))
            .all()
        ):
            if user_id not in roles_by_task[task_id][role.value]:
                roles_by_task[task_id][role.value].append(user_id)
            user_ids.add(user_id)
    users = {}
    if user_ids:
        for uid, name, email, dept in db.query(User.id, User.name, User.email, User.department).filter(User.id.in_(user_ids)).all():
            users[uid] = {"id": uid, "name": name or email or f"User {uid}", "department": dept}
    return users, roles_by_task


def _extras_for(db: Session, tasks: list) -> tuple[dict, dict, dict]:
    ids = [t.id for t in tasks]
    if not ids:
        return {}, {}, {}
    completed = dict(db.query(Task.id, completed_at_expr()).filter(Task.id.in_(ids)).all())
    comments = dict(db.query(TaskComment.task_id, func.count(TaskComment.id))
                    .filter(TaskComment.task_id.in_(ids)).group_by(TaskComment.task_id).all())
    last_activity = dict(db.query(TaskStatusHistory.task_id, func.max(TaskStatusHistory.timestamp))
                         .filter(TaskStatusHistory.task_id.in_(ids)).group_by(TaskStatusHistory.task_id).all())
    return completed, comments, last_activity


def _deadline_state(task: Task, done_at) -> str:
    if not task.deadline:
        return "no_deadline"
    deadline = task.deadline if task.deadline.tzinfo else task.deadline.replace(tzinfo=timezone.utc)
    if task.status in DONE:
        if done_at is None:
            return "missed"
        done = done_at if done_at.tzinfo else done_at.replace(tzinfo=timezone.utc)
        return "met" if done <= deadline else "missed"
    if task.status in CLOSED:
        return "closed"
    now = _now()
    if deadline < now:
        return "overdue"
    return "due_soon" if deadline < now + timedelta(days=7) else "on_track"


def _days_between(a, b) -> Optional[float]:
    if not a or not b:
        return None
    a = a if a.tzinfo else a.replace(tzinfo=timezone.utc)
    b = b if b.tzinfo else b.replace(tzinfo=timezone.utc)
    return round((b - a).total_seconds() / 86400, 1)


def _task_rows(db: Session, tasks: list) -> list[dict]:
    users, roles = _people_for(db, tasks)
    completed, comments, last_activity = _extras_for(db, tasks)
    rows = []
    for t in tasks:
        done_at = completed.get(t.id)
        role_map = roles.get(t.id, {})
        state = _deadline_state(t, done_at)
        end_point = done_at if t.status in DONE else (_now() if t.status not in CLOSED else None)
        rows.append({
            "id": t.id,
            "taskNumber": t.task_number,
            "title": t.title,
            "projectName": t.project_name,
            "category": t.task_tag,
            "fromDepartment": t.from_department,
            "toDepartment": t.to_department,
            "priority": t.priority.value if t.priority else None,
            "status": t.status.value if t.status else None,
            "statusLabel": STATUS_LABELS.get(t.status.value, t.status.value) if t.status else None,
            "stageTitle": t.current_stage_title if t.workflow_enabled else None,
            "assignedBy": users.get(t.creator_id),
            "assignees": [users[u] for u in role_map.get("assignee", []) if u in users],
            "approvers": [users[u] for u in role_map.get("approver", []) if u in users],
            "hods": [users[u] for u in role_map.get("hod", []) if u in users],
            "createdAt": serialize_utc_datetime(t.created_at),
            "deadline": serialize_utc_datetime(t.deadline),
            "completedAt": serialize_utc_datetime(done_at) if t.status in DONE else None,
            "updatedAt": serialize_utc_datetime(last_activity.get(t.id) or t.updated_at),
            "deadlineState": state,
            "ageDays": _days_between(t.created_at, end_point),
            "hasResult": bool((t.result_text or "").strip()),
            "commentCount": int(comments.get(t.id, 0)),
        })
    return rows


def _kpis(query) -> dict:
    done_at = completed_at_expr()
    flag = lambda cond: func.sum(case((cond, 1), else_=0))
    total, open_n, done_n, closed_n, overdue, with_deadline_done, met = query.with_entities(
        func.count(Task.id),
        flag(Task.status.notin_(NOT_OPEN)),
        flag(Task.status.in_(DONE)),
        flag(Task.status.in_(CLOSED)),
        flag(and_(Task.status.notin_(NOT_OPEN), Task.deadline.isnot(None), Task.deadline < _now())),
        flag(and_(Task.status.in_(DONE), Task.deadline.isnot(None))),
        flag(and_(Task.status.in_(DONE), Task.deadline.isnot(None), done_at.isnot(None), done_at <= Task.deadline)),
    ).one()
    avg_days = query.filter(Task.status.in_(DONE)).with_entities(
        func.avg(func.extract("epoch", done_at - Task.created_at) / 86400.0)
    ).scalar()
    return {
        "total": int(total or 0), "open": int(open_n or 0), "done": int(done_n or 0), "closed": int(closed_n or 0),
        "overdue": int(overdue or 0),
        "onTimeRate": round(100.0 * int(met or 0) / int(with_deadline_done), 1) if with_deadline_done else None,
        "avgDaysToComplete": round(float(avg_days), 1) if avg_days is not None else None,
    }


# ── Endpoints ────────────────────────────────────────────────────────────────

@router.get("/tasks")
def task_report_tasks(
    filters: TaskReportFilters = Depends(),
    sort: str = Query("newest"),
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
    db: Session = Depends(get_operational_db),
    current_user: User = Depends(require_admin),
):
    if sort not in SORTS:
        raise HTTPException(status_code=400, detail=f"sort must be one of {sorted(SORTS)}")
    query = apply_filters(db.query(Task), filters)
    tasks = _order(query, sort).offset(offset).limit(limit + 1).all()
    has_more = len(tasks) > limit
    tasks = tasks[:limit]
    payload = {"success": True, "tasks": _task_rows(db, tasks), "hasMore": has_more,
               "nextOffset": offset + limit if has_more else None}
    if offset == 0:
        payload["kpis"] = _kpis(query)
        # Status mix for the bar, ignoring the status filter itself so every
        # segment stays clickable.
        mix = apply_filters(db.query(Task), filters, skip=("status", "stage"))
        payload["statusCounts"] = {
            status.value: int(n)
            for status, n in mix.with_entities(Task.status, func.count(Task.id)).group_by(Task.status).all()
        }
    return payload


@router.get("/options")
def task_report_options(
    db: Session = Depends(get_operational_db),
    current_user: User = Depends(require_admin),
):
    """Every filter value that occurs in the data, with task counts."""
    base = db.query(Task).filter(Task.is_deleted.is_(False), Task.status != TaskStatus.DRAFT)

    def counts(column):
        return [
            {"value": value, "label": value, "count": int(n)}
            for value, n in base.with_entities(column, func.count(Task.id))
            .filter(column.isnot(None), column != "").group_by(column).order_by(func.count(Task.id).desc()).all()
        ]

    creators = [
        {"value": str(uid), "label": name or email or f"User {uid}", "count": int(n)}
        for uid, name, email, n in base.join(User, Task.creator_id == User.id)
        .with_entities(User.id, User.name, User.email, func.count(Task.id))
        .group_by(User.id, User.name, User.email).order_by(func.count(Task.id).desc()).all()
    ]
    assignees = [
        {"value": str(uid), "label": name or email or f"User {uid}", "count": int(n)}
        for uid, name, email, n in base.join(TaskParticipant, TaskParticipant.task_id == Task.id)
        .join(User, TaskParticipant.user_id == User.id)
        .filter(TaskParticipant.role == ParticipantRole.ASSIGNEE, TaskParticipant.is_active.is_(True))
        .with_entities(User.id, User.name, User.email, func.count(func.distinct(Task.id)))
        .group_by(User.id, User.name, User.email).order_by(func.count(func.distinct(Task.id)).desc()).all()
    ]
    unassigned = base.filter(Task.id.notin_(_any_assignee_subquery())).count()
    if unassigned:
        assignees.append({"value": "none", "label": "Nobody yet", "count": unassigned})
    statuses = dict(base.with_entities(Task.status, func.count(Task.id)).group_by(Task.status).all())
    priorities = dict(base.with_entities(Task.priority, func.count(Task.id)).group_by(Task.priority).all())
    state = deadline_state_expr()
    deadline_counts = dict(base.with_entities(state, func.count(Task.id)).group_by(state).all())
    low, high = base.with_entities(func.min(Task.created_at), func.max(Task.created_at)).one()
    to_ist = lambda v: v.astimezone(IST).date().isoformat() if v else None
    return {
        "success": True,
        "statuses": [{"value": s, "label": STATUS_LABELS[s], "count": int(statuses.get(TaskStatus(s), 0))}
                     for s in STATUS_ORDER if statuses.get(TaskStatus(s))],
        "priorities": [{"value": p.value, "label": p.value.title(), "count": int(priorities.get(p, 0))}
                       for p in (Priority.HIGH, Priority.MEDIUM, Priority.LOW) if priorities.get(p)],
        "categories": counts(Task.task_tag),
        "projects": counts(Task.project_name),
        "toDepartments": counts(Task.to_department),
        "fromDepartments": counts(Task.from_department),
        "creators": creators,
        "assignees": assignees,
        "deadlineStates": [{"value": k, "label": label, "count": int(deadline_counts.get(k, 0))}
                           for k, label in DEADLINE_STATES.items() if deadline_counts.get(k)],
        "dateFields": [{"value": k, "label": v} for k, v in DATE_FIELDS.items()],
        "dateRange": {"from": to_ist(low), "to": to_ist(high)},
    }


@router.get("/tasks/{task_id}")
def task_report_detail(
    task_id: int,
    db: Session = Depends(get_operational_db),
    current_user: User = Depends(require_admin),
):
    """Everything recorded about one task, for the report's detail drawer."""
    task = db.query(Task).filter(Task.id == task_id, Task.is_deleted.is_(False)).first()
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")
    row = _task_rows(db, [task])[0]
    history = (
        db.query(TaskStatusHistory, User.name)
        .outerjoin(User, TaskStatusHistory.user_id == User.id)
        .filter(TaskStatusHistory.task_id == task_id)
        .order_by(TaskStatusHistory.timestamp.asc(), TaskStatusHistory.id.asc())
        .all()
    )
    comments = (
        db.query(TaskComment, User.name)
        .outerjoin(User, TaskComment.user_id == User.id)
        .filter(TaskComment.task_id == task_id)
        .order_by(TaskComment.created_at.desc())
        .limit(50)
        .all()
    )
    stages = (
        db.query(TaskStage).filter(TaskStage.task_id == task_id).order_by(TaskStage.stage_order.asc()).all()
        if task.workflow_enabled else []
    )
    return {
        "success": True,
        "task": {
            **row,
            "description": task.description,
            "resultText": task.result_text,
            "workflowEnabled": bool(task.workflow_enabled),
            "startedAt": serialize_utc_datetime(task.started_at),
            "submittedAt": serialize_utc_datetime(task.submitted_at),
        },
        "history": [
            {
                "from": h.status_from, "to": h.status_to,
                "fromLabel": STATUS_LABELS.get((h.status_from or "").lower(), h.status_from),
                "toLabel": STATUS_LABELS.get((h.status_to or "").lower(), h.status_to),
                "action": h.action, "comments": h.comments, "by": name, "at": serialize_utc_datetime(h.timestamp),
            }
            for h, name in history
        ],
        "comments": [
            {"id": c.id, "text": c.comment, "type": c.comment_type, "internal": bool(c.is_internal),
             "by": name, "at": serialize_utc_datetime(c.created_at)}
            for c, name in comments
        ],
        "stages": [
            {"order": s.stage_order, "title": s.title, "status": getattr(s.status, "value", s.status),
             "final": bool(s.is_final_stage), "completedAt": serialize_utc_datetime(s.completed_at)}
            for s in stages
        ],
    }


@router.get("/export.xlsx")
def task_report_export(
    filters: TaskReportFilters = Depends(),
    sort: str = Query("newest"),
    include_history: bool = Query(True),
    db: Session = Depends(get_operational_db),
    current_user: User = Depends(require_admin),
):
    """Workbook: Summary (filters, KPIs, breakdowns), Tasks (one row per task)
    and, optionally, Status history (every status change)."""
    from openpyxl import Workbook
    from openpyxl.styles import Alignment, Font, PatternFill
    from routers.rmw_data_export_router import TITLE_FONT, _style_header, _write_table

    if sort not in SORTS:
        sort = "newest"
    query = apply_filters(db.query(Task), filters)
    tasks = _order(query, sort).limit(EXPORT_CAP).all()
    rows = _task_rows(db, tasks)
    kpis = _kpis(query)
    by_id = {t.id: t for t in tasks}

    def ist_naive(iso):
        if not iso:
            return None
        value = datetime.fromisoformat(iso.replace("Z", "+00:00"))
        return value.astimezone(IST).replace(tzinfo=None)

    wb = Workbook()
    ws = wb.active
    ws.title = "Summary"
    ws["A1"] = "Task Report"
    ws["A1"].font = TITLE_FONT
    meta = [
        ("Generated", datetime.now(IST).strftime("%d %b %Y, %I:%M %p IST")),
        ("Generated by", f"{current_user.name} ({current_user.email})"),
        ("Filters", "; ".join(filters.describe(db)) or "None (every task)"),
    ]
    for offset, (label, value) in enumerate(meta, start=3):
        ws.cell(row=offset, column=1, value=label).font = Font(bold=True)
        ws.cell(row=offset, column=2, value=value).alignment = Alignment(wrap_text=True, vertical="top")
    row_no = _write_table(ws, 4 + len(meta), "Key figures", ["Measure", "Value"], [
        ["Tasks", kpis["total"]], ["Open", kpis["open"]], ["Finished (completed/approved)", kpis["done"]],
        ["Cancelled / rejected", kpis["closed"]], ["Overdue (open, past deadline)", kpis["overdue"]],
        ["On-time rate (finished with a deadline)", f"{kpis['onTimeRate']}%" if kpis["onTimeRate"] is not None else "—"],
        ["Average days to finish", kpis["avgDaysToComplete"] if kpis["avgDaysToComplete"] is not None else "—"],
    ])

    def breakdown(title, keys_fn, extra=True):
        nonlocal row_no
        stats = defaultdict(lambda: [0, 0, 0, 0])  # tasks, open, done, overdue
        for r in rows:
            for key in keys_fn(r):
                s = stats[key]
                s[0] += 1
                s[1] += r["status"] not in ("completed", "approved", "cancelled", "rejected")
                s[2] += r["status"] in ("completed", "approved")
                s[3] += r["deadlineState"] == "overdue"
        ordered = sorted(stats.items(), key=lambda kv: (-kv[1][0], str(kv[0])))[:40]
        row_no = _write_table(ws, row_no, title, [title.split("By ")[-1].capitalize(), "Tasks", "Open", "Finished", "Overdue"],
                              [[k, *v] for k, v in ordered])

    breakdown("By status", lambda r: [r["statusLabel"] or "Unknown"])
    breakdown("By assignee", lambda r: [a["name"] for a in r["assignees"]] or ["Nobody yet"])
    breakdown("By assigned by", lambda r: [(r["assignedBy"] or {}).get("name") or "Unknown"])
    breakdown("By department", lambda r: [r["toDepartment"] or "None"])
    breakdown("By category", lambda r: [r["category"] or "None"])
    breakdown("By project", lambda r: [r["projectName"] or "None"])
    breakdown("By month created", lambda r: [ist_naive(r["createdAt"]).strftime("%Y-%m (%b)") if r["createdAt"] else "Unknown"])
    for letter, width in zip("ABCDE", (34, 60, 10, 10, 10)):
        ws.column_dimensions[letter].width = width

    sheet = wb.create_sheet("Tasks")
    headers = ["Task #", "Title", "Project", "Category", "Priority", "Status", "Workflow stage", "Assigned by",
               "Assignees", "HOD / approvers", "From dept", "To dept", "Created (IST)", "Deadline (IST)",
               "Completed (IST)", "Deadline status", "Days open / to finish", "Comments", "Result", "Description",
               "Last activity (IST)"]
    widths = [22, 40, 22, 16, 10, 16, 18, 20, 28, 24, 16, 16, 18, 18, 18, 22, 12, 10, 40, 50, 18]
    sheet.append(headers)
    _style_header(sheet, 1, len(headers))
    state_labels = {**DEADLINE_STATES, "closed": "Closed"}
    late_fill = PatternFill("solid", fgColor="FDE2E1")
    for r in rows:
        task = by_id[r["id"]]
        sheet.append([
            r["taskNumber"], r["title"], r["projectName"], r["category"], (r["priority"] or "").title(), r["statusLabel"],
            r["stageTitle"], (r["assignedBy"] or {}).get("name"), ", ".join(a["name"] for a in r["assignees"]) or "Nobody yet",
            ", ".join(p["name"] for p in r["hods"] + r["approvers"]), r["fromDepartment"], r["toDepartment"],
            ist_naive(r["createdAt"]), ist_naive(r["deadline"]), ist_naive(r["completedAt"]),
            state_labels.get(r["deadlineState"], r["deadlineState"]), r["ageDays"], r["commentCount"],
            (task.result_text or "")[:32000], (task.description or "")[:32000], ist_naive(r["updatedAt"]),
        ])
        if r["deadlineState"] in ("overdue", "missed"):
            sheet.cell(row=sheet.max_row, column=16).fill = late_fill
    for index, width in enumerate(widths, start=1):
        sheet.column_dimensions[sheet.cell(row=1, column=index).column_letter].width = width
    for col in ("M", "N", "O", "U"):
        for cell in sheet[col][1:]:
            cell.number_format = "dd mmm yyyy, hh:mm"
    for col in ("B", "S", "T"):
        for cell in sheet[col][1:]:
            cell.alignment = Alignment(wrap_text=True, vertical="top")
    sheet.freeze_panes = "C2"
    if rows:
        sheet.auto_filter.ref = f"A1:U{len(rows) + 1}"

    if include_history and tasks:
        hist = wb.create_sheet("Status history")
        hist.append(["Task #", "Title", "When (IST)", "From", "To", "Action", "By", "Comment"])
        _style_header(hist, 1, 8)
        ids = [t.id for t in tasks]
        for chunk_start in range(0, len(ids), 1000):
            chunk = ids[chunk_start:chunk_start + 1000]
            for h, name in (
                db.query(TaskStatusHistory, User.name).outerjoin(User, TaskStatusHistory.user_id == User.id)
                .filter(TaskStatusHistory.task_id.in_(chunk))
                .order_by(TaskStatusHistory.task_id.asc(), TaskStatusHistory.timestamp.asc()).all()
            ):
                task = by_id.get(h.task_id)
                when = h.timestamp.astimezone(IST).replace(tzinfo=None) if h.timestamp and h.timestamp.tzinfo else h.timestamp
                hist.append([
                    task.task_number if task else h.task_id, task.title if task else None, when,
                    STATUS_LABELS.get((h.status_from or "").lower(), h.status_from),
                    STATUS_LABELS.get((h.status_to or "").lower(), h.status_to), h.action, name, h.comments,
                ])
        for index, width in enumerate((22, 40, 18, 16, 16, 18, 20, 50), start=1):
            hist.column_dimensions[hist.cell(row=1, column=index).column_letter].width = width
        for cell in hist["C"][1:]:
            cell.number_format = "dd mmm yyyy, hh:mm"
        hist.freeze_panes = "C2"
        hist.auto_filter.ref = f"A1:H{hist.max_row}"

    buffer = io.BytesIO()
    wb.save(buffer)
    stamp = datetime.now(IST).strftime("%Y-%m-%d")
    return Response(
        content=buffer.getvalue(),
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": f'attachment; filename="task-report_{stamp}.xlsx"', "Cache-Control": "no-store"},
    )
