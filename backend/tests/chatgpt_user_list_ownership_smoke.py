"""Regression cover for providers/chatgpt/queries.py's list_users()/
get_user_detail() - fixed 2026-08-05 after a real production report: the
admin-facing Capture Center showed "22 users" on its metrics tile but only
ever listed 2 of them.

Root cause: list_users() required ConversationRecord.ownership_status ==
'resolved' to include a user at all - correct, deliberate behavior for
never *guessing* who owns a pre-existing conversation (see normalization.py's
_is_attributable), but it meant any user whose conversations were all
captured mid-thread (not literally at creation) was silently dropped from
this admin visibility view entirely, while /metrics (no ownership gate)
still counted them. Fixed by falling back to the raw capturing
ConversationCaptureEvent.user_id when ownership isn't resolved, flagged via
hasUnresolvedConversations rather than presented with the same confidence
as a fully-resolved user.

Run: python tests/chatgpt_user_list_ownership_smoke.py
"""
import os
import sys
from datetime import date, datetime
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
from providers.chatgpt.constants import (  # noqa: E402
    EVENT_TYPE_PROMPT_CAPTURED,
    EVENT_TYPE_RESPONSE_COMPLETED,
    OWNERSHIP_STATUS_RESOLVED,
    OWNERSHIP_STATUS_UNKNOWN,
)
from providers.chatgpt.models import (  # noqa: E402
    ConversationCaptureAttachment,
    ConversationCaptureEvent,
    ConversationMediaAsset,
    ConversationRecord,
)
from providers.chatgpt import queries as chatgpt_queries  # noqa: E402


engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
Base.metadata.create_all(
    bind=engine,
    tables=[
        User.__table__,
        ITPortalTool.__table__,
        ConversationCaptureEvent.__table__,
        ConversationRecord.__table__,
        ConversationCaptureAttachment.__table__,
        ConversationMediaAsset.__table__,
    ],
)


def _assert(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def _seed_actor(email: str, name: str) -> tuple[int, int]:
    with SessionLocal() as db:
        tool = db.query(ITPortalTool).filter(ITPortalTool.slug == "chatgpt").first()
        if not tool:
            tool = ITPortalTool(name="ChatGPT", slug="chatgpt", website_url="https://chatgpt.com", is_active=True)
            db.add(tool)
        user = User(email=email, name=name, hashed_password="x", is_active=True, is_deleted=False)
        db.add(user)
        db.commit()
        return user.id, tool.id


def _event(*, user_id, tool_id, conversation_id, event_type, client_event_id):
    return ConversationCaptureEvent(
        tool_id=tool_id,
        user_id=user_id,
        provider="chatgpt",
        event_type=event_type,
        client_event_id=client_event_id,
        provider_conversation_id=conversation_id,
        payload_json={},
        event_date=date.today(),
        created_at=datetime.utcnow(),
    )


def test_user_with_only_unresolved_conversations_still_appears() -> None:
    """The exact production bug: a user whose only conversation was captured
    mid-thread (never isNewConversation) must still show up in list_users(),
    not vanish entirely."""
    with SessionLocal() as db:
        user_id, tool_id = _seed_actor("unresolved@example.com", "Continuation Chahal")

        record = ConversationRecord(
            provider="chatgpt",
            provider_conversation_id="conv-unresolved-1",
            ownership_status=OWNERSHIP_STATUS_UNKNOWN,
        )
        db.add(record)
        db.add(_event(user_id=user_id, tool_id=tool_id, conversation_id="conv-unresolved-1", event_type=EVENT_TYPE_PROMPT_CAPTURED, client_event_id="e1"))
        db.add(_event(user_id=user_id, tool_id=tool_id, conversation_id="conv-unresolved-1", event_type=EVENT_TYPE_RESPONSE_COMPLETED, client_event_id="e2"))
        db.flush()

        items, total = chatgpt_queries.list_users(db, limit=50, offset=0)
        _assert(total == 1, f"expected 1 user, got total={total}")
        _assert(len(items) == 1, f"expected 1 user returned, got {len(items)}")
        _assert(items[0]["userId"] == user_id, f"wrong user returned: {items[0]}")
        _assert(items[0]["conversationsCount"] == 1, f"expected 1 conversation, got {items[0]['conversationsCount']}")
        _assert(items[0]["messagesCount"] == 2, f"expected 2 messages, got {items[0]['messagesCount']}")
        _assert(items[0]["hasUnresolvedConversations"] is True, "user with only unresolved conversations must be flagged")

        detail = chatgpt_queries.get_user_detail(db, user_id)
        _assert(detail is not None, "get_user_detail returned None for a user with unresolved conversations")
        _assert(detail["conversationsCount"] == 1, f"get_user_detail conversationsCount mismatch: {detail}")
        _assert(detail["messagesCount"] == 2, f"get_user_detail messagesCount mismatch: {detail}")
        _assert(detail["hasUnresolvedConversations"] is True, "get_user_detail must flag unresolved conversations too")
        db.rollback()
    print("ok  a user whose only conversation is unresolved still appears, flagged")


def test_user_with_only_resolved_conversations_is_not_flagged() -> None:
    with SessionLocal() as db:
        user_id, tool_id = _seed_actor("resolved@example.com", "Fresh Fatima")

        record = ConversationRecord(
            provider="chatgpt",
            provider_conversation_id="conv-resolved-1",
            owner_user_id=user_id,
            ownership_status=OWNERSHIP_STATUS_RESOLVED,
        )
        db.add(record)
        db.add(_event(user_id=user_id, tool_id=tool_id, conversation_id="conv-resolved-1", event_type=EVENT_TYPE_PROMPT_CAPTURED, client_event_id="e3"))
        db.flush()

        items, total = chatgpt_queries.list_users(db, limit=50, offset=0)
        _assert(total == 1, f"expected 1 user, got total={total}")
        _assert(items[0]["hasUnresolvedConversations"] is False, "a fully-resolved user must not be flagged")
        db.rollback()
    print("ok  a user with only resolved conversations is not flagged")


def test_mixed_resolved_and_unresolved_conversations_both_count() -> None:
    """A user with ONE resolved conversation and ONE unresolved one (e.g.
    they started a brand-new chat, but also replied inside an old thread
    someone else's session first surfaced) must have BOTH counted, and be
    flagged, matching the "best-effort but not fully certain" reality."""
    with SessionLocal() as db:
        user_id, tool_id = _seed_actor("mixed@example.com", "Mixed Manav")

        db.add(ConversationRecord(
            provider="chatgpt", provider_conversation_id="conv-mixed-resolved",
            owner_user_id=user_id, ownership_status=OWNERSHIP_STATUS_RESOLVED,
        ))
        db.add(ConversationRecord(
            provider="chatgpt", provider_conversation_id="conv-mixed-unresolved",
            ownership_status=OWNERSHIP_STATUS_UNKNOWN,
        ))
        db.add(_event(user_id=user_id, tool_id=tool_id, conversation_id="conv-mixed-resolved", event_type=EVENT_TYPE_PROMPT_CAPTURED, client_event_id="e4"))
        db.add(_event(user_id=user_id, tool_id=tool_id, conversation_id="conv-mixed-unresolved", event_type=EVENT_TYPE_PROMPT_CAPTURED, client_event_id="e5"))
        db.flush()

        items, total = chatgpt_queries.list_users(db, limit=50, offset=0)
        _assert(total == 1, f"expected 1 user (not split into two), got total={total}")
        _assert(items[0]["conversationsCount"] == 2, f"expected both conversations counted, got {items[0]['conversationsCount']}")
        _assert(items[0]["hasUnresolvedConversations"] is True, "a user with even one unresolved conversation must be flagged")
        db.rollback()
    print("ok  a user's resolved and unresolved conversations are combined under one entry, flagged")


def test_someone_elses_unresolved_conversation_does_not_leak_to_a_different_user() -> None:
    """Sanity check that the fallback doesn't break the original safety
    property for RESOLVED conversations: if user A's conversation is
    resolved to user A, a capture event from a DIFFERENT user B merely
    continuing to view it must not get attributed to B."""
    with SessionLocal() as db:
        owner_id, tool_id = _seed_actor("owner@example.com", "Owner Om")
        viewer_id, _ = _seed_actor("viewer@example.com", "Viewer Vic")

        db.add(ConversationRecord(
            provider="chatgpt", provider_conversation_id="conv-owned",
            owner_user_id=owner_id, ownership_status=OWNERSHIP_STATUS_RESOLVED,
        ))
        db.add(_event(user_id=owner_id, tool_id=tool_id, conversation_id="conv-owned", event_type=EVENT_TYPE_PROMPT_CAPTURED, client_event_id="e6"))
        db.add(_event(user_id=viewer_id, tool_id=tool_id, conversation_id="conv-owned", event_type=EVENT_TYPE_PROMPT_CAPTURED, client_event_id="e7"))
        db.flush()

        items, total = chatgpt_queries.list_users(db, limit=50, offset=0)
        by_user = {item["userId"]: item for item in items}
        _assert(owner_id in by_user, "the resolved owner must appear")
        _assert(by_user[owner_id]["conversationsCount"] == 1, f"owner's conversation count wrong: {by_user[owner_id]}")
        _assert(viewer_id not in by_user, "a viewer of someone else's RESOLVED conversation must not be attributed it - resolved ownership stays sticky to the true owner")
        db.rollback()
    print("ok  a resolved conversation stays attributed to its true owner even if someone else's session also touches it")


if __name__ == "__main__":
    test_user_with_only_unresolved_conversations_still_appears()
    test_user_with_only_resolved_conversations_is_not_flagged()
    test_mixed_resolved_and_unresolved_conversations_both_count()
    test_someone_elses_unresolved_conversation_does_not_leak_to_a_different_user()
    print("\nall chatgpt user-list ownership smoke checks passed")
