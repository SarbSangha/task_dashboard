# main.py - Clean and Consolidated
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, FileResponse
from fastapi.staticfiles import StaticFiles
from contextlib import asynccontextmanager
from datetime import datetime
import os
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
from utils.cache import init_redis, close_redis

# Import auth utilities for system status
from auth import SESSION_STORE
from auth import get_password_hash

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


# ==================== LIFESPAN EVENT ====================
@asynccontextmanager
async def lifespan(app: FastAPI):
    """Startup and shutdown events"""
    print("\n" + "="*60)
    print("STARTING TASK MANAGEMENT SYSTEM")
    print("="*60)
    
    # Create operational database tables
    print("\nInitializing operational database...")
    Base.metadata.create_all(bind=operational_engine)
    ensure_operational_schema(operational_engine)
    print(f"Operational database ready: {operational_engine.dialect.name}")
    
    # Create archive database tables
    print("\nInitializing archive database...")
    ArchiveBase.metadata.create_all(bind=archive_engine)
    print(f"Archive database ready: {archive_engine.dialect.name}")

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
                admin.is_admin = True
                admin.is_active = True
                admin.is_deleted = False
                if configured_roles:
                    roles = []
                    if isinstance(admin.roles_json, list):
                        roles = [str(role).strip().lower() for role in admin.roles_json if str(role).strip()]
                    for role in configured_roles:
                        if role not in roles:
                            roles.append(role)
                    admin.roles_json = roles
                if (admin.position or "").lower() != "admin":
                    admin.position = "admin"
                admin.department = "ADMIN"
                if not admin.name:
                    admin.name = "Administrator"
        else:
            print("Default admin bootstrap disabled: DEFAULT_ADMIN_EMAIL is not set.")
        op_db.commit()
    finally:
        op_db.close()
    
    print("\n" + "="*60)
    print("APPLICATION READY")
    print("="*60)
    print("\nAPI Documentation: http://localhost:8000/docs")
    print(f"Operational DB: {_mask_db_url(OPERATIONAL_DB_URL)}")
    print(f"Archive DB: {_mask_db_url(ARCHIVE_DB_URL)}")
    await init_redis()
    print("Frontend: http://localhost:5173\n")
    
    yield
    
    print("\nShutting down gracefully...")
    await close_redis()
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
    allow_origin_regex=r"https://.*\.onrender\.com",
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=["Set-Cookie"],
)


# ==================== EXCEPTION HANDLERS ====================
@app.exception_handler(Exception)
async def global_exception_handler(request: Request, exc: Exception):
    """Global exception handler"""
    print(f"Unhandled exception: {str(exc)}")
    import traceback
    traceback.print_exc()
    
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
    
    overall_status = "healthy" if (op_status == "healthy" and ar_status == "healthy") else "degraded"
    
    return {
        "status": overall_status,
        "timestamp": datetime.utcnow().isoformat(),
        "databases": {
            "operational": op_status,
            "archive": ar_status
        }
    }

@app.get("/api/system/status")
async def system_status():
    """Get system status"""
    try:
        with OperationalSessionLocal() as op_db:
            user_count = op_db.query(User).count()
            task_count = op_db.query(Task).count()
            active_tasks = op_db.query(Task).filter(Task.is_deleted == False).count()
        
        return {
            "status": "operational",
            "timestamp": datetime.utcnow().isoformat(),
            "statistics": {
                "total_users": user_count,
                "total_tasks": task_count,
                "active_tasks": active_tasks,
                "active_sessions": len(SESSION_STORE)
            }
        }
    except Exception as e:
        return {"status": "error", "error": str(e)}

# ==================== STATIC FILES - MUST BE AFTER API ROUTES ====================
if os.path.exists("dist"):
    print("Serving frontend from dist/")
    
    # Mount assets folder for JS/CSS/images
    if os.path.exists("dist/assets"):
        app.mount("/assets", StaticFiles(directory="dist/assets"), name="assets")
        print("Mounted /assets")
    
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
    print("dist folder not found - API only mode")
    
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
