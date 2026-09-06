# providers/claude/normalization.py
"""
Normalizes raw ConversationCaptureEvent rows (provider="claude") into
ConversationRecord / ConversationPrompt / ConversationResponse - the same
shared, structured tables providers/chatgpt/normalization.py writes to under
provider="chatgpt" (see providers/claude/__init__.py).

Substantially simpler than providers/chatgpt/normalization.py, because the
extension's source data is different in kind, not just detail: every Claude
capture event is built from GET .../chat_conversations/{id}?tree=True's full,
authoritative message tree (see CAPTURE_CONTRACT.md) - there is no streamed/
partial reconstruction to fall back from, and both provider_conversation_id
and payload.parentMessageId are ALWAYS known (Claude assigns a conversation
uuid client-side before the first message is ever sent, and every message
object in the tree carries its own parent_message_uuid). That eliminates two
entire classes of complexity providers/chatgpt/normalization.py has to carry:

- No orphan reconciliation (_reconcile_orphaned_prompt/_renumber_by_timestamp
  in the ChatGPT module): a Claude prompt_captured event is never missing its
  conversation id, so there is nothing to backfill later.
- No "most recently created prompt" pairing fallback
  (_find_matching_prompt's second branch): payload.parentMessageId always
  resolves to a real ConversationPrompt.provider_message_id already captured
  moments earlier - content-claude-capture.js walks a snapshot's
  chat_messages in tree (index) order and sends one event per message in
  that same order, so within a single capture batch a prompt is always
  built (and, in normalize_capture_events_batch below, normalized) before
  the response that replies to it. A tiny fallback still exists in
  _upsert_response below for the one case that ordering can't cover - a
  response replayed via backfill_all before its own prompt's event exists
  in the table at all yet.

Invoked from router.py after a raw event is successfully ingested, wrapped so
a normalization failure never affects the raw-capture HTTP response - raw
capture (ConversationCaptureEvent) is the lossless source of truth this reads
from, and any event can always be reprocessed later (see backfill_all).
"""
import logging
from datetime import datetime, timedelta
from typing import Optional

from sqlalchemy import func
from sqlalchemy.orm import Session

from providers.chatgpt.models import (
    ConversationCaptureEvent,
    ConversationPrompt,
    ConversationRecord,
    ConversationResponse,
)
from providers.claude.constants import (
    EVENT_TYPE_CONVERSATION_CREATED,
    EVENT_TYPE_CONVERSATION_OPENED,
    EVENT_TYPE_CONVERSATION_RENAMED,
    EVENT_TYPE_PROMPT_CAPTURED,
    EVENT_TYPE_RESPONSE_COMPLETED,
    INGESTION_SOURCE_CAPTURED,
    OWNERSHIP_STATUS_RESOLVED,
    OWNERSHIP_STATUS_UNKNOWN,
    PROVIDER,
)

logger = logging.getLogger("claude_normalization")

# How recently a conversation's own provider-reported created_at must be,
# relative to when this backend first captured it, to trust that it started
# with the current sender rather than being an existing conversation someone
# else already used (same bug class as providers/chatgpt/normalization.py's
# _is_attributable - see that function's docstring). Claude gives us a real
# server timestamp for this instead of ChatGPT's client-inferred
# isNewConversation flag, so the check is a plain age comparison.
NEW_CONVERSATION_AGE_THRESHOLD_SECONDS = 5 * 60


def _parse_iso_datetime(value: Optional[str]) -> Optional[datetime]:
    if not value:
        return None
    try:
        return datetime.fromisoformat(f"{value}".replace("Z", "+00:00")).replace(tzinfo=None)
    except (TypeError, ValueError):
        return None


def _is_attributable(event: ConversationCaptureEvent) -> bool:
    payload = event.payload_json or {}
    if "isNewConversation" in payload:
        return bool(payload.get("isNewConversation"))
    provider_created_at = _parse_iso_datetime(payload.get("providerCreatedAt"))
    if not provider_created_at:
        return False
    age = (event.created_at or datetime.utcnow()) - provider_created_at
    return timedelta(0) <= age <= timedelta(seconds=NEW_CONVERSATION_AGE_THRESHOLD_SECONDS)


def _get_or_create_conversation_record(db: Session, event: ConversationCaptureEvent) -> ConversationRecord:
    record = (
        db.query(ConversationRecord)
        .filter(
            ConversationRecord.provider == PROVIDER,
            ConversationRecord.provider_conversation_id == event.provider_conversation_id,
        )
        .first()
    )
    if record:
        return record

    record = ConversationRecord(
        provider=PROVIDER,
        provider_conversation_id=event.provider_conversation_id,
        ingestion_source=INGESTION_SOURCE_CAPTURED,
    )
    if _is_attributable(event):
        record.owner_user_id = event.user_id
        record.ownership_status = OWNERSHIP_STATUS_RESOLVED
        record.ownership_source = "capture_event_user"
    else:
        # Lands unclaimed by design - a pre-existing conversation surfacing
        # for the first time (e.g. this backend was only just deployed, or
        # the extension only just got installed on this machine) should
        # never be silently attributed to whoever's session happened to
        # touch it first. See providers/chatgpt/normalization.py's identical
        # branch.
        record.ownership_status = OWNERSHIP_STATUS_UNKNOWN
    db.add(record)
    db.flush()
    return record


def _next_prompt_sequence(db: Session, record: ConversationRecord) -> int:
    max_index = (
        db.query(func.max(ConversationPrompt.sequence_index))
        .filter(ConversationPrompt.conversation_id == record.id)
        .scalar()
    )
    return (max_index or 0) + 1


def _next_response_sequence(db: Session, record: ConversationRecord) -> int:
    max_index = (
        db.query(func.max(ConversationResponse.sequence_index))
        .filter(ConversationResponse.conversation_id == record.id)
        .scalar()
    )
    return (max_index or 0) + 1


def _find_prompt_by_message_id(db: Session, record: ConversationRecord, message_id: Optional[str]) -> Optional[ConversationPrompt]:
    if not message_id:
        return None
    return (
        db.query(ConversationPrompt)
        .filter(ConversationPrompt.conversation_id == record.id, ConversationPrompt.provider_message_id == message_id)
        .first()
    )


def _upsert_prompt(db: Session, record: ConversationRecord, event: ConversationCaptureEvent) -> ConversationPrompt:
    payload = event.payload_json or {}
    prompt = _find_prompt_by_message_id(db, record, event.provider_message_id)
    if prompt is None:
        prompt = (
            db.query(ConversationPrompt)
            .filter(ConversationPrompt.conversation_id == record.id, ConversationPrompt.source_capture_event_id == event.id)
            .first()
        )
    if prompt is None:
        prompt = ConversationPrompt(conversation_id=record.id, sequence_index=_next_prompt_sequence(db, record))
        db.add(prompt)

    text = payload.get("text") or ""
    prompt.source_capture_event_id = event.id
    if event.provider_message_id:
        prompt.provider_message_id = event.provider_message_id
    prompt.prompt_text = text
    prompt.prompt_length = len(text)
    prompt.attachments_json = payload.get("attachments") or None
    prompt.files_json = payload.get("files") or None
    prompt.code_blocks_json = payload.get("codeBlocks") or None
    prompt.content_parts_json = payload.get("contentParts") or None
    prompt.prompt_timestamp = _parse_iso_datetime(payload.get("promptTimestamp")) or event.created_at
    db.flush()
    return prompt


def _upsert_response(db: Session, record: ConversationRecord, event: ConversationCaptureEvent) -> ConversationResponse:
    payload = event.payload_json or {}
    response = None
    if event.provider_message_id:
        response = (
            db.query(ConversationResponse)
            .filter(ConversationResponse.conversation_id == record.id, ConversationResponse.provider_message_id == event.provider_message_id)
            .first()
        )
    if response is None:
        response = (
            db.query(ConversationResponse)
            .filter(ConversationResponse.conversation_id == record.id, ConversationResponse.source_capture_event_id == event.id)
            .first()
        )
    if response is None:
        response = ConversationResponse(conversation_id=record.id, sequence_index=_next_response_sequence(db, record))
        db.add(response)

    text = payload.get("text") or ""
    response.source_capture_event_id = event.id
    if event.provider_message_id:
        response.provider_message_id = event.provider_message_id
    response.response_text = text
    response.response_length = len(text)
    response.code_blocks_json = payload.get("codeBlocks") or None
    response.has_markdown = bool(payload.get("hasMarkdown"))
    response.has_tables = bool(payload.get("hasTables"))
    response.content_parts_json = payload.get("contentParts") or None
    response.citations_json = payload.get("citations") or None
    response.response_status = "completed"
    response.response_timestamp = _parse_iso_datetime(payload.get("completedAt")) or event.created_at

    if response.prompt_id is None:
        parent_message_id = payload.get("parentMessageId")
        matching_prompt = _find_prompt_by_message_id(db, record, parent_message_id)
        if matching_prompt is None:
            # Extremely rare fallback (a response whose own parent prompt was
            # somehow never captured - e.g. this event was replayed via
            # backfill_all before the prompt's own event existed yet): most
            # recently created prompt for this conversation, matching
            # providers/chatgpt/normalization.py's _find_matching_prompt
            # fallback. Unlike ChatGPT this is not the primary path - Claude
            # always supplies parentMessageId - so it is not expected to ever
            # actually fire in steady state.
            matching_prompt = (
                db.query(ConversationPrompt)
                .filter(ConversationPrompt.conversation_id == record.id)
                .order_by(ConversationPrompt.sequence_index.desc(), ConversationPrompt.id.desc())
                .first()
            )
        if matching_prompt:
            response.prompt_id = matching_prompt.id

    db.flush()
    return response


def _handle_conversation_renamed(db: Session, record: ConversationRecord, event: ConversationCaptureEvent) -> None:
    payload = event.payload_json or {}
    new_title = payload.get("newTitle")
    if new_title:
        record.title = new_title
    db.flush()


def _handle_conversation_snapshot_metadata(db: Session, record: ConversationRecord, event: ConversationCaptureEvent) -> None:
    """conversation_created/conversation_opened both carry the same header
    fields read straight off Claude's own conversation object (see
    content-claude-capture.js) - title/model/url refresh on every
    observation (cheap, idempotent, and the only way a title changed outside
    this browser - e.g. Claude's own auto-titling completing after the first
    turn - ever reaches conversation_renamed-less installs), while
    provider_created_time is set once (a conversation's creation moment
    never changes)."""
    payload = event.payload_json or {}
    if payload.get("title"):
        record.title = payload["title"]
    if payload.get("model"):
        record.model_label = payload["model"]
    if payload.get("url"):
        record.conversation_url = payload["url"]
    provider_created_at = _parse_iso_datetime(payload.get("providerCreatedAt"))
    if provider_created_at and not record.provider_created_time:
        record.provider_created_time = provider_created_at
    provider_updated_at = _parse_iso_datetime(payload.get("providerUpdatedAt"))
    if provider_updated_at:
        record.provider_updated_time = provider_updated_at
    db.flush()


def _resync_conversation_counts(db: Session, record: ConversationRecord) -> None:
    record.prompt_count = db.query(ConversationPrompt).filter(ConversationPrompt.conversation_id == record.id).count()
    record.response_count = db.query(ConversationResponse).filter(ConversationResponse.conversation_id == record.id).count()


_EVENT_HANDLERS = {
    EVENT_TYPE_PROMPT_CAPTURED: lambda db, record, event: _upsert_prompt(db, record, event),
    EVENT_TYPE_RESPONSE_COMPLETED: lambda db, record, event: _upsert_response(db, record, event),
    EVENT_TYPE_CONVERSATION_RENAMED: _handle_conversation_renamed,
    EVENT_TYPE_CONVERSATION_CREATED: _handle_conversation_snapshot_metadata,
    EVENT_TYPE_CONVERSATION_OPENED: _handle_conversation_snapshot_metadata,
}


def normalize_capture_event(db: Session, event: ConversationCaptureEvent) -> Optional[ConversationRecord]:
    """Normalizes ONE event: flushes its changes (never commits - see
    normalize_capture_events_batch, which every caller should go through
    instead of calling this directly). A no-op for event types with no
    normalized representation at all (conversation_deleted) - the raw event
    remains the source of truth for those."""
    if not event.provider_conversation_id:
        # Should not happen for Claude (see this module's docstring) - every
        # capture event the extension builds already knows the conversation
        # uuid. Guarded anyway for defense-in-depth / a malformed replay.
        return None
    handler = _EVENT_HANDLERS.get(event.event_type)
    if handler is None:
        return None
    record = _get_or_create_conversation_record(db, event)
    handler(db, record, event)
    return record


def _find_unnormalized_message_events(db: Session, events: list) -> list:
    """Of the given events, the message-bearing ones (prompt_captured/
    response_completed) that have NO corresponding ConversationPrompt/
    ConversationResponse row - i.e. events whose normalization silently did
    not stick.

    This exists because that failure is otherwise invisible AND permanent.
    Raw capture is lossless and idempotent: a re-uploaded event is deduped to
    "duplicate" by capture.py, and router.py only ever normalizes events whose
    ingest returned "created" - so nothing was ever going to revisit an event
    that got ingested but never normalized. It stayed a standing gap in the
    dashboard until someone ran scripts/backfill_claude_normalization.py by
    hand.

    Observed live (2026-09-06): a conversation whose prompt_captured event was
    ingested and stored correctly - full text, and a files[] entry whose uuid
    matched an already-uploaded image attachment - never produced its
    ConversationPrompt row. The conversation showed promptCount 0 with the
    user's message and its image missing entirely, while the assistant
    response from the very same batch normalized fine. Replaying that exact
    batch through this module afterwards reproduced nothing: it normalized
    cleanly. So rather than guess at the trigger, verify the outcome."""
    missing = []
    for event in events:
        if event.event_type not in (EVENT_TYPE_PROMPT_CAPTURED, EVENT_TYPE_RESPONSE_COMPLETED):
            continue
        if not event.provider_conversation_id or not event.provider_message_id:
            continue
        record = (
            db.query(ConversationRecord)
            .filter(
                ConversationRecord.provider == PROVIDER,
                ConversationRecord.provider_conversation_id == event.provider_conversation_id,
            )
            .first()
        )
        if record is None:
            missing.append(event)
            continue
        model = ConversationPrompt if event.event_type == EVENT_TYPE_PROMPT_CAPTURED else ConversationResponse
        exists = (
            db.query(model.id)
            .filter(model.conversation_id == record.id, model.provider_message_id == event.provider_message_id)
            .first()
        )
        if exists is None:
            missing.append(event)
    return missing


def _normalize_events_once(db: Session, events: list) -> tuple[dict, int]:
    """One pass: each event in its own SAVEPOINT (so one bad event only
    discards its own changes), then a single commit for the whole batch."""
    touched_records: dict[int, ConversationRecord] = {}
    errors = 0
    for event in events:
        try:
            with db.begin_nested():
                record = normalize_capture_event(db, event)
            if record is not None:
                touched_records[record.id] = record
        except Exception:
            logger.exception("claude normalization failed for event_id=%s", event.id)
            errors += 1
            continue
    for record in touched_records.values():
        _resync_conversation_counts(db, record)
    db.commit()
    return touched_records, errors


def normalize_capture_events_batch(db: Session, events: list) -> dict:
    """Normalizes many events against ONE commit, not one per event - same
    connection-pool-exhaustion reasoning as
    providers/chatgpt/normalization.py's identical function.

    Then VERIFIES that every message-bearing event actually produced its row,
    and retries just the ones that did not - see
    _find_unnormalized_message_events for the incident that motivated this.
    The retry is bounded (one extra pass) and idempotent: every upsert here
    keys off (conversation, provider_message_id), so re-running an event that
    did land is a no-op, not a duplicate."""
    touched_records, errors = _normalize_events_once(db, events)

    unnormalized = _find_unnormalized_message_events(db, events)
    if unnormalized:
        logger.warning(
            "claude normalization left %d message event(s) without a normalized row - retrying: %s",
            len(unnormalized),
            [event.id for event in unnormalized],
        )
        retry_records, retry_errors = _normalize_events_once(db, unnormalized)
        touched_records.update(retry_records)
        errors += retry_errors
        still_missing = _find_unnormalized_message_events(db, unnormalized)
        if still_missing:
            # Deliberately loud: the raw events are still the lossless source
            # of truth and scripts/backfill_claude_normalization.py can replay
            # them, but nothing automatic will retry again after this.
            logger.error(
                "claude normalization STILL missing rows for event_id(s)=%s after retry - "
                "run scripts/backfill_claude_normalization.py",
                [event.id for event in still_missing],
            )

    return {"touchedConversations": len(touched_records), "errors": errors}


def backfill_all(db: Session, *, batch_size: int = 500) -> dict:
    """Replays every historical ConversationCaptureEvent (provider="claude",
    oldest-first) through the same idempotent normalizer the live path uses -
    safe to re-run any number of times. See
    providers/chatgpt/normalization.py's identical backfill_all."""
    stats = {"processed": 0, "normalized": 0, "skipped": 0, "errors": 0}
    last_id = 0
    while True:
        events = (
            db.query(ConversationCaptureEvent)
            .filter(ConversationCaptureEvent.provider == PROVIDER, ConversationCaptureEvent.id > last_id)
            .order_by(ConversationCaptureEvent.id.asc())
            .limit(batch_size)
            .all()
        )
        if not events:
            break
        last_id = events[-1].id
        stats["processed"] += len(events)
        eligible = [event for event in events if event.provider_conversation_id and event.event_type in _EVENT_HANDLERS]
        stats["skipped"] += len(events) - len(eligible)
        if eligible:
            batch_result = normalize_capture_events_batch(db, eligible)
            stats["errors"] += batch_result["errors"]
            stats["normalized"] += len(eligible) - batch_result["errors"]
    return stats
