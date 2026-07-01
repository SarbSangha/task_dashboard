from time import perf_counter

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from database_config import get_operational_db
from models_new import GenerationRecoveryAudit, User
from utils.generation_recovery import (
    analyze_generation_reconciliation,
    build_recovery_audit_report,
    create_generation_recovery_audit,
    import_generation_recovery_audit,
    missing_candidate_preview,
    parse_recovery_date_range,
)
from utils.generation_recovery_observability import (
    IMPORT_DURATION_METRIC,
    PREVIEW_DURATION_METRIC,
    RECONCILIATION_DURATION_METRIC,
    classify_generation_recovery_error,
    emit_recovery_log,
    get_generation_recovery_metrics_snapshot,
    increment_metric,
    observe_duration,
)
from utils.permissions import require_admin


router = APIRouter(prefix="/api/admin/generation-recovery", tags=["Generation Recovery"])


def _clamp_limit(value: int, *, default: int, maximum: int) -> int:
    if value <= 0:
        return default
    return min(value, maximum)


def _parse_date_range_or_400(date_from: str, date_to: str | None = None):
    try:
        return parse_recovery_date_range(date_from, date_to)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


def _serialize_audit(audit: GenerationRecoveryAudit) -> dict:
    return {
        "id": audit.id,
        "provider": audit.provider,
        "action": audit.action_type,
        "requested_by_admin_id": audit.requested_by_admin_id,
        "date_from": audit.date_from.isoformat() if audit.date_from else None,
        "date_to": audit.date_to.isoformat() if audit.date_to else None,
        "kling_count": audit.kling_count,
        "database_count": audit.database_count,
        "missing_count": audit.missing_count,
        "imported_count": audit.imported_count,
        "duplicate_count": audit.duplicate_count,
        "status": audit.status,
        "filters": audit.filters_json or {},
        "report": audit.report_json or {},
        "error_message": audit.error_message,
        "started_at": audit.started_at.isoformat() if audit.started_at else None,
        "completed_at": audit.completed_at.isoformat() if audit.completed_at else None,
        "created_at": audit.created_at.isoformat() if audit.created_at else None,
    }


@router.get("/reconcile")
async def reconcile_generation_recovery(
    date_from: str = Query(..., description="Inclusive YYYY-MM-DD start date"),
    date_to: str | None = Query(None, description="Inclusive YYYY-MM-DD end date"),
    db: Session = Depends(get_operational_db),
    current_user: User = Depends(require_admin),
):
    started_at = perf_counter()
    increment_metric("total_reconciliations")
    emit_recovery_log(
        "generation_reconciliation_started",
        admin_user_id=current_user.id,
        date_from=date_from,
        date_to=date_to or date_from,
        status="started",
    )
    try:
        parsed_from, parsed_to = _parse_date_range_or_400(date_from, date_to)
        analysis = analyze_generation_reconciliation(
            db,
            date_from=parsed_from,
            date_to=parsed_to,
        )
        audit = create_generation_recovery_audit(
            db,
            requested_by_admin_id=current_user.id,
            action_type="reconcile",
            date_from=parsed_from,
            date_to=parsed_to,
            analysis=analysis,
            filters_json={"date_from": parsed_from.isoformat(), "date_to": parsed_to.isoformat()},
            report_json=build_recovery_audit_report(analysis),
        )
        duration_ms = int((perf_counter() - started_at) * 1000)
        observe_duration(RECONCILIATION_DURATION_METRIC, duration_ms)
        increment_metric("successful_reconciliations")
        payload = analysis.summary_dict()
        payload["audit_id"] = audit.id
        emit_recovery_log(
            "generation_reconciliation_completed",
            audit_id=audit.id,
            admin_user_id=current_user.id,
            date_from=parsed_from.isoformat(),
            date_to=parsed_to.isoformat(),
            kling_count=analysis.kling_count,
            database_count=analysis.database_count,
            missing_count=analysis.missing_count,
            capture_success_rate=analysis.capture_success_rate,
            duration_ms=duration_ms,
            status="success",
        )
        return {
            "success": True,
            "data": payload,
        }
    except Exception as exc:
        duration_ms = int((perf_counter() - started_at) * 1000)
        observe_duration(RECONCILIATION_DURATION_METRIC, duration_ms)
        increment_metric("reconciliation_failures")
        emit_recovery_log(
            "generation_reconciliation_failed",
            admin_user_id=getattr(current_user, "id", None),
            date_from=date_from,
            date_to=date_to or date_from,
            duration_ms=duration_ms,
            status="failed",
            error_classification=classify_generation_recovery_error(exc),
            error_message=str(exc),
        )
        raise


@router.get("/missing")
async def preview_missing_generations(
    date_from: str = Query(..., description="Inclusive YYYY-MM-DD start date"),
    date_to: str | None = Query(None, description="Inclusive YYYY-MM-DD end date"),
    limit: int = Query(100, ge=1, le=500),
    offset: int = Query(0, ge=0),
    db: Session = Depends(get_operational_db),
    current_user: User = Depends(require_admin),
):
    started_at = perf_counter()
    emit_recovery_log(
        "generation_missing_preview_started",
        admin_user_id=current_user.id,
        date_from=date_from,
        date_to=date_to or date_from,
        limit=limit,
        offset=offset,
        status="started",
    )
    try:
        parsed_from, parsed_to = _parse_date_range_or_400(date_from, date_to)
        resolved_limit = _clamp_limit(limit, default=100, maximum=500)
        analysis = analyze_generation_reconciliation(
            db,
            date_from=parsed_from,
            date_to=parsed_to,
        )
        preview_items = missing_candidate_preview(
            db,
            analysis.missing_candidates,
            limit=resolved_limit,
            offset=offset,
        )
        audit = create_generation_recovery_audit(
            db,
            requested_by_admin_id=current_user.id,
            action_type="preview_missing",
            date_from=parsed_from,
            date_to=parsed_to,
            analysis=analysis,
            filters_json={
                "date_from": parsed_from.isoformat(),
                "date_to": parsed_to.isoformat(),
                "limit": resolved_limit,
                "offset": offset,
            },
            report_json=build_recovery_audit_report(analysis, preview_count=len(preview_items)),
        )
        duration_ms = int((perf_counter() - started_at) * 1000)
        observe_duration(PREVIEW_DURATION_METRIC, duration_ms)
        emit_recovery_log(
            "generation_missing_preview_completed",
            audit_id=audit.id,
            admin_user_id=current_user.id,
            date_from=parsed_from.isoformat(),
            date_to=parsed_to.isoformat(),
            missing_count=analysis.missing_count,
            preview_count=len(preview_items),
            limit=resolved_limit,
            offset=offset,
            duration_ms=duration_ms,
            status="success",
        )
        return {
            "success": True,
            "data": preview_items,
            "pagination": {
                "limit": resolved_limit,
                "offset": offset,
                "total": analysis.missing_count,
            },
            "summary": analysis.summary_dict(),
            "audit_id": audit.id,
        }
    except Exception as exc:
        duration_ms = int((perf_counter() - started_at) * 1000)
        observe_duration(PREVIEW_DURATION_METRIC, duration_ms)
        emit_recovery_log(
            "generation_missing_preview_failed",
            admin_user_id=getattr(current_user, "id", None),
            date_from=date_from,
            date_to=date_to or date_from,
            limit=limit,
            offset=offset,
            duration_ms=duration_ms,
            status="failed",
            error_classification=classify_generation_recovery_error(exc),
            error_message=str(exc),
        )
        raise


@router.post("/import/{audit_id}")
async def import_missing_generations_from_audit(
    audit_id: int,
    db: Session = Depends(get_operational_db),
    current_user: User = Depends(require_admin),
):
    started_at = perf_counter()
    increment_metric("total_imports")
    emit_recovery_log(
        "generation_recovery_import_started",
        audit_id=audit_id,
        admin_user_id=current_user.id,
        status="started",
    )
    try:
        audit, summary = import_generation_recovery_audit(
            db,
            audit_id=audit_id,
            requested_by_admin_id=current_user.id,
        )
        duration_ms = int((perf_counter() - started_at) * 1000)
        observe_duration(IMPORT_DURATION_METRIC, duration_ms)
        increment_metric("successful_imports")
        increment_metric("duplicate_skips", summary.duplicate_count)
        increment_metric("invalid_identity_skips", summary.invalid_identity_count)
        emit_recovery_log(
            "generation_recovery_import_completed",
            audit_id=audit.id,
            admin_user_id=current_user.id,
            imported_count=summary.imported_count,
            skipped_duplicates=summary.duplicate_count,
            skipped_invalid_identity=summary.invalid_identity_count,
            skipped_malformed=summary.malformed_count,
            skipped_non_importable=summary.non_importable_count,
            failed_count=0,
            duration_ms=duration_ms,
            status="success",
        )
    except LookupError as exc:
        duration_ms = int((perf_counter() - started_at) * 1000)
        observe_duration(IMPORT_DURATION_METRIC, duration_ms)
        increment_metric("import_failures")
        emit_recovery_log(
            "generation_recovery_import_failed",
            audit_id=audit_id,
            admin_user_id=current_user.id,
            duration_ms=duration_ms,
            status="failed",
            error_classification=classify_generation_recovery_error(exc),
            error_message=str(exc),
        )
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ValueError as exc:
        duration_ms = int((perf_counter() - started_at) * 1000)
        observe_duration(IMPORT_DURATION_METRIC, duration_ms)
        increment_metric("import_failures")
        emit_recovery_log(
            "generation_recovery_import_failed",
            audit_id=audit_id,
            admin_user_id=current_user.id,
            duration_ms=duration_ms,
            status="failed",
            error_classification=classify_generation_recovery_error(exc),
            error_message=str(exc),
        )
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except Exception as exc:
        duration_ms = int((perf_counter() - started_at) * 1000)
        observe_duration(IMPORT_DURATION_METRIC, duration_ms)
        increment_metric("import_failures")
        emit_recovery_log(
            "generation_recovery_import_failed",
            audit_id=audit_id,
            admin_user_id=current_user.id,
            duration_ms=duration_ms,
            status="failed",
            error_classification=classify_generation_recovery_error(exc),
            error_message=str(exc),
        )
        raise
    return {
        "success": True,
        "data": summary.to_dict(),
        "audit": _serialize_audit(audit),
    }


@router.get("/audits")
async def list_generation_recovery_audits(
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
    db: Session = Depends(get_operational_db),
    current_user: User = Depends(require_admin),
):
    resolved_limit = _clamp_limit(limit, default=50, maximum=200)
    total = db.query(GenerationRecoveryAudit).count()
    audits = (
        db.query(GenerationRecoveryAudit)
        .order_by(GenerationRecoveryAudit.created_at.desc(), GenerationRecoveryAudit.id.desc())
        .offset(offset)
        .limit(resolved_limit)
        .all()
    )
    return {
        "success": True,
        "data": [_serialize_audit(audit) for audit in audits],
        "pagination": {
            "limit": resolved_limit,
            "offset": offset,
            "total": total,
        },
    }


@router.get("/metrics")
async def generation_recovery_metrics(
    current_user: User = Depends(require_admin),
):
    emit_recovery_log(
        "generation_recovery_metrics_requested",
        admin_user_id=current_user.id,
        status="success",
    )
    return {
        "success": True,
        "data": get_generation_recovery_metrics_snapshot(),
    }
