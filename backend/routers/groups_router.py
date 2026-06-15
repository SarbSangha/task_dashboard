from datetime import datetime, timedelta
from typing import Optional
from collections import defaultdict
import logging
import time

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session
from sqlalchemy import and_, func, select

from database_config import get_operational_db
from models_new import ActivityStatus, ChatMessageReaction, ChatMessageReadReceipt, GroupChat, GroupChatMember, GroupChatMessage, User, UserActivity
from routers.auth_router import get_current_user
from routers.tasks_router import notification_dispatcher
from utils.cache import cache_response
from utils.datetime_utils import normalize_to_utc_naive, utcnow_naive


router = APIRouter(prefix="/api/groups", tags=["Groups"])
PRESENCE_STALE_SECONDS = 90
TYPING_THROTTLE_SECONDS = 5
_TYPING_THROTTLE: dict[tuple[int, int, bool], float] = {}
logger = logging.getLogger(__name__)


class GroupCreatePayload(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    member_ids: list[int] = Field(default_factory=list)


class GroupMembersPayload(BaseModel):
    member_ids: list[int] = Field(default_factory=list)


class GroupMessagePayload(BaseModel):
    message: str = Field(default="", max_length=5000)
    attachments: list[dict] = Field(default_factory=list)
    reply_to_message_id: Optional[int] = Field(default=None, ge=1)
    mention_ids: list[int] = Field(default_factory=list)
    forward_metadata: Optional[dict] = None


class MessageEditPayload(BaseModel):
    message: str = Field(min_length=1, max_length=5000)


class TypingPayload(BaseModel):
    active: bool = True


class ReactionPayload(BaseModel):
    emoji: str = Field(min_length=1, max_length=32)


class GroupRolePayload(BaseModel):
    role: str = Field(pattern="^(admin|member)$")


def _utcnow() -> datetime:
    return utcnow_naive()


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


def _group_member_row(db: Session, group_id: int, user_id: int) -> Optional[GroupChatMember]:
    return (
        db.query(GroupChatMember)
        .filter(
            GroupChatMember.group_id == group_id,
            GroupChatMember.user_id == user_id,
            GroupChatMember.is_active == True,
        )
        .first()
    )


def _ensure_group_access(db: Session, group_id: int, user_id: int) -> tuple[GroupChat, GroupChatMember]:
    group = (
        db.query(GroupChat)
        .filter(GroupChat.id == group_id, GroupChat.is_archived == False)
        .first()
    )
    if not group:
        raise HTTPException(status_code=404, detail="Group not found")
    member_row = _group_member_row(db, group_id, user_id)
    if not member_row:
        raise HTTPException(status_code=403, detail="You are not a member of this group")
    return group, member_row


def _is_group_admin(group: GroupChat, member_row: GroupChatMember, user_id: int) -> bool:
    return group.created_by == user_id or (member_row.role or "member") == "admin"


def _normalize_group_message_attachments(items: list[dict]) -> list[dict]:
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


def _serialize_receipt_user(
    user: User,
    delivered_at: Optional[datetime] = None,
    seen_at: Optional[datetime] = None,
) -> dict:
    return {
        "id": user.id,
        "name": user.name,
        "email": user.email,
        "department": user.department,
        "position": user.position,
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


def _serialize_group_reply_preview(message: GroupChatMessage, sender: User) -> dict:
    is_deleted = bool(message.deleted_at)
    return {
        "id": message.id,
        "senderId": message.sender_id,
        "senderName": sender.name,
        "message": "" if is_deleted else message.message,
        "attachments": [] if is_deleted else (message.attachments_json or []),
        "deletedAt": message.deleted_at.isoformat() if message.deleted_at else None,
    }


def _normalize_mention_token(value: str) -> str:
    return "".join(char.lower() for char in (value or "") if char.isalnum() or char in ("_", "-"))


def _build_user_mention_tokens(user: User) -> set[str]:
    name_parts = [part for part in (user.name or "").split() if part]
    tokens = {_normalize_mention_token(part) for part in name_parts}
    tokens.add(_normalize_mention_token(user.name or ""))
    if user.email and "@" in user.email:
        tokens.add(_normalize_mention_token(user.email.split("@", 1)[0]))
    return {token for token in tokens if token}


def _extract_mention_tokens(text: str) -> set[str]:
    tokens = set()
    for raw_part in (text or "").split():
        if "@" not in raw_part:
            continue
        for candidate in raw_part.split("@")[1:]:
            token = _normalize_mention_token(candidate)
            if token:
                tokens.add(token)
    return tokens


def _serialize_group_mentions(users: list[User]) -> list[dict]:
    return [
        {
            "id": user.id,
            "name": user.name,
            "email": user.email,
        }
        for user in users
    ]


def _build_group_reply_lookup(
    db: Session,
    messages: list[GroupChatMessage],
) -> dict[int, dict]:
    reply_ids = sorted({message.reply_to_message_id for message in messages if message.reply_to_message_id})
    if not reply_ids:
        return {}

    rows = (
        db.query(GroupChatMessage, User)
        .join(User, User.id == GroupChatMessage.sender_id)
        .filter(GroupChatMessage.id.in_(reply_ids))
        .all()
    )
    return {
        message.id: _serialize_group_reply_preview(message, sender)
        for message, sender in rows
    }


def _notify_receipt_update(user_id: int, payload: dict) -> None:
    try:
        queued = notification_dispatcher.enqueue(user_id, payload)
        if not queued:
            logger.warning("Group notification queue full for user_id=%s event=%s", user_id, payload.get("eventType"))
    except Exception:
        logger.exception("Failed to enqueue group notification for user_id=%s event=%s", user_id, payload.get("eventType"))


def _notify_group_members(member_ids: list[int] | set[int], sender_id: int, payload_factory) -> int:
    queued_count = 0
    for member_id in sorted({int(member_id) for member_id in member_ids if member_id}):
        if member_id == sender_id:
            continue
        _notify_receipt_update(member_id, payload_factory(member_id))
        queued_count += 1
    return queued_count


def _should_send_typing_event(sender_id: int, group_id: int, active: bool) -> bool:
    now = time.monotonic()
    key = (sender_id, group_id, bool(active))
    last_sent_at = _TYPING_THROTTLE.get(key)
    if last_sent_at and now - last_sent_at < TYPING_THROTTLE_SECONDS:
        return False
    _TYPING_THROTTLE[key] = now

    if len(_TYPING_THROTTLE) > 3000:
        cutoff = now - (TYPING_THROTTLE_SECONDS * 4)
        for stale_key, sent_at in list(_TYPING_THROTTLE.items()):
            if sent_at < cutoff:
                _TYPING_THROTTLE.pop(stale_key, None)
    return True


def _mark_group_receipts(
    db: Session,
    rows: list,
    user_id: int,
    now: datetime,
    *,
    mark_seen: bool = False,
) -> list:
    message_ids = sorted({row.id for row in rows if row.id})
    if not message_ids:
        return []

    existing_receipts = (
        db.query(ChatMessageReadReceipt)
        .filter(
            ChatMessageReadReceipt.message_scope == "group",
            ChatMessageReadReceipt.user_id == user_id,
            ChatMessageReadReceipt.message_id.in_(message_ids),
        )
        .all()
    )
    existing_by_message_id = {receipt.message_id: receipt for receipt in existing_receipts}
    changed_rows = []
    missing_rows = []

    for row in rows:
        receipt = existing_by_message_id.get(row.id)
        if not receipt:
            missing_rows.append(row)
            changed_rows.append(row)
            continue
        if not receipt.delivered_at or (mark_seen and not receipt.seen_at):
            changed_rows.append(row)

    changed_message_ids = [row.id for row in changed_rows if row.id not in {missing.id for missing in missing_rows}]
    if changed_message_ids:
        if any(not existing_by_message_id[row.id].delivered_at for row in changed_rows if row.id in existing_by_message_id):
            (
                db.query(ChatMessageReadReceipt)
                .filter(
                    ChatMessageReadReceipt.message_scope == "group",
                    ChatMessageReadReceipt.user_id == user_id,
                    ChatMessageReadReceipt.message_id.in_(changed_message_ids),
                    ChatMessageReadReceipt.delivered_at.is_(None),
                )
                .update({"delivered_at": now}, synchronize_session=False)
            )
        if mark_seen and any(not existing_by_message_id[row.id].seen_at for row in changed_rows if row.id in existing_by_message_id):
            (
                db.query(ChatMessageReadReceipt)
                .filter(
                    ChatMessageReadReceipt.message_scope == "group",
                    ChatMessageReadReceipt.user_id == user_id,
                    ChatMessageReadReceipt.message_id.in_(changed_message_ids),
                    ChatMessageReadReceipt.seen_at.is_(None),
                )
                .update({"seen_at": now}, synchronize_session=False)
            )

    if missing_rows:
        db.bulk_insert_mappings(
            ChatMessageReadReceipt,
            [
                {
                    "message_scope": "group",
                    "message_id": row.id,
                    "user_id": user_id,
                    "delivered_at": now,
                    "seen_at": now if mark_seen else None,
                }
                for row in missing_rows
            ],
        )

    return changed_rows


def _build_group_receipt_lookup(
    db: Session,
    group_id: int,
    messages: list[GroupChatMessage],
    current_user_id: int,
) -> dict[int, dict]:
    sent_message_ids = [message.id for message in messages if message.sender_id == current_user_id]
    if not sent_message_ids:
        return {}

    total_recipients = (
        db.query(func.count(GroupChatMember.id))
        .filter(
            GroupChatMember.group_id == group_id,
            GroupChatMember.is_active == True,
            GroupChatMember.user_id != current_user_id,
        )
        .scalar()
        or 0
    )

    receipt_rows = (
        db.query(ChatMessageReadReceipt, User)
        .join(User, User.id == ChatMessageReadReceipt.user_id)
        .filter(
            ChatMessageReadReceipt.message_scope == "group",
            ChatMessageReadReceipt.message_id.in_(sent_message_ids),
            User.is_active == True,
            User.is_deleted == False,
        )
        .order_by(ChatMessageReadReceipt.seen_at.asc(), User.name.asc())
        .all()
    )

    lookup = {
        message_id: {
            "status": "sent",
            "totalRecipientCount": total_recipients,
            "deliveredCount": 0,
            "deliveredBy": [],
            "readCount": 0,
            "readBy": [],
        }
        for message_id in sent_message_ids
    }
    for receipt, user in receipt_rows:
        entry = lookup.setdefault(
            receipt.message_id,
            {
                "status": "sent",
                "totalRecipientCount": total_recipients,
                "deliveredCount": 0,
                "deliveredBy": [],
                "readCount": 0,
                "readBy": [],
            },
        )
        delivered_at = receipt.delivered_at or receipt.seen_at
        if delivered_at:
            entry["deliveredBy"].append(_serialize_receipt_user(user, delivered_at, receipt.seen_at))
        if receipt.seen_at:
            entry["readBy"].append(_serialize_receipt_user(user, receipt.delivered_at, receipt.seen_at))

    for entry in lookup.values():
        entry["deliveredCount"] = len(entry["deliveredBy"])
        entry["readCount"] = len(entry["readBy"])
        if entry["readCount"] > 0:
            entry["status"] = "read"
        elif entry["deliveredCount"] > 0:
            entry["status"] = "delivered"

    return lookup


def _serialize_group(
    db: Session,
    group: GroupChat,
    current_user_id: int,
) -> dict:
    members = (
        db.query(GroupChatMember, User)
        .join(User, User.id == GroupChatMember.user_id)
        .filter(
            GroupChatMember.group_id == group.id,
            GroupChatMember.is_active == True,
            User.is_active == True,
            User.is_deleted == False,
        )
        .all()
    )
    latest_message = (
        db.query(GroupChatMessage)
        .filter(GroupChatMessage.group_id == group.id)
        .order_by(GroupChatMessage.created_at.desc(), GroupChatMessage.id.desc())
        .first()
    )
    return _serialize_group_with_members(
        group,
        current_user_id,
        members,
        presence_lookup=_build_presence_lookup(db, [user.id for _member, user in members]),
        latest_message_sender_id=latest_message.sender_id if latest_message else None,
    )


def _serialize_group_with_members(
    group: GroupChat,
    current_user_id: int,
    members: list[tuple[GroupChatMember, User]],
    presence_lookup: Optional[dict[int, dict]] = None,
    latest_message_sender_id: Optional[int] = None,
) -> dict:
    payload_members = []
    my_role = "member"
    presence_lookup = presence_lookup or {}
    for m, u in members:
        role = "admin" if (group.created_by == u.id or (m.role or "member") == "admin") else "member"
        if u.id == current_user_id:
            my_role = role
        payload_members.append(
            {
                "id": u.id,
                "name": u.name,
                "email": u.email,
                "department": u.department,
                "position": u.position,
                "role": role,
                "presence": presence_lookup.get(u.id) or _default_presence(),
            }
        )
    return {
        "id": group.id,
        "name": group.name,
        "createdBy": group.created_by,
        "createdAt": group.created_at.isoformat() if group.created_at else None,
        "lastMessageAt": group.last_message_at.isoformat() if group.last_message_at else None,
        "lastMessageSenderId": latest_message_sender_id,
        "myRole": my_role,
        "members": payload_members,
        "memberCount": len(payload_members),
    }


def _serialize_groups(
    db: Session,
    groups: list[GroupChat],
    current_user_id: int,
) -> list[dict]:
    if not groups:
        return []

    group_ids = [group.id for group in groups]
    member_rows = (
        db.query(GroupChatMember, User)
        .join(User, User.id == GroupChatMember.user_id)
        .filter(
            GroupChatMember.group_id.in_(group_ids),
            GroupChatMember.is_active == True,
            User.is_active == True,
            User.is_deleted == False,
        )
        .order_by(GroupChatMember.group_id.asc(), User.name.asc())
        .all()
    )

    members_by_group = defaultdict(list)
    member_user_ids = set()
    for member, user in member_rows:
        members_by_group[member.group_id].append((member, user))
        member_user_ids.add(user.id)
    presence_lookup = _build_presence_lookup(db, list(member_user_ids))

    latest_message_ids = (
        db.query(func.max(GroupChatMessage.id).label("message_id"))
        .filter(GroupChatMessage.group_id.in_(group_ids))
        .group_by(GroupChatMessage.group_id)
        .subquery()
    )
    latest_sender_by_group = {
        row.group_id: row.sender_id
        for row in (
            db.query(GroupChatMessage.group_id, GroupChatMessage.sender_id)
            .join(latest_message_ids, GroupChatMessage.id == latest_message_ids.c.message_id)
            .all()
        )
    }

    return [
        _serialize_group_with_members(
            group,
            current_user_id,
            members_by_group.get(group.id, []),
            presence_lookup=presence_lookup,
            latest_message_sender_id=latest_sender_by_group.get(group.id),
        )
        for group in groups
    ]


@router.get("/users")
@cache_response(ttl=120, vary_by_user=False, namespace="group_users")
async def list_group_users(
    request: Request,
    db: Session = Depends(get_operational_db),
    current_user: User = Depends(get_current_user),
):
    users = (
        db.query(User)
        .filter(User.is_active == True, User.is_deleted == False)
        .order_by(User.name.asc())
        .all()
    )
    return {
        "success": True,
        "data": [
            {
                "id": u.id,
                "name": u.name,
                "email": u.email,
                "department": u.department,
                "position": u.position,
                "isAdmin": bool(u.is_admin or (u.position or "").lower() == "admin"),
            }
            for u in users
        ],
    }


@router.get("")
@cache_response(ttl=30, vary_by_user=True, namespace="groups_mine")
async def list_my_groups(
    request: Request,
    db: Session = Depends(get_operational_db),
    current_user: User = Depends(get_current_user),
):
    groups = (
        db.query(GroupChat)
        .join(
            GroupChatMember,
            and_(
                GroupChatMember.group_id == GroupChat.id,
                GroupChatMember.user_id == current_user.id,
                GroupChatMember.is_active == True,
            ),
        )
        .filter(
            GroupChat.is_archived == False,
        )
        .order_by(GroupChat.last_message_at.desc(), GroupChat.id.desc())
        .all()
    )
    return {"success": True, "data": _serialize_groups(db, groups, current_user.id)}


@router.get("/unread-counts")
async def get_group_unread_counts(
    db: Session = Depends(get_operational_db),
    current_user: User = Depends(get_current_user),
):
    rows = (
        db.query(
            GroupChatMessage.group_id.label("group_id"),
            func.count(GroupChatMessage.id).label("unread_count"),
        )
        .join(
            GroupChat,
            and_(
                GroupChat.id == GroupChatMessage.group_id,
                GroupChat.is_archived == False,
            ),
        )
        .join(
            GroupChatMember,
            and_(
                GroupChatMember.group_id == GroupChatMessage.group_id,
                GroupChatMember.user_id == current_user.id,
                GroupChatMember.is_active == True,
            ),
        )
        .outerjoin(
            ChatMessageReadReceipt,
            and_(
                ChatMessageReadReceipt.message_scope == "group",
                ChatMessageReadReceipt.message_id == GroupChatMessage.id,
                ChatMessageReadReceipt.user_id == current_user.id,
            ),
        )
        .filter(
            GroupChatMessage.sender_id != current_user.id,
            GroupChatMessage.deleted_at.is_(None),
            ChatMessageReadReceipt.seen_at.is_(None),
        )
        .group_by(GroupChatMessage.group_id)
        .all()
    )
    groups = [
        {"groupId": row.group_id, "unreadCount": int(row.unread_count or 0)}
        for row in rows
        if int(row.unread_count or 0) > 0
    ]
    total_unread_messages = sum(item["unreadCount"] for item in groups)
    return {
        "success": True,
        "data": {
            "groups": groups,
            "countsByGroupId": {str(item["groupId"]): item["unreadCount"] for item in groups},
            "totalUnreadMessages": total_unread_messages,
            "totalUnreadThreads": len(groups),
        },
    }


@router.post("")
async def create_group(
    payload: GroupCreatePayload,
    db: Session = Depends(get_operational_db),
    current_user: User = Depends(get_current_user),
):
    name = payload.name.strip()
    if not name:
        raise HTTPException(status_code=400, detail="Group name is required")

    member_ids = {int(x) for x in payload.member_ids if int(x) > 0}
    member_ids.add(current_user.id)

    valid_users = (
        db.query(User.id)
        .filter(User.id.in_(member_ids), User.is_active == True, User.is_deleted == False)
        .all()
    )
    valid_user_ids = {u.id for u in valid_users}
    if current_user.id not in valid_user_ids:
        raise HTTPException(status_code=403, detail="Current user is not active")

    now = _utcnow()
    group = GroupChat(
        name=name,
        created_by=current_user.id,
        created_at=now,
        updated_at=now,
        last_message_at=now,
        is_archived=False,
    )
    db.add(group)
    db.flush()

    for uid in valid_user_ids:
        db.add(
            GroupChatMember(
                group_id=group.id,
                user_id=uid,
                role="admin" if uid == current_user.id else "member",
                joined_at=now,
                is_active=True,
            )
        )

    db.commit()
    db.refresh(group)
    return {"success": True, "data": _serialize_group(db, group, current_user.id)}


@router.post("/{group_id}/members")
async def add_group_members(
    group_id: int,
    payload: GroupMembersPayload,
    db: Session = Depends(get_operational_db),
    current_user: User = Depends(get_current_user),
):
    group, me = _ensure_group_access(db, group_id, current_user.id)
    if not _is_group_admin(group, me, current_user.id):
        raise HTTPException(status_code=403, detail="Only group admins can add members")

    member_ids = {int(x) for x in payload.member_ids if int(x) > 0}
    if not member_ids:
        raise HTTPException(status_code=400, detail="No members provided")

    users = (
        db.query(User)
        .filter(User.id.in_(member_ids), User.is_active == True, User.is_deleted == False)
        .all()
    )
    now = _utcnow()
    for u in users:
        existing = (
            db.query(GroupChatMember)
            .filter(GroupChatMember.group_id == group_id, GroupChatMember.user_id == u.id)
            .first()
        )
        if existing:
            existing.is_active = True
            if not existing.joined_at:
                existing.joined_at = now
        else:
            db.add(
                GroupChatMember(
                    group_id=group_id,
                    user_id=u.id,
                    role="member",
                    joined_at=now,
                    is_active=True,
                )
            )
    group.updated_at = now
    db.commit()
    db.refresh(group)
    return {"success": True, "data": _serialize_group(db, group, current_user.id)}


@router.delete("/{group_id}/members/{user_id}")
async def remove_group_member(
    group_id: int,
    user_id: int,
    db: Session = Depends(get_operational_db),
    current_user: User = Depends(get_current_user),
):
    group, me = _ensure_group_access(db, group_id, current_user.id)
    is_self_leave = current_user.id == user_id
    if not is_self_leave and not _is_group_admin(group, me, current_user.id):
        raise HTTPException(status_code=403, detail="Only group admins can remove members")
    if user_id == group.created_by:
        raise HTTPException(status_code=400, detail="Group creator cannot be removed")

    target = _group_member_row(db, group_id, user_id)
    if not target:
        raise HTTPException(status_code=404, detail="Member not found")
    target.is_active = False
    group.updated_at = _utcnow()
    db.commit()
    db.refresh(group)
    return {"success": True, "data": _serialize_group(db, group, current_user.id)}


@router.patch("/{group_id}/members/{user_id}/role")
async def update_group_member_role(
    group_id: int,
    user_id: int,
    payload: GroupRolePayload,
    db: Session = Depends(get_operational_db),
    current_user: User = Depends(get_current_user),
):
    group, me = _ensure_group_access(db, group_id, current_user.id)
    if not _is_group_admin(group, me, current_user.id):
        raise HTTPException(status_code=403, detail="Only group admins can change member roles")
    if user_id == group.created_by:
        raise HTTPException(status_code=400, detail="Creator role cannot be changed")

    target = _group_member_row(db, group_id, user_id)
    if not target:
        raise HTTPException(status_code=404, detail="Member not found")

    target.role = payload.role
    group.updated_at = _utcnow()
    db.commit()
    db.refresh(group)
    return {"success": True, "data": _serialize_group(db, group, current_user.id)}


@router.get("/{group_id}/messages")
async def list_group_messages(
    group_id: int,
    before_message_id: Optional[int] = Query(default=None, ge=1),
    limit: int = Query(default=50, ge=1, le=300),
    db: Session = Depends(get_operational_db),
    current_user: User = Depends(get_current_user),
):
    group, _ = _ensure_group_access(db, group_id, current_user.id)
    query = (
        db.query(GroupChatMessage, User)
        .join(User, User.id == GroupChatMessage.sender_id)
        .filter(GroupChatMessage.group_id == group.id)
    )
    if before_message_id:
        query = query.filter(GroupChatMessage.id < before_message_id)

    rows = (
        query
        .order_by(GroupChatMessage.id.desc())
        .limit(limit + 1)
        .all()
    )
    has_more = len(rows) > limit
    if has_more:
        rows = rows[:limit]
    rows.reverse()
    messages = [msg for msg, _sender in rows]
    receipt_lookup = _build_group_receipt_lookup(db, group.id, messages, current_user.id)
    reaction_lookup = _build_reaction_lookup(db, "group", [msg.id for msg in messages], current_user.id)
    reply_lookup = _build_group_reply_lookup(db, messages)
    return {
        "success": True,
        "pagination": {
            "limit": limit,
            "hasMore": has_more,
            "nextBeforeMessageId": rows[0][0].id if has_more and rows else None,
        },
        "data": [
            {
                "id": msg.id,
                "groupId": msg.group_id,
                "senderId": msg.sender_id,
                "senderName": sender.name,
                "message": msg.message,
                "replyTo": reply_lookup.get(msg.reply_to_message_id),
                "attachments": [] if msg.deleted_at else (msg.attachments_json or []),
                "mentions": [] if msg.deleted_at else (msg.mentions_json or []),
                "forwardMetadata": None if msg.deleted_at else (msg.forward_metadata_json or None),
                "createdAt": msg.created_at.isoformat() if msg.created_at else None,
                "editedAt": msg.edited_at.isoformat() if msg.edited_at else None,
                "deletedAt": msg.deleted_at.isoformat() if msg.deleted_at else None,
                "receipt": receipt_lookup.get(msg.id),
                **({"reactions": [], "myReaction": None} if msg.deleted_at else reaction_lookup.get(msg.id, {"reactions": [], "myReaction": None})),
            }
            for msg, sender in rows
        ],
    }


@router.post("/{group_id}/messages/mark-delivered")
async def mark_group_messages_delivered(
    group_id: int,
    db: Session = Depends(get_operational_db),
    current_user: User = Depends(get_current_user),
):
    group, _ = _ensure_group_access(db, group_id, current_user.id)
    rows = (
        db.query(GroupChatMessage.id, GroupChatMessage.sender_id)
        .filter(
            GroupChatMessage.group_id == group.id,
            GroupChatMessage.sender_id != current_user.id,
            GroupChatMessage.deleted_at.is_(None),
        )
        .all()
    )
    message_ids = [row.id for row in rows]
    if not message_ids:
        return {"success": True, "markedCount": 0}

    now = _utcnow()
    changed_rows = _mark_group_receipts(db, rows, current_user.id, now, mark_seen=False)
    db.commit()

    for sender_id in {row.sender_id for row in changed_rows if row.sender_id != current_user.id}:
        _notify_receipt_update(sender_id, {
            "eventType": "message_delivery_receipt",
            "title": f"{current_user.name} received messages in {group.name}",
            "message": f"{current_user.name} received your group messages",
            "metadata": {
                "scope": "group",
                "groupId": group.id,
                "readerId": current_user.id,
                "readerName": current_user.name,
                "deliveredAt": now.isoformat(),
            },
        })

    return {"success": True, "markedCount": len(changed_rows)}


@router.post("/{group_id}/messages/mark-read")
async def mark_group_messages_read(
    group_id: int,
    db: Session = Depends(get_operational_db),
    current_user: User = Depends(get_current_user),
):
    group, _ = _ensure_group_access(db, group_id, current_user.id)
    rows = (
        db.query(GroupChatMessage.id, GroupChatMessage.sender_id)
        .filter(
            GroupChatMessage.group_id == group.id,
            GroupChatMessage.sender_id != current_user.id,
            GroupChatMessage.deleted_at.is_(None),
        )
        .all()
    )
    message_ids = [row.id for row in rows]
    if not message_ids:
        return {"success": True, "markedCount": 0}

    now = _utcnow()
    changed_rows = _mark_group_receipts(db, rows, current_user.id, now, mark_seen=True)
    db.commit()

    affected_sender_ids = {row.sender_id for row in changed_rows if row.sender_id != current_user.id}
    for sender_id in affected_sender_ids:
        _notify_receipt_update(sender_id, {
            "eventType": "message_read_receipt",
            "title": f"{current_user.name} read messages in {group.name}",
            "message": f"{current_user.name} read your group messages",
            "metadata": {
                "scope": "group",
                "groupId": group.id,
                "readerId": current_user.id,
                "readerName": current_user.name,
                "deliveredAt": now.isoformat(),
                "seenAt": now.isoformat(),
            },
        })

    return {"success": True, "markedCount": len(changed_rows)}


@router.post("/{group_id}/typing")
async def send_group_typing_indicator(
    group_id: int,
    payload: TypingPayload,
    db: Session = Depends(get_operational_db),
    current_user: User = Depends(get_current_user),
):
    group, _ = _ensure_group_access(db, group_id, current_user.id)
    member_ids = [
        row.user_id
        for row in db.query(GroupChatMember).filter(
            GroupChatMember.group_id == group.id,
            GroupChatMember.is_active == True,
        ).all()
    ]
    ws_payload = {
        "eventType": "chat_typing",
        "title": "",
        "message": "",
        "metadata": {
            "scope": "group",
            "active": bool(payload.active),
            "groupId": group.id,
            "groupName": group.name,
            "senderId": current_user.id,
            "senderName": current_user.name,
            "updatedAt": _utcnow().isoformat(),
        },
    }
    if _should_send_typing_event(current_user.id, group.id, payload.active):
        _notify_group_members(member_ids, current_user.id, lambda _member_id: ws_payload)

    return {"success": True}


@router.post("/{group_id}/messages/{message_id}/reaction")
async def set_group_message_reaction(
    group_id: int,
    message_id: int,
    payload: ReactionPayload,
    db: Session = Depends(get_operational_db),
    current_user: User = Depends(get_current_user),
):
    group, _ = _ensure_group_access(db, group_id, current_user.id)
    message = (
        db.query(GroupChatMessage)
        .filter(GroupChatMessage.id == message_id, GroupChatMessage.group_id == group.id)
        .first()
    )
    if not message:
        raise HTTPException(status_code=404, detail="Message not found")
    if message.deleted_at:
        raise HTTPException(status_code=400, detail="Deleted messages cannot be reacted to")

    emoji = payload.emoji.strip()
    if not emoji:
        raise HTTPException(status_code=400, detail="Reaction is required")

    now = _utcnow()
    reaction = (
        db.query(ChatMessageReaction)
        .filter(
            ChatMessageReaction.message_scope == "group",
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
            message_scope="group",
            message_id=message.id,
            user_id=current_user.id,
            emoji=emoji,
            created_at=now,
            updated_at=now,
        ))
    db.commit()

    reaction_data = _build_reaction_lookup(db, "group", [message.id], current_user.id).get(
        message.id,
        {"reactions": [], "myReaction": None},
    )
    member_ids = [
        row.user_id
        for row in db.query(GroupChatMember).filter(
            GroupChatMember.group_id == group.id,
            GroupChatMember.is_active == True,
        ).all()
    ]
    for member_id in member_ids:
        if member_id == current_user.id:
            continue
        _notify_receipt_update(member_id, {
            "eventType": "message_reaction",
            "title": f"{current_user.name} reacted in {group.name}",
            "message": f"{current_user.name} reacted to a message",
            "metadata": {
                "scope": "group",
                "groupId": group.id,
                "messageId": message.id,
                "userId": current_user.id,
                "userName": current_user.name,
                "emoji": emoji,
                "removed": False,
                "updatedAt": now.isoformat(),
            },
        })

    return {"success": True, "data": reaction_data}


@router.delete("/{group_id}/messages/{message_id}/reaction")
async def remove_group_message_reaction(
    group_id: int,
    message_id: int,
    db: Session = Depends(get_operational_db),
    current_user: User = Depends(get_current_user),
):
    group, _ = _ensure_group_access(db, group_id, current_user.id)
    message = (
        db.query(GroupChatMessage)
        .filter(GroupChatMessage.id == message_id, GroupChatMessage.group_id == group.id)
        .first()
    )
    if not message:
        raise HTTPException(status_code=404, detail="Message not found")
    if message.deleted_at:
        raise HTTPException(status_code=400, detail="Deleted messages cannot be reacted to")

    reaction = (
        db.query(ChatMessageReaction)
        .filter(
            ChatMessageReaction.message_scope == "group",
            ChatMessageReaction.message_id == message.id,
            ChatMessageReaction.user_id == current_user.id,
        )
        .first()
    )
    if reaction:
        db.delete(reaction)
        db.commit()

    now = _utcnow()
    reaction_data = _build_reaction_lookup(db, "group", [message.id], current_user.id).get(
        message.id,
        {"reactions": [], "myReaction": None},
    )
    member_ids = [
        row.user_id
        for row in db.query(GroupChatMember).filter(
            GroupChatMember.group_id == group.id,
            GroupChatMember.is_active == True,
        ).all()
    ]
    for member_id in member_ids:
        if member_id == current_user.id:
            continue
        _notify_receipt_update(member_id, {
            "eventType": "message_reaction",
            "title": f"{current_user.name} updated a reaction in {group.name}",
            "message": f"{current_user.name} updated a reaction",
            "metadata": {
                "scope": "group",
                "groupId": group.id,
                "messageId": message.id,
                "userId": current_user.id,
                "userName": current_user.name,
                "removed": True,
                "updatedAt": now.isoformat(),
            },
        })

    return {"success": True, "data": reaction_data}


@router.patch("/{group_id}/messages/{message_id}")
async def edit_group_message(
    group_id: int,
    message_id: int,
    payload: MessageEditPayload,
    db: Session = Depends(get_operational_db),
    current_user: User = Depends(get_current_user),
):
    group, _ = _ensure_group_access(db, group_id, current_user.id)
    message = (
        db.query(GroupChatMessage)
        .filter(GroupChatMessage.id == message_id, GroupChatMessage.group_id == group.id)
        .first()
    )
    if not message:
        raise HTTPException(status_code=404, detail="Message not found")
    if message.sender_id != current_user.id:
        raise HTTPException(status_code=403, detail="You can only edit your own messages")
    if message.deleted_at:
        raise HTTPException(status_code=400, detail="Deleted messages cannot be edited")

    text = payload.message.strip()
    if not text:
        raise HTTPException(status_code=400, detail="Message is required")

    member_rows = (
        db.query(GroupChatMember, User)
        .join(User, User.id == GroupChatMember.user_id)
        .filter(
            GroupChatMember.group_id == group.id,
            GroupChatMember.is_active == True,
            User.is_active == True,
            User.is_deleted == False,
        )
        .all()
    )
    mention_tokens = _extract_mention_tokens(text)
    mentioned_users = [
        member_user
        for _member, member_user in member_rows
        if member_user.id != current_user.id and mention_tokens.intersection(_build_user_mention_tokens(member_user))
    ]
    mentions = _serialize_group_mentions(mentioned_users)
    mentioned_user_ids = {user.id for user in mentioned_users}

    now = _utcnow()
    message.message = text
    message.mentions_json = mentions
    message.edited_at = now
    db.commit()
    db.refresh(message)

    member_ids = [member.user_id for member, _user in member_rows]
    for member_id in member_ids:
        if member_id == current_user.id:
            continue
        _notify_receipt_update(member_id, {
            "eventType": "message_updated",
            "title": f"{current_user.name} edited a message in {group.name}",
            "message": f"{current_user.name} edited a message",
            "metadata": {
                "scope": "group",
                "groupId": group.id,
                "messageId": message.id,
                "senderId": current_user.id,
                "messageText": message.message,
                "mentions": mentions,
                "mentionIds": sorted(mentioned_user_ids),
                "editedAt": message.edited_at.isoformat() if message.edited_at else None,
            },
        })

    return {
        "success": True,
        "data": {
            "id": message.id,
            "message": message.message,
            "mentions": message.mentions_json or [],
            "editedAt": message.edited_at.isoformat() if message.edited_at else None,
            "deletedAt": None,
        },
    }


@router.delete("/{group_id}/messages/{message_id}")
async def delete_group_message(
    group_id: int,
    message_id: int,
    db: Session = Depends(get_operational_db),
    current_user: User = Depends(get_current_user),
):
    group, _ = _ensure_group_access(db, group_id, current_user.id)
    message = (
        db.query(GroupChatMessage)
        .filter(GroupChatMessage.id == message_id, GroupChatMessage.group_id == group.id)
        .first()
    )
    if not message:
        raise HTTPException(status_code=404, detail="Message not found")
    if message.sender_id != current_user.id:
        raise HTTPException(status_code=403, detail="You can only delete your own messages")

    now = _utcnow()
    if not message.deleted_at:
        message.message = ""
        message.attachments_json = []
        message.mentions_json = []
        message.forward_metadata_json = None
        message.deleted_at = now
        message.edited_at = None
        db.query(ChatMessageReaction).filter(
            ChatMessageReaction.message_scope == "group",
            ChatMessageReaction.message_id == message.id,
        ).delete(synchronize_session=False)
        db.commit()
        db.refresh(message)

    member_ids = [
        row.user_id
        for row in db.query(GroupChatMember).filter(
            GroupChatMember.group_id == group.id,
            GroupChatMember.is_active == True,
        ).all()
    ]
    for member_id in member_ids:
        if member_id == current_user.id:
            continue
        _notify_receipt_update(member_id, {
            "eventType": "message_deleted",
            "title": f"{current_user.name} deleted a message in {group.name}",
            "message": f"{current_user.name} deleted a message",
            "metadata": {
                "scope": "group",
                "groupId": group.id,
                "messageId": message.id,
                "senderId": current_user.id,
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


@router.post("/{group_id}/messages")
async def send_group_message(
    group_id: int,
    payload: GroupMessagePayload,
    db: Session = Depends(get_operational_db),
    current_user: User = Depends(get_current_user),
):
    group, _ = _ensure_group_access(db, group_id, current_user.id)
    text = payload.message.strip()
    attachments = _normalize_group_message_attachments(payload.attachments)
    if not text and not attachments:
        raise HTTPException(status_code=400, detail="Message or attachment is required")
    reply_row = None
    if payload.reply_to_message_id:
        reply_row = (
            db.query(GroupChatMessage, User)
            .join(User, User.id == GroupChatMessage.sender_id)
            .filter(
                GroupChatMessage.id == payload.reply_to_message_id,
                GroupChatMessage.group_id == group.id,
            )
            .first()
        )
        if not reply_row:
            raise HTTPException(status_code=404, detail="Reply target message not found")

    member_rows = (
        db.query(GroupChatMember, User)
        .join(User, User.id == GroupChatMember.user_id)
        .filter(
            GroupChatMember.group_id == group.id,
            GroupChatMember.is_active == True,
            User.is_active == True,
            User.is_deleted == False,
        )
        .all()
    )
    mention_id_candidates = {int(user_id) for user_id in (payload.mention_ids or []) if user_id}
    mention_tokens = _extract_mention_tokens(text)
    mentioned_users = []
    for _member, member_user in member_rows:
        if member_user.id == current_user.id:
            continue
        is_payload_match = member_user.id in mention_id_candidates
        is_text_match = bool(mention_tokens.intersection(_build_user_mention_tokens(member_user)))
        if is_payload_match or is_text_match:
            mentioned_users.append(member_user)
    mentions = _serialize_group_mentions(mentioned_users)
    mentioned_user_ids = {user.id for user in mentioned_users}

    now = _utcnow()
    msg = GroupChatMessage(
        group_id=group.id,
        sender_id=current_user.id,
        reply_to_message_id=payload.reply_to_message_id,
        message=text,
        attachments_json=attachments,
        mentions_json=mentions,
        forward_metadata_json=payload.forward_metadata or None,
        created_at=now,
    )
    group.last_message_at = now
    group.updated_at = now
    db.add(msg)
    db.commit()
    db.refresh(msg)

    # Push realtime event to active group members via shared notifications socket.
    member_ids = [member.user_id for member, _user in member_rows]
    ws_payload = {
        "eventType": "group_message",
        "title": f"New message in {group.name}",
        "message": (text or f"{len(attachments)} attachment{'s' if len(attachments) != 1 else ''}")[:180],
        "attachments": attachments,
        "metadata": {
            "groupId": group.id,
            "groupName": group.name,
            "messageId": msg.id,
            "senderId": current_user.id,
            "senderName": current_user.name,
            "messageText": text,
            "replyTo": _serialize_group_reply_preview(*reply_row) if reply_row else None,
            "attachmentCount": len(attachments),
            "mentions": mentions,
            "mentionIds": sorted(mentioned_user_ids),
            "forwardMetadata": msg.forward_metadata_json or None,
            "createdAt": msg.created_at.isoformat() if msg.created_at else None,
        },
    }
    def _message_payload_for_member(member_id: int) -> dict:
        if member_id in mentioned_user_ids:
            return {
                **ws_payload,
                "title": f"{current_user.name} mentioned you in {group.name}",
                "message": (text or "You were mentioned in a group message")[:180],
                "metadata": {
                    **ws_payload["metadata"],
                    "mentionedUserId": member_id,
                    "isMention": True,
                },
            }
        return ws_payload

    _notify_group_members(member_ids, current_user.id, _message_payload_for_member)

    return {
        "success": True,
        "data": {
            "id": msg.id,
            "groupId": msg.group_id,
            "senderId": msg.sender_id,
            "senderName": current_user.name,
            "message": msg.message,
            "replyTo": _serialize_group_reply_preview(*reply_row) if reply_row else None,
            "attachments": msg.attachments_json or [],
            "mentions": msg.mentions_json or [],
            "forwardMetadata": msg.forward_metadata_json or None,
            "createdAt": msg.created_at.isoformat() if msg.created_at else None,
            "editedAt": msg.edited_at.isoformat() if msg.edited_at else None,
            "deletedAt": msg.deleted_at.isoformat() if msg.deleted_at else None,
        },
    }
