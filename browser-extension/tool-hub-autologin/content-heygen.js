const TOOL_SLUG = 'heygen';
const LOGIN_URL = 'https://www.heygen.com/';
const AUTH_URL = 'https://auth.heygen.com/';
const BLOCKED_NOTICE_KEY = 'rmw_heygen_blocked_notice';
const EXTENSION_TICKET_KEY = 'rmw_extension_ticket';
const SCRIPT_VERSION = 'debug-2026-06-04-11';

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
  status: 'Waiting for HeyGen login form',
};

const MIN_RUN_GAP_MS = 900;
const KEEP_ALIVE_MS = 4000;
const ACTION_THROTTLE_MS = 1200;
const PASSWORD_PROMPT_RESTORE_DELAY_MS = 8000;

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
  const existing = document.getElementById('rmw-heygen-autologin-status');
  if (existing) return existing;

  const badge = document.createElement('div');
  badge.id = 'rmw-heygen-autologin-status';
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
  badge.textContent = `HeyGen auto-login ${SCRIPT_VERSION}\n${STATE.status || 'Starting auto-login'}`;
  (document.body || document.documentElement).appendChild(badge);
  return badge;
}

function setStatus(message) {
  if (STATE.status === message) return;
  STATE.status = message;
  const badge = ensureStatusBadge();
  if (badge) {
    badge.textContent = `HeyGen auto-login ${SCRIPT_VERSION}\n${message}`;
  }
  console.debug('[RMW HeyGen Auto Login]', message);
}

function debugLog(label, data = {}) {
  console.log(`[RMW HeyGen Auto Login] ${label}`, data);
}

function exposeDebugState() {
  try {
    window.__RMW_STATE = STATE;
    window.__RMW_HEYGEN_DEBUG = {
      state: STATE,
      attemptFill,
      attemptOpenHeyGenLogin,
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
  console.log(`[RMW HeyGen Auto Login] ${label} diagnostic result`, result);
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
  console.log('[RMW HeyGen Auto Login] clicking action', label, describeElement(element));
  delays.forEach((delay) => {
    window.setTimeout(() => {
      if (!isVisible(element) || isDisabled(element)) return;
      console.log('[RMW HeyGen Auto Login] click attempt', label, delay);
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

function findHomeSignInAction() {
  return findActionByText({
    exact: ['sign in'],
    partial: ['sign in'],
    exclude: ['google', 'apple', 'sso', 'email'],
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

function onAuthHost() {
  return window.location.hostname === 'auth.heygen.com';
}

function onHeyGenHost() {
  return window.location.hostname === 'heygen.com'
    || window.location.hostname.endsWith('.heygen.com');
}

function isLandingPage() {
  const host = window.location.hostname;
  return host === 'heygen.com' || host === 'www.heygen.com';
}

function isLoginPage() {
  return onAuthHost()
    || Boolean(findEmailInput())
    || Boolean(findPasswordInput())
    || Boolean(findEmailOptionAction())
    || Boolean(findUsePasswordInsteadAction())
    || (isLandingPage() && Boolean(findHomeSignInAction()));
}

function looksLikeAuthenticatedWorkspace() {
  if (!onHeyGenHost()) return false;
  if (onAuthHost()) return false;
  if (findEmailInput() || findPasswordInput() || findEmailOptionAction() || findUsePasswordInsteadAction()) {
    return false;
  }
  if (isLandingPage() && findHomeSignInAction()) {
    return false;
  }

  if (window.location.hostname === 'app.heygen.com') {
    return true;
  }

  const workspaceWords = ['avatars', 'video', 'videos', 'template', 'templates', 'workspace', 'dashboard', 'create'];
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

  await clearToolSession({ preserveLaunch: true });
  const preparedResponse = await sendRuntimeMessage({
    type: 'TOOL_HUB_MARK_FRESH_SESSION_PREPARED',
    toolSlug: TOOL_SLUG,
  });
  if (preparedResponse?.ok) {
    STATE.launchPrepared = true;
  }
  window.sessionStorage.removeItem(BLOCKED_NOTICE_KEY);
  setStatus('Preparing fresh HeyGen session');

  if (!onAuthHost()) {
    window.location.replace(AUTH_URL);
    return false;
  }

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
          setStatus(`HeyGen direct run error: ${error?.message || 'Unknown error'}`);
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
      setStatus(`Opening HeyGen password sign-in (attempt ${attempt})`);
      if (attemptSwitchToPassword(emailInput)) return;
    }

    if (attempt < 8) {
      schedulePasswordSwitchAfterEmailChoice(attempt + 1);
    } else {
      setStatus('HeyGen password option not found after email choice');
      forceScheduleAttempt(200);
    }
  }, attempt === 1 ? 500 : 750);
}

function attemptOpenHeyGenLogin() {
  debugLog('attemptOpenHeyGenLogin CALLED', {
    canActNow: canActNow(),
    loginOpenAttempts: STATE.loginOpenAttempts,
  });

  const emailInput = findEmailInput();
  const passwordInput = findPasswordInput();
  debugLog('attemptOpenHeyGenLogin fields', {
    emailInput: describeElement(emailInput),
    passwordInput: describeElement(passwordInput),
  });
  if (emailInput || passwordInput) {
    debugLog('attemptOpenHeyGenLogin EXIT existing fields');
    return false;
  }

  if (shouldUseGoogleProvider()) {
    const googleOption = findGoogleOptionAction();
    debugLog('googleOption=', describeElement(googleOption));
    if (googleOption) {
      if (canActNow()) {
        markActionTaken();
        STATE.loginOpenAttempts += 1;
        setStatus('Opening HeyGen Google sign-in');
        clickAction(googleOption, 'Google sign-in');
        scheduleAttempt(1200);
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
      setStatus('Opening HeyGen email sign-in');
      clickAction(emailOption, 'Use email');
      scheduleAttempt(1200);
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
      setStatus('Opening HeyGen sign-in');
      clickAction(homeSignIn, 'Sign in');
      scheduleAttempt(1200);
    } else {
      debugLog('Sign-in option found, waiting for action throttle');
      scheduleAttempt(nextActionDelay());
    }
    return true;
  }

  if (!onAuthHost() && !isLandingPage() && canActNow()) {
    markActionTaken();
    STATE.loginOpenAttempts += 1;
    setStatus('Redirecting to HeyGen sign-in');
    window.location.replace(LOGIN_URL);
    return true;
  }

  if (isLandingPage() && canActNow()) {
    markActionTaken();
    STATE.loginOpenAttempts += 1;
    setStatus('Redirecting to HeyGen sign-in');
    window.location.replace(AUTH_URL);
    return true;
  }

  return false;
}

function attemptProviderChoice(source = 'provider-choice') {
  const route = credentialLoginRoute();
  setStatus(`Inspecting HeyGen ${route} sign-in (${source})\n${stateSnapshotText()}`);

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
    setStatus(`Choosing HeyGen Google sign-in (${source})`);
    if (googleOption) {
      clickAction(googleOption, 'Google sign-in');
      scheduleAttempt(1200);
      return true;
    }
    if (clickVisibleText(['sign in with google', 'continue with google', 'log in with google', 'login with google'], 'Google sign-in')) {
      scheduleAttempt(1200);
      return true;
    }
    setStatus('HeyGen Google sign-in option not found');
    return false;
  }

  if ((emailInput || passwordInput) && !emailOption && !googleOption) {
    setStatus(`HeyGen form already open (${source})\n${stateSnapshotText()}`);
    return false;
  }

  setStatus(`Choosing HeyGen email sign-in (${source})`);
    if (emailOption) {
      clickAction(emailOption, 'Use email');
      schedulePasswordSwitchAfterEmailChoice();
      scheduleAttempt(1200);
      return true;
    }
    if (clickVisibleText(['use email', 'sign in with email', 'continue with email'], 'Use email')) {
      schedulePasswordSwitchAfterEmailChoice();
      scheduleAttempt(1200);
      return true;
    }
  setStatus('HeyGen email sign-in option not found');
  return false;
}

function attemptSwitchToPassword(emailInput) {
  const usePasswordAction = findUsePasswordInsteadAction();
  if (!usePasswordAction) {
    if (canActNow() && clickVisibleText(['use password', 'use password instead', 'sign in with password', 'log in with password'], 'Use password')) {
      markActionTaken();
      setStatus('Switching HeyGen to password login');
      requestPasswordSavingSuppression();
      scheduleAttempt(1200);
      return true;
    }
    return false;
  }

  if (!STATE.credential?.loginIdentifier) {
    requestCredential();
    setStatus('Waiting for HeyGen email credential');
    return true;
  }

  if (emailInput && emailInput.value !== STATE.credential.loginIdentifier) {
    emailInput.focus();
    setInputValue(emailInput, STATE.credential.loginIdentifier);
  }

  if (canActNow()) {
    markActionTaken();
    setStatus('Switching HeyGen to password login');
    requestPasswordSavingSuppression();
    clickAction(usePasswordAction, 'Use password');
    scheduleAttempt(1200);
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
      const badge = document.getElementById('rmw-heygen-autologin-status');
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
    if (emailInput || passwordInput || emailOption || passwordOption || onAuthHost()) {
      requestCredential();
    }
    if (attemptOpenHeyGenLogin()) {
      return;
    }
    if (!emailInput && !passwordInput && canActNow() && clickVisibleText(['use email', 'sign in with email', 'continue with email'], 'Use email')) {
      markActionTaken();
      STATE.loginOpenAttempts += 1;
      setStatus('Opening HeyGen email sign-in');
      scheduleAttempt(1200);
      return;
    }
    return;
  }

  if (shouldUseGoogleProvider()) {
    if (attemptProviderChoice('attempt-fill') || attemptOpenHeyGenLogin()) {
      return;
    }
    setStatus('Waiting for HeyGen Google sign-in option');
    return;
  }

  if (!emailInput && !passwordInput && attemptProviderChoice('attempt-fill')) {
    return;
  }

  if (!passwordInput && emailOption) {
    debugLog('attemptFill opening email option');
    attemptOpenHeyGenLogin();
    return;
  }

  if (!emailInput && !passwordInput && canActNow() && clickVisibleText(['use email', 'sign in with email', 'continue with email'], 'Use email')) {
    markActionTaken();
    STATE.loginOpenAttempts += 1;
    setStatus('Opening HeyGen email sign-in');
    scheduleAttempt(1200);
    return;
  }

  if (!passwordInput && attemptSwitchToPassword(emailInput)) {
    return;
  }

  if (emailInput && !passwordInput) {
    requestPasswordSavingSuppression();
    setStatus('Waiting for HeyGen password login');
    return;
  }

  if (!emailInput && !passwordInput) {
    attemptOpenHeyGenLogin();
    setStatus('Waiting for HeyGen login field');
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
    setStatus(`HeyGen scheduler skipped: settled\n${stateSnapshotText()}`);
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
    setStatus(`HeyGen force scheduler skipped: settled\n${stateSnapshotText()}`);
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
  if (now - STATE.lastMutationHandledAt < 1200) return;

  STATE.lastMutationHandledAt = now;
  scheduleAttempt(200);
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

start();

// ============================================================================
// Generation capture (HeyGen Generation Capture System - see the
// implementation plan). Deliberately independent of the autologin STATE
// machine above - neither this section nor content-heygen-network.js touches
// STATE or any of the DOM-automation helpers, so a bug here cannot regress
// the login flow and vice versa. Reuses ACTION_SELECTORS/isVisible/
// isDisabled/sendRuntimeMessage/TOOL_SLUG already defined above rather than
// duplicating them.
//
// Two independent pieces, both isolated-world:
//
// 1. Generate/Render Scene click detection, DOM-scraping, and the arm/disarm
//    live-capture state machine - ports content-freepik.js's
//    activeGeneration design (armed by a real click, not inferred from data
//    shape) verbatim in spirit. HeyGen has TWO distinct capture-worthy
//    actions per the reference screenshot - a top-level "Generate" button
//    (whole video, potentially multiple scenes) and a per-scene
//    "Render Scene" button - both real credit-consuming generations, both
//    captured as their own event per the product decision recorded in the
//    implementation plan.
//
// 2. A relay for content-heygen-network.js's (MAIN world) intercepted
//    generation-shaped responses.
//
// NOT included in this pass: a reconciliation/history-page walker like
// Freepik's (content-freepik.js's runFreepikReconciliationWalk). No HeyGen
// history/project-listing endpoint shape has been confirmed against real
// traffic - see providers/heygen/sync.py's module docstring. This degrades
// gracefully: live capture (this file) and network-shape capture
// (content-heygen-network.js) still work independently of it; only recovery
// of generations missed by both is deferred until that endpoint is known.
// ============================================================================

function collectUniqueElements(elements) {
  return Array.from(new Set(elements.filter(Boolean)));
}

// ---- On-page live-capture status badge (separate from the autologin status
// badge above - this one reflects generation-capture progress, not login) ----

let heygenCaptureStatusHideTimer = null;

function ensureHeygenCaptureStatusBadge() {
  const existing = document.getElementById('rmw-heygen-capture-status');
  if (existing) return existing;
  const badge = document.createElement('div');
  badge.id = 'rmw-heygen-capture-status';
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

function setHeygenCaptureStatus(message, { autoHideMs } = {}) {
  const badge = ensureHeygenCaptureStatusBadge();
  badge.textContent = `HeyGen capture\n${message}`;
  badge.style.display = 'block';
  if (heygenCaptureStatusHideTimer) {
    window.clearTimeout(heygenCaptureStatusHideTimer);
    heygenCaptureStatusHideTimer = null;
  }
  if (autoHideMs) {
    heygenCaptureStatusHideTimer = window.setTimeout(() => { badge.style.display = 'none'; }, autoHideMs);
  }
}

function hideHeygenCaptureStatus() {
  const badge = document.getElementById('rmw-heygen-capture-status');
  if (badge) badge.style.display = 'none';
}

// ---- DOM scraping helpers ----
//
// No confirmed HeyGen DOM structure was available while building this (only
// the create-video screenshot referenced in the implementation plan) - every
// reader below is a best-effort heuristic with several fallback selectors,
// not a precise, confirmed mapping. Tighten these once the extension has run
// against the real page.

function heygenElementText(element) {
  if (!element) return '';
  return `${element.innerText || element.textContent || ''}`.trim();
}

// Finds a heading/label-like element whose own (direct, non-descendant) text
// matches labelRe, then reads a nearby value from either a sibling element or
// a descendant of the label's parent container - the common shape for a
// "Label \n Value" panel row (matches the Avatar/Voice/Motion Engine panel
// rows in the reference screenshot).
function readHeygenLabeledValue(labelRe, { withinSelector, maxDepth = 4 } = {}) {
  const scope = withinSelector ? document.querySelector(withinSelector) : document;
  if (!scope) return '';
  const candidates = Array.from(scope.querySelectorAll('label, h1, h2, h3, h4, p, span, div'));
  for (const label of candidates) {
    const ownText = Array.from(label.childNodes)
      .filter((node) => node.nodeType === Node.TEXT_NODE)
      .map((node) => node.textContent)
      .join(' ')
      .trim();
    const text = ownText || heygenElementText(label);
    if (!text || text.length > 60 || !labelRe.test(text)) continue;

    // Try the next sibling first (common "label row" / "value row" pattern).
    let sibling = label.nextElementSibling;
    if (sibling) {
      const siblingText = heygenElementText(sibling);
      if (siblingText && siblingText.length < 200) return siblingText;
    }
    // Fall back to the label's own container, minus the label text itself.
    let container = label.parentElement;
    let depth = 0;
    while (container && depth < maxDepth) {
      const containerText = heygenElementText(container);
      if (containerText && containerText.length < 200) {
        const withoutLabel = containerText.replace(text, '').trim();
        if (withoutLabel) return withoutLabel;
      }
      container = container.parentElement;
      depth += 1;
    }
  }
  return '';
}

function readHeygenScriptText() {
  // The Script panel (left sidebar in the reference screenshot) is either a
  // contenteditable region or a textarea - try both, preferring one whose
  // nearby label/heading actually says "Script" over a blind first-match.
  const labeled = Array.from(document.querySelectorAll('h1, h2, h3, h4, [class*="header" i], [class*="title" i]'))
    .find((el) => /^script$/i.test(heygenElementText(el)));
  if (labeled) {
    const container = labeled.closest('[class*="script" i]') || labeled.parentElement;
    const field = container?.querySelector('[contenteditable="true"], textarea');
    const text = heygenElementText(field);
    if (text) return text;
  }
  // Broad fallback: any contenteditable/textarea that looks like a script
  // input rather than a search box or comment field.
  const fallback = Array.from(document.querySelectorAll('[contenteditable="true"], textarea'))
    .find((el) => isVisible(el) && !/search|comment/i.test(el.getAttribute('placeholder') || el.getAttribute('aria-label') || ''));
  return heygenElementText(fallback);
}

function readHeygenAvatarInfo() {
  const panel = document.querySelector('[class*="avatar" i][class*="voice" i]') || document;
  const name = readHeygenLabeledValue(/^avatar$/i, { withinSelector: undefined })
    || heygenElementText(panel.querySelector?.('[class*="avatar" i] img[alt]'))
    || panel.querySelector?.('[class*="avatar" i] img[alt]')?.getAttribute('alt')
    || '';
  return { name: name || null, id: null, version: null, type: null };
}

function readHeygenVoiceInfo() {
  const raw = readHeygenLabeledValue(/^voice$/i);
  if (!raw) return { name: null, id: null, language: null, gender: null, style: null };
  // Reference screenshot shape: "Lively Liam - Serious" (voice name, then a
  // " - " separated style/emotion tag with a trailing emoji sometimes).
  const [namePart, ...styleParts] = raw.split(/\s+-\s+/);
  const style = styleParts.join(' - ').replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, '').trim();
  return { name: namePart?.trim() || raw, id: null, language: null, gender: null, style: style || null };
}

function readHeygenMotionEngine() {
  return readHeygenLabeledValue(/^motion engine$/i) || null;
}

function readHeygenLayout() {
  return readHeygenLabeledValue(/^layout$/i) || null;
}

function readHeygenBackgroundType() {
  return readHeygenLabeledValue(/^avatar background$/i) || null;
}

// Expected-credit chip shown directly on/near the clicked button (the "1"
// badge next to "Render Scene" in the reference screenshot).
function readHeygenExpectedCredits(button) {
  if (!button) return null;
  const container = button.closest('[class*="scene" i], [class*="panel" i]') || button.parentElement;
  const scope = container || button;
  const chip = Array.from(scope.querySelectorAll('*')).find((el) => {
    const text = heygenElementText(el);
    return text && /^\d+(\.\d+)?$/.test(text) && el.childElementCount === 0;
  });
  const value = chip ? Number(heygenElementText(chip)) : NaN;
  return Number.isFinite(value) ? value : null;
}

function readHeygenSceneIndexLabel() {
  // "Avatar & Voice (Scene 1)" heading in the reference screenshot.
  const heading = Array.from(document.querySelectorAll('h1, h2, h3, h4'))
    .map((el) => heygenElementText(el))
    .find((text) => /scene\s*\d+/i.test(text));
  const match = heading && heading.match(/scene\s*(\d+)/i);
  return match ? match[1] : null;
}

// ---- Generate / Render Scene click detection ----
//
// Mirrors content-freepik.js's findFreepikGenerateActionTarget /
// findFreepikGenerateButtonAncestor exactly (see that file's own comment for
// why this walk only ever accepts a real button/link/role=button ancestor,
// never a form field, never a fallback to the raw clicked node) - broadened
// to match BOTH of HeyGen's action button labels instead of Freepik/Kling's
// bare "generate".

const HEYGEN_GATE_EXCLUDED_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT', 'OPTION']);
const HEYGEN_ACTION_TEXT_RE = /(^|\s)(generate|render\s*scene|render)($|\s)/i;

function findHeygenActionButtonAncestor(element) {
  let current = element;
  while (current && current !== document.body) {
    if (
      !HEYGEN_GATE_EXCLUDED_TAGS.has(current.tagName)
      && current.matches?.(ACTION_SELECTORS.join(','))
      && isVisible(current)
      && !isDisabled(current)
    ) {
      return current;
    }
    current = current.parentElement;
  }
  return null;
}

function collectHeygenInteractionCandidateElements(target) {
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
  return collectUniqueElements([...pathElements, ...fallback]);
}

function heygenButtonDescriptorText(element) {
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

// Diagnostic only - never changes what qualifies as an action click. Live
// data (2026-08-20) showed this regex/click-gate almost never firing for
// avatar_type="photar" (Photo Avatar) generations specifically: only ~4.5%
// of captured HeyGen events over a real sample were live click/network
// events, the rest all reconciliation (passive listing/credit-ledger scans),
// and nearly every recent generation was avatar_type="photar" - consistent
// with that surface's real submit button using label text this regex
// (built against the standard multi-scene Avatar Video Creator's "Generate"/
// "Render Scene" buttons) doesn't recognize. Rather than guess a new label
// blind - this codebase has already paid for that mistake more than once
// (Suno's event_type mismatch, HeyGen's own "workflow_id" identity
// mismapping, ChatGPT's SSE format) - log the descriptor text of any
// clicked, button-shaped, plausibly-submit-ish element that this regex
// rejects, so the next real Photo Avatar submission confirms the actual
// label instead of another guess.
const HEYGEN_UNRECOGNIZED_ACTION_HINT_RE = /(creat|generat|submit|animat|continue|next|render|save|publish)/i;
let heygenLastUnrecognizedActionLoggedAt = 0;

function maybeLogUnrecognizedHeygenActionClick(candidates) {
  const now = Date.now();
  if (now - heygenLastUnrecognizedActionLoggedAt < 2000) return; // throttle - one page can have many buttons
  for (const candidate of candidates) {
    if (!candidate) continue;
    const text = heygenButtonDescriptorText(candidate);
    if (!text || text.length > 60) continue;
    if (!HEYGEN_UNRECOGNIZED_ACTION_HINT_RE.test(text)) continue;
    heygenLastUnrecognizedActionLoggedAt = now;
    console.debug('[RMW HeyGen Capture] clicked a submit-shaped button not recognized by HEYGEN_ACTION_TEXT_RE', {
      text, href: location.href, tag: candidate.tagName, testId: candidate.getAttribute?.('data-testid') || null,
    });
    return;
  }
}

// Returns { target, kind } where kind is 'scene_render' for a "Render Scene"
// (or bare "Render") button, 'generate' otherwise - the top-level "Generate"
// button in the reference screenshot renders the whole (potentially
// multi-scene) video.
function findHeygenActionTarget(target) {
  const candidates = collectUniqueElements(
    collectHeygenInteractionCandidateElements(target).map((element) => findHeygenActionButtonAncestor(element))
  );
  for (const candidate of candidates) {
    if (!candidate) continue;
    const text = heygenButtonDescriptorText(candidate);
    if (!text || text.length > 60) continue;
    if (!HEYGEN_ACTION_TEXT_RE.test(text)) continue;
    const kind = /render/i.test(text) ? 'scene_render' : 'generate';
    return { target: candidate, kind };
  }
  maybeLogUnrecognizedHeygenActionClick(candidates);
  return null;
}

// ---- Task/Client gate ----
//
// Mirrors content-freepik.js's runFreepikTaskGate exactly - block the real
// click, open the picker, re-dispatch a synthetic click flagged to bypass
// re-gating once a task/client is chosen.

let heygenTaskGateBypassTarget = null;
let heygenTaskGateModalOpen = false;
let heygenPendingTaskSelection = null; // {taskId, taskName, clientId, clientName} - consumed by armHeygenGeneration()
let heygenPendingActionKind = null; // 'generate' | 'scene_render' - the kind of the click currently being gated

async function runHeygenTaskGate(target) {
  if (heygenTaskGateModalOpen) return; // double-click while the modal is already open - no-op
  heygenTaskGateModalOpen = true;
  try {
    const selection = await openHeygenTaskSelectionModal();
    if (!selection) return; // cancelled/ESC/no active tasks - click stays blocked
    heygenPendingTaskSelection = selection;
    heygenTaskGateBypassTarget = target;
    target.click();
  } finally {
    heygenTaskGateModalOpen = false;
  }
}

document.addEventListener('click', (event) => {
  try {
    const match = findHeygenActionTarget(event.target);
    if (!match) return;
    const { target, kind } = match;

    if (heygenTaskGateBypassTarget === target) {
      heygenTaskGateBypassTarget = null; // one-shot: next action click gates again
      armHeygenGeneration(kind, target);
      return; // let the (re-dispatched) click reach HeyGen's own handler
    }

    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    heygenPendingActionKind = kind;
    runHeygenTaskGate(target);
  } catch {}
}, true); // capturing phase - fires even if the page's own handler stops propagation

// ---- Arm/disarm live-capture state machine ----
//
// Ports content-freepik.js's activeGeneration design (armed by a real click,
// validated by expiry, not inferred from data shape) - see that file's own
// comment block for the full rationale. capturedIdentities plays the same
// role as Freepik's capturedCreationIds.

const HEYGEN_ARM_MAX_DURATION_MS = 10 * 60 * 1000; // generous for slow multi-scene renders
const HEYGEN_ARM_QUIET_PERIOD_MS = 90 * 1000; // disarm 90s after the last qualifying signal
const HEYGEN_CLOCK_SKEW_SLACK_MS = 60 * 1000;

// { generateIntentId, kind, armedAt, expiresAt, capturedIdentities: Map, taskId, taskName, clientId, clientName, submitSnapshot }
let heygenActiveGeneration = null;
let heygenArmQuietTimer = null;
let heygenArmMaxTimer = null;

function clearHeygenArmTimers() {
  if (heygenArmQuietTimer) { window.clearTimeout(heygenArmQuietTimer); heygenArmQuietTimer = null; }
  if (heygenArmMaxTimer) { window.clearTimeout(heygenArmMaxTimer); heygenArmMaxTimer = null; }
}

function heygenGenerationLinkLabel(generation) {
  if (!generation) return '';
  const parts = [];
  if (generation.taskName) parts.push(`Task: ${generation.taskName}`);
  if (generation.clientName) parts.push(`Client: ${generation.clientName}`);
  return parts.length ? ` (${parts.join(', ')})` : '';
}

function disarmHeygenGeneration() {
  clearHeygenArmTimers();
  const hadCaptures = Boolean(heygenActiveGeneration && heygenActiveGeneration.capturedIdentities.size > 0);
  const linkLabel = heygenGenerationLinkLabel(heygenActiveGeneration);
  stopHeygenAssetDetection();
  heygenActiveGeneration = null;
  if (hadCaptures) {
    setHeygenCaptureStatus(`Capture complete ✓${linkLabel}`, { autoHideMs: 6000 });
  } else {
    hideHeygenCaptureStatus();
  }
}

function scheduleHeygenArmQuietReset() {
  if (heygenArmQuietTimer) window.clearTimeout(heygenArmQuietTimer);
  heygenArmQuietTimer = window.setTimeout(disarmHeygenGeneration, HEYGEN_ARM_QUIET_PERIOD_MS);
}

function isHeygenGenerationArmed() {
  return Boolean(heygenActiveGeneration) && Date.now() <= heygenActiveGeneration.expiresAt;
}

function buildHeygenSubmitSnapshot(button, kind) {
  const avatar = readHeygenAvatarInfo();
  const voice = readHeygenVoiceInfo();
  return {
    scriptText: readHeygenScriptText() || null,
    avatar,
    voice,
    scene: {
      count: null,
      ids: [],
      layout: readHeygenLayout(),
      backgroundType: readHeygenBackgroundType(),
      avatarPosition: null,
    },
    videoConfig: {
      resolution: null,
      aspectRatio: null,
      fps: null,
      duration: null,
      quality: null,
      motionEngine: readHeygenMotionEngine(),
    },
    credits: {
      before: null,
      after: null,
      used: null,
      // The chip captured here is the button's EXPECTED cost, not an actual
      // debit - stored under the same envelope key normalization.py reads
      // (credits.used) would be misleading, so it travels in metadata
      // instead and credits.* stays null until a real before/after balance
      // or network-observed debit is seen.
    },
    sceneIdLabel: readHeygenSceneIndexLabel(),
    expectedCredits: readHeygenExpectedCredits(button),
    kind,
    status: 'submitted',
  };
}

function armHeygenGeneration(kind, button) {
  const now = Date.now();
  const pendingSelection = heygenPendingTaskSelection;
  heygenPendingTaskSelection = null;
  heygenPendingActionKind = null;

  const submitSnapshot = buildHeygenSubmitSnapshot(button, kind);

  if (isHeygenGenerationArmed()) {
    // A second action click while still waiting on a prior one extends the
    // existing session rather than resetting capturedIdentities, so
    // in-flight tracking for the first render isn't lost - same reasoning as
    // content-freepik.js's armFreepikGeneration.
    if (pendingSelection) {
      heygenActiveGeneration.taskId = pendingSelection.taskId;
      heygenActiveGeneration.taskName = pendingSelection.taskName;
      heygenActiveGeneration.clientId = pendingSelection.clientId;
      heygenActiveGeneration.clientName = pendingSelection.clientName;
    }
    scheduleHeygenArmQuietReset();
    setHeygenCaptureStatus(`Waiting for generation…${heygenGenerationLinkLabel(heygenActiveGeneration)}`);
  } else {
    clearHeygenArmTimers();
    heygenActiveGeneration = {
      generateIntentId: `hgen_${now}_${Math.random().toString(36).slice(2, 8)}`,
      kind,
      armedAt: now,
      expiresAt: now + HEYGEN_ARM_MAX_DURATION_MS,
      capturedIdentities: new Map(),
      taskId: pendingSelection?.taskId ?? null,
      taskName: pendingSelection?.taskName ?? null,
      clientId: pendingSelection?.clientId ?? null,
      clientName: pendingSelection?.clientName ?? null,
      submitSnapshot,
    };
    heygenArmMaxTimer = window.setTimeout(disarmHeygenGeneration, HEYGEN_ARM_MAX_DURATION_MS);
    scheduleHeygenArmQuietReset();
    setHeygenCaptureStatus(`Waiting for generation…${heygenGenerationLinkLabel(heygenActiveGeneration)}`);
    console.debug('[RMW HeyGen Capture] armed', {
      generateIntentId: heygenActiveGeneration.generateIntentId, kind,
      taskId: heygenActiveGeneration.taskId, clientId: heygenActiveGeneration.clientId,
    });
  }

  // reportHeygenCaptureEvent's `identity` argument is only ever used to
  // compute the client-side dedupe key (clientEventId) and pick out
  // video_id/project_id as their own DB columns - render_id/job_id/
  // workflow_id/external_event_id are NEVER forwarded separately (see
  // ingest_capture_event's signature in providers/heygen/capture.py).
  // normalize_capture_event's _extract_fields reads external_event_id
  // exclusively out of payload_json, so unless the id is embedded directly
  // in the payload object itself, the backend can never see it - this was
  // the actual reason every submitted click was silently dropped by
  // normalize_capture_event's "no identity field present" skip-check
  // (external_event_id was always None). Mutating submitSnapshot in place
  // also means startHeygenAssetDetection's later completed-DOM-fallback
  // event (which spreads this same object) carries it too.
  submitSnapshot.externalEventId = heygenActiveGeneration.generateIntentId;

  // The "submitted" event is sent immediately, synchronously with the click -
  // per the spec's "never wait until generation finishes" rule - regardless
  // of whether this extended an existing arm or started a fresh one, so
  // every click the user actually made produces its own pending record.
  reportHeygenCaptureEvent({
    eventType: kind === 'scene_render' ? 'scene_render_click' : 'generate_click',
    isReconciliation: false,
    payload: submitSnapshot,
    identity: { externalEventId: heygenActiveGeneration.generateIntentId },
    changeToken: 'submitted',
  });

  startHeygenAssetDetection();
}

// ---- Reporting ----

function heygenChangeToken(payload) {
  return payload?.status || payload?.updatedAt || 'unknown';
}

async function reportHeygenCaptureEvent({ eventType, isReconciliation, payload, identity, changeToken }) {
  const videoId = identity?.videoId ? String(identity.videoId) : '';
  const renderId = identity?.renderId ? String(identity.renderId) : '';
  const jobId = identity?.jobId ? String(identity.jobId) : '';
  const workflowId = identity?.workflowId ? String(identity.workflowId) : '';
  const externalEventId = identity?.externalEventId ? String(identity.externalEventId) : '';
  const primaryId = videoId || renderId || jobId || workflowId || externalEventId || `rand:${Math.random().toString(36).slice(2)}`;
  // MUST change whenever the payload's actual content changes (a "submitted"
  // snapshot later becoming "completed" with real output) - see
  // content-freepik.js's reportFreepikGenerationRow for the "stuck with no
  // preview" bug this exact design prevents.
  const token = changeToken || heygenChangeToken(payload);
  const clientEventId = `heygen:${primaryId}:${token}`;

  try {
    const result = await sendRuntimeMessage({
      type: 'HEYGEN_CAPTURE_EVENT',
      event: {
        event_type: eventType,
        client_event_id: clientEventId,
        video_id: videoId || null,
        project_id: identity?.projectId ? String(identity.projectId) : null,
        is_reconciliation: Boolean(isReconciliation),
        payload,
        capture_version: 1,
        linked_task_id: !isReconciliation && heygenActiveGeneration ? heygenActiveGeneration.taskId : null,
        linked_client_id: !isReconciliation && heygenActiveGeneration ? heygenActiveGeneration.clientId : null,
      },
    });
    if (result?.ok) {
      console.debug('[RMW HeyGen Capture] reported event', { eventType, primaryId, queued: result.queued });
      // "Queued", not "Saved" - result.ok only confirms the local background
      // queue accepted it; the actual server upload happens later via the
      // batched flush (best-effort, see background-heygen-capture.js).
      setHeygenCaptureStatus('Queued for upload…');
    } else {
      console.warn('[RMW HeyGen Capture] failed to report event', { eventType, primaryId, error: result?.error });
      setHeygenCaptureStatus(`Capture failed: ${result?.error || 'unknown error'}`, { autoHideMs: 8000 });
    }
  } catch (error) {
    console.warn('[RMW HeyGen Capture] unexpected error reporting event', { eventType, error: error?.message || error });
  }
}

// ---- Network-relay: content-heygen-network.js's intercepted rows ----

function heygenRowIdentity(row) {
  return {
    // Corrected 2026-08-04: a bare "id" on HeyGen's render/queue-status
    // response is the video's own video_id, not a separate workflow_id -
    // confirmed by a side-by-side comparison where the same generation's
    // status-poll "id" and its eventual listing-endpoint "video_id" were the
    // identical string (the status payload separately has its own
    // "workflow_id" key, always observed null). Only falls back to it when
    // "videoId"/"video_id" aren't already present, so it never masks a more
    // specific id.
    videoId: row?.videoId ?? row?.video_id ?? row?.id ?? null,
    renderId: row?.renderId ?? row?.render_id ?? null,
    jobId: row?.jobId ?? row?.job_id ?? null,
    workflowId: row?.workflowId ?? row?.workflow_id ?? null,
    projectId: row?.projectId ?? row?.project_id ?? null,
  };
}

function isHeygenRowSettled(row) {
  const status = `${row?.status || ''}`.toLowerCase();
  if (['completed', 'failed', 'cancelled'].includes(status)) return true;
  const output = row?.output || {};
  return Boolean(row?.videoUrl || row?.video_url || output.videoUrl || output.video_url);
}

function onHeygenNetworkMessage(event) {
  if (event.source !== window) return;
  const data = event.data;
  if (!data || data.source !== 'rmw-heygen-network-telemetry' || data.type !== 'HEYGEN_NETWORK_GENERATION') return;
  const rows = data.payload && Array.isArray(data.payload.rows) ? data.payload.rows : [];
  const transport = (data.payload && data.payload.transport) || 'http';

  rows.forEach((row) => {
    const identity = heygenRowIdentity(row);
    const hasIdentity = identity.videoId || identity.renderId || identity.jobId || identity.workflowId;

    // Only a direct fetch/XHR response (issued by THIS tab) may originate a
    // brand-new identity claim - a push-channel sighting is left unattributed
    // rather than credited to whoever's tab happened to be armed, same
    // reasoning as content-freepik.js's evaluateFreepikRowForLiveCapture.
    if (!hasIdentity) return;
    const alreadyTracked = heygenActiveGeneration?.capturedIdentities.has(String(identity.videoId || identity.renderId || identity.jobId || identity.workflowId));
    if (!isHeygenGenerationArmed() && !alreadyTracked) {
      if (transport !== 'http') return;
      // Un-armed and never-before-seen: nothing currently claims this row.
      // No reconciliation walker exists yet in this pass (see this section's
      // top comment) so an un-armed sighting is simply not reported - it will
      // be picked up once the recovery/reconciliation follow-up lands.
      return;
    }
    if (transport !== 'http' && !alreadyTracked) return;

    const idKey = String(identity.videoId || identity.renderId || identity.jobId || identity.workflowId);
    const settled = isHeygenRowSettled(row);
    if (heygenActiveGeneration) {
      heygenActiveGeneration.capturedIdentities.set(idKey, { settled });
      scheduleHeygenArmQuietReset();
    }
    // Credit ledger rows key by action_id === video_id specifically (see
    // queueHeygenCreditLedgerLookup's own comment) - render/job/workflow ids
    // alone can't be looked up this way, only a real video_id.
    if (settled && identity.videoId) {
      queueHeygenCreditLedgerLookup(String(identity.videoId));
    }

    setHeygenCaptureStatus(settled ? 'Capturing…' : 'Generation detected — rendering…');
    // Same payload-embedding requirement as armHeygenGeneration's
    // submitSnapshot.externalEventId above - without this, this
    // network-observed row (which DOES carry a real video/render/job/
    // workflow id) creates a brand-new HeygenGeneration from scratch
    // instead of merging into the one the "submitted" click already
    // started, so the DOM-scraped script/avatar/voice data on that first
    // row is permanently orphaned.
    const networkPayload = heygenActiveGeneration
      ? { ...row, externalEventId: heygenActiveGeneration.generateIntentId }
      : row;
    reportHeygenCaptureEvent({
      eventType: 'network_snapshot',
      isReconciliation: false,
      payload: networkPayload,
      identity,
      changeToken: heygenChangeToken(row),
    });
  });
}

window.addEventListener('message', onHeygenNetworkMessage);

// ---- Reconciliation: content-heygen-network.js's passively-observed
// listing rows (api2.heygen.com/v1/project/items) ----
//
// Deliberately its own message type and its own handler, never merged into
// onHeygenNetworkMessage above - that function's whole design is "attribute
// to whichever generation is currently armed", which is exactly wrong for a
// listing response that can contain dozens of OLD, unrelated videos. Every
// row here is reported with isReconciliation: true unconditionally, which
// makes reportHeygenCaptureEvent send linked_task_id/linked_client_id as
// null regardless of arm state, and makes the backend's ownership-freshness
// gate (normalization.py's _is_fresh_enough_for_attribution, keyed off each
// row's own real created_ts) the only thing that can ever resolve ownership
// for these rows - never "whoever's tab happened to have it open".
//
// This is intentionally passive, not an active paginated crawl: HeyGen's
// pagination here uses an opaque `token` cursor (not a simple ?page=N like
// Freepik's), and no response sample has confirmed which field carries the
// "next page" token yet - so rather than guess and risk building a walker
// that silently stops after page 1 forever, this only captures whatever
// page(s) the user's own browsing already triggers. Promote to an active
// walk (mirroring content-freepik.js's runFreepikReconciliationWalk) once
// that field is confirmed.
function onHeygenNetworkListingMessage(event) {
  if (event.source !== window) return;
  const data = event.data;
  if (!data || data.source !== 'rmw-heygen-network-telemetry' || data.type !== 'HEYGEN_NETWORK_LISTING') return;
  const rows = data.payload && Array.isArray(data.payload.rows) ? data.payload.rows : [];

  rows.forEach((row) => {
    const identity = heygenRowIdentity(row);
    if (!(identity.videoId || identity.renderId || identity.jobId || identity.workflowId)) return;
    // Historical/reconciliation rows are exactly the case Sarbjeet reported
    // (2026-08-05): most generations are only ever discovered this way, not
    // through a live-armed click, and the user won't reliably visit HeyGen's
    // billing page on their own - so this is the main path that needs the
    // proactive lookup, not just the live-capture one above.
    if (isHeygenRowSettled(row) && identity.videoId) {
      queueHeygenCreditLedgerLookup(String(identity.videoId));
    }
    reportHeygenCaptureEvent({
      eventType: 'generation_listing_row',
      isReconciliation: true,
      payload: row,
      identity,
      changeToken: heygenChangeToken(row),
    });
  });
}

window.addEventListener('message', onHeygenNetworkListingMessage);

// ---- Reconciliation: content-heygen-network.js's passively-observed credit
// ledger rows (movio_bill.list) ----
//
// A completely different HeyGen endpoint from the video listing above, and
// deliberately reported as its own thin, minimal payload rather than merged
// into a full generation snapshot - this row only ever tells us "video X
// consumed N credits", never script/avatar/status/etc, so there is nothing
// else honest to put in this payload. normalize_capture_event merges
// metadata_json instead of replacing it wholesale specifically so a thin
// event like this can never blow away the richer snapshot the listing/live
// capture already stored for the same video_id (see normalization.py).
function onHeygenNetworkCreditLedgerMessage(event) {
  if (event.source !== window) return;
  const data = event.data;
  if (!data || data.source !== 'rmw-heygen-network-telemetry' || data.type !== 'HEYGEN_NETWORK_CREDIT_LEDGER') return;
  const rows = data.payload && Array.isArray(data.payload.rows) ? data.payload.rows : [];

  rows.forEach((row) => {
    const videoId = row?.action_id ? String(row.action_id) : '';
    if (!videoId) return;
    const creditsUsed = typeof row?.credit === 'number' ? row.credit : row?.display_value;
    if (typeof creditsUsed !== 'number') return;
    reportHeygenCaptureEvent({
      eventType: 'credit_ledger_row',
      isReconciliation: true,
      payload: { videoId, credits: { used: creditsUsed } },
      identity: { videoId },
      changeToken: row?.id ? String(row.id) : `credit:${creditsUsed}`,
    });
  });
}

window.addEventListener('message', onHeygenNetworkCreditLedgerMessage);

// ---- Proactive credit-ledger fetch (2026-08-05) ----
//
// onHeygenNetworkCreditLedgerMessage above only ever fires if the PAGE
// itself happens to call movio_bill.list, which in practice almost never
// happens on its own - a generation would sit with credits_used=null
// forever unless the user separately visits whatever page shows billing
// history. This actively requests it instead: whenever a row is observed
// (live-armed or reconciliation-listing) transitioning to "settled"
// (completed/failed/cancelled - see isHeygenRowSettled), its video_id is
// queued and content-heygen-network.js (the MAIN-world script that owns
// the real request URL/shape, confirmed 2026-08-05 - see its own comment)
// is asked to fetch the ledger for it. Batched rather than one fetch per
// video: HeyGen's own Credits UI batches many action_ids into a single
// request too (confirmed from the same capture), so this mirrors real
// usage instead of hammering the endpoint per-video.
const HEYGEN_CREDIT_LEDGER_BATCH_DEBOUNCE_MS = 2500;
const HEYGEN_CREDIT_LEDGER_BATCH_MAX_SIZE = 40;
// Page-session-scoped only (reset on reload) - a missed/failed lookup just
// gets re-queued the next time this video's id resurfaces in a listing row,
// same "no infinite tight retry, but never permanently give up either"
// posture as the rest of this file's capture paths.
const heygenCreditLedgerRequested = new Set();
const heygenCreditLedgerQueue = new Set();
let heygenCreditLedgerTimer = null;

function flushHeygenCreditLedgerQueue() {
  heygenCreditLedgerTimer = null;
  if (!heygenCreditLedgerQueue.size) return;
  const actionIds = Array.from(heygenCreditLedgerQueue);
  heygenCreditLedgerQueue.clear();
  try {
    window.postMessage({
      source: 'rmw-heygen-network-telemetry',
      type: 'HEYGEN_REQUEST_CREDIT_LEDGER',
      payload: { actionIds },
    }, location.origin);
  } catch {}
}

function queueHeygenCreditLedgerLookup(videoId) {
  if (!videoId || heygenCreditLedgerRequested.has(videoId)) return;
  heygenCreditLedgerRequested.add(videoId);
  heygenCreditLedgerQueue.add(videoId);
  if (heygenCreditLedgerQueue.size >= HEYGEN_CREDIT_LEDGER_BATCH_MAX_SIZE) {
    if (heygenCreditLedgerTimer) {
      window.clearTimeout(heygenCreditLedgerTimer);
    }
    flushHeygenCreditLedgerQueue();
    return;
  }
  if (heygenCreditLedgerTimer) return;
  heygenCreditLedgerTimer = window.setTimeout(flushHeygenCreditLedgerQueue, HEYGEN_CREDIT_LEDGER_BATCH_DEBOUNCE_MS);
}

// ---- DOM fallback: poll for a rendered output element appearing on the
// page, in case a generation's real output URL only ever surfaces in the DOM
// (e.g. an inline <video>/thumbnail) rather than a captured network response
// - mirrors content-kling.js's startGeneratedAssetDetection at a much
// simpler scale (no per-asset dedupe across many thumbnails, just "did the
// preview area gain a video/src since we armed"). ----

const HEYGEN_ASSET_SCAN_MS = 4000;
const HEYGEN_ASSET_SCAN_MAX_MS = 10 * 60 * 1000;
let heygenAssetScanTimer = null;
let heygenAssetScanStartedAt = 0;

function collectHeygenVisibleOutputUrl() {
  const video = Array.from(document.querySelectorAll('video[src], video source[src]'))
    .find((el) => isVisible(el.closest('video') || el));
  if (video) {
    const src = video.tagName === 'VIDEO' ? video.currentSrc || video.src : video.src;
    if (src && !src.startsWith('blob:')) return src;
  }
  const downloadLink = Array.from(document.querySelectorAll('a[href*=".mp4" i], a[download]'))
    .find((el) => isVisible(el));
  return downloadLink?.href || null;
}

function stopHeygenAssetDetection() {
  if (heygenAssetScanTimer) { window.clearInterval(heygenAssetScanTimer); heygenAssetScanTimer = null; }
}

function startHeygenAssetDetection() {
  stopHeygenAssetDetection();
  heygenAssetScanStartedAt = Date.now();
  heygenAssetScanTimer = window.setInterval(() => {
    if (!heygenActiveGeneration || Date.now() - heygenAssetScanStartedAt > HEYGEN_ASSET_SCAN_MAX_MS) {
      stopHeygenAssetDetection();
      return;
    }
    const outputUrl = collectHeygenVisibleOutputUrl();
    if (!outputUrl) return;
    stopHeygenAssetDetection();
    setHeygenCaptureStatus('Capturing…');
    reportHeygenCaptureEvent({
      eventType: heygenActiveGeneration.kind === 'scene_render' ? 'scene_render_click' : 'generate_click',
      isReconciliation: false,
      payload: {
        ...heygenActiveGeneration.submitSnapshot,
        status: 'completed',
        output: { videoUrl: outputUrl },
      },
      identity: { externalEventId: heygenActiveGeneration.generateIntentId },
      changeToken: 'completed_dom',
    });
  }, HEYGEN_ASSET_SCAN_MS);
}
