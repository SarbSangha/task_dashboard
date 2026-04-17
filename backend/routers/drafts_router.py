# routers/drafts_router.py - Updated with new schema
from fastapi import APIRouter, HTTPException, Depends, Cookie, Header
from sqlalchemy.orm import Session
from typing import Optional, List, Any, Dict
from pydantic import BaseModel, Field
from datetime import datetime

from database_config import get_operational_db
from models_new import Task, User, TaskStatus, Priority, ParticipantRole, TaskParticipant
from auth import get_request_session_token, resolve_session_user
from task_helpers import TaskHelpers

router = APIRouter(prefix="/api/drafts", tags=["Drafts"])


# ==================== SCHEMAS ====================
class DraftCreate(BaseModel):
    title: Optional[str] = Field(default="", max_length=200)
    description: Optional[str] = None
    projectName: Optional[str] = None
    taskId: Optional[str] = None
    projectId: Optional[str] = None
    projectIdRaw: Optional[str] = None
    projectIdHex: Optional[str] = None
    customerName: Optional[str] = None
    reference: Optional[str] = None
    taskType: str = Field(default="task")
    taskTag: Optional[str] = None
    priority: str = Field(default="medium")
    toDepartment: Optional[str] = None
    deadline: Optional[str] = None
    selectedUserIds: List[int] = Field(default_factory=list)
    attachments: List[Any] = Field(default_factory=list)
    links: List[str] = Field(default_factory=list)
    workflowEnabled: bool = False
    finalApprovalRequired: bool = False
    workflowStages: List[Dict[str, Any]] = Field(default_factory=list)


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


def _build_draft_metadata(draft_data: DraftCreate) -> Dict[str, Any]:
    return {
        "customerName": (draft_data.customerName or "").strip() or None,
        "reference": (draft_data.reference or "").strip() or None,
        "taskId": (draft_data.taskId or "").strip() or None,
        "selectedUserIds": [int(user_id) for user_id in (draft_data.selectedUserIds or []) if str(user_id).strip()],
        "attachments": draft_data.attachments or [],
        "links": [str(link).strip() for link in (draft_data.links or []) if str(link).strip()],
        "workflowStages": draft_data.workflowStages or [],
    }


def _is_meaningful_workflow_stage(stage: Any) -> bool:
    if not isinstance(stage, dict):
        return False
    title = f"{stage.get('title') or ''}".strip()
    description = f"{stage.get('description') or ''}".strip()
    approval_required = bool(stage.get("approvalRequired"))
    assignee_ids = [user_id for user_id in (stage.get("assigneeIds") or []) if str(user_id).strip()]
    default_stage_title = False
    if title:
        lower_title = title.lower()
        default_stage_title = lower_title.startswith("stage ") and title[6:].strip().isdigit()
    return bool(description or approval_required or assignee_ids or (title and not default_stage_title))


def _has_meaningful_draft_content(draft_data: DraftCreate) -> bool:
    text_fields = [
        draft_data.title,
        draft_data.description,
        draft_data.projectName,
        draft_data.taskId,
        draft_data.projectId,
        draft_data.customerName,
        draft_data.reference,
        draft_data.toDepartment,
        draft_data.deadline,
    ]
    if any(f"{value or ''}".strip() for value in text_fields):
        return True
    if any(str(user_id).strip() for user_id in (draft_data.selectedUserIds or [])):
        return True
    if draft_data.attachments or draft_data.links:
        return True
    if bool(draft_data.workflowEnabled) and any(_is_meaningful_workflow_stage(stage) for stage in (draft_data.workflowStages or [])):
        return True
    return False


def _serialize_draft(task: Task) -> Dict[str, Any]:
    task_dict = task.to_dict()
    meta = task.metadata_json if isinstance(task.metadata_json, dict) else {}
    task_dict.update({
        "taskId": meta.get("taskId") or task.task_number,
        "customerName": meta.get("customerName"),
        "reference": meta.get("reference"),
        "selectedUserIds": meta.get("selectedUserIds") or [],
        "attachments": meta.get("attachments") or [],
        "links": meta.get("links") or [],
        "workflowEnabled": bool(task.workflow_enabled),
        "finalApprovalRequired": bool(task.final_approval_required),
        "workflowStages": meta.get("workflowStages") or [],
    })
    return task_dict


def get_current_user_from_session(
    session_id: Optional[str] = Cookie(None, alias="session_id"),
    x_session_id: Optional[str] = Header(None, alias="X-Session-Id"),
    db: Session = Depends(get_operational_db)
):
    resolved_session_id = get_request_session_token(session_id, x_session_id)
    if not resolved_session_id:
        return None
    try:
        return resolve_session_user(resolved_session_id, db, raise_on_missing=False)
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
    if not _has_meaningful_draft_content(draft_data):
        raise HTTPException(status_code=400, detail="Add some task details before saving a draft")
    
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
            project_id=draft_data.projectId,
            project_id_raw=draft_data.projectIdRaw,
            project_id_hex=draft_data.projectIdHex,
            task_type=draft_data.taskType,
            task_tag=draft_data.taskTag,
            priority=priority,
            creator_id=current_user.id,
            from_department=current_user.department,
            to_department=draft_data.toDepartment,
            status=TaskStatus.DRAFT,
            deadline=deadline,
            workflow_enabled=bool(draft_data.workflowEnabled),
            final_approval_required=bool(draft_data.finalApprovalRequired),
            metadata_json=_build_draft_metadata(draft_data),
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
            "data": _serialize_draft(new_draft)
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
            "data": [_serialize_draft(draft) for draft in drafts]
        }
        
    except Exception as e:
        print(f"❌ Error fetching drafts: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))


# ==================== GET LATEST DRAFT ====================
@router.get("/latest")
async def get_latest_draft(
    db: Session = Depends(get_operational_db),
    current_user: User = Depends(get_current_user_from_session)
):
    """Get the most recently updated draft for the current user."""
    if not current_user:
        raise HTTPException(status_code=401, detail="Not authenticated")

    try:
        draft = db.query(Task).filter(
            Task.status == TaskStatus.DRAFT,
            Task.creator_id == current_user.id,
            Task.is_deleted == False
        ).order_by(Task.updated_at.desc(), Task.created_at.desc()).first()

        if not draft:
            raise HTTPException(status_code=404, detail="No draft found")

        return _serialize_draft(draft)

    except HTTPException:
        raise
    except Exception as e:
        print(f"❌ Error fetching latest draft: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/{draft_id}")
async def get_draft_by_id(
    draft_id: int,
    db: Session = Depends(get_operational_db),
    current_user: User = Depends(get_current_user_from_session)
):
    """Get a single draft for editing."""
    if not current_user:
        raise HTTPException(status_code=401, detail="Not authenticated")

    draft = db.query(Task).filter(
        Task.id == draft_id,
        Task.creator_id == current_user.id,
        Task.status == TaskStatus.DRAFT,
        Task.is_deleted == False,
    ).first()

    if not draft:
        raise HTTPException(status_code=404, detail="Draft not found or access denied")

    return {
        "success": True,
        "data": _serialize_draft(draft)
    }


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
    if not _has_meaningful_draft_content(draft_data):
        raise HTTPException(status_code=400, detail="Add some task details before saving a draft")
    
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
        draft.project_id = draft_data.projectId
        draft.project_id_raw = draft_data.projectIdRaw
        draft.project_id_hex = draft_data.projectIdHex
        draft.task_type = draft_data.taskType
        draft.task_tag = draft_data.taskTag
        draft.priority = priority
        draft.to_department = draft_data.toDepartment
        draft.deadline = deadline
        draft.workflow_enabled = bool(draft_data.workflowEnabled)
        draft.final_approval_required = bool(draft_data.finalApprovalRequired)
        draft.metadata_json = _build_draft_metadata(draft_data)
        draft.updated_at = datetime.utcnow()
        
        db.commit()
        db.refresh(draft)
        
        print(f"✅ Draft updated: {draft_id} by {current_user.email}")
        
        return {
            "success": True,
            "message": "Draft updated successfully",
            "data": _serialize_draft(draft)
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
