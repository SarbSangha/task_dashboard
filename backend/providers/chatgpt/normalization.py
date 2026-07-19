# providers/chatgpt/normalization.py
"""
Phase 3: normalizes raw ConversationCaptureEvent rows into
ConversationRecord / ConversationPrompt / ConversationResponse /
ConversationGeneratedAsset - the structured, queryable representation the
Capture Center's UI actually wants. This is the step the schema in models.py
was always designed for (see README.md's Status table, which has carried
"Phase 3 | Normalization | Pending" since Phase 1 shipped) but that no code
ever implemented until now.

Deliberately NOT called from capture.py - see that module's own docstring:
"No parsing, no business logic... Normalization is a separate, later step
that reads from this table; it does not happen here." Invoked from
router.py instead, after a raw event is successfully ingested, wrapped so a
normalization failure never affects the raw-capture HTTP response - raw
capture (ConversationCaptureEvent) is the lossless source of truth this
reads from, and any event can always be reprocessed later (see backfill_all).

Idempotent by design: every upsert here keys off a unique/partial-unique
index that already exists on the target table (provider_message_id per
conversation for prompts/responses, provider+asset_id for generated assets),
so replaying the same event twice - or two events that turn out to describe
the same underlying message (e.g. the duplicate response_completed rows
produced by the double-finalize() bug fixed in content-chatgpt.js/
content-chatgpt-network.js) - updates one row rather than creating a second.
"""
import logging
from datetime import datetime
from typing import Optional

from sqlalchemy import func
from sqlalchemy.orm import Session

from providers.chatgpt.constants import (
    EVENT_TYPE_GENERATION_CAPTURED,
    EVENT_TYPE_MESSAGE_EDITED,
    EVENT_TYPE_PROMPT_CAPTURED,
    EVENT_TYPE_RESPONSE_COMPLETED,
    INGESTION_SOURCE_CAPTURED,
    OUTPUT_TYPES,
    OWNERSHIP_STATUS_RESOLVED,
    PROVIDER,
)
from providers.chatgpt.models import (
    ConversationCaptureAttachment,
    ConversationCaptureEvent,
    ConversationGeneratedAsset,
    ConversationPrompt,
    ConversationRecord,
    ConversationResponse,
)

logger = logging.getLogger("chatgpt_normalization")


def _parse_iso_datetime(value: Optional[str]) -> Optional[datetime]:
    if not value:
        return None
    try:
        return datetime.fromisoformat(f"{value}".replace("Z", "+00:00"))
    except (TypeError, ValueError):
        return None


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
        owner_user_id=event.user_id,
        ownership_status=OWNERSHIP_STATUS_RESOLVED,
        ownership_source="capture_event_user",
    )
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
    prompt.images_json = payload.get("images") or None
    prompt.files_json = payload.get("files") or None
    prompt.code_blocks_json = payload.get("codeBlocks") or None
    prompt.content_parts_json = payload.get("contentParts") or None
    if payload.get("sequenceIndex") is not None:
        prompt.sequence_index = payload["sequenceIndex"]
    prompt.prompt_timestamp = _parse_iso_datetime(payload.get("promptTimestamp")) or event.created_at
    db.flush()
    return prompt


def _handle_message_edited(db: Session, record: ConversationRecord, event: ConversationCaptureEvent) -> ConversationPrompt:
    """An edit modifies an existing prompt's text rather than adding a new
    turn - resolve the original prompt by whichever message id is known
    (the new one the edit produced, falling back to the one it replaced) and
    update it in place. Creates a bare prompt row only if neither is found
    (the original prompt predates normalization, or was never captured)."""
    payload = event.payload_json or {}
    new_message_id = payload.get("newMessageId") or event.provider_message_id
    original_message_id = payload.get("originalMessageId")

    prompt = _find_prompt_by_message_id(db, record, new_message_id) or _find_prompt_by_message_id(db, record, original_message_id)
    if prompt is None:
        prompt = ConversationPrompt(conversation_id=record.id, sequence_index=_next_prompt_sequence(db, record))
        db.add(prompt)

    text = payload.get("newText") or ""
    prompt.source_capture_event_id = event.id
    if new_message_id:
        prompt.provider_message_id = new_message_id
    prompt.prompt_text = text
    prompt.prompt_length = len(text)
    db.flush()
    return prompt


def _find_matching_prompt(db: Session, record: ConversationRecord, event: ConversationCaptureEvent) -> Optional[ConversationPrompt]:
    """Most recently created prompt for this conversation - mirrors the
    turn-pairing heuristic queries.py:list_conversation_messages already
    applies at read time (a response answers whatever prompt most recently
    preceded it, since conversations are turn-based and capture events are
    chronological)."""
    return (
        db.query(ConversationPrompt)
        .filter(ConversationPrompt.conversation_id == record.id)
        .order_by(ConversationPrompt.sequence_index.desc(), ConversationPrompt.id.desc())
        .first()
    )


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
        matching_prompt = _find_matching_prompt(db, record, event)
        if matching_prompt:
            response.prompt_id = matching_prompt.id

    db.flush()

    content_parts = response.content_parts_json or []
    for part in content_parts:
        if isinstance(part, dict) and part.get("type") == "image":
            _upsert_generated_asset_from_content_part(db, record, response, part)

    return response


def _upsert_generated_asset_from_content_part(
    db: Session, record: ConversationRecord, response: ConversationResponse, part: dict
) -> Optional[ConversationGeneratedAsset]:
    asset_pointer = part.get("assetPointer")
    if not asset_pointer:
        return None

    asset = (
        db.query(ConversationGeneratedAsset)
        .filter(ConversationGeneratedAsset.provider == PROVIDER, ConversationGeneratedAsset.provider_asset_id == asset_pointer)
        .first()
    )
    file_id = f"{asset_pointer}".replace("file-service://", "").strip()
    # The extension uploads output attachments with file_name == the file id
    # (see content-chatgpt.js's resolveAndUploadImagePart) - same
    # filename-correlation heuristic the frontend already applies client-side
    # (matchStoredAttachments), done once here server-side instead.
    attachment = (
        db.query(ConversationCaptureAttachment)
        .filter(
            ConversationCaptureAttachment.provider == PROVIDER,
            ConversationCaptureAttachment.provider_conversation_id == record.provider_conversation_id,
            ConversationCaptureAttachment.kind == "output",
            ConversationCaptureAttachment.file_name == file_id,
        )
        .order_by(ConversationCaptureAttachment.created_at.desc())
        .first()
    )

    if asset is None:
        asset = ConversationGeneratedAsset(
            conversation_id=record.id,
            provider=PROVIDER,
            output_type="image",
            provider_asset_id=asset_pointer,
            canonical_asset_key=file_id or None,
        )
        db.add(asset)

    asset.response_id = response.id
    asset.prompt_id = response.prompt_id
    if attachment:
        asset.file_url = attachment.file_url
        asset.file_name = attachment.file_name
        asset.mime_type = attachment.mime_type
        asset.size_bytes = attachment.size_bytes
    db.flush()
    return asset


def _handle_generation_captured(db: Session, record: ConversationRecord, event: ConversationCaptureEvent) -> None:
    """generation_captured isn't currently emitted by the extension (images
    now flow through response_completed's contentParts instead - see
    CAPTURE_CONTRACT.md) but is a documented event_type; handled here for
    forward-compatibility with any future DOM-fallback capture path that
    does emit it, rather than silently dropping a defined contract event."""
    payload = event.payload_json or {}
    output_type = payload.get("outputType") if payload.get("outputType") in OUTPUT_TYPES else "file"
    asset_key = payload.get("fileUrl") or f"event-{event.id}"

    asset = (
        db.query(ConversationGeneratedAsset)
        .filter(ConversationGeneratedAsset.provider == PROVIDER, ConversationGeneratedAsset.canonical_asset_key == asset_key)
        .first()
    )
    if asset is None:
        asset = ConversationGeneratedAsset(conversation_id=record.id, provider=PROVIDER, canonical_asset_key=asset_key)
        db.add(asset)
    asset.output_type = output_type
    asset.file_url = payload.get("fileUrl")
    asset.file_name = payload.get("fileName")
    asset.mime_type = payload.get("mimeType")
    asset.size_bytes = payload.get("sizeBytes")
    db.flush()


def _resync_conversation_counts(db: Session, record: ConversationRecord) -> None:
    record.prompt_count = db.query(ConversationPrompt).filter(ConversationPrompt.conversation_id == record.id).count()
    record.response_count = db.query(ConversationResponse).filter(ConversationResponse.conversation_id == record.id).count()


_EVENT_HANDLERS = {
    EVENT_TYPE_PROMPT_CAPTURED: lambda db, record, event: _upsert_prompt(db, record, event),
    EVENT_TYPE_MESSAGE_EDITED: _handle_message_edited,
    EVENT_TYPE_RESPONSE_COMPLETED: lambda db, record, event: _upsert_response(db, record, event),
    EVENT_TYPE_GENERATION_CAPTURED: _handle_generation_captured,
}


def normalize_capture_event(db: Session, event: ConversationCaptureEvent) -> Optional[ConversationRecord]:
    """Normalizes ONE event: flushes its changes (never commits, never
    resyncs conversation counts - see normalize_capture_events_batch, which
    every caller should go through instead of calling this directly). A
    no-op for event types with no normalized representation yet
    (response_started, lifecycle/diagnostic events) - the raw event remains
    the source of truth for those; queries.py's read-time reconstruction
    still covers them."""
    if not event.provider_conversation_id:
        # No conversation identity yet (e.g. the very first prompt_captured
        # of a brand-new conversation, before ChatGPT assigns an id) -
        # nothing to attach a ConversationRecord to. A later event for the
        # same underlying conversation will carry the id once known.
        return None
    handler = _EVENT_HANDLERS.get(event.event_type)
    if handler is None:
        return None
    record = _get_or_create_conversation_record(db, event)
    handler(db, record, event)
    return record


def normalize_capture_events_batch(db: Session, events: list) -> dict:
    """Normalizes many events against ONE commit, not one per event.

    A single capture request can carry up to 200 events
    (CaptureEventsRequest.events), and the operational database is a remote
    Postgres (Supabase, ap-south-1 in this deployment) - a naive
    commit-per-event loop turns one HTTP request into up to 200 sequential
    network round trips just for commits, on top of the several SELECTs each
    event's upsert already does. That's what actually exhausted the
    connection pool under concurrent batches in production ("QueuePool limit
    ... connection timed out" + 15s frontend timeouts) - not genuine
    overload, one chatty endpoint holding its pooled connection far longer
    than the work justified.

    Each event's normalization runs inside its own SAVEPOINT
    (`db.begin_nested()`) so one bad event only discards that event's own
    changes on failure - not the whole batch's - while the whole batch still
    costs exactly one real commit."""
    touched_records: dict[int, ConversationRecord] = {}
    errors = 0
    for event in events:
        try:
            with db.begin_nested():
                record = normalize_capture_event(db, event)
            if record is not None:
                touched_records[record.id] = record
        except Exception:
            logger.exception("chatgpt normalization failed for event_id=%s", event.id)
            errors += 1
            continue
    for record in touched_records.values():
        _resync_conversation_counts(db, record)
    db.commit()
    return {"touchedConversations": len(touched_records), "errors": errors}


def backfill_all(db: Session, *, batch_size: int = 500) -> dict:
    """Replays every historical ConversationCaptureEvent (oldest-first)
    through the same idempotent normalizer the live path uses - safe to
    re-run any number of times. Not a "recovery" (no source-of-truth
    reconciliation against ChatGPT itself, no ConversationRecoveryAudit) -
    just a straight replay of data this system already captured losslessly.
    Commits once per `batch_size`-sized page (via normalize_capture_events_batch),
    not once per event."""
    stats = {"processed": 0, "normalized": 0, "skipped": 0, "errors": 0}
    last_id = 0
    while True:
        events = (
            db.query(ConversationCaptureEvent)
            .filter(ConversationCaptureEvent.id > last_id)
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
