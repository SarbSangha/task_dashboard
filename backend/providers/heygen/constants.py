# providers/heygen/constants.py
"""
Central place for HeyGen provider literals. Every other module in this
package (capture.py, normalization.py, sync.py, router.py, queries.py)
imports from here instead of repeating string literals - mirrors
providers/freepik/constants.py, which is this package's template.
"""

PROVIDER = "heygen"
PROVIDER_DISPLAY = "HeyGen"

# it_portal_tools.slug values that map to this provider. Confirmed against
# routers/it_tools_router.py's TOOL_SESSION_DOMAINS / autofill config - HeyGen
# has always been registered under the single 'heygen' slug (no aliases, one
# domain family), unlike Kling's three-alias slug set.
TOOL_SLUGS = frozenset({"heygen"})

# No webhook/server push exists for HeyGen's render/project APIs (they are
# session-cookie-authenticated internal endpoints, not a key-authenticated
# developer API) - capture is entirely dependent on a browser tab being open
# through our launcher, exactly like Freepik/Kling. See the module docstring
# in sync.py for what this means for reconciliation.
RELIABILITY_CLASS_BEST_EFFORT = "best_effort"
RELIABILITY_CLASS_LOSSLESS = "lossless"
RELIABILITY_CLASS = RELIABILITY_CLASS_BEST_EFFORT

# How many events share one COMMIT on the ingest and normalization paths -
# same reasoning as providers/freepik/constants.py's INGEST_COMMIT_CHUNK_SIZE.
INGEST_COMMIT_CHUNK_SIZE = 50

# Written into HeygenCaptureEvent.capture_version by the capture endpoint.
# Bump when the raw payload_json shape changes in a way normalization.py
# needs to branch on - HeyGen's internal API is unofficial/reverse-engineered
# (observed via network interception, not a published contract) and can
# change without notice.
CAPTURE_SCHEMA_VERSION = 1

# HeygenCaptureEvent.event_type values. Two distinct click events because the
# HeyGen UI has two different capture-worthy actions (see content-heygen.js):
# a per-scene "Render Scene" button and a top-level "Generate" button for the
# whole video - both are real credit-consuming generations and both are
# captured, per the product decision to treat them as separate events.
EVENT_TYPE_GENERATE_CLICK = "generate_click"
EVENT_TYPE_SCENE_RENDER_CLICK = "scene_render_click"
EVENT_TYPE_NETWORK_SNAPSHOT = "network_snapshot"
# One row from api2.heygen.com's project/items listing endpoint (confirmed
# 2026-08-04 - see content-heygen-network.js's extractListingRows), passively
# observed whenever the user's own browsing happens to trigger that request.
# Always is_reconciliation=true (never linked to an active arm/click) - see
# content-heygen.js's onHeygenNetworkListingMessage for why a bulk historical
# listing must never be attributed the same way a single armed click is.
EVENT_TYPE_GENERATION_LISTING_ROW = "generation_listing_row"
# One row from HeyGen's credit ledger (movio_bill.list), confirmed
# 2026-08-04 - {action_id, action_type, credit, ...}, where action_id equals
# the video's own id only when action_type == "video_generate" (see
# content-heygen-network.js's hasCreditLedgerShape). Thin by construction
# (only ever carries videoId + credits.used, nothing else) - always
# is_reconciliation=true, same reasoning as EVENT_TYPE_GENERATION_LISTING_ROW.
EVENT_TYPE_CREDIT_LEDGER_ROW = "credit_ledger_row"

ALL_EVENT_TYPES = frozenset(
    {
        EVENT_TYPE_GENERATE_CLICK,
        EVENT_TYPE_SCENE_RENDER_CLICK,
        EVENT_TYPE_NETWORK_SNAPSHOT,
        EVENT_TYPE_GENERATION_LISTING_ROW,
        EVENT_TYPE_CREDIT_LEDGER_ROW,
    }
)

# How the extension obtained a given raw event - informational (lives in
# payload_json/generation_method, not its own column), mirrors Freepik's
# CAPTURE_SOURCE_* constants.
CAPTURE_SOURCE_NETWORK_INTERCEPT = "network_intercept"
CAPTURE_SOURCE_DOM_CAPTURE = "dom_capture"
CAPTURE_SOURCE_HISTORY_SCAN = "history_scan"

# HeygenGeneration.generation_source values - which pipeline produced the row.
GENERATION_SOURCE_LIVE_CAPTURE = "live_capture"
GENERATION_SOURCE_RECONCILIATION = "reconciliation"

# HeygenGeneration.ingestion_source values (mirrors GenerationRecord's).
INGESTION_SOURCE_CAPTURED = "captured"
INGESTION_SOURCE_RECOVERED = "recovered"

# HeygenGeneration.ownership_status values (mirrors GenerationRecord's).
OWNERSHIP_STATUS_UNKNOWN = "unknown"
OWNERSHIP_STATUS_RESOLVED = "resolved"

# HeygenGeneration.ownership_source values.
OWNERSHIP_SOURCE_USAGE_TICKET = "usage_ticket"
OWNERSHIP_SOURCE_EXTENSION_TICKET = "extension_ticket"
OWNERSHIP_SOURCE_SESSION = "session"
OWNERSHIP_SOURCE_USER_CLAIMED = "user_claimed"

# HeyGen's own lifecycle status values, per the spec's state machine
# (pending -> queued -> processing/rendering -> completed, or -> failed /
# cancelled). Informational, used for success/failure rate analytics, never
# validated/rejected against - HeyGen may use different literal strings in
# practice, normalization.py's status mapping degrades gracefully for any it
# doesn't recognize.
GENERATION_STATUS_PENDING = "pending"
GENERATION_STATUS_QUEUED = "queued"
GENERATION_STATUS_PROCESSING = "processing"
GENERATION_STATUS_RENDERING = "rendering"
GENERATION_STATUS_COMPLETED = "completed"
GENERATION_STATUS_FAILED = "failed"
GENERATION_STATUS_CANCELLED = "cancelled"

# HeygenRecoveryAudit.action_type values.
RECOVERY_ACTION_ANALYZE = "analyze"
RECOVERY_ACTION_IMPORT = "import"

# HeygenSyncCursor.status values.
SYNC_STATUS_IDLE = "idle"
SYNC_STATUS_RUNNING = "running"
SYNC_STATUS_FAILED = "failed"

# HeygenCaptureHealth derived `status` (computed at read time in health.py -
# never stored). Priority when multiple rules match: OFFLINE > BACKLOGGED > DEGRADED > HEALTHY.
HEALTH_STATUS_HEALTHY = "healthy"
HEALTH_STATUS_DEGRADED = "degraded"
HEALTH_STATUS_BACKLOGGED = "backlogged"
HEALTH_STATUS_OFFLINE = "offline"

# A ping older than this is treated as OFFLINE even if offline_since wasn't
# explicitly set - same reasoning as Freepik's HEALTH_STALE_PING_THRESHOLD_SECONDS.
HEALTH_STALE_PING_THRESHOLD_SECONDS = 15 * 60

# queue_length at or above this is BACKLOGGED rather than merely DEGRADED.
HEALTH_BACKLOG_QUEUE_LENGTH_THRESHOLD = 500

# Hard server-side ownership safety net (normalization.py) - identical
# reasoning to Freepik's OWNERSHIP_FRESHNESS_WINDOW_SECONDS: a non-
# reconciliation capture event is only actually attributed to its ticket-
# resolved user if the generation's own timestamp falls within this many
# seconds of when the server received it. Anything older is treated like a
# reconciliation import for ownership purposes regardless of what
# ownership_confidence the client claimed.
OWNERSHIP_FRESHNESS_WINDOW_SECONDS = 15 * 60
