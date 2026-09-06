# providers/grammarly_docs/normalization.py
"""
Raw GrammarlyCaptureEvent -> normalized GrammarlyDocSession.

Unlike every other provider's normalization.py in this codebase (always
INSERT one new row per capture event), this one has two branches that behave
differently, because a doc session is one real-world thing reported by TWO
events:

  doc_open         -> INSERT a new GrammarlyDocSession (status="open")
  doc_session_end  -> UPDATE the matching GrammarlyDocSession (by
                       session_key) in place: ended_at, duration_seconds,
                       status="ended"

If a doc_session_end arrives with no matching open session (extension
restarted mid-session, event lost and retried out of order, etc.) it is
dropped with a warning, not turned into an orphan row - there is nothing
meaningful to attach a bare "session ended" fact to without a start.

reconcile_stale_sessions() is this provider's equivalent of an asset-mirror
sweep: a periodic pass (not yet wired into main.py's periodic dispatchers -
see this provider's CAPTURE_CONTRACT.md known-gaps section) that closes out
any session still "open" long after it plausibly could still be, capping its
duration at MAX_SESSION_DURATION_SECONDS - see constants.py.
"""
import logging
from datetime import datetime, timedelta, timezone
from typing import Any, Optional

from sqlalchemy.orm import Session

from providers.grammarly_docs.constants import (
    EVENT_TYPE_DOC_CONTENT_CAPTURED,
    EVENT_TYPE_DOC_OPEN,
    EVENT_TYPE_DOC_SESSION_END,
    EVENT_TYPE_PAGE_NAME_UPDATED,
    MAX_CONTENT_TEXT_CHARS,
    MAX_SESSION_DURATION_SECONDS,
    OWNERSHIP_STATUS_RESOLVED,
    PROVIDER,
)
from providers.grammarly_docs.models import GrammarlyCaptureEvent, GrammarlyDocSession

logger = logging.getLogger("grammarly_docs_normalization")


def _s(value: Any, max_length: Optional[int] = None) -> Optional[str]:
    if value is None:
        return None
    text = str(value).strip()
    if not text:
        return None
    return text[:max_length] if max_length else text


def _parse_dt(value: Any) -> Optional[datetime]:
    """Same conversion-to-naive-UTC rule as every other provider's
    normalization.py's _parse_dt - see providers/splice/normalization.py's
    identical function for the full reasoning."""
    if not value or not isinstance(value, str):
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is not None:
        parsed = parsed.astimezone(timezone.utc).replace(tzinfo=None)
    return parsed


def _normalize_doc_open_event(db: Session, event: GrammarlyCaptureEvent) -> Optional[GrammarlyDocSession]:
    """A doc was opened - see GrammarlyDocSession's own docstring. Gated
    behind nothing (opening a doc is not an accountable action the way a
    download/generation is - see CAPTURE_CONTRACT.md), so linked_task_id/
    linked_client_id are carried through only when the extension actually
    sent them, never required.

    Idempotent on session_key, not just client_event_id: capture.py already
    dedupes on client_event_id, but a session_key collision (the extension
    retrying a doc_open under a fresh client_event_id after a failed send)
    would otherwise create a second session row for the same real visit."""
    if not event.session_key:
        logger.warning(
            "grammarly doc_open capture_event_id=%s has no session_key - dropped, nothing to key a session on",
            event.id,
        )
        return None

    existing = (
        db.query(GrammarlyDocSession)
        .filter(GrammarlyDocSession.provider == PROVIDER, GrammarlyDocSession.session_key == event.session_key)
        .first()
    )
    if existing is not None:
        return existing

    payload = event.payload_json or {}
    doc_title = _s(payload.get("docTitle") or payload.get("doc_title") or payload.get("title"))
    doc_author = _s(payload.get("docAuthor") or payload.get("doc_author") or payload.get("author"), 255)
    doc_url = _s(payload.get("docUrl") or payload.get("doc_url") or payload.get("canonicalUrl"))
    page_url = _s(payload.get("pageUrl") or payload.get("page_url"))
    page_id = _s(payload.get("pageId") or payload.get("page_id"), 160)
    page_name = _s(payload.get("pageName") or payload.get("page_name"))
    started_at = _parse_dt(payload.get("startedAt") or payload.get("started_at")) or event.created_at

    row = GrammarlyDocSession(
        provider=PROVIDER,
        source_capture_event_id=event.id,
        tool_id=event.tool_id,
        credential_id=event.credential_id,
        owner_user_id=event.user_id,
        ownership_status=OWNERSHIP_STATUS_RESOLVED,
        linked_task_id=event.linked_task_id,
        linked_task_name=event.linked_task_name,
        linked_client_id=event.linked_client_id,
        linked_client_name=event.linked_client_name,
        session_key=event.session_key,
        doc_id=_s(event.doc_id, 160),
        doc_title=doc_title,
        doc_author=doc_author,
        doc_url=doc_url,
        page_url=page_url,
        page_id=page_id,
        page_name=page_name,
        started_at=started_at,
        last_seen_at=started_at,
        status="open",
        metadata_json=payload,
    )
    db.add(row)
    db.flush()
    return row


def _normalize_doc_session_end_event(db: Session, event: GrammarlyCaptureEvent) -> Optional[GrammarlyDocSession]:
    """A doc session ended (tab hidden/closed/navigated away - a client-side
    lifecycle signal, not a Coda API response - see constants.py). Updates
    the matching open GrammarlyDocSession in place; does not insert a row."""
    if not event.session_key:
        logger.warning(
            "grammarly doc_session_end capture_event_id=%s has no session_key - dropped, nothing to close",
            event.id,
        )
        return None

    session = (
        db.query(GrammarlyDocSession)
        .filter(GrammarlyDocSession.provider == PROVIDER, GrammarlyDocSession.session_key == event.session_key)
        .first()
    )
    if session is None:
        logger.warning(
            "grammarly doc_session_end capture_event_id=%s session_key=%s has no matching doc_open - dropped",
            event.id, event.session_key,
        )
        return None

    if session.status == "ended":
        # Already closed (a retried/duplicate close event under a different
        # client_event_id) - nothing to do, this is not an error.
        return session

    payload = event.payload_json or {}
    ended_at = _parse_dt(payload.get("endedAt") or payload.get("ended_at")) or event.created_at
    if ended_at < session.started_at:
        # A clock-skew/out-of-order artifact - never report a negative
        # duration; clamp to the start instant instead of dropping the event.
        ended_at = session.started_at

    duration_seconds = payload.get("durationSeconds") or payload.get("duration_seconds")
    if not isinstance(duration_seconds, (int, float)):
        duration_seconds = (ended_at - session.started_at).total_seconds()
    duration_seconds = max(0.0, min(float(duration_seconds), MAX_SESSION_DURATION_SECONDS))

    session.close_capture_event_id = event.id
    session.ended_at = ended_at
    session.duration_seconds = duration_seconds
    session.last_seen_at = ended_at
    session.status = "ended"
    db.flush()
    return session


def _normalize_doc_content_captured_event(db: Session, event: GrammarlyCaptureEvent) -> Optional[GrammarlyDocSession]:
    """A best-effort DOM read of the doc's visible text - see constants.py's
    EVENT_TYPE_DOC_CONTENT_CAPTURED docstring for the full posture. Updates
    the matching session's content_text/content_word_count/
    content_char_count/content_captured_at in place - OVERWRITES on every
    capture (this can fire more than once per session), same "latest signal
    wins" posture as _normalize_doc_session_end_event's ended_at/
    duration_seconds. Applies even to an already-"ended" session (the
    pre-close capture is expected to land after doc_session_end in some
    orderings), unlike doc_session_end which no-ops once closed."""
    if not event.session_key:
        logger.warning(
            "grammarly doc_content_captured capture_event_id=%s has no session_key - dropped, nothing to attach content to",
            event.id,
        )
        return None

    session = (
        db.query(GrammarlyDocSession)
        .filter(GrammarlyDocSession.provider == PROVIDER, GrammarlyDocSession.session_key == event.session_key)
        .first()
    )
    if session is None:
        logger.warning(
            "grammarly doc_content_captured capture_event_id=%s session_key=%s has no matching doc_open - dropped",
            event.id, event.session_key,
        )
        return None

    payload = event.payload_json or {}
    content_text = _s(payload.get("contentText") or payload.get("content_text"))
    if content_text and len(content_text) > MAX_CONTENT_TEXT_CHARS:
        content_text = content_text[:MAX_CONTENT_TEXT_CHARS]

    word_count = payload.get("wordCount") or payload.get("word_count")
    char_count = payload.get("charCount") or payload.get("char_count")
    captured_at = _parse_dt(payload.get("capturedAt") or payload.get("captured_at")) or event.created_at

    session.content_text = content_text
    session.content_word_count = int(word_count) if isinstance(word_count, (int, float)) else (
        len(content_text.split()) if content_text else None
    )
    session.content_char_count = int(char_count) if isinstance(char_count, (int, float)) else (
        len(content_text) if content_text else None
    )
    session.content_captured_at = captured_at
    db.flush()
    return session


def _normalize_page_name_updated_event(db: Session, event: GrammarlyCaptureEvent) -> Optional[GrammarlyDocSession]:
    """Coda's router caught up to the current page's real name after
    doc_open already fired with a stale URL slug - see constants.py's
    EVENT_TYPE_PAGE_NAME_UPDATED docstring. Updates the matching session's
    page_name (and page_id, defensively, in case it too had drifted) in
    place - same "latest signal wins" posture as content/duration, applies
    even to an already-"ended" session for the same ordering reason
    _normalize_doc_content_captured_event's own docstring gives."""
    if not event.session_key:
        logger.warning(
            "grammarly page_name_updated capture_event_id=%s has no session_key - dropped, nothing to update",
            event.id,
        )
        return None

    session = (
        db.query(GrammarlyDocSession)
        .filter(GrammarlyDocSession.provider == PROVIDER, GrammarlyDocSession.session_key == event.session_key)
        .first()
    )
    if session is None:
        logger.warning(
            "grammarly page_name_updated capture_event_id=%s session_key=%s has no matching doc_open - dropped",
            event.id, event.session_key,
        )
        return None

    payload = event.payload_json or {}
    page_name = _s(payload.get("pageName") or payload.get("page_name"))
    page_id = _s(payload.get("pageId") or payload.get("page_id"), 160)
    if page_name:
        session.page_name = page_name
    if page_id:
        session.page_id = page_id
    db.flush()
    return session


def normalize_capture_event(db: Session, event: GrammarlyCaptureEvent) -> Optional[GrammarlyDocSession]:
    if event.event_type == EVENT_TYPE_DOC_OPEN:
        return _normalize_doc_open_event(db, event)
    if event.event_type == EVENT_TYPE_DOC_SESSION_END:
        return _normalize_doc_session_end_event(db, event)
    if event.event_type == EVENT_TYPE_DOC_CONTENT_CAPTURED:
        return _normalize_doc_content_captured_event(db, event)
    if event.event_type == EVENT_TYPE_PAGE_NAME_UPDATED:
        return _normalize_page_name_updated_event(db, event)
    # capture.py already rejects anything not in ALL_EVENT_TYPES before a row
    # ever reaches here - this branch exists only for structural parity with
    # every other provider's normalize_capture_event.
    logger.warning("grammarly capture_event_id=%s has unrecognized event_type=%r", event.id, event.event_type)
    return None


def normalize_capture_events_batch(db: Session, events: list[GrammarlyCaptureEvent]) -> dict:
    """Best-effort relative to raw capture - mirrors
    providers/splice/normalization.py's identical function (per-event
    SAVEPOINT isolation, chunked commit) verbatim. Events are processed in
    the order given, which router.py preserves as capture order - so a
    doc_session_end normalized in the same batch as its doc_open always sees
    the session row already inserted."""
    from providers.grammarly_docs.constants import INGEST_COMMIT_CHUNK_SIZE

    stats = {"normalized": 0, "skipped": 0, "errors": 0}
    if not events:
        return stats
    pending_since_commit = 0
    for event in events:
        savepoint = db.begin_nested()
        try:
            normalized = normalize_capture_event(db, event)
            savepoint.commit()
            stats["normalized" if normalized is not None else "skipped"] += 1
        except Exception:
            savepoint.rollback()
            stats["errors"] += 1
            logger.exception(
                "grammarly normalization failed for capture_event_id=%s - skipped this cycle",
                event.id,
            )
        pending_since_commit += 1
        if pending_since_commit >= INGEST_COMMIT_CHUNK_SIZE:
            db.commit()
            pending_since_commit = 0
    if pending_since_commit:
        db.commit()
    return stats


def backfill_all(db: Session, *, batch_size: int = 500) -> dict:
    """Replays every historical GrammarlyCaptureEvent through the same
    idempotent normalizer the live path uses - mirrors
    providers/splice/normalization.py's identical function. Safe to re-run:
    doc_open is idempotent on session_key, doc_session_end no-ops against an
    already-"ended" session."""
    stats = {"processed": 0, "normalized": 0, "skipped": 0, "errors": 0}
    last_id = 0
    while True:
        events = (
            db.query(GrammarlyCaptureEvent)
            .filter(GrammarlyCaptureEvent.provider == PROVIDER, GrammarlyCaptureEvent.id > last_id)
            .order_by(GrammarlyCaptureEvent.id.asc())
            .limit(batch_size)
            .all()
        )
        if not events:
            break
        last_id = events[-1].id
        stats["processed"] += len(events)
        batch_stats = normalize_capture_events_batch(db, events)
        for key, value in batch_stats.items():
            stats[key] += value
        logger.info(
            "grammarly backfill progress: processed=%s normalized=%s skipped=%s errors=%s (through capture_event_id=%s)",
            stats["processed"], stats["normalized"], stats["skipped"], stats["errors"], last_id,
        )
    return stats


def reconcile_stale_sessions(db: Session, *, stale_after_seconds: int = MAX_SESSION_DURATION_SECONDS, limit: int = 200) -> dict:
    """Closes out sessions still status="open" whose started_at is old
    enough that they can no longer plausibly be a real live tab (extension
    reload, browser crash, or a lost doc_session_end event) - caps
    duration_seconds at MAX_SESSION_DURATION_SECONDS and marks status="stale"
    rather than leaving them open forever. NOT yet wired into a periodic
    dispatcher in main.py (see CAPTURE_CONTRACT.md known-gaps) - callable
    on demand (e.g. from a maintenance script) until it is."""
    cutoff = datetime.utcnow() - timedelta(seconds=stale_after_seconds)
    rows = (
        db.query(GrammarlyDocSession)
        .filter(
            GrammarlyDocSession.provider == PROVIDER,
            GrammarlyDocSession.status == "open",
            GrammarlyDocSession.started_at <= cutoff,
        )
        .limit(limit)
        .all()
    )
    for row in rows:
        anchor = row.last_seen_at or row.started_at
        row.ended_at = anchor
        row.duration_seconds = max(0.0, min((anchor - row.started_at).total_seconds(), MAX_SESSION_DURATION_SECONDS))
        row.status = "stale"
    if rows:
        db.commit()
    return {"reconciled": len(rows)}
