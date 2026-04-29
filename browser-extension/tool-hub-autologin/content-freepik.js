const TOOL_SLUG = 'freepik';
const LOGIN_URL = 'https://www.freepik.com/log-in?client_id=freepik&lang=en';
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

const ACTION_SELECTORS = [
  'button',
  'a[href]',
  'input[type="submit"]',
  'input[type="button"]',
  '[role="button"]',
].join(',');

const STATE = {
  status: 'Waiting for Freepik',
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
  stopped: false,
};

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
  badge.textContent = `Freepik auto-login\n${STATE.status}`;
  (document.body || document.documentElement).appendChild(badge);
  return badge;
}

function setStatus(message) {
  if (STATE.status === message) return;
  STATE.status = message;
  ensureStatusBadge().textContent = `Freepik auto-login\n${message}`;
  console.debug('[RMW Freepik Auto Login]', message);
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
    return `${window.sessionStorage.getItem(PREPARED_LAUNCH_KEY) || ''}`.trim();
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

function collectActionCandidates(root = document) {
  return Array.from(root.querySelectorAll(ACTION_SELECTORS))
    .filter((element) => isVisible(element) && !isDisabled(element));
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
  return collectActionCandidates().find((element) => {
    const text = actionText(element);
    const href = normalizeText(element.getAttribute?.('href') || '');

    return text.includes('log in')
      || text.includes('login')
      || text.includes('sign in')
      || text.includes('continue with email')
      || text === 'email'
      || href.includes('/log-in')
      || href.includes('/login');
  }) || null;
}

function isLoginPage() {
  return window.location.pathname.includes('/log-in')
    || Boolean(findInput(EMAIL_SELECTORS))
    || Boolean(findInput(PASSWORD_SELECTORS))
    || Boolean(findLoginOpenAction());
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

function findSubmitButton(emailInput, passwordInput) {
  const exactMatches = ['log in', 'login', 'sign in', 'continue'];

  for (const root of getFieldRoots(emailInput, passwordInput)) {
    const candidates = collectActionCandidates(root);

    const exact = candidates.find((element) => exactMatches.includes(actionText(element)));
    if (exact) return exact;

    const partial = candidates.find((element) => {
      const text = actionText(element);
      return text.includes('log in')
        || text.includes('login')
        || text.includes('sign in')
        || text.includes('continue')
        || text.includes('submit');
    });
    if (partial) return partial;

    const submit = candidates.find((element) => `${element.type || ''}`.toLowerCase() === 'submit');
    if (submit) return submit;
  }

  return null;
}

function findPasswordToggle(passwordInput) {
  if (!passwordInput) return null;

  const roots = [
    passwordInput.parentElement,
    passwordInput.closest('div'),
    passwordInput.closest('form'),
  ].filter(Boolean);

  for (const root of roots) {
    const toggle = Array.from(
      root.querySelectorAll('button, [role="button"], [aria-label], [title]')
    ).find((element) => {
      if (!isVisible(element)) return false;
      const text = actionText(element);
      return text.includes('show')
        || text.includes('hide')
        || text.includes('password')
        || text.includes('eye');
    });

    if (toggle) return toggle;
  }

  return null;
}

function lockPasswordVisibility(passwordInput) {
  if (!passwordInput) return;

  try {
    passwordInput.type = 'password';
  } catch {}

  const toggle = findPasswordToggle(passwordInput);
  if (!toggle) return;
  if (toggle.dataset.rmwPasswordToggleLocked === '1') return;

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

  const blockToggle = (event) => {
    try {
      passwordInput.type = 'password';
    } catch {}
    event.preventDefault();
    event.stopImmediatePropagation();
    event.stopPropagation();
  };

  toggle.addEventListener('click', blockToggle, true);
  toggle.addEventListener('mousedown', blockToggle, true);
  toggle.addEventListener('pointerdown', blockToggle, true);
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
    element.click();
    return true;
  } catch {
    return false;
  }
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
      if (!STATE.credential?.loginIdentifier || !STATE.credential?.password) {
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

  if (window.sessionStorage.getItem(PREPARED_LAUNCH_KEY) === launchKey) {
    return;
  }

  await clearToolSession({ preserveLaunch: true });
  window.sessionStorage.setItem(PREPARED_LAUNCH_KEY, launchKey);
  window.sessionStorage.removeItem(BLOCKED_NOTICE_KEY);
  setStatus('Preparing fresh Freepik session');

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
    .catch((error) => {
      stop(`Session check failed: ${error?.message || 'Unknown error'}`);
    });
}

function attemptFlow() {
  if (STATE.stopped) return;

  if (!STATE.launchChecked) {
    setStatus('Checking dashboard launch');
    return;
  }

  if (!hasLocalLaunchEvidence()) {
    scheduleAsyncStep(enforceDashboardOnlyAccess);
    return;
  }

  if (!STATE.launchAuthorized) {
    scheduleAsyncStep(enforceDashboardOnlyAccess);
    return;
  }

  if (
    STATE.launchExpiresAt
    && window.sessionStorage.getItem(PREPARED_LAUNCH_KEY) !== `${STATE.launchExpiresAt}`
  ) {
    scheduleAsyncStep(ensureFreshLaunchSession);
    return;
  }

  const emailInput = findInput(EMAIL_SELECTORS);
  const passwordInput = findInput(PASSWORD_SELECTORS);

  if (passwordInput) {
    lockPasswordVisibility(passwordInput);
    protectPasswordField(passwordInput);
  }

  if (!STATE.credential) {
    requestCredential();
  }

  if (!emailInput || !passwordInput) {
    const loginAction = findLoginOpenAction();
    if (!loginAction) {
      setStatus('Waiting for Freepik login form');
      return;
    }

    if (Date.now() - STATE.lastLoginOpenAt < LOGIN_OPEN_COOLDOWN_MS) {
      setStatus('Waiting for login form to open');
      return;
    }

    STATE.lastLoginOpenAt = Date.now();
    setStatus('Opening login form');
    clickElement(loginAction);
    return;
  }

  if (!STATE.credential?.loginIdentifier || !STATE.credential?.password) {
    setStatus('Waiting for credential');
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
    setStatus('Filling Freepik login form');
    return;
  }

  if (Date.now() - STATE.lastSubmitAt < SUBMIT_COOLDOWN_MS) {
    setStatus('Waiting for Freepik sign-in');
    return;
  }

  const submitButton = findSubmitButton(emailInput, passwordInput);
  STATE.lastSubmitAt = Date.now();
  setStatus('Submitting Freepik login');
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

  STATE.observer = new MutationObserver(() => scheduleAttempt(150));
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
      scheduleAttempt(0);
    });

  if (window.location.href !== LOGIN_URL && window.location.pathname === '/') {
    setStatus('Opening Freepik login page');
    window.location.replace(LOGIN_URL);
    return;
  }
}

start();
