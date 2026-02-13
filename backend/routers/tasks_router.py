# routers/tasks_router.py - REORDERED with correct route priority
from fastapi import APIRouter, HTTPException, Depends, Query, Cookie, Request
from sqlalchemy.orm import Session
from typing import List, Optional
from pydantic import BaseModel, Field
from datetime import datetime

from database_config import get_operational_db, get_archive_db, get_dual_db
from models_new import Task, TaskParticipant, TaskStatusHistory, User, TaskStatus, Priority, ParticipantRole
from auth import verify_session_token
from archive_service import ArchiveService
from task_helpers import TaskHelpers

router = APIRouter(prefix="/api/tasks", tags=["Tasks"])


# ==================== SCHEMAS ====================
class TaskCreate(BaseModel):
    title: str = Field(..., min_length=1, max_length=200)
    description: Optional[str] = None
    projectName: Optional[str] = None
    taskType: str = Field(default="task")
    taskTag: Optional[str] = None
    priority: str = Field(default="medium")
    toDepartment: Optional[str] = None
    deadline: Optional[str] = None
    assigneeIds: List[int] = Field(default_factory=list, description="List of assignee user IDs")


class TaskUpdate(BaseModel):
    title: Optional[str] = None
    description: Optional[str] = None
    priority: Optional[str] = None
    deadline: Optional[str] = None
    status: Optional[str] = None


# ==================== HELPER FUNCTIONS ====================
def parse_deadline(deadline_str: Optional[str]) -> Optional[datetime]:
    if not deadline_str:
        return None
    try:
        return datetime.fromisoformat(deadline_str.replace('Z', '+00:00'))
    except:
        try:
            return datetime.strptime(deadline_str, "%Y-%m-%dT%H:%M")
        except:
            return None


def get_current_user_from_session(
    session_id: Optional[str] = Cookie(None, alias="session_id"),
    db: Session = Depends(get_operational_db)
):
    """Get current user from session cookie"""
    if not session_id:
        return None
    try:
        user_id = verify_session_token(session_id)
        user = db.query(User).filter(User.id == user_id).first()
        return user
    except:
        return None


# ==================== POST ROUTES ====================
@router.post("/create")
async def create_task(
    task_data: TaskCreate,
    request: Request,
    db: Session = Depends(get_operational_db),
    archive_db: Session = Depends(get_archive_db),
    current_user: User = Depends(get_current_user_from_session)
):
    """Create a new task and assign to users"""
    if not current_user:
        raise HTTPException(status_code=401, detail="Not authenticated")
    
    try:
        deadline = parse_deadline(task_data.deadline)
        task_number = TaskHelpers.generate_task_number(db)
        
        priority_map = {
            "low": Priority.LOW,
            "medium": Priority.MEDIUM,
            "high": Priority.HIGH,
            "urgent": Priority.URGENT
        }
        priority = priority_map.get(task_data.priority.lower(), Priority.MEDIUM)
        
        new_task = Task(
            task_number=task_number,
            title=task_data.title,
            description=task_data.description,
            project_name=task_data.projectName,
            task_type=task_data.taskType,
            task_tag=task_data.taskTag,
            priority=priority,
            creator_id=current_user.id,
            from_department=current_user.department,
            to_department=task_data.toDepartment,
            status=TaskStatus.PENDING,
            workflow_stage="sent",
            deadline=deadline,
            created_at=datetime.utcnow(),
            updated_at=datetime.utcnow()
        )
        
        db.add(new_task)
        db.flush()
        
        creator_participant = TaskParticipant(
            task_id=new_task.id,
            user_id=current_user.id,
            role=ParticipantRole.CREATOR,
            is_read=True,
            added_at=datetime.utcnow()
        )
        db.add(creator_participant)
        
        for assignee_id in task_data.assigneeIds:
            assignee = db.query(User).filter(User.id == assignee_id).first()
            if assignee:
                assignee_participant = TaskParticipant(
                    task_id=new_task.id,
                    user_id=assignee_id,
                    role=ParticipantRole.ASSIGNEE,
                    is_read=False,
                    added_at=datetime.utcnow()
                )
                db.add(assignee_participant)
        
        history = TaskStatusHistory(
            task_id=new_task.id,
            user_id=current_user.id,
            status_from=None,
            status_to=TaskStatus.PENDING.value,
            action="created",
            comments=f"Task created and assigned to {len(task_data.assigneeIds)} user(s)",
            timestamp=datetime.utcnow()
        )
        db.add(history)
        
        db.commit()
        db.refresh(new_task)
        
        ArchiveService.log_activity(
            user_id=current_user.id,
            task_id=new_task.id,
            action="task_created",
            entity_type="task",
            entity_id=new_task.id,
            details={
                "task_number": task_number,
                "title": new_task.title,
                "assignee_count": len(task_data.assigneeIds)
            },
            ip_address=request.client.host if request.client else None,
            archive_db=archive_db
        )
        
        print(f"✅ Task created: {task_number} by {current_user.email}")
        
        return {
            "success": True,
            "message": "Task created successfully",
            "data": {
                **new_task.to_dict(),
                "participants": TaskHelpers.get_task_participants(new_task.id, db)
            }
        }
        
    except Exception as e:
        db.rollback()
        print(f"❌ Error creating task: {str(e)}")
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=400, detail=str(e))


@router.post("/inbox/{task_id}/mark-read")
async def mark_task_read(
    task_id: int,
    db: Session = Depends(get_operational_db),
    current_user: User = Depends(get_current_user_from_session)
):
    """Mark a task as read"""
    if not current_user:
        raise HTTPException(status_code=401, detail="Not authenticated")
    
    success = TaskHelpers.mark_as_read(task_id, current_user.id, db)
    
    if not success:
        raise HTTPException(status_code=404, detail="Task not found in your inbox")
    
    return {
        "success": True,
        "message": "Task marked as read"
    }


# ==================== GET ROUTES - SPECIFIC FIRST ====================
@router.get("/inbox/unread-count")
async def get_unread_count(
    db: Session = Depends(get_operational_db),
    current_user: User = Depends(get_current_user_from_session)
):
    """Get count of unread tasks"""
    if not current_user:
        raise HTTPException(status_code=401, detail="Not authenticated")
    
    unread_count = TaskHelpers.get_unread_count(current_user.id, db)
    
    return {
        "success": True,
        "unreadCount": unread_count
    }


@router.get("/outbox")
async def get_outbox(
    db: Session = Depends(get_operational_db),
    current_user: User = Depends(get_current_user_from_session)
):
    """Get all tasks sent by current user"""
    if not current_user:
        raise HTTPException(status_code=401, detail="Not authenticated")
    
    try:
        tasks = TaskHelpers.get_sent_tasks(current_user.id, db, include_deleted=False)
        
        result = []
        for task in tasks:
            task_dict = task.to_dict()
            task_dict["participants"] = TaskHelpers.get_task_participants(task.id, db)
            
            participants = task_dict["participants"]
            task_dict["totalRecipients"] = len(participants) - 1
            task_dict["readCount"] = sum(1 for p in participants if p["isRead"] and p["role"] != "creator")
            task_dict["unreadCount"] = task_dict["totalRecipients"] - task_dict["readCount"]
            
            result.append(task_dict)
        
        print(f"📤 Outbox: {len(tasks)} tasks for user {current_user.email}")
        
        return {
            "success": True,
            "count": len(tasks),
            "data": result,
            "user": {
                "id": current_user.id,
                "name": current_user.name,
                "email": current_user.email
            }
        }
        
    except Exception as e:
        print(f"❌ Error fetching outbox: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/inbox")
async def get_inbox(
    include_read: bool = Query(True),
    db: Session = Depends(get_operational_db),
    current_user: User = Depends(get_current_user_from_session)
):
    """Get all tasks received by current user"""
    if not current_user:
        raise HTTPException(status_code=401, detail="Not authenticated")
    
    try:
        tasks = TaskHelpers.get_received_tasks(current_user.id, db, include_read=include_read)
        unread_count = TaskHelpers.get_unread_count(current_user.id, db)
        
        result = []
        for task in tasks:
            task_dict = task.to_dict()
            
            creator = db.query(User).filter(User.id == task.creator_id).first()
            if creator:
                task_dict["sender"] = {
                    "id": creator.id,
                    "name": creator.name,
                    "email": creator.email,
                    "department": creator.department
                }
            
            my_participation = db.query(TaskParticipant).filter(
                TaskParticipant.task_id == task.id,
                TaskParticipant.user_id == current_user.id
            ).first()
            
            if my_participation:
                task_dict["isRead"] = my_participation.is_read
                task_dict["readAt"] = my_participation.read_at.isoformat() if my_participation.read_at else None
                task_dict["myRole"] = my_participation.role.value
            
            result.append(task_dict)
        
        print(f"📥 Inbox: {len(tasks)} tasks ({unread_count} unread) for user {current_user.email}")
        
        return {
            "success": True,
            "count": len(tasks),
            "unreadCount": unread_count,
            "data": result
        }
        
    except Exception as e:
        print(f"❌ Error fetching inbox: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/stats/me")
async def get_my_stats(
    db: Session = Depends(get_operational_db),
    current_user: User = Depends(get_current_user_from_session)
):
    """Get task statistics for current user"""
    if not current_user:
        raise HTTPException(status_code=401, detail="Not authenticated")
    
    stats = TaskHelpers.get_task_statistics(current_user.id, db)
    
    return {
        "success": True,
        "data": stats
    }


@router.get("/debug/current-user")
async def debug_current_user(
    db: Session = Depends(get_operational_db),
    current_user: User = Depends(get_current_user_from_session)
):
    """Debug endpoint to check authentication"""
    if not current_user:
        return {
            "authenticated": False,
            "message": "No user logged in"
        }
    
    stats = TaskHelpers.get_
