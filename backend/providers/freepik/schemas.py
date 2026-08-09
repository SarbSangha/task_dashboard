# providers/freepik/schemas.py
"""
Pydantic request/response payloads for the Freepik provider's API surface.
Kept separate from models.py (SQLAlchemy/DB layer) so the wire contract can
evolve independently of storage - see CAPTURE_CONTRACT.md for the envelope
this mirrors.
"""
from typing import Any, Optional

from pydantic import BaseModel, Field


class CaptureEventIn(BaseModel):
    """One raw capture signal as reported by the extension - the intercepted
    Freepik JSON response (or a single row from it), plus routing/identity
    fields the extension already knows. `payload` is opaque to this layer;
    see providers/freepik/capture.py."""

    event_type: str = Field(..., min_length=1, max_length=40)
    client_event_id: str = Field(..., min_length=1, max_length=160)
    creation_id: Optional[str] = Field(default=None, max_length=160)
    family_id: Optional[str] = Field(default=None, max_length=160)
    # True only when the extension is walking historical listing pages as
    # part of a reconciliation/backfill sync (see sync.py) - never true for a
    # row observed as a natural consequence of the live "my creations"
    # response Freepik's own UI fetches right after a submit. This is an
    # explicit signal from the extension, not inferred from timestamps or
    # prompt content (both called out as fragile in the architecture plan) -
    # it is the sole thing that prevents a reconciliation-imported row from
    # ever being attributed to whichever tab happened to run the scan.
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
    # the user select (see content-freepik-task-modal.js). Never trusted as-is
    # - ingest_capture_event() revalidates ownership/active-status server-side
    # and always uses the task's own current title, never a client-supplied
    # name (see utils/task_gate.py).
    linked_task_id: Optional[int] = None

    # Client Mapping: an independent selection from the same gate, validated
    # server-side against GenerationClient (see utils/client_gate.py).
    linked_client_id: Optional[int] = None

    # Identity proof for ownership attribution (Phase 2) - the exact same
    # ticket fields Kling's usage-event payload sends, resolved the same way
    # by _resolve_usage_event_actor. Never a plain X-Session-Id-only flow:
    # Freepik is a DIRECT_TICKET_ONLY_TOOLS entry (often an incognito/popup
    # window), so a ticket is the only reliable proof of "which employee".
    extension_ticket: Optional[str] = Field(default=None, max_length=4000)
    usage_ticket: Optional[str] = Field(default=None, max_length=4000)


class CaptureEventsRequest(BaseModel):
    """Body of POST /api/providers/freepik/capture/events - always a batch,
    so a queue flush sends everything it has queued in one round trip."""

    events: list[CaptureEventIn] = Field(..., min_length=1, max_length=200)


class CaptureEventResult(BaseModel):
    client_event_id: str
    status: str  # "created" | "duplicate" | "rejected"
    id: Optional[int] = None
    generation_id: Optional[int] = None
    reason: Optional[str] = None  # populated when status == "rejected"


class CaptureEventsResponse(BaseModel):
    success: bool = True
    results: list[CaptureEventResult]


class CaptureHealthPingIn(BaseModel):
    """Periodic snapshot of the extension's local retry queue - see
    providers/freepik/health.py."""

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
    """Body of POST /sync/cursor - reported by the extension after walking
    one or more reconciliation pages. is_full_reconciliation marks a run that
    ignored the cursor and walked every page regardless (admin-triggered).

    credential_id is optional: the extension doesn't necessarily know it (it
    only ever gets a ticket, never the resolved credential row) - when
    omitted, the router resolves it the same way capture/events does, from
    the ticket-resolved actor."""

    credential_id: Optional[int] = None
    last_seen_creation_id: Optional[str] = Field(default=None, max_length=160)
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


# Structurally identical to GenerationListOut/EventListOut - kept as their
# own named classes (this codebase's own convention, see EventListOut vs
# GenerationListOut above) rather than reused directly, one pair per entity.
class SearchQueryListOut(BaseModel):
    success: bool = True
    data: list[dict[str, Any]]
    pagination: PaginationOut


class SearchQueryDetailOut(BaseModel):
    success: bool = True
    data: dict[str, Any]


class DownloadListOut(BaseModel):
    success: bool = True
    data: list[dict[str, Any]]
    pagination: PaginationOut


class DownloadDetailOut(BaseModel):
    success: bool = True
    data: dict[str, Any]


class UserListOut(BaseModel):
    success: bool = True
    data: list[dict[str, Any]]
    pagination: PaginationOut


class UserDetailOut(BaseModel):
    success: bool = True
    data: dict[str, Any]
