(() => {
// ============================================================
// ChatGPT Auto-Login Content Script — content-chatgpt.js
// KEY FIX: authenticated-state evaluation now requires a mandatory
// DOM-settle wait plus positive signed-in UI evidence before it can
// ever report success.
// ============================================================

const TOOL_SLUG = 'chatgpt';
const EXTENSION_TICKET_KEY = 'rmw_extension_ticket';
const LOGIN_FLOW_STORAGE_KEY = 'rmw_chatgpt_login_flow_hints_v1';
const LOGIN_FLOW_HINT_TTL_MS = 45 * 24 * 60 * 60 * 1000;

const LOGIN_FLOW = {
  OPENAI_PASSWORD: 'openai_password',
  GOOGLE:          'google_oauth',
  MICROSOFT:       'microsoft_oauth',
  SSO:             'openai_sso',
};

const PHASE = {
  BOOT:             'boot',
  AUTH:             'auth',
  LOAD_CRED:        'load_cred',
  CHATGPT_LANDING:  'chatgpt_landing',
  CHATGPT_EMAIL_OTP:'chatgpt_email_otp',
  PREFER_PROVIDER:  'prefer_provider',
  CHATGPT_EMAIL:    'chatgpt_email',
  CHATGPT_PASSWORD: 'chatgpt_password',
  GOOGLE_CHOOSER:   'google_chooser',
  GOOGLE_EMAIL:     'google_email',
  GOOGLE_PASSWORD:  'google_password',
  WAIT_REDIRECT:    'wait_redirect',
  DONE:             'done',
  BLOCKED:          'blocked',
};

// ── Timing constants ──────────────────────────────────────────
const KEEP_ALIVE_MS         = 3500;
const MIN_RUN_GAP_MS        = 400;
const MUTATION_DEBOUNCE_MS  = 300;
const SUBMIT_LOCK_MS        = 10000;
const POST_CLICK_SETTLE_MS  = 800;
const FIELD_FILL_DELAY_MS   = 120;
const AUTH_RETRY_DELAY_MS   = 500;
const MAX_AUTH_RETRIES      = 8;
const MAX_CRED_RETRIES      = 4;
const GOOGLE_NEXT_WAIT_MS   = 2500;
const GOOGLE_NEXT_POLL_MS   = 120;
const SUCCESS_BADGE_HIDE_MS = 4000;
const AUTHENTICATED_CONFIRM_MS = 1800;
const LOGIN_ERROR_LOOKBACK_MS = 9000;
const GOOGLE_AUTH_CANCEL_HINT_MS = 45000;

const CHATGPT_LOGIN_ERROR_PHRASES = [
  'incorrect password',
  'invalid password',
  'wrong password',
  'incorrect email',
  'invalid email',
  'email or password is incorrect',
  'email and password do not match',
  "email and password don't match",
  'invalid credentials',
  'invalid login',
  'account not found',
  "we couldn't find an account",
  'no account found',
  'try again',
];

const CHATGPT_SIGNED_IN_STRONG_SELECTORS = [
  '[data-testid*="user-menu" i]',
  '[data-testid*="account-menu" i]',
  '[data-testid*="profile" i]',
  '[data-testid*="avatar" i]',
  '[aria-label*="user menu" i]',
  '[aria-label*="account menu" i]',
  '[aria-label*="profile" i]',
  '[aria-label*="my plan" i]',
  'img[alt*="avatar" i]',
  'img[alt*="profile" i]',
];

const CHATGPT_WORKSPACE_SHELL_SELECTORS = [
  'nav',
  '[data-testid*="sidebar" i]',
  '[data-testid*="history" i]',
  '[data-testid*="composer" i]',
];

// ── THE FIX: DOM-settle gate ──────────────────────────────────
// ChatGPT auth verification is BANNED from returning true until
// at least SETTLE_MS have passed since script start AND at least
// SETTLE_TICKS clean checks have passed with no login UI present.
// This prevents the race where the first tick fires before the
// modal has painted, sees no login UI, and quits prematurely.
const SETTLE_MS             = 2000;   // minimum wall-clock wait
const SETTLE_TICKS          = 3;      // consecutive clean checks required
const SETTLE_TICK_GAP_MS    = 350;    // gap between consecutive checks

const CTX = {
  phase:            PHASE.BOOT,
  busy:             false,
  stopped:          false,
  timer:            null,
  keepAlive:        null,
  observer:         null,
  badgeTimer:       null,
  credential:       null,
  credentialKey:    '',
  flowHint:         '',
  flowHintLoaded:   false,
  launchHostname:   '',
  credRetries:      0,
  authRetries:      0,
  submitLockUntil:  0,
  submitAt:         0,
  authorized:       false,
  authenticatedSeenAt: 0,
  googleSignInClickedAt: 0,
  lastAuthEvaluation: null,
  lastRunAt:        0,
  lastMutationAt:   0,
  landingClicks:    0,
  providerClicks:   0,
  emailOtpValue:    '',
  emailOtpFetching: false,
  emailOtpAttempts: 0,
  emailOtpUnavailable: false,
  emailOtpLastRequestAt: 0,
  // settle gate state
  startedAt:        Date.now(),
  cleanTicks:       0,
  lastCleanTickAt:  0,
};

// ── Selectors ─────────────────────────────────────────────────
const EMAIL_SELECTORS = [
  'input[type="email"]',
  'input[name="username"]',
  'input[name="email"]',
  'input[autocomplete="username"]',
  'input[placeholder*="Email" i]',
  'input[placeholder*="email" i]',
  'input[aria-label*="Email" i]',
];

const PASSWORD_SELECTORS = [
  'input[type="password"]',
  'input[name="password"]',
  'input[autocomplete="current-password"]',
  'input[placeholder*="Password" i]',
];

const ACTION_SELECTORS = ['button', 'input[type="submit"]', '[role="button"]'];
const GOOGLE_ACTION_SELECTORS = [
  'button',
  'a[href]',
  'input[type="button"]',
  'input[type="submit"]',
  '[role="button"]',
  '[data-identifier]',
  'div[tabindex]',
  'li[tabindex]',
];
const GOOGLE_EMAIL_SELECTORS = [
  'input[type="email"]',
  'input[type="text"][name="identifier"]',
  'input[name="identifier"]',
  'input[autocomplete="username"]',
  'input[aria-label*="email" i]',
];
const GOOGLE_PASSWORD_SELECTORS = [
  'input[type="password"]',
  'input[name="Passwd"]',
  'input[autocomplete="current-password"]',
];
const PASSWORD_GUARD_STYLE_ID = 'rmw-password-guard-style';
const OTP_CODE_SELECTORS = [
  'input[autocomplete="one-time-code"]',
  'input[inputmode="numeric"]',
  'input[name="code"]',
  'input[aria-label*="code" i]',
  'input[placeholder*="code" i]',
  'input[type="text"]',
];

// ── Status badge ──────────────────────────────────────────────
function ensureBadge() {
  let el = document.getElementById('rmw-autologin-status');
  if (el) return el;
  el = document.createElement('div');
  el.id = 'rmw-autologin-status';
  Object.assign(el.style, {
    position: 'fixed', top: '12px', right: '12px', zIndex: '2147483647',
    maxWidth: '320px', padding: '10px 12px', borderRadius: '10px',
    background: 'rgba(15,23,42,0.92)', color: '#f8fafc',
    font: '12px/1.4 system-ui,sans-serif',
    boxShadow: '0 8px 24px rgba(15,23,42,0.28)',
    pointerEvents: 'none', whiteSpace: 'pre-wrap',
  });
  (document.body || document.documentElement).appendChild(el);
  return el;
}

function setStatus(msg) {
  console.debug('[RMW ChatGPT]', `[${CTX.phase}]`, msg);
  const b = ensureBadge();
  if (b) b.textContent = `ChatGPT auto-login\n[${CTX.phase}] ${msg}`;
}

function dismissBadge(delay = SUCCESS_BADGE_HIDE_MS) {
  if (CTX.badgeTimer) clearTimeout(CTX.badgeTimer);
  CTX.badgeTimer = setTimeout(() => {
    document.getElementById('rmw-autologin-status')?.remove();
    CTX.badgeTimer = null;
  }, Math.max(0, delay));
}

// ── Chrome messaging ──────────────────────────────────────────
function sendMsg(payload) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(payload, (res) => {
      if (chrome.runtime.lastError) resolve({ ok: false, error: chrome.runtime.lastError.message });
      else resolve(res || { ok: false, error: 'No response' });
    });
  });
}

// ── Ticket helpers ────────────────────────────────────────────
function readTicketFromUrl() {
  try {
    const t = new URLSearchParams(location.search || '').get('rmw_extension_ticket') || '';
    if (t) return t.trim();
    return (new URLSearchParams((location.hash || '').replace(/^#/, '')).get('rmw_extension_ticket') || '').trim();
  } catch { return ''; }
}
function getStoredTicket() {
  try { return (sessionStorage.getItem(EXTENSION_TICKET_KEY) || '').trim(); } catch { return ''; }
}
function storeTicket(t) {
  try { t ? sessionStorage.setItem(EXTENSION_TICKET_KEY, t) : sessionStorage.removeItem(EXTENSION_TICKET_KEY); } catch {}
}
function clearTicket() {
  try { sessionStorage.removeItem(EXTENSION_TICKET_KEY); } catch {}
}
function captureTicket() {
  const t = readTicketFromUrl();
  if (!t) return getStoredTicket();
  storeTicket(t);
  try {
    const sp = new URLSearchParams(location.search || '');
    sp.delete('rmw_extension_ticket'); sp.delete('rmw_tool_slug');
    const q = sp.toString();
    history.replaceState(null, '', location.pathname + (q ? '?' + q : '') + (location.hash || ''));
  } catch {}
  return t;
}

// ── Flow hint helpers ─────────────────────────────────────────
function credFlowKey(cred) {
  const id = (cred?.loginIdentifier || '').trim().toLowerCase();
  const domain = id.includes('@') ? id.split('@').pop() : id;
  return domain ? `${TOOL_SLUG}:${domain}` : `${TOOL_SLUG}:default`;
}
async function loadFlowHint(cred) {
  const key = credFlowKey(cred);
  try {
    const stored = await chrome.storage.local.get([LOGIN_FLOW_STORAGE_KEY]);
    const hints = stored[LOGIN_FLOW_STORAGE_KEY] || {};
    const item = hints[key];
    if (item && Number(item.updatedAt || 0) + LOGIN_FLOW_HINT_TTL_MS > Date.now()) return item.flow;
  } catch {}
  return '';
}
function saveFlowHint(cred, flow, evidence) {
  const key = credFlowKey(cred);
  if (!key || !flow) return;
  CTX.credentialKey = key; CTX.flowHint = flow; CTX.flowHintLoaded = true;
  chrome.storage.local.get([LOGIN_FLOW_STORAGE_KEY]).then((s) => {
    const h = { ...(s[LOGIN_FLOW_STORAGE_KEY] || {}) };
    h[key] = { flow, evidence, updatedAt: Date.now() };
    return chrome.storage.local.set({ [LOGIN_FLOW_STORAGE_KEY]: h });
  }).catch(() => {});
}

// ── DOM helpers ───────────────────────────────────────────────
function isVisible(el) {
  if (!el) return false;
  const r = el.getBoundingClientRect(), s = getComputedStyle(el);
  return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0';
}
function isDisabled(el) {
  if (!el) return true;
  return el.disabled || el.getAttribute('aria-disabled') === 'true' || el.getAttribute('disabled') !== null;
}

function collectRoots(root, roots = new Set()) {
  if (!root || roots.has(root)) return roots;
  roots.add(root);
  const walk = (n) => {
    if (!(n instanceof Element)) return;
    if (n.shadowRoot && !roots.has(n.shadowRoot)) {
      roots.add(n.shadowRoot);
      Array.from(n.shadowRoot.children || []).forEach(walk);
    }
    Array.from(n.children || []).forEach(walk);
  };
  if (root instanceof Document || root instanceof ShadowRoot) Array.from(root.children || []).forEach(walk);
  else if (root instanceof Element) walk(root);
  return roots;
}

function queryDeep(sel, root = document) {
  const list = Array.isArray(sel) ? sel : [sel];
  const out = [];
  for (const r of collectRoots(root)) {
    for (const s of list) {
      try { out.push(...Array.from(r.querySelectorAll(s))); } catch {}
    }
  }
  return out;
}

function findInput(sels, root = document) {
  for (const s of sels) {
    const m = queryDeep(s, root).find((el) => !el.disabled && !el.readOnly && isVisible(el));
    if (m) return m;
  }
  return null;
}

function getValueSetter(el) {
  let c = el;
  while (c) {
    const d = Object.getOwnPropertyDescriptor(c, 'value');
    if (d?.set) return d.set;
    c = Object.getPrototypeOf(c);
  }
  return null;
}

function fillField(input, value) {
  const next = `${value || ''}`, prev = `${input.value || ''}`;
  const setter = getValueSetter(input);
  input.focus();
  if (setter) setter.call(input, next); else input.value = next;
  input.setAttribute('value', next);
  if (input._valueTracker?.setValue) input._valueTracker.setValue(prev);
  input.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, cancelable: true, data: next, inputType: 'insertText' }));
  input.dispatchEvent(new InputEvent('input', { bubbles: true, data: next, inputType: 'insertText' }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
  input.dispatchEvent(new Event('blur', { bubbles: true }));
}

function setInputValueForTyping(input, nextValue) {
  const next = `${nextValue || ''}`;
  const prev = `${input.value || ''}`;
  const setter = getValueSetter(input);
  if (setter) setter.call(input, next); else input.value = next;
  input.setAttribute('value', next);
  if (input._valueTracker?.setValue) input._valueTracker.setValue(prev);
}

async function typeFieldLikeUser(input, value, { perCharDelayMs = 12 } = {}) {
  const next = `${value || ''}`;
  focusElement(input);
  setInputValueForTyping(input, '');
  input.dispatchEvent(new Event('input', { bubbles: true }));
  for (let i = 0; i < next.length; i += 1) {
    const ch = next[i];
    const partial = next.slice(0, i + 1);
    try {
      input.dispatchEvent(new KeyboardEvent('keydown', {
        key: ch,
        code: ch.length === 1 ? `Key${ch.toUpperCase()}` : '',
        bubbles: true,
        cancelable: true,
      }));
    } catch {}
    try {
      input.dispatchEvent(new InputEvent('beforeinput', {
        data: ch,
        inputType: 'insertText',
        bubbles: true,
        cancelable: true,
      }));
    } catch {}
    setInputValueForTyping(input, partial);
    try {
      input.dispatchEvent(new InputEvent('input', {
        data: ch,
        inputType: 'insertText',
        bubbles: true,
      }));
    } catch {
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }
    try {
      input.dispatchEvent(new KeyboardEvent('keyup', {
        key: ch,
        code: ch.length === 1 ? `Key${ch.toUpperCase()}` : '',
        bubbles: true,
        cancelable: true,
      }));
    } catch {}
    if (perCharDelayMs > 0) await sleep(perCharDelayMs);
  }
  input.dispatchEvent(new Event('change', { bubbles: true }));
}

function sleep(ms) { return new Promise((r) => setTimeout(r, Math.max(0, ms))); }

function focusElement(el) {
  if (!el) return;
  try { el.scrollIntoView({ block: 'center', inline: 'nearest' }); } catch {}
  try { el.focus({ preventScroll: true }); } catch { el.focus?.(); }
}

function btnText(el) {
  return `${el.innerText || el.textContent || el.value || el.getAttribute?.('aria-label') || ''}`.trim().toLowerCase();
}
function descriptorText(el) {
  return `${el.innerText || el.textContent || el.value || el.getAttribute?.('aria-label') || ''} ${el.getAttribute?.('data-identifier') || ''}`
    .trim()
    .toLowerCase();
}
function normalizeText(value) {
  return `${value || ''}`.replace(/\s+/g, ' ').trim().toLowerCase();
}
function normalizeLoginMethod(value) {
  const method = normalizeText(value).replace(/[-\s]+/g, '_');
  if (!method) return 'email_password';
  if (method === 'google' || method.includes('google')) return 'google';
  if (method === 'email' || method.includes('email') || method.includes('password')) return 'email_password';
  return method;
}
function normalizeCredential(credential) {
  if (!credential || typeof credential !== 'object') return null;
  const loginMethod = normalizeLoginMethod(credential.loginMethod || credential.login_method);
  return {
    ...credential,
    loginMethod,
    login_method: loginMethod,
  };
}
function getCredentialLoginMethod(cred = CTX.credential) {
  return normalizeLoginMethod(cred?.loginMethod || cred?.login_method);
}
function isGoogleCredential(cred = CTX.credential) {
  return getCredentialLoginMethod(cred) === 'google';
}
function isThirdPartyBtn(el) {
  const t = btnText(el);
  return t.includes('google') || t.includes('microsoft') || t.includes('apple') || t.includes('passkey') || t.includes('phone');
}
function isSsoBtn(el) {
  const t = btnText(el);
  return t.includes('single sign-on') || t.includes('continue with sso') || t === 'sso';
}

function findClickableTarget(el) {
  if (!el) return null;
  const descendant = Array.from(
    el.querySelectorAll?.('button, a[href], input[type="button"], input[type="submit"], [role="button"]') || []
  ).find((candidate) => !isDisabled(candidate) && isVisible(candidate));
  if (descendant) return descendant;
  let cur = el;
  while (cur && cur !== document.body) {
    if (
      cur.matches?.('button, a[href], input[type="button"], input[type="submit"], [role="button"]')
      && !isDisabled(cur)
      && isVisible(cur)
    ) {
      return cur;
    }
    cur = cur.parentElement;
  }
  return el;
}

function dispatchClickSequence(el) {
  const pointerCtor = typeof window.PointerEvent === 'function' ? window.PointerEvent : window.MouseEvent;
  [
    ['pointerdown', pointerCtor],
    ['mousedown', window.MouseEvent],
    ['pointerup', pointerCtor],
    ['mouseup', window.MouseEvent],
  ].forEach(([name, EventCtor]) => {
    try {
      el.dispatchEvent(new EventCtor(name, {
        bubbles: true,
        cancelable: true,
        composed: true,
        view: window,
      }));
    } catch {}
  });
}

function safeClick(el) {
  const target = findClickableTarget(el);
  if (!target || isDisabled(target) || !isVisible(target)) return false;
  focusElement(target);
  dispatchClickSequence(target);
  try {
    target.click();
    return true;
  } catch {
    try {
      target.dispatchEvent(new MouseEvent('click', {
        bubbles: true,
        cancelable: true,
        composed: true,
        view: window,
      }));
      return true;
    } catch {
      return false;
    }
  }
}

function pressEnter(input) {
  if (!input) return false;
  focusElement(input);
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

// ── Page detection ────────────────────────────────────────────
function onGoogleDomain()  { return location.hostname === 'accounts.google.com'; }
function onChatGPTDomain() { return location.hostname.includes('chat.openai.com') || location.hostname.includes('chatgpt.com'); }
function onAuthDomain()    { return location.hostname.includes('auth.openai.com'); }
function isOpenAIPasswordPage() {
  return onAuthDomain() && location.pathname.toLowerCase().includes('/log-in/password');
}
function isGoogleIdentifierUrl() {
  return onGoogleDomain() && location.pathname.includes('/signin/identifier');
}
function isGooglePasswordUrl() {
  return onGoogleDomain() && (location.pathname.includes('/signin/challenge') || location.pathname.includes('/signin/v2/challenge'));
}
function isEmailVerificationPage() {
  const pageText = (document.body?.innerText || '').toLowerCase();
  return location.pathname.toLowerCase().includes('email-verification')
    || (
      pageText.includes('enter the verification code')
      || pageText.includes('temporary chatgpt login code')
      || pageText.includes('check your inbox')
      || pageText.includes('resend email')
    );
}

function findEmailVerificationCodeInput() {
  const labels = ['enter the verification code', 'temporary chatgpt login code', 'check your inbox', 'resend email'];
  const pageText = (document.body?.innerText || '').toLowerCase();
  if (!labels.some((label) => pageText.includes(label))) return null;
  return findInput(OTP_CODE_SELECTORS);
}

function findEmailVerificationContinueButton() {
  const buttons = queryDeep(ACTION_SELECTORS).filter((el) => !isDisabled(el) && isVisible(el));
  return buttons.find((el) => btnText(el) === 'continue') || null;
}

// ── Login UI detection ────────────────────────────────────────
function isLoginUiPresent() {
  // 1. Visible modal/dialog
  if (queryDeep(['[role="dialog"]', '[aria-modal="true"]']).filter(isVisible).length > 0) return true;
  // 2. Visible email or password input
  if (findInput(EMAIL_SELECTORS) || findInput(PASSWORD_SELECTORS)) return true;
  // 3. Logged-out ChatGPT shell/sidebar prompt. ChatGPT can show the chat
  // composer while still logged out, so this must override chat UI signals.
  const pageText = `${document.body?.innerText || ''}`.trim().toLowerCase();
  if (
    pageText.includes('get responses tailored to you')
    || pageText.includes('log in to get responses based on saved chats')
    || pageText.includes('log in to get responses based on saved chats, plus create images and upload files')
  ) {
    return true;
  }
  // 4. Visible login action outside a modal, such as the left sidebar CTA
  // shown on logged-out ChatGPT pages.
  if (findLandingLoginBtn()) return true;
  // 5. Leaf-node visible text matching login phrases
  const loginPhrases = ['welcome back', 'stay logged out', 'log in or sign up'];
  const visibleText = Array.from(document.querySelectorAll('h1,h2,h3,p,span'))
    .filter((el) => el.childElementCount === 0 && isVisible(el))
    .map((el) => (el.innerText || el.textContent || '').trim().toLowerCase())
    .join(' ');
  if (loginPhrases.some((p) => visibleText.includes(p))) return true;
  // 6. Auth path
  const path = location.pathname;
  if (path.includes('/auth/') || path.includes('/login') || path.includes('/signup')) return true;
  return false;
}

function getRenderedPageText() {
  return normalizeText(document.body?.innerText || '');
}

function findChatGPTLoginErrorMessage() {
  const errorSelectors = '[role="alert"], [aria-live], [class*="error" i], [class*="danger" i], [class*="invalid" i]';
  for (const root of collectRoots(document)) {
    const candidates = root.querySelectorAll ? Array.from(root.querySelectorAll(errorSelectors)) : [];
    for (const element of candidates) {
      if (!isVisible(element)) continue;
      const text = normalizeText(element.textContent || '');
      if (!text) continue;
      const match = CHATGPT_LOGIN_ERROR_PHRASES.find((phrase) => text.includes(phrase));
      if (match) return match;
    }
  }
  return '';
}

function findSignedInIndicator() {
  const strongSignal = CHATGPT_SIGNED_IN_STRONG_SELECTORS
    .flatMap((selector) => {
      try {
        return queryDeep(selector);
      } catch {
        return [];
      }
    })
    .find((element) => isVisible(element));
  if (strongSignal) return { found: true, reason: 'avatar_or_account_menu', element: strongSignal };

  const workspaceAction = queryDeep(ACTION_SELECTORS)
    .filter((element) => isVisible(element) && !isDisabled(element))
    .find((element) => {
      const text = btnText(element);
      return text === 'new chat' || text === 'temporary chat';
    });
  if (workspaceAction) return { found: true, reason: 'workspace_new_chat', element: workspaceAction };

  const composer = queryDeep([
    'textarea',
    'textarea[placeholder*="message" i]',
    'textarea[placeholder*="ask" i]',
    'textarea[data-id]',
  ]).find((element) => isVisible(element));
  const shell = CHATGPT_WORKSPACE_SHELL_SELECTORS
    .flatMap((selector) => {
      try {
        return queryDeep(selector);
      } catch {
        return [];
      }
    })
    .find((element) => isVisible(element));
  if (composer && shell) return { found: true, reason: 'workspace_shell', element: composer };

  return { found: false, reason: 'no_positive_signal' };
}

function evaluateChatGPTAuthState() {
  if (!onChatGPTDomain()) {
    return { authenticated: false, reason: 'not_chatgpt_host' };
  }

  const now = Date.now();
  if (now - CTX.startedAt < SETTLE_MS) {
    return { authenticated: false, reason: 'settling' };
  }

  if (isLoginUiPresent()) {
    CTX.cleanTicks = 0;
    CTX.lastCleanTickAt = 0;
    return { authenticated: false, reason: 'login_ui_present' };
  }

  if (CTX.lastCleanTickAt === 0 || now - CTX.lastCleanTickAt >= SETTLE_TICK_GAP_MS) {
    CTX.cleanTicks += 1;
    CTX.lastCleanTickAt = now;
  }
  if (CTX.cleanTicks < SETTLE_TICKS) {
    return { authenticated: false, reason: 'awaiting_clean_checks' };
  }

  const loginError = findChatGPTLoginErrorMessage();
  if (loginError) {
    return { authenticated: false, reason: 'login_error', detail: loginError };
  }

  const signedIn = findSignedInIndicator();
  if (signedIn.found) {
    return { authenticated: true, reason: signedIn.reason };
  }

  const renderedText = getRenderedPageText();
  if (
    renderedText.includes('log in or sign up')
    || renderedText.includes('log in to get responses based on saved chats')
  ) {
    return { authenticated: false, reason: 'rendered_signed_out_copy' };
  }

  return { authenticated: false, reason: 'no_positive_signal' };
}

// ── Provider helpers ──────────────────────────────────────────
function findThirdPartyButtons() {
  return queryDeep(ACTION_SELECTORS).filter((el) => isVisible(el) && !isDisabled(el) && isThirdPartyBtn(el));
}
function findGoogleButton()    { return findThirdPartyButtons().find((el) => btnText(el).includes('google'))    || null; }
function findMicrosoftButton() { return findThirdPartyButtons().find((el) => btnText(el).includes('microsoft')) || null; }

function getPreferredProviderBtn(cred) {
  const explicitMethod = getCredentialLoginMethod(cred);
  if (explicitMethod === 'google') return findGoogleButton();
  if (explicitMethod === 'email_password') return null;
  const thirdPartyBtns = findThirdPartyButtons();
  if (!thirdPartyBtns.length) return null;
  const hint   = CTX.flowHint;
  const id     = (cred?.loginIdentifier || '').trim().toLowerCase();
  const domain = id.includes('@') ? id.split('@').pop() : '';
  if (hint === LOGIN_FLOW.GOOGLE)    return findGoogleButton();
  if (hint === LOGIN_FLOW.MICROSOFT) return findMicrosoftButton();
  const googleDomains = ['gmail.com', 'googlemail.com', 'google.com'];
  if (googleDomains.includes(domain)) return findGoogleButton();
  const msDomains = ['outlook.com', 'hotmail.com', 'live.com', 'msn.com', 'microsoft.com'];
  if (msDomains.includes(domain)) return findMicrosoftButton();
  // Unknown domain (Workspace) → prefer Google
  const knownConsumerDomains = [...googleDomains, ...msDomains, 'yahoo.com', 'icloud.com', 'proton.me', 'protonmail.com'];
  if (domain && !knownConsumerDomains.includes(domain)) {
    const gBtn = findGoogleButton();
    if (gBtn) return gBtn;
  }
  if (thirdPartyBtns.length === 1) return thirdPartyBtns[0];
  return null;
}

// ── Login dialog helpers ──────────────────────────────────────
function findLoginDialog() {
  return queryDeep(['[role="dialog"]', '[aria-modal="true"]'])
    .filter(isVisible)
    .find((el) => {
      const t = (el.innerText || el.textContent || '').toLowerCase();
      return t.includes('log in') || t.includes('welcome back') || t.includes('email address') || t.includes('password');
    }) || null;
}

function findEmailInputInModal() {
  const d = findLoginDialog();
  if (d) { const i = findInput(EMAIL_SELECTORS, d); if (i) return i; }
  return findInput(EMAIL_SELECTORS);
}

function findPasswordInputInModal() {
  const d = findLoginDialog();
  if (d) { const i = findInput(PASSWORD_SELECTORS, d); if (i) return i; }
  return findInput(PASSWORD_SELECTORS);
}

function ensurePasswordGuardStyle() {
  if (document.getElementById(PASSWORD_GUARD_STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = PASSWORD_GUARD_STYLE_ID;
  style.textContent = `
    [data-rmw-password-guard="hidden"] {
      display: none !important;
      visibility: hidden !important;
      pointer-events: none !important;
    }
    input[data-rmw-password-copy-guard="true"] {
      user-select: none !important;
      -webkit-user-select: none !important;
      caret-color: transparent !important;
    }
  `;
  (document.head || document.documentElement).appendChild(style);
}

function describeElement(el) {
  return [
    el?.getAttribute?.('aria-label') || '',
    el?.getAttribute?.('title') || '',
    el?.getAttribute?.('data-testid') || '',
    el?.getAttribute?.('name') || '',
    el?.getAttribute?.('id') || '',
    typeof el?.className === 'string' ? el.className : '',
  ].join(' ').trim().toLowerCase();
}

function looksLikePasswordRevealControl(el) {
  const descriptor = describeElement(el);
  if (!descriptor) return false;
  const mentionsPassword = descriptor.includes('password');
  const mentionsRevealAction = (
    descriptor.includes('show')
    || descriptor.includes('hide')
    || descriptor.includes('reveal')
    || descriptor.includes('visibility')
    || descriptor.includes('toggle')
  );
  return mentionsPassword && mentionsRevealAction;
}

function isInlinePasswordRevealControl(el, input) {
  if (!el || !input || el === input) return false;
  if (!isVisible(el)) return false;
  const rect = el.getBoundingClientRect();
  const inputRect = input.getBoundingClientRect();
  if (!rect.width || !rect.height || !inputRect.width || !inputRect.height) return false;

  const verticallyAligned = rect.bottom >= inputRect.top && rect.top <= inputRect.bottom;
  const horizontallyNearRightEdge = rect.left >= (inputRect.right - 140) && rect.left <= (inputRect.right + 24);
  const sizeLooksLikeIconButton = rect.width <= 72 && rect.height <= 72;
  const sameWrapper = (
    el.parentElement === input.parentElement
    || el.closest('label, div, section, form') === input.closest('label, div, section, form')
  );

  return verticallyAligned && horizontallyNearRightEdge && sizeLooksLikeIconButton && sameWrapper;
}

function findPasswordRevealControls(input) {
  const roots = [
    input?.parentElement,
    input?.closest?.('[role="dialog"],[aria-modal="true"],form,section,main,div'),
    document,
  ].filter(Boolean);
  const seen = new Set();
  const matches = [];
  for (const root of roots) {
    const controls = queryDeep(['button', '[role="button"]', '[aria-label]', '[title]'], root);
    for (const control of controls) {
      if (!control || seen.has(control)) continue;
      seen.add(control);
      if (!isVisible(control)) continue;
      if (!looksLikePasswordRevealControl(control) && !isInlinePasswordRevealControl(control, input)) continue;
      matches.push(control);
    }
  }
  return matches;
}

function forcePasswordConcealed(input) {
  if (!input) return;
  if (input.type !== 'password') {
    try { input.type = 'password'; } catch {}
  }
  input.setAttribute('type', 'password');
}

function suppressPasswordFieldExposure(input) {
  if (!input) return;
  ensurePasswordGuardStyle();
  forcePasswordConcealed(input);

  if (input.dataset.rmwPasswordCopyGuard !== 'true') {
    input.dataset.rmwPasswordCopyGuard = 'true';
    input.setAttribute('autocomplete', 'off');
    ['copy', 'cut', 'contextmenu', 'dragstart', 'selectstart'].forEach((eventName) => {
      input.addEventListener(eventName, (event) => {
        event.preventDefault();
        event.stopPropagation();
      }, true);
    });
  }

  if (input.dataset.rmwPasswordRevealObserver !== 'true') {
    input.dataset.rmwPasswordRevealObserver = 'true';
    const observer = new MutationObserver(() => {
      forcePasswordConcealed(input);
      suppressPasswordFieldExposure(input);
    });
    observer.observe(input, {
      attributes: true,
      attributeFilter: ['type', 'aria-label', 'class'],
    });

    const wrapper = input.closest('[role="dialog"],[aria-modal="true"],form,section,main,div') || input.parentElement;
    if (wrapper) {
      const subtreeObserver = new MutationObserver(() => {
        forcePasswordConcealed(input);
        findPasswordRevealControls(input).forEach((control) => {
          control.dataset.rmwPasswordGuard = 'hidden';
          control.setAttribute('aria-hidden', 'true');
          control.setAttribute('tabindex', '-1');
        });
      });
      subtreeObserver.observe(wrapper, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['aria-label', 'title', 'class', 'style', 'type'],
      });
    }
  }

  findPasswordRevealControls(input).forEach((control) => {
    control.dataset.rmwPasswordGuard = 'hidden';
    control.setAttribute('aria-hidden', 'true');
    control.setAttribute('tabindex', '-1');
    control.style.pointerEvents = 'none';
    control.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
    }, true);
    control.addEventListener('mousedown', (event) => {
      event.preventDefault();
      event.stopPropagation();
    }, true);
    control.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      event.stopPropagation();
    }, true);
  });
}

function findContinueBtn(input) {
  const root = input?.closest?.('[role="dialog"],[aria-modal="true"]') || findLoginDialog() || document;
  return queryDeep(ACTION_SELECTORS, root)
    .filter((el) => isVisible(el) && !isDisabled(el) && !isThirdPartyBtn(el) && !isSsoBtn(el))
    .find((el) => { const t = btnText(el); return t === 'continue' || t === 'next' || t === 'log in' || t === 'sign in'; })
    || null;
}

function findLandingLoginBtn() {
  return queryDeep(ACTION_SELECTORS)
    .filter((el) => !isDisabled(el) && isVisible(el) && !isThirdPartyBtn(el) && !isSsoBtn(el))
    .find((el) => {
      const t = btnText(el);
      return t.includes('log in') || t.includes('login') || t.includes('sign in')
        || (el.getAttribute?.('href') || '').toLowerCase().includes('/auth/login');
    }) || null;
}

function findSubmitBtn(kind, input) {
  const words = kind === 'password'
    ? ['continue', 'log in', 'login', 'sign in', 'submit']
    : ['continue', 'next', 'submit'];
  const containers = [];
  let cur = input?.parentElement;
  while (cur && cur !== document.body) {
    containers.push(cur);
    if (cur.matches?.('form,[role="dialog"],[aria-modal="true"],main,section')) break;
    cur = cur.parentElement;
  }
  containers.push(document);
  for (const root of containers) {
    const cands = queryDeep(ACTION_SELECTORS, root)
      .filter((el) => !isDisabled(el) && isVisible(el) && !isThirdPartyBtn(el) && !isSsoBtn(el));
    const exact = cands.find((el) => { const t = btnText(el); return t === 'continue' || t === 'next' || t === 'log in' || t === 'sign in'; });
    if (exact) return exact;
    const word = cands.find((el) => words.some((w) => btnText(el).includes(w)));
    if (word) return word;
    const sub = cands.find((el) => el.type === 'submit');
    if (sub) return sub;
  }
  return null;
}

// ── Google continuation helpers ───────────────────────────────
function normalizeIdentifier(value) {
  return `${value || ''}`.trim().toLowerCase();
}

function findGoogleEmailInput() {
  return findInput(GOOGLE_EMAIL_SELECTORS);
}

function findGooglePasswordInput() {
  return findInput(GOOGLE_PASSWORD_SELECTORS);
}

function findGoogleActions(root = document) {
  return queryDeep(GOOGLE_ACTION_SELECTORS, root).filter((el) => isVisible(el) && !isDisabled(el));
}

function findGoogleUseAnotherAccountButton() {
  return findGoogleActions().find((el) => descriptorText(el).includes('use another account')) || null;
}

function findGoogleTryAnotherWayButton() {
  return findGoogleActions().find((el) => descriptorText(el).includes('try another way')) || null;
}

function findGoogleMatchingAccountButton(loginIdentifier) {
  const normalized = normalizeIdentifier(loginIdentifier);
  if (!normalized) return null;
  const local = normalized.split('@')[0];
  const domain = normalized.includes('@') ? normalized.split('@').pop() : '';
  return findGoogleActions().find((el) => {
    const text = descriptorText(el);
    return text.includes(normalized) || (local && text.includes(local) && (!domain || text.includes(domain)));
  }) || null;
}

function getGoogleEmailValue(loginIdentifier, input) {
  const full = `${loginIdentifier || ''}`.trim();
  if (!full.includes('@')) return full;
  const screenText = `${input?.closest('form, main, section, div')?.innerText || document.body?.innerText || ''}`.toLowerCase();
  const domain = full.split('@')[1].toLowerCase();
  if (domain && screenText.includes(`@${domain}`)) return full.split('@')[0];
  return full;
}

function findGoogleNextButton(kind, input = null) {
  const selectors = kind === 'password'
    ? ['#passwordNext button', '#passwordNext [role="button"]', '#passwordNext']
    : ['#identifierNext button', '#identifierNext [role="button"]', '#identifierNext'];
  for (const selector of selectors) {
    const match = queryDeep(selector).find((el) => isVisible(el) && !isDisabled(el));
    if (match) return match;
  }
  return findSubmitBtn(kind === 'password' ? 'password' : 'email', input);
}

async function waitForGoogleNextButton(kind, input = null, timeoutMs = GOOGLE_NEXT_WAIT_MS) {
  const deadline = Date.now() + Math.max(0, timeoutMs);
  let button = findGoogleNextButton(kind, input);
  while (!button && Date.now() < deadline) {
    await sleep(GOOGLE_NEXT_POLL_MS);
    button = findGoogleNextButton(kind, input);
  }
  return button;
}

function didGoogleEmailAdvance() {
  return Boolean(
    findGooglePasswordInput()
    || isGooglePasswordUrl()
    || findGoogleMatchingAccountButton(CTX.credential?.loginIdentifier)
    || findGoogleUseAnotherAccountButton()
    || (onGoogleDomain() && !isGoogleIdentifierUrl() && !findGoogleEmailInput())
  );
}

function didGooglePasswordAdvance() {
  return Boolean(
    !findGooglePasswordInput()
    || !isGooglePasswordUrl()
  );
}

async function submitGoogleNextStep(kind, input) {
  const waitAfterSubmitMs = kind === 'password' ? 900 : 700;
  const didAdvance = kind === 'password' ? didGooglePasswordAdvance : didGoogleEmailAdvance;
  const nextButton = await waitForGoogleNextButton(kind, input);
  if (nextButton && safeClick(nextButton)) {
    await sleep(waitAfterSubmitMs);
    if (didAdvance()) return true;
  }
  if (pressEnter(input)) {
    await sleep(waitAfterSubmitMs);
    if (didAdvance()) return true;
  }
  const form = input?.closest?.('form');
  if (form) {
    try {
      if (typeof form.requestSubmit === 'function') form.requestSubmit();
      else form.submit?.();
    } catch {}
    await sleep(waitAfterSubmitMs);
    if (didAdvance()) return true;
  }
  const retryButton = findGoogleNextButton(kind, input);
  if (retryButton && retryButton !== nextButton && safeClick(retryButton)) {
    await sleep(waitAfterSubmitMs);
    if (didAdvance()) return true;
  }
  return didAdvance();
}

async function handleGoogleChooser() {
  const cred = CTX.credential;
  if (findGooglePasswordInput()) { CTX.phase = PHASE.GOOGLE_PASSWORD; wake(0); return; }
  if (findGoogleEmailInput())    { CTX.phase = PHASE.GOOGLE_EMAIL;    wake(0); return; }

  const matchingAccount = findGoogleMatchingAccountButton(cred?.loginIdentifier);
  if (matchingAccount) {
    setStatus('Selecting matching Google account...');
    if (!safeClick(matchingAccount)) { setStatus('Google account tile not clickable yet...'); wake(300); return; }
    CTX.submitAt = Date.now();
    CTX.submitLockUntil = Date.now() + SUBMIT_LOCK_MS;
    CTX.phase = PHASE.WAIT_REDIRECT;
    wake(POST_CLICK_SETTLE_MS);
    return;
  }

  const useAnotherAccount = findGoogleUseAnotherAccountButton();
  if (useAnotherAccount) {
    setStatus('Opening Google account entry...');
    if (!safeClick(useAnotherAccount)) { setStatus('Use another account is not clickable yet...'); wake(300); return; }
    CTX.phase = PHASE.GOOGLE_EMAIL;
    wake(POST_CLICK_SETTLE_MS);
    return;
  }

  const tryAnotherWay = findGoogleTryAnotherWayButton();
  if (tryAnotherWay) {
    setStatus('Trying alternate Google sign-in option...');
    if (!safeClick(tryAnotherWay)) { setStatus('Try another way is not clickable yet...'); wake(300); return; }
    wake(POST_CLICK_SETTLE_MS);
    return;
  }

  if (Date.now() < CTX.submitLockUntil) { setStatus('Waiting for Google sign-in screen...'); wake(400); return; }
  setStatus('Waiting for Google account chooser...');
  wake(500);
}

async function handleGoogleEmail() {
  const cred = CTX.credential;
  const emailInput = findGoogleEmailInput();
  if (!emailInput) {
    if (findGooglePasswordInput())                     { CTX.phase = PHASE.GOOGLE_PASSWORD; wake(0); return; }
    if (findGoogleMatchingAccountButton(cred?.loginIdentifier)
      || findGoogleUseAnotherAccountButton()
      || findGoogleTryAnotherWayButton())            { CTX.phase = PHASE.GOOGLE_CHOOSER;  wake(0); return; }
    setStatus('Waiting for Google email field...');
    wake(350);
    return;
  }

  if (Date.now() < CTX.submitLockUntil) {
    if (didGoogleEmailAdvance()) { CTX.submitLockUntil = 0; wake(0); return; }
    setStatus('Google Next clicked — waiting...');
    wake(400);
    return;
  }

  const emailValue = getGoogleEmailValue(cred?.loginIdentifier, emailInput);
  if (!emailValue) { stop('Credential incomplete — check dashboard settings.'); return; }

  setStatus('Filling Google email...');
  fillField(emailInput, emailValue);
  await sleep(FIELD_FILL_DELAY_MS);
  if (`${emailInput.value || ''}`.trim() !== `${emailValue}`.trim()) {
    setStatus('Google email fill did not take — retrying...');
    wake(300);
    return;
  }

  setStatus('Clicking Google Next...');
  const advanced = await submitGoogleNextStep('email', emailInput);
  CTX.submitAt = Date.now();
  CTX.submitLockUntil = Date.now() + SUBMIT_LOCK_MS;
  CTX.phase = PHASE.WAIT_REDIRECT;
  if (advanced) CTX.submitLockUntil = 0;
  wake(POST_CLICK_SETTLE_MS);
}

async function handleGooglePassword() {
  const cred = CTX.credential;
  const passwordInput = findGooglePasswordInput();
  if (!passwordInput) {
    if (findGoogleEmailInput()) { CTX.phase = PHASE.GOOGLE_EMAIL; wake(0); return; }
    if (findGoogleUseAnotherAccountButton() || findGoogleMatchingAccountButton(cred?.loginIdentifier)) {
      CTX.phase = PHASE.GOOGLE_CHOOSER;
      wake(0);
      return;
    }
    if (Date.now() < CTX.submitLockUntil) { setStatus('Waiting for Google password screen...'); wake(400); return; }
    setStatus('Waiting for Google password field...');
    wake(350);
    return;
  }

  if (Date.now() < CTX.submitLockUntil) {
    if (didGooglePasswordAdvance()) { CTX.submitLockUntil = 0; wake(0); return; }
    setStatus('Google Sign in clicked — waiting...');
    wake(400);
    return;
  }

  setStatus('Filling Google password...');
  fillField(passwordInput, cred?.password || '');
  await sleep(FIELD_FILL_DELAY_MS);
  if (`${passwordInput.value || ''}` !== `${cred?.password || ''}`) {
    setStatus('Google password fill did not take — retrying...');
    wake(300);
    return;
  }

  setStatus('Submitting Google password...');
  const advanced = await submitGoogleNextStep('password', passwordInput);
  CTX.submitAt = Date.now();
  CTX.submitLockUntil = Date.now() + SUBMIT_LOCK_MS;
  CTX.phase = PHASE.WAIT_REDIRECT;
  if (advanced) CTX.submitLockUntil = 0;
  wake(POST_CLICK_SETTLE_MS);
}

async function handleGoogleFlow() {
  const cred = CTX.credential;
  if (!cred?.loginIdentifier || !cred?.password) { CTX.phase = PHASE.LOAD_CRED; wake(0); return; }
  saveFlowHint(cred, LOGIN_FLOW.GOOGLE, 'google_accounts_page');

  if (findGooglePasswordInput() || isGooglePasswordUrl()) {
    CTX.phase = PHASE.GOOGLE_PASSWORD;
    await handleGooglePassword();
    return;
  }

  if (findGoogleEmailInput() || isGoogleIdentifierUrl()) {
    CTX.phase = PHASE.GOOGLE_EMAIL;
    await handleGoogleEmail();
    return;
  }

  if (findGoogleMatchingAccountButton(cred.loginIdentifier) || findGoogleUseAnotherAccountButton() || findGoogleTryAnotherWayButton()) {
    CTX.phase = PHASE.GOOGLE_CHOOSER;
    await handleGoogleChooser();
    return;
  }

  if (Date.now() < CTX.submitLockUntil) {
    setStatus('Waiting for Google redirect...');
    wake(500);
    return;
  }

  setStatus('Waiting for Google sign-in screen...');
  wake(500);
}

// ── Authorization ─────────────────────────────────────────────
async function checkAuth() {
  const ticket = captureTicket();
  if (ticket) {
    const res = await sendMsg({ type: 'TOOL_HUB_ACTIVATE_LAUNCH', toolSlug: TOOL_SLUG, hostname: location.hostname, pageUrl: location.href, extensionTicket: ticket });
    if (res?.ok && res.authorized) {
      CTX.launchHostname = `${res.hostname || CTX.launchHostname || ''}`.trim().toLowerCase();
      clearTicket();
      return { authorized: true, hostname: CTX.launchHostname };
    }
    clearTicket();
  }
  const res = await sendMsg({ type: 'TOOL_HUB_GET_LAUNCH_STATE', toolSlug: TOOL_SLUG, hostname: location.hostname, pageUrl: location.href });
  CTX.launchHostname = `${res?.hostname || CTX.launchHostname || ''}`.trim().toLowerCase();
  return { authorized: Boolean(res?.ok && res.authorized), hostname: CTX.launchHostname };
}

// ── Credential loader ─────────────────────────────────────────
let credPromise = null;
function getCredentialRequestContext() {
  if (onGoogleDomain() && CTX.launchHostname) {
    return {
      hostname: CTX.launchHostname,
      pageUrl: `https://${CTX.launchHostname}/`,
    };
  }
  return {
    hostname: location.hostname,
    pageUrl: location.href,
  };
}

async function loadCred() {
  if (CTX.credential) return CTX.credential;
  if (credPromise) return credPromise;
  const requestContext = getCredentialRequestContext();
  credPromise = sendMsg({
    type: 'TOOL_HUB_GET_CREDENTIAL', toolSlug: TOOL_SLUG,
    hostname: requestContext.hostname, pageUrl: requestContext.pageUrl, extensionTicket: getStoredTicket(),
  }).then((res) => {
    credPromise = null;
    if (!res?.ok) throw new Error(res?.error || 'Credential unavailable');
    CTX.credential = normalizeCredential(res.data?.credential || null);
    return CTX.credential;
  }).catch((err) => { credPromise = null; throw err; });
  return credPromise;
}

async function requestEmailOtp() {
  if (CTX.emailOtpUnavailable || CTX.emailOtpFetching || CTX.emailOtpValue) return;
  if (CTX.emailOtpAttempts >= 4) {
    setStatus('Email verification code fetch failed after 4 attempts.');
    return;
  }

  const now = Date.now();
  if (now - CTX.emailOtpLastRequestAt < 2500) return;

  CTX.emailOtpFetching = true;
  CTX.emailOtpLastRequestAt = now;
  CTX.emailOtpAttempts += 1;
  setStatus(`Fetching email verification code (attempt ${CTX.emailOtpAttempts})...`);

  const requestContext = getCredentialRequestContext();
  const response = await sendMsg({
    type: 'TOOL_HUB_FETCH_OTP',
    toolSlug: TOOL_SLUG,
    hostname: requestContext.hostname,
    pageUrl: requestContext.pageUrl,
    extensionTicket: getStoredTicket(),
  });

  CTX.emailOtpFetching = false;

  if (!response?.ok || !response.otp) {
    const errorMessage = `${response?.error || 'Email verification code unavailable'}`;
    if (errorMessage.includes('OTP already fetched')) {
      if (CTX.emailOtpValue) {
        wake(100);
        return;
      }
      setStatus('OTP was already fetched for this launch. Relaunch ChatGPT from the dashboard if the code field was refreshed.');
      return;
    }
    setStatus(errorMessage);
    wake(2000);
    return;
  }

  CTX.emailOtpUnavailable = false;
  CTX.emailOtpValue = `${response.otp}`.trim();
  wake(100);
}

async function handleEmailVerificationStep() {
  const codeInput = findEmailVerificationCodeInput();
  if (!codeInput) {
    setStatus('Waiting for email verification code field...');
    wake(800);
    return;
  }

  if (!CTX.emailOtpValue && !CTX.emailOtpFetching) {
    await requestEmailOtp();
    if (!CTX.emailOtpValue) {
      setStatus('Email verification — waiting for OTP...');
      wake(1200);
      return;
    }
  }

  if (!CTX.emailOtpValue) {
    setStatus('Email verification — waiting for OTP...');
    wake(1200);
    return;
  }

  if (`${codeInput.value || ''}`.trim() !== CTX.emailOtpValue) {
    setStatus('Filling email verification code...');
    fillField(codeInput, CTX.emailOtpValue);
    await sleep(FIELD_FILL_DELAY_MS);
  }

  const continueButton = findEmailVerificationContinueButton();
  if (Date.now() < CTX.submitLockUntil) {
    setStatus('Verification code entered — waiting...');
    wake(700);
    return;
  }

  setStatus('Submitting email verification code...');
  let submitted = false;
  if (continueButton) {
    submitted = safeClick(continueButton);
  }
  if (!submitted) {
    submitted = pressEnter(codeInput);
  }
  if (!submitted) {
    const form = codeInput.closest('form');
    if (form) {
      try {
        if (typeof form.requestSubmit === 'function') form.requestSubmit();
        else form.submit?.();
        submitted = true;
      } catch {}
    }
  }

  if (submitted) {
    CTX.submitAt = Date.now();
    CTX.submitLockUntil = Date.now() + SUBMIT_LOCK_MS;
    wake(POST_CLICK_SETTLE_MS);
    return;
  }

  setStatus('Unable to submit the email verification form automatically.');
  wake(1000);
}

// ── Stop / wake / run ─────────────────────────────────────────
function stop(msg, { dismissAfterMs = 0 } = {}) {
  CTX.stopped = true;
  if (CTX.timer)     { clearTimeout(CTX.timer);     CTX.timer = null; }
  if (CTX.keepAlive) { clearInterval(CTX.keepAlive); CTX.keepAlive = null; }
  if (CTX.observer)  { CTX.observer.disconnect();    CTX.observer = null; }
  clearTicket();
  setStatus(msg);
  if (dismissAfterMs > 0) dismissBadge(dismissAfterMs);
}

function wake(delay = 0) {
  if (CTX.stopped || CTX.timer) return;
  CTX.timer = setTimeout(run, Math.max(0, delay));
}

async function run() {
  CTX.timer = null;
  if (CTX.stopped || CTX.busy) return;
  const now = Date.now();
  if (now - CTX.lastRunAt < MIN_RUN_GAP_MS) { wake(MIN_RUN_GAP_MS - (now - CTX.lastRunAt)); return; }
  CTX.lastRunAt = now; CTX.busy = true;
  try { await tick(); }
  catch (e) { setStatus(`Error: ${e?.message}`); wake(2000); }
  finally { CTX.busy = false; }
}

// ── State machine ─────────────────────────────────────────────
async function tick() {
  const authEvaluation = evaluateChatGPTAuthState();
  CTX.lastAuthEvaluation = authEvaluation;

  if (CTX.authorized && authEvaluation.authenticated) {
    if (!CTX.authenticatedSeenAt) {
      CTX.authenticatedSeenAt = Date.now();
      setStatus('Verifying authentication...');
      wake(200);
      return;
    }

    const confirmAgeMs = Date.now() - CTX.authenticatedSeenAt;
    if (confirmAgeMs < AUTHENTICATED_CONFIRM_MS) {
      setStatus('Verifying authentication...');
      wake(AUTHENTICATED_CONFIRM_MS - confirmAgeMs);
      return;
    }

    const reconfirm = evaluateChatGPTAuthState();
    CTX.lastAuthEvaluation = reconfirm;
    if (reconfirm.authenticated) {
      stop('ChatGPT Login Successful', { dismissAfterMs: SUCCESS_BADGE_HIDE_MS });
      return;
    }

    CTX.authenticatedSeenAt = 0;
    setStatus('Checking authentication...');
    wake(200);
    return;
  }
  CTX.authenticatedSeenAt = 0;

  if (
    CTX.authorized
    && authEvaluation.reason === 'login_error'
    && CTX.submitAt
    && Date.now() - CTX.submitAt < LOGIN_ERROR_LOOKBACK_MS
  ) {
    stop('Invalid Credentials');
    return;
  }

  switch (CTX.phase) {

    // ── BOOT ─────────────────────────────────────────────────
    case PHASE.BOOT: {
      // During the settle window, show a holding message so the
      // user knows the script is alive and waiting for the DOM.
      const elapsed = Date.now() - CTX.startedAt;
      if (elapsed < SETTLE_MS) {
        setStatus(`Waiting for page to settle... (${Math.ceil((SETTLE_MS - elapsed) / 100) / 10}s)`);
        wake(150);
        return;
      }
      setStatus('Page settled. Starting auth check...');
      CTX.phase = PHASE.AUTH;
      wake(0);
      break;
    }

    // ── AUTH ─────────────────────────────────────────────────
    case PHASE.AUTH: {
      setStatus('Checking authorization...');
      let auth;
      try { auth = await checkAuth(); } catch { auth = { authorized: false }; }
      if (!auth.authorized) {
        CTX.authRetries += 1;
        if (CTX.authRetries > MAX_AUTH_RETRIES) { stop('Open this tool from the dashboard first.'); return; }
        setStatus(`Not authorized yet (${CTX.authRetries}/${MAX_AUTH_RETRIES})...`);
        wake(AUTH_RETRY_DELAY_MS); return;
      }
      CTX.authorized = true;
      CTX.phase = PHASE.LOAD_CRED;
      wake(0);
      break;
    }

    // ── LOAD_CRED ────────────────────────────────────────────
    case PHASE.LOAD_CRED: {
      setStatus('Loading credentials...');
      if (CTX.credRetries >= MAX_CRED_RETRIES) { stop('Credential unavailable — check dashboard settings.'); return; }
      try {
        const cred = await loadCred();
        if (!cred?.loginIdentifier || (!cred?.password && !isGoogleCredential(cred))) {
          stop('Credential incomplete — check dashboard settings.');
          return;
        }
        if (!CTX.flowHintLoaded) {
          CTX.flowHint = await loadFlowHint(cred);
          CTX.flowHintLoaded = true;
        }
        setStatus(`Credentials loaded. Login method: "${getCredentialLoginMethod(cred)}"${CTX.flowHint ? ` • Flow hint: "${CTX.flowHint}"` : ''}`);
      } catch (err) {
        CTX.credRetries += 1;
        setStatus(`Credential error: ${err.message} (${CTX.credRetries}/${MAX_CRED_RETRIES})`);
        wake(2000); return;
      }
      CTX.phase = onGoogleDomain()
        ? PHASE.GOOGLE_CHOOSER
        : ((isOpenAIPasswordPage() || findPasswordInputInModal()) ? PHASE.CHATGPT_PASSWORD : PHASE.CHATGPT_LANDING);
      wake(0);
      break;
    }

    // ── CHATGPT_LANDING ──────────────────────────────────────
    case PHASE.CHATGPT_LANDING: {
      const prefersGoogle = isGoogleCredential(CTX.credential);
      if (isOpenAIPasswordPage() || findPasswordInputInModal()){ CTX.phase = PHASE.CHATGPT_PASSWORD; wake(0); return; }
      if (prefersGoogle && findThirdPartyButtons().length > 0) { CTX.phase = PHASE.PREFER_PROVIDER; wake(0); return; }
      if (findEmailInputInModal())   { CTX.phase = PHASE.CHATGPT_EMAIL;    wake(0); return; }
      if (findEmailVerificationCodeInput() || isEmailVerificationPage()) { CTX.phase = PHASE.CHATGPT_EMAIL_OTP; wake(0); return; }
      if (findLoginDialog() || findThirdPartyButtons().length > 0) { CTX.phase = PHASE.PREFER_PROVIDER; wake(0); return; }
      if (CTX.landingClicks < 3) {
        const btn = findLandingLoginBtn();
        if (btn) {
          CTX.landingClicks += 1;
          setStatus(`Clicking Log In (attempt ${CTX.landingClicks})...`);
          await sleep(300);
          if (!safeClick(btn)) {
            setStatus('Log In button is not clickable yet...');
            wake(300);
            return;
          }
          wake(1500);
          return;
        }
      }
      setStatus('Waiting for login modal...');
      wake(700);
      break;
    }

    // ── CHATGPT_EMAIL_OTP ────────────────────────────────────
    case PHASE.CHATGPT_EMAIL_OTP: {
      if (isOpenAIPasswordPage() || findPasswordInputInModal()) { CTX.phase = PHASE.CHATGPT_PASSWORD; wake(0); return; }
      if (findEmailInputInModal())    { CTX.phase = PHASE.CHATGPT_EMAIL;    wake(0); return; }
      if (!findEmailVerificationCodeInput() && !isEmailVerificationPage()) { CTX.phase = PHASE.CHATGPT_LANDING; wake(0); return; }
      await handleEmailVerificationStep();
      break;
    }

    // ── PREFER_PROVIDER ──────────────────────────────────────
    case PHASE.PREFER_PROVIDER: {
      const cred = CTX.credential;
      if (isOpenAIPasswordPage() || findPasswordInputInModal()) { CTX.phase = PHASE.CHATGPT_PASSWORD; wake(0); return; }
      if (Date.now() < CTX.submitLockUntil) { setStatus('Provider clicked — waiting for OAuth redirect...'); wake(600); return; }
      if (getCredentialLoginMethod(cred) === 'email_password') {
        if (findEmailInputInModal()) { CTX.phase = PHASE.CHATGPT_EMAIL; wake(0); return; }
        setStatus('Using email / password sign-in...');
        CTX.phase = PHASE.CHATGPT_EMAIL;
        wake(0);
        return;
      }
      const providerBtn = getPreferredProviderBtn(cred);
      if (providerBtn) {
        const label = btnText(providerBtn);
        if (label.includes('google'))    saveFlowHint(cred, LOGIN_FLOW.GOOGLE,    'provider_button');
        if (label.includes('microsoft')) saveFlowHint(cred, LOGIN_FLOW.MICROSOFT, 'provider_button');
        CTX.providerClicks += 1;
        if (label.includes('google')) CTX.googleSignInClickedAt = Date.now();
        setStatus(`Clicking "${label}" (attempt ${CTX.providerClicks})...`);
        await sleep(300);
        if (!safeClick(providerBtn)) {
          setStatus(`"${label}" is not clickable yet...`);
          wake(300);
          return;
        }
        CTX.submitAt = Date.now();
        CTX.submitLockUntil = Date.now() + SUBMIT_LOCK_MS;
        CTX.phase = PHASE.WAIT_REDIRECT;
        wake(POST_CLICK_SETTLE_MS); return;
      }
      if (isGoogleCredential(cred)) {
        setStatus('Waiting for Google Authentication option...');
        wake(500);
        return;
      }
      if (findEmailInputInModal())    { CTX.phase = PHASE.CHATGPT_EMAIL;    wake(0); return; }
      setStatus('Using email / password sign-in...');
      CTX.phase = PHASE.CHATGPT_EMAIL;
      wake(0);
      break;
    }

    // ── CHATGPT_EMAIL ────────────────────────────────────────
    case PHASE.CHATGPT_EMAIL: {
      const cred = CTX.credential;
      if (isGoogleCredential(cred) && findGoogleButton()) { CTX.phase = PHASE.PREFER_PROVIDER; wake(0); return; }
      const emailInput = findEmailInputInModal();
      if (!emailInput) {
        if (isOpenAIPasswordPage() || findPasswordInputInModal()) { CTX.phase = PHASE.CHATGPT_PASSWORD; wake(0); return; }
        if (!findLoginDialog())         { CTX.phase = PHASE.CHATGPT_LANDING;  wake(300); return; }
        setStatus('Waiting for email field...'); wake(300); return;
      }
      if (Date.now() < CTX.submitLockUntil) { setStatus('Continue clicked — waiting...'); wake(500); return; }
      setStatus('Filling email address...');
      emailInput.focus();
      await sleep(100);
      fillField(emailInput, cred.loginIdentifier);
      await sleep(FIELD_FILL_DELAY_MS);
      if (emailInput.value !== cred.loginIdentifier) { setStatus('Fill did not take — retrying...'); wake(300); return; }
      const btn = findContinueBtn(emailInput) || findSubmitBtn('email', emailInput);
      if (!btn)               { setStatus('Email filled — Continue not found yet...'); wake(300); return; }
      if (isDisabled(btn))    { setStatus('Email filled — Continue not yet enabled...'); wake(250); return; }
      setStatus('Clicking Continue...');
      await sleep(350);
      if (!safeClick(btn)) { setStatus('Continue button is not clickable yet...'); wake(250); return; }
      CTX.submitAt = Date.now();
      CTX.submitLockUntil = Date.now() + SUBMIT_LOCK_MS;
      CTX.phase = PHASE.WAIT_REDIRECT;
      wake(POST_CLICK_SETTLE_MS);
      break;
    }

    // ── CHATGPT_PASSWORD ─────────────────────────────────────
    case PHASE.CHATGPT_PASSWORD: {
      const cred = CTX.credential;
      const passInput = findPasswordInputInModal();
      if (!passInput) { CTX.phase = PHASE.CHATGPT_LANDING; wake(300); return; }
      suppressPasswordFieldExposure(passInput);
      if (Date.now() < CTX.submitLockUntil) { setStatus('Sign In clicked — waiting...'); wake(500); return; }
      setStatus('Filling password...');
      passInput.focus();
      await sleep(100);
      fillField(passInput, cred.password);
      if (`${passInput.value || ''}` !== `${cred.password || ''}`) {
        await typeFieldLikeUser(passInput, cred.password, { perCharDelayMs: 10 });
      }
      suppressPasswordFieldExposure(passInput);
      await sleep(FIELD_FILL_DELAY_MS);
      if (`${passInput.value || ''}` !== `${cred.password || ''}`) {
        setStatus('Password fill did not stick yet — retrying...');
        wake(250);
        return;
      }
      saveFlowHint(cred, LOGIN_FLOW.OPENAI_PASSWORD, 'password_field');
      const btn = findContinueBtn(passInput) || findSubmitBtn('password', passInput);
      if (!btn)            { setStatus('Password filled — Sign In not found yet...'); wake(300); return; }
      if (isDisabled(btn)) { setStatus('Password filled — Sign In not yet enabled...'); wake(250); return; }
      setStatus('Clicking Sign In...');
      await sleep(350);
      if (!safeClick(btn)) { setStatus('Sign In button is not clickable yet...'); wake(250); return; }
      CTX.submitAt = Date.now();
      CTX.submitLockUntil = Date.now() + SUBMIT_LOCK_MS;
      CTX.phase = PHASE.WAIT_REDIRECT;
      wake(POST_CLICK_SETTLE_MS);
      break;
    }

    // ── WAIT_REDIRECT ────────────────────────────────────────
    case PHASE.WAIT_REDIRECT: {
      const elapsed = Date.now() - CTX.submitAt;
      if ((onChatGPTDomain() || onAuthDomain()) && findPasswordInputInModal()) { CTX.submitLockUntil = 0; CTX.phase = PHASE.CHATGPT_PASSWORD; wake(0); return; }
      if ((onChatGPTDomain() || onAuthDomain()) && findEmailInputInModal())    { CTX.submitLockUntil = 0; CTX.phase = PHASE.CHATGPT_EMAIL;    wake(0); return; }
      if ((onChatGPTDomain() || onAuthDomain()) && (findEmailVerificationCodeInput() || isEmailVerificationPage())) {
        CTX.submitLockUntil = 0;
        CTX.phase = PHASE.CHATGPT_EMAIL_OTP;
        wake(0);
        return;
      }
      if (
        isGoogleCredential(CTX.credential)
        && CTX.googleSignInClickedAt
        && elapsed > GOOGLE_AUTH_CANCEL_HINT_MS
        && findGoogleButton()
        && !findPasswordInputInModal()
        && !findEmailInputInModal()
      ) {
        stop('Login Cancelled');
        return;
      }
      if (elapsed > 3000 && findChatGPTLoginErrorMessage()) {
        stop('Invalid Credentials');
        return;
      }
      const timeoutMs = isGoogleCredential(CTX.credential) ? GOOGLE_AUTH_CANCEL_HINT_MS : 20000;
      if (elapsed > timeoutMs) {
        stop(isGoogleCredential(CTX.credential) ? 'Authentication Required' : 'Login Failed');
        return;
      }
      setStatus(
        isGoogleCredential(CTX.credential)
          ? `Waiting for Google Authentication... (${Math.ceil((timeoutMs - elapsed) / 1000)}s)`
          : `Waiting for authentication... (${Math.ceil((timeoutMs - elapsed) / 1000)}s)`
      );
      wake(700);
      break;
    }

    case PHASE.BLOCKED: { stop('Blocked — open this tool from the dashboard first.'); break; }
    case PHASE.DONE:    { stop('✓ Done.', { dismissAfterMs: SUCCESS_BADGE_HIDE_MS }); break; }
  }
}

// ── Mutation observer ─────────────────────────────────────────
function onMutation() {
  if (CTX.stopped) return;
  const now = Date.now();
  if (now - CTX.lastMutationAt < MUTATION_DEBOUNCE_MS) return;
  CTX.lastMutationAt = now;
  const reactive = [
    PHASE.CHATGPT_LANDING,
    PHASE.PREFER_PROVIDER,
    PHASE.CHATGPT_EMAIL,
    PHASE.CHATGPT_PASSWORD,
    PHASE.GOOGLE_CHOOSER,
    PHASE.GOOGLE_EMAIL,
    PHASE.GOOGLE_PASSWORD,
    PHASE.WAIT_REDIRECT,
  ];
  if (reactive.includes(CTX.phase)) wake(200);
}

// ── Raw capture (Phase 2B) ─────────────────────────────────────
// Independent of the auto-login state machine above: raw capture must work
// for organic ChatGPT usage too, not only sessions launched via the
// dashboard, so this never reads/depends on CTX.authorized or CTX.stopped.
// It's the single place that maps a capture signal (from either
// content-chatgpt-network.js via postMessage, or
// content-chatgpt-dom-observer.js via the shared bus) to a Capture
// Contract event and hands it to the background worker's outbox - see
// backend/providers/chatgpt/CAPTURE_CONTRACT.md for the wire shape and
// background-chatgpt-capture.js for what happens to it after that.
// ---- Diagnostic trace (temporary, instrumentation-only) -------------------
// Forensic instrumentation for the "response_started/response_completed
// never emitted" investigation. Persists to chrome.storage.local (not just
// console.debug) so a run with DevTools closed is still inspectable
// afterward - console output during a DevTools-closed run is lost forever,
// which would make the very Run-A-vs-Run-B comparison this exists for
// impossible. Never becomes a ConversationCaptureEvent, never reaches the
// backend - purely local, purely temporary, removed once the investigation
// concludes.
const CAPTURE_TRACE_STORAGE_KEY = 'chatGptCaptureTraceLogV1';
// Raised again: full per-frame tracing (frame_received + a mutation trace
// for every single delta, uncapped up to 4000 per turn on the MAIN-world
// side) means one long response's complete protocol timeline alone can run
// into the thousands of entries. Sized for at least one complete long-turn
// capture without the oldest (bootstrap/init) entries getting evicted
// mid-turn.
const CAPTURE_TRACE_MAX_ENTRIES = 8000;
let captureTraceLog = [];

function persistCaptureTrace() {
  try {
    chrome.storage.local.set({ [CAPTURE_TRACE_STORAGE_KEY]: captureTraceLog });
  } catch {}
  // Kept live (reassigned on every write, not just once at load) since
  // captureTraceLog itself gets reassigned to a new array on clear - a
  // one-time `window.__chatgptProtocolTrace = captureTraceLog` at module
  // load would go stale after that.
  try { window.__chatgptProtocolTrace = captureTraceLog; } catch {}
}

// Bootstrap checkpoints (bus existence, domain/frame gating) intentionally
// always record - they run before feature flags can possibly have loaded,
// and volume is a handful of entries per page load, not per SSE chunk.
function recordCaptureTrace(step, detail, source, at) {
  captureTraceLog.push({ step, at: at || Date.now(), source: source || 'isolated_world', detail: detail || {} });
  if (captureTraceLog.length > CAPTURE_TRACE_MAX_ENTRIES) {
    captureTraceLog.splice(0, captureTraceLog.length - CAPTURE_TRACE_MAX_ENTRIES);
  }
  persistCaptureTrace();
}

// Manual inspection helpers - reachable from this content script's own
// console context (DevTools console context dropdown -> this file), or via
// chrome.storage.local.get('chatGptCaptureTraceLogV1', console.log) from
// anywhere (background page, popup, or this same console) regardless of
// whether DevTools was open during the actual run being inspected.
try {
  window.__rmwDumpCaptureTrace = () => {
    console.table(captureTraceLog.map((entry) => ({
      step: entry.step,
      at: new Date(entry.at).toISOString(),
      source: entry.source,
      detail: JSON.stringify(entry.detail),
    })));
    return captureTraceLog;
  };
  window.__rmwClearCaptureTrace = () => {
    captureTraceLog = [];
    persistCaptureTrace();
  };
  // console.table()/console.log() become unusable well before a long
  // response's full protocol timeline (thousands of frame/mutation
  // entries) - this downloads the complete, structured trace as a real
  // .json file so it can be searched, diffed, and compared across runs
  // programmatically instead of read off a truncated table.
  window.__rmwExportCaptureTrace = () => {
    const filename = `protocol-trace-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    const blob = new Blob([JSON.stringify(captureTraceLog, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    return { entries: captureTraceLog.length, filename };
  };
} catch {}

(async function initChatGptCapture() {
  recordCaptureTrace('isolated_world_capture_init_started', { href: location.href });
  if (window.top !== window) { recordCaptureTrace('isolated_world_skip_iframe', {}); return; } // top frame only - skip OAuth/embed iframes
  if (!onChatGPTDomain()) { recordCaptureTrace('isolated_world_skip_not_chatgpt_domain', { hostname: location.hostname }); return; }
  const bus = window.RMWChatGPTCapture;
  recordCaptureTrace('isolated_world_bus_check', { busExists: Boolean(bus) });
  if (!bus) return; // content-chatgpt-event-builder.js failed to load - fail closed

  // Feature-flag gate (kill switch) - see content-chatgpt-event-builder.js
  // "Feature flags" section. Master switch: if off, install nothing at all
  // (no subscribe, no message listener, no initial conversation_opened) -
  // background-chatgpt-capture.js independently re-checks the same flag
  // before it ever enqueues/uploads, so this is defense-in-depth, not the
  // only gate.
  let flags = await bus.readFeatureFlags();
  recordCaptureTrace('isolated_world_flags_loaded', { enableCapture: flags.enableCapture, enableNetworkCapture: flags.enableNetworkCapture, effectiveDebug: flags.effectiveDebug });
  if (!flags.enableCapture) return;

  function currentConversationIdFromLocation() {
    const match = location.pathname.match(/\/c\/([^/?#]+)/i);
    return match ? match[1] : '';
  }

  // Suppresses the DOM title-change fallback when the network layer already
  // reported the same rename via a PATCH request moments earlier - the title
  // element re-rendering is a direct side-effect of that same action, not an
  // independent occurrence, so without this the two capture paths would
  // build two conversation_renamed events for one user action.
  const RENAME_DOM_FALLBACK_SUPPRESS_MS = 4000;
  const recentNetworkRenameAt = new Map();

  // Local, in-memory-only telemetry (per the review request for duplicate/
  // dropped/failure counters). Not wired into the backend Capture Health
  // schema (CaptureHealthPingIn's fields are fixed Phase 2A work) - surfaced
  // via console.debug (gated by enableDebug) for now.
  const captureTelemetry = {
    eventsSent: 0,
    domRenameDuplicatesSuppressed: 0,
    attachmentsSent: 0,
  };

  function syncFlagsToNetworkScript() {
    try {
      window.postMessage({
        source: 'rmw-chatgpt-capture-orchestrator',
        type: 'CHATGPT_CAPTURE_FLAGS_SYNC',
        payload: {
          enabled: Boolean(flags.enableCapture && flags.enableNetworkCapture),
          debug: Boolean(flags.effectiveDebug),
        },
      }, location.origin);
    } catch {}
  }

  function sendCaptureEvent(event) {
    if (!event) return;
    try {
      if (CTX.credential?.id && !event.credential_id) event.credential_id = CTX.credential.id;
      captureTelemetry.eventsSent += 1;
      // Sanitized observability only - event_type/conversation_id/payload
      // size, never the prompt/response text itself (see Security review in
      // the Phase 2B report for why payload content never touches console).
      if (flags.effectiveDebug) {
        console.debug('[RMW ChatGPT Capture]', event.event_type, {
          conversationId: event.conversation_id || '',
          clientEventId: event.client_event_id,
          captureVersion: event.capture_version,
          captureMode: flags.captureMode,
          payloadBytes: (() => { try { return JSON.stringify(event.payload || {}).length; } catch { return 0; } })(),
          totalSentThisTab: captureTelemetry.eventsSent,
        });
      }
      chrome.runtime.sendMessage({ type: 'CHATGPT_CAPTURE_EVENT', event, tabId: 0 }, () => {
        void chrome.runtime.lastError; // background owns persistence/retry - nothing to do here
      });
    } catch {}
  }

  // ---- Authoritative assistant-content fetch (Slice A) --------------------
  // The streaming SSE reconstruction in content-chatgpt-network.js
  // (applyJsonPointerPatch/applyStreamPatch) guesses at an undocumented,
  // unverified patch-operation vocabulary - confirmed against real production
  // captures to silently drop large spans of text mid-stream (see
  // CAPTURE_CONTRACT.md's response_completed section). Rather than continue
  // guessing at that vocabulary, once the stream ends we re-fetch the
  // conversation's own authoritative state from ChatGPT's stable
  // conversation-fetch endpoint (the same one the ChatGPT UI itself uses to
  // load a past conversation from the sidebar) and read the assistant
  // message straight from there. The streamed text stays as a fallback only
  // - this must never make capture LESS reliable than before, only more
  // faithful when it succeeds.

  function assetPointerToFileId(assetPointer) {
    return `${assetPointer || ''}`.replace(/^file-service:\/\//, '').trim();
  }

  async function resolveAndUploadImagePart(part, conversationId) {
    const fileId = assetPointerToFileId(part.assetPointer);
    if (!fileId) return part;
    try {
      const downloadRes = await fetch(`${location.origin}/backend-api/files/${fileId}/download`, { credentials: 'include' });
      if (!downloadRes.ok) return part; // leave the part as-is (assetPointer only) - not fatal to the rest of the message
      const downloadJson = await downloadRes.json();
      const downloadUrl = downloadJson?.download_url;
      if (!downloadUrl) return part;
      const blob = await (await fetch(downloadUrl)).blob();
      const dataUrl = await bus.readFileAsDataUrl(blob);
      // Reuses the exact upload path already wired for user-input
      // attachments (see the CHATGPT_ATTACHMENT_CAPTURED case below) - just
      // kind: 'output', the column already reserved for this in
      // ConversationCaptureAttachment.
      chrome.runtime.sendMessage({
        type: 'CHATGPT_CAPTURE_ATTACHMENT',
        attachment: {
          conversation_id: conversationId || undefined,
          kind: 'output',
          file_name: fileId,
          mime_type: blob.type || undefined,
          data_url: dataUrl,
        },
      }, () => { void chrome.runtime.lastError; });
      return { ...part, uploaded: true };
    } catch {
      // Per-image failure never aborts the rest of the message - the other
      // content parts (text, other images) are still worth keeping.
      return part;
    }
  }

  function buildContentPartsFromMessage(message) {
    const parts = message?.content?.parts;
    if (!Array.isArray(parts)) return null; // unrecognized shape - caller falls back to stream text
    return parts.map((part, index) => {
      if (typeof part === 'string') {
        return { type: 'markdown', order: index, text: part };
      }
      if (part && typeof part === 'object' && part.content_type === 'image_asset_pointer') {
        return {
          type: 'image',
          order: index,
          assetPointer: part.asset_pointer || '',
          width: part.width || undefined,
          height: part.height || undefined,
          sizeBytes: part.size_bytes || undefined,
        };
      }
      // Anything else (code-interpreter output, browsing display, etc.) -
      // never silently dropped, matches this codebase's lossless-capture
      // philosophy elsewhere (raw payload_json storage, unknown event_types
      // logged not rejected).
      return { type: 'attachment', order: index, raw: part };
    });
  }

  async function fetchAuthoritativeAssistantContent(conversationId, messageId, attempt = 1) {
    recordCaptureTrace('authoritative_fetch_attempt', { conversationId, messageId, attempt }, 'isolated_world');
    if (!conversationId || !messageId) {
      recordCaptureTrace('authoritative_fetch_missing_ids', { conversationId, messageId }, 'isolated_world');
      return null;
    }
    try {
      const url = `${location.origin}/backend-api/conversation/${conversationId}`;
      const res = await fetch(url, {
        credentials: 'include',
        headers: { accept: 'application/json' },
      });
      recordCaptureTrace('authoritative_fetch_response', { conversationId, messageId, status: res.status, ok: res.ok, url }, 'isolated_world');
      if (!res.ok) return null;
      const data = await res.json();
      const mappingKeys = data?.mapping ? Object.keys(data.mapping) : null;
      const message = data?.mapping?.[messageId]?.message;
      recordCaptureTrace('authoritative_fetch_mapping_lookup', {
        conversationId,
        messageId,
        messageFound: Boolean(message),
        mappingKeyCount: mappingKeys ? mappingKeys.length : null,
        // Only useful if the lookup failed - shows whether messageId is
        // simply absent, or present under a different case/format, without
        // dumping the entire (potentially large) mapping object.
        messageIdPresentInMapping: mappingKeys ? mappingKeys.includes(messageId) : null,
        sampleMappingKeys: !message && mappingKeys ? mappingKeys.slice(-5) : null,
      }, 'isolated_world');
      if (!message) {
        // Possible eventual-consistency race right after the stream ends -
        // retry once, short backoff, before giving up to the fallback.
        if (attempt < 2) {
          await new Promise((resolve) => setTimeout(resolve, 400));
          return fetchAuthoritativeAssistantContent(conversationId, messageId, attempt + 1);
        }
        return null;
      }
      let contentParts = buildContentPartsFromMessage(message);
      recordCaptureTrace('authoritative_fetch_content_parts_built', {
        conversationId,
        messageId,
        contentPartsIsNull: contentParts === null,
        partCount: Array.isArray(contentParts) ? contentParts.length : null,
        messageContentType: message?.content?.content_type || null,
        messageContentKeys: message?.content ? Object.keys(message.content) : null,
      }, 'isolated_world');
      if (!contentParts) return null;
      contentParts = await Promise.all(
        contentParts.map((part) => (part.type === 'image' ? resolveAndUploadImagePart(part, conversationId) : part))
      );
      const text = contentParts.filter((part) => part.type === 'markdown').map((part) => part.text).join('');
      const citations = message?.metadata?.content_references || [];
      recordCaptureTrace('authoritative_fetch_succeeded', { conversationId, messageId, textLength: text.length }, 'isolated_world');
      return {
        contentParts,
        citations,
        text,
        hasMarkdown: bus.looksLikeMarkdown(text),
        hasTables: bus.looksLikeTable(text),
        codeBlocks: bus.extractCodeBlocks(text),
      };
    } catch (error) {
      recordCaptureTrace('authoritative_fetch_threw', { conversationId, messageId, error: `${error?.message || error}` }, 'isolated_world');
      return null;
    }
  }

  // Positional comparison, not an LCS-based diff - sufficient for evidence
  // (length delta, where divergence starts/ends, how many characters
  // differ), not meant to be a merge algorithm. Generic over any labeled
  // pair so it works for all three (stream, dom, authoritative) combinations.
  function compareTexts(labelA, textA, labelB, textB) {
    const a = textA || '';
    const b = textB || '';
    const minLength = Math.min(a.length, b.length);
    let firstDifferingIndex = -1;
    for (let i = 0; i < minLength; i += 1) {
      if (a[i] !== b[i]) { firstDifferingIndex = i; break; }
    }
    if (firstDifferingIndex === -1 && a.length !== b.length) firstDifferingIndex = minLength;
    let lastDifferingIndex = -1;
    for (let i = 0; i < minLength; i += 1) {
      const charA = a[a.length - 1 - i];
      const charB = b[b.length - 1 - i];
      if (charA !== charB) {
        lastDifferingIndex = Math.max(a.length - 1 - i, b.length - 1 - i);
        break;
      }
    }
    let differingCharCount = 0;
    for (let i = 0; i < minLength; i += 1) {
      if (a[i] !== b[i]) differingCharCount += 1;
    }
    differingCharCount += Math.abs(a.length - b.length);
    return {
      pair: `${labelA}_vs_${labelB}`,
      [`${labelA}Length`]: a.length,
      [`${labelB}Length`]: b.length,
      lengthDiff: b.length - a.length,
      firstDifferingIndex,
      lastDifferingIndex,
      differingCharCount,
      identical: differingCharCount === 0,
    };
  }

  async function sha256Hex(text) {
    try {
      const bytes = new TextEncoder().encode(text || '');
      const hashBuffer = await crypto.subtle.digest('SHA-256', bytes);
      return Array.from(new Uint8Array(hashBuffer)).map((b) => b.toString(16).padStart(2, '0')).join('');
    } catch {
      return null;
    }
  }

  // ---- Layer D: rendered DOM capture -------------------------------------
  // Reads the finished assistant turn directly from the page's own rendered
  // output - what the user actually sees, with zero dependency on
  // understanding ChatGPT's streaming wire protocol at all. Selector
  // strategy is best-effort: data-message-author-role/data-message-id are a
  // long-standing ChatGPT DOM convention, but this has NOT been verified
  // against a live session in this investigation (no browser access) - the
  // trace records exactly which strategy (if any) found something, so this
  // is self-correcting from real data on first use rather than a silent
  // guess.
  function captureRenderedDomText(messageId) {
    try {
      let container = null;
      let strategyUsed = null;
      if (messageId) {
        container = document.querySelector(`[data-message-id="${messageId}"][data-message-author-role="assistant"]`)
          || document.querySelector(`[data-message-id="${messageId}"]`);
        if (container) strategyUsed = 'message-id-exact';
      }
      if (!container) {
        const candidates = document.querySelectorAll('[data-message-author-role="assistant"]');
        if (candidates.length) {
          container = candidates[candidates.length - 1];
          strategyUsed = 'last-assistant-turn-fallback';
        }
      }
      if (!container) {
        recordCaptureTrace('dom_capture_no_container_found', { messageId }, 'isolated_world');
        return null;
      }
      const text = container.innerText || container.textContent || '';
      recordCaptureTrace('dom_capture_succeeded', {
        messageId,
        strategyUsed,
        textLength: text.length,
        textFirst80: text.slice(0, 80),
        textLast80: text.length > 80 ? text.slice(-80) : text,
      }, 'isolated_world');
      return text;
    } catch (error) {
      recordCaptureTrace('dom_capture_threw', { messageId, error: `${error?.message || error}` }, 'isolated_world');
      return null;
    }
  }

  async function buildAndSendResponseCompletedEvent(payload) {
    // Gather all three independent representations before deciding anything
    // - per the validation-pipeline requirement, none of them silently wins
    // without the other two being captured and compared first.
    const authoritative = await fetchAuthoritativeAssistantContent(payload.conversationId, payload.messageId);
    const streamText = payload.text || '';
    // Small settle delay - the DOM read races the same eventual-consistency
    // window the authoritative-fetch retry already accounts for (React
    // hasn't necessarily finished its final render the instant our
    // end_turn/[DONE] signal fires).
    await new Promise((resolve) => setTimeout(resolve, 300));
    const domText = captureRenderedDomText(payload.messageId) || '';
    const authoritativeText = authoritative ? authoritative.text : '';

    const [streamHash, domHash, authoritativeHash] = await Promise.all([
      sha256Hex(streamText),
      sha256Hex(domText),
      sha256Hex(authoritativeText),
    ]);

    const comparisons = {
      streamVsDom: domText ? compareTexts('stream', streamText, 'dom', domText) : null,
      streamVsAuthoritative: authoritative ? compareTexts('stream', streamText, 'authoritative', authoritativeText) : null,
      domVsAuthoritative: (domText && authoritative) ? compareTexts('dom', domText, 'authoritative', authoritativeText) : null,
    };

    // The consistency-validator record: hashes first (cheap, unambiguous
    // "are these identical" check), then the positional diff only matters
    // when they're not. This is logged unconditionally, regardless of
    // which source the event below ends up using - the validation and the
    // selection decision are deliberately kept separate.
    recordCaptureTrace('validation_result', {
      correlationId: payload.correlationId,
      conversationId: payload.conversationId,
      messageId: payload.messageId,
      streamHash,
      domHash,
      authoritativeHash,
      streamLength: streamText.length,
      domLength: domText.length,
      authoritativeLength: authoritativeText.length,
      streamEqualsDom: Boolean(domText) && streamHash === domHash,
      streamEqualsAuthoritative: Boolean(authoritative) && streamHash === authoritativeHash,
      domEqualsAuthoritative: Boolean(domText) && Boolean(authoritative) && domHash === authoritativeHash,
      comparisons,
    }, 'isolated_world');

    recordCaptureTrace('state_transition', {
      correlationId: payload.correlationId,
      previousState: 'FETCH_AUTHORITATIVE',
      newState: 'COMPLETE',
      detail: { usedSource: authoritative ? 'authoritative_fetch' : 'stream_fallback' },
    }, 'isolated_world');

    // Selection logic is UNCHANGED from before this validation pass -
    // authoritative fetch wins when available, stream text is the fallback.
    // The DOM capture and full 3-way comparison above are evidence-gathering
    // only at this stage, not yet wired into this decision.
    sendCaptureEvent(bus.buildEvent(bus.EVENT_TYPE.RESPONSE_COMPLETED, {
      conversationId: payload.conversationId,
      messageId: payload.messageId,
      payload: {
        text: authoritative ? authoritative.text : streamText,
        textLength: (authoritative ? authoritative.text : streamText).length,
        codeBlocks: authoritative ? authoritative.codeBlocks : (payload.codeBlocks || []),
        hasMarkdown: authoritative ? authoritative.hasMarkdown : Boolean(payload.hasMarkdown),
        hasTables: authoritative ? authoritative.hasTables : Boolean(payload.hasTables),
        contentParts: authoritative ? authoritative.contentParts : undefined,
        citations: authoritative ? authoritative.citations : undefined,
        contentSource: authoritative ? 'authoritative_fetch' : 'stream_fallback',
        stopReason: payload.stopReason || undefined,
        completedAt: new Date().toISOString(),
      },
    }));
  }

  // Additive media-capture hook - calls the function above completely
  // unchanged, then separately triggers DOM/network/observer-based media
  // capture via content-chatgpt-media-capture.js (a different file, zero
  // shared state). Wrapped in try/catch so a media-capture failure can
  // never propagate back into this response-completion path. This
  // function's body, its call site below (which now invokes it instead of
  // buildAndSendResponseCompletedEvent directly), and the matching one-line
  // addition inside the CHATGPT_RESPONSE_STARTED case above (which starts
  // the DOM observer early) are the only changes this feature makes to
  // this file - media capture deliberately does not read from or depend on
  // buildAndSendResponseCompletedEvent/fetchAuthoritativeAssistantContent's
  // internals, since the authoritative fetch they use has been observed
  // failing 100% of the time in production (see
  // RESPONSE_RECONSTRUCTION_REPORT.md) and media capture must not inherit
  // that single point of failure.
  function handleResponseCompletion(payload) {
    buildAndSendResponseCompletedEvent(payload);
    try {
      window.RMWChatGptMediaCapture?.captureGeneratedMediaForResponse?.(payload);
    } catch {}
  }

  function handleCaptureSignal(type, payload) {
    const E = bus.EVENT_TYPE;
    const source = bus.CAPTURE_SOURCE;
    switch (type) {
      case 'CHATGPT_NAV_CHANGED':
        sendCaptureEvent(bus.buildEvent(E.CONVERSATION_OPENED, {
          conversationId: payload.conversationId,
          payload: { title: document.title, url: payload.url, isNewConversation: Boolean(payload.isNewConversation) },
        }));
        break;

      case 'CHATGPT_PROMPT_SUBMITTED':
        sendCaptureEvent(bus.buildEvent(E.PROMPT_CAPTURED, {
          conversationId: payload.conversationId,
          messageId: payload.newMessageId || undefined,
          payload: {
            text: payload.text || '',
            textLength: (payload.text || '').length,
            attachments: payload.attachments || [],
            images: (payload.attachments || []).filter((attachment) => attachment.type === 'image'),
            files: (payload.attachments || []).filter((attachment) => attachment.type === 'file'),
            sequenceIndex: bus.nextSequenceIndex(payload.conversationId),
            promptTimestamp: new Date().toISOString(),
          },
        }));
        break;

      case 'CHATGPT_RESPONSE_STARTED': {
        const turnStarted = bus.markTurnStarted(payload.correlationId);
        recordCaptureTrace('isolated_world_received_response_started', { correlationId: payload.correlationId, turnStarted }, 'isolated_world');
        if (!turnStarted) return;
        sendCaptureEvent(bus.buildEvent(E.RESPONSE_STARTED, {
          conversationId: payload.conversationId,
          messageId: payload.messageId,
          payload: { model: payload.model || undefined, sequenceIndex: bus.nextSequenceIndex(`${payload.conversationId}:response`), startedAt: new Date().toISOString() },
        }));
        // Additive media-capture hook, mirrors the one at
        // CHATGPT_RESPONSE_COMPLETED below - starts watching the DOM as
        // early as possible so images that render progressively during
        // generation are still caught, not just ones present at
        // end_turn. Wrapped in try/catch so it can never affect the line
        // above; does not touch any existing variable/state in this case.
        try {
          window.RMWChatGptMediaCapture?.observeGeneratedMediaForResponse?.(payload);
        } catch {}
        break;
      }

      case 'CHATGPT_MESSAGE_EDITED':
        sendCaptureEvent(bus.buildEvent(E.MESSAGE_EDITED, {
          conversationId: payload.conversationId,
          messageId: payload.newMessageId || undefined,
          payload: {
            originalMessageId: payload.originalMessageId,
            newMessageId: payload.newMessageId || undefined,
            newText: payload.newText,
          },
        }));
        break;

      case 'CHATGPT_RESPONSE_COMPLETED': {
        // Mirrors the markTurnStarted() guard above: consumeTurn() returns
        // undefined for a turn that was already consumed (the double-
        // finalize() bug in content-chatgpt-network.js, now fixed there too
        // as defense in depth) - without this guard a second finalize() for
        // the same turn would build a second response_completed event.
        const turn = bus.consumeTurn(payload.correlationId);
        recordCaptureTrace('isolated_world_received_response_completed', { correlationId: payload.correlationId, turnConsumed: Boolean(turn) }, 'isolated_world');
        if (!turn) return;
        // Fire-and-forget: buildAndSendResponseCompletedEvent awaits the
        // authoritative conversation-fetch (with its own fallback-on-failure
        // built in) before calling sendCaptureEvent - never blocks this
        // synchronous signal handler. handleResponseCompletion() calls it
        // unchanged, then additively triggers media capture - see that
        // function's own comment for why this is the only touch to this
        // file the media capture feature makes.
        handleResponseCompletion(payload);
        // Note: conversation_created for a brand-new conversation is emitted
        // separately by the CHATGPT_CONVERSATION_CREATED signal below (fired
        // once by content-chatgpt-network.js's stream finalizer) - not here,
        // to avoid building two conversation_created events off the same
        // underlying occurrence.
        break;
      }

      case 'CHATGPT_CONVERSATION_CREATED':
        sendCaptureEvent(bus.buildEvent(E.CONVERSATION_CREATED, {
          conversationId: payload.conversationId,
          payload: { title: document.title, url: location.href, model: payload.model || undefined },
        }));
        break;

      case 'CHATGPT_CONVERSATION_MUTATED':
        if (payload.kind === 'renamed') {
          recentNetworkRenameAt.set(payload.conversationId, Date.now());
          sendCaptureEvent(bus.buildEvent(E.CONVERSATION_RENAMED, {
            conversationId: payload.conversationId,
            payload: { newTitle: payload.newTitle },
          }));
        } else if (payload.kind === 'archived') {
          sendCaptureEvent(bus.buildEvent(E.CONVERSATION_ARCHIVED, {
            conversationId: payload.conversationId,
            payload: { archived: Boolean(payload.archived) },
          }));
        } else if (payload.kind === 'deleted') {
          sendCaptureEvent(bus.buildEvent(E.CONVERSATION_DELETED, {
            conversationId: payload.conversationId,
            payload: { detectedVia: payload.detectedVia || 'explicit_delete_action' },
          }));
        } else {
          sendCaptureEvent(bus.buildEvent(E.CONVERSATION_UPDATED, {
            conversationId: payload.conversationId,
            payload: { changedFields: payload.changedFields || [], values: payload.values || {} },
          }));
        }
        break;

      case 'CHATGPT_FILE_UPLOAD_DETECTED':
        sendCaptureEvent(bus.buildEvent(E.FILE_UPLOAD_DETECTED, {
          conversationId: currentConversationIdFromLocation(),
          payload: {
            fileName: payload.fileName,
            mimeType: payload.mimeType || undefined,
            sizeBytes: payload.sizeBytes || undefined,
            attachedTo: payload.attachedTo || 'prompt',
          },
        }));
        break;

      case 'CHATGPT_ATTACHMENT_CAPTURED': {
        // Not part of the lossless capture-event queue - a best-effort
        // binary upload (see providers/chatgpt/attachments.py). Sent as its
        // own message type so background doesn't have to special-case a
        // dataUrl-carrying "event" inside the tiny-JSON event queue.
        if (!flags.enableCapture) break;
        captureTelemetry.attachmentsSent += 1;
        if (flags.effectiveDebug) {
          console.debug('[RMW ChatGPT Capture] attachment captured', {
            conversationId: payload.conversationId || '',
            fileName: payload.fileName,
            sizeBytes: payload.sizeBytes,
            totalAttachmentsSent: captureTelemetry.attachmentsSent,
          });
        }
        chrome.runtime.sendMessage({
          type: 'CHATGPT_CAPTURE_ATTACHMENT',
          attachment: {
            conversation_id: payload.conversationId || undefined,
            kind: 'input',
            file_name: payload.fileName,
            mime_type: payload.mimeType,
            data_url: payload.dataUrl,
          },
        }, () => { void chrome.runtime.lastError; });
        break;
      }

      // Diagnostic-only network signals - not part of the Capture Contract's
      // event_type set, never forwarded as their own event.
      case 'CHATGPT_STREAM_STATUS':
      case 'CHATGPT_PREPARE_DETECTED':
        break;

      // ---- DOM fallback signals (content-chatgpt-dom-observer.js) ---------
      case 'CHATGPT_DOM_TITLE_CHANGED': {
        const lastNetworkRenameAt = recentNetworkRenameAt.get(payload.conversationId) || 0;
        if (Date.now() - lastNetworkRenameAt < RENAME_DOM_FALLBACK_SUPPRESS_MS) {
          captureTelemetry.domRenameDuplicatesSuppressed += 1;
          if (flags.effectiveDebug) {
            console.debug('[RMW ChatGPT Capture] suppressed duplicate DOM rename', {
              conversationId: payload.conversationId,
              totalSuppressed: captureTelemetry.domRenameDuplicatesSuppressed,
            });
          }
          break;
        }
        sendCaptureEvent(bus.buildEvent(E.CONVERSATION_RENAMED, {
          conversationId: payload.conversationId,
          payload: { previousTitle: payload.previousTitle, newTitle: payload.newTitle },
          captureSource: source.DOM_FALLBACK,
        }));
        break;
      }

      case 'CHATGPT_DOM_SIDEBAR_ITEM_REMOVED':
        sendCaptureEvent(bus.buildEvent(E.CONVERSATION_DELETED, {
          conversationId: payload.conversationId,
          payload: { detectedVia: 'sidebar_removal' },
          captureSource: source.DOM_FALLBACK,
        }));
        break;

      case 'CHATGPT_DOM_CANVAS_DETECTED':
        sendCaptureEvent(bus.buildEvent(E.GENERATION_CAPTURED, {
          conversationId: payload.conversationId,
          payload: { outputType: 'canvas' },
          captureSource: source.DOM_FALLBACK,
        }));
        break;

      default:
        break;
    }
  }

  bus.subscribe(handleCaptureSignal);
  syncFlagsToNetworkScript();

  // Live flag toggling: a kill switch that only takes effect after every
  // open tab reloads defeats the point of a kill switch. chrome.storage.local
  // is shared with the background service worker, so flipping the flag from
  // anywhere re-syncs every open ChatGPT tab's MAIN-world hook within one
  // storage round-trip - no reload required.
  try {
    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName !== 'local' || !changes.chatGptCaptureFeatureFlags) return;
      bus.readFeatureFlags().then((nextFlags) => {
        flags = nextFlags;
        syncFlagsToNetworkScript();
      }).catch(() => {});
    });
  } catch {}

  // MAIN-world network signals only ever reach this isolated world via
  // window.postMessage (see content-chatgpt-network.js); DOM-observer
  // signals reach the bus directly since they share this JS realm. Relaying
  // postMessage into bus.emitSignal keeps exactly one dispatch path.
  window.addEventListener('message', (event) => {
    try {
      if (event.source !== window) return;
      if (event.origin !== location.origin) return;
      if (event.data?.source !== 'rmw-chatgpt-network-telemetry') return;
      const { type, payload } = event.data;
      if (!type) return;
      bus.emitSignal(type, payload || {});
    } catch {}
  }, false);

  // Diagnostic trace relay from content-chatgpt-network.js's MAIN-world
  // trace() helper - separate channel/source from the Capture Contract
  // signals above, gated on the existing debug flag (unlike the always-on
  // isolated-world bootstrap checkpoints above, these can fire once per SSE
  // chunk/frame so volume actually matters here).
  window.addEventListener('message', (event) => {
    try {
      if (event.source !== window) return;
      if (event.origin !== location.origin) return;
      if (event.data?.source !== 'rmw-chatgpt-capture-trace') return;
      if (!flags.effectiveDebug) return;
      const { step, at, detail } = event.data;
      if (!step) return;
      recordCaptureTrace(step, detail, 'main_world', at);
    } catch {}
  }, false);

  // The network layer's pushState/replaceState hook only sees *subsequent*
  // SPA navigations - the very first document load needs its own
  // conversation_opened here.
  const initialConversationId = currentConversationIdFromLocation();
  sendCaptureEvent(bus.buildEvent(bus.EVENT_TYPE.CONVERSATION_OPENED, {
    conversationId: initialConversationId,
    payload: { title: document.title, url: location.href, isNewConversation: !initialConversationId },
  }));
})();

// ── Entry point ───────────────────────────────────────────────
function start() {
  const boot = async () => {
    if (onGoogleDomain()) {
      let auth;
      try {
        auth = await checkAuth();
      } catch {
        auth = { authorized: false, hostname: '' };
      }
      if (!auth?.authorized) {
        return;
      }
      CTX.authorized = true;
    }

    ensureBadge();
    CTX.observer = new MutationObserver(onMutation);
    CTX.observer.observe(document.body || document.documentElement, { childList: true, subtree: true, attributes: false });
    CTX.keepAlive = setInterval(() => { if (!CTX.stopped && !CTX.busy && !CTX.timer) wake(0); }, KEEP_ALIVE_MS);
    wake(0);
  };

  boot().catch(() => {});
}

start();
})();
