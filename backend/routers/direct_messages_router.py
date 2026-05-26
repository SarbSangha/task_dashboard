from datetime import datetime, timedelta
import asyncio
from collections import defaultdict
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import and_, func, or_
from sqlalchemy.orm import Session

from database_config import get_operational_db
from models_new import ActivityStatus, ChatMessageReaction, ChatMessageReadReceipt, DirectMessage, User, UserActivity
from routers.auth_router import get_current_user
from routers.tasks_router import notification_hub
from utils.datetime_utils import normalize_to_utc_naive, utcnow_naive


router = APIRouter(prefix="/api/direct-messages", tags=["Direct Messages"])
PRESENCE_STALE_SECONDS = 90


class DirectMessagePayload(BaseModel):
    message: str = Field(default="", max_length=5000)
    attachments: list[dict] = Field(default_factory=list)
    reply_to_message_id: Optional[int] = Field(default=None, ge=1)
    forward_metadata: Optional[dict] = None


class MessageEditPayload(BaseModel):
    message: str = Field(min_length=1, max_length=5000)


class TypingPayload(BaseModel):
    active: bool = True


class ReactionPayload(BaseModel):
    emoji: str = Field(min_length=1, max_length=32)


def _utcnow() -> datetime:
    return utcnow_naive()


def _normalize_attachments(items: list[dict]) -> list[dict]:
    normalized = []
    for item in items or []:
        if not isinstance(item, dict):
            continue
        normalized_item = {
            "filename": item.get("filename") or item.get("name") or None,
            "originalName": item.get("originalName") or item.get("filename") or item.get("name") or None,
            "relativePath": item.get("relativePath") or None,
            "path": item.get("path") or None,
            "url": item.get("url") or None,
            "mimetype": item.get("mimetype") or item.get("type") or None,
            "size": item.get("size") or None,
            "storage": item.get("storage") or None,
        }
        if normalized_item["url"] or normalized_item["path"] or normalized_item["filename"]:
            normalized.append(normalized_item)
    return normalized


def _default_presence() -> dict:
    return {
        "status": ActivityStatus.OFFLINE.value,
        "isOnline": False,
        "lastSeen": None,
    }


def _serialize_presence(activity: Optional[UserActivity], now: Optional[datetime] = None) -> dict:
    if not activity:
        return _default_presence()

    current_time = normalize_to_utc_naive(now) or _utcnow()
    last_seen = normalize_to_utc_naive(activity.last_seen)
    is_recent = bool(last_seen and last_seen >= current_time - timedelta(seconds=PRESENCE_STALE_SECONDS))
    status = activity.status.value if hasattr(activity.status, "value") else activity.status
    status = status or ActivityStatus.OFFLINE.value
    if not is_recent:
        status = ActivityStatus.OFFLINE.value

    return {
        "status": status,
        "isOnline": status in {ActivityStatus.ACTIVE.value, ActivityStatus.IDLE.value, ActivityStatus.AWAY.value},
        "lastSeen": last_seen.isoformat() if last_seen else None,
    }


def _build_presence_lookup(db: Session, user_ids: list[int]) -> dict[int, dict]:
    unique_user_ids = sorted({user_id for user_id in user_ids if user_id})
    if not unique_user_ids:
        return {}

    now = _utcnow()
    activities = (
        db.query(UserActivity)
        .filter(UserActivity.user_id.in_(unique_user_ids), UserActivity.date == now.date())
        .all()
    )
    activity_map = {activity.user_id: activity for activity in activities}
    return {user_id: _serialize_presence(activity_map.get(user_id), now) for user_id in unique_user_ids}


def _serialize_user(user: User, presence: Optional[dict] = None) -> dict:
    return {
        "id": user.id,
        "name": user.name,
        "email": user.email,
        "department": user.department,
        "position": user.position,
        "isAdmin": bool(user.is_admin or (user.position or "").lower() == "admin"),
        "presence": presence or _default_presence(),
    }


def _serialize_receipt_user(
    user: User,
    delivered_at: Optional[datetime] = None,
    seen_at: Optional[datetime] = None,
) -> dict:
    return {
        **_serialize_user(user),
        "deliveredAt": delivered_at.isoformat() if delivered_at else None,
        "seenAt": seen_at.isoformat() if seen_at else None,
    }


def _serialize_reactions(
    reactions: list[tuple[ChatMessageReaction, User]],
    current_user_id: int,
) -> dict:
    grouped = {}
    my_reaction = None
    for reaction, user in reactions:
        entry = grouped.setdefault(
            reaction.emoji,
            {
                "emoji": reaction.emoji,
                "count": 0,
                "users": [],
            },
        )
        entry["count"] += 1
        entry["users"].append({
            "id": user.id,
            "name": user.name,
        })
        if user.id == current_user_id:
            my_reaction = reaction.emoji

    return {
        "reactions": sorted(grouped.values(), key=lambda item: (-item["count"], item["emoji"])),
        "myReaction": my_reaction,
    }


def _build_reaction_lookup(
    db: Session,
    message_scope: str,
    message_ids: list[int],
    current_user_id: int,
) -> dict[int, dict]:
    unique_message_ids = sorted({message_id for message_id in message_ids if message_id})
    if not unique_message_ids:
        return {}

    rows = (
        db.query(ChatMessageReaction, User)
        .join(User, User.id == ChatMessageReaction.user_id)
        .filter(
            ChatMessageReaction.message_scope == message_scope,
            ChatMessageReaction.message_id.in_(unique_message_ids),
            User.is_active == True,
            User.is_deleted == False,
        )
        .order_by(ChatMessageReaction.created_at.asc(), User.name.asc())
        .all()
    )
    grouped = defaultdict(list)
    for reaction, user in rows:
        grouped[reaction.message_id].append((reaction, user))

    return {
        message_id: _serialize_reactions(grouped.get(message_id, []), current_user_id)
        for message_id in unique_message_ids
    }


def _notify_receipt_update(user_id: int, payload: dict) -> None:
    try:
        asyncio.create_task(notification_hub.push(user_id, payload))
    except RuntimeError:
        pass


def _get_active_user(db: Session, user_id: int) -> User:
    user = (
        db.query(User)
        .filter(User.id == user_id, User.is_active == True, User.is_deleted == False)
        .first()
    )
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    return user


def _serialize_direct_message(
    message: DirectMessage,
    sender_name: str,
    receipt: Optional[dict] = None,
    reaction_data: Optional[dict] = None,
    reply_to: Optional[dict] = None,
) -> dict:
    return {
        "id": message.id,
        "senderId": message.sender_id,
        "senderName": sender_name,
        "recipientId": message.recipient_id,
        "message": message.message,
        "replyTo": reply_to,
        "attachments": [] if message.deleted_at else (message.attachments_json or []),
        "forwardMetadata": None if message.deleted_at else (message.forward_metadata_json or None),
        "createdAt": message.created_at.isoformat() if message.created_at else None,
        "editedAt": message.edited_at.isoformat() if message.edited_at else None,
        "deletedAt": message.deleted_at.isoformat() if message.deleted_at else None,
        "receipt": receipt,
        **({"reactions": [], "myReaction": None} if message.deleted_at else (reaction_data or {"reactions": [], "myReaction": None})),
    }


def _serialize_direct_reply_preview(message: DirectMessage, sender: User) -> dict:
    is_deleted = bool(message.deleted_at)
    return {
        "id": message.id,
        "senderId": message.sender_id,
        "senderName": sender.name,
        "message": "" if is_deleted else message.message,
        "attachments": [] if is_deleted else (message.attachments_json or []),
        "deletedAt": message.deleted_at.isoformat() if message.deleted_at else None,
    }


def _build_direct_reply_lookup(
    db: Session,
    messages: list[DirectMessage],
) -> dict[int, dict]:
    reply_ids = sorted({message.reply_to_message_id for message in messages if message.reply_to_message_id})
    if not reply_ids:
        return {}

    rows = (
        db.query(DirectMessage, User)
        .join(User, User.id == DirectMessage.sender_id)
        .filter(DirectMessage.id.in_(reply_ids))
        .all()
    )
    return {
        message.id: _serialize_direct_reply_preview(message, sender)
        for message, sender in rows
    }


def _build_direct_receipt_lookup(
    db: Session,
    messages: list[DirectMessage],
    current_user_id: int,
) -> dict[int, dict]:
    sent_messages = [message for message in messages if message.sender_id == current_user_id]
    if not sent_messages:
        return {}

    recipient_ids = {message.recipient_id for message in sent_messages}
    recipient_map = {
        user.id: user
        for user in db.query(User)
        .filter(User.id.in_(recipient_ids), User.is_active == True, User.is_deleted == False)
        .all()
    }
    receipts = {
        receipt.message_id: receipt
        for receipt in db.query(ChatMessageReadReceipt)
        .filter(
            ChatMessageReadReceipt.message_scope == "direct",
            ChatMessageReadReceipt.message_id.in_([message.id for message in sent_messages]),
        )
        .all()
    }

    lookup = {}
    for message in sent_messages:
        recipient = recipient_map.get(message.recipient_id)
        receipt = receipts.get(message.id)
        delivered_at = (receipt.delivered_at or receipt.seen_at) if receipt else None
        delivered_by = [_serialize_receipt_user(recipient, delivered_at, receipt.seen_at)] if recipient and receipt and delivered_at else []
        read_by = [_serialize_receipt_user(recipient, receipt.delivered_at, receipt.seen_at)] if recipient and receipt and receipt.seen_at else []
        lookup[message.id] = {
            "status": "read" if read_by else "delivered" if delivered_by else "sent",
            "totalRecipientCount": 1 if recipient else 0,
            "deliveredCount": len(delivered_by),
            "deliveredBy": delivered_by,
            "readCount": len(read_by),
            "readBy": read_by,
        }
    return lookup


@router.get("/users")
async def list_direct_message_users(
    db: Session = Depends(get_operational_db),
    current_user: User = Depends(get_current_user),
):
    users = (
        db.query(User)
        .filter(User.is_active == True, User.is_deleted == False)
        .order_by(User.name.asc())
        .all()
    )
    visible_users = [user for user in users if user.id != current_user.id]
    presence_lookup = _build_presence_lookup(db, [user.id for user in visible_users])
    return {
        "success": True,
        "data": [_serialize_user(user, presence_lookup.get(user.id)) for user in visible_users],
    }


@router.get("/conversations")
async def list_direct_conversations(
    db: Session = Depends(get_operational_db),
    current_user: User = Depends(get_current_user),
):
    # Split sent/received sides first so the database can use the dedicated
    # sender/recipient indexes before ranking the latest row per conversation.
    sent_rows = (
        db.query(
            DirectMessage.id.label("message_id"),
            DirectMessage.sender_id.label("sender_id"),
            DirectMessage.message.label("message"),
            DirectMessage.attachments_json.label("attachments_json"),
            DirectMessage.created_at.label("created_at"),
            DirectMessage.deleted_at.label("deleted_at"),
            DirectMessage.recipient_id.label("partner_id"),
        )
        .filter(DirectMessage.sender_id == current_user.id)
    )

    received_rows = (
        db.query(
            DirectMessage.id.label("message_id"),
            DirectMessage.sender_id.label("sender_id"),
            DirectMessage.message.label("message"),
            DirectMessage.attachments_json.label("attachments_json"),
            DirectMessage.created_at.label("created_at"),
            DirectMessage.deleted_at.label("deleted_at"),
            DirectMessage.sender_id.label("partner_id"),
        )
        .filter(DirectMessage.recipient_id == current_user.id)
    )

    conversation_rows = sent_rows.union_all(received_rows).subquery()

    ranked_rows = (
        db.query(
            conversation_rows.c.partner_id,
            conversation_rows.c.sender_id,
            conversation_rows.c.message,
            conversation_rows.c.attachments_json,
            conversation_rows.c.created_at,
            conversation_rows.c.deleted_at,
            func.row_number().over(
                partition_by=conversation_rows.c.partner_id,
                order_by=(conversation_rows.c.created_at.desc(), conversation_rows.c.message_id.desc()),
            ).label("row_num"),
        )
        .subquery()
    )

    rows = (
        db.query(
            ranked_rows.c.partner_id,
            ranked_rows.c.sender_id,
            ranked_rows.c.message,
            ranked_rows.c.attachments_json,
            ranked_rows.c.created_at,
            ranked_rows.c.deleted_at,
        )
        .filter(ranked_rows.c.row_num == 1)
        .order_by(ranked_rows.c.created_at.desc())
        .all()
    )

    if not rows:
        return {"success": True, "data": []}

    partners = (
        db.query(User)
        .filter(
            User.id.in_([row.partner_id for row in rows]),
            User.is_active == True,
            User.is_deleted == False,
        )
        .all()
    )
    partner_map = {partner.id: partner for partner in partners}
    presence_lookup = _build_presence_lookup(db, [partner.id for partner in partners])

    data = []
    for row in rows:
        partner = partner_map.get(row.partner_id)
        if not partner:
            continue
        attachments = row.attachments_json or []
        preview = (
            "This message was deleted"
            if row.deleted_at
            else (row.message or "").strip() or f"{len(attachments)} attachment{'s' if len(attachments) != 1 else ''}"
        )
        data.append(
            {
                "user": _serialize_user(partner, presence_lookup.get(partner.id)),
                "lastMessageAt": row.created_at.isoformat() if row.created_at else None,
                "lastMessagePreview": preview[:180],
                "lastMessageSenderId": row.sender_id,
            }
        )

    data.sort(key=lambda item: item.get("lastMessageAt") or "", reverse=True)
    return {"success": True, "data": data}


@router.get("/unread-counts")
async def get_direct_unread_counts(
    db: Session = Depends(get_operational_db),
    current_user: User = Depends(get_current_user),
):
    rows = (
        db.query(
            DirectMessage.sender_id.label("sender_id"),
            func.count(DirectMessage.id).label("unread_count"),
        )
        .join(User, User.id == DirectMessage.sender_id)
        .outerjoin(
            ChatMessageReadReceipt,
            and_(
                ChatMessageReadReceipt.message_scope == "direct",
                ChatMessageReadReceipt.message_id == DirectMessage.id,
                ChatMessageReadReceipt.user_id == current_user.id,
            ),
        )
        .filter(
            DirectMessage.recipient_id == current_user.id,
            DirectMessage.sender_id != current_user.id,
            DirectMessage.deleted_at.is_(None),
            User.is_active == True,
            User.is_deleted == False,
            ChatMessageReadReceipt.seen_at.is_(None),
        )
        .group_by(DirectMessage.sender_id)
        .all()
    )
    conversations = [
        {"userId": row.sender_id, "unreadCount": int(row.unread_count or 0)}
        for row in rows
        if int(row.unread_count or 0) > 0
    ]
    total_unread_messages = sum(item["unreadCount"] for item in conversations)
    return {
        "success": True,
        "data": {
            "conversations": conversations,
            "countsByUserId": {str(item["userId"]): item["unreadCount"] for item in conversations},
            "totalUnreadMessages": total_unread_messages,
            "totalUnreadThreads": len(conversations),
        },
    }


@router.get("/conversations/{other_user_id}/messages")
async def list_direct_messages(
    other_user_id: int,
    db: Session = Depends(get_operational_db),
    current_user: User = Depends(get_current_user),
):
    if other_user_id == current_user.id:
        raise HTTPException(status_code=400, detail="You cannot chat with yourself")

    other_user = _get_active_user(db, other_user_id)
    rows = (
        db.query(DirectMessage, User)
        .join(User, User.id == DirectMessage.sender_id)
        .filter(
            or_(
                and_(DirectMessage.sender_id == current_user.id, DirectMessage.recipient_id == other_user_id),
                and_(DirectMessage.sender_id == other_user_id, DirectMessage.recipient_id == current_user.id),
            )
        )
        .order_by(DirectMessage.created_at.desc(), DirectMessage.id.desc())
        .limit(300)
        .all()
    )
    rows.reverse()
    messages = [message for message, _sender in rows]
    receipt_lookup = _build_direct_receipt_lookup(db, messages, current_user.id)
    reaction_lookup = _build_reaction_lookup(db, "direct", [message.id for message in messages], current_user.id)
    reply_lookup = _build_direct_reply_lookup(db, messages)
    presence_lookup = _build_presence_lookup(db, [other_user.id])
    return {
        "success": True,
        "conversationWith": _serialize_user(other_user, presence_lookup.get(other_user.id)),
        "data": [
            _serialize_direct_message(
                message,
                sender.name,
                receipt_lookup.get(message.id),
                reaction_lookup.get(message.id),
                reply_lookup.get(message.reply_to_message_id),
            )
            for message, sender in rows
        ],
    }


@router.post("/conversations/{other_user_id}/messages/mark-delivered")
async def mark_direct_messages_delivered(
    other_user_id: int,
    db: Session = Depends(get_operational_db),
    current_user: User = Depends(get_current_user),
):
    if other_user_id == current_user.id:
        raise HTTPException(status_code=400, detail="You cannot chat with yourself")

    other_user = _get_active_user(db, other_user_id)
    rows = (
        db.query(DirectMessage.id)
        .filter(
            DirectMessage.sender_id == other_user.id,
            DirectMessage.recipient_id == current_user.id,
            DirectMessage.deleted_at.is_(None),
        )
        .all()
    )
    message_ids = [row.id for row in rows]
    if not message_ids:
        return {"success": True, "markedCount": 0}

    existing = {
        row.message_id: row
        for row in db.query(ChatMessageReadReceipt)
        .filter(
            ChatMessageReadReceipt.message_scope == "direct",
            ChatMessageReadReceipt.user_id == current_user.id,
            ChatMessageReadReceipt.message_id.in_(message_ids),
        )
        .all()
    }
    now = _utcnow()
    changed_count = 0
    for message_id in message_ids:
        receipt = existing.get(message_id)
        if receipt:
            if not receipt.delivered_at:
                receipt.delivered_at = now
                changed_count += 1
            continue
        db.add(
            ChatMessageReadReceipt(
                message_scope="direct",
                message_id=message_id,
                user_id=current_user.id,
                delivered_at=now,
            )
        )
        changed_count += 1
    db.commit()

    if changed_count:
        _notify_receipt_update(other_user.id, {
            "eventType": "message_delivery_receipt",
            "title": f"{current_user.name} received your message",
            "message": f"{current_user.name} received your direct messages",
            "metadata": {
                "scope": "direct",
                "readerId": current_user.id,
                "readerName": current_user.name,
                "otherUserId": current_user.id,
                "deliveredAt": now.isoformat(),
            },
        })

    return {"success": True, "markedCount": changed_count}


@router.post("/conversations/{other_user_id}/messages/mark-read")
async def mark_direct_messages_read(
    other_user_id: int,
    db: Session = Depends(get_operational_db),
    current_user: User = Depends(get_current_user),
):
    if other_user_id == current_user.id:
        raise HTTPException(status_code=400, detail="You cannot chat with yourself")

    other_user = _get_active_user(db, other_user_id)
    rows = (
        db.query(DirectMessage.id)
        .filter(
            DirectMessage.sender_id == other_user.id,
            DirectMessage.recipient_id == current_user.id,
            DirectMessage.deleted_at.is_(None),
        )
        .all()
    )
    message_ids = [row.id for row in rows]
    if not message_ids:
        return {"success": True, "markedCount": 0}

    existing = {
        row.message_id: row
        for row in db.query(ChatMessageReadReceipt)
        .filter(
            ChatMessageReadReceipt.message_scope == "direct",
            ChatMessageReadReceipt.user_id == current_user.id,
            ChatMessageReadReceipt.message_id.in_(message_ids),
        )
        .all()
    }
    now = _utcnow()
    changed_count = 0
    for message_id in message_ids:
        receipt = existing.get(message_id)
        if receipt:
            changed = False
            if not receipt.delivered_at:
                receipt.delivered_at = now
                changed = True
            if not receipt.seen_at:
                receipt.seen_at = now
                changed = True
            if changed:
                changed_count += 1
            continue
        db.add(
            ChatMessageReadReceipt(
                message_scope="direct",
                message_id=message_id,
                user_id=current_user.id,
                delivered_at=now,
                seen_at=now,
            )
        )
        changed_count += 1
    db.commit()

    if changed_count:
        _notify_receipt_update(other_user.id, {
            "eventType": "message_read_receipt",
            "title": f"{current_user.name} read your message",
            "message": f"{current_user.name} read your direct messages",
            "metadata": {
                "scope": "direct",
                "readerId": current_user.id,
                "readerName": current_user.name,
                "otherUserId": current_user.id,
                "deliveredAt": now.isoformat(),
                "seenAt": now.isoformat(),
            },
        })

    return {"success": True, "markedCount": changed_count}


@router.post("/conversations/{other_user_id}/typing")
async def send_direct_typing_indicator(
    other_user_id: int,
    payload: TypingPayload,
    db: Session = Depends(get_operational_db),
    current_user: User = Depends(get_current_user),
):
    if other_user_id == current_user.id:
        raise HTTPException(status_code=400, detail="You cannot chat with yourself")

    recipient = _get_active_user(db, other_user_id)
    ws_payload = {
        "eventType": "chat_typing",
        "title": "",
        "message": "",
        "metadata": {
            "scope": "direct",
            "active": bool(payload.active),
            "senderId": current_user.id,
            "senderName": current_user.name,
            "recipientId": recipient.id,
            "updatedAt": _utcnow().isoformat(),
        },
    }
    try:
        asyncio.create_task(notification_hub.push(recipient.id, ws_payload))
    except RuntimeError:
        pass

    return {"success": True}


def _get_direct_message_for_conversation(
    db: Session,
    message_id: int,
    current_user_id: int,
    other_user_id: int,
) -> DirectMessage:
    message = (
        db.query(DirectMessage)
        .filter(
            DirectMessage.id == message_id,
            or_(
                and_(DirectMessage.sender_id == current_user_id, DirectMessage.recipient_id == other_user_id),
                and_(DirectMessage.sender_id == other_user_id, DirectMessage.recipient_id == current_user_id),
            ),
        )
        .first()
    )
    if not message:
        raise HTTPException(status_code=404, detail="Message not found")
    return message


@router.post("/conversations/{other_user_id}/messages/{message_id}/reaction")
async def set_direct_message_reaction(
    other_user_id: int,
    message_id: int,
    payload: ReactionPayload,
    db: Session = Depends(get_operational_db),
    current_user: User = Depends(get_current_user),
):
    if other_user_id == current_user.id:
        raise HTTPException(status_code=400, detail="You cannot chat with yourself")

    other_user = _get_active_user(db, other_user_id)
    message = _get_direct_message_for_conversation(db, message_id, current_user.id, other_user.id)
    if message.deleted_at:
        raise HTTPException(status_code=400, detail="Deleted messages cannot be reacted to")
    emoji = payload.emoji.strip()
    if not emoji:
        raise HTTPException(status_code=400, detail="Reaction is required")

    now = _utcnow()
    reaction = (
        db.query(ChatMessageReaction)
        .filter(
            ChatMessageReaction.message_scope == "direct",
            ChatMessageReaction.message_id == message.id,
            ChatMessageReaction.user_id == current_user.id,
        )
        .first()
    )
    if reaction:
        reaction.emoji = emoji
        reaction.updated_at = now
    else:
        db.add(ChatMessageReaction(
            message_scope="direct",
            message_id=message.id,
            user_id=current_user.id,
            emoji=emoji,
            created_at=now,
            updated_at=now,
        ))
    db.commit()

    reaction_data = _build_reaction_lookup(db, "direct", [message.id], current_user.id).get(
        message.id,
        {"reactions": [], "myReaction": None},
    )
    _notify_receipt_update(other_user.id, {
        "eventType": "message_reaction",
        "title": f"{current_user.name} reacted to your message",
        "message": f"{current_user.name} reacted to a direct message",
        "metadata": {
            "scope": "direct",
            "messageId": message.id,
            "userId": current_user.id,
            "userName": current_user.name,
            "otherUserId": current_user.id,
            "emoji": emoji,
            "removed": False,
            "updatedAt": now.isoformat(),
        },
    })

    return {"success": True, "data": reaction_data}


@router.delete("/conversations/{other_user_id}/messages/{message_id}/reaction")
async def remove_direct_message_reaction(
    other_user_id: int,
    message_id: int,
    db: Session = Depends(get_operational_db),
    current_user: User = Depends(get_current_user),
):
    if other_user_id == current_user.id:
        raise HTTPException(status_code=400, detail="You cannot chat with yourself")

    other_user = _get_active_user(db, other_user_id)
    message = _get_direct_message_for_conversation(db, message_id, current_user.id, other_user.id)
    if message.deleted_at:
        raise HTTPException(status_code=400, detail="Deleted messages cannot be reacted to")
    reaction = (
        db.query(ChatMessageReaction)
        .filter(
            ChatMessageReaction.message_scope == "direct",
            ChatMessageReaction.message_id == message.id,
            ChatMessageReaction.user_id == current_user.id,
        )
        .first()
    )
    if reaction:
        db.delete(reaction)
        db.commit()

    now = _utcnow()
    reaction_data = _build_reaction_lookup(db, "direct", [message.id], current_user.id).get(
        message.id,
        {"reactions": [], "myReaction": None},
    )
    _notify_receipt_update(other_user.id, {
        "eventType": "message_reaction",
        "title": f"{current_user.name} updated a reaction",
        "message": f"{current_user.name} updated a reaction",
        "metadata": {
            "scope": "direct",
            "messageId": message.id,
            "userId": current_user.id,
            "userName": current_user.name,
            "otherUserId": current_user.id,
            "removed": True,
            "updatedAt": now.isoformat(),
        },
    })

    return {"success": True, "data": reaction_data}


@router.patch("/conversations/{other_user_id}/messages/{message_id}")
async def edit_direct_message(
    other_user_id: int,
    message_id: int,
    payload: MessageEditPayload,
    db: Session = Depends(get_operational_db),
    current_user: User = Depends(get_current_user),
):
    if other_user_id == current_user.id:
        raise HTTPException(status_code=400, detail="You cannot chat with yourself")

    other_user = _get_active_user(db, other_user_id)
    message = _get_direct_message_for_conversation(db, message_id, current_user.id, other_user.id)
    if message.sender_id != current_user.id:
        raise HTTPException(status_code=403, detail="You can only edit your own messages")
    if message.deleted_at:
        raise HTTPException(status_code=400, detail="Deleted messages cannot be edited")

    text = payload.message.strip()
    if not text:
        raise HTTPException(status_code=400, detail="Message is required")

    now = _utcnow()
    message.message = text
    message.edited_at = now
    db.commit()
    db.refresh(message)

    _notify_receipt_update(other_user.id, {
        "eventType": "message_updated",
        "title": f"{current_user.name} edited a message",
        "message": f"{current_user.name} edited a direct message",
        "metadata": {
            "scope": "direct",
            "messageId": message.id,
            "senderId": current_user.id,
            "otherUserId": current_user.id,
            "messageText": message.message,
            "editedAt": message.edited_at.isoformat() if message.edited_at else None,
        },
    })

    return {
        "success": True,
        "data": {
            "id": message.id,
            "message": message.message,
            "editedAt": message.edited_at.isoformat() if message.edited_at else None,
            "deletedAt": None,
        },
    }


@router.delete("/conversations/{other_user_id}/messages/{message_id}")
async def delete_direct_message(
    other_user_id: int,
    message_id: int,
    db: Session = Depends(get_operational_db),
    current_user: User = Depends(get_current_user),
):
    if other_user_id == current_user.id:
        raise HTTPException(status_code=400, detail="You cannot chat with yourself")

    other_user = _get_active_user(db, other_user_id)
    message = _get_direct_message_for_conversation(db, message_id, current_user.id, other_user.id)
    if message.sender_id != current_user.id:
        raise HTTPException(status_code=403, detail="You can only delete your own messages")

    now = _utcnow()
    if not message.deleted_at:
        message.message = ""
        message.attachments_json = []
        message.forward_metadata_json = None
        message.deleted_at = now
        message.edited_at = None
        db.query(ChatMessageReaction).filter(
            ChatMessageReaction.message_scope == "direct",
            ChatMessageReaction.message_id == message.id,
        ).delete(synchronize_session=False)
        db.commit()
        db.refresh(message)

    _notify_receipt_update(other_user.id, {
        "eventType": "message_deleted",
        "title": f"{current_user.name} deleted a message",
        "message": f"{current_user.name} deleted a direct message",
        "metadata": {
            "scope": "direct",
            "messageId": message.id,
            "senderId": current_user.id,
            "otherUserId": current_user.id,
            "deletedAt": message.deleted_at.isoformat() if message.deleted_at else now.isoformat(),
        },
    })

    return {
        "success": True,
        "data": {
            "id": message.id,
            "message": "",
            "attachments": [],
            "editedAt": None,
            "deletedAt": message.deleted_at.isoformat() if message.deleted_at else now.isoformat(),
            "reactions": [],
            "myReaction": None,
        },
    }


@router.post("/conversations/{other_user_id}/messages")
async def send_direct_message(
    other_user_id: int,
    payload: DirectMessagePayload,
    db: Session = Depends(get_operational_db),
    current_user: User = Depends(get_current_user),
):
    if other_user_id == current_user.id:
        raise HTTPException(status_code=400, detail="You cannot chat with yourself")

    recipient = _get_active_user(db, other_user_id)
    text = payload.message.strip()
    attachments = _normalize_attachments(payload.attachments)
    if not text and not attachments:
        raise HTTPException(status_code=400, detail="Message or attachment is required")
    reply_row = None
    if payload.reply_to_message_id:
        reply_row = (
            db.query(DirectMessage, User)
            .join(User, User.id == DirectMessage.sender_id)
            .filter(
                DirectMessage.id == payload.reply_to_message_id,
                or_(
                    and_(DirectMessage.sender_id == current_user.id, DirectMessage.recipient_id == recipient.id),
                    and_(DirectMessage.sender_id == recipient.id, DirectMessage.recipient_id == current_user.id),
                ),
            )
            .first()
        )
        if not reply_row:
            raise HTTPException(status_code=404, detail="Reply target message not found")

    now = _utcnow()
    message = DirectMessage(
        sender_id=current_user.id,
        recipient_id=recipient.id,
        reply_to_message_id=payload.reply_to_message_id,
        message=text,
        attachments_json=attachments,
        forward_metadata_json=payload.forward_metadata or None,
        created_at=now,
    )
    db.add(message)
    db.commit()
    db.refresh(message)

    ws_payload = {
        "eventType": "direct_message",
        "title": f"New message from {current_user.name}",
        "message": (text or f"{len(attachments)} attachment{'s' if len(attachments) != 1 else ''}")[:180],
        "attachments": attachments,
        "metadata": {
            "messageId": message.id,
            "senderId": current_user.id,
            "senderName": current_user.name,
            "recipientId": recipient.id,
            "messageText": text,
            "replyTo": _serialize_direct_reply_preview(*reply_row) if reply_row else None,
            "attachmentCount": len(attachments),
            "forwardMetadata": message.forward_metadata_json or None,
            "createdAt": message.created_at.isoformat() if message.created_at else None,
        },
    }
    try:
        asyncio.create_task(notification_hub.push(recipient.id, ws_payload))
    except RuntimeError:
        pass

    return {
        "success": True,
        "data": _serialize_direct_message(
            message,
            current_user.name,
            reply_to=_serialize_direct_reply_preview(*reply_row) if reply_row else None,
        ),
    }
