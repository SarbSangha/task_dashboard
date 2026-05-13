const TOOL_SLUG = 'canva';
const EXTENSION_TICKET_KEY = 'rmw_extension_ticket';

const MIN_RUN_GAP_MS = 500;
const KEEP_ALIVE_MS = 2500;
const ACTION_COOLDOWN_MS = 1800;
const SUBMIT_COOLDOWN_MS = 4500;
const EMAIL_STAGE_SETTLE_MS = 2200;

const EMAIL_SELECTORS = [
  'input[type="email"]',
  'input[type="text"][placeholder*="email" i]',
  'input[type="text"][aria-label*="email" i]',
  'input[type="text"][placeholder*="phone" i]',
  'input[type="text"][aria-label*="phone" i]',
  'input[name*="email" i]',
  'input[id*="email" i]',
  'input[autocomplete="username"]',
  'input[autocomplete="email"]',
  'input[inputmode="email"]',
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

const OTP_SELECTORS = [
  'input[autocomplete="one-time-code"]',
  'input[name="code"]',
  'input[name*="otp" i]',
  'input[name*="verification" i]',
  'input[id*="code" i]',
  'input[id*="otp" i]',
  'input[id*="verification" i]',
  'input[placeholder*="code" i]',
  'input[placeholder*="otp" i]',
  'input[placeholder*="verification" i]',
  'input[aria-label*="code" i]',
  'input[aria-label*="otp" i]',
  'input[aria-label*="verification" i]',
].join(',');

const ACTION_SELECTORS = [
  'button',
  'a[href]',
  'input[type="submit"]',
  'input[type="button"]',
  '[role="button"]',
].join(',');

const STATE = {
  status: 'Waiting for Canva',
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
  lastEmailContinueAt: 0,
  otpValue: '',
  otpFetching: false,
  otpRequestAttempts: 0,
  otpLastRequestAt: 0,
  otpSubmittedAt: 0,
};

function ensureStatusBadge() {
  const existing = document.getElementById('rmw-canva-autologin-status');
  if (existing) return existing;

  const badge = document.createElement('div');
  badge.id = 'rmw-canva-autologin-status';
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
  badge.textContent = `Canva auto-login\n${STATE.status}`;
  (document.body || document.documentElement).appendChild(badge);
  return badge;
}

function hideStatusBadge() {
  document.getElementById('rmw-canva-autologin-status')?.remove();
}

function setStatus(message) {
  if (STATE.status === message) return;
  STATE.status = message;
  ensureStatusBadge().textContent = `Canva auto-login\n${message}`;
  console.debug('[RMW Canva Auto Login]', message);
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

function complete(message = 'Canva login complete') {
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
  console.debug('[RMW Canva Auto Login]', message);
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

function pageText() {
  return normalizeText(document.body?.innerText || document.body?.textContent || '');
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

function findOtpInput() {
  const direct = findInput(OTP_SELECTORS);
  if (direct) return direct;

  const text = pageText();
  const looksLikeOtpScreen = text.includes('finish logging in')
    || text.includes('enter the code')
    || text.includes('code we sent')
    || text.includes("didn't get the code")
    || text.includes('resend');
  if (!looksLikeOtpScreen) return null;

  return Array.from(document.querySelectorAll('input'))
    .find((element) => {
      if (!isVisible(element) || element.disabled || element.readOnly) return false;
      const type = `${element.type || ''}`.trim().toLowerCase();
      if (type === 'password' || type === 'email') return false;
      const hints = normalizeText([
        element.type,
        element.name,
        element.id,
        element.placeholder,
        element.getAttribute('aria-label'),
        element.getAttribute('autocomplete'),
        element.getAttribute('inputmode'),
      ].filter(Boolean).join(' '));
      return hints.includes('code')
        || hints.includes('otp')
        || hints.includes('verification')
        || hints.includes('one-time')
        || hints.includes('numeric');
    }) || null;
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

function findCanvaEmailAction() {
  return collectBroadActionCandidates().find((element) => {
    const text = actionText(element);
    return text === 'continue with email'
      || text.includes('continue with email');
  }) || null;
}

function findAuthOpenAction() {
  return collectBroadActionCandidates().find((element) => {
    const text = actionText(element);
    const hints = controlHintText(element);
    const href = normalizeText(element.getAttribute?.('href') || '');
    if (text.includes('google') || text.includes('sign up')) return false;
    return text === 'log in'
      || text === 'login'
      || text === 'sign in'
      || href.includes('/login')
      || hints.includes('/login');
  }) || null;
}

function findEmailInput() {
  const direct = findInput(EMAIL_SELECTORS);
  if (direct) return direct;

  return Array.from(document.querySelectorAll('input'))
    .find((element) => {
      if (!isVisible(element) || element.disabled || element.readOnly) return false;
      if ((element.type || '').toLowerCase() === 'password') return false;
      const hints = normalizeText([
        element.type,
        element.name,
        element.id,
        element.placeholder,
        element.getAttribute('aria-label'),
        element.getAttribute('autocomplete'),
      ].filter(Boolean).join(' '));
      return hints.includes('email')
        || hints.includes('phone number')
        || hints.includes('phone/email')
        || hints.includes('username');
    }) || null;
}

function findStageSubmitButton(emailInput, passwordInput) {
  const exactMatches = passwordInput
    ? new Set(['continue', 'log in', 'login', 'sign in'])
    : new Set(['continue', 'next']);

  for (const root of getFieldRoots(passwordInput || emailInput)) {
    const candidates = collectActionCandidates(root);
    const exact = candidates.find((element) => exactMatches.has(actionText(element)));
    if (exact) return exact;

    const partial = candidates.find((element) => {
      const text = actionText(element);
      return (text.includes('continue') || text.includes('next') || text.includes('log in') || text.includes('login') || text.includes('sign in'))
        && !text.includes('google')
        && !text.includes('apple')
        && !text.includes('phone number')
        && !text.includes('another way');
    });
    if (partial) return partial;

    const submit = candidates.find((element) => `${element.type || ''}`.toLowerCase() === 'submit');
    if (submit) return submit;
  }

  return null;
}

function findOtpSubmitButton(otpInput) {
  return findStageSubmitButton(otpInput, null)
    || collectActionCandidates()
      .find((element) => {
        const text = actionText(element);
        return (text === 'continue' || text.includes('continue') || text.includes('verify'))
          && !text.includes('google')
          && !text.includes('help')
          && !text.includes('resend');
      })
    || null;
}

function submitStage(primaryInput, submitButton) {
  if (submitButton && clickElement(submitButton)) return true;
  if (pressEnter(primaryInput)) return true;
  const form = primaryInput?.closest('form');
  if (form) {
    try {
      if (typeof form.requestSubmit === 'function') form.requestSubmit();
      else form.submit?.();
      return true;
    } catch {}
  }
  return false;
}

function isAuthenticatedCanvaPage() {
  try {
    const url = new URL(window.location.href);
    const host = normalizeText(url.hostname);
    const path = normalizeText(url.pathname);
    if (!host.includes('canva.com')) return false;
    if (path.includes('/login') || path.includes('/signup') || path.includes('/register')) {
      return false;
    }
  } catch {
    return false;
  }

  const emailInput = findEmailInput();
  const passwordInput = findInput(PASSWORD_SELECTORS);
  if (emailInput || passwordInput) return false;

  if (findCanvaEmailAction() || findAuthOpenAction()) return false;

  return true;
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
      if (!STATE.credential?.loginIdentifier) {
        setStatus('Credential missing');
        return;
      }

      setStatus('Credential loaded');
      scheduleAttempt(100);
    }
  );
}

function requestOtp() {
  const now = Date.now();
  if (STATE.otpFetching || STATE.otpValue) return;
  if (STATE.otpRequestAttempts >= 4) {
    setStatus('Canva OTP fetch failed after 4 attempts');
    return;
  }
  if (now - STATE.otpLastRequestAt < 2500) return;

  STATE.otpFetching = true;
  STATE.otpLastRequestAt = now;
  STATE.otpRequestAttempts += 1;
  setStatus(`Fetching Canva OTP from email (attempt ${STATE.otpRequestAttempts})`);

  sendRuntimeMessage({
    type: 'TOOL_HUB_FETCH_OTP',
    toolSlug: TOOL_SLUG,
    hostname: window.location.hostname,
    pageUrl: window.location.href,
    extensionTicket: getStoredLaunchTicket(),
  }).then((response) => {
    STATE.otpFetching = false;

    if (!response?.ok || !response.otp) {
      setStatus(response?.error || 'Canva OTP not received yet');
      scheduleAttempt(1500);
      return;
    }

    STATE.otpValue = `${response.otp}`.trim();
    scheduleAttempt(100);
  });
}

function attemptOtpStep(otpInput) {
  if (!otpInput) return false;

  if (!STATE.otpValue && !STATE.otpFetching) {
    requestOtp();
  }

  if (!STATE.otpValue) {
    setStatus(STATE.otpFetching ? 'Fetching Canva OTP from email' : 'Waiting for Canva OTP');
    scheduleAttempt(1200);
    return true;
  }

  if (`${otpInput.value || ''}`.trim() !== STATE.otpValue) {
    setStatus('Filling Canva OTP');
    setInputValue(otpInput, STATE.otpValue);
    scheduleAttempt(300);
    return true;
  }

  if (Date.now() - STATE.otpSubmittedAt < 3000) {
    setStatus('Canva OTP submitted, waiting for login');
    return true;
  }

  const submitButton = findOtpSubmitButton(otpInput);
  STATE.otpSubmittedAt = Date.now();
  STATE.lastSubmitAt = Date.now();
  setStatus('Submitting Canva OTP');
  submitStage(otpInput, submitButton);
  return true;
}

function canActNow() {
  return Date.now() - STATE.lastActionAt > ACTION_COOLDOWN_MS;
}

function markActionTaken() {
  STATE.lastActionAt = Date.now();
}

function attemptOpenAuth() {
  const authAction = findAuthOpenAction();
  if (!authAction) return false;
  if (!canActNow()) return true;

  markActionTaken();
  setStatus('Opening Canva sign-in');
  clickElement(authAction);
  scheduleAttempt(500);
  return true;
}

function attemptOpenEmailStep() {
  const emailAction = findCanvaEmailAction();
  if (!emailAction) return false;
  if (!canActNow()) return true;

  markActionTaken();
  setStatus('Opening Canva email sign-in');
  clickElement(emailAction);
  scheduleAttempt(500);
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

  if (isAuthenticatedCanvaPage()) {
    complete();
    return;
  }

  const emailInput = findEmailInput();
  const passwordInput = findInput(PASSWORD_SELECTORS);
  const otpInput = findOtpInput();

  if (!STATE.credential) {
    requestCredential();
  }

  if (otpInput) {
    attemptOtpStep(otpInput);
    return;
  }

  if (!emailInput && !passwordInput) {
    if (attemptOpenEmailStep()) return;
    if (attemptOpenAuth()) return;
    setStatus('Waiting for Canva sign-in form');
    return;
  }

  if (!STATE.credential?.loginIdentifier) {
    setStatus('Waiting for credential');
    return;
  }

  if (!passwordInput) {
    if (emailInput && emailInput.value !== STATE.credential.loginIdentifier) {
      setInputValue(emailInput, STATE.credential.loginIdentifier);
    }

    if (emailInput?.value !== STATE.credential.loginIdentifier) {
      setStatus('Filling Canva email');
      return;
    }

    if (Date.now() - STATE.lastEmailContinueAt < EMAIL_STAGE_SETTLE_MS) {
      setStatus('Canva email submitted, waiting for password step');
      return;
    }

    if (Date.now() - STATE.lastSubmitAt < SUBMIT_COOLDOWN_MS) {
      setStatus('Waiting for Canva email continue');
      return;
    }

    const submitButton = findStageSubmitButton(emailInput, null);
    STATE.lastSubmitAt = Date.now();
    STATE.lastEmailContinueAt = Date.now();
    setStatus('Submitting Canva email');
    submitStage(emailInput, submitButton);
    return;
  }

  if (emailInput && emailInput.value && emailInput.value !== STATE.credential.loginIdentifier) {
    setInputValue(emailInput, STATE.credential.loginIdentifier);
  }

  if (!STATE.credential?.password) {
    setStatus('Canva password missing; waiting for OTP or manual password entry');
    return;
  }

  if (passwordInput.value !== STATE.credential.password) {
    setInputValue(passwordInput, STATE.credential.password);
  }

  if (passwordInput.value !== STATE.credential.password) {
    setStatus('Filling Canva password');
    return;
  }

  if (Date.now() - STATE.lastSubmitAt < SUBMIT_COOLDOWN_MS) {
    setStatus('Waiting for Canva sign-in');
    return;
  }

  const submitButton = findStageSubmitButton(emailInput, passwordInput);
  STATE.lastSubmitAt = Date.now();
  setStatus('Submitting Canva login');
  submitStage(passwordInput, submitButton);
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
