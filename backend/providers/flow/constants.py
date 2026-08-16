# providers/flow/constants.py
"""
Central place for Flow (labs.google/fx/tools/flow) provider literals. Mirrors
providers/freepik/constants.py's structure and RELIABILITY_CLASS choice - see
that file's own docstring for the rationale this reuses. Flow, like Freepik,
is reached through a dashboard-issued launch ticket rather than an
app-session-authenticated request, and has no server-push completion signal -
capture is entirely dependent on a browser tab being open through the
launcher.
"""

PROVIDER = "flow"
PROVIDER_DISPLAY = "Google Flow"

# it_portal_tools.slug values that map to this provider - matches the single
# 'flow' slug already used everywhere in background-main.js
# (DIRECT_TICKET_ONLY_TOOLS, TOOL_SESSION_DOMAINS, CLEAR_SESSION_ON_CLOSE_TOOLS).
TOOL_SLUGS = frozenset({"flow"})

RELIABILITY_CLASS_BEST_EFFORT = "best_effort"
RELIABILITY_CLASS_LOSSLESS = "lossless"
RELIABILITY_CLASS = RELIABILITY_CLASS_BEST_EFFORT

# How many events share one COMMIT on the ingest and normalization paths -
# see providers/freepik/constants.py's identical constant for the full
# reasoning (per-event SAVEPOINT isolation, COMMIT once per chunk).
INGEST_COMMIT_CHUNK_SIZE = 50

# Written into FlowCaptureEvent.capture_version by the capture endpoint. Bump
# when the raw payload_json shape changes in a way normalization.py needs to
# branch on - aisandbox-pa.googleapis.com's flowWorkflows API is unofficial
# (observed via network capture, not a published contract) and can change
# without notice.
CAPTURE_SCHEMA_VERSION = 1

# FlowCaptureEvent.event_type values. Only one confirmed shape exists so far -
# a flowWorkflows/{uuid} PATCH response (see CAPTURE_CONTRACT.md). Unlike
# Freepik, Flow has no confirmed stock-search/existing-asset-download surface
# to route separately - if one turns out to exist later, follow Freepik's
# EVENT_TYPE_SEARCH_QUERY/EVENT_TYPE_DOWNLOAD_CLICK precedent (its own event
# type + its own table) rather than overloading this one.
EVENT_TYPE_GENERATION_WORKFLOW_ROW = "generation_workflow_row"

# The flowWorkflows PATCH response (above) only ever carries primaryMediaId,
# never an actual image URL - resolving one requires a SEPARATE network call
# (media.getMediaUrlRedirect?name={mediaId}, a 307 redirect to a signed CDN
# URL) that content-flow-network.js watches for independently. This event
# type carries just {mediaId, url} - pure enrichment of an existing
# FlowGeneration row (see normalization.py's _normalize_media_url_event), not
# a generation observation of its own, so it's never gated by the arm/click
# window the way EVENT_TYPE_GENERATION_WORKFLOW_ROW is.
EVENT_TYPE_MEDIA_URL_RESOLVED = "media_url_resolved"

ALL_EVENT_TYPES = frozenset({EVENT_TYPE_GENERATION_WORKFLOW_ROW, EVENT_TYPE_MEDIA_URL_RESOLVED})

# How the extension obtained a given raw event - informational, mirrors
# ChatGPT/Freepik's CAPTURE_SOURCE_* constants.
CAPTURE_SOURCE_NETWORK_INTERCEPT = "network_intercept"
CAPTURE_SOURCE_HISTORY_SCAN = "history_scan"

# FlowGeneration.generation_source values - which pipeline produced the row.
GENERATION_SOURCE_LIVE_CAPTURE = "live_capture"
GENERATION_SOURCE_RECONCILIATION = "reconciliation"

# FlowGeneration.ingestion_source values (mirrors GenerationRecord's).
INGESTION_SOURCE_CAPTURED = "captured"
INGESTION_SOURCE_RECOVERED = "recovered"

# FlowGeneration.ownership_status values (mirrors GenerationRecord's).
OWNERSHIP_STATUS_UNKNOWN = "unknown"
OWNERSHIP_STATUS_RESOLVED = "resolved"

# FlowGeneration.ownership_source values.
OWNERSHIP_SOURCE_USAGE_TICKET = "usage_ticket"
OWNERSHIP_SOURCE_EXTENSION_TICKET = "extension_ticket"
OWNERSHIP_SOURCE_SESSION = "session"
OWNERSHIP_SOURCE_USER_CLAIMED = "user_claimed"

# Flow's own generation status is NOT confirmed in any captured payload yet -
# the one confirmed flowWorkflows response carries no status field at all,
# just metadata.createTime/updateTime. Kept for parity with every other
# provider's constants module (and for _CAPTURE_STATUS_BY_PROVIDER_STATUS in
# normalization.py) in case a status field turns up once video generation
# (which may have a longer processing window) is captured live.
GENERATION_STATUS_COMPLETED = "completed"
GENERATION_STATUS_FAILED = "failed"
GENERATION_STATUS_PENDING = "pending"
GENERATION_STATUS_PROCESSING = "processing"

# Hard server-side ownership safety net (normalization.py) - identical
# reasoning and value to providers/freepik/constants.py's
# OWNERSHIP_FRESHNESS_WINDOW_SECONDS: a non-reconciliation capture event is
# only actually attributed to its ticket-resolved user if the generation's
# own timestamp falls within this many seconds of when the server received
# it, regardless of what confidence the client claimed.
OWNERSHIP_FRESHNESS_WINDOW_SECONDS = 15 * 60
