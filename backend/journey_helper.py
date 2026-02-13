# journey_helper.py - ENHANCED VERSION

from sqlalchemy.orm import Session
from .database_config import get_operational_db
from .models_new import Task, TaskStatusHistory, User
from datetime import datetime
from typing import Optional, Dict, Any

def add_journey_entry(
    db: Session,
    task_id: int,
    user_id: Optional[int],
    action: str,
    status_after: str,
    status_before: Optional[str] = None,
    from_dept: Optional[str] = None,
    to_dept: Optional[str] = None,
    comments: Optional[str] = None,
    extra_data: Optional[Dict[str, Any]] = None
):
    """
    Add a journey entry with complete user information
    """
    user_name = None
    user_position = None
    user_department = None
    
    # Fetch user details if user_id provided
    if user_id:
        user = db.query(User).filter(User.id == user_id).first()
        if user:
            user_name = user.name
            user_position = user.position
            user_department = user.department
    
    journey_entry = TaskJourney(
        task_id=task_id,
        user_id=user_id,
        user_name=user_name,
        user_position=user_position,
        user_department=user_department,
        action=action,
        status_before=status_before,
        status_after=status_after,
        from_department=from_dept,
        to_department=to_dept,
        comments=comments,
        extra_data=extra_data or {},
        timestamp=datetime.utcnow()
    )
    
    db.add(journey_entry)
    
    # Log for debugging
    print(f"📝 Journey Entry: Task {task_id} - {action} by {user_name or 'System'} ({user_id})")
    
    return journey_entry


def get_task_journey(db: Session, task_id: int):
    """Get complete journey history for a task"""
    journey_entries = db.query(TaskJourney).filter(
        TaskJourney.task_id == task_id
    ).order_by(TaskJourney.timestamp.asc()).all()
    
    return [entry.to_dict() for entry in journey_entries]
