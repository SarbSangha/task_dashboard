from datetime import datetime
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from database_config import get_operational_db
from models_new import User, UserApprovalRequest
from routers.auth_router import get_current_user, ensure_admin


router = APIRouter(prefix="/api/admin", tags=["Admin"])


class RejectPayload(BaseModel):
    reason: str = Field(..., min_length=2)


class ReviewPayload(BaseModel):
    approve: bool = True
    notes: Optional[str] = None


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
        "isAdmin": user.is_admin,
        "approvalStatus": approval_status,
        "approvedBy": user.approved_by,
        "approvedAt": user.approved_at.isoformat() if user.approved_at else None,
        "rejectionReason": user.rejection_reason,
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
        user = db.query(User).filter(User.id == req.user_id).first()
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
        user = db.query(User).filter(User.id == req.user_id).first()
        if not user:
            continue
        items.append(
            {
                "requestId": req.id,
                "requestType": req.request_type,
                "status": req.status,
                "payload": req.payload_json or {},
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
    else:
        if req.request_type == "signup":
            user.is_active = False
            user.rejection_reason = payload.notes or "Request rejected by admin"

    db.commit()
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
    user.is_active = False
    if payload and payload.reason:
        user.rejection_reason = payload.reason
    db.commit()
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
    user.is_active = True
    user.rejection_reason = None
    db.commit()
    return {"success": True, "message": "User login access restored"}


@router.get("/all-users")
async def all_users(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_operational_db),
):
    ensure_admin(current_user)
    users = db.query(User).order_by(User.created_at.desc()).all()
    data = []
    for user in users:
        req = _get_signup_request(db, user.id)
        status = "approved" if user.is_active else "pending"
        if req and req.status in {"pending", "rejected", "approved"}:
            status = req.status
        data.append(_serialize_user(user, status))
    return {"success": True, "count": len(data), "users": data}
