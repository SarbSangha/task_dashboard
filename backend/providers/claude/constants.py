# providers/claude/constants.py
"""
Central place for Claude (claude.ai) provider literals - mirrors
providers/chatgpt/constants.py's role for that provider. Every other module
in this package imports from here rather than repeating string literals.
"""

PROVIDER = "claude"
PROVIDER_DISPLAY = "Claude"

# See providers/chatgpt/constants.py's own comment on this classification.
# Claude capture reads the same authoritative endpoint ChatGPT only reaches
# via a best-effort re-fetch (GET .../chat_conversations/{id}) for every
# single turn, not just as a fallback - so there is no streamed/partial
# capture path to lose data to. A conversation is still worth more than a
# generate-click, so this is LOSSLESS the same as ChatGPT, not
# best-effort like Kling's usage-event queue.
RELIABILITY_CLASS_BEST_EFFORT = "best_effort"
RELIABILITY_CLASS_LOSSLESS = "lossless"
RELIABILITY_CLASS = RELIABILITY_CLASS_LOSSLESS

# it_portal_tools.slug values that map to this provider - "claude" is the
# only seeded slug (see db_migrations.py DEFAULT_TOOL_DIRECTORY).
TOOL_SLUGS = frozenset({"claude"})

# Informational only (not enforced/validated against) - extend as Anthropic
# ships new models. Used for filter dropdowns / analytics labeling.
SUPPORTED_MODELS = [
    "claude-sonnet-5",
    "claude-opus-5",
    "claude-fable-5-1",
    "claude-haiku-4-5",
]

# Written into ConversationCaptureEvent.capture_version by the capture
# endpoint. Bump when the raw event payload_json shape changes in a way that
# normalization.py needs to branch on.
CAPTURE_SCHEMA_VERSION = 1

# ConversationCaptureEvent.event_type values. Deliberately a smaller set than
# ChatGPT's - see CAPTURE_CONTRACT.md for why message_edited/
# generation_captured/file_upload_detected/file_download_detected aren't
# emitted yet (additive events for a future pass, same "documented but not
# yet produced" posture ChatGPT's own generation_captured already has).
EVENT_TYPE_CONVERSATION_OPENED = "conversation_opened"
EVENT_TYPE_CONVERSATION_CREATED = "conversation_created"
EVENT_TYPE_CONVERSATION_RENAMED = "conversation_renamed"
EVENT_TYPE_CONVERSATION_DELETED = "conversation_deleted"
EVENT_TYPE_PROMPT_CAPTURED = "prompt_captured"
EVENT_TYPE_RESPONSE_COMPLETED = "response_completed"

ALL_EVENT_TYPES = frozenset(
    {
        EVENT_TYPE_CONVERSATION_OPENED,
        EVENT_TYPE_CONVERSATION_CREATED,
        EVENT_TYPE_CONVERSATION_RENAMED,
        EVENT_TYPE_CONVERSATION_DELETED,
        EVENT_TYPE_PROMPT_CAPTURED,
        EVENT_TYPE_RESPONSE_COMPLETED,
    }
)

# ConversationRecord.ingestion_source values.
INGESTION_SOURCE_CAPTURED = "captured"

# ConversationRecord.ownership_status values.
OWNERSHIP_STATUS_UNKNOWN = "unknown"
OWNERSHIP_STATUS_RESOLVED = "resolved"

# ConversationCaptureHealth derived `status` (computed at read time in
# health.py - see providers/chatgpt/constants.py's own comment on why this
# is never stored). Priority when multiple rules match:
# OFFLINE > BACKLOGGED > DEGRADED > HEALTHY.
HEALTH_STATUS_HEALTHY = "healthy"
HEALTH_STATUS_DEGRADED = "degraded"
HEALTH_STATUS_BACKLOGGED = "backlogged"
HEALTH_STATUS_OFFLINE = "offline"
HEALTH_STATUS_NO_MESSAGES = "no_messages"

HEALTH_STALE_PING_THRESHOLD_SECONDS = 15 * 60
HEALTH_BACKLOG_QUEUE_LENGTH_THRESHOLD = 500
