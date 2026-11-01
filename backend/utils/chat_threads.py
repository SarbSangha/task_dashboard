"""Shared helpers for pinned chat messages and per-user thread mutes.

Used by routers/groups_router.py ("group" scope, thread id = group id) and
routers/direct_messages_router.py ("direct" scope, thread id = the other
participant's user id).
"""
from typing import Iterable, Optional

from sqlalchemy.orm import Session

from models_new import ChatThreadMute, User

PINNED_MESSAGES_LIMIT = 25


def muted_thread_ids(db: Session, user_id: int, scope: str) -> set[int]:
    rows = (
        db.query(ChatThreadMute.thread_id)
        .filter(ChatThreadMute.user_id == user_id, ChatThreadMute.message_scope == scope)
        .all()
    )
    return {row.thread_id for row in rows}


def users_muting_thread(db: Session, scope: str, thread_id: int, user_ids: Iterable[int]) -> set[int]:
    candidate_ids = sorted({int(user_id) for user_id in user_ids if user_id})
    if not candidate_ids:
        return set()
    rows = (
        db.query(ChatThreadMute.user_id)
        .filter(
            ChatThreadMute.message_scope == scope,
            ChatThreadMute.thread_id == thread_id,
            ChatThreadMute.user_id.in_(candidate_ids),
        )
        .all()
    )
    return {row.user_id for row in rows}


def set_thread_muted(db: Session, user_id: int, scope: str, thread_id: int, muted: bool) -> bool:
    existing = (
        db.query(ChatThreadMute)
        .filter(
            ChatThreadMute.user_id == user_id,
            ChatThreadMute.message_scope == scope,
            ChatThreadMute.thread_id == thread_id,
        )
        .first()
    )
    if muted and not existing:
        db.add(ChatThreadMute(user_id=user_id, message_scope=scope, thread_id=thread_id))
    elif not muted and existing:
        db.delete(existing)
    db.commit()
    return muted


def mark_payload_muted(payload: dict) -> dict:
    """Copy of a realtime payload flagged so clients and web push stay quiet."""
    return {**payload, "metadata": {**(payload.get("metadata") or {}), "muted": True}}


def build_pinner_lookup(db: Session, messages: Iterable) -> dict[int, str]:
    pinner_ids = sorted({message.pinned_by for message in messages if getattr(message, "pinned_by", None)})
    if not pinner_ids:
        return {}
    return {row.id: row.name for row in db.query(User.id, User.name).filter(User.id.in_(pinner_ids)).all()}


def serialize_pin_fields(message, pinner_lookup: dict[int, str]) -> dict:
    if not message.pinned_at or message.deleted_at:
        return {"pinnedAt": None, "pinnedBy": None}
    return {
        "pinnedAt": message.pinned_at.isoformat(),
        "pinnedBy": {
            "id": message.pinned_by,
            "name": pinner_lookup.get(message.pinned_by) or "Someone",
        } if message.pinned_by else None,
    }


def serialize_pinned_message(message, sender_name: str, pinner_lookup: dict[int, str]) -> dict:
    return {
        "id": message.id,
        "senderId": message.sender_id,
        "senderName": sender_name,
        "message": message.message,
        "attachments": message.attachments_json or [],
        "createdAt": message.created_at.isoformat() if message.created_at else None,
        **serialize_pin_fields(message, pinner_lookup),
    }


def pin_event_payload(
    *,
    scope: str,
    actor: User,
    message_id: int,
    pinned: bool,
    group_id: Optional[int] = None,
    other_user_id: Optional[int] = None,
    thread_label: str = "",
) -> dict:
    verb = "pinned" if pinned else "unpinned"
    metadata = {
        "scope": scope,
        "messageId": message_id,
        "pinned": pinned,
        "userId": actor.id,
        "userName": actor.name,
    }
    if group_id is not None:
        metadata["groupId"] = group_id
    if other_user_id is not None:
        metadata["otherUserId"] = other_user_id
    return {
        "eventType": "message_pinned",
        "title": f"{actor.name} {verb} a message{f' in {thread_label}' if thread_label else ''}",
        "message": f"{actor.name} {verb} a message",
        "metadata": {**metadata, "muted": True},
    }
