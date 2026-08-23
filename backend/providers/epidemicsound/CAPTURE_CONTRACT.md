# Epidemic Sound Capture Contract

The extension <-> backend wire contract for
`POST /api/providers/epidemicsound/capture/events`. Mirrors
`providers/envato/normalization.py`'s download-capture shape
(`_normalize_download_click_event`) - see that file's own docstring for the
pattern this is built on.

## What this provider is

Epidemic Sound (epidemicsound.com) has TWO architecturally different capture
surfaces:

1. **Downloads** (this section, below) - a stock music/sound-effects
   LICENSING LIBRARY. Users browse and download pre-made tracks and sound
   effects - there is no "Generate" action, no prompt, no generation
   identity of any kind. Captured as `download_click` events, normalized
   into `EpidemicDownload` - always a new row, never upserted (see below).
2. **Adapt** (`epidemicsound.com/adapt` - see its own section further down)
   - a real AI generation that regenerates a track's stems from a text
   prompt, costs real credits, and has a genuine multi-step async lifecycle.
   Captured as `adaptation_version` events, normalized into
   `EpidemicAdaptation` - upserted by identity (`version_id`), since the
   SAME version's status changes over time (draft -> pending -> completed)
   and each later capture must UPDATE the existing row, not insert a
   duplicate.

There is no sync/reconciliation walker for either surface, and no
`/generations` route - only `EpidemicDownload` and `EpidemicAdaptation` rows,
each behind their own read routes (`/downloads`, `/adaptations`).

## Reliability class: BEST_EFFORT

Same class as every other capture provider in this codebase: there is no
webhook or server push from Epidemic Sound, so completeness is bounded by
whether an employee has the site open through our launcher.

## Confirmed network shape (CONFIRMED REAL, live DevTools capture, 2026-08-18)

This is not a guess or an inference from a screenshot - it is a real request/
response pair captured live from the running site.

Request:

```
GET https://www.epidemicsound.com/download/?bundle=false&context=MODAL_MUSIC_DOWNLOAD&downloadId=383bf181-f9f2-4251-ab6d-0fd24cd1528e&is_sfx=true&qualityType=hq&queryId=e342da71-3874-406d-bd5c-3a2a6fd3e675&sound_id=16bb9f7c-282e-45f4-a253-40ee6d605412&stemType=full&uiOrigin=tracklist_button&useBundler=true
```

Response:

```json
{
  "assetUrl": "https://audiocdn.epidemicsound.com/audiofiles/mp3/01KJFAQ6HGNGQV779FGDWGBCM3.mp3?exp=1787045581.0&key_id=K3IHC07NT7VB9M&response-content-disposition=attachment%3B%20filename%3D%22ES_Swooshes%2C%20Whoosh%2C%20Mids%20-%20Epidemic%20Sound.mp3%22&signature=...",
  "remainingDownloads": 1188
}
```

## Identity: downloadId, not sound_id

`downloadId` (request URL query param) is the per-download-EVENT identity -
a fresh id minted every single time the download button is clicked, even for
the same track downloaded twice. It is stored as a reference column
(`EpidemicDownload.download_id`) but is NEVER used as a dedup/lookup key -
every captured download_click event produces its own new `EpidemicDownload`
row, mirroring `EnvatoDownload`'s "always `db.add()` a new row" behavior
exactly (see `providers/envato/normalization.py:195-243`). A download is a
real, individually-quota-consuming action (see `remainingDownloads` below),
not something to merge against a prior download of the same track.

`sound_id` (request URL query param) is the stable TRACK identity - stored as
a reference/filterable column (`EpidemicDownload.sound_id`), also never a
dedup key.

## Field mapping

| Source | Field | Column | Notes |
|---|---|---|---|
| request URL | `downloadId` | `download_id` | per-click identity, reference only |
| request URL | `sound_id` | `sound_id` | stable per-track identity, reference only |
| request URL | `is_sfx` | `is_sfx` (bool) | Sound Effect vs Music - the closest thing to a "surface" split here |
| request URL | `qualityType` | `quality_type` | e.g. `"hq"` |
| request URL | `stemType` | `stem_type` | e.g. `"full"` |
| response body | `assetUrl` | `asset_source_url` | real, signed, time-limited; different host (`audiocdn.epidemicsound.com`) - see mirroring below |
| response body | `remainingDownloads` | `remaining_downloads` | informational only - the account's quota remaining AFTER this download |
| response body (`assetUrl`'s `response-content-disposition` param) | filename | `asset_title` | parsed, see below |

`remainingDownloads` has no confirmed formula for computing a per-download
cost from it, so there is deliberately no `credits_used`-style column at all
on `EpidemicDownload` - same "don't guess a cost" discipline already applied
to Suno's permanently-null `credits_used`, taken one step further since
`EnvatoDownload` itself has no credits column either.

## Title parsing (CONFIRMED REAL, 2026-08-18)

A real, human-readable title is embedded in the response's `assetUrl` via its
own `response-content-disposition` query param:

```
response-content-disposition=attachment%3B%20filename%3D%22ES_Swooshes%2C%20Whoosh%2C%20Mids%20-%20Epidemic%20Sound.mp3%22
```

which URL-decodes to:

```
attachment; filename="ES_Swooshes, Whoosh, Mids - Epidemic Sound.mp3"
```

`normalization.py`'s `_parse_asset_title` does, in order:

1. URL-decode the `response-content-disposition` query param.
2. Regex out the `filename="..."` value.
3. Strip a trailing `.mp3` extension.
4. Strip a leading `"ES_"` prefix, if present.
5. Strip a trailing `" - Epidemic Sound"` suffix, if present.

For the confirmed sample above this yields `"Swooshes, Whoosh, Mids"`, stored
in `EpidemicDownload.asset_title`.

This parse is deliberately defensive end-to-end: `assetUrl` is an unofficial,
signed CDN URL whose shape could change without notice. Any failure at any
step (missing param, unexpected shape, malformed URL) falls back to `None`
rather than raising - the full raw payload is always kept in `metadata_json`
regardless, so nothing is ever lost even when this parse fails.

## Auth

Cookie-session-based (`credentials: 'include'`), same as every other
best-effort capture provider - no backend changes needed for auth beyond the
standard ticket-based actor resolution every `DIRECT_TICKET_ONLY_TOOLS`
provider already uses (`_resolve_usage_event_actor`, the same function every
other provider's `capture.py` calls).

## Asset mirroring

`assetUrl` is real but signed/time-limited, and lives on a different host
(`audiocdn.epidemicsound.com`) than the page that requested it
(`www.epidemicsound.com`) - and, like Envato's download flow, requires the
browser's own authenticated session to have been fetched at all. This
backend can never independently re-fetch it, so the SAME asset-mirroring
approach as `EnvatoDownload.mirrored_asset_key`/`asset_mirror_status` is used
verbatim: the browser extension pushes the already-fetched bytes to
`POST /capture/download-media`, keyed by `client_event_id` (the same id the
original `download_click` event was reported under), and
`EpidemicDownload.to_dict()` mints a fresh short-lived presigned R2 URL from
the stored object key on every read (see
`providers/epidemicsound/models.py`'s `_presigned_mirror_url`).

## Route set (confirmed)

- `POST /api/providers/epidemicsound/capture/events` (shared by BOTH surfaces - generic across `event_type`)
- `POST /api/providers/epidemicsound/capture/download-media`
- `POST /api/providers/epidemicsound/capture/adaptation-media`
- `GET /api/providers/epidemicsound/downloads`
- `GET /api/providers/epidemicsound/downloads/{download_id}`
- `GET /api/providers/epidemicsound/adaptations`
- `GET /api/providers/epidemicsound/adaptations/{adaptation_id}`

No `/generations` route exists (Adapt's read route is `/adaptations`, its own
name, not the generic `/generations` shape other generation-capturing
providers use) and no `/sync/cursor` route exists (no reconciliation walker
for either surface).

## Closed: the Download click-gate was firing on the wrong element (found 2026-08-18)

Epidemic Sound actually has TWO separate "Download" controls in its UI, not
one. The row-level arrow icon (`aria-label="Download"`, icon-only - this is
the exact DOM this whole capture pipeline was originally built against) does
NOT trigger a real download at all - clicking it only opens Epidemic Sound's
own "Download sound effect" modal (file format picker, Full track/Segment
toggle). The real `/download/` network request documented above only fires
when the user clicks that modal's OWN "Download" button.

`content-epidemicsound-capture.js`'s click-gate originally matched on
`aria-label === 'download'` (catching the row icon) with a text-content
fallback that, via `epidemicSoundButtonDescriptorText`, ALSO folded
`aria-label` into its check - so both the row icon and the real modal button
fired the Task/Client popup, confusing the user (popup appearing twice per
download, once on a click that doesn't actually download anything). Fixed:
the gate now matches only on genuine visible `innerText`/`textContent`
containing "download" - the row icon is icon-only (no rendered text, only
an aria-label) and no longer matches; the modal's real Download button (real
visible text) does. `epidemicSoundButtonDescriptorText` was removed
(dead code once aria-label was dropped from the match).

## Known gaps (downloads)

- No confirmed sample yet for a Music-only (`is_sfx=false`) or a non-`hq`
  `qualityType`/non-`full` `stemType` download - the field mapping above is
  expected to hold (same query-param shape, different values) but has not
  been separately observed.
- No confirmed "my downloads" history/listing endpoint on the site itself,
  so there is no reconciliation/backfill walker (unlike Envato's
  `generation-history.data` walk) - capture is live network-intercept only.

---

# Adapt Capture Contract

The extension <-> backend wire contract for the `adaptation_version`
`event_type`, sent through the SAME `POST /api/providers/epidemicsound/
capture/events` endpoint documented above (no separate capture endpoint - the
endpoint is already generic across `event_type`).

## What Adapt is

`epidemicsound.com/adapt` regenerates an existing track's stems from a text
prompt - a real AI generation, architecturally unlike a stock-library
download: there is no pre-existing asset, there IS a genuine multi-step async
lifecycle with a stable identity across it, and it costs real credits.

## Reliability class: BEST_EFFORT

Same class/reasoning as downloads - see that section above.

## Confirmed real traffic lifecycle (CONFIRMED REAL, live DevTools capture,
end-to-end, 2026-08-19)

Three real requests, in order:

**1. Compose** - mints the version, status `"draft"`:

```
POST https://www.epidemicsound.com/a/adaptation/sessions/{sessionId}/versions/compose
```

Response (202 Accepted):

```json
{
  "id": "e4e0c4e6-07c6-4363-bac0-bc200d08a196",
  "name": "Aug 19, 10:21 AM",
  "recordingId": "930c96e6-acce-49bd-994c-ebf50fa34113",
  "status": "draft",
  "compose": {
    "compositeRegions": [],
    "stems": { "melody": {"volume": 1}, "instruments": {"versionId": "44d8c838-...", "volume": 1}, "bass": {}, "drums": {} },
    "clientSettings": {
      "modifications": [
        {
          "type": "adaptedStyle",
          "audioUrl": "https://audiocdn.epidemicsound.com/generated/adapt/lqmp3/....mp3?exp=...&signature=...",
          "stems": ["bass", "drums", "instruments"],
          "prompt": "give this tune a dhol sarangi touch  in punjabi style"
        }
      ],
      "hasBeenDownloaded": false,
      "labels": []
    }
  },
  "createdAt": "2026-08-19T04:51:00Z",
  "updatedAt": "2026-08-19T04:51:00Z"
}
```

**2. Finalize** - status flips to `"pending"`:

```
POST https://www.epidemicsound.com/a/adaptation/sessions/{sessionId}/versions/{id}/finalize
```

Response (202 Accepted, empty request body): mirrors the SAME object shape as
compose, but with `"status": "pending"`.

**3. List versions** - the completion signal AND read model:

```
GET https://www.epidemicsound.com/a/adaptation/sessions/{sessionId}/versions?limit=100&sort=-updatedAt
```

Response (200 OK):

```json
{
  "data": [
    {
      "id": "e4e0c4e6-07c6-4363-bac0-bc200d08a196",
      "name": "Aug 19, 10:21 AM",
      "recordingId": "930c96e6-acce-49bd-994c-ebf50fa34113",
      "status": "completed",
      "asset": {
        "labels": ["compose", "remix"],
        "previewUrl": "https://audiocdn.epidemicsound.com/generated/adapt/lqmp3/....mp3?exp=2102734275&key_id=...&signature=..."
      },
      "stems": {
        "melody": {"labels": ["compose"], "previewUrl": "..."},
        "instruments": {"labels": [], "previewUrl": "..."},
        "bass": {"labels": [], "previewUrl": "..."},
        "drums": {"labels": [], "previewUrl": "..."}
      },
      "compose": { "...": "same shape as the compose/finalize response above" },
      "createdAt": "2026-08-19T04:51:00Z",
      "updatedAt": "2026-08-19T04:51:15Z"
    },
    {
      "id": "44d8c838-0ddd-4d01-84d4-88290478c7b0",
      "status": "completed",
      "asset": {"labels": ["remix"], "previewUrl": "..."},
      "stems": {"instruments": {}, "bass": {}, "drums": {}, "melody": {"previewUrl": "..."}},
      "remix": {
        "textPrompt": "give this tune a dhol sarangi touch  in punjabi style",
        "stemTypes": [],
        "usePromptRewriting": true,
        "beCreative": true,
        "autoSelectStemsToAdapt": true
      },
      "createdAt": "2026-08-19T04:50:45Z",
      "updatedAt": "2026-08-19T04:51:00Z"
    }
  ],
  "links": {"first": "/sessions/{sessionId}/versions?limit=100&sort=-updatedAt"}
}
```

The extension reports one `adaptation_version` capture event per version
object it observes - either the compose/finalize response body directly, or
one entry of this listing's `data[]` array - so `payload_json` on
`EpidemicCaptureEvent` is always a single version object, never the wrapped
`{data: [...]}` envelope.

## Identity: `id` (a single stable identity across the whole lifecycle)

Unlike downloads' `downloadId` (a fresh id per event, never a dedup key), a
version's own `id` is THE SAME value across all three steps above
(`e4e0c4e6-...` in the sample) - draft, then pending, then completed are all
the SAME version, just observed at different points in its lifecycle. Stored
as `EpidemicAdaptation.version_id` (unique, indexed) and used as the upsert
key.

**This is why `EpidemicAdaptation` is normalized completely differently from
`EpidemicDownload`**: `_normalize_adaptation_version_event` looks up any
existing row by `version_id` first (mirrors
`providers/elevenlabs/normalization.py`'s `_find_existing_generation`
pattern) and UPDATES it if found, only inserting a new row the first time a
given `version_id` is seen. A later capture of the same version (e.g. once
status flips to `"completed"`) updates the SAME row's `status`/`media_url`/
`stems_json` columns rather than creating a second row. `EpidemicDownload`,
by contrast, always inserts a new row per event - see that section above for
why (each download is its own individually-quota-consuming action; there is
no "the same download later changes state").

## Field mapping

| Source | Field | Column | Notes |
|---|---|---|---|
| response body | `id` | `version_id` | THE identity - same value across draft/pending/completed, upsert key |
| extension-added (parsed from request URL path, NOT the response body) | `sessionId` | `session_id` | `/a/adaptation/sessions/{sessionId}/...` |
| response body | `recordingId` | `recording_id` | the ORIGINAL track being adapted |
| extension-added (DOM-scraped, optional/best-effort) | `originalTrackTitle` | `original_track_title` | e.g. "Shibuya Bullet Train" - not in any API response |
| response body (two possible locations, see below) | prompt | `prompt` | try `compose.clientSettings.modifications[]` first, fall back to `remix.textPrompt` |
| response body | `status` | `status` | `"draft"` \| `"pending"` \| `"completed"` - stored as-is, no guessed 4th value |
| response body (`asset.previewUrl`) | asset URL | `media_url` | **ONLY populated once `status == "completed"`** - see warning below |
| response body | `stems` | `stems_json` | raw object stored as one JSON blob (per-stem `previewUrl`), not separate columns |
| n/a | flat rate | `credits_used` | always `ADAPTATION_CREDITS_FLAT_RATE` (1000) - see below, not read from any payload field |

### Prompt: two possible locations, try both

Depending on which internal variant a version has, the prompt lives in one
of two different shapes - `_extract_adaptation_prompt` in `normalization.py`
tries both, in order:

1. `compose.clientSettings.modifications[]` (an array) - take the **last**
   entry's `.prompt`. Present on the compose/finalize response body
   directly, and also nested inside a completed version's own `compose` key
   in the list response (see the first `data[]` entry in the sample above).
2. `remix.textPrompt` - only present on some version entries, e.g. ones the
   list endpoint surfaces from earlier/different adaptation actions in the
   same session (see the second `data[]` entry in the sample above, which has
   no `compose` key at all, only `remix`).

### `media_url`: only trust `asset.previewUrl` on a `completed` version

`compose.clientSettings.modifications[].audioUrl` (present already on the
draft/compose response) LOOKS like it could be the final asset, but it is
NOT - it is a draft/preview URL. The confirmed final asset only exists at
`asset.previewUrl`, and only once `status == "completed"` (the `asset` key
itself is absent on draft/pending versions). Reading `modifications[].
audioUrl` as the final asset would be silently wrong - `media_url` is
deliberately left `null` until the version is genuinely `completed`.

## Credits: confirmed flat rate, not a formula

**No credits field exists in ANY of the three response bodies above.** This
is a genuine gap in Epidemic Sound's own API, not a parsing miss. The
confirmed number (`ADAPTATION_CREDITS_FLAT_RATE = 1000` in `constants.py`)
comes from two independent, converging signals observed live on 2026-08-19:

1. The Adapt UI itself shows a static **"Uses 1000 credits"** label before
   submission.
2. A real account credit-balance delta was observed across one full
   submission: **2500 -> 1500**, exactly 1000.

This is treated as a flat rate applied to every captured adaptation (not a
per-second/per-stem/per-prompt-length formula) because the UI never shows a
different number for a different prompt or a different original track.
Honestly: only **one** real submission has ever been observed end-to-end, so
this is a single confirmed data point generalized to a flat rate, not a
guess pulled from documentation - if a submission is ever observed costing
something other than 1000, this constant (and this section) needs updating.
Same "confirmed once, documented honestly, not invented" discipline as
`providers/elevenlabs/normalization.py`'s `MUSIC_CREDITS_PER_SECOND` and
`providers/suno/normalization.py`'s permanently-null `credits_used`.

## Auth

Same cookie-session-based, ticket-resolved auth as downloads - no changes
needed, `_resolve_usage_event_actor` is shared across every `event_type` this
provider's `capture/events` endpoint accepts.

## Asset mirroring

Same approach as downloads' own asset mirroring (see that section above):
`asset.previewUrl` is real but signed/time-limited and requires the
browser's own authenticated session, so this backend can never
independently re-fetch it. The extension pushes the already-fetched bytes to
`POST /capture/adaptation-media`, keyed by `client_event_id` (the id the
`adaptation_version` event carrying the `"completed"` status was reported
under), and `EpidemicAdaptation.to_dict()` mints a fresh short-lived
presigned R2 URL from the stored object key on every read.

## Known gaps (Adapt)

- Only ONE end-to-end submission has ever been captured live (2026-08-19) -
  the credits figure above is a single confirmed data point, not a large
  sample.
- No confirmed 4th `status` value (e.g. a failed/errored adaptation) - only
  `draft`/`pending`/`completed` have been observed.
- No confirmed sample of a version whose `compose.clientSettings.
  modifications[]` is empty AND has no `remix` key either - `prompt` would
  come back `null` in that case (defensive fallback, not an error), but this
  exact combination has not been separately observed.
