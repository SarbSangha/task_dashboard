# providers/freepik/normalization.py
"""
Raw FreepikCaptureEvent -> normalized FreepikGeneration, plus a projection
into the generic GenerationRecord (models_new.py, provider="freepik") so
cross-tool reporting (generation_records_router.py's browse/search/claim UI,
future Kling-log-style sheets) picks up Freepik with no changes of its own -
see CAPTURE_CONTRACT.md for the full field-by-field mapping this implements.

Idempotent on creation_id/identifier/reference/transaction_id (in that lookup
priority - mirrors GenerationRecord's own "never rely on one fragile field"
dedupe strategy). Safe to re-run on the same raw event any number of times:
re-normalizing an already-normalized event updates the existing row instead
of creating a second one.

Ownership is never re-derived here from the Freepik payload itself (it
structurally cannot be - see models.py's FreepikGeneration docstring). It is
carried in verbatim from the FreepikCaptureEvent's already-resolved
`user_id` + `ownership_confidence`, and only ever set on first insert or
while still 'unknown' - once resolved, sticky (see the architecture plan's
Phase 1: a prior Kling bug that let a later re-discovery clobber ~35% of
generations company-wide is the reason this rule exists).
"""
import hashlib
import logging
from datetime import datetime, timezone
from typing import Any, Optional

from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from models_new import GenerationRecord
from providers.freepik.constants import (
    GENERATION_SOURCE_LIVE_CAPTURE,
    GENERATION_SOURCE_RECONCILIATION,
    GENERATION_STATUS_COMPLETED,
    GENERATION_STATUS_FAILED,
    GENERATION_STATUS_PENDING,
    GENERATION_STATUS_PROCESSING,
    INGEST_COMMIT_CHUNK_SIZE,
    INGESTION_SOURCE_CAPTURED,
    INGESTION_SOURCE_RECOVERED,
    OWNERSHIP_FRESHNESS_WINDOW_SECONDS,
    OWNERSHIP_STATUS_RESOLVED,
    OWNERSHIP_STATUS_UNKNOWN,
    PROVIDER,
)
from providers.freepik.models import FreepikCaptureEvent, FreepikGeneration

logger = logging.getLogger("freepik_normalization")

# FreepikGeneration.status -> GenerationRecord.capture_status. Only "completed"
# maps into reports_router.SUCCESS_STATUSES ("active", "completed"); a still-
# running generation is honestly not a success yet, and a failed one never was.
_CAPTURE_STATUS_BY_PROVIDER_STATUS = {
    GENERATION_STATUS_COMPLETED: "completed",
    GENERATION_STATUS_FAILED: "failed",
    GENERATION_STATUS_PENDING: "pending",
    GENERATION_STATUS_PROCESSING: "processing",
}


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


def _f(value: Any) -> Optional[float]:
    try:
        return float(value) if value is not None else None
    except (TypeError, ValueError):
        return None


def _b(value: Any) -> Optional[bool]:
    if value is None:
        return None
    return bool(value)


def _parse_dt(value: Any) -> Optional[datetime]:
    """Freepik mixes two ISO shapes in the same response
    ("2026-07-02T11:27:02+00:00" and "2026-07-02T11:27:02.000000Z") - both
    parse fine via fromisoformat once 'Z' is normalized to '+00:00'.

    Every datetime column in this codebase is naive UTC, so an offset-aware
    value is *converted* to UTC before the tzinfo is dropped rather than
    having it stripped in place. Stripping in place is a no-op for the two
    shapes above (both are already UTC) but silently shifts wall-clock for
    any other offset - which would quietly break the 15-minute ownership
    freshness gate (see constants.OWNERSHIP_FRESHNESS_WINDOW_SECONDS) by
    making every generation look hours stale, so nothing would ever be
    attributed.
    """
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
    """The hard server-side ownership safety net (see constants.py's
    OWNERSHIP_FRESHNESS_WINDOW_SECONDS docstring). A capture event claiming
    "ticket"/"session" confidence is only actually eligible to set ownership
    if the generation it describes was created recently relative to when we
    received it - otherwise it's almost certainly a historical row from a
    "my creations" gallery/listing view, not something the current ticket
    holder just generated. No provider timestamp at all is treated as "not
    fresh" (fail closed - never attribute on missing information)."""
    if not provider_created_at:
        return False
    reference_time = captured_at or datetime.utcnow()
    age_seconds = (reference_time - provider_created_at).total_seconds()
    # Small negative slack tolerates minor clock skew between Freepik's
    # server and ours; the upper bound is the real guard.
    return -60 <= age_seconds <= OWNERSHIP_FRESHNESS_WINDOW_SECONDS


def _find_existing_generation(db: Session, *, creation_id, identifier, reference, transaction_id) -> Optional[FreepikGeneration]:
    query = db.query(FreepikGeneration).filter(FreepikGeneration.provider == PROVIDER)
    if creation_id:
        found = query.filter(FreepikGeneration.creation_id == creation_id).first()
        if found:
            return found
    if identifier:
        found = query.filter(FreepikGeneration.identifier == identifier).first()
        if found:
            return found
    if reference:
        found = query.filter(FreepikGeneration.reference == reference).first()
        if found:
            return found
    if transaction_id:
        found = query.filter(FreepikGeneration.transaction_id == transaction_id).first()
        if found:
            return found
    return None


def _extract_video_asset(metadata: dict) -> tuple[Optional[str], Optional[str]]:
    """Video-generator creations (tool="video-generator") leave
    creation.preview/raw/large_preview all null - those are image-only
    fields. Confirmed against a real captured payload: the rendered clip and
    a representative still frame instead live in metadata.mediaCollection
    (a list of {type: "video"|"frame", url, ...} entries), with metadata.url
    duplicating the same clip URL as a convenience top-level field. Returns
    (video_url, frame_thumbnail_url), either of which may be None if this
    creation isn't a video or the shape has drifted."""
    media_collection = metadata.get("mediaCollection")
    if not isinstance(media_collection, list):
        media_collection = []

    video_url = next(
        (item.get("url") for item in media_collection if isinstance(item, dict) and item.get("type") == "video" and item.get("url")),
        None,
    ) or metadata.get("url")

    # Prefer the frame at timestamp 0 (the start frame) as the thumbnail -
    # falls back to whatever frame comes first if timestamps are missing.
    thumbnail_url = next(
        (item.get("url") for item in media_collection if isinstance(item, dict) and item.get("type") == "frame" and item.get("timestamp") == 0 and item.get("url")),
        None,
    ) or next(
        (item.get("url") for item in media_collection if isinstance(item, dict) and item.get("type") == "frame" and item.get("url")),
        None,
    )

    return _s(video_url), _s(thumbnail_url)


def _extract_fields(payload: dict) -> dict:
    """Maps one Freepik "file" object (see CAPTURE_CONTRACT.md - the shape in
    the sample response's data[] array) to a flat dict of FreepikGeneration
    column values. Every access is defensive (.get with fallbacks) because
    Freepik's API is unofficial/reverse-engineered and can omit or rename
    fields without notice - a missing field degrades that one column to
    None, it never aborts normalization of the rest of the row."""
    payload = payload or {}
    creation = payload.get("creation") or {}
    metadata = creation.get("metadata") or {}
    source_metadata = metadata.get("source_metadata") or {}
    properties = creation.get("properties") or {}
    thumbnail = payload.get("thumbnail") or {}
    credit_ledger_totals = metadata.get("creditLedgerTotals") or {}

    prompt = metadata.get("prompt") or payload.get("name")
    video_url, video_thumbnail_url = _extract_video_asset(metadata)

    return {
        "creation_id": _s(creation.get("id"), 160),
        "identifier": _s(creation.get("identifier"), 160),
        "reference": _s(payload.get("reference"), 160),
        "family_id": _s(creation.get("family"), 160),
        "variant_index": _i(metadata.get("index")),
        "external_id": _s(payload.get("external_id"), 160),
        "request_id": _s(metadata.get("request_id"), 160),
        "task_id": _s(metadata.get("task_id"), 160),
        "iqs_task_id": _s(metadata.get("iqsTaskId"), 160),
        "transaction_id": _s(metadata.get("transactionId"), 160),
        "project_folder_reference": _s(metadata.get("projects_folder_reference"), 160),
        "folder_reference": _s(payload.get("folder_reference") or creation.get("folder_reference"), 160),

        "name_field": _s(payload.get("name")),
        "prompt": _s(prompt),
        "input_prompt": _s(metadata.get("inputPrompt")),
        "variation_prompt": _s(metadata.get("variationPrompt")),
        "smart_prompt": _b(metadata.get("smartPrompt")),
        "prompt_length": len(prompt) if isinstance(prompt, str) else None,
        "prompt_hash": _prompt_hash(prompt if isinstance(prompt, str) else None),
        "prompt_type": _s(metadata.get("prompt_type") or creation.get("origin")),

        "tool": _s(creation.get("tool"), 80),
        "tool_name": _s(payload.get("tool_name"), 80),
        "mode": _s(metadata.get("mode"), 80),
        "slug": _s(metadata.get("slug"), 80),
        "service": _s(metadata.get("service"), 120),
        "aspect_ratio": _s(metadata.get("aspectRatio"), 20),
        "resolution": _s(metadata.get("resolution"), 20),
        "width": _i(metadata.get("width")),
        "height": _i(metadata.get("height")),
        "output_width": _i(metadata.get("outputWidth")),
        "output_height": _i(metadata.get("outputHeight")),
        "seed": _s(metadata.get("seed"), 40),
        "tags_json": metadata.get("tags") or [],
        "modifiers_json": metadata.get("modifiers") or [],
        "image_references_json": metadata.get("imageReferences") or [],

        "status": _s(creation.get("status"), 40),
        "persisted": _b(creation.get("persisted")),
        "visible": _b(creation.get("visible")),
        "is_watermarked": _b(creation.get("is_watermarked")),
        "nsfw": _b(creation.get("nsfw")),
        "is_public": _b(creation.get("public")),
        "stored": _b(creation.get("stored")),
        "shared": _b(payload.get("shared")),
        "is_last": _b(creation.get("is_last")),
        "provider_created_at": _parse_dt(creation.get("created_at") or payload.get("created_at")),
        "provider_updated_at": _parse_dt(payload.get("updated_at")),
        "elapsed_time_ms": _i(metadata.get("elapsedTime")),
        "expect_time_s": _i(metadata.get("expectTime") or creation.get("expectTime")),
        "queue_priority": _i(metadata.get("queue_priority")),

        "credits_charged": _f(credit_ledger_totals.get("credits")),
        "credits_estimated": _f(credit_ledger_totals.get("creditsEstimated")),
        "unlimited_credits": _f(credit_ledger_totals.get("unlimitedCredits")),
        "credit_ledger_json": metadata.get("creditLedger") or [],

        # Image creations populate these straight off `creation`; video
        # creations leave all four null there and carry their clip/frame
        # instead inside metadata.mediaCollection (see _extract_video_asset).
        # `or video_url`/`or video_thumbnail_url` are no-ops for images, since
        # video_url/video_thumbnail_url are None when mediaCollection is
        # absent - image behavior is unchanged.
        "preview_url": _s(creation.get("preview")) or video_thumbnail_url,
        "thumbnail_url": _s(thumbnail.get("url")) or video_thumbnail_url,
        "large_preview_url": _s(creation.get("large_preview")),
        "raw_url": _s(creation.get("raw")) or video_url,
        "download_url": _s(payload.get("download_url")) or video_url,
        "web_url": _s(creation.get("webUrl")),
        "blurhash": _s(properties.get("blurhash"), 80),
        "ratio": _f(properties.get("ratio")),
        "file_size": _i(payload.get("file_size")),
        "file_type_id": _i(payload.get("file_type_id")),
        "origin": _s(payload.get("origin"), 40),

        "folder_id": _i(payload.get("folder_id")),
        "folder_name": _s(payload.get("folder_name"), 255),

        "metadata_json": metadata,
        "source_metadata_json": source_metadata,
    }


def _is_stale_snapshot(generation: FreepikGeneration, fields: dict) -> bool:
    """True when this payload describes an OLDER state of the creation than
    the one already stored.

    provider_updated_at is Freepik's own last-modified for the row - the very
    value content-freepik.js folds into client_event_id as its change token,
    so it is exactly what distinguishes two snapshots of one creation and it
    orders them reliably. Missing on either side means the two are not
    comparable, which is deliberately NOT treated as stale: the caller falls
    through to the weaker non-null merge rather than dropping data on a
    guess.
    """
    incoming = fields.get("provider_updated_at")
    stored = generation.provider_updated_at
    return bool(incoming and stored and incoming < stored)


def normalize_capture_event(db: Session, event: FreepikCaptureEvent) -> Optional[FreepikGeneration]:
    fields = _extract_fields(event.payload_json or {})
    if not (fields["creation_id"] or fields["identifier"] or fields["reference"]):
        logger.warning(
            "freepik normalization skipped capture_event_id=%s: no identity field present in payload",
            event.id,
        )
        return None

    existing = _find_existing_generation(
        db,
        creation_id=fields["creation_id"],
        identifier=fields["identifier"],
        reference=fields["reference"],
        transaction_id=fields["transaction_id"],
    )

    is_reconciliation = event.ownership_confidence == "reconciliation"
    generation = existing or FreepikGeneration(provider=PROVIDER)
    is_new = existing is None

    # The same creation is deliberately captured more than once: content-
    # freepik.js derives client_event_id from a change token precisely so a
    # "processing" row AND its later "completed" row both reach us. Nothing
    # orders their normalization though - a retry, or the browser-wide shared
    # flush queue draining two tabs, can deliver the earlier snapshot last.
    # A blind overwrite then walks credits_charged/download_url/status back to
    # their earlier (usually null) state and the generation silently vanishes
    # from every credit report. Two guards, in the same "never clobber with
    # emptier data" spirit as it_tools_router.py's re-report path and
    # generation_backfill.py's sticky re-sync:
    #   1. an outright older snapshot leaves the stored columns untouched;
    #   2. otherwise a None never overwrites a value we already have.
    is_stale_snapshot = (not is_new) and _is_stale_snapshot(generation, fields)
    if is_stale_snapshot:
        logger.info(
            "freepik normalization: keeping stored columns for creation_id=%s - "
            "capture_event_id=%s describes an older state (payload updated_at=%s < stored %s)",
            generation.creation_id,
            event.id,
            fields.get("provider_updated_at"),
            generation.provider_updated_at,
        )
    else:
        for field_name, value in fields.items():
            if is_new or value is not None:
                setattr(generation, field_name, value)

    if not is_stale_snapshot:
        # Points at the capture event whose state the row currently reflects,
        # so it must not be dragged backwards to an older one either.
        generation.source_capture_event_id = event.id
    generation.tool_id = event.tool_id
    generation.credential_id = event.credential_id
    # Task Mapping - sticky like ownership below: only ever set from an event
    # that actually carries a validated task (organic live-capture), never
    # cleared by a later reconciliation/history-scan re-normalization pass
    # that naturally has no task attribution of its own.
    if event.linked_task_id is not None:
        generation.linked_task_id = event.linked_task_id
        generation.linked_task_name = event.linked_task_name
    if event.linked_client_id is not None:
        generation.linked_client_id = event.linked_client_id
        generation.linked_client_name = event.linked_client_name
    if not is_stale_snapshot:
        # Both describe how the state the row currently holds was obtained,
        # so they travel with the columns above.
        generation.generation_method = "history_scan" if is_reconciliation else "network_intercept"
        generation.generation_source = GENERATION_SOURCE_RECONCILIATION if is_reconciliation else GENERATION_SOURCE_LIVE_CAPTURE

    # is_attributable depends on freshness ALONE, not on is_reconciliation.
    # is_reconciliation only labels which *pipeline* produced this event
    # (organic network intercept vs. the deliberate history-page walker) for
    # generation_source/generation_method/ingestion_source below - it is not
    # a second, independent trust tier. The actual safety guarantee against
    # mis-attributing old history (an admin's reconciliation walk, or simply
    # the "my creations" gallery loading on tab open, surfacing the whole
    # account's history under whoever's ticket is active) is freshness alone
    # - see _is_fresh_enough_for_attribution's docstring. A reconciliation
    # walk that happens to discover a genuinely fresh row (very plausible: it
    # walks newest-first) is exactly as trustworthy as an organic discovery
    # of that same fresh row, since both resolve identity through the exact
    # same ticket mechanism - excluding it on top of the freshness gate was
    # needless double protection that only cost real, correctly-attributable
    # fresh generations their ownership.
    is_attributable = _is_fresh_enough_for_attribution(fields["provider_created_at"], event.created_at)

    if is_reconciliation:
        if is_new:
            generation.ingestion_source = INGESTION_SOURCE_RECOVERED
    else:
        if is_new:
            generation.ingestion_source = INGESTION_SOURCE_CAPTURED

    if is_attributable:
        # Sticky ownership: only ever set owner_user_id while it is still
        # unresolved. A live, ticket-attributed re-capture of an already
        # reconciliation-imported row is the one case that's allowed to fill
        # in an unknown owner after the fact; a *resolved* owner is never
        # overwritten by anything short of the explicit admin
        # claim/revoke/reassign flow on generation_records_router.py.
        if generation.ownership_status != OWNERSHIP_STATUS_RESOLVED:
            generation.owner_user_id = event.user_id
            generation.ownership_status = OWNERSHIP_STATUS_RESOLVED
            generation.ownership_source = event.ownership_confidence or "session"
    elif is_new:
        # Stale or reconciliation-sourced and never previously seen - lands
        # unclaimed by design, exactly like a recovery import (see
        # CAPTURE_CONTRACT.md's ownership decision table).
        generation.ownership_status = OWNERSHIP_STATUS_UNKNOWN

    if is_new:
        db.add(generation)
    db.flush()

    _project_into_generation_record(db, generation)
    return generation


def _project_into_generation_record(db: Session, generation: FreepikGeneration) -> None:
    """Upserts the cross-tool GenerationRecord row for this FreepikGeneration.
    provider_generation_id=creation_id is the join key (partial-unique on
    GenerationRecord already, per its own schema) - no schema change to
    GenerationRecord was needed for this, since `provider` + the three
    identity columns were already generic."""
    # FreepikGeneration dedupes across four identity fields, but a record was
    # previously looked up by the single preferred key alone. A first snapshot
    # carrying only `identifier`, followed by one that also carries
    # `creation_id`, therefore matched no record the second time and minted a
    # SECOND GenerationRecord - generation_record_id repointed to it and the
    # orphan kept on counting in every report. Resolve through the existing
    # link first, then across the whole identity chain, so one
    # FreepikGeneration can only ever own one GenerationRecord.
    identity_keys = [key for key in (generation.creation_id, generation.identifier, generation.reference) if key]
    if not identity_keys:
        return
    canonical_asset_key = identity_keys[0]

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
                GenerationRecord.provider_generation_id.in_(identity_keys),
            )
            .first()
        )
    is_new = record is None
    if is_new:
        record = GenerationRecord(provider=PROVIDER, provider_generation_id=canonical_asset_key)
        # created_at otherwise defaults to ingestion time (now), which can be
        # hours/days after the actual Freepik render for a reconciliation
        # import - falling back to that only when the real timestamp is
        # unavailable keeps report date-window filtering accurate.
        record.created_at = generation.provider_created_at or datetime.utcnow()

    record.canonical_asset_url = generation.download_url or generation.large_preview_url or generation.preview_url
    record.canonical_asset_key = canonical_asset_key
    record.prompt_text = generation.prompt or generation.name_field
    record.model_label = generation.mode or generation.tool
    # duration_label is what _is_video_filter (reports_router.py) keys off to
    # tell video generations apart from images in the Executive Overview split
    # - without this, every Freepik video-generator row silently counted as an
    # "image" there. metadata_json.duration (seconds) only exists on
    # video-generator creations, so this is naturally a no-op for images.
    duration_seconds = (generation.metadata_json or {}).get("duration")
    record.duration_label = f"{duration_seconds}s" if duration_seconds is not None else None
    record.resolution_label = generation.resolution or generation.aspect_ratio
    record.credits_burned = generation.credits_charged if generation.credits_charged is not None else generation.credits_estimated
    record.ingestion_source = generation.ingestion_source
    # capture_status is the generic column every cross-provider report keys
    # success off (reports_router.SUCCESS_STATUSES). Leaving it at its "active"
    # model default - which this projection used to do - put every Freepik row
    # permanently in the success bucket, so successRate read a hardcoded 100%,
    # statusBreakdown collapsed to one bucket and successVsFailure could never
    # report a failure, even though the real outcome was sitting right here in
    # FreepikGeneration.status the whole time. An unrecognized or absent
    # provider status leaves the default alone rather than inventing a failure.
    mapped_capture_status = _CAPTURE_STATUS_BY_PROVIDER_STATUS.get((generation.status or "").strip().lower())
    if mapped_capture_status:
        record.capture_status = mapped_capture_status
    if generation.linked_task_id is not None:
        record.linked_task_id = generation.linked_task_id
        record.linked_task_name = generation.linked_task_name
    if generation.linked_client_id is not None:
        record.linked_client_id = generation.linked_client_id
        record.linked_client_name = generation.linked_client_name
    record.metadata_json = {
        "freepikGenerationId": generation.id,
        "familyId": generation.family_id,
        "tool": generation.tool,
        "service": generation.service,
        "creditsEstimated": generation.credits_estimated,
        "unlimitedCredits": generation.unlimited_credits,
    }

    # Sticky ownership, same rule as above - GenerationRecord.owner_user_id
    # is never overwritten once resolved, regardless of what re-triggers this
    # projection.
    if record.ownership_status != OWNERSHIP_STATUS_RESOLVED and generation.ownership_status == OWNERSHIP_STATUS_RESOLVED:
        record.owner_user_id = generation.owner_user_id
        record.ownership_status = OWNERSHIP_STATUS_RESOLVED
        record.ownership_source = generation.ownership_source

    if is_new:
        db.add(record)
    db.flush()
    generation.generation_record_id = record.id


def normalize_capture_events_batch(db: Session, events: list[FreepikCaptureEvent]) -> dict:
    """Best-effort relative to raw capture (each event is already durably
    committed by ingest_capture_event before this runs) - a normalization
    failure here must never turn a successful, lossless ingest into an error
    response.

    Each event is isolated in its own SAVEPOINT, and a real COMMIT lands once
    per INGEST_COMMIT_CHUNK_SIZE events. The isolation matters: two requests
    normalizing the same never-before-seen creation_id at once make the
    loser's INSERT raise IntegrityError against FreepikGeneration's unique
    index, and without per-event isolation that single collision would roll
    back every sibling already normalized in the same batch. It costs the
    losing event only its own redundant update - not a bug, since the winning
    request already normalized that creation_id correctly.

    An earlier version bought that isolation with a COMMIT per event, which
    on a 200-event batch meant 200 sequential round-trips to the pooler on one
    held connection. Savepoints give the same guarantee for a fraction of the
    traffic.

    Returns per-batch counts ({"normalized", "skipped", "errors"}) so the
    backfill below can report an honest outcome. The live capture path ignores
    the return value - a normalization problem there is logged, never
    surfaced to the extension."""
    stats = {"normalized": 0, "skipped": 0, "errors": 0}
    if not events:
        return stats
    pending_since_commit = 0
    for event in events:
        savepoint = db.begin_nested()
        try:
            generation = normalize_capture_event(db, event)
            savepoint.commit()
            # A None return is the deliberate "no identity field in this
            # payload" skip, not a failure - see normalize_capture_event.
            stats["normalized" if generation is not None else "skipped"] += 1
        except Exception:
            savepoint.rollback()
            stats["errors"] += 1
            logger.exception(
                "freepik normalization failed for capture_event_id=%s - skipped this cycle, "
                "harmless if lost to a concurrent normalize of the same creation_id",
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
    """Replays every historical FreepikCaptureEvent through the same
    idempotent normalizer the live path uses. Safe to re-run any number of
    times; safe to interrupt and restart (keyset pagination + per-event
    commit means completed work is already durable).

    Oldest-first is load-bearing, not incidental. The same creation is
    captured repeatedly as it moves from "processing" to "completed", and
    replaying in id order feeds those snapshots to normalize_capture_event in
    their original sequence, so each row converges on its newest state. The
    staleness guard makes any other ordering safe too, but this ordering
    makes it unnecessary.

    Ownership cannot drift on a replay: _is_fresh_enough_for_attribution
    measures the generation's age against `event.created_at` - when the event
    was actually received - not against now. A replay therefore reaches the
    exact same attribution verdict the live pass did, however long after the
    fact it runs.
    """
    stats = {"processed": 0, "normalized": 0, "skipped": 0, "errors": 0}
    last_id = 0
    while True:
        events = (
            db.query(FreepikCaptureEvent)
            .filter(FreepikCaptureEvent.provider == PROVIDER, FreepikCaptureEvent.id > last_id)
            .order_by(FreepikCaptureEvent.id.asc())
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
            "freepik backfill progress: processed=%s normalized=%s skipped=%s errors=%s (through capture_event_id=%s)",
            stats["processed"], stats["normalized"], stats["skipped"], stats["errors"], last_id,
        )
    return stats
