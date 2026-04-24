(() => {
const LOGIN_FLOW_STORAGE_KEY = 'rmw_chatgpt_login_flow_hints_v1';
const LOGIN_FLOW_HINT_TTL_MS = 45 * 24 * 60 * 60 * 1000;
const STATE = {
  credential: null,
  requested: false,
  requestAttempts: 0,
  lastRequestAt: 0,
  lastEmailFilledAt: 0,
  lastEmailSubmitAt: 0,
  lastPasswordFilledAt: 0,
  lastPasswordSubmitAt: 0,
  emailSubmitted: false,
  passwordSubmitted: false,
  scheduledTimer: null,
  keepAliveTimer: null,
  observer: null,
  lastRunAt: 0,
  lastMutationHandledAt: 0,
  launchChecked: false,
  launchAuthorized: false,
  toolSlug: '',
  settled: false,
  status: 'Waiting for Google sign-in',
};

const MIN_RUN_GAP_MS = 900;
const KEEP_ALIVE_MS = 3500;
const STEP_PENDING_RETRY_MS = 5000;
const INPUT_SETTLE_MS = 300;
const NEXT_BUTTON_WAIT_MS = 2500;
const NEXT_BUTTON_POLL_MS = 120;
const EMAIL_SELECTORS = [
  'input[type="email"]',
  'input[id="identifierId"]',
  'input[type="text"][name="identifier"]',
  'input[type="text"]#identifierId',
  'input[name="identifier"]',
  'input[autocomplete="username"]',
  'input[autocomplete*="username" i]',
  'input[inputmode="email"]',
  'input[aria-label*="email" i]',
  'input[aria-label*="phone" i]',
];
const PASSWORD_SELECTORS = [
  'input[type="password"]',
  'input[name="Passwd"]',
  'input[autocomplete="current-password"]',
];
const NEXT_SELECTORS = [
  '#identifierNext button',
  '#passwordNext button',
  'button[jsname]',
  'button',
  '[role="button"]',
];

function normalizeToolSlug(value) {
  return `${value || ''}`.trim().toLowerCase();
}

function getCredentialFlowKey(credential, toolSlug = STATE.toolSlug) {
  const normalizedToolSlug = normalizeToolSlug(toolSlug);
  if (!normalizedToolSlug) return '';

  const identifier = `${credential?.loginIdentifier || ''}`.trim().toLowerCase();
  const domain = identifier.includes('@') ? identifier.split('@').pop() : identifier;
  return domain ? `${normalizedToolSlug}:${domain}` : `${normalizedToolSlug}:default`;
}

function rememberGoogleFlow(credential, evidence = 'google_accounts_page', toolSlug = STATE.toolSlug) {
  const key = getCredentialFlowKey(credential, toolSlug);
  if (!key) return;

  chrome.storage.local.get([LOGIN_FLOW_STORAGE_KEY])
    .then((stored) => {
      const hints = { ...(stored[LOGIN_FLOW_STORAGE_KEY] || {}) };
      const now = Date.now();
      Object.keys(hints).forEach((hintKey) => {
        const hint = hints[hintKey];
        if (!hint || Number(hint.updatedAt || 0) + LOGIN_FLOW_HINT_TTL_MS <= now) {
          delete hints[hintKey];
        }
      });
      hints[key] = {
        flow: 'google_oauth',
        evidence,
        updatedAt: now,
      };
      return chrome.storage.local.set({ [LOGIN_FLOW_STORAGE_KEY]: hints });
    })
    .catch(() => {});
}

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

function setStatus(message) {
  if (STATE.status === message) return;
  STATE.status = message;
  const badge = ensureStatusBadge();
  if (badge) {
    badge.textContent = `Google auto-login\n${message}`;
  }
  console.debug('[RMW Google Auto Login]', message);
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

function findInput(selectors) {
  for (const selector of selectors) {
    const matches = Array.from(document.querySelectorAll(selector));
    const input = matches.find((item) => !item.readOnly && !isDisabled(item) && isVisible(item));
    if (input) return input;
  }
  return null;
}

function findGoogleEmailInput() {
  const direct = findInput(EMAIL_SELECTORS);
  if (direct) return direct;

  const candidates = Array.from(document.querySelectorAll('input'))
    .filter((input) => !input.readOnly && !isDisabled(input) && isVisible(input) && input.type !== 'password');

  return candidates.find((input) => {
    const descriptor = [
      input.id,
      input.name,
      input.type,
      input.autocomplete,
      input.inputMode,
      input.getAttribute('aria-label'),
      input.getAttribute('placeholder'),
      input.closest('form, main, section, div')?.innerText,
    ]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();

    return descriptor.includes('identifier')
      || descriptor.includes('email')
      || descriptor.includes('phone')
      || descriptor.includes('username')
      || descriptor.includes('identifierid')
      || descriptor.includes('email or phone');
  }) || null;
}

function findGooglePasswordInput() {
  return findInput(PASSWORD_SELECTORS);
}

function getValueSetter(element) {
  let current = element;
  while (current) {
    const descriptor = Object.getOwnPropertyDescriptor(current, 'value');
    if (descriptor?.set) {
      return descriptor.set;
    }
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
    input.focus();
  }
  try {
    input.select?.();
  } catch {}

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

function sleep(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, Math.max(0, ms)));
}

function inferToolSlugFromGooglePage() {
  try {
    const url = new URL(window.location.href);
    const values = [
      url.searchParams.get('redirect_uri'),
      url.searchParams.get('app_domain'),
      url.searchParams.get('continue'),
      document.referrer,
    ]
      .filter(Boolean)
      .map((value) => `${value}`.toLowerCase());

    if (values.some((value) => value.includes('labs.google'))) {
      return 'flow';
    }
  } catch {}

  return '';
}

function isGoogleIdentifierUrl() {
  try {
    const url = new URL(window.location.href);
    return url.hostname.includes('accounts.google.com') && url.pathname.includes('/signin/identifier');
  } catch {
    return false;
  }
}

function isGooglePasswordUrl() {
  try {
    const url = new URL(window.location.href);
    return url.hostname.includes('accounts.google.com')
      && (url.pathname.includes('/signin/challenge') || url.pathname.includes('/signin/v2/challenge'));
  } catch {
    return false;
  }
}

function buttonText(button) {
  return `${button.innerText || button.textContent || button.value || button.getAttribute?.('aria-label') || ''}`
    .trim()
    .toLowerCase();
}

function findStepContainer(input) {
  if (!input) return [document];

  const containers = [];
  let current = input.parentElement;

  while (current && current !== document.body) {
    containers.push(current);
    if (current.matches?.('form, [role="dialog"], [aria-modal="true"], main, section, article, div[data-view-id], div[data-identifier]')) {
      break;
    }
    current = current.parentElement;
  }

  containers.push(document);
  return containers;
}

function findRealClickableTarget(element) {
  if (!element) return null;

  const descendant = Array.from(
    element.querySelectorAll?.('button, a[href], input[type="button"], input[type="submit"], [role="button"]') || []
  ).find((candidate) => !isDisabled(candidate) && isVisible(candidate));
  if (descendant) {
    return descendant;
  }

  let current = element;
  while (current && current !== document.body) {
    if (
      current.matches?.('button, a[href], input[type="button"], input[type="submit"], [role="button"]')
      && !isDisabled(current)
      && isVisible(current)
    ) {
      return current;
    }
    current = current.parentElement;
  }
  return element;
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

function safeClick(element) {
  const target = findRealClickableTarget(element);
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
      target.dispatchEvent(new MouseEvent('click', {
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

function submitStep(button, input) {
  if (button && safeClick(button)) return true;
  return pressEnter(input);
}

function didGoogleEmailAdvance() {
  return Boolean(
    findGooglePasswordInput()
    || isGooglePasswordUrl()
    || (!isGoogleIdentifierUrl() && !findGoogleEmailInput())
  );
}

function didGooglePasswordAdvance() {
  return Boolean(
    !findGooglePasswordInput()
    || !isGooglePasswordUrl()
  );
}

function getGoogleNextButton(kind, input = null) {
  const selectors = kind === 'email'
    ? ['#identifierNext button', '#identifierNext [role="button"]', '#identifierNext']
    : ['#passwordNext button', '#passwordNext [role="button"]', '#passwordNext'];

  for (const selector of selectors) {
    const match = Array.from(document.querySelectorAll(selector))
      .find((element) => !isDisabled(element) && isVisible(element));
    if (match) return match;
  }

  return findNextButton(kind, input);
}

async function waitForGoogleNextButton(kind, input = null, timeoutMs = NEXT_BUTTON_WAIT_MS) {
  const deadline = Date.now() + Math.max(0, timeoutMs);
  let button = getGoogleNextButton(kind, input);
  while (!button && Date.now() < deadline) {
    await sleep(NEXT_BUTTON_POLL_MS);
    button = getGoogleNextButton(kind, input);
  }
  return button;
}

function findNextButton(kind, input = null) {
  const candidates = Array.from(document.querySelectorAll(NEXT_SELECTORS.join(',')))
    .filter((button) => !isDisabled(button) && isVisible(button));

  const roots = findStepContainer(input);
  const words = kind === 'password'
    ? ['next', 'continue', 'sign in', 'yes, continue', 'confirm']
    : ['next', 'continue', 'yes, continue'];

  for (const root of roots) {
    const scopedCandidates = candidates.filter((button) => root === document || root.contains(button));
    if (!scopedCandidates.length) continue;

    const explicit = kind === 'email'
      ? scopedCandidates.find((button) => button.closest('#identifierNext'))
      : scopedCandidates.find((button) => button.closest('#passwordNext'));
    if (explicit) return explicit;

    const exact = scopedCandidates.find((button) => words.includes(buttonText(button)));
    if (exact) return exact;

    const partial = scopedCandidates.find((button) => words.some((word) => buttonText(button).includes(word)));
    if (partial) return partial;
  }

  if (kind === 'email') {
    return candidates.find((button) => button.closest('#identifierNext'))
      || candidates.find((button) => words.some((word) => buttonText(button).includes(word)))
      || null;
  }

  return candidates.find((button) => button.closest('#passwordNext'))
    || candidates.find((button) => words.some((word) => buttonText(button).includes(word)))
    || null;
}

function getGoogleEmailValue(loginIdentifier, input) {
  const full = `${loginIdentifier || ''}`.trim();
  if (!full.includes('@')) return full;

  const screenText = `${input.closest('form, main, section, div')?.innerText || document.body?.innerText || ''}`.toLowerCase();
  const domain = full.split('@')[1].toLowerCase();
  if (domain && screenText.includes(`@${domain}`)) {
    return full.split('@')[0];
  }

  return full;
}

async function submitGoogleNextStep(kind, input) {
  const waitAfterSubmitMs = kind === 'password' ? 900 : 700;
  const didAdvance = kind === 'password' ? didGooglePasswordAdvance : didGoogleEmailAdvance;

  const nextButton = await waitForGoogleNextButton(kind, input);
  if (nextButton && safeClick(nextButton)) {
    await sleep(waitAfterSubmitMs);
    if (didAdvance()) return true;
  }

  if (pressEnter(input)) {
    await sleep(waitAfterSubmitMs);
    if (didAdvance()) return true;
  }

  const form = input.closest('form');
  if (form) {
    try {
      if (typeof form.requestSubmit === 'function') form.requestSubmit();
      else form.submit?.();
    } catch {}
    await sleep(waitAfterSubmitMs);
    if (didAdvance()) return true;
  }

  const retryButton = getGoogleNextButton(kind, input);
  if (retryButton && retryButton !== nextButton && safeClick(retryButton)) {
    await sleep(waitAfterSubmitMs);
    if (didAdvance()) return true;
  }

  return didAdvance();
}

async function submitGoogleEmailStep(credential) {
  const input = findGoogleEmailInput();
  if (!input) return false;

  const emailValue = getGoogleEmailValue(credential?.loginIdentifier, input);
  if (!emailValue) return false;

  try {
    input.focus({ preventScroll: true });
  } catch {
    input.focus?.();
  }

  setInputValue(input, emailValue);
  input.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
  input.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
  input.dispatchEvent(new Event('blur', { bubbles: true, cancelable: true }));

  await sleep(Math.max(INPUT_SETTLE_MS, 350));
  if (`${input.value || ''}`.trim() !== `${emailValue}`.trim()) {
    setInputValue(input, emailValue);
    await sleep(200);
  }
  return submitGoogleNextStep('email', input);
}

async function submitGooglePasswordStep(credential) {
  const input = findGooglePasswordInput();
  if (!input) return false;

  const passwordValue = `${credential?.password || ''}`;
  if (!passwordValue) return false;

  try {
    input.focus({ preventScroll: true });
  } catch {
    input.focus?.();
  }

  setInputValue(input, passwordValue);
  input.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
  input.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
  input.dispatchEvent(new Event('blur', { bubbles: true, cancelable: true }));

  await sleep(Math.max(INPUT_SETTLE_MS, 350));
  if (`${input.value || ''}` !== passwordValue) {
    setInputValue(input, passwordValue);
    await sleep(200);
  }
  return submitGoogleNextStep('password', input);
}

async function loadLaunchState() {
  const inferredToolSlug = normalizeToolSlug(STATE.toolSlug || inferToolSlugFromGooglePage());
  const response = await sendRuntimeMessage({
    type: 'TOOL_HUB_GET_LAUNCH_STATE',
    toolSlug: inferredToolSlug,
    hostname: window.location.hostname,
    pageUrl: window.location.href,
  });

  STATE.launchChecked = true;
  STATE.launchAuthorized = Boolean(response?.ok && response.authorized);
  if (response?.ok && response.toolSlug) {
    STATE.toolSlug = normalizeToolSlug(response.toolSlug);
  } else if (inferredToolSlug) {
    STATE.toolSlug = inferredToolSlug;
  }
}

function enforceDashboardOnlyAccess() {
  setStatus('Launch this tool from the dashboard first');
  STATE.settled = true;
}

function requestCredential() {
  const now = Date.now();
  const toolSlug = normalizeToolSlug(STATE.toolSlug || inferToolSlugFromGooglePage());
  if (!toolSlug) {
    setStatus('Waiting for active dashboard launch');
    return;
  }
  STATE.toolSlug = toolSlug;
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
      toolSlug,
      hostname: window.location.hostname,
      pageUrl: window.location.href,
    },
    (response) => {
      STATE.requested = false;

      if (chrome.runtime.lastError) {
        STATE.settled = true;
        setStatus(`Extension error: ${chrome.runtime.lastError.message}`);
        return;
      }

      if (!response?.ok) {
        setStatus(response?.error || 'Credential unavailable');
        if ((response?.error || '').includes('http=404')) {
          STATE.settled = true;
        }
        return;
      }

      STATE.credential = response.data?.credential || null;
      rememberGoogleFlow(STATE.credential, 'google_accounts_page', toolSlug);
      setStatus(STATE.credential ? 'Credential loaded' : 'Credential missing');
      scheduleAttempt(150);
    }
  );
}

async function attemptEmailStep(credential) {
  const input = findGoogleEmailInput();
  if (!input) return false;

  if (isGoogleIdentifierUrl() || document.querySelector('#identifierNext')) {
    if (STATE.emailSubmitted && Date.now() - STATE.lastEmailSubmitAt < STEP_PENDING_RETRY_MS) {
      setStatus('Email submitted, waiting for password page');
      scheduleAttempt(700);
      return true;
    }

    setStatus('Submitting Google email');
    const ok = await submitGoogleEmailStep(credential);
    if (!ok) {
      setStatus('Google email step not ready');
      scheduleAttempt(500);
      return true;
    }

    STATE.lastEmailFilledAt = Date.now();
    STATE.lastEmailSubmitAt = Date.now();
    STATE.emailSubmitted = true;
    setStatus('Email submitted, waiting for password page');
    scheduleAttempt(1200);
    return true;
  }

  const emailValue = getGoogleEmailValue(credential.loginIdentifier, input);
  if (input.value !== emailValue) {
    input.focus();
    setInputValue(input, emailValue);
    STATE.lastEmailFilledAt = Date.now();
    STATE.emailSubmitted = false;
    setStatus('Email filled, waiting to continue');
    scheduleAttempt(INPUT_SETTLE_MS);
    return true;
  }

  if (STATE.lastEmailFilledAt > 0) {
    const settleRemaining = INPUT_SETTLE_MS - (Date.now() - STATE.lastEmailFilledAt);
    if (settleRemaining > 0) {
      setStatus('Email filled, waiting to continue');
      scheduleAttempt(settleRemaining);
      return true;
    }
  }

  if (STATE.emailSubmitted) {
    if (Date.now() - STATE.lastEmailSubmitAt > STEP_PENDING_RETRY_MS) {
      STATE.emailSubmitted = false;
    } else {
      setStatus('Email filled, waiting for password page');
      return true;
    }
  }

  const nextButton = findNextButton('email', input);

  const now = Date.now();
  if (input.value && now - STATE.lastEmailSubmitAt > 2500) {
    if (!nextButton) {
      setStatus('Email filled, trying Enter fallback');
    }

    if (!submitStep(nextButton, input)) {
      setStatus('Email filled, submit action not ready');
      scheduleAttempt(250);
      return true;
    }

    STATE.lastEmailSubmitAt = now;
    STATE.emailSubmitted = true;
    setStatus('Email filled, moving to password');
  }
  return true;
}

async function attemptPasswordStep(credential) {
  const input = findGooglePasswordInput();
  if (!input) return false;

  if (isGooglePasswordUrl() || document.querySelector('#passwordNext')) {
    STATE.emailSubmitted = false;
    if (STATE.passwordSubmitted && Date.now() - STATE.lastPasswordSubmitAt < STEP_PENDING_RETRY_MS) {
      setStatus('Password submitted, waiting for Google sign-in');
      scheduleAttempt(700);
      return true;
    }

    setStatus('Submitting Google password');
    const ok = await submitGooglePasswordStep(credential);
    if (!ok) {
      setStatus('Google password step not ready');
      scheduleAttempt(500);
      return true;
    }

    STATE.lastPasswordFilledAt = Date.now();
    STATE.lastPasswordSubmitAt = Date.now();
    STATE.passwordSubmitted = true;
    setStatus('Password submitted, signing in');
    scheduleAttempt(1500);
    return true;
  }

  STATE.emailSubmitted = false;
  if (input.value !== credential.password) {
    input.focus();
    setInputValue(input, credential.password);
    STATE.lastPasswordFilledAt = Date.now();
    STATE.passwordSubmitted = false;
    setStatus('Password filled, waiting to continue');
    scheduleAttempt(INPUT_SETTLE_MS);
    return true;
  }

  if (STATE.lastPasswordFilledAt > 0) {
    const settleRemaining = INPUT_SETTLE_MS - (Date.now() - STATE.lastPasswordFilledAt);
    if (settleRemaining > 0) {
      setStatus('Password filled, waiting to continue');
      scheduleAttempt(settleRemaining);
      return true;
    }
  }

  if (STATE.passwordSubmitted) {
    if (Date.now() - STATE.lastPasswordSubmitAt > STEP_PENDING_RETRY_MS) {
      STATE.passwordSubmitted = false;
    } else {
      setStatus('Password filled, waiting for Google sign-in');
      return true;
    }
  }

  const nextButton = findNextButton('password', input);

  const now = Date.now();
  if (input.value && now - STATE.lastPasswordSubmitAt > 2500) {
    if (!nextButton) {
      setStatus('Password filled, trying Enter fallback');
    }

    if (!submitStep(nextButton, input)) {
      setStatus('Password filled, submit action not ready');
      scheduleAttempt(250);
      return true;
    }

    STATE.lastPasswordSubmitAt = now;
    STATE.passwordSubmitted = true;
    setStatus('Password filled, clicking Next');
  }
  return true;
}

async function attemptFill() {
  if (STATE.settled) return;
  if (!STATE.launchChecked) {
    setStatus('Checking dashboard launch');
    return;
  }
  if (!STATE.launchAuthorized) {
    enforceDashboardOnlyAccess();
    return;
  }

  const credential = STATE.credential;
  if (!credential?.loginIdentifier || !credential?.password) {
    if (findGoogleEmailInput() || findGooglePasswordInput()) {
      requestCredential();
    }
    return;
  }

  if (await attemptPasswordStep(credential)) return;
  if (await attemptEmailStep(credential)) return;

  setStatus('Waiting for Google sign-in fields');
}

async function runAttempt() {
  STATE.scheduledTimer = null;

  const now = Date.now();
  if (now - STATE.lastRunAt < MIN_RUN_GAP_MS) {
    scheduleAttempt(MIN_RUN_GAP_MS - (now - STATE.lastRunAt));
    return;
  }

  STATE.lastRunAt = now;

  try {
    await attemptFill();
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
  const inferredToolSlug = normalizeToolSlug(inferToolSlugFromGooglePage());
  if (inferredToolSlug) {
    STATE.toolSlug = inferredToolSlug;
    ensureStatusBadge();
    setStatus(`Booting ${inferredToolSlug} Google auto-login`);
  }

  STATE.observer = new MutationObserver(() => handleMutations());
  STATE.observer.observe(document.body || document.documentElement, { childList: true, subtree: true });
  STATE.keepAliveTimer = window.setInterval(() => scheduleAttempt(0), KEEP_ALIVE_MS);
  loadLaunchState()
    .catch(() => {
      STATE.launchChecked = true;
      STATE.launchAuthorized = false;
    })
    .finally(() => {
      const activeToolSlug = normalizeToolSlug(STATE.toolSlug);
      if (activeToolSlug === 'chatgpt') {
        STATE.settled = true;
        return;
      }
      ensureStatusBadge();
      scheduleAttempt(0);
    });
}

start();
})();
