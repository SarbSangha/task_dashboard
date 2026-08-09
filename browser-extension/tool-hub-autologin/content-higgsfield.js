const TOOL_SLUG = 'higgsfield';
const LOGIN_URL = 'https://higgsfield.ai/auth/login';
const BLOCKED_NOTICE_KEY = 'rmw_higgsfield_blocked_notice';
const EXTENSION_TICKET_KEY = 'rmw_extension_ticket';
const STATE = {
  credential: null,
  requested: false,
  requestAttempts: 0,
  lastRequestAt: 0,
  otpValue: '',
  otpStageSeen: false,
  otpSubmittedAt: 0,
  otpFetching: false,
  otpRequestAttempts: 0,
  otpLastRequestAt: 0,
  otpBaselineUid: '',
  otpBaselineFetching: false,
  otpBaselinePrepared: false,
  lastSubmitAt: 0,
  lastLoginOpenAt: 0,
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
  authTransitionAt: 0,
  passwordSavingInFlight: false,
  passwordSavingSuppressed: false,
  passwordSavingRestoreTimer: null,
  status: 'Waiting for Higgsfield login form',
};

const MIN_RUN_GAP_MS = 900;
const KEEP_ALIVE_MS = 4000;
const OTP_FETCH_RETRY_MS = 2500;
const OTP_SUBMIT_RETRY_MS = 900;

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

const OTP_SELECTORS = [
  'input[name="otp"]',
  'input[name="code"]',
  'input[name="token"]',
  'input[name="verificationCode"]',
  'input[autocomplete="one-time-code"]',
  'input[type="number"][maxlength="6"]',
  'input[type="number"][maxlength="4"]',
  'input[type="text"][maxlength="6"]',
  'input[type="text"][maxlength="8"]',
  'input[placeholder*="code" i]',
  'input[placeholder*="otp" i]',
  'input[placeholder*="verification" i]',
  'input[aria-label*="code" i]',
  'input[aria-label*="otp" i]',
];

const ACTION_SELECTORS = [
  'button',
  'input[type="submit"]',
  'a[href]',
  '[role="button"]',
];

function ensureStatusBadge() {
  const existing = document.getElementById('rmw-higgsfield-autologin-status');
  if (existing) return existing;

  const badge = document.createElement('div');
  badge.id = 'rmw-higgsfield-autologin-status';
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

function setStatus(message) {
  if (STATE.status === message) return;
  STATE.status = message;
  const badge = ensureStatusBadge();
  if (badge) {
    badge.textContent = `Higgsfield auto-login\n${message}`;
  }
  console.debug('[RMW Higgsfield Auto Login]', message);
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
  try {
    input.dispatchEvent(new InputEvent('beforeinput', {
      bubbles: true,
      cancelable: true,
      data: value,
      inputType: 'insertText',
    }));
  } catch {}
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
  try {
    input.dispatchEvent(new KeyboardEvent('keyup', {
      key: `${value}`.slice(-1),
      bubbles: true,
      cancelable: true,
    }));
  } catch {}
  input.dispatchEvent(new Event('blur', { bubbles: true }));
}

function clickAction(element) {
  if (!element || isDisabled(element) || !isVisible(element)) return false;

  try {
    element.scrollIntoView({ block: 'center', inline: 'nearest' });
  } catch {}
  try {
    element.focus({ preventScroll: true });
  } catch {}

  const pointerCtor = typeof window.PointerEvent === 'function' ? window.PointerEvent : window.MouseEvent;
  [
    ['pointerdown', pointerCtor],
    ['mousedown', window.MouseEvent],
    ['pointerup', pointerCtor],
    ['mouseup', window.MouseEvent],
    ['click', window.MouseEvent],
  ].forEach(([type, EventCtor]) => {
    try {
      element.dispatchEvent(new EventCtor(type, {
        bubbles: true,
        cancelable: true,
        composed: true,
        view: window,
      }));
    } catch {}
  });

  try {
    element.click();
    return true;
  } catch {
    return true;
  }
}

function dispatchEnterKey(input) {
  if (!input) return false;

  try {
    input.focus();
  } catch {}

  const events = ['keydown', 'keypress', 'keyup'];
  for (const type of events) {
    try {
      input.dispatchEvent(new KeyboardEvent(type, {
        key: 'Enter',
        code: 'Enter',
        keyCode: 13,
        which: 13,
        bubbles: true,
        cancelable: true,
      }));
    } catch {}
  }

  return true;
}

function submitNearestForm(input) {
  const form = input?.closest?.('form') || null;
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
  } catch {}

  return false;
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
    .filter((button) => !isDisabled(button) && isVisible(button));
}

function findSubmitButton(emailInput, passwordInput) {
  const words = ['log in', 'login', 'sign in', 'continue', 'submit', 'verify'];

  for (const root of findStepContainer(passwordInput, emailInput)) {
    const candidates = collectActionCandidates(root);
    if (!candidates.length) continue;

    const exactMatch = candidates.find((button) => {
      const text = buttonText(button);
      return text === 'log in' || text === 'login' || text === 'sign in' || text === 'continue' || text === 'verify';
    });
    if (exactMatch) return exactMatch;

    const wordMatch = candidates.find((button) => words.some((word) => buttonText(button).includes(word)));
    if (wordMatch) return wordMatch;

    const submitMatch = candidates.find((button) => button.type === 'submit');
    if (submitMatch) return submitMatch;
  }

  return null;
}

function findEmailEntryAction() {
  const candidates = Array.from(document.querySelectorAll(ACTION_SELECTORS.join(',')))
    .filter((element) => !isDisabled(element) && isVisible(element));

  return candidates.find((element) => {
    const text = buttonText(element);
    if (
      text.includes('continue with email')
      || text.includes('sign in with email')
      || text.includes('log in with email')
      || text === 'email'
    ) {
      return true;
    }

    const href = `${element.getAttribute?.('href') || ''}`.toLowerCase();
    return href.includes('/auth/login') || href.includes('/auth/email/sign-in');
  }) || null;
}

function findPrimaryLoginAction() {
  const candidates = Array.from(document.querySelectorAll(ACTION_SELECTORS.join(',')))
    .filter((element) => !isDisabled(element) && isVisible(element));

  return candidates.find((element) => {
    const text = buttonText(element);
    if (text === 'login' || text === 'log in' || text === 'sign in') {
      return true;
    }

    const href = `${element.getAttribute?.('href') || ''}`.toLowerCase();
    return href.includes('/auth/login') || href.includes('/login') || href.includes('/sign-in');
  }) || null;
}

function isLoginPage() {
  return window.location.pathname.startsWith('/auth')
    || Boolean(findInput(EMAIL_SELECTORS))
    || Boolean(findInput(PASSWORD_SELECTORS))
    || Boolean(findPrimaryLoginAction())
    || Boolean(findEmailEntryAction());
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
      STATE.authTransitionAt = Number(activation.authTransitionAt || 0);
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
  STATE.authTransitionAt = Number(response?.ok && response.authorized ? response.authTransitionAt || 0 : 0);
}

function markAuthTransition() {
  const now = Date.now();
  STATE.authTransitionAt = now;
  sendRuntimeMessage({
    type: 'TOOL_HUB_MARK_AUTH_TRANSITION',
    toolSlug: TOOL_SLUG,
  }).catch(() => {});
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
  setStatus('Preparing fresh Higgsfield session');

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
        if ((response?.error || '').includes('http=404')) {
          STATE.settled = true;
        }
        return;
      }

      clearStoredLaunchTicket();
      STATE.credential = response.data?.credential || null;
      setStatus(STATE.credential ? 'Credential loaded' : 'Credential missing');
      scheduleAttempt(150);
    }
  );
}

function attemptOpenEmailLogin() {
  const emailInput = findInput(EMAIL_SELECTORS);
  const passwordInput = findInput(PASSWORD_SELECTORS);
  if (emailInput || passwordInput) return false;
  if (STATE.loginOpenAttempts >= 3) return false;

  const now = Date.now();
  const emailAction = findEmailEntryAction();
  if (emailAction) {
    if (now - STATE.lastLoginOpenAt > 3500) {
      STATE.lastLoginOpenAt = now;
      STATE.loginOpenAttempts += 1;
      setStatus('Opening Higgsfield email login');
      window.setTimeout(() => emailAction.click(), 250);
    }
    return true;
  }

  const loginAction = findPrimaryLoginAction();
  if (loginAction) {
    if (now - STATE.lastLoginOpenAt > 3500) {
      STATE.lastLoginOpenAt = now;
      STATE.loginOpenAttempts += 1;
      setStatus('Opening Higgsfield login');
      window.setTimeout(() => loginAction.click(), 250);
    }
    return true;
  }

  if (!window.location.pathname.startsWith('/auth') && now - STATE.lastLoginOpenAt > 3500) {
    STATE.lastLoginOpenAt = now;
    STATE.loginOpenAttempts += 1;
    setStatus('Redirecting to Higgsfield login');
    window.location.replace(LOGIN_URL);
    return true;
  }

  return false;
}

function findOtpInput() {
  return findInput(OTP_SELECTORS);
}

function onHiggsfieldWorkspaceHost() {
  return ['higgsfield.ai', 'www.higgsfield.ai', 'app.higgsfield.ai', 'beta.higgsfield.ai'].includes(window.location.hostname);
}

function looksLikeAuthenticatedWorkspace() {
  if (window.location.pathname.startsWith('/auth')) return false;
  if (findInput(EMAIL_SELECTORS) || findInput(PASSWORD_SELECTORS) || findOtpInput()) return false;
  if (findPrimaryLoginAction() || findEmailEntryAction()) return false;
  if (!onHiggsfieldWorkspaceHost()) return false;

  const workspaceWords = ['explore', 'image', 'video', 'audio', 'collab', 'apps', 'assist', 'community'];
  const matched = new Set();
  const candidates = Array.from(document.querySelectorAll('a, button, [role="button"], nav *'));
  for (const element of candidates) {
    const text = buttonText(element);
    if (!text) continue;
    workspaceWords.forEach((word) => {
      if (text === word || text.startsWith(`${word} `) || text.includes(` ${word} `)) {
        matched.add(word);
      }
    });
    if (matched.size >= 4) {
      return true;
    }
  }

  return false;
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
  releasePasswordSavingSuppressed(8000);

  if (hideBadgeAfterMs > 0) {
    window.setTimeout(() => {
      const badge = document.getElementById('rmw-higgsfield-autologin-status');
      if (badge) {
        badge.remove();
      }
    }, hideBadgeAfterMs);
  }
}

async function requestOtp() {
  const now = Date.now();
  if (STATE.otpFetching || STATE.otpValue) return;
  if (STATE.otpRequestAttempts >= 4) {
    setStatus('OTP fetch failed after 4 attempts');
    return;
  }
  if (now - STATE.otpLastRequestAt < OTP_FETCH_RETRY_MS) return;

  STATE.otpFetching = true;
  STATE.otpLastRequestAt = now;
  STATE.otpRequestAttempts += 1;
  setStatus(`Fetching OTP from email (attempt ${STATE.otpRequestAttempts})`);

  const response = await sendRuntimeMessage({
    type: 'TOOL_HUB_FETCH_OTP',
    toolSlug: TOOL_SLUG,
    hostname: window.location.hostname,
    pageUrl: window.location.href,
    extensionTicket: getStoredLaunchTicket(),
    otpNotBeforeMs: Number(STATE.lastSubmitAt || STATE.authTransitionAt || 0) || Date.now(),
    otpAfterUid: STATE.otpBaselineUid || undefined,
  });

  STATE.otpFetching = false;

  if (!response?.ok || !response.otp) {
    const errorMessage = `${response?.error || 'OTP not received yet'}`;
    if (errorMessage.includes('OTP already fetched')) {
      if (STATE.otpValue) {
        scheduleAttempt(100);
        return;
      }
      setStatus('OTP was already fetched for this launch. Relaunch Higgsfield from the dashboard if the code field was refreshed.');
      return;
    }
    setStatus(errorMessage);
    scheduleAttempt(2000);
    return;
  }

  STATE.otpValue = `${response.otp}`.trim();
  scheduleAttempt(100);
}

async function prepareOtpBaseline() {
  if (STATE.otpBaselinePrepared || STATE.otpBaselineFetching) return;

  STATE.otpBaselineFetching = true;
  setStatus('Preparing Higgsfield OTP lookup');
  const response = await sendRuntimeMessage({
    type: 'TOOL_HUB_PREPARE_OTP_BASELINE',
    toolSlug: TOOL_SLUG,
    hostname: window.location.hostname,
    pageUrl: window.location.href,
    extensionTicket: getStoredLaunchTicket(),
  });
  STATE.otpBaselineFetching = false;

  if (!response?.ok) {
    setStatus(response?.error || 'OTP lookup preparation failed');
    STATE.otpBaselinePrepared = true;
    scheduleAttempt(300);
    return;
  }

  STATE.otpBaselineUid = `${response.latestUid || ''}`.trim();
  STATE.otpBaselinePrepared = true;
  scheduleAttempt(50);
}

function fillOtp(otpInput, otp) {
  const normalizedOtp = `${otp || ''}`.trim();
  if (!otpInput || !normalizedOtp) {
    return;
  }

  if (otpInput.value !== normalizedOtp) {
    otpInput.focus();
    setInputValue(otpInput, normalizedOtp);
  }

  const submitButton = findSubmitButton(otpInput, null) || document.querySelector('button[type="submit"]');
  const now = Date.now();
  if (now - Number(STATE.otpSubmittedAt || 0) > OTP_SUBMIT_RETRY_MS) {
    STATE.lastSubmitAt = now;
    STATE.otpSubmittedAt = now;
    markAuthTransition();

    if (submitButton) {
      setStatus('OTP filled, verifying');
      window.setTimeout(() => {
        if (!clickAction(submitButton)) {
          submitNearestForm(otpInput) || dispatchEnterKey(otpInput);
        }
        scheduleAttempt(OTP_SUBMIT_RETRY_MS);
      }, 120);
      return;
    }

    if (submitNearestForm(otpInput)) {
      setStatus('OTP filled, submitting form');
      scheduleAttempt(OTP_SUBMIT_RETRY_MS);
      return;
    }

    if (dispatchEnterKey(otpInput)) {
      setStatus('OTP filled, submitting with Enter');
      scheduleAttempt(OTP_SUBMIT_RETRY_MS);
      return;
    }

    setStatus('OTP filled, verify action not found');
    return;
  }

  setStatus('OTP filled, retrying submit');
  scheduleAttempt(OTP_SUBMIT_RETRY_MS);
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
  if (STATE.launchExpiresAt && !STATE.launchPrepared) {
    scheduleAsyncStep(ensureFreshLaunchSession);
    return;
  }

  if (looksLikeAuthenticatedWorkspace()) {
    stopAutomation('Signed in successfully');
    return;
  }

  const emailInput = findInput(EMAIL_SELECTORS);
  const passwordInput = findInput(PASSWORD_SELECTORS);
  const otpInput = findOtpInput();
  const postSubmitAt = Math.max(
    Number(STATE.lastSubmitAt || 0),
    Number(STATE.otpSubmittedAt || 0),
    Number(STATE.authTransitionAt || 0)
  );
  const hasLoginUi = Boolean(
    emailInput
    || passwordInput
    || otpInput
    || findPrimaryLoginAction()
    || findEmailEntryAction()
  );

  if (postSubmitAt && !window.location.pathname.startsWith('/auth') && !hasLoginUi) {
    stopAutomation('Signed in successfully');
    return;
  }

  if (onHiggsfieldWorkspaceHost() && !hasLoginUi) {
    if (looksLikeAuthenticatedWorkspace()) {
      stopAutomation('Signed in successfully');
      return;
    }

    if (postSubmitAt && Date.now() - postSubmitAt < 20000) {
      setStatus('Waiting for Higgsfield workspace to finish loading');
      return;
    }
  }

  if (otpInput) {
    STATE.otpStageSeen = true;
  }
  if (
    (emailInput || passwordInput)
    && (STATE.otpValue || STATE.otpFetching || STATE.otpRequestAttempts)
    && (!postSubmitAt || Date.now() - postSubmitAt > 15000)
  ) {
    STATE.otpValue = '';
    STATE.otpFetching = false;
    STATE.otpRequestAttempts = 0;
    STATE.otpLastRequestAt = 0;
    STATE.otpBaselineUid = '';
    STATE.otpBaselineFetching = false;
    STATE.otpBaselinePrepared = false;
    STATE.otpStageSeen = false;
    STATE.otpSubmittedAt = 0;
  }

  if (!hasLoginUi && postSubmitAt && Date.now() - postSubmitAt < 20000) {
    setStatus(
      window.location.pathname.startsWith('/auth')
        ? 'Waiting for Higgsfield verification redirect'
        : 'Waiting for Higgsfield workspace to finish loading'
    );
    return;
  }

  if (!STATE.credential?.loginIdentifier || !STATE.credential?.password) {
    if (emailInput || passwordInput || findEmailEntryAction() || window.location.pathname.startsWith('/auth')) {
      requestCredential();
    }
    if (otpInput) {
      requestOtp();
      return;
    }
    attemptOpenEmailLogin();
    return;
  }

  if (emailInput && emailInput.value !== STATE.credential.loginIdentifier) {
    emailInput.focus();
    setInputValue(emailInput, STATE.credential.loginIdentifier);
  }

  if (passwordInput && !STATE.passwordSavingSuppressed) {
    requestPasswordSavingSuppression();
    return;
  }

  if (passwordInput && passwordInput.value !== STATE.credential.password) {
    passwordInput.focus();
    setInputValue(passwordInput, STATE.credential.password);
  }

  if (!emailInput && !passwordInput) {
    if (otpInput) {
      if (!STATE.otpValue) {
        requestOtp();
        setStatus(STATE.otpFetching ? 'Fetching OTP from email' : 'Waiting for OTP code');
        return;
      }

      fillOtp(otpInput, STATE.otpValue);
      return;
    }

    attemptOpenEmailLogin();
    setStatus('Waiting for Higgsfield login field');
    return;
  }

  const readyForSubmit = (!emailInput || emailInput.value) && (!passwordInput || passwordInput.value);
  if (!readyForSubmit) {
    setStatus('Waiting for credential fields');
    return;
  }

  if (!STATE.otpBaselinePrepared) {
    prepareOtpBaseline().catch((error) => {
      STATE.otpBaselineFetching = false;
      STATE.otpBaselinePrepared = true;
      setStatus(error?.message || 'OTP lookup preparation failed');
      scheduleAttempt(300);
    });
    setStatus(STATE.otpBaselineFetching ? 'Preparing Higgsfield OTP lookup' : 'Starting Higgsfield OTP lookup');
    return;
  }

  const now = Date.now();
  const submitButton = findSubmitButton(emailInput, passwordInput);
  if (!submitButton) {
    setStatus('Credential filled, sign-in button not found');
    return;
  }

  if (now - STATE.lastSubmitAt > 3000) {
    STATE.lastSubmitAt = now;
    markAuthTransition();
    setStatus('Credential filled, signing in');
    window.setTimeout(() => {
      clickAction(submitButton);
      requestOtp();
      scheduleAttempt(500);
    }, 350);
    return;
  }

  setStatus('Credential filled');
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
    })
    .finally(() => {
      STATE.settled = false;
      scheduleAttempt(0);
    });
}

start();

// =====================================================================
// ---- Generation Capture (added alongside the login automation above,
// without disturbing STATE/attemptFill()'s own loop) ----
//
// Mirrors content-heygen.js's capture design (this package's template, not
// Freepik's - Higgsfield, like HeyGen, is a single-preset-per-click video
// generator with multiple distinct capture-worthy actions, not a
// multi-model-per-prompt image tool). No real Higgsfield network traffic or
// DOM structure has been observed while building this - only one UI
// screenshot (Create Video tab: image upload, "Seedance Pro" preset picker
// with a "Change" button, a Multi-shot toggle, a Prompt textarea with
// "Enhance on", a "Generate ⚡4" button showing an inline credit cost).
// Every DOM reader below is a best-effort heuristic with several fallback
// selectors, not a precise, confirmed mapping - tighten these once the
// extension has run against the real page, same posture HeyGen shipped
// with on 2026-08-04.
// =====================================================================

function collectUniqueElements(elements) {
  return Array.from(new Set(elements.filter(Boolean)));
}

// ---- On-page live-capture status badge (separate from the autologin status
// badge above - this one reflects generation-capture progress, not login) ----

let higgsfieldCaptureStatusHideTimer = null;

function ensureHiggsfieldCaptureStatusBadge() {
  const existing = document.getElementById('rmw-higgsfield-capture-status');
  if (existing) return existing;
  const badge = document.createElement('div');
  badge.id = 'rmw-higgsfield-capture-status';
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

function setHiggsfieldCaptureStatus(message, { autoHideMs } = {}) {
  const badge = ensureHiggsfieldCaptureStatusBadge();
  badge.textContent = `Higgsfield capture\n${message}`;
  badge.style.display = 'block';
  if (higgsfieldCaptureStatusHideTimer) {
    window.clearTimeout(higgsfieldCaptureStatusHideTimer);
    higgsfieldCaptureStatusHideTimer = null;
  }
  if (autoHideMs) {
    higgsfieldCaptureStatusHideTimer = window.setTimeout(() => { badge.style.display = 'none'; }, autoHideMs);
  }
}

function hideHiggsfieldCaptureStatus() {
  const badge = document.getElementById('rmw-higgsfield-capture-status');
  if (badge) badge.style.display = 'none';
}

// ---- DOM scraping helpers ----

function higgsfieldElementText(element) {
  if (!element) return '';
  return `${element.innerText || element.textContent || ''}`.trim();
}

// Finds a heading/label-like element whose own (direct, non-descendant) text
// matches labelRe, then reads a nearby value from either a sibling element or
// a descendant of the label's parent container - same "Label \n Value" panel
// row heuristic as content-heygen.js's readHeygenLabeledValue.
function readHiggsfieldLabeledValue(labelRe, { maxDepth = 4 } = {}) {
  const candidates = Array.from(document.querySelectorAll('label, h1, h2, h3, h4, p, span, div'));
  for (const label of candidates) {
    const ownText = Array.from(label.childNodes)
      .filter((node) => node.nodeType === Node.TEXT_NODE)
      .map((node) => node.textContent)
      .join(' ')
      .trim();
    const text = ownText || higgsfieldElementText(label);
    if (!text || text.length > 60 || !labelRe.test(text)) continue;

    let sibling = label.nextElementSibling;
    if (sibling) {
      const siblingText = higgsfieldElementText(sibling);
      if (siblingText && siblingText.length < 200) return siblingText;
    }
    let container = label.parentElement;
    let depth = 0;
    while (container && depth < maxDepth) {
      const containerText = higgsfieldElementText(container);
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

function readHiggsfieldPromptText() {
  const labeled = Array.from(document.querySelectorAll('h1, h2, h3, h4, [class*="header" i], [class*="title" i], label'))
    .find((el) => /^prompt$/i.test(higgsfieldElementText(el)));
  if (labeled) {
    const container = labeled.closest('[class*="prompt" i]') || labeled.parentElement;
    const field = container?.querySelector('[contenteditable="true"], textarea');
    const text = higgsfieldElementText(field);
    if (text) return text;
  }
  // Broad fallback: any contenteditable/textarea that looks like a prompt
  // input rather than a search box or comment field.
  const fallback = Array.from(document.querySelectorAll('[contenteditable="true"], textarea'))
    .find((el) => isVisible(el) && !/search|comment/i.test(el.getAttribute('placeholder') || el.getAttribute('aria-label') || ''));
  return higgsfieldElementText(fallback);
}

// Reference screenshot shape: a preset picker card showing the preset's own
// name (e.g. "Seedance Pro") next to a "Change" button.
function readHiggsfieldPreset() {
  const changeButton = Array.from(document.querySelectorAll(ACTION_SELECTORS.join(',')))
    .find((el) => isVisible(el) && buttonText(el) === 'change');
  const container = changeButton?.closest('[class*="preset" i]') || changeButton?.parentElement;
  const name = higgsfieldElementText(container)?.replace(/change/i, '').trim()
    || readHiggsfieldLabeledValue(/^preset$/i)
    || null;
  return { id: null, name: name || null, category: null };
}

function readHiggsfieldToggleState(labelRe) {
  const labeled = Array.from(document.querySelectorAll('label, [class*="toggle" i], [class*="switch" i], div, span'))
    .find((el) => labelRe.test(higgsfieldElementText(el)) && higgsfieldElementText(el).length < 60);
  if (!labeled) return null;
  const container = labeled.closest('[class*="toggle" i], [class*="switch" i]') || labeled;
  const input = container.querySelector?.('input[type="checkbox"], input[role="switch"], [role="switch"]');
  if (input) {
    if (typeof input.checked === 'boolean') return input.checked;
    const ariaChecked = input.getAttribute?.('aria-checked');
    if (ariaChecked) return ariaChecked === 'true';
  }
  return /\bon\b/i.test(higgsfieldElementText(container));
}

function readHiggsfieldMultiShot() {
  return readHiggsfieldToggleState(/multi[-\s]?shot/i);
}

function readHiggsfieldEnhancePrompt() {
  return readHiggsfieldToggleState(/enhance/i);
}

function readHiggsfieldImageReferenceUrl() {
  const image = Array.from(document.querySelectorAll('img[src]'))
    .find((el) => isVisible(el) && el.closest('[class*="upload" i], [class*="reference" i], [class*="preset" i]'));
  return image?.getAttribute('src') || null;
}

// Expected-credit chip shown directly on the clicked button itself (the
// "⚡4" suffix on the "Generate" button in the reference screenshot), same
// reasoning as content-heygen.js's readHeygenExpectedCredits but tried
// against the button's OWN text first, since Higgsfield's cost appears to be
// inline with the label rather than a separate nearby chip.
function readHiggsfieldExpectedCredits(button) {
  if (!button) return null;
  const ownMatch = buttonText(button).match(/(\d+(?:\.\d+)?)\s*$/);
  if (ownMatch) {
    const value = Number(ownMatch[1]);
    if (Number.isFinite(value)) return value;
  }
  const container = button.closest('[class*="panel" i]') || button.parentElement;
  const scope = container || button;
  const chip = Array.from(scope.querySelectorAll('*')).find((el) => {
    const text = higgsfieldElementText(el);
    return text && /^\d+(\.\d+)?$/.test(text) && el.childElementCount === 0;
  });
  const value = chip ? Number(higgsfieldElementText(chip)) : NaN;
  return Number.isFinite(value) ? value : null;
}

// ---- Generate / Edit Video / Motion Control click detection ----
//
// Mirrors content-heygen.js's findHeygenActionTarget - a capturing-phase
// ancestor walk that only ever accepts a real button/link/role=button
// ancestor, never a form field, never a fallback to the raw clicked node.
// `kind` is derived from the matched button's own text (mirrors HeyGen's
// "render" vs default split): "edit video"/"motion control" phrasing maps
// to their own kind, anything else (the bare "Generate" button, per the
// Create Video tab screenshot) defaults to create_video.

const HIGGSFIELD_GATE_EXCLUDED_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT', 'OPTION']);
const HIGGSFIELD_ACTION_TEXT_RE = /(^|\s)(generate|edit\s*video|motion\s*control)($|\s)/i;

function findHiggsfieldActionButtonAncestor(element) {
  let current = element;
  while (current && current !== document.body) {
    if (
      !HIGGSFIELD_GATE_EXCLUDED_TAGS.has(current.tagName)
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

function collectHiggsfieldInteractionCandidateElements(target) {
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

function higgsfieldButtonDescriptorText(element) {
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

function findHiggsfieldActionTarget(target) {
  const candidates = collectUniqueElements(
    collectHiggsfieldInteractionCandidateElements(target).map((element) => findHiggsfieldActionButtonAncestor(element))
  );
  for (const candidate of candidates) {
    if (!candidate) continue;
    const text = higgsfieldButtonDescriptorText(candidate);
    if (!text || text.length > 60) continue;
    if (!HIGGSFIELD_ACTION_TEXT_RE.test(text)) continue;
    let kind = 'create_video';
    if (/edit\s*video/i.test(text)) kind = 'edit_video';
    else if (/motion\s*control/i.test(text)) kind = 'motion_control';
    return { target: candidate, kind };
  }
  return null;
}

// ---- Task/Client gate ----
//
// Mirrors content-heygen.js's runHeygenTaskGate exactly - block the real
// click, open the picker, re-dispatch a synthetic click flagged to bypass
// re-gating once a task/client is chosen.

let higgsfieldTaskGateBypassTarget = null;
let higgsfieldTaskGateModalOpen = false;
let higgsfieldPendingTaskSelection = null; // {taskId, taskName, clientId, clientName} - consumed by armHiggsfieldGeneration()
let higgsfieldPendingActionKind = null; // 'create_video' | 'edit_video' | 'motion_control' - the kind of the click currently being gated

async function runHiggsfieldTaskGate(target) {
  if (higgsfieldTaskGateModalOpen) return; // double-click while the modal is already open - no-op
  higgsfieldTaskGateModalOpen = true;
  try {
    const selection = await openHiggsfieldTaskSelectionModal();
    if (!selection) return; // cancelled/ESC/no active tasks - click stays blocked
    higgsfieldPendingTaskSelection = selection;
    higgsfieldTaskGateBypassTarget = target;
    target.click();
  } finally {
    higgsfieldTaskGateModalOpen = false;
  }
}

document.addEventListener('click', (event) => {
  try {
    const match = findHiggsfieldActionTarget(event.target);
    if (!match) return;
    const { target, kind } = match;

    if (higgsfieldTaskGateBypassTarget === target) {
      higgsfieldTaskGateBypassTarget = null; // one-shot: next action click gates again
      armHiggsfieldGeneration(kind, target);
      return; // let the (re-dispatched) click reach Higgsfield's own handler
    }

    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    higgsfieldPendingActionKind = kind;
    runHiggsfieldTaskGate(target);
  } catch {}
}, true); // capturing phase - fires even if the page's own handler stops propagation

// ---- Arm/disarm live-capture state machine ----
//
// Ports content-heygen.js's heygenActiveGeneration design (armed by a real
// click, validated by expiry, not inferred from data shape) - see that
// file's own comment block for the full rationale. capturedIdentities plays
// the same role as HeyGen's own field of the same name.

const HIGGSFIELD_ARM_MAX_DURATION_MS = 10 * 60 * 1000; // generous for slow video renders
const HIGGSFIELD_ARM_QUIET_PERIOD_MS = 90 * 1000; // disarm 90s after the last qualifying signal

// { generateIntentId, kind, armedAt, expiresAt, capturedIdentities: Map, taskId, taskName, clientId, clientName, submitSnapshot }
let higgsfieldActiveGeneration = null;
let higgsfieldArmQuietTimer = null;
let higgsfieldArmMaxTimer = null;

function clearHiggsfieldArmTimers() {
  if (higgsfieldArmQuietTimer) { window.clearTimeout(higgsfieldArmQuietTimer); higgsfieldArmQuietTimer = null; }
  if (higgsfieldArmMaxTimer) { window.clearTimeout(higgsfieldArmMaxTimer); higgsfieldArmMaxTimer = null; }
}

function higgsfieldGenerationLinkLabel(generation) {
  if (!generation) return '';
  const parts = [];
  if (generation.taskName) parts.push(`Task: ${generation.taskName}`);
  if (generation.clientName) parts.push(`Client: ${generation.clientName}`);
  return parts.length ? ` (${parts.join(', ')})` : '';
}

function disarmHiggsfieldGeneration() {
  clearHiggsfieldArmTimers();
  const hadCaptures = Boolean(higgsfieldActiveGeneration && higgsfieldActiveGeneration.capturedIdentities.size > 0);
  const linkLabel = higgsfieldGenerationLinkLabel(higgsfieldActiveGeneration);
  stopHiggsfieldAssetDetection();
  higgsfieldActiveGeneration = null;
  if (hadCaptures) {
    setHiggsfieldCaptureStatus(`Capture complete ✓${linkLabel}`, { autoHideMs: 6000 });
  } else {
    hideHiggsfieldCaptureStatus();
  }
}

function scheduleHiggsfieldArmQuietReset() {
  if (higgsfieldArmQuietTimer) window.clearTimeout(higgsfieldArmQuietTimer);
  higgsfieldArmQuietTimer = window.setTimeout(disarmHiggsfieldGeneration, HIGGSFIELD_ARM_QUIET_PERIOD_MS);
}

function isHiggsfieldGenerationArmed() {
  return Boolean(higgsfieldActiveGeneration) && Date.now() <= higgsfieldActiveGeneration.expiresAt;
}

function buildHiggsfieldSubmitSnapshot(button, kind) {
  return {
    promptText: readHiggsfieldPromptText() || null,
    preset: readHiggsfieldPreset(),
    multiShot: readHiggsfieldMultiShot(),
    enhancePrompt: readHiggsfieldEnhancePrompt(),
    imageReferenceUrl: readHiggsfieldImageReferenceUrl(),
    videoConfig: {
      resolution: null,
      aspectRatio: null,
      fps: null,
      duration: null,
      quality: null,
    },
    credits: {
      before: null,
      after: null,
      used: null,
      // The chip captured here is the button's EXPECTED cost, not an actual
      // debit - stored under its own top-level key (expectedCredits) rather
      // than credits.used, which stays null until a real before/after
      // balance or network-observed debit is seen. Same reasoning as
      // content-heygen.js's buildHeygenSubmitSnapshot.
    },
    expectedCredits: readHiggsfieldExpectedCredits(button),
    kind,
    status: 'submitted',
  };
}

function armHiggsfieldGeneration(kind, button) {
  const now = Date.now();
  const pendingSelection = higgsfieldPendingTaskSelection;
  higgsfieldPendingTaskSelection = null;
  higgsfieldPendingActionKind = null;

  const submitSnapshot = buildHiggsfieldSubmitSnapshot(button, kind);

  if (isHiggsfieldGenerationArmed()) {
    // A second action click while still waiting on a prior one extends the
    // existing session rather than resetting capturedIdentities, so
    // in-flight tracking for the first render isn't lost - same reasoning as
    // content-heygen.js's armHeygenGeneration.
    if (pendingSelection) {
      higgsfieldActiveGeneration.taskId = pendingSelection.taskId;
      higgsfieldActiveGeneration.taskName = pendingSelection.taskName;
      higgsfieldActiveGeneration.clientId = pendingSelection.clientId;
      higgsfieldActiveGeneration.clientName = pendingSelection.clientName;
    }
    scheduleHiggsfieldArmQuietReset();
    setHiggsfieldCaptureStatus(`Waiting for generation…${higgsfieldGenerationLinkLabel(higgsfieldActiveGeneration)}`);
  } else {
    clearHiggsfieldArmTimers();
    higgsfieldActiveGeneration = {
      generateIntentId: `hfgen_${now}_${Math.random().toString(36).slice(2, 8)}`,
      kind,
      armedAt: now,
      expiresAt: now + HIGGSFIELD_ARM_MAX_DURATION_MS,
      capturedIdentities: new Map(),
      taskId: pendingSelection?.taskId ?? null,
      taskName: pendingSelection?.taskName ?? null,
      clientId: pendingSelection?.clientId ?? null,
      clientName: pendingSelection?.clientName ?? null,
      submitSnapshot,
    };
    higgsfieldArmMaxTimer = window.setTimeout(disarmHiggsfieldGeneration, HIGGSFIELD_ARM_MAX_DURATION_MS);
    scheduleHiggsfieldArmQuietReset();
    setHiggsfieldCaptureStatus(`Waiting for generation…${higgsfieldGenerationLinkLabel(higgsfieldActiveGeneration)}`);
    console.debug('[RMW Higgsfield Capture] armed', {
      generateIntentId: higgsfieldActiveGeneration.generateIntentId, kind,
      taskId: higgsfieldActiveGeneration.taskId, clientId: higgsfieldActiveGeneration.clientId,
    });
  }

  // reportHiggsfieldCaptureEvent's `identity` argument is only ever used to
  // compute the client-side dedupe key (clientEventId) and pick out
  // generation_id/project_id as their own DB columns - job_id/request_id/
  // external_event_id are NEVER forwarded separately (see
  // ingest_capture_event's signature in providers/higgsfield/capture.py).
  // normalize_capture_event's _extract_fields reads external_event_id
  // exclusively out of payload_json, so unless the id is embedded directly
  // in the payload object itself, the backend can never see it - same
  // lesson content-heygen.js's armHeygenGeneration already paid for once.
  submitSnapshot.externalEventId = higgsfieldActiveGeneration.generateIntentId;

  // The "submitted" event is sent immediately, synchronously with the click -
  // per the spec's "never wait until generation finishes" rule - regardless
  // of whether this extended an existing arm or started a fresh one, so
  // every click the user actually made produces its own pending record.
  reportHiggsfieldCaptureEvent({
    eventType: kind === 'edit_video' ? 'edit_video_click' : kind === 'motion_control' ? 'motion_control_click' : 'video_generate_click',
    isReconciliation: false,
    payload: submitSnapshot,
    identity: { externalEventId: higgsfieldActiveGeneration.generateIntentId },
    changeToken: 'submitted',
  });

  startHiggsfieldAssetDetection();
}

// ---- Reporting ----

function higgsfieldChangeToken(payload) {
  return payload?.status || payload?.updatedAt || 'unknown';
}

async function reportHiggsfieldCaptureEvent({ eventType, isReconciliation, payload, identity, changeToken }) {
  const generationId = identity?.generationId ? String(identity.generationId) : '';
  const jobId = identity?.jobId ? String(identity.jobId) : '';
  const requestId = identity?.requestId ? String(identity.requestId) : '';
  const externalEventId = identity?.externalEventId ? String(identity.externalEventId) : '';
  const primaryId = generationId || jobId || requestId || externalEventId || `rand:${Math.random().toString(36).slice(2)}`;
  // MUST change whenever the payload's actual content changes (a "submitted"
  // snapshot later becoming "completed" with real output) - see
  // content-heygen.js's reportHeygenCaptureEvent for the "stuck with no
  // preview" bug this exact design prevents.
  const token = changeToken || higgsfieldChangeToken(payload);
  const clientEventId = `higgsfield:${primaryId}:${token}`;

  try {
    const result = await sendRuntimeMessage({
      type: 'HIGGSFIELD_CAPTURE_EVENT',
      event: {
        event_type: eventType,
        client_event_id: clientEventId,
        generation_id: generationId || null,
        project_id: identity?.projectId ? String(identity.projectId) : null,
        is_reconciliation: Boolean(isReconciliation),
        payload,
        capture_version: 1,
        linked_task_id: !isReconciliation && higgsfieldActiveGeneration ? higgsfieldActiveGeneration.taskId : null,
        linked_client_id: !isReconciliation && higgsfieldActiveGeneration ? higgsfieldActiveGeneration.clientId : null,
      },
    });
    if (result?.ok) {
      console.debug('[RMW Higgsfield Capture] reported event', { eventType, primaryId, queued: result.queued });
      // "Queued", not "Saved" - result.ok only confirms the local background
      // queue accepted it; the actual server upload happens later via the
      // batched flush (best-effort, see background-higgsfield-capture.js).
      setHiggsfieldCaptureStatus('Queued for upload…');
    } else {
      console.warn('[RMW Higgsfield Capture] failed to report event', { eventType, primaryId, error: result?.error });
      setHiggsfieldCaptureStatus(`Capture failed: ${result?.error || 'unknown error'}`, { autoHideMs: 8000 });
    }
  } catch (error) {
    console.warn('[RMW Higgsfield Capture] unexpected error reporting event', { eventType, error: error?.message || error });
  }
}

// ---- Network-relay: content-higgsfield-network.js's intercepted rows ----

function higgsfieldRowIdentity(row) {
  return {
    generationId: row?.generationId ?? row?.generation_id ?? row?.id ?? null,
    // job_set_id: the real, confirmed "job set" detail response's own field
    // name for the batch a multi-shot generation's several jobs share (see
    // content-higgsfield-network.js's looksLikeHiggsfieldJobDetailObject and
    // providers/higgsfield/normalization.py's module docstring) - checked
    // after jobId/job_id (still-guessed key names), never instead of them.
    jobId: row?.jobId ?? row?.job_id ?? row?.job_set_id ?? null,
    requestId: row?.requestId ?? row?.request_id ?? null,
    projectId: row?.projectId ?? row?.project_id ?? null,
  };
}

function isHiggsfieldRowSettled(row) {
  const status = `${row?.status || ''}`.toLowerCase();
  if (['completed', 'failed', 'cancelled'].includes(status)) return true;
  const output = row?.output || {};
  return Boolean(row?.videoUrl || row?.video_url || output.videoUrl || output.video_url);
}

function onHiggsfieldNetworkMessage(event) {
  if (event.source !== window) return;
  const data = event.data;
  if (!data || data.source !== 'rmw-higgsfield-network-telemetry' || data.type !== 'HIGGSFIELD_NETWORK_GENERATION') return;
  const rows = data.payload && Array.isArray(data.payload.rows) ? data.payload.rows : [];
  const transport = (data.payload && data.payload.transport) || 'http';
  // 'proactive' (2026-08-06): content-higgsfield-network.js's
  // onJobDetailFetchRequest tags its OWN successful fetches this way,
  // distinct from 'http' (a passively-intercepted response to some fetch/XHR
  // the PAGE itself issued). The arm-gate below exists to stop a passive
  // sighting from being misattributed to whoever's tab happened to be armed
  // - it was never meant to apply here, since a 'proactive' row is one WE
  // explicitly asked for by id (via queueHiggsfieldJobDetailLookup, either
  // from a live-armed click above or from enqueueHiggsfieldDetailEnrichment's
  // historical backfill queue). Real bug this fixed (found 2026-08-06 via
  // Sarbjeet's own console + a direct DB check): every enrichment fetch for
  // a historical (never-armed) asset was succeeding all the way through
  // content-higgsfield-network.js and STILL being silently dropped right
  // here, because the row's identity was neither armed nor already tracked -
  // the fetch worked, the result just never got reported.
  const isProactive = transport === 'proactive';

  rows.forEach((row) => {
    const identity = higgsfieldRowIdentity(row);
    const hasIdentity = identity.generationId || identity.jobId || identity.requestId;

    // Only a direct fetch/XHR response (issued by THIS tab) may originate a
    // brand-new identity claim - a push-channel sighting is left unattributed
    // rather than credited to whoever's tab happened to be armed, same
    // reasoning as content-heygen.js's onHeygenNetworkMessage. A 'proactive'
    // row always qualifies (see comment above), bypassing this arm-gate
    // entirely.
    if (!hasIdentity) return;
    const idKey = String(identity.generationId || identity.jobId || identity.requestId);
    const alreadyTracked = higgsfieldActiveGeneration?.capturedIdentities.has(idKey);
    const armed = isHiggsfieldGenerationArmed();
    if (!isProactive) {
      if (!armed && !alreadyTracked) {
        if (transport !== 'http') return;
        // Un-armed and never-before-seen: nothing currently claims this row.
        // No reconciliation walker exists yet in this pass (see this section's
        // top comment) so an un-armed sighting is simply not reported - it will
        // be picked up once the recovery/reconciliation follow-up lands.
        return;
      }
      if (transport !== 'http' && !alreadyTracked) return;
    }

    const settled = isHiggsfieldRowSettled(row);
    // Only bookkeep against the currently-armed generation for rows that are
    // actually part of ITS OWN capture - a 'proactive' historical backfill
    // row must never pollute an unrelated live generation's capturedIdentities
    // just because one happens to be armed at the same moment.
    if (!isProactive && higgsfieldActiveGeneration) {
      higgsfieldActiveGeneration.capturedIdentities.set(idKey, { settled });
      scheduleHiggsfieldArmQuietReset();
    }
    if (settled && identity.generationId) {
      // No longer passed an id - see queueHiggsfieldCreditLedgerLookup's own
      // comment; a settled generation just nudges the next sweep sooner.
      queueHiggsfieldCreditLedgerLookup();
    }
    // Fires as soon as a real id is known, not gated on settled - see
    // queueHiggsfieldJobDetailLookup's own comment for why earlier is
    // better here (a fresh bearer token, not a batching concern).
    if (identity.generationId) {
      queueHiggsfieldJobDetailLookup(String(identity.generationId));
    }

    // A background historical-backfill result finishing shouldn't flash the
    // on-page "Capturing…" badge that's meant to reflect the user's OWN
    // in-progress generation.
    if (!isProactive) {
      setHiggsfieldCaptureStatus(settled ? 'Capturing…' : 'Generation detected — rendering…');
    }
    // Same payload-embedding requirement as armHiggsfieldGeneration's
    // submitSnapshot.externalEventId above - without this, this
    // network-observed row (which DOES carry a real generation/job/request
    // id) creates a brand-new HiggsfieldGeneration from scratch instead of
    // merging into the one the "submitted" click already started, so the
    // DOM-scraped prompt/preset data on that first row is permanently
    // orphaned. Never applies to a 'proactive' row - it has no submitted
    // click of its own to merge into.
    const networkPayload = (!isProactive && higgsfieldActiveGeneration)
      ? { ...row, externalEventId: higgsfieldActiveGeneration.generateIntentId }
      : row;
    reportHiggsfieldCaptureEvent({
      eventType: 'network_snapshot',
      // A proactive fetch for an armed generation's own id (the live path,
      // unchanged from before) still reports as live capture; one for
      // anything else (the historical backfill case) reports as
      // reconciliation - same ownership-freshness gate every other
      // reconciliation row already goes through server-side.
      isReconciliation: isProactive ? !(armed && alreadyTracked) : false,
      payload: networkPayload,
      identity,
      changeToken: higgsfieldChangeToken(row),
    });
  });
}

window.addEventListener('message', onHiggsfieldNetworkMessage);

// ---- Reconciliation: content-higgsfield-network.js's passively-observed
// listing rows (no confirmed Higgsfield history/listing endpoint yet - see
// that file's own comment) ----
//
// Deliberately its own message type and its own handler, never merged into
// onHiggsfieldNetworkMessage above - that function's whole design is
// "attribute to whichever generation is currently armed", which is exactly
// wrong for a listing response that can contain dozens of OLD, unrelated
// videos. Every row here is reported with isReconciliation: true
// unconditionally, which makes reportHiggsfieldCaptureEvent send
// linked_task_id/linked_client_id as null regardless of arm state, and makes
// the backend's ownership-freshness gate
// (normalization.py's _is_fresh_enough_for_attribution, keyed off each row's
// own real created_ts) the only thing that can ever resolve ownership for
// these rows - never "whoever's tab happened to have it open". Scaffolded
// the same way content-heygen.js's own listing handler started, before its
// listing endpoint was confirmed.
// Per-page-load dedup for listing rows only (job-detail/credit-ledger
// lookups already have their own Sets below) - the periodic proactive sweep
// (see queueHiggsfieldAssetListingSweep further down) re-fetches the SAME
// ~300 rows every few minutes on purpose (it has no cursor/since-id to ask
// for only new ones), and every field on a finished asset row is immutable
// once created, so there is nothing to gain from re-reporting an id already
// seen this page load - the server would just bucket it as "duplicate"
// anyway, this just saves the round trip and local queue churn.
const higgsfieldListingRowsReported = new Set();

function onHiggsfieldNetworkListingMessage(event) {
  if (event.source !== window) return;
  const data = event.data;
  if (!data || data.source !== 'rmw-higgsfield-network-telemetry' || data.type !== 'HIGGSFIELD_NETWORK_LISTING') return;
  const rows = data.payload && Array.isArray(data.payload.rows) ? data.payload.rows : [];

  rows.forEach((row) => {
    const identity = higgsfieldRowIdentity(row);
    if (!(identity.generationId || identity.jobId || identity.requestId)) return;
    const dedupeKey = String(identity.generationId || identity.jobId || identity.requestId);
    if (higgsfieldListingRowsReported.has(dedupeKey)) return;
    higgsfieldListingRowsReported.add(dedupeKey);
    if (isHiggsfieldRowSettled(row) && identity.generationId) {
      queueHiggsfieldCreditLedgerLookup(String(identity.generationId));
    }
    // The listing row itself has no prompt/params - only the detail
    // endpoint does (see enqueueHiggsfieldDetailEnrichment's own comment for
    // why this is throttled rather than fired immediately like
    // onHiggsfieldNetworkMessage's live-armed path does above).
    if (identity.generationId) {
      enqueueHiggsfieldDetailEnrichment(String(identity.generationId));
    }
    reportHiggsfieldCaptureEvent({
      eventType: 'generation_listing_row',
      isReconciliation: true,
      payload: row,
      identity,
      changeToken: higgsfieldChangeToken(row),
    });
  });
}

window.addEventListener('message', onHiggsfieldNetworkListingMessage);

// ---- Reconciliation: content-higgsfield-network.js's passively-observed
// credit ledger rows (no confirmed Higgsfield credit endpoint yet) ----
//
// A completely different (unconfirmed) Higgsfield endpoint from the video
// listing above, and deliberately reported as its own thin, minimal payload
// rather than merged into a full generation snapshot - a ledger row would
// only ever tell us "generation X consumed N credits", never prompt/preset/
// status/etc, so there is nothing else honest to put in this payload.
// normalize_capture_event merges metadata_json instead of replacing it
// wholesale specifically so a thin event like this can never blow away the
// richer snapshot the listing/live capture already stored for the same
// generation_id (see normalization.py).
// Real shape (CONFIRMED 2026-08-06, see content-higgsfield-network.js's
// hasCreditLedgerShape): {tx_id, display_name, workflow_id, total_credits,
// action, cost_breakdown, created_at}. No generation_id/job_id/request_id -
// tx_id is the row's own stable identity (used as external_event_id so
// re-sweeps of the same history dedupe cleanly instead of minting a random
// clientEventId every time - see reportHiggsfieldCaptureEvent's own
// fallback chain), workflow_id is a possible-but-usually-null exact link.
// Matching a row to a specific generation when workflow_id is null (the
// common case) happens entirely server-side in normalization.py - this
// handler's only job is forwarding every row raw and exactly once per page
// load, same "never guess client-side, the backend has the full picture"
// reasoning as everywhere else in this file.
const higgsfieldCreditLedgerRowsReported = new Set();

function onHiggsfieldNetworkCreditLedgerMessage(event) {
  if (event.source !== window) return;
  const data = event.data;
  if (!data || data.source !== 'rmw-higgsfield-network-telemetry' || data.type !== 'HIGGSFIELD_NETWORK_CREDIT_LEDGER') return;
  const rows = data.payload && Array.isArray(data.payload.rows) ? data.payload.rows : [];

  rows.forEach((row) => {
    const txId = typeof row?.tx_id === 'string' ? row.tx_id : '';
    if (!txId || higgsfieldCreditLedgerRowsReported.has(txId)) return;
    higgsfieldCreditLedgerRowsReported.add(txId);
    const workflowId = typeof row?.workflow_id === 'string' ? row.workflow_id : '';
    reportHiggsfieldCaptureEvent({
      eventType: 'credit_ledger_row',
      isReconciliation: true,
      payload: row,
      identity: { generationId: workflowId || null, externalEventId: txId },
      // Immutable once created (a ledger transaction never changes after
      // the fact) - a stable, not-'unknown' token so a re-sweep's repeat of
      // the SAME row is recognized as identical rather than treated as a
      // (harmless but pointless) "updated" snapshot.
      changeToken: 'ledger',
    });
  });
}

window.addEventListener('message', onHiggsfieldNetworkCreditLedgerMessage);

// ---- Proactive credit-ledger sweep (2026-08-06) ----
//
// Was originally scaffolded as a per-generation batched lookup (mirroring
// HeyGen's movio_bill.list?action_ids=... convention) before the real
// endpoint was confirmed - that assumption doesn't hold: the real ledger
// endpoint (GET .../fnf/workspaces/credit-ledger) is a plain paginated
// history with no per-generation filter at all, so there is nothing to
// batch by id. Replaced with the same periodic-sweep shape as the Assets
// listing sweep above: fires once shortly after page load, then on a
// repeating timer, independent of what the user is doing - a generation
// settling (see the two queueHiggsfieldCreditLedgerLookup call sites above,
// now just a debounced "sweep soon" trigger) still nudges an earlier sweep
// rather than waiting for the next scheduled tick, since a fresh spend is
// likely to already be in the ledger within seconds of settling.
const HIGGSFIELD_CREDIT_LEDGER_SWEEP_INITIAL_DELAY_MS = 8 * 1000; // staggered after the asset-listing sweep's 5s, not simultaneous
const HIGGSFIELD_CREDIT_LEDGER_SWEEP_INTERVAL_MS = 6 * 60 * 1000;
const HIGGSFIELD_CREDIT_LEDGER_SETTLED_DEBOUNCE_MS = 3 * 1000;
let higgsfieldCreditLedgerSweepTimer = null;

function queueHiggsfieldCreditLedgerSweep() {
  try {
    window.postMessage({
      source: 'rmw-higgsfield-network-telemetry',
      type: 'HIGGSFIELD_REQUEST_CREDIT_LEDGER',
      payload: {},
    }, location.origin);
  } catch {}
}

// Called from onHiggsfieldNetworkMessage/onHiggsfieldNetworkListingMessage
// when a generation is observed settling - debounced (not immediate) since
// several generations can settle in a short burst and each only needs to
// trigger ONE nearby sweep, not one apiece.
function queueHiggsfieldCreditLedgerLookup() {
  if (higgsfieldCreditLedgerSweepTimer) return;
  higgsfieldCreditLedgerSweepTimer = window.setTimeout(() => {
    higgsfieldCreditLedgerSweepTimer = null;
    queueHiggsfieldCreditLedgerSweep();
  }, HIGGSFIELD_CREDIT_LEDGER_SETTLED_DEBOUNCE_MS);
}

window.setTimeout(queueHiggsfieldCreditLedgerSweep, HIGGSFIELD_CREDIT_LEDGER_SWEEP_INITIAL_DELAY_MS);
window.setInterval(queueHiggsfieldCreditLedgerSweep, HIGGSFIELD_CREDIT_LEDGER_SWEEP_INTERVAL_MS);

// ---- Proactive job-detail fetch (2026-08-05) ----
//
// Closes the gap Sarbjeet flagged (2026-08-05): the confirmed job-detail
// endpoint (GET .../fnf/assets/{id}/detail - see
// content-higgsfield-network.js's looksLikeHiggsfieldJobDetailObject) is
// otherwise only ever fetched by the Higgsfield page itself when a user
// plays/opens a specific generation, so anything the user never replays
// in-app would stay on the thinner DOM-scraped submit snapshot forever.
//
// Unlike queueHiggsfieldCreditLedgerLookup above (which batches many ids
// into ONE request, because that endpoint accepts a comma-separated list),
// this endpoint is per-resource (GET .../assets/{id}/detail) - there is
// nothing to batch, so each id fires its own postMessage, no debounce
// timer. Triggered as early as any real generation_id/job_id/request_id is
// observed for the still-armed generation (not gated on "settled" the way
// the credit-ledger lookup is) - the earlier a real id is known, the
// earlier content-higgsfield-network.js can attempt the proactive fetch
// while its captured bearer token is still fresh, and if the job isn't
// finished yet the detail endpoint's own response simply reflects that
// (harmless - it just gets superseded by a later, richer snapshot, same
// stale-snapshot handling every other network_snapshot event already has
// via normalization.py's _is_stale_snapshot).
const higgsfieldJobDetailRequested = new Set();

function queueHiggsfieldJobDetailLookup(jobId) {
  if (!jobId || higgsfieldJobDetailRequested.has(jobId)) return;
  higgsfieldJobDetailRequested.add(jobId);
  try {
    window.postMessage({
      source: 'rmw-higgsfield-network-telemetry',
      type: 'HIGGSFIELD_REQUEST_JOB_DETAIL',
      payload: { jobId },
    }, location.origin);
  } catch {}
}

// ---- Throttled detail enrichment for listing rows (2026-08-06) ----
//
// Sarbjeet's own ask: a listing row (from the Assets-listing sweep above)
// only ever carries raw_url/min_url/job_set_type/created_at - never the
// prompt, which lives exclusively in the per-resource detail endpoint (GET
// .../fnf/assets/{id}/detail, see looksLikeHiggsfieldJobDetailObject). The
// live-armed path (onHiggsfieldNetworkMessage above) calls
// queueHiggsfieldJobDetailLookup directly, one id at a time, because it only
// ever has ONE id in flight. A listing sweep is different: it can hand us up
// to ~300 ids in a single burst, and this same-origin endpoint is Bearer-JWT
// authenticated AND sits behind DataDome bot-detection (see the
// x-datadome-clientid header on the real captured request) - firing
// hundreds of authenticated requests back to back would look exactly like
// scripted abuse to that layer, independent of whether Higgsfield's own
// rate limits would tolerate it. So these ids go through a queue drained one
// at a time on an interval instead of all at once - slower to fully
// backfill (a large history takes several minutes to enrich, not seconds),
// but indistinguishable in shape from a human idly opening one video after
// another. queueHiggsfieldJobDetailLookup's own higgsfieldJobDetailRequested
// Set still provides the actual dedupe.
//
// RETRY (2026-08-06, fixing a real bug Sarbjeet hit): a proactive fetch that
// fails - no fresh bearer token yet, or an HTTP error - used to be
// indistinguishable from a successful one on this side: higgsfieldJobDetailRequested
// marked the id done the instant it was ASKED for, not once it actually
// succeeded, so a single bad token (observed in practice: a 401, from a
// token captured mid-login-flow while Clerk was still rotating sign-in
// tokens) permanently stranded that generation on "no prompt captured" for
// the rest of the page load, with nothing left to ever retry it - not even
// a later listing sweep, since higgsfieldListingRowsReported (above) had
// already marked the row "reported" the first time through. See
// onHiggsfieldJobDetailFetchFailedMessage below, which content-higgsfield-network.js
// now calls back into on failure, specifically to undo that.
const HIGGSFIELD_DETAIL_ENRICHMENT_INTERVAL_MS = 3 * 1000;
const HIGGSFIELD_DETAIL_ENRICHMENT_QUEUE_MAX = 2000; // safety valve, not a normal operating ceiling
// Was 5 - raised 2026-08-06 after Sarbjeet hit a real cluster: several ids
// queued right after a fresh login all burned through 5 attempts while
// Clerk was still actively rotating sign-in-flow tokens (visible in the
// console as repeated 401/403 on clerk.higgsfield.ai itself, not just our
// own fetch), so every one of THEIR retries also landed on a bad token -
// bad luck correlated in time, not 5 independent coin flips. 15 gives more
// chances to land after that churn settles, without retrying a truly-dead
// id forever.
const HIGGSFIELD_DETAIL_ENRICHMENT_MAX_ATTEMPTS = 15;
const higgsfieldDetailEnrichmentQueue = [];
const higgsfieldDetailEnrichmentQueued = new Set();
const higgsfieldDetailEnrichmentAttempts = new Map();
let higgsfieldDetailEnrichmentTimer = null;

function drainHiggsfieldDetailEnrichmentQueue() {
  higgsfieldDetailEnrichmentTimer = null;
  const nextId = higgsfieldDetailEnrichmentQueue.shift();
  if (nextId) {
    higgsfieldDetailEnrichmentQueued.delete(nextId);
    queueHiggsfieldJobDetailLookup(nextId);
  }
  if (higgsfieldDetailEnrichmentQueue.length) {
    higgsfieldDetailEnrichmentTimer = window.setTimeout(drainHiggsfieldDetailEnrichmentQueue, HIGGSFIELD_DETAIL_ENRICHMENT_INTERVAL_MS);
  }
}

function enqueueHiggsfieldDetailEnrichment(jobId) {
  if (!jobId || higgsfieldJobDetailRequested.has(jobId) || higgsfieldDetailEnrichmentQueued.has(jobId)) return;
  if (higgsfieldDetailEnrichmentQueue.length >= HIGGSFIELD_DETAIL_ENRICHMENT_QUEUE_MAX) return;
  higgsfieldDetailEnrichmentQueued.add(jobId);
  higgsfieldDetailEnrichmentQueue.push(jobId);
  if (!higgsfieldDetailEnrichmentTimer) {
    higgsfieldDetailEnrichmentTimer = window.setTimeout(drainHiggsfieldDetailEnrichmentQueue, HIGGSFIELD_DETAIL_ENRICHMENT_INTERVAL_MS);
  }
}

// content-higgsfield-network.js's postHiggsfieldJobDetailFailure posts this
// whenever a proactive detail fetch (queueHiggsfieldJobDetailLookup, either
// from a live-armed generation or from the enrichment queue above)
// definitely did not land a usable response. Un-marks the id as requested
// and re-queues it for another attempt at the BACK of the enrichment queue
// (not the front - retrying immediately would just hit the same stale-token
// window again; letting other pending ids drain first buys real time for a
// fresh token to show up from the page's own ambient traffic). Capped at
// HIGGSFIELD_DETAIL_ENRICHMENT_MAX_ATTEMPTS so a structurally-broken id (not
// a timing fluke - e.g. genuinely revoked/expired access) doesn't retry
// forever; once exhausted it's left in higgsfieldJobDetailRequested so nothing
// keeps re-attempting it this page load, same terminal state as before this
// fix existed, just reached only after really trying.
function onHiggsfieldJobDetailFetchFailedMessage(event) {
  if (event.source !== window) return;
  const data = event.data;
  if (!data || data.source !== 'rmw-higgsfield-network-telemetry' || data.type !== 'HIGGSFIELD_JOB_DETAIL_FETCH_FAILED') return;
  const jobId = typeof data.payload?.jobId === 'string' ? data.payload.jobId.trim() : '';
  if (!jobId) return;

  const attempts = (higgsfieldDetailEnrichmentAttempts.get(jobId) || 0) + 1;
  higgsfieldDetailEnrichmentAttempts.set(jobId, attempts);
  if (attempts > HIGGSFIELD_DETAIL_ENRICHMENT_MAX_ATTEMPTS) {
    console.debug('[RMW Higgsfield Capture] giving up on detail enrichment after repeated failures', { jobId, attempts, reason: data.payload?.reason });
    return;
  }

  higgsfieldJobDetailRequested.delete(jobId);
  enqueueHiggsfieldDetailEnrichment(jobId);
}

window.addEventListener('message', onHiggsfieldJobDetailFetchFailedMessage);

// ---- Proactive Assets-listing sweep (2026-08-06) ----
//
// Sarbjeet flagged that the page's own Assets-listing call fires
// inconsistently - sometimes early in a session, sometimes late, sometimes
// not at all (depends entirely on whether/when the user visits that
// section). Rather than depend on that, fire our own sweep on a timer as
// soon as this content script loads on ANY higgsfield.ai page, independent
// of which tab/section is actually open - mirrors the "don't wait for the
// user" reasoning behind queueHiggsfieldJobDetailLookup above, just on a
// repeating interval instead of a one-shot per-resource id, since there's no
// single id to key a listing sweep on.
//
// content-higgsfield-network.js's onAssetListingFetchRequest silently no-ops
// if no fresh-enough bearer token has been captured yet (same posture as the
// job-detail fetch) - so an early tick before the page's own traffic has
// yielded a token just does nothing rather than send an unauthenticated
// request, and the next tick tries again.
const HIGGSFIELD_ASSET_LISTING_SWEEP_INITIAL_DELAY_MS = 5 * 1000;
const HIGGSFIELD_ASSET_LISTING_SWEEP_INTERVAL_MS = 4 * 60 * 1000;

function queueHiggsfieldAssetListingSweep() {
  try {
    window.postMessage({
      source: 'rmw-higgsfield-network-telemetry',
      type: 'HIGGSFIELD_REQUEST_ASSET_LISTING',
      payload: {},
    }, location.origin);
  } catch {}
}

window.setTimeout(queueHiggsfieldAssetListingSweep, HIGGSFIELD_ASSET_LISTING_SWEEP_INITIAL_DELAY_MS);
window.setInterval(queueHiggsfieldAssetListingSweep, HIGGSFIELD_ASSET_LISTING_SWEEP_INTERVAL_MS);

// ---- DOM fallback: poll for a rendered output element appearing on the
// page, in case a generation's real output URL only ever surfaces in the DOM
// (e.g. an inline <video>/thumbnail) rather than a captured network response
// - mirrors content-heygen.js's startHeygenAssetDetection. ----

const HIGGSFIELD_ASSET_SCAN_MS = 4000;
const HIGGSFIELD_ASSET_SCAN_MAX_MS = 10 * 60 * 1000;
let higgsfieldAssetScanTimer = null;
let higgsfieldAssetScanStartedAt = 0;

function collectHiggsfieldVisibleOutputUrl() {
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

function stopHiggsfieldAssetDetection() {
  if (higgsfieldAssetScanTimer) { window.clearInterval(higgsfieldAssetScanTimer); higgsfieldAssetScanTimer = null; }
}

function startHiggsfieldAssetDetection() {
  stopHiggsfieldAssetDetection();
  higgsfieldAssetScanStartedAt = Date.now();
  higgsfieldAssetScanTimer = window.setInterval(() => {
    if (!higgsfieldActiveGeneration || Date.now() - higgsfieldAssetScanStartedAt > HIGGSFIELD_ASSET_SCAN_MAX_MS) {
      stopHiggsfieldAssetDetection();
      return;
    }
    const outputUrl = collectHiggsfieldVisibleOutputUrl();
    if (!outputUrl) return;
    stopHiggsfieldAssetDetection();
    setHiggsfieldCaptureStatus('Capturing…');
    const kind = higgsfieldActiveGeneration.kind;
    reportHiggsfieldCaptureEvent({
      eventType: kind === 'edit_video' ? 'edit_video_click' : kind === 'motion_control' ? 'motion_control_click' : 'video_generate_click',
      isReconciliation: false,
      payload: {
        ...higgsfieldActiveGeneration.submitSnapshot,
        status: 'completed',
        output: { videoUrl: outputUrl },
      },
      identity: { externalEventId: higgsfieldActiveGeneration.generateIntentId },
      changeToken: 'completed_dom',
    });
  }, HIGGSFIELD_ASSET_SCAN_MS);
}
