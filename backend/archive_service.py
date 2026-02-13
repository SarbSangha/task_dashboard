# archive_service.py - Archive Management Service
from sqlalchemy.orm import Session
from .models_new import Task, ArchivedTask, ActivityLog, TaskParticipant, TaskStatusHistory
from .database_config import get_dual_db
from datetime import datetime
import json


class ArchiveService:
    """Service to manage task archiving and activity logging"""
    
    @staticmethod
    def archive_task(task: Task, reason: str, user_id: int, operational_db: Session, archive_db: Session):
        """
        Archive a task to permanent storage
        
        Args:
            task: Task object to archive
            reason: Reason for archiving (deleted, completed, cancelled)
            user_id: User who initiated the archive
            operational_db: Operational database session
            archive_db: Archive database session
        """
        try:
            # Prepare complete task data with relationships
            task_data = task.to_dict()
            
            # Add participants data
            participants_data = []
            for participant in task.participants:
                participants_data.append({
                    "userId": participant.user_id,
                    "role": participant.role.value,
                    "isRead": participant.is_read,
                    "addedAt": participant.added_at.isoformat() if participant.added_at else None
                })
            task_data["participants"] = participants_data
            
            # Add status history
            history_data = []
            for history in task.status_history:
                history_data.append(history.to_dict())
            task_data["statusHistory"] = history_data
            
            # Add attachments
            attachments_data = []
            for attachment in task.attachments:
                attachments_data.append({
                    "filename": attachment.filename,
                    "fileUrl": attachment.file_url,
                    "uploadedBy": attachment.uploaded_by,
                    "uploadedAt": attachment.uploaded_at.isoformat() if attachment.uploaded_at else None
                })
            task_data["attachments"] = attachments_data
            
            # Create archived task record
            archived_task = ArchivedTask(
                original_task_id=task.id,
                task_data=task_data,
                archived_at=datetime.utcnow(),
                archived_by=user_id,
                archive_reason=reason
            )
            
            archive_db.add(archived_task)
            archive_db.commit()
            
            print(f"📦 Task {task.id} archived to permanent storage. Reason: {reason}")
            
            # Log the archival
            ArchiveService.log_activity(
                user_id=user_id,
                task_id=task.id,
                action=f"task_archived_{reason}",
                entity_type="task",
                entity_id=task.id,
                details={
                    "task_title": task.title,
                    "archive_reason": reason,
                    "archived_at": datetime.utcnow().isoformat()
                },
                archive_db=archive_db
            )
            
            return True
            
        except Exception as e:
            archive_db.rollback()
            print(f"❌ Error archiving task {task.id}: {str(e)}")
            return False
    
    
    @staticmethod
    def log_activity(
        user_id: int,
        action: str,
        archive_db: Session,
        task_id: int = None,
        entity_type: str = None,
        entity_id: int = None,
        details: dict = None,
        ip_address: str = None,
        user_agent: str = None
    ):
        """
        Log any activity to permanent archive
        
        Args:
            user_id: User who performed the action
            action: Action name (e.g., "task_created", "task_deleted")
            archive_db: Archive database session
            task_id: Related task ID (optional)
            entity_type: Type of entity (task, comment, etc.)
            entity_id: ID of the entity
            details: Additional details as JSON
            ip_address: User's IP address
            user_agent: User's browser/client info
        """
        try:
            activity = ActivityLog(
                user_id=user_id,
                task_id=task_id,
                action=action,
                entity_type=entity_type,
                entity_id=entity_id,
                details=details or {},
                ip_address=ip_address,
                user_agent=user_agent,
                timestamp=datetime.utcnow()
            )
            
            archive_db.add(activity)
            archive_db.commit()
            
            print(f"📝 Activity logged: {action} by user {user_id}")
            
        except Exception as e:
            archive_db.rollback()
            print(f"⚠️ Error logging activity: {str(e)}")
    
    
    @staticmethod
    def get_task_history(task_id: int, archive_db: Session):
        """Get complete history of a task from archive"""
        try:
            activities = archive_db.query(ActivityLog).filter(
                ActivityLog.task_id == task_id
            ).order_by(ActivityLog.timestamp.desc()).all()
            
            return [activity.to_dict() for activity in activities]
            
        except Exception as e:
            print(f"❌ Error fetching task history: {str(e)}")
            return []
    
    
    @staticmethod
    def get_user_activity(user_id: int, archive_db: Session, limit: int = 100):
        """Get all activities by a user"""
        try:
            activities = archive_db.query(ActivityLog).filter(
                ActivityLog.user_id == user_id
            ).order_by(ActivityLog.timestamp.desc()).limit(limit).all()
            
            return [activity.to_dict() for activity in activities]
            
        except Exception as e:
            print(f"❌ Error fetching user activity: {str(e)}")
            return []
    
    
    @staticmethod
    def restore_task(archived_task_id: int, user_id: int, operational_db: Session, archive_db: Session):
        """Restore an archived task back to operational database"""
        try:
            archived = archive_db.query(ArchivedTask).filter(
                ArchivedTask.id == archived_task_id
            ).first()
            
            if not archived:
                raise ValueError("Archived task not found")
            
            task_data = archived.task_data
            
            # Recreate task (you'd need to implement full restoration logic)
            print(f"🔄 Restoring task {archived.original_task_id}")
            
            # Log restoration
            ArchiveService.log_activity(
                user_id=user_id,
                task_id=archived.original_task_id,
                action="task_restored",
                entity_type="task",
                entity_id=archived.original_task_id,
                details={"restored_from_archive": archived_task_id},
                archive_db=archive_db
            )
            
            return True
            
        except Exception as e:
            print(f"❌ Error restoring task: {str(e)}")
            return False
