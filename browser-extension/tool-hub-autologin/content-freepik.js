const TOOL_SLUG = 'freepik';
const LOGIN_URL = 'https://www.magnific.com/log-in?client_id=magnific&lang=en';
const SIGNUP_URL_PATH_FRAGMENT = '/sign-up';
const PREPARED_LAUNCH_KEY = 'rmw_freepik_prepared_launch';
const BLOCKED_NOTICE_KEY = 'rmw_freepik_blocked_notice';
const EXTENSION_TICKET_KEY = 'rmw_extension_ticket';

const MIN_RUN_GAP_MS = 400;
const KEEP_ALIVE_MS = 2000;
const LOGIN_OPEN_COOLDOWN_MS = 2500;
const SUBMIT_COOLDOWN_MS = 1500;

const EMAIL_SELECTORS = [
  'input[type="email"]',
  'input[name="email"]',
  'input[id*="email"]',
  'input[name*="email"]',
  'input[autocomplete="username"]',
  'input[autocomplete="email"]',
  'input[placeholder*="email" i]',
  'input[aria-label*="email" i]',
];

const PASSWORD_SELECTORS = [
  'input[type="password"]',
  'input[name="password"]',
  'input[id*="password"]',
  'input[name*="password"]',
  'input[autocomplete="current-password"]',
  'input[placeholder*="password" i]',
  'input[aria-label*="password" i]',
];

const PASSWORD_REVEAL_ACTION_HINTS = ['show', 'hide', 'view', 'reveal', 'toggle'];
const PASSWORD_REVEAL_SUBJECT_HINTS = ['password', 'passcode'];
const PASSWORD_REVEAL_ICON_HINTS = ['eye', 'visibility', 'visible'];

const ACTION_SELECTORS = [
  'button',
  'a[href]',
  'input[type="submit"]',
  'input[type="button"]',
  '[role="button"]',
].join(',');

const STATE = {
  status: 'Waiting for Magnific',
  credential: null,
  launchChecked: false,
  launchAuthorized: false,
  launchExpiresAt: 0,
  requestedCredential: false,
  scheduledTimer: null,
  keepAliveTimer: null,
  observer: null,
  lastRunAt: 0,
  lastLoginOpenAt: 0,
  lastSubmitAt: 0,
  lastEmailContinueAt: 0,
  passwordFilled: false,
  passwordRevealGuardAttached: false,
  switchingToLoginUntil: 0,
  lastBackNavigationAt: 0,
  stopped: false,
};

function normalizeLoginMethod(value) {
  return `${value || ''}`.trim().toLowerCase() || 'email_password';
}

function isGoogleCredential() {
  return normalizeLoginMethod(STATE.credential?.loginMethod) === 'google';
}

function ensureStatusBadge() {
  const existing = document.getElementById('rmw-autologin-status');
  if (existing) return existing;

  const badge = document.createElement('div');
  badge.id = 'rmw-autologin-status';
  Object.assign(badge.style, {
    position: 'fixed',
    top: '12px',
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
  });
  badge.textContent = `Magnific auto-login\n${STATE.status}`;
  (document.body || document.documentElement).appendChild(badge);
  return badge;
}

function hideStatusBadge() {
  const badge = document.getElementById('rmw-autologin-status');
  if (badge) {
    badge.remove();
  }
}

function setStatus(message) {
  if (STATE.status === message) return;
  STATE.status = message;
  ensureStatusBadge().textContent = `Magnific auto-login\n${message}`;
  console.debug('[RMW Magnific Auto Login]', message);
}

function stop(message) {
  STATE.stopped = true;
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
}

function complete(message = 'Magnific login complete') {
  STATE.stopped = true;
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
  STATE.status = message;
  console.debug('[RMW Magnific Auto Login]', message);
  window.setTimeout(() => hideStatusBadge(), 600);
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
  try {
    const searchParams = new URLSearchParams(window.location.search || '');
    const queryTicket = `${searchParams.get('rmw_extension_ticket') || ''}`.trim();
    if (queryTicket) return queryTicket;

    const hash = `${window.location.hash || ''}`.replace(/^#/, '');
    return `${new URLSearchParams(hash).get('rmw_extension_ticket') || ''}`.trim();
  } catch {
    return '';
  }
}

function getStoredLaunchTicket() {
  try {
    return `${window.sessionStorage.getItem(EXTENSION_TICKET_KEY) || ''}`.trim();
  } catch {
    return '';
  }
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

function clearStoredLaunchTicket() {
  try {
    window.sessionStorage.removeItem(EXTENSION_TICKET_KEY);
  } catch {}
}

function captureLaunchTicket() {
  const ticket = readLaunchTicketFromUrl();
  if (!ticket) return getStoredLaunchTicket();

  storeLaunchTicket(ticket);
  try {
    const searchParams = new URLSearchParams(window.location.search || '');
    searchParams.delete('rmw_extension_ticket');
    searchParams.delete('rmw_tool_slug');
    const nextSearch = searchParams.toString();
    window.history.replaceState(
      null,
      '',
      `${window.location.pathname}${nextSearch ? `?${nextSearch}` : ''}${window.location.hash}`
    );
  } catch {}
  return ticket;
}

function getPreparedLaunchKey() {
  try {
    return `${window.sessionStorage.getItem(PREPARED_LAUNCH_KEY)
      || window.localStorage.getItem(PREPARED_LAUNCH_KEY)
      || ''}`.trim();
  } catch {
    return '';
  }
}

function hasLocalLaunchEvidence() {
  return Boolean(
    readLaunchTicketFromUrl()
    || getStoredLaunchTicket()
    || getPreparedLaunchKey()
  );
}

async function loadLaunchState() {
  const storedTicket = captureLaunchTicket();
  if (storedTicket) {
    const activation = await sendRuntimeMessage({
      type: 'TOOL_HUB_ACTIVATE_LAUNCH',
      toolSlug: TOOL_SLUG,
      hostname: window.location.hostname,
      pageUrl: window.location.href,
      extensionTicket: storedTicket,
    });

    if (activation?.ok && activation.authorized) {
      clearStoredLaunchTicket();
      STATE.launchChecked = true;
      STATE.launchAuthorized = true;
      STATE.launchExpiresAt = Number(activation.expiresAt || 0);
      return;
    }
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
}

function isVisible(element) {
  if (!element) return false;
  const rect = element.getBoundingClientRect();
  const style = window.getComputedStyle(element);
  return rect.width > 0
    && rect.height > 0
    && style.display !== 'none'
    && style.visibility !== 'hidden';
}

function isDisabled(element) {
  return !element
    || element.disabled
    || element.getAttribute('aria-disabled') === 'true'
    || element.getAttribute('disabled') !== null;
}

function normalizeText(value) {
  return `${value || ''}`.replace(/\s+/g, ' ').trim().toLowerCase();
}

function actionText(element) {
  return normalizeText(
    element?.innerText
      || element?.textContent
      || element?.value
      || element?.getAttribute?.('aria-label')
      || element?.getAttribute?.('title')
      || ''
  );
}

function controlHintText(element) {
  return normalizeText([
    actionText(element),
    element?.getAttribute?.('name'),
    element?.getAttribute?.('id'),
    element?.getAttribute?.('class'),
    element?.getAttribute?.('data-testid'),
    element?.getAttribute?.('data-icon'),
    element?.getAttribute?.('aria-controls'),
  ].filter(Boolean).join(' '));
}

function collectActionCandidates(root = document, options = {}) {
  const includeDisabled = Boolean(options.includeDisabled);
  return Array.from(root.querySelectorAll(ACTION_SELECTORS))
    .filter((element) => isVisible(element) && (includeDisabled || !isDisabled(element)));
}

function collectUniqueElements(elements) {
  return Array.from(new Set(elements.filter(Boolean)));
}

function collectBroadActionCandidates() {
  const textNodes = Array.from(document.querySelectorAll('button, a[href], [role="button"], [tabindex], div, span'))
    .map((element) => findClickableAncestor(element));
  return collectUniqueElements([
    ...collectActionCandidates(),
    ...textNodes,
  ]).filter((element) => isVisible(element) && !isDisabled(element));
}

function collectGoogleTextCandidates() {
  return collectUniqueElements(
    Array.from(document.querySelectorAll('button, a[href], [role="button"], [tabindex], div, span, p, strong'))
      .map((element) => {
        const text = actionText(element);
        const hints = controlHintText(element);
        if (
          text.includes('google')
          || text.includes('gmail')
          || hints.includes('google')
          || hints.includes('gmail')
        ) {
          return findClickableAncestor(element);
        }
        return null;
      })
  ).filter((element) => isVisible(element) && !isDisabled(element));
}

function collectElementChain(element, maxDepth = 8) {
  const chain = [];
  let current = element || null;
  let depth = 0;
  while (current && current !== document.body && depth < maxDepth) {
    chain.push(current);
    current = current.parentElement;
    depth += 1;
  }
  return chain;
}

function extractCandidateUrlsFromText(value) {
  const raw = `${value || ''}`;
  const matches = [
    ...raw.matchAll(/https?:\/\/[^\s"'`]+/gi),
  ];
  return matches.map((match) => `${match[0] || ''}`.trim()).filter(Boolean);
}

function resolveAbsoluteUrl(value) {
  const raw = `${value || ''}`.trim();
  if (!raw || raw.startsWith('#') || raw.toLowerCase().startsWith('javascript:')) {
    return '';
  }
  try {
    return new URL(raw, window.location.href).href;
  } catch {
    return '';
  }
}

function looksLikeGoogleLoginUrl(value) {
  const absoluteUrl = resolveAbsoluteUrl(value);
  if (!absoluteUrl) return false;
  try {
    const url = new URL(absoluteUrl);
    const host = normalizeText(url.hostname);
    const path = normalizeText(url.pathname);
    const query = normalizeText(url.search);
    if (host.includes('accounts.google.com')) {
      return true;
    }
    return (
      (host.includes('magnific.com') || host.includes('freepik.com'))
      && (
        (path.includes('oauth') && query.includes('google'))
        || (path.includes('auth') && query.includes('google'))
        || (path.includes('social') && query.includes('google'))
      )
    );
  } catch {
    return false;
  }
}

function resolveGoogleLoginUrl(element) {
  const candidates = [];
  collectElementChain(element).forEach((node) => {
    if (!node?.getAttributeNames) return;
    node.getAttributeNames().forEach((attributeName) => {
      const attributeValue = `${node.getAttribute(attributeName) || ''}`.trim();
      if (!attributeValue) return;
      candidates.push(attributeValue);
      extractCandidateUrlsFromText(attributeValue).forEach((value) => candidates.push(value));
    });
    ['href', 'action', 'formAction'].forEach((propertyName) => {
      const propertyValue = `${node[propertyName] || ''}`.trim();
      if (!propertyValue) return;
      candidates.push(propertyValue);
      extractCandidateUrlsFromText(propertyValue).forEach((value) => candidates.push(value));
    });
  });

  for (const candidate of candidates) {
    if (!looksLikeGoogleLoginUrl(candidate)) continue;
    const absoluteUrl = resolveAbsoluteUrl(candidate);
    if (absoluteUrl) return absoluteUrl;
  }
  return '';
}

function isActionLikeElement(element) {
  if (!element || !isVisible(element) || isDisabled(element)) return false;
  if (element.matches?.(ACTION_SELECTORS)) return true;
  if (element.tabIndex >= 0) return true;
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

function findInput(selectors) {
  for (const selector of selectors) {
    const match = Array.from(document.querySelectorAll(selector))
      .find((element) => isVisible(element) && !element.disabled && !element.readOnly);
    if (match) return match;
  }
  return null;
}

function findLoginOpenAction() {
  const continueWithEmail = collectActionCandidates().find((element) => {
    const text = actionText(element);
    return text.includes('continue with email')
      || text.includes('use email')
      || text === 'email';
  });
  if (continueWithEmail) return continueWithEmail;

  return collectActionCandidates().find((element) => {
    const text = actionText(element);
    const href = normalizeText(element.getAttribute?.('href') || '');

    return text.includes('log in')
      || text.includes('login')
      || text.includes('sign in')
      || href.includes('/log-in')
      || href.includes('/login');
  }) || null;
}

function findEmailChooserAction() {
  return collectActionCandidates().find((element) => {
    const text = actionText(element);
    return text.includes('continue with email')
      || text.includes('use email')
      || text === 'email';
  }) || null;
}

function findGoogleLoginAction() {
  const broadMatch = collectBroadActionCandidates().find((element) => {
    const text = actionText(element);
    const href = normalizeText(element.getAttribute?.('href') || '');
    const hints = controlHintText(element);
    return text.includes('continue with google')
      || text.includes('continue with gmail')
      || text.includes('continue with google account')
      || text.includes('continue with gmail account')
      || text.includes('sign in with google')
      || text.includes('sign in with gmail')
      || text.includes('login with google')
      || text.includes('login with gmail')
      || text.includes('continue using google')
      || text.includes('continue using gmail')
      || text === 'google'
      || text === 'gmail'
      || href.includes('accounts.google.com')
      || (href.includes('oauth') && href.includes('google'))
      || (hints.includes('google') && (hints.includes('oauth') || hints.includes('social')))
      || (hints.includes('gmail') && (hints.includes('oauth') || hints.includes('social')))
      || (hints.includes('google') && hints.includes('continue'))
      || (hints.includes('gmail') && hints.includes('continue'));
  });
  if (broadMatch) return broadMatch;

  return collectGoogleTextCandidates().find((element) => {
    const text = actionText(element);
    const href = normalizeText(element.getAttribute?.('href') || '');
    const hints = controlHintText(element);
    return text.includes('google')
      || text.includes('gmail')
      || href.includes('google')
      || hints.includes('google')
      || hints.includes('gmail');
  }) || null;
}

function findGenericLoginAction() {
  return collectActionCandidates().find((element) => {
    const text = actionText(element);
    const href = normalizeText(element.getAttribute?.('href') || '');
    const textLooksLikeLogin = (text === 'log in' || text === 'login' || text === 'sign in' || text.includes('log in'))
      && !text.includes('google')
      && !text.includes('apple')
      && !text.includes('email')
      && !text.includes('sign up')
      && !text.includes('create account');
    return textLooksLikeLogin
      || href.includes('/log-in')
      || href.includes('/login');
  }) || null;
}

function findBackAction() {
  return collectActionCandidates().find((element) => {
    const text = actionText(element);
    const href = normalizeText(element.getAttribute?.('href') || '');
    return text === 'back'
      || text.includes(' back')
      || text.startsWith('back ')
      || text.includes('go back')
      || href === '/'
      || href.endsWith('/log-in')
      || href.endsWith('/login');
  }) || null;
}

function isLoginPage() {
  return window.location.pathname.includes('/log-in')
    || window.location.pathname.includes('/login')
    || Boolean(findInput(EMAIL_SELECTORS))
    || Boolean(findInput(PASSWORD_SELECTORS))
    || Boolean(findLoginOpenAction());
}

function isAuthenticatedMagnificPage() {
  try {
    const url = new URL(window.location.href);
    const host = normalizeText(url.hostname);
    const path = normalizeText(url.pathname);
    const onMagnificHost = host.includes('magnific.com') || host.includes('freepik.com');
    if (!onMagnificHost) return false;

    if (path.includes('/log-in') || path.includes('/login') || path.includes('/sign-up') || path.includes('/signup')) {
      return false;
    }
  } catch {
    return false;
  }

  const emailInput = findInput(EMAIL_SELECTORS);
  const passwordInput = findInput(PASSWORD_SELECTORS);
  if (emailInput || passwordInput) return false;

  const pageText = normalizeText(document.body?.innerText || '');
  const looksLikeAuthenticatedAppShell = (
    pageText.includes('hello,')
    || pageText.includes('good morning, start creating')
    || pageText.includes('what do you want to create')
  ) && (
    pageText.includes('projects')
    || pageText.includes('all tools')
    || pageText.includes('chat history')
    || pageText.includes('personal')
  );
  if (looksLikeAuthenticatedAppShell) return true;

  if (findGoogleLoginAction() || findGenericLoginAction()) return false;

  return pageText.includes('logout')
    || pageText.includes('profile')
    || pageText.includes('settings')
    || pageText.includes('projects')
    || pageText.includes('workspace')
    || pageText.includes('dashboard')
    || pageText.includes('my account');
}

function onSignUpRoute() {
  return window.location.pathname.includes(SIGNUP_URL_PATH_FRAGMENT);
}

function getFieldRoots(...fields) {
  const seed = fields.find(Boolean);
  if (!seed) return [document];

  const roots = [];
  let current = seed.parentElement;
  while (current && current !== document.body) {
    roots.push(current);
    if (current.matches?.('form, [role="dialog"], [aria-modal="true"], main, section, article')) {
      break;
    }
    current = current.parentElement;
  }
  roots.push(document);
  return Array.from(new Set(roots));
}

function collectFieldContextText(emailInput, passwordInput, maxRoots = 3) {
  const scopedRoots = getFieldRoots(emailInput, passwordInput)
    .filter((root) => root && root !== document);
  const roots = scopedRoots.length ? scopedRoots : [document];
  return normalizeText(roots
    .slice(0, Math.max(1, maxRoots))
    .map((root) => root?.innerText || root?.textContent || '')
    .join(' '));
}

function hasLoginSurfaceClues(emailInput, passwordInput) {
  const contextText = collectFieldContextText(emailInput, passwordInput, 3);
  return contextText.includes('forgot my password')
    || contextText.includes('stay logged in');
}

function hasSignUpSurfaceClues(emailInput, passwordInput) {
  const contextText = collectFieldContextText(emailInput, passwordInput, 3);
  return contextText.includes('create an account');
}

function findButtonByText(emailInput, passwordInput, matcher, options = {}) {
  for (const root of getFieldRoots(emailInput, passwordInput)) {
    const candidates = collectActionCandidates(root, options);
    const match = candidates.find((element) => matcher(actionText(element), element));
    if (match) return match;
  }

  return null;
}

function findLoginSubmitButton(emailInput, passwordInput, options = {}) {
  const exactMatches = new Set(['log in', 'login', 'sign in', 'continue']);
  const exact = findButtonByText(
    emailInput,
    passwordInput,
    (text) => exactMatches.has(text),
    options
  );
  if (exact) return exact;

  const partial = findButtonByText(
    emailInput,
    passwordInput,
    (text) => (
      (text.includes('log in') || text.includes('login') || text.includes('sign in') || text.includes('continue'))
      && !text.includes('google')
      && !text.includes('apple')
      && !text.includes('email')
      && !text.includes('sign up')
      && !text.includes('create account')
    ),
    options
  );
  if (partial) return partial;

  for (const root of getFieldRoots(emailInput, passwordInput)) {
    const candidates = collectActionCandidates(root, options);
    const submit = candidates.find((element) => `${element.type || ''}`.toLowerCase() === 'submit');
    if (submit) return submit;
  }

  return null;
}

function findEmailContinueButton(emailInput, options = {}) {
  const exact = findButtonByText(
    emailInput,
    null,
    (text) => text === 'continue',
    options
  );
  if (exact) return exact;

  const partial = findButtonByText(
    emailInput,
    null,
    (text) => (
      text.includes('continue')
      && !text.includes('google')
      && !text.includes('gmail')
      && !text.includes('apple')
      && !text.includes('sso')
      && !text.includes('sign up')
      && !text.includes('create account')
      && !text.includes('continue as')
    ),
    options
  );
  if (partial) return partial;

  for (const root of getFieldRoots(emailInput, null)) {
    const candidates = collectActionCandidates(root, options);
    const submit = candidates.find((element) => `${element.type || ''}`.toLowerCase() === 'submit');
    if (submit) return submit;
  }

  return null;
}

function findSignUpSubmitButton(emailInput, passwordInput, options = {}) {
  const exactMatches = new Set(['sign up', 'create account']);
  const exact = findButtonByText(
    emailInput,
    passwordInput,
    (text) => exactMatches.has(text),
    options
  );
  if (exact) return exact;

  return findButtonByText(
    emailInput,
    passwordInput,
    (text) => text.includes('sign up') || text.includes('create account'),
    options
  );
}

function isSignUpActionText(text) {
  return text.includes('sign up') || text.includes('create account');
}

function findExistingAccountAction(emailInput, passwordInput) {
  if (hasLoginSurfaceClues(emailInput, passwordInput)) return null;

  const currentSubmit = findSignUpSubmitButton(emailInput, passwordInput, { includeDisabled: true });
  const submitText = actionText(currentSubmit);
  if (!isSignUpActionText(submitText)) return null;

  const searchRoots = getFieldRoots(emailInput, passwordInput);
  const actionCandidates = collectUniqueElements([
    ...searchRoots.flatMap((root) => collectActionCandidates(root)),
    ...searchRoots.flatMap((root) =>
      Array.from(root.querySelectorAll('a[href], button, [role="button"], [tabindex], span, div'))
        .map((element) => findClickableAncestor(element))
    ),
  ]);

  return actionCandidates.find((element) => {
    if (!element || element === currentSubmit) return false;

    const text = actionText(element);
    const href = normalizeText(element.getAttribute?.('href') || '');
    if (!text && !href) return false;
    if (isSignUpActionText(text)) return false;

    return text === 'log in'
      || text === 'login'
      || text === 'sign in'
      || text.includes('already have an account')
      || (text.includes('log in') && !text.includes('google') && !text.includes('apple'))
      || href.includes('/log-in')
      || href.includes('/login');
  }) || null;
}

function isSignUpSurface(emailInput, passwordInput) {
  if (!emailInput || !passwordInput) return false;
  if (hasLoginSurfaceClues(emailInput, passwordInput)) return false;
  const submitButton = findSignUpSubmitButton(emailInput, passwordInput, { includeDisabled: true });
  return isSignUpActionText(actionText(submitButton)) || hasSignUpSurfaceClues(emailInput, passwordInput);
}

function collectPasswordFieldScopes(passwordInput) {
  const scopes = [];
  let current = passwordInput?.parentElement || null;
  let depth = 0;
  while (current && current !== document.body && depth < 5) {
    scopes.push(current);
    current = current.parentElement;
    depth += 1;
  }
  return Array.from(new Set(scopes));
}

function verticalOverlapAmount(aRect, bRect) {
  return Math.max(0, Math.min(aRect.bottom, bRect.bottom) - Math.max(aRect.top, bRect.top));
}

function isNearPasswordInput(passwordInput, candidate) {
  if (!passwordInput || !candidate || !isVisible(candidate)) return false;

  const passwordRect = passwordInput.getBoundingClientRect();
  const candidateRect = candidate.getBoundingClientRect();
  const verticalOverlap = verticalOverlapAmount(passwordRect, candidateRect);
  const horizontalGap = candidateRect.left - passwordRect.right;
  const candidateCenterX = candidateRect.left + (candidateRect.width / 2);

  return verticalOverlap >= Math.min(passwordRect.height, candidateRect.height) * 0.4
    && candidateCenterX >= passwordRect.right - 40
    && horizontalGap <= 80;
}

function isPasswordRowAffordance(passwordInput, candidate) {
  if (!passwordInput || !candidate || !isVisible(candidate)) return false;

  const passwordRect = passwordInput.getBoundingClientRect();
  const candidateRect = candidate.getBoundingClientRect();
  const verticalOverlap = verticalOverlapAmount(passwordRect, candidateRect);
  const horizontalGap = candidateRect.left - passwordRect.right;
  const candidateCenterX = candidateRect.left + (candidateRect.width / 2);

  return verticalOverlap >= Math.min(passwordRect.height, candidateRect.height) * 0.35
    && candidateCenterX >= passwordRect.right - 50
    && horizontalGap <= 120;
}

function enforcePasswordMask(passwordInput) {
  if (!passwordInput) return;
  try {
    passwordInput.type = 'password';
    passwordInput.setAttribute('type', 'password');
  } catch {}
}

function blockPasswordToggleEvent(event, passwordInput) {
  enforcePasswordMask(passwordInput);
  event.preventDefault();
  event.stopImmediatePropagation();
  event.stopPropagation();
}

function findPasswordToggleCandidates(passwordInput) {
  const roots = collectPasswordFieldScopes(passwordInput);
  const rawCandidates = roots.flatMap((root) =>
    Array.from(root.querySelectorAll('button, [role="button"], [tabindex], [aria-label], [title], svg, img, span, div'))
  );

  return Array.from(new Set(rawCandidates))
    .map((element) => element.closest?.('button, [role="button"], [tabindex]') || element)
    .filter((element) => element && element !== passwordInput && !element.contains(passwordInput) && !passwordInput.contains(element))
    .filter((element) => {
      const hints = controlHintText(element);
      const hasSubjectHint = PASSWORD_REVEAL_SUBJECT_HINTS.some((hint) => hints.includes(hint));
      const hasActionHint = PASSWORD_REVEAL_ACTION_HINTS.some((hint) => hints.includes(hint));
      const hasIconHint = PASSWORD_REVEAL_ICON_HINTS.some((hint) => hints.includes(hint));
      const classHints = normalizeText(`${element.className || ''}`);
      const hasIconChild = Boolean(element.querySelector?.('svg, img'));
      const looksLikeEye = hasIconChild || /eye|visibility|show|hide|view/.test(classHints);

      return (hasSubjectHint && (hasActionHint || hasIconHint))
        || (isNearPasswordInput(passwordInput, element) && (hasIconHint || looksLikeEye))
        || isPasswordRowAffordance(passwordInput, element);
    });
}

function findPasswordToggleFromTarget(target, passwordInput) {
  if (!target || !passwordInput) return null;

  const path = typeof target.composedPath === 'function' ? target.composedPath() : [];
  const pathElements = path.filter((node) => node?.nodeType === Node.ELEMENT_NODE);
  const ancestors = [];
  let current = target?.nodeType === Node.ELEMENT_NODE ? target : target?.parentElement;
  while (current && current !== document.body) {
    ancestors.push(current);
    current = current.parentElement;
  }

  const candidates = Array.from(new Set([...pathElements, ...ancestors]))
    .map((element) => element.closest?.('button, [role="button"], [tabindex]') || element);
  const knownToggles = findPasswordToggleCandidates(passwordInput);
  return candidates.find((element) => knownToggles.includes(element)) || null;
}

function ensurePasswordRevealGuard() {
  if (STATE.passwordRevealGuardAttached) return;
  STATE.passwordRevealGuardAttached = true;

  ['click', 'mousedown', 'mouseup', 'pointerdown', 'pointerup', 'touchstart', 'touchend', 'keydown', 'keyup']
    .forEach((eventName) => {
      document.addEventListener(eventName, (event) => {
        const passwordInput = findInput(PASSWORD_SELECTORS);
        if (!passwordInput) return;
        const toggle = findPasswordToggleFromTarget(event.target, passwordInput);
        if (!toggle) return;
        blockPasswordToggleEvent(event, passwordInput);
      }, true);
    });
}

function lockPasswordVisibility(passwordInput) {
  void passwordInput;
}

function isLoginSurface(emailInput, passwordInput) {
  if (!emailInput || !passwordInput) return false;
  if (hasLoginSurfaceClues(emailInput, passwordInput)) return true;
  const submitText = actionText(findLoginSubmitButton(emailInput, passwordInput, { includeDisabled: true }));
  return submitText === 'log in'
    || submitText === 'login'
    || submitText === 'sign in';
}

function isEmailChooserSurface() {
  return Boolean(findEmailChooserAction());
}

function protectPasswordField(passwordInput) {
  if (!passwordInput) return;
  ensurePasswordRevealGuard();
  lockPasswordVisibility(passwordInput);
}

function setInputValue(input, value) {
  const descriptor = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value');
  if (descriptor?.set) descriptor.set.call(input, value);
  else input.value = value;

  input.setAttribute('value', value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
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

function clickElement(element) {
  if (!element || !isVisible(element) || isDisabled(element)) return false;
  try {
    element.scrollIntoView({ block: 'center', inline: 'nearest' });
  } catch {}
  try {
    element.focus({ preventScroll: true });
  } catch {}
  try {
    const href = `${element.getAttribute?.('href') || element.href || ''}`.trim();
    const canDirectNavigate = href
      && !href.startsWith('#')
      && !href.toLowerCase().startsWith('javascript:');
    if (typeof PointerEvent === 'function') {
      ['pointerdown', 'pointerup'].forEach((eventName) => {
        try {
          element.dispatchEvent(new PointerEvent(eventName, {
            bubbles: true,
            cancelable: true,
            pointerType: 'mouse',
            isPrimary: true,
            view: window,
          }));
        } catch {}
      });
    }
    ['pointerdown', 'mousedown', 'mouseup', 'click'].forEach((eventName) => {
      try {
        element.dispatchEvent(new MouseEvent(eventName, {
          bubbles: true,
          cancelable: true,
          view: window,
        }));
      } catch {}
    });
    if (typeof element.click === 'function') {
      element.click();
    }
    if (canDirectNavigate && isVisible(element)) {
      window.setTimeout(() => {
        if (document.contains(element)) {
          try { window.location.assign(href); } catch {}
        }
      }, 250);
    }
    return true;
  } catch {
    return false;
  }
}

function clickElementAtCenter(element) {
  if (!element || !isVisible(element) || isDisabled(element)) return false;
  const rect = element.getBoundingClientRect();
  if (!rect.width || !rect.height) return false;

  const centerX = rect.left + (rect.width / 2);
  const centerY = rect.top + (rect.height / 2);
  const topElement = document.elementFromPoint(centerX, centerY);
  const target = findClickableAncestor(topElement) || findClickableAncestor(element) || element;
  return clickElement(target);
}

function clickGoogleLoginAction(element) {
  if (!element) return false;

  const targets = collectUniqueElements([
    element,
    element.closest?.('button, a[href], [role="button"], form'),
    ...collectElementChain(element),
  ]).filter(Boolean);

  let clicked = false;
  for (const target of targets) {
    if (clickElementAtCenter(target) || clickElement(target)) {
      clicked = true;
      break;
    }
  }

  const url = resolveGoogleLoginUrl(element);
  if (url) {
    window.setTimeout(() => {
      try { window.location.assign(url); } catch {}
    }, clicked ? 250 : 0);
    return true;
  }

  return clicked;
}

function submitLogin(emailInput, passwordInput, submitButton) {
  if (clickElementAtCenter(submitButton) || clickElement(submitButton)) return true;
  if (submitNearestForm(passwordInput || emailInput)) return true;
  return pressEnter(passwordInput || emailInput);
}

function requestCredential() {
  if (STATE.requestedCredential || STATE.credential) return;

  STATE.requestedCredential = true;
  setStatus('Fetching credential');

  chrome.runtime.sendMessage(
    {
      type: 'TOOL_HUB_GET_CREDENTIAL',
      toolSlug: TOOL_SLUG,
      hostname: window.location.hostname,
      pageUrl: window.location.href,
      extensionTicket: getStoredLaunchTicket(),
    },
    (response) => {
      STATE.requestedCredential = false;

      if (chrome.runtime.lastError) {
        stop(`Extension error: ${chrome.runtime.lastError.message}`);
        return;
      }

      if (!response?.ok) {
        setStatus(response?.error || 'Credential unavailable');
        return;
      }

      clearStoredLaunchTicket();
      STATE.credential = response.data?.credential || null;
      if (!STATE.credential?.loginIdentifier || (!STATE.credential?.password && !isGoogleCredential())) {
        setStatus('Credential missing');
        return;
      }

      setStatus('Credential loaded');
      scheduleAttempt(100);
    }
  );
}

function isReadyForSubmit(emailInput, passwordInput) {
  if (!emailInput || !passwordInput || !STATE.credential) return false;
  return emailInput.value === STATE.credential.loginIdentifier
    && passwordInput.value === STATE.credential.password;
}

async function enforceDashboardOnlyAccess() {
  const alreadyNotified = window.sessionStorage.getItem(BLOCKED_NOTICE_KEY) === '1';
  if (!isLoginPage()) {
    await sendRuntimeMessage({
      type: 'TOOL_HUB_REVOKE_ACTIVE_LAUNCH',
      toolSlug: TOOL_SLUG,
    });
    window.sessionStorage.setItem(BLOCKED_NOTICE_KEY, '1');
    window.location.replace(LOGIN_URL);
    return;
  }

  if (!alreadyNotified) {
    window.sessionStorage.setItem(BLOCKED_NOTICE_KEY, '1');
  }

  stop('Launch this tool from the dashboard first');
}

async function ensureFreshLaunchSession() {
  const launchKey = `${STATE.launchExpiresAt || 0}`;
  if (!launchKey || launchKey === '0') {
    return;
  }

  if (getPreparedLaunchKey() === launchKey) {
    return;
  }

  window.sessionStorage.setItem(PREPARED_LAUNCH_KEY, launchKey);
  try { window.localStorage.setItem(PREPARED_LAUNCH_KEY, launchKey); } catch {}
  window.sessionStorage.removeItem(BLOCKED_NOTICE_KEY);
  setStatus('Preparing fresh Magnific session');

  if (window.location.href !== LOGIN_URL) {
    window.location.replace(LOGIN_URL);
    return;
  }

  window.location.reload();
}

function scheduleAsyncStep(task) {
  if (STATE.stopped) return;
  STATE.stopped = true;
  Promise.resolve()
    .then(task)
    .then(() => {
      if (STATE.stopped) {
        STATE.stopped = false;
        scheduleAttempt(200);
      }
    })
    .catch((error) => {
      stop(`Session check failed: ${error?.message || 'Unknown error'}`);
    });
}

function attemptFlow() {
  if (STATE.stopped) return;

  if (onSignUpRoute()) {
    setStatus('Redirecting to Magnific log-in form');
    window.location.replace(LOGIN_URL);
    return;
  }

  if (!STATE.launchChecked) {
    setStatus('Checking dashboard launch');
    return;
  }

  if (!STATE.launchAuthorized) {
    scheduleAsyncStep(enforceDashboardOnlyAccess);
    return;
  }

  if (isAuthenticatedMagnificPage()) {
    complete();
    return;
  }

  if (
    STATE.launchExpiresAt
    && getPreparedLaunchKey() !== `${STATE.launchExpiresAt}`
  ) {
    scheduleAsyncStep(ensureFreshLaunchSession);
    return;
  }

  const emailInput = findInput(EMAIL_SELECTORS);
  const passwordInput = findInput(PASSWORD_SELECTORS);
  const hasCredentialInputs = Boolean(emailInput && passwordInput);
  const hasEmailOnlyCredentialInput = Boolean(emailInput && !passwordInput);
  const hasPasswordOnlyCredentialInput = Boolean(!emailInput && passwordInput);
  const loginFormVisible = hasCredentialInputs && isLoginSurface(emailInput, passwordInput);
  const signUpFormVisible = hasCredentialInputs && !loginFormVisible && isSignUpSurface(emailInput, passwordInput);
  const unknownCredentialSurface = hasCredentialInputs && !loginFormVisible && !signUpFormVisible;
  const emailChooserVisible = !hasCredentialInputs && isEmailChooserSurface();
  const emailChooserAction = !hasCredentialInputs ? findEmailChooserAction() : null;
  const genericLoginAction = !hasCredentialInputs && !emailChooserVisible ? findGenericLoginAction() : null;
  const googleLoginAction = findGoogleLoginAction();
  const backAction = findBackAction();

  if (loginFormVisible) {
    STATE.switchingToLoginUntil = 0;
  }

  if (passwordInput) {
    protectPasswordField(passwordInput);
  }

  if (!STATE.credential) {
    requestCredential();
  }

  if (hasEmailOnlyCredentialInput && !isGoogleCredential()) {
    if (!STATE.credential?.loginIdentifier) {
      setStatus('Waiting for credential');
      return;
    }

    if (!isVisible(emailInput)) {
      setStatus('Waiting for email field');
      return;
    }

    if (emailInput.value !== STATE.credential.loginIdentifier) {
      emailInput.focus();
      setInputValue(emailInput, STATE.credential.loginIdentifier);
      STATE.lastEmailContinueAt = 0;
      setStatus('Entering Magnific email');
      scheduleAttempt(350);
      return;
    }

    const continueButton = findEmailContinueButton(emailInput, { includeDisabled: true });
    if (continueButton && isDisabled(continueButton)) {
      setStatus('Waiting for Magnific email continue');
      scheduleAttempt(350);
      return;
    }

    if (Date.now() - STATE.lastEmailContinueAt < LOGIN_OPEN_COOLDOWN_MS) {
      setStatus('Waiting for Magnific password form');
      scheduleAttempt(400);
      return;
    }

    STATE.lastEmailContinueAt = Date.now();
    setStatus('Submitting Magnific email');
    if (clickElement(continueButton) || submitNearestForm(emailInput) || pressEnter(emailInput)) {
      scheduleAttempt(700);
      return;
    }

    setStatus('Waiting for Magnific email continue');
    scheduleAttempt(400);
    return;
  }

  if (hasPasswordOnlyCredentialInput && !isGoogleCredential()) {
    if (!STATE.credential?.password) {
      setStatus('Waiting for credential');
      return;
    }

    if (!isVisible(passwordInput)) {
      setStatus('Waiting for password field');
      return;
    }

    if (passwordInput.value !== STATE.credential.password) {
      passwordInput.focus();
      setInputValue(passwordInput, STATE.credential.password);
      STATE.passwordFilled = passwordInput.value === STATE.credential.password;
      setStatus('Filling Magnific password');
      scheduleAttempt(120);
      return;
    }

    if (Date.now() - STATE.lastSubmitAt < SUBMIT_COOLDOWN_MS) {
      setStatus('Waiting for Magnific sign-in');
      return;
    }

    const submitButton = findLoginSubmitButton(null, passwordInput, { includeDisabled: true });
    if (submitButton && isDisabled(submitButton)) {
      setStatus('Waiting for Magnific log-in button');
      scheduleAttempt(150);
      return;
    }

    STATE.lastSubmitAt = Date.now();
    STATE.passwordFilled = true;
    setStatus('Submitting Magnific login');
    submitLogin(null, passwordInput, submitButton);
    return;
  }

  if (!hasCredentialInputs) {
    if (isGoogleCredential() && googleLoginAction) {
      if (Date.now() - STATE.lastLoginOpenAt < LOGIN_OPEN_COOLDOWN_MS) {
        setStatus('Waiting for Google sign-in');
        scheduleAttempt(400);
        return;
      }

      STATE.lastLoginOpenAt = Date.now();
      setStatus('Opening Google sign-in');
      clickGoogleLoginAction(googleLoginAction);
      scheduleAttempt(700);
      return;
    }

    const loginAction = emailChooserVisible
      ? (isGoogleCredential() ? null : (emailChooserAction || findLoginOpenAction()))
      : (genericLoginAction || findLoginOpenAction());
    if (!loginAction) {
      setStatus(isGoogleCredential() ? 'Waiting for Google sign-in option' : 'Waiting for Magnific login form');
      return;
    }

    const loginActionText = actionText(loginAction);
    const chooserDelay = loginActionText.includes('continue with email') || loginActionText.includes('use email')
      ? 350
      : LOGIN_OPEN_COOLDOWN_MS;
    const actionCooldown = loginActionText.includes('continue with email') || loginActionText.includes('use email')
      ? 700
      : LOGIN_OPEN_COOLDOWN_MS;

    if (Date.now() - STATE.lastLoginOpenAt < actionCooldown) {
      setStatus('Waiting for login form to open');
      scheduleAttempt(Math.min(chooserDelay, 400));
      return;
    }

    STATE.lastLoginOpenAt = Date.now();
    setStatus(emailChooserAction ? 'Opening email login form' : 'Opening login form');
    clickElement(loginAction);
    scheduleAttempt(chooserDelay);
    return;
  }

  if (!STATE.credential?.loginIdentifier || (!STATE.credential?.password && !isGoogleCredential())) {
    setStatus('Waiting for credential');
    return;
  }

  if (isGoogleCredential()) {
    if (hasCredentialInputs && !googleLoginAction && backAction) {
      if (Date.now() - STATE.lastBackNavigationAt < LOGIN_OPEN_COOLDOWN_MS) {
        setStatus('Waiting to return to sign-in options');
        scheduleAttempt(400);
        return;
      }

      STATE.lastBackNavigationAt = Date.now();
      setStatus('Returning to sign-in options');
      clickElement(backAction);
      scheduleAttempt(700);
      return;
    }

    if (googleLoginAction) {
      if (Date.now() - STATE.lastLoginOpenAt < LOGIN_OPEN_COOLDOWN_MS) {
        setStatus('Waiting for Google sign-in');
        scheduleAttempt(400);
        return;
      }

      STATE.lastLoginOpenAt = Date.now();
      setStatus('Opening Google sign-in');
      clickGoogleLoginAction(googleLoginAction);
      scheduleAttempt(700);
      return;
    }

    setStatus('Waiting for Google sign-in option');
    scheduleAttempt(500);
    return;
  }

  if (signUpFormVisible) {
    if (STATE.switchingToLoginUntil > Date.now()) {
      setStatus('Waiting for Magnific log-in form');
      scheduleAttempt(400);
      return;
    }

    const existingAccountAction = findExistingAccountAction(emailInput, passwordInput);
    if (existingAccountAction) {
      STATE.lastSubmitAt = 0;
      STATE.switchingToLoginUntil = Date.now() + 5000;
      setStatus('Switching to Magnific log-in form');
      clickElement(existingAccountAction);
      scheduleAttempt(400);
      return;
    }
    setStatus('Waiting for Magnific log-in form');
    scheduleAttempt(400);
    return;
  }

  if (STATE.switchingToLoginUntil && STATE.switchingToLoginUntil <= Date.now()) {
    STATE.switchingToLoginUntil = 0;
  }

  if (unknownCredentialSurface) {
    setStatus('Waiting for Magnific form to stabilize');
    scheduleAttempt(500);
    return;
  }

  if (emailInput && !isVisible(emailInput)) {
    setStatus('Waiting for email field');
    return;
  }

  if (passwordInput && !isVisible(passwordInput)) {
    setStatus('Waiting for password field');
    return;
  }

  let filledCredentialField = false;
  if (emailInput.value !== STATE.credential.loginIdentifier) {
    emailInput.focus();
    setInputValue(emailInput, STATE.credential.loginIdentifier);
    filledCredentialField = true;
  }

  if (passwordInput.value !== STATE.credential.password) {
    passwordInput.focus();
    setInputValue(passwordInput, STATE.credential.password);
    STATE.passwordFilled = passwordInput.value === STATE.credential.password;
    filledCredentialField = true;
  }

  if (filledCredentialField) {
    setStatus('Filling Magnific login form');
    scheduleAttempt(120);
    return;
  }

  if (!isReadyForSubmit(emailInput, passwordInput)) {
    setStatus('Filling Magnific login form');
    scheduleAttempt(150);
    return;
  }

  if (Date.now() - STATE.lastSubmitAt < SUBMIT_COOLDOWN_MS) {
    setStatus('Waiting for Magnific sign-in');
    return;
  }

  const submitButton = findLoginSubmitButton(emailInput, passwordInput, { includeDisabled: true });
  if (submitButton && isDisabled(submitButton)) {
    setStatus('Waiting for Magnific log-in button');
    scheduleAttempt(150);
    return;
  }

  STATE.lastSubmitAt = Date.now();
  STATE.passwordFilled = true;
  setStatus('Submitting Magnific login');
  submitLogin(emailInput, passwordInput, submitButton);
}

function runAttempt() {
  STATE.scheduledTimer = null;
  if (STATE.stopped) return;

  const now = Date.now();
  if (now - STATE.lastRunAt < MIN_RUN_GAP_MS) {
    scheduleAttempt(MIN_RUN_GAP_MS - (now - STATE.lastRunAt));
    return;
  }

  STATE.lastRunAt = now;

  try {
    attemptFlow();
  } catch (error) {
    stop(`Script error: ${error?.message || 'Unknown error'}`);
  }
}

function scheduleAttempt(delay = 0) {
  if (STATE.stopped || STATE.scheduledTimer) return;
  STATE.scheduledTimer = window.setTimeout(runAttempt, Math.max(0, delay));
}

function start() {
  ensureStatusBadge();
  captureLaunchTicket();

  STATE.observer = new MutationObserver(() => scheduleAttempt(450));
  STATE.observer.observe(document.body || document.documentElement, {
    childList: true,
    subtree: true,
  });

  STATE.keepAliveTimer = window.setInterval(() => scheduleAttempt(0), KEEP_ALIVE_MS);

  loadLaunchState()
    .catch(() => {
      STATE.launchChecked = true;
      STATE.launchAuthorized = false;
    })
    .finally(() => {
      if (window.location.href !== LOGIN_URL && window.location.pathname === '/') {
        setStatus('Opening Magnific login page');
        window.location.replace(LOGIN_URL);
        return;
      }
      scheduleAttempt(0);
    });
}

start();

// ============================================================================
// Generation capture (Phase 2/5 of the Freepik Generation Capture System) -
// see backend/providers/freepik/CAPTURE_CONTRACT.md. Two independent pieces,
// both isolated-world:
//
// 1. A relay for content-freepik-network.js's (MAIN world) intercepted
//    "my creations" / generation-submit responses - organic traffic only,
//    never reconciliation, reported with is_reconciliation=false.
// 2. A bounded reconciliation walker that learns the listing endpoint's URL
//    shape from that same organic traffic (this codebase has never seen a
//    confirmed request URL, only the response shape - see
//    content-freepik-network.js's top comment) and pages forward through it
//    a few pages at a time using the tab's own authenticated session
//    (fetch() from an isolated-world content script carries the page's
//    cookies for same-origin requests, so no separate credential is needed
//    here - matches the "no server-side Freepik credential exists" design
//    decision in the architecture plan).
//
// Deliberately independent of the autologin STATE machine above - neither
// piece touches STATE or any of the DOM-automation helpers, so a bug here
// cannot regress the login flow and vice versa.
// ============================================================================

const FREEPIK_SYNC_STORAGE_KEY = 'rmw_freepik_sync_state';
const FREEPIK_RECONCILIATION_WALK_PAGES_PER_RUN = 3;
const FREEPIK_RECONCILIATION_MIN_GAP_MS = 20 * 60 * 1000; // one walk per tab per ~20 min

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

async function getFreepikSyncState() {
  const stored = await chromeStorageGet([FREEPIK_SYNC_STORAGE_KEY]);
  return stored[FREEPIK_SYNC_STORAGE_KEY] || {};
}

async function patchFreepikSyncState(patch) {
  const current = await getFreepikSyncState();
  const next = { ...current, ...patch };
  await chromeStorageSet({ [FREEPIK_SYNC_STORAGE_KEY]: next });
  return next;
}

function buildFreepikListingUrlForPage(templateUrl, page) {
  try {
    const url = new URL(templateUrl, window.location.href);
    url.searchParams.set('page', String(page));
    return url.toString();
  } catch {
    return null;
  }
}

async function reportFreepikGenerationRow(row, { isReconciliation }) {
  const creation = (row && row.creation) || {};
  const creationId = creation.id !== undefined && creation.id !== null ? String(creation.id) : '';
  const identifier = creation.identifier ? String(creation.identifier) : '';
  // MUST change whenever the row's actual content changes (e.g. a
  // "processing" generation later becoming "completed" with a real image),
  // or the server's (provider, credential, client_event_id) idempotency key
  // treats the updated snapshot as an exact duplicate of the first one and
  // never re-normalizes it - silently freezing the row at its earliest
  // (often image-less) state forever. This was the real bug behind
  // "captured generations stuck with no preview": client_event_id used to be
  // a pure function of creation_id alone. row.updated_at (falling back to
  // creation.updated_at, then status) changes any time Freepik's own record
  // for this creation actually changes, while staying identical across a
  // pure re-poll of unchanged data - so a genuine no-op repeat still
  // correctly collapses server-side, but a real state transition doesn't.
  const changeToken = row?.updated_at || creation?.updated_at || creation?.status || 'unknown';
  const clientEventId = `freepik:${creationId || identifier || `rand:${Math.random().toString(36).slice(2)}`}:${changeToken}`;
  try {
    // sendRuntimeMessage() never rejects (see its own definition) - it
    // always resolves, even on failure ({ok:false, error}) - so the actual
    // result must be inspected explicitly here, or a failure (e.g. no
    // resolvable ticket/session, backend rejection) is silently invisible.
    const result = await sendRuntimeMessage({
      type: 'FREEPIK_CAPTURE_EVENT',
      event: {
        event_type: 'generation_listing_row',
        client_event_id: clientEventId,
        creation_id: creationId || null,
        family_id: creation.family ? String(creation.family) : null,
        is_reconciliation: Boolean(isReconciliation),
        payload: row,
        capture_version: 1,
        // Task/Client Mapping - only ever present for a live-capture row
        // belonging to the currently-armed session (reconciliation rows
        // never have one, since they aren't the result of a gated click at
        // all).
        linked_task_id: !isReconciliation && freepikActiveGeneration ? freepikActiveGeneration.taskId : null,
        linked_client_id: !isReconciliation && freepikActiveGeneration ? freepikActiveGeneration.clientId : null,
      },
    });
    if (result?.ok) {
      console.debug('[RMW Freepik Capture] reported generation row', { creationId, isReconciliation, queued: result.queued });
      // "Queued", not "Saved" - result.ok only confirms the local background
      // queue accepted it; the actual server upload happens later via the
      // batched flush (best-effort, see background-freepik-capture.js), with
      // no feedback channel back to this specific content script call. Never
      // claim a stronger confirmation than what's actually known - "Capture
      // complete ✓" (shown on disarm) is the honest final state for this badge.
      if (!isReconciliation) setFreepikCaptureStatus('Queued for upload…');
    } else {
      console.warn('[RMW Freepik Capture] failed to report generation row', { creationId, isReconciliation, error: result?.error });
      if (!isReconciliation) setFreepikCaptureStatus(`Capture failed: ${result?.error || 'unknown error'}`, { autoHideMs: 8000 });
    }
  } catch (error) {
    console.warn('[RMW Freepik Capture] unexpected error reporting generation row', { creationId, error: error?.message || error });
  }
}

// ----------------------------------------------------------------------------
// Live-capture state machine (architecture redesign - replaces the old
// timestamp-freshness heuristic entirely).
//
// The old design asked "does this row look recent?" - a leaky proxy for
// intent that a page reload, gallery scroll, pagination, or background
// re-poll can all satisfy without the user having generated anything. The
// right question is "did we just watch this specific user click Generate,
// and is this row the result of THAT action?" - answered by observing intent
// directly (a real DOM click) instead of inferring it from data shape.
//
// This mirrors content-kling.js's USAGE_CTX.activeGeneration pattern
// (generateIntentId/startedAt/expiresAt, armed by generic button-text
// click-detection, validated by isActiveGenerationValid-style expiry
// checks) - already proven in production for Kling, ported here rather than
// invented fresh. See the architecture plan for the full rationale.
// ----------------------------------------------------------------------------

const FREEPIK_ARM_MAX_DURATION_MS = 10 * 60 * 1000; // generous for slow "auto" renders
const FREEPIK_ARM_QUIET_PERIOD_MS = 90 * 1000; // disarm 90s after the last qualifying row
const FREEPIK_CLOCK_SKEW_SLACK_MS = 60 * 1000;
const FREEPIK_LAST_LIVE_CAPTURED_AT_KEY = 'rmw_freepik_last_live_captured_at';

// { generateIntentId, armedAt, expiresAt, capturedCreationIds: Map<string, {settled}> }
// null when Idle - this IS the state machine; there is no separate "state" enum,
// armed-ness is simply "this is non-null and not expired" (isFreepikGenerationArmed).
let freepikActiveGeneration = null;
let freepikArmQuietTimer = null;
let freepikArmMaxTimer = null;
// In-memory mirror of a persisted (chrome.storage.local) watermark - satisfies
// the explicit "generation timestamp is newer than the last captured
// generation" rule independently of arming, so even a wrongly-armed session
// cannot re-capture something we've already captured and moved past.
let freepikLastLiveCapturedAt = 0;

chromeStorageGet([FREEPIK_LAST_LIVE_CAPTURED_AT_KEY]).then((stored) => {
  freepikLastLiveCapturedAt = Number(stored[FREEPIK_LAST_LIVE_CAPTURED_AT_KEY] || 0);
});

function persistFreepikLastLiveCapturedAt(timestampMs) {
  if (!(timestampMs > freepikLastLiveCapturedAt)) return;
  freepikLastLiveCapturedAt = timestampMs;
  chromeStorageSet({ [FREEPIK_LAST_LIVE_CAPTURED_AT_KEY]: timestampMs }).catch(() => {});
}

// ---- On-page live-capture status badge (separate from the autologin status
// badge above - this one reflects generation-capture progress, not login) ----

let freepikCaptureStatusHideTimer = null;

function ensureFreepikCaptureStatusBadge() {
  const existing = document.getElementById('rmw-freepik-capture-status');
  if (existing) return existing;
  const badge = document.createElement('div');
  badge.id = 'rmw-freepik-capture-status';
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

function setFreepikCaptureStatus(message, { autoHideMs } = {}) {
  const badge = ensureFreepikCaptureStatusBadge();
  badge.textContent = `Freepik capture\n${message}`;
  badge.style.display = 'block';
  if (freepikCaptureStatusHideTimer) {
    window.clearTimeout(freepikCaptureStatusHideTimer);
    freepikCaptureStatusHideTimer = null;
  }
  if (autoHideMs) {
    freepikCaptureStatusHideTimer = window.setTimeout(() => { badge.style.display = 'none'; }, autoHideMs);
  }
}

function hideFreepikCaptureStatus() {
  const badge = document.getElementById('rmw-freepik-capture-status');
  if (badge) badge.style.display = 'none';
}

// ---- Arm/disarm ----

function clearFreepikArmTimers() {
  if (freepikArmQuietTimer) { window.clearTimeout(freepikArmQuietTimer); freepikArmQuietTimer = null; }
  if (freepikArmMaxTimer) { window.clearTimeout(freepikArmMaxTimer); freepikArmMaxTimer = null; }
}

// Visible confirmation that the popup's answer actually reached this
// generation - without this the task/client attachment is only provable by
// checking the database, which isn't useful feedback for the person who just
// picked one. Empty string when neither was selected, so the plain
// "Waiting for generation…" / "Capture complete" text is left unchanged.
function freepikGenerationLinkLabel(generation) {
  if (!generation) return '';
  const parts = [];
  if (generation.taskName) parts.push(`Task: ${generation.taskName}`);
  if (generation.clientName) parts.push(`Client: ${generation.clientName}`);
  return parts.length ? ` (${parts.join(', ')})` : '';
}

function disarmFreepikGeneration() {
  clearFreepikArmTimers();
  const hadCaptures = Boolean(freepikActiveGeneration && freepikActiveGeneration.capturedCreationIds.size > 0);
  const linkLabel = freepikGenerationLinkLabel(freepikActiveGeneration);
  freepikActiveGeneration = null;
  if (hadCaptures) {
    setFreepikCaptureStatus(`Capture complete ✓${linkLabel}`, { autoHideMs: 6000 });
  } else {
    hideFreepikCaptureStatus();
  }
}

function scheduleFreepikArmQuietReset() {
  if (freepikArmQuietTimer) window.clearTimeout(freepikArmQuietTimer);
  freepikArmQuietTimer = window.setTimeout(disarmFreepikGeneration, FREEPIK_ARM_QUIET_PERIOD_MS);
}

function isFreepikGenerationArmed() {
  return Boolean(freepikActiveGeneration) && Date.now() <= freepikActiveGeneration.expiresAt;
}

function armFreepikGeneration() {
  const now = Date.now();
  // Task/Client Mapping: consumed here (one-shot) regardless of which branch
  // below runs - the gate in runFreepikTaskGate() guarantees this is only
  // ever called for a click that just passed (or re-passed, via the bypass)
  // task/client selection, so every arm - fresh or extended - reflects
  // whatever was actually confirmed for THIS click, per the "every single
  // click" rule.
  const pendingSelection = freepikPendingTaskSelection;
  freepikPendingTaskSelection = null;

  if (isFreepikGenerationArmed()) {
    // A second Generate click while still waiting on a prior one (e.g.
    // queued a follow-up before the first finished rendering) extends the
    // existing session rather than resetting capturedCreationIds, so
    // in-flight tracking for the first batch isn't lost.
    if (pendingSelection) {
      freepikActiveGeneration.taskId = pendingSelection.taskId;
      freepikActiveGeneration.taskName = pendingSelection.taskName;
      freepikActiveGeneration.clientId = pendingSelection.clientId;
      freepikActiveGeneration.clientName = pendingSelection.clientName;
    }
    scheduleFreepikArmQuietReset();
    setFreepikCaptureStatus(`Waiting for generation…${freepikGenerationLinkLabel(freepikActiveGeneration)}`);
    return;
  }
  clearFreepikArmTimers();
  freepikActiveGeneration = {
    generateIntentId: `fpgen_${now}_${Math.random().toString(36).slice(2, 8)}`,
    armedAt: now,
    expiresAt: now + FREEPIK_ARM_MAX_DURATION_MS,
    capturedCreationIds: new Map(),
    taskId: pendingSelection?.taskId ?? null,
    taskName: pendingSelection?.taskName ?? null,
    clientId: pendingSelection?.clientId ?? null,
    clientName: pendingSelection?.clientName ?? null,
  };
  freepikArmMaxTimer = window.setTimeout(disarmFreepikGeneration, FREEPIK_ARM_MAX_DURATION_MS);
  scheduleFreepikArmQuietReset();
  setFreepikCaptureStatus(`Waiting for generation…${freepikGenerationLinkLabel(freepikActiveGeneration)}`);
  console.debug('[RMW Freepik Capture] armed', {
    generateIntentId: freepikActiveGeneration.generateIntentId,
    taskId: freepikActiveGeneration.taskId,
    clientId: freepikActiveGeneration.clientId,
  });
}

// ---- Generic "was this click a Generate action" detector - ports
// content-kling.js's collectInteractionCandidateElements/findClickableAncestor/
// buttonDescriptorText pattern. isVisible/isDisabled/isActionLikeElement/
// ACTION_SELECTORS are this file's own, already used by the autologin flow
// above - reused as-is, not duplicated.
//
// Deliberately does NOT reuse findClickableAncestor's own ancestor-walk here,
// even though the two look similar: findClickableAncestor treats any
// tabIndex>=0 element as "clickable" (every textarea/input qualifies by
// default) and, if nothing better is found up the tree, falls back to
// returning the raw clicked element itself. That's an acceptable trade-off
// for the passive capture-arm heuristic below (a false positive just widens
// a watch window), but this result also gates a real click - a false
// positive here blocks a normal interaction. Concretely: clicking back into
// the prompt textarea once it already contains the word "generate" (e.g.
// "generate the video of...") would match, because findClickableAncestor's
// fallback returns the textarea itself and freepikButtonDescriptorText used
// to read element.value. So this walk only ever accepts a real
// button/link/role=button ancestor - never a form field, never a fallback to
// the raw clicked node - and its text reader no longer looks at .value.

const FREEPIK_GATE_EXCLUDED_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT', 'OPTION']);

function findFreepikGenerateButtonAncestor(element) {
  let current = element;
  while (current && current !== document.body) {
    if (
      !FREEPIK_GATE_EXCLUDED_TAGS.has(current.tagName)
      && current.matches?.(ACTION_SELECTORS)
      && isVisible(current)
      && !isDisabled(current)
    ) {
      return current;
    }
    current = current.parentElement;
  }
  return null;
}

function collectFreepikInteractionCandidateElements(target) {
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

function freepikButtonDescriptorText(element) {
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

function findFreepikGenerateActionTarget(target) {
  const candidates = collectUniqueElements(
    collectFreepikInteractionCandidateElements(target).map((element) => findFreepikGenerateButtonAncestor(element))
  );
  for (const candidate of candidates) {
    if (!candidate) continue;
    const text = freepikButtonDescriptorText(candidate);
    if (!text || text.length > 60) continue;
    if (!/(^|\s)generate($|\s)/i.test(text)) continue;
    return candidate;
  }
  return null;
}

// ---- Task Mapping: Generation Interceptor ----
//
// Every real Generate click must have an active task selected first (see
// content-freepik-task-modal.js). blockPasswordToggleEvent() above proves
// this exact technique - preventDefault/stopPropagation/stopImmediatePropagation
// from a capturing-phase document listener - already reliably vetoes a real
// page-native click on freepik.com, so it's reused here rather than inventing
// new interception machinery.
//
// A click that passes the gate is re-dispatched (target.click()) so Freepik's
// own handler still runs exactly as it did before this feature existed; the
// one-shot bypass below is what lets that SECOND, synthetic click through
// this same listener without looping back into the modal.
let freepikTaskGateBypassTarget = null;
let freepikTaskGateModalOpen = false;
let freepikPendingTaskSelection = null; // {taskId, taskName, clientId, clientName} - consumed by armFreepikGeneration()

async function runFreepikTaskGate(target) {
  if (freepikTaskGateModalOpen) return; // double-click Generate while the modal is already open - no-op
  freepikTaskGateModalOpen = true;
  try {
    const selection = await openFreepikTaskSelectionModal();
    if (!selection) return; // cancelled/ESC/no active tasks - click stays blocked
    freepikPendingTaskSelection = selection;
    freepikTaskGateBypassTarget = target;
    target.click();
  } finally {
    freepikTaskGateModalOpen = false;
  }
}

document.addEventListener('click', (event) => {
  try {
    const target = findFreepikGenerateActionTarget(event.target);
    if (target) {
      if (freepikTaskGateBypassTarget === target) {
        freepikTaskGateBypassTarget = null; // one-shot: next Generate click gates again
        armFreepikGeneration();
        return; // let the (re-dispatched) click reach Freepik's own handler
      }

      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      runFreepikTaskGate(target);
      return;
    }

    // Download gate (added 2026-08-06) - checked only when this click wasn't
    // already a Generate click, same "block the real click, open the
    // picker, re-dispatch a synthetic bypass click" technique, own state so
    // the two gates never interfere with each other. See this file's
    // "Download capture" section further down for
    // findFreepikDownloadActionTarget/runFreepikDownloadTaskGate.
    const downloadTarget = findFreepikDownloadActionTarget(event.target);
    if (downloadTarget) {
      if (freepikDownloadTaskGateBypassTarget === downloadTarget) {
        freepikDownloadTaskGateBypassTarget = null; // one-shot: next Download click gates again
        return; // already reported (see runFreepikDownloadTaskGate) - let the re-dispatched click reach Freepik's own handler
      }

      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      runFreepikDownloadTaskGate(downloadTarget);
    }
  } catch {}
}, true); // capturing phase - fires even if the page's own handler stops propagation

// ---- Qualifying-row evaluation: the ONLY gate for the live-capture path ----

function getFreepikRowTimestampMs(row) {
  const raw = row?.updated_at || row?.created_at || row?.creation?.updated_at || row?.creation?.created_at;
  if (!raw) return null;
  const parsed = Date.parse(raw);
  return Number.isNaN(parsed) ? null : parsed;
}

function isFreepikRowSettled(row) {
  const creation = row?.creation || {};
  const status = `${creation.status || ''}`.toLowerCase();
  if (status === 'completed' || status === 'failed') return true;
  // Defensive fallback if status is missing/unrecognized on some response
  // shape we haven't seen yet: treat "has an actual asset URL" as settled.
  return Boolean(
    row?.thumbnail?.url || row?.download_url
    || creation.preview || creation.large_preview || creation.raw || creation.url
  );
}

// Tracks creation_ids that have already been captured live (via an armed
// session) but were still rendering ("processing", no asset URL) at
// capture time - deliberately INDEPENDENT of the arm/quiet-period timeout.
//
// Without this, a render that takes longer than FREEPIK_ARM_QUIET_PERIOD_MS
// (90s) - entirely plausible, some models take tens of seconds - would
// disarm before the completed version (with the real image) ever arrives.
// The new design correctly refuses to look at ANYTHING while un-armed (that
// is the actual fix for the mis-attribution bug), but "is this a brand-new
// creation_id safe to treat as live" and "keep watching for the completion
// of a row I already know is legitimately mine" are two different
// questions - only the first one should be gated by arming. This map
// answers the second, with its own much longer window.
const freepikPendingSettlement = new Map(); // creationId -> { expiresAt }
const FREEPIK_PENDING_SETTLEMENT_MAX_MS = 20 * 60 * 1000; // generous - some models render slowly

function evaluateFreepikRowForLiveCapture(row, transport) {
  const creationId = row?.creation?.id !== undefined && row.creation.id !== null ? String(row.creation.id) : '';
  if (!creationId) return { qualifies: false, reason: 'no_creation_id' };

  const rowTimestampMs = getFreepikRowTimestampMs(row);

  // Case 1: we're already watching this exact creation_id for its
  // completion - this does NOT require currently being armed, since
  // rendering can legitimately outlast the arm/quiet-period window. Also
  // transport-independent on purpose: once a creation_id is legitimately
  // ours (learned from our own direct request below), its completion is
  // expected to arrive over the shared websocket/eventsource push - that's
  // just how Freepik delivers renders, not a new ownership claim.
  const pending = freepikPendingSettlement.get(creationId);
  if (pending) {
    if (Date.now() > pending.expiresAt) {
      freepikPendingSettlement.delete(creationId); // gave up waiting - falls through to normal (armed-only) rules below
    } else {
      return { qualifies: true, creationId, rowTimestampMs, isPendingCompletion: true };
    }
  }

  // Case 2: a brand-new creation_id. Being armed is necessary but NOT
  // sufficient - mirrors content-kling-network.js's approach of trusting an
  // identifier pulled from the request/response pair over a bare time
  // window: Freepik's shared team login means every open tab on the account
  // receives every OTHER employee's completion push too (private-user/
  // private-project Echo channel), so "a new id showed up while I was
  // armed" is not proof *I* caused it - two people generating within the
  // same few minutes on the same login is a realistic, observed case, not a
  // hypothetical. A direct fetch/XHR response, in contrast, only ever
  // reaches the tab that issued the request - see
  // content-freepik-network.js's transport tagging - so only that transport
  // may originate a brand-new claim. A push-only sighting of an unfamiliar
  // creation_id is silently left for the reconciliation walker (unowned)
  // rather than credited to whoever's tab happened to be armed.
  if (transport === 'websocket' || transport === 'eventsource') {
    return { qualifies: false, reason: 'new_id_via_push_channel_not_trusted' };
  }

  if (!isFreepikGenerationArmed()) return { qualifies: false, reason: 'not_armed' };

  const alreadySettled = freepikActiveGeneration.capturedCreationIds.get(creationId)?.settled;
  if (alreadySettled) return { qualifies: false, reason: 'already_settled_this_session' };

  if (rowTimestampMs === null) return { qualifies: false, reason: 'no_timestamp' };
  // Rule: must post-date the click that armed us (a result cannot precede
  // its own cause) - mirrors content-kling.js's assetStartedAfterActiveGeneration.
  if (rowTimestampMs < freepikActiveGeneration.armedAt - FREEPIK_CLOCK_SKEW_SLACK_MS) {
    return { qualifies: false, reason: 'older_than_click' };
  }
  // Rule: must also be newer than the last thing we ever captured live -
  // a monotonicity guard independent of arming (protects against a
  // mis-armed session replaying something already captured and moved past).
  if (freepikLastLiveCapturedAt && rowTimestampMs <= freepikLastLiveCapturedAt - FREEPIK_CLOCK_SKEW_SLACK_MS) {
    return { qualifies: false, reason: 'not_newer_than_watermark' };
  }
  return { qualifies: true, creationId, rowTimestampMs };
}

function onFreepikNetworkMessage(event) {
  if (event.source !== window) return;
  const data = event.data;
  if (!data || data.source !== 'rmw-freepik-network-telemetry' || data.type !== 'FREEPIK_NETWORK_GENERATION') return;
  const rows = data.payload && Array.isArray(data.payload.rows) ? data.payload.rows : [];
  const sourceUrl = (data.payload && data.payload.sourceUrl) || '';
  const transport = (data.payload && data.payload.transport) || 'http';

  rows.forEach((row) => {
    const evaluation = evaluateFreepikRowForLiveCapture(row, transport);
    if (!evaluation.qualifies) {
      // Not reported AT ALL by this path - an un-armed (or otherwise
      // non-qualifying) observation is history, and history is exclusively
      // the reconciliation walker's job below, never this organic path's.
      // This is the actual architectural fix: the old design still sent (or
      // at best silently dropped after evaluating) rows based on a
      // timestamp guess; this design never even considers sending one
      // unless a real click armed us for it.
      console.debug('[RMW Freepik Capture] ignored non-qualifying row (not a live generation)', {
        creationId: row?.creation?.id, reason: evaluation.reason,
      });
      return;
    }

    const settled = isFreepikRowSettled(row);

    // A pending-completion match can legitimately arrive while disarmed
    // (that's the entire point of freepikPendingSettlement) - only touch
    // the active arm session's own bookkeeping if one actually exists.
    if (freepikActiveGeneration && isFreepikGenerationArmed()) {
      freepikActiveGeneration.capturedCreationIds.set(evaluation.creationId, { settled });
      scheduleFreepikArmQuietReset(); // this counts as recent activity - extend the window
    }

    if (settled) {
      freepikPendingSettlement.delete(evaluation.creationId);
    } else {
      // Not settled yet - keep watching for this specific creation_id's
      // completion independently of arm/quiet-period state (see
      // freepikPendingSettlement's docstring above evaluateFreepikRowForLiveCapture).
      freepikPendingSettlement.set(evaluation.creationId, { expiresAt: Date.now() + FREEPIK_PENDING_SETTLEMENT_MAX_MS });
    }

    persistFreepikLastLiveCapturedAt(evaluation.rowTimestampMs);
    setFreepikCaptureStatus(settled ? 'Capturing…' : 'Generation detected — rendering…');
    console.debug('[RMW Freepik Capture] qualifying row - reporting as live', {
      creationId: evaluation.creationId, settled, isPendingCompletion: Boolean(evaluation.isPendingCompletion),
    });
    reportFreepikGenerationRow(row, { isReconciliation: false });
  });

  // Still needed regardless of arming: this is how the reconciliation
  // walker below learns the listing endpoint's URL shape without it ever
  // being hardcoded (see content-freepik-network.js's top comment).
  if (sourceUrl && /[?&]page=/i.test(sourceUrl)) {
    patchFreepikSyncState({ listingUrlTemplate: sourceUrl, listingUrlObservedAt: Date.now() });
  }
}

window.addEventListener('message', onFreepikNetworkMessage);

async function runFreepikReconciliationWalk() {
  const state = await getFreepikSyncState();
  const now = Date.now();
  if (state.lastWalkAt && now - state.lastWalkAt < FREEPIK_RECONCILIATION_MIN_GAP_MS) {
    console.debug('[RMW Freepik Sync] walk skipped: ran too recently', { lastWalkAt: state.lastWalkAt });
    return;
  }
  if (!state.listingUrlTemplate) {
    // Nothing observed yet to learn the paginated endpoint's URL shape from -
    // this walker stays a permanent no-op until at least one organic
    // "my creations"-style response with a `page=` query param has been
    // seen (see onFreepikNetworkMessage). If this line keeps showing up,
    // that observation is the thing that's missing, not this walker.
    console.debug('[RMW Freepik Sync] walk skipped: no listing URL learned yet - visit the Creations gallery once');
    return;
  }

  console.debug('[RMW Freepik Sync] starting reconciliation walk', { fromPage: Number(state.lastSyncedPage || 0) + 1, template: state.listingUrlTemplate });
  await patchFreepikSyncState({ lastWalkAt: now });

  let page = Number(state.lastSyncedPage || 0) + 1;
  let lastSeenCreationId = state.lastSeenCreationId || null;
  let pagesWalked = 0;

  for (; pagesWalked < FREEPIK_RECONCILIATION_WALK_PAGES_PER_RUN; pagesWalked++, page++) {
    const pageUrl = buildFreepikListingUrlForPage(state.listingUrlTemplate, page);
    if (!pageUrl) break;

    let json = null;
    try {
      const response = await fetch(pageUrl, { credentials: 'include' });
      if (!response.ok) {
        console.warn('[RMW Freepik Sync] page fetch returned non-OK status, stopping walk', { pageUrl, status: response.status });
        break;
      }
      json = await response.json();
    } catch (error) {
      console.warn('[RMW Freepik Sync] page fetch failed, stopping walk', { pageUrl, error: error?.message || error });
      break;
    }

    const rows = json && Array.isArray(json.data) ? json.data : [];
    if (!rows.length) {
      console.debug('[RMW Freepik Sync] page returned no rows, stopping walk', { pageUrl });
      break;
    }

    for (const row of rows) {
      await reportFreepikGenerationRow(row, { isReconciliation: true });
      const creation = row.creation || {};
      if (creation.id !== undefined && creation.id !== null) lastSeenCreationId = String(creation.id);
    }

    const lastPage = Number((json.meta && json.meta.pagination && json.meta.pagination.last_page) || 0);
    if (lastPage && page >= lastPage) {
      page += 1;
      pagesWalked += 1;
      break;
    }
  }

  console.debug('[RMW Freepik Sync] walk finished', { pagesWalked, lastSyncedPage: page - 1 });
  if (pagesWalked > 0) {
    await patchFreepikSyncState({ lastSyncedPage: page - 1, lastSeenCreationId });
    sendRuntimeMessage({
      type: 'FREEPIK_SYNC_PROGRESS',
      lastSeenCreationId,
      lastSyncedPage: page - 1,
      isFullReconciliation: false,
      status: 'idle',
    }).catch(() => {});
  }
}

// Delayed start: give the page a chance to make its own organic "my
// creations" request first (that's how listingUrlTemplate gets learned) -
// running immediately on every load would just no-op most of the time.
window.setTimeout(() => {
  runFreepikReconciliationWalk().catch(() => {});
}, 15000);

// ============================================================================
// ---- Search + Download capture (added 2026-08-06) ----
//
// Sarbjeet's own ask: freepik.com/magnific.com users don't only generate new
// AI content, they also SEARCH the stock library and DOWNLOAD existing
// (not user-generated) assets - neither has a creation.id, so both route to
// their own backend tables (FreepikSearchQuery/FreepikDownload, never
// FreepikGeneration - see providers/freepik/normalization.py). Two explicit
// design calls Sarbjeet made when asked directly (not guessed):
//   - Download IS gated behind the same mandatory Task/Client picker
//     Generate uses ("what he download for what project" is the whole point).
//   - Search is free-form, never gated - only the eventual download needs
//     project attribution, not the browsing/searching that led to it.
//   - Both apply on freepik.com AND magnific.com (already one shared
//     capture surface - see constants.py's TOOL_SLUGS comment - no manifest
//     change needed, both hosts are already in this file's own matches[]).
//
// Built from a single UI screenshot (magnific.com's stock search results
// page, a hover-card Download icon button on a result card) - not confirmed
// DOM/network structure for either host. Every scraper below is best-effort
// with graceful degradation to null, tighten once real interaction on both
// hosts is observed, same posture every other provider's Phase 1 shipped
// with in this codebase.
// ============================================================================

// ---- Shared: search term / host readers (used by both search capture and
// download's own search_term correlation field) ----

// Common stock-site query param names - magnific.com's own confirmed URL
// (?term=...) is checked first; the others are unconfirmed guesses for
// freepik.com's own search, which hasn't been captured yet. Works out of the
// box if freepik.com happens to use one of these, otherwise this degrades to
// null (no search captured there) rather than a wrong guess.
const FREEPIK_SEARCH_PARAM_NAMES = ['term', 'query', 'q', 'search'];

function readFreepikSearchTermFromUrl(href) {
  try {
    const url = new URL(href || window.location.href);
    for (const name of FREEPIK_SEARCH_PARAM_NAMES) {
      const value = url.searchParams.get(name);
      if (value && value.trim()) return value.trim();
    }
  } catch {}
  return null;
}

function currentFreepikSourceHost() {
  return window.location.hostname.replace(/^www\./, '');
}

// ---- Download capture ----
//
// Reuses findFreepikGenerateButtonAncestor (misnamed but fully generic - it
// only ever walks up to the nearest real button/link/role=button ancestor,
// the "generate" part of its name refers to nothing inside the function
// itself) rather than duplicating the identical ancestor-walk a second time.

function findFreepikDownloadActionTarget(target) {
  const candidates = collectUniqueElements(
    collectFreepikInteractionCandidateElements(target).map((element) => findFreepikGenerateButtonAncestor(element))
  );
  for (const candidate of candidates) {
    if (!candidate) continue;
    const text = freepikButtonDescriptorText(candidate);
    if (!text || text.length > 60) continue;
    if (!/(^|\s)download($|\s)/i.test(text)) continue;
    return candidate;
  }
  return null;
}

// Best-effort scrape of whatever's visible near the clicked Download button
// - unconfirmed DOM structure, see this section's own top comment. Read
// BEFORE the click is re-dispatched (see runFreepikDownloadTaskGate), since
// the click itself may navigate away or alter the DOM.
function collectFreepikDownloadAssetInfo(button) {
  const container = button.closest('[class*="card" i], article, figure') || button.parentElement || button;
  const img = container?.querySelector?.('img[src]');
  const rawTitle = img?.getAttribute('alt') || container?.getAttribute?.('aria-label') || container?.getAttribute?.('title') || null;
  return {
    assetTitle: rawTitle ? String(rawTitle).trim().slice(0, 2000) : null,
    assetThumbnailUrl: img?.getAttribute('src') || null,
    // No confirmed way to read the stock item's own permalink from just the
    // card yet (no visible <a href> reliably pointing at it in the one
    // screenshot this was built from) - left null rather than guess.
    assetSourceUrl: null,
  };
}

async function reportFreepikDownloadClick(assetInfo, selection) {
  const clientEventId = `freepik:download:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
  try {
    const result = await sendRuntimeMessage({
      type: 'FREEPIK_CAPTURE_EVENT',
      event: {
        event_type: 'download_click',
        client_event_id: clientEventId,
        payload: {
          assetTitle: assetInfo.assetTitle,
          assetThumbnailUrl: assetInfo.assetThumbnailUrl,
          assetSourceUrl: assetInfo.assetSourceUrl,
          searchTerm: readFreepikSearchTermFromUrl(window.location.href),
          sourceHost: currentFreepikSourceHost(),
          pageUrl: window.location.href,
          downloadedAt: new Date().toISOString(),
        },
        capture_version: 1,
        linked_task_id: selection?.taskId ?? null,
        linked_client_id: selection?.clientId ?? null,
      },
    });
    if (result?.ok) {
      console.debug('[RMW Freepik Capture] reported download click', { assetTitle: assetInfo.assetTitle, queued: result.queued });
    } else {
      console.warn('[RMW Freepik Capture] failed to report download click', { error: result?.error });
    }
  } catch (error) {
    console.warn('[RMW Freepik Capture] unexpected error reporting download click', { error: error?.message || error });
  }
}

// ---- Task Mapping: Download Interceptor - mirrors runFreepikTaskGate
// exactly (own bypass-target state so the two gates never interfere), except
// the bypass branch reports the download directly instead of arming a
// generation-tracking session - a download's outcome IS the click itself,
// no async multi-second render to wait for the way a generation has. ----
let freepikDownloadTaskGateBypassTarget = null;
let freepikDownloadTaskGateModalOpen = false;

async function runFreepikDownloadTaskGate(target) {
  if (freepikDownloadTaskGateModalOpen) return; // double-click Download while the modal is already open - no-op
  freepikDownloadTaskGateModalOpen = true;
  try {
    const selection = await openFreepikTaskSelectionModal();
    if (!selection) return; // cancelled/ESC/no active tasks - click stays blocked
    const assetInfo = collectFreepikDownloadAssetInfo(target);
    freepikDownloadTaskGateBypassTarget = target;
    reportFreepikDownloadClick(assetInfo, selection);
    target.click();
  } finally {
    freepikDownloadTaskGateModalOpen = false;
  }
}

// ---- Search-query capture ----
//
// Free-form, never gated (see this section's own top comment). URL-param
// based rather than DOM-scraped - the one confirmed real capture
// (magnific.com's own search results page) carries the term directly in the
// URL, far more reliable than guessing a search-input selector across two
// different sites.

function readFreepikResultCountLabel() {
  // Best-effort: the confirmed screenshot showed a plain text node shaped
  // like "28.7k results" near the search box - no confirmed selector, so
  // this scans short leaf text nodes for that exact shape instead of
  // guessing a class name that could easily be wrong on either host.
  const candidates = document.querySelectorAll('body *');
  for (const el of candidates) {
    if (el.childElementCount > 0) continue;
    const text = (el.textContent || '').trim();
    if (!text || text.length > 40) continue;
    if (/^[\d,.]+[km]?\+?\s+results?$/i.test(text)) return text;
  }
  return null;
}

async function reportFreepikSearchQuery(searchTerm) {
  const clientEventId = `freepik:search:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
  try {
    const result = await sendRuntimeMessage({
      type: 'FREEPIK_CAPTURE_EVENT',
      event: {
        event_type: 'search_query',
        client_event_id: clientEventId,
        payload: {
          searchTerm,
          sourceHost: currentFreepikSourceHost(),
          pageUrl: window.location.href,
          resultCountLabel: readFreepikResultCountLabel(),
          searchedAt: new Date().toISOString(),
        },
        capture_version: 1,
      },
    });
    if (result?.ok) {
      console.debug('[RMW Freepik Capture] reported search query', { searchTerm, queued: result.queued });
    } else {
      console.warn('[RMW Freepik Capture] failed to report search query', { searchTerm, error: result?.error });
    }
  } catch (error) {
    console.warn('[RMW Freepik Capture] unexpected error reporting search query', { error: error?.message || error });
  }
}

const FREEPIK_SEARCH_REPORT_DEBOUNCE_MS = 1500;
let freepikLastReportedSearchTerm = null;
let freepikSearchReportTimer = null;

function checkFreepikSearchTermChanged() {
  const term = readFreepikSearchTermFromUrl(window.location.href);
  if (!term || term === freepikLastReportedSearchTerm) return;
  if (freepikSearchReportTimer) window.clearTimeout(freepikSearchReportTimer);
  freepikSearchReportTimer = window.setTimeout(() => {
    freepikSearchReportTimer = null;
    // Re-check immediately before firing - the debounce window means the
    // URL (and result count label) could have already changed again by the
    // time this fires, e.g. mid-typing in a live-search box.
    const latestTerm = readFreepikSearchTermFromUrl(window.location.href);
    if (!latestTerm || latestTerm === freepikLastReportedSearchTerm) return;
    freepikLastReportedSearchTerm = latestTerm;
    reportFreepikSearchQuery(latestTerm);
  }, FREEPIK_SEARCH_REPORT_DEBOUNCE_MS);
}

// SPA URL-change detection via polling, not a history.pushState/replaceState
// monkey-patch: this file runs in the ISOLATED world (see manifest.json),
// which has its own separate `window`/`history` objects from the MAIN world
// the page's own React/SPA router actually calls into - patching
// history.pushState here would silently never fire, since it patches a
// completely different function reference than the one the page calls (see
// content-freepik-network.js's own MAIN-world placement for why THAT file
// can patch window.fetch but this one structurally cannot patch history the
// same way). A plain interval poll of window.location.href sidesteps the
// cross-world problem entirely; popstate is kept alongside it purely as a
// faster (not more reliable) path for actual back/forward navigation.
const FREEPIK_URL_POLL_MS = 1000;
let freepikLastSeenHref = window.location.href;

function checkFreepikUrlChanged() {
  if (window.location.href === freepikLastSeenHref) return;
  freepikLastSeenHref = window.location.href;
  checkFreepikSearchTermChanged();
}

window.addEventListener('popstate', checkFreepikUrlChanged);
window.setInterval(checkFreepikUrlChanged, FREEPIK_URL_POLL_MS);
checkFreepikSearchTermChanged(); // covers a page opened directly on a search URL, not navigated to from within the SPA
