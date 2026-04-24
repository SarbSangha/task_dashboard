(() => {
// ============================================================
// ChatGPT Auto-Login Content Script — content-chatgpt.js
// KEY FIX: isChatGPTAuthenticated() now requires a mandatory
// DOM-settle wait before it can ever return true.
// The script cannot declare "signed in" until the page has had
// time to paint, React has hydrated, and we have confirmed
// NO login UI is present after at least SETTLE_MS have elapsed.
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

// ── THE FIX: DOM-settle gate ──────────────────────────────────
// isChatGPTAuthenticated() is BANNED from returning true until
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
  credential:       null,
  credentialKey:    '',
  flowHint:         '',
  flowHintLoaded:   false,
  launchHostname:   '',
  credRetries:      0,
  authRetries:      0,
  submitLockUntil:  0,
  submitAt:         0,
  lastRunAt:        0,
  lastMutationAt:   0,
  landingClicks:    0,
  providerClicks:   0,
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
function isGoogleIdentifierUrl() {
  return onGoogleDomain() && location.pathname.includes('/signin/identifier');
}
function isGooglePasswordUrl() {
  return onGoogleDomain() && (location.pathname.includes('/signin/challenge') || location.pathname.includes('/signin/v2/challenge'));
}
function isEmailVerificationPage() {
  return location.pathname.toLowerCase().includes('email-verification')
    || (document.body?.innerText || '').toLowerCase().includes('route error');
}

// ── Login UI detection ────────────────────────────────────────
function isLoginUiPresent() {
  // 1. Visible modal/dialog
  if (queryDeep(['[role="dialog"]', '[aria-modal="true"]']).filter(isVisible).length > 0) return true;
  // 2. Visible email or password input
  if (findInput(EMAIL_SELECTORS) || findInput(PASSWORD_SELECTORS)) return true;
  // 3. Leaf-node visible text matching login phrases
  const loginPhrases = ['welcome back', 'stay logged out', 'log in or sign up'];
  const visibleText = Array.from(document.querySelectorAll('h1,h2,h3,p,span'))
    .filter((el) => el.childElementCount === 0 && isVisible(el))
    .map((el) => (el.innerText || el.textContent || '').trim().toLowerCase())
    .join(' ');
  if (loginPhrases.some((p) => visibleText.includes(p))) return true;
  // 4. Auth path
  const path = location.pathname;
  if (path.includes('/auth/') || path.includes('/login') || path.includes('/signup')) return true;
  return false;
}

// ── THE CORE FIX: settle-gated isChatGPTAuthenticated ─────────
//
// Problem: On first tick the page is barely rendered. The modal
// hasn't painted yet, so isLoginUiPresent() returns false and the
// script wrongly declares success at [boot] phase.
//
// Solution: Two hard gates before we can ever return true:
//   Gate 1 — wall-clock: at least SETTLE_MS must have elapsed
//             since the script started (gives React time to hydrate
//             and the modal time to paint).
//   Gate 2 — consecutive clean ticks: isLoginUiPresent() must
//             return false on SETTLE_TICKS consecutive checks,
//             each separated by at least SETTLE_TICK_GAP_MS.
//             This filters out the brief window where the DOM is
//             partially rendered and the modal isn't visible yet.
//
// Only when BOTH gates pass do we return true.
// If login UI IS present at any point during the settle window,
// we reset the clean-tick counter immediately.
//
function isChatGPTAuthenticated() {
  if (!onChatGPTDomain()) return false;

  const now = Date.now();

  // Gate 1: wall-clock settle
  if (now - CTX.startedAt < SETTLE_MS) return false;

  // Check for login UI
  if (isLoginUiPresent()) {
    // Reset consecutive-clean counter — login UI is present
    CTX.cleanTicks = 0;
    CTX.lastCleanTickAt = 0;
    return false;
  }

  // No login UI found — advance the consecutive-clean counter
  if (CTX.lastCleanTickAt === 0 || now - CTX.lastCleanTickAt >= SETTLE_TICK_GAP_MS) {
    CTX.cleanTicks += 1;
    CTX.lastCleanTickAt = now;
  }

  // Gate 2: require SETTLE_TICKS consecutive clean checks
  if (CTX.cleanTicks < SETTLE_TICKS) return false;

  // Both gates passed → genuinely authenticated
  return true;
}

// ── Provider helpers ──────────────────────────────────────────
function findThirdPartyButtons() {
  return queryDeep(ACTION_SELECTORS).filter((el) => isVisible(el) && !isDisabled(el) && isThirdPartyBtn(el));
}
function findGoogleButton()    { return findThirdPartyButtons().find((el) => btnText(el).includes('google'))    || null; }
function findMicrosoftButton() { return findThirdPartyButtons().find((el) => btnText(el).includes('microsoft')) || null; }

function getPreferredProviderBtn(cred) {
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
    CTX.credential = res.data?.credential || null;
    return CTX.credential;
  }).catch((err) => { credPromise = null; throw err; });
  return credPromise;
}

// ── Stop / wake / run ─────────────────────────────────────────
function stop(msg) {
  CTX.stopped = true;
  if (CTX.timer)     { clearTimeout(CTX.timer);     CTX.timer = null; }
  if (CTX.keepAlive) { clearInterval(CTX.keepAlive); CTX.keepAlive = null; }
  if (CTX.observer)  { CTX.observer.disconnect();    CTX.observer = null; }
  clearTicket();
  setStatus(msg);
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

  // ChatGPT owns its own Google OAuth continuation flow.
  if (onGoogleDomain() && ![PHASE.BOOT, PHASE.AUTH, PHASE.LOAD_CRED].includes(CTX.phase)) {
    await handleGoogleFlow();
    return;
  }

  // Auth check gated behind settle window
  if (isChatGPTAuthenticated()) { stop('✓ Signed in successfully'); return; }

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
        if (!cred?.loginIdentifier || !cred?.password) { stop('Credential incomplete — check dashboard settings.'); return; }
        if (!CTX.flowHintLoaded) {
          CTX.flowHint = await loadFlowHint(cred);
          CTX.flowHintLoaded = true;
        }
        setStatus(`Credentials loaded. Flow hint: "${CTX.flowHint || 'none'}"`);
      } catch (err) {
        CTX.credRetries += 1;
        setStatus(`Credential error: ${err.message} (${CTX.credRetries}/${MAX_CRED_RETRIES})`);
        wake(2000); return;
      }
      CTX.phase = onGoogleDomain() ? PHASE.GOOGLE_CHOOSER : PHASE.CHATGPT_LANDING;
      wake(0);
      break;
    }

    // ── CHATGPT_LANDING ──────────────────────────────────────
    case PHASE.CHATGPT_LANDING: {
      if (isEmailVerificationPage()) { setStatus('Email verification — waiting...'); wake(1500); return; }
      if (findEmailInputInModal())   { CTX.phase = PHASE.CHATGPT_EMAIL;    wake(0); return; }
      if (findPasswordInputInModal()){ CTX.phase = PHASE.CHATGPT_PASSWORD; wake(0); return; }
      if (findLoginDialog() || findThirdPartyButtons().length > 0) { CTX.phase = PHASE.PREFER_PROVIDER; wake(0); return; }
      if (CTX.landingClicks < 3) {
        const btn = findLandingLoginBtn();
        if (btn) {
          CTX.landingClicks += 1;
          setStatus(`Clicking Log In (attempt ${CTX.landingClicks})...`);
          await sleep(300); btn.click(); wake(1500); return;
        }
      }
      setStatus('Waiting for login modal...');
      wake(700);
      break;
    }

    // ── PREFER_PROVIDER ──────────────────────────────────────
    case PHASE.PREFER_PROVIDER: {
      const cred = CTX.credential;
      if (findEmailInputInModal())    { CTX.phase = PHASE.CHATGPT_EMAIL;    wake(0); return; }
      if (findPasswordInputInModal()) { CTX.phase = PHASE.CHATGPT_PASSWORD; wake(0); return; }
      if (Date.now() < CTX.submitLockUntil) { setStatus('Provider clicked — waiting for OAuth redirect...'); wake(600); return; }
      const providerBtn = getPreferredProviderBtn(cred);
      if (providerBtn) {
        const label = btnText(providerBtn);
        if (label.includes('google'))    saveFlowHint(cred, LOGIN_FLOW.GOOGLE,    'provider_button');
        if (label.includes('microsoft')) saveFlowHint(cred, LOGIN_FLOW.MICROSOFT, 'provider_button');
        CTX.providerClicks += 1;
        setStatus(`Clicking "${label}" (attempt ${CTX.providerClicks})...`);
        await sleep(300); providerBtn.click();
        CTX.submitAt = Date.now();
        CTX.submitLockUntil = Date.now() + SUBMIT_LOCK_MS;
        CTX.phase = PHASE.WAIT_REDIRECT;
        wake(POST_CLICK_SETTLE_MS); return;
      }
      setStatus('No provider preference — using email/password...');
      CTX.phase = PHASE.CHATGPT_EMAIL;
      wake(0);
      break;
    }

    // ── CHATGPT_EMAIL ────────────────────────────────────────
    case PHASE.CHATGPT_EMAIL: {
      const cred = CTX.credential;
      const emailInput = findEmailInputInModal();
      if (!emailInput) {
        if (findPasswordInputInModal()) { CTX.phase = PHASE.CHATGPT_PASSWORD; wake(0); return; }
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
      await sleep(350); btn.click();
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
      if (Date.now() < CTX.submitLockUntil) { setStatus('Sign In clicked — waiting...'); wake(500); return; }
      setStatus('Filling password...');
      passInput.focus();
      await sleep(100);
      fillField(passInput, cred.password);
      await sleep(FIELD_FILL_DELAY_MS);
      saveFlowHint(cred, LOGIN_FLOW.OPENAI_PASSWORD, 'password_field');
      const btn = findContinueBtn(passInput) || findSubmitBtn('password', passInput);
      if (!btn)            { setStatus('Password filled — Sign In not found yet...'); wake(300); return; }
      if (isDisabled(btn)) { setStatus('Password filled — Sign In not yet enabled...'); wake(250); return; }
      setStatus('Clicking Sign In...');
      await sleep(350); btn.click();
      CTX.submitAt = Date.now();
      CTX.submitLockUntil = Date.now() + SUBMIT_LOCK_MS;
      CTX.phase = PHASE.WAIT_REDIRECT;
      wake(POST_CLICK_SETTLE_MS);
      break;
    }

    // ── WAIT_REDIRECT ────────────────────────────────────────
    case PHASE.WAIT_REDIRECT: {
      const elapsed = Date.now() - CTX.submitAt;
      if (isChatGPTAuthenticated()) { stop('✓ Signed in'); return; }
      if (onGoogleDomain()) { CTX.submitLockUntil = 0; await handleGoogleFlow(); return; }
      if ((onChatGPTDomain() || onAuthDomain()) && findPasswordInputInModal()) { CTX.submitLockUntil = 0; CTX.phase = PHASE.CHATGPT_PASSWORD; wake(0); return; }
      if ((onChatGPTDomain() || onAuthDomain()) && findEmailInputInModal())    { CTX.submitLockUntil = 0; CTX.phase = PHASE.CHATGPT_EMAIL;    wake(0); return; }
      if (elapsed > 3000) {
        const body = (document.body?.innerText || '').toLowerCase();
        if (['incorrect password','wrong password','invalid email','try again','account not found'].some((e) => body.includes(e))) {
          stop('Login failed — check credentials in dashboard.'); return;
        }
      }
      if (elapsed > 15000) {
        setStatus('Timeout — resetting...'); CTX.submitLockUntil = 0;
        CTX.phase = PHASE.CHATGPT_LANDING; wake(0); return;
      }
      setStatus(`Waiting for redirect... (${Math.ceil((15000 - elapsed) / 1000)}s)`);
      wake(700);
      break;
    }

    case PHASE.BLOCKED: { stop('Blocked — open this tool from the dashboard first.'); break; }
    case PHASE.DONE:    { stop('✓ Done.'); break; }
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
