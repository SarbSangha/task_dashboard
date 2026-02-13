# routers/archive_router.py - View archived tasks and activity logs
from fastapi import APIRouter, HTTPException, Depends, Query, Cookie
from sqlalchemy.orm import Session
from typing import Optional, List
from datetime import datetime, timedelta

from database_config import get_operational_db, get_archive_db, get_dual_db
from models_new import User, Task, ArchivedTask, ActivityLog
from auth import verify_session_token
from archive_service import ArchiveService
from task_helpers import TaskHelpers

router = APIRouter(prefix="/api/archive", tags=["Archive"])


# ==================== HELPER FUNCTIONS ====================
def get_current_user_from_session(
    session_id: Optional[str] = Cookie(None, alias="session_id"),
    db: Session = Depends(get_operational_db)
):
    if not session_id:
        return None
    try:
        user_id = verify_session_token(session_id)
        user = db.query(User).filter(User.id == user_id).first()
        return user
    except:
        return None


# ==================== GET ARCHIVED TASKS ====================
@router.get("/tasks")
async def get_archived_tasks(
    limit: int = Query(50, le=200),
    offset: int = Query(0, ge=0),
    reason: Optional[str] = Query(None, description="Filter by archive reason"),
    operational_db: Session = Depends(get_operational_db),
    archive_db: Session = Depends(get_archive_db),
    current_user: User = Depends(get_current_user_from_session)
):
    """Get archived tasks for current user"""
    if not current_user:
        raise HTTPException(status_code=401, detail="Not authenticated")
    
    try:
        # Query archived tasks
        query = archive_db.query(ArchivedTask)
        
        # Filter by reason if provided
        if reason:
            query = query.filter(ArchivedTask.archive_reason == reason)
        
        # Order by most recent
        query = query.order_by(ArchivedTask.archived_at.desc())
        
        total = query.count()
        archived_tasks = query.offset(offset).limit(limit).all()
        
        # Filter to only show user's own tasks
        result = []
        for archived in archived_tasks:
            task_data = archived.task_data
            
            # Only show if user was creator
            if task_data.get("creatorId") == current_user.id:
                result.append({
                    "archiveId": archived.id,
                    "originalTaskId": archived.original_task_id,
                    "taskNumber": task_data.get("taskNumber"),
                    "title": task_data.get("title"),
                    "status": task_data.get("status"),
                    "archivedAt": archived.archived_at.isoformat() if archived.archived_at else None,
                    "archiveReason": archived.archive_reason,
                    "canRestore": archived.archive_reason == "deleted"  # Only deleted tasks can be restored
                })
        
        print(f"📦 Found {len(result)} archived tasks for user {current_user.email}")
        
        return {
            "success": True,
            "count": len(result),
            "total": total,
            "data": result
        }
        
    except Exception as e:
        print(f"❌ Error fetching archived tasks: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))


# ==================== GET ARCHIVED TASK DETAILS ====================
@router.get("/tasks/{archive_id}")
async def get_archived_task_details(
    archive_id: int,
    operational_db: Session = Depends(get_operational_db),
    archive_db: Session = Depends(get_archive_db),
    current_user: User = Depends(get_current_user_from_session)
):
    """Get full details of an archived task"""
    if not current_user:
        raise HTTPException(status_code=401, detail="Not authenticated")
    
    try:
        archived = archive_db.query(ArchivedTask).filter(
            ArchivedTask.id == archive_id
        ).first()
        
        if not archived:
            raise HTTPException(status_code=404, detail="Archived task not found")
        
        task_data = archived.task_data
        
        # Check if user has access (was creator or participant)
        creator_id = task_data.get("creatorId")
        participants = task_data.get("participants", [])
        participant_ids = [p.get("userId") for p in participants]
        
        if current_user.id != creator_id and current_user.id not in participant_ids:
            raise HTTPException(status_code=403, detail="Access denied")
        
        return {
            "success": True,
            "data": {
                "archiveId": archived.id,
                "archivedAt": archived.archived_at.isoformat() if archived.archived_at else None,
                "archiveReason": archived.archive_reason,
                "taskData": task_data,
                "canRestore": archived.archive_reason == "deleted" and creator_id == current_user.id
            }
        }
        
    except HTTPException:
        raise
    except Exception as e:
        print(f"❌ Error fetching archived task details: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))


# ==================== RESTORE ARCHIVED TASK ====================
@router.post("/tasks/{archive_id}/restore")
async def restore_archived_task(
    archive_id: int,
    operational_db: Session = Depends(get_operational_db),
    archive_db: Session = Depends(get_archive_db),
    current_user: User = Depends(get_current_user_from_session)
):
    """Restore a deleted task from archive"""
    if not current_user:
        raise HTTPException(status_code=401, detail="Not authenticated")
    
    try:
        # Get archived task
        archived = archive_db.query(ArchivedTask).filter(
            ArchivedTask.id == archive_id
        ).first()
        
        if not archived:
            raise HTTPException(status_code=404, detail="Archived task not found")
        
        # Only deleted tasks can be restored
        if archived.archive_reason != "deleted":
            raise HTTPException(
                status_code=400,
                detail=f"Cannot restore task with reason: {archived.archive_reason}"
            )
        
        task_data = archived.task_data
        
        # Only creator can restore
        if task_data.get("creatorId") != current_user.id:
            raise HTTPException(status_code=403, detail="Only creator can restore task")
        
        # Check if task still exists in operational DB (soft deleted)
        existing_task = operational_db.query(Task).filter(
            Task.id == archived.original_task_id
        ).first()
        
        if existing_task:
            # Simply undelete
            existing_task.is_deleted = False
            existing_task.deleted_at = None
            existing_task.deleted_by = None
            operational_db.commit()
            
            print(f"✅ Task {existing_task.id} restored from soft delete")
            
            # Log activity
            ArchiveService.log_activity(
                user_id=current_user.id,
                task_id=existing_task.id,
                action="task_restored",
                entity_type="task",
                entity_id=existing_task.id,
                details={
                    "archive_id": archive_id,
                    "restored_from": "soft_delete"
                },
                archive_db=archive_db
            )
            
            return {
                "success": True,
                "message": "Task restored successfully",
                "taskId": existing_task.id
            }
        else:
            # Task was hard deleted, need to recreate (not implemented for safety)
            raise HTTPException(
                status_code=400,
                detail="Task was permanently deleted and cannot be restored automatically"
            )
        
    except HTTPException:
        raise
    except Exception as e:
        operational_db.rollback()
        print(f"❌ Error restoring task: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))


# ==================== GET ACTIVITY LOG ====================
@router.get("/activity")
async def get_activity_log(
    limit: int = Query(100, le=500),
    offset: int = Query(0, ge=0),
    action_filter: Optional[str] = Query(None, description="Filter by action type"),
    task_id: Optional[int] = Query(None, description="Filter by task ID"),
    days: int = Query(30, description="Number of days to look back"),
    operational_db: Session = Depends(get_operational_db),
    archive_db: Session = Depends(get_archive_db),
    current_user: User = Depends(get_current_user_from_session)
):
    """Get activity log for current user"""
    if not current_user:
        raise HTTPException(status_code=401, detail="Not authenticated")
    
    try:
        # Calculate date range
        since_date = datetime.utcnow() - timedelta(days=days)
        
        # Query activities
        query = archive_db.query(ActivityLog).filter(
            ActivityLog.user_id == current_user.id,
            ActivityLog.timestamp >= since_date
        )
        
        # Apply filters
        if action_filter:
            query = query.filter(ActivityLog.action == action_filter)
        
        if task_id:
            query = query.filter(ActivityLog.task_id == task_id)
        
        # Order by most recent
        query = query.order_by(ActivityLog.timestamp.desc())
        
        total = query.count()
        activities = query.offset(offset).limit(limit).all()
        
        result = [activity.to_dict() for activity in activities]
        
        print(f"📝 Found {len(result)} activity logs for user {current_user.email}")
        
        return {
            "success": True,
            "count": len(result),
            "total": total,
            "data": result
        }
        
    except Exception as e:
        print(f"❌ Error fetching activity log: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))


# ==================== GET TASK COMPLETE HISTORY ====================
@router.get("/tasks/{task_id}/history")
async def get_task_complete_history(
    task_id: int,
    operational_db: Session = Depends(get_operational_db),
    archive_db: Session = Depends(get_archive_db),
    current_user: User = Depends(get_current_user_from_session)
):
    """Get complete audit trail for a specific task"""
    if not current_user:
        raise HTTPException(status_code=401, detail="Not authenticated")
    
    try:
        # Check if user has access to this task
        if not TaskHelpers.can_user_access_task(task_id, current_user.id, operational_db):
            raise HTTPException(status_code=403, detail="Access denied")
        
        # Get all activities for this task
        history = ArchiveService.get_task_history(task_id, archive_db)
        
        return {
            "success": True,
            "taskId": task_id,
            "count": len(history),
            "data": history
        }
        
    except HTTPException:
        raise
    except Exception as e:
        print(f"❌ Error fetching task history: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))


# ==================== GET MY ACTIVITY SUMMARY ====================
@router.get("/activity/summary")
async def get_activity_summary(
    days: int = Query(30, description="Number of days to analyze"),
    operational_db: Session = Depends(get_operational_db),
    archive_db: Session = Depends(get_archive_db),
    current_user: User = Depends(get_current_user_from_session)
):
    """Get activity summary statistics for current user"""
    if not current_user:
        raise HTTPException(status_code=401, detail="Not authenticated")
    
    try:
        since_date = datetime.utcnow() - timedelta(days=days)
        
        # Get all activities
        activities = archive_db.query(ActivityLog).filter(
            ActivityLog.user_id == current_user.id,
            ActivityLog.timestamp >= since_date
        ).all()
        
        # Count by action type
        action_counts = {}
        for activity in activities:
            action = activity.action
            action_counts[action] = action_counts.get(action, 0) + 1
        
        # Count by day
        daily_activity = {}
        for activity in activities:
            date_key = activity.timestamp.date().isoformat()
            daily_activity[date_key] = daily_activity.get(date_key, 0) + 1
        
        return {
            "success": True,
            "period": f"Last {days} days",
            "totalActivities": len(activities),
            "byAction": action_counts,
            "byDay": daily_activity
        }
        
    except Exception as e:
        print(f"❌ Error generating activity summary: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))


# ==================== PERMANENTLY DELETE ARCHIVED TASK ====================
@router.delete("/tasks/{archive_id}/permanent")
async def permanently_delete_archived_task(
    archive_id: int,
    operational_db: Session = Depends(get_operational_db),
    archive_db: Session = Depends(get_archive_db),
    current_user: User = Depends(get_current_user_from_session)
):
    """Permanently delete an archived task (admin only - use with caution)"""
    if not current_user:
        raise HTTPException(status_code=401, detail="Not authenticated")
    
    # Only allow for admins (you can add admin check here)
    # if current_user.position != "Admin":
    #     raise HTTPException(status_code=403, detail="Admin access required")
    
    try:
        archived = archive_db.query(ArchivedTask).filter(
            ArchivedTask.id == archive_id
        ).first()
        
        if not archived:
            raise HTTPException(status_code=404, detail="Archived task not found")
        
        task_data = archived.task_data
        
        # Only creator can permanently delete
        if task_data.get("creatorId") != current_user.id:
            raise HTTPException(status_code=403, detail="Only creator can permanently delete")
        
        # Delete from archive
        archive_db.delete(archived)
        archive_db.commit()
        
        print(f"🗑️ Permanently deleted archived task {archive_id}")
        
        # Log the permanent deletion
        ArchiveService.log_activity(
            user_id=current_user.id,
            action="archived_task_permanently_deleted",
            entity_type="archived_task",
            entity_id=archive_id,
            details={"archive_id": archive_id},
            archive_db=archive_db
        )
        
        return {
            "success": True,
            "message": "Archived task permanently deleted"
        }
        
    except HTTPException:
        raise
    except Exception as e:
        archive_db.rollback()
        print(f"❌ Error permanently deleting: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))
