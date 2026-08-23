// content-splice-capture.js — Splice Download Capture (isolated world,
// splice.com).
//
// Splice is a sample/loop library - users browse audio samples and click a
// per-row Download button. Mirrors content-epidemicsound-capture.js's
// DOWNLOAD-ONLY click-gate + Task/Client popup + report-on-observed-response
// pattern exactly (there is no Adapt-style generation surface here, unlike
// Epidemic Sound - Splice's capture surface is download-only).
//
// Its own file, loaded via its own manifest.json content_scripts entry
// (grouped only with content-splice-task-api.js/content-splice-task-modal.js),
// NOT appended to content-splice.js (the login-automation script). See
// content-epidemicsound-capture.js's own header comment for the real
// incident this discipline traces back to.
//
// Because this file's entry shares a host (and therefore an isolated-world
// global scope) with content-splice.js, every top-level name here is
// namespaced "splice"/"Splice" rather than reusing generic names
// content-splice.js may already declare. Same discipline
// content-epidemicsound-capture.js already uses.
//
// CRITICAL architectural point (see content-splice-network.js's own header
// comment for the fuller version): https://surfaces-graphql.splice.com/graphql
// is a SHARED endpoint used for many unrelated queries, not a dedicated
// download endpoint. content-splice-network.js relays EVERY response whose
// body matches the data.asset.files[] shape (with a "source" entry) - this
// file is the one that decides whether a given relayed message corresponds
// to a real, user-gated download click, via a FIFO pending-arm queue
// (splicePendingArms/takeOldestSpliceArm), ported directly from
// content-epidemicsound-capture.js's identical /download/-response-matching
// pattern. If no arm is pending when a relay arrives, it is a preview/browse
// action and is dropped.
//
// Confirmed real Download button DOM (2026-08-19 live DevTools capture):
//   <button type="button" data-qa="download-button" class="variant-transparent icon-only icon-small">
//     <span class="icon"><svg><use href="#icon-file-download"></use></svg></span>
//     <span class="visually-hidden">Download GrenadeExplosion_S08WA.219.wav</span>
//   </button>
// No useful aria-label, no visible text (icon-only) - but a real, reliable
// data-qa="download-button" attribute exists, used as the primary (and only)
// selector here, unlike every other provider built this session (Epidemic
// Sound/ElevenLabs Music/Epidemic Sound Adapt) which all had to fall back to
// visible-text matching because their aria-labels were absent or misleading.
//
// Confirmed real network flow (2026-08-19 live DevTools capture):
//   POST https://surfaces-graphql.splice.com/graphql
//   -> data.asset.files[]: entries with asset_file_type_slug
//      "preview_mp3" | "waveform" | "source"
//   Then a plain GET on the "source" entry's signed S3 URL (CORS-open,
//   no auth headers needed) fetches the actual audio bytes. That signed URL
//   expires in only ~119 seconds - the shortest expiry of any provider built
//   this session - so the fetch must happen immediately, not deferred.

function spliceSendRuntimeMessage(message) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) {
        resolve({ ok: false, error: chrome.runtime.lastError.message });
        return;
      }
      resolve(response || { ok: false, error: 'No response received' });
    });
  });
}

function spliceIsVisible(element) {
  if (!element) return false;
  const rect = element.getBoundingClientRect();
  const style = window.getComputedStyle(element);
  return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
}

function spliceIsDisabled(element) {
  if (!element) return true;
  return Boolean(
    element.disabled
    || element.getAttribute('aria-disabled') === 'true'
    || element.getAttribute('disabled') !== null
  );
}

// ---- On-page capture status badge - same pattern as
// content-epidemicsound-capture.js's ensureEpidemicSoundCaptureStatusBadge,
// own element id so it can't collide with content-splice.js's own
// login-status badge, if any. ----

let spliceCaptureStatusHideTimer = null;

function ensureSpliceCaptureStatusBadge() {
  const existing = document.getElementById('rmw-splice-capture-status');
  if (existing) return existing;
  const badge = document.createElement('div');
  badge.id = 'rmw-splice-capture-status';
  Object.assign(badge.style, {
    position: 'fixed',
    top: '60px',
    right: '12px',
    zIndex: '2147483647',
    maxWidth: '320px',
    padding: '10px 12px',
    borderRadius: '10px',
    background: 'rgba(15, 23, 42, 0.92)',
    color: '#f8fafc',
    font: '12px/1.4 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    boxShadow: '0 8px 24px rgba(15, 23, 42, 0.28)',
    pointerEvents: 'none',
    whiteSpace: 'pre-wrap',
    display: 'none',
  });
  (document.body || document.documentElement).appendChild(badge);
  return badge;
}

function setSpliceCaptureStatus(message, { autoHideMs } = {}) {
  const badge = ensureSpliceCaptureStatusBadge();
  badge.textContent = `Splice capture\n${message}`;
  badge.style.display = 'block';
  if (spliceCaptureStatusHideTimer) {
    window.clearTimeout(spliceCaptureStatusHideTimer);
    spliceCaptureStatusHideTimer = null;
  }
  if (autoHideMs) {
    spliceCaptureStatusHideTimer = window.setTimeout(() => { badge.style.display = 'none'; }, autoHideMs);
  }
}

// ---- "Is this click a Download action" detector. Confirmed real DOM has a
// reliable data-qa="download-button" attribute - no visible-text fallback
// needed here (unlike every other icon-only Download control built this
// session), a plain attribute-selector match is primary and sufficient. ----

function spliceFindDownloadButton(eventTarget) {
  const startFromElement = () => (eventTarget?.nodeType === Node.ELEMENT_NODE ? eventTarget : eventTarget?.parentElement);

  let current = startFromElement();
  let depth = 0;
  while (current && current !== document.body && depth < 8) {
    if (
      current.matches?.('[data-qa="download-button"]')
      && spliceIsVisible(current) && !spliceIsDisabled(current)
    ) {
      return current;
    }
    current = current.parentElement;
    depth += 1;
  }
  return null;
}

// Best-effort filename extraction from the button's own `.visually-hidden`
// child span ("Download {filename}") - captured at CLICK time (not later,
// when reporting the eventual graphql relay) because the button element may
// no longer be queryable/attached by the time a matching network response
// arrives. Strips the leading "Download " prefix to get just the filename.
function extractSpliceButtonTitle(button) {
  try {
    const hiddenSpan = button?.querySelector?.('.visually-hidden');
    const text = `${hiddenSpan?.textContent || ''}`.trim();
    if (!text) return null;
    const stripped = text.replace(/^download\s+/i, '').trim();
    return stripped || null;
  } catch {
    return null;
  }
}

// ---- FIFO pending-arm queue - ported directly from
// content-epidemicsound-capture.js's epidemicSoundPendingArms/
// takeOldestEpidemicSoundArm pattern. Necessary here because
// surfaces-graphql.splice.com/graphql is a SHARED endpoint (search,
// previews, user info, ...) relayed unconditionally by
// content-splice-network.js - only a relay observed while at least one arm
// is pending is treated as a real, gated download; everything else is
// silently ignored as ordinary browse/preview traffic. ----
const SPLICE_ARM_WINDOW_MS = 30 * 1000;
let splicePendingArms = [];

function armSpliceDownload(selection, buttonTitle) {
  const clientEventId = `splice:download:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
  const arm = { clientEventId, selection, armedAt: Date.now(), buttonTitle: buttonTitle || null, timer: null };
  arm.timer = window.setTimeout(() => {
    splicePendingArms = splicePendingArms.filter((item) => item !== arm);
    console.warn('[RMW Splice Capture] pending download arm expired with no matching graphql asset.files response observed', { clientEventId });
  }, SPLICE_ARM_WINDOW_MS);
  splicePendingArms.push(arm);
  return arm;
}

function takeOldestSpliceArm() {
  const arm = splicePendingArms.shift();
  if (arm) window.clearTimeout(arm.timer);
  return arm || null;
}

// ---- Media capture (real audio bytes for a download) ----
//
// Once a graphql asset.files response is matched to its arm, proactively
// fetch() the "source" file's signed S3 URL directly - CORS-open to
// https://splice.com, publicly fetchable, same pattern as Epidemic Sound's
// audiocdn.epidemicsound.com URL / ElevenLabs Music's GCS URL / Suno's
// cdn1.suno.ai URL, so no credentials or cookies are needed. Uses the SAME
// client_event_id as the metadata event.
const spliceRecentlyPushedMedia = new Map(); // clientEventId -> { pushedAt }
const SPLICE_MEDIA_PUSH_DEDUPE_MS = 60000;
const SPLICE_MEDIA_PUSH_MAX_ATTEMPTS = 4;
const SPLICE_MEDIA_PUSH_RETRY_DELAY_MS = 4000; // 4s, 8s, 12s

function spliceArrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  const CHUNK_SIZE = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += CHUNK_SIZE) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK_SIZE));
  }
  return btoa(binary);
}

async function pushSpliceDownloadMedia(clientEventId, contentType, mediaBase64, attempt = 1) {
  if (!clientEventId || !mediaBase64) return;

  if (attempt === 1) {
    const now = Date.now();
    const last = spliceRecentlyPushedMedia.get(clientEventId);
    if (last && now - last.pushedAt < SPLICE_MEDIA_PUSH_DEDUPE_MS) return;
  }

  try {
    const result = await spliceSendRuntimeMessage({
      type: 'SPLICE_CAPTURE_DOWNLOAD_MEDIA',
      clientEventId,
      contentType: contentType || 'audio/mpeg',
      audioBase64: mediaBase64,
      isDownload: true,
    });
    if (result?.ok) {
      spliceRecentlyPushedMedia.set(clientEventId, { pushedAt: Date.now() });
      console.debug('[RMW Splice Capture] pushed download media', { clientEventId, status: result.status, attempt });
      return;
    }
    // The metadata event is enqueued through the durable outbox queue (see
    // background-splice-capture.js), which batches on a short quiet timer
    // before it actually POSTs - so the backend row this media push needs to
    // attach to may not exist yet the instant we try. Same retry shape
    // content-epidemicsound-capture.js's pushEpidemicSoundDownloadMedia uses
    // for the identical race.
    if (result?.status === 'download_not_found' && attempt < SPLICE_MEDIA_PUSH_MAX_ATTEMPTS) {
      const delay = SPLICE_MEDIA_PUSH_RETRY_DELAY_MS * attempt;
      console.debug('[RMW Splice Capture] media arrived before its download row - retrying shortly', { clientEventId, attempt, delay });
      window.setTimeout(() => pushSpliceDownloadMedia(clientEventId, contentType, mediaBase64, attempt + 1), delay);
      return;
    }
    console.warn('[RMW Splice Capture] failed to push download media', { clientEventId, error: result?.error, status: result?.status, attempt });
  } catch (error) {
    console.warn('[RMW Splice Capture] unexpected error pushing download media', { clientEventId, error: error?.message || error });
  }
}

async function fetchAndPushSpliceAssetMedia(sourceUrl, clientEventId) {
  if (!sourceUrl) return;
  try {
    const response = await fetch(sourceUrl);
    if (!response.ok) {
      console.warn('[RMW Splice Capture] asset fetch failed', { status: response.status, clientEventId });
      return;
    }
    const contentType = response.headers.get('content-type') || 'audio/mpeg';
    const buffer = await response.arrayBuffer();
    if (!buffer || !buffer.byteLength) return;
    const mediaBase64 = spliceArrayBufferToBase64(buffer);
    await pushSpliceDownloadMedia(clientEventId, contentType, mediaBase64);
  } catch (error) {
    console.warn('[RMW Splice Capture] unexpected error fetching asset bytes', { error: error?.message || error, clientEventId });
  }
}

// Extracts the ~64-char hex sample hash from the "source" file's url/path,
// e.g. ".../audio_samples/12908ad00dc905834dc604243940d138b4247ae4bd96f7c622934507cd971e08?..."
// The character class naturally stops at the first non-hex character (?, -,
// /), so no separate trimming is needed.
const SPLICE_SAMPLE_HASH_RE = /audio_samples\/([0-9a-f]{16,})/i;

function extractSpliceSampleHash(urlOrPath) {
  if (!urlOrPath || typeof urlOrPath !== 'string') return null;
  const match = SPLICE_SAMPLE_HASH_RE.exec(urlOrPath);
  return match ? match[1] : null;
}

// ---- Report the matched row as one capture event. Payload fields are
// exactly the confirmed-real ones - no sample id/uuid/BPM/key/pack-name is
// invented, since none was observed anywhere in the response. ----

async function reportSpliceDownloadEvent(sourceFile, previewFile, arm) {
  const sourceUrl = typeof sourceFile?.url === 'string' ? sourceFile.url : null;
  const previewMp3Url = typeof previewFile?.url === 'string' ? previewFile.url : null;
  const sampleHash = extractSpliceSampleHash(sourceUrl || sourceFile?.path || '');

  // Fire the asset fetch FIRST, before awaiting the metadata report below -
  // the source URL's signed link expires in only ~119 seconds, the shortest
  // of any provider built this session, so this cannot wait on anything
  // else finishing first. pushSpliceDownloadMedia's own retry-on-
  // "download_not_found" logic already covers the case where this push
  // reaches the backend before the metadata event below has landed.
  if (sourceUrl) fetchAndPushSpliceAssetMedia(sourceUrl, arm.clientEventId);

  try {
    const result = await spliceSendRuntimeMessage({
      type: 'SPLICE_CAPTURE_EVENT',
      event: {
        event_type: 'download_click',
        client_event_id: arm.clientEventId,
        payload: {
          sourceUrl,
          previewMp3Url,
          assetTitle: arm.buttonTitle || null,
          sampleHash,
          sourceHost: window.location.hostname.replace(/^www\./, ''),
          pageUrl: window.location.href,
          downloadedAt: new Date().toISOString(),
        },
        capture_version: 1,
        linked_task_id: arm.selection?.taskId ?? null,
        linked_client_id: arm.selection?.clientId ?? null,
      },
    });
    if (result?.ok) {
      console.debug('[RMW Splice Capture] reported download event', { clientEventId: arm.clientEventId, queued: result.queued });
      setSpliceCaptureStatus('Queued for upload…', { autoHideMs: 6000 });
    } else {
      console.warn('[RMW Splice Capture] failed to report download event', { error: result?.error });
      setSpliceCaptureStatus(`Capture failed: ${result?.error || 'unknown error'}`, { autoHideMs: 8000 });
    }
  } catch (error) {
    console.warn('[RMW Splice Capture] unexpected error reporting download event', { error: error?.message || error });
  }
}

function onSpliceNetworkMessage(event) {
  if (event.source !== window) return;
  const data = event.data;
  if (!data || data.source !== 'rmw-splice-network-telemetry') return;
  if (data.type !== 'SPLICE_NETWORK_GRAPHQL_ASSET_FILES') return;

  const files = data.payload?.files;
  if (!Array.isArray(files) || !files.length) return;

  if (!splicePendingArms.length) {
    console.debug('[RMW Splice Capture] observed a graphql asset.files response with no pending arm to match - dropped (preview/browse action)');
    return;
  }

  const sourceFile = files.find((file) => file && file.asset_file_type_slug === 'source');
  if (!sourceFile) {
    console.debug('[RMW Splice Capture] graphql asset.files response had no "source" entry - dropped');
    return;
  }

  const arm = takeOldestSpliceArm();
  if (!arm) return; // race: another handler already consumed the last arm

  const previewFile = files.find((file) => file && file.asset_file_type_slug === 'preview_mp3');
  reportSpliceDownloadEvent(sourceFile, previewFile, arm);
}

window.addEventListener('message', onSpliceNetworkMessage);

// ---- Task/Client Mapping gate - same block/re-dispatch-synthetic-click
// technique as content-epidemicsound-capture.js's
// runEpidemicSoundDownloadTaskGate: the bypass branch arms a pending
// capture instead of reporting immediately, since the actual report waits
// for a matching graphql asset.files relay. ----

let spliceGateBypassTarget = null;
let spliceGateModalOpen = false;

async function runSpliceDownloadTaskGate(target, buttonTitle) {
  if (spliceGateModalOpen) return; // double-click Download while the modal is already open - no-op
  spliceGateModalOpen = true;
  try {
    const selection = await openSpliceTaskSelectionModal();
    if (!selection) return; // cancelled/ESC/no active tasks - click stays blocked
    armSpliceDownload(selection, buttonTitle);
    spliceGateBypassTarget = target;
    target.click();
  } finally {
    spliceGateModalOpen = false;
  }
}

document.addEventListener('click', (event) => {
  try {
    const target = spliceFindDownloadButton(event.target);
    if (!target) return;

    if (spliceGateBypassTarget === target) {
      spliceGateBypassTarget = null; // one-shot: next Download click gates again
      return; // already armed (see runSpliceDownloadTaskGate) - let the re-dispatched click reach Splice's own handler
    }

    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    const buttonTitle = extractSpliceButtonTitle(target); // captured now - target may not be queryable once the graphql relay arrives
    runSpliceDownloadTaskGate(target, buttonTitle);
  } catch {}
}, true); // capturing phase - fires even if the page's own handler stops propagation
