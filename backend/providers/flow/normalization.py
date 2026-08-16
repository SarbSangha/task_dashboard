# providers/flow/normalization.py
"""
Raw FlowCaptureEvent -> normalized FlowGeneration, plus a projection into the
generic GenerationRecord (models_new.py, provider="flow") so cross-tool
reporting picks up Flow with no changes of its own. Mirrors
providers/freepik/normalization.py's structure (see that file's own
docstring for the full reasoning) minus the search/download event routing -
Flow has no confirmed equivalent event type yet (see constants.py).

Idempotent on provider_creation_id (`flowWorkflows.name` - the only
confirmed identity field, unlike Freepik's four-way identity chain). Safe to
re-run on the same raw event any number of times.

Ownership is never re-derived here from the Flow payload itself (it
structurally cannot be - flowWorkflows responses are scoped to the shared
Google account's OAuth token, not per-employee). It is carried in verbatim
from the FlowCaptureEvent's already-resolved `user_id` +
`ownership_confidence`, and only ever set on first insert or while still
'unknown' - once resolved, sticky (same rule and the same real-world incident
providers/freepik/normalization.py's module docstring describes).
"""
import hashlib
import logging
from datetime import datetime, timezone
from typing import Any, List, Optional

from sqlalchemy.orm import Session

from models_new import GenerationRecord
from providers.flow.constants import (
    EVENT_TYPE_MEDIA_URL_RESOLVED,
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
from providers.flow.models import FlowCaptureEvent, FlowGeneration

logger = logging.getLogger("flow_normalization")

# FlowGeneration.status -> GenerationRecord.capture_status. Only "completed"
# maps into reports_router.SUCCESS_STATUSES. No captured payload has carried
# a status field yet (see constants.py) so this is currently a no-op branch,
# kept for parity/forward-compatibility the same way constants.py's
# GENERATION_STATUS_* values are.
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


def _parse_dt(value: Any) -> Optional[datetime]:
    """Flow's timestamps are ISO-8601 with microseconds and a 'Z' suffix
    ("2026-08-11T10:53:35.925841Z") - normalize 'Z' to '+00:00' the same way
    providers/freepik/normalization.py's _parse_dt does, for the same reason:
    every datetime column in this codebase is naive UTC, so an offset-aware
    value is *converted* to UTC before tzinfo is dropped, rather than merely
    stripped - stripping in place would silently break the ownership
    freshness gate below for any timestamp not already UTC."""
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
    """Hard server-side ownership safety net - identical reasoning to
    providers/freepik/normalization.py's function of the same name (see its
    docstring). A non-reconciliation capture event is only actually eligible
    to set ownership if the generation it describes was created recently
    relative to when the server received it. No provider timestamp at all is
    treated as "not fresh" (fail closed)."""
    if not provider_created_at:
        return False
    reference_time = captured_at or datetime.utcnow()
    age_seconds = (reference_time - provider_created_at).total_seconds()
    # Small negative slack tolerates minor clock skew; the upper bound is
    # the real guard.
    return -60 <= age_seconds <= OWNERSHIP_FRESHNESS_WINDOW_SECONDS


def _find_existing_generation(db: Session, *, creation_id: Optional[str]) -> Optional[FlowGeneration]:
    if not creation_id:
        return None
    return (
        db.query(FlowGeneration)
        .filter(FlowGeneration.provider == PROVIDER, FlowGeneration.provider_creation_id == creation_id)
        .first()
    )


def _extract_fields(payload: dict) -> dict:
    """Maps one flowWorkflows response object to a flat dict of
    FlowGeneration column values - see CAPTURE_CONTRACT.md for the confirmed
    shape this implements:

        {
          "name": "<uuid>",
          "projectId": "<uuid>",
          "metadata": {
            "displayName": "<prompt>",
            "createTime": "<iso8601>",
            "updateTime": "<iso8601>",
            "primaryMediaId": "<uuid>",
            "batchId": "<uuid>"
          }
        }

    Every access is defensive (.get with fallbacks), same convention as
    Freepik's _extract_fields - Flow's flowWorkflows API is unofficial
    (observed via network capture, not a published contract) and can change
    shape without notice; a missing field degrades that one column to None,
    it never aborts normalization of the rest of the row."""
    payload = payload or {}
    metadata = payload.get("metadata") or {}
    prompt = metadata.get("displayName")

    return {
        "provider_creation_id": _s(payload.get("name"), 160),
        "project_id": _s(payload.get("projectId"), 160),
        "batch_id": _s(metadata.get("batchId"), 160),
        "primary_media_id": _s(metadata.get("primaryMediaId"), 160),
        "prompt": _s(prompt),
        "prompt_length": len(prompt) if isinstance(prompt, str) else None,
        "prompt_hash": _prompt_hash(prompt if isinstance(prompt, str) else None),
        # Not present in any confirmed payload yet - see this module's own
        # docstring and constants.py's GENERATION_STATUS_* comment.
        "status": _s(metadata.get("status"), 40),
        "provider_created_at": _parse_dt(metadata.get("createTime")),
        "provider_updated_at": _parse_dt(metadata.get("updateTime")),
        "metadata_json": metadata,
    }


def _is_stale_snapshot(generation: FlowGeneration, fields: dict) -> bool:
    """True when this payload describes an OLDER state of the workflow than
    the one already stored - identical reasoning to
    providers/freepik/normalization.py's function of the same name.
    metadata.updateTime is exactly what content-flow.js folds into
    client_event_id as its change token, so it reliably orders two
    snapshots of the same workflow. Missing on either side is NOT treated as
    stale - falls through to the weaker non-null merge instead of dropping
    data on a guess."""
    incoming = fields.get("provider_updated_at")
    stored = generation.provider_updated_at
    return bool(incoming and stored and incoming < stored)


def _normalize_media_url_event(db: Session, event: FlowCaptureEvent) -> Optional[FlowGeneration]:
    """Pure enrichment - patches an EXISTING FlowGeneration's media_url by
    primary_media_id, never creates a row, never touches
    ownership/attribution. See constants.py's EVENT_TYPE_MEDIA_URL_RESOLVED
    docstring for why this is a separate, ungated event type rather than
    folded into the flowWorkflows row handling below."""
    payload = event.payload_json or {}
    media_id = _s(payload.get("mediaId"), 160)
    url = _s(payload.get("url"))
    if not media_id or not url:
        logger.warning(
            "flow normalization skipped media_url_resolved capture_event_id=%s: missing mediaId/url",
            event.id,
        )
        return None

    generation = (
        db.query(FlowGeneration)
        .filter(FlowGeneration.provider == PROVIDER, FlowGeneration.primary_media_id == media_id)
        .first()
    )
    if not generation:
        # The flowWorkflows event for this media hasn't been captured/
        # normalized yet (ordering isn't guaranteed between the two network
        # calls) - nothing to patch. Not an error: the URL is simply lost for
        # this occurrence: a later gallery view/re-render will resolve and
        # capture it again with a fresh Expires-based client_event_id (see
        # content-flow.js's reportFlowMediaUrl).
        logger.info(
            "flow normalization: no FlowGeneration yet for primary_media_id=%s (capture_event_id=%s) - skipping",
            media_id, event.id,
        )
        return None

    # A row whose PREVIOUS media_url already died (asset_mirror_status=
    # "failed" - terminal, per asset_mirror.py's own docstring) deserves a
    # fresh shot once a genuinely different URL shows up here, rather than
    # staying permanently un-mirrored just because an earlier, now-irrelevant
    # token had already expired by the time the sweep got to it.
    url_changed = generation.media_url != url
    generation.media_url = url
    if url_changed and generation.asset_mirror_status == "failed":
        generation.asset_mirror_status = "pending"
        generation.asset_mirror_error = None
    db.flush()
    # Keep the cross-tool projection's canonical_asset_url in sync too - see
    # _project_into_generation_record, which reads generation.media_url
    # directly.
    _project_into_generation_record(db, generation)
    return generation


def normalize_capture_event(db: Session, event: FlowCaptureEvent) -> Optional[FlowGeneration]:
    if event.event_type == EVENT_TYPE_MEDIA_URL_RESOLVED:
        return _normalize_media_url_event(db, event)

    fields = _extract_fields(event.payload_json or {})
    if not fields["provider_creation_id"]:
        logger.warning(
            "flow normalization skipped capture_event_id=%s: no identity field present in payload",
            event.id,
        )
        return None

    existing = _find_existing_generation(db, creation_id=fields["provider_creation_id"])

    is_reconciliation = event.ownership_confidence == "reconciliation"
    generation = existing or FlowGeneration(provider=PROVIDER)
    is_new = existing is None

    # The same workflow is deliberately captured more than once as its
    # metadata is patched (e.g. once primaryMediaId is first attached, again
    # if it's later updated) - nothing orders their normalization though, so
    # the same two guards as Freepik's normalize_capture_event apply: an
    # outright older snapshot leaves stored columns untouched, and otherwise
    # a None never overwrites a value already present.
    is_stale_snapshot = (not is_new) and _is_stale_snapshot(generation, fields)
    if is_stale_snapshot:
        logger.info(
            "flow normalization: keeping stored columns for creation_id=%s - "
            "capture_event_id=%s describes an older state (payload updateTime=%s < stored %s)",
            generation.provider_creation_id,
            event.id,
            fields.get("provider_updated_at"),
            generation.provider_updated_at,
        )
    else:
        for field_name, value in fields.items():
            if is_new or value is not None:
                setattr(generation, field_name, value)

    if not is_stale_snapshot:
        generation.source_capture_event_id = event.id
    generation.tool_id = event.tool_id
    generation.credential_id = event.credential_id
    # Task Mapping - sticky like ownership below: only ever set from an event
    # that actually carries a validated task, never cleared by a later
    # reconciliation/history-scan re-normalization pass that naturally has
    # no task attribution of its own.
    if event.linked_task_id is not None:
        generation.linked_task_id = event.linked_task_id
        generation.linked_task_name = event.linked_task_name
    if event.linked_client_id is not None:
        generation.linked_client_id = event.linked_client_id
        generation.linked_client_name = event.linked_client_name
    if not is_stale_snapshot:
        generation.generation_method = "history_scan" if is_reconciliation else "network_intercept"
        generation.generation_source = GENERATION_SOURCE_RECONCILIATION if is_reconciliation else GENERATION_SOURCE_LIVE_CAPTURE

    # is_attributable depends on freshness ALONE, not on is_reconciliation -
    # see providers/freepik/normalization.py's identical comment for the
    # full reasoning (freshness is the actual safety guarantee; reconciliation
    # only labels which pipeline produced the event).
    is_attributable = _is_fresh_enough_for_attribution(fields["provider_created_at"], event.created_at)

    if is_reconciliation:
        if is_new:
            generation.ingestion_source = INGESTION_SOURCE_RECOVERED
    else:
        if is_new:
            generation.ingestion_source = INGESTION_SOURCE_CAPTURED

    if is_attributable:
        # Sticky ownership: only ever set owner_user_id while it is still
        # unresolved - a resolved owner is never overwritten by anything
        # short of an explicit admin claim/revoke/reassign flow.
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


def _project_into_generation_record(db: Session, generation: FlowGeneration) -> None:
    """Upserts the cross-tool GenerationRecord row for this FlowGeneration -
    mirrors providers/freepik/normalization.py's identical projection
    (provider_generation_id=provider_creation_id is the join key, partial-
    unique on GenerationRecord already)."""
    if not generation.provider_creation_id:
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
                GenerationRecord.provider_generation_id == generation.provider_creation_id,
            )
            .first()
        )
    is_new = record is None
    if is_new:
        record = GenerationRecord(provider=PROVIDER, provider_generation_id=generation.provider_creation_id)
        # created_at otherwise defaults to ingestion time (now), which can be
        # well after the actual Flow render for a reconciliation import -
        # falling back to that only when the real timestamp is unavailable
        # keeps report date-window filtering accurate.
        record.created_at = generation.provider_created_at or datetime.utcnow()

    record.canonical_asset_url = generation.media_url
    record.canonical_asset_key = generation.provider_creation_id
    record.prompt_text = generation.prompt
    record.ingestion_source = generation.ingestion_source
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
        "flowGenerationId": generation.id,
        "batchId": generation.batch_id,
        "projectId": generation.project_id,
        "primaryMediaId": generation.primary_media_id,
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


def normalize_capture_events_batch(db: Session, events: List[FlowCaptureEvent]) -> dict:
    """Best-effort relative to raw capture (each event is already durably
    committed by ingest_capture_event before this runs) - mirrors
    providers/freepik/normalization.py's identical function, including the
    per-event SAVEPOINT isolation reasoning (a concurrent normalize of the
    same never-before-seen provider_creation_id must not roll back sibling
    events already normalized in the same batch)."""
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
            # payload" skip, not a failure.
            stats["normalized" if generation is not None else "skipped"] += 1
        except Exception:
            savepoint.rollback()
            stats["errors"] += 1
            logger.exception(
                "flow normalization failed for capture_event_id=%s - skipped this cycle, "
                "harmless if lost to a concurrent normalize of the same provider_creation_id",
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
    """Replays every historical FlowCaptureEvent through the same idempotent
    normalizer the live path uses - mirrors
    providers/freepik/normalization.py's backfill_all (see its docstring for
    why oldest-first ordering is load-bearing, not incidental, and why a
    replay reaches the exact same ownership verdict the live pass did)."""
    stats = {"processed": 0, "normalized": 0, "skipped": 0, "errors": 0}
    last_id = 0
    while True:
        events = (
            db.query(FlowCaptureEvent)
            .filter(FlowCaptureEvent.provider == PROVIDER, FlowCaptureEvent.id > last_id)
            .order_by(FlowCaptureEvent.id.asc())
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
            "flow backfill progress: processed=%s normalized=%s skipped=%s errors=%s (through capture_event_id=%s)",
            stats["processed"], stats["normalized"], stats["skipped"], stats["errors"], last_id,
        )
    return stats
