const TOOL_SLUG = 'higgsfield';
const LOGIN_URL = 'https://higgsfield.ai/auth/login';
const PREPARED_LAUNCH_KEY = 'rmw_higgsfield_prepared_launch';
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
  status: 'Waiting for Higgsfield login form',
};

const MIN_RUN_GAP_MS = 900;
const KEEP_ALIVE_MS = 4000;

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
  const launchKey = `${STATE.launchExpiresAt || 0}`;
  if (!launchKey || launchKey === '0') {
    return false;
  }

  if (window.sessionStorage.getItem(PREPARED_LAUNCH_KEY) === launchKey) {
    return true;
  }

  await clearToolSession({ preserveLaunch: true });
  window.sessionStorage.setItem(PREPARED_LAUNCH_KEY, launchKey);
  window.sessionStorage.removeItem(BLOCKED_NOTICE_KEY);
  setStatus('Preparing fresh Higgsfield session');

  if (
    findInput(EMAIL_SELECTORS)
    || findInput(PASSWORD_SELECTORS)
    || findPrimaryLoginAction()
    || findEmailEntryAction()
  ) {
    window.location.reload();
    return false;
  }

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

function looksLikeAuthenticatedWorkspace() {
  if (window.location.pathname.startsWith('/auth')) return false;
  if (findInput(EMAIL_SELECTORS) || findInput(PASSWORD_SELECTORS) || findOtpInput()) return false;
  if (findPrimaryLoginAction() || findEmailEntryAction()) return false;

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

  if (hideBadgeAfterMs > 0) {
    window.setTimeout(() => {
      const badge = document.getElementById('rmw-higgsfield-autologin-status');
      if (badge) {
        badge.remove();
      }
    }, hideBadgeAfterMs);
  }
}

function requestOtp() {
  const now = Date.now();
  if (STATE.otpFetching || STATE.otpValue) return;
  if (STATE.otpRequestAttempts >= 3) {
    setStatus('OTP fetch failed after 3 attempts');
    return;
  }
  if (now - STATE.otpLastRequestAt < 3000) return;

  STATE.otpFetching = true;
  STATE.otpLastRequestAt = now;
  STATE.otpRequestAttempts += 1;
  setStatus(`Fetching OTP from email (attempt ${STATE.otpRequestAttempts})`);

  sendRuntimeMessage({
    type: 'TOOL_HUB_FETCH_OTP',
    toolSlug: TOOL_SLUG,
    hostname: window.location.hostname,
    pageUrl: window.location.href,
    extensionTicket: getStoredLaunchTicket(),
  }).then((response) => {
    STATE.otpFetching = false;

    if (!response?.ok || !response.otp) {
      setStatus(response?.error || 'OTP not received yet');
      scheduleAttempt(1500);
      return;
    }

    STATE.otpValue = `${response.otp}`.trim();
    scheduleAttempt(100);
  });
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
  if (!submitButton) {
    setStatus('OTP filled, verify button not found');
    return;
  }

  const now = Date.now();
  if (now - STATE.lastSubmitAt > 3000) {
    STATE.lastSubmitAt = now;
    STATE.otpSubmittedAt = now;
    setStatus('OTP filled, verifying');
    window.setTimeout(() => submitButton.click(), 300);
    return;
  }

  setStatus('OTP filled');
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
  if (STATE.launchExpiresAt && window.sessionStorage.getItem(PREPARED_LAUNCH_KEY) !== `${STATE.launchExpiresAt}`) {
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
  if (otpInput) {
    STATE.otpStageSeen = true;
  }
  if ((emailInput || passwordInput) && (STATE.otpValue || STATE.otpFetching || STATE.otpRequestAttempts)) {
    STATE.otpValue = '';
    STATE.otpFetching = false;
    STATE.otpRequestAttempts = 0;
    STATE.otpLastRequestAt = 0;
    STATE.otpStageSeen = false;
    STATE.otpSubmittedAt = 0;
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

  const now = Date.now();
  const submitButton = findSubmitButton(emailInput, passwordInput);
  if (!submitButton) {
    setStatus('Credential filled, sign-in button not found');
    return;
  }

  if (now - STATE.lastSubmitAt > 3000) {
    STATE.lastSubmitAt = now;
    setStatus('Credential filled, signing in');
    window.setTimeout(() => submitButton.click(), 350);
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
