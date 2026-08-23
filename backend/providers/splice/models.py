# providers/splice/models.py - Splice Download Capture data model
"""
Two capture surfaces layer, mirroring providers/epidemicsound/models.py's
EpidemicCaptureEvent / EpidemicDownload pair exactly (this provider has only
the download-style surface - no Adapt-equivalent second surface exists for
Splice, see constants.py's module docstring):

  SpliceCaptureEvent (raw, append-only, lossless)
        -> normalization.py ->
  SpliceDownload     (normalized, one row per download CLICK - not per sample)

Splice (splice.com) is a sample/loop LIBRARY - users browse and download
audio samples, there is no "Generate" action and no generation identity at
all. Every download is its own real action, so - exactly like
EpidemicDownload/EnvatoDownload - a download is ALWAYS inserted as a new row,
never looked up/merged against a prior download of the same sample. There is
no idempotent-generation pattern for this surface.

Confirmed real traffic (live capture, 2026-08-19 - see CAPTURE_CONTRACT.md):

  POST https://surfaces-graphql.splice.com/graphql
  -> {
       "data": {
         "asset": {
           "__typename": "SampleAsset",
           "files": [
             {"asset_file_type_slug": "preview_mp3", "url": "https://spliceproduction.s3.us-west-1.amazonaws.com/audio_samples/{hash}-scrambled/{hash}.mp3?...", "path": "audio_samples/{hash}-scrambled/{hash}.mp3", ...},
             {"asset_file_type_slug": "waveform", "url": "https://spliceblob.splice.com/audio_samples/{hash}.wv.json", ...},
             {"asset_file_type_slug": "source", "url": "https://spliceproduction.s3.us-west-1.amazonaws.com/audio_samples/{hash}?X-Amz-...&X-Amz-Expires=119&...", "path": null, ...}
           ]
         }
       }
     }

then the browser GETs the "source" file's signed URL directly (the real
download bytes, Content-Type audio/wav) - that short-lived (119s) URL is what
this backend stores in asset_source_url.

sample_hash (parsed by normalization.py out of the source file's URL path,
e.g. `audio_samples/12908ad0...` -> `12908ad0...`) is the closest thing to a
sample identity in this data - there is NO explicit sample id/uuid anywhere
in the confirmed response. Stored as a reference/filterable column only,
never a dedup key (same posture as EpidemicDownload.sound_id).

No credits/quota field exists anywhere in the confirmed response (unlike
Epidemic Sound's `remainingDownloads`) - no equivalent column is invented
here.
"""
from sqlalchemy import (
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
from utils.datetime_utils import serialize_utc_datetime
from utils import r2_storage


def _presigned_mirror_url(key, *, client=None):
    """Mints a fresh short-lived R2 URL for a mirrored-asset key at
    serialization time - identical reasoning/implementation to
    providers/epidemicsound/models.py's function of the same name (see its
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


class SpliceCaptureEvent(Base):
    """Raw, provider-agnostic capture signal reported by the extension,
    stored losslessly and opaquely (payload_json) before normalization into
    SpliceDownload. Deliberately thin - see providers/splice/capture.py.
    Mirrors providers/epidemicsound/models.py's EpidemicCaptureEvent exactly.

    Idempotency is (provider, credential_id, client_event_id) - same
    reasoning as every other provider's *CaptureEvent: scope uniqueness by
    the shared account (credential), never by the reporting portal user.
    """
    __tablename__ = "splice_capture_events"
    __table_args__ = (
        Index(
            "ux_splice_capture_events_credential_client_event_id",
            "provider", "credential_id", "client_event_id",
            unique=True,
        ),
        Index("ix_splice_capture_events_download_id", "provider_download_id"),
        Index("ix_splice_capture_events_tool_created_at", "tool_id", "created_at"),
        Index("ix_splice_capture_events_user_created_at", "user_id", "created_at"),
    )

    id = Column(Integer, primary_key=True, index=True)
    tool_id = Column(Integer, ForeignKey("it_portal_tools.id"), nullable=False, index=True)
    credential_id = Column(Integer, ForeignKey("it_portal_tool_credentials.id"), index=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False, index=True)
    provider = Column(String(40), nullable=False, default="splice", index=True)
    event_type = Column(String(40), nullable=False, index=True)
    client_event_id = Column(String(160), nullable=False)
    # Splice has no per-download-event id in the confirmed response shape
    # (unlike Epidemic Sound's downloadId) - this column is kept for parity
    # with every other provider's capture envelope but is expected to stay
    # null; normalization.py falls back to the parsed sample_hash for
    # anything identity-shaped.
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


class SpliceDownload(Base):
    """One row per download of an EXISTING (not user-generated) audio sample
    from Splice's sample/loop library - a download IS gated behind the same
    mandatory Task/Client picker every other provider's capture-worthy action
    uses ("what he downloaded for what project" is the whole point of
    capturing this). Mirrors providers/epidemicsound/models.py's
    EpidemicDownload exactly, including its column set, sticky-ownership
    semantics, and asset-mirroring approach - see that class's own docstring
    for the reasoning repeated here only where Splice's shape actually
    differs.

    No download_id/sound_id/is_sfx/quality_type/stem_type/remaining_downloads
    columns (Epidemic Sound's confirmed identity/quota shape) - Splice's
    confirmed identity field is sample_hash instead (parsed by
    normalization.py out of the "source" file's URL path). See this module's
    own docstring for the confirmed real request/response shape.
    """
    __tablename__ = "splice_downloads"
    __table_args__ = (
        Index("ix_splice_downloads_owner_created_at", "owner_user_id", "created_at"),
        Index("ix_splice_downloads_credential_created_at", "credential_id", "created_at"),
        # sample_hash/source_host are NOT redeclared here - both columns
        # already carry index=True below, which auto-generates an index of
        # this exact same name (SQLAlchemy's ix_<table>_<column> convention).
        # Declaring both here would attempt to create the identical index
        # twice in one run and fail with DuplicateTable - this is the exact
        # bug that already hit EpidemicDownload once (see that class's own
        # __table_args__ comment, confirmed real 2026-08-18 against the live
        # Supabase Postgres) - only genuinely COMPOSITE multi-column indexes
        # belong in this tuple.
    )

    id = Column(Integer, primary_key=True, index=True)
    provider = Column(String(40), nullable=False, default="splice", index=True)
    source_capture_event_id = Column(Integer, ForeignKey("splice_capture_events.id", ondelete="SET NULL"))
    tool_id = Column(Integer, ForeignKey("it_portal_tools.id"), index=True)
    credential_id = Column(Integer, ForeignKey("it_portal_tool_credentials.id"), index=True)
    owner_user_id = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), index=True)
    ownership_status = Column(String(40), nullable=False, default="unknown", index=True)

    linked_task_id = Column(Integer, ForeignKey("tasks.id", ondelete="SET NULL"), index=True)
    linked_task_name = Column(String(255))
    linked_client_id = Column(Integer, ForeignKey("generation_clients.id", ondelete="SET NULL"), index=True)
    linked_client_name = Column(String(255))

    # ---- Identity (confirmed via a real live capture, 2026-08-19 - see this
    # module's own docstring and CAPTURE_CONTRACT.md) ----
    # Stable per-sample content identifier shared between the preview_mp3 and
    # source file paths - parsed out of the source URL's path by
    # normalization.py (regex on audio_samples/([0-9a-f]{20,})). Reference/
    # filterable column only, never a dedup key - same posture as
    # EpidemicDownload.sound_id.
    sample_hash = Column(String(160), index=True)

    # asset_title is the button-derived filename string the extension sends
    # directly (e.g. "GrenadeExplosion_S08WA.219.wav") - not derived by this
    # backend, see normalization.py.
    asset_title = Column(Text)
    asset_source_url = Column(Text)  # the short-lived (119s) signed "source" file URL
    preview_mp3_url = Column(Text)  # the longer-lived "preview_mp3" file URL - informational only
    page_url = Column(Text)
    source_host = Column(String(80), index=True)

    # ---- Asset mirroring (see providers/epidemicsound/models.py's
    # EpidemicDownload.mirrored_asset_key comment for the full reasoning) ----
    # The "source" file's signed URL requires the browser's own authenticated
    # session to have been fetched at all, and expires in only 119 seconds -
    # the shortest of any provider captured this session - so this backend
    # can never independently re-fetch it, only mirror what the extension
    # pushes via /capture/download-media.
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
            "sampleHash": self.sample_hash,
            "assetTitle": self.asset_title,
            "assetSourceUrl": self.asset_source_url,
            "previewMp3Url": self.preview_mp3_url,
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


class SpliceCaptureHealth(Base):
    """Latest known health snapshot of one extension install's Splice
    capture (not an event log). Mirrors EpidemicCaptureHealth exactly - added
    so background-splice-capture.js's periodic /capture/health ping has
    somewhere real to land instead of 404ing, even though this provider
    otherwise has no reconciliation/sync-cursor surface."""
    __tablename__ = "splice_capture_health"
    __table_args__ = (
        Index(
            "ux_splice_capture_health_session",
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
    provider = Column(String(40), nullable=False, default="splice", index=True)
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
