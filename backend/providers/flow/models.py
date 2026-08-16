# providers/flow/models.py - Flow (labs.google/fx/tools/flow) Generation Capture data model
"""
Two-layer design for this first pass (mirrors providers/freepik/models.py's
three-layer design, minus FreepikSearchQuery/FreepikDownload/
FreepikRecoveryAudit/FreepikSyncCursor - Flow has no confirmed equivalent of
Freepik's stock-library search or existing-asset download, and no
reconciliation walker built yet - see CAPTURE_CONTRACT.md):

  FlowCaptureEvent (raw, append-only, lossless)
        -> normalization.py ->
  FlowGeneration (normalized, one row per Flow `flowWorkflows.name`)
        -> normalization.py also projects a matching row into ->
  GenerationRecord (models_new.py, provider="flow") for cross-tool reporting

Only the fields confirmed from a real captured flowWorkflows PATCH response
are modeled as their own columns; metadata_json holds the raw `metadata`
object verbatim so nothing is lost if the real shape carries more fields than
currently known (video generation's shape in particular is unconfirmed - see
CAPTURE_CONTRACT.md's known-gaps section).
"""
from datetime import datetime

from sqlalchemy import (
    CheckConstraint,
    Column,
    Date,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    JSON,
    String,
    Text,
)

from database_config import Base
from utils.datetime_utils import serialize_utc_datetime
from utils import r2_storage


def _presigned_mirror_url(key, *, client=None):
    """Mints a fresh short-lived R2 URL for a mirrored-asset key at
    serialization time - identical reasoning/implementation to
    providers/freepik/models.py's function of the same name (see its
    docstring: the bucket is private, so a permanently-stored URL would go
    stale). Swallows any failure (R2 not configured, a transient signing
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


class FlowCaptureEvent(Base):
    """Raw capture signal reported by the extension - mirrors
    providers/freepik/models.py::FreepikCaptureEvent's shape/columns/
    idempotency rule exactly (same (provider, credential_id, client_event_id)
    scope - see that class's docstring for the full reasoning). Deliberately
    thin: no parsing, no business logic - see providers/flow/capture.py.
    """
    __tablename__ = "flow_capture_events"
    __table_args__ = (
        Index(
            "ux_flow_capture_events_credential_client_event_id",
            "provider", "credential_id", "client_event_id",
            unique=True,
        ),
        Index("ix_flow_capture_events_creation_id", "provider_creation_id"),
        Index("ix_flow_capture_events_family_id", "provider_family_id"),
        Index("ix_flow_capture_events_tool_created_at", "tool_id", "created_at"),
        Index("ix_flow_capture_events_user_created_at", "user_id", "created_at"),
    )

    id = Column(Integer, primary_key=True, index=True)
    tool_id = Column(Integer, ForeignKey("it_portal_tools.id"), nullable=False, index=True)
    credential_id = Column(Integer, ForeignKey("it_portal_tool_credentials.id"), index=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False, index=True)
    provider = Column(String(40), nullable=False, default="flow", index=True)
    event_type = Column(String(40), nullable=False, index=True)
    client_event_id = Column(String(160), nullable=False)
    provider_creation_id = Column(String(160), index=True)
    provider_family_id = Column(String(160), index=True)
    ownership_confidence = Column(String(20))  # "ticket" | "session" | "reconciliation" - set by capture.py
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


class FlowGeneration(Base):
    """One row per Flow `flowWorkflows.name` (one generated image/video - a
    multi-image batch from one Generate click produces multiple sibling rows
    sharing batch_id). See CAPTURE_CONTRACT.md for the confirmed field
    mapping from the raw flowWorkflows response.

    Ownership is capture-time-only, same reasoning as FreepikGeneration: the
    flowWorkflows response never identifies which employee generated it (it's
    scoped to the shared Google account's OAuth token, not per-employee) -
    owner_user_id here is resolved exclusively from this codebase's own
    launch-ticket system at the moment of interception. A row imported later
    purely from reconciliation, with no matching live ticket, is structurally
    unattributable and stays ownership_status='unknown' by design.
    """
    __tablename__ = "flow_generations"
    __table_args__ = (
        CheckConstraint(
            "provider_creation_id IS NOT NULL",
            name="ck_flow_generations_identity_present",
        ),
        Index(
            "ux_flow_generations_creation_id",
            "provider", "provider_creation_id",
            unique=True,
        ),
        Index("ix_flow_generations_batch_id", "batch_id"),
        Index("ix_flow_generations_owner_created_at", "owner_user_id", "created_at"),
        Index("ix_flow_generations_owner_status_created_at", "owner_user_id", "ownership_status", "created_at"),
        Index("ix_flow_generations_credential_created_at", "credential_id", "created_at"),
        Index("ix_flow_generations_ingestion_created_at", "ingestion_source", "created_at"),
        Index("ix_flow_generations_generation_record_id", "generation_record_id"),
        Index("ix_flow_generations_asset_mirror_status", "asset_mirror_status"),
    )

    id = Column(Integer, primary_key=True, index=True)
    provider = Column(String(40), nullable=False, default="flow", index=True)

    # ---- Identity ----
    # `flowWorkflows.name` - the only confirmed identifier. Freepik's model
    # keys on a four-way creation_id/identifier/reference/transaction_id
    # chain because its API genuinely surfaces several different IDs
    # depending on endpoint; Flow has shown only one so far, so this
    # collapses to a single column rather than pre-building unused ones.
    provider_creation_id = Column(String(160), index=True)
    project_id = Column(String(160), index=True)
    # No index=True here - already covered by the explicit
    # Index("ix_flow_generations_batch_id", "batch_id") in __table_args__
    # above. Having both produced two indexes with the IDENTICAL
    # auto-generated name (SQLAlchemy's index=True naming convention is
    # ix_<tablename>_<colname>, which for this table+column is exactly
    # "ix_flow_generations_batch_id") - create_all() tried to create both in
    # the same transaction, the second collided with the first, and Postgres
    # rolled back the whole transaction (table included), which is why the
    # table appeared to not exist on every subsequent inspection despite the
    # error being fully reproducible.
    batch_id = Column(String(160))
    primary_media_id = Column(String(160), index=True)

    # ---- Ownership / capture provenance ----
    source_capture_event_id = Column(Integer, ForeignKey("flow_capture_events.id", ondelete="SET NULL"))
    generation_record_id = Column(Integer, ForeignKey("generation_records.id", ondelete="SET NULL"))
    tool_id = Column(Integer, ForeignKey("it_portal_tools.id"), index=True)
    credential_id = Column(Integer, ForeignKey("it_portal_tool_credentials.id"), index=True)
    owner_user_id = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), index=True)
    ownership_status = Column(String(40), nullable=False, default="unknown", index=True)
    ownership_source = Column(String(80))
    ownership_notes = Column(Text)
    assigned_by_admin_id = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"))
    assigned_at = Column(DateTime)
    # Task Mapping - carried in from FlowCaptureEvent.linked_task_id/name,
    # then projected onto GenerationRecord below (see normalization.py).
    linked_task_id = Column(Integer, ForeignKey("tasks.id", ondelete="SET NULL"), index=True)
    linked_task_name = Column(String(255))
    linked_client_id = Column(Integer, ForeignKey("generation_clients.id", ondelete="SET NULL"), index=True)
    linked_client_name = Column(String(255))
    generation_source = Column(String(40), nullable=False, default="live_capture", index=True)  # live_capture | reconciliation
    generation_method = Column(String(40), nullable=False, default="network_intercept")  # network_intercept | history_scan
    ingestion_source = Column(String(40), nullable=False, default="captured", index=True)  # captured | recovered

    # ---- Prompt ----
    prompt = Column(Text)  # metadata.displayName
    prompt_length = Column(Integer)
    prompt_hash = Column(String(64), index=True)

    # ---- Status (unconfirmed field, kept for parity - see constants.py) ----
    status = Column(String(40), index=True)
    provider_created_at = Column(DateTime)
    provider_updated_at = Column(DateTime)

    # ---- Assets ----
    # media_url/thumbnail_url start out null at capture time - the
    # flowWorkflows response only ever carries primary_media_id; the real URL
    # is patched in separately once content-flow-network.js observes the
    # page's own media.getMediaUrlRedirect?name={id} response (see
    # normalization.py's _normalize_media_url_event / constants.py's
    # EVENT_TYPE_MEDIA_URL_RESOLVED).
    media_url = Column(Text)
    thumbnail_url = Column(Text)

    # ---- Asset mirroring (see providers/flow/asset_mirror.py) ----
    # Confirmed live 2026-08-14: Flow's own media_url is a Google Cloud
    # signed URL (flow-content.google/image/...?Expires=...&Signature=...)
    # that 403s once its Expires token passes - a generation captured
    # perfectly correctly still goes permanently unviewable within a couple
    # of days unless mirrored, same class of bug Freepik/HeyGen's asset_mirror
    # already exists to fix, just not yet built for this provider. Same
    # shape/reasoning as providers/freepik/models.py's identical columns:
    # mirrored_asset_key/mirrored_thumbnail_key hold the R2 object KEY (never
    # a URL - the bucket is private, see utils/r2_storage.py), and to_dict()
    # mints a fresh short-lived presigned URL from them on every read.
    mirrored_asset_key = Column(Text)
    mirrored_thumbnail_key = Column(Text)
    asset_mirror_status = Column(String(20), nullable=False, default="pending")  # pending | mirrored | failed | skipped
    asset_mirror_attempted_at = Column(DateTime)
    asset_mirror_error = Column(Text)

    # ---- Metadata catch-all (nothing discarded) ----
    metadata_json = Column(JSON)

    created_at = Column(DateTime, default=datetime.utcnow, nullable=False, index=True)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, nullable=False, index=True)

    def to_dict(self):
        r2_client = (
            r2_storage.build_client()
            if (self.mirrored_asset_key or self.mirrored_thumbnail_key) and r2_storage.is_configured()
            else None
        )
        return {
            "id": self.id,
            "provider": self.provider,
            "creationId": self.provider_creation_id,
            "projectId": self.project_id,
            "batchId": self.batch_id,
            "primaryMediaId": self.primary_media_id,
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
            "prompt": self.prompt,
            "promptLength": self.prompt_length,
            "promptHash": self.prompt_hash,
            "status": self.status,
            "providerCreatedAt": serialize_utc_datetime(self.provider_created_at),
            "providerUpdatedAt": serialize_utc_datetime(self.provider_updated_at),
            "mediaUrl": self.media_url,
            "thumbnailUrl": self.thumbnail_url,
            "mirroredAssetUrl": _presigned_mirror_url(self.mirrored_asset_key, client=r2_client),
            "mirroredThumbnailUrl": _presigned_mirror_url(self.mirrored_thumbnail_key, client=r2_client),
            "assetMirrorStatus": self.asset_mirror_status,
            "assetMirrorAttemptedAt": serialize_utc_datetime(self.asset_mirror_attempted_at),
            "assetMirrorError": self.asset_mirror_error,
            "metadata": self.metadata_json or {},
            "createdAt": serialize_utc_datetime(self.created_at),
            "updatedAt": serialize_utc_datetime(self.updated_at),
        }
