# providers/epidemicsound/constants.py
"""
Central place for Epidemic Sound provider literals - mirrors
providers/envato/constants.py's structure exactly (see that file's own
docstring for why this pattern exists).

Epidemic Sound (epidemicsound.com) is primarily a stock music/sound-effects
LICENSING LIBRARY - users browse pre-made tracks/sound-effects and download
them, there is no "Generate" action and no generation identity at all for
that surface. This provider captures that as download_click events (see
providers/epidemicsound/models.py's EpidemicDownload docstring) - it mirrors
Envato Elements' own download-capture pattern (EnvatoDownload /
_normalize_download_click_event), not Envato's/Freepik's/Suno's generation-
capture pattern.

Confirmed via a real live DevTools capture, 2026-08-18 (see
CAPTURE_CONTRACT.md for the full request/response):

  GET https://www.epidemicsound.com/download/?bundle=false&context=MODAL_MUSIC_DOWNLOAD
      &downloadId=...&is_sfx=true&qualityType=hq&queryId=...&sound_id=...
      &stemType=full&uiOrigin=tracklist_button&useBundler=true
  -> { "assetUrl": "https://audiocdn.epidemicsound.com/...", "remainingDownloads": 1188 }

Epidemic Sound ALSO exposes a second, architecturally different surface:
"Adapt" (epidemicsound.com/adapt) - a real AI generation that regenerates a
track's stems from a text prompt, costs real credits, and has a multi-step
async lifecycle (draft -> pending -> completed), unlike a download click
which is a single, always-new, always-final event. This is captured as
adaptation_version events (see providers/epidemicsound/models.py's
EpidemicAdaptation docstring) and normalized with an idempotent upsert-by-
identity pattern (mirroring providers/elevenlabs/normalization.py's
_find_existing_generation pattern), NOT the always-insert-new-row pattern
EpidemicDownload uses - see CAPTURE_CONTRACT.md for the full confirmed
request/response shapes of both surfaces.
"""

PROVIDER = "epidemic-sound"
PROVIDER_DISPLAY = "Epidemic Sound"

# it_portal_tools.slug values that map to this provider. "epidemic-sound" is
# the real seeded slug (hyphenated) - confirmed present in db_migrations.py's
# seed data and routers/it_tools_router.py's allowlists. This is the first
# hyphenated tool_slug in this codebase; the Python package directory is
# named "epidemicsound" (no hyphen, since directory names must be valid
# Python identifiers) - the two are deliberately different strings.
TOOL_SLUGS = frozenset({"epidemic-sound"})

# Cookie-session-authenticated (not a public/keyed API) - same posture as
# every other best-effort capture provider in this codebase. Capture depends
# entirely on a browser tab open through our launcher.
RELIABILITY_CLASS_BEST_EFFORT = "best_effort"
RELIABILITY_CLASS = RELIABILITY_CLASS_BEST_EFFORT

# How many events share one COMMIT on the ingest and normalization paths -
# see providers/freepik/constants.py's INGEST_COMMIT_CHUNK_SIZE for the
# reasoning this mirrors verbatim.
INGEST_COMMIT_CHUNK_SIZE = 50

# Written into EpidemicCaptureEvent.capture_version by the capture endpoint.
# Bump when the raw payload_json shape changes in a way normalization.py
# needs to branch on.
CAPTURE_SCHEMA_VERSION = 1

# EpidemicCaptureEvent.event_type value. EXACT LITERAL STRING - the browser
# extension sends this same string; a mismatch here silently breaks capture
# with no error (this is precisely the bug that hit Suno's capture pipeline
# when its event_type string diverged from the extension's - see
# utils/generation_gate.py's own docstring for the related, but distinct,
# TOOL_SLUGS registration incident). Do not rename without coordinating with
# the extension side.
EVENT_TYPE_DOWNLOAD_CLICK = "download_click"

# EpidemicCaptureEvent.event_type value for the Adapt surface (see this
# file's module docstring). EXACT LITERAL STRING, same coordination
# requirement as EVENT_TYPE_DOWNLOAD_CLICK above - confirmed real,
# 2026-08-19 via live DevTools capture of the compose/finalize/versions
# endpoints (see CAPTURE_CONTRACT.md). Do not rename without coordinating
# with the extension side.
EVENT_TYPE_ADAPTATION_VERSION = "adaptation_version"

ALL_EVENT_TYPES = frozenset({EVENT_TYPE_DOWNLOAD_CLICK, EVENT_TYPE_ADAPTATION_VERSION})

# How the extension obtained a given raw event. Only network interception
# exists for this provider - there is no history/listing endpoint to walk
# for reconciliation (browsing a stock library has no "my downloads" API
# confirmed so far), so this is carried only for parity with every other
# provider's capture envelope.
CAPTURE_SOURCE_NETWORK_INTERCEPT = "network_intercept"

# EpidemicDownload.ownership_status values (mirrors EnvatoDownload's). Also
# used verbatim by EpidemicAdaptation - same two-value ownership model, no
# provider-specific variant needed.
OWNERSHIP_STATUS_UNKNOWN = "unknown"
OWNERSHIP_STATUS_RESOLVED = "resolved"

# EpidemicAdaptation.status values - confirmed real, all three observed live
# in one end-to-end capture (2026-08-19, see CAPTURE_CONTRACT.md): a version
# is minted as "draft" by the compose call, flips to "pending" on finalize,
# and later shows as "completed" once the GET .../versions listing reflects
# it. No 4th value (e.g. a "failed" state) has ever been observed - do not
# add one speculatively.
ADAPTATION_STATUS_DRAFT = "draft"
ADAPTATION_STATUS_PENDING = "pending"
ADAPTATION_STATUS_COMPLETED = "completed"

ALL_ADAPTATION_STATUSES = frozenset({ADAPTATION_STATUS_DRAFT, ADAPTATION_STATUS_PENDING, ADAPTATION_STATUS_COMPLETED})

# No credits field exists anywhere in the confirmed compose/finalize/versions
# response bodies. This number is NOT a guess: the Adapt UI itself shows a
# static "Uses 1000 credits" label before submission, and a real account
# balance delta (2500 -> 1500) was observed across one full submission,
# confirmed 2026-08-19 - both point at the same number. Treated as a flat
# rate (not a per-second/per-stem formula) because the UI never shows a
# different number for a different prompt or a different original track -
# only one data point has ever been confirmed, though, so this should be
# revisited if a submission is ever observed costing something other than
# 1000 (same honest-not-a-guess framing as
# providers/elevenlabs/normalization.py's MUSIC_CREDITS_PER_SECOND and
# providers/suno/normalization.py's permanently-null credits_used comment).
ADAPTATION_CREDITS_FLAT_RATE = 1000

# EpidemicCaptureHealth status values + thresholds - mirrors
# providers/envato/constants.py's identical block verbatim. The extension's
# background-epidemicsound-capture.js pings /capture/health on the same
# schedule Envato's own background script does (mirroring
# background-envato-capture.js's structure, as instructed) even though this
# provider has no reconciliation/sync-cursor concept - added here so that
# ping actually lands somewhere instead of 404ing.
HEALTH_STATUS_HEALTHY = "healthy"
HEALTH_STATUS_DEGRADED = "degraded"
HEALTH_STATUS_BACKLOGGED = "backlogged"
HEALTH_STATUS_OFFLINE = "offline"

HEALTH_STALE_PING_THRESHOLD_SECONDS = 15 * 60

HEALTH_BACKLOG_QUEUE_LENGTH_THRESHOLD = 500
