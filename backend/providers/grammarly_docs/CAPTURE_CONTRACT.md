# Grammarly Docs — Capture Contract

Backend capture surface for `coda.grammarly.com/d/<docId>` (Grammarly's
document product, formerly Coda) plus a Client Mapping gate on doc creation
at `app.grammarly.com`. Session-shaped, not generation- or download-shaped —
see `constants.py`'s module docstring for why this provider doesn't fit the
pattern every other provider in this codebase uses.

## What this covers

1. **How much work got done** — a doc was opened, how long it stayed open,
   and (best-effort) what was in it.
2. **Client attribution on creation** — a Client Mapping gate blocks "New
   doc" until a client is picked, same as every other provider's Task/Client
   gate.
3. Nothing about doc *count* (creation totals) as its own reportable metric
   yet — see Known gaps.

## Confirmed (real captured traffic/DOM, 2026-08-27)

```
GET https://coda.grammarly.com/d/_dWg6E6d9q24
->  full HTML page (Content-Type: text/html), NOT a JSON API response.

    Inline bootstrap <script> carries:
      "docId": "Wg6E6d9q24"        (bootstrap's own field - strips the "d" too)
      "title": rendered as <title>testing 2</title>
      author: <meta name="author" content="RMW">
      canonical: <link rel="canonical" href="https://coda.io/d/testing-2_dWg6E6d9q24">
```

The URL segment after `/d/` is `<title-slug>_<stableId>` - the slug is empty
for an untitled doc (`_dWg6E6d9q24`) and a human-readable title-derived
string once titled (`tesing-document_dgJFoypEmLC`). **doc_id here is the
part after the LAST underscore** (`dWg6E6d9q24`, `dgJFoypEmLC` - keeping the
leading "d", unlike the bootstrap script's own stripped field above) - this
is NOT the same normalization the bootstrap's own `docId` field uses, and
that's deliberate: the slug prefix changes every time the doc is renamed,
confirmed real (2026-08-27) to otherwise misfire `syncToCurrentDoc` into
treating a rename as "left this doc, opened a different one" - see
`content-grammarly-docs.js`'s `normalizeDocId` for the full incident this
fixed (it fragmented a session in two AND silently dropped the doc-creation
gate's picked client, since that only rides along on whichever `doc_open`
happens to consume the pending selection).

The doc's real page-render content (pages/blocks/tables) is NOT in this
response — it's a loading shell. Coda's own internal document model arrives
via later authenticated `fetch` calls to
`codacontent.io/docs/<docId>/snapshots/.../fui-critical` and further "shard"
requests, in an undocumented, proprietary format — this provider does not
touch that path at all. Instead, **content capture reads the rendered DOM
directly** (see "Content capture" below) — a different, much simpler path
than reverse-engineering Coda's own data model.

There is **no confirmed "doc closed" signal** in Coda's own network traffic.
`doc_session_end` (see `constants.py`) is a client-side tab-lifecycle event
(`visibilitychange` / `pagehide`), computed and reported entirely by the
extension — not something this backend ever observes independently.

```
Confirmed real button DOM (app.grammarly.com/?source=doc-title-bar):
  <button class="gds-button gds-button-primary gds-button-medium
    buttonNew_f1628a0" type="button" data-name="new-ai-doc-add-btn">
```
`data-name="new-ai-doc-add-btn"` is the stable selector the doc-creation
gate uses — the `buttonNew_f1628a0` class is a build hash, not trusted. The
`react-aria...` id on the adjacent dropdown confirms this app is built on
React Aria's `usePress`, which fires on `pointerdown`/`pointerup`, **before**
the native `click` event — the gate has to block that whole sequence, not
just `click` (see `content-grammarly-new-doc-gate.js`'s own header comment
for the real incident this fixed).

## Pages (confirmed real DOM/URL, 2026-08-27)

A Coda doc can hold several "pages" (its own sidebar sub-page feature - a
new "page 2" nested under "page testing" in the doc's own left rail).
Confirmed real URLs for two pages of the same doc:

```
https://coda.grammarly.com/d/page-testing_dZ37c5NX5mD/page-2_suQqVX4R#_lupBUa2u
https://coda.grammarly.com/d/page-testing_dZ37c5NX5mD/0001-page-name_su-Fxicy#_luKXXUpV
```

The FIRST `/d/` segment (`page-testing_dZ37c5NX5mD`) is the document -
**identical across every page in it**, confirmed by both URLs above sharing
`dZ37c5NX5mD`. The SECOND path segment is the page: same
`<slug>_<stableId>` shape as the doc segment, but Coda prefixes the page's
stable id `su` instead of the doc's own `d` (`suQqVX4R`, `su-Fxicy`). The
trailing `#_lupBUa2u` hash is a cursor/block anchor within the page, not
part of page identity - it's excluded by only matching `location.pathname`.

`document.title` (used for `doc_title`) stays the DOCUMENT's name across a
page switch - confirmed real, the tab title never changed to "page 2" when
that page was open - so there is no live DOM source for the page's own
name the way there is for the doc's. The page name is instead read off this
same URL segment's slug half, hyphens turned back to spaces
(`page-2` → `page 2`, `0001-page-name` → `0001 page name`) - both confirmed
to match the sidebar/breadcrumb's own rendered page name exactly.

A page switch (same `doc_id`, different `page_id`) is treated as a new
session, same as a real doc change - see `content-grammarly-docs.js`'s
`syncToCurrentDoc` - rather than silently overwriting the previous page's
still-accurate `doc_title`/content with the new page's. `GrammarlyDocSession`
carries `page_id`/`page_name` per session so a document's many page-visits
stay individually named instead of collapsing into indistinguishable rows;
the "by person" UI groups every session sharing one `doc_id` back into a
single document entry regardless (`groupSessionsByDoc` in
`my-dashboard/.../grammarlyDocsCaptureUtils.js`), with each page-visit shown
as an expandable line under it, so this only adds a per-visit breakdown, it
does not fragment the document's identity in the browse view.

A session opened at the doc's own root (no second path segment at all) gets
`page_id`/`page_name` = null, shown in the UI as "Main page".

**Page name can read stale right at doc_open, confirmed real (2026-08-27)**:
unlike `doc_title` (read from the live `document.title`), there is no live
DOM source for a page's own name - it's read purely from the URL's slug.
A freshly-created/renamed page's URL can still carry the OLD default slug
("Untitled-page") for a beat after `doc_open` fires - two sessions opened
back-to-back on the SAME real pages ("page1", "page 2") both captured
`pageName: "Untitled page"` while Coda's router hadn't yet rewritten the
URL, even though later re-visits of the identical `page_id` correctly
picked up "page1"/"page 2" once the URL had caught up. `page_name_updated`
(see `constants.py`) exists to self-correct this WITHIN the same session
instead of waiting for a fresh visit: the extension's existing 1s backstop
poll re-derives the page name every tick, and reports a correction
(`page_id`/`doc_id` unchanged, `page_name` changed) the moment the URL
catches up - `payload` carries `pageId`, `pageName`. Normalization updates
the matching session's `page_name` (and `page_id`, defensively) in place,
same "latest signal wins" posture as content/duration.

## Event shape (`POST /api/providers/grammarly-docs/capture/events`)

Same envelope every other provider's `capture/events` uses (see
`schemas.py::CaptureEventIn`), plus two fields no other provider needs:

- `session_key` — extension-generated, unique per doc-open, unchanged for
  that session's later `doc_session_end`/`doc_content_captured` events.
  **Required** for all three event types.
- `doc_id` — Coda's own docId (see confirmed shape above).

`event_type` is one of:

- `doc_open` — fired once per doc (or per-page, within a doc - see
  "Pages" above) visit. `payload` carries `docTitle`, `docAuthor`, `docUrl`
  (canonical), `pageUrl`, `pageId`, `pageName`, `startedAt` (ISO).
- `doc_session_end` — fired on tab hide/close/navigate-away for a
  `session_key` that already has an open session. `payload` carries
  `endedAt` (ISO) and, ideally, a client-computed `durationSeconds` (the
  backend re-derives it from `endedAt - started_at` if omitted, and clamps
  either way at `MAX_SESSION_DURATION_SECONDS` — see `constants.py`).
- `doc_content_captured` — fired once the DOM settles after `doc_open`
  (debounced `MutationObserver`, capped wait), and again right before a
  genuine tab-leaving `doc_session_end` (not on an in-app doc switch — see
  "Content capture" below). `payload` carries `contentText`, `wordCount`,
  `charCount`, `capturedAt` (ISO). Can fire more than once per session; each
  capture **overwrites** the session's stored content (latest wins, not a
  history of edits).
- `page_name_updated` — fired when the CURRENT page's URL-slug-derived name
  changes while its `page_id`/`doc_id` stay the same (Coda's router catching
  up after `doc_open` already fired with a stale slug — see "Pages" above).
  `payload` carries `pageId`, `pageName`. Can fire more than once per
  session; each report overwrites the session's stored `page_name` (latest
  wins).

`linked_client_id` (top-level, like every other provider) is how the
doc-creation gate's picked client rides along on the very next `doc_open`.

Ownership is resolved via the exact same `_resolve_usage_event_actor` /
`_resolve_usage_event_credential` every other provider trusts (ticket or
dashboard-session).

## Content capture

Reads `[contenteditable="true"]` regions off the live DOM (a semantic,
framework-agnostic marker for "the actual editable content region" — chosen
specifically because no Coda-specific class name has ever been confirmed;
only the loading-shell HTML has been captured, never the fully-rendered
app), falling back to `document.body.innerText` if none is found. This is a
**flat text read of whatever is visibly rendered**, not Coda's own
structured document model — tables/formulas collapse to plain text, and the
selector may need revision once real rendered-DOM evidence is available
(same "expect a follow-up fix pass" posture this codebase already applies
to HeyGen/Higgsfield's screenshot-only network interceptors).

**A capture can land before the real editor has mounted, confirmed real
(2026-08-27)**: a page opened right after doc/page creation can go
DOM-quiet for the full `CONTENT_SETTLE_QUIET_MS` before Coda's own
`[contenteditable]` canvas actually exists yet - capturing at that instant
falls straight through to the whole-page-text fallback and locks in
sidebar/toolbar chrome ("Skip to content / Pages / New page / Grammarly
Writing quality...") as the doc's "content", while the SAME page visited
again later (DOM already warm) correctly finds its real region within the
same wait. `content-grammarly-docs.js`'s settle-watch now probes for a real
`[contenteditable]` region before accepting a capture - if none exists yet
and the hard `CONTENT_SETTLE_MAX_WAIT_MS` budget isn't exhausted, it waits
another quiet window instead of locking in a chrome-only snapshot. A
genuinely blank freshly-created page (a real, empty contenteditable) still
reports 0 words rather than being overwritten by chrome text - the fallback
only applies when no editable region exists at all.

This is a deliberate, explicit exception to this codebase's usual "usage
metadata only, never content" posture (every other provider here never
captures prompt/generation text) — added on direct request, not by default.
Stored text is capped at `MAX_CONTENT_TEXT_CHARS` (200k chars) server-side.
The `/sessions` **list** endpoint omits `contentText` from its response
(`to_dict(include_content=False)`) so browsing 100 sessions can't balloon
into megabytes; the single-session detail endpoint returns it in full.

A doc switch via Coda's own in-app router does **not** trigger a pre-close
capture (see `closeSession`'s own comment in `content-grammarly-docs.js`):
by the time that fires, the DOM has very likely already swapped over to the
new doc, so a capture at that point would risk attaching the wrong doc's
text. Only the initial settle-capture covers that case.

## Doc-creation Client Mapping gate

`content-grammarly-new-doc-gate.js` (on `app.grammarly.com`) blocks the
"New doc" button, shows a Client-only picker (`content-grammarly-docs-task-modal.js`
— no Task section, since a new Coda doc isn't tied to this codebase's Task
system the way a download/generation is), then replays the full
`pointerdown → mousedown → pointerup → mouseup → click` sequence once a
client is chosen (a bare synthetic `.click()` is not enough for a React
Aria `usePress` button — see that file's header comment).

The picked client is stashed in `chrome.storage.local` (not
`sessionStorage` — the new doc opens at a *different origin*,
`coda.grammarly.com`, which can't read `app.grammarly.com`'s session
storage) with a 2-minute TTL, and consumed by the very next `doc_open` on
`content-grammarly-docs.js`, wherever it ends up.

That one-shot handoff only covers the very first session after creation. A
`doc_session_end` fires on every tab-hide (`visibilitychange`), and coming
back to the tab starts a brand-new `session_key` — by design, see
`content-grammarly-docs.js`'s "Session end / re-open" comment — so a plain
one-shot consume would lose the picked client the moment the user ever
switched away from the tab and back. Confirmed real (2026-08-27): a client
picked at creation was gone by the very next re-open, from nothing more than
switching to this extension's own dashboard to check the result. To fix
this, `openSession()` also maintains a second, longer-lived
`chrome.storage.local` map (`grammarlyDocsClientByDocId`, 24h TTL) keyed by
`doc_id`: whichever client resolves for a session (from the gate's one-shot
stash, or from this map on a later re-open) is written back into the map, so
it "sticks" for every subsequent re-open of that same doc within the TTL —
not just the first one.

**Known gap**: the dropdown next to "New doc"
(`data-name="new-doc-add-btn-dropdown"`) presumably opens a menu with other
creation options (import/template/etc.) — not gated, no confirmed selector
for its menu items yet. A doc created through that menu has no client
prompt.

## Data model

`page_id`/`page_name` on `GrammarlyDocSession` identify which page (of a
possibly multi-page doc) a given session was on - see "Pages" above.

`GrammarlyCaptureEvent` (raw, append-only) → `GrammarlyDocSession`
(normalized). Unlike every other provider's normalized table, a
`GrammarlyDocSession` row is **updated in place**, not insert-only: `doc_open`
creates it, `doc_session_end` fills in `ended_at`/`duration_seconds`/
`status="ended"`, `doc_content_captured` fills in `content_text`/
`content_word_count`/`content_char_count`/`content_captured_at` — all
correlated by `session_key`, all in-place updates. See `models.py` and
`normalization.py`.

## Known gaps (deliberately out of scope)

- **No "doc created" count as its own metric.** The gate above attaches a
  client to creation, but there's no dedicated "docs created" tally
  separate from the general session list. Would also benefit from Coda's
  official API (`api.coda.io`) if this org has access — unconfirmed, never
  checked.
- **No capture-health ping, no asset mirroring, no reconciliation sync, no
  Capture Center dashboard integration into Reports/AI-report.** All of the
  above exist for other providers; none exist here. (A "by person" browse
  UI *does* exist — see the workspace's "Grammarly Docs" tab — just not
  wired into the org-wide Reports/AI-report pipeline the way Kling/Freepik
  are.)
- **`reconcile_stale_sessions()` exists but isn't wired into a periodic
  dispatcher** in `main.py` — callable on demand only, for now.
- **Multi-tab / concurrent doc opens**: `session_key` is per-tab-visit, so
  two tabs on the same doc produce two independent sessions — this is
  intentional (same posture as `tab_id` riding along "for diagnostics only,
  never part of identity" elsewhere in this codebase), not a bug to fix.
- **Content selector is unconfirmed** (see "Content capture" above) — built
  from reasoning about React-based rich editors in general, not a captured
  DOM sample of Coda's actual rendered canvas.
