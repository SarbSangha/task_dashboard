# providers/higgsfield/schemas.py
"""
Pydantic request/response payloads for the Higgsfield provider's API
surface. Kept separate from models.py (SQLAlchemy/DB layer) so the wire
contract can evolve independently of storage - mirrors
providers/heygen/schemas.py.
"""
from typing import Any, Optional

from pydantic import BaseModel, Field


class CaptureEventIn(BaseModel):
    """One raw capture signal as reported by the extension - either a
    DOM-scraped "Generate"/"Edit Video"/"Motion Control" click snapshot, or
    an intercepted Higgsfield network response, plus routing/identity
    fields the extension already knows. `payload` is opaque to this layer;
    see providers/higgsfield/capture.py."""

    event_type: str = Field(..., min_length=1, max_length=40)
    client_event_id: str = Field(..., min_length=1, max_length=160)
    generation_id: Optional[str] = Field(default=None, max_length=160)
    project_id: Optional[str] = Field(default=None, max_length=160)
    # True only when the extension is walking a Higgsfield history/project
    # listing as part of a reconciliation/backfill sync (see sync.py) -
    # never true for a row observed as a natural consequence of a live
    # Generate click or its own network responses.
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
    # the user select (see content-higgsfield-task-modal.js). Never trusted
    # as-is - ingest_capture_event() revalidates ownership/active-status
    # server-side and always uses the task's own current title, never a
    # client-supplied name (see utils/task_gate.py).
    linked_task_id: Optional[int] = None

    # Client Mapping: an independent selection from the same gate, validated
    # server-side against GenerationClient (see utils/client_gate.py).
    linked_client_id: Optional[int] = None

    # Identity proof for ownership attribution - the same ticket fields
    # every other provider's usage-event payloads send, resolved the same
    # way by _resolve_usage_event_actor.
    extension_ticket: Optional[str] = Field(default=None, max_length=4000)
    usage_ticket: Optional[str] = Field(default=None, max_length=4000)


class CaptureEventsRequest(BaseModel):
    """Body of POST /api/providers/higgsfield/capture/events - always a
    batch, so a queue flush sends everything it has queued in one round
    trip."""

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
    providers/higgsfield/health.py."""

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
    one or more reconciliation pages (not wired to a confirmed listing
    endpoint in this pass - see sync.py). credential_id is optional: the
    extension doesn't necessarily know it (it only ever gets a ticket, never
    the resolved credential row) - when omitted, the router resolves it the
    same way capture/events does, from the ticket-resolved actor."""

    credential_id: Optional[int] = None
    last_seen_generation_id: Optional[str] = Field(default=None, max_length=160)
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
