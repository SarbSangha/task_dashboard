const TOOL_SLUG = 'kling-ai';
const LOGIN_URL = 'https://kling.ai/app';
const PREPARED_LAUNCH_KEY = 'rmw_kling_prepared_launch';
const BLOCKED_NOTICE_KEY = 'rmw_kling_blocked_notice';
const EXTENSION_TICKET_KEY = 'rmw_extension_ticket';
const STATE = {
  credential: null,
  requested: false,
  requestAttempts: 0,
  lastRequestAt: 0,
  lastEmailSubmitAt: 0,
  lastPasswordSubmitAt: 0,
  lastLoginOpenAt: 0,
  lastLandingActionKey: '',
  loginOpenAttempts: 0,
  emailStepPending: false,
  passwordStepPending: false,
  scheduledTimer: null,
  keepAliveTimer: null,
  observer: null,
  lastRunAt: 0,
  lastMutationHandledAt: 0,
  settled: false,
  launchChecked: false,
  launchAuthorized: false,
  launchExpiresAt: 0,
  status: 'Waiting for Kling login form',
};

const MIN_RUN_GAP_MS = 500;
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

const ACTION_SELECTORS = [
  'button',
  'input[type="submit"]',
  'a[href]',
  '[role="button"]',
];

function ensureStatusBadge() {
  const badge = document.getElementById('rmw-autologin-status');
  if (badge) badge.remove();
  return null;
}

function setStatus(message) {
  if (STATE.status === message) return;
  STATE.status = message;
  ensureStatusBadge();
}

function markerFromValue(value) {
  let hash = 0;
  const text = `${value || ''}`;
  for (let index = 0; index < text.length; index += 1) {
    hash = ((hash << 5) - hash) + text.charCodeAt(index);
    hash |= 0;
  }
  return `${hash}`;
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

function captureLaunchTicketFromUrl() {
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

function isThirdPartyAuthAction(button) {
  const text = buttonText(button);
  return text.includes('google')
    || text.includes('apple')
    || text.includes('facebook')
    || text.includes('continue as ');
}

function isEmailAuthAction(button) {
  const text = buttonText(button);
  return text.includes('sign in with email')
    || text.includes('continue with email')
    || text.includes('use email')
    || text === 'email';
}

function landingActionKey(action) {
  if (!action) return '';
  return [
    buttonText(action),
    `${action.getAttribute?.('href') || ''}`.trim().toLowerCase(),
    `${action.getAttribute?.('data-testid') || ''}`.trim().toLowerCase(),
  ].join('|');
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

function valuesMatch(currentValue, expectedValue) {
  return `${currentValue || ''}`.trim() === `${expectedValue || ''}`.trim();
}

function findStepContainer(input) {
  if (!input) return [document];

  const containers = [];
  let current = input.parentElement;

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

function findSubmitButton(kind, input = null) {
  const words = kind === 'password'
    ? ['continue', 'log in', 'login', 'sign in', 'submit']
    : ['continue', 'next', 'use email', 'email', 'submit', 'sign in'];

  for (const root of findStepContainer(input)) {
    const candidates = collectActionCandidates(root);
    if (!candidates.length) continue;

    const exactMatch = candidates.find((button) => {
      const text = buttonText(button);
      return text === 'continue'
        || text === 'next'
        || text === 'log in'
        || text === 'login'
        || text === 'sign in';
    });
    if (exactMatch) return exactMatch;

    const wordMatch = candidates.find((button) => words.some((word) => buttonText(button).includes(word)));
    if (wordMatch) return wordMatch;

    const submitMatch = candidates.find((button) => button.type === 'submit');
    if (submitMatch) return submitMatch;
  }

  return null;
}

function findLandingLoginAction() {
  const candidates = Array.from(document.querySelectorAll(ACTION_SELECTORS.join(',')))
    .filter((element) => !isDisabled(element) && isVisible(element));

  const emailAction = candidates.find((element) => isEmailAuthAction(element));
  if (emailAction) return emailAction;

  const authAction = candidates.find((element) => {
    if (isThirdPartyAuthAction(element)) return false;
    const text = buttonText(element);
    if (
      text.includes('log in')
      || text.includes('login')
      || text.includes('sign in')
      || text.includes('experience now')
      || text.includes('create now')
    ) {
      return true;
    }

    const href = `${element.getAttribute?.('href') || ''}`.toLowerCase();
    return href.includes('/login')
      || href.includes('/log-in')
      || href.includes('/sign-in')
      || href.includes('/signin')
      || href.includes('/auth')
      || href.includes('/app');
  });

  return authAction || null;
}

function isLoginPage() {
  return window.location.pathname.includes('/login')
    || window.location.pathname.includes('/sign-in')
    || Boolean(findInput(EMAIL_SELECTORS))
    || Boolean(findInput(PASSWORD_SELECTORS))
    || Boolean(findLandingLoginAction());
}

async function loadLaunchState() {
  const directTicket = captureLaunchTicketFromUrl() || getStoredLaunchTicket();
  if (directTicket) {
    STATE.launchChecked = true;
    STATE.launchAuthorized = true;
    STATE.launchExpiresAt = Number(markerFromValue(directTicket));
    return;
  }

  const response = await sendRuntimeMessage({
    type: 'TOOL_HUB_GET_LAUNCH_STATE',
    toolSlug: TOOL_SLUG,
    hostname: window.location.hostname,
    pageUrl: window.location.href,
  });

  STATE.launchChecked = true;
  STATE.launchAuthorized = true;
  STATE.launchExpiresAt = Number(response?.ok && response.authorized ? response.expiresAt || 0 : 0);
}

async function clearToolSession() {
  clearPageStorage();
  await sendRuntimeMessage({
    type: 'TOOL_HUB_CLEAR_TOOL_SESSION',
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
  const launchKey = `${STATE.launchExpiresAt || 0}`;
  if (!launchKey || launchKey === '0') {
    return false;
  }

  if (window.sessionStorage.getItem(PREPARED_LAUNCH_KEY) === launchKey) {
    return true;
  }

  await clearToolSession();
  window.sessionStorage.setItem(PREPARED_LAUNCH_KEY, launchKey);
  window.sessionStorage.removeItem(BLOCKED_NOTICE_KEY);
  setStatus('Preparing fresh Kling session');

  if (window.location.origin + window.location.pathname !== new URL(LOGIN_URL).origin + new URL(LOGIN_URL).pathname) {
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

function attemptEmailStep(credential) {
  const input = findInput(EMAIL_SELECTORS);
  if (!input) return false;

  if (STATE.passwordStepPending || findInput(PASSWORD_SELECTORS)) {
    STATE.emailStepPending = false;
  }

  if (input.value !== credential.loginIdentifier) {
    input.focus();
    setInputValue(input, credential.loginIdentifier);
  }

  if (STATE.emailStepPending) {
    setStatus('Email filled, waiting for password step');
    return true;
  }

  const now = Date.now();
  if (input.value && now - STATE.lastEmailSubmitAt > 2500) {
    const submitButton = findSubmitButton('email', input);
    if (!submitButton) {
      setStatus('Email filled, continue button not found');
      return true;
    }

    STATE.lastEmailSubmitAt = now;
    STATE.emailStepPending = true;
    setStatus('Email filled, continuing');
    window.setTimeout(() => submitButton.click(), 300);
  } else if (input.value) {
    setStatus('Email filled');
  }

  return true;
}

function attemptPasswordStep(credential) {
  const input = findInput(PASSWORD_SELECTORS);
  if (!input) return false;

  STATE.emailStepPending = false;
  if (input.value !== credential.password) {
    input.focus();
    setInputValue(input, credential.password);
  }

  if (STATE.passwordStepPending) {
    setStatus('Password filled, waiting for sign-in');
    return true;
  }

  const now = Date.now();
  if (input.value && now - STATE.lastPasswordSubmitAt > 2500) {
    const submitButton = findSubmitButton('password', input);
    if (!submitButton) {
      setStatus('Password filled, sign-in button not found');
      return true;
    }

    STATE.lastPasswordSubmitAt = now;
    STATE.passwordStepPending = true;
    setStatus('Password filled, signing in');
    window.setTimeout(() => submitButton.click(), 350);
  } else if (input.value) {
    setStatus('Password filled');
  }

  return true;
}

function attemptCombinedCredentialStep(credential) {
  const emailInput = findInput(EMAIL_SELECTORS);
  const passwordInput = findInput(PASSWORD_SELECTORS);
  if (!emailInput || !passwordInput) return false;

  STATE.emailStepPending = false;

  if (!valuesMatch(emailInput.value, credential.loginIdentifier)) {
    emailInput.focus();
    setInputValue(emailInput, credential.loginIdentifier);
  }

  if (!valuesMatch(passwordInput.value, credential.password)) {
    passwordInput.focus();
    setInputValue(passwordInput, credential.password);
  }

  const emailReady = valuesMatch(emailInput.value, credential.loginIdentifier);
  const passwordReady = valuesMatch(passwordInput.value, credential.password);
  if (!emailReady || !passwordReady) {
    setStatus('Filling Kling credentials');
    return true;
  }

  const now = Date.now();
  const submitButton = findSubmitButton('password', passwordInput);
  if (!submitButton) {
    setStatus('Credential filled, sign-in button not found');
    return true;
  }

  if (isDisabled(submitButton)) {
    setStatus('Credential filled, waiting for sign-in button');
    return true;
  }

  if (STATE.passwordStepPending) {
    setStatus('Credential filled, waiting for sign-in');
    return true;
  }

  if (now - STATE.lastPasswordSubmitAt > 1800) {
    STATE.lastPasswordSubmitAt = now;
    STATE.passwordStepPending = true;
    setStatus('Credential filled, signing in');
    window.setTimeout(() => submitButton.click(), 180);
    return true;
  }

  setStatus('Credential filled');
  return true;
}

function attemptLandingLogin() {
  const emailInput = findInput(EMAIL_SELECTORS);
  const passwordInput = findInput(PASSWORD_SELECTORS);
  if (emailInput || passwordInput) return false;
  if (STATE.loginOpenAttempts >= 8) return false;

  const action = findLandingLoginAction();
  if (!action) return false;

  const now = Date.now();
  const actionKey = landingActionKey(action);
  const isNewAction = actionKey && actionKey !== STATE.lastLandingActionKey;
  const cooldownMs = isEmailAuthAction(action) ? 250 : 900;
  if (isNewAction || now - STATE.lastLoginOpenAt > cooldownMs) {
    STATE.lastLoginOpenAt = now;
    STATE.lastLandingActionKey = actionKey;
    STATE.loginOpenAttempts += 1;
    setStatus(isEmailAuthAction(action) ? 'Opening email sign-in' : 'Opening login prompt');
    window.setTimeout(() => action.click(), isEmailAuthAction(action) ? 80 : 160);
  }
  return true;
}

function attemptFill() {
  if (STATE.settled) return;
  if (!STATE.launchChecked) {
    setStatus('Checking dashboard launch');
    return;
  }
  if (STATE.launchExpiresAt && window.sessionStorage.getItem(PREPARED_LAUNCH_KEY) !== `${STATE.launchExpiresAt}`) {
    scheduleAsyncStep(ensureFreshLaunchSession);
    return;
  }

  const credential = STATE.credential;
  if (!credential?.loginIdentifier || !credential?.password) {
    if (findInput(EMAIL_SELECTORS) || findInput(PASSWORD_SELECTORS) || findLandingLoginAction()) {
      requestCredential();
    }
    attemptLandingLogin();
    return;
  }

  if (attemptCombinedCredentialStep(credential)) return;
  if (attemptEmailStep(credential)) return;
  if (attemptPasswordStep(credential)) return;
  attemptLandingLogin();
  setStatus('Waiting for matching Kling field');
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
  captureLaunchTicketFromUrl();
  STATE.observer = new MutationObserver(() => handleMutations());
  STATE.observer.observe(document.body || document.documentElement, { childList: true, subtree: true });
  STATE.keepAliveTimer = window.setInterval(() => scheduleAttempt(0), KEEP_ALIVE_MS);
  loadLaunchState()
    .catch(() => {
      STATE.launchChecked = true;
      STATE.launchAuthorized = true;
      STATE.launchExpiresAt = 0;
    })
    .finally(() => {
      STATE.settled = false;
      scheduleAttempt(0);
    });
}

start();
