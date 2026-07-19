// content-chatgpt-media-capture.js — isolated world, document_idle.
//
// Additive media-asset capture. Deliberately does NOT call into any
// function inside content-chatgpt.js's frozen text-capture pipeline
// (fetchAuthoritativeAssistantContent, buildContentPartsFromMessage,
// resolveAndUploadImagePart, buildAndSendResponseCompletedEvent) - those
// are explicitly out of scope for this feature. This file's own duplicate
// of the authoritative-fetch lookup is used too, but strictly as the LAST,
// optional enrichment step - not as the discovery mechanism.
//
// Priority order: DOM scan -> network byte resolution -> MutationObserver
// -> authoritative-fetch enrichment (last, purely additive, never blocking).
// See RESPONSE_RECONSTRUCTION_REPORT.md for why authoritative fetch cannot
// be the primary/only path (observed failing 100% of the time in
// production).
//
// ---------------------------------------------------------------------
// INSTRUMENTATION PASS (this revision): every stage below now emits a
// MEDIA_CAPTURE_TRACE entry (own trace log, own chrome.storage key -
// zero coupling to content-chatgpt.js's text-capture trace). This is
// observability only: no selector, threshold, or capture algorithm below
// was changed by this pass. The goal is to determine, from real browser
// usage, exactly which stage a given turn's media capture stops at -
// see the printed "MEDIA CAPTURE REPORT" at the end of every
// captureGeneratedMediaForResponse() run.
// ---------------------------------------------------------------------
//
// A failure anywhere in this file is caught and swallowed - it can never
// affect text capture, which doesn't call into this file for anything
// (only the other direction: content-chatgpt.js's handleResponseCompletion()
// / the CHATGPT_RESPONSE_STARTED case call into this file, strictly
// additively, after the unmodified text-capture logic already ran).

// Unconditional, absolute-first-line log - fires as long as this file's top
// level JS is executing at all (i.e. it was injected and parsed without
// error), before the IIFE below evaluates any guard. If this never appears
// in DevTools, the file itself isn't running (injection/manifest/parse
// problem); if it DOES appear but nothing after it does, the problem is one
// of the guards inside the IIFE, which now all log their own exit reason
// too (see [RMW MEDIA EXIT] below).
try {
  console.log('[RMW MEDIA FILE LOADED]', { timestamp: Date.now(), tabUrl: location.href });
} catch {}

(function installRmwChatGptMediaCapture() {
  if (window.__rmwChatGptMediaCaptureInstalled) {
    try { console.log('[RMW MEDIA EXIT]', { reason: 'already installed', timestamp: Date.now() }); } catch {}
    return;
  }
  window.__rmwChatGptMediaCaptureInstalled = true;
  if (window.top !== window) {
    try { console.log('[RMW MEDIA EXIT]', { reason: 'iframe (not top frame) - all_frames:true injects this into every frame, only the top frame installs', timestamp: Date.now() }); } catch {}
    return;
  }

  // Previously: const bus = window.RMWChatGPTCapture; if (!bus) return; -
  // a PERMANENT, silent exit if content-chatgpt-event-builder.js's bus
  // wasn't set yet. Chrome guarantees content scripts within the same
  // manifest.json content_scripts entry run in listed order, each to
  // completion, before the next starts - so event-builder.js (listed
  // first) should always finish setting window.RMWChatGPTCapture before
  // this file's IIFE begins. But "should always" is exactly the kind of
  // assumption this investigation exists to stop trusting - if that
  // ordering guarantee is ever violated (a future manifest edit, a browser
  // quirk, event-builder.js throwing before reaching its own bus
  // assignment), the old code gave up permanently and silently. This now
  // retries on a bounded interval instead, and logs every attempt and the
  // final outcome either way.
  const MAX_BUS_WAIT_ATTEMPTS = 20;
  const BUS_WAIT_INTERVAL_MS = 250; // 20 x 250ms = 5s total before giving up

  function waitForBusThenInitialize(attempt) {
    const bus = window.RMWChatGPTCapture;
    if (bus) {
      try { console.log('[RMW MEDIA INIT]', { timestamp: Date.now(), tabUrl: location.href, busFoundOnAttempt: attempt, performanceObserverAvailable: typeof PerformanceObserver !== 'undefined', mutationObserverAvailable: typeof MutationObserver !== 'undefined' }); } catch {}
      initializeMediaCapture(bus);
      return;
    }
    if (attempt >= MAX_BUS_WAIT_ATTEMPTS) {
      try { console.log('[RMW MEDIA EXIT]', { reason: 'missing bus after max retries', attempts: attempt, waitedMs: attempt * BUS_WAIT_INTERVAL_MS, note: 'window.RMWChatGPTCapture never became available - content-chatgpt-event-builder.js likely failed to run or threw before setting it; debug exports were NOT installed this load' }); } catch {}
      return;
    }
    try { console.log('[RMW MEDIA INIT] waiting for bus', { attempt, willRetryInMs: BUS_WAIT_INTERVAL_MS }); } catch {}
    setTimeout(() => waitForBusThenInitialize(attempt + 1), BUS_WAIT_INTERVAL_MS);
  }

  function initializeMediaCapture(bus) {
  // ---- MEDIA_CAPTURE_TRACE infrastructure ----------------------------------
  // Own trace log, own storage key, own console helpers - deliberately not
  // sharing content-chatgpt.js's captureTraceLog/recordCaptureTrace (same
  // "own independent copy, zero shared state" philosophy already used for
  // the fetch/resolve helpers below).

  const MEDIA_TRACE_STORAGE_KEY = 'chatGptMediaCaptureTraceLogV1';
  const MEDIA_TRACE_MAX_ENTRIES = 4000;
  let mediaCaptureTraceLog = [];

  function persistMediaCaptureTrace() {
    try { chrome.storage.local.set({ [MEDIA_TRACE_STORAGE_KEY]: mediaCaptureTraceLog }); } catch {}
    try { window.__rmwMediaCaptureTrace = mediaCaptureTraceLog; } catch {}
  }

  // Keeps chrome.storage/console output sane - canvas-derived data URLs in
  // particular can be hundreds of KB; the trace only ever needs enough to
  // confirm "yes, a URL was found", not the full payload.
  function truncateForTrace(value, maxLength = 140) {
    if (typeof value !== 'string') return value;
    if (value.length <= maxLength) return value;
    return `${value.slice(0, maxLength)}...(${value.length} chars total)`;
  }

  function traceStage(stage, status, ctx, detail) {
    const entry = {
      category: 'MEDIA_CAPTURE_TRACE',
      stage,
      status, // PASS | FAIL | SKIPPED
      at: Date.now(),
      conversationId: ctx?.conversationId || null,
      messageId: ctx?.messageId || null,
      correlationId: ctx?.correlationId || null,
      reason: (detail && detail.reason) || null,
      detail: detail || {},
    };
    mediaCaptureTraceLog.push(entry);
    if (mediaCaptureTraceLog.length > MEDIA_TRACE_MAX_ENTRIES) {
      mediaCaptureTraceLog.splice(0, mediaCaptureTraceLog.length - MEDIA_TRACE_MAX_ENTRIES);
    }
    persistMediaCaptureTrace();
    return entry;
  }

  try {
    window.__rmwDumpMediaCaptureTrace = () => {
      console.table(mediaCaptureTraceLog.map((entry) => ({
        stage: entry.stage,
        status: entry.status,
        at: new Date(entry.at).toISOString(),
        correlationId: entry.correlationId,
        reason: entry.reason,
        detail: JSON.stringify(entry.detail),
      })));
      return mediaCaptureTraceLog;
    };
    window.__rmwClearMediaCaptureTrace = () => {
      mediaCaptureTraceLog = [];
      persistMediaCaptureTrace();
    };
    window.__rmwExportMediaCaptureTrace = () => {
      const filename = `media-capture-trace-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
      const blob = new Blob([JSON.stringify(mediaCaptureTraceLog, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = filename;
      document.body.appendChild(anchor);
      anchor.click();
      document.body.removeChild(anchor);
      setTimeout(() => URL.revokeObjectURL(url), 5000);
      return { entries: mediaCaptureTraceLog.length, filename };
    };
  } catch {}

  // ---- conversation-scoped dedup (requirement #5, done correctly) ---------
  // The unique key is (conversationId + stable-url key), EXACTLY as the spec
  // asked - and deliberately NOT overloaded onto the backend's global
  // provider_asset_id, which is (provider, provider_asset_id)-unique with no
  // conversation scope. Overloading it there (a) collided across
  // conversations (the same file referenced in two chats would steal the
  // first chat's row) and (b) broke the backend's DOM->authoritative-fetch
  // merge (that merge keys on provider_asset_id IS NULL). Keeping this dedup
  // client-side and conversation-scoped avoids both, needs no migration, and
  // leaves provider_asset_id free for the real ChatGPT asset pointer the
  // enrichment step supplies. Persisted in chrome.storage.local so it also
  // suppresses re-capture of the same image after a page reload / across
  // turns in the same conversation.
  const MEDIA_DEDUP_STORAGE_KEY = 'chatGptMediaCaptureDedupV1';
  const MEDIA_DEDUP_MAX_KEYS = 5000;
  let dedupCache = null; // lazy-loaded { "conversationId|stableKey": timestamp }

  function loadDedupCache() {
    if (dedupCache) return Promise.resolve(dedupCache);
    return new Promise((resolve) => {
      try {
        chrome.storage.local.get(MEDIA_DEDUP_STORAGE_KEY, (r) => {
          void chrome.runtime.lastError;
          dedupCache = (r && r[MEDIA_DEDUP_STORAGE_KEY]) || {};
          resolve(dedupCache);
        });
      } catch {
        dedupCache = {};
        resolve(dedupCache);
      }
    });
  }

  function dedupKeyFor(conversationId, stableKey) {
    if (!conversationId || !stableKey) return null; // no stable key (e.g. inline canvas) -> not dedupable, always send
    return `${conversationId}|${stableKey}`;
  }

  async function alreadyStored(conversationId, stableKey) {
    const k = dedupKeyFor(conversationId, stableKey);
    if (!k) return false;
    const cache = await loadDedupCache();
    return Object.prototype.hasOwnProperty.call(cache, k);
  }

  function markStored(conversationId, stableKey) {
    const k = dedupKeyFor(conversationId, stableKey);
    if (!k || !dedupCache) return;
    dedupCache[k] = Date.now();
    const keys = Object.keys(dedupCache);
    if (keys.length > MEDIA_DEDUP_MAX_KEYS) {
      keys.sort((a, b) => dedupCache[a] - dedupCache[b]);
      for (const old of keys.slice(0, keys.length - MEDIA_DEDUP_MAX_KEYS)) delete dedupCache[old];
    }
    try { chrome.storage.local.set({ [MEDIA_DEDUP_STORAGE_KEY]: dedupCache }); } catch {}
  }

  // Synchronous, in-memory claim guard - the async alreadyStored/markStored
  // pair (backed by chrome.storage) can't stop CONCURRENT captures of the
  // same image, because the persist lands after the parallel checks already
  // passed. Three producers race for the same asset every turn: the DOM
  // scan, and the TWO network-observer instances (one from RESPONSE_STARTED,
  // one from completion, each with buffered:true so both replay the same
  // resource). Observed live: one image stored 3x. claimKey() is checked and
  // set synchronously BEFORE any await, so exactly one producer proceeds per
  // (conversation, stableKey) this page session; the rest bail immediately.
  // Released again only on send FAILURE, so a genuinely failed upload stays
  // retryable.
  const claimedKeys = new Set();

  function claimKey(conversationId, stableKey) {
    const k = dedupKeyFor(conversationId, stableKey);
    if (!k) return true; // unkeyed (rare) - can't dedup, allow through
    if (claimedKeys.has(k)) return false;
    claimedKeys.add(k);
    return true;
  }

  function releaseKey(conversationId, stableKey) {
    const k = dedupKeyFor(conversationId, stableKey);
    if (k) claimedKeys.delete(k);
  }

  function isSameOriginUrl(url) {
    try {
      return new URL(url, location.origin).origin === location.origin;
    } catch {
      return false;
    }
  }

  // ---- shared helpers -----------------------------------------------------

  function assetPointerToFileId(assetPointer) {
    return `${assetPointer || ''}`.replace(/^file-service:\/\//, '').trim();
  }

  function blobToDataUrl(blob) {
    return bus.readFileAsDataUrl ? bus.readFileAsDataUrl(blob) : new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    });
  }

  // Sends the captured media asset to the background script and resolves
  // with its response - previously fire-and-forget; now awaited purely so
  // stage 7/8 (Media Upload / Backend Response) have something real to
  // trace. Does not change what gets sent or how the background script
  // handles it.
  function sendMediaCaptured(media, ctx) {
    traceStage('MEDIA_UPLOAD', 'PASS', ctx, {
      mediaType: media.media_type,
      isGeneratedImage: media.media_type === 'generated_image',
      isGeneratedVideo: media.media_type === 'generated_video',
      isResponseImage: media.media_type === 'response_image',
      isResponseVideo: media.media_type === 'response_video',
      hasDataUrl: Boolean(media.data_url),
      hasSourceUrl: Boolean(media.source_url),
      displayOrder: media.display_order,
      uploadAttempted: true,
    });
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage({ type: 'CHATGPT_MEDIA_CAPTURED', media }, (result) => {
          const lastError = chrome.runtime.lastError;
          if (lastError) {
            traceStage('BACKEND_RESPONSE', 'FAIL', ctx, {
              mediaType: media.media_type,
              reason: lastError.message || 'chrome.runtime.sendMessage error (no response received)',
            });
            resolve({ ok: false, error: lastError.message });
            return;
          }
          if (!result || result.ok === false) {
            traceStage('BACKEND_RESPONSE', 'FAIL', ctx, {
              mediaType: media.media_type,
              httpStatus: result?.httpStatus ?? null,
              reason: result?.error || result?.reason || 'unknown failure (no result object)',
            });
            resolve(result || { ok: false });
            return;
          }
          const assetData = (result.data && result.data.data) || null; // CaptureMediaOut -> { success, data: <asset dict> }
          traceStage('BACKEND_RESPONSE', 'PASS', ctx, {
            mediaType: media.media_type,
            httpStatus: result.data?.httpStatus ?? null,
            mediaAssetId: assetData?.id ?? null,
            databaseId: assetData?.id ?? null,
            status: assetData?.status ?? null,
            enrichmentStatus: assetData?.enrichmentStatus ?? null,
            uploaded: Boolean(result.uploaded),
            reason: result.reason || null,
          });
          if (assetData?.id) {
            try {
              console.log('[RMW MEDIA STORED]', {
                mediaAssetId: assetData.id,
                mediaType: media.media_type,
                conversationId: ctx?.conversationId || null,
                messageId: ctx?.messageId || null,
                providerAssetId: assetData.providerAssetId ?? media.provider_asset_id ?? null,
                status: assetData.status ?? null,
                enrichmentStatus: assetData.enrichmentStatus ?? null,
              });
            } catch {}
          }
          resolve(result);
        });
      } catch (error) {
        traceStage('BACKEND_RESPONSE', 'FAIL', ctx, { mediaType: media.media_type, reason: `${error?.message || error}` });
        resolve({ ok: false, error: `${error?.message || error}` });
      }
    });
  }

  // Diagnostic-only probe for the "container validation" question - counts
  // a handful of speculative selector families that could plausibly hold a
  // generated-image UI ChatGPT renders outside the normal message flow
  // (modal/gallery/tool-output). Never used to decide what gets captured -
  // purely evidence for the next, targeted fix.
  function probeAlternativeContainers() {
    try {
      return {
        dialogRole: document.querySelectorAll('[role="dialog"]').length,
        modalClass: document.querySelectorAll('[class*="modal" i]').length,
        galleryClass: document.querySelectorAll('[class*="gallery" i]').length,
        toolOutputHint: document.querySelectorAll('[data-testid*="tool" i], [class*="tool-output" i]').length,
        imageGenHint: document.querySelectorAll('[class*="image-gen" i], [class*="generated-image" i]').length,
      };
    } catch {
      return null;
    }
  }

  // Own, independent copy of the DOM-container-finding strategy already
  // established in content-chatgpt.js's captureRenderedDomText() - not
  // imported, so this file has zero coupling to that frozen function.
  // Selector strategy itself is UNCHANGED by this instrumentation pass -
  // only which strategy matched is now logged.
  function findAssistantContainer(messageId, ctx) {
    let container = null;
    let selectorUsed = null;
    if (messageId) {
      container = document.querySelector(`[data-message-id="${messageId}"][data-message-author-role="assistant"]`);
      if (container) selectorUsed = '[data-message-id][data-message-author-role="assistant"]';
      if (!container) {
        container = document.querySelector(`[data-message-id="${messageId}"]`);
        if (container) selectorUsed = '[data-message-id] (role-agnostic)';
      }
    }
    const assistantCandidates = document.querySelectorAll('[data-message-author-role="assistant"]');
    if (!container && assistantCandidates.length) {
      container = assistantCandidates[assistantCandidates.length - 1];
      selectorUsed = '[data-message-author-role="assistant"] (last-fallback)';
    }

    traceStage('DOM_CONTAINER_RESOLUTION', container ? 'PASS' : 'FAIL', ctx, {
      selectorUsed,
      containerExists: Boolean(container),
      nodeType: container ? container.nodeType : null,
      tagName: container ? container.tagName : null,
      childElementCount: container ? container.childElementCount : null,
      assistantContainerCountInDocument: assistantCandidates.length,
      allAssistantContainers: assistantCandidates.length > 1
        ? Array.from(assistantCandidates).map((el, index) => ({
          index,
          dataMessageId: el.getAttribute('data-message-id'),
          tagName: el.tagName,
          childElementCount: el.childElementCount,
        }))
        : undefined,
      alternativeContainerProbe: probeAlternativeContainers(),
      reason: container ? null : 'no [data-message-id] or [data-message-author-role="assistant"] element found in document',
    });
    return container;
  }

  // ---- DOM scan (Priority 1) -----------------------------------------------

  function extractBackgroundImageUrl(el) {
    try {
      const bg = getComputedStyle(el).backgroundImage;
      const match = /url\((['"]?)(.*?)\1\)/.exec(bg || '');
      return match ? match[2] : null;
    } catch {
      return null;
    }
  }

  function canvasToDataUrl(canvas) {
    try {
      return canvas.toDataURL('image/png');
    } catch {
      // Tainted (cross-origin draw) or CSP-restricted canvas - not fatal,
      // just nothing capturable from this element.
      return null;
    }
  }

  // Heuristic size floor to skip obvious UI chrome (avatars/icons) once
  // dimensions are actually known - unchanged from the prior pass; never
  // filters an element whose dimensions aren't resolved yet.
  const MIN_MEANINGFUL_DIMENSION = 32;
  function looksLikeIcon(width, height) {
    return Boolean(width) && Boolean(height) && width < MIN_MEANINGFUL_DIMENSION && height < MIN_MEANINGFUL_DIMENSION;
  }

  // ---- Known-host classification + stable dedup key (additive) ------------
  // The three confirmed real-world media hosts/paths ChatGPT actually serves
  // generated/referenced images from (per live evidence: images.openai.com
  // static-rsc CDN, files.oaiusercontent.com, and the estuary content
  // endpoint). Matching here does NOT gate whether an element is captured -
  // scanContainerForMedia's existing behavior (size-floor, all <img>/canvas/
  // video elements) is unchanged - it only adds classification/logging and,
  // where a stable id is extractable, a dedup key.
  const KNOWN_MEDIA_URL_PATTERNS = [
    /images\.openai\.com/i,
    /files\.oaiusercontent\.com/i,
    /backend-api\/estuary\/content/i,
  ];
  function matchesKnownMediaHost(url) {
    if (!url) return false;
    return KNOWN_MEDIA_URL_PATTERNS.some((re) => re.test(url));
  }

  function looksLikeVideoUrl(url) {
    if (!url) return false;
    return /\.(mp4|webm)(\?|$)/i.test(url) || url.startsWith('blob:');
  }

  // Strict source classification (production requirement). This is the gate
  // that keeps non-ChatGPT assets (external markdown images, avatars, UI
  // icons, logos) OUT of conversation_media_assets. Only the three confirmed
  // ChatGPT-origin sources are captured; everything else is detected+logged
  // (for observability) but NEVER sent to the backend.
  //
  // Also splits the two media kinds the user distinguished:
  //   - GENERATED: images.openai.com (rendered generated image) and the
  //     estuary content endpoint (the generation-serving path) -> the AI
  //     actually produced this -> generated_image/_video, high confidence.
  //   - FILE ASSET: files.oaiusercontent.com -> a file surfaced in the
  //     response that isn't necessarily AI-generated (uploaded/fetched
  //     file) -> response_image/_video.
  // `capture:false` means "recognized element, but not a supported source" -
  // the caller logs it and moves on without creating a media asset.
  function classifyMediaCandidate(url, kind) {
    const isVideo = kind === 'video';
    if (!url) {
      return { capture: false, sourceClass: 'none', mediaType: null, generated: false, confidence: 0 };
    }
    if (/images\.openai\.com/i.test(url) || /backend-api\/estuary\/content/i.test(url)) {
      return { capture: true, sourceClass: 'generated', mediaType: isVideo ? 'generated_video' : 'generated_image', generated: true, confidence: 0.95 };
    }
    if (/files\.oaiusercontent\.com/i.test(url)) {
      return { capture: true, sourceClass: 'file_asset', mediaType: isVideo ? 'response_video' : 'response_image', generated: false, confidence: 0.9 };
    }
    // Unknown host: NOT captured. Video byte-download isn't implemented yet
    // anyway, and an unknown-host image is exactly the ChatGPT-logo /
    // avatar / external-markdown-image case this filter exists to exclude.
    return { capture: false, sourceClass: 'unknown', mediaType: null, generated: false, confidence: 0 };
  }

  // Deterministic, non-cryptographic - only needs to be stable and cheap,
  // not collision-proof against an adversary.
  function simpleHash(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i += 1) {
      hash = (Math.imul(31, hash) + str.charCodeAt(i)) | 0;
    }
    return `h${(hash >>> 0).toString(36)}`;
  }

  // Extracts a STABLE identifier from a media URL, for use as
  // provider_asset_id at DOM-detection time (before/independent of the
  // separate authoritative-fetch enrichment step, which is the only thing
  // that previously supplied one). Deliberately NOT a hash of the full URL -
  // live evidence showed the estuary endpoint's URL carries time-varying
  // ts=/sig= query params that differ on every re-fetch of the SAME
  // underlying file, so hashing the full string would fail to recognize a
  // re-signed URL for an already-captured image as a duplicate. The `id`
  // query param (when present) or the URL's own pathname (for the CDN hosts,
  // which showed no time-varying query params in the evidence gathered) is
  // the actual stable part.
  function computeStableAssetKeyFromUrl(url) {
    if (!url) return null;
    try {
      const parsed = new URL(url, location.origin);
      const idParam = parsed.searchParams.get('id');
      if (idParam) return `dom:${parsed.hostname}:${idParam}`;
      return `dom:${parsed.hostname}:${parsed.pathname}`;
    } catch {
      return `dom:${simpleHash(url)}`;
    }
  }

  // `ctx` is optional - when provided, emits a DOM_SCAN trace stage. Passed
  // by the deliberate scans (initial + completion-time) but deliberately
  // omitted from the MutationObserver's own rescan loop, which would
  // otherwise flood the trace with one DOM_SCAN entry per DOM mutation;
  // that path has its own MUTATION_OBSERVER_DISCOVERIES stage instead.
  function logDomDetected(candidate, ctx) {
    try {
      console.log('[RMW MEDIA DOM DETECTED]', {
        url: candidate.url,
        type: candidate.kind,
        conversationId: ctx?.conversationId || null,
        messageId: ctx?.messageId || null,
        sourceClass: candidate.sourceClass,
        captured: candidate.capture,
        confidence: candidate.confidence,
      });
    } catch {}
  }

  // Builds a classified candidate, logs it (captured or ignored), and pushes
  // it onto `found` ONLY when the strict source classifier accepts it. This
  // is the single choke point that keeps non-ChatGPT assets out of the DB.
  function considerCandidate(url, kind, extras, found, ctx) {
    if (!url) return;
    const cls = classifyMediaCandidate(url, kind);
    const candidate = {
      kind,
      url,
      sourceClass: cls.sourceClass,
      capture: cls.capture,
      confidence: cls.confidence,
      mediaType: cls.mediaType,
      generated: cls.generated,
      providerAssetIdHint: cls.capture ? computeStableAssetKeyFromUrl(url) : null,
      ...extras,
    };
    logDomDetected(candidate, ctx);
    if (cls.capture) found.push(candidate);
  }

  function scanContainerForMedia(container, ctx) {
    const found = [];
    if (!container) {
      if (ctx) traceStage('DOM_SCAN', 'SKIPPED', ctx, { reason: 'no container to scan' });
      return found;
    }

    const counts = { img: 0, picture: 0, pictureSource: 0, video: 0, canvas: 0, backgroundImage: 0, svg: 0 };
    let ignoredUnknownHost = 0;
    const imgDetails = [];

    container.querySelectorAll('img').forEach((img) => {
      counts.img += 1;
      const url = img.currentSrc || img.src;
      imgDetails.push({
        url: truncateForTrace(url),
        currentSrc: truncateForTrace(img.currentSrc),
        src: truncateForTrace(img.src),
        naturalWidth: img.naturalWidth || undefined,
        naturalHeight: img.naturalHeight || undefined,
      });
      if (!url || url.startsWith('data:image/svg')) return;
      const width = img.naturalWidth || undefined;
      const height = img.naturalHeight || undefined;
      if (looksLikeIcon(width, height)) return;
      if (!matchesKnownMediaHost(url)) { ignoredUnknownHost += 1; }
      // Per-element analytics metadata (requirement: width/height/
      // naturalWidth/naturalHeight/alt/src/timestamp) - lands in
      // metadata_json server-side, never gates capture.
      considerCandidate(url, 'image', {
        width,
        height,
        altText: img.alt || undefined,
        elementMeta: {
          displayWidth: img.width || undefined,
          displayHeight: img.height || undefined,
          naturalWidth: img.naturalWidth || undefined,
          naturalHeight: img.naturalHeight || undefined,
          alt: img.alt || undefined,
          detectedAt: Date.now(),
        },
      }, found, ctx);
    });

    counts.picture = container.querySelectorAll('picture').length;

    container.querySelectorAll('picture source').forEach((source) => {
      counts.pictureSource += 1;
      const url = source.srcset ? source.srcset.trim().split(/\s+/)[0] : source.src;
      if (url && !matchesKnownMediaHost(url)) ignoredUnknownHost += 1;
      considerCandidate(url, 'image', { elementMeta: { detectedAt: Date.now() } }, found, ctx);
    });

    container.querySelectorAll('[style*="background-image"]').forEach((el) => {
      const url = extractBackgroundImageUrl(el);
      if (url) {
        counts.backgroundImage += 1;
        if (!matchesKnownMediaHost(url)) ignoredUnknownHost += 1;
        considerCandidate(url, 'image', { elementMeta: { detectedAt: Date.now() } }, found, ctx);
      }
    });

    // Canvas: an inline drawing with no source URL - cannot be classified as
    // one of the three supported ChatGPT hosts, so under strict filtering it
    // is counted but NOT captured (ChatGPT canvases are charts/UI, not
    // generated image assets). Left here so the count stays visible.
    counts.canvas = container.querySelectorAll('canvas').length;

    // Video architecture (detection + strict-gated; byte download still not
    // implemented - blob handling in sendDiscoveredItem stays source-only).
    container.querySelectorAll('video').forEach((video) => {
      counts.video += 1;
      const url = video.currentSrc || video.src;
      if (url && !matchesKnownMediaHost(url)) ignoredUnknownHost += 1;
      considerCandidate(url, 'video', {
        width: video.videoWidth || undefined,
        height: video.videoHeight || undefined,
        elementMeta: { detectedAt: Date.now() },
      }, found, ctx);
      video.querySelectorAll('source').forEach((source) => {
        if (source.src && !matchesKnownMediaHost(source.src)) ignoredUnknownHost += 1;
        considerCandidate(source.src, 'video', { elementMeta: { detectedAt: Date.now() } }, found, ctx);
      });
    });

    // Diagnostic count only - SVGs are UI chrome (icons/logos) in ChatGPT's
    // markup far more often than generated content; never added to `found`.
    counts.svg = container.querySelectorAll('svg').length;

    if (ctx) {
      traceStage('DOM_SCAN', found.length > 0 ? 'PASS' : 'FAIL', ctx, {
        counts,
        ignoredUnknownHost,
        imgDetails,
        discoveredAssets: found.map((item) => ({
          kind: item.kind,
          url: truncateForTrace(item.url),
          sourceClass: item.sourceClass,
          mediaType: item.mediaType,
          width: item.width,
          height: item.height,
          confidence: item.confidence,
        })),
        reason: found.length > 0
          ? null
          : `zero SUPPORTED-source media elements captured (counts=raw element tallies; ignoredUnknownHost=${ignoredUnknownHost} elements were present but not on a supported ChatGPT host)`,
      });
    }

    return found;
  }

  // ---- network bytes for a DOM-discovered URL (Priority 1 continued) ------

  async function fetchUrlAsDataUrl(url, ctx) {
    if (!url) {
      traceStage('NETWORK_RESOLUTION', 'SKIPPED', ctx, { sourceUrl: null, fetchAttempted: false, reason: 'no url to fetch' });
      return null;
    }
    if (url.startsWith('data:')) {
      traceStage('NETWORK_RESOLUTION', 'SKIPPED', ctx, { sourceUrl: truncateForTrace(url), fetchAttempted: false, reason: 'already an inline data: URL (canvas capture) - no fetch needed' });
      return url;
    }
    try {
      const res = await fetch(url, { credentials: 'include' });
      if (!res.ok) {
        traceStage('NETWORK_RESOLUTION', 'FAIL', ctx, { sourceUrl: url, fetchAttempted: true, success: false, reason: `HTTP ${res.status}` });
        return null;
      }
      const blob = await res.blob();
      const dataUrl = await blobToDataUrl(blob);
      traceStage('NETWORK_RESOLUTION', 'PASS', ctx, { sourceUrl: url, fetchAttempted: true, success: true, blobSize: blob.size, mimeType: blob.type });
      return dataUrl;
    } catch (error) {
      // Cross-origin/CORS-blocked or network failure - caller falls back to
      // source_url-only (still stored, status=pending on the backend until
      // bytes are obtainable another way).
      traceStage('NETWORK_RESOLUTION', 'FAIL', ctx, {
        sourceUrl: url,
        fetchAttempted: true,
        success: false,
        reason: `${error?.message || error} (commonly a cross-origin/CORS block on the CDN URL)`,
      });
      return null;
    }
  }

  // ---- Network-layer asset observation (log-only, no storage) -------------
  // Added per the estuary-content investigation: a real GET
  // /backend-api/estuary/content?id=file_xxxxx request was confirmed
  // (status 200, content-type image/png, sec-fetch-dest: image - i.e. a
  // native <img src> load, not a page fetch()/XHR call). Nothing in this
  // codebase currently observes it: content-chatgpt-network.js's fetch hook
  // only ever matches the conversation-send POST endpoint (see
  // CONVERSATION_SEND_URL_RE) and is untouched by this addition; and a
  // fetch/XHR monkey-patch - in either world - could never see this in the
  // first place, since <img src> loads bypass fetch()/XMLHttpRequest
  // entirely. PerformanceObserver's Resource Timing entries are the only
  // JS-visible signal for a native element-initiated load, and work from an
  // isolated-world content script with zero monkey-patching, so this cannot
  // conflict with or affect the frozen SSE fetch hook in any way.
  //
  // This section ONLY traces what it observes (NETWORK_ASSET_OBSERVED) -
  // it never calls sendMediaCaptured or anything that reaches
  // store_media_asset. No storage/upload behavior changes as a result of
  // this addition.

  const ESTUARY_CONTENT_URL_RE = /\/backend-api\/estuary\/content(\?|$)/i;
  const IMAGE_VIDEO_EXTENSION_RE = /\.(png|jpe?g|gif|webp|bmp|mp4|webm|mov)(\?|$)/i;

  function looksLikeMediaResourceEntry(entry) {
    if (ESTUARY_CONTENT_URL_RE.test(entry.name)) return true;
    if (IMAGE_VIDEO_EXTENSION_RE.test(entry.name)) return true;
    // initiatorType is a standard, always-populated Resource Timing field
    // (not a guess/heuristic) - 'img'/'video' means a native element load,
    // regardless of what the URL itself looks like (the estuary URL has no
    // file extension at all, so this catches it independent of the regexes
    // above too).
    if (entry.initiatorType === 'img' || entry.initiatorType === 'video') return true;
    return false;
  }

  // Read-only, log-only probe for contentType/size on a resource the
  // browser has ALREADY loaded successfully (it's already rendering) - not
  // part of the capture/upload path. A failure here only means
  // contentType/size stay null in the trace entry; nothing else is
  // affected, and nothing here is sent to the backend.
  async function probeResourceMetadata(url) {
    try {
      const res = await fetch(url, { credentials: 'include' });
      if (!res.ok) return { contentType: null, size: null, probeStatus: res.status };
      const contentType = res.headers.get('content-type');
      const blob = await res.blob();
      return { contentType, size: blob.size, probeStatus: res.status };
    } catch (error) {
      return { contentType: null, size: null, probeError: `${error?.message || error}` };
    }
  }

  // Captures a network-observed asset the container-scoped DOM scan would
  // miss - late-rendering carousel images, images rendered in a portal
  // OUTSIDE the assistant message container, AND generated images served
  // from the same-origin estuary endpoint (which the DOM scan kept missing).
  // The network observer is page-wide + buffered, so it sees every media
  // resource load regardless of where/when it renders - strictly more
  // reliable than the DOM scan. Byte handling depends on origin:
  //   - same-origin (estuary on chatgpt.com): the extension CAN read the
  //     bytes and the backend CANNOT (needs the user's session), so fetch a
  //     data_url here.
  //   - cross-origin CDN (images.openai.com / files.oaiusercontent.com):
  //     CORS blocks the extension from reading bytes, so send source_url and
  //     let the backend fetch server-side (verified working).
  // Strict host classification still gates capture (junk/avatars rejected),
  // and the synchronous claimKey guard prevents the DOM path + the two
  // network-observer instances from all storing the same image (observed 3x
  // duplication before this guard existed).
  async function captureNetworkObservedAsset(url, initiatorType, ctx) {
    if (!ctx?.conversationId) return;
    const kind = initiatorType === 'video' ? 'video' : 'image';
    const cls = classifyMediaCandidate(url, kind);
    if (!cls.capture) return; // only images.openai.com / estuary / oaiusercontent
    const stableKey = computeStableAssetKeyFromUrl(url);
    if (stableKey && await alreadyStored(ctx.conversationId, stableKey)) {
      traceStage('DEDUP_SKIP', 'SKIPPED', ctx, { stableKey, reason: 'already stored (prior turn / reload)' });
      return;
    }
    if (!claimKey(ctx.conversationId, stableKey)) {
      traceStage('DEDUP_SKIP', 'SKIPPED', ctx, { stableKey, reason: 'another producer is already capturing this asset this session' });
      return;
    }

    const base = {
      media_type: cls.mediaType,
      generated: cls.generated,
      provider_conversation_id: ctx.conversationId,
      message_id: ctx.messageId,
      assistant_message_id: ctx.messageId,
      correlation_id: ctx.correlationId,
      source: 'network_capture',
      metadata: { sourceClass: cls.sourceClass, confidence: cls.confidence, detection: 'network' },
    };

    let media;
    if (isSameOriginUrl(url)) {
      const dataUrl = await fetchUrlAsDataUrl(url, ctx); // same-origin (estuary) - extension can read bytes
      media = dataUrl ? { ...base, data_url: dataUrl } : { ...base, source_url: url };
    } else {
      media = { ...base, source_url: url }; // cross-origin CDN - backend fetches bytes
    }

    const result = await sendMediaCaptured(media, ctx);
    if (result?.ok !== false && result?.data?.data?.id && stableKey) {
      markStored(ctx.conversationId, stableKey);
    } else {
      releaseKey(ctx.conversationId, stableKey); // failed - let a later attempt retry
    }
  }

  function observeNetworkMediaAssets(ctx, timeoutMs) {
    if (typeof PerformanceObserver === 'undefined') {
      traceStage('NETWORK_ASSET_OBSERVATION', 'FAIL', ctx, { reason: 'PerformanceObserver unavailable in this context' });
      return () => {};
    }
    const seenUrls = new Set();
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (seenUrls.has(entry.name)) continue;
        if (!looksLikeMediaResourceEntry(entry)) continue;
        seenUrls.add(entry.name);
        const detectedAt = Date.now();
        // Capture (not just log) the CORS-blocked CDN assets the DOM scan
        // can't reliably reach - fire-and-forget, never blocks logging.
        captureNetworkObservedAsset(entry.name, entry.initiatorType, ctx);
        probeResourceMetadata(entry.name).then((meta) => {
          const record = {
            correlationId: ctx?.correlationId || null,
            conversationId: ctx?.conversationId || null,
            url: entry.name,
            resourceName: entry.name,
            initiatorType: entry.initiatorType,
            contentType: meta.contentType,
            size: meta.size,
            timestamp: detectedAt,
          };
          // Explicit, unconditional console line (not gated behind any debug
          // flag) so this is visible live in DevTools during a debug session
          // without needing to call a dump/export function first.
          console.log('[RMW MEDIA NETWORK]', record);
          traceStage('NETWORK_ASSET_OBSERVED', 'PASS', ctx, {
            ...record,
            url: truncateForTrace(record.url, 300),
            transferSize: entry.transferSize || null,
            probeStatus: meta.probeStatus ?? null,
            probeError: meta.probeError || null,
            capturedForStorage: classifyMediaCandidate(entry.name, entry.initiatorType === 'video' ? 'video' : 'image').capture,
          });
        });
      }
    });
    try {
      observer.observe({ type: 'resource', buffered: true });
      console.log('[RMW MEDIA OBSERVER ATTACHED]', { timestamp: Date.now(), correlationId: ctx?.correlationId || null, conversationId: ctx?.conversationId || null, timeoutMs });
    } catch (error) {
      traceStage('NETWORK_ASSET_OBSERVATION', 'FAIL', ctx, { reason: `${error?.message || error}` });
      return () => {};
    }
    const stop = () => { try { observer.disconnect(); } catch {} };
    if (timeoutMs) setTimeout(stop, timeoutMs);
    return stop;
  }

  // ---- MutationObserver (Priority 3) ---------------------------------------

  // Keyed by correlationId so a turn's observer results survive from
  // RESPONSE_STARTED through to the RESPONSE_COMPLETED handler picking them
  // up - capped to avoid unbounded growth across a long browsing session.
  const pendingObservations = new Map();
  const turnDiagnostics = new Map(); // correlationId -> { responseStarted, observerAttached }
  const MAX_TRACKED_TURNS = 50;

  function rememberDiscovered(correlationId, item) {
    if (!correlationId) return false;
    let bucket = pendingObservations.get(correlationId);
    if (!bucket) {
      bucket = { seenUrls: new Set(), items: [] };
      pendingObservations.set(correlationId, bucket);
      if (pendingObservations.size > MAX_TRACKED_TURNS) {
        const oldestKey = pendingObservations.keys().next().value;
        pendingObservations.delete(oldestKey);
      }
    }
    if (bucket.seenUrls.has(item.url)) return false;
    bucket.seenUrls.add(item.url);
    bucket.items.push(item);
    return true;
  }

  function takeDiscovered(correlationId) {
    const bucket = pendingObservations.get(correlationId);
    return bucket ? bucket.items : [];
  }

  function observeContainerForMedia(container, ctx, timeoutMs) {
    if (!container || typeof MutationObserver === 'undefined') {
      traceStage('MUTATION_OBSERVER_REGISTRATION', 'FAIL', ctx, {
        containerFound: Boolean(container),
        observerAttached: false,
        reason: !container ? 'no container to observe' : 'MutationObserver unavailable in this context',
      });
      return () => {};
    }
    let anyDiscovered = false;
    const rescan = () => {
      const items = scanContainerForMedia(container); // no ctx - avoid DOM_SCAN spam on every mutation
      const newlyFound = items.filter((item) => rememberDiscovered(ctx.correlationId, item));
      if (newlyFound.length) {
        anyDiscovered = true;
        traceStage('MUTATION_OBSERVER_DISCOVERIES', 'PASS', ctx, {
          newAssetCount: newlyFound.length,
          discoveries: newlyFound.map((item) => ({ kind: item.kind, url: truncateForTrace(item.url) })),
        });
      }
    };
    const observer = new MutationObserver(rescan);
    observer.observe(container, { childList: true, subtree: true, attributes: true, attributeFilter: ['src', 'srcset', 'style'] });
    rescan(); // capture whatever's already there at attach time too
    const stop = () => {
      try { observer.disconnect(); } catch {}
      if (!anyDiscovered) {
        traceStage('MUTATION_OBSERVER_DISCOVERIES', 'SKIPPED', ctx, {
          reason: 'observer window elapsed with zero new asset discoveries',
          windowMs: timeoutMs,
        });
      }
    };
    setTimeout(stop, timeoutMs);
    return stop;
  }

  // Entry point called from content-chatgpt.js's CHATGPT_RESPONSE_STARTED
  // case - starts watching as early as possible so images that render
  // progressively during generation (not just after end_turn) are still
  // caught. The container may not exist in the DOM yet at the very start of
  // a turn, so this retries a few times on a short interval before giving
  // up (the completion-time scan in captureGeneratedMediaForResponse is the
  // fallback if this never finds anything to attach to).
  function observeGeneratedMediaForResponse(payload) {
    const ctx = { conversationId: payload?.conversationId, messageId: payload?.messageId, correlationId: payload?.correlationId };
    traceStage('CHATGPT_RESPONSE_STARTED', payload?.correlationId ? 'PASS' : 'FAIL', ctx, {
      model: payload?.model || null,
      reason: payload?.correlationId ? null : 'no correlationId on payload - media capture cannot track this turn',
    });
    if (!payload?.correlationId) return;
    turnDiagnostics.set(payload.correlationId, { responseStarted: true, observerAttached: false });

    // Log-only, unconditional (unlike the container-scoped MutationObserver
    // below, this needs no DOM container at all - Resource Timing is
    // page-wide) - a long window since async image generation can take a
    // while after RESPONSE_STARTED fires.
    observeNetworkMediaAssets(ctx, 60000);

    let attempts = 0;
    const tryAttach = () => {
      attempts += 1;
      const container = findAssistantContainer(payload.messageId, ctx);
      if (container) {
        observeContainerForMedia(container, ctx, 20000);
        traceStage('MUTATION_OBSERVER_REGISTRATION', 'PASS', ctx, {
          containerFound: true,
          retryCount: attempts,
          observerAttached: true,
        });
        const diag = turnDiagnostics.get(payload.correlationId);
        if (diag) diag.observerAttached = true;
        return;
      }
      if (attempts < 5) { setTimeout(tryAttach, 500); return; }
      traceStage('MUTATION_OBSERVER_REGISTRATION', 'FAIL', ctx, {
        containerFound: false,
        retryCount: attempts,
        observerAttached: false,
        reason: 'no assistant container found after 5 retries (~2.5s) from RESPONSE_STARTED',
      });
    };
    tryAttach();
  }

  // ---- authoritative-fetch enrichment (Priority 4, last, optional) --------

  async function fetchImagePartsForMessage(conversationId, messageId, attempt = 1) {
    if (!conversationId || !messageId) return [];
    try {
      const res = await fetch(`${location.origin}/backend-api/conversation/${conversationId}`, {
        credentials: 'include',
        headers: { accept: 'application/json' },
      });
      if (!res.ok) return [];
      const data = await res.json();
      const message = data?.mapping?.[messageId]?.message;
      const parts = message?.content?.parts;
      if (!Array.isArray(parts)) {
        if (attempt < 2) {
          await new Promise((resolve) => setTimeout(resolve, 400));
          return fetchImagePartsForMessage(conversationId, messageId, attempt + 1);
        }
        return [];
      }
      return parts
        .map((part, index) => ({ part, index }))
        .filter(({ part }) => part && typeof part === 'object' && part.content_type === 'image_asset_pointer')
        .map(({ part, index }) => ({
          order: index,
          assetPointer: part.asset_pointer || '',
          width: part.width || undefined,
          height: part.height || undefined,
        }));
    } catch {
      return [];
    }
  }

  async function resolveImageBytes(assetPointer) {
    const fileId = assetPointerToFileId(assetPointer);
    if (!fileId) return null;
    try {
      const downloadRes = await fetch(`${location.origin}/backend-api/files/${fileId}/download`, { credentials: 'include' });
      if (!downloadRes.ok) return null;
      const downloadJson = await downloadRes.json();
      const downloadUrl = downloadJson?.download_url;
      if (!downloadUrl) return null;
      const blob = await (await fetch(downloadUrl)).blob();
      return { blob, fileId };
    } catch {
      return null;
    }
  }

  // Best-effort, non-blocking of everything already sent by the DOM/network/
  // observer steps. Never throws out to the caller - a failure here just
  // means the assets already captured stay at enrichment_status='pending'
  // server-side.
  async function enrichWithAuthoritativeFetch(payload, ctx, report) {
    const imageParts = await fetchImagePartsForMessage(payload.conversationId, payload.messageId);
    if (!imageParts.length) {
      traceStage('AUTHORITATIVE_ENRICHMENT', 'FAIL', ctx, {
        attempted: true,
        succeeded: false,
        reason: 'authoritative fetch returned zero image parts (mapping lookup failed, or message has no image_asset_pointer parts)',
      });
      report.enrichment = 'FAIL';
      return;
    }
    for (const part of imageParts) {
      try {
        const resolved = await resolveImageBytes(part.assetPointer);
        const base = {
          media_type: 'generated_image',
          generated: true,
          provider_conversation_id: payload.conversationId,
          message_id: payload.messageId,
          assistant_message_id: payload.messageId,
          correlation_id: payload.correlationId,
          provider_asset_id: part.assetPointer || undefined,
          width: part.width,
          height: part.height,
          display_order: part.order,
        };
        let result;
        if (!resolved) {
          result = await sendMediaCaptured(base, ctx);
        } else {
          const dataUrl = await blobToDataUrl(resolved.blob);
          result = await sendMediaCaptured({
            ...base,
            file_name: resolved.fileId,
            mime_type: resolved.blob.type || undefined,
            data_url: dataUrl,
          }, ctx);
        }
        report.uploadsAttempted += 1;
        if (result?.ok !== false && result?.data?.data?.id) report.databaseInserts += 1;
      } catch {
        // Per-image failure never aborts the rest of the batch.
      }
    }
    traceStage('AUTHORITATIVE_ENRICHMENT', 'PASS', ctx, { attempted: true, succeeded: true, imagePartsFound: imageParts.length });
    report.enrichment = 'PASS';
  }

  // ---- Orchestration + Pipeline Summary ------------------------------------

  function mediaTypeFor(kind) {
    return kind === 'video' ? 'generated_video' : 'generated_image';
  }

  async function sendDiscoveredItem(payload, ctx, item, displayOrder, report) {
    // Conversation-scoped dedup (requirement #5): if this exact
    // (conversationId + stable-url key) was already stored - this turn, a
    // prior turn, or before a page reload - skip the re-upload entirely.
    // Deliberately NOT expressed as backend provider_asset_id (see
    // alreadyStored/markStored comment for why that collided across
    // conversations and broke the enrichment merge).
    if (item.providerAssetIdHint && await alreadyStored(payload.conversationId, item.providerAssetIdHint)) {
      report.dedupSkipped = (report.dedupSkipped || 0) + 1;
      traceStage('DEDUP_SKIP', 'SKIPPED', ctx, { stableKey: item.providerAssetIdHint, reason: 'already stored for this conversation (conversationId + stable url key)' });
      return;
    }
    // Synchronous cross-path claim - stops this DOM capture from racing the
    // network-observer capture of the same image (see claimKey).
    if (item.providerAssetIdHint && !claimKey(payload.conversationId, item.providerAssetIdHint)) {
      report.dedupSkipped = (report.dedupSkipped || 0) + 1;
      traceStage('DEDUP_SKIP', 'SKIPPED', ctx, { stableKey: item.providerAssetIdHint, reason: 'another producer (network observer) is already capturing this asset' });
      return;
    }

    const base = {
      // Classified media_type/generated from the source host (generated
      // image vs response/file image), not a blanket 'generated_image'.
      media_type: item.mediaType || mediaTypeFor(item.kind),
      generated: item.generated !== undefined ? item.generated : true,
      provider_conversation_id: payload.conversationId,
      message_id: payload.messageId,
      assistant_message_id: payload.messageId,
      correlation_id: payload.correlationId,
      width: item.width,
      height: item.height,
      display_order: displayOrder,
      source: 'dom_capture',
      alt_text: item.altText || undefined,
      // Analytics metadata (requirement): element dimensions/alt/timestamp,
      // the source classification, and a detection confidence score. Lands
      // in metadata_json server-side; never gates capture.
      metadata: {
        sourceClass: item.sourceClass,
        confidence: item.confidence,
        detection: 'dom',
        element: item.elementMeta || undefined,
      },
      // NOTE: provider_asset_id is intentionally NOT set here. It stays null
      // for DOM-discovered rows so the backend's authoritative-fetch
      // enrichment step can adopt this exact row via its position-based
      // merge (_find_existing_unenriched_by_position, which requires
      // provider_asset_id IS NULL). The real ChatGPT asset pointer is filled
      // in later by that enrichment step. Same-image dedup is handled
      // client-side above, scoped by conversation.
    };
    let result;
    if (item.url && item.url.startsWith('blob:')) {
      // Video architecture (detection-only per requirements): a blob: URL
      // was created in the page's own JS context - fetching it from this
      // isolated-world content script is not guaranteed to resolve to the
      // same underlying bytes (blob URLs are scoped to the context that
      // created them), so this deliberately does NOT attempt byte
      // extraction yet. The reference is still captured (source_url),
      // landing as status=pending server-side, exactly like any other
      // not-yet-resolvable asset.
      traceStage('NETWORK_RESOLUTION', 'SKIPPED', ctx, { sourceUrl: item.url, fetchAttempted: false, reason: 'blob: URL - byte extraction not implemented yet (video architecture is detection-only)' });
      result = await sendMediaCaptured({ ...base, source_url: item.url }, ctx);
    } else {
      report.networkFetchesAttempted += 1;
      const dataUrl = await fetchUrlAsDataUrl(item.url, ctx);
      if (dataUrl) {
        report.networkFetchesSucceeded += 1;
        result = await sendMediaCaptured({ ...base, data_url: dataUrl }, ctx);
      } else {
        // Bytes weren't obtainable (commonly a cross-origin CDN URL that
        // fetch() can't read even though the <img> tag renders it fine) -
        // still capture the reference itself rather than dropping the
        // asset; store_media_asset() records this as status=pending.
        result = await sendMediaCaptured({ ...base, source_url: item.url }, ctx);
      }
    }
    report.uploadsAttempted += 1;
    if (result?.ok !== false && result?.data?.data?.id) {
      report.databaseInserts += 1;
      // Only record the dedup key AFTER a confirmed backend insert - a failed
      // upload must remain re-tryable on a later turn, not be suppressed.
      if (item.providerAssetIdHint) markStored(payload.conversationId, item.providerAssetIdHint);
    } else if (item.providerAssetIdHint) {
      releaseKey(payload.conversationId, item.providerAssetIdHint); // failed - allow retry
    }
  }

  function determineFailurePoint(report) {
    if (!report.observerAttached && !report.containerFound) return 'MUTATION_OBSERVER_REGISTRATION / DOM_CONTAINER_RESOLUTION (no assistant container ever found)';
    if (!report.containerFound) return 'DOM_CONTAINER_RESOLUTION (no assistant container found at completion time)';
    if (report.domImages + report.domVideos + report.domCanvas === 0) return 'DOM_SCAN (zero capturable media elements found in container)';
    if (report.networkFetchesAttempted > 0 && report.networkFetchesSucceeded === 0) return 'NETWORK_RESOLUTION (all byte fetches failed - check reason field, commonly CORS)';
    if (report.uploadsAttempted > 0 && report.databaseInserts === 0) return 'MEDIA_UPLOAD / BACKEND_RESPONSE (uploads sent but zero confirmed database inserts)';
    if (report.databaseInserts > 0) return null;
    return 'UNKNOWN (no assets discovered and nothing attempted)';
  }

  // ---- Root Cause Summary ---------------------------------------------------
  // Pure analysis over the trace entries/report already produced above - does
  // not observe, touch, or influence anything about how capture itself runs.
  // Exists so day-to-day debugging can read one paragraph instead of
  // scanning the raw MEDIA_CAPTURE_TRACE log entry by entry.

  function collectRunEntries(correlationId) {
    if (!correlationId) return [];
    return mediaCaptureTraceLog.filter((entry) => entry.correlationId === correlationId);
  }

  function reasonsFor(entries, stage, status) {
    return entries
      .filter((entry) => entry.stage === stage && entry.status === status)
      .map((entry) => entry.reason)
      .filter(Boolean);
  }

  function looksLikeCors(reason) {
    if (!reason) return false;
    const text = reason.toLowerCase();
    return text.includes('cors') || text.includes('failed to fetch') || text.includes('networkerror') || text.includes('opaque');
  }

  // Ordered so the first applicable rule is the true first-failing stage -
  // mirrors determineFailurePoint()'s order but with a human-readable
  // explanation, a confidence rating, and a concrete next step per case.
  function buildRootCauseSummary(report, runEntries) {
    if (!report.responseStarted) {
      return {
        rootCause: 'RESPONSE_STARTED signal never reached media capture (missing correlationId on the payload, or observeGeneratedMediaForResponse() was never invoked for this turn).',
        confidence: 'HIGH',
        suggestion: 'Confirm content-chatgpt.js\'s CHATGPT_RESPONSE_STARTED case still calls window.RMWChatGptMediaCapture.observeGeneratedMediaForResponse(payload), and that payload.correlationId is populated at that point.',
      };
    }

    if (!report.observerAttached && !report.containerFound) {
      return {
        rootCause: 'Assistant container not found - no [data-message-id] or [data-message-author-role="assistant"] element existed in the document, neither during the early MutationObserver attach attempt nor at completion time.',
        confidence: 'HIGH',
        suggestion: 'Inspect the live DOM during a generated-image response (DevTools Elements panel) to see what actually wraps the image - check alternativeContainerProbe in the raw DOM_CONTAINER_RESOLUTION trace entry for modal/dialog/gallery/tool-output hit counts elsewhere in the document.',
      };
    }

    if (!report.containerFound) {
      return {
        rootCause: 'Assistant container was found early (observer attached) but was gone by completion time - the DOM node likely got replaced/re-rendered mid-turn.',
        confidence: 'MEDIUM',
        suggestion: 'Compare the DOM_CONTAINER_RESOLUTION trace entry from MUTATION_OBSERVER_REGISTRATION (early) against the one from completion time for this correlationId - a changed tagName/childElementCount between them confirms a DOM replacement.',
      };
    }

    const domFoundNothing = report.domImages + report.domVideos + report.domCanvas === 0;
    const enrichmentEntries = runEntries.filter((entry) => entry.stage === 'AUTHORITATIVE_ENRICHMENT');
    const imagePartsFound = enrichmentEntries.some((entry) => Number(entry.detail?.imagePartsFound) > 0);

    if (domFoundNothing && !imagePartsFound) {
      return {
        rootCause: 'No media elements were found via DOM scan, and authoritative-fetch enrichment also found zero image parts for this message. Most likely this response simply did not generate any images/videos (a normal text-only turn) - not necessarily a capture defect.',
        confidence: 'MEDIUM',
        suggestion: 'Only worth investigating further if you know this specific turn DID generate an image - if so, check the DOM_SCAN trace entry\'s `counts` field (img/picture/video/canvas/backgroundImage/svg tallies) for any non-zero count that still produced no capturable asset.',
      };
    }

    if (domFoundNothing) {
      return {
        rootCause: 'DOM contained zero images/videos/canvas matching capture criteria, even though the container was found and authoritative fetch DID find image part(s) for this message - the image exists in ChatGPT\'s data but wasn\'t present in the scanned DOM subtree.',
        confidence: 'HIGH',
        suggestion: 'Inspect DOM_SCAN\'s counts/imgDetails in the raw trace for this turn - the generated image is likely rendered outside the resolved container (see alternativeContainerProbe), or as an element type scanContainerForMedia does not enumerate.',
      };
    }

    if (report.networkFetchesAttempted > 0 && report.networkFetchesSucceeded === 0) {
      const failReasons = reasonsFor(runEntries, 'NETWORK_RESOLUTION', 'FAIL');
      const corsLikely = failReasons.some(looksLikeCors);
      return {
        rootCause: corsLikely
          ? 'Image URLs were extracted from the DOM, but fetching their bytes over the network was blocked - failure reasons match a cross-origin/CORS restriction on the CDN URL.'
          : 'Image URLs were extracted from the DOM, but every network fetch for their bytes failed.',
        confidence: corsLikely ? 'HIGH' : 'MEDIUM',
        suggestion: corsLikely
          ? 'Expected for opaque cross-origin CDN URLs - store_media_asset() already stores these as source_url-only (status=pending), so this is not data loss. Only actionable if the dashboard needs the actual bytes, which would require a server-side proxy fetch.'
          : `Inspect the exact failure reason(s): ${failReasons.slice(0, 3).join(' | ') || 'none captured in this run'}.`,
      };
    }

    if (report.uploadsAttempted > 0 && report.databaseInserts === 0) {
      const failReasons = reasonsFor(runEntries, 'BACKEND_RESPONSE', 'FAIL');
      return {
        rootCause: 'Assets were sent to the background script for upload, but zero were confirmed stored in the database.',
        confidence: 'HIGH',
        suggestion: `Inspect BACKEND_RESPONSE failure reasons: ${failReasons.slice(0, 3).join(' | ') || 'none captured - check chrome.runtime.lastError, or whether capture is disabled/DRY_RUN in feature flags'}.`,
      };
    }

    if (report.databaseInserts > 0) {
      const enrichmentNote = report.enrichment === 'FAIL'
        ? ' Authoritative enrichment failed separately, so provider_asset_id/prompt are not attached yet (enrichment_status stays pending) - this does not affect the stored asset itself.'
        : '';
      return {
        rootCause: `Capture succeeded - ${report.databaseInserts} asset(s) stored.${enrichmentNote}`,
        confidence: 'HIGH',
        suggestion: report.enrichment === 'FAIL' ? 'No action needed for capture; enrichment is tracked separately (see the authoritative-fetch outage investigation).' : 'No action needed.',
      };
    }

    return {
      rootCause: 'Pipeline completed with no assets discovered and nothing attempted - does not match any recognized pattern.',
      confidence: 'LOW',
      suggestion: 'Inspect the full raw trace for this turn via window.__rmwDumpMediaCaptureTrace().',
    };
  }

  function printMediaCaptureReport(report) {
    const failurePoint = determineFailurePoint(report);
    const finalResult = report.databaseInserts > 0 ? 'SUCCESS' : 'FAILED';
    const runEntries = collectRunEntries(report.correlationId);
    const { rootCause, confidence, suggestion } = buildRootCauseSummary(report, runEntries);

    const lines = [
      '==========================',
      'MEDIA CAPTURE REPORT',
      '==========================',
      '',
      'Stage Results',
      '-------------',
      `Response Started: ${report.responseStarted ? 'PASS' : 'FAIL'}`,
      `Observer Attached: ${report.observerAttached ? 'PASS' : 'FAIL'}`,
      `Container Found: ${report.containerFound ? 'PASS' : 'FAIL'}`,
      `DOM Images: ${report.domImages}`,
      `DOM Videos: ${report.domVideos}`,
      `Canvas: ${report.domCanvas}`,
      `Picture Elements: ${report.domPictureElements}`,
      `Network Fetches: ${report.networkFetchesAttempted}`,
      `Successful Fetches: ${report.networkFetchesSucceeded}`,
      `Uploads: ${report.uploadsAttempted}`,
      `Database Inserts: ${report.databaseInserts}`,
      `Enrichment: ${report.enrichment || 'SKIPPED'}`,
      '',
      'Root Cause',
      '----------',
      rootCause,
      '',
      'Confidence',
      '----------',
      confidence,
      '',
      'Suggested Investigation',
      '------------------------',
      suggestion,
      '',
      `Final Result: ${finalResult}`,
    ];
    if (failurePoint) lines.push(`Failure Point: ${failurePoint}`);
    lines.push('==========================');
    const reportText = lines.join('\n');
    console.log(reportText);
    traceStage('PIPELINE_SUMMARY', finalResult === 'SUCCESS' ? 'PASS' : 'FAIL', report, { report, failurePoint, rootCause, confidence, suggestion, reportText });
    return { finalResult, failurePoint, rootCause, confidence, suggestion, reportText };
  }

  // Entry point, called from content-chatgpt.js's handleResponseCompletion()
  // - additive, fire-and-forget from that caller's perspective, after the
  // existing text-capture call has already run unmodified. Never awaits or
  // depends on authoritative fetch for the core capture - that only runs
  // last, as enrichment.
  async function captureGeneratedMediaForResponse(payload) {
    const ctx = { conversationId: payload?.conversationId, messageId: payload?.messageId, correlationId: payload?.correlationId };
    const diag = turnDiagnostics.get(payload?.correlationId) || { responseStarted: false, observerAttached: false };
    const report = {
      correlationId: payload?.correlationId,
      conversationId: payload?.conversationId,
      messageId: payload?.messageId,
      responseStarted: diag.responseStarted,
      observerAttached: diag.observerAttached,
      containerFound: false,
      domImages: 0,
      domVideos: 0,
      domCanvas: 0,
      domPictureElements: 0,
      networkFetchesAttempted: 0,
      networkFetchesSucceeded: 0,
      uploadsAttempted: 0,
      databaseInserts: 0,
      enrichment: null,
    };

    if (!payload?.conversationId || !payload?.messageId) {
      const reason = 'missing conversationId/messageId on the RESPONSE_COMPLETED payload - capture cannot run at all';
      traceStage('PIPELINE_SUMMARY', 'FAIL', ctx, { reason, report });
      console.log([
        '==========================',
        'MEDIA CAPTURE REPORT',
        '==========================',
        '',
        'Root Cause',
        '----------',
        reason,
        '',
        'Confidence',
        '----------',
        'HIGH',
        '',
        'Suggested Investigation',
        '------------------------',
        'Check the CHATGPT_RESPONSE_COMPLETED case in content-chatgpt.js - the payload it builds should always carry conversationId/messageId by this point in the text-capture pipeline.',
        '',
        'Final Result: FAILED',
        '==========================',
      ].join('\n'));
      return;
    }

    // Log-only fallback in case RESPONSE_STARTED never reached media
    // capture for this turn (e.g. isVisibleResponseMessage still didn't
    // match) - short window, since by completion time generation is
    // presumably already done or nearly done.
    observeNetworkMediaAssets(ctx, 5000);

    const container = findAssistantContainer(payload.messageId, ctx);
    report.containerFound = Boolean(container);

    const immediateItems = scanContainerForMedia(container, ctx);
    immediateItems.forEach((item) => rememberDiscovered(payload.correlationId, item));
    report.domPictureElements = container ? container.querySelectorAll('picture').length : 0;

    // Give the observer (already running since RESPONSE_STARTED, or started
    // just now if that hook missed) a short additional grace window - some
    // generated images finish swapping in a beat after end_turn.
    if (container) observeContainerForMedia(container, ctx, 4000);
    await new Promise((resolve) => setTimeout(resolve, 1200));

    const discovered = takeDiscovered(payload.correlationId);
    pendingObservations.delete(payload.correlationId);
    turnDiagnostics.delete(payload.correlationId);

    // Recompute DOM counts including anything the observer added beyond the
    // immediate scan, so the report reflects everything actually captured.
    report.domImages = discovered.filter((i) => i.kind === 'image' && !i.isDataUrl).length;
    report.domCanvas = discovered.filter((i) => i.isDataUrl).length;
    report.domVideos = discovered.filter((i) => i.kind === 'video').length;

    // In-batch dedup by stable key BEFORE the concurrent sends below - the
    // persistent alreadyStored()/markStored() pair can't guard against two
    // items with the same stable key inside a single Promise.all batch
    // (both would read "not stored" before either writes). rememberDiscovered
    // already collapses identical RAW urls, but a re-signed URL for the same
    // file (different ts/sig, same id) is a different raw url yet the same
    // stable key - this collapses those too. Items without a stable key
    // (inline canvas) are always kept.
    const seenStableKeysThisBatch = new Set();
    const toSend = discovered.filter((item) => {
      if (!item.providerAssetIdHint) return true;
      if (seenStableKeysThisBatch.has(item.providerAssetIdHint)) return false;
      seenStableKeysThisBatch.add(item.providerAssetIdHint);
      return true;
    });

    await Promise.all(toSend.map((item, index) => sendDiscoveredItem(payload, ctx, item, index, report)));

    // Priority 4, last: purely additive enrichment. Runs regardless of
    // whether the DOM/observer steps found anything - but never blocks or
    // gates what's already been sent.
    try {
      await enrichWithAuthoritativeFetch(payload, ctx, report);
    } catch (error) {
      traceStage('AUTHORITATIVE_ENRICHMENT', 'FAIL', ctx, { attempted: true, succeeded: false, reason: `${error?.message || error}` });
      report.enrichment = 'FAIL';
    }

    printMediaCaptureReport(report);
  }

  window.RMWChatGptMediaCapture = { captureGeneratedMediaForResponse, observeGeneratedMediaForResponse };
  } // end initializeMediaCapture

  waitForBusThenInitialize(1);
})();
