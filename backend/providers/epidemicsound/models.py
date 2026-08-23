# providers/epidemicsound/models.py - Epidemic Sound Download + Adapt Capture data model
"""
Two capture surfaces, both built on the same raw/normalized two-layer design
mirroring providers/envato/models.py's EnvatoCaptureEvent / EnvatoDownload
pair:

  EpidemicCaptureEvent (raw, append-only, lossless - shared by BOTH surfaces)
        -> normalization.py ->
  EpidemicDownload   (normalized, one row per download CLICK - not per track)
  EpidemicAdaptation (normalized, one row per Adapt VERSION identity - see
                       that class's own docstring; upserted, not always-new)

Surface 1 - stock-library downloads: Epidemic Sound has no "Generate" action
for this surface and no generation identity at all - users browse and
download pre-made tracks/sound-effects from a licensing library. Every
download is its own real, individually-quota-consuming action (see the
confirmed `remainingDownloads` counter in the response body), so - exactly
like EnvatoDownload - a download is ALWAYS inserted as a new row, never
looked up/merged against a prior download of the same track. There is no
idempotent-generation pattern for this surface.

Confirmed real traffic (live DevTools capture, 2026-08-18 - see
CAPTURE_CONTRACT.md):

  GET https://www.epidemicsound.com/download/?bundle=false&context=MODAL_MUSIC_DOWNLOAD
      &downloadId=383bf181-f9f2-4251-ab6d-0fd24cd1528e&is_sfx=true&qualityType=hq
      &queryId=e342da71-3874-406d-bd5c-3a2a6fd3e675&sound_id=16bb9f7c-282e-45f4-a253-40ee6d605412
      &stemType=full&uiOrigin=tracklist_button&useBundler=true
  -> {
       "assetUrl": "https://audiocdn.epidemicsound.com/audiofiles/mp3/....mp3?...&response-content-disposition=attachment%3B%20filename%3D%22ES_Swooshes%2C%20Whoosh%2C%20Mids%20-%20Epidemic%20Sound.mp3%22&...",
       "remainingDownloads": 1188
     }

downloadId (request URL) is the per-download-event identity - a fresh id
minted every single download click, stored as a reference field only (never
a dedup key). sound_id (request URL) is the stable TRACK identity, also a
reference/filterable column, not a dedup key.

Surface 2 - Adapt (epidemicsound.com/adapt): a real AI generation with an
actual multi-step lifecycle and a stable identity across it - see
EpidemicAdaptation's own docstring and CAPTURE_CONTRACT.md for the confirmed
request/response shapes (live DevTools capture, 2026-08-19).
"""
from sqlalchemy import (
    Boolean,
    Column,
    Date,
    DateTime,
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
from providers.epidemicsound.constants import ADAPTATION_CREDITS_FLAT_RATE
from utils.datetime_utils import serialize_utc_datetime
from utils import r2_storage


def _presigned_mirror_url(key, *, client=None):
    """Mints a fresh short-lived R2 URL for a mirrored-asset key at
    serialization time - identical reasoning/implementation to
    providers/envato/models.py's function of the same name (see its
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


class EpidemicCaptureEvent(Base):
    """Raw, provider-agnostic capture signal reported by the extension,
    stored losslessly and opaquely (payload_json) before normalization into
    EpidemicDownload. Deliberately thin - see providers/epidemicsound/capture.py.
    Mirrors providers/envato/models.py's EnvatoCaptureEvent exactly.

    Idempotency is (provider, credential_id, client_event_id) - same
    reasoning as every other provider's *CaptureEvent: scope uniqueness by
    the shared account (credential), never by the reporting portal user.
    """
    __tablename__ = "epidemic_capture_events"
    __table_args__ = (
        Index(
            "ux_epidemic_capture_events_credential_client_event_id",
            "provider", "credential_id", "client_event_id",
            unique=True,
        ),
        Index("ix_epidemic_capture_events_download_id", "provider_download_id"),
        Index("ix_epidemic_capture_events_tool_created_at", "tool_id", "created_at"),
        Index("ix_epidemic_capture_events_user_created_at", "user_id", "created_at"),
    )

    id = Column(Integer, primary_key=True, index=True)
    tool_id = Column(Integer, ForeignKey("it_portal_tools.id"), nullable=False, index=True)
    credential_id = Column(Integer, ForeignKey("it_portal_tool_credentials.id"), index=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False, index=True)
    provider = Column(String(40), nullable=False, default="epidemic-sound", index=True)
    event_type = Column(String(40), nullable=False, index=True)
    client_event_id = Column(String(160), nullable=False)
    # downloadId from the request URL - the per-download-event identity, a
    # fresh id minted every single download click (see this module's own
    # docstring). Stored here purely as a reference field, same posture as
    # EnvatoCaptureEvent.provider_item_uuid.
    provider_download_id = Column(String(160), index=True)
    ownership_confidence = Column(String(20))  # "ticket" | "session" - set by capture.py
    # Task Mapping: the internal Task (tasks.id) the extension's gate had the
    # user select before this download - re-validated server-side in
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
            "providerDownloadId": self.provider_download_id,
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


class EpidemicDownload(Base):
    """One row per download of an EXISTING (not user-generated) stock
    music/sound-effect track from Epidemic Sound's licensing library - a
    download IS gated behind the same mandatory Task/Client picker every
    other provider's capture-worthy action uses ("what he downloaded for
    what project" is the whole point of capturing this). Mirrors
    providers/envato/models.py's EnvatoDownload exactly, including its
    column set, sticky-ownership semantics, and asset-mirroring approach -
    see that class's own docstring for the reasoning repeated here only
    where Epidemic Sound's shape actually differs.

    No item_uuid/item_type columns (Envato's stock-download identity shape) -
    Epidemic Sound's confirmed identity fields are download_id (per-click,
    from the request URL's downloadId) and sound_id (per-track, from the
    request URL's sound_id) instead. See this module's own docstring for the
    confirmed real request/response shape.

    remaining_downloads is purely informational (the account's download
    quota remaining AFTER this download, from the response body) - there is
    no confirmed formula for a per-download cost, so no credits_used column
    exists here at all (same "don't guess a cost" discipline as Suno's
    permanently-null credits_used, taken one step further since
    EnvatoDownload itself has no credits column either).
    """
    __tablename__ = "epidemic_downloads"
    __table_args__ = (
        Index("ix_epidemic_downloads_owner_created_at", "owner_user_id", "created_at"),
        Index("ix_epidemic_downloads_credential_created_at", "credential_id", "created_at"),
        # sound_id/download_id are NOT redeclared here - both columns already
        # carry index=True below, which auto-generates an index of this exact
        # same name (SQLAlchemy's ix_<table>_<column> convention). Declaring
        # both caused create_all() to attempt creating the identical index
        # twice in one run and fail with DuplicateTable (confirmed real,
        # 2026-08-18, against the live Supabase Postgres - not a
        # uvicorn --reload race as first suspected).
    )

    id = Column(Integer, primary_key=True, index=True)
    provider = Column(String(40), nullable=False, default="epidemic-sound", index=True)
    source_capture_event_id = Column(Integer, ForeignKey("epidemic_capture_events.id", ondelete="SET NULL"))
    tool_id = Column(Integer, ForeignKey("it_portal_tools.id"), index=True)
    credential_id = Column(Integer, ForeignKey("it_portal_tool_credentials.id"), index=True)
    owner_user_id = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), index=True)
    ownership_status = Column(String(40), nullable=False, default="unknown", index=True)

    linked_task_id = Column(Integer, ForeignKey("tasks.id", ondelete="SET NULL"), index=True)
    linked_task_name = Column(String(255))
    linked_client_id = Column(Integer, ForeignKey("generation_clients.id", ondelete="SET NULL"), index=True)
    linked_client_name = Column(String(255))

    # ---- Identity (confirmed via a real live DevTools capture, 2026-08-18 -
    # see this module's own docstring and CAPTURE_CONTRACT.md) ----
    download_id = Column(String(160), index=True)  # request URL's downloadId - per-download-click, never a dedup key
    sound_id = Column(String(160), index=True)      # request URL's sound_id - stable per-track identity
    is_sfx = Column(Boolean)                          # request URL's is_sfx - Sound Effect vs Music
    quality_type = Column(String(40))                 # request URL's qualityType, e.g. "hq"
    stem_type = Column(String(40))                     # request URL's stemType, e.g. "full"
    remaining_downloads = Column(Integer)              # response body's remainingDownloads - informational only, no cost formula

    # asset_title is parsed out of the response's assetUrl
    # response-content-disposition filename param (see normalization.py's
    # _parse_asset_title) - defensive best-effort, falls back to null on any
    # parse failure rather than raising.
    asset_title = Column(Text)
    asset_source_url = Column(Text)  # the raw, signed assetUrl from the response body (short-lived - see mirroring below)
    page_url = Column(Text)
    source_host = Column(String(80), index=True)

    # ---- Asset mirroring (see providers/envato/models.py's EnvatoDownload.
    # mirrored_asset_key comment for the full reasoning) ----
    # assetUrl is real but signed/time-limited (audiocdn.epidemicsound.com,
    # a different host from www.epidemicsound.com) and requires the
    # browser's own authenticated session to have been fetched at all, so
    # this backend can never independently re-fetch it - only the browser,
    # which already legitimately received the bytes, can push them here via
    # /capture/download-media. mirrored_asset_key holds the R2 object KEY
    # (never a URL - the bucket is private, see utils/r2_storage.py);
    # to_dict() mints a fresh short-lived presigned URL from it on every read.
    mirrored_asset_key = Column(Text)
    asset_mirror_status = Column(String(20), nullable=False, default="pending")  # pending | mirrored | failed | skipped
    asset_mirror_attempted_at = Column(DateTime)
    asset_mirror_error = Column(Text)

    downloaded_at = Column(DateTime)
    metadata_json = Column(JSON)

    created_at = Column(DateTime, default=datetime.utcnow, nullable=False, index=True)

    def to_dict(self):
        r2_client = (
            r2_storage.build_client()
            if self.mirrored_asset_key and r2_storage.is_configured()
            else None
        )
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
            "downloadId": self.download_id,
            "soundId": self.sound_id,
            "isSfx": self.is_sfx,
            "qualityType": self.quality_type,
            "stemType": self.stem_type,
            "remainingDownloads": self.remaining_downloads,
            "assetTitle": self.asset_title,
            "assetSourceUrl": self.asset_source_url,
            "sourceHost": self.source_host,
            "pageUrl": self.page_url,
            "mirroredAssetUrl": _presigned_mirror_url(self.mirrored_asset_key, client=r2_client),
            "assetMirrorStatus": self.asset_mirror_status,
            "assetMirrorAttemptedAt": serialize_utc_datetime(self.asset_mirror_attempted_at),
            "assetMirrorError": self.asset_mirror_error,
            "downloadedAt": serialize_utc_datetime(self.downloaded_at),
            "metadata": self.metadata_json or {},
            "createdAt": serialize_utc_datetime(self.created_at),
        }


class EpidemicAdaptation(Base):
    """One row per Adapt "version" (epidemicsound.com/adapt) - a real AI
    generation that regenerates a track's stems from a text prompt.
    Architecturally different from EpidemicDownload above: there IS a stable
    identity here (the version's own `id`) that persists across a real
    multi-step async lifecycle (draft -> pending -> completed - see
    constants.py's ADAPTATION_STATUS_* comment), so unlike EpidemicDownload's
    always-insert-new-row design, this table is UPSERTED BY IDENTITY
    (version_id) - mirrors providers/elevenlabs/models.py's
    ElevenlabsGeneration / normalization.py's _find_existing_generation
    pattern, not EnvatoDownload's/EpidemicDownload's own pattern. See
    normalization.py's _normalize_adaptation_version_event and
    CAPTURE_CONTRACT.md for the full reasoning and confirmed request/response
    shapes (live DevTools capture, 2026-08-19).

    Confirmed real lifecycle:

      POST .../sessions/{sessionId}/versions/compose    -> status "draft"
      POST .../sessions/{sessionId}/versions/{id}/finalize -> status "pending"
      GET  .../sessions/{sessionId}/versions?...          -> status "completed"
                                                              (once settled)

    Ownership/task/client/tool/credential/mirror column set is copied
    verbatim from EpidemicDownload above (same sticky-ownership semantics,
    same asset-mirroring approach via mirrored_asset_key/asset_mirror_status
    - see that class's own docstring for the shared reasoning, not repeated
    here).

    The prompt lives in one of two different shapes depending on which
    internal variant a version has - normalization.py checks both,
    defensively (see its own docstring): `compose.clientSettings.
    modifications[].prompt` (last entry) or `remix.textPrompt`.

    session_id/original_track_title are NOT present in any confirmed API
    response body - session_id is parsed by the extension from the request
    URL path and passed through as payload.sessionId; original_track_title
    is DOM-scraped by the extension (best-effort, often absent) and passed
    through as payload.originalTrackTitle. Both are stored as plain
    reference/optional columns, never a dedup key (version_id alone is the
    identity).

    credits_used is always set to constants.py's ADAPTATION_CREDITS_FLAT_RATE
    - see that constant's own comment for why this is a confirmed single data
    point treated as a flat rate, not a formula.
    """
    __tablename__ = "epidemic_adaptations"
    __table_args__ = (
        Index("ix_epidemic_adaptations_owner_created_at", "owner_user_id", "created_at"),
        Index("ix_epidemic_adaptations_credential_created_at", "credential_id", "created_at"),
        # version_id/session_id/recording_id/status are NOT redeclared here -
        # each already carries index=True below, which auto-generates an
        # index of this exact same name (SQLAlchemy's ix_<table>_<column>
        # convention). Redeclaring any of them here would attempt to create
        # the identical index twice and crash create_all() with
        # DuplicateTable - this is the exact bug that already hit
        # EpidemicDownload once (see that class's own __table_args__
        # comment, confirmed real 2026-08-18) - only genuinely COMPOSITE
        # multi-column indexes belong in this tuple.
    )

    id = Column(Integer, primary_key=True, index=True)
    provider = Column(String(40), nullable=False, default="epidemic-sound", index=True)
    source_capture_event_id = Column(Integer, ForeignKey("epidemic_capture_events.id", ondelete="SET NULL"))
    tool_id = Column(Integer, ForeignKey("it_portal_tools.id"), index=True)
    credential_id = Column(Integer, ForeignKey("it_portal_tool_credentials.id"), index=True)
    owner_user_id = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), index=True)
    ownership_status = Column(String(40), nullable=False, default="unknown", index=True)

    linked_task_id = Column(Integer, ForeignKey("tasks.id", ondelete="SET NULL"), index=True)
    linked_task_name = Column(String(255))
    linked_client_id = Column(Integer, ForeignKey("generation_clients.id", ondelete="SET NULL"), index=True)
    linked_client_name = Column(String(255))

    # ---- Identity (confirmed via a real live DevTools capture, 2026-08-19 -
    # see this class's own docstring and CAPTURE_CONTRACT.md) ----
    version_id = Column(String(160), unique=True, index=True)  # the version's own `id` - stable across draft->pending->completed
    session_id = Column(String(160), index=True)                # parsed by the extension from the request URL path, not the response body
    recording_id = Column(String(160), index=True)               # `recordingId` - the ORIGINAL track being adapted
    original_track_title = Column(Text)                           # DOM-scraped by the extension, best-effort, often absent

    prompt = Column(Text)
    status = Column(String(40), index=True)  # "draft" | "pending" | "completed" - see constants.py's ADAPTATION_STATUS_*
    credits_used = Column(Integer, default=ADAPTATION_CREDITS_FLAT_RATE)  # see constants.py's own comment - a confirmed flat rate, not a formula

    # media_url only ever populated once status == "completed" - see
    # normalization.py's own comment for why the draft/pending-era
    # compose.clientSettings.modifications[].audioUrl is deliberately NOT
    # read as the final asset (it's a preview URL, not the confirmed final
    # one).
    media_url = Column(Text)
    # Raw `stems` object from a completed version (per-stem previewUrl) -
    # stored as one JSON blob rather than separate columns, matching this
    # codebase's "store what's not a first-class column in a JSON blob,
    # nothing is ever lost" convention.
    stems_json = Column(JSON)
    metadata_json = Column(JSON)

    # ---- Asset mirroring (identical reasoning/columns to EpidemicDownload's
    # own mirrored_asset_key block above - the previewUrl is real but signed/
    # time-limited and requires the browser's own authenticated session, so
    # this backend can never independently re-fetch it) ----
    mirrored_asset_key = Column(Text)
    asset_mirror_status = Column(String(20), nullable=False, default="pending")  # pending | mirrored | failed | skipped
    asset_mirror_attempted_at = Column(DateTime)
    asset_mirror_error = Column(Text)

    created_at = Column(DateTime, default=datetime.utcnow, nullable=False, index=True)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, nullable=False)

    def to_dict(self):
        r2_client = (
            r2_storage.build_client()
            if self.mirrored_asset_key and r2_storage.is_configured()
            else None
        )
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
            "versionId": self.version_id,
            "sessionId": self.session_id,
            "recordingId": self.recording_id,
            "originalTrackTitle": self.original_track_title,
            "prompt": self.prompt,
            "status": self.status,
            "creditsUsed": self.credits_used,
            "mediaUrl": self.media_url,
            "stems": self.stems_json or {},
            "mirroredAssetUrl": _presigned_mirror_url(self.mirrored_asset_key, client=r2_client),
            "assetMirrorStatus": self.asset_mirror_status,
            "assetMirrorAttemptedAt": serialize_utc_datetime(self.asset_mirror_attempted_at),
            "assetMirrorError": self.asset_mirror_error,
            "metadata": self.metadata_json or {},
            "createdAt": serialize_utc_datetime(self.created_at),
            "updatedAt": serialize_utc_datetime(self.updated_at),
        }


class EpidemicCaptureHealth(Base):
    """Latest known health snapshot of one extension install's Epidemic
    Sound capture (not an event log). Mirrors EnvatoCaptureHealth exactly -
    added so background-epidemicsound-capture.js's periodic /capture/health
    ping (mirroring background-envato-capture.js's structure) has somewhere
    real to land instead of 404ing, even though this provider otherwise has
    no reconciliation/sync-cursor surface."""
    __tablename__ = "epidemic_capture_health"
    __table_args__ = (
        Index(
            "ux_epidemic_capture_health_session",
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
    provider = Column(String(40), nullable=False, default="epidemic-sound", index=True)
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
