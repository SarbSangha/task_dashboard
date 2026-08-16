# providers/elevenlabs/schemas.py
"""
Pydantic request/response payloads for the ElevenLabs provider's API surface.
Kept separate from models.py (SQLAlchemy/DB layer) so the wire contract can
evolve independently of storage - mirrors providers/flow/schemas.py field-for-
field (provider-agnostic envelope), trimmed to what this first pass's
endpoints (capture/events, generations, events) actually use - see
CAPTURE_CONTRACT.md for the envelope.
"""
from typing import Any, Optional

from pydantic import BaseModel, Field


class CaptureEventIn(BaseModel):
    """One raw capture signal as reported by the extension - the intercepted
    ElevenLabs `history` row JSON, plus routing/identity fields the extension
    already knows. `payload` is opaque to this layer; see
    providers/elevenlabs/capture.py."""

    event_type: str = Field(..., min_length=1, max_length=40)
    client_event_id: str = Field(..., min_length=1, max_length=160)
    creation_id: Optional[str] = Field(default=None, max_length=160)
    family_id: Optional[str] = Field(default=None, max_length=160)
    # True only when the extension is walking historical data as part of a
    # reconciliation/backfill sync (the reconciliation walker described in
    # the plan's Phase 1 - browser extension is out of scope for this
    # backend-only pass, but the field is already part of the envelope every
    # other provider sends).
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
    # the user select. Never trusted as-is - ingest_capture_event()
    # revalidates ownership/active-status server-side.
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
    """Body of POST /api/providers/elevenlabs/capture/events - always a
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


class CaptureAudioIn(BaseModel):
    """One captured audio asset, base64-encoded, pushed directly by the
    extension after it observes ElevenLabs' own authenticated audio response
    in the browser. See CAPTURE_CONTRACT.md's "audio asset delivery" note:
    ElevenLabs' /v1/history/{id}/audio endpoint requires the browser's own
    session/auth (confirmed - an unauthenticated request 401s), which this
    backend has no access to, so a signed-URL pull like Freepik/HeyGen's
    asset_mirror.py sweep can never work here. The browser has to push the
    bytes itself instead."""

    history_item_id: str = Field(..., min_length=1, max_length=160)
    content_type: Optional[str] = Field(default=None, max_length=100)
    audio_base64: str = Field(..., min_length=1)
    # True only for the deterministic Download-button path (request body
    # carried history_item_id) - see content-elevenlabs-network.js's
    # postAudioCapture(). Never set by the proactive-fetch or Play-
    # correlation paths, which aren't real user downloads.
    is_download: bool = False


class CaptureAudioResult(BaseModel):
    success: bool
    # "mirrored" | "already_mirrored" | "generation_not_found" | "not_configured" | "invalid_audio"
    status: str


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
