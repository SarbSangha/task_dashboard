# routers/drafts_router.py - Updated with new schema
from fastapi import APIRouter, HTTPException, Depends, Cookie
from sqlalchemy.orm import Session
from typing import Optional
from pydantic import BaseModel, Field
from datetime import datetime

from database_config import get_operational_db
from models_new import Task, User, TaskStatus, Priority, ParticipantRole, TaskParticipant
from auth import verify_session_token
from task_helpers import TaskHelpers

router = APIRouter(prefix="/api/drafts", tags=["Drafts"])


# ==================== SCHEMAS ====================
class DraftCreate(BaseModel):
    title: Optional[str] = Field(default="", max_length=200)
    description: Optional[str] = None
    projectName: Optional[str] = None
    taskType: str = Field(default="task")
    taskTag: Optional[str] = None
    priority: str = Field(default="medium")
    toDepartment: Optional[str] = None
    deadline: Optional[str] = None


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
    if not session_id:
        return None
    try:
        user_id = verify_session_token(session_id)
        user = db.query(User).filter(User.id == user_id).first()
        return user
    except:
        return None


# ==================== CREATE DRAFT ====================
@router.post("/save")
async def save_draft(
    draft_data: DraftCreate,
    db: Session = Depends(get_operational_db),
    current_user: User = Depends(get_current_user_from_session)
):
    """Save a new draft"""
    if not current_user:
        raise HTTPException(status_code=401, detail="Not authenticated")
    
    try:
        deadline = parse_deadline(draft_data.deadline)
        task_number = TaskHelpers.generate_task_number(db)
        
        priority_map = {
            "low": Priority.LOW,
            "medium": Priority.MEDIUM,
            "high": Priority.HIGH,
            "urgent": Priority.URGENT
        }
        priority = priority_map.get(draft_data.priority.lower(), Priority.MEDIUM)
        
        new_draft = Task(
            task_number=task_number,
            title=draft_data.title or "Untitled Draft",
            description=draft_data.description,
            project_name=draft_data.projectName,
            task_type=draft_data.taskType,
            task_tag=draft_data.taskTag,
            priority=priority,
            creator_id=current_user.id,
            from_department=current_user.department,
            to_department=draft_data.toDepartment,
            status=TaskStatus.DRAFT,
            deadline=deadline,
            created_at=datetime.utcnow(),
            updated_at=datetime.utcnow()
        )
        
        db.add(new_draft)
        db.flush()
        
        # Add creator as participant
        creator_participant = TaskParticipant(
            task_id=new_draft.id,
            user_id=current_user.id,
            role=ParticipantRole.CREATOR,
            is_read=True,
            added_at=datetime.utcnow()
        )
        db.add(creator_participant)
        
        db.commit()
        db.refresh(new_draft)
        
        print(f"✅ Draft saved: {task_number} by {current_user.email}")
        
        return {
            "success": True,
            "message": "Draft saved successfully",
            "data": new_draft.to_dict()
        }
        
    except Exception as e:
        db.rollback()
        print(f"❌ Error saving draft: {str(e)}")
        raise HTTPException(status_code=400, detail=str(e))


# ==================== GET ALL DRAFTS ====================
@router.get("/")
async def get_drafts(
    db: Session = Depends(get_operational_db),
    current_user: User = Depends(get_current_user_from_session)
):
    """Get all drafts for current user"""
    if not current_user:
        raise HTTPException(status_code=401, detail="Not authenticated")
    
    try:
        drafts = db.query(Task).filter(
            Task.status == TaskStatus.DRAFT,
            Task.creator_id == current_user.id,
            Task.is_deleted == False
        ).order_by(Task.updated_at.desc()).all()
        
        print(f"📝 Found {len(drafts)} drafts for user {current_user.email}")
        
        return {
            "success": True,
            "count": len(drafts),
            "data": [draft.to_dict() for draft in drafts]
        }
        
    except Exception as e:
        print(f"❌ Error fetching drafts: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))


# ==================== UPDATE DRAFT ====================
@router.put("/{draft_id}")
async def update_draft(
    draft_id: int,
    draft_data: DraftCreate,
    db: Session = Depends(get_operational_db),
    current_user: User = Depends(get_current_user_from_session)
):
    """Update an existing draft"""
    if not current_user:
        raise HTTPException(status_code=401, detail="Not authenticated")
    
    draft = db.query(Task).filter(
        Task.id == draft_id,
        Task.creator_id == current_user.id,
        Task.status == TaskStatus.DRAFT
    ).first()
    
    if not draft:
        raise HTTPException(status_code=404, detail="Draft not found or access denied")
    
    try:
        deadline = parse_deadline(draft_data.deadline)
        
        priority_map = {
            "low": Priority.LOW,
            "medium": Priority.MEDIUM,
            "high": Priority.HIGH,
            "urgent": Priority.URGENT
        }
        priority = priority_map.get(draft_data.priority.lower(), Priority.MEDIUM)
        
        draft.title = draft_data.title or "Untitled Draft"
        draft.description = draft_data.description
        draft.project_name = draft_data.projectName
        draft.task_type = draft_data.taskType
        draft.task_tag = draft_data.taskTag
        draft.priority = priority
        draft.to_department = draft_data.toDepartment
        draft.deadline = deadline
        draft.updated_at = datetime.utcnow()
        
        db.commit()
        db.refresh(draft)
        
        print(f"✅ Draft updated: {draft_id} by {current_user.email}")
        
        return {
            "success": True,
            "message": "Draft updated successfully",
            "data": draft.to_dict()
        }
        
    except Exception as e:
        db.rollback()
        print(f"❌ Error updating draft: {str(e)}")
        raise HTTPException(status_code=400, detail=str(e))


# ==================== DELETE DRAFT ====================
@router.delete("/{draft_id}")
async def delete_draft(
    draft_id: int,
    db: Session = Depends(get_operational_db),
    current_user: User = Depends(get_current_user_from_session)
):
    """Delete a draft"""
    if not current_user:
        raise HTTPException(status_code=401, detail="Not authenticated")
    
    draft = db.query(Task).filter(
        Task.id == draft_id,
        Task.creator_id == current_user.id,
        Task.status == TaskStatus.DRAFT
    ).first()
    
    if not draft:
        raise HTTPException(status_code=404, detail="Draft not found or access denied")
    
    try:
        db.delete(draft)
        db.commit()
        
        print(f"✅ Draft deleted: {draft_id} by {current_user.email}")
        
        return {
            "success": True,
            "message": "Draft deleted successfully"
        }
        
    except Exception as e:
        db.rollback()
        print(f"❌ Error deleting draft: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))
