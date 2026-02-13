# task_helpers.py - Helper functions for task operations
from sqlalchemy.orm import Session
from models_new import Task, TaskParticipant, User, ParticipantRole, TaskStatus
from typing import List, Optional
from datetime import datetime


class TaskHelpers:
    """Utility functions for task management"""
    
    @staticmethod
    def get_sent_tasks(user_id: int, db: Session, include_deleted: bool = False) -> List[Task]:
        """
        Get all tasks created/sent by a user
        
        Args:
            user_id: User ID
            db: Database session
            include_deleted: Whether to include deleted tasks
            
        Returns:
            List of tasks created by the user
        """
        query = db.query(Task).filter(Task.creator_id == user_id)
        
        if not include_deleted:
            query = query.filter(Task.is_deleted == False)
        
        tasks = query.order_by(Task.created_at.desc()).all()
        
        print(f"📤 Found {len(tasks)} sent tasks for user {user_id}")
        return tasks
    
    
    @staticmethod
    def get_received_tasks(user_id: int, db: Session, include_read: bool = True) -> List[Task]:
        """
        Get all tasks received by a user (where they're assignee/reviewer)
        
        Args:
            user_id: User ID
            db: Database session
            include_read: Whether to include already-read tasks
            
        Returns:
            List of tasks received by the user
        """
        query = db.query(Task).join(TaskParticipant).filter(
            TaskParticipant.user_id == user_id,
            TaskParticipant.role.in_([ParticipantRole.ASSIGNEE, ParticipantRole.REVIEWER]),
            TaskParticipant.is_active == True,
            Task.is_deleted == False
        )
        
        if not include_read:
            query = query.filter(TaskParticipant.is_read == False)
        
        tasks = query.order_by(Task.created_at.desc()).all()
        
        print(f"📥 Found {len(tasks)} received tasks for user {user_id}")
        return tasks
    
    
    @staticmethod
    def get_unread_count(user_id: int, db: Session) -> int:
        """Get count of unread tasks for a user"""
        count = db.query(TaskParticipant).join(Task).filter(
            TaskParticipant.user_id == user_id,
            TaskParticipant.is_read == False,
            TaskParticipant.is_active == True,
            Task.is_deleted == False
        ).count()
        
        return count
    
    
    @staticmethod
    def mark_as_read(task_id: int, user_id: int, db: Session) -> bool:
        """Mark a task as read for a specific user"""
        try:
            participant = db.query(TaskParticipant).filter(
                TaskParticipant.task_id == task_id,
                TaskParticipant.user_id == user_id
            ).first()
            
            if participant and not participant.is_read:
                participant.is_read = True
                participant.read_at = datetime.utcnow()
                db.commit()
                print(f"✅ Task {task_id} marked as read by user {user_id}")
                return True
            
            return False
            
        except Exception as e:
            db.rollback()
            print(f"❌ Error marking task as read: {str(e)}")
            return False
    
    
    @staticmethod
    def add_participant(
        task_id: int,
        user_id: int,
        role: ParticipantRole,
        db: Session
    ) -> bool:
        """Add a participant to a task"""
        try:
            # Check if already exists
            existing = db.query(TaskParticipant).filter(
                TaskParticipant.task_id == task_id,
                TaskParticipant.user_id == user_id,
                TaskParticipant.role == role
            ).first()
            
            if existing:
                print(f"⚠️ Participant already exists")
                return False
            
            participant = TaskParticipant(
                task_id=task_id,
                user_id=user_id,
                role=role,
                is_read=False,
                is_active=True,
                added_at=datetime.utcnow()
            )
            
            db.add(participant)
            db.commit()
            
            print(f"✅ Added participant: User {user_id} as {role.value} to task {task_id}")
            return True
            
        except Exception as e:
            db.rollback()
            print(f"❌ Error adding participant: {str(e)}")
            return False
    
    
    @staticmethod
    def get_task_participants(task_id: int, db: Session) -> List[dict]:
        """Get all participants of a task with their user info"""
        participants = db.query(TaskParticipant).join(User).filter(
            TaskParticipant.task_id == task_id,
            TaskParticipant.is_active == True
        ).all()
        
        result = []
        for participant in participants:
            result.append({
                "userId": participant.user_id,
                "userName": participant.user.name,
                "userEmail": participant.user.email,
                "userDepartment": participant.user.department,
                "role": participant.role.value,
                "isRead": participant.is_read,
                "readAt": participant.read_at.isoformat() if participant.read_at else None,
                "addedAt": participant.added_at.isoformat() if participant.added_at else None
            })
        
        return result
    
    
    @staticmethod
    def generate_task_number(db: Session) -> str:
        """Generate unique task number: TASK-YYYY-XXXX"""
        year = datetime.now().year
        
        # Get count of tasks this year
        count = db.query(Task).filter(
            Task.task_number.like(f"TASK-{year}-%")
        ).count()
        
        next_number = count + 1
        task_number = f"TASK-{year}-{next_number:04d}"
        
        return task_number
    
    
    @staticmethod
    def can_user_access_task(task_id: int, user_id: int, db: Session) -> bool:
        """Check if a user can access a task"""
        task = db.query(Task).filter(Task.id == task_id).first()
        
        if not task:
            return False
        
        # Creator can always access
        if task.creator_id == user_id:
            return True
        
        # Check if user is a participant
        participant = db.query(TaskParticipant).filter(
            TaskParticipant.task_id == task_id,
            TaskParticipant.user_id == user_id,
            TaskParticipant.is_active == True
        ).first()
        
        return participant is not None
    
    
    @staticmethod
    def get_task_statistics(user_id: int, db: Session) -> dict:
        """Get task statistics for a user"""
        # Sent tasks
        sent_total = db.query(Task).filter(
            Task.creator_id == user_id,
            Task.is_deleted == False
        ).count()
        
        # Received tasks
        received_total = db.query(TaskParticipant).join(Task).filter(
            TaskParticipant.user_id == user_id,
            TaskParticipant.is_active == True,
            Task.is_deleted == False
        ).count()
        
        # Unread
        unread = TaskHelpers.get_unread_count(user_id, db)
        
        # By status (received tasks)
        pending = db.query(Task).join(TaskParticipant).filter(
            TaskParticipant.user_id == user_id,
            Task.status == TaskStatus.PENDING,
            Task.is_deleted == False
        ).count()
        
        in_progress = db.query(Task).join(TaskParticipant).filter(
            TaskParticipant.user_id == user_id,
            Task.status == TaskStatus.IN_PROGRESS,
            Task.is_deleted == False
        ).count()
        
        completed = db.query(Task).join(TaskParticipant).filter(
            TaskParticipant.user_id == user_id,
            Task.status == TaskStatus.COMPLETED,
            Task.is_deleted == False
        ).count()
        
        return {
            "sent": {
                "total": sent_total
            },
            "received": {
                "total": received_total,
                "unread": unread,
                "pending": pending,
                "inProgress": in_progress,
                "completed": completed
            }
        }
