from datetime import datetime
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import func
from sqlalchemy.exc import IntegrityError, SQLAlchemyError
from sqlalchemy.orm import Session

from database_config import get_operational_db
from models_new import DepartmentDirectory, User, UserApprovalRequest
from auth import get_password_hash, revoke_user_sessions
from services.admin_workflow_service import (
    pending_password_change_for_request,
    push_admin_realtime_event,
    sanitize_request_payload,
)
from services.role_service import user_role_names
from utils.cache import invalidate_pattern
from utils.datetime_utils import serialize_utc_datetime
from utils.permissions import has_any_role, require_admin


router = APIRouter(prefix="/api/admin", tags=["Admin"])
AUTH_DEPARTMENTS_CACHE_PATTERN = "cache:auth_departments:*"


class RejectPayload(BaseModel):
    reason: str = Field(..., min_length=2)


class ReviewPayload(BaseModel):
    approve: bool = True
    notes: Optional[str] = None


class DeleteUserPayload(BaseModel):
    reason: Optional[str] = None


class AdminPasswordChangePayload(BaseModel):
    new_password: str = Field(..., min_length=8)


class DepartmentCreatePayload(BaseModel):
    name: str = Field(..., min_length=2, max_length=120)


class WorkplacePolicyPayload(BaseModel):
    enforce_active_task_policy: bool


class BulkWorkplacePolicyPayload(BaseModel):
    user_ids: List[int] = Field(..., min_length=1)
    enforce_active_task_policy: bool


def _serialize_user(user: User, approval_status: str) -> dict:
    return {
        "id": user.id,
        "name": user.name,
        "email": user.email,
        "employeeId": user.employee_id,
        "department": user.department,
        "position": user.position,
        "roles": sorted(user_role_names(user)),
        "isActive": user.is_active,
        "isDeleted": bool(getattr(user, "is_deleted", False)),
        "isAdmin": user.is_admin,
        "approvalStatus": approval_status,
        "approvedBy": user.approved_by,
        "approvedAt": serialize_utc_datetime(user.approved_at),
        "rejectionReason": user.rejection_reason,
        "deletedBy": user.deleted_by,
        "deletedAt": serialize_utc_datetime(user.deleted_at),
        "deletedReason": user.deleted_reason,
        "createdAt": serialize_utc_datetime(user.created_at),
        "lastLogin": serialize_utc_datetime(user.last_login),
        "enforceActiveTaskPolicy": bool(getattr(user, "enforce_active_task_policy", False)),
    }


def _serialize_department(department: DepartmentDirectory, member_count: int = 0) -> dict:
    return {
        "id": department.id,
        "name": department.name,
        "isActive": bool(department.is_active),
        "memberCount": int(member_count or 0),
        "createdAt": serialize_utc_datetime(department.created_at),
        "updatedAt": serialize_utc_datetime(department.updated_at),
    }


def _get_signup_request(db: Session, user_id: int) -> Optional[UserApprovalRequest]:
    return (
        db.query(UserApprovalRequest)
        .filter(
            UserApprovalRequest.user_id == user_id,
            UserApprovalRequest.request_type == "signup",
        )
        .order_by(UserApprovalRequest.created_at.desc())
        .first()
    )


def _archive_deleted_user_identity(user: User) -> None:
    timestamp = datetime.utcnow().strftime("%Y%m%d%H%M%S")
    if user.email and "@archived.local" not in user.email:
        user.email = f"deleted+{user.id}.{timestamp}@archived.local"
    if user.employee_id and "-DEL-" not in user.employee_id:
        user.employee_id = f"{user.employee_id}-DEL-{user.id}-{timestamp}"


@router.get("/pending-signups")
async def pending_signups(
    current_user: User = Depends(require_admin),
    db: Session = Depends(get_operational_db),
):
    users = []
    rows = (
        db.query(UserApprovalRequest, User)
        .join(User, User.id == UserApprovalRequest.user_id)
        .filter(
            UserApprovalRequest.request_type == "signup",
            UserApprovalRequest.status == "pending",
            User.is_deleted == False,
        )
        .order_by(UserApprovalRequest.created_at.asc())
        .all()
    )

    for req, user in rows:
        item = _serialize_user(user, "pending")
        item["requestId"] = req.id
        item["requestCreatedAt"] = serialize_utc_datetime(req.created_at)
        users.append(item)

    return {"success": True, "count": len(users), "users": users}


@router.get("/requests/pending")
async def pending_requests(
    current_user: User = Depends(require_admin),
    db: Session = Depends(get_operational_db),
):
    rows = (
        db.query(UserApprovalRequest, User)
        .join(User, User.id == UserApprovalRequest.user_id)
        .filter(UserApprovalRequest.status == "pending")
        .filter(User.is_deleted == False)
        .order_by(UserApprovalRequest.created_at.asc())
        .all()
    )
    items = []
    for req, user in rows:
        items.append(
            {
                "requestId": req.id,
                "requestType": req.request_type,
                "status": req.status,
                "payload": sanitize_request_payload(req.request_type, req.payload_json),
                "createdAt": serialize_utc_datetime(req.created_at),
                "user": _serialize_user(user, req.status),
            }
        )
    return {"success": True, "count": len(items), "requests": items}


@router.post("/approve-user/{user_id}")
async def approve_user(
    user_id: int,
    current_user: User = Depends(require_admin),
    db: Session = Depends(get_operational_db),
):
    user = db.query(User).filter(User.id == user_id).first()
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    if user.is_deleted:
        raise HTTPException(status_code=400, detail="Cannot approve a deleted user")

    user.is_active = True
    user.approved_by = current_user.id
    user.approved_at = datetime.utcnow()
    user.rejection_reason = None

    req = _get_signup_request(db, user_id)
    if req and req.status == "pending":
        req.status = "approved"
        req.reviewed_by = current_user.id
        req.reviewed_at = datetime.utcnow()
        req.review_notes = "Approved by admin"

    db.commit()
    db.refresh(user)
    return {"success": True, "message": "User approved", "user": _serialize_user(user, "approved")}


@router.post("/reject-user/{user_id}")
async def reject_user(
    user_id: int,
    payload: RejectPayload,
    current_user: User = Depends(require_admin),
    db: Session = Depends(get_operational_db),
):
    user = db.query(User).filter(User.id == user_id).first()
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    if user.is_deleted:
        raise HTTPException(status_code=400, detail="Cannot reject a deleted user")

    user.is_active = False
    user.rejection_reason = payload.reason

    req = _get_signup_request(db, user_id)
    if req and req.status == "pending":
        req.status = "rejected"
        req.reviewed_by = current_user.id
        req.reviewed_at = datetime.utcnow()
        req.review_notes = payload.reason

    db.commit()
    db.refresh(user)
    return {"success": True, "message": "User rejected", "user": _serialize_user(user, "rejected")}


@router.post("/requests/{request_id}/review")
async def review_request(
    request_id: int,
    payload: ReviewPayload,
    current_user: User = Depends(require_admin),
    db: Session = Depends(get_operational_db),
):
    try:
        req = (
            db.query(UserApprovalRequest)
            .filter(UserApprovalRequest.id == request_id)
            .with_for_update()
            .first()
        )
        if not req:
            raise HTTPException(status_code=404, detail="Request not found")
        if req.status != "pending":
            raise HTTPException(status_code=400, detail="Request already reviewed")

        user = db.query(User).filter(User.id == req.user_id).with_for_update().first()
        if not user:
            raise HTTPException(status_code=404, detail="User not found")
        if user.is_deleted:
            raise HTTPException(status_code=400, detail="Cannot review requests for deleted users")

        req.status = "approved" if payload.approve else "rejected"
        req.reviewed_at = datetime.utcnow()
        req.reviewed_by = current_user.id
        req.review_notes = payload.notes

        if payload.approve:
            if req.request_type == "signup":
                user.is_active = True
                user.approved_by = current_user.id
                user.approved_at = datetime.utcnow()
                user.rejection_reason = None
            elif req.request_type == "profile_update":
                data = req.payload_json or {}
                user.name = data.get("name", user.name)
                user.email = data.get("email", user.email)
                user.employee_id = data.get("employee_id", user.employee_id)
                user.position = data.get("position", user.position)
                user.department = data.get("department", user.department)
            elif req.request_type == "password_change":
                pending_password = pending_password_change_for_request(db, req)
                if not pending_password or pending_password.status != "pending":
                    raise HTTPException(status_code=400, detail="Password change request is missing password data")
                if pending_password.expires_at and pending_password.expires_at < datetime.utcnow():
                    pending_password.status = "expired"
                    raise HTTPException(status_code=400, detail="Password change request has expired")
                user.hashed_password = pending_password.password_hash
                pending_password.status = "approved"
                pending_password.consumed_at = datetime.utcnow()
                revoke_user_sessions(db, user.id)
        else:
            if req.request_type == "password_change":
                pending_password = pending_password_change_for_request(db, req)
                if pending_password and pending_password.status == "pending":
                    pending_password.status = "rejected"
                    pending_password.consumed_at = datetime.utcnow()
            if req.request_type == "signup":
                user.is_active = False
                user.rejection_reason = payload.notes or "Request rejected by admin"

        db.commit()
    except HTTPException:
        db.rollback()
        raise
    except IntegrityError:
        db.rollback()
        raise HTTPException(status_code=409, detail="Request review could not be completed because of a duplicate value")
    except SQLAlchemyError:
        db.rollback()
        raise HTTPException(status_code=503, detail="Request review database unavailable")

    push_admin_realtime_event(
        db,
        "admin_request_reviewed",
        "Request Reviewed",
        f"{req.request_type} request was {req.status}.",
        {
            "requestType": req.request_type,
            "requestId": req.id,
            "status": req.status,
            "userId": user.id,
            "userEmail": user.email,
            "reviewedBy": current_user.id,
        },
    )
    return {"success": True, "message": f"Request {req.status}"}


@router.post("/deactivate-user/{user_id}")
async def deactivate_user(
    user_id: int,
    payload: Optional[RejectPayload] = None,
    current_user: User = Depends(require_admin),
    db: Session = Depends(get_operational_db),
):
    user = db.query(User).filter(User.id == user_id).first()
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    if user.is_deleted:
        raise HTTPException(status_code=400, detail="User account is deleted")
    user.is_active = False
    if payload and payload.reason:
        user.rejection_reason = payload.reason
    revoke_user_sessions(db, user.id)
    db.commit()
    push_admin_realtime_event(
        db,
        "admin_user_access_changed",
        "Login Access Removed",
        f"Login access removed for {user.name}.",
        {
            "userId": user.id,
            "userEmail": user.email,
            "userName": user.name,
            "isActive": False,
            "reason": payload.reason if payload and payload.reason else None,
            "updatedBy": current_user.id,
        },
    )
    return {"success": True, "message": "User login access removed"}


@router.post("/activate-user/{user_id}")
async def activate_user(
    user_id: int,
    current_user: User = Depends(require_admin),
    db: Session = Depends(get_operational_db),
):
    user = db.query(User).filter(User.id == user_id).first()
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    if user.is_deleted:
        raise HTTPException(status_code=400, detail="Cannot restore login for deleted account")
    user.is_active = True
    user.rejection_reason = None
    db.commit()
    push_admin_realtime_event(
        db,
        "admin_user_access_changed",
        "Login Access Restored",
        f"Login access restored for {user.name}.",
        {
            "userId": user.id,
            "userEmail": user.email,
            "userName": user.name,
            "isActive": True,
            "updatedBy": current_user.id,
        },
    )
    return {"success": True, "message": "User login access restored"}


@router.post("/delete-user/{user_id}")
async def delete_user_account(
    user_id: int,
    payload: Optional[DeleteUserPayload] = None,
    current_user: User = Depends(require_admin),
    db: Session = Depends(get_operational_db),
):
    if current_user.id == user_id:
        raise HTTPException(status_code=400, detail="You cannot delete your own account")

    user = db.query(User).filter(User.id == user_id).first()
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    if user.is_deleted:
        raise HTTPException(status_code=400, detail="User is already deleted")

    user.is_deleted = True
    user.is_active = False
    user.deleted_at = datetime.utcnow()
    user.deleted_by = current_user.id
    user.deleted_reason = (payload.reason.strip() if payload and payload.reason else None) or "Deleted by admin"
    user.rejection_reason = user.deleted_reason
    _archive_deleted_user_identity(user)

    pending_rows = db.query(UserApprovalRequest).filter(
        UserApprovalRequest.user_id == user.id,
        UserApprovalRequest.status == "pending",
    ).all()
    for row in pending_rows:
        row.status = "rejected"
        row.reviewed_at = datetime.utcnow()
        row.reviewed_by = current_user.id
        row.review_notes = f"Account deleted by admin. {user.deleted_reason}"

    revoke_user_sessions(db, user.id)
    db.commit()
    push_admin_realtime_event(
        db,
        "admin_user_deleted",
        "User Account Deleted",
        f"{user.name} account was deleted.",
        {
            "userId": user.id,
            "userEmail": user.email,
            "userName": user.name,
            "deletedAt": serialize_utc_datetime(user.deleted_at),
            "deletedReason": user.deleted_reason,
            "deletedBy": current_user.id,
        },
    )
    return {"success": True, "message": "User account deleted permanently"}


@router.post("/users/{user_id}/password")
async def admin_change_user_password(
    user_id: int,
    payload: AdminPasswordChangePayload,
    current_user: User = Depends(require_admin),
    db: Session = Depends(get_operational_db),
):
    user = db.query(User).filter(User.id == user_id).first()
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    if user.is_deleted:
        raise HTTPException(status_code=400, detail="Cannot change password for a deleted account")

    user.hashed_password = get_password_hash(payload.new_password)
    revoke_user_sessions(db, user.id)
    db.commit()

    push_admin_realtime_event(
        db,
        "admin_user_password_changed",
        "User Password Changed",
        f"Password updated for {user.name}.",
        {
            "userId": user.id,
            "userEmail": user.email,
            "userName": user.name,
            "updatedBy": current_user.id,
        },
    )
    return {"success": True, "message": "User password updated successfully"}


@router.patch("/users/workplace-policy/bulk")
async def bulk_set_workplace_policy(
    payload: BulkWorkplacePolicyPayload,
    current_user: User = Depends(require_admin),
    db: Session = Depends(get_operational_db),
):
    if not payload.user_ids:
        raise HTTPException(status_code=400, detail="No user IDs provided")
    rows = (
        db.query(User)
        .filter(
            User.id.in_(payload.user_ids),
            User.is_deleted == False,
        )
        .all()
    )
    updated = []
    skipped = []
    for u in rows:
        if has_any_role(u, {"admin"}):
            skipped.append(u.id)
            continue
        u.enforce_active_task_policy = payload.enforce_active_task_policy
        updated.append(u.id)
    db.commit()
    push_admin_realtime_event(
        db,
        "admin_user_policy_changed",
        "Workplace Policy Bulk Update",
        f"Policy {'enabled' if payload.enforce_active_task_policy else 'disabled'} for {len(updated)} user(s).",
        {
            "updatedUserIds": updated,
            "skippedUserIds": skipped,
            "enforceActiveTaskPolicy": payload.enforce_active_task_policy,
            "updatedBy": current_user.id,
        },
    )
    return {"success": True, "updatedCount": len(updated), "skippedCount": len(skipped)}


@router.patch("/users/{user_id}/workplace-policy")
async def set_user_workplace_policy(
    user_id: int,
    payload: WorkplacePolicyPayload,
    current_user: User = Depends(require_admin),
    db: Session = Depends(get_operational_db),
):
    user = db.query(User).filter(User.id == user_id).first()
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    if user.is_deleted:
        raise HTTPException(status_code=400, detail="Cannot update policy for a deleted account")
    if has_any_role(user, {"admin"}):
        raise HTTPException(status_code=400, detail="Workplace policy cannot be applied to administrators")
    user.enforce_active_task_policy = payload.enforce_active_task_policy
    db.commit()
    db.refresh(user)
    push_admin_realtime_event(
        db,
        "admin_user_policy_changed",
        "Workplace Policy Updated",
        f"Workplace access policy {'enabled' if payload.enforce_active_task_policy else 'disabled'} for {user.name}.",
        {
            "userId": user.id,
            "userName": user.name,
            "enforceActiveTaskPolicy": payload.enforce_active_task_policy,
            "updatedBy": current_user.id,
        },
    )
    return {"success": True, "user": _serialize_user(user, "approved" if user.is_active else "pending")}


@router.get("/deleted-users")
async def deleted_users(
    current_user: User = Depends(require_admin),
    db: Session = Depends(get_operational_db),
):
    rows = db.query(User).filter(User.is_deleted == True).order_by(User.deleted_at.desc(), User.created_at.desc()).all()
    return {
        "success": True,
        "count": len(rows),
        "users": [_serialize_user(user, "deleted") for user in rows],
    }


@router.get("/all-users")
async def all_users(
    current_user: User = Depends(require_admin),
    db: Session = Depends(get_operational_db),
):
    users = db.query(User).order_by(User.is_deleted.asc(), User.created_at.desc()).all()
    signup_requests = (
        db.query(UserApprovalRequest)
        .filter(UserApprovalRequest.request_type == "signup")
        .order_by(UserApprovalRequest.user_id.asc(), UserApprovalRequest.created_at.desc())
        .all()
    )
    latest_signup_by_user: dict[int, UserApprovalRequest] = {}
    for req in signup_requests:
        latest_signup_by_user.setdefault(req.user_id, req)

    data = []
    for user in users:
        req = latest_signup_by_user.get(user.id)
        status = "deleted" if user.is_deleted else ("approved" if user.is_active else "pending")
        if req and req.status in {"pending", "rejected", "approved"}:
            status = req.status
        if user.is_deleted:
            status = "deleted"
        data.append(_serialize_user(user, status))
    return {"success": True, "count": len(data), "users": data}


@router.get("/departments")
async def list_departments(
    current_user: User = Depends(require_admin),
    db: Session = Depends(get_operational_db),
):
    departments = (
        db.query(DepartmentDirectory)
        .filter(DepartmentDirectory.is_active == True)
        .order_by(DepartmentDirectory.name.asc())
        .all()
    )
    normalized_names = [f"{department.name or ''}".strip().lower() for department in departments]
    member_counts = {}
    if normalized_names:
        counts = (
            db.query(func.lower(func.trim(User.department)).label("department_key"), func.count(User.id))
            .filter(
                User.is_deleted == False,
                User.department != None,
                func.lower(func.trim(User.department)).in_(normalized_names),
            )
            .group_by(func.lower(func.trim(User.department)))
            .all()
        )
        member_counts = {row[0]: int(row[1] or 0) for row in counts}

    return {
        "success": True,
        "count": len(departments),
        "departments": [
            _serialize_department(
                department,
                member_counts.get(f"{department.name or ''}".strip().lower(), 0),
            )
            for department in departments
        ],
    }


@router.post("/departments")
async def create_department(
    payload: DepartmentCreatePayload,
    current_user: User = Depends(require_admin),
    db: Session = Depends(get_operational_db),
):
    name = (payload.name or "").strip()
    if len(name) < 2:
        raise HTTPException(status_code=400, detail="Department name must be at least 2 characters long")

    existing = (
        db.query(DepartmentDirectory)
        .filter(func.lower(func.trim(DepartmentDirectory.name)) == name.lower())
        .first()
    )
    if existing:
        if existing.is_active:
            raise HTTPException(status_code=409, detail="Department already exists")
        existing.name = name
        existing.is_active = True
        existing.updated_by = current_user.id
        existing.updated_at = datetime.utcnow()
        department = existing
    else:
        department = DepartmentDirectory(
            name=name,
            is_active=True,
            created_by=current_user.id,
            updated_by=current_user.id,
        )
        db.add(department)

    db.commit()
    db.refresh(department)
    await invalidate_pattern(AUTH_DEPARTMENTS_CACHE_PATTERN)
    return {
        "success": True,
        "message": "Department added successfully",
        "department": _serialize_department(department, 0),
    }
