"""Regression cover for providers/elevenlabs/capture.py + router.py's
capture_events endpoint - mirrors tests/chatgpt_capture_smoke.py's overall
shape, but exercises the ticket-based actor-resolution flow (like Flow/
Freepik) rather than ChatGPT's plain-session one, following
freepik_normalization_smoke.py::test_capture_batch_commits_and_isolates_duplicates'
convention of monkeypatching resolve_elevenlabs_tool/_actor/_credential on
the router module and calling capture_events(...) directly as a plain Python
function (no TestClient/real HTTP, no `current_user` dependency injection -
that's ChatGPT's own pattern, not this provider's).

Run: python tests/elevenlabs_capture_smoke.py
"""
import os
import sys
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
import providers.elevenlabs.router as elevenlabs_router  # noqa: E402
from providers.elevenlabs.constants import INGEST_COMMIT_CHUNK_SIZE  # noqa: E402
from providers.elevenlabs.models import ElevenlabsCaptureEvent, ElevenlabsGeneration  # noqa: E402
from providers.elevenlabs.schemas import CaptureEventIn, CaptureEventsRequest  # noqa: E402


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
        user = User(email="elevenlabs@example.com", name="ElevenLabs User", hashed_password="x", is_active=True, is_deleted=False)
        tool = ITPortalTool(name="ElevenLabs", slug="elevenlabs", website_url="https://elevenlabs.io", is_active=True)
        db.add_all([user, tool])
        db.commit()
        return user.id, tool.id


USER_ID, TOOL_ID = _seed_actor()


def _history_row(*, history_item_id: str, text: str = "hello world", source: str = "TTS") -> dict:
    """A synthetic best-guess-shape ElevenLabs `history` row - see
    CAPTURE_CONTRACT.md: the real response body has never been observed, so
    this is deliberately just one of several plausible shapes."""
    return {"history_item_id": history_item_id, "text": text, "source": source, "voice_id": "v1", "date_unix": 1700000000}


def _install_fakes(user, tool):
    original_tool, original_actor, original_credential = (
        elevenlabs_router.resolve_elevenlabs_tool,
        elevenlabs_router.resolve_elevenlabs_actor,
        elevenlabs_router.resolve_elevenlabs_credential,
    )
    elevenlabs_router.resolve_elevenlabs_tool = lambda _db: tool
    elevenlabs_router.resolve_elevenlabs_actor = lambda **_kw: user
    elevenlabs_router.resolve_elevenlabs_credential = lambda *_a, **_kw: None
    return original_tool, original_actor, original_credential


def _restore_fakes(original_tool, original_actor, original_credential):
    elevenlabs_router.resolve_elevenlabs_tool = original_tool
    elevenlabs_router.resolve_elevenlabs_actor = original_actor
    elevenlabs_router.resolve_elevenlabs_credential = original_credential


def test_create_then_duplicate_then_rejected() -> None:
    with SessionLocal() as db:
        user = db.query(User).filter(User.id == USER_ID).one()
        tool = db.query(ITPortalTool).filter(ITPortalTool.id == TOOL_ID).one()

    originals = _install_fakes(user, tool)
    try:
        # 1. First insert -> created.
        with SessionLocal() as db:
            response = elevenlabs_router.capture_events(
                CaptureEventsRequest(events=[
                    CaptureEventIn(
                        event_type="history_row",
                        client_event_id="evt-1",
                        creation_id="hist-1",
                        payload=_history_row(history_item_id="hist-1"),
                    ),
                ]),
                request=None, db=db,
            )
        _assert(response.results[0].status == "created", f"expected created, got {response.results[0].status!r}")
        _assert(response.results[0].id is not None, "created event should have a stored row id")

        with SessionLocal() as db:
            count = db.query(ElevenlabsCaptureEvent).filter(ElevenlabsCaptureEvent.client_event_id == "evt-1").count()
            _assert(count == 1, f"expected exactly 1 row after first insert, got {count}")
            gen_count = db.query(ElevenlabsGeneration).filter(ElevenlabsGeneration.provider_creation_id == "hist-1").count()
            _assert(gen_count == 1, f"expected the new event to normalize into 1 generation, got {gen_count}")
        print("ok  first insert of a capture event creates a row and normalizes it")

        # 2. Replaying the exact same client_event_id -> duplicate, no new row.
        with SessionLocal() as db:
            replay_response = elevenlabs_router.capture_events(
                CaptureEventsRequest(events=[
                    CaptureEventIn(
                        event_type="history_row",
                        client_event_id="evt-1",
                        creation_id="hist-1",
                        payload=_history_row(history_item_id="hist-1"),
                    ),
                ]),
                request=None, db=db,
            )
        _assert(replay_response.results[0].status == "duplicate", f"expected duplicate, got {replay_response.results[0].status!r}")
        with SessionLocal() as db:
            count = db.query(ElevenlabsCaptureEvent).filter(ElevenlabsCaptureEvent.client_event_id == "evt-1").count()
            _assert(count == 1, f"duplicate retry must not create a second row, got {count}")
        print("ok  replaying the same client_event_id reports duplicate and does not duplicate the row")

        # 3. An unrecognized event_type -> rejected, id is None.
        with SessionLocal() as db:
            rejected_response = elevenlabs_router.capture_events(
                CaptureEventsRequest(events=[
                    CaptureEventIn(event_type="totally_unknown_event", client_event_id="evt-2", payload={}),
                ]),
                request=None, db=db,
            )
        _assert(rejected_response.results[0].status == "rejected", f"expected rejected, got {rejected_response.results[0].status!r}")
        _assert(rejected_response.results[0].id is None, "rejected event should not have a stored row id")
        with SessionLocal() as db:
            count = db.query(ElevenlabsCaptureEvent).filter(ElevenlabsCaptureEvent.client_event_id == "evt-2").count()
            _assert(count == 0, f"a rejected event must never be stored, got {count}")
        print("ok  unrecognized event_type is rejected cleanly and never stored")
    finally:
        _restore_fakes(*originals)


def test_batch_larger_than_commit_chunk_ingests_everything() -> None:
    """A batch exceeding INGEST_COMMIT_CHUNK_SIZE must still ingest every row
    correctly - proves the chunked-commit loop in capture_events doesn't
    drop or duplicate rows at the chunk boundary."""
    with SessionLocal() as db:
        user = db.query(User).filter(User.id == USER_ID).one()
        tool = db.query(ITPortalTool).filter(ITPortalTool.id == TOOL_ID).one()

    originals = _install_fakes(user, tool)
    try:
        batch_size = INGEST_COMMIT_CHUNK_SIZE + 17
        events = [
            CaptureEventIn(
                event_type="history_row",
                client_event_id=f"batch-evt-{i}",
                creation_id=f"batch-hist-{i}",
                payload=_history_row(history_item_id=f"batch-hist-{i}"),
            )
            for i in range(batch_size)
        ]

        with SessionLocal() as db:
            response = elevenlabs_router.capture_events(CaptureEventsRequest(events=events), request=None, db=db)

        statuses = [r.status for r in response.results]
        _assert(statuses.count("created") == batch_size, f"expected {batch_size} created, got {statuses.count('created')}")

        # Fresh session: proves the work was really COMMITted, not just flushed.
        with SessionLocal() as db:
            persisted = (
                db.query(ElevenlabsCaptureEvent)
                .filter(ElevenlabsCaptureEvent.client_event_id.like("batch-evt-%"))
                .count()
            )
            _assert(persisted == batch_size, f"expected {batch_size} durable capture events, found {persisted}")
            normalized = (
                db.query(ElevenlabsGeneration)
                .filter(ElevenlabsGeneration.provider_creation_id.like("batch-hist-%"))
                .count()
            )
            _assert(normalized == batch_size, f"expected {batch_size} normalized generations, found {normalized}")
        print(f"ok  a batch of {batch_size} events (exceeding the commit chunk size of {INGEST_COMMIT_CHUNK_SIZE}) ingests fully")
    finally:
        _restore_fakes(*originals)


if __name__ == "__main__":
    test_create_then_duplicate_then_rejected()
    test_batch_larger_than_commit_chunk_ingests_everything()
    print("\nall elevenlabs capture smoke checks passed")
