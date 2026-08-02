(function installRmwFreepikNetworkTelemetry() {
  if (window.__rmwFreepikNetworkTelemetryInstalled) return;
  window.__rmwFreepikNetworkTelemetryInstalled = true;

  // MAIN-world network interceptor for Freepik/Magnific - mirrors
  // content-kling-network.js's philosophy (observe real traffic, classify by
  // body shape, never assume a URL contract) but is much simpler: Freepik's
  // "my creations" / generation-submit responses are already rich, complete
  // JSON (owner, creation.metadata, credit ledger, everything) - there is no
  // DOM prompt-scraping to do here at all, unlike Kling.
  //
  // Freepik's exact endpoint path is not hardcoded on purpose: this codebase
  // has only ever seen the *response shape* (a sample "my creations" page),
  // never a confirmed request URL. Detection is therefore shape-based (does
  // the parsed JSON look like a Freepik "file" object or a listing of them),
  // gated by a broad host+path heuristic so unrelated JSON on the page isn't
  // parsed needlessly. Per providers/freepik/CAPTURE_CONTRACT.md's "observe
  // first" methodology, tighten PATH_HINT_RE once real traffic is captured
  // (a HAR export) instead of guessing further.
  const SOURCE = 'rmw-freepik-network-telemetry';
  const MAX_TEXT_LENGTH = 500000; // listing pages carry up to 50 rich rows
  const HOST_RE = /(^|\.)(freepik\.com|magnific\.com)$/i;
  const PATH_HINT_RE = /(creation|generation|gallery|history|my-|library|asset|folder)/i;
  const EXCLUDED_PATH_RE = /\.(?:png|jpe?g|webp|gif|avif|svg|mp4|webm|css|woff2?|ttf|ico)(?:[?#]|$)/i;

  function isFreepikHost(url) {
    try {
      return HOST_RE.test(new URL(url, location.href).hostname);
    } catch {
      return false;
    }
  }

  function shouldInspectUrl(url) {
    if (!isFreepikHost(url)) return false;
    if (EXCLUDED_PATH_RE.test(url)) return false;
    // Broad net on purpose - the body-shape check below (looksLikeFreepikFile)
    // is the real, precise gate. PATH_HINT_RE just avoids wasting a JSON.parse
    // on every single Freepik XHR (analytics beacons, websocket upgrades, etc).
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

  // A "file object" is one entry of a "my creations" listing's data[] array,
  // or (assumed, unverified against real traffic) the equivalent single-object
  // shape a generation-submit response returns - see CAPTURE_CONTRACT.md.
  function looksLikeFreepikFileObject(candidate) {
    if (!candidate || typeof candidate !== 'object') return false;
    const creation = candidate.creation;
    if (!creation || typeof creation !== 'object') return false;
    return creation.id !== undefined || creation.identifier !== undefined;
  }

  // The "my creations" gallery listing wraps each row in an outer "file"
  // object ({creation: {...}, thumbnail, download_url, ...} - see the shape
  // in CAPTURE_CONTRACT.md). The completion signal Magnific's image-generator
  // page itself reacts to in real time (updating its own on-page grid the
  // moment a render finishes) has never been confirmed to use that same
  // wrapped shape - it may well be a per-task status poll that returns the
  // "creation" object BARE, with no outer wrapper. This recognizes that case
  // too, since silently requiring the wrapper would mean the exact
  // completion event this system most needs (processing -> completed) could
  // never be recognized at all.
  function looksLikeBareCreationObject(candidate) {
    if (!candidate || typeof candidate !== 'object' || candidate.creation) return false;
    const hasIdentity = candidate.id !== undefined || candidate.identifier !== undefined;
    if (!hasIdentity) return false;
    // Deliberately NOT gated on candidate.status alone (an earlier version
    // of this check was) - "an object with an id and a status field" matches
    // an enormous fraction of unrelated API responses on any site (user
    // profile, notification, subscription, folder, ...), which would have
    // misclassified ordinary site traffic as a "generation" and inserted
    // garbage rows, possibly attributed to whoever's ticket was active. The
    // only acceptable signals here are ones genuinely specific to a Freepik
    // creation object: a metadata sub-object carrying prompt/service/mode
    // (Freepik-generation vocabulary, not generic), or a non-empty `tool`
    // string (e.g. "text-to-image").
    const metadata = candidate.metadata;
    const hasCreationMetadataShape = Boolean(
      metadata && typeof metadata === 'object'
      && (metadata.prompt !== undefined || metadata.service !== undefined || metadata.mode !== undefined)
    );
    const hasToolField = typeof candidate.tool === 'string' && candidate.tool.length > 0;
    return hasCreationMetadataShape || hasToolField;
  }

  function extractFileObjects(json) {
    if (!json || typeof json !== 'object') return [];
    if (looksLikeFreepikFileObject(json)) return [json];
    if (looksLikeBareCreationObject(json)) return [{ creation: json }];
    if (Array.isArray(json.data)) {
      return json.data.map((item) => {
        if (looksLikeFreepikFileObject(item)) return item;
        if (looksLikeBareCreationObject(item)) return { creation: item };
        return null;
      }).filter(Boolean);
    }
    if (looksLikeFreepikFileObject(json.data)) return [json.data];
    if (looksLikeBareCreationObject(json.data)) return [{ creation: json.data }];
    // A few more plausible nesting points for a task/status-poll response,
    // checked defensively since none of these are confirmed against real
    // traffic yet (see the "shape learner" diagnostic below, which exists
    // specifically to replace this guesswork with ground truth).
    for (const key of ['result', 'task', 'job', 'creation']) {
      const nested = json[key];
      if (looksLikeFreepikFileObject(nested)) return [nested];
      if (looksLikeBareCreationObject(nested)) return [{ creation: nested }];
    }
    return [];
  }

  // Diagnostic-only, never used for actual capture decisions: if a response
  // didn't match any known shape above but its raw text mentions "creation"
  // or "prompt", it's plausibly a generation-related payload we just don't
  // recognize yet - log a bounded snippet so the next repro gives real
  // ground truth (exact field names/nesting) instead of another guess.
  function logUnrecognizedShapeIfPromising(url, json, text) {
    if (!json || typeof json !== 'object') return;
    const haystack = text.length <= 4000 ? text : text.slice(0, 4000);
    if (!/creation|prompt/i.test(haystack)) return;
    console.debug('[RMW Freepik Network] unrecognized but generation-like response - please report this shape', {
      url,
      topLevelKeys: Object.keys(json),
      snippet: haystack.length > 1500 ? `${haystack.slice(0, 1500)}…` : haystack,
    });
  }

  function postGenerationRows(rows, sourceUrl, transport) {
    if (!rows.length) return;
    try {
      window.postMessage({
        source: SOURCE,
        type: 'FREEPIK_NETWORK_GENERATION',
        payload: {
          rows,
          sourceUrl: `${sourceUrl || ''}`.slice(0, 2000),
          // 'http' (a direct fetch/XHR response to a request THIS tab issued)
          // vs 'websocket'/'eventsource' (Echo/Pusher push traffic, which the
          // shared Freepik/Magnific account broadcasts to every open tab on
          // that login, not just the one that triggered the generation) -
          // content-freepik.js's live-capture gate uses this to decide
          // whether a brand-new creation_id is safe to claim: only a direct
          // response to our own request proves this tab caused it, mirroring
          // how content-kling-network.js correlates identifiers pulled from
          // the outgoing request/response pair rather than trusting anything
          // that merely arrives during an armed window.
          transport: transport || 'http',
          // meta.pagination (page/per_page/last_page/total) rides along
          // unparsed on the raw row set the isolated world already has - this
          // layer doesn't need to understand pagination, only content-freepik.js's
          // reconciliation walker does (see its own file for how it learns
          // the listing URL template from sourceUrl).
          capturedAt: Date.now(),
        },
      }, location.origin);
    } catch {}
  }

  // Laravel Echo / Pusher-protocol push messages (confirmed on this account -
  // console shows "[Echo] Subscribed: private-project.xxx" / "private-user.xxx")
  // arrive as a wire-level envelope: {"event": "...", "channel": "...",
  // "data": "<json string>"} - the actual payload is JSON-encoded a SECOND
  // time inside the `data` field, because we intercept the raw WebSocket
  // frame before pusher-js's own client gets a chance to parse it. A plain
  // fetch/XHR JSON body never has this shape, so unwrapping it here is safe -
  // it only ever fires for the one extra level Echo/Pusher actually adds.
  function unwrapPusherEnvelope(json) {
    if (!json || typeof json !== 'object' || typeof json.data !== 'string') return null;
    return parseJson(json.data);
  }

  function inspectResponseText(url, text, transport) {
    if (!text || text.length > MAX_TEXT_LENGTH) return;
    const json = parseJson(text);
    let rows = extractFileObjects(json);
    if (!rows.length) {
      const unwrapped = unwrapPusherEnvelope(json);
      if (unwrapped) rows = extractFileObjects(unwrapped);
    }
    if (rows.length) {
      console.debug('[RMW Freepik Network] found generation row(s) in response', { url, count: rows.length, transport });
      postGenerationRows(rows, url, transport);
    } else {
      // Doesn't match any recognized shape - only worth a log (and only a
      // targeted one) if the text hints this might be a generation-related
      // payload we simply don't recognize the shape of yet. Everything else
      // (analytics, config, unrelated JSON) is silently skipped, or this
      // would flood the console given shouldInspectUrl's broad net.
      logUnrecognizedShapeIfPromising(url, json, text);
    }
  }

  // ---- fetch ----
  const rawFetch = window.fetch;
  if (typeof rawFetch === 'function') {
    window.fetch = function rmwFreepikFetch(input, init) {
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

    OriginalXHR.prototype.open = function rmwFreepikXhrOpen(method, url, ...rest) {
      this.__rmwFreepikUrl = url;
      return rawOpen.call(this, method, url, ...rest);
    };

    OriginalXHR.prototype.send = function rmwFreepikXhrSend(...args) {
      const url = this.__rmwFreepikUrl || '';
      if (shouldInspectUrl(url)) {
        this.addEventListener('loadend', function () {
          try {
            if (this.status < 200 || this.status >= 300) return;
            // this.responseText THROWS (not just empty) if the caller set
            // xhr.responseType to anything other than '' or 'text' - a very
            // common pattern ("responseType: 'json'") that a naive
            // unconditional access here would silently miss entirely (the
            // exception lands in this try/catch with zero trace). When
            // responseType is 'json', the browser has already parsed the
            // body into `this.response` - re-serializing it is cheap and
            // lets inspectResponseText's shape-detection logic work
            // identically either way, without needing a second code path.
            const responseType = this.responseType;
            if (responseType === '' || responseType === 'text') {
              if (typeof this.responseText === 'string') inspectResponseText(url, this.responseText, 'http');
            } else if (responseType === 'json') {
              if (this.response != null) inspectResponseText(url, JSON.stringify(this.response), 'http');
            }
            // 'blob' / 'arraybuffer' / 'document' are never JSON API payloads
            // in this app - intentionally left unhandled.
          } catch {}
        });
      }
      return rawSend.apply(this, args);
    };
  }

  // ---- WebSocket / EventSource ----
  // Kling's own network interceptor hooks these transports too, because a
  // real-time "your generation is done" push is a plausible design for this
  // exact kind of app - and for Freepik it turned out to matter: the
  // completion update (the one carrying creation.preview/large_preview/raw,
  // i.e. the actual image) can arrive over one of these push transports
  // rather than as a second XHR/fetch response, while the *first* response
  // (job submission, status: "processing", no preview yet) does come through
  // XHR/fetch and gets captured normally. Routing these messages through the
  // exact same inspectResponseText()/extractFileObjects() shape-detection
  // used for fetch/XHR (rather than a separate, looser check) means a
  // message only ever gets forwarded as a capturable row if it passes the
  // same Freepik-specific vocabulary gate (looksLikeBareCreationObject) that
  // guards against misclassifying unrelated traffic - no new false-positive
  // surface versus the fetch/XHR path. Messages that don't match any known
  // shape still just log via inspectResponseText's own fallback, same as
  // before.
  function inspectTransportMessage(sourceLabel, data, transport) {
    if (typeof data !== 'string') return; // binary frames (e.g. protobuf) aren't a JSON payload we can parse
    inspectResponseText(sourceLabel, data, transport);
  }

  // Deliberately NOT gated by isFreepikHost - confirmed via this account's
  // own console ("[Echo] Subscribed: private-project.xxx / private-user.xxx")
  // that the real-time push channel is Laravel Echo over Pusher, which
  // connects to Pusher's own infrastructure (typically wss://ws-*.pusher.com
  // or a dedicated Reverb/Soketi host) rather than a freepik.com/magnific.com
  // subdomain. Gating WebSocket construction on the page's own host would
  // have silently skipped attaching a listener to that connection entirely -
  // exactly the kind of silent miss this system exists to avoid. A page only
  // ever opens a handful of WebSocket connections (unlike the hundreds of
  // XHR/fetch calls shouldInspectUrl has to filter), so the cost of
  // inspecting all of them is negligible; extractFileObjects' Freepik-
  // specific vocabulary gate is what actually protects against
  // misclassifying unrelated socket traffic (chat widgets, analytics, etc).
  const OriginalWebSocket = window.WebSocket;
  if (typeof OriginalWebSocket === 'function') {
    window.WebSocket = function rmwFreepikWebSocket(wsUrl, protocols) {
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
    window.EventSource = function rmwFreepikEventSource(esUrl, options) {
      const source = new OriginalEventSource(esUrl, options);
      try {
        if (isFreepikHost(esUrl)) {
          source.addEventListener('message', (event) => inspectTransportMessage(`eventsource:${esUrl}`, event?.data, 'eventsource'));
        }
      } catch {}
      return source;
    };
    window.EventSource.prototype = OriginalEventSource.prototype;
  }
})();
