"""Regression cover for providers/heygen/normalization.py's core guarantees,
mirroring backend/tests/freepik_normalization_smoke.py (this package's
template):

  1. GenerationRecord.capture_status is derived from HeygenGeneration.status,
     not left at the "active" model default.
  2. A thinner or older snapshot of an already-normalized generation never
     walks stored columns back to null (content-heygen.js deliberately
     reports the same generation twice - "submitted" then "settled" - and
     nothing guarantees they arrive in order).
  3. One HeygenGeneration can only ever own one GenerationRecord, even when
     the first snapshot carries only a job_id and a later one adds video_id.
  4. _parse_dt converts an offset-aware timestamp to UTC instead of stripping
     the offset in place.
  5. ingest_capture_event's SAVEPOINT-per-event/commit-per-chunk design still
     durably commits every accepted event and isolates an in-batch duplicate.

Run: python tests/heygen_normalization_smoke.py
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
from providers.heygen.models import HeygenCaptureEvent, HeygenGeneration  # noqa: E402
from providers.heygen.normalization import _parse_dt, backfill_all, normalize_capture_event  # noqa: E402


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
        HeygenCaptureEvent.__table__,
        HeygenGeneration.__table__,
    ],
)


def _assert(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def _seed_actor() -> tuple[int, int]:
    with SessionLocal() as db:
        user = User(email="heygen@example.com", name="HeyGen User", hashed_password="x", is_active=True, is_deleted=False)
        tool = ITPortalTool(name="HeyGen", slug="heygen", website_url="https://www.heygen.com", is_active=True)
        db.add_all([user, tool])
        db.commit()
        return user.id, tool.id


USER_ID, TOOL_ID = _seed_actor()


def _snapshot(*, video_id=None, job_id=None, status, updated_at, credits_used=None, video_url=None):
    """One captured HeyGen event payload, shaped as content-heygen.js's
    envelope (see normalization.py's module docstring)."""
    payload = {"status": status, "updatedAt": updated_at, "createdAt": updated_at}
    if video_id is not None:
        payload["videoId"] = video_id
    if job_id is not None:
        payload["jobId"] = job_id
    if credits_used is not None:
        payload["credits"] = {"used": credits_used}
    if video_url is not None:
        payload["output"] = {"videoUrl": video_url}
    return payload


def _capture(db, payload: dict) -> HeygenCaptureEvent:
    event = HeygenCaptureEvent(
        tool_id=TOOL_ID,
        user_id=USER_ID,
        provider="heygen",
        event_type="network_snapshot",
        client_event_id=f"heygen:test:{datetime.utcnow().timestamp()}:{len(payload)}",
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
        gen = normalize_capture_event(db, _capture(db, _snapshot(
            video_id="v-status", status="completed", updated_at="2026-07-02T10:00:00+00:00", credits_used=4.0,
        )))
        db.flush()
        record = db.query(GenerationRecord).filter(GenerationRecord.id == gen.generation_record_id).one()
        _assert(record.capture_status == "completed", f"expected completed, got {record.capture_status!r}")

        gen_failed = normalize_capture_event(db, _capture(db, _snapshot(
            video_id="v-failed", status="failed", updated_at="2026-07-02T10:00:00+00:00",
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
        normalize_capture_event(db, _capture(db, _snapshot(
            video_id="v-order",
            status="completed",
            updated_at="2026-07-02T11:00:00+00:00",
            credits_used=7.5,
            video_url="https://cdn.heygen.test/final.mp4",
        )))
        db.flush()

        # ...then the earlier "processing" snapshot of the SAME generation is
        # delivered late by a retry. It carries no credits and no output url.
        normalize_capture_event(db, _capture(db, _snapshot(
            video_id="v-order", status="processing", updated_at="2026-07-02T10:00:00+00:00",
        )))
        db.flush()

        gen = db.query(HeygenGeneration).filter(HeygenGeneration.video_id == "v-order").one()
        _assert(gen.credits_used == 7.5, f"credits were clobbered by the stale snapshot: {gen.credits_used!r}")
        _assert(gen.status == "completed", f"status regressed to {gen.status!r}")
        _assert(gen.video_url == "https://cdn.heygen.test/final.mp4", f"output url lost: {gen.video_url!r}")

        record = db.query(GenerationRecord).filter(GenerationRecord.id == gen.generation_record_id).one()
        _assert(record.credits_burned == 7.5, f"report credits lost: {record.credits_burned!r}")
        _assert(record.capture_status == "completed", f"report status regressed: {record.capture_status!r}")
        db.rollback()
    print("ok  a late/thin snapshot cannot erase a richer one")


def test_job_id_then_video_id_reuses_one_record() -> None:
    with SessionLocal() as db:
        first = normalize_capture_event(db, _capture(db, _snapshot(
            job_id="job-1", status="processing", updated_at="2026-07-02T12:00:00+00:00",
        )))
        db.flush()
        second = normalize_capture_event(db, _capture(db, _snapshot(
            video_id="v-later", job_id="job-1", status="completed",
            updated_at="2026-07-02T12:05:00+00:00", credits_used=2.0,
        )))
        db.flush()

        _assert(first.id == second.id, "the two snapshots should be one HeygenGeneration")
        record_count = (
            db.query(GenerationRecord)
            .filter(GenerationRecord.provider == "heygen", GenerationRecord.canonical_asset_key.in_(["job-1", "v-later"]))
            .count()
        )
        _assert(record_count == 1, f"expected exactly one GenerationRecord, found {record_count}")
        db.rollback()
    print("ok  one generation maps to exactly one report record")


def test_external_event_id_then_workflow_id_reuses_one_record_and_keeps_script() -> None:
    """Regression for the bug reported 2026-08-04: a "submitted" click carries
    only a client-side external_event_id (no real HeyGen id exists yet) and
    the script/avatar/voice DOM snapshot - it must not be silently skipped
    just because it lacks video_id/render_id/job_id/workflow_id. The later
    network_snapshot (which HAS a real workflow_id but no script text,
    matching HeyGen's actual queue-status response shape) must resolve to
    the SAME generation via the shared external_event_id, not mint an
    orphaned duplicate that never has the script."""
    with SessionLocal() as db:
        submitted = normalize_capture_event(db, _capture(db, {
            "externalEventId": "hgen_test_1",
            "scriptText": "Welcome to our product demo.",
            "status": "submitted",
        }))
        db.flush()
        _assert(submitted is not None, "a submit-time snapshot with only external_event_id must not be skipped")
        _assert(submitted.script_text == "Welcome to our product demo.", "script text lost on the submitted row")
        _assert(submitted.generation_record_id is None, "no real id yet - no GenerationRecord should exist")

        settled = normalize_capture_event(db, _capture(db, {
            "externalEventId": "hgen_test_1",
            "workflowId": "wf-real-id",
            "status": "processing",
            "progress": 16.5,
        }))
        db.flush()

        _assert(submitted.id == settled.id, "the submitted and network snapshots should be one HeygenGeneration")
        _assert(settled.script_text == "Welcome to our product demo.", "script text was lost once a real id arrived")
        _assert(settled.workflow_id == "wf-real-id", "workflow_id from the network snapshot was not merged in")

        record = db.query(GenerationRecord).filter(GenerationRecord.id == settled.generation_record_id).one()
        _assert(record.prompt_text == "Welcome to our product demo.", f"report row missing script text: {record.prompt_text!r}")
        db.rollback()
    print("ok  external_event_id correlates a submitted snapshot with its later network snapshot")


def test_real_listing_endpoint_shape_extracts_correctly() -> None:
    """Regression for the real HeyGen response shape confirmed 2026-08-04 from
    api2.heygen.com/v1/project/items (the listing endpoint providers/heygen/
    sync.py's docstring flagged as unconfirmed) - trimmed to the fields
    _extract_fields actually reads. Unlike our own DOM-scrape envelope, a real
    HeyGen response puts video_url/thumbnail_url/aspect_ratio top-level (not
    under an "output"/"videoConfig" wrapper) and the actual prompt under
    metadata.avatar_iv_meta.prompt, not a top-level "prompt" key."""
    with SessionLocal() as db:
        gen = normalize_capture_event(db, _capture(db, {
            "video_id": "3c4d2bb96f5f409b96a4fc5dc24ef893",
            "status": "completed",
            "duration": 7.70942,
            "aspect_ratio": "9:16",
            "created_ts": 1784541923,
            "updated_ts": 1784542075,
            "video_url": "https://files2.heygen.ai/example.mp4",
            "thumbnail_url": "https://dynamic.heygen.ai/example.jpeg",
            "metadata": {
                "avatar_iv_meta": {
                    "model": "4.3_seven_step_0925",
                    "prompt": "The woman maintains a steady, grounded presence.",
                    "resolution": "1080p",
                    "avatar_type": "photar",
                },
            },
        }))
        db.flush()
        _assert(gen.script_text == "The woman maintains a steady, grounded presence.", f"prompt not pulled from avatar_iv_meta: {gen.script_text!r}")
        _assert(gen.video_url == "https://files2.heygen.ai/example.mp4", f"top-level video_url not read: {gen.video_url!r}")
        _assert(gen.thumbnail_url == "https://dynamic.heygen.ai/example.jpeg", f"top-level thumbnail_url not read: {gen.thumbnail_url!r}")
        _assert(gen.aspect_ratio == "9:16", f"top-level aspect_ratio not read: {gen.aspect_ratio!r}")
        _assert(gen.duration_seconds == 7.70942, f"top-level duration not read: {gen.duration_seconds!r}")
        _assert(gen.resolution == "1080p", f"resolution not pulled from avatar_iv_meta: {gen.resolution!r}")
        _assert(gen.motion_engine == "4.3_seven_step_0925", f"motion_engine not pulled from avatar_iv_meta.model: {gen.motion_engine!r}")
        _assert(gen.avatar_type == "photar", f"avatar_type not pulled from avatar_iv_meta: {gen.avatar_type!r}")
        _assert(gen.provider_created_at is not None, "created_ts epoch was not parsed")
        db.rollback()
    print("ok  the confirmed real listing-endpoint shape extracts script/video/duration correctly")


def test_reconciliation_listing_row_never_gets_live_ownership() -> None:
    """The reconciliation walker (content-heygen.js's
    onHeygenNetworkListingMessage) reports EVERY row from a passively-observed
    project/items listing response, which can contain dozens of old, unrelated
    videos - none of them may ever be attributed to whichever user's tab
    happened to fetch the list. The freshness gate (an old provider_created_at
    far outside OWNERSHIP_FRESHNESS_WINDOW_SECONDS) must leave ownership
    unresolved, and generation_source/ingestion_source must reflect
    reconciliation, not live capture."""
    with SessionLocal() as db:
        old_event = _capture(db, {
            "video_id": "old-historical-video",
            "status": "completed",
            "created_ts": 1700000000,  # long before this test run - definitely outside the freshness window
            "updated_ts": 1700000100,
        })
        old_event.ownership_confidence = "reconciliation"
        db.flush()

        gen = normalize_capture_event(db, old_event)
        db.flush()
        _assert(gen.ownership_status != "resolved", f"an old reconciled row must not be auto-attributed, got {gen.ownership_status!r}")
        _assert(gen.generation_source == "reconciliation", f"expected reconciliation source, got {gen.generation_source!r}")
        _assert(gen.ingestion_source == "recovered", f"expected recovered ingestion_source, got {gen.ingestion_source!r}")
        db.rollback()
    print("ok  a reconciliation listing row never receives live-capture ownership")


def test_thin_credit_ledger_row_cannot_reattribute_an_old_generation() -> None:
    """Regression for the misattribution confirmed 2026-08-16: the test above
    proves an OLD listing row lands unclaimed, but the very next event for
    that same video used to hand it to whoever was browsing.

    content-heygen.js queues a proactive movio_bill.list lookup for every
    settled listing row it sees, and that credit_ledger_row payload is
    `{videoId, credits:{used}}` - no timestamp exists in that shape at all. The
    freshness gate used to read only the INCOMING payload's
    provider_created_at and treat "no timestamp" as fresh, so seconds after the
    listing row correctly left a month-old video unclaimed, the ledger
    follow-up resolved it to the current tab's user. In production this
    reassigned 74 of 107 stored generations - some created a month earlier - to
    one user.

    Both halves of the fix are covered here: reconciliation events fail closed
    on a missing timestamp, AND the gate falls back to the timestamp already
    stored on the row rather than judging a thin event on its own silence."""
    with SessionLocal() as db:
        listing_event = _capture(db, {
            "video_id": "old-video-then-billed",
            "status": "completed",
            "created_ts": 1700000000,  # far outside the freshness window
            "updated_ts": 1700000100,
        })
        listing_event.ownership_confidence = "reconciliation"
        db.flush()
        gen = normalize_capture_event(db, listing_event)
        db.flush()
        _assert(gen.ownership_status != "resolved", "precondition: the old listing row must land unclaimed")

        ledger_event = _capture(db, {"videoId": "old-video-then-billed", "credits": {"used": 4}})
        ledger_event.ownership_confidence = "reconciliation"
        db.flush()
        gen = normalize_capture_event(db, ledger_event)
        db.flush()

        _assert(
            gen.ownership_status != "resolved",
            f"a thin credit-ledger row must not attribute a month-old video, got {gen.ownership_status!r}",
        )
        _assert(gen.owner_user_id is None, f"owner must stay unset, got {gen.owner_user_id!r}")
        # The credits themselves must still land - failing the ownership gate
        # may never cost us the data the event was captured for.
        _assert(gen.credits_used == 4, f"credits_used must still merge, got {gen.credits_used!r}")
    print("ok  a thin credit-ledger row cannot re-attribute an old generation")


def test_live_submit_snapshot_without_timestamp_still_attributes() -> None:
    """The other side of the same gate: a LIVE, ticket-armed generate_click
    DOM snapshot genuinely has no provider timestamp yet (HeyGen hasn't
    assigned one at click time). Failing closed on it - the blanket rule
    Freepik uses - would leave every HeyGen generation permanently unclaimed,
    so only reconciliation events fail closed on a missing timestamp."""
    with SessionLocal() as db:
        event = _capture(db, {
            "externalEventId": "live-intent-no-timestamp",
            "scriptText": "hello from a freshly clicked generate button",
            "status": "processing",
        })
        event.ownership_confidence = "ticket"
        db.flush()
        gen = normalize_capture_event(db, event)
        db.flush()
        _assert(gen.ownership_status == "resolved", f"a live armed click must still attribute, got {gen.ownership_status!r}")
        _assert(gen.owner_user_id == event.user_id, f"expected owner {event.user_id}, got {gen.owner_user_id}")
        db.rollback()
    print("ok  a live submit snapshot with no provider timestamp still attributes")


def test_thin_credit_ledger_event_merges_without_erasing_metadata() -> None:
    """Regression for the credit-consumption gap reported 2026-08-04: HeyGen's
    credit ledger (movio_bill.list) is a completely separate endpoint from the
    video listing, so content-heygen.js reports it as its own thin event
    (only videoId + credits.used, nothing else - there is nothing richer to
    put in it). That event must merge credits_used onto the already-captured
    generation WITHOUT wiping out the rich metadata_json a prior listing
    capture already stored (metadata_json is always a dict, never None, so
    the normal "value is not None" merge guard can't protect it on its own -
    see normalize_capture_event's dedicated metadata_json merge block)."""
    with SessionLocal() as db:
        rich = normalize_capture_event(db, _capture(db, {
            "video_id": "v-credits",
            "status": "completed",
            "metadata": {"avatar_iv_meta": {"prompt": "A calm, confident delivery.", "model": "4.3_turbo_edge"}},
        }))
        db.flush()
        _assert(rich.script_text == "A calm, confident delivery.", "setup: prompt not captured")

        thin = normalize_capture_event(db, _capture(db, {
            "videoId": "v-credits",
            "credits": {"used": 4},
        }))
        db.flush()

        _assert(rich.id == thin.id, "the ledger row should resolve to the same generation")
        _assert(thin.credits_used == 4, f"credits_used not merged in: {thin.credits_used!r}")
        _assert(thin.script_text == "A calm, confident delivery.", f"thin ledger event erased the stored script: {thin.script_text!r}")
        _assert(
            thin.metadata_json.get("metadata", {}).get("avatar_iv_meta", {}).get("prompt") == "A calm, confident delivery.",
            f"thin ledger event erased the stored metadata_json: {thin.metadata_json!r}",
        )

        record = db.query(GenerationRecord).filter(GenerationRecord.id == thin.generation_record_id).one()
        _assert(record.credits_burned == 4, f"report row credits not updated: {record.credits_burned!r}")
        db.rollback()
    print("ok  a thin credit-ledger event merges credits without erasing stored metadata")


def test_bare_id_queue_status_maps_to_video_id_not_workflow_id() -> None:
    """Regression for the split-record bug reported 2026-08-04: a real
    generation showed up as TWO separate cards - a "submitted" click capture
    (script text, task/client) stuck on the queue-status endpoint's bare "id"
    misclassified as workflow_id, and a separate reconciliation-capture row
    with the real video_id - because the two events landed in different
    identity columns despite being the literal same HeyGen id string. Proven
    with a side-by-side comparison the user provided: the queue-status
    payload's "id" and the listing endpoint's "video_id" were identical, and
    the queue-status payload separately had its own "workflow_id": null."""
    with SessionLocal() as db:
        submitted = normalize_capture_event(db, _capture(db, {
            "externalEventId": "hgen_real_1",
            "scriptText": "my name is sarbjeet singh",
        }))
        db.flush()

        queue_status = normalize_capture_event(db, _capture(db, {
            # content-heygen.js's onHeygenNetworkMessage embeds the armed
            # generation's externalEventId onto every network_snapshot row -
            # without it this event would have no shared key with `submitted`
            # at all (the bare "id" here isn't known to be a video_id yet
            # from any prior event, so video_id-based matching alone can't
            # find the right row on this specific event).
            "externalEventId": "hgen_real_1",
            "id": "3d01cd6d7d744041a3778a91637bc694",
            "workflow_id": None,
            "status": "processing",
            "progress": 16,
        }))
        db.flush()
        _assert(queue_status.id == submitted.id, "bare-id queue status did not resolve to the submitted generation")
        _assert(queue_status.video_id == "3d01cd6d7d744041a3778a91637bc694", f"bare id was not mapped to video_id: {queue_status.video_id!r}")
        _assert(queue_status.workflow_id is None, f"workflow_id should stay null, got {queue_status.workflow_id!r}")

        listing = normalize_capture_event(db, _capture(db, {
            "video_id": "3d01cd6d7d744041a3778a91637bc694",
            "status": "completed",
            "video_url": "https://files2.heygen.ai/example.mp4",
        }))
        db.flush()

        _assert(listing.id == submitted.id, "the reconciliation listing row minted a separate duplicate generation instead of merging")
        _assert(listing.script_text == "my name is sarbjeet singh", f"script lost after merging in the real video_id: {listing.script_text!r}")
        _assert(listing.status == "completed", f"status not updated to completed: {listing.status!r}")
        db.rollback()
    print("ok  a bare-id queue-status row maps to video_id and merges with the submitted click capture")


def test_cross_column_identity_without_shared_correlation_key_merges() -> None:
    """Regression for the split-record incident found 2026-08-05: three real
    generations each ended up as two HeygenGeneration rows because
    _find_existing_generation only matched an incoming identity value against
    its OWN column (workflow_id against workflow_id, video_id against
    video_id) instead of across all four. This is a stricter case than
    test_bare_id_queue_status_maps_to_video_id_not_workflow_id above: here the
    second event has no external_event_id at all to correlate through (a bulk
    reconciliation/backfill replay of a historical listing row never carries
    one) - video_id vs workflow_id cross-matching is the ONLY thing that can
    resolve it to the same row."""
    with SessionLocal() as db:
        live = normalize_capture_event(db, _capture(db, {
            "externalEventId": "hgen_real_2",
            "video_id": "3d01cd6d7d744041a3778a91637bc694",
            "scriptText": "my name is sarbjeet singh",
            "status": "processing",
        }))
        db.flush()

        reconciled = normalize_capture_event(db, _capture(db, {
            # No externalEventId here - a bulk/backfill replay of a historical
            # listing row has nothing client-minted to correlate through.
            "workflowId": "3d01cd6d7d744041a3778a91637bc694",
            "status": "completed",
        }))
        db.flush()

        _assert(reconciled.id == live.id, "workflow_id did not cross-match the existing row's video_id - minted a duplicate")
        _assert(reconciled.script_text == "my name is sarbjeet singh", f"script lost after cross-column merge: {reconciled.script_text!r}")
        _assert(reconciled.status == "completed", f"status not updated to completed: {reconciled.status!r}")

        count = db.query(HeygenGeneration).filter(HeygenGeneration.video_id == "3d01cd6d7d744041a3778a91637bc694").count()
        _assert(count == 1, f"expected exactly one row for this generation, found {count}")
        db.rollback()
    print("ok  an incoming identity value cross-matches every identity column, not just its own")


def test_parse_dt_converts_offsets_to_utc() -> None:
    _assert(_parse_dt("2026-07-02T11:27:02+00:00") == datetime(2026, 7, 2, 11, 27, 2), "UTC offset shape changed")
    _assert(_parse_dt("2026-07-02T11:27:02.000000Z") == datetime(2026, 7, 2, 11, 27, 2), "Z shape changed")
    _assert(
        _parse_dt("2026-07-02T17:00:00+05:30") == datetime(2026, 7, 2, 11, 30, 0),
        "a non-UTC offset must be converted, not stripped in place",
    )
    _assert(_parse_dt(1751449622) == datetime(2025, 7, 2, 9, 47, 2), "bare epoch seconds must parse")
    print("ok  _parse_dt normalizes to naive UTC")


def test_backfill_repairs_a_pre_fix_row() -> None:
    with SessionLocal() as db:
        _capture(db, _snapshot(
            video_id="v-backfill", status="failed", updated_at="2026-07-03T09:00:00+00:00",
        ))
        db.commit()

    with SessionLocal() as db:
        stats = backfill_all(db, batch_size=100)
        _assert(stats["errors"] == 0, f"backfill reported errors: {stats}")
        gen = db.query(HeygenGeneration).filter(HeygenGeneration.video_id == "v-backfill").one()
        record = db.query(GenerationRecord).filter(GenerationRecord.id == gen.generation_record_id).one()
        record.capture_status = "active"
        db.commit()

    with SessionLocal() as db:
        stats = backfill_all(db, batch_size=100)
        _assert(stats["errors"] == 0, f"backfill reported errors: {stats}")
        _assert(stats["processed"] >= 1, f"backfill processed nothing: {stats}")
        gen = db.query(HeygenGeneration).filter(HeygenGeneration.video_id == "v-backfill").one()
        record = db.query(GenerationRecord).filter(GenerationRecord.id == gen.generation_record_id).one()
        _assert(
            record.capture_status == "failed",
            f"backfill did not repair the stale capture_status, got {record.capture_status!r}",
        )
    print("ok  backfill replay repairs a pre-fix row")


def test_capture_batch_commits_and_isolates_duplicates() -> None:
    """ingest_capture_event flushes inside a SAVEPOINT and the router owns
    the transaction, committing a chunk at a time. Prove every accepted event
    is durably committed, and a duplicate inside the batch unwinds by itself
    without taking its siblings with it."""
    import providers.heygen.router as heygen_router
    from providers.heygen.schemas import CaptureEventIn, CaptureEventsRequest

    with SessionLocal() as db:
        user = db.query(User).filter(User.id == USER_ID).one()
        tool = db.query(ITPortalTool).filter(ITPortalTool.id == TOOL_ID).one()

    original_tool, original_actor, original_credential = (
        heygen_router.resolve_heygen_tool,
        heygen_router.resolve_heygen_actor,
        heygen_router.resolve_heygen_credential,
    )
    heygen_router.resolve_heygen_tool = lambda _db: tool
    heygen_router.resolve_heygen_actor = lambda **_kw: user
    heygen_router.resolve_heygen_credential = lambda *_a, **_kw: None
    try:
        events = [
            CaptureEventIn(
                event_type="network_snapshot",
                client_event_id=f"batch-{i}",
                payload=_snapshot(
                    video_id=f"batch-v{i}", status="completed",
                    updated_at="2026-07-05T10:00:00+00:00", credits_used=1.0,
                ),
            )
            for i in range(5)
        ]
        # A repeat of an id already in the same batch.
        events.append(events[2].model_copy(deep=True))

        with SessionLocal() as db:
            response = heygen_router.capture_events(
                CaptureEventsRequest(events=events), request=None, db=db,
            )

        statuses = [r.status for r in response.results]
        _assert(statuses.count("created") == 5, f"expected 5 created, got {statuses}")
        _assert(statuses.count("duplicate") == 1, f"expected 1 duplicate, got {statuses}")

        with SessionLocal() as db:
            persisted = (
                db.query(HeygenCaptureEvent)
                .filter(HeygenCaptureEvent.client_event_id.like("batch-%"))
                .count()
            )
            _assert(persisted == 5, f"expected 5 durable capture events, found {persisted}")
            normalized = (
                db.query(HeygenGeneration)
                .filter(HeygenGeneration.video_id.like("batch-v%"))
                .count()
            )
            _assert(normalized == 5, f"expected 5 normalized generations, found {normalized}")
    finally:
        heygen_router.resolve_heygen_tool = original_tool
        heygen_router.resolve_heygen_actor = original_actor
        heygen_router.resolve_heygen_credential = original_credential
    print("ok  capture batch commits durably and isolates in-batch duplicates")


if __name__ == "__main__":
    test_capture_status_tracks_provider_status()
    test_stale_snapshot_does_not_erase_stored_columns()
    test_job_id_then_video_id_reuses_one_record()
    test_external_event_id_then_workflow_id_reuses_one_record_and_keeps_script()
    test_real_listing_endpoint_shape_extracts_correctly()
    test_reconciliation_listing_row_never_gets_live_ownership()
    test_thin_credit_ledger_row_cannot_reattribute_an_old_generation()
    test_live_submit_snapshot_without_timestamp_still_attributes()
    test_thin_credit_ledger_event_merges_without_erasing_metadata()
    test_bare_id_queue_status_maps_to_video_id_not_workflow_id()
    test_cross_column_identity_without_shared_correlation_key_merges()
    test_parse_dt_converts_offsets_to_utc()
    test_backfill_repairs_a_pre_fix_row()
    test_capture_batch_commits_and_isolates_duplicates()
    print("\nall heygen normalization smoke checks passed")
