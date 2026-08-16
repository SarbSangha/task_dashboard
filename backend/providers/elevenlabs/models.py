# providers/elevenlabs/models.py - ElevenLabs (elevenlabs.io) Generation Capture data model
"""
Two-layer design, structurally copied from providers/flow/models.py:

  ElevenlabsCaptureEvent (raw, append-only, lossless)
        -> normalization.py ->
  ElevenlabsGeneration (normalized, one row per confirmed-or-guessed history
        item identity - see normalization.py's _extract_fields for the
        multi-candidate-key defensive extraction this requires)
        -> normalization.py also projects a matching row into ->
  GenerationRecord (models_new.py, provider="elevenlabs") for cross-tool
        reporting

Only ONE piece of real traffic has been observed for this provider (a
`GET /v1/history?page_size=20&source=TTS&sort_direction=desc` *request*, seen
in a DevTools screenshot, not a full HAR) - the response body shape is NOT
confirmed. Every field below is therefore a best guess, and metadata_json
holds the raw history-row object verbatim so nothing is lost once the real
shape is confirmed and this module needs a follow-up pass. See
CAPTURE_CONTRACT.md's "known gaps" section for the full list of open
questions.

Beyond Flow's column set, this model adds (up front, since audio-asset
mirroring is in scope from the start for ElevenLabs, unlike Flow):
  - source/voice_id/voice_name - ElevenLabs-specific identity/classification
    fields.
  - Freepik's asset-mirror column shape (asset_mirror_status/
    mirrored_asset_key/asset_mirror_attempted_at/asset_mirror_error) - see
    providers/freepik/models.py's identical columns and
    providers/elevenlabs/asset_mirror.py.
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


class ElevenlabsCaptureEvent(Base):
    """Raw capture signal reported by the extension - mirrors
    providers/flow/models.py::FlowCaptureEvent's shape/columns/idempotency
    rule exactly (same (provider, credential_id, client_event_id) scope - see
    that class's docstring for the full reasoning). Deliberately thin: no
    parsing, no business logic - see providers/elevenlabs/capture.py.
    """
    __tablename__ = "elevenlabs_capture_events"
    __table_args__ = (
        Index(
            "ux_elevenlabs_capture_events_credential_client_event_id",
            "provider", "credential_id", "client_event_id",
            unique=True,
        ),
        Index("ix_elevenlabs_capture_events_creation_id", "provider_creation_id"),
        Index("ix_elevenlabs_capture_events_family_id", "provider_family_id"),
        Index("ix_elevenlabs_capture_events_tool_created_at", "tool_id", "created_at"),
        Index("ix_elevenlabs_capture_events_user_created_at", "user_id", "created_at"),
    )

    id = Column(Integer, primary_key=True, index=True)
    tool_id = Column(Integer, ForeignKey("it_portal_tools.id"), nullable=False, index=True)
    credential_id = Column(Integer, ForeignKey("it_portal_tool_credentials.id"), index=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False, index=True)
    provider = Column(String(40), nullable=False, default="elevenlabs", index=True)
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


class ElevenlabsGeneration(Base):
    """One row per ElevenLabs history item (TTS clip / music track / sound
    effect / dubbing / voice-changer output / speech-to-text transcript).
    See CAPTURE_CONTRACT.md for the (unconfirmed) field mapping this
    implements.

    Ownership is capture-time-only, same reasoning as FlowGeneration/
    FreepikGeneration: ElevenLabs' history API never identifies which
    employee generated a row (it's scoped to the shared account, not
    per-employee) - owner_user_id here is resolved exclusively from this
    codebase's own launch-ticket system at the moment of interception. A row
    imported later purely from reconciliation, with no matching live ticket,
    is structurally unattributable and stays ownership_status='unknown' by
    design.
    """
    __tablename__ = "elevenlabs_generations"
    __table_args__ = (
        CheckConstraint(
            "provider_creation_id IS NOT NULL",
            name="ck_elevenlabs_generations_identity_present",
        ),
        Index(
            "ux_elevenlabs_generations_creation_id",
            "provider", "provider_creation_id",
            unique=True,
        ),
        Index("ix_elevenlabs_generations_owner_created_at", "owner_user_id", "created_at"),
        Index("ix_elevenlabs_generations_owner_status_created_at", "owner_user_id", "ownership_status", "created_at"),
        Index("ix_elevenlabs_generations_credential_created_at", "credential_id", "created_at"),
        Index("ix_elevenlabs_generations_ingestion_created_at", "ingestion_source", "created_at"),
        Index("ix_elevenlabs_generations_generation_record_id", "generation_record_id"),
        Index("ix_elevenlabs_generations_asset_mirror_status", "asset_mirror_status"),
    )

    id = Column(Integer, primary_key=True, index=True)
    provider = Column(String(40), nullable=False, default="elevenlabs", index=True)

    # ---- Identity ----
    # The only confirmed identifier candidate is `history_item_id` (best
    # guess - see normalization.py's _extract_fields for the full candidate
    # list this is picked from). Collapses to a single column, same posture
    # as FlowGeneration.provider_creation_id.
    provider_creation_id = Column(String(160), index=True)

    # ---- Ownership / capture provenance ----
    source_capture_event_id = Column(Integer, ForeignKey("elevenlabs_capture_events.id", ondelete="SET NULL"))
    generation_record_id = Column(Integer, ForeignKey("generation_records.id", ondelete="SET NULL"))
    tool_id = Column(Integer, ForeignKey("it_portal_tools.id"), index=True)
    credential_id = Column(Integer, ForeignKey("it_portal_tool_credentials.id"), index=True)
    owner_user_id = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), index=True)
    ownership_status = Column(String(40), nullable=False, default="unknown", index=True)
    ownership_source = Column(String(80))
    ownership_notes = Column(Text)
    assigned_by_admin_id = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"))
    assigned_at = Column(DateTime)
    # Task Mapping - carried in from ElevenlabsCaptureEvent.linked_task_id/
    # name, then projected onto GenerationRecord below (see normalization.py).
    linked_task_id = Column(Integer, ForeignKey("tasks.id", ondelete="SET NULL"), index=True)
    linked_task_name = Column(String(255))
    linked_client_id = Column(Integer, ForeignKey("generation_clients.id", ondelete="SET NULL"), index=True)
    linked_client_name = Column(String(255))
    generation_source = Column(String(40), nullable=False, default="live_capture", index=True)  # live_capture | reconciliation
    generation_method = Column(String(40), nullable=False, default="network_intercept")  # network_intercept | history_scan
    ingestion_source = Column(String(40), nullable=False, default="captured", index=True)  # captured | recovered

    # ---- ElevenLabs-specific classification (beyond Flow's shape) ----
    # Raw `source` field value (e.g. "TTS") - kept both as its own indexed
    # column (for fast per-surface filtering/reporting) and inside
    # metadata_json (as part of the raw payload, unmodified). See
    # constants.py's KNOWN_SOURCE_VALUES for the diagnostic-only allow-list
    # this is checked against at normalization time.
    source = Column(String(40), index=True)
    voice_id = Column(String(160))
    voice_name = Column(String(255))

    # ---- Prompt / text input ----
    prompt = Column(Text)  # the text fed to TTS/Music/SFX, when present
    prompt_length = Column(Integer)
    prompt_hash = Column(String(64), index=True)

    # ---- Credit burn ----
    # ElevenLabs' own character_count_change_to minus character_count_change_from
    # (see normalization.py's _credits_used) - how many of the account's
    # shared credits this one generation consumed. Confirmed real field
    # names, unlike most of this model's other columns.
    credits_used = Column(Integer)

    # ---- Status (unconfirmed field, kept for parity - see constants.py) ----
    status = Column(String(40), index=True)
    provider_created_at = Column(DateTime)
    provider_updated_at = Column(DateTime)

    # ---- Assets ----
    # media_url is populated by normalization.py's best-guess field
    # extraction (audio_url/url/download_url/nested media.url - see
    # CAPTURE_CONTRACT.md) when a candidate is present on the row. Left null
    # for Speech-to-Text rows (no audio output) and for any row whose real
    # shape doesn't match any known candidate key yet.
    media_url = Column(Text)
    thumbnail_url = Column(Text)

    # ---- Metadata catch-all (nothing discarded) ----
    metadata_json = Column(JSON)

    # ---- Asset mirroring (see providers/elevenlabs/asset_mirror.py) ----
    # Same shape/reasoning as providers/freepik/models.py::FreepikGeneration's
    # identical columns: mirrored_asset_key holds the R2 object KEY (never a
    # URL - the bucket is private, see utils/r2_storage.py), and to_dict()
    # mints a fresh short-lived presigned URL from it on every read.
    mirrored_asset_key = Column(Text)
    # No index=True here - already covered by the explicit
    # Index("ix_elevenlabs_generations_asset_mirror_status", ...) in
    # __table_args__ above. See FlowGeneration.batch_id's own comment in
    # providers/flow/models.py for why having both produces two indexes with
    # the IDENTICAL auto-generated name and breaks create_all().
    asset_mirror_status = Column(String(20), nullable=False, default="pending")  # pending | mirrored | failed | skipped
    asset_mirror_attempted_at = Column(DateTime)
    asset_mirror_error = Column(Text)

    # ---- Download tracking ----
    # Null = never downloaded. Set by capture_audio() in router.py when the
    # extension reports a CONFIRMED Download click (not Play, not our own
    # proactive fetch - see content-elevenlabs-network.js's "AUDIO DELIVERY"
    # comment: only the real Download request body carries history_item_id,
    # Play never does). Powers the dashboard's Downloads view - a filter over
    # this same table, not a separate one, since unlike Freepik's
    # FreepikDownload (downloads of existing stock assets) an ElevenLabs
    # download is always of something the user already generated.
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
            "source": self.source,
            "voiceId": self.voice_id,
            "voiceName": self.voice_name,
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
