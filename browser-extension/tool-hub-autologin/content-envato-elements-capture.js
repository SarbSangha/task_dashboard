// content-envato-elements-capture.js — Envato Elements Download Capture
// (isolated world, elements.envato.com only).
//
// Envato Elements is the stock-asset subscription marketplace (photos,
// videos, graphic templates, music, fonts) - a completely different product
// from app.envato.com's AI generation tools, reached at a different host
// with its own DOM. Downloading an EXISTING (not user-generated) stock
// asset here has no `itemUuid` at all, so it's captured as its own
// EnvatoDownload row (see backend/providers/envato/models.py's
// EnvatoDownload docstring) rather than folded into generation capture.
//
// Its own file, not appended to content-envato-capture.js (which is
// app.envato.com-only and carries generation-specific arm/reconciliation
// state that has no meaning here), and not appended to content-envato.js
// (the login-automation script - see the real incident where running that
// script on a host it wasn't meant for caused a login redirect loop; this
// file follows the same "one file per host-appropriate concern" discipline
// that fixed it). Self-contained utility copies, same reasoning as
// content-envato-capture.js's own header comment.
//
// Loaded alongside content-envato-task-api.js/content-envato-task-modal.js
// in the same manifest.json content_scripts block (elements.envato.com),
// so openEnvatoTaskSelectionModal()/fetchMyActiveEnvatoTasks()/
// fetchActiveEnvatoClients() are already in scope here - reused as-is, not
// redefined.
//
// Built without a confirmed HAR/DOM sample of Envato Elements' own Download
// button (unlike the AI-generation capture, which was built from a real
// captured HAR) - the click-detection heuristic and asset-info scrape below
// are best-effort, same posture Freepik's own download capture shipped with
// before its DOM was confirmed. Tighten once real interaction is observed.

function envatoElementsSendRuntimeMessage(message) {
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

function envatoElementsIsVisible(element) {
  if (!element) return false;
  const rect = element.getBoundingClientRect();
  const style = window.getComputedStyle(element);
  return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
}

function envatoElementsIsDisabled(element) {
  if (!element) return true;
  return Boolean(
    element.disabled
    || element.getAttribute('aria-disabled') === 'true'
    || element.getAttribute('disabled') !== null
  );
}

const ENVATO_ELEMENTS_ACTION_SELECTORS = ['button', 'input[type="submit"]', 'a[href]', '[role="button"]'];
const ENVATO_ELEMENTS_GATE_EXCLUDED_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT', 'OPTION']);

function envatoElementsCollectUniqueElements(elements) {
  return Array.from(new Set(elements.filter(Boolean)));
}

// ---- On-page capture status badge ----

let envatoElementsCaptureStatusHideTimer = null;

function ensureEnvatoElementsCaptureStatusBadge() {
  const existing = document.getElementById('rmw-envato-elements-capture-status');
  if (existing) return existing;
  const badge = document.createElement('div');
  badge.id = 'rmw-envato-elements-capture-status';
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

function setEnvatoElementsCaptureStatus(message, { autoHideMs } = {}) {
  const badge = ensureEnvatoElementsCaptureStatusBadge();
  badge.textContent = `Envato Elements capture\n${message}`;
  badge.style.display = 'block';
  if (envatoElementsCaptureStatusHideTimer) {
    window.clearTimeout(envatoElementsCaptureStatusHideTimer);
    envatoElementsCaptureStatusHideTimer = null;
  }
  if (autoHideMs) {
    envatoElementsCaptureStatusHideTimer = window.setTimeout(() => { badge.style.display = 'none'; }, autoHideMs);
  }
}

// ---- Generic "was this click a Download action" detector - same
// nearest-button-ancestor text-match heuristic as the Generate detector in
// content-envato-capture.js/content-freepik.js, matched against "download"
// instead. ----

function findEnvatoElementsButtonAncestor(element) {
  let current = element;
  while (current && current !== document.body) {
    if (
      !ENVATO_ELEMENTS_GATE_EXCLUDED_TAGS.has(current.tagName)
      && current.matches?.(ENVATO_ELEMENTS_ACTION_SELECTORS.join(','))
      && envatoElementsIsVisible(current)
      && !envatoElementsIsDisabled(current)
    ) {
      return current;
    }
    current = current.parentElement;
  }
  return null;
}

function collectEnvatoElementsInteractionCandidateElements(target) {
  const path = typeof target?.composedPath === 'function' ? target.composedPath() : [];
  const pathElements = path.filter((node) => node?.nodeType === Node.ELEMENT_NODE);
  const fallback = [];
  let current = target?.nodeType === Node.ELEMENT_NODE ? target : target?.parentElement;
  let depth = 0;
  while (current && current !== document.body && depth < 8) {
    fallback.push(current);
    current = current.parentElement;
    depth += 1;
  }
  return envatoElementsCollectUniqueElements([...pathElements, ...fallback]);
}

function envatoElementsButtonDescriptorText(element) {
  if (!element) return '';
  const parts = [
    element.innerText, element.textContent,
    element.getAttribute?.('aria-label'), element.getAttribute?.('title'),
    element.getAttribute?.('data-testid'),
  ];
  element.querySelectorAll?.('img[alt],[aria-label],[title]').forEach((node) => {
    parts.push(node.getAttribute?.('alt'), node.getAttribute?.('aria-label'), node.getAttribute?.('title'));
  });
  return parts.filter(Boolean).join(' ').trim().toLowerCase();
}

// Reported live, 2026-08-14: the text-only detector below never fires for
// Music/Sound Effects downloads - "pop up unable to show" for those
// categories specifically, while Photos/Video/Graphics worked. Root cause is
// almost certainly the same one content-envato-capture.js already hit and
// fixed for app.envato.com's OWN Download button (see that file's "Confirmed
// via a captured DOM+Network trace" comment): Envato's real Download control
// is icon-only, an SVG glyph with no visible/accessible text at all, carried
// instead on a `data-cy="item-action-download"` attribute - a stable,
// deliberate test-hook, unlike the build-hashed CSS module classnames next to
// it. That was confirmed on app.envato.com's /search/* route specifically,
// NOT this file's own elements.envato.com host - Envato Elements' music/audio
// row markup has never actually been captured (see this file's own top
// comment), so this is an informed bet on shared component-library
// conventions across Envato's properties, not a confirmed fix. Tried FIRST,
// same priority order as the confirmed app.envato.com version; the text
// matcher below remains as a fallback for whatever card types (if any) DO
// carry visible text.
function findEnvatoElementsDownloadDataCyTarget(target) {
  const el = target?.nodeType === Node.ELEMENT_NODE ? target : target?.parentElement;
  return el?.closest?.('[data-cy="item-action-download"], [data-cy^="item-action-download"]') || null;
}

function findEnvatoElementsDownloadActionTarget(target) {
  const candidates = envatoElementsCollectUniqueElements(
    collectEnvatoElementsInteractionCandidateElements(target).map((element) => findEnvatoElementsButtonAncestor(element))
  );
  for (const candidate of candidates) {
    if (!candidate) continue;
    const text = envatoElementsButtonDescriptorText(candidate);
    if (!text || text.length > 60) continue;
    if (!/(^|\s)download($|\s)/i.test(text)) continue;
    return candidate;
  }
  return null;
}

// DIAGNOSTIC (2026-08-14): the data-cy bet above is unconfirmed for this
// host - logs every click on anything that LOOKS download-related (by
// data-cy, aria-label/title/text, or a nearby SVG "download" icon use-href)
// so the real markup shows up in the console the next time a Music/Sound
// Effects download is attempted, confirmed or not. Remove once confirmed.
function envatoElementsDescribeDiagnosticClick(element) {
  if (!element) return null;
  const dataCy = element.getAttribute?.('data-cy') || '';
  const text = envatoElementsButtonDescriptorText(element);
  const svgUseHref = element.querySelector?.('svg use')?.getAttribute?.('href')
    || element.querySelector?.('svg use')?.getAttribute?.('xlink:href') || '';
  const looksRelevant = /download/i.test(dataCy) || /download/i.test(text) || /download/i.test(svgUseHref);
  if (!looksRelevant) return null;
  return {
    tag: element.tagName,
    dataCy: dataCy || null,
    text: text || null,
    svgUseHref: svgUseHref || null,
    outerHTML: `${element.outerHTML || ''}`.slice(0, 500),
  };
}

document.addEventListener('click', (event) => {
  try {
    const path = typeof event.composedPath === 'function' ? event.composedPath() : [];
    const candidates = (path.length ? path : [event.target]).filter((node) => node?.nodeType === Node.ELEMENT_NODE).slice(0, 8);
    for (const el of candidates) {
      const info = envatoElementsDescribeDiagnosticClick(el);
      if (info) {
        console.debug('[RMW Envato Elements Capture] click on a download-related element', info);
        break;
      }
    }
  } catch {}
}, true);

// Walking up parentElement until an ancestor CONTAINS an <img> - same
// technique content-envato-capture.js's confirmed findEnvatoDownloadCardContainer
// uses for app.envato.com's identically build-hashed-classname card markup
// (`[class*="card" i]` never matches Envato's real DOM - see that function's
// own comment). A Music/Sound Effects row may have no <img> anywhere at all
// (a waveform/play control instead of a thumbnail, unlike Photos/Video) -
// this still terminates gracefully at the walk's depth limit, falling
// through to the document.title fallback below rather than throwing.
function findEnvatoElementsDownloadCardContainer(button) {
  let current = button.parentElement;
  let depth = 0;
  while (current && current !== document.body && depth < 10) {
    if (current.querySelector?.('img')) return current;
    current = current.parentElement;
    depth += 1;
  }
  return button.parentElement || button;
}

function extractEnvatoElementsImageUrl(img) {
  if (!img) return null;
  const direct = img.currentSrc || img.getAttribute('src');
  if (direct && !direct.startsWith('data:')) return direct;
  const lazySrc = img.getAttribute('data-src');
  if (lazySrc) return lazySrc;
  const srcset = img.getAttribute('srcset') || img.getAttribute('data-srcset');
  if (srcset) {
    const first = srcset.split(',')[0]?.trim().split(/\s+/)[0];
    if (first) return first;
  }
  return direct || null;
}

// Best-effort scrape of whatever's visible near the clicked Download button
// - unconfirmed DOM structure for THIS host, see this file's own top
// comment. Prefers data-analytics-item_title/item_author if the button
// carries them (confirmed present on app.envato.com's equivalent button -
// see content-envato-capture.js's collectEnvatoDownloadAssetInfo - untested
// here), falling back to a nearby <img alt>/container label/document.title.
// Read BEFORE the click is re-dispatched, since the click itself may
// navigate away or alter the DOM.
function collectEnvatoElementsDownloadAssetInfo(button) {
  const container = findEnvatoElementsDownloadCardContainer(button);
  const img = container?.querySelector?.('img');
  const analyticsTitle = button.getAttribute?.('data-analytics-item_title');
  const analyticsAuthor = button.getAttribute?.('data-analytics-item_author');
  const rawTitle = analyticsTitle || img?.getAttribute('alt') || container?.getAttribute?.('aria-label') || container?.getAttribute?.('title') || document.title || null;
  const anchor = container?.querySelector?.('a[href]');
  return {
    assetTitle: rawTitle ? String(rawTitle).trim().slice(0, 2000) : null,
    assetAuthor: analyticsAuthor ? String(analyticsAuthor).trim().slice(0, 255) : null,
    assetThumbnailUrl: extractEnvatoElementsImageUrl(img),
    assetSourceUrl: anchor?.href || null,
  };
}

const ENVATO_ELEMENTS_SEARCH_PARAM_NAMES = ['term', 'query', 'q', 'search'];

function readEnvatoElementsSearchTermFromUrl(href) {
  try {
    const url = new URL(href || window.location.href);
    for (const name of ENVATO_ELEMENTS_SEARCH_PARAM_NAMES) {
      const value = url.searchParams.get(name);
      if (value && value.trim()) return value.trim();
    }
  } catch {}
  return null;
}

// ---- Media capture (real audio/video bytes for a download) ----
//
// EnvatoDownload has no stable per-item identity to key on the way
// ElevenLabs keys by history_item_id (item_uuid is null for anything
// captured on this host) - client_event_id, generated fresh for every
// reported download click below, is the correlation key instead (see
// providers/envato/schemas.py's CaptureDownloadMediaIn docstring for the
// server-side half of this). Remembering the MOST RECENT one here mirrors
// content-elevenlabs-capture.js's noteElevenlabsLastLiveReportedRow -
// ordering between the click report and the MAIN-world media observation
// isn't guaranteed, so both directions need a way to find each other.
let envatoElementsLastReportedClientEventId = null;
let envatoElementsLastReportedAt = 0;
const ENVATO_ELEMENTS_MEDIA_CORRELATION_MS = 60 * 1000;

function noteEnvatoElementsLastReportedDownload(clientEventId) {
  envatoElementsLastReportedClientEventId = clientEventId;
  envatoElementsLastReportedAt = Date.now();
}

// {pushedAt, isDownload} per clientEventId - same sticky-isDownload dedupe
// shape content-elevenlabs-capture.js's reportElevenlabsAudioCapture uses,
// including the fix for the bug reported live there 2026-08-14: a dedupe
// keyed only on "was this recently pushed" (regardless of what that push
// reported) can silently swallow a LATER confirmed-download signal that
// arrives after an earlier non-download push already succeeded. Built with
// that fix from the start here rather than repeating the incident.
const envatoElementsRecentlyPushedMedia = new Map();
const ENVATO_ELEMENTS_MEDIA_PUSH_DEDUPE_MS = 60000;
const ENVATO_ELEMENTS_MEDIA_PUSH_MAX_ATTEMPTS = 4;
const ENVATO_ELEMENTS_MEDIA_PUSH_RETRY_DELAY_MS = 4000; // 4s, 8s, 12s

async function reportEnvatoElementsDownloadMedia(payload, clientEventId, attempt = 1) {
  const audioBase64 = payload?.audioBase64;
  if (!clientEventId || !audioBase64) return;
  const isDownload = Boolean(payload.isDownload);

  if (attempt === 1) {
    const now = Date.now();
    const last = envatoElementsRecentlyPushedMedia.get(clientEventId);
    const withinDedupeWindow = last && now - last.pushedAt < ENVATO_ELEMENTS_MEDIA_PUSH_DEDUPE_MS;
    if (withinDedupeWindow && (!isDownload || last.isDownload)) return;
  }

  try {
    const result = await envatoElementsSendRuntimeMessage({
      type: 'ENVATO_CAPTURE_DOWNLOAD_MEDIA',
      clientEventId,
      contentType: payload.contentType || 'application/octet-stream',
      audioBase64,
      isDownload,
    });
    if (result?.ok) {
      const previouslyDownload = envatoElementsRecentlyPushedMedia.get(clientEventId)?.isDownload;
      envatoElementsRecentlyPushedMedia.set(clientEventId, { pushedAt: Date.now(), isDownload: isDownload || Boolean(previouslyDownload) });
      console.debug('[RMW Envato Elements Capture] pushed download media', { clientEventId, status: result.status, attempt, isDownload });
      return;
    }
    if (result?.status === 'download_not_found' && attempt < ENVATO_ELEMENTS_MEDIA_PUSH_MAX_ATTEMPTS) {
      const delay = ENVATO_ELEMENTS_MEDIA_PUSH_RETRY_DELAY_MS * attempt;
      console.debug('[RMW Envato Elements Capture] media arrived before its download row - retrying shortly', { clientEventId, attempt, delay });
      window.setTimeout(() => reportEnvatoElementsDownloadMedia(payload, clientEventId, attempt + 1), delay);
      return;
    }
    if (result?.status !== 'download_not_found') {
      const previouslyDownload = envatoElementsRecentlyPushedMedia.get(clientEventId)?.isDownload;
      envatoElementsRecentlyPushedMedia.set(clientEventId, { pushedAt: Date.now(), isDownload: Boolean(previouslyDownload) });
    }
    console.warn('[RMW Envato Elements Capture] failed to push download media', { clientEventId, error: result?.error, status: result?.status, attempt });
  } catch (error) {
    const previouslyDownload = envatoElementsRecentlyPushedMedia.get(clientEventId)?.isDownload;
    envatoElementsRecentlyPushedMedia.set(clientEventId, { pushedAt: Date.now(), isDownload: Boolean(previouslyDownload) });
    console.warn('[RMW Envato Elements Capture] unexpected error pushing download media', { clientEventId, error: error?.message || error });
  }
}

function onEnvatoElementsNetworkMessage(event) {
  if (event.source !== window) return;
  const data = event.data;
  if (!data || data.source !== 'rmw-envato-elements-network-telemetry') return;
  if (data.type !== 'ENVATO_ELEMENTS_NETWORK_MEDIA_UNATTRIBUTED') return;

  const payload = data.payload;
  if (!payload?.audioBase64) return;

  const hasRecentClick = envatoElementsLastReportedClientEventId
    && Date.now() - envatoElementsLastReportedAt <= ENVATO_ELEMENTS_MEDIA_CORRELATION_MS;
  if (!hasRecentClick) {
    console.debug('[RMW Envato Elements Capture] media observed with no recent download click to correlate against - dropped', { isDownload: payload.isDownload });
    return;
  }
  console.debug('[RMW Envato Elements Capture] correlated media with the most recently reported download', {
    clientEventId: envatoElementsLastReportedClientEventId, isDownload: payload.isDownload,
  });
  reportEnvatoElementsDownloadMedia(payload, envatoElementsLastReportedClientEventId);
}

window.addEventListener('message', onEnvatoElementsNetworkMessage);

async function reportEnvatoElementsDownloadClick(assetInfo, selection) {
  const clientEventId = `envato:download:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
  noteEnvatoElementsLastReportedDownload(clientEventId); // set immediately - a media observation can arrive before this report's own await settles
  try {
    const result = await envatoElementsSendRuntimeMessage({
      type: 'ENVATO_CAPTURE_EVENT',
      event: {
        event_type: 'download_click',
        client_event_id: clientEventId,
        payload: {
          assetTitle: assetInfo.assetTitle,
          assetAuthor: assetInfo.assetAuthor,
          assetThumbnailUrl: assetInfo.assetThumbnailUrl,
          assetSourceUrl: assetInfo.assetSourceUrl,
          searchTerm: readEnvatoElementsSearchTermFromUrl(window.location.href),
          sourceHost: window.location.hostname.replace(/^www\./, ''),
          pageUrl: window.location.href,
          downloadedAt: new Date().toISOString(),
        },
        capture_version: 1,
        linked_task_id: selection?.taskId ?? null,
        linked_client_id: selection?.clientId ?? null,
      },
    });
    if (result?.ok) {
      console.debug('[RMW Envato Elements Capture] reported download click', { assetTitle: assetInfo.assetTitle, queued: result.queued });
      setEnvatoElementsCaptureStatus('Queued for upload…', { autoHideMs: 6000 });
    } else {
      console.warn('[RMW Envato Elements Capture] failed to report download click', { error: result?.error });
      setEnvatoElementsCaptureStatus(`Capture failed: ${result?.error || 'unknown error'}`, { autoHideMs: 8000 });
    }
  } catch (error) {
    console.warn('[RMW Envato Elements Capture] unexpected error reporting download click', { error: error?.message || error });
  }
}

// ---- Task/Client Mapping gate - same block/re-dispatch-synthetic-click
// technique as content-envato-capture.js's runEnvatoTaskGate, except the
// bypass branch reports the download directly instead of arming a
// generation-tracking session - a download's outcome IS the click itself,
// no async render to wait for. ----

let envatoElementsDownloadTaskGateBypassTarget = null;
let envatoElementsDownloadTaskGateModalOpen = false;

async function runEnvatoElementsDownloadTaskGate(target) {
  if (envatoElementsDownloadTaskGateModalOpen) return; // double-click Download while the modal is already open - no-op
  envatoElementsDownloadTaskGateModalOpen = true;
  try {
    const selection = await openEnvatoTaskSelectionModal();
    if (!selection) return; // cancelled/ESC/no active tasks - click stays blocked
    const assetInfo = collectEnvatoElementsDownloadAssetInfo(target);
    envatoElementsDownloadTaskGateBypassTarget = target;
    reportEnvatoElementsDownloadClick(assetInfo, selection);
    target.click();
  } finally {
    envatoElementsDownloadTaskGateModalOpen = false;
  }
}

document.addEventListener('click', (event) => {
  try {
    const target = findEnvatoElementsDownloadDataCyTarget(event.target) || findEnvatoElementsDownloadActionTarget(event.target);
    if (!target) return;

    if (envatoElementsDownloadTaskGateBypassTarget === target) {
      envatoElementsDownloadTaskGateBypassTarget = null; // one-shot: next Download click gates again
      return; // already reported (see runEnvatoElementsDownloadTaskGate) - let the re-dispatched click reach Envato's own handler
    }

    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    runEnvatoElementsDownloadTaskGate(target);
  } catch {}
}, true); // capturing phase - fires even if the page's own handler stops propagation
