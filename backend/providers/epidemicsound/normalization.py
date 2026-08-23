# providers/epidemicsound/normalization.py
"""
Raw EpidemicCaptureEvent -> normalized EpidemicDownload OR EpidemicAdaptation,
dispatched by event_type. Two entirely different normalization strategies
live in this one file:

  download_click       -> _normalize_download_click_event
                           (mirrors providers/envato/normalization.py's
                           identical function - ALWAYS inserts a new row, no
                           idempotent lookup-by-identity, since a download is
                           a real, individually-quota-consuming action, not
                           something to dedupe against a prior download of
                           the same track - same reasoning as
                           EnvatoDownload's own docstring)

  adaptation_version    -> _normalize_adaptation_version_event
                           (mirrors providers/elevenlabs/normalization.py's
                           normalize_capture_event UPSERT-by-identity
                           pattern - _find_existing_generation's equivalent
                           here is _find_existing_adaptation, keyed on
                           version_id - because a version's status genuinely
                           changes over time, draft -> pending -> completed,
                           and a LATER capture of the SAME identity must
                           UPDATE the existing row, never insert a duplicate)

Payload shape (download_click): the extension (content-epidemicsound-
network.js observes the real `GET /download/?...` request URL and its JSON
response body) sends one flat dict per download click - the request URL's
query params (downloadId/sound_id/is_sfx/qualityType/stemType) plus the
response body's assetUrl/remainingDownloads, all folded into one
payload_json. See CAPTURE_CONTRACT.md for the confirmed real shape (live
DevTools capture, 2026-08-18).

Payload shape (adaptation_version): one Adapt "version" object per event -
either the compose/finalize response body directly, or one entry from the
GET .../versions listing's `data[]` array - plus two fields the extension
adds itself since they aren't present in the response body at all:
payload.sessionId (parsed from the request URL path) and
payload.originalTrackTitle (DOM-scraped, optional). See CAPTURE_CONTRACT.md
for the full confirmed shapes (live DevTools capture, 2026-08-19).
"""
import logging
import re
from datetime import datetime, timezone
from typing import Any, Optional
from urllib.parse import parse_qs, urlparse

from sqlalchemy.orm import Session

from providers.epidemicsound.constants import (
    ADAPTATION_CREDITS_FLAT_RATE,
    ADAPTATION_STATUS_COMPLETED,
    EVENT_TYPE_ADAPTATION_VERSION,
    OWNERSHIP_STATUS_RESOLVED,
    PROVIDER,
)
from providers.epidemicsound.models import EpidemicAdaptation, EpidemicCaptureEvent, EpidemicDownload

logger = logging.getLogger("epidemicsound_normalization")

_TITLE_SUFFIX = " - epidemic sound"
_TITLE_PREFIX = "es_"


def _s(value: Any, max_length: Optional[int] = None) -> Optional[str]:
    if value is None:
        return None
    text = str(value).strip()
    if not text:
        return None
    return text[:max_length] if max_length else text


def _i(value: Any) -> Optional[int]:
    try:
        return int(value) if value is not None else None
    except (TypeError, ValueError):
        return None


def _b(value: Any) -> Optional[bool]:
    if value is None:
        return None
    if isinstance(value, str):
        return value.strip().lower() in ("true", "1", "yes")
    return bool(value)


def _parse_dt(value: Any) -> Optional[datetime]:
    """Same conversion-to-naive-UTC rule as every other provider's
    normalization.py's _parse_dt - see providers/envato/normalization.py's
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


def _parse_asset_title(asset_url: Optional[str]) -> Optional[str]:
    """A real, human-readable title is embedded in the response's assetUrl
    via its response-content-disposition query param - e.g.
    filename="ES_Swooshes, Whoosh, Mids - Epidemic Sound.mp3" - confirmed
    real, 2026-08-18 (see CAPTURE_CONTRACT.md). URL-decodes the param, strips
    the .mp3 extension, strips a leading "ES_" prefix if present, and strips
    a trailing " - Epidemic Sound" suffix if present, yielding e.g.
    "Swooshes, Whoosh, Mids".

    Deliberately defensive end-to-end: assetUrl is an unofficial, signed CDN
    URL whose query-param shape could change without notice, so ANY failure
    here (missing param, unexpected shape, malformed URL) falls back to None
    rather than raising - the raw payload is kept in metadata_json
    regardless, so nothing is ever lost even when this parse fails."""
    if not asset_url or not isinstance(asset_url, str):
        return None
    try:
        parsed_url = urlparse(asset_url)
        query = parse_qs(parsed_url.query)
        disposition_values = query.get("response-content-disposition")
        if not disposition_values:
            return None
        disposition = disposition_values[0]
        match = re.search(r'filename="?([^";]+)"?', disposition)
        if not match:
            return None
        filename = match.group(1).strip()
        if not filename:
            return None
        if filename.lower().endswith(".mp3"):
            filename = filename[: -len(".mp3")]
        if filename.lower().startswith(_TITLE_PREFIX):
            filename = filename[len(_TITLE_PREFIX):]
        if filename.lower().endswith(_TITLE_SUFFIX):
            filename = filename[: -len(_TITLE_SUFFIX)]
        filename = filename.strip()
        return filename or None
    except Exception:
        logger.warning("epidemicsound asset title parse failed for assetUrl=%r", asset_url, exc_info=True)
        return None


def _normalize_download_click_event(db: Session, event: EpidemicCaptureEvent) -> EpidemicDownload:
    """A download of an existing stock music/sound-effect track - see
    EpidemicDownload's own docstring. Gated behind the same Task/Client
    picker every other capture-worthy action uses, so linked_task_id/
    linked_client_id are carried in from the capture event exactly like
    EnvatoDownload's own columns of the same name - capture.py has already
    re-validated both against the live task/client tables before this ever
    runs, so they're trusted as-is here.

    No freshness gate (unlike a generation's ownership resolution): a
    download-click capture is generated at the exact moment of the user's
    own action, so event.user_id (already resolved by the same launch-
    ticket system every other capture in this codebase trusts) is always
    trustworthy here - same reasoning as Envato's
    _normalize_download_click_event."""
    payload = event.payload_json or {}
    asset_url = _s(payload.get("assetUrl"))
    row = EpidemicDownload(
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
        download_id=_s(event.provider_download_id or payload.get("downloadId"), 160),
        sound_id=_s(payload.get("sound_id") or payload.get("soundId"), 160),
        is_sfx=_b(payload.get("is_sfx") if payload.get("is_sfx") is not None else payload.get("isSfx")),
        quality_type=_s(payload.get("qualityType"), 40),
        stem_type=_s(payload.get("stemType"), 40),
        remaining_downloads=_i(payload.get("remainingDownloads")),
        asset_title=_parse_asset_title(asset_url),
        asset_source_url=asset_url,
        source_host=_s(payload.get("sourceHost"), 80),
        page_url=_s(payload.get("pageUrl")),
        downloaded_at=_parse_dt(payload.get("downloadedAt")) or event.created_at,
        metadata_json=payload,
    )
    db.add(row)
    db.flush()
    return row


def _find_existing_adaptation(db: Session, *, version_id: Optional[str]) -> Optional[EpidemicAdaptation]:
    if not version_id:
        return None
    return (
        db.query(EpidemicAdaptation)
        .filter(EpidemicAdaptation.provider == PROVIDER, EpidemicAdaptation.version_id == version_id)
        .first()
    )


def _extract_adaptation_prompt(payload: dict) -> Optional[str]:
    """Two different shapes for where the prompt lives, depending on which
    internal variant a version has - tries both, defensively (see this
    module's own docstring and CAPTURE_CONTRACT.md):

      1. compose.clientSettings.modifications[] (an array - the LAST entry's
         .prompt) - present on the compose/finalize response body directly,
         and nested inside a completed version's own `compose` key in the
         list response.
      2. remix.textPrompt - only present on some version entries (e.g. ones
         the list endpoint surfaces from earlier/different adaptation
         actions in the same session).

    Tries (1) first, falls back to (2). Any unexpected shape (missing key,
    wrong type) degrades to None rather than raising - the raw payload is
    kept in metadata_json regardless, so nothing is ever lost."""
    compose = payload.get("compose")
    if isinstance(compose, dict):
        client_settings = compose.get("clientSettings")
        if isinstance(client_settings, dict):
            modifications = client_settings.get("modifications")
            if isinstance(modifications, list) and modifications:
                last_modification = modifications[-1]
                if isinstance(last_modification, dict):
                    prompt = last_modification.get("prompt")
                    if isinstance(prompt, str) and prompt.strip():
                        return prompt.strip()

    remix = payload.get("remix")
    if isinstance(remix, dict):
        prompt = remix.get("textPrompt")
        if isinstance(prompt, str) and prompt.strip():
            return prompt.strip()

    return None


def _normalize_adaptation_version_event(db: Session, event: EpidemicCaptureEvent) -> Optional[EpidemicAdaptation]:
    """A version of an Adapt generation - see EpidemicAdaptation's own
    docstring. Unlike _normalize_download_click_event above, this UPSERTS by
    identity (version_id): the same version is deliberately capturable more
    than once (once as "draft" right after compose, again as "pending" after
    finalize, again as "completed" once the versions listing reflects it),
    and each later capture must update the existing row rather than insert a
    duplicate - mirrors providers/elevenlabs/normalization.py's
    normalize_capture_event pattern (find-existing-by-identity, then update
    columns if found / insert if not), simplified: this surface has no
    reconciliation/staleness-ordering concern the way ElevenLabs/Suno do
    (every capture here is live network-intercept of the user's own
    in-progress action, never a backfill walk), so there's no
    is_stale_snapshot guard - a None value from a later, less-complete
    payload simply never overwrites a value already present (same
    `is_new or value is not None` merge rule, without the extra staleness
    check)."""
    payload = event.payload_json or {}
    version_id = _s(payload.get("id"), 160)
    if not version_id:
        logger.warning(
            "epidemicsound adaptation normalization skipped capture_event_id=%s: no version id in payload",
            event.id,
        )
        return None

    existing = _find_existing_adaptation(db, version_id=version_id)
    adaptation = existing or EpidemicAdaptation(provider=PROVIDER, version_id=version_id)
    is_new = existing is None

    status = _s(payload.get("status"), 40)

    # media_url is ONLY populated once status == "completed" - the
    # draft/pending-era compose.clientSettings.modifications[].audioUrl looks
    # similar but is a preview/draft URL, not the confirmed final asset (see
    # this module's own docstring and CAPTURE_CONTRACT.md's own warning).
    media_url = None
    if status == ADAPTATION_STATUS_COMPLETED:
        asset = payload.get("asset")
        if isinstance(asset, dict):
            media_url = _s(asset.get("previewUrl"))

    stems = payload.get("stems")
    stems_json = stems if isinstance(stems, dict) else None

    fields = {
        "session_id": _s(payload.get("sessionId"), 160),
        "recording_id": _s(payload.get("recordingId"), 160),
        "original_track_title": _s(payload.get("originalTrackTitle")),
        "prompt": _extract_adaptation_prompt(payload),
        "status": status,
        "media_url": media_url,
        "stems_json": stems_json,
        "metadata_json": payload,
    }
    for field_name, value in fields.items():
        if is_new or value is not None:
            setattr(adaptation, field_name, value)

    # credits_used is always the same confirmed flat rate - see
    # constants.py's ADAPTATION_CREDITS_FLAT_RATE comment. Set unconditionally
    # rather than relying on the column default, since the column default
    # only applies to a brand-new row, not an update of an existing one.
    adaptation.credits_used = ADAPTATION_CREDITS_FLAT_RATE

    adaptation.source_capture_event_id = event.id
    adaptation.tool_id = event.tool_id
    adaptation.credential_id = event.credential_id

    # Task/Client Mapping - sticky like ownership below: only ever set from
    # an event that actually carries a validated task/client, never cleared
    # by a later capture (e.g. the "completed" status update) that naturally
    # has no attribution of its own if the gate only fired on the first
    # (compose) step.
    if event.linked_task_id is not None:
        adaptation.linked_task_id = event.linked_task_id
        adaptation.linked_task_name = event.linked_task_name
    if event.linked_client_id is not None:
        adaptation.linked_client_id = event.linked_client_id
        adaptation.linked_client_name = event.linked_client_name

    # Sticky ownership: only ever set owner_user_id while it is still
    # unresolved - a resolved owner is never overwritten by a later capture
    # of the same version's status change.
    if adaptation.ownership_status != OWNERSHIP_STATUS_RESOLVED:
        adaptation.owner_user_id = event.user_id
        adaptation.ownership_status = OWNERSHIP_STATUS_RESOLVED

    if is_new:
        db.add(adaptation)
    db.flush()
    return adaptation


def normalize_capture_event(db: Session, event: EpidemicCaptureEvent) -> Optional[EpidemicDownload | EpidemicAdaptation]:
    """Dispatches on event_type - capture.py already rejects anything not in
    ALL_EVENT_TYPES, so this is exhaustive over download_click (the always-
    insert-new-row surface) and adaptation_version (the upsert-by-identity
    surface). See this module's own docstring for the full contrast."""
    if event.event_type == EVENT_TYPE_ADAPTATION_VERSION:
        return _normalize_adaptation_version_event(db, event)
    return _normalize_download_click_event(db, event)


def normalize_capture_events_batch(db: Session, events: list[EpidemicCaptureEvent]) -> dict:
    """Best-effort relative to raw capture - mirrors
    providers/envato/normalization.py's identical function (per-event
    SAVEPOINT isolation, chunked commit) verbatim."""
    from providers.epidemicsound.constants import INGEST_COMMIT_CHUNK_SIZE

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
                "epidemicsound normalization failed for capture_event_id=%s - skipped this cycle",
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
    """Replays every historical EpidemicCaptureEvent through the same
    idempotent normalizer the live path uses - mirrors
    providers/envato/normalization.py's identical function."""
    stats = {"processed": 0, "normalized": 0, "skipped": 0, "errors": 0}
    last_id = 0
    while True:
        events = (
            db.query(EpidemicCaptureEvent)
            .filter(EpidemicCaptureEvent.provider == PROVIDER, EpidemicCaptureEvent.id > last_id)
            .order_by(EpidemicCaptureEvent.id.asc())
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
            "epidemicsound backfill progress: processed=%s normalized=%s skipped=%s errors=%s (through capture_event_id=%s)",
            stats["processed"], stats["normalized"], stats["skipped"], stats["errors"], last_id,
        )
    return stats
