from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date, datetime
from typing import Optional

from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from models_new import GenerationRecord, GenerationRecoveryAudit, ITPortalTool, ITPortalToolUsageEvent, User
from utils.generation_backfill import (
    BackfillCandidate,
    KLING_TOOL_SLUGS,
    _build_candidate,
    _find_generation_record_for_candidate,
    _merge_generation_record_metadata,
)
from utils.generation_recovery_observability import emit_recovery_log

MISSING_REASON_NO_GENERATION_RECORD = "no_generation_record"
RECOVERY_SOURCE_LOCAL_CAPTURE_RECONCILIATION = "local_capture_reconciliation"


@dataclass
class ReconciliationAnalysis:
    provider: str
    date_from: date
    date_to: date
    kling_count: int = 0
    database_count: int = 0
    missing_count: int = 0
    captured_count: int = 0
    recovered_count: int = 0
    capture_success_rate: float = 0.0
    malformed_count: int = 0
    skipped_non_generation: int = 0
    skipped_no_identity: int = 0
    duplicate_source_count: int = 0
    accepted_candidates: list[BackfillCandidate] = field(default_factory=list)
    missing_candidates: list[BackfillCandidate] = field(default_factory=list)

    def summary_dict(self) -> dict:
        return {
            "provider": self.provider,
            "date_from": self.date_from.isoformat(),
            "date_to": self.date_to.isoformat(),
            "kling_count": self.kling_count,
            "database_count": self.database_count,
            "missing_count": self.missing_count,
            "captured_count": self.captured_count,
            "recovered_count": self.recovered_count,
            "capture_success_rate": self.capture_success_rate,
            "malformed_count": self.malformed_count,
            "skipped_non_generation": self.skipped_non_generation,
            "skipped_no_identity": self.skipped_no_identity,
            "duplicate_source_count": self.duplicate_source_count,
        }


@dataclass
class RecoveryImportSummary:
    audit_id: int
    snapshot_candidate_count: int = 0
    imported_count: int = 0
    duplicate_count: int = 0
    invalid_identity_count: int = 0
    malformed_count: int = 0
    non_importable_count: int = 0
    skipped_count: int = 0
    completed_at: Optional[datetime] = None

    def to_dict(self) -> dict:
        return {
            "audit_id": self.audit_id,
            "snapshot_candidate_count": self.snapshot_candidate_count,
            "imported_count": self.imported_count,
            "duplicate_count": self.duplicate_count,
            "invalid_identity_count": self.invalid_identity_count,
            "malformed_count": self.malformed_count,
            "non_importable_count": self.non_importable_count,
            "skipped_count": self.skipped_count,
            "completed_at": self.completed_at.isoformat() if self.completed_at else None,
        }


def parse_recovery_date_range(date_from_raw: str, date_to_raw: Optional[str] = None) -> tuple[date, date]:
    try:
        parsed_from = date.fromisoformat((date_from_raw or "").strip())
    except ValueError as exc:
        raise ValueError("date_from must be in YYYY-MM-DD format") from exc
    if date_to_raw:
        try:
            parsed_to = date.fromisoformat(date_to_raw.strip())
        except ValueError as exc:
            raise ValueError("date_to must be in YYYY-MM-DD format") from exc
    else:
        parsed_to = parsed_from
    if parsed_to < parsed_from:
        raise ValueError("date_to must be greater than or equal to date_from")
    return parsed_from, parsed_to


def _confidence_rank(value: str) -> int:
    if value == "high":
        return 2
    if value == "medium":
        return 1
    return 0


def _dedupe_source_candidates(candidates: list[BackfillCandidate]) -> tuple[list[BackfillCandidate], int]:
    accepted: list[BackfillCandidate] = []
    seen_task_ids: set[str] = set()
    seen_generation_ids: set[str] = set()
    seen_asset_keys: set[str] = set()
    duplicate_count = 0

    ordered = sorted(
        candidates,
        key=lambda candidate: (
            _confidence_rank(candidate.confidence),
            len(candidate.signals),
            candidate.created_at or datetime.min,
            candidate.usage_event_id,
        ),
        reverse=True,
    )
    for candidate in ordered:
        if (
            (candidate.provider_task_id and candidate.provider_task_id in seen_task_ids)
            or (candidate.provider_generation_id and candidate.provider_generation_id in seen_generation_ids)
            or (candidate.canonical_asset_key and candidate.canonical_asset_key in seen_asset_keys)
        ):
            duplicate_count += 1
            continue
        accepted.append(candidate)
        if candidate.provider_task_id:
            seen_task_ids.add(candidate.provider_task_id)
        if candidate.provider_generation_id:
            seen_generation_ids.add(candidate.provider_generation_id)
        if candidate.canonical_asset_key:
            seen_asset_keys.add(candidate.canonical_asset_key)
    accepted.sort(key=lambda candidate: (candidate.created_at or datetime.min, candidate.usage_event_id))
    return accepted, duplicate_count


def _prefetch_matching_record_maps(
    session: Session,
    candidates: list[BackfillCandidate],
) -> tuple[
    dict[int, GenerationRecord],
    dict[str, GenerationRecord],
    dict[str, GenerationRecord],
    dict[str, GenerationRecord],
]:
    source_ids = [candidate.usage_event_id for candidate in candidates]
    task_ids = [candidate.provider_task_id for candidate in candidates if candidate.provider_task_id]
    generation_ids = [candidate.provider_generation_id for candidate in candidates if candidate.provider_generation_id]
    asset_keys = [candidate.canonical_asset_key for candidate in candidates if candidate.canonical_asset_key]

    records = (
        session.query(GenerationRecord)
        .filter(
            (
                GenerationRecord.source_usage_event_id.in_(source_ids)
                if source_ids
                else False
            )
            | (
                (GenerationRecord.provider == "kling")
                & (GenerationRecord.provider_task_id.in_(task_ids) if task_ids else False)
            )
            | (
                (GenerationRecord.provider == "kling")
                & (GenerationRecord.provider_generation_id.in_(generation_ids) if generation_ids else False)
            )
            | (
                (GenerationRecord.provider == "kling")
                & (GenerationRecord.canonical_asset_key.in_(asset_keys) if asset_keys else False)
            )
        )
        .all()
    )
    source_map: dict[int, GenerationRecord] = {}
    task_map: dict[str, GenerationRecord] = {}
    generation_map: dict[str, GenerationRecord] = {}
    asset_map: dict[str, GenerationRecord] = {}
    for record in records:
        if record.source_usage_event_id is not None and record.source_usage_event_id not in source_map:
            source_map[record.source_usage_event_id] = record
        if record.provider_task_id and record.provider_task_id not in task_map:
            task_map[record.provider_task_id] = record
        if record.provider_generation_id and record.provider_generation_id not in generation_map:
            generation_map[record.provider_generation_id] = record
        if record.canonical_asset_key and record.canonical_asset_key not in asset_map:
            asset_map[record.canonical_asset_key] = record
    return source_map, task_map, generation_map, asset_map


def _matching_record_for_candidate(
    candidate: BackfillCandidate,
    source_map: dict[int, GenerationRecord],
    task_map: dict[str, GenerationRecord],
    generation_map: dict[str, GenerationRecord],
    asset_map: dict[str, GenerationRecord],
) -> Optional[GenerationRecord]:
    if candidate.usage_event_id in source_map:
        return source_map[candidate.usage_event_id]
    if candidate.provider_task_id and candidate.provider_task_id in task_map:
        return task_map[candidate.provider_task_id]
    if candidate.provider_generation_id and candidate.provider_generation_id in generation_map:
        return generation_map[candidate.provider_generation_id]
    if candidate.canonical_asset_key and candidate.canonical_asset_key in asset_map:
        return asset_map[candidate.canonical_asset_key]
    return None


def analyze_generation_reconciliation(
    session: Session,
    *,
    date_from: date,
    date_to: date,
) -> ReconciliationAnalysis:
    kling_tool_ids = [
        tool_id
        for (tool_id,) in session.query(ITPortalTool.id)
        .filter(ITPortalTool.slug.in_(KLING_TOOL_SLUGS))
        .all()
    ]
    analysis = ReconciliationAnalysis(provider="kling", date_from=date_from, date_to=date_to)
    if not kling_tool_ids:
        return analysis

    source_rows = (
        session.query(ITPortalToolUsageEvent)
        .filter(
            ITPortalToolUsageEvent.tool_id.in_(kling_tool_ids),
            ITPortalToolUsageEvent.event_date >= date_from,
            ITPortalToolUsageEvent.event_date <= date_to,
        )
        .order_by(ITPortalToolUsageEvent.created_at.asc(), ITPortalToolUsageEvent.id.asc())
        .all()
    )

    raw_candidates: list[BackfillCandidate] = []
    for row in source_rows:
        try:
            candidate = _build_candidate(row)
        except Exception:
            analysis.malformed_count += 1
            continue
        if candidate is None:
            analysis.skipped_non_generation += 1
            continue
        if not (
            candidate.provider_task_id
            or candidate.provider_generation_id
            or candidate.canonical_asset_key
        ):
            analysis.skipped_no_identity += 1
            continue
        raw_candidates.append(candidate)

    accepted_candidates, duplicate_count = _dedupe_source_candidates(raw_candidates)
    analysis.accepted_candidates = accepted_candidates
    analysis.duplicate_source_count = duplicate_count
    analysis.kling_count = len(accepted_candidates)

    if not accepted_candidates:
        return analysis

    source_map, task_map, generation_map, asset_map = _prefetch_matching_record_maps(session, accepted_candidates)
    for candidate in accepted_candidates:
        record = _matching_record_for_candidate(candidate, source_map, task_map, generation_map, asset_map)
        if record is None:
            analysis.missing_candidates.append(candidate)
            continue
        analysis.database_count += 1
        if record.ingestion_source == "recovered":
            analysis.recovered_count += 1
        else:
            analysis.captured_count += 1

    analysis.missing_count = len(analysis.missing_candidates)
    analysis.capture_success_rate = round(
        (analysis.database_count / analysis.kling_count) * 100.0,
        2,
    ) if analysis.kling_count else 100.0

    # Temporary stage-by-stage tracing for the missing-generations investigation.
    # Reconciliation only ever sees ITPortalToolUsageEvent rows — it has no
    # path to the live Kling API or the extension's in-page cache. If
    # source_rows is 0 here, no usage events were ever captured for this
    # date range, which is upstream of reconciliation entirely.
    emit_recovery_log(
        "generation_reconciliation_stage_counts",
        date_from=date_from.isoformat(),
        date_to=date_to.isoformat(),
        raw_usage_event_rows=len(source_rows),
        malformed_count=analysis.malformed_count,
        skipped_non_generation=analysis.skipped_non_generation,
        skipped_no_identity=analysis.skipped_no_identity,
        deduped_kling_candidates=analysis.kling_count,
        duplicate_source_count=analysis.duplicate_source_count,
        database_count=analysis.database_count,
        missing_count=analysis.missing_count,
    )
    return analysis


def _load_candidate_owner_lookup(session: Session, candidates: list[BackfillCandidate]) -> dict[int, User]:
    owner_ids = sorted({candidate.owner_user_id for candidate in candidates if candidate.owner_user_id})
    if not owner_ids:
        return {}
    return {
        user.id: user
        for user in session.query(User)
        .filter(User.id.in_(owner_ids))
        .all()
    }


def _serialize_missing_candidate(
    candidate: BackfillCandidate,
    *,
    owner_lookup: Optional[dict[int, User]] = None,
) -> dict:
    owner_lookup = owner_lookup or {}
    owner = owner_lookup.get(candidate.owner_user_id or 0)
    return {
        "source_usage_event_id": candidate.usage_event_id,
        "provider_task_id": candidate.provider_task_id,
        "provider_generation_id": candidate.provider_generation_id,
        "canonical_asset_url": candidate.canonical_asset_url,
        "canonical_asset_key": candidate.canonical_asset_key,
        "created_at": candidate.created_at.isoformat() if candidate.created_at else None,
        "prompt": candidate.prompt_text,
        "model_label": candidate.model_label,
        "duration_label": candidate.duration_label,
        "resolution_label": candidate.resolution_label,
        "credits_burned": candidate.credits_burned,
        "confidence": candidate.confidence,
        "missing_reason": MISSING_REASON_NO_GENERATION_RECORD,
        "candidate_owner_user_id": candidate.owner_user_id,
        "candidate_owner": (
            {
                "user_id": owner.id,
                "name": owner.name,
            }
            if owner
            else None
        ),
    }


def build_missing_candidate_snapshot(candidates: list[BackfillCandidate]) -> list[dict]:
    return [
        {
            "source_usage_event_id": candidate.usage_event_id,
            "provider_task_id": candidate.provider_task_id,
            "provider_generation_id": candidate.provider_generation_id,
            "canonical_asset_key": candidate.canonical_asset_key,
            "missing_reason": MISSING_REASON_NO_GENERATION_RECORD,
            "confidence": candidate.confidence,
            "created_at": candidate.created_at.isoformat() if candidate.created_at else None,
        }
        for candidate in candidates
    ]


def build_recovery_audit_report(
    analysis: ReconciliationAnalysis,
    *,
    preview_count: Optional[int] = None,
) -> dict:
    report = analysis.summary_dict()
    report["missing_candidates"] = build_missing_candidate_snapshot(analysis.missing_candidates)
    if preview_count is not None:
        report["preview_count"] = preview_count
    return report


def missing_candidate_preview(
    session: Session,
    candidates: list[BackfillCandidate],
    *,
    limit: int = 100,
    offset: int = 0,
) -> list[dict]:
    slice_candidates = candidates[offset: offset + limit]
    owner_lookup = _load_candidate_owner_lookup(session, slice_candidates)
    return [
        _serialize_missing_candidate(candidate, owner_lookup=owner_lookup)
        for candidate in slice_candidates
    ]


def create_generation_recovery_audit(
    session: Session,
    *,
    requested_by_admin_id: int,
    action_type: str,
    date_from: date,
    date_to: date,
    analysis: ReconciliationAnalysis,
    filters_json: Optional[dict] = None,
    report_json: Optional[dict] = None,
) -> GenerationRecoveryAudit:
    now = datetime.utcnow()
    audit = GenerationRecoveryAudit(
        provider="kling",
        action_type=action_type,
        requested_by_admin_id=requested_by_admin_id,
        date_from=date_from,
        date_to=date_to,
        kling_count=analysis.kling_count,
        database_count=analysis.database_count,
        missing_count=analysis.missing_count,
        imported_count=0,
        duplicate_count=analysis.duplicate_source_count,
        status="completed",
        filters_json=filters_json or {},
        report_json=report_json or build_recovery_audit_report(analysis),
        started_at=now,
        completed_at=now,
        created_at=now,
    )
    session.add(audit)
    session.commit()
    session.refresh(audit)
    return audit


def _snapshot_has_valid_identity(snapshot_item: dict) -> bool:
    return bool(
        snapshot_item.get("provider_task_id")
        or snapshot_item.get("provider_generation_id")
        or snapshot_item.get("canonical_asset_key")
    )


def import_generation_recovery_audit(
    session: Session,
    *,
    audit_id: int,
    requested_by_admin_id: int,
) -> tuple[GenerationRecoveryAudit, RecoveryImportSummary]:
    audit = session.get(GenerationRecoveryAudit, audit_id)
    if audit is None:
        raise LookupError(f"Generation recovery audit {audit_id} was not found")

    report = dict(audit.report_json) if isinstance(audit.report_json, dict) else {}
    snapshot_items = report.get("missing_candidates")
    if not isinstance(snapshot_items, list):
        raise ValueError("Audit snapshot unavailable. Please run reconciliation again.")

    audit.status = "started"
    audit.error_message = None
    session.add(audit)
    session.commit()
    session.refresh(audit)

    summary = RecoveryImportSummary(audit_id=audit.id, snapshot_candidate_count=len(snapshot_items))
    imported_record_ids: list[int] = []
    try:
        for snapshot_item in snapshot_items:
            if not isinstance(snapshot_item, dict):
                summary.malformed_count += 1
                continue
            if snapshot_item.get("missing_reason") != MISSING_REASON_NO_GENERATION_RECORD:
                summary.non_importable_count += 1
                continue
            if not _snapshot_has_valid_identity(snapshot_item):
                summary.invalid_identity_count += 1
                continue

            source_usage_event_id = snapshot_item.get("source_usage_event_id")
            try:
                source_usage_event_id = int(source_usage_event_id)
            except (TypeError, ValueError):
                summary.malformed_count += 1
                continue

            usage_event = session.get(ITPortalToolUsageEvent, source_usage_event_id)
            if usage_event is None:
                summary.malformed_count += 1
                continue

            try:
                candidate = _build_candidate(usage_event)
            except Exception:
                summary.malformed_count += 1
                continue

            if candidate is None:
                summary.malformed_count += 1
                continue
            if not (
                candidate.provider_task_id
                or candidate.provider_generation_id
                or candidate.canonical_asset_key
            ):
                summary.invalid_identity_count += 1
                continue

            existing = _find_generation_record_for_candidate(session, candidate)
            if existing is not None:
                summary.duplicate_count += 1
                continue

            recovered_at = datetime.utcnow()
            metadata_json = _merge_generation_record_metadata(
                {},
                candidate.metadata_json,
                action="recover_import",
                candidate=candidate,
                source_usage_event_id_conflict=False,
            )
            metadata_json["recovery_source"] = RECOVERY_SOURCE_LOCAL_CAPTURE_RECONCILIATION
            metadata_json["recoveryImport"] = {
                "auditId": audit.id,
                "importedAt": recovered_at.isoformat(),
                "requestedByAdminId": requested_by_admin_id,
                "missingReason": snapshot_item.get("missing_reason"),
                "snapshotSourceUsageEventId": source_usage_event_id,
            }
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
                ingestion_source="recovered",
                capture_status="active",
                owner_user_id=None,
                ownership_status="unknown",
                ownership_source=None,
                project_id=None,
                source_usage_event_id=candidate.usage_event_id,
                recovery_audit_id=audit.id,
                recovered_by_admin_id=requested_by_admin_id,
                recovered_at=recovered_at,
                metadata_json=metadata_json,
                created_at=candidate.created_at or recovered_at,
                updated_at=recovered_at,
            )
            try:
                with session.begin_nested():
                    session.add(record)
                    session.flush()
                imported_record_ids.append(record.id)
                summary.imported_count += 1
            except IntegrityError:
                summary.duplicate_count += 1

        summary.skipped_count = (
            summary.duplicate_count
            + summary.invalid_identity_count
            + summary.malformed_count
            + summary.non_importable_count
        )
        summary.completed_at = datetime.utcnow()

        existing_import_runs = report.get("import_runs")
        report["import_runs"] = list(existing_import_runs) if isinstance(existing_import_runs, list) else []
        report["import_runs"].append(
            {
                **summary.to_dict(),
                "imported_record_ids": imported_record_ids,
            }
        )
        report["last_import_summary"] = summary.to_dict()
        audit.report_json = report
        audit.imported_count = (
            session.query(GenerationRecord)
            .filter(GenerationRecord.recovery_audit_id == audit.id)
            .count()
        )
        audit.duplicate_count = summary.duplicate_count
        audit.status = "completed"
        audit.completed_at = summary.completed_at
        audit.error_message = None
        session.add(audit)
        session.commit()
        session.refresh(audit)
        return audit, summary
    except Exception as exc:
        audit.status = "failed"
        audit.error_message = str(exc)
        audit.completed_at = datetime.utcnow()
        session.add(audit)
        session.commit()
        raise
