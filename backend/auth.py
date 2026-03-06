# auth.py - Authentication Utilities ONLY (NO ROUTES)
from passlib.context import CryptContext
from datetime import datetime, timedelta
from typing import Optional
from sqlalchemy.orm import Session
import secrets
import os
from fastapi import APIRouter, HTTPException, Depends, Response, Cookie
from itsdangerous import URLSafeTimedSerializer, BadSignature, SignatureExpired
from database_config import get_operational_db
from models_new import User
# Password hashing context
pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")

# In-memory storage
SESSION_STORE = {}
RESET_TOKEN_STORE = {}
REVOKED_SESSION_STORE = {}

SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60
_SESSION_SALT = "rmw-session-v1"


def _get_session_serializer() -> URLSafeTimedSerializer:
    secret_key = (os.getenv("SECRET_KEY") or "").strip()
    if not secret_key:
        # Fallback keeps local/dev usable, but production should always set SECRET_KEY.
        secret_key = "rmw-dev-secret-key-change-me"
    return URLSafeTimedSerializer(secret_key=secret_key, salt=_SESSION_SALT)


# ==================== PASSWORD FUNCTIONS ====================
# backend/auth.py - UPDATE THIS FUNCTION

def get_password_hash(password: str) -> str:
    """Hash a password - handles bcrypt 72 byte limit"""
    # Bcrypt has a 72 byte maximum
    # Encode to bytes and truncate if needed
    password_bytes = password.encode('utf-8')
    
    if len(password_bytes) > 72:
        # Truncate to 72 bytes
        password = password_bytes[:72].decode('utf-8', errors='ignore')
    
    return pwd_context.hash(password)



def verify_password(plain_password: str, hashed_password: str) -> bool:
    """Verify password against hash - handles bcrypt 72 byte limit"""
    # Bcrypt has a 72 byte maximum
    password_bytes = plain_password.encode('utf-8')
    
    if len(password_bytes) > 72:
        # Truncate to 72 bytes
        plain_password = password_bytes[:72].decode('utf-8', errors='ignore')
    
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
    serializer = _get_session_serializer()
    token = serializer.dumps(
        {
            "user_id": int(user_id),
            "nonce": secrets.token_urlsafe(12),
        }
    )
    SESSION_STORE[token] = {
        "user_id": user_id,
        "created_at": datetime.utcnow(),
        "expires_at": datetime.utcnow() + timedelta(days=30)
    }
    return token


def verify_session_token(token: str) -> int:
    """Verify session token and return user_id"""
    from fastapi import HTTPException

    revoked = REVOKED_SESSION_STORE.get(token)
    if revoked and datetime.utcnow() <= revoked["expires_at"]:
        raise HTTPException(status_code=401, detail="Session revoked")
    if revoked:
        del REVOKED_SESSION_STORE[token]
    
    # Fast path for local in-process sessions
    session = SESSION_STORE.get(token)
    if session:
        if datetime.utcnow() > session["expires_at"]:
            del SESSION_STORE[token]
            raise HTTPException(status_code=401, detail="Session expired")
        return session["user_id"]

    # Cross-process fallback for production (stateless signed token)
    serializer = _get_session_serializer()
    try:
        payload = serializer.loads(token, max_age=SESSION_MAX_AGE_SECONDS)
        user_id = int(payload.get("user_id"))
        return user_id
    except SignatureExpired:
        raise HTTPException(status_code=401, detail="Session expired")
    except (BadSignature, TypeError, ValueError):
        raise HTTPException(status_code=401, detail="Invalid session")


def invalidate_session(token: str):
    """Remove session token"""
    if token in SESSION_STORE:
        del SESSION_STORE[token]
    REVOKED_SESSION_STORE[token] = {
        "expires_at": datetime.utcnow() + timedelta(seconds=SESSION_MAX_AGE_SECONDS)
    }


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

    expired_revoked = [token for token, data in REVOKED_SESSION_STORE.items()
                       if now > data["expires_at"]]
    for token in expired_revoked:
        del REVOKED_SESSION_STORE[token]

    return len(expired)


def cleanup_expired_reset_tokens():
    """Remove expired reset tokens"""
    now = datetime.utcnow()
    expired = [token for token, data in RESET_TOKEN_STORE.items() 
               if now > data["expires_at"]]
    for token in expired:
        del RESET_TOKEN_STORE[token]
    return len(expired)
