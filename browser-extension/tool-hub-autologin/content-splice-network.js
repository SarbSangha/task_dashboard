(function installRmwSpliceNetworkTelemetry() {
  if (window.__rmwSpliceNetworkTelemetryInstalled) return;
  window.__rmwSpliceNetworkTelemetryInstalled = true;

  // MAIN-world network interceptor for Splice (splice.com). Patching
  // window.fetch/XMLHttpRequest has to happen in MAIN world because an
  // isolated-world content script has its own separate `window` and cannot
  // see the page's own fetch/XHR calls - same reasoning as every other
  // *-network.js file in this extension (content-epidemicsound-network.js,
  // content-envato-elements-network.js, etc).
  //
  // CRITICAL architectural difference from Epidemic Sound's /download/
  // endpoint: https://surfaces-graphql.splice.com/graphql is a SHARED
  // GraphQL endpoint used for many unrelated queries (search, previews,
  // user info, etc) - it is NOT a dedicated download endpoint. This file's
  // only job is to classify a response body's SHAPE (does
  // data.asset.files[] exist as an array, with an entry whose
  // asset_file_type_slug === "source") and relay every match - it does NOT
  // try to decide whether a given response corresponds to a real,
  // user-initiated download click. That decision belongs entirely to
  // content-splice-capture.js's FIFO pending-arm queue (splicePendingArms /
  // takeOldestSpliceArm), ported directly from
  // content-epidemicsound-capture.js's identical pattern for /download/
  // responses that could arrive before or without a matching arm.
  //
  // Confirmed real traffic (2026-08-19 live DevTools capture):
  //   POST https://surfaces-graphql.splice.com/graphql
  //   -> {
  //        "data": {
  //          "asset": {
  //            "__typename": "SampleAsset",
  //            "files": [
  //              { "uuid": "...", "name": "", "url": "https://spliceproduction.s3.us-west-1.amazonaws.com/audio_samples/{hash}-scrambled/{hash}.mp3?...", "asset_file_type_slug": "preview_mp3", "path": "audio_samples/{hash}-scrambled/{hash}.mp3", "__typename": "AssetFile" },
  //              { "uuid": "...", "name": "", "url": "https://spliceblob.splice.com/audio_samples/{hash}.wv.json", "asset_file_type_slug": "waveform", "path": "/audio_samples/{hash}.wv.json", "__typename": "AssetFile" },
  //              { "uuid": "", "name": null, "url": "https://spliceproduction.s3.us-west-1.amazonaws.com/audio_samples/{hash}?...", "asset_file_type_slug": "source", "path": null, "__typename": "AssetFile" }
  //            ]
  //          }
  //        }
  //      }
  // The "source" entry's signed S3 URL expires in only ~119 seconds - the
  // shortest expiry of any provider built so far - so the consumer of this
  // relay must fetch it immediately, not defer/batch. That timing concern is
  // entirely content-splice-capture.js's responsibility; this file just
  // relays as soon as the response is observed.
  const SOURCE = 'rmw-splice-network-telemetry';
  const GRAPHQL_HOST_RE = /(^|\.)surfaces-graphql\.splice\.com$/i;
  const GRAPHQL_PATH_RE = /^\/graphql\/?$/i;

  function isSpliceGraphqlEndpoint(url) {
    try {
      const parsed = new URL(url, location.href);
      return GRAPHQL_HOST_RE.test(parsed.hostname) && GRAPHQL_PATH_RE.test(parsed.pathname);
    } catch {
      return false;
    }
  }

  // Only the response shape matters here - not the request's own query/
  // operation name (never confirmed stable, so not relied upon). Matches
  // data.asset.files as an array containing at least one "source" entry;
  // anything else (search results, user info, other unrelated graphql
  // responses sharing this same endpoint) is silently ignored.
  function extractAssetFiles(body) {
    const files = body?.data?.asset?.files;
    if (!Array.isArray(files) || !files.length) return null;
    const hasSource = files.some((file) => file && file.asset_file_type_slug === 'source');
    if (!hasSource) return null;
    return files;
  }

  function relayGraphqlAssetFiles(url, body) {
    const files = extractAssetFiles(body);
    if (!files) return;
    console.debug('[RMW Splice Network] captured graphql asset.files response', {
      url, count: files.length, types: files.map((file) => file?.asset_file_type_slug),
    });
    window.postMessage({
      source: SOURCE,
      type: 'SPLICE_NETWORK_GRAPHQL_ASSET_FILES',
      payload: { files, capturedAt: Date.now() },
    }, location.origin);
  }

  // ---- fetch ----
  const rawFetch = window.fetch;
  if (typeof rawFetch === 'function') {
    window.fetch = function rmwSpliceFetch(input, init) {
      const url = typeof input === 'string' ? input : (input && input.url) || '';
      const promise = rawFetch.apply(this, arguments);
      if (!isSpliceGraphqlEndpoint(url)) return promise;
      return promise.then((response) => {
        try {
          if (response.ok) {
            response.clone().json().then((body) => {
              relayGraphqlAssetFiles(url, body);
            }).catch(() => {});
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

    OriginalXHR.prototype.open = function rmwSpliceXhrOpen(method, url, ...rest) {
      this.__rmwSpliceUrl = url;
      return rawOpen.call(this, method, url, ...rest);
    };

    OriginalXHR.prototype.send = function rmwSpliceXhrSend(...args) {
      const url = this.__rmwSpliceUrl || '';
      if (isSpliceGraphqlEndpoint(url)) {
        this.addEventListener('loadend', function () {
          try {
            if (this.status < 200 || this.status >= 300) return;
            const effectiveUrl = this.responseURL || url;
            let body = null;
            if (this.responseType === 'json') {
              body = this.response;
            } else if (!this.responseType || this.responseType === 'text') {
              body = JSON.parse(this.responseText);
            }
            if (body) relayGraphqlAssetFiles(effectiveUrl, body);
          } catch {}
        });
      }
      return rawSend.apply(this, args);
    };
  }
})();
