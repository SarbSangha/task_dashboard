# ElevenLabs Capture Contract

The extension <-> backend wire contract for `POST /api/providers/elevenlabs/capture/events`.
Mirrors `providers/flow/CAPTURE_CONTRACT.md`'s shape (envelope fields,
ownership decision table, versioning rule) with ElevenLabs-specific identity
fields layered on.

## Reliability class: BEST_EFFORT

Same class as Flow/Freepik/Kling: there is no webhook or server push for
ElevenLabs' generation API, so completeness is inherently bounded by whether
an employee has ElevenLabs open through our launcher. A queue that can't
flush after its max retry attempts is dropped rather than retried forever.

## Confirmed network shape

**UPDATED 2026-08-13 with the first real captured row.** A live TTS
generation, captured end-to-end through the extension and inspected directly
from the operational DB, confirmed the actual `history` list item shape:

```json
{
  "history_item_id": "poFpDeSgOlgmYzBws8uN",
  "request_id": "aTrtdgh3aFn9G0hhPH14",
  "voice_id": "CwhRBWXzGAHq8TQ4Fs17",
  "voice_name": "Roger - Laid-Back, Casual, Resonant",
  "voice_category": "premade",
  "model_id": "eleven_multilingual_v2",
  "text": "helloo kiva aa  ki kardi cc",
  "source": "TTS",
  "state": "created",
  "date_unix": 1786610923,
  "character_count_change_from": 1188,
  "character_count_change_to": 1215,
  "content_type": "audio/mpeg",
  "output_format": "mp3_44100_128",
  "settings": { "stability": 0.5, "similarity_boost": 0.75, "style": 0, "use_speaker_boost": true, "speed": 1 },
  "alignments": null,
  "avatar_context": null,
  "dialogue": null,
  "feedback": null,
  "share_link_id": null
}
```

This confirms the field-name guesses for identity/timestamp/source/prompt/
voice below were correct on the first try, **for the `TTS` surface only** -
Music/Sound Effects/Dubbing/Voice Changer/Speech-to-Text rows have not been
observed and may carry a different shape under the same `source`-keyed
endpoint (or a different endpoint entirely). `normalization.py`'s
multi-candidate-key extraction stays as-is (cheap insurance, not dead
weight) rather than being narrowed to only these exact keys.

**Also confirmed the same day: there is no downloadable audio URL anywhere
in this row.** The audio lives behind a separate authenticated endpoint -
see "Audio asset delivery" below, which replaces what was previously listed
here as Known gap #5.

Also still only a DevTools-observed *request* (never a full HAR), for the
list call itself:

```
GET https://api.elevenlabs.io/v1/history?page_size=20&source=TTS&sort_direction=desc
```

Nobody has yet captured a generate-submission request/response at all, for
any surface.

## Audio asset delivery (confirmed 2026-08-13, corrected same day)

**First pass guessed wrong and was corrected against real DevTools traffic -
recording both attempts here since the wrong guess is itself informative.**

Initial probe of `GET https://api.elevenlabs.io/v1/history/{history_item_id}/audio`
confirmed that URL is real and live (401 without credentials, wide-open CORS
`access-control-allow-origin: *`) - but it turned out to **not** be the
endpoint the web app actually calls for Play/Download. Real captured traffic
(Network tab, played + downloaded a clip) showed the real request: an XHR
literally named `download`, preceded by a CORS preflight (i.e. a non-simple/
POST request), matching ElevenLabs' documented bulk endpoint:

```
POST https://api.us.elevenlabs.io/v1/history/download
Body: {"history_item_id": "..."} or {"history_item_ids": ["..."]}
Response: audio/mpeg bytes (single item) or a zip (multiple items, not
          captured/mirrored by this pass - see normalization notes below)
```

(`api.us.elevenlabs.io` - a *regional* subdomain, not the bare
`api.elevenlabs.io` used for the initial probe above; already covered by the
extension's existing `(^|\.)elevenlabs\.io$` host match, no manifest change
needed.)

The important part both attempts agree on: **the authentication is
header-based, not cookie-based** (confirmed by the first probe's wide-open
CORS - a wildcard ACAO is incompatible with credentialed/cookie requests in
every browser), so this backend has **no way to ever fetch either endpoint
itself**. The Freepik/HeyGen model (a periodic backend-side sweep pulling a
signed CDN URL, `providers/elevenlabs/asset_mirror.py`) can therefore
**never** work for ElevenLabs, for any row, ever - see `main.py`'s comment
at the (deliberately not started) `elevenlabs_asset_mirror_task` for how
this was actually handled operationally (the periodic sweep was found to be
actively harmful, not just useless - see below).

`content-elevenlabs-network.js` watches every same-origin/`api.*.elevenlabs.io`
response for `content-type: audio/*` and first tries three deterministic id
sources, in priority order:

1. **URL path** (`/history/{id}/(audio|download)`) - cheap fallback, no
   confirmed real call actually uses this shape.
2. **Response headers** (`history-item-id` / `xi-history-item-id` /
   `x-history-item-id`) - a guess based on ElevenLabs' own naming convention
   elsewhere in their API. **Tried live and confirmed NOT to carry it.**
3. **Request body** (`history_item_id`, or `history_item_ids[0]` when the
   array has exactly one entry - more than one is skipped, not guessed at,
   since the response would be a multi-item zip that can't be safely
   attributed to a single generation without unzipping) - the confirmed real
   shape for `POST /v1/history/download` (Download button). This is the only
   one of the three that has ever actually matched live traffic.

**Play vs. Download - the gap that forced a design change.** Confirmed live
(2026-08-13, twice): Download reliably captures via source #3; Play on an
already-generated clip never does, even across repeated replays - none of
the three sources above are ever present on whatever request Play (or the
underlying stream Generate itself uses to produce the first playable audio,
`POST /v1/text-to-speech/{voice_id}/stream`) issues. After the header guess
(#2) was tried and ruled out, this was reframed from "find the right
deterministic signal" to **"stop trying to guess a fourth one - capture
proactively and correlate instead."**

**Layer 0 - proactive fetch (deterministic).** First version wrongly assumed
`${location.origin}/v1/history` (elevenlabs.io itself) proxies to the real
API over the ordinary session cookie, "confirmed" by a misread of the
walker's own logs (the "found history row(s)" logs were always the
MAIN-world interceptor observing the PAGE's own traffic to
`api.us.elevenlabs.io`, not this script's own fetch succeeding). **Confirmed
wrong live, 2026-08-13**: that same-origin request returns Next.js's plain
HTML fallback page (`content-type: text/html`) - there is no such proxy, and
`fetchElevenlabsHistoryPage`'s reconciliation walker had therefore been
silently failing on every single run since it was written
("`page fetch/decode failed, stopping walk`" - a log that had always fired,
just never flagged as the real bug it was, since the independently-working
MAIN-world observation path covers live captures either way and never
depended on this).

**The actual fix, part 1 - real host + auth token**: the real API lives at a
separate, regional host (`api.us.elevenlabs.io`, confirmed via live DevTools
capture) and authenticates via a manually-attached `Authorization: Bearer
<JWT>` header (Firebase, ~1hr TTL) the page's own JS computes - not a cookie
at all. This content script has no ambient access to that header, but
`content-elevenlabs-network.js` observes it on every real outgoing request
the page makes and relays the most recent `{apiHost, authorization}` pair
via `ELEVENLABS_NETWORK_AUTH_TOKEN` (cached in `elevenlabsCachedAuth`, never
logged even truncated - it's a live bearer credential). Both
`fetchElevenlabsHistoryPage` (the reconciliation walker - also fixed by this
same change) and `proactivelyFetchElevenlabsAudio` (fired the moment a row
is captured live, no dependency on the user clicking Play/Download at all)
now build their requests against `elevenlabsApiUrl()`/`elevenlabsApiHeaders()`
using this relayed token instead of guessing at a same-origin proxy.

**The actual fix, part 2 - drop `credentials:'include'`**: pointing the
fetch at the right host+auth still failed, with a browser-level CORS error,
confirmed live: `api.us.elevenlabs.io` responds with a wildcard
`Access-Control-Allow-Origin: *`, which every browser refuses to expose to a
credentialed (`credentials:'include'`) request, full stop - independent of
whether the Authorization header itself is valid. The page's own request
never hits this because it never asks for credentialed mode either - its
auth is 100% the Authorization header, no cookies involved. Both functions
now omit `credentials` entirely (matching the page's own real behavior)
instead of requesting `'include'`. Every outcome (ok / wrong content-type /
non-2xx / network/CORS error) is still logged either way.

**The actual fix, part 3 - request body shape**: with host+auth+CORS all
fixed, `proactivelyFetchElevenlabsAudio` finally reached the real endpoint -
and got `422 Unprocessable Content`. Fixed by sending `history_item_ids: [id]`
(plural array, matching the endpoint's own "download" naming and the
confirmed real Download-button request shape
`extractHistoryItemIdFromRequestBody` already parses on the observe side)
instead of a singular `history_item_id` field. Failure responses now also
log the response body (a FastAPI/uvicorn 422 carries the exact validation
error in its JSON body - confirmed via the `server: uvicorn` header on real
traffic), so a wrong guess here is fixable from the very next report instead
of costing another round trip.

**Response-header extraction: confirmed dead, removed.** The `history-item-id`
/`xi-history-item-id`/`x-history-item-id` guess (added when the header
approach looked promising) was tested live and produced
`Refused to get unsafe header "..."` for every candidate - a hard browser
CORS restriction (custom response headers are invisible to JS unless the
server lists them in `Access-Control-Expose-Headers`, which it doesn't),
not an account/session-specific gap that a different guess could fix.
Removed entirely rather than left as permanently-failing dead code +
console noise; `maybeCaptureAudioResponse` now tries only URL path then
request body.

**A second real bug found alongside this, also fixed**: even when Layer 0 (or
the deterministic URL/header/body sources on a real observed response) DID
correctly identify a row's audio, `reportElevenlabsAudioCapture` was pushing
it to the backend so fast it frequently raced ahead of that same row's own
queued/batched `/capture/events` upload+normalization - the backend
correctly replied `status:"generation_not_found"` (the row didn't exist in
`ElevenlabsGeneration` yet), but the function marked the push as "done"
regardless of the actual result, permanently eating that one real capture
for the full `ELEVENLABS_AUDIO_PUSH_DEDUPE_MS` (60s) window with no retry.
Fixed: only lock out further attempts on a CONFIRMED outcome (success, or a
non-transient failure); `generation_not_found` now retries up to
`ELEVENLABS_AUDIO_PUSH_MAX_ATTEMPTS` (4) times with linear backoff
(`ELEVENLABS_AUDIO_PUSH_RETRY_DELAY_MS * attempt` - 4s/8s/12s), since the
underlying row reliably lands within a few seconds.

**A third bug, found because the retry fix above still didn't work in
practice**: confirmed live 2026-08-13, two generations in a row got
permanently stuck at `asset_mirror_status="pending"` even after the retry
fix - `reportElevenlabsAudioCapture`'s own retry logic was correct, but it
never actually ran, because `background-elevenlabs-capture.js`'s
`handleElevenlabsCaptureAudioMessage` mapped `response.ok` (the HTTP status)
straight to `{ok: true}`, without ever checking the JSON body's own
`data.success` field. `POST /capture/audio` deliberately returns **HTTP 200**
for every soft/business-logic outcome including `generation_not_found`
(`success` is a JSON field there, not an HTTP status - see
`CaptureAudioResult` in `router.py`) - only a real transport/server error is
non-2xx. So a `generation_not_found` result was reported back to
`reportElevenlabsAudioCapture` as `{ok: true, status: "generation_not_found"}`
- which its own success branch (`if (result?.ok) { ...; return; }`) happily
accepted as done, before the retry-triggering check even ran. The very first
attempt, win or lose, always looked like a win. Fixed: `ok` now reflects
`data.success`, not just `response.ok`. The two generations caught by this
before the fix have no recoverable audio (the bytes were only ever transient
in browser memory, never successfully persisted) - replaying/regenerating
them is the only way to get their audio captured now.

**Layers 1-2 - correlation (heuristic backstop for whatever Layer 0 misses)**:
`content-elevenlabs-network.js` still captures the bytes of ANY audio/*
response that fails all three deterministic URL/header/body sources and
hands them over as `ELEVENLABS_NETWORK_AUDIO_UNATTRIBUTED` instead of just
logging a diagnostic. `content-elevenlabs-capture.js` then attributes it
heuristically, trying both orderings since which one actually happens isn't
fixed:

- **Row-then-audio** (the common real case: generate, then replay): remember
  the most recently live-reported row's identity for
  `ELEVENLABS_RECENT_ROW_CORRELATION_MS` (3 minutes) and attribute any
  unattributed audio arriving in that window directly to it, without waiting
  for a new row event at all (the row usually already qualified once and
  won't qualify again this session - `already_captured_this_session`).
- **Audio-then-row** (a fresh Generate's audio is produced synchronously,
  before the history-list poll notices the new row): buffer the most recent
  unattributed blob for `ELEVENLABS_AUDIO_BUFFER_TTL_MS` (45s) and consume it
  the moment a row next qualifies as a live capture.

This is explicitly a **heuristic, not a deterministic attribution** - a
false positive is possible (e.g. playing an old clip within 3 minutes of a
different, unrelated fresh generation could misattribute audio to the wrong
row). Accepted deliberately: silently attributing zero Play events to
anything (the prior state) is strictly worse than an occasional
misattribution to an adjacent generation. If this ever needs tightening,
the fix is narrowing `ELEVENLABS_RECENT_ROW_CORRELATION_MS`, not reverting
to source-only extraction (three real attempts confirmed no deterministic
source exists for Play).

Either path (deterministic or correlated) pushes the real bytes
(base64-encoded) through `content-elevenlabs-capture.js` ->
`background-elevenlabs-capture.js` -> `POST /api/providers/elevenlabs/capture/audio`
(new endpoint, not part of the batched `/capture/events` outbox - see that
endpoint's own docstring in `router.py`).

A generation captured via the history-list poll but never played/downloaded,
or whose Play falls outside every correlation window above, stays
`"pending"`/never mirrored. Not retried/queued: naturally self-healing for
anything that IS attributable/correlatable, since the same clip re-triggers
this path every time Download or a (recent-enough) Play happens again.

## Envelope (`CaptureEventIn`, schemas.py)

| Field | Notes |
|---|---|
| `event_type` | Always `history_row` in this first pass - one event type covers every surface (TTS/Music/SFX/Dubbing/Voice-Changer/STT), distinguished only by the open-ended `source` field inside `payload` (see constants.py's `ALL_EVENT_TYPES`) |
| `client_event_id` | Idempotency key, scoped to `(provider, credential_id)` - never break old clients by changing this scope |
| `creation_id` / `family_id` | `creation_id` is the best-guess identity field (`history_item_id`/`id`/`generation_id`, whichever is present), parsed out client-side, not buried in `payload`. `family_id` has no confirmed ElevenLabs equivalent of Flow's `batchId` grouping concept yet - always null today, kept for envelope parity |
| `is_reconciliation` | `true` only when the extension is walking historical data via a reconciliation/backfill sync, not a live-generation observation |
| `payload` | The raw intercepted `history` row object - opaque to capture.py |
| `capture_version` | Bump `CAPTURE_SCHEMA_VERSION` in constants.py when `payload`'s shape changes in a way normalization.py must branch on |
| `extension_ticket` / `usage_ticket` | Same ticket fields every other `DIRECT_TICKET_ONLY_TOOLS` provider sends; resolved via the exact same `_resolve_usage_event_actor` |

## Field mapping: `history` row (best guess) -> `ElevenlabsGeneration`

`normalization.py`'s `_extract_fields()` is the authoritative implementation;
this table is the human-readable index into it. Every row lists the
candidate keys tried, in priority order - the first one present on a given
payload wins.

| Logical field | Candidate JSON keys (priority order) | Column |
|---|---|---|
| Identity | `history_item_id`, `id`, `generation_id` | `provider_creation_id` |
| Created timestamp | `date_unix` (unix seconds), `created_at_unix`, `created_at`, `date` | `provider_created_at` |
| Updated timestamp | same candidates as created; falls back to the created timestamp if no separate field exists | `provider_updated_at` |
| Source/surface | `source`, `source_type` | `source` |
| Prompt/text input | `text`, `prompt`, `text_input` | `prompt` (+ `prompt_length`/`prompt_hash`) |
| Voice id | `voice_id` | `voice_id` |
| Voice name | `voice_name` | `voice_name` |
| Asset URL | `audio_url`, `url`, `download_url`, or a nested `media`/`audio` object's own `url` - **confirmed absent on a real TTS row** (see "Audio asset delivery" above); kept as a fallback candidate list only in case a future surface's row shape differs | `media_url` |

Anything not in this table is not lost - `metadata_json` holds the full raw
payload verbatim, so a future column can be backfilled from existing rows
without re-capturing.

## Known gaps

1. **`history` response body shape confirmed for `TTS` only.** Music, Sound
   Effects, Dubbing, Voice Changer, and Speech-to-Text rows have never been
   observed - they may share this exact shape or differ. `normalization.py`'s
   defensive multi-candidate extraction is kept as-is (not narrowed to the
   now-confirmed TTS keys) specifically to absorb that remaining uncertainty.
2. **No confirmed generate-submission endpoint at all**, for any surface
   (TTS/Music/SFX/Dubbing/Voice-Changer). Nothing in this backend module
   depends on one existing (capture is reconciliation/history-walk-first, the
   same posture Envato ships on today - see `providers/registry.py`'s Envato
   entry), but it means there is currently no way to correlate a capture
   event back to "the moment the Generate button was clicked" beyond
   whatever the extension's click-arm window provides.
3. **`source` enum values beyond `"TTS"` are unconfirmed.** Music, Sound
   Effects, Dubbing, and Voice Changer very likely surface through this same
   `history` endpoint with different `source` values, but none has been
   observed. `constants.KNOWN_SOURCE_VALUES` is a diagnostic-only allow-list
   (`{"TTS"}`) - an unrecognized `source` value is still captured and
   normalized normally, just logged (`logger.debug`) so a future pass can
   extend the allow-list once real traffic confirms the real values.
4. **Completion/status field: partially confirmed.** The real captured row
   carries `"state": "created"` - a genuine status-like field exists, just
   with only one observed value so far. Not wired as a settlement gate yet
   (unlike Flow's `primaryMediaId`-based one) since a single observed value
   proves nothing about what the other states are or mean (e.g. whether
   "created" ever transitions to something else, or whether a
   still-rendering row has a different value entirely). `models.py`'s
   `status` column now maps from this field - update this gap once a second
   value is observed and its meaning is clear enough to gate on.
5. **Audio asset delivery: closed, see "Audio asset delivery" above.** Was
   "unconfirmed whether the audio asset is embedded in the history row or
   requires a separate authenticated fetch" - confirmed the latter, and
   implemented (browser observes + pushes the real bytes, since the backend
   has no way to fetch them itself). `asset_mirror.py`'s periodic pull-based
   sweep is confirmed permanently unable to mirror anything for this
   provider (every row will always scan as zero candidate URLs) and is
   **deliberately not started** in `main.py`'s lifespan as of 2026-08-13 -
   see the comment right above where the other providers' equivalent tasks
   are created. Running it would actively race ahead of and permanently
   mislabel `"pending"` rows that DO have real audio waiting on the
   browser-side push path as `"skipped"`, before the extension ever gets a
   chance to observe the real playback/download request - this happened for
   real in testing (two rows got mismarked within minutes of capture) before
   the dispatch was disabled. The module/endpoint are left in place
   (harmless if ever manually invoked) in case a real signed-URL path is
   discovered later; do not re-enable the periodic task without first
   confirming that's changed.
6. **Every row stays `asset_mirror_status="pending"` until actually
   played/downloaded once.** With the periodic sweep disabled, there is no
   longer any path that marks a row `"skipped"` automatically - a genuine
   Speech-to-Text row (no audio output at all) and a TTS row nobody has
   replayed yet are currently indistinguishable in this field (both sit at
   `"pending"` indefinitely). Acceptable for now, matches the dashboard's own
   "no audio available yet" framing either way; a future pass could mark STT
   rows `"skipped"` explicitly at normalization time once the `source` value
   for STT is confirmed, to make the two states distinguishable.

## Ownership decision table (normalization.py)

| `is_reconciliation` | ticket present | Result |
|---|---|---|
| `false` | yes | `ownership_status="resolved"`, `ownership_source="ticket"`, `generation_source="live_capture"` |
| `false` | no (session only) | `ownership_status="resolved"`, `ownership_source="session"`, `generation_source="live_capture"` |
| `true` | (irrelevant) | `ownership_status="unknown"`, `ingestion_source="recovered"`, `generation_source="reconciliation"` |

Sticky rule: once `ownership_status="resolved"`, no later re-capture ever
changes `owner_user_id` - only an explicit admin claim/revoke/reassign flow
could (not built for ElevenLabs in this pass, the same posture Flow's own
contract documents).

## Versioning rule

Never repurpose an existing `CaptureEventIn` field for a different meaning.
Adding a field is safe (old extension versions just don't send it,
defaulting server-side); changing what an existing field means requires
bumping `CAPTURE_SCHEMA_VERSION` and branching on `capture_version` in
`normalization.py`, same rule every other provider follows.
