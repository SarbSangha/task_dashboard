// content-envato-capture.js — Envato Generation Capture (isolated world,
// app.envato.com only).
//
// Deliberately its OWN file rather than folded into content-envato.js (the
// autologin script, which also runs on envato.com/elements.envato.com/
// market.envato.com — hosts with no generation tools and no task-api/task-
// modal scripts loaded). Keeping capture fully separate means a bug here
// can never regress the working autologin flow, and vice versa — same goal
// content-freepik.js's "two independent halves in one file" split serves,
// achieved here with two independent FILES instead, since app.envato.com
// is a genuinely different host set than the rest of content-envato.js's
// matches. Every helper this file needs (sendRuntimeMessage, isVisible,
// isDisabled, the button-detection walk) is therefore its own local copy,
// not borrowed from content-envato.js — no assumption about cross-block
// script load order is made anywhere in this file.
//
// Three independent pieces, same split as content-freepik.js's Phase 2/5:
//   1. A relay for content-envato-network.js's (MAIN world) intercepted
//      `.data` responses — organic traffic only, reported live only while
//      armed by a real Generate click (see the arm/disarm state machine).
//   2. A reconciliation walker that pages `/generation-history.data`
//      directly (confirmed URL + body shape from a captured HAR — unlike
//      Freepik, this one is NOT a guess) using the tab's own authenticated
//      fetch() (isolated-world content scripts share the page's cookies for
//      same-origin requests, so no separate credential is needed).
//   3. A Download gate for app.envato.com's own `/search/*` stock-browse
//      flow (a real Download click there was confirmed, 2026-08-08, to
//      issue `GET /download.data?itemUuid=...&itemType=...` -
//      content-envato-network.js posts that as ENVATO_NETWORK_DOWNLOAD,
//      correlated here against the gated click for a reliable identity
//      signal - see the "Download capture" section below). A near-identical,
//      independent gate also exists for elements.envato.com in
//      content-envato-elements-capture.js, for whichever of Envato's two
//      stock-browsing surfaces a given install actually uses.
//
// The live "Generate" submission network call itself has never been
// captured (no HAR sample of it exists yet) — so unlike Freepik/Kling this
// provider cannot correlate a specific request/response pair to a click.
// Arming instead answers a simpler question: "did a new item just appear in
// generation-history whose createdAt is after the click that armed us" —
// good enough for accurate who/when/what capture, at the cost of no
// real-time "generating…" progress feedback (the row only becomes visible
// once Envato's own history reflects it).

// ---- Self-contained utility helpers (see this file's own header for why
// these are local copies, not shared with content-envato.js) ----

function envatoSendRuntimeMessage(message) {
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

function envatoIsVisible(element) {
  if (!element) return false;
  const rect = element.getBoundingClientRect();
  const style = window.getComputedStyle(element);
  return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
}

function envatoIsDisabled(element) {
  if (!element) return true;
  return Boolean(
    element.disabled
    || element.getAttribute('aria-disabled') === 'true'
    || element.getAttribute('disabled') !== null
  );
}

const ENVATO_ACTION_SELECTORS = ['button', 'input[type="submit"]', 'a[href]', '[role="button"]'];
const ENVATO_GATE_EXCLUDED_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT', 'OPTION']);

function envatoCollectUniqueElements(elements) {
  return Array.from(new Set(elements.filter(Boolean)));
}

function chromeStorageGet(keys) {
  return new Promise((resolve) => {
    try {
      chrome.storage.local.get(keys, (result) => resolve(result || {}));
    } catch {
      resolve({});
    }
  });
}

function chromeStorageSet(items) {
  return new Promise((resolve) => {
    try {
      chrome.storage.local.set(items, () => resolve(true));
    } catch {
      resolve(false);
    }
  });
}

// ---- On-page live-capture status badge ----

let envatoCaptureStatusHideTimer = null;

function ensureEnvatoCaptureStatusBadge() {
  const existing = document.getElementById('rmw-envato-capture-status');
  if (existing) return existing;
  const badge = document.createElement('div');
  badge.id = 'rmw-envato-capture-status';
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

function setEnvatoCaptureStatus(message, { autoHideMs } = {}) {
  const badge = ensureEnvatoCaptureStatusBadge();
  badge.textContent = `Envato capture\n${message}`;
  badge.style.display = 'block';
  if (envatoCaptureStatusHideTimer) {
    window.clearTimeout(envatoCaptureStatusHideTimer);
    envatoCaptureStatusHideTimer = null;
  }
  if (autoHideMs) {
    envatoCaptureStatusHideTimer = window.setTimeout(() => { badge.style.display = 'none'; }, autoHideMs);
  }
}

function hideEnvatoCaptureStatus() {
  const badge = document.getElementById('rmw-envato-capture-status');
  if (badge) badge.style.display = 'none';
}

// ---- DOM-scraped credit signals (see providers/envato/models.py's
// EnvatoGeneration docstring — no numeric ledger API exists for Envato,
// unlike Freepik, so this best-effort scrape is the only credit signal
// available at all). Both best-effort: return null, never throw, on
// anything unexpected. ----

function scrapeEnvatoQuotaRemaining() {
  try {
    const match = (document.body?.innerText || '').match(/(\d+)\s*Generations?\s+remaining/i);
    return match ? parseInt(match[1], 10) : null;
  } catch {
    return null;
  }
}

function scrapeEnvatoCreditBadgeNear(target) {
  try {
    const text = envatoButtonDescriptorText(target);
    const match = text.match(/\+\s*(\d+(?:\.\d+)?)/);
    return match ? parseFloat(match[1]) : null;
  } catch {
    return null;
  }
}

// ---- Reporting a decoded generation-history row (or {item, actions}
// wrapper — normalize_capture_event on the backend unwraps either shape,
// see providers/envato/normalization.py) to the backend ----

function envatoRowItem(row) {
  return (row && row.item) || row || {};
}

function envatoRowReviewStatus(row) {
  const actions = (row && row.actions) || envatoRowItem(row).actions;
  if (!Array.isArray(actions)) return '';
  const reviewAction = actions.find((action) => action && action.type === 'request-review');
  return reviewAction?.reviewStatus || '';
}

async function reportEnvatoGenerationRow(row, { isReconciliation }) {
  const item = envatoRowItem(row);
  const itemUuid = item.itemUuid !== undefined && item.itemUuid !== null ? String(item.itemUuid) : '';
  if (!itemUuid) return;

  // No confirmed "processing -> completed" lifecycle for Envato items (see
  // this file's header) — every observed row is already in its final
  // state — so the change token only needs to catch a download/review-status
  // update on an already-known item, not a snapshot ordering problem.
  const changeToken = `${item.isDownloaded ? '1' : '0'}:${envatoRowReviewStatus(row)}`;
  const clientEventId = `envato:${itemUuid}:${changeToken}`;

  const payload = { ...row };
  if (!isReconciliation && envatoActiveGeneration) {
    if (envatoActiveGeneration.creditsBadge != null) payload.creditsBadge = envatoActiveGeneration.creditsBadge;
    if (envatoActiveGeneration.quotaRemainingBefore != null) payload.quotaRemainingBefore = envatoActiveGeneration.quotaRemainingBefore;
    const quotaAfter = scrapeEnvatoQuotaRemaining();
    if (quotaAfter != null) payload.quotaRemainingAfter = quotaAfter;
  }

  try {
    const result = await envatoSendRuntimeMessage({
      type: 'ENVATO_CAPTURE_EVENT',
      event: {
        event_type: isReconciliation ? 'generation_listing_row' : 'generation_submitted',
        client_event_id: clientEventId,
        item_uuid: itemUuid,
        is_reconciliation: Boolean(isReconciliation),
        payload,
        capture_version: 1,
        linked_task_id: !isReconciliation && envatoActiveGeneration ? envatoActiveGeneration.taskId : null,
        linked_client_id: !isReconciliation && envatoActiveGeneration ? envatoActiveGeneration.clientId : null,
      },
    });
    if (result?.ok) {
      console.debug('[RMW Envato Capture] reported generation row', { itemUuid, isReconciliation, queued: result.queued });
      if (!isReconciliation) setEnvatoCaptureStatus('Queued for upload…');
    } else {
      console.warn('[RMW Envato Capture] failed to report generation row', { itemUuid, isReconciliation, error: result?.error });
      if (!isReconciliation) setEnvatoCaptureStatus(`Capture failed: ${result?.error || 'unknown error'}`, { autoHideMs: 8000 });
    }
  } catch (error) {
    console.warn('[RMW Envato Capture] unexpected error reporting generation row', { itemUuid, error: error?.message || error });
  }
}

// ----------------------------------------------------------------------------
// Live-capture arm/disarm state machine — mirrors content-freepik.js's
// USAGE_CTX-derived design (armed by a real DOM click, not a data-shape
// guess). Simpler than Freepik's since there is no separate pending-
// settlement tracking needed (see this file's header on why).
// ----------------------------------------------------------------------------

const ENVATO_ARM_MAX_DURATION_MS = 10 * 60 * 1000; // generous for slow renders (video/music can take a while)
const ENVATO_ARM_QUIET_PERIOD_MS = 90 * 1000;
const ENVATO_CLOCK_SKEW_SLACK_MS = 60 * 1000;

// { generateIntentId, armedAt, expiresAt, capturedItemUuids: Set, taskId,
//   taskName, clientId, clientName, creditsBadge, quotaRemainingBefore }
let envatoActiveGeneration = null;
let envatoArmQuietTimer = null;
let envatoArmMaxTimer = null;

function clearEnvatoArmTimers() {
  if (envatoArmQuietTimer) { window.clearTimeout(envatoArmQuietTimer); envatoArmQuietTimer = null; }
  if (envatoArmMaxTimer) { window.clearTimeout(envatoArmMaxTimer); envatoArmMaxTimer = null; }
}

function envatoGenerationLinkLabel(generation) {
  if (!generation) return '';
  const parts = [];
  if (generation.taskName) parts.push(`Task: ${generation.taskName}`);
  if (generation.clientName) parts.push(`Client: ${generation.clientName}`);
  return parts.length ? ` (${parts.join(', ')})` : '';
}

function disarmEnvatoGeneration() {
  clearEnvatoArmTimers();
  const hadCaptures = Boolean(envatoActiveGeneration && envatoActiveGeneration.capturedItemUuids.size > 0);
  const linkLabel = envatoGenerationLinkLabel(envatoActiveGeneration);
  envatoActiveGeneration = null;
  if (hadCaptures) {
    setEnvatoCaptureStatus(`Capture complete ✓${linkLabel}`, { autoHideMs: 6000 });
  } else {
    hideEnvatoCaptureStatus();
  }
}

function scheduleEnvatoArmQuietReset() {
  if (envatoArmQuietTimer) window.clearTimeout(envatoArmQuietTimer);
  envatoArmQuietTimer = window.setTimeout(disarmEnvatoGeneration, ENVATO_ARM_QUIET_PERIOD_MS);
}

function isEnvatoGenerationArmed() {
  return Boolean(envatoActiveGeneration) && Date.now() <= envatoActiveGeneration.expiresAt;
}

function armEnvatoGeneration(target) {
  const now = Date.now();
  const pendingSelection = envatoPendingTaskSelection;
  envatoPendingTaskSelection = null;
  const creditsBadge = scrapeEnvatoCreditBadgeNear(target);
  const quotaRemainingBefore = scrapeEnvatoQuotaRemaining();

  if (isEnvatoGenerationArmed()) {
    // A second Generate click while still waiting on a prior one extends the
    // existing session rather than resetting capturedItemUuids.
    if (pendingSelection) {
      envatoActiveGeneration.taskId = pendingSelection.taskId;
      envatoActiveGeneration.taskName = pendingSelection.taskName;
      envatoActiveGeneration.clientId = pendingSelection.clientId;
      envatoActiveGeneration.clientName = pendingSelection.clientName;
    }
    if (creditsBadge != null) envatoActiveGeneration.creditsBadge = creditsBadge;
    scheduleEnvatoArmQuietReset();
    setEnvatoCaptureStatus(`Waiting for generation…${envatoGenerationLinkLabel(envatoActiveGeneration)}`);
    return;
  }

  clearEnvatoArmTimers();
  envatoActiveGeneration = {
    generateIntentId: `envgen_${now}_${Math.random().toString(36).slice(2, 8)}`,
    armedAt: now,
    expiresAt: now + ENVATO_ARM_MAX_DURATION_MS,
    capturedItemUuids: new Set(),
    taskId: pendingSelection?.taskId ?? null,
    taskName: pendingSelection?.taskName ?? null,
    clientId: pendingSelection?.clientId ?? null,
    clientName: pendingSelection?.clientName ?? null,
    creditsBadge,
    quotaRemainingBefore,
  };
  envatoArmMaxTimer = window.setTimeout(disarmEnvatoGeneration, ENVATO_ARM_MAX_DURATION_MS);
  scheduleEnvatoArmQuietReset();
  setEnvatoCaptureStatus(`Waiting for generation…${envatoGenerationLinkLabel(envatoActiveGeneration)}`);
  console.debug('[RMW Envato Capture] armed', {
    generateIntentId: envatoActiveGeneration.generateIntentId,
    taskId: envatoActiveGeneration.taskId,
    clientId: envatoActiveGeneration.clientId,
  });
}

// ---- Generic "was this click a Generate action" detector — direct port of
// content-freepik.js's findFreepikGenerateActionTarget. The same text-match
// heuristic (nearest button-like ancestor whose text matches /generate/)
// generalizes for free across all of ImageGen/ImageEdit/VideoGen/MusicGen/
// VoiceGen/SoundGen/GraphicsGen/MockupGen — every one of those tool pages
// has a button literally labeled "Generate" (confirmed via screenshots of
// several of them). See content-freepik.js's own comment on why this walk
// only ever accepts a real button/link/role=button ancestor, never a form
// field or a fallback to the raw clicked node. ----

function findEnvatoGenerateButtonAncestor(element) {
  let current = element;
  while (current && current !== document.body) {
    if (
      !ENVATO_GATE_EXCLUDED_TAGS.has(current.tagName)
      && current.matches?.(ENVATO_ACTION_SELECTORS.join(','))
      && envatoIsVisible(current)
      && !envatoIsDisabled(current)
    ) {
      return current;
    }
    current = current.parentElement;
  }
  return null;
}

function collectEnvatoInteractionCandidateElements(target) {
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
  return envatoCollectUniqueElements([...pathElements, ...fallback]);
}

function envatoButtonDescriptorText(element) {
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

function findEnvatoGenerateActionTarget(target) {
  const candidates = envatoCollectUniqueElements(
    collectEnvatoInteractionCandidateElements(target).map((element) => findEnvatoGenerateButtonAncestor(element))
  );
  for (const candidate of candidates) {
    if (!candidate) continue;
    const text = envatoButtonDescriptorText(candidate);
    // A little longer than Freepik's 60-char cap: Envato's own button text
    // includes the inline credit badge (e.g. "generate + 1"), still short
    // and specific enough to stay a reliable, low-false-positive match.
    if (!text || text.length > 80) continue;
    if (!/(^|\s)generate($|\s)/i.test(text)) continue;
    return candidate;
  }
  return null;
}

// ---- Download capture (app.envato.com's own /search/* stock-browse flow -
// see this file's header). Reuses findEnvatoGenerateButtonAncestor (fully
// generic despite the name - see content-freepik.js's identical reuse of
// findFreepikGenerateButtonAncestor for its own download gate) rather than
// duplicating the ancestor-walk. ----

// Confirmed via a captured DOM+Network trace (2026-08-08, real button HTML):
// the actual Download icon on both photos and videos search-result cards is
// a real <button data-cy="item-action-download" data-analytics-item_title=
// "..." data-analytics-item_author="...">, icon-only (an SVG <use> glyph,
// no visible/accessible text at all - the reason the text-based detector
// below could never catch it). `data-cy` is a deliberate, stable test-hook
// attribute (unlike the CSS module classnames alongside it - `ds-b1394h...`,
// clearly build-hashed and guaranteed to change), so this is checked FIRST
// and is the primary, reliable detector - not a text-matching guess.
//
// For photos this button's click triggers `GET /download.data?itemUuid=
// ...&itemType=photos` directly. For videos the same click instead opens a
// resolution/format picker menu (a second click, e.g. "1080P (1920 x 1080 /
// 6.4 MB)", is needed before that same request fires) - gating on THIS
// (first) click still correctly covers both: the Task/Client prompt appears
// once, right when the user expresses download intent, and
// content-envato-network.js's ENVATO_NETWORK_DOWNLOAD signal correlates
// against whichever later click actually produces the request (see
// ENVATO_DOWNLOAD_CORRELATION_WINDOW_MS below, sized generously to cover a
// video download's extra format-selection step).
function findEnvatoDownloadDataCyTarget(target) {
  const el = target?.nodeType === Node.ELEMENT_NODE ? target : target?.parentElement;
  return el?.closest?.('[data-cy="item-action-download"], [data-cy^="item-action-download"]') || null;
}

// Fallback for any Download control that doesn't carry the data-cy hook
// above (defense in depth, not the primary path).
function findEnvatoDownloadActionTarget(target) {
  const candidates = envatoCollectUniqueElements(
    collectEnvatoInteractionCandidateElements(target).map((element) => findEnvatoGenerateButtonAncestor(element))
  );
  for (const candidate of candidates) {
    if (!candidate) continue;
    const text = envatoButtonDescriptorText(candidate);
    if (!text || text.length > 60) continue;
    if (!/(^|\s)download($|\s)/i.test(text)) continue;
    return candidate;
  }
  return null;
}

// Best-effort scrape of whatever's visible near the clicked Download
// button. Prefers the button's own data-analytics-item_title/item_author
// attributes (confirmed present and reliable - see this section's own top
// comment) over guessing from a nearby <img alt>, falling back to the
// latter only if the former is absent (e.g. the findEnvatoDownloadActionTarget
// fallback path matched a button without those attributes). Read BEFORE the
// click is re-dispatched, since the click itself may navigate away or alter
// the DOM.
// Envato's item-card DOM (confirmed via a real captured sample, 2026-08-08)
// uses build-hashed, non-semantic class names throughout (e.g. "ds-b1394h957")
// - there is no "card"/"article"/"figure" class or tag to select on. Walking
// up parentElement until an ancestor actually CONTAINS an <img> (the
// thumbnail always lives somewhere within the visual card boundary, however
// many non-semantic wrapper divs separate it from the button) is robust to
// that class-hashing regardless of the exact markup shape.
function findEnvatoDownloadCardContainer(button) {
  let current = button.parentElement;
  let depth = 0;
  while (current && current !== document.body && depth < 10) {
    // Not `img[src]` - a lazy-loaded thumbnail may have no `src` attribute
    // at all yet (relying solely on `data-src`/`srcset`, see
    // extractEnvatoImageUrl below), so require only the tag's presence here.
    if (current.querySelector?.('img')) return current;
    current = current.parentElement;
    depth += 1;
  }
  return button.parentElement || button;
}

// Prefers currentSrc/src, falling back to common lazy-load attributes
// (data-src, srcset's first candidate) and rejecting a blank data: URI
// placeholder - lazy-loaded card grids often leave the real image out of
// `src` until the element scrolls into view.
function extractEnvatoImageUrl(img) {
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

function collectEnvatoDownloadAssetInfo(button) {
  const container = findEnvatoDownloadCardContainer(button);
  const img = container?.querySelector?.('img');
  const analyticsTitle = button.getAttribute?.('data-analytics-item_title');
  const analyticsAuthor = button.getAttribute?.('data-analytics-item_author');
  const rawTitle = analyticsTitle || img?.getAttribute('alt') || container?.getAttribute?.('aria-label') || container?.getAttribute?.('title') || document.title || null;
  const anchor = container?.querySelector?.('a[href]');
  return {
    assetTitle: rawTitle ? String(rawTitle).trim().slice(0, 2000) : null,
    assetAuthor: analyticsAuthor ? String(analyticsAuthor).trim().slice(0, 255) : null,
    assetThumbnailUrl: extractEnvatoImageUrl(img),
    assetSourceUrl: anchor?.href || null,
  };
}

const ENVATO_SEARCH_PARAM_NAMES = ['term', 'query', 'q', 'search'];

function readEnvatoSearchTermFromUrl(href) {
  try {
    const url = new URL(href || window.location.href);
    for (const name of ENVATO_SEARCH_PARAM_NAMES) {
      const value = url.searchParams.get(name);
      if (value && value.trim()) return value.trim();
    }
  } catch {}
  return null;
}

// Correlates a gated Download click against content-envato-network.js's
// ENVATO_NETWORK_DOWNLOAD signal (the confirmed `/download.data?itemUuid=
// ...&itemType=...` request - see this file's header) for a reliable
// itemUuid/itemType, falling back to a DOM-only report if no such signal
// arrives within the window (some downloads may not hit that endpoint, or
// the endpoint shape may drift - never block capture entirely on this).
// Generous window (not the original 4s): a photo's download.data fires
// almost immediately after the gated click, but a video's fires only after
// the user picks a format from the menu that click opens - the window has
// to comfortably outlast that extra, human-paced step.
const ENVATO_DOWNLOAD_CORRELATION_WINDOW_MS = 20000;
let envatoPendingDownloadReport = null; // { assetInfo, selection, timer, resolved }

function reportEnvatoDownloadClick(assetInfo, selection, networkInfo) {
  const clientEventId = `envato:download:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
  envatoSendRuntimeMessage({
    type: 'ENVATO_CAPTURE_EVENT',
    event: {
      event_type: 'download_click',
      client_event_id: clientEventId,
      item_uuid: networkInfo?.itemUuid || null,
      payload: {
        itemType: networkInfo?.itemType || null,
        assetTitle: assetInfo.assetTitle,
        assetAuthor: assetInfo.assetAuthor,
        assetThumbnailUrl: assetInfo.assetThumbnailUrl,
        assetSourceUrl: assetInfo.assetSourceUrl,
        searchTerm: readEnvatoSearchTermFromUrl(window.location.href),
        sourceHost: window.location.hostname.replace(/^www\./, ''),
        pageUrl: window.location.href,
        downloadedAt: new Date().toISOString(),
      },
      capture_version: 1,
      linked_task_id: selection?.taskId ?? null,
      linked_client_id: selection?.clientId ?? null,
    },
  }).then((result) => {
    if (result?.ok) {
      console.debug('[RMW Envato Capture] reported download click', { itemUuid: networkInfo?.itemUuid, assetTitle: assetInfo.assetTitle, queued: result.queued });
      setEnvatoCaptureStatus('Queued for upload…', { autoHideMs: 6000 });
    } else {
      console.warn('[RMW Envato Capture] failed to report download click', { error: result?.error });
      setEnvatoCaptureStatus(`Capture failed: ${result?.error || 'unknown error'}`, { autoHideMs: 8000 });
    }
  }).catch((error) => {
    console.warn('[RMW Envato Capture] unexpected error reporting download click', { error: error?.message || error });
  });
}

function scheduleEnvatoDownloadReport(assetInfo, selection) {
  if (envatoPendingDownloadReport?.timer) window.clearTimeout(envatoPendingDownloadReport.timer);
  const pending = { assetInfo, selection, resolved: false };
  pending.timer = window.setTimeout(() => {
    if (pending.resolved) return;
    pending.resolved = true;
    console.debug('[RMW Envato Capture] no network-confirmed download signal within window - reporting DOM-only', { assetTitle: assetInfo.assetTitle });
    reportEnvatoDownloadClick(assetInfo, selection, null);
    if (envatoPendingDownloadReport === pending) envatoPendingDownloadReport = null;
  }, ENVATO_DOWNLOAD_CORRELATION_WINDOW_MS);
  envatoPendingDownloadReport = pending;
}

// ---- Task/Client Mapping gate for Download - own bypass-target state so
// it never interferes with the Generate gate below, same "independent
// gates in one listener" structure content-freepik.js uses. ----

let envatoDownloadTaskGateBypassTarget = null;
let envatoDownloadTaskGateModalOpen = false;

async function runEnvatoDownloadTaskGate(target) {
  if (envatoDownloadTaskGateModalOpen) return; // double-click Download while the modal is already open - no-op
  envatoDownloadTaskGateModalOpen = true;
  try {
    const selection = await openEnvatoTaskSelectionModal();
    if (!selection) return; // cancelled/ESC/no active tasks - click stays blocked
    const assetInfo = collectEnvatoDownloadAssetInfo(target);
    envatoDownloadTaskGateBypassTarget = target;
    scheduleEnvatoDownloadReport(assetInfo, selection);
    target.click();
  } finally {
    envatoDownloadTaskGateModalOpen = false;
  }
}

// ---- Task/Client Mapping gate for Generate — same block/re-dispatch-
// synthetic-click technique as content-freepik.js's runFreepikTaskGate. ----

let envatoTaskGateBypassTarget = null;
let envatoTaskGateModalOpen = false;
let envatoPendingTaskSelection = null; // {taskId, taskName, clientId, clientName} - consumed by armEnvatoGeneration()

async function runEnvatoTaskGate(target) {
  if (envatoTaskGateModalOpen) return; // double-click Generate while the modal is already open - no-op
  envatoTaskGateModalOpen = true;
  try {
    const selection = await openEnvatoTaskSelectionModal();
    if (!selection) return; // cancelled/ESC/no active tasks - click stays blocked
    envatoPendingTaskSelection = selection;
    envatoTaskGateBypassTarget = target;
    target.click();
  } finally {
    envatoTaskGateModalOpen = false;
  }
}

document.addEventListener('click', (event) => {
  try {
    const target = findEnvatoGenerateActionTarget(event.target);
    if (target) {
      if (envatoTaskGateBypassTarget === target) {
        envatoTaskGateBypassTarget = null; // one-shot: next Generate click gates again
        armEnvatoGeneration(target);
        return; // let the (re-dispatched) click reach Envato's own handler
      }

      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      runEnvatoTaskGate(target);
      return;
    }

    const downloadTarget = findEnvatoDownloadDataCyTarget(event.target) || findEnvatoDownloadActionTarget(event.target);
    if (downloadTarget) {
      if (envatoDownloadTaskGateBypassTarget === downloadTarget) {
        envatoDownloadTaskGateBypassTarget = null; // one-shot: next Download click gates again
        return; // already scheduled for report (see runEnvatoDownloadTaskGate) - let the re-dispatched click reach Envato's own handler
      }

      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      runEnvatoDownloadTaskGate(downloadTarget);
      return;
    }

    // Temporary diagnostic (2026-08-08) - a real Download click was
    // confirmed (native Save-As dialog appeared) but neither gate above
    // matched it, and no console output from this file preceded it. Logs
    // the actual clicked element + its ancestor chain so the real tag/role/
    // text is visible without a manual Inspect Element round trip. Safe to
    // remove once the Download detection gap is confirmed fixed.
    const clickedEl = event.target?.nodeType === Node.ELEMENT_NODE ? event.target : event.target?.parentElement;
    if (clickedEl) {
      // Printed as plain copy-pasteable HTML strings (not a collapsed
      // console object tree that needs manual per-node expanding) - each
      // ancestor on its own labeled line, easiest to paste back whole.
      const lines = ['[RMW Envato Capture][diagnostic] click did not match Generate or Download - ancestor chain (innermost first):'];
      const ancestors = collectEnvatoInteractionCandidateElements(event.target).slice(0, 8);
      ancestors.forEach((el, index) => {
        let html = '';
        try { html = el.outerHTML.slice(0, 300); } catch { html = '(unavailable)'; }
        lines.push(`  [${index}] ${html}`);
      });
      console.debug(lines.join('\n'));
    }
  } catch {}
}, true); // capturing phase - fires even if the page's own handler stops propagation

// ---- Relay for content-envato-network.js's (MAIN world) intercepted
// `.data` responses ----

function evaluateEnvatoRowForLiveCapture(row) {
  const item = envatoRowItem(row);
  const itemUuid = item.itemUuid !== undefined && item.itemUuid !== null ? String(item.itemUuid) : '';
  if (!itemUuid) return { qualifies: false, reason: 'no_item_uuid' };
  if (!isEnvatoGenerationArmed()) return { qualifies: false, reason: 'not_armed' };
  if (envatoActiveGeneration.capturedItemUuids.has(itemUuid)) return { qualifies: false, reason: 'already_captured_this_session' };

  const rawTimestamp = item.createdAt || item.jobCreatedAt;
  const timestampMs = rawTimestamp ? Date.parse(rawTimestamp) : NaN;
  if (Number.isNaN(timestampMs)) return { qualifies: false, reason: 'no_timestamp' };
  // Must post-date the click that armed us - a result cannot precede its own cause.
  if (timestampMs < envatoActiveGeneration.armedAt - ENVATO_CLOCK_SKEW_SLACK_MS) {
    return { qualifies: false, reason: 'older_than_click' };
  }
  return { qualifies: true, itemUuid };
}

function onEnvatoNetworkMessage(event) {
  if (event.source !== window) return;
  const data = event.data;
  if (!data || data.source !== 'rmw-envato-network-telemetry') return;

  if (data.type === 'ENVATO_NETWORK_DOWNLOAD') {
    // Correlates with scheduleEnvatoDownloadReport's pending window - see
    // this file's own "Download capture" section for why the network signal
    // (a confirmed real request) is preferred over the DOM-only fallback.
    if (envatoPendingDownloadReport && !envatoPendingDownloadReport.resolved) {
      envatoPendingDownloadReport.resolved = true;
      window.clearTimeout(envatoPendingDownloadReport.timer);
      const { assetInfo, selection } = envatoPendingDownloadReport;
      envatoPendingDownloadReport = null;
      console.debug('[RMW Envato Capture] correlated download click with network signal', data.payload);
      reportEnvatoDownloadClick(assetInfo, selection, data.payload);
    }
    return;
  }

  if (data.type !== 'ENVATO_NETWORK_GENERATION') return;
  const rows = data.payload && Array.isArray(data.payload.rows) ? data.payload.rows : [];

  rows.forEach((row) => {
    const evaluation = evaluateEnvatoRowForLiveCapture(row);
    if (!evaluation.qualifies) {
      console.debug('[RMW Envato Capture] ignored non-qualifying row (not a live generation)', {
        itemUuid: envatoRowItem(row).itemUuid, reason: evaluation.reason,
      });
      return;
    }
    envatoActiveGeneration.capturedItemUuids.add(evaluation.itemUuid);
    scheduleEnvatoArmQuietReset(); // this counts as recent activity - extend the window
    setEnvatoCaptureStatus('Capturing…');
    console.debug('[RMW Envato Capture] qualifying row - reporting as live', { itemUuid: evaluation.itemUuid });
    reportEnvatoGenerationRow(row, { isReconciliation: false });
  });
}

window.addEventListener('message', onEnvatoNetworkMessage);

// ----------------------------------------------------------------------------
// Reconciliation walker — pages /generation-history.data directly. Unlike
// content-freepik.js's walker, the URL/body shape here is CONFIRMED (a real
// captured HAR), not learned from observed traffic, so this can start
// walking immediately rather than waiting to learn a template first.
// ----------------------------------------------------------------------------

const ENVATO_SYNC_STORAGE_KEY = 'rmw_envato_sync_state';
const ENVATO_RECONCILIATION_WALK_PAGES_PER_RUN = 3;
const ENVATO_RECONCILIATION_MIN_GAP_MS = 20 * 60 * 1000; // one walk per tab per ~20 min

async function getEnvatoSyncState() {
  const stored = await chromeStorageGet([ENVATO_SYNC_STORAGE_KEY]);
  return stored[ENVATO_SYNC_STORAGE_KEY] || {};
}

async function patchEnvatoSyncState(patch) {
  const current = await getEnvatoSyncState();
  const next = { ...current, ...patch };
  await chromeStorageSet({ [ENVATO_SYNC_STORAGE_KEY]: next });
  return next;
}

// Confirmed against a real captured HAR (2026-08-07): page 1 is the plain
// GET route-loader; page 2+ is a POST `actionType=loadMore` form action.
// Neither needs any header beyond what fetch()/the browser set automatically.
async function fetchEnvatoHistoryPage(page) {
  try {
    let response;
    if (page <= 1) {
      response = await fetch('/generation-history.data?_routes=routes%2Fgeneration-history%2Froute', {
        credentials: 'include',
      });
    } else {
      response = await fetch('/generation-history.data', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
        body: `actionType=loadMore&page=${page}&order=desc&addedTimeframe=all_time&assetType=all`,
      });
    }
    if (!response.ok) return null;
    const text = await response.text();
    return parseEnvatoTurboStreamResponse(text);
  } catch {
    return null;
  }
}

// Hunts the decoded tree for the object actually carrying assets/results
// (+ hasNextPage/page) - same bounded-depth, skip-`messages` approach as
// content-envato-network.js's collectEnvatoRows, but returns the CONTAINING
// object (not just the rows) since the walker also needs hasNextPage/page.
function findEnvatoHistoryPayload(node, depth) {
  if (!node || typeof node !== 'object' || depth > 6) return null;
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findEnvatoHistoryPayload(child, depth + 1);
      if (found) return found;
    }
    return null;
  }
  if (Array.isArray(node.assets) || Array.isArray(node.results)) return node;
  for (const key of Object.keys(node)) {
    if (key === 'messages') continue;
    const found = findEnvatoHistoryPayload(node[key], depth + 1);
    if (found) return found;
  }
  return null;
}

async function walkEnvatoReconciliation() {
  const state = await getEnvatoSyncState();
  const now = Date.now();
  if (state.lastWalkAt && now - state.lastWalkAt < ENVATO_RECONCILIATION_MIN_GAP_MS) {
    console.debug('[RMW Envato Sync] walk skipped: ran too recently', { lastWalkAt: state.lastWalkAt });
    return;
  }

  console.debug('[RMW Envato Sync] starting reconciliation walk', { fromPage: Number(state.lastSyncedPage || 0) + 1 });
  await patchEnvatoSyncState({ lastWalkAt: now });

  let page = Number(state.lastSyncedPage || 0) + 1;
  let lastSeenItemUuid = state.lastSeenItemUuid || null;
  let pagesWalked = 0;

  for (; pagesWalked < ENVATO_RECONCILIATION_WALK_PAGES_PER_RUN; pagesWalked++, page++) {
    const decoded = await fetchEnvatoHistoryPage(page);
    if (!decoded) {
      console.warn('[RMW Envato Sync] page fetch/decode failed, stopping walk', { page });
      break;
    }
    const payload = findEnvatoHistoryPayload(decoded, 0);
    const rows = payload ? (payload.assets || payload.results || []) : [];
    if (!rows.length) {
      console.debug('[RMW Envato Sync] page returned no rows, stopping walk', { page });
      break;
    }

    for (const row of rows) {
      await reportEnvatoGenerationRow(row, { isReconciliation: true });
      const item = envatoRowItem(row);
      if (item.itemUuid) lastSeenItemUuid = String(item.itemUuid);
    }

    if (!payload.hasNextPage) {
      pagesWalked += 1;
      break;
    }
  }

  console.debug('[RMW Envato Sync] walk finished', { pagesWalked, lastSyncedPage: page - 1 });
  if (pagesWalked > 0) {
    await patchEnvatoSyncState({ lastSyncedPage: page - 1, lastSeenItemUuid });
    envatoSendRuntimeMessage({
      type: 'ENVATO_SYNC_PROGRESS',
      lastSeenItemUuid,
      lastSyncedPage: page - 1,
      isFullReconciliation: false,
      status: 'idle',
    }).catch(() => {});
  }
}

// Short delay (unlike Freepik's 15s wait to learn a URL template — not
// needed here, the endpoint is already confirmed) just to let the page
// settle before issuing a background fetch.
window.setTimeout(() => {
  walkEnvatoReconciliation().catch(() => {});
}, 6000);
