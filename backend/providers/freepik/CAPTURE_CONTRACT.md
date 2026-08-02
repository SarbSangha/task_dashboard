# Freepik/Magnific Capture Contract

The extension <-> backend wire contract for `POST /api/providers/freepik/capture/events`.
Mirrors the shape of `providers/chatgpt/CAPTURE_CONTRACT.md` (envelope fields,
versioning rule) with Freepik-specific identity/ownership fields layered on.

## Reliability class: BEST_EFFORT

Unlike ChatGPT (LOSSLESS - never intentionally discards a queued event),
Freepik capture is **BEST_EFFORT**, the same class as Kling: there is no
webhook or server push for Freepik's "my creations" endpoint, so completeness
is inherently bounded by whether an employee has Freepik open through our
launcher. A queue that can't flush after `FREEPIK_CAPTURE_RETRY_MAX_ATTEMPTS`
(background-freepik-capture.js) is dropped rather than retried forever - the
reconciliation sync (below) is the backstop for anything lost this way, not
an indefinite local retry queue.

## Envelope (`CaptureEventIn`, schemas.py)

| Field | Notes |
|---|---|
| `event_type` | `generation_submitted` \| `generation_listing_row` |
| `client_event_id` | Idempotency key, scoped to `(provider, credential_id)` - never break old clients by changing this scope |
| `creation_id` / `family_id` | Routing keys the extension already parsed out, not buried in `payload` |
| `is_reconciliation` | **Never inferred** - `true` only when the extension is walking historical pages via the sync cursor, `false` for anything observed as a natural consequence of Freepik's own UI. This is the sole switch between "attribute to the ticket user" and "leave ownership unknown" - see normalization.py |
| `payload` | The raw intercepted "file" object (see field mapping below) - opaque to capture.py |
| `capture_version` | Bump `CAPTURE_SCHEMA_VERSION` in constants.py when `payload`'s shape changes in a way normalization.py must branch on |
| `extension_ticket` / `usage_ticket` | Same ticket fields Kling's usage-event payload sends; resolved via the exact same `_resolve_usage_event_actor` - **required** for a non-reconciliation event to end up attributed (absent -> falls back to plain session, logged as `ownership_source="session"`, still valid but lower-confidence) |

## Field mapping: Freepik "file" object -> `FreepikGeneration`

One `payload` is one entry from the "my creations" listing's `data[]` array
(or the equivalent single-object shape from a generation-submit response).
`normalization.py`'s `_extract_fields()` is the authoritative implementation;
this table is the human-readable index into it.

| Freepik JSON path | Column |
|---|---|
| `creation.id` | `creation_id` |
| `creation.identifier` | `identifier` |
| `reference` | `reference` |
| `creation.family` | `family_id` |
| `creation.metadata.index` | `variant_index` |
| `external_id` | `external_id` |
| `creation.metadata.request_id` | `request_id` |
| `creation.metadata.task_id` | `task_id` |
| `creation.metadata.iqsTaskId` | `iqs_task_id` |
| `creation.metadata.transactionId` | `transaction_id` |
| `creation.metadata.projects_folder_reference` | `project_folder_reference` |
| `name` (top level - **misleading name**, this is prompt-like text, not a title) | `name_field` |
| `creation.metadata.prompt` | `prompt` |
| `creation.metadata.inputPrompt` | `input_prompt` (pre smart-prompt-rewrite original) |
| `creation.metadata.variationPrompt` | `variation_prompt` |
| `creation.metadata.smartPrompt` | `smart_prompt` |
| `creation.tool` | `tool` |
| `tool_name` (top level) | `tool_name` |
| `creation.metadata.mode` / `.slug` / `.service` | `mode` / `slug` / `service` |
| `creation.metadata.aspectRatio` / `.resolution` / `.width` / `.height` / `.outputWidth` / `.outputHeight` / `.seed` | as named |
| `creation.metadata.tags` / `.modifiers` / `.imageReferences` | `tags_json` / `modifiers_json` / `image_references_json` (stored verbatim - `imageReferences` entries look like `{type,image:"creation:<id>",label,category}`, used for image-to-image lineage, resolved to another `FreepikGeneration` opportunistically, never blocking) |
| `creation.status` / `.persisted` / `.visible` / `.is_watermarked` / `.nsfw` / `.public` / `.stored` / `.is_last` | as named |
| `shared` (top level) | `shared` |
| `creation.metadata.creditLedgerTotals.credits` | `credits_charged` (actual charge - **0 on an unlimited-plan generation**, not "free") |
| `creation.metadata.creditLedgerTotals.creditsEstimated` | `credits_estimated` |
| `creation.metadata.creditLedgerTotals.unlimitedCredits` | `unlimited_credits` |
| `creation.metadata.creditLedger` (array) | `credit_ledger_json` verbatim |
| `creation.preview` / `.large_preview` / `.raw` / `.webUrl`, `thumbnail.url` (top level), `download_url` (top level) | asset URL columns |
| `creation.properties.blurhash` / `.ratio` | `blurhash` / `ratio` |
| `file_size` / `file_type_id` / `origin` (top level) | as named |
| `folder_id` / `folder_name` / `folder_reference` (top level) | as named |
| `creation.metadata` (whole object) | `metadata_json` (verbatim, catch-all) |
| `creation.metadata.source_metadata` (whole object) | `source_metadata_json` (verbatim, catch-all) |

Anything not in this table is not lost - `metadata_json`/`source_metadata_json`
hold the full nested objects, so a future column can be backfilled from
existing rows without re-capturing.

## Ownership decision table (normalization.py)

| `is_reconciliation` | ticket present | Result |
|---|---|---|
| `false` | yes | `ownership_status="resolved"`, `ownership_source="ticket"`, `generation_source="live_capture"` |
| `false` | no (session only) | `ownership_status="resolved"`, `ownership_source="session"`, `generation_source="live_capture"` |
| `true` | (irrelevant) | `ownership_status="unknown"`, `ingestion_source="recovered"`, `generation_source="reconciliation"` - **never** attributed, regardless of who ran the scan |

Sticky rule: once `ownership_status="resolved"`, no later re-capture
(reconciliation or otherwise) of the same `creation_id` ever changes
`owner_user_id` - only the explicit claim/revoke/reassign flow on
`generation_records_router.py` can. This is the exact rule that fixed a real
production incident on Kling (see the architecture plan).

## Reconciliation sync wire contract (`POST /sync/cursor`)

Reported by the extension after walking one or more listing pages with
`is_reconciliation=true` events already sent for any newly-discovered rows.
`last_synced_page`/`last_seen_creation_id` only ever move forward for an
incremental walk; a full reconciliation (admin-triggered, walks every page
regardless of cursor) always overwrites. See `sync.py`.

## Versioning rule

Never repurpose an existing `CaptureEventIn` field for a different meaning.
Adding a field is safe (old extension versions just don't send it,
defaulting server-side); changing what an existing field means requires
bumping `CAPTURE_SCHEMA_VERSION` and branching on `capture_version` in
`normalization.py`, exactly as ChatGPT's contract requires.
