# providers/cursor/models.py - Cursor prompt + usage data model
"""
Three tables, deliberately NOT the CaptureEvent -> normalized-row pair every
browser provider uses:

  CursorPrompt       one row per prompt a person typed in Cursor, posted by the
                     Cursor extension (already structured - there is no raw
                     network payload to normalize). Re-posted prompts upsert on
                     (owner_user_id, prompt_uid), since the extension re-sends
                     recent days so late responses/steps get filled in.

  CursorUsageEvent   one row per request in Cursor's own usage CSV export
                     (cursor.com -> Dashboard -> Usage -> Export CSV). Account-
                     wide: Cursor doesn't record which person/computer made a
                     request, so ownership is never stored here - matching.py
                     works it out at read time from the prompts' timing.

  CursorUsageUpload  audit log of each CSV upload.

  CursorSetupCode    one-time code an admin creates for one person; the Cursor
                     extension trades it for that person's tracker token.

  CursorDevice       one computer connected to the tracker: whose prompts it
                     sends, and the hash of the token it was given. The token
                     only works together with that computer's device id, and an
                     admin can disconnect it at any time.

cursor_account_email scopes everything to one Cursor login: a CSV only ever
matches prompts sent from computers signed in to that same account.
"""
from datetime import datetime

from sqlalchemy import (
    Boolean,
    Column,
    DateTime,
    Float,
    ForeignKey,
    Index,
    Integer,
    JSON,
    String,
    Text,
)

from database_config import Base
from utils.datetime_utils import serialize_utc_datetime


class CursorPrompt(Base):
    __tablename__ = "cursor_prompts"
    __table_args__ = (
        Index("ux_cursor_prompts_owner_prompt_uid", "owner_user_id", "prompt_uid", unique=True),
        Index("ix_cursor_prompts_account_prompted_at", "cursor_account_email", "prompted_at"),
    )

    id = Column(Integer, primary_key=True, index=True)
    provider = Column(String(40), nullable=False, default="cursor", index=True)
    tool_id = Column(Integer, ForeignKey("it_portal_tools.id"), index=True)
    owner_user_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)

    # "<composerId>:<bubbleId>" from Cursor's local state.vscdb - stable per prompt.
    prompt_uid = Column(String(200), nullable=False)
    # Cursor login the computer was signed in to ("" when the extension couldn't read it).
    cursor_account_email = Column(String(255), nullable=False, default="")
    cursor_plan = Column(String(40))

    device_id = Column(String(160))
    device_name = Column(String(160))
    device_os = Column(String(40))
    extension_version = Column(String(40))

    conversation_id = Column(String(160), index=True)
    conversation_name = Column(Text)
    prompt_text = Column(Text)
    text_truncated = Column(Boolean, nullable=False, default=False)
    mode = Column(String(20))  # "agent" | "ask" | None
    models_json = Column(JSON)
    # AI responses/tool steps that followed the prompt in the local history.
    steps = Column(Integer, nullable=False, default=0)
    # Cursor 3 writes 0 here; kept for older Cursor versions that still record them.
    local_input_tokens = Column(Integer, nullable=False, default=0)
    local_output_tokens = Column(Integer, nullable=False, default=0)

    prompted_at = Column(DateTime, nullable=False, index=True)
    completed_at = Column(DateTime)

    created_at = Column(DateTime, default=datetime.utcnow, nullable=False, index=True)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, nullable=False)

    def to_dict(self):
        return {
            "id": self.id,
            "provider": self.provider,
            "ownerUserId": self.owner_user_id,
            "promptUid": self.prompt_uid,
            "cursorAccountEmail": self.cursor_account_email or None,
            "cursorPlan": self.cursor_plan,
            "deviceName": self.device_name,
            "deviceOs": self.device_os,
            "extensionVersion": self.extension_version,
            "conversationId": self.conversation_id,
            "conversationName": self.conversation_name,
            "promptText": self.prompt_text,
            "textTruncated": bool(self.text_truncated),
            "mode": self.mode,
            "localModels": self.models_json or [],
            "steps": self.steps or 0,
            "promptedAt": serialize_utc_datetime(self.prompted_at),
            "completedAt": serialize_utc_datetime(self.completed_at),
            "createdAt": serialize_utc_datetime(self.created_at),
        }


class CursorUsageUpload(Base):
    __tablename__ = "cursor_usage_uploads"

    id = Column(Integer, primary_key=True, index=True)
    uploaded_by_user_id = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), index=True)
    cursor_account_email = Column(String(255), nullable=False, default="", index=True)
    file_name = Column(String(255))
    row_count = Column(Integer, nullable=False, default=0)
    added_count = Column(Integer, nullable=False, default=0)
    skipped_count = Column(Integer, nullable=False, default=0)
    range_start = Column(DateTime)
    range_end = Column(DateTime)
    columns_json = Column(JSON)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False, index=True)

    def to_dict(self):
        return {
            "id": self.id,
            "uploadedByUserId": self.uploaded_by_user_id,
            "cursorAccountEmail": self.cursor_account_email or None,
            "fileName": self.file_name,
            "rowCount": self.row_count,
            "addedCount": self.added_count,
            "skippedCount": self.skipped_count,
            "rangeStart": serialize_utc_datetime(self.range_start),
            "rangeEnd": serialize_utc_datetime(self.range_end),
            "columns": self.columns_json or {},
            "createdAt": serialize_utc_datetime(self.created_at),
        }


class CursorUsageEvent(Base):
    __tablename__ = "cursor_usage_events"
    __table_args__ = (
        # Re-uploading the same or an overlapping export never double counts.
        Index("ux_cursor_usage_events_account_uid", "cursor_account_email", "event_uid", unique=True),
        Index("ix_cursor_usage_events_account_occurred_at", "cursor_account_email", "occurred_at"),
    )

    id = Column(Integer, primary_key=True, index=True)
    provider = Column(String(40), nullable=False, default="cursor", index=True)
    tool_id = Column(Integer, ForeignKey("it_portal_tools.id"), index=True)
    cursor_account_email = Column(String(255), nullable=False, default="")
    # "<epoch ms>:<model>:<input>:<output>:<cache read>" - Cursor's export has no request id.
    event_uid = Column(String(255), nullable=False)
    source_upload_id = Column(Integer, ForeignKey("cursor_usage_uploads.id", ondelete="SET NULL"), index=True)

    occurred_at = Column(DateTime, nullable=False, index=True)
    model = Column(String(120))
    kind = Column(String(60))
    max_mode = Column(Boolean, nullable=False, default=False)
    input_tokens = Column(Integer, nullable=False, default=0)
    output_tokens = Column(Integer, nullable=False, default=0)
    cache_read_tokens = Column(Integer, nullable=False, default=0)
    cache_write_tokens = Column(Integer, nullable=False, default=0)
    # Null when the export says "Included"/blank instead of an amount.
    cost_cents = Column(Float)
    cloud_agent_id = Column(String(160))
    automation_id = Column(String(160))

    created_at = Column(DateTime, default=datetime.utcnow, nullable=False, index=True)


class CursorSetupCode(Base):
    __tablename__ = "cursor_setup_codes"

    id = Column(Integer, primary_key=True, index=True)
    # sha256 of the normalized code - the code itself is only ever shown once.
    code_hash = Column(String(64), nullable=False, unique=True)
    user_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    created_by_user_id = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"))
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    expires_at = Column(DateTime, nullable=False)
    used_at = Column(DateTime)
    used_by_device_row_id = Column(Integer)


class CursorDevice(Base):
    __tablename__ = "cursor_devices"
    __table_args__ = (
        Index("ix_cursor_devices_device_id", "device_id"),
    )

    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    # Cursor's machine id for that installation (vscode.env.machineId).
    device_id = Column(String(160), nullable=False)
    device_name = Column(String(160))
    device_os = Column(String(40))
    # sha256 of the tracker token - the token itself is never stored.
    token_hash = Column(String(64), nullable=False, unique=True)
    created_by_user_id = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"))
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    last_seen_at = Column(DateTime)
    last_account_email = Column(String(255))
    extension_version = Column(String(40))
    revoked_at = Column(DateTime)
    revoked_by_user_id = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"))

    def to_dict(self):
        return {
            "id": self.id,
            "userId": self.user_id,
            "deviceName": self.device_name,
            "deviceOs": self.device_os,
            "connectedAt": serialize_utc_datetime(self.created_at),
            "lastSeenAt": serialize_utc_datetime(self.last_seen_at),
            "cursorAccountEmail": self.last_account_email,
            "extensionVersion": self.extension_version,
            "active": self.revoked_at is None,
            "disconnectedAt": serialize_utc_datetime(self.revoked_at),
        }
