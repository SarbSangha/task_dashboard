# ChatGPT Capture Contract (capture_version 1)

This is the wire contract between the browser extension and
`POST /api/providers/chatgpt/capture/events`. It is the thing the extension
and the backend must agree on forever - see `providers/chatgpt/schemas.py`
(`CaptureEventIn`) for the enforced shape and `providers/chatgpt/constants.py`
for the canonical `event_type` values.

**Versioning rule:** changing a payload shape below in a backward-incompatible
way (rename/remove/retype a field) requires bumping `capture_version`. The
backend never rejects an unrecognized `capture_version` - raw capture's job is
to never lose an event - it just gets logged and Phase 3's normalization step
branches on `capture_version` per event when interpreting `payload_json`.
Adding a new *optional* field to an existing payload does not require a bump.

## Compatibility matrix

| Capture Version | Backend Support | Status |
|---|---|---|
| 1 | ✅ Yes | Current |
| 2 | - | Reserved (not yet defined) |

Update this table the moment a new `capture_version` is introduced, *before*
any extension build ships it - "Backend Support" must go ✅ first. Never
remove a row here without confirming (via `extension_version`/`capture_version`
distribution in analytics, once Phase 6 exists) that zero recent events still
arrive at that version. Dropping backend support for an old version is a
deliberate decision recorded as a row edit here, not a silent code change.

## Reliability class: LOSSLESS

ChatGPT capture is **LOSSLESS**, not best-effort - see
`EXTENSION_CAPTURE_DESIGN.md` for what that means for the extension's retry
queue. Concretely for this contract: the backend must never treat an
old-but-still-arriving event as an error just because time has passed - a
`client_event_id` retried after being queued offline for days is exactly as
valid as one retried after 30 seconds.

## Envelope (every event)

| Field | Required | Notes |
|---|---|---|
| `event_type` | yes | one of the values in `constants.ALL_EVENT_TYPES` |
| `client_event_id` | yes | extension-generated, stable across retries of the *same* attempt (UUID v4 recommended). This is the idempotency key - not `message_id`, not a hash of content. |
| `conversation_id` | no | ChatGPT's own conversation id, when known |
| `message_id` | no | ChatGPT's own message id, when known |
| `payload` | yes | shape depends on `event_type`, see below. Extra unknown fields are ignored, not rejected. |
| `capture_version` | no | defaults to the current schema version if omitted |
| `extension_version` | no | e.g. `"1.4.2"` - for debugging capture regressions after an extension release |
| `browser` | no | e.g. `"chrome/126"` |
| `tab_id` | no | for diagnostics/multi-tab tracing only - never part of dedup |
| `session_id` | no | dashboard session token (usually filled by the background worker, not the content script) |
| `extension_session_id` | no | per-install/per-launch identifier |
| `credential_id` | no | only if the extension already knows it; the server resolves it from the session otherwise |
| `event_date` | no | ISO date (`YYYY-MM-DD`); defaults to server "today" if omitted |

## Per-`event_type` payload shapes

### `conversation_opened`
```json
{ "title": "optional string", "url": "string", "isNewConversation": true }
```

### `conversation_created`
```json
{ "title": "optional string", "url": "string", "model": "optional string" }
```

### `conversation_updated`
Generic catch-all for metadata changes not covered by a more specific event
(e.g. pin toggle).
```json
{ "changedFields": ["pinned"], "values": { "pinned": true } }
```

### `conversation_renamed`
```json
{ "previousTitle": "optional string", "newTitle": "string" }
```

### `conversation_archived`
```json
{ "archived": true }
```

### `conversation_deleted`
```json
{ "detectedVia": "sidebar_removal" }
```
`detectedVia` is one of `"sidebar_removal"` (inferred - item vanished from the
list) or `"explicit_delete_action"` (observed the delete confirmation itself).

### `prompt_captured`
```json
{
  "text": "string",
  "textLength": 123,
  "attachments": [{ "type": "image", "name": "string", "url": "optional string" }],
  "images": [{ "url": "string" }],
  "files": [{ "name": "string", "mimeType": "optional string", "sizeBytes": 0 }],
  "codeBlocks": [{ "language": "optional string", "code": "string" }],
  "sequenceIndex": 0,
  "promptTimestamp": "ISO 8601 string"
}
```

### `message_edited`
```json
{ "originalMessageId": "string", "newMessageId": "optional string", "newText": "string", "branchIndex": 0 }
```

### `response_started`
Fired once, when the assistant's stream opens. No text yet.
```json
{ "model": "optional string", "sequenceIndex": 0, "startedAt": "ISO 8601 string" }
```

### `response_completed`
Fired once, when the stream ends. Streaming deltas in between are never sent
as events (see README.md "Streaming capture").

As of the extension version that introduced `contentParts`/`citations`/
`contentSource` below, the primary content source is no longer the streamed
text itself - the extension re-fetches the conversation's own authoritative
state (`GET /backend-api/conversation/{id}`) once the stream ends and reads
the assistant message straight from there, since the streamed
JSON-patch reconstruction was confirmed (against real production captures)
to silently drop large spans of text. `contentSource` tells you which path
produced this event:

- `"authoritative_fetch"` - `contentParts` is the source of truth for
  rendering order (text/image/etc. interleaved exactly as ChatGPT produced
  them). `text` is a derived join of the markdown parts, kept for
  search/back-compat/preview only - don't use it for faithful rendering.
- `"stream_fallback"` - the authoritative fetch failed or returned an
  unrecognized shape; only `text`/`codeBlocks`/`hasMarkdown`/`hasTables` are
  populated, exactly as before this field existed. `contentParts`/`citations`
  are absent. This path exists so capture never regresses to losing an event
  entirely if the authoritative endpoint's shape has drifted.

```json
{
  "text": "string",
  "textLength": 123,
  "codeBlocks": [{ "language": "optional string", "code": "string" }],
  "hasMarkdown": true,
  "hasTables": false,
  "contentSource": "authoritative_fetch | stream_fallback",
  "contentParts": [
    { "type": "markdown", "order": 0, "text": "string" },
    { "type": "image", "order": 1, "assetPointer": "file-service://file-id", "width": 0, "height": 0, "sizeBytes": 0, "uploaded": true },
    { "type": "attachment", "order": 2, "raw": {} }
  ],
  "citations": [{}],
  "reasoningMetadata": {},
  "completedAt": "ISO 8601 string",
  "stopReason": "optional string"
}
```

`contentParts`/`citations`/`contentSource` are optional, additive fields -
per this file's own versioning rule, adding an optional field does not
require a `capture_version` bump. `images`/`files`/`artifacts` (documented in
earlier versions of this file) were never actually populated by any shipped
extension version and are superseded by `contentParts`; they're removed here
rather than kept as permanently-unpopulated dead fields.

Each `contentParts` entry's `type` is one of:
- `"markdown"` - a text segment, in ChatGPT's own markdown (headings, bold,
  italic, lists, block quotes, GFM tables, inline/fenced code, links are all
  literal markdown syntax within `text` - render with a standard markdown
  renderer, don't reparse).
- `"image"` - a generated image. `assetPointer` is ChatGPT's internal
  `file-service://` reference; when `uploaded: true`, the actual bytes have
  been captured via `POST /capture/attachments` with `kind: "output"` and can
  be looked up by matching `assetPointer`'s file id against
  `conversation_capture_attachments.file_name`. When `uploaded` is absent,
  resolving the image failed for this turn (not fatal to the rest of the
  message) and only the pointer is known.
- `"attachment"` - any other content-part shape ChatGPT's message object
  contained (code-interpreter output, browsing display, etc.) that this
  contract doesn't yet model explicitly. `raw` carries the untouched object -
  lossless, never silently dropped, same philosophy as raw event capture.

`citations` is the untouched `message.metadata.content_references` array
when present - captured losslessly but not yet resolved into inline
hyperlinks (the marker syntax ChatGPT embeds in `text` to reference a
citation needs a live sample to parse correctly; see the engineering report's
Known Limitations).

### `generation_captured`
For images/charts/canvas/code/documents/tables/downloads produced by a
response. `outputType` is one of `constants.OUTPUT_TYPES`.
```json
{
  "outputType": "image",
  "fileUrl": "optional string",
  "fileName": "optional string",
  "mimeType": "optional string",
  "sizeBytes": 0,
  "sourcePromptId": "optional string",
  "sourceResponseId": "optional string"
}
```

### `file_upload_detected`
```json
{ "fileName": "string", "mimeType": "optional string", "sizeBytes": 0, "attachedTo": "prompt" }
```
`attachedTo` is `"prompt"` (attached to a message being composed) or
`"standalone"` (uploaded before any prompt, e.g. via a file-manager panel).

### `file_download_detected`
```json
{ "fileName": "string", "mimeType": "optional string", "sourceMessageId": "optional string", "downloadUrl": "optional string" }
```
