# providers/envato/constants.py
"""
Central place for Envato provider literals - mirrors
providers/freepik/constants.py's structure exactly (see that file's own
docstring for why this pattern exists).

Envato (app.envato.com) is a React Router 7 app: ImageGen, ImageEdit,
VideoGen, MusicGen, VoiceGen, SoundGen, GraphicsGen and MockupGen all funnel
their history into one shared `/generation-history.data` route-loader
endpoint, which returns every item type in one paginated list - confirmed by
inspecting a real captured HAR (2026-08-07). Only `genai-image` rows were
actually present in that capture; the other five ITEM_TYPES values are
inferred from the endpoint's own filter-chip i18n keys
(generationHistory.filter.assetType.*), not yet observed in a real payload -
see normalization.py's _extract_fields for how that uncertainty is handled
(generic field mapping + a full metadata_json catch-all, nothing discarded).
"""

PROVIDER = "envato"
PROVIDER_DISPLAY = "Envato"

# it_portal_tools.slug values that map to this provider.
TOOL_SLUGS = frozenset({"envato"})

# Envato's `.data` route-loader responses are session-cookie-authenticated,
# not a public/keyed API - same posture as Freepik's "my creations" endpoint.
# Capture depends entirely on a browser tab open through our launcher.
RELIABILITY_CLASS_BEST_EFFORT = "best_effort"
RELIABILITY_CLASS = RELIABILITY_CLASS_BEST_EFFORT

# How many events share one COMMIT on the ingest and normalization paths -
# see providers/freepik/constants.py's INGEST_COMMIT_CHUNK_SIZE for the
# reasoning this mirrors verbatim.
INGEST_COMMIT_CHUNK_SIZE = 50

# Written into EnvatoCaptureEvent.capture_version by the capture endpoint.
# Bump when the raw payload_json shape changes in a way normalization.py
# needs to branch on - Envato's `.data` endpoints are unofficial/reverse-
# engineered (decoded from React Router's turbo-stream wire format) and can
# change without notice.
CAPTURE_SCHEMA_VERSION = 1

# EnvatoCaptureEvent.event_type values. Unlike Freepik, both of these carry
# the SAME payload shape (one decoded `generation-history` item) - the
# distinction is purely provenance (which pipeline produced the event), not a
# different extraction path in normalization.py.
EVENT_TYPE_GENERATION_LISTING_ROW = "generation_listing_row"  # discovered by the reconciliation walker paging generation-history.data
EVENT_TYPE_GENERATION_SUBMITTED = "generation_submitted"  # discovered via the Generate-click arm+correlate window
# Added for Envato Elements (elements.envato.com) stock-asset downloads - see
# EnvatoDownload's own docstring in models.py for why this is a separate
# table/event type from a generation (a downloaded stock asset has no
# itemUuid at all). Mirrors Freepik's EVENT_TYPE_DOWNLOAD_CLICK exactly,
# including the "gated behind Task/Client, unlike a free-form search" call.
EVENT_TYPE_DOWNLOAD_CLICK = "download_click"

ALL_EVENT_TYPES = frozenset({EVENT_TYPE_GENERATION_LISTING_ROW, EVENT_TYPE_GENERATION_SUBMITTED, EVENT_TYPE_DOWNLOAD_CLICK})

# How the extension obtained a given raw event.
CAPTURE_SOURCE_NETWORK_INTERCEPT = "network_intercept"
CAPTURE_SOURCE_HISTORY_SCAN = "history_scan"

# EnvatoGeneration.itemType values - see this file's own module docstring for
# which of these are confirmed vs inferred.
ITEM_TYPE_IMAGE = "genai-image"    # confirmed
ITEM_TYPE_VIDEO = "genai-video"    # inferred
ITEM_TYPE_VECTOR = "genai-vector"  # inferred - GraphicsGen
ITEM_TYPE_VOICE = "genai-voice"    # inferred
ITEM_TYPE_MUSIC = "genai-music"    # inferred
ITEM_TYPE_SOUND = "genai-sound"    # inferred

ALL_ITEM_TYPES = frozenset({
    ITEM_TYPE_IMAGE, ITEM_TYPE_VIDEO, ITEM_TYPE_VECTOR,
    ITEM_TYPE_VOICE, ITEM_TYPE_MUSIC, ITEM_TYPE_SOUND,
})

# EnvatoGeneration.generation_source values - which pipeline produced the row.
GENERATION_SOURCE_LIVE_CAPTURE = "live_capture"
GENERATION_SOURCE_RECONCILIATION = "reconciliation"

# EnvatoGeneration.ingestion_source values (mirrors GenerationRecord's).
INGESTION_SOURCE_CAPTURED = "captured"
INGESTION_SOURCE_RECOVERED = "recovered"

# EnvatoGeneration.ownership_status values (mirrors GenerationRecord's).
OWNERSHIP_STATUS_UNKNOWN = "unknown"
OWNERSHIP_STATUS_RESOLVED = "resolved"

# EnvatoGeneration.ownership_source values.
OWNERSHIP_SOURCE_USAGE_TICKET = "usage_ticket"
OWNERSHIP_SOURCE_EXTENSION_TICKET = "extension_ticket"
OWNERSHIP_SOURCE_SESSION = "session"
OWNERSHIP_SOURCE_USER_CLAIMED = "user_claimed"

# FreepikRecoveryAudit-equivalent action types.
RECOVERY_ACTION_ANALYZE = "analyze"
RECOVERY_ACTION_IMPORT = "import"

# EnvatoSyncCursor.status values.
SYNC_STATUS_IDLE = "idle"
SYNC_STATUS_RUNNING = "running"
SYNC_STATUS_FAILED = "failed"

# EnvatoCaptureHealth derived `status` (computed at read time in health.py -
# never stored). Priority when multiple rules match: OFFLINE > BACKLOGGED > DEGRADED > HEALTHY.
HEALTH_STATUS_HEALTHY = "healthy"
HEALTH_STATUS_DEGRADED = "degraded"
HEALTH_STATUS_BACKLOGGED = "backlogged"
HEALTH_STATUS_OFFLINE = "offline"

# A ping older than this is treated as OFFLINE even if offline_since wasn't
# explicitly set.
HEALTH_STALE_PING_THRESHOLD_SECONDS = 15 * 60

# queue_length at or above this is BACKLOGGED rather than merely DEGRADED.
HEALTH_BACKLOG_QUEUE_LENGTH_THRESHOLD = 500

# Envato's generation-history listing pages 24-at-a-time in the confirmed
# sample response (both the initial loader and the `actionType=loadMore`
# POST action returned 24 items) - kept here so sync.py and the extension's
# reconciliation walker share one source of truth for the expected page size.
LISTING_PAGE_SIZE = 24

# Above this many consecutive already-known item_uuids while walking the
# listing pages newest-first, an incremental reconciliation walk stops.
INCREMENTAL_STOP_AFTER_KNOWN_PAGES = 2

# Hard server-side ownership safety net (normalization.py) - see
# providers/freepik/constants.py's OWNERSHIP_FRESHNESS_WINDOW_SECONDS
# docstring for the full reasoning this mirrors verbatim. A capture event
# only gets to SET ownership if the generation's own createdAt is within this
# many seconds of when the server received it; anything older is treated like
# a reconciliation import for ownership purposes regardless of what
# ownership_confidence the client claimed.
OWNERSHIP_FRESHNESS_WINDOW_SECONDS = 15 * 60
