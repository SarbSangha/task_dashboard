# providers/chatgpt/models.py - ChatGPT Capture & Conversation Intelligence data model
from sqlalchemy import Column, Integer, String, Text, DateTime, Date, Boolean, ForeignKey, JSON, Index, UniqueConstraint, CheckConstraint, text
from sqlalchemy.orm import relationship
from datetime import datetime
from database_config import Base
from utils.datetime_utils import serialize_utc_datetime


class ConversationProject(Base):
    __tablename__ = "conversation_projects"
    __table_args__ = (
        Index(
            "ux_conversation_projects_owner_normalized_name_active",
            "owner_user_id",
            "normalized_name",
            unique=True,
            postgresql_where=text("archived_at IS NULL"),
            sqlite_where=text("archived_at IS NULL"),
        ),
        Index("ix_conversation_projects_owner_updated_at", "owner_user_id", "updated_at"),
        Index("ix_conversation_projects_archived_at", "archived_at"),
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

    conversations = relationship("ConversationRecord", back_populates="project")

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


class ConversationRecoveryAudit(Base):
    __tablename__ = "conversation_recovery_audits"
    __table_args__ = (
        Index("ix_conversation_recovery_audits_admin_created_at", "requested_by_admin_id", "created_at"),
        Index("ix_conversation_recovery_audits_provider_action_created_at", "provider", "action_type", "created_at"),
        Index("ix_conversation_recovery_audits_date_range_created_at", "date_from", "date_to", "created_at"),
    )

    id = Column(Integer, primary_key=True, index=True)
    provider = Column(String(40), nullable=False, default="chatgpt", index=True)
    action_type = Column(String(40), nullable=False, index=True)
    requested_by_admin_id = Column(Integer, ForeignKey("users.id", ondelete="RESTRICT"), nullable=False, index=True)
    date_from = Column(Date, nullable=False, index=True)
    date_to = Column(Date, nullable=False, index=True)
    source_count = Column(Integer, nullable=False, default=0)
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

    conversations = relationship("ConversationRecord", back_populates="recovery_audit")

    def to_dict(self):
        return {
            "id": self.id,
            "provider": self.provider,
            "actionType": self.action_type,
            "requestedByAdminId": self.requested_by_admin_id,
            "dateFrom": self.date_from.isoformat() if self.date_from else None,
            "dateTo": self.date_to.isoformat() if self.date_to else None,
            "sourceCount": self.source_count,
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


class ConversationCaptureEvent(Base):
    """Raw, provider-agnostic capture signal (prompt/response/lifecycle event) reported by the extension,
    stored losslessly and opaquely (payload_json) before normalization into
    ConversationRecord/ConversationPrompt/ConversationResponse in Phase 3.

    Deliberately thin: no parsing, no business logic. provider_conversation_id/provider_message_id are
    kept as columns (not buried in payload_json) purely so Phase 3 can query/replay by conversation
    without scanning JSON - they are not "parsed" content, just routing keys the extension already knows.

    Idempotency is client_event_id, not provider_message_id/fingerprint: a raw event log legitimately has
    multiple rows per message (response_started + response_completed share a message_id), so uniqueness
    can only live on an id the extension itself guarantees is stable across retries of the same attempt.
    """
    __tablename__ = "conversation_capture_events"
    __table_args__ = (
        Index(
            "ux_conversation_capture_events_credential_client_event_id",
            "provider", "credential_id", "client_event_id",
            unique=True,
        ),
        Index("ix_conversation_capture_events_conversation_id", "provider_conversation_id"),
        Index("ix_conversation_capture_events_message_id", "provider_message_id"),
        Index("ix_conversation_capture_events_tool_created_at", "tool_id", "created_at"),
        Index("ix_conversation_capture_events_user_created_at", "user_id", "created_at"),
        # event_type and created_at already get ix_conversation_capture_events_event_type
        # / ix_conversation_capture_events_created_at from Column(index=True) below - a
        # fresh install (Base.metadata.create_all) creates them without needing an entry
        # here. migrations.py adds the same two by raw name for already-existing tables
        # created before this column-level index=True was added.
    )

    id = Column(Integer, primary_key=True, index=True)
    tool_id = Column(Integer, ForeignKey("it_portal_tools.id"), nullable=False, index=True)
    credential_id = Column(Integer, ForeignKey("it_portal_tool_credentials.id"), index=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False, index=True)
    provider = Column(String(40), nullable=False, default="chatgpt", index=True)
    event_type = Column(String(40), nullable=False, index=True)
    client_event_id = Column(String(160), nullable=False)
    provider_conversation_id = Column(String(160), index=True)
    provider_message_id = Column(String(160), index=True)
    payload_json = Column(JSON, nullable=False)
    capture_version = Column(Integer, nullable=False, default=1)
    extension_version = Column(String(40))
    browser = Column(String(80))
    tab_id = Column(Integer)
    session_id = Column(String(512), index=True)
    extension_session_id = Column(String(160), index=True)
    event_date = Column(Date, nullable=False, index=True)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False, index=True)

    def to_dict(self):
        return {
            "id": self.id,
            "toolId": self.tool_id,
            "credentialId": self.credential_id,
            "userId": self.user_id,
            "provider": self.provider,
            "eventType": self.event_type,
            "clientEventId": self.client_event_id,
            "providerConversationId": self.provider_conversation_id,
            "providerMessageId": self.provider_message_id,
            "payload": self.payload_json or {},
            "captureVersion": self.capture_version,
            "extensionVersion": self.extension_version,
            "browser": self.browser,
            "tabId": self.tab_id,
            "sessionId": self.session_id,
            "extensionSessionId": self.extension_session_id,
            "eventDate": self.event_date.isoformat() if self.event_date else None,
            "createdAt": serialize_utc_datetime(self.created_at),
        }


class ConversationRecord(Base):
    __tablename__ = "conversation_records"
    __table_args__ = (
        CheckConstraint(
            "provider_conversation_id IS NOT NULL OR canonical_conversation_key IS NOT NULL",
            name="ck_conversation_records_identity_present",
        ),
        Index(
            "ux_conversation_records_provider_conversation_id",
            "provider", "provider_conversation_id",
            unique=True,
            postgresql_where=text("provider_conversation_id IS NOT NULL"),
            sqlite_where=text("provider_conversation_id IS NOT NULL"),
        ),
        Index(
            "ux_conversation_records_provider_canonical_key",
            "provider", "canonical_conversation_key",
            unique=True,
            postgresql_where=text("canonical_conversation_key IS NOT NULL"),
            sqlite_where=text("canonical_conversation_key IS NOT NULL"),
        ),
        Index("ix_conversation_records_owner_project_created_at", "owner_user_id", "project_id", "created_at"),
        Index("ix_conversation_records_owner_status_created_at", "owner_user_id", "ownership_status", "created_at"),
        Index("ix_conversation_records_project_created_at", "project_id", "created_at"),
        Index("ix_conversation_records_ingestion_created_at", "ingestion_source", "created_at"),
        Index("ix_conversation_records_favorite_created_at", "is_favorite", "created_at"),
    )

    id = Column(Integer, primary_key=True, index=True)
    provider = Column(String(40), nullable=False, default="chatgpt", index=True)
    provider_conversation_id = Column(String(160), index=True)
    canonical_conversation_key = Column(Text)
    title = Column(String(500))
    conversation_url = Column(Text)
    model_label = Column(String(255))
    gpt_version = Column(String(80))
    workspace_type = Column(String(80))
    provider_created_time = Column(DateTime)
    provider_updated_time = Column(DateTime)
    conversation_status = Column(String(40), nullable=False, default="active", index=True)
    is_pinned = Column(Boolean, nullable=False, default=False, index=True)
    is_archived = Column(Boolean, nullable=False, default=False, index=True)
    is_deleted_detected = Column(Boolean, nullable=False, default=False, index=True)
    prompt_count = Column(Integer, nullable=False, default=0)
    response_count = Column(Integer, nullable=False, default=0)
    ingestion_source = Column(String(40), nullable=False, default="captured", index=True)
    capture_status = Column(String(40), nullable=False, default="active", index=True)
    owner_user_id = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), index=True)
    ownership_status = Column(String(40), nullable=False, default="unknown", index=True)
    ownership_source = Column(String(80))
    ownership_notes = Column(Text)
    assigned_by_admin_id = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"))
    assigned_at = Column(DateTime)
    project_id = Column(Integer, ForeignKey("conversation_projects.id", ondelete="SET NULL"), index=True)
    recovery_audit_id = Column(Integer, ForeignKey("conversation_recovery_audits.id", ondelete="SET NULL"), index=True)
    recovered_by_admin_id = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"))
    recovered_at = Column(DateTime)
    metadata_json = Column(JSON)
    is_favorite = Column(Boolean, nullable=False, default=False, index=True)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False, index=True)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, nullable=False, index=True)
    archived_at = Column(DateTime, index=True)

    project = relationship("ConversationProject", back_populates="conversations")
    recovery_audit = relationship("ConversationRecoveryAudit", back_populates="conversations")
    prompts = relationship("ConversationPrompt", back_populates="conversation")
    responses = relationship("ConversationResponse", back_populates="conversation")
    generated_assets = relationship("ConversationGeneratedAsset", back_populates="conversation")

    def to_dict(self):
        return {
            "id": self.id,
            "provider": self.provider,
            "providerConversationId": self.provider_conversation_id,
            "canonicalConversationKey": self.canonical_conversation_key,
            "title": self.title,
            "conversationUrl": self.conversation_url,
            "modelLabel": self.model_label,
            "gptVersion": self.gpt_version,
            "workspaceType": self.workspace_type,
            "providerCreatedTime": serialize_utc_datetime(self.provider_created_time),
            "providerUpdatedTime": serialize_utc_datetime(self.provider_updated_time),
            "conversationStatus": self.conversation_status,
            "isPinned": bool(self.is_pinned),
            "isArchived": bool(self.is_archived),
            "isDeletedDetected": bool(self.is_deleted_detected),
            "promptCount": self.prompt_count,
            "responseCount": self.response_count,
            "ingestionSource": self.ingestion_source,
            "captureStatus": self.capture_status,
            "ownerUserId": self.owner_user_id,
            "ownershipStatus": self.ownership_status,
            "ownershipSource": self.ownership_source,
            "ownershipNotes": self.ownership_notes,
            "assignedByAdminId": self.assigned_by_admin_id,
            "assignedAt": serialize_utc_datetime(self.assigned_at),
            "projectId": self.project_id,
            "recoveryAuditId": self.recovery_audit_id,
            "recoveredByAdminId": self.recovered_by_admin_id,
            "recoveredAt": serialize_utc_datetime(self.recovered_at),
            "metadata": self.metadata_json or {},
            "isFavorite": bool(self.is_favorite),
            "createdAt": serialize_utc_datetime(self.created_at),
            "updatedAt": serialize_utc_datetime(self.updated_at),
            "archivedAt": serialize_utc_datetime(self.archived_at),
        }


class ConversationPrompt(Base):
    __tablename__ = "conversation_prompts"
    __table_args__ = (
        Index(
            "ux_conversation_prompts_conversation_message_id",
            "conversation_id", "provider_message_id",
            unique=True,
            postgresql_where=text("provider_message_id IS NOT NULL"),
            sqlite_where=text("provider_message_id IS NOT NULL"),
        ),
        Index("ix_conversation_prompts_conversation_sequence", "conversation_id", "sequence_index"),
    )

    id = Column(Integer, primary_key=True, index=True)
    conversation_id = Column(Integer, ForeignKey("conversation_records.id", ondelete="CASCADE"), nullable=False, index=True)
    source_capture_event_id = Column(Integer, ForeignKey("conversation_capture_events.id", ondelete="SET NULL"))
    provider_message_id = Column(String(160), index=True)
    sequence_index = Column(Integer, nullable=False, default=0)
    prompt_text = Column(Text)
    prompt_length = Column(Integer)
    attachments_json = Column(JSON)
    images_json = Column(JSON)
    files_json = Column(JSON)
    code_blocks_json = Column(JSON)
    prompt_metadata_json = Column(JSON)
    prompt_timestamp = Column(DateTime)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False, index=True)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, nullable=False)

    conversation = relationship("ConversationRecord", back_populates="prompts")

    def to_dict(self):
        return {
            "id": self.id,
            "conversationId": self.conversation_id,
            "sourceCaptureEventId": self.source_capture_event_id,
            "providerMessageId": self.provider_message_id,
            "sequenceIndex": self.sequence_index,
            "promptText": self.prompt_text,
            "promptLength": self.prompt_length,
            "attachments": self.attachments_json or [],
            "images": self.images_json or [],
            "files": self.files_json or [],
            "codeBlocks": self.code_blocks_json or [],
            "promptMetadata": self.prompt_metadata_json or {},
            "promptTimestamp": serialize_utc_datetime(self.prompt_timestamp),
            "createdAt": serialize_utc_datetime(self.created_at),
            "updatedAt": serialize_utc_datetime(self.updated_at),
        }


class ConversationResponse(Base):
    __tablename__ = "conversation_responses"
    __table_args__ = (
        Index(
            "ux_conversation_responses_conversation_message_id",
            "conversation_id", "provider_message_id",
            unique=True,
            postgresql_where=text("provider_message_id IS NOT NULL"),
            sqlite_where=text("provider_message_id IS NOT NULL"),
        ),
        Index("ix_conversation_responses_conversation_sequence", "conversation_id", "sequence_index"),
        Index("ix_conversation_responses_prompt_id", "prompt_id"),
    )

    id = Column(Integer, primary_key=True, index=True)
    conversation_id = Column(Integer, ForeignKey("conversation_records.id", ondelete="CASCADE"), nullable=False, index=True)
    prompt_id = Column(Integer, ForeignKey("conversation_prompts.id", ondelete="SET NULL"))
    source_capture_event_id = Column(Integer, ForeignKey("conversation_capture_events.id", ondelete="SET NULL"))
    provider_message_id = Column(String(160), index=True)
    sequence_index = Column(Integer, nullable=False, default=0)
    response_text = Column(Text)
    response_length = Column(Integer)
    code_blocks_json = Column(JSON)
    has_markdown = Column(Boolean, nullable=False, default=False)
    has_tables = Column(Boolean, nullable=False, default=False)
    images_json = Column(JSON)
    files_json = Column(JSON)
    artifacts_json = Column(JSON)
    reasoning_metadata_json = Column(JSON)
    response_status = Column(String(40), nullable=False, default="completed", index=True)
    response_timestamp = Column(DateTime)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False, index=True)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, nullable=False)

    conversation = relationship("ConversationRecord", back_populates="responses")

    def to_dict(self):
        return {
            "id": self.id,
            "conversationId": self.conversation_id,
            "promptId": self.prompt_id,
            "sourceCaptureEventId": self.source_capture_event_id,
            "providerMessageId": self.provider_message_id,
            "sequenceIndex": self.sequence_index,
            "responseText": self.response_text,
            "responseLength": self.response_length,
            "codeBlocks": self.code_blocks_json or [],
            "hasMarkdown": bool(self.has_markdown),
            "hasTables": bool(self.has_tables),
            "images": self.images_json or [],
            "files": self.files_json or [],
            "artifacts": self.artifacts_json or [],
            "reasoningMetadata": self.reasoning_metadata_json or {},
            "responseStatus": self.response_status,
            "responseTimestamp": serialize_utc_datetime(self.response_timestamp),
            "createdAt": serialize_utc_datetime(self.created_at),
            "updatedAt": serialize_utc_datetime(self.updated_at),
        }


class ConversationGeneratedAsset(Base):
    __tablename__ = "conversation_generated_assets"
    __table_args__ = (
        Index(
            "ux_conversation_generated_assets_provider_asset_id",
            "provider", "provider_asset_id",
            unique=True,
            postgresql_where=text("provider_asset_id IS NOT NULL"),
            sqlite_where=text("provider_asset_id IS NOT NULL"),
        ),
        Index("ix_conversation_generated_assets_conversation_created_at", "conversation_id", "created_at"),
        Index("ix_conversation_generated_assets_response_id", "response_id"),
    )

    id = Column(Integer, primary_key=True, index=True)
    conversation_id = Column(Integer, ForeignKey("conversation_records.id", ondelete="CASCADE"), nullable=False, index=True)
    response_id = Column(Integer, ForeignKey("conversation_responses.id", ondelete="SET NULL"))
    prompt_id = Column(Integer, ForeignKey("conversation_prompts.id", ondelete="SET NULL"))
    provider = Column(String(40), nullable=False, default="chatgpt", index=True)
    output_type = Column(String(40), nullable=False, index=True)
    provider_asset_id = Column(String(160), index=True)
    canonical_asset_key = Column(String(255), index=True)
    file_url = Column(Text)
    file_name = Column(String(500))
    mime_type = Column(String(120))
    size_bytes = Column(Integer)
    metadata_json = Column(JSON)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False, index=True)

    conversation = relationship("ConversationRecord", back_populates="generated_assets")

    def to_dict(self):
        return {
            "id": self.id,
            "conversationId": self.conversation_id,
            "responseId": self.response_id,
            "promptId": self.prompt_id,
            "provider": self.provider,
            "outputType": self.output_type,
            "providerAssetId": self.provider_asset_id,
            "canonicalAssetKey": self.canonical_asset_key,
            "fileUrl": self.file_url,
            "fileName": self.file_name,
            "mimeType": self.mime_type,
            "sizeBytes": self.size_bytes,
            "metadata": self.metadata_json or {},
            "createdAt": serialize_utc_datetime(self.created_at),
        }


class ConversationTag(Base):
    __tablename__ = "conversation_tags"
    __table_args__ = (
        UniqueConstraint("conversation_id", "normalized_tag", name="ux_conversation_tags_conversation_normalized"),
        Index("ix_conversation_tags_normalized_tag", "normalized_tag"),
        Index("ix_conversation_tags_conversation_id", "conversation_id"),
    )

    id = Column(Integer, primary_key=True, index=True)
    conversation_id = Column(Integer, ForeignKey("conversation_records.id", ondelete="CASCADE"), nullable=False)
    tag = Column(String(80), nullable=False)
    normalized_tag = Column(String(80), nullable=False)
    created_by = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"))
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False, index=True)

    def to_dict(self):
        return {
            "id": self.id,
            "conversationId": self.conversation_id,
            "tag": self.tag,
            "createdBy": self.created_by,
            "createdAt": serialize_utc_datetime(self.created_at),
        }


class ConversationCaptureHealth(Base):
    """Latest known health snapshot of one extension install's capture queue (not an event
    log - one row per install, upserted on each health ping). Backs the Capture Center's
    future "is capture healthy for this user right now" indicator.

    Scoped by extension_session_id (a browser install/launch identity) rather than
    credential_id, because the retry queue lives in the browser and its health is a property
    of that install, not of which ChatGPT account happens to be logged in through it.

    last_capture_event_at (extension observed an event locally) is deliberately distinct from
    last_successful_upload_at (backend confirmed receiving one): an idle user with an empty
    queue and no recent captures is healthy; an actively-chatting user with recent captures
    but no recent successful uploads is not - the two would look identical without this field.
    """
    __tablename__ = "conversation_capture_health"
    __table_args__ = (
        Index(
            "ux_conversation_capture_health_session",
            "provider", "extension_session_id",
            unique=True,
            postgresql_where=text("extension_session_id IS NOT NULL"),
            sqlite_where=text("extension_session_id IS NOT NULL"),
        ),
        # user_id and reported_at already get their single-column index from
        # Column(..., index=True) below - no separate Index() needed for those.
    )

    id = Column(Integer, primary_key=True, index=True)
    tool_id = Column(Integer, ForeignKey("it_portal_tools.id"), index=True)
    credential_id = Column(Integer, ForeignKey("it_portal_tool_credentials.id"), index=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False, index=True)
    provider = Column(String(40), nullable=False, default="chatgpt", index=True)
    extension_session_id = Column(String(160))
    extension_version = Column(String(40))
    queue_length = Column(Integer, nullable=False, default=0)
    events_waiting = Column(Integer, nullable=False, default=0)
    oldest_pending_event_at = Column(DateTime)
    retry_count = Column(Integer, nullable=False, default=0)
    last_capture_event_at = Column(DateTime)
    last_successful_upload_at = Column(DateTime)
    last_failed_upload_at = Column(DateTime)
    average_upload_time_ms = Column(Integer)
    offline_since = Column(DateTime)
    reported_at = Column(DateTime, default=datetime.utcnow, nullable=False, index=True)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False, index=True)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, nullable=False, index=True)

    def to_dict(self):
        return {
            "id": self.id,
            "toolId": self.tool_id,
            "credentialId": self.credential_id,
            "userId": self.user_id,
            "provider": self.provider,
            "extensionSessionId": self.extension_session_id,
            "extensionVersion": self.extension_version,
            "queueLength": self.queue_length,
            "eventsWaiting": self.events_waiting,
            "oldestPendingEventAt": serialize_utc_datetime(self.oldest_pending_event_at),
            "retryCount": self.retry_count,
            "lastCaptureEventAt": serialize_utc_datetime(self.last_capture_event_at),
            "lastSuccessfulUploadAt": serialize_utc_datetime(self.last_successful_upload_at),
            "lastFailedUploadAt": serialize_utc_datetime(self.last_failed_upload_at),
            "averageUploadTimeMs": self.average_upload_time_ms,
            "offlineSince": serialize_utc_datetime(self.offline_since),
            "reportedAt": serialize_utc_datetime(self.reported_at),
            "createdAt": serialize_utc_datetime(self.created_at),
            "updatedAt": serialize_utc_datetime(self.updated_at),
        }


class ConversationProjectEvent(Base):
    """Activity log for a conversation project's timeline (project_created, conversation_assigned, etc.)."""
    __tablename__ = "conversation_project_events"
    __table_args__ = (
        Index("ix_conversation_project_events_project_created_at", "project_id", "created_at"),
    )

    id = Column(Integer, primary_key=True, index=True)
    project_id = Column(Integer, ForeignKey("conversation_projects.id", ondelete="CASCADE"), nullable=False)
    conversation_id = Column(Integer, ForeignKey("conversation_records.id", ondelete="SET NULL"))
    actor_user_id = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"))
    event_type = Column(String(40), nullable=False)
    description = Column(Text)
    metadata_json = Column(JSON)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False, index=True)

    def to_dict(self):
        return {
            "id": self.id,
            "projectId": self.project_id,
            "conversationId": self.conversation_id,
            "actorUserId": self.actor_user_id,
            "eventType": self.event_type,
            "description": self.description,
            "metadata": self.metadata_json or {},
            "createdAt": serialize_utc_datetime(self.created_at),
        }


class ConversationCaptureAttachment(Base):
    """An actual stored image/file for the Capture Center's media viewer -
    distinct from conversation_capture_events.payload_json's images/files
    arrays, which only ever carry {name, type} (the extension observes the
    filename from the outgoing request, never the bytes). This table holds
    the real file, uploaded to R2 by a dedicated best-effort path (DOM file
    input / drop interception, not network interception - ChatGPT's actual
    upload wire format is a presigned-URL flow to a host this extension
    doesn't otherwise touch, so the reliable capture point is the browser's
    File object at selection time, not the network).

    kind='input' for something the user attached to a prompt; kind='output'
    reserved for a future generation_captured (AI-generated image) capture
    path - not implemented yet, this column exists so that addition doesn't
    require another migration.

    client_event_id is a best-effort correlation to the prompt_captured event
    it was attached to (matched by filename - see capture.py) - nullable
    because the correlation can legitimately fail (rename, timing) and the
    attachment is still worth keeping even unmatched."""
    __tablename__ = "conversation_capture_attachments"
    __table_args__ = (
        Index("ix_conversation_capture_attachments_conversation_id", "provider_conversation_id"),
    )

    id = Column(Integer, primary_key=True, index=True)
    provider = Column(String(40), nullable=False, default="chatgpt", index=True)
    provider_conversation_id = Column(String(160), index=True)
    client_event_id = Column(String(160), index=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False, index=True)
    kind = Column(String(20), nullable=False, default="input")
    file_name = Column(String(500))
    mime_type = Column(String(120))
    size_bytes = Column(Integer)
    file_url = Column(Text, nullable=False)
    storage_path = Column(Text)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False, index=True)

    def to_dict(self):
        return {
            "id": self.id,
            "provider": self.provider,
            "providerConversationId": self.provider_conversation_id,
            "clientEventId": self.client_event_id,
            "userId": self.user_id,
            "kind": self.kind,
            "fileName": self.file_name,
            "mimeType": self.mime_type,
            "sizeBytes": self.size_bytes,
            "fileUrl": self.file_url,
            # The raw R2 URL isn't directly fetchable (bucket requires signed
            # access) - storagePath is the key the existing /api/files/open,
            # /api/files/thumbnail, /api/files/download endpoints expect via
            # their ?path= param, which is how the frontend actually renders
            # this (same mechanism the rest of the app already uses for
            # uploaded files).
            "storagePath": self.storage_path,
            "createdAt": serialize_utc_datetime(self.created_at),
        }
