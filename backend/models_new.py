# models_new.py - New Database Models
from sqlalchemy import Column, Integer, String, Text, DateTime, Date, Boolean, ForeignKey, JSON, Float, Enum as SQLEnum, Index, UniqueConstraint, CheckConstraint, text
from sqlalchemy.orm import relationship
from datetime import datetime
from database_config import Base, ArchiveBase
import enum
from utils.datetime_utils import serialize_utc_datetime


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


class TaskWorkflowStatus(enum.Enum):
    NOT_STARTED = "not_started"
    ACTIVE = "active"
    WAITING_APPROVAL = "waiting_approval"
    REVISION_REQUESTED = "revision_requested"
    COMPLETED = "completed"
    BLOCKED = "blocked"


class TaskStageStatus(enum.Enum):
    NOT_STARTED = "not_started"
    ACTIVE = "active"
    SUBMITTED = "submitted"
    APPROVED = "approved"
    REVISION_REQUESTED = "revision_requested"
    COMPLETED = "completed"
    BLOCKED = "blocked"


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
    enforce_active_task_policy = Column(Boolean, default=False, nullable=False)
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
    role_assignments = relationship("UserRole", back_populates="user", cascade="all, delete-orphan")


class UserRole(Base):
    __tablename__ = "user_roles"
    __table_args__ = (
        UniqueConstraint("user_id", "role", name="uq_user_roles_user_role"),
        Index("ix_user_roles_role_user_id", "role", "user_id"),
    )

    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    role = Column(String(80), nullable=False, index=True)
    created_at = Column(DateTime, default=datetime.utcnow, index=True)

    user = relationship("User", back_populates="role_assignments")


class DepartmentDirectory(Base):
    __tablename__ = "department_directory"

    id = Column(Integer, primary_key=True, index=True)
    name = Column(String, nullable=False, unique=True, index=True)
    is_active = Column(Boolean, default=True, index=True)
    created_by = Column(Integer, ForeignKey("users.id"))
    updated_by = Column(Integer, ForeignKey("users.id"))
    created_at = Column(DateTime, default=datetime.utcnow, index=True)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)


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
    workflow_enabled = Column(Boolean, default=False, nullable=False, index=True)
    workflow_status = Column(String, index=True)
    current_stage_id = Column(Integer, ForeignKey("task_stages.id"))
    current_stage_order = Column(Integer, index=True)
    current_stage_title = Column(String)
    final_approval_required = Column(Boolean, default=False, nullable=False)
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
    current_stage = relationship("TaskStage", foreign_keys=[current_stage_id], post_update=True)
    stages = relationship(
        "TaskStage",
        foreign_keys="TaskStage.task_id",
        back_populates="task",
        cascade="all, delete-orphan",
        order_by="TaskStage.stage_order",
    )
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
            "workflowEnabled": bool(self.workflow_enabled),
            "workflowStatus": self.workflow_status,
            "currentStageId": self.current_stage_id,
            "currentStageOrder": self.current_stage_order,
            "currentStageTitle": self.current_stage_title,
            "finalApprovalRequired": bool(self.final_approval_required),
            "deadline": serialize_utc_datetime(self.deadline),
            "createdAt": serialize_utc_datetime(self.created_at),
            "updatedAt": serialize_utc_datetime(self.updated_at),
            "startedAt": serialize_utc_datetime(self.started_at),
            "completedAt": serialize_utc_datetime(self.completed_at),
            "submittedAt": serialize_utc_datetime(self.submitted_at),
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
            "readAt": serialize_utc_datetime(self.read_at),
            "addedAt": serialize_utc_datetime(self.added_at)
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
            "timestamp": serialize_utc_datetime(self.timestamp)
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


class TaskStage(Base):
    __tablename__ = "task_stages"
    __table_args__ = (
        UniqueConstraint("task_id", "stage_order", name="uq_task_stages_task_id_stage_order"),
        Index("ix_task_stages_task_status", "task_id", "status"),
    )

    id = Column(Integer, primary_key=True)
    task_id = Column(Integer, ForeignKey("tasks.id"), nullable=False, index=True)
    stage_order = Column(Integer, nullable=False)
    title = Column(String, nullable=False)
    description = Column(Text)
    status = Column(String, nullable=False, default=TaskStageStatus.NOT_STARTED.value, index=True)
    approval_required = Column(Boolean, default=False, nullable=False)
    is_final_stage = Column(Boolean, default=False, nullable=False)
    started_at = Column(DateTime)
    submitted_at = Column(DateTime)
    completed_at = Column(DateTime)
    approved_at = Column(DateTime)
    approved_by_user_id = Column(Integer, ForeignKey("users.id"))
    revision_notes = Column(Text)
    created_at = Column(DateTime, default=datetime.utcnow, index=True)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    task = relationship("Task", foreign_keys=[task_id], back_populates="stages")
    assignees = relationship("TaskStageAssignee", back_populates="stage", cascade="all, delete-orphan")
    submissions = relationship(
        "TaskStageSubmission",
        back_populates="stage",
        cascade="all, delete-orphan",
        order_by="TaskStageSubmission.version.desc()",
    )
    comments = relationship("TaskComment", back_populates="stage")


class TaskStageAssignee(Base):
    __tablename__ = "task_stage_assignees"
    __table_args__ = (
        UniqueConstraint("stage_id", "user_id", "role", name="uq_task_stage_assignees_stage_user_role"),
        Index("ix_task_stage_assignees_stage_user", "stage_id", "user_id"),
    )

    id = Column(Integer, primary_key=True)
    stage_id = Column(Integer, ForeignKey("task_stages.id"), nullable=False, index=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False, index=True)
    role = Column(String, nullable=False, default="assignee")
    is_primary = Column(Boolean, default=False, nullable=False)
    is_active = Column(Boolean, default=True, nullable=False)
    assigned_at = Column(DateTime, default=datetime.utcnow, index=True)

    stage = relationship("TaskStage", back_populates="assignees")
    user = relationship("User", foreign_keys=[user_id])


class TaskStageSubmission(Base):
    __tablename__ = "task_stage_submissions"
    __table_args__ = (
        UniqueConstraint("stage_id", "version", name="uq_task_stage_submissions_stage_version"),
        Index("ix_task_stage_submissions_stage_current", "stage_id", "is_current"),
        Index(
            "uq_task_stage_submissions_current_stage",
            "stage_id",
            unique=True,
            postgresql_where=text("is_current = true"),
            sqlite_where=text("is_current = 1"),
        ),
    )

    id = Column(Integer, primary_key=True)
    stage_id = Column(Integer, ForeignKey("task_stages.id"), nullable=False, index=True)
    version = Column(Integer, nullable=False, default=1)
    output_text = Column(Text)
    links_json = Column(JSON)
    attachments_json = Column(JSON)
    submitted_by_user_id = Column(Integer, ForeignKey("users.id"), nullable=False, index=True)
    submitted_at = Column(DateTime, default=datetime.utcnow, index=True)
    is_current = Column(Boolean, default=True, nullable=False, index=True)

    stage = relationship("TaskStage", back_populates="submissions")
    submitted_by = relationship("User", foreign_keys=[submitted_by_user_id])


class TaskComment(Base):
    """Comments and notes on tasks"""
    __tablename__ = "task_comments"
    
    id = Column(Integer, primary_key=True)
    task_id = Column(Integer, ForeignKey("tasks.id"), nullable=False, index=True)
    stage_id = Column(Integer, ForeignKey("task_stages.id"), index=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False)
    
    comment = Column(Text, nullable=False)
    comment_type = Column(String, default="general")  # suggestion / need_improvement / approved / general
    is_internal = Column(Boolean, default=False)  # Internal notes vs public comments
    attachments_json = Column(JSON)
    
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, onupdate=datetime.utcnow)
    
    # Relationships
    task = relationship("Task", back_populates="comments")
    stage = relationship("TaskStage", back_populates="comments")
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


class NotificationOutbox(Base):
    """Recoverable notification delivery attempts for realtime/web-push fanout."""
    __tablename__ = "notification_outbox"
    __table_args__ = (
        Index("ix_notification_outbox_status_next_attempt", "status", "next_attempt_at"),
    )

    id = Column(Integer, primary_key=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False, index=True)
    event_type = Column(String(120), nullable=False, index=True)
    payload_json = Column(JSON, nullable=False)
    status = Column(String(40), nullable=False, default="pending", index=True)
    attempts = Column(Integer, nullable=False, default=0)
    max_attempts = Column(Integer, nullable=False, default=10)
    last_error = Column(Text)
    created_at = Column(DateTime, default=datetime.utcnow, index=True)
    next_attempt_at = Column(DateTime, default=datetime.utcnow, index=True)
    dispatched_at = Column(DateTime)


class WebPushSubscription(Base):
    """Browser push subscriptions scoped to a single authenticated user."""
    __tablename__ = "web_push_subscriptions"
    __table_args__ = (
        UniqueConstraint("endpoint", name="uq_web_push_subscriptions_endpoint"),
    )

    id = Column(Integer, primary_key=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False, index=True)
    endpoint = Column(Text, nullable=False)
    p256dh = Column(Text, nullable=False)
    auth = Column(Text, nullable=False)
    expiration_time = Column(DateTime)
    user_agent = Column(Text)
    created_at = Column(DateTime, default=datetime.utcnow, index=True)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, index=True)
    last_success_at = Column(DateTime)
    last_failure_at = Column(DateTime)
    failure_reason = Column(Text)
    is_active = Column(Boolean, default=True, nullable=False, index=True)


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
    __table_args__ = (
        Index(
            "ux_user_approval_pending_user_type",
            "user_id",
            "request_type",
            unique=True,
            postgresql_where=text("status = 'pending'"),
            sqlite_where=text("status = 'pending'"),
        ),
    )

    id = Column(Integer, primary_key=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False, index=True)
    request_type = Column(String, nullable=False, default="signup")  # signup/profile_update/password_change
    status = Column(String, nullable=False, default="pending", index=True)  # pending/approved/rejected
    payload_json = Column(JSON)
    created_at = Column(DateTime, default=datetime.utcnow, index=True)
    reviewed_at = Column(DateTime)
    reviewed_by = Column(Integer, ForeignKey("users.id"))
    review_notes = Column(Text)


class PendingPasswordChange(Base):
    __tablename__ = "pending_password_changes"
    __table_args__ = (
        UniqueConstraint("approval_request_id", name="ux_pending_password_changes_request"),
        Index("ix_pending_password_changes_status_created", "status", "created_at"),
    )

    id = Column(Integer, primary_key=True)
    approval_request_id = Column(Integer, ForeignKey("user_approval_requests.id"), nullable=False, index=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False, index=True)
    password_hash = Column(Text, nullable=False)
    status = Column(String, nullable=False, default="pending", index=True)
    created_at = Column(DateTime, default=datetime.utcnow, index=True)
    expires_at = Column(DateTime, index=True)
    consumed_at = Column(DateTime)


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
    linked_credential_id = Column(Integer, ForeignKey("it_portal_tool_credentials.id"), index=True)
    login_method = Column(String(40), default="email_password", index=True)
    login_identifier_encrypted = Column(Text)
    password_encrypted = Column(Text)
    backup_codes_encrypted = Column(Text)
    totp_secret_encrypted = Column(Text)
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


class ITPortalToolUsageEvent(Base):
    __tablename__ = "it_portal_tool_usage_events"

    id = Column(Integer, primary_key=True, index=True)
    tool_id = Column(Integer, ForeignKey("it_portal_tools.id"), nullable=False, index=True)
    credential_id = Column(Integer, ForeignKey("it_portal_tool_credentials.id"), index=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False, index=True)
    event_type = Column(String, nullable=False, index=True)
    event_date = Column(Date, nullable=False, index=True)
    status = Column(String, nullable=False, default="captured", index=True)
    model_label = Column(String(255))
    duration_label = Column(String(80))
    resolution_label = Column(String(80))
    prompt_text = Column(Text)
    expected_credits = Column(Float)
    credits_before = Column(Float)
    credits_after = Column(Float)
    credits_burned = Column(Float)
    external_event_id = Column(String(160), index=True)
    generation_id = Column(String(160), index=True)
    request_id = Column(String(160), index=True)
    fingerprint = Column(String(160), index=True)
    source = Column(String(80), index=True)
    schema_version = Column(Integer)
    confidence = Column(Float)
    metadata_json = Column(JSON)
    created_at = Column(DateTime, default=datetime.utcnow, index=True)

    def to_dict(self):
        return {
            "id": self.id,
            "toolId": self.tool_id,
            "credentialId": self.credential_id,
            "userId": self.user_id,
            "eventType": self.event_type,
            "eventDate": self.event_date.isoformat() if self.event_date else None,
            "status": self.status,
            "modelLabel": self.model_label,
            "durationLabel": self.duration_label,
            "resolutionLabel": self.resolution_label,
            "promptText": self.prompt_text,
            "expectedCredits": self.expected_credits,
            "creditsBefore": self.credits_before,
            "creditsAfter": self.credits_after,
            "creditsBurned": self.credits_burned,
            "externalEventId": self.external_event_id,
            "generationId": self.generation_id,
            "requestId": self.request_id,
            "fingerprint": self.fingerprint,
            "source": self.source,
            "schemaVersion": self.schema_version,
            "confidence": self.confidence,
            "metadata": self.metadata_json or {},
            "createdAt": serialize_utc_datetime(self.created_at),
        }


class GenerationProject(Base):
    __tablename__ = "generation_projects"
    __table_args__ = (
        Index(
            "ux_generation_projects_owner_normalized_name_active",
            "owner_user_id",
            "normalized_name",
            unique=True,
            postgresql_where=text("archived_at IS NULL"),
            sqlite_where=text("archived_at IS NULL"),
        ),
        Index("ix_generation_projects_owner_updated_at", "owner_user_id", "updated_at"),
        Index("ix_generation_projects_archived_at", "archived_at"),
    )

    id = Column(Integer, primary_key=True, index=True)
    owner_user_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    name = Column(String(200), nullable=False)
    normalized_name = Column(String(200), nullable=False)
    description = Column(Text)
    created_by = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"))
    updated_by = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"))
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False, index=True)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, nullable=False, index=True)
    archived_at = Column(DateTime)

    records = relationship("GenerationRecord", back_populates="project")

    def to_dict(self):
        return {
            "id": self.id,
            "ownerUserId": self.owner_user_id,
            "name": self.name,
            "normalizedName": self.normalized_name,
            "description": self.description,
            "createdBy": self.created_by,
            "updatedBy": self.updated_by,
            "createdAt": serialize_utc_datetime(self.created_at),
            "updatedAt": serialize_utc_datetime(self.updated_at),
            "archivedAt": serialize_utc_datetime(self.archived_at),
        }


class GenerationRecoveryAudit(Base):
    __tablename__ = "generation_recovery_audits"
    __table_args__ = (
        Index("ix_generation_recovery_audits_admin_created_at", "requested_by_admin_id", "created_at"),
        Index("ix_generation_recovery_audits_provider_action_created_at", "provider", "action_type", "created_at"),
        Index("ix_generation_recovery_audits_date_range_created_at", "date_from", "date_to", "created_at"),
    )

    id = Column(Integer, primary_key=True, index=True)
    provider = Column(String(40), nullable=False, default="kling", index=True)
    action_type = Column(String(40), nullable=False, index=True)
    requested_by_admin_id = Column(Integer, ForeignKey("users.id", ondelete="RESTRICT"), nullable=False, index=True)
    date_from = Column(Date, nullable=False, index=True)
    date_to = Column(Date, nullable=False, index=True)
    kling_count = Column(Integer, nullable=False, default=0)
    database_count = Column(Integer, nullable=False, default=0)
    missing_count = Column(Integer, nullable=False, default=0)
    imported_count = Column(Integer, nullable=False, default=0)
    duplicate_count = Column(Integer, nullable=False, default=0)
    status = Column(String(40), nullable=False, default="started", index=True)
    filters_json = Column(JSON)
    report_json = Column(JSON)
    error_message = Column(Text)
    started_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    completed_at = Column(DateTime)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False, index=True)

    records = relationship("GenerationRecord", back_populates="recovery_audit")

    def to_dict(self):
        return {
            "id": self.id,
            "provider": self.provider,
            "actionType": self.action_type,
            "requestedByAdminId": self.requested_by_admin_id,
            "dateFrom": self.date_from.isoformat() if self.date_from else None,
            "dateTo": self.date_to.isoformat() if self.date_to else None,
            "klingCount": self.kling_count,
            "databaseCount": self.database_count,
            "missingCount": self.missing_count,
            "importedCount": self.imported_count,
            "duplicateCount": self.duplicate_count,
            "status": self.status,
            "errorMessage": self.error_message,
            "startedAt": serialize_utc_datetime(self.started_at),
            "completedAt": serialize_utc_datetime(self.completed_at),
            "createdAt": serialize_utc_datetime(self.created_at),
        }


class GenerationRecord(Base):
    __tablename__ = "generation_records"
    __table_args__ = (
        CheckConstraint(
            "provider_task_id IS NOT NULL OR provider_generation_id IS NOT NULL OR canonical_asset_key IS NOT NULL",
            name="ck_generation_records_identity_present",
        ),
        Index(
            "ux_generation_records_provider_task_id",
            "provider",
            "provider_task_id",
            unique=True,
            postgresql_where=text("provider_task_id IS NOT NULL"),
            sqlite_where=text("provider_task_id IS NOT NULL"),
        ),
        Index(
            "ux_generation_records_provider_generation_id",
            "provider",
            "provider_generation_id",
            unique=True,
            postgresql_where=text("provider_generation_id IS NOT NULL"),
            sqlite_where=text("provider_generation_id IS NOT NULL"),
        ),
        Index(
            "ux_generation_records_provider_asset_key",
            "provider",
            "canonical_asset_key",
            unique=True,
            postgresql_where=text("canonical_asset_key IS NOT NULL"),
            sqlite_where=text("canonical_asset_key IS NOT NULL"),
        ),
        Index(
            "ux_generation_records_source_usage_event_id",
            "source_usage_event_id",
            unique=True,
            postgresql_where=text("source_usage_event_id IS NOT NULL"),
            sqlite_where=text("source_usage_event_id IS NOT NULL"),
        ),
        Index("ix_generation_records_owner_project_created_at", "owner_user_id", "project_id", "created_at"),
        Index("ix_generation_records_owner_status_created_at", "owner_user_id", "ownership_status", "created_at"),
        Index("ix_generation_records_project_created_at", "project_id", "created_at"),
        Index("ix_generation_records_ingestion_created_at", "ingestion_source", "created_at"),
        Index("ix_generation_records_favorite_created_at", "is_favorite", "created_at"),
    )

    id = Column(Integer, primary_key=True, index=True)
    provider = Column(String(40), nullable=False, default="kling", index=True)
    provider_task_id = Column(String(160), index=True)
    provider_generation_id = Column(String(160), index=True)
    canonical_asset_url = Column(Text)
    canonical_asset_key = Column(String(255), index=True)
    prompt_text = Column(Text)
    model_label = Column(String(255))
    duration_label = Column(String(80))
    resolution_label = Column(String(80))
    credits_burned = Column(Float)
    ingestion_source = Column(String(40), nullable=False, default="captured", index=True)
    capture_status = Column(String(40), nullable=False, default="active", index=True)
    owner_user_id = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), index=True)
    ownership_status = Column(String(40), nullable=False, default="unknown", index=True)
    ownership_source = Column(String(80))
    ownership_notes = Column(Text)
    assigned_by_admin_id = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"))
    assigned_at = Column(DateTime)
    project_id = Column(Integer, ForeignKey("generation_projects.id", ondelete="SET NULL"), index=True)
    source_usage_event_id = Column(Integer, ForeignKey("it_portal_tool_usage_events.id", ondelete="SET NULL"), index=True)
    recovery_audit_id = Column(Integer, ForeignKey("generation_recovery_audits.id", ondelete="SET NULL"), index=True)
    recovered_by_admin_id = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"))
    recovered_at = Column(DateTime)
    metadata_json = Column(JSON)
    is_favorite = Column(Boolean, nullable=False, default=False, index=True)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False, index=True)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, nullable=False, index=True)
    archived_at = Column(DateTime, index=True)

    project = relationship("GenerationProject", back_populates="records")
    recovery_audit = relationship("GenerationRecoveryAudit", back_populates="records")

    def to_dict(self):
        return {
            "id": self.id,
            "provider": self.provider,
            "providerTaskId": self.provider_task_id,
            "providerGenerationId": self.provider_generation_id,
            "canonicalAssetUrl": self.canonical_asset_url,
            "canonicalAssetKey": self.canonical_asset_key,
            "promptText": self.prompt_text,
            "modelLabel": self.model_label,
            "durationLabel": self.duration_label,
            "resolutionLabel": self.resolution_label,
            "creditsBurned": self.credits_burned,
            "ingestionSource": self.ingestion_source,
            "captureStatus": self.capture_status,
            "ownerUserId": self.owner_user_id,
            "ownershipStatus": self.ownership_status,
            "ownershipSource": self.ownership_source,
            "ownershipNotes": self.ownership_notes,
            "assignedByAdminId": self.assigned_by_admin_id,
            "assignedAt": serialize_utc_datetime(self.assigned_at),
            "projectId": self.project_id,
            "sourceUsageEventId": self.source_usage_event_id,
            "recoveryAuditId": self.recovery_audit_id,
            "recoveredByAdminId": self.recovered_by_admin_id,
            "recoveredAt": serialize_utc_datetime(self.recovered_at),
            "metadata": self.metadata_json or {},
            "isFavorite": bool(self.is_favorite),
            "createdAt": serialize_utc_datetime(self.created_at),
            "updatedAt": serialize_utc_datetime(self.updated_at),
            "archivedAt": serialize_utc_datetime(self.archived_at),
        }


class GenerationTag(Base):
    __tablename__ = "generation_tags"
    __table_args__ = (
        UniqueConstraint("generation_id", "normalized_tag", name="ux_generation_tags_generation_normalized"),
        Index("ix_generation_tags_normalized_tag", "normalized_tag"),
        Index("ix_generation_tags_generation_id", "generation_id"),
    )

    id = Column(Integer, primary_key=True, index=True)
    generation_id = Column(Integer, ForeignKey("generation_records.id", ondelete="CASCADE"), nullable=False)
    tag = Column(String(80), nullable=False)
    normalized_tag = Column(String(80), nullable=False)
    created_by = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"))
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False, index=True)

    def to_dict(self):
        return {
            "id": self.id,
            "generationId": self.generation_id,
            "tag": self.tag,
            "createdBy": self.created_by,
            "createdAt": serialize_utc_datetime(self.created_at),
        }


class GenerationCollection(Base):
    __tablename__ = "generation_collections"
    __table_args__ = (
        Index(
            "ux_generation_collections_owner_normalized_name_active",
            "owner_user_id", "normalized_name",
            unique=True,
            postgresql_where=text("archived_at IS NULL"),
            sqlite_where=text("archived_at IS NULL"),
        ),
        Index("ix_generation_collections_owner_updated_at", "owner_user_id", "updated_at"),
        Index("ix_generation_collections_archived_at", "archived_at"),
    )

    id = Column(Integer, primary_key=True, index=True)
    owner_user_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    name = Column(String(200), nullable=False)
    normalized_name = Column(String(200), nullable=False)
    description = Column(Text)
    created_by = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"))
    updated_by = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"))
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False, index=True)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, nullable=False, index=True)
    archived_at = Column(DateTime)

    def to_dict(self):
        return {
            "id": self.id,
            "ownerUserId": self.owner_user_id,
            "name": self.name,
            "normalizedName": self.normalized_name,
            "description": self.description,
            "createdBy": self.created_by,
            "updatedBy": self.updated_by,
            "createdAt": serialize_utc_datetime(self.created_at),
            "updatedAt": serialize_utc_datetime(self.updated_at),
            "archivedAt": serialize_utc_datetime(self.archived_at),
        }


class GenerationCollectionMember(Base):
    __tablename__ = "generation_collection_members"
    __table_args__ = (
        UniqueConstraint("collection_id", "generation_id", name="ux_generation_collection_members_collection_generation"),
        Index("ix_generation_collection_members_collection_id", "collection_id"),
        Index("ix_generation_collection_members_generation_id", "generation_id"),
    )

    id = Column(Integer, primary_key=True, index=True)
    collection_id = Column(Integer, ForeignKey("generation_collections.id", ondelete="CASCADE"), nullable=False)
    generation_id = Column(Integer, ForeignKey("generation_records.id", ondelete="CASCADE"), nullable=False)
    added_by = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"))
    added_at = Column(DateTime, default=datetime.utcnow, nullable=False, index=True)

    def to_dict(self):
        return {
            "id": self.id,
            "collectionId": self.collection_id,
            "generationId": self.generation_id,
            "addedBy": self.added_by,
            "addedAt": serialize_utc_datetime(self.added_at),
        }


class GenerationProjectEvent(Base):
    """Activity log for a generation project's timeline (project_created, generation_assigned, etc.)."""
    __tablename__ = "generation_project_events"
    __table_args__ = (
        Index("ix_generation_project_events_project_created_at", "project_id", "created_at"),
    )

    id = Column(Integer, primary_key=True, index=True)
    project_id = Column(Integer, ForeignKey("generation_projects.id", ondelete="CASCADE"), nullable=False)
    generation_id = Column(Integer, ForeignKey("generation_records.id", ondelete="SET NULL"))
    actor_user_id = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"))
    event_type = Column(String(40), nullable=False)
    description = Column(Text)
    metadata_json = Column(JSON)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False, index=True)

    def to_dict(self):
        return {
            "id": self.id,
            "projectId": self.project_id,
            "generationId": self.generation_id,
            "actorUserId": self.actor_user_id,
            "eventType": self.event_type,
            "description": self.description,
            "metadata": self.metadata_json or {},
            "createdAt": serialize_utc_datetime(self.created_at),
        }


# NOTE: ChatGPT Capture & Conversation Intelligence models now live in
# providers/chatgpt/models.py (see providers/chatgpt/__init__.py for
# Base.metadata registration). Kept out of this file per the modular
# provider architecture: each provider owns its own models/migrations.


class ITPortalToolMailbox(Base):
    __tablename__ = "it_portal_tool_mailboxes"

    id = Column(Integer, primary_key=True, index=True)
    tool_id = Column(Integer, ForeignKey("it_portal_tools.id"), nullable=False, unique=True, index=True)
    email_address = Column(String(255), nullable=False)
    app_password_encrypted = Column(Text, nullable=False)
    otp_sender_filter = Column(String(255))
    otp_subject_pattern = Column(String(255))
    otp_regex = Column(String(255), nullable=False, default=r"\b(\d{4,8})\b")
    auth_link_pattern = Column(String(255))
    auth_link_host = Column(String(255))
    mailboxes_json = Column(JSON)
    created_by = Column(Integer, ForeignKey("users.id"))
    updated_by = Column(Integer, ForeignKey("users.id"))
    created_at = Column(DateTime, default=datetime.utcnow, index=True)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)


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
    reply_to_message_id = Column(Integer, ForeignKey("group_chat_messages.id"), index=True)
    message = Column(Text, nullable=False)
    attachments_json = Column(JSON)
    mentions_json = Column(JSON)
    forward_metadata_json = Column(JSON)
    created_at = Column(DateTime, default=datetime.utcnow, index=True)
    edited_at = Column(DateTime)
    deleted_at = Column(DateTime, index=True)


class DirectMessage(Base):
    __tablename__ = "direct_messages"

    id = Column(Integer, primary_key=True)
    sender_id = Column(Integer, ForeignKey("users.id"), nullable=False, index=True)
    recipient_id = Column(Integer, ForeignKey("users.id"), nullable=False, index=True)
    reply_to_message_id = Column(Integer, ForeignKey("direct_messages.id"), index=True)
    message = Column(Text, nullable=False)
    attachments_json = Column(JSON)
    forward_metadata_json = Column(JSON)
    created_at = Column(DateTime, default=datetime.utcnow, index=True)
    edited_at = Column(DateTime)
    deleted_at = Column(DateTime, index=True)


class ChatMessageReadReceipt(Base):
    __tablename__ = "chat_message_read_receipts"
    __table_args__ = (
        UniqueConstraint("message_scope", "message_id", "user_id", name="ux_chat_message_read_receipts_scope_message_user"),
        Index("ix_chat_message_read_receipts_scope_message", "message_scope", "message_id"),
        Index("ix_chat_message_read_receipts_user_scope", "user_id", "message_scope"),
    )

    id = Column(Integer, primary_key=True)
    message_scope = Column(String(20), nullable=False, index=True)
    message_id = Column(Integer, nullable=False, index=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False, index=True)
    delivered_at = Column(DateTime, index=True)
    seen_at = Column(DateTime, index=True)


class ChatMessageReaction(Base):
    __tablename__ = "chat_message_reactions"
    __table_args__ = (
        UniqueConstraint("message_scope", "message_id", "user_id", name="ux_chat_message_reactions_scope_message_user"),
        Index("ix_chat_message_reactions_scope_message", "message_scope", "message_id"),
        Index("ix_chat_message_reactions_user_scope", "user_id", "message_scope"),
    )

    id = Column(Integer, primary_key=True)
    message_scope = Column(String(20), nullable=False, index=True)
    message_id = Column(Integer, nullable=False, index=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False, index=True)
    emoji = Column(String(32), nullable=False)
    created_at = Column(DateTime, default=datetime.utcnow, index=True)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, index=True)


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
            "archivedAt": serialize_utc_datetime(self.archived_at),
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
            "timestamp": serialize_utc_datetime(self.timestamp)
        }
