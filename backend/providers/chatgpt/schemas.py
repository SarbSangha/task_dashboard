# providers/chatgpt/schemas.py
"""
Pydantic request/response payloads for the ChatGPT provider's API surface.

Kept separate from models.py (the SQLAlchemy/DB layer) so the API contract
can evolve independently of storage.
"""
from typing import Any, Optional

from pydantic import BaseModel, Field


class CaptureEventIn(BaseModel):
    """One raw capture signal as reported by the extension. Deliberately thin -
    payload_json is opaque to this layer; see providers/chatgpt/capture.py."""

    event_type: str = Field(..., min_length=1, max_length=40)
    client_event_id: str = Field(..., min_length=1, max_length=160)
    conversation_id: Optional[str] = Field(default=None, max_length=160)
    message_id: Optional[str] = Field(default=None, max_length=160)
    payload: dict[str, Any] = Field(default_factory=dict)
    capture_version: Optional[int] = None
    extension_version: Optional[str] = Field(default=None, max_length=40)
    browser: Optional[str] = Field(default=None, max_length=80)
    tab_id: Optional[int] = None
    session_id: Optional[str] = Field(default=None, max_length=512)
    extension_session_id: Optional[str] = Field(default=None, max_length=160)
    credential_id: Optional[int] = None
    event_date: Optional[str] = None  # ISO date; defaults to today (server time) if omitted


class CaptureEventsRequest(BaseModel):
    """Body of POST /api/providers/chatgpt/capture/events - always a batch (1+ events),
    so the extension's retry-queue flush can send everything it has queued in
    one call instead of one HTTP round-trip per event."""

    events: list[CaptureEventIn] = Field(..., min_length=1, max_length=200)


class CaptureEventResult(BaseModel):
    client_event_id: str
    status: str  # "created" | "duplicate" | "rejected"
    id: Optional[int] = None
    reason: Optional[str] = None  # populated when status == "rejected"


class CaptureEventsResponse(BaseModel):
    success: bool = True
    results: list[CaptureEventResult]


class CaptureHealthPingIn(BaseModel):
    """Periodic snapshot of the extension's local retry queue, reported by the background
    worker (not per-event) - see providers/chatgpt/health.py and EXTENSION_CAPTURE_DESIGN.md."""

    extension_session_id: Optional[str] = Field(default=None, max_length=160)
    extension_version: Optional[str] = Field(default=None, max_length=40)
    credential_id: Optional[int] = None
    queue_length: int = 0
    events_waiting: int = 0
    oldest_pending_event_at: Optional[str] = None  # ISO datetime
    retry_count: int = 0
    last_capture_event_at: Optional[str] = None  # extension observed an event, whether uploaded or not
    last_successful_upload_at: Optional[str] = None
    last_failed_upload_at: Optional[str] = None
    average_upload_time_ms: Optional[int] = None
    offline_since: Optional[str] = None


class CaptureHealthOut(BaseModel):
    success: bool = True
    data: dict[str, Any]


class PaginationOut(BaseModel):
    limit: int
    offset: int
    total: int


class CaptureEventListOut(BaseModel):
    success: bool = True
    data: list[dict[str, Any]]
    pagination: PaginationOut


class CaptureEventDetailOut(BaseModel):
    success: bool = True
    data: dict[str, Any]


class ConversationListOut(BaseModel):
    success: bool = True
    data: list[dict[str, Any]]
    pagination: PaginationOut


class ConversationDetailOut(BaseModel):
    success: bool = True
    data: dict[str, Any]


class ConversationMessagesOut(BaseModel):
    success: bool = True
    data: dict[str, Any]


class CaptureAttachmentIn(BaseModel):
    """Body of POST /capture/attachments - a best-effort binary upload, not
    part of the lossless event batch (see providers/chatgpt/attachments.py)."""

    conversation_id: Optional[str] = Field(default=None, max_length=160)
    client_event_id: Optional[str] = Field(default=None, max_length=160)
    kind: str = Field(default="input", max_length=20)
    file_name: str = Field(..., min_length=1, max_length=500)
    mime_type: Optional[str] = Field(default=None, max_length=120)
    data_url: str = Field(..., min_length=1)


class CaptureAttachmentOut(BaseModel):
    success: bool = True
    data: dict[str, Any]


class ConversationAttachmentsOut(BaseModel):
    success: bool = True
    data: list[dict[str, Any]]


class CaptureMetricsOut(BaseModel):
    success: bool = True
    data: dict[str, Any]


class UserListOut(BaseModel):
    success: bool = True
    data: list[dict[str, Any]]
    pagination: PaginationOut


class UserDetailOut(BaseModel):
    success: bool = True
    data: dict[str, Any]
