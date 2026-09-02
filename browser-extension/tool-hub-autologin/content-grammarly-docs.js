// content-grammarly-docs.js
//
// Session presence tracking for Grammarly's document product
// (coda.grammarly.com/d/<docId>[/<pageId>], formerly Coda - see backend
// providers/grammarly_docs/CAPTURE_CONTRACT.md for the full confirmed
// traffic shape this is built from). Deliberately DOM-only, no network
// interception and no MAIN-world injection: everything this pass needs
// (docId, pageId/pageName, title, author, canonical URL) is readable
// straight off the URL/document from an isolated-world content script -
// Coda server-renders the
// real <title>/<meta name="author">/<link rel="canonical"> into the initial
// HTML response (confirmed: the real captured response already carried
// "testing 2" as <title>, not a loading placeholder), so no MAIN-world
// bootstrap-variable read or stabilization wait is needed for a fresh page
// load. See CAPTURE_CONTRACT.md's "Known gaps" for what this deliberately
// does NOT do (doc creation tracking, document content capture).
//
// history.pushState/replaceState ARE interceptable from an isolated-world
// content script without MAIN-world injection - unlike a page-defined
// window variable, `history`/`location` are native browser objects shared
// identically between the isolated and main worlds, so monkey-patching them
// here intercepts calls Coda's own SPA router makes. Same reasoning
// EXTENSION_CAPTURE_DESIGN.md documents for ChatGPT's conversation-switch
// detection (that provider's own content-chatgpt-network.js hooks the same
// two methods, in the MAIN world only because IT also needs a network
// fetch/XHR hook for other reasons this provider doesn't have).
//
// "Session end" is a client-side tab-lifecycle signal (visibilitychange to
// hidden, or pagehide) - never something observed in Coda's own network
// traffic. See constants.py's module docstring on the backend side for why.

(function () {
  const DOC_PATH_RE = /\/d\/([^/?#]+)/;

  // Coda's URL segment is <title-slug>_<stableId> - the slug is empty for
  // an untitled doc ("_dWg6E6d9q24") and a human-readable title-derived
  // string once titled ("tesing-document_dgJFoypEmLC"). The STABLE identity
  // is only the part after the LAST underscore - the slug prefix changes
  // every time the doc is renamed.
  //
  // Confirmed real incident (2026-08-27): this function used to return the
  // WHOLE segment (including the slug). Renaming "Untitled doc" -> "testing
  // no 3" changed the URL from .../Untitled-doc_dEuOQI8bN22 to
  // .../testing-no-3_dEuOQI8bN22 - same trailing dEuOQI8bN22 - but with the
  // whole-segment comparison that looked like "left this doc, opened a
  // different one" to syncToCurrentDoc: it closed the real, still-open
  // session and opened a brand new untracked one, which (a) fragmented one
  // continuous editing session into two backend rows, and (b) silently lost
  // the doc-creation gate's picked client - that only rides along on
  // whichever doc_open happens to consume the pending selection, and the
  // rename's spurious doc_open wasn't the one that had it armed. Keying on
  // the stable suffix alone means a rename no longer looks like a doc
  // change at all - docId stays the same, so syncToCurrentDoc's "same doc,
  // nothing to do" branch correctly leaves the one session alone.
  //
  // Trade-off this reintroduces: doc_title is captured once at doc_open and
  // never refreshed mid-session (same "snapshot, not live-mirrored" posture
  // GrammarlyDocSession's own docstring already documents for doc_title/
  // doc_author) - a rename mid-session means the stored title goes stale
  // until the NEXT real doc_open. Acceptable: title staleness is cosmetic,
  // losing the client link was not.
  // Coda's own doc id (the part after "d") is FIXED-LENGTH - confirmed real
  // (2026-08-27) across every distinct doc captured so far (11 of them):
  // always exactly 10 characters, e.g. "Wg6E6d9q24", "EuOQI8bN22" - INCLUDING
  // "9cinLpH_Bv", where the id itself legitimately CONTAINS AN UNDERSCORE
  // (Coda's id alphabet is not plain alphanumeric). That one real id broke
  // the previous "everything after the LAST underscore" rule outright: it
  // truncated "testing-no-idk_d9cinLpH_Bv" down to just "Bv", silently
  // dropping the other 8 characters - confirmed real via the live DB, this
  // produced doc_id="Bv" for a session that should have been
  // "d9cinLpH_Bv". Two unrelated real docs whose true ids happen to share
  // the same last-underscore-delimited tail would have been wrongly merged
  // into one under that rule; this doc got lucky (nothing else in the DB
  // yet also ends in "_Bv"), but the corruption itself is real and not
  // doc-specific.
  //
  // Preferring the known fixed length (and verifying the slice actually
  // starts with "d", the doc prefix) sidesteps the whole
  // underscore-ambiguity problem instead of trying to out-guess it.
  // Anything that doesn't fit that shape (unexpectedly short, or the slice
  // doesn't start with "d") falls back to the old last-underscore split
  // rather than silently guessing wrong - better a possible slug leftover
  // than a corrupted id.
  const DOC_ID_LEN = 11; // leading "d" + the 10-character id

  function normalizeDocId(rawSegment) {
    if (!rawSegment) return null;
    if (rawSegment.length >= DOC_ID_LEN) {
      const tail = rawSegment.slice(-DOC_ID_LEN);
      if (tail[0] === 'd') return tail;
    }
    const lastUnderscore = rawSegment.lastIndexOf('_');
    return lastUnderscore >= 0 ? rawSegment.slice(lastUnderscore + 1) : rawSegment;
  }

  function currentDocId() {
    const match = DOC_PATH_RE.exec(location.pathname);
    return match ? normalizeDocId(match[1]) : null;
  }

  // A Coda doc can hold several "pages" (its own sidebar sub-page feature) -
  // confirmed real (2026-08-27) URL shape for one:
  //   /d/page-testing_dZ37c5NX5mD/page-2_suQqVX4R#_lupBUa2u
  // The FIRST /d/ segment (matched by DOC_PATH_RE above) is the document,
  // unchanged across every page in it. The SECOND path segment is the page:
  // same "<slug>_<stableId>" shape as the doc segment, but Coda prefixes the
  // page's stable id "su" (vs. the doc's own "d") - e.g. "suQqVX4R",
  // "su-Fxicy". Reuses normalizeDocId's "keep everything after the last
  // underscore" rule for the id half, same rename-survives-it reasoning.
  // The human-readable page NAME has no separate live DOM source the way
  // doc_title does (document.title stays the DOCUMENT's name across a page
  // switch, confirmed real from the same capture - the tab/breadcrumb never
  // renamed itself to the page) - so the page name is read from this same
  // segment's slug half instead, hyphens turned back into spaces
  // ("page-2" -> "page 2", "0001-page-name" -> "0001 page name" - both
  // confirmed matching the real sidebar/breadcrumb page names exactly).
  const PAGE_PATH_RE = /\/d\/[^/?#]+\/([^/?#]+)/;

  // Same fixed-length reasoning as DOC_ID_LEN above, confirmed real across
  // every distinct page captured so far (4): the id after "su" is always
  // exactly 6 characters ("QqVX4R", "-Fxicy", "PiEXUB", "r--r7Q" - the
  // latter two show the id alphabet includes '-' too, not just
  // alphanumerics, so the same underscore-in-id risk applies here in
  // principle even though no page id has shown one yet).
  const PAGE_ID_LEN = 8; // leading "su" + the 6-character id

  function currentPageInfo() {
    const match = PAGE_PATH_RE.exec(location.pathname);
    if (!match) return null; // viewing the doc's own root, no named page segment
    const rawSegment = match[1];
    let pageId;
    let slug;
    if (rawSegment.length >= PAGE_ID_LEN && rawSegment.slice(-PAGE_ID_LEN, -PAGE_ID_LEN + 2) === 'su') {
      pageId = rawSegment.slice(-PAGE_ID_LEN);
      slug = rawSegment.slice(0, rawSegment.length - PAGE_ID_LEN).replace(/_$/, '');
    } else {
      const lastUnderscore = rawSegment.lastIndexOf('_');
      pageId = lastUnderscore >= 0 ? rawSegment.slice(lastUnderscore + 1) : rawSegment;
      slug = lastUnderscore >= 0 ? rawSegment.slice(0, lastUnderscore) : '';
    }
    const pageName = slug.replace(/-/g, ' ').trim() || null; // empty slug (untitled page) -> null
    return { pageId, pageName };
  }

  function currentDocMeta() {
    const canonical = document.querySelector('link[rel="canonical"]');
    const author = document.querySelector('meta[name="author"]');
    return {
      title: (document.title || '').trim() || null,
      author: (author?.getAttribute('content') || '').trim() || null,
      canonicalUrl: (canonical?.getAttribute('href') || '').trim() || null,
    };
  }

  // ---- Document content (best-effort DOM read - see backend
  // providers/grammarly_docs/CAPTURE_CONTRACT.md's "Content capture"
  // section) ----
  // No confirmed Coda-specific class name exists for the doc's canvas (only
  // the loading-shell HTML has ever been captured, never the fully-rendered
  // app - see this file's own top-of-file header comment) - contenteditable
  // is used instead: a semantic, framework-agnostic marker for "the actual
  // editable content region" that virtually every rich document editor
  // (Coda included, going by its "gds-" design system's general shape)
  // exposes regardless of internal class naming, so it survives a Coda
  // redeploy that a guessed class name would not. Falls back to the whole
  // page's visible text if no such region is found - noisier (picks up
  // sidebar/toolbar chrome) but never silently captures nothing.
  function extractGrammarlyDocContentText() {
    let text = '';
    let foundEditableRegion = false;
    try {
      const editableRegions = Array.from(document.querySelectorAll('[contenteditable="true"], [contenteditable=""]'));
      if (editableRegions.length) {
        foundEditableRegion = true;
        // Keep only top-level regions - a nested contenteditable's text is
        // already included in its ancestor's innerText, so including both
        // would duplicate it.
        const topLevel = editableRegions.filter(
          (el) => !editableRegions.some((other) => other !== el && other.contains(el))
        );
        text = topLevel.map((el) => el.innerText || '').join('\n\n').trim();
      }
    } catch (error) {
      try { console.warn('[RMW Grammarly Docs] contenteditable content read failed', error); } catch (_) {}
    }
    // Fall back to whole-page text ONLY when no real editable canvas exists
    // at all - not merely when its text happens to be empty (a genuinely
    // blank freshly-created page has an empty contenteditable, and should
    // report as 0 words, not silently get overwritten with sidebar/toolbar
    // chrome text just because it has nothing typed yet).
    if (!foundEditableRegion) {
      try {
        text = (document.body?.innerText || '').trim();
      } catch (error) {
        try { console.warn('[RMW Grammarly Docs] fallback content read failed', error); } catch (_) {}
      }
    }
    if (!text && !foundEditableRegion) return null; // nothing at all, not even fallback chrome text
    return {
      text,
      wordCount: text ? text.split(/\s+/).filter(Boolean).length : 0,
      charCount: text.length,
      foundEditableRegion,
    };
  }

  // Reports a content snapshot for `sessionKeyAtCall` - a no-op if the
  // active session has already moved on (a new doc opened, or this session
  // already closed) by the time this actually runs, since a settle-timer
  // capture is inherently delayed relative to when it was armed.
  function captureDocContent(reason, sessionKeyAtCall) {
    const targetSessionKey = sessionKeyAtCall || STATE.sessionKey;
    if (!targetSessionKey || STATE.sessionKey !== targetSessionKey) return;
    const extracted = extractGrammarlyDocContentText();
    if (!extracted) return;
    sendCaptureEvent(
      'doc_content_captured',
      newClientEventId(`content-${reason}`, targetSessionKey),
      targetSessionKey,
      STATE.docId,
      {
        contentText: extracted.text,
        wordCount: extracted.wordCount,
        charCount: extracted.charCount,
        capturedAt: new Date().toISOString(),
      },
    );
  }

  // ---- Content settle watch - fires ONE capture per doc_open, once the DOM
  // stops mutating for CONTENT_SETTLE_QUIET_MS (or CONTENT_SETTLE_MAX_WAIT_MS
  // elapses regardless) after a session opens. Re-armed on every new session
  // (openSession below), cleared on close. ----
  const CONTENT_SETTLE_QUIET_MS = 1200;
  const CONTENT_SETTLE_MAX_WAIT_MS = 8000;
  let contentSettleObserver = null;
  let contentSettleQuietTimer = null;
  let contentSettleMaxTimer = null;

  function clearContentSettleWatch() {
    if (contentSettleObserver) { contentSettleObserver.disconnect(); contentSettleObserver = null; }
    if (contentSettleQuietTimer) { clearTimeout(contentSettleQuietTimer); contentSettleQuietTimer = null; }
    if (contentSettleMaxTimer) { clearTimeout(contentSettleMaxTimer); contentSettleMaxTimer = null; }
  }

  function armContentSettleWatch(sessionKey) {
    clearContentSettleWatch();
    const armedAt = Date.now();
    const fire = () => {
      // Confirmed real (2026-08-27): a page opened right after doc/page
      // creation can go DOM-quiet for 1.2s before Coda's own editable canvas
      // has actually mounted - capturing right then falls all the way
      // through to the whole-page-text fallback and locks in sidebar/toolbar
      // chrome ("Skip to content / Pages / New page / Grammarly Writing
      // quality...") as if it were the doc's content, while a page opened
      // later (DOM already warm) correctly finds its real contenteditable
      // region within the same wait. Rather than accept whatever's there on
      // the first quiet tick, check whether a real editable region exists
      // yet - if not, and the hard MAX_WAIT budget isn't exhausted, give it
      // one more quiet window instead of locking in a chrome-only capture.
      const stillWithinBudget = Date.now() - armedAt < CONTENT_SETTLE_MAX_WAIT_MS;
      if (stillWithinBudget) {
        const probe = extractGrammarlyDocContentText();
        if (!probe || !probe.foundEditableRegion) {
          contentSettleQuietTimer = setTimeout(fire, CONTENT_SETTLE_QUIET_MS);
          return;
        }
      }
      clearContentSettleWatch();
      captureDocContent('initial', sessionKey);
    };
    contentSettleMaxTimer = setTimeout(fire, CONTENT_SETTLE_MAX_WAIT_MS);
    contentSettleQuietTimer = setTimeout(fire, CONTENT_SETTLE_QUIET_MS);
    try {
      contentSettleObserver = new MutationObserver(() => {
        if (contentSettleQuietTimer) clearTimeout(contentSettleQuietTimer);
        contentSettleQuietTimer = setTimeout(fire, CONTENT_SETTLE_QUIET_MS);
      });
      contentSettleObserver.observe(document.body || document.documentElement, {
        childList: true, subtree: true, characterData: true,
      });
    } catch (error) {
      try { console.warn('[RMW Grammarly Docs] content settle observer failed to attach', error); } catch (_) {}
    }
  }

  function newSessionKey() {
    return (typeof crypto?.randomUUID === 'function')
      ? crypto.randomUUID()
      : `gdoc_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  }

  function newClientEventId(kind, sessionKey) {
    return `${kind}_${sessionKey}`;
  }

  // Fire-and-forget send to the background service worker's durable outbox -
  // see background-grammarly-docs-capture.js's handleGrammarlyDocsCaptureEventMessage.
  // Errors are swallowed here on purpose: the background script's own queue
  // is the retry/reliability boundary, not this call site (same posture as
  // every other provider's content script send). `linkedClientId`, when
  // given, rides at the TOP level of the event (not inside payload) - that's
  // where the backend schema (CaptureEventIn.linked_client_id) and its
  // server-side re-validation (validate_client_for_generation) expect it,
  // same as every other provider's Client Mapping field.
  function sendCaptureEvent(eventType, clientEventId, sessionKey, docId, payload, linkedClientId) {
    try {
      chrome.runtime.sendMessage({
        type: 'GRAMMARLY_DOCS_CAPTURE_EVENT',
        event: {
          event_type: eventType,
          client_event_id: clientEventId,
          session_key: sessionKey,
          doc_id: docId || undefined,
          payload,
          linked_client_id: linkedClientId || undefined,
        },
      });
    } catch (error) {
      try { console.warn('[RMW Grammarly Docs] capture send failed', error); } catch (_) {}
    }
  }

  const STATE = {
    docId: null,
    pageId: null,
    pageName: null,
    sessionKey: null,
    startedAt: 0,
    ended: true, // true until a doc_open has actually been sent
  };

  // Grammarly (Docs) -> chrome.storage.local key
  // content-grammarly-new-doc-gate.js stashes a picked client under, before
  // replaying the "New doc" click it gated - see that file's own header
  // comment for why chrome.storage.local (not sessionStorage) is the handoff
  // mechanism between it (app.grammarly.com) and this script
  // (coda.grammarly.com).
  const GRAMMARLY_PENDING_CLIENT_STORAGE_KEY = 'grammarlyDocsPendingClientSelection';
  const GRAMMARLY_PENDING_CLIENT_TTL_MS = 2 * 60 * 1000;

  // Consumes (reads AND clears) a still-fresh pending client selection, if
  // one is waiting - a stale one (older than the TTL, or already consumed by
  // an earlier doc_open) is left alone/ignored rather than silently
  // attached to a doc it was never actually picked for.
  async function takePendingClientSelection() {
    try {
      const stored = await chrome.storage.local.get([GRAMMARLY_PENDING_CLIENT_STORAGE_KEY]);
      const pending = stored?.[GRAMMARLY_PENDING_CLIENT_STORAGE_KEY];
      if (!pending || typeof pending !== 'object') return null;
      await chrome.storage.local.remove([GRAMMARLY_PENDING_CLIENT_STORAGE_KEY]);
      if (!pending.clientId || Date.now() - Number(pending.storedAt || 0) > GRAMMARLY_PENDING_CLIENT_TTL_MS) {
        return null;
      }
      return pending;
    } catch (error) {
      try { console.warn('[RMW Grammarly Docs] failed to read pending client selection', error); } catch (_) {}
      return null;
    }
  }

  // A "session" only covers one continuous stretch of the tab being visible
  // - switching away (visibilitychange -> hidden) and back closes the old
  // session and opens a brand new one on return (see this file's own
  // "Session end / re-open" comment further down for why). The doc-creation
  // gate's pending-client handoff above is a ONE-SHOT consumed by whichever
  // doc_open happens to be next - which is exactly the very first session,
  // right after creation. Every later re-open of the SAME doc (tab-switch
  // back, reopening from the doc list, anything) is a brand new session
  // with nothing left to consume, so without this map the picked client
  // would only ever "stick" for as long as the user never once looked away
  // from the tab - confirmed real (2026-08-27): a client picked at creation
  // was gone by the very next re-open, purely from switching to this
  // extension's own dashboard to check the result and back.
  //
  // This map remembers, per doc_id, the last client that WAS successfully
  // attached (from the gate, or from a previous run of this same fallback),
  // and reapplies it to every subsequent doc_open for that doc within the
  // TTL - so the client set at creation now survives tab-switches,
  // reopening the doc later, and reloading the extension itself.
  const GRAMMARLY_DOC_CLIENT_STORAGE_KEY = 'grammarlyDocsClientByDocId';
  const GRAMMARLY_DOC_CLIENT_TTL_MS = 24 * 60 * 60 * 1000; // 24h - a realistic same-day work session

  async function rememberDocClient(docId, clientId, clientName) {
    if (!docId || !clientId) return;
    try {
      const stored = await chrome.storage.local.get([GRAMMARLY_DOC_CLIENT_STORAGE_KEY]);
      const map = (stored?.[GRAMMARLY_DOC_CLIENT_STORAGE_KEY] && typeof stored[GRAMMARLY_DOC_CLIENT_STORAGE_KEY] === 'object')
        ? stored[GRAMMARLY_DOC_CLIENT_STORAGE_KEY]
        : {};
      map[docId] = { clientId, clientName: clientName || undefined, updatedAt: Date.now() };
      await chrome.storage.local.set({ [GRAMMARLY_DOC_CLIENT_STORAGE_KEY]: map });
    } catch (error) {
      try { console.warn('[RMW Grammarly Docs] failed to remember doc client', error); } catch (_) {}
    }
  }

  async function recallDocClient(docId) {
    if (!docId) return null;
    try {
      const stored = await chrome.storage.local.get([GRAMMARLY_DOC_CLIENT_STORAGE_KEY]);
      const map = stored?.[GRAMMARLY_DOC_CLIENT_STORAGE_KEY];
      const entry = map && typeof map === 'object' ? map[docId] : null;
      if (!entry || !entry.clientId) return null;
      if (Date.now() - Number(entry.updatedAt || 0) > GRAMMARLY_DOC_CLIENT_TTL_MS) return null;
      return entry;
    } catch (error) {
      try { console.warn('[RMW Grammarly Docs] failed to recall doc client', error); } catch (_) {}
      return null;
    }
  }

  async function openSession(docId, pageInfo) {
    const meta = currentDocMeta();
    const sessionKey = newSessionKey();
    const startedAt = Date.now();
    // Synchronous state update BEFORE the async client-selection lookup, so
    // any syncToCurrentDoc call that runs while this await is in flight sees
    // a consistent "session already open for this doc" STATE immediately,
    // not a stale/empty one.
    STATE.docId = docId;
    STATE.pageId = pageInfo?.pageId || null;
    STATE.pageName = pageInfo?.pageName || null;
    STATE.sessionKey = sessionKey;
    STATE.startedAt = startedAt;
    STATE.ended = false;

    // Pending gate selection wins if present (a doc just created through
    // the gate) - falls back to whatever client this doc last remembered
    // (any later re-open) - see rememberDocClient/recallDocClient above.
    const pendingClient = await takePendingClientSelection();
    const remembered = pendingClient ? null : await recallDocClient(docId);
    if (STATE.sessionKey !== sessionKey) return; // superseded by a newer session while awaiting
    const resolvedClientId = pendingClient?.clientId ?? remembered?.clientId;
    const resolvedClientName = pendingClient?.clientName ?? remembered?.clientName;

    sendCaptureEvent(
      'doc_open',
      newClientEventId('open', sessionKey),
      sessionKey,
      docId,
      {
        docTitle: meta.title,
        docAuthor: meta.author,
        docUrl: meta.canonicalUrl,
        pageUrl: location.href,
        pageId: STATE.pageId,
        pageName: STATE.pageName,
        startedAt: new Date(startedAt).toISOString(),
      },
      resolvedClientId,
    );
    if (resolvedClientId) rememberDocClient(docId, resolvedClientId, resolvedClientName);
    armContentSettleWatch(sessionKey);
  }

  function closeSession(reason, { captureContent = true } = {}) {
    if (STATE.ended || !STATE.sessionKey) return;
    clearContentSettleWatch();
    // Best-effort final content snapshot, BEFORE flipping STATE.ended below -
    // only for a reason where the DOM still genuinely belongs to the closing
    // doc at this exact synchronous moment (a real tab-leaving signal). SPA
    // navigation to a DIFFERENT doc (doc_changed/left_doc_route) does NOT
    // capture here: by the time this runs (after NAV_SETTLE_DELAY_MS, see
    // syncToCurrentDoc), Coda's own router has very likely already swapped
    // the DOM over to the NEW doc, so a capture at this point would silently
    // attach the wrong doc's content to this session - the settle-watch
    // capture already taken shortly after this session opened is the only
    // signal for that case.
    if (captureContent) captureDocContent('preclose', STATE.sessionKey);
    STATE.ended = true;

    const endedAt = Date.now();
    const durationSeconds = Math.max(0, (endedAt - STATE.startedAt) / 1000);
    sendCaptureEvent(
      'doc_session_end',
      newClientEventId('close', STATE.sessionKey),
      STATE.sessionKey,
      STATE.docId,
      {
        endedAt: new Date(endedAt).toISOString(),
        durationSeconds,
        reason, // informational only - not a field the backend schema requires
      },
    );
  }

  // Re-derives current doc identity from the URL and opens/closes sessions
  // as needed - called on initial load, on every detected SPA navigation,
  // and when the tab becomes visible again after being hidden (see below
  // for why a re-show is treated as a NEW session rather than resuming the
  // old one).
  function syncToCurrentDoc({ delayMs = 0 } = {}) {
    const apply = () => {
      const docId = currentDocId();
      if (!docId) {
        // Left the /d/<docId> route entirely (e.g. back to a doc list) -
        // close out whatever was open, nothing new to start. See
        // closeSession's own comment for why captureContent is false here.
        closeSession('left_doc_route', { captureContent: false });
        STATE.docId = null;
        STATE.pageId = null;
        STATE.pageName = null;
        return;
      }
      const pageInfo = currentPageInfo();
      const pageId = pageInfo?.pageId || null;
      if (docId === STATE.docId && pageId === STATE.pageId && !STATE.ended) {
        // Same doc AND same page, session already open - nothing to do
        // (covers a pushState call that doesn't actually change either,
        // e.g. a hash-only cursor-position update within the same page).
        return;
      }
      if (STATE.docId && !STATE.ended) {
        // Same doc, different page (Coda's sidebar page switch - confirmed
        // real 2026-08-27, see currentPageInfo's own comment) counts as a
        // new session too, not a resumed one: a page switch is a different
        // canvas even though doc_id is shared, so it gets its own session
        // row (and its own duration/content capture) instead of silently
        // overwriting the previous page's still-accurate title/content with
        // the new page's. The doc-level "by person" UI groups all of a
        // doc's sessions back together regardless (see my-dashboard's
        // grammarlyDocsCaptureUtils.js groupSessionsByDoc), so this doesn't
        // fragment the document's reported identity, only its per-visit
        // breakdown - which is the whole point of tracking pageId/pageName
        // at all.
        closeSession(docId === STATE.docId ? 'page_changed' : 'doc_changed', { captureContent: false });
      }
      openSession(docId, pageInfo);
    };

    if (delayMs > 0) {
      // SPA navigation (pushState/replaceState/popstate): unlike a fresh
      // page load, Coda's client router may update <title>/<meta
      // name="author"> a moment after the URL changes rather than having
      // them ready synchronously - a short, best-effort wait gives the DOM
      // a chance to settle before reading it. Not a guarantee (no
      // MutationObserver backstop in this pass) - see CAPTURE_CONTRACT.md.
      setTimeout(apply, delayMs);
    } else {
      apply();
    }
  }

  // ---- SPA navigation detection ----
  // history/location are native objects shared between isolated and main
  // worlds (see this file's own header comment) - patching them here
  // intercepts Coda's own router calls without needing MAIN-world injection.
  const NAV_SETTLE_DELAY_MS = 800;
  const originalPushState = history.pushState;
  const originalReplaceState = history.replaceState;

  history.pushState = function (...args) {
    const result = originalPushState.apply(this, args);
    syncToCurrentDoc({ delayMs: NAV_SETTLE_DELAY_MS });
    return result;
  };
  history.replaceState = function (...args) {
    const result = originalReplaceState.apply(this, args);
    syncToCurrentDoc({ delayMs: NAV_SETTLE_DELAY_MS });
    return result;
  };
  window.addEventListener('popstate', () => syncToCurrentDoc({ delayMs: NAV_SETTLE_DELAY_MS }));

  // Cheap backstop poll (mirrors EXTENSION_CAPTURE_DESIGN.md's documented
  // ChatGPT pattern: "a cheap setInterval backstop (~1s) to catch
  // navigations the hook might miss, e.g. bfcache restores") - catches any
  // route change the pushState/replaceState/popstate hooks above miss.
  // Reports a same-page name correction (page_id/doc_id unchanged, only the
  // URL-slug-derived name changed) - see constants.py's
  // EVENT_TYPE_PAGE_NAME_UPDATED docstring for why this exists: there is no
  // live DOM source for a page's name the way document.title is for the
  // doc's, so a page opened right as it's created/renamed can capture the
  // OLD default slug at doc_open and never get a chance to correct it
  // without this.
  function refreshPageName(pageName) {
    if (!STATE.sessionKey || STATE.ended) return;
    STATE.pageName = pageName;
    sendCaptureEvent(
      'page_name_updated',
      newClientEventId('pagename', `${STATE.sessionKey}-${Date.now()}`),
      STATE.sessionKey,
      STATE.docId,
      { pageId: STATE.pageId, pageName },
    );
  }

  setInterval(() => {
    const docId = currentDocId();
    const pageInfo = currentPageInfo();
    const pageId = pageInfo?.pageId || null;
    if (docId !== STATE.docId || pageId !== STATE.pageId) {
      syncToCurrentDoc();
    } else if (!STATE.ended && pageInfo && pageInfo.pageName && pageInfo.pageName !== STATE.pageName) {
      refreshPageName(pageInfo.pageName);
    }
  }, 1000);

  // ---- Session end / re-open on visibility change ----
  // A hidden tab is treated as the session ending, not merely pausing - if
  // the user comes back to the SAME doc later, that is counted as a new
  // session rather than resuming the old one (this backend attaches no
  // significance to a gap between two sessions on the same doc_id - see
  // GrammarlyDocSession's own docstring). This mirrors the
  // visibilitychange-based approach Coda's own first-party analytics script
  // uses (window.firstHiddenTime, confirmed in the real captured page
  // response) for the same "when did the user actually leave" question.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      closeSession('hidden');
    } else if (document.visibilityState === 'visible' && STATE.ended) {
      syncToCurrentDoc();
    }
  });

  // Backstop for tab close / real navigation away / bfcache eviction -
  // visibilitychange->hidden always fires first per spec, so this rarely
  // does anything by itself, but costs nothing to also register.
  window.addEventListener('pagehide', () => closeSession('pagehide'));

  syncToCurrentDoc();
})();
