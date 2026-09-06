const TOOL_SLUG = 'claude';
const LOGIN_URL = 'https://claude.ai/login';
const BLOCKED_NOTICE_KEY = 'rmw_claude_blocked_notice';
const EXTENSION_TICKET_KEY = 'rmw_extension_ticket';
const EMAIL_SUBMITTED_AT_KEY = 'rmw_claude_email_submitted_at';
const AUTH_LINK_NAVIGATED_KEY = 'rmw_claude_auth_link_navigated';

const STATE = {
  credential: null,
  requested: false,
  requestAttempts: 0,
  lastRequestAt: 0,
  lastSubmitAt: 0,
  lastActionAt: 0,
  authLinkInFlight: false,
  authLinkAttempts: 0,
  authLinkNavigated: false,
  emailSubmittedAt: 0,
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
  lastGoogleSignInClickAt: 0,
  googleSignInClickAttempts: 0,
  status: 'Waiting for Claude sign-in',
};

const MIN_RUN_GAP_MS = 900;
const KEEP_ALIVE_MS = 4000;
const ACTION_THROTTLE_MS = 1200;
// Reported bug: clicking "Continue with Google" opens a real
// window.open() popup - Chrome's popup blocker treats a burst of these in
// quick succession as spam (confirmed live: 4 blocked in a row) and starts
// refusing every one of them, even a perfectly genuine later attempt. The
// generic ACTION_THROTTLE_MS (1200ms) is nowhere near long enough here:
// Claude's own page re-renders the same button (and often shows its own
// "There was an error logging you in" banner) the instant a popup gets
// blocked, so nothing about the DOM signals "already tried" the way a
// successful click normally would - the button just looks identical to a
// fresh, never-clicked one on every following attemptFill() pass. This is
// a much longer, click-specific cooldown, separate from and on top of
// ACTION_THROTTLE_MS, so at most one popup attempt goes out per window
// regardless of how often the mutation observer/keepalive timer re-fires.
// Also deliberately long enough to comfortably outlast a SUCCESSFUL popup's
// own full flow (chooser -> password -> consent, each with their own
// multi-second settle/retry waits in content-google.js) - the goal is never
// clicking a second time while a first, perfectly working popup is simply
// still in progress. A completed sign-in stops this tab's automation
// entirely (looksLikeAuthenticatedWorkspace()) well before this would ever
// fire again anyway.
const GOOGLE_SIGN_IN_CLICK_COOLDOWN_MS = 20000;
// Safety valve, not a normal ceiling: if Chrome is still blocking popups
// from this site after several spaced-out attempts, retrying forever just
// keeps adding to the blocked-popups list - stop and let the user finish
// manually (click "Continue with Google" themselves, or "Always allow
// pop-ups" for claude.ai) rather than fighting the browser's own blocker
// indefinitely.
const GOOGLE_SIGN_IN_CLICK_MAX_ATTEMPTS = 3;

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

const ACTION_SELECTORS = [
  'button',
  'a[href]',
  'input[type="submit"]',
  'input[type="button"]',
  '[role="button"]',
];

function ensureStatusBadge() {
  const existing = document.getElementById('rmw-claude-autologin-status');
  if (existing) return existing;

  const badge = document.createElement('div');
  badge.id = 'rmw-claude-autologin-status';
  badge.style.position = 'fixed';
  badge.style.top = '12px';
  badge.style.right = '12px';
  badge.style.zIndex = '2147483647';
  badge.style.maxWidth = '340px';
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

function setStatus(message) {
  if (STATE.status === message) return;
  STATE.status = message;
  const badge = ensureStatusBadge();
  if (badge) {
    badge.textContent = `Claude auto-login\n${message}`;
  }
  console.debug('[RMW Claude Auto Login]', message);
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

function getSessionNumber(key) {
  try {
    const value = Number(window.sessionStorage.getItem(key) || 0);
    return Number.isFinite(value) ? value : 0;
  } catch {
    return 0;
  }
}

function setSessionNumber(key, value) {
  try {
    if (!value) {
      window.sessionStorage.removeItem(key);
      return;
    }
    window.sessionStorage.setItem(key, `${value}`);
  } catch {}
}

function syncAuthStateFromStorage() {
  STATE.emailSubmittedAt = getSessionNumber(EMAIL_SUBMITTED_AT_KEY);
  STATE.authLinkNavigated = getSessionNumber(AUTH_LINK_NAVIGATED_KEY) > 0;
}

function persistEmailSubmittedAt() {
  setSessionNumber(EMAIL_SUBMITTED_AT_KEY, STATE.emailSubmittedAt);
}

function markAuthLinkNavigated(value) {
  STATE.authLinkNavigated = Boolean(value);
  setSessionNumber(AUTH_LINK_NAVIGATED_KEY, value ? Date.now() : 0);
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

function isGoogleLoginCredential(credential) {
  return normalizeLoginMethod(credential?.loginMethod) === 'google';
}

function descriptorText(element) {
  const parts = [
    element?.innerText,
    element?.textContent,
    element?.value,
    element?.getAttribute?.('aria-label'),
    element?.getAttribute?.('title'),
    element?.getAttribute?.('href'),
  ];
  return normalizeText(parts.filter(Boolean).join(' '));
}

function collectActionCandidates(root = document) {
  return Array.from(root.querySelectorAll(ACTION_SELECTORS.join(',')))
    .filter((element) => !isDisabled(element) && isVisible(element));
}

function findActionByText({ exact = [], partial = [], exclude = [] } = {}) {
  const exactSet = exact.map(normalizeText);
  const partialSet = partial.map(normalizeText);
  const excludeSet = exclude.map(normalizeText);
  const candidates = collectActionCandidates();

  return candidates.find((element) => {
    const text = descriptorText(element);
    if (!text) return false;
    if (excludeSet.some((value) => text.includes(value))) {
      return false;
    }
    if (exactSet.some((value) => text === value)) {
      return true;
    }
    return partialSet.some((value) => text.includes(value));
  }) || null;
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
  STATE.emailSubmittedAt = 0;
  STATE.authLinkNavigated = false;
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

  try {
    element.click();
    return true;
  } catch {
    try {
      element.dispatchEvent(new MouseEvent('click', {
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

function findEmailInput() {
  return findInput(EMAIL_SELECTORS);
}

function onClaudeHost() {
  return window.location.hostname === 'claude.ai' || window.location.hostname.endsWith('.claude.ai');
}

function looksLikeWaitingForEmail() {
  const text = normalizeText(document.body?.innerText || '');
  if (!text) return false;
  return [
    'check your email',
    'secure link',
    'sign in with the secure link below',
    'we sent you a sign in link',
    'we sent a login link',
    'email me a login link',
    'open the link in your email',
  ].some((phrase) => text.includes(phrase));
}

function findContinueButton() {
  return findActionByText({
    exact: ['continue', 'email me a login link', 'send link', 'send sign in link'],
    partial: ['continue', 'email me a login link', 'send link', 'send sign in link', 'email me a secure link'],
    exclude: ['google', 'apple', 'github', 'enterprise', 'sso'],
  });
}

function findGoogleOptionAction() {
  return findActionByText({
    exact: ['continue with google', 'sign in with google'],
    partial: ['continue with google', 'sign in with google', 'log in with google', 'login with google', 'continue using google'],
  });
}

function isLoginPage() {
  const path = normalizeText(window.location.pathname || '');
  return path.includes('/login')
    || Boolean(findEmailInput())
    || Boolean(findContinueButton())
    || looksLikeWaitingForEmail();
}

function looksLikeAuthenticatedWorkspace() {
  if (!onClaudeHost()) return false;
  if (findEmailInput() || looksLikeWaitingForEmail()) return false;
  if ((window.location.pathname || '').startsWith('/login')) return false;

  if (
    /^(\/new|\/chat|\/recents|\/projects|\/settings)(\/|$)/.test(window.location.pathname || '')
  ) {
    return true;
  }

  if (document.querySelector('textarea, [contenteditable="true"], a[href^="/new"], a[href^="/chat"]')) {
    return true;
  }

  const text = normalizeText(document.body?.innerText || '');
  return [
    'new chat',
    'claude can make mistakes',
    'projects',
    'recents',
  ].some((phrase) => text.includes(phrase));
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

async function revokeActiveLaunch() {
  await sendRuntimeMessage({
    type: 'TOOL_HUB_REVOKE_ACTIVE_LAUNCH',
    toolSlug: TOOL_SLUG,
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
  setStatus('Preparing fresh Claude session');

  if (window.location.href !== LOGIN_URL) {
    window.location.replace(LOGIN_URL);
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
  setStatus(`Fetching Claude email (attempt ${STATE.requestAttempts})`);

  chrome.runtime.sendMessage(
    {
      type: 'TOOL_HUB_GET_CREDENTIAL',
      toolSlug: TOOL_SLUG,
      hostname: window.location.hostname,
      pageUrl: window.location.href,
      extensionTicket: getStoredLaunchTicket(),
      requireDirectTicket: true,
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
        setStatus(response?.error || 'Claude credential unavailable');
        return;
      }

      clearStoredLaunchTicket();
      STATE.credential = response.data?.credential || null;
      // Surfaces exactly which route this credential will take - the single
      // most useful line for diagnosing "it filled the email field instead
      // of clicking Google" (or vice versa): that always means the resolved
      // credential's loginMethod itself is not what was expected (e.g. the
      // dashboard's Add/Edit Credential form still has "Email" selected, or
      // a DIFFERENT saved Claude credential than the one just edited is the
      // one actually being served for this launch) - not a routing bug in
      // attemptFill() below, which always branches on this exact value.
      const routeLabel = STATE.credential
        ? (isGoogleLoginCredential(STATE.credential) ? 'google' : 'email')
        : 'none';
      setStatus(
        STATE.credential?.loginIdentifier
          ? `Claude credential loaded (${STATE.credential.loginIdentifier}, route=${routeLabel})`
          : 'Claude email missing'
      );
      scheduleAttempt(150);
    }
  );
}

function canActNow() {
  return Date.now() - STATE.lastActionAt > ACTION_THROTTLE_MS;
}

function markActionTaken() {
  STATE.lastActionAt = Date.now();
}

// Reported bug: signing in successfully would immediately log the user
// back out, storage wiped, right after the whole verification process
// completed. Root cause: revokeActiveLaunch() used to fire the instant
// looksLikeAuthenticatedWorkspace() first matched - but Claude's own
// auth-callback flow can land on more than one URL before settling
// (e.g. a transitional "verifying..." shell that shares enough layout
// with the real app - a textarea, a "New chat" link - to false-match
// authenticated-workspace detection before the final client-side redirect
// actually lands). Revoking right then deleted the launch one hop too
// early: the NEXT page load (the real final one) found no launch left,
// was treated as an unauthorized manual visit by enforceDashboardOnlyAccess,
// and wiped everything. Claude has no continuation-launch fallback by
// design (see DIRECT_TICKET_ONLY_TOOLS in background-main.js), so there
// was nothing to catch that. Delaying the revoke lets a later hop's own
// success detection - which only ever runs while the launch is still
// valid - see the same still-live launch instead of finding it already
// gone.
const REVOKE_LAUNCH_GRACE_MS = 8000;

function stopAutomation(message, { hideBadgeAfterMs = 3000, revokeLaunch = false } = {}) {
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
  if (revokeLaunch) {
    window.setTimeout(() => { void revokeActiveLaunch(); }, REVOKE_LAUNCH_GRACE_MS);
  }

  if (hideBadgeAfterMs > 0) {
    window.setTimeout(() => {
      const badge = document.getElementById('rmw-claude-autologin-status');
      if (badge) {
        badge.remove();
      }
    }, hideBadgeAfterMs);
  }
}

function attemptOpenLoginPage() {
  if (isLoginPage()) return false;
  if (!canActNow()) return true;
  markActionTaken();
  setStatus('Redirecting to Claude sign-in');
  window.location.replace(LOGIN_URL);
  return true;
}

function submitClaudeEmail(emailInput) {
  if (!STATE.credential?.loginIdentifier) {
    requestCredential();
    setStatus('Waiting for Claude sign-in email');
    return true;
  }

  if (emailInput.value !== STATE.credential.loginIdentifier) {
    emailInput.focus();
    setInputValue(emailInput, STATE.credential.loginIdentifier);
  }

  const continueButton = findContinueButton();
  if (!continueButton) {
    setStatus('Email filled, continue button not found');
    return true;
  }

  const now = Date.now();
  if (!canActNow() || now - STATE.lastSubmitAt < 3000) {
    setStatus('Email filled');
    return true;
  }

  markActionTaken();
  STATE.lastSubmitAt = now;
  STATE.emailSubmittedAt = now;
  persistEmailSubmittedAt();
  setStatus('Email filled, requesting Claude sign-in link');
  window.setTimeout(() => safeClick(continueButton), 250);
  scheduleAttempt(800);
  return true;
}

// Mirrors content-suno.js/content-google.js's own attemptProviderChoice /
// attempt<Tool>GooglePopupFlow pattern: clicking this button opens a real
// child popup window (window.open from claude.ai's own JS, confirmed live -
// not a same-tab redirect the way the email magic-link flow is), which
// navigates to accounts.google.com. That popup gets its own content-script
// injection per manifest.json's existing accounts.google.com match
// (content-google.js), which recognizes this as a Claude flow via
// isClaudeGoogleFlow()/inferToolSlugFromGooglePage() and drives the
// chooser/password/email steps there - nothing else is needed here once
// the click lands; looksLikeAuthenticatedWorkspace() below already detects
// the resulting signed-in state on this tab once the popup completes.
function attemptGoogleSignIn() {
  const googleButton = findGoogleOptionAction();
  if (!googleButton) {
    // Confirmed live: Claude's login page renders the Google button
    // asynchronously (a brief loading spinner sits in its place while it
    // checks for an existing browser Google session) - on an attemptFill()
    // pass that lands during that window, this simply isn't found yet. The
    // caller (attemptFill()) must never treat this as "no Google option on
    // this page, fall back to email" for a credential we already know is
    // Google-based - see the comment there for the double-flow bug that
    // produced (both an email fill AND a Google popup, at once) before this
    // waited instead.
    setStatus('Waiting for Claude Google sign-in button to render');
    scheduleAttempt(400);
    return false;
  }

  if (STATE.googleSignInClickAttempts >= GOOGLE_SIGN_IN_CLICK_MAX_ATTEMPTS) {
    // Stop retrying - see GOOGLE_SIGN_IN_CLICK_MAX_ATTEMPTS's own comment.
    // STATE.settled is deliberately NOT set here: looksLikeAuthenticatedWorkspace()
    // above still keeps checking on every later mutation/keepalive tick, so
    // a manual click by the user (or Chrome's own "Always allow" choice
    // followed by a page reload) is still picked up and completes normally.
    setStatus('Claude Google sign-in popup keeps getting blocked. Click "Continue with Google" yourself, or allow pop-ups for claude.ai.');
    return true;
  }

  const now = Date.now();
  if (!canActNow() || now - STATE.lastGoogleSignInClickAt < GOOGLE_SIGN_IN_CLICK_COOLDOWN_MS) {
    setStatus('Waiting to open Claude Google sign-in');
    scheduleAttempt(1000);
    return true;
  }

  markActionTaken();
  STATE.lastGoogleSignInClickAt = now;
  STATE.googleSignInClickAttempts += 1;
  setStatus(`Opening Claude Google sign-in (attempt ${STATE.googleSignInClickAttempts}/${GOOGLE_SIGN_IN_CLICK_MAX_ATTEMPTS})`);
  safeClick(googleButton);
  scheduleAttempt(GOOGLE_SIGN_IN_CLICK_COOLDOWN_MS);
  return true;
}

function requestAuthLink() {
  if (STATE.authLinkInFlight || STATE.authLinkAttempts >= 1 || STATE.authLinkNavigated) {
    return;
  }

  STATE.authLinkInFlight = true;
  STATE.authLinkAttempts += 1;
  setStatus('Waiting for Claude sign-in email...');

  chrome.runtime.sendMessage(
    {
      type: 'TOOL_HUB_FETCH_AUTH_LINK',
      toolSlug: TOOL_SLUG,
      hostname: window.location.hostname,
      pageUrl: window.location.href,
      extensionTicket: getStoredLaunchTicket(),
    },
    async (response) => {
      STATE.authLinkInFlight = false;

      if (chrome.runtime.lastError) {
        stopAutomation(`Extension error: ${chrome.runtime.lastError.message}`, { revokeLaunch: true });
        return;
      }

      if (!response?.ok || !response?.authLink) {
        stopAutomation(response?.error || 'Claude sign-in link unavailable', { revokeLaunch: true, hideBadgeAfterMs: 5000 });
        return;
      }

      markAuthLinkNavigated(true);
      await sendRuntimeMessage({
        type: 'TOOL_HUB_MARK_AUTH_TRANSITION',
        toolSlug: TOOL_SLUG,
      });
      setStatus('Opening Claude sign-in link');
      window.location.replace(response.authLink);
    }
  );
}

function attemptFill() {
  if (STATE.settled) return;

  // Checked before ANY launch-authorization gating below - see the block
  // that follows for why. Doesn't depend on launchChecked/launchAuthorized
  // at all (it only inspects the page's own DOM), so it's safe to run
  // immediately, before loadLaunchState()'s async round-trip even resolves.
  if (looksLikeAuthenticatedWorkspace()) {
    stopAutomation('Signed in successfully', { revokeLaunch: true });
    return;
  }

  if (!STATE.launchChecked) {
    setStatus('Checking dashboard launch');
    return;
  }
  // Reported bug: refreshing the page after a successful sign-in logged the
  // user straight back out. Root cause: stopAutomation's own revokeLaunch
  // cleanup (see REVOKE_LAUNCH_GRACE_MS above) deletes this tab's launch
  // record a few seconds after sign-in succeeds, by design - the
  // extension's job is done at that point. With the launch-authorization
  // check running first (as it used to), ANY later page load - a plain
  // refresh, not a stray auth-callback hop - found no launch record left,
  // was treated identically to a genuine unauthorized manual visit, and
  // enforceDashboardOnlyAccess() wiped storage and bounced back to
  // /login - even though the real Claude session (server-side, cookie-based)
  // was still perfectly valid the whole time. Checking
  // looksLikeAuthenticatedWorkspace() first, above, means an already
  // signed-in tab never reaches this gate at all on a refresh.
  if (!STATE.launchAuthorized) {
    scheduleAsyncStep(enforceDashboardOnlyAccess);
    return;
  }
  if (STATE.launchExpiresAt && !STATE.launchPrepared) {
    scheduleAsyncStep(ensureFreshLaunchSession);
    return;
  }

  if (STATE.authLinkNavigated && isLoginPage()) {
    stopAutomation('Claude returned to sign-in. Check the email link or continue manually.', {
      revokeLaunch: true,
      hideBadgeAfterMs: 5000,
    });
    return;
  }

  // Route on credential type before touching the email field at all - once
  // a credential is loaded and it's Google-based, click "Continue with
  // Google" instead of filling the (also always-present, per Claude's own
  // login page) email field. On the very first pass, before any credential
  // has loaded yet, STATE.credential is still null - this simply falls
  // through to the email branch below, which lazily requests the
  // credential itself (submitClaudeEmail's own requestCredential() call);
  // once that resolves, scheduleAttempt(150) reruns attemptFill() and this
  // check runs again with the real credential now known.
  //
  // Reported bug: both the email field got filled with the Google
  // credential's own loginIdentifier AND a Google sign-in popup opened, at
  // once. Root cause: attemptGoogleSignIn() returning false whenever
  // findGoogleOptionAction() hadn't found the button YET (Claude's login
  // page renders "Continue with Google" asynchronously behind a brief
  // loading spinner - confirmed live) used to be read by this caller as "no
  // Google option exists on this page, fall back to the email flow" - the
  // exact same signal as a page that genuinely has no Google button at all.
  // A later pass, once the spinner resolved into the real button, then
  // separately succeeded and opened the popup - so both flows fired for the
  // one credential. `return` unconditionally once we know the route is
  // Google, matching how the email branch below already waits (via
  // submitClaudeEmail's own credential/button checks) rather than ever
  // falling through to some other flow.
  if (STATE.credential && isGoogleLoginCredential(STATE.credential)) {
    attemptGoogleSignIn();
    return;
  }

  const emailInput = findEmailInput();
  if (emailInput) {
    submitClaudeEmail(emailInput);
    return;
  }

  if (looksLikeWaitingForEmail() || STATE.emailSubmittedAt) {
    requestAuthLink();
    return;
  }

  attemptOpenLoginPage();
  setStatus('Waiting for Claude sign-in form');
}

function scheduleAsyncStep(task) {
  if (STATE.settled) return;
  STATE.settled = true;
  Promise.resolve()
    .then(task)
    .then((shouldContinue) => {
      if (shouldContinue && STATE.observer) {
        STATE.settled = false;
        scheduleAttempt(150);
      }
    })
    .catch((error) => {
      setStatus(`Session check failed: ${error?.message || 'Unknown error'}`);
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
  syncAuthStateFromStorage();
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
