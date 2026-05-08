import imaplib
import re
import uuid
from datetime import datetime
from typing import Optional
from urllib.parse import urlparse

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, EmailStr
from sqlalchemy.orm import Session

from database_config import get_operational_db
from models_new import ITPortalTool, ITPortalToolMailbox, User
from utils.credential_crypto import decrypt_secret, encrypt_secret
from utils.permissions import require_admin


router = APIRouter(prefix="/api/it-tools", tags=["Mailbox Admin"])


class MailboxConfigPayload(BaseModel):
    mailbox_id: Optional[str] = None
    email_address: EmailStr
    app_password: Optional[str] = None
    otp_sender_filter: Optional[str] = None
    otp_subject_pattern: Optional[str] = None
    otp_regex: str = r"\b(\d{4,8})\b"
    auth_link_pattern: Optional[str] = None
    auth_link_host: Optional[str] = None


class MailboxConfigResponse(BaseModel):
    id: str
    tool_id: int
    email_address: str
    otp_sender_filter: Optional[str]
    otp_subject_pattern: Optional[str]
    otp_regex: str
    auth_link_pattern: Optional[str]
    auth_link_host: Optional[str]
    app_password_set: bool
    created_at: Optional[datetime]
    updated_at: Optional[datetime]

    class Config:
        from_attributes = True


class MailboxConfigListResponse(BaseModel):
    success: bool
    mailboxes: list[MailboxConfigResponse]


class MailboxConnectionTestResponse(BaseModel):
    success: bool
    message: str


def _normalize_mailbox_entry(raw_entry: Optional[dict], *, fallback_id: str = "") -> Optional[dict]:
    if not isinstance(raw_entry, dict):
        return None

    email_address = (raw_entry.get("email_address") or "").strip()
    if not email_address:
        return None

    mailbox_id = (raw_entry.get("id") or fallback_id or uuid.uuid4().hex).strip()
    return {
        "id": mailbox_id,
        "email_address": email_address,
        "app_password_encrypted": raw_entry.get("app_password_encrypted"),
        "otp_sender_filter": (raw_entry.get("otp_sender_filter") or "").strip() or None,
        "otp_subject_pattern": (raw_entry.get("otp_subject_pattern") or "").strip() or None,
        "otp_regex": (raw_entry.get("otp_regex") or r"\b(\d{4,8})\b").strip() or r"\b(\d{4,8})\b",
        "auth_link_pattern": (raw_entry.get("auth_link_pattern") or "").strip() or None,
        "auth_link_host": (raw_entry.get("auth_link_host") or "").strip() or None,
    }


def _legacy_mailbox_entry(mailbox: ITPortalToolMailbox) -> Optional[dict]:
    if not (mailbox.email_address or "").strip():
        return None
    return _normalize_mailbox_entry(
        {
            "id": "legacy-primary",
            "email_address": mailbox.email_address,
            "app_password_encrypted": mailbox.app_password_encrypted,
            "otp_sender_filter": mailbox.otp_sender_filter,
            "otp_subject_pattern": mailbox.otp_subject_pattern,
            "otp_regex": mailbox.otp_regex,
            "auth_link_pattern": mailbox.auth_link_pattern,
            "auth_link_host": mailbox.auth_link_host,
        },
        fallback_id="legacy-primary",
    )


def _get_mailbox_entries(mailbox: ITPortalToolMailbox) -> list[dict]:
    stored_entries = mailbox.mailboxes_json if isinstance(mailbox.mailboxes_json, list) else []
    normalized_entries: list[dict] = []

    for raw_entry in stored_entries:
      normalized = _normalize_mailbox_entry(raw_entry)
      if not normalized:
        continue
      normalized_entries.append(normalized)

    legacy_entry = _legacy_mailbox_entry(mailbox)
    if legacy_entry and not any(
        (entry.get("email_address") or "").strip().lower() == legacy_entry["email_address"].lower()
        for entry in normalized_entries
    ):
        normalized_entries.insert(0, legacy_entry)

    return normalized_entries


def _apply_mailbox_entries(
    mailbox: ITPortalToolMailbox,
    entries: list[dict],
    *,
    actor_id: int,
) -> None:
    normalized_entries = [entry for entry in (_normalize_mailbox_entry(item) for item in entries) if entry]
    mailbox.mailboxes_json = normalized_entries

    primary_entry = normalized_entries[0] if normalized_entries else None
    if primary_entry:
        mailbox.email_address = primary_entry["email_address"]
        mailbox.app_password_encrypted = primary_entry["app_password_encrypted"]
        mailbox.otp_sender_filter = primary_entry["otp_sender_filter"]
        mailbox.otp_subject_pattern = primary_entry["otp_subject_pattern"]
        mailbox.otp_regex = primary_entry["otp_regex"]
        mailbox.auth_link_pattern = primary_entry["auth_link_pattern"]
        mailbox.auth_link_host = primary_entry["auth_link_host"]
    mailbox.updated_by = actor_id
    mailbox.updated_at = datetime.utcnow()


def _serialize_mailbox(tool_id: int, mailbox_entry: dict, mailbox: ITPortalToolMailbox) -> MailboxConfigResponse:
    return MailboxConfigResponse(
        id=f"{mailbox_entry.get('id') or ''}",
        tool_id=tool_id,
        email_address=mailbox_entry.get("email_address") or "",
        otp_sender_filter=mailbox_entry.get("otp_sender_filter"),
        otp_subject_pattern=mailbox_entry.get("otp_subject_pattern"),
        otp_regex=mailbox_entry.get("otp_regex") or r"\b(\d{4,8})\b",
        auth_link_pattern=mailbox_entry.get("auth_link_pattern"),
        auth_link_host=mailbox_entry.get("auth_link_host"),
        app_password_set=bool(mailbox_entry.get("app_password_encrypted")),
        created_at=mailbox.created_at,
        updated_at=mailbox.updated_at,
    )


def _get_tool(db: Session, tool_id: int) -> ITPortalTool:
    tool = db.query(ITPortalTool).filter(ITPortalTool.id == tool_id).first()
    if not tool:
        raise HTTPException(status_code=404, detail="Tool not found")
    return tool


def _validate_regex(pattern: str) -> str:
    normalized = (pattern or r"\b(\d{4,8})\b").strip() or r"\b(\d{4,8})\b"
    try:
        compiled = re.compile(normalized)
    except re.error as exc:
        raise HTTPException(status_code=400, detail=f"Invalid OTP regex: {exc}") from exc

    if compiled.groups < 1:
        raise HTTPException(status_code=400, detail="OTP regex must include at least one capture group")
    return normalized


def _validate_optional_regex(pattern: Optional[str], *, label: str) -> Optional[str]:
    normalized = (pattern or "").strip()
    if not normalized:
        return None
    try:
        re.compile(normalized)
    except re.error as exc:
        raise HTTPException(status_code=400, detail=f"Invalid {label}: {exc}") from exc
    return normalized


def _validate_optional_host(value: Optional[str]) -> Optional[str]:
    normalized = (value or "").strip()
    if not normalized:
        return None
    try:
        parsed = urlparse(normalized if "://" in normalized else f"https://{normalized}")
        hostname = (parsed.hostname or "").strip().lower()
    except Exception:
        hostname = normalized.split("/")[0].strip().lower()
    if not hostname:
        raise HTTPException(status_code=400, detail="Auth link host must be a valid hostname")
    return hostname[4:] if hostname.startswith("www.") else hostname


@router.get("/{tool_id}/mailbox", response_model=MailboxConfigResponse)
def get_mailbox_config(
    tool_id: int,
    db: Session = Depends(get_operational_db),
    current_user: User = Depends(require_admin),
):
    _ = current_user
    _get_tool(db, tool_id)
    mailbox = db.query(ITPortalToolMailbox).filter(ITPortalToolMailbox.tool_id == tool_id).first()
    if not mailbox:
        raise HTTPException(status_code=404, detail="No mailbox configured for this tool")
    entries = _get_mailbox_entries(mailbox)
    if not entries:
        raise HTTPException(status_code=404, detail="No mailbox configured for this tool")
    return _serialize_mailbox(tool_id, entries[0], mailbox)


@router.get("/{tool_id}/mailboxes", response_model=MailboxConfigListResponse)
def list_mailbox_configs(
    tool_id: int,
    db: Session = Depends(get_operational_db),
    current_user: User = Depends(require_admin),
):
    _ = current_user
    _get_tool(db, tool_id)
    mailbox = db.query(ITPortalToolMailbox).filter(ITPortalToolMailbox.tool_id == tool_id).first()
    if not mailbox:
        return MailboxConfigListResponse(success=True, mailboxes=[])
    entries = _get_mailbox_entries(mailbox)
    return MailboxConfigListResponse(
        success=True,
        mailboxes=[_serialize_mailbox(tool_id, entry, mailbox) for entry in entries],
    )


@router.post("/{tool_id}/mailbox", response_model=MailboxConfigResponse)
@router.post("/{tool_id}/mailboxes", response_model=MailboxConfigResponse)
def upsert_mailbox_config(
    tool_id: int,
    payload: MailboxConfigPayload,
    db: Session = Depends(get_operational_db),
    current_user: User = Depends(require_admin),
):
    _get_tool(db, tool_id)
    otp_regex = _validate_regex(payload.otp_regex)
    auth_link_pattern = _validate_optional_regex(payload.auth_link_pattern, label="auth link regex")
    auth_link_host = _validate_optional_host(payload.auth_link_host)

    mailbox = db.query(ITPortalToolMailbox).filter(ITPortalToolMailbox.tool_id == tool_id).first()
    encrypted_password = encrypt_secret(payload.app_password) if payload.app_password is not None else None
    if payload.app_password is not None and not encrypted_password:
        raise HTTPException(status_code=400, detail="App password must not be empty")

    mailbox_id = (payload.mailbox_id or "").strip()
    if mailbox is None:
        if not encrypted_password:
            raise HTTPException(status_code=400, detail="App password is required when creating a mailbox config")

        mailbox_entry = _normalize_mailbox_entry(
            {
                "id": mailbox_id or uuid.uuid4().hex,
                "email_address": payload.email_address,
                "app_password_encrypted": encrypted_password,
                "otp_sender_filter": payload.otp_sender_filter,
                "otp_subject_pattern": payload.otp_subject_pattern,
                "otp_regex": otp_regex,
                "auth_link_pattern": auth_link_pattern,
                "auth_link_host": auth_link_host,
            }
        )
        mailbox = ITPortalToolMailbox(
            tool_id=tool_id,
            email_address=mailbox_entry["email_address"],
            app_password_encrypted=mailbox_entry["app_password_encrypted"],
            otp_sender_filter=mailbox_entry["otp_sender_filter"],
            otp_subject_pattern=mailbox_entry["otp_subject_pattern"],
            otp_regex=mailbox_entry["otp_regex"],
            auth_link_pattern=mailbox_entry["auth_link_pattern"],
            auth_link_host=mailbox_entry["auth_link_host"],
            mailboxes_json=[mailbox_entry],
            created_by=current_user.id,
            updated_by=current_user.id,
        )
        db.add(mailbox)
    else:
        entries = _get_mailbox_entries(mailbox)
        target_index = next(
            (
                index for index, entry in enumerate(entries)
                if entry["id"] == mailbox_id
                or entry["email_address"].lower() == payload.email_address.strip().lower()
            ),
            None,
        )
        if target_index is None:
            if not encrypted_password:
                raise HTTPException(status_code=400, detail="App password is required when creating a new mailbox entry")
            entries.append(
                _normalize_mailbox_entry(
                    {
                        "id": mailbox_id or uuid.uuid4().hex,
                        "email_address": payload.email_address,
                        "app_password_encrypted": encrypted_password,
                        "otp_sender_filter": payload.otp_sender_filter,
                        "otp_subject_pattern": payload.otp_subject_pattern,
                        "otp_regex": otp_regex,
                        "auth_link_pattern": auth_link_pattern,
                        "auth_link_host": auth_link_host,
                    }
                )
            )
            target_index = len(entries) - 1
        else:
            current_entry = entries[target_index]
            entries[target_index] = _normalize_mailbox_entry(
                {
                    "id": current_entry["id"],
                    "email_address": payload.email_address,
                    "app_password_encrypted": encrypted_password or current_entry.get("app_password_encrypted"),
                    "otp_sender_filter": payload.otp_sender_filter,
                    "otp_subject_pattern": payload.otp_subject_pattern,
                    "otp_regex": otp_regex,
                    "auth_link_pattern": auth_link_pattern,
                    "auth_link_host": auth_link_host,
                }
            )

        ordered_entries = [entries[target_index], *[entry for idx, entry in enumerate(entries) if idx != target_index]]
        _apply_mailbox_entries(mailbox, ordered_entries, actor_id=current_user.id)

    db.commit()
    db.refresh(mailbox)
    entries = _get_mailbox_entries(mailbox)
    return _serialize_mailbox(tool_id, entries[0], mailbox)


@router.delete("/{tool_id}/mailbox", status_code=204)
def delete_mailbox_config(
    tool_id: int,
    db: Session = Depends(get_operational_db),
    current_user: User = Depends(require_admin),
):
    _ = current_user
    _get_tool(db, tool_id)
    mailbox = db.query(ITPortalToolMailbox).filter(ITPortalToolMailbox.tool_id == tool_id).first()
    if not mailbox:
        raise HTTPException(status_code=404, detail="No mailbox configured for this tool")

    db.delete(mailbox)
    db.commit()


@router.delete("/{tool_id}/mailboxes/{mailbox_id}", status_code=204)
def delete_mailbox_entry(
    tool_id: int,
    mailbox_id: str,
    db: Session = Depends(get_operational_db),
    current_user: User = Depends(require_admin),
):
    _ = current_user
    _get_tool(db, tool_id)
    mailbox = db.query(ITPortalToolMailbox).filter(ITPortalToolMailbox.tool_id == tool_id).first()
    if not mailbox:
        raise HTTPException(status_code=404, detail="No mailbox configured for this tool")

    entries = _get_mailbox_entries(mailbox)
    remaining_entries = [entry for entry in entries if entry["id"] != mailbox_id]
    if len(remaining_entries) == len(entries):
        raise HTTPException(status_code=404, detail="Mailbox entry not found")

    if remaining_entries:
        _apply_mailbox_entries(mailbox, remaining_entries, actor_id=current_user.id)
    else:
        db.delete(mailbox)

    db.commit()


@router.post("/{tool_id}/mailbox/test", response_model=MailboxConnectionTestResponse)
def test_mailbox_connection(
    tool_id: int,
    db: Session = Depends(get_operational_db),
    current_user: User = Depends(require_admin),
):
    _ = current_user
    _get_tool(db, tool_id)
    mailbox = db.query(ITPortalToolMailbox).filter(ITPortalToolMailbox.tool_id == tool_id).first()
    if not mailbox:
        raise HTTPException(status_code=404, detail="No mailbox configured for this tool")
    entries = _get_mailbox_entries(mailbox)
    if not entries:
        raise HTTPException(status_code=404, detail="No mailbox configured for this tool")
    return _test_mailbox_entry(entries[0])


@router.post("/{tool_id}/mailboxes/{mailbox_id}/test", response_model=MailboxConnectionTestResponse)
def test_mailbox_entry_connection(
    tool_id: int,
    mailbox_id: str,
    db: Session = Depends(get_operational_db),
    current_user: User = Depends(require_admin),
):
    _ = current_user
    _get_tool(db, tool_id)
    mailbox = db.query(ITPortalToolMailbox).filter(ITPortalToolMailbox.tool_id == tool_id).first()
    if not mailbox:
        raise HTTPException(status_code=404, detail="No mailbox configured for this tool")
    entry = next((item for item in _get_mailbox_entries(mailbox) if item["id"] == mailbox_id), None)
    if not entry:
        raise HTTPException(status_code=404, detail="Mailbox entry not found")
    return _test_mailbox_entry(entry)


def _test_mailbox_entry(entry: dict) -> MailboxConnectionTestResponse:
    app_password = decrypt_secret(entry.get("app_password_encrypted"))
    if not app_password:
        return MailboxConnectionTestResponse(success=False, message="Stored app password could not be decrypted")

    try:
        mail = imaplib.IMAP4_SSL("imap.gmail.com", 993)
        mail.login(entry["email_address"], app_password)
        mail.select("INBOX")
        mail.logout()
        return MailboxConnectionTestResponse(
            success=True,
            message=f"Connected to {entry['email_address']} successfully.",
        )
    except imaplib.IMAP4.error as exc:
        return MailboxConnectionTestResponse(success=False, message=f"IMAP login failed: {exc}")
    except Exception as exc:
        return MailboxConnectionTestResponse(success=False, message=f"Connection error: {exc}")
