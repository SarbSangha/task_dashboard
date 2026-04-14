# models_new.py - New Database Models
from sqlalchemy import Column, Integer, String, Text, DateTime, Date, Boolean, ForeignKey, JSON, Enum as SQLEnum
from sqlalchemy.orm import relationship
from datetime import datetime
from database_config import Base, ArchiveBase
import enum


# ==================== ENUMS ====================
def enum_values(enum_cls):
    return [member.value for member in enum_cls]


class TaskStatus(enum.Enum):
    DRAFT = "draft"
    PENDING = "pending"
    FORWARDED = "forwarded"
    ASSIGNED = "assigned"
    IN_PROGRESS = "in_progress"
    SUBMITTED = "submitted"
    UNDER_REVIEW = "under_review"
    NEED_IMPROVEMENT = "need_improvement"
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
    HOD = "hod"
    SPOC = "spoc"
    FACULTY = "faculty"
    EMPLOYEE = "employee"


class Priority(enum.Enum):
    LOW = "low"
    MEDIUM = "medium"
    HIGH = "high"
    URGENT = "urgent"


class ActivityStatus(enum.Enum):
    ACTIVE = "ACTIVE"
    IDLE = "IDLE"
    AWAY = "AWAY"
    OFFLINE = "OFFLINE"


# ==================== OPERATIONAL DATABASE MODELS ====================

class User(Base):
    __tablename__ = "users"
    
    id = Column(Integer, primary_key=True, index=True)
    email = Column(String, unique=True, index=True, nullable=False)
    employee_id = Column(String, unique=True, index=True)
    name = Column(String, nullable=False)
    hashed_password = Column(String, nullable=False)
    department = Column(String)
    position = Column(String)
    avatar = Column(Text)  # Base64 encoded or URL
    roles_json = Column(JSON)  # Optional explicit role list for multi-role users
    is_active = Column(Boolean, default=True)
    is_deleted = Column(Boolean, default=False, index=True)
    mfa_enabled = Column(Boolean, default=False)  # ← ADD THIS
    is_admin = Column(Boolean, default=False, index=True)
    rejection_reason = Column(Text)
    deleted_reason = Column(Text)
    deleted_at = Column(DateTime)
    deleted_by = Column(Integer, ForeignKey("users.id"))
    approved_by = Column(Integer, ForeignKey("users.id"))
    approved_at = Column(DateTime)
    created_at = Column(DateTime, default=datetime.utcnow)
    last_login = Column(DateTime)
    session_revoked_at = Column(DateTime, index=True)
    
    # Relationships
    created_tasks = relationship("Task", foreign_keys="Task.creator_id", back_populates="creator")
    participations = relationship("TaskParticipant", back_populates="user")
    comments = relationship("TaskComment", back_populates="user")


class Task(Base):
    __tablename__ = "tasks"
    
    # Core Fields
    id = Column(Integer, primary_key=True, index=True)
    task_number = Column(String, unique=True, index=True)  # Generated on assignment
    task_id_project_hex = Column(String)
    task_id_customer_hex = Column(String)
    project_id = Column(String, index=True)
    project_id_raw = Column(String)
    project_id_hex = Column(String)
    title = Column(String, nullable=False)
    description = Column(Text)
    
    # Categorization
    project_name = Column(String)
    task_type = Column(String, default="task")
    task_tag = Column(String)
    priority = Column(
        SQLEnum(
            Priority,
            name="priority",
            values_callable=enum_values,
            validate_strings=True,
        ),
        default=Priority.MEDIUM,
    )
    
    # Ownership & Departments
    creator_id = Column(Integer, ForeignKey("users.id"), nullable=False)
    from_department = Column(String)
    to_department = Column(String)
    
    # Status & Workflow
    status = Column(
        SQLEnum(
            TaskStatus,
            name="task_status",
            values_callable=enum_values,
            validate_strings=True,
        ),
        default=TaskStatus.DRAFT,
        index=True,
    )
    workflow_stage = Column(String)
    current_assignee_ids_json = Column(JSON)
    
    # Deadlines & Timing
    deadline = Column(DateTime)
    estimated_hours = Column(Integer)
    actual_hours = Column(Integer)
    
    # Timestamps
    created_at = Column(DateTime, default=datetime.utcnow, index=True)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)
    started_at = Column(DateTime)
    completed_at = Column(DateTime)
    submitted_at = Column(DateTime)
    submitted_by = Column(Integer, ForeignKey("users.id"))
    
    # Soft Delete
    is_deleted = Column(Boolean, default=False, index=True)
    deleted_at = Column(DateTime)
    deleted_by = Column(Integer, ForeignKey("users.id"))
    
    # Metadata
    metadata_json = Column(JSON)  # For flexible extra data
    task_version = Column(Integer, default=1)
    result_version = Column(Integer, default=0)
    task_edit_locked = Column(Boolean, default=False)
    result_edit_locked = Column(Boolean, default=True)
    result_text = Column(Text)
    
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
            "taskIdProjectHex": self.task_id_project_hex,
            "taskIdCustomerHex": self.task_id_customer_hex,
            "projectId": self.project_id,
            "projectIdRaw": self.project_id_raw,
            "projectIdHex": self.project_id_hex,
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
            "submittedAt": self.submitted_at.isoformat() if self.submitted_at else None,
            "submittedBy": self.submitted_by,
            "taskVersion": self.task_version,
            "resultVersion": self.result_version,
            "taskEditLocked": self.task_edit_locked,
            "resultEditLocked": self.result_edit_locked,
            "isDeleted": self.is_deleted
        }


class TaskParticipant(Base):
    """Who is involved in the task and their role"""
    __tablename__ = "task_participants"
    
    id = Column(Integer, primary_key=True)
    task_id = Column(Integer, ForeignKey("tasks.id"), nullable=False, index=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False, index=True)
    role = Column(
        SQLEnum(
            ParticipantRole,
            name="participant_role",
            values_callable=enum_values,
            validate_strings=True,
        ),
        nullable=False,
    )
    
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
    comment_type = Column(String, default="general")  # suggestion / need_improvement / approved / general
    is_internal = Column(Boolean, default=False)  # Internal notes vs public comments
    
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, onupdate=datetime.utcnow)
    
    # Relationships
    task = relationship("Task", back_populates="comments")
    user = relationship("User", back_populates="comments")


class TaskForward(Base):
    """Track forwarding chain between users/departments"""
    __tablename__ = "task_forwards"

    id = Column(Integer, primary_key=True)
    task_id = Column(Integer, ForeignKey("tasks.id"), nullable=False, index=True)
    from_user_id = Column(Integer, ForeignKey("users.id"), nullable=False, index=True)
    to_user_id = Column(Integer, ForeignKey("users.id"), index=True)
    from_department = Column(String)
    to_department = Column(String)
    reason = Column(Text)
    created_at = Column(DateTime, default=datetime.utcnow, index=True)


class TaskNotification(Base):
    """In-app notifications for workflow actions"""
    __tablename__ = "task_notifications"

    id = Column(Integer, primary_key=True)
    task_id = Column(Integer, ForeignKey("tasks.id"), nullable=False, index=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False, index=True)
    event_type = Column(String, nullable=False, index=True)  # forwarded/assigned/approved/need_improvement/etc
    task_number = Column(String, index=True)
    project_id = Column(String, index=True)
    title = Column(String, nullable=False)
    message = Column(Text)
    is_read = Column(Boolean, default=False, index=True)
    metadata_json = Column(JSON)
    created_at = Column(DateTime, default=datetime.utcnow, index=True)
    read_at = Column(DateTime)


class TaskView(Base):
    """Seen-by entries per task"""
    __tablename__ = "task_views"

    id = Column(Integer, primary_key=True)
    task_id = Column(Integer, ForeignKey("tasks.id"), nullable=False, index=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False, index=True)
    seen_at = Column(DateTime, default=datetime.utcnow, index=True)


class TaskEditLog(Base):
    """Track task and result edits with before/after snapshots"""
    __tablename__ = "task_edit_logs"

    id = Column(Integer, primary_key=True)
    task_id = Column(Integer, ForeignKey("tasks.id"), nullable=False, index=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False, index=True)
    edit_scope = Column(String, nullable=False)  # task/result
    before_json = Column(JSON)
    after_json = Column(JSON)
    created_at = Column(DateTime, default=datetime.utcnow, index=True)


class IdSequence(Base):
    """Central sequence table for configurable IDs"""
    __tablename__ = "id_sequences"

    id = Column(Integer, primary_key=True)
    sequence_key = Column(String, unique=True, nullable=False, index=True)
    prefix = Column(String, nullable=False)
    year = Column(Integer, nullable=False)
    next_value = Column(Integer, nullable=False, default=1)


class UserApprovalRequest(Base):
    __tablename__ = "user_approval_requests"

    id = Column(Integer, primary_key=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False, index=True)
    request_type = Column(String, nullable=False, default="signup")  # signup/profile_update/password_change
    status = Column(String, nullable=False, default="pending", index=True)  # pending/approved/rejected
    payload_json = Column(JSON)
    created_at = Column(DateTime, default=datetime.utcnow, index=True)
    reviewed_at = Column(DateTime)
    reviewed_by = Column(Integer, ForeignKey("users.id"))
    review_notes = Column(Text)


class UserActivity(Base):
    __tablename__ = "user_activities"

    id = Column(Integer, primary_key=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False, index=True)
    date = Column(Date, nullable=False, index=True)

    login_time = Column(DateTime)
    logout_time = Column(DateTime)
    total_session_duration = Column(Integer, default=0)  # seconds
    active_time = Column(Integer, default=0)  # seconds
    idle_time = Column(Integer, default=0)  # seconds
    away_time = Column(Integer, default=0)  # seconds

    status = Column(
        SQLEnum(
            ActivityStatus,
            name="activity_status",
            values_callable=enum_values,
            validate_strings=True,
        ),
        default=ActivityStatus.ACTIVE,
        index=True,
    )
    last_seen = Column(DateTime, default=datetime.utcnow, index=True)
    heartbeat_count = Column(Integer, default=0)


# ==================== IT PROFILE / TOOL VAULT MODELS ====================

class ITPortalTool(Base):
    __tablename__ = "it_portal_tools"

    id = Column(Integer, primary_key=True, index=True)
    name = Column(String, nullable=False, index=True)
    slug = Column(String, unique=True, nullable=False, index=True)
    category = Column(String, default="General", index=True)
    description = Column(Text)
    website_url = Column(Text, nullable=False)
    login_url = Column(Text)
    icon = Column(String, default="Globe")
    launch_mode = Column(String, default="manual_credential", index=True)
    status = Column(String, default="active", index=True)
    is_active = Column(Boolean, default=True, index=True)
    metadata_json = Column(JSON)
    created_by = Column(Integer, ForeignKey("users.id"))
    updated_by = Column(Integer, ForeignKey("users.id"))
    created_at = Column(DateTime, default=datetime.utcnow, index=True)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)


class ITPortalToolCredential(Base):
    __tablename__ = "it_portal_tool_credentials"

    id = Column(Integer, primary_key=True, index=True)
    tool_id = Column(Integer, ForeignKey("it_portal_tools.id"), nullable=False, index=True)
    scope = Column(String, nullable=False, default="company", index=True)  # company/user
    user_id = Column(Integer, ForeignKey("users.id"), index=True)
    login_identifier_encrypted = Column(Text)
    password_encrypted = Column(Text)
    api_key_encrypted = Column(Text)
    notes = Column(Text)
    is_active = Column(Boolean, default=True, index=True)
    created_by = Column(Integer, ForeignKey("users.id"))
    updated_by = Column(Integer, ForeignKey("users.id"))
    created_at = Column(DateTime, default=datetime.utcnow, index=True)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)


class ITPortalToolAudit(Base):
    __tablename__ = "it_portal_tool_audit"

    id = Column(Integer, primary_key=True, index=True)
    tool_id = Column(Integer, ForeignKey("it_portal_tools.id"), index=True)
    credential_id = Column(Integer, ForeignKey("it_portal_tool_credentials.id"), index=True)
    actor_id = Column(Integer, ForeignKey("users.id"), nullable=False, index=True)
    target_user_id = Column(Integer, ForeignKey("users.id"), index=True)
    action = Column(String, nullable=False, index=True)
    details_json = Column(JSON)
    created_at = Column(DateTime, default=datetime.utcnow, index=True)


# ==================== GROUP CHAT MODELS ====================

class GroupChat(Base):
    __tablename__ = "group_chats"

    id = Column(Integer, primary_key=True)
    name = Column(String, nullable=False, index=True)
    created_by = Column(Integer, ForeignKey("users.id"), nullable=False, index=True)
    created_at = Column(DateTime, default=datetime.utcnow, index=True)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)
    last_message_at = Column(DateTime, default=datetime.utcnow, index=True)
    is_archived = Column(Boolean, default=False, index=True)


class GroupChatMember(Base):
    __tablename__ = "group_chat_members"

    id = Column(Integer, primary_key=True)
    group_id = Column(Integer, ForeignKey("group_chats.id"), nullable=False, index=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False, index=True)
    role = Column(String, default="member", index=True)  # admin/member
    joined_at = Column(DateTime, default=datetime.utcnow, index=True)
    is_active = Column(Boolean, default=True, index=True)


class GroupChatMessage(Base):
    __tablename__ = "group_chat_messages"

    id = Column(Integer, primary_key=True)
    group_id = Column(Integer, ForeignKey("group_chats.id"), nullable=False, index=True)
    sender_id = Column(Integer, ForeignKey("users.id"), nullable=False, index=True)
    message = Column(Text, nullable=False)
    attachments_json = Column(JSON)
    created_at = Column(DateTime, default=datetime.utcnow, index=True)
    edited_at = Column(DateTime)


class DirectMessage(Base):
    __tablename__ = "direct_messages"

    id = Column(Integer, primary_key=True)
    sender_id = Column(Integer, ForeignKey("users.id"), nullable=False, index=True)
    recipient_id = Column(Integer, ForeignKey("users.id"), nullable=False, index=True)
    message = Column(Text, nullable=False)
    attachments_json = Column(JSON)
    created_at = Column(DateTime, default=datetime.utcnow, index=True)
    edited_at = Column(DateTime)


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
