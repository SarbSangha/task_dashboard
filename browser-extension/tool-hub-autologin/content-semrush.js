const TOOL_SLUG = 'semrush';
const LOGIN_URL = 'https://www.semrush.com/login/';
const PREPARED_LAUNCH_KEY = 'rmw_semrush_prepared_launch';
const BLOCKED_NOTICE_KEY = 'rmw_semrush_blocked_notice';
const EXTENSION_TICKET_KEY = 'rmw_extension_ticket';
// Semrush is single-seat: the launch ticket used to fetch the credential is
// kept around (past the point loadLaunchState() otherwise discards it) so
// that every later page load - Semrush is a normal multi-page app, not a
// pure SPA, so browsing between sections re-runs this whole script - can
// still poll whether this tab is still the recognized holder of the lock.
const HELD_TICKET_KEY = 'rmw_semrush_held_ticket';
const SESSION_STATUS_POLL_MS = 30000;

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
  lastRunAt: 0,
  lastMutationHandledAt: 0,
  scheduledTimer: null,
  keepAliveTimer: null,
  observer: null,
  settled: false,
  passwordFilled: false,
  firstFilledAt: 0,
  launchChecked: false,
  launchAuthorized: false,
  launchExpiresAt: 0,
  launchActivatedAt: 0,
  passwordSavingInFlight: false,
  passwordSavingSuppressed: false,
  passwordSavingRestoreTimer: null,
  passwordRevealGuardAttached: false,
  sessionStatusPollTimer: null,
  launchKeepAliveTimer: null,
  sessionRevoked: false,
  status: 'Waiting for Semrush login form',
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
    badge.textContent = `Semrush auto-login\n${message}`;
  }
  console.debug('[RMW Semrush Auto Login]', message);
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

function markSignedIn(message) {
  STATE.settled = true;
  setStatus(message);
  window.setTimeout(() => hideStatusBadge(), 600);
  startSessionStatusPolling();
  startLaunchKeepAlive();
}

// Semrush is a multi-page app - switching sections is a real page reload,
// which re-runs this whole script and re-checks TOOL_HUB_GET_LAUNCH_STATE
// from scratch. Without this, the dashboard launch ticket's 20-minute local
// bookkeeping (background-main.js's setActiveLaunch) would lapse on the
// first reload past that window, and the tab - despite being continuously,
// legitimately signed in the whole time - would get treated as an
// unauthorized visit and force-logged-out by enforceDashboardOnlyAccess.
// Pinging well inside that window keeps it from ever actually lapsing while
// this tab stays open. See background-main.js's extendActiveLaunch for the
// other half of this.
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

// Semrush only allows one signed-in session at a time - if an admin
// force-releases this tool's lock (or the stale-lock safety net expires it)
// while this tab is still open, Semrush's own backend will silently
// invalidate this session on its next real request regardless of what the
// extension does. The extension itself can't reach across machines to close
// ANOTHER user's tab directly - but it CAN ask this tab's own background
// script to close *this* tab, once this tab's own polling finds out it's no
// longer the holder. So: poll, warn for a few seconds (so a genuine "why did
// my tab just disappear" doesn't happen), then close it.
const SESSION_REVOKED_AUTO_CLOSE_DELAY_MS = 5000;

function showSessionRevokedBanner() {
  if (STATE.sessionRevoked) return;
  STATE.sessionRevoked = true;

  if (STATE.sessionStatusPollTimer) {
    window.clearInterval(STATE.sessionStatusPollTimer);
    STATE.sessionStatusPollTimer = null;
  }

  if (!document.getElementById('rmw-semrush-session-revoked-banner')) {
    const banner = document.createElement('div');
    banner.id = 'rmw-semrush-session-revoked-banner';
    Object.assign(banner.style, {
      position: 'fixed',
      top: '0',
      left: '0',
      right: '0',
      zIndex: '2147483647',
      padding: '14px 20px',
      background: '#b91c1c',
      color: '#ffffff',
      font: '600 14px/1.4 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
      textAlign: 'center',
      boxShadow: '0 4px 16px rgba(0, 0, 0, 0.25)',
    });
    banner.textContent = 'Your access to Semrush here has ended - this shared account is now signed in elsewhere. This tab will close automatically.';
    (document.body || document.documentElement).prepend(banner);
  }

  window.setTimeout(() => {
    chrome.runtime.sendMessage({ type: 'TOOL_HUB_CLOSE_THIS_TAB' });
  }, SESSION_REVOKED_AUTO_CLOSE_DELAY_MS);
}

function startSessionStatusPolling() {
  if (STATE.sessionStatusPollTimer || STATE.sessionRevoked) return;
  // Not gated on having a held ticket: a tab that was already signed in
  // when this script ran (bookmarked past /login/, or a tab still open from
  // before this polling shipped) never has one, and no amount of refreshing
  // will give it one after the fact - only /login/ ever captures it. The
  // background script's own cached dashboard session covers that gap, so
  // this starts unconditionally; the empty ticket is just a no-op fallback.
  const ticket = getHeldTicket();

  const poll = () => {
    chrome.runtime.sendMessage(
      { type: 'TOOL_HUB_CHECK_SESSION_STATUS', toolSlug: TOOL_SLUG, extensionTicket: ticket },
      (response) => {
        if (chrome.runtime.lastError) return;
        if (response?.ok && response.data?.stillHolding === false) {
          showSessionRevokedBanner();
        }
      }
    );
  };

  STATE.sessionStatusPollTimer = window.setInterval(poll, SESSION_STATUS_POLL_MS);
  poll();
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
    || text.includes('facebook')
    || text.includes('saml')
    || text.includes('sign up')
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

// Semrush's password field ships with an eye icon that flips the input to
// type="text" on click, exposing the plaintext credential on screen (and to
// screen recordings). The extension fills the field but must not let the
// page reveal what it typed, so every click/press anywhere near that toggle
// is intercepted and the field is forced back to type="password" - the same
// guard content-freepik.js uses for Magnific's identical toggle.
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
    const heldTicket = window.sessionStorage.getItem(HELD_TICKET_KEY);
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
    if (heldTicket) {
      window.sessionStorage.setItem(HELD_TICKET_KEY, heldTicket);
    }
  } catch {}
}

function getHeldTicket() {
  try {
    return `${window.sessionStorage.getItem(HELD_TICKET_KEY) || ''}`.trim();
  } catch {
    return '';
  }
}

function storeHeldTicket(ticket) {
  if (!ticket) return;
  try {
    window.sessionStorage.setItem(HELD_TICKET_KEY, ticket);
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

function findLandingLoginAction() {
  const candidates = Array.from(document.querySelectorAll(ACTION_SELECTORS.join(',')))
    .filter((element) => !isDisabled(element) && isVisible(element));

  return candidates.find((element) => {
    if (isThirdPartyAuthAction(element)) return false;

    const text = buttonText(element);
    if (
      text.includes('log in')
      || text.includes('login')
      || text.includes('sign in')
      || text.includes('continue with email')
      || text === 'email'
    ) {
      return true;
    }

    const href = `${element.getAttribute?.('href') || ''}`.toLowerCase();
    return href.includes('/login') || href.includes('/log-in');
  }) || null;
}

function isLoginPage() {
  // Deliberately narrow: the URL path (Semrush's login form always lives at
  // /login/) or an actual email/password field. findGoogleAction() and
  // findLandingLoginAction() scan the WHOLE page for anything mentioning
  // "google" or "log in" - fine on a bare marketing page, but Semrush's
  // authenticated app is full of "Connect Google Search Console"/"Google
  // Analytics"-style buttons on every section (SEO, Traffic & Market, etc.),
  // so including them here made isLoginPage() true on ordinary dashboard
  // pages and re-armed the whole auto-login flow (and its status badge) on
  // every in-app navigation, even while already signed in.
  const path = window.location.pathname.toLowerCase();
  return path.includes('/login')
    || path.includes('/log-in')
    || Boolean(findInput(EMAIL_SELECTORS))
    || Boolean(findInput(PASSWORD_SELECTORS));
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
  // Keyed on launchActivatedAt (the launch's original activation time), NOT
  // launchExpiresAt - startLaunchKeepAlive() extends expiresAt every few
  // minutes to keep a genuinely still-open, signed-in tab from getting
  // treated as unauthorized (see that function's own comment), and using
  // the constantly-changing expiresAt here would make every single one of
  // those renewals look like a brand new dashboard launch, wiping cookies
  // and forcing the whole sign-in flow to restart on every reload -
  // reported by Sarbjeet 2026-09-14 ("reload Semrush, get logged out").
  // activatedAt only changes on a genuine new setActiveLaunch, which is
  // exactly when a fresh session SHOULD be forced.
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
  setStatus('Preparing fresh Semrush session');

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

  const ticketForThisRequest = getStoredLaunchTicket();

  chrome.runtime.sendMessage(
    {
      type: 'TOOL_HUB_GET_CREDENTIAL',
      toolSlug: TOOL_SLUG,
      hostname: window.location.hostname,
      pageUrl: window.location.href,
      extensionTicket: ticketForThisRequest,
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
      storeHeldTicket(ticketForThisRequest);
      STATE.credential = response.data?.credential || null;
      const ready = isGoogleCredential()
        ? Boolean(STATE.credential?.loginIdentifier)
        : Boolean(STATE.credential?.loginIdentifier && STATE.credential?.password);
      setStatus(ready ? 'Credential loaded' : 'Credential missing');
      scheduleAttempt(150);
    }
  );
}

function attemptLandingLogin() {
  const emailInput = findInput(EMAIL_SELECTORS);
  const passwordInput = findInput(PASSWORD_SELECTORS);
  if (emailInput || passwordInput || findGoogleAction()) return false;
  if (STATE.loginOpenAttempts >= 2) return false;

  const action = findLandingLoginAction();
  if (!action) return false;

  const now = Date.now();
  if (now - STATE.lastLoginOpenAt > 3500) {
    STATE.lastLoginOpenAt = now;
    STATE.loginOpenAttempts += 1;
    setStatus('Opening login prompt');
    window.setTimeout(() => clickElement(action), 250);
  }
  return true;
}

function looksSignedInAfterSubmit() {
  if (!STATE.lastSubmitAt) return false;
  if (Date.now() - STATE.lastSubmitAt < 1500) return false;
  if (isLoginPage()) return false;
  if (findInput(EMAIL_SELECTORS) || findInput(PASSWORD_SELECTORS)) return false;
  return true;
}

// The email/password flow never submits the form itself (Semrush's captcha
// only passes on a real user click - see finishLoginForm()), so there is no
// STATE.lastSubmitAt to gate on here. Once the fields have been filled at
// least once, the fields/login form disappearing is the only signal that the
// user's manual click succeeded.
function looksSignedInAfterManualFill() {
  if (!STATE.firstFilledAt) return false;
  if (Date.now() - STATE.firstFilledAt < 1500) return false;
  if (isLoginPage()) return false;
  if (findInput(EMAIL_SELECTORS) || findInput(PASSWORD_SELECTORS)) return false;
  return true;
}

function attemptGoogleFlow() {
  if (looksSignedInAfterSubmit() || (!isLoginPage() && STATE.googleClickAttempts > 0)) {
    markSignedIn('Signed in successfully');
    return;
  }

  const googleAction = findGoogleAction();
  if (!googleAction) {
    if (!STATE.credential) requestCredential();
    setStatus('Waiting for Semrush "Sign in with Google" button');
    return;
  }

  if (!STATE.credential?.loginIdentifier) {
    requestCredential();
    setStatus('Waiting for Google credential');
    return;
  }

  if (STATE.googleClickAttempts >= MAX_GOOGLE_CLICK_ATTEMPTS) {
    setStatus('Clicked "Sign in with Google" repeatedly - complete sign-in manually.');
    STATE.settled = true;
    return;
  }

  const now = Date.now();
  if (now - STATE.lastGoogleClickAt < GOOGLE_CLICK_COOLDOWN_MS) {
    return;
  }

  STATE.lastGoogleClickAt = now;
  STATE.googleClickAttempts += 1;
  STATE.lastSubmitAt = now;
  setStatus('Continuing with Google');
  clickElement(googleAction);
}

function attemptEmailPasswordFlow() {
  const emailInput = findInput(EMAIL_SELECTORS);
  const passwordInput = findInput(PASSWORD_SELECTORS);

  if (passwordInput) {
    protectPasswordField(passwordInput);
  }

  if (looksSignedInAfterManualFill()) {
    markSignedIn('Signed in successfully');
    return;
  }

  if (!STATE.credential?.loginIdentifier || !STATE.credential?.password) {
    if (emailInput || passwordInput || findLandingLoginAction()) {
      requestCredential();
    }

    if (!emailInput && !passwordInput && !attemptLandingLogin()) {
      setStatus('Waiting for Semrush login field');
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
      setStatus('Waiting for Semrush login field');
    }
    return;
  }

  const readyForSubmit = (!emailInput || emailInput.value) && (!passwordInput || passwordInput.value);
  if (!readyForSubmit) {
    setStatus('Waiting for credential fields');
    return;
  }

  // Semrush's login form sits behind a captcha check that only passes on a
  // real user click - a scripted click gets flagged and risks a lockout (the
  // same issue Freepik/Magnific has, see content-freepik.js). So the
  // extension fills the credentials and stops here: it highlights the "Log
  // in" button and leaves the actual click to the user.
  finishLoginForm(findSubmitButton(emailInput, passwordInput), passwordInput);
}

function highlightSubmitButton(button) {
  // Re-applied on every pass rather than a set-once guard: if Semrush
  // rejects a submit and re-renders the form, the old (highlighted) button
  // node is gone and a fresh one needs the same treatment.
  if (!button) return;
  try {
    button.style.outline = '3px solid #22c55e';
    button.style.outlineOffset = '2px';
    button.style.borderRadius = button.style.borderRadius || '8px';
  } catch {}
}

function finishLoginForm(submitButton, passwordInput) {
  const firstFill = !STATE.passwordFilled;
  if (!STATE.firstFilledAt) {
    STATE.firstFilledAt = Date.now();
  }
  STATE.passwordFilled = true;
  highlightSubmitButton(submitButton);
  if (firstFill && passwordInput) {
    releasePasswordSavingSuppressed(PASSWORD_PROMPT_RESTORE_DELAY_MS);
  }
  setStatus('Email and password are filled. Click "Log in" to finish - Semrush\'s captcha needs your click.');
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
    setStatus('Semrush requires verification. Complete it manually.');
    STATE.settled = true;
    return;
  }

  // A page load with no login form, no "Sign in with Google" button and a
  // path that is not the login screen means there is nothing for this script
  // to do here - most commonly a fresh content-script run on the
  // already-authenticated app (e.g. semrush.com/home/ right after a
  // successful manual login submit navigated the tab there). Without this,
  // the credential/fill branches below never match, requestCredential() is
  // never called, and the badge is stuck on "Waiting for Semrush login
  // field" forever even though sign-in already succeeded.
  if (!isLoginPage()) {
    markSignedIn('Signed in - no login form on this page.');
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
