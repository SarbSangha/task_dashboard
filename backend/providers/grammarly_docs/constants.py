# providers/grammarly_docs/constants.py
"""
Central place for the Grammarly Docs provider's literals - mirrors
providers/splice/constants.py's structure (see that file's own docstring for
why this pattern exists).

Grammarly's document product (coda.grammarly.com/d/<docId>, formerly Coda -
see this provider's own CAPTURE_CONTRACT.md) is NOT a generation-shaped
provider and NOT a download-shaped one either (unlike every other provider in
this codebase so far): there is no Generate action, no prompt, and no
"download a file" click. What's captured here is SESSION shape - a doc was
opened, and (best-effort) how long it stayed open - the same category of
signal the dashboard's own Tool Logins / time-spent tracking already collects
generically for every tool's *launch*, but scoped to which DOC specifically,
which the generic launch-time proxy cannot see.

Confirmed via a real captured request/response (2026-08-27 - see
CAPTURE_CONTRACT.md for the full detail):

  GET https://coda.grammarly.com/d/_dWg6E6d9q24
  -> full HTML page (not JSON) whose inline bootstrap script carries
     "docId": "Wg6E6d9q24" (the URL's docId minus its leading underscore),
     <title>testing 2</title>, <meta name="author" content="RMW">,
     <link rel="canonical" href="https://coda.io/d/testing-2_dWg6E6d9q24">.

This is a PAGE LOAD, not an API call with a clean JSON envelope - there is no
confirmed "doc closed" signal from the network at all (session end is
computed client-side from tab lifecycle events - visibilitychange/pagehide/
beforeunload - not observed from Coda's own traffic), no confirmed "create
doc" endpoint, and no confirmed identity for the actual document CONTENT (see
this provider's own README/CAPTURE_CONTRACT.md "known gaps" section - this is
a first pass scoped deliberately to session presence only, not content).
"""

PROVIDER = "grammarly"
PROVIDER_DISPLAY = "Grammarly (Docs)"

# it_portal_tools.slug values that map to this provider. Reuses the SAME
# seeded "grammarly" tool row content-grammarly.js's login autofill already
# targets (see routers/it_tools_router.py) - this is a second capture surface
# on an already-registered tool, not a new tool.
TOOL_SLUGS = frozenset({"grammarly"})

# Cookie-session-authenticated (not a public/keyed API) - same posture as
# every other best-effort capture provider in this codebase.
RELIABILITY_CLASS_BEST_EFFORT = "best_effort"
RELIABILITY_CLASS = RELIABILITY_CLASS_BEST_EFFORT

# How many events share one COMMIT on the ingest and normalization paths -
# see providers/freepik/constants.py's INGEST_COMMIT_CHUNK_SIZE for the
# reasoning this mirrors verbatim.
INGEST_COMMIT_CHUNK_SIZE = 50

# Written into GrammarlyCaptureEvent.capture_version by the capture endpoint.
CAPTURE_SCHEMA_VERSION = 1

# GrammarlyCaptureEvent.event_type values. EXACT LITERAL STRINGS - the
# extension sends these same strings; a mismatch here silently breaks capture
# with no error (see providers/splice/constants.py's identical warning). Do
# not rename without coordinating with the extension side.
#
# doc_open: fired once per doc visit (page load of /d/<docId>) - creates the
#   GrammarlyDocSession row.
# doc_session_end: fired by the extension when the tab/doc is left (hidden,
#   navigated away, or closed) - carries a client-computed duration. This is
#   a TAB LIFECYCLE signal, not something observed in Coda's own network
#   traffic - see this module's own docstring.
# doc_content_captured: fired once the page's rendered content has settled
#   after open, and again right before doc_session_end - carries the
#   extension's best-effort DOM READ of the doc's visible text (NOT Coda's
#   own document model - there is no confirmed access to that, see
#   CAPTURE_CONTRACT.md's "Content capture" section). Every other provider
#   in this codebase deliberately never captures prompt/generation content -
#   this is the one exception, added on explicit request; see that same
#   section for the reasoning and the size cap this is truncated to.
EVENT_TYPE_DOC_OPEN = "doc_open"
EVENT_TYPE_DOC_SESSION_END = "doc_session_end"
EVENT_TYPE_DOC_CONTENT_CAPTURED = "doc_content_captured"
# page_name_updated: fired when the CURRENT page's URL-slug-derived name
# changes while its page_id (and doc_id) stay the same - i.e. the extension
# is still on the same page, but Coda's own router has caught up to a name
# it didn't have yet at doc_open. Confirmed real (2026-08-27, see
# CAPTURE_CONTRACT.md's "Pages" section): a freshly-created/renamed page's
# URL can still read the OLD default slug ("Untitled-page") for a beat after
# doc_open - there is no live DOM source for a page's name the way
# document.title is for the doc's, so the only way to catch a same-page
# rename is to keep re-checking the URL for as long as the session stays
# open (the extension's existing 1s backstop poll does this) and report a
# correction when it lands, rather than carrying the stale name for the rest
# of the session with no way to fix it.
EVENT_TYPE_PAGE_NAME_UPDATED = "page_name_updated"

ALL_EVENT_TYPES = frozenset({
    EVENT_TYPE_DOC_OPEN,
    EVENT_TYPE_DOC_SESSION_END,
    EVENT_TYPE_DOC_CONTENT_CAPTURED,
    EVENT_TYPE_PAGE_NAME_UPDATED,
})

# Hard cap on stored doc content - a runaway/pathological doc (or a DOM-read
# heuristic gone wrong, pulling in something far larger than an actual
# document) must never turn into an unbounded TEXT column write. Generous
# for genuine document text (a very long report is still well under this).
MAX_CONTENT_TEXT_CHARS = 200_000

CAPTURE_SOURCE_PAGE_LOAD = "page_load"
CAPTURE_SOURCE_TAB_LIFECYCLE = "tab_lifecycle"

# GrammarlyDocSession.ownership_status values (mirrors SpliceDownload's).
OWNERSHIP_STATUS_UNKNOWN = "unknown"
OWNERSHIP_STATUS_RESOLVED = "resolved"

# A session that started but never got a doc_session_end event (crashed tab,
# extension reload, browser killed) should not report an unbounded duration.
# normalization.py caps duration_seconds at this ceiling when reconciling a
# stale-but-unclosed session - see normalization.py's own comment.
MAX_SESSION_DURATION_SECONDS = 4 * 60 * 60  # 4 hours
