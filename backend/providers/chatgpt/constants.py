# providers/chatgpt/constants.py
"""
Central place for ChatGPT provider literals. Every future module in this
package (capture.py, router.py, services.py, analytics.py, recovery.py)
should import from here instead of repeating string literals, so a rename
(e.g. "chatgpt" -> "openai") or a new supported model is a one-file change.
"""

PROVIDER = "chatgpt"
PROVIDER_DISPLAY = "ChatGPT"

# Extension retry-queue reliability class (see EXTENSION_CAPTURE_DESIGN.md
# "Queue behavior under connectivity loss"). Kling's usage-event queue is
# BEST_EFFORT (drops after USAGE_EVENT_RETRY_MAX_ATTEMPTS) - a conversation
# is worth more than a generate-click, so ChatGPT capture never intentionally
# discards a queued event.
RELIABILITY_CLASS_BEST_EFFORT = "best_effort"
RELIABILITY_CLASS_LOSSLESS = "lossless"
RELIABILITY_CLASS = RELIABILITY_CLASS_LOSSLESS

# it_portal_tools.slug values that map to this provider (mirrors the
# _canonical_tool_slug alias handling already in routers/it_tools_router.py).
TOOL_SLUGS = frozenset({"chatgpt", "chat-gpt"})

# Informational only (not enforced/validated against) - extend as OpenAI
# ships new models. Used for filter dropdowns / analytics labeling.
SUPPORTED_MODELS = [
    "gpt-5",
    "gpt-5-mini",
    "gpt-4.1",
    "gpt-4o",
    "o3",
    "o4-mini",
]

# Written into ConversationCaptureEvent.capture_version by the capture
# endpoint (Phase 2A). Bump when the raw event payload_json shape changes in
# a way that the normalization step (Phase 3) needs to branch on.
CAPTURE_SCHEMA_VERSION = 1

# ConversationCaptureEvent.event_type values. Streaming deltas are NOT an
# event type here on purpose - only the start and the final assembled result
# are ever worth a network round-trip (see providers/chatgpt/README.md,
# "Streaming capture"). event_type is a plain routing/validation tag; the
# actual content lives in payload_json, not in additional typed columns.
EVENT_TYPE_CONVERSATION_OPENED = "conversation_opened"
EVENT_TYPE_CONVERSATION_CREATED = "conversation_created"
EVENT_TYPE_CONVERSATION_UPDATED = "conversation_updated"
EVENT_TYPE_CONVERSATION_RENAMED = "conversation_renamed"
EVENT_TYPE_CONVERSATION_ARCHIVED = "conversation_archived"
EVENT_TYPE_CONVERSATION_DELETED = "conversation_deleted"
EVENT_TYPE_PROMPT_CAPTURED = "prompt_captured"
EVENT_TYPE_MESSAGE_EDITED = "message_edited"
EVENT_TYPE_RESPONSE_STARTED = "response_started"
EVENT_TYPE_RESPONSE_COMPLETED = "response_completed"
EVENT_TYPE_GENERATION_CAPTURED = "generation_captured"
EVENT_TYPE_FILE_UPLOAD_DETECTED = "file_upload_detected"
EVENT_TYPE_FILE_DOWNLOAD_DETECTED = "file_download_detected"

ALL_EVENT_TYPES = frozenset(
    {
        EVENT_TYPE_CONVERSATION_OPENED,
        EVENT_TYPE_CONVERSATION_CREATED,
        EVENT_TYPE_CONVERSATION_UPDATED,
        EVENT_TYPE_CONVERSATION_RENAMED,
        EVENT_TYPE_CONVERSATION_ARCHIVED,
        EVENT_TYPE_CONVERSATION_DELETED,
        EVENT_TYPE_PROMPT_CAPTURED,
        EVENT_TYPE_MESSAGE_EDITED,
        EVENT_TYPE_RESPONSE_STARTED,
        EVENT_TYPE_RESPONSE_COMPLETED,
        EVENT_TYPE_GENERATION_CAPTURED,
        EVENT_TYPE_FILE_UPLOAD_DETECTED,
        EVENT_TYPE_FILE_DOWNLOAD_DETECTED,
    }
)

# Extension-reported capture source (informational, goes in payload_json -
# not a column - since it describes how the extension obtained the event,
# not what the event means).
CAPTURE_SOURCE_NETWORK_INTERCEPT = "network_intercept"
CAPTURE_SOURCE_DOM_FALLBACK = "dom_fallback"
CAPTURE_SOURCE_SIDEBAR_SCAN = "sidebar_scan"

# ConversationRecord.ingestion_source values.
INGESTION_SOURCE_CAPTURED = "captured"
INGESTION_SOURCE_RECOVERED = "recovered"

# ConversationRecord.ownership_status values.
OWNERSHIP_STATUS_UNKNOWN = "unknown"
OWNERSHIP_STATUS_RESOLVED = "resolved"

# ConversationGeneratedAsset.output_type values.
OUTPUT_TYPES = ("image", "chart", "canvas", "code", "document", "table", "download", "file")

# ConversationMediaAsset.media_type values (additive media capture layer -
# see providers/chatgpt/media.py). Deliberately NOT added to ALL_EVENT_TYPES/
# the raw ConversationCaptureEvent log - media capture follows the same
# pattern attachments.py already established for binary uploads (its own
# docstring: "an attachment is a large binary upload, not a tiny JSON event"),
# going straight to POST /capture/media -> ConversationMediaAsset, not
# through the lossless raw-event queue.
MEDIA_TYPE_GENERATED_IMAGE = "generated_image"
MEDIA_TYPE_GENERATED_VIDEO = "generated_video"
MEDIA_TYPE_RESPONSE_IMAGE = "response_image"
MEDIA_TYPE_RESPONSE_VIDEO = "response_video"
MEDIA_TYPES = (
    MEDIA_TYPE_GENERATED_IMAGE,
    MEDIA_TYPE_GENERATED_VIDEO,
    MEDIA_TYPE_RESPONSE_IMAGE,
    MEDIA_TYPE_RESPONSE_VIDEO,
)

# ConversationMediaAsset.status values.
MEDIA_STATUS_PENDING = "pending"
MEDIA_STATUS_STORED = "stored"
MEDIA_STATUS_FAILED = "failed"

# ConversationMediaAsset.enrichment_status - deliberately separate from
# `status` above. `status` describes whether we have the asset's actual
# bytes/URL (the thing that matters for rendering it in a gallery);
# `enrichment_status` describes whether the richer authoritative-fetch-only
# fields (provider_asset_id, prompt) have been attached yet. A DOM/network-
# discovered asset is fully STORED and displayable while still PENDING
# enrichment - the two are independent axes on purpose, so an authoritative-
# fetch outage (see RESPONSE_RECONSTRUCTION_REPORT.md) degrades captured
# assets to "missing a caption/id", never to "missing entirely".
ENRICHMENT_STATUS_PENDING = "pending"
ENRICHMENT_STATUS_ENRICHED = "enriched"

# ConversationCaptureHealth derived `status` (computed at read time in
# health.py - never stored, since "is the last ping stale" changes with wall
# clock time even when no new ping arrives). Priority order when multiple
# rules match: OFFLINE > BACKLOGGED > DEGRADED > HEALTHY.
HEALTH_STATUS_HEALTHY = "healthy"
HEALTH_STATUS_DEGRADED = "degraded"
HEALTH_STATUS_BACKLOGGED = "backlogged"
HEALTH_STATUS_OFFLINE = "offline"

# A ping older than this is treated as OFFLINE even if offline_since wasn't
# explicitly set - an extension that stopped pinging entirely (crashed,
# uninstalled, browser closed) looks identical to one that reported nothing,
# and both should read as "we don't currently know this is healthy".
HEALTH_STALE_PING_THRESHOLD_SECONDS = 15 * 60

# queue_length at or above this is BACKLOGGED rather than merely DEGRADED.
HEALTH_BACKLOG_QUEUE_LENGTH_THRESHOLD = 500
