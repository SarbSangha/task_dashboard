# auth.py - Authentication Utilities ONLY (NO ROUTES)
from passlib.context import CryptContext
from datetime import datetime, timedelta, timezone
from typing import Optional, Tuple
from sqlalchemy import func
from sqlalchemy.orm import Session
import hashlib
import json
import secrets
import os
import threading
import time
from fastapi import HTTPException, Cookie, Header
from itsdangerous import URLSafeTimedSerializer, BadSignature, SignatureExpired
from models_new import User

try:
    import redis
except ImportError:  # pragma: no cover - optional runtime dependency
    redis = None
# Password hashing context
pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")

# In-memory storage
SESSION_STORE = {}
RESET_TOKEN_STORE = {}
REVOKED_SESSION_STORE = {}
RESET_EMAIL_LATEST_DIGEST = {}

SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60
RESET_TOKEN_MAX_AGE_SECONDS = 60 * 60
_SESSION_SALT = "rmw-session-v1"  
_RESET_SALT = "rmw-reset-v1"
_REDIS_CLIENT = None
_REDIS_DISABLED = False
_REDIS_DISABLED_AT: Optional[float] = None
# A transient Redis blip must not permanently 500 every authenticated request
# for the rest of the process's life (see _get_redis_client) - retry after
# this cooldown instead of staying disabled until a manual restart. Short in
# production, where Redis is required and expected to be available (recover
# from a real blip fast). Much longer when Redis is merely optional (local
# dev without a Redis server running at all, the common case per
# backend/.env's REDIS_URL pointing at localhost) - otherwise every ~30s one
# request pays the full ~4s connect+ping timeout for a server that was never
# going to be there, which is what made "Unable to load IT tools" and similar
# pages intermittently stall for several seconds (confirmed live: localhost
# Redis was unreachable and AUTH_REQUIRE_REDIS was unset).
_REDIS_RECONNECT_COOLDOWN_SECONDS_REQUIRED = 30
_REDIS_RECONNECT_COOLDOWN_SECONDS_OPTIONAL = 600
# Non-blocking single-flight lock: once the cooldown elapses, many worker
# threads can notice at once (verified under load: 20 concurrent /me calls
# all reconnecting simultaneously drove P50 to ~7s, since "localhost" resolves
# to both ::1 and 127.0.0.1 and each failed attempt alone costs ~4s). Only the
# thread that acquires this lock actually retries; everyone else treats the
# state as still-disabled for this one call rather than piling on.
_REDIS_RECONNECT_LOCK = threading.Lock()


def _is_production() -> bool:
    environment = (os.getenv("ENVIRONMENT") or "").strip().lower()
    render_flag = (os.getenv("RENDER") or "").strip().lower()
    return environment == "production" or render_flag in {"1", "true", "yes", "on"}


def _redis_required() -> bool:
    raw = (os.getenv("AUTH_REQUIRE_REDIS") or "").strip().lower()
    if raw in {"0", "false", "no", "off"}:
        return False
    if raw in {"1", "true", "yes", "on"}:
        return True
    return _is_production()


def _memory_fallback_allowed() -> bool:
    return not _redis_required()


def _redis_reconnect_cooldown_seconds() -> float:
    return _REDIS_RECONNECT_COOLDOWN_SECONDS_REQUIRED if _redis_required() else _REDIS_RECONNECT_COOLDOWN_SECONDS_OPTIONAL


def _get_session_serializer() -> URLSafeTimedSerializer:
    secret_key = (os.getenv("SECRET_KEY") or "").strip()
    if not secret_key:
        if _is_production():
            raise RuntimeError("SECRET_KEY is required for production authentication.")
        # Fallback keeps local/dev usable only.
        secret_key = "rmw-dev-secret-key-change-me"
    return URLSafeTimedSerializer(secret_key=secret_key, salt=_SESSION_SALT)


def _get_reset_serializer() -> URLSafeTimedSerializer:
    secret_key = (os.getenv("SECRET_KEY") or "").strip()
    if not secret_key:
        if _is_production():
            raise RuntimeError("SECRET_KEY is required for production password resets.")
        secret_key = "rmw-dev-secret-key-change-me"
    return URLSafeTimedSerializer(secret_key=secret_key, salt=_RESET_SALT)


def _mark_redis_disabled() -> None:
    """Invalidate the cached client and start the reconnect cooldown.

    Called on any Redis failure - both an initial connect failure and a
    failure of an already-established client mid-use - so a stale/dead
    client is never reused indefinitely and a transient outage recovers on
    its own once the cooldown elapses, instead of requiring a restart.
    """
    global _REDIS_CLIENT, _REDIS_DISABLED, _REDIS_DISABLED_AT
    _REDIS_DISABLED = True
    _REDIS_DISABLED_AT = time.monotonic()
    _REDIS_CLIENT = None


def _connect_redis_locked():
    """Perform the actual (slow) connect+ping. Caller must hold _REDIS_RECONNECT_LOCK
    for this entire call, not just the state toggle around it - a released lock
    during the connection attempt itself would let other threads slip through
    and pile on for its full 2-4s duration (verified under load)."""
    global _REDIS_CLIENT
    redis_url = (os.getenv("REDIS_URL") or "").strip()
    if not redis_url:
        if _redis_required():
            raise RuntimeError("REDIS_URL is required for production authentication state.")
        _mark_redis_disabled()
        return None
    try:
        client = redis.Redis.from_url(
            redis_url,
            decode_responses=True,
            socket_connect_timeout=2,
            socket_timeout=2,
        )
        client.ping()
        _REDIS_CLIENT = client
        return _REDIS_CLIENT
    except Exception:
        _mark_redis_disabled()
        if _redis_required():
            raise
        return None


def _get_redis_client():
    global _REDIS_DISABLED
    if redis is None:
        if _redis_required():
            raise RuntimeError("Redis package is required for production authentication state.")
        return None
    if _REDIS_CLIENT is not None:
        return _REDIS_CLIENT
    if _REDIS_DISABLED:
        cooldown_elapsed = (
            _REDIS_DISABLED_AT is not None
            and (time.monotonic() - _REDIS_DISABLED_AT) >= _redis_reconnect_cooldown_seconds()
        )
        if not cooldown_elapsed:
            if _redis_required():
                raise RuntimeError("Redis authentication state is disabled after a connection failure.")
            return None
    # No client yet - either this is the very first attempt, or a prior
    # failure's cooldown just elapsed. Either way, at most one thread should
    # pay the connect cost. Non-blocking acquire, held for the *entire*
    # connect+ping attempt: whichever thread gets here first does the real
    # work; every other concurrent caller just treats this one call as
    # unavailable instead of also attempting to connect (verified under load:
    # without holding the lock across the full attempt, 20 concurrent callers
    # each independently paid the ~4s connect cost, driving P50 to ~7s).
    if not _REDIS_RECONNECT_LOCK.acquire(blocking=False):
        if _redis_required():
            raise RuntimeError("Redis authentication state is disabled after a connection failure.")
        return None
    try:
        if _REDIS_CLIENT is not None:
            # Another thread already won the race and connected before we
            # acquired the lock.
            return _REDIS_CLIENT
        _REDIS_DISABLED = False
        return _connect_redis_locked()
    finally:
        _REDIS_RECONNECT_LOCK.release()


def _redis_setex(key: str, ttl: int, value: str) -> None:
    client = _get_redis_client()
    if client is None:
        return
    try:
        client.setex(key, ttl, value)
    except Exception:
        _mark_redis_disabled()


def _redis_get(key: str) -> Optional[str]:
    client = _get_redis_client()
    if client is None:
        return None
    try:
        return client.get(key)
    except Exception:
        _mark_redis_disabled()
        return None


def _redis_delete(*keys: str) -> None:
    client = _get_redis_client()
    if client is None or not keys:
        return
    try:
        client.delete(*keys)
    except Exception:
        _mark_redis_disabled()


def _token_digest(token: str) -> str:
    return hashlib.sha256((token or "").encode("utf-8")).hexdigest()


def _session_key(token: str) -> str:
    return f"auth:session:{_token_digest(token)}"


def _revoked_key(token: str) -> str:
    return f"auth:revoked-session:{_token_digest(token)}"


def _reset_key(token: str) -> str:
    return f"auth:reset-token:{_token_digest(token)}"


def _reset_latest_key(email: str) -> str:
    return f"auth:reset-latest:{hashlib.sha256((email or '').strip().lower().encode('utf-8')).hexdigest()}"


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
    row = db.query(User.session_revoked_at).filter(User.id == user_id).first()
    revoked_at = _normalize_to_utc_naive(row[0]) if row else None
    if revoked_at and issued_at <= revoked_at:
        raise HTTPException(status_code=401, detail="Session revoked")


# ==================== PASSWORD FUNCTIONS ====================
def _password_digest(password: str) -> str:
    """Hash arbitrary-length passwords before bcrypt's 72-byte input limit."""
    return hashlib.sha256(password.encode("utf-8")).hexdigest()


def get_password_hash(password: str) -> str:
    """Hash a password without losing entropy past bcrypt's 72-byte limit."""
    return pwd_context.hash(_password_digest(password))



def verify_password(plain_password: str, hashed_password: str) -> bool:
    """Verify current SHA256+bcrypt hashes and legacy direct-bcrypt hashes."""
    if pwd_context.verify(_password_digest(plain_password), hashed_password):
        return True

    # Backward compatibility for existing hashes created before pre-hashing.
    password_bytes = plain_password.encode("utf-8")
    legacy_password = plain_password
    if len(password_bytes) > 72:
        legacy_password = password_bytes[:72].decode("utf-8", errors="ignore")
    return pwd_context.verify(legacy_password, hashed_password)

def authenticate_user(db: Session, email: str, password: str):
    """Authenticate user with email and password"""
    from models_new import User

    normalized_email = (email or "").strip().lower()
    user = db.query(User).filter(
        func.lower(func.trim(User.email)) == normalized_email
    ).first()
    if not user:
        return None
    
    if not verify_password(password, user.hashed_password):
        return None
    
    return user


# ==================== SESSION TOKENS ====================
def create_session_fingerprint(user_agent: Optional[str]) -> str:
    normalized = (user_agent or "").strip().lower()
    return hashlib.sha256(normalized.encode("utf-8")).hexdigest()


def _validate_session_fingerprint(
    token_fingerprint: Optional[str],
    expected_fingerprint: Optional[str],
) -> None:
    if token_fingerprint and expected_fingerprint and token_fingerprint != expected_fingerprint:
        raise HTTPException(status_code=401, detail="Session device mismatch")


def create_session_token(user_id: int, session_fingerprint: Optional[str] = None) -> str:
    """Create new session token"""
    serializer = _get_session_serializer()
    created_at = datetime.utcnow()
    token = serializer.dumps(
        {
            "user_id": int(user_id),
            "nonce": secrets.token_urlsafe(12),
            "session_fingerprint": session_fingerprint,
        }
    )
    if _memory_fallback_allowed():
        SESSION_STORE[token] = {
            "user_id": user_id,
            "created_at": created_at,
            "expires_at": created_at + timedelta(days=30),
            "session_fingerprint": session_fingerprint,
        }
    _redis_setex(
        _session_key(token),
        SESSION_MAX_AGE_SECONDS,
        json.dumps(
            {
                "user_id": int(user_id),
                "created_at": created_at.isoformat(),
                "session_fingerprint": session_fingerprint,
            }
        ),
    )
    return token


def _decode_session_token(token: str) -> Tuple[int, Optional[datetime], Optional[str]]:
    if _memory_fallback_allowed():
        revoked = REVOKED_SESSION_STORE.get(token)
        if revoked and datetime.utcnow() <= revoked["expires_at"]:
            raise HTTPException(status_code=401, detail="Session revoked")
        if revoked:
            REVOKED_SESSION_STORE.pop(token, None)

    if _redis_get(_revoked_key(token)):
        raise HTTPException(status_code=401, detail="Session revoked")
    
    # Fast path for local in-process sessions
    if _memory_fallback_allowed():
        session = SESSION_STORE.get(token)
        if session:
            if datetime.utcnow() > session["expires_at"]:
                SESSION_STORE.pop(token, None)
                raise HTTPException(status_code=401, detail="Session expired")
            return int(session["user_id"]), session.get("created_at"), session.get("session_fingerprint")

    redis_session = _redis_get(_session_key(token))
    if redis_session:
        try:
            data = json.loads(redis_session)
            created_at = data.get("created_at")
            return (
                int(data.get("user_id")),
                datetime.fromisoformat(created_at) if created_at else None,
                data.get("session_fingerprint"),
            )
        except (TypeError, ValueError, json.JSONDecodeError):
            _redis_delete(_session_key(token))

    # Cross-process fallback for production (stateless signed token)
    serializer = _get_session_serializer()
    try:
        payload, issued_at = serializer.loads(
            token,
            max_age=SESSION_MAX_AGE_SECONDS,
            return_timestamp=True,
        )
        return (
            int(payload.get("user_id")),
            _normalize_to_utc_naive(issued_at),
            payload.get("session_fingerprint"),
        )
    except SignatureExpired:
        raise HTTPException(status_code=401, detail="Session expired")
    except (BadSignature, TypeError, ValueError):
        raise HTTPException(status_code=401, detail="Invalid session")


def verify_session_token(
    token: str,
    db: Optional[Session] = None,
    session_fingerprint: Optional[str] = None,
) -> int:
    """Verify session token and return user_id."""
    user_id, issued_at, token_fingerprint = _decode_session_token(token)
    _validate_session_fingerprint(token_fingerprint, session_fingerprint)
    _ensure_user_session_not_revoked(db, user_id, issued_at)
    return user_id


def resolve_session_user(
    token: str,
    db: Session,
    *,
    session_fingerprint: Optional[str] = None,
    allow_deleted: bool = False,
    raise_on_missing: bool = True,
) -> Optional[User]:
    """Resolve a signed session to a user with one database lookup."""
    user_id, issued_at, token_fingerprint = _decode_session_token(token)
    _validate_session_fingerprint(token_fingerprint, session_fingerprint)
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
    # Prefer the explicit dashboard token over cookies. This prevents a stale
    # browser cookie from overriding the current tab/profile's stored session.
    token = (x_session_id or "").strip()
    if token:
        return token
    token = (session_id or "").strip()
    return token or None


def invalidate_session(token: str):
    """Remove session token"""
    SESSION_STORE.pop(token, None)
    _redis_delete(_session_key(token))
    if _memory_fallback_allowed():
        REVOKED_SESSION_STORE[token] = {
            "expires_at": datetime.utcnow() + timedelta(seconds=SESSION_MAX_AGE_SECONDS)
        }
    _redis_setex(_revoked_key(token), SESSION_MAX_AGE_SECONDS, "1")


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
        SESSION_STORE.pop(token, None)
        if _memory_fallback_allowed():
            REVOKED_SESSION_STORE[token] = {
                "expires_at": effective_revoked_at + timedelta(seconds=SESSION_MAX_AGE_SECONDS)
            }
        _redis_delete(_session_key(token))
        _redis_setex(_revoked_key(token), SESSION_MAX_AGE_SECONDS, "1")

    return effective_revoked_at


# ==================== RESET TOKENS ====================
def create_reset_token(email: str) -> str:
    """Create password reset token"""
    created_at = datetime.utcnow()
    normalized_email = (email or "").strip().lower()
    token = _get_reset_serializer().dumps(
        {
            "email": normalized_email,
            "nonce": secrets.token_urlsafe(12),
        }
    )
    token_digest = _token_digest(token)
    if _memory_fallback_allowed():
        RESET_TOKEN_STORE[token] = {
            "email": normalized_email,
            "created_at": created_at,
            "expires_at": created_at + timedelta(seconds=RESET_TOKEN_MAX_AGE_SECONDS),
            "digest": token_digest,
        }
        RESET_EMAIL_LATEST_DIGEST[normalized_email] = {
            "digest": token_digest,
            "expires_at": created_at + timedelta(seconds=RESET_TOKEN_MAX_AGE_SECONDS),
        }
    _redis_setex(
        _reset_key(token),
        RESET_TOKEN_MAX_AGE_SECONDS,
        json.dumps({"email": normalized_email, "created_at": created_at.isoformat(), "digest": token_digest}),
    )
    _redis_setex(_reset_latest_key(normalized_email), RESET_TOKEN_MAX_AGE_SECONDS, token_digest)
    return token


def _ensure_latest_reset_token(email: str, token: str) -> None:
    normalized_email = (email or "").strip().lower()
    token_digest = _token_digest(token)
    latest_digest = _redis_get(_reset_latest_key(normalized_email))
    if latest_digest is None and _memory_fallback_allowed():
        latest = RESET_EMAIL_LATEST_DIGEST.get(normalized_email)
        if latest and datetime.utcnow() <= latest["expires_at"]:
            latest_digest = latest.get("digest")
        elif latest:
            RESET_EMAIL_LATEST_DIGEST.pop(normalized_email, None)
    if latest_digest and latest_digest != token_digest:
        raise HTTPException(status_code=400, detail="Token superseded")


def verify_reset_token(token: str) -> str:
    """Verify reset token and return email"""
    if _memory_fallback_allowed():
        reset_data = RESET_TOKEN_STORE.get(token)
        if reset_data:
            if datetime.utcnow() > reset_data["expires_at"]:
                RESET_TOKEN_STORE.pop(token, None)
                _redis_delete(_reset_key(token))
                raise HTTPException(status_code=400, detail="Token expired")
            email = reset_data["email"]
            _ensure_latest_reset_token(email, token)
            return email

    reset_key = _reset_key(token)
    redis_reset = _redis_get(reset_key)
    if redis_reset:
        try:
            data = json.loads(redis_reset)
            email = (data.get("email") or "").strip()
            if email:
                _ensure_latest_reset_token(email, token)
                return email
        except (TypeError, json.JSONDecodeError):
            _redis_delete(reset_key)

    if _get_redis_client() is not None:
        raise HTTPException(status_code=400, detail="Invalid token")

    try:
        payload = _get_reset_serializer().loads(token, max_age=RESET_TOKEN_MAX_AGE_SECONDS)
        email = (payload.get("email") or "").strip()
        if not email:
            raise ValueError("Missing reset email")
        _ensure_latest_reset_token(email, token)
        return email
    except SignatureExpired:
        raise HTTPException(status_code=400, detail="Token expired")
    except (BadSignature, TypeError, ValueError):
        raise HTTPException(status_code=400, detail="Invalid token")


def invalidate_reset_token(token: str):
    """Remove reset token"""
    email = ""
    entry = RESET_TOKEN_STORE.pop(token, None)
    if entry:
        email = (entry.get("email") or "").strip().lower()
        latest = RESET_EMAIL_LATEST_DIGEST.get(email)
        if latest and latest.get("digest") == _token_digest(token):
            RESET_EMAIL_LATEST_DIGEST.pop(email, None)
    else:
        redis_reset = _redis_get(_reset_key(token))
        if redis_reset:
            try:
                data = json.loads(redis_reset)
                email = (data.get("email") or "").strip().lower()
            except (TypeError, json.JSONDecodeError):
                email = ""
    if email:
        latest_key = _reset_latest_key(email)
        latest_digest = _redis_get(latest_key)
        if latest_digest == _token_digest(token):
            _redis_delete(latest_key)
    _redis_delete(_reset_key(token))


# ==================== CLEANUP ====================
def cleanup_expired_sessions():
    """Remove expired sessions"""
    now = datetime.utcnow()
    expired = [token for token, data in SESSION_STORE.items()
               if now > data["expires_at"]]
    for token in expired:
        SESSION_STORE.pop(token, None)

    expired_revoked = [token for token, data in REVOKED_SESSION_STORE.items()
                       if now > data["expires_at"]]
    for token in expired_revoked:
        REVOKED_SESSION_STORE.pop(token, None)

    return len(expired)


def cleanup_expired_reset_tokens():
    """Remove expired reset tokens"""
    now = datetime.utcnow()
    expired = [token for token, data in RESET_TOKEN_STORE.items()
               if now > data["expires_at"]]
    for token in expired:
        RESET_TOKEN_STORE.pop(token, None)
    expired_latest = [
        email for email, data in RESET_EMAIL_LATEST_DIGEST.items()
        if now > data["expires_at"]
    ]
    for email in expired_latest:
        RESET_EMAIL_LATEST_DIGEST.pop(email, None)
    return len(expired)
