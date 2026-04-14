const TOOL_SLUG = 'chatgpt';
const TOOL_HOSTNAME = 'chatgpt.com';
const STATE = {
  credential: null,
  requested: false,
  requestAttempts: 0,
  lastRequestAt: 0,
  lastEmailSubmitAt: 0,
  lastPasswordSubmitAt: 0,
  emailSubmitted: false,
  passwordSubmitted: false,
  scheduledTimer: null,
  keepAliveTimer: null,
  observer: null,
  lastRunAt: 0,
  lastMutationHandledAt: 0,
  settled: false,
  status: 'Waiting for Google sign-in',
};

const MIN_RUN_GAP_MS = 900;
const KEEP_ALIVE_MS = 3500;
const EMAIL_SELECTORS = [
  'input[type="email"]',
  'input[type="text"][name="identifier"]',
  'input[name="identifier"]',
  'input[autocomplete="username"]',
  'input[aria-label*="email" i]',
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

function setInputValue(input, value) {
  const descriptor = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value');
  if (descriptor?.set) descriptor.set.call(input, value);
  else input.value = value;

  input.setAttribute('value', value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
  input.dispatchEvent(new Event('blur', { bubbles: true }));
}

function buttonText(button) {
  return `${button.innerText || button.textContent || button.value || button.getAttribute?.('aria-label') || ''}`
    .trim()
    .toLowerCase();
}

function findNextButton(kind) {
  const candidates = Array.from(document.querySelectorAll(NEXT_SELECTORS.join(',')))
    .filter((button) => !isDisabled(button) && isVisible(button));

  if (kind === 'email') {
    return candidates.find((button) => button.closest('#identifierNext'))
      || candidates.find((button) => buttonText(button) === 'next')
      || null;
  }

  return candidates.find((button) => button.closest('#passwordNext'))
    || candidates.find((button) => buttonText(button) === 'next')
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
      hostname: TOOL_HOSTNAME,
      pageUrl: `https://${TOOL_HOSTNAME}/`,
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
      setStatus(STATE.credential ? 'Credential loaded' : 'Credential missing');
      scheduleAttempt(150);
    }
  );
}

function attemptEmailStep(credential) {
  const input = findInput(EMAIL_SELECTORS);
  if (!input) return false;

  const emailValue = getGoogleEmailValue(credential.loginIdentifier, input);
  if (input.value !== emailValue) {
    input.focus();
    setInputValue(input, emailValue);
  }

  if (STATE.emailSubmitted) {
    setStatus('Email filled, waiting for password page');
    return true;
  }

  const nextButton = findNextButton('email');
  if (!nextButton) {
    setStatus('Email filled, Next button not found');
    return true;
  }

  const now = Date.now();
  if (input.value && now - STATE.lastEmailSubmitAt > 2500) {
    STATE.lastEmailSubmitAt = now;
    STATE.emailSubmitted = true;
    setStatus('Email filled, moving to password');
    window.setTimeout(() => nextButton.click(), 300);
  }
  return true;
}

function attemptPasswordStep(credential) {
  const input = findInput(PASSWORD_SELECTORS);
  if (!input) return false;

  STATE.emailSubmitted = false;
  if (input.value !== credential.password) {
    input.focus();
    setInputValue(input, credential.password);
  }

  if (STATE.passwordSubmitted) {
    setStatus('Password filled, waiting for Google sign-in');
    return true;
  }

  const nextButton = findNextButton('password');
  if (!nextButton) {
    setStatus('Password filled, Next button not found');
    return true;
  }

  const now = Date.now();
  if (input.value && now - STATE.lastPasswordSubmitAt > 2500) {
    STATE.lastPasswordSubmitAt = now;
    STATE.passwordSubmitted = true;
    setStatus('Password filled, clicking Next');
    window.setTimeout(() => nextButton.click(), 300);
  }
  return true;
}

function attemptFill() {
  if (STATE.settled) return;

  const credential = STATE.credential;
  if (!credential?.loginIdentifier || !credential?.password) {
    if (findInput(EMAIL_SELECTORS) || findInput(PASSWORD_SELECTORS)) {
      requestCredential();
    }
    return;
  }

  if (attemptPasswordStep(credential)) return;
  if (attemptEmailStep(credential)) return;

  setStatus('Waiting for Google sign-in fields');
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
  STATE.observer = new MutationObserver(() => handleMutations());
  STATE.observer.observe(document.body || document.documentElement, { childList: true, subtree: true });
  STATE.keepAliveTimer = window.setInterval(() => scheduleAttempt(0), KEEP_ALIVE_MS);
  scheduleAttempt(0);
}

start();
