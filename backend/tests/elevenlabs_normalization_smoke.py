"""Regression cover for providers/elevenlabs/normalization.py.

Fixture shapes are best-guess pending a real captured `history` row - update
this file's fixtures the moment real traffic is observed (see
providers/elevenlabs/CAPTURE_CONTRACT.md's known gaps).

Mirrors tests/freepik_normalization_smoke.py's structure/conventions:
in-process SQLite (StaticPool), normalize_capture_event called directly as a
plain Python function.

Run: python tests/elevenlabs_normalization_smoke.py
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

from models_new import Base, GenerationRecord, ITPortalTool, User  # noqa: E402
from providers.elevenlabs.models import ElevenlabsCaptureEvent, ElevenlabsGeneration  # noqa: E402
from providers.elevenlabs.normalization import normalize_capture_event  # noqa: E402


engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
Base.metadata.create_all(
    bind=engine,
    tables=[
        User.__table__,
        ITPortalTool.__table__,
        GenerationRecord.__table__,
        ElevenlabsCaptureEvent.__table__,
        ElevenlabsGeneration.__table__,
    ],
)


def _assert(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def _seed_actor() -> tuple[int, int]:
    with SessionLocal() as db:
        user = User(email="elevenlabs-norm@example.com", name="ElevenLabs Norm User", hashed_password="x", is_active=True, is_deleted=False)
        tool = ITPortalTool(name="ElevenLabs", slug="elevenlabs", website_url="https://elevenlabs.io", is_active=True)
        db.add_all([user, tool])
        db.commit()
        return user.id, tool.id


USER_ID, TOOL_ID = _seed_actor()


def _capture(db, payload: dict, *, client_event_id: str, ownership_confidence: str = "ticket") -> ElevenlabsCaptureEvent:
    event = ElevenlabsCaptureEvent(
        tool_id=TOOL_ID,
        user_id=USER_ID,
        provider="elevenlabs",
        event_type="history_row",
        client_event_id=client_event_id,
        payload_json=payload,
        capture_version=1,
        event_date=datetime.utcnow().date(),
        ownership_confidence=ownership_confidence,
    )
    db.add(event)
    db.flush()
    return event


def test_synthetic_row_extracts_expected_fields() -> None:
    """A synthetic best-guess-shape history row - the primary candidate keys
    for every logical field (history_item_id/text/source/voice_id/date_unix -
    see CAPTURE_CONTRACT.md's field mapping table)."""
    # Freshness-gated ownership attribution (see normalization.py's
    # _is_fresh_enough_for_attribution) requires the row's own timestamp to
    # be recent relative to "now", not any fixed point in the past - use the
    # current wall-clock time as unix seconds so this test exercises live
    # attribution rather than the "too old to attribute" branch. NOTE:
    # datetime.utcnow().timestamp() is wrong here - .timestamp() interprets a
    # naive datetime as LOCAL time, so on a non-UTC machine it silently
    # shifts by the local offset; compute the epoch directly against the
    # UTC epoch instead.
    now_unix = int((datetime.utcnow() - datetime(1970, 1, 1)).total_seconds())
    expected_created_at = datetime.utcfromtimestamp(now_unix)
    with SessionLocal() as db:
        gen = normalize_capture_event(db, _capture(
            db,
            {"history_item_id": "abc123", "voice_id": "v1", "voice_name": "Rachel", "text": "hello world", "source": "TTS", "date_unix": now_unix},
            client_event_id="evt-synthetic",
        ))
        db.flush()

        _assert(gen is not None, "expected a normalized ElevenlabsGeneration, got None")
        _assert(gen.provider_creation_id == "abc123", f"identity not extracted: {gen.provider_creation_id!r}")
        _assert(gen.voice_id == "v1", f"voice_id not extracted: {gen.voice_id!r}")
        _assert(gen.voice_name == "Rachel", f"voice_name not extracted: {gen.voice_name!r}")
        _assert(gen.prompt == "hello world", f"prompt not extracted: {gen.prompt!r}")
        _assert(gen.prompt_length == len("hello world"), f"prompt_length wrong: {gen.prompt_length!r}")
        _assert(gen.source == "TTS", f"source not extracted: {gen.source!r}")
        _assert(gen.provider_created_at == expected_created_at, f"date_unix not parsed as unix seconds: {gen.provider_created_at!r}")
        # No separate "updated" candidate present on this row - falls back to
        # the created timestamp (see _extract_fields' docstring).
        _assert(gen.provider_updated_at == gen.provider_created_at, "provider_updated_at should fall back to created when absent")
        _assert(gen.owner_user_id == USER_ID, f"expected live attribution, got owner_user_id={gen.owner_user_id!r}")
        _assert(gen.ownership_status == "resolved", f"expected resolved ownership, got {gen.ownership_status!r}")

        record = db.query(GenerationRecord).filter(GenerationRecord.id == gen.generation_record_id).one()
        _assert(record.provider == "elevenlabs", f"GenerationRecord.provider wrong: {record.provider!r}")
        _assert(record.prompt_text == "hello world", f"GenerationRecord.prompt_text not projected: {record.prompt_text!r}")
        db.rollback()
    print("ok  a synthetic best-guess-shape row normalizes with correctly extracted fields")


def test_row_with_only_one_identity_key_normalizes_without_raising() -> None:
    """A pathological row carrying almost nothing - just one identity-like
    key - must still normalize without raising, proving the defensive
    multi-candidate extraction degrades gracefully rather than assuming any
    particular field is present."""
    with SessionLocal() as db:
        gen = normalize_capture_event(db, _capture(db, {"id": "xyz"}, client_event_id="evt-minimal"))
        db.flush()

        _assert(gen is not None, "a row with a bare 'id' field should still normalize")
        _assert(gen.provider_creation_id == "xyz", f"identity not extracted from fallback key 'id': {gen.provider_creation_id!r}")
        _assert(gen.prompt is None, f"no prompt candidate was present, expected None, got {gen.prompt!r}")
        _assert(gen.source is None, f"no source candidate was present, expected None, got {gen.source!r}")
        _assert(gen.media_url is None, f"no asset URL candidate was present, expected None, got {gen.media_url!r}")
        _assert(gen.provider_created_at is None, f"no timestamp candidate was present, expected None, got {gen.provider_created_at!r}")
        db.rollback()
    print("ok  a row with only one identity-like field normalizes without raising (defensive extraction)")


def test_totally_empty_payload_is_skipped_not_raised() -> None:
    """A row with NO identity candidate at all must be skipped (None
    returned), never raise - normalize_capture_events_batch relies on this
    to distinguish a deliberate skip from an error."""
    with SessionLocal() as db:
        gen = normalize_capture_event(db, _capture(db, {"text": "no id anywhere"}, client_event_id="evt-no-identity"))
        _assert(gen is None, "a payload with no identity candidate should return None, not raise or fabricate a row")
        db.rollback()
    print("ok  a payload with no identity candidate at all is skipped cleanly")


def test_stale_snapshot_does_not_erase_stored_columns() -> None:
    """The extension can plausibly report the same history item twice out of
    order (e.g. a live capture followed by a later reconciliation walk that
    happens to replay an older cached copy) - a thinner/older snapshot must
    never walk stored columns back to null or an earlier value."""
    with SessionLocal() as db:
        normalize_capture_event(db, _capture(
            db,
            {"history_item_id": "stale-test", "text": "the final version", "source": "TTS",
             "voice_name": "Rachel", "date_unix": 1700000200},
            client_event_id="evt-newer",
        ))
        db.flush()

        # ...then an OLDER snapshot of the same item arrives late.
        normalize_capture_event(db, _capture(
            db,
            {"history_item_id": "stale-test", "text": "an earlier draft", "source": "TTS",
             "date_unix": 1700000100},
            client_event_id="evt-older",
        ))
        db.flush()

        gen = db.query(ElevenlabsGeneration).filter(ElevenlabsGeneration.provider_creation_id == "stale-test").one()
        _assert(gen.prompt == "the final version", f"prompt was clobbered by the stale snapshot: {gen.prompt!r}")
        _assert(gen.voice_name == "Rachel", f"voice_name was clobbered by the stale snapshot: {gen.voice_name!r}")
        db.rollback()
    print("ok  a stale/older snapshot never overwrites already-stored richer columns")


def test_one_generation_produces_exactly_one_generation_record() -> None:
    """Calling normalize twice for the same provider_creation_id (e.g. a
    live capture followed by a reconciliation replay of the same item) must
    never create a second GenerationRecord."""
    with SessionLocal() as db:
        first = normalize_capture_event(db, _capture(
            db, {"history_item_id": "one-record-test", "text": "first pass", "source": "TTS", "date_unix": 1700000300},
            client_event_id="evt-first-pass",
        ))
        db.flush()
        second = normalize_capture_event(db, _capture(
            db, {"history_item_id": "one-record-test", "text": "first pass", "source": "TTS", "date_unix": 1700000400},
            client_event_id="evt-second-pass",
        ))
        db.flush()

        _assert(first.id == second.id, "both normalize calls should resolve to the same ElevenlabsGeneration row")
        record_count = (
            db.query(GenerationRecord)
            .filter(GenerationRecord.provider == "elevenlabs", GenerationRecord.provider_generation_id == "one-record-test")
            .count()
        )
        _assert(record_count == 1, f"expected exactly one GenerationRecord, found {record_count}")
        db.rollback()
    print("ok  one generation produces exactly one GenerationRecord even when normalized twice")


if __name__ == "__main__":
    test_synthetic_row_extracts_expected_fields()
    test_row_with_only_one_identity_key_normalizes_without_raising()
    test_totally_empty_payload_is_skipped_not_raised()
    test_stale_snapshot_does_not_erase_stored_columns()
    test_one_generation_produces_exactly_one_generation_record()
    print("\nall elevenlabs normalization smoke checks passed")
