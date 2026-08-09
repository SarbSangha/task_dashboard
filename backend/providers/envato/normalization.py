# providers/envato/normalization.py
"""
Raw EnvatoCaptureEvent -> normalized EnvatoGeneration, plus a projection into
the generic GenerationRecord (models_new.py, provider="envato") so cross-tool
reporting picks up Envato with no changes of its own. Mirrors
providers/freepik/normalization.py's structure and every safety rule it
documents (staleness guard, ownership freshness gate, sticky ownership) - see
that file's own docstring for the full reasoning, repeated here only where
Envato's shape actually differs.

Payload shape: the extension (content-envato-turbo-stream.js decodes
Envato's `.data` responses, content-envato-network.js/content-envato-
capture.js build the envelope) sends one flat dict per item - either
straight from generation-history's `assets[]`/`results[].item`, or from an
item-detail page's `itemDetailsProps.item`. Both shapes share the same
field names (itemUuid, itemType, prompt, createdAt/jobCreatedAt,
aspectRatio, ...) per the real decoded samples inspected while building
this provider, so one extractor handles both.

A download of an EXISTING (not user-generated) stock asset on
elements.envato.com (content-envato-elements-capture.js) has no itemUuid at
all - it routes to its own EnvatoDownload table instead, dispatched by
event_type just like Freepik's EVENT_TYPE_DOWNLOAD_CLICK (see
_normalize_download_click_event below).
"""
import hashlib
import logging
from datetime import datetime, timezone
from typing import Any, Optional, Union

from sqlalchemy.orm import Session

from models_new import GenerationRecord
from providers.envato.constants import (
    EVENT_TYPE_DOWNLOAD_CLICK,
    GENERATION_SOURCE_LIVE_CAPTURE,
    GENERATION_SOURCE_RECONCILIATION,
    INGEST_COMMIT_CHUNK_SIZE,
    INGESTION_SOURCE_CAPTURED,
    INGESTION_SOURCE_RECOVERED,
    OWNERSHIP_FRESHNESS_WINDOW_SECONDS,
    OWNERSHIP_STATUS_RESOLVED,
    OWNERSHIP_STATUS_UNKNOWN,
    PROVIDER,
)
from providers.envato.models import EnvatoCaptureEvent, EnvatoDownload, EnvatoGeneration

logger = logging.getLogger("envato_normalization")


def _s(value: Any, max_length: Optional[int] = None) -> Optional[str]:
    if value is None:
        return None
    text = str(value).strip()
    if not text:
        return None
    return text[:max_length] if max_length else text


def _f(value: Any) -> Optional[float]:
    try:
        return float(value) if value is not None else None
    except (TypeError, ValueError):
        return None


def _i(value: Any) -> Optional[int]:
    try:
        return int(value) if value is not None else None
    except (TypeError, ValueError):
        return None


def _b(value: Any) -> Optional[bool]:
    if value is None:
        return None
    return bool(value)


def _parse_dt(value: Any) -> Optional[datetime]:
    """Envato's timestamps observed so far are all
    "2026-07-14T05:55:39.742Z" shaped (fromisoformat handles it once 'Z' is
    normalized to '+00:00') - same conversion-to-naive-UTC rule as
    providers/freepik/normalization.py's _parse_dt, for the same reason: the
    15-minute ownership freshness gate below would silently stop attributing
    anything if a non-UTC offset were ever stripped in place instead of
    converted."""
    if not value or not isinstance(value, str):
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is not None:
        parsed = parsed.astimezone(timezone.utc).replace(tzinfo=None)
    return parsed


def _prompt_hash(prompt: Optional[str]) -> Optional[str]:
    if not prompt:
        return None
    return hashlib.sha256(prompt.encode("utf-8", errors="ignore")).hexdigest()


def _is_fresh_enough_for_attribution(provider_created_at: Optional[datetime], captured_at: Optional[datetime]) -> bool:
    """Hard server-side ownership safety net - see
    constants.OWNERSHIP_FRESHNESS_WINDOW_SECONDS and
    providers/freepik/normalization.py's identical guard for the full
    reasoning. No provider timestamp at all is treated as "not fresh" (fail
    closed)."""
    if not provider_created_at:
        return False
    reference_time = captured_at or datetime.utcnow()
    age_seconds = (reference_time - provider_created_at).total_seconds()
    return -60 <= age_seconds <= OWNERSHIP_FRESHNESS_WINDOW_SECONDS


def _find_existing_generation(db: Session, *, item_uuid: Optional[str]) -> Optional[EnvatoGeneration]:
    if not item_uuid:
        return None
    return (
        db.query(EnvatoGeneration)
        .filter(EnvatoGeneration.provider == PROVIDER, EnvatoGeneration.item_uuid == item_uuid)
        .first()
    )


def _review_status_from_actions(actions: Any) -> Optional[str]:
    """The `request-review` entry in the item's `actions` array (present on
    the POST loadMore/detail shapes, absent on the plain listing shape) is
    the only place a review status lives - see the real decoded sample this
    was built from (decode_test.js output, 2026-08-07)."""
    if not isinstance(actions, list):
        return None
    for action in actions:
        if isinstance(action, dict) and action.get("type") == "request-review":
            return _s(action.get("reviewStatus"), 40)
    return None


def _extract_fields(payload: dict) -> dict:
    """Maps one decoded Envato generation-history item to a flat dict of
    EnvatoGeneration column values. Every access is defensive (.get with
    fallbacks) - Envato's `.data` endpoints are unofficial/reverse-engineered
    (decoded from React Router's turbo-stream wire format) and can omit or
    rename fields without notice; a missing field degrades that one column to
    None, never aborts normalization of the rest of the row.

    Handles both the flat listing shape (payload IS the item) and the
    wrapped shape (payload has its own `item`/`actions` keys, as produced by
    the POST loadMore response and the item-detail page) by unwrapping once
    up front - both were confirmed present in the real captured HAR."""
    payload = payload or {}
    item = payload.get("item") if isinstance(payload.get("item"), dict) else payload
    actions = payload.get("actions", item.get("actions"))
    image = item.get("image") if isinstance(item.get("image"), dict) else {}

    prompt = item.get("prompt")
    created_at = item.get("createdAt") or item.get("jobCreatedAt")

    return {
        "item_uuid": _s(item.get("itemUuid"), 160),
        "item_type": _s(item.get("itemType"), 40),

        "prompt": _s(prompt),
        "prompt_length": len(prompt) if isinstance(prompt, str) else None,
        "prompt_hash": _prompt_hash(prompt if isinstance(prompt, str) else None),
        "title": _s(item.get("title")),

        "aspect_ratio": _s(item.get("aspectRatio"), 20),
        "style": _s(item.get("style"), 120),
        "shortcut_slug": _s(item.get("shortcutSlug"), 120),

        "is_in_workspace": _b(item.get("isInWorkspace")),
        "is_downloaded": _b(item.get("isDownloaded")),
        "review_status": _review_status_from_actions(actions),
        "provider_created_at": _parse_dt(created_at),

        # DOM-scraped, only present on a live (Generate-click) capture - see
        # this module's own docstring and schemas.CaptureEventIn's comment.
        "credits_badge": _f(payload.get("creditsBadge")),
        "quota_remaining_before": _i(payload.get("quotaRemainingBefore")),
        "quota_remaining_after": _i(payload.get("quotaRemainingAfter")),

        "canvas_url": _s(image.get("canvasUrl")),
        "fallback_url": _s(image.get("fallbackSrc")),
        "thumbnail_url": _s(image.get("fallbackSrc")),
        "src_set_json": image.get("srcSet") if image.get("srcSet") else None,

        "metadata_json": item,
        "source_metadata_json": {"actions": actions} if actions else {},
    }


def _normalize_download_click_event(db: Session, event: EnvatoCaptureEvent) -> EnvatoDownload:
    """A download of an existing stock asset - see EnvatoDownload's own
    docstring. Gated behind the same Task/Client picker Generate uses, so
    linked_task_id/linked_client_id are carried in from the capture event
    exactly like EnvatoGeneration's own columns of the same name -
    capture.py has already re-validated both against the live task/client
    tables before this ever runs, so they're trusted as-is here.

    item_uuid/item_type come from event.provider_item_uuid / payload.itemType
    - populated only when content-envato-capture.js's network-signal
    correlation caught the real `GET /download.data?itemUuid=...&itemType=...`
    request (app.envato.com's search/browse flow - confirmed via a captured
    Network panel trace, 2026-08-08); null for a download reported without
    that correlation (e.g. elements.envato.com's own flow, or a network
    signal that never arrived within the correlation window) - not a defect,
    the DOM-scraped fields below still carry the row on their own.

    No freshness gate (unlike EnvatoGeneration's ownership resolution): a
    download-click capture is generated at the exact moment of the user's
    own action, so event.user_id (already resolved by the same launch-ticket
    system every other capture in this codebase trusts) is always
    trustworthy here - same reasoning as Freepik's
    _normalize_download_click_event."""
    payload = event.payload_json or {}
    row = EnvatoDownload(
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
        item_uuid=_s(event.provider_item_uuid, 160),
        item_type=_s(payload.get("itemType"), 40),
        asset_title=_s(payload.get("assetTitle"), 2000),
        asset_thumbnail_url=_s(payload.get("assetThumbnailUrl")),
        asset_source_url=_s(payload.get("assetSourceUrl")),
        search_term=_s(payload.get("searchTerm"), 2000),
        source_host=_s(payload.get("sourceHost"), 80),
        page_url=_s(payload.get("pageUrl")),
        downloaded_at=_parse_dt(payload.get("downloadedAt")) or event.created_at,
        metadata_json=payload,
    )
    db.add(row)
    db.flush()
    return row


def normalize_capture_event(db: Session, event: EnvatoCaptureEvent) -> Optional[Union[EnvatoGeneration, EnvatoDownload]]:
    if event.event_type == EVENT_TYPE_DOWNLOAD_CLICK:
        return _normalize_download_click_event(db, event)

    fields = _extract_fields(event.payload_json or {})
    if not fields["item_uuid"]:
        logger.warning(
            "envato normalization skipped capture_event_id=%s: no itemUuid present in payload",
            event.id,
        )
        return None

    existing = _find_existing_generation(db, item_uuid=fields["item_uuid"])
    is_reconciliation = event.ownership_confidence == "reconciliation"
    generation = existing or EnvatoGeneration(provider=PROVIDER)
    is_new = existing is None

    # No staleness/snapshot-ordering guard here (unlike Freepik): Envato's
    # generation-history item has no equivalent of Freepik's
    # provider_updated_at "processing -> completed" lifecycle in the
    # confirmed payload shape - every observed item is already in its final
    # state by the time it appears in the history listing. A None field
    # never overwrites a value already stored, same "never clobber with
    # emptier data" rule Freepik's blind-overwrite guard encodes, just
    # without the extra older-snapshot check that rule needs.
    for field_name, value in fields.items():
        if is_new or value is not None:
            setattr(generation, field_name, value)

    generation.source_capture_event_id = event.id
    generation.tool_id = event.tool_id
    generation.credential_id = event.credential_id
    if event.linked_task_id is not None:
        generation.linked_task_id = event.linked_task_id
        generation.linked_task_name = event.linked_task_name
    if event.linked_client_id is not None:
        generation.linked_client_id = event.linked_client_id
        generation.linked_client_name = event.linked_client_name
    generation.generation_method = "history_scan" if is_reconciliation else "network_intercept"
    generation.generation_source = GENERATION_SOURCE_RECONCILIATION if is_reconciliation else GENERATION_SOURCE_LIVE_CAPTURE

    # is_attributable depends on freshness ALONE, not on is_reconciliation -
    # see providers/freepik/normalization.py's identical comment for the full
    # reasoning (a reconciliation walk discovering a genuinely fresh row is
    # exactly as trustworthy as an organic live discovery of that same row).
    is_attributable = _is_fresh_enough_for_attribution(fields["provider_created_at"], event.created_at)

    if is_reconciliation:
        if is_new:
            generation.ingestion_source = INGESTION_SOURCE_RECOVERED
    else:
        if is_new:
            generation.ingestion_source = INGESTION_SOURCE_CAPTURED

    if is_attributable:
        # Sticky ownership - only ever set while still unresolved.
        if generation.ownership_status != OWNERSHIP_STATUS_RESOLVED:
            generation.owner_user_id = event.user_id
            generation.ownership_status = OWNERSHIP_STATUS_RESOLVED
            generation.ownership_source = event.ownership_confidence or "session"
    elif is_new:
        generation.ownership_status = OWNERSHIP_STATUS_UNKNOWN

    if is_new:
        db.add(generation)
    db.flush()

    _project_into_generation_record(db, generation)
    return generation


def _project_into_generation_record(db: Session, generation: EnvatoGeneration) -> None:
    """Upserts the cross-tool GenerationRecord row for this EnvatoGeneration.
    provider_generation_id=item_uuid is the join key, same pattern as every
    other provider's projection (see providers/freepik/normalization.py's
    identical function for the full reasoning behind resolving through the
    existing link first)."""
    if not generation.item_uuid:
        return

    record = None
    if generation.generation_record_id:
        record = (
            db.query(GenerationRecord)
            .filter(GenerationRecord.id == generation.generation_record_id)
            .first()
        )
    if record is None:
        record = (
            db.query(GenerationRecord)
            .filter(
                GenerationRecord.provider == PROVIDER,
                GenerationRecord.provider_generation_id == generation.item_uuid,
            )
            .first()
        )
    is_new = record is None
    if is_new:
        record = GenerationRecord(provider=PROVIDER, provider_generation_id=generation.item_uuid)
        record.created_at = generation.provider_created_at or datetime.utcnow()

    record.canonical_asset_url = generation.canvas_url or generation.fallback_url or generation.thumbnail_url
    record.canonical_asset_key = generation.item_uuid
    record.prompt_text = generation.prompt or generation.title
    record.model_label = generation.item_type
    # duration_label is what reports_router.py's _is_video_filter keys off to
    # split video from image generations in the Executive Overview - Envato's
    # confirmed payload carries no duration field for any item type observed
    # so far, so this stays None (falls into the image/default bucket) until
    # a genai-video sample is captured and a real field is found for it.
    record.resolution_label = generation.aspect_ratio
    record.credits_burned = generation.credits_badge
    record.ingestion_source = generation.ingestion_source
    if generation.linked_task_id is not None:
        record.linked_task_id = generation.linked_task_id
        record.linked_task_name = generation.linked_task_name
    if generation.linked_client_id is not None:
        record.linked_client_id = generation.linked_client_id
        record.linked_client_name = generation.linked_client_name
    record.metadata_json = {
        "envatoGenerationId": generation.id,
        "itemType": generation.item_type,
        "shortcutSlug": generation.shortcut_slug,
        "quotaRemainingBefore": generation.quota_remaining_before,
        "quotaRemainingAfter": generation.quota_remaining_after,
    }

    if record.ownership_status != OWNERSHIP_STATUS_RESOLVED and generation.ownership_status == OWNERSHIP_STATUS_RESOLVED:
        record.owner_user_id = generation.owner_user_id
        record.ownership_status = OWNERSHIP_STATUS_RESOLVED
        record.ownership_source = generation.ownership_source

    if is_new:
        db.add(record)
    db.flush()
    generation.generation_record_id = record.id


def normalize_capture_events_batch(db: Session, events: list[EnvatoCaptureEvent]) -> dict:
    """Best-effort relative to raw capture - mirrors
    providers/freepik/normalization.py's identical function (per-event
    SAVEPOINT isolation, chunked commit) verbatim."""
    stats = {"normalized": 0, "skipped": 0, "errors": 0}
    if not events:
        return stats
    pending_since_commit = 0
    for event in events:
        savepoint = db.begin_nested()
        try:
            generation = normalize_capture_event(db, event)
            savepoint.commit()
            stats["normalized" if generation is not None else "skipped"] += 1
        except Exception:
            savepoint.rollback()
            stats["errors"] += 1
            logger.exception(
                "envato normalization failed for capture_event_id=%s - skipped this cycle, "
                "harmless if lost to a concurrent normalize of the same item_uuid",
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
    """Replays every historical EnvatoCaptureEvent through the same
    idempotent normalizer the live path uses - mirrors
    providers/freepik/normalization.py's identical function."""
    stats = {"processed": 0, "normalized": 0, "skipped": 0, "errors": 0}
    last_id = 0
    while True:
        events = (
            db.query(EnvatoCaptureEvent)
            .filter(EnvatoCaptureEvent.provider == PROVIDER, EnvatoCaptureEvent.id > last_id)
            .order_by(EnvatoCaptureEvent.id.asc())
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
            "envato backfill progress: processed=%s normalized=%s skipped=%s errors=%s (through capture_event_id=%s)",
            stats["processed"], stats["normalized"], stats["skipped"], stats["errors"], last_id,
        )
    return stats
