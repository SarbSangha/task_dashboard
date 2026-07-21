const TOOL_SLUG = 'splice';
const LOGIN_URL = 'https://splice.com/sounds';
const AUTH_URL = 'https://auth.splice.com/';
const BLOCKED_NOTICE_KEY = 'rmw_splice_blocked_notice';
const EXTENSION_TICKET_KEY = 'rmw_extension_ticket';
const SCRIPT_VERSION = 'debug-2026-07-21-splice-05-strict';

const STATE = {
  credential: null,
  requested: false,
  requestAttempts: 0,
  lastRequestAt: 0,
  lastSubmitAt: 0,
  lastActionAt: 0,
  loginOpenAttempts: 0,
  scheduledTimer: null,
  keepAliveTimer: null,
  observer: null,
  lastRunAt: 0,
  lastMutationHandledAt: 0,
  settled: false,
  launchChecked: false,
  launchAuthorized: false,
  launchExpiresAt: 0,
  launchPrepared: false,
  passwordSavingInFlight: false,
  passwordSavingSuppressed: false,
  passwordSavingRestoreTimer: null,
  passwordSwitchTimer: null,
  lastCookieDismissAt: 0,
  status: 'Waiting for Splice login form',
};

const MIN_RUN_GAP_MS = 500;
const KEEP_ALIVE_MS = 4000;
const ACTION_THROTTLE_MS = 700;
const PASSWORD_PROMPT_RESTORE_DELAY_MS = 8000;
const COOKIE_DISMISS_THROTTLE_MS = 1500;
// Splice is a Next.js SSR app: acting before React finishes hydrating trips a
// hydration mismatch (React #418) and our click lands on a node React discards,
// so the login modal never opens on first launch. Wait for load + a short settle
// (enough for hydration, small enough to keep the popup opening quickly).
const PAGE_SETTLE_AFTER_LOAD_MS = 550;
const COOKIE_CONSENT_BUTTON_TEXTS = [
  'accept all cookies',
  'accept all',
  'accept cookies',
  'allow all cookies',
  'allow all',
  'reject all',
  'reject all cookies',
  'got it',
  'i agree',
];

const EMAIL_SELECTORS = [
  'input[type="email"]',
  'input[name="email"]',
  'input[id*="email" i]',
  'input[name*="email" i]',
  'input[autocomplete="username"]',
  'input[autocomplete="email"]',
  'input[placeholder*="email" i]',
  'input[aria-label*="email" i]',
];

const PASSWORD_SELECTORS = [
  'input[type="password"]',
  'input[name="password"]',
  'input[id*="password" i]',
  'input[name*="password" i]',
  'input[autocomplete="current-password"]',
  'input[placeholder*="password" i]',
  'input[aria-label*="password" i]',
];

const ACTION_SELECTORS = [
  'button',
  'a[href]',
  'input[type="submit"]',
  'input[type="button"]',
  '[role="button"]',
  '[tabindex]',
];

function ensureStatusBadge() {
  const existing = document.getElementById('rmw-splice-autologin-status');
  if (existing) return existing;

  const badge = document.createElement('div');
  badge.id = 'rmw-splice-autologin-status';
  badge.style.position = 'fixed';
  badge.style.top = '12px';
  badge.style.right = '12px';
  badge.style.zIndex = '2147483647';
  badge.style.maxWidth = '320px';
  badge.style.padding = '10px 12px';
  badge.style.borderRadius = '10px';
  badge.style.background = 'rgba(15, 23, 42, 0.92)';
  badge.style.color = '#f8fafc';
  badge.style.font = '12px/1.4 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
  badge.style.boxShadow = '0 8px 24px rgba(15, 23, 42, 0.28)';
  badge.style.pointerEvents = 'none';
  badge.style.whiteSpace = 'pre-wrap';
  badge.textContent = `Splice auto-login ${SCRIPT_VERSION}\n${STATE.status || 'Starting auto-login'}`;
  (document.body || document.documentElement).appendChild(badge);
  return badge;
}

function setStatus(message) {
  if (STATE.status === message) return;
  STATE.status = message;
  const badge = ensureStatusBadge();
  if (badge) {
    badge.textContent = `Splice auto-login ${SCRIPT_VERSION}\n${message}`;
  }
  console.debug('[RMW Splice Auto Login]', message);
}

function debugLog(label, data = {}) {
  console.log(`[RMW Splice Auto Login] ${label}`, data);
}

function exposeDebugState() {
  try {
    window.__RMW_STATE = STATE;
    window.__RMW_SPLICE_DEBUG = {
      state: STATE,
      attemptFill,
      attemptOpenSpliceLogin,
      findEmailOptionAction,
      findGoogleOptionAction,
      shouldUseGoogleProvider,
      findUsePasswordInsteadAction,
      clickVisibleText,
      diagnoseEmailStep,
      diagnosePasswordStep,
      forceScheduleAttempt,
    };
  } catch {}
}

function sendRuntimeMessage(message) {
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

function readLaunchTicketFromUrl() {
  const searchParams = new URLSearchParams(window.location.search || '');
  const directQueryTicket = `${searchParams.get('rmw_extension_ticket') || ''}`.trim();
  if (directQueryTicket) {
    return directQueryTicket;
  }

  const hash = `${window.location.hash || ''}`.replace(/^#/, '');
  if (!hash) return '';
  const hashParams = new URLSearchParams(hash);
  return `${hashParams.get('rmw_extension_ticket') || ''}`.trim();
}

function getStoredLaunchTicket() {
  try {
    return `${window.sessionStorage.getItem(EXTENSION_TICKET_KEY) || ''}`.trim();
  } catch {
    return '';
  }
}

function clearStoredLaunchTicket() {
  try {
    window.sessionStorage.removeItem(EXTENSION_TICKET_KEY);
  } catch {}
}

function storeLaunchTicket(ticket) {
  try {
    if (ticket) {
      window.sessionStorage.setItem(EXTENSION_TICKET_KEY, ticket);
    } else {
      window.sessionStorage.removeItem(EXTENSION_TICKET_KEY);
    }
  } catch {}
}

function captureLaunchTicketFromHash() {
  const ticket = readLaunchTicketFromUrl();
  if (!ticket) return '';

  storeLaunchTicket(ticket);
  try {
    const searchParams = new URLSearchParams(window.location.search || '');
    searchParams.delete('rmw_extension_ticket');
    searchParams.delete('rmw_tool_slug');
    const nextSearch = searchParams.toString();
    const cleanUrl = `${window.location.pathname}${nextSearch ? `?${nextSearch}` : ''}`;
    window.history.replaceState(null, '', cleanUrl);
  } catch {}
  return ticket;
}

function isVisible(element) {
  if (!element) return false;
  const rect = element.getBoundingClientRect();
  const style = window.getComputedStyle(element);
  return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
}

function isDisabled(element) {
  if (!element) return true;
  return Boolean(
    element.disabled
    || element.getAttribute('aria-disabled') === 'true'
    || element.getAttribute('disabled') !== null
  );
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

function buttonText(button) {
  return normalizeText(
    `${button?.innerText || button?.textContent || button?.value || button?.getAttribute?.('aria-label') || ''}`
  );
}

function descriptorText(element) {
  const parts = [
    element?.innerText,
    element?.textContent,
    element?.value,
    element?.getAttribute?.('aria-label'),
    element?.getAttribute?.('title'),
    element?.getAttribute?.('alt'),
    element?.getAttribute?.('id'),
    element?.getAttribute?.('class'),
    element?.getAttribute?.('data-provider'),
    element?.getAttribute?.('data-testid'),
    element?.getAttribute?.('data-test'),
    element?.getAttribute?.('href'),
  ];
  element?.querySelectorAll?.('img[alt], svg[aria-label], [aria-label], [title], [alt], [data-provider], [data-testid], [data-test]').forEach((node) => {
    parts.push(
      node.getAttribute?.('alt'),
      node.getAttribute?.('aria-label'),
      node.getAttribute?.('title'),
      node.getAttribute?.('data-provider'),
      node.getAttribute?.('data-testid'),
      node.getAttribute?.('data-test'),
      node.getAttribute?.('class')
    );
  });
  return normalizeText(parts.filter(Boolean).join(' '));
}

function providerHintText(element) {
  if (!element) return '';
  const parts = [descriptorText(element)];
  let current = element.parentElement;
  let depth = 0;
  while (current && current !== document.body && depth < 3) {
    parts.push(
      current.getAttribute?.('aria-label'),
      current.getAttribute?.('title'),
      current.getAttribute?.('data-provider'),
      current.getAttribute?.('data-testid'),
      current.getAttribute?.('data-test'),
      current.getAttribute?.('class'),
      current.getAttribute?.('href')
    );
    current = current.parentElement;
    depth += 1;
  }
  return normalizeText(parts.filter(Boolean).join(' '));
}

function collectActionCandidates(root = document) {
  const directCandidates = Array.from(root.querySelectorAll(ACTION_SELECTORS.join(',')));
  const textCandidates = Array.from(root.querySelectorAll('button, a[href], [role="button"], [tabindex], div, span, p'))
    .map((element) => findClickableAncestor(element));

  return Array.from(new Set([...directCandidates, ...textCandidates]))
    .filter((element) => element && !isDisabled(element) && isVisible(element));
}

function isActionLikeElement(element) {
  if (!element || !isVisible(element) || isDisabled(element)) return false;
  if (element.matches?.(ACTION_SELECTORS.join(','))) return true;
  const style = window.getComputedStyle(element);
  return style.cursor === 'pointer' || typeof element.onclick === 'function';
}

function findClickableAncestor(element) {
  let current = element;
  while (current && current !== document.body) {
    if (isActionLikeElement(current)) return current;
    current = current.parentElement;
  }
  return isVisible(element) ? element : null;
}

function findActionByText({ exact = [], partial = [], exclude = [] } = {}) {
  const exactSet = exact.map(normalizeText);
  const partialSet = partial.map(normalizeText);
  const excludeSet = exclude.map(normalizeText);
  const candidates = collectActionCandidates();

  const matches = candidates.map((element) => {
    const text = buttonText(element);
    const descriptor = descriptorText(element);
    if (!text && !descriptor) return null;
    if (excludeSet.some((value) => text.includes(value) || descriptor.includes(value))) {
      return null;
    }
    const exactTextMatch = exactSet.some((value) => text === value);
    const exactDescriptorMatch = exactSet.some((value) => descriptor === value);
    const partialTextMatch = partialSet.some((value) => text.includes(value));
    const partialDescriptorMatch = partialSet.some((value) => descriptor.includes(value));
    if (!exactTextMatch && !exactDescriptorMatch && !partialTextMatch && !partialDescriptorMatch) {
      return null;
    }

    const rect = element.getBoundingClientRect();
    const area = rect.width * rect.height;
    return {
      element,
      rank: [
        exactTextMatch ? 0 : exactDescriptorMatch ? 1 : partialTextMatch ? 2 : 3,
        text.length || descriptor.length || 999,
        Number.isFinite(area) ? area : Number.MAX_SAFE_INTEGER,
      ],
    };
  }).filter(Boolean);

  matches.sort((a, b) => {
    for (let index = 0; index < a.rank.length; index += 1) {
      if (a.rank[index] !== b.rank[index]) return a.rank[index] - b.rank[index];
    }
    return 0;
  });

  return matches[0]?.element || null;
}

function findVisibleButtonByText(textValues = []) {
  const textSet = textValues.map(normalizeText);
  const candidates = Array.from(document.querySelectorAll('button, a[href], [role="button"]'));
  return candidates.find((element) => {
    if (!element || isDisabled(element) || !isVisible(element)) return false;
    const text = buttonText(element);
    const descriptor = descriptorText(element);
    return textSet.some((value) => text === value || descriptor === value);
  }) || null;
}

function findExactTextAction(textValues = []) {
  const textSet = textValues.map(normalizeText);
  const candidates = Array.from(document.querySelectorAll('*'));
  const textElement = candidates.find((element) => {
    if (!element || !isVisible(element)) return false;
    const directText = normalizeText(element.innerText || element.textContent || '');
    return textSet.some((value) => directText === value);
  });
  if (!textElement) return null;

  const explicitAction = textElement.closest?.('button, a[href], [role="button"], [tabindex]');
  if (explicitAction && !isDisabled(explicitAction) && isVisible(explicitAction)) {
    return explicitAction;
  }

  return findClickableAncestor(textElement) || textElement;
}

function textNodeMatches(node, textValues = []) {
  const text = normalizeText(node?.nodeValue || '');
  if (!text) return false;
  return textValues.map(normalizeText).some((value) => text === value || text.includes(value));
}

function getTextNodeRect(node, textValues = []) {
  try {
    const source = `${node.nodeValue || ''}`;
    const normalizedSource = normalizeText(source);
    const matchValue = textValues.map(normalizeText).find((value) => normalizedSource === value || normalizedSource.includes(value));
    if (!matchValue) return null;
    const sourceLower = source.toLowerCase();
    const matchIndex = sourceLower.indexOf(matchValue.toLowerCase());
    const range = document.createRange();
    if (matchIndex >= 0) {
      range.setStart(node, matchIndex);
      range.setEnd(node, Math.min(source.length, matchIndex + matchValue.length));
    } else {
      range.selectNodeContents(node);
    }
    const rect = Array.from(range.getClientRects()).find((item) => item.width > 0 && item.height > 0)
      || range.getBoundingClientRect();
    range.detach?.();
    return rect && rect.width > 0 && rect.height > 0 ? rect : null;
  } catch {
    return null;
  }
}

function clickAtRenderedText(node, textValues = []) {
  const rect = getTextNodeRect(node, textValues);
  if (!rect) return false;
  const clientX = rect.left + (rect.width / 2);
  const clientY = rect.top + (rect.height / 2);
  const target = document.elementFromPoint(clientX, clientY) || node.parentElement;
  if (!target) return false;

  const action = findClickableAncestor(target) || target;
  const targets = Array.from(new Set([target, action, target.parentElement, action.parentElement].filter(Boolean)));
  const clickOptions = {
    bubbles: true,
    cancelable: true,
    composed: true,
    clientX,
    clientY,
    view: window,
  };

  return targets.some((element) => {
    if (!element || !isVisible(element) || isDisabled(element)) return false;
    try {
      element.focus?.({ preventScroll: true });
    } catch {}
    try {
      if (typeof PointerEvent === 'function') {
        element.dispatchEvent(new PointerEvent('pointerdown', { ...clickOptions, pointerType: 'mouse', isPrimary: true }));
        element.dispatchEvent(new PointerEvent('pointerup', { ...clickOptions, pointerType: 'mouse', isPrimary: true }));
      }
      element.dispatchEvent(new MouseEvent('mousedown', clickOptions));
      element.dispatchEvent(new MouseEvent('mouseup', clickOptions));
      element.dispatchEvent(new MouseEvent('click', clickOptions));
      element.click?.();
      return true;
    } catch {
      return false;
    }
  });
}

function clickVisibleText(textValues = [], label = 'text action') {
  const values = Array.isArray(textValues) ? textValues : [textValues];
  const walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement;
      if (!parent || !isVisible(parent)) return NodeFilter.FILTER_REJECT;
      return textNodeMatches(node, values) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
    },
  });

  let node = walker.nextNode();
  while (node) {
    debugLog('clickVisibleText candidate', {
      label,
      text: normalizeText(node.nodeValue),
      parent: describeElement(node.parentElement),
    });
    if (clickAtRenderedText(node, values)) return true;
    node = walker.nextNode();
  }
  return false;
}

function collectVisibleTextCandidates(textValues = []) {
  const values = Array.isArray(textValues) ? textValues : [textValues];
  const matches = [];
  const walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement;
      if (!parent || !isVisible(parent)) return NodeFilter.FILTER_REJECT;
      return textNodeMatches(node, values) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
    },
  });

  let node = walker.nextNode();
  while (node) {
    const rect = getTextNodeRect(node, values);
    const clientX = rect ? rect.left + (rect.width / 2) : 0;
    const clientY = rect ? rect.top + (rect.height / 2) : 0;
    const pointTarget = rect ? document.elementFromPoint(clientX, clientY) : null;
    matches.push({
      text: normalizeText(node.nodeValue),
      rect: rect ? {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      } : null,
      parent: describeElement(node.parentElement),
      pointTarget: describeElement(pointTarget),
      clickableAncestor: describeElement(findClickableAncestor(pointTarget || node.parentElement)),
    });
    node = walker.nextNode();
  }
  return matches;
}

function diagnoseActionStep({ label, textValues, finder }) {
  const beforeStatus = STATE.status;
  const finderElement = finder?.() || null;
  const textCandidates = collectVisibleTextCandidates(textValues);
  const textClickResult = clickVisibleText(textValues, `${label} diagnostic`);
  const finderClickResult = finderElement ? clickAction(finderElement, `${label} diagnostic`) : false;
  const result = {
    label,
    beforeStatus,
    afterStatus: STATE.status,
    credentialLoaded: Boolean(STATE.credential),
    loginMethod: STATE.credential?.loginMethod || '',
    hasLoginIdentifier: Boolean(STATE.credential?.loginIdentifier),
    hasPassword: Boolean(STATE.credential?.password),
    shouldUseGoogleProvider: shouldUseGoogleProvider(),
    finderElement: describeElement(finderElement),
    textCandidates,
    textClickResult,
    finderClickResult,
  };
  console.log(`[RMW Splice Auto Login] ${label} diagnostic result`, result);
  return result;
}

function diagnoseEmailStep() {
  return diagnoseActionStep({
    label: 'Use email',
    textValues: ['use email', 'sign in with email', 'continue with email'],
    finder: findEmailOptionAction,
  });
}

function diagnosePasswordStep() {
  return diagnoseActionStep({
    label: 'Use password',
    textValues: ['use password', 'use password instead', 'sign in with password', 'log in with password'],
    finder: findUsePasswordInsteadAction,
  });
}

function findInput(selectors) {
  for (const selector of selectors) {
    const inputs = Array.from(document.querySelectorAll(selector));
    const match = inputs.find((input) => !input.disabled && !input.readOnly && isVisible(input));
    if (match) return match;
  }
  return null;
}

function clearPageStorage() {
  try {
    window.localStorage.clear();
  } catch {}
  try {
    const blockedNotice = window.sessionStorage.getItem(BLOCKED_NOTICE_KEY);
    const extensionTicket = window.sessionStorage.getItem(EXTENSION_TICKET_KEY);
    window.sessionStorage.clear();
    if (blockedNotice) {
      window.sessionStorage.setItem(BLOCKED_NOTICE_KEY, blockedNotice);
    }
    if (extensionTicket) {
      window.sessionStorage.setItem(EXTENSION_TICKET_KEY, extensionTicket);
    }
  } catch {}
}

function setInputValue(input, value) {
  const descriptor = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value');
  if (descriptor?.set) descriptor.set.call(input, value);
  else input.value = value;

  input.setAttribute('value', value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
  input.dispatchEvent(new Event('blur', { bubbles: true }));
}

function safeClick(element) {
  if (!element || isDisabled(element) || !isVisible(element)) return false;
  try {
    element.scrollIntoView({ block: 'center', inline: 'nearest' });
  } catch {}
  try {
    element.focus({ preventScroll: true });
  } catch {}

  const rect = element.getBoundingClientRect();
  const clickOptions = {
    bubbles: true,
    cancelable: true,
    composed: true,
    clientX: rect.left + (rect.width / 2),
    clientY: rect.top + (rect.height / 2),
    view: window,
  };

  try {
    if (typeof PointerEvent === 'function') {
      ['pointerdown', 'pointerup'].forEach((eventName) => {
        try {
          element.dispatchEvent(new PointerEvent(eventName, {
            ...clickOptions,
            pointerType: 'mouse',
            isPrimary: true,
          }));
        } catch {}
      });
    }
    ['mousedown', 'mouseup', 'click'].forEach((eventName) => {
      try {
        element.dispatchEvent(new MouseEvent(eventName, clickOptions));
      } catch {}
    });
    if (typeof element.click === 'function') {
      element.click();
    }
    return true;
  } catch {
    try {
      element.dispatchEvent(new MouseEvent('click', clickOptions));
      return true;
    } catch {
      return false;
    }
  }
}

function dispatchKeyboardActivation(element) {
  if (!element || isDisabled(element) || !isVisible(element)) return false;
  try {
    element.focus({ preventScroll: true });
  } catch {}

  ['keydown', 'keyup'].forEach((eventName) => {
    try {
      element.dispatchEvent(new KeyboardEvent(eventName, {
        bubbles: true,
        cancelable: true,
        composed: true,
        key: 'Enter',
        code: 'Enter',
        view: window,
      }));
    } catch {}
  });
  return true;
}

function describeElement(element) {
  if (!element) return 'none';
  const rect = element.getBoundingClientRect();
  return {
    tag: element.tagName,
    text: element.innerText || element.textContent || element.value || element.getAttribute?.('aria-label') || '',
    className: element.className,
    rect: {
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    },
  };
}

function clickAction(element, label, delays = [0, 250, 900]) {
  if (!element) return false;
  console.log('[RMW Splice Auto Login] clicking action', label, describeElement(element));
  delays.forEach((delay) => {
    window.setTimeout(() => {
      if (!isVisible(element) || isDisabled(element)) return;
      console.log('[RMW Splice Auto Login] click attempt', label, delay);
      safeClick(element);
      dispatchKeyboardActivation(element);
    }, delay);
  });
  return true;
}

function findEmailInput() {
  return findInput(EMAIL_SELECTORS);
}

function findPasswordInput() {
  return findInput(PASSWORD_SELECTORS);
}

function findCookieConsentAction() {
  const directButton = findVisibleButtonByText(COOKIE_CONSENT_BUTTON_TEXTS);
  if (directButton) return directButton;
  return findActionByText({
    exact: COOKIE_CONSENT_BUTTON_TEXTS,
    partial: ['accept all', 'reject all', 'allow all', 'accept cookies'],
    exclude: ['manage', 'settings', 'preferences', 'customize', 'more options', 'privacy choices'],
  });
}

// Fresh (incognito) sessions always show Splice's cookie-consent banner, whose
// backdrop can swallow the click that opens the login modal. Clear it first.
function maybeDismissCookieConsent() {
  const now = Date.now();
  if (now - STATE.lastCookieDismissAt < COOKIE_DISMISS_THROTTLE_MS) return false;

  const consentAction = findCookieConsentAction();
  if (consentAction) {
    STATE.lastCookieDismissAt = now;
    debugLog('Dismissing Splice cookie consent', describeElement(consentAction));
    safeClick(consentAction);
    return true;
  }

  if (clickVisibleText(COOKIE_CONSENT_BUTTON_TEXTS, 'Cookie consent')) {
    STATE.lastCookieDismissAt = now;
    return true;
  }
  return false;
}

function findHomeSignInAction() {
  return findActionByText({
    exact: ['log in', 'sign in', 'log in / sign up'],
    partial: ['log in', 'sign in'],
    exclude: ['google', 'apple', 'sso', 'email', 'phone', 'microsoft', 'discord', 'cookie'],
  });
}

function findEmailOptionAction() {
  const directButton = findVisibleButtonByText(['use email', 'sign in with email', 'continue with email']);
  if (directButton) return directButton;

  const exactTextAction = findExactTextAction(['use email', 'sign in with email', 'continue with email']);
  if (exactTextAction) return exactTextAction;

  return findActionByText({
    exact: ['sign in with email', 'use email', 'email'],
    partial: [
      'sign in with email',
      'continue with email',
      'use email',
      'email sign-in',
      'email login',
    ],
  });
}

function findGoogleOptionAction() {
  const directMatch = findVisibleButtonByText([
    'sign in with google',
    'continue with google',
    'log in with google',
    'login with google',
    'google',
  ]);
  if (directMatch) return directMatch;

  const broadMatch = collectActionCandidates().find((element) => {
    const text = buttonText(element);
    const descriptor = descriptorText(element);
    const hints = providerHintText(element);
    const href = normalizeText(element.getAttribute?.('href') || '');
    return text.includes('sign in with google')
      || text.includes('continue with google')
      || text.includes('log in with google')
      || text.includes('login with google')
      || text.includes('continue using google')
      || text === 'google'
      || descriptor.includes('sign in with google')
      || descriptor.includes('continue with google')
      || descriptor.includes('log in with google')
      || descriptor.includes('login with google')
      || descriptor.includes('continue using google')
      || descriptor === 'google'
      || href.includes('accounts.google.com')
      || (href.includes('oauth') && href.includes('google'))
      || (hints.includes('google') && (hints.includes('oauth') || hints.includes('social') || hints.includes('continue') || hints.includes('sign')));
  });
  if (broadMatch) return broadMatch;

  return findActionByText({
    exact: ['sign in with google', 'continue with google'],
    partial: ['sign in with google', 'continue with google', 'log in with google', 'login with google', 'continue using google'],
  });
}

// On the Keycloak login page "Continue with Google" is an anchor to a broker
// endpoint. A synthetic click on its inner content only focuses it, so the page
// never leaves auth.splice.com. Resolve the real href and navigate to it.
function resolveGoogleOptionHref(option) {
  if (!option) return '';
  const candidates = [];
  if (option.matches?.('a[href]')) candidates.push(option);
  const closestAnchor = option.closest?.('a[href]');
  if (closestAnchor) candidates.push(closestAnchor);
  option.querySelectorAll?.('a[href]').forEach((anchor) => candidates.push(anchor));

  for (const anchor of candidates) {
    const href = `${anchor.getAttribute?.('href') || anchor.href || ''}`.trim();
    if (!href) continue;
    const lowered = href.toLowerCase();
    if (lowered.startsWith('#') || lowered.startsWith('javascript:')) continue;
    if (lowered.includes('google')
      || lowered.includes('broker')
      || lowered.includes('oauth')
      || lowered.includes('social')
      || lowered.includes('kc_idp_hint')
      || lowered.includes('/idp')) {
      try {
        return new URL(href, window.location.href).toString();
      } catch {
        return href;
      }
    }
  }
  return '';
}

// Keycloak's social sign-in is always an anchor to a broker endpoint. Scan the
// whole page for it so we can navigate directly regardless of how the visible
// button/wrapper is structured (and regardless of trusted-click requirements).
// Auth0 renders social sign-in either as a link to /authorize?connection=... or
// (New Universal Login) as a form-submit button. Prefer a real anchor if present.
function findGoogleBrokerHref() {
  const anchors = Array.from(document.querySelectorAll('a[href]'));
  for (const anchor of anchors) {
    const rawHref = `${anchor.getAttribute?.('href') || anchor.href || ''}`.trim();
    if (!rawHref) continue;
    const lowered = rawHref.toLowerCase();
    if (lowered.startsWith('#') || lowered.startsWith('javascript:')) continue;
    // Ignore footer policy links to google.com (privacy/terms/reCAPTCHA).
    if (lowered.includes('policies.google.com') || lowered.includes('google.com/intl')) continue;
    const looksLikeGoogleAuth = lowered.includes('connection=google')
      || lowered.includes('google-oauth2')
      || (lowered.includes('/authorize') && lowered.includes('google'))
      || lowered.includes('kc_idp_hint=google');
    if (looksLikeGoogleAuth) {
      try {
        return new URL(rawHref, window.location.href).toString();
      } catch {
        return rawHref;
      }
    }
  }
  return '';
}

// Auth0 New Universal Login social buttons are form-submit buttons. Find the
// "Continue with Google" button and submit its form (which POSTs the connection
// and 302s to Google). Never submit the email/password form.
function submitSpliceGoogleForm() {
  const button = findGoogleOptionAction();
  if (!button) return false;
  debugLog('submitSpliceGoogleForm target', {
    tag: button.tagName,
    html: `${button.outerHTML || ''}`.slice(0, 300),
  });
  const form = button.closest?.('form');
  clickAction(button, 'Continue with Google');
  if (form && !form.contains(findEmailInput()) && !form.contains(findPasswordInput())) {
    window.setTimeout(() => {
      if (STATE.settled) return;
      setStatus('Submitting Splice Google sign-in');
      try {
        if (typeof form.requestSubmit === 'function') {
          form.requestSubmit(button.matches?.('button, input[type="submit"]') ? button : undefined);
        } else {
          form.submit();
        }
      } catch {}
    }, 300);
  }
  return true;
}

function activateGoogleOption(option, label = 'Google sign-in') {
  try {
    debugLog('activateGoogleOption target', {
      tag: option?.tagName,
      href: option?.getAttribute?.('href') || option?.closest?.('a[href]')?.getAttribute?.('href') || '',
      brokerHref: findGoogleBrokerHref(),
      html: `${option?.outerHTML || ''}`.slice(0, 400),
    });
  } catch {}

  const href = findGoogleBrokerHref() || resolveGoogleOptionHref(option);
  if (href) {
    setStatus('Opening Google sign-in');
    debugLog('Navigating to Google broker href', { href });
    window.location.assign(href);
    return true;
  }

  clickAction(option, label);

  // Some Keycloak themes render the social button as a real submit button with
  // no href. Submit its form directly (never the email/password form).
  const form = option?.closest?.('form');
  if (form && !form.contains(findEmailInput()) && !form.contains(findPasswordInput())) {
    window.setTimeout(() => {
      if (STATE.settled) return;
      setStatus('Submitting Google sign-in');
      try {
        if (typeof form.requestSubmit === 'function') {
          form.requestSubmit(option?.matches?.('button, input[type="submit"]') ? option : undefined);
        } else {
          form.submit();
        }
      } catch {}
    }, 350);
  }
  return true;
}

function isGoogleCredential() {
  return normalizeLoginMethod(STATE.credential?.loginMethod) === 'google';
}

function shouldUseGoogleProvider() {
  return isGoogleCredential();
}

function credentialLoginRoute() {
  return shouldUseGoogleProvider() ? 'google' : 'email';
}

function stateSnapshotText() {
  return [
    `route=${credentialLoginRoute()}`,
    `checked=${STATE.launchChecked ? '1' : '0'}`,
    `auth=${STATE.launchAuthorized ? '1' : '0'}`,
    `prep=${STATE.launchPrepared ? '1' : '0'}`,
    `settled=${STATE.settled ? '1' : '0'}`,
  ].join(' ');
}

function findUsePasswordInsteadAction() {
  const directButton = findVisibleButtonByText([
    'use password',
    'use password instead',
    'sign in with password',
    'log in with password',
  ]);
  if (directButton) return directButton;

  const exactTextAction = findExactTextAction([
    'use password',
    'use password instead',
    'sign in with password',
    'log in with password',
  ]);
  if (exactTextAction) return exactTextAction;

  return findActionByText({
    exact: [
      'use password',
      'use password instead',
      'sign in with password',
      'log in with password',
    ],
    partial: [
      'use password',
      'use password instead',
      'sign in with password',
      'log in with password',
      'password login',
    ],
  });
}

function findSubmitButton(emailInput, passwordInput) {
  const candidates = collectActionCandidates();
  const priorityWords = passwordInput
    ? ['log in', 'login', 'sign in']
    : ['continue', 'next', 'log in', 'login', 'sign in'];

  const directMatch = candidates.find((element) => {
    const text = buttonText(element);
    return priorityWords.some((word) => text === word);
  });
  if (directMatch) return directMatch;

  const partialMatch = candidates.find((element) => {
    const text = buttonText(element);
    return priorityWords.some((word) => text.includes(word));
  });
  if (partialMatch) return partialMatch;

  return candidates.find((element) => element.type === 'submit') || null;
}

function onSpliceHost() {
  return window.location.hostname === 'splice.com'
    || window.location.hostname.endsWith('.splice.com');
}

// Splice uses a dedicated Auth0 login page on a separate origin
// (auth.splice.com), similar to HeyGen's separate auth host.
function onAuthHost() {
  return window.location.hostname === 'auth.splice.com';
}

function isLandingPage() {
  const host = window.location.hostname;
  return host === 'splice.com' || host === 'www.splice.com';
}

function isLoginPage() {
  return onAuthHost()
    || Boolean(findEmailInput())
    || Boolean(findPasswordInput())
    || Boolean(findEmailOptionAction())
    || Boolean(findGoogleOptionAction())
    || Boolean(findUsePasswordInsteadAction())
    || (onSpliceHost() && Boolean(findHomeSignInAction()));
}

function looksLikeAuthenticatedWorkspace() {
  if (!onSpliceHost()) return false;
  if (onAuthHost()) return false;
  if (findEmailInput() || findPasswordInput() || findEmailOptionAction() || findGoogleOptionAction() || findUsePasswordInsteadAction()) {
    return false;
  }

  // Positive signals that only appear once signed in to the Splice app. Check
  // these first because Splice keeps a "Log in" link in the footer even when
  // authenticated, which would otherwise make us think we are logged out.
  const bodyText = `${document.body?.innerText || ''}`.toLowerCase();
  const signedInSignals = [
    'daily picks',
    'my library',
    'my sounds',
    "you're currently previewing",
    'youre currently previewing',
    'currently previewing splice',
    'manage plan',
    'account settings',
    'log out',
    'sign out',
  ];
  if (signedInSignals.some((signal) => bodyText.includes(signal))) {
    return true;
  }

  if (findHomeSignInAction()) {
    return false;
  }

  const workspaceWords = ['sounds', 'create', 'library', 'samples', 'browse', 'download', 'credits', 'studio', 'presets', 'playlists', 'account'];
  const matched = new Set();
  Array.from(document.querySelectorAll('a, button, nav *, main *')).forEach((element) => {
    const text = buttonText(element);
    if (!text) return;
    workspaceWords.forEach((word) => {
      if (text === word || text.startsWith(`${word} `) || text.includes(` ${word} `)) {
        matched.add(word);
      }
    });
  });
  return matched.size >= 3;
}

async function ensurePasswordSavingSuppressed() {
  if (STATE.passwordSavingSuppressed) return true;

  const response = await sendRuntimeMessage({
    type: 'TOOL_HUB_SET_PASSWORD_SAVING_SUPPRESSED',
    suppressed: true,
  });

  if (!response?.ok) {
    setStatus(response?.error || 'Could not suppress Chrome password prompt');
    return false;
  }

  STATE.passwordSavingSuppressed = true;
  return true;
}

function requestPasswordSavingSuppression() {
  if (STATE.passwordSavingSuppressed || STATE.passwordSavingInFlight) {
    return;
  }

  STATE.passwordSavingInFlight = true;
  setStatus('Disabling Chrome password-save prompt...');

  ensurePasswordSavingSuppressed()
    .then((ok) => {
      if (!ok) {
        STATE.passwordSavingInFlight = false;
        STATE.settled = true;
        setStatus('Blocked: Chrome password-save prompt could not be disabled.');
        return;
      }

      STATE.passwordSavingInFlight = false;
      scheduleAttempt(50);
    })
    .catch((error) => {
      STATE.passwordSavingInFlight = false;
      STATE.settled = true;
      setStatus(`Blocked: ${error?.message || 'Could not disable Chrome password-save prompt.'}`);
    });
}

function releasePasswordSavingSuppressed(delay = 0) {
  if (STATE.passwordSavingRestoreTimer) {
    window.clearTimeout(STATE.passwordSavingRestoreTimer);
    STATE.passwordSavingRestoreTimer = null;
  }

  STATE.passwordSavingRestoreTimer = window.setTimeout(() => {
    sendRuntimeMessage({
      type: 'TOOL_HUB_SET_PASSWORD_SAVING_SUPPRESSED',
      suppressed: false,
    });
    STATE.passwordSavingSuppressed = false;
    STATE.passwordSavingRestoreTimer = null;
  }, Math.max(0, delay));
}

async function loadLaunchState() {
  const directTicket = captureLaunchTicketFromHash() || getStoredLaunchTicket();
  if (directTicket) {
    const activation = await sendRuntimeMessage({
      type: 'TOOL_HUB_ACTIVATE_LAUNCH',
      toolSlug: TOOL_SLUG,
      hostname: window.location.hostname,
      pageUrl: window.location.href,
      extensionTicket: directTicket,
    });

    if (activation?.ok && activation.authorized) {
      clearStoredLaunchTicket();
      STATE.launchChecked = true;
      STATE.launchAuthorized = true;
      STATE.launchExpiresAt = Number(activation.expiresAt || 0);
      STATE.launchPrepared = Boolean(activation.prepared);
      return;
    }

    clearStoredLaunchTicket();
  }

  const response = await sendRuntimeMessage({
    type: 'TOOL_HUB_GET_LAUNCH_STATE',
    toolSlug: TOOL_SLUG,
    hostname: window.location.hostname,
    pageUrl: window.location.href,
  });

  STATE.launchChecked = true;
  STATE.launchAuthorized = Boolean(response?.ok && response.authorized);
  STATE.launchExpiresAt = Number(response?.ok && response.authorized ? response.expiresAt || 0 : 0);
  STATE.launchPrepared = Boolean(response?.ok && response.authorized && response.prepared);
}

async function clearToolSession(options = {}) {
  clearPageStorage();
  await sendRuntimeMessage({
    type: 'TOOL_HUB_CLEAR_TOOL_SESSION',
    toolSlug: TOOL_SLUG,
    preserveLaunch: Boolean(options.preserveLaunch),
  });
}

async function enforceDashboardOnlyAccess() {
  const alreadyNotified = window.sessionStorage.getItem(BLOCKED_NOTICE_KEY) === '1';
  releasePasswordSavingSuppressed(0);

  if (!isLoginPage()) {
    await clearToolSession();
    window.sessionStorage.setItem(BLOCKED_NOTICE_KEY, '1');
    window.location.replace(LOGIN_URL);
    return false;
  }

  if (!alreadyNotified) {
    window.sessionStorage.setItem(BLOCKED_NOTICE_KEY, '1');
  }

  setStatus('Launch this tool from the dashboard first');
  STATE.settled = true;
  return false;
}

async function ensureFreshLaunchSession() {
  if (!STATE.launchExpiresAt) {
    return false;
  }

  if (STATE.launchPrepared) {
    return true;
  }

  // Splice launches run in a fresh Incognito window, so the session is already
  // clean. Clearing + reloading here only loops on splice.com without ever
  // opening the login, so mark the launch prepared in place and continue.
  await sendRuntimeMessage({
    type: 'TOOL_HUB_MARK_FRESH_SESSION_PREPARED',
    toolSlug: TOOL_SLUG,
  });
  STATE.launchPrepared = true;
  window.sessionStorage.removeItem(BLOCKED_NOTICE_KEY);
  return true;
}

function requestCredential() {
  const now = Date.now();
  if (STATE.requested) return;
  if (STATE.requestAttempts >= 4) return;
  if (now - STATE.lastRequestAt < 2000) return;

  STATE.requested = true;
  STATE.lastRequestAt = now;
  STATE.requestAttempts += 1;
  setStatus(`Fetching credential (attempt ${STATE.requestAttempts})`);

  chrome.runtime.sendMessage(
    {
      type: 'TOOL_HUB_GET_CREDENTIAL',
      toolSlug: TOOL_SLUG,
      hostname: window.location.hostname,
      pageUrl: window.location.href,
      extensionTicket: getStoredLaunchTicket(),
    },
    (response) => {
      STATE.requested = false;

      if (chrome.runtime.lastError) {
        setStatus(`Extension error: ${chrome.runtime.lastError.message}`);
        STATE.settled = true;
        return;
      }

      if (!response?.ok) {
        if ((response?.error || '').toLowerCase().includes('launch this tool from the dashboard first')) {
          clearStoredLaunchTicket();
        }
        setStatus(response?.error || 'Credential unavailable');
        return;
      }

      clearStoredLaunchTicket();
      STATE.credential = response.data?.credential || null;
      STATE.settled = false;
      setStatus(STATE.credential ? `Credential loaded, chooser queued\n${stateSnapshotText()}` : 'Credential missing');
      exposeDebugState();
      debugLog('CREDENTIAL RECEIVED', {
        credentialLoaded: Boolean(STATE.credential),
        hasLoginIdentifier: Boolean(STATE.credential?.loginIdentifier),
        hasPassword: Boolean(STATE.credential?.password),
        launchChecked: STATE.launchChecked,
        launchAuthorized: STATE.launchAuthorized,
        launchPrepared: STATE.launchPrepared,
        settled: STATE.settled,
      });
      debugLog('FORCING RUN');
      window.setTimeout(() => {
        debugLog('DIRECT provider choice AFTER CREDENTIAL');
        try {
          if (!attemptProviderChoice('credential-loaded')) {
            debugLog('DIRECT attemptFill AFTER CREDENTIAL');
            attemptFill();
          }
        } catch (error) {
          setStatus(`Splice direct run error: ${error?.message || 'Unknown error'}`);
          releasePasswordSavingSuppressed(0);
        }
      }, 0);
      forceScheduleAttempt(150);
    }
  );
}

function canActNow() {
  return Date.now() - STATE.lastActionAt > ACTION_THROTTLE_MS;
}

function nextActionDelay() {
  return Math.max(100, ACTION_THROTTLE_MS - (Date.now() - STATE.lastActionAt) + 50);
}

function markActionTaken() {
  STATE.lastActionAt = Date.now();
}

function schedulePasswordSwitchAfterEmailChoice(attempt = 1) {
  if (STATE.passwordSwitchTimer) {
    window.clearTimeout(STATE.passwordSwitchTimer);
    STATE.passwordSwitchTimer = null;
  }

  STATE.passwordSwitchTimer = window.setTimeout(() => {
    STATE.passwordSwitchTimer = null;
    if (STATE.settled || shouldUseGoogleProvider()) return;

    const passwordInput = findPasswordInput();
    if (passwordInput) {
      forceScheduleAttempt(50);
      return;
    }

    const emailInput = findEmailInput();
    const passwordOption = findUsePasswordInsteadAction();
    if (passwordOption || emailInput) {
      setStatus(`Opening Splice password sign-in (attempt ${attempt})`);
      if (attemptSwitchToPassword(emailInput)) return;
    }

    if (attempt < 8) {
      schedulePasswordSwitchAfterEmailChoice(attempt + 1);
    } else {
      setStatus('Splice password option not found after email choice');
      forceScheduleAttempt(200);
    }
  }, attempt === 1 ? 500 : 750);
}

function attemptOpenSpliceLogin() {
  debugLog('attemptOpenSpliceLogin CALLED', {
    canActNow: canActNow(),
    loginOpenAttempts: STATE.loginOpenAttempts,
  });

  const emailInput = findEmailInput();
  const passwordInput = findPasswordInput();
  debugLog('attemptOpenSpliceLogin fields', {
    emailInput: describeElement(emailInput),
    passwordInput: describeElement(passwordInput),
  });
  if (emailInput || passwordInput) {
    debugLog('attemptOpenSpliceLogin EXIT existing fields');
    return false;
  }

  // Splice's "Log in" triggers a client-side navigation to the Auth0 /authorize
  // endpoint. Re-clicking it (mutation observer, keep-alive, retry) cancels the
  // in-flight navigation, so it never reaches the login page. After a click,
  // hold off long enough for the Auth0 redirect chain to land.
  const nowTs = Date.now();
  if (STATE.loginOpenCooldownUntil && nowTs < STATE.loginOpenCooldownUntil) {
    debugLog('attemptOpenSpliceLogin cooldown active', {
      remainingMs: STATE.loginOpenCooldownUntil - nowTs,
    });
    setStatus('Opening Splice sign-in');
    scheduleAttempt(STATE.loginOpenCooldownUntil - nowTs + 100);
    return true;
  }

  // Clear the consent banner before trying to open the modal so its backdrop
  // cannot intercept the click.
  if (maybeDismissCookieConsent()) {
    scheduleAttempt(200);
    return true;
  }

  if (shouldUseGoogleProvider()) {
    const googleOption = findGoogleOptionAction();
    debugLog('googleOption=', describeElement(googleOption));
    if (googleOption) {
      if (canActNow()) {
        markActionTaken();
        STATE.loginOpenAttempts += 1;
        setStatus('Opening Splice Google sign-in');
        activateGoogleOption(googleOption, 'Google sign-in');
        scheduleAttempt(600);
      } else {
        debugLog('Google option found, waiting for action throttle');
        scheduleAttempt(nextActionDelay());
      }
      return true;
    }
  }

  const emailOption = findEmailOptionAction();
  debugLog('emailOption=', describeElement(emailOption));
  if (emailOption) {
    if (canActNow()) {
      markActionTaken();
      STATE.loginOpenAttempts += 1;
      setStatus('Opening Splice email sign-in');
      clickAction(emailOption, 'Use email');
      scheduleAttempt(600);
    } else {
      debugLog('Email option found, waiting for action throttle');
      scheduleAttempt(nextActionDelay());
    }
    return true;
  }

  const homeSignIn = findHomeSignInAction();
  debugLog('homeSignIn=', describeElement(homeSignIn));
  if (homeSignIn) {
    if (canActNow()) {
      markActionTaken();
      STATE.loginOpenAttempts += 1;
      STATE.loginOpenCooldownUntil = Date.now() + 6000;
      setStatus('Opening Splice sign-in');
      clickAction(homeSignIn, 'Log in');
      scheduleAttempt(6000);
    } else {
      debugLog('Sign-in option found, waiting for action throttle');
      scheduleAttempt(nextActionDelay());
    }
    return true;
  }

  // Fallback: click the "Log in" label directly when it is not exposed as a
  // conventional button/anchor the finder recognises.
  if (canActNow() && clickVisibleText(['log in', 'sign in', 'log in / sign up'], 'Log in')) {
    markActionTaken();
    STATE.loginOpenAttempts += 1;
    STATE.loginOpenCooldownUntil = Date.now() + 6000;
    setStatus('Opening Splice sign-in');
    scheduleAttempt(6000);
    return true;
  }

  if (!onSpliceHost() && canActNow()) {
    markActionTaken();
    STATE.loginOpenAttempts += 1;
    setStatus('Redirecting to Splice sign-in');
    window.location.replace(LOGIN_URL);
    return true;
  }

  return false;
}

function attemptProviderChoice(source = 'provider-choice') {
  const route = credentialLoginRoute();
  setStatus(`Inspecting Splice ${route} sign-in (${source})\n${stateSnapshotText()}`);

  const emailInput = findEmailInput();
  const passwordInput = findPasswordInput();
  const googleOption = findGoogleOptionAction();
  const emailOption = findEmailOptionAction();
  debugLog('attemptProviderChoice', {
    source,
    route,
    emailInput: describeElement(emailInput),
    passwordInput: describeElement(passwordInput),
    googleOption: describeElement(googleOption),
    emailOption: describeElement(emailOption),
  });

  if (route === 'google') {
    setStatus(`Choosing Splice Google sign-in (${source})`);
    const brokerHref = findGoogleBrokerHref();
    if (brokerHref) {
      setStatus('Opening Google sign-in');
      debugLog('Navigating to Google broker href (provider-choice)', { href: brokerHref });
      window.location.assign(brokerHref);
      return true;
    }
    if (googleOption) {
      activateGoogleOption(googleOption, 'Google sign-in');
      scheduleAttempt(600);
      return true;
    }
    // Auth0 New Universal Login: submit the "Continue with Google" form.
    if (onAuthHost() && submitSpliceGoogleForm()) {
      scheduleAttempt(600);
      return true;
    }
    if (clickVisibleText(['sign in with google', 'continue with google', 'log in with google', 'login with google'], 'Google sign-in')) {
      scheduleAttempt(600);
      return true;
    }
    // The Google option lives behind the "Log in" button on the landing page.
    if (findHomeSignInAction() && attemptOpenSpliceLogin()) {
      return true;
    }
    setStatus('Splice Google sign-in option not found');
    return false;
  }

  if ((emailInput || passwordInput) && !emailOption && !googleOption) {
    setStatus(`Splice form already open (${source})\n${stateSnapshotText()}`);
    return false;
  }

  setStatus(`Choosing Splice email sign-in (${source})`);
    if (emailOption) {
      clickAction(emailOption, 'Use email');
      schedulePasswordSwitchAfterEmailChoice();
      scheduleAttempt(600);
      return true;
    }
    if (clickVisibleText(['use email', 'sign in with email', 'continue with email'], 'Use email')) {
      schedulePasswordSwitchAfterEmailChoice();
      scheduleAttempt(600);
      return true;
    }
  setStatus('Splice email sign-in option not found');
  return false;
}

function attemptSwitchToPassword(emailInput) {
  const usePasswordAction = findUsePasswordInsteadAction();
  if (!usePasswordAction) {
    if (canActNow() && clickVisibleText(['use password', 'use password instead', 'sign in with password', 'log in with password'], 'Use password')) {
      markActionTaken();
      setStatus('Switching Splice to password login');
      requestPasswordSavingSuppression();
      scheduleAttempt(600);
      return true;
    }
    return false;
  }

  if (!STATE.credential?.loginIdentifier) {
    requestCredential();
    setStatus('Waiting for Splice email credential');
    return true;
  }

  if (emailInput && emailInput.value !== STATE.credential.loginIdentifier) {
    emailInput.focus();
    setInputValue(emailInput, STATE.credential.loginIdentifier);
  }

  if (canActNow()) {
    markActionTaken();
    setStatus('Switching Splice to password login');
    requestPasswordSavingSuppression();
    clickAction(usePasswordAction, 'Use password');
    scheduleAttempt(600);
  } else {
    debugLog('Password option found, waiting for action throttle');
    scheduleAttempt(nextActionDelay());
  }

  return true;
}

function stopAutomation(message, hideBadgeAfterMs = 2500) {
  STATE.settled = true;
  if (STATE.scheduledTimer) {
    window.clearTimeout(STATE.scheduledTimer);
    STATE.scheduledTimer = null;
  }
  if (STATE.keepAliveTimer) {
    window.clearInterval(STATE.keepAliveTimer);
    STATE.keepAliveTimer = null;
  }
  if (STATE.observer) {
    STATE.observer.disconnect();
    STATE.observer = null;
  }

  setStatus(message);
  releasePasswordSavingSuppressed(PASSWORD_PROMPT_RESTORE_DELAY_MS);

  if (hideBadgeAfterMs > 0) {
    window.setTimeout(() => {
      const badge = document.getElementById('rmw-splice-autologin-status');
      if (badge) {
        badge.remove();
      }
    }, hideBadgeAfterMs);
  }
}

function attemptFill() {
  debugLog('attemptFill START', {
    settled: STATE.settled,
    launchChecked: STATE.launchChecked,
    launchAuthorized: STATE.launchAuthorized,
    launchPrepared: STATE.launchPrepared,
    launchExpiresAt: STATE.launchExpiresAt,
    credentialLoaded: Boolean(STATE.credential),
    hasLoginIdentifier: Boolean(STATE.credential?.loginIdentifier),
    hasPassword: Boolean(STATE.credential?.password),
  });

  if (STATE.settled) {
    debugLog('attemptFill EXIT settled');
    return;
  }
  if (document.readyState !== 'complete') {
    debugLog('attemptFill EXIT page not ready');
    setStatus('Waiting for Splice page to finish loading');
    scheduleAttempt(300);
    return;
  }
  if (!STATE.launchChecked) {
    debugLog('attemptFill EXIT launch not checked');
    setStatus('Checking dashboard launch');
    return;
  }
  if (!STATE.launchAuthorized) {
    debugLog('attemptFill EXIT launch unauthorized', {
      launchChecked: STATE.launchChecked,
      launchAuthorized: STATE.launchAuthorized,
    });
    scheduleAsyncStep(enforceDashboardOnlyAccess);
    return;
  }
  if (STATE.launchExpiresAt && !STATE.launchPrepared) {
    debugLog('attemptFill EXIT launch needs prep', {
      launchExpiresAt: STATE.launchExpiresAt,
      launchPrepared: STATE.launchPrepared,
    });
    scheduleAsyncStep(ensureFreshLaunchSession);
    return;
  }

  if (looksLikeAuthenticatedWorkspace()) {
    debugLog('attemptFill EXIT looks authenticated');
    stopAutomation('Signed in successfully');
    return;
  }

  // On Splice's Keycloak login page the "Continue with Google" button is
  // a standard broker anchor. For a Google credential we navigate straight to it;
  // the actual Google credential is applied later on accounts.google.com by
  // content-google.js. Give the credential one brief chance to load (so an
  // email-method credential is still respected) but never let a failing
  // login-host fetch block the Google hand-off.
  if (onAuthHost()) {
    const credentialMethod = normalizeLoginMethod(STATE.credential?.loginMethod);
    const isEmailCredential = STATE.credential && credentialMethod !== 'google';
    if (!isEmailCredential) {
      if (!STATE.credential && STATE.brokerNavAttempts == null) {
        STATE.brokerNavAttempts = 1;
        requestCredential();
        setStatus('Preparing Splice Google sign-in');
        scheduleAttempt(700);
        return;
      }
      const brokerHref = findGoogleBrokerHref();
      debugLog('auth-host broker check', { brokerHref, credentialMethod, attempts: STATE.brokerNavAttempts });
      if (brokerHref) {
        setStatus('Opening Google sign-in');
        window.location.assign(brokerHref);
        STATE.settled = true;
        return;
      }
      // Auth0 New Universal Login: no anchor, submit the Google form instead.
      if (submitSpliceGoogleForm()) {
        STATE.settled = true;
        return;
      }
    }
  }

  const emailInput = findEmailInput();
  const passwordInput = findPasswordInput();
  const emailOption = findEmailOptionAction();
  const passwordOption = findUsePasswordInsteadAction();
  debugLog('attemptFill DOM snapshot', {
    emailInput: describeElement(emailInput),
    passwordInput: describeElement(passwordInput),
    emailOption: describeElement(emailOption),
    passwordOption: describeElement(passwordOption),
  });

  if (!STATE.credential?.loginIdentifier || (!STATE.credential?.password && !shouldUseGoogleProvider())) {
    debugLog('attemptFill credential incomplete');
    // Only fetch the credential once we are actually on the dedicated login
    // page (auth.splice.com) or a real login form/option is present.
    // Requesting it on the marketing landing page would burn the "direct
    // credential issued" flag and trip the continuation gate on the auth host.
    if (emailInput || passwordInput || emailOption || passwordOption || onAuthHost()) {
      requestCredential();
    }
    if (attemptOpenSpliceLogin()) {
      return;
    }
    if (!emailInput && !passwordInput && canActNow() && clickVisibleText(['use email', 'sign in with email', 'continue with email'], 'Use email')) {
      markActionTaken();
      STATE.loginOpenAttempts += 1;
      setStatus('Opening Splice email sign-in');
      scheduleAttempt(600);
      return;
    }
    return;
  }

  if (shouldUseGoogleProvider()) {
    if (attemptProviderChoice('attempt-fill') || attemptOpenSpliceLogin()) {
      return;
    }
    setStatus('Waiting for Splice Google sign-in option');
    return;
  }

  if (!emailInput && !passwordInput && attemptProviderChoice('attempt-fill')) {
    return;
  }

  if (!passwordInput && emailOption) {
    debugLog('attemptFill opening email option');
    attemptOpenSpliceLogin();
    return;
  }

  if (!emailInput && !passwordInput && canActNow() && clickVisibleText(['use email', 'sign in with email', 'continue with email'], 'Use email')) {
    markActionTaken();
    STATE.loginOpenAttempts += 1;
    setStatus('Opening Splice email sign-in');
    scheduleAttempt(600);
    return;
  }

  if (!passwordInput && attemptSwitchToPassword(emailInput)) {
    return;
  }

  if (emailInput && !passwordInput) {
    requestPasswordSavingSuppression();
    setStatus('Waiting for Splice password login');
    return;
  }

  if (!emailInput && !passwordInput) {
    attemptOpenSpliceLogin();
    setStatus('Waiting for Splice login field');
    return;
  }

  if (emailInput && emailInput.value !== STATE.credential.loginIdentifier) {
    emailInput.focus();
    setInputValue(emailInput, STATE.credential.loginIdentifier);
  }

  if (passwordInput) {
    if (!STATE.passwordSavingSuppressed) {
      requestPasswordSavingSuppression();
      return;
    }
    if (passwordInput.value !== STATE.credential.password) {
      passwordInput.focus();
      setInputValue(passwordInput, STATE.credential.password);
    }
  }

  const readyForSubmit = (!emailInput || emailInput.value) && (!passwordInput || passwordInput.value);
  if (!readyForSubmit) {
    setStatus('Waiting for credential fields');
    return;
  }

  const submitButton = findSubmitButton(emailInput, passwordInput);
  if (!submitButton) {
    setStatus(passwordInput ? 'Credential filled, log in button not found' : 'Email filled, waiting for password login option');
    return;
  }

  const now = Date.now();
  if (now - STATE.lastSubmitAt > 3000) {
    STATE.lastSubmitAt = now;
    setStatus(passwordInput ? 'Credential filled, logging in' : 'Email filled, continuing');
    window.setTimeout(() => safeClick(submitButton), 300);
    return;
  }

  setStatus(passwordInput ? 'Credential filled' : 'Email filled');
}

function scheduleAsyncStep(task) {
  if (STATE.settled) {
    debugLog('scheduleAsyncStep SKIP settled');
    return;
  }
  debugLog('scheduleAsyncStep START', {
    task: task?.name || 'anonymous',
  });
  STATE.settled = true;
  Promise.resolve()
    .then(task)
    .then((result) => {
      debugLog('scheduleAsyncStep DONE', {
        task: task?.name || 'anonymous',
        result,
      });
      if (result !== false) {
        STATE.settled = false;
        forceScheduleAttempt(150);
      }
    })
    .catch((error) => {
      setStatus(`Session check failed: ${error?.message || 'Unknown error'}`);
      releasePasswordSavingSuppressed(0);
    });
}

function runAttempt() {
  debugLog('runAttempt START', {
    settled: STATE.settled,
    lastRunAt: STATE.lastRunAt,
  });
  STATE.scheduledTimer = null;

  const now = Date.now();
  if (now - STATE.lastRunAt < MIN_RUN_GAP_MS) {
    debugLog('runAttempt THROTTLED', {
      remainingMs: MIN_RUN_GAP_MS - (now - STATE.lastRunAt),
    });
    scheduleAttempt(MIN_RUN_GAP_MS - (now - STATE.lastRunAt));
    return;
  }

  STATE.lastRunAt = now;

  try {
    attemptFill();
  } catch (error) {
    STATE.settled = true;
    setStatus(`Script error: ${error?.message || 'Unknown error'}`);
    releasePasswordSavingSuppressed(0);
  }
}

function scheduleAttempt(delay = 0) {
  if (STATE.settled) {
    debugLog('scheduleAttempt SKIP settled', { delay });
    setStatus(`Splice scheduler skipped: settled\n${stateSnapshotText()}`);
    return;
  }
  if (STATE.scheduledTimer) {
    debugLog('scheduleAttempt SKIP existing timer', { delay });
    return;
  }
  debugLog('scheduleAttempt SET', { delay });
  STATE.scheduledTimer = window.setTimeout(runAttempt, Math.max(0, delay));
}

function forceScheduleAttempt(delay = 0) {
  if (STATE.settled) {
    debugLog('forceScheduleAttempt SKIP settled', { delay });
    setStatus(`Splice force scheduler skipped: settled\n${stateSnapshotText()}`);
    return;
  }
  if (STATE.scheduledTimer) {
    window.clearTimeout(STATE.scheduledTimer);
    STATE.scheduledTimer = null;
  }
  STATE.lastRunAt = 0;
  debugLog('forceScheduleAttempt SET', { delay });
  STATE.scheduledTimer = window.setTimeout(runAttempt, Math.max(0, delay));
}

function handleMutations() {
  if (STATE.settled) return;

  const now = Date.now();
  if (now - STATE.lastMutationHandledAt < 400) return;

  STATE.lastMutationHandledAt = now;
  scheduleAttempt(150);
}

function start() {
  exposeDebugState();
  ensureStatusBadge();
  captureLaunchTicketFromHash();
  STATE.observer = new MutationObserver(() => handleMutations());
  STATE.observer.observe(document.body || document.documentElement, { childList: true, subtree: true });
  STATE.keepAliveTimer = window.setInterval(() => scheduleAttempt(0), KEEP_ALIVE_MS);
  loadLaunchState()
    .catch(() => {
      STATE.launchChecked = true;
      STATE.launchAuthorized = false;
      STATE.launchExpiresAt = 0;
    })
    .finally(() => {
      STATE.settled = false;
      scheduleAttempt(0);
    });
}

// Grab the launch ticket from the URL immediately so a later navigation cannot
// drop it, but defer all DOM work (badge, clicks) until React has hydrated.
captureLaunchTicketFromHash();

function boot() {
  const begin = () => window.setTimeout(start, PAGE_SETTLE_AFTER_LOAD_MS);
  if (document.readyState === 'complete') {
    begin();
    return;
  }
  window.addEventListener('load', begin, { once: true });
}

boot();
