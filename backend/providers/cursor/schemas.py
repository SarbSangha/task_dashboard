# providers/cursor/schemas.py
"""
Pydantic request/response payloads for the Cursor provider's API surface.
CapturePromptsRequest is what the Cursor extension posts - see
CAPTURE_CONTRACT.md for the exact shape and where each field comes from in
Cursor's local state.vscdb.
"""
from typing import Any, Optional

from pydantic import BaseModel, Field

from providers.cursor.constants import MAX_PROMPTS_PER_BATCH


class CaptureDeviceIn(BaseModel):
    id: Optional[str] = Field(default=None, max_length=160)
    name: Optional[str] = Field(default=None, max_length=160)
    os: Optional[str] = Field(default=None, max_length=40)


class CaptureAccountIn(BaseModel):
    # The Cursor login this computer is signed in to (cursorAuth/cachedEmail).
    email: Optional[str] = Field(default=None, max_length=255)
    plan: Optional[str] = Field(default=None, max_length=40)


class CapturePromptIn(BaseModel):
    id: str = Field(..., min_length=1, max_length=200)  # "<composerId>:<bubbleId>"
    ts: int  # epoch ms the prompt was sent
    endTs: Optional[int] = None  # epoch ms of the last response/step that followed it
    conversationId: Optional[str] = Field(default=None, max_length=160)
    conversationName: Optional[str] = None
    text: Optional[str] = None
    textTruncated: bool = False
    mode: Optional[str] = Field(default=None, max_length=20)
    models: list[str] = Field(default_factory=list)
    inputTokens: int = 0
    outputTokens: int = 0
    responses: int = 0


class CapturePromptsRequest(BaseModel):
    extension_version: Optional[str] = Field(default=None, max_length=40)
    device: CaptureDeviceIn = Field(default_factory=CaptureDeviceIn)
    account: CaptureAccountIn = Field(default_factory=CaptureAccountIn)
    prompts: list[CapturePromptIn] = Field(default_factory=list, max_length=MAX_PROMPTS_PER_BATCH)


class CapturePromptsResponse(BaseModel):
    success: bool = True
    created: int = 0
    updated: int = 0
    skipped: int = 0
    user: dict[str, Any] = Field(default_factory=dict)


class SetupCodeIn(BaseModel):
    user_id: int


class SetupCodeOut(BaseModel):
    success: bool = True
    code: str
    expiresAt: str
    user: dict[str, Any]


class ConnectIn(BaseModel):
    code: str = Field(..., min_length=1, max_length=40)
    extension_version: Optional[str] = Field(default=None, max_length=40)
    device: CaptureDeviceIn


class ConnectOut(BaseModel):
    success: bool = True
    token: str
    user: dict[str, Any]
    # Set when this computer was last connected for someone else: only prompts
    # from this moment on are this person's.
    sendFromMs: Optional[int] = None


class PaginationOut(BaseModel):
    limit: int
    offset: int
    total: int


class PromptListOut(BaseModel):
    success: bool = True
    data: list[dict[str, Any]]
    pagination: PaginationOut


class PromptDetailOut(BaseModel):
    success: bool = True
    data: dict[str, Any]


class SummaryOut(BaseModel):
    success: bool = True
    data: dict[str, Any]


class UsageUploadOut(BaseModel):
    success: bool = True
    data: dict[str, Any]


class ListOut(BaseModel):
    success: bool = True
    data: list[dict[str, Any]]
