import imaplib
import re
from datetime import datetime
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, EmailStr
from sqlalchemy.orm import Session

from database_config import get_operational_db
from models_new import ITPortalTool, ITPortalToolMailbox, User
from utils.credential_crypto import decrypt_secret, encrypt_secret
from utils.permissions import require_admin


router = APIRouter(prefix="/api/it-tools", tags=["Mailbox Admin"])


class MailboxConfigPayload(BaseModel):
    email_address: EmailStr
    app_password: Optional[str] = None
    otp_sender_filter: Optional[str] = None
    otp_subject_pattern: Optional[str] = None
    otp_regex: str = r"\b(\d{4,8})\b"


class MailboxConfigResponse(BaseModel):
    tool_id: int
    email_address: str
    otp_sender_filter: Optional[str]
    otp_subject_pattern: Optional[str]
    otp_regex: str
    app_password_set: bool
    created_at: Optional[datetime]
    updated_at: Optional[datetime]

    class Config:
        from_attributes = True


class MailboxConnectionTestResponse(BaseModel):
    success: bool
    message: str


def _serialize_mailbox(mailbox: ITPortalToolMailbox) -> MailboxConfigResponse:
    return MailboxConfigResponse(
        tool_id=mailbox.tool_id,
        email_address=mailbox.email_address,
        otp_sender_filter=mailbox.otp_sender_filter,
        otp_subject_pattern=mailbox.otp_subject_pattern,
        otp_regex=mailbox.otp_regex,
        app_password_set=bool(mailbox.app_password_encrypted),
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
    return _serialize_mailbox(mailbox)


@router.post("/{tool_id}/mailbox", response_model=MailboxConfigResponse)
def upsert_mailbox_config(
    tool_id: int,
    payload: MailboxConfigPayload,
    db: Session = Depends(get_operational_db),
    current_user: User = Depends(require_admin),
):
    _get_tool(db, tool_id)
    otp_regex = _validate_regex(payload.otp_regex)

    mailbox = db.query(ITPortalToolMailbox).filter(ITPortalToolMailbox.tool_id == tool_id).first()
    encrypted_password = encrypt_secret(payload.app_password) if payload.app_password is not None else None
    if payload.app_password is not None and not encrypted_password:
        raise HTTPException(status_code=400, detail="App password must not be empty")

    if mailbox is None:
        if not encrypted_password:
            raise HTTPException(status_code=400, detail="App password is required when creating a mailbox config")

        mailbox = ITPortalToolMailbox(
            tool_id=tool_id,
            email_address=payload.email_address,
            app_password_encrypted=encrypted_password,
            otp_sender_filter=(payload.otp_sender_filter or "").strip() or None,
            otp_subject_pattern=(payload.otp_subject_pattern or "").strip() or None,
            otp_regex=otp_regex,
            created_by=current_user.id,
            updated_by=current_user.id,
        )
        db.add(mailbox)
    else:
        mailbox.email_address = payload.email_address
        if encrypted_password:
            mailbox.app_password_encrypted = encrypted_password
        mailbox.otp_sender_filter = (payload.otp_sender_filter or "").strip() or None
        mailbox.otp_subject_pattern = (payload.otp_subject_pattern or "").strip() or None
        mailbox.otp_regex = otp_regex
        mailbox.updated_by = current_user.id
        mailbox.updated_at = datetime.utcnow()

    db.commit()
    db.refresh(mailbox)
    return _serialize_mailbox(mailbox)


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

    app_password = decrypt_secret(mailbox.app_password_encrypted)
    if not app_password:
        return MailboxConnectionTestResponse(success=False, message="Stored app password could not be decrypted")

    try:
        mail = imaplib.IMAP4_SSL("imap.gmail.com", 993)
        mail.login(mailbox.email_address, app_password)
        mail.select("INBOX")
        mail.logout()
        return MailboxConnectionTestResponse(
            success=True,
            message=f"Connected to {mailbox.email_address} successfully.",
        )
    except imaplib.IMAP4.error as exc:
        return MailboxConnectionTestResponse(success=False, message=f"IMAP login failed: {exc}")
    except Exception as exc:
        return MailboxConnectionTestResponse(success=False, message=f"Connection error: {exc}")
