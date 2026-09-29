"""Regression cover for providers/claude/normalization.py's silent-
normalization-failure retry, extended to conversation-level events:

  1. _find_unapplied_conversation_metadata_events flags a ConversationRecord
     whose title/provider_created_time never landed, even though the raw
     conversation_opened event carried both.
  2. normalize_capture_events_batch's retry pass actually backfills them -
     this is what scripts/backfill_claude_normalization.py leans on to repair
     a record that already silently failed once, and what protects every
     future event of this kind from the same fate going forward.
  3. A record that DID normalize correctly the first time is never flagged
     (no needless retries/log noise on the happy path).
  4. The existing message-event retry (prompt_captured/response_completed,
     from dd876ec) still works, side by side with the new check.

Confirmed live (2026-09-22): two real conversations (69 and 214 messages)
ended up with title=None and provider_created_time=None despite their raw
conversation_opened events carrying both correctly - every message inside
them normalized fine, only the conversation-level metadata silently did not
stick, and nothing retried it before this fix.

Run: python tests/claude_normalization_smoke.py
"""
import os
import sys
from datetime import date, datetime, timedelta
from pathlib import Path

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool


BACKEND_DIR = Path(__file__).resolve().parents[1]
os.environ.setdefault("DATABASE_URL", "postgresql://placeholder:placeholder@localhost:5432/placeholder")
os.environ.setdefault("ARCHIVE_DATABASE_URL", os.environ["DATABASE_URL"])
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from models_new import Base, ITPortalTool, User  # noqa: E402
from providers.chatgpt.models import (  # noqa: E402
    ConversationCaptureEvent,
    ConversationPrompt,
    ConversationRecord,
    ConversationResponse,
)
from providers.claude.normalization import (  # noqa: E402
    _find_unapplied_conversation_metadata_events,
    normalize_capture_events_batch,
)

engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
Base.metadata.create_all(
    bind=engine,
    tables=[
        User.__table__,
        ITPortalTool.__table__,
        ConversationRecord.__table__,
        ConversationPrompt.__table__,
        ConversationResponse.__table__,
        ConversationCaptureEvent.__table__,
    ],
)


def _assert(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


_fixture_counter = 0


def _make_tool_and_user(db) -> tuple[int, int]:
    global _fixture_counter
    _fixture_counter += 1
    tool = ITPortalTool(name="Claude", slug=f"claude-{_fixture_counter}", website_url="https://claude.ai")
    user = User(
        email=f"capture-{_fixture_counter}@example.com", name="capture",
        hashed_password="x", is_active=True, is_deleted=False,
    )
    db.add_all([tool, user])
    db.commit()
    db.refresh(tool)
    db.refresh(user)
    return tool.id, user.id


def _make_event(*, tool_id, user_id, event_type, conversation_id, client_event_id, payload, message_id=None) -> ConversationCaptureEvent:
    return ConversationCaptureEvent(
        tool_id=tool_id,
        user_id=user_id,
        provider="claude",
        event_type=event_type,
        client_event_id=client_event_id,
        provider_conversation_id=conversation_id,
        provider_message_id=message_id,
        payload_json=payload,
        event_date=date.today(),
        created_at=datetime.utcnow(),
    )


def test_flags_and_backfills_title_and_created_time() -> None:
    with SessionLocal() as db:
        tool_id, user_id = _make_tool_and_user(db)
        conversation_id = "conv-broken-1"
        provider_created_at = (datetime.utcnow() - timedelta(days=10)).isoformat() + "Z"

        # The record already exists in the exact broken state the live
        # incident left behind: created (by whatever event got there first),
        # but title/provider_created_time never applied.
        record = ConversationRecord(
            provider="claude",
            provider_conversation_id=conversation_id,
            ingestion_source="captured",
            ownership_status="unknown",
        )
        db.add(record)
        db.commit()

        event = _make_event(
            tool_id=tool_id, user_id=user_id,
            event_type="conversation_opened",
            conversation_id=conversation_id,
            client_event_id="evt-1",
            payload={
                "title": "Indexation checker tool",
                "providerCreatedAt": provider_created_at,
                "isNewConversation": False,
            },
        )
        db.add(event)
        db.commit()
        db.refresh(event)

        flagged = _find_unapplied_conversation_metadata_events(db, [event])
        _assert(len(flagged) == 1 and flagged[0].id == event.id, "a record missing title+created_time should be flagged for retry")

        result = normalize_capture_events_batch(db, [event])
        _assert(result["errors"] == 0, f"expected no errors, got {result}")

        db.refresh(record)
        _assert(record.title == "Indexation checker tool", f"title should have backfilled, got {record.title!r}")
        _assert(record.provider_created_time is not None, "provider_created_time should have backfilled")

        # Re-running the exact same event again (idempotency - this is what
        # backfill_all does on every historical event, every time it runs)
        # must not flag it again or change anything.
        still_flagged = _find_unapplied_conversation_metadata_events(db, [event])
        _assert(still_flagged == [], "a now-correct record must not be flagged again")


def test_healthy_record_is_never_flagged() -> None:
    with SessionLocal() as db:
        tool_id, user_id = _make_tool_and_user(db)
        conversation_id = "conv-healthy-1"
        provider_created_at = datetime.utcnow().isoformat() + "Z"

        event = _make_event(
            tool_id=tool_id, user_id=user_id,
            event_type="conversation_created",
            conversation_id=conversation_id,
            client_event_id="evt-2",
            payload={"title": "New chat", "providerCreatedAt": provider_created_at, "isNewConversation": True},
        )
        db.add(event)
        db.commit()
        db.refresh(event)

        result = normalize_capture_events_batch(db, [event])
        _assert(result["errors"] == 0, f"expected no errors, got {result}")

        record = db.query(ConversationRecord).filter(ConversationRecord.provider_conversation_id == conversation_id).first()
        _assert(record.title == "New chat", "title should be set on first successful pass")
        _assert(record.ownership_status == "resolved", "a genuinely new conversation should resolve ownership")

        _assert(
            _find_unapplied_conversation_metadata_events(db, [event]) == [],
            "an event that normalized correctly the first time should never be flagged",
        )


def test_message_event_retry_still_works_alongside_new_check() -> None:
    """dd876ec's original protection (prompt/response events) must keep
    working unchanged now that it shares normalize_capture_events_batch's
    retry pass with the new conversation-metadata check."""
    with SessionLocal() as db:
        tool_id, user_id = _make_tool_and_user(db)
        conversation_id = "conv-msg-1"

        record = ConversationRecord(provider="claude", provider_conversation_id=conversation_id, ingestion_source="captured")
        db.add(record)
        db.commit()

        event = _make_event(
            tool_id=tool_id, user_id=user_id,
            event_type="prompt_captured",
            conversation_id=conversation_id,
            client_event_id="evt-3",
            message_id="msg-1",
            payload={"text": "hello", "sequenceIndex": 1},
        )
        db.add(event)
        db.commit()
        db.refresh(event)

        result = normalize_capture_events_batch(db, [event])
        _assert(result["errors"] == 0, f"expected no errors, got {result}")

        prompt = db.query(ConversationPrompt).filter(ConversationPrompt.provider_message_id == "msg-1").first()
        _assert(prompt is not None, "the prompt row should have normalized")


def run() -> None:
    tests = [
        test_flags_and_backfills_title_and_created_time,
        test_healthy_record_is_never_flagged,
        test_message_event_retry_still_works_alongside_new_check,
    ]
    for test in tests:
        test()
        print(f"  ok  {test.__name__}")
    print(f"\nclaude normalization smoke: {len(tests)} passed")


if __name__ == "__main__":
    run()
