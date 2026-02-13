# routers/approvals.py
from fastapi import APIRouter, HTTPException, Depends, Cookie
from sqlalchemy.orm import Session
from typing import Optional
from datetime import datetime

# ✅ UPDATED IMPORTS
from database_config import get_operational_db as get_db
from models_new import Task, User
from auth import verify_session_token

router = APIRouter(prefix="/api/approvals", tags=["Approvals"])


# ==================== HELPER FUNCTIONS ====================
def get_current_user_from_session(
    session_id: Optional[str] = Cookie(None, alias="session_id"),
    db: Session = Depends(get_db)
):
    """Get current user from session"""
    if not session_id:
        return None
    try:
        user_id = verify_session_token(session_id)
        user = db.query(User).filter(User.id == user_id).first()
        return user
    except:
        return None


# ==================== APPROVAL ENDPOINTS ====================
@router.get("/pending")
async def get_pending_approvals(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user_from_session)
):
    """Get tasks pending approval for current user"""
    if not current_user:
        raise HTTPException(status_code=401, detail="Not authenticated")
    
    try:
        # Get tasks that need approval from this user
        pending_tasks = db.query(Task).filter(
            Task.status == "submitted",
            # Add your approval logic here
        ).all()
        
        return {
            "success": True,
            "count": len(pending_tasks),
            "data": [task.to_dict() for task in pending_tasks]
        }
    except Exception as e:
        print(f"❌ Error fetching pending approvals: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/{task_id}/approve")
async def approve_task(
    task_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user_from_session)
):
    """Approve a task"""
    if not current_user:
        raise HTTPException(status_code=401, detail="Not authenticated")
    
    task = db.query(Task).filter(Task.id == task_id).first()
    
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")
    
    try:
        # Update task status
        task.status = "approved"
        task.updated_at = datetime.utcnow()
        
        db.commit()
        db.refresh(task)
        
        print(f"✅ Task {task_id} approved by {current_user.email}")
        
        return {
            "success": True,
            "message": "Task approved successfully",
            "data": task.to_dict()
        }
    except Exception as e:
        db.rollback()
        print(f"❌ Error approving task: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/{task_id}/reject")
async def reject_task(
    task_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user_from_session)
):
    """Reject a task"""
    if not current_user:
        raise HTTPException(status_code=401, detail="Not authenticated")
    
    task = db.query(Task).filter(Task.id == task_id).first()
    
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")
    
    try:
        # Update task status
        task.status = "rejected"
        task.updated_at = datetime.utcnow()
        
        db.commit()
        db.refresh(task)
        
        print(f"⚠️ Task {task_id} rejected by {current_user.email}")
        
        return {
            "success": True,
            "message": "Task rejected",
            "data": task.to_dict()
        }
    except Exception as e:
        db.rollback()
        print(f"❌ Error rejecting task: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))
