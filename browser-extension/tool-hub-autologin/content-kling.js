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

// ── Timing constants ──────────────────────────────────────────
const KEEP_ALIVE_MS          = 10000;
const MUTATION_DEBOUNCE_MS   = 200;    // was 250
const SUBMIT_LOCK_MS         = 12000;
const POST_LOGIN_GRACE_MS    = 7000;   // was 10000
const AUTH_TRANSITION_TIMEOUT_MS = 45000;
const AUTH_TRANSITION_INITIAL_QUIET_MS = 3000;
const AUTH_TRANSITION_POLL_MS = 2000;
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
  lastGenerateAt      : 0,
  pendingReportTimer  : null,
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

  const match = normalizedValue.match(/(\d+(?:\.\d+)?)\s*([km])?/i);
  if (!match?.[1]) return null;

  const numericValue = Number(match[1]);
  if (!Number.isFinite(numericValue)) return null;

  const suffix = `${match[2] || ''}`.toLowerCase();
  if (suffix === 'k') return numericValue * 1000;
  if (suffix === 'm') return numericValue * 1000000;
  return numericValue;
}

function parseExpectedCreditsFromGenerateText(value) {
  const normalized = normalizeGenerateActionLabel(value);
  if (!normalized) return null;
  const match = normalized.match(/(?:^|\s)(\d+(?:\.\d+)?)\s+generate(?:\s|$)/i);
  return match ? Number(match[1]) : null;
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

  const splitCandidates = rawCandidates
    .filter(Boolean)
    .flatMap((value) => `${value}`.split(/\r?\n+/))
    .map((value) => normalizeGenerateActionLabel(value))
    .filter(Boolean);

  return collectUniqueElements(splitCandidates).sort((left, right) => left.length - right.length);
}

function buildLocalDateValue(offsetDays = 0) {
  const date = new Date();
  date.setHours(12, 0, 0, 0);
  date.setDate(date.getDate() + offsetDays);
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

function readPromptText() {
  const input = findVisiblePromptField();
  if (!input) return '';
  const value = 'value' in input ? input.value : (input.innerText || input.textContent || '');
  return `${value || ''}`.trim();
}

function readSelectedModelLabel() {
  const text = normalizeSpace(document.body?.innerText || '');
  const patterns = [
    /\b(image\s*\d+(?:\.\d+)?(?:\s*[a-z][a-z0-9-]*)?)/i,
    /\b(video\s*\d+(?:\.\d+)?\s*(?:turbo|master|pro)?)/i,
    /\b(motion\s*control)\b/i,
    /\bavatar\b/i,
    /\b(master|turbo)\b/i,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]) return match[1].trim();
    if (match?.[0]) return match[0].trim();
  }
  return '';
}

function readGenerationMode() {
  const pathname = `${location.pathname || ''}`.toLowerCase();
  if (pathname.includes('/image/')) return 'image';
  if (pathname.includes('/video/')) return 'video';
  if (pathname.includes('/motion/')) return 'motion-control';
  if (pathname.includes('/avatar/')) return 'avatar';

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
    if (!/(^|\s)generate($|\s)/.test(text)) continue;
    if (text.includes('create in omni')) continue;

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
    if (text.includes('generate')) {
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

  return {
    durationLabel: durationMatch?.[0] || '',
    resolutionLabel: resolutionMatch?.[0] || '',
    aspectRatioLabel: ratioMatch?.[0] || '',
    scopeText,
  };
}

function readVisibleCreditBalance() {
  const creditCandidates = [];

  for (const el of collectUniqueElements(Array.from(document.querySelectorAll('div,span,button,strong,b')))) {
    if (!isVisible(el)) continue;
    if (el.closest?.('#rmw-kling-badge')) continue;

    const text = `${el.textContent || ''}`.trim();
    if (!text || text.length > 32) continue;
    if (text.includes('-')) continue;

    const parsedValue = parseCreditNumber(text);
    if (parsedValue == null) continue;

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

  const candidates = collectUniqueElements(Array.from(document.querySelectorAll('div,span,button,strong,b')))
    .filter((el) => isVisible(el))
    .filter((el) => /^\d+(?:\.\d+)?$/.test(`${el.textContent || ''}`.trim()))
    .map((el) => {
      const rect = el.getBoundingClientRect();
      let score = 0;
      if (rect.left < 220) score += 3;
      if (rect.top > window.innerHeight * 0.55) score += 3;
      if (rect.width < 80) score += 1;
      const parentText = normalizeSpace(el.parentElement?.innerText || '');
      if (parentText.includes('upgrade')) score += 2;
      return { el, score };
    })
    .sort((left, right) => right.score - left.score);

  return candidates.length ? parseCreditNumber(candidates[0].el.textContent) : null;
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

function buildGenerateUsageSnapshot(generateButton) {
  const buttonLabel = readGenerateButtonLabel(generateButton);
  const controlContext = readGenerateControlContext(generateButton);
  const generationMode = readGenerationMode();
  const creditsBefore = readVisibleCreditBalance();
  const klingAccountLabel = readTrackedKlingAccountLabel();
  const credentialUsageMetadata = readCredentialUsageMetadata();
  return {
    eventType: 'generate_click',
    eventDate: buildLocalDateValue(),
    status: 'captured',
    promptText: readPromptText(),
    modelLabel: readSelectedModelLabel(),
    durationLabel: controlContext.durationLabel,
    resolutionLabel: controlContext.resolutionLabel,
    expectedCredits: readExpectedCreditsFromGenerateButton(generateButton),
    creditsBefore,
    metadata: {
      actionLabel: buttonLabel,
      aspectRatioLabel: controlContext.aspectRatioLabel,
      generationMode,
      pathname: location.pathname,
      controlContext: controlContext.scopeText,
      currentCredits: creditsBefore,
      klingAccountLabel,
      credentialId: credentialUsageMetadata.credentialId,
      linkedCredentialId: credentialUsageMetadata.linkedCredentialId,
      credentialLabel: credentialUsageMetadata.credentialLabel,
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
    metadata: snapshot.metadata,
  });

  if (response?.contextInvalidated) {
    throw buildExtensionContextInvalidatedError(response.error);
  }

  if (!response?.ok) {
    throw new Error(response?.error || 'Usage event request failed');
  }

  return response;
}

function finalizeGenerateUsageSnapshot(snapshot, creditsAfter, settlementReason) {
  snapshot.creditsAfter = creditsAfter;
  snapshot.creditsBurned = (
    snapshot.creditsBefore != null && creditsAfter != null
      ? Math.max(0, snapshot.creditsBefore - creditsAfter)
      : snapshot.expectedCredits
  );
  snapshot.metadata = {
    ...(snapshot.metadata || {}),
    currentCredits: creditsAfter != null ? creditsAfter : snapshot.creditsBefore,
    settlementReason,
  };
  return snapshot;
}

function waitForGenerateUsageSettlement(snapshot) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    let lastObservedCredits = snapshot.creditsBefore;
    let settled = false;
    let intervalId = 0;

    const finish = (creditsAfter, settlementReason) => {
      if (settled) return;
      settled = true;
      if (intervalId) {
        clearInterval(intervalId);
      }
      resolve(finalizeGenerateUsageSnapshot(snapshot, creditsAfter, settlementReason));
    };

    const check = () => {
      const creditsAfter = readVisibleCreditBalance();
      if (creditsAfter != null) {
        lastObservedCredits = creditsAfter;
      }

      if (
        snapshot.creditsBefore != null
        && creditsAfter != null
        && creditsAfter < snapshot.creditsBefore
      ) {
        finish(creditsAfter, 'balance_decreased');
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
  const dedupeKey = JSON.stringify([
    snapshot.promptText,
    snapshot.modelLabel,
    snapshot.durationLabel,
    snapshot.resolutionLabel,
    snapshot.expectedCredits,
  ]);
  const now = Date.now();
  if (USAGE_CTX.lastGenerateKey === dedupeKey && now - USAGE_CTX.lastGenerateAt < 1500) {
    return;
  }

  USAGE_CTX.lastGenerateKey = dedupeKey;
  USAGE_CTX.lastGenerateAt = now;
  if (USAGE_CTX.pendingReportTimer) {
    clearTimeout(USAGE_CTX.pendingReportTimer);
    USAGE_CTX.pendingReportTimer = null;
  }

  USAGE_CTX.pendingReportTimer = window.setTimeout(() => {
    USAGE_CTX.pendingReportTimer = null;
    resolveTrackedKlingAccountLabel()
      .then((klingAccountLabel) => {
        snapshot.metadata = {
          ...(snapshot.metadata || {}),
          klingAccountLabel: klingAccountLabel || snapshot.metadata?.klingAccountLabel || '',
        };
        return reportKlingUsage({
          ...snapshot,
          status: 'submitted',
          metadata: {
            ...(snapshot.metadata || {}),
            stage: 'submitted',
          },
        });
      })
      .then((response) => {
        const eventId = Number(response?.event?.id || 0);
        if (eventId > 0) {
          snapshot.eventId = eventId;
        }
        setStatus(`Usage saved: ${eventId > 0 ? `#${eventId}` : 'submitted'}`, { hideAfterMs: 3500 });
        return waitForGenerateUsageSettlement(snapshot);
      })
      .then((settledSnapshot) => reportKlingUsage({
        ...settledSnapshot,
        status: 'settled',
        metadata: {
          ...(settledSnapshot.metadata || {}),
          stage: 'settled',
        },
      }))
      .then((response) => {
        const eventId = Number(response?.event?.id || snapshot.eventId || 0);
        setStatus(`Usage updated: ${eventId > 0 ? `#${eventId}` : 'settled'}`, { hideAfterMs: 3500 });
      })
      .catch((error) => {
        if (error?.contextInvalidated || isExtensionContextInvalidatedError(error?.message)) {
          return;
        }
        setStatus(`Usage tracking failed: ${error?.message || 'Unknown error'}`);
        console.warn('[RMW Kling] Usage report failed', error);
      });
  }, 1200);
}

function clearPendingUsageReport() {
  if (USAGE_CTX.pendingReportTimer) {
    clearTimeout(USAGE_CTX.pendingReportTimer);
    USAGE_CTX.pendingReportTimer = null;
  }
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
  if (USAGE_CTX.listenerAttached) return;
  USAGE_CTX.listenerAttached = true;
  document.addEventListener('pointerdown', handleGenerateInteraction, true);
  document.addEventListener('click', handleGenerateInteraction, true);
  window.addEventListener('pagehide', clearPendingUsageReport, true);
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
  const text = normalizeSpace(document.body?.innerText || '');
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
  if (!enhancedSafeClick(clickTarget)) {
    setStatus('Google button click failed. Retrying…');
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

      // FIX: sessionClearDone guard — only clears cookies on FIRST launch prep
      if (CTX.expiresAt && !CTX.prepared && !CTX.sessionClearDone) {
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
        stop(buildSignedInStatusMessage(), P.DONE);
        return;
      }

      if (CTX.submitKind === 'google' && hasKlingNetworkErrorToast()) {
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
