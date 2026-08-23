# providers/elevenlabs/normalization.py
"""
Raw ElevenlabsCaptureEvent -> normalized ElevenlabsGeneration, plus a
projection into the generic GenerationRecord (models_new.py,
provider="elevenlabs") so cross-tool reporting picks up ElevenLabs with no
changes of its own. Mirrors providers/flow/normalization.py's structure (see
that file's own docstring for the full sticky-ownership/staleness/projection
reasoning, ported unchanged below).

Idempotent on provider_creation_id. Safe to re-run on the same raw event any
number of times.

Ownership is never re-derived here from the ElevenLabs payload itself (it
structurally cannot be - the `history` endpoint is scoped to the shared
account, not per-employee). It is carried in verbatim from the
ElevenlabsCaptureEvent's already-resolved `user_id` + `ownership_confidence`,
and only ever set on first insert or while still 'unknown' - once resolved,
sticky (same rule providers/freepik/normalization.py's module docstring
describes).

THE ONE THING THIS FILE DOES DIFFERENTLY FROM FLOW'S: only two shapes of real
ElevenLabs traffic have ever been observed - a `history?...&source=TTS...`
row (TTS) and a `music/chats?...` row (Music, confirmed 2026-08-17, see
CAPTURE_CONTRACT.md). `_extract_fields` below is therefore maximally
defensive: for every logical field it tries several plausible candidate JSON
keys, in priority order, and takes the first one present. This is NOT the
same posture as Flow's _extract_fields (which implements one fully-confirmed
shape) - update the candidate-key lists the moment a new real row shape
(Sound Effects/Dubbing/Voice Changer) is captured and confirmed, and tighten
CAPTURE_CONTRACT.md accordingly.

Music's row shape nests almost everything one level down in a `song` object
(chat.song.id/created_at_utc/download_url/status/product_type_source, with
the prompt itself a further level down at
chat.song.generation_settings.prompt) rather than TTS's flat shape -
_flatten_music_chat below folds that down to one dict before the rest of
this function's candidate-key extraction runs, so the same candidate lists
serve both shapes.
"""
import hashlib
import logging
from datetime import datetime, timezone
from typing import Any, List, Optional

from sqlalchemy.orm import Session

from models_new import GenerationRecord
from providers.elevenlabs.constants import (
    GENERATION_SOURCE_LIVE_CAPTURE,
    GENERATION_SOURCE_RECONCILIATION,
    GENERATION_STATUS_COMPLETED,
    GENERATION_STATUS_FAILED,
    GENERATION_STATUS_PENDING,
    GENERATION_STATUS_PROCESSING,
    INGEST_COMMIT_CHUNK_SIZE,
    INGESTION_SOURCE_CAPTURED,
    INGESTION_SOURCE_RECOVERED,
    KNOWN_SOURCE_VALUES,
    MUSIC_CREDITS_PER_SECOND,
    OWNERSHIP_FRESHNESS_WINDOW_SECONDS,
    OWNERSHIP_STATUS_RESOLVED,
    OWNERSHIP_STATUS_UNKNOWN,
    PROVIDER,
)
from providers.elevenlabs.models import ElevenlabsCaptureEvent, ElevenlabsGeneration

logger = logging.getLogger("elevenlabs_normalization")

# ElevenlabsGeneration.status -> GenerationRecord.capture_status. No
# confirmed payload has carried a status field yet (see constants.py) so
# this is currently a no-op branch, kept for parity/forward-compatibility the
# same way constants.py's GENERATION_STATUS_* values are.
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
    """Handles both plausible timestamp shapes for an unconfirmed API:
    ISO-8601 strings (normalized the same way providers/flow/normalization.py
    and providers/freepik/normalization.py's _parse_dt do - 'Z' -> '+00:00',
    then converted to naive UTC, never merely stripped) and unix seconds
    (ElevenLabs' own dashboard/API docs elsewhere use `date_unix`-style
    integer fields, hence date_unix/created_at_unix being candidate keys in
    _extract_fields below)."""
    if value is None:
        return None
    if isinstance(value, (int, float)):
        try:
            return datetime.fromtimestamp(float(value), tz=timezone.utc).replace(tzinfo=None)
        except (ValueError, OverflowError, OSError):
            return None
    if not isinstance(value, str):
        return None
    stripped = value.strip()
    if not stripped:
        return None
    # A numeric string (e.g. "1234567890") is still plausibly a unix
    # timestamp - some JSON encoders emit large integers as strings.
    if stripped.replace(".", "", 1).isdigit():
        try:
            return datetime.fromtimestamp(float(stripped), tz=timezone.utc).replace(tzinfo=None)
        except (ValueError, OverflowError, OSError):
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
    providers/flow/normalization.py's function of the same name (see its
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


def _find_existing_generation(db: Session, *, creation_id: Optional[str]) -> Optional[ElevenlabsGeneration]:
    if not creation_id:
        return None
    return (
        db.query(ElevenlabsGeneration)
        .filter(ElevenlabsGeneration.provider == PROVIDER, ElevenlabsGeneration.provider_creation_id == creation_id)
        .first()
    )


def _first_present(payload: dict, *keys: str, log_field: Optional[str] = None, capture_event_id: Optional[int] = None):
    """Returns the value of the first of `keys` that is actually present (and
    non-empty) on `payload`, defensive-extraction style - see this module's
    own docstring for why. If MORE than one candidate key is present, logs a
    debug note identifying which one won, so a future pass can pick the
    canonical key once the real shape is confirmed (per the plan's explicit
    ask)."""
    present = [k for k in keys if payload.get(k) not in (None, "")]
    if len(present) > 1 and log_field:
        logger.debug(
            "elevenlabs normalization: multiple candidate keys present for %s (capture_event_id=%s): %s - using %r",
            log_field, capture_event_id, present, present[0],
        )
    if present:
        return payload.get(present[0])
    return None


# Eleven v3's Dialogue/multi-speaker mode (model_id "eleven_v3", confirmed
# live 2026-08-14): text/voice_id/voice_name are all null at the top level -
# the real content lives in a `dialogue` array instead, one entry per line/
# speaker: [{text, voice_id, voice_name}, ...]. Previously unhandled, so
# every dialogue-mode row normalized with prompt=None ("No prompt captured"
# in the dashboard) even though the actual script was sitting right there in
# the raw payload the whole time - metadata_json still had it (nothing was
# ever lost), it just never made it into the prompt column or its search/
# hash/length derivatives.
def _dialogue_entries(payload: dict) -> List[dict]:
    dialogue = payload.get("dialogue")
    if not isinstance(dialogue, list):
        return []
    return [entry for entry in dialogue if isinstance(entry, dict)]


def _prompt_from_dialogue(entries: List[dict]) -> Optional[str]:
    parts = [entry["text"].strip() for entry in entries if isinstance(entry.get("text"), str) and entry["text"].strip()]
    return "\n\n".join(parts) if parts else None


# Collects each entry's value for `key` (voice_id or voice_name), de-duped in
# first-seen order - a dialogue can mix multiple voices across its lines, so
# this joins them rather than silently keeping only the first speaker's.
def _voice_from_dialogue(entries: List[dict], key: str) -> Optional[str]:
    values: List[str] = []
    for entry in entries:
        value = entry.get(key)
        if isinstance(value, str) and value.strip() and value not in values:
            values.append(value.strip())
    if not values:
        return None
    return values[0] if len(values) == 1 else ", ".join(values)


# Confirmed real field names (2026-08-14, unlike most of this module's other
# extractions, which are still guessing at candidate keys for an unconfirmed
# shape): character_count_change_from is the account's running character-
# credit tally BEFORE this generation, character_count_change_to is the
# tally AFTER - the difference is exactly how many credits this one
# generation burned.
def _credits_used(payload: dict) -> Optional[int]:
    from_value = payload.get("character_count_change_from")
    to_value = payload.get("character_count_change_to")
    if not isinstance(from_value, (int, float)) or not isinstance(to_value, (int, float)):
        return None
    delta = int(to_value) - int(from_value)
    return delta if delta >= 0 else None


# Music carries no character_count_change_from/to at all (that's a TTS-only
# concept) - see MUSIC_CREDITS_PER_SECOND's own comment for the confirmed
# flat per-second rate this derives from `song_length_ms`
# (payload.generation_settings.song_length_ms after _flatten_music_chat).
def _music_credits_used(payload: dict) -> Optional[int]:
    settings = payload.get("generation_settings")
    if not isinstance(settings, dict):
        return None
    length_ms = settings.get("song_length_ms")
    if not isinstance(length_ms, (int, float)) or length_ms <= 0:
        return None
    return round(length_ms / 1000 * MUSIC_CREDITS_PER_SECOND)


def _extract_asset_url(payload: dict) -> Optional[str]:
    """Best-guess asset URL extraction - tries top-level candidates first,
    then a nested `media`/`audio` object's own `url` field (a plausible shape
    ElevenLabs' broader public API uses elsewhere for nested resources). See
    CAPTURE_CONTRACT.md's known-gaps section: it's entirely possible NO
    candidate here is correct and the real audio asset requires a second
    authenticated fetch this pass does not implement - a null result here is
    the honest, expected outcome for now, not a bug."""
    direct = _first_present(payload, "audio_url", "url", "download_url", log_field="asset_url")
    if direct:
        return direct
    for nested_key in ("media", "audio"):
        nested = payload.get(nested_key)
        if isinstance(nested, dict):
            nested_url = nested.get("url")
            if nested_url:
                return nested_url
    return None


def _flatten_music_chat(payload: dict) -> dict:
    """Music's `/v1/music/chats` rows nest almost everything one level down
    in `song` (id, timestamps, download_url, status, product_type_source)
    and the prompt two levels down in `song.generation_settings.prompt` -
    confirmed real shape (2026-08-17, chat id j2A7GA4Gdye2vr76rkck / song id
    iPZjn5C0kfqSu7CHkx6d). Flattened here into one dict - song-level keys win
    over chat-level ones of the same name (e.g. `id`), since the song is the
    actual generation/asset unit and the chat is just the grouping/prompt-
    thread wrapper around it - so the rest of this function's candidate-key
    logic works unmodified on either shape. A no-op passthrough for TTS rows
    (no `song` key)."""
    song = payload.get("song")
    if not isinstance(song, dict):
        return payload
    flat = {**payload, **song}
    settings = song.get("generation_settings")
    if isinstance(settings, dict) and not flat.get("prompt"):
        flat["prompt"] = settings.get("prompt")
    return flat


def _extract_fields(payload: dict, *, capture_event_id: Optional[int] = None) -> dict:
    """Maps one ElevenLabs `history` or `music/chats` row object to a flat
    dict of ElevenlabsGeneration column values - see this module's own
    docstring and CAPTURE_CONTRACT.md. Every logical field tries several
    plausible candidate keys, in priority order:

      identity          -> history_item_id, id, generation_id
      created timestamp -> date_unix, created_at_unix, created_at, date,
                            created_at_utc
      updated timestamp -> same candidates as created plus updated_at_utc,
                            finished_at_utc; falls back to the created
                            timestamp if no separate updated field exists
      source             -> source, source_type, product_type_source (Music)
      prompt/text        -> text, prompt, text_input; falls back to joining
                            dialogue[].text when those are all null (Eleven
                            v3 Dialogue/multi-speaker mode - see
                            _dialogue_entries below)
      voice id/name       -> voice_id / voice_name; same dialogue[] fallback
      asset URL           -> audio_url, url, download_url, or a nested
                            media/audio object's own `url`

    Every access is defensive (.get with fallbacks) - a missing field
    degrades that one column to None, it never aborts normalization of the
    rest of the row, same convention as every other provider's
    _extract_fields."""
    payload = _flatten_music_chat(payload or {})

    creation_id = _first_present(
        payload, "history_item_id", "id", "generation_id",
        log_field="identity", capture_event_id=capture_event_id,
    )

    created_raw = _first_present(
        payload, "date_unix", "created_at_unix", "created_at", "date", "created_at_utc",
        log_field="created_timestamp", capture_event_id=capture_event_id,
    )
    updated_raw = _first_present(
        payload, "date_unix", "created_at_unix", "created_at", "date", "updated_at_utc", "finished_at_utc",
        log_field="updated_timestamp", capture_event_id=capture_event_id,
    )
    provider_created_at = _parse_dt(created_raw)
    provider_updated_at = _parse_dt(updated_raw) or provider_created_at

    source = _s(
        _first_present(payload, "source", "source_type", "product_type_source", log_field="source", capture_event_id=capture_event_id),
        40,
    )
    if source and source.upper() not in {v.upper() for v in KNOWN_SOURCE_VALUES}:
        logger.debug(
            "elevenlabs normalization: unrecognized source value %r (capture_event_id=%s) - "
            "not in KNOWN_SOURCE_VALUES, please report so constants.py can be updated",
            source, capture_event_id,
        )

    dialogue_entries = _dialogue_entries(payload)

    prompt = _first_present(
        payload, "text", "prompt", "text_input",
        log_field="prompt", capture_event_id=capture_event_id,
    )
    if not prompt and dialogue_entries:
        prompt = _prompt_from_dialogue(dialogue_entries)
    prompt = prompt if isinstance(prompt, str) else _s(prompt)

    voice_id = _s(payload.get("voice_id"), 160)
    voice_name = _s(payload.get("voice_name"), 255)
    if not voice_id and dialogue_entries:
        voice_id = _s(_voice_from_dialogue(dialogue_entries, "voice_id"), 160)
    if not voice_name and dialogue_entries:
        voice_name = _s(_voice_from_dialogue(dialogue_entries, "voice_name"), 255)

    asset_url = _extract_asset_url(payload)
    credits_used = _credits_used(payload)
    if credits_used is None:
        credits_used = _music_credits_used(payload)

    return {
        "provider_creation_id": _s(creation_id, 160),
        "source": source,
        "voice_id": voice_id,
        "voice_name": voice_name,
        "prompt": _s(prompt),
        "prompt_length": len(prompt) if isinstance(prompt, str) else None,
        "prompt_hash": _prompt_hash(prompt if isinstance(prompt, str) else None),
        "credits_used": credits_used,
        # Not present in any confirmed payload yet - see this module's own
        # docstring and constants.py's GENERATION_STATUS_* comment.
        "status": _s(payload.get("status"), 40),
        "provider_created_at": provider_created_at,
        "provider_updated_at": provider_updated_at,
        "media_url": _s(asset_url),
        "metadata_json": payload,
    }


def _is_stale_snapshot(generation: ElevenlabsGeneration, fields: dict) -> bool:
    """True when this payload describes an OLDER state of the row than the
    one already stored - identical reasoning to
    providers/flow/normalization.py's function of the same name. Missing on
    either side is NOT treated as stale - falls through to the weaker
    non-null merge instead of dropping data on a guess."""
    incoming = fields.get("provider_updated_at")
    stored = generation.provider_updated_at
    return bool(incoming and stored and incoming < stored)


def normalize_capture_event(db: Session, event: ElevenlabsCaptureEvent) -> Optional[ElevenlabsGeneration]:
    fields = _extract_fields(event.payload_json or {}, capture_event_id=event.id)
    if not fields["provider_creation_id"]:
        logger.warning(
            "elevenlabs normalization skipped capture_event_id=%s: no identity field present in payload",
            event.id,
        )
        return None

    existing = _find_existing_generation(db, creation_id=fields["provider_creation_id"])

    is_reconciliation = event.ownership_confidence == "reconciliation"
    generation = existing or ElevenlabsGeneration(provider=PROVIDER)
    is_new = existing is None

    # The same history item is deliberately capturable more than once (e.g.
    # once live at generation time, again via the reconciliation walker) -
    # nothing orders their normalization though, so the same two guards as
    # Flow/Freepik's normalize_capture_event apply: an outright older
    # snapshot leaves stored columns untouched, and otherwise a None never
    # overwrites a value already present.
    is_stale_snapshot = (not is_new) and _is_stale_snapshot(generation, fields)
    if is_stale_snapshot:
        logger.info(
            "elevenlabs normalization: keeping stored columns for creation_id=%s - "
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
    # see providers/flow/normalization.py's identical comment for the full
    # reasoning (freshness is the actual safety guarantee; reconciliation
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


def _project_into_generation_record(db: Session, generation: ElevenlabsGeneration) -> None:
    """Upserts the cross-tool GenerationRecord row for this
    ElevenlabsGeneration - mirrors providers/flow/normalization.py's
    identical projection (provider_generation_id=provider_creation_id is the
    join key, partial-unique on GenerationRecord already)."""
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
        "elevenlabsGenerationId": generation.id,
        "source": generation.source,
        "voiceId": generation.voice_id,
        "voiceName": generation.voice_name,
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


def normalize_capture_events_batch(db: Session, events: List[ElevenlabsCaptureEvent]) -> dict:
    """Best-effort relative to raw capture (each event is already durably
    committed by ingest_capture_event before this runs) - mirrors
    providers/flow/normalization.py's identical function, including the
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
                "elevenlabs normalization failed for capture_event_id=%s - skipped this cycle, "
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
    """Replays every historical ElevenlabsCaptureEvent through the same
    idempotent normalizer the live path uses - mirrors
    providers/flow/normalization.py's backfill_all (see its docstring for why
    oldest-first ordering is load-bearing, not incidental, and why a replay
    reaches the exact same ownership verdict the live pass did)."""
    stats = {"processed": 0, "normalized": 0, "skipped": 0, "errors": 0}
    last_id = 0
    while True:
        events = (
            db.query(ElevenlabsCaptureEvent)
            .filter(ElevenlabsCaptureEvent.provider == PROVIDER, ElevenlabsCaptureEvent.id > last_id)
            .order_by(ElevenlabsCaptureEvent.id.asc())
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
            "elevenlabs backfill progress: processed=%s normalized=%s skipped=%s errors=%s (through capture_event_id=%s)",
            stats["processed"], stats["normalized"], stats["skipped"], stats["errors"], last_id,
        )
    return stats
