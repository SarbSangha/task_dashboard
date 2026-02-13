# routers/auth_router.py - Authentication endpoints
from fastapi import APIRouter, Depends, HTTPException, Response, Cookie
from sqlalchemy.orm import Session
from typing import Optional
from datetime import datetime

from database_config import get_operational_db
from models_new import User
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


# ==================== HELPER FUNCTIONS ====================
def get_current_user(
    session_id: Optional[str] = Cookie(None, alias="session_id"),
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


# ==================== AUTH ENDPOINTS ====================
@router.post("/register", response_model=UserResponse)
def register(
    user_data: UserCreate, 
    response: Response, 
    db: Session = Depends(get_operational_db)
):
    """Register a new user"""
    existing_user = db.query(User).filter(User.email == user_data.email).first()
    if existing_user:
        raise HTTPException(status_code=400, detail="Email already registered")
    
    new_user = User(
        email=user_data.email,
        name=user_data.name,
        hashed_password=get_password_hash(user_data.password),
        position=user_data.position,
        department=user_data.department if hasattr(user_data, 'department') else None
    )
    db.add(new_user)
    db.commit()
    db.refresh(new_user)
    
    session_id = create_session_token(new_user.id)
    
    response.set_cookie(
        key="session_id",
        value=session_id,
        httponly=True,
        secure=False,
        samesite="lax",
        max_age=30 * 24 * 60 * 60,
        path="/"
    )
    
    print(f"✅ New user registered: {new_user.email}")
    return new_user


@router.post("/login", response_model=UserResponse)
def login(
    credentials: UserLoginExtended, 
    response: Response, 
    db: Session = Depends(get_operational_db)
):
    """Login user"""
    print(f"\n{'='*50}")
    print(f"🔐 LOGIN ATTEMPT: {credentials.email}")
    
    user = authenticate_user(db, credentials.email, credentials.password)
    
    if not user:
        print(f"❌ Authentication failed")
        raise HTTPException(status_code=401, detail="Invalid email or password")
    
    user.last_login = datetime.utcnow()
    db.commit()
    
    session_id = create_session_token(user.id)
    max_age = 30 * 24 * 60 * 60 if credentials.remember_me else 24 * 60 * 60
    
    response.set_cookie(
        key="session_id",
        value=session_id,
        httponly=True,
        secure=False,
        samesite="lax",
        max_age=max_age,
        path="/"
    )
    
    print(f"✅ User authenticated: {user.email}")
    print(f"{'='*50}\n")
    
    return user


@router.get("/me", response_model=UserResponse)
def get_me(current_user: User = Depends(get_current_user)):
    """Get current logged-in user"""
    return current_user


@router.post("/logout", response_model=MessageResponse)
def logout(
    response: Response, 
    session_id: Optional[str] = Cookie(None, alias="session_id")
):
    """Logout user"""
    if session_id:
        invalidate_session(session_id)
    
    response.delete_cookie(key="session_id", path="/")
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
