(function installRmwEnvatoNetworkTelemetry() {
  if (window.__rmwEnvatoNetworkTelemetryInstalled) return;
  window.__rmwEnvatoNetworkTelemetryInstalled = true;

  // MAIN-world network interceptor for Envato (app.envato.com). Unlike
  // Freepik's interceptor (content-freepik-network.js, shape-based because
  // the real endpoint was never confirmed), Envato's endpoint IS confirmed:
  // a captured HAR shows every ImageGen/ImageEdit/VideoGen/MusicGen/VoiceGen/
  // SoundGen/GraphicsGen tool page loads its history through one shared
  // route-loader family whose URLs always end in `.data` (React Router 7's
  // "single fetch" convention) - e.g. `/generation-history.data`,
  // `/image-generator.data`. Detection here is therefore URL-based (precise,
  // not a guess), not body-shape-based.
  //
  // Critically, these responses are served as `Content-Type: text/x-script`
  // (confirmed in the HAR), NOT `application/json` - a naive content-type
  // gate (the kind content-freepik-network.js uses) would silently miss
  // every single one of them. This gates on the URL's `.data` suffix
  // instead and always attempts to decode the body.
  //
  // The body itself is React Router's "turbo-stream" array-reference format,
  // not plain JSON - decodeEnvatoTurboStream/parseEnvatoTurboStreamResponse
  // (content-envato-turbo-stream.js, loaded before this file in the same
  // MAIN-world manifest.json block) handle that.
  const SOURCE = 'rmw-envato-network-telemetry';
  const MAX_TEXT_LENGTH = 2000000; // a full generation-history page can carry ~24 rich rows plus i18n message tables
  const HOST_RE = /(^|\.)app\.envato\.com$/i;
  const DATA_PATH_RE = /\.data(?:[?#]|$)/i;
  // Confirmed via a captured Network panel trace (2026-08-08): clicking
  // Download on a stock item in app.envato.com's own /search/* browse flow
  // issues `GET /download.data?itemUuid=...&itemType=...` - a materially
  // more reliable identity signal than DOM-scraping the clicked button, so
  // content-envato-capture.js correlates its Task/Client-gated Download
  // click against this network signal rather than relying on DOM alone.
  const DOWNLOAD_PATH_RE = /\/download\.data(?:[?#]|$)/i;

  function isEnvatoHost(url) {
    try {
      return HOST_RE.test(new URL(url, location.href).hostname);
    } catch {
      return false;
    }
  }

  function shouldInspectUrl(url) {
    if (!isEnvatoHost(url)) return false;
    return DATA_PATH_RE.test(url);
  }

  function maybeReportDownloadRequest(url) {
    if (!url || !DOWNLOAD_PATH_RE.test(url) || !isEnvatoHost(url)) return;
    try {
      const parsed = new URL(url, location.href);
      const itemUuid = parsed.searchParams.get('itemUuid');
      // Temporary diagnostic (2026-08-08) - always logs when a download.data
      // request is seen, regardless of whether itemUuid parses out, so we
      // can tell from the console alone whether this download used the same
      // network mechanism as the one already confirmed, or a different one
      // entirely. Safe to remove once the click-detection gap is confirmed
      // fixed.
      console.debug('[RMW Envato Network] download.data request observed', { url, itemUuid, itemType: parsed.searchParams.get('itemType') });
      if (!itemUuid) return;
      window.postMessage({
        source: SOURCE,
        type: 'ENVATO_NETWORK_DOWNLOAD',
        payload: {
          itemUuid,
          itemType: parsed.searchParams.get('itemType') || null,
          sourceUrl: `${url}`.slice(0, 2000),
          capturedAt: Date.now(),
        },
      }, location.origin);
    } catch {}
  }

  // Recursively hunts the decoded response tree for the shapes actually
  // observed (see providers/envato/normalization.py's module docstring for
  // the same three shapes on the backend side): a top-level `assets` array
  // (the GET generation-history loader), a `results` array of {item,
  // actions} wrappers (the POST `actionType=loadMore` action), or an
  // `itemDetailsProps.item` object (a single item-detail page). Bounded
  // depth since the decoded tree also carries a large, irrelevant i18n
  // `messages` map this must not wander into.
  function collectEnvatoRows(node, depth, rows) {
    if (!node || typeof node !== 'object' || depth > 6) return;
    if (Array.isArray(node)) {
      for (const child of node) collectEnvatoRows(child, depth + 1, rows);
      return;
    }
    if (Array.isArray(node.assets)) {
      for (const item of node.assets) if (item && typeof item === 'object') rows.push(item);
    }
    if (Array.isArray(node.results)) {
      for (const wrapper of node.results) if (wrapper && typeof wrapper === 'object') rows.push(wrapper);
    }
    if (node.itemDetailsProps && typeof node.itemDetailsProps === 'object' && node.itemDetailsProps.item) {
      rows.push(node.itemDetailsProps.item);
    }
    for (const key of Object.keys(node)) {
      // 'messages' is Envato's i18n string catalog on every one of these
      // responses (hundreds of keys, never a row) - skip descending into it,
      // pure cost with zero chance of a match.
      if (key === 'messages') continue;
      collectEnvatoRows(node[key], depth + 1, rows);
    }
  }

  function postGenerationRows(rows, sourceUrl, method) {
    if (!rows.length) return;
    try {
      window.postMessage({
        source: SOURCE,
        type: 'ENVATO_NETWORK_GENERATION',
        payload: {
          rows,
          sourceUrl: `${sourceUrl || ''}`.slice(0, 2000),
          method: method || 'GET',
          capturedAt: Date.now(),
        },
      }, location.origin);
    } catch {}
  }

  function inspectResponseText(url, text, method) {
    if (!text || text.length > MAX_TEXT_LENGTH) return;
    const decoded = parseEnvatoTurboStreamResponse(text);
    if (!decoded) return;
    const rows = [];
    collectEnvatoRows(decoded, 0, rows);
    if (rows.length) {
      console.debug('[RMW Envato Network] found generation row(s) in response', { url, count: rows.length });
      postGenerationRows(rows, url, method);
    }
  }

  // ---- fetch ----
  const rawFetch = window.fetch;
  if (typeof rawFetch === 'function') {
    window.fetch = function rmwEnvatoFetch(input, init) {
      const url = typeof input === 'string' ? input : (input && input.url) || '';
      const method = (init && init.method) || (typeof input === 'object' && input && input.method) || 'GET';
      maybeReportDownloadRequest(url); // fired at request time, not response - see this file's own comment on why
      const promise = rawFetch.apply(this, arguments);
      if (!shouldInspectUrl(url)) return promise;
      return promise.then((response) => {
        try {
          response.clone().text().then((text) => inspectResponseText(url, text, method)).catch(() => {});
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

    OriginalXHR.prototype.open = function rmwEnvatoXhrOpen(method, url, ...rest) {
      this.__rmwEnvatoUrl = url;
      this.__rmwEnvatoMethod = method;
      maybeReportDownloadRequest(url);
      return rawOpen.call(this, method, url, ...rest);
    };

    OriginalXHR.prototype.send = function rmwEnvatoXhrSend(...args) {
      const url = this.__rmwEnvatoUrl || '';
      if (shouldInspectUrl(url)) {
        this.addEventListener('loadend', function () {
          try {
            if (this.status < 200 || this.status >= 300) return;
            const responseType = this.responseType;
            if (responseType === '' || responseType === 'text') {
              if (typeof this.responseText === 'string') inspectResponseText(url, this.responseText, this.__rmwEnvatoMethod);
            } else if (responseType === 'json') {
              // Never expected for a `.data` response (Content-Type is
              // text/x-script, so the browser never auto-parses it as JSON) -
              // handled anyway for parity with content-freepik-network.js's
              // identical guard, in case a future Envato build changes this.
              if (this.response != null) inspectResponseText(url, JSON.stringify(this.response), this.__rmwEnvatoMethod);
            }
          } catch {}
        });
      }
      return rawSend.apply(this, args);
    };
  }
})();
