# providers/elevenlabs/constants.py
"""
Central place for ElevenLabs (elevenlabs.io) provider literals. Structurally
copied from providers/flow/constants.py - see that file's own docstring for
the RELIABILITY_CLASS rationale this reuses. ElevenLabs, like Flow/Freepik, is
reached through a dashboard-issued launch ticket rather than an
app-session-authenticated request, and has no server-push completion signal -
capture is entirely dependent on a browser tab being open through the
launcher.

Unlike Flow, ElevenLabs has only ONE confirmed piece of real traffic so far -
a `GET /v1/history?page_size=20&source=TTS&sort_direction=desc` *request*
observed in a DevTools screenshot, not a full HAR capture. The response body
shape is NOT confirmed. See CAPTURE_CONTRACT.md's "known gaps" section for
the full list of open questions this module's design defers rather than
guesses at.
"""

PROVIDER = "elevenlabs"
PROVIDER_DISPLAY = "ElevenLabs"

# it_portal_tools.slug values that map to this provider - matches the single
# 'elevenlabs' slug already used in background-main.js
# (DIRECT_TICKET_ONLY_TOOLS, TOOL_SESSION_DOMAINS, hostname groups, autofill
# slug list, login methods - all already wired and working, see the plan's
# "confirmed already-working" note).
TOOL_SLUGS = frozenset({"elevenlabs"})

RELIABILITY_CLASS_BEST_EFFORT = "best_effort"
RELIABILITY_CLASS_LOSSLESS = "lossless"
RELIABILITY_CLASS = RELIABILITY_CLASS_BEST_EFFORT

# How many events share one COMMIT on the ingest and normalization paths -
# see providers/freepik/constants.py's identical constant for the full
# reasoning (per-event SAVEPOINT isolation, COMMIT once per chunk).
INGEST_COMMIT_CHUNK_SIZE = 50

# Written into ElevenlabsCaptureEvent.capture_version by the capture
# endpoint. Bump when the raw payload_json shape changes in a way
# normalization.py needs to branch on.
CAPTURE_SCHEMA_VERSION = 1

# ElevenlabsCaptureEvent.event_type values. One event type covers every
# "surface" (Text-to-Speech, Music, Sound Effects, Dubbing, Voice Changer,
# Speech-to-Text) - they are all rows of the same `history` listing,
# distinguished only by an open-ended `source` string (see
# KNOWN_SOURCE_VALUES below), not by separate event types. See the plan's
# scope note for why this collapses to one type rather than one per surface.
EVENT_TYPE_HISTORY_ROW = "history_row"

ALL_EVENT_TYPES = frozenset({EVENT_TYPE_HISTORY_ROW})

# How the extension obtained a given raw event - informational, mirrors
# Flow/Freepik's CAPTURE_SOURCE_* constants.
CAPTURE_SOURCE_NETWORK_INTERCEPT = "network_intercept"
CAPTURE_SOURCE_HISTORY_SCAN = "history_scan"

# ElevenlabsGeneration.generation_source values - which pipeline produced the
# row.
GENERATION_SOURCE_LIVE_CAPTURE = "live_capture"
GENERATION_SOURCE_RECONCILIATION = "reconciliation"

# ElevenlabsGeneration.ingestion_source values (mirrors GenerationRecord's).
INGESTION_SOURCE_CAPTURED = "captured"
INGESTION_SOURCE_RECOVERED = "recovered"

# ElevenlabsGeneration.ownership_status values (mirrors GenerationRecord's).
OWNERSHIP_STATUS_UNKNOWN = "unknown"
OWNERSHIP_STATUS_RESOLVED = "resolved"

# ElevenlabsGeneration.ownership_source values.
OWNERSHIP_SOURCE_USAGE_TICKET = "usage_ticket"
OWNERSHIP_SOURCE_EXTENSION_TICKET = "extension_ticket"
OWNERSHIP_SOURCE_SESSION = "session"
OWNERSHIP_SOURCE_USER_CLAIMED = "user_claimed"

# ElevenLabs' own generation status is NOT confirmed in any captured payload
# yet - no completion/status field has been observed on a history row at all
# (see CAPTURE_CONTRACT.md's known-gaps section). Kept for parity with every
# other provider's constants module (and for _CAPTURE_STATUS_BY_PROVIDER_STATUS
# in normalization.py) in case one turns up once real traffic is captured.
GENERATION_STATUS_COMPLETED = "completed"
GENERATION_STATUS_FAILED = "failed"
GENERATION_STATUS_PENDING = "pending"
GENERATION_STATUS_PROCESSING = "processing"

# Hard server-side ownership safety net (normalization.py) - identical
# reasoning and value to providers/freepik/constants.py's and
# providers/flow/constants.py's OWNERSHIP_FRESHNESS_WINDOW_SECONDS: a
# non-reconciliation capture event is only actually attributed to its
# ticket-resolved user if the generation's own timestamp falls within this
# many seconds of when the server received it, regardless of what confidence
# the client claimed.
OWNERSHIP_FRESHNESS_WINDOW_SECONDS = 15 * 60

# Diagnostic-only allow-list of `source` values actually confirmed in real
# traffic - NOT a capture gate (a row with an unrecognized source value is
# still captured/normalized normally). Used only by normalization.py to log
# an "unrecognized source value, please report" note so a future pass can
# tighten KNOWN_SOURCE_VALUES/CAPTURE_CONTRACT.md once Music/Sound-Effects/
# Dubbing/Voice-Changer are actually observed.
KNOWN_SOURCE_VALUES = frozenset({"TTS"})
