import asyncio
import os
import sys
from datetime import date, datetime, timezone
from pathlib import Path

from fastapi import HTTPException
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool


BACKEND_DIR = Path(__file__).resolve().parents[1]
os.environ.setdefault("DATABASE_URL", "postgresql://placeholder:placeholder@localhost:5432/placeholder")
os.environ.setdefault("ARCHIVE_DATABASE_URL", os.environ["DATABASE_URL"])
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from models_new import (  # noqa: E402
    Base,
    GenerationRecord,
    GenerationRecoveryAudit,
    ITPortalTool,
    ITPortalToolUsageEvent,
    User,
)
from routers.generation_recovery_router import (  # noqa: E402
    generation_recovery_metrics,
    import_missing_generations_from_audit,
    list_generation_recovery_audits,
    preview_missing_generations,
    reconcile_generation_recovery,
    router as generation_recovery_router,
)
from utils.generation_recovery_observability import reset_generation_recovery_metrics  # noqa: E402
from utils.permissions import require_admin  # noqa: E402


engine = create_engine(
    "sqlite://",
    connect_args={"check_same_thread": False},
    poolclass=StaticPool,
)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
Base.metadata.create_all(
    bind=engine,
    tables=[
        User.__table__,
        ITPortalTool.__table__,
        ITPortalToolUsageEvent.__table__,
        GenerationRecoveryAudit.__table__,
        GenerationRecord.__table__,
    ],
)


def _assert(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def _utc_now_naive() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


def _run(coro):
    return asyncio.run(coro)


def _create_user(*, email: str, name: str, is_admin: bool) -> int:
    with SessionLocal() as db:
        user = User(
            email=email,
            name=name,
            hashed_password="hashed-password",
            is_active=True,
            is_deleted=False,
            is_admin=is_admin,
            position="admin" if is_admin else "employee",
        )
        db.add(user)
        db.commit()
        db.refresh(user)
        return user.id


def _create_kling_tool() -> int:
    with SessionLocal() as db:
        tool = ITPortalTool(
            name="Kling",
            slug="kling",
            category="AI",
            website_url="https://kling.ai",
            is_active=True,
            status="active",
        )
        db.add(tool)
        db.commit()
        db.refresh(tool)
        return tool.id


def _create_usage_event(
    *,
    tool_id: int,
    user_id: int,
    task_id: str | None,
    event_day: date,
    prompt: str,
    created_at: datetime,
    metadata_json: dict | None = None,
) -> int:
    with SessionLocal() as db:
        event = ITPortalToolUsageEvent(
            tool_id=tool_id,
            user_id=user_id,
            event_type="generate_click",
            event_date=event_day,
            status="settled",
            prompt_text=prompt,
            generation_id=task_id,
            created_at=created_at,
            metadata_json=metadata_json if metadata_json is not None else {"generationMode": "video"},
        )
        db.add(event)
        db.commit()
        db.refresh(event)
        return event.id


def _create_generation_record(
    *,
    owner_user_id: int,
    task_id: str,
    created_at: datetime,
    ingestion_source: str,
) -> int:
    with SessionLocal() as db:
        record = GenerationRecord(
            provider="kling",
            provider_task_id=task_id,
            prompt_text=f"normalized {task_id}",
            ingestion_source=ingestion_source,
            capture_status="active",
            owner_user_id=owner_user_id,
            ownership_status="resolved",
            ownership_source="usage_event_user_id",
            metadata_json={},
            created_at=created_at,
            updated_at=created_at,
        )
        db.add(record)
        db.commit()
        db.refresh(record)
        return record.id


def _call_reconcile(admin_user_id: int, date_from: str, date_to: str | None = None):
    with SessionLocal() as db:
        admin = db.get(User, admin_user_id)
        return _run(
            reconcile_generation_recovery(
                date_from=date_from,
                date_to=date_to,
                db=db,
                current_user=admin,
            )
        )


def _call_missing(admin_user_id: int, date_from: str, date_to: str | None = None, limit: int = 100, offset: int = 0):
    with SessionLocal() as db:
        admin = db.get(User, admin_user_id)
        return _run(
            preview_missing_generations(
                date_from=date_from,
                date_to=date_to,
                limit=limit,
                offset=offset,
                db=db,
                current_user=admin,
            )
        )


def _call_audits(admin_user_id: int, limit: int = 50, offset: int = 0):
    with SessionLocal() as db:
        admin = db.get(User, admin_user_id)
        return _run(
            list_generation_recovery_audits(
                limit=limit,
                offset=offset,
                db=db,
                current_user=admin,
            )
        )


def _call_import(admin_user_id: int, audit_id: int):
    with SessionLocal() as db:
        admin = db.get(User, admin_user_id)
        return _run(
            import_missing_generations_from_audit(
                audit_id=audit_id,
                db=db,
                current_user=admin,
            )
        )


def _call_metrics(admin_user_id: int):
    with SessionLocal() as db:
        admin = db.get(User, admin_user_id)
        return _run(generation_recovery_metrics(current_user=admin))


def _create_recovery_audit(
    *,
    requested_by_admin_id: int,
    report_json: dict,
    event_day: date,
) -> int:
    with SessionLocal() as db:
        now = _utc_now_naive()
        audit = GenerationRecoveryAudit(
            provider="kling",
            action_type="reconcile",
            requested_by_admin_id=requested_by_admin_id,
            date_from=event_day,
            date_to=event_day,
            kling_count=1,
            database_count=0,
            missing_count=1,
            imported_count=0,
            duplicate_count=0,
            status="completed",
            filters_json={"date_from": event_day.isoformat(), "date_to": event_day.isoformat()},
            report_json=report_json,
            started_at=now,
            completed_at=now,
            created_at=now,
        )
        db.add(audit)
        db.commit()
        db.refresh(audit)
        return audit.id


def main() -> int:
    reset_generation_recovery_metrics()
    admin_id = _create_user(email="admin@example.com", name="Admin", is_admin=True)
    regular_id = _create_user(email="user@example.com", name="Regular User", is_admin=False)
    kling_tool_id = _create_kling_tool()

    for path in (
        "/api/admin/generation-recovery/reconcile",
        "/api/admin/generation-recovery/missing",
        "/api/admin/generation-recovery/import/{audit_id}",
        "/api/admin/generation-recovery/audits",
    ):
        route = next(route for route in generation_recovery_router.routes if getattr(route, "path", "") == path)
        dependency_calls = [dependency.call for dependency in route.dependant.dependencies]
        _assert(require_admin in dependency_calls, f"{path} should require admin authorization")
    print("PASS admin authorization wiring")

    _create_usage_event(
        tool_id=kling_tool_id,
        user_id=regular_id,
        task_id="1000000001",
        event_day=date(2026, 6, 20),
        prompt="Prompt A",
        created_at=datetime(2026, 6, 20, 9, 0, 0),
    )
    _create_usage_event(
        tool_id=kling_tool_id,
        user_id=regular_id,
        task_id="1000000002",
        event_day=date(2026, 6, 20),
        prompt="Prompt Missing",
        created_at=datetime(2026, 6, 20, 10, 0, 0),
    )
    _create_usage_event(
        tool_id=kling_tool_id,
        user_id=regular_id,
        task_id="1000000001",
        event_day=date(2026, 6, 20),
        prompt="Prompt A Duplicate",
        created_at=datetime(2026, 6, 20, 11, 0, 0),
    )
    _create_usage_event(
        tool_id=kling_tool_id,
        user_id=regular_id,
        task_id="1000000003",
        event_day=date(2026, 6, 21),
        prompt="Prompt Recovered",
        created_at=datetime(2026, 6, 21, 9, 0, 0),
    )
    _create_generation_record(
        owner_user_id=regular_id,
        task_id="1000000001",
        created_at=datetime(2026, 6, 20, 9, 30, 0),
        ingestion_source="captured",
    )
    _create_generation_record(
        owner_user_id=regular_id,
        task_id="1000000003",
        created_at=datetime(2026, 6, 21, 9, 30, 0),
        ingestion_source="recovered",
    )

    empty_reconcile = _call_reconcile(admin_id, "2026-06-19")
    _assert(empty_reconcile["data"]["kling_count"] == 0, "Empty reconciliation should report zero Kling count")
    _assert(empty_reconcile["data"]["missing_count"] == 0, "Empty reconciliation should report zero missing count")
    print("PASS empty reconciliation")

    day_reconcile = _call_reconcile(admin_id, "2026-06-20")
    day_data = day_reconcile["data"]
    _assert(day_data["kling_count"] == 2, f"Expected 2 unique raw Kling candidates for single day, got {day_data['kling_count']}")
    _assert(day_data["database_count"] == 1, f"Expected 1 normalized record for single day, got {day_data['database_count']}")
    _assert(day_data["missing_count"] == 1, f"Expected 1 missing candidate for single day, got {day_data['missing_count']}")
    _assert(day_data["duplicate_source_count"] == 1, f"Expected duplicate source count 1, got {day_data['duplicate_source_count']}")
    print("PASS single-day reconciliation")

    range_reconcile = _call_reconcile(admin_id, "2026-06-20", "2026-06-21")
    range_data = range_reconcile["data"]
    _assert(range_data["kling_count"] == 3, f"Expected 3 unique raw Kling candidates across range, got {range_data['kling_count']}")
    _assert(range_data["database_count"] == 2, f"Expected 2 matched generation records across range, got {range_data['database_count']}")
    _assert(range_data["missing_count"] == 1, f"Expected 1 missing candidate across range, got {range_data['missing_count']}")
    _assert(range_data["captured_count"] == 1, f"Expected captured_count=1, got {range_data['captured_count']}")
    _assert(range_data["recovered_count"] == 1, f"Expected recovered_count=1, got {range_data['recovered_count']}")
    print("PASS date-range reconciliation")

    missing_preview = _call_missing(admin_id, "2026-06-20", "2026-06-21")
    _assert(missing_preview["pagination"]["total"] == 1, "Missing preview should report one missing candidate")
    _assert(len(missing_preview["data"]) == 1, "Missing preview should return one item")
    _assert(missing_preview["data"][0]["provider_task_id"] == "1000000002", "Missing preview should include the unmatched task id")
    _assert(missing_preview["data"][0]["missing_reason"] == "no_generation_record", "Missing preview should expose the missing reason")
    _assert(missing_preview["data"][0]["candidate_owner"]["user_id"] == regular_id, "Missing preview should expose the candidate owner")
    print("PASS missing preview")

    reconcile_for_import = _call_reconcile(admin_id, "2026-06-20")
    import_audit_id = reconcile_for_import["data"]["audit_id"]
    import_response = _call_import(admin_id, import_audit_id)
    _assert(import_response["data"]["imported_count"] == 1, "Import should create one recovered generation record")
    _assert(import_response["data"]["duplicate_count"] == 0, "Initial import should not report duplicates")
    _assert(import_response["audit"]["imported_count"] == 1, "Audit should report one imported record after import")
    with SessionLocal() as db:
        imported_record = (
            db.query(GenerationRecord)
            .filter(GenerationRecord.provider_task_id == "1000000002")
            .first()
        )
        _assert(imported_record is not None, "Import should create a GenerationRecord for the missing task")
        _assert(imported_record.ingestion_source == "recovered", "Imported generation should be marked as recovered")
        _assert(imported_record.owner_user_id is None, "Recovered generation should not auto-assign an owner")
        _assert(imported_record.project_id is None, "Recovered generation should remain ungrouped")
        _assert(imported_record.ownership_status == "unknown", "Recovered generation should enter with unknown ownership")
        _assert(imported_record.recovery_audit_id == import_audit_id, "Imported generation should link back to the audit")
        _assert(imported_record.recovered_by_admin_id == admin_id, "Imported generation should record the importing admin")
        _assert(imported_record.metadata_json.get("recovery_source") == "local_capture_reconciliation", "Recovered metadata should record the recovery source")
    print("PASS recovery import success")

    duplicate_import_response = _call_import(admin_id, import_audit_id)
    _assert(duplicate_import_response["data"]["imported_count"] == 0, "Re-import should not create duplicate generation records")
    _assert(duplicate_import_response["data"]["duplicate_count"] == 1, "Re-import should report the already imported record as duplicate")
    _assert(duplicate_import_response["audit"]["imported_count"] == 1, "Audit imported_count should remain cumulative across reruns")
    print("PASS recovery import idempotency")

    invalid_identity_event_id = _create_usage_event(
        tool_id=kling_tool_id,
        user_id=regular_id,
        task_id=None,
        event_day=date(2026, 6, 23),
        prompt="Identity Missing",
        created_at=datetime(2026, 6, 23, 9, 0, 0),
        metadata_json={"generationMode": "video"},
    )
    invalid_identity_audit_id = _create_recovery_audit(
        requested_by_admin_id=admin_id,
        report_json={
            "missing_candidates": [
                {
                    "source_usage_event_id": invalid_identity_event_id,
                    "provider_task_id": None,
                    "provider_generation_id": None,
                    "canonical_asset_key": None,
                    "missing_reason": "no_generation_record",
                }
            ]
        },
        event_day=date(2026, 6, 23),
    )
    invalid_identity_response = _call_import(admin_id, invalid_identity_audit_id)
    _assert(invalid_identity_response["data"]["imported_count"] == 0, "Invalid-identity snapshot should not import a record")
    _assert(invalid_identity_response["data"]["invalid_identity_count"] == 1, "Invalid-identity snapshot should be counted explicitly")
    print("PASS invalid identity import tolerance")

    legacy_audit_id = _create_recovery_audit(
        requested_by_admin_id=admin_id,
        report_json={"capture_success_rate": 91.5},
        event_day=date(2026, 6, 24),
    )
    try:
        _call_import(admin_id, legacy_audit_id)
        raise AssertionError("Legacy audit import should raise HTTPException 409")
    except HTTPException as exc:
        _assert(exc.status_code == 409, f"Expected legacy audit import to return 409, got {exc.status_code}")
        _assert(
            exc.detail == "Audit snapshot unavailable. Please run reconciliation again.",
            f"Unexpected legacy audit import detail: {exc.detail}",
        )
    print("PASS legacy audit 409 handling")

    large_day = date(2026, 6, 22)
    for index in range(105):
        _create_usage_event(
            tool_id=kling_tool_id,
            user_id=regular_id,
            task_id=f"2000000{index:03d}",
            event_day=large_day,
            prompt=f"Missing {index}",
            created_at=datetime(2026, 6, 22, 12, 0, 0),
        )
    large_preview = _call_missing(admin_id, "2026-06-22")
    _assert(large_preview["pagination"]["total"] == 105, "Large preview should report full missing total")
    _assert(len(large_preview["data"]) == 100, "Large preview should honor the default limit of 100")
    print("PASS missing preview pagination")

    audits = _call_audits(admin_id)
    actions = [item["action"] for item in audits["data"]]
    _assert(len(actions) >= 5, f"Expected audit rows to be created for reconciliation and preview runs, got {len(actions)}")
    _assert("reconcile" in actions, "Audit history should include reconcile actions")
    _assert("preview_missing" in actions, "Audit history should include preview_missing actions")
    print("PASS audit creation and history")

    metrics = _call_metrics(admin_id)["data"]
    counters = metrics["counters"]
    _assert(counters["total_reconciliations"] >= 3, f"Expected reconciliation counter to be populated, got {counters}")
    _assert(counters["successful_reconciliations"] >= 3, f"Expected successful reconciliation counter to be populated, got {counters}")
    _assert(counters["total_imports"] >= 3, f"Expected import counter to be populated, got {counters}")
    _assert(counters["successful_imports"] >= 2, f"Expected successful import counter to be populated, got {counters}")
    _assert(counters["duplicate_skips"] >= 1, f"Expected duplicate skip counter to be populated, got {counters}")
    _assert(counters["invalid_identity_skips"] >= 1, f"Expected invalid identity skip counter to be populated, got {counters}")
    _assert(counters["import_failures"] >= 1, f"Expected import failure counter for legacy audits, got {counters}")
    _assert("reconciliation_duration_ms" in metrics["durations"], "Expected reconciliation duration metric to be recorded")
    _assert("import_duration_ms" in metrics["durations"], "Expected import duration metric to be recorded")
    print("PASS recovery observability metrics")

    engine.dispose()
    print("PHASE 4A/4B SMOKE TESTS PASSED")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
