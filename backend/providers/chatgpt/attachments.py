# providers/chatgpt/attachments.py
"""
Best-effort image/file capture for the Capture Center's media viewer.

Deliberately separate from capture.py's lossless event ingestion: an
attachment is a large binary upload, not a tiny JSON event, and losing one
occasionally (a failed R2 upload, an oversized file) is an acceptable
tradeoff rather than something that needs a persistent retry queue - the
extension's own capture (prompt/response text) is unaffected either way.

Reuses the app's existing R2 upload infrastructure (routers/upload.py)
instead of inventing a second storage mechanism.
"""
import base64
import binascii
import time
from typing import Optional
from uuid import uuid4

from sqlalchemy.orm import Session

from models_new import User
from providers.chatgpt.constants import PROVIDER
from providers.chatgpt.models import ConversationCaptureAttachment
from routers.upload import _build_public_url, _build_r2_client, _env, _is_r2_configured, _normalized_content_type

MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024  # 8MB - generous for a chat-uploaded image, small enough for one HTTP POST


class AttachmentCaptureError(Exception):
    def __init__(self, message: str, status_code: int = 400):
        super().__init__(message)
        self.status_code = status_code


def decode_data_url(data_url: str) -> tuple[bytes, Optional[str]]:
    """Parses `data:<mime>;base64,<payload>` - the shape FileReader.readAsDataURL()
    produces in the extension. Raises AttachmentCaptureError for anything else
    (never silently accepts a malformed upload)."""
    if not data_url or not data_url.startswith("data:"):
        raise AttachmentCaptureError("Attachment data must be a data: URL")

    header, _, encoded = data_url.partition(",")
    if not encoded:
        raise AttachmentCaptureError("Attachment data URL is missing its payload")
    if ";base64" not in header:
        raise AttachmentCaptureError("Attachment data URL must be base64-encoded")

    mime_type = header[len("data:"):].split(";")[0].strip() or None

    try:
        raw_bytes = base64.b64decode(encoded, validate=True)
    except (binascii.Error, ValueError) as exc:
        raise AttachmentCaptureError("Attachment data URL is not valid base64") from exc

    if not raw_bytes:
        raise AttachmentCaptureError("Attachment payload is empty")
    if len(raw_bytes) > MAX_ATTACHMENT_BYTES:
        raise AttachmentCaptureError(
            f"Attachment exceeds the {MAX_ATTACHMENT_BYTES // (1024 * 1024)}MB capture limit", status_code=413
        )

    return raw_bytes, mime_type


def _upload_bytes_to_r2(raw_bytes: bytes, *, file_name: str, mime_type: str) -> tuple[str, str]:
    if not _is_r2_configured():
        raise AttachmentCaptureError("File storage is not configured on the server", status_code=503)

    timestamp_ms = int(time.time() * 1000)
    safe_name = (file_name or "attachment").strip().replace("/", "_").replace("\\", "_")[:200] or "attachment"
    key = f"chatgpt-capture/{timestamp_ms}/{uuid4().hex[:8]}_{safe_name}"

    client = _build_r2_client()
    bucket = _env("R2_BUCKET")
    client.put_object(Bucket=bucket, Key=key, Body=raw_bytes, ContentType=mime_type)

    return key, _build_public_url(key)


def store_attachment(
    db: Session,
    *,
    user: User,
    conversation_id: Optional[str],
    client_event_id: Optional[str],
    kind: str,
    file_name: str,
    mime_type: Optional[str],
    data_url: str,
) -> ConversationCaptureAttachment:
    raw_bytes, detected_mime_type = decode_data_url(data_url)
    resolved_mime_type = _normalized_content_type(mime_type or detected_mime_type)

    storage_path, file_url = _upload_bytes_to_r2(raw_bytes, file_name=file_name, mime_type=resolved_mime_type)

    record = ConversationCaptureAttachment(
        provider=PROVIDER,
        provider_conversation_id=conversation_id or None,
        client_event_id=client_event_id or None,
        user_id=user.id,
        kind=kind if kind in ("input", "output") else "input",
        file_name=(file_name or "").strip()[:500] or None,
        mime_type=resolved_mime_type,
        size_bytes=len(raw_bytes),
        file_url=file_url,
        storage_path=storage_path,
    )
    db.add(record)
    db.commit()
    db.refresh(record)
    return record
