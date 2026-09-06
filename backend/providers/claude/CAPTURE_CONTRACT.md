# Claude Capture Contract (capture_version 1)

This is the wire contract between the browser extension
(`content-claude-network.js` + `content-claude-capture.js`) and
`POST /api/providers/claude/capture/events`. See `providers/claude/schemas.py`
(`CaptureEventIn`) for the enforced envelope shape and
`providers/claude/constants.py` for the canonical `event_type` values.

## How this differs from ChatGPT's capture (and why it's simpler)

ChatGPT capture (`providers/chatgpt/`) has to reconstruct a response by
parsing an undocumented, frequently-drifting SSE JSON-patch protocol frame
by frame (`content-chatgpt-network.js`) - the authoritative
`GET /backend-api/conversation/{id}` re-fetch is a fallback for that path,
observed succeeding on the order of ~1% of turns in production (see
`providers/chatgpt/RESPONSE_RECONSTRUCTION_REPORT.md`).

Claude works the other way around. claude.ai's own web client calls
`GET /api/organizations/{orgId}/chat_conversations/{conversationId}?tree=True&rendering_mode=messages&render_all_tools=true&include_inline_comparison=true&consistency=eventual`
to (re)hydrate the full message tree - confirmed live, captured immediately
after two ordinary chat turns, header-to-body - and does so after every turn
completes (to reconcile branches/artifacts/tool state), on every page load,
and on every conversation switch. That response already contains the
complete, final `chat_messages` array - human and assistant messages
interleaved, each with its own stable `uuid`, `parent_message_uuid`,
`index`, and per-content-block `start_timestamp`/`stop_timestamp`. There is
no streaming delta to reconstruct and no "did the authoritative fetch
succeed this time" fallback ladder: capture here means reading this one
response and diffing it against messages already seen in this tab.

This also means, for free: opening (or reloading) any existing Claude
conversation captures its **entire history**, not just messages sent after
the extension was installed - the first GET of a conversation's tree is
itself a full backfill.

## Reliability class: LOSSLESS

Same classification as ChatGPT (see `providers/chatgpt/constants.py`'s
`RELIABILITY_CLASS`) - a conversation is worth more than a generate-click,
so the extension's retry queue (`background-claude-capture.js`) never gives
up on a queued event.

## Envelope (every event)

Identical shape to ChatGPT's (`providers/chatgpt/CAPTURE_CONTRACT.md`'s
Envelope table) - `event_type`, `client_event_id`, `conversation_id`,
`message_id`, `payload`, `capture_version`, `extension_version`, `browser`,
`tab_id`, `session_id`, `extension_session_id`, `credential_id`,
`event_date`. One difference: **`client_event_id` is deterministic, not a
random uuid4** - the extension builds it as `claude:{conversationUuid}:{kind}:{messageUuid}`
(`kind` is `prompt` or `response`, since a request/response pair can share a
message uuid boundary in some Claude payload shapes). Claude's authoritative
snapshot re-observes the same already-captured message on every later GET of
the same conversation (reload, reopening an old chat, a second tab) - a
stable key collapses those re-observations into ordinary "duplicate"
responses for free, rather than relying solely on retry-of-the-same-attempt
idempotency the way ChatGPT's random `client_event_id` does.

## Per-`event_type` payload shapes

### `conversation_opened` / `conversation_created`
Both carry the same header fields, read straight off the conversation
object; see `providers/claude/normalization.py`'s
`_handle_conversation_snapshot_metadata` for how they're applied (title/
model/url refresh on every observation, `providerCreatedAt` is sticky).
`conversation_created` fires the first time this tab observes a conversation
uuid it hasn't seen before *and* the conversation's own `created_at` is
recent (see `isNewConversation` below); every other observation of the same
conversation - including by a different tab/install - is `conversation_opened`.
```json
{
  "title": "How to play basketball",
  "url": "https://claude.ai/chat/630df9cf-4aa5-4ca9-bde7-41d8491085d0",
  "model": "claude-sonnet-5",
  "providerCreatedAt": "2026-09-03T07:34:25.932912Z",
  "providerUpdatedAt": "2026-09-03T07:36:21.787824Z",
  "isNewConversation": true
}
```
`isNewConversation` mirrors ChatGPT's own field of the same name and the
same purpose (see that provider's `normalization.py` docstring on
`_is_attributable`) - true only when this conversation's own `created_at`
was within the last few minutes of being observed, so a pre-existing
conversation this backend has simply never seen before doesn't get silently
attributed to whoever's browser happened to open it first.

### `conversation_renamed`
```json
{ "previousTitle": "optional string", "newTitle": "string" }
```

### `conversation_deleted`
```json
{ "detectedVia": "sidebar_removal | explicit_delete_action" }
```
Not emitted by the initial extension build (no confirmed DELETE traffic
capture yet) - documented for forward compatibility, same posture ChatGPT's
contract takes for its own not-yet-emitted event types.

### `prompt_captured`
One per `chat_messages[]` entry with `sender: "human"` not yet seen in this
tab.
```json
{
  "text": "now tell me how to play the basket ball",
  "textLength": 39,
  "attachments": [{ "type": "image | file", "name": "string" }],
  "files": [{ "name": "string", "mimeType": "optional string", "uuid": "optional string" }],
  "codeBlocks": [{ "language": "optional string", "code": "string" }],
  "sequenceIndex": 0,
  "promptTimestamp": "2026-09-03T07:34:28.889526Z",
  "parentMessageId": "00000000-0000-4000-8000-000000000000",
  "isNewConversation": true,
  "providerCreatedAt": "2026-09-03T07:34:25.932912Z"
}
```
`sequenceIndex` is the message's own `index` field from the conversation
tree (Claude's own turn ordering) - `normalization.py` still assigns its own
server-computed `sequence_index` on the stored row (see that module's
`_next_prompt_sequence`), this field is carried through informationally
only, same as ChatGPT's contract.

### `response_completed`
One per `chat_messages[]` entry with `sender: "assistant"` not yet seen in
this tab. Fired once the message is observed in an authoritative snapshot -
there is no separate `response_started`, because there is nothing to
distinguish it from (no streamed partial state is ever captured).
```json
{
  "text": "Hi Sarbjeet! Basketball is a fun sport to pick up...",
  "textLength": 1024,
  "codeBlocks": [{ "language": "optional string", "code": "string" }],
  "hasMarkdown": true,
  "hasTables": false,
  "contentSource": "authoritative_fetch",
  "contentParts": [
    { "type": "markdown", "order": 0, "text": "Hi Sarbjeet! ..." },
    { "type": "attachment", "order": 1, "raw": {} }
  ],
  "citations": [],
  "completedAt": "2026-09-03T07:34:35.542811Z",
  "stopReason": "end_turn",
  "parentMessageId": "01a06630-b911-72ae-ac18-18e932a7997b",
  "sequenceIndex": 1,
  "model": "claude-sonnet-5"
}
```
`contentSource` is always `"authoritative_fetch"` for Claude - unlike
ChatGPT's contract, there is no `stream_fallback`/`dom_fallback`/
`no_content_captured` ladder, because there is no earlier, less-reliable
capture path to have fallen back from in the first place.

Each `contentParts` entry's `type`:
- `"markdown"` - a `content[]` block with `type: "text"`; `text` is that
  block's own `text` field, Claude's own markdown.
- `"attachment"` - any other block shape (`tool_use`, `tool_result`,
  `thinking`, artifact references, etc.) this contract doesn't yet model
  explicitly. `raw` carries the untouched block - lossless, never silently
  dropped, same philosophy as ChatGPT's contract's identical `"attachment"`
  part type.

`parentMessageId` is the exact id of the prompt message this response
replies to - Claude's own `parent_message_uuid`, always present (unlike
ChatGPT's contract, where this field is only populated when a best-effort
authoritative re-fetch happens to succeed). `normalization.py`'s response
pairing is therefore always an exact match, never a "most recently created
prompt" heuristic guess.

## Attachment binary capture (best-effort, not part of the event contract)

`POST /api/providers/claude/capture/attachments` (see `attachments.py`) is a
separate, best-effort binary-upload path - same "large binary upload, not a
tiny JSON event" reasoning as ChatGPT's contract's identical endpoint, not
part of the lossless `/capture/events` batch above.

Unlike ChatGPT (whose API never hands back a fetchable URL for an uploaded
INPUT file, forcing DOM file-input/drop interception), a Claude snapshot's
`chat_messages[].files[]` entries each already carry same-origin, cookie-
authenticated URLs - confirmed live:
```json
{
  "file_uuid": "6fba8c07-3e23-48ed-9fa9-8312d0fbd6d0",
  "file_kind": "image",
  "file_name": "arafed-image-boy-with-glasses-backpack-generative-ai.jpg",
  "thumbnail_url": "/api/{orgId}/files/{fileUuid}/thumbnail",
  "preview_url": "/api/{orgId}/files/{fileUuid}/preview"
}
```
`content-claude-capture.js`'s `captureFileAttachments` fetches `preview_url`
(falling back to `thumbnail_url`) directly - a plain authenticated GET, no
MAIN-world bounce needed, same-origin content-script fetches already carry
the page's cookies. Confirmed live: `image/webp`, tens of KB - a reasonably
sized, reviewable rendition, not the multi-MB original upload
(`size_bytes` on the file's own upload-response is separate and can be
several MB; deliberately not what gets captured here, matching
`MAX_ATTACHMENT_BYTES`'s existing 8MB ceiling and R2 storage cost
reasoning). The captured bytes are POSTed with `file_name` set to the file's
own `file_uuid` (not its human filename) - the same key
`ConversationPrompt.files_json`'s `uuid` field carries (see
`content-claude-capture.js`'s `extractFiles`), so the dashboard can
correlate a `ConversationCaptureAttachment` row back to the exact prompt
message it belongs to without a filename-collision risk.

Confirmed only for `file_kind: "image"` so far. PDFs/videos/other file
kinds are attempted through the exact same `preview_url`/`thumbnail_url`
fields (Claude may well render a page-1 thumbnail for a PDF the same way it
does an image) but this is **unconfirmed** against live traffic for any
non-image kind - a fetch that comes back empty/unusable for those simply
skips that one file's capture (best-effort, per this section's own
posture), it does not affect the message's own `prompt_captured` event,
which has already been sent by the time attachment capture runs. Revisit
once a real PDF/video upload has been observed live.

Not implemented: capturing the ASSISTANT side's generated
artifacts/images/documents (Claude's `content[]` blocks for those land in
`contentParts` as a lossless but unrendered `"attachment"` part - raw JSON
only, no bytes) - out of scope for this pass, no confirmed asset URL shape
for them yet the way `files[].preview_url` is confirmed for prompt-side
uploads.
