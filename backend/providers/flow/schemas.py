# providers/flow/schemas.py
"""
Pydantic request/response payloads for the Flow provider's API surface.
Kept separate from models.py (SQLAlchemy/DB layer) so the wire contract can
evolve independently of storage - mirrors providers/freepik/schemas.py,
trimmed to what this first pass's endpoints (capture/events, generations,
events) actually use - see CAPTURE_CONTRACT.md for the envelope.
"""
from typing import Any, Optional

from pydantic import BaseModel, Field


class CaptureEventIn(BaseModel):
    """One raw capture signal as reported by the extension - the intercepted
    flowWorkflows JSON response, plus routing/identity fields the extension
    already knows. `payload` is opaque to this layer; see
    providers/flow/capture.py."""

    event_type: str = Field(..., min_length=1, max_length=40)
    client_event_id: str = Field(..., min_length=1, max_length=160)
    creation_id: Optional[str] = Field(default=None, max_length=160)
    family_id: Optional[str] = Field(default=None, max_length=160)
    # True only when the extension is walking historical data as part of a
    # reconciliation/backfill sync - never true for a row observed as a
    # natural consequence of the live Generate flow. No reconciliation
    # walker exists for Flow yet, so this is always false in practice today,
    # kept for schema parity with every other provider.
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
    # the user select (see content-flow-task-modal.js). Never trusted as-is
    # - ingest_capture_event() revalidates ownership/active-status server-side.
    linked_task_id: Optional[int] = None

    # Client Mapping: an independent selection from the same gate, validated
    # server-side against GenerationClient.
    linked_client_id: Optional[int] = None

    # Identity proof for ownership attribution - the exact same ticket fields
    # every other DIRECT_TICKET_ONLY_TOOLS provider sends, resolved the same
    # way by _resolve_usage_event_actor.
    extension_ticket: Optional[str] = Field(default=None, max_length=4000)
    usage_ticket: Optional[str] = Field(default=None, max_length=4000)


class CaptureEventsRequest(BaseModel):
    """Body of POST /api/providers/flow/capture/events - always a batch, so a
    queue flush sends everything it has queued in one round trip."""

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


class EventListOut(BaseModel):
    success: bool = True
    data: list[dict[str, Any]]
    pagination: PaginationOut


class EventDetailOut(BaseModel):
    success: bool = True
    data: dict[str, Any]
