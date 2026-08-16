(function installRmwFlowNetworkTelemetry() {
  if (window.__rmwFlowNetworkTelemetryInstalled) return;
  window.__rmwFlowNetworkTelemetryInstalled = true;

  // MAIN-world network interceptor for Flow (labs.google/fx/tools/flow) -
  // mirrors content-freepik-network.js's philosophy (observe real traffic,
  // classify by body shape, never assume a URL contract is permanent) with
  // one structural difference: Flow's generation API lives on a DIFFERENT
  // host (aisandbox-pa.googleapis.com) than the page itself (labs.google).
  // That's fine - window.fetch/XMLHttpRequest are patched once, globally, on
  // this page's own JS context, and see every outgoing request regardless of
  // destination host, cross-origin or not (the page's own JS is what issues
  // these calls, with a Bearer token it already holds - no extra
  // host_permissions needed purely to observe the response).
  //
  // Confirmed via a real captured PATCH response (not guessed): one
  // generation = one flowWorkflows/{uuid} resource,
  //   { name, projectId, metadata: { displayName, createTime, updateTime,
  //     primaryMediaId, batchId } }
  // metadata.batchId is the "one Generate click" grouping key - two images
  // from one prompt shared the same batchId, different name/primaryMediaId.
  // See providers/flow/CAPTURE_CONTRACT.md for the full field mapping.
  //
  // A SECOND, independent detection path (below, "Media URL resolution")
  // closes the gap the comment above used to describe: the flowWorkflows
  // response only ever carries primaryMediaId, never an actual image URL.
  // Resolving one requires watching for a completely separate request
  // (media.getMediaUrlRedirect?name={mediaId}, confirmed live: a 307
  // redirect to a signed CDN URL) and reading where the browser ended up,
  // not the response body - see that section for why it can't reuse any of
  // the JSON-shape machinery above.
  const SOURCE = 'rmw-flow-network-telemetry';
  const MAX_TEXT_LENGTH = 500000;
  const HOST_RE = /(^|\.)aisandbox-pa\.googleapis\.com$/i;
  const PATH_HINT_RE = /flowworkflow/i;
  const EXCLUDED_PATH_RE = /\.(?:png|jpe?g|webp|gif|avif|svg|mp4|webm|css|woff2?|ttf|ico)(?:[?#]|$)/i;

  function isFlowGenerationHost(url) {
    try {
      return HOST_RE.test(new URL(url, location.href).hostname);
    } catch {
      return false;
    }
  }

  function shouldInspectUrl(url) {
    if (!isFlowGenerationHost(url)) return false;
    if (EXCLUDED_PATH_RE.test(url)) return false;
    // Broad net on purpose - the body-shape check below
    // (looksLikeFlowWorkflowObject) is the real, precise gate. PATH_HINT_RE
    // just avoids wasting a JSON.parse on every single call to this host
    // (session/credits/other aisandbox endpoints may share it).
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

  // Confirmed shape (see this file's own top comment) - name + a metadata
  // object carrying at least one of the fields this system actually reads.
  // Deliberately NOT gated on `metadata.batchId` alone (every field here is
  // optional individually) - an object with a bare `name` and SOME
  // recognizable metadata is enough to accept, since a still-processing
  // workflow may not have primaryMediaId yet but is still worth capturing
  // once it does show up in a later snapshot (see _is_stale_snapshot in
  // normalization.py, which resolves ordering across multiple captures of
  // the same workflow).
  function looksLikeFlowWorkflowObject(candidate) {
    if (!candidate || typeof candidate !== 'object') return false;
    if (typeof candidate.name !== 'string' || !candidate.name) return false;
    const metadata = candidate.metadata;
    if (!metadata || typeof metadata !== 'object') return false;
    return metadata.batchId !== undefined
      || metadata.primaryMediaId !== undefined
      || metadata.displayName !== undefined;
  }

  function extractWorkflowRows(json) {
    if (!json || typeof json !== 'object') return [];
    if (looksLikeFlowWorkflowObject(json)) return [json];
    // Defensive nesting checks for a future "list workflows" endpoint (never
    // confirmed to exist - see CAPTURE_CONTRACT.md's known gaps) - harmless
    // if it never shows up, since looksLikeFlowWorkflowObject is the real
    // gate either way.
    if (Array.isArray(json.data)) {
      return json.data.filter(looksLikeFlowWorkflowObject);
    }
    if (Array.isArray(json.workflows)) {
      return json.workflows.filter(looksLikeFlowWorkflowObject);
    }
    if (looksLikeFlowWorkflowObject(json.workflow)) return [json.workflow];
    return [];
  }

  // Diagnostic-only, never used for actual capture decisions - same
  // "shape learner" precedent as content-freepik-network.js's identical
  // function. Particularly useful here since video generation's shape is
  // unconfirmed: this is what will surface it the first time someone
  // generates a video with the extension active.
  function logUnrecognizedShapeIfPromising(url, json, text) {
    if (!json || typeof json !== 'object') return;
    const haystack = text.length <= 4000 ? text : text.slice(0, 4000);
    if (!/workflow|batchid|displayname/i.test(haystack)) return;
    console.debug('[RMW Flow Network] unrecognized but workflow-like response - please report this shape', {
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
        type: 'FLOW_NETWORK_GENERATION',
        payload: {
          rows,
          sourceUrl: `${sourceUrl || ''}`.slice(0, 2000),
          // 'http' (a direct fetch/XHR response to a request THIS tab
          // issued) is the only transport this interceptor produces - no
          // confirmed push/websocket completion signal exists for Flow (see
          // CAPTURE_CONTRACT.md). content-flow.js's live-capture gate still
          // checks this field for symmetry with the Freepik gate it mirrors,
          // in case a push transport is added here later.
          transport: transport || 'http',
          capturedAt: Date.now(),
        },
      }, location.origin);
    } catch {}
  }

  // Confirmed live: the flowMedia:batchGenerateImages response body carries
  // BOTH the workflow row(s) (handled above) AND a sibling `media` array in
  // the SAME payload, each entry already holding a ready-to-use signed CDN
  // URL (`image.generatedImage.fifeUrl`) - no need to wait for a later
  // media.getMediaUrlRedirect call (the "Media URL resolution" section
  // below), which only fires once the image is actually viewed/re-rendered.
  // Extracting it here means new generations get a thumbnail immediately;
  // getMediaUrlRedirect remains a useful fallback for older/reconciled rows
  // whose original generation response was never captured.
  function extractMediaUrlRows(json) {
    if (!json || typeof json !== 'object' || !Array.isArray(json.media)) return [];
    return json.media
      .map((entry) => ({
        mediaId: entry?.name ? String(entry.name) : '',
        url: entry?.image?.generatedImage?.fifeUrl ? String(entry.image.generatedImage.fifeUrl) : '',
      }))
      .filter((row) => row.mediaId && row.url);
  }

  function inspectResponseText(url, text, transport) {
    if (!text || text.length > MAX_TEXT_LENGTH) return;
    const json = parseJson(text);
    const rows = extractWorkflowRows(json);
    if (rows.length) {
      console.debug('[RMW Flow Network] found workflow row(s) in response', { url, count: rows.length, transport });
      postGenerationRows(rows, url, transport);
    } else {
      logUnrecognizedShapeIfPromising(url, json, text);
    }
    extractMediaUrlRows(json).forEach((row) => postMediaUrl(row.mediaId, row.url));
  }

  // ---- Media URL resolution ----
  // Matched on the URL substring alone, regardless of host - the full
  // authority was never visible in DevTools' compact Name column when this
  // was captured live, so (same "shape over URL-certainty" philosophy as
  // the rest of this file) this doesn't guess one. Deliberately host-
  // independent, unlike shouldInspectUrl above.
  const MEDIA_REDIRECT_RE = /getMediaUrlRedirect/i;

  function isMediaRedirectUrl(url) {
    return MEDIA_REDIRECT_RE.test(url);
  }

  // Reads the `name` query param off the REQUEST url (before the browser
  // follows the redirect) - this is the mediaId, matching
  // FlowGeneration.primary_media_id exactly. The resolved signed CDN URL
  // itself never contains this id in a matchable form, only the original
  // request does.
  function extractMediaIdFromUrl(url) {
    try {
      return new URL(url, location.href).searchParams.get('name') || '';
    } catch {
      return '';
    }
  }

  // Never touches the response BODY (it's an image, not JSON) - only the
  // final resolved URL matters, read via the standard Response.url /
  // XHR.responseURL property, which reflects where the browser ended up
  // after automatically following the 307, not the originally requested URL.
  function postMediaUrl(mediaId, resolvedUrl) {
    if (!mediaId || !resolvedUrl) return;
    try {
      window.postMessage({
        source: SOURCE,
        type: 'FLOW_NETWORK_MEDIA_URL',
        payload: { mediaId, url: resolvedUrl, capturedAt: Date.now() },
      }, location.origin);
    } catch {}
  }

  // ---- Generate-request gate ----
  // Holds the ACTUAL network call to Flow's generate endpoint - never
  // calling the real fetch/XHR send - until content-flow.js (ISOLATED
  // world) posts back a decision from its task/client picker. Deliberately
  // does NOT touch the click/keydown that triggered this call (that
  // happened before fetch() was even invoked): its recaptcha token was
  // already legitimately minted by Flow's own code from that genuinely
  // trusted gesture, and holding the outgoing HTTP call for the few seconds
  // it takes to pick a task/client doesn't invalidate it (enterprise
  // recaptcha tokens are valid for ~2 minutes, not tied to dispatch
  // timing). See content-flow.js's own "Generate gate" comment for the two
  // earlier designs this replaced and why both broke real generation.
  const GENERATE_ENDPOINT_RE = /flowMedia:batchGenerateImages/i;

  function isGenerateEndpointUrl(url) {
    return GENERATE_ENDPOINT_RE.test(url);
  }

  let flowGenerateGateSeq = 0;
  const pendingFlowGenerateGates = new Map(); // gateId -> {resolve, reject}

  function requestFlowGenerateGateDecision(url) {
    const gateId = `flowgate_${Date.now()}_${++flowGenerateGateSeq}`;
    return new Promise((resolve, reject) => {
      pendingFlowGenerateGates.set(gateId, { resolve, reject });
      try {
        window.postMessage({
          source: SOURCE,
          type: 'FLOW_GENERATE_GATE_REQUEST',
          payload: { gateId, url: `${url || ''}`.slice(0, 2000) },
        }, location.origin);
      } catch (err) {
        pendingFlowGenerateGates.delete(gateId);
        reject(err);
      }
    });
  }

  // Separate source tag from SOURCE above so this listener (and
  // content-flow.js's own message listener, which only reacts to SOURCE)
  // never mistake each other's messages for something else on the shared
  // window - MAIN and ISOLATED worlds both dispatch/observe 'message'
  // events on the same actual window object.
  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.source !== 'rmw-flow-network-telemetry-gate' || data.type !== 'FLOW_GENERATE_GATE_DECISION') return;
    const gateId = data.payload?.gateId;
    const pending = gateId ? pendingFlowGenerateGates.get(gateId) : null;
    if (!pending) return;
    pendingFlowGenerateGates.delete(gateId);
    if (data.payload?.allow) {
      pending.resolve();
    } else {
      pending.reject(new DOMException('Flow generation cancelled - no task/client selected', 'AbortError'));
    }
  });

  // ---- fetch ----
  const rawFetch = window.fetch;
  if (typeof rawFetch === 'function') {
    window.fetch = function rmwFlowFetch(input, init) {
      const url = typeof input === 'string' ? input : (input && input.url) || '';
      const callArgs = arguments;
      const callThis = this;
      const dispatchReal = () => {
        const promise = rawFetch.apply(callThis, callArgs);
        const mediaId = isMediaRedirectUrl(url) ? extractMediaIdFromUrl(url) : '';
        const inspectJson = shouldInspectUrl(url);
        if (!mediaId && !inspectJson) return promise;
        return promise.then((response) => {
          try {
            if (mediaId && response?.url) postMediaUrl(mediaId, response.url);
          } catch {}
          if (inspectJson) {
            try {
              const contentType = `${response.headers?.get?.('content-type') || ''}`;
              if (/json/i.test(contentType)) {
                response.clone().text().then((text) => inspectResponseText(url, text, 'http')).catch(() => {});
              }
            } catch {}
          }
          return response;
        });
      };
      if (isGenerateEndpointUrl(url)) {
        return requestFlowGenerateGateDecision(url).then(dispatchReal);
        // A rejected gate decision (Cancel) propagates as a rejected fetch()
        // promise, exactly like a network failure - Flow's own .catch()
        // handles it, and critically, rawFetch is never called at all.
      }
      return dispatchReal();
    };
  }

  // ---- XMLHttpRequest ----
  const OriginalXHR = window.XMLHttpRequest;
  if (typeof OriginalXHR === 'function') {
    const rawOpen = OriginalXHR.prototype.open;
    const rawSend = OriginalXHR.prototype.send;

    OriginalXHR.prototype.open = function rmwFlowXhrOpen(method, url, ...rest) {
      this.__rmwFlowUrl = url;
      return rawOpen.call(this, method, url, ...rest);
    };

    OriginalXHR.prototype.send = function rmwFlowXhrSend(...args) {
      const url = this.__rmwFlowUrl || '';
      const xhr = this;
      const mediaId = isMediaRedirectUrl(url) ? extractMediaIdFromUrl(url) : '';
      const inspectJson = shouldInspectUrl(url);
      const attachObservers = () => {
        if (!mediaId && !inspectJson) return;
        xhr.addEventListener('loadend', function () {
          try {
            if (this.status < 200 || this.status >= 300) return;
            if (mediaId && this.responseURL) postMediaUrl(mediaId, this.responseURL);
          } catch {}
          if (inspectJson) {
            try {
              if (this.status < 200 || this.status >= 300) return;
              // See content-freepik-network.js's identical comment: responseText
              // throws if responseType isn't '' or 'text', so branch on it
              // rather than accessing it unconditionally.
              const responseType = this.responseType;
              if (responseType === '' || responseType === 'text') {
                if (typeof this.responseText === 'string') inspectResponseText(url, this.responseText, 'http');
              } else if (responseType === 'json') {
                if (this.response != null) inspectResponseText(url, JSON.stringify(this.response), 'http');
              }
            } catch {}
          }
        });
      };
      if (isGenerateEndpointUrl(url)) {
        // real send() is deferred until the decision resolves - on Cancel
        // it is never called at all, same guarantee as the fetch path.
        requestFlowGenerateGateDecision(url).then(
          () => { attachObservers(); rawSend.apply(xhr, args); },
          () => { try { xhr.dispatchEvent(new Event('error')); } catch {} },
        );
        return undefined;
      }
      attachObservers();
      return rawSend.apply(this, args);
    };
  }
})();
