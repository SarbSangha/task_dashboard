# Phase 2A.5 — Browser Capture Architecture Review

Design review for the extension side of ChatGPT capture, before any
extension code is written. Answers the five questions raised in review, then
proposes the adapter architecture those answers imply. Grounded in what
`browser-extension/tool-hub-autologin/` already does for Kling (confirmed by
reading `manifest.json`, `background.js`, `background-main.js` this session)
rather than inventing new mechanisms where a proven one exists.

## 1. DOM observation - detecting response/edit/regeneration/switch/completion reliably

**Primary signal should be network interception, not DOM diffing** - same
philosophy as `content-kling-network.js` (MAIN-world `fetch`/`XHR` hook).
ChatGPT's own UI is driven by calls to `/backend-api/conversation` (SSE
stream for prompts/responses) and per-conversation REST calls (rename,
archive, delete) - all interceptable in the MAIN world before any DOM
diffing is needed:

- **New prompt**: outgoing POST body to `/backend-api/conversation`.
- **Response started/streaming/completed**: the SSE response stream itself -
  first content chunk → `response_started`; the terminal chunk / `[DONE]`
  sentinel → `response_completed` with the fully assembled text buffered
  client-side (never sent chunk-by-chunk, per the already-approved
  streaming decision).
- **Edit / regeneration**: both re-POST with a `parent_message_id` pointing
  at an earlier message - distinguished by whether the replaced message's
  role is `user` (edit) or `assistant` (regenerate).
- **Conversation switch**: hook `history.pushState`/`replaceState` in the
  MAIN world (ChatGPT is a SPA, URL is `/c/<id>`) - more reliable than
  polling, with a cheap `setInterval` backstop (~1s) to catch navigations
  the hook might miss (e.g. bfcache restores).
- **New conversation id assignment**: first SSE chunk of a request made
  without an id in the URL carries the freshly-assigned `conversation_id`.
- **Archive/delete/pin**: in practice these are real network calls too
  (PATCH/DELETE against a per-conversation endpoint), not DOM-only actions.

**DOM `MutationObserver` becomes a narrow fallback**, not the primary
mechanism - scoped only to the title element and sidebar list container, for
redundancy and for the rare UI-only affordance with no clean network
correlate. This mirrors Kling's own layering (network hook primary,
DOM/isolated-script secondary).

**Caveat worth stating plainly**: ChatGPT's network API is unversioned and
undocumented, same situation Kling was in. The exact endpoint paths/payload
shapes above are the best available inference and **must be verified against
the live network tab before writing the interception regexes** - this is
Phase 2B's first concrete task, not something to lock in from a design
review alone.

## 2. Queue behavior under connectivity loss

**Resolved: two reliability classes, not one retry policy.** Kling's
existing queue (`BEST_EFFORT`) gives up after `USAGE_EVENT_RETRY_MAX_ATTEMPTS`
and drops the event - the right tradeoff for a generate-click, wrong for a
conversation. ChatGPT capture is `LOSSLESS` (also recorded in
`CAPTURE_CONTRACT.md` and `constants.RELIABILITY_CLASS`):

| Reliability class | Example | Give-up behavior |
|---|---|---|
| `BEST_EFFORT` | Kling `generate_click` | Drop after `USAGE_EVENT_RETRY_MAX_ATTEMPTS`, exponential backoff |
| `LOSSLESS` | ChatGPT conversation events | Never intentionally discard |

For `LOSSLESS`:
- Persist to `chrome.storage.local` immediately on capture, before the first
  send attempt, so a browser crash/extension reload doesn't lose anything
  either (not just a network blip).
- Exponential backoff on send failure while attempts are "recent": reuse
  Kling's exact formula (`30s * 2^attempts`, capped at 30 min).
- **After backoff maxes out, don't drop - downgrade to a slow indefinite
  retry cadence** (e.g. retry every 30 min forever, plus opportunistically on
  browser startup and on next login) instead of giving up. Bounded by queue
  *size*, not *age* or *attempt count* - like an email client's outbox: it
  keeps retrying "eventually delivered," it doesn't expire a draft because
  it's a week old. If the queue does hit a hard size ceiling (backend down
  for an extended period), that's a `Capture Health` signal (`offline_since`
  growing, `queue_length` pinned at the ceiling) for an admin to notice and
  intervene on - not a silent data-loss event.

## 3. Multi-tab isolation

Per the earlier design review: `tab_id` rides along for diagnostics only,
never part of identity/dedup - two tabs independently observing the same
underlying event is expected and tolerated at the raw layer (Phase 3
normalization is where true duplicates collapse, via `provider_message_id`).

For the **queue** specifically: one shared queue owned by the background
service worker, not one queue per content-script tab. Content scripts should
only build events and hand them off via `chrome.runtime.sendMessage`
(exactly the existing `TOOL_HUB_REPORT_USAGE_EVENT` pattern) - the
background worker owns persistence, batching, and retry centrally. This
isn't a new mechanism to design; it's exactly what `background-main.js`
already does for Kling usage events, extended to a new message type.

## 4. Rate limiting / batching for rapid bursts

The endpoint already accepts 1-200 events per call
(`CaptureEventsRequest.events`), so the fix is batching in the background
worker, not one `sendMessage`/HTTP call per keystroke-adjacent event.
Recommend a debounce-with-max-wait flush policy (same shape as the
dashboard's existing 250ms search-input debounce, just tuned for a queue):
flush on whichever comes first - **500ms of queue quiet**, **50 events
accumulated**, or **2s since the oldest unflushed event** (so a steady
trickle can't starve flushing indefinitely). Starting numbers, not final -
Phase 2B's own validation step should tune these against real usage.

## 5. Extension upgrade / schema versioning compatibility

Mostly already solved by `CAPTURE_CONTRACT.md`'s versioning rule: the
backend never rejects an unrecognized `capture_version`, so an old extension
sending `capture_version: 1` keeps working indefinitely once a `2` exists -
no forced-upgrade mechanism needed at the protocol level. The obligation
this places on Phase 3: normalization must dispatch on `(event_type,
capture_version)`, not assume the latest shape. `extension_version` (already
in the envelope) lets future analytics show the version distribution in the
field, so "when is it safe to stop writing a parser for `capture_version: 1`"
becomes a data-driven decision, not a guess.

## Proposed architecture (confirmed feasible against the real manifest/background setup)

Checked this session: `manifest.json` has no bundler (plain
`content_scripts[].js` arrays, shared scope per world) and `background.js` is
a **classic** (non-module) service worker that already splits via
`importScripts('background-main.js')` - so the background side can be split
into multiple files the same way, not just the content-script side.

```
browser-extension/tool-hub-autologin/
│
├── content-chatgpt-network.js       (MAIN world, document_start)
│     fetch/XHR/EventSource + pushState/replaceState hooks;
│     posts structured signals via window.postMessage (isolated world can't
│     call chrome.runtime directly from MAIN world - same constraint Kling's
│     network hook already works around)
│
├── content-chatgpt-dom-observer.js  (isolated world, document_idle)
│     narrow MutationObserver - fallback/confirmation signals only
│
├── content-chatgpt-event-builder.js (isolated world)
│     turns raw network/DOM signals into Capture Contract-shaped events;
│     generates client_event_id; holds response_started state per
│     message_id until the stream ends, then emits exactly one
│     response_completed
│
├── content-chatgpt.js               (isolated world, document_idle)
│     thin orchestrator + existing auto-login logic; forwards built events
│     to the background worker via chrome.runtime.sendMessage
│
├── background.js                    (existing - just adds one more importScripts entry)
├── background-main.js               (existing - gets one new message-type handler,
│     delegating to the file below rather than growing further)
└── background-chatgpt-capture.js    (NEW - loaded via importScripts, mirrors
      Kling's usage-event retry-queue shape but as its own file instead of
      folded into the already-large background-main.js):
        - single persistent queue (chrome.storage.local)
        - debounce+max-wait batching (Q4)
        - exponential backoff retry (Q2, reusing Kling's formula)
        - POST /api/providers/chatgpt/capture/events
```

No "Retry Manager" / "Batch Sender" as separate files from the original
sketch - folded into `background-chatgpt-capture.js` since that's one
cohesive responsibility (queue lifecycle), matching how Kling's equivalent
logic already lives together rather than split further. A "Health Monitor"
piece is deferred - it's UI/observability (queue depth, oldest-unsent-age
surfaced to the dev capture badge, later to an admin capture-health view in
Phase 5), not a Phase 2B capture-correctness concern.

## What Phase 2B needs to do first, before writing the adapter

1. Open ChatGPT in devtools, capture the actual current network shape for:
   new conversation, prompt send, streaming response, regenerate, edit,
   rename, archive, delete, image/canvas generation, file upload/download.
   The interception regexes in `content-chatgpt-network.js` get written
   against what's actually observed, not against the inferred shape above.
2. Decide the open queue-retry question in Section 2 (never-give-up vs.
   Kling's drop-after-N-attempts).
3. Add `chatgpt.com`/`chat.openai.com`/`auth.openai.com` to
   `host_permissions` in `manifest.json` (confirmed missing there in the
   earlier architecture survey - only present in `content_scripts.matches`
   today, which is enough for content scripts to run but not for any
   background-worker-initiated fetch to those origins if that's ever needed).
