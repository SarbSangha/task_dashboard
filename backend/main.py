# main.py - Clean and Consolidated
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, FileResponse
from fastapi.staticfiles import StaticFiles
from contextlib import asynccontextmanager
from datetime import datetime
import asyncio
import os
import re
import time
import traceback
from sqlalchemy import text

# FIXED: Use relative imports or backend prefix
from database_config import (
    operational_engine, 
    archive_engine, 
    Base, 
    ArchiveBase,
    OperationalSessionLocal,
    ArchiveSessionLocal,
    OPERATIONAL_DB_URL,
    ARCHIVE_DB_URL,
)
from db_migrations import ensure_operational_schema

from models_new import User, Task, TaskParticipant, TaskStatusHistory, ArchivedTask, ActivityLog
# Import routers
from routers import auth_router
from routers.tasks import router as tasks_router
from routers import drafts_router
from routers import archive_router
from routers import approvals
from routers import upload
from routers import activity_router
from routers import admin_router
from routers import groups_router
from routers import direct_messages_router
from routers import it_tools_router
from routers import mailbox_admin_router
from utils import cache as cache_utils

# Import auth utilities for system status
from auth import SESSION_STORE
from auth import get_password_hash
from auth import cleanup_expired_reset_tokens, cleanup_expired_sessions
from routers.tasks_router import notification_dispatcher
from services.notification_outbox_service import dispatch_notification_outbox_batch

def _split_csv(value: str) -> list[str]:
    return [item.strip() for item in (value or "").split(",") if item.strip()]


def _allowed_origins() -> list[str]:
    env_origins = _split_csv(os.getenv("CORS_ORIGINS", ""))
    frontend_url = (os.getenv("FRONTEND_URL") or "").strip()
    defaults = [
        "https://task-dashboard-1-um9m.onrender.com",
        "http://localhost:3000",
        "http://localhost:5173",
        "http://127.0.0.1:3000",
        "http://127.0.0.1:5173",
        "http://192.168.1.15:5173",
        "https://dashboard.ritzmediaworld.in",
        "http://dashboard.ritzmediaworld.in",
    ]
    merged = []
    for origin in [*env_origins, frontend_url, *defaults]:
        if origin and origin not in merged:
            merged.append(origin)
    return merged


def _display_frontend_url() -> str:
    frontend_url = (os.getenv("FRONTEND_URL") or "").strip()
    if frontend_url:
        return frontend_url
    return "not configured"


def _is_production() -> bool:
    environment = (os.getenv("ENVIRONMENT") or "").strip().lower()
    render_flag = (os.getenv("RENDER") or "").strip().lower()
    return environment == "production" or render_flag in {"1", "true", "yes", "on"}


def _allowed_origin_regex() -> str | None:
    configured = (os.getenv("CORS_ALLOW_ORIGIN_REGEX") or "").strip()
    if configured:
        return configured
    if _bool_env("CORS_ALLOW_RENDER_PREVIEWS", False):
        return r"https://.*\.onrender\.com"
    return None


def _origin_allowed(origin: str) -> bool:
    normalized = (origin or "").strip()
    if not normalized:
        return False
    if normalized in _allowed_origins():
        return True
    origin_regex = _allowed_origin_regex()
    return bool(origin_regex and re.fullmatch(origin_regex, normalized))


def _mask_db_url(url: str) -> str:
    if not url:
        return ""
    if "://" not in url:
        return url
    scheme, rest = url.split("://", 1)
    if "@" not in rest:
        return f"{scheme}://{rest}"
    creds, tail = rest.split("@", 1)
    if ":" in creds:
        user = creds.split(":", 1)[0]
        return f"{scheme}://{user}:***@{tail}"
    return f"{scheme}://***@{tail}"


def _ascii_safe_text(value: object) -> str:
    return f"{value}".encode("ascii", "backslashreplace").decode("ascii")


def _safe_print(value: object = "") -> None:
    print(_ascii_safe_text(value))


def _int_env(name: str, default: int) -> int:
    raw = (os.getenv(name) or "").strip()
    if not raw:
        return default
    try:
        return int(raw)
    except ValueError:
        return default


def _bool_env(name: str, default: bool = False) -> bool:
    raw = (os.getenv(name) or "").strip().lower()
    if not raw:
        return default
    return raw in {"1", "true", "yes", "on"}


def _startup_schema_sync_enabled() -> bool:
    raw = (os.getenv("RUN_STARTUP_SCHEMA_SYNC") or "").strip()
    if raw:
        return _bool_env("RUN_STARTUP_SCHEMA_SYNC", True)
    return not _is_production()


def _redis_configured() -> bool:
    return bool((os.getenv("REDIS_URL") or "").strip())


def _is_local_request(request: Request) -> bool:
    client_host = request.client.host if request.client else ""
    return client_host in {"127.0.0.1", "::1", "localhost"}


_SYSTEM_STATUS_CACHE: dict = {"expires_at": 0.0, "payload": None}


async def _periodic_auth_store_cleanup(interval_seconds: int = 3600) -> None:
    while True:
        await asyncio.sleep(max(60, interval_seconds))
        try:
            expired_sessions, expired_reset_tokens = await asyncio.wait_for(
                asyncio.to_thread(
                    lambda: (
                        cleanup_expired_sessions(),
                        cleanup_expired_reset_tokens(),
                    )
                ),
                timeout=10,
            )
            if expired_sessions or expired_reset_tokens:
                _safe_print(
                    "Auth cleanup removed "
                    f"sessions={expired_sessions} resetTokens={expired_reset_tokens}"
                )
        except Exception as exc:
            _safe_print(f"Auth cleanup failed: {exc}")


async def _periodic_notification_outbox_dispatch(interval_seconds: int = 30) -> None:
    while True:
        await asyncio.sleep(max(5, interval_seconds))
        db = OperationalSessionLocal()
        try:
            dispatched = await asyncio.wait_for(
                asyncio.to_thread(
                    dispatch_notification_outbox_batch,
                    db,
                    notification_dispatcher,
                    limit=_int_env("NOTIFICATION_OUTBOX_BATCH_SIZE", 100),
                ),
                timeout=max(5, _int_env("NOTIFICATION_OUTBOX_DISPATCH_TIMEOUT_SECONDS", 20)),
            )
            if dispatched:
                _safe_print(f"Notification outbox dispatched={dispatched}")
        except Exception as exc:
            db.rollback()
            _safe_print(f"Notification outbox dispatch failed: {exc}")
        finally:
            db.close()


# ==================== LIFESPAN EVENT ====================
@asynccontextmanager
async def lifespan(app: FastAPI):
    """Startup and shutdown events"""
    _safe_print("\n" + "="*60)
    _safe_print("STARTING TASK MANAGEMENT SYSTEM")
    _safe_print("="*60)
    
    if _startup_schema_sync_enabled():
        # Prefer external migrations in production; startup schema sync defaults off there.
        _safe_print("\nInitializing operational database...")
        Base.metadata.create_all(bind=operational_engine)
        ensure_operational_schema(operational_engine)
        _safe_print(f"Operational database ready: {operational_engine.dialect.name}")
        
        _safe_print("\nInitializing archive database...")
        ArchiveBase.metadata.create_all(bind=archive_engine)
        _safe_print(f"Archive database ready: {archive_engine.dialect.name}")
    else:
        _safe_print("\nStartup schema sync disabled.")

    # Optional default-admin bootstrap, driven by environment variables instead of hardcoded account details.
    op_db = OperationalSessionLocal()
    try:
        admin_email = (os.getenv("DEFAULT_ADMIN_EMAIL") or "").strip()
        bootstrap_password = (os.getenv("DEFAULT_ADMIN_BOOTSTRAP_PASSWORD") or "").strip()
        configured_roles = [
            role.lower()
            for role in _split_csv(os.getenv("DEFAULT_ADMIN_ROLES", ""))
            if role.strip()
        ]

        if admin_email:
            admin = (
                op_db.query(User)
                .filter(User.email == admin_email)
                .order_by(User.id.asc())
                .first()
            )

            if not admin:
                if not bootstrap_password:
                    raise RuntimeError(
                        "Configured default admin account is missing. Create it manually or set "
                        "DEFAULT_ADMIN_BOOTSTRAP_PASSWORD for a one-time bootstrap."
                    )
                admin = User(
                    email=admin_email,
                    name="Administrator",
                    hashed_password=get_password_hash(bootstrap_password),
                    position="admin",
                    department="ADMIN",
                    roles_json=configured_roles,
                    is_admin=True,
                    is_active=True,
                )
                op_db.add(admin)
            else:
                _safe_print(f"Default admin {admin_email} already exists; bootstrap will not mutate existing user.")
                if configured_roles:
                    _safe_print("DEFAULT_ADMIN_ROLES ignored for existing user; update roles from admin UI or database.")
        else:
            _safe_print("Default admin bootstrap disabled: DEFAULT_ADMIN_EMAIL is not set.")
        op_db.commit()
    finally:
        op_db.close()
    
    _safe_print("\n" + "="*60)
    _safe_print("APPLICATION READY")
    _safe_print("="*60)
    _safe_print("\nAPI Documentation: http://localhost:8000/docs")
    _safe_print(f"Operational DB: {_mask_db_url(OPERATIONAL_DB_URL)}")
    _safe_print(f"Archive DB: {_mask_db_url(ARCHIVE_DB_URL)}")
    try:
        await cache_utils.init_redis()
    except Exception as exc:
        _safe_print(f"Redis initialization failed; continuing without Redis: {exc}")
    try:
        notification_dispatcher.start()
    except Exception as exc:
        _safe_print(f"Notification dispatcher failed to start; continuing degraded: {exc}")
    auth_cleanup_task = asyncio.create_task(
        _periodic_auth_store_cleanup(_int_env("AUTH_CLEANUP_INTERVAL_SECONDS", 3600)),
        name="auth-store-cleanup",
    )
    notification_outbox_task = asyncio.create_task(
        _periodic_notification_outbox_dispatch(_int_env("NOTIFICATION_OUTBOX_INTERVAL_SECONDS", 30)),
        name="notification-outbox-dispatch",
    )
    _safe_print(f"Frontend: {_display_frontend_url()}\n")
    
    try:
        yield
    finally:
        auth_cleanup_task.cancel()
        notification_outbox_task.cancel()
        await asyncio.gather(auth_cleanup_task, notification_outbox_task, return_exceptions=True)
        await notification_dispatcher.stop()
    
    _safe_print("\nShutting down gracefully...")
    await cache_utils.close_redis()
    operational_engine.dispose()
    if archive_engine is not operational_engine:
        archive_engine.dispose()


# ==================== CREATE APP ====================
app = FastAPI(
    title="Task Management System",
    description="Dual Database Task Management with Archive & Audit Trail",
    version="2.0.0",
    lifespan=lifespan
)


# ==================== CORS MIDDLEWARE ====================
app.add_middleware(
    CORSMiddleware,
    allow_origins=_allowed_origins(),
    allow_origin_regex=_allowed_origin_regex(),
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=["Set-Cookie"],
)


@app.middleware("http")
async def ensure_cors_headers_on_error_responses(request: Request, call_next):
    started_at = time.perf_counter()
    try:
        response = await call_next(request)
    except Exception as exc:
        _safe_print(f"Unhandled exception: {exc}")
        traceback_text = "".join(traceback.format_exception(type(exc), exc, exc.__traceback__))
        _safe_print(traceback_text)
        response = JSONResponse(
            status_code=500,
            content={
                "success": False,
                "message": "Internal server error",
                "detail": str(exc),
            },
        )
    origin = (request.headers.get("origin") or "").strip()
    if origin and _origin_allowed(origin) and "access-control-allow-origin" not in response.headers:
        response.headers["Access-Control-Allow-Origin"] = origin
        response.headers["Vary"] = "Origin"
        response.headers["Access-Control-Allow-Credentials"] = "true"
    elapsed_ms = int((time.perf_counter() - started_at) * 1000)
    slow_request_ms = max(1000, _int_env("SLOW_REQUEST_LOG_MS", 3000))
    if elapsed_ms >= slow_request_ms or request.url.path in {"/api/auth/login", "/api/auth/me"}:
        _safe_print(
            f"REQUEST {request.method} {request.url.path} "
            f"status={response.status_code} elapsed_ms={elapsed_ms}"
        )
    return response


# ==================== EXCEPTION HANDLERS ====================
@app.exception_handler(Exception)
async def global_exception_handler(request: Request, exc: Exception):
    """Global exception handler"""
    _safe_print(f"Unhandled exception: {exc}")
    traceback_text = "".join(traceback.format_exception(type(exc), exc, exc.__traceback__))
    _safe_print(traceback_text)
    
    return JSONResponse(
        status_code=500,
        content={
            "success": False,
            "message": "Internal server error",
            "detail": str(exc)
        }
    )


# ==================== REGISTER ROUTERS ====================
# Authentication & User Management
app.include_router(auth_router.router)

# Task Management
app.include_router(tasks_router)

# Drafts
app.include_router(drafts_router.router)

# Archive & Activity Logs
app.include_router(archive_router.router)

# Approvals
app.include_router(approvals.router)

# File Uploads
app.include_router(upload.router)

# User Activity Tracking
app.include_router(activity_router.router)

# Admin Management
app.include_router(admin_router.router)

# Groups & Messages
app.include_router(groups_router.router)

# Direct Messages
app.include_router(direct_messages_router.router)

# IT Profile / Tool Vault
app.include_router(it_tools_router.router)
app.include_router(mailbox_admin_router.router)


# ==================== ROOT ENDPOINTS ====================
@app.get("/")
async def root():
    """Root endpoint - API info"""
    if os.path.exists("dist/index.html"):
        return FileResponse("dist/index.html")
    return {
        "name": "Task Management System API",
        "version": "2.0.0",
        "status": "operational",
        "features": [
            "Dual Database (Operational + Archive)",
            "User Authentication & Authorization",
            "Task Management with Workflow",
            "Draft System",
            "Complete Audit Trail",
            "Task Archiving & Restoration",
            "Activity Logging",
            "File Upload Support",
            "Approval Workflow"
        ],
        "databases": {
            "operational": _mask_db_url(OPERATIONAL_DB_URL),
            "archive": _mask_db_url(ARCHIVE_DB_URL),
        },
        "documentation": "/docs",
        "interactive_docs": "/redoc"
    }

# ==================== ROOT & STATIC FILES ====================

# Health check (API route)
@app.get("/api/health")
async def health_check():
    """Health check endpoint"""
    try:
        with OperationalSessionLocal() as op_db:
            op_db.execute(text("SELECT 1"))
        op_status = "healthy"
    except Exception as e:
        op_status = f"unhealthy: {str(e)}"
    
    try:
        with ArchiveSessionLocal() as ar_db:
            ar_db.execute(text("SELECT 1"))
        ar_status = "healthy"
    except Exception as e:
        ar_status = f"unhealthy: {str(e)}"

    redis_status = "disabled"
    if cache_utils.redis_client is not None:
        try:
            await cache_utils.redis_client.ping()
            redis_status = "healthy"
        except Exception as e:
            redis_status = f"unhealthy: {str(e)}"
    elif _redis_configured():
        redis_status = "unhealthy: REDIS_URL configured but client is unavailable"
    
    dispatcher_status = notification_dispatcher.status()
    dispatcher_healthy = dispatcher_status.get("stopped", 0) == 0
    redis_healthy = redis_status in {"healthy", "disabled"}
    overall_status = (
        "healthy"
        if (
            op_status == "healthy"
            and ar_status == "healthy"
            and redis_healthy
            and dispatcher_healthy
        )
        else "degraded"
    )
    
    payload = {
        "status": overall_status,
        "timestamp": datetime.utcnow().isoformat(),
        "databases": {
            "operational": op_status,
            "archive": ar_status
        },
        "redis": redis_status,
        "notificationDispatcher": dispatcher_status,
    }
    if overall_status != "healthy":
        return JSONResponse(status_code=503, content=payload)
    return payload


@app.get("/api/debug/pool")
async def debug_pool(request: Request):
    """Local-only database pool diagnostics for production incidents."""
    if not _is_local_request(request):
        raise HTTPException(status_code=404, detail="Not found")

    return {
        "timestamp": datetime.utcnow().isoformat(),
        "processId": os.getpid(),
        "operationalPool": operational_engine.pool.status(),
        "archivePool": archive_engine.pool.status(),
        "sharedArchivePool": archive_engine is operational_engine,
        "notificationDispatcher": notification_dispatcher.status(),
    }


@app.get("/api/system/status")
async def system_status():
    """Get system status"""
    now = time.time()
    cached_payload = _SYSTEM_STATUS_CACHE.get("payload")
    if cached_payload and now < float(_SYSTEM_STATUS_CACHE.get("expires_at") or 0):
        return cached_payload

    try:
        with OperationalSessionLocal() as op_db:
            user_count = op_db.query(User).count()
            task_count = op_db.query(Task).count()
            active_tasks = op_db.query(Task).filter(Task.is_deleted == False).count()
        
        payload = {
            "status": "operational",
            "timestamp": datetime.utcnow().isoformat(),
            "statistics": {
                "total_users": user_count,
                "total_tasks": task_count,
                "active_tasks": active_tasks,
                "local_worker_sessions": len(SESSION_STORE)
            }
        }
        _SYSTEM_STATUS_CACHE["payload"] = payload
        _SYSTEM_STATUS_CACHE["expires_at"] = now + max(5, _int_env("SYSTEM_STATUS_CACHE_SECONDS", 30))
        return payload
    except Exception as e:
        return {"status": "error", "error": str(e)}

# ==================== STATIC FILES - MUST BE AFTER API ROUTES ====================
if os.path.exists("dist"):
    _safe_print("Serving frontend from dist/")
    
    # Mount assets folder for JS/CSS/images
    if os.path.exists("dist/assets"):
        app.mount("/assets", StaticFiles(directory="dist/assets"), name="assets")
        _safe_print("Mounted /assets")
    
    # Catch-all for SPA routing (MUST BE LAST)
    @app.get("/{full_path:path}")
    async def serve_react_app(full_path: str):
        """Serve React app for all non-API routes"""
        # Skip API routes
        if full_path.startswith("api/"):
            return JSONResponse({"error": "Not found"}, status_code=404)
        
        # Serve index.html for all other routes (React Router support)
        return FileResponse("dist/index.html")
else:
    _safe_print("dist folder not found - API only mode")
    
    @app.get("/")
    async def root_no_frontend():
        return {
            "name": "Task Management System API",
            "version": "2.0.0",
            "status": "operational",
            "message": "Frontend not built. Run: cd my-dashboard && npm run build",
            "documentation": "/docs"
        }

# ==================== RUN APP ====================
if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True, log_level="info")

