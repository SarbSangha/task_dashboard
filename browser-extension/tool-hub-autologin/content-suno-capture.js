// content-suno-capture.js — Suno Generation Capture (isolated world,
// suno.com only).
//
// Deliberately its OWN file rather than folded into content-suno.js (the
// autologin script, which stays exactly as-is - see that file). Keeping
// capture fully separate means a bug here can never regress the working
// autologin flow, and vice versa - same split content-elevenlabs-capture.js
// uses relative to content-elevenlabs.js (this file's primary template).
// Every helper this file needs is therefore its own local copy, not borrowed
// from content-suno.js or any other tool's capture file - no assumption
// about cross-file load order beyond what manifest.json's content_scripts
// ordering already guarantees (task-api + task-modal load before this file).
//
// Design, in one paragraph: unlike ElevenLabs (only a URL shape confirmed,
// no response body ever captured), Suno's real traffic IS fully confirmed
// from a live DevTools capture (2026-08-17): `POST /api/feed/v3` returning
// `{ clips: [...], has_more }`, flat `id` identity, `created_at` ISO-8601
// timestamp, and a deterministic readiness signal in
// action_config.actions[].find(a => a.action_type === 'download_song').disabled.
// That puts Suno in a stronger position than ElevenLabs on shape, but in the
// SAME position on request-body/pagination (the reconciliation walker's own
// outgoing POST body has never been captured - only the response was). Three
// independent pieces, same shape as content-elevenlabs-capture.js:
//   1. A click-arm gate on the "Create" button (blocks the click, shows the
//      task/client modal, re-dispatches a synthetic click on Continue) -
//      arms a capture window, does NOT hold the real network request.
//   2. A relay for content-suno-network.js's (MAIN world) intercepted
//      `/api/feed/v3` responses - reported live only while armed.
//   3. A reconciliation walker that POSTs `/api/feed/v3` directly on a
//      timer, independent of arming - the primary, not fallback, capture
//      signal, exactly like ElevenLabs'/Envato's.
//
// KNOWN RISK (see content-elevenlabs-capture.js's identical header note):
// blocking+re-dispatching a click broke generation on Flow (a synthetic
// gesture can't mint a valid anti-bot token there); it works fine for
// Envato/ElevenLabs. We do not yet know which case Suno is. If generation
// silently hangs/fails right after a task/client pick during first real use,
// the fallback is Flow's non-blocking arm-on-observed-click design (Cancel
// would then only skip attribution, not abort generation).

// ---- Self-contained utility helpers (see this file's own header for why
// these are local copies, not shared with content-suno.js) ----

function sunoSendRuntimeMessage(message) {
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

function sunoIsVisible(element) {
  if (!element) return false;
  const rect = element.getBoundingClientRect();
  const style = window.getComputedStyle(element);
  return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
}

function sunoIsDisabled(element) {
  if (!element) return true;
  return Boolean(
    element.disabled
    || element.getAttribute('aria-disabled') === 'true'
    || element.getAttribute('disabled') !== null
  );
}

const SUNO_ACTION_SELECTORS = ['button', 'input[type="submit"]', 'a[href]', '[role="button"]'];
const SUNO_GATE_EXCLUDED_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT', 'OPTION']);

function sunoCollectUniqueElements(elements) {
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
// fallback for the rare row that carries no `created_at` at all (shouldn't
// happen per the confirmed shape, but this file never assumes a required
// field is actually always present on every real response). No external
// deps - same helper content-elevenlabs-capture.js already has.
function hashString(str) {
  let hash = 0x811c9dc5;
  const text = `${str || ''}`;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16);
}

function sunoArrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  const CHUNK_SIZE = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += CHUNK_SIZE) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK_SIZE));
  }
  return btoa(binary);
}

// ---- On-page live-capture status badge (same pattern as
// content-elevenlabs-capture.js's identical badge) ----

let sunoCaptureStatusHideTimer = null;

function ensureSunoCaptureStatusBadge() {
  const existing = document.getElementById('rmw-suno-capture-status');
  if (existing) return existing;
  const badge = document.createElement('div');
  badge.id = 'rmw-suno-capture-status';
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

function setSunoCaptureStatus(message, { autoHideMs } = {}) {
  const badge = ensureSunoCaptureStatusBadge();
  badge.textContent = `Suno capture\n${message}`;
  badge.style.display = 'block';
  if (sunoCaptureStatusHideTimer) {
    window.clearTimeout(sunoCaptureStatusHideTimer);
    sunoCaptureStatusHideTimer = null;
  }
  if (autoHideMs) {
    sunoCaptureStatusHideTimer = window.setTimeout(() => { badge.style.display = 'none'; }, autoHideMs);
  }
}

function hideSunoCaptureStatus() {
  const badge = document.getElementById('rmw-suno-capture-status');
  if (badge) badge.style.display = 'none';
}

// ---- Row-shape helpers (local copy of content-suno-network.js's
// identity/shape logic - not shared cross-file, matches this codebase's own
// "each capture file is self-contained" convention). Deliberately much
// simpler than content-elevenlabs-capture.js's equivalent: Suno's `id` is
// flat and stable for the clip's whole lifecycle, no nested chat/song
// wrapper split, so no elevenlabsEffectiveRow-style flatten-through-nesting
// is needed at all. ----

function getSunoRowIdentity(row) {
  if (!row || typeof row !== 'object') return '';
  if (row.id === undefined || row.id === null || row.id === '') return '';
  return String(row.id);
}

// Single confirmed field (created_at, ISO-8601) - unlike ElevenLabs' original
// defensive multi-candidate-field guessing, which existed only because that
// shape was never confirmed. Returns the raw string or null.
function getSunoRowRawTimestamp(row) {
  if (!row || typeof row !== 'object') return null;
  if (row.created_at === undefined || row.created_at === null || row.created_at === '') return null;
  return String(row.created_at);
}

function parseSunoTimestampMs(raw) {
  if (raw === undefined || raw === null || raw === '') return null;
  const parsed = Date.parse(raw);
  return Number.isNaN(parsed) ? null : parsed;
}

function looksLikeSunoClipRowLocal(candidate) {
  if (!candidate || typeof candidate !== 'object') return false;
  return Boolean(getSunoRowIdentity(candidate) && getSunoRowRawTimestamp(candidate));
}

function extractSunoClipRowsFromJson(json) {
  if (!json || typeof json !== 'object') return [];
  if (Array.isArray(json)) return json.filter(looksLikeSunoClipRowLocal);
  if (looksLikeSunoClipRowLocal(json)) return [json];
  if (Array.isArray(json.clips)) return json.clips.filter(looksLikeSunoClipRowLocal);
  return [];
}

// audio_url/media_urls are populated even while "status":"streaming" (a live
// streaming endpoint, not a completion signal) - see this file's header
// comment and content-suno-network.js's identical comment. The confirmed
// deterministic readiness signal instead lives in action_config.actions[]:
// the entry with action_type "download_song" carries a `disabled` boolean.
function getSunoDownloadAction(row) {
  const actions = row?.action_config?.actions;
  if (!Array.isArray(actions)) return null;
  return actions.find((action) => action && typeof action === 'object' && action.action_type === 'download_song') || null;
}

function sunoRowIsReadyForDownload(row) {
  const action = getSunoDownloadAction(row);
  // No action_config.actions[] at all, or no download_song entry within it -
  // shape only confirmed for the one real capture this file is built
  // against; treat as NOT ready rather than guess, since a false positive
  // here means proactively fetching a still-encoding/partial stream instead
  // of the finished asset.
  if (!action) return false;
  if (action.disabled !== false) return false;
  // Confirmed real 2026-08-17: a freshly-queued row (status "queued") can
  // show download_song.disabled === false with audio_url === "" (no media
  // at all yet) - action_config's disabled flag alone is NOT sufficient,
  // contrary to this function's original assumption. Requiring a real URL
  // too closes that gap without weakening the disabled check (both must
  // hold), and keeps the re-qualification logic in
  // evaluateSunoRowForLiveCapture honest - a row seen this early no longer
  // gets marked readyForDownload, so it still gets its one extra pass once
  // the URL actually appears.
  return Boolean(getSunoAudioUrl(row));
}

// The best available playable URL on a row - prefers an mp3 entry in
// media_urls (matches the confirmed real shape's content_type field), falls
// back to the first media_urls entry with a url, falls back to the bare
// audio_url. All three are the SAME live-streaming endpoint family
// (audiopipe.suno.ai) per the confirmed capture - readiness is gated
// separately via sunoRowIsReadyForDownload, never inferred from which of
// these happens to be present.
function getSunoAudioUrl(row) {
  if (Array.isArray(row?.media_urls)) {
    const mp3Entry = row.media_urls.find((entry) => entry && typeof entry === 'object' && entry.url && /mp3/i.test(entry.content_type || ''));
    if (mp3Entry) return mp3Entry.url;
    const firstEntry = row.media_urls.find((entry) => entry && typeof entry === 'object' && entry.url);
    if (firstEntry) return firstEntry.url;
  }
  return typeof row?.audio_url === 'string' ? row.audio_url : '';
}

// ----------------------------------------------------------------------------
// Live-capture arm/disarm state machine — mirrors content-elevenlabs-
// capture.js's identical design (rolling quiet-period reset extends the
// window on each qualifying row; a hard max-duration ceiling backstops a
// session that never quiets down).
// ----------------------------------------------------------------------------

const SUNO_ARM_MAX_DURATION_MS = 10 * 60 * 1000;
// 90s (ElevenLabs' value, near-instant TTS/Music audio) was too short for
// Suno specifically - confirmed real 2026-08-18: a queued/submitted row can
// sit unchanged for well over 90s before the page's own next natural feed
// poll observes it as streaming/complete, since only a NEWLY-qualifying
// capture resets this timer (repeated "still not ready" sightings of the
// same row don't count - see evaluateSunoRowForLiveCapture's
// already_captured_this_session gate). A quiet arm was disarming before
// real audio ever showed up, silently falling back on the ~20-minute
// reconciliation walk instead of catching it live. Widened to give a full
// song's typical generation time room to breathe; SUNO_ARM_MAX_DURATION_MS
// above is the real backstop regardless.
const SUNO_ARM_QUIET_PERIOD_MS = 4 * 60 * 1000;
const SUNO_CLOCK_SKEW_SLACK_MS = 60 * 1000;
const SUNO_LAST_LIVE_CAPTURED_AT_KEY = 'rmw_suno_last_live_captured_at';
// Suno's own row shape carries a `batch_index` field, confirming a single
// Create click can produce more than one clip (a batch) - same "don't miss a
// delayed second take" motivation as ElevenLabs' identically-shaped constant
// (see content-elevenlabs-capture.js's own comment), even though the exact
// registration-delay behavior hasn't been separately confirmed for Suno.
// Extended well past the old 80s ceiling (see SUNO_ARM_QUIET_PERIOD_MS's own
// comment for why) - each entry still comfortably beats the quiet-period
// timer it's racing, same margin convention as before.
const SUNO_ACCELERATED_POLL_DELAYS_MS = [4000, 15000, 30000, 60000, 90000, 120000, 180000, 230000];

// { generateIntentId, armedAt, expiresAt, capturedClipIds: Map,
//   taskId, taskName, clientId, clientName } - null when idle.
let sunoActiveGeneration = null;
let sunoArmQuietTimer = null;
let sunoArmMaxTimer = null;
let sunoAcceleratedPollTimers = [];
let sunoLastLiveCapturedAt = 0;

chromeStorageGet([SUNO_LAST_LIVE_CAPTURED_AT_KEY]).then((stored) => {
  sunoLastLiveCapturedAt = Number(stored[SUNO_LAST_LIVE_CAPTURED_AT_KEY] || 0);
});

function persistSunoLastLiveCapturedAt(timestampMs) {
  if (!(timestampMs > sunoLastLiveCapturedAt)) return;
  sunoLastLiveCapturedAt = timestampMs;
  chromeStorageSet({ [SUNO_LAST_LIVE_CAPTURED_AT_KEY]: timestampMs }).catch(() => {});
}

function clearSunoAcceleratedPollTimers() {
  sunoAcceleratedPollTimers.forEach((id) => window.clearTimeout(id));
  sunoAcceleratedPollTimers = [];
}

// Schedules a fresh batch of accelerated polls from NOW - called on every
// arm (fresh or extended), so a second Create click while still armed gets
// its own full set of chances too, not just whatever's left of the first
// click's schedule.
function scheduleSunoAcceleratedPolls() {
  clearSunoAcceleratedPollTimers();
  sunoAcceleratedPollTimers = SUNO_ACCELERATED_POLL_DELAYS_MS.map((delay) => window.setTimeout(() => {
    triggerSunoFeedPoll().catch(() => {});
  }, delay));
}

function clearSunoArmTimers() {
  if (sunoArmQuietTimer) { window.clearTimeout(sunoArmQuietTimer); sunoArmQuietTimer = null; }
  if (sunoArmMaxTimer) { window.clearTimeout(sunoArmMaxTimer); sunoArmMaxTimer = null; }
  clearSunoAcceleratedPollTimers();
}

function sunoGenerationLinkLabel(generation) {
  if (!generation) return '';
  const parts = [];
  if (generation.taskName) parts.push(`Task: ${generation.taskName}`);
  if (generation.clientName) parts.push(`Client: ${generation.clientName}`);
  return parts.length ? ` (${parts.join(', ')})` : '';
}

function disarmSunoGeneration() {
  clearSunoArmTimers();
  const capturedEntries = sunoActiveGeneration ? Array.from(sunoActiveGeneration.capturedClipIds.values()) : [];
  const hadCaptures = capturedEntries.length > 0;
  // Confirmed real 2026-08-18: Suno's queued->submitted->streaming->complete
  // progression routinely outlasts the arm window entirely (unlike TTS/
  // Music, whose audio is usually ready within seconds) - a metadata-only
  // row (readyForDownload: false, from a "queued"/"submitted" snapshot) is
  // very often the only thing captured before disarm fires. Saying "Capture
  // complete" there is actively misleading (reported live, user confused
  // when "Audio Backup Status" still shows Pending) - distinguish the two
  // cases instead of reusing ElevenLabs' unconditional message.
  const hadAudio = capturedEntries.some((entry) => entry && entry.readyForDownload);
  const linkLabel = sunoGenerationLinkLabel(sunoActiveGeneration);
  sunoActiveGeneration = null;
  if (hadAudio) {
    setSunoCaptureStatus(`Capture complete ✓${linkLabel}`, { autoHideMs: 6000 });
  } else if (hadCaptures) {
    setSunoCaptureStatus(`Prompt captured - audio still generating…${linkLabel}`, { autoHideMs: 8000 });
  } else {
    hideSunoCaptureStatus();
  }
}

function scheduleSunoArmQuietReset() {
  if (sunoArmQuietTimer) window.clearTimeout(sunoArmQuietTimer);
  sunoArmQuietTimer = window.setTimeout(disarmSunoGeneration, SUNO_ARM_QUIET_PERIOD_MS);
}

function isSunoGenerationArmed() {
  return Boolean(sunoActiveGeneration) && Date.now() <= sunoActiveGeneration.expiresAt;
}

function armSunoGeneration(target, selection) {
  const now = Date.now();

  if (isSunoGenerationArmed()) {
    // A second Create click while still waiting on a prior one extends the
    // existing session rather than resetting capturedClipIds.
    if (selection) {
      sunoActiveGeneration.taskId = selection.taskId;
      sunoActiveGeneration.taskName = selection.taskName;
      sunoActiveGeneration.clientId = selection.clientId;
      sunoActiveGeneration.clientName = selection.clientName;
    }
    scheduleSunoArmQuietReset();
    scheduleSunoAcceleratedPolls();
    setSunoCaptureStatus(`Waiting for generation…${sunoGenerationLinkLabel(sunoActiveGeneration)}`);
    return;
  }

  clearSunoArmTimers();
  sunoActiveGeneration = {
    generateIntentId: `sunogen_${now}_${Math.random().toString(36).slice(2, 8)}`,
    armedAt: now,
    expiresAt: now + SUNO_ARM_MAX_DURATION_MS,
    capturedClipIds: new Map(),
    taskId: selection?.taskId ?? null,
    taskName: selection?.taskName ?? null,
    clientId: selection?.clientId ?? null,
    clientName: selection?.clientName ?? null,
  };
  sunoArmMaxTimer = window.setTimeout(disarmSunoGeneration, SUNO_ARM_MAX_DURATION_MS);
  scheduleSunoArmQuietReset();
  setSunoCaptureStatus(`Waiting for generation…${sunoGenerationLinkLabel(sunoActiveGeneration)}`);
  console.debug('[RMW Suno Capture] armed', {
    generateIntentId: sunoActiveGeneration.generateIntentId,
    taskId: sunoActiveGeneration.taskId,
    clientId: sunoActiveGeneration.clientId,
  });

  // A batch of accelerated polls (see SUNO_ACCELERATED_POLL_DELAYS_MS's own
  // comment) so live capture doesn't wait for the next scheduled
  // reconciliation walk (up to SUNO_RECONCILIATION_MIN_GAP_MS away otherwise)
  // to catch a take Suno is slow to register.
  scheduleSunoAcceleratedPolls();
}

// ---- "Create" button click-gate — CONFIRMED real DOM (2026-08-17, via
// DevTools Inspect):
//   <button type="button" aria-label="Create song" id="base-ui-_r_dj_"
//           class="hxc-btn-base hxc-btn-variant-aura ...">
//     <span class="hxc-btn-content"><svg>...</svg>Create</span>
//   </button>
// A real <BUTTON> with a stable, precise aria-label ("Create song", not
// just "Create") - distinct from the sidebar's plain "Create" nav link,
// which per Suno's Base UI component conventions (the "hxc-btn-base"/
// "base-ui-_r_xx_" class/id prefixes seen here are that library's own
// generated names) is almost certainly an <a>, not a <button>, and
// wouldn't carry this exact aria-label either way. Matches primarily on
// aria-label containing "create song"; the broader own-text-mentions-
// "create" and nearby-credit-text checks are kept as a fallback in case
// Suno ever changes the aria-label wording (same defensive posture as
// every other click-gate in this codebase). ----

function sunoButtonDescriptorText(element) {
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

function sunoNearbyTextMentionsCredit(candidate) {
  const neighbors = [candidate.previousElementSibling, candidate.nextElementSibling, candidate.parentElement].filter(Boolean);
  return neighbors.some((el) => {
    const own = el.getAttribute?.('aria-label') || el.getAttribute?.('title') || '';
    const nested = el.textContent || '';
    return /\bcredit/i.test(`${own} ${nested}`.slice(0, 200));
  });
}

function looksLikeSunoCreateButton(candidate) {
  if (!candidate || candidate.tagName !== 'BUTTON') return false;
  const ariaLabel = `${candidate.getAttribute?.('aria-label') || ''}`.toLowerCase();
  if (ariaLabel.includes('create song')) return true;
  const text = sunoButtonDescriptorText(candidate);
  const hasCreateText = /\bcreate\b/i.test(text) && text.length <= 80;
  if (hasCreateText) return true;
  return sunoNearbyTextMentionsCredit(candidate);
}

function findSunoCreateButtonAncestor(element) {
  let current = element;
  while (current && current !== document.body) {
    if (
      !SUNO_GATE_EXCLUDED_TAGS.has(current.tagName)
      && current.matches?.(SUNO_ACTION_SELECTORS.join(','))
      && sunoIsVisible(current)
      && !sunoIsDisabled(current)
    ) {
      return current;
    }
    current = current.parentElement;
  }
  return null;
}

function collectSunoInteractionCandidateElements(target) {
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
  return sunoCollectUniqueElements([...pathElements, ...fallback]);
}

function findSunoCreateActionTarget(target) {
  const candidates = sunoCollectUniqueElements(
    collectSunoInteractionCandidateElements(target).map((element) => findSunoCreateButtonAncestor(element))
  );
  for (const candidate of candidates) {
    if (!candidate) continue;
    if (looksLikeSunoCreateButton(candidate)) return candidate;
  }
  return null;
}

// ---- Task/Client Mapping gate for Create — same block/re-dispatch-
// synthetic-click bypass-flag technique as content-elevenlabs-capture.js's
// runElevenlabsTaskGate. ----

let sunoTaskGateBypassTarget = null;
let sunoTaskGateModalOpen = false;
let sunoPendingTaskSelection = null; // consumed by armSunoGeneration() on the bypass (re-dispatched) click

async function runSunoTaskGate(target) {
  if (sunoTaskGateModalOpen) return; // double-click Create while the modal is already open - no-op
  sunoTaskGateModalOpen = true;
  try {
    const selection = await openSunoTaskSelectionModal();
    if (!selection) return; // cancelled/ESC/no active tasks - click stays blocked, generation is blocked
    sunoPendingTaskSelection = selection;
    sunoTaskGateBypassTarget = target;
    target.click();
  } finally {
    sunoTaskGateModalOpen = false;
  }
}

document.addEventListener('click', (event) => {
  try {
    const target = findSunoCreateActionTarget(event.target);
    if (!target) return;

    if (sunoTaskGateBypassTarget === target) {
      sunoTaskGateBypassTarget = null; // one-shot: next Create click gates again
      const selection = sunoPendingTaskSelection;
      sunoPendingTaskSelection = null;
      armSunoGeneration(target, selection);
      return; // let the (re-dispatched) click reach Suno's own handler
    }

    event.preventDefault();
    event.stopImmediatePropagation();
    runSunoTaskGate(target);
  } catch {}
}, true); // capturing phase - fires even if the page's own handler stops propagation

// ---- Row qualification + reporting ----

function evaluateSunoRowForLiveCapture(row) {
  const identityValue = getSunoRowIdentity(row);
  if (!identityValue) return { qualifies: false, reason: 'no_identity' };
  if (!isSunoGenerationArmed()) return { qualifies: false, reason: 'not_armed' };

  const readyForDownload = sunoRowIsReadyForDownload(row);
  const previousCapture = sunoActiveGeneration.capturedClipIds.get(identityValue);
  // Once-per-identity-per-arm for everything EXCEPT a row whose first-ever
  // capture happened before download_song.disabled flipped to false - that
  // one gets exactly one more pass once it does, so proactivelyFetchSunoAudio
  // actually gets to run against a ready row instead of being permanently
  // starved by this same gate. Ported from ElevenLabs Music's identical
  // isNewlyResolvedMusicAsset fix (see content-elevenlabs-capture.js's
  // evaluateElevenlabsRowForLiveCapture) rather than reintroduced after the
  // fact - Suno's audio_url/media_urls are populated well before the asset
  // is actually ready (see this file's header "live streaming endpoint, not
  // a completion signal" comment), so this file would hit the exact same bug
  // on day one without it.
  const isNewlyResolvedDownload = Boolean(previousCapture && !previousCapture.readyForDownload && readyForDownload);
  if (previousCapture && !isNewlyResolvedDownload) {
    return { qualifies: false, reason: 'already_captured_this_session' };
  }

  const rawTimestamp = getSunoRowRawTimestamp(row);
  if (!rawTimestamp) {
    // Shouldn't happen per the confirmed shape (created_at is one of the two
    // required identity fields - see looksLikeSunoClipRowLocal), but this
    // file never assumes a field is actually present on every real
    // response - allow it while armed rather than silently drop it.
    console.debug('[RMW Suno Capture] row has no created_at - allowing while armed, timestamp qualification skipped', { identityValue });
    return { qualifies: true, identityValue, timestampMs: null, readyForDownload };
  }

  const timestampMs = parseSunoTimestampMs(rawTimestamp);
  if (timestampMs === null) {
    console.debug('[RMW Suno Capture] created_at present but unparsable - allowing while armed, timestamp qualification skipped', { identityValue, raw: rawTimestamp });
    return { qualifies: true, identityValue, timestampMs: null, readyForDownload };
  }

  // The freshness checks below reject a STALE row from before this
  // generation started - skipped for a newly-resolved download, since
  // created_at never changes between the not-yet-ready and ready snapshots
  // (only action_config.actions[].disabled does), so it would otherwise get
  // wrongly rejected as "not newer than watermark".
  if (!isNewlyResolvedDownload) {
    if (timestampMs < sunoActiveGeneration.armedAt - SUNO_CLOCK_SKEW_SLACK_MS) {
      return { qualifies: false, reason: 'older_than_arm' };
    }
    if (sunoLastLiveCapturedAt && timestampMs <= sunoLastLiveCapturedAt - SUNO_CLOCK_SKEW_SLACK_MS) {
      return { qualifies: false, reason: 'not_newer_than_watermark' };
    }
  }
  return { qualifies: true, identityValue, timestampMs, readyForDownload };
}

// Every qualifying row snapshot is captured immediately - client_event_id's
// changeToken (see reportSunoClipRow below) naturally re-captures a later,
// more-complete snapshot of the same identity without duplicating, once one
// is observed. A re-submission with the SAME created_at (e.g. the
// newly-resolved-download re-pass above) may land as a harmless backend
// duplicate of the metadata event - the actual asset delivery for that pass
// happens through the separate, identity-keyed audio push below, which is
// unaffected by the metadata event being a duplicate.
async function reportSunoClipRow(row, { isReconciliation }) {
  const identityValue = getSunoRowIdentity(row);
  if (!identityValue) return;

  const rawTimestamp = getSunoRowRawTimestamp(row);
  const changeToken = rawTimestamp || hashString(JSON.stringify(row));
  const clientEventId = `suno:${identityValue}:${changeToken}`;

  try {
    const result = await sunoSendRuntimeMessage({
      type: 'SUNO_CAPTURE_EVENT',
      event: {
        // Must match backend/providers/suno/constants.py's EVENT_TYPE_CLIP
        // exactly ("clip", not "feed_clip") - a mismatch here means
        // ingest_capture_event rejects every single event with "unknown
        // event_type", silently draining the local outbox queue without
        // ever creating a row (confirmed real bug, 2026-08-17: found via
        // an empty chrome.storage.local queue + zero DB rows).
        event_type: 'clip',
        client_event_id: clientEventId,
        creation_id: identityValue || null,
        family_id: null,
        is_reconciliation: Boolean(isReconciliation),
        payload: row,
        capture_version: 1,
        linked_task_id: (!isReconciliation && sunoActiveGeneration) ? sunoActiveGeneration.taskId : null,
        linked_client_id: (!isReconciliation && sunoActiveGeneration) ? sunoActiveGeneration.clientId : null,
      },
    });
    if (result?.ok) {
      console.debug('[RMW Suno Capture] reported clip row', { identityValue, isReconciliation, queued: result.queued });
      if (!isReconciliation) setSunoCaptureStatus('Queued for upload…');
    } else {
      console.warn('[RMW Suno Capture] failed to report clip row', { identityValue, isReconciliation, error: result?.error });
      if (!isReconciliation) setSunoCaptureStatus(`Capture failed: ${result?.error || 'unknown error'}`, { autoHideMs: 8000 });
    }
  } catch (error) {
    console.warn('[RMW Suno Capture] unexpected error reporting clip row', { identityValue, error: error?.message || error });
  }
}

function processSunoIncomingRow(row) {
  const evaluation = evaluateSunoRowForLiveCapture(row);
  if (!evaluation.qualifies) {
    console.debug('[RMW Suno Capture] ignored non-qualifying row (not a live generation)', {
      identity: getSunoRowIdentity(row), reason: evaluation.reason,
    });
    return;
  }
  sunoActiveGeneration.capturedClipIds.set(evaluation.identityValue, { readyForDownload: Boolean(evaluation.readyForDownload) });
  scheduleSunoArmQuietReset(); // this counts as recent activity - extend the window
  if (evaluation.timestampMs) persistSunoLastLiveCapturedAt(evaluation.timestampMs);
  setSunoCaptureStatus('Capturing…');
  console.debug('[RMW Suno Capture] qualifying row - reporting as live', { identity: evaluation.identityValue });
  reportSunoClipRow(row, { isReconciliation: false });

  // Deterministic, no dependency on any Play/Download click ever happening -
  // the row already carries its own asset URL once download_song.disabled
  // is false, so there's nothing to correlate, unlike ElevenLabs. Fire-and-
  // forget: reportSunoAudioCapture's own dedupe means this can safely run
  // even if the reconciliation walker also finds and fetches the same row.
  if (evaluation.readyForDownload) {
    proactivelyFetchSunoAudio(row);
  }
}

// ---- Relay for content-suno-network.js's (MAIN world) intercepted
// `/api/feed/v3` responses ----

function onSunoNetworkMessage(event) {
  if (event.source !== window) return;
  const data = event.data;
  if (!data || data.source !== 'rmw-suno-network-telemetry') return;

  if (data.type === 'SUNO_NETWORK_GENERATION') {
    const rows = data.payload && Array.isArray(data.payload.rows) ? data.payload.rows : [];
    rows.forEach((row) => processSunoIncomingRow(row));
    return;
  }

  if (data.type === 'SUNO_NETWORK_AUTH_TOKEN') {
    sunoCachedAuth = {
      apiHost: data.payload?.apiHost,
      authorization: data.payload?.authorization,
      browserToken: data.payload?.browserToken,
      deviceId: data.payload?.deviceId,
    };
  }
}

window.addEventListener('message', onSunoNetworkMessage);

// Populated from content-suno-network.js's SUNO_NETWORK_AUTH_TOKEN relay -
// see that file's "AUTH TOKEN RELAY" comment. null until the MAIN-world
// interceptor observes the page's own first real API call.
let sunoCachedAuth = null; // {apiHost, authorization, browserToken, deviceId} | null

function sunoApiUrl(path) {
  const host = sunoCachedAuth?.apiHost || 'studio-api-prod.suno.com'; // the one confirmed host - overridden the moment a real one is observed (defensive only, never expected to differ)
  return `https://${host}${path}`;
}

function sunoApiHeaders(extra = {}) {
  const headers = { ...extra };
  if (sunoCachedAuth?.authorization) headers.Authorization = sunoCachedAuth.authorization;
  // browser-token/device-id: relayed alongside Authorization because the
  // real captured request carried them too, and it's unconfirmed whether
  // this walker's own re-issued request is accepted without them - see
  // content-suno-network.js's "AUTH TOKEN RELAY" comment.
  if (sunoCachedAuth?.browserToken) headers['browser-token'] = sunoCachedAuth.browserToken;
  if (sunoCachedAuth?.deviceId) headers['device-id'] = sunoCachedAuth.deviceId;
  return headers;
}

// ---- Proactive audio fetch (deterministic - the row already carries its
// own asset URL once ready, no separate lookup-by-id call needed, no
// Play/Download-click correlation needed either - see this file's header) ----

async function proactivelyFetchSunoAudio(row) {
  const identityValue = getSunoRowIdentity(row);
  const audioUrl = getSunoAudioUrl(row);
  if (!identityValue || !audioUrl) return;
  try {
    // No Authorization header, no credentials - the audiopipe.suno.ai URL
    // embedded in the row is treated the same way ElevenLabs Music's signed
    // download_url is (see proactivelyFetchElevenlabsMusicAudio in
    // content-elevenlabs-capture.js): fetched plain. UNCONFIRMED whether
    // this endpoint actually requires no auth at all vs. being tied to the
    // browser's session some other way (e.g. a short-lived query param
    // already baked into the URL) - logged clearly on failure either way.
    const response = await fetch(audioUrl);
    if (!response.ok) {
      const errorBody = await response.text().catch(() => '');
      console.debug('[RMW Suno Capture] proactive audio fetch failed', {
        identityValue, status: response.status, errorBody: errorBody.slice(0, 1000),
      });
      return;
    }
    const contentType = response.headers.get('content-type') || 'audio/mpeg';
    const buffer = await response.arrayBuffer();
    if (!buffer || !buffer.byteLength) return;
    const audioBase64 = sunoArrayBufferToBase64(buffer);
    console.debug('[RMW Suno Capture] proactively fetched audio', { identityValue, contentType, bytes: buffer.byteLength });
    reportSunoAudioCapture({ clipId: identityValue, contentType, audioBase64 });
  } catch (error) {
    console.debug('[RMW Suno Capture] proactive audio fetch error', { identityValue, error: error?.message || error });
  }
}

// Pushes an observed audio response's actual bytes to the backend, keyed by
// clipId - mirrors content-elevenlabs-capture.js's reportElevenlabsAudioCapture,
// simplified: Suno has no separate Play/Download-click signal here (see this
// file's header - the asset URL is already embedded in the row, so there's
// nothing to correlate), so every push is a proactive fetch, never a
// confirmed user download.
const sunoRecentlyPushedAudioIds = new Map(); // clipId -> pushedAt (only on a CONFIRMED outcome - see below)
const SUNO_AUDIO_PUSH_DEDUPE_MS = 60000; // avoid re-uploading the exact same clip within a short window
// Same race the ElevenLabs equivalent's incident writeup documents: audio
// can be fetched and pushed before the row's own metadata event has reached
// the backend and been normalized into a SunoGeneration row. The backend's
// /capture/audio is expected to reply status:"generation_not_found" in that
// case rather than error - only a CONFIRMED outcome (success, or a
// non-transient failure) locks out further attempts; generation_not_found
// retries a few times with a short delay instead, since the underlying row
// reliably lands within a few seconds. Ported from day one rather than
// reintroduced after the fact - see reportElevenlabsAudioCapture's own
// comment for the original incident this pattern fixes.
const SUNO_AUDIO_PUSH_MAX_ATTEMPTS = 4;
const SUNO_AUDIO_PUSH_RETRY_DELAY_MS = 4000; // linear backoff: 4s, 8s, 12s

async function reportSunoAudioCapture(payload, attempt = 1) {
  const clipId = `${payload?.clipId || ''}`.trim();
  const audioBase64 = payload?.audioBase64;
  if (!clipId || !audioBase64) return;

  if (attempt === 1) {
    const now = Date.now();
    const last = sunoRecentlyPushedAudioIds.get(clipId);
    if (last && now - last < SUNO_AUDIO_PUSH_DEDUPE_MS) return;
  }

  try {
    const result = await sunoSendRuntimeMessage({
      type: 'SUNO_CAPTURE_AUDIO',
      clipId,
      contentType: payload.contentType || 'audio/mpeg',
      audioBase64,
    });
    if (result?.ok) {
      sunoRecentlyPushedAudioIds.set(clipId, Date.now());
      console.debug('[RMW Suno Capture] pushed audio asset', { clipId, status: result.status, attempt });
      return;
    }
    if (result?.status === 'generation_not_found' && attempt < SUNO_AUDIO_PUSH_MAX_ATTEMPTS) {
      const delay = SUNO_AUDIO_PUSH_RETRY_DELAY_MS * attempt;
      console.debug('[RMW Suno Capture] audio arrived before its generation row - retrying shortly', { clipId, attempt, delay });
      window.setTimeout(() => reportSunoAudioCapture(payload, attempt + 1), delay);
      return;
    }
    if (result?.status !== 'generation_not_found') {
      sunoRecentlyPushedAudioIds.set(clipId, Date.now());
    }
    console.warn('[RMW Suno Capture] failed to push audio asset', { clipId, error: result?.error, status: result?.status, attempt });
  } catch (error) {
    sunoRecentlyPushedAudioIds.set(clipId, Date.now());
    console.warn('[RMW Suno Capture] unexpected error pushing audio asset', { clipId, error: error?.message || error });
  }
}

// ----------------------------------------------------------------------------
// Reconciliation walker — POSTs /api/feed/v3 directly. Confirmed RESPONSE
// shape (see this file's header); the outgoing REQUEST BODY has never been
// captured, only the response was - so this tries a minimal/empty JSON body
// first and logs clearly (status + response body text) on failure, the same
// "log the real error for next time" convention proactivelyFetchSunoAudio
// and every other not-yet-fully-confirmed piece in this extension uses.
// Deliberately NOT attempting cursor-based pagination past page 1 (has_more's
// accompanying cursor param is entirely unconfirmed) - single-page-per-walk
// is a real, useful signal on its own (this is the SAME endpoint the page's
// own feed view calls, so page 1 always carries the newest clips first), and
// guessing at a wrong cursor shape risks silently walking the wrong data
// forever instead of just not paginating.
// ----------------------------------------------------------------------------

const SUNO_SYNC_STORAGE_KEY = 'rmw_suno_sync_state';
const SUNO_RECONCILIATION_MIN_GAP_MS = 20 * 60 * 1000; // one full walk per tab per ~20 min, matches ElevenLabs'/Envato's cadence

async function getSunoSyncState() {
  const stored = await chromeStorageGet([SUNO_SYNC_STORAGE_KEY]);
  return stored[SUNO_SYNC_STORAGE_KEY] || {};
}

async function patchSunoSyncState(patch) {
  const current = await getSunoSyncState();
  const next = { ...current, ...patch };
  await chromeStorageSet({ [SUNO_SYNC_STORAGE_KEY]: next });
  return next;
}

async function fetchSunoFeedPage(body) {
  try {
    // credentials deliberately OMITTED, same reasoning as
    // content-elevenlabs-capture.js's identical comment: if the real API's
    // CORS response uses a wildcard Access-Control-Allow-Origin (unconfirmed
    // for Suno specifically, but the same architecture ElevenLabs/Music
    // use), a credentialed request would be refused regardless of the auth
    // headers, which are the actual (and hopefully sufficient) auth
    // mechanism here.
    const response = await fetch(sunoApiUrl('/api/feed/v3'), {
      method: 'POST',
      headers: sunoApiHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(body || {}),
    });
    if (!response.ok) {
      const errorBody = await response.text().catch(() => '');
      console.warn('[RMW Suno Sync] feed fetch failed', {
        status: response.status, hadAuthToken: Boolean(sunoCachedAuth), errorBody: errorBody.slice(0, 1000),
      });
      return null;
    }
    return await response.json().catch(() => null);
  } catch (error) {
    console.warn('[RMW Suno Sync] feed fetch error', { error: error?.message || error });
    return null;
  }
}

// Stops once a row matching the previous walk's lastSeenId is reached
// (nothing new since last time) - same "stop at the last known row" pattern
// content-elevenlabs-capture.js's Music walker uses, appropriate here since
// /api/feed/v3's rows are the page's own feed view, newest-first.
async function walkSunoReconciliation() {
  const state = await getSunoSyncState();
  const now = Date.now();
  if (state.lastWalkAt && now - state.lastWalkAt < SUNO_RECONCILIATION_MIN_GAP_MS) {
    console.debug('[RMW Suno Sync] walk skipped: ran too recently', { lastWalkAt: state.lastWalkAt });
    return;
  }

  console.debug('[RMW Suno Sync] starting reconciliation walk');
  await patchSunoSyncState({ lastWalkAt: now });

  const lastSeenId = state.lastSeenId || null;
  const json = await fetchSunoFeedPage({});
  if (!json) return;

  const rows = extractSunoClipRowsFromJson(json);
  if (!rows.length) {
    console.debug('[RMW Suno Sync] walk returned no recognizable rows');
    return;
  }

  let newestSeenThisWalk = null;
  for (const row of rows) {
    const id = getSunoRowIdentity(row);
    if (id && lastSeenId && id === lastSeenId) break; // reached a row already seen last walk - nothing new past this point
    await reportSunoClipRow(row, { isReconciliation: true });
    if (sunoRowIsReadyForDownload(row)) proactivelyFetchSunoAudio(row);
    if (!newestSeenThisWalk && id) newestSeenThisWalk = id;
  }

  if (json.has_more) {
    console.debug('[RMW Suno Sync] feed response indicates more pages exist - pagination not attempted this walk (request cursor shape unconfirmed, see this file\'s header)');
  }

  await patchSunoSyncState({ lastSeenId: newestSeenThisWalk || lastSeenId });
  console.debug('[RMW Suno Sync] walk finished', { lastSeenId: newestSeenThisWalk || lastSeenId });
}

// Accelerated one-off poll fired after arming (see armSunoGeneration) so
// live capture doesn't wait for the next scheduled walk. Deliberately does
// NOT touch the reconciliation cursor (unlike walkSunoReconciliation) and
// reports through the same live-capture (isReconciliation:false) path as
// content-suno-network.js's relay - this is meant to catch the just-armed
// generation quickly, not backfill history.
async function triggerSunoFeedPoll() {
  if (!isSunoGenerationArmed()) return;
  try {
    const json = await fetchSunoFeedPage({});
    if (!json) return;
    const rows = extractSunoClipRowsFromJson(json);
    rows.forEach((row) => processSunoIncomingRow(row));
  } catch (error) {
    console.warn('[RMW Suno Capture] accelerated post-arm poll failed', { error: error?.message || error });
  }
}

// ---- Boot: register listeners immediately (passive), start the
// reconciliation walker on its own timer. Nothing here needs to wait for any
// particular readiness state. ----

window.setTimeout(() => {
  walkSunoReconciliation().catch(() => {});
}, 6000);

window.setInterval(() => {
  walkSunoReconciliation().catch(() => {});
}, SUNO_RECONCILIATION_MIN_GAP_MS);
