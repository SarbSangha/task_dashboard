# Splice Capture Contract

The extension <-> backend wire contract for
`POST /api/providers/splice/capture/events`. Mirrors
`providers/epidemicsound/CAPTURE_CONTRACT.md`'s own "Downloads" section (the
`_normalize_download_click_event` pattern) - see that file for the pattern
this is built on. Splice has no Adapt-equivalent second surface - this is the
whole contract for this provider.

## What this provider is

Splice (splice.com) is a sample/loop LIBRARY - users browse audio samples and
click a per-row Download button to download them. There is no "Generate"
action, no prompt, and no generation identity of any kind. Captured as
`download_click` events, normalized into `SpliceDownload` - always a new row,
never upserted (same reasoning as `EpidemicDownload`/`EnvatoDownload`: each
download is its own real user action, not something to merge against a prior
download of the same sample).

## Reliability class: BEST_EFFORT

Same class as every other capture provider in this codebase: there is no
webhook or server push from Splice, so completeness is bounded by whether an
employee has the site open through our launcher.

## Confirmed network shape (CONFIRMED REAL, live capture, 2026-08-19)

This is not a guess or an inference from a screenshot - it is a real
request/response pair captured live from the running site.

Request:

```
POST https://surfaces-graphql.splice.com/graphql
```

Response (200 OK):

```json
{
  "data": {
    "asset": {
      "__typename": "SampleAsset",
      "files": [
        {
          "uuid": "53005e1a-0f07-482a-a5fa-0bc0b72f8391",
          "name": "",
          "url": "https://spliceproduction.s3.us-west-1.amazonaws.com/audio_samples/{hash}-scrambled/{hash}.mp3?X-Amz-...&X-Amz-Expires=21600&...",
          "asset_file_type_slug": "preview_mp3",
          "path": "audio_samples/{hash}-scrambled/{hash}.mp3",
          "__typename": "AssetFile"
        },
        {
          "uuid": "52bc1d53-8b27-44bf-b450-6de246d38034",
          "name": "",
          "url": "https://spliceblob.splice.com/audio_samples/{hash}.wv.json",
          "asset_file_type_slug": "waveform",
          "path": "/audio_samples/{hash}.wv.json",
          "__typename": "AssetFile"
        },
        {
          "uuid": "",
          "name": null,
          "url": "https://spliceproduction.s3.us-west-1.amazonaws.com/audio_samples/{hash}?X-Amz-...&X-Amz-Expires=119&...",
          "asset_file_type_slug": "source",
          "path": null,
          "__typename": "AssetFile"
        }
      ]
    }
  }
}
```

Then the browser GETs the "source" file's signed URL directly - the real
download:

```
GET {source url}
-> 200 OK, Content-Type: audio/wav, Content-Length: 1432764, Access-Control-Allow-Origin: https://splice.com
```

## Identity: sample_hash, parsed from the source URL - not an explicit id

There is **no explicit sample id/uuid** anywhere in the confirmed response
body (the `files[].uuid` values are per-FILE uuids, e.g. one for the
preview_mp3 entry and one for the waveform entry - the source entry's own
`uuid` is even observed empty). The `{hash}` embedded in the `audio_samples/
{hash}...` path segment (e.g.
`12908ad00dc905834dc604243940d138b4247ae4bd96f7c622934507cd971e08`) is a
stable per-sample content identifier shared between the `preview_mp3` and
`source` file paths - the closest thing to a sample identity in this data.

`normalization.py`'s `_extract_sample_hash` parses this out of the
**source** file's URL (not the `preview_mp3` path, since the extension sends
`sourceUrl` as the primary payload field) via the regex
`audio_samples/([0-9a-f]{20,})` - the character class stops naturally at
`-`, `/`, `.`, `?` (none of which are hex digits), so one pattern handles
both the `preview_mp3` path's `-scrambled` suffix and the `source` URL's
query string without a separate strip step. Stored in
`SpliceDownload.sample_hash` as a reference/filterable column only, **never**
a dedup key - every captured `download_click` event produces its own new
`SpliceDownload` row (see "Identity" reasoning above).

There is also **no BPM/key/pack name** and **no credits/quota field**
anywhere in the confirmed response (unlike Epidemic Sound's own
`remainingDownloads`) - no equivalent column is invented on
`SpliceDownload`.

## Field mapping

| Source | Field | Column | Notes |
|---|---|---|---|
| extension-derived (button's own filename text, not the graphql response) | `assetTitle` | `asset_title` | e.g. `"GrenadeExplosion_S08WA.219.wav"` |
| graphql response (`files[]`, `asset_file_type_slug == "source"`) `.url` | `sourceUrl` | `asset_source_url` | the real download URL - signed, expires in **119 seconds** (see below) |
| graphql response (`files[]`, `asset_file_type_slug == "preview_mp3"`) `.url` | `previewMp3Url` | `preview_mp3_url` | longer-lived (21600s / 6h) - informational only, never the mirrored asset |
| parsed from `sourceUrl`'s path | n/a | `sample_hash` | see "Identity" above |
| extension-derived | `sourceHost` | `source_host` | |
| extension-derived | `pageUrl` | `page_url` | |
| extension-derived | `downloadedAt` | `downloaded_at` | ISO timestamp; falls back to the capture event's own `created_at` if missing/unparseable |

`payload_json`/`metadata_json` always retains the full raw payload the
extension sent regardless of how the above fields parse, so nothing is ever
lost.

## Coordination contract (exact key names)

Per the extension/backend coordination for this build, `CaptureEventIn.payload`
carries at minimum these keys from the extension:

- `sourceUrl` - the short-lived signed "source" wav URL
- `previewMp3Url`
- `assetTitle` - filename string, e.g. `"GrenadeExplosion_S08WA.219.wav"`
- `sourceHost`
- `pageUrl`
- `downloadedAt` - ISO timestamp

`_normalize_download_click_event` reads these exact key names as the primary
source, with `.get()` fallbacks to a couple of alternate spellings
(`source_url`/`assetSourceUrl`, `preview_mp3_url`/`previewMp3`,
`asset_title`/`filename`, `source_host`, `page_url`, `downloaded_at`) - this
codebase's standard "candidate keys" convention, since the extension side is
not fully in our control. No field is ever required; a missing/renamed key
degrades to `None` rather than raising.

Event type string: **`"download_click"`** (exact match required - a previous
provider build shipped with the extension sending `"feed_clip"` while the
backend expected `"clip"`, and every single event was silently rejected for a
long time before anyone noticed. This string is deliberately spelled out
here to prevent a repeat.)

## The 119-second expiry (extension's problem, not backend's)

The "source" file's signed URL expires in only **119 seconds** - the
shortest expiry of any provider captured this session (Epidemic Sound's
`assetUrl`, for comparison, has no confirmed expiry this short). This means
the extension pushes the actual audio bytes to `POST /capture/download-media`
almost immediately after the download click, rather than lazily. This is
entirely an extension-side timing concern - the backend's mirroring flow
(`capture_download_media` in `router.py`) is identical to every other
provider's, just correlated by `client_event_id` as always; no special
backend handling exists or is needed for the short expiry.

## No credits field - do not invent one

Unlike Epidemic Sound's confirmed `remainingDownloads` counter, **no
credits/quota/remaining-downloads field exists anywhere** in the confirmed
graphql response. `SpliceDownload` deliberately has no `credits_used`- or
`remaining_downloads`-style column - same "don't guess a cost" discipline as
`EpidemicDownload`'s own absence of a credits column.

## Auth

Cookie-session-based, same as every other best-effort capture provider - no
backend changes needed for auth beyond the standard ticket-based actor
resolution every `DIRECT_TICKET_ONLY_TOOLS` provider already uses
(`_resolve_usage_event_actor`, the same function every other provider's
`capture.py` calls).

## Asset mirroring

The "source" file's signed URL is real but time-limited (119s) and requires
the browser's own authenticated session to have been fetched at all - this
backend can never independently re-fetch it. Same asset-mirroring approach as
`EpidemicDownload.mirrored_asset_key`/`asset_mirror_status` used verbatim:
the browser extension pushes the already-fetched bytes to
`POST /capture/download-media`, keyed by `client_event_id` (the same id the
original `download_click` event was reported under), and
`SpliceDownload.to_dict()` mints a fresh short-lived presigned R2 URL from
the stored object key on every read (see
`providers/splice/models.py`'s `_presigned_mirror_url`).

## Route set (confirmed)

- `POST /api/providers/splice/capture/events`
- `POST /api/providers/splice/capture/download-media`
- `POST /api/providers/splice/capture/health`
- `GET /api/providers/splice/health` (admin-gated)
- `GET /api/providers/splice/downloads` (admin-gated)
- `GET /api/providers/splice/downloads/{download_id}` (admin-gated)
- `GET /api/providers/splice/events` (admin-gated)
- `GET /api/providers/splice/events/{event_id}` (admin-gated)

No `/sync/cursor` route exists (no reconciliation walker - no confirmed "my
downloads" history/listing endpoint on the site itself, capture is live
network-intercept only).

## Out of scope for this build

- **Bulk/pack downloads** - Splice supports downloading an entire sample
  pack in one action; no real traffic for that flow was captured, so its
  shape (single `files[]` array vs. multiple, one `download_click` event vs.
  many) is unconfirmed and unhandled.
- **Non-wav download variants** - only a single `.wav` "source" file
  download was observed. Any other format Splice may offer (stems, MIDI,
  alternate bit depths) has not been captured and is not handled.
- **Music-only / non-SFX distinctions, BPM/key/pack metadata** - none of
  these are present in the confirmed response at all (unlike, say, Epidemic
  Sound's `is_sfx`/`qualityType`/`stemType`), so no columns exist for them.

## Known gaps

- No confirmed "my downloads" history/listing endpoint on the site itself,
  so there is no reconciliation/backfill walker - capture is live
  network-intercept only.
- Only one end-to-end download has been captured live (2026-08-19) - the
  field mapping above is a single confirmed data point, not a large sample.
- No confirmed non-200 / error response shape for a failed download attempt.
