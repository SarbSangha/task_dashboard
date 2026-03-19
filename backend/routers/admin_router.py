from datetime import datetime
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session
import asyncio

from database_config import get_operational_db
from models_new import User, UserApprovalRequest
from auth import SESSION_STORE, invalidate_session, revoke_user_sessions
from routers.tasks_router import notification_hub
from routers.auth_router import get_current_user, ensure_admin


router = APIRouter(prefix="/api/admin", tags=["Admin"])


class RejectPayload(BaseModel):
    reason: str = Field(..., min_length=2)


class ReviewPayload(BaseModel):
    approve: bool = True
    notes: Optional[str] = None


class DeleteUserPayload(BaseModel):
    reason: Optional[str] = None


def _serialize_user(user: User, approval_status: str) -> dict:
    return {
        "id": user.id,
        "name": user.name,
        "email": user.email,
        "employeeId": user.employee_id,
        "department": user.department,
        "position": user.position,
        "roles": user.roles_json or [],
        "isActive": user.is_active,
        "isDeleted": bool(getattr(user, "is_deleted", False)),
        "isAdmin": user.is_admin,
        "approvalStatus": approval_status,
        "approvedBy": user.approved_by,
        "approvedAt": user.approved_at.isoformat() if user.approved_at else None,
        "rejectionReason": user.rejection_reason,
        "deletedBy": user.deleted_by,
        "deletedAt": user.deleted_at.isoformat() if user.deleted_at else None,
        "deletedReason": user.deleted_reason,
        "createdAt": user.created_at.isoformat() if user.created_at else None,
        "lastLogin": user.last_login.isoformat() if user.last_login else None,
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


def _terminate_user_sessions(user_id: int) -> None:
    tokens = [token for token, data in SESSION_STORE.items() if data.get("user_id") == user_id]
    for token in tokens:
        invalidate_session(token)


def _admin_user_ids(db: Session) -> list[int]:
    rows = db.query(User.id).filter(
        User.is_active == True,
        User.is_deleted == False,
        ((User.is_admin == True) | (User.position.ilike("%admin%"))),
    ).all()
    return [row[0] for row in rows]


def _push_admin_realtime_event(db: Session, event_type: str, title: str, message: str, metadata: Optional[dict] = None):
    payload = {
        "eventType": event_type,
        "title": title,
        "message": message,
        "metadata": metadata or {},
    }
    for admin_id in _admin_user_ids(db):
        try:
            asyncio.create_task(notification_hub.push(admin_id, payload))
        except RuntimeError:
            pass


def _sanitize_request_payload(request_type: str, payload: Optional[dict]) -> dict:
    data = dict(payload or {})
    if request_type == "password_change":
        return {
            "summary": "Secure password change request",
            "hasPasswordUpdate": bool(data.get("password_hash")),
        }
    return data


@router.get("/pending-signups")
async def pending_signups(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_operational_db),
):
    ensure_admin(current_user)
    requests = (
        db.query(UserApprovalRequest)
        .filter(
            UserApprovalRequest.request_type == "signup",
            UserApprovalRequest.status == "pending",
        )
        .order_by(UserApprovalRequest.created_at.asc())
        .all()
    )

    users = []
    for req in requests:
        user = db.query(User).filter(User.id == req.user_id, User.is_deleted == False).first()
        if not user:
            continue
        item = _serialize_user(user, "pending")
        item["requestId"] = req.id
        item["requestCreatedAt"] = req.created_at.isoformat() if req.created_at else None
        users.append(item)

    return {"success": True, "count": len(users), "users": users}


@router.get("/requests/pending")
async def pending_requests(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_operational_db),
):
    ensure_admin(current_user)
    rows = (
        db.query(UserApprovalRequest)
        .filter(UserApprovalRequest.status == "pending")
        .order_by(UserApprovalRequest.created_at.asc())
        .all()
    )
    items = []
    for req in rows:
        user = db.query(User).filter(User.id == req.user_id, User.is_deleted == False).first()
        if not user:
            continue
        items.append(
            {
                "requestId": req.id,
                "requestType": req.request_type,
                "status": req.status,
                "payload": _sanitize_request_payload(req.request_type, req.payload_json),
                "createdAt": req.created_at.isoformat() if req.created_at else None,
                "user": _serialize_user(user, req.status),
            }
        )
    return {"success": True, "count": len(items), "requests": items}


@router.post("/approve-user/{user_id}")
async def approve_user(
    user_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_operational_db),
):
    ensure_admin(current_user)
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
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_operational_db),
):
    ensure_admin(current_user)
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
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_operational_db),
):
    ensure_admin(current_user)
    req = db.query(UserApprovalRequest).filter(UserApprovalRequest.id == request_id).first()
    if not req:
        raise HTTPException(status_code=404, detail="Request not found")
    if req.status != "pending":
        raise HTTPException(status_code=400, detail="Request already reviewed")

    user = db.query(User).filter(User.id == req.user_id).first()
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
            data = req.payload_json or {}
            password_hash = data.get("password_hash")
            if not password_hash:
                raise HTTPException(status_code=400, detail="Password change request is missing password data")
            user.hashed_password = password_hash
            revoke_user_sessions(db, user.id)
    else:
        if req.request_type == "signup":
            user.is_active = False
            user.rejection_reason = payload.notes or "Request rejected by admin"

    db.commit()
    _push_admin_realtime_event(
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
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_operational_db),
):
    ensure_admin(current_user)
    user = db.query(User).filter(User.id == user_id).first()
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    if user.is_deleted:
        raise HTTPException(status_code=400, detail="User account is deleted")
    user.is_active = False
    if payload and payload.reason:
        user.rejection_reason = payload.reason
    _terminate_user_sessions(user.id)
    db.commit()
    _push_admin_realtime_event(
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
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_operational_db),
):
    ensure_admin(current_user)
    user = db.query(User).filter(User.id == user_id).first()
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    if user.is_deleted:
        raise HTTPException(status_code=400, detail="Cannot restore login for deleted account")
    user.is_active = True
    user.rejection_reason = None
    db.commit()
    _push_admin_realtime_event(
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
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_operational_db),
):
    ensure_admin(current_user)
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

    pending_rows = db.query(UserApprovalRequest).filter(
        UserApprovalRequest.user_id == user.id,
        UserApprovalRequest.status == "pending",
    ).all()
    for row in pending_rows:
        row.status = "rejected"
        row.reviewed_at = datetime.utcnow()
        row.reviewed_by = current_user.id
        row.review_notes = f"Account deleted by admin. {user.deleted_reason}"

    _terminate_user_sessions(user.id)
    db.commit()
    _push_admin_realtime_event(
        db,
        "admin_user_deleted",
        "User Account Deleted",
        f"{user.name} account was deleted.",
        {
            "userId": user.id,
            "userEmail": user.email,
            "userName": user.name,
            "deletedAt": user.deleted_at.isoformat() if user.deleted_at else None,
            "deletedReason": user.deleted_reason,
            "deletedBy": current_user.id,
        },
    )
    return {"success": True, "message": "User account deleted permanently"}


@router.get("/deleted-users")
async def deleted_users(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_operational_db),
):
    ensure_admin(current_user)
    rows = db.query(User).filter(User.is_deleted == True).order_by(User.deleted_at.desc(), User.created_at.desc()).all()
    return {
        "success": True,
        "count": len(rows),
        "users": [_serialize_user(user, "deleted") for user in rows],
    }


@router.get("/all-users")
async def all_users(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_operational_db),
):
    ensure_admin(current_user)
    users = db.query(User).order_by(User.is_deleted.asc(), User.created_at.desc()).all()
    data = []
    for user in users:
        req = _get_signup_request(db, user.id)
        status = "deleted" if user.is_deleted else ("approved" if user.is_active else "pending")
        if req and req.status in {"pending", "rejected", "approved"}:
            status = req.status
        if user.is_deleted:
            status = "deleted"
        data.append(_serialize_user(user, status))
    return {"success": True, "count": len(data), "users": data}
