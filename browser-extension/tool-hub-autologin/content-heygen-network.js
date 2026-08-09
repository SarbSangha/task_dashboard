(function installRmwHeygenNetworkTelemetry() {
  if (window.__rmwHeygenNetworkTelemetryInstalled) return;
  window.__rmwHeygenNetworkTelemetryInstalled = true;

  // MAIN-world network interceptor for HeyGen - mirrors
  // content-freepik-network.js's philosophy (classify by response body shape,
  // never assume a URL contract) even more cautiously than Freepik's: this
  // codebase has not observed ANY real HeyGen network traffic while building
  // this (no HAR export, no confirmed endpoint or response shape - only the
  // create-video screenshot referenced in the implementation plan). Detection
  // is therefore shape-based against a vocabulary drawn directly from the
  // capture spec (video/render/job/workflow ids, avatar, voice, credits),
  // gated by a broad host+path heuristic so unrelated JSON on the page isn't
  // parsed needlessly. Tighten PATH_HINT_RE and the shape checks below once
  // real traffic is captured, instead of guessing further - see
  // providers/heygen/registry.py's notes for this same caveat on the backend
  // side.
  const SOURCE = 'rmw-heygen-network-telemetry';
  const MAX_TEXT_LENGTH = 500000;
  const HOST_RE = /(^|\.)heygen\.com$/i;
  const PATH_HINT_RE = /(generat|render|video|scene|avatar|voice|project|credit|usage|histor|task|job|workflow)/i;
  const EXCLUDED_PATH_RE = /\.(?:png|jpe?g|webp|gif|avif|svg|mp4|webm|css|woff2?|ttf|ico)(?:[?#]|$)/i;

  // Never forward these fields to the isolated world / backend, wherever
  // they appear in a response body - the spec is explicit that credentials
  // must never be captured, and unlike headers (never read at all here, see
  // below) a JSON response body could incidentally echo one back (e.g. a
  // session-refresh endpoint). Matches key names case-insensitively at any
  // nesting depth.
  const SENSITIVE_KEY_RE = /password|passwd|secret|token|authorization|auth[-_]?header|cookie|session[-_]?key|api[-_]?key/i;

  function redactSensitive(value, depth) {
    if (depth > 8 || value === null || typeof value !== 'object') return value;
    if (Array.isArray(value)) return value.map((item) => redactSensitive(item, depth + 1));
    const out = {};
    for (const key of Object.keys(value)) {
      if (SENSITIVE_KEY_RE.test(key)) {
        out[key] = '[REDACTED]';
        continue;
      }
      out[key] = redactSensitive(value[key], depth + 1);
    }
    return out;
  }

  function isHeygenHost(url) {
    try {
      return HOST_RE.test(new URL(url, location.href).hostname);
    } catch {
      return false;
    }
  }

  function shouldInspectUrl(url) {
    if (!isHeygenHost(url)) return false;
    if (EXCLUDED_PATH_RE.test(url)) return false;
    // Broad net on purpose - the body-shape check below is the real, precise
    // gate. PATH_HINT_RE just avoids wasting a JSON.parse on every single
    // HeyGen XHR (analytics beacons, websocket upgrades, etc). `|| true`
    // matches content-freepik-network.js's own choice to keep the net wide
    // until real traffic proves the hint is safe to rely on.
    return PATH_HINT_RE.test(url) || true;
  }

  function parseJson(text) {
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  }

  const ID_KEY_RE = /^(video|render|job|workflow|scene|avatar|voice|project|request)[-_]?id$/i;
  const CREDIT_KEY_RE = /^(remaining[-_]?credits|used[-_]?credits|credits?|balance|credit[-_]?balance)$/i;

  // A "generation-like object" carries at least one of HeyGen's own
  // identifiers (video/render/job/workflow id - the spec's own list of what
  // to capture), OR both an avatar-shaped and a voice-shaped sub-object
  // (the create-video screen's Avatar & Voice panel, per the reference
  // screenshot), OR a credit-shaped field paired with a status field (a
  // quota/usage response). Any one of these alone (e.g. a bare "credits"
  // field) is too generic and matches unrelated account/profile responses,
  // which is why credits require a co-occurring status field as corroboration
  // - the same "never trust one generic-looking field alone" lesson
  // content-freepik-network.js's looksLikeBareCreationObject already encodes.
  function hasGenerationIdentity(candidate) {
    if (Object.keys(candidate).some((key) => ID_KEY_RE.test(key))) return true;
    // Real observed HeyGen render/queue-status responses (confirmed against
    // live traffic, unlike the rest of this file's vocabulary) key their
    // identity as a bare "id", not "video_id"/"workflow_id" - e.g.
    // { id, status: "processing", progress, eta, eta_anchor_ts,
    // suggested_actions, ... }. A bare "id" alone is too generic (matches
    // any unrelated object), so it only counts when paired with at least one
    // of this shape's other corroborating fields.
    if (typeof candidate.id !== 'string' && typeof candidate.id !== 'number') return false;
    return ['progress', 'eta', 'eta_anchor_ts', 'suggested_actions', 'low_on_capacity'].some((key) => key in candidate);
  }

  function hasAvatarAndVoiceShape(candidate) {
    const avatar = candidate.avatar;
    const voice = candidate.voice;
    const avatarLooksReal = avatar && typeof avatar === 'object' && (avatar.id !== undefined || avatar.avatar_id !== undefined || avatar.name !== undefined);
    const voiceLooksReal = voice && typeof voice === 'object' && (voice.id !== undefined || voice.voice_id !== undefined || voice.name !== undefined);
    return Boolean(avatarLooksReal && voiceLooksReal);
  }

  function hasCorroboratedCreditShape(candidate) {
    const hasCredit = Object.keys(candidate).some((key) => CREDIT_KEY_RE.test(key));
    if (!hasCredit) return false;
    return candidate.status !== undefined || hasGenerationIdentity(candidate);
  }

  function looksLikeHeygenGenerationObject(candidate) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return false;
    return hasGenerationIdentity(candidate) || hasAvatarAndVoiceShape(candidate) || hasCorroboratedCreditShape(candidate);
  }

  function extractGenerationObjects(json) {
    if (!json || typeof json !== 'object') return [];
    if (looksLikeHeygenGenerationObject(json)) return [json];
    if (Array.isArray(json.data)) {
      return json.data.filter((item) => looksLikeHeygenGenerationObject(item));
    }
    if (looksLikeHeygenGenerationObject(json.data)) return [json.data];
    // A few plausible nesting points for a task/status-poll response -
    // unconfirmed against real traffic, same caveat as
    // content-freepik-network.js's identical fallback list.
    for (const key of ['result', 'video', 'render', 'task', 'job', 'workflow', 'project', 'scene']) {
      const nested = json[key];
      if (looksLikeHeygenGenerationObject(nested)) return [nested];
    }
    return [];
  }

  // Shared traversal for "a whole list of rows in one response" shapes -
  // checks the handful of nesting points real HeyGen list endpoints have
  // been observed to use (data.items, data.list, items, or data itself as a
  // bare array), used by both extractListingRows and extractCreditLedgerRows
  // below so the two independently-confirmed list shapes don't duplicate
  // this traversal. data.list added 2026-08-05: movio_bill.list's own real
  // response envelope is {code, data: {total, list: [...]}, msg} - data.list,
  // not data.items - confirmed by a real DevTools capture; credit_ledger_row
  // had silently never matched anything before this, on any page, because
  // this traversal never looked there.
  function extractRowsMatching(json, predicate) {
    const candidates = [json?.data?.items, json?.data?.list, json?.items, Array.isArray(json?.data) ? json.data : null];
    for (const candidate of candidates) {
      if (Array.isArray(candidate) && candidate.length) {
        const rows = candidate.filter((item) => item && typeof item === 'object' && predicate(item));
        if (rows.length) return rows;
      }
    }
    return [];
  }

  // Confirmed real shape (2026-08-04, api2.heygen.com/v1/project/items): a
  // project's whole video history in one response, as
  // { code, data: { items: [ {video_id, status, video_url, metadata: {
  // avatar_iv_meta: {prompt, ...}}, ...}, ... ] } }. Deliberately a SEPARATE
  // detection path from extractGenerationObjects above (which only ever
  // returns a handful of rows meant for the live/armed capture flow) -
  // content-heygen.js routes this one through the reconciliation-only
  // reporting path (isReconciliation: true, never linked to
  // heygenActiveGeneration) precisely because this response can contain
  // dozens of OLD, unrelated videos that must never be attributed to
  // whichever click happens to be armed when the page fetches this.
  function extractListingRows(json) {
    return extractRowsMatching(json, looksLikeHeygenGenerationObject);
  }

  // Confirmed real shape (2026-08-04, movio_bill.list): HeyGen's credit
  // ledger, one row per billable action - {id, action_id, action_type,
  // meta:{quotas:{plan_credit}, duration}, credit, display_value,
  // created_ts, ...}. Not recognized by looksLikeHeygenGenerationObject
  // above (no video/render/job/workflow-shaped key, no status field to
  // corroborate the bare "credit" field) - a ledger row identifies its
  // video by "action_id", not any of this file's usual identity keys.
  function hasCreditLedgerShape(candidate) {
    if (typeof candidate.action_id !== 'string' || typeof candidate.action_type !== 'string') return false;
    return typeof candidate.credit === 'number' || typeof candidate.display_value === 'number';
  }

  // Corrected 2026-08-05 from a real side-by-side sample: one video's real
  // cost is SPLIT across multiple rows with DIFFERENT action_types, not
  // carried entirely on the "video_generate" row alone (the original,
  // unconfirmed 2026-08-04 guess). Confirmed example: video
  // 3761a4b3a0af40e692c9d839dfb9ec6f had a video_generate row with
  // credit:0 AND a companion avatar_iv row (action_id
  // "3761a4b3a0af40e692c9d839dfb9ec6f-41761be4-..." - the video_id PLUS a
  // "-<uuid>" suffix, not the bare video_id) with credit:1 - HeyGen's own
  // UI showed the total as 1, matching 0+1, not either row alone. Filtering
  // to video_generate only (the old code) silently under-reported to 0 on
  // exactly this shape. Grouped instead by the action_ids this app itself
  // requested (parsed from the response URL's own ?action_ids= query param,
  // which every real call to this endpoint carries, proactive or passive)
  // and summed per video - not by guessing at a UUID-suffix pattern.
  function extractRequestedActionIds(url) {
    try {
      const requested = new URL(url, location.href).searchParams.get('action_ids');
      if (!requested) return [];
      return requested.split(',').map((id) => id.trim()).filter(Boolean);
    } catch {
      return [];
    }
  }

  function extractCreditLedgerRows(json, url) {
    const allRows = extractRowsMatching(json, hasCreditLedgerShape);
    if (!allRows.length) return [];
    const requestedIds = extractRequestedActionIds(url);
    if (!requestedIds.length) {
      // No ?action_ids= on the URL to group by - shouldn't happen for this
      // endpoint based on every sample seen so far, but fail back to the
      // old (undercounting but non-zero) behavior rather than guessing at a
      // different grouping scheme blind.
      return allRows.filter((row) => row.action_type === 'video_generate');
    }
    const totalsByVideoId = new Map();
    for (const row of allRows) {
      const actionId = `${row.action_id || ''}`;
      const owner = requestedIds.find((id) => actionId === id || actionId.startsWith(`${id}-`));
      if (!owner) continue;
      const amount = typeof row.credit === 'number' ? row.credit : (typeof row.display_value === 'number' ? row.display_value : 0);
      totalsByVideoId.set(owner, (totalsByVideoId.get(owner) || 0) + amount);
    }
    return Array.from(totalsByVideoId, ([videoId, credit]) => ({ action_id: videoId, action_type: 'video_generate', credit }));
  }

  function postRows(type, rows, sourceUrl) {
    if (!rows.length) return;
    try {
      window.postMessage({
        source: SOURCE,
        type,
        payload: {
          rows: rows.map((item) => redactSensitive(item, 0)),
          sourceUrl: `${sourceUrl || ''}`.slice(0, 2000),
          capturedAt: Date.now(),
        },
      }, location.origin);
    } catch {}
  }

  function logUnrecognizedShapeIfPromising(url, json, text) {
    if (!json || typeof json !== 'object') return;
    const haystack = text.length <= 4000 ? text : text.slice(0, 4000);
    if (!/video|render|avatar|voice|scene|credit/i.test(haystack)) return;
    console.debug('[RMW HeyGen Network] unrecognized but generation-like response - please report this shape', {
      url,
      topLevelKeys: Object.keys(json),
      snippet: haystack.length > 1500 ? `${haystack.slice(0, 1500)}…` : haystack,
    });
  }

  function postGenerationObjects(objects, sourceUrl, transport) {
    if (!objects.length) return;
    try {
      window.postMessage({
        source: SOURCE,
        type: 'HEYGEN_NETWORK_GENERATION',
        payload: {
          rows: objects.map((item) => redactSensitive(item, 0)),
          sourceUrl: `${sourceUrl || ''}`.slice(0, 2000),
          // 'http' (a direct fetch/XHR response to a request this tab
          // issued) vs 'websocket'/'eventsource' (push traffic that could in
          // principle reach every open tab under a shared login) - same
          // distinction content-freepik-network.js draws, for the same
          // reason: content-heygen.js's live-capture gate uses this to decide
          // whether a brand-new identifier is safe to attribute to this tab.
          transport: transport || 'http',
          capturedAt: Date.now(),
        },
      }, location.origin);
    } catch {}
  }

  function inspectResponseText(url, text, transport) {
    if (!text || text.length > MAX_TEXT_LENGTH) return;
    const json = parseJson(text);

    const listingRows = extractListingRows(json);
    if (listingRows.length) {
      console.debug('[RMW HeyGen Network] found listing-shaped response', { url, count: listingRows.length, transport });
      postRows('HEYGEN_NETWORK_LISTING', listingRows, url);
      return;
    }

    const creditLedgerRows = extractCreditLedgerRows(json, url);
    if (creditLedgerRows.length) {
      console.debug('[RMW HeyGen Network] found credit-ledger-shaped response', { url, count: creditLedgerRows.length, transport });
      postRows('HEYGEN_NETWORK_CREDIT_LEDGER', creditLedgerRows, url);
      return;
    }

    const objects = extractGenerationObjects(json);
    if (objects.length) {
      console.debug('[RMW HeyGen Network] found generation-like object(s) in response', { url, count: objects.length, transport });
      postGenerationObjects(objects, url, transport);
    } else {
      logUnrecognizedShapeIfPromising(url, json, text);
    }
  }

  // ---- fetch ----
  // Deliberately never reads `init.headers` / the Request's headers here (see
  // SENSITIVE_KEY_RE's docstring above) - only the response BODY is ever
  // inspected, so an Authorization/Cookie header on the outgoing request is
  // structurally impossible to leak through this path.
  const rawFetch = window.fetch;
  if (typeof rawFetch === 'function') {
    window.fetch = function rmwHeygenFetch(input, init) {
      const url = typeof input === 'string' ? input : (input && input.url) || '';
      const promise = rawFetch.apply(this, arguments);
      if (!shouldInspectUrl(url)) return promise;
      return promise.then((response) => {
        try {
          const contentType = `${response.headers?.get?.('content-type') || ''}`;
          if (/json/i.test(contentType)) {
            response.clone().text().then((text) => inspectResponseText(url, text, 'http')).catch(() => {});
          }
        } catch {}
        return response;
      });
    };
  }

  // ---- XMLHttpRequest ----
  const OriginalXHR = window.XMLHttpRequest;
  if (typeof OriginalXHR === 'function') {
    const rawOpen = OriginalXHR.prototype.open;
    const rawSend = OriginalXHR.prototype.send;

    OriginalXHR.prototype.open = function rmwHeygenXhrOpen(method, url, ...rest) {
      this.__rmwHeygenUrl = url;
      return rawOpen.call(this, method, url, ...rest);
    };

    OriginalXHR.prototype.send = function rmwHeygenXhrSend(...args) {
      const url = this.__rmwHeygenUrl || '';
      if (shouldInspectUrl(url)) {
        this.addEventListener('loadend', function () {
          try {
            if (this.status < 200 || this.status >= 300) return;
            const responseType = this.responseType;
            if (responseType === '' || responseType === 'text') {
              if (typeof this.responseText === 'string') inspectResponseText(url, this.responseText, 'http');
            } else if (responseType === 'json') {
              if (this.response != null) inspectResponseText(url, JSON.stringify(this.response), 'http');
            }
          } catch {}
        });
      }
      return rawSend.apply(this, args);
    };
  }

  // ---- WebSocket / EventSource ----
  // HeyGen's render-progress updates plausibly arrive over a push channel
  // rather than a second XHR/fetch response (the same reasoning
  // content-freepik-network.js documents for its own WebSocket/EventSource
  // hooks) - unconfirmed, but cheap to cover since a page only ever opens a
  // handful of these connections. looksLikeHeygenGenerationObject's
  // vocabulary gate is what protects against misclassifying unrelated socket
  // traffic.
  function inspectTransportMessage(sourceLabel, data, transport) {
    if (typeof data !== 'string') return;
    inspectResponseText(sourceLabel, data, transport);
  }

  const OriginalWebSocket = window.WebSocket;
  if (typeof OriginalWebSocket === 'function') {
    window.WebSocket = function rmwHeygenWebSocket(wsUrl, protocols) {
      const socket = protocols === undefined ? new OriginalWebSocket(wsUrl) : new OriginalWebSocket(wsUrl, protocols);
      try {
        socket.addEventListener('message', (event) => inspectTransportMessage(`websocket:${wsUrl}`, event?.data, 'websocket'));
      } catch {}
      return socket;
    };
    window.WebSocket.prototype = OriginalWebSocket.prototype;
  }

  const OriginalEventSource = window.EventSource;
  if (typeof OriginalEventSource === 'function') {
    window.EventSource = function rmwHeygenEventSource(esUrl, options) {
      const source = new OriginalEventSource(esUrl, options);
      try {
        if (isHeygenHost(esUrl)) {
          source.addEventListener('message', (event) => inspectTransportMessage(`eventsource:${esUrl}`, event?.data, 'eventsource'));
        }
      } catch {}
      return source;
    };
    window.EventSource.prototype = OriginalEventSource.prototype;
  }

  // ---- Proactive credit-ledger fetch (2026-08-05) ----
  //
  // HeyGen never calls movio_bill.list on its own after a generation - only
  // when the user happens to browse to whatever page shows billing/credit
  // history - so credits_used silently never got captured otherwise.
  // content-heygen.js (the ISOLATED-world script that decides WHEN a video
  // is worth a credit lookup) can't call the patched window.fetch above
  // directly - isolated and MAIN worlds each have their own `window`, so its
  // window.fetch is the real, unpatched one and a call there would never
  // reach inspectResponseText. Instead it posts a request over
  // window.postMessage (the same channel this file already uses in the
  // other direction) and THIS MAIN-world script performs the actual fetch,
  // so the response flows through the exact same
  // hasCreditLedgerShape/extractCreditLedgerRows/HEYGEN_NETWORK_CREDIT_LEDGER
  // pipeline as any passively-observed response - no parallel extraction
  // logic to keep in sync.
  //
  // Confirmed real request (2026-08-05, side-by-side DevTools capture, not a
  // guess): GET https://api2.heygen.com/v1/pacific/movio_bill.list
  // ?action_ids=<comma-separated video ids>&perpage=200 - cookie-
  // authenticated (credentials: 'include'; the server's own
  // access-control-allow-credentials: true + allow-origin: https://app.heygen.com
  // response headers confirm this is the intended calling convention, not
  // header/token forgery). Batching many action_ids into one request is
  // HeyGen's own usage pattern too (the captured request itself carried 15).
  const CREDIT_LEDGER_ENDPOINT = 'https://api2.heygen.com/v1/pacific/movio_bill.list';

  function onCreditLedgerFetchRequest(event) {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.source !== SOURCE || data.type !== 'HEYGEN_REQUEST_CREDIT_LEDGER') return;
    const actionIds = Array.isArray(data.payload?.actionIds)
      ? data.payload.actionIds.filter((id) => typeof id === 'string' && id).slice(0, 40)
      : [];
    if (!actionIds.length) return;
    const url = `${CREDIT_LEDGER_ENDPOINT}?action_ids=${actionIds.map(encodeURIComponent).join(',')}&perpage=200`;
    // rawFetch, not the patched window.fetch above - calling the patched
    // version here would still work (shouldInspectUrl matches this URL
    // either way) but would process the response through two independent
    // code paths for no benefit; call inspectResponseText exactly once.
    rawFetch(url, { credentials: 'include' })
      .then((response) => response.text())
      .then((text) => inspectResponseText(url, text, 'http'))
      .catch(() => {});
  }

  window.addEventListener('message', onCreditLedgerFetchRequest);
})();
