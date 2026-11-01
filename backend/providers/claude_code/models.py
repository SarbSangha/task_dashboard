# providers/claude_code/models.py - Claude Code prompt + request data model
"""
Three tables:

  ClaudeCodeToken    the credential Claude Code sends (OTEL_EXPORTER_OTLP_HEADERS)
                     for one connected computer. It hangs off that computer's
                     CursorDevice row, so an admin's Disconnect - or connecting
                     the computer for someone else - stops it too. Only its
                     sha256 is stored.

  ClaudeCodePrompt   one row per user_prompt event (a prompt a person typed).
                     Upserts on (owner_user_id, prompt_uid) - prompt_uid is
                     Claude Code's prompt.id, which every event produced while
                     answering that prompt also carries.

  ClaudeCodeRequest  one row per api_request event (one model call), with
                     Claude Code's own tokens and cost_usd. Upserts on
                     (owner_user_id, request_uid), so an OTLP retry never
                     double counts.

Unlike Cursor, nothing is matched by timing: every event already says whose
computer sent it (the token) and which prompt it belongs to (prompt.id).
"""
from datetime import datetime

from sqlalchemy import Column, DateTime, Float, ForeignKey, Index, Integer, String, Text

from database_config import Base
from utils.datetime_utils import serialize_utc_datetime


class ClaudeCodeToken(Base):
    __tablename__ = "claude_code_tokens"

    id = Column(Integer, primary_key=True, index=True)
    cursor_device_row_id = Column(Integer, ForeignKey("cursor_devices.id", ondelete="CASCADE"), nullable=False, index=True)
    user_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    token_hash = Column(String(64), nullable=False, unique=True)
    extension_version = Column(String(40))
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    last_seen_at = Column(DateTime)
    last_account_email = Column(String(255))
    last_terminal_type = Column(String(80))
    last_claude_version = Column(String(40))
    revoked_at = Column(DateTime)

    def to_dict(self):
        return {
            "id": self.id,
            "cursorDeviceRowId": self.cursor_device_row_id,
            "userId": self.user_id,
            "connectedAt": serialize_utc_datetime(self.created_at),
            "lastSeenAt": serialize_utc_datetime(self.last_seen_at),
            "claudeAccountEmail": self.last_account_email,
            "terminalType": self.last_terminal_type,
            "claudeVersion": self.last_claude_version,
            "extensionVersion": self.extension_version,
            "active": self.revoked_at is None,
            "disconnectedAt": serialize_utc_datetime(self.revoked_at),
        }


class ClaudeCodePrompt(Base):
    __tablename__ = "claude_code_prompts"
    __table_args__ = (
        Index("ux_claude_code_prompts_owner_prompt_uid", "owner_user_id", "prompt_uid", unique=True),
        Index("ix_claude_code_prompts_owner_prompted_at", "owner_user_id", "prompted_at"),
    )

    id = Column(Integer, primary_key=True, index=True)
    owner_user_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    token_row_id = Column(Integer, ForeignKey("claude_code_tokens.id", ondelete="SET NULL"), index=True)
    # Claude Code's prompt.id, or "<session.id>:<epoch ms>" on versions without it.
    prompt_uid = Column(String(200), nullable=False)
    session_id = Column(String(160), index=True)
    # Empty when the computer was connected with prompt text turned off.
    prompt_text = Column(Text)
    prompt_length = Column(Integer, nullable=False, default=0)
    command_name = Column(String(120))  # slash command, e.g. "compact"
    terminal_type = Column(String(80))
    account_email = Column(String(255))
    claude_version = Column(String(40))
    prompted_at = Column(DateTime, nullable=False, index=True)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)


class ClaudeCodeRequest(Base):
    __tablename__ = "claude_code_requests"
    __table_args__ = (
        Index("ux_claude_code_requests_owner_request_uid", "owner_user_id", "request_uid", unique=True),
        Index("ix_claude_code_requests_owner_occurred_at", "owner_user_id", "occurred_at"),
    )

    id = Column(Integer, primary_key=True, index=True)
    owner_user_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    token_row_id = Column(Integer, ForeignKey("claude_code_tokens.id", ondelete="SET NULL"), index=True)
    # Anthropic's request id (req_...), or a composite key when it's missing.
    request_uid = Column(String(255), nullable=False)
    prompt_uid = Column(String(200), index=True)
    session_id = Column(String(160), index=True)
    model = Column(String(120))
    # What Claude Code reports, at API list price. Null when it sent none.
    cost_usd = Column(Float)
    input_tokens = Column(Integer, nullable=False, default=0)
    output_tokens = Column(Integer, nullable=False, default=0)
    cache_read_tokens = Column(Integer, nullable=False, default=0)
    cache_write_tokens = Column(Integer, nullable=False, default=0)
    duration_ms = Column(Integer)
    terminal_type = Column(String(80))
    account_email = Column(String(255))
    claude_version = Column(String(40))
    occurred_at = Column(DateTime, nullable=False, index=True)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)
