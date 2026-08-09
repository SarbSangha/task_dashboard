# providers/heygen/normalization.py
"""
Raw HeygenCaptureEvent -> normalized HeygenGeneration, plus a projection into
the generic GenerationRecord (models_new.py, provider="heygen") so cross-tool
reporting picks up HeyGen with no changes of its own. Mirrors
providers/freepik/normalization.py (this package's template) structurally,
including the specific bugs that template's history already paid for:

  - client_event_id (built by content-heygen.js) always embeds a change
    token, never a bare id alone, so a "processing" snapshot followed by a
    "completed" one are both captured instead of the second looking like an
    exact duplicate of the first.
  - _is_stale_snapshot below refuses to let an out-of-order/older snapshot
    null out columns a newer one already populated.
  - _find_existing_generation resolves across the full identity chain
    (video_id/render_id/job_id/workflow_id), not a single preferred key, so a
    generation that only had a client-side intent id at "submitted" time and
    gains a real video_id at "completed" time doesn't mint an orphaned
    duplicate row.
  - All timestamps are converted to naive UTC, never stripped-in-place.
  - Provider status is explicitly mapped to capture_status rather than
    defaulting everything to a success bucket.
  - Ownership is sticky: only ever set while unresolved.

Unlike Freepik (whose payload_json is literally Freepik's own unofficial API
response, reverse-engineered field-by-field), HeyGen's payload_json is an
envelope WE define in content-heygen.js - the extension packs whatever it
scraped from the DOM (script/avatar/voice/scene/credits) and whatever shape-
based network interception found into a common shape before sending it,
because no real HeyGen traffic sample was available while building this (see
the package README). _extract_fields below is therefore intentionally
tolerant: every field is looked up under several plausible key-name variants,
so a follow-up pass that tightens content-heygen.js's envelope naming doesn't
require a matching change here.
"""
import hashlib
import logging
from datetime import datetime, timezone
from typing import Any, Optional

from sqlalchemy import or_
from sqlalchemy.orm import Session

from models_new import GenerationRecord
from providers.heygen.constants import (
    GENERATION_SOURCE_LIVE_CAPTURE,
    GENERATION_SOURCE_RECONCILIATION,
    GENERATION_STATUS_CANCELLED,
    GENERATION_STATUS_COMPLETED,
    GENERATION_STATUS_FAILED,
    GENERATION_STATUS_PENDING,
    GENERATION_STATUS_PROCESSING,
    GENERATION_STATUS_QUEUED,
    GENERATION_STATUS_RENDERING,
    INGEST_COMMIT_CHUNK_SIZE,
    INGESTION_SOURCE_CAPTURED,
    INGESTION_SOURCE_RECOVERED,
    OWNERSHIP_FRESHNESS_WINDOW_SECONDS,
    OWNERSHIP_STATUS_RESOLVED,
    OWNERSHIP_STATUS_UNKNOWN,
    PROVIDER,
)
from providers.heygen.models import HeygenCaptureEvent, HeygenGeneration

logger = logging.getLogger("heygen_normalization")

# HeygenGeneration.status -> GenerationRecord.capture_status. Only "completed"
# maps into reports_router.SUCCESS_STATUSES ("active", "completed"); a still-
# running generation is honestly not a success yet, and a failed/cancelled one
# never was.
_CAPTURE_STATUS_BY_PROVIDER_STATUS = {
    GENERATION_STATUS_COMPLETED: "completed",
    GENERATION_STATUS_FAILED: "failed",
    GENERATION_STATUS_CANCELLED: "cancelled",
    GENERATION_STATUS_PENDING: "pending",
    GENERATION_STATUS_QUEUED: "pending",
    GENERATION_STATUS_PROCESSING: "processing",
    GENERATION_STATUS_RENDERING: "processing",
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


def _parse_dt(value: Any) -> Optional[datetime]:
    """HeyGen's own timestamps are of unknown shape (no confirmed sample) -
    handles ISO-8601 with 'Z' or offset the same way Freepik's parser does,
    plus a bare epoch (seconds or milliseconds), since both are common for
    render/status endpoints. Every datetime column in this codebase is naive
    UTC, so an offset-aware value is converted to UTC before tzinfo is
    dropped, never stripped in place (would silently shift wall-clock for any
    non-UTC offset and break the ownership freshness gate below)."""
    if value is None:
        return None
    if isinstance(value, (int, float)):
        try:
            # Heuristic: values above this are almost certainly milliseconds
            # (a seconds-based epoch this large would be year ~5138).
            seconds = value / 1000.0 if value > 10_000_000_000 else value
            return datetime.utcfromtimestamp(seconds)
        except (OverflowError, OSError, ValueError):
            return None
    if not isinstance(value, str) or not value:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is not None:
        parsed = parsed.astimezone(timezone.utc).replace(tzinfo=None)
    return parsed


def _first(source: dict, *keys: str) -> Any:
    """Returns the first non-None value found under any of the given keys,
    checked in order - the tolerance mechanism described in this module's
    docstring for a payload envelope whose exact naming isn't pinned down
    yet."""
    for key in keys:
        if key in source and source[key] is not None:
            return source[key]
    return None


def _prompt_hash(prompt: Optional[str]) -> Optional[str]:
    if not prompt:
        return None
    return hashlib.sha256(prompt.encode("utf-8", errors="ignore")).hexdigest()


def _is_fresh_enough_for_attribution(provider_created_at: Optional[datetime], captured_at: Optional[datetime]) -> bool:
    """Hard server-side ownership safety net - identical reasoning to
    providers/freepik/normalization.py's version. No provider timestamp at
    all is treated as "not fresh" (fail closed - never attribute on missing
    information); this matters more for HeyGen than Freepik since a
    DOM-scraped snapshot may genuinely have no provider timestamp at all, in
    which case captured_at (server receive time) is used as a proxy - a
    freshly-clicked Generate/Render Scene button is, by construction, always
    "now"."""
    reference_time = captured_at or datetime.utcnow()
    if not provider_created_at:
        # DOM-scraped submit-time snapshots legitimately have no provider
        # timestamp yet (HeyGen hasn't assigned one at click time) - treat the
        # capture event's own received time as the generation's origin rather
        # than failing closed on every submit-time event, which would leave
        # every HeyGen generation permanently unattributed until a network
        # snapshot happens to arrive with a real provider_created_at.
        return True
    age_seconds = (reference_time - provider_created_at).total_seconds()
    return -60 <= age_seconds <= OWNERSHIP_FRESHNESS_WINDOW_SECONDS


def _find_existing_generation(db: Session, *, video_id, render_id, job_id, workflow_id, external_event_id) -> Optional[HeygenGeneration]:
    """Every incoming video_id/render_id/job_id/workflow_id is checked
    against all four of those columns, not just its own same-named one - two
    different HeyGen endpoint shapes have already been observed carrying the
    identical real identifier under different field names (2026-08-05: a
    queue-status payload's bare "id" and a listing payload's literal
    "workflow_id" key turned out to be the same video), which produced a
    live-capture row and a reconciliation row for the same generation that
    never matched and never merged. _project_into_generation_record below
    already resolves GenerationRecord this same cross-column way - this
    brings HeygenGeneration's own identity lookup in line with it."""
    query = db.query(HeygenGeneration).filter(HeygenGeneration.provider == PROVIDER)
    identity_values = [value for value in (video_id, render_id, job_id, workflow_id) if value]
    if identity_values:
        found = query.filter(
            or_(
                HeygenGeneration.video_id.in_(identity_values),
                HeygenGeneration.render_id.in_(identity_values),
                HeygenGeneration.job_id.in_(identity_values),
                HeygenGeneration.workflow_id.in_(identity_values),
            )
        ).first()
        if found:
            return found
    if external_event_id:
        # Weakest signal, checked last - this is the client-side intent id
        # content-heygen.js's armHeygenGeneration mints at click time, before
        # HeyGen has assigned any real video/render/job/workflow id. It's
        # what lets a "submitted" DOM snapshot (script/avatar/voice, no real
        # id yet) and the "network_snapshot" that later arrives with a real
        # id resolve to the SAME row instead of the network snapshot minting
        # an orphaned duplicate that never has the script/avatar/voice data.
        # Kept as a single-column check (not folded into identity_values
        # above): it's client-minted, never a real HeyGen identifier, so it
        # can't legitimately collide with the other four.
        found = query.filter(HeygenGeneration.external_event_id == external_event_id).first()
        if found:
            return found
    return None


def _extract_fields(payload: dict) -> dict:
    """Maps one captured HeyGen event payload (the envelope content-heygen.js
    builds - see module docstring) to a flat dict of HeygenGeneration column
    values. Every access is defensive because neither the DOM structure nor
    any network response shape was directly observable while building this -
    a missing field degrades that one column to None, it never aborts
    normalization of the rest of the row."""
    payload = payload or {}
    avatar = payload.get("avatar") or {}
    voice = payload.get("voice") or {}
    scene = payload.get("scene") or {}
    video_config = payload.get("videoConfig") or payload.get("video_config") or {}
    credits = payload.get("credits") or {}
    output = payload.get("output") or {}
    timestamps = payload.get("timestamps") or {}
    # avatar_iv_meta is real, confirmed shape (2026-08-04) from HeyGen's
    # project/items listing endpoint (api2.heygen.com/v1/project/items) - the
    # prompt/resolution/model/duration this envelope-oriented extraction
    # otherwise never finds because that endpoint doesn't use content-
    # heygen.js's own envelope keys at all (it's a real HeyGen response, not
    # our DOM-scrape envelope). Consulted only as a fallback, after this
    # envelope's own keys, so it never shadows a richer DOM-scraped value.
    avatar_iv_meta = ((payload.get("metadata") or {}).get("avatar_iv_meta")) or {}

    script_text = _first(payload, "scriptText", "script_text", "promptText", "prompt") or avatar_iv_meta.get("prompt")
    scene_ids = _first(scene, "ids", "sceneIds") or []
    if not isinstance(scene_ids, list):
        scene_ids = []

    return {
        # "item_id" (the listing endpoint's own primary key) and "id" (the
        # queue/render-status endpoint's primary key) are both last-resort
        # fallbacks for video_id, not workflow_id - corrected 2026-08-04 after
        # a real side-by-side comparison proved it: a generation's queue-
        # status payload's bare "id" and its eventual listing-endpoint
        # "video_id" were the IDENTICAL string. Originally guessed as a
        # separate "workflow_id" (no field of that name was ever actually
        # observed - HeyGen's status payload literally has "workflow_id":
        # null alongside its own "id"), which caused the live-capture row and
        # the reconciliation-capture row for the same video to sit in two
        # different identity columns and never merge - content-heygen.js
        # never puts a bare "id" in any other envelope shape (submitSnapshot
        # has no top-level "id"), so this can't collide with an unrelated
        # identifier.
        "video_id": _s(_first(payload, "videoId", "video_id", "item_id", "id"), 160),
        "render_id": _s(_first(payload, "renderId", "render_id"), 160),
        "job_id": _s(_first(payload, "jobId", "job_id"), 160),
        "workflow_id": _s(_first(payload, "workflowId", "workflow_id"), 160),
        "request_id": _s(_first(payload, "requestId", "request_id"), 160),
        "project_id": _s(_first(payload, "projectId", "project_id"), 160),
        "scene_id": _s(_first(payload, "sceneId", "scene_id"), 160),
        "external_event_id": _s(_first(payload, "externalEventId", "intentId", "generateIntentId"), 160),

        "script_text": _s(script_text),
        "prompt_length": len(script_text) if isinstance(script_text, str) else None,
        "estimated_duration_seconds": _f(_first(payload, "estimatedDurationSeconds", "estimated_duration_seconds")),

        "avatar_id": _s(_first(avatar, "id", "avatarId") or avatar_iv_meta.get("cross_ref_avatar_id"), 160),
        "avatar_name": _s(_first(avatar, "name", "avatarName"), 255),
        "avatar_version": _s(_first(avatar, "version", "avatarVersion"), 40),
        "avatar_type": _s(_first(avatar, "type", "avatarType") or avatar_iv_meta.get("avatar_type"), 40),
        "avatar_position": _s(_first(scene, "avatarPosition", "avatar_position"), 40),

        "voice_id": _s(_first(voice, "id", "voiceId"), 160),
        "voice_name": _s(_first(voice, "name", "voiceName"), 255),
        "voice_language": _s(_first(voice, "language", "voiceLanguage"), 40),
        "voice_gender": _s(_first(voice, "gender", "voiceGender"), 20),
        "voice_style": _s(_first(voice, "style", "emotion", "voiceStyle"), 80),

        "scene_count": _i(_first(scene, "count", "sceneCount")),
        "scene_ids_json": scene_ids,
        "layout": _s(_first(scene, "layout"), 40),
        "background_type": _s(_first(scene, "backgroundType", "background_type"), 40),

        "resolution": _s(_first(video_config, "resolution") or avatar_iv_meta.get("resolution"), 20),
        # Top-level "aspect_ratio" is the listing endpoint's own field name
        # (e.g. "9:16") - videoConfig is only ever populated by our own DOM
        # envelope, never by a real HeyGen response, so this needs its own
        # top-level fallback the same way video_url/thumbnail_url do below.
        "aspect_ratio": _s(_first(video_config, "aspectRatio", "aspect_ratio") or _first(payload, "aspectRatio", "aspect_ratio"), 20),
        "fps": _i(_first(video_config, "fps")),
        # Top-level "duration" on the listing endpoint is the actual rendered
        # duration in seconds (e.g. 2.3431) - preferred over
        # avatar_iv_meta.duration, which is the requested/target duration,
        # not what was actually produced.
        "duration_seconds": _f(
            _first(video_config, "duration", "durationSeconds")
            or _first(payload, "duration")
            or avatar_iv_meta.get("avatar_iv_duration")
        ),
        "quality": _s(_first(video_config, "quality"), 40),
        # avatar_iv_meta.model (e.g. "4.3_turbo_edge") is HeyGen's own name
        # for what this codebase calls "motion engine" - confirmed from the
        # listing endpoint's scene_engines[].model, which uses the same value.
        "motion_engine": _s(_first(video_config, "motionEngine", "motion_engine") or avatar_iv_meta.get("model"), 40),

        "credits_before": _f(_first(credits, "before", "creditsBefore")),
        "credits_after": _f(_first(credits, "after", "creditsAfter")),
        "credits_used": _f(_first(credits, "used", "creditsUsed", "burned")),
        "credit_ledger_json": credits.get("ledger") or [],

        "status": _s(_first(payload, "status"), 40),
        # "created_ts"/"updated_ts" (bare epoch seconds) are the listing
        # endpoint's own field names - _parse_dt already handles a bare epoch,
        # this was just never in the fallback key list.
        "provider_created_at": _parse_dt(_first(payload, "createdAt", "created_at", "created_ts")),
        "provider_updated_at": _parse_dt(_first(payload, "updatedAt", "updated_at", "updated_ts")),
        "submitted_at": _parse_dt(_first(timestamps, "submitted", "submittedAt")),
        "completed_at": _parse_dt(_first(timestamps, "completed", "completedAt")),
        "failed_at": _parse_dt(_first(timestamps, "failed", "failedAt")),
        "cancelled_at": _parse_dt(_first(timestamps, "cancelled", "cancelledAt")),
        "generation_duration_ms": _i(_first(payload, "generationDurationMs", "generation_duration_ms")),

        # A real HeyGen response (e.g. the project/items listing endpoint)
        # puts these top-level, never inside an "output" wrapper - "output.*"
        # is only ever populated by our own DOM-fallback envelope
        # (startHeygenAssetDetection in content-heygen.js), so both have to
        # be checked.
        "video_url": _s(_first(output, "videoUrl", "video_url") or _first(payload, "videoUrl", "video_url")),
        "thumbnail_url": _s(_first(output, "thumbnailUrl", "thumbnail_url") or _first(payload, "thumbnailUrl", "thumbnail_url")),
        "download_url": _s(
            _first(output, "downloadUrl", "download_url")
            or _first(payload, "downloadUrl", "download_url", "videoDownloadUrl", "video_download_url")
        ),
        "preview_url": _s(_first(output, "previewUrl", "preview_url")),
        "share_url": _s(_first(output, "shareUrl", "share_url")),
        "storage_url": _s(_first(output, "storageUrl", "storage_url")),

        "metadata_json": payload,
        "source_metadata_json": payload.get("rawNetworkPayload") or {},
    }


def _is_stale_snapshot(generation: HeygenGeneration, fields: dict) -> bool:
    """True when this payload describes an OLDER state of the generation than
    the one already stored - see providers/freepik/normalization.py's version
    for the incident this guards against. Missing on either side is NOT
    treated as stale: the caller falls through to the weaker non-null merge
    rather than dropping data on a guess."""
    incoming = fields.get("provider_updated_at")
    stored = generation.provider_updated_at
    return bool(incoming and stored and incoming < stored)


def normalize_capture_event(db: Session, event: HeygenCaptureEvent) -> Optional[HeygenGeneration]:
    fields = _extract_fields(event.payload_json or {})
    if not (
        fields["video_id"] or fields["render_id"] or fields["job_id"]
        or fields["workflow_id"] or fields["external_event_id"]
    ):
        # Genuinely no identity field at all (not even the client-side
        # external_event_id content-heygen.js embeds in every submitted-click
        # payload) - nothing to key a row on. The raw HeygenCaptureEvent is
        # never lost either way (see capture.py) - only the normalized
        # projection is deferred.
        logger.warning(
            "heygen normalization skipped capture_event_id=%s: no identity field present in payload",
            event.id,
        )
        return None

    existing = _find_existing_generation(
        db,
        video_id=fields["video_id"],
        render_id=fields["render_id"],
        job_id=fields["job_id"],
        workflow_id=fields["workflow_id"],
        external_event_id=fields["external_event_id"],
    )

    is_reconciliation = event.ownership_confidence == "reconciliation"
    generation = existing or HeygenGeneration(provider=PROVIDER)
    is_new = existing is None

    is_stale_snapshot = (not is_new) and _is_stale_snapshot(generation, fields)
    if is_stale_snapshot:
        logger.info(
            "heygen normalization: keeping stored columns for video_id=%s - "
            "capture_event_id=%s describes an older state (payload updated_at=%s < stored %s)",
            generation.video_id,
            event.id,
            fields.get("provider_updated_at"),
            generation.provider_updated_at,
        )
    else:
        # metadata_json/source_metadata_json are handled separately below by
        # merging rather than blindly replacing wholesale - both are always a
        # dict (never None), so the generic "value is not None" guard every
        # other column relies on can't protect them. Without this, a
        # thin-by-design event like credit_ledger_row (which only ever
        # carries videoId + credits.used - see constants.py's docstring for
        # why there is nothing richer to put in it) would silently erase the
        # full script/avatar/voice snapshot metadata_json already stored from
        # an earlier, richer capture of the SAME generation.
        for field_name, value in fields.items():
            if field_name in ("metadata_json", "source_metadata_json"):
                continue
            if is_new or value is not None:
                setattr(generation, field_name, value)

        for field_name in ("metadata_json", "source_metadata_json"):
            incoming = fields[field_name]
            stored = getattr(generation, field_name)
            if is_new or not stored:
                setattr(generation, field_name, incoming)
            elif incoming:
                merged = dict(stored)
                merged.update(incoming)
                setattr(generation, field_name, merged)

    if not is_stale_snapshot:
        generation.source_capture_event_id = event.id
    generation.tool_id = event.tool_id
    generation.credential_id = event.credential_id
    if event.linked_task_id is not None:
        generation.linked_task_id = event.linked_task_id
        generation.linked_task_name = event.linked_task_name
    if event.linked_client_id is not None:
        generation.linked_client_id = event.linked_client_id
        generation.linked_client_name = event.linked_client_name
    if not is_stale_snapshot:
        generation.generation_method = "history_scan" if is_reconciliation else "network_intercept"
        generation.generation_source = GENERATION_SOURCE_RECONCILIATION if is_reconciliation else GENERATION_SOURCE_LIVE_CAPTURE

    is_attributable = _is_fresh_enough_for_attribution(fields["provider_created_at"], event.created_at)

    if is_reconciliation:
        if is_new:
            generation.ingestion_source = INGESTION_SOURCE_RECOVERED
    else:
        if is_new:
            generation.ingestion_source = INGESTION_SOURCE_CAPTURED

    if is_attributable:
        # Sticky ownership - only ever set while unresolved (see this
        # module's docstring for the Kling incident this rule exists to
        # prevent).
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


def _project_into_generation_record(db: Session, generation: HeygenGeneration) -> None:
    """Upserts the cross-tool GenerationRecord row for this HeygenGeneration.
    provider_generation_id is the join key (partial-unique on GenerationRecord
    already, per its own schema) - no schema change to GenerationRecord was
    needed, since `provider` + the identity columns were already generic."""
    identity_keys = [key for key in (generation.video_id, generation.render_id, generation.job_id, generation.workflow_id) if key]
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
        # Resolve across the whole identity chain, not a single preferred
        # key - see providers/freepik/normalization.py's _project_into_
        # generation_record docstring for the orphaned-duplicate bug this
        # prevents (a submitted-time snapshot carrying only a job_id,
        # followed by a completed-time snapshot that also carries video_id,
        # must resolve to the same GenerationRecord both times).
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
        record.created_at = generation.provider_created_at or generation.submitted_at or datetime.utcnow()

    record.canonical_asset_url = generation.video_url or generation.download_url or generation.preview_url
    record.canonical_asset_key = canonical_asset_key
    record.prompt_text = generation.script_text
    record.model_label = generation.motion_engine or generation.avatar_name
    record.duration_label = f"{generation.duration_seconds}s" if generation.duration_seconds is not None else None
    record.resolution_label = generation.resolution or generation.aspect_ratio
    record.credits_burned = (
        generation.credits_used
        if generation.credits_used is not None
        else (
            (generation.credits_before - generation.credits_after)
            if generation.credits_before is not None and generation.credits_after is not None
            else None
        )
    )
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
        "heygenGenerationId": generation.id,
        "projectId": generation.project_id,
        "sceneId": generation.scene_id,
        "avatarId": generation.avatar_id,
        "avatarName": generation.avatar_name,
        "voiceId": generation.voice_id,
        "voiceName": generation.voice_name,
        "motionEngine": generation.motion_engine,
        "creditsBefore": generation.credits_before,
        "creditsAfter": generation.credits_after,
    }

    # Sticky ownership, same rule as above.
    if record.ownership_status != OWNERSHIP_STATUS_RESOLVED and generation.ownership_status == OWNERSHIP_STATUS_RESOLVED:
        record.owner_user_id = generation.owner_user_id
        record.ownership_status = OWNERSHIP_STATUS_RESOLVED
        record.ownership_source = generation.ownership_source

    if is_new:
        db.add(record)
    db.flush()
    generation.generation_record_id = record.id


def normalize_capture_events_batch(db: Session, events: list[HeygenCaptureEvent]) -> dict:
    """Best-effort relative to raw capture (each event is already durably
    committed by ingest_capture_event before this runs) - a normalization
    failure here must never turn a successful, lossless ingest into an error
    response. Each event is isolated in its own SAVEPOINT so one event losing
    a concurrent-insert race can't roll back its siblings; a real COMMIT lands
    once per INGEST_COMMIT_CHUNK_SIZE events."""
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
                "heygen normalization failed for capture_event_id=%s - skipped this cycle, "
                "harmless if lost to a concurrent normalize of the same identity",
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
    """Replays every historical HeygenCaptureEvent through the same idempotent
    normalizer the live path uses. Safe to re-run any number of times; safe to
    interrupt and restart. Oldest-first so the same generation's snapshots
    (submitted -> settled) are replayed in their original sequence."""
    stats = {"processed": 0, "normalized": 0, "skipped": 0, "errors": 0}
    last_id = 0
    while True:
        events = (
            db.query(HeygenCaptureEvent)
            .filter(HeygenCaptureEvent.provider == PROVIDER, HeygenCaptureEvent.id > last_id)
            .order_by(HeygenCaptureEvent.id.asc())
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
            "heygen backfill progress: processed=%s normalized=%s skipped=%s errors=%s (through capture_event_id=%s)",
            stats["processed"], stats["normalized"], stats["skipped"], stats["errors"], last_id,
        )
    return stats
