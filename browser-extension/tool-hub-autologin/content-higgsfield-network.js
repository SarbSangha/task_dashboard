(function installRmwHiggsfieldNetworkTelemetry() {
  if (window.__rmwHiggsfieldNetworkTelemetryInstalled) return;
  window.__rmwHiggsfieldNetworkTelemetryInstalled = true;

  // MAIN-world network interceptor for Higgsfield - mirrors
  // content-heygen-network.js's philosophy (classify by response body shape,
  // never assume a URL contract). One real response shape is now CONFIRMED
  // (2026-08-05, a "job set" detail endpoint - see
  // looksLikeHiggsfieldJobDetailObject below and
  // providers/higgsfield/normalization.py's module docstring for the full
  // field mapping); every other shape here (the submit-time click response,
  // a listing endpoint, a credit ledger) is still an unconfirmed guess, same
  // posture HeyGen shipped with initially. Detection for the unconfirmed
  // shapes is shape-based against a vocabulary drawn directly from the
  // capture spec (generation/job/request ids, preset, multi-shot, credits),
  // gated by a broad host+path heuristic so unrelated JSON on the page isn't
  // parsed needlessly. Tighten PATH_HINT_RE and those shape checks further
  // once more real traffic is captured, instead of guessing - see
  // providers/higgsfield/registry.py's notes for this same caveat on the
  // backend side.
  //
  // KNOWN GAP (flagged 2026-08-05, not yet fixed): the confirmed job-detail
  // endpoint above is only fetched by the Higgsfield page itself when a user
  // plays/opens a specific generation in its own history/gallery UI - not on
  // every generation, and not proactively. A generation the user never plays
  // back in-app (downloads directly, or just navigates away) never gets this
  // rich network snapshot at all, only the thinner DOM-scraped submit-time
  // one. This is the same class of gap movio_bill.list had for HeyGen before
  // its proactive-fetch mechanism was built (see that file's own "Proactive
  // credit-ledger fetch" section) - the fix here is the same shape: capture
  // the confirmed request URL for this job-detail endpoint from a real
  // DevTools session, then have content-higgsfield.js proactively call it by
  // job id once a generation is armed, instead of only waiting for a
  // passive sighting. Not built yet because the request URL itself hasn't
  // been captured - only the response body has.
  const SOURCE = 'rmw-higgsfield-network-telemetry';
  const MAX_TEXT_LENGTH = 500000;
  // Matches both higgsfield.ai (the page's own origin) and its confirmed API
  // subdomain fnf-api-gw.higgsfield.ai (the "job set" detail endpoint's own
  // host, GET /fnf/assets/{id}/detail - see looksLikeHiggsfieldJobDetailObject)
  // without needing a separate entry, since (^|\.)higgsfield\.ai$ matches any
  // subdomain depth.
  const HOST_RE = /(^|\.)higgsfield\.ai$/i;
  const PATH_HINT_RE = /(generat|render|video|motion|edit|preset|project|credit|usage|histor|task|job|asset)/i;
  const EXCLUDED_PATH_RE = /\.(?:png|jpe?g|webp|gif|avif|svg|mp4|webm|css|woff2?|ttf|ico)(?:[?#]|$)/i;

  // Never forward these fields to the isolated world / backend, wherever
  // they appear in a response body - same redaction contract as
  // content-heygen-network.js. Matches key names case-insensitively at any
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

  function isHiggsfieldHost(url) {
    try {
      return HOST_RE.test(new URL(url, location.href).hostname);
    } catch {
      return false;
    }
  }

  function shouldInspectUrl(url) {
    if (!isHiggsfieldHost(url)) return false;
    if (EXCLUDED_PATH_RE.test(url)) return false;
    // Broad net on purpose - the body-shape check below is the real, precise
    // gate. PATH_HINT_RE just avoids wasting a JSON.parse on every single
    // Higgsfield XHR (analytics beacons, websocket upgrades, etc). `|| true`
    // matches content-heygen-network.js's own choice to keep the net wide
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

  const ID_KEY_RE = /^(generation|job|request|project)[-_]?id$/i;
  const CREDIT_KEY_RE = /^(remaining[-_]?credits|used[-_]?credits|credits?|balance|credit[-_]?balance)$/i;

  // CONFIRMED real shape (2026-08-05, a "job set" detail endpoint, fetched
  // by the page when a user plays/opens a specific generation - see
  // providers/higgsfield/normalization.py's module docstring for the full
  // field-by-field mapping): {job_set_id, job_set_type, params: {prompt,
  // resolution, aspect_ratio, duration, model, medias: [...]}, id, status,
  // results: {raw: {url, thumbnail_url}, min: {...}}, created_at, ...}.
  // Checked FIRST, ahead of the generic guessed vocabulary below, since this
  // one is precise (job_set_id + params + results co-occurring is Higgsfield-
  // specific, not a generic "object with an id" match).
  function looksLikeHiggsfieldJobDetailObject(candidate) {
    return Boolean(
      candidate.job_set_id !== undefined
      && candidate.params && typeof candidate.params === 'object'
      && candidate.results && typeof candidate.results === 'object'
    );
  }

  // A "generation-like object" carries at least one of Higgsfield's own
  // identifiers (generation/job/request id - the spec's own list of what to
  // capture), OR a preset-shaped sub-object (the Create Video screen's preset
  // picker, e.g. "Seedance Pro", per the reference screenshot), OR a
  // credit-shaped field paired with a status field (a quota/usage response).
  // Any one of these alone (e.g. a bare "credits" field) is too generic and
  // matches unrelated account/profile responses, which is why credits
  // require a co-occurring status field as corroboration - the same "never
  // trust one generic-looking field alone" lesson
  // content-freepik-network.js's looksLikeBareCreationObject already encodes.
  // Still unconfirmed against real traffic (the submit-time response shape,
  // as opposed to the job-detail shape above, has never been observed) -
  // tighten once it is, same as every other guessed vocabulary in this file.
  function hasGenerationIdentity(candidate) {
    if (Object.keys(candidate).some((key) => ID_KEY_RE.test(key))) return true;
    // A bare "id" alone is too generic (matches any unrelated object), so it
    // only counts when paired with at least one corroborating
    // lifecycle/progress field - same reasoning as
    // content-heygen-network.js's identical bare-id carve-out for its own
    // confirmed queue-status shape.
    if (typeof candidate.id !== 'string' && typeof candidate.id !== 'number') return false;
    return ['progress', 'eta', 'eta_anchor_ts', 'status'].some((key) => key in candidate);
  }

  function hasPresetShape(candidate) {
    const preset = candidate.preset;
    return Boolean(preset && typeof preset === 'object' && (preset.id !== undefined || preset.name !== undefined));
  }

  function hasCorroboratedCreditShape(candidate) {
    const hasCredit = Object.keys(candidate).some((key) => CREDIT_KEY_RE.test(key));
    if (!hasCredit) return false;
    return candidate.status !== undefined || hasGenerationIdentity(candidate);
  }

  // CONFIRMED real shape (2026-08-06, the Assets page's own listing
  // endpoint): GET https://fnf-api-gw.higgsfield.ai/fnf/assets?size=<n>&category=all
  // (Bearer-JWT authenticated, same auth as the job-detail endpoint above),
  // response {items: [{id, user_id, created_at, min_url, raw_url,
  // thumbnail_url, job_set_type, published_at, folder_ids, comments_count,
  // artifacts, is_favourite}, ...], cursor}. Deliberately its OWN shape gate
  // rather than folded into hasGenerationIdentity's ID_KEY_RE - a row here
  // carries none of generation_id/job_id/request_id, and its bare "id" has
  // no status/progress/eta co-occurring (every asset in this listing is
  // already finished), so the existing bare-id carve-out never matches it.
  // job_set_type + (raw_url or min_url) + user_id co-occurring is precise to
  // this endpoint, same "don't trust one generic field alone" posture as
  // every other check in this file.
  function looksLikeHiggsfieldAssetListingRow(candidate) {
    return Boolean(
      typeof candidate.id === 'string'
      && typeof candidate.job_set_type === 'string'
      && (typeof candidate.raw_url === 'string' || typeof candidate.min_url === 'string')
      && 'user_id' in candidate
    );
  }

  function looksLikeHiggsfieldGenerationObject(candidate) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return false;
    return (
      looksLikeHiggsfieldJobDetailObject(candidate)
      || looksLikeHiggsfieldAssetListingRow(candidate)
      || hasGenerationIdentity(candidate)
      || hasPresetShape(candidate)
      || hasCorroboratedCreditShape(candidate)
    );
  }

  function extractGenerationObjects(json) {
    if (!json || typeof json !== 'object') return [];
    if (looksLikeHiggsfieldGenerationObject(json)) return [json];
    if (Array.isArray(json.data)) {
      return json.data.filter((item) => looksLikeHiggsfieldGenerationObject(item));
    }
    if (looksLikeHiggsfieldGenerationObject(json.data)) return [json.data];
    // A few plausible nesting points for a task/status-poll response -
    // unconfirmed against real traffic, same caveat as
    // content-heygen-network.js's identical fallback list.
    for (const key of ['result', 'generation', 'job', 'task', 'project']) {
      const nested = json[key];
      if (looksLikeHiggsfieldGenerationObject(nested)) return [nested];
    }
    return [];
  }

  // Shared traversal for "a whole list of rows in one response" shapes -
  // checks the handful of nesting points HeyGen's own list endpoints turned
  // out to actually use (data.items, data.list, items, or data itself as a
  // bare array) - see content-heygen-network.js's extractRowsMatching for
  // the real-traffic history behind checking data.list specifically. Kept
  // here up front rather than added later once Higgsfield's own listing
  // shape is confirmed, since it cost nothing to include from day one.
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

  // CONFIRMED 2026-08-06 (see looksLikeHiggsfieldAssetListingRow above) -
  // json.items is exactly the nesting point .../fnf/assets?size=...&category=all
  // uses (data.items/data.list/bare-array remain here as unconfirmed
  // fallbacks for other listing shapes, same as before). Routed through the
  // reconciliation-only reporting path (isReconciliation: true, never linked
  // to higgsfieldActiveGeneration) once content-higgsfield.js consumes it,
  // since a bulk historical listing must never be attributed to whichever
  // click happens to be armed when the page fetches this.
  function extractListingRows(json) {
    return extractRowsMatching(json, looksLikeHiggsfieldGenerationObject);
  }

  // CONFIRMED real shape (2026-08-06, DevTools capture): GET
  // https://fnf-api-gw.higgsfield.ai/fnf/workspaces/credit-ledger?limit=<n>&page=<n>
  // (Bearer-JWT authenticated, same auth as the asset endpoints above),
  // response {items: [{tx_id, display_name, workflow_id, total_credits,
  // action: "spend"|"deduct"|"refund", credit_type, cost_breakdown,
  // action_to_claim, created_at, tooltip}, ...]}. Unlike HeyGen's own
  // confirmed movio_bill.list (a real per-video action_id on every row), a
  // Higgsfield ledger row carries NO reliable per-generation identity -
  // workflow_id is null on every real row observed so far, and
  // display_name only names the FEATURE used ("Nano Banana Pro", "Seedance
  // 2.0"), not a specific generation instance. Deliberately NOT reusing
  // ID_KEY_RE/hasGenerationIdentity here - tx_id/workflow_id don't match
  // that pattern, and a bare tx_id + total_credits + action co-occurring is
  // precise enough to this endpoint on its own. Best-effort matching a row
  // to a specific HiggsfieldGeneration (workflow_id when present, otherwise
  // an unambiguous time+feature window, NEVER a guess among multiple
  // candidates) happens server-side in normalization.py - this file only
  // recognizes and forwards the raw row.
  function hasCreditLedgerShape(candidate) {
    return Boolean(
      typeof candidate.tx_id === 'string'
      && typeof candidate.total_credits === 'number'
      && typeof candidate.action === 'string'
    );
  }

  function extractCreditLedgerRows(json) {
    return extractRowsMatching(json, hasCreditLedgerShape);
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
    if (!/generation|preset|video|motion|credit/i.test(haystack)) return;
    console.debug('[RMW Higgsfield Network] unrecognized but generation-like response - please report this shape', {
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
        type: 'HIGGSFIELD_NETWORK_GENERATION',
        payload: {
          rows: objects.map((item) => redactSensitive(item, 0)),
          sourceUrl: `${sourceUrl || ''}`.slice(0, 2000),
          // 'http' (a direct fetch/XHR response to a request this tab
          // issued) vs 'websocket'/'eventsource' (push traffic that could in
          // principle reach every open tab under a shared login) - same
          // distinction content-heygen-network.js draws, for the same
          // reason: content-higgsfield.js's live-capture gate uses this to
          // decide whether a brand-new identifier is safe to attribute to
          // this tab.
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
      console.debug('[RMW Higgsfield Network] found listing-shaped response', { url, count: listingRows.length, transport });
      postRows('HIGGSFIELD_NETWORK_LISTING', listingRows, url);
      return;
    }

    const creditLedgerRows = extractCreditLedgerRows(json);
    if (creditLedgerRows.length) {
      console.debug('[RMW Higgsfield Network] found credit-ledger-shaped response', { url, count: creditLedgerRows.length, transport });
      postRows('HIGGSFIELD_NETWORK_CREDIT_LEDGER', creditLedgerRows, url);
      return;
    }

    const objects = extractGenerationObjects(json);
    if (objects.length) {
      console.debug('[RMW Higgsfield Network] found generation-like object(s) in response', { url, count: objects.length, transport });
      postGenerationObjects(objects, url, transport);
    } else {
      logUnrecognizedShapeIfPromising(url, json, text);
    }
  }

  // ---- Bearer-token capture (2026-08-05) ----
  //
  // Every OTHER content-*-network.js file in this extension deliberately
  // never reads request headers, only response bodies (see this file's own
  // earlier version of this comment) - Higgsfield's confirmed job-detail
  // endpoint (see looksLikeHiggsfieldJobDetailObject / the proactive fetch
  // below) is the first exception, because it is NOT cookie-authenticated
  // like every other provider's endpoints in this codebase. It requires an
  // `Authorization: Bearer <JWT>` header, a Clerk-issued session token with
  // an approximately 60-SECOND lifetime (confirmed from a real capture's own
  // iat/exp claims) - `credentials: 'include'` alone cannot reach it. The
  // only way to call it ourselves is to capture that token off one of the
  // PAGE's own outgoing requests and replay it immediately, within its short
  // validity window.
  //
  // Scope of what this captures and where it goes: the token is held ONLY in
  // this MAIN-world module-scope variable, for the current page load only
  // (nothing here persists it to chrome.storage or any other durable store).
  // It is used exclusively to attach an Authorization header to OUR OWN
  // proactive fetch of the exact same detail endpoint the page's own logged-
  // in user is already authorized to read - never forwarded to our backend,
  // never included in any postMessage payload or console log. postRows/
  // postGenerationObjects below still run every captured response through
  // redactSensitive() regardless, as defense in depth.
  const HIGGSFIELD_BEARER_TOKEN_MAX_AGE_MS = 45 * 1000; // stay safely under the observed ~60s token lifetime
  let higgsfieldBearerToken = null;
  let higgsfieldBearerTokenCapturedAt = 0;

  function extractAuthorizationHeaderValue(headers) {
    if (!headers) return null;
    try {
      if (typeof Headers !== 'undefined' && headers instanceof Headers) {
        return headers.get('authorization') || headers.get('Authorization') || null;
      }
      if (Array.isArray(headers)) {
        const pair = headers.find(([key]) => `${key}`.toLowerCase() === 'authorization');
        return pair ? pair[1] : null;
      }
      if (typeof headers === 'object') {
        const key = Object.keys(headers).find((candidateKey) => candidateKey.toLowerCase() === 'authorization');
        return key ? headers[key] : null;
      }
    } catch {}
    return null;
  }

  function captureBearerTokenFromFetchArgs(url, input, init) {
    if (!isHiggsfieldHost(url)) return;
    try {
      let headerValue = extractAuthorizationHeaderValue(init && init.headers);
      if (!headerValue && typeof Request !== 'undefined' && input instanceof Request) {
        headerValue = extractAuthorizationHeaderValue(input.headers);
      }
      if (headerValue && /^Bearer\s/i.test(headerValue)) {
        higgsfieldBearerToken = headerValue;
        higgsfieldBearerTokenCapturedAt = Date.now();
      }
    } catch {}
  }

  // ---- fetch ----
  const rawFetch = window.fetch;
  if (typeof rawFetch === 'function') {
    window.fetch = function rmwHiggsfieldFetch(input, init) {
      const url = typeof input === 'string' ? input : (input && input.url) || '';
      captureBearerTokenFromFetchArgs(url, input, init);
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
    const rawSetRequestHeader = OriginalXHR.prototype.setRequestHeader;

    OriginalXHR.prototype.open = function rmwHiggsfieldXhrOpen(method, url, ...rest) {
      this.__rmwHiggsfieldUrl = url;
      return rawOpen.call(this, method, url, ...rest);
    };

    OriginalXHR.prototype.setRequestHeader = function rmwHiggsfieldXhrSetRequestHeader(name, value) {
      try {
        if (`${name}`.toLowerCase() === 'authorization' && /^Bearer\s/i.test(value || '') && isHiggsfieldHost(this.__rmwHiggsfieldUrl || '')) {
          higgsfieldBearerToken = value;
          higgsfieldBearerTokenCapturedAt = Date.now();
        }
      } catch {}
      return rawSetRequestHeader.apply(this, arguments);
    };

    OriginalXHR.prototype.send = function rmwHiggsfieldXhrSend(...args) {
      const url = this.__rmwHiggsfieldUrl || '';
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
  // Higgsfield's render-progress updates plausibly arrive over a push
  // channel rather than a second XHR/fetch response (the same reasoning
  // content-heygen-network.js documents for its own WebSocket/EventSource
  // hooks) - unconfirmed, but cheap to cover since a page only ever opens a
  // handful of these connections. looksLikeHiggsfieldGenerationObject's
  // vocabulary gate is what protects against misclassifying unrelated socket
  // traffic.
  function inspectTransportMessage(sourceLabel, data, transport) {
    if (typeof data !== 'string') return;
    inspectResponseText(sourceLabel, data, transport);
  }

  const OriginalWebSocket = window.WebSocket;
  if (typeof OriginalWebSocket === 'function') {
    window.WebSocket = function rmwHiggsfieldWebSocket(wsUrl, protocols) {
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
    window.EventSource = function rmwHiggsfieldEventSource(esUrl, options) {
      const source = new OriginalEventSource(esUrl, options);
      try {
        if (isHiggsfieldHost(esUrl)) {
          source.addEventListener('message', (event) => inspectTransportMessage(`eventsource:${esUrl}`, event?.data, 'eventsource'));
        }
      } catch {}
      return source;
    };
    window.EventSource.prototype = OriginalEventSource.prototype;
  }

  // ---- Proactive credit-ledger fetch (2026-08-06) ----
  //
  // content-higgsfield.js (ISOLATED world) posts a request over
  // window.postMessage (isolated and MAIN worlds each have their own
  // `window`, so it can't call the patched fetch above directly) and this
  // MAIN-world script performs the actual fetch so the response flows
  // through the same hasCreditLedgerShape/extractCreditLedgerRows/
  // HIGGSFIELD_NETWORK_CREDIT_LEDGER pipeline as any passively-observed
  // response, no parallel extraction logic to keep in sync - same posture
  // as the job-detail and asset-listing proactive fetches above.
  //
  // Confirmed real request (2026-08-06, DevTools capture): GET
  // https://fnf-api-gw.higgsfield.ai/fnf/workspaces/credit-ledger?limit=<n>&page=<n>
  // - Bearer-JWT authenticated, same as the other two proactive endpoints.
  // limit=500&page=1 in ONE request rather than paging through - this
  // account's own usage page showed "1,000.7 credits spent" / 64 total
  // generations, a bounded, modest history; no need for the asset-listing
  // sweep's tighter size cap here. No per-row retry-on-failure the way the
  // job-detail fetch has: this whole sweep just runs again on its own
  // periodic timer (see content-higgsfield.js), so an occasional stale-token
  // miss self-heals on the next tick rather than needing individual
  // bookkeeping per ledger row.
  const HIGGSFIELD_CREDIT_LEDGER_ENDPOINT = 'https://fnf-api-gw.higgsfield.ai/fnf/workspaces/credit-ledger';

  function onCreditLedgerFetchRequest(event) {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.source !== SOURCE || data.type !== 'HIGGSFIELD_REQUEST_CREDIT_LEDGER') return;

    const token = getFreshHiggsfieldBearerToken();
    if (!token) {
      console.debug('[RMW Higgsfield Network] proactive credit ledger sweep requested but no fresh bearer token is available yet');
      return;
    }

    const url = `${HIGGSFIELD_CREDIT_LEDGER_ENDPOINT}?limit=500&page=1`;
    rawFetch(url, {
      credentials: 'include',
      headers: { Authorization: token },
    })
      .then((response) => (response.ok ? response.text() : null))
      .then((text) => {
        if (text) inspectResponseText(url, text, 'http');
      })
      .catch(() => {});
  }

  window.addEventListener('message', onCreditLedgerFetchRequest);

  // ---- Proactive job-detail fetch (2026-08-05) ----
  //
  // Closes the gap Sarbjeet flagged: the confirmed job-detail endpoint (see
  // looksLikeHiggsfieldJobDetailObject above) is otherwise only ever fetched
  // by the page itself when a user plays/opens a specific generation, so a
  // generation nobody replays in-app would never get this rich data.
  // content-higgsfield.js (the ISOLATED-world script that decides WHICH job
  // id is worth looking up, as soon as one is observed for an armed
  // generation - see its own queueHiggsfieldJobDetailLookup) posts a request
  // over window.postMessage, and THIS MAIN-world script performs the actual
  // fetch, attaching whatever bearer token was most recently captured from
  // the page's own traffic (see the capture logic above) - so the response
  // flows through the exact same looksLikeHiggsfieldJobDetailObject /
  // HIGGSFIELD_NETWORK_GENERATION pipeline as any passively-observed
  // response, no parallel extraction logic to keep in sync.
  //
  // Confirmed real request (2026-08-05, DevTools capture): GET
  // https://fnf-api-gw.higgsfield.ai/fnf/assets/<job id>/detail - Bearer-JWT
  // authenticated (see the token-capture section above for why this can't
  // just use credentials: 'include' the way every other provider's
  // proactive fetch does). If no fresh-enough token has been captured yet,
  // this silently no-ops rather than sending an unauthenticated request that
  // would just 401 - the passive path (the user eventually playing the
  // video) remains the fallback either way.
  const HIGGSFIELD_JOB_DETAIL_ENDPOINT = 'https://fnf-api-gw.higgsfield.ai/fnf/assets';

  // Shared by onJobDetailFetchRequest and onAssetListingFetchRequest below -
  // both are proactive, bearer-token-authenticated fetches with the exact
  // same "no fresh-enough token yet -> silently no-op rather than send an
  // unauthenticated request that would just 401" posture.
  function getFreshHiggsfieldBearerToken() {
    if (!higgsfieldBearerToken || Date.now() - higgsfieldBearerTokenCapturedAt > HIGGSFIELD_BEARER_TOKEN_MAX_AGE_MS) {
      return null;
    }
    return higgsfieldBearerToken;
  }

  // Told to the isolated world whenever a proactive detail fetch definitely
  // did NOT land a usable response - no fresh token yet, an HTTP error (a
  // 401 was observed in practice: tokens captured mid-login-flow, while
  // Clerk is still rotating sign-in-attempt tokens, can already be dead by
  // the time this fetch actually reaches the server, even though they
  // looked "fresh enough" by our own 45s clock), or a network failure.
  // Without this, content-higgsfield.js's higgsfieldJobDetailRequested Set
  // has no way to tell "we asked and it worked" apart from "we asked and it
  // silently died" - it would mark the id done either way and never retry
  // it for the rest of this page load, which is exactly the bug Sarbjeet
  // hit: several ids sitting on "No prompt captured" forever after a single
  // 401 or a single timing miss on a background sweep with hundreds of ids
  // queued behind it.
  function postHiggsfieldJobDetailFailure(jobId, reason, status) {
    try {
      window.postMessage({
        source: SOURCE,
        type: 'HIGGSFIELD_JOB_DETAIL_FETCH_FAILED',
        payload: { jobId, reason, status: status || null },
      }, location.origin);
    } catch {}
  }

  function onJobDetailFetchRequest(event) {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.source !== SOURCE || data.type !== 'HIGGSFIELD_REQUEST_JOB_DETAIL') return;
    const jobId = typeof data.payload?.jobId === 'string' ? data.payload.jobId.trim() : '';
    if (!jobId) return;

    const token = getFreshHiggsfieldBearerToken();
    if (!token) {
      console.debug('[RMW Higgsfield Network] job detail lookup requested but no fresh bearer token is available yet', { jobId });
      postHiggsfieldJobDetailFailure(jobId, 'no_token');
      return;
    }

    const url = `${HIGGSFIELD_JOB_DETAIL_ENDPOINT}/${encodeURIComponent(jobId)}/detail`;
    // rawFetch, not the patched window.fetch above - calling the patched
    // version here would still work (shouldInspectUrl matches this URL
    // either way) but would process the response through two independent
    // code paths for no benefit; call inspectResponseText exactly once. The
    // captured token is read into a local const immediately before use and
    // never touches any variable this file exposes outside this closure.
    rawFetch(url, {
      credentials: 'include',
      headers: { Authorization: token },
    })
      .then((response) => {
        if (!response.ok) {
          postHiggsfieldJobDetailFailure(jobId, 'http_error', response.status);
          return null;
        }
        return response.text();
      })
      .then((text) => {
        // 'proactive', not 'http' - tells content-higgsfield.js's
        // onHiggsfieldNetworkMessage this is a response to a fetch WE
        // explicitly requested by id (queueHiggsfieldJobDetailLookup), not a
        // passively-intercepted response to some fetch the PAGE itself
        // issued. That distinction is what lets a historical (never-armed)
        // asset's detail actually get reported - see that function's own
        // comment for the bug this fixed.
        if (text) inspectResponseText(url, text, 'proactive');
      })
      .catch(() => postHiggsfieldJobDetailFailure(jobId, 'network_error'));
  }

  window.addEventListener('message', onJobDetailFetchRequest);

  // ---- Proactive Assets-listing sweep (2026-08-06) ----
  //
  // Closes the reliability gap Sarbjeet flagged: the confirmed Assets
  // listing endpoint (see looksLikeHiggsfieldAssetListingRow above) is
  // otherwise only ever fetched by the page itself when the user happens to
  // open the Assets tab/section - and even then, timing is inconsistent
  // (observed firing early on some page loads, late or not at all on
  // others, and split across category=image/category=video/category=all
  // variants depending on which sub-tab is visited). Rather than depend on
  // that, content-higgsfield.js fires this on a timer regardless of what
  // page/tab the user is actually looking at, the same "don't wait for the
  // user" reasoning as the job-detail fetch above - just periodic instead of
  // per-resource, since there's no single id to key it on.
  //
  // category=all in ONE request (mirrors the confirmed
  // size=1001&category=all capture) rather than the page's own
  // split image/video calls, so this stays one request per sweep, not two.
  // size is capped well below the 1001 the real page used - MAX_TEXT_LENGTH
  // above is 500KB and 1001 rows of this shape gets uncomfortably close to
  // that; a periodic background sweep doesn't need the full history in one
  // shot the way a one-time page visit might.
  const HIGGSFIELD_ASSET_LISTING_ENDPOINT = 'https://fnf-api-gw.higgsfield.ai/fnf/assets';

  function onAssetListingFetchRequest(event) {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.source !== SOURCE || data.type !== 'HIGGSFIELD_REQUEST_ASSET_LISTING') return;

    const token = getFreshHiggsfieldBearerToken();
    if (!token) {
      console.debug('[RMW Higgsfield Network] proactive asset listing sweep requested but no fresh bearer token is available yet');
      return;
    }

    const url = `${HIGGSFIELD_ASSET_LISTING_ENDPOINT}?size=300&category=all`;
    rawFetch(url, {
      credentials: 'include',
      headers: { Authorization: token },
    })
      .then((response) => response.text())
      .then((text) => inspectResponseText(url, text, 'http'))
      .catch(() => {});
  }

  window.addEventListener('message', onAssetListingFetchRequest);
})();
