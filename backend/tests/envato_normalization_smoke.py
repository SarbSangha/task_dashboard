"""Regression cover for the Envato provider's normalization pipeline.

Fixture payloads below are shaped exactly like the real decoded items
inspected while building this provider (see providers/envato/README-worthy
research: a captured HAR of app.envato.com's generation-history.data
endpoint, decoded via the turbo-stream algorithm verified in
scratchpad/decode_test.js) - not invented field names.

Run: python tests/envato_normalization_smoke.py
"""
import os
import sys
from datetime import datetime, timedelta
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
from providers.envato.models import EnvatoCaptureEvent, EnvatoDownload, EnvatoGeneration  # noqa: E402
from providers.envato.normalization import _parse_dt, backfill_all, normalize_capture_event  # noqa: E402


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
        EnvatoCaptureEvent.__table__,
        EnvatoGeneration.__table__,
        EnvatoDownload.__table__,
    ],
)


def _assert(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def _seed_actor() -> tuple[int, int]:
    with SessionLocal() as db:
        user = User(email="envato@example.com", name="Envato User", hashed_password="x", is_active=True, is_deleted=False)
        tool = ITPortalTool(name="Envato", slug="envato", website_url="https://app.envato.com", is_active=True)
        db.add_all([user, tool])
        db.commit()
        return user.id, tool.id


USER_ID, TOOL_ID = _seed_actor()


def _flat_item(*, item_uuid, created_at, prompt="A test prompt", item_type="genai-image", is_downloaded=True):
    """Shaped exactly like one entry of generation-history.data's `assets[]`
    array after turbo-stream decoding - confirmed field names."""
    return {
        "aspectRatio": 1.781,
        "prompt": prompt,
        "createdAt": created_at,
        "itemUuid": item_uuid,
        "itemType": item_type,
        "isInWorkspace": False,
        "isDownloaded": is_downloaded,
        "upscaleTargets": [],
        "image": {
            "canvasUrl": f"https://gen-assets-resized.envatousercontent.com/{item_uuid}/canvas.avif",
            "fallbackSrc": f"https://gen-assets-resized.envatousercontent.com/{item_uuid}/fallback.jpg",
            "srcSet": "200w, 400w",
        },
    }


def _wrapped_item(*, item_uuid, created_at, review_status="submitted"):
    """Shaped exactly like one entry of the POST loadMore `results[]` array
    - {actions, item} - confirmed field names."""
    return {
        "item": _flat_item(item_uuid=item_uuid, created_at=created_at),
        "actions": [
            {"type": "download"},
            {"type": "workspace", "isInWorkspace": False},
            {"type": "edit"},
            {"type": "request-review", "reviewStatus": review_status, "submittedAt": created_at},
        ],
    }


def _capture(db, payload: dict, *, event_type: str = "generation_listing_row", linked_task_id=None, linked_client_id=None, ownership_confidence="ticket", item_uuid=None) -> EnvatoCaptureEvent:
    event = EnvatoCaptureEvent(
        tool_id=TOOL_ID,
        user_id=USER_ID,
        provider="envato",
        event_type=event_type,
        client_event_id=f"envato:test:{datetime.utcnow().timestamp()}:{len(payload)}",
        provider_item_uuid=item_uuid,
        payload_json=payload,
        capture_version=1,
        event_date=datetime.utcnow().date(),
        ownership_confidence=ownership_confidence,
        linked_task_id=linked_task_id,
        linked_client_id=linked_client_id,
    )
    db.add(event)
    db.flush()
    return event


def test_flat_listing_item_normalizes() -> None:
    with SessionLocal() as db:
        now_iso = datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%S.000Z")
        gen = normalize_capture_event(db, _capture(db, _flat_item(item_uuid="uuid-flat", created_at=now_iso)))
        db.flush()
        _assert(gen is not None, "expected a normalized EnvatoGeneration")
        _assert(gen.item_uuid == "uuid-flat", f"item_uuid not extracted: {gen.item_uuid!r}")
        _assert(gen.item_type == "genai-image", f"item_type not extracted: {gen.item_type!r}")
        _assert(gen.prompt == "A test prompt", f"prompt not extracted: {gen.prompt!r}")
        _assert(gen.canvas_url and "canvas.avif" in gen.canvas_url, f"canvas_url not extracted: {gen.canvas_url!r}")
        _assert(gen.ownership_status == "resolved", f"a fresh live capture should resolve ownership, got {gen.ownership_status!r}")
        _assert(gen.owner_user_id == USER_ID, f"owner not attributed: {gen.owner_user_id!r}")

        record = db.query(GenerationRecord).filter(GenerationRecord.id == gen.generation_record_id).one()
        _assert(record.prompt_text == "A test prompt", f"projection lost prompt: {record.prompt_text!r}")
        _assert(record.provider == "envato", f"projection provider wrong: {record.provider!r}")
        db.rollback()
    print("ok  flat generation-history item normalizes and projects into GenerationRecord")


def test_wrapped_item_unwraps_and_reads_review_status() -> None:
    with SessionLocal() as db:
        now_iso = datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%S.000Z")
        gen = normalize_capture_event(db, _capture(db, _wrapped_item(item_uuid="uuid-wrapped", created_at=now_iso, review_status="submitted")))
        db.flush()
        _assert(gen is not None, "expected a normalized EnvatoGeneration from the {item, actions} shape")
        _assert(gen.item_uuid == "uuid-wrapped", f"item_uuid not extracted from wrapped shape: {gen.item_uuid!r}")
        _assert(gen.review_status == "submitted", f"review_status not extracted from actions[]: {gen.review_status!r}")
        db.rollback()
    print("ok  the {item, actions} POST-loadMore shape unwraps to the same fields as the flat shape")


def test_ownership_freshness_gate() -> None:
    """A reconciliation walk (or a live event whose own createdAt is old -
    e.g. a listing page loaded on tab-open, surfacing the whole account's
    history) must never attribute an old generation to whoever's ticket
    happens to be active right now."""
    with SessionLocal() as db:
        old_iso = (datetime.utcnow() - timedelta(hours=6)).strftime("%Y-%m-%dT%H:%M:%S.000Z")
        gen = normalize_capture_event(db, _capture(
            db, _flat_item(item_uuid="uuid-old", created_at=old_iso),
            ownership_confidence="reconciliation",
        ))
        db.flush()
        _assert(gen.ownership_status == "unknown", f"a stale/reconciliation row must stay unattributed, got {gen.ownership_status!r}")
        _assert(gen.owner_user_id is None, f"owner must not be set for a stale row, got {gen.owner_user_id!r}")
        _assert(gen.generation_source == "reconciliation", f"generation_source should be reconciliation, got {gen.generation_source!r}")
        db.rollback()
    print("ok  ownership freshness gate refuses to attribute an old/reconciliation-imported row")


def test_none_never_overwrites_stored_value() -> None:
    with SessionLocal() as db:
        now_iso = datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%S.000Z")
        normalize_capture_event(db, _capture(db, _flat_item(item_uuid="uuid-merge", created_at=now_iso, prompt="Rich prompt")))
        db.flush()

        # A thinner re-report of the same item (e.g. the item-detail page's
        # itemDetailsProps.item, which carries no `createdAt` field at all -
        # confirmed in the real captured sample) must not null out prompt.
        thin_payload = {"itemUuid": "uuid-merge", "itemType": "genai-image"}
        normalize_capture_event(db, _capture(db, thin_payload))
        db.flush()

        gen = db.query(EnvatoGeneration).filter(EnvatoGeneration.item_uuid == "uuid-merge").one()
        _assert(gen.prompt == "Rich prompt", f"a thinner snapshot erased the prompt: {gen.prompt!r}")
        db.rollback()
    print("ok  a thinner re-report never erases a richer stored value")


def test_download_click_carries_task_client_attribution() -> None:
    """A download of an existing Envato Elements stock asset is gated behind
    the same Task/Client picker Generate uses - linked_task_id/
    linked_client_id must flow through from the capture event onto
    EnvatoDownload exactly like they do for a generation_submitted event
    onto EnvatoGeneration. Mirrors freepik_normalization_smoke.py's
    identical test."""
    with SessionLocal() as db:
        row = normalize_capture_event(db, _capture(
            db,
            {
                "itemType": "photos",
                "assetTitle": "Modern office interior mockup",
                "assetThumbnailUrl": "https://elements-cover-images.envato.com/example_thumb.jpg",
                "assetSourceUrl": "https://elements.envato.com/modern-office-interior-mockup-ABCDE",
                "searchTerm": "office interior mockup",
                "sourceHost": "app.envato.com",
                "pageUrl": "https://app.envato.com/search/all?term=office+interior",
                "downloadedAt": "2026-08-08T10:05:00+00:00",
            },
            event_type="download_click",
            linked_task_id=42,
            linked_client_id=7,
            item_uuid="7723d5c2-e236-41b3-a563-48abc3d4df7c",
        ))
        db.flush()

        _assert(isinstance(row, EnvatoDownload), f"expected an EnvatoDownload row, got {type(row)!r}")
        _assert(row.item_uuid == "7723d5c2-e236-41b3-a563-48abc3d4df7c", f"item_uuid not carried from the network-correlated signal: {row.item_uuid!r}")
        _assert(row.item_type == "photos", f"item_type not extracted: {row.item_type!r}")
        _assert(row.asset_title == "Modern office interior mockup", f"asset_title not extracted: {row.asset_title!r}")
        _assert(row.asset_thumbnail_url == "https://elements-cover-images.envato.com/example_thumb.jpg", f"asset_thumbnail_url not extracted: {row.asset_thumbnail_url!r}")
        _assert(row.search_term == "office interior mockup", f"search_term not correlated: {row.search_term!r}")
        _assert(row.linked_task_id == 42, f"linked_task_id not carried through: {row.linked_task_id!r}")
        _assert(row.linked_client_id == 7, f"linked_client_id not carried through: {row.linked_client_id!r}")
        _assert(row.owner_user_id == USER_ID, f"download should be attributed live: {row.owner_user_id!r}")
        _assert(row.ownership_status == "resolved", f"expected resolved ownership, got {row.ownership_status!r}")

        gen_count = db.query(EnvatoGeneration).count()
        _assert(gen_count == 0, f"a download must never create an EnvatoGeneration row, found {gen_count}")
        db.rollback()
    print("ok  a download click carries its Task/Client attribution and network-correlated item_uuid/item_type onto EnvatoDownload")


def test_parse_dt_converts_offsets_to_utc() -> None:
    _assert(_parse_dt("2026-07-14T05:55:39.742Z") == datetime(2026, 7, 14, 5, 55, 39, 742000), "Z shape changed")
    _assert(
        _parse_dt("2026-07-14T11:25:39+05:30") == datetime(2026, 7, 14, 5, 55, 39),
        "a non-UTC offset must be converted, not stripped in place",
    )
    print("ok  _parse_dt normalizes to naive UTC")


def test_backfill_replays_events() -> None:
    with SessionLocal() as db:
        now_iso = datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%S.000Z")
        _capture(db, _flat_item(item_uuid="uuid-backfill", created_at=now_iso))
        db.commit()

    with SessionLocal() as db:
        stats = backfill_all(db, batch_size=100)
        _assert(stats["errors"] == 0, f"backfill reported errors: {stats}")
        _assert(stats["processed"] >= 1, f"backfill processed nothing: {stats}")
        gen = db.query(EnvatoGeneration).filter(EnvatoGeneration.item_uuid == "uuid-backfill").one()
        _assert(gen.ingestion_source == "captured", f"expected captured ingestion_source, got {gen.ingestion_source!r}")
    print("ok  backfill replays raw capture events idempotently")


def test_capture_batch_commits_and_isolates_duplicates() -> None:
    import providers.envato.router as envato_router
    from providers.envato.schemas import CaptureEventIn, CaptureEventsRequest

    with SessionLocal() as db:
        user = db.query(User).filter(User.id == USER_ID).one()
        tool = db.query(ITPortalTool).filter(ITPortalTool.id == TOOL_ID).one()

    original_tool, original_actor, original_credential = (
        envato_router.resolve_envato_tool,
        envato_router.resolve_envato_actor,
        envato_router.resolve_envato_credential,
    )
    envato_router.resolve_envato_tool = lambda _db: tool
    envato_router.resolve_envato_actor = lambda **_kw: user
    envato_router.resolve_envato_credential = lambda *_a, **_kw: None
    try:
        now_iso = datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%S.000Z")
        events = [
            CaptureEventIn(
                event_type="generation_listing_row",
                client_event_id=f"batch-{i}",
                payload=_flat_item(item_uuid=f"batch-uuid-{i}", created_at=now_iso),
            )
            for i in range(5)
        ]
        events.append(events[2].model_copy(deep=True))  # repeat of an id already in this batch

        with SessionLocal() as db:
            response = envato_router.capture_events(
                CaptureEventsRequest(events=events), request=None, db=db,
            )

        statuses = [r.status for r in response.results]
        _assert(statuses.count("created") == 5, f"expected 5 created, got {statuses}")
        _assert(statuses.count("duplicate") == 1, f"expected 1 duplicate, got {statuses}")

        with SessionLocal() as db:
            persisted = (
                db.query(EnvatoCaptureEvent)
                .filter(EnvatoCaptureEvent.client_event_id.like("batch-%"))
                .count()
            )
            _assert(persisted == 5, f"expected 5 durable capture events, found {persisted}")
            normalized = (
                db.query(EnvatoGeneration)
                .filter(EnvatoGeneration.item_uuid.like("batch-uuid-%"))
                .count()
            )
            _assert(normalized == 5, f"expected 5 normalized generations, found {normalized}")
    finally:
        envato_router.resolve_envato_tool = original_tool
        envato_router.resolve_envato_actor = original_actor
        envato_router.resolve_envato_credential = original_credential
    print("ok  capture batch commits durably and isolates in-batch duplicates")


if __name__ == "__main__":
    test_flat_listing_item_normalizes()
    test_wrapped_item_unwraps_and_reads_review_status()
    test_ownership_freshness_gate()
    test_none_never_overwrites_stored_value()
    test_download_click_carries_task_client_attribution()
    test_parse_dt_converts_offsets_to_utc()
    test_backfill_replays_events()
    test_capture_batch_commits_and_isolates_duplicates()
    print("\nall envato normalization smoke checks passed")
