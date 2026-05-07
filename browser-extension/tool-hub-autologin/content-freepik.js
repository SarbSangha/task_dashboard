const TOOL_SLUG = 'freepik';
const LOGIN_URL = 'https://www.magnific.com/log-in?client_id=magnific&lang=en';
const SIGNUP_URL_PATH_FRAGMENT = '/sign-up';
const PREPARED_LAUNCH_KEY = 'rmw_freepik_prepared_launch';
const BLOCKED_NOTICE_KEY = 'rmw_freepik_blocked_notice';
const EXTENSION_TICKET_KEY = 'rmw_extension_ticket';

const MIN_RUN_GAP_MS = 400;
const KEEP_ALIVE_MS = 2000;
const LOGIN_OPEN_COOLDOWN_MS = 2500;
const SUBMIT_COOLDOWN_MS = 5000;
const PASSWORD_PROMPT_RESTORE_DELAY_MS = 8000;

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
  passwordSavingInFlight: false,
  passwordSavingSuppressed: false,
  passwordSavingRestoreTimer: null,
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
  releasePasswordSavingSuppressed(0);
  setStatus(message);
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
  setStatus('Disabling Chrome password-save prompt');

  ensurePasswordSavingSuppressed()
    .then((ok) => {
      STATE.passwordSavingInFlight = false;
      if (!ok) {
        stop('Blocked: Chrome password-save prompt could not be disabled.');
        return;
      }
      scheduleAttempt(50);
    })
    .catch((error) => {
      STATE.passwordSavingInFlight = false;
      stop(`Blocked: ${error?.message || 'Could not disable Chrome password-save prompt.'}`);
    });
}

function releasePasswordSavingSuppressed(delay = 0) {
  if (STATE.passwordSavingRestoreTimer) {
    window.clearTimeout(STATE.passwordSavingRestoreTimer);
    STATE.passwordSavingRestoreTimer = null;
  }

  if (!STATE.passwordSavingSuppressed && delay <= 0) {
    return;
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

function clearPageStorage() {
  const preparedLaunch = getPreparedLaunchKey();
  try {
    window.localStorage.clear();
  } catch {}
  try {
    const blockedNotice = window.sessionStorage.getItem(BLOCKED_NOTICE_KEY);
    const extensionTicket = window.sessionStorage.getItem(EXTENSION_TICKET_KEY);
    window.sessionStorage.clear();
    if (preparedLaunch) {
      window.sessionStorage.setItem(PREPARED_LAUNCH_KEY, preparedLaunch);
    }
    if (blockedNotice) {
      window.sessionStorage.setItem(BLOCKED_NOTICE_KEY, blockedNotice);
    }
    if (extensionTicket) {
      window.sessionStorage.setItem(EXTENSION_TICKET_KEY, extensionTicket);
    }
  } catch {}
  if (preparedLaunch) {
    try { window.localStorage.setItem(PREPARED_LAUNCH_KEY, preparedLaunch); } catch {}
    try { window.sessionStorage.setItem(PREPARED_LAUNCH_KEY, preparedLaunch); } catch {}
  }
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
  if (!passwordInput) return;
  enforcePasswordMask(passwordInput);
  ensurePasswordRevealGuard();

  findPasswordToggleCandidates(passwordInput).forEach((toggle) => {
    if (!toggle || toggle.dataset.rmwPasswordToggleLocked === '1') return;

    toggle.dataset.rmwPasswordToggleLocked = '1';
    toggle.setAttribute('aria-disabled', 'true');
    toggle.setAttribute('tabindex', '-1');
    if ('disabled' in toggle) {
      try {
        toggle.disabled = true;
      } catch {}
    }
    toggle.style.pointerEvents = 'none';
    toggle.style.opacity = '0.45';

    const blockToggle = (event) => blockPasswordToggleEvent(event, passwordInput);
    ['click', 'mousedown', 'mouseup', 'pointerdown', 'pointerup', 'touchstart', 'touchend', 'keydown', 'keyup']
      .forEach((eventName) => toggle.addEventListener(eventName, blockToggle, true));
  });
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
  if (passwordInput.dataset.rmwPasswordProtected === '1') return;

  passwordInput.dataset.rmwPasswordProtected = '1';
  passwordInput.setAttribute('autocomplete', 'off');
  passwordInput.setAttribute('spellcheck', 'false');

  const collapseSelection = () => {
    try {
      const length = `${passwordInput.value || ''}`.length;
      passwordInput.setSelectionRange(length, length);
    } catch {}
  };

  const blockEvent = (event) => {
    collapseSelection();
    event.preventDefault();
    event.stopImmediatePropagation();
    event.stopPropagation();
  };

  passwordInput.addEventListener('copy', blockEvent, true);
  passwordInput.addEventListener('cut', blockEvent, true);
  passwordInput.addEventListener('contextmenu', blockEvent, true);
  passwordInput.addEventListener('dragstart', blockEvent, true);
  passwordInput.addEventListener('select', collapseSelection, true);
  passwordInput.addEventListener('mouseup', collapseSelection, true);

  passwordInput.addEventListener('keydown', (event) => {
    const key = `${event.key || ''}`.toLowerCase();
    if ((event.ctrlKey || event.metaKey) && ['a', 'c', 'x'].includes(key)) {
      blockEvent(event);
      return;
    }

    if (event.shiftKey && ['arrowleft', 'arrowright', 'home', 'end'].includes(key)) {
      blockEvent(event);
    }
  }, true);

  collapseSelection();
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
  if (clickElement(submitButton)) return true;
  if (submitNearestForm(passwordInput || emailInput)) return true;
  return pressEnter(passwordInput || emailInput);
}

async function clearToolSession(options = {}) {
  clearPageStorage();
  await sendRuntimeMessage({
    type: 'TOOL_HUB_CLEAR_TOOL_SESSION',
    toolSlug: TOOL_SLUG,
    preserveLaunch: Boolean(options.preserveLaunch),
  });
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
    await clearToolSession();
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

  await clearToolSession({ preserveLaunch: true });
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
    lockPasswordVisibility(passwordInput);
    protectPasswordField(passwordInput);
  }

  if (!STATE.credential) {
    requestCredential();
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

  if (emailInput.value !== STATE.credential.loginIdentifier) {
    emailInput.focus();
    setInputValue(emailInput, STATE.credential.loginIdentifier);
  }

  if (passwordInput.value !== STATE.credential.password) {
    if (!STATE.passwordSavingSuppressed) {
      requestPasswordSavingSuppression();
      return;
    }
    passwordInput.focus();
    setInputValue(passwordInput, STATE.credential.password);
  }

  if (!isReadyForSubmit(emailInput, passwordInput)) {
    setStatus('Filling Magnific login form');
    return;
  }

  if (Date.now() - STATE.lastSubmitAt < SUBMIT_COOLDOWN_MS) {
    setStatus('Waiting for Magnific sign-in');
    return;
  }

  const submitButton = findLoginSubmitButton(emailInput, passwordInput);
  STATE.lastSubmitAt = Date.now();
  setStatus('Submitting Magnific login');
  submitLogin(emailInput, passwordInput, submitButton);
  releasePasswordSavingSuppressed(PASSWORD_PROMPT_RESTORE_DELAY_MS);
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
