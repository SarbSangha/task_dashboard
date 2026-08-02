"""Regression cover for the four normalization fixes:

  1. GenerationRecord.capture_status is derived from FreepikGeneration.status
     (it used to stay at the "active" model default, pinning every Freepik
     success-rate KPI at 100%).
  3. A thinner or older snapshot of an already-normalized creation never walks
     stored columns back to null (the extension deliberately reports the same
     creation twice - "processing" then "completed" - and nothing guarantees
     they arrive in that order).
  6. One FreepikGeneration can only ever own one GenerationRecord, even when
     the first snapshot carries `identifier` and a later one adds `creation_id`.
  7. _parse_dt converts an offset-aware timestamp to UTC instead of stripping
     the offset in place.

Run: python tests/freepik_normalization_smoke.py
"""
import os
import sys
from datetime import datetime
from pathlib import Path

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
    GenerationCollectionMember,
    GenerationProjectEvent,
    GenerationRecord,
    GenerationTag,
    ITPortalTool,
    User,
)
from providers.freepik.models import FreepikCaptureEvent, FreepikGeneration  # noqa: E402
from providers.freepik.normalization import _parse_dt, backfill_all, normalize_capture_event  # noqa: E402
from merge_duplicate_freepik_generation_records import run as run_freepik_record_merge  # noqa: E402


engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
Base.metadata.create_all(
    bind=engine,
    tables=[
        User.__table__,
        ITPortalTool.__table__,
        GenerationRecord.__table__,
        GenerationTag.__table__,
        GenerationCollectionMember.__table__,
        GenerationProjectEvent.__table__,
        FreepikCaptureEvent.__table__,
        FreepikGeneration.__table__,
    ],
)


def _assert(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def _seed_actor() -> tuple[int, int]:
    with SessionLocal() as db:
        user = User(email="freepik@example.com", name="Freepik User", hashed_password="x", is_active=True, is_deleted=False)
        tool = ITPortalTool(name="Freepik", slug="freepik", website_url="https://www.freepik.com", is_active=True)
        db.add_all([user, tool])
        db.commit()
        return user.id, tool.id


USER_ID, TOOL_ID = _seed_actor()


def _listing_row(*, creation_id=None, identifier=None, status, updated_at, credits=None, download_url=None):
    """One row of Freepik's "my creations" listing, shaped as content-freepik.js
    forwards it verbatim in `payload`."""
    creation = {"status": status, "updated_at": updated_at, "created_at": updated_at, "metadata": {}}
    if creation_id is not None:
        creation["id"] = creation_id
    if identifier is not None:
        creation["identifier"] = identifier
    if credits is not None:
        creation["metadata"]["creditLedgerTotals"] = {"credits": credits, "creditsEstimated": credits}
    row = {"creation": creation, "updated_at": updated_at}
    if download_url is not None:
        row["download_url"] = download_url
    return row


def _capture(db, payload: dict) -> FreepikCaptureEvent:
    event = FreepikCaptureEvent(
        tool_id=TOOL_ID,
        user_id=USER_ID,
        provider="freepik",
        event_type="generation_listing_row",
        client_event_id=f"freepik:test:{datetime.utcnow().timestamp()}:{len(payload)}",
        payload_json=payload,
        capture_version=1,
        event_date=datetime.utcnow().date(),
        ownership_confidence="ticket",
    )
    db.add(event)
    db.flush()
    return event


def test_capture_status_tracks_provider_status() -> None:
    with SessionLocal() as db:
        gen = normalize_capture_event(db, _capture(db, _listing_row(
            creation_id="c-status", status="completed", updated_at="2026-07-02T10:00:00+00:00", credits=4.0,
        )))
        db.flush()
        record = db.query(GenerationRecord).filter(GenerationRecord.id == gen.generation_record_id).one()
        _assert(record.capture_status == "completed", f"expected completed, got {record.capture_status!r}")

        gen_failed = normalize_capture_event(db, _capture(db, _listing_row(
            creation_id="c-failed", status="failed", updated_at="2026-07-02T10:00:00+00:00",
        )))
        db.flush()
        failed_record = db.query(GenerationRecord).filter(GenerationRecord.id == gen_failed.generation_record_id).one()
        _assert(
            failed_record.capture_status == "failed",
            f"a failed generation must not sit in the success bucket, got {failed_record.capture_status!r}",
        )
        db.rollback()
    print("ok  capture_status tracks the provider's real status")


def test_stale_snapshot_does_not_erase_stored_columns() -> None:
    with SessionLocal() as db:
        # Completed snapshot lands first...
        normalize_capture_event(db, _capture(db, _listing_row(
            creation_id="c-order",
            status="completed",
            updated_at="2026-07-02T11:00:00+00:00",
            credits=7.5,
            download_url="https://cdn.freepik.test/final.png",
        )))
        db.flush()

        # ...then the earlier "processing" snapshot of the SAME creation is
        # delivered late by a retry. It carries no credits and no output URL.
        normalize_capture_event(db, _capture(db, _listing_row(
            creation_id="c-order", status="processing", updated_at="2026-07-02T10:00:00+00:00",
        )))
        db.flush()

        gen = db.query(FreepikGeneration).filter(FreepikGeneration.creation_id == "c-order").one()
        _assert(gen.credits_charged == 7.5, f"credits were clobbered by the stale snapshot: {gen.credits_charged!r}")
        _assert(gen.status == "completed", f"status regressed to {gen.status!r}")
        _assert(gen.download_url == "https://cdn.freepik.test/final.png", f"output url lost: {gen.download_url!r}")

        record = db.query(GenerationRecord).filter(GenerationRecord.id == gen.generation_record_id).one()
        _assert(record.credits_burned == 7.5, f"report credits lost: {record.credits_burned!r}")
        _assert(record.capture_status == "completed", f"report status regressed: {record.capture_status!r}")
        db.rollback()
    print("ok  a late/thin snapshot cannot erase a richer one")


def test_identifier_then_creation_id_reuses_one_record() -> None:
    with SessionLocal() as db:
        first = normalize_capture_event(db, _capture(db, _listing_row(
            identifier="ident-1", status="processing", updated_at="2026-07-02T12:00:00+00:00",
        )))
        db.flush()
        second = normalize_capture_event(db, _capture(db, _listing_row(
            creation_id="c-later", identifier="ident-1", status="completed",
            updated_at="2026-07-02T12:05:00+00:00", credits=2.0,
        )))
        db.flush()

        _assert(first.id == second.id, "the two snapshots should be one FreepikGeneration")
        record_count = (
            db.query(GenerationRecord)
            .filter(GenerationRecord.provider == "freepik", GenerationRecord.canonical_asset_key.in_(["ident-1", "c-later"]))
            .count()
        )
        _assert(record_count == 1, f"expected exactly one GenerationRecord, found {record_count}")
        db.rollback()
    print("ok  one generation maps to exactly one report record")


def test_parse_dt_converts_offsets_to_utc() -> None:
    _assert(_parse_dt("2026-07-02T11:27:02+00:00") == datetime(2026, 7, 2, 11, 27, 2), "UTC offset shape changed")
    _assert(_parse_dt("2026-07-02T11:27:02.000000Z") == datetime(2026, 7, 2, 11, 27, 2), "Z shape changed")
    _assert(
        _parse_dt("2026-07-02T17:00:00+05:30") == datetime(2026, 7, 2, 11, 30, 0),
        "a non-UTC offset must be converted, not stripped in place",
    )
    print("ok  _parse_dt normalizes to naive UTC")


def test_backfill_repairs_a_pre_fix_row() -> None:
    """scripts/backfill_freepik_normalization.py exists because the fixes are
    forward-only. Prove the replay actually repairs a row left in the old
    state: capture_status stuck at the "active" default on a failed
    generation."""
    with SessionLocal() as db:
        _capture(db, _listing_row(
            creation_id="c-backfill", status="failed", updated_at="2026-07-03T09:00:00+00:00",
        ))
        db.commit()

    with SessionLocal() as db:
        # Normalize once, then force the record back to exactly what the
        # pre-fix projection would have left behind.
        stats = backfill_all(db, batch_size=100)
        _assert(stats["errors"] == 0, f"backfill reported errors: {stats}")
        gen = db.query(FreepikGeneration).filter(FreepikGeneration.creation_id == "c-backfill").one()
        record = db.query(GenerationRecord).filter(GenerationRecord.id == gen.generation_record_id).one()
        record.capture_status = "active"
        db.commit()

    with SessionLocal() as db:
        stats = backfill_all(db, batch_size=100)
        _assert(stats["errors"] == 0, f"backfill reported errors: {stats}")
        _assert(stats["processed"] >= 1, f"backfill processed nothing: {stats}")
        gen = db.query(FreepikGeneration).filter(FreepikGeneration.creation_id == "c-backfill").one()
        record = db.query(GenerationRecord).filter(GenerationRecord.id == gen.generation_record_id).one()
        _assert(
            record.capture_status == "failed",
            f"backfill did not repair the stale capture_status, got {record.capture_status!r}",
        )
    print("ok  backfill replay repairs a pre-fix row")


def test_duplicate_record_merge() -> None:
    """The duplicate rows the OLD projection keying already created still sit
    in the database. Prove the merge script finds and collapses them, and that
    a dry run changes nothing."""
    with SessionLocal() as db:
        keep = GenerationRecord(
            provider="freepik", provider_generation_id="dup-ident",
            canonical_asset_key="dup-ident", created_at=datetime(2026, 7, 4, 9, 0, 0), credits_burned=None,
        )
        orphan = GenerationRecord(
            provider="freepik", provider_generation_id="dup-creation",
            canonical_asset_key="dup-creation", created_at=datetime(2026, 7, 4, 9, 5, 0), credits_burned=3.0,
        )
        db.add_all([keep, orphan])
        db.flush()
        gen = FreepikGeneration(
            provider="freepik", creation_id="dup-creation", identifier="dup-ident",
            generation_record_id=keep.id,
        )
        db.add(gen)
        db.commit()
        keep_id, orphan_id, gen_id = keep.id, orphan.id, gen.id

    with SessionLocal() as db:
        summary = run_freepik_record_merge(db, apply=False)
        _assert(summary["clustersFound"] == 1, f"dry run should find 1 cluster, found {summary['clustersFound']}")
        _assert(summary["rowsDeleted"] == 0, "a dry run must not delete anything")
    with SessionLocal() as db:
        still_there = db.query(GenerationRecord).filter(GenerationRecord.id.in_([keep_id, orphan_id])).count()
        _assert(still_there == 2, f"dry run mutated the database: {still_there} rows remain")

    with SessionLocal() as db:
        summary = run_freepik_record_merge(db, apply=True)
        _assert(summary["rowsDeleted"] == 1, f"expected 1 row deleted, got {summary['rowsDeleted']}")

    with SessionLocal() as db:
        remaining = db.query(GenerationRecord).filter(GenerationRecord.id.in_([keep_id, orphan_id])).all()
        _assert(len(remaining) == 1, f"expected one surviving record, got {len(remaining)}")
        _assert(remaining[0].id == keep_id, "the linked record should have been kept")
        _assert(
            remaining[0].credits_burned == 3.0,
            f"the orphan's credits should have merged onto the survivor, got {remaining[0].credits_burned!r}",
        )
        gen = db.query(FreepikGeneration).filter(FreepikGeneration.id == gen_id).one()
        _assert(gen.generation_record_id == keep_id, "generation should point at the surviving record")
    print("ok  duplicate report records merge (dry run is inert)")


def test_capture_batch_commits_and_isolates_duplicates() -> None:
    """ingest_capture_event no longer commits per event - it flushes inside a
    SAVEPOINT and the router owns the transaction, committing a chunk at a
    time. Prove the two properties that change bought us are still intact:
    every accepted event is durably committed, and a duplicate inside the
    batch unwinds by itself without taking its siblings with it."""
    import providers.freepik.router as freepik_router
    from providers.freepik.schemas import CaptureEventIn, CaptureEventsRequest

    with SessionLocal() as db:
        user = db.query(User).filter(User.id == USER_ID).one()
        tool = db.query(ITPortalTool).filter(ITPortalTool.id == TOOL_ID).one()

    original_tool, original_actor, original_credential = (
        freepik_router.resolve_freepik_tool,
        freepik_router.resolve_freepik_actor,
        freepik_router.resolve_freepik_credential,
    )
    freepik_router.resolve_freepik_tool = lambda _db: tool
    freepik_router.resolve_freepik_actor = lambda **_kw: user
    freepik_router.resolve_freepik_credential = lambda *_a, **_kw: None
    try:
        events = [
            CaptureEventIn(
                event_type="generation_listing_row",
                client_event_id=f"batch-{i}",
                payload=_listing_row(
                    creation_id=f"batch-c{i}", status="completed",
                    updated_at="2026-07-05T10:00:00+00:00", credits=1.0,
                ),
            )
            for i in range(5)
        ]
        # A repeat of an id already in the same batch.
        events.append(events[2].model_copy(deep=True))

        with SessionLocal() as db:
            response = freepik_router.capture_events(
                CaptureEventsRequest(events=events), request=None, db=db,
            )

        statuses = [r.status for r in response.results]
        _assert(statuses.count("created") == 5, f"expected 5 created, got {statuses}")
        _assert(statuses.count("duplicate") == 1, f"expected 1 duplicate, got {statuses}")

        # Fresh session: proves the work was really COMMITted, not just flushed.
        with SessionLocal() as db:
            persisted = (
                db.query(FreepikCaptureEvent)
                .filter(FreepikCaptureEvent.client_event_id.like("batch-%"))
                .count()
            )
            _assert(persisted == 5, f"expected 5 durable capture events, found {persisted}")
            normalized = (
                db.query(FreepikGeneration)
                .filter(FreepikGeneration.creation_id.like("batch-c%"))
                .count()
            )
            _assert(normalized == 5, f"expected 5 normalized generations, found {normalized}")
    finally:
        freepik_router.resolve_freepik_tool = original_tool
        freepik_router.resolve_freepik_actor = original_actor
        freepik_router.resolve_freepik_credential = original_credential
    print("ok  capture batch commits durably and isolates in-batch duplicates")


if __name__ == "__main__":
    test_capture_status_tracks_provider_status()
    test_stale_snapshot_does_not_erase_stored_columns()
    test_identifier_then_creation_id_reuses_one_record()
    test_parse_dt_converts_offsets_to_utc()
    test_backfill_repairs_a_pre_fix_row()
    test_duplicate_record_merge()
    test_capture_batch_commits_and_isolates_duplicates()
    print("\nall freepik normalization smoke checks passed")
