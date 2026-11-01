# providers/figma/schemas.py
"""
Pydantic payloads for the Figma provider. The capture batch keeps the field
names every other browser-extension provider sends (event_type,
client_event_id, payload, tickets), so background-figma-capture.js is the same
outbox as the others.
"""
from typing import Any, Optional

from pydantic import BaseModel, Field


class CaptureEventIn(BaseModel):
    """One "prompt" or "balance" event. For a prompt, client_event_id is
    Figma's user_action_uuid; payload is read by capture.py."""

    event_type: str = Field(..., min_length=1, max_length=40)
    client_event_id: str = Field(..., min_length=1, max_length=160)
    payload: dict[str, Any] = Field(default_factory=dict)
    capture_version: Optional[int] = None
    extension_version: Optional[str] = Field(default=None, max_length=40)
    tab_id: Optional[int] = None
    session_id: Optional[str] = Field(default=None, max_length=512)
    credential_id: Optional[int] = None
    linked_task_id: Optional[int] = None
    linked_client_id: Optional[int] = None
    # Identity proof - the dashboard launch that opened the tab, resolved
    # by _resolve_usage_event_actor like every other DIRECT_TICKET_ONLY tool.
    extension_ticket: Optional[str] = Field(default=None, max_length=4000)
    usage_ticket: Optional[str] = Field(default=None, max_length=4000)


class CaptureEventsRequest(BaseModel):
    events: list[CaptureEventIn] = Field(..., min_length=1, max_length=200)


class CaptureEventResult(BaseModel):
    client_event_id: str
    status: str  # "created" | "updated" | "duplicate" | "rejected"
    id: Optional[int] = None
    reason: Optional[str] = None


class CaptureEventsResponse(BaseModel):
    success: bool = True
    results: list[CaptureEventResult]


class ViewOut(BaseModel):
    success: bool = True
    data: dict[str, Any]
