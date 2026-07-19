# ChatGPT Assistant-Response Reconstruction — Engineering Report

Scope: why the Capture Center showed "No chat content captured yet" / garbled
partial text instead of a faithful replay of ChatGPT responses, and the fix
across the browser extension, database, backend, and frontend. Investigated
and implemented against this repository's live production database
(`backend/.env`'s Supabase Postgres instance) rather than assumption.

---

## 1. Root Cause

Five distinct, independently-confirmed problems, not one bug:

1. **The extension's SSE reconstruction silently corrupts assistant text.**
   `content-chatgpt-network.js` rebuilds the assistant's message by applying
   incremental JSON-Pointer-style patches (`{p, o, v}`) from ChatGPT's
   streaming response, guessing at an undocumented operation vocabulary
   (checking `op === 'append'` literally). This was written without ever
   capturing a real HAR to verify the wire format — `NETWORK_DISCOVERY_GUIDE.md`
   is a HAR-collection checklist that was written but never actually executed,
   and the code's own comments (lines 313-317, 364-372 pre-fix) admit this is
   "untested against a live HAR."

   Direct query of the production `conversation_capture_events` table
   confirmed the consequence: **100% of 12+ sampled `response_completed`
   rows contained short, grammatically mangled, mid-sentence-truncated
   text**, e.g.:
   > `"Yes. In fact, **this is exactly what I would do as approving code that
   > you already suspect may still need refinement."`

   This reads like the true answer's opening clause spliced directly to its
   closing clause, with the entire body dropped — consistent with a
   mid-stream patch operation replacing (rather than appending to) the
   accumulated text. This was the dominant cause of bad captures, not an
   edge case: every single sampled row exhibited it.

2. **No image/artifact capture path existed at all.**
   `extractAssistantTextFromMessage()` only read string elements of
   `message.content.parts`, silently discarding `image_asset_pointer`
   objects. `finalize()` never populated the contract's `images`/`artifacts`
   fields. Confirmed: 0 of 41 real `response_completed` events had any image
   data. `ConversationCaptureAttachment.kind='output'` was a column already
   reserved in the schema for exactly this, explicitly documented as "not
   implemented yet."

3. **Phase 3 normalization was fully-designed dead schema.**
   `ConversationRecord` / `ConversationPrompt` / `ConversationResponse` /
   `ConversationGeneratedAsset` were fully migrated (DDL already ran on every
   startup) but zero code anywhere constructed one — confirmed via grep and
   via `SELECT count(*)` on production (`0, 0, 0` despite 54 `prompt_captured`
   / 41 `response_completed` raw events already sitting in
   `conversation_capture_events`). `README.md`'s own status table already
   marked this "Pending" — a known, not a discovered, gap.

4. **The frontend was not the bottleneck.**
   `ConversationChatView.jsx` already rendered full markdown fidelity
   (headings, bold, italic, lists, quotes, GFM tables, code, links) via
   `ReactMarkdown` + `remarkGfm` whenever given real text. It was faithfully
   displaying already-corrupted input. Images rendered separately, after
   text, matched by filename — never interleaved at their true position,
   which is the specific "TEXT → IMAGE → TEXT" flattening problem in the
   original brief.

5. **Secondary bug: duplicate `response_completed` events.** Production data
   showed `finalize()` firing twice per assistant turn — e.g. two events
   sharing `provider_message_id`, near-identical text, timestamps ~0.3s
   apart, but *different* `client_event_id`s, so the existing
   `client_event_id` dedupe never caught it. `handleFrame()` called
   `finalize()` once on the `[DONE]` sentinel and the read loop called it
   again unconditionally after the loop ended — both fired on every
   normal-completion turn.

---

## 2. Current Capture Flow (before this change)

```
ChatGPT tab
  └─ content-chatgpt-network.js (MAIN world)
       intercepts fetch/XHR to /backend-api/f/conversation
       reconstructs assistant text from streamed JSON-patch deltas
       (unverified format — confirmed to drop most of the real text)
       posts CHATGPT_RESPONSE_COMPLETED via window.postMessage
  └─ content-chatgpt.js (isolated world)
       builds a Capture Contract event from the signal, verbatim
       (text/codeBlocks/hasMarkdown/hasTables only — no images, no ordering)
  └─ background-chatgpt-capture.js
       queues + POSTs to /api/providers/chatgpt/capture/events
  └─ capture.py: ingest_capture_event()
       stores the raw payload losslessly into ConversationCaptureEvent
       (this part worked correctly — the corruption happened upstream)
  └─ [Phase 3 normalization never existed — dead end]
  └─ queries.py: list_conversation_messages()
       reconstructs chat turns AT READ TIME directly from raw events,
       forwarding whatever (corrupted) text/flags the extension sent
  └─ ConversationChatView.jsx
       renders the (already-corrupted, image-less) text via ReactMarkdown
```

The pipeline's raw-capture layer (`ConversationCaptureEvent`) was and remains
sound — the losslessness guarantee held. The corruption happened entirely in
the extension's own text-reconstruction step, before the payload ever left
the browser.

---

## 3. New Capture Architecture

Rather than continuing to guess at ChatGPT's private streaming patch
vocabulary, the extension now uses the stream only for a fast
`response_started` signal and a "stream ended" trigger. Once the stream
ends, it re-fetches the conversation's own authoritative state from
ChatGPT's own stable conversation-fetch endpoint — the same one the ChatGPT
UI itself uses when you open a past conversation from the sidebar — and
reads the assistant message straight from there:

```
GET /backend-api/conversation/{conversationId}
  → { mapping: { <messageId>: { message: { content: { parts: [...] }, metadata: {...} } } } }
```

`message.content.parts` is an ordered array mixing plain strings (markdown
text segments) and objects like `{content_type: "image_asset_pointer",
asset_pointer: "file-service://...", width, height}` — array order IS true
content order, which is exactly the ordering information the old pipeline
discarded. Each image is resolved via a companion endpoint
(`GET /backend-api/files/{fileId}/download` → signed `download_url`),
fetched, and uploaded through the **existing** input-attachment upload path
(`POST /capture/attachments`), just with `kind: 'output'` — the column
already reserved for this.

```
AssistantResponse
  content[]  (ordered)
    { type: "markdown", order, text }        ← rendered via ReactMarkdown
    { type: "image", order, assetPointer }   ← rendered inline via ChatAttachmentGallery
    { type: "attachment", order, raw }       ← lossless fallback for anything unrecognized
```

If the authoritative fetch fails or the shape doesn't match (e.g. ChatGPT
has changed its API), the extension falls back to the pre-existing
best-effort streamed text — capture never regresses to losing an event
entirely, only to reduced fidelity for that one turn, and the event is
tagged `contentSource: 'stream_fallback'` so this is observable.

The double-`finalize()` bug is fixed with two guards, mirroring the pattern
`response_started` already used (`markTurnStarted`/`consumeTurn` return-value
checks) — one in `content-chatgpt-network.js`, one in `content-chatgpt.js`,
as defense in depth.

---

## 4. Database Changes

Additive only, via the existing idempotent `ADD COLUMN IF NOT EXISTS`
pattern in `migrations.py` (both Postgres and SQLite — a SQLite equivalent
helper, `_sqlite_add_column_if_missing`, was added since one didn't exist
yet):

| Table | New column | Purpose |
|---|---|---|
| `conversation_prompts` | `content_parts_json` (JSON) | Ordered content parts for user prompts |
| `conversation_responses` | `content_parts_json` (JSON) | Ordered content parts — the field that actually solves the "flattening" problem; existing `images_json`/`code_blocks_json`/`artifacts_json` remain as flat summaries |
| `conversation_responses` | `citations_json` (JSON) | Raw, lossless `message.metadata.content_references` |

No existing column, table, or row was altered or removed. Verified by
running `ensure_chatgpt_postgres_schema()` twice in a row against production
— second run is a confirmed no-op — and confirmed the three columns exist
via `information_schema.columns`.

---

## 5. Backend Changes

- **`providers/chatgpt/normalization.py`** (new) — Phase 3, finally
  implemented. `normalize_capture_event(db, event)` dispatches on
  `event_type` (`prompt_captured`, `message_edited`, `response_completed`,
  `generation_captured`) and upserts `ConversationRecord` →
  `ConversationPrompt`/`ConversationResponse`, plus
  `ConversationGeneratedAsset` rows for each image content part (correlated
  to the actual uploaded bytes in `ConversationCaptureAttachment` by file
  id). Every upsert keys off an existing unique/partial-unique index
  (`provider_message_id` per conversation for prompts/responses,
  `provider_asset_id` for assets), so reprocessing the same event — or the
  two duplicate `response_completed` events from the double-`finalize()`
  bug — updates one row, never creates a second. Deliberately **not** called
  from `capture.py` (whose own docstring states raw capture does no parsing
  or business logic); invoked from `router.py` instead, wrapped in
  try/except so a normalization failure never turns a successful raw
  ingest into an HTTP error.
- **`providers/chatgpt/router.py`** — after each successful
  `ingest_capture_event()` call, invokes `normalize_capture_event()`.
- **`providers/chatgpt/queries.py`** — `list_conversation_messages()` now
  prefers normalized `ConversationPrompt`/`ConversationResponse` rows when
  they exist for a conversation, falling back to the original read-time
  raw-event reconstruction for conversations captured before normalization
  existed. Also forwards the new `contentParts`/`citations` fields in the
  raw-event fallback path, so rendering is correct immediately for new
  captures even before a conversation has been backfilled.
- **`backend/scripts/backfill_chatgpt_normalization.py`** (new) — one-off,
  idempotent replay of every historical `ConversationCaptureEvent` through
  the normalizer, for the 54 prompts / 41 responses already sitting
  un-normalized in production.

---

## 6. Frontend Changes

- **`ConversationContentParts.jsx`** (new) — renders a message's
  `contentParts` array in true document order: markdown parts through the
  existing `ReactMarkdown` + `remarkGfm` pipeline, image parts inline via
  the existing `ChatAttachmentGallery`, unrecognized part types rendered as
  a visible muted badge (never silently dropped, matching this codebase's
  established Data Integrity philosophy).
- **`ConversationChatView.jsx`** — `ChatMessage` now branches: if a message
  carries `contentParts`, render `<ConversationContentParts>` (images inline,
  positioned correctly) instead of the old "all text, then all images
  appended below" layout. Falls through unchanged to the original flat-text
  rendering for any message without `contentParts` — old captures render
  byte-for-byte identically to before.

---

## 7. Validation Results

Everything below was actually executed this session, not just written:

| Check | Result |
|---|---|
| Python syntax check (`py_compile`) on all changed/new backend files | PASS |
| Import check (`import providers.chatgpt.normalization/router/queries/migrations`) | PASS — no wiring errors |
| `ensure_chatgpt_postgres_schema()` run twice against production | PASS — idempotent, 3 new columns confirmed via `information_schema.columns` |
| `ensure_chatgpt_sqlite_schema()` run twice against a scratch DB | PASS — idempotent |
| `normalize_capture_event()` against a **real historical payload** pulled from production (prompt_captured + response_completed pair) | PASS — correct `response_text`, prompt↔response linkage |
| `normalize_capture_event()` against a synthetic post-fix payload with `contentParts` (markdown + image + unrecognized-type parts) | PASS — `content_parts_json`/`citations_json` populated correctly, `ConversationGeneratedAsset` row created for the image part |
| Duplicate `response_completed` events (same `provider_message_id`, different `client_event_id` — the exact double-`finalize()` scenario observed in production) | PASS — normalizes to **one** `ConversationResponse` row, not two |
| `backfill_all()` run twice over a full event log | PASS — idempotent, 0 errors |
| `list_conversation_messages()` normalized-read path, round-tripping `contentParts`/`citations` through to the API response shape | PASS |
| Frontend: `npm run build` (production Vite build) | PASS — no errors |
| Frontend: `eslint` on new/changed components | PASS — no warnings |
| Extension: `node --check` syntax validation on all 4 changed files | PASS |
| Extension field-name cross-check: the new output-image upload message shape against `background-chatgpt-capture.js` → `attachments.py`'s `CaptureAttachmentIn` schema | Confirmed matching |

**Not validated (cannot be, without a live browser session):** the
extension's actual behavior against a real ChatGPT tab — the
`/backend-api/conversation/{id}` and `/backend-api/files/{id}/download`
endpoint shapes, and the SSE `response_started` detection. See Known
Limitations.

---

## 8. Known Limitations

- **Extension changes are unverified against a live ChatGPT session.** I
  have no browser to drive. The authoritative-fetch endpoints are
  long-established in the broader ChatGPT ecosystem and defensively coded
  (any failure/shape-mismatch falls back to the pre-existing stream-text
  path rather than losing the event), but full-fidelity capture for this
  turn depends on those endpoints matching what's coded. **Action needed:**
  load the rebuilt extension against a real ChatGPT account and confirm (1)
  a plain-text turn produces exactly one `response_completed` with no
  duplicate `provider_message_id`, (2) an image-generating turn produces a
  resolved `image` content part and a `kind='output'` attachment row, (3)
  blocking `/backend-api/conversation/{id}` in DevTools still produces an
  event (via `stream_fallback`), never a lost one.
- **Citation rendering is lossless but not yet inline.**
  `message.metadata.content_references` is captured verbatim into
  `citations_json`, but the marker syntax ChatGPT embeds in the text itself
  to reference a citation is not yet parsed into inline hyperlinks — needs a
  live sample to get right rather than guessed at (the same mistake that
  caused root cause #1).
- **Historical conversations need the backfill script run once** (
  `python scripts/backfill_chatgpt_normalization.py`) to populate
  `ConversationPrompt`/`ConversationResponse` for the 54/41 events already
  captured — until then, `list_conversation_messages()` correctly falls back
  to the raw-event path for those specific conversations (no data loss, just
  not yet on the new structured path).
- **`generation_captured` handling exists but is currently unreachable** —
  the extension doesn't emit this event type (images now flow through
  `response_completed`'s `contentParts` instead); the handler in
  `normalization.py` is forward-compatible scaffolding for a possible future
  DOM-fallback capture path, not exercised by the current pipeline.

---

## 9. Future Improvements

- Resolve and render inline citations once a live HAR sample confirms the
  marker syntax.
- Extend `_upsert_prompt`/normalization to also populate `ConversationRecord`
  title/model metadata from `conversation_opened`/`conversation_created`/
  `conversation_renamed` events (out of scope for this fix — the read path
  changed here, `list_conversation_messages`, doesn't need conversation-level
  metadata; `get_conversation_detail` still uses the original raw-event
  reconstruction and was left untouched).
- Once `extension_version`/`capture_version` distribution data exists
  (Phase 6, analytics — still not built), confirm live adoption of the new
  extension before treating `stream_fallback` captures as rare enough to
  stop investing in.
- Consider persisting a short-lived cache of resolved `download_url`s if
  image-heavy conversations turn out to trigger redundant
  `/backend-api/files/{id}/download` calls across retries.
