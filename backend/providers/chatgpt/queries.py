# providers/chatgpt/queries.py
"""
Read-only query/aggregation layer for the Capture Center (GET /events,
/events/{id}, /conversations, /metrics). Never writes to the database -
ingestion lives in capture.py, health snapshotting in health.py, this module
only reads ConversationCaptureEvent/ConversationCaptureHealth.

Conversations aren't a stored entity yet (Phase 3 owns ConversationRecord) -
"conversations" here means "distinct provider_conversation_id values seen in
the raw event log", derived on the fly.
"""
import re
from dataclasses import dataclass, replace
from datetime import date, datetime
from typing import Optional

from sqlalchemy import and_, case, cast, distinct, func, or_
from sqlalchemy.orm import Query, Session
from sqlalchemy.types import Text

from providers.chatgpt.capture import get_ingest_stats_snapshot
from providers.chatgpt.constants import (
    EVENT_TYPE_CONVERSATION_RENAMED,
    EVENT_TYPE_FILE_UPLOAD_DETECTED,
    EVENT_TYPE_GENERATION_CAPTURED,
    EVENT_TYPE_MESSAGE_EDITED,
    EVENT_TYPE_PROMPT_CAPTURED,
    EVENT_TYPE_RESPONSE_COMPLETED,
    EVENT_TYPE_RESPONSE_STARTED,
    HEALTH_STATUS_BACKLOGGED,
    HEALTH_STATUS_DEGRADED,
    HEALTH_STATUS_HEALTHY,
    HEALTH_STATUS_OFFLINE,
    OWNERSHIP_STATUS_RESOLVED,
    PROVIDER,
)
from providers.chatgpt.health import compute_capture_health_status
from providers.chatgpt.models import (
    ConversationCaptureAttachment,
    ConversationCaptureEvent,
    ConversationCaptureHealth,
    ConversationMediaAsset,
    ConversationPrompt,
    ConversationRecord,
    ConversationResponse,
)
from models_new import User
from utils.datetime_utils import serialize_utc_datetime

# Event types that make up a conversation's chat flow (as opposed to lifecycle
# events like opened/renamed/archived, which describe the conversation itself
# rather than something someone said).
_CHAT_MESSAGE_EVENT_TYPES = (
    EVENT_TYPE_PROMPT_CAPTURED,
    EVENT_TYPE_MESSAGE_EDITED,
    EVENT_TYPE_RESPONSE_STARTED,
    EVENT_TYPE_RESPONSE_COMPLETED,
    EVENT_TYPE_FILE_UPLOAD_DETECTED,
)

# Same "real activity vs lifecycle" distinction as _CHAT_MESSAGE_EVENT_TYPES
# above, reused for "how recently active is this conversation" (list sort +
# displayed lastSeenAt/lastActiveAt), plus generation_captured (a genuine new-
# content event that constant doesn't include, since it isn't itself a chat
# turn to reconstruct). Lifecycle/observation events - conversation_opened,
# conversation_renamed, conversation_archived/deleted - are deliberately
# excluded: merely navigating to a long-dormant conversation fires a
# conversation_opened (and, until a companion extension fix, a spurious
# conversation_renamed - see content-chatgpt-dom-observer.js) for it, which
# without this exclusion resurfaced it at the top of "most recent" despite no
# real activity having happened. Confirmed against production data: a
# conversation last messaged in on 2026-07-16 got a fresh conversation_opened
# + conversation_renamed pair on 2026-07-28 purely from being reopened.
_CONVERSATION_ACTIVITY_EVENT_TYPES = _CHAT_MESSAGE_EVENT_TYPES + (EVENT_TYPE_GENERATION_CAPTURED,)

DEFAULT_EVENTS_LIMIT = 25
MAX_EVENTS_LIMIT = 200
DEFAULT_CONVERSATIONS_LIMIT = 20
MAX_CONVERSATIONS_LIMIT = 100

_HEALTH_STATUS_PRIORITY = (HEALTH_STATUS_OFFLINE, HEALTH_STATUS_BACKLOGGED, HEALTH_STATUS_DEGRADED, HEALTH_STATUS_HEALTHY)


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


def _apply_event_filters(query: Query, filters: EventFilters) -> Query:
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


def _search_matching_conversation_ids(db: Session, q: str) -> set[str]:
    """Search-by-text needs to match what a person actually typed - a
    conversation's title or something said in it - not just internal id
    fields (the only thing _apply_event_filters' q clause matches, which is
    fine for the Raw Event Inspector's developer-facing lookup but not for a
    "Search conversations..." box a real user types into). Rather than
    tracking which JSON key holds the title vs. message text per event type,
    this casts the whole payload to text and substring-matches against that -
    broad, but simple and portable across Postgres/SQLite instead of relying
    on a dialect-specific JSON operator."""
    needle = f"%{q.strip()}%"
    rows = (
        db.query(ConversationCaptureEvent.provider_conversation_id)
        .filter(
            ConversationCaptureEvent.provider == PROVIDER,
            ConversationCaptureEvent.provider_conversation_id.isnot(None),
            or_(
                cast(ConversationCaptureEvent.payload_json, Text).ilike(needle),
                ConversationCaptureEvent.provider_conversation_id.ilike(needle),
                ConversationCaptureEvent.client_event_id.ilike(needle),
                ConversationCaptureEvent.provider_message_id.ilike(needle),
            ),
        )
        .distinct()
        .all()
    )
    return {row[0] for row in rows}


def list_conversations(db: Session, *, filters: EventFilters, limit: int, offset: int) -> tuple[list[dict], int]:
    """Two-step aggregate, deliberately avoiding array_agg/GROUP_CONCAT (dialect-specific):
    (1) group the *entire filtered set* down to one row per conversation for pagination,
    (2) fetch full event rows only for the conversation ids on the current page to build
    per-type counts / latest-event / title-guess. Step 2's cost is bounded by page size,
    not table size, regardless of how many events exist overall."""
    matching_conversation_ids: Optional[set[str]] = None
    if filters.q:
        matching_conversation_ids = _search_matching_conversation_ids(db, filters.q)
        if not matching_conversation_ids:
            return [], 0
        # Which conversations match is already decided above - re-applying q
        # at the event level below would wrongly shrink eventCount/
        # eventTypeCounts down to just the matching event(s) instead of the
        # conversation's real totals within the remaining filters.
        filters = replace(filters, q=None)

    # "This user's conversations" must mean conversations they actually own
    # (ConversationRecord.owner_user_id, resolved via the same
    # isNewConversation freshness gate normalization.py's
    # _get_or_create_conversation_record applies) - not "every conversation
    # whose raw event log happens to contain something sent by this user's
    # session". The latter pulled in any conversation someone merely opened
    # or continued, regardless of who actually started it - confirmed in
    # production: an employee opening a 2-week-old conversation that had
    # already been correctly captured under a different owner caused it to
    # also show up in the opener's own conversation list. Same shared-
    # credential misattribution bug already fixed for Kling/Freepik, one
    # layer up (the browse view, not the ownership field itself, which was
    # already protected). _apply_event_filters' own user_id clause is left
    # untouched - list_events (the raw Developer Console event inspector)
    # legitimately wants "events this session sent", a different, valid
    # question from "conversations this person owns".
    # ...but requiring resolved ownership and NOTHING else made this the exact
    # mirror-image of the bug list_users had before 2026-08-05 (see its
    # docstring): a conversation captured mid-thread never gets a resolved
    # ConversationRecord, so it was dropped here entirely. list_users was
    # fixed to fall back to the capturing session (attributed_user_id) and
    # therefore *counts* those conversations, while this function still
    # returned only resolved ones - so the two disagreed. A user whose
    # conversations were all captured mid-thread showed a real conversation
    # count in the list and then an empty "No conversations captured yet" on
    # drill-down. Confirmed against live data: 54 of 119 captured
    # conversations had no ConversationRecord at all, and the "Unconfirmed"
    # badge the list already renders is driven by exactly the rows this
    # dropped.
    #
    # The attribution rule below is the set-based twin of list_users'
    # coalesce, so the count and the drill-down are now the same question:
    #   resolved  -> the conversation belongs to its owner, and to nobody else
    #                (this is what keeps the shared-credential misattribution
    #                fix above intact - opening someone else's resolved thread
    #                still does not put it in your list)
    #   unresolved-> best-effort: it belongs to whoever's session captured it
    unconfirmed_conversation_ids: set[str] = set()
    owned_conversation_ids: Optional[set[str]] = None
    if filters.user_id is not None:
        resolved_owner_by_conversation = {
            conversation_id: owner_user_id
            for conversation_id, owner_user_id in db.query(
                ConversationRecord.provider_conversation_id,
                ConversationRecord.owner_user_id,
            )
            .filter(
                ConversationRecord.provider == PROVIDER,
                ConversationRecord.ownership_status == OWNERSHIP_STATUS_RESOLVED,
                ConversationRecord.provider_conversation_id.isnot(None),
            )
            .all()
        }
        captured_conversation_ids = {
            row[0]
            for row in db.query(distinct(ConversationCaptureEvent.provider_conversation_id))
            .filter(
                ConversationCaptureEvent.provider == PROVIDER,
                ConversationCaptureEvent.user_id == filters.user_id,
                ConversationCaptureEvent.provider_conversation_id.isnot(None),
            )
            .all()
        }
        # Anything this user's session captured that nobody owns outright.
        unconfirmed_conversation_ids = captured_conversation_ids - set(resolved_owner_by_conversation)
        owned_conversation_ids = {
            conversation_id
            for conversation_id, owner_user_id in resolved_owner_by_conversation.items()
            if owner_user_id == filters.user_id
        } | unconfirmed_conversation_ids
        if not owned_conversation_ids:
            return [], 0
        # Attribution already answers the "which user" question above; the
        # events query below stays unfiltered by user_id so it still pulls
        # every message in an owned conversation (including any reply
        # someone else's session added to it, which correctly stays part of
        # that conversation's history once ownership has resolved).
        filters = replace(filters, user_id=None)

    grouped_base = _apply_event_filters(db.query(ConversationCaptureEvent), filters).filter(
        ConversationCaptureEvent.provider_conversation_id.isnot(None)
    )
    if matching_conversation_ids is not None:
        grouped_base = grouped_base.filter(
            ConversationCaptureEvent.provider_conversation_id.in_(matching_conversation_ids)
        )
    if owned_conversation_ids is not None:
        grouped_base = grouped_base.filter(
            ConversationCaptureEvent.provider_conversation_id.in_(owned_conversation_ids)
        )
    # Falls back to the full event-set max only when a conversation has no
    # activity-typed event at all yet (e.g. capture failed on everything but
    # a lifecycle signal) - never surfaces NULL, just prefers real activity
    # time over passive/observation time when both exist.
    activity_created_at = case(
        (ConversationCaptureEvent.event_type.in_(_CONVERSATION_ACTIVITY_EVENT_TYPES), ConversationCaptureEvent.created_at),
        else_=None,
    )
    last_seen_at_expr = func.coalesce(func.max(activity_created_at), func.max(ConversationCaptureEvent.created_at))

    grouped = grouped_base.with_entities(
        ConversationCaptureEvent.provider_conversation_id.label("conversation_id"),
        func.count(ConversationCaptureEvent.id).label("event_count"),
        func.min(ConversationCaptureEvent.created_at).label("first_seen_at"),
        last_seen_at_expr.label("last_seen_at"),
    ).group_by(ConversationCaptureEvent.provider_conversation_id)

    total = grouped.count()
    page_rows = (
        grouped.order_by(last_seen_at_expr.desc())
        .offset(offset)
        .limit(limit)
        .all()
    )
    conversation_ids = [row.conversation_id for row in page_rows]

    detail_by_conversation: dict[str, dict] = {
        cid: {
            "event_types": {},
            "latest_event_type": None,
            "latest_created_at": None,
            "title": None,
            "model": None,
            "prompts": 0,
            "responses": 0,
            "first_prompt_preview": None,
            "last_response_preview": None,
        }
        for cid in conversation_ids
    }
    if conversation_ids:
        detail_rows = (
            db.query(
                ConversationCaptureEvent.provider_conversation_id,
                ConversationCaptureEvent.event_type,
                ConversationCaptureEvent.created_at,
                ConversationCaptureEvent.payload_json,
            )
            .filter(
                ConversationCaptureEvent.provider == PROVIDER,
                ConversationCaptureEvent.provider_conversation_id.in_(conversation_ids),
            )
            .order_by(ConversationCaptureEvent.created_at.asc())
            .all()
        )
        for conversation_id, event_type, created_at, payload in detail_rows:
            bucket = detail_by_conversation[conversation_id]
            payload = payload or {}
            bucket["event_types"][event_type] = bucket["event_types"].get(event_type, 0) + 1
            if bucket["latest_created_at"] is None or created_at >= bucket["latest_created_at"]:
                bucket["latest_created_at"] = created_at
                bucket["latest_event_type"] = event_type
            if event_type == EVENT_TYPE_CONVERSATION_RENAMED:
                new_title = payload.get("newTitle") or payload.get("new_title")
                if new_title:
                    bucket["title"] = new_title
            elif event_type == EVENT_TYPE_PROMPT_CAPTURED:
                bucket["prompts"] += 1
                if bucket["first_prompt_preview"] is None:
                    bucket["first_prompt_preview"] = _truncate_preview(payload.get("text"))
            elif event_type == EVENT_TYPE_RESPONSE_COMPLETED:
                bucket["responses"] += 1
                bucket["model"] = payload.get("model") or bucket["model"]
                bucket["last_response_preview"] = _truncate_preview(payload.get("text"))
            elif event_type == EVENT_TYPE_RESPONSE_STARTED:
                bucket["model"] = payload.get("model") or bucket["model"]

    attachment_counts_by_conversation: dict[str, tuple[int, int]] = {}
    if conversation_ids:
        attachment_rows = (
            db.query(ConversationCaptureAttachment.provider_conversation_id, ConversationCaptureAttachment.mime_type)
            .filter(
                ConversationCaptureAttachment.provider == PROVIDER,
                ConversationCaptureAttachment.provider_conversation_id.in_(conversation_ids),
            )
            .all()
        )
        for conversation_id, mime_type in attachment_rows:
            images, files = attachment_counts_by_conversation.get(conversation_id, (0, 0))
            if (mime_type or "").startswith("image/"):
                images += 1
            else:
                files += 1
            attachment_counts_by_conversation[conversation_id] = (images, files)

        # Generated/response media assets (ConversationMediaAsset) count toward
        # the same "images" total shown in the conversation summary - separate
        # table from ConversationCaptureAttachment (uploaded files) above, so
        # it's a separate query folded into the same running tally. Only
        # url-bearing (stored) rows count, matching what the gallery renders.
        media_rows = (
            db.query(
                ConversationMediaAsset.provider_conversation_id,
                func.count(ConversationMediaAsset.id),
            )
            .filter(
                ConversationMediaAsset.provider == PROVIDER,
                ConversationMediaAsset.provider_conversation_id.in_(conversation_ids),
                ConversationMediaAsset.url.isnot(None),
            )
            .group_by(ConversationMediaAsset.provider_conversation_id)
            .all()
        )
        for conversation_id, media_count in media_rows:
            images, files = attachment_counts_by_conversation.get(conversation_id, (0, 0))
            attachment_counts_by_conversation[conversation_id] = (images + int(media_count or 0), files)

    items = []
    for row in page_rows:
        detail = detail_by_conversation.get(row.conversation_id, {})
        images_count, files_count = attachment_counts_by_conversation.get(row.conversation_id, (0, 0))
        items.append(
            {
                "conversationId": row.conversation_id,
                "title": detail.get("title"),
                "model": detail.get("model"),
                "eventCount": row.event_count,
                "eventTypeCounts": detail.get("event_types", {}),
                "latestEventType": detail.get("latest_event_type"),
                "promptsCount": detail.get("prompts", 0),
                "responsesCount": detail.get("responses", 0),
                "imagesCount": images_count,
                "filesCount": files_count,
                "firstPromptPreview": detail.get("first_prompt_preview"),
                "lastResponsePreview": detail.get("last_response_preview"),
                "captureHealth": _classify_conversation_health(detail.get("prompts", 0), detail.get("responses", 0)),
                # True only on the per-user drill-down, for rows included by
                # the best-effort branch above - the same thing the user
                # list's "Unconfirmed" badge warns about, now attributable to
                # the individual conversation instead of only the person.
                "isUnconfirmedOwnership": row.conversation_id in unconfirmed_conversation_ids,
                "firstSeenAt": serialize_utc_datetime(row.first_seen_at),
                "lastSeenAt": serialize_utc_datetime(row.last_seen_at),
            }
        )
    return items, total


def _search_matching_user_ids(db: Session, q: str) -> set[int]:
    """Mirrors _search_matching_conversation_ids but one level up: matches
    what an admin would actually type into the Users search box - a name,
    email, or department - not an internal id."""
    needle = f"%{q.strip()}%"
    rows = (
        db.query(User.id)
        .filter(or_(User.name.ilike(needle), User.email.ilike(needle), User.department.ilike(needle)))
        .all()
    )
    return {row[0] for row in rows}


_USER_SORT_OPTIONS = {"recent", "conversations", "messages", "name"}


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
    """Same two-step aggregate shape as list_conversations, one level up the
    hierarchy: (1) group the filtered event set by user_id for cheap
    pagination, (2) fetch full detail only for the current page's user_ids
    to compute per-conversation health rollups and attachment counts -
    bounded by page size, not table size, regardless of how many users or
    conversations exist overall.

    Grouped by attributed_user_id = ConversationRecord.owner_user_id when
    ownership is resolved, falling back to the raw
    ConversationCaptureEvent.user_id (the capturing browser session) when
    it isn't. Fixed 2026-08-05: this used to be an INNER join requiring
    ownership_status == resolved, which - correctly, by design - drops a
    conversation whose first-ever capture wasn't flagged isNewConversation
    (see normalization.py's _is_attributable) rather than guess an owner for
    it. In production that meant most users, whose ChatGPT usage mostly
    continues pre-existing threads rather than starting brand-new ones,
    never appeared in this admin-facing list at all - 20 of 22 real captured
    users - even though the /metrics tile (no ownership gate at all) still
    counted them, producing a visibly inconsistent "22 users, 2 shown"
    admin view. This is a reporting/visibility view, not a billing or
    generation-linking one, so the tradeoff here is different from Freepik/
    HeyGen/Kling's identical-looking ownership gates: showing a
    best-effort attribution (whoever's own browser captured the event) is
    better than making 90% of real users invisible. hasUnresolvedConversations
    flags it per-user rather than presenting it with the same confidence as
    a fully-resolved user."""
    is_resolved = ConversationRecord.ownership_status == OWNERSHIP_STATUS_RESOLVED
    attributed_user_id = func.coalesce(
        case((is_resolved, ConversationRecord.owner_user_id), else_=None),
        ConversationCaptureEvent.user_id,
    )
    grouped_base = (
        db.query(ConversationCaptureEvent)
        .outerjoin(
            ConversationRecord,
            and_(
                ConversationRecord.provider == PROVIDER,
                ConversationRecord.provider_conversation_id == ConversationCaptureEvent.provider_conversation_id,
            ),
        )
        .join(User, User.id == attributed_user_id)
        .filter(ConversationCaptureEvent.provider == PROVIDER)
    )
    if q:
        matching_user_ids = _search_matching_user_ids(db, q)
        if not matching_user_ids:
            return [], 0
        grouped_base = grouped_base.filter(attributed_user_id.in_(matching_user_ids))
    if department:
        grouped_base = grouped_base.filter(User.department == department)

    if health_filter:
        # Health isn't a raw column - determining "which users match" requires
        # the same per-conversation prompt/response rollup as step 2 below,
        # just run over the *entire* filtered set (not just the current page)
        # so pagination/totals stay correct rather than approximate.
        health_scan_rows = (
            grouped_base.with_entities(
                attributed_user_id.label("user_id"),
                ConversationCaptureEvent.provider_conversation_id,
                ConversationCaptureEvent.event_type,
            )
            .filter(ConversationCaptureEvent.provider_conversation_id.isnot(None))
            .all()
        )
        conv_map: dict[int, dict[str, dict[str, int]]] = {}
        for user_id, conversation_id, event_type in health_scan_rows:
            bucket = conv_map.setdefault(user_id, {}).setdefault(conversation_id, {"prompts": 0, "responses": 0})
            if event_type == EVENT_TYPE_PROMPT_CAPTURED:
                bucket["prompts"] += 1
            elif event_type == EVENT_TYPE_RESPONSE_COMPLETED:
                bucket["responses"] += 1
        matching_health_user_ids = {
            user_id
            for user_id, convs in conv_map.items()
            if _classify_overall_health(
                [_classify_conversation_health(c["prompts"], c["responses"]) for c in convs.values()]
            )
            == health_filter
        }
        if not matching_health_user_ids:
            return [], 0
        grouped_base = grouped_base.filter(attributed_user_id.in_(matching_health_user_ids))

    # Same activity-vs-lifecycle distinction as list_conversations' last_seen_at
    # above - a user merely opening an old conversation shouldn't make them
    # look freshly active.
    user_activity_created_at = case(
        (ConversationCaptureEvent.event_type.in_(_CONVERSATION_ACTIVITY_EVENT_TYPES), ConversationCaptureEvent.created_at),
        else_=None,
    )
    user_last_seen_at_expr = func.coalesce(func.max(user_activity_created_at), func.max(ConversationCaptureEvent.created_at))

    grouped = grouped_base.with_entities(
        attributed_user_id.label("user_id"),
        func.count(func.distinct(ConversationCaptureEvent.provider_conversation_id)).label("conversation_count"),
        func.count(ConversationCaptureEvent.id).label("event_count"),
        func.min(ConversationCaptureEvent.created_at).label("first_seen_at"),
        user_last_seen_at_expr.label("last_seen_at"),
        func.max(case((is_resolved, 0), else_=1)).label("has_unresolved"),
    ).group_by(attributed_user_id)

    total = grouped.count()

    sort_key = sort if sort in _USER_SORT_OPTIONS else "recent"
    if sort_key == "conversations":
        grouped = grouped.order_by(func.count(func.distinct(ConversationCaptureEvent.provider_conversation_id)).desc())
    elif sort_key == "messages":
        grouped = grouped.order_by(func.count(ConversationCaptureEvent.id).desc())
    elif sort_key == "name":
        grouped = grouped.order_by(func.min(User.name).asc())
    else:
        grouped = grouped.order_by(user_last_seen_at_expr.desc())

    page_rows = grouped.offset(offset).limit(limit).all()
    user_ids = [row.user_id for row in page_rows]
    unresolved_by_user = {row.user_id: bool(row.has_unresolved) for row in page_rows}

    # Per-conversation prompt/response counts for the current page's users,
    # to classify health per conversation and roll that up - same reasoning
    # as _classify_conversation_health/_classify_overall_health, one level up.
    # Same attributed_user_id fallback as the grouping query above, so a
    # user's displayed conversationsCount/messagesCount actually match the
    # totals that got them onto this page in the first place.
    conversation_stats: dict[int, dict[str, dict[str, int]]] = {uid: {} for uid in user_ids}
    if user_ids:
        detail_rows = (
            db.query(
                attributed_user_id.label("user_id"),
                ConversationCaptureEvent.provider_conversation_id,
                ConversationCaptureEvent.event_type,
            )
            .select_from(ConversationCaptureEvent)
            .outerjoin(
                ConversationRecord,
                and_(
                    ConversationRecord.provider == PROVIDER,
                    ConversationRecord.provider_conversation_id == ConversationCaptureEvent.provider_conversation_id,
                ),
            )
            .filter(
                ConversationCaptureEvent.provider == PROVIDER,
                attributed_user_id.in_(user_ids),
                ConversationCaptureEvent.provider_conversation_id.isnot(None),
            )
            .all()
        )
        for user_id, conversation_id, event_type in detail_rows:
            bucket = conversation_stats[user_id].setdefault(conversation_id, {"prompts": 0, "responses": 0})
            if event_type == EVENT_TYPE_PROMPT_CAPTURED:
                bucket["prompts"] += 1
            elif event_type == EVENT_TYPE_RESPONSE_COMPLETED:
                bucket["responses"] += 1

    prompts_by_user: dict[int, int] = {}
    responses_by_user: dict[int, int] = {}
    health_by_user: dict[int, str] = {}
    for user_id in user_ids:
        conv_map = conversation_stats.get(user_id, {})
        prompts_by_user[user_id] = sum(c["prompts"] for c in conv_map.values())
        responses_by_user[user_id] = sum(c["responses"] for c in conv_map.values())
        statuses = [_classify_conversation_health(c["prompts"], c["responses"]) for c in conv_map.values()]
        health_by_user[user_id] = _classify_overall_health(statuses) if statuses else HEALTH_STATUS_HEALTHY

    # Attachments belong to a conversation_id, not directly to an event/user,
    # so they can't reuse the attributed_user_id expression as a join
    # condition the way detail_rows above does - a naive join back through
    # ConversationCaptureEvent to borrow a user_id would cross-multiply one
    # attachment row per matching event sharing that conversation_id and
    # wildly overcount. conversation_stats (built from detail_rows just
    # above, using the exact same fallback attribution) already has the
    # correct, de-duplicated conversation_id -> user_id mapping for this
    # page's users - reuse it instead of re-deriving via SQL.
    conversation_owner_lookup: dict[str, int] = {
        conversation_id: user_id
        for user_id, convs in conversation_stats.items()
        for conversation_id in convs
    }
    images_by_user: dict[int, int] = {}
    files_by_user: dict[int, int] = {}
    if conversation_owner_lookup:
        attachment_rows = (
            db.query(ConversationCaptureAttachment.provider_conversation_id, ConversationCaptureAttachment.mime_type)
            .filter(
                ConversationCaptureAttachment.provider == PROVIDER,
                ConversationCaptureAttachment.provider_conversation_id.in_(conversation_owner_lookup.keys()),
            )
            .all()
        )
        for conversation_id, mime_type in attachment_rows:
            user_id = conversation_owner_lookup.get(conversation_id)
            if user_id is None:
                continue
            if (mime_type or "").startswith("image/"):
                images_by_user[user_id] = images_by_user.get(user_id, 0) + 1
            else:
                files_by_user[user_id] = files_by_user.get(user_id, 0) + 1

    users_by_id = {user.id: user for user in db.query(User).filter(User.id.in_(user_ids)).all()} if user_ids else {}

    items = []
    for row in page_rows:
        user = users_by_id.get(row.user_id)
        prompts = prompts_by_user.get(row.user_id, 0)
        responses = responses_by_user.get(row.user_id, 0)
        items.append(
            {
                "userId": row.user_id,
                "name": user.name if user else f"User #{row.user_id}",
                "email": user.email if user else None,
                "department": user.department if user else None,
                "avatar": user.avatar if user else None,
                "conversationsCount": row.conversation_count,
                "eventCount": row.event_count,
                "messagesCount": prompts + responses,
                "promptsCount": prompts,
                "responsesCount": responses,
                "imagesCount": images_by_user.get(row.user_id, 0),
                "filesCount": files_by_user.get(row.user_id, 0),
                "captureHealth": health_by_user.get(row.user_id, HEALTH_STATUS_HEALTHY),
                "lastActiveAt": serialize_utc_datetime(row.last_seen_at),
                "firstSeenAt": serialize_utc_datetime(row.first_seen_at),
                "hasUnresolvedConversations": unresolved_by_user.get(row.user_id, False),
            }
        )
    return items, total


def get_user_detail(db: Session, user_id: int) -> Optional[dict]:
    """Single-user version of list_users' aggregate, for the profile/header
    view - no pagination concerns, so this just does the full rollup directly.

    Fixed 2026-08-05 alongside list_users (see that function's own comment
    for the full reasoning): a conversation is now included here via the
    same attributed_user_id fallback - ConversationRecord.owner_user_id
    when ownership_status is resolved, else the raw
    ConversationCaptureEvent.user_id - instead of requiring resolved
    ownership outright. Without this, a user who now appears in list_users()
    thanks to that same fallback would click through to an empty/broken
    profile here (0 conversations, 0 messages) since this function still
    demanded full resolution."""
    user = db.query(User).filter(User.id == user_id).first()
    if not user:
        return None

    is_resolved = ConversationRecord.ownership_status == OWNERSHIP_STATUS_RESOLVED
    attributed_user_id = func.coalesce(
        case((is_resolved, ConversationRecord.owner_user_id), else_=None),
        ConversationCaptureEvent.user_id,
    )

    event_rows = (
        db.query(
            ConversationCaptureEvent.provider_conversation_id,
            ConversationCaptureEvent.event_type,
            ConversationCaptureEvent.created_at,
            is_resolved,
        )
        .outerjoin(
            ConversationRecord,
            and_(
                ConversationRecord.provider == PROVIDER,
                ConversationRecord.provider_conversation_id == ConversationCaptureEvent.provider_conversation_id,
            ),
        )
        .filter(
            ConversationCaptureEvent.provider == PROVIDER,
            ConversationCaptureEvent.provider_conversation_id.isnot(None),
            attributed_user_id == user_id,
        )
        .all()
    )

    conv_map: dict[str, dict[str, int]] = {}
    last_active_at = None
    has_unresolved = False
    for conversation_id, event_type, created_at, resolved in event_rows:
        if not resolved:
            has_unresolved = True
        if last_active_at is None or created_at >= last_active_at:
            last_active_at = created_at
        bucket = conv_map.setdefault(conversation_id, {"prompts": 0, "responses": 0})
        if event_type == EVENT_TYPE_PROMPT_CAPTURED:
            bucket["prompts"] += 1
        elif event_type == EVENT_TYPE_RESPONSE_COMPLETED:
            bucket["responses"] += 1

    owned_conversation_ids = set(conv_map.keys())
    prompts_total = sum(c["prompts"] for c in conv_map.values())
    responses_total = sum(c["responses"] for c in conv_map.values())
    statuses = [_classify_conversation_health(c["prompts"], c["responses"]) for c in conv_map.values()]
    images_count, files_count = _count_real_attachments(db, conversation_ids=owned_conversation_ids)

    return {
        "userId": user.id,
        "name": user.name,
        "email": user.email,
        "department": user.department,
        "avatar": user.avatar,
        "conversationsCount": len(conv_map),
        "messagesCount": prompts_total + responses_total,
        "promptsCount": prompts_total,
        "responsesCount": responses_total,
        "imagesCount": images_count,
        "filesCount": files_count,
        "captureHealth": _classify_overall_health(statuses) if statuses else HEALTH_STATUS_HEALTHY,
        "lastActiveAt": serialize_utc_datetime(last_active_at),
        "hasUnresolvedConversations": has_unresolved,
    }


_ENTITY_MARKER_START = chr(0xE200)
_ENTITY_MARKER_END = chr(0xE201)
_ENTITY_MARKER_RE = re.compile(re.escape(_ENTITY_MARKER_START) + ".*?" + re.escape(_ENTITY_MARKER_END), re.DOTALL)


def _strip_entity_markers(text: str) -> str:
    """Mirrors chatgptCaptureUtils.sanitizeResponseText on the frontend - strips
    ChatGPT's inline citation/entity marker spans (delimited by two Unicode
    Private-Use-Area code points) before the text is truncated into a preview.
    Must run *before* truncation: cutting a raw response at a fixed character
    length can slice through a marker span before its closing delimiter,
    leaving a dangling start marker with no closing marker for the frontend
    sanitizer to match against - so the raw control char and literal payload
    (e.g. entity["politician","Yogi Adityanath",...]) would otherwise leak
    straight into the conversation card preview."""
    text = _ENTITY_MARKER_RE.sub("", text)
    start_index = text.find(_ENTITY_MARKER_START)
    if start_index != -1:
        text = text[:start_index]
    return re.sub(r" {2,}", " ", text).strip()


def _truncate_preview(text: Optional[str], max_length: int = 140) -> Optional[str]:
    if not text:
        return None
    text = _strip_entity_markers(text.strip())
    if not text:
        return None
    if len(text) <= max_length:
        return text
    return text[:max_length].rstrip() + "…"


def _classify_conversation_health(prompts: int, responses: int) -> str:
    """Per-conversation capture health is a simpler question than per-install
    health (health.py answers "is the extension's queue healthy right now",
    not "did this specific conversation capture cleanly") - "degraded" means
    exactly the gap this feature exists to surface: prompts were sent but no
    response was ever captured for them."""
    if prompts > 0 and responses == 0:
        return "degraded"
    return "healthy"


def _count_by_event_type(db: Session, event_type: str) -> int:
    return (
        db.query(func.count(ConversationCaptureEvent.id))
        .filter(ConversationCaptureEvent.provider == PROVIDER, ConversationCaptureEvent.event_type == event_type)
        .scalar()
        or 0
    )


def _classify_overall_health(statuses: list[str]) -> str:
    if not statuses:
        return HEALTH_STATUS_OFFLINE
    for status in _HEALTH_STATUS_PRIORITY:
        if status in statuses:
            return status
    return HEALTH_STATUS_HEALTHY


def _count_real_attachments(
    db: Session,
    *,
    conversation_id: Optional[str] = None,
    user_id: Optional[int] = None,
    conversation_ids: Optional[set[str]] = None,
) -> tuple[int, int]:
    """Real, previewable files (see attachments.py/ConversationCaptureAttachment)
    - what the gallery actually renders. Deliberately NOT the same as counting
    prompt_captured.payload's images/files arrays: those are a filename-only
    signal the network layer observes (extractPromptFromRequestJson), which
    can be non-zero even when nothing was ever uploaded (the DOM capture path
    that produces real files is a separate, best-effort mechanism - see
    content-chatgpt-attachment-capture.js). An earlier version of this
    function counted the metadata-only signal, which produced a real,
    reported bug: the dashboard showed "Images: 2" while the gallery showed
    nothing and the selected conversation showed "Images: 0", because the two
    numbers came from entirely different sources of truth. Counting the same
    table the gallery reads from keeps every number in the UI consistent with
    what's actually visible."""
    query = db.query(ConversationCaptureAttachment.mime_type).filter(
        ConversationCaptureAttachment.provider == PROVIDER
    )
    if conversation_id is not None:
        query = query.filter(ConversationCaptureAttachment.provider_conversation_id == conversation_id)
    if conversation_ids is not None:
        if not conversation_ids:
            return 0, 0
        query = query.filter(ConversationCaptureAttachment.provider_conversation_id.in_(conversation_ids))
    if user_id is not None:
        query = query.filter(ConversationCaptureAttachment.user_id == user_id)

    images = 0
    files = 0
    for (mime_type,) in query.all():
        if (mime_type or "").startswith("image/"):
            images += 1
        else:
            files += 1

    # Generated/response media assets (ConversationMediaAsset) count toward
    # "images" too - same "count the same rows the gallery renders" rule as
    # this function's docstring: only url-bearing (stored) rows, so the header
    # number always matches the gallery. Video assets are counted as images
    # here for now (the header has no separate "videos" field yet); revisit
    # when video capture actually lands.
    media_query = db.query(func.count(ConversationMediaAsset.id)).filter(
        ConversationMediaAsset.provider == PROVIDER,
        ConversationMediaAsset.url.isnot(None),
    )
    if conversation_id is not None:
        media_query = media_query.filter(ConversationMediaAsset.provider_conversation_id == conversation_id)
    if user_id is not None:
        media_query = media_query.filter(ConversationMediaAsset.user_id == user_id)
    images += int(media_query.scalar() or 0)

    return images, files


def get_metrics(db: Session) -> dict:
    total_events = (
        db.query(func.count(ConversationCaptureEvent.id)).filter(ConversationCaptureEvent.provider == PROVIDER).scalar() or 0
    )
    conversations_captured = (
        db.query(func.count(func.distinct(ConversationCaptureEvent.provider_conversation_id)))
        .filter(ConversationCaptureEvent.provider == PROVIDER, ConversationCaptureEvent.provider_conversation_id.isnot(None))
        .scalar()
        or 0
    )
    users_captured = (
        db.query(func.count(func.distinct(ConversationCaptureEvent.user_id)))
        .filter(ConversationCaptureEvent.provider == PROVIDER)
        .scalar()
        or 0
    )
    prompts_captured = _count_by_event_type(db, EVENT_TYPE_PROMPT_CAPTURED)
    responses_captured = _count_by_event_type(db, EVENT_TYPE_RESPONSE_COMPLETED)
    # Real, previewable files only - see _count_real_attachments for why this
    # is not the same as counting prompt_captured.payload's images/files
    # arrays (a filename-only signal that can be non-zero with nothing
    # actually stored).
    images_captured, files_captured = _count_real_attachments(db)
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

    # "Extension" facts for the diagnostics panel - most recently reported
    # install wins ties, since that's the one someone debugging right now
    # actually cares about.
    latest_health = max(health_rows, key=lambda record: record.reported_at or datetime.min, default=None)
    latest_extension_version = latest_health.extension_version if latest_health else None
    if not latest_extension_version:
        # No health ping yet (enableHealth may be off) - fall back to
        # whatever the most recent capture event itself reported.
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
        "imagesCaptured": images_captured,
        "filesCaptured": files_captured,
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
            # Trivially true if this response was served at all - included
            # because the redesigned Diagnostics panel calls for it, not
            # because either field carries independent diagnostic signal.
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
        # The extension never relays client-side JSON-parse failures to the
        # backend today (content-chatgpt-network.js tracks parseFailureCount
        # in-memory, per-tab, with no message channel to the background
        # worker for it) - surfaced as null rather than a fabricated number.
        # See Implementation Report for the follow-up needed to wire this.
        "parseFailures": None,
    }


def _conversation_events(db: Session, conversation_id: str) -> list[ConversationCaptureEvent]:
    return (
        db.query(ConversationCaptureEvent)
        .filter(
            ConversationCaptureEvent.provider == PROVIDER,
            ConversationCaptureEvent.provider_conversation_id == conversation_id,
        )
        .order_by(ConversationCaptureEvent.created_at.asc(), ConversationCaptureEvent.id.asc())
        .all()
    )


def get_conversation_detail(db: Session, conversation_id: str) -> Optional[dict]:
    """Normalized conversation metadata - the header card the UI needs
    (title/owner/model/created/last activity/message counts/capture health),
    aggregated from the raw event log rather than a stored ConversationRecord
    (Phase 3 still owns that table; this is a read-time reconstruction)."""
    events = _conversation_events(db, conversation_id)
    if not events:
        return None

    title = None
    model = None
    prompts = 0
    responses = 0
    owner_user_id = None
    latest_health_signal_at = None

    for event in events:
        payload = event.payload_json or {}
        owner_user_id = owner_user_id or event.user_id
        if event.event_type == EVENT_TYPE_CONVERSATION_RENAMED:
            new_title = payload.get("newTitle") or payload.get("new_title")
            if new_title:
                title = new_title
        elif event.event_type == EVENT_TYPE_PROMPT_CAPTURED:
            prompts += 1
        elif event.event_type == EVENT_TYPE_RESPONSE_COMPLETED:
            responses += 1
            model = payload.get("model") or model
        elif event.event_type == EVENT_TYPE_RESPONSE_STARTED:
            model = payload.get("model") or model
        latest_health_signal_at = event.created_at

    # Real, previewable files only - see _count_real_attachments. Keeps this
    # header card's numbers consistent with what the gallery actually shows,
    # instead of a filename-only signal that can report attachments that
    # were never actually captured.
    images, files = _count_real_attachments(db, conversation_id=conversation_id)

    owner = db.query(User).filter(User.id == owner_user_id).first() if owner_user_id else None

    return {
        "conversationId": conversation_id,
        "title": title,
        "model": model,
        "ownerUserId": owner_user_id,
        "ownerName": owner.name if owner else None,
        "provider": PROVIDER,
        "createdAt": serialize_utc_datetime(events[0].created_at),
        "lastActivityAt": serialize_utc_datetime(events[-1].created_at),
        "messageCount": prompts + responses,
        "promptsCount": prompts,
        "responsesCount": responses,
        "imagesCount": images,
        "filesCount": files,
        "eventCount": len(events),
        "captureHealth": _classify_conversation_health(prompts, responses),
    }


def _list_conversation_messages_from_normalized(db: Session, record: ConversationRecord, *, limit: int) -> dict:
    """Phase 3 read path: builds the identical wire shape the raw-event
    reconstruction below produces, from ConversationPrompt/ConversationResponse
    rows instead - so ConversationChatView.jsx needs zero awareness of which
    path served it. Used once a conversation has been normalized (see
    normalization.py); conversations captured before normalization existed
    fall through to the raw-event path."""
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

    entries: list[tuple[datetime, dict]] = []
    for prompt in prompts:
        timestamp = prompt.prompt_timestamp or prompt.created_at
        entries.append((timestamp, {
            "id": f"prompt-{prompt.source_capture_event_id}" if prompt.source_capture_event_id else f"prompt-db-{prompt.id}",
            "role": "user",
            "text": prompt.prompt_text or "",
            "timestamp": serialize_utc_datetime(timestamp),
            "edited": False,
            "pending": False,
            "attachments": _build_attachment_list({
                "images": prompt.images_json or [],
                "files": prompt.files_json or [],
                "attachments": prompt.attachments_json or [],
            }),
            "contentParts": prompt.content_parts_json,
            "sourceEventIds": [prompt.source_capture_event_id] if prompt.source_capture_event_id else [],
        }))
    for response in responses:
        timestamp = response.response_timestamp or response.created_at
        entries.append((timestamp, {
            "id": f"response-{response.source_capture_event_id}" if response.source_capture_event_id else f"response-db-{response.id}",
            "role": "assistant",
            "text": response.response_text or "",
            "model": None,
            "timestamp": serialize_utc_datetime(timestamp),
            "edited": False,
            "pending": False,
            "hasMarkdown": bool(response.has_markdown),
            "codeBlocks": response.code_blocks_json or [],
            "contentParts": response.content_parts_json,
            "citations": response.citations_json,
            "attachments": [],
            "sourceEventIds": [response.source_capture_event_id] if response.source_capture_event_id else [],
            # The real ChatGPT-assigned message id (not the synthetic "id"
            # above) - lets the frontend match a ConversationMediaAsset to
            # the exact turn that generated it (asset.assistantMessageId ==
            # this) instead of guessing by nearest timestamp, which merges
            # two turns' images together when they land close in time (see
            # mediaHelpers.buildGenerations).
            "providerMessageId": response.provider_message_id,
        }))

    entries.sort(key=lambda item: item[0] or datetime.min)
    messages = [entry[1] for entry in entries[:limit]]

    return {
        "conversationId": record.provider_conversation_id,
        "messages": messages,
        "truncated": len(entries) > limit,
        "totalEvents": len(entries),
    }


def list_conversation_messages(db: Session, conversation_id: str, *, limit: int = 200) -> Optional[dict]:
    """Normalized chat messages for one conversation - the API this feature's
    UI actually wants (role/text/timestamp/attachments), not raw events.

    Prefers Phase 3 normalized rows (ConversationPrompt/ConversationResponse)
    when they exist for this conversation. Falls back to a best-effort
    chronological reconstruction directly from the raw event log (same
    heuristic previously implemented client-side, see
    chatgptCaptureUtils.buildConversationTurns) for conversations captured
    before normalization existed - a response_started/response_completed pair
    is treated as the answer to whatever prompt_captured most recently
    preceded it, since conversations are turn-based and events are already
    chronological.
    """
    record = (
        db.query(ConversationRecord)
        .filter(ConversationRecord.provider == PROVIDER, ConversationRecord.provider_conversation_id == conversation_id)
        .first()
    )
    if record and (record.prompt_count or record.response_count):
        return _list_conversation_messages_from_normalized(db, record, limit=limit)

    events = _conversation_events(db, conversation_id)
    if not events:
        return None

    messages: list[dict] = []
    open_assistant_message: Optional[dict] = None

    for event in events[:limit]:
        if event.event_type not in _CHAT_MESSAGE_EVENT_TYPES:
            continue
        payload = event.payload_json or {}

        if event.event_type == EVENT_TYPE_PROMPT_CAPTURED:
            open_assistant_message = None
            messages.append({
                "id": f"prompt-{event.id}",
                "role": "user",
                "text": payload.get("text") or "",
                "timestamp": serialize_utc_datetime(event.created_at),
                "edited": False,
                "pending": False,
                "attachments": _build_attachment_list(payload),
                "sourceEventIds": [event.id],
            })
        elif event.event_type == EVENT_TYPE_MESSAGE_EDITED:
            open_assistant_message = None
            messages.append({
                "id": f"edit-{event.id}",
                "role": "user",
                "text": payload.get("newText") or "",
                "timestamp": serialize_utc_datetime(event.created_at),
                "edited": True,
                "pending": False,
                "attachments": [],
                "sourceEventIds": [event.id],
            })
        elif event.event_type == EVENT_TYPE_RESPONSE_STARTED:
            message = {
                "id": f"response-{event.id}",
                "role": "assistant",
                "text": "",
                "model": payload.get("model"),
                "timestamp": serialize_utc_datetime(event.created_at),
                "edited": False,
                "pending": True,
                "attachments": [],
                "sourceEventIds": [event.id],
                # See providerMessageId comment in
                # _list_conversation_messages_from_normalized - same purpose,
                # raw-event reconstruction path.
                "providerMessageId": event.provider_message_id,
            }
            messages.append(message)
            open_assistant_message = message
        elif event.event_type == EVENT_TYPE_RESPONSE_COMPLETED:
            if open_assistant_message is not None:
                open_assistant_message["text"] = payload.get("text") or ""
                open_assistant_message["pending"] = False
                open_assistant_message["model"] = payload.get("model") or open_assistant_message.get("model")
                open_assistant_message["hasMarkdown"] = bool(payload.get("hasMarkdown"))
                open_assistant_message["codeBlocks"] = payload.get("codeBlocks") or []
                open_assistant_message["contentParts"] = payload.get("contentParts")
                open_assistant_message["citations"] = payload.get("citations")
                open_assistant_message["timestamp"] = serialize_utc_datetime(event.created_at)
                open_assistant_message["sourceEventIds"].append(event.id)
                open_assistant_message["providerMessageId"] = event.provider_message_id or open_assistant_message.get("providerMessageId")
            else:
                # response_completed with no matching response_started in this
                # window - still surface the real captured answer.
                messages.append({
                    "id": f"response-{event.id}",
                    "role": "assistant",
                    "text": payload.get("text") or "",
                    "model": payload.get("model"),
                    "timestamp": serialize_utc_datetime(event.created_at),
                    "edited": False,
                    "pending": False,
                    "hasMarkdown": bool(payload.get("hasMarkdown")),
                    "codeBlocks": payload.get("codeBlocks") or [],
                    "contentParts": payload.get("contentParts"),
                    "citations": payload.get("citations"),
                    "attachments": [],
                    "sourceEventIds": [event.id],
                    "providerMessageId": event.provider_message_id,
                })
            open_assistant_message = None
        elif event.event_type == EVENT_TYPE_FILE_UPLOAD_DETECTED:
            file_name = payload.get("fileName") or "File"
            mime_type = payload.get("mimeType")
            messages.append({
                "id": f"file-{event.id}",
                "role": "system",
                "text": f"{file_name} attached" + (f" ({mime_type})" if mime_type else ""),
                "timestamp": serialize_utc_datetime(event.created_at),
                "edited": False,
                "pending": False,
                "attachments": [],
                "sourceEventIds": [event.id],
            })

    return {
        "conversationId": conversation_id,
        "messages": messages,
        "truncated": len(events) > limit,
        "totalEvents": len(events),
    }


def _build_attachment_list(payload: dict) -> list[dict]:
    attachments = []
    for index, item in enumerate(payload.get("images") or []):
        attachments.append({"kind": "image", "label": (item or {}).get("name") or f"Image {index + 1}"})
    for index, item in enumerate(payload.get("files") or []):
        attachments.append({"kind": "file", "label": (item or {}).get("name") or f"File {index + 1}"})
    for index, item in enumerate(payload.get("attachments") or []):
        attachments.append({"kind": "attachment", "label": (item or {}).get("name") or f"Attachment {index + 1}"})
    return attachments


def list_conversation_attachments(db: Session, conversation_id: str) -> list[dict]:
    """Real stored files (see attachments.py) for one conversation, newest
    first. Separate from the {kind, label} placeholders embedded in a
    prompt_captured event's payload - those come from the network layer and
    only ever carry a filename; this is the actual uploaded bytes, captured
    via DOM file-input/drop interception and stored in R2."""
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


def list_conversation_media(db: Session, conversation_id: str) -> list[dict]:
    """Generated/response media assets (see media.py -> ConversationMediaAsset)
    for one conversation, in display order. Only rows that actually have a
    stored R2 url are returned - a 'pending' row (no bytes yet, or a source
    the server couldn't fetch) has nothing renderable, so it would only show
    as a broken thumbnail in the gallery. The row's `url` is the raw
    (private) R2 url; the dashboard renders it through /api/files/open?url=,
    which extracts the key and issues a short-lived signed redirect."""
    records = (
        db.query(ConversationMediaAsset)
        .filter(
            ConversationMediaAsset.provider == PROVIDER,
            ConversationMediaAsset.provider_conversation_id == conversation_id,
            ConversationMediaAsset.url.isnot(None),
        )
        .order_by(
            ConversationMediaAsset.display_order.asc().nullslast(),
            ConversationMediaAsset.created_at.asc(),
        )
        .all()
    )
    return [record.to_dict() for record in records]
