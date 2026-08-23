// content-elevenlabs-capture.js — ElevenLabs Generation Capture (isolated
// world, elevenlabs.io only).
//
// Deliberately its OWN file rather than folded into content-elevenlabs.js
// (the autologin script, which stays exactly as-is - see that file). Keeping
// capture fully separate means a bug here can never regress the working
// autologin flow, and vice versa - same split content-envato-capture.js uses
// relative to content-envato.js (this file's primary template). Every helper
// this file needs is therefore its own local copy, not borrowed from
// content-elevenlabs.js or any other tool's capture file - no assumption
// about cross-file load order beyond what manifest.json's content_scripts
// ordering already guarantees (task-api + task-modal load before this file).
//
// Design, in one paragraph: unlike Flow/Freepik (one confirmed generation-API
// shape each), ElevenLabs has only ONE confirmed piece of real traffic - a
// `history?page_size=20&source=TTS&sort_direction=desc` request URL (no
// captured response body, no confirmed generate-submission endpoint). That
// puts ElevenLabs in the exact same position Envato has always shipped from
// (confirmed listing endpoint, unconfirmed generate endpoint) - so this file
// follows content-envato-capture.js's reconciliation-walker-first design, not
// Flow's network-gate-first design. Three independent pieces:
//   1. A click-arm gate on a broadly-matched Generate-like button (blocks the
//      click, shows the task/client modal, re-dispatches a synthetic click on
//      Continue) - arms a capture window, does NOT hold the real network
//      request (there is no confirmed request to hold).
//   2. A relay for content-elevenlabs-network.js's (MAIN world) intercepted
//      `/history` responses - reported live only while armed.
//   3. A reconciliation walker that pages `/v1/history` directly on a timer,
//      independent of arming - the primary, not fallback, capture signal,
//      exactly like Envato's.
//
// KNOWN RISK (see CAPTURE_CONTRACT.md's checkpoint list): Flow's own code
// comments document that blocking+re-dispatching a click broke generation
// there, because a synthetic gesture can't mint a valid anti-bot token -
// Envato's identical block/re-dispatch pattern works fine for Envato. We do
// not yet know which case ElevenLabs is. If generation silently hangs/fails
// right after a task/client pick during first real use, the fallback is
// Flow's non-blocking arm-on-observed-click design (Cancel would then only
// skip attribution, not abort generation).

// ---- Self-contained utility helpers (see this file's own header for why
// these are local copies, not shared with content-elevenlabs.js) ----

function elevenlabsSendRuntimeMessage(message) {
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

function elevenlabsIsVisible(element) {
  if (!element) return false;
  const rect = element.getBoundingClientRect();
  const style = window.getComputedStyle(element);
  return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
}

function elevenlabsIsDisabled(element) {
  if (!element) return true;
  return Boolean(
    element.disabled
    || element.getAttribute('aria-disabled') === 'true'
    || element.getAttribute('disabled') !== null
  );
}

const ELEVENLABS_ACTION_SELECTORS = ['button', 'input[type="submit"]', 'a[href]', '[role="button"]'];
const ELEVENLABS_GATE_EXCLUDED_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT', 'OPTION']);

function elevenlabsCollectUniqueElements(elements) {
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

// Plain 32-bit FNV-1a string hash - used as a client_event_id change-token
// fallback when a row carries no recognizable timestamp field at all (shape
// unconfirmed - see this file's header). No external deps.
function hashString(str) {
  let hash = 0x811c9dc5;
  const text = `${str || ''}`;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16);
}

// ---- On-page live-capture status badge (same pattern as
// content-envato-capture.js's identical badge) ----

let elevenlabsCaptureStatusHideTimer = null;

function ensureElevenlabsCaptureStatusBadge() {
  const existing = document.getElementById('rmw-elevenlabs-capture-status');
  if (existing) return existing;
  const badge = document.createElement('div');
  badge.id = 'rmw-elevenlabs-capture-status';
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

function setElevenlabsCaptureStatus(message, { autoHideMs } = {}) {
  const badge = ensureElevenlabsCaptureStatusBadge();
  badge.textContent = `ElevenLabs capture\n${message}`;
  badge.style.display = 'block';
  if (elevenlabsCaptureStatusHideTimer) {
    window.clearTimeout(elevenlabsCaptureStatusHideTimer);
    elevenlabsCaptureStatusHideTimer = null;
  }
  if (autoHideMs) {
    elevenlabsCaptureStatusHideTimer = window.setTimeout(() => { badge.style.display = 'none'; }, autoHideMs);
  }
}

function hideElevenlabsCaptureStatus() {
  const badge = document.getElementById('rmw-elevenlabs-capture-status');
  if (badge) badge.style.display = 'none';
}

// ---- Row-shape helpers (local copy of content-elevenlabs-network.js's
// identity/shape logic - not shared cross-file, matches this codebase's own
// "each capture file is self-contained" convention). ----

// Music's /v1/music/chats rows nest the real generation/asset unit one level
// down in `song` (id, product_type_source, timestamps) - the chat wrapper's
// own `id` is just the grouping/prompt-thread id, not the generation. Song-
// level fields win when present so this file's identity/source/timestamp
// resolution agrees with the backend's own flatten rule
// (normalization.py's _flatten_music_chat) - same provider_creation_id
// either side computes independently.
function elevenlabsEffectiveRow(row) {
  if (row && typeof row === 'object' && row.song && typeof row.song === 'object') {
    return { ...row, ...row.song };
  }
  return row;
}

function getElevenlabsRowIdentity(rawRow) {
  const row = elevenlabsEffectiveRow(rawRow);
  if (!row || typeof row !== 'object') return '';
  if (row.history_item_id !== undefined && row.history_item_id !== null && row.history_item_id !== '') return String(row.history_item_id);
  if (row.id !== undefined && row.id !== null && row.id !== '') return String(row.id);
  if (row.generation_id !== undefined && row.generation_id !== null && row.generation_id !== '') return String(row.generation_id);
  return '';
}

function getElevenlabsRowSource(rawRow) {
  const row = elevenlabsEffectiveRow(rawRow);
  if (!row || typeof row !== 'object') return '';
  if (row.source !== undefined && row.source !== null && row.source !== '') return String(row.source);
  if (row.source_type !== undefined && row.source_type !== null && row.source_type !== '') return String(row.source_type);
  if (row.product_type_source !== undefined && row.product_type_source !== null && row.product_type_source !== '') return String(row.product_type_source);
  return '';
}

// Returns {field, raw} for whichever timestamp-like field is present, or
// null if none is - tries in this order since the real shape is unconfirmed.
function getElevenlabsRowRawTimestamp(rawRow) {
  const row = elevenlabsEffectiveRow(rawRow);
  if (!row || typeof row !== 'object') return null;
  const fields = ['date_unix', 'created_at_unix', 'date', 'created_at', 'created_at_utc'];
  for (const field of fields) {
    if (row[field] !== undefined && row[field] !== null && row[field] !== '') {
      return { field, raw: row[field] };
    }
  }
  return null;
}

// _unix-suffixed fields are assumed to be unix epoch SECONDS (the common
// convention that name implies) unless the number is already millisecond-
// scale; the plain date/created_at fields are assumed ISO-ish strings parsed
// via Date.parse, falling back to a numeric interpretation if Date.parse
// fails (defensive - the real format is unconfirmed).
function parseElevenlabsTimestampMs(field, raw) {
  if (raw === undefined || raw === null || raw === '') return null;
  const numeric = Number(raw);
  const isNumeric = !Number.isNaN(numeric) && `${raw}`.trim() !== '';
  if (/_unix$/i.test(field || '')) {
    if (!isNumeric) return null;
    return numeric < 10000000000 ? numeric * 1000 : numeric;
  }
  const parsed = Date.parse(raw);
  if (!Number.isNaN(parsed)) return parsed;
  if (isNumeric) return numeric < 10000000000 ? numeric * 1000 : numeric;
  return null;
}

function looksLikeElevenlabsHistoryRowLocal(candidate) {
  if (!candidate || typeof candidate !== 'object') return false;
  if (!getElevenlabsRowIdentity(candidate) || !getElevenlabsRowRawTimestamp(candidate)) return false;
  // Mirrors content-elevenlabs-network.js's identical gate - see that file's
  // comment for why a Music chat with no `song` yet must never be reported.
  if (candidate.current_song_id !== undefined && !(candidate.song && typeof candidate.song === 'object')) {
    return false;
  }
  return true;
}

function extractElevenlabsHistoryRowsFromJson(json) {
  if (!json || typeof json !== 'object') return [];
  if (Array.isArray(json)) return json.filter(looksLikeElevenlabsHistoryRowLocal);
  if (looksLikeElevenlabsHistoryRowLocal(json)) return [json];
  if (Array.isArray(json.history)) return json.history.filter(looksLikeElevenlabsHistoryRowLocal);
  if (Array.isArray(json.items)) return json.items.filter(looksLikeElevenlabsHistoryRowLocal);
  if (Array.isArray(json.chats)) return json.chats.filter(looksLikeElevenlabsHistoryRowLocal); // Music, confirmed 2026-08-17
  return [];
}

// ----------------------------------------------------------------------------
// Live-capture arm/disarm state machine — mirrors content-flow.js's
// flowActiveGeneration design (rolling quiet-period reset extends the window
// on each qualifying row; a hard max-duration ceiling backstops a session
// that never quiets down).
// ----------------------------------------------------------------------------

const ELEVENLABS_ARM_MAX_DURATION_MS = 10 * 60 * 1000;
const ELEVENLABS_ARM_QUIET_PERIOD_MS = 90 * 1000;
const ELEVENLABS_CLOCK_SKEW_SLACK_MS = 60 * 1000;
const ELEVENLABS_LAST_LIVE_CAPTURED_AT_KEY = 'rmw_elevenlabs_last_live_captured_at';
// Reported live, 2026-08-14: a single Generate click that produces multiple
// candidate takes (ElevenLabs' own UI shows them as "Generation 1"/
// "Generation 2") does not register both takes' history rows at the same
// time - confirmed directly in the database: one pair's second take landed
// ~65s after the first (and ~61s after the FIRST take was already captured),
// while a different generation's second take never appeared in our data at
// all. A single accelerated poll 4s after arming (the original design) only
// ever catches whichever take(s) ElevenLabs has already registered by then -
// it caught the first take reliably, but the delayed second take needed
// something to poll again later, which nothing did unless the user happened
// to trigger other activity on the page. These extra fixed offsets exist
// solely to give every take a real chance of being seen, without waiting on
// the reconciliation walker's own throttle (one walk per tab per ~20 min -
// see ELEVENLABS_RECONCILIATION_MIN_GAP_MS - far too infrequent to be this
// gap's backstop in practice).
// Capped at 80s, not 90s: ELEVENLABS_ARM_QUIET_PERIOD_MS below is also 90s,
// counted from the same arm moment - a poll scheduled at exactly 90s would
// race its own disarm timer instead of comfortably beating it.
const ELEVENLABS_ACCELERATED_POLL_DELAYS_MS = [4000, 15000, 30000, 60000, 80000];

// { generateIntentId, armedAt, expiresAt, capturedHistoryItemIds: Map,
//   taskId, taskName, clientId, clientName } - null when idle.
let elevenlabsActiveGeneration = null;
let elevenlabsArmQuietTimer = null;
let elevenlabsArmMaxTimer = null;
let elevenlabsAcceleratedPollTimers = [];
let elevenlabsLastLiveCapturedAt = 0;

chromeStorageGet([ELEVENLABS_LAST_LIVE_CAPTURED_AT_KEY]).then((stored) => {
  elevenlabsLastLiveCapturedAt = Number(stored[ELEVENLABS_LAST_LIVE_CAPTURED_AT_KEY] || 0);
});

function persistElevenlabsLastLiveCapturedAt(timestampMs) {
  if (!(timestampMs > elevenlabsLastLiveCapturedAt)) return;
  elevenlabsLastLiveCapturedAt = timestampMs;
  chromeStorageSet({ [ELEVENLABS_LAST_LIVE_CAPTURED_AT_KEY]: timestampMs }).catch(() => {});
}

function clearElevenlabsAcceleratedPollTimers() {
  elevenlabsAcceleratedPollTimers.forEach((id) => window.clearTimeout(id));
  elevenlabsAcceleratedPollTimers = [];
}

// Schedules a fresh batch of accelerated polls from NOW - called on every
// arm (fresh or extended), so a second Generate click while still armed
// gets its own full set of chances too, not just whatever's left of the
// first click's schedule.
function scheduleElevenlabsAcceleratedPolls() {
  clearElevenlabsAcceleratedPollTimers();
  elevenlabsAcceleratedPollTimers = ELEVENLABS_ACCELERATED_POLL_DELAYS_MS.map((delay) => window.setTimeout(() => {
    triggerElevenlabsHistoryPoll().catch(() => {});
  }, delay));
}

function clearElevenlabsArmTimers() {
  if (elevenlabsArmQuietTimer) { window.clearTimeout(elevenlabsArmQuietTimer); elevenlabsArmQuietTimer = null; }
  if (elevenlabsArmMaxTimer) { window.clearTimeout(elevenlabsArmMaxTimer); elevenlabsArmMaxTimer = null; }
  clearElevenlabsAcceleratedPollTimers();
}

function elevenlabsGenerationLinkLabel(generation) {
  if (!generation) return '';
  const parts = [];
  if (generation.taskName) parts.push(`Task: ${generation.taskName}`);
  if (generation.clientName) parts.push(`Client: ${generation.clientName}`);
  return parts.length ? ` (${parts.join(', ')})` : '';
}

function disarmElevenlabsGeneration() {
  clearElevenlabsArmTimers();
  const hadCaptures = Boolean(elevenlabsActiveGeneration && elevenlabsActiveGeneration.capturedHistoryItemIds.size > 0);
  const linkLabel = elevenlabsGenerationLinkLabel(elevenlabsActiveGeneration);
  elevenlabsActiveGeneration = null;
  if (hadCaptures) {
    setElevenlabsCaptureStatus(`Capture complete ✓${linkLabel}`, { autoHideMs: 6000 });
  } else {
    hideElevenlabsCaptureStatus();
  }
}

function scheduleElevenlabsArmQuietReset() {
  if (elevenlabsArmQuietTimer) window.clearTimeout(elevenlabsArmQuietTimer);
  elevenlabsArmQuietTimer = window.setTimeout(disarmElevenlabsGeneration, ELEVENLABS_ARM_QUIET_PERIOD_MS);
}

function isElevenlabsGenerationArmed() {
  return Boolean(elevenlabsActiveGeneration) && Date.now() <= elevenlabsActiveGeneration.expiresAt;
}

function armElevenlabsGeneration(target, selection) {
  const now = Date.now();

  if (isElevenlabsGenerationArmed()) {
    // A second Generate click while still waiting on a prior one extends the
    // existing session rather than resetting capturedHistoryItemIds.
    if (selection) {
      elevenlabsActiveGeneration.taskId = selection.taskId;
      elevenlabsActiveGeneration.taskName = selection.taskName;
      elevenlabsActiveGeneration.clientId = selection.clientId;
      elevenlabsActiveGeneration.clientName = selection.clientName;
    }
    scheduleElevenlabsArmQuietReset();
    scheduleElevenlabsAcceleratedPolls();
    setElevenlabsCaptureStatus(`Waiting for generation…${elevenlabsGenerationLinkLabel(elevenlabsActiveGeneration)}`);
    return;
  }

  clearElevenlabsArmTimers();
  elevenlabsActiveGeneration = {
    generateIntentId: `elevenlabsgen_${now}_${Math.random().toString(36).slice(2, 8)}`,
    armedAt: now,
    expiresAt: now + ELEVENLABS_ARM_MAX_DURATION_MS,
    capturedHistoryItemIds: new Map(),
    taskId: selection?.taskId ?? null,
    taskName: selection?.taskName ?? null,
    clientId: selection?.clientId ?? null,
    clientName: selection?.clientName ?? null,
  };
  elevenlabsArmMaxTimer = window.setTimeout(disarmElevenlabsGeneration, ELEVENLABS_ARM_MAX_DURATION_MS);
  scheduleElevenlabsArmQuietReset();
  setElevenlabsCaptureStatus(`Waiting for generation…${elevenlabsGenerationLinkLabel(elevenlabsActiveGeneration)}`);
  console.debug('[RMW ElevenLabs Capture] armed', {
    generateIntentId: elevenlabsActiveGeneration.generateIntentId,
    taskId: elevenlabsActiveGeneration.taskId,
    clientId: elevenlabsActiveGeneration.clientId,
  });

  // A batch of accelerated polls (see ELEVENLABS_ACCELERATED_POLL_DELAYS_MS's
  // own comment) so live capture doesn't wait for the next scheduled
  // reconciliation walk (up to ELEVENLABS_RECONCILIATION_MIN_GAP_MS away
  // otherwise) to catch a take that ElevenLabs is slow to register.
  scheduleElevenlabsAcceleratedPolls();
}

// ---- Generic "was this click a Generate action" detector — broad
// text/attribute heuristic, since the real markup per ElevenLabs surface
// (TTS/Music/SFX/Dubbing/Voice-Changer) is unconfirmed. Deliberately not one
// hardcoded CSS selector - see this file's header. ----

const ELEVENLABS_GENERATE_TEXT_PHRASES = [
  'generate', 'create speech', 'generate speech', 'generate sound effect',
  'generate music', 'generate audio', 'convert',
];

function elevenlabsButtonDescriptorText(element) {
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

function findElevenlabsGenerateButtonAncestor(element) {
  let current = element;
  while (current && current !== document.body) {
    if (
      !ELEVENLABS_GATE_EXCLUDED_TAGS.has(current.tagName)
      && current.matches?.(ELEVENLABS_ACTION_SELECTORS.join(','))
      && elevenlabsIsVisible(current)
      && !elevenlabsIsDisabled(current)
    ) {
      return current;
    }
    current = current.parentElement;
  }
  return null;
}

function collectElevenlabsInteractionCandidateElements(target) {
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
  return elevenlabsCollectUniqueElements([...pathElements, ...fallback]);
}

// Confirmed real shape (2026-08-17, Music composer's submit control): a
// fully icon-only round button (bare up-arrow SVG glyph) with NO
// aria-label/title/data-testid of its own at all - its only per-render
// attribute (`data-agent-id="button-_r_66u_"`) is a React useId(), not
// stable across sessions/reloads, so it can never be a selector. The text-
// phrase detector above can therefore never match it, no matter how many
// phrases are added. Its one reliable neighbor is a "Costs N credits" cost-
// preview pill sitting right next to it in the same flex row, carrying that
// real copy in a `data-agent-tooltip` attribute - checked on the immediate
// previous sibling and one level up (covers the confirmed real layout:
// button and cost-pill as direct siblings under a shared flex container).
function looksLikeElevenlabsIconSubmitButton(candidate) {
  if (!candidate || candidate.tagName !== 'BUTTON') return false;
  if (elevenlabsButtonDescriptorText(candidate)) return false; // has real text - the phrase detector above already covers it
  if (!candidate.querySelector?.('svg')) return false;
  const neighbors = [candidate.previousElementSibling, candidate.parentElement].filter(Boolean);
  return neighbors.some((el) => {
    const own = el.getAttribute?.('data-agent-tooltip') || '';
    const nested = el.querySelector?.('[data-agent-tooltip]')?.getAttribute?.('data-agent-tooltip') || '';
    return /\bcredit/i.test(`${own} ${nested}`);
  });
}

function looksLikeElevenlabsGenerateButton(candidate) {
  if (!candidate) return false;
  const text = elevenlabsButtonDescriptorText(candidate);
  if (text && text.length <= 80 && ELEVENLABS_GENERATE_TEXT_PHRASES.some((phrase) => text.includes(phrase))) {
    return true;
  }
  const testId = `${candidate.getAttribute?.('data-testid') || ''}`.toLowerCase();
  const ariaLabel = `${candidate.getAttribute?.('aria-label') || ''}`.toLowerCase();
  if (testId.includes('generate') || ariaLabel.includes('generate')) return true;
  return looksLikeElevenlabsIconSubmitButton(candidate);
}

function findElevenlabsGenerateActionTarget(target) {
  const candidates = elevenlabsCollectUniqueElements(
    collectElevenlabsInteractionCandidateElements(target).map((element) => findElevenlabsGenerateButtonAncestor(element))
  );
  for (const candidate of candidates) {
    if (!candidate) continue;
    if (looksLikeElevenlabsGenerateButton(candidate)) return candidate;
  }
  return null;
}

// ---- Task/Client Mapping gate for Generate — same block/re-dispatch-
// synthetic-click bypass-flag technique as content-envato-capture.js's
// runEnvatoTaskGate. ----

let elevenlabsTaskGateBypassTarget = null;
let elevenlabsTaskGateModalOpen = false;
let elevenlabsPendingTaskSelection = null; // consumed by armElevenlabsGeneration() on the bypass (re-dispatched) click

async function runElevenlabsTaskGate(target) {
  if (elevenlabsTaskGateModalOpen) return; // double-click Generate while the modal is already open - no-op
  elevenlabsTaskGateModalOpen = true;
  try {
    const selection = await openElevenlabsTaskSelectionModal();
    if (!selection) return; // cancelled/ESC/no active tasks - click stays blocked, generation is blocked
    elevenlabsPendingTaskSelection = selection;
    elevenlabsTaskGateBypassTarget = target;
    target.click();
  } finally {
    elevenlabsTaskGateModalOpen = false;
  }
}

document.addEventListener('click', (event) => {
  try {
    const target = findElevenlabsGenerateActionTarget(event.target);
    if (!target) return;

    if (elevenlabsTaskGateBypassTarget === target) {
      elevenlabsTaskGateBypassTarget = null; // one-shot: next Generate click gates again
      const selection = elevenlabsPendingTaskSelection;
      elevenlabsPendingTaskSelection = null;
      armElevenlabsGeneration(target, selection);
      return; // let the (re-dispatched) click reach ElevenLabs' own handler
    }

    event.preventDefault();
    event.stopImmediatePropagation();
    runElevenlabsTaskGate(target);
  } catch {}
}, true); // capturing phase - fires even if the page's own handler stops propagation

// ---- Row qualification + reporting ----

// A Music row's asset URL (song.download_url) often isn't resolved yet on
// its first sighting (generation still in progress - see
// CAPTURE_CONTRACT.md's "Confirmed network shape: Music") - unlike TTS,
// whose audio is essentially ready the instant the row exists at all.
function elevenlabsRowHasResolvedMusicAsset(row) {
  const effective = elevenlabsEffectiveRow(row);
  return Boolean(effective && typeof effective === 'object' && effective.download_url);
}

function evaluateElevenlabsRowForLiveCapture(row) {
  const identityValue = getElevenlabsRowIdentity(row);
  if (!identityValue) return { qualifies: false, reason: 'no_identity' };
  if (!isElevenlabsGenerationArmed()) return { qualifies: false, reason: 'not_armed' };

  const isMusicRow = Boolean(row && typeof row === 'object' && row.song && typeof row.song === 'object');
  const hasResolvedAsset = isMusicRow ? elevenlabsRowHasResolvedMusicAsset(row) : undefined;
  const previousCapture = elevenlabsActiveGeneration.capturedHistoryItemIds.get(identityValue);
  // Once-per-identity-per-arm for everything EXCEPT a Music row whose
  // first-ever capture happened before its asset URL existed - that one
  // gets exactly one more pass once the URL resolves, so
  // proactivelyFetchElevenlabsMusicAudio actually gets to run against a
  // fetchable row instead of being permanently starved by this same gate
  // (confirmed real 2026-08-17: a generation stuck at asset_mirror_status
  // "pending" indefinitely, first capture pre-dated the asset URL).
  const isNewlyResolvedMusicAsset = Boolean(previousCapture && isMusicRow && !previousCapture.hasAudioUrl && hasResolvedAsset);
  if (previousCapture && !isNewlyResolvedMusicAsset) {
    return { qualifies: false, reason: 'already_captured_this_session' };
  }

  const tsInfo = getElevenlabsRowRawTimestamp(row);
  if (!tsInfo) {
    // No timestamp-like field found on this row at all - shape unconfirmed
    // (see this file's header), so don't over-filter: allow it while armed,
    // but note that timestamp-based qualification was skipped.
    console.debug('[RMW ElevenLabs Capture] row has no recognizable timestamp field - allowing while armed, timestamp qualification skipped', { identityValue });
    return { qualifies: true, identityValue, timestampMs: null, hasAudioUrl: hasResolvedAsset };
  }

  const timestampMs = parseElevenlabsTimestampMs(tsInfo.field, tsInfo.raw);
  if (timestampMs === null) {
    console.debug('[RMW ElevenLabs Capture] timestamp field present but unparsable - allowing while armed, timestamp qualification skipped', { identityValue, field: tsInfo.field, raw: tsInfo.raw });
    return { qualifies: true, identityValue, timestampMs: null, hasAudioUrl: hasResolvedAsset };
  }

  // The freshness checks below reject a STALE row from before this
  // generation started - skipped for a newly-resolved Music asset, since
  // its timestamp never changes between the incomplete and resolved
  // snapshots (only song.download_url does), so it would otherwise get
  // wrongly rejected as "not newer than watermark".
  if (!isNewlyResolvedMusicAsset) {
    if (timestampMs < elevenlabsActiveGeneration.armedAt - ELEVENLABS_CLOCK_SKEW_SLACK_MS) {
      return { qualifies: false, reason: 'older_than_arm' };
    }
    if (elevenlabsLastLiveCapturedAt && timestampMs <= elevenlabsLastLiveCapturedAt - ELEVENLABS_CLOCK_SKEW_SLACK_MS) {
      return { qualifies: false, reason: 'not_newer_than_watermark' };
    }
  }
  return { qualifies: true, identityValue, timestampMs, hasAudioUrl: hasResolvedAsset };
}

// No completion/status gating in this pass - every qualifying row snapshot
// is captured immediately. The real completion signal (a status-like field
// on a history row) is unconfirmed - see CAPTURE_CONTRACT.md's known gaps.
// client_event_id's changeToken (see reportElevenlabsHistoryRow below)
// naturally re-captures a later, more-complete snapshot of the same
// identity without duplicating, once one is observed.
async function reportElevenlabsHistoryRow(row, { isReconciliation }) {
  const identityValue = getElevenlabsRowIdentity(row);
  if (!identityValue) return;

  const source = getElevenlabsRowSource(row);
  const tsInfo = getElevenlabsRowRawTimestamp(row);
  const changeToken = tsInfo ? `${tsInfo.raw}` : hashString(JSON.stringify(row));
  const clientEventId = `elevenlabs:${source || 'unknown'}:${identityValue}:${changeToken}`;

  try {
    const result = await elevenlabsSendRuntimeMessage({
      type: 'ELEVENLABS_CAPTURE_EVENT',
      event: {
        event_type: 'history_row',
        client_event_id: clientEventId,
        creation_id: identityValue || null,
        family_id: null,
        is_reconciliation: Boolean(isReconciliation),
        payload: row,
        capture_version: 1,
        linked_task_id: (!isReconciliation && elevenlabsActiveGeneration) ? elevenlabsActiveGeneration.taskId : null,
        linked_client_id: (!isReconciliation && elevenlabsActiveGeneration) ? elevenlabsActiveGeneration.clientId : null,
      },
    });
    if (result?.ok) {
      console.debug('[RMW ElevenLabs Capture] reported history row', { identityValue, isReconciliation, queued: result.queued });
      if (!isReconciliation) setElevenlabsCaptureStatus('Queued for upload…');
    } else {
      console.warn('[RMW ElevenLabs Capture] failed to report history row', { identityValue, isReconciliation, error: result?.error });
      if (!isReconciliation) setElevenlabsCaptureStatus(`Capture failed: ${result?.error || 'unknown error'}`, { autoHideMs: 8000 });
    }
  } catch (error) {
    console.warn('[RMW ElevenLabs Capture] unexpected error reporting history row', { identityValue, error: error?.message || error });
  }
}

function processElevenlabsIncomingRow(row) {
  const evaluation = evaluateElevenlabsRowForLiveCapture(row);
  if (!evaluation.qualifies) {
    console.debug('[RMW ElevenLabs Capture] ignored non-qualifying row (not a live generation)', {
      identity: getElevenlabsRowIdentity(row), reason: evaluation.reason,
    });
    return;
  }
  elevenlabsActiveGeneration.capturedHistoryItemIds.set(evaluation.identityValue, { hasAudioUrl: Boolean(evaluation.hasAudioUrl) });
  scheduleElevenlabsArmQuietReset(); // this counts as recent activity - extend the window
  if (evaluation.timestampMs) persistElevenlabsLastLiveCapturedAt(evaluation.timestampMs);
  setElevenlabsCaptureStatus('Capturing…');
  console.debug('[RMW ElevenLabs Capture] qualifying row - reporting as live', { identity: evaluation.identityValue });
  reportElevenlabsHistoryRow(row, { isReconciliation: false });

  // Try to fetch the audio ourselves first (deterministic, no dependency on
  // Play/Download ever happening at all - see "Proactive audio fetch"
  // above). Fire-and-forget: reportElevenlabsAudioCapture's own dedupe means
  // this can safely run alongside the correlation fallback below without
  // double-uploading if both happen to succeed for the same row.
  // Music rows (structurally identified by a nested `song` object - see
  // elevenlabsEffectiveRow above) carry their own asset URL and use a
  // separate proactive fetch that needs the row itself, not just the id -
  // see proactivelyFetchElevenlabsMusicAudio's own comment for why this is
  // simpler than TTS's endpoint-based fetch below.
  if (row && typeof row === 'object' && row.song && typeof row.song === 'object') {
    proactivelyFetchElevenlabsMusicAudio(row);
  } else {
    proactivelyFetchElevenlabsAudio(evaluation.identityValue);
  }

  // Audio correlation (see the "Audio correlation" section below for the
  // full why) - a fresh Generate produces its audio synchronously, then the
  // history row for it shows up moments later via this same poll, so a
  // buffered unattributed blob at this exact moment is, in practice, always
  // this row's own audio.
  const correlatedAudio = takeElevenlabsPendingUnattributedAudio();
  if (correlatedAudio) {
    console.debug('[RMW ElevenLabs Capture] correlated buffered audio with this live row', { identity: evaluation.identityValue });
    reportElevenlabsAudioCapture({ historyItemId: evaluation.identityValue, ...correlatedAudio });
  }

  // Remembers this row so a LATER Play (the row already qualified once,
  // won't qualify again - see already_captured_this_session above) can still
  // find something to correlate against. See the "Audio correlation"
  // section below for the full reasoning.
  noteElevenlabsLastLiveReportedRow(evaluation.identityValue);
}

// ---- Relay for content-elevenlabs-network.js's (MAIN world) intercepted
// `/history` responses ----

function onElevenlabsNetworkMessage(event) {
  if (event.source !== window) return;
  const data = event.data;
  if (!data || data.source !== 'rmw-elevenlabs-network-telemetry') return;

  if (data.type === 'ELEVENLABS_NETWORK_GENERATION') {
    const rows = data.payload && Array.isArray(data.payload.rows) ? data.payload.rows : [];
    rows.forEach((row) => processElevenlabsIncomingRow(row));
    return;
  }

  if (data.type === 'ELEVENLABS_NETWORK_AUDIO') {
    reportElevenlabsAudioCapture(data.payload);
    return;
  }

  if (data.type === 'ELEVENLABS_NETWORK_AUDIO_UNATTRIBUTED') {
    bufferElevenlabsUnattributedAudio(data.payload);
    return;
  }

  if (data.type === 'ELEVENLABS_NETWORK_AUTH_TOKEN') {
    elevenlabsCachedAuth = { apiHost: data.payload?.apiHost, authorization: data.payload?.authorization };
  }
}

window.addEventListener('message', onElevenlabsNetworkMessage);

// Populated from content-elevenlabs-network.js's ELEVENLABS_NETWORK_AUTH_TOKEN
// relay - see that file's "AUTH TOKEN RELAY" comment for the full story:
// this content script has no ambient access to the page's own Authorization
// header, and elevenlabs.io does NOT proxy /v1/* to the real API over the
// ordinary session cookie the way an earlier version of this file assumed
// (confirmed: that path returns a plain HTML fallback page, not JSON/audio).
// null until the MAIN-world interceptor observes the page's own first real
// API call, which happens very early (the history-list poll fires on load).
let elevenlabsCachedAuth = null; // {apiHost, authorization} | null

function elevenlabsApiUrl(path) {
  const host = elevenlabsCachedAuth?.apiHost || 'api.us.elevenlabs.io'; // best-known default, overridden the moment a real one is observed
  return `https://${host}${path}`;
}

function elevenlabsApiHeaders(extra = {}) {
  const headers = { ...extra };
  if (elevenlabsCachedAuth?.authorization) headers.Authorization = elevenlabsCachedAuth.authorization;
  return headers;
}

// ---- Audio correlation (Play, and anything else that never carries its own
// id) ----
//
// Reported live, 2026-08-13: Download reliably captures (its request body
// carries history_item_id - see content-elevenlabs-network.js), but Play on
// an already-generated clip never does, even across REPEATED plays - neither
// the URL, response headers, nor request body of whatever request Play (or
// the underlying stream Generate itself uses) issues ever carries an id.
// Rather than keep guessing at a fourth deterministic signal,
// content-elevenlabs-network.js now captures EVERY unattributable audio/*
// response and hands it here as "unattributed" for correlation.
//
// Two directions, because the real ordering isn't fixed:
//   1. Audio-then-row: a fresh Generate produces its audio synchronously,
//      and the history-list row for it only shows up moments later via the
//      poll. Handled by buffering the audio and consuming it the moment a
//      row next qualifies as a live capture (processElevenlabsIncomingRow).
//   2. Row-then-audio (the reported case: "generated and played multiple
//      times"): the row already qualified/was reported BEFORE Play was ever
//      clicked (it only fires once per row per session - see
//      already_captured_this_session in evaluateElevenlabsRowForLiveCapture),
//      so waiting for a NEW qualifying-row event would never happen for a
//      replay of something already captured. Handled by remembering the
//      most recently live-reported row's identity and attributing any
//      unattributed audio that arrives soon after directly to it, without
//      waiting for another row event at all.
//
// Both are heuristic, not deterministic - trade-off accepted deliberately:
// a slightly-too-generous window occasionally misattributing a Play to the
// wrong (adjacent) generation is strictly better than the alternative this
// replaces, which was never attributing Play'd audio to anything at all.
// The "most recent row" window is intentionally longer than the "buffered
// audio, no row yet" window - a delayed replay minutes later is common and
// worth covering; an audio blob sitting unclaimed for many minutes with no
// row ever showing up at all is more likely stale/unrelated than something
// worth waiting further for.
const ELEVENLABS_AUDIO_BUFFER_TTL_MS = 45000; // audio arrived, no row known yet
const ELEVENLABS_RECENT_ROW_CORRELATION_MS = 3 * 60 * 1000; // row known, audio arrives later (repeated Play)

let elevenlabsPendingUnattributedAudio = null; // {contentType, audioBase64, capturedAt, isDownload} | null
let elevenlabsLastLiveReportedIdentity = null;
let elevenlabsLastLiveReportedAt = 0;

function noteElevenlabsLastLiveReportedRow(identityValue) {
  elevenlabsLastLiveReportedIdentity = identityValue;
  elevenlabsLastLiveReportedAt = Date.now();
}

function bufferElevenlabsUnattributedAudio(payload) {
  const audioBase64 = payload?.audioBase64;
  if (!audioBase64) return;
  // Set only by content-elevenlabs-network.js's blob-URL Download-click
  // detector (an <a download> with a blob: href actually being clicked) -
  // never by the generic "audio response with no id" fetch/XHR fallback
  // this same buffer also feeds from, which is Play, not a download. See
  // that file's own "Blob-URL Download capture" comment for why a real
  // Download click can produce no observable network request at all for a
  // while after generating (served from an in-memory cached Blob), which is
  // what this whole path exists to still catch.
  const isDownload = Boolean(payload.isDownload);

  // Direction 2 first: if a live row was reported recently enough, this is
  // almost certainly a replay of it (or of the clip that was just
  // generated) - attribute immediately rather than buffering at all.
  if (elevenlabsLastLiveReportedIdentity && Date.now() - elevenlabsLastLiveReportedAt <= ELEVENLABS_RECENT_ROW_CORRELATION_MS) {
    console.debug('[RMW ElevenLabs Capture] correlated audio with the most recently reported row', { identity: elevenlabsLastLiveReportedIdentity, isDownload });
    reportElevenlabsAudioCapture({
      historyItemId: elevenlabsLastLiveReportedIdentity,
      contentType: payload.contentType || 'audio/mpeg',
      audioBase64,
      isDownload,
    });
    return;
  }

  // Direction 1 fallback: no recent row known yet - buffer for
  // processElevenlabsIncomingRow to consume once one shows up.
  elevenlabsPendingUnattributedAudio = {
    contentType: payload.contentType || 'audio/mpeg',
    audioBase64,
    capturedAt: Date.now(),
    isDownload,
  };
  console.debug('[RMW ElevenLabs Capture] buffered unattributed audio, awaiting a live row to correlate with', { isDownload });
}

// One-shot: consuming clears the buffer so the same blob is never attached
// to more than one generation.
function takeElevenlabsPendingUnattributedAudio() {
  const pending = elevenlabsPendingUnattributedAudio;
  elevenlabsPendingUnattributedAudio = null;
  if (!pending) return null;
  if (Date.now() - pending.capturedAt > ELEVENLABS_AUDIO_BUFFER_TTL_MS) return null;
  return pending;
}

// ---- Proactive audio fetch (deterministic, replaces the need for
// correlation whenever it works) ----
//
// First version of this function assumed the same broken same-origin/cookie
// path fetchElevenlabsHistoryPage did (see that function's own comment for
// the confirmed root cause: elevenlabs.io has no `/v1/*` proxy at all, that
// request just hit Next.js's HTML fallback page). Fixed the same way: use
// the real API host + Authorization header relayed from
// content-elevenlabs-network.js. Every call result (ok, wrong content-type,
// non-2xx, network error) is still logged so it's obvious from console
// output whether this path is actually live for a given account/session,
// and the buffer/correlation mechanism above stays in place as a backstop
// for whatever this doesn't cover (e.g. before the first auth token has
// been observed yet, early in a fresh page load).
const ELEVENLABS_PROACTIVE_AUDIO_ENDPOINT = '/v1/history/download';

function elevenlabsArrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  const CHUNK_SIZE = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += CHUNK_SIZE) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK_SIZE));
  }
  return btoa(binary);
}

async function proactivelyFetchElevenlabsAudio(historyItemId) {
  if (!historyItemId) return;
  try {
    // credentials deliberately OMITTED (not 'include') - see
    // elevenlabsApiHeaders' own comment: the real API's CORS response uses a
    // wildcard Access-Control-Allow-Origin, which browsers refuse to expose
    // to a credentialed ('include') request no matter what, regardless of
    // the Authorization header. The page's own request works precisely
    // because it never asks for credentialed mode either - auth is 100%
    // the Authorization header, cookies aren't part of this at all.
    // Confirmed live 2026-08-13: reaches the real endpoint now (CORS fix
    // worked), but 422s with a singular `history_item_id` field - the
    // endpoint name itself ("download", ElevenLabs' documented BULK
    // download route) suggests it wants the plural array shape instead,
    // same as the confirmed real Download-button request body
    // (extractHistoryItemIdFromRequestBody in content-elevenlabs-network.js
    // already accepts a single-entry array on the OBSERVE side - this is
    // the send side using the same shape).
    const response = await fetch(elevenlabsApiUrl(ELEVENLABS_PROACTIVE_AUDIO_ENDPOINT), {
      method: 'POST',
      headers: elevenlabsApiHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ history_item_ids: [historyItemId] }),
    });
    if (!response.ok) {
      // Read the body on failure only - a FastAPI/uvicorn 422 (confirmed via
      // the `server: uvicorn` response header seen in real traffic) carries
      // the exact validation error in its JSON body, which a bare status
      // code doesn't - logging it means a wrong guess here is fixable from
      // the very next report instead of needing yet another round trip.
      const errorBody = await response.text().catch(() => '');
      console.debug('[RMW ElevenLabs Capture] proactive audio fetch failed', {
        historyItemId, status: response.status, hadAuthToken: Boolean(elevenlabsCachedAuth),
        errorBody: errorBody.slice(0, 1000),
      });
      return;
    }
    const contentType = response.headers.get('content-type') || '';
    if (!/^audio\//i.test(contentType)) {
      console.debug('[RMW ElevenLabs Capture] proactive audio fetch returned non-audio content-type', { historyItemId, contentType });
      return;
    }
    const buffer = await response.arrayBuffer();
    if (!buffer || !buffer.byteLength) return;
    const audioBase64 = elevenlabsArrayBufferToBase64(buffer);
    console.debug('[RMW ElevenLabs Capture] proactively fetched audio', { historyItemId, contentType, bytes: buffer.byteLength });
    reportElevenlabsAudioCapture({ historyItemId, contentType, audioBase64 });
  } catch (error) {
    console.debug('[RMW ElevenLabs Capture] proactive audio fetch error', { historyItemId, error: error?.message || error });
  }
}

// Music's own row already carries its asset URL (song.download_url - a
// public GCS v4-signed URL, confirmed 2026-08-17, ~24h expiry) - unlike TTS,
// no separate authenticated endpoint call is needed at all, just a plain
// GET on that URL. Same "deterministic, no dependency on Play/Download ever
// happening" posture as proactivelyFetchElevenlabsAudio above, simpler here
// since the URL is already in hand rather than needing a lookup-by-id call.
async function proactivelyFetchElevenlabsMusicAudio(row) {
  const effective = elevenlabsEffectiveRow(row);
  const historyItemId = getElevenlabsRowIdentity(row);
  const downloadUrl = effective && typeof effective === 'object' ? effective.download_url : null;
  if (!historyItemId || !downloadUrl) return;
  try {
    // No Authorization header, no credentials - a signed URL is the auth.
    const response = await fetch(downloadUrl);
    if (!response.ok) {
      console.debug('[RMW ElevenLabs Capture] Music proactive audio fetch failed', { historyItemId, status: response.status });
      return;
    }
    const contentType = response.headers.get('content-type') || 'audio/mp4';
    const buffer = await response.arrayBuffer();
    if (!buffer || !buffer.byteLength) return;
    const audioBase64 = elevenlabsArrayBufferToBase64(buffer);
    console.debug('[RMW ElevenLabs Capture] proactively fetched Music audio', { historyItemId, contentType, bytes: buffer.byteLength });
    reportElevenlabsAudioCapture({ historyItemId, contentType, audioBase64 });
  } catch (error) {
    console.debug('[RMW ElevenLabs Capture] Music proactive audio fetch error', { historyItemId, error: error?.message || error });
  }
}

// Pushes an observed audio response's actual bytes to the backend, keyed by
// historyItemId - see content-elevenlabs-network.js's "AUDIO DELIVERY"
// comment for why this exists (the history row carries no downloadable URL
// at all, and the real audio endpoint requires the browser's own session,
// so only the browser can ever obtain these bytes). Not gated by arm state
// or correlated with a generation/task/client the way capture events are -
// this is pure asset delivery for a generation that (almost always) already
// has its own metadata row captured separately; the backend's
// POST /capture/audio endpoint is itself a no-op (not an error) if that row
// hasn't landed yet, and this naturally re-fires every time the same clip is
// played/downloaded again, so a miss here is self-healing, not a lost event.
const elevenlabsRecentlyPushedAudioIds = new Map(); // historyItemId -> {pushedAt, isDownload} (only on a CONFIRMED outcome - see below)
const ELEVENLABS_AUDIO_PUSH_DEDUPE_MS = 60000; // avoid re-uploading the exact same clip on rapid repeat playback
// Reported bug, confirmed live 2026-08-13: audio is captured and pushed
// essentially instantly (often before the row has even been reported yet -
// this function can genuinely fire before reportElevenlabsHistoryRow's own
// queued/batched upload has reached the backend and been normalized into an
// ElevenlabsGeneration row). The backend's /capture/audio correctly replies
// status:"generation_not_found" in that case rather than erroring - but the
// ORIGINAL version of this function marked the push as "done" (via
// elevenlabsRecentlyPushedAudioIds) regardless of the actual result, so that
// race permanently ate the one real capture with no retry, for the full
// 60s dedupe window. Fixed: only lock out further attempts on a CONFIRMED
// outcome (success, or a non-transient failure); a generation_not_found
// result retries a few times with a short delay instead, since the
// underlying row reliably lands within a few seconds.
const ELEVENLABS_AUDIO_PUSH_MAX_ATTEMPTS = 4;
const ELEVENLABS_AUDIO_PUSH_RETRY_DELAY_MS = 4000; // linear backoff: 4s, 8s, 12s

async function reportElevenlabsAudioCapture(payload, attempt = 1) {
  const historyItemId = `${payload?.historyItemId || ''}`.trim();
  const audioBase64 = payload?.audioBase64;
  if (!historyItemId || !audioBase64) return;

  const isDownload = Boolean(payload.isDownload);

  if (attempt === 1) {
    const now = Date.now();
    const last = elevenlabsRecentlyPushedAudioIds.get(historyItemId);
    const withinDedupeWindow = last && now - last.pushedAt < ELEVENLABS_AUDIO_PUSH_DEDUPE_MS;
    // Reported bug, confirmed live 2026-08-14: this dedupe used to key only
    // on "have we pushed this id recently", blind to WHAT that earlier push
    // reported. The proactive fetch (fires automatically, seconds after
    // every generation, isDownload=false) almost always wins the race and
    // locks this id for a full 60s - so a real Download click landing inside
    // that window (extremely common: clicking Download shortly after
    // generating is exactly when this bug bit) got silently swallowed here,
    // isDownload:true never even reaching the backend, downloaded_at never
    // set, with no error/log of any kind to explain why. Fixed: only skip
    // when this call has nothing NEW to report - i.e. it isn't a download,
    // or a download was already recorded for this id. A download signal
    // always gets through at least once.
    if (withinDedupeWindow && (!isDownload || last.isDownload)) return;
  }

  try {
    const result = await elevenlabsSendRuntimeMessage({
      type: 'ELEVENLABS_CAPTURE_AUDIO',
      historyItemId,
      contentType: payload.contentType || 'audio/mpeg',
      audioBase64,
      // Only ever true when this payload came straight from content-
      // elevenlabs-network.js's postAudioCapture (a confirmed Download click
      // - see that file's comment on isDownload). The proactive-fetch and
      // Play-correlation callers of this function never set it, so it
      // correctly defaults to falsy there - neither is a real user download.
      isDownload,
    });
    if (result?.ok) {
      // isDownload is sticky-true: once a download has been recorded for
      // this id, a later non-download push (e.g. a Play replay) must not
      // clear that memory and re-open the window for a same-second repeat
      // Download click to slip through the dedupe check above unnecessarily.
      const previouslyDownload = elevenlabsRecentlyPushedAudioIds.get(historyItemId)?.isDownload;
      elevenlabsRecentlyPushedAudioIds.set(historyItemId, { pushedAt: Date.now(), isDownload: isDownload || Boolean(previouslyDownload) });
      console.debug('[RMW ElevenLabs Capture] pushed audio asset', { historyItemId, status: result.status, attempt, isDownload });
      return;
    }
    if (result?.status === 'generation_not_found' && attempt < ELEVENLABS_AUDIO_PUSH_MAX_ATTEMPTS) {
      const delay = ELEVENLABS_AUDIO_PUSH_RETRY_DELAY_MS * attempt;
      console.debug('[RMW ElevenLabs Capture] audio arrived before its generation row - retrying shortly', { historyItemId, attempt, delay });
      window.setTimeout(() => reportElevenlabsAudioCapture(payload, attempt + 1), delay);
      return;
    }
    // Terminal failure - lock out further attempts for this id so a
    // persistently-broken row doesn't get hammered every time it's
    // re-observed. EXCEPT when the retries above were exhausted while still
    // getting generation_not_found: reported live 2026-08-14 - downloading a
    // clip within ~1s of generating it can outlast this whole ~24s retry
    // window (metadata capture racing a slow accelerated-poll/queue-flush/
    // normalization chain), and generation_not_found isn't a persistently-
    // broken row, it's a row that hasn't landed YET. Locking here anyway used
    // to silently swallow the user's own manual re-download click for the
    // full 60s dedupe window (attempt===1's check above), forcing them to
    // wait it out before a retry did anything - by the time they'd noticed
    // and re-clicked, the row had almost always already landed, so the fix is
    // to just let that click through as a fresh attempt instead of eating it.
    if (result?.status !== 'generation_not_found') {
      // This attempt reported nothing new (it failed) - preserve whatever
      // was already recorded rather than overwriting a prior isDownload:true
      // with false.
      const previouslyDownload = elevenlabsRecentlyPushedAudioIds.get(historyItemId)?.isDownload;
      elevenlabsRecentlyPushedAudioIds.set(historyItemId, { pushedAt: Date.now(), isDownload: Boolean(previouslyDownload) });
    }
    console.warn('[RMW ElevenLabs Capture] failed to push audio asset', { historyItemId, error: result?.error, status: result?.status, attempt });
  } catch (error) {
    const previouslyDownload = elevenlabsRecentlyPushedAudioIds.get(historyItemId)?.isDownload;
    elevenlabsRecentlyPushedAudioIds.set(historyItemId, { pushedAt: Date.now(), isDownload: Boolean(previouslyDownload) });
    console.warn('[RMW ElevenLabs Capture] unexpected error pushing audio asset', { historyItemId, error: error?.message || error });
  }
}

// ----------------------------------------------------------------------------
// Reconciliation walker — pages /v1/history directly per known `source`
// value. Confirmed via a real DevTools screenshot: the request URL shape
// `history?page_size=20&source=TTS&sort_direction=desc` (response body never
// captured - see this file's header). Primary, not fallback, capture signal,
// same as content-envato-capture.js's walker.
// ----------------------------------------------------------------------------

// Only "TTS" is confirmed. New source values (Music/Sound-Effects/Dubbing/
// Voice-Changer) get appended here once confirmed via the diagnostic
// logging in content-elevenlabs-network.js's logUnrecognizedShapeIfPromising
// - never guessed at.
const ELEVENLABS_KNOWN_SOURCES = ['TTS'];
const ELEVENLABS_SYNC_STORAGE_KEY = 'rmw_elevenlabs_sync_state';
const ELEVENLABS_RECONCILIATION_MIN_GAP_MS = 20 * 60 * 1000; // one full walk per tab per ~20 min
const ELEVENLABS_HISTORY_PAGE_SIZE = 20;
const ELEVENLABS_RECONCILIATION_MAX_PAGES_PER_SOURCE = 5; // guard against an unbounded loop if pagination fields lie

async function getElevenlabsSyncState() {
  const stored = await chromeStorageGet([ELEVENLABS_SYNC_STORAGE_KEY]);
  return stored[ELEVENLABS_SYNC_STORAGE_KEY] || {};
}

async function patchElevenlabsSyncState(patch) {
  const current = await getElevenlabsSyncState();
  const next = { ...current, ...patch };
  await chromeStorageSet({ [ELEVENLABS_SYNC_STORAGE_KEY]: next });
  return next;
}

// The cursor query param name below (`start_after_history_item_id`) is NOT
// confirmed - no paginated (page 2+) request has ever been captured, only
// the page-1 URL shape. Best-effort guess following ElevenLabs' own public
// API convention; update once a real paginated request is observed. Page 1
// (no cursor) is the confirmed shape and always safe to send.
// Reported bug, confirmed live 2026-08-13: this previously fetched
// `${location.origin}/v1/history` (i.e. elevenlabs.io itself), assuming it
// proxies to the real API over the ordinary session cookie. Confirmed
// false - elevenlabs.io has no such route; that request returned Next.js's
// plain HTML fallback page, which failed to parse as JSON, silently
// aborting every single reconciliation walk from the very start ("page
// fetch/decode failed, stopping walk" - a log that had always fired, never
// actually noticed as a real bug since the MAIN-world observation path
// covers live captures independently and never depended on this). Fixed to
// use the real API host + Authorization header relayed from
// content-elevenlabs-network.js (see elevenlabsCachedAuth above) - a no-op
// 401 until the first real page request is observed, same graceful-miss
// posture as before, just for a different (now correct) reason.
async function fetchElevenlabsHistoryPage(source, afterId) {
  try {
    const params = new URLSearchParams();
    params.set('page_size', String(ELEVENLABS_HISTORY_PAGE_SIZE));
    params.set('source', source);
    params.set('sort_direction', 'desc');
    if (afterId) params.set('start_after_history_item_id', afterId);
    // credentials deliberately OMITTED - see proactivelyFetchElevenlabsAudio's
    // identical comment: the real API's wildcard CORS response is
    // incompatible with a credentialed ('include') request at the browser
    // level, independent of the Authorization header, which is the actual
    // (and sufficient) auth mechanism here.
    const response = await fetch(elevenlabsApiUrl(`/v1/history?${params.toString()}`), {
      headers: elevenlabsApiHeaders(),
    });
    if (!response.ok) return null;
    return await response.json().catch(() => null);
  } catch {
    return null;
  }
}

// Defensive pagination: tries common response field names (has_more /
// last_history_item_id) and stops rather than looping forever if neither is
// present after page 1 - the real pagination contract is unconfirmed.
async function walkElevenlabsReconciliationForSource(source, sourceState) {
  let afterId = sourceState?.cursor || null;
  let lastSeenId = sourceState?.lastSeenId || null;
  let pagesWalked = 0;

  for (; pagesWalked < ELEVENLABS_RECONCILIATION_MAX_PAGES_PER_SOURCE; pagesWalked++) {
    const json = await fetchElevenlabsHistoryPage(source, afterId);
    if (!json) {
      console.warn('[RMW ElevenLabs Sync] page fetch/decode failed, stopping walk', { source, page: pagesWalked + 1 });
      break;
    }

    const rows = extractElevenlabsHistoryRowsFromJson(json);
    if (!rows.length) {
      console.debug('[RMW ElevenLabs Sync] page returned no recognizable rows, stopping walk', { source, page: pagesWalked + 1 });
      break;
    }

    for (const row of rows) {
      await reportElevenlabsHistoryRow(row, { isReconciliation: true });
      const id = getElevenlabsRowIdentity(row);
      if (id) lastSeenId = id;
    }

    const hasMore = json?.has_more;
    const nextCursor = json?.last_history_item_id;
    if (hasMore && nextCursor) {
      afterId = nextCursor;
      continue;
    }
    break; // neither field present, or has_more explicitly false - stop rather than guess
  }

  return { cursor: afterId, lastSeenId };
}

// ----------------------------------------------------------------------------
// Music reconciliation walker — /v1/music/chats, confirmed shape 2026-08-17
// (see CAPTURE_CONTRACT.md's "Confirmed network shape: Music"). Kept as a
// parallel walker rather than folding into walkElevenlabsReconciliationFor
// Source above: pagination is page-number based (page/per_page), not
// cursor-based (start_after_history_item_id), and the envelope/row shape
// differ (chats[], row nested in .song - see elevenlabsEffectiveRow).
// ----------------------------------------------------------------------------

const ELEVENLABS_MUSIC_SOURCE_KEY = 'Music'; // storage key alongside ELEVENLABS_KNOWN_SOURCES entries in perSource - opaque per-source state, shape doesn't need to match TTS's {cursor,lastSeenId}
const ELEVENLABS_MUSIC_PAGE_SIZE = 20;
const ELEVENLABS_MUSIC_MAX_PAGES = 5; // same unbounded-loop guard rationale as ELEVENLABS_RECONCILIATION_MAX_PAGES_PER_SOURCE

async function fetchElevenlabsMusicChatsPage(page) {
  try {
    const params = new URLSearchParams();
    params.set('page', String(page));
    params.set('per_page', String(ELEVENLABS_MUSIC_PAGE_SIZE));
    params.set('sort_by', 'created_at_utc');
    params.set('sort_order', 'desc');
    // credentials deliberately OMITTED - same wildcard-CORS reasoning as
    // fetchElevenlabsHistoryPage above.
    const response = await fetch(elevenlabsApiUrl(`/v1/music/chats?${params.toString()}`), {
      headers: elevenlabsApiHeaders(),
    });
    if (!response.ok) return null;
    return await response.json().catch(() => null);
  } catch {
    return null;
  }
}

// Page-number pagination, unlike /v1/history's cursor above - stops once a
// row matching the previous walk's lastSeenId is reached (nothing new since
// last time) or a page comes back short of a full page (last page) - no
// confirmed has_more/total field to depend on instead.
async function walkElevenlabsMusicReconciliation(sourceState) {
  const lastSeenId = sourceState?.lastSeenId || null;
  let newestSeenThisWalk = null;

  for (let page = 0; page < ELEVENLABS_MUSIC_MAX_PAGES; page++) {
    const json = await fetchElevenlabsMusicChatsPage(page);
    if (!json) {
      console.warn('[RMW ElevenLabs Sync] Music page fetch/decode failed, stopping walk', { page: page + 1 });
      break;
    }

    const rows = extractElevenlabsHistoryRowsFromJson(json);
    if (!rows.length) {
      console.debug('[RMW ElevenLabs Sync] Music page returned no recognizable rows, stopping walk', { page: page + 1 });
      break;
    }

    let reachedKnownRow = false;
    for (const row of rows) {
      const id = getElevenlabsRowIdentity(row);
      if (id && lastSeenId && id === lastSeenId) { reachedKnownRow = true; break; }
      await reportElevenlabsHistoryRow(row, { isReconciliation: true });
      // Unlike TTS's reconciliation walk above (no embedded asset URL, so
      // audio genuinely can only come from a later Play/Download), a Music
      // row IS its own asset URL - fetched here too, not just from
      // processElevenlabsIncomingRow's live-capture path, so a generation
      // this walker (rather than live capture) happens to find first still
      // gets its audio, not just its metadata.
      if (row && typeof row === 'object' && row.song && typeof row.song === 'object') {
        proactivelyFetchElevenlabsMusicAudio(row);
      }
      if (page === 0 && !newestSeenThisWalk && id) newestSeenThisWalk = id;
    }
    if (reachedKnownRow) break;

    const chats = Array.isArray(json.chats) ? json.chats : [];
    if (chats.length < ELEVENLABS_MUSIC_PAGE_SIZE) break; // short page - last one
  }

  return { lastSeenId: newestSeenThisWalk || lastSeenId };
}

async function walkElevenlabsReconciliation() {
  const state = await getElevenlabsSyncState();
  const now = Date.now();
  if (state.lastWalkAt && now - state.lastWalkAt < ELEVENLABS_RECONCILIATION_MIN_GAP_MS) {
    console.debug('[RMW ElevenLabs Sync] walk skipped: ran too recently', { lastWalkAt: state.lastWalkAt });
    return;
  }

  console.debug('[RMW ElevenLabs Sync] starting reconciliation walk', { sources: [...ELEVENLABS_KNOWN_SOURCES, ELEVENLABS_MUSIC_SOURCE_KEY] });
  await patchElevenlabsSyncState({ lastWalkAt: now });

  const perSource = state.perSource || {};
  const nextPerSource = { ...perSource };
  for (const source of ELEVENLABS_KNOWN_SOURCES) {
    try {
      nextPerSource[source] = await walkElevenlabsReconciliationForSource(source, perSource[source]);
    } catch (error) {
      console.warn('[RMW ElevenLabs Sync] walk failed for source, skipping', { source, error: error?.message || error });
    }
  }
  try {
    nextPerSource[ELEVENLABS_MUSIC_SOURCE_KEY] = await walkElevenlabsMusicReconciliation(perSource[ELEVENLABS_MUSIC_SOURCE_KEY]);
  } catch (error) {
    console.warn('[RMW ElevenLabs Sync] Music walk failed, skipping', { error: error?.message || error });
  }

  await patchElevenlabsSyncState({ perSource: nextPerSource });
  console.debug('[RMW ElevenLabs Sync] walk finished', { perSource: nextPerSource });
}

// Accelerated one-off poll fired ~4s after arming (see armElevenlabsGeneration)
// so live capture doesn't wait for the next scheduled walk. Deliberately
// does NOT touch the reconciliation cursor (unlike walkElevenlabsReconciliation)
// and reports through the same live-capture (isReconciliation:false) path as
// content-elevenlabs-network.js's relay - this is meant to catch the just-
// armed generation quickly, not backfill history.
async function triggerElevenlabsHistoryPoll() {
  if (!isElevenlabsGenerationArmed()) return;
  for (const source of ELEVENLABS_KNOWN_SOURCES) {
    try {
      const json = await fetchElevenlabsHistoryPage(source, null);
      if (!json) continue;
      const rows = extractElevenlabsHistoryRowsFromJson(json);
      rows.forEach((row) => processElevenlabsIncomingRow(row));
    } catch (error) {
      console.warn('[RMW ElevenLabs Capture] accelerated post-arm poll failed', { source, error: error?.message || error });
    }
  }
  try {
    const json = await fetchElevenlabsMusicChatsPage(0);
    if (json) {
      const rows = extractElevenlabsHistoryRowsFromJson(json);
      rows.forEach((row) => processElevenlabsIncomingRow(row));
    }
  } catch (error) {
    console.warn('[RMW ElevenLabs Capture] accelerated Music post-arm poll failed', { error: error?.message || error });
  }
}

// ---- Boot: register listeners immediately (passive), start the
// reconciliation walker on its own timer. Nothing here needs to wait for any
// particular readiness state. ----

window.setTimeout(() => {
  walkElevenlabsReconciliation().catch(() => {});
}, 6000);

window.setInterval(() => {
  walkElevenlabsReconciliation().catch(() => {});
}, ELEVENLABS_RECONCILIATION_MIN_GAP_MS);
