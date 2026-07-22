from __future__ import annotations

import logging
import re
from dataclasses import dataclass, field
from datetime import datetime
from typing import Optional
from urllib.parse import urlparse

from sqlalchemy import inspect
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from models_new import GenerationRecord, ITPortalTool, ITPortalToolUsageEvent

LOGGER = logging.getLogger(__name__)
KLING_TOOL_SLUGS = {"kling", "kling-ai", "klingai"}
INTERNAL_ID_PREFIX_RE = re.compile(r"^(?:kgen|net|dom|trade)_", flags=re.IGNORECASE)
NUMERIC_TASK_ID_RE = re.compile(r"^\d{9,}$")
OUTPUT_URL_HINT_RE = re.compile(r"(?:output|result|generated|avremux|\.mp4$|\.webm$|\.mov$)", flags=re.IGNORECASE)
INTERNAL_ASSET_HINT_RE = re.compile(
    r"/(?:assets?|static|web-assets?|kling-web)/[^?#]*(?:logo|icon|sprite|placeholder|loading|empty|default|avatar|badge|watermark|ui|guide|tutorial|sample|example)",
    flags=re.IGNORECASE,
)
_GENERATION_TABLE_READY_BINDS: set[str] = set()


@dataclass
class BackfillCandidate:
    usage_event_id: int
    owner_user_id: Optional[int]
    provider_task_id: Optional[str]
    provider_generation_id: Optional[str]
    canonical_asset_url: Optional[str]
    canonical_asset_key: Optional[str]
    prompt_text: Optional[str]
    model_label: Optional[str]
    duration_label: Optional[str]
    resolution_label: Optional[str]
    credits_burned: Optional[float]
    created_at: Optional[datetime]
    metadata_json: dict
    confidence: str
    signals: list[str] = field(default_factory=list)


@dataclass
class BackfillSummary:
    apply_mode: bool
    batch_size: int
    start_after_id: int
    max_rows: Optional[int]
    kling_tool_ids: list[int] = field(default_factory=list)
    scanned_rows: int = 0
    generation_candidates: int = 0
    candidate_confidence_high: int = 0
    candidate_confidence_medium: int = 0
    skipped_non_generation: int = 0
    skipped_no_identity: int = 0
    malformed_rows: int = 0
    duplicate_source_usage_event: int = 0
    duplicate_identity: int = 0
    inserted: int = 0
    would_insert: int = 0
    owner_assigned: int = 0
    last_processed_id: int = 0
    error_samples: list[str] = field(default_factory=list)

    def to_dict(self) -> dict:
        return {
            "applyMode": self.apply_mode,
            "batchSize": self.batch_size,
            "startAfterId": self.start_after_id,
            "maxRows": self.max_rows,
            "klingToolIds": self.kling_tool_ids,
            "scannedRows": self.scanned_rows,
            "generationCandidates": self.generation_candidates,
            "candidateConfidenceHigh": self.candidate_confidence_high,
            "candidateConfidenceMedium": self.candidate_confidence_medium,
            "skippedNonGeneration": self.skipped_non_generation,
            "skippedNoIdentity": self.skipped_no_identity,
            "malformedRows": self.malformed_rows,
            "duplicateSourceUsageEvent": self.duplicate_source_usage_event,
            "duplicateIdentity": self.duplicate_identity,
            "inserted": self.inserted,
            "wouldInsert": self.would_insert,
            "ownerAssigned": self.owner_assigned,
            "lastProcessedId": self.last_processed_id,
            "errorSamples": self.error_samples,
        }


@dataclass
class GenerationRecordSyncResult:
    attempted: bool = False
    created: bool = False
    updated: bool = False
    skipped: bool = False
    skip_reason: Optional[str] = None
    record_id: Optional[int] = None
    source_usage_event_id: Optional[int] = None
    confidence: Optional[str] = None
    identity_signals: list[str] = field(default_factory=list)
    error_message: Optional[str] = None

    def to_dict(self) -> dict:
        return {
            "attempted": self.attempted,
            "created": self.created,
            "updated": self.updated,
            "skipped": self.skipped,
            "skipReason": self.skip_reason,
            "recordId": self.record_id,
            "sourceUsageEventId": self.source_usage_event_id,
            "confidence": self.confidence,
            "identitySignals": self.identity_signals,
            "errorMessage": self.error_message,
        }


def _normalize_text(value: object, *, max_length: Optional[int] = None) -> str:
    text_value = f"{value or ''}".strip()
    if not text_value:
        return ""
    if max_length is not None:
        return text_value[:max_length]
    return text_value


def _metadata_dict(event: ITPortalToolUsageEvent) -> dict:
    return event.metadata_json if isinstance(event.metadata_json, dict) else {}


def _append_unique(values: list[str], seen: set[str], value: object, *, max_length: int = 160) -> None:
    normalized = _normalize_text(value, max_length=max_length)
    if not normalized:
        return
    lowered = normalized.lower()
    if lowered in seen:
        return
    seen.add(lowered)
    values.append(normalized)


def _task_id_candidates(event: ITPortalToolUsageEvent, metadata: dict) -> list[str]:
    values: list[str] = []
    seen: set[str] = set()
    ownership = metadata.get("ownership") if isinstance(metadata.get("ownership"), dict) else {}
    pipeline = metadata.get("pipelineDiagnostics") if isinstance(metadata.get("pipelineDiagnostics"), dict) else {}
    for value in (
        event.generation_id,
        event.request_id,
        metadata.get("klingTaskId"),
        ownership.get("klingTaskId"),
    ):
        _append_unique(values, seen, value)
    for value in pipeline.get("taskIds") if isinstance(pipeline.get("taskIds"), list) else []:
        _append_unique(values, seen, value)
    for value in metadata.get("discoveredTaskIds") if isinstance(metadata.get("discoveredTaskIds"), list) else []:
        _append_unique(values, seen, value)
    return values


def _provider_task_id(event: ITPortalToolUsageEvent, metadata: dict) -> str:
    candidates = _task_id_candidates(event, metadata)
    numeric = [value for value in candidates if NUMERIC_TASK_ID_RE.fullmatch(value)]
    if numeric:
        return numeric[0]
    external = [value for value in candidates if not INTERNAL_ID_PREFIX_RE.match(value)]
    if external:
        return external[0]
    return ""


def _provider_generation_id(event: ITPortalToolUsageEvent, metadata: dict) -> str:
    candidates: list[str] = []
    seen: set[str] = set()
    ownership = metadata.get("ownership") if isinstance(metadata.get("ownership"), dict) else {}
    pipeline = metadata.get("pipelineDiagnostics") if isinstance(metadata.get("pipelineDiagnostics"), dict) else {}
    generation_pipeline = (
        pipeline.get("generationPipeline") if isinstance(pipeline.get("generationPipeline"), dict) else {}
    )
    for value in (
        event.generation_id if INTERNAL_ID_PREFIX_RE.match(_normalize_text(event.generation_id)) else "",
        metadata.get("generationId"),
        metadata.get("canonicalInternalGenerationId"),
        metadata.get("internalGenerationId"),
        metadata.get("generateIntentId"),
        ownership.get("internalGenerationId"),
        generation_pipeline.get("currentIntentId"),
    ):
        _append_unique(candidates, seen, value)
    media_assets = metadata.get("mediaAssets") if isinstance(metadata.get("mediaAssets"), list) else []
    for item in media_assets:
        if not isinstance(item, dict):
            continue
        _append_unique(candidates, seen, item.get("generationId"))
    return candidates[0] if candidates else ""


def _canonical_asset_url(metadata: dict) -> str:
    media_assets = metadata.get("mediaAssets") if isinstance(metadata.get("mediaAssets"), list) else []
    candidates: list[str] = []
    for item in media_assets:
        if not isinstance(item, dict):
            continue
        role = _normalize_text(item.get("assetRole")).lower()
        if role == "input":
            continue
        url = _normalize_text(item.get("url"))
        if not url.startswith(("http://", "https://")):
            continue
        lowered = url.lower()
        if "prompt-library-resources" in lowered:
            continue
        if INTERNAL_ASSET_HINT_RE.search(lowered):
            continue
        if not OUTPUT_URL_HINT_RE.search(lowered):
            continue
        candidates.append(url)
    return sorted(set(candidates))[0] if candidates else ""


def _canonical_asset_key(asset_url: str) -> str:
    normalized = _normalize_text(asset_url)
    if not normalized:
        return ""
    parsed = urlparse(normalized)
    path = parsed.path or ""
    lowered = path.lower()
    if "multi_bitrate" in lowered:
        path = path.split("_multi_bitrate", 1)[0]
    key = f"{parsed.netloc.lower()}{path}"
    return key[:255]


def _prompt_text(event: ITPortalToolUsageEvent, metadata: dict) -> str:
    prompt_text = _normalize_text(event.prompt_text)
    if prompt_text:
        return prompt_text
    prompt_capture = metadata.get("promptCapture") if isinstance(metadata.get("promptCapture"), dict) else {}
    return _normalize_text(prompt_capture.get("text"))


def _is_generation_candidate(event: ITPortalToolUsageEvent, metadata: dict) -> bool:
    event_type = _normalize_text(event.event_type).lower()
    if event_type == "generate_click" or event_type.startswith("network"):
        return True
    if _normalize_text(event.generation_id) or _normalize_text(event.request_id):
        return True
    if _normalize_text(metadata.get("klingTaskId")):
        return True
    if isinstance(metadata.get("mediaAssets"), list) and metadata.get("mediaAssets"):
        return True
    if _normalize_text(metadata.get("generationMode")):
        return True
    return False


def _candidate_confidence(provider_task_id: str, provider_generation_id: str, asset_key: str) -> str:
    if provider_task_id or asset_key:
        return "high"
    if provider_generation_id:
        return "medium"
    return "low"


def _build_candidate(event: ITPortalToolUsageEvent) -> Optional[BackfillCandidate]:
    metadata = _metadata_dict(event)
    if not _is_generation_candidate(event, metadata):
        return None

    provider_task_id = _provider_task_id(event, metadata)
    provider_generation_id = _provider_generation_id(event, metadata)
    canonical_asset_url = _canonical_asset_url(metadata)
    canonical_asset_key = _canonical_asset_key(canonical_asset_url)
    if not (provider_task_id or provider_generation_id or canonical_asset_key):
        return BackfillCandidate(
            usage_event_id=event.id,
            owner_user_id=event.user_id,
            provider_task_id=None,
            provider_generation_id=None,
            canonical_asset_url=None,
            canonical_asset_key=None,
            prompt_text=None,
            model_label=None,
            duration_label=None,
            resolution_label=None,
            credits_burned=None,
            created_at=event.created_at,
            metadata_json={},
            confidence="low",
            signals=[],
        )

    prompt_text = _prompt_text(event, metadata)
    confidence = _candidate_confidence(provider_task_id, provider_generation_id, canonical_asset_key)
    signals: list[str] = []
    if provider_task_id:
        signals.append("provider_task_id")
    if provider_generation_id:
        signals.append("provider_generation_id")
    if canonical_asset_key:
        signals.append("canonical_asset_key")
    if prompt_text:
        signals.append("prompt_text")
    candidate_metadata = dict(metadata)
    candidate_metadata["generationRecordCandidate"] = {
        "sourceUsageEventId": event.id,
        "signals": signals,
        "confidence": confidence,
        "derivedAt": datetime.utcnow().isoformat(),
    }
    return BackfillCandidate(
        usage_event_id=event.id,
        owner_user_id=event.user_id,
        provider_task_id=provider_task_id or None,
        provider_generation_id=provider_generation_id or None,
        canonical_asset_url=canonical_asset_url or None,
        canonical_asset_key=canonical_asset_key or None,
        prompt_text=prompt_text or None,
        model_label=_normalize_text(event.model_label, max_length=255) or None,
        duration_label=_normalize_text(event.duration_label, max_length=80) or None,
        resolution_label=_normalize_text(event.resolution_label, max_length=80) or None,
        credits_burned=event.credits_burned,
        created_at=event.created_at,
        metadata_json=candidate_metadata,
        confidence=confidence,
        signals=signals,
    )


def _prefetch_existing_identities(session: Session, candidates: list[BackfillCandidate]) -> tuple[set[int], set[tuple[str, str]], set[tuple[str, str]], set[tuple[str, str]]]:
    source_ids = [candidate.usage_event_id for candidate in candidates]
    task_keys = {( "kling", candidate.provider_task_id) for candidate in candidates if candidate.provider_task_id}
    generation_keys = {( "kling", candidate.provider_generation_id) for candidate in candidates if candidate.provider_generation_id}
    asset_keys = {( "kling", candidate.canonical_asset_key) for candidate in candidates if candidate.canonical_asset_key}

    existing_source_ids = {
        value
        for (value,) in session.query(GenerationRecord.source_usage_event_id)
        .filter(GenerationRecord.source_usage_event_id.in_(source_ids))
        .all()
        if value is not None
    }
    existing_task_keys = {
        (provider, provider_task_id)
        for provider, provider_task_id in session.query(GenerationRecord.provider, GenerationRecord.provider_task_id)
        .filter(
            GenerationRecord.provider == "kling",
            GenerationRecord.provider_task_id.in_([value for _, value in task_keys]) if task_keys else False,
        )
        .all()
        if provider_task_id
    }
    existing_generation_keys = {
        (provider, provider_generation_id)
        for provider, provider_generation_id in session.query(GenerationRecord.provider, GenerationRecord.provider_generation_id)
        .filter(
            GenerationRecord.provider == "kling",
            GenerationRecord.provider_generation_id.in_([value for _, value in generation_keys]) if generation_keys else False,
        )
        .all()
        if provider_generation_id
    }
    existing_asset_keys = {
        (provider, canonical_asset_key)
        for provider, canonical_asset_key in session.query(GenerationRecord.provider, GenerationRecord.canonical_asset_key)
        .filter(
            GenerationRecord.provider == "kling",
            GenerationRecord.canonical_asset_key.in_([value for _, value in asset_keys]) if asset_keys else False,
        )
        .all()
        if canonical_asset_key
    }
    return existing_source_ids, existing_task_keys, existing_generation_keys, existing_asset_keys


def _ensure_generation_tables_exist(session: Session) -> None:
    inspector = inspect(session.bind)
    missing = [
        table_name
        for table_name in ("generation_projects", "generation_records", "generation_recovery_audits")
        if not inspector.has_table(table_name)
    ]
    if missing:
        raise RuntimeError(
            "Phase 2A schema is not available yet. Missing tables: " + ", ".join(missing)
        )


def _generation_tables_available(session: Session) -> bool:
    bind_key = str(session.bind)
    if bind_key in _GENERATION_TABLE_READY_BINDS:
        return True
    inspector = inspect(session.bind)
    is_ready = all(
        inspector.has_table(table_name)
        for table_name in ("generation_projects", "generation_records", "generation_recovery_audits")
    )
    if is_ready:
        _GENERATION_TABLE_READY_BINDS.add(bind_key)
    return is_ready


def _find_generation_record_for_candidate(
    session: Session,
    candidate: BackfillCandidate,
) -> Optional[GenerationRecord]:
    if candidate.usage_event_id:
        record = (
            session.query(GenerationRecord)
            .filter(GenerationRecord.source_usage_event_id == candidate.usage_event_id)
            .first()
        )
        if record:
            return record
    if candidate.provider_task_id:
        record = (
            session.query(GenerationRecord)
            .filter(
                GenerationRecord.provider == "kling",
                GenerationRecord.provider_task_id == candidate.provider_task_id,
            )
            .first()
        )
        if record:
            return record
    if candidate.provider_generation_id:
        record = (
            session.query(GenerationRecord)
            .filter(
                GenerationRecord.provider == "kling",
                GenerationRecord.provider_generation_id == candidate.provider_generation_id,
            )
            .first()
        )
        if record:
            return record
    if candidate.canonical_asset_key:
        record = (
            session.query(GenerationRecord)
            .filter(
                GenerationRecord.provider == "kling",
                GenerationRecord.canonical_asset_key == candidate.canonical_asset_key,
            )
            .first()
        )
        if record:
            return record
    return None


def _merge_generation_record_metadata(
    existing_metadata: object,
    candidate_metadata: dict,
    *,
    action: str,
    candidate: BackfillCandidate,
    source_usage_event_id_conflict: bool,
) -> dict:
    merged = dict(existing_metadata) if isinstance(existing_metadata, dict) else {}
    merged.update(candidate_metadata or {})
    merged["generationRecordNormalization"] = {
        "action": action,
        "normalizedAt": datetime.utcnow().isoformat(),
        "sourceUsageEventId": candidate.usage_event_id,
        "confidence": candidate.confidence,
        "identitySignals": list(candidate.signals),
        "sourceUsageEventIdConflict": source_usage_event_id_conflict,
    }
    return merged


def _apply_candidate_to_generation_record(
    record: GenerationRecord,
    candidate: BackfillCandidate,
    *,
    action: str,
    assign_owner: bool = True,
) -> None:
    source_usage_event_id_conflict = bool(
        record.source_usage_event_id
        and candidate.usage_event_id
        and record.source_usage_event_id != candidate.usage_event_id
    )
    record.provider = "kling"
    record.provider_task_id = candidate.provider_task_id or record.provider_task_id
    record.provider_generation_id = candidate.provider_generation_id or record.provider_generation_id
    record.canonical_asset_url = candidate.canonical_asset_url or record.canonical_asset_url
    record.canonical_asset_key = candidate.canonical_asset_key or record.canonical_asset_key
    record.prompt_text = candidate.prompt_text or record.prompt_text
    record.model_label = candidate.model_label or record.model_label
    record.duration_label = candidate.duration_label or record.duration_label
    record.resolution_label = candidate.resolution_label or record.resolution_label
    record.credits_burned = candidate.credits_burned if candidate.credits_burned is not None else record.credits_burned
    record.ingestion_source = "captured"
    record.capture_status = "active"
    # Ownership is sticky: only ever fill it in when the record doesn't have
    # one yet. Previously this was `candidate.owner_user_id or record.owner_user_id`,
    # which let *any* later re-capture of the same task_id (e.g. a teammate's
    # extension re-syncing a shared Kling account's generation history) silently
    # overwrite a correctly-attributed owner with whoever most recently viewed
    # it -- that clobbered ~35% of generations company-wide before this fix.
    # Reconciliation-recovered records additionally skip owner assignment
    # entirely (see sync_generation_record_from_usage_event's assign_owner
    # param): the usage event's user_id there is just whoever's extension
    # happened to re-discover it, not necessarily who ran the generation.
    if assign_owner and not record.owner_user_id and candidate.owner_user_id:
        record.owner_user_id = candidate.owner_user_id
        record.ownership_status = "resolved"
        record.ownership_source = "usage_event_user_id"
    if not source_usage_event_id_conflict and candidate.usage_event_id:
        record.source_usage_event_id = candidate.usage_event_id
    # Anchor created_at to the EARLIEST known occurrence of this generation.
    # History re-discovery reports the same clip later (its discovery time is a
    # larger timestamp than the real generation), so taking the min does two
    # things: it stops a re-scan from pushing a correctly-dated record forward
    # to its discovery day, and it pulls a previously mis-dated record (one
    # created at discovery time before the historical-occurredAt fix) back to
    # the real generation time. Without this, the Reports module — which filters
    # GenerationRecord.created_at — keeps double-counting old clips (and their
    # credits) into whatever day they were rediscovered.
    if candidate.created_at and (record.created_at is None or candidate.created_at < record.created_at):
        record.created_at = candidate.created_at
    record.metadata_json = _merge_generation_record_metadata(
        record.metadata_json,
        candidate.metadata_json,
        action=action,
        candidate=candidate,
        source_usage_event_id_conflict=source_usage_event_id_conflict,
    )
    record.updated_at = datetime.utcnow()


def sync_generation_record_from_usage_event(
    session: Session,
    usage_event: ITPortalToolUsageEvent,
    *,
    assign_owner: bool = True,
    logger: Optional[logging.Logger] = None,
) -> GenerationRecordSyncResult:
    logger = logger or LOGGER
    result = GenerationRecordSyncResult(source_usage_event_id=usage_event.id)
    if not _generation_tables_available(session):
        result.skipped = True
        result.skip_reason = "schema_missing"
        return result

    try:
        candidate = _build_candidate(usage_event)
    except Exception as exc:  # pragma: no cover - safety path
        logger.warning("Generation normalization failed for usage event id=%s: %s", usage_event.id, exc)
        result.attempted = True
        result.skipped = True
        result.skip_reason = "malformed_usage_event"
        result.error_message = str(exc)
        return result

    result.attempted = True
    if candidate is None:
        result.skipped = True
        result.skip_reason = "non_generation_event"
        return result

    result.confidence = candidate.confidence
    result.identity_signals = list(candidate.signals)
    if not (
        candidate.provider_task_id
        or candidate.provider_generation_id
        or candidate.canonical_asset_key
    ):
        result.skipped = True
        result.skip_reason = "missing_identity"
        return result

    existing = _find_generation_record_for_candidate(session, candidate)
    if existing:
        try:
            with session.begin_nested():
                _apply_candidate_to_generation_record(existing, candidate, action="update", assign_owner=assign_owner)
                session.add(existing)
                session.flush()
            result.updated = True
            result.record_id = existing.id
            return result
        except IntegrityError as exc:
            logger.warning(
                "Generation normalization update conflicted for usage event id=%s: %s",
                usage_event.id,
                exc.__class__.__name__,
            )
            result.skipped = True
            result.skip_reason = "integrity_conflict"
            result.error_message = exc.__class__.__name__
            return result

    record_owner_user_id = candidate.owner_user_id if assign_owner else None
    record = GenerationRecord(
        provider="kling",
        provider_task_id=candidate.provider_task_id,
        provider_generation_id=candidate.provider_generation_id,
        canonical_asset_url=candidate.canonical_asset_url,
        canonical_asset_key=candidate.canonical_asset_key,
        prompt_text=candidate.prompt_text,
        model_label=candidate.model_label,
        duration_label=candidate.duration_label,
        resolution_label=candidate.resolution_label,
        credits_burned=candidate.credits_burned,
        ingestion_source="captured",
        capture_status="active",
        owner_user_id=record_owner_user_id,
        ownership_status="resolved" if record_owner_user_id else "unknown",
        ownership_source="usage_event_user_id" if record_owner_user_id else None,
        source_usage_event_id=candidate.usage_event_id,
        metadata_json=_merge_generation_record_metadata(
            {},
            candidate.metadata_json,
            action="create",
            candidate=candidate,
            source_usage_event_id_conflict=False,
        ),
        created_at=candidate.created_at or datetime.utcnow(),
        updated_at=datetime.utcnow(),
    )
    try:
        with session.begin_nested():
            session.add(record)
            session.flush()
        result.created = True
        result.record_id = record.id
        return result
    except IntegrityError:
        existing = _find_generation_record_for_candidate(session, candidate)
        if not existing:
            result.skipped = True
            result.skip_reason = "integrity_conflict"
            result.error_message = "IntegrityError"
            return result
        try:
            with session.begin_nested():
                _apply_candidate_to_generation_record(existing, candidate, action="update_after_conflict", assign_owner=assign_owner)
                session.add(existing)
                session.flush()
            result.updated = True
            result.record_id = existing.id
            return result
        except IntegrityError as exc:
            logger.warning(
                "Generation normalization conflict fallback failed for usage event id=%s: %s",
                usage_event.id,
                exc.__class__.__name__,
            )
            result.skipped = True
            result.skip_reason = "integrity_conflict"
            result.error_message = exc.__class__.__name__
            return result


def run_generation_records_backfill(
    session: Session,
    *,
    apply: bool = False,
    batch_size: int = 500,
    max_rows: Optional[int] = None,
    start_after_id: int = 0,
    logger: Optional[logging.Logger] = None,
) -> BackfillSummary:
    logger = logger or LOGGER
    _ensure_generation_tables_exist(session)
    summary = BackfillSummary(
        apply_mode=apply,
        batch_size=max(1, batch_size),
        start_after_id=max(0, start_after_id),
        max_rows=max_rows if max_rows and max_rows > 0 else None,
    )

    kling_tool_ids = [
        tool_id
        for (tool_id,) in session.query(ITPortalTool.id)
        .filter(ITPortalTool.slug.in_(KLING_TOOL_SLUGS))
        .all()
    ]
    summary.kling_tool_ids = kling_tool_ids
    if not kling_tool_ids:
        logger.warning("No Kling tool IDs found. Backfill exiting without changes.")
        return summary

    last_id = summary.start_after_id
    processed = 0

    while True:
        remaining = None if summary.max_rows is None else max(summary.max_rows - processed, 0)
        if remaining == 0:
            break
        current_limit = summary.batch_size if remaining is None else min(summary.batch_size, remaining)
        rows = (
            session.query(ITPortalToolUsageEvent)
            .filter(
                ITPortalToolUsageEvent.tool_id.in_(kling_tool_ids),
                ITPortalToolUsageEvent.id > last_id,
            )
            .order_by(ITPortalToolUsageEvent.id.asc())
            .limit(current_limit)
            .all()
        )
        if not rows:
            break

        last_id = rows[-1].id
        summary.last_processed_id = last_id
        processed += len(rows)

        batch_candidates: list[BackfillCandidate] = []
        for row in rows:
            summary.scanned_rows += 1
            try:
                candidate = _build_candidate(row)
            except Exception as exc:  # pragma: no cover - safety path
                summary.malformed_rows += 1
                if len(summary.error_samples) < 10:
                    summary.error_samples.append(f"row={row.id} error={exc}")
                logger.warning("Skipping malformed usage event id=%s: %s", row.id, exc)
                continue

            if candidate is None:
                summary.skipped_non_generation += 1
                continue

            summary.generation_candidates += 1
            if candidate.confidence == "high":
                summary.candidate_confidence_high += 1
            elif candidate.confidence == "medium":
                summary.candidate_confidence_medium += 1

            if not (
                candidate.provider_task_id
                or candidate.provider_generation_id
                or candidate.canonical_asset_key
            ):
                summary.skipped_no_identity += 1
                continue

            batch_candidates.append(candidate)

        if not batch_candidates:
            logger.info(
                "Backfill batch complete: last_id=%s scanned=%s inserted=%s would_insert=%s",
                summary.last_processed_id,
                summary.scanned_rows,
                summary.inserted,
                summary.would_insert,
            )
            continue

        existing_source_ids, existing_task_keys, existing_generation_keys, existing_asset_keys = _prefetch_existing_identities(session, batch_candidates)
        seen_source_ids = set(existing_source_ids)
        seen_task_keys = set(existing_task_keys)
        seen_generation_keys = set(existing_generation_keys)
        seen_asset_keys = set(existing_asset_keys)

        for candidate in batch_candidates:
            if candidate.usage_event_id in seen_source_ids:
                summary.duplicate_source_usage_event += 1
                continue

            task_key = ("kling", candidate.provider_task_id) if candidate.provider_task_id else None
            generation_key = ("kling", candidate.provider_generation_id) if candidate.provider_generation_id else None
            asset_key = ("kling", candidate.canonical_asset_key) if candidate.canonical_asset_key else None
            if (
                (task_key and task_key in seen_task_keys)
                or (generation_key and generation_key in seen_generation_keys)
                or (asset_key and asset_key in seen_asset_keys)
            ):
                summary.duplicate_identity += 1
                continue

            if not apply:
                summary.would_insert += 1
                if candidate.owner_user_id:
                    summary.owner_assigned += 1
                seen_source_ids.add(candidate.usage_event_id)
                if task_key:
                    seen_task_keys.add(task_key)
                if generation_key:
                    seen_generation_keys.add(generation_key)
                if asset_key:
                    seen_asset_keys.add(asset_key)
                continue

            record = GenerationRecord(
                provider="kling",
                provider_task_id=candidate.provider_task_id,
                provider_generation_id=candidate.provider_generation_id,
                canonical_asset_url=candidate.canonical_asset_url,
                canonical_asset_key=candidate.canonical_asset_key,
                prompt_text=candidate.prompt_text,
                model_label=candidate.model_label,
                duration_label=candidate.duration_label,
                resolution_label=candidate.resolution_label,
                credits_burned=candidate.credits_burned,
                ingestion_source="captured",
                capture_status="active",
                owner_user_id=candidate.owner_user_id,
                ownership_status="resolved" if candidate.owner_user_id else "unknown",
                ownership_source="usage_event_user_id" if candidate.owner_user_id else None,
                source_usage_event_id=candidate.usage_event_id,
                metadata_json=candidate.metadata_json,
                created_at=candidate.created_at or datetime.utcnow(),
                updated_at=candidate.created_at or datetime.utcnow(),
            )
            try:
                with session.begin_nested():
                    session.add(record)
                    session.flush()
                summary.inserted += 1
                if candidate.owner_user_id:
                    summary.owner_assigned += 1
                seen_source_ids.add(candidate.usage_event_id)
                if task_key:
                    seen_task_keys.add(task_key)
                if generation_key:
                    seen_generation_keys.add(generation_key)
                if asset_key:
                    seen_asset_keys.add(asset_key)
            except IntegrityError as exc:
                summary.duplicate_identity += 1
                if len(summary.error_samples) < 10:
                    summary.error_samples.append(f"row={candidate.usage_event_id} integrity={exc.__class__.__name__}")
                logger.warning(
                    "Skipping usage event id=%s due to integrity conflict during backfill.",
                    candidate.usage_event_id,
                )

        if apply:
            session.commit()
        else:
            session.rollback()

        logger.info(
            "Backfill batch complete: last_id=%s scanned=%s inserted=%s would_insert=%s duplicates=%s malformed=%s",
            summary.last_processed_id,
            summary.scanned_rows,
            summary.inserted,
            summary.would_insert,
            summary.duplicate_identity + summary.duplicate_source_usage_event,
            summary.malformed_rows,
        )

    return summary
