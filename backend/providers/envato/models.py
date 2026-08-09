# providers/envato/models.py - Envato Generation Capture data model
"""
Three-layer design, mirroring providers/freepik/models.py exactly:

  EnvatoCaptureEvent (raw, append-only, lossless)
        -> normalization.py ->
  EnvatoGeneration (normalized, rich, one row per Envato `itemUuid`)
        -> normalization.py also projects a matching row into ->
  GenerationRecord (models_new.py, provider="envato") for cross-tool reporting

Identity is simpler than Freepik's four-field chain: Envato's
generation-history endpoint keys every item on a single `itemUuid` (a real
UUID), confirmed against a captured HAR - there is no separate
identifier/reference/transaction_id concept observed. EnvatoGeneration is NOT
a duplicate of GenerationRecord - see FreepikGeneration's own docstring for
why the two-table split exists; the same reasoning applies here.
metadata_json/source_metadata_json hold the raw decoded item verbatim, so
schema drift or an unconfirmed item type (see constants.py's ALL_ITEM_TYPES)
never loses data even before a column exists for it.
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


class EnvatoCaptureEvent(Base):
    """Raw, provider-agnostic capture signal reported by the extension,
    stored losslessly and opaquely (payload_json) before normalization into
    EnvatoGeneration. Deliberately thin - see providers/envato/capture.py.

    Idempotency is (provider, credential_id, client_event_id) - same
    reasoning as FreepikCaptureEvent's own docstring: scope uniqueness by the
    shared account (credential), never by the reporting portal user.
    """
    __tablename__ = "envato_capture_events"
    __table_args__ = (
        Index(
            "ux_envato_capture_events_credential_client_event_id",
            "provider", "credential_id", "client_event_id",
            unique=True,
        ),
        Index("ix_envato_capture_events_item_uuid", "provider_item_uuid"),
        Index("ix_envato_capture_events_tool_created_at", "tool_id", "created_at"),
        Index("ix_envato_capture_events_user_created_at", "user_id", "created_at"),
    )

    id = Column(Integer, primary_key=True, index=True)
    tool_id = Column(Integer, ForeignKey("it_portal_tools.id"), nullable=False, index=True)
    credential_id = Column(Integer, ForeignKey("it_portal_tool_credentials.id"), index=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False, index=True)
    provider = Column(String(40), nullable=False, default="envato", index=True)
    event_type = Column(String(40), nullable=False, index=True)
    client_event_id = Column(String(160), nullable=False)
    provider_item_uuid = Column(String(160), index=True)
    ownership_confidence = Column(String(20))  # "ticket" | "reconciliation" | "session" - set by capture.py
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
            "providerItemUuid": self.provider_item_uuid,
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


class EnvatoGeneration(Base):
    """One row per Envato `itemUuid` (ImageGen/ImageEdit/VideoGen/MusicGen/
    VoiceGen/SoundGen/GraphicsGen/MockupGen all share this one identity
    space - confirmed via generation-history.data).

    Ownership is capture-time-only, same posture as FreepikGeneration (see
    its own docstring): Envato's generation-history response never
    identifies which employee generated an item, only what's in the shared
    account's history. owner_user_id here is resolved exclusively from our
    own launch-ticket system at the moment of interception/correlation - a
    row imported purely from reconciliation, with no matching live ticket,
    stays ownership_status='unknown' by design.

    Credits are DOM-scraped best-effort (credits_badge, quota_remaining_*)
    since - unlike Freepik - Envato's API exposes no numeric per-item credit
    ledger anywhere (confirmed: searched the full captured HAR for "credit",
    found only i18n failure-message strings, never a ledger field).
    """
    __tablename__ = "envato_generations"
    __table_args__ = (
        CheckConstraint("item_uuid IS NOT NULL", name="ck_envato_generations_identity_present"),
        Index("ux_envato_generations_item_uuid", "provider", "item_uuid", unique=True),
        Index("ix_envato_generations_owner_created_at", "owner_user_id", "created_at"),
        Index("ix_envato_generations_owner_status_created_at", "owner_user_id", "ownership_status", "created_at"),
        Index("ix_envato_generations_credential_created_at", "credential_id", "created_at"),
        Index("ix_envato_generations_ingestion_created_at", "ingestion_source", "created_at"),
        Index("ix_envato_generations_generation_record_id", "generation_record_id"),
        # No explicit Index() for item_type/linked_task_id/linked_client_id
        # here - column-level index=True below already creates one apiece.
        # An explicit duplicate made Base.metadata.create_all fail with
        # "index already exists" (self-caught immediately via this smoke
        # test) - same lesson FreepikDownload's own comment documents.
    )

    id = Column(Integer, primary_key=True, index=True)
    provider = Column(String(40), nullable=False, default="envato", index=True)

    # ---- Identity ----
    item_uuid = Column(String(160), index=True)
    item_type = Column(String(40), index=True)  # genai-image | genai-video | genai-vector | genai-voice | genai-music | genai-sound

    # ---- Ownership / capture provenance ----
    source_capture_event_id = Column(Integer, ForeignKey("envato_capture_events.id", ondelete="SET NULL"))
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
    generation_method = Column(String(40), nullable=False, default="network_intercept")  # network_intercept | history_scan
    ingestion_source = Column(String(40), nullable=False, default="captured", index=True)  # captured | recovered
    recovery_audit_id = Column(Integer, ForeignKey("envato_recovery_audits.id", ondelete="SET NULL"), index=True)
    recovered_by_admin_id = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"))
    recovered_at = Column(DateTime)

    # ---- Prompt ----
    prompt = Column(Text)
    prompt_length = Column(Integer)
    prompt_hash = Column(String(64), index=True)
    title = Column(Text)  # populated for item types that carry a title instead of/alongside a prompt (e.g. music tracks)

    # ---- Tool / model ----
    aspect_ratio = Column(String(20))
    style = Column(String(120))
    shortcut_slug = Column(String(120), index=True)  # the ImageGen "Shortcuts" preset used, if any

    # ---- Status / flags ----
    is_in_workspace = Column(Boolean)
    is_downloaded = Column(Boolean)
    review_status = Column(String(40))
    provider_created_at = Column(DateTime)

    # ---- Credits (DOM-scraped best-effort - see this model's own docstring) ----
    credits_badge = Column(Float)  # the "+N" cost shown on the Generate button at click time
    quota_remaining_before = Column(Integer)  # sidebar "N Generations remaining" just before the click
    quota_remaining_after = Column(Integer)   # same counter just after - the delta is the real charge

    # ---- Assets ----
    canvas_url = Column(Text)
    fallback_url = Column(Text)
    thumbnail_url = Column(Text)
    src_set_json = Column(JSON)

    # ---- Metadata catch-all (nothing discarded) ----
    metadata_json = Column(JSON)
    source_metadata_json = Column(JSON)

    created_at = Column(DateTime, default=datetime.utcnow, nullable=False, index=True)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, nullable=False, index=True)

    def to_dict(self):
        return {
            "id": self.id,
            "provider": self.provider,
            "itemUuid": self.item_uuid,
            "itemType": self.item_type,
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
            "prompt": self.prompt,
            "promptLength": self.prompt_length,
            "promptHash": self.prompt_hash,
            "title": self.title,
            "aspectRatio": self.aspect_ratio,
            "style": self.style,
            "shortcutSlug": self.shortcut_slug,
            "isInWorkspace": self.is_in_workspace,
            "isDownloaded": self.is_downloaded,
            "reviewStatus": self.review_status,
            "providerCreatedAt": serialize_utc_datetime(self.provider_created_at),
            "creditsBadge": self.credits_badge,
            "quotaRemainingBefore": self.quota_remaining_before,
            "quotaRemainingAfter": self.quota_remaining_after,
            "canvasUrl": self.canvas_url,
            "fallbackUrl": self.fallback_url,
            "thumbnailUrl": self.thumbnail_url,
            "srcSet": self.src_set_json or [],
            "metadata": self.metadata_json or {},
            "sourceMetadata": self.source_metadata_json or {},
            "createdAt": serialize_utc_datetime(self.created_at),
            "updatedAt": serialize_utc_datetime(self.updated_at),
        }


class EnvatoRecoveryAudit(Base):
    """Batch-import provenance for admin-triggered full reconciliation runs -
    mirrors FreepikRecoveryAudit exactly."""
    __tablename__ = "envato_recovery_audits"
    __table_args__ = (
        Index("ix_envato_recovery_audits_admin_created_at", "requested_by_admin_id", "created_at"),
        Index("ix_envato_recovery_audits_action_created_at", "action_type", "created_at"),
    )

    id = Column(Integer, primary_key=True, index=True)
    provider = Column(String(40), nullable=False, default="envato", index=True)
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


class EnvatoDownload(Base):
    """One row per download of an EXISTING (not user-generated) stock asset -
    photos, videos, templates, music, fonts from Envato's stock library - a
    materially different action from app.envato.com's AI generation tools.
    Captured from two surfaces: app.envato.com's own `/search/*` browse flow
    (confirmed via a captured Network panel trace, 2026-08-08 - the real
    download request is `GET /download.data?itemUuid=...&itemType=...`,
    which is where item_uuid/item_type below come from) and, best-effort,
    elements.envato.com's own separate download flow (no confirmed network
    signal there yet, so item_uuid/item_type stay null for anything captured
    on that host). Mirrors FreepikDownload's docstring and design exactly,
    including Sarbjeet's own call there: a download IS gated behind the same
    mandatory Task/Client picker Generate uses ("what he download for what
    project" is the whole point of capturing this), unlike a free-form
    search (not built for Envato in this pass - only download was asked
    for).

    asset_title/asset_thumbnail_url are still best-effort DOM scrapes (no
    confirmed DOM sample of either host's actual item card) - only the
    item_uuid/item_type identity fields have real network confirmation so
    far. Tighten the rest once more real interaction is observed."""
    __tablename__ = "envato_downloads"
    __table_args__ = (
        Index("ix_envato_downloads_owner_created_at", "owner_user_id", "created_at"),
        Index("ix_envato_downloads_credential_created_at", "credential_id", "created_at"),
    )

    id = Column(Integer, primary_key=True, index=True)
    provider = Column(String(40), nullable=False, default="envato", index=True)
    source_capture_event_id = Column(Integer, ForeignKey("envato_capture_events.id", ondelete="SET NULL"))
    tool_id = Column(Integer, ForeignKey("it_portal_tools.id"), index=True)
    credential_id = Column(Integer, ForeignKey("it_portal_tool_credentials.id"), index=True)
    owner_user_id = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), index=True)
    ownership_status = Column(String(40), nullable=False, default="unknown", index=True)

    linked_task_id = Column(Integer, ForeignKey("tasks.id", ondelete="SET NULL"), index=True)
    linked_task_name = Column(String(255))
    linked_client_id = Column(Integer, ForeignKey("generation_clients.id", ondelete="SET NULL"), index=True)
    linked_client_name = Column(String(255))

    # Added once a real download request was observed (app.envato.com's
    # search/browse flow calls `GET /download.data?itemUuid=...&itemType=...`
    # - confirmed via a captured Network panel trace, 2026-08-08) - a
    # materially more reliable identity signal than the DOM-scraped fields
    # below, which predate that observation. Nullable: elements.envato.com's
    # own download flow (if it still exists/is used) has never produced this
    # signal, so a download captured there stays identity-less exactly as
    # originally designed.
    item_uuid = Column(String(160), index=True)
    item_type = Column(String(40), index=True)

    asset_title = Column(Text)
    asset_thumbnail_url = Column(Text)
    asset_source_url = Column(Text)
    search_term = Column(Text)
    source_host = Column(String(80), index=True)
    page_url = Column(Text)

    downloaded_at = Column(DateTime)
    metadata_json = Column(JSON)

    created_at = Column(DateTime, default=datetime.utcnow, nullable=False, index=True)

    def to_dict(self):
        return {
            "id": self.id,
            "provider": self.provider,
            "sourceCaptureEventId": self.source_capture_event_id,
            "toolId": self.tool_id,
            "credentialId": self.credential_id,
            "ownerUserId": self.owner_user_id,
            "ownershipStatus": self.ownership_status,
            "linkedTaskId": self.linked_task_id,
            "linkedTaskName": self.linked_task_name,
            "linkedClientId": self.linked_client_id,
            "linkedClientName": self.linked_client_name,
            "itemUuid": self.item_uuid,
            "itemType": self.item_type,
            "assetTitle": self.asset_title,
            "assetThumbnailUrl": self.asset_thumbnail_url,
            "assetSourceUrl": self.asset_source_url,
            "searchTerm": self.search_term,
            "sourceHost": self.source_host,
            "pageUrl": self.page_url,
            "downloadedAt": serialize_utc_datetime(self.downloaded_at),
            "metadata": self.metadata_json or {},
            "createdAt": serialize_utc_datetime(self.created_at),
        }


class EnvatoSyncCursor(Base):
    """Extension-driven reconciliation progress, one row per credential (the
    shared Envato account) - see providers/envato/sync.py. Mirrors
    FreepikSyncCursor exactly."""
    __tablename__ = "envato_sync_cursors"
    __table_args__ = (
        Index("ux_envato_sync_cursors_credential", "credential_id", unique=True),
    )

    id = Column(Integer, primary_key=True, index=True)
    credential_id = Column(Integer, ForeignKey("it_portal_tool_credentials.id"), nullable=False, index=True)
    last_seen_item_uuid = Column(String(160))
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
            "lastSeenItemUuid": self.last_seen_item_uuid,
            "lastSyncedPage": self.last_synced_page,
            "lastFullReconciliationAt": serialize_utc_datetime(self.last_full_reconciliation_at),
            "lastRunAt": serialize_utc_datetime(self.last_run_at),
            "lastRunByUserId": self.last_run_by_user_id,
            "status": self.status,
            "lastError": self.last_error,
            "createdAt": serialize_utc_datetime(self.created_at),
            "updatedAt": serialize_utc_datetime(self.updated_at),
        }


class EnvatoCaptureHealth(Base):
    """Latest known health snapshot of one extension install's Envato
    capture (not an event log). Mirrors FreepikCaptureHealth exactly."""
    __tablename__ = "envato_capture_health"
    __table_args__ = (
        Index(
            "ux_envato_capture_health_session",
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
    provider = Column(String(40), nullable=False, default="envato", index=True)
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
