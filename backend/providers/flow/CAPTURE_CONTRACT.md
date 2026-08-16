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

## Confirmed network shape

Flow's generation API lives on a **different host** than the page itself:
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
