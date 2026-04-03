# routers/auth_router.py - Authentication endpoints
from fastapi import APIRouter, Depends, HTTPException, Response, Cookie, Request, Header
from sqlalchemy import or_
from sqlalchemy.orm import Session
from typing import Optional, List
from datetime import datetime
from time import monotonic as _monotonic
from fastapi.responses import JSONResponse
from pydantic import BaseModel, EmailStr, Field, validator
import traceback
import os
import asyncio
from urllib.parse import urlparse
from database_config import get_operational_db
from models_new import User, UserApprovalRequest
from routers.tasks_router import notification_hub
from schemas import (
    UserCreate, 
    UserLoginExtended,
    UserResponse, 
    PasswordUpdate, 
    MessageResponse,
    ForgotPasswordRequest,
    ResetPasswordRequest,
    AvatarUpload,
    ProfileUpdate
)
from auth import (
    get_password_hash, 
    authenticate_user, 
    create_session_token,
    resolve_session_user,
    verify_session_token,
    invalidate_session,
    revoke_user_sessions,
    verify_password,
    create_reset_token,
    verify_reset_token,
    invalidate_reset_token,
    get_request_session_token,
)
from utils.cache import cache_response
from utils.permissions import has_any_role, require_admin

router = APIRouter(prefix="/api/auth", tags=["Authentication"])

DEFAULT_ALLOWED_COMPANY_DOMAINS = (
    "@ritzmediaworld.com",
    "@ctm.co.in",
    "@rmwcreative.in",
    "@contenaissance.com",
)

_ADMIN_IDS_CACHE: dict = {"ids": [], "exp": 0.0}
_ADMIN_IDS_TTL = 60.0


def _allowed_company_domains() -> tuple[str, ...]:
    raw = (os.getenv("ALLOWED_COMPANY_EMAIL_DOMAINS") or "").strip()
    if not raw:
        return DEFAULT_ALLOWED_COMPANY_DOMAINS
    domains = []
    for part in raw.split(","):
        value = part.strip().lower()
        if not value:
            continue
        if not value.startswith("@"):
            value = f"@{value}"
        domains.append(value)
    return tuple(domains) if domains else DEFAULT_ALLOWED_COMPANY_DOMAINS


def _is_allowed_company_email(email: Optional[str]) -> bool:
    value = (email or "").strip().lower()
    if "@" not in value:
        return False
    return any(value.endswith(domain) for domain in _allowed_company_domains())


def _serialize_user(user: User) -> dict:
    return {
        "id": user.id,
        "name": user.name,
        "email": user.email,
        "employeeId": user.employee_id,
        "position": user.position,
        "department": user.department,
        "avatar": None if _is_base64_avatar(user.avatar) else user.avatar,
        "roles": user.roles_json or [],
        "isAdmin": user.is_admin,
        "lastLogin": user.last_login.isoformat() if user.last_login else None,
    }


def _is_base64_avatar(value: Optional[str]) -> bool:
    return bool(value and value.lower().startswith("data:"))


def _normalize_avatar(avatar: Optional[str]) -> Optional[str]:
    value = (avatar or "").strip()
    if not value:
        return None
    if value.startswith("data:image/"):
        return value
    if value.startswith("http://") or value.startswith("https://") or value.startswith("/"):
        return value
    return None


def _is_truthy(value: Optional[str]) -> bool:
    return (value or "").strip().lower() in {"1", "true", "yes", "on"}


def _resolve_cookie_policy(request: Optional[Request] = None) -> tuple[bool, str]:
    is_production = (os.getenv("ENVIRONMENT", "").strip().lower() == "production")
    configured_samesite = (os.getenv("COOKIE_SAMESITE", "").strip().lower() or None)
    cookie_secure = _is_truthy(os.getenv("COOKIE_SECURE")) or is_production

    request_scheme = ""
    request_host = ""
    origin_host = ""
    origin_scheme = ""

    if request is not None:
        request_scheme = (
            request.headers.get("x-forwarded-proto")
            or request.headers.get("x-forwarded-protocol")
            or request.url.scheme
            or ""
        ).split(",")[0].strip().lower()
        request_host = (request.headers.get("x-forwarded-host") or request.headers.get("host") or "").strip().lower()
        origin = (request.headers.get("origin") or "").strip()
        if origin:
            parsed_origin = urlparse(origin)
            origin_host = (parsed_origin.netloc or "").strip().lower()
            origin_scheme = (parsed_origin.scheme or "").strip().lower()

    is_cross_site = bool(origin_host and request_host and origin_host != request_host)
    if request_scheme == "https" or origin_scheme == "https":
        cookie_secure = True

    cookie_samesite = configured_samesite or ("none" if (cookie_secure and is_cross_site) else "lax")
    if cookie_samesite not in {"lax", "strict", "none"}:
        cookie_samesite = "none" if (cookie_secure and is_cross_site) else "lax"
    if cookie_samesite == "none" and not cookie_secure:
        cookie_secure = True

    return cookie_secure, cookie_samesite

class UserRegister(BaseModel):
    email: EmailStr
    password: str = Field(..., min_length=6)
    name: str = Field(..., min_length=2)
    position: str = Field(default=None)
    department: str = Field(default=None)
    roles: Optional[List[str]] = None


class ApprovalDecision(BaseModel):
    notes: Optional[str] = None
    approve: bool = True


class ProfileChangeRequestPayload(BaseModel):
    name: str = Field(..., min_length=2)
    email: EmailStr
    employee_id: Optional[str] = None
    position: Optional[str] = None
    department: Optional[str] = None


class PasswordChangeRequestPayload(BaseModel):
    new_password: str = Field(..., min_length=8)
    confirm_password: str = Field(..., min_length=8)

    @validator("confirm_password")
    def passwords_must_match(cls, value: str, values: dict) -> str:
        if value != values.get("new_password"):
            raise ValueError("Passwords do not match")
        return value

# ==================== HELPER FUNCTIONS ====================
def get_current_user(
    session_id: Optional[str] = Cookie(None, alias="session_id"),
    x_session_id: Optional[str] = Header(None, alias="X-Session-Id"),
    # response: Response,
    db: Session = Depends(get_operational_db)
):
    """Validate session and return current user"""
    resolved_session_id = get_request_session_token(session_id, x_session_id)
    if not resolved_session_id:
        raise HTTPException(status_code=401, detail="Not authenticated")
    
    return resolve_session_user(resolved_session_id, db)


def ensure_admin(current_user: User):
    if not has_any_role(current_user, {"admin"}):
        raise HTTPException(status_code=403, detail="Admin access required")


def generate_employee_id(db: Session) -> str:
    year = datetime.utcnow().year
    prefix = f"EMP-{year}-"
    existing_ids = [
        row[0]
        for row in db.query(User.employee_id)
        .filter(User.employee_id.like(f"{prefix}%"))
        .all()
        if row[0]
    ]

    next_sequence = 1
    for employee_id in existing_ids:
        suffix = employee_id.removeprefix(prefix)
        if not suffix.isdigit():
            continue
        next_sequence = max(next_sequence, int(suffix) + 1)

    while True:
        candidate = f"{prefix}{next_sequence:04d}"
        exists = db.query(User.id).filter(User.employee_id == candidate).first()
        if not exists:
            return candidate
        next_sequence += 1


def _archive_deleted_user_identity(existing_user: User) -> None:
    timestamp = datetime.utcnow().strftime("%Y%m%d%H%M%S")
    existing_user.email = f"deleted+{existing_user.id}.{timestamp}@archived.local"
    if existing_user.employee_id:
        existing_user.employee_id = f"{existing_user.employee_id}-DEL-{existing_user.id}-{timestamp}"


def _admin_user_ids(db: Session) -> list[int]:
    now = _monotonic()
    if _ADMIN_IDS_CACHE["exp"] > now:
        return _ADMIN_IDS_CACHE["ids"]

    rows = (
        db.query(User.id)
        .filter(
            User.is_active == True,
            User.is_deleted == False,
            or_(
                User.is_admin == True,
                User.position.ilike("%admin%"),
            ),
        )
        .all()
    )
    ids = [row[0] for row in rows]
    _ADMIN_IDS_CACHE["ids"] = ids
    _ADMIN_IDS_CACHE["exp"] = now + _ADMIN_IDS_TTL
    return ids


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


def _latest_user_request_by_type(db: Session, user_id: int, request_type: str) -> Optional[UserApprovalRequest]:
    return (
        db.query(UserApprovalRequest)
        .filter(
            UserApprovalRequest.user_id == user_id,
            UserApprovalRequest.request_type == request_type,
        )
        .order_by(UserApprovalRequest.created_at.desc())
        .first()
    )


def _create_password_change_request(db: Session, current_user: User, new_password: str) -> UserApprovalRequest:
    existing_pending = db.query(UserApprovalRequest).filter(
        UserApprovalRequest.user_id == current_user.id,
        UserApprovalRequest.request_type == "password_change",
        UserApprovalRequest.status == "pending",
    ).first()
    if existing_pending:
        raise HTTPException(status_code=400, detail="A password change request is already pending approval")

    if verify_password(new_password, current_user.hashed_password):
        raise HTTPException(status_code=400, detail="New password must be different from your current password")

    password_hash = get_password_hash(new_password)
    request_row = UserApprovalRequest(
        user_id=current_user.id,
        request_type="password_change",
        status="pending",
        payload_json={
            "password_hash": password_hash,
        },
        created_at=datetime.utcnow(),
    )
    db.add(request_row)
    db.commit()
    db.refresh(request_row)

    _push_admin_realtime_event(
        db,
        "admin_request_created",
        "New Password Change Request",
        f"{current_user.name} requested a password change.",
        {
            "requestType": "password_change",
            "requestId": request_row.id,
            "userId": current_user.id,
            "userEmail": current_user.email,
            "userName": current_user.name,
        },
    )
    return request_row


# ==================== AUTH ENDPOINTS ====================
# ==================== REGISTER ====================
@router.post("/register")
async def register(
    user_data: UserRegister,
    db: Session = Depends(get_operational_db)
):
    """Register a new user"""
    try:
        print(f"\n📝 REGISTRATION ATTEMPT: {user_data.email}")

        if not _is_allowed_company_email(user_data.email):
            raise HTTPException(
                status_code=403,
                detail=(
                    "Only company email addresses are allowed. "
                    "Use one of: @ritzmediaworld.com, @ctm.co.in, "
                    "@rmwcreative.in, @contenaissance.com"
                ),
            )
        
        normalized_email = user_data.email.strip().lower()
        user_data.email = normalized_email

        # Check if user exists
        existing_user = db.query(User).filter(
            User.email == user_data.email
        ).first()
        
        if existing_user:
            if not existing_user.is_deleted:
                raise HTTPException(
                    status_code=400,
                    detail="Email already registered"
                )
            print(f"♻️ Re-registering deleted account with fresh identity: {existing_user.email}")
            stale_pending_rows = db.query(UserApprovalRequest).filter(
                UserApprovalRequest.user_id == existing_user.id,
                UserApprovalRequest.status == "pending",
            ).all()
            for row in stale_pending_rows:
                row.status = "rejected"
                row.reviewed_at = datetime.utcnow()
                row.review_notes = "Superseded by a newer signup registration."
            _archive_deleted_user_identity(existing_user)
            db.flush()

        # Hash password
        hashed_password = get_password_hash(user_data.password)
        
        # Create user
        new_user = User(
            email=user_data.email,
            employee_id=generate_employee_id(db),
            name=user_data.name,
            hashed_password=hashed_password,
            position=user_data.position,
            department=user_data.department,
            roles_json=[r.lower() for r in (user_data.roles or [])],
            is_active=False,
            is_admin=False,
            created_at=datetime.utcnow()
        )
        
        db.add(new_user)
        db.flush()

        db.add(
            UserApprovalRequest(
                user_id=new_user.id,
                request_type="signup",
                status="pending",
                payload_json={
                    "name": new_user.name,
                    "email": new_user.email,
                    "position": new_user.position,
                    "department": new_user.department,
                    "roles": new_user.roles_json or [],
                },
                created_at=datetime.utcnow(),
            )
        )
        
        db.commit()
        db.refresh(new_user)
        created_request = db.query(UserApprovalRequest).filter(
            UserApprovalRequest.user_id == new_user.id,
            UserApprovalRequest.request_type == "signup",
        ).order_by(UserApprovalRequest.created_at.desc()).first()
        _push_admin_realtime_event(
            db,
            "admin_request_created",
            "New Login Request",
            f"{new_user.name} requested signup approval.",
            {
                "requestType": "signup",
                "requestId": created_request.id if created_request else None,
                "userId": new_user.id,
                "userEmail": new_user.email,
                "userName": new_user.name,
            },
        )
        
        print(f"✅ Registration successful: {new_user.email}")
        
        return {
            "success": True,
            "message": "Registration submitted. Admin approval required before login.",
            "user": {
                "id": new_user.id,
                "name": new_user.name,
                "email": new_user.email,
                "employeeId": new_user.employee_id,
                "position": new_user.position,
                "department": new_user.department,
                "roles": new_user.roles_json or [],
                "isAdmin": new_user.is_admin
            }
        }
        
    except HTTPException:
        raise
    except Exception as e:
        db.rollback()
        print(f"❌ Registration error: {str(e)}")
        traceback.print_exc()
        raise HTTPException(
            status_code=500,
            detail="An error occurred during registration"
        )


@router.post("/login")
async def login(
    credentials: UserLoginExtended,
    request: Request,
    response: Response,
    db: Session = Depends(get_operational_db)
):
    """Login user and create session"""
    try:
        print(f"\nLOGIN ATTEMPT: {credentials.email}")
        
        # Find user
        user = db.query(User).filter(
            (User.email == credentials.email) | (User.name == credentials.email)
        ).first()
        if not user:
            raise HTTPException(
                status_code=401, 
                detail="Invalid email or password"
            )
        if user.is_deleted:
            raise HTTPException(
                status_code=401,
                detail={
                    "code": "ACCOUNT_DELETED",
                    "message": "This account has been deleted by admin.",
                    "reason": user.deleted_reason,
                    "nextAction": "Contact your admin if this is unexpected.",
                },
            )

        if not _is_allowed_company_email(user.email):
            raise HTTPException(
                status_code=403,
                detail=(
                    "Only company email addresses are authorized to login. "
                    "Allowed: @ritzmediaworld.com, @ctm.co.in, "
                    "@rmwcreative.in, @contenaissance.com"
                ),
            )
        
        # Verify password
        if not verify_password(credentials.password, user.hashed_password):
            raise HTTPException(
                status_code=401, 
                detail="Invalid email or password"
            )
        
        if not user.is_active:
            latest_signup_request = db.query(UserApprovalRequest).filter(
                UserApprovalRequest.user_id == user.id,
                UserApprovalRequest.request_type == "signup",
            ).order_by(UserApprovalRequest.created_at.desc()).first()
            pending_request = latest_signup_request and latest_signup_request.status == "pending"
            rejected_request = latest_signup_request and latest_signup_request.status == "rejected"
            rejection_reason = (
                (latest_signup_request.review_notes or user.rejection_reason)
                if rejected_request
                else user.rejection_reason
            )
            if pending_request:
                detail_payload = {
                    "code": "ACCOUNT_PENDING_APPROVAL",
                    "message": "Your account is pending admin approval.",
                    "reason": None,
                    "nextAction": "Please wait for approval or contact your admin.",
                }
            elif rejected_request:
                detail_payload = {
                    "code": "ACCOUNT_REJECTED",
                    "message": "Your account request was rejected.",
                    "reason": rejection_reason,
                    "nextAction": "Contact your admin to request reactivation.",
                }
            else:
                detail_payload = {
                    "code": "ACCOUNT_INACTIVE",
                    "message": "Your account is inactive.",
                    "reason": rejection_reason,
                    "nextAction": "Contact your admin to restore login access.",
                }
            raise HTTPException(
                status_code=401, 
                detail=detail_payload
            )
        
        # Update last login
        user.last_login = datetime.utcnow()
        db.commit()
        
        # Create session
        session_id = create_session_token(user.id)

        cookie_secure, cookie_samesite = _resolve_cookie_policy(request)
        
        # Set cookie
        response.set_cookie(
            key="session_id",
            value=session_id,
            httponly=True,
            secure=cookie_secure,
            samesite=cookie_samesite,
            max_age=30 * 24 * 60 * 60,
            path="/"
        )
        
        print(f"✅ Login successful: {user.email}")
        print(f"🍪 Cookie set: session_id={session_id[:10]}...")
        
        return {
            "success": True,
            "message": "Login successful",
            "user": _serialize_user(user),
            "sessionToken": session_id,
        }
        
    except HTTPException:
        raise
    except Exception as e:
        print(f"❌ Login error: {str(e)}")
        traceback.print_exc()
        raise HTTPException(
            status_code=500,
            detail="An error occurred during login"
        )


@router.get("/me")
async def get_current_user_profile(
    session_id: Optional[str] = Cookie(None, alias="session_id"),
    x_session_id: Optional[str] = Header(None, alias="X-Session-Id"),
    db: Session = Depends(get_operational_db)
):
    """Get current authenticated user"""
    resolved_session_id = get_request_session_token(session_id, x_session_id)
    if not resolved_session_id:
        raise HTTPException(status_code=401, detail="Not authenticated")
    
    try:
        user = resolve_session_user(resolved_session_id, db)
        
        return {
            "success": True,
            "user": _serialize_user(user)
        }
    except HTTPException:
        raise
    except Exception as e:
        print(f"❌ Error getting current user: {str(e)}")
        raise HTTPException(status_code=401, detail="Invalid session")


@router.get("/profile")
async def get_profile(
    current_user: User = Depends(get_current_user),
):
    return {
        "success": True,
        "user": _serialize_user(current_user),
    }


@router.get("/avatar")
async def get_avatar(
    current_user: User = Depends(get_current_user),
):
    return {
        "success": True,
        "userId": current_user.id,
        "avatar": current_user.avatar,
        "hasAvatar": bool(current_user.avatar),
    }


@router.post("/avatar")
async def upload_avatar(
    payload: AvatarUpload,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_operational_db)
):
    avatar = _normalize_avatar(payload.avatar)
    if not avatar:
        raise HTTPException(status_code=400, detail="A valid image is required")
    if len(avatar) > 3_000_000:
        raise HTTPException(status_code=400, detail="Avatar image is too large")

    current_user.avatar = avatar
    db.commit()
    db.refresh(current_user)

    return {
        "success": True,
        "message": "Avatar updated successfully",
        "avatar": current_user.avatar,
        "user": _serialize_user(current_user),
    }


@router.delete("/avatar")
async def delete_avatar(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_operational_db)
):
    current_user.avatar = None
    db.commit()
    db.refresh(current_user)

    return {
        "success": True,
        "message": "Avatar removed successfully",
        "avatar": None,
        "user": _serialize_user(current_user),
    }


@router.put("/profile")
async def update_profile(
    payload: ProfileUpdate,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_operational_db)
):
    updated = False

    if payload.avatar is not None:
        normalized_avatar = _normalize_avatar(payload.avatar)
        if payload.avatar and not normalized_avatar:
            raise HTTPException(status_code=400, detail="A valid avatar image is required")
        current_user.avatar = normalized_avatar
        updated = True

    if payload.name is not None:
        next_name = payload.name.strip()
        if len(next_name) < 2:
            raise HTTPException(status_code=400, detail="Name must be at least 2 characters long")
        current_user.name = next_name
        updated = True

    if updated:
        db.commit()
        db.refresh(current_user)

    return {
        "success": True,
        "message": "Profile updated successfully",
        "user": _serialize_user(current_user),
    }


@router.get("/department/{department_name}/users")
async def get_users_by_department(
    department_name: str,
    role: Optional[str] = None,
    db: Session = Depends(get_operational_db)
):
    """Get all active users in a specific department"""
    try:
        users_query = db.query(User).filter(
            User.department == department_name,
            User.is_active == True,
            User.is_deleted == False
        )
        if role:
            role_lower = role.lower()
            users_query = users_query.filter(
                (User.position.ilike(f"%{role_lower}%")) |
                (User.roles_json.contains([role_lower]))
            )
        users = users_query.all()
        
        return {
            "success": True,
            "department": department_name,
            "users": [
                {
                    "id": user.id,
                    "name": user.name,
                    "email": user.email,
                    "employeeId": user.employee_id,
                    "position": user.position,
                    "roles": user.roles_json or [],
                    "avatar": user.avatar
                }
                for user in users
            ],
            "count": len(users)
        }
    except Exception as e:
        print(f"❌ Error fetching users for department {department_name}: {str(e)}")
        raise HTTPException(
            status_code=500,
            detail="Failed to fetch department users"
        )


@router.get("/departments")
@cache_response(ttl=300, vary_by_user=False, namespace="auth_departments")
async def get_all_departments(
    request: Request,
    db: Session = Depends(get_operational_db)
):
    """Get all unique departments"""
    try:
        departments = (
            db.query(User.department)
            .distinct()
            .filter(
                User.is_active == True,
                User.is_deleted == False,
                User.department != None,
            )
            .all()
        )

        dept_list = [dept[0] for dept in departments if dept[0]]

        return {
            "success": True,
            "departments": sorted(dept_list),
            "count": len(dept_list)
        }
    except Exception as e:
        print(f"Error fetching departments: {str(e)}")
        raise HTTPException(
            status_code=500,
            detail="Failed to fetch departments"
        )


@router.get("/employee-id/options")
async def get_employee_id_options(
    db: Session = Depends(get_operational_db),
    current_user: User = Depends(get_current_user)
):
    used = db.query(User.employee_id).filter(User.employee_id != None).order_by(User.employee_id.asc()).all()
    used_ids = [u[0] for u in used if u[0]]
    suggested = generate_employee_id(db)
    options = list(dict.fromkeys(([current_user.employee_id] if current_user.employee_id else []) + used_ids[-20:] + [suggested]))
    return {
        "success": True,
        "options": options,
        "suggested": suggested
    }


@router.post("/profile-change/request")
async def request_profile_change(
    payload: ProfileChangeRequestPayload,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_operational_db)
):
    existing_pending = db.query(UserApprovalRequest).filter(
        UserApprovalRequest.user_id == current_user.id,
        UserApprovalRequest.request_type == "profile_update",
        UserApprovalRequest.status == "pending"
    ).first()
    if existing_pending:
        raise HTTPException(status_code=400, detail="A profile change request is already pending approval")

    db.add(
        UserApprovalRequest(
            user_id=current_user.id,
            request_type="profile_update",
            status="pending",
            payload_json={
                "name": payload.name,
                "email": payload.email,
                "employee_id": payload.employee_id,
                "position": payload.position,
                "department": payload.department
            },
            created_at=datetime.utcnow()
        )
    )
    db.commit()
    created_request = db.query(UserApprovalRequest).filter(
        UserApprovalRequest.user_id == current_user.id,
        UserApprovalRequest.request_type == "profile_update",
        UserApprovalRequest.status == "pending",
    ).order_by(UserApprovalRequest.created_at.desc()).first()
    _push_admin_realtime_event(
        db,
        "admin_request_created",
        "New Profile Change Request",
        f"{current_user.name} requested a profile update.",
        {
            "requestType": "profile_update",
            "requestId": created_request.id if created_request else None,
            "userId": current_user.id,
            "userEmail": current_user.email,
            "userName": current_user.name,
        },
    )
    return {"success": True, "message": "Profile change request submitted for admin approval"}


@router.get("/profile-change/latest")
async def latest_profile_change_status(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_operational_db)
):
    req = _latest_user_request_by_type(db, current_user.id, "profile_update")
    if not req:
        return {"success": True, "request": None}
    return {
        "success": True,
        "request": {
            "id": req.id,
            "status": req.status,
            "payload": _sanitize_request_payload(req.request_type, req.payload_json),
            "createdAt": req.created_at.isoformat() if req.created_at else None,
            "reviewedAt": req.reviewed_at.isoformat() if req.reviewed_at else None,
            "reviewNotes": req.review_notes
        }
    }


@router.post("/password-change/request")
async def request_password_change(
    payload: PasswordChangeRequestPayload,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_operational_db)
):
    _create_password_change_request(db, current_user, payload.new_password)
    return {"success": True, "message": "Password change request submitted for admin approval"}


@router.get("/password-change/latest")
async def latest_password_change_status(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_operational_db)
):
    req = _latest_user_request_by_type(db, current_user.id, "password_change")
    if not req:
        return {"success": True, "request": None}
    return {
        "success": True,
        "request": {
            "id": req.id,
            "status": req.status,
            "payload": _sanitize_request_payload(req.request_type, req.payload_json),
            "createdAt": req.created_at.isoformat() if req.created_at else None,
            "reviewedAt": req.reviewed_at.isoformat() if req.reviewed_at else None,
            "reviewNotes": req.review_notes,
        },
    }


@router.get("/admin/pending-signups")
async def admin_pending_signups(
    current_user: User = Depends(require_admin),
    db: Session = Depends(get_operational_db)
):
    items = db.query(UserApprovalRequest).filter(
        UserApprovalRequest.request_type == "signup",
        UserApprovalRequest.status == "pending"
    ).order_by(UserApprovalRequest.created_at.asc()).all()
    return {
        "success": True,
        "count": len(items),
        "requests": [
            {
                "id": item.id,
                "userId": item.user_id,
                "payload": item.payload_json,
                "createdAt": item.created_at.isoformat() if item.created_at else None
            }
            for item in items
        ]
    }


@router.get("/admin/pending-profile-changes")
async def admin_pending_profile_changes(
    current_user: User = Depends(require_admin),
    db: Session = Depends(get_operational_db)
):
    items = db.query(UserApprovalRequest).filter(
        UserApprovalRequest.request_type == "profile_update",
        UserApprovalRequest.status == "pending"
    ).order_by(UserApprovalRequest.created_at.asc()).all()
    return {
        "success": True,
        "count": len(items),
        "requests": [
            {
                "id": item.id,
                "userId": item.user_id,
                "payload": item.payload_json,
                "createdAt": item.created_at.isoformat() if item.created_at else None
            }
            for item in items
        ]
    }


@router.get("/admin/pending-password-changes")
async def admin_pending_password_changes(
    current_user: User = Depends(require_admin),
    db: Session = Depends(get_operational_db)
):
    items = db.query(UserApprovalRequest).filter(
        UserApprovalRequest.request_type == "password_change",
        UserApprovalRequest.status == "pending"
    ).order_by(UserApprovalRequest.created_at.asc()).all()
    return {
        "success": True,
        "count": len(items),
        "requests": [
            {
                "id": item.id,
                "userId": item.user_id,
                "payload": _sanitize_request_payload(item.request_type, item.payload_json),
                "createdAt": item.created_at.isoformat() if item.created_at else None
            }
            for item in items
        ]
    }


@router.post("/admin/requests/{request_id}/review")
async def admin_review_request(
    request_id: int,
    decision: ApprovalDecision,
    current_user: User = Depends(require_admin),
    db: Session = Depends(get_operational_db)
):
    req = db.query(UserApprovalRequest).filter(UserApprovalRequest.id == request_id).first()
    if not req:
        raise HTTPException(status_code=404, detail="Approval request not found")
    if req.status != "pending":
        raise HTTPException(status_code=400, detail="Request already reviewed")

    user = db.query(User).filter(User.id == req.user_id).first()
    if not user:
        raise HTTPException(status_code=404, detail="User not found")

    req.status = "approved" if decision.approve else "rejected"
    req.reviewed_at = datetime.utcnow()
    req.reviewed_by = current_user.id
    req.review_notes = decision.notes

    if decision.approve:
        if req.request_type == "signup":
            user.is_active = True
            user.approved_at = datetime.utcnow()
            user.approved_by = current_user.id
        elif req.request_type == "profile_update":
            payload = req.payload_json or {}
            user.name = payload.get("name", user.name)
            user.email = payload.get("email", user.email)
            user.employee_id = payload.get("employee_id", user.employee_id)
            user.position = payload.get("position", user.position)
            user.department = payload.get("department", user.department)
        elif req.request_type == "password_change":
            payload = req.payload_json or {}
            password_hash = payload.get("password_hash")
            if not password_hash:
                raise HTTPException(status_code=400, detail="Password change request is missing password data")
            user.hashed_password = password_hash
            revoke_user_sessions(db, user.id)

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


@router.post("/logout", response_model=MessageResponse)
def logout(
    request: Request,
    response: Response, 
    session_id: Optional[str] = Cookie(None, alias="session_id"),
    x_session_id: Optional[str] = Header(None, alias="X-Session-Id"),
):
    """Logout user"""
    resolved_session_id = get_request_session_token(session_id, x_session_id)
    if resolved_session_id:
        invalidate_session(resolved_session_id)
    
    cookie_secure, cookie_samesite = _resolve_cookie_policy(request)

    response.delete_cookie(
        key="session_id",
        path="/",
        secure=cookie_secure,
        samesite=cookie_samesite,
    )
    return {"message": "Logged out successfully"}


@router.put("/password", response_model=MessageResponse)
def update_password(
    password_data: PasswordUpdate,
    response: Response,
    session_id: Optional[str] = Cookie(None, alias="session_id"),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_operational_db)
):
    """Submit a password change request for admin approval"""
    if not verify_password(password_data.current_password, current_user.hashed_password):
        raise HTTPException(status_code=400, detail="Current password is incorrect")

    _create_password_change_request(db, current_user, password_data.new_password)
    return {"message": "Password change request submitted for admin approval."}


@router.post("/forgot-password", response_model=MessageResponse)
def forgot_password(
    request: ForgotPasswordRequest, 
    db: Session = Depends(get_operational_db)
):
    """Request password reset"""
    user = db.query(User).filter(User.email == request.email).first()
    
    if user:
        token = create_reset_token(request.email)
        reset_link = f"http://localhost:5173/reset-password?token={token}"
        print(f"🔐 Password reset link: {reset_link}")
    
    return {"message": "If that email exists, we sent a password reset link"}


@router.post("/reset-password", response_model=MessageResponse)
def reset_password(
    request: ResetPasswordRequest, 
    db: Session = Depends(get_operational_db)
):
    """Reset password using token"""
    email = verify_reset_token(request.token)
    
    user = db.query(User).filter(User.email == email).first()
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    
    user.hashed_password = get_password_hash(request.new_password)
    revoke_user_sessions(db, user.id)
    db.commit()
    
    invalidate_reset_token(request.token)
    
    return {"message": "Password reset successfully"}
