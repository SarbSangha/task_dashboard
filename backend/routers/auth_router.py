# routers/auth_router.py - Authentication endpoints
import hashlib
import json
import base64
import logging
import smtplib
import ssl
from email.message import EmailMessage
from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Response, Cookie, Request, Header
from sqlalchemy import func, or_, text
from sqlalchemy.exc import IntegrityError, SQLAlchemyError
from sqlalchemy.orm import Session
from typing import Optional, List
from datetime import datetime, timedelta
from time import monotonic as _monotonic
from fastapi.responses import JSONResponse
from pydantic import BaseModel, EmailStr, Field, validator
import os
from urllib.parse import urlparse
from database_config import get_operational_db
from models_new import DepartmentDirectory, PendingPasswordChange, User, UserApprovalRequest, UserRole
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
    create_session_fingerprint,
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
from utils import cache as cache_utils
from services.admin_workflow_service import (
    pending_password_change_for_request,
    push_admin_realtime_event,
    sanitize_request_payload,
)
from services.role_service import normalize_roles, replace_user_roles, user_role_names


KNOWN_DEPARTMENTS = (
    "CREATIVE",
    "CONTENT",
    "CONTENT CREATOR",
    "CRACK TEAM",
    "DIGITAL",
    "GEN AI",
    "INTERNAL BRANDS",
    "3D Visualizer",
)
from utils.cache import cache_response
from utils.permissions import has_any_role, require_admin

router = APIRouter(prefix="/api/auth", tags=["Authentication"])
logger = logging.getLogger(__name__)

DEFAULT_ALLOWED_COMPANY_DOMAINS = (
    "@ritzmediaworld.com",
    "@ctm.co.in",
    "@rmwcreative.in",
    "@contenaissance.com",
)

_LOGIN_RATE_LIMIT_CACHE: dict[str, tuple[int, float]] = {}
_DUMMY_PASSWORD_HASH: Optional[str] = None


def _int_env(name: str, default: int) -> int:
    raw = (os.getenv(name) or "").strip()
    if not raw:
        return default
    try:
        return int(raw)
    except ValueError:
        return default


def _is_production_auth() -> bool:
    environment = (os.getenv("ENVIRONMENT") or "").strip().lower()
    render_flag = (os.getenv("RENDER") or "").strip().lower()
    return environment == "production" or render_flag in {"1", "true", "yes", "on"}


def _auth_requires_redis() -> bool:
    raw = (os.getenv("AUTH_REQUIRE_REDIS") or "").strip().lower()
    if raw in {"0", "false", "no", "off"}:
        return False
    if raw in {"1", "true", "yes", "on"}:
        return True
    return _is_production_auth()


_LOGIN_RATE_LIMIT_ATTEMPTS = max(1, _int_env("LOGIN_RATE_LIMIT_ATTEMPTS", 5))
_LOGIN_RATE_LIMIT_WINDOW_SECONDS = max(10, _int_env("LOGIN_RATE_LIMIT_WINDOW_SECONDS", 60))
_FORGOT_PASSWORD_RATE_LIMIT_ATTEMPTS = max(1, _int_env("FORGOT_PASSWORD_RATE_LIMIT_ATTEMPTS", 3))
_FORGOT_PASSWORD_RATE_LIMIT_WINDOW_SECONDS = max(60, _int_env("FORGOT_PASSWORD_RATE_LIMIT_WINDOW_SECONDS", 300))
_AUTH_RESPONSE_CACHE_TTL_SECONDS = max(0, _int_env("AUTH_RESPONSE_CACHE_TTL_SECONDS", 10))
_AUTH_RESPONSE_CACHE: dict[str, tuple[dict, float]] = {}


def _ascii_safe_text(value: object) -> str:
    return f"{value}".encode("ascii", "backslashreplace").decode("ascii")


def _log_exception(prefix: str, exc: Exception) -> None:
    logger.exception("%s: %s", prefix, _ascii_safe_text(exc))


def _safe_log(message: str) -> None:
    logger.info("%s", _ascii_safe_text(message))


def _cleanup_local_auth_caches() -> None:
    now = _monotonic()
    expired_login_keys = [
        key for key, (_attempts, expires_at) in _LOGIN_RATE_LIMIT_CACHE.items()
        if expires_at <= now
    ]
    for key in expired_login_keys:
        _LOGIN_RATE_LIMIT_CACHE.pop(key, None)

    expired_auth_keys = [
        key for key, (_value, expires_at) in _AUTH_RESPONSE_CACHE.items()
        if expires_at <= now
    ]
    for key in expired_auth_keys:
        _AUTH_RESPONSE_CACHE.pop(key, None)


def _fake_password_verify_for_timing(password: str) -> None:
    global _DUMMY_PASSWORD_HASH
    if _DUMMY_PASSWORD_HASH is None:
        _DUMMY_PASSWORD_HASH = get_password_hash("rmw-auth-dummy-password")
    verify_password(password, _DUMMY_PASSWORD_HASH)


def _request_ip(request: Request) -> str:
    forwarded_for = (request.headers.get("x-forwarded-for") or "").split(",")[0].strip()
    return forwarded_for or (request.client.host if request.client else "unknown")


def _login_rate_limit_key(email: str, request: Request) -> str:
    normalized = f"{email or ''}".strip().lower()
    raw_key = f"{_request_ip(request)}:{normalized}"
    digest = hashlib.sha256(raw_key.encode("utf-8")).hexdigest()[:24]
    return f"auth:login-rate:{digest}"


def _forgot_password_rate_limit_key(email: str, request: Request) -> str:
    normalized = f"{email or ''}".strip().lower()
    raw_key = f"forgot:{_request_ip(request)}:{normalized}"
    digest = hashlib.sha256(raw_key.encode("utf-8")).hexdigest()[:24]
    return f"auth:forgot-password-rate:{digest}"


async def _check_simple_rate_limit(
    key: str,
    *,
    attempts_limit: int,
    window_seconds: int,
    local_cache: dict[str, tuple[int, float]],
    message: str,
) -> None:
    redis_client = cache_utils.redis_client
    if redis_client is not None:
        try:
            attempts = await redis_client.incr(key)
            if attempts == 1:
                await redis_client.expire(key, window_seconds)
            if attempts > attempts_limit:
                raise HTTPException(status_code=429, detail=message)
            return
        except HTTPException:
            raise
        except Exception as exc:
            _safe_log(f"Rate-limit Redis error for key_prefix={key.split(':', 2)[:2]}: {exc}")
            if _auth_requires_redis():
                raise HTTPException(status_code=503, detail="Authentication rate limiter unavailable")

    if _auth_requires_redis():
        raise HTTPException(status_code=503, detail="Authentication rate limiter unavailable")

    now = _monotonic()
    attempts, expires_at = local_cache.get(key, (0, now + window_seconds))
    if expires_at <= now:
        attempts = 0
        expires_at = now + window_seconds
    attempts += 1
    local_cache[key] = (attempts, expires_at)
    if attempts > attempts_limit:
        raise HTTPException(status_code=429, detail=message)


async def _check_login_rate_limit(email: str, request: Request) -> None:
    _cleanup_local_auth_caches()
    key = _login_rate_limit_key(email, request)
    await _check_simple_rate_limit(
        key,
        attempts_limit=_LOGIN_RATE_LIMIT_ATTEMPTS,
        window_seconds=_LOGIN_RATE_LIMIT_WINDOW_SECONDS,
        local_cache=_LOGIN_RATE_LIMIT_CACHE,
        message="Too many login attempts. Please try again shortly.",
    )


async def _check_forgot_password_rate_limit(email: str, request: Request) -> None:
    _cleanup_local_auth_caches()
    await _check_simple_rate_limit(
        _forgot_password_rate_limit_key(email, request),
        attempts_limit=_FORGOT_PASSWORD_RATE_LIMIT_ATTEMPTS,
        window_seconds=_FORGOT_PASSWORD_RATE_LIMIT_WINDOW_SECONDS,
        local_cache=_LOGIN_RATE_LIMIT_CACHE,
        message="Too many password reset requests. Please try again later.",
    )


async def _clear_login_rate_limit(email: str, request: Request) -> None:
    key = _login_rate_limit_key(email, request)
    _LOGIN_RATE_LIMIT_CACHE.pop(key, None)
    if cache_utils.redis_client is None:
        return
    try:
        await cache_utils.redis_client.delete(key)
    except Exception as exc:
        _safe_log(f"Login rate-limit Redis cleanup error: {exc}")


def _auth_cache_key(token: str, suffix: str = "user") -> str:
    digest = hashlib.sha256((token or "").encode("utf-8")).hexdigest()[:32]
    return f"auth:session-response:{suffix}:{digest}"


async def _get_auth_response_cache(token: str, suffix: str = "user") -> Optional[dict]:
    if _AUTH_RESPONSE_CACHE_TTL_SECONDS <= 0:
        return None
    key = _auth_cache_key(token, suffix)
    if cache_utils.redis_client is not None:
        try:
            cached = await cache_utils.redis_client.get(key)
            return json.loads(cached) if cached else None
        except Exception as exc:
            _safe_log(f"Auth response cache read error: {exc}")

    cached_entry = _AUTH_RESPONSE_CACHE.get(key)
    if not cached_entry:
        return None
    cached_value, expires_at = cached_entry
    if expires_at <= _monotonic():
        _AUTH_RESPONSE_CACHE.pop(key, None)
        return None
    return cached_value


async def _set_auth_response_cache(token: str, value: dict, suffix: str = "user") -> None:
    if _AUTH_RESPONSE_CACHE_TTL_SECONDS <= 0:
        return
    key = _auth_cache_key(token, suffix)
    if cache_utils.redis_client is not None:
        try:
            await cache_utils.redis_client.setex(
                key,
                _AUTH_RESPONSE_CACHE_TTL_SECONDS,
                json.dumps(value, default=str),
            )
            return
        except Exception as exc:
            _safe_log(f"Auth response cache write error: {exc}")
    _AUTH_RESPONSE_CACHE[key] = (value, _monotonic() + _AUTH_RESPONSE_CACHE_TTL_SECONDS)


async def _clear_auth_response_cache(token: Optional[str]) -> None:
    normalized_token = (token or "").strip()
    if not normalized_token:
        return
    keys = [_auth_cache_key(normalized_token, "user"), _auth_cache_key(normalized_token, "avatar")]
    for key in keys:
        _AUTH_RESPONSE_CACHE.pop(key, None)
    if cache_utils.redis_client is None:
        return
    try:
        await cache_utils.redis_client.delete(*keys)
    except Exception as exc:
        _safe_log(f"Auth response cache cleanup error: {exc}")

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


def _department_map_from_sources(db: Session) -> dict[str, str]:
    dept_map: dict[str, str] = {}

    managed_departments = (
        db.query(DepartmentDirectory.name)
        .filter(DepartmentDirectory.is_active == True)
        .order_by(DepartmentDirectory.name.asc())
        .all()
    )
    for row in managed_departments:
        department_value = f"{row[0] or ''}".strip()
        if department_value:
            dept_map.setdefault(department_value.lower(), department_value)

    user_departments = (
        db.query(User.department)
        .distinct()
        .filter(
            User.is_active == True,
            User.is_deleted == False,
            User.department != None,
        )
        .all()
    )
    for row in user_departments:
        department_value = f"{row[0] or ''}".strip()
        if department_value:
            dept_map.setdefault(department_value.lower(), department_value)

    for department_value in KNOWN_DEPARTMENTS:
        normalized_department = f"{department_value or ''}".strip()
        if normalized_department:
            dept_map.setdefault(normalized_department.lower(), normalized_department)

    return dept_map


def _serialize_user(user: User) -> dict:
    return {
        "id": user.id,
        "name": user.name,
        "email": user.email,
        "employeeId": user.employee_id,
        "position": user.position,
        "department": user.department,
        "avatar": None if _is_base64_avatar(user.avatar) else user.avatar,
        "roles": sorted(user_role_names(user)),
        "isAdmin": user.is_admin,
        "lastLogin": user.last_login.isoformat() if user.last_login else None,
    }


def _is_base64_avatar(value: Optional[str]) -> bool:
    return bool(value and value.lower().startswith("data:"))


def _normalize_avatar(avatar: Optional[str]) -> Optional[str]:
    value = (avatar or "").strip()
    if not value:
        return None
    allowed_data_prefixes = (
        "data:image/jpeg;",
        "data:image/jpg;",
        "data:image/png;",
        "data:image/webp;",
        "data:image/gif;",
    )
    if value.lower().startswith(allowed_data_prefixes):
        return value
    if value.startswith("http://") or value.startswith("https://") or value.startswith("/"):
        return value
    return None


def _avatar_size_bytes(avatar: str) -> int:
    if not avatar.startswith("data:image/") or "," not in avatar:
        return len(avatar.encode("utf-8"))
    encoded = avatar.split(",", 1)[1].strip()
    try:
        return len(base64.b64decode(encoded, validate=True))
    except Exception:
        return len(encoded.encode("utf-8"))


def _is_truthy(value: Optional[str]) -> bool:
    return (value or "").strip().lower() in {"1", "true", "yes", "on"}


def _frontend_reset_password_url(token: str) -> str:
    configured = (
        os.getenv("PASSWORD_RESET_URL")
        or os.getenv("RESET_PASSWORD_URL")
        or ""
    ).strip()
    if configured:
        separator = "&" if "?" in configured else "?"
        return f"{configured}{separator}token={token}"

    frontend_url = (os.getenv("FRONTEND_URL") or "").strip().rstrip("/")
    if frontend_url:
        return f"{frontend_url}/reset-password?token={token}"

    return f"http://localhost:5173/reset-password?token={token}"


def _send_password_reset_email(recipient_email: str, reset_link: str) -> bool:
    smtp_host = (os.getenv("SMTP_HOST") or "").strip()
    smtp_username = (os.getenv("SMTP_USERNAME") or os.getenv("SMTP_USER") or "").strip()
    smtp_password = (os.getenv("SMTP_PASSWORD") or "").strip()
    sender = (os.getenv("PASSWORD_RESET_FROM_EMAIL") or os.getenv("SMTP_FROM_EMAIL") or smtp_username).strip()
    if not smtp_host or not sender:
        return False

    smtp_port = _int_env("SMTP_PORT", 587)
    use_ssl = _is_truthy(os.getenv("SMTP_USE_SSL"))
    use_tls = _is_truthy(os.getenv("SMTP_USE_TLS")) or not use_ssl

    message = EmailMessage()
    message["From"] = sender
    message["To"] = recipient_email
    message["Subject"] = "Reset your RMW Task System password"
    message.set_content(
        "\n".join(
            [
                "We received a request to reset your RMW Task System password.",
                "",
                f"Reset your password here: {reset_link}",
                "",
                "This link expires in 1 hour. If you did not request this, you can ignore this email.",
            ]
        )
    )

    try:
        if use_ssl:
            with smtplib.SMTP_SSL(smtp_host, smtp_port, timeout=10) as smtp:
                if smtp_username and smtp_password:
                    smtp.login(smtp_username, smtp_password)
                smtp.send_message(message)
        else:
            with smtplib.SMTP(smtp_host, smtp_port, timeout=10) as smtp:
                if use_tls:
                    smtp.starttls(context=ssl.create_default_context())
                if smtp_username and smtp_password:
                    smtp.login(smtp_username, smtp_password)
                smtp.send_message(message)
        return True
    except Exception as exc:
        recipient_fingerprint = hashlib.sha256(recipient_email.encode("utf-8")).hexdigest()[:12]
        _safe_log(f"Password reset email delivery failed fingerprint={recipient_fingerprint}: {exc}")
        return False


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
    request: Request,
    session_id: Optional[str] = Cookie(None, alias="session_id"),
    x_session_id: Optional[str] = Header(None, alias="X-Session-Id"),
    # response: Response,
    db: Session = Depends(get_operational_db)
):
    """Validate session and return current user"""
    resolved_session_id = get_request_session_token(session_id, x_session_id)
    if not resolved_session_id:
        raise HTTPException(status_code=401, detail="Not authenticated")
    
    return resolve_session_user(
        resolved_session_id,
        db,
        session_fingerprint=create_session_fingerprint(request.headers.get("user-agent")),
    )


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


def _lock_employee_id_generation(db: Session) -> None:
    if db.bind and db.bind.dialect.name == "postgresql":
        db.execute(text("SELECT pg_advisory_xact_lock(hashtext('rmw_employee_id_generation'))"))


def _archive_deleted_user_identity(existing_user: User) -> None:
    timestamp = datetime.utcnow().strftime("%Y%m%d%H%M%S")
    existing_user.email = f"deleted+{existing_user.id}.{timestamp}@archived.local"
    if existing_user.employee_id:
        existing_user.employee_id = f"{existing_user.employee_id}-DEL-{existing_user.id}-{timestamp}"


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

    now = datetime.utcnow()
    password_hash = get_password_hash(new_password)
    try:
        request_row = UserApprovalRequest(
            user_id=current_user.id,
            request_type="password_change",
            status="pending",
            payload_json={
                "summary": "Secure password change request",
                "hasPasswordUpdate": True,
            },
            created_at=now,
        )
        db.add(request_row)
        db.flush()
        db.add(
            PendingPasswordChange(
                approval_request_id=request_row.id,
                user_id=current_user.id,
                password_hash=password_hash,
                status="pending",
                created_at=now,
                expires_at=now + timedelta(days=_int_env("PASSWORD_CHANGE_APPROVAL_EXPIRES_DAYS", 7)),
            )
        )
        db.commit()
        db.refresh(request_row)
    except SQLAlchemyError:
        db.rollback()
        raise

    push_admin_realtime_event(
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
        _safe_log(f"\nREGISTRATION ATTEMPT: {user_data.email}")

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
            _safe_log(f"Re-registering deleted account with fresh identity: {existing_user.email}")
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
        
        _lock_employee_id_generation(db)

        # Create user
        requested_roles = normalize_roles(user_data.roles or [])
        new_user = User(
            email=user_data.email,
            employee_id=generate_employee_id(db),
            name=user_data.name,
            hashed_password=hashed_password,
            position=user_data.position,
            department=user_data.department,
            roles_json=requested_roles,
            is_active=False,
            is_admin=False,
            created_at=datetime.utcnow()
        )
        
        db.add(new_user)
        db.flush()
        replace_user_roles(db, new_user, requested_roles)

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
                    "roles": sorted(user_role_names(new_user)),
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
        push_admin_realtime_event(
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
        
        _safe_log(f"Registration successful: {new_user.email}")
        
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
                "roles": sorted(user_role_names(new_user)),
                "isAdmin": new_user.is_admin
            }
        }
        
    except HTTPException:
        raise
    except IntegrityError as e:
        db.rollback()
        _log_exception("Registration integrity error", e)
        raise HTTPException(
            status_code=409,
            detail="Registration could not be completed because a unique account value already exists. Please try again."
        )
    except Exception as e:
        db.rollback()
        _log_exception("Registration error", e)
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
        normalized_email = credentials.email.strip().lower()
        _safe_log(f"\nLOGIN ATTEMPT: {normalized_email}")
        await _check_login_rate_limit(normalized_email, request)
        
        # Find user
        user = db.query(User).filter(
            User.email == normalized_email
        ).first()
        if not user:
            _fake_password_verify_for_timing(credentials.password)
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
        
        # Create session
        session_fingerprint = create_session_fingerprint(request.headers.get("user-agent"))
        session_id = create_session_token(user.id, session_fingerprint=session_fingerprint)

        # Update last login only after session creation succeeds.
        user.last_login = datetime.utcnow()
        db.commit()
        await _clear_login_rate_limit(normalized_email, request)
        serialized_user = _serialize_user(user)
        await _set_auth_response_cache(session_id, serialized_user)

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
        
        _safe_log(f"Login successful: {user.email}")
        _safe_log(f"Cookie set: session_id={session_id[:10]}...")
        
        return {
            "success": True,
            "message": "Login successful",
            "user": serialized_user,
            "sessionToken": session_id,
        }
        
    except HTTPException:
        raise
    except SQLAlchemyError as e:
        db.rollback()
        _log_exception("Login database error", e)
        raise HTTPException(status_code=503, detail="Auth database unavailable")
    except Exception as e:
        db.rollback()
        _log_exception("Login error", e)
        raise HTTPException(
            status_code=500,
            detail="An error occurred during login"
        )


@router.get("/me")
async def get_current_user_profile(
    request: Request,
    session_id: Optional[str] = Cookie(None, alias="session_id"),
    x_session_id: Optional[str] = Header(None, alias="X-Session-Id"),
    db: Session = Depends(get_operational_db)
):
    """Get current authenticated user"""
    resolved_session_id = get_request_session_token(session_id, x_session_id)
    if not resolved_session_id:
        raise HTTPException(status_code=401, detail="Not authenticated")
    
    try:
        cached_user = await _get_auth_response_cache(resolved_session_id)
        if cached_user:
            verify_session_token(
                resolved_session_id,
                db,
                create_session_fingerprint(request.headers.get("user-agent")),
            )
            return {
                "success": True,
                "user": cached_user,
                "cached": True,
            }

        user = resolve_session_user(
            resolved_session_id,
            db,
            session_fingerprint=create_session_fingerprint(request.headers.get("user-agent")),
        )
        serialized_user = _serialize_user(user)
        await _set_auth_response_cache(resolved_session_id, serialized_user)
        
        return {
            "success": True,
            "user": serialized_user
        }
    except HTTPException:
        raise
    except SQLAlchemyError as e:
        _log_exception("Database error getting current user", e)
        raise HTTPException(status_code=503, detail="Auth database unavailable")
    except Exception as e:
        _log_exception("Error getting current user", e)
        raise HTTPException(status_code=500, detail="Unable to verify session")


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
    request: Request,
    session_id: Optional[str] = Cookie(None, alias="session_id"),
    x_session_id: Optional[str] = Header(None, alias="X-Session-Id"),
    db: Session = Depends(get_operational_db),
):
    resolved_session_id = get_request_session_token(session_id, x_session_id)
    if not resolved_session_id:
        raise HTTPException(status_code=401, detail="Not authenticated")

    cached_avatar = await _get_auth_response_cache(resolved_session_id or "", "avatar")
    if cached_avatar:
        verify_session_token(
            resolved_session_id,
            db,
            create_session_fingerprint(request.headers.get("user-agent")),
        )
        return cached_avatar

    current_user = resolve_session_user(
        resolved_session_id,
        db,
        session_fingerprint=create_session_fingerprint(request.headers.get("user-agent")),
    )
    payload = {
        "success": True,
        "userId": current_user.id,
        "avatar": current_user.avatar,
        "hasAvatar": bool(current_user.avatar),
    }
    if resolved_session_id:
        await _set_auth_response_cache(resolved_session_id, payload, "avatar")
    return payload


@router.post("/avatar")
async def upload_avatar(
    payload: AvatarUpload,
    session_id: Optional[str] = Cookie(None, alias="session_id"),
    x_session_id: Optional[str] = Header(None, alias="X-Session-Id"),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_operational_db)
):
    avatar = _normalize_avatar(payload.avatar)
    if not avatar:
        raise HTTPException(status_code=400, detail="A valid image is required")
    if _avatar_size_bytes(avatar) > 3_000_000:
        raise HTTPException(status_code=400, detail="Avatar image is too large")

    current_user.avatar = avatar
    db.commit()
    db.refresh(current_user)
    resolved_session_id = get_request_session_token(session_id, x_session_id)
    await _clear_auth_response_cache(resolved_session_id)
    if resolved_session_id:
        await _set_auth_response_cache(resolved_session_id, _serialize_user(current_user))

    return {
        "success": True,
        "message": "Avatar updated successfully",
        "avatar": current_user.avatar,
        "user": _serialize_user(current_user),
    }


@router.delete("/avatar")
async def delete_avatar(
    session_id: Optional[str] = Cookie(None, alias="session_id"),
    x_session_id: Optional[str] = Header(None, alias="X-Session-Id"),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_operational_db)
):
    current_user.avatar = None
    db.commit()
    db.refresh(current_user)
    resolved_session_id = get_request_session_token(session_id, x_session_id)
    await _clear_auth_response_cache(resolved_session_id)
    if resolved_session_id:
        await _set_auth_response_cache(resolved_session_id, _serialize_user(current_user))

    return {
        "success": True,
        "message": "Avatar removed successfully",
        "avatar": None,
        "user": _serialize_user(current_user),
    }


@router.put("/profile")
async def update_profile(
    payload: ProfileUpdate,
    session_id: Optional[str] = Cookie(None, alias="session_id"),
    x_session_id: Optional[str] = Header(None, alias="X-Session-Id"),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_operational_db)
):
    updated = False

    if payload.avatar is not None:
        normalized_avatar = _normalize_avatar(payload.avatar)
        if payload.avatar and not normalized_avatar:
            raise HTTPException(status_code=400, detail="A valid avatar image is required")
        if normalized_avatar and _avatar_size_bytes(normalized_avatar) > 3_000_000:
            raise HTTPException(status_code=400, detail="Avatar image is too large")
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
        resolved_session_id = get_request_session_token(session_id, x_session_id)
        await _clear_auth_response_cache(resolved_session_id)
        if resolved_session_id:
            await _set_auth_response_cache(resolved_session_id, _serialize_user(current_user))

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
        normalized_department = (department_name or "").strip()
        if not normalized_department:
            return {
                "success": True,
                "department": "",
                "users": [],
                "count": 0
            }

        users_query = db.query(User).filter(
            func.lower(func.trim(User.department)) == normalized_department.lower(),
            User.is_active == True,
            User.is_deleted == False
        )
        if role:
            role_lower = role.lower()
            users_query = users_query.filter(
                (User.position.ilike(f"%{role_lower}%")) |
                (User.id.in_(db.query(UserRole.user_id).filter(UserRole.role == role_lower)))
            )
        users = users_query.all()
        
        return {
            "success": True,
            "department": normalized_department,
            "users": [
                {
                    "id": user.id,
                    "name": user.name,
                    "email": user.email,
                    "employeeId": user.employee_id,
                    "department": user.department,
                    "position": user.position,
                    "roles": sorted(user_role_names(user)),
                    "avatar": user.avatar,
                    "lastLogin": user.last_login.isoformat() if user.last_login else None
                }
                for user in users
            ],
            "count": len(users)
        }
    except Exception as e:
        _safe_log(f"Error fetching users for department {department_name}: {str(e)}")
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
        dept_map = _department_map_from_sources(db)
        dept_list = sorted(dept_map.values())

        return {
            "success": True,
            "departments": dept_list,
            "count": len(dept_list)
        }
    except Exception as e:
        logger.exception("Error fetching departments")
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
    push_admin_realtime_event(
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
            "payload": sanitize_request_payload(req.request_type, req.payload_json),
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
            "payload": sanitize_request_payload(req.request_type, req.payload_json),
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
                "payload": sanitize_request_payload(item.request_type, item.payload_json),
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
    try:
        req = (
            db.query(UserApprovalRequest)
            .filter(UserApprovalRequest.id == request_id)
            .with_for_update()
            .first()
        )
        if not req:
            raise HTTPException(status_code=404, detail="Approval request not found")
        if req.status != "pending":
            raise HTTPException(status_code=400, detail="Request already reviewed")

        user = db.query(User).filter(User.id == req.user_id).with_for_update().first()
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
        elif req.request_type == "password_change":
            pending_password = pending_password_change_for_request(db, req)
            if pending_password and pending_password.status == "pending":
                pending_password.status = "rejected"
                pending_password.consumed_at = datetime.utcnow()

        db.commit()
    except HTTPException:
        db.rollback()
        raise
    except IntegrityError as exc:
        db.rollback()
        _log_exception("Approval review integrity error", exc)
        raise HTTPException(status_code=409, detail="Approval could not be completed because of a duplicate value")
    except SQLAlchemyError as exc:
        db.rollback()
        _log_exception("Approval review database error", exc)
        raise HTTPException(status_code=503, detail="Approval database unavailable")

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


@router.post("/logout", response_model=MessageResponse)
async def logout(
    request: Request,
    response: Response, 
    session_id: Optional[str] = Cookie(None, alias="session_id"),
    x_session_id: Optional[str] = Header(None, alias="X-Session-Id"),
):
    """Logout user"""
    resolved_session_id = get_request_session_token(session_id, x_session_id)
    if resolved_session_id:
        invalidate_session(resolved_session_id)
        await _clear_auth_response_cache(resolved_session_id)
    
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
async def forgot_password(
    request: Request,
    background_tasks: BackgroundTasks,
    payload: ForgotPasswordRequest, 
    db: Session = Depends(get_operational_db)
):
    """Request password reset"""
    normalized_email = payload.email.strip().lower()
    await _check_forgot_password_rate_limit(normalized_email, request)
    user = db.query(User).filter(User.email == normalized_email).first()
    
    if user:
        token = create_reset_token(normalized_email)
        reset_link = _frontend_reset_password_url(token)
        token_fingerprint = hashlib.sha256(token.encode("utf-8")).hexdigest()[:12]
        background_tasks.add_task(_send_password_reset_email, normalized_email, reset_link)
        _safe_log(f"Password reset token created for user_id={user.id} fingerprint={token_fingerprint}")
    
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

    try:
        user.hashed_password = get_password_hash(request.new_password)
        revoke_user_sessions(db, user.id)
        db.commit()
    except SQLAlchemyError as exc:
        db.rollback()
        _log_exception("Password reset database error", exc)
        raise HTTPException(status_code=503, detail="Password reset database unavailable")
    
    invalidate_reset_token(request.token)
    
    return {"message": "Password reset successfully"}

