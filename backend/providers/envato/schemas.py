# providers/envato/schemas.py
"""
Pydantic request/response payloads for the Envato provider's API surface.
Mirrors providers/freepik/schemas.py exactly - see that file's own docstring.
"""
from typing import Any, Optional

from pydantic import BaseModel, Field


class CaptureEventIn(BaseModel):
    """One raw capture signal as reported by the extension - a single decoded
    item from Envato's generation-history.data endpoint, plus routing/identity
    fields the extension already knows. `payload` is opaque to this layer;
    see providers/envato/capture.py."""

    event_type: str = Field(..., min_length=1, max_length=40)
    client_event_id: str = Field(..., min_length=1, max_length=160)
    item_uuid: Optional[str] = Field(default=None, max_length=160)
    # True only when the extension is walking historical generation-history
    # pages as part of a reconciliation/backfill sync (see sync.py) - never
    # true for a row discovered via the Generate-click arm+correlate window.
    # Explicit signal from the extension, not inferred from timestamps.
    is_reconciliation: bool = False
    payload: dict[str, Any] = Field(default_factory=dict)
    capture_version: Optional[int] = None
    extension_version: Optional[str] = Field(default=None, max_length=40)
    browser: Optional[str] = Field(default=None, max_length=80)
    tab_id: Optional[int] = None
    session_id: Optional[str] = Field(default=None, max_length=512)
    extension_session_id: Optional[str] = Field(default=None, max_length=160)
    credential_id: Optional[int] = None
    event_date: Optional[str] = None  # ISO date; defaults to today (server time) if omitted

    # Task Mapping: the internal Task the extension's pre-generation gate had
    # the user select (see content-envato-task-modal.js). Never trusted as-is
    # - ingest_capture_event() revalidates server-side.
    linked_task_id: Optional[int] = None

    # Client Mapping: independent selection from the same gate.
    linked_client_id: Optional[int] = None

    # Note: DOM-scraped credit signals (the "+N" Generate-button badge, the
    # sidebar quota-remaining counter) travel inside `payload` itself
    # (creditsBadge/quotaRemainingBefore/quotaRemainingAfter keys), not as
    # their own top-level fields here - same posture as every other
    # generation-shaped field Envato's payload carries. They are simply
    # absent on a reconciliation-sourced payload (no click happened).

    # Identity proof for ownership attribution - same ticket fields every
    # other provider's capture payload sends, resolved the same way by
    # _resolve_usage_event_actor. Envato is a DIRECT_TICKET_ONLY_TOOLS entry,
    # so a ticket is the only reliable proof of "which employee".
    extension_ticket: Optional[str] = Field(default=None, max_length=4000)
    usage_ticket: Optional[str] = Field(default=None, max_length=4000)


class CaptureEventsRequest(BaseModel):
    """Body of POST /api/providers/envato/capture/events - always a batch."""

    events: list[CaptureEventIn] = Field(..., min_length=1, max_length=200)


class CaptureEventResult(BaseModel):
    client_event_id: str
    status: str  # "created" | "duplicate" | "rejected"
    id: Optional[int] = None
    generation_id: Optional[int] = None
    reason: Optional[str] = None


class CaptureEventsResponse(BaseModel):
    success: bool = True
    results: list[CaptureEventResult]


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


class PaginationOut(BaseModel):
    limit: int
    offset: int
    total: int


class GenerationListOut(BaseModel):
    success: bool = True
    data: list[dict[str, Any]]
    pagination: PaginationOut


class GenerationDetailOut(BaseModel):
    success: bool = True
    data: dict[str, Any]


class SyncCursorIn(BaseModel):
    credential_id: Optional[int] = None
    last_seen_item_uuid: Optional[str] = Field(default=None, max_length=160)
    last_synced_page: int = 0
    is_full_reconciliation: bool = False
    status: str = "idle"
    error: Optional[str] = None
    extension_ticket: Optional[str] = Field(default=None, max_length=4000)
    usage_ticket: Optional[str] = Field(default=None, max_length=4000)


class SyncCursorOut(BaseModel):
    success: bool = True
    data: dict[str, Any]


class MetricsOut(BaseModel):
    success: bool = True
    data: dict[str, Any]


class EventListOut(BaseModel):
    success: bool = True
    data: list[dict[str, Any]]
    pagination: PaginationOut


class EventDetailOut(BaseModel):
    success: bool = True
    data: dict[str, Any]


class UserListOut(BaseModel):
    success: bool = True
    data: list[dict[str, Any]]
    pagination: PaginationOut


class UserDetailOut(BaseModel):
    success: bool = True
    data: dict[str, Any]


# ---- Downloads (Envato Elements stock-asset downloads) ----
class DownloadListOut(BaseModel):
    success: bool = True
    data: list[dict[str, Any]]
    pagination: PaginationOut


class DownloadDetailOut(BaseModel):
    success: bool = True
    data: dict[str, Any]
