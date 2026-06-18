// ============================================================
// Kling AI Auto-Login Content Script — v3 Final
// Fixes: syntax error, landing lock reset, chooser guard,
//        session clear once, credential cache, redirect loops,
//        observer drain, double-delay click, speed tuning
// ============================================================

const TOOL_SLUG               = 'kling-ai';
const LOGIN_URL               = 'https://kling.ai/app';
const EXTENSION_TICKET_KEY    = 'rmw_extension_ticket';
const USAGE_TICKET_KEY        = 'rmw_kling_usage_ticket';
const PREPARED_LAUNCH_KEY     = 'rmw_kling_prepared_launch';
const BLOCKED_NOTICE_KEY      = 'rmw_kling_blocked_notice';
const SESSION_CHECKPOINT_KEY  = 'rmw_kling_checkpoint';
const GOOGLE_POPUP_ALLOW_RELOAD_KEY = 'rmw_kling_google_popup_allow_reload';
const USAGE_BROWSER_SESSION_KEY = 'rmw_kling_usage_browser_session';
const USAGE_TAB_SESSION_KEY = 'rmw_kling_usage_tab_session';
const USAGE_BROADCAST_CHANNEL = 'rmw-kling-usage';

// ── Timing constants ──────────────────────────────────────────
const KEEP_ALIVE_MS          = 10000;
const MUTATION_DEBOUNCE_MS   = 200;    // was 250
const SUBMIT_LOCK_MS         = 12000;
const POST_LOGIN_GRACE_MS    = 7000;   // was 10000
const AUTH_TRANSITION_TIMEOUT_MS = 45000;
const AUTH_TRANSITION_INITIAL_QUIET_MS = 3000;
const AUTH_TRANSITION_POLL_MS = 2000;
const MAX_KLING_GOOGLE_ERROR_RETRIES = 3;
const KLING_GOOGLE_ERROR_RETRY_COOLDOWN_MS = 2500;
const EMAIL_STEP_GRACE_MS    = 5000;   // was 3500
const MIN_RUN_GAP_MS         = 150;    // was 200
const LAUNCH_RETRY_DELAY_MS  = 8000;
const MAX_LAUNCH_RETRIES     = 2;
const FIELD_FILL_DELAY_MS    = 60;     // was 80
const TYPED_FILL_CHAR_DELAY_MS = 0;
const EMAIL_SUBMIT_DELAY_MS  = 180;
const PASSWORD_SUBMIT_DELAY_MS = 180;
const PASSWORD_FIELD_SETTLE_MS = 320;
const PASSWORD_FIELD_SETTLE_CHECK_MS = 80;
const LANDING_CLICK_DELAY_MS = 0;      // was 60 — removed double-delay wrapper
const LANDING_RETRY_DELAY_MS = 500;    // was 1200
const EMAIL_CHOOSER_WAIT_MS  = 600;    // was 1500
const CHECKPOINT_RESUME_MS   = 400;    // was 1200
const POST_SUBMIT_WAIT_MS    = 300;    // was 700
const USAGE_REPORT_POLL_MS   = 1200;
const USAGE_REPORT_MAX_WAIT_MS = 30000;
const MAX_REASONABLE_KLING_CREDIT_BURN = 3000;
const MAX_REASONABLE_KLING_CREDIT_BALANCE = 1000000;
const MAX_PROMPT_CAPTURE_LENGTH = 4000;
const MAX_PROMPT_CANDIDATES = 3;
const MAX_CAPTURED_MEDIA_ASSETS = 8;
const MAX_MEDIASOURCE_CAPTURED_ASSETS = 8;
const MAX_PENDING_MEDIASOURCE_PAYLOADS = 4;
const PENDING_MEDIASOURCE_MAX_MS = 30000;
const GENERATED_ASSET_SCAN_MS = 4000;
const GENERATED_ASSET_SCAN_MAX_MS = 150000;
const ACTIVE_GENERATION_MAX_MS = GENERATED_ASSET_SCAN_MAX_MS;
const MAX_EXPECTED_LOCK_AUTO_BURN = 300;
const SUPPORTED_KLING_USAGE_FALLBACK_MODES = new Set(['image', 'video', 'motion-control', 'avatar']);
const CREDIT_SOURCE_PROFILES = {
  trade: { source: 'trade_history_reconciled', priority: 90, confidence: 0.9 },
  wallet: { source: 'wallet_reconciled', priority: 100, confidence: 1 },
  dom: { source: 'dom_balance_fallback', priority: 80, confidence: 0.8 },
  expected: { source: 'expected_credit_lock', priority: 60, confidence: 0.6 },
};
const BADGE_HIDE_DONE_MS     = 4000;
const BADGE_HIDE_BLOCKED_MS  = 12000;

const AUTHENTICATED_APP_LABELS = [
  'explore', 'assets', 'generate', 'canvas', 'all tools', 'api', 'omni',
];

const P = {
  BOOT         : 'boot',
  AUTHORIZE    : 'authorize',
  LOAD_CRED    : 'loadCredential',
  OPEN_LANDING : 'openLanding',
  FILL         : 'fill',
  SUBMIT       : 'submit',
  WAIT_GOOGLE  : 'waitGoogle',
  WAIT_REDIRECT: 'waitRedirect',
  DONE         : 'done',
  BLOCKED      : 'blocked',
};

const ACTION_SELECTORS = [
  'button',
  'input[type="button"]',
  'input[type="submit"]',
  'a[href]',
  '[role="button"]',
];

const EMAIL_SELS = [
  'input[type="email"]',
  'input[name="email"]',
  'input[name*="email" i]',
  'input[id*="email" i]',
  'input[placeholder*="email" i]',
  'input[aria-label*="email" i]',
  'input[autocomplete="username"]',
  'input[autocomplete="email"]',
];

const PASS_SELS = [
  'input[type="password"]',
  'input[name="password"]',
  'input[name*="password" i]',
  'input[id*="password" i]',
  'input[placeholder*="password" i]',
  'input[aria-label*="password" i]',
  'input[autocomplete="current-password"]',
];

const PASSWORD_REVEAL_ACTION_HINTS = ['show', 'hide', 'view', 'reveal', 'toggle'];
const PASSWORD_REVEAL_SUBJECT_HINTS = ['password', 'passcode'];
const PASSWORD_REVEAL_ICON_HINTS = ['eye', 'visibility', 'visible'];
const PASSWORD_GUARD_STYLE_ID = 'rmw-kling-password-guard-style';

// ── Checkpoint: survives same-origin reload, cleared on done/fail ──
function writeCheckpoint(phase, extra = {}) {
  try {
    sessionStorage.setItem(SESSION_CHECKPOINT_KEY, JSON.stringify({
      phase, ts: Date.now(), ...extra,
    }));
  } catch {}
}

function readCheckpoint() {
  try {
    const raw = sessionStorage.getItem(SESSION_CHECKPOINT_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw);
    if (Date.now() - data.ts > 45000) { clearCheckpoint(); return null; }
    return data;
  } catch { return null; }
}

function clearCheckpoint() {
  try { sessionStorage.removeItem(SESSION_CHECKPOINT_KEY); } catch {}
}
function hasSignedInToast() {
  const text = `${document.body?.innerText || ''}`.toLowerCase();
  return text.includes('you have signed in');
}
// ── CTX ───────────────────────────────────────────────────────
const CTX = {
  phase                : P.BOOT,
  busy                 : false,
  stopped              : false,
  timer                : null,
  keepAlive            : null,
  observer             : null,
  credential           : null,
  badgeHideTimer       : null,
  submitLockUntil      : 0,
  submitAt             : 0,
  submitKind           : '',
  lastSubmitActionKey  : '',
  submitActionLockUntil: 0,
  passwordSubmitGuardKey: '',
  passwordSubmitGuardUntil: 0,
  manualGoogleHandoff  : false,
  googleErrorRetryCount: 0,
  googleErrorLastRetryAt: 0,
  lastGoogleOauthRecoveryUrl: '',
  lastGoogleOauthRecoveryAt: 0,
  googlePopupAllowRequestedAt: 0,
  googlePopupAllowAppliedAt: 0,
  googlePopupAllowFailedAt: 0,
  launchRetries        : 0,
  lastRunAt            : 0,
  lastMutationAt       : 0,
  ticket               : '',
  authorized           : false,
  prepared             : false,
  expiresAt            : 0,
  authTransitionAt     : 0,
  authTransitionActive : false,
  lastLandingActionKey : '',
  landingActionLockUntil: 0,
  sessionClearDone     : false,  // FIX: guard against repeated session clearing
  blockedRevealControl : null,
  lastStatusMessage    : '',
};

const USAGE_CTX = {
  listenerAttached    : false,
  debugReadyShown     : false,
  lastInteractionAt   : 0,
  lastInteractionType : '',
  lastGenerateKey     : '',
  lastGenerateIntentId: '',
  lastGenerateAt      : 0,
  pendingReportTimer  : null,
  pendingReportTimers : new Set(),
  networkListenerAttached: false,
  networkEventKeys    : new Map(),
  domSettlementKeys   : new Map(),
  browserSessionId    : '',
  tabSessionId        : '',
  extensionTabId      : 0,
  broadcastChannel    : null,
  latestWalletBalance : null,
  generatedAssetUrls  : new Set(),
  blobSourceUrls      : new Map(),
  mediaSourceAssets   : new Map(),
  assetScanTimer      : null,
  assetScanObserver   : null,
  assetScanStartedAt  : 0,
  assetScanSnapshot   : null,
  activeGenerationIds : new Map(),
  activeGeneration    : null,
  pendingMediaSourcePayloads: [],
};

function normalizeLoginMethod(value) {
  return `${value || ''}`.trim().toLowerCase() || 'email_password';
}

function isGoogleCredential() {
  return normalizeLoginMethod(CTX.credential?.loginMethod) === 'google';
}

// ── Status badge ──────────────────────────────────────────────
function ensureBadge() {
  let el = document.getElementById('rmw-kling-badge');
  if (el) return el;
  el = document.createElement('div');
  el.id = 'rmw-kling-badge';
  Object.assign(el.style, {
    position: 'fixed', top: '10px', right: '10px', zIndex: '2147483647',
    maxWidth: '300px', padding: '8px 12px', borderRadius: '8px',
    background: 'rgba(10,15,30,0.90)', color: '#f0f4ff',
    font: '12px/1.5 system-ui,sans-serif',
    boxShadow: '0 4px 16px rgba(0,0,0,0.4)',
    pointerEvents: 'none', whiteSpace: 'pre-wrap',
  });
  (document.body || document.documentElement).appendChild(el);
  return el;
}

function hideBadge() {
  const badge = document.getElementById('rmw-kling-badge');
  if (badge) {
    badge.remove();
  }
}

function clearBadgeHideTimer() {
  if (CTX.badgeHideTimer) {
    clearTimeout(CTX.badgeHideTimer);
    CTX.badgeHideTimer = null;
  }
}

function scheduleBadgeHide(delayMs = 0) {
  clearBadgeHideTimer();
  if (!delayMs || delayMs <= 0) return;
  CTX.badgeHideTimer = window.setTimeout(() => {
    CTX.badgeHideTimer = null;
    hideBadge();
  }, delayMs);
}

function setStatus(message, options = {}) {
  const normalizedMessage = `${message || ''}`;
  const isSameMessage = CTX.lastStatusMessage === normalizedMessage;
  CTX.lastStatusMessage = normalizedMessage;
  console.debug('[RMW Kling]', message);
  const badge = ensureBadge();
  if (badge) badge.textContent = `Kling Auto-Login\n${message}`;
  if (options.hideAfterMs) {
    if (!(options.preserveExistingHideTimer && isSameMessage && CTX.badgeHideTimer)) {
      scheduleBadgeHide(options.hideAfterMs);
    }
  } else if (!options.preserveExistingHideTimer) {
    clearBadgeHideTimer();
  }
}

function formatResolvedCredentialLabel(credential) {
  const credentialId = Number(credential?.id || 0);
  return credentialId > 0 ? `Credential #${credentialId}` : 'credential';
}

function buildSignedInStatusMessage() {
  const credentialId = Number(CTX.credential?.id || 0);
  return credentialId > 0
    ? `✓ Signed in successfully (${formatResolvedCredentialLabel(CTX.credential)})`
    : '✓ Signed in successfully';
}

function isExtensionContextInvalidatedError(value) {
  const message = `${value || ''}`.trim().toLowerCase();
  return message.includes('extension context invalidated');
}

function buildExtensionContextInvalidatedError(message = 'Extension context invalidated.') {
  const error = new Error(message);
  error.contextInvalidated = true;
  return error;
}

function hasRecentAuthTransition(maxAgeMs = AUTH_TRANSITION_TIMEOUT_MS) {
  return Number(CTX.authTransitionAt || 0) > 0
    && (Date.now() - Number(CTX.authTransitionAt || 0)) < maxAgeMs;
}

function isGoogleAuthTransitionPending() {
  return Boolean(CTX.authTransitionActive && hasRecentAuthTransition());
}

function startGoogleAuthTransition(startedAt = Date.now()) {
  CTX.authTransitionActive = true;
  CTX.submitKind = 'google';
  CTX.authTransitionAt = Math.max(Number(CTX.authTransitionAt || 0), Number(startedAt || 0), Date.now());
  msg({ type: 'TOOL_HUB_MARK_AUTH_TRANSITION', toolSlug: TOOL_SLUG })
    .then((response) => {
      if (response?.ok) {
        CTX.authTransitionAt = Date.now();
      }
    })
    .catch(() => {});
}

function clearAuthTransition() {
  CTX.authTransitionAt = 0;
  CTX.authTransitionActive = false;
}

function resumeGoogleAuthTransition(startedAt = Date.now()) {
  CTX.authTransitionActive = true;
  CTX.submitKind = 'google';
  CTX.authTransitionAt = Math.max(Number(CTX.authTransitionAt || 0), Number(startedAt || 0), Date.now());
}

function getGoogleAuthTransitionElapsedMs() {
  if (!isGoogleAuthTransitionPending()) return 0;
  return Math.max(0, Date.now() - Number(CTX.authTransitionAt || 0));
}

function getGoogleAuthTransitionRemainingMs() {
  return Math.max(0, AUTH_TRANSITION_TIMEOUT_MS - getGoogleAuthTransitionElapsedMs());
}

// ── Chrome messaging ──────────────────────────────────────────
function msg(payload) {
  return new Promise((resolve) => {
    try {
      if (!chrome?.runtime?.id || typeof chrome.runtime.sendMessage !== 'function') {
        resolve({
          ok: false,
          error: 'Extension context invalidated.',
          contextInvalidated: true,
        });
        return;
      }

      chrome.runtime.sendMessage(payload, (response) => {
        const runtimeErrorMessage = chrome.runtime.lastError?.message || '';
        if (runtimeErrorMessage) {
          resolve({
            ok: false,
            error: runtimeErrorMessage,
            contextInvalidated: isExtensionContextInvalidatedError(runtimeErrorMessage),
          });
          return;
        }
        resolve(response || { ok: false, error: 'No response' });
      });
    } catch (error) {
      const runtimeErrorMessage = error?.message || 'Extension context invalidated.';
      resolve({
        ok: false,
        error: runtimeErrorMessage,
        contextInvalidated: isExtensionContextInvalidatedError(runtimeErrorMessage),
      });
    }
  });
}

// ── Ticket helpers ────────────────────────────────────────────
function readTicketFromUrl() {
  try {
    const sp = new URLSearchParams(location.search || '');
    const t = `${sp.get('rmw_extension_ticket') || ''}`.trim();
    if (t) return t;
    const hash = `${location.hash || ''}`.replace(/^#/, '');
    if (!hash) return '';
    return `${new URLSearchParams(hash).get('rmw_extension_ticket') || ''}`.trim();
  } catch { return ''; }
}

function readUsageTicketFromUrl() {
  try {
    const sp = new URLSearchParams(location.search || '');
    const ticket = `${sp.get('rmw_usage_ticket') || ''}`.trim();
    if (ticket) return ticket;
    const hash = `${location.hash || ''}`.replace(/^#/, '');
    if (!hash) return '';
    return `${new URLSearchParams(hash).get('rmw_usage_ticket') || ''}`.trim();
  } catch { return ''; }
}

function storeTicket(ticket) {
  try {
    ticket
      ? sessionStorage.setItem(EXTENSION_TICKET_KEY, ticket)
      : sessionStorage.removeItem(EXTENSION_TICKET_KEY);
  } catch {}
}

function loadStoredTicket() {
  try { return `${sessionStorage.getItem(EXTENSION_TICKET_KEY) || ''}`.trim(); }
  catch { return ''; }
}

function storeUsageTicket(ticket) {
  try {
    ticket
      ? sessionStorage.setItem(USAGE_TICKET_KEY, ticket)
      : sessionStorage.removeItem(USAGE_TICKET_KEY);
  } catch {}
}

function loadStoredUsageTicket() {
  try { return `${sessionStorage.getItem(USAGE_TICKET_KEY) || ''}`.trim(); }
  catch { return ''; }
}

function clearTicket() {
  try { sessionStorage.removeItem(EXTENSION_TICKET_KEY); } catch {}
}

function captureTicket() {
  const ticket = readTicketFromUrl();
  const usageTicket = readUsageTicketFromUrl();
  if (usageTicket) storeUsageTicket(usageTicket);
  const resolvedTicket = ticket || loadStoredTicket();
  if (ticket) storeTicket(ticket);
  if (ticket || usageTicket) {
    try {
      const sp = new URLSearchParams(location.search || '');
      sp.delete('rmw_extension_ticket');
      sp.delete('rmw_usage_ticket');
      sp.delete('rmw_tool_slug');
      const q = sp.toString();
      history.replaceState(null, '', location.pathname + (q ? `?${q}` : ''));
    } catch {}
  }
  return resolvedTicket;
}

// ── FIX: Only ever remove OUR keys — never clear site storage ─
function clearOurKeys() {
  const keys = [EXTENSION_TICKET_KEY, USAGE_TICKET_KEY, PREPARED_LAUNCH_KEY, BLOCKED_NOTICE_KEY];
  [sessionStorage, localStorage].forEach((s) => {
    keys.forEach((k) => { try { s.removeItem(k); } catch {} });
  });
}

function clearUsageTicket() {
  try { sessionStorage.removeItem(USAGE_TICKET_KEY); } catch {}
}

function parseCreditNumber(value) {
  const normalizedValue = `${value || ''}`.replace(/,/g, '').trim().toLowerCase();
  if (!normalizedValue) return null;
  if (!/^\d+(?:\.\d+)?\s*[km]?$/.test(normalizedValue)) return null;

  const match = normalizedValue.match(/^(\d+(?:\.\d+)?)\s*([km])?$/i);
  if (!match?.[1]) return null;

  const numericValue = Number(match[1]);
  if (!Number.isFinite(numericValue)) return null;

  const suffix = `${match[2] || ''}`.toLowerCase();
  if (suffix === 'k') return numericValue * 1000;
  if (suffix === 'm') return numericValue * 1000000;
  return numericValue;
}

function parseIntegerCreditNumber(value) {
  const parsed = parseCreditNumber(value);
  return Number.isInteger(parsed) ? parsed : null;
}

function parseExpectedCreditsFromGenerateText(value) {
  const normalized = normalizeGenerateActionLabel(value);
  if (!normalized) return null;
  const match = normalized.match(/(?:^|\s)(\d+)\s+(?:generate|credits?)(?:\s|$)/i)
    || normalized.match(/(?:^|\s)generate\s+(\d+)(?:\s|$)/i)
    || normalized.match(/(?:^|\s)credits?\s*[:=-]?\s*(\d+)(?:\s|$)/i);
  if (!match) return null;
  const parsed = Number(match[1]);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= MAX_REASONABLE_KLING_CREDIT_BURN
    ? parsed
    : null;
}

function collectGenerateTextCandidates(generateButton) {
  if (!generateButton) return [];

  const rawCandidates = [
    generateButton.innerText,
    generateButton.textContent,
    generateButton.value,
    generateButton.getAttribute?.('aria-label'),
    generateButton.getAttribute?.('title'),
    ...Array.from(generateButton.querySelectorAll('span,strong,b,div')).map((el) => el.textContent),
  ];

  const wholeCandidates = rawCandidates
    .filter(Boolean)
    .map((value) => normalizeGenerateActionLabel(value))
    .filter(Boolean);

  const splitCandidates = rawCandidates
    .filter(Boolean)
    .flatMap((value) => `${value}`.split(/\r?\n+/))
    .map((value) => normalizeGenerateActionLabel(value))
    .filter(Boolean);

  return collectUniqueElements([...wholeCandidates, ...splitCandidates])
    .sort((left, right) => left.length - right.length);
}

function buildLocalDateValue(offsetDays = 0) {
  const date = offsetDays instanceof Date ? new Date(offsetDays.getTime()) : new Date();
  date.setHours(12, 0, 0, 0);
  if (!(offsetDays instanceof Date)) {
    date.setDate(date.getDate() + offsetDays);
  }
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, '0');
  const day = `${date.getDate()}`.padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function findVisiblePromptField() {
  return collectUniqueElements([
    ...Array.from(document.querySelectorAll('textarea')),
    ...Array.from(document.querySelectorAll('input[type="text"], input:not([type])')),
    ...Array.from(document.querySelectorAll('[contenteditable="true"]')),
  ]).find((el) => isVisible(el) && !el.disabled && !el.readOnly) || null;
}

function normalizePromptCaptureValue(value) {
  const text = `${value || ''}`
    .replace(/\u00a0/g, ' ')
    .replace(/\s+\n/g, '\n')
    .replace(/\n\s+/g, '\n')
    .trim();
  if (!text || text.length < 2) return '';
  if (/^https?:\/\//i.test(text)) return '';
  if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(text)) return '';
  if (/^(generate|image generation|video generation|motion control|avatar|native audio|styles?)$/i.test(text)) return '';
  return text.slice(0, MAX_PROMPT_CAPTURE_LENGTH);
}

function readPromptCaptureSnapshot() {
  const candidates = [];
  const seen = new Set();
  const fields = collectUniqueElements([
    ...Array.from(document.querySelectorAll('textarea')),
    ...Array.from(document.querySelectorAll('[contenteditable="true"]')),
    ...Array.from(document.querySelectorAll('input[type="text"], input:not([type])')),
  ]);

  for (const field of fields) {
    if (!isVisible(field) || field.disabled || field.readOnly) continue;
    const rawValue = 'value' in field ? field.value : (field.innerText || field.textContent || '');
    const text = normalizePromptCaptureValue(rawValue);
    if (!text) continue;
    const lowered = text.toLowerCase();
    if (seen.has(lowered)) continue;
    seen.add(lowered);

    const labelText = normalizeSpace([
      field.getAttribute?.('placeholder'),
      field.getAttribute?.('aria-label'),
      field.getAttribute?.('name'),
      field.getAttribute?.('id'),
      field.closest?.('label')?.textContent,
      field.parentElement?.textContent?.slice(0, 200),
    ].filter(Boolean).join(' '));
    const tagName = `${field.tagName || ''}`.toLowerCase();
    const score = [
      tagName === 'textarea' ? 30 : 0,
      field.isContentEditable ? 25 : 0,
      /\b(prompt|describe|content|idea|text)\b/i.test(labelText) ? 20 : 0,
      text.length > 20 ? 10 : 0,
      text.length > 80 ? 10 : 0,
    ].reduce((sum, value) => sum + value, 0);

    candidates.push({
      text,
      source: tagName || (field.isContentEditable ? 'contenteditable' : 'field'),
      label: labelText.slice(0, 160),
      length: text.length,
      score,
    });
  }

  candidates.sort((left, right) => right.score - left.score || right.length - left.length);
  const limitedCandidates = candidates.slice(0, MAX_PROMPT_CANDIDATES);
  return {
    text: limitedCandidates[0]?.text || '',
    source: limitedCandidates[0]?.source || '',
    candidateCount: candidates.length,
    candidates: limitedCandidates.map((candidate) => ({
      text: candidate.text,
      source: candidate.source,
      label: candidate.label,
      length: candidate.length,
      score: candidate.score,
    })),
  };
}

function readPromptText() {
  const promptCapture = readPromptCaptureSnapshot();
  if (promptCapture.text) return promptCapture.text;
  const input = findVisiblePromptField();
  if (!input) return '';
  const value = 'value' in input ? input.value : (input.innerText || input.textContent || '');
  return normalizePromptCaptureValue(value);
}

function extractModelLabelFromText(value, generationMode = '') {
  const text = normalizeSpace(value || '');
  if (!text) return '';
  const patterns = [
    /\b(video\s*\d+(?:\.\d+)?\s*(?:turbo|master|pro)?)/i,
    /\b(image\s*\d+(?:\.\d+)?(?:\s*[a-z][a-z0-9-]*)?)/i,
    /\b(motion\s*control\s*(?:turbo|master|pro)?)/i,
    /\b(avatar\s*(?:basic|pro|realistic)?)/i,
    /\b(motion\s*control)\b/i,
    /\bavatar\b/i,
    /\b(master|turbo)\b/i,
  ];

  if (generationMode === 'video') {
    patterns.sort((left, right) => `${right}`.includes('video') - `${left}`.includes('video'));
  }
  if (generationMode === 'image') {
    patterns.sort((left, right) => `${right}`.includes('image') - `${left}`.includes('image'));
  }

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]) return match[1].trim();
    if (match?.[0]) return match[0].trim();
  }
  return '';
}

function readSelectedModelLabel(generationMode = '', scopedText = '') {
  const scopedLabel = extractModelLabelFromText(scopedText, generationMode);
  if (scopedLabel && !(generationMode === 'video' && /motion\s*control/i.test(scopedLabel))) {
    return scopedLabel;
  }
  const bodyLabel = extractModelLabelFromText(document.body?.innerText || '', generationMode);
  if (generationMode === 'video' && /motion\s*control/i.test(bodyLabel)) return 'video';
  return bodyLabel;
}

function inferGenerationModeFromText(value) {
  const text = normalizeSpace(value || '');
  if (!text) return '';

  const hasVideoModel = /\bvideo\s*\d+(?:\.\d+)?\b/i.test(text);
  const hasImageModel = /\bimage\s*\d+(?:\.\d+)?\b/i.test(text);
  const hasAvatarMode = /\bavatar\b/i.test(text);
  const hasMotionControlMode = /\bmotion\s*control\b/i.test(text);
  const hasVideoControls = /\b(360p|540p|720p|1080p|4k|2k|hd)\b/i.test(text)
    || /\b\d+\s*s\b/i.test(text)
    || /\bnative\s+audio\b/i.test(text)
    || /\bmulti-?shot\b/i.test(text)
    || /\bend\s+frame\b/i.test(text);
  if (hasVideoModel) return 'video';
  if (hasImageModel || /\b(image generation|strengthen|image-to-image|text-to-image)\b/i.test(text)) return 'image';
  if (hasAvatarMode) return 'avatar';
  if (hasMotionControlMode) return 'motion-control';
  if (hasVideoControls) return 'video';
  return '';
}

function readGenerationMode(scopedText = '') {
  const scopedMode = inferGenerationModeFromText(scopedText);
  if (scopedMode) return scopedMode;

  const bodyText = normalizeSpace(document.body?.innerText || '');
  const bodyMode = inferGenerationModeFromText(bodyText);
  if (bodyMode) return bodyMode;

  const pathname = `${location.pathname || ''}`.toLowerCase();
  if (pathname.includes('/image/')) return 'image';
  if (pathname.includes('/video/')) return 'video';
  if (pathname.includes('/avatar/')) return 'avatar';
  if (pathname.includes('/motion/')) return 'motion-control';

  const activeTab = Array.from(document.querySelectorAll('button,a,[role="button"],div,span'))
    .find((el) => {
      if (!isVisible(el)) return false;
      const text = normalizeSpace(buttonDescriptorText(el) || buttonText(el));
      if (!text) return false;
      const style = getComputedStyle(el);
      return (
        ['image generation', 'video generation', 'motion control', 'avatar'].includes(text)
        && (style.fontWeight === '700' || style.fontWeight === '600' || el.getAttribute('aria-current') === 'page')
      );
    });

  const label = normalizeSpace(buttonDescriptorText(activeTab) || buttonText(activeTab));
  if (label.includes('image')) return 'image';
  if (label.includes('video')) return 'video';
  if (label.includes('motion')) return 'motion-control';
  if (label.includes('avatar')) return 'avatar';
  return '';
}

function normalizeGenerateActionLabel(value) {
  return normalizeSpace(`${value || ''}`)
    .replace(/\b(\d+(?:\.\d+)?)\s+generate\s+\1generate\b/g, '$1 generate')
    .replace(/\bgenerate\s+generate\b/g, 'generate')
    .trim();
}

function readGenerateButtonLabel(generateButton) {
  return normalizeGenerateActionLabel(buttonText(generateButton))
    || normalizeGenerateActionLabel(buttonDescriptorText(generateButton));
}

function readExpectedCreditsFromGenerateButton(generateButton) {
  if (!generateButton) return null;

  for (const value of collectGenerateTextCandidates(generateButton)) {
    const parsed = parseExpectedCreditsFromGenerateText(value);
    if (parsed != null) return parsed;
  }
  return null;
}

function readCurrentKlingAccountLabel() {
  const emailPattern = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i;
  const visibleCandidates = collectUniqueElements(
    Array.from(document.querySelectorAll('button,span,div,a,p,strong,b'))
  )
    .filter((el) => isVisible(el))
    .map((el) => `${el.textContent || ''}`.trim())
    .filter(Boolean);

  for (const text of visibleCandidates) {
    const match = text.match(emailPattern);
    if (match?.[0]) return match[0].trim();
  }
  return '';
}

function readTrackedKlingAccountLabel() {
  return `${CTX.credential?.loginIdentifier || ''}`.trim() || readCurrentKlingAccountLabel();
}

async function resolveTrackedKlingAccountLabel() {
  const immediateLabel = readTrackedKlingAccountLabel();
  if (immediateLabel) return immediateLabel;
  try {
    const credential = await loadCredential();
    return `${credential?.loginIdentifier || ''}`.trim() || readCurrentKlingAccountLabel();
  } catch {
    return readCurrentKlingAccountLabel();
  }
}

function collectInteractionCandidateElements(target) {
  const path = typeof target?.composedPath === 'function' ? target.composedPath() : [];
  const pathElements = path.filter((node) => node?.nodeType === Node.ELEMENT_NODE);
  const fallback = [];
  let cur = target?.nodeType === Node.ELEMENT_NODE ? target : target?.parentElement;
  let depth = 0;
  while (cur && cur !== document.body && depth < 8) {
    fallback.push(cur);
    cur = cur.parentElement;
    depth += 1;
  }
  return collectUniqueElements([...pathElements, ...fallback]);
}

function findGenerateActionTarget(target) {
  const candidates = collectInteractionCandidateElements(target)
    .map((el) => findClickableAncestor(el) || el);

  let bestCandidate = null;
  let bestScore = -1;

  for (const candidate of collectUniqueElements(candidates)) {
    if (!candidate || !isVisible(candidate) || !isEnabled(candidate)) continue;

    const text = readGenerateButtonLabel(candidate);
    if (!text) continue;
    if (!/(^|\s)generate($|\s)/i.test(text)) continue;
    if (/create\s+in\s+omni/i.test(text)) continue;

    const rect = candidate.getBoundingClientRect();
    if (rect.width < 90 || rect.height < 32) continue;

    let score = 0;
    if (candidate.matches?.('button,[role="button"],a[href],input[type="button"],input[type="submit"]')) score += 5;
    if (rect.width >= 140) score += 3;
    if (rect.height >= 40) score += 2;
    if (parseCreditNumber(text) != null) score += 2;
    if (rect.top > window.innerHeight * 0.5) score += 1;

    if (score > bestScore) {
      bestScore = score;
      bestCandidate = candidate;
    }
  }

  return bestCandidate;
}

function readGenerateLikeClickLabel(target) {
  const path = typeof target?.composedPath === 'function' ? target.composedPath() : [];
  const pathElements = path.filter((node) => node?.nodeType === Node.ELEMENT_NODE);
  const fallback = [];
  let cur = target?.nodeType === Node.ELEMENT_NODE ? target : target?.parentElement;
  let depth = 0;
  while (cur && cur !== document.body && depth < 5) {
    fallback.push(cur);
    cur = cur.parentElement;
    depth += 1;
  }

  const candidates = collectUniqueElements([...pathElements, ...fallback]);
  for (const candidate of candidates) {
    const text = normalizeSpace(buttonDescriptorText(candidate) || buttonText(candidate));
    if (/\bgenerate\b/i.test(text)) {
      return text;
    }
  }
  return '';
}

function readGenerateControlContext(generateButton) {
  const scopeCandidates = [];
  let cur = generateButton?.parentElement || null;
  let depth = 0;
  while (cur && cur !== document.body && depth < 6) {
    scopeCandidates.push(cur);
    cur = cur.parentElement;
    depth += 1;
  }

  const scopeText = normalizeSpace(
    scopeCandidates
      .slice(0, 3)
      .map((el) => buttonDescriptorText(el))
      .filter(Boolean)
      .join(' ')
  );

  const durationMatch = scopeText.match(/\b(\d+)\s*s\b/i);
  const resolutionMatch = scopeText.match(/\b(360p|540p|720p|1080p|4k)\b/i);
  const ratioMatch = scopeText.match(/\b\d+\s*[:x]\s*\d+\b/i);
  const bodyText = normalizeSpace(document.body?.innerText || '');
  const modeContextText = normalizeSpace(`${scopeText} ${bodyText}`);
  const generationMode = inferGenerationModeFromText(modeContextText);
  const modelLabel = extractModelLabelFromText(modeContextText, generationMode);
  const outputCountMatch = scopeText.match(/\b(?:360p|540p|720p|1080p|4k)\b\s*[·|/,-]\s*\d+\s*s\s*[·|/,-]\s*(\d+)\b/i)
    || modeContextText.match(/\bnumber\s+of\s+outputs?\s*(\d+)\b/i)
    || modeContextText.match(/\boutputs?\s*[:=-]?\s*(\d+)\b/i);
  const outputCount = outputCountMatch ? Number(outputCountMatch[1]) : null;
  const nativeAudioEnabled = /\bnative\s+audio\b/i.test(modeContextText);
  const multiShotEnabled = /\bmulti-?shot\b/i.test(modeContextText);

  return {
    modelLabel,
    generationMode,
    durationLabel: durationMatch?.[0] || '',
    resolutionLabel: resolutionMatch?.[0] || '',
    aspectRatioLabel: ratioMatch?.[0] || '',
    outputCount: Number.isInteger(outputCount) && outputCount > 0 ? outputCount : null,
    nativeAudioEnabled,
    multiShotEnabled,
    scopeText,
  };
}

function buildGenerationSettingsMetadata({
  modelLabel = '',
  generationMode = '',
  durationLabel = '',
  resolutionLabel = '',
  aspectRatioLabel = '',
  outputCount = null,
  nativeAudio = false,
  multiShot = false,
  expectedCredits = null,
  actionLabel = '',
} = {}) {
  return {
    modelLabel: `${modelLabel || ''}`.trim(),
    generationMode: `${generationMode || ''}`.trim(),
    durationLabel: `${durationLabel || ''}`.trim(),
    resolutionLabel: `${resolutionLabel || ''}`.trim(),
    aspectRatioLabel: `${aspectRatioLabel || ''}`.trim(),
    outputCount: Number(outputCount || 0) || null,
    nativeAudio: Boolean(nativeAudio),
    multiShot: Boolean(multiShot),
    expectedCredits: Number(expectedCredits || 0) || null,
    actionLabel: `${actionLabel || ''}`.trim(),
  };
}

function inferCapturedAssetType(url = '', hint = '') {
  const text = `${hint || ''}\n${url || ''}`.toLowerCase();
  if (/\.(mp4|webm|mov|m4v|m3u8)(?:[?#]|$)/i.test(text) || /\b(video|mp4|m3u8)\b/i.test(text)) return 'video';
  if (/\.(png|jpe?g|webp|gif|avif)(?:[?#]|$)/i.test(text) || /\b(image|img|cover|thumbnail|poster)\b/i.test(text)) return 'image';
  return 'media';
}

function inferCapturedAssetRole(url = '', hint = '', source = '') {
  const normalizedSource = `${source || ''}`.trim().toLowerCase();
  const text = `${hint || ''}\n${url || ''}`.toLowerCase();
  if (normalizedSource === 'dom' || /^blob:/i.test(`${url || ''}`)) return 'output';
  if (/\b(input|reference|ref|origin|source|start|end|first|last|init|mask|image_url|imageurl)\b/.test(text)) {
    return 'input';
  }
  if (/\b(output|result|generated|final|download|resource|works?|task|video_url|videourl|cover|poster|thumbnail)\b/.test(text)) {
    return 'output';
  }
  return 'output';
}

function isInternalKlingPreviewAsset(url = '', hint = '') {
  const normalizedUrl = `${url || ''}`.trim().toLowerCase();
  const normalizedHint = `${hint || ''}`.trim().toLowerCase();
  if (!normalizedUrl) return false;
  if (/\.origin(?:[?#]|$)/i.test(normalizedUrl)) return false;
  const klingCdnSizeMatch = normalizedUrl.match(/^https?:\/\/[^/]*(?:klingai\.com|kling\.ai)\/kimg\/[^?#]+:(\d+)x(\d+)\.webp(?:[?#]|$)/i);
  if (klingCdnSizeMatch) {
    const width = Number(klingCdnSizeMatch[1]);
    const height = Number(klingCdnSizeMatch[2]);
    if (Number.isFinite(width) && Number.isFinite(height) && height > 0 && width / height >= 2.5) return true;
  }
  if (/^https?:\/\/[^/]*(?:klingai\.com|kling\.ai)\/kos\/[^?#]*\/kling-web[-/][^?#]*\.(?:png|jpe?g|webp|gif|avif|svg)(?:[?#]|$)/i.test(normalizedUrl)) return true;
  if (/^https?:\/\/[^/]*(?:klingai\.com|kling\.ai)\/kos\/[^?#]*\/kling-web\/assets\/[^?#]*\.(?:png|jpe?g|webp|gif|avif|svg)(?:[?#]|$)/i.test(normalizedUrl)) return true;
  if (/\/(?:assets?|static|web-assets?|kling-web)\/[^?#]*(?:logo|icon|sprite|placeholder|loading|empty|default|avatar|badge|watermark|ui|guide|tutorial|sample|example)[^/]*(?:\.(?:png|jpe?g|webp|gif|avif|svg))?(?:[?#]|$)/i.test(normalizedUrl)) return true;
  if (/\b(?:logo|icon|sprite|placeholder|loading|empty|default|avatar|badge|watermark|ui|guide|tutorial|sample|example)\b/i.test(normalizedHint)) return true;
  if (!/\.webp(?:[?#]|$)/i.test(normalizedUrl)) return false;
  if (/\borigin\b/.test(normalizedHint)) return false;
  if (/(omni-stream-loading|stream-loading|loading|placeholder|empty|default|sample|example)/i.test(normalizedUrl)) return true;
  return false;
}

function normalizeCapturedAssetUrl(value) {
  const text = `${value || ''}`.trim();
  if (!text || text.length > 4000) return '';
  if (/^data:/i.test(text)) return '';
  if (/^(https?:|blob:)/i.test(text)) return text;
  if (/^\/\//.test(text)) return `${location.protocol}${text}`;
  if (/^\/[^/]/.test(text)) {
    try {
      return new URL(text, location.href).href;
    } catch {}
  }
  return '';
}

function rememberBlobSourceUrl(blobUrl = '', sourceUrl = '') {
  const normalizedBlobUrl = `${blobUrl || ''}`.trim();
  const normalizedSourceUrl = normalizeCapturedAssetUrl(sourceUrl);
  if (!/^blob:/i.test(normalizedBlobUrl) || !/^https?:\/\//i.test(normalizedSourceUrl)) return;
  USAGE_CTX.blobSourceUrls.set(normalizedBlobUrl, {
    sourceUrl: normalizedSourceUrl,
    capturedAt: Date.now(),
  });
  if (USAGE_CTX.blobSourceUrls.size > 80) {
    const oldestKey = USAGE_CTX.blobSourceUrls.keys().next().value;
    if (oldestKey) USAGE_CTX.blobSourceUrls.delete(oldestKey);
  }
  USAGE_CTX.generatedAssetUrls.delete(normalizedBlobUrl);
  reportGeneratedAssetCandidates(USAGE_CTX.assetScanSnapshot, [{
    assetType: inferCapturedAssetType(normalizedSourceUrl),
    assetRole: 'output',
    source: 'blob_source',
    url: normalizedSourceUrl,
    blobUrl: normalizedBlobUrl,
    detectedAt: Date.now(),
  }]);
}

function releaseStoredMediaSourceAsset(key = '') {
  const normalizedKey = `${key || ''}`.trim();
  if (!normalizedKey) return;
  const asset = USAGE_CTX.mediaSourceAssets.get(normalizedKey);
  if (!asset) return;
  try {
    if (asset.objectUrl) URL.revokeObjectURL(asset.objectUrl);
  } catch {}
  USAGE_CTX.mediaSourceAssets.delete(normalizedKey);
}

function pruneStoredMediaSourceAssets() {
  while (USAGE_CTX.mediaSourceAssets.size > MAX_MEDIASOURCE_CAPTURED_ASSETS) {
    const oldestKey = USAGE_CTX.mediaSourceAssets.keys().next().value;
    if (!oldestKey) break;
    releaseStoredMediaSourceAsset(oldestKey);
  }
}

function clearStoredMediaSourceAssets() {
  for (const key of Array.from(USAGE_CTX.mediaSourceAssets.keys())) {
    releaseStoredMediaSourceAsset(key);
  }
}

function isBlobLike(value) {
  return Boolean(value)
    && typeof value === 'object'
    && typeof value.size === 'number'
    && typeof value.slice === 'function';
}

function storeMediaSourceVideoAsset(payload = {}) {
  const blob = payload?.blob;
  if (!isBlobLike(blob) || blob.size <= 0) return null;
  const sessionId = `${payload.sessionId || `kling-mediasource-${Date.now()}`}`.slice(0, 120);
  const objectUrl = URL.createObjectURL(blob);
  const completedAt = Number(payload.completedAt || Date.now());
  const startedAt = Number(payload.startedAt || completedAt);
  const fileName = `${sessionId}.mp4`.replace(/[^\w.-]+/g, '_');
  const file = typeof File === 'function'
    ? new File([blob], fileName, { type: 'video/mp4', lastModified: completedAt })
    : blob;

  const stored = {
    sessionId,
    objectUrl,
    fileName,
    file,
    blob,
    size: Number(payload.size || blob.size || 0) || blob.size,
    chunkCount: Number(payload.chunkCount || 0) || null,
    totalBytes: Number(payload.totalBytes || payload.size || blob.size || 0) || blob.size,
    startedAt,
    completedAt,
    capturedAt: completedAt,
    mimeType: `${payload.mimeType || blob.type || 'video/mp4'}`.slice(0, 120),
    sourceMimeType: `${payload.sourceMimeType || ''}`.slice(0, 200),
  };

  // Store only the completed Blob/File and its object URL. The page-context
  // chunk arrays are released by content-kling-mediasource.js after this event.
  releaseStoredMediaSourceAsset(sessionId);
  USAGE_CTX.mediaSourceAssets.set(sessionId, stored);
  pruneStoredMediaSourceAssets();
  USAGE_CTX.generatedAssetUrls.delete(objectUrl);

  return {
    assetType: 'video',
    assetRole: 'output',
    source: 'mediasource',
    url: objectUrl,
    blobUrl: objectUrl,
    key: sessionId,
    detectedAt: completedAt,
    size: stored.size,
    chunkCount: stored.chunkCount,
    totalBytes: stored.totalBytes,
    startedAt: stored.startedAt,
    completedAt: stored.completedAt,
    mimeType: stored.mimeType,
    mediaSourceSessionId: sessionId,
  };
}

function readBlobAsDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(`${reader.result || ''}`);
    reader.onerror = () => reject(reader.error || new Error('Unable to read captured video file.'));
    reader.readAsDataURL(blob);
  });
}

async function uploadMediaSourceVideoAsset(asset) {
  const sessionId = `${asset?.mediaSourceSessionId || asset?.key || ''}`.trim();
  const stored = sessionId ? USAGE_CTX.mediaSourceAssets.get(sessionId) : null;
  if (!stored?.blob) return asset;

  const dataUrl = await readBlobAsDataUrl(stored.blob);
  const response = await msg({
    type: 'TOOL_HUB_UPLOAD_CAPTURED_MEDIA',
    toolSlug: TOOL_SLUG,
    filename: stored.fileName || `${sessionId || 'kling-mediasource'}.mp4`,
    contentType: stored.mimeType || 'video/mp4',
    relativePath: `tool-captures/kling/${buildLocalDateValue(new Date(stored.completedAt || Date.now()))}`,
    dataUrl,
    metadata: {
      sessionId,
      size: stored.size,
      chunkCount: stored.chunkCount,
      startedAt: stored.startedAt,
      completedAt: stored.completedAt,
      source: 'mediasource',
    },
  });

  if (!response?.ok || !response.uploaded?.url) {
    throw new Error(response?.error || 'Captured MediaSource video upload failed.');
  }

  const uploaded = response.uploaded;
  const playableUrl = `${uploaded.permanentUrl || uploaded.openUrl || uploaded.url || ''}`;
  const rawUrl = `${uploaded.rawUrl || uploaded.storageUrl || ''}`;
  return {
    ...asset,
    source: 'mediasource_upload',
    url: playableUrl.slice(0, 4000),
    permanentUrl: playableUrl.slice(0, 4000),
    openUrl: `${uploaded.openUrl || playableUrl || ''}`.slice(0, 4000),
    downloadUrl: `${uploaded.downloadUrl || ''}`.slice(0, 4000),
    rawUrl: rawUrl.slice(0, 4000),
    storageUrl: `${uploaded.storageUrl || rawUrl || ''}`.slice(0, 4000),
    path: `${uploaded.path || ''}`.slice(0, 2048),
    filename: `${uploaded.filename || stored.fileName || ''}`.slice(0, 512),
    originalName: `${uploaded.originalName || stored.fileName || ''}`.slice(0, 512),
    storage: `${uploaded.storage || 'r2'}`.slice(0, 80),
    mimetype: `${uploaded.mimetype || stored.mimeType || 'video/mp4'}`.slice(0, 120),
    upload: {
      ok: true,
      uploadedAt: Date.now(),
      storage: `${uploaded.storage || 'r2'}`.slice(0, 80),
      path: `${uploaded.path || ''}`.slice(0, 2048),
      url: playableUrl.slice(0, 4000),
      rawUrl: rawUrl.slice(0, 4000),
      openUrl: `${uploaded.openUrl || playableUrl || ''}`.slice(0, 4000),
      downloadUrl: `${uploaded.downloadUrl || ''}`.slice(0, 4000),
    },
  };
}

function resolveCapturedAssetUrl(value) {
  const url = normalizeCapturedAssetUrl(value);
  if (!/^blob:/i.test(url)) {
    return {
      url,
      blobUrl: '',
      source: '',
    };
  }
  const mapped = USAGE_CTX.blobSourceUrls.get(url);
  const sourceUrl = normalizeCapturedAssetUrl(mapped?.sourceUrl);
  return {
    url: /^https?:\/\//i.test(sourceUrl) ? sourceUrl : url,
    blobUrl: url,
    source: /^https?:\/\//i.test(sourceUrl) ? 'blob_source' : '',
  };
}

function extractSrcsetUrls(value = '') {
  return `${value || ''}`
    .split(',')
    .map((item) => item.trim().split(/\s+/)[0])
    .filter(Boolean);
}

function extractCssUrlValues(value = '') {
  const urls = [];
  const text = `${value || ''}`;
  const re = /url\((['"]?)(.*?)\1\)/gi;
  let match = re.exec(text);
  while (match) {
    if (match[2]) urls.push(match[2]);
    match = re.exec(text);
  }
  return urls;
}

function getElementMediaUrlCandidates(el, mediaEl) {
  const candidates = [
    el.currentSrc,
    el.src,
    el.getAttribute?.('src'),
    el.getAttribute?.('poster'),
    mediaEl?.poster,
    el.getAttribute?.('data-src'),
    el.getAttribute?.('data-original'),
    el.getAttribute?.('data-url'),
  ];
  candidates.push(...extractSrcsetUrls(el.srcset || el.getAttribute?.('srcset') || ''));
  candidates.push(...extractCssUrlValues(window.getComputedStyle?.(el)?.backgroundImage || ''));
  if (mediaEl && mediaEl !== el) {
    candidates.push(...extractCssUrlValues(window.getComputedStyle?.(mediaEl)?.backgroundImage || ''));
  }
  return candidates.filter(Boolean);
}

function isLikelyKlingUiMediaElement(el) {
  if (!el || el.nodeType !== Node.ELEMENT_NODE) return true;
  if (el.closest?.('#rmw-kling-badge')) return true;
  if (el.closest?.('nav,header,footer,aside,[role="navigation"],[role="menu"],[role="menubar"],[role="dialog"],[aria-modal="true"]')) return true;
  const contextText = normalizeSpace([
    el.getAttribute?.('alt'),
    el.getAttribute?.('aria-label'),
    el.getAttribute?.('title'),
    el.getAttribute?.('class'),
    el.getAttribute?.('id'),
    el.closest?.('[class]')?.getAttribute?.('class'),
    el.closest?.('[id]')?.getAttribute?.('id'),
  ].filter(Boolean).join(' '));
  return /\b(logo|icon|avatar|badge|watermark|sidebar|navbar|toolbar|menu|button|empty|placeholder|loading|spinner|guide|tutorial|sample|example|template|history|asset-library)\b/i.test(contextText);
}

function inferGenerateDetectionSource(generateButton) {
  if (!generateButton) return 'unknown';
  const parts = [
    ['inner_text', generateButton.innerText],
    ['text_content', generateButton.textContent],
    ['value', generateButton.value],
    ['aria_label', generateButton.getAttribute?.('aria-label')],
    ['title', generateButton.getAttribute?.('title')],
    ['data_testid', generateButton.getAttribute?.('data-testid')],
  ];
  const matched = parts.find(([, value]) => /\bgenerate\b/i.test(normalizeSpace(value || '')));
  if (matched) return matched[0];
  const descendantText = Array.from(generateButton.querySelectorAll?.('span,strong,b,div,img[alt]') || [])
    .map((el) => el.getAttribute?.('alt') || el.textContent || '')
    .find((value) => /\bgenerate\b/i.test(normalizeSpace(value || '')));
  return descendantText ? 'descendant_text' : 'button_descriptor';
}

function normalizeCapturedMediaAssets(value, source = 'network') {
  const inputAssets = Array.isArray(value) ? value : [];
  const assets = [];
  const seen = new Set();
  for (const asset of inputAssets) {
    const rawUrl = typeof asset === 'string' ? asset : asset?.url;
    const resolvedAssetUrl = resolveCapturedAssetUrl(rawUrl);
    const url = resolvedAssetUrl.url;
    if (!url || seen.has(url)) continue;
    if (isInternalKlingPreviewAsset(url, asset?.key || '')) continue;
    seen.add(url);
    assets.push({
      assetType: `${asset?.assetType || inferCapturedAssetType(url, asset?.key || '')}`.trim() || 'media',
      assetRole: `${asset?.assetRole || inferCapturedAssetRole(url, asset?.key || '', asset?.source || source)}`.trim() || 'output',
      source: `${resolvedAssetUrl.source || asset?.source || source || 'network'}`.trim(),
      url,
      blobUrl: `${asset?.blobUrl || resolvedAssetUrl.blobUrl || ''}`.slice(0, 4000),
      key: `${asset?.key || ''}`.slice(0, 120),
      width: Number(asset?.width || 0) || null,
      height: Number(asset?.height || 0) || null,
      detectedAt: Number(asset?.detectedAt || Date.now()),
      size: Number(asset?.size || 0) || null,
      chunkCount: Number(asset?.chunkCount || 0) || null,
      totalBytes: Number(asset?.totalBytes || 0) || null,
      startedAt: Number(asset?.startedAt || 0) || null,
      completedAt: Number(asset?.completedAt || 0) || null,
      mimeType: `${asset?.mimeType || ''}`.slice(0, 120),
      mediaSourceSessionId: `${asset?.mediaSourceSessionId || ''}`.slice(0, 120),
      permanentUrl: `${asset?.permanentUrl || ''}`.slice(0, 4000),
      openUrl: `${asset?.openUrl || ''}`.slice(0, 4000),
      downloadUrl: `${asset?.downloadUrl || ''}`.slice(0, 4000),
      rawUrl: `${asset?.rawUrl || ''}`.slice(0, 4000),
      storageUrl: `${asset?.storageUrl || ''}`.slice(0, 4000),
      path: `${asset?.path || ''}`.slice(0, 2048),
      filename: `${asset?.filename || ''}`.slice(0, 512),
      originalName: `${asset?.originalName || ''}`.slice(0, 512),
      storage: `${asset?.storage || ''}`.slice(0, 80),
      mimetype: `${asset?.mimetype || ''}`.slice(0, 120),
      upload: asset?.upload && typeof asset.upload === 'object'
        ? {
          ok: Boolean(asset.upload.ok),
          uploadedAt: Number(asset.upload.uploadedAt || 0) || null,
          storage: `${asset.upload.storage || ''}`.slice(0, 80),
          path: `${asset.upload.path || ''}`.slice(0, 2048),
          url: `${asset.upload.url || ''}`.slice(0, 4000),
          rawUrl: `${asset.upload.rawUrl || ''}`.slice(0, 4000),
          openUrl: `${asset.upload.openUrl || ''}`.slice(0, 4000),
          downloadUrl: `${asset.upload.downloadUrl || ''}`.slice(0, 4000),
          error: `${asset.upload.error || ''}`.slice(0, 500),
          failedAt: Number(asset.upload.failedAt || 0) || null,
        }
        : null,
    });
    if (assets.length >= MAX_CAPTURED_MEDIA_ASSETS) break;
  }
  return assets;
}

function collectVisibleGeneratedMediaAssets(generationMode = '') {
  const normalizedGenerationMode = `${generationMode || ''}`.trim().toLowerCase();
  const shouldScanVideo = normalizedGenerationMode !== 'image';
  const assets = [];
  const seen = new Set();
  const selectors = [
    'img[src]',
    'img[currentSrc]',
    'img[srcset]',
    'img[data-src]',
    'img[data-original]',
    'img[data-url]',
    'picture source[srcset]',
  ];
  if (normalizedGenerationMode === 'image') {
    selectors.push(
      '[style*="background-image"]',
      '[style*="background:"]',
    );
  }
  if (shouldScanVideo) {
    selectors.push(
      'video[src]',
      'video[poster]',
      'video source[src]',
    );
  }

  for (const el of collectUniqueElements(Array.from(document.querySelectorAll(selectors.join(','))))) {
    const mediaEl = el.closest?.('video') || el;
    if (!isVisible(mediaEl)) continue;
    if (isLikelyKlingUiMediaElement(mediaEl) || isLikelyKlingUiMediaElement(el)) continue;

    const rect = mediaEl.getBoundingClientRect();
    if (rect.width < 160 || rect.height < 120) continue;
    const viewportArea = Math.max(1, window.innerWidth * window.innerHeight);
    if ((rect.width * rect.height) / viewportArea < 0.015) continue;

    const rawUrl = getElementMediaUrlCandidates(el, mediaEl)
      .find((candidate) => {
        const resolved = resolveCapturedAssetUrl(candidate);
        const resolvedUrl = resolved.url;
        if (!resolvedUrl || seen.has(resolvedUrl)) return false;
        if (isInternalKlingPreviewAsset(resolvedUrl, mediaEl.tagName || el.tagName)) return false;
        if (/\/(logo|icon|avatar|sprite|placeholder|loading|empty|default|sample|example|template)[^/]*\.(?:png|jpe?g|webp|gif|svg)/i.test(resolvedUrl)) return false;
        return true;
      });
    const resolvedAssetUrl = resolveCapturedAssetUrl(rawUrl);
    const url = resolvedAssetUrl.url;
    if (!url || seen.has(url)) continue;
    if (isInternalKlingPreviewAsset(url, mediaEl.tagName || el.tagName)) continue;
    if (/\/(logo|icon|avatar|sprite|placeholder|loading|empty|default|sample|example|template)[^/]*\.(?:png|jpe?g|webp|gif|svg)/i.test(url)) continue;

    seen.add(url);
    const isVideoAsset = mediaEl.tagName?.toLowerCase() === 'video' || el.tagName?.toLowerCase() === 'video';
    if (normalizedGenerationMode === 'image' && isVideoAsset) continue;

    assets.push({
      assetType: isVideoAsset ? 'video' : inferCapturedAssetType(url, mediaEl.tagName || el.tagName),
      assetRole: 'output',
      source: resolvedAssetUrl.source || 'dom',
      url,
      blobUrl: resolvedAssetUrl.blobUrl,
      width: Math.round(rect.width),
      height: Math.round(rect.height),
      detectedAt: Date.now(),
    });
    if (assets.length >= MAX_CAPTURED_MEDIA_ASSETS) break;
  }
  return assets;
}

function mergeCapturedMediaAssets(existingAssets = [], incomingAssets = []) {
  const mergedByKey = new Map();
  const order = [];
  for (const asset of [...normalizeCapturedMediaAssets(existingAssets), ...normalizeCapturedMediaAssets(incomingAssets, 'dom')]) {
    if (!asset.url) continue;
    const key = asset.blobUrl || asset.url;
    const existing = mergedByKey.get(key);
    if (!existing) {
      mergedByKey.set(key, asset);
      order.push(key);
      continue;
    }
    const existingIsBlobOnly = /^blob:/i.test(existing.url || '');
    const incomingIsHttp = /^https?:\/\//i.test(asset.url || '');
    if (existingIsBlobOnly && incomingIsHttp) {
      mergedByKey.set(key, { ...existing, ...asset, blobUrl: asset.blobUrl || existing.blobUrl });
    }
  }
  return order.map((key) => mergedByKey.get(key)).filter(Boolean).slice(0, MAX_CAPTURED_MEDIA_ASSETS);
}

function isMediaSourceCapturedAsset(asset) {
  return /^mediasource/i.test(`${asset?.source || ''}`) || `${asset?.mediaSourceSessionId || ''}`.trim();
}

function shouldDropDomPreviewAfterMediaSource(asset) {
  const source = `${asset?.source || ''}`.trim().toLowerCase();
  if (inferCapturedAssetRole(asset?.url, asset?.key, source) === 'input') return false;
  return source === 'dom' || source === 'blob_source' || /^blob:/i.test(`${asset?.url || ''}`);
}

function buildActiveGenerationFromSnapshot(snapshot, startedAt = Date.now()) {
  const promptText = normalizePromptCaptureValue(snapshot?.promptText);
  const generateIntentId = `${snapshot?.metadata?.generateIntentId || snapshot?.externalEventId || ''}`.trim();
  if (!promptText || !generateIntentId) return null;
  return {
    internalGenerationId: generateIntentId,
    generateIntentId,
    externalEventId: `${snapshot?.externalEventId || ''}`.trim(),
    fingerprint: `${snapshot?.fingerprint || ''}`.trim(),
    promptText,
    prompt: promptText,
    startedAt,
    expiresAt: startedAt + ACTIVE_GENERATION_MAX_MS,
    klingTaskId: '',
    identifierChannel: '',
    identifierSource: '',
    identifierKind: '',
    ownershipConfidence: 0.9,
    discoveredTaskIds: [],
    outputFeedSnapshotCount: Number(snapshot?.metadata?.outputFeedSnapshotCount || 0) || 0,
    ownedOutputDetectedAt: 0,
    ownedOutputAssetCount: 0,
    status: 'active',
  };
}

function isActiveGenerationValid(activeGeneration = USAGE_CTX.activeGeneration, now = Date.now()) {
  return Boolean(
    activeGeneration
    && normalizePromptCaptureValue(activeGeneration.promptText)
    && `${activeGeneration.generateIntentId || ''}`.trim()
    && Number(activeGeneration.startedAt || 0) > 0
    && Number(activeGeneration.expiresAt || 0) >= now
  );
}

function snapshotMatchesActiveGeneration(snapshot, activeGeneration = USAGE_CTX.activeGeneration) {
  if (!isActiveGenerationValid(activeGeneration)) return false;
  const snapshotIntentId = `${snapshot?.metadata?.generateIntentId || snapshot?.externalEventId || ''}`.trim();
  return Boolean(snapshotIntentId && snapshotIntentId === activeGeneration.generateIntentId);
}

function assetStartedAfterActiveGeneration(asset, activeGeneration = USAGE_CTX.activeGeneration) {
  if (!isActiveGenerationValid(activeGeneration)) return false;
  const startedAt = Number(asset?.startedAt || asset?.detectedAt || Date.now());
  if (!Number.isFinite(startedAt) || startedAt <= 0) return false;
  return startedAt >= Number(activeGeneration.startedAt || 0);
}

function mediaSourcePayloadMatchesActiveGeneration(payload = {}) {
  if (!isActiveGenerationValid()) return false;
  const startedAt = Number(payload?.startedAt || 0);
  if (!Number.isFinite(startedAt) || startedAt <= 0) return false;
  return startedAt >= Number(USAGE_CTX.activeGeneration.startedAt || 0);
}

function normalizeKlingTaskId(value) {
  const text = `${value || ''}`.trim();
  if (!text || text.length > 220) return '';
  if (/^\d{1,3}$/.test(text)) return '';
  return text;
}

function collectKlingTaskIdsFromPayload(payload = {}) {
  const ids = [];
  const push = (value) => {
    const normalized = normalizeKlingTaskId(value);
    if (normalized && !ids.includes(normalized)) ids.push(normalized);
  };
  push(payload.klingTaskId);
  push(payload.generationId);
  push(payload.requestId);
  push(payload.externalEventId);
  if (Array.isArray(payload.identifierCandidates)) {
    for (const candidate of payload.identifierCandidates) {
      push(candidate?.value);
    }
  }
  return ids;
}

function getActiveGenerationTaskIds(activeGeneration = USAGE_CTX.activeGeneration) {
  const ids = [];
  const push = (value) => {
    const normalized = normalizeKlingTaskId(value);
    if (normalized && !ids.includes(normalized)) ids.push(normalized);
  };
  push(activeGeneration?.klingTaskId);
  if (Array.isArray(activeGeneration?.discoveredTaskIds)) {
    activeGeneration.discoveredTaskIds.forEach(push);
  }
  return ids;
}

function buildGenerationOwnershipMetadata(activeGeneration = USAGE_CTX.activeGeneration, strategy = '') {
  if (!isActiveGenerationValid(activeGeneration)) return {};
  const taskIds = getActiveGenerationTaskIds(activeGeneration);
  return {
    internalGenerationId: activeGeneration.internalGenerationId || activeGeneration.generateIntentId,
    klingTaskId: activeGeneration.klingTaskId || taskIds[0] || '',
    discoveredTaskIds: taskIds,
    ownershipStrategy: strategy || (taskIds.length ? 'kling_task_id' : 'dom_new_output_fallback'),
    ownershipConfidence: Number(activeGeneration.ownershipConfidence || (taskIds.length ? 0.99 : 0.9)),
    ownershipChannel: activeGeneration.identifierChannel || '',
    ownershipSource: activeGeneration.identifierSource || '',
    ownershipKind: activeGeneration.identifierKind || '',
    outputFeedSnapshotCount: Number(activeGeneration.outputFeedSnapshotCount || 0) || 0,
    ownedOutputDetectedAt: Number(activeGeneration.ownedOutputDetectedAt || 0) || null,
  };
}

function attachActiveGenerationOwnership(snapshot, strategy = '') {
  if (!snapshot || !isActiveGenerationValid()) return snapshot;
  const ownership = buildGenerationOwnershipMetadata(USAGE_CTX.activeGeneration, strategy);
  snapshot.metadata = {
    ...(snapshot.metadata || {}),
    ...ownership,
    ownership,
  };
  if (ownership.klingTaskId) {
    snapshot.generationId = snapshot.generationId || ownership.klingTaskId;
  }
  return snapshot;
}

function associateKlingTaskIdWithActiveGeneration(payload = {}) {
  if (!isActiveGenerationValid()) return false;
  const ids = collectKlingTaskIdsFromPayload(payload);
  if (!ids.length) return false;
  const activeIds = getActiveGenerationTaskIds();
  const hasSubmitPrompt = Boolean(normalizePromptCaptureValue(payload?.promptText));
  if (activeIds.length && !ids.some((id) => activeIds.includes(id)) && !hasSubmitPrompt) {
    debugUsageTelemetry('kling_task_id_association_skipped_mismatch', {
      incomingIds: ids.slice(0, 8),
      activeIds: activeIds.slice(0, 8),
      source: payload.source,
    });
    return false;
  }
  const activeGeneration = USAGE_CTX.activeGeneration;
  activeGeneration.discoveredTaskIds = Array.isArray(activeGeneration.discoveredTaskIds)
    ? activeGeneration.discoveredTaskIds
    : [];
  for (const id of ids) {
    if (!activeGeneration.discoveredTaskIds.includes(id)) {
      activeGeneration.discoveredTaskIds.push(id);
    }
    USAGE_CTX.activeGenerationIds.set(id, Date.now());
  }
  const primaryId = normalizeKlingTaskId(payload.klingTaskId)
    || ids.find((id) => id && id !== payload.externalEventId)
    || ids[0];
  if (primaryId && !activeGeneration.klingTaskId) {
    activeGeneration.klingTaskId = primaryId;
  }
  activeGeneration.identifierChannel = `${payload.identifierChannel || payload.transport || payload.source || activeGeneration.identifierChannel || ''}`.slice(0, 120);
  activeGeneration.identifierSource = `${payload.identifierSource || activeGeneration.identifierSource || ''}`.slice(0, 120);
  activeGeneration.identifierKind = `${payload.identifierKind || activeGeneration.identifierKind || ''}`.slice(0, 80);
  activeGeneration.ownershipConfidence = Math.max(
    Number(activeGeneration.ownershipConfidence || 0),
    Number(payload.ownershipConfidence || (activeGeneration.klingTaskId ? 0.99 : 0.85))
  );
  if (USAGE_CTX.assetScanSnapshot) {
    attachActiveGenerationOwnership(USAGE_CTX.assetScanSnapshot, 'kling_task_id');
  }
  debugUsageTelemetry('kling_task_id_associated', {
    internalGenerationId: activeGeneration.internalGenerationId,
    klingTaskId: activeGeneration.klingTaskId,
    ids: activeGeneration.discoveredTaskIds.slice(0, 8),
    channel: activeGeneration.identifierChannel,
  });
  return true;
}

function payloadMatchesActiveGenerationTaskId(payload = {}) {
  const activeIds = getActiveGenerationTaskIds();
  if (!activeIds.length) return null;
  const payloadIds = collectKlingTaskIdsFromPayload(payload);
  if (!payloadIds.length) return false;
  return payloadIds.some((id) => activeIds.includes(id));
}

function markActiveGenerationOwnedOutput(assetCount = 0, source = 'dom_new_output_fallback') {
  if (!isActiveGenerationValid()) return;
  const activeGeneration = USAGE_CTX.activeGeneration;
  activeGeneration.ownedOutputDetectedAt = activeGeneration.ownedOutputDetectedAt || Date.now();
  activeGeneration.ownedOutputAssetCount += Math.max(0, Number(assetCount || 0));
  activeGeneration.ownershipConfidence = Math.max(
    Number(activeGeneration.ownershipConfidence || 0),
    getActiveGenerationTaskIds(activeGeneration).length ? 0.99 : 0.9
  );
  if (USAGE_CTX.assetScanSnapshot) {
    attachActiveGenerationOwnership(USAGE_CTX.assetScanSnapshot, source);
  }
}

function hasOwnedOutputForActiveGeneration() {
  return Boolean(isActiveGenerationValid() && Number(USAGE_CTX.activeGeneration?.ownedOutputDetectedAt || 0) > 0);
}

function isGoogleOauthRecoveryUrl(value = '') {
  try {
    const url = new URL(`${value || ''}`, location.href);
    return url.protocol === 'https:'
      && url.hostname === 'accounts.google.com'
      && (
        /oauth|signin|identifier|servicelogin/i.test(url.pathname)
        || /client_id|redirect_uri|oauth/i.test(url.search)
      );
  } catch {
    return false;
  }
}

function requestKlingGooglePopupAllowance() {
  return msg({
    type: 'TOOL_HUB_ALLOW_KLING_GOOGLE_POPUPS',
    toolSlug: TOOL_SLUG,
  })
    .then((response) => {
      if (response?.ok) {
        CTX.googlePopupAllowAppliedAt = Date.now();
        CTX.googlePopupAllowFailedAt = 0;
        debugUsageTelemetry('kling_google_popup_allow_applied', {
          applied: Array.isArray(response.applied) ? response.applied : [],
          errors: Array.isArray(response.errors) ? response.errors : [],
          probes: Array.isArray(response.probes) ? response.probes : [],
        });
        return response;
      }
      CTX.googlePopupAllowFailedAt = Date.now();
      debugUsageTelemetry('kling_google_popup_allow_failed', {
        error: response?.error || 'unknown error',
      });
      return response;
    })
    .catch((error) => {
      CTX.googlePopupAllowFailedAt = Date.now();
      debugUsageTelemetry('kling_google_popup_allow_failed', {
        error: error?.message || `${error || 'unknown error'}`,
      });
      return { ok: false, error: error?.message || `${error || 'unknown error'}` };
    });
}

function ensureKlingGooglePopupsAllowed() {
  const now = Date.now();
  if (CTX.googlePopupAllowAppliedAt && now - Number(CTX.googlePopupAllowAppliedAt || 0) < 10 * 60 * 1000) {
    return true;
  }
  if (CTX.googlePopupAllowFailedAt && now - Number(CTX.googlePopupAllowFailedAt || 0) < 30000) {
    return true;
  }
  if (CTX.googlePopupAllowRequestedAt && now - Number(CTX.googlePopupAllowRequestedAt || 0) < 2500) {
    return false;
  }

  CTX.googlePopupAllowRequestedAt = now;
  setStatus('Allowing Kling Google popup...');
  requestKlingGooglePopupAllowance()
    .then(() => {
      CTX.lastLandingActionKey = '';
      CTX.landingActionLockUntil = 0;
      wake(0);
    });

  return false;
}

function retryOriginalKlingGooglePopup(delayMs = 900) {
  setTimeout(() => {
    if (CTX.stopped) return;
    CTX.manualGoogleHandoff = false;
    CTX.lastLandingActionKey = '';
    CTX.landingActionLockUntil = 0;
    const googleButton = findGoogleAuthButton();
    if (googleButton) {
      clickGoogleLandingAction(googleButton, 'Opening Google sign-in in Kling popup...');
      return;
    }
    CTX.phase = P.OPEN_LANDING;
    wake(300);
  }, Math.max(0, delayMs));
}

function scheduleKlingPopupAllowanceReload(delayMs = 500) {
  const now = Date.now();
  let lastReloadAt = 0;
  try {
    lastReloadAt = Number(sessionStorage.getItem(GOOGLE_POPUP_ALLOW_RELOAD_KEY) || 0) || 0;
  } catch {}

  if (lastReloadAt && now - lastReloadAt < 60000) {
    retryOriginalKlingGooglePopup(900);
    return;
  }

  try {
    sessionStorage.setItem(GOOGLE_POPUP_ALLOW_RELOAD_KEY, `${now}`);
  } catch {}
  writeCheckpoint(P.OPEN_LANDING, {
    googlePopupAllowedReload: true,
    submitKind: 'google',
  });
  setStatus('Popups allowed for Kling. Refreshing once so Google popup can open...');
  setTimeout(() => {
    try {
      location.reload();
    } catch {
      retryOriginalKlingGooglePopup(300);
    }
  }, Math.max(0, delayMs));
}

function recoverBlockedGoogleOauthPopup(payload = {}) {
  const url = `${payload?.url || ''}`.trim();
  if (!isGoogleOauthRecoveryUrl(url)) return;
  const now = Date.now();
  if (now - Number(CTX.lastGoogleOauthRecoveryAt || 0) < 15000) {
    return;
  }
  CTX.lastGoogleOauthRecoveryUrl = url;
  CTX.lastGoogleOauthRecoveryAt = now;
  setStatus('Chrome blocked Kling Google popup. Allowing popups and retrying Kling button...');
  clearAuthTransition();
  clearCheckpoint();
  CTX.manualGoogleHandoff = false;
  CTX.submitLockUntil = 0;
  CTX.submitAt = 0;
  CTX.submitKind = '';
  CTX.phase = P.OPEN_LANDING;
  CTX.lastLandingActionKey = '';
  CTX.landingActionLockUntil = 0;
  CTX.googlePopupAllowRequestedAt = 0;
  CTX.googlePopupAllowAppliedAt = 0;
  CTX.googlePopupAllowFailedAt = 0;
  requestKlingGooglePopupAllowance()
    .then((response) => {
      if (response?.ok) {
        scheduleKlingPopupAllowanceReload(500);
        return;
      }
      setStatus(`Could not auto-allow Kling popups: ${response?.error || 'unknown error'}`);
      retryOriginalKlingGooglePopup(1000);
    });
}

function prunePendingMediaSourcePayloads(now = Date.now()) {
  USAGE_CTX.pendingMediaSourcePayloads = (USAGE_CTX.pendingMediaSourcePayloads || [])
    .filter((entry) => entry?.payload?.blob && now - Number(entry.queuedAt || 0) <= PENDING_MEDIASOURCE_MAX_MS)
    .slice(-MAX_PENDING_MEDIASOURCE_PAYLOADS);
}

function processOwnedMediaSourcePayload(mediaSourcePayload = {}) {
  const asset = storeMediaSourceVideoAsset(mediaSourcePayload);
  if (!asset) return;
  attachActiveGenerationOwnership(USAGE_CTX.assetScanSnapshot, 'owned_output_mediasource_enrichment');
  setStatus(`MediaSource video captured (${Math.round((asset.size || 0) / 1024 / 1024)} MB)`, { hideAfterMs: 2500 });
  uploadMediaSourceVideoAsset(asset)
    .then((uploadedAsset) => {
      const enrichedAsset = {
        ...uploadedAsset,
        internalGenerationId: USAGE_CTX.activeGeneration?.internalGenerationId || '',
        klingTaskId: USAGE_CTX.activeGeneration?.klingTaskId || '',
      };
      reportGeneratedAssetCandidates(USAGE_CTX.assetScanSnapshot, [enrichedAsset]);
      debugUsageTelemetry('mediasource_video_uploaded', {
        sessionId: uploadedAsset.mediaSourceSessionId,
        size: uploadedAsset.size,
        chunkCount: uploadedAsset.chunkCount,
        url: `${uploadedAsset.permanentUrl || uploadedAsset.url || ''}`.slice(0, 1000),
        startedAt: uploadedAsset.startedAt,
        completedAt: uploadedAsset.completedAt,
        ownership: buildGenerationOwnershipMetadata(USAGE_CTX.activeGeneration, 'owned_output_mediasource_enrichment'),
      });
      releaseStoredMediaSourceAsset(asset.mediaSourceSessionId);
      setStatus('MediaSource video uploaded', { hideAfterMs: 2500 });
    })
    .catch((error) => {
      releaseStoredMediaSourceAsset(asset.mediaSourceSessionId);
      debugUsageTelemetry('mediasource_video_upload_failed', {
        sessionId: asset.mediaSourceSessionId,
        size: asset.size,
        chunkCount: asset.chunkCount,
        error: `${error?.message || error || ''}`.slice(0, 500),
      });
      console.warn('[RMW Kling] MediaSource video upload failed', error);
    });
}

function flushPendingMediaSourcePayloads() {
  prunePendingMediaSourcePayloads();
  if (!hasOwnedOutputForActiveGeneration()) return;
  const pending = USAGE_CTX.pendingMediaSourcePayloads.splice(0, MAX_PENDING_MEDIASOURCE_PAYLOADS);
  for (const entry of pending) {
    if (mediaSourcePayloadMatchesActiveGeneration(entry.payload)) {
      processOwnedMediaSourcePayload(entry.payload);
    }
  }
}

function queueOrProcessMediaSourcePayload(mediaSourcePayload = {}) {
  if (!normalizePromptCaptureValue(USAGE_CTX.assetScanSnapshot?.promptText) || !mediaSourcePayloadMatchesActiveGeneration(mediaSourcePayload)) {
    debugUsageTelemetry('mediasource_video_skipped_without_active_generation', {
      sessionId: `${mediaSourcePayload?.sessionId || ''}`.slice(0, 120),
      size: Number(mediaSourcePayload?.size || 0) || null,
      sessionStartedAt: Number(mediaSourcePayload?.startedAt || 0) || null,
      activeStartedAt: Number(USAGE_CTX.activeGeneration?.startedAt || 0) || null,
      activeIntentId: `${USAGE_CTX.activeGeneration?.generateIntentId || ''}`.trim(),
    });
    return;
  }
  if (hasOwnedOutputForActiveGeneration()) {
    processOwnedMediaSourcePayload(mediaSourcePayload);
    return;
  }
  // MediaSource delivers the MP4 bytes, but ownership is decided by task ID or
  // newly inserted output cards. Keep only a tiny pending set until ownership
  // lands, then release each Blob after upload.
  prunePendingMediaSourcePayloads();
  USAGE_CTX.pendingMediaSourcePayloads.push({
    payload: mediaSourcePayload,
    queuedAt: Date.now(),
  });
  while (USAGE_CTX.pendingMediaSourcePayloads.length > MAX_PENDING_MEDIASOURCE_PAYLOADS) {
    USAGE_CTX.pendingMediaSourcePayloads.shift();
  }
  debugUsageTelemetry('mediasource_video_waiting_for_owned_output', {
    sessionId: `${mediaSourcePayload?.sessionId || ''}`.slice(0, 120),
    size: Number(mediaSourcePayload?.size || 0) || null,
    pendingCount: USAGE_CTX.pendingMediaSourcePayloads.length,
    activeIntentId: `${USAGE_CTX.activeGeneration?.generateIntentId || ''}`.trim(),
  });
}

function clearActiveGeneration(reason = '') {
  if (USAGE_CTX.activeGeneration) {
    debugUsageTelemetry('active_generation_cleared', {
      reason,
      generateIntentId: USAGE_CTX.activeGeneration.generateIntentId,
    });
  }
  USAGE_CTX.activeGeneration = null;
}

function stopGeneratedAssetDetection() {
  if (USAGE_CTX.assetScanTimer) {
    clearInterval(USAGE_CTX.assetScanTimer);
    USAGE_CTX.assetScanTimer = null;
  }
  if (USAGE_CTX.assetScanObserver) {
    try {
      USAGE_CTX.assetScanObserver.disconnect();
    } catch {}
    USAGE_CTX.assetScanObserver = null;
  }
  USAGE_CTX.assetScanSnapshot = null;
  USAGE_CTX.assetScanStartedAt = 0;
  USAGE_CTX.pendingMediaSourcePayloads = [];
  clearActiveGeneration('asset_detection_stopped');
}

function reportGeneratedAssetCandidates(snapshot, assets) {
  if (!snapshot || !assets.length) return;
  if (!snapshotMatchesActiveGeneration(snapshot)) {
    debugUsageTelemetry('generated_assets_skipped_inactive_generation', {
      snapshotIntentId: `${snapshot?.metadata?.generateIntentId || snapshot?.externalEventId || ''}`.trim(),
      activeIntentId: `${USAGE_CTX.activeGeneration?.generateIntentId || ''}`.trim(),
      assetCount: assets.length,
    });
    return;
  }
  const ownedAssets = assets.filter((asset) => assetStartedAfterActiveGeneration(asset));
  if (!ownedAssets.length) {
    debugUsageTelemetry('generated_assets_skipped_before_generation', {
      generateIntentId: USAGE_CTX.activeGeneration?.generateIntentId,
      assetCount: assets.length,
    });
    return;
  }
  const captureSource = ownedAssets.some((asset) => /^mediasource/i.test(`${asset?.source || ''}`))
    ? 'mediasource'
    : 'dom';
  const existingAssets = Array.isArray(snapshot.metadata?.mediaAssets) ? snapshot.metadata.mediaAssets : [];
  const hasExistingMediaSource = existingAssets.some(isMediaSourceCapturedAsset);
  if (captureSource === 'dom' && hasExistingMediaSource) {
    debugUsageTelemetry('dom_assets_skipped_after_mediasource', {
      generateIntentId: USAGE_CTX.activeGeneration?.generateIntentId,
      assetCount: ownedAssets.length,
    });
    return;
  }
  const mergeBaseAssets = captureSource === 'mediasource'
    ? existingAssets.filter((asset) => !shouldDropDomPreviewAfterMediaSource(asset))
    : existingAssets;
  const mergedAssets = mergeCapturedMediaAssets(mergeBaseAssets, ownedAssets);
  if (!mergedAssets.length) return;
  markActiveGenerationOwnedOutput(ownedAssets.length, captureSource === 'mediasource' ? 'owned_output_mediasource_enrichment' : 'dom_new_output_fallback');
  const ownershipStrategy = captureSource === 'mediasource' ? 'owned_output_mediasource_enrichment' : '';
  attachActiveGenerationOwnership(snapshot, ownershipStrategy);
  snapshot.metadata = {
    ...(snapshot.metadata || {}),
    ...buildGenerationOwnershipMetadata(USAGE_CTX.activeGeneration, ownershipStrategy),
    assetCapture: {
      source: captureSource,
      assetCount: mergedAssets.length,
      capturedAt: Date.now(),
    },
    mediaAssets: mergedAssets,
    mediaAssetCount: mergedAssets.length,
    lifecycleEvent: {
      stage: 'asset_captured',
      source: captureSource === 'mediasource' ? 'mediasource_capture' : 'dom_asset_scan',
      transport: captureSource,
      capturedAt: Date.now(),
    },
  };

  reportKlingUsage({
    ...snapshot,
    status: snapshot.status || 'submitted',
    creditsBurned: snapshot.creditsBurned ?? null,
    metadata: snapshot.metadata,
  })
    .then(() => debugUsageTelemetry('generated_assets_captured', {
      eventId: snapshot.eventId,
      assetCount: mergedAssets.length,
    }))
    .catch((error) => {
      if (error?.contextInvalidated || isExtensionContextInvalidatedError(error?.message)) return;
      console.warn('[RMW Kling] Generated asset capture report failed', error);
    });
  if (captureSource !== 'mediasource') {
    flushPendingMediaSourcePayloads();
  }
}

function startGeneratedAssetDetection(snapshot) {
  if (!snapshot) return;
  stopGeneratedAssetDetection();
  const scanStartedAt = Date.now();
  const activeGeneration = buildActiveGenerationFromSnapshot(snapshot, scanStartedAt);
  if (!activeGeneration) {
    debugUsageTelemetry('asset_detection_skipped_without_active_generation', {
      promptCaptured: Boolean(normalizePromptCaptureValue(snapshot.promptText)),
      generateIntentId: `${snapshot?.metadata?.generateIntentId || snapshot?.externalEventId || ''}`.trim(),
    });
    return;
  }
  USAGE_CTX.activeGeneration = activeGeneration;
  const generationMode = `${snapshot.metadata?.generationMode || ''}`.trim().toLowerCase();
  const outputFeedSnapshot = collectVisibleGeneratedMediaAssets(generationMode);
  USAGE_CTX.generatedAssetUrls = new Set(
    outputFeedSnapshot
      .map((asset) => asset.url)
      .filter(Boolean)
  );
  activeGeneration.outputFeedSnapshotCount = outputFeedSnapshot.length;
  USAGE_CTX.assetScanStartedAt = scanStartedAt;
  USAGE_CTX.assetScanSnapshot = snapshot;
  snapshot.metadata = {
    ...(snapshot.metadata || {}),
    internalGenerationId: activeGeneration.internalGenerationId,
    outputFeedSnapshotCount: outputFeedSnapshot.length,
    ownershipStrategy: 'dom_new_output_fallback',
    ownershipConfidence: 0.9,
  };

  const scan = () => {
    const scanStartedAt = USAGE_CTX.assetScanStartedAt;
    if (!scanStartedAt || Date.now() - scanStartedAt > GENERATED_ASSET_SCAN_MAX_MS || !isActiveGenerationValid()) {
      stopGeneratedAssetDetection();
      return;
    }
    const candidates = collectVisibleGeneratedMediaAssets(generationMode)
      .filter((asset) => {
        if (!asset.url || USAGE_CTX.generatedAssetUrls.has(asset.url)) return false;
        USAGE_CTX.generatedAssetUrls.add(asset.url);
        return true;
      });
    if (candidates.length) {
      reportGeneratedAssetCandidates(USAGE_CTX.assetScanSnapshot, candidates);
    }
  };

  USAGE_CTX.assetScanTimer = window.setInterval(scan, GENERATED_ASSET_SCAN_MS);
  if (typeof MutationObserver === 'function') {
    let observerScanTimer = null;
    USAGE_CTX.assetScanObserver = new MutationObserver(() => {
      if (observerScanTimer) window.clearTimeout(observerScanTimer);
      observerScanTimer = window.setTimeout(scan, 250);
    });
    try {
      USAGE_CTX.assetScanObserver.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['src', 'srcset', 'style', 'poster', 'data-src', 'data-original', 'data-url'],
      });
    } catch {}
  }
  window.setTimeout(scan, 1500);
  window.setTimeout(scan, 8000);
  window.setTimeout(scan, 30000);
  window.setTimeout(scan, 90000);
}

function readVisibleCreditBalance() {
  const creditCandidates = [];

  for (const el of collectUniqueElements(Array.from(document.querySelectorAll('div,span,button,strong,b')))) {
    if (!isVisible(el)) continue;
    if (el.closest?.('#rmw-kling-badge')) continue;

    const text = `${el.textContent || ''}`.trim();
    if (!text || text.length > 32) continue;
    if (text.includes('-')) continue;

    const parsedValue = parseIntegerCreditNumber(text);
    if (parsedValue == null) continue;
    if (parsedValue < 0 || parsedValue > MAX_REASONABLE_KLING_CREDIT_BALANCE) continue;

    const normalizedText = normalizeSpace(text);
    const rect = el.getBoundingClientRect();
    const contextText = normalizeSpace([
      el.parentElement?.innerText || '',
      el.parentElement?.parentElement?.innerText || '',
      el.closest?.('button')?.innerText || '',
    ].join(' '));
    const isCompactDisplay = /[km]\s*$/i.test(text);

    if (
      /\b\d+\s*[:x]\s*\d+\b/.test(normalizedText)
      || /\b(360p|540p|720p|1080p|4k|2k|hd)\b/i.test(normalizedText)
      || /\b(image|video|motion|avatar|seconds?|mins?|styles?)\b/i.test(contextText)
      || /\b(consumed credits|purchase|obtained|transfer out)\b/i.test(contextText)
    ) {
      continue;
    }

    let score = 0;
    if (/^\d+(?:\.\d+)?\s*[km]?$/i.test(text)) score += 6;
    if (isCompactDisplay) score += 3;
    if (!isCompactDisplay && /^\d+(?:\.\d+)?$/.test(text)) score += 7;
    if (parsedValue >= 1000) score += 4;
    if (rect.left < 220) score += 3;
    if (rect.top > window.innerHeight * 0.7) score += 4;
    if (rect.width < 120) score += 1;
    if (contextText.includes('upgrade')) score += 2;
    if (contextText.includes('subscription')) score += 2;
    if (contextText.includes('api')) score += 1;
    if (contextText.includes('credit details')) score += 4;
    if (contextText.includes('remaining credits')) score += 24;
    if (contextText.includes('membership credits')) score += 10;
    if (contextText.includes('top-up credits')) score += 8;
    if (contextText.includes('bonus credits')) score += 8;

    creditCandidates.push({
      el,
      parsedValue,
      score,
    });
  }

  creditCandidates.sort((left, right) => {
    if (right.score !== left.score) return right.score - left.score;
    if (right.parsedValue !== left.parsedValue) return right.parsedValue - left.parsedValue;
    return 0;
  });

  if (creditCandidates.length) {
    return creditCandidates[0].parsedValue;
  }

  return null;
}

function findVisibleGenerateActionButton() {
  const candidates = collectUniqueElements(Array.from(document.querySelectorAll(ACTION_SELECTORS.join(','))));
  let bestCandidate = null;
  let bestScore = -1;

  for (const candidate of candidates) {
    if (!candidate || !isVisible(candidate) || !isEnabled(candidate)) continue;
    const text = readGenerateButtonLabel(candidate);
    if (!/(^|\s)generate($|\s)/i.test(text)) continue;
    if (/create\s+in\s+omni/i.test(text)) continue;
    const expectedCredits = readExpectedCreditsFromGenerateButton(candidate);
    if (!Number.isInteger(expectedCredits) || expectedCredits <= 0) continue;

    const rect = candidate.getBoundingClientRect();
    let score = expectedCredits;
    if (rect.top > window.innerHeight * 0.45) score += 1000;
    if (candidate.matches?.('button,[role="button"],input[type="button"],input[type="submit"]')) score += 100;
    if (rect.width >= 120) score += 10;

    if (score > bestScore) {
      bestScore = score;
      bestCandidate = candidate;
    }
  }

  return bestCandidate;
}

function readVisibleExpectedGenerateCredits() {
  const generateButton = findVisibleGenerateActionButton();
  const buttonCredits = readExpectedCreditsFromGenerateButton(generateButton);
  if (Number.isInteger(buttonCredits) && buttonCredits > 0 && buttonCredits <= MAX_REASONABLE_KLING_CREDIT_BURN) {
    return buttonCredits;
  }
  return null;
}

function showCurrentCreditsDebug(reason = '') {
  const credits = readVisibleCreditBalance();
  const suffix = reason ? ` (${reason})` : '';
  setStatus(
    credits != null
      ? `Current credits: ${credits}${suffix}`
      : `Current credits: not found${suffix}`,
    { hideAfterMs: 4000 }
  );
}

function readCredentialUsageMetadata() {
  const credentialId = Number(CTX.credential?.id || 0);
  const linkedCredentialId = Number(CTX.credential?.linkedCredentialId || 0);
  return {
    credentialId: credentialId > 0 ? credentialId : null,
    linkedCredentialId: linkedCredentialId > 0 ? linkedCredentialId : null,
    credentialLabel: `${CTX.credential?.loginIdentifier || ''}`.trim() || null,
  };
}

function announceKlingGenerateIntent(snapshot) {
  try {
    window.postMessage({
      source: 'rmw-kling-content-telemetry',
      type: 'KLING_GENERATE_INTENT',
      payload: {
        internalGenerationId: snapshot?.metadata?.generateIntentId || snapshot?.externalEventId || '',
        prompt: snapshot?.promptText || '',
        expectedCredits: snapshot?.expectedCredits ?? null,
        modelLabel: snapshot?.modelLabel || '',
        generationMode: snapshot?.metadata?.generationMode || '',
        fingerprint: snapshot?.fingerprint || '',
        capturedAt: Date.now(),
      },
    }, location.origin);
  } catch {}
}

function makeUsageSessionId(prefix) {
  try {
    if (crypto?.randomUUID) return `${prefix}_${crypto.randomUUID()}`;
  } catch {}
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function initUsageIdentity() {
  if (!USAGE_CTX.browserSessionId) {
    try {
      let browserSessionId = localStorage.getItem(USAGE_BROWSER_SESSION_KEY);
      if (!browserSessionId) {
        browserSessionId = makeUsageSessionId('ksess');
        localStorage.setItem(USAGE_BROWSER_SESSION_KEY, browserSessionId);
      }
      USAGE_CTX.browserSessionId = browserSessionId;
    } catch {
      USAGE_CTX.browserSessionId = makeUsageSessionId('ksess');
    }
  }

  if (!USAGE_CTX.tabSessionId) {
    try {
      let tabSessionId = sessionStorage.getItem(USAGE_TAB_SESSION_KEY);
      if (!tabSessionId) {
        tabSessionId = makeUsageSessionId('ktab');
        sessionStorage.setItem(USAGE_TAB_SESSION_KEY, tabSessionId);
      }
      USAGE_CTX.tabSessionId = tabSessionId;
    } catch {
      USAGE_CTX.tabSessionId = makeUsageSessionId('ktab');
    }
  }

  if (!USAGE_CTX.extensionTabId) {
    msg({ type: 'TOOL_HUB_GET_TAB_ID' })
      .then((response) => {
        const tabId = Number(response?.tabId || 0);
        if (tabId > 0) USAGE_CTX.extensionTabId = tabId;
      })
      .catch(() => {});
  }
}

function debugUsageTelemetry(label, payload = {}) {
  try {
    if (!window.__RMW_DEBUG_USAGE) return;
    console.debug('[RMW Kling Usage]', label, payload);
  } catch {}
}

function getUsageIdentityMetadata() {
  initUsageIdentity();
  return {
    browserSessionId: USAGE_CTX.browserSessionId || null,
    tabSessionId: USAGE_CTX.tabSessionId || null,
    extensionTabId: Number(USAGE_CTX.extensionTabId || 0) || null,
  };
}

function buildNetworkUsageDedupeKey(payload) {
  const creditsUsed = Number(payload?.creditsUsed);
  const visibleExpectedCredits = readVisibleExpectedGenerateCredits();
  const status = normalizeNetworkUsageStatus(payload?.status, Number.isFinite(creditsUsed) ? creditsUsed : null);
  const canUseExpectedFallback = status === 'settled'
    && (!Number.isInteger(creditsUsed) || creditsUsed <= 0)
    && Number.isInteger(visibleExpectedCredits)
    && visibleExpectedCredits > 0
    && visibleExpectedCredits <= MAX_EXPECTED_LOCK_AUTO_BURN
    && Date.now() - Number(USAGE_CTX.lastGenerateAt || 0) < 30000;
  if (canUseExpectedFallback && (USAGE_CTX.lastGenerateIntentId || USAGE_CTX.lastGenerateKey)) {
    return [
      'network-expected-fallback',
      USAGE_CTX.lastGenerateIntentId || USAGE_CTX.lastGenerateKey,
      status,
      visibleExpectedCredits,
    ].join('|');
  }
  return [
    payload?.klingTaskId,
    payload?.externalEventId,
    payload?.generationId,
    payload?.requestId,
    payload?.fingerprint,
    payload?.status,
    payload?.creditsUsed,
  ].filter(Boolean).join('|');
}

function normalizeKlingTradeCredits(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return Number.isInteger(parsed) && parsed <= MAX_REASONABLE_KLING_CREDIT_BURN
    ? parsed
    : null;
}

function isKnownKlingTaskId(taskId) {
  const normalizedId = normalizeKlingTaskId(taskId);
  if (!normalizedId) return false;
  if (USAGE_CTX.activeGenerationIds.has(normalizedId)) return true;
  return getActiveGenerationTaskIds().includes(normalizedId);
}

function buildTradeHistoryUsageSnapshot(row = {}, payload = {}) {
  const taskId = normalizeKlingTaskId(row.taskId);
  const creditsBurned = normalizeKlingTradeCredits(row.creditsBurned);
  if (!taskId || creditsBurned == null) return null;
  const createTime = Number(row.createTime || 0) || null;
  const capturedAt = Number(payload.capturedAt || Date.now());
  const tradeProfile = CREDIT_SOURCE_PROFILES.trade;
  const credentialUsageMetadata = readCredentialUsageMetadata();
  const usageIdentityMetadata = getUsageIdentityMetadata();
  const eventDate = createTime ? buildLocalDateValue(new Date(createTime)) : buildLocalDateValue(new Date(capturedAt));
  const amount = Number(row.amount || 0) || null;

  return {
    eventType: 'network_generation',
    eventDate,
    status: 'settled',
    promptText: '',
    modelLabel: '',
    durationLabel: '',
    resolutionLabel: '',
    expectedCredits: null,
    creditsBefore: null,
    creditsAfter: null,
    creditsBurned,
    externalEventId: `trade_${taskId}_${createTime || capturedAt}`,
    generationId: taskId,
    requestId: '',
    fingerprint: `trade_${taskId}_${createTime || capturedAt}`,
    source: tradeProfile.source,
    schemaVersion: Number(payload.schemaVersion || 1) || 1,
    confidence: tradeProfile.confidence,
    metadata: {
      stage: 'settled',
      source: tradeProfile.source,
      capture: 'trade_history',
      creditSource: tradeProfile.source,
      creditSourcePriority: tradeProfile.priority,
      confidenceLevel: tradeProfile.confidence,
      klingTaskId: taskId,
      discoveredTaskIds: [taskId],
      tradeHistory: {
        taskId,
        amount,
        creditsBurned,
        createTime,
        taskType: `${row.taskType || ''}`.slice(0, 160),
        capturedAt,
        networkUrl: `${payload.url || ''}`.slice(0, 1000),
        networkMethod: `${payload.method || ''}`.slice(0, 16),
        networkTransport: `${payload.transport || payload.source || ''}`.slice(0, 80),
        httpStatus: Number(payload.httpStatus || 0) || null,
        ok: Boolean(payload.ok),
      },
      lifecycleEvent: {
        stage: 'settled',
        source: tradeProfile.source,
        transport: `${payload.transport || payload.source || ''}`.slice(0, 80),
        capturedAt,
        creditsUsed: creditsBurned,
      },
      credentialId: credentialUsageMetadata.credentialId,
      linkedCredentialId: credentialUsageMetadata.linkedCredentialId,
      credentialLabel: credentialUsageMetadata.credentialLabel,
      ...usageIdentityMetadata,
      klingAccountLabel: readTrackedKlingAccountLabel(),
    },
  };
}

function setupUsageBroadcastChannel() {
  if (USAGE_CTX.broadcastChannel || typeof BroadcastChannel !== 'function') return;
  try {
    const channel = new BroadcastChannel(USAGE_BROADCAST_CHANNEL);
    channel.addEventListener('message', (event) => {
      const data = event?.data || {};
      if (data.type !== 'network-event-claimed' || !data.key) return;
      if (data.tabSessionId && data.tabSessionId === USAGE_CTX.tabSessionId) return;
      USAGE_CTX.networkEventKeys.set(data.key, Number(data.claimedAt || Date.now()));
      pruneNetworkEventKeys();
    });
    USAGE_CTX.broadcastChannel = channel;
  } catch {
    USAGE_CTX.broadcastChannel = null;
  }
}

function broadcastNetworkUsageClaim(key) {
  if (!key) return;
  setupUsageBroadcastChannel();
  try {
    USAGE_CTX.broadcastChannel?.postMessage({
      type: 'network-event-claimed',
      key,
      browserSessionId: USAGE_CTX.browserSessionId,
      tabSessionId: USAGE_CTX.tabSessionId,
      extensionTabId: Number(USAGE_CTX.extensionTabId || 0) || null,
      claimedAt: Date.now(),
    });
  } catch {}
}

function buildGenerateUsageSnapshot(generateButton) {
  const buttonLabel = readGenerateButtonLabel(generateButton);
  const controlContext = readGenerateControlContext(generateButton);
  const promptCapture = readPromptCaptureSnapshot();
  const generationMode = controlContext.generationMode || readGenerationMode(controlContext.scopeText);
  const expectedCredits = readExpectedCreditsFromGenerateButton(generateButton);
  const latestWalletBalance = USAGE_CTX.latestWalletBalance;
  const walletBalanceIsRecent = latestWalletBalance?.capturedAt && Date.now() - latestWalletBalance.capturedAt < 60000;
  const creditsBefore = readVisibleCreditBalance() ?? (walletBalanceIsRecent ? latestWalletBalance.balance : null);
  const klingAccountLabel = readTrackedKlingAccountLabel();
  const credentialUsageMetadata = readCredentialUsageMetadata();
  const usageIdentityMetadata = getUsageIdentityMetadata();
  const modelLabel = (
    controlContext.modelLabel
    && !(generationMode === 'video' && /motion\s*control/i.test(controlContext.modelLabel))
      ? controlContext.modelLabel
      : readSelectedModelLabel(generationMode, controlContext.scopeText)
  );
  return {
    eventType: 'generate_click',
    eventDate: buildLocalDateValue(),
    status: 'captured',
    promptText: promptCapture.text || readPromptText(),
    modelLabel,
    durationLabel: controlContext.durationLabel,
    resolutionLabel: controlContext.resolutionLabel,
    expectedCredits,
    creditsBefore,
    source: 'dom_balance_fallback',
    schemaVersion: 1,
    confidence: 0.35,
    metadata: {
      actionLabel: buttonLabel,
      aspectRatioLabel: controlContext.aspectRatioLabel,
      outputCount: controlContext.outputCount,
      nativeAudio: controlContext.nativeAudioEnabled,
      multiShot: controlContext.multiShotEnabled,
      generationMode,
      promptCapture,
      generationSettings: buildGenerationSettingsMetadata({
        modelLabel,
        generationMode,
        durationLabel: controlContext.durationLabel,
        resolutionLabel: controlContext.resolutionLabel,
        aspectRatioLabel: controlContext.aspectRatioLabel,
        outputCount: controlContext.outputCount,
        nativeAudio: controlContext.nativeAudioEnabled,
        multiShot: controlContext.multiShotEnabled,
        expectedCredits,
        actionLabel: buttonLabel,
      }),
      pathname: location.pathname,
      controlContext: controlContext.scopeText,
      currentCredits: creditsBefore,
      creditsBeforeSource: creditsBefore === latestWalletBalance?.balance && walletBalanceIsRecent ? 'wallet_api' : 'visible_dom',
      klingAccountLabel,
      credentialId: credentialUsageMetadata.credentialId,
      linkedCredentialId: credentialUsageMetadata.linkedCredentialId,
      credentialLabel: credentialUsageMetadata.credentialLabel,
      ...usageIdentityMetadata,
      source: 'dom_balance_fallback',
      confidence: 0.35,
    },
  };
}

async function reportKlingUsage(snapshot) {
  const usageTicket = loadStoredUsageTicket();
  const extensionTicket = loadStoredTicket();

  const response = await msg({
    type: 'TOOL_HUB_REPORT_USAGE_EVENT',
    eventId: snapshot.eventId,
    credentialId: Number(snapshot.metadata?.credentialId || CTX.credential?.id || 0) || null,
    toolSlug: TOOL_SLUG,
    hostname: location.hostname,
    pageUrl: location.href,
    eventDate: snapshot.eventDate,
    usageTicket,
    extensionTicket,
    eventType: snapshot.eventType,
    status: snapshot.status,
    modelLabel: snapshot.modelLabel,
    durationLabel: snapshot.durationLabel,
    resolutionLabel: snapshot.resolutionLabel,
    promptText: snapshot.promptText,
    expectedCredits: snapshot.expectedCredits,
    creditsBefore: snapshot.creditsBefore,
    creditsAfter: snapshot.creditsAfter,
    creditsBurned: snapshot.creditsBurned,
    externalEventId: snapshot.externalEventId,
    generationId: snapshot.generationId,
    requestId: snapshot.requestId,
    fingerprint: snapshot.fingerprint,
    source: snapshot.source,
    schemaVersion: snapshot.schemaVersion,
    confidence: snapshot.confidence,
    metadata: snapshot.metadata,
  });

  if (response?.contextInvalidated) {
    throw buildExtensionContextInvalidatedError(response.error);
  }

  if (!response?.ok) {
    throw new Error(response?.error || 'Usage event request failed');
  }

  const eventId = Number(response?.event?.id || 0);
  if (eventId > 0) {
    snapshot.eventId = eventId;
  }

  return response;
}

function pruneNetworkEventKeys(now = Date.now()) {
  for (const [key, capturedAt] of USAGE_CTX.networkEventKeys.entries()) {
    if (now - capturedAt > 10 * 60 * 1000) {
      USAGE_CTX.networkEventKeys.delete(key);
    }
  }
  for (const [key, capturedAt] of USAGE_CTX.activeGenerationIds.entries()) {
    if (now - capturedAt > 30 * 60 * 1000) {
      USAGE_CTX.activeGenerationIds.delete(key);
    }
  }
}

function pruneDomSettlementKeys(now = Date.now()) {
  for (const [key, capturedAt] of USAGE_CTX.domSettlementKeys.entries()) {
    if (now - capturedAt > 2 * 60 * 1000) {
      USAGE_CTX.domSettlementKeys.delete(key);
    }
  }
}

function normalizeNetworkUsageStatus(value, creditsUsed) {
  const normalized = `${value || ''}`.trim().toLowerCase();
  if (/(fail|error|cancel|reject)/.test(normalized)) return 'failed';
  if (/(complete|success|finish|done|settle)/.test(normalized)) return 'settled';
  if (creditsUsed != null) return 'settled';
  if (/(process|running|render|start|progress)/.test(normalized)) return 'processing';
  if (/(queue|wait|pending)/.test(normalized)) return 'queued';
  if (/(submit|create|init|received)/.test(normalized)) return 'submitted';
  return 'submitted';
}

function normalizeNetworkGenerationMode(value) {
  const normalized = `${value || ''}`.trim().toLowerCase();
  if (!normalized) return '';
  if (normalized.includes('mnu_img') || normalized.includes('image')) return 'image';
  if (normalized.includes('mnu_video') || normalized.includes('video')) return 'video';
  if (normalized.includes('avatar')) return 'avatar';
  if (normalized.includes('motion')) return 'motion-control';
  return normalized;
}

function rememberActiveNetworkGeneration(payload) {
  const now = Date.now();
  const hasSubmitPrompt = Boolean(normalizePromptCaptureValue(payload?.promptText));
  if (!hasSubmitPrompt) return;
  for (const id of collectKlingTaskIdsFromPayload(payload)) {
    const normalizedId = normalizeKlingTaskId(id);
    if (normalizedId) USAGE_CTX.activeGenerationIds.set(normalizedId, now);
  }
}

function isActiveNetworkGeneration(payload) {
  for (const id of collectKlingTaskIdsFromPayload(payload)) {
    const normalizedId = normalizeKlingTaskId(id);
    if (normalizedId && USAGE_CTX.activeGenerationIds.has(normalizedId)) return true;
  }
  return false;
}

function buildNetworkUsageSnapshot(networkPayload) {
  const credentialUsageMetadata = readCredentialUsageMetadata();
  const usageIdentityMetadata = getUsageIdentityMetadata();
  const creditsUsed = Number(networkPayload?.creditsUsed);
  const hasCreditsUsed = Number.isFinite(creditsUsed);
  const networkExpectedCredits = Number(networkPayload?.expectedCredits);
  const visibleExpectedCredits = readVisibleExpectedGenerateCredits();
  const expectedCredits = Number.isFinite(networkExpectedCredits) && networkExpectedCredits > 0
    ? networkExpectedCredits
    : (Number.isInteger(visibleExpectedCredits) ? visibleExpectedCredits : null);
  const hasExpectedCredits = Number.isInteger(expectedCredits) && expectedCredits > 0;
  const capturedAt = Number(networkPayload?.capturedAt || Date.now());
  const source = `${networkPayload?.source || 'network_response'}`.trim() || 'network_response';
  const status = normalizeNetworkUsageStatus(networkPayload?.status, hasCreditsUsed ? creditsUsed : null);
  const isCompleted = Boolean(networkPayload?.isCompleted) || status === 'settled';
  const isReasonableCreditBurn = hasCreditsUsed
    && Number.isInteger(creditsUsed)
    && creditsUsed > 0
    && creditsUsed <= MAX_REASONABLE_KLING_CREDIT_BURN;
  const canUseExpectedNetworkFallback = !isReasonableCreditBurn
    && isCompleted
    && Number.isInteger(expectedCredits)
    && expectedCredits > 0
    && expectedCredits <= MAX_EXPECTED_LOCK_AUTO_BURN
    && USAGE_CTX.pendingReportTimers.size <= 1
    && Date.now() - Number(USAGE_CTX.lastGenerateAt || 0) < 30000;
  const creditsBurned = isReasonableCreditBurn
    ? Math.max(0, creditsUsed)
    : (canUseExpectedNetworkFallback ? expectedCredits : null);
  const generationMode = normalizeNetworkGenerationMode(networkPayload?.generationMode) || inferGenerationModeFromText(document.body?.innerText || '');
  const generationId = `${networkPayload?.generationId || ''}`.trim();
  const requestId = `${networkPayload?.requestId || ''}`.trim();
  const klingTaskId = normalizeKlingTaskId(networkPayload?.klingTaskId) || generationId || requestId;
  const fingerprint = `${networkPayload?.fingerprint || ''}`.trim();
  const networkFallbackDedupeKey = canUseExpectedNetworkFallback && (USAGE_CTX.lastGenerateIntentId || USAGE_CTX.lastGenerateKey)
    ? [
      'network-expected-fallback',
      USAGE_CTX.lastGenerateIntentId || USAGE_CTX.lastGenerateKey,
      status,
      expectedCredits,
    ].join('|')
    : '';
  const externalEventId = `${networkFallbackDedupeKey || networkPayload?.externalEventId || generationId || requestId || fingerprint || ''}`.trim();
  const requestPreview = `${networkPayload?.requestPreview || ''}`.slice(0, 1500);
  const responsePreview = `${networkPayload?.responsePreview || ''}`.slice(0, 3000);
  const promptCapture = readPromptCaptureSnapshot();
  const activeIntentIsRecent = Date.now() - Number(USAGE_CTX.lastGenerateAt || 0) < 5 * 60 * 1000;
  const activeIntentPrompt = activeIntentIsRecent
    ? normalizePromptCaptureValue(USAGE_CTX.assetScanSnapshot?.promptText)
    : '';
  const networkPromptText = normalizePromptCaptureValue(networkPayload?.promptText)
    || activeIntentPrompt;
  const mediaAssets = normalizeCapturedMediaAssets(networkPayload?.mediaAssets, networkPayload?.source || 'network');

  return {
    eventType: 'network_generation',
    eventDate: buildLocalDateValue(new Date(capturedAt)),
    status,
    promptText: networkPromptText,
    modelLabel: `${networkPayload?.modelLabel || ''}`.trim() || readSelectedModelLabel(),
    durationLabel: `${networkPayload?.durationLabel || ''}`.trim(),
    resolutionLabel: `${networkPayload?.resolutionLabel || ''}`.trim(),
    expectedCredits: hasExpectedCredits ? expectedCredits : null,
    creditsBefore: null,
    creditsAfter: null,
    creditsBurned,
    externalEventId,
    generationId,
    requestId,
    fingerprint,
    source: canUseExpectedNetworkFallback ? CREDIT_SOURCE_PROFILES.expected.source : source,
    schemaVersion: Number(networkPayload?.schemaVersion || 1) || 1,
    confidence: isReasonableCreditBurn
      ? 0.95
      : (canUseExpectedNetworkFallback ? CREDIT_SOURCE_PROFILES.expected.confidence : (isCompleted && (generationId || requestId) ? 0.95 : 0.8)),
    metadata: {
      stage: status,
      source: canUseExpectedNetworkFallback ? CREDIT_SOURCE_PROFILES.expected.source : source,
      capture: 'network',
      networkUrl: `${networkPayload?.url || ''}`.slice(0, 1000),
      networkMethod: `${networkPayload?.method || ''}`.slice(0, 16),
      networkTransport: `${networkPayload?.transport || source || ''}`.slice(0, 80),
      httpStatus: Number(networkPayload?.httpStatus || 0) || null,
      ok: Boolean(networkPayload?.ok),
      isCompleted,
      isReasonableCreditBurn,
      usedExpectedCreditFallback: canUseExpectedNetworkFallback,
      networkFallbackDedupeKey,
      creditSource: canUseExpectedNetworkFallback ? CREDIT_SOURCE_PROFILES.expected.source : source,
      creditSourcePriority: canUseExpectedNetworkFallback ? CREDIT_SOURCE_PROFILES.expected.priority : 90,
      confidenceLevel: isReasonableCreditBurn ? 0.95 : (canUseExpectedNetworkFallback ? CREDIT_SOURCE_PROFILES.expected.confidence : 0.8),
      generationMode,
      rawGenerationMode: `${networkPayload?.generationMode || ''}`.trim(),
      assetCapture: {
        source: 'network',
        assetCount: mediaAssets.length,
        capturedAt,
      },
      mediaAssets,
      mediaAssetCount: mediaAssets.length,
      outputCount: Number(networkPayload?.outputCount || 0) || null,
      nativeAudio: Boolean(networkPayload?.nativeAudioEnabled),
      multiShot: Boolean(networkPayload?.multiShotEnabled),
      expectedCredits: hasExpectedCredits ? expectedCredits : null,
      promptCapture: {
        ...promptCapture,
        source: normalizePromptCaptureValue(networkPayload?.promptText)
          ? 'network_request'
          : (activeIntentPrompt ? 'generate_intent' : promptCapture.source),
        candidateCount: promptCapture.candidateCount,
      },
      generationSettings: buildGenerationSettingsMetadata({
        modelLabel: `${networkPayload?.modelLabel || ''}`.trim() || readSelectedModelLabel(),
        generationMode,
        durationLabel: `${networkPayload?.durationLabel || ''}`.trim(),
        resolutionLabel: `${networkPayload?.resolutionLabel || ''}`.trim(),
        outputCount: Number(networkPayload?.outputCount || 0) || null,
        nativeAudio: Boolean(networkPayload?.nativeAudioEnabled),
        multiShot: Boolean(networkPayload?.multiShotEnabled),
        expectedCredits: hasExpectedCredits ? expectedCredits : null,
      }),
      requestPreview,
      responsePreview,
      klingTaskId,
      identifierCandidates: Array.isArray(networkPayload?.identifierCandidates)
        ? networkPayload.identifierCandidates.slice(0, 12)
        : [],
      identifierChannel: `${networkPayload?.identifierChannel || networkPayload?.transport || source || ''}`.slice(0, 120),
      identifierSource: `${networkPayload?.identifierSource || ''}`.slice(0, 120),
      identifierKind: `${networkPayload?.identifierKind || ''}`.slice(0, 80),
      ownershipConfidence: Number(networkPayload?.ownershipConfidence || 0) || null,
      generationId,
      requestId,
      fingerprint,
      externalEventId,
      lifecycleEvent: {
        stage: status,
        source: canUseExpectedNetworkFallback ? CREDIT_SOURCE_PROFILES.expected.source : source,
        transport: `${networkPayload?.transport || source || ''}`.slice(0, 80),
        capturedAt,
        creditsUsed: creditsBurned,
      },
      credentialId: credentialUsageMetadata.credentialId,
      linkedCredentialId: credentialUsageMetadata.linkedCredentialId,
      credentialLabel: credentialUsageMetadata.credentialLabel,
      ...usageIdentityMetadata,
      klingAccountLabel: readTrackedKlingAccountLabel(),
    },
  };
}

function handleKlingNetworkUsageMessage(event) {
  if (event?.source !== window) return;
  if (event?.origin !== location.origin) return;
  if (event?.data?.source === 'rmw-kling-mediasource-capture') {
    if (event?.data?.type === 'KLING_MEDIASOURCE_VIDEO_COMPLETE') {
      const mediaSourcePayload = event.data.payload || {};
      queueOrProcessMediaSourcePayload(mediaSourcePayload);
    } else if (event?.data?.type === 'KLING_MEDIASOURCE_VIDEO_DROPPED') {
      debugUsageTelemetry('mediasource_video_dropped', {
        sessionId: `${event.data.payload?.sessionId || ''}`.slice(0, 120),
        reason: `${event.data.payload?.reason || ''}`.slice(0, 120),
        chunkCount: Number(event.data.payload?.chunkCount || 0) || null,
        totalBytes: Number(event.data.payload?.totalBytes || 0) || null,
      });
    } else if (event?.data?.type === 'KLING_MEDIASOURCE_SESSION_STARTED') {
      debugUsageTelemetry('mediasource_session_started', {
        sessionId: `${event.data.payload?.sessionId || ''}`.slice(0, 120),
        mimeType: `${event.data.payload?.mimeType || ''}`.slice(0, 200),
      });
    }
    return;
  }
  if (event?.data?.source !== 'rmw-kling-network-telemetry') return;
  if (event?.data?.type === 'KLING_GOOGLE_OAUTH_POPUP_BLOCKED') {
    recoverBlockedGoogleOauthPopup(event.data.payload || {});
    debugUsageTelemetry('google_oauth_popup_blocked_recovered', {
      url: `${event.data.payload?.url || ''}`.slice(0, 500),
      target: `${event.data.payload?.target || ''}`.slice(0, 120),
    });
    return;
  }
  if (event?.data?.type === 'KLING_BLOB_MEDIA_SOURCE') {
    rememberBlobSourceUrl(event.data.payload?.blobUrl, event.data.payload?.sourceUrl);
    debugUsageTelemetry('blob_media_source_captured', {
      sourceUrl: `${event.data.payload?.sourceUrl || ''}`.slice(0, 1000),
      assetType: event.data.payload?.assetType || '',
    });
    return;
  }
  if (event?.data?.type === 'KLING_WALLET_BALANCE') {
    const balance = Number(event.data.payload?.balance);
    if (Number.isInteger(balance) && balance >= 0 && balance <= MAX_REASONABLE_KLING_CREDIT_BALANCE) {
      USAGE_CTX.latestWalletBalance = {
        balance,
        capturedAt: Number(event.data.payload?.capturedAt || Date.now()),
        source: event.data.payload?.source || 'wallet_api',
        url: `${event.data.payload?.url || ''}`.slice(0, 1000),
      };
      debugUsageTelemetry('wallet_balance_captured', USAGE_CTX.latestWalletBalance);
    }
    return;
  }
  if (event?.data?.type === 'KLING_TRADE_HISTORY') {
    const payload = event.data.payload || {};
    const rows = Array.isArray(payload.rows) ? payload.rows.slice(0, 80) : [];
    const now = Date.now();
    const tradeMetrics = {
      tradeRowsSeen: rows.length,
      tradeRowsMatched: 0,
      tradeRowsSkippedUnknownTask: 0,
      tradeRowsDuplicate: 0,
      tradeRowsInvalid: 0,
      tradeRowsReconciled: 0,
    };
    pruneNetworkEventKeys(now);
    for (const row of rows) {
      const tradeTaskId = normalizeKlingTaskId(row?.taskId);
      if (!isKnownKlingTaskId(tradeTaskId)) {
        tradeMetrics.tradeRowsSkippedUnknownTask += 1;
        continue;
      }
      tradeMetrics.tradeRowsMatched += 1;
      const snapshot = buildTradeHistoryUsageSnapshot(row, payload);
      if (!snapshot) {
        tradeMetrics.tradeRowsInvalid += 1;
        continue;
      }
      const dedupeKey = [
        snapshot.source,
        snapshot.generationId,
        snapshot.creditsBurned,
        snapshot.metadata?.tradeHistory?.createTime || '',
      ].filter(Boolean).join('|');
      if (dedupeKey && USAGE_CTX.networkEventKeys.has(dedupeKey)) {
        tradeMetrics.tradeRowsDuplicate += 1;
        continue;
      }
      if (dedupeKey) {
        USAGE_CTX.networkEventKeys.set(dedupeKey, now);
        broadcastNetworkUsageClaim(dedupeKey);
      }
      if (snapshot.generationId) {
        USAGE_CTX.activeGenerationIds.set(snapshot.generationId, now);
      }
      tradeMetrics.tradeRowsReconciled += 1;
      reportKlingUsage(snapshot)
        .then((response) => {
          const eventId = Number(response?.event?.id || 0);
          debugUsageTelemetry('trade_history_reconciled', {
            eventId,
            taskId: snapshot.generationId,
            creditsBurned: snapshot.creditsBurned,
            source: snapshot.source,
          });
        })
        .catch((error) => {
          if (error?.contextInvalidated || isExtensionContextInvalidatedError(error?.message)) return;
          console.warn('[RMW Kling] Trade history reconciliation failed', error);
        });
    }
    debugUsageTelemetry('trade_history_metrics', {
      ...tradeMetrics,
      knownTaskIdCount: getActiveGenerationTaskIds().length + USAGE_CTX.activeGenerationIds.size,
      source: payload.source || '',
      httpStatus: Number(payload.httpStatus || 0) || null,
      capturedAt: Number(payload.capturedAt || now),
    });
    if (tradeMetrics.tradeRowsSkippedUnknownTask > 0) {
      debugUsageTelemetry('trade_history_skipped_unknown_task_id', {
        skippedCount: tradeMetrics.tradeRowsSkippedUnknownTask,
        rowCount: rows.length,
        knownTaskIdCount: getActiveGenerationTaskIds().length + USAGE_CTX.activeGenerationIds.size,
      });
    }
    return;
  }
  if (event?.data?.type !== 'KLING_NETWORK_USAGE') return;

  const payload = event.data.payload || {};
  const now = Date.now();
  const creditsUsed = Number(payload?.creditsUsed);
  const hasReasonableCreditBurn = Number.isFinite(creditsUsed)
    && Number.isInteger(creditsUsed)
    && creditsUsed > 0
    && creditsUsed <= MAX_REASONABLE_KLING_CREDIT_BURN;
  const mediaAssetCount = Array.isArray(payload?.mediaAssets) ? payload.mediaAssets.length : 0;
  const hasRecentGenerateIntent = now - Number(USAGE_CTX.lastGenerateAt || 0) < 30000;
  const hasStableNetworkId = Boolean(payload?.klingTaskId || payload?.generationId || payload?.requestId);
  const associationCandidateMatch = payloadMatchesActiveGenerationTaskId(payload);
  const hasNetworkSubmitPrompt = Boolean(normalizePromptCaptureValue(payload?.promptText));
  const canAssociateTaskId = hasRecentGenerateIntent
    && isActiveGenerationValid()
    && (associationCandidateMatch !== false || !getActiveGenerationTaskIds().length || hasNetworkSubmitPrompt);
  const associatedTaskId = canAssociateTaskId
    ? associateKlingTaskIdWithActiveGeneration(payload)
    : false;
  if (!payload?.status && !payload?.isCompleted && !hasReasonableCreditBurn && !mediaAssetCount) return;
  if (!hasStableNetworkId && !hasRecentGenerateIntent) return;
  if (mediaAssetCount > 0) {
    const taskIdMatch = payloadMatchesActiveGenerationTaskId(payload);
    if (taskIdMatch === false) {
      debugUsageTelemetry('network_media_skipped_task_id_mismatch', {
        klingTaskId: payload.klingTaskId,
        generationId: payload.generationId,
        requestId: payload.requestId,
        activeTaskIds: getActiveGenerationTaskIds(),
        mediaAssetCount,
      });
      return;
    }
    const capturedAt = Number(payload?.capturedAt || now);
    if (!isActiveGenerationValid() || capturedAt < Number(USAGE_CTX.activeGeneration?.startedAt || 0)) {
      debugUsageTelemetry('network_media_skipped_without_active_generation', {
        generationId: payload.generationId,
        requestId: payload.requestId,
        status: payload.status,
        source: payload.source,
        mediaAssetCount,
        capturedAt,
        activeStartedAt: Number(USAGE_CTX.activeGeneration?.startedAt || 0) || null,
      });
      return;
    }
  }
  if (!hasStableNetworkId && USAGE_CTX.pendingReportTimers.size > 1) {
    debugUsageTelemetry('network_usage_skipped_ambiguous_idless_concurrent', {
      pendingCount: USAGE_CTX.pendingReportTimers.size,
      status: payload.status,
      source: payload.source,
      mediaAssetCount,
      hasReasonableCreditBurn,
    });
    return;
  }

  pruneNetworkEventKeys(now);
  rememberActiveNetworkGeneration(payload);

  const dedupeKey = buildNetworkUsageDedupeKey(payload);

  if (dedupeKey && USAGE_CTX.networkEventKeys.has(dedupeKey)) {
    return;
  }
  if (dedupeKey) {
    USAGE_CTX.networkEventKeys.set(dedupeKey, now);
    broadcastNetworkUsageClaim(dedupeKey);
  }

  const snapshot = buildNetworkUsageSnapshot(payload);
  attachActiveGenerationOwnership(snapshot, getActiveGenerationTaskIds().length ? 'kling_task_id' : '');
  const hasSubmitPrompt = Boolean(normalizePromptCaptureValue(payload?.promptText));
  const matchesActiveGeneration = isActiveNetworkGeneration(payload);
  if (mediaAssetCount > 0 && !hasReasonableCreditBurn && !hasSubmitPrompt && !matchesActiveGeneration) {
    debugUsageTelemetry('network_usage_skipped_unmatched_assets', {
      generationId: payload.generationId,
      requestId: payload.requestId,
      status: payload.status,
      source: payload.source,
    });
    return;
  }
  if (mediaAssetCount > 0 && (payloadMatchesActiveGenerationTaskId(payload) !== false || associatedTaskId || matchesActiveGeneration)) {
    markActiveGenerationOwnedOutput(mediaAssetCount, getActiveGenerationTaskIds().length ? 'kling_task_id' : 'network_owned_output');
    attachActiveGenerationOwnership(snapshot, getActiveGenerationTaskIds().length ? 'kling_task_id' : 'network_owned_output');
    flushPendingMediaSourcePayloads();
  }
  if (
    !hasReasonableCreditBurn
    && !(Number(snapshot.creditsBurned || 0) > 0)
    && mediaAssetCount <= 0
    && !snapshot.metadata?.usedExpectedCreditFallback
  ) {
    debugUsageTelemetry('network_usage_skipped_empty_status', {
      generationId: payload.generationId,
      requestId: payload.requestId,
      status: payload.status,
      source: payload.source,
    });
    return;
  }
  resolveTrackedKlingAccountLabel()
    .then((klingAccountLabel) => {
      snapshot.metadata = {
        ...(snapshot.metadata || {}),
        klingAccountLabel: klingAccountLabel || snapshot.metadata?.klingAccountLabel || '',
      };
      return reportKlingUsage(snapshot);
    })
    .then((response) => {
      const eventId = Number(response?.event?.id || 0);
      setStatus(`Network usage captured${eventId > 0 ? ` #${eventId}` : ''}`, { hideAfterMs: 2500 });
    })
    .catch((error) => {
      if (error?.contextInvalidated || isExtensionContextInvalidatedError(error?.message)) {
        return;
      }
      console.warn('[RMW Kling] Network usage report failed', error);
    });
}

function finalizeGenerateUsageSnapshot(snapshot, creditsAfter, settlementReason) {
  snapshot.creditsAfter = creditsAfter;
  const rawCreditsBurned = (
    snapshot.creditsBefore != null && creditsAfter != null
      ? Math.max(0, snapshot.creditsBefore - creditsAfter)
      : null
  );
  const expectedCredits = Number(snapshot.expectedCredits);
  const hasExpectedCredits = Number.isFinite(expectedCredits) && expectedCredits > 0;
  const generationMode = `${snapshot.metadata?.generationMode || ''}`.trim().toLowerCase();
  const isSupportedFallbackMode = SUPPORTED_KLING_USAGE_FALLBACK_MODES.has(generationMode);
  const hasStrongGenerateCost = hasExpectedCredits
    && expectedCredits <= MAX_REASONABLE_KLING_CREDIT_BURN;
  const canAutoBurnExpectedFallback = hasExpectedCredits
    && expectedCredits <= MAX_EXPECTED_LOCK_AUTO_BURN;
  const maxSingleGenerationDelta = hasExpectedCredits
    ? Math.max(expectedCredits + 5, Math.ceil(expectedCredits * 1.25))
    : 0;
  const hasReasonableRawBurn = Number.isFinite(rawCreditsBurned)
    && rawCreditsBurned > 0
    && rawCreditsBurned <= MAX_REASONABLE_KLING_CREDIT_BURN
    && hasStrongGenerateCost
    && rawCreditsBurned <= maxSingleGenerationDelta;
  const sourceKind = settlementReason === 'wallet_balance_decreased'
    ? 'wallet'
    : (hasReasonableRawBurn ? 'dom' : 'expected');
  const creditSourceProfile = CREDIT_SOURCE_PROFILES[sourceKind];
  const usedExpectedFallback = !hasReasonableRawBurn && hasStrongGenerateCost && canAutoBurnExpectedFallback && isSupportedFallbackMode;
  snapshot.creditsBurned = hasReasonableRawBurn
    ? rawCreditsBurned
    : (usedExpectedFallback ? expectedCredits : null);
  const walletSnapshot = {
    before: snapshot.creditsBefore,
    after: creditsAfter,
    delta: rawCreditsBurned,
    expected: hasExpectedCredits ? expectedCredits : null,
    source: creditSourceProfile.source,
    capturedAt: Date.now(),
  };
  const driftAmount = hasReasonableRawBurn && hasExpectedCredits ? rawCreditsBurned - expectedCredits : 0;
  const hasCreditDrift = hasReasonableRawBurn && hasExpectedCredits && driftAmount !== 0;
  const confidenceLevel = snapshot.creditsBurned != null ? creditSourceProfile.confidence : 0.35;
  debugUsageTelemetry('settlement_finalized', {
    settlementReason,
    sourceKind,
    expectedCredits,
    rawCreditsBurned,
    creditsBurned: snapshot.creditsBurned,
    walletSnapshot,
    hasCreditDrift,
    maxSingleGenerationDelta,
  });
  snapshot.metadata = {
    ...(snapshot.metadata || {}),
    currentCredits: creditsAfter != null ? creditsAfter : snapshot.creditsBefore,
    settlementReason,
    rawCreditsBurned,
    maxSingleGenerationDelta,
    walletSnapshot,
    creditSource: creditSourceProfile.source,
    creditSourcePriority: creditSourceProfile.priority,
    confidenceLevel,
    creditDrift: hasCreditDrift,
    creditDriftAmount: hasCreditDrift ? driftAmount : 0,
    usedExpectedCreditFallback: usedExpectedFallback,
    supportedFallbackMode: isSupportedFallbackMode,
    strongGenerateCost: hasStrongGenerateCost,
    expectedFallbackAutoBurn: canAutoBurnExpectedFallback,
    expectedFallbackAutoBurnLimit: MAX_EXPECTED_LOCK_AUTO_BURN,
    source: creditSourceProfile.source,
    confidence: confidenceLevel,
  };
  snapshot.source = creditSourceProfile.source;
  snapshot.schemaVersion = 1;
  snapshot.confidence = confidenceLevel;
  return snapshot;
}

function waitForGenerateUsageSettlement(snapshot) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    let lastObservedCredits = snapshot.creditsBefore;
    let settled = false;
    let intervalId = 0;

    snapshot.status = 'reconciling';
    snapshot.metadata = {
      ...(snapshot.metadata || {}),
      stage: 'reconciling',
      lifecycleEvent: {
        stage: 'reconciling',
        source: 'dom_balance_fallback',
        transport: 'settlement_poll',
        capturedAt: startedAt,
        creditsUsed: null,
      },
    };
    debugUsageTelemetry('reconciliation_started', {
      expectedCredits: snapshot.expectedCredits,
      creditsBefore: snapshot.creditsBefore,
      fingerprint: snapshot.fingerprint,
    });

    const finish = (creditsAfter, settlementReason) => {
      if (settled) return;
      settled = true;
      if (intervalId) {
        clearInterval(intervalId);
      }
      resolve(finalizeGenerateUsageSnapshot(snapshot, creditsAfter, settlementReason));
    };

    const check = () => {
      const walletBalance = USAGE_CTX.latestWalletBalance;
      const walletBalanceIsFresh = walletBalance?.capturedAt && walletBalance.capturedAt >= startedAt - 250;
      const creditsAfter = walletBalanceIsFresh ? walletBalance.balance : readVisibleCreditBalance();
      if (creditsAfter != null) {
        lastObservedCredits = creditsAfter;
      }

      if (
        snapshot.creditsBefore != null
        && creditsAfter != null
        && creditsAfter < snapshot.creditsBefore
      ) {
        finish(creditsAfter, walletBalanceIsFresh ? 'wallet_balance_decreased' : 'balance_decreased');
        return;
      }

      if (Date.now() - startedAt >= USAGE_REPORT_MAX_WAIT_MS) {
        finish(lastObservedCredits, 'timeout');
      }
    };

    intervalId = window.setInterval(check, USAGE_REPORT_POLL_MS);
    check();
  });
}

function scheduleGenerateUsageReport(generateButton) {
  const snapshot = buildGenerateUsageSnapshot(generateButton);
  const generationMode = `${snapshot.metadata?.generationMode || ''}`.trim().toLowerCase();
  const expectedCredits = Number(snapshot.expectedCredits);
  const promptText = normalizePromptCaptureValue(snapshot.promptText);
  if (!promptText) {
    debugUsageTelemetry('generate_intent_skipped_missing_prompt', {
      generationMode,
      actionLabel: snapshot.metadata?.actionLabel,
      generateDetectionSource: inferGenerateDetectionSource(generateButton),
    });
    setStatus('Generate ignored: no prompt captured', { hideAfterMs: 2500 });
    return;
  }
  snapshot.promptText = promptText;
  snapshot.metadata = {
    ...(snapshot.metadata || {}),
    promptCapture: {
      ...(snapshot.metadata?.promptCapture || {}),
      text: promptText,
    },
  };
  const hasSupportedMode = SUPPORTED_KLING_USAGE_FALLBACK_MODES.has(generationMode);
  const hasExpectedCredits = Number.isFinite(expectedCredits)
    && expectedCredits > 0
    && expectedCredits <= MAX_REASONABLE_KLING_CREDIT_BURN;
  const canSettleCredits = hasSupportedMode && hasExpectedCredits;
  const missingCaptureFields = [
    !hasSupportedMode ? 'generationMode' : '',
    !hasExpectedCredits ? 'expectedCredits' : '',
  ].filter(Boolean);
  const generateDetectionSource = inferGenerateDetectionSource(generateButton);
  if (!hasExpectedCredits) {
    snapshot.expectedCredits = null;
  }
  const dedupeKey = JSON.stringify([
    snapshot.promptText,
    snapshot.modelLabel,
    snapshot.durationLabel,
    snapshot.resolutionLabel,
    hasExpectedCredits ? snapshot.expectedCredits : null,
  ]);
  const now = Date.now();
  const intentId = makeUsageSessionId('kgen');
  pruneDomSettlementKeys(now);
  if (
    USAGE_CTX.lastGenerateKey === dedupeKey
    && now - USAGE_CTX.lastGenerateAt < 3000
  ) {
    return;
  }

  USAGE_CTX.lastGenerateKey = dedupeKey;
  USAGE_CTX.lastGenerateIntentId = intentId;
  USAGE_CTX.lastGenerateAt = now;
  USAGE_CTX.domSettlementKeys.set(intentId, now);
  snapshot.fingerprint = `dom_${intentId}`;
  snapshot.externalEventId = intentId;
  snapshot.metadata = {
    ...(snapshot.metadata || {}),
    domDedupeKey: intentId,
    generateDedupeBase: dedupeKey,
    generateIntentId: intentId,
    generateDetectionSource,
  };
  announceKlingGenerateIntent(snapshot);
  snapshot.metadata = {
    ...(snapshot.metadata || {}),
    creditIntentCaptured: true,
    reservedCredits: hasExpectedCredits ? expectedCredits : null,
    usageCaptureIncomplete: !canSettleCredits,
    captureIncomplete: !canSettleCredits || missingCaptureFields.length > 0,
    missingCaptureFields,
    usageCaptureIncompleteReason: !hasSupportedMode
      ? 'unsupported_or_unknown_generation_mode'
      : (!hasExpectedCredits ? 'unclear_generate_credit_cost' : ''),
  };
  startGeneratedAssetDetection(snapshot);
  reportKlingUsage({
    ...snapshot,
    status: 'submitted',
    creditsBurned: null,
    source: 'generate_intent',
    confidence: 0.55,
    metadata: {
      ...(snapshot.metadata || {}),
      stage: 'submitted',
      source: 'generate_intent',
      creditSource: 'generate_intent',
      creditSourcePriority: 50,
      confidenceLevel: 0.55,
      canSettleCredits,
      generateDetectionSource,
      captureIncomplete: !canSettleCredits || missingCaptureFields.length > 0,
      missingCaptureFields,
      lifecycleEvent: {
        stage: 'submitted',
        source: 'generate_intent',
        transport: 'click',
        capturedAt: now,
        creditsUsed: null,
      },
    },
  })
    .then((response) => {
      const eventId = Number(response?.event?.id || 0);
      if (eventId > 0) {
        snapshot.eventId = eventId;
      }
      debugUsageTelemetry('generate_intent_saved', {
        eventId,
        expectedCredits: hasExpectedCredits ? expectedCredits : null,
        generationMode,
        canSettleCredits,
        generateDetectionSource,
        missingCaptureFields,
        fingerprint: snapshot.fingerprint,
      });
    })
    .catch((error) => {
      if (error?.contextInvalidated || isExtensionContextInvalidatedError(error?.message)) return;
      console.warn('[RMW Kling] Generate intent report failed', error);
    });
  setStatus(
    hasExpectedCredits
      ? `Generate intent detected: ${expectedCredits} credit${expectedCredits === 1 ? '' : 's'}`
      : 'Generate intent detected: credit cost unclear',
    { hideAfterMs: 2500 }
  );
  debugUsageTelemetry('credit_intent_captured', {
    expectedCredits: hasExpectedCredits ? expectedCredits : null,
    generationMode,
    canSettleCredits,
    generateDetectionSource,
    missingCaptureFields,
    fingerprint: snapshot.fingerprint,
  });
  if (!canSettleCredits) {
    debugUsageTelemetry('credit_settlement_skipped_unclear_generation', {
      generationMode,
      expectedCredits: hasExpectedCredits ? expectedCredits : null,
      actionLabel: snapshot.metadata?.actionLabel,
      promptCaptured: Boolean(snapshot.promptText),
      generateDetectionSource,
      missingCaptureFields,
    });
    return;
  }
  const reportTimer = window.setTimeout(() => {
    USAGE_CTX.pendingReportTimers.delete(reportTimer);
    if (USAGE_CTX.pendingReportTimer === reportTimer) {
      USAGE_CTX.pendingReportTimer = null;
    }
    resolveTrackedKlingAccountLabel()
      .then((klingAccountLabel) => {
        snapshot.metadata = {
          ...(snapshot.metadata || {}),
          klingAccountLabel: klingAccountLabel || snapshot.metadata?.klingAccountLabel || '',
        };
        return waitForGenerateUsageSettlement(snapshot);
      })
      .then((settledSnapshot) => {
        const usedExpectedFallback = Boolean(settledSnapshot.metadata?.usedExpectedCreditFallback);
        if (
          (
            !['balance_decreased', 'wallet_balance_decreased'].includes(settledSnapshot.metadata?.settlementReason)
            && !usedExpectedFallback
          )
          || !(Number(settledSnapshot.creditsBurned || 0) > 0)
        ) {
          USAGE_CTX.domSettlementKeys.delete(intentId);
          setStatus('Usage not saved: no confirmed credit burn', { hideAfterMs: 3000 });
          return null;
        }
        USAGE_CTX.domSettlementKeys.set(intentId, Date.now());
        return reportKlingUsage({
          ...settledSnapshot,
          status: 'settled',
          metadata: {
            ...(settledSnapshot.metadata || {}),
            stage: 'settled',
          },
        });
      })
      .then((response) => {
        if (!response) return;
        const eventId = Number(response?.event?.id || snapshot.eventId || 0);
        setStatus(`Usage saved: ${eventId > 0 ? `#${eventId}` : 'settled'}`, { hideAfterMs: 3500 });
      })
      .catch((error) => {
        if (error?.contextInvalidated || isExtensionContextInvalidatedError(error?.message)) {
          return;
        }
        setStatus(`Usage tracking failed: ${error?.message || 'Unknown error'}`);
        console.warn('[RMW Kling] Usage report failed', error);
      });
  }, 1200);
  USAGE_CTX.pendingReportTimer = reportTimer;
  USAGE_CTX.pendingReportTimers.add(reportTimer);
}

function clearPendingUsageReport() {
  for (const timer of USAGE_CTX.pendingReportTimers) {
    clearTimeout(timer);
  }
  USAGE_CTX.pendingReportTimers.clear();
  if (USAGE_CTX.pendingReportTimer) {
    clearTimeout(USAGE_CTX.pendingReportTimer);
    USAGE_CTX.pendingReportTimer = null;
  }
  stopGeneratedAssetDetection();
}

function handleGenerateInteraction(event) {
  const now = Date.now();
  if (
    USAGE_CTX.lastInteractionType === event.type
    && now - USAGE_CTX.lastInteractionAt < 120
  ) {
    return;
  }
  USAGE_CTX.lastInteractionType = event.type;
  USAGE_CTX.lastInteractionAt = now;

  const generateButton = findGenerateActionTarget(event.target);
  if (!generateButton) {
    const debugLabel = readGenerateLikeClickLabel(event.target);
    if (debugLabel) {
      setStatus(`Generate-like interaction: ${debugLabel}`, { hideAfterMs: 4000 });
      window.setTimeout(() => showCurrentCreditsDebug('after generate-like interaction'), 250);
    }
    return;
  }
  const label = readGenerateButtonLabel(generateButton);
  setStatus(`Generate detected: ${label || 'button found'}`, { hideAfterMs: 4000 });
  window.setTimeout(() => showCurrentCreditsDebug('after generate detect'), 250);
  scheduleGenerateUsageReport(generateButton);
}

function startUsageTracking() {
  captureTicket();
  initUsageIdentity();
  setupUsageBroadcastChannel();
  if (USAGE_CTX.listenerAttached) return;
  USAGE_CTX.listenerAttached = true;
  document.addEventListener('pointerdown', handleGenerateInteraction, true);
  document.addEventListener('click', handleGenerateInteraction, true);
  window.addEventListener('pagehide', clearPendingUsageReport, true);
  window.addEventListener('pagehide', clearStoredMediaSourceAssets, true);
  if (!USAGE_CTX.networkListenerAttached) {
    USAGE_CTX.networkListenerAttached = true;
    window.addEventListener('message', handleKlingNetworkUsageMessage, false);
  }
  if (!USAGE_CTX.debugReadyShown) {
    USAGE_CTX.debugReadyShown = true;
    setStatus('Kling usage tracker ready', { hideAfterMs: 2500 });
    window.setTimeout(() => showCurrentCreditsDebug('startup'), 900);
  }
}

// ── DOM helpers ───────────────────────────────────────────────
function isVisible(el) {
  if (!el) return false;
  const r = el.getBoundingClientRect();
  const s = getComputedStyle(el);
  return r.width > 0 && r.height > 0
    && s.display !== 'none'
    && s.visibility !== 'hidden'
    && s.opacity !== '0';
}

function isEnabled(el) {
  return Boolean(el)
    && !el.disabled
    && el.getAttribute('aria-disabled') !== 'true'
    && el.getAttribute('disabled') === null;
}

function getClickReadiness(el) {
  if (!el) {
    return { ok: false, reason: 'missing' };
  }
  const style = getComputedStyle(el);
  return {
    ok: Boolean(isVisible(el) && isEnabled(el) && style.pointerEvents !== 'none'),
    disabled: Boolean(el.disabled),
    ariaDisabled: `${el.getAttribute?.('aria-disabled') || ''}`,
    disabledAttr: el.getAttribute?.('disabled') !== null,
    pointerEvents: style.pointerEvents,
    visible: isVisible(el),
    enabled: isEnabled(el),
    text: normalizeSpace(buttonDescriptorText(el) || buttonText(el)).slice(0, 160),
  };
}

function buttonText(el) {
  return `${el?.innerText || el?.textContent || el?.value || el?.getAttribute?.('aria-label') || ''}`
    .trim().toLowerCase();
}

function buttonDescriptorText(el) {
  if (!el) return '';
  const parts = [
    el.innerText, el.textContent, el.value,
    el.getAttribute?.('aria-label'), el.getAttribute?.('title'),
    el.getAttribute?.('data-testid'), el.getAttribute?.('href'),
  ];
  el.querySelectorAll?.('img[alt],[aria-label],[title]').forEach((n) => {
    parts.push(n.getAttribute?.('alt'), n.getAttribute?.('aria-label'), n.getAttribute?.('title'));
  });
  return parts.filter(Boolean).join(' ').trim().toLowerCase();
}

function isPolicyLikeAction(el) {
  if (!el) return false;
  const text = buttonDescriptorText(el) || buttonText(el);
  const href = `${el.getAttribute?.('href') || ''}`.trim().toLowerCase();
  const combined = `${text} ${href}`.trim();
  return combined.includes('privacy')
    || combined.includes('terms')
    || combined.includes('policy')
    || combined.includes('cookies')
    || combined.includes('cookie')
    || combined.includes('help center')
    || combined.includes('/privacy')
    || combined.includes('/terms')
    || combined.includes('/policy')
    || combined.includes('/cookies');
}

function hasKlingNetworkErrorToast() {
  const text = normalizeSpace(
    Array.from(document.body?.querySelectorAll('body *') || [])
      .filter((element) => isVisible(element) && !element.closest?.('#rmw-kling-badge'))
      .map((element) => element.innerText || element.textContent || '')
      .filter(Boolean)
      .join(' ')
  );
  return text.includes('network error, please try again');
}

function isActionLikeElement(el) {
  if (!el || !isVisible(el)) return false;
  if (el.matches?.(ACTION_SELECTORS.join(','))) return isEnabled(el);
  if (el.tabIndex >= 0) return isEnabled(el);
  const s = getComputedStyle(el);
  return s.cursor === 'pointer' || typeof el.onclick === 'function';
}

function findClickableAncestor(el) {
  let cur = el;
  while (cur && cur !== document.body) {
    if (isActionLikeElement(cur)) return cur;
    cur = cur.parentElement;
  }
  return isVisible(el) ? el : null;
}

function collectUniqueElements(els) {
  return Array.from(new Set(els.filter(Boolean)));
}

function findInput(selectors) {
  for (const sel of selectors) {
    const match = Array.from(document.querySelectorAll(sel))
      .find((el) => isVisible(el) && !el.disabled && !el.readOnly);
    if (match) return match;
  }
  return null;
}

function valuesMatch(a, b) {
  return `${a || ''}`.trim() === `${b || ''}`.trim();
}

function normalizeSpace(value) {
  return `${value || ''}`.replace(/\s+/g, ' ').trim().toLowerCase();
}

function passwordSemanticText(input) {
  if (!input) return '';
  return normalizeSpace([
    input.getAttribute?.('type') || input.type || '',
    input.getAttribute?.('autocomplete') || '',
    input.getAttribute?.('name') || '',
    input.getAttribute?.('id') || '',
    input.getAttribute?.('placeholder') || '',
    input.getAttribute?.('aria-label') || '',
    input.getAttribute?.('data-testid') || '',
    input.getAttribute?.('class') || '',
  ].join(' '));
}

function isPasswordSemanticInput(input) {
  if (!input) return false;
  const descriptor = passwordSemanticText(input);
  return descriptor.includes('password')
    || descriptor.includes('passcode')
    || descriptor.includes('current-password')
    || descriptor.includes('new-password');
}

function findVisiblePasswordInputs() {
  return Array.from(document.querySelectorAll('input'))
    .filter((input) => isVisible(input) && !input.disabled && !input.readOnly && isPasswordSemanticInput(input));
}

function findPrimaryPasswordInput() {
  const candidates = collectUniqueElements([
    findInput(PASS_SELS),
    ...findVisiblePasswordInputs(),
  ]).filter(Boolean);

  if (!candidates.length) return null;
  return candidates
    .sort((left, right) => {
      const score = (input) => {
        let value = 0;
        if (input === document.activeElement) value += 8;
        if (`${input.value || ''}`.length > 0) value += 6;
        if ((`${input.getAttribute?.('type') || input.type || ''}`.trim().toLowerCase()) === 'password') value += 4;
        if (input.matches?.('input[autocomplete="current-password"], input[autocomplete="new-password"]')) value += 3;
        return value;
      };
      return score(right) - score(left);
    })[0];
}

function controlHintText(el) {
  if (!el) return '';
  const parts = [
    buttonDescriptorText(el),
    el.getAttribute?.('name'),
    el.getAttribute?.('id'),
    el.getAttribute?.('class'),
    el.getAttribute?.('data-testid'),
    el.getAttribute?.('data-icon'),
    el.getAttribute?.('aria-controls'),
  ];
  return normalizeSpace(parts.filter(Boolean).join(' '));
}

function collectPasswordFieldScopes(passInput) {
  const scopes = [];
  let cur = passInput?.parentElement || null;
  let depth = 0;
  while (cur && cur !== document.body && depth < 4) {
    scopes.push(cur);
    cur = cur.parentElement;
    depth += 1;
  }
  return collectUniqueElements(scopes);
}

function blockRevealControlEvent(event) {
  event.preventDefault();
  event.stopPropagation();
  event.stopImmediatePropagation();
}

function disablePasswordRevealControl(el) {
  if (!el || el.dataset?.rmwKlingPasswordRevealDisabled === 'true') return;
  el.dataset.rmwKlingPasswordRevealDisabled = 'true';
  el.setAttribute('aria-disabled', 'true');
  el.setAttribute('tabindex', '-1');

  if ('disabled' in el) {
    try { el.disabled = true; } catch {}
  }

  ['click', 'mousedown', 'mouseup', 'pointerdown', 'pointerup', 'touchstart', 'touchend', 'keydown', 'keyup']
    .forEach((eventName) => el.addEventListener(eventName, blockRevealControlEvent, true));

  el.style.setProperty('pointer-events', 'none', 'important');
  el.style.setProperty('cursor', 'not-allowed', 'important');
  el.style.setProperty('opacity', '0.6', 'important');
}

function verticalOverlapAmount(aRect, bRect) {
  return Math.max(0, Math.min(aRect.bottom, bRect.bottom) - Math.max(aRect.top, bRect.top));
}

function isNearPasswordInput(passInput, candidate) {
  if (!passInput || !candidate || !isVisible(candidate)) return false;

  const passRect = passInput.getBoundingClientRect();
  const candidateRect = candidate.getBoundingClientRect();
  const verticalOverlap = verticalOverlapAmount(passRect, candidateRect);
  const horizontalGap = candidateRect.left - passRect.right;
  const candidateCenterX = candidateRect.left + (candidateRect.width / 2);

  return verticalOverlap >= Math.min(passRect.height, candidateRect.height) * 0.4
    && candidateCenterX >= passRect.right - 40
    && horizontalGap <= 80;
}

function findPasswordRevealCandidates(passInput) {
  const scopes = collectPasswordFieldScopes(passInput);
  const rawCandidates = scopes.flatMap((scope) =>
    Array.from(scope.querySelectorAll('button,[role="button"],[tabindex],svg,img,span,div'))
      .map((el) => findClickableAncestor(el) || el)
  );

  return collectUniqueElements(rawCandidates).filter((candidate) => {
    if (!candidate || candidate === passInput || candidate.contains(passInput) || passInput.contains(candidate)) return false;

    const hints = controlHintText(candidate);
    const hasSubjectHint = PASSWORD_REVEAL_SUBJECT_HINTS.some((hint) => hints.includes(hint));
    const hasActionHint = PASSWORD_REVEAL_ACTION_HINTS.some((hint) => hints.includes(hint));
    const hasIconHint = PASSWORD_REVEAL_ICON_HINTS.some((hint) => hints.includes(hint));
    const iconChild = candidate.querySelector?.('svg,img');
    const classHints = normalizeSpace(`${candidate.className || ''}`);
    const looksLikeEyeIcon = Boolean(iconChild) || /eye|visibility|show|hide|view/.test(classHints);

    return (hasSubjectHint && (hasActionHint || hasIconHint))
      || (isNearPasswordInput(passInput, candidate) && (hasIconHint || looksLikeEyeIcon));
  });
}

function findPasswordRevealControlFromTarget(target, passInput) {
  if (!target || !passInput) return null;

  const path = typeof target.composedPath === 'function' ? target.composedPath() : [];
  const pathElements = path.filter((node) => node?.nodeType === Node.ELEMENT_NODE);
  const ancestors = [];
  let cur = target?.nodeType === Node.ELEMENT_NODE ? target : target?.parentElement;
  while (cur && cur !== document.body) {
    ancestors.push(cur);
    cur = cur.parentElement;
  }

  const candidates = collectUniqueElements([...pathElements, ...ancestors])
    .map((el) => findClickableAncestor(el) || el);

  return candidates.find((candidate) => findPasswordRevealCandidates(passInput).includes(candidate)) || null;
}

function ensurePasswordGuardStyle() {
  void PASSWORD_GUARD_STYLE_ID;
}

function applyPasswordConcealmentStyles(passInput) {
  void passInput;
}

function concealPasswordText(passInput) {
  void passInput;
}

function enforcePasswordMask(passInput) {
  void passInput;
}

function handlePasswordRevealAttempt(event) {
  void event;
}

function ensurePasswordRevealGuards() {
  void handlePasswordRevealAttempt;
}

function suppressPasswordReveal(passInput) {
  void passInput;
  CTX.blockedRevealControl = null;
}

// ── React-compatible fill ─────────────────────────────────────
function sleep(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, Math.max(0, ms)));
}

function getValueSetter(input) {
  let current = input;
  while (current && current !== Object.prototype) {
    const descriptor = Object.getOwnPropertyDescriptor(current, 'value');
    if (descriptor?.set) {
      return descriptor.set;
    }
    current = Object.getPrototypeOf(current);
  }
  return null;
}

function isPasswordField(input) {
  if (!input) return false;
  const type = `${input.getAttribute?.('type') || input.type || ''}`.trim().toLowerCase();
  return type === 'password' || isPasswordSemanticInput(input);
}

function moveCaretToEnd(input) {
  if (!input || typeof input.setSelectionRange !== 'function') return;
  try {
    const length = `${input.value || ''}`.length;
    input.setSelectionRange(length, length);
  } catch {}
}

function getPasswordTypedMarker(input) {
  return `${input?.dataset?.rmwKlingTypedValue || ''}`;
}

function setPasswordTypedMarker(input, value) {
  if (!input?.dataset) return;
  input.dataset.rmwKlingTypedValue = `${value || ''}`;
}

function resetPasswordSubmitGuard() {
  CTX.passwordSubmitGuardKey = '';
  CTX.passwordSubmitGuardUntil = 0;
}

function buildPasswordSubmitGuardKey(emailInput, passInput) {
  const emailMarker = emailInput
    ? `${`${emailInput.value || ''}`.trim().toLowerCase()}`
    : '';
  const passwordLength = `${passInput?.value || ''}`.length;
  return [
    location.pathname || '',
    emailMarker,
    passwordLength,
    passInput ? 'password-present' : 'password-missing',
  ].join('|');
}

async function waitForFieldValueStability(input, value, {
  durationMs = PASSWORD_FIELD_SETTLE_MS,
  intervalMs = PASSWORD_FIELD_SETTLE_CHECK_MS,
} = {}) {
  if (!input) return true;
  const expectedValue = `${value || ''}`;
  if (!valuesMatch(input.value, expectedValue)) return false;

  const deadline = Date.now() + Math.max(0, durationMs);
  while (Date.now() < deadline) {
    await sleep(intervalMs);
    if (!input.isConnected) return false;
    if (!valuesMatch(input.value, expectedValue)) return false;
  }
  return valuesMatch(input.value, expectedValue);
}

function fillField(input, value) {
  if (!input) return;
  const passwordField = isPasswordField(input);
  const nextValue = `${value || ''}`;
  const previousValue = `${input.value || ''}`;
  const setter = getValueSetter(input);
  try { input.focus({ preventScroll: true }); } catch {}
  if (setter) setter.call(input, nextValue);
  else input.value = nextValue;
  input.setAttribute('value', nextValue);
  if (input._valueTracker && typeof input._valueTracker.setValue === 'function') {
    input._valueTracker.setValue(previousValue);
  }
  try {
    input.dispatchEvent(new InputEvent('beforeinput', {
      bubbles: true,
      cancelable: true,
      data: nextValue,
      inputType: 'insertText',
    }));
  } catch {}
  try {
    input.dispatchEvent(new InputEvent('input', {
      bubbles: true,
      data: nextValue,
      inputType: 'insertText',
    }));
  } catch {
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }
  input.dispatchEvent(new Event('change', { bubbles: true }));
  moveCaretToEnd(input);
  if (!passwordField) {
    input.dispatchEvent(new Event('blur', { bubbles: true }));
  }
}

async function typeFieldLikeUser(input, value, { perCharDelayMs = TYPED_FILL_CHAR_DELAY_MS } = {}) {
  if (!input) return;
  const passwordField = isPasswordField(input);
  const nextValue = `${value || ''}`;
  const setter = getValueSetter(input);
  const setTypedValue = (typedValue, previousValue) => {
    if (setter) setter.call(input, typedValue);
    else input.value = typedValue;
    input.setAttribute('value', typedValue);
    if (input._valueTracker && typeof input._valueTracker.setValue === 'function') {
      input._valueTracker.setValue(previousValue);
    }
  };

  try { input.focus({ preventScroll: true }); } catch {}

  const initialValue = `${input.value || ''}`;
  setTypedValue('', initialValue);
  try {
    input.dispatchEvent(new InputEvent('beforeinput', {
      bubbles: true,
      cancelable: true,
      data: '',
      inputType: 'deleteContentBackward',
    }));
  } catch {}
  input.dispatchEvent(new Event('input', { bubbles: true }));

  for (let index = 0; index < nextValue.length; index += 1) {
    const character = nextValue[index];
    const partialValue = nextValue.slice(0, index + 1);
    const previousPartial = `${input.value || ''}`;
    try {
      input.dispatchEvent(new KeyboardEvent('keydown', {
        key: character,
        code: character.length === 1 ? `Key${character.toUpperCase()}` : '',
        bubbles: true,
        cancelable: true,
      }));
    } catch {}
    try {
      input.dispatchEvent(new InputEvent('beforeinput', {
        data: character,
        inputType: 'insertText',
        bubbles: true,
        cancelable: true,
      }));
    } catch {}
    setTypedValue(partialValue, previousPartial);
    try {
      input.dispatchEvent(new InputEvent('input', {
        data: character,
        inputType: 'insertText',
        bubbles: true,
      }));
    } catch {
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }
    try {
      input.dispatchEvent(new KeyboardEvent('keyup', {
        key: character,
        code: character.length === 1 ? `Key${character.toUpperCase()}` : '',
        bubbles: true,
        cancelable: true,
      }));
    } catch {}
    if (perCharDelayMs > 0) {
      await sleep(perCharDelayMs);
    }
  }

  input.dispatchEvent(new Event('change', { bubbles: true }));
  moveCaretToEnd(input);
  if (passwordField) {
    setPasswordTypedMarker(input, nextValue);
  }
  if (!passwordField) {
    input.dispatchEvent(new Event('blur', { bubbles: true }));
  }
}

async function ensureFieldValue(input, value) {
  if (!input) return true;
  const passwordField = isPasswordField(input);
  if (valuesMatch(input.value, value)) {
    return passwordField
      ? waitForFieldValueStability(input, value)
      : true;
  }

  fillField(input, value);
  await sleep(FIELD_FILL_DELAY_MS);
  if (passwordField && await waitForFieldValueStability(input, value)) return true;
  if (!passwordField && valuesMatch(input.value, value)) return true;

  if (passwordField) {
    await typeFieldLikeUser(input, value);
    await sleep(FIELD_FILL_DELAY_MS);
    if (await waitForFieldValueStability(input, value)) return true;
  }

  if (valuesMatch(input.value, value)) return true;
  fillField(input, value);
  await sleep(FIELD_FILL_DELAY_MS);
  return passwordField
    ? waitForFieldValueStability(input, value)
    : valuesMatch(input.value, value);
}

function submitNearestForm(input) {
  const form = input?.closest?.('form');
  if (!form) return false;

  try {
    if (typeof form.requestSubmit === 'function') {
      form.requestSubmit();
      return true;
    }
  } catch {}

  try {
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    return true;
  } catch {
    return false;
  }
}

function pressEnter(input) {
  if (!input) return false;
  try { input.focus({ preventScroll: true }); } catch {}
  ['keydown', 'keypress', 'keyup'].forEach((eventName) => {
    try {
      input.dispatchEvent(new KeyboardEvent(eventName, {
        key: 'Enter',
        code: 'Enter',
        keyCode: 13,
        which: 13,
        bubbles: true,
        cancelable: true,
      }));
    } catch {}
  });
  return true;
}

function submitSignInStep(button, fallbackInput) {
  if (button && safeClick(button)) return true;
  if (submitNearestForm(fallbackInput)) return true;
  return pressEnter(fallbackInput);
}

function buildSubmitActionKey(kind, emailInput, passInput, button) {
  const buttonLabel = normalizeSpace(buttonDescriptorText(button) || buttonText(button));
  const emailMarker = emailInput
    ? `${emailInput.getAttribute?.('name') || emailInput.id || 'email'}:${`${emailInput.value || ''}`.trim().toLowerCase()}`
    : 'email:none';
  const passwordMarker = passInput
    ? `password:${`${passInput.value || ''}`.length}`
    : 'password:none';
  return [
    kind || 'unknown',
    location.pathname || '',
    buttonLabel || 'button',
    emailMarker,
    passwordMarker,
  ].join('|');
}

// ── Single safe click — no multi-event chain ──────────────────
function safeClick(el) {
  if (!el || !isVisible(el) || !isEnabled(el)) return false;
  const anchor = el.closest?.('a[href]') || (el.matches?.('a[href]') ? el : null);
  const target = anchor || el;
  if (anchor) {
    const href = `${anchor.getAttribute('href') || ''}`.trim();
    const linkTarget = `${anchor.getAttribute('target') || ''}`.trim().toLowerCase();
    if (href && href !== '#' && !href.toLowerCase().startsWith('javascript:') && linkTarget === '_blank') {
      try { anchor.setAttribute('target', '_self'); } catch {}
    }
  }
  try { target.scrollIntoView({ block: 'nearest', inline: 'nearest' }); } catch {}
  try { target.focus({ preventScroll: true }); } catch {}
  target.click();
  return true;
}

function enhancedSafeClick(el) {
  if (!el || !isVisible(el) || !isEnabled(el)) return false;
  const clickable = findClickableAncestor(el) || el;
  const anchor = clickable.closest?.('a[href]') || (clickable.matches?.('a[href]') ? clickable : null);
  let target = anchor || clickable;
  if (anchor) {
    const href = `${anchor.getAttribute('href') || ''}`.trim();
    const linkTarget = `${anchor.getAttribute('target') || ''}`.trim().toLowerCase();
    if (href && href !== '#' && !href.toLowerCase().startsWith('javascript:') && linkTarget === '_blank') {
      try { anchor.setAttribute('target', '_self'); } catch {}
    }
  }
  try { target.scrollIntoView({ block: 'center', inline: 'nearest' }); } catch {}
  try { target.focus({ preventScroll: true }); } catch {}

  try {
    const rect = target.getBoundingClientRect();
    const clientX = rect.left + (rect.width / 2);
    const clientY = rect.top + (rect.height / 2);
    const pointed = document.elementFromPoint(clientX, clientY);
    const pointedTarget = findClickableAncestor(pointed) || pointed;
    if (pointedTarget && isVisible(pointedTarget) && isEnabled(pointedTarget)) {
      target = pointedTarget;
    }
    const pointerCtor = typeof window.PointerEvent === 'function' ? window.PointerEvent : window.MouseEvent;
    [
      ['pointerover', pointerCtor],
      ['mouseover', window.MouseEvent],
      ['pointerenter', pointerCtor],
      ['mouseenter', window.MouseEvent],
      ['pointerdown', pointerCtor],
      ['mousedown', window.MouseEvent],
      ['pointerup', pointerCtor],
      ['mouseup', window.MouseEvent],
      ['click', window.MouseEvent],
      ['pointerout', pointerCtor],
      ['mouseout', window.MouseEvent],
    ].forEach(([type, EventCtor]) => {
      try {
        target.dispatchEvent(new EventCtor(type, {
          bubbles: true,
          cancelable: true,
          composed: true,
          view: window,
          clientX,
          clientY,
          button: 0,
          buttons: type.includes('down') ? 1 : 0,
          detail: type === 'click' ? 1 : 0,
        }));
      } catch {}
    });
  } catch {}

  try {
    target.click();
    return true;
  } catch {
    try {
      const rect = target.getBoundingClientRect();
      target.dispatchEvent(new MouseEvent('click', {
        bubbles: true,
        cancelable: true,
        composed: true,
        view: window,
        clientX: rect.left + (rect.width / 2),
        clientY: rect.top + (rect.height / 2),
      }));
      return true;
    } catch {
      return false;
    }
  }
}

// ── Button detection helpers ──────────────────────────────────
function isThirdPartyAuthAction(el) {
  if (isPolicyLikeAction(el)) return false;
  const text = buttonDescriptorText(el) || buttonText(el);
  return text.includes('google') || text.includes('apple')
    || text.includes('facebook') || text.includes('continue as ');
}

function isEmailAuthAction(el) {
  if (isPolicyLikeAction(el)) return false;
  const text = buttonDescriptorText(el) || buttonText(el);
  return text.includes('sign in with email')
    || text.includes('continue with email')
    || text.includes('use email')
    || text === 'email';
}

function landingActionKey(el) {
  if (!el) return '';
  return [
    buttonText(el),
    `${el.getAttribute?.('href') || ''}`.trim().toLowerCase(),
    `${el.getAttribute?.('data-testid') || ''}`.trim().toLowerCase(),
  ].join('|');
}

function findLandingCandidates() {
  const primary = Array.from(document.querySelectorAll(ACTION_SELECTORS.join(',')));
  const fallback = Array.from(document.querySelectorAll('[tabindex],div,span,li,section,article'))
    .filter((el) => {
      const text = buttonDescriptorText(el);
      return text.includes('sign in') || text.includes('log in') || text.includes('login')
        || text.includes('sign in with email') || text.includes('continue with email')
        || text.includes('use email') || text.includes('experience now') || text.includes('create now');
    })
    .map((el) => findClickableAncestor(el));
  return collectUniqueElements([...primary, ...fallback])
    .filter((el) => isActionLikeElement(el))
    .filter((el) => !isPolicyLikeAction(el));
}

function findEmailChooserButton() {
  return findLandingCandidates().find((el) => isEmailAuthAction(el)) || null;
}

function findGoogleAuthButton() {
  return findLandingCandidates().find((el) => {
    const text = buttonDescriptorText(el) || buttonText(el);
    return text.includes('google') && !text.includes('apple') && !text.includes('facebook');
  }) || null;
}

function scoreExactSignInCandidate(el) {
  if (!el) return -1;
  const text = normalizeSpace(buttonText(el));
  const descriptor = normalizeSpace(buttonDescriptorText(el));
  const hints = controlHintText(el);
  const rect = el.getBoundingClientRect();
  let score = 0;

  if (text === 'sign in') score += 100;
  else if (descriptor === 'sign in') score += 90;
  else if (text.includes('sign in')) score += 40;

  if (el.closest?.('aside, nav')) score += 40;
  if (rect.left <= 140) score += 25;
  if (rect.width <= 160 && rect.height <= 80) score += 20;
  if (hints.includes('api')) score += 10;
  if (hints.includes('google') || hints.includes('apple') || hints.includes('facebook')) score -= 40;
  if (descriptor.includes('trial package') || descriptor.includes('experience now') || descriptor.includes('create now')) score -= 50;

  return score;
}

function findDirectInteractiveSignInButton() {
  const directSelectors = [
    'button',
    'a[href]',
    '[role="button"]',
    'input[type="button"]',
    'input[type="submit"]',
  ];

  const matches = collectUniqueElements(
    directSelectors.flatMap((selector) => Array.from(document.querySelectorAll(selector)))
  )
    .filter((el) => isVisible(el) && isEnabled(el))
    .filter((el) => {
      if (isPolicyLikeAction(el)) return false;
      if (isThirdPartyAuthAction(el) || isEmailAuthAction(el)) return false;
      const text = normalizeSpace(buttonText(el));
      const descriptor = normalizeSpace(buttonDescriptorText(el));
      return text === 'sign in' || descriptor === 'sign in';
    });

  if (!matches.length) return null;
  return matches.sort((left, right) => scoreExactSignInCandidate(right) - scoreExactSignInCandidate(left))[0] || null;
}

function findExactSignInButton() {
  const directMatch = findDirectInteractiveSignInButton();
  if (directMatch) return directMatch;

  const rawCandidates = Array.from(document.querySelectorAll('[tabindex],div,span,li'))
    .filter((el) => isVisible(el))
    .map((el) => findClickableAncestor(el) || el);

  const matches = collectUniqueElements(rawCandidates)
    .filter((el) => isActionLikeElement(el))
    .filter((el) => {
      if (isPolicyLikeAction(el)) return false;
      if (isThirdPartyAuthAction(el) || isEmailAuthAction(el)) return false;
      const text = normalizeSpace(buttonText(el));
      const descriptor = normalizeSpace(buttonDescriptorText(el));
      return text === 'sign in' || descriptor === 'sign in';
    });

  if (!matches.length) return null;
  return matches.sort((left, right) => scoreExactSignInCandidate(right) - scoreExactSignInCandidate(left))[0] || null;
}

// FIX: No longer matches generic /app hrefs — those are nav links, not login buttons
function findLandingEntryButton() {
  const exactSignInButton = findExactSignInButton();
  if (exactSignInButton) return exactSignInButton;

  const candidates = findLandingCandidates();
  const signInButton = candidates.find((el) => {
    if (isPolicyLikeAction(el)) return false;
    if (isThirdPartyAuthAction(el) || isEmailAuthAction(el)) return false;
    const text = buttonDescriptorText(el) || buttonText(el);
    return text === 'sign in' || text === 'login' || text === 'log in'
      || text.includes('sign in') || text.includes('log in') || text.includes('login');
  });
  if (signInButton) return signInButton;
  return candidates.find((el) => {
    if (isPolicyLikeAction(el)) return false;
    if (isThirdPartyAuthAction(el) || isEmailAuthAction(el)) return false;
    const text = buttonDescriptorText(el) || buttonText(el);
    if (text.includes('experience now') || text.includes('create now') || text.includes('get started')) return true;
    const href = `${el.getAttribute?.('href') || ''}`.trim().toLowerCase();
    // FIX: removed href.includes('/app') — matched sidebar nav links and caused redirect loops
    return href.includes('/login') || href.includes('/sign-in')
      || href.includes('/signin') || href.includes('/auth');
  }) || null;
}

function hasLoginForm() {
  return Boolean(findInput(EMAIL_SELS) || findPrimaryPasswordInput());
}

function hasVisibleLoginSurface() {
  return Boolean(hasLoginForm() || findEmailChooserButton() || findLandingEntryButton());
}

// FIX: Never redirect if already on /app — prevents reload during transient render
function shouldRedirectToApp() {
  const pathname = `${location.pathname || ''}`.toLowerCase();
  if (pathname.startsWith('/app')) return false;
  if (isGoogleAuthTransitionPending()) return false;
  if (hasVisibleLoginSurface()) return false;
  if (
    pathname.includes('/auth')
    || pathname.includes('/login')
    || pathname.includes('/signin')
    || pathname.includes('/accounts')
  ) {
    return false;
  }
  return true;
}

function collectVisibleTextSnapshot() {
  return collectUniqueElements(
    ['nav','aside','main','header','a[href]','button','[role="button"]','[tabindex]']
      .flatMap((s) => Array.from(document.querySelectorAll(s)))
  )
    .filter((el) => isVisible(el))
    .map((el) => buttonDescriptorText(el))
    .filter(Boolean)
    .join(' ');
}

function isAuthenticated() {
  if (hasSignedInToast()) return true;

  if (!location.pathname.startsWith('/app')) return false;
  if (hasVisibleLoginSurface()) return false;

  const visibleText = collectVisibleTextSnapshot();
  const matched = AUTHENTICATED_APP_LABELS.filter((label) => visibleText.includes(label));
  return matched.length >= 3;
}

function collectScopedActions(root) {
  const primary = Array.from((root || document).querySelectorAll(ACTION_SELECTORS.join(',')));
  const fallback = Array.from((root || document).querySelectorAll('[tabindex],div,span,li,section,article'))
    .map((el) => findClickableAncestor(el));
  return collectUniqueElements([...primary, ...fallback]).filter((el) => isActionLikeElement(el));
}

function findSignInButton(emailInput, passInput) {
  const roots = [];
  let cur = (passInput || emailInput)?.parentElement;
  while (cur && cur !== document.body) {
    roots.push(cur);
    if (cur.matches?.('form,[role="dialog"],[aria-modal="true"],main,section,article')) break;
    cur = cur.parentElement;
  }
  roots.push(document);

  for (const root of roots) {
    const buttons = collectScopedActions(root)
      .filter((el) => !isThirdPartyAuthAction(el) && !isEmailAuthAction(el));

    const exact = buttons.find((el) => {
      const t = buttonDescriptorText(el) || buttonText(el);
      return t === 'sign in' || t === 'log in' || t === 'login'
        || t === 'continue' || t === 'next' || t === 'submit';
    });
    if (exact) return exact;

    const partial = buttons.find((el) => {
      const t = buttonDescriptorText(el) || buttonText(el);
      return (t.includes('sign in') || t.includes('log in') || t.includes('continue') || t.includes('next'))
        && !t.includes('google') && !t.includes('apple') && !t.includes('email');
    });
    if (partial) return partial;

    const submit = buttons.find((el) => el.type === 'submit');
    if (submit) return submit;
  }
  return null;
}

// ── Authorization ─────────────────────────────────────────────
async function checkAuthorization() {
  const storedTicket = loadStoredTicket();
  if (storedTicket) {
    const activation = await msg({
      type: 'TOOL_HUB_ACTIVATE_LAUNCH',
      toolSlug: TOOL_SLUG,
      hostname: location.hostname,
      pageUrl: location.href,
      extensionTicket: storedTicket,
    });
    if (activation?.ok && activation.authorized) {
      clearTicket();
      return {
        authorized: true,
        prepared: Boolean(activation.prepared),
        expiresAt: Number(activation.expiresAt || 0),
        authTransitionAt: Number(activation.authTransitionAt || 0),
      };
    }
  }
  const response = await msg({
    type: 'TOOL_HUB_GET_LAUNCH_STATE',
    toolSlug: TOOL_SLUG,
    hostname: location.hostname,
    pageUrl: location.href,
  });
  return {
    authorized: Boolean(response?.ok && response.authorized),
    prepared: Boolean(response?.ok && response.authorized && response.prepared),
    expiresAt: Number(response?.ok && response.authorized ? response.expiresAt || 0 : 0),
    authTransitionAt: Number(response?.ok && response.authorized ? response.authTransitionAt || 0 : 0),
  };
}

// ── Credential: fetched once, cache cleared with session ──────
let credFetchPromise = null;

function clearCredentialCache() {
  credFetchPromise = null;
  CTX.credential = null;
}

async function loadCredential() {
  if (CTX.credential) return CTX.credential;
  if (credFetchPromise) return credFetchPromise;
  credFetchPromise = msg({
    type: 'TOOL_HUB_GET_CREDENTIAL',
    toolSlug: TOOL_SLUG,
    hostname: location.hostname,
    pageUrl: location.href,
    extensionTicket: loadStoredTicket(),
  }).then((response) => {
    credFetchPromise = null;
    if (!response?.ok) throw new Error(response?.error || 'Credential unavailable');
    CTX.credential = response.data?.credential || null;
    return CTX.credential;
  }).catch((error) => {
    credFetchPromise = null;
    throw error;
  });
  return credFetchPromise;
}

// FIX: clearToolSessionSafe runs ONCE per launch (sessionClearDone guard)
// and also clears credential cache so stale creds are never reused
async function clearToolSessionSafe(options = {}) {
  clearOurKeys();
  if (!options.preserveLaunch) {
    try { sessionStorage.removeItem(PREPARED_LAUNCH_KEY); } catch {}
    try { localStorage.removeItem(PREPARED_LAUNCH_KEY); } catch {}
  }
  clearCredentialCache();
  CTX.sessionClearDone = true;
  await msg({
    type: 'TOOL_HUB_CLEAR_TOOL_SESSION',
    toolSlug: TOOL_SLUG,
    preserveLaunch: Boolean(options.preserveLaunch),
  });
}

async function markFreshSessionPrepared() {
  const response = await msg({ type: 'TOOL_HUB_MARK_FRESH_SESSION_PREPARED', toolSlug: TOOL_SLUG });
  if (response?.ok) CTX.prepared = true;
  return Boolean(response?.ok);
}

// ── Stop ──────────────────────────────────────────────────────
function stop(message, phase = P.DONE, options = {}) {
  const preserveLaunch = options.preserveLaunch ?? (phase === P.DONE);
  CTX.phase = phase;
  CTX.stopped = true;
  resetPasswordSubmitGuard();
  clearAuthTransition();
  clearPendingUsageReport();
  if (CTX.timer)    { clearTimeout(CTX.timer);    CTX.timer = null; }
  if (CTX.keepAlive){ clearInterval(CTX.keepAlive); CTX.keepAlive = null; }
  if (CTX.observer) { CTX.observer.disconnect();  CTX.observer = null; } // FIX: stops mutation drain
  if (!preserveLaunch) {
    clearTicket();
    clearUsageTicket();
  }
  clearCheckpoint();
  if (phase === P.DONE) {
    try { sessionStorage.removeItem(GOOGLE_POPUP_ALLOW_RELOAD_KEY); } catch {}
  }
  if (!preserveLaunch) {
    msg({ type: 'TOOL_HUB_REVOKE_ACTIVE_LAUNCH', toolSlug: TOOL_SLUG }).catch(() => {});
  }
  const hideAfterMs = options.hideAfterMs ?? (
    phase === P.DONE
      ? BADGE_HIDE_DONE_MS
      : (phase === P.BLOCKED ? BADGE_HIDE_BLOCKED_MS : 0)
  );
  setStatus(message, { hideAfterMs });
}

function wake(delay = 0) {
  if (CTX.stopped || CTX.timer) return;
  CTX.timer = setTimeout(run, Math.max(0, delay));
}

// FIX: Removed inner setTimeout wrapper — click fires immediately,
// no stacked latency on top of wake(delayAfterClick)
function clickLandingAction(button, nextPhase, delayAfterClick) {
  if (!button) return false;
  const actionKey = landingActionKey(button);
  const now = Date.now();
  const sameActionPending = actionKey
    && actionKey === CTX.lastLandingActionKey
    && CTX.landingActionLockUntil > now;

  if (sameActionPending) {
    setStatus('Waiting for Kling login screen…');
    wake(Math.max(100, CTX.landingActionLockUntil - now));
    return true;
  }

  CTX.lastLandingActionKey   = actionKey;
  CTX.landingActionLockUntil = now + delayAfterClick;
  if (!CTX.stopped) {
    const exactSignInButton = findExactSignInButton();
    const useEnhancedSignInClick = exactSignInButton && button === exactSignInButton;
    const clickOk = useEnhancedSignInClick
      ? enhancedSafeClick(button)
      : safeClick(button);
    if (!clickOk) return false;
  }
  if (nextPhase === P.WAIT_REDIRECT) {
    CTX.submitAt = now;
    CTX.submitKind = isGoogleCredential() ? 'google' : '';
    CTX.submitLockUntil = now + SUBMIT_LOCK_MS;
    writeCheckpoint(P.WAIT_REDIRECT, {
      submitAt: now,
      submitKind: CTX.submitKind || 'unknown',
    });
  }
  CTX.phase = nextPhase;
  wake(delayAfterClick);
  return true;
}

function clickGoogleLandingAction(button, statusMessage) {
  if (CTX.manualGoogleHandoff) {
    setStatus('Waiting for manual Google sign-in…', {
      hideAfterMs: BADGE_HIDE_BLOCKED_MS,
      preserveExistingHideTimer: true,
    });
    wake(1000);
    return true;
  }
  if (!button) return false;
  if (!ensureKlingGooglePopupsAllowed()) {
    wake(300);
    return true;
  }
  const actionKey = landingActionKey(button);
  const now = Date.now();
  const sameActionPending = actionKey
    && actionKey === CTX.lastLandingActionKey
    && CTX.landingActionLockUntil > now;

  if (sameActionPending) {
    setStatus('Waiting for Google sign-in to open…');
    wake(Math.max(100, CTX.landingActionLockUntil - now));
    return true;
  }

  CTX.lastLandingActionKey = actionKey;
  CTX.landingActionLockUntil = now + EMAIL_CHOOSER_WAIT_MS;

  const clickTarget = findClickableAncestor(button) || button;
  const readiness = getClickReadiness(clickTarget);
  debugUsageTelemetry('google_signin_button_click_attempt', {
    readiness,
    phase: CTX.phase,
    url: location.href,
    hasKlingNetworkToast: hasKlingNetworkErrorToast(),
  });
  if (!readiness.ok) {
    setStatus(`Google button not ready (${readiness.reason || readiness.pointerEvents || 'blocked'}). Retrying...`);
    CTX.lastLandingActionKey = '';
    CTX.landingActionLockUntil = 0;
    wake(400);
    return true;
  }
  if (!enhancedSafeClick(clickTarget)) {
    setStatus('Google button click failed. Retrying…');
    CTX.lastLandingActionKey = '';
    CTX.landingActionLockUntil = 0;
    wake(300);
    return true;
  }

  CTX.submitAt = now;
  CTX.submitLockUntil = now + SUBMIT_LOCK_MS;
  startGoogleAuthTransition(now);
  writeCheckpoint(P.WAIT_GOOGLE, {
    submitAt: now,
    submitKind: 'google',
    authTransitionAt: now,
  });
  CTX.phase = P.WAIT_GOOGLE;
  setStatus(statusMessage || 'Opening Google sign-in…');
  wake(AUTH_TRANSITION_INITIAL_QUIET_MS);
  return true;
}

function retryVisibleGoogleLandingButton(statusMessage = 'Clicking visible Google sign-in button…') {
  const now = Date.now();
  if (CTX.googleErrorRetryCount >= MAX_KLING_GOOGLE_ERROR_RETRIES) return false;
  if (
    CTX.googleErrorLastRetryAt
    && now - CTX.googleErrorLastRetryAt < KLING_GOOGLE_ERROR_RETRY_COOLDOWN_MS
  ) {
    setStatus('Waiting before clicking Google sign-in again…');
    wake(Math.max(300, KLING_GOOGLE_ERROR_RETRY_COOLDOWN_MS - (now - CTX.googleErrorLastRetryAt)));
    return true;
  }

  const googleButton = findGoogleAuthButton();
  if (!googleButton) return false;

  CTX.manualGoogleHandoff = false;
  CTX.googleErrorRetryCount += 1;
  CTX.googleErrorLastRetryAt = now;
  CTX.submitLockUntil = 0;
  clearAuthTransition();
  clearCheckpoint();
  CTX.lastLandingActionKey = '';
  CTX.landingActionLockUntil = 0;
  setStatus(`${statusMessage} (${CTX.googleErrorRetryCount}/${MAX_KLING_GOOGLE_ERROR_RETRIES})`);
  clickGoogleLandingAction(googleButton, statusMessage);
  return true;
}

// ── Runner ────────────────────────────────────────────────────
async function run() {
  CTX.timer = null;
  if (CTX.stopped || CTX.busy) return;
  const now = Date.now();
  if (now - CTX.lastRunAt < MIN_RUN_GAP_MS) {
    wake(MIN_RUN_GAP_MS - (now - CTX.lastRunAt));
    return;
  }
  CTX.lastRunAt = now;
  CTX.busy = true;
  try { await tick(); }
  catch (error) { setStatus(`Error: ${error?.message || 'Unknown'}`); wake(2000); }
  finally { CTX.busy = false; }
}

async function tick() {
  if (isAuthenticated()) {
    CTX.manualGoogleHandoff = false;
    stop(buildSignedInStatusMessage(), P.DONE);
    return;
  }

  switch (CTX.phase) {

    // ── BOOT ──────────────────────────────────────────────────
    case P.BOOT: {
      CTX.ticket = captureTicket();
      const checkpoint = readCheckpoint();
      if (checkpoint?.phase === P.WAIT_GOOGLE || (checkpoint?.phase === P.WAIT_REDIRECT && checkpoint.submitKind === 'google')) {
        resumeGoogleAuthTransition(Number(checkpoint.authTransitionAt || checkpoint.submitAt || Date.now()));
        setStatus('Resuming after login redirect…');
        CTX.submitAt       = checkpoint.submitAt || Date.now();
        CTX.submitLockUntil = Date.now() + SUBMIT_LOCK_MS;
        CTX.phase = P.WAIT_GOOGLE;
        wake(AUTH_TRANSITION_INITIAL_QUIET_MS);
        return;
      }
      if (checkpoint?.phase === P.WAIT_REDIRECT) {
        setStatus('Resuming after login redirect…');
        CTX.submitAt       = checkpoint.submitAt || Date.now();
        CTX.submitLockUntil = Date.now() + SUBMIT_LOCK_MS;
        CTX.submitKind     = checkpoint.submitKind || 'password';
        CTX.phase = P.WAIT_REDIRECT;
        wake(CHECKPOINT_RESUME_MS);  // 400ms — page already loaded
        return;
      }
      CTX.phase = P.AUTHORIZE;
      wake(0);
      return;
    }

    // ── AUTHORIZE ─────────────────────────────────────────────
    case P.AUTHORIZE: {
      setStatus('Checking dashboard authorization…');
      let auth;
      try { auth = await checkAuthorization(); }
      catch { auth = { authorized: false, prepared: false, expiresAt: 0 }; }

      CTX.authorized = Boolean(auth.authorized);
      CTX.prepared   = Boolean(auth.prepared);
      CTX.expiresAt  = Number(auth.expiresAt || 0);
      CTX.authTransitionAt = Number(auth.authTransitionAt || CTX.authTransitionAt || 0);
      CTX.authTransitionActive = hasRecentAuthTransition();

      if (!CTX.authorized) {
        if (isGoogleAuthTransitionPending()) {
          setStatus('Google sign-in is still completing…');
          wake(AUTH_TRANSITION_POLL_MS);
          return;
        }
        CTX.launchRetries += 1;
        if (CTX.launchRetries > MAX_LAUNCH_RETRIES) {
          stop('Open this tool from the dashboard first.', P.BLOCKED);
          return;
        }
        setStatus(`Waiting for dashboard launch (${CTX.launchRetries}/${MAX_LAUNCH_RETRIES})…`);
        wake(LAUNCH_RETRY_DELAY_MS);
        return;
      }

      CTX.launchRetries = 0;

      if (isGoogleAuthTransitionPending() && !CTX.manualGoogleHandoff) {
        CTX.phase = P.WAIT_GOOGLE;
        wake(AUTH_TRANSITION_POLL_MS);
        return;
      }

      // Only prepare a fresh browser session before login. If Kling is already
      // authenticated, clearing site data here would log the working session out.
      if (CTX.expiresAt && !CTX.prepared && !CTX.sessionClearDone) {
        if (isAuthenticated()) {
          setStatus('Kling session already active — keeping it signed in.');
          await markFreshSessionPrepared();
          CTX.phase = P.DONE;
          stop(buildSignedInStatusMessage(), P.DONE);
          return;
        }
        setStatus('Preparing fresh Kling session…');
        await clearToolSessionSafe({ preserveLaunch: true });
        await markFreshSessionPrepared();
        if (shouldRedirectToApp()) {
          location.replace(LOGIN_URL);
          return;
        }
      }

      if (shouldRedirectToApp()) {
        setStatus('Redirecting to Kling app…');
        location.replace(LOGIN_URL);
        return;
      }

      CTX.phase = P.LOAD_CRED;
      wake(0);
      return;
    }

    // ── LOAD_CRED ─────────────────────────────────────────────
    case P.LOAD_CRED: {
      setStatus('Fetching credentials…');
      try {
        const credential = await loadCredential();
        if (!credential?.loginIdentifier || (!credential?.password && !isGoogleCredential())) {
          setStatus('Credential missing. Check the dashboard.');
          wake(3000);
          return;
        }
        if (credential?.id) {
          setStatus(`Using ${formatResolvedCredentialLabel(credential)}`);
        }
      } catch (error) {
        const message = error?.message || 'Unavailable';
        if (message.toLowerCase().includes('open this tool from the dashboard first')) {
          CTX.authorized = false;
          CTX.prepared   = false;
          CTX.expiresAt  = 0;
          CTX.phase = P.AUTHORIZE;
          setStatus('Launch expired. Re-checking authorization…');
          wake(LAUNCH_RETRY_DELAY_MS);
          return;
        }
        setStatus(`Credential error: ${message}`);
        wake(3000);
        return;
      }
      CTX.phase = P.OPEN_LANDING;
      wake(0);
      return;
    }

    // ── OPEN_LANDING ──────────────────────────────────────────
    case P.OPEN_LANDING: {
      if (isGoogleCredential() && !CTX.manualGoogleHandoff && isGoogleAuthTransitionPending()) {
        CTX.phase = P.WAIT_GOOGLE;
        const remaining = Math.max(1, Math.round(getGoogleAuthTransitionRemainingMs() / 1000));
        setStatus(`Waiting for Google OAuth to finish… (${remaining}s)`);
        wake(AUTH_TRANSITION_POLL_MS);
        return;
      }

      if (isGoogleCredential()) {
        const googleButton = findGoogleAuthButton();
        if (googleButton) {
          if (CTX.manualGoogleHandoff) {
            if (findGoogleAuthButton() && retryVisibleGoogleLandingButton('Clicking visible Google sign-in button…')) {
              return;
            }
            setStatus('Waiting for manual Google sign-in…', {
              hideAfterMs: BADGE_HIDE_BLOCKED_MS,
              preserveExistingHideTimer: true,
            });
            wake(1000);
            return;
          }
          clickGoogleLandingAction(googleButton, 'Opening Google sign-in…');
          return;
        }
      }

      if (hasLoginForm()) {
        CTX.phase = P.FILL;
        wake(0);
        return;
      }

      const emailButton = findEmailChooserButton();
      if (emailButton) {
        setStatus('Opening email sign-in…');
        clickLandingAction(emailButton, P.FILL, EMAIL_CHOOSER_WAIT_MS);  // 600ms
        return;
      }

      const signInButton = findLandingEntryButton();
      if (signInButton) {
        setStatus('Opening Kling sign-in…');
        clickLandingAction(signInButton, P.OPEN_LANDING, LANDING_RETRY_DELAY_MS);  // 500ms
        return;
      }

      if (shouldRedirectToApp()) {
        setStatus('Redirecting to Kling app…');
        location.replace(LOGIN_URL);
        return;
      }

      setStatus('Waiting for Kling login screen…');
      wake(400);
      return;
    }

    // ── FILL ──────────────────────────────────────────────────
    case P.FILL: {
      const emailInput = findInput(EMAIL_SELS);
      const passInput  = findPrimaryPasswordInput();

      if (isGoogleCredential() && !CTX.manualGoogleHandoff && isGoogleAuthTransitionPending()) {
        CTX.phase = P.WAIT_GOOGLE;
        const remaining = Math.max(1, Math.round(getGoogleAuthTransitionRemainingMs() / 1000));
        setStatus(`Waiting for Google OAuth to finish… (${remaining}s)`);
        wake(AUTH_TRANSITION_POLL_MS);
        return;
      }

      if (isGoogleCredential()) {
        const googleButton = findGoogleAuthButton();
        if (googleButton) {
          if (CTX.manualGoogleHandoff) {
            if (findGoogleAuthButton() && retryVisibleGoogleLandingButton('Clicking visible Google sign-in button…')) {
              return;
            }
            setStatus('Waiting for manual Google sign-in…', {
              hideAfterMs: BADGE_HIDE_BLOCKED_MS,
              preserveExistingHideTimer: true,
            });
            wake(1000);
            return;
          }
          clickGoogleLandingAction(googleButton, 'Continuing with Google…');
          return;
        }
      }

      suppressPasswordReveal(passInput);

      if (!emailInput && !passInput) {
        CTX.phase = P.OPEN_LANDING;
        wake(200);
        return;
      }

      if (!CTX.credential?.loginIdentifier || (!CTX.credential?.password && !isGoogleCredential())) {
        CTX.phase = P.LOAD_CRED;
        wake(0);
        return;
      }

      if (emailInput && !valuesMatch(emailInput.value, CTX.credential.loginIdentifier)) {
        emailInput.focus();
      }

      const emailReady = !emailInput || await ensureFieldValue(emailInput, CTX.credential.loginIdentifier);

      if (passInput && !valuesMatch(passInput.value, CTX.credential.password)) {
        passInput.focus();
      }

      const passwordReady = !passInput || await ensureFieldValue(passInput, CTX.credential.password);

      if (!emailReady || !passwordReady) {
        if (passInput) {
          resetPasswordSubmitGuard();
        }
        setStatus(passwordReady ? 'Syncing email field…' : 'Syncing password field…');
        wake(FIELD_FILL_DELAY_MS);
        return;
      }

      const hasPasswordStep = Boolean(passInput);
      if (hasPasswordStep) {
        const passwordSubmitGuardKey = buildPasswordSubmitGuardKey(emailInput, passInput);
        const now = Date.now();
        if (CTX.passwordSubmitGuardKey !== passwordSubmitGuardKey || CTX.passwordSubmitGuardUntil <= now) {
          CTX.passwordSubmitGuardKey = passwordSubmitGuardKey;
          CTX.passwordSubmitGuardUntil = now + PASSWORD_SUBMIT_DELAY_MS;
        }
      } else {
        resetPasswordSubmitGuard();
      }
      const submitDelayMs = hasPasswordStep ? PASSWORD_SUBMIT_DELAY_MS : EMAIL_SUBMIT_DELAY_MS;
      setStatus(
        hasPasswordStep
          ? 'Password filled. Re-checking before Sign In…'
          : 'Email filled. Continuing…'
      );
      CTX.phase = P.SUBMIT;
      wake(submitDelayMs);
      return;
    }

    // ── SUBMIT ────────────────────────────────────────────────
    case P.SUBMIT: {
      if (Date.now() < CTX.submitLockUntil) {
        setStatus('Waiting for sign-in response…');
        wake(500);
        return;
      }

      const emailInput = findInput(EMAIL_SELS);
      const passInput  = findPrimaryPasswordInput();

      suppressPasswordReveal(passInput);

      if (emailInput && !valuesMatch(emailInput.value, CTX.credential?.loginIdentifier)) {
        resetPasswordSubmitGuard();
        CTX.phase = P.FILL; wake(0); return;
      }
      if (passInput && !valuesMatch(passInput.value, CTX.credential?.password)) {
        resetPasswordSubmitGuard();
        CTX.phase = P.FILL; wake(0); return;
      }

      if (passInput && Date.now() < CTX.passwordSubmitGuardUntil) {
        setStatus('Password filled. Re-checking before Sign In…');
        wake(Math.max(50, CTX.passwordSubmitGuardUntil - Date.now()));
        return;
      }

      const signInButton = findSignInButton(emailInput, passInput);
      if (!signInButton) {
        setStatus('Sign In button not found. Retrying…');
        wake(400);
        return;
      }

      const nextSubmitKind = emailInput && !passInput ? 'email' : (passInput ? 'password' : 'unknown');
      const nextSubmitActionKey = buildSubmitActionKey(nextSubmitKind, emailInput, passInput, signInButton);
      const now = Date.now();
      const sameSubmitPending = nextSubmitActionKey
        && nextSubmitActionKey === CTX.lastSubmitActionKey
        && CTX.submitActionLockUntil > now;
      if (sameSubmitPending) {
        setStatus(nextSubmitKind === 'email' ? 'Waiting for password step…' : 'Waiting to retry Sign In…');
        wake(350);
        return;
      }
      setStatus(nextSubmitKind === 'email' ? 'Continuing to password step…' : 'Clicking Sign In…');

      writeCheckpoint(P.WAIT_REDIRECT, { submitAt: now, submitKind: nextSubmitKind });

      if (submitSignInStep(signInButton, passInput || emailInput)) {
        resetPasswordSubmitGuard();
        const submitActionLockMs = nextSubmitKind === 'email' ? EMAIL_STEP_GRACE_MS : SUBMIT_LOCK_MS;
        CTX.submitAt       = now;
        CTX.submitKind     = nextSubmitKind;
        CTX.submitLockUntil = now + SUBMIT_LOCK_MS;
        CTX.lastSubmitActionKey = nextSubmitActionKey;
        CTX.submitActionLockUntil = now + submitActionLockMs;
        CTX.phase = P.WAIT_REDIRECT;
        wake(POST_SUBMIT_WAIT_MS);  // 300ms — was 700ms
      } else {
        clearCheckpoint();
        wake(300);
      }
      return;
    }

    // ── WAIT_GOOGLE ────────────────────────────────────────────
    case P.WAIT_GOOGLE: {
      const elapsed = getGoogleAuthTransitionElapsedMs();

      if (isAuthenticated()) {
        CTX.manualGoogleHandoff = false;
        CTX.googleErrorRetryCount = 0;
        CTX.googleErrorLastRetryAt = 0;
        stop(buildSignedInStatusMessage(), P.DONE);
        return;
      }

      if (elapsed < AUTH_TRANSITION_INITIAL_QUIET_MS) {
        const remaining = Math.max(1, Math.round((AUTH_TRANSITION_INITIAL_QUIET_MS - elapsed) / 1000));
        setStatus(`Waiting for Google to process sign-in… (${remaining}s)`);
        wake(AUTH_TRANSITION_POLL_MS);
        return;
      }

      if (hasKlingNetworkErrorToast()) {
        if (findGoogleAuthButton() && retryVisibleGoogleLandingButton('Clicking visible Google sign-in button…')) {
          return;
        }
        CTX.manualGoogleHandoff = true;
        CTX.submitLockUntil = 0;
        clearAuthTransition();
        clearCheckpoint();
        setStatus(
          'Google sign-in failed on Kling side. Click Sign in with Google manually to continue.',
          { hideAfterMs: BADGE_HIDE_BLOCKED_MS }
        );
        wake(1500);
        return;
      }

      if (hasLoginForm()) {
        const bodyText = `${document.body?.innerText || ''}`.toLowerCase();
        const hasError = [
          'incorrect password', 'invalid password', 'wrong password',
          'invalid email', 'account not found', 'try again', 'password is incorrect',
          'couldn’t sign you in', "couldn't sign you in", 'google rejected',
        ].some((token) => bodyText.includes(token));
        if (hasError) {
          clearAuthTransition();
          stop('Login failed. Check credentials in the dashboard.', P.BLOCKED);
          return;
        }
      }

      if (hasSignedInToast()) {
        setStatus('Kling accepted login — waiting for app...');
        wake(AUTH_TRANSITION_POLL_MS);
        return;
      }

      if (elapsed >= AUTH_TRANSITION_TIMEOUT_MS) {
        setStatus('Google sign-in timed out. Retrying…');
        CTX.submitLockUntil = 0;
        clearAuthTransition();
        clearCheckpoint();
        CTX.lastLandingActionKey = '';
        CTX.landingActionLockUntil = 0;
        CTX.phase = P.OPEN_LANDING;
        wake(0);
        return;
      }

      const remaining = Math.max(1, Math.round(getGoogleAuthTransitionRemainingMs() / 1000));
      setStatus(`Waiting for Google OAuth to finish… (${remaining}s)`);
      wake(AUTH_TRANSITION_POLL_MS);
      return;
    }

    // ── WAIT_REDIRECT ─────────────────────────────────────────
    case P.WAIT_REDIRECT: {
      const elapsed = Date.now() - CTX.submitAt;
      const emailInput = findInput(EMAIL_SELS);
      const passInput = findPrimaryPasswordInput();
      const hasCredentialSurface = Boolean(emailInput || passInput);
      const stillOnEmailOnlyStep = Boolean(emailInput && !passInput);
      const waitingForPasswordStep = CTX.submitKind === 'email' && elapsed <= EMAIL_STEP_GRACE_MS;

      if (isAuthenticated()) {
        CTX.manualGoogleHandoff = false;
        CTX.googleErrorRetryCount = 0;
        CTX.googleErrorLastRetryAt = 0;
        stop(buildSignedInStatusMessage(), P.DONE);
        return;
      }

      if (CTX.submitKind === 'google' && hasKlingNetworkErrorToast()) {
        if (findGoogleAuthButton() && retryVisibleGoogleLandingButton('Clicking visible Google sign-in button…')) {
          return;
        }
        CTX.manualGoogleHandoff = true;
        CTX.submitLockUntil = 0;
        clearCheckpoint();
        setStatus(
          'Google sign-in failed on Kling side. Click Sign in with Google manually to continue.',
          { hideAfterMs: BADGE_HIDE_BLOCKED_MS }
        );
        wake(1500);
        return;
      }

      if (hasSignedInToast()) {
        setStatus('Kling accepted login — waiting for app...');
        CTX.submitLockUntil = Date.now() + 3000;

        if (shouldRedirectToApp()) {
          location.replace(LOGIN_URL);
          return;
        }

        return;
      }

      // FIX: chooser check guarded with elapsed > 1500ms to avoid
      // premature re-entry while SPA transition is still in progress
      if (
        location.pathname.startsWith('/app')
        && findEmailChooserButton()
        && elapsed > 1500
        && !waitingForPasswordStep
        && !emailInput
        && !passInput
      ) {
        setStatus('Kling reloaded chooser — re-entering…');
        CTX.submitLockUntil        = 0;
        CTX.lastLandingActionKey   = '';   // FIX BUG2 — reset lock so click fires
        CTX.landingActionLockUntil = 0;   // FIX BUG2
        clearCheckpoint();
        CTX.phase = P.OPEN_LANDING;
        wake(0);
        return;
      }

      // Email-only step: password field appeared — fill it
      if (CTX.submitKind === 'email' && passInput) {
        CTX.submitLockUntil = 0;
        clearCheckpoint();
        CTX.phase = P.FILL;
        wake(0);
        return;
      }

      // Error detection after 3 seconds
      if (elapsed > 3000 && hasLoginForm()) {
        const bodyText = `${document.body?.innerText || ''}`.toLowerCase();
        const hasError = [
          'incorrect password', 'invalid password', 'wrong password',
          'invalid email', 'account not found', 'try again', 'password is incorrect',
        ].some((t) => bodyText.includes(t));
        if (hasError) {
          stop('Login failed. Check credentials in the dashboard.', P.BLOCKED);
          return;
        }
      }

      // Email step grace timeout
      if (CTX.submitKind === 'email' && stillOnEmailOnlyStep && elapsed > EMAIL_STEP_GRACE_MS) {
        CTX.submitLockUntil = 0;
        clearCheckpoint();
        CTX.phase = P.FILL;
        wake(0);
        return;
      }

      // Stay on Kling's auth route while a credential form is still visible.
      // Redirecting to /app too early refreshes the password step and loses progress.
      if (!location.pathname.startsWith('/app')) {
        if (hasCredentialSurface) {
          setStatus(
            CTX.submitKind === 'password'
              ? 'Waiting for password submit to complete…'
              : 'Waiting for Kling login flow…'
          );
          wake(450);
          return;
        }

        if (elapsed < 1200) {
          wake(300);
          return;
        }

        if (shouldRedirectToApp()) {
          setStatus('Post-login redirect to public page — going to app…');
          location.replace(LOGIN_URL);
          return;
        }

        setStatus('Waiting for Kling login flow…');
        wake(450);
        return;
      }

      // Grace period expired
      if (elapsed > POST_LOGIN_GRACE_MS) {
        if (hasLoginForm() || findEmailChooserButton()) {
          setStatus('Session not held — re-entering…');
          CTX.submitLockUntil        = 0;
          CTX.lastLandingActionKey   = '';   // FIX BUG4
          CTX.landingActionLockUntil = 0;   // FIX BUG4
          clearCheckpoint();
          CTX.phase = hasLoginForm() ? P.FILL : P.OPEN_LANDING;
          wake(0);
          return;
        }
        if (elapsed > POST_LOGIN_GRACE_MS * 1.5) {
          setStatus('Login timed out. Retrying…');
          CTX.submitLockUntil = 0;
          clearCheckpoint();
          CTX.phase = P.FILL;
          wake(0);
          return;
        }
      }

      const remaining = Math.max(1, Math.round((POST_LOGIN_GRACE_MS - elapsed) / 1000));
      setStatus(`Waiting for Kling to load… (${remaining}s)`);
      wake(600);
      return;
    }

    // FIX BUG1: missing default case — switch was not closed, causing syntax error
    case P.DONE:
    case P.BLOCKED:
    default:
      return;
  }
}

// ── MutationObserver ──────────────────────────────────────────
// attributes: false — avoids triggering on Kling canvas/animation attribute changes
// stop() disconnects observer on DONE/BLOCKED to prevent CPU drain after login
function onMutation() {
  if (CTX.stopped) return;
  if (isGoogleAuthTransitionPending()) return;
  const now = Date.now();
  if (now - CTX.lastMutationAt < MUTATION_DEBOUNCE_MS) return;
  CTX.lastMutationAt = now;
  if ([P.OPEN_LANDING, P.FILL, P.SUBMIT, P.WAIT_REDIRECT].includes(CTX.phase)) {
    wake(100);
  }
}

// ── Start ─────────────────────────────────────────────────────
function start() {
  startUsageTracking();
  ensureBadge();
  CTX.ticket = captureTicket();
  CTX.observer = new MutationObserver(onMutation);
  CTX.observer.observe(document.body || document.documentElement, {
    childList: true, subtree: true, attributes: false,
  });
  CTX.keepAlive = setInterval(() => {
    if (!CTX.stopped && !CTX.busy && !CTX.timer && !isGoogleAuthTransitionPending()) wake(0);
  }, KEEP_ALIVE_MS);
  wake(0);
}

start();
