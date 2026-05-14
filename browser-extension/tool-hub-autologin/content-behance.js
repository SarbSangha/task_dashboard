const TOOL_SLUG = 'behance';
const EXTENSION_TICKET_KEY = 'rmw_extension_ticket';

const MIN_RUN_GAP_MS = 450;
const KEEP_ALIVE_MS = 2200;
const ACTION_COOLDOWN_MS = 900;
const SUBMIT_COOLDOWN_MS = 2200;
const PASSWORD_PROMPT_RESTORE_DELAY_MS = 8000;

const EMAIL_SELECTORS = [
  'input[type="email"]',
  'input[name="email"]',
  'input[name="username"]',
  'input[id*="email" i]',
  'input[id*="username" i]',
  'input[autocomplete="username"]',
  'input[placeholder*="email" i]',
  'input[aria-label*="email" i]',
].join(',');

const PASSWORD_SELECTORS = [
  'input[type="password"]',
  'input[name="password"]',
  'input[name="passwd"]',
  'input[id*="password" i]',
  'input[autocomplete="current-password"]',
  'input[placeholder*="password" i]',
  'input[aria-label*="password" i]',
].join(',');

const ACTION_SELECTORS = [
  'button',
  'a[href]',
  'input[type="submit"]',
  'input[type="button"]',
  '[role="button"]',
].join(',');

const STATE = {
  status: 'Waiting for Behance',
  credential: null,
  launchChecked: false,
  launchAuthorized: false,
  launchExpiresAt: 0,
  requestedCredential: false,
  scheduledTimer: null,
  keepAliveTimer: null,
  observer: null,
  settled: false,
  lastRunAt: 0,
  lastActionAt: 0,
  lastEmailSubmitAt: 0,
  lastPasswordSubmitAt: 0,
  passwordSavingInFlight: false,
  passwordSavingInFlightSince: 0,
  passwordSavingSuppressed: false,
  passwordSavingBypass: false,
  passwordSavingRestoreTimer: null,
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
    top: '68px',
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
  badge.textContent = `Behance auto-login\n${STATE.status}`;
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
  ensureStatusBadge().textContent = `Behance auto-login\n${message}`;
  console.debug('[RMW Behance Auto Login]', message);
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
  if (STATE.passwordSavingSuppressed || STATE.passwordSavingBypass) return;
  if (STATE.passwordSavingInFlight) {
    if (STATE.passwordSavingInFlightSince && Date.now() - STATE.passwordSavingInFlightSince > 4000) {
      STATE.passwordSavingInFlight = false;
      STATE.passwordSavingInFlightSince = 0;
      STATE.passwordSavingBypass = true;
      setStatus('Warning: Password-save suppression timed out. Continuing anyway');
      scheduleAttempt(50);
    }
    return;
  }

  STATE.passwordSavingInFlight = true;
  STATE.passwordSavingInFlightSince = Date.now();
  setStatus('Disabling Chrome password-save prompt');

  ensurePasswordSavingSuppressed()
    .then((ok) => {
      STATE.passwordSavingInFlight = false;
      STATE.passwordSavingInFlightSince = 0;
      if (!ok) {
        STATE.passwordSavingBypass = true;
      }
      scheduleAttempt(50);
    })
    .catch((error) => {
      STATE.passwordSavingInFlight = false;
      STATE.passwordSavingInFlightSince = 0;
      STATE.passwordSavingBypass = true;
      setStatus(`Warning: ${error?.message || 'Could not disable Chrome password-save prompt'}`);
      scheduleAttempt(50);
    });
}

function releasePasswordSavingSuppressed(delay = 0) {
  if (STATE.passwordSavingRestoreTimer) {
    window.clearTimeout(STATE.passwordSavingRestoreTimer);
    STATE.passwordSavingRestoreTimer = null;
  }

  if (!STATE.passwordSavingSuppressed && delay <= 0) return;

  STATE.passwordSavingRestoreTimer = window.setTimeout(() => {
    sendRuntimeMessage({
      type: 'TOOL_HUB_SET_PASSWORD_SAVING_SUPPRESSED',
      suppressed: false,
    });
    STATE.passwordSavingSuppressed = false;
    STATE.passwordSavingRestoreTimer = null;
  }, Math.max(0, delay));
}

function stop(message) {
  STATE.settled = true;
  if (STATE.scheduledTimer) window.clearTimeout(STATE.scheduledTimer);
  if (STATE.keepAliveTimer) window.clearInterval(STATE.keepAliveTimer);
  if (STATE.observer) STATE.observer.disconnect();
  STATE.scheduledTimer = null;
  STATE.keepAliveTimer = null;
  STATE.observer = null;
  releasePasswordSavingSuppressed(0);
  setStatus(message);
}

function complete(message = 'Behance login complete') {
  STATE.settled = true;
  if (STATE.scheduledTimer) window.clearTimeout(STATE.scheduledTimer);
  if (STATE.keepAliveTimer) window.clearInterval(STATE.keepAliveTimer);
  if (STATE.observer) STATE.observer.disconnect();
  STATE.scheduledTimer = null;
  STATE.keepAliveTimer = null;
  STATE.observer = null;
  releasePasswordSavingSuppressed(0);
  console.debug('[RMW Behance Auto Login]', message);
  window.setTimeout(() => hideStatusBadge(), 600);
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
    if (ticket) window.sessionStorage.setItem(EXTENSION_TICKET_KEY, ticket);
    else window.sessionStorage.removeItem(EXTENSION_TICKET_KEY);
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
    && style.visibility !== 'hidden'
    && style.opacity !== '0';
}

function isDisabled(element) {
  return !element
    || element.disabled
    || element.getAttribute('aria-disabled') === 'true'
    || element.getAttribute('disabled') !== null;
}

function isOwnStatusElement(element) {
  return Boolean(element?.id === 'rmw-autologin-status' || element?.closest?.('#rmw-autologin-status'));
}

function normalizeText(value) {
  return `${value || ''}`.replace(/\s+/g, ' ').trim().toLowerCase();
}

function pageText() {
  return normalizeText(document.body?.innerText || '');
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
  ].filter(Boolean).join(' '));
}

function collectActionCandidates(root = document) {
  return Array.from(root.querySelectorAll(ACTION_SELECTORS))
    .filter((element) => isVisible(element) && !isDisabled(element) && !isOwnStatusElement(element));
}

function isActionLikeElement(element) {
  if (!element || !isVisible(element) || isDisabled(element) || isOwnStatusElement(element)) return false;
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

function collectBroadActionCandidates() {
  const broad = Array.from(document.querySelectorAll('button, a[href], [role="button"], [tabindex], div, span'))
    .map((element) => findClickableAncestor(element));
  return Array.from(new Set([
    ...collectActionCandidates(),
    ...broad.filter(Boolean),
  ])).filter((element) => isVisible(element) && !isDisabled(element) && !isOwnStatusElement(element));
}

function findInput(selectorList) {
  return Array.from(document.querySelectorAll(selectorList))
    .find((element) => isVisible(element) && !element.disabled && !element.readOnly) || null;
}

function getValueSetter(element) {
  let current = element;
  while (current) {
    const descriptor = Object.getOwnPropertyDescriptor(current, 'value');
    if (descriptor?.set) return descriptor.set;
    current = Object.getPrototypeOf(current);
  }
  return null;
}

function setInputValue(input, value) {
  const nextValue = `${value || ''}`;
  const previousValue = `${input.value || ''}`;
  const setter = getValueSetter(input);

  try {
    input.focus({ preventScroll: true });
  } catch {
    input.focus?.();
  }

  if (setter) setter.call(input, nextValue);
  else input.value = nextValue;

  input.setAttribute('value', nextValue);
  if (input._valueTracker?.setValue) {
    input._valueTracker.setValue(previousValue);
  }

  try {
    input.dispatchEvent(new InputEvent('input', {
      bubbles: true,
      data: nextValue,
      inputType: 'insertText',
    }));
  } catch {
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }
  input.dispatchEvent(new Event('change', { bubbles: true }));
  input.dispatchEvent(new Event('blur', { bubbles: true }));
}

function dispatchMouseSequence(element) {
  const pointerCtor = typeof window.PointerEvent === 'function' ? window.PointerEvent : window.MouseEvent;
  [
    ['pointerdown', pointerCtor],
    ['mousedown', window.MouseEvent],
    ['pointerup', pointerCtor],
    ['mouseup', window.MouseEvent],
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
}

function clickElement(element) {
  const target = findClickableAncestor(element) || element;
  if (!target || isDisabled(target) || !isVisible(target)) return false;

  try {
    target.scrollIntoView({ block: 'center', inline: 'nearest' });
  } catch {}
  try {
    target.focus({ preventScroll: true });
  } catch {
    target.focus?.();
  }

  dispatchMouseSequence(target);
  try {
    target.click();
    return true;
  } catch {
    try {
      const rect = target.getBoundingClientRect();
      target.dispatchEvent(new MouseEvent('click', {
        bubbles: true,
        cancelable: true,
        composed: true,
        view: window,
        clientX: rect.left + (rect.width / 2),
        clientY: rect.top + (rect.height / 2),
      }));
      return true;
    } catch {
      return false;
    }
  }
}

function pressEnter(input) {
  if (!input) return false;
  try {
    input.focus({ preventScroll: true });
  } catch {
    input.focus?.();
  }
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

function findSubmitButton(input, kind = 'continue') {
  const exactWords = kind === 'password'
    ? new Set(['continue', 'sign in', 'log in', 'login'])
    : new Set(['continue', 'next']);

  for (const root of getFieldRoots(input)) {
    const candidates = collectActionCandidates(root);
    const exact = candidates.find((element) => exactWords.has(actionText(element)));
    if (exact) return exact;

    const partial = candidates.find((element) => {
      const text = actionText(element);
      return (text.includes('continue') || text.includes('next') || text.includes('sign in') || text.includes('login') || text.includes('log in'))
        && !text.includes('google')
        && !text.includes('facebook')
        && !text.includes('apple')
        && !text.includes('create account');
    });
    if (partial) return partial;

    const submit = candidates.find((element) => `${element.type || ''}`.toLowerCase() === 'submit');
    if (submit) return submit;
  }
  return null;
}

function submitStep(input, kind) {
  const submitButton = findSubmitButton(input, kind);
  if (submitButton && clickElement(submitButton)) return true;
  if (pressEnter(input)) return true;
  const form = input?.closest('form');
  if (form) {
    try {
      if (typeof form.requestSubmit === 'function') form.requestSubmit();
      else form.submit?.();
      return true;
    } catch {}
  }
  return false;
}

function findGoogleLoginAction() {
  return collectBroadActionCandidates().find((element) => {
    const text = actionText(element);
    const hints = controlHintText(element);
    return text.includes('continue with google')
      || text.includes('sign in with google')
      || text.includes('log in with google')
      || text.includes('login with google')
      || (text === 'google' && hints.includes('google'));
  }) || null;
}

function findBehanceSignInAction() {
  return collectBroadActionCandidates().find((element) => {
    const text = actionText(element);
    const href = normalizeText(element.getAttribute?.('href') || '');
    return (
      text === 'sign in'
      || text === 'log in'
      || text === 'login'
      || href.includes('/login')
      || href.includes('adobeid')
      || href.includes('auth.services.adobe.com')
    )
      && !text.includes('google')
      && !text.includes('facebook')
      && !text.includes('apple')
      && !text.includes('create');
  }) || null;
}

function isAdobeAuthPage() {
  try {
    const host = new URL(window.location.href).hostname;
    return host.includes('adobe.com') || host.includes('adobelogin.com');
  } catch {
    return false;
  }
}

function isAuthenticatedBehancePage() {
  try {
    const url = new URL(window.location.href);
    if (!url.hostname.includes('behance.net')) return false;
  } catch {
    return false;
  }

  if (findInput(EMAIL_SELECTORS) || findInput(PASSWORD_SELECTORS) || findGoogleLoginAction() || findBehanceSignInAction()) {
    return false;
  }

  const text = pageText();
  return text.includes('profile')
    || text.includes('upload your work')
    || text.includes('for you')
    || text.includes('notifications')
    || text.includes('messages');
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

function canActNow() {
  return Date.now() - STATE.lastActionAt > ACTION_COOLDOWN_MS;
}

function markActionTaken() {
  STATE.lastActionAt = Date.now();
}

function attemptOpenBehanceAuth() {
  const signInAction = findBehanceSignInAction();
  if (!signInAction) return false;
  if (!canActNow()) return true;

  markActionTaken();
  setStatus('Opening Behance sign-in');
  clickElement(signInAction);
  scheduleAttempt(700);
  return true;
}

function attemptOpenGoogle() {
  const googleAction = findGoogleLoginAction();
  if (!googleAction) return false;
  if (!canActNow()) return true;

  markActionTaken();
  setStatus('Opening Behance Google sign-in');
  clickElement(googleAction);
  scheduleAttempt(900);
  return true;
}

function attemptEmailStep(emailInput) {
  if (!emailInput || !STATE.credential?.loginIdentifier) return false;

  if (emailInput.value !== STATE.credential.loginIdentifier) {
    setStatus('Filling Behance email');
    setInputValue(emailInput, STATE.credential.loginIdentifier);
    scheduleAttempt(120);
    return true;
  }

  if (Date.now() - STATE.lastEmailSubmitAt < SUBMIT_COOLDOWN_MS) {
    setStatus('Waiting for Behance password step');
    return true;
  }

  STATE.lastEmailSubmitAt = Date.now();
  setStatus('Submitting Behance email');
  submitStep(emailInput, 'email');
  scheduleAttempt(700);
  return true;
}

function attemptPasswordStep(passwordInput) {
  if (!passwordInput || !STATE.credential?.password) return false;

  if (passwordInput.value !== STATE.credential.password) {
    if (!STATE.passwordSavingSuppressed && !STATE.passwordSavingBypass) {
      requestPasswordSavingSuppression();
      return true;
    }
    setStatus('Filling Behance password');
    setInputValue(passwordInput, STATE.credential.password);
    scheduleAttempt(120);
    return true;
  }

  if (Date.now() - STATE.lastPasswordSubmitAt < SUBMIT_COOLDOWN_MS) {
    setStatus('Waiting for Behance sign-in');
    return true;
  }

  STATE.lastPasswordSubmitAt = Date.now();
  setStatus('Submitting Behance password');
  submitStep(passwordInput, 'password');
  releasePasswordSavingSuppressed(PASSWORD_PROMPT_RESTORE_DELAY_MS);
  scheduleAttempt(800);
  return true;
}

function attemptFlow() {
  if (!STATE.launchChecked) {
    setStatus('Checking launch authorization');
    return;
  }

  if (!STATE.launchAuthorized) {
    stop('Launch this tool from the dashboard first');
    return;
  }

  if (isAuthenticatedBehancePage()) {
    complete();
    return;
  }

  const emailInput = findInput(EMAIL_SELECTORS);
  const passwordInput = findInput(PASSWORD_SELECTORS);

  if (!STATE.credential) {
    requestCredential();
  }

  if (isGoogleCredential()) {
    if (attemptOpenGoogle()) return;
    if (attemptOpenBehanceAuth()) return;
    setStatus('Waiting for Behance Google sign-in option');
    return;
  }

  if (!STATE.credential?.loginIdentifier || !STATE.credential?.password) {
    setStatus('Waiting for credential');
    return;
  }

  if (passwordInput) {
    if (attemptPasswordStep(passwordInput)) return;
  }

  if (emailInput) {
    if (attemptEmailStep(emailInput)) return;
  }

  if (attemptOpenBehanceAuth()) return;

  setStatus(isAdobeAuthPage() ? 'Waiting for Adobe sign-in fields' : 'Waiting for Behance sign-in');
}

function runAttempt() {
  STATE.scheduledTimer = null;
  if (STATE.settled) return;

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
  if (STATE.settled || STATE.scheduledTimer) return;
  STATE.scheduledTimer = window.setTimeout(runAttempt, Math.max(0, delay));
}

function start() {
  ensureStatusBadge();
  captureLaunchTicket();

  STATE.observer = new MutationObserver(() => scheduleAttempt(250));
  STATE.observer.observe(document.body || document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['type', 'aria-label', 'class', 'style', 'disabled', 'aria-disabled'],
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
}

start();
