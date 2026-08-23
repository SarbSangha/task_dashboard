# Suno Capture Contract

The extension <-> backend wire contract for `POST /api/providers/suno/capture/events`.
Mirrors `providers/elevenlabs/CAPTURE_CONTRACT.md`'s shape (envelope fields,
ownership decision table, versioning rule) with Suno-specific identity fields
layered on.

## Reliability class: BEST_EFFORT

Same class as ElevenLabs/Flow/Freepik/Kling: there is no webhook or server
push for Suno's generation API, so completeness is inherently bounded by
whether an employee has Suno open through our launcher. A queue that can't
flush after its max retry attempts is dropped rather than retried forever.

## Closed: `event_type` mismatch silently rejected every capture (found 2026-08-17)

First real end-to-end test produced zero `SunoGeneration`/`SunoCaptureEvent`
rows despite the extension console clearly showing `armed` -> `qualifying
row` -> `reported clip row {queued: true}` for multiple real clips, and the
background service worker's local outbox queue draining to empty (implying
a definitive server response, not a stuck/failing retry). Root cause:
`content-suno-capture.js`'s `reportSunoClipRow` sent `event_type: 'feed_clip'`,
but this module's `ALL_EVENT_TYPES` (`constants.EVENT_TYPE_CLIP = "clip"`)
only accepts `"clip"` - `ingest_capture_event` rejects (not errors) on an
unrecognized `event_type`, and a `"rejected"` result is treated as
definitive (never retried) by the outbox, so the queue drains silently with
nothing ever created. The backend and extension were built by two
independently-briefed agents that each picked this string on their own
without a shared literal to coordinate against - fixed by changing the
extension to send `"clip"` (also the better choice: matches Suno's own
`clips` envelope key). If capture events go silently missing again, check
this mismatch class first - a `"rejected"` `CaptureIngestResult.reason` is
logged server-side (`suno_capture_event ... status=rejected reason=...`) and
would have caught this immediately.

## Closed: misleading "Capture complete" badge + arm window too short for Suno's real generation time (found 2026-08-18)

Two related issues surfaced from real use, both in `content-suno-capture.js`:

1. `disarmSunoGeneration` reused ElevenLabs' unconditional
   `"Capture complete ✓"` status message the moment ANY row was reported
   this arm session - including a metadata-only `"queued"`/`"submitted"`
   snapshot with no audio at all. A user reasonably reads "complete" as
   "fully captured, audio included," then sees `Audio Backup Status:
   Pending` on the dashboard and concludes capture is broken, when it's
   actually just still generating. Fixed: the message now checks whether
   any captured entry actually had `readyForDownload: true` and says
   `"Prompt captured - audio still generating…"` otherwise.
2. The arm quiet-period (90s, copied from ElevenLabs, where TTS/Music audio
   is ready in seconds) was too short for Suno - a row can sit unchanged
   for well over 90s before the page's own next natural feed poll observes
   it as streaming/complete, and repeated "still not ready" sightings of
   the SAME row never reset the quiet timer (only a newly-qualifying
   capture does). The arm would quietly disarm before real audio ever
   appeared, silently falling back on the ~20-minute reconciliation walk
   instead of catching it live. Widened `SUNO_ARM_QUIET_PERIOD_MS` to 4
   minutes and extended `SUNO_ACCELERATED_POLL_DELAYS_MS` out to ~230s to
   match - `SUNO_ARM_MAX_DURATION_MS` (10 min) was already generous enough
   as the hard backstop.

## Closed: `/api/generate/v2-web/` created a permanent audio-less ghost generation per batch (found 2026-08-18)

A single Create click generating a 2-song batch produced **three**
`SunoGeneration` rows instead of two: the two real clips (`batch_index: 0`
and `1`, both eventually got real audio) plus one extra row with `status:
"running"`, no `batch_index`, no `title`, and audio that never arrived.
Root cause: `POST /api/generate/v2-web/` (the generate-submission endpoint
noted in the gap above as having an unconfirmed response shape) returns its
own clip-shaped placeholder object with a **unique `id` that is never the
same identity** as the real clip(s) that subsequently appear in
`/api/feed/v3` - `content-suno-network.js` was capturing it like any other
clip row, since its shape happened to pass the generic `id` + `created_at`
check. Same failure class as ElevenLabs Music's "chat created before song"
duplicate bug, just from a different endpoint. Fixed by excluding
`/api/generate/` paths from clip-row extraction entirely
(`isCanonicalClipSourceUrl` in `content-suno-network.js`) - `/api/feed/v3`
is the confirmed canonical source and already fully covered by live
capture, accelerated polls, and the reconciliation walker, so nothing is
lost by never treating this endpoint's response as capturable. Also
confirms a fourth real `status` value: `"running"` - though since it only
ever appeared on this non-canonical placeholder response, it's unclear
whether `"running"` is a real clip lifecycle state at all, or specific to
`/api/generate/v2-web/`'s own response shape.

## Confirmed network shape (2026-08-17, live DevTools capture)

Unlike ElevenLabs (built from a single unconfirmed screenshot), this
provider's response body IS confirmed from real traffic - a live DevTools
capture of the actual response, not just a request shape:

```
POST https://studio-api-prod.suno.com/api/feed/v3
```

```json
{
  "clips": [
    {
      "id": "05567ff6-a8ad-478c-b3dd-59dc2e953fdb",
      "status": "streaming",
      "title": "Mera Dil",
      "created_at": "2026-08-17T09:09:34.447Z",
      "audio_url": "https://audiopipe.suno.ai/?item_id=05567ff6-a8ad-478c-b3dd-59dc2e953fdb",
      "media_urls": [
        {"url": "https://audiopipe.suno.ai/?item_id=...&format=webm&encoded=true", "content_type": "webm-opus", "delivery": "streaming"},
        {"url": "https://audiopipe.suno.ai/?item_id=...&format=mp3&encoded=true", "content_type": "mp3", "delivery": "streaming"},
        {"url": "https://audiopipe.suno.ai/?item_id=...", "content_type": "mp3", "delivery": "streaming"}
      ],
      "image_url": "https://cdn2.suno.ai/image_....jpeg",
      "major_model_version": "v5.5",
      "model_name": "chirp-fenix",
      "metadata": {
        "tags": "Punjabi pop with a swaying mid-tempo groove...",
        "prompt": "[Verse 1]\nRo ro ke arja gujar ta haan\n...",
        "gpt_description_prompt": "ro ro ke arja gujar ta ha dill.\nhae mera dill haye mera .\n...",
        "type": "preview",
        "make_instrumental": false
      },
      "is_liked": false, "user_id": "295a1731-...", "display_name": "captainsangha",
      "is_public": false, "is_trashed": false, "is_hidden": false,
      "play_count": 0, "upvote_count": 0, "comment_count": 0,
      "batch_index": 0,
      "action_config": {
        "actions": [
          {"action_type": "download_song", "disabled": true, "visible": true, "action_override": {"type": "toast", "text": "You can download once your song's done generating."}}
        ]
      }
    }
  ],
  "has_more": false
}
```

The request BODY that produces this response was never captured - only the
response. See "Known gaps" below.

## Readiness signal

The confirmed, deterministic "is the real audio actually ready" signal is
`action_config.actions[]` - find the entry where `action_type ===
"download_song"`; its `disabled` boolean is the answer, and while `disabled`
is true, `action_override` carries the literal toast copy: "You can download
once your song's done generating."

**Do NOT gate readiness on `status`** - only `"streaming"` has ever been
observed; the terminal value is unconfirmed (see Known gaps below).

**Do NOT gate readiness on `audio_url`/`media_urls` presence** - both are
populated even while the clip is still generating (this is a live streaming
endpoint, the URLs point at a stream that resolves once the render catches
up, not proof the final asset already exists). A generation row's
`media_url` column is therefore populated at capture time regardless of true
readiness, same as every other provider's best-effort media_url extraction -
the `action_config` readiness gate is what any future extension-side capture
logic (or asset-mirror push decision) must key on instead, not this column's
mere presence.

`constants.READINESS_ACTION_TYPE` ("download_song") is the canonical key
name for this, documented there for whoever builds the extension side.

## Envelope (`CaptureEventIn`, schemas.py)

| Field | Notes |
|---|---|
| `event_type` | Always `clip` in this first pass - one event type covers every captured clip (Suno only makes music, no TTS/Music/SFX multi-surface split the way ElevenLabs has) |
| `client_event_id` | Idempotency key, scoped to `(provider, credential_id)` - never break old clients by changing this scope |
| `creation_id` / `family_id` | `creation_id` is the clip's `id` (flat, top-level, never changes across the clip's lifecycle - no flatten/dedup problem the way ElevenLabs Music's chat/song split had). `family_id` has no confirmed Suno equivalent of Flow's `batchId` grouping concept yet - `batch_index` exists on the clip (multiple samples from one generation) but no shared batch/group id has been observed alongside it, so `family_id` stays always null today, kept for envelope parity |
| `is_reconciliation` | `true` only when the extension is walking historical data via a reconciliation/backfill sync, not a live-generation observation |
| `payload` | The raw intercepted clip object - opaque to capture.py |
| `capture_version` | Bump `CAPTURE_SCHEMA_VERSION` in constants.py when `payload`'s shape changes in a way normalization.py must branch on |
| `extension_ticket` / `usage_ticket` | Same ticket fields every other `DIRECT_TICKET_ONLY_TOOLS` provider sends; resolved via the exact same `_resolve_usage_event_actor` |

## Field mapping: clip -> `SunoGeneration`

`normalization.py`'s `_extract_fields()` is the authoritative implementation;
this table is the human-readable index into it. Unlike ElevenLabs, every row
below is a single confirmed key, not a candidate list - the shape was
confirmed from real traffic on the first try, so `_extract_fields` does not
need (and deliberately does not implement) multi-candidate-key defensive
guessing.

| Logical field | JSON key | Column | Notes |
|---|---|---|---|
| Identity | `id` | `provider_creation_id` | Flat, top-level, stable across the clip's lifecycle |
| Created timestamp | `created_at` (ISO-8601) | `provider_created_at` | No separate "updated" timestamp has ever been observed - `provider_updated_at` falls back to the same value |
| Prompt | `metadata.gpt_description_prompt` | `prompt` (+ `prompt_length`/`prompt_hash`) | The literal text the user typed - confirmed matches a real screenshot's "Song Description" textarea verbatim. **Not** `metadata.prompt` (the AI-expanded full lyrics output, a different thing - kept in `metadata_json` only, never promoted) |
| Model name | `model_name` | `model_name` | e.g. `"chirp-fenix"` - first-class column (not just metadata_json) |
| Model version | `major_model_version` | `major_model_version` | e.g. `"v5.5"` - first-class column |
| Asset URL | `audio_url` | `media_url` | Populated even while still generating - see "Readiness signal" above, not a readiness proof |
| Thumbnail | `image_url` | `thumbnail_url` | Cover art |
| Status | `status` | `status` | Only `"streaming"` confirmed - see Known gaps |
| Credits used | *(none - not implemented)* | `credits_used` | Permanently `NULL` - see Known gaps |

Anything not in this table is not lost - `metadata_json` holds the full raw
clip object verbatim (including `media_urls[]`, `title`, `is_liked`,
`user_id`, `display_name`, `play_count`/`upvote_count`/`comment_count`,
`batch_index`, `action_config`, and `metadata.tags`/`metadata.prompt`/
`metadata.type`/`metadata.make_instrumental`), so a future column can be
backfilled from existing rows without re-capturing.

## Known gaps

1. **Closed: terminal `status` value confirmed `"complete"`** (2026-08-17,
   real capture). A second real shape difference came with it, not just the
   status string: once `status: "complete"`, `audio_url` switches from the
   `audiopipe.suno.ai` **streaming** endpoint to a permanent
   `https://cdn1.suno.ai/{id}.mp3` URL, and `media_urls` gains a CloudFront
   progressive-download entry (`d2lwuy8qc234o3.cloudfront.net/.../{id}.m4a`,
   `delivery: "progressive"` instead of `"streaming"`) alongside the cdn1 mp3
   (also now `delivery: "progressive"`). A real `duration` field (seconds,
   e.g. `22.36`) also appears in `metadata` at this point, previously absent.
   `constants.py`'s `GENERATION_STATUS_*` values still include the
   unconfirmed `completed`/`failed`/`pending`/`processing` set for parity
   with other providers, but only `"streaming"` and `"complete"` are real
   Suno values so far - `_CAPTURE_STATUS_BY_PROVIDER_STATUS` in
   `normalization.py` should be revisited to map `"complete"` explicitly
   rather than staying a no-op for it.
   **Two more real values confirmed since** (2026-08-18): `"queued"`
   (freshly created, `audio_url: ""`, no `media_urls` at all - the very
   first observable state) and `"submitted"` (`audio_url` still `""`, but
   `metadata.gpt_description_prompt` is already populated - generation
   accepted but not yet streaming). Plausible progression so far, in
   observation order: `queued` -> `submitted` -> `streaming` -> `complete` -
   NOT confirmed to always follow this exact order or never skip/repeat a
   step, just the sequence actually observed across captures to date. A
   `"queued"`/`"submitted"` row's `action_config.actions[].download_song`
   can show `disabled: false` even with no audio at all - see
   `sunoRowIsReadyForDownload` in `content-suno-capture.js`, which now
   requires a real URL in addition to that flag for exactly this reason.
2. **No confirmed credits formula.** The UI only shows a running
   per-SESSION total ("N credits used this session"), never a per-clip cost.
   Unlike ElevenLabs Music (where three independent confirmed data points -
   10s->150 credits, two separate 3s samples->45 each - made a flat
   15-credits/second formula safe to add), there is not yet enough
   independent real data for Suno to reverse-engineer one, and no per-clip
   credit-ledger-style field (comparable to ElevenLabs TTS's
   `character_count_change_from/to`) has been observed on a clip at all.
   `SunoGeneration.credits_used` is therefore left nullable and always
   `None` - no credits-computation function exists in `normalization.py`.
   Revisit once either a per-clip cost field is observed, or enough
   independent same-model/same-length data points are captured to fit a
   formula the way ElevenLabs Music's was.
3. **Partially closed: a generate-submission endpoint IS real, but its
   response shape is unconfirmed.** Live capture (2026-08-17) showed
   `content-suno-network.js` intercepting `POST /api/generate/v2-web/`
   immediately after a real Create click, whose response also matched the
   clip-row shape check (`count: 1`) and was captured live via the same path
   as a `/api/feed/v3` row - so this module still doesn't depend on it (the
   reconciliation walker only ever calls `/api/feed/v3`), but it's no longer
   accurate to say no submit endpoint exists. Its exact response shape
   (single clip vs. batch, whether it differs from a feed row at all) was
   never inspected directly - if a future pass wants to use it as a
   deterministic "generation started" signal, capture and diff it against
   the feed shape first rather than assuming they're identical.
4. **The `POST /api/feed/v3` request BODY was never captured** - only the
   response shown above. It is unknown what parameters the request sends
   (pagination cursor, page size, filters, etc.). If a future pass building
   the extension side (reconciliation walker, click-arm window sizing) needs
   this, it must be captured fresh rather than guessed at.
5. **Closed: the "Create" submit button's DOM is confirmed** (2026-08-17,
   via DevTools Inspect) - `<button aria-label="Create song" ...>` - distinct
   from the sidebar's plain "Create" nav link (see
   `content-suno-capture.js`'s `looksLikeSunoCreateButton`, which matches
   primarily on that aria-label now rather than the earlier best-effort
   text-proximity heuristic). Noted here since this gap was originally
   flagged in this file's earlier draft alongside the others above.

## Ownership decision table (normalization.py)

| `is_reconciliation` | ticket present | Result |
|---|---|---|
| `false` | yes | `ownership_status="resolved"`, `ownership_source="ticket"`, `generation_source="live_capture"` |
| `false` | no (session only) | `ownership_status="resolved"`, `ownership_source="session"`, `generation_source="live_capture"` |
| `true` | (irrelevant) | `ownership_status="unknown"`, `ingestion_source="recovered"`, `generation_source="reconciliation"` |

Sticky rule: once `ownership_status="resolved"`, no later re-capture ever
changes `owner_user_id` - only an explicit admin claim/revoke/reassign flow
could (not built for Suno in this pass, the same posture every other
provider's contract documents).

## Versioning rule

Never repurpose an existing `CaptureEventIn` field for a different meaning.
Adding a field is safe (old extension versions just don't send it,
defaulting server-side); changing what an existing field means requires
bumping `CAPTURE_SCHEMA_VERSION` and branching on `capture_version` in
`normalization.py`, same rule every other provider follows.
