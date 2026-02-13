# auth.py - Authentication Utilities ONLY (NO ROUTES)
from passlib.context import CryptContext
from datetime import datetime, timedelta
from typing import Optional
from sqlalchemy.orm import Session
import secrets

# Password hashing context
pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")

# In-memory storage
SESSION_STORE = {}
RESET_TOKEN_STORE = {}


# ==================== PASSWORD FUNCTIONS ====================
def get_password_hash(password: str) -> str:
    """Hash a password"""
    return pwd_context.hash(password)


def verify_password(plain_password: str, hashed_password: str) -> bool:
    """Verify password against hash"""
    return pwd_context.verify(plain_password, hashed_password)


def authenticate_user(db: Session, email: str, password: str):
    """Authenticate user with email and password"""
    from models_new import User
    
    user = db.query(User).filter(User.email == email).first()
    if not user:
        return None
    
    if not verify_password(password, user.hashed_password):
        return None
    
    return user


# ==================== SESSION TOKENS ====================
def create_session_token(user_id: int) -> str:
    """Create new session token"""
    token = secrets.token_urlsafe(32)
    SESSION_STORE[token] = {
        "user_id": user_id,
        "created_at": datetime.utcnow(),
        "expires_at": datetime.utcnow() + timedelta(days=30)
    }
    return token


def verify_session_token(token: str) -> int:
    """Verify session token and return user_id"""
    from fastapi import HTTPException
    
    if token not in SESSION_STORE:
        raise HTTPException(status_code=401, detail="Invalid session")
    
    session = SESSION_STORE[token]
    
    if datetime.utcnow() > session["expires_at"]:
        del SESSION_STORE[token]
        raise HTTPException(status_code=401, detail="Session expired")
    
    return session["user_id"]


def invalidate_session(token: str):
    """Remove session token"""
    if token in SESSION_STORE:
        del SESSION_STORE[token]


# ==================== RESET TOKENS ====================
def create_reset_token(email: str) -> str:
    """Create password reset token"""
    token = secrets.token_urlsafe(32)
    RESET_TOKEN_STORE[token] = {
        "email": email,
        "created_at": datetime.utcnow(),
        "expires_at": datetime.utcnow() + timedelta(hours=1)
    }
    return token


def verify_reset_token(token: str) -> str:
    """Verify reset token and return email"""
    from fastapi import HTTPException
    
    if token not in RESET_TOKEN_STORE:
        raise HTTPException(status_code=400, detail="Invalid token")
    
    reset_data = RESET_TOKEN_STORE[token]
    
    if datetime.utcnow() > reset_data["expires_at"]:
        del RESET_TOKEN_STORE[token]
        raise HTTPException(status_code=400, detail="Token expired")
    
    return reset_data["email"]


def invalidate_reset_token(token: str):
    """Remove reset token"""
    if token in RESET_TOKEN_STORE:
        del RESET_TOKEN_STORE[token]


# ==================== CLEANUP ====================
def cleanup_expired_sessions():
    """Remove expired sessions"""
    now = datetime.utcnow()
    expired = [token for token, data in SESSION_STORE.items() 
               if now > data["expires_at"]]
    for token in expired:
        del SESSION_STORE[token]
    return len(expired)


def cleanup_expired_reset_tokens():
    """Remove expired reset tokens"""
    now = datetime.utcnow()
    expired = [token for token, data in RESET_TOKEN_STORE.items() 
               if now > data["expires_at"]]
    for token in expired:
        del RESET_TOKEN_STORE[token]
    return len(expired)
