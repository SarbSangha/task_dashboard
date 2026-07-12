import asyncio
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

from models_new import Base, ITPortalTool, ITPortalToolCredential, User  # noqa: E402
from providers.chatgpt.health import compute_capture_health_status  # noqa: E402
from providers.chatgpt.models import ConversationCaptureEvent, ConversationCaptureHealth  # noqa: E402
from providers.chatgpt.router import capture_events, get_capture_health, report_capture_health  # noqa: E402
from providers.chatgpt.schemas import CaptureEventIn, CaptureEventsRequest, CaptureHealthPingIn  # noqa: E402


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
        ITPortalToolCredential.__table__,
        ConversationCaptureEvent.__table__,
        ConversationCaptureHealth.__table__,
    ],
)


def _assert(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def _create_user(email: str, name: str) -> int:
    with SessionLocal() as db:
        user = User(email=email, name=name, hashed_password="hashed-password", is_active=True, is_deleted=False)
        db.add(user)
        db.commit()
        db.refresh(user)
        return user.id


def _create_chatgpt_tool() -> int:
    with SessionLocal() as db:
        tool = ITPortalTool(
            name="ChatGPT",
            slug="chatgpt",
            website_url="https://chatgpt.com/",
            launch_mode="extension_autofill",
            is_active=True,
        )
        db.add(tool)
        db.commit()
        db.refresh(tool)
        return tool.id


def _post_events(user_id: int, events: list[CaptureEventIn]) -> dict:
    with SessionLocal() as db:
        user = db.get(User, user_id)
        payload = CaptureEventsRequest(events=events)
        response = asyncio.run(capture_events(payload, db=db, current_user=user))
        return response.model_dump()


def _post_health(user_id: int, ping: CaptureHealthPingIn) -> dict:
    with SessionLocal() as db:
        user = db.get(User, user_id)
        response = asyncio.run(report_capture_health(ping, db=db, current_user=user))
        return response.model_dump()


def _get_health(user_id: int) -> dict:
    with SessionLocal() as db:
        user = db.get(User, user_id)
        response = asyncio.run(get_capture_health(db=db, current_user=user))
        return response.model_dump()


def main() -> int:
    user_a_id = _create_user("user-a@example.com", "User A")
    _create_user("user-b@example.com", "User B")
    _create_chatgpt_tool()

    # 1. Basic capture across the event lifecycle.
    result = _post_events(
        user_a_id,
        [
            CaptureEventIn(event_type="conversation_opened", client_event_id="evt-1", conversation_id="conv-1", payload={}),
            CaptureEventIn(event_type="prompt_captured", client_event_id="evt-2", conversation_id="conv-1", message_id="msg-1", payload={"text": "hello"}),
            CaptureEventIn(event_type="response_started", client_event_id="evt-3", conversation_id="conv-1", message_id="msg-2", payload={}),
            CaptureEventIn(event_type="response_completed", client_event_id="evt-4", conversation_id="conv-1", message_id="msg-2", payload={"text": "hi there"}),
        ],
    )
    _assert(result["success"] is True, "Batch capture should succeed")
    statuses = [r["status"] for r in result["results"]]
    _assert(statuses == ["created", "created", "created", "created"], f"All 4 distinct events should be created, got {statuses}")
    print("PASS basic multi-event-type capture (including response_started + response_completed sharing no message collision)")

    # 2. response_started and response_completed sharing the SAME message_id must both persist
    #    (this is exactly the case the old provider_message_id-unique index would have broken).
    with SessionLocal() as db:
        rows = (
            db.query(ConversationCaptureEvent)
            .filter(ConversationCaptureEvent.provider_message_id == "msg-2")
            .all()
        )
        _assert(len(rows) == 2, f"Both response_started and response_completed for msg-2 should persist as separate rows, got {len(rows)}")
    print("PASS multiple events sharing one provider_message_id are not deduped against each other")

    # 3. Idempotent retry: same client_event_id twice must not create a second row.
    retry_result = _post_events(
        user_a_id,
        [CaptureEventIn(event_type="prompt_captured", client_event_id="evt-2", conversation_id="conv-1", message_id="msg-1", payload={"text": "hello"})],
    )
    _assert(retry_result["results"][0]["status"] == "duplicate", "Retrying the same client_event_id should report duplicate")
    with SessionLocal() as db:
        count = db.query(ConversationCaptureEvent).filter(ConversationCaptureEvent.client_event_id == "evt-2").count()
        _assert(count == 1, f"Duplicate retry must not create a second row, got {count}")
    print("PASS idempotent retry (same client_event_id never duplicates)")

    # 4. Unknown event_type is rejected, not silently accepted or crashed on.
    rejected_result = _post_events(
        user_a_id,
        [CaptureEventIn(event_type="totally_unknown_event", client_event_id="evt-5", payload={})],
    )
    _assert(rejected_result["results"][0]["status"] == "rejected", "Unknown event_type should be rejected")
    _assert(rejected_result["results"][0]["id"] is None, "Rejected event should not have a stored row id")
    print("PASS unknown event_type rejected cleanly")

    # 5. Lifecycle events with no message_id at all (e.g. repeated renames) must each persist -
    #    they are distinguished purely by client_event_id, never by provider_message_id/fingerprint.
    rename_result = _post_events(
        user_a_id,
        [
            CaptureEventIn(event_type="conversation_renamed", client_event_id="evt-rename-1", conversation_id="conv-1", payload={"title": "First title"}),
            CaptureEventIn(event_type="conversation_renamed", client_event_id="evt-rename-2", conversation_id="conv-1", payload={"title": "Second title"}),
        ],
    )
    _assert(
        [r["status"] for r in rename_result["results"]] == ["created", "created"],
        "Two distinct rename events (no message_id) should both be created, not deduped against each other",
    )
    print("PASS repeated message-id-less lifecycle events (renames) both persist")

    # 6. Capture Health: first ping creates a snapshot, second ping for the same
    #    extension_session_id updates it in place (never a second row for one install).
    _post_health(
        user_a_id,
        CaptureHealthPingIn(extension_session_id="install-1", extension_version="1.0.0", queue_length=3, events_waiting=3, retry_count=1),
    )
    second_ping = _post_health(
        user_a_id,
        CaptureHealthPingIn(extension_session_id="install-1", extension_version="1.0.1", queue_length=0, events_waiting=0, last_successful_upload_at="2026-01-01T00:00:00"),
    )
    _assert(second_ping["data"]["queueLength"] == 0, "Second ping should reflect the latest reported queue length")
    _assert(second_ping["data"]["extensionVersion"] == "1.0.1", "Second ping should update extension_version in place")
    with SessionLocal() as db:
        count = db.query(ConversationCaptureHealth).filter(ConversationCaptureHealth.extension_session_id == "install-1").count()
        _assert(count == 1, f"Repeated pings for the same install must upsert, not insert, got {count} rows")
    print("PASS capture health upserts by extension_session_id")

    health_view = _get_health(user_a_id)
    _assert(len(health_view["data"]["installs"]) == 1, "User A should see exactly one health snapshot (one install pinged)")
    print("PASS capture health read-back scoped to the requesting user")

    # 7. Derived status: empty queue + no offline_since + fresh ping = healthy.
    _assert(second_ping["data"]["status"] == "healthy", f"Idle install with empty queue should be healthy, got {second_ping['data']['status']}")
    print("PASS derived status: healthy")

    # 8. Derived status: large queue = backlogged (takes priority over plain degraded).
    backlogged_ping = _post_health(
        user_a_id,
        CaptureHealthPingIn(extension_session_id="install-backlogged", queue_length=600, events_waiting=600),
    )
    _assert(backlogged_ping["data"]["status"] == "backlogged", f"Large queue should be backlogged, got {backlogged_ping['data']['status']}")
    print("PASS derived status: backlogged")

    # 9. Derived status: explicit offline_since = offline (takes priority over backlogged/degraded).
    offline_ping = _post_health(
        user_a_id,
        CaptureHealthPingIn(extension_session_id="install-offline", queue_length=600, offline_since="2026-01-01T00:00:00"),
    )
    _assert(offline_ping["data"]["status"] == "offline", f"Explicit offline_since should win over backlogged, got {offline_ping['data']['status']}")
    print("PASS derived status: offline (explicit offline_since)")

    # 10. Derived status: small nonzero queue with no other signal = degraded, not backlogged/healthy.
    degraded_ping = _post_health(
        user_a_id,
        CaptureHealthPingIn(extension_session_id="install-degraded", queue_length=5, events_waiting=5),
    )
    _assert(degraded_ping["data"]["status"] == "degraded", f"Small nonzero queue should be degraded, got {degraded_ping['data']['status']}")
    print("PASS derived status: degraded (nonzero queue below backlog threshold)")

    # 11. Derived status: actively capturing but nothing successfully uploaded recently = degraded,
    #     distinguishing "broken while active" from "idle and healthy" - exactly what
    #     last_capture_event_at exists for.
    capturing_without_delivery_ping = _post_health(
        user_a_id,
        CaptureHealthPingIn(
            extension_session_id="install-capturing-stuck",
            queue_length=0,
            last_capture_event_at="2026-01-01T12:00:00",
            last_successful_upload_at="2026-01-01T10:00:00",
        ),
    )
    _assert(
        capturing_without_delivery_ping["data"]["status"] == "degraded",
        f"Recent capture with no matching recent successful upload should be degraded, got {capturing_without_delivery_ping['data']['status']}",
    )
    print("PASS derived status: degraded (capturing without delivery, empty-queue-alone would look healthy)")

    # 12. Derived status: a ping that stopped arriving a long time ago reads as offline even
    #     without an explicit offline_since - tested directly against the pure function since
    #     it depends on wall-clock "now" relative to reported_at, not on ping-time values alone.
    stale_record = ConversationCaptureHealth(
        provider="chatgpt",
        user_id=user_a_id,
        queue_length=0,
        reported_at=datetime.utcnow() - timedelta(hours=2),
    )
    stale_status = compute_capture_health_status(stale_record)
    _assert(stale_status == "offline", f"A ping over the staleness threshold old should read offline, got {stale_status}")
    print("PASS derived status: offline (stale ping, no explicit offline_since)")

    engine.dispose()
    print("SMOKE TESTS PASSED")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
