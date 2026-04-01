# auth.py - Authentication Utilities ONLY (NO ROUTES)
from passlib.context import CryptContext
from datetime import datetime, timedelta, timezone
from typing import Optional, Tuple
from sqlalchemy.orm import Session
import secrets
import os
from fastapi import APIRouter, HTTPException, Depends, Response, Cookie, Header
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


def _normalize_to_utc_naive(value: Optional[datetime]) -> Optional[datetime]:
    if not value:
        return None
    if value.tzinfo is not None and value.tzinfo.utcoffset(value) is not None:
        return value.astimezone(timezone.utc).replace(tzinfo=None)
    return value


def _ensure_session_not_revoked_for_user(user: Optional[User], issued_at: Optional[datetime]) -> None:
    if user is None or issued_at is None:
        return
    revoked_at = _normalize_to_utc_naive(user.session_revoked_at)
    if revoked_at and issued_at <= revoked_at:
        raise HTTPException(status_code=401, detail="Session revoked")


def _ensure_user_session_not_revoked(db: Optional[Session], user_id: int, issued_at: Optional[datetime]) -> None:
    if db is None or issued_at is None:
        return
    user = db.query(User).filter(User.id == user_id).first()
    _ensure_session_not_revoked_for_user(user, issued_at)


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
    created_at = datetime.utcnow()
    token = serializer.dumps(
        {
            "user_id": int(user_id),
            "nonce": secrets.token_urlsafe(12),
        }
    )
    SESSION_STORE[token] = {
        "user_id": user_id,
        "created_at": created_at,
        "expires_at": created_at + timedelta(days=30)
    }
    return token


def _decode_session_token(token: str) -> Tuple[int, Optional[datetime]]:
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
        return int(session["user_id"]), session.get("created_at")

    # Cross-process fallback for production (stateless signed token)
    serializer = _get_session_serializer()
    try:
        payload, issued_at = serializer.loads(
            token,
            max_age=SESSION_MAX_AGE_SECONDS,
            return_timestamp=True,
        )
        return int(payload.get("user_id")), _normalize_to_utc_naive(issued_at)
    except SignatureExpired:
        raise HTTPException(status_code=401, detail="Session expired")
    except (BadSignature, TypeError, ValueError):
        raise HTTPException(status_code=401, detail="Invalid session")


def verify_session_token(token: str, db: Optional[Session] = None) -> int:
    """Verify session token and return user_id."""
    user_id, issued_at = _decode_session_token(token)
    _ensure_user_session_not_revoked(db, user_id, issued_at)
    return user_id


def resolve_session_user(
    token: str,
    db: Session,
    *,
    allow_deleted: bool = False,
    raise_on_missing: bool = True,
) -> Optional[User]:
    """Resolve a signed session to a user with one database lookup."""
    user_id, issued_at = _decode_session_token(token)
    user = db.query(User).filter(User.id == user_id).first()

    if not user:
        if raise_on_missing:
            raise HTTPException(status_code=401, detail="User not found")
        return None

    _ensure_session_not_revoked_for_user(user, issued_at)

    if not allow_deleted and user.is_deleted:
        raise HTTPException(status_code=401, detail="Account has been deleted")

    return user


def get_request_session_token(
    session_id: Optional[str] = Cookie(None, alias="session_id"),
    x_session_id: Optional[str] = Header(None, alias="X-Session-Id"),
) -> Optional[str]:
    token = (session_id or "").strip()
    if token:
        return token
    token = (x_session_id or "").strip()
    return token or None


def invalidate_session(token: str):
    """Remove session token"""
    if token in SESSION_STORE:
        del SESSION_STORE[token]
    REVOKED_SESSION_STORE[token] = {
        "expires_at": datetime.utcnow() + timedelta(seconds=SESSION_MAX_AGE_SECONDS)
    }


def revoke_user_sessions(db: Session, user_id: int, revoked_at: Optional[datetime] = None) -> datetime:
    """Persistently revoke all sessions for a user."""
    user = db.query(User).filter(User.id == user_id).first()
    if not user:
        raise HTTPException(status_code=404, detail="User not found")

    effective_revoked_at = revoked_at or datetime.utcnow()
    user.session_revoked_at = effective_revoked_at

    for token, data in list(SESSION_STORE.items()):
        if int(data.get("user_id") or 0) != int(user_id):
            continue
        del SESSION_STORE[token]
        REVOKED_SESSION_STORE[token] = {
            "expires_at": effective_revoked_at + timedelta(seconds=SESSION_MAX_AGE_SECONDS)
        }

    return effective_revoked_at


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
