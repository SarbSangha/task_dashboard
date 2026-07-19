# providers/chatgpt/media.py
"""
Media asset capture (additive, Phase 1/2/7 of the media capture plan).

Deliberately separate from capture.py's lossless raw-event ingestion, same
reasoning attachments.py already established for binary uploads: a media
asset is a large binary payload, not a tiny JSON event, so it goes straight
to POST /capture/media -> ConversationMediaAsset, not through the
ConversationCaptureEvent queue. Also deliberately separate from
attachments.py itself (not a new `kind` value on ConversationCaptureAttachment)
- that table is scoped to the Capture Center's media *viewer* for real,
uploaded-file bytes; ConversationMediaAsset is the structured, queryable
model for the media *content-block* layer (generated/response images and
videos), with the richer fields (width/height/duration/prompt/alt text/
display order/status) that layer actually needs.

Reuses the app's existing R2 upload infrastructure (routers/upload.py),
the same helpers attachments.py already imports - no second storage
mechanism invented here.

Text capture (capture.py, the SSE/patch reconstruction, normalization.py)
is untouched by this module and does not import from it.
"""
import base64
import binascii
import time
import urllib.request
from typing import Optional
from urllib.parse import urlparse
from uuid import uuid4

from sqlalchemy.orm import Session

from models_new import User
from providers.chatgpt.constants import (
    ENRICHMENT_STATUS_ENRICHED,
    ENRICHMENT_STATUS_PENDING,
    MEDIA_STATUS_FAILED,
    MEDIA_STATUS_PENDING,
    MEDIA_STATUS_STORED,
    MEDIA_TYPES,
    PROVIDER,
)
from providers.chatgpt.models import ConversationMediaAsset, ConversationRecord
from routers.upload import _build_public_url, _build_r2_client, _env, _is_r2_configured, _normalized_content_type

# Generous enough for high-resolution generated images; video capture
# (deferred - see plan) will need a much higher ceiling when that phase
# lands, revisited then rather than guessed at now.
MAX_MEDIA_BYTES = 25 * 1024 * 1024

# Hosts the SERVER is allowed to fetch a media asset from when the extension
# could not obtain the bytes itself (the images.openai.com CDN is
# cross-origin to chatgpt.com, so a browser fetch() cannot read its bytes -
# CORS - even though the <img> renders fine; the server has no such
# restriction). This is an explicit allowlist, NOT "fetch whatever URL the
# client sent" - that would be an SSRF hole (a malicious source_url could
# point the server at an internal address). Only these confirmed public
# ChatGPT media CDNs are ever fetched server-side. The estuary endpoint is
# deliberately NOT here: it lives on chatgpt.com and needs the user's
# session cookies, which the server doesn't have - that one is (and must
# stay) the extension's job, where it's same-origin and already works.
SERVER_FETCHABLE_MEDIA_HOSTS = frozenset({
    "images.openai.com",
    "files.oaiusercontent.com",
})
REMOTE_FETCH_TIMEOUT_SECONDS = 15


class MediaCaptureError(Exception):
    def __init__(self, message: str, status_code: int = 400):
        super().__init__(message)
        self.status_code = status_code


def _host_is_server_fetchable(url: Optional[str]) -> bool:
    if not url:
        return False
    try:
        parsed = urlparse(url)
    except ValueError:
        return False
    if parsed.scheme != "https":  # never fetch http/file/ftp/etc server-side
        return False
    return parsed.hostname in SERVER_FETCHABLE_MEDIA_HOSTS


def fetch_remote_media_bytes(source_url: str) -> Optional[tuple[bytes, Optional[str]]]:
    """Best-effort server-side fetch of a media asset the browser couldn't
    read (cross-origin CDN). SSRF-guarded: only the hosts in
    SERVER_FETCHABLE_MEDIA_HOSTS are ever contacted, https only. Returns
    (bytes, content_type) on success, or None on any failure (never raises
    out - a failed fetch just leaves the row at status=pending, exactly as
    before this fetch existed)."""
    if not _host_is_server_fetchable(source_url):
        return None
    try:
        request = urllib.request.Request(source_url, headers={"User-Agent": "Mozilla/5.0 (RMW media capture)"})
        with urllib.request.urlopen(request, timeout=REMOTE_FETCH_TIMEOUT_SECONDS) as response:
            if getattr(response, "status", 200) != 200:
                return None
            # Read one byte past the cap so an over-limit asset is detected
            # and rejected rather than silently truncated.
            raw_bytes = response.read(MAX_MEDIA_BYTES + 1)
            if not raw_bytes or len(raw_bytes) > MAX_MEDIA_BYTES:
                return None
            content_type = response.headers.get("Content-Type")
            return raw_bytes, content_type
    except Exception:
        return None


def decode_data_url(data_url: str) -> tuple[bytes, Optional[str]]:
    """Parses `data:<mime>;base64,<payload>` - same shape/validation as
    attachments.py's decode_data_url, duplicated rather than imported so this
    module has zero import-time coupling to the attachment-upload path."""
    if not data_url or not data_url.startswith("data:"):
        raise MediaCaptureError("Media data must be a data: URL")

    header, _, encoded = data_url.partition(",")
    if not encoded:
        raise MediaCaptureError("Media data URL is missing its payload")
    if ";base64" not in header:
        raise MediaCaptureError("Media data URL must be base64-encoded")

    mime_type = header[len("data:"):].split(";")[0].strip() or None

    try:
        raw_bytes = base64.b64decode(encoded, validate=True)
    except (binascii.Error, ValueError) as exc:
        raise MediaCaptureError("Media data URL is not valid base64") from exc

    if not raw_bytes:
        raise MediaCaptureError("Media payload is empty")
    if len(raw_bytes) > MAX_MEDIA_BYTES:
        raise MediaCaptureError(
            f"Media exceeds the {MAX_MEDIA_BYTES // (1024 * 1024)}MB capture limit", status_code=413
        )

    return raw_bytes, mime_type


def _upload_bytes_to_r2(raw_bytes: bytes, *, file_name: str, mime_type: str) -> tuple[str, str]:
    if not _is_r2_configured():
        raise MediaCaptureError("File storage is not configured on the server", status_code=503)

    timestamp_ms = int(time.time() * 1000)
    safe_name = (file_name or "media").strip().replace("/", "_").replace("\\", "_")[:200] or "media"
    key = f"chatgpt-media/{timestamp_ms}/{uuid4().hex[:8]}_{safe_name}"

    client = _build_r2_client()
    bucket = _env("R2_BUCKET")
    client.put_object(Bucket=bucket, Key=key, Body=raw_bytes, ContentType=mime_type)

    return key, _build_public_url(key)


def _resolve_conversation_record_id(db: Session, provider_conversation_id: Optional[str]) -> Optional[int]:
    """Best-effort link to the normalized ConversationRecord, when one
    already exists (created by normalization.py off the text-capture path).
    Media capture never creates a ConversationRecord itself - if none exists
    yet, the row is still stored with provider_conversation_id populated
    (queryable on its own), just without the internal FK, rather than
    blocking on or reaching into the text-capture/normalization pipeline."""
    if not provider_conversation_id:
        return None
    record = (
        db.query(ConversationRecord)
        .filter(ConversationRecord.provider == PROVIDER, ConversationRecord.provider_conversation_id == provider_conversation_id)
        .first()
    )
    return record.id if record else None


def _find_existing_by_asset_id(db: Session, provider_asset_id: Optional[str]) -> Optional[ConversationMediaAsset]:
    if not provider_asset_id:
        return None
    return (
        db.query(ConversationMediaAsset)
        .filter(ConversationMediaAsset.provider == PROVIDER, ConversationMediaAsset.provider_asset_id == provider_asset_id)
        .first()
    )


def _find_existing_unenriched_by_position(
    db: Session,
    provider_conversation_id: Optional[str],
    message_id: Optional[str],
    display_order: Optional[int],
) -> Optional[ConversationMediaAsset]:
    """Matches a row that DOM/network capture already created for this
    message slot (no provider_asset_id yet, since DOM discovery never has
    one) so a later authoritative-fetch enrichment call adopts that same row
    instead of creating a duplicate for the same visual asset. Only matches
    rows that aren't already enriched - a slot that was already enriched by
    an earlier call is left alone even if position collides (e.g. a message
    regenerated with a different image at the same index)."""
    if not provider_conversation_id or not message_id or display_order is None:
        return None
    return (
        db.query(ConversationMediaAsset)
        .filter(
            ConversationMediaAsset.provider == PROVIDER,
            ConversationMediaAsset.provider_conversation_id == provider_conversation_id,
            ConversationMediaAsset.message_id == message_id,
            ConversationMediaAsset.display_order == display_order,
            ConversationMediaAsset.provider_asset_id.is_(None),
        )
        .order_by(ConversationMediaAsset.created_at.desc())
        .first()
    )


def store_media_asset(
    db: Session,
    *,
    user: User,
    provider_conversation_id: Optional[str],
    message_id: Optional[str],
    assistant_message_id: Optional[str],
    correlation_id: Optional[str],
    media_type: str,
    generated: bool,
    data_url: Optional[str],
    source_url: Optional[str],
    thumbnail_url: Optional[str],
    file_name: Optional[str],
    mime_type: Optional[str],
    width: Optional[int],
    height: Optional[int],
    duration_ms: Optional[int],
    provider_asset_id: Optional[str],
    prompt: Optional[str],
    alt_text: Optional[str],
    source: Optional[str],
    display_order: Optional[int],
    metadata: Optional[dict] = None,
) -> ConversationMediaAsset:
    """Idempotent on (provider, provider_asset_id) when an asset id is known
    - a retried/duplicate capture updates the same row instead of creating a
    second one, mirroring the exact pattern already proven for
    ConversationGeneratedAsset in normalization.py.

    When no provider_asset_id is known yet (a DOM/network-discovered asset,
    captured before - or entirely without - a successful authoritative
    fetch), dedup instead falls back to (provider_conversation_id,
    message_id, display_order): a later call that DOES carry a
    provider_asset_id (the authoritative-fetch enrichment step) adopts that
    same row rather than creating a duplicate for the same visual asset. See
    ENRICHMENT_STATUS_* in constants.py - this is what makes media capture
    resilient to the authoritative fetch being slow, flaky, or entirely
    down: the asset is already STORED before enrichment is ever attempted."""
    if media_type not in MEDIA_TYPES:
        raise MediaCaptureError(f"Unknown media_type: {media_type!r}")

    asset = _find_existing_by_asset_id(db, provider_asset_id)
    if asset is None and provider_asset_id:
        asset = _find_existing_unenriched_by_position(db, provider_conversation_id, message_id, display_order)
    is_new = asset is None
    if asset is None:
        asset = ConversationMediaAsset(
            provider=PROVIDER,
            provider_conversation_id=provider_conversation_id or None,
            provider_asset_id=provider_asset_id or None,
            media_type=media_type,
            user_id=user.id,
            enrichment_status=ENRICHMENT_STATUS_ENRICHED if provider_asset_id else ENRICHMENT_STATUS_PENDING,
        )

    asset.provider_asset_id = provider_asset_id or asset.provider_asset_id
    if provider_asset_id:
        asset.enrichment_status = ENRICHMENT_STATUS_ENRICHED
    asset.conversation_id = _resolve_conversation_record_id(db, provider_conversation_id) or asset.conversation_id
    asset.provider_conversation_id = provider_conversation_id or asset.provider_conversation_id
    asset.message_id = message_id or asset.message_id
    asset.assistant_message_id = assistant_message_id or asset.assistant_message_id
    asset.correlation_id = correlation_id or asset.correlation_id
    asset.media_type = media_type
    asset.generated = bool(generated)
    asset.source_url = source_url or asset.source_url
    asset.thumbnail_url = thumbnail_url or asset.thumbnail_url
    asset.width = width if width is not None else asset.width
    asset.height = height if height is not None else asset.height
    asset.duration_ms = duration_ms if duration_ms is not None else asset.duration_ms
    asset.prompt = prompt or asset.prompt
    asset.alt_text = alt_text or asset.alt_text
    asset.source = source or asset.source
    asset.display_order = display_order if display_order is not None else asset.display_order
    asset.metadata_json = metadata or asset.metadata_json

    if data_url:
        raw_bytes, detected_mime_type = decode_data_url(data_url)
        resolved_mime_type = _normalized_content_type(mime_type or detected_mime_type)
        _storage_path, file_url = _upload_bytes_to_r2(raw_bytes, file_name=file_name or media_type, mime_type=resolved_mime_type)
        asset.url = file_url
        asset.mime_type = resolved_mime_type
        asset.status = MEDIA_STATUS_STORED
    elif asset.status != MEDIA_STATUS_STORED and _host_is_server_fetchable(source_url) and _is_r2_configured():
        # The browser couldn't read this asset's bytes (images.openai.com is
        # cross-origin to chatgpt.com -> CORS blocks fetch(), even though the
        # <img> renders) so the extension only sent us the source_url. The
        # server has no CORS restriction, so fetch it here and upload to R2.
        # Best-effort: any failure falls through to the PENDING path below,
        # never raises - a missing image must never fail the whole capture.
        fetched = None
        try:
            fetched = fetch_remote_media_bytes(source_url)
        except Exception:
            fetched = None
        if fetched is not None:
            raw_bytes, fetched_content_type = fetched
            resolved_mime_type = _normalized_content_type(mime_type or fetched_content_type)
            try:
                _storage_path, file_url = _upload_bytes_to_r2(raw_bytes, file_name=file_name or media_type, mime_type=resolved_mime_type)
                asset.url = file_url
                asset.mime_type = resolved_mime_type
                asset.status = MEDIA_STATUS_STORED
            except Exception:
                asset.mime_type = mime_type or asset.mime_type
                asset.status = MEDIA_STATUS_PENDING
        else:
            asset.mime_type = mime_type or asset.mime_type
            asset.status = MEDIA_STATUS_PENDING
    elif asset.status != MEDIA_STATUS_STORED:
        # No bytes this call (e.g. a metadata-only response_image reference,
        # or a resolve/upload failure the caller already handled). Never
        # downgrade a row that's already STORED. Otherwise: PENDING if we at
        # least have a source URL to work with (or retry) later, FAILED if
        # we have nothing at all - either way the event is recorded, not
        # dropped.
        asset.mime_type = mime_type or asset.mime_type
        asset.status = MEDIA_STATUS_PENDING if source_url else MEDIA_STATUS_FAILED

    if is_new:
        db.add(asset)
    db.commit()
    db.refresh(asset)
    return asset
