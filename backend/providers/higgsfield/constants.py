# providers/higgsfield/constants.py
"""
Central place for Higgsfield provider literals. Every other module in this
package (capture.py, normalization.py, sync.py, router.py, queries.py)
imports from here instead of repeating string literals - mirrors
providers/heygen/constants.py, which is this package's template (chosen over
Freepik's since Higgsfield, like HeyGen, is a single-preset-per-click video
generator with multiple distinct capture-worthy actions, not Freepik's
multi-model-per-prompt image tool).

No real Higgsfield network traffic has been observed while building this -
only one UI screenshot (higgsfield.ai/ai/video, Create Video tab: image
upload, a "Seedance Pro" preset picker with a "Change" button, a Multi-shot
toggle, a Prompt textarea with "Enhance on", a "Generate ⚡4" button showing
an inline credit cost). Every field name/shape below is a provisional best
guess from that screenshot and this package's own DOM-scrape envelope, the
same starting posture HeyGen shipped with on 2026-08-04 - see
providers/heygen/normalization.py's module docstring and
providers/registry.py's HeyGen entry for how many real-traffic correction
passes that needed. Tighten every value here once a real captured
request/response is available, don't guess further.
"""

PROVIDER = "higgsfield"
PROVIDER_DISPLAY = "Higgsfield"

# it_portal_tools.slug values that map to this provider. Higgsfield is
# already registered under the single 'higgsfield' slug (id=7) for
# login-autofill purposes - no aliases, one domain family, same shape as
# HeyGen's own single-slug TOOL_SLUGS.
TOOL_SLUGS = frozenset({"higgsfield"})

# No webhook/server push exists for Higgsfield's generation APIs (assumed
# session-cookie-authenticated internal endpoints, not a key-authenticated
# developer API, same as every other provider in this package) - capture is
# entirely dependent on a browser tab being open through our launcher.
RELIABILITY_CLASS_BEST_EFFORT = "best_effort"
RELIABILITY_CLASS_LOSSLESS = "lossless"
RELIABILITY_CLASS = RELIABILITY_CLASS_BEST_EFFORT

# How many events share one COMMIT on the ingest and normalization paths -
# same reasoning as providers/heygen/constants.py's INGEST_COMMIT_CHUNK_SIZE.
INGEST_COMMIT_CHUNK_SIZE = 50

# Written into HiggsfieldCaptureEvent.capture_version by the capture
# endpoint. Bump when the raw payload_json shape changes in a way
# normalization.py needs to branch on.
CAPTURE_SCHEMA_VERSION = 1

# HiggsfieldCaptureEvent.event_type values. Three distinct click events
# because the Higgsfield UI has three top-level generation tabs (Create
# Video / Edit Video / Motion Control, per the screenshot's own tab bar) -
# same "each real credit-consuming action is its own event type" decision
# HeyGen made for its Generate/Render Scene split.
EVENT_TYPE_VIDEO_GENERATE_CLICK = "video_generate_click"
EVENT_TYPE_EDIT_VIDEO_CLICK = "edit_video_click"
EVENT_TYPE_MOTION_CONTROL_CLICK = "motion_control_click"
EVENT_TYPE_NETWORK_SNAPSHOT = "network_snapshot"
# One row from a not-yet-confirmed Higgsfield history/listing endpoint,
# passively observed whenever the user's own browsing happens to trigger
# that request - always is_reconciliation=true, mirrors HeyGen's
# EVENT_TYPE_GENERATION_LISTING_ROW/content-heygen.js's
# onHeygenNetworkListingMessage reasoning exactly (a bulk historical listing
# must never be attributed the same way a single armed click is).
EVENT_TYPE_GENERATION_LISTING_ROW = "generation_listing_row"
# One row from a not-yet-confirmed Higgsfield credit-ledger endpoint -
# scaffolded the same way HeyGen's EVENT_TYPE_CREDIT_LEDGER_ROW was before
# movio_bill.list was confirmed (see content-higgsfield-network.js's
# HIGGSFIELD_REQUEST_CREDIT_LEDGER listener, which exists but has no real
# URL wired in yet).
EVENT_TYPE_CREDIT_LEDGER_ROW = "credit_ledger_row"

ALL_EVENT_TYPES = frozenset(
    {
        EVENT_TYPE_VIDEO_GENERATE_CLICK,
        EVENT_TYPE_EDIT_VIDEO_CLICK,
        EVENT_TYPE_MOTION_CONTROL_CLICK,
        EVENT_TYPE_NETWORK_SNAPSHOT,
        EVENT_TYPE_GENERATION_LISTING_ROW,
        EVENT_TYPE_CREDIT_LEDGER_ROW,
    }
)

# How the extension obtained a given raw event - informational (lives in
# payload_json/generation_method, not its own column), mirrors HeyGen's
# CAPTURE_SOURCE_* constants.
CAPTURE_SOURCE_NETWORK_INTERCEPT = "network_intercept"
CAPTURE_SOURCE_DOM_CAPTURE = "dom_capture"
CAPTURE_SOURCE_HISTORY_SCAN = "history_scan"

# HiggsfieldGeneration.generation_source values - which pipeline produced
# the row.
GENERATION_SOURCE_LIVE_CAPTURE = "live_capture"
GENERATION_SOURCE_RECONCILIATION = "reconciliation"

# HiggsfieldGeneration.ingestion_source values (mirrors GenerationRecord's).
INGESTION_SOURCE_CAPTURED = "captured"
INGESTION_SOURCE_RECOVERED = "recovered"

# HiggsfieldGeneration.ownership_status values (mirrors GenerationRecord's).
OWNERSHIP_STATUS_UNKNOWN = "unknown"
OWNERSHIP_STATUS_RESOLVED = "resolved"

# HiggsfieldGeneration.ownership_source values.
OWNERSHIP_SOURCE_USAGE_TICKET = "usage_ticket"
OWNERSHIP_SOURCE_EXTENSION_TICKET = "extension_ticket"
OWNERSHIP_SOURCE_SESSION = "session"
OWNERSHIP_SOURCE_USER_CLAIMED = "user_claimed"

# Higgsfield's own lifecycle status values - unconfirmed guesses at a
# plausible state machine (submitted -> queued/processing -> completed, or
# -> failed/cancelled), informational only, never validated/rejected
# against - normalization.py's status mapping degrades gracefully for any
# string it doesn't recognize.
GENERATION_STATUS_PENDING = "pending"
GENERATION_STATUS_QUEUED = "queued"
GENERATION_STATUS_PROCESSING = "processing"
GENERATION_STATUS_RENDERING = "rendering"
GENERATION_STATUS_COMPLETED = "completed"
GENERATION_STATUS_FAILED = "failed"
GENERATION_STATUS_CANCELLED = "cancelled"

# HiggsfieldRecoveryAudit.action_type values.
RECOVERY_ACTION_ANALYZE = "analyze"
RECOVERY_ACTION_IMPORT = "import"

# HiggsfieldSyncCursor.status values.
SYNC_STATUS_IDLE = "idle"
SYNC_STATUS_RUNNING = "running"
SYNC_STATUS_FAILED = "failed"

# HiggsfieldCaptureHealth derived `status` (computed at read time in
# health.py - never stored). Priority when multiple rules match:
# OFFLINE > BACKLOGGED > DEGRADED > HEALTHY.
HEALTH_STATUS_HEALTHY = "healthy"
HEALTH_STATUS_DEGRADED = "degraded"
HEALTH_STATUS_BACKLOGGED = "backlogged"
HEALTH_STATUS_OFFLINE = "offline"

# A ping older than this is treated as OFFLINE even if offline_since wasn't
# explicitly set - same reasoning as every other provider's
# HEALTH_STALE_PING_THRESHOLD_SECONDS.
HEALTH_STALE_PING_THRESHOLD_SECONDS = 15 * 60

# queue_length at or above this is BACKLOGGED rather than merely DEGRADED.
HEALTH_BACKLOG_QUEUE_LENGTH_THRESHOLD = 500

# Hard server-side ownership safety net (normalization.py) - identical
# reasoning to every other provider's OWNERSHIP_FRESHNESS_WINDOW_SECONDS: a
# non-reconciliation capture event is only actually attributed to its
# ticket-resolved user if the generation's own timestamp falls within this
# many seconds of when the server received it.
OWNERSHIP_FRESHNESS_WINDOW_SECONDS = 15 * 60
