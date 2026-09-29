(function installRmwSunoNetworkTelemetry() {
  if (window.__rmwSunoNetworkTelemetryInstalled) return;
  window.__rmwSunoNetworkTelemetryInstalled = true;

  // Confirmed real gap (2026-09-29): this content script's manifest.json
  // entry had no all_frames:true (unlike content-chatgpt/-figma/-google's
  // identical MAIN-world entries, which do), so it only ever ran in the
  // top-level suno.com document - never in an iframe, if Suno's actual
  // player happens to live in one. That would explain every one of this
  // file's playback hooks (createObjectURL, decodeAudioData, appendBuffer,
  // the 'play' listener) staying silent through a real, audible Play at
  // once, better than any single-hook theory. all_frames:true is now set;
  // this log's frame URL/top-ness is what actually proves or disproves the
  // theory once a real Play is repeated - multiple distinct log lines from
  // different frameUrl values means the player really is in a sub-frame.
  console.debug('[RMW Suno Network] telemetry installed in a frame', {
    frameUrl: location.href, isTopFrame: window === window.top,
  });

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

  // ---- Real playback path diagnostic (2026-09-29) ----
  // Confirmed real, repeatedly, from content-suno-capture.js's proactive
  // fetch: sunoCloudfrontFallbackUrl's guessed https://d2lwuy8qc234o3.
  // cloudfront.net/1/clip/<id>.m4a asset returns stable, repeatable,
  // undecodable bytes for some clips even once the row is genuinely ready -
  // that URL was only ever a guess from a single past DevTools capture (see
  // that file's "sunoCloudfrontFallbackUrl" comment), never independently
  // confirmed playable the way cdn1.suno.ai was. Retrying it harder (see
  // that file's readyButUnconfirmed re-qualification) does not help when the
  // asset at that URL is simply never going to decode.
  //
  // But the song DOES play in Suno's own UI - so the browser gets real bytes
  // from SOMEWHERE when the page itself plays it. This section observes that
  // real path directly instead of guessing a fourth static URL pattern,
  // mirroring content-elevenlabs-network.js's createObjectURL Download-
  // capture section (that file's proven working precedent for "the page's
  // own JS hands real bytes to a Blob/blob: URL before the media element
  // ever sees them").
  //
  // DIAGNOSTIC-ONLY for now, deliberately, per this file's own established
  // convention (see logUnrecognizedShapeIfPromising above) - logs whatever
  // real mechanism shows up the next time a clip is actually played, rather
  // than guessing blind and risking a repeat of the CloudFront-guess
  // failure. Once a real Play confirms the shape (blob: URL, a different
  // authenticated CDN host, MediaSource/appendBuffer chunks, or something
  // else), wire the confirmed path up to actually post captured bytes the
  // same way SUNO_NETWORK_GENERATION already does for rows.
  const sunoBlobUrlDiagnostics = new Map(); // blob: URL -> {type, size} (bounded, audio-like only)
  const SUNO_BLOB_DIAGNOSTIC_MAX_ENTRIES = 50;
  const SUNO_AUDIO_LIKE_BLOB_TYPE_RE = /^(audio\/|application\/octet-stream$|^$)/i;

  const rawCreateObjectURL = URL.createObjectURL;
  if (typeof rawCreateObjectURL === 'function') {
    URL.createObjectURL = function rmwSunoCreateObjectURL(obj) {
      const url = rawCreateObjectURL.call(URL, obj);
      try {
        const isBlob = typeof Blob !== 'undefined' && obj instanceof Blob;
        const isMediaSource = typeof MediaSource !== 'undefined' && obj instanceof MediaSource;
        if (isBlob && SUNO_AUDIO_LIKE_BLOB_TYPE_RE.test(obj.type || '')) {
          console.debug('[RMW Suno Network] createObjectURL called with an audio-like Blob - possible real playback source', {
            url, type: obj.type, size: obj.size,
          });
          if (sunoBlobUrlDiagnostics.size >= SUNO_BLOB_DIAGNOSTIC_MAX_ENTRIES) {
            const oldestKey = sunoBlobUrlDiagnostics.keys().next().value;
            if (oldestKey !== undefined) sunoBlobUrlDiagnostics.delete(oldestKey);
          }
          sunoBlobUrlDiagnostics.set(url, { type: obj.type, size: obj.size });
        } else if (isMediaSource) {
          // A MediaSource is NOT a Blob (obj instanceof Blob is false for
          // it), so the branch above silently misses this entirely - a
          // separate, deliberate check rather than widening that condition,
          // since MSE playback needs a different capture point below
          // (SourceBuffer.appendBuffer), not a Blob read.
          console.debug('[RMW Suno Network] createObjectURL called with a MediaSource - streaming (MSE) playback, watching appendBuffer', { url });
        }
      } catch {}
      return url;
    };
  }

  // MSE feeds the decoder in chunks via SourceBuffer.appendBuffer as they
  // arrive over the wire - this is the standard mechanism for a seekable,
  // waveform-scrubbing web audio player (SoundCloud-style), and unlike a
  // single decodeAudioData call or a whole-file Blob, would explain BOTH
  // previously-ruled-out symptoms at once: no single big fetch visible right
  // at click time (chunks can arrive earlier/incrementally) and no
  // createObjectURL(Blob) (MSE uses createObjectURL(mediaSource) instead,
  // now caught above). Each appended chunk is the real decoded-or-decodable
  // bytes the browser's own decoder consumes, wherever it originally came
  // from - the same rationale as the decodeAudioData hook, for the streaming
  // path instead of the single-shot path.
  // CONFIRMED CAPTURE PATH (2026-09-29, after every other candidate was ruled
  // out live): the chunks handed to appendBuffer are REAL, VALID, UNENCRYPTED
  // fragmented MP4 - the very first chunk is an `ftyp` init segment
  // (first8 0000001c66747970) and every chunk after it is a `moof` fragment
  // (first8 000006946d6f6f66), mimeType 'audio/mp4; codecs="opus"'. That is
  // exactly what the browser's own decoder consumes, so concatenating the
  // init segment + every following fragment IN ORDER reproduces a complete,
  // playable fMP4 file - no decryption, no key, and no knowledge of where the
  // bytes originally came from required.
  //
  // This matters because the CloudFront .m4a asset content-suno-capture.js
  // fetches is PROVEN ciphertext (independently re-downloaded and measured at
  // exactly 8.0 bits/byte Shannon entropy, zero container magic anywhere in
  // 4.9MB). Suno evidently fetches that same encrypted blob, decrypts it in
  // its own JS, and feeds the plaintext here in ~30KB pieces - which is why no
  // fetch/XHR with an audio content-type is ever observable either.
  //
  // TRADEOFF, deliberate and unavoidable: this only yields bytes for a clip
  // that is actually PLAYED in the tab, unlike the (broken) proactive fetch
  // which needed no interaction. A clip nobody plays produces nothing here.
  const SUNO_MSE_MAX_TOTAL_BYTES = 40 * 1024 * 1024; // generous ceiling for one song; guards against an unbounded live stream filling memory
  const SUNO_MSE_QUIET_FLUSH_MS = 4000; // no new chunk for this long => treat the song as fully buffered and flush

  // appendBuffer chunks carry no identity of their own, so the assembled
  // bytes need a clip id from somewhere else. Suno's own player reports what
  // it is playing to /playbar_state and /listen_milestone (both observed live
  // in the Network tab during playback) - watching those requests go past is
  // a direct read of the page's own "currently playing" state, rather than
  // guessing from the DOM or correlating by timing alone. Updated by
  // sunoNoteClipIdFromPlaybackTelemetry below, read when a SourceBuffer is
  // created and again on its first chunks (whichever lands first wins).
  let sunoCurrentlyPlayingClipId = '';
  const SUNO_UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
  const SUNO_PLAYBACK_TELEMETRY_RE = /(playbar_state|listen_milestone|listen_session)/i;

  function sunoNoteClipIdFromPlaybackTelemetry(url, body) {
    try {
      if (!SUNO_PLAYBACK_TELEMETRY_RE.test(`${url || ''}`)) return;
      // The clip id can ride in either the path/query or the JSON body -
      // both are searched, body first (more specific when present).
      const bodyText = typeof body === 'string' ? body : '';
      const match = (bodyText && bodyText.match(SUNO_UUID_RE)) || `${url || ''}`.match(SUNO_UUID_RE);
      if (!match) return;
      const clipId = match[0].toLowerCase();
      if (clipId === sunoCurrentlyPlayingClipId) return;
      sunoCurrentlyPlayingClipId = clipId;
      console.debug('[RMW Suno Network] now-playing clip id observed from playback telemetry', { clipId, url });
    } catch {}
  }

  function sunoFlushMseCapture(state) {
    if (!state || state.flushed || !state.chunks.length) return;
    state.flushed = true;
    try {
      if (state.quietTimer) clearTimeout(state.quietTimer);
      const total = state.chunks.reduce((sum, part) => sum + part.length, 0);
      const assembled = new Uint8Array(total);
      let offset = 0;
      for (const part of state.chunks) {
        assembled.set(part, offset);
        offset += part.length;
      }
      state.chunks.length = 0;
      let binary = '';
      const CHUNK = 0x8000; // String.fromCharCode.apply blows the stack on a whole multi-MB array
      for (let i = 0; i < assembled.length; i += CHUNK) {
        binary += String.fromCharCode.apply(null, assembled.subarray(i, i + CHUNK));
      }
      const audioBase64 = btoa(binary);
      console.debug('[RMW Suno Network] assembled a complete MSE audio stream - posting for capture', {
        clipId: state.clipId || '(unattributed)', mimeType: state.mimeType, bytes: total,
      });
      window.postMessage({
        source: SOURCE,
        type: 'SUNO_NETWORK_MSE_AUDIO',
        payload: {
          clipId: state.clipId || '',
          contentType: 'audio/mp4',
          audioBase64,
          capturedAt: Date.now(),
        },
      }, location.origin);
    } catch (error) {
      console.debug('[RMW Suno Network] failed to assemble/post MSE audio', { error: error?.message || error });
    }
  }

  if (typeof MediaSource !== 'undefined' && MediaSource.prototype && MediaSource.prototype.addSourceBuffer) {
    const rawAddSourceBuffer = MediaSource.prototype.addSourceBuffer;
    MediaSource.prototype.addSourceBuffer = function rmwSunoAddSourceBuffer(mimeType) {
      console.debug('[RMW Suno Network] MediaSource.addSourceBuffer called', { mimeType });
      const sourceBuffer = rawAddSourceBuffer.call(this, mimeType);
      try {
        if (sourceBuffer && typeof sourceBuffer.appendBuffer === 'function' && !sourceBuffer.__rmwSunoPatched) {
          // One capture state per SourceBuffer - a new Play mints a new
          // MediaSource/SourceBuffer pair (confirmed live: a second Play
          // logged its own createObjectURL(MediaSource) + addSourceBuffer),
          // so this never mixes two songs' bytes together.
          const state = {
            mimeType, chunks: [], totalBytes: 0, flushed: false, quietTimer: null,
            clipId: sunoCurrentlyPlayingClipId,
          };
          const rawAppendBuffer = sourceBuffer.appendBuffer;
          sourceBuffer.appendBuffer = function rmwSunoAppendBuffer(chunk) {
            try {
              const view = chunk instanceof ArrayBuffer ? new Uint8Array(chunk)
                : (ArrayBuffer.isView(chunk) ? new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength) : null);
              if (view && !state.flushed) {
                // COPY, never retain the caller's buffer: the page is free to
                // reuse or neuter it the moment appendBuffer returns.
                if (state.totalBytes + view.length <= SUNO_MSE_MAX_TOTAL_BYTES) {
                  state.chunks.push(new Uint8Array(view));
                  state.totalBytes += view.length;
                  if (!state.clipId) state.clipId = sunoCurrentlyPlayingClipId;
                }
                if (state.quietTimer) clearTimeout(state.quietTimer);
                state.quietTimer = setTimeout(() => sunoFlushMseCapture(state), SUNO_MSE_QUIET_FLUSH_MS);
              }
            } catch {}
            return rawAppendBuffer.apply(this, arguments);
          };
          sourceBuffer.__rmwSunoPatched = true;
          // endOfStream is the page's own explicit "that's the whole song"
          // signal - flush immediately rather than waiting out the quiet
          // timer, but keep the timer as the backstop for a player that
          // never calls it.
          try {
            const mediaSource = this;
            if (!mediaSource.__rmwSunoEndOfStreamPatched && typeof mediaSource.endOfStream === 'function') {
              const rawEndOfStream = mediaSource.endOfStream;
              mediaSource.endOfStream = function rmwSunoEndOfStream() {
                try { sunoFlushMseCapture(state); } catch {}
                return rawEndOfStream.apply(this, arguments);
              };
              mediaSource.__rmwSunoEndOfStreamPatched = true;
            }
          } catch {}
        }
      } catch {}
      return sourceBuffer;
    };
  }

  // Fires on every real user Play (and on the page's own autoplay-next) -
  // logs whatever the media element's ACTUAL resolved source is at that
  // moment, cross-referencing the createObjectURL map above so a blob: src
  // shows its underlying Blob's type/size right in the same log line.
  document.addEventListener('play', (event) => {
    try {
      const el = event.target;
      if (!el || (el.tagName !== 'AUDIO' && el.tagName !== 'VIDEO')) return;
      const currentSrc = el.currentSrc || el.src || '';
      const blobInfo = currentSrc.startsWith('blob:') ? sunoBlobUrlDiagnostics.get(currentSrc) : null;
      console.debug('[RMW Suno Network] media element play - real playback source', {
        tag: el.tagName, currentSrc, blobInfo,
      });
    } catch {}
  }, true);

  // Confirmed real 2026-09-29: a real Play on a v6 clip produced NEITHER a
  // createObjectURL(audio-like Blob) log NOR a media-element 'play' event NOR
  // any new Network-tab request at click time (the only .m4a requests
  // visible were this extension's OWN proactive fetches, already known
  // undecodable). All three ruled out at once means Suno's player is almost
  // certainly not an HTMLMediaElement at all - the standard alternative for
  // an app with a waveform/seek-bar UI (which Suno has) is the Web Audio API:
  // AudioContext.decodeAudioData() on a buffer it already fetched earlier
  // (explaining the missing click-time request), feeding an
  // AudioBufferSourceNode (explaining why no <audio>/<video> element ever
  // fires 'play'). decodeAudioData is the one point every such path must
  // cross before real audio comes out, regardless of how the input buffer
  // was obtained or whether Suno's own JS transforms/decrypts it first - so
  // this hooks that directly instead of guessing at another upstream step.
  function installSunoDecodeAudioDataHook(ContextCtor) {
    if (!ContextCtor || !ContextCtor.prototype) return;
    const proto = ContextCtor.prototype;
    if (proto.__rmwSunoDecodePatched) return;
    const rawDecode = proto.decodeAudioData;
    if (typeof rawDecode !== 'function') return;
    proto.decodeAudioData = function rmwSunoDecodeAudioData(audioData) {
      try {
        const buffer = audioData instanceof ArrayBuffer ? audioData : null;
        if (buffer) {
          const head = new Uint8Array(buffer.slice(0, 8));
          const hex = Array.from(head).map((b) => b.toString(16).padStart(2, '0')).join('');
          console.debug('[RMW Suno Network] decodeAudioData called - real decode input (the actual bytes the browser plays)', {
            byteLength: buffer.byteLength, first8: hex,
          });
        }
      } catch {}
      return rawDecode.apply(this, arguments);
    };
    proto.__rmwSunoDecodePatched = true;
  }
  installSunoDecodeAudioDataHook(window.AudioContext);
  installSunoDecodeAudioDataHook(window['webkitAudioContext']);
  installSunoDecodeAudioDataHook(window.OfflineAudioContext);

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
        sunoNoteClipIdFromPlaybackTelemetry(url, init && init.body);
      } catch {}
      const promise = rawFetch.apply(this, arguments);
      // Confirmed real 2026-09-29: the actual playback pipeline is
      // MediaSource + SourceBuffer.appendBuffer with real fragmented-MP4
      // (ftyp/moof) chunks (see the appendBuffer hook above) - NOT the
      // CloudFront .m4a fallback content-suno-capture.js was fetching, which
      // is proven-encrypted garbage instead. A *.suno.com/*.suno.ai hostname
      // guess (this block's previous version) caught nothing on a real Play,
      // ruling that out too - the real host is apparently something else
      // entirely (a third-party CDN is common for this). Matching on
      // content-type instead of guessing at a domain finds it regardless of
      // which host it's actually on.
      try {
        promise.then((response) => {
          try {
            const contentType = `${response.headers?.get?.('content-type') || ''}`;
            if (/audio|video|mp4|webm|opus|octet-stream/i.test(contentType)) {
              console.debug('[RMW Suno Network] fetch response with an audio/video-ish content-type - possible real audio stream source', {
                url, status: response.status, contentType,
              });
            }
          } catch {}
        }).catch(() => {});
      } catch {}
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
        sunoNoteClipIdFromPlaybackTelemetry(url, args && args[0]);
      } catch {}
      // Same broad "where's the real audio stream coming from" diagnostic as
      // the fetch patch above, for the XHR transport instead - matches on
      // content-type, not a guessed hostname (a suno.com/suno.ai hostname
      // guess caught nothing on a real Play, so the real host is apparently
      // something else entirely).
      try {
        xhr.addEventListener('loadend', function () {
          try {
            const contentType = this.getResponseHeader?.('content-type') || '';
            if (/audio|video|mp4|webm|opus|octet-stream/i.test(contentType)) {
              console.debug('[RMW Suno Network] XHR response with an audio/video-ish content-type - possible real audio stream source', {
                url, status: this.status, contentType, responseType: this.responseType,
              });
            }
          } catch {}
        });
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
