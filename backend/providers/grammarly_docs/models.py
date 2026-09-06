# providers/grammarly_docs/models.py - Grammarly Docs (session) capture data model
"""
Two-layer design, mirroring providers/splice/models.py's
SpliceCaptureEvent -> SpliceDownload pair (see constants.py's module
docstring for why this provider is session-shaped, not generation- or
download-shaped):

  GrammarlyCaptureEvent (raw, append-only, lossless)
        -> normalization.py ->
  GrammarlyDocSession   (normalized, one row per doc-open SESSION)

Unlike every download/generation row elsewhere in this codebase,
GrammarlyDocSession is NOT insert-only: a doc_open event creates the row,
and a later doc_session_end event for the SAME session_key UPDATES it
in place (ended_at, duration_seconds) rather than inserting a second row -
the two events are two halves of one real-world session, not two
independent actions. See normalization.py for the update-in-place logic
and constants.py for why "closed" is a client-side tab-lifecycle signal,
not something observed in Coda's own network traffic.
"""
from datetime import datetime

from sqlalchemy import (
    Column,
    Date,
    DateTime,
    Float,
    ForeignKey,
    Index,
    Integer,
    JSON,
    String,
    Text,
)

from database_config import Base
from utils.datetime_utils import serialize_utc_datetime


class GrammarlyCaptureEvent(Base):
    """Raw, provider-agnostic capture signal reported by the extension,
    stored losslessly and opaquely (payload_json) before normalization into
    GrammarlyDocSession. Deliberately thin - see
    providers/grammarly_docs/capture.py. Mirrors
    providers/splice/models.py's SpliceCaptureEvent exactly.

    Idempotency is (provider, credential_id, client_event_id) - same
    reasoning as every other provider's *CaptureEvent: scope uniqueness by
    the shared/assigned account (credential), never by the reporting portal
    user. client_event_id here is the doc-open session's session_key for a
    doc_open event, and the SAME session_key again for that session's
    doc_session_end event - the two rows are correlated by session_key
    (carried in payload_json), not by sharing a client_event_id (each event
    still needs its own unique client_event_id for dedup)."""
    __tablename__ = "grammarly_capture_events"
    __table_args__ = (
        Index(
            "ux_grammarly_capture_events_credential_client_event_id",
            "provider", "credential_id", "client_event_id",
            unique=True,
        ),
        Index("ix_grammarly_capture_events_tool_created_at", "tool_id", "created_at"),
        Index("ix_grammarly_capture_events_user_created_at", "user_id", "created_at"),
        # session_key is NOT redeclared here - it already carries index=True
        # below, which auto-generates an index of this exact same name
        # (SQLAlchemy's ix_<table>_<column> convention). Declaring both here
        # attempts to create the identical index twice in one run and fails
        # with DuplicateTable/"index already exists" - this is the exact bug
        # providers/splice/models.py's own __table_args__ comment documents
        # (confirmed real against SQLite in this provider's own offline test,
        # same class of bug that hit EpidemicDownload/FlowGeneration against
        # live Postgres) - only genuinely COMPOSITE multi-column indexes
        # belong in this tuple.
    )

    id = Column(Integer, primary_key=True, index=True)
    tool_id = Column(Integer, ForeignKey("it_portal_tools.id"), nullable=False, index=True)
    credential_id = Column(Integer, ForeignKey("it_portal_tool_credentials.id"), index=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False, index=True)
    provider = Column(String(40), nullable=False, default="grammarly", index=True)
    event_type = Column(String(40), nullable=False, index=True)
    client_event_id = Column(String(160), nullable=False)
    # The extension-generated id correlating a doc_open and its later
    # doc_session_end - see this class's own docstring.
    session_key = Column(String(160), index=True)
    doc_id = Column(String(160), index=True)
    ownership_confidence = Column(String(20))  # "ticket" | "session" - set by capture.py
    # Task Mapping: the internal Task the extension had the user select, if
    # any - see providers/grammarly_docs/capture.py. Optional for this
    # provider (opening a doc is not gated the way a download/generation
    # is) - see CAPTURE_CONTRACT.md.
    linked_task_id = Column(Integer, ForeignKey("tasks.id", ondelete="SET NULL"), index=True)
    linked_task_name = Column(String(255))
    linked_client_id = Column(Integer, ForeignKey("generation_clients.id", ondelete="SET NULL"), index=True)
    linked_client_name = Column(String(255))
    payload_json = Column(JSON, nullable=False)
    capture_version = Column(Integer, nullable=False, default=1)
    extension_version = Column(String(40))
    browser = Column(String(80))
    tab_id = Column(Integer)
    session_id = Column(String(512), index=True)
    extension_session_id = Column(String(160), index=True)
    event_date = Column(Date, nullable=False, index=True)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False, index=True)

    def to_dict(self):
        return {
            "id": self.id,
            "toolId": self.tool_id,
            "credentialId": self.credential_id,
            "userId": self.user_id,
            "provider": self.provider,
            "eventType": self.event_type,
            "clientEventId": self.client_event_id,
            "sessionKey": self.session_key,
            "docId": self.doc_id,
            "ownershipConfidence": self.ownership_confidence,
            "linkedTaskId": self.linked_task_id,
            "linkedTaskName": self.linked_task_name,
            "linkedClientId": self.linked_client_id,
            "linkedClientName": self.linked_client_name,
            "payload": self.payload_json or {},
            "captureVersion": self.capture_version,
            "extensionVersion": self.extension_version,
            "browser": self.browser,
            "tabId": self.tab_id,
            "sessionId": self.session_id,
            "extensionSessionId": self.extension_session_id,
            "eventDate": self.event_date.isoformat() if self.event_date else None,
            "createdAt": serialize_utc_datetime(self.created_at),
        }


class GrammarlyDocSession(Base):
    """One row per doc-open session - see this module's own docstring for
    why a doc_session_end event UPDATES this row instead of inserting a new
    one. Ownership is capture-time-only, same posture as every other
    provider's *_STATUS_RESOLVED path: event.user_id is trusted as-is
    because it comes from this codebase's own launch-ticket/dashboard-session
    resolution, not from Grammarly's own (never employee-identifying) traffic.

    doc_title/doc_author are best-effort, parsed by normalization.py from the
    page's own <title>/<meta name="author"> - Grammarly doc titles/authors
    can be renamed after the fact, so these are a snapshot as of THIS
    session's open, not a live-updated mirror (same posture as every other
    provider's denormalized *_name columns, e.g. linked_task_name)."""
    __tablename__ = "grammarly_doc_sessions"
    __table_args__ = (
        Index(
            "ux_grammarly_doc_sessions_session_key",
            "provider", "session_key",
            unique=True,
        ),
        Index("ix_grammarly_doc_sessions_owner_created_at", "owner_user_id", "created_at"),
        Index("ix_grammarly_doc_sessions_credential_created_at", "credential_id", "created_at"),
        Index("ix_grammarly_doc_sessions_doc_id_started_at", "doc_id", "started_at"),
    )

    id = Column(Integer, primary_key=True, index=True)
    provider = Column(String(40), nullable=False, default="grammarly", index=True)
    source_capture_event_id = Column(Integer, ForeignKey("grammarly_capture_events.id", ondelete="SET NULL"))
    # Set once the matching doc_session_end event lands - lets a query tell
    # "session confirmed closed" apart from "session still open or the close
    # event never arrived" without inspecting ended_at's nullability alone
    # (ended_at can also get backfilled by the stale-session reconciliation
    # pass - see normalization.py - which does NOT set this column).
    close_capture_event_id = Column(Integer, ForeignKey("grammarly_capture_events.id", ondelete="SET NULL"))
    tool_id = Column(Integer, ForeignKey("it_portal_tools.id"), index=True)
    credential_id = Column(Integer, ForeignKey("it_portal_tool_credentials.id"), index=True)
    owner_user_id = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), index=True)
    ownership_status = Column(String(40), nullable=False, default="unknown", index=True)

    linked_task_id = Column(Integer, ForeignKey("tasks.id", ondelete="SET NULL"), index=True)
    linked_task_name = Column(String(255))
    linked_client_id = Column(Integer, ForeignKey("generation_clients.id", ondelete="SET NULL"), index=True)
    linked_client_name = Column(String(255))

    # ---- Identity (confirmed via a real live capture, 2026-08-27 - see
    # CAPTURE_CONTRACT.md) ----
    session_key = Column(String(160), nullable=False, index=True)
    doc_id = Column(String(160), index=True)  # Coda's own docId, e.g. "Wg6E6d9q24" (URL's docId minus leading "_")
    doc_title = Column(Text)
    doc_author = Column(String(255))
    doc_url = Column(Text)  # canonical URL (coda.io/d/<slug>_<docId>), if present
    page_url = Column(Text)  # the actual coda.grammarly.com/d/<docId> URL the tab loaded

    # ---- Page identity, within the document (confirmed via a real live
    # capture, 2026-08-27 - see CAPTURE_CONTRACT.md) ----
    # A Coda doc can hold several "pages" (its own sidebar sub-page feature) -
    # the doc_id above stays IDENTICAL across every page of the same
    # document (it's the first /d/<slug>_<docId> URL segment), so it alone
    # cannot tell "page 2" apart from "page 3" of the same doc. page_id is
    # the SECOND URL path segment's stable suffix (Coda prefixes it "su",
    # e.g. "suQqVX4R", vs. the doc's own "d" prefix) - present only when the
    # URL actually names a page; null for a session opened at the doc's own
    # root (no second path segment).
    page_id = Column(String(160), index=True)
    page_name = Column(Text)  # human name, derived from that same segment's slug (hyphens -> spaces)

    # ---- Session timing ----
    started_at = Column(DateTime, nullable=False)
    ended_at = Column(DateTime)
    duration_seconds = Column(Float)
    # "open" | "ended" | "stale" (never got a close event, reconciled by a
    # later cycle capping duration - see constants.MAX_SESSION_DURATION_SECONDS
    # and normalization.py's reconcile_stale_sessions).
    status = Column(String(20), nullable=False, default="open", index=True)
    last_seen_at = Column(DateTime)  # most recent heartbeat/activity signal, if the extension sends one

    # ---- Document content (best-effort, DOM-read - see
    # constants.py's EVENT_TYPE_DOC_CONTENT_CAPTURED and
    # CAPTURE_CONTRACT.md's "Content capture" section for the full posture:
    # the extension reads whatever text is rendered on the page at capture
    # time, not Coda's own internal document model, so this is plain text,
    # not structure (tables/formulas collapse to flat text). A doc_open only
    # ever fires once, but content_captured can fire more than once per
    # session (an initial capture once the page settles, another right
    # before the session ends) - each capture OVERWRITES these columns
    # in place with the latest read, same "one row per session, updated as
    # new signal arrives" posture as ended_at/duration_seconds above, not a
    # history of edits.
    content_text = Column(Text)
    content_word_count = Column(Integer)
    content_char_count = Column(Integer)
    content_captured_at = Column(DateTime)

    metadata_json = Column(JSON)

    created_at = Column(DateTime, default=datetime.utcnow, nullable=False, index=True)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, nullable=False, index=True)

    def to_dict(self, *, include_content: bool = True):
        # include_content=False (used by the /sessions LIST endpoint - see
        # router.py) omits the potentially-large contentText field so
        # browsing 100 sessions at once can't balloon into megabytes of
        # response body; word/char counts and the capture timestamp are
        # cheap and always included either way so the browse view can still
        # show "this session has content" without fetching it.
        content_fields = {
            "contentWordCount": self.content_word_count,
            "contentCharCount": self.content_char_count,
            "contentCapturedAt": serialize_utc_datetime(self.content_captured_at),
        }
        if include_content:
            content_fields["contentText"] = self.content_text
        return {
            "id": self.id,
            "provider": self.provider,
            "sourceCaptureEventId": self.source_capture_event_id,
            "closeCaptureEventId": self.close_capture_event_id,
            "toolId": self.tool_id,
            "credentialId": self.credential_id,
            "ownerUserId": self.owner_user_id,
            "ownershipStatus": self.ownership_status,
            "linkedTaskId": self.linked_task_id,
            "linkedTaskName": self.linked_task_name,
            "linkedClientId": self.linked_client_id,
            "linkedClientName": self.linked_client_name,
            "sessionKey": self.session_key,
            "docId": self.doc_id,
            "docTitle": self.doc_title,
            "docAuthor": self.doc_author,
            "docUrl": self.doc_url,
            "pageUrl": self.page_url,
            "pageId": self.page_id,
            "pageName": self.page_name,
            "startedAt": serialize_utc_datetime(self.started_at),
            "endedAt": serialize_utc_datetime(self.ended_at),
            "durationSeconds": self.duration_seconds,
            "status": self.status,
            "lastSeenAt": serialize_utc_datetime(self.last_seen_at),
            **content_fields,
            "metadata": self.metadata_json or {},
            "createdAt": serialize_utc_datetime(self.created_at),
            "updatedAt": serialize_utc_datetime(self.updated_at),
        }
