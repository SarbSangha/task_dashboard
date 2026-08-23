# providers/splice/normalization.py
"""
Raw SpliceCaptureEvent -> normalized SpliceDownload, via
_normalize_download_click_event - the only normalization path this provider
has (no Adapt-equivalent second surface, unlike Epidemic Sound - see
constants.py's module docstring). Mirrors
providers/epidemicsound/normalization.py's _normalize_download_click_event
exactly: ALWAYS inserts a new row, no idempotent lookup-by-identity, since a
download is a real user action, not something to dedupe against a prior
download of the same sample.

Payload shape (download_click): the extension (content-splice-network.js
observes the real `POST https://surfaces-graphql.splice.com/graphql`
response's `data.asset.files[]` array, plus the button's own DOM-derived
filename text) sends one flat dict per download click. Per the coordination
contract (CAPTURE_CONTRACT.md), the payload carries at minimum: sourceUrl
(the short-lived signed "source" wav URL), previewMp3Url, assetTitle
(filename string), sourceHost, pageUrl, downloadedAt (ISO timestamp). Read
defensively via multiple candidate key names (this codebase's "candidate
keys" convention, since the extension side is not fully in our control) with
graceful .get() fallbacks - never crash on a missing/renamed key.

sample_hash is NOT sent explicitly by the extension - it is parsed here out
of the source URL's path (see _extract_sample_hash), the closest thing to a
sample identity in this data (no explicit sample id/uuid exists anywhere in
the confirmed response). See CAPTURE_CONTRACT.md for the full confirmed
shape (live capture, 2026-08-19).
"""
import logging
import re
from datetime import datetime, timezone
from typing import Any, Optional

from sqlalchemy.orm import Session

from providers.splice.constants import OWNERSHIP_STATUS_RESOLVED, PROVIDER
from providers.splice.models import SpliceCaptureEvent, SpliceDownload

logger = logging.getLogger("splice_normalization")

# Matches the stable per-sample content hash embedded in an audio_samples/...
# path segment - shared between the preview_mp3 path
# ("audio_samples/{hash}-scrambled/{hash}.mp3") and the source file's URL
# ("https://.../audio_samples/{hash}?X-Amz-..."). The character class stops
# naturally at "-", "/", ".", "?" (none of which are in [0-9a-f]), so this
# single pattern handles the "-scrambled" suffix and any query string without
# needing a separate strip step.
_SAMPLE_HASH_RE = re.compile(r"audio_samples/([0-9a-f]{20,})")


def _s(value: Any, max_length: Optional[int] = None) -> Optional[str]:
    if value is None:
        return None
    text = str(value).strip()
    if not text:
        return None
    return text[:max_length] if max_length else text


def _parse_dt(value: Any) -> Optional[datetime]:
    """Same conversion-to-naive-UTC rule as every other provider's
    normalization.py's _parse_dt - see providers/epidemicsound/normalization.py's
    identical function for the full reasoning."""
    if not value or not isinstance(value, str):
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is not None:
        parsed = parsed.astimezone(timezone.utc).replace(tzinfo=None)
    return parsed


def _extract_sample_hash(source_url: Optional[str]) -> Optional[str]:
    """Parses the stable per-sample hash out of the "source" file's URL path
    - see this module's own docstring and CAPTURE_CONTRACT.md. Deliberately
    defensive: source_url is an unofficial, signed S3 URL whose shape could
    change without notice, so ANY failure here (missing match, unexpected
    shape) falls back to None rather than raising - the raw payload is kept
    in metadata_json regardless, so nothing is ever lost even when this
    parse fails."""
    if not source_url or not isinstance(source_url, str):
        return None
    try:
        match = _SAMPLE_HASH_RE.search(source_url)
        if not match:
            return None
        return match.group(1) or None
    except Exception:
        logger.warning("splice sample_hash parse failed for source_url=%r", source_url, exc_info=True)
        return None


def _normalize_download_click_event(db: Session, event: SpliceCaptureEvent) -> SpliceDownload:
    """A download of an existing sample from Splice's library - see
    SpliceDownload's own docstring. Gated behind the same Task/Client picker
    every other capture-worthy action uses, so linked_task_id/
    linked_client_id are carried in from the capture event exactly like
    EpidemicDownload's own columns of the same name - capture.py has already
    re-validated both against the live task/client tables before this ever
    runs, so they're trusted as-is here.

    No freshness gate (unlike a generation's ownership resolution): a
    download-click capture is generated at the exact moment of the user's
    own action, so event.user_id (already resolved by the same launch-
    ticket system every other capture in this codebase trusts) is always
    trustworthy here - same reasoning as Epidemic Sound's/Envato's
    _normalize_download_click_event."""
    payload = event.payload_json or {}

    # Candidate keys per the coordination contract's primary names, with
    # graceful fallbacks - defensive since the extension side isn't fully in
    # our control (this codebase's standard "candidate keys" convention).
    source_url = _s(payload.get("sourceUrl") or payload.get("source_url") or payload.get("assetSourceUrl"))
    preview_mp3_url = _s(payload.get("previewMp3Url") or payload.get("preview_mp3_url") or payload.get("previewMp3"))
    asset_title = _s(payload.get("assetTitle") or payload.get("asset_title") or payload.get("filename"))
    source_host = _s(payload.get("sourceHost") or payload.get("source_host"), 80)
    page_url = _s(payload.get("pageUrl") or payload.get("page_url"))
    downloaded_at = _parse_dt(payload.get("downloadedAt") or payload.get("downloaded_at")) or event.created_at

    row = SpliceDownload(
        provider=PROVIDER,
        source_capture_event_id=event.id,
        tool_id=event.tool_id,
        credential_id=event.credential_id,
        owner_user_id=event.user_id,
        ownership_status=OWNERSHIP_STATUS_RESOLVED,
        linked_task_id=event.linked_task_id,
        linked_task_name=event.linked_task_name,
        linked_client_id=event.linked_client_id,
        linked_client_name=event.linked_client_name,
        sample_hash=_s(_extract_sample_hash(source_url), 160),
        asset_title=asset_title,
        asset_source_url=source_url,
        preview_mp3_url=preview_mp3_url,
        source_host=source_host,
        page_url=page_url,
        downloaded_at=downloaded_at,
        metadata_json=payload,
    )
    db.add(row)
    db.flush()
    return row


def normalize_capture_event(db: Session, event: SpliceCaptureEvent) -> Optional[SpliceDownload]:
    """Only one event_type exists for this provider (download_click) -
    capture.py already rejects anything not in ALL_EVENT_TYPES, so this is
    a thin single-branch dispatcher kept for structural parity with every
    other provider's normalize_capture_event."""
    return _normalize_download_click_event(db, event)


def normalize_capture_events_batch(db: Session, events: list[SpliceCaptureEvent]) -> dict:
    """Best-effort relative to raw capture - mirrors
    providers/epidemicsound/normalization.py's identical function (per-event
    SAVEPOINT isolation, chunked commit) verbatim."""
    from providers.splice.constants import INGEST_COMMIT_CHUNK_SIZE

    stats = {"normalized": 0, "skipped": 0, "errors": 0}
    if not events:
        return stats
    pending_since_commit = 0
    for event in events:
        savepoint = db.begin_nested()
        try:
            normalized = normalize_capture_event(db, event)
            savepoint.commit()
            stats["normalized" if normalized is not None else "skipped"] += 1
        except Exception:
            savepoint.rollback()
            stats["errors"] += 1
            logger.exception(
                "splice normalization failed for capture_event_id=%s - skipped this cycle",
                event.id,
            )
        pending_since_commit += 1
        if pending_since_commit >= INGEST_COMMIT_CHUNK_SIZE:
            db.commit()
            pending_since_commit = 0
    if pending_since_commit:
        db.commit()
    return stats


def backfill_all(db: Session, *, batch_size: int = 500) -> dict:
    """Replays every historical SpliceCaptureEvent through the same
    idempotent normalizer the live path uses - mirrors
    providers/epidemicsound/normalization.py's identical function."""
    stats = {"processed": 0, "normalized": 0, "skipped": 0, "errors": 0}
    last_id = 0
    while True:
        events = (
            db.query(SpliceCaptureEvent)
            .filter(SpliceCaptureEvent.provider == PROVIDER, SpliceCaptureEvent.id > last_id)
            .order_by(SpliceCaptureEvent.id.asc())
            .limit(batch_size)
            .all()
        )
        if not events:
            break
        last_id = events[-1].id
        stats["processed"] += len(events)
        batch_stats = normalize_capture_events_batch(db, events)
        for key, value in batch_stats.items():
            stats[key] += value
        logger.info(
            "splice backfill progress: processed=%s normalized=%s skipped=%s errors=%s (through capture_event_id=%s)",
            stats["processed"], stats["normalized"], stats["skipped"], stats["errors"], last_id,
        )
    return stats
