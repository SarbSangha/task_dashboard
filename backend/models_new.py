# models_new.py - New Database Models
from sqlalchemy import Column, Integer, String, Text, DateTime, Boolean, ForeignKey, JSON, Enum as SQLEnum
from sqlalchemy.orm import relationship
from datetime import datetime
from .database_config import Base, ArchiveBase
import enum


# ==================== ENUMS ====================
class TaskStatus(enum.Enum):
    DRAFT = "draft"
    PENDING = "pending"
    IN_PROGRESS = "in_progress"
    SUBMITTED = "submitted"
    UNDER_REVIEW = "under_review"
    APPROVED = "approved"
    REJECTED = "rejected"
    COMPLETED = "completed"
    CANCELLED = "cancelled"


class ParticipantRole(enum.Enum):
    CREATOR = "creator"
    ASSIGNEE = "assignee"
    REVIEWER = "reviewer"
    APPROVER = "approver"
    OBSERVER = "observer"


class Priority(enum.Enum):
    LOW = "low"
    MEDIUM = "medium"
    HIGH = "high"
    URGENT = "urgent"


# ==================== OPERATIONAL DATABASE MODELS ====================

class User(Base):
    __tablename__ = "users"
    
    id = Column(Integer, primary_key=True, index=True)
    email = Column(String, unique=True, index=True, nullable=False)
    name = Column(String, nullable=False)
    hashed_password = Column(String, nullable=False)
    department = Column(String)
    position = Column(String)
    avatar = Column(Text)  # Base64 encoded or URL
    is_active = Column(Boolean, default=True)
    mfa_enabled = Column(Boolean, default=False)  # ← ADD THIS
    created_at = Column(DateTime, default=datetime.utcnow)
    last_login = Column(DateTime)
    
    # Relationships
    created_tasks = relationship("Task", foreign_keys="Task.creator_id", back_populates="creator")
    participations = relationship("TaskParticipant", back_populates="user")
    comments = relationship("TaskComment", back_populates="user")


class Task(Base):
    __tablename__ = "tasks"
    
    # Core Fields
    id = Column(Integer, primary_key=True, index=True)
    task_number = Column(String, unique=True, index=True)  # Auto-generated: TASK-2026-0001
    title = Column(String, nullable=False)
    description = Column(Text)
    
    # Categorization
    project_name = Column(String)
    task_type = Column(String, default="task")
    task_tag = Column(String)
    priority = Column(SQLEnum(Priority), default=Priority.MEDIUM)
    
    # Ownership & Departments
    creator_id = Column(Integer, ForeignKey("users.id"), nullable=False)
    from_department = Column(String)
    to_department = Column(String)
    
    # Status & Workflow
    status = Column(SQLEnum(TaskStatus), default=TaskStatus.DRAFT, index=True)
    workflow_stage = Column(String)
    
    # Deadlines & Timing
    deadline = Column(DateTime)
    estimated_hours = Column(Integer)
    actual_hours = Column(Integer)
    
    # Timestamps
    created_at = Column(DateTime, default=datetime.utcnow, index=True)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)
    started_at = Column(DateTime)
    completed_at = Column(DateTime)
    
    # Soft Delete
    is_deleted = Column(Boolean, default=False, index=True)
    deleted_at = Column(DateTime)
    deleted_by = Column(Integer, ForeignKey("users.id"))
    
    # Metadata
    metadata_json = Column(JSON)  # For flexible extra data
    
    # Relationships
    creator = relationship("User", foreign_keys=[creator_id], back_populates="created_tasks")
    participants = relationship("TaskParticipant", back_populates="task", cascade="all, delete-orphan")
    status_history = relationship("TaskStatusHistory", back_populates="task", cascade="all, delete-orphan")
    attachments = relationship("TaskAttachment", back_populates="task", cascade="all, delete-orphan")
    comments = relationship("TaskComment", back_populates="task", cascade="all, delete-orphan")
    
    def to_dict(self):
        return {
            "id": self.id,
            "taskNumber": self.task_number,
            "title": self.title,
            "description": self.description,
            "projectName": self.project_name,
            "taskType": self.task_type,
            "taskTag": self.task_tag,
            "priority": self.priority.value if self.priority else None,
            "creatorId": self.creator_id,
            "fromDepartment": self.from_department,
            "toDepartment": self.to_department,
            "status": self.status.value if self.status else None,
            "workflowStage": self.workflow_stage,
            "deadline": self.deadline.isoformat() if self.deadline else None,
            "createdAt": self.created_at.isoformat() if self.created_at else None,
            "updatedAt": self.updated_at.isoformat() if self.updated_at else None,
            "startedAt": self.started_at.isoformat() if self.started_at else None,
            "completedAt": self.completed_at.isoformat() if self.completed_at else None,
            "isDeleted": self.is_deleted
        }


class TaskParticipant(Base):
    """Who is involved in the task and their role"""
    __tablename__ = "task_participants"
    
    id = Column(Integer, primary_key=True)
    task_id = Column(Integer, ForeignKey("tasks.id"), nullable=False, index=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False, index=True)
    role = Column(SQLEnum(ParticipantRole), nullable=False)
    
    # Interaction tracking
    is_read = Column(Boolean, default=False)
    read_at = Column(DateTime)
    accepted_at = Column(DateTime)
    rejected_at = Column(DateTime)
    
    # Status
    is_active = Column(Boolean, default=True)
    removed_at = Column(DateTime)
    
    # Timestamps
    added_at = Column(DateTime, default=datetime.utcnow)
    
    # Relationships
    task = relationship("Task", back_populates="participants")
    user = relationship("User", back_populates="participations")
    
    def to_dict(self):
        return {
            "id": self.id,
            "taskId": self.task_id,
            "userId": self.user_id,
            "role": self.role.value,
            "isRead": self.is_read,
            "readAt": self.read_at.isoformat() if self.read_at else None,
            "addedAt": self.added_at.isoformat() if self.added_at else None
        }


class TaskStatusHistory(Base):
    """Complete audit trail of status changes"""
    __tablename__ = "task_status_history"
    
    id = Column(Integer, primary_key=True)
    task_id = Column(Integer, ForeignKey("tasks.id"), nullable=False, index=True)
    user_id = Column(Integer, ForeignKey("users.id"))
    
    status_from = Column(String)
    status_to = Column(String, nullable=False)
    action = Column(String, nullable=False)  # created, started, submitted, approved, etc.
    
    comments = Column(Text)
    metadata_json = Column(JSON)
    
    timestamp = Column(DateTime, default=datetime.utcnow, index=True)
    
    # Relationships
    task = relationship("Task", back_populates="status_history")
    
    def to_dict(self):
        return {
            "id": self.id,
            "taskId": self.task_id,
            "userId": self.user_id,
            "statusFrom": self.status_from,
            "statusTo": self.status_to,
            "action": self.action,
            "comments": self.comments,
            "timestamp": self.timestamp.isoformat() if self.timestamp else None
        }


class TaskAttachment(Base):
    """File attachments for tasks"""
    __tablename__ = "task_attachments"
    
    id = Column(Integer, primary_key=True)
    task_id = Column(Integer, ForeignKey("tasks.id"), nullable=False, index=True)
    uploaded_by = Column(Integer, ForeignKey("users.id"))
    
    filename = Column(String, nullable=False)
    file_url = Column(String, nullable=False)
    file_size = Column(Integer)
    file_type = Column(String)
    
    uploaded_at = Column(DateTime, default=datetime.utcnow)
    
    # Relationships
    task = relationship("Task", back_populates="attachments")


class TaskComment(Base):
    """Comments and notes on tasks"""
    __tablename__ = "task_comments"
    
    id = Column(Integer, primary_key=True)
    task_id = Column(Integer, ForeignKey("tasks.id"), nullable=False, index=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False)
    
    comment = Column(Text, nullable=False)
    is_internal = Column(Boolean, default=False)  # Internal notes vs public comments
    
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, onupdate=datetime.utcnow)
    
    # Relationships
    task = relationship("Task", back_populates="comments")
    user = relationship("User", back_populates="comments")


# ==================== ARCHIVE DATABASE MODELS ====================

class ArchivedTask(ArchiveBase):
    """Permanent storage of all tasks (even deleted ones)"""
    __tablename__ = "archived_tasks"
    
    id = Column(Integer, primary_key=True)
    original_task_id = Column(Integer, index=True)
    task_data = Column(JSON, nullable=False)  # Complete task snapshot
    
    archived_at = Column(DateTime, default=datetime.utcnow, index=True)
    archived_by = Column(Integer)
    archive_reason = Column(String)  # deleted, completed, cancelled
    
    def to_dict(self):
        return {
            "id": self.id,
            "originalTaskId": self.original_task_id,
            "taskData": self.task_data,
            "archivedAt": self.archived_at.isoformat() if self.archived_at else None,
            "archiveReason": self.archive_reason
        }


class ActivityLog(ArchiveBase):
    """Log every single action in the system"""
    __tablename__ = "activity_log"
    
    id = Column(Integer, primary_key=True)
    user_id = Column(Integer, index=True)
    task_id = Column(Integer, index=True)
    
    action = Column(String, nullable=False, index=True)
    entity_type = Column(String)  # task, comment, attachment, etc.
    entity_id = Column(Integer)
    
    details = Column(JSON)
    ip_address = Column(String)
    user_agent = Column(String)
    
    timestamp = Column(DateTime, default=datetime.utcnow, index=True)
    
    def to_dict(self):
        return {
            "id": self.id,
            "userId": self.user_id,
            "taskId": self.task_id,
            "action": self.action,
            "details": self.details,
            "timestamp": self.timestamp.isoformat() if self.timestamp else None
        }
