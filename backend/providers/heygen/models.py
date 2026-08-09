# providers/heygen/models.py - HeyGen Generation Capture data model
"""
Three-layer design, mirroring providers/freepik/models.py (this package's
template):

  HeygenCaptureEvent (raw, append-only, lossless)
        -> normalization.py ->
  HeygenGeneration (normalized, rich, one row per HeyGen video/render/job)
        -> normalization.py also projects a matching row into ->
  GenerationRecord (models_new.py, provider="heygen") for cross-tool reporting

HeygenGeneration is NOT a duplicate of GenerationRecord: GenerationRecord is
the lowest-common-denominator table every provider's generations already
surface through (browse/search/claim UI in generation_records_router.py,
project/tag/collection organization) with a handful of generic columns.
HeygenGeneration is the rich, HeyGen-specific record - avatar, voice, scene,
video-config and credit fields the spec calls out explicitly, each with its
own column since (unlike Freepik) these are known, named fields rather than
an unofficial API's incidental shape. metadata_json/source_metadata_json
still hold the raw captured payload verbatim, so anything not given its own
column - or a HeyGen API change - never loses data.
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
from utils import r2_storage


def _presigned_mirror_url(key, *, client=None):
    """Mints a fresh short-lived R2 URL for a mirrored-asset key at
    serialization time - see providers/freepik/models.py's identical helper
    for the private-bucket reasoning (this package's template). Swallows any
    failure (R2 not configured, a transient signing error) rather than let
    one broken asset take down an entire API response - the field just comes
    back null, same as never having been mirrored yet."""
    if not key:
        return None
    try:
        if not r2_storage.is_configured():
            return None
        return r2_storage.generate_presigned_url(key, client=client)
    except Exception:
        return None


class HeygenCaptureEvent(Base):
    """Raw, provider-agnostic capture signal reported by the extension, stored
    losslessly and opaquely (payload_json) before normalization into
    HeygenGeneration. Deliberately thin: no parsing, no business logic - see
    providers/heygen/capture.py.

    Idempotency is (provider, credential_id, client_event_id) - the same
    lesson Freepik's dedupe cascade encodes: scope uniqueness by the real
    shared account (credential), never by the reporting portal user, since an
    admin re-scanning history under their own login must not spawn a
    duplicate row.
    """
    __tablename__ = "heygen_capture_events"
    __table_args__ = (
        Index(
            "ux_heygen_capture_events_credential_client_event_id",
            "provider", "credential_id", "client_event_id",
            unique=True,
        ),
        Index("ix_heygen_capture_events_video_id", "provider_video_id"),
        Index("ix_heygen_capture_events_project_id", "provider_project_id"),
        Index("ix_heygen_capture_events_tool_created_at", "tool_id", "created_at"),
        Index("ix_heygen_capture_events_user_created_at", "user_id", "created_at"),
    )

    id = Column(Integer, primary_key=True, index=True)
    tool_id = Column(Integer, ForeignKey("it_portal_tools.id"), nullable=False, index=True)
    credential_id = Column(Integer, ForeignKey("it_portal_tool_credentials.id"), index=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False, index=True)
    provider = Column(String(40), nullable=False, default="heygen", index=True)
    event_type = Column(String(40), nullable=False, index=True)
    client_event_id = Column(String(160), nullable=False)
    provider_video_id = Column(String(160), index=True)
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
            "providerVideoId": self.provider_video_id,
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


class HeygenGeneration(Base):
    """One row per HeyGen generation identity (video_id / render_id / job_id /
    workflow_id - whichever the intercepted payload actually carries; HeyGen's
    exact field naming was not directly observable while building this, see
    the package README, so several candidate identifiers are all indexed
    rather than assuming one canonical name).

    Ownership is capture-time-only, same posture as Freepik: resolved
    exclusively from our own launch-ticket system at the moment of
    interception. A row imported later purely from history/reconciliation,
    with no matching live ticket, is structurally unattributable and stays
    ownership_status='unknown' by design.
    """
    __tablename__ = "heygen_generations"
    __table_args__ = (
        CheckConstraint(
            "video_id IS NOT NULL OR render_id IS NOT NULL OR job_id IS NOT NULL "
            "OR workflow_id IS NOT NULL OR external_event_id IS NOT NULL",
            name="ck_heygen_generations_identity_present",
        ),
        Index(
            "ux_heygen_generations_video_id",
            "provider", "video_id",
            unique=True,
            postgresql_where=text("video_id IS NOT NULL"),
            sqlite_where=text("video_id IS NOT NULL"),
        ),
        Index(
            "ux_heygen_generations_render_id",
            "provider", "render_id",
            unique=True,
            postgresql_where=text("render_id IS NOT NULL"),
            sqlite_where=text("render_id IS NOT NULL"),
        ),
        Index(
            "ux_heygen_generations_job_id",
            "provider", "job_id",
            unique=True,
            postgresql_where=text("job_id IS NOT NULL"),
            sqlite_where=text("job_id IS NOT NULL"),
        ),
        Index(
            "ux_heygen_generations_workflow_id",
            "provider", "workflow_id",
            unique=True,
            postgresql_where=text("workflow_id IS NOT NULL"),
            sqlite_where=text("workflow_id IS NOT NULL"),
        ),
        Index("ix_heygen_generations_project_scene", "project_id", "scene_id"),
        Index("ix_heygen_generations_owner_created_at", "owner_user_id", "created_at"),
        Index("ix_heygen_generations_owner_status_created_at", "owner_user_id", "ownership_status", "created_at"),
        Index("ix_heygen_generations_credential_created_at", "credential_id", "created_at"),
        Index("ix_heygen_generations_ingestion_created_at", "ingestion_source", "created_at"),
        Index("ix_heygen_generations_generation_record_id", "generation_record_id"),
    )

    id = Column(Integer, primary_key=True, index=True)
    provider = Column(String(40), nullable=False, default="heygen", index=True)

    # ---- Identity ----
    video_id = Column(String(160), index=True)
    render_id = Column(String(160), index=True)
    job_id = Column(String(160), index=True)
    workflow_id = Column(String(160), index=True)
    request_id = Column(String(160), index=True)
    project_id = Column(String(160), index=True)
    scene_id = Column(String(160), index=True)
    external_event_id = Column(String(160), index=True)  # client-generated intent id, fallback correlation key

    # ---- Ownership / capture provenance ----
    source_capture_event_id = Column(Integer, ForeignKey("heygen_capture_events.id", ondelete="SET NULL"))
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
    recovery_audit_id = Column(Integer, ForeignKey("heygen_recovery_audits.id", ondelete="SET NULL"), index=True)
    recovered_by_admin_id = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"))
    recovered_at = Column(DateTime)

    # ---- Prompt / script ----
    script_text = Column(Text)
    prompt_length = Column(Integer)
    estimated_duration_seconds = Column(Float)

    # ---- Avatar ----
    avatar_id = Column(String(160), index=True)
    avatar_name = Column(String(255))
    avatar_version = Column(String(40))
    avatar_type = Column(String(40))
    avatar_position = Column(String(40))

    # ---- Voice ----
    voice_id = Column(String(160), index=True)
    voice_name = Column(String(255))
    voice_language = Column(String(40))
    voice_gender = Column(String(20))
    voice_style = Column(String(80))  # emotion/delivery style, e.g. "Serious"

    # ---- Scene ----
    scene_count = Column(Integer)
    scene_ids_json = Column(JSON)
    layout = Column(String(40))
    background_type = Column(String(40))

    # ---- Video configuration ----
    resolution = Column(String(20))
    aspect_ratio = Column(String(20))
    fps = Column(Integer)
    duration_seconds = Column(Float)
    quality = Column(String(40))
    motion_engine = Column(String(40))  # e.g. "Avatar IV"

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
    video_url = Column(Text)
    thumbnail_url = Column(Text)
    download_url = Column(Text)
    preview_url = Column(Text)
    share_url = Column(Text)
    storage_url = Column(Text)

    # ---- Metadata catch-all (nothing discarded) ----
    metadata_json = Column(JSON)
    source_metadata_json = Column(JSON)

    # ---- Asset mirroring (see providers/heygen/asset_mirror.py) ----
    # video_url/download_url/thumbnail_url/preview_url above are HeyGen's own
    # signed CDN URLs, time-limited the same way Freepik/Pikaso's are - once
    # the token expires the original 404s permanently even for a correctly
    # captured generation. These hold the R2 object KEY of our own permanent
    # copy (NOT a URL - the bucket is private, so to_dict() below mints a
    # fresh short-lived presigned URL from the key on every read rather than
    # storing one that would itself go stale). Deliberately separate from
    # storage_url above (an unused catch-all populated straight from
    # whatever storageUrl key a captured payload happens to contain, not a
    # mirrored copy of anything). mirrored_asset_url/mirrored_thumbnail_url
    # (Text, unindexed) were the original 2026-08-05 columns, before
    # discovering the bucket is private and a static "public" URL doesn't
    # actually load - kept only so any already-written value isn't silently
    # dropped by the migration; to_dict() no longer reads them.
    mirrored_asset_url = Column(Text)
    mirrored_thumbnail_url = Column(Text)
    mirrored_asset_key = Column(Text)
    mirrored_thumbnail_key = Column(Text)
    asset_mirror_status = Column(String(20), nullable=False, default="pending", index=True)  # pending | mirrored | failed | skipped
    asset_mirror_attempted_at = Column(DateTime)
    asset_mirror_error = Column(Text)

    created_at = Column(DateTime, default=datetime.utcnow, nullable=False, index=True)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, nullable=False, index=True)

    def to_dict(self):
        # One R2 client shared by both presign calls below (asset + thumbnail)
        # instead of building a fresh one for each - client construction is
        # local/no network I/O, but no reason to pay it twice per row.
        r2_client = r2_storage.build_client() if (self.mirrored_asset_key or self.mirrored_thumbnail_key) and r2_storage.is_configured() else None
        return {
            "id": self.id,
            "provider": self.provider,
            "videoId": self.video_id,
            "renderId": self.render_id,
            "jobId": self.job_id,
            "workflowId": self.workflow_id,
            "requestId": self.request_id,
            "projectId": self.project_id,
            "sceneId": self.scene_id,
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
            "scriptText": self.script_text,
            "promptLength": self.prompt_length,
            "estimatedDurationSeconds": self.estimated_duration_seconds,
            "avatarId": self.avatar_id,
            "avatarName": self.avatar_name,
            "avatarVersion": self.avatar_version,
            "avatarType": self.avatar_type,
            "avatarPosition": self.avatar_position,
            "voiceId": self.voice_id,
            "voiceName": self.voice_name,
            "voiceLanguage": self.voice_language,
            "voiceGender": self.voice_gender,
            "voiceStyle": self.voice_style,
            "sceneCount": self.scene_count,
            "sceneIds": self.scene_ids_json or [],
            "layout": self.layout,
            "backgroundType": self.background_type,
            "resolution": self.resolution,
            "aspectRatio": self.aspect_ratio,
            "fps": self.fps,
            "durationSeconds": self.duration_seconds,
            "quality": self.quality,
            "motionEngine": self.motion_engine,
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
            "videoUrl": self.video_url,
            "thumbnailUrl": self.thumbnail_url,
            "downloadUrl": self.download_url,
            "previewUrl": self.preview_url,
            "shareUrl": self.share_url,
            "storageUrl": self.storage_url,
            "metadata": self.metadata_json or {},
            "sourceMetadata": self.source_metadata_json or {},
            "mirroredAssetUrl": _presigned_mirror_url(self.mirrored_asset_key, client=r2_client),
            "mirroredThumbnailUrl": _presigned_mirror_url(self.mirrored_thumbnail_key, client=r2_client),
            "assetMirrorStatus": self.asset_mirror_status,
            "assetMirrorAttemptedAt": serialize_utc_datetime(self.asset_mirror_attempted_at),
            "assetMirrorError": self.asset_mirror_error,
            "createdAt": serialize_utc_datetime(self.created_at),
            "updatedAt": serialize_utc_datetime(self.updated_at),
        }


class HeygenRecoveryAudit(Base):
    """Batch-import provenance for admin-triggered full reconciliation runs -
    mirrors FreepikRecoveryAudit exactly rather than reusing Kling's
    GenerationRecoveryAudit, which has Kling-flavored column names baked in."""
    __tablename__ = "heygen_recovery_audits"
    __table_args__ = (
        Index("ix_heygen_recovery_audits_admin_created_at", "requested_by_admin_id", "created_at"),
        Index("ix_heygen_recovery_audits_action_created_at", "action_type", "created_at"),
    )

    id = Column(Integer, primary_key=True, index=True)
    provider = Column(String(40), nullable=False, default="heygen", index=True)
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


class HeygenSyncCursor(Base):
    """Extension-driven reconciliation progress, one row per credential (the
    shared HeyGen account) - see providers/heygen/sync.py. The actual
    page-walk trigger is not wired up in this pass (no confirmed HeyGen
    history/listing endpoint shape yet - see sync.py docstring); this table
    exists so the bookkeeping is ready the moment that endpoint is confirmed,
    without a schema change."""
    __tablename__ = "heygen_sync_cursors"
    __table_args__ = (
        Index("ux_heygen_sync_cursors_credential", "credential_id", unique=True),
    )

    id = Column(Integer, primary_key=True, index=True)
    credential_id = Column(Integer, ForeignKey("it_portal_tool_credentials.id"), nullable=False, index=True)
    last_seen_video_id = Column(String(160))
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
            "lastSeenVideoId": self.last_seen_video_id,
            "lastSyncedPage": self.last_synced_page,
            "lastFullReconciliationAt": serialize_utc_datetime(self.last_full_reconciliation_at),
            "lastRunAt": serialize_utc_datetime(self.last_run_at),
            "lastRunByUserId": self.last_run_by_user_id,
            "status": self.status,
            "lastError": self.last_error,
            "createdAt": serialize_utc_datetime(self.created_at),
            "updatedAt": serialize_utc_datetime(self.updated_at),
        }


class HeygenCaptureHealth(Base):
    """Latest known health snapshot of one extension install's HeyGen
    capture (not an event log - one row per install, upserted on each health
    ping). Mirrors FreepikCaptureHealth exactly."""
    __tablename__ = "heygen_capture_health"
    __table_args__ = (
        Index(
            "ux_heygen_capture_health_session",
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
    provider = Column(String(40), nullable=False, default="heygen", index=True)
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
