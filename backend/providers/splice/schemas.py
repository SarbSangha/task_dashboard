# providers/splice/schemas.py
"""
Pydantic request/response payloads for the Splice provider's API surface.
Mirrors providers/epidemicsound/schemas.py's download-only shape exactly (see
that file's own docstring) - Splice has only one capture surface (downloads),
no Adapt-equivalent second surface, so no adaptation schemas exist here. No
sync-cursor shapes exist either (no reconciliation walker on this provider).
"""
from typing import Any, Optional

from pydantic import BaseModel, Field


class CaptureEventIn(BaseModel):
    """One raw capture signal as reported by the extension - a single
    download_click event, plus routing/identity fields the extension
    already knows. `payload` is opaque to this layer; see
    providers/splice/capture.py."""

    event_type: str = Field(..., min_length=1, max_length=40)
    client_event_id: str = Field(..., min_length=1, max_length=160)
    download_id: Optional[str] = Field(default=None, max_length=160)
    payload: dict[str, Any] = Field(default_factory=dict)
    capture_version: Optional[int] = None
    extension_version: Optional[str] = Field(default=None, max_length=40)
    browser: Optional[str] = Field(default=None, max_length=80)
    tab_id: Optional[int] = None
    session_id: Optional[str] = Field(default=None, max_length=512)
    extension_session_id: Optional[str] = Field(default=None, max_length=160)
    credential_id: Optional[int] = None
    event_date: Optional[str] = None  # ISO date; defaults to today (server time) if omitted

    # Task Mapping: the internal Task the extension's pre-download gate had
    # the user select. Never trusted as-is - ingest_capture_event()
    # revalidates server-side.
    linked_task_id: Optional[int] = None

    # Client Mapping: independent selection from the same gate.
    linked_client_id: Optional[int] = None

    # Identity proof for ownership attribution - same ticket fields every
    # other DIRECT_TICKET_ONLY_TOOLS provider's capture payload sends,
    # resolved the same way by _resolve_usage_event_actor.
    extension_ticket: Optional[str] = Field(default=None, max_length=4000)
    usage_ticket: Optional[str] = Field(default=None, max_length=4000)


class CaptureEventsRequest(BaseModel):
    """Body of POST /api/providers/splice/capture/events - always a batch."""

    events: list[CaptureEventIn] = Field(..., min_length=1, max_length=200)


class CaptureEventResult(BaseModel):
    client_event_id: str
    status: str  # "created" | "duplicate" | "rejected"
    id: Optional[int] = None
    reason: Optional[str] = None


class CaptureEventsResponse(BaseModel):
    success: bool = True
    results: list[CaptureEventResult]


class PaginationOut(BaseModel):
    limit: int
    offset: int
    total: int


class CaptureDownloadMediaIn(BaseModel):
    """One captured audio asset, base64-encoded, pushed directly by the
    extension after it observes Splice's own authenticated "source" file
    response in the browser - mirrors providers/epidemicsound/schemas.py's
    CaptureDownloadMediaIn exactly (same reasoning: the real download
    response requires the browser's own session, so this backend can never
    pull it independently - see providers/splice/models.py's
    SpliceDownload.mirrored_asset_key comment). The source URL expires in
    only 119 seconds, so the extension pushes bytes here almost immediately -
    an extension-side concern, not a backend one.

    client_event_id (the SAME id the original download_click
    SpliceCaptureEvent was reported under) is the correlation key: the
    backend looks up that event, then the SpliceDownload row whose
    source_capture_event_id points at it."""

    client_event_id: str = Field(..., min_length=1, max_length=160)
    content_type: Optional[str] = Field(default=None, max_length=100)
    media_base64: str = Field(..., min_length=1)


class CaptureDownloadMediaResult(BaseModel):
    success: bool
    # "mirrored" | "already_mirrored" | "download_not_found" | "not_configured" | "invalid_media"
    status: str


class DownloadListOut(BaseModel):
    success: bool = True
    data: list[dict[str, Any]]
    pagination: PaginationOut


class DownloadDetailOut(BaseModel):
    success: bool = True
    data: dict[str, Any]


class CaptureHealthPingIn(BaseModel):
    extension_session_id: Optional[str] = Field(default=None, max_length=160)
    extension_version: Optional[str] = Field(default=None, max_length=40)
    credential_id: Optional[int] = None
    queue_length: int = 0
    events_waiting: int = 0
    oldest_pending_event_at: Optional[str] = None
    retry_count: int = 0
    last_capture_event_at: Optional[str] = None
    last_successful_upload_at: Optional[str] = None
    last_failed_upload_at: Optional[str] = None
    average_upload_time_ms: Optional[int] = None
    offline_since: Optional[str] = None
    extension_ticket: Optional[str] = Field(default=None, max_length=4000)
    usage_ticket: Optional[str] = Field(default=None, max_length=4000)


class CaptureHealthOut(BaseModel):
    success: bool = True
    data: dict[str, Any]


class EventListOut(BaseModel):
    success: bool = True
    data: list[dict[str, Any]]
    pagination: PaginationOut


class EventDetailOut(BaseModel):
    success: bool = True
    data: dict[str, Any]
