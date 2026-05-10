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
const KEEP_ALIVE_MS          = 1500;   // was 3000
const MUTATION_DEBOUNCE_MS   = 200;    // was 250
const SUBMIT_LOCK_MS         = 12000;
const POST_LOGIN_GRACE_MS    = 7000;   // was 10000
const GOOGLE_POPUP_GRACE_MS  = 30000;
const EMAIL_STEP_GRACE_MS    = 1800;   // was 3500
const MIN_RUN_GAP_MS         = 150;    // was 200
const LAUNCH_RETRY_DELAY_MS  = 400;
const MAX_LAUNCH_RETRIES     = 6;
const FIELD_FILL_DELAY_MS    = 60;     // was 80
const LANDING_CLICK_DELAY_MS = 0;      // was 60 — removed double-delay wrapper
const LANDING_RETRY_DELAY_MS = 500;    // was 1200
const EMAIL_CHOOSER_WAIT_MS  = 600;    // was 1500
const CHECKPOINT_RESUME_MS   = 400;    // was 1200
const POST_SUBMIT_WAIT_MS    = 300;    // was 700

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
  submitLockUntil      : 0,
  submitAt             : 0,
  submitKind           : '',
  launchRetries        : 0,
  lastRunAt            : 0,
  lastMutationAt       : 0,
  ticket               : '',
  authorized           : false,
  prepared             : false,
  expiresAt            : 0,
  lastLandingActionKey : '',
  landingActionLockUntil: 0,
  sessionClearDone     : false,  // FIX: guard against repeated session clearing
  blockedRevealControl : null,
};

const USAGE_CTX = {
  listenerAttached    : false,
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

function setStatus(message) {
  console.debug('[RMW Kling]', message);
  const badge = ensureBadge();
  if (badge) badge.textContent = `Kling Auto-Login\n${message}`;
}

// ── Chrome messaging ──────────────────────────────────────────
function msg(payload) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(payload, (response) => {
      if (chrome.runtime.lastError) {
        resolve({ ok: false, error: chrome.runtime.lastError.message });
        return;
      }
      resolve(response || { ok: false, error: 'No response' });
    });
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
  const keys = [EXTENSION_TICKET_KEY, PREPARED_LAUNCH_KEY, BLOCKED_NOTICE_KEY];
  [sessionStorage, localStorage].forEach((s) => {
    keys.forEach((k) => { try { s.removeItem(k); } catch {} });
  });
}

function parseCreditNumber(value) {
  const match = `${value || ''}`.replace(/,/g, '').match(/(\d+(?:\.\d+)?)/);
  return match ? Number(match[1]) : null;
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
    /\b(video\s*\d+(?:\.\d+)?\s*(?:turbo|master|pro)?)/i,
    /\b(master|turbo)\b/i,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]) return match[1].trim();
    if (match?.[0]) return match[0].trim();
  }
  return '';
}

function findGenerateActionTarget(target) {
  const candidate = findClickableAncestor(target?.nodeType === Node.ELEMENT_NODE ? target : target?.parentElement);
  if (!candidate || !isVisible(candidate) || !isEnabled(candidate)) return null;

  const text = normalizeSpace(buttonDescriptorText(candidate) || buttonText(candidate));
  if (!/(^|\s)(\d+(?:\.\d+)?\s+)?generate$/.test(text)) return null;
  if (text.includes('create in omni')) return null;

  const rect = candidate.getBoundingClientRect();
  if (rect.width < 120 || rect.height < 36) return null;
  if (rect.top < window.innerHeight * 0.45) return null;
  return candidate;
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
  };
}

function readVisibleCreditBalance() {
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

function buildGenerateUsageSnapshot(generateButton) {
  const buttonLabel = normalizeSpace(buttonDescriptorText(generateButton) || buttonText(generateButton));
  const controlContext = readGenerateControlContext(generateButton);
  return {
    eventType: 'generate_click',
    status: 'captured',
    promptText: readPromptText(),
    modelLabel: readSelectedModelLabel(),
    durationLabel: controlContext.durationLabel,
    resolutionLabel: controlContext.resolutionLabel,
    expectedCredits: parseCreditNumber(buttonLabel),
    creditsBefore: readVisibleCreditBalance(),
    metadata: {
      actionLabel: buttonLabel,
      aspectRatioLabel: controlContext.aspectRatioLabel,
      pathname: location.pathname,
    },
  };
}

async function reportKlingUsage(snapshot) {
  const usageTicket = loadStoredUsageTicket();
  if (!usageTicket) return;

  await msg({
    type: 'TOOL_HUB_REPORT_USAGE_EVENT',
    toolSlug: TOOL_SLUG,
    hostname: location.hostname,
    pageUrl: location.href,
    usageTicket,
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
    const creditsAfter = readVisibleCreditBalance();
    snapshot.creditsAfter = creditsAfter;
    snapshot.creditsBurned = (
      snapshot.creditsBefore != null && creditsAfter != null
        ? Math.max(0, snapshot.creditsBefore - creditsAfter)
        : snapshot.expectedCredits
    );
    reportKlingUsage(snapshot).catch(() => {});
  }, 1800);
}

function handleGenerateClick(event) {
  const generateButton = findGenerateActionTarget(event.target);
  if (!generateButton) return;
  scheduleGenerateUsageReport(generateButton);
}

function startUsageTracking() {
  captureTicket();
  if (USAGE_CTX.listenerAttached) return;
  USAGE_CTX.listenerAttached = true;
  document.addEventListener('click', handleGenerateClick, true);
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

function enforcePasswordMask(passInput) {
  if (!passInput) return;
  try {
    if (passInput.type !== 'password') {
      passInput.type = 'password';
    }
    if (passInput.getAttribute('type') !== 'password') {
      passInput.setAttribute('type', 'password');
    }
  } catch {}
}

function handlePasswordRevealAttempt(event) {
  const passInput = findInput(PASS_SELS);
  if (!passInput) return;

  const revealControl = findPasswordRevealControlFromTarget(event.target, passInput);
  if (!revealControl) return;

  disablePasswordRevealControl(revealControl);
  enforcePasswordMask(passInput);
  blockRevealControlEvent(event);
}

function ensurePasswordRevealGuards() {
  if (document.documentElement?.dataset?.rmwKlingRevealGuardAttached === 'true') return;
  document.documentElement.dataset.rmwKlingRevealGuardAttached = 'true';

  ['click', 'mousedown', 'mouseup', 'pointerdown', 'pointerup', 'touchstart', 'touchend', 'keydown', 'keyup']
    .forEach((eventName) => document.addEventListener(eventName, handlePasswordRevealAttempt, true));
}

function suppressPasswordReveal(passInput) {
  if (!passInput) return;

  enforcePasswordMask(passInput);
  const candidates = findPasswordRevealCandidates(passInput);
  candidates.forEach((candidate) => disablePasswordRevealControl(candidate));
  CTX.blockedRevealControl = candidates[0] || null;
}

// ── React-compatible fill ─────────────────────────────────────
function fillField(input, value) {
  if (!input) return;
  const desc = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
  if (desc?.set) desc.set.call(input, value);
  else input.value = value;
  input.setAttribute('value', value);
  ['input', 'change', 'blur'].forEach((e) =>
    input.dispatchEvent(new Event(e, { bubbles: true }))
  );
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
  const text = buttonDescriptorText(el) || buttonText(el);
  return text.includes('google') || text.includes('apple')
    || text.includes('facebook') || text.includes('continue as ');
}

function isEmailAuthAction(el) {
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
  return collectUniqueElements([...primary, ...fallback]).filter((el) => isActionLikeElement(el));
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
    if (isThirdPartyAuthAction(el) || isEmailAuthAction(el)) return false;
    const text = buttonDescriptorText(el) || buttonText(el);
    return text === 'sign in' || text === 'login' || text === 'log in'
      || text.includes('sign in') || text.includes('log in') || text.includes('login');
  });
  if (signInButton) return signInButton;
  return candidates.find((el) => {
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
  return Boolean(findInput(EMAIL_SELS) || findInput(PASS_SELS));
}

function hasVisibleLoginSurface() {
  return Boolean(hasLoginForm() || findEmailChooserButton() || findLandingEntryButton());
}

// FIX: Never redirect if already on /app — prevents reload during transient render
function shouldRedirectToApp() {
  return !location.pathname.startsWith('/app');
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
  CTX.phase = phase;
  CTX.stopped = true;
  if (CTX.timer)    { clearTimeout(CTX.timer);    CTX.timer = null; }
  if (CTX.keepAlive){ clearInterval(CTX.keepAlive); CTX.keepAlive = null; }
  if (CTX.observer) { CTX.observer.disconnect();  CTX.observer = null; } // FIX: stops mutation drain
  clearTicket();
  clearCheckpoint();
  if (!options.preserveLaunch) {
    msg({ type: 'TOOL_HUB_REVOKE_ACTIVE_LAUNCH', toolSlug: TOOL_SLUG }).catch(() => {});
  }
  setStatus(message);
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
  CTX.submitKind = 'google';
  CTX.submitLockUntil = now + SUBMIT_LOCK_MS;
  writeCheckpoint(P.WAIT_REDIRECT, {
    submitAt: now,
    submitKind: 'google',
  });
  CTX.phase = P.WAIT_REDIRECT;
  setStatus(statusMessage || 'Opening Google sign-in…');
  wake(EMAIL_CHOOSER_WAIT_MS);
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
    stop('✓ Signed in successfully', P.DONE);
    return;
  }

  switch (CTX.phase) {

    // ── BOOT ──────────────────────────────────────────────────
    case P.BOOT: {
      CTX.ticket = captureTicket();
      const checkpoint = readCheckpoint();
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

      if (!CTX.authorized) {
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
      if (isGoogleCredential()) {
        const googleButton = findGoogleAuthButton();
        if (googleButton) {
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
      const passInput  = findInput(PASS_SELS);

      if (isGoogleCredential()) {
        const googleButton = findGoogleAuthButton();
        if (googleButton) {
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
        fillField(emailInput, CTX.credential.loginIdentifier);
      }

      if (passInput && !valuesMatch(passInput.value, CTX.credential.password)) {
        passInput.focus();
        fillField(passInput, CTX.credential.password);
      }

      setStatus('Fields filled. Looking for Sign In…');
      CTX.phase = P.SUBMIT;
      wake(FIELD_FILL_DELAY_MS);
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
      const passInput  = findInput(PASS_SELS);

      suppressPasswordReveal(passInput);

      if (emailInput && !valuesMatch(emailInput.value, CTX.credential?.loginIdentifier)) {
        CTX.phase = P.FILL; wake(0); return;
      }
      if (passInput && !valuesMatch(passInput.value, CTX.credential?.password)) {
        CTX.phase = P.FILL; wake(0); return;
      }

      const signInButton = findSignInButton(emailInput, passInput);
      if (!signInButton) {
        setStatus('Sign In button not found. Retrying…');
        wake(400);
        return;
      }

      const nextSubmitKind = emailInput && !passInput ? 'email' : (passInput ? 'password' : 'unknown');
      setStatus(nextSubmitKind === 'email' ? 'Continuing to password step…' : 'Clicking Sign In…');

      writeCheckpoint(P.WAIT_REDIRECT, { submitAt: Date.now(), submitKind: nextSubmitKind });

      if (safeClick(signInButton)) {
        CTX.submitAt       = Date.now();
        CTX.submitKind     = nextSubmitKind;
        CTX.submitLockUntil = Date.now() + SUBMIT_LOCK_MS;
        CTX.phase = P.WAIT_REDIRECT;
        wake(POST_SUBMIT_WAIT_MS);  // 300ms — was 700ms
      } else {
        clearCheckpoint();
        wake(300);
      }
      return;
    }

    // ── WAIT_REDIRECT ─────────────────────────────────────────
    case P.WAIT_REDIRECT: {
      const elapsed = Date.now() - CTX.submitAt;

      if (isAuthenticated()) {
        stop('✓ Signed in successfully', P.DONE);
        return;
      }

      if (CTX.submitKind === 'google' && hasKlingNetworkErrorToast()) {
        stop(
          'Google sign-in failed on Kling side. Click Sign in with Google manually to continue.',
          P.BLOCKED,
          { preserveLaunch: true }
        );
        return;
      }

      if (hasSignedInToast()) {
        setStatus('Kling accepted login — waiting for app...');
        CTX.submitLockUntil = Date.now() + 3000;

        if (!location.pathname.startsWith('/app')) {
          location.replace(LOGIN_URL);
          return;
        }

        return;
      }

      if (isGoogleCredential() && location.pathname.startsWith('/app') && findGoogleAuthButton()) {
        if (elapsed < GOOGLE_POPUP_GRACE_MS) {
          const remaining = Math.max(1, Math.round((GOOGLE_POPUP_GRACE_MS - elapsed) / 1000));
          setStatus(`Waiting for Google sign-in window… (${remaining}s)`);
          wake(800);
          return;
        }
      }

      // FIX: chooser check guarded with elapsed > 1500ms to avoid
      // premature re-entry while SPA transition is still in progress
      if (location.pathname.startsWith('/app') && findEmailChooserButton() && elapsed > 1500) {
        setStatus('Kling reloaded chooser — re-entering…');
        CTX.submitLockUntil        = 0;
        CTX.lastLandingActionKey   = '';   // FIX BUG2 — reset lock so click fires
        CTX.landingActionLockUntil = 0;   // FIX BUG2
        clearCheckpoint();
        CTX.phase = P.OPEN_LANDING;
        wake(0);
        return;
      }

      // Ended up on public kling.ai after login — redirect back to app
      if (!location.pathname.startsWith('/app')) {
        setStatus('Post-login redirect to public page — going to app…');
        location.replace(LOGIN_URL);
        return;
      }

      // Email-only step: password field appeared — fill it
      if (CTX.submitKind === 'email' && findInput(PASS_SELS)) {
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

      // Email step grace timeout (1800ms)
      if (CTX.submitKind === 'email' && elapsed > EMAIL_STEP_GRACE_MS) {
        CTX.submitLockUntil = 0;
        clearCheckpoint();
        CTX.phase = P.FILL;
        wake(0);
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
    if (!CTX.stopped && !CTX.busy && !CTX.timer) wake(0);
  }, KEEP_ALIVE_MS);
  wake(0);
}

start();
