# providers/suno/models.py - Suno (suno.com) Generation Capture data model
"""
Two-layer design, structurally copied from providers/elevenlabs/models.py:

  SunoCaptureEvent (raw, append-only, lossless)
        -> normalization.py ->
  SunoGeneration (normalized, one row per clip `id` - see normalization.py's
        _extract_fields; unlike ElevenLabs there is no flatten/dedup problem
        here, `id` is flat, top-level, and never changes across a clip's
        lifecycle, confirmed via live DevTools capture, 2026-08-17)
        -> normalization.py also projects a matching row into ->
  GenerationRecord (models_new.py, provider="suno") for cross-tool reporting

The confirmed real shape (`POST https://studio-api-prod.suno.com/api/feed/v3`
response, `clips[]`) is documented in full in CAPTURE_CONTRACT.md. Unlike
ElevenLabs (whose model file was written against an unconfirmed guess), every
column below maps to a field that has actually been observed on a real clip
object EXCEPT credits_used (kept nullable, always None - see constants.py's
module docstring and CAPTURE_CONTRACT.md's known-gaps section for why no
credits formula is implemented yet) and the terminal value of `status` (only
"streaming" has been observed - see constants.py's GENERATION_STATUS_*
comment).

Column set is ElevenlabsGeneration's minus source/voice_id/voice_name (Suno
only makes music - no TTS/Music/SFX multi-surface concept, no voice concept
at all), plus model_name/major_model_version as first-class columns (both
confirmed present on every clip, useful for filtering/reporting).
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
    providers/elevenlabs/models.py's function of the same name (see its
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


class SunoCaptureEvent(Base):
    """Raw capture signal reported by the extension - mirrors
    providers/elevenlabs/models.py::ElevenlabsCaptureEvent's shape/columns/
    idempotency rule exactly (same (provider, credential_id, client_event_id)
    scope - see that class's docstring for the full reasoning). Deliberately
    thin: no parsing, no business logic - see providers/suno/capture.py.
    """
    __tablename__ = "suno_capture_events"
    __table_args__ = (
        Index(
            "ux_suno_capture_events_credential_client_event_id",
            "provider", "credential_id", "client_event_id",
            unique=True,
        ),
        Index("ix_suno_capture_events_creation_id", "provider_creation_id"),
        Index("ix_suno_capture_events_family_id", "provider_family_id"),
        Index("ix_suno_capture_events_tool_created_at", "tool_id", "created_at"),
        Index("ix_suno_capture_events_user_created_at", "user_id", "created_at"),
    )

    id = Column(Integer, primary_key=True, index=True)
    tool_id = Column(Integer, ForeignKey("it_portal_tools.id"), nullable=False, index=True)
    credential_id = Column(Integer, ForeignKey("it_portal_tool_credentials.id"), index=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False, index=True)
    provider = Column(String(40), nullable=False, default="suno", index=True)
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


class SunoGeneration(Base):
    """One row per Suno clip (`id` in `POST /api/feed/v3`'s `clips[]`). See
    CAPTURE_CONTRACT.md for the confirmed field mapping this implements.

    Ownership is capture-time-only, same reasoning as ElevenlabsGeneration/
    FlowGeneration/FreepikGeneration: Suno's feed API never identifies which
    employee generated a clip (it's scoped to the shared account, not
    per-employee) - owner_user_id here is resolved exclusively from this
    codebase's own launch-ticket system at the moment of interception. A row
    imported later purely from reconciliation, with no matching live ticket,
    is structurally unattributable and stays ownership_status='unknown' by
    design.
    """
    __tablename__ = "suno_generations"
    __table_args__ = (
        CheckConstraint(
            "provider_creation_id IS NOT NULL",
            name="ck_suno_generations_identity_present",
        ),
        Index(
            "ux_suno_generations_creation_id",
            "provider", "provider_creation_id",
            unique=True,
        ),
        Index("ix_suno_generations_owner_created_at", "owner_user_id", "created_at"),
        Index("ix_suno_generations_owner_status_created_at", "owner_user_id", "ownership_status", "created_at"),
        Index("ix_suno_generations_credential_created_at", "credential_id", "created_at"),
        Index("ix_suno_generations_ingestion_created_at", "ingestion_source", "created_at"),
        Index("ix_suno_generations_generation_record_id", "generation_record_id"),
        Index("ix_suno_generations_asset_mirror_status", "asset_mirror_status"),
    )

    id = Column(Integer, primary_key=True, index=True)
    provider = Column(String(40), nullable=False, default="suno", index=True)

    # ---- Identity ----
    # Confirmed real field: clip.id - flat, top-level, never changes across
    # the clip's lifecycle (unlike ElevenLabs Music's chat/song split, there
    # is no flatten/dedup problem here - one row per `id`, always).
    provider_creation_id = Column(String(160), index=True)

    # ---- Ownership / capture provenance ----
    source_capture_event_id = Column(Integer, ForeignKey("suno_capture_events.id", ondelete="SET NULL"))
    generation_record_id = Column(Integer, ForeignKey("generation_records.id", ondelete="SET NULL"))
    tool_id = Column(Integer, ForeignKey("it_portal_tools.id"), index=True)
    credential_id = Column(Integer, ForeignKey("it_portal_tool_credentials.id"), index=True)
    owner_user_id = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), index=True)
    ownership_status = Column(String(40), nullable=False, default="unknown", index=True)
    ownership_source = Column(String(80))
    ownership_notes = Column(Text)
    assigned_by_admin_id = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"))
    assigned_at = Column(DateTime)
    # Task Mapping - carried in from SunoCaptureEvent.linked_task_id/name,
    # then projected onto GenerationRecord below (see normalization.py).
    linked_task_id = Column(Integer, ForeignKey("tasks.id", ondelete="SET NULL"), index=True)
    linked_task_name = Column(String(255))
    linked_client_id = Column(Integer, ForeignKey("generation_clients.id", ondelete="SET NULL"), index=True)
    linked_client_name = Column(String(255))
    generation_source = Column(String(40), nullable=False, default="live_capture", index=True)  # live_capture | reconciliation
    generation_method = Column(String(40), nullable=False, default="network_intercept")  # network_intercept | feed_scan
    ingestion_source = Column(String(40), nullable=False, default="captured", index=True)  # captured | recovered

    # ---- Suno-specific classification ----
    # Confirmed present on every clip - kept as first-class, indexed columns
    # (not just buried in metadata_json) since they're useful for
    # filtering/reporting, unlike ElevenLabs there is no `source` column at
    # all (Suno only makes music) and no voice_id/voice_name (not applicable).
    model_name = Column(String(80), index=True)  # e.g. "chirp-fenix"
    major_model_version = Column(String(20))  # e.g. "v5.5"

    # ---- Prompt / text input ----
    # metadata.gpt_description_prompt - the literal text the user typed (
    # confirmed: matches a real screenshot's "Song Description" textarea
    # verbatim). Deliberately NOT metadata.prompt, which is the AI-expanded
    # full lyrics output, a different thing (kept in metadata_json only).
    prompt = Column(Text)
    prompt_length = Column(Integer)
    prompt_hash = Column(String(64), index=True)

    # ---- Credit burn ----
    # Permanently null for this pass - the UI only shows a running
    # per-SESSION total ("N credits used this session"), not a confirmed
    # per-clip formula, and there isn't yet enough independent real data to
    # reverse-engineer one (unlike ElevenLabs Music, where three independent
    # confirmed data points made a formula safe to add). See
    # CAPTURE_CONTRACT.md's known-gaps section.
    credits_used = Column(Integer)

    # ---- Status ----
    # clip.status - confirmed present, but only "streaming" has ever been
    # observed (see constants.py's GENERATION_STATUS_* comment and
    # CAPTURE_CONTRACT.md's known-gaps section). Do NOT gate readiness on
    # this field - the confirmed readiness signal is
    # action_config.actions[].disabled for the "download_song" action (see
    # constants.READINESS_ACTION_TYPE), not `status`.
    status = Column(String(40), index=True)
    provider_created_at = Column(DateTime)
    provider_updated_at = Column(DateTime)

    # ---- Assets ----
    # Confirmed real field: audio_url. Populated immediately on capture -
    # NOT a readiness signal (media_urls/audio_url are populated even while
    # still generating, per CAPTURE_CONTRACT.md - it's a live streaming
    # endpoint, not proof the final asset exists yet).
    media_url = Column(Text)
    # Confirmed real field: image_url (cover art).
    thumbnail_url = Column(Text)

    # ---- Metadata catch-all (nothing discarded) ----
    metadata_json = Column(JSON)

    # ---- Asset mirroring ----
    # Same shape/reasoning as providers/elevenlabs/models.py::ElevenlabsGeneration's
    # identical columns: mirrored_asset_key holds the R2 object KEY (never a
    # URL - the bucket is private, see utils/r2_storage.py), and to_dict()
    # mints a fresh short-lived presigned URL from it on every read. No
    # periodic pull-based sweep exists for this provider (see
    # providers/suno/router.py's capture_audio docstring and main.py - same
    # reasoning as ElevenLabs: only a push from the browser, which holds the
    # real session, can ever populate this).
    mirrored_asset_key = Column(Text)
    # No index=True here - already covered by the explicit
    # Index("ix_suno_generations_asset_mirror_status", ...) in __table_args__
    # above. See FlowGeneration.batch_id's own comment in
    # providers/flow/models.py for why having both produces two indexes with
    # the IDENTICAL auto-generated name and breaks create_all().
    asset_mirror_status = Column(String(20), nullable=False, default="pending")  # pending | mirrored | failed | skipped
    asset_mirror_attempted_at = Column(DateTime)
    asset_mirror_error = Column(Text)

    # ---- Download tracking ----
    # Null = never downloaded. Set by capture_audio() in router.py when the
    # extension reports a confirmed Download click. Powers the dashboard's
    # Downloads view - a filter over this same table, not a separate one.
    downloaded_at = Column(DateTime)

    created_at = Column(DateTime, default=datetime.utcnow, nullable=False, index=True)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, nullable=False, index=True)

    def to_dict(self):
        r2_client = r2_storage.build_client() if self.mirrored_asset_key and r2_storage.is_configured() else None
        return {
            "id": self.id,
            "provider": self.provider,
            "creationId": self.provider_creation_id,
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
            "modelName": self.model_name,
            "majorModelVersion": self.major_model_version,
            "prompt": self.prompt,
            "promptLength": self.prompt_length,
            "promptHash": self.prompt_hash,
            "creditsUsed": self.credits_used,
            "status": self.status,
            "providerCreatedAt": serialize_utc_datetime(self.provider_created_at),
            "providerUpdatedAt": serialize_utc_datetime(self.provider_updated_at),
            "mediaUrl": self.media_url,
            "thumbnailUrl": self.thumbnail_url,
            "metadata": self.metadata_json or {},
            "mirroredAssetUrl": _presigned_mirror_url(self.mirrored_asset_key, client=r2_client),
            "assetMirrorStatus": self.asset_mirror_status,
            "assetMirrorAttemptedAt": serialize_utc_datetime(self.asset_mirror_attempted_at),
            "assetMirrorError": self.asset_mirror_error,
            "downloadedAt": serialize_utc_datetime(self.downloaded_at),
            "createdAt": serialize_utc_datetime(self.created_at),
            "updatedAt": serialize_utc_datetime(self.updated_at),
        }
