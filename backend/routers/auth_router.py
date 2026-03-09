# routers/auth_router.py - Authentication endpoints
from fastapi import APIRouter, Depends, HTTPException, Response, Cookie
from sqlalchemy.orm import Session
from typing import Optional, List
from datetime import datetime
from fastapi.responses import JSONResponse
from pydantic import BaseModel, EmailStr, Field, validator
import traceback
import os
from database_config import get_operational_db
from models_new import User, UserApprovalRequest
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
    verify_session_token,
    invalidate_session,
    verify_password,
    create_reset_token,
    verify_reset_token,
    invalidate_reset_token
)

router = APIRouter(prefix="/api/auth", tags=["Authentication"])

DEFAULT_ALLOWED_COMPANY_DOMAINS = (
    "@ritzmediaworld.com",
    "@ctm.co.in",
    "@rmwcreative.in",
    "@contenaissance.com",
)


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

# ==================== SCHEMAS ====================
class UserLogin(BaseModel):
    email: str
    password: str
    remember_me: bool = False

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

# ==================== HELPER FUNCTIONS ====================
def get_current_user(
    session_id: Optional[str] = Cookie(None, alias="session_id"),
    # response: Response,
    db: Session = Depends(get_operational_db)
):
    """Validate session and return current user"""
    if not session_id:
        raise HTTPException(status_code=401, detail="Not authenticated")
    
    user_id = verify_session_token(session_id)
    user = db.query(User).filter(User.id == user_id).first()
    
    if not user:
        raise HTTPException(status_code=401, detail="User not found")
    
    return user


def ensure_admin(current_user: User):
    if not (current_user.is_admin or ((current_user.position or "").lower() == "admin")):
        raise HTTPException(status_code=403, detail="Admin access required")


def generate_employee_id(db: Session) -> str:
    year = datetime.utcnow().year
    prefix = f"EMP-{year}-"
    count = db.query(User).filter(User.employee_id.like(f"{prefix}%")).count()
    return f"{prefix}{count + 1:04d}"


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
        
        # Check if user exists
        existing_user = db.query(User).filter(
            User.email == user_data.email
        ).first()
        
        if existing_user:
            raise HTTPException(
                status_code=400,
                detail="Email already registered"
            )
        
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
    credentials: UserLogin,
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

        is_production = (os.getenv("ENVIRONMENT", "").strip().lower() == "production")
        cookie_secure = (os.getenv("COOKIE_SECURE", "").strip().lower() in {"1", "true", "yes"}) or is_production
        cookie_samesite = (os.getenv("COOKIE_SAMESITE", "").strip().lower() or ("none" if cookie_secure else "lax"))
        if cookie_samesite not in {"lax", "strict", "none"}:
            cookie_samesite = "none" if cookie_secure else "lax"
        # Browsers reject SameSite=None cookies when Secure is false.
        if cookie_samesite == "none" and not cookie_secure:
            cookie_secure = True
        
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
            "user": {
                "id": user.id,
                "name": user.name,
                "email": user.email,
                "employeeId": user.employee_id,
                "position": user.position,
                "department": user.department,
                "avatar": user.avatar,
                "roles": user.roles_json or [],
                "isAdmin": user.is_admin
            }
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
    db: Session = Depends(get_operational_db)
):
    """Get current authenticated user"""
    if not session_id:
        raise HTTPException(status_code=401, detail="Not authenticated")
    
    try:
        user_id = verify_session_token(session_id)
        user = db.query(User).filter(User.id == user_id).first()
        
        if not user:
            raise HTTPException(status_code=404, detail="User not found")
        
        return {
            "success": True,
            "user": {
                "id": user.id,
                "name": user.name,
                "email": user.email,
                "employeeId": user.employee_id,
                "position": user.position,
                "department": user.department,
                "avatar": user.avatar,
                "roles": user.roles_json or [],
                "isAdmin": user.is_admin,
                "lastLogin": user.last_login.isoformat() if user.last_login else None
            }
        }
    except HTTPException:
        raise
    except Exception as e:
        print(f"❌ Error getting current user: {str(e)}")
        raise HTTPException(status_code=401, detail="Invalid session")


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
            User.is_active == True
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
async def get_all_departments(
    db: Session = Depends(get_operational_db)
):
    """Get all unique departments"""
    try:
        departments = db.query(User.department).distinct().filter(
            User.is_active == True,
            User.department != None
        ).all()
        
        dept_list = [dept[0] for dept in departments if dept[0]]
        
        return {
            "success": True,
            "departments": sorted(dept_list),
            "count": len(dept_list)
        }
    except Exception as e:
        print(f"❌ Error fetching departments: {str(e)}")
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
    return {"success": True, "message": "Profile change request submitted for admin approval"}


@router.get("/profile-change/latest")
async def latest_profile_change_status(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_operational_db)
):
    req = db.query(UserApprovalRequest).filter(
        UserApprovalRequest.user_id == current_user.id,
        UserApprovalRequest.request_type == "profile_update"
    ).order_by(UserApprovalRequest.created_at.desc()).first()
    if not req:
        return {"success": True, "request": None}
    return {
        "success": True,
        "request": {
            "id": req.id,
            "status": req.status,
            "payload": req.payload_json or {},
            "createdAt": req.created_at.isoformat() if req.created_at else None,
            "reviewedAt": req.reviewed_at.isoformat() if req.reviewed_at else None,
            "reviewNotes": req.review_notes
        }
    }


@router.get("/admin/pending-signups")
async def admin_pending_signups(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_operational_db)
):
    ensure_admin(current_user)
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
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_operational_db)
):
    ensure_admin(current_user)
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


@router.post("/admin/requests/{request_id}/review")
async def admin_review_request(
    request_id: int,
    decision: ApprovalDecision,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_operational_db)
):
    ensure_admin(current_user)
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

    db.commit()
    return {"success": True, "message": f"Request {req.status}"}


@router.post("/logout", response_model=MessageResponse)
def logout(
    response: Response, 
    session_id: Optional[str] = Cookie(None, alias="session_id")
):
    """Logout user"""
    if session_id:
        invalidate_session(session_id)
    
    is_production = (os.getenv("ENVIRONMENT", "").strip().lower() == "production")
    cookie_secure = (os.getenv("COOKIE_SECURE", "").strip().lower() in {"1", "true", "yes"}) or is_production
    cookie_samesite = (os.getenv("COOKIE_SAMESITE", "").strip().lower() or ("none" if cookie_secure else "lax"))
    if cookie_samesite == "none" and not cookie_secure:
        cookie_secure = True

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
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_operational_db)
):
    """Update user password"""
    if not verify_password(password_data.current_password, current_user.hashed_password):
        raise HTTPException(status_code=400, detail="Current password is incorrect")
    
    current_user.hashed_password = get_password_hash(password_data.new_password)
    db.commit()
    
    return {"message": "Password updated successfully"}


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
    db.commit()
    
    invalidate_reset_token(request.token)
    
    return {"message": "Password reset successfully"}
