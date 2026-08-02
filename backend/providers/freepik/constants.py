# providers/freepik/constants.py
"""
Central place for Freepik/Magnific provider literals. Every other module in
this package (capture.py, normalization.py, sync.py, router.py, queries.py)
imports from here instead of repeating string literals - see
providers/chatgpt/constants.py for the precedent this mirrors.
"""

PROVIDER = "freepik"
PROVIDER_DISPLAY = "Freepik / Magnific"

# it_portal_tools.slug values that map to this provider. "Freepik" in this
# codebase's launch/ticket system (background-main.js TOOL_SESSION_DOMAINS)
# already covers both freepik.com and magnific.com under the single 'freepik'
# tool slug - there is no separate "magnific" tool row.
TOOL_SLUGS = frozenset({"freepik", "magnific"})

# No webhook/server push exists for Freepik's "my creations" endpoint (it is
# a session-cookie-authenticated internal API, not Freepik's key-authenticated
# developer API) - capture is entirely dependent on a browser tab being open
# through our launcher, exactly like Kling. See CAPTURE_CONTRACT.md.
RELIABILITY_CLASS_BEST_EFFORT = "best_effort"
RELIABILITY_CLASS_LOSSLESS = "lossless"
RELIABILITY_CLASS = RELIABILITY_CLASS_BEST_EFFORT

# How many events share one COMMIT on the ingest and normalization paths.
# A capture batch can carry 200 events (schemas.CaptureEventsRequest); at one
# COMMIT per event per stage that was up to 400 sequential round-trips to a
# hosted pooler on a single held connection. Per-event SAVEPOINTs keep the
# isolation that motivated per-event commits in the first place (one event
# losing a concurrent-insert race must not roll back its siblings) while
# paying for a real COMMIT only once per chunk.
INGEST_COMMIT_CHUNK_SIZE = 50

# Written into FreepikCaptureEvent.capture_version by the capture endpoint.
# Bump when the raw payload_json shape changes in a way normalization.py
# needs to branch on - Freepik's API is unofficial/reverse-engineered and can
# change without notice.
CAPTURE_SCHEMA_VERSION = 1

# FreepikCaptureEvent.event_type values.
EVENT_TYPE_GENERATION_SUBMITTED = "generation_submitted"
EVENT_TYPE_GENERATION_LISTING_ROW = "generation_listing_row"

ALL_EVENT_TYPES = frozenset(
    {
        EVENT_TYPE_GENERATION_SUBMITTED,
        EVENT_TYPE_GENERATION_LISTING_ROW,
    }
)

# How the extension obtained a given raw event - informational (lives in
# payload_json/generation_method, not its own column), mirrors ChatGPT's
# CAPTURE_SOURCE_* constants.
CAPTURE_SOURCE_NETWORK_INTERCEPT = "network_intercept"
CAPTURE_SOURCE_HISTORY_SCAN = "history_scan"

# FreepikGeneration.generation_source values - which pipeline produced the
# row in the first place.
GENERATION_SOURCE_LIVE_CAPTURE = "live_capture"
GENERATION_SOURCE_RECONCILIATION = "reconciliation"

# FreepikGeneration.ingestion_source values (mirrors GenerationRecord's).
INGESTION_SOURCE_CAPTURED = "captured"
INGESTION_SOURCE_RECOVERED = "recovered"

# FreepikGeneration.ownership_status values (mirrors GenerationRecord's).
OWNERSHIP_STATUS_UNKNOWN = "unknown"
OWNERSHIP_STATUS_RESOLVED = "resolved"

# FreepikGeneration.ownership_source values.
OWNERSHIP_SOURCE_USAGE_TICKET = "usage_ticket"
OWNERSHIP_SOURCE_EXTENSION_TICKET = "extension_ticket"
OWNERSHIP_SOURCE_SESSION = "session"
OWNERSHIP_SOURCE_USER_CLAIMED = "user_claimed"

# Freepik's own top-level `status` values as observed in the sample response
# (creation.status / row status) - informational, used for success/failure
# rate analytics (Phase 7), never validated/rejected against.
GENERATION_STATUS_COMPLETED = "completed"
GENERATION_STATUS_FAILED = "failed"
GENERATION_STATUS_PENDING = "pending"
GENERATION_STATUS_PROCESSING = "processing"

# FreepikRecoveryAudit.action_type values.
RECOVERY_ACTION_ANALYZE = "analyze"
RECOVERY_ACTION_IMPORT = "import"

# FreepikSyncCursor.status values.
SYNC_STATUS_IDLE = "idle"
SYNC_STATUS_RUNNING = "running"
SYNC_STATUS_FAILED = "failed"

# FreepikCaptureHealth derived `status` (computed at read time in health.py -
# never stored). Priority when multiple rules match: OFFLINE > BACKLOGGED > DEGRADED > HEALTHY.
HEALTH_STATUS_HEALTHY = "healthy"
HEALTH_STATUS_DEGRADED = "degraded"
HEALTH_STATUS_BACKLOGGED = "backlogged"
HEALTH_STATUS_OFFLINE = "offline"

# A ping older than this is treated as OFFLINE even if offline_since wasn't
# explicitly set - same reasoning as ChatGPT's HEALTH_STALE_PING_THRESHOLD_SECONDS.
HEALTH_STALE_PING_THRESHOLD_SECONDS = 15 * 60

# queue_length at or above this is BACKLOGGED rather than merely DEGRADED.
HEALTH_BACKLOG_QUEUE_LENGTH_THRESHOLD = 500

# Freepik's "my creations" listing endpoint pages 50-at-a-time in the sample
# response (meta.pagination.per_page) - kept here so sync.py and the
# extension-facing docs share one source of truth for the expected page size.
LISTING_PAGE_SIZE = 50

# Above this many consecutive already-known creation_ids while walking the
# listing pages newest-first, an incremental reconciliation walk stops - the
# rest of the backlog is assumed already captured. A full (admin-triggered)
# reconciliation ignores this and walks every page regardless.
INCREMENTAL_STOP_AFTER_KNOWN_PAGES = 2

# Hard server-side ownership safety net (normalization.py). Freepik's "my
# creations" listing endpoint returns the account's ENTIRE history on every
# page load - not just what the current tab's employee just generated. The
# extension's own capture logic tries to only report freshly-generated rows
# (see content-freepik.js), but the server must not simply trust that: a
# non-reconciliation capture event is only actually attributed to its
# ticket-resolved user if the generation's own timestamp (creation.created_at)
# falls within this many seconds of when the server received it. Anything
# older is treated exactly like a reconciliation import for ownership
# purposes (ownership_status stays/becomes 'unknown') regardless of what
# ownership_confidence the client claimed - this is what actually prevents
# "opening the Freepik gallery re-attributes someone else's old generations
# to me" even if the extension has a bug or an old version is still deployed.
OWNERSHIP_FRESHNESS_WINDOW_SECONDS = 15 * 60
