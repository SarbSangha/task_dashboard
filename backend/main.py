# main.py - Clean and Consolidated
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, FileResponse
from fastapi.staticfiles import StaticFiles
from contextlib import asynccontextmanager
from datetime import datetime
import os

# ✅ FIXED: Use relative imports or backend prefix
from database_config import (
    operational_engine, 
    archive_engine, 
    Base, 
    ArchiveBase,
    OperationalSessionLocal,
    ArchiveSessionLocal
)

from models_new import User, Task, TaskParticipant, TaskStatusHistory, ArchivedTask, ActivityLog
# Import routers
from routers import auth_router
from routers import tasks_router
from routers import drafts_router
from routers import archive_router
from routers import approvals
from routers import upload

# Import auth utilities for system status
from auth import SESSION_STORE


# ==================== CONFIGURATION ====================
UPLOAD_DIR = "uploads"
os.makedirs(UPLOAD_DIR, exist_ok=True)


# ==================== LIFESPAN EVENT ====================
@asynccontextmanager
async def lifespan(app: FastAPI):
    """Startup and shutdown events"""
    print("\n" + "="*60)
    print("🚀 STARTING TASK MANAGEMENT SYSTEM")
    print("="*60)
    
    # Create operational database tables
    print("\n📊 Initializing operational database...")
    Base.metadata.create_all(bind=operational_engine)
    print("✅ Operational database ready: task_db.sqlite")
    
    # Create archive database tables
    print("\n📦 Initializing archive database...")
    ArchiveBase.metadata.create_all(bind=archive_engine)
    print("✅ Archive database ready: archive_db.sqlite")
    
    print("\n" + "="*60)
    print("✅ APPLICATION READY")
    print("="*60)
    print("\n📚 API Documentation: http://localhost:8000/docs")
    print("📊 Operational DB: task_db.sqlite")
    print("📦 Archive DB: archive_db.sqlite")
    print("🌐 Frontend: http://localhost:5173\n")
    
    yield
    
    print("\n👋 Shutting down gracefully...")


# ==================== CREATE APP ====================
app = FastAPI(
    title="Task Management System",
    description="Dual Database Task Management with Archive & Audit Trail",
    version="2.0.0",
    lifespan=lifespan
)


# ==================== STATIC FILES ====================
app.mount("/uploads", StaticFiles(directory=UPLOAD_DIR), name="uploads")


# ==================== CORS MIDDLEWARE ====================
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "https://task-dashboard-1-um9m.onrender.com",
        "http://localhost:3000",
        "http://localhost:5173",
        "http://127.0.0.1:3000",
        "http://127.0.0.1:5173"
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=["Set-Cookie"],
)


# ==================== EXCEPTION HANDLERS ====================
@app.exception_handler(Exception)
async def global_exception_handler(request: Request, exc: Exception):
    """Global exception handler"""
    print(f"❌ Unhandled exception: {str(exc)}")
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
app.include_router(tasks_router.router)

# Drafts
app.include_router(drafts_router.router)

# Archive & Activity Logs
app.include_router(archive_router.router)

# Approvals
app.include_router(approvals.router)

# File Uploads
app.include_router(upload.router)


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
            "operational": "task_db.sqlite",
            "archive": "archive_db.sqlite"
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
        op_db = OperationalSessionLocal()
        op_db.execute("SELECT 1")
        op_db.close()
        op_status = "healthy"
    except Exception as e:
        op_status = f"unhealthy: {str(e)}"
    
    try:
        ar_db = ArchiveSessionLocal()
        ar_db.execute("SELECT 1")
        ar_db.close()
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
        op_db = OperationalSessionLocal()
        user_count = op_db.query(User).count()
        task_count = op_db.query(Task).count()
        active_tasks = op_db.query(Task).filter(Task.is_deleted == False).count()
        op_db.close()
        
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
    print("✅ Serving frontend from dist/")
    
    # Mount assets folder for JS/CSS/images
    if os.path.exists("dist/assets"):
        app.mount("/assets", StaticFiles(directory="dist/assets"), name="assets")
        print("✅ Mounted /assets")
    
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
    print("⚠️ dist folder not found - API only mode")
    
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
