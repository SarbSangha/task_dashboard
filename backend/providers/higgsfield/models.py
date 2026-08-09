# providers/higgsfield/models.py - Higgsfield Generation Capture data model
"""
Three-layer design, mirroring providers/heygen/models.py (this package's
template):

  HiggsfieldCaptureEvent (raw, append-only, lossless)
        -> normalization.py ->
  HiggsfieldGeneration (normalized, rich, one row per Higgsfield video job)
        -> normalization.py also projects a matching row into ->
  GenerationRecord (models_new.py, provider="higgsfield") for cross-tool
  reporting

HiggsfieldGeneration is NOT a duplicate of GenerationRecord: GenerationRecord
is the lowest-common-denominator table every provider's generations already
surface through (browse/search/claim UI in generation_records_router.py,
project/tag/collection organization) with a handful of generic columns.
HiggsfieldGeneration is the rich, Higgsfield-specific record - prompt/preset/
multi-shot/credit fields, each with its own column since (like HeyGen) these
are known, named concepts from the product UI rather than an unofficial
API's incidental shape. metadata_json/source_metadata_json still hold the
raw captured payload verbatim, so anything not given its own column - or a
Higgsfield API change - never loses data.

No real Higgsfield network traffic has been observed while building this -
see constants.py's module docstring. Several candidate identifier columns
are indexed rather than assuming one canonical name, the same uncertainty
HeyGen shipped with on 2026-08-04.
"""
from sqlalchemy import (
    Boolean,
    CheckConstraint,
    Column,
    Date,
    DateTime,
    Float,
    ForeignKey,
    Index,
    Integer,
    JSON,
    String,
    Text,
    text,
)
from datetime import datetime

from database_config import Base
from utils.datetime_utils import serialize_utc_datetime


class HiggsfieldCaptureEvent(Base):
    """Raw, provider-agnostic capture signal reported by the extension,
    stored losslessly and opaquely (payload_json) before normalization into
    HiggsfieldGeneration. Deliberately thin: no parsing, no business logic -
    see providers/higgsfield/capture.py.

    Idempotency is (provider, credential_id, client_event_id) - the same
    lesson every other provider's own dedupe cascade encodes: scope
    uniqueness by the real shared account (credential), never by the
    reporting portal user, since an admin re-scanning history under their
    own login must not spawn a duplicate row.
    """
    __tablename__ = "higgsfield_capture_events"
    __table_args__ = (
        Index(
            "ux_higgsfield_capture_events_credential_client_event_id",
            "provider", "credential_id", "client_event_id",
            unique=True,
        ),
        Index("ix_higgsfield_capture_events_generation_id", "provider_generation_id"),
        Index("ix_higgsfield_capture_events_project_id", "provider_project_id"),
        Index("ix_higgsfield_capture_events_tool_created_at", "tool_id", "created_at"),
        Index("ix_higgsfield_capture_events_user_created_at", "user_id", "created_at"),
    )

    id = Column(Integer, primary_key=True, index=True)
    tool_id = Column(Integer, ForeignKey("it_portal_tools.id"), nullable=False, index=True)
    credential_id = Column(Integer, ForeignKey("it_portal_tool_credentials.id"), index=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False, index=True)
    provider = Column(String(40), nullable=False, default="higgsfield", index=True)
    event_type = Column(String(40), nullable=False, index=True)
    client_event_id = Column(String(160), nullable=False)
    provider_generation_id = Column(String(160), index=True)
    provider_project_id = Column(String(160), index=True)
    ownership_confidence = Column(String(20))  # "ticket" | "reconciliation" - set by capture.py, not the extension
    # Task Mapping: the internal Task (tasks.id) the extension's gate had the
    # user select before this generation - re-validated server-side in
    # ingest_capture_event (never trusted from the client as-is).
    linked_task_id = Column(Integer, ForeignKey("tasks.id", ondelete="SET NULL"), index=True)
    linked_task_name = Column(String(255))
    # Client Mapping - independent selection from Task Mapping above.
    linked_client_id = Column(Integer, ForeignKey("generation_clients.id", ondelete="SET NULL"), index=True)
    linked_client_name = Column(String(255))
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
            "providerGenerationId": self.provider_generation_id,
            "providerProjectId": self.provider_project_id,
            "ownershipConfidence": self.ownership_confidence,
            "linkedTaskId": self.linked_task_id,
            "linkedTaskName": self.linked_task_name,
            "linkedClientId": self.linked_client_id,
            "linkedClientName": self.linked_client_name,
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


class HiggsfieldGeneration(Base):
    """One row per Higgsfield generation identity (generation_id/job_id/
    request_id - whichever the intercepted payload actually carries; no
    real Higgsfield response shape was directly observable while building
    this, see the package docstring, so several candidate identifiers are
    all indexed rather than assuming one canonical name).

    Ownership is capture-time-only, same posture as every other provider in
    this package: resolved exclusively from our own launch-ticket system at
    the moment of interception. A row imported later purely from
    history/reconciliation, with no matching live ticket, is structurally
    unattributable and stays ownership_status='unknown' by design.
    """
    __tablename__ = "higgsfield_generations"
    __table_args__ = (
        CheckConstraint(
            "generation_id IS NOT NULL OR job_id IS NOT NULL "
            "OR request_id IS NOT NULL OR external_event_id IS NOT NULL",
            name="ck_higgsfield_generations_identity_present",
        ),
        Index(
            "ux_higgsfield_generations_generation_id",
            "provider", "generation_id",
            unique=True,
            postgresql_where=text("generation_id IS NOT NULL"),
            sqlite_where=text("generation_id IS NOT NULL"),
        ),
        # job_id is populated from Higgsfield's job_set_id (see
        # normalization.py's docstring), a BATCH identifier multiple sibling
        # generations legitimately share (a multi-image job set producing
        # several outputs from one job_set_id, each with its own unique
        # generation_id but the same shared job_id) - unlike
        # generation_id/request_id, it must NOT be unique. Was wrongly
        # unique until 2026-08-06 (found via a live backfill_all run hitting
        # real UniqueViolation errors on real sibling-batch data); the
        # column-level index=True below already provides a normal,
        # non-unique index, so no explicit Index() entry is needed here at
        # all - same self-caught duplicate-index lesson this file's own
        # earlier history already records for a different column.
        Index(
            "ux_higgsfield_generations_request_id",
            "provider", "request_id",
            unique=True,
            postgresql_where=text("request_id IS NOT NULL"),
            sqlite_where=text("request_id IS NOT NULL"),
        ),
        Index("ix_higgsfield_generations_owner_created_at", "owner_user_id", "created_at"),
        Index("ix_higgsfield_generations_owner_status_created_at", "owner_user_id", "ownership_status", "created_at"),
        Index("ix_higgsfield_generations_credential_created_at", "credential_id", "created_at"),
        Index("ix_higgsfield_generations_ingestion_created_at", "ingestion_source", "created_at"),
        Index("ix_higgsfield_generations_generation_record_id", "generation_record_id"),
    )

    id = Column(Integer, primary_key=True, index=True)
    provider = Column(String(40), nullable=False, default="higgsfield", index=True)

    # ---- Identity ----
    generation_id = Column(String(160), index=True)
    job_id = Column(String(160), index=True)
    request_id = Column(String(160), index=True)
    project_id = Column(String(160), index=True)
    external_event_id = Column(String(160), index=True)  # client-generated intent id, fallback correlation key

    # ---- Ownership / capture provenance ----
    source_capture_event_id = Column(Integer, ForeignKey("higgsfield_capture_events.id", ondelete="SET NULL"))
    generation_record_id = Column(Integer, ForeignKey("generation_records.id", ondelete="SET NULL"))
    tool_id = Column(Integer, ForeignKey("it_portal_tools.id"), index=True)
    credential_id = Column(Integer, ForeignKey("it_portal_tool_credentials.id"), index=True)
    owner_user_id = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), index=True)
    ownership_status = Column(String(40), nullable=False, default="unknown", index=True)
    ownership_source = Column(String(80))
    ownership_notes = Column(Text)
    assigned_by_admin_id = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"))
    assigned_at = Column(DateTime)
    linked_task_id = Column(Integer, ForeignKey("tasks.id", ondelete="SET NULL"), index=True)
    linked_task_name = Column(String(255))
    linked_client_id = Column(Integer, ForeignKey("generation_clients.id", ondelete="SET NULL"), index=True)
    linked_client_name = Column(String(255))
    generation_source = Column(String(40), nullable=False, default="live_capture", index=True)  # live_capture | reconciliation
    generation_method = Column(String(40), nullable=False, default="network_intercept")  # network_intercept | dom_capture | history_scan
    ingestion_source = Column(String(40), nullable=False, default="captured", index=True)  # captured | recovered
    recovery_audit_id = Column(Integer, ForeignKey("higgsfield_recovery_audits.id", ondelete="SET NULL"), index=True)
    recovered_by_admin_id = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"))
    recovered_at = Column(DateTime)

    # ---- What tab/action produced this (Create Video | Edit Video | Motion
    # Control - see constants.py's EVENT_TYPE_* split) ----
    kind = Column(String(40), index=True)  # create_video | edit_video | motion_control

    # ---- Prompt / preset ----
    prompt_text = Column(Text)
    prompt_length = Column(Integer)
    preset_id = Column(String(160), index=True)
    preset_name = Column(String(255))  # e.g. "Seedance Pro", "General"
    preset_category = Column(String(120))  # e.g. camera control / framing / VFX, per the preset gallery
    multi_shot = Column(Boolean)
    enhance_prompt = Column(Boolean)  # the "Enhance on" toggle
    image_reference_url = Column(Text)  # DOM-scraped best-effort - the uploaded/generated starting image

    # ---- Video configuration ----
    resolution = Column(String(20))
    aspect_ratio = Column(String(20))
    fps = Column(Integer)
    duration_seconds = Column(Float)
    quality = Column(String(40))

    # ---- Credits ----
    credits_before = Column(Float)
    credits_after = Column(Float)
    credits_used = Column(Float)
    credit_ledger_json = Column(JSON)

    # ---- Status / lifecycle ----
    status = Column(String(40), index=True)
    provider_created_at = Column(DateTime)
    provider_updated_at = Column(DateTime)
    submitted_at = Column(DateTime)
    completed_at = Column(DateTime)
    failed_at = Column(DateTime)
    cancelled_at = Column(DateTime)
    generation_duration_ms = Column(Integer)

    # ---- Output assets ----
    # output_type ("video" | "image") - confirmed 2026-08-05 from real
    # traffic that Higgsfield is NOT video-only (unlike HeyGen): a
    # "nano_banana_2" job set produces images, results.raw.type: "image",
    # while a "seedance_2_0" job set produces video, results.raw.type:
    # "video". video_url/thumbnail_url/etc below keep their names for
    # continuity with every other column in this file even though they now
    # hold an image URL for an image-type generation - see
    # normalization.py's _extract_fields docstring. output_type is what the
    # dashboard's detail panel/card actually branch on to choose <video> vs
    # <img>, not a URL file-extension guess.
    output_type = Column(String(20), index=True)
    video_url = Column(Text)
    thumbnail_url = Column(Text)
    download_url = Column(Text)
    preview_url = Column(Text)

    # ---- Metadata catch-all (nothing discarded) ----
    metadata_json = Column(JSON)
    source_metadata_json = Column(JSON)

    created_at = Column(DateTime, default=datetime.utcnow, nullable=False, index=True)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, nullable=False, index=True)

    def to_dict(self):
        return {
            "id": self.id,
            "provider": self.provider,
            "generationId": self.generation_id,
            "jobId": self.job_id,
            "requestId": self.request_id,
            "projectId": self.project_id,
            "externalEventId": self.external_event_id,
            "sourceCaptureEventId": self.source_capture_event_id,
            "generationRecordId": self.generation_record_id,
            "toolId": self.tool_id,
            "credentialId": self.credential_id,
            "ownerUserId": self.owner_user_id,
            "ownershipStatus": self.ownership_status,
            "ownershipSource": self.ownership_source,
            "ownershipNotes": self.ownership_notes,
            "assignedByAdminId": self.assigned_by_admin_id,
            "assignedAt": serialize_utc_datetime(self.assigned_at),
            "linkedTaskId": self.linked_task_id,
            "linkedTaskName": self.linked_task_name,
            "linkedClientId": self.linked_client_id,
            "linkedClientName": self.linked_client_name,
            "generationSource": self.generation_source,
            "generationMethod": self.generation_method,
            "ingestionSource": self.ingestion_source,
            "recoveryAuditId": self.recovery_audit_id,
            "recoveredByAdminId": self.recovered_by_admin_id,
            "recoveredAt": serialize_utc_datetime(self.recovered_at),
            "kind": self.kind,
            "promptText": self.prompt_text,
            "promptLength": self.prompt_length,
            "presetId": self.preset_id,
            "presetName": self.preset_name,
            "presetCategory": self.preset_category,
            "multiShot": self.multi_shot,
            "enhancePrompt": self.enhance_prompt,
            "imageReferenceUrl": self.image_reference_url,
            "resolution": self.resolution,
            "aspectRatio": self.aspect_ratio,
            "fps": self.fps,
            "durationSeconds": self.duration_seconds,
            "quality": self.quality,
            "creditsBefore": self.credits_before,
            "creditsAfter": self.credits_after,
            "creditsUsed": self.credits_used,
            "creditLedger": self.credit_ledger_json or [],
            "status": self.status,
            "providerCreatedAt": serialize_utc_datetime(self.provider_created_at),
            "providerUpdatedAt": serialize_utc_datetime(self.provider_updated_at),
            "submittedAt": serialize_utc_datetime(self.submitted_at),
            "completedAt": serialize_utc_datetime(self.completed_at),
            "failedAt": serialize_utc_datetime(self.failed_at),
            "cancelledAt": serialize_utc_datetime(self.cancelled_at),
            "generationDurationMs": self.generation_duration_ms,
            "outputType": self.output_type,
            "videoUrl": self.video_url,
            "thumbnailUrl": self.thumbnail_url,
            "downloadUrl": self.download_url,
            "previewUrl": self.preview_url,
            "metadata": self.metadata_json or {},
            "sourceMetadata": self.source_metadata_json or {},
            "createdAt": serialize_utc_datetime(self.created_at),
            "updatedAt": serialize_utc_datetime(self.updated_at),
        }


class HiggsfieldRecoveryAudit(Base):
    """Batch-import provenance for admin-triggered full reconciliation runs -
    mirrors HeygenRecoveryAudit exactly."""
    __tablename__ = "higgsfield_recovery_audits"
    __table_args__ = (
        Index("ix_higgsfield_recovery_audits_admin_created_at", "requested_by_admin_id", "created_at"),
        Index("ix_higgsfield_recovery_audits_action_created_at", "action_type", "created_at"),
    )

    id = Column(Integer, primary_key=True, index=True)
    provider = Column(String(40), nullable=False, default="higgsfield", index=True)
    action_type = Column(String(40), nullable=False, index=True)  # analyze | import
    requested_by_admin_id = Column(Integer, ForeignKey("users.id", ondelete="RESTRICT"), nullable=False, index=True)
    credential_id = Column(Integer, ForeignKey("it_portal_tool_credentials.id"), index=True)
    pages_walked = Column(Integer, nullable=False, default=0)
    source_count = Column(Integer, nullable=False, default=0)
    database_count = Column(Integer, nullable=False, default=0)
    missing_count = Column(Integer, nullable=False, default=0)
    imported_count = Column(Integer, nullable=False, default=0)
    duplicate_count = Column(Integer, nullable=False, default=0)
    status = Column(String(40), nullable=False, default="started", index=True)
    report_json = Column(JSON)
    error_message = Column(Text)
    started_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    completed_at = Column(DateTime)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False, index=True)

    def to_dict(self):
        return {
            "id": self.id,
            "provider": self.provider,
            "actionType": self.action_type,
            "requestedByAdminId": self.requested_by_admin_id,
            "credentialId": self.credential_id,
            "pagesWalked": self.pages_walked,
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


class HiggsfieldSyncCursor(Base):
    """Extension-driven reconciliation progress, one row per credential (the
    shared Higgsfield account) - see providers/higgsfield/sync.py. The
    actual page-walk trigger is not wired up in this pass (no confirmed
    Higgsfield history/listing endpoint shape yet); this table exists so
    the bookkeeping is ready the moment that endpoint is confirmed, without
    a schema change - mirrors HeygenSyncCursor exactly."""
    __tablename__ = "higgsfield_sync_cursors"
    __table_args__ = (
        Index("ux_higgsfield_sync_cursors_credential", "credential_id", unique=True),
    )

    id = Column(Integer, primary_key=True, index=True)
    credential_id = Column(Integer, ForeignKey("it_portal_tool_credentials.id"), nullable=False, index=True)
    last_seen_generation_id = Column(String(160))
    last_synced_page = Column(Integer, nullable=False, default=0)
    last_full_reconciliation_at = Column(DateTime)
    last_run_at = Column(DateTime)
    last_run_by_user_id = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"))
    status = Column(String(40), nullable=False, default="idle", index=True)  # idle | running | failed
    last_error = Column(Text)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, nullable=False)

    def to_dict(self):
        return {
            "id": self.id,
            "credentialId": self.credential_id,
            "lastSeenGenerationId": self.last_seen_generation_id,
            "lastSyncedPage": self.last_synced_page,
            "lastFullReconciliationAt": serialize_utc_datetime(self.last_full_reconciliation_at),
            "lastRunAt": serialize_utc_datetime(self.last_run_at),
            "lastRunByUserId": self.last_run_by_user_id,
            "status": self.status,
            "lastError": self.last_error,
            "createdAt": serialize_utc_datetime(self.created_at),
            "updatedAt": serialize_utc_datetime(self.updated_at),
        }


class HiggsfieldCaptureHealth(Base):
    """Latest known health snapshot of one extension install's Higgsfield
    capture (not an event log - one row per install, upserted on each
    health ping). Mirrors HeygenCaptureHealth exactly."""
    __tablename__ = "higgsfield_capture_health"
    __table_args__ = (
        Index(
            "ux_higgsfield_capture_health_session",
            "provider", "extension_session_id",
            unique=True,
            postgresql_where=text("extension_session_id IS NOT NULL"),
            sqlite_where=text("extension_session_id IS NOT NULL"),
        ),
    )

    id = Column(Integer, primary_key=True, index=True)
    tool_id = Column(Integer, ForeignKey("it_portal_tools.id"), index=True)
    credential_id = Column(Integer, ForeignKey("it_portal_tool_credentials.id"), index=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False, index=True)
    provider = Column(String(40), nullable=False, default="higgsfield", index=True)
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
