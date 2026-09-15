const TOOL_SLUG = 'figma';
const LOGIN_URL = 'https://www.figma.com/login';
const PREPARED_LAUNCH_KEY = 'rmw_figma_prepared_launch';
const BLOCKED_NOTICE_KEY = 'rmw_figma_blocked_notice';
const EXTENSION_TICKET_KEY = 'rmw_extension_ticket';

const STATE = {
  credential: null,
  requested: false,
  requestAttempts: 0,
  lastRequestAt: 0,
  lastSubmitAt: 0,
  lastGoogleClickAt: 0,
  googleClickAttempts: 0,
  lastLoginOpenAt: 0,
  loginOpenAttempts: 0,
  giveUpNotified: false,
  loginOpenStartedAt: 0,
  lastRunAt: 0,
  lastMutationHandledAt: 0,
  scheduledTimer: null,
  keepAliveTimer: null,
  observer: null,
  settled: false,
  passwordFilled: false,
  launchChecked: false,
  launchAuthorized: false,
  launchExpiresAt: 0,
  launchActivatedAt: 0,
  passwordSavingInFlight: false,
  passwordSavingSuppressed: false,
  passwordSavingRestoreTimer: null,
  passwordRevealGuardAttached: false,
  launchKeepAliveTimer: null,
  status: 'Waiting for Figma login form',
};

const MIN_RUN_GAP_MS = 900;
const KEEP_ALIVE_MS = 4000;
const PASSWORD_PROMPT_RESTORE_DELAY_MS = 8000;
const GOOGLE_CLICK_COOLDOWN_MS = 3000;
const MAX_GOOGLE_CLICK_ATTEMPTS = 5;

const PASSWORD_REVEAL_ACTION_HINTS = ['show', 'hide', 'view', 'reveal', 'toggle'];
const PASSWORD_REVEAL_SUBJECT_HINTS = ['password', 'passcode'];
const PASSWORD_REVEAL_ICON_HINTS = ['eye', 'visibility', 'visible'];

const EMAIL_SELECTORS = [
  'input[type="email"]',
  'input[name="email"]',
  'input[name="username"]',
  'input[id*="email"]',
  'input[name*="email"]',
  'input[autocomplete="username"]',
  'input[autocomplete="email"]',
  'input[placeholder*="email" i]',
  'input[placeholder*="username" i]',
  'input[aria-label*="email" i]',
  'input[aria-label*="username" i]',
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

const ACTION_SELECTORS = [
  'button',
  'input[type="submit"]',
  'a[href]',
  '[role="button"]',
];

function ensureStatusBadge() {
  const existing = document.getElementById('rmw-autologin-status');
  if (existing) return existing;

  const badge = document.createElement('div');
  badge.id = 'rmw-autologin-status';
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
  badge.textContent = STATE.status || 'Starting auto-login';
  (document.body || document.documentElement).appendChild(badge);
  return badge;
}

function hideStatusBadge() {
  const badge = document.getElementById('rmw-autologin-status');
  if (badge) badge.remove();
}

function setStatus(message) {
  if (STATE.status === message) return;
  STATE.status = message;
  const badge = ensureStatusBadge();
  if (badge) {
    badge.textContent = `Figma auto-login\n${message}`;
  }
  console.debug('[RMW Figma Auto Login]', message);
}

function markSignedIn(message) {
  STATE.settled = true;
  setStatus(message);
  window.setTimeout(() => hideStatusBadge(), 600);
  startLaunchKeepAlive();
}

// Figma is a multi-page app - the post-login redirect into /files/... (and
// further in-app navigation) is a real page reload, which re-runs this whole
// script and re-checks TOOL_HUB_GET_LAUNCH_STATE from scratch. Without this,
// the dashboard launch ticket's 20-minute local bookkeeping (background-
// main.js's setActiveLaunch) would lapse on the first reload past that
// window, and the tab - despite being continuously, legitimately signed in
// the whole time - would get treated as an unauthorized visit and
// force-logged-out by enforceDashboardOnlyAccess. Pinging well inside that
// window keeps it from ever actually lapsing while this tab stays open. See
// background-main.js's extendActiveLaunch for the other half of this (same
// fix as content-semrush.js's startLaunchKeepAlive).
const LAUNCH_KEEPALIVE_INTERVAL_MS = 5 * 60 * 1000;

function startLaunchKeepAlive() {
  if (STATE.launchKeepAliveTimer) return;
  const extend = () => {
    chrome.runtime.sendMessage({ type: 'TOOL_HUB_EXTEND_SIGNED_IN_LAUNCH', toolSlug: TOOL_SLUG }, () => {
      void chrome.runtime.lastError;
    });
  };
  extend();
  STATE.launchKeepAliveTimer = window.setInterval(extend, LAUNCH_KEEPALIVE_INTERVAL_MS);
}

function normalizeLoginMethod(value) {
  return `${value || ''}`.trim().toLowerCase() || 'email_password';
}

function isGoogleCredential() {
  return normalizeLoginMethod(STATE.credential?.loginMethod) === 'google';
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
  setStatus('Disabling Chrome password-save prompt...');

  ensurePasswordSavingSuppressed()
    .then((ok) => {
      STATE.passwordSavingInFlight = false;
      if (!ok) {
        STATE.settled = true;
        setStatus('Blocked: Chrome password-save prompt could not be disabled.');
        return;
      }
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

function buttonText(button) {
  return `${button.innerText || button.textContent || button.value || button.getAttribute?.('aria-label') || ''}`
    .trim()
    .toLowerCase();
}

function buttonDescriptorText(button) {
  if (!button) return '';

  const textParts = [
    button.innerText,
    button.textContent,
    button.value,
    button.getAttribute?.('aria-label'),
    button.getAttribute?.('title'),
    button.getAttribute?.('data-provider'),
    button.getAttribute?.('href'),
  ];

  button.querySelectorAll?.('img[alt], [aria-label], [title], [data-provider]').forEach((node) => {
    textParts.push(
      node.getAttribute?.('alt'),
      node.getAttribute?.('aria-label'),
      node.getAttribute?.('title'),
      node.getAttribute?.('data-provider')
    );
  });

  return textParts
    .filter(Boolean)
    .join(' ')
    .trim()
    .toLowerCase();
}

function isGoogleAuthAction(button) {
  const text = buttonDescriptorText(button);
  return (text.includes('google') || text.includes('gmail')) && !text.includes('analytics');
}

function isThirdPartyAuthAction(button) {
  const text = buttonDescriptorText(button);
  return isGoogleAuthAction(button)
    || text.includes('apple')
    || text.includes('single sign-on')
    || text.includes('sso')
    || text.includes('sign up')
    || text.includes('create one')
    || text.includes('create account');
}

function findInput(selectors) {
  for (const selector of selectors) {
    const inputs = Array.from(document.querySelectorAll(selector));
    const match = inputs.find((input) => !input.disabled && !input.readOnly && isVisible(input));
    if (match) return match;
  }
  return null;
}

// Figma's password eye icon flips the field to type="text" on click, showing
// the plaintext password on screen. Same guard content-semrush.js and
// content-freepik.js use for their identical toggles.
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
      const hints = buttonDescriptorText(element);
      const hasSubjectHint = PASSWORD_REVEAL_SUBJECT_HINTS.some((hint) => hints.includes(hint));
      const hasActionHint = PASSWORD_REVEAL_ACTION_HINTS.some((hint) => hints.includes(hint));
      const hasIconHint = PASSWORD_REVEAL_ICON_HINTS.some((hint) => hints.includes(hint));
      const classHints = `${element.className || ''}`.toLowerCase();
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

function protectPasswordField(passwordInput) {
  if (!passwordInput) return;
  ensurePasswordRevealGuard();
}

function clearPageStorage() {
  try {
    window.localStorage.clear();
  } catch {}
  try {
    const preparedLaunch = window.sessionStorage.getItem(PREPARED_LAUNCH_KEY);
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

function findStepContainer(...inputs) {
  const seed = inputs.find(Boolean);
  if (!seed) return [document];

  const containers = [];
  let current = seed.parentElement;

  while (current && current !== document.body) {
    containers.push(current);
    if (
      current.matches?.('form, [role="dialog"], [aria-modal="true"], main, section, article')
      || current.getAttribute?.('data-testid')
    ) {
      break;
    }
    current = current.parentElement;
  }

  containers.push(document);
  return containers;
}

function collectActionCandidates(root) {
  return Array.from((root || document).querySelectorAll(ACTION_SELECTORS.join(',')))
    .filter((button) => !isDisabled(button) && isVisible(button) && !isThirdPartyAuthAction(button));
}

function findSubmitButton(emailInput, passwordInput) {
  const words = ['log in', 'login', 'sign in', 'continue', 'submit'];

  for (const root of findStepContainer(passwordInput, emailInput)) {
    const candidates = collectActionCandidates(root);
    if (!candidates.length) continue;

    const exactMatch = candidates.find((button) => {
      const text = buttonText(button);
      return text === 'log in' || text === 'login' || text === 'sign in' || text === 'continue';
    });
    if (exactMatch) return exactMatch;

    const wordMatch = candidates.find((button) => words.some((word) => buttonText(button).includes(word)));
    if (wordMatch) return wordMatch;

    const submitMatch = candidates.find((button) => button.type === 'submit');
    if (submitMatch) return submitMatch;
  }

  return null;
}

function findGoogleAction() {
  const candidates = Array.from(document.querySelectorAll(ACTION_SELECTORS.join(',')))
    .filter((element) => !isDisabled(element) && isVisible(element));

  return candidates.find((element) => {
    const text = buttonText(element);
    const descriptor = buttonDescriptorText(element);
    return text.includes('google')
      || text.includes('gmail')
      || descriptor.includes('sign in with google')
      || descriptor.includes('continue with google')
      || descriptor.includes('log in with google')
      || (descriptor.includes('google') && !descriptor.includes('analytics'));
  }) || null;
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
    ['mousedown', 'mouseup', 'click'].forEach((eventName) => {
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
    return true;
  } catch {
    return false;
  }
}

// Unlike Semrush's dedicated /login/ page, Figma's sign-in is a modal that
// opens over whatever page you're already on (the URL never changes) - so
// the entry point is a "Log in" link/button on the current page, not a
// distinct login URL. This finds that trigger.
function findLandingLoginAction() {
  const candidates = Array.from(document.querySelectorAll(ACTION_SELECTORS.join(',')))
    .filter((element) => !isDisabled(element) && isVisible(element));

  return candidates.find((element) => {
    if (isThirdPartyAuthAction(element)) return false;

    const text = buttonText(element);
    if (text === 'log in' || text === 'login' || text === 'sign in') {
      return true;
    }

    const href = `${element.getAttribute?.('href') || ''}`.toLowerCase();
    return href.includes('/login') || href.includes('/log-in');
  }) || null;
}

// True only while the modal is actually open (real email/password fields or
// the Google button present) or a landing "Log in" trigger is visible to
// open it - deliberately NOT a broad page-wide text/button scan, which on a
// large app like Figma's file browser would false-positive on unrelated
// "Google Drive import"-style buttons the same way it did on Semrush.
function isLoginSurfaceOpen() {
  return Boolean(findInput(EMAIL_SELECTORS))
    || Boolean(findInput(PASSWORD_SELECTORS))
    || Boolean(findGoogleAction());
}

// Narrow and URL-based on purpose: these path prefixes are Figma's
// authenticated file/board areas - a signed-out visitor can never reach
// them, so landing on one is unambiguous proof of a real, completed sign-in.
// This is deliberately NOT a page-text/button scan (like isLoginSurfaceOpen
// or the old Semrush isLoginPage()) - Figma's authenticated app is full of
// its own "Google Drive" import-style buttons that a broad scan would
// false-positive on, which is exactly the bug that had to be fixed on the
// Semrush script. Extend this list only from a confirmed screenshot of an
// authenticated Figma URL, not a guess.
function isAuthenticatedFigmaPath() {
  const path = window.location.pathname.toLowerCase();
  return path.startsWith('/files/')
    || path.startsWith('/design/')
    || path.startsWith('/proto/')
    || path.startsWith('/board/')
    || path.startsWith('/slides/');
}

// /make/ (Figma's AI tool) is used both logged-out (marketing page, "Log in"
// in the nav) and logged-in (same URL, "Log out" in the nav instead) - so
// unlike /files/ etc., its path alone can't tell the two apart, and the
// script kept waiting for a login form that was never going to appear once
// already signed in there (reported 2026-09-14). A visible "Log out" control
// is authenticated-only by definition, so it's a safe positive signal
// without the broad page-text/button scanning that caused the earlier
// Semrush false-positive bug (see content-semrush.js's isLoginPage comment).
function hasLogoutAction() {
  const candidates = Array.from(document.querySelectorAll(ACTION_SELECTORS.join(',')))
    .filter((element) => !isDisabled(element) && isVisible(element));
  return candidates.some((element) => {
    const text = buttonText(element);
    return text === 'log out' || text === 'logout' || text === 'sign out';
  });
}

function isVerificationPage() {
  const text = `${document.body?.innerText || ''}`.toLowerCase();
  return text.includes('passcode')
    || text.includes('authenticate')
    || text.includes('sign in verification')
    || text.includes('two-factor')
    || text.includes('2fa')
    || text.includes('verification code')
    || text.includes('captcha');
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
      STATE.launchActivatedAt = Number(activation.activatedAt || 0);
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
  STATE.launchActivatedAt = Number(response?.ok && response.authorized ? response.activatedAt || 0 : 0);
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
  if (!isLoginSurfaceOpen() && !findLandingLoginAction()) {
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
  // Keyed on launchActivatedAt, not launchExpiresAt - see the identical
  // comment in content-semrush.js's own ensureFreshLaunchSession for why:
  // startLaunchKeepAlive() renews expiresAt every few minutes, and keying
  // this off it would make every renewal look like a brand new dashboard
  // launch and force the whole sign-in flow to restart on every reload.
  const launchKey = `${STATE.launchActivatedAt || 0}`;
  if (!launchKey || launchKey === '0') {
    return false;
  }

  if (window.sessionStorage.getItem(PREPARED_LAUNCH_KEY) === launchKey) {
    return true;
  }

  await clearToolSession({ preserveLaunch: true });
  window.sessionStorage.setItem(PREPARED_LAUNCH_KEY, launchKey);
  window.sessionStorage.removeItem(BLOCKED_NOTICE_KEY);
  setStatus('Preparing fresh Figma session');

  if (window.location.href !== LOGIN_URL) {
    window.location.replace(LOGIN_URL);
    return false;
  }

  window.location.reload();
  return false;
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
      const ready = isGoogleCredential()
        ? Boolean(STATE.credential?.loginIdentifier)
        : Boolean(STATE.credential?.loginIdentifier && STATE.credential?.password);
      setStatus(ready ? 'Credential loaded' : 'Credential missing');
      scheduleAttempt(150);
    }
  );
}

// A visible [role="dialog"]/[aria-modal="true"] container is enough to know
// Figma has already opened the login prompt, even before any field or
// Google button inside it has actually rendered - a fresh, cache-less
// incognito window (see Tools.jsx's shouldLaunchExtensionToolInIncognito -
// Figma now always launches isolated) can take noticeably longer than a
// normal cached tab to finish loading a modal's own JS/content.
function isModalShellOpen() {
  return Array.from(document.querySelectorAll('[role="dialog"], [aria-modal="true"]'))
    .some((element) => isVisible(element));
}

// Generous on purpose: the previous fixed "3 clicks, ~7.5s total" cap gave
// up before a cold incognito load of Figma's own modal content had a chance
// to finish, and - worse - kept RE-clicking the "Log in" trigger every 2.5s
// while a modal was already open and still loading, which very likely
// interrupted/reset that in-progress load rather than helping (reported
// 2026-09-14: modal opened but stayed permanently blank). Time-based instead
// of attempt-count-based, and never re-clicks once a modal shell is visibly
// open - only waits for its content to catch up.
const LOGIN_OPEN_TIMEOUT_MS = 20000;

function notifyLoginGiveUp(message) {
  if (STATE.giveUpNotified) return;
  STATE.giveUpNotified = true;
  setStatus(message);
  STATE.settled = true;
}

function attemptLandingLogin() {
  if (isLoginSurfaceOpen()) return false;

  if (!STATE.loginOpenStartedAt) {
    STATE.loginOpenStartedAt = Date.now();
  }
  const elapsed = Date.now() - STATE.loginOpenStartedAt;

  if (isModalShellOpen()) {
    if (elapsed > LOGIN_OPEN_TIMEOUT_MS) {
      notifyLoginGiveUp('The Figma login form opened but never finished loading. Please sign in manually.');
      return false;
    }
    setStatus('Waiting for the Figma login form to finish loading...');
    return true;
  }

  if (elapsed > LOGIN_OPEN_TIMEOUT_MS) {
    notifyLoginGiveUp('Could not find the Figma login form automatically. Please sign in manually.');
    return false;
  }

  const action = findLandingLoginAction();
  if (!action) return false;

  const now = Date.now();
  if (now - STATE.lastLoginOpenAt > 2500) {
    STATE.lastLoginOpenAt = now;
    STATE.loginOpenAttempts += 1;
    setStatus('Opening Figma login prompt');
    window.setTimeout(() => clickElement(action), 250);
  }
  return true;
}

function attemptGoogleFlow() {
  if (STATE.googleClickAttempts > 0 && Date.now() - STATE.lastGoogleClickAt > 1500 && !isLoginSurfaceOpen()) {
    markSignedIn('Signed in successfully');
    return;
  }

  const googleAction = findGoogleAction();
  if (!googleAction) {
    if (!STATE.credential) requestCredential();
    if (!attemptLandingLogin()) {
      setStatus('Waiting for Figma "Continue with Google" button');
    }
    return;
  }

  if (!STATE.credential?.loginIdentifier) {
    requestCredential();
    setStatus('Waiting for Google credential');
    return;
  }

  if (STATE.googleClickAttempts >= MAX_GOOGLE_CLICK_ATTEMPTS) {
    setStatus('Clicked "Continue with Google" repeatedly - complete sign-in manually.');
    STATE.settled = true;
    return;
  }

  const now = Date.now();
  if (now - STATE.lastGoogleClickAt < GOOGLE_CLICK_COOLDOWN_MS) {
    return;
  }

  STATE.lastGoogleClickAt = now;
  STATE.googleClickAttempts += 1;
  setStatus('Continuing with Google');
  clickElement(googleAction);
}

function finishLoginForm(submitButton, passwordInput) {
  const firstFill = !STATE.passwordFilled;
  STATE.passwordFilled = true;
  highlightSubmitButton(submitButton);
  if (firstFill && passwordInput) {
    releasePasswordSavingSuppressed(PASSWORD_PROMPT_RESTORE_DELAY_MS);
  }
  // Not auto-submitted: same reasoning as content-semrush.js/content-freepik.js
  // - an invisible bot-check on the real submit can silently reject a
  // scripted click and, on some tools, escalate into a lockout. Until this
  // is confirmed safe on Figma specifically, fill and leave the click to the
  // user.
  setStatus('Email and password are filled. Click "Log in" to finish.');
}

function highlightSubmitButton(button) {
  if (!button) return;
  try {
    button.style.outline = '3px solid #22c55e';
    button.style.outlineOffset = '2px';
    button.style.borderRadius = button.style.borderRadius || '8px';
  } catch {}
}

function attemptEmailPasswordFlow() {
  const emailInput = findInput(EMAIL_SELECTORS);
  const passwordInput = findInput(PASSWORD_SELECTORS);

  if (passwordInput) {
    protectPasswordField(passwordInput);
  }

  if (STATE.passwordFilled && !emailInput && !passwordInput) {
    markSignedIn('Signed in successfully');
    return;
  }

  if (!STATE.credential?.loginIdentifier || !STATE.credential?.password) {
    if (emailInput || passwordInput || findLandingLoginAction()) {
      requestCredential();
    }

    if (!emailInput && !passwordInput && !attemptLandingLogin()) {
      setStatus('Waiting for Figma login field');
    }
    return;
  }

  if (emailInput && emailInput.value !== STATE.credential.loginIdentifier) {
    emailInput.focus();
    setInputValue(emailInput, STATE.credential.loginIdentifier);
  }

  if (passwordInput && passwordInput.value !== STATE.credential.password) {
    if (!STATE.passwordSavingSuppressed) {
      requestPasswordSavingSuppression();
      return;
    }
    passwordInput.focus();
    setInputValue(passwordInput, STATE.credential.password);
  }

  if (!emailInput && !passwordInput) {
    if (!attemptLandingLogin()) {
      setStatus('Waiting for Figma login field');
    }
    return;
  }

  const readyForSubmit = (!emailInput || emailInput.value) && (!passwordInput || passwordInput.value);
  if (!readyForSubmit) {
    setStatus('Waiting for credential fields');
    return;
  }

  finishLoginForm(findSubmitButton(emailInput, passwordInput), passwordInput);
}

function attemptFill() {
  if (STATE.settled) return;
  if (!STATE.launchChecked) {
    setStatus('Checking dashboard launch');
    return;
  }
  if (!STATE.launchAuthorized) {
    scheduleAsyncStep(enforceDashboardOnlyAccess);
    return;
  }
  if (STATE.launchActivatedAt && window.sessionStorage.getItem(PREPARED_LAUNCH_KEY) !== `${STATE.launchActivatedAt}`) {
    scheduleAsyncStep(ensureFreshLaunchSession);
    return;
  }

  if (isVerificationPage()) {
    setStatus('Figma requires verification. Complete it manually.');
    STATE.settled = true;
    return;
  }

  if ((isAuthenticatedFigmaPath() || hasLogoutAction()) && !isLoginSurfaceOpen()) {
    markSignedIn('Signed in successfully');
    return;
  }

  if (!STATE.credential) {
    requestCredential();
  }

  if (isGoogleCredential()) {
    attemptGoogleFlow();
  } else {
    attemptEmailPasswordFlow();
  }
}

function scheduleAsyncStep(task) {
  if (STATE.settled) return;
  STATE.settled = true;
  Promise.resolve()
    .then(task)
    .catch((error) => {
      setStatus(`Session check failed: ${error?.message || 'Unknown error'}`);
      releasePasswordSavingSuppressed(0);
    });
}

function runAttempt() {
  STATE.scheduledTimer = null;

  const now = Date.now();
  if (now - STATE.lastRunAt < MIN_RUN_GAP_MS) {
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
  if (STATE.settled) return;
  if (STATE.scheduledTimer) return;
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
      STATE.launchActivatedAt = 0;
    })
    .finally(() => {
      STATE.settled = false;
      scheduleAttempt(0);
    });
}

start();
