from datetime import datetime, timedelta
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Cookie, Header
from pydantic import BaseModel, Field
from sqlalchemy import func
from sqlalchemy.exc import IntegrityError, OperationalError
from sqlalchemy.orm import Session

from auth import get_request_session_token, resolve_session_user
from database_config import get_operational_db
from models_new import ActivityStatus, Task, TaskStatus, User, UserActivity
from utils.datetime_utils import normalize_to_utc_naive, serialize_utc_datetime, utcnow_naive
from utils.permissions import require_admin


router = APIRouter(prefix="/api/activity", tags=["Activity"])


class HeartbeatPayload(BaseModel):
    status: ActivityStatus
    active_seconds: int = Field(ge=0, default=0)
    idle_seconds: int = Field(ge=0, default=0)
    away_seconds: int = Field(ge=0, default=0)
    timestamp: Optional[datetime] = None


class StatusPayload(BaseModel):
    status: ActivityStatus
    timestamp: Optional[datetime] = None


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


def role_set(user: User) -> set[str]:
    roles = set()
    if user and isinstance(user.roles_json, list):
        roles = {str(x).strip().lower() for x in user.roles_json if str(x).strip()}

    position = (user.position or "").lower() if user else ""
    if "hod" in position:
        roles.add("hod")
    if "admin" in position or "super admin" in position:
        roles.add("admin")
    if user and user.is_admin:
        roles.add("admin")
    return roles


def ensure_authenticated(user: Optional[User]) -> User:
    if not user:
        raise HTTPException(status_code=401, detail="Not authenticated")
    return user


def get_today_activity(db: Session, user_id: int) -> Optional[UserActivity]:
    today = utcnow_naive().date()
    return (
        db.query(UserActivity)
        .filter(UserActivity.user_id == user_id, UserActivity.date == today)
        .first()
    )


def get_or_create_today_activity(
    db: Session,
    user: User,
    now: datetime,
    *,
    status: ActivityStatus,
    logout_time: Optional[datetime] = None,
    total_session_duration: Optional[int] = None,
) -> tuple[UserActivity, bool]:
    today = now.date()
    row = (
        db.query(UserActivity)
        .filter(UserActivity.user_id == user.id, UserActivity.date == today)
        .first()
    )
    if row:
        return row, False

    row = UserActivity(
        user_id=user.id,
        date=today,
        login_time=now,
        logout_time=logout_time,
        status=status,
        last_seen=now,
        heartbeat_count=0,
        total_session_duration=total_session_duration or 0,
    )
    db.add(row)
    try:
        db.flush()
        return row, True
    except (IntegrityError, OperationalError):
        # Another concurrent request may have created today's row first.
        db.rollback()
        existing = (
            db.query(UserActivity)
            .filter(UserActivity.user_id == user.id, UserActivity.date == today)
            .first()
        )
        if existing:
            return existing, False
        raise


def serialize_activity(row: UserActivity, user: Optional[User] = None) -> dict:
    return {
        "id": row.id,
        "userId": row.user_id,
        "name": user.name if user else None,
        "email": user.email if user else None,
        "department": user.department if user else None,
        "position": user.position if user else None,
        "date": row.date.isoformat() if row.date else None,
        "loginTime": serialize_utc_datetime(row.login_time),
        "logoutTime": serialize_utc_datetime(row.logout_time),
        "totalSessionDuration": row.total_session_duration or 0,
        "activeTime": row.active_time or 0,
        "idleTime": row.idle_time or 0,
        "awayTime": row.away_time or 0,
        "status": row.status.value if row.status else ActivityStatus.OFFLINE.value,
        "lastSeen": serialize_utc_datetime(row.last_seen),
        "heartbeatCount": row.heartbeat_count or 0,
    }


def compute_productivity(active_time: int, total_time: int) -> float:
    if total_time <= 0:
        return 0.0
    return round((active_time / total_time) * 100.0, 2)


@router.post("/start-session")
async def start_session(
    db: Session = Depends(get_operational_db),
    current_user: User = Depends(get_current_user_from_session),
):
    user = ensure_authenticated(current_user)
    now = utcnow_naive()
    row, created = get_or_create_today_activity(db, user, now, status=ActivityStatus.ACTIVE)

    if not created:
        if not row.login_time:
            row.login_time = now
    row.status = ActivityStatus.ACTIVE
    row.last_seen = now
    row.logout_time = None

    db.commit()
    db.refresh(row)
    return {"success": True, "data": serialize_activity(row, user)}


@router.post("/heartbeat")
async def heartbeat(
    payload: HeartbeatPayload,
    db: Session = Depends(get_operational_db),
    current_user: User = Depends(get_current_user_from_session),
):
    user = ensure_authenticated(current_user)
    now = normalize_to_utc_naive(payload.timestamp) or utcnow_naive()
    row, _ = get_or_create_today_activity(db, user, now, status=payload.status)

    # Soft rate limit: accept at most one persisted heartbeat every 20s.
    # Extra heartbeats are treated as no-op to avoid 429 noise storms.
    last_seen = normalize_to_utc_naive(row.last_seen)
    if last_seen and (now - last_seen).total_seconds() < 20:
        return {
            "success": True,
            "skipped": True,
            "reason": "heartbeat_throttled",
            "data": serialize_activity(row, user),
        }

    row.status = payload.status
    row.last_seen = now
    row.heartbeat_count = (row.heartbeat_count or 0) + 1
    row.active_time = max(payload.active_seconds, row.active_time or 0)
    row.idle_time = max(payload.idle_seconds, row.idle_time or 0)
    row.away_time = max(payload.away_seconds, row.away_time or 0)
    login_time = normalize_to_utc_naive(row.login_time)
    if login_time:
        row.total_session_duration = int((now - login_time).total_seconds())

    db.commit()
    db.refresh(row)
    return {"success": True, "data": serialize_activity(row, user)}


@router.post("/update-status")
async def update_status(
    payload: StatusPayload,
    db: Session = Depends(get_operational_db),
    current_user: User = Depends(get_current_user_from_session),
):
    user = ensure_authenticated(current_user)
    now = normalize_to_utc_naive(payload.timestamp) or utcnow_naive()
    row, _ = get_or_create_today_activity(db, user, now, status=payload.status)
    row.status = payload.status
    row.last_seen = now
    login_time = normalize_to_utc_naive(row.login_time)
    if login_time:
        row.total_session_duration = int((now - login_time).total_seconds())

    db.commit()
    db.refresh(row)
    return {"success": True, "data": serialize_activity(row, user)}


@router.post("/end-session")
async def end_session(
    payload: Optional[StatusPayload] = None,
    db: Session = Depends(get_operational_db),
    current_user: User = Depends(get_current_user_from_session),
):
    user = ensure_authenticated(current_user)
    now = normalize_to_utc_naive(payload.timestamp) if payload and payload.timestamp else utcnow_naive()
    row, _ = get_or_create_today_activity(
        db,
        user,
        now,
        status=ActivityStatus.OFFLINE,
        logout_time=now,
        total_session_duration=0,
    )
    row.status = ActivityStatus.OFFLINE
    row.logout_time = now
    row.last_seen = now
    login_time = normalize_to_utc_naive(row.login_time)
    if login_time:
        row.total_session_duration = int((now - login_time).total_seconds())

    db.commit()
    db.refresh(row)
    return {"success": True, "data": serialize_activity(row, user)}


@router.get("/my-activity")
async def my_activity(
    db: Session = Depends(get_operational_db),
    current_user: User = Depends(get_current_user_from_session),
):
    user = ensure_authenticated(current_user)
    row = get_today_activity(db, user.id)
    if not row:
        return {"success": True, "data": None}
    return {"success": True, "data": serialize_activity(row, user)}


@router.get("/department")
async def department_activity(
    db: Session = Depends(get_operational_db),
    current_user: User = Depends(get_current_user_from_session),
):
    user = ensure_authenticated(current_user)
    roles = role_set(user)
    if "hod" not in roles and "admin" not in roles:
        raise HTTPException(status_code=403, detail="Only HOD/Admin can view department activity")

    today = utcnow_naive().date()
    today_start = datetime.combine(today, datetime.min.time())
    today_end = datetime.combine(today + timedelta(days=1), datetime.min.time())
    users = db.query(User).filter(User.is_active == True, User.department == user.department).all()
    user_ids = [u.id for u in users]

    rows = (
        db.query(UserActivity)
        .filter(UserActivity.date == today, UserActivity.user_id.in_(user_ids))
        .all()
        if user_ids
        else []
    )
    row_by_user = {r.user_id: r for r in rows}

    active_member_ids = [member_id for member_id in user_ids if member_id in row_by_user]
    task_counts = {}
    if active_member_ids:
        task_counts = {
            submitted_by: count
            for submitted_by, count in (
                db.query(Task.submitted_by, func.count(Task.id))
                .filter(
                    Task.submitted_by.in_(active_member_ids),
                    Task.updated_at >= today_start,
                    Task.updated_at < today_end,
                )
                .group_by(Task.submitted_by)
                .all()
            )
        }

    data = []
    for member in users:
        row = row_by_user.get(member.id)
        if not row:
            data.append(
                {
                    "id": None,
                    "userId": member.id,
                    "name": member.name,
                    "email": member.email,
                    "department": member.department,
                    "position": member.position,
                    "status": ActivityStatus.OFFLINE.value,
                    "productivity": 0.0,
                }
            )
            continue

        item = serialize_activity(row, member)
        item["productivity"] = compute_productivity(item["activeTime"], item["totalSessionDuration"])
        # Use submitted_by as practical "tasks done today" metric.
        item["tasksDone"] = task_counts.get(member.id, 0)
        data.append(item)

    return {"success": True, "count": len(data), "data": data}


@router.get("/all-users")
async def all_users_activity(
    db: Session = Depends(get_operational_db),
    current_user: User = Depends(require_admin),
):
    user = ensure_authenticated(current_user)

    today = utcnow_naive().date()
    users = db.query(User).filter(User.is_active == True).all()
    rows = db.query(UserActivity).filter(UserActivity.date == today).all()
    row_by_user = {r.user_id: r for r in rows}

    data = []
    for member in users:
        row = row_by_user.get(member.id)
        if row:
            item = serialize_activity(row, member)
            item["productivity"] = compute_productivity(item["activeTime"], item["totalSessionDuration"])
            data.append(item)
        else:
            data.append(
                {
                    "id": None,
                    "userId": member.id,
                    "name": member.name,
                    "email": member.email,
                    "department": member.department,
                    "position": member.position,
                    "status": ActivityStatus.OFFLINE.value,
                    "productivity": 0.0,
                    "heartbeatCount": 0,
                }
            )
    return {"success": True, "count": len(data), "data": data}


@router.get("/live-stats")
async def live_stats(
    db: Session = Depends(get_operational_db),
    current_user: User = Depends(require_admin),
):
    user = ensure_authenticated(current_user)

    today = utcnow_naive().date()
    total_users = db.query(func.count(User.id)).filter(User.is_active == True).scalar() or 0
    rows = db.query(UserActivity).filter(UserActivity.date == today).all()

    active = 0
    idle = 0
    away = 0
    offline = 0

    # Users with no activity today are offline
    users_with_rows = {r.user_id for r in rows}
    offline += max(total_users - len(users_with_rows), 0)

    stale_cutoff = utcnow_naive() - timedelta(seconds=90)
    for row in rows:
        last_seen = normalize_to_utc_naive(row.last_seen)
        if row.status == ActivityStatus.ACTIVE and last_seen and last_seen >= stale_cutoff:
            active += 1
        elif row.status == ActivityStatus.IDLE:
            idle += 1
        elif row.status == ActivityStatus.AWAY:
            away += 1
        else:
            offline += 1

    return {
        "success": True,
        "data": {
            "active": active,
            "idle": idle,
            "away": away,
            "offline": offline,
            "totalUsers": total_users,
            "timestamp": serialize_utc_datetime(utcnow_naive()),
        },
    }
