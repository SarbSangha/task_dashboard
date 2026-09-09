# Flow Capture Contract

The extension <-> backend wire contract for `POST /api/providers/flow/capture/events`.
Mirrors `providers/freepik/CAPTURE_CONTRACT.md`'s shape (envelope fields,
ownership decision table, versioning rule) with Flow-specific identity fields
layered on.

## Reliability class: BEST_EFFORT

Same class as Freepik/Kling: there is no webhook or server push for Flow's
generation API, so completeness is inherently bounded by whether an employee
has Flow open through our launcher. A queue that can't flush after
`FLOW_CAPTURE_QUEUE_HARD_LIMIT`/max retry attempts (background-flow-capture.js)
is dropped rather than retried forever. No reconciliation sync exists for
Flow yet (unlike Freepik's `/sync/cursor`) - anything lost to a dropped queue
is currently unrecoverable. Worth building if this turns out to matter in
practice.

## Primary capture path: asset observation (2026-09-07)

`content-flow.js` captures a generation by **observing the generated asset
download**, not by decoding Google's RPC. This is the path that actually
runs; the batchexecute decoder described below is a secondary path that
takes precedence only when it genuinely succeeds.

Rationale: post-migration, the only generation traffic is `/batchexecute`,
whose method is an opaque `rpcids` code that rotates per Google build and
whose payloads are positional arrays with no field names. Building capture
on that means re-deriving an unnamed wire format after every Google release.
The generated image, by contrast, *has* to be downloaded and shown to the
user - that is observable through Resource Timing with no selectors, no
request-body shape, and no dependency on Google's naming.

The join to this contract is exact rather than inferred: in all 26 rows
captured before the migration, `media_url` is `.../image/<uuid>` where that
`<uuid>` is byte-for-byte the row's own `primary_media_id` - the key
`_normalize_media_url_event` already binds on. Remaining fields:

| Field | Source |
|---|---|
| `name` (creation id) | the media uuid from the asset URL |
| `primaryMediaId` | same uuid |
| `projectId` | `flow.google.com/project/<uuid>`, off `location` |
| `displayName` (prompt) | the composer, tracked live via `input` events |
| `batchId` | the arm cycle's `generateIntentId` - exactly "one Generate click" |
| `createTime`/`updateTime` | observation time |

`_extract_fields()` consumes this unchanged, so **no backend change was
required**. Rows built this way carry `metadata.rmwCaptureSource =
"asset-observation"` in `metadata_json` to distinguish them from rows
decoded out of a real `flowWorkflows` response.

Safeguards: every media id seen while unarmed is recorded and can never
later be treated as fresh output (so scrolling an existing gallery captures
nothing); assets are only collected inside an armed window; a settle delay
groups one click's images into a single batch and lets the network path win
if it lands first; and per-cycle counting distinguishes network-decoded rows
from asset-built ones, so precedence never suppresses a later generation in
the same window.

Covered by `browser-extension/tool-hub-autologin/tests/flow_asset_capture_smoke.js`
(runs the real content script under a stubbed page; `node tests/flow_asset_capture_smoke.js`).

## Surface migration (2026-09-07) - READ FIRST

Google moved the real Flow app from `labs.google/fx/tools/flow` to
**`flow.google.com`**, and with it the entire transport. The
`aisandbox-pa.googleapis.com` REST surface documented in the next section is
**no longer used by a live generation**. Everything the app does now goes
through Google's generic RPC framework at

    https://flow.google.com/_/AiSandboxAngularFrontend/data/batchexecute?rpcids=<opaque>&bl=<build tag>&...

where the method is an opaque `rpcids` code that **rotates per Google build**
(`bl=boq_labs-ai-sandbox-frontend_20260903.13_p1`) - two captures minutes
apart showed ~20 codes each with no overlap, so no rpcids allowlist can be
relied on. See content-flow-network.js's own comments for the DOM-armed gate
that replaced rpcid matching.

Consequence for capture, and the bug it caused: `shouldInspectUrl()`
originally hard-required the REST host, so after the migration every
generation response was rejected before its body was read. On 2026-09-07 a
real generation armed the picker correctly
(`[RMW Flow Capture] armed {taskId: 1161, clientId: 2}`) and still produced
**zero** capture events - the last row in `flow_capture_events` was from
2026-08-14. `shouldInspectUrl()` now accepts any `/batchexecute` URL
host-independently, and `inspectBatchExecuteResponse()` decodes the envelope
(XSSI prefix + length-framed chunks + a double-encoded JSON payload string
per `wrb.fr` frame) before the existing shape checks run over it.

**Open gap:** batchexecute payloads are *positional arrays*, not the
named-field objects below. Where `looksLikeFlowWorkflowObject()` still
matches inside a decoded frame, capture works unchanged. Where it does not,
`reportBatchExecuteMappingCandidate()` logs the uuids / timestamps / media
URLs / text candidates it found **with their array paths**, which is what a
correct positional mapping should be written from. No mapping is guessed.

## Confirmed network shape

Historical (pre-2026-09-07 migration - see above; kept because rows
captured before that date use this shape, and the field names below are
still the contract the backend normalizes against).

Flow's generation API lived on a **different host** than the page itself:
`https://aisandbox-pa.googleapis.com`, not `labs.google`. The page's own JS
calls this cross-origin directly via `fetch`/XHR with a Bearer OAuth token.
One generation = one `flowWorkflows/{uuid}` resource, `PATCH`ed by the
client. Confirmed real response (captured live, two images generated from
one prompt):

```json
{
  "name": "0a53c5d4-7326-4b96-8bf4-1e97b0afa49a",
  "projectId": "b7d77f67-311f-40a6-8d60-94e8ed42d4db",
  "metadata": {
    "displayName": "Boy paragliding",
    "createTime": "2026-08-11T10:53:35.925841Z",
    "updateTime": "2026-08-11T10:53:48.657180Z",
    "primaryMediaId": "79dac7fe-8102-403a-ac29-7a2f7250cb42",
    "batchId": "9087cb97-bb1a-4b51-baad-e05aab69065b"
  }
}
```

`metadata.batchId` is the "one Generate click" grouping key - both images
from the one prompt above shared this exact value, with different `name`/
`primaryMediaId`. This is Flow's equivalent of Freepik's single "creation"
row, just split across N `flowWorkflows`.

## Envelope (`CaptureEventIn`, schemas.py)

| Field | Notes |
|---|---|
| `event_type` | Always `generation_workflow_row` in this first pass (see constants.py's `ALL_EVENT_TYPES`) |
| `client_event_id` | Idempotency key, scoped to `(provider, credential_id)` - never break old clients by changing this scope |
| `creation_id` / `family_id` | `flowWorkflows.name` / `metadata.batchId`, parsed out by content-flow.js, not buried in `payload` |
| `is_reconciliation` | Always `false` today - no reconciliation walker exists for Flow yet |
| `payload` | The raw intercepted `flowWorkflows` object - opaque to capture.py |
| `capture_version` | Bump `CAPTURE_SCHEMA_VERSION` in constants.py when `payload`'s shape changes in a way normalization.py must branch on |
| `extension_ticket` / `usage_ticket` | Same ticket fields every other `DIRECT_TICKET_ONLY_TOOLS` provider sends; resolved via the exact same `_resolve_usage_event_actor` |

## Field mapping: `flowWorkflows` object -> `FlowGeneration`

`normalization.py`'s `_extract_fields()` is the authoritative implementation;
this table is the human-readable index into it.

| Flow JSON path | Column |
|---|---|
| `name` | `provider_creation_id` |
| `projectId` | `project_id` |
| `metadata.batchId` | `batch_id` |
| `metadata.displayName` | `prompt` |
| `metadata.primaryMediaId` | `primary_media_id` |
| `metadata.createTime` | `provider_created_at` |
| `metadata.updateTime` | `provider_updated_at` |
| `metadata` (whole object) | `metadata_json` (verbatim, catch-all) |

Anything not in this table is not lost - `metadata_json` holds the full
nested object, so a future column can be backfilled from existing rows
without re-capturing.

## Known gaps (first pass)

- **No resolved media URL.** `primary_media_id` is captured, but resolving
  it to an actual downloadable/viewable URL requires also capturing the
  page's own `media.getMediaUrlRedirect?name={id}` response (a *different*
  request, on `labs.google` itself, not `aisandbox-pa.googleapis.com`).
  `content-flow-network.js` does not do this in this first pass -
  `FlowGeneration.media_url`/`thumbnail_url` stay null until that's added.
- **Video generation shape is unconfirmed.** Only images have been captured
  live so far. If video's `flowWorkflows` response differs (e.g. carrying
  extra fields, or media living in a nested collection the way Freepik's
  `metadata.mediaCollection` does for its own video tool - see
  `providers/freepik/normalization.py::_extract_video_asset` for that
  precedent), `_extract_fields()` needs a follow-up pass once observed.
- **No status field observed.** The one confirmed payload carries no
  generation-status field at all (just `createTime`/`updateTime`) -
  `status`/`GENERATION_STATUS_*` exist in the model/constants for parity
  with every other provider, but are currently always null in practice.
- **No "list all generations for a project" capture.** Not needed for live
  capture (shape-based per-event detection doesn't require it), but means
  there's no reconciliation/backfill source yet if a capture event is ever
  missed.

## Ownership decision table (normalization.py)

| `is_reconciliation` | ticket present | Result |
|---|---|---|
| `false` | yes | `ownership_status="resolved"`, `ownership_source="ticket"`, `generation_source="live_capture"` |
| `false` | no (session only) | `ownership_status="resolved"`, `ownership_source="session"`, `generation_source="live_capture"` |
| `true` | (irrelevant) | `ownership_status="unknown"`, `ingestion_source="recovered"`, `generation_source="reconciliation"` - not reachable today (no reconciliation walker), kept for schema parity |

Sticky rule: once `ownership_status="resolved"`, no later re-capture ever
changes `owner_user_id` - only an explicit admin claim/revoke/reassign flow
could (not built for Flow yet, since Freepik's equivalent lives in
`generation_records_router.py` at the `GenerationRecord` level, which Flow
already projects into).

## Versioning rule

Never repurpose an existing `CaptureEventIn` field for a different meaning.
Adding a field is safe (old extension versions just don't send it,
defaulting server-side); changing what an existing field means requires
bumping `CAPTURE_SCHEMA_VERSION` and branching on `capture_version` in
`normalization.py`, same rule every other provider follows.
