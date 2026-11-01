# providers/claude_code/schemas.py
"""
Pydantic payloads for the Claude Code provider. The OTLP receiver reads the
raw body itself (it's Claude Code's OpenTelemetry exporter talking, not our
extension), so only the extension-facing and admin endpoints have models here.
"""
from typing import Any, Optional

from pydantic import BaseModel, Field

from providers.cursor.schemas import CaptureDeviceIn


class ClaudeConnectIn(BaseModel):
    extension_version: Optional[str] = Field(default=None, max_length=40)
    device: CaptureDeviceIn


class ClaudeConnectOut(BaseModel):
    success: bool = True
    token: str
    # Path under the dashboard address to put in OTEL_EXPORTER_OTLP_ENDPOINT.
    otlpPath: str
    user: dict[str, Any]


class ClaudeDisconnectOut(BaseModel):
    success: bool = True
    revoked: int = 0


class ViewOut(BaseModel):
    success: bool = True
    data: dict[str, Any]


class ListOut(BaseModel):
    success: bool = True
    data: list[dict[str, Any]]
