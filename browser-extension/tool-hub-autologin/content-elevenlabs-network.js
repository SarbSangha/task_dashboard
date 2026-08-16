(function installRmwElevenlabsNetworkTelemetry() {
  if (window.__rmwElevenlabsNetworkTelemetryInstalled) return;
  window.__rmwElevenlabsNetworkTelemetryInstalled = true;

  // MAIN-world network interceptor for ElevenLabs (elevenlabs.io) - modeled
  // on content-flow-network.js's philosophy (observe real traffic, classify
  // by body SHAPE, never assume a URL contract is permanent), but same-origin
  // throughout (unlike Flow's cross-host aisandbox-pa.googleapis.com split),
  // so no extra host_permissions are needed beyond what's already granted
  // for elevenlabs.io/*.elevenlabs.io.
  //
  // Unlike Flow/Freepik, ElevenLabs has exactly ONE confirmed piece of real
  // traffic: a `history?page_size=20&source=TTS&sort_direction=desc` request
  // (URL only - the response body was never captured in a HAR). No
  // generate-submission endpoint, no confirmed field names, no confirmed
  // `source` enum beyond "TTS" - see
  // browser-extension/tool-hub-autologin's sibling capture files and
  // providers/elevenlabs/CAPTURE_CONTRACT.md (backend side, built in
  // parallel) for the full list of open questions this file exists to help
  // close. Every gate below is deliberately loose/defensive as a result:
  // shape-based, OR'd across several candidate field names, never requiring
  // one exact schema.
  //
  // This file is PURELY OBSERVATIONAL - no request-holding/gating here,
  // unlike Flow's flowMedia:batchGenerateImages gate. There is no confirmed
  // generate endpoint to gate on yet, and blocking the wrong request would
  // be strictly worse than not gating at all. See content-elevenlabs-
  // capture.js for the click-arm + reconciliation-walker design this
  // feeds into instead (the same shape Envato ships on).
  //
  // AUDIO DELIVERY (confirmed from real captured traffic, 2026-08-13, twice):
  // the history row carries no downloadable audio URL at all - just metadata
  // (text/voice_id/model_id/content_type/state/...). First pass wrongly
  // assumed a GET .../history/{id}/audio path (real, live, 401s without auth
  // - but never actually the one the web app calls for playback/download).
  // Real DevTools capture corrected this: the page's Play/Download both hit
  // an XHR literally named `download` (preceded by a CORS preflight, i.e. a
  // non-simple/POST request) - matching ElevenLabs' documented bulk
  // `POST /v1/history/download` endpoint, which takes `history_item_id(s)`
  // in the JSON REQUEST BODY, not the URL. So this file has to read BOTH
  // sides of a matching call: the outgoing body (for the id) and the
  // incoming response (for the bytes) - see extractHistoryItemIdFromRequestBody
  // below. The URL-path extraction (extractHistoryItemIdFromUrl) is kept as
  // a fallback in case a singular `/history/{id}/download`-style path also
  // exists for some surface - cheap insurance, not dead code.
  //
  // Either way, this backend can never mirror the audio itself (no browser
  // session/token) - see providers/elevenlabs/router.py's POST
  // /capture/audio, which this feeds: the browser pushes the actual bytes it
  // already legitimately received, instead of the backend trying (and
  // failing) to pull them independently.
  const SOURCE = 'rmw-elevenlabs-network-telemetry';
  const MAX_TEXT_LENGTH = 500000;
  const MAX_AUDIO_BYTES = 25 * 1024 * 1024; // mirrors the backend's own cap - guards against a pathological payload
  const HOST_RE = /(^|\.)elevenlabs\.io$/i;
  const PATH_HINT_RE = /\/history/i;
  const AUDIO_CONTENT_TYPE_RE = /^audio\//i;
  // Matches the real backend host (api.us.elevenlabs.io, confirmed live -
  // regional, so not hardcoded to ".us." specifically) as distinct from the
  // page's own host (elevenlabs.io/app.elevenlabs.io/etc, no "api." prefix).
  // See "AUTH TOKEN RELAY" below for why this distinction matters.
  const API_HOST_RE = /^api(\.[a-z0-9-]+)?\.elevenlabs\.io$/i;
  // Fallback only (see "AUDIO DELIVERY" above) - the confirmed real call
  // (`POST /v1/history/download`) carries no id in the URL at all.
  const HISTORY_AUDIO_PATH_RE = /\/history\/([^/?#]+)\/(?:audio|download)(?:[/?#]|$)/i;
  // Firestore long-poll channel - proprietary wire format, not JSON, never
  // worth even attempting to JSON.parse it.
  const FIRESTORE_CHANNEL_RE = /channel\?VER=/i;
  // Next.js RSC page-shell prefetches (`text-to-speech?_rsc=...`,
  // `sound-effects?_rsc=...`, `files?_rsc=...`, etc.) - confirmed NOT
  // generation data, just React server-component payloads for page
  // navigation. Excluded outright rather than shape-gated, since their
  // response bodies are a different serialization entirely (React Flight),
  // not plain JSON, and would otherwise waste a parse attempt on every nav.
  const RSC_PREFETCH_RE = /[?&]_rsc=/i;
  // Deliberately does NOT exclude .mp3/.wav (unlike a typical media-asset
  // filter list) - real audio responses are now a first-class capture
  // target, not noise. Everything else here is still genuinely irrelevant.
  const EXCLUDED_PATH_RE = /\.(?:png|jpe?g|webp|gif|avif|svg|mp4|webm|css|woff2?|ttf|ico|js|json\.map)(?:[?#]|$)/i;

  function isElevenlabsHost(url) {
    try {
      return HOST_RE.test(new URL(url, location.href).hostname);
    } catch {
      return false;
    }
  }

  function isHardExcludedUrl(url) {
    return FIRESTORE_CHANNEL_RE.test(url) || RSC_PREFETCH_RE.test(url) || EXCLUDED_PATH_RE.test(url);
  }

  function shouldInspectUrl(url) {
    if (!isElevenlabsHost(url)) return false;
    if (isHardExcludedUrl(url)) return false;
    // Soft gate only - the body-shape check below
    // (looksLikeElevenlabsHistoryRow) is the real, precise gate. PATH_HINT_RE
    // just avoids wasting a JSON.parse on every single same-origin call
    // (auth/billing/other elevenlabs.io endpoints share this host too).
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

  // Defensive OR-gate over several candidate identity fields plus a
  // timestamp-like field - never requires one exact field set, since the
  // real response shape is unconfirmed (see this file's top comment).
  function looksLikeElevenlabsHistoryRow(candidate) {
    if (!candidate || typeof candidate !== 'object') return false;
    const hasIdentity = candidate.history_item_id !== undefined
      || candidate.id !== undefined
      || candidate.generation_id !== undefined;
    if (!hasIdentity) return false;
    const hasTimestamp = candidate.date_unix !== undefined
      || candidate.created_at_unix !== undefined
      || candidate.date !== undefined
      || candidate.created_at !== undefined;
    return hasTimestamp;
  }

  // Handles: a bare array of matching objects, {history:[...]}, {items:[...]},
  // or a single bare object matching the shape.
  function extractHistoryRows(json) {
    if (!json || typeof json !== 'object') return [];
    if (Array.isArray(json)) {
      return json.filter(looksLikeElevenlabsHistoryRow);
    }
    if (looksLikeElevenlabsHistoryRow(json)) return [json];
    if (Array.isArray(json.history)) {
      return json.history.filter(looksLikeElevenlabsHistoryRow);
    }
    if (Array.isArray(json.items)) {
      return json.items.filter(looksLikeElevenlabsHistoryRow);
    }
    return [];
  }

  // Diagnostic-only, never used for actual capture decisions - same "shape
  // learner" precedent as content-flow-network.js's identical function.
  // Particularly useful here since the real history response shape is
  // entirely unconfirmed: this is what surfaces it the first time someone
  // generates something with the extension active.
  function logUnrecognizedShapeIfPromising(url, json, text) {
    if (!json || typeof json !== 'object') return;
    const haystack = text.length <= 4000 ? text : text.slice(0, 4000);
    if (!/history_item|voice_id|generation_id|audio/i.test(haystack)) return;
    console.debug('[RMW ElevenLabs Network] unrecognized but history-like response - please report this shape', {
      url,
      topLevelKeys: Object.keys(json),
      snippet: haystack.length > 1500 ? `${haystack.slice(0, 1500)}…` : haystack,
    });
  }

  // Diagnostic-only loose POST-response sniffer - purely to help a human
  // discover the real generate-endpoint shape later, since no
  // generate-submission endpoint has ever been confirmed for ElevenLabs.
  // NEVER feeds into capture.
  function maybeLogPossibleGenerateResponse(url, method, json, text) {
    if (`${method || ''}`.toUpperCase() !== 'POST') return;
    if (!json || typeof json !== 'object') return;
    const haystack = text.length <= 4000 ? text : text.slice(0, 4000);
    if (!/audio_base64|history_item_id|voice_id/i.test(haystack)) return;
    console.debug('[RMW ElevenLabs Network] possible generate-response — please report this shape', {
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
        type: 'ELEVENLABS_NETWORK_GENERATION',
        payload: {
          rows,
          sourceUrl: `${sourceUrl || ''}`.slice(0, 2000),
          transport: transport || 'http',
          capturedAt: Date.now(),
        },
      }, location.origin);
    } catch {}
  }

  function inspectResponseText(url, method, text, transport) {
    if (!text || text.length > MAX_TEXT_LENGTH) return;
    const json = parseJson(text);
    const rows = extractHistoryRows(json);
    if (rows.length) {
      console.debug('[RMW ElevenLabs Network] found history row(s) in response', { url, count: rows.length, transport });
      postGenerationRows(rows, url, transport);
    } else {
      logUnrecognizedShapeIfPromising(url, json, text);
    }
    maybeLogPossibleGenerateResponse(url, method, json, text);
  }

  // ---- AUTH TOKEN RELAY ----
  // Reported bug, root-caused 2026-08-13: content-elevenlabs-capture.js's own
  // reconciliation walker and its (now-removed) same-origin proactive audio
  // fetch both silently failed this whole time - both assumed
  // `${location.origin}/v1/...` (i.e. elevenlabs.io itself) proxies to the
  // real API over the ordinary session cookie. Confirmed false: that path
  // returns Next.js's plain HTML fallback page (content-type text/html),
  // not JSON/audio. Real captured traffic shows the actual API lives at a
  // separate, regional host (api.us.elevenlabs.io - confirmed via a live
  // DevTools capture of the page's own request) and authenticates via a
  // manually-attached `Authorization: Bearer <JWT>` header, not a cookie at
  // all - explaining both the same-origin failure AND the earlier wide-open-
  // CORS finding (a wildcard/specific-origin ACAO is incompatible with
  // credentialed/cookie requests; header-based auth has no such
  // restriction).
  //
  // This content script has no ambient access to that header (it's computed
  // and attached by the page's own JS per-request), but it CAN observe it on
  // any real outgoing request the page makes - so it captures and relays the
  // most recently observed {apiHost, authorization} pair to the isolated
  // world, which can then reuse it to make its own authenticated calls to
  // the real API (reconciliation walker, proactive audio fetch) instead of
  // guessing at a same-origin proxy that doesn't exist. Relayed only on
  // change (not on every single request) to avoid needless cross-world
  // traffic - Firebase JWTs are long-lived enough (~1hr TTL observed) that
  // this fires rarely once a session is warm.
  let elevenlabsLastRelayedAuth = null; // {apiHost, authorization} | null

  function maybeCaptureAndRelayAuth(url, authorization) {
    if (!authorization) return;
    try {
      const hostname = new URL(url, location.href).hostname;
      if (!API_HOST_RE.test(hostname)) return;
      if (elevenlabsLastRelayedAuth
        && elevenlabsLastRelayedAuth.apiHost === hostname
        && elevenlabsLastRelayedAuth.authorization === authorization) {
        return; // unchanged - nothing new to relay
      }
      elevenlabsLastRelayedAuth = { apiHost: hostname, authorization };
      // Never logs the token value itself (even truncated) - this is a live
      // bearer credential, not diagnostic data safe to leave in devtools
      // history.
      console.debug('[RMW ElevenLabs Network] observed API auth token, relaying to isolated world', { apiHost: hostname });
      window.postMessage({
        source: SOURCE,
        type: 'ELEVENLABS_NETWORK_AUTH_TOKEN',
        payload: { apiHost: hostname, authorization },
      }, location.origin);
    } catch {}
  }

  // fetch()'s init.headers can be a Headers instance, a plain object, or an
  // array of [key, value] pairs - normalize all three.
  function extractAuthorizationHeader(headers) {
    if (!headers) return '';
    try {
      if (typeof headers.get === 'function') {
        return headers.get('authorization') || headers.get('Authorization') || '';
      }
      if (Array.isArray(headers)) {
        const pair = headers.find(([key]) => `${key}`.toLowerCase() === 'authorization');
        return pair ? `${pair[1] || ''}` : '';
      }
      const key = Object.keys(headers).find((candidate) => candidate.toLowerCase() === 'authorization');
      return key ? `${headers[key] || ''}` : '';
    } catch {
      return '';
    }
  }

  // ---- Audio asset capture ----
  // See this file's header comment ("AUDIO DELIVERY") for why this exists:
  // the history row has no downloadable URL, so the only way to ever get a
  // playable copy of a generation is to observe the real, already-
  // authenticated audio response the page itself receives when the user
  // plays/downloads a clip in ElevenLabs' own UI, and push those exact bytes
  // to our backend (content-elevenlabs-capture.js -> background -> POST
  // /api/providers/elevenlabs/capture/audio).

  function extractHistoryItemIdFromUrl(url) {
    try {
      const path = new URL(url, location.href).pathname;
      const match = HISTORY_AUDIO_PATH_RE.exec(path);
      return match ? decodeURIComponent(match[1]) : '';
    } catch {
      return '';
    }
  }

  // The confirmed real call (POST /v1/history/download) carries the id in
  // the JSON request body, not the URL - see this file's header comment.
  // `requestBody` is whatever was passed to fetch()'s init.body or
  // XHR.send() - a plain string in every case actually observed so far
  // (ElevenLabs' own web app JSON-stringifies before sending); a
  // FormData/Blob/ReadableStream body is left unhandled (returns '') rather
  // than guessed at, since none has been seen for this call.
  function extractHistoryItemIdFromRequestBody(requestBody) {
    if (typeof requestBody !== 'string' || !requestBody) return '';
    try {
      const json = JSON.parse(requestBody);
      if (typeof json?.history_item_id === 'string' && json.history_item_id) {
        return json.history_item_id;
      }
      if (Array.isArray(json?.history_item_ids) && json.history_item_ids.length === 1) {
        // Bulk-download shape with exactly one id - safe to attribute the
        // single returned blob to it. More than one id in the same call
        // means the response is (or might be) a multi-item zip, which can't
        // be safely attributed to any single generation without unzipping -
        // deliberately not attempted here, falls through to the
        // unrecognized-shape diagnostic instead.
        return `${json.history_item_ids[0] || ''}`;
      }
    } catch {}
    return '';
  }

  // Reported bug: Play (on an already-generated history item) never
  // triggers a capture, only Download does - even across repeated Play
  // clicks. Root cause: ElevenLabs' web app appears to either replay a
  // client-side-cached blob on Play (nothing to intercept at all) or reuse
  // the same POST /v1/text-to-speech/{voice_id}/stream endpoint Generate
  // itself uses to actually PRODUCE the first playable audio - and that
  // endpoint carries no history_item_id in its URL or JSON body.
  //
  // A response-header guess (`history-item-id` etc.) was tried next.
  // CONFIRMED DEAD, not just "didn't pan out" - live testing produced
  // `Refused to get unsafe header "..."` for every candidate name: custom
  // response headers are invisible to page/content-script JS entirely
  // unless the server explicitly lists them in
  // `Access-Control-Expose-Headers` (it doesn't), a hard browser CORS
  // restriction with no workaround, not an account/session-specific gap.
  // Removed rather than left as permanently-failing dead code + console
  // noise. Rather than keep guessing at a fourth deterministic signal, this
  // now falls through to postUnattributedAudioCapture below - a proactive
  // capture-then-correlate approach instead of a purely reactive one, since
  // no single response is ever going to hand over its own id this way.

  // Chunked to avoid a single String.fromCharCode(...spread) call choking on
  // a multi-MB buffer (some engines cap the argument count a function can be
  // called with via spread/apply well below what a longer Music/TTS clip's
  // byte length would need).
  function arrayBufferToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    const CHUNK_SIZE = 0x8000;
    let binary = '';
    for (let i = 0; i < bytes.length; i += CHUNK_SIZE) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK_SIZE));
    }
    return btoa(binary);
  }

  // isDownload is always true here - postAudioCapture is only ever reached
  // when a historyItemId was deterministically extracted (from the URL or,
  // per this file's "AUDIO DELIVERY" header comment, the confirmed real
  // Download request body shape), and per that same comment Play - even
  // repeated - never carries an id at all. So a call reaching this function
  // is, by construction, a real Download click, never a Play. Threaded
  // through to content-elevenlabs-capture.js -> background -> POST
  // /capture/audio's is_download flag, which marks the generation row's
  // downloaded_at for the dashboard's Downloads view.
  function postAudioCapture(historyItemId, contentType, arrayBuffer, sourceUrl) {
    if (!historyItemId || !arrayBuffer || !arrayBuffer.byteLength) return;
    if (arrayBuffer.byteLength > MAX_AUDIO_BYTES) {
      console.debug('[RMW ElevenLabs Network] audio response too large, skipping capture', {
        url: sourceUrl, bytes: arrayBuffer.byteLength,
      });
      return;
    }
    try {
      const audioBase64 = arrayBufferToBase64(arrayBuffer);
      console.debug('[RMW ElevenLabs Network] captured audio response', {
        historyItemId, contentType, bytes: arrayBuffer.byteLength,
      });
      window.postMessage({
        source: SOURCE,
        type: 'ELEVENLABS_NETWORK_AUDIO',
        payload: {
          historyItemId,
          contentType: contentType || 'audio/mpeg',
          audioBase64,
          sourceUrl: `${sourceUrl || ''}`.slice(0, 2000),
          capturedAt: Date.now(),
          isDownload: true,
        },
      }, location.origin);
    } catch (error) {
      console.debug('[RMW ElevenLabs Network] failed to encode/post captured audio', error);
    }
  }

  // Neither URL, headers, nor a deterministic id source ever panned out for
  // Play (confirmed live, 2026-08-13: Download reliably captures via the
  // request-body path; Play - even repeated - never does, and the header
  // guess didn't pan out either). Rather than keep guessing at a fourth
  // deterministic signal, this is now PROACTIVE instead of purely reactive:
  // capture the bytes regardless, and hand them to
  // content-elevenlabs-capture.js as "unattributed" - it retroactively
  // correlates them against whichever history row shows up next during the
  // same armed Generate window (see its own "Audio correlation" comment).
  // This still logs every response header too (not just the ones this file
  // already checks), in case a real deterministic id source is ever found
  // and this correlation step can be retired as unnecessary.
  function postUnattributedAudioCapture(contentType, arrayBuffer, sourceUrl, allHeadersText) {
    if (!arrayBuffer || !arrayBuffer.byteLength || arrayBuffer.byteLength > MAX_AUDIO_BYTES) return;
    try {
      const audioBase64 = arrayBufferToBase64(arrayBuffer);
      console.debug('[RMW ElevenLabs Network] captured unattributed audio response - will attempt correlation', {
        contentType, bytes: arrayBuffer.byteLength, url: sourceUrl, headers: allHeadersText || '(unavailable)',
      });
      window.postMessage({
        source: SOURCE,
        type: 'ELEVENLABS_NETWORK_AUDIO_UNATTRIBUTED',
        payload: {
          contentType: contentType || 'audio/mpeg',
          audioBase64,
          sourceUrl: `${sourceUrl || ''}`.slice(0, 2000),
          capturedAt: Date.now(),
          isDownload: false,
        },
      }, location.origin);
    } catch (error) {
      console.debug('[RMW ElevenLabs Network] failed to encode/post unattributed audio', error);
    }
  }

  // ---- Blob-URL Download capture ----
  // Reported live, 2026-08-14: Download served from an already-in-memory
  // cached Blob for a while after generating produces NO fetch/XHR call at
  // all - confirmed by a user downloading the same clip 3 times in a row
  // (3 real files saved to disk, Windows appending "(1)"/"(2)" to the
  // filename to avoid a collision) with only the 3rd click ever producing a
  // network request either of this file's fetch/XHR patches could see. The
  // first two clicks are invisible to every network-level signal this file
  // has, no matter how long anything downstream retries - this is the same
  // "client-side cache, nothing to intercept on the wire" behavior already
  // documented above for repeated Play, just also happening on Download for
  // a window after generation.
  //
  // ElevenLabs' web app almost certainly uses the standard browser pattern
  // for "save an already-fetched Blob to disk": URL.createObjectURL(blob) to
  // mint a blob: URL, assign it to a (possibly detached/hidden)
  // <a download="...">'s href, then .click() it - the browser's native
  // save-file handling takes over from there with no further JS or network
  // involvement. This section observes that pattern directly instead of the
  // network: remember every Blob handed to createObjectURL that's audio/*
  // (everything else is irrelevant and would just waste memory), then watch
  // for an <a download> with a blob: href actually being clicked (capturing-
  // phase listener sees both a real user click and a synthetic .click() the
  // same way) and, if its href matches a remembered audio Blob, treat the
  // click itself as the download signal.
  //
  // Unlike the fetch/XHR path this never gets a history_item_id
  // (createObjectURL carries no such metadata, same gap Play has always had)
  // - handed to content-elevenlabs-capture.js as unattributed-but-CONFIRMED-
  // download (isDownload: true), reusing the exact same buffer/correlate-
  // with-the-most-recent-row machinery Play's unattributed audio already
  // uses (see that file's bufferElevenlabsUnattributedAudio) - a successful
  // correlation there now marks the row's downloaded_at, a failed one just
  // means one fewer signal, never a false attribution (both directions only
  // ever attribute to a row this same tab already live-reported).
  const BLOB_URL_MAP_MAX_ENTRIES = 50; // audio blobs only - generous, but bounded so a page that never revokes doesn't leak unboundedly for the tab's lifetime
  const blobUrlToAudioBlob = new Map(); // blob: URL string -> Blob (audio/* only)
  const DATA_URI_AUDIO_RE = /^data:audio\/[^;]+;base64,/i;

  const rawCreateObjectURL = URL.createObjectURL;
  if (typeof rawCreateObjectURL === 'function') {
    URL.createObjectURL = function rmwElevenlabsCreateObjectURL(obj) {
      const url = rawCreateObjectURL.call(URL, obj);
      try {
        // DIAGNOSTIC (2026-08-14): the blob-URL Download capture below this
        // was added on the assumption ElevenLabs uses createObjectURL + an
        // <a download> - unconfirmed, since it still took multiple attempts
        // after this shipped. Logging every call (not just audio/*) so the
        // real mechanism shows up in the console the next time Download is
        // clicked, whatever it turns out to be - remove once confirmed.
        const isBlob = typeof Blob !== 'undefined' && obj instanceof Blob;
        console.debug('[RMW ElevenLabs Network] createObjectURL called', {
          url, isBlob, type: isBlob ? obj.type : typeof obj, size: isBlob ? obj.size : undefined,
        });
        // Confirmed live 2026-08-14: the real Download-prep Blob here is
        // tagged type:"arraybuffer" - not a real MIME type at all, just
        // whatever ElevenLabs' own code happened to pass as the Blob
        // constructor's `type` option - so the original audio/*-only filter
        // silently excluded the one Blob this whole path exists to catch.
        // Broadened to also accept the untyped/generic-binary shapes a
        // non-MIME-aware caller might use; image/text/etc (also observed
        // live: image/webp, image/png thumbnails) are still excluded, since
        // those are unambiguously not audio and would just waste map slots.
        const looksAudioLike = AUDIO_CONTENT_TYPE_RE.test(obj.type || '')
          || obj.type === '' || obj.type === 'arraybuffer' || obj.type === 'application/octet-stream';
        if (isBlob && looksAudioLike) {
          if (blobUrlToAudioBlob.size >= BLOB_URL_MAP_MAX_ENTRIES) {
            const oldestKey = blobUrlToAudioBlob.keys().next().value;
            if (oldestKey !== undefined) blobUrlToAudioBlob.delete(oldestKey);
          }
          blobUrlToAudioBlob.set(url, obj);
        }
      } catch {}
      return url;
    };
  }

  const rawRevokeObjectURL = URL.revokeObjectURL;
  if (typeof rawRevokeObjectURL === 'function') {
    URL.revokeObjectURL = function rmwElevenlabsRevokeObjectURL(url) {
      try { blobUrlToAudioBlob.delete(url); } catch {}
      return rawRevokeObjectURL.call(URL, url);
    };
  }

  function postBlobDownloadCapture(contentType, audioBase64) {
    console.debug('[RMW ElevenLabs Network] captured Download click audio', { contentType, base64Length: audioBase64.length });
    window.postMessage({
      source: SOURCE,
      type: 'ELEVENLABS_NETWORK_AUDIO_UNATTRIBUTED',
      payload: {
        contentType: contentType || 'audio/mpeg',
        audioBase64,
        sourceUrl: '(anchor download click)',
        capturedAt: Date.now(),
        isDownload: true,
      },
    }, location.origin);
  }

  function postBlobDownloadCaptureFromBlob(blob) {
    if (!blob || !blob.size || blob.size > MAX_AUDIO_BYTES) return;
    blob.arrayBuffer()
      .then((buffer) => postBlobDownloadCapture(blob.type, arrayBufferToBase64(buffer)))
      .catch((error) => console.debug('[RMW ElevenLabs Network] failed to read blob-URL download', error));
  }

  // data: URIs carry the payload inline - no createObjectURL/lookup needed,
  // just decode the base64 straight out of the href.
  function postBlobDownloadCaptureFromDataUri(href) {
    try {
      const commaIndex = href.indexOf(',');
      if (commaIndex === -1) return;
      const meta = href.slice(5, commaIndex); // strip "data:"
      const contentType = meta.split(';')[0] || 'audio/mpeg';
      const audioBase64 = href.slice(commaIndex + 1);
      if (audioBase64.length > MAX_AUDIO_BYTES * 1.4) return; // base64 overhead - generous upper bound
      postBlobDownloadCapture(contentType, audioBase64);
    } catch (error) {
      console.debug('[RMW ElevenLabs Network] failed to decode data-URI download', error);
    }
  }

  // DIAGNOSTIC (2026-08-14): logs EVERY click whose accessible text/aria-
  // label/title contains "download", regardless of tag or attributes, so the
  // real markup ElevenLabs uses is visible in the console next time someone
  // clicks it - the <a download>/blob:/data: handling below is a best guess
  // that hasn't been confirmed to match yet. Remove once confirmed.
  function elevenlabsDescribeClickTarget(element) {
    if (!element) return '';
    return [element.innerText, element.textContent, element.getAttribute?.('aria-label'), element.getAttribute?.('title')]
      .filter(Boolean).join(' ').trim().toLowerCase();
  }

  document.addEventListener('click', (event) => {
    try {
      const path = typeof event.composedPath === 'function' ? event.composedPath() : [];
      const candidates = (path.length ? path : [event.target]).filter((node) => node?.nodeType === Node.ELEMENT_NODE).slice(0, 6);
      for (const el of candidates) {
        const text = elevenlabsDescribeClickTarget(el);
        if (text.includes('download') && text.length <= 80) {
          console.debug('[RMW ElevenLabs Network] click on a "download"-labeled element', {
            tag: el.tagName, href: el.getAttribute?.('href') || null,
            outerHTML: `${el.outerHTML || ''}`.slice(0, 500),
          });
          break;
        }
      }
    } catch {}
  }, true);

  function maybeReportAnchorDownloadClick(anchor) {
    try {
      if (!anchor?.hasAttribute?.('download')) return;
      const href = anchor.getAttribute('href') || '';
      if (href.startsWith('blob:')) {
        const blob = blobUrlToAudioBlob.get(href);
        if (blob) postBlobDownloadCaptureFromBlob(blob);
        else console.debug('[RMW ElevenLabs Network] <a download> with an untracked blob: href', { href });
        return;
      }
      if (DATA_URI_AUDIO_RE.test(href)) {
        postBlobDownloadCaptureFromDataUri(href);
        return;
      }
      console.debug('[RMW ElevenLabs Network] <a download> clicked with neither a tracked blob: nor audio data: href', { href: href.slice(0, 80) });
    } catch {}
  }

  // Real user clicks on a still-attached <a download> - captures on the
  // document so it fires even if the page's own handler stops propagation.
  document.addEventListener('click', (event) => {
    const anchor = typeof event.target?.closest === 'function' ? event.target.closest('a[download]') : null;
    if (anchor) maybeReportAnchorDownloadClick(anchor);
  }, true);

  // Synthetic a.click() on a DETACHED anchor (a common "temp download link"
  // pattern - create, click, discard, never appended to the document at
  // all) never bubbles to the document listener above, since there's no
  // parent chain to propagate through - patching the method directly catches
  // it regardless of DOM attachment.
  const rawAnchorClick = HTMLAnchorElement.prototype.click;
  if (typeof rawAnchorClick === 'function') {
    HTMLAnchorElement.prototype.click = function rmwElevenlabsAnchorClick(...args) {
      maybeReportAnchorDownloadClick(this);
      return rawAnchorClick.apply(this, args);
    };
  }

  function maybeCaptureAudioResponse(url, contentType, getArrayBuffer, requestBody, allHeadersText) {
    if (!AUDIO_CONTENT_TYPE_RE.test(contentType || '')) return;
    // Priority order: URL path (cheapest, no ambiguity) -> request body (the
    // confirmed bulk-download/Download shape). Response headers were tried
    // and confirmed permanently unusable (see this file's header-guess
    // comment above) - removed, not just skipped.
    const historyItemId = extractHistoryItemIdFromUrl(url)
      || extractHistoryItemIdFromRequestBody(requestBody);
    if (historyItemId) {
      getArrayBuffer()
        .then((buffer) => postAudioCapture(historyItemId, contentType, buffer, url))
        .catch(() => {});
      return;
    }
    // No deterministic id anywhere on this response - proactive fallback,
    // see postUnattributedAudioCapture's own comment above.
    getArrayBuffer()
      .then((buffer) => postUnattributedAudioCapture(contentType, buffer, url, allHeadersText))
      .catch(() => {});
  }

  // ---- fetch ----
  const rawFetch = window.fetch;
  if (typeof rawFetch === 'function') {
    window.fetch = function rmwElevenlabsFetch(input, init) {
      const url = typeof input === 'string' ? input : (input && input.url) || '';
      const method = (init && init.method) || (input && input.method) || 'GET';
      try {
        // Unconditional (not gated by shouldInspectUrl below) - this needs
        // to see every request to the real API host, not just the subset
        // that also looks history-related.
        const authorization = extractAuthorizationHeader(init?.headers) || extractAuthorizationHeader(input?.headers);
        maybeCaptureAndRelayAuth(url, authorization);
      } catch {}
      const promise = rawFetch.apply(this, arguments);
      if (!shouldInspectUrl(url)) return promise;
      return promise.then((response) => {
        try {
          const contentType = `${response.headers?.get?.('content-type') || ''}`;
          if (/json/i.test(contentType)) {
            response.clone().text().then((text) => inspectResponseText(url, method, text, 'http')).catch(() => {});
          } else if (AUDIO_CONTENT_TYPE_RE.test(contentType)) {
            // response.clone() means this never interferes with however the
            // page itself consumes the original (blob URL for an <audio>
            // element, arrayBuffer for WebAudio, etc.) - same non-invasive
            // pattern the JSON branch above already uses. init.body is only
            // a plain string/URLSearchParams in the confirmed real call
            // (JSON-stringified) - a Request-object `input` with its own
            // body, or a stream/FormData body, is left unhandled (see
            // extractHistoryItemIdFromRequestBody's own comment).
            const requestBody = (init && typeof init.body === 'string') ? init.body : undefined;
            const allHeadersText = (() => {
              try {
                return Array.from(response.headers.entries()).map(([k, v]) => `${k}: ${v}`).join(' | ');
              } catch {
                return '';
              }
            })();
            maybeCaptureAudioResponse(url, contentType, () => response.clone().arrayBuffer(), requestBody, allHeadersText);
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

    OriginalXHR.prototype.open = function rmwElevenlabsXhrOpen(method, url, ...rest) {
      this.__rmwElevenlabsUrl = url;
      this.__rmwElevenlabsMethod = method;
      return rawOpen.call(this, method, url, ...rest);
    };

    OriginalXHR.prototype.setRequestHeader = function rmwElevenlabsSetRequestHeader(name, value) {
      if (`${name}`.toLowerCase() === 'authorization') {
        this.__rmwElevenlabsAuthorization = value;
      }
      return rawSetRequestHeader.call(this, name, value);
    };

    OriginalXHR.prototype.send = function rmwElevenlabsXhrSend(...args) {
      const url = this.__rmwElevenlabsUrl || '';
      const method = this.__rmwElevenlabsMethod || 'GET';
      // args[0] is XHR.send()'s optional body - a plain string in the
      // confirmed real call (JSON-stringified); anything else (FormData,
      // Blob, ArrayBuffer, URLSearchParams, ReadableStream) is left
      // unhandled, same posture as the fetch branch below.
      const requestBody = typeof args[0] === 'string' ? args[0] : undefined;
      const xhr = this;
      try {
        maybeCaptureAndRelayAuth(url, this.__rmwElevenlabsAuthorization);
      } catch {}
      if (shouldInspectUrl(url)) {
        xhr.addEventListener('loadend', function () {
          try {
            if (this.status < 200 || this.status >= 300) return;
            const contentType = `${(this.getResponseHeader && this.getResponseHeader('content-type')) || ''}`;
            if (AUDIO_CONTENT_TYPE_RE.test(contentType)) {
              // Only 'blob'/'arraybuffer' carry recoverable binary bytes here.
              // A page that left responseType at '' ('text') for an audio
              // response would have already had it UTF-8-decoded (lossy/
              // corrupting for binary data) by the time this fires - nothing
              // salvageable, so this is deliberately skipped rather than
              // attempting a lossy reinterpretation.
              const responseType = this.responseType;
              // getAllResponseHeaders() only ever returns safe-listed/
              // explicitly-exposed headers - unlike getResponseHeader() with
              // a specific unlisted name, it never logs a "Refused to get
              // unsafe header" warning, so this diagnostic dump is safe to
              // keep even though the per-name lookup it used to feed
              // (extractHistoryItemIdFromHeaders) was removed as dead code.
              const allHeadersText = (this.getAllResponseHeaders && this.getAllResponseHeaders()) || '';
              if (responseType === 'arraybuffer' && this.response) {
                maybeCaptureAudioResponse(url, contentType, () => Promise.resolve(this.response), requestBody, allHeadersText);
              } else if (responseType === 'blob' && this.response) {
                maybeCaptureAudioResponse(url, contentType, () => this.response.arrayBuffer(), requestBody, allHeadersText);
              }
              return;
            }
            // responseText throws if responseType isn't '' or 'text', so
            // branch on it rather than accessing it unconditionally - same
            // guard content-flow-network.js uses.
            const responseType = this.responseType;
            if (responseType === '' || responseType === 'text') {
              if (typeof this.responseText === 'string') inspectResponseText(url, method, this.responseText, 'http');
            } else if (responseType === 'json') {
              if (this.response != null) inspectResponseText(url, method, JSON.stringify(this.response), 'http');
            }
          } catch {}
        });
      }
      return rawSend.apply(this, args);
    };
  }
})();
