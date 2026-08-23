(function installRmwEpidemicSoundNetworkTelemetry() {
  if (window.__rmwEpidemicSoundNetworkTelemetryInstalled) return;
  window.__rmwEpidemicSoundNetworkTelemetryInstalled = true;

  // MAIN-world network interceptor for Epidemic Sound (www.epidemicsound.com).
  // Patching window.fetch/XMLHttpRequest has to happen in MAIN world because
  // an isolated-world content script has its own separate `window` and
  // cannot see the page's own fetch/XHR calls - same reasoning as every
  // other *-network.js file in this extension (content-elevenlabs-network.js,
  // content-envato-elements-network.js, etc).
  //
  // Unlike every other provider captured so far, this one does NOT need to
  // relay the response bytes themselves - the real download endpoint
  // (`/download/`) returns a small JSON body, not audio, and the actual mp3
  // bytes live behind a separately-fetchable signed CDN URL
  // (audiocdn.epidemicsound.com) that content-epidemicsound-capture.js
  // fetches directly once it knows the URL (see that file's
  // fetchAndPushEpidemicSoundAssetMedia). This file's only job is to observe
  // the `/download/` request+response pair and relay a MERGED row (request
  // URL query params + response JSON body) to the isolated world - confirmed
  // live 2026-08-18 via DevTools that the row's identity fields
  // (sound_id, downloadId, is_sfx, qualityType, stemType) live ONLY in the
  // request URL's query string, not in the response body, a difference from
  // every other provider built so far where everything needed was in the
  // response body alone.
  //
  // Confirmed real traffic (2026-08-18 live DevTools capture):
  //   GET https://www.epidemicsound.com/download/?bundle=false&context=MODAL_MUSIC_DOWNLOAD&downloadId=...&is_sfx=true&qualityType=hq&queryId=...&sound_id=...&stemType=full&uiOrigin=tracklist_button&useBundler=true
  //   -> { "assetUrl": "https://audiocdn.epidemicsound.com/audiofiles/mp3/....mp3?...", "remainingDownloads": 1188 }
  // Auth is cookie-based (x-csrftoken header mirrors the csrftoken cookie) -
  // cookies attach automatically to the page's own same-origin requests
  // regardless of which world observes them, so no auth-token-relay dance
  // (unlike ElevenLabs/Suno's MAIN-world auth-observation) is needed here.
  const SOURCE = 'rmw-epidemicsound-network-telemetry';
  const DOWNLOAD_PATH_RE = /^\/download\/?$/i;
  const HOST_RE = /(^|\.)epidemicsound\.com$/i;

  function isEpidemicSoundDownloadEndpoint(url) {
    try {
      const parsed = new URL(url, location.href);
      return HOST_RE.test(parsed.hostname) && DOWNLOAD_PATH_RE.test(parsed.pathname);
    } catch {
      return false;
    }
  }

  // ---- Adapt (epidemicsound.com/adapt?sessionId=...) - a SECOND, separate
  // capture surface added alongside the download interceptor above. Same
  // MAIN-world patch, same postMessage-relay approach, just a distinct
  // message type (EPIDEMIC_SOUND_NETWORK_ADAPTATION, not
  // EPIDEMIC_SOUND_NETWORK_DOWNLOAD_RESPONSE) so content-epidemicsound-
  // capture.js can tell the two surfaces apart without inspecting payload
  // shape. Confirmed real traffic (2026-08-19 live DevTools capture):
  //   POST /a/adaptation/sessions/{sessionId}/versions/compose
  //     -> { id, recordingId, status: "draft", compose: {...}, ... }
  //   POST /a/adaptation/sessions/{sessionId}/versions/{id}/finalize
  //     -> same object shape, status: "pending"
  //   GET  /a/adaptation/sessions/{sessionId}/versions?limit=100&sort=-updatedAt
  //     -> { data: [ {id, status, asset, stems, ...}, ... ] } - the page's
  //     OWN natural polling of this endpoint is the completion signal; no
  //     separate timer-based poll is built here, this file only observes it.
  // Unlike /download/, sessionId lives only in the URL (both the page URL's
  // ?sessionId= query param AND, more reliably since this file only ever
  // sees the REQUEST url, the /sessions/{sessionId}/ path segment shared by
  // all three endpoints) - never in any response body, so it is extracted
  // from the request URL here and relayed explicitly alongside the row(s).
  const ADAPT_COMPOSE_RE = /^\/a\/adaptation\/sessions\/([^/]+)\/versions\/compose\/?$/i;
  const ADAPT_FINALIZE_RE = /^\/a\/adaptation\/sessions\/([^/]+)\/versions\/([^/]+)\/finalize\/?$/i;
  const ADAPT_LIST_RE = /^\/a\/adaptation\/sessions\/([^/]+)\/versions\/?$/i;

  // Returns { kind: 'compose'|'finalize'|'list', sessionId, versionId? } or
  // null if the url isn't one of the three confirmed adaptation endpoints.
  // Checked in addition to (not instead of) isEpidemicSoundDownloadEndpoint -
  // see classifyEpidemicSoundEndpoint below, which tries both.
  function classifyEpidemicSoundAdaptationUrl(url) {
    try {
      const parsed = new URL(url, location.href);
      if (!HOST_RE.test(parsed.hostname)) return null;
      const path = parsed.pathname;
      let match = ADAPT_COMPOSE_RE.exec(path);
      if (match) return { kind: 'compose', sessionId: match[1] };
      match = ADAPT_FINALIZE_RE.exec(path);
      if (match) return { kind: 'finalize', sessionId: match[1], versionId: match[2] };
      match = ADAPT_LIST_RE.exec(path);
      if (match) return { kind: 'list', sessionId: match[1] };
      return null;
    } catch {
      return null;
    }
  }

  // Single dispatch point used by both the fetch and XHR patches below so
  // the download endpoint and the three adaptation endpoints are recognized
  // through one shared code path rather than two parallel interceptors.
  function classifyEpidemicSoundEndpoint(url) {
    if (isEpidemicSoundDownloadEndpoint(url)) return { kind: 'download' };
    return classifyEpidemicSoundAdaptationUrl(url);
  }

  function relayAdaptationResponse(url, body, classification) {
    if (!body || typeof body !== 'object') {
      console.debug('[RMW Epidemic Sound Network] adaptation response had no parseable JSON body', { url, kind: classification.kind });
      return;
    }
    // The list endpoint's response is { data: [...] } - relay EVERY entry,
    // matching how content-suno-network.js relays every clip in a feed
    // response; the isolated-world capture script qualifies/dedupes each one,
    // not this file. The compose/finalize endpoints instead return the
    // version object itself directly (no wrapper) - normalize both shapes
    // into the same `rows` array so the relay message and its consumer don't
    // need to branch on `kind` to find the row(s).
    const rows = classification.kind === 'list'
      ? (Array.isArray(body.data) ? body.data : [])
      : (body.id ? [body] : []);
    if (!rows.length) {
      console.debug('[RMW Epidemic Sound Network] adaptation response had no version rows', { url, kind: classification.kind });
      return;
    }
    console.debug('[RMW Epidemic Sound Network] captured adaptation response', {
      kind: classification.kind, sessionId: classification.sessionId, count: rows.length,
    });
    window.postMessage({
      source: SOURCE,
      type: 'EPIDEMIC_SOUND_NETWORK_ADAPTATION',
      payload: { sessionId: classification.sessionId, kind: classification.kind, rows, capturedAt: Date.now() },
    }, location.origin);
  }

  function queryParamsOf(url) {
    try {
      const parsed = new URL(url, location.href);
      return Object.fromEntries(parsed.searchParams.entries());
    } catch {
      return {};
    }
  }

  function relayDownloadResponse(url, body) {
    if (!body || typeof body !== 'object') {
      console.debug('[RMW Epidemic Sound Network] /download/ response had no parseable JSON body', { url });
      return;
    }
    // DIAGNOSTIC: the confirmed shape is { assetUrl, remainingDownloads } -
    // log anything that drifts from that so a backend schema change shows up
    // here instead of silently dropping capture.
    if (typeof body.assetUrl !== 'string') {
      console.debug('[RMW Epidemic Sound Network] /download/ response missing expected assetUrl field', { url, body });
    }
    const row = {
      requestUrl: `${url || ''}`.slice(0, 2000),
      queryParams: queryParamsOf(url),
      assetUrl: typeof body.assetUrl === 'string' ? body.assetUrl : null,
      remainingDownloads: typeof body.remainingDownloads === 'number' ? body.remainingDownloads : null,
      capturedAt: Date.now(),
    };
    console.debug('[RMW Epidemic Sound Network] captured /download/ response', {
      downloadId: row.queryParams.downloadId, soundId: row.queryParams.sound_id, hasAssetUrl: Boolean(row.assetUrl),
    });
    window.postMessage({ source: SOURCE, type: 'EPIDEMIC_SOUND_NETWORK_DOWNLOAD_RESPONSE', payload: row }, location.origin);
  }

  // ---- fetch ----
  const rawFetch = window.fetch;
  if (typeof rawFetch === 'function') {
    window.fetch = function rmwEpidemicSoundFetch(input, init) {
      const url = typeof input === 'string' ? input : (input && input.url) || '';
      const promise = rawFetch.apply(this, arguments);
      const classification = classifyEpidemicSoundEndpoint(url);
      if (!classification) return promise;
      return promise.then((response) => {
        try {
          if (response.ok) {
            response.clone().json().then((body) => {
              if (classification.kind === 'download') relayDownloadResponse(url, body);
              else relayAdaptationResponse(url, body, classification);
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

    OriginalXHR.prototype.open = function rmwEpidemicSoundXhrOpen(method, url, ...rest) {
      this.__rmwEpidemicSoundUrl = url;
      return rawOpen.call(this, method, url, ...rest);
    };

    OriginalXHR.prototype.send = function rmwEpidemicSoundXhrSend(...args) {
      const url = this.__rmwEpidemicSoundUrl || '';
      const classification = classifyEpidemicSoundEndpoint(url);
      if (classification) {
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
            if (body) {
              if (classification.kind === 'download') relayDownloadResponse(effectiveUrl, body);
              else relayAdaptationResponse(effectiveUrl, body, classification);
            }
          } catch {}
        });
      }
      return rawSend.apply(this, args);
    };
  }
})();
