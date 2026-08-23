# providers/suno/normalization.py
"""
Raw SunoCaptureEvent -> normalized SunoGeneration, plus a projection into the
generic GenerationRecord (models_new.py, provider="suno") so cross-tool
reporting picks up Suno with no changes of its own. Mirrors
providers/elevenlabs/normalization.py's structure (see that file's own
docstring for the full sticky-ownership/staleness/projection reasoning,
ported unchanged below).

Idempotent on provider_creation_id. Safe to re-run on the same raw event any
number of times.

Ownership is never re-derived here from the Suno payload itself (it
structurally cannot be - the `feed/v3` endpoint is scoped to the shared
account, not per-employee). It is carried in verbatim from the
SunoCaptureEvent's already-resolved `user_id` + `ownership_confidence`, and
only ever set on first insert or while still 'unknown' - once resolved,
sticky (same rule providers/elevenlabs/normalization.py's module docstring
describes).

UNLIKE ELEVENLABS' `_extract_fields`, this one is NOT defensive multi-
candidate-key extraction: Suno's real `POST /api/feed/v3` response shape is
CONFIRMED from a live DevTools capture (2026-08-17), not guessed at, so every
field below reads one specific, confirmed key. Still defensive against a
field being MISSING on a given payload (every access is `.get`-based, a
missing field degrades that one column to None rather than aborting
normalization of the rest of the row) - just not against the key having a
different NAME than expected, since that's not an open question here the way
it was for ElevenLabs' unconfirmed shape.
"""
import hashlib
import logging
from datetime import datetime, timezone
from typing import Any, List, Optional

from sqlalchemy.orm import Session

from models_new import GenerationRecord
from providers.suno.constants import (
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
from providers.suno.models import SunoCaptureEvent, SunoGeneration

logger = logging.getLogger("suno_normalization")

# SunoGeneration.status -> GenerationRecord.capture_status. Only "streaming"
# has ever been observed on a real clip, and it does not appear in this map
# (it isn't confirmed to correspond to any of these four generic states) -
# this is currently a no-op branch, kept for parity/forward-compatibility the
# same way constants.py's GENERATION_STATUS_* values are. Update once a
# second/terminal status value is observed and its meaning is clear.
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
    """Suno's confirmed timestamp shape is an ISO-8601 string with
    milliseconds and a 'Z' suffix ("2026-08-17T09:09:34.447Z") - normalized
    the same way every other provider's _parse_dt does: 'Z' -> '+00:00', then
    converted to naive UTC, never merely stripped (every datetime column in
    this codebase is naive UTC, so an offset-aware value must be *converted*
    first or the ownership freshness gate below silently breaks for any
    timestamp not already UTC)."""
    if not value or not isinstance(value, str):
        return None
    stripped = value.strip()
    if not stripped:
        return None
    try:
        parsed = datetime.fromisoformat(stripped.replace("Z", "+00:00"))
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
    providers/elevenlabs/normalization.py's function of the same name (see
    its docstring). A non-reconciliation capture event is only actually
    eligible to set ownership if the generation it describes was created
    recently relative to when the server received it. No provider timestamp
    at all is treated as "not fresh" (fail closed)."""
    if not provider_created_at:
        return False
    reference_time = captured_at or datetime.utcnow()
    age_seconds = (reference_time - provider_created_at).total_seconds()
    # Small negative slack tolerates minor clock skew; the upper bound is
    # the real guard.
    return -60 <= age_seconds <= OWNERSHIP_FRESHNESS_WINDOW_SECONDS


def _find_existing_generation(db: Session, *, creation_id: Optional[str]) -> Optional[SunoGeneration]:
    if not creation_id:
        return None
    return (
        db.query(SunoGeneration)
        .filter(SunoGeneration.provider == PROVIDER, SunoGeneration.provider_creation_id == creation_id)
        .first()
    )


def _extract_fields(payload: dict, *, capture_event_id: Optional[int] = None) -> dict:
    """Maps one Suno clip object (`POST /api/feed/v3`'s `clips[]` entries) to
    a flat dict of SunoGeneration column values - see this module's own
    docstring and CAPTURE_CONTRACT.md's field mapping table. Every field
    below is a single confirmed key, not a candidate list (unlike
    ElevenLabs' _extract_fields) - the shape was confirmed from real traffic
    on the first try.

      identity          -> id
      created timestamp -> created_at (ISO-8601); no separate "updated"
                            timestamp has ever been observed on a clip, so
                            provider_updated_at falls back to the same value
      prompt             -> metadata.gpt_description_prompt (the literal
                            user-typed text) when present, falling back to
                            metadata.prompt when it's not - confirmed real
                            2026-08-17: a short/simple prompt with no lyric
                            expansion (e.g. "hello good morning\nwhat a
                            lovely day") never gets a gpt_description_prompt
                            key at all, only metadata.prompt, which in that
                            case IS the literal input verbatim, not expanded
                            lyrics - the AI-expanded-lyrics case this
                            fallback risks capturing instead only happens
                            when gpt_description_prompt is ALSO present (and
                            preferred), so this never regresses that case
      model fields        -> major_model_version, model_name
      asset URL           -> audio_url
      thumbnail            -> image_url
      status               -> status (only "streaming" confirmed so far)

    Every access is defensive against a MISSING field (`.get`, no raise) -
    it never aborts normalization of the rest of the row, same convention as
    every other provider's _extract_fields."""
    payload = payload or {}
    metadata = payload.get("metadata")
    if not isinstance(metadata, dict):
        metadata = {}

    creation_id = payload.get("id")

    provider_created_at = _parse_dt(payload.get("created_at"))
    # No separate "updated" timestamp has ever been observed on a clip -
    # falls back to the created timestamp, same convention as every other
    # provider's _extract_fields uses when no distinct field exists.
    provider_updated_at = provider_created_at

    prompt = metadata.get("gpt_description_prompt")
    if prompt in (None, ""):
        prompt = metadata.get("prompt")
    prompt = prompt if isinstance(prompt, str) else _s(prompt)

    return {
        "provider_creation_id": _s(creation_id, 160),
        "model_name": _s(payload.get("model_name"), 80),
        "major_model_version": _s(payload.get("major_model_version"), 20),
        "prompt": _s(prompt),
        "prompt_length": len(prompt) if isinstance(prompt, str) else None,
        "prompt_hash": _prompt_hash(prompt if isinstance(prompt, str) else None),
        # Permanently None - see constants.py's module docstring and
        # SunoGeneration.credits_used's own comment for why no
        # credits-computation function exists for this pass.
        "credits_used": None,
        # Only "streaming" is confirmed - see this module's own docstring
        # and constants.py's GENERATION_STATUS_* comment.
        "status": _s(payload.get("status"), 40),
        "provider_created_at": provider_created_at,
        "provider_updated_at": provider_updated_at,
        "media_url": _s(payload.get("audio_url")),
        "thumbnail_url": _s(payload.get("image_url")),
        "metadata_json": payload,
    }


def _is_stale_snapshot(generation: SunoGeneration, fields: dict) -> bool:
    """True when this payload describes an OLDER state of the row than the
    one already stored - identical reasoning to
    providers/elevenlabs/normalization.py's function of the same name.
    Missing on either side is NOT treated as stale - falls through to the
    weaker non-null merge instead of dropping data on a guess."""
    incoming = fields.get("provider_updated_at")
    stored = generation.provider_updated_at
    return bool(incoming and stored and incoming < stored)


def normalize_capture_event(db: Session, event: SunoCaptureEvent) -> Optional[SunoGeneration]:
    fields = _extract_fields(event.payload_json or {}, capture_event_id=event.id)
    if not fields["provider_creation_id"]:
        logger.warning(
            "suno normalization skipped capture_event_id=%s: no identity field present in payload",
            event.id,
        )
        return None

    existing = _find_existing_generation(db, creation_id=fields["provider_creation_id"])

    is_reconciliation = event.ownership_confidence == "reconciliation"
    generation = existing or SunoGeneration(provider=PROVIDER)
    is_new = existing is None

    # The same clip is deliberately capturable more than once (e.g. once
    # live while still streaming, again via the reconciliation walker once
    # settled) - nothing orders their normalization though, so the same two
    # guards as ElevenLabs/Flow/Freepik's normalize_capture_event apply: an
    # outright older snapshot leaves stored columns untouched, and otherwise
    # a None never overwrites a value already present.
    is_stale_snapshot = (not is_new) and _is_stale_snapshot(generation, fields)
    if is_stale_snapshot:
        logger.info(
            "suno normalization: keeping stored columns for creation_id=%s - "
            "capture_event_id=%s describes an older state (payload updated=%s < stored %s)",
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
    # reconciliation/feed-scan re-normalization pass that naturally has no
    # task attribution of its own.
    if event.linked_task_id is not None:
        generation.linked_task_id = event.linked_task_id
        generation.linked_task_name = event.linked_task_name
    if event.linked_client_id is not None:
        generation.linked_client_id = event.linked_client_id
        generation.linked_client_name = event.linked_client_name
    if not is_stale_snapshot:
        generation.generation_method = "feed_scan" if is_reconciliation else "network_intercept"
        generation.generation_source = GENERATION_SOURCE_RECONCILIATION if is_reconciliation else GENERATION_SOURCE_LIVE_CAPTURE

    # is_attributable depends on freshness ALONE, not on is_reconciliation -
    # see providers/elevenlabs/normalization.py's identical comment for the
    # full reasoning (freshness is the actual safety guarantee;
    # reconciliation only labels which pipeline produced the event).
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


def _project_into_generation_record(db: Session, generation: SunoGeneration) -> None:
    """Upserts the cross-tool GenerationRecord row for this SunoGeneration -
    mirrors providers/elevenlabs/normalization.py's identical projection
    (provider_generation_id=provider_creation_id is the join key,
    partial-unique on GenerationRecord already)."""
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
        # well after the actual generation for a reconciliation import -
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
        "sunoGenerationId": generation.id,
        "modelName": generation.model_name,
        "majorModelVersion": generation.major_model_version,
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


def normalize_capture_events_batch(db: Session, events: List[SunoCaptureEvent]) -> dict:
    """Best-effort relative to raw capture (each event is already durably
    committed by ingest_capture_event before this runs) - mirrors
    providers/elevenlabs/normalization.py's identical function, including the
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
                "suno normalization failed for capture_event_id=%s - skipped this cycle, "
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
    """Replays every historical SunoCaptureEvent through the same idempotent
    normalizer the live path uses - mirrors
    providers/elevenlabs/normalization.py's backfill_all (see its docstring
    for why oldest-first ordering is load-bearing, not incidental, and why a
    replay reaches the exact same ownership verdict the live pass did)."""
    stats = {"processed": 0, "normalized": 0, "skipped": 0, "errors": 0}
    last_id = 0
    while True:
        events = (
            db.query(SunoCaptureEvent)
            .filter(SunoCaptureEvent.provider == PROVIDER, SunoCaptureEvent.id > last_id)
            .order_by(SunoCaptureEvent.id.asc())
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
            "suno backfill progress: processed=%s normalized=%s skipped=%s errors=%s (through capture_event_id=%s)",
            stats["processed"], stats["normalized"], stats["skipped"], stats["errors"], last_id,
        )
    return stats
