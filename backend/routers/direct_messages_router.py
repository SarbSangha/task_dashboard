from datetime import datetime
import asyncio

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import and_, or_
from sqlalchemy.orm import Session

from database_config import get_operational_db
from models_new import DirectMessage, User
from routers.auth_router import get_current_user
from routers.tasks_router import notification_hub


router = APIRouter(prefix="/api/direct-messages", tags=["Direct Messages"])


class DirectMessagePayload(BaseModel):
    message: str = Field(default="", max_length=5000)
    attachments: list[dict] = Field(default_factory=list)


def _utcnow() -> datetime:
    return datetime.utcnow()


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


def _serialize_user(user: User) -> dict:
    return {
        "id": user.id,
        "name": user.name,
        "email": user.email,
        "department": user.department,
        "position": user.position,
        "isAdmin": bool(user.is_admin or (user.position or "").lower() == "admin"),
    }


def _get_active_user(db: Session, user_id: int) -> User:
    user = (
        db.query(User)
        .filter(User.id == user_id, User.is_active == True, User.is_deleted == False)
        .first()
    )
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    return user


def _serialize_direct_message(message: DirectMessage, sender_name: str) -> dict:
    return {
        "id": message.id,
        "senderId": message.sender_id,
        "senderName": sender_name,
        "recipientId": message.recipient_id,
        "message": message.message,
        "attachments": message.attachments_json or [],
        "createdAt": message.created_at.isoformat() if message.created_at else None,
        "editedAt": message.edited_at.isoformat() if message.edited_at else None,
    }


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
    return {"success": True, "data": [_serialize_user(user) for user in users if user.id != current_user.id]}


@router.get("/conversations")
async def list_direct_conversations(
    db: Session = Depends(get_operational_db),
    current_user: User = Depends(get_current_user),
):
    rows = (
        db.query(DirectMessage)
        .filter(or_(DirectMessage.sender_id == current_user.id, DirectMessage.recipient_id == current_user.id))
        .order_by(DirectMessage.created_at.desc(), DirectMessage.id.desc())
        .all()
    )

    latest_by_partner = {}
    for message in rows:
        partner_id = message.recipient_id if message.sender_id == current_user.id else message.sender_id
        if partner_id == current_user.id or partner_id in latest_by_partner:
            continue
        latest_by_partner[partner_id] = message

    if not latest_by_partner:
        return {"success": True, "data": []}

    partners = (
        db.query(User)
        .filter(
            User.id.in_(list(latest_by_partner.keys())),
            User.is_active == True,
            User.is_deleted == False,
        )
        .all()
    )
    partner_map = {partner.id: partner for partner in partners}

    data = []
    for partner_id, message in latest_by_partner.items():
        partner = partner_map.get(partner_id)
        if not partner:
            continue
        attachments = message.attachments_json or []
        preview = (message.message or "").strip() or f"{len(attachments)} attachment{'s' if len(attachments) != 1 else ''}"
        data.append(
            {
                "user": _serialize_user(partner),
                "lastMessageAt": message.created_at.isoformat() if message.created_at else None,
                "lastMessagePreview": preview[:180],
                "lastMessageSenderId": message.sender_id,
            }
        )

    data.sort(key=lambda item: item.get("lastMessageAt") or "", reverse=True)
    return {"success": True, "data": data}


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
        .order_by(DirectMessage.created_at.asc(), DirectMessage.id.asc())
        .limit(300)
        .all()
    )
    return {
        "success": True,
        "conversationWith": _serialize_user(other_user),
        "data": [_serialize_direct_message(message, sender.name) for message, sender in rows],
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

    now = _utcnow()
    message = DirectMessage(
        sender_id=current_user.id,
        recipient_id=recipient.id,
        message=text,
        attachments_json=attachments,
        created_at=now,
    )
    db.add(message)
    db.commit()
    db.refresh(message)

    ws_payload = {
        "eventType": "direct_message",
        "title": f"New message from {current_user.name}",
        "message": (text or f"{len(attachments)} attachment{'s' if len(attachments) != 1 else ''}")[:180],
        "metadata": {
            "messageId": message.id,
            "senderId": current_user.id,
            "senderName": current_user.name,
            "recipientId": recipient.id,
            "attachmentCount": len(attachments),
            "createdAt": message.created_at.isoformat() if message.created_at else None,
        },
    }
    try:
        asyncio.create_task(notification_hub.push(recipient.id, ws_payload))
    except RuntimeError:
        pass

    return {"success": True, "data": _serialize_direct_message(message, current_user.name)}
