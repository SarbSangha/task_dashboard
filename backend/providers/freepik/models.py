# providers/freepik/models.py - Freepik/Magnific Generation Capture data model
"""
Three-layer design, mirroring the ChatGPT provider package (see its README)
combined with Kling's proven GenerationRecord projection:

  FreepikCaptureEvent (raw, append-only, lossless)
        -> normalization.py ->
  FreepikGeneration (normalized, rich, one row per Freepik `creation.id`)
        -> normalization.py also projects a matching row into ->
  GenerationRecord (models_new.py, provider="freepik") for cross-tool reporting

FreepikGeneration is NOT a duplicate of GenerationRecord: GenerationRecord is
the lowest-common-denominator table every provider's generations already
surface through (browse/search/claim UI in generation_records_router.py,
project/tag/collection organization) with a handful of generic columns.
FreepikGeneration is the rich, Freepik-specific record - every field in the
Freepik API response that's worth keeping for analytics (Phase 7) but has no
home on the generic table. Nothing is discarded: metadata_json/
source_metadata_json hold the raw `creation.metadata` / `.source_metadata`
blobs verbatim, so schema drift in Freepik's undocumented API never loses data
even before a column is added for it.
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
    serialization time (see FreepikGeneration.mirrored_asset_key's own
    comment for why this can't just be a stored column value - the bucket is
    private). Swallows any failure (R2 not configured, a transient signing
    error) rather than let one broken asset take down an entire API
    response - the field just comes back null, same as never having been
    mirrored yet."""
    if not key:
        return None
    try:
        if not r2_storage.is_configured():
            return None
        return r2_storage.generate_presigned_url(key, client=client)
    except Exception:
        return None


class FreepikCaptureEvent(Base):
    """Raw, provider-agnostic capture signal reported by the extension, stored
    losslessly and opaquely (payload_json) before normalization into
    FreepikGeneration. Deliberately thin: no parsing, no business logic - see
    providers/freepik/capture.py.

    Idempotency is (provider, credential_id, client_event_id) - the same
    lesson Kling's dedupe cascade and ChatGPT's ConversationCaptureEvent both
    encode: scope uniqueness by the real shared account (credential), never
    by the reporting portal user, since an admin re-scanning history under
    their own login must not spawn a duplicate row.
    """
    __tablename__ = "freepik_capture_events"
    __table_args__ = (
        Index(
            "ux_freepik_capture_events_credential_client_event_id",
            "provider", "credential_id", "client_event_id",
            unique=True,
        ),
        Index("ix_freepik_capture_events_creation_id", "provider_creation_id"),
        Index("ix_freepik_capture_events_family_id", "provider_family_id"),
        Index("ix_freepik_capture_events_tool_created_at", "tool_id", "created_at"),
        Index("ix_freepik_capture_events_user_created_at", "user_id", "created_at"),
    )

    id = Column(Integer, primary_key=True, index=True)
    tool_id = Column(Integer, ForeignKey("it_portal_tools.id"), nullable=False, index=True)
    credential_id = Column(Integer, ForeignKey("it_portal_tool_credentials.id"), index=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False, index=True)
    provider = Column(String(40), nullable=False, default="freepik", index=True)
    event_type = Column(String(40), nullable=False, index=True)
    client_event_id = Column(String(160), nullable=False)
    provider_creation_id = Column(String(160), index=True)
    provider_family_id = Column(String(160), index=True)
    ownership_confidence = Column(String(20))  # "ticket" | "reconciliation" - set by capture.py, not the extension
    # Task Mapping: the internal Task (tasks.id) the extension's gate had the
    # user select before this generation - re-validated server-side in
    # ingest_capture_event (never trusted from the client as-is). Named
    # linked_* rather than task_* to avoid any confusion with
    # FreepikGeneration.task_id, which is Freepik's own unrelated field.
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
            "providerCreationId": self.provider_creation_id,
            "providerFamilyId": self.provider_family_id,
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


class FreepikGeneration(Base):
    """One row per Freepik `creation.id` (i.e. per generated image/variant -
    a single prompt submission on an "auto" multi-model run can produce up to
    4 sibling rows sharing family_id). See CAPTURE_CONTRACT.md for the full
    field-by-field mapping from the raw Freepik response.

    Ownership is capture-time-only: Freepik's own response never identifies
    the employee (owner.user_id/email is the shared account holder, constant
    across every generation; creation.user_id is a constant internal service
    id). owner_user_id here is resolved exclusively from our own launch-ticket
    system at the moment of interception - a row imported later purely from
    history-page reconciliation, with no matching live ticket, is structurally
    unattributable and stays ownership_status='unknown' by design (same as
    Kling's recovery-import behavior), not a bug to chase.
    """
    __tablename__ = "freepik_generations"
    __table_args__ = (
        CheckConstraint(
            "creation_id IS NOT NULL OR identifier IS NOT NULL OR reference IS NOT NULL",
            name="ck_freepik_generations_identity_present",
        ),
        Index(
            "ux_freepik_generations_creation_id",
            "provider", "creation_id",
            unique=True,
            postgresql_where=text("creation_id IS NOT NULL"),
            sqlite_where=text("creation_id IS NOT NULL"),
        ),
        Index(
            "ux_freepik_generations_identifier",
            "provider", "identifier",
            unique=True,
            postgresql_where=text("identifier IS NOT NULL"),
            sqlite_where=text("identifier IS NOT NULL"),
        ),
        Index(
            "ux_freepik_generations_reference",
            "provider", "reference",
            unique=True,
            postgresql_where=text("reference IS NOT NULL"),
            sqlite_where=text("reference IS NOT NULL"),
        ),
        Index(
            "ux_freepik_generations_transaction_id",
            "provider", "transaction_id",
            unique=True,
            postgresql_where=text("transaction_id IS NOT NULL"),
            sqlite_where=text("transaction_id IS NOT NULL"),
        ),
        Index("ix_freepik_generations_family_index", "family_id", "variant_index"),
        Index("ix_freepik_generations_owner_created_at", "owner_user_id", "created_at"),
        Index("ix_freepik_generations_owner_status_created_at", "owner_user_id", "ownership_status", "created_at"),
        Index("ix_freepik_generations_credential_created_at", "credential_id", "created_at"),
        Index("ix_freepik_generations_ingestion_created_at", "ingestion_source", "created_at"),
        Index("ix_freepik_generations_generation_record_id", "generation_record_id"),
    )

    id = Column(Integer, primary_key=True, index=True)
    provider = Column(String(40), nullable=False, default="freepik", index=True)

    # ---- Identity ----
    creation_id = Column(String(160), index=True)
    identifier = Column(String(160), index=True)
    reference = Column(String(160), index=True)
    family_id = Column(String(160), index=True)
    variant_index = Column(Integer)
    external_id = Column(String(160), index=True)
    request_id = Column(String(160), index=True)
    task_id = Column(String(160), index=True)
    iqs_task_id = Column(String(160), index=True)
    transaction_id = Column(String(160), index=True)
    project_folder_reference = Column(String(160), index=True)
    folder_reference = Column(String(160), index=True)

    # ---- Ownership / capture provenance ----
    source_capture_event_id = Column(Integer, ForeignKey("freepik_capture_events.id", ondelete="SET NULL"))
    generation_record_id = Column(Integer, ForeignKey("generation_records.id", ondelete="SET NULL"))
    tool_id = Column(Integer, ForeignKey("it_portal_tools.id"), index=True)
    credential_id = Column(Integer, ForeignKey("it_portal_tool_credentials.id"), index=True)
    owner_user_id = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), index=True)
    ownership_status = Column(String(40), nullable=False, default="unknown", index=True)
    ownership_source = Column(String(80))
    ownership_notes = Column(Text)
    assigned_by_admin_id = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"))
    assigned_at = Column(DateTime)
    # Task Mapping - carried in from FreepikCaptureEvent.linked_task_id/name,
    # then projected onto GenerationRecord below (see normalization.py).
    linked_task_id = Column(Integer, ForeignKey("tasks.id", ondelete="SET NULL"), index=True)
    linked_task_name = Column(String(255))
    linked_client_id = Column(Integer, ForeignKey("generation_clients.id", ondelete="SET NULL"), index=True)
    linked_client_name = Column(String(255))
    generation_source = Column(String(40), nullable=False, default="live_capture", index=True)  # live_capture | reconciliation
    generation_method = Column(String(40), nullable=False, default="network_intercept")  # network_intercept | history_scan
    ingestion_source = Column(String(40), nullable=False, default="captured", index=True)  # captured | recovered
    recovery_audit_id = Column(Integer, ForeignKey("freepik_recovery_audits.id", ondelete="SET NULL"), index=True)
    recovered_by_admin_id = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"))
    recovered_at = Column(DateTime)

    # ---- Prompt ----
    name_field = Column(Text)  # raw top-level `name` - often the prompt, sometimes a follow-up instruction; kept verbatim
    prompt = Column(Text)
    input_prompt = Column(Text)
    variation_prompt = Column(Text)
    smart_prompt = Column(Boolean)
    prompt_length = Column(Integer)
    prompt_hash = Column(String(64), index=True)
    prompt_type = Column(String(40))

    # ---- Model / tool ----
    tool = Column(String(80), index=True)
    tool_name = Column(String(80), index=True)
    mode = Column(String(80), index=True)
    slug = Column(String(80), index=True)
    service = Column(String(120), index=True)
    aspect_ratio = Column(String(20))
    resolution = Column(String(20))
    width = Column(Integer)
    height = Column(Integer)
    output_width = Column(Integer)
    output_height = Column(Integer)
    seed = Column(String(40))
    tags_json = Column(JSON)
    modifiers_json = Column(JSON)
    image_references_json = Column(JSON)  # raw {label: {image: "creation:XXXX", category}} map

    # ---- Status ----
    status = Column(String(40), index=True)
    persisted = Column(Boolean)
    visible = Column(Boolean)
    is_watermarked = Column(Boolean)
    nsfw = Column(Boolean)
    is_public = Column(Boolean)
    stored = Column(Boolean)
    shared = Column(Boolean)
    is_last = Column(Boolean)
    provider_created_at = Column(DateTime)
    provider_updated_at = Column(DateTime)
    elapsed_time_ms = Column(Integer)
    expect_time_s = Column(Integer)
    queue_priority = Column(Integer)

    # ---- Credits (kept as 3 distinct numbers - see CAPTURE_CONTRACT.md) ----
    credits_charged = Column(Float)
    credits_estimated = Column(Float)
    unlimited_credits = Column(Float)
    credit_ledger_json = Column(JSON)

    # ---- Assets ----
    preview_url = Column(Text)
    thumbnail_url = Column(Text)
    large_preview_url = Column(Text)
    raw_url = Column(Text)
    download_url = Column(Text)
    web_url = Column(Text)
    blurhash = Column(String(80))
    ratio = Column(Float)
    file_size = Column(Integer)
    file_type_id = Column(Integer)
    origin = Column(String(40))

    # ---- Folder ----
    folder_id = Column(Integer)
    folder_name = Column(String(255))

    # ---- Metadata catch-all (nothing discarded) ----
    metadata_json = Column(JSON)
    source_metadata_json = Column(JSON)

    # ---- Asset mirroring (see providers/freepik/asset_mirror.py) ----
    # Freepik/Pikaso's own CDN URLs (preview_url/raw_url/download_url/etc
    # above) are signed with a short-lived expiry token - once it lapses the
    # original 404s permanently, even for a generation that captured fine.
    # These hold the R2 object KEY of our own permanent copy (NOT a URL -
    # the bucket is private, so to_dict() below mints a fresh short-lived
    # presigned URL from the key on every read rather than storing one that
    # would itself go stale); the raw_url/download_url/etc columns above are
    # left untouched as the historical record of what Freepik originally
    # returned. mirrored_asset_url/mirrored_thumbnail_url (Text, unindexed)
    # were the original 2026-08-05 columns, before discovering the bucket is
    # private and a static "public" URL doesn't actually load - kept only so
    # any already-written value isn't silently dropped by the migration;
    # to_dict() no longer reads them.
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
            "creationId": self.creation_id,
            "identifier": self.identifier,
            "reference": self.reference,
            "familyId": self.family_id,
            "variantIndex": self.variant_index,
            "externalId": self.external_id,
            "requestId": self.request_id,
            "taskId": self.task_id,
            "iqsTaskId": self.iqs_task_id,
            "transactionId": self.transaction_id,
            "projectFolderReference": self.project_folder_reference,
            "folderReference": self.folder_reference,
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
            "nameField": self.name_field,
            "prompt": self.prompt,
            "inputPrompt": self.input_prompt,
            "variationPrompt": self.variation_prompt,
            "smartPrompt": self.smart_prompt,
            "promptLength": self.prompt_length,
            "promptHash": self.prompt_hash,
            "promptType": self.prompt_type,
            "tool": self.tool,
            "toolName": self.tool_name,
            "mode": self.mode,
            "slug": self.slug,
            "service": self.service,
            "aspectRatio": self.aspect_ratio,
            "resolution": self.resolution,
            "width": self.width,
            "height": self.height,
            "outputWidth": self.output_width,
            "outputHeight": self.output_height,
            "seed": self.seed,
            "tags": self.tags_json or [],
            "modifiers": self.modifiers_json or [],
            "imageReferences": self.image_references_json or {},
            "status": self.status,
            "persisted": self.persisted,
            "visible": self.visible,
            "isWatermarked": self.is_watermarked,
            "nsfw": self.nsfw,
            "isPublic": self.is_public,
            "stored": self.stored,
            "shared": self.shared,
            "isLast": self.is_last,
            "providerCreatedAt": serialize_utc_datetime(self.provider_created_at),
            "providerUpdatedAt": serialize_utc_datetime(self.provider_updated_at),
            "elapsedTimeMs": self.elapsed_time_ms,
            "expectTimeS": self.expect_time_s,
            "queuePriority": self.queue_priority,
            "creditsCharged": self.credits_charged,
            "creditsEstimated": self.credits_estimated,
            "unlimitedCredits": self.unlimited_credits,
            "creditLedger": self.credit_ledger_json or [],
            "previewUrl": self.preview_url,
            "thumbnailUrl": self.thumbnail_url,
            "largePreviewUrl": self.large_preview_url,
            "rawUrl": self.raw_url,
            "downloadUrl": self.download_url,
            "webUrl": self.web_url,
            "blurhash": self.blurhash,
            "ratio": self.ratio,
            "fileSize": self.file_size,
            "fileTypeId": self.file_type_id,
            "origin": self.origin,
            "folderId": self.folder_id,
            "folderName": self.folder_name,
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


class FreepikSearchQuery(Base):
    """One row per stock-library search on freepik.com or magnific.com -
    added 2026-08-06 alongside FreepikDownload below, since neither a search
    nor a download of an EXISTING (not user-generated) stock asset has a
    `creation.id` FreepikGeneration can key on - these are a structurally
    different action, not a thinner version of a generation.

    Deliberately NOT gated behind the Task/Client picker the way Generate/
    Download clicks are (Sarbjeet's own call: search is free-form browsing,
    only the eventual download of something found needs project
    attribution) - linked_task_id/linked_client_id are always null here.
    owner_user_id is still capture-time-only ownership (same posture as
    FreepikGeneration - see its own docstring), best-effort since a search
    can happen outside any active launch ticket.

    Built from a single UI screenshot (magnific.com's stock search results
    page, `?term=...` in the URL), not confirmed DOM/network structure for
    either host - every field below is best-effort DOM/URL scraping in
    content-freepik.js, tighten once real interaction across both hosts is
    observed, same posture every other provider's Phase 1 shipped with."""
    __tablename__ = "freepik_search_queries"
    __table_args__ = (
        Index("ix_freepik_search_queries_owner_created_at", "owner_user_id", "created_at"),
        Index("ix_freepik_search_queries_credential_created_at", "credential_id", "created_at"),
        Index("ix_freepik_search_queries_term", "search_term"),
    )

    id = Column(Integer, primary_key=True, index=True)
    provider = Column(String(40), nullable=False, default="freepik", index=True)
    source_capture_event_id = Column(Integer, ForeignKey("freepik_capture_events.id", ondelete="SET NULL"))
    tool_id = Column(Integer, ForeignKey("it_portal_tools.id"), index=True)
    credential_id = Column(Integer, ForeignKey("it_portal_tool_credentials.id"), index=True)
    owner_user_id = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), index=True)
    ownership_status = Column(String(40), nullable=False, default="unknown", index=True)

    search_term = Column(Text)
    # "freepik.com" | "magnific.com" - which surface the search happened on,
    # since both share this one capture pipeline (see constants.py's
    # TOOL_SLUGS comment).
    source_host = Column(String(80), index=True)
    page_url = Column(Text)
    result_count_label = Column(String(40))  # raw as displayed, e.g. "28.7k results" - not parsed to an int, Freepik's own abbreviation format is unconfirmed
    filters_json = Column(JSON)  # whatever filter chips were visible (License/AI-generated/Orientation/...) - best-effort, unconfirmed shape

    searched_at = Column(DateTime)
    metadata_json = Column(JSON)  # catch-all raw payload, nothing discarded - same posture as FreepikGeneration's own metadata_json

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
            "searchTerm": self.search_term,
            "sourceHost": self.source_host,
            "pageUrl": self.page_url,
            "resultCountLabel": self.result_count_label,
            "filters": self.filters_json or {},
            "searchedAt": serialize_utc_datetime(self.searched_at),
            "metadata": self.metadata_json or {},
            "createdAt": serialize_utc_datetime(self.created_at),
        }


class FreepikDownload(Base):
    """One row per download of an EXISTING (not user-generated) stock asset
    on freepik.com or magnific.com - see FreepikSearchQuery's own docstring
    for why this is a separate table from FreepikGeneration. Unlike search,
    a download click IS gated behind the same mandatory Task/Client picker
    Generate uses (Sarbjeet's own call - "what he download for what
    project" is the whole point of capturing this at all), so
    linked_task_id/linked_client_id are populated the same way
    FreepikCaptureEvent's own columns are for a generation_submitted event.

    Built from a single UI screenshot (a hover-card Download icon button on
    a magnific.com stock search result), not confirmed DOM structure -
    asset_title/asset_thumbnail_url/asset_source_url are best-effort scrapes
    of whatever's visible near the clicked button, tighten once real click
    behavior on both hosts is observed."""
    __tablename__ = "freepik_downloads"
    __table_args__ = (
        Index("ix_freepik_downloads_owner_created_at", "owner_user_id", "created_at"),
        Index("ix_freepik_downloads_credential_created_at", "credential_id", "created_at"),
        # No explicit single-column Index() for linked_task_id/linked_client_id
        # here - column-level index=True below already creates one apiece.
        # An explicit duplicate entry made Base.metadata.create_all fail with
        # "index already exists" (self-caught immediately via the smoke
        # test) - same lesson this codebase already learned once for a
        # different provider's table.
    )

    id = Column(Integer, primary_key=True, index=True)
    provider = Column(String(40), nullable=False, default="freepik", index=True)
    source_capture_event_id = Column(Integer, ForeignKey("freepik_capture_events.id", ondelete="SET NULL"))
    tool_id = Column(Integer, ForeignKey("it_portal_tools.id"), index=True)
    credential_id = Column(Integer, ForeignKey("it_portal_tool_credentials.id"), index=True)
    owner_user_id = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), index=True)
    ownership_status = Column(String(40), nullable=False, default="unknown", index=True)

    # Task/Client Mapping - carried in from FreepikCaptureEvent.linked_task_id/
    # name at capture time, same as FreepikGeneration's own columns of the
    # same name (see capture.py's re-validation of both before trusting them).
    linked_task_id = Column(Integer, ForeignKey("tasks.id", ondelete="SET NULL"), index=True)
    linked_task_name = Column(String(255))
    linked_client_id = Column(Integer, ForeignKey("generation_clients.id", ondelete="SET NULL"), index=True)
    linked_client_name = Column(String(255))

    asset_title = Column(Text)
    asset_thumbnail_url = Column(Text)
    asset_source_url = Column(Text)
    # The search term active on the page at the moment of download, if any -
    # best-effort correlation (same page/tab, read from the URL at click
    # time), not a guaranteed causal link to which search actually surfaced
    # this specific asset.
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


class FreepikRecoveryAudit(Base):
    """Batch-import provenance for admin-triggered full reconciliation runs
    (walking every page of the "my creations" listing, ignoring the
    incremental sync cursor) - mirrors ConversationRecoveryAudit exactly
    rather than reusing Kling's GenerationRecoveryAudit, which has
    Kling-flavored column names (kling_count) baked in."""
    __tablename__ = "freepik_recovery_audits"
    __table_args__ = (
        Index("ix_freepik_recovery_audits_admin_created_at", "requested_by_admin_id", "created_at"),
        Index("ix_freepik_recovery_audits_action_created_at", "action_type", "created_at"),
    )

    id = Column(Integer, primary_key=True, index=True)
    provider = Column(String(40), nullable=False, default="freepik", index=True)
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


class FreepikSyncCursor(Base):
    """Extension-driven reconciliation progress, one row per credential (the
    shared Freepik account) - see providers/freepik/sync.py. Lets a page-walk
    resume correctly across tab closes/reopens/extension reloads instead of
    restarting from page 1 every time."""
    __tablename__ = "freepik_sync_cursors"
    __table_args__ = (
        Index("ux_freepik_sync_cursors_credential", "credential_id", unique=True),
    )

    id = Column(Integer, primary_key=True, index=True)
    credential_id = Column(Integer, ForeignKey("it_portal_tool_credentials.id"), nullable=False, index=True)
    last_seen_creation_id = Column(String(160))
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
            "lastSeenCreationId": self.last_seen_creation_id,
            "lastSyncedPage": self.last_synced_page,
            "lastFullReconciliationAt": serialize_utc_datetime(self.last_full_reconciliation_at),
            "lastRunAt": serialize_utc_datetime(self.last_run_at),
            "lastRunByUserId": self.last_run_by_user_id,
            "status": self.status,
            "lastError": self.last_error,
            "createdAt": serialize_utc_datetime(self.created_at),
            "updatedAt": serialize_utc_datetime(self.updated_at),
        }


class FreepikCaptureHealth(Base):
    """Latest known health snapshot of one extension install's Freepik
    capture (not an event log - one row per install, upserted on each health
    ping). Mirrors ConversationCaptureHealth; see providers/chatgpt/models.py
    for the reasoning behind last_capture_event_at vs last_successful_upload_at
    being tracked as two independent fields."""
    __tablename__ = "freepik_capture_health"
    __table_args__ = (
        Index(
            "ux_freepik_capture_health_session",
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
    provider = Column(String(40), nullable=False, default="freepik", index=True)
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
