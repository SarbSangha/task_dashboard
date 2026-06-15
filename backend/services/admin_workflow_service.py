from datetime import datetime, timedelta
import logging
import os
from time import monotonic
from typing import Optional

from sqlalchemy.orm import Session

from models_new import PendingPasswordChange, User, UserApprovalRequest, UserRole
from routers.tasks_router import notification_dispatcher
from services.notification_outbox_service import record_notification_outbox_failure


logger = logging.getLogger(__name__)

_ADMIN_IDS_CACHE: dict = {"ids": [], "exp": 0.0}
_ADMIN_IDS_TTL = 60.0


def _int_env(name: str, default: int) -> int:
    raw = (os.getenv(name) or "").strip()
    if not raw:
        return default
    try:
        return int(raw)
    except ValueError:
        return default


def admin_user_ids(db: Session) -> list[int]:
    now = monotonic()
    if _ADMIN_IDS_CACHE["exp"] > now:
        return _ADMIN_IDS_CACHE["ids"]

    admin_rows = (
        db.query(User.id)
        .filter(
            User.is_active == True,
            User.is_deleted == False,
            User.is_admin == True,
        )
        .all()
    )
    ids = [row[0] for row in admin_rows]

    normalized_role_rows = (
        db.query(UserRole.user_id)
        .join(User, User.id == UserRole.user_id)
        .filter(
            User.is_active == True,
            User.is_deleted == False,
            UserRole.role == "admin",
        )
        .all()
    )
    ids.extend(row[0] for row in normalized_role_rows)

    role_rows = (
        db.query(User.id, User.roles_json)
        .filter(
            User.is_active == True,
            User.is_deleted == False,
            User.is_admin == False,
            User.roles_json != None,
        )
        .all()
    )
    for user_id, roles_json in role_rows:
        if isinstance(roles_json, list) and "admin" in {str(role).strip().lower() for role in roles_json}:
            ids.append(user_id)

    ids = sorted(set(ids))
    _ADMIN_IDS_CACHE["ids"] = ids
    _ADMIN_IDS_CACHE["exp"] = now + _ADMIN_IDS_TTL
    return ids


def push_admin_realtime_event(
    db: Session,
    event_type: str,
    title: str,
    message: str,
    metadata: Optional[dict] = None,
) -> None:
    payload = {
        "eventType": event_type,
        "title": title,
        "message": message,
        "metadata": metadata or {},
    }
    recorded_outbox = False
    for admin_id in admin_user_ids(db):
        try:
            queued = notification_dispatcher.enqueue(admin_id, payload)
            if not queued:
                logger.warning("Admin notification queue full for admin_id=%s event=%s", admin_id, event_type)
                record_notification_outbox_failure(
                    db,
                    user_id=admin_id,
                    event_type=event_type,
                    payload=payload,
                    error="Notification dispatcher queue full",
                )
                recorded_outbox = True
        except Exception:
            logger.exception("Failed to enqueue admin notification for admin_id=%s event=%s", admin_id, event_type)
            record_notification_outbox_failure(
                db,
                user_id=admin_id,
                event_type=event_type,
                payload=payload,
                error="Notification dispatcher enqueue exception",
            )
            recorded_outbox = True
    if recorded_outbox:
        db.commit()


def sanitize_request_payload(request_type: str, payload: Optional[dict]) -> dict:
    data = dict(payload or {})
    if request_type == "password_change":
        return {
            "summary": "Secure password change request",
            "hasPasswordUpdate": bool(data.get("password_hash")),
        }
    return data


def pending_password_change_for_request(
    db: Session,
    req: UserApprovalRequest,
    *,
    expires_days: Optional[int] = None,
) -> Optional[PendingPasswordChange]:
    pending_password = (
        db.query(PendingPasswordChange)
        .filter(PendingPasswordChange.approval_request_id == req.id)
        .with_for_update()
        .first()
    )
    if pending_password:
        return pending_password

    legacy_hash = (req.payload_json or {}).get("password_hash")
    if not legacy_hash:
        return None

    created_at = req.created_at or datetime.utcnow()
    pending_password = PendingPasswordChange(
        approval_request_id=req.id,
        user_id=req.user_id,
        password_hash=legacy_hash,
        status=req.status if req.status != "pending" else "pending",
        created_at=created_at,
        expires_at=created_at + timedelta(
            days=expires_days if expires_days is not None else _int_env("PASSWORD_CHANGE_APPROVAL_EXPIRES_DAYS", 7)
        ),
    )
    req.payload_json = {
        "summary": "Secure password change request",
        "hasPasswordUpdate": True,
        "migratedFromLegacyPayload": True,
    }
    db.add(pending_password)
    db.flush()
    return pending_password
