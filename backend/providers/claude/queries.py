# providers/claude/queries.py
"""
Read-only query/aggregation layer for the Claude Capture Center (GET
/events, /events/{id}, /conversations, /conversations/{id}, /metrics,
/users). Never writes to the database.

Unlike providers/chatgpt/queries.py (which reconstructs conversations by
scanning the raw ConversationCaptureEvent log, because that provider's
normalized ConversationRecord/Prompt/Response tables started out as a later,
partially-adopted addition - see that module's own docstring), this module
reads the normalized tables directly as the primary source for everything
except the raw Event Inspector (/events, /events/{id}). Claude's
normalization (see normalization.py) never leaves a conversation
un-normalized the way ChatGPT's orphan case can, so ConversationRecord's own
prompt_count/response_count/title/model_label/provider_created_time columns
are always trustworthy and cheap to query directly, without re-deriving them
from scratch on every request.
"""
from dataclasses import dataclass
from datetime import date, datetime
from typing import Optional

from sqlalchemy import func, or_
from sqlalchemy.orm import Session

from models_new import User
from providers.chatgpt.models import (
    ConversationCaptureAttachment,
    ConversationCaptureEvent,
    ConversationCaptureHealth,
    ConversationPrompt,
    ConversationRecord,
    ConversationResponse,
)
from providers.claude.capture import get_ingest_stats_snapshot
from providers.claude.constants import (
    EVENT_TYPE_PROMPT_CAPTURED,
    EVENT_TYPE_RESPONSE_COMPLETED,
    HEALTH_STATUS_BACKLOGGED,
    HEALTH_STATUS_DEGRADED,
    HEALTH_STATUS_HEALTHY,
    HEALTH_STATUS_NO_MESSAGES,
    HEALTH_STATUS_OFFLINE,
    PROVIDER,
)
from providers.claude.health import compute_capture_health_status
from utils.datetime_utils import serialize_utc_datetime

DEFAULT_EVENTS_LIMIT = 25
MAX_EVENTS_LIMIT = 200
DEFAULT_CONVERSATIONS_LIMIT = 20
MAX_CONVERSATIONS_LIMIT = 100

_USER_SORT_OPTIONS = {"recent", "conversations", "messages", "name"}

# See providers/chatgpt/queries.py's identical constant/comment - NO_MESSAGES
# sits last so it only wins when every one of a user's/rollup's conversations
# is content-less.
_HEALTH_STATUS_PRIORITY = (
    HEALTH_STATUS_OFFLINE,
    HEALTH_STATUS_BACKLOGGED,
    HEALTH_STATUS_DEGRADED,
    HEALTH_STATUS_HEALTHY,
    HEALTH_STATUS_NO_MESSAGES,
)


@dataclass
class EventFilters:
    conversation_id: Optional[str] = None
    event_type: Optional[str] = None
    client_event_id: Optional[str] = None
    capture_version: Optional[int] = None
    extension_version: Optional[str] = None
    date_from: Optional[date] = None
    date_to: Optional[date] = None
    q: Optional[str] = None
    user_id: Optional[int] = None


def _apply_event_filters(query, filters: EventFilters):
    query = query.filter(ConversationCaptureEvent.provider == PROVIDER)
    if filters.user_id is not None:
        query = query.filter(ConversationCaptureEvent.user_id == filters.user_id)
    if filters.conversation_id:
        query = query.filter(ConversationCaptureEvent.provider_conversation_id == filters.conversation_id)
    if filters.event_type:
        query = query.filter(ConversationCaptureEvent.event_type == filters.event_type)
    if filters.client_event_id:
        query = query.filter(ConversationCaptureEvent.client_event_id == filters.client_event_id)
    if filters.capture_version is not None:
        query = query.filter(ConversationCaptureEvent.capture_version == filters.capture_version)
    if filters.extension_version:
        query = query.filter(ConversationCaptureEvent.extension_version == filters.extension_version)
    if filters.date_from:
        query = query.filter(ConversationCaptureEvent.event_date >= filters.date_from)
    if filters.date_to:
        query = query.filter(ConversationCaptureEvent.event_date <= filters.date_to)
    if filters.q:
        needle = f"%{filters.q.strip()}%"
        query = query.filter(
            or_(
                ConversationCaptureEvent.provider_conversation_id.ilike(needle),
                ConversationCaptureEvent.client_event_id.ilike(needle),
                ConversationCaptureEvent.provider_message_id.ilike(needle),
            )
        )
    return query


def list_events(db: Session, *, filters: EventFilters, limit: int, offset: int) -> tuple[list[ConversationCaptureEvent], int]:
    base = _apply_event_filters(db.query(ConversationCaptureEvent), filters)
    total = base.with_entities(func.count(ConversationCaptureEvent.id)).scalar() or 0
    items = (
        base.order_by(ConversationCaptureEvent.created_at.desc(), ConversationCaptureEvent.id.desc())
        .offset(offset)
        .limit(limit)
        .all()
    )
    return items, total


def get_event(db: Session, event_id: int) -> Optional[ConversationCaptureEvent]:
    return (
        db.query(ConversationCaptureEvent)
        .filter(ConversationCaptureEvent.provider == PROVIDER, ConversationCaptureEvent.id == event_id)
        .first()
    )


def _truncate_preview(text: Optional[str], max_length: int = 140) -> Optional[str]:
    if not text:
        return None
    text = text.strip()
    if not text:
        return None
    if len(text) <= max_length:
        return text
    return text[:max_length].rstrip() + "…"


def _classify_conversation_health(prompts: int, responses: int) -> str:
    """See providers/chatgpt/queries.py's identical function for the
    reasoning - "degraded" means prompts were sent but no response was ever
    captured, "no_messages" means the conversation only has lifecycle events
    (a conversation_opened/conversation_created with nothing said)."""
    if prompts == 0 and responses == 0:
        return HEALTH_STATUS_NO_MESSAGES
    if prompts > 0 and responses == 0:
        return HEALTH_STATUS_DEGRADED
    return HEALTH_STATUS_HEALTHY


def _classify_overall_health(statuses: list[str]) -> str:
    if not statuses:
        return HEALTH_STATUS_OFFLINE
    for status in _HEALTH_STATUS_PRIORITY:
        if status in statuses:
            return status
    return HEALTH_STATUS_HEALTHY


def _conversation_to_summary_dict(
    record: ConversationRecord, *, last_message_preview: Optional[str] = None, owner: Optional[User] = None
) -> dict:
    data = record.to_dict()
    data["captureHealth"] = _classify_conversation_health(record.prompt_count or 0, record.response_count or 0)
    data["lastMessagePreview"] = last_message_preview
    data["lastActivityAt"] = data["updatedAt"]
    # Convenience fields for the dashboard's "by person" conversation browser
    # - record.to_dict() already carries ownerUserId (a bare id), this adds
    # the display name/email so the UI doesn't need a second round-trip per
    # conversation just to label who it belongs to.
    data["ownerName"] = owner.name if owner else (f"User #{record.owner_user_id}" if record.owner_user_id else None)
    data["ownerEmail"] = owner.email if owner else None
    return data


def _apply_conversation_filters(query, filters: EventFilters):
    query = query.filter(ConversationRecord.provider == PROVIDER)
    if filters.user_id is not None:
        query = query.filter(ConversationRecord.owner_user_id == filters.user_id)
    if filters.conversation_id:
        query = query.filter(ConversationRecord.provider_conversation_id == filters.conversation_id)
    if filters.date_from:
        query = query.filter(func.date(ConversationRecord.created_at) >= filters.date_from)
    if filters.date_to:
        query = query.filter(func.date(ConversationRecord.created_at) <= filters.date_to)
    return query


def list_conversations(db: Session, *, filters: EventFilters, limit: int, offset: int) -> tuple[list[dict], int]:
    base = _apply_conversation_filters(db.query(ConversationRecord), filters)
    if filters.q:
        needle = f"%{filters.q.strip()}%"
        matching_ids = {
            row[0]
            for row in (
                db.query(ConversationPrompt.conversation_id)
                .join(ConversationRecord, ConversationRecord.id == ConversationPrompt.conversation_id)
                .filter(ConversationRecord.provider == PROVIDER, ConversationPrompt.prompt_text.ilike(needle))
                .union(
                    db.query(ConversationResponse.conversation_id)
                    .join(ConversationRecord, ConversationRecord.id == ConversationResponse.conversation_id)
                    .filter(ConversationRecord.provider == PROVIDER, ConversationResponse.response_text.ilike(needle))
                )
                .all()
            )
        }
        text_match_clauses = [
            ConversationRecord.title.ilike(needle),
            ConversationRecord.provider_conversation_id.ilike(needle),
        ]
        if matching_ids:
            text_match_clauses.append(ConversationRecord.id.in_(matching_ids))
        base = base.filter(or_(*text_match_clauses))

    total = base.with_entities(func.count(ConversationRecord.id)).scalar() or 0
    records = base.order_by(ConversationRecord.updated_at.desc(), ConversationRecord.id.desc()).offset(offset).limit(limit).all()

    owner_ids = {record.owner_user_id for record in records if record.owner_user_id}
    owners_by_id = {user.id: user for user in db.query(User).filter(User.id.in_(owner_ids)).all()} if owner_ids else {}

    items = []
    for record in records:
        last_response = (
            db.query(ConversationResponse.response_text)
            .filter(ConversationResponse.conversation_id == record.id)
            .order_by(ConversationResponse.sequence_index.desc(), ConversationResponse.id.desc())
            .limit(1)
            .scalar()
        )
        last_prompt = None
        if not last_response:
            last_prompt = (
                db.query(ConversationPrompt.prompt_text)
                .filter(ConversationPrompt.conversation_id == record.id)
                .order_by(ConversationPrompt.sequence_index.desc(), ConversationPrompt.id.desc())
                .limit(1)
                .scalar()
            )
        items.append(
            _conversation_to_summary_dict(
                record,
                last_message_preview=_truncate_preview(last_response or last_prompt),
                owner=owners_by_id.get(record.owner_user_id),
            )
        )
    return items, total


def _owner_for_record(db: Session, record: ConversationRecord) -> Optional[User]:
    if not record.owner_user_id:
        return None
    return db.query(User).filter(User.id == record.owner_user_id).first()


def get_conversation_detail(db: Session, conversation_id: str) -> Optional[dict]:
    record = (
        db.query(ConversationRecord)
        .filter(ConversationRecord.provider == PROVIDER, ConversationRecord.provider_conversation_id == conversation_id)
        .first()
    )
    if record is None:
        return None
    return _conversation_to_summary_dict(record, owner=_owner_for_record(db, record))


def _prompt_to_message_dict(prompt: ConversationPrompt) -> dict:
    data = prompt.to_dict()
    data["role"] = "human"
    data["text"] = data.pop("promptText")
    data["timestamp"] = data.pop("promptTimestamp")
    return data


def _response_to_message_dict(response: ConversationResponse) -> dict:
    data = response.to_dict()
    data["role"] = "assistant"
    data["text"] = data.pop("responseText")
    data["timestamp"] = data.pop("responseTimestamp")
    return data


def list_conversation_messages(db: Session, conversation_id: str, *, limit: int = 200) -> Optional[dict]:
    record = (
        db.query(ConversationRecord)
        .filter(ConversationRecord.provider == PROVIDER, ConversationRecord.provider_conversation_id == conversation_id)
        .first()
    )
    if record is None:
        return None

    prompts = (
        db.query(ConversationPrompt)
        .filter(ConversationPrompt.conversation_id == record.id)
        .order_by(ConversationPrompt.sequence_index.asc(), ConversationPrompt.id.asc())
        .all()
    )
    responses = (
        db.query(ConversationResponse)
        .filter(ConversationResponse.conversation_id == record.id)
        .order_by(ConversationResponse.sequence_index.asc(), ConversationResponse.id.asc())
        .all()
    )

    messages = [_prompt_to_message_dict(prompt) for prompt in prompts] + [_response_to_message_dict(response) for response in responses]
    messages.sort(key=lambda item: (item.get("timestamp") or "", item.get("id") or 0))
    messages = messages[:limit]

    return {
        "conversation": _conversation_to_summary_dict(record, owner=_owner_for_record(db, record)),
        "messages": messages,
    }


def list_conversation_attachments(db: Session, conversation_id: str) -> list[dict]:
    """Real stored files (see attachments.py) for one conversation, newest
    first - mirrors providers/chatgpt/queries.py's identical function.
    Correlated to a specific prompt_captured message on the frontend by
    fileName (== the file's own Claude-assigned uuid - see
    content-claude-capture.js's extractAttachments/extractFiles, which put
    that same uuid on the prompt event's payload), not by conversation alone."""
    records = (
        db.query(ConversationCaptureAttachment)
        .filter(
            ConversationCaptureAttachment.provider == PROVIDER,
            ConversationCaptureAttachment.provider_conversation_id == conversation_id,
        )
        .order_by(ConversationCaptureAttachment.created_at.desc())
        .all()
    )
    return [record.to_dict() for record in records]


def get_metrics(db: Session) -> dict:
    total_events = (
        db.query(func.count(ConversationCaptureEvent.id)).filter(ConversationCaptureEvent.provider == PROVIDER).scalar() or 0
    )
    conversations_captured = (
        db.query(func.count(ConversationRecord.id)).filter(ConversationRecord.provider == PROVIDER).scalar() or 0
    )
    users_captured = (
        db.query(func.count(func.distinct(ConversationCaptureEvent.user_id)))
        .filter(ConversationCaptureEvent.provider == PROVIDER)
        .scalar()
        or 0
    )
    prompts_captured = (
        db.query(func.count(ConversationCaptureEvent.id))
        .filter(ConversationCaptureEvent.provider == PROVIDER, ConversationCaptureEvent.event_type == EVENT_TYPE_PROMPT_CAPTURED)
        .scalar()
        or 0
    )
    responses_captured = (
        db.query(func.count(ConversationCaptureEvent.id))
        .filter(ConversationCaptureEvent.provider == PROVIDER, ConversationCaptureEvent.event_type == EVENT_TYPE_RESPONSE_COMPLETED)
        .scalar()
        or 0
    )
    last_capture_time = (
        db.query(func.max(ConversationCaptureEvent.created_at)).filter(ConversationCaptureEvent.provider == PROVIDER).scalar()
    )
    events_today = (
        db.query(func.count(ConversationCaptureEvent.id))
        .filter(ConversationCaptureEvent.provider == PROVIDER, ConversationCaptureEvent.event_date == datetime.utcnow().date())
        .scalar()
        or 0
    )

    version_rows = (
        db.query(ConversationCaptureEvent.capture_version, func.count(ConversationCaptureEvent.id))
        .filter(ConversationCaptureEvent.provider == PROVIDER)
        .group_by(ConversationCaptureEvent.capture_version)
        .all()
    )
    capture_version_distribution = {str(version): count for version, count in version_rows}

    health_rows = db.query(ConversationCaptureHealth).filter(ConversationCaptureHealth.provider == PROVIDER).all()
    now = datetime.utcnow()
    health_statuses = [compute_capture_health_status(record, now=now) for record in health_rows]
    queue_length_total = sum(record.queue_length or 0 for record in health_rows)
    events_waiting_total = sum(record.events_waiting or 0 for record in health_rows)
    max_retry_count = max((record.retry_count or 0 for record in health_rows), default=0)
    upload_times = [record.average_upload_time_ms for record in health_rows if record.average_upload_time_ms is not None]
    average_upload_time_ms = round(sum(upload_times) / len(upload_times)) if upload_times else None
    upload_failure_installs = sum(
        1
        for record in health_rows
        if record.last_failed_upload_at
        and (not record.last_successful_upload_at or record.last_failed_upload_at > record.last_successful_upload_at)
    )
    install_health_breakdown: dict[str, int] = {}
    for status in health_statuses:
        install_health_breakdown[status] = install_health_breakdown.get(status, 0) + 1

    latest_health = max(health_rows, key=lambda record: record.reported_at or datetime.min, default=None)
    latest_extension_version = latest_health.extension_version if latest_health else None
    if not latest_extension_version:
        latest_extension_version = (
            db.query(ConversationCaptureEvent.extension_version)
            .filter(ConversationCaptureEvent.provider == PROVIDER, ConversationCaptureEvent.extension_version.isnot(None))
            .order_by(ConversationCaptureEvent.created_at.desc())
            .limit(1)
            .scalar()
        )
    last_heartbeat_at = latest_health.reported_at if latest_health else None
    latest_capture_version = max((int(version) for version in capture_version_distribution), default=None)

    ingest_stats = get_ingest_stats_snapshot()
    total_ingest_attempts = sum(ingest_stats.values())
    success_rate_percent = (
        round((ingest_stats["created"] / total_ingest_attempts) * 100, 1) if total_ingest_attempts else None
    )

    return {
        "totalEvents": total_events,
        "eventsToday": events_today,
        "usersCaptured": users_captured,
        "conversationsCaptured": conversations_captured,
        "messagesCaptured": prompts_captured + responses_captured,
        "promptsCaptured": prompts_captured,
        "responsesCaptured": responses_captured,
        "lastCaptureTime": serialize_utc_datetime(last_capture_time),
        "captureVersionDistribution": capture_version_distribution,
        "captureHealth": _classify_overall_health(health_statuses),
        "installHealthBreakdown": install_health_breakdown,
        "extension": {
            "version": latest_extension_version,
            "captureVersion": latest_capture_version,
            "lastHeartbeatAt": serialize_utc_datetime(last_heartbeat_at),
        },
        "backend": {
            "status": "connected",
            "database": "healthy",
        },
        "queue": {
            "queueLengthTotal": queue_length_total,
            "eventsWaitingTotal": events_waiting_total,
            "maxRetryCount": max_retry_count,
            "averageUploadTimeMs": average_upload_time_ms,
            "uploadFailureInstalls": upload_failure_installs,
            "activeInstalls": len(health_rows),
        },
        "ingestStats": {
            "created": ingest_stats["created"],
            "duplicate": ingest_stats["duplicate"],
            "rejected": ingest_stats["rejected"],
            "successRatePercent": success_rate_percent,
            "windowLabel": "since last server restart",
        },
    }


def list_users(
    db: Session,
    *,
    q: Optional[str] = None,
    health_filter: Optional[str] = None,
    department: Optional[str] = None,
    sort: str = "recent",
    limit: int = DEFAULT_CONVERSATIONS_LIMIT,
    offset: int = 0,
) -> tuple[list[dict], int]:
    """Grouped by ConversationRecord.owner_user_id (falling back to the raw
    ConversationCaptureEvent.user_id for conversations that landed unclaimed
    - see normalization.py's _get_or_create_conversation_record) - same
    fallback reasoning as providers/chatgpt/queries.py's list_users, simpler
    to express here because ConversationRecord.prompt_count/response_count
    are always up to date, so no per-conversation raw-event rollup is
    needed."""
    # ConversationCaptureEvent has no direct FK to ConversationRecord, so
    # attribution is resolved via a correlated subquery rather than a join -
    # a conversation's owner is a property of the record itself once
    # ownership_status is resolved, and only needs a fallback lookup (the
    # conversation's earliest capture event's user_id) when it isn't.
    grouped_base = db.query(ConversationRecord).filter(ConversationRecord.provider == PROVIDER)

    fallback_user_subquery = (
        db.query(ConversationCaptureEvent.user_id)
        .filter(
            ConversationCaptureEvent.provider == PROVIDER,
            ConversationCaptureEvent.provider_conversation_id == ConversationRecord.provider_conversation_id,
        )
        .order_by(ConversationCaptureEvent.created_at.asc())
        .limit(1)
        .correlate(ConversationRecord)
        .scalar_subquery()
    )
    attributed_user_id = func.coalesce(ConversationRecord.owner_user_id, fallback_user_subquery)

    if department:
        grouped_base = grouped_base.join(User, User.id == attributed_user_id).filter(User.department == department)
    if q:
        needle = f"%{q.strip()}%"
        matching_user_ids = {
            row[0]
            for row in db.query(User.id).filter(or_(User.name.ilike(needle), User.email.ilike(needle))).all()
        }
        if not matching_user_ids:
            return [], 0
        grouped_base = grouped_base.filter(attributed_user_id.in_(matching_user_ids))

    grouped = grouped_base.with_entities(
        attributed_user_id.label("user_id"),
        func.count(func.distinct(ConversationRecord.id)).label("conversation_count"),
        func.coalesce(func.sum(ConversationRecord.prompt_count), 0).label("prompt_count"),
        func.coalesce(func.sum(ConversationRecord.response_count), 0).label("response_count"),
        func.min(ConversationRecord.created_at).label("first_seen_at"),
        func.max(ConversationRecord.updated_at).label("last_seen_at"),
    ).group_by(attributed_user_id)

    if health_filter:
        # Health isn't a stored column - resolve it per user from each of
        # their conversations' own prompt_count/response_count, same
        # reasoning as providers/chatgpt/queries.py's identical gate.
        rows = grouped_base.with_entities(
            attributed_user_id.label("user_id"), ConversationRecord.prompt_count, ConversationRecord.response_count
        ).all()
        conv_map: dict[int, list[str]] = {}
        for user_id, prompt_count, response_count in rows:
            conv_map.setdefault(user_id, []).append(_classify_conversation_health(prompt_count or 0, response_count or 0))
        matching_health_user_ids = {
            user_id for user_id, statuses in conv_map.items() if _classify_overall_health(statuses) == health_filter
        }
        if not matching_health_user_ids:
            return [], 0
        grouped = grouped.filter(attributed_user_id.in_(matching_health_user_ids))

    total = grouped.count()

    sort_key = sort if sort in _USER_SORT_OPTIONS else "recent"
    if sort_key == "conversations":
        grouped = grouped.order_by(func.count(func.distinct(ConversationRecord.id)).desc())
    elif sort_key == "messages":
        grouped = grouped.order_by((func.sum(ConversationRecord.prompt_count) + func.sum(ConversationRecord.response_count)).desc())
    elif sort_key != "name":
        grouped = grouped.order_by(func.max(ConversationRecord.updated_at).desc())

    page_rows = grouped.offset(offset).limit(limit).all()
    user_ids = [row.user_id for row in page_rows if row.user_id is not None]
    users_by_id = {user.id: user for user in db.query(User).filter(User.id.in_(user_ids)).all()} if user_ids else {}

    # Per-user overall health, from the same per-conversation rollup as the
    # health_filter gate above (recomputed here unconditionally so it's
    # populated even when no health_filter was passed).
    detail_rows = (
        grouped_base.with_entities(attributed_user_id.label("user_id"), ConversationRecord.prompt_count, ConversationRecord.response_count)
        .filter(attributed_user_id.in_(user_ids))
        .all()
        if user_ids
        else []
    )
    conv_map: dict[int, list[str]] = {}
    for user_id, prompt_count, response_count in detail_rows:
        conv_map.setdefault(user_id, []).append(_classify_conversation_health(prompt_count or 0, response_count or 0))

    items = []
    for row in page_rows:
        if row.user_id is None:
            continue
        user = users_by_id.get(row.user_id)
        items.append(
            {
                "userId": row.user_id,
                "name": user.name if user else f"User #{row.user_id}",
                "email": user.email if user else None,
                "department": getattr(user, "department", None) if user else None,
                "avatar": getattr(user, "avatar", None) if user else None,
                "conversationsCount": row.conversation_count,
                "eventCount": (row.prompt_count or 0) + (row.response_count or 0),
                "messagesCount": (row.prompt_count or 0) + (row.response_count or 0),
                "promptsCount": row.prompt_count or 0,
                "responsesCount": row.response_count or 0,
                "captureHealth": _classify_overall_health(conv_map.get(row.user_id, [])),
                "lastActiveAt": serialize_utc_datetime(row.last_seen_at),
                "firstSeenAt": serialize_utc_datetime(row.first_seen_at),
            }
        )
    if sort_key == "name":
        items.sort(key=lambda item: (item["name"] or "").lower())
    return items, total


def get_user_detail(db: Session, user_id: int) -> Optional[dict]:
    user = db.query(User).filter(User.id == user_id).first()
    if user is None:
        return None

    fallback_user_subquery = (
        db.query(ConversationCaptureEvent.user_id)
        .filter(
            ConversationCaptureEvent.provider == PROVIDER,
            ConversationCaptureEvent.provider_conversation_id == ConversationRecord.provider_conversation_id,
        )
        .order_by(ConversationCaptureEvent.created_at.asc())
        .limit(1)
        .correlate(ConversationRecord)
        .scalar_subquery()
    )
    attributed_user_id = func.coalesce(ConversationRecord.owner_user_id, fallback_user_subquery)

    records = (
        db.query(ConversationRecord)
        .filter(ConversationRecord.provider == PROVIDER, attributed_user_id == user_id)
        .order_by(ConversationRecord.updated_at.desc())
        .all()
    )
    statuses = [_classify_conversation_health(r.prompt_count or 0, r.response_count or 0) for r in records]
    prompts = sum(r.prompt_count or 0 for r in records)
    responses = sum(r.response_count or 0 for r in records)

    return {
        "userId": user.id,
        "name": user.name,
        "email": user.email,
        "department": getattr(user, "department", None),
        "avatar": getattr(user, "avatar", None),
        "conversationsCount": len(records),
        "promptsCount": prompts,
        "responsesCount": responses,
        "messagesCount": prompts + responses,
        "captureHealth": _classify_overall_health(statuses),
        "conversations": [_conversation_to_summary_dict(record, owner=user) for record in records],
    }
