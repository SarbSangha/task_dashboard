# providers/grammarly_docs/schemas.py
"""
Pydantic request/response payloads for the Grammarly Docs provider's API
surface. Mirrors providers/splice/schemas.py's shape, plus session_key/doc_id
(this provider's session-correlation fields - see models.py) which no other
provider needs. No capture-health, asset-mirror, or sync-cursor shapes exist
yet - see CAPTURE_CONTRACT.md's known-gaps section.
"""
from typing import Any, Optional

from pydantic import BaseModel, Field


class CaptureEventIn(BaseModel):
    """One raw capture signal as reported by the extension - a doc_open or
    doc_session_end event, plus routing/identity fields the extension
    already knows. `payload` is opaque to this layer; see
    providers/grammarly_docs/capture.py."""

    event_type: str = Field(..., min_length=1, max_length=40)
    client_event_id: str = Field(..., min_length=1, max_length=160)
    # Correlates a doc_open and its later doc_session_end - generated once
    # by the extension per doc-open, reused unchanged for that session's
    # close event. Required for both event types (see capture.py).
    session_key: Optional[str] = Field(default=None, max_length=160)
    doc_id: Optional[str] = Field(default=None, max_length=160)
    payload: dict[str, Any] = Field(default_factory=dict)
    capture_version: Optional[int] = None
    extension_version: Optional[str] = Field(default=None, max_length=40)
    browser: Optional[str] = Field(default=None, max_length=80)
    tab_id: Optional[int] = None
    session_id: Optional[str] = Field(default=None, max_length=512)
    extension_session_id: Optional[str] = Field(default=None, max_length=160)
    credential_id: Optional[int] = None
    event_date: Optional[str] = None  # ISO date; defaults to today (server time) if omitted

    # Task Mapping / Client Mapping: optional for this provider (opening a
    # doc is not gated the way a download/generation is) - see
    # CAPTURE_CONTRACT.md. Never trusted as-is when present -
    # ingest_capture_event() revalidates server-side.
    linked_task_id: Optional[int] = None
    linked_client_id: Optional[int] = None

    # Identity proof for ownership attribution - same ticket fields every
    # other provider's capture payload sends, resolved the same way by
    # _resolve_usage_event_actor.
    extension_ticket: Optional[str] = Field(default=None, max_length=4000)
    usage_ticket: Optional[str] = Field(default=None, max_length=4000)


class CaptureEventsRequest(BaseModel):
    """Body of POST /api/providers/grammarly-docs/capture/events - always a
    batch."""

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


class SessionListOut(BaseModel):
    success: bool = True
    data: list[dict[str, Any]]
    pagination: PaginationOut


class SessionDetailOut(BaseModel):
    success: bool = True
    data: dict[str, Any]


class EventListOut(BaseModel):
    success: bool = True
    data: list[dict[str, Any]]
    pagination: PaginationOut


class EventDetailOut(BaseModel):
    success: bool = True
    data: dict[str, Any]
