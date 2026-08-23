# providers/splice/constants.py
"""
Central place for Splice provider literals - mirrors
providers/epidemicsound/constants.py's structure exactly (see that file's own
docstring for why this pattern exists).

Splice (splice.com) is a sample/loop LIBRARY - users browse audio samples and
click a per-row Download button to download them. There is no "Generate"
action, no prompt, and no generation identity at all - architecturally
identical to Epidemic Sound's own stock-library "downloads" surface (this
provider does NOT have an Adapt-style second surface the way Epidemic Sound
does; Splice has no confirmed generation surface of any kind).

Confirmed via a real live capture, 2026-08-19 (see CAPTURE_CONTRACT.md for
the full request/response):

  POST https://surfaces-graphql.splice.com/graphql
  -> {
       "data": {
         "asset": {
           "__typename": "SampleAsset",
           "files": [
             {"asset_file_type_slug": "preview_mp3", "url": "...", "path": "audio_samples/{hash}-scrambled/{hash}.mp3", ...},
             {"asset_file_type_slug": "waveform", "url": "...", ...},
             {"asset_file_type_slug": "source", "url": "...", "path": null, ...}
           ]
         }
       }
     }

Then the browser GETs the "source" file's signed URL directly (a short-lived,
119-second-expiry S3 URL) - that GET is the real download. There is no
explicit sample id/uuid, no BPM/key/pack name, and no credits/quota field
anywhere in this response (unlike Epidemic Sound's `remainingDownloads`) - do
not invent an equivalent. See CAPTURE_CONTRACT.md's "known gaps" section for
what is explicitly out of scope (bulk/pack downloads, non-wav variants).
"""

PROVIDER = "splice"
PROVIDER_DISPLAY = "Splice"

# it_portal_tools.slug values that map to this provider. Unlike Epidemic
# Sound's hyphenated "epidemic-sound" seeded slug, "splice" has no hyphen -
# the Python package directory name matches the tool_slug verbatim here.
TOOL_SLUGS = frozenset({"splice"})

# Cookie-session-authenticated (not a public/keyed API) - same posture as
# every other best-effort capture provider in this codebase. Capture depends
# entirely on a browser tab open through our launcher.
RELIABILITY_CLASS_BEST_EFFORT = "best_effort"
RELIABILITY_CLASS = RELIABILITY_CLASS_BEST_EFFORT

# How many events share one COMMIT on the ingest and normalization paths -
# see providers/freepik/constants.py's INGEST_COMMIT_CHUNK_SIZE for the
# reasoning this mirrors verbatim.
INGEST_COMMIT_CHUNK_SIZE = 50

# Written into SpliceCaptureEvent.capture_version by the capture endpoint.
# Bump when the raw payload_json shape changes in a way normalization.py
# needs to branch on.
CAPTURE_SCHEMA_VERSION = 1

# SpliceCaptureEvent.event_type value. EXACT LITERAL STRING - the browser
# extension sends this same string; a mismatch here silently breaks capture
# with no error (this is precisely the bug that hit Suno's capture pipeline
# when its event_type string diverged from the extension's - see
# utils/generation_gate.py's own docstring for the related, but distinct,
# TOOL_SLUGS registration incident). Do not rename without coordinating with
# the extension side.
EVENT_TYPE_DOWNLOAD_CLICK = "download_click"

ALL_EVENT_TYPES = frozenset({EVENT_TYPE_DOWNLOAD_CLICK})

# How the extension obtained a given raw event. Only network interception
# exists for this provider - there is no history/listing endpoint to walk
# for reconciliation, so this is carried only for parity with every other
# provider's capture envelope.
CAPTURE_SOURCE_NETWORK_INTERCEPT = "network_intercept"

# SpliceDownload.ownership_status values (mirrors EpidemicDownload's).
OWNERSHIP_STATUS_UNKNOWN = "unknown"
OWNERSHIP_STATUS_RESOLVED = "resolved"

# SpliceCaptureHealth status values + thresholds - mirrors
# providers/epidemicsound/constants.py's identical block verbatim. The
# extension's background-suno-capture.js-style periodic /capture/health ping
# needs somewhere real to land instead of 404ing.
HEALTH_STATUS_HEALTHY = "healthy"
HEALTH_STATUS_DEGRADED = "degraded"
HEALTH_STATUS_BACKLOGGED = "backlogged"
HEALTH_STATUS_OFFLINE = "offline"

HEALTH_STALE_PING_THRESHOLD_SECONDS = 15 * 60

HEALTH_BACKLOG_QUEUE_LENGTH_THRESHOLD = 500
