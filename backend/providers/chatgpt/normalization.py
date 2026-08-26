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
from datetime import datetime, timedelta
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
    OWNERSHIP_STATUS_UNKNOWN,
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


def _is_attributable(event: ConversationCaptureEvent) -> bool:
    """The ChatGPT equivalent of providers/freepik/normalization.py's
    _is_fresh_enough_for_attribution - same bug class (a conversation_id our
    backend has never captured before is just as likely to be an existing
    conversation someone else already used, especially on a shared tool
    credential, as it is to be genuinely new), different signal, because
    ChatGPT capture events don't carry a trustworthy provider-side timestamp
    the way Freepik's payload does.

    isNewConversation is set by the extension (content-chatgpt.js) only when
    ChatGPT itself had not yet assigned this conversation an id at the moment
    the triggering prompt/response was captured - the one signal that
    actually proves this conversation started with the current sender, in
    this exact browser session, right now. A reply inside an existing
    conversation - even one this backend has never seen before - never sets
    it, regardless of who sent that reply."""
    payload = event.payload_json or {}
    return bool(payload.get("isNewConversation"))


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
        # Sticky ownership: an already-resolved (or already-unknown) record is
        # never touched here - the one place ownership is ever assigned is
        # the create branch below, on this conversation_id's very first
        # capture event. See _is_attributable's docstring for why a later
        # event can't be trusted to safely resolve an unknown owner anyway
        # (isNewConversation is only ever true for the first message of a
        # thread, never for a later one).
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
        # Lands unclaimed by design, exactly like Freepik's stale/
        # reconciliation branch - a pre-existing conversation surfacing for
        # the first time should never be silently attributed to whoever's
        # session happened to touch it first.
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
    prompt.images_json = payload.get("images") or None
    prompt.files_json = payload.get("files") or None
    prompt.code_blocks_json = payload.get("codeBlocks") or None
    prompt.content_parts_json = payload.get("contentParts") or None
    # sequence_index is set once, at creation, from _next_prompt_sequence
    # (server-computed, monotonic per conversation) - never from
    # payload.sequenceIndex. That field is the extension's own local
    # per-conversation-id counter (bus.nextSequenceIndex), which restarts
    # from 0 whenever it starts counting under a different id - including
    # empty string, the id a brand-new thread's opening message is sent
    # under before ChatGPT assigns one. Trusting it here let a reconciled
    # orphan (see _reconcile_orphaned_prompt) collide with that same
    # conversation's next ordinary prompt, both landing on sequence_index 0
    # - confirmed live in production.
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
    """Pair a response to the prompt that actually triggered it.

    Prefers an exact match via ChatGPT's own thread pointer: response_completed's
    payload.parentMessageId (populated from the authoritative conversation-fetch's
    mapping[messageId].parent - see content-chatgpt.js fetchAuthoritativeAssistantContent)
    is the id of the prompt message this response replies to, and
    ConversationPrompt.provider_message_id is exactly that prompt's own id. This is
    unambiguous even when turns overlap.

    Falls back to "most recently created prompt for this conversation" - mirrors the
    turn-pairing heuristic queries.py:list_conversation_messages already applies at
    read time - only when parentMessageId is unavailable (stream/DOM fallback
    captures, or events predating this field). That fallback assumes turns never
    overlap, which is false for async tool-backed responses (e.g. image generation
    taking 30-90s): a prompt sent while an earlier response is still pending would
    otherwise steal the pairing.
    """
    payload = event.payload_json or {}
    parent_message_id = payload.get("parentMessageId")
    if parent_message_id:
        exact = _find_prompt_by_message_id(db, record, parent_message_id)
        if exact:
            return exact

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


# How long a brand-new conversation's opening prompt can plausibly sit
# unanswered before _reconcile_orphaned_prompt's timestamp-proximity fallback
# refuses to guess. Generous on purpose: async tool-backed turns (image
# generation) were independently observed taking 30-90s (see
# _find_matching_prompt's docstring) - this just needs to comfortably clear
# that, not pin it exactly.
ORPHAN_RECONCILE_WINDOW_SECONDS = 15 * 60


def _reconcile_orphaned_prompt(db: Session, record: ConversationRecord, event: ConversationCaptureEvent) -> None:
    """Backfills the one prompt_captured event that genuinely cannot carry a
    conversation_id at capture time: the very first message of a brand-new
    conversation, sent before ChatGPT has assigned it an id (see
    normalize_capture_event's provider_conversation_id guard, whose comment
    promised "a later event... will carry the id once known" - nothing
    actually implemented that until now, so that event sat losslessly in
    ConversationCaptureEvent forever with provider_conversation_id NULL,
    invisible to every conversation-scoped read; confirmed in production via
    direct query - dozens of conversations permanently missing their opening
    prompt/image, not an extension capture bug at all.

    Only relevant when this conversation has no prompt at all yet (a reply
    inside an existing conversation already carries a real conversation_id at
    capture time, so there is nothing to reconcile) - gated on that directly,
    via a live query, rather than on "is this ConversationRecord brand new
    right now": the latter is only true once per record's entire lifetime, so
    a second backfill_all() replay - or simply re-running it after a first
    pass whose only matching response_completed used stream_fallback - would
    silently stop retrying reconciliation for every record already created by
    the first pass. A has-any-prompt check is idempotent across any number of
    replays instead.

    Two link strategies, tried in order:
    1. response_completed's payload.parentMessageId - ChatGPT's own thread
       pointer naming the exact prompt message this response replies to.
       Exact, but only populated when the authoritative conversation-fetch
       succeeds, which production data shows happening on roughly 1% of
       response_completed events (RESPONSE_RECONSTRUCTION_REPORT.md's
       "observed failing 100% of the time" turned out to still be true after
       that fix shipped) - not a usable primary strategy on its own.
    2. Nearest still-orphaned prompt_captured event from the SAME user
       within ORPHAN_RECONCILE_WINDOW_SECONDS before this event - the same
       "closest preceding event, same actor" heuristic
       mediaHelpers.buildGenerations already applies client-side for
       image-to-turn pairing, and the only thing available for the ~99% of
       turns strategy 1 can't resolve. Approximate the same way that one is:
       two new conversations from the same user opened within the window
       could theoretically cross-pair, which is why this only ever runs
       while the conversation has zero prompts, not on every event of an
       existing one.

    Patches the raw event's provider_conversation_id (so it stops being
    orphaned for any future replay too) and normalizes it immediately,
    before the caller's own handler runs - so response.prompt_id below
    resolves correctly the very first time instead of only after a second
    backfill pass. Also repairs a specific corruption this introduced on its
    way to this fix: before this gate existed, _upsert_response's own
    "most recently created prompt for this conversation" fallback (see
    _find_matching_prompt) ran against a conversation that - because its
    true first prompt was still an unreconciled orphan - genuinely had no
    prompt at all yet at that point, then later ran again after a *later*
    turn's ordinary prompt had already been normalized, and paired this
    first response to that later prompt instead (confirmed live: conv 77's
    "I wasn't able to generate the image..." response had prompt_id pointing
    at "try again", its own conversation's *second* message). Once set,
    _upsert_response's `if response.prompt_id is None` guard never
    revisits it - so the fix below overwrites it directly rather than
    relying on that guard to self-correct on replay."""
    if event.event_type != EVENT_TYPE_RESPONSE_COMPLETED:
        return
    # Gated on "is this the earliest response_completed event ever captured
    # for this real conversation_id" - a property of the immutable raw event
    # log (ConversationCaptureEvent.id ordering), not of what has or hasn't
    # been written to ConversationResponse/ConversationPrompt yet. Checking
    # against those normalized tables instead (prompt exists? response
    # exists?) sounds equivalent but isn't: both get written by ordinary,
    # unrelated turns processing before or after this one on a later replay,
    # and reading that as "already reconciled" is exactly what produced the
    # corruption this function now also repairs.
    earliest_response_event_id = (
        db.query(func.min(ConversationCaptureEvent.id))
        .filter(
            ConversationCaptureEvent.provider == PROVIDER,
            ConversationCaptureEvent.provider_conversation_id == event.provider_conversation_id,
            ConversationCaptureEvent.event_type == EVENT_TYPE_RESPONSE_COMPLETED,
        )
        .scalar()
    )
    if earliest_response_event_id != event.id:
        return

    orphan_query = db.query(ConversationCaptureEvent).filter(
        ConversationCaptureEvent.provider == PROVIDER,
        ConversationCaptureEvent.event_type == EVENT_TYPE_PROMPT_CAPTURED,
        ConversationCaptureEvent.provider_conversation_id.is_(None),
    )

    orphan = None
    parent_message_id = (event.payload_json or {}).get("parentMessageId")
    if parent_message_id:
        orphan = orphan_query.filter(ConversationCaptureEvent.provider_message_id == parent_message_id).first()

    if orphan is None:
        window_start = event.created_at - timedelta(seconds=ORPHAN_RECONCILE_WINDOW_SECONDS)
        orphan = (
            orphan_query.filter(
                ConversationCaptureEvent.user_id == event.user_id,
                ConversationCaptureEvent.created_at >= window_start,
                ConversationCaptureEvent.created_at <= event.created_at,
            )
            .order_by(ConversationCaptureEvent.created_at.desc())
            .first()
        )

    if orphan is not None:
        orphan.provider_conversation_id = event.provider_conversation_id
        db.flush()
        prompt = _upsert_prompt(db, record, orphan)

        # Repair: if this exact turn's response was already normalized (by
        # an earlier run of this backfill, before this reconciliation
        # existed or before it could find this orphan yet) and got
        # mis-paired to some other prompt via _find_matching_prompt's
        # fallback, point it at the real one now instead of leaving it
        # wrong forever.
        existing_response = (
            db.query(ConversationResponse)
            .filter(ConversationResponse.conversation_id == record.id, ConversationResponse.source_capture_event_id == event.id)
            .first()
        )
        if existing_response is not None and existing_response.prompt_id != prompt.id:
            existing_response.prompt_id = prompt.id
            db.flush()

    # Runs whether or not an orphan was found just now, not only inside the
    # branch above: once an orphan has already been linked by an earlier
    # replay, orphan_query correctly finds nothing new here every time after
    # (it only matches provider_conversation_id IS NULL, which this orphan
    # no longer is) - but sequence_index still needs enforcing on every
    # replay of this same gated event, since _upsert_prompt's own handling
    # of this conversation's *other*, ordinary prompts runs later in the
    # same replay pass and would otherwise have nothing left correcting the
    # renumbering behind it.
    _renumber_by_timestamp(db, record)


def _renumber_by_timestamp(db: Session, record: ConversationRecord) -> None:
    """Reassigns sequence_index for every prompt and response in a
    conversation by true chronological (timestamp) order, overriding
    whatever the extension's own client-side sequenceIndex payload field
    said. Only called right after _reconcile_orphaned_prompt links an
    orphan in, because that is the one situation where sequence_index can
    disagree with real chronology badly enough to matter: the extension's
    counter is keyed per conversation_id as it knew it at send time, which
    is empty for a brand-new thread's opening message - so that prompt's
    sequenceIndex starts from 0 in its own, separate counting, and so does
    the conversation's next *ordinary* message once a real id exists,
    producing two prompts both claiming sequence_index 0 once both land in
    the same conversation (confirmed live: exactly this collision, between
    an orphan and the thread's own second message). Nothing else in this
    file lets two prompts/responses collide this way, so this does not need
    to run on every event - list_conversation_messages already displays by
    timestamp regardless, this only fixes the stored column for anything
    that reads sequence_index directly."""
    prompts = (
        db.query(ConversationPrompt)
        .filter(ConversationPrompt.conversation_id == record.id)
        .order_by(ConversationPrompt.prompt_timestamp.asc(), ConversationPrompt.id.asc())
        .all()
    )
    for index, prompt in enumerate(prompts, start=1):
        prompt.sequence_index = index

    responses = (
        db.query(ConversationResponse)
        .filter(ConversationResponse.conversation_id == record.id)
        .order_by(ConversationResponse.response_timestamp.asc(), ConversationResponse.id.asc())
        .all()
    )
    for index, response in enumerate(responses, start=1):
        response.sequence_index = index

    db.flush()


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
        # nothing to attach a ConversationRecord to yet. Handled once the
        # conversation's response_completed event arrives (which does carry
        # the real id) via _reconcile_orphaned_prompt below - this raw event
        # is not lost, just deferred.
        return None
    handler = _EVENT_HANDLERS.get(event.event_type)
    if handler is None:
        return None
    record = _get_or_create_conversation_record(db, event)
    _reconcile_orphaned_prompt(db, record, event)
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
