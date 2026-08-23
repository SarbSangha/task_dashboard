# providers/suno/constants.py
"""
Central place for Suno (suno.com) provider literals. Structurally copied from
providers/elevenlabs/constants.py - see that file's own docstring for the
RELIABILITY_CLASS rationale this reuses. Suno, like ElevenLabs/Flow/Freepik,
is reached through a dashboard-issued launch ticket rather than an
app-session-authenticated request, and has no server-push completion signal -
capture is entirely dependent on a browser tab being open through the
launcher.

Unlike ElevenLabs, Suno's response body shape IS confirmed from real traffic
(a live DevTools capture of `POST /api/feed/v3`'s response, 2026-08-17) - see
CAPTURE_CONTRACT.md for the full payload and its "Known gaps" section for
what is still NOT confirmed (terminal status value, credits formula,
generate-submission endpoint, the feed/v3 request body).
"""

PROVIDER = "suno"
PROVIDER_DISPLAY = "Suno"

# it_portal_tools.slug values that map to this provider.
TOOL_SLUGS = frozenset({"suno"})

RELIABILITY_CLASS_BEST_EFFORT = "best_effort"
RELIABILITY_CLASS_LOSSLESS = "lossless"
RELIABILITY_CLASS = RELIABILITY_CLASS_BEST_EFFORT

# How many events share one COMMIT on the ingest and normalization paths -
# see providers/freepik/constants.py's identical constant for the full
# reasoning (per-event SAVEPOINT isolation, COMMIT once per chunk).
INGEST_COMMIT_CHUNK_SIZE = 50

# Written into SunoCaptureEvent.capture_version by the capture endpoint.
# Bump when the raw payload_json shape changes in a way normalization.py
# needs to branch on.
CAPTURE_SCHEMA_VERSION = 1

# SunoCaptureEvent.event_type values. Suno only makes music - there is no
# ElevenLabs-style TTS/Music/SFX multi-surface split, so one event type
# covers every captured clip (a row of `POST /api/feed/v3`'s `clips` array).
EVENT_TYPE_CLIP = "clip"

ALL_EVENT_TYPES = frozenset({EVENT_TYPE_CLIP})

# How the extension obtained a given raw event - informational, mirrors
# ElevenLabs/Flow/Freepik's CAPTURE_SOURCE_* constants. Named "feed_scan"
# rather than ElevenLabs' "history_scan" since Suno's reconciliation source
# is the feed endpoint, not a history endpoint.
CAPTURE_SOURCE_NETWORK_INTERCEPT = "network_intercept"
CAPTURE_SOURCE_FEED_SCAN = "feed_scan"

# SunoGeneration.generation_source values - which pipeline produced the row.
GENERATION_SOURCE_LIVE_CAPTURE = "live_capture"
GENERATION_SOURCE_RECONCILIATION = "reconciliation"

# SunoGeneration.ingestion_source values (mirrors GenerationRecord's).
INGESTION_SOURCE_CAPTURED = "captured"
INGESTION_SOURCE_RECOVERED = "recovered"

# SunoGeneration.ownership_status values (mirrors GenerationRecord's).
OWNERSHIP_STATUS_UNKNOWN = "unknown"
OWNERSHIP_STATUS_RESOLVED = "resolved"

# SunoGeneration.ownership_source values.
OWNERSHIP_SOURCE_USAGE_TICKET = "usage_ticket"
OWNERSHIP_SOURCE_EXTENSION_TICKET = "extension_ticket"
OWNERSHIP_SOURCE_SESSION = "session"
OWNERSHIP_SOURCE_USER_CLAIMED = "user_claimed"

# Suno's own terminal generation status is NOT confirmed - only "streaming"
# has ever been observed on a real clip (see CAPTURE_CONTRACT.md's known-gaps
# section). Kept for parity with every other provider's constants module
# (and for _CAPTURE_STATUS_BY_PROVIDER_STATUS in normalization.py) in case
# one of these turns up once a completed/failed clip is captured.
GENERATION_STATUS_STREAMING = "streaming"  # the one CONFIRMED value seen so far
GENERATION_STATUS_COMPLETED = "completed"
GENERATION_STATUS_FAILED = "failed"
GENERATION_STATUS_PENDING = "pending"
GENERATION_STATUS_PROCESSING = "processing"

# Hard server-side ownership safety net (normalization.py) - identical
# reasoning and value to providers/elevenlabs/constants.py's and
# providers/freepik/constants.py's OWNERSHIP_FRESHNESS_WINDOW_SECONDS: a
# non-reconciliation capture event is only actually attributed to its
# ticket-resolved user if the generation's own timestamp falls within this
# many seconds of when the server received it, regardless of what confidence
# the client claimed.
OWNERSHIP_FRESHNESS_WINDOW_SECONDS = 15 * 60

# The confirmed real key identifying the "is this clip's audio actually
# ready" entry inside a clip's `action_config.actions[]` array - see
# CAPTURE_CONTRACT.md's "Readiness signal" section. `disabled: true` on this
# action means the real asset is not ready yet (its `action_override` carries
# the literal "You can download once your song's done generating." toast).
# Documented here (rather than acted on in normalization.py, which does not
# need it - see this module's own docstring) so the browser extension side
# has one canonical source for the key name.
READINESS_ACTION_TYPE = "download_song"
