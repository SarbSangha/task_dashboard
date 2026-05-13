const TOOL_SLUG = 'elevenlabs';
const EXTENSION_TICKET_KEY = 'rmw_extension_ticket';

const MIN_RUN_GAP_MS = 500;
const KEEP_ALIVE_MS = 2500;
const ACTION_COOLDOWN_MS = 1800;
const SUBMIT_COOLDOWN_MS = 5000;
const LAUNCH_RETRY_DELAY_MS = 500;
const MAX_LAUNCH_RETRIES = 10;

const EMAIL_SELECTORS = [
  'input[type="email"]',
  'input[name="email"]',
  'input[id*="email" i]',
  'input[name*="email" i]',
  'input[autocomplete="username"]',
  'input[autocomplete="email"]',
  'input[placeholder*="email" i]',
  'input[aria-label*="email" i]',
].join(',');

const PASSWORD_SELECTORS = [
  'input[type="password"]',
  'input[name="password"]',
  'input[id*="password" i]',
  'input[name*="password" i]',
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
  status: 'Waiting for ElevenLabs',
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
  lastSubmitAt: 0,
  launchRetryAttempts: 0,
  lastLaunchRetryAt: 0,
  launchRetryInFlight: false,
  launchTicket: '',
  lastLaunchError: '',
};

function normalizeLoginMethod(value) {
  return `${value || ''}`.trim().toLowerCase() || 'email_password';
}

function isGoogleCredential() {
  return normalizeLoginMethod(STATE.credential?.loginMethod) === 'google';
}

function ensureStatusBadge() {
  const existing = document.getElementById('rmw-elevenlabs-autologin-status');
  if (existing) return existing;

  const badge = document.createElement('div');
  badge.id = 'rmw-elevenlabs-autologin-status';
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
  badge.textContent = `ElevenLabs auto-login\n${STATE.status}`;
  (document.body || document.documentElement).appendChild(badge);
  return badge;
}

function hideStatusBadge() {
  document.getElementById('rmw-elevenlabs-autologin-status')?.remove();
}

function setStatus(message) {
  if (STATE.status === message) return;
  STATE.status = message;
  ensureStatusBadge().textContent = `ElevenLabs auto-login\n${message}`;
  console.debug('[RMW ElevenLabs Auto Login]', message);
}

function stop(message) {
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
}

function complete(message = 'ElevenLabs login complete') {
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
  STATE.status = message;
  console.debug('[RMW ElevenLabs Auto Login]', message);
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
    if (ticket) window.sessionStorage.setItem(EXTENSION_TICKET_KEY, ticket);
    else window.sessionStorage.removeItem(EXTENSION_TICKET_KEY);
  } catch {}
}

function clearStoredLaunchTicket() {
  try {
    window.sessionStorage.removeItem(EXTENSION_TICKET_KEY);
  } catch {}
}

function removeLaunchTicketFromUrl() {
  try {
    const url = new URL(window.location.href);
    url.searchParams.delete('rmw_extension_ticket');
    url.searchParams.delete('rmw_usage_ticket');
    url.searchParams.delete('rmw_tool_slug');

    const hashParams = new URLSearchParams((url.hash || '').replace(/^#/, ''));
    hashParams.delete('rmw_extension_ticket');
    hashParams.delete('rmw_usage_ticket');
    hashParams.delete('rmw_tool_slug');
    url.hash = hashParams.toString();
    window.history.replaceState(null, '', url.toString());
  } catch {}
}

function captureLaunchTicket() {
  const ticket = readLaunchTicketFromUrl() || getStoredLaunchTicket() || STATE.launchTicket;
  if (!ticket) return '';

  STATE.launchTicket = ticket;
  storeLaunchTicket(ticket);
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
      clearStoredLaunchTicket();
      removeLaunchTicketFromUrl();
      STATE.launchTicket = '';
      STATE.lastLaunchError = '';
      STATE.launchChecked = true;
      STATE.launchAuthorized = true;
      STATE.launchExpiresAt = Number(activation.expiresAt || 0);
      return;
    }

    STATE.lastLaunchError = `${activation?.error || 'Dashboard launch ticket was not accepted'}`.trim();
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
  if (STATE.launchAuthorized) {
    STATE.lastLaunchError = '';
  } else if (response?.error) {
    STATE.lastLaunchError = `${response.error}`.trim();
  } else if (!storedTicket) {
    STATE.lastLaunchError = 'No dashboard launch ticket reached ElevenLabs. Reload the extension, then launch ElevenLabs from the dashboard again.';
  }
}

function retryLaunchAuthorizationIfNeeded() {
  if (STATE.launchAuthorized || STATE.launchRetryInFlight) return true;
  if (STATE.launchRetryAttempts >= MAX_LAUNCH_RETRIES) return false;

  const now = Date.now();
  if (now - STATE.lastLaunchRetryAt < LAUNCH_RETRY_DELAY_MS) {
    setStatus('Waiting for dashboard launch authorization');
    scheduleAttempt(LAUNCH_RETRY_DELAY_MS);
    return true;
  }

  STATE.launchRetryAttempts += 1;
  STATE.lastLaunchRetryAt = now;
  STATE.launchRetryInFlight = true;
  setStatus(`Checking dashboard launch authorization (${STATE.launchRetryAttempts}/${MAX_LAUNCH_RETRIES})${STATE.launchTicket ? '' : ' - no ticket yet'}`);

  loadLaunchState()
    .then(() => {
      STATE.launchRetryInFlight = false;
      if (STATE.launchAuthorized) {
        STATE.launchRetryAttempts = 0;
      }
      scheduleAttempt(100);
    })
    .catch((error) => {
      STATE.lastLaunchError = `${error?.message || 'Launch authorization check failed'}`.trim();
      STATE.launchRetryInFlight = false;
      scheduleAttempt(LAUNCH_RETRY_DELAY_MS);
    });

  return true;
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
    element?.getAttribute?.('href'),
  ].filter(Boolean).join(' '));
}

function collectActionCandidates(root = document) {
  return Array.from(root.querySelectorAll(ACTION_SELECTORS))
    .filter((element) => isVisible(element) && !isDisabled(element));
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

function collectBroadActionCandidates() {
  const textNodes = Array.from(document.querySelectorAll('button, a[href], [role="button"], [tabindex], div, span'))
    .map((element) => findClickableAncestor(element));
  return Array.from(new Set([
    ...collectActionCandidates(),
    ...textNodes.filter(Boolean),
  ])).filter((element) => isVisible(element) && !isDisabled(element));
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
    input.dispatchEvent(new InputEvent('beforeinput', {
      bubbles: true,
      cancelable: true,
      data: nextValue,
      inputType: 'insertText',
    }));
  } catch {}
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

  let resolvedTarget = target;
  try {
    const rect = target.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) {
      const clientX = rect.left + (rect.width / 2);
      const clientY = rect.top + (rect.height / 2);
      const pointed = document.elementFromPoint(clientX, clientY);
      const pointedTarget = findClickableAncestor(pointed) || pointed;
      if (pointedTarget && isVisible(pointedTarget) && !isDisabled(pointedTarget)) {
        resolvedTarget = pointedTarget;
      }
    }
  } catch {}

  dispatchMouseSequence(resolvedTarget);

  try {
    resolvedTarget.click();
    return true;
  } catch {
    try {
      const rect = resolvedTarget.getBoundingClientRect();
      resolvedTarget.dispatchEvent(new MouseEvent('click', {
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

function findLoginSubmitButton(emailInput, passwordInput) {
  const exactMatches = new Set(['sign in', 'login', 'log in', 'continue', 'next']);
  for (const root of getFieldRoots(emailInput, passwordInput)) {
    const candidates = collectActionCandidates(root);
    const exact = candidates.find((element) => exactMatches.has(actionText(element)));
    if (exact) return exact;

    const partial = candidates.find((element) => {
      const text = actionText(element);
      return (text.includes('sign in') || text.includes('login') || text.includes('log in') || text.includes('continue') || text.includes('next'))
        && !text.includes('google')
        && !text.includes('apple')
        && !text.includes('sso');
    });
    if (partial) return partial;

    const submit = candidates.find((element) => `${element.type || ''}`.toLowerCase() === 'submit');
    if (submit) return submit;
  }

  return null;
}

function submitLogin(emailInput, passwordInput, submitButton) {
  if (submitButton && clickElement(submitButton)) return true;
  if (pressEnter(passwordInput || emailInput)) return true;
  const form = (passwordInput || emailInput)?.closest('form');
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
    return text.includes('sign in with google')
      || text.includes('continue with google')
      || text.includes('login with google')
      || (text === 'google' && hints.includes('google'));
  }) || null;
}

function findAuthOpenAction() {
  return collectBroadActionCandidates().find((element) => {
    const text = actionText(element);
    const hints = controlHintText(element);
    const href = normalizeText(element.getAttribute?.('href') || '');
    if (text.includes('google') || text.includes('sign up') || text.includes('contact sales')) return false;
    return text === 'log in'
      || text === 'login'
      || text === 'sign in'
      || href.includes('/sign-in')
      || hints.includes('/sign-in');
  }) || null;
}

function isAuthenticatedElevenLabsPage() {
  try {
    const url = new URL(window.location.href);
    const host = normalizeText(url.hostname);
    const path = normalizeText(url.pathname);
    if (!host.includes('elevenlabs.io')) return false;
    if (path.includes('/sign-in') || path.includes('/login') || path.includes('/signup')) {
      return false;
    }
  } catch {
    return false;
  }

  const emailInput = findInput(EMAIL_SELECTORS);
  const passwordInput = findInput(PASSWORD_SELECTORS);
  if (emailInput || passwordInput) return false;

  if (findGoogleLoginAction() || findAuthOpenAction()) return false;

  const pageText = normalizeText(document.body?.innerText || '');
  return pageText.includes('workspace')
    || pageText.includes('voices')
    || pageText.includes('projects')
    || pageText.includes('create')
    || pageText.includes('history')
    || pageText.includes('billing')
    || pageText.includes('profile')
    || pageText.includes('my account');
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
      extensionTicket: STATE.launchTicket || getStoredLaunchTicket(),
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

function isReadyForSubmit(emailInput, passwordInput) {
  if (!emailInput || !passwordInput || !STATE.credential) return false;
  return emailInput.value === STATE.credential.loginIdentifier
    && passwordInput.value === STATE.credential.password;
}

function attemptOpenAuth() {
  const authAction = findAuthOpenAction();
  if (!authAction) return false;
  if (!canActNow()) return true;

  markActionTaken();
  setStatus('Opening ElevenLabs sign-in');
  clickElement(authAction);
  scheduleAttempt(500);
  return true;
}

function attemptOpenGoogle() {
  const googleAction = findGoogleLoginAction();
  if (!googleAction) return false;
  if (!canActNow()) return true;

  markActionTaken();
  setStatus('Opening ElevenLabs Google sign-in');
  clickElement(googleAction);
  scheduleAttempt(700);
  return true;
}

function attemptFlow() {
  if (!STATE.launchChecked) {
    setStatus('Checking launch authorization');
    return;
  }

  if (!STATE.launchAuthorized) {
    if (retryLaunchAuthorizationIfNeeded()) return;
    stop(STATE.lastLaunchError || 'Launch this tool from the dashboard first');
    return;
  }

  if (isAuthenticatedElevenLabsPage()) {
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
    if (attemptOpenAuth()) return;
    setStatus('Waiting for ElevenLabs Google sign-in option');
    return;
  }

  if (!emailInput && !passwordInput) {
    if (attemptOpenAuth()) return;
    setStatus('Waiting for ElevenLabs email sign-in form');
    return;
  }

  if (!STATE.credential?.loginIdentifier || !STATE.credential?.password) {
    setStatus('Waiting for credential');
    return;
  }

  if (emailInput && emailInput.value !== STATE.credential.loginIdentifier) {
    emailInput.focus?.();
    setInputValue(emailInput, STATE.credential.loginIdentifier);
  }

  if (passwordInput && passwordInput.value !== STATE.credential.password) {
    passwordInput.focus?.();
    setInputValue(passwordInput, STATE.credential.password);
  }

  if (!isReadyForSubmit(emailInput, passwordInput)) {
    setStatus('Filling ElevenLabs login form');
    return;
  }

  if (Date.now() - STATE.lastSubmitAt < SUBMIT_COOLDOWN_MS) {
    setStatus('Waiting for ElevenLabs sign-in');
    return;
  }

  const submitButton = findLoginSubmitButton(emailInput, passwordInput);
  STATE.lastSubmitAt = Date.now();
  setStatus('Submitting ElevenLabs login');
  submitLogin(emailInput, passwordInput, submitButton);
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

  STATE.observer = new MutationObserver(() => scheduleAttempt(350));
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
}

start();
