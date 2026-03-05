from datetime import datetime
from typing import Optional
import asyncio

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session
from sqlalchemy import select

from database_config import get_operational_db
from models_new import GroupChat, GroupChatMember, GroupChatMessage, User
from routers.auth_router import get_current_user
from routers.tasks_router import notification_hub


router = APIRouter(prefix="/api/groups", tags=["Groups"])


class GroupCreatePayload(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    member_ids: list[int] = Field(default_factory=list)


class GroupMembersPayload(BaseModel):
    member_ids: list[int] = Field(default_factory=list)


class GroupMessagePayload(BaseModel):
    message: str = Field(min_length=1, max_length=5000)


class GroupRolePayload(BaseModel):
    role: str = Field(pattern="^(admin|member)$")


def _utcnow() -> datetime:
    return datetime.utcnow()


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
        )
        .all()
    )
    payload_members = []
    my_role = "member"
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
            }
        )
    return {
        "id": group.id,
        "name": group.name,
        "createdBy": group.created_by,
        "createdAt": group.created_at.isoformat() if group.created_at else None,
        "lastMessageAt": group.last_message_at.isoformat() if group.last_message_at else None,
        "myRole": my_role,
        "members": payload_members,
        "memberCount": len(payload_members),
    }


@router.get("/users")
async def list_group_users(
    db: Session = Depends(get_operational_db),
    current_user: User = Depends(get_current_user),
):
    users = (
        db.query(User)
        .filter(User.is_active == True)
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
async def list_my_groups(
    db: Session = Depends(get_operational_db),
    current_user: User = Depends(get_current_user),
):
    memberships = (
        db.query(GroupChatMember.group_id)
        .filter(
            GroupChatMember.user_id == current_user.id,
            GroupChatMember.is_active == True,
        )
        .subquery()
    )
    groups = (
        db.query(GroupChat)
        .filter(
            GroupChat.id.in_(select(memberships.c.group_id)),
            GroupChat.is_archived == False,
        )
        .order_by(GroupChat.last_message_at.desc(), GroupChat.id.desc())
        .all()
    )
    return {"success": True, "data": [_serialize_group(db, g, current_user.id) for g in groups]}


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
        .filter(User.id.in_(member_ids), User.is_active == True)
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

    users = db.query(User).filter(User.id.in_(member_ids), User.is_active == True).all()
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
    db: Session = Depends(get_operational_db),
    current_user: User = Depends(get_current_user),
):
    group, _ = _ensure_group_access(db, group_id, current_user.id)
    rows = (
        db.query(GroupChatMessage, User)
        .join(User, User.id == GroupChatMessage.sender_id)
        .filter(GroupChatMessage.group_id == group.id)
        .order_by(GroupChatMessage.created_at.asc(), GroupChatMessage.id.asc())
        .limit(300)
        .all()
    )
    return {
        "success": True,
        "data": [
            {
                "id": msg.id,
                "groupId": msg.group_id,
                "senderId": msg.sender_id,
                "senderName": sender.name,
                "message": msg.message,
                "createdAt": msg.created_at.isoformat() if msg.created_at else None,
                "editedAt": msg.edited_at.isoformat() if msg.edited_at else None,
            }
            for msg, sender in rows
        ],
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
    if not text:
        raise HTTPException(status_code=400, detail="Message is required")

    now = _utcnow()
    msg = GroupChatMessage(
        group_id=group.id,
        sender_id=current_user.id,
        message=text,
        created_at=now,
    )
    group.last_message_at = now
    group.updated_at = now
    db.add(msg)
    db.commit()
    db.refresh(msg)

    # Push realtime event to active group members via shared notifications socket.
    member_ids = [
        row.user_id
        for row in db.query(GroupChatMember).filter(
            GroupChatMember.group_id == group.id,
            GroupChatMember.is_active == True,
        ).all()
    ]
    ws_payload = {
        "eventType": "group_message",
        "title": f"New message in {group.name}",
        "message": text[:180],
        "metadata": {
            "groupId": group.id,
            "groupName": group.name,
            "messageId": msg.id,
            "senderId": current_user.id,
            "senderName": current_user.name,
            "createdAt": msg.created_at.isoformat() if msg.created_at else None,
        },
    }
    for member_id in member_ids:
        if member_id == current_user.id:
            continue
        try:
            asyncio.create_task(notification_hub.push(member_id, ws_payload))
        except RuntimeError:
            # If event loop scheduling is unavailable, skip realtime push gracefully.
            pass

    return {
        "success": True,
        "data": {
            "id": msg.id,
            "groupId": msg.group_id,
            "senderId": msg.sender_id,
            "senderName": current_user.name,
            "message": msg.message,
            "createdAt": msg.created_at.isoformat() if msg.created_at else None,
            "editedAt": msg.edited_at.isoformat() if msg.edited_at else None,
        },
    }
