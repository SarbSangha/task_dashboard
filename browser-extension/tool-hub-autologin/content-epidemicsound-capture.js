// content-epidemicsound-capture.js — Epidemic Sound Download Capture
// (isolated world, www.epidemicsound.com).
//
// Epidemic Sound is a stock music/sound-effects licensing library - users
// browse and DOWNLOAD pre-made tracks/sound effects, there is no "Generate"
// action. Mirrors content-envato-elements-capture.js's download-capture
// pattern (click-gate + Task/Client popup + report-on-observed-response),
// NOT the ElevenLabs/Suno generation-capture pattern (arm-and-poll a
// generation session).
//
// Its own file, loaded via its own manifest.json content_scripts entry
// (grouped only with content-epidemicsound-task-api.js/
// content-epidemicsound-task-modal.js), NOT appended to
// content-epidemicsound.js (the login-automation script). See
// content-envato-elements-capture.js's own header comment for the real
// incident this discipline traces back to: running a capture script grouped
// into a login-automation script's OWN manifest entry, on a host the login
// script wasn't built to share that way, caused a login-redirect-loop bug.
// Envato's content-envato.js/content-envato-elements-capture.js are kept as
// two separate manifest.json entries for exactly this reason, even though
// content-epidemicsound.js's own matches ARE the same host this file runs
// on (unlike Envato's split-host case) - so this file still gets its own
// entry, never content-epidemicsound.js's.
//
// Because this file's entry shares a host (and therefore an isolated-world
// global scope - Chrome shares one JS global per extension per frame across
// every content_scripts entry matching that frame, MAIN-world entries
// excepted) with content-epidemicsound.js, every top-level name here is
// namespaced "epidemicSound"/"Epidemic" rather than reusing the generic
// names content-epidemicsound.js already declares (STATE, TOOL_SLUG,
// isVisible, isDisabled, delay, findInput, sendRuntimeMessage, setStatus,
// ensureStatusBadge, start, boot, ...). Redeclaring any of those would throw
// at content-script injection time and take down BOTH scripts. Same
// discipline content-envato-elements-capture.js already uses (envatoElements
// prefix) despite living on a different host from content-envato.js - here
// it is not optional, since the hosts genuinely overlap.
//
// Unlike every other provider in this codebase, no polling/reconciliation
// walker exists here: every download is a single, synchronous,
// complete request/response pair triggered by a real user click - there is
// no "still generating, check back later" state. Capture is entirely
// event-driven: block the click, gate with the Task/Client popup, let the
// real click through, observe the resulting /download/ response via
// content-epidemicsound-network.js's postMessage relay, then report.
//
// Confirmed real traffic (2026-08-18 live DevTools capture - ground truth):
//   GET https://www.epidemicsound.com/download/?bundle=false&context=MODAL_MUSIC_DOWNLOAD&downloadId=...&is_sfx=true&qualityType=hq&queryId=...&sound_id=...&stemType=full&uiOrigin=tracklist_button&useBundler=true
//   -> { "assetUrl": "https://audiocdn.epidemicsound.com/audiofiles/mp3/....mp3?...", "remainingDownloads": 1188 }
// Confirmed real Download button DOM: <button aria-label="Download">...
// (React-generated `id` is NOT stable, not used as a selector).

function epidemicSoundSendRuntimeMessage(message) {
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

function epidemicSoundIsVisible(element) {
  if (!element) return false;
  const rect = element.getBoundingClientRect();
  const style = window.getComputedStyle(element);
  return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
}

function epidemicSoundIsDisabled(element) {
  if (!element) return true;
  return Boolean(
    element.disabled
    || element.getAttribute('aria-disabled') === 'true'
    || element.getAttribute('disabled') !== null
  );
}

// ---- On-page capture status badge - same pattern as
// content-envato-elements-capture.js's ensureEnvatoElementsCaptureStatusBadge,
// own element id so it can't collide with content-epidemicsound.js's own
// login-status badge (id: rmw-epidemic-autologin-status). ----

let epidemicSoundCaptureStatusHideTimer = null;

function ensureEpidemicSoundCaptureStatusBadge() {
  const existing = document.getElementById('rmw-epidemicsound-capture-status');
  if (existing) return existing;
  const badge = document.createElement('div');
  badge.id = 'rmw-epidemicsound-capture-status';
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

function setEpidemicSoundCaptureStatus(message, { autoHideMs } = {}) {
  const badge = ensureEpidemicSoundCaptureStatusBadge();
  badge.textContent = `Epidemic Sound capture\n${message}`;
  badge.style.display = 'block';
  if (epidemicSoundCaptureStatusHideTimer) {
    window.clearTimeout(epidemicSoundCaptureStatusHideTimer);
    epidemicSoundCaptureStatusHideTimer = null;
  }
  if (autoHideMs) {
    epidemicSoundCaptureStatusHideTimer = window.setTimeout(() => { badge.style.display = 'none'; }, autoHideMs);
  }
}

// ---- "Is this click a Download action" detector. Confirmed real DOM has a
// clean, unambiguous <button aria-label="Download"> - no icon-only-with-no-
// label trap like ElevenLabs Music had, no ambiguous-text-collision trap
// like Suno's "Create" had - so an exact aria-label match is the primary
// (and normally sufficient) path. A light text-match fallback is kept as a
// defensive backup only, not a heuristic chain like Envato Elements' (that
// host's DOM was never confirmed; this one was). ----

// Confirmed real 2026-08-18: Epidemic Sound actually has TWO separate
// "Download" controls, not one. The row-level arrow icon (aria-label=
// "Download", confirmed via the original DOM capture this file was first
// built against) is icon-only and does NOT trigger a real download at all -
// clicking it only opens Epidemic Sound's OWN "Download sound effect"
// format-selection modal (file format / Full track vs Segment). The actual
// `/download/` network request only fires when the user clicks that
// modal's own "Download" button. Gating on aria-label alone (this file's
// original approach) fired the popup on BOTH clicks, since the row icon's
// aria-label matches too - confusing and wrong, since the row click doesn't
// download anything yet.
//
// The real distinguishing signal: the row icon is icon-only (an SVG with no
// rendered text at all, only an aria-label), while the modal's Download
// button has genuine VISIBLE text ("Download"). Matching on
// innerText/textContent specifically - NOT aria-label, which
// epidemicSoundButtonDescriptorText folds in and would still catch the row
// icon - correctly excludes the row icon and correctly matches the modal
// button.
function epidemicSoundFindDownloadButton(eventTarget) {
  const startFromElement = () => (eventTarget?.nodeType === Node.ELEMENT_NODE ? eventTarget : eventTarget?.parentElement);

  let current = startFromElement();
  let depth = 0;
  while (current && current !== document.body && depth < 8) {
    if (
      (current.tagName === 'BUTTON' || current.getAttribute?.('role') === 'button')
      && epidemicSoundIsVisible(current) && !epidemicSoundIsDisabled(current)
    ) {
      const visibleText = `${current.innerText || current.textContent || ''}`.trim().toLowerCase();
      if (visibleText && visibleText.length <= 40 && /(^|\s)download($|\s)/i.test(visibleText)) {
        return current;
      }
    }
    current = current.parentElement;
    depth += 1;
  }
  return null;
}

// ---- "Is this click a Submit (Adapt) action" detector. Same "visible text
// only, never aria-label" convention epidemicSoundFindDownloadButton above
// already had to be fixed to use - confirmed real DOM (2026-08-19 DevTools
// Inspect) for the Adapt page's own submit control is
//   <button class="_applyStyleButton_1kkyu_150" aria-label="Apply" ...>
//     <span>Submit</span>
//     <svg aria-hidden="true" ...>...</svg>
//   </button>
// aria-label is "Apply" - a genuine mismatch with the visibly-rendered text
// "Submit" inside the <span> (the <svg> is aria-hidden, contributes no
// text). Matching on innerText/textContent here, exactly like the Download
// gate's fixed convention, correctly finds this button and would NOT be
// fooled by a hypothetical aria-label-only match. "submit" and "download"
// are lexically distinct, so this cannot cross-match the Download button
// (or its own gating modal's button) elsewhere on the page. ----
function epidemicSoundFindSubmitButton(eventTarget) {
  const startFromElement = () => (eventTarget?.nodeType === Node.ELEMENT_NODE ? eventTarget : eventTarget?.parentElement);

  let current = startFromElement();
  let depth = 0;
  while (current && current !== document.body && depth < 8) {
    if (
      (current.tagName === 'BUTTON' || current.getAttribute?.('role') === 'button')
      && epidemicSoundIsVisible(current) && !epidemicSoundIsDisabled(current)
    ) {
      const visibleText = `${current.innerText || current.textContent || ''}`.trim().toLowerCase();
      if (visibleText && visibleText.length <= 40 && /(^|\s)submit($|\s)/i.test(visibleText)) {
        return current;
      }
    }
    current = current.parentElement;
    depth += 1;
  }
  return null;
}

// ---- Multi-arm pending-download state machine ----
//
// Every other provider in this extension arms a single active-session
// variable and polls for a "still generating" state over minutes. Epidemic
// Sound's downloads are fast, synchronous request/response pairs, so the
// window here is short - but a user can plausibly click Download on a
// second track before the first one's /download/ response has landed, so
// this is a small FIFO array of concurrent pending arms, not one variable.
//
// Matching an incoming /download/ response to a specific arm: the request
// URL's downloadId/queryId (visible only to content-epidemicsound-network.js,
// the MAIN-world observer) would allow precise correlation, but wiring that
// id back through the re-dispatched click (which this isolated-world script
// does not control the internals of) is not straightforward. FIFO
// oldest-arm-first is the documented, accepted fallback - Epidemic Sound's
// short, synchronous request/response pairing makes cross-click misordering
// unlikely in practice.
const EPIDEMIC_SOUND_ARM_WINDOW_MS = 30 * 1000;
let epidemicSoundPendingArms = [];

function armEpidemicSoundDownload(selection) {
  const clientEventId = `epidemicsound:download:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
  const arm = { clientEventId, selection, armedAt: Date.now(), timer: null };
  arm.timer = window.setTimeout(() => {
    epidemicSoundPendingArms = epidemicSoundPendingArms.filter((item) => item !== arm);
    console.warn('[RMW Epidemic Sound Capture] pending download arm expired with no matching /download/ response observed', { clientEventId });
  }, EPIDEMIC_SOUND_ARM_WINDOW_MS);
  epidemicSoundPendingArms.push(arm);
  return arm;
}

function takeOldestEpidemicSoundArm() {
  const arm = epidemicSoundPendingArms.shift();
  if (arm) window.clearTimeout(arm.timer);
  return arm || null;
}

// ---- Media capture (real audio bytes for a download) ----
//
// Once a /download/ response is matched to its arm and reported,
// proactively fetch(assetUrl) directly - audiocdn.epidemicsound.com is a
// different host serving a publicly-fetchable signed URL, same pattern as
// ElevenLabs Music's GCS URL / Suno's cdn1.suno.ai URL, so no credentials or
// cookies are needed. Uses the SAME client_event_id as the metadata event -
// unlike Envato Elements' design, no separate "unattributed audio, correlate
// within N seconds" complexity is needed, since this file already knows the
// exact client_event_id synchronously at the moment it matches the
// /download/ response.
const epidemicSoundRecentlyPushedMedia = new Map(); // clientEventId -> { pushedAt }
const EPIDEMIC_SOUND_MEDIA_PUSH_DEDUPE_MS = 60000;
const EPIDEMIC_SOUND_MEDIA_PUSH_MAX_ATTEMPTS = 4;
const EPIDEMIC_SOUND_MEDIA_PUSH_RETRY_DELAY_MS = 4000; // 4s, 8s, 12s

function epidemicSoundArrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  const CHUNK_SIZE = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += CHUNK_SIZE) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK_SIZE));
  }
  return btoa(binary);
}

async function pushEpidemicSoundDownloadMedia(clientEventId, contentType, mediaBase64, attempt = 1) {
  if (!clientEventId || !mediaBase64) return;

  if (attempt === 1) {
    const now = Date.now();
    const last = epidemicSoundRecentlyPushedMedia.get(clientEventId);
    if (last && now - last.pushedAt < EPIDEMIC_SOUND_MEDIA_PUSH_DEDUPE_MS) return;
  }

  try {
    const result = await epidemicSoundSendRuntimeMessage({
      type: 'EPIDEMIC_CAPTURE_DOWNLOAD_MEDIA',
      clientEventId,
      contentType: contentType || 'audio/mpeg',
      audioBase64: mediaBase64,
      isDownload: true,
    });
    if (result?.ok) {
      epidemicSoundRecentlyPushedMedia.set(clientEventId, { pushedAt: Date.now() });
      console.debug('[RMW Epidemic Sound Capture] pushed download media', { clientEventId, status: result.status, attempt });
      return;
    }
    // The metadata event is enqueued through the durable outbox queue (see
    // background-epidemicsound-capture.js), which batches on a short quiet
    // timer before it actually POSTs - so the backend row this media push
    // needs to attach to may not exist yet the instant we try. Same retry
    // shape content-envato-elements-capture.js's reportEnvatoElementsDownloadMedia
    // uses for the identical race.
    if (result?.status === 'download_not_found' && attempt < EPIDEMIC_SOUND_MEDIA_PUSH_MAX_ATTEMPTS) {
      const delay = EPIDEMIC_SOUND_MEDIA_PUSH_RETRY_DELAY_MS * attempt;
      console.debug('[RMW Epidemic Sound Capture] media arrived before its download row - retrying shortly', { clientEventId, attempt, delay });
      window.setTimeout(() => pushEpidemicSoundDownloadMedia(clientEventId, contentType, mediaBase64, attempt + 1), delay);
      return;
    }
    console.warn('[RMW Epidemic Sound Capture] failed to push download media', { clientEventId, error: result?.error, status: result?.status, attempt });
  } catch (error) {
    console.warn('[RMW Epidemic Sound Capture] unexpected error pushing download media', { clientEventId, error: error?.message || error });
  }
}

async function fetchAndPushEpidemicSoundAssetMedia(assetUrl, clientEventId) {
  try {
    const response = await fetch(assetUrl);
    if (!response.ok) {
      console.warn('[RMW Epidemic Sound Capture] asset fetch failed', { status: response.status, clientEventId });
      return;
    }
    const contentType = response.headers.get('content-type') || 'audio/mpeg';
    const buffer = await response.arrayBuffer();
    if (!buffer || !buffer.byteLength) return;
    const mediaBase64 = epidemicSoundArrayBufferToBase64(buffer);
    await pushEpidemicSoundDownloadMedia(clientEventId, contentType, mediaBase64);
  } catch (error) {
    console.warn('[RMW Epidemic Sound Capture] unexpected error fetching asset bytes', { error: error?.message || error, clientEventId });
  }
}

// ---- Report the matched row (request-URL query params + response body,
// merged by content-epidemicsound-network.js) as one capture event. The
// real, human-readable title lives inside assetUrl's own
// response-content-disposition query param - passed through unparsed here,
// same "payload is opaque to the client, backend does normalization"
// convention every other provider in this codebase already follows; no
// title-parsing logic is invented here. ----

async function reportEpidemicSoundDownloadEvent(row, arm) {
  try {
    const result = await epidemicSoundSendRuntimeMessage({
      type: 'EPIDEMIC_CAPTURE_EVENT',
      event: {
        event_type: 'download_click',
        client_event_id: arm.clientEventId,
        payload: {
          ...row.queryParams,
          assetUrl: row.assetUrl,
          remainingDownloads: row.remainingDownloads,
          requestUrl: row.requestUrl,
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
      console.debug('[RMW Epidemic Sound Capture] reported download event', { clientEventId: arm.clientEventId, queued: result.queued });
      setEpidemicSoundCaptureStatus('Queued for upload…', { autoHideMs: 6000 });
    } else {
      console.warn('[RMW Epidemic Sound Capture] failed to report download event', { error: result?.error });
      setEpidemicSoundCaptureStatus(`Capture failed: ${result?.error || 'unknown error'}`, { autoHideMs: 8000 });
    }
  } catch (error) {
    console.warn('[RMW Epidemic Sound Capture] unexpected error reporting download event', { error: error?.message || error });
  }

  if (row.assetUrl) fetchAndPushEpidemicSoundAssetMedia(row.assetUrl, arm.clientEventId);
}

function onEpidemicSoundNetworkMessage(event) {
  if (event.source !== window) return;
  const data = event.data;
  if (!data || data.source !== 'rmw-epidemicsound-network-telemetry') return;

  if (data.type === 'EPIDEMIC_SOUND_NETWORK_DOWNLOAD_RESPONSE') {
    const row = data.payload;
    if (!row) return;

    const arm = takeOldestEpidemicSoundArm();
    if (!arm) {
      console.debug('[RMW Epidemic Sound Capture] observed a /download/ response with no pending arm to match - dropped', { requestUrl: row.requestUrl });
      return;
    }
    reportEpidemicSoundDownloadEvent(row, arm);
    return;
  }

  if (data.type === 'EPIDEMIC_SOUND_NETWORK_ADAPTATION') {
    const payload = data.payload;
    if (!payload) return;
    const rows = Array.isArray(payload.rows) ? payload.rows : [];
    const sessionId = payload.sessionId || getEpidemicSoundAdaptationSessionId();
    rows.forEach((row) => processEpidemicSoundAdaptationRow(row, sessionId));
  }
}

window.addEventListener('message', onEpidemicSoundNetworkMessage);

// ---- Task/Client Mapping gate - same block/re-dispatch-synthetic-click
// technique as content-envato-elements-capture.js's
// runEnvatoElementsDownloadTaskGate: the bypass branch arms a pending
// capture instead of reporting immediately, since (unlike Envato Elements)
// the actual report waits for the matching /download/ response. ----

let epidemicSoundGateBypassTarget = null;
let epidemicSoundGateModalOpen = false;

async function runEpidemicSoundDownloadTaskGate(target) {
  if (epidemicSoundGateModalOpen) return; // double-click Download while the modal is already open - no-op
  epidemicSoundGateModalOpen = true;
  try {
    const selection = await openEpidemicTaskSelectionModal();
    if (!selection) return; // cancelled/ESC/no active tasks - click stays blocked
    armEpidemicSoundDownload(selection);
    epidemicSoundGateBypassTarget = target;
    target.click();
  } finally {
    epidemicSoundGateModalOpen = false;
  }
}

document.addEventListener('click', (event) => {
  try {
    const target = epidemicSoundFindDownloadButton(event.target);
    if (!target) return;

    if (epidemicSoundGateBypassTarget === target) {
      epidemicSoundGateBypassTarget = null; // one-shot: next Download click gates again
      return; // already armed (see runEpidemicSoundDownloadTaskGate) - let the re-dispatched click reach Epidemic Sound's own handler
    }

    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    runEpidemicSoundDownloadTaskGate(target);
  } catch {}
}, true); // capturing phase - fires even if the page's own handler stops propagation

// ============================================================================
// Adapt capture (epidemicsound.com/adapt?sessionId=...) - a SECOND, separate
// capture surface, added alongside the Download-capture flow above without
// touching it. Adapt is a real AI generation (regenerates a track's stems
// from a text prompt) with its own async draft->pending->completed
// lifecycle, unlike the plain-download flow's single synchronous
// request/response pair - so this half of the file follows Suno's
// arm-and-observe generation-capture pattern (content-suno-capture.js),
// not Envato Elements'/this file's own click-gate-then-wait-for-one-response
// pattern.
//
// Identity = the version's own `id`, stable across the whole
// draft->pending->completed lifecycle (confirmed real 2026-08-19: compose
// and finalize responses for the same submission carry the same `id`). No
// split-identity problem here, unlike Suno/ElevenLabs Music.
// ============================================================================

// sessionId lives only in the page URL (?sessionId=...) - never in any
// response body. content-epidemicsound-network.js also extracts it from the
// request URL's own path segment and relays it explicitly; this local copy
// is the fallback used when arming (before any network response has been
// observed yet) and when a relayed payload is missing it for any reason.
function getEpidemicSoundAdaptationSessionId() {
  try {
    return new URL(location.href).searchParams.get('sessionId') || null;
  } catch {
    return null;
  }
}

// Best-effort only - the original track's title is not present in any
// confirmed API response. Screenshots of the real page show it rendered as
// plain visible text near the play/skip transport controls at the top of
// the /adapt page (e.g. "Shibuya Bullet Train"). No stable class/id was
// confirmed, so this is a defensive heuristic scan, not a hard selector -
// returns null rather than guessing wrong, matching how other providers'
// best-effort title scrapes are written.
function findEpidemicSoundAdaptationOriginalTrackTitle() {
  try {
    const candidates = document.querySelectorAll('h1, h2, [class*="title" i]');
    for (const el of candidates) {
      if (!epidemicSoundIsVisible(el)) continue;
      const text = `${el.textContent || ''}`.trim();
      if (text && text.length <= 120) return text;
    }
  } catch {}
  return null;
}

// ---- Row-shape helpers ----

function getEpidemicSoundAdaptationRowIdentity(row) {
  if (!row || typeof row !== 'object') return '';
  if (row.id === undefined || row.id === null || row.id === '') return '';
  return String(row.id);
}

// createdAt is stable across a version's whole draft->pending->completed
// lifecycle (unlike updatedAt, which changes on every status transition) -
// preferred here since it's used as an "older than this arm" freshness
// check below, where a value that shifts on every status flip would be the
// wrong thing to compare against armedAt.
function getEpidemicSoundAdaptationRowRawTimestamp(row) {
  if (!row || typeof row !== 'object') return null;
  const raw = row.createdAt || row.updatedAt;
  return raw ? String(raw) : null;
}

function parseEpidemicSoundAdaptationTimestampMs(raw) {
  if (raw === undefined || raw === null || raw === '') return null;
  const parsed = Date.parse(raw);
  return Number.isNaN(parsed) ? null : parsed;
}

// Only status "completed" with a real asset.previewUrl means actual audio
// exists - "draft"/"pending" carry prompt/settings data but no playable
// asset yet. Confirmed real 2026-08-19: the draft (compose) and pending
// (finalize) responses for the same version never carry asset.previewUrl at
// all; only a later "completed" snapshot (observed via the list endpoint)
// does.
function epidemicSoundAdaptationRowIsReady(row) {
  if (!row || typeof row !== 'object') return false;
  if (row.status !== 'completed') return false;
  return Boolean(row.asset && typeof row.asset.previewUrl === 'string' && row.asset.previewUrl);
}

// ---- Arm/re-qualification state machine - ported from Suno's
// evaluateSunoRowForLiveCapture/sunoActiveGeneration/capturedClipIds
// pattern (content-suno-capture.js), renamed for this surface. A version is
// very often first observed as "draft" or "pending" (no asset.previewUrl
// yet, from the compose/finalize responses that fire synchronously off the
// Submit click) well before it later shows "completed" (observed only via
// the page's own natural GET .../versions polling, passively watched by
// content-epidemicsound-network.js). Without this fix, that first
// not-ready capture would permanently mark the id "already captured this
// arm" and the later completed snapshot - the one that actually carries
// real audio - would never get a second look. ----

const EPIDEMIC_SOUND_ADAPT_ARM_MAX_DURATION_MS = 10 * 60 * 1000; // stem regeneration can run several minutes - same order of magnitude as Suno's song-generation ceiling
const EPIDEMIC_SOUND_ADAPT_ARM_QUIET_PERIOD_MS = 3 * 60 * 1000; // reset on every qualifying observation, same rolling-window design as Suno's arm
const EPIDEMIC_SOUND_ADAPT_CLOCK_SKEW_SLACK_MS = 60 * 1000;

// { sessionId, armedAt, expiresAt, capturedVersionIds: Map<id, {readyForAsset}>,
//   taskId, taskName, clientId, clientName } - null when idle.
let epidemicSoundActiveAdaptation = null;
let epidemicSoundAdaptArmQuietTimer = null;
let epidemicSoundAdaptArmMaxTimer = null;

function clearEpidemicSoundAdaptArmTimers() {
  if (epidemicSoundAdaptArmQuietTimer) { window.clearTimeout(epidemicSoundAdaptArmQuietTimer); epidemicSoundAdaptArmQuietTimer = null; }
  if (epidemicSoundAdaptArmMaxTimer) { window.clearTimeout(epidemicSoundAdaptArmMaxTimer); epidemicSoundAdaptArmMaxTimer = null; }
}

function epidemicSoundAdaptationLinkLabel(adaptation) {
  if (!adaptation) return '';
  const parts = [];
  if (adaptation.taskName) parts.push(`Task: ${adaptation.taskName}`);
  if (adaptation.clientName) parts.push(`Client: ${adaptation.clientName}`);
  return parts.length ? ` (${parts.join(', ')})` : '';
}

function disarmEpidemicSoundAdaptation() {
  clearEpidemicSoundAdaptArmTimers();
  const capturedEntries = epidemicSoundActiveAdaptation ? Array.from(epidemicSoundActiveAdaptation.capturedVersionIds.values()) : [];
  const hadCaptures = capturedEntries.length > 0;
  // Same distinction Suno's disarmSunoGeneration makes (see that function's
  // own comment): a metadata-only capture (draft/pending, no real asset yet)
  // routinely outlasts this arm window, since the page's own poll cadence
  // for the list endpoint isn't controlled by this file. Saying "Capture
  // complete" there would be actively misleading.
  const hadAsset = capturedEntries.some((entry) => entry && entry.readyForAsset);
  const linkLabel = epidemicSoundAdaptationLinkLabel(epidemicSoundActiveAdaptation);
  epidemicSoundActiveAdaptation = null;
  if (hadAsset) {
    setEpidemicSoundCaptureStatus(`Capture complete ✓${linkLabel}`, { autoHideMs: 6000 });
  } else if (hadCaptures) {
    setEpidemicSoundCaptureStatus(`Prompt captured - adaptation still generating…${linkLabel}`, { autoHideMs: 8000 });
  }
}

function scheduleEpidemicSoundAdaptArmQuietReset() {
  if (epidemicSoundAdaptArmQuietTimer) window.clearTimeout(epidemicSoundAdaptArmQuietTimer);
  epidemicSoundAdaptArmQuietTimer = window.setTimeout(disarmEpidemicSoundAdaptation, EPIDEMIC_SOUND_ADAPT_ARM_QUIET_PERIOD_MS);
}

function isEpidemicSoundAdaptationArmed() {
  return Boolean(epidemicSoundActiveAdaptation) && Date.now() <= epidemicSoundActiveAdaptation.expiresAt;
}

function armEpidemicSoundAdaptation(selection) {
  const now = Date.now();

  if (isEpidemicSoundAdaptationArmed()) {
    // A second Submit click while still waiting on a prior one extends the
    // existing session rather than resetting capturedVersionIds - same
    // design as Suno's armSunoGeneration.
    if (selection) {
      epidemicSoundActiveAdaptation.taskId = selection.taskId;
      epidemicSoundActiveAdaptation.taskName = selection.taskName;
      epidemicSoundActiveAdaptation.clientId = selection.clientId;
      epidemicSoundActiveAdaptation.clientName = selection.clientName;
    }
    scheduleEpidemicSoundAdaptArmQuietReset();
    setEpidemicSoundCaptureStatus(`Waiting for generation…${epidemicSoundAdaptationLinkLabel(epidemicSoundActiveAdaptation)}`);
    return;
  }

  clearEpidemicSoundAdaptArmTimers();
  epidemicSoundActiveAdaptation = {
    sessionId: getEpidemicSoundAdaptationSessionId(),
    armedAt: now,
    expiresAt: now + EPIDEMIC_SOUND_ADAPT_ARM_MAX_DURATION_MS,
    capturedVersionIds: new Map(),
    taskId: selection?.taskId ?? null,
    taskName: selection?.taskName ?? null,
    clientId: selection?.clientId ?? null,
    clientName: selection?.clientName ?? null,
  };
  epidemicSoundAdaptArmMaxTimer = window.setTimeout(disarmEpidemicSoundAdaptation, EPIDEMIC_SOUND_ADAPT_ARM_MAX_DURATION_MS);
  scheduleEpidemicSoundAdaptArmQuietReset();
  setEpidemicSoundCaptureStatus(`Waiting for generation…${epidemicSoundAdaptationLinkLabel(epidemicSoundActiveAdaptation)}`);
}

function evaluateEpidemicSoundAdaptationRowForLiveCapture(row) {
  const identityValue = getEpidemicSoundAdaptationRowIdentity(row);
  if (!identityValue) return { qualifies: false, reason: 'no_identity' };
  if (!isEpidemicSoundAdaptationArmed()) return { qualifies: false, reason: 'not_armed' };

  const readyForAsset = epidemicSoundAdaptationRowIsReady(row);
  const previousCapture = epidemicSoundActiveAdaptation.capturedVersionIds.get(identityValue);
  // Once-per-identity-per-arm for everything EXCEPT a row whose first-ever
  // capture happened before it was ready - that one gets exactly one more
  // pass once asset.previewUrl actually shows up, so the proactive media
  // fetch below actually gets to run. Ported directly from Suno's
  // isNewlyResolvedDownload fix (see evaluateSunoRowForLiveCapture's own
  // comment in content-suno-capture.js).
  const isNewlyResolvedAsset = Boolean(previousCapture && !previousCapture.readyForAsset && readyForAsset);
  if (previousCapture && !isNewlyResolvedAsset) {
    return { qualifies: false, reason: 'already_captured_this_session' };
  }

  // The list endpoint returns EVERY version in the whole session, not just
  // ones from this arm (see content-epidemicsound-network.js's own comment)
  // - an older, already-completed version from a prior submission would
  // otherwise look "new" to a fresh arm's empty capturedVersionIds Map and
  // get wrongly re-reported. Reject anything created before this arm
  // started, unless it's the newly-resolved-asset pass for an id THIS arm
  // already captured once (createdAt never changes between snapshots, so it
  // would otherwise wrongly fail this same check).
  if (!isNewlyResolvedAsset) {
    const rawTimestamp = getEpidemicSoundAdaptationRowRawTimestamp(row);
    const timestampMs = parseEpidemicSoundAdaptationTimestampMs(rawTimestamp);
    if (timestampMs !== null && timestampMs < epidemicSoundActiveAdaptation.armedAt - EPIDEMIC_SOUND_ADAPT_CLOCK_SKEW_SLACK_MS) {
      return { qualifies: false, reason: 'older_than_arm' };
    }
  }

  return { qualifies: true, identityValue, readyForAsset };
}

// ---- Media capture (real audio bytes for a completed adaptation) ----
//
// Once a version is observed status "completed" with asset.previewUrl
// present, proactively fetch() that URL directly - audiocdn.epidemicsound.com
// is the SAME public-signed-URL host the Download flow's assetUrl already
// uses (see fetchAndPushEpidemicSoundAssetMedia above), so no credentials or
// cookies are needed here either. Uses the SAME client_event_id as the
// metadata event, exactly like the Download flow's media push.

const epidemicSoundRecentlyPushedAdaptationMedia = new Map(); // clientEventId -> { pushedAt }
const EPIDEMIC_SOUND_ADAPT_MEDIA_PUSH_DEDUPE_MS = 60000;
const EPIDEMIC_SOUND_ADAPT_MEDIA_PUSH_MAX_ATTEMPTS = 4;
const EPIDEMIC_SOUND_ADAPT_MEDIA_PUSH_RETRY_DELAY_MS = 4000; // 4s, 8s, 12s

async function pushEpidemicSoundAdaptationMedia(clientEventId, contentType, mediaBase64, attempt = 1) {
  if (!clientEventId || !mediaBase64) return;

  if (attempt === 1) {
    const now = Date.now();
    const last = epidemicSoundRecentlyPushedAdaptationMedia.get(clientEventId);
    if (last && now - last.pushedAt < EPIDEMIC_SOUND_ADAPT_MEDIA_PUSH_DEDUPE_MS) return;
  }

  try {
    const result = await epidemicSoundSendRuntimeMessage({
      type: 'EPIDEMIC_CAPTURE_ADAPTATION_MEDIA',
      clientEventId,
      contentType: contentType || 'audio/mpeg',
      audioBase64: mediaBase64,
      isDownload: false, // a generated/adapted asset, not a plain download click - see background-epidemicsound-capture.js's handleEpidemicCaptureAdaptationMediaMessage
    });
    if (result?.ok) {
      epidemicSoundRecentlyPushedAdaptationMedia.set(clientEventId, { pushedAt: Date.now() });
      console.debug('[RMW Epidemic Sound Capture] pushed adaptation media', { clientEventId, status: result.status, attempt });
      return;
    }
    // Same race the Download flow's pushEpidemicSoundDownloadMedia already
    // documents: the metadata event is enqueued through the durable outbox
    // queue, which batches on a short quiet timer before it actually POSTs -
    // so the backend row this media push needs to attach to may not exist
    // yet the instant we try. Retry a few times on a "row not found yet"
    // outcome before giving up.
    if (result?.status === 'adaptation_not_found' && attempt < EPIDEMIC_SOUND_ADAPT_MEDIA_PUSH_MAX_ATTEMPTS) {
      const delay = EPIDEMIC_SOUND_ADAPT_MEDIA_PUSH_RETRY_DELAY_MS * attempt;
      console.debug('[RMW Epidemic Sound Capture] adaptation media arrived before its version row - retrying shortly', { clientEventId, attempt, delay });
      window.setTimeout(() => pushEpidemicSoundAdaptationMedia(clientEventId, contentType, mediaBase64, attempt + 1), delay);
      return;
    }
    console.warn('[RMW Epidemic Sound Capture] failed to push adaptation media', { clientEventId, error: result?.error, status: result?.status, attempt });
  } catch (error) {
    console.warn('[RMW Epidemic Sound Capture] unexpected error pushing adaptation media', { clientEventId, error: error?.message || error });
  }
}

async function fetchAndPushEpidemicSoundAdaptationMedia(assetUrl, clientEventId) {
  if (!assetUrl) return;
  try {
    const response = await fetch(assetUrl);
    if (!response.ok) {
      console.warn('[RMW Epidemic Sound Capture] adaptation asset fetch failed', { status: response.status, clientEventId });
      return;
    }
    const contentType = response.headers.get('content-type') || 'audio/mpeg';
    const buffer = await response.arrayBuffer();
    if (!buffer || !buffer.byteLength) return;
    const mediaBase64 = epidemicSoundArrayBufferToBase64(buffer); // shared helper, defined above for the Download flow
    await pushEpidemicSoundAdaptationMedia(clientEventId, contentType, mediaBase64);
  } catch (error) {
    console.warn('[RMW Epidemic Sound Capture] unexpected error fetching adaptation asset bytes', { error: error?.message || error, clientEventId });
  }
}

// ---- Report the matched row as one capture event. Payload is opaque to
// this client - the full raw row is relayed unparsed, plus the explicit
// sessionId (the backend cannot derive it from the response bodies alone -
// see this file's own getEpidemicSoundAdaptationSessionId comment) and a
// best-effort originalTrackTitle. No prompt-parsing logic is invented here,
// matching every other provider's "backend does normalization" convention. ----

async function reportEpidemicSoundAdaptationRow(row, sessionId) {
  const identityValue = getEpidemicSoundAdaptationRowIdentity(row);
  if (!identityValue) return;

  const status = typeof row?.status === 'string' ? row.status : 'unknown';
  // Incorporates status so a later re-capture of the same id with a NEW
  // status (e.g. draft -> completed) is treated as a distinct event, while
  // the backend's NORMALIZED row identity (version_id alone, per the build
  // instructions this file was written against) still upserts correctly
  // either way - safe regardless of which side is right.
  const clientEventId = `epidemicsound:adaptation:${identityValue}:${status}`;

  try {
    const result = await epidemicSoundSendRuntimeMessage({
      type: 'EPIDEMIC_CAPTURE_EVENT',
      event: {
        // Must match backend's EVENT_TYPE_ADAPTATION_VERSION exactly - see
        // this file's own header discipline (and the identical incident
        // this codebase already hit once with Suno's capture pipeline: a
        // mismatched event_type string silently drops every event with no
        // visible error).
        event_type: 'adaptation_version',
        client_event_id: clientEventId,
        payload: {
          ...row,
          sessionId: sessionId || row?.sessionId || null,
          originalTrackTitle: findEpidemicSoundAdaptationOriginalTrackTitle(),
          sourceHost: window.location.hostname.replace(/^www\./, ''),
          pageUrl: window.location.href,
          observedAt: new Date().toISOString(),
        },
        capture_version: 1,
        linked_task_id: epidemicSoundActiveAdaptation?.taskId ?? null,
        linked_client_id: epidemicSoundActiveAdaptation?.clientId ?? null,
      },
    });
    if (result?.ok) {
      console.debug('[RMW Epidemic Sound Capture] reported adaptation version', { identityValue, status, queued: result.queued });
      setEpidemicSoundCaptureStatus('Capturing…');
    } else {
      console.warn('[RMW Epidemic Sound Capture] failed to report adaptation version', { identityValue, status, error: result?.error });
      setEpidemicSoundCaptureStatus(`Capture failed: ${result?.error || 'unknown error'}`, { autoHideMs: 8000 });
    }
  } catch (error) {
    console.warn('[RMW Epidemic Sound Capture] unexpected error reporting adaptation version', { identityValue, error: error?.message || error });
  }

  if (epidemicSoundAdaptationRowIsReady(row)) {
    fetchAndPushEpidemicSoundAdaptationMedia(row.asset.previewUrl, clientEventId);
  }
}

function processEpidemicSoundAdaptationRow(row, sessionId) {
  const evaluation = evaluateEpidemicSoundAdaptationRowForLiveCapture(row);
  if (!evaluation.qualifies) {
    console.debug('[RMW Epidemic Sound Capture] ignored non-qualifying adaptation row', {
      identity: getEpidemicSoundAdaptationRowIdentity(row), reason: evaluation.reason,
    });
    return;
  }
  epidemicSoundActiveAdaptation.capturedVersionIds.set(evaluation.identityValue, { readyForAsset: Boolean(evaluation.readyForAsset) });
  scheduleEpidemicSoundAdaptArmQuietReset(); // this counts as recent activity - extend the window
  console.debug('[RMW Epidemic Sound Capture] qualifying adaptation row - reporting as live', { identity: evaluation.identityValue });
  reportEpidemicSoundAdaptationRow(row, sessionId);
}

// ---- Task/Client Mapping gate for the Submit button - reuses the SAME
// modal functions the Download gate above already uses (openEpidemicTaskSelectionModal,
// from content-epidemicsound-task-modal.js/content-epidemicsound-task-api.js),
// same block/re-dispatch-synthetic-click/one-shot-bypass-target technique.
// Unlike the Download gate, the bypass branch arms the generation state
// machine above (not a FIFO response-matching arm), since there is no
// single request/response pair to wait for here - the real signal is the
// page's own later natural poll of the list endpoint. ----

let epidemicSoundAdaptGateBypassTarget = null;
let epidemicSoundAdaptGateModalOpen = false;

// Real-money safety net: confirmed live (two DB rows, ~20s apart, same
// session/track/task/client, two DIFFERENT version ids, both fully
// completed) - clicking Submit again while a prior adaptation for this
// session is still genuinely generating re-dispatches a real click to
// Epidemic Sound's own Submit button, which mints a genuinely SEPARATE
// version on Epidemic Sound's backend - a second, independently-billed
// generation (ADAPTATION_CREDITS_FLAT_RATE, confirmed 1000 credits, per
// submission). The capturedVersionIds dedup elsewhere only prevents us from
// double-REPORTING one version to our own backend; it does nothing to stop
// the user from actually generating twice.
//
// Deliberately keyed on "any captured version not yet readyForAsset", NOT
// isEpidemicSoundAdaptationArmed() alone: the arm stays armed for up to
// EPIDEMIC_SOUND_ADAPT_ARM_QUIET_PERIOD_MS (3 min) of bookkeeping AFTER a
// version has already fully completed (see scheduleEpidemicSoundAdaptArmQuietReset
// being called on every qualifying capture, completed included) - gating on
// "armed" alone warned on every routine next-track submission made within
// that lingering window, not just genuine still-in-flight resubmission.
function epidemicSoundAdaptationHasInFlightCapture() {
  if (!isEpidemicSoundAdaptationArmed()) return false;
  const entries = Array.from(epidemicSoundActiveAdaptation.capturedVersionIds.values());
  return entries.some((entry) => entry && !entry.readyForAsset);
}

// Own Shadow DOM dialog rather than window.confirm(): a native confirm() is
// synchronous/blocking and, critically, Chrome silently auto-suppresses ALL
// further confirm()/alert() calls from a page once the user has dismissed a
// couple of them in quick succession ("Prevent this page from creating
// additional dialogs") - after that point confirm() returns false with no
// visible dialog at all, which would silently block every future Submit
// through this gate, not just the intended double-submission case. Mirrors
// content-epidemicsound-task-modal.js's own Shadow DOM host/overlay pattern
// and reuses its stylesheet (epidemicTaskModalStyles(), a plain top-level
// function in the same shared isolated-world scope) for visual consistency.
const EPIDEMIC_ADAPT_CONFIRM_HOST_ID = 'rmw-epidemicsound-adapt-confirm-host';

function showEpidemicSoundAdaptationDoubleSubmitConfirm() {
  return new Promise((resolve) => {
    document.getElementById(EPIDEMIC_ADAPT_CONFIRM_HOST_ID)?.remove();

    const host = document.createElement('div');
    host.id = EPIDEMIC_ADAPT_CONFIRM_HOST_ID;
    const shadow = host.attachShadow({ mode: 'open' });

    const style = document.createElement('style');
    style.textContent = epidemicTaskModalStyles();
    shadow.appendChild(style);

    const overlay = document.createElement('div');
    overlay.className = 'rmw-overlay';
    overlay.setAttribute('role', 'presentation');

    const dialog = document.createElement('div');
    dialog.className = 'rmw-dialog';
    dialog.setAttribute('role', 'alertdialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-labelledby', 'rmw-adapt-confirm-title');
    overlay.appendChild(dialog);

    dialog.innerHTML = `
      <div class="rmw-header">
        <p class="rmw-title" id="rmw-adapt-confirm-title">Generation still in progress</p>
      </div>
      <div class="rmw-body" style="padding: 4px 20px 12px; font-size: 13px; line-height: 1.5; color: #c7cbdc;">
        An adaptation for this track is still generating. Submitting again will start a
        <strong>SEPARATE</strong> generation and use another 1,000 credits.
      </div>
      <div class="rmw-footer">
        <button type="button" class="rmw-btn rmw-btn-cancel">Cancel</button>
        <button type="button" class="rmw-btn rmw-btn-continue">Submit anyway</button>
      </div>
    `;

    shadow.appendChild(overlay);
    (document.body || document.documentElement).appendChild(host);

    const cancelBtn = shadow.querySelector('.rmw-btn-cancel');
    const continueBtn = shadow.querySelector('.rmw-btn-continue');

    let closed = false;
    function close(result) {
      if (closed) return;
      closed = true;
      document.removeEventListener('keydown', onKeyDown, true);
      host.remove();
      resolve(result);
    }
    function onKeyDown(event) {
      if (event.key === 'Escape') { event.preventDefault(); close(false); }
      if (event.key === 'Enter') { event.preventDefault(); close(true); }
    }
    document.addEventListener('keydown', onKeyDown, true);
    cancelBtn.addEventListener('click', () => close(false));
    continueBtn.addEventListener('click', () => close(true));
    overlay.addEventListener('mousedown', (event) => {
      if (event.target === overlay) close(false);
    });
  });
}

async function runEpidemicSoundAdaptationTaskGate(target) {
  if (epidemicSoundAdaptGateModalOpen) return; // double-click Submit while the modal is already open - no-op

  if (epidemicSoundAdaptationHasInFlightCapture()) {
    const confirmed = await showEpidemicSoundAdaptationDoubleSubmitConfirm();
    if (!confirmed) return;
  }

  epidemicSoundAdaptGateModalOpen = true;
  try {
    const selection = await openEpidemicTaskSelectionModal();
    if (!selection) return; // cancelled/ESC/no active tasks - click stays blocked
    armEpidemicSoundAdaptation(selection);
    epidemicSoundAdaptGateBypassTarget = target;
    target.click();
  } finally {
    epidemicSoundAdaptGateModalOpen = false;
  }
}

document.addEventListener('click', (event) => {
  try {
    const target = epidemicSoundFindSubmitButton(event.target);
    if (!target) return;

    if (epidemicSoundAdaptGateBypassTarget === target) {
      epidemicSoundAdaptGateBypassTarget = null; // one-shot: next Submit click gates again
      return; // already armed (see runEpidemicSoundAdaptationTaskGate) - let the re-dispatched click reach Epidemic Sound's own handler
    }

    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    runEpidemicSoundAdaptationTaskGate(target);
  } catch {}
}, true); // capturing phase - fires even if the page's own handler stops propagation
