(function installRmwSunoNetworkTelemetry() {
  if (window.__rmwSunoNetworkTelemetryInstalled) return;
  window.__rmwSunoNetworkTelemetryInstalled = true;

  // MAIN-world network interceptor for Suno (suno.com) - modeled on
  // content-elevenlabs-network.js's philosophy (observe real traffic,
  // classify by body SHAPE, relay auth to the isolated world), but starting
  // from a CONFIRMED shape rather than a defensive guess - see this
  // extension's task brief / CAPTURE_CONTRACT.md for the full live DevTools
  // capture (2026-08-17) this file is built against:
  //
  //   POST https://studio-api-prod.suno.com/api/feed/v3
  //   -> { clips: [ { id, status, title, created_at, audio_url, media_urls,
  //                    metadata: { tags, prompt, gpt_description_prompt, ... },
  //                    action_config: { actions: [...] }, ... }, ... ],
  //        has_more: bool }
  //
  // Note the host: studio-api-prod.suno.com (hyphen before "prod") - a
  // different subdomain-naming convention than ElevenLabs' regional
  // api.us.elevenlabs.io, so this file does NOT wildcard-match an "api.*"
  // prefix the way content-elevenlabs-network.js does - only the one
  // confirmed exact host is matched. It IS a subdomain of suno.com, so it's
  // already covered by manifest.json's existing https://*.suno.com/*
  // host_permissions entry - no manifest host_permissions change needed for
  // this file (see this repo's task brief for the audit that confirmed this).
  //
  // Unlike ElevenLabs (id split across history_item_id/id/generation_id,
  // Music's nested chat/song wrapper), Suno's clip `id` is flat, top-level,
  // and stable for the clip's whole lifecycle - one row per id, always. So
  // the row-recognition logic below is deliberately simple (id + created_at
  // present, both flat) rather than ElevenLabs' defensive multi-candidate-
  // field OR-gate, which exists there only because that shape was never
  // confirmed - this one already is.
  //
  // AUDIO DELIVERY: unlike ElevenLabs (history row carries no audio URL at
  // all, only Play/Download traffic ever does), Suno's row carries its own
  // audio_url/media_urls INLINE - but those are populated even while the
  // clip is still "status":"streaming" (a live streaming endpoint, not a
  // proof-of-completion signal). The confirmed, deterministic readiness
  // signal instead lives in action_config.actions[] - the entry with
  // action_type "download_song" carries a `disabled` boolean (true = still
  // generating, with a literal "You can download once your song's done
  // generating." toast override; false = the real asset is ready). Because
  // the asset URL is already embedded in the row once ready, the primary
  // capture path for audio bytes is content-suno-capture.js's PROACTIVE fetch
  // (gated on that disabled flag), not a Play/Download-click network-layer
  // watcher the way ElevenLabs needs one - so this file, unlike
  // content-elevenlabs-network.js, does NOT implement blob-URL/createObjectURL
  // download-click detection at all. If proactive fetch ever turns out to
  // miss real captures in practice, that click-detection layer is the next
  // thing to add here, following content-elevenlabs-network.js's own pattern
  // as a template - deliberately left out for now rather than shipped
  // speculatively.
  const SOURCE = 'rmw-suno-network-telemetry';
  const MAX_TEXT_LENGTH = 500000;
  // Exact match only (not a wildcard/prefix pattern) - see this file's header
  // comment for why: only this one literal host has ever been confirmed, and
  // Suno's naming convention isn't assumed to generalize the way ElevenLabs'
  // regional "api.<region>.elevenlabs.io" pattern does.
  const API_HOST = 'studio-api-prod.suno.com';

  function isSunoApiHost(url) {
    try {
      return new URL(url, location.href).hostname.toLowerCase() === API_HOST;
    } catch {
      return false;
    }
  }

  function shouldInspectUrl(url) {
    return isSunoApiHost(url);
  }

  // Confirmed real bug (2026-08-18): POST /api/generate/v2-web/ (the
  // generate-submission endpoint noted as unconfirmed-shape in this file's
  // header) returns its OWN clip-shaped placeholder object with a UNIQUE
  // `id` that is NEVER the same identity as the real clip(s) that
  // subsequently appear in /api/feed/v3 - carries no `batch_index`/`title`
  // either, unlike a real feed row. Capturing it created a permanent,
  // audio-less duplicate generation alongside the real one(s) every single
  // time - same failure class as ElevenLabs Music's "chat created before
  // song" bug, just from a different endpoint. /api/feed/v3 is the
  // confirmed canonical, reliable source (live capture + accelerated polls
  // + reconciliation walker all already cover it), so the fix is simply to
  // never treat this endpoint's response as a capturable clip row at all -
  // still logged via logUnrecognizedShapeIfPromising for visibility, just
  // never posted as a generation.
  const NON_CANONICAL_CLIP_SOURCE_RE = /\/api\/generate\//i;

  function isCanonicalClipSourceUrl(url) {
    try {
      return !NON_CANONICAL_CLIP_SOURCE_RE.test(new URL(url, location.href).pathname);
    } catch {
      return true;
    }
  }

  function parseJson(text) {
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  }

  // Confirmed real shape (2026-08-17): a candidate clip row requires both
  // `id` and `created_at` present, flat/top-level - no nested-wrapper split
  // like ElevenLabs Music's chat/song, so no flatten-through-nesting logic is
  // needed here at all.
  function looksLikeSunoClipRow(candidate) {
    if (!candidate || typeof candidate !== 'object') return false;
    if (candidate.id === undefined || candidate.id === null || candidate.id === '') return false;
    if (candidate.created_at === undefined || candidate.created_at === null || candidate.created_at === '') return false;
    return true;
  }

  // Confirmed envelope: { clips: [...], has_more }. A bare array or a single
  // bare object matching the shape is also handled defensively, same
  // posture as every other capture file in this extension, even though only
  // the `clips` envelope has actually been observed.
  function extractSunoClipRows(json) {
    if (!json || typeof json !== 'object') return [];
    if (Array.isArray(json)) return json.filter(looksLikeSunoClipRow);
    if (looksLikeSunoClipRow(json)) return [json];
    if (Array.isArray(json.clips)) return json.clips.filter(looksLikeSunoClipRow);
    return [];
  }

  // Diagnostic-only, never used for actual capture decisions - same "shape
  // learner" precedent as content-elevenlabs-network.js's identical
  // function. Useful if Suno ever adds a second endpoint/envelope shape this
  // file doesn't yet recognize.
  function logUnrecognizedShapeIfPromising(url, json, text) {
    if (!json || typeof json !== 'object') return;
    const haystack = text.length <= 4000 ? text : text.slice(0, 4000);
    if (!/clip|audio_url|media_urls|gpt_description_prompt|action_config/i.test(haystack)) return;
    console.debug('[RMW Suno Network] unrecognized but clip-like response - please report this shape', {
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
        type: 'SUNO_NETWORK_GENERATION',
        payload: {
          rows,
          sourceUrl: `${sourceUrl || ''}`.slice(0, 2000),
          transport: transport || 'http',
          capturedAt: Date.now(),
        },
      }, location.origin);
    } catch {}
  }

  function inspectResponseText(url, text, transport) {
    if (!text || text.length > MAX_TEXT_LENGTH) return;
    const json = parseJson(text);
    const rows = isCanonicalClipSourceUrl(url) ? extractSunoClipRows(json) : [];
    if (rows.length) {
      console.debug('[RMW Suno Network] found clip row(s) in response', { url, count: rows.length, transport });
      postGenerationRows(rows, url, transport);
    } else {
      logUnrecognizedShapeIfPromising(url, json, text);
    }
  }

  // ---- AUTH TOKEN RELAY ----
  // Same pattern as content-elevenlabs-network.js's "AUTH TOKEN RELAY"
  // section: this content script has no ambient access to the page's own
  // per-request auth (computed/attached by the page's own JS), but it CAN
  // observe it on any real outgoing request the page makes to the API host,
  // and relays the most recently observed set to the isolated world so its
  // reconciliation walker can reuse it for its own authenticated calls.
  //
  // Suno's real captured request also carried `browser-token` and
  // `device-id` custom headers that ElevenLabs' equivalent request never
  // had - UNCONFIRMED whether the reconciliation walker's own re-issued
  // request will be accepted without them, so both are relayed alongside
  // Authorization on the theory that omitting a header the real page always
  // sends is a more likely failure mode than including one that turns out to
  // be unnecessary. content-suno-capture.js logs clearly (status + response
  // body) if its own request fails despite having these, per this file's
  // "don't fail silently" convention.
  let sunoLastRelayedAuth = null; // {apiHost, authorization, browserToken, deviceId} | null

  function maybeCaptureAndRelayAuth(url, authorization, browserToken, deviceId) {
    if (!authorization && !browserToken && !deviceId) return;
    try {
      const hostname = new URL(url, location.href).hostname.toLowerCase();
      if (hostname !== API_HOST) return;
      const next = { apiHost: hostname, authorization, browserToken, deviceId };
      if (
        sunoLastRelayedAuth
        && sunoLastRelayedAuth.apiHost === next.apiHost
        && sunoLastRelayedAuth.authorization === next.authorization
        && sunoLastRelayedAuth.browserToken === next.browserToken
        && sunoLastRelayedAuth.deviceId === next.deviceId
      ) {
        return; // unchanged - nothing new to relay
      }
      sunoLastRelayedAuth = next;
      // Never logs the token/header values themselves - live credentials,
      // not diagnostic data safe to leave in devtools history.
      console.debug('[RMW Suno Network] observed API auth, relaying to isolated world', {
        apiHost: hostname, hasAuthorization: Boolean(authorization), hasBrowserToken: Boolean(browserToken), hasDeviceId: Boolean(deviceId),
      });
      window.postMessage({
        source: SOURCE,
        type: 'SUNO_NETWORK_AUTH_TOKEN',
        payload: next,
      }, location.origin);
    } catch {}
  }

  // fetch()'s init.headers can be a Headers instance, a plain object, or an
  // array of [key, value] pairs - normalize all three, same helper shape as
  // content-elevenlabs-network.js's extractAuthorizationHeader, generalized
  // to any header name since this file also needs browser-token/device-id.
  function extractHeader(headers, name) {
    if (!headers) return '';
    const lowerName = name.toLowerCase();
    try {
      if (typeof headers.get === 'function') {
        return headers.get(name) || headers.get(lowerName) || '';
      }
      if (Array.isArray(headers)) {
        const pair = headers.find(([key]) => `${key}`.toLowerCase() === lowerName);
        return pair ? `${pair[1] || ''}` : '';
      }
      const key = Object.keys(headers).find((candidate) => candidate.toLowerCase() === lowerName);
      return key ? `${headers[key] || ''}` : '';
    } catch {
      return '';
    }
  }

  // ---- fetch ----
  const rawFetch = window.fetch;
  if (typeof rawFetch === 'function') {
    window.fetch = function rmwSunoFetch(input, init) {
      const url = typeof input === 'string' ? input : (input && input.url) || '';
      try {
        // Unconditional (not gated by shouldInspectUrl below) - needs to see
        // every request to the real API host, not just the subset that also
        // parses as a recognizable clip response.
        const headers = (init && init.headers) || (input && input.headers);
        maybeCaptureAndRelayAuth(
          url,
          extractHeader(headers, 'authorization'),
          extractHeader(headers, 'browser-token'),
          extractHeader(headers, 'device-id')
        );
      } catch {}
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

    OriginalXHR.prototype.open = function rmwSunoXhrOpen(method, url, ...rest) {
      this.__rmwSunoUrl = url;
      return rawOpen.call(this, method, url, ...rest);
    };

    OriginalXHR.prototype.setRequestHeader = function rmwSunoSetRequestHeader(name, value) {
      const lowerName = `${name}`.toLowerCase();
      if (lowerName === 'authorization') this.__rmwSunoAuthorization = value;
      else if (lowerName === 'browser-token') this.__rmwSunoBrowserToken = value;
      else if (lowerName === 'device-id') this.__rmwSunoDeviceId = value;
      return rawSetRequestHeader.call(this, name, value);
    };

    OriginalXHR.prototype.send = function rmwSunoXhrSend(...args) {
      const url = this.__rmwSunoUrl || '';
      const xhr = this;
      try {
        maybeCaptureAndRelayAuth(url, this.__rmwSunoAuthorization, this.__rmwSunoBrowserToken, this.__rmwSunoDeviceId);
      } catch {}
      if (shouldInspectUrl(url)) {
        xhr.addEventListener('loadend', function () {
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
})();
