const TOOL_SLUG = 'chatgpt';
const STATE = {
  credential: null,
  requested: false,
  requestAttempts: 0,
  lastRequestAt: 0,
  lastEmailSubmitAt: 0,
  lastPasswordSubmitAt: 0,
  lastLandingLoginClickAt: 0,
  landingLoginAttempts: 0,
  emailStepPending: false,
  passwordStepPending: false,
  scheduledTimer: null,
  keepAliveTimer: null,
  observer: null,
  lastRunAt: 0,
  lastMutationHandledAt: 0,
  settled: false,
  status: 'Waiting for login form',
};

const MIN_RUN_GAP_MS = 900;
const KEEP_ALIVE_MS = 4000;

const EMAIL_SELECTORS = [
  'input[type="email"]',
  'input[type="text"][name="username"]',
  'input[type="text"][name="email"]',
  'input[name="email"]',
  'input[name="username"]',
  'input[autocomplete="username"]',
  'input[placeholder*="Email" i]',
  'input[placeholder*="email" i]',
  'input[aria-label*="Email" i]',
  'input[aria-label*="email" i]',
  'input[id*="email"]',
  'input[name*="email"]',
];

const PASSWORD_SELECTORS = [
  'input[type="password"]',
  'input[name="password"]',
  'input[autocomplete="current-password"]',
  'input[id*="password"]',
  'input[name*="password"]',
];

const ACTION_SELECTORS = [
  'button',
  'input[type="submit"]',
  'a[href]',
  '[role="button"]',
  '[role="link"]',
];

const CHATGPT_MODAL_INPUT_SELECTORS = [
  'input[type="email"]',
  'input[type="text"]',
  'input[autocomplete="username"]',
  'input[placeholder*="Email address" i]',
  'input[placeholder*="email address" i]',
  'input[placeholder*="Email" i]',
  'input[placeholder*="email" i]',
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

function collectRoots(root = document, roots = new Set()) {
  if (!root || roots.has(root)) return roots;
  roots.add(root);

  const nodes = [];
  if (root instanceof Document || root instanceof ShadowRoot) {
    nodes.push(...Array.from(root.children || []));
  } else if (root instanceof Element) {
    nodes.push(root);
  }

  while (nodes.length) {
    const node = nodes.shift();
    if (!(node instanceof Element)) continue;
    if (node.shadowRoot && !roots.has(node.shadowRoot)) {
      roots.add(node.shadowRoot);
      nodes.push(...Array.from(node.shadowRoot.children || []));
    }
    nodes.push(...Array.from(node.children || []));
  }

  return roots;
}

function queryAllDeep(selectors, root = document) {
  const list = Array.isArray(selectors) ? selectors : [selectors];
  const matches = [];

  for (const searchRoot of collectRoots(root)) {
    for (const selector of list) {
      try {
        matches.push(...Array.from(searchRoot.querySelectorAll(selector)));
      } catch {
        // Ignore selector parsing issues and continue.
      }
    }
  }

  return matches;
}

function findInput(selectors) {
  for (const selector of selectors) {
    const inputs = queryAllDeep(selector);
    const match = inputs.find((input) => !input.disabled && !input.readOnly && isVisible(input));
    if (match) return match;
  }
  return null;
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

  if (typeof input.click === 'function') {
    input.click();
  }
  input.focus();

  if (setter) setter.call(input, nextValue);
  else input.value = nextValue;

  input.setAttribute('value', nextValue);
  if (input._valueTracker?.setValue) {
    input._valueTracker.setValue(previousValue);
  }

  input.dispatchEvent(new InputEvent('beforeinput', {
    bubbles: true,
    cancelable: true,
    data: nextValue,
    inputType: 'insertText',
  }));
  input.dispatchEvent(new InputEvent('input', {
    bubbles: true,
    data: nextValue,
    inputType: 'insertText',
  }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
  input.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'Enter', code: 'Enter' }));
  input.dispatchEvent(new Event('blur', { bubbles: true }));
}

function buttonText(button) {
  return `${button.innerText || button.textContent || button.value || button.getAttribute?.('aria-label') || ''}`
    .trim()
    .toLowerCase();
}

function isThirdPartyAuthAction(button) {
  const text = buttonText(button);
  return text.includes('continue with google')
    || text.includes('continue with apple')
    || text.includes('continue with phone')
    || text.includes('continue with passkey')
    || text.includes('continue with microsoft');
}

function isDisabled(element) {
  if (!element) return true;
  return Boolean(
    element.disabled
    || element.getAttribute('aria-disabled') === 'true'
    || element.getAttribute('disabled') !== null
  );
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

function findOpenLoginDialog() {
  const dialogs = queryAllDeep(['[role="dialog"]', '[aria-modal="true"]'])
    .filter((element) => isVisible(element));

  return dialogs.find((dialog) => {
    const text = `${dialog.innerText || dialog.textContent || ''}`.toLowerCase();
    return text.includes('log in or sign up')
      || text.includes('continue with google')
      || text.includes('continue with apple')
      || text.includes('email address');
  }) || null;
}

function findOpenAIModalEmailInput() {
  const dialog = findOpenLoginDialog();
  if (!dialog) return null;

  for (const selector of CHATGPT_MODAL_INPUT_SELECTORS) {
    const inputs = queryAllDeep(selector, dialog);
    const match = inputs.find((input) => !input.disabled && !input.readOnly && isVisible(input));
    if (match) return match;
  }

  return null;
}

function findOpenAIModalContinueButton(input = null) {
  const dialog = input?.closest?.('[role="dialog"], [aria-modal="true"]') || findOpenLoginDialog();
  if (!dialog) return null;

  const candidates = queryAllDeep(ACTION_SELECTORS, dialog)
    .filter((button) => isVisible(button) && !isThirdPartyAuthAction(button));

  return candidates.find((button) => {
    const text = buttonText(button);
    return text === 'continue' || text.includes('continue');
  }) || null;
}

function collectActionCandidates(root) {
  return queryAllDeep(ACTION_SELECTORS, root || document)
    .filter((button) => !isDisabled(button) && isVisible(button) && !isThirdPartyAuthAction(button));
}

function findSubmitButton(kind, input = null) {
  const words = kind === 'password'
    ? ['continue', 'log in', 'login', 'sign in', 'submit']
    : ['continue', 'next', 'submit'];

  for (const root of findStepContainer(input)) {
    const candidates = collectActionCandidates(root);
    if (!candidates.length) continue;

    const exactContinue = candidates.find((button) => {
      const text = buttonText(button);
      return text === 'continue' || text === 'next' || text === 'log in' || text === 'sign in';
    });
    if (exactContinue) return exactContinue;

    const wordMatch = candidates.find((button) => words.some((word) => buttonText(button).includes(word)));
    if (wordMatch) return wordMatch;

    const submitMatch = candidates.find((button) => button.type === 'submit' && !isThirdPartyAuthAction(button));
    if (submitMatch) return submitMatch;
  }

  return null;
}

function findLandingLoginAction() {
  const candidates = queryAllDeep(ACTION_SELECTORS)
    .filter((element) => !isDisabled(element) && isVisible(element));

  return candidates.find((element) => {
    const text = buttonText(element);
    if (text.includes('log in') || text.includes('login') || text.includes('sign in')) {
      return true;
    }

    const href = `${element.getAttribute?.('href') || ''}`.toLowerCase();
    return href.includes('/auth/login')
      || href.includes('/auth/log-in')
      || href.includes('/login')
      || href.includes('/log-in');
  }) || null;
}

function hasOpenLoginPrompt() {
  if (findInput(EMAIL_SELECTORS) || findInput(PASSWORD_SELECTORS)) {
    return true;
  }

  const dialogs = queryAllDeep(['[role="dialog"]', '[aria-modal="true"]'])
    .filter((element) => isVisible(element));

  return dialogs.some((dialog) => {
    const text = `${dialog.innerText || dialog.textContent || ''}`.toLowerCase();
    return text.includes('log in')
      || text.includes('login')
      || text.includes('sign up')
      || text.includes('email address');
  });
}

function isEmailVerificationRoute() {
  const path = `${window.location.pathname || ''}`.toLowerCase();
  const bodyText = `${document.body?.innerText || ''}`.toLowerCase();
  return path.includes('email-verification')
    || bodyText.includes('route error (405 method not allowed)')
    || bodyText.includes('did not provide an `action` for route "email_verification"')
    || bodyText.includes('did not provide an action for route "email_verification"');
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
    },
    (response) => {
      STATE.requested = false;

      if (chrome.runtime.lastError) {
        setStatus(`Extension error: ${chrome.runtime.lastError.message}`);
        STATE.settled = true;
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
  const input = findOpenAIModalEmailInput() || findInput(EMAIL_SELECTORS);

  if (!input) return false;
  if (STATE.passwordStepPending || findInput(PASSWORD_SELECTORS)) {
    STATE.emailStepPending = false;
  }
  if (input.value !== credential.loginIdentifier) {
    setInputValue(input, credential.loginIdentifier);
    if (input.value !== credential.loginIdentifier) {
      setStatus('Retrying email fill');
      scheduleAttempt(250);
      return true;
    }
  }

  if (STATE.emailStepPending) {
    setStatus('Email filled, waiting for password step');
    return true;
  }

  const now = Date.now();
  if (input.value && now - STATE.lastEmailSubmitAt > 2500) {
    const submitButton = findOpenAIModalContinueButton(input) || findSubmitButton('email', input);
    if (!submitButton) {
      setStatus('Email filled, submit button not found');
      return true;
    }
    if (isDisabled(submitButton)) {
      setStatus('Email filled, waiting for Continue button');
      scheduleAttempt(250);
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
    setInputValue(input, credential.password);
    if (input.value !== credential.password) {
      setStatus('Retrying password fill');
      scheduleAttempt(250);
      return true;
    }
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

function attemptLandingLogin() {
  if (hasOpenLoginPrompt()) return false;
  if (STATE.landingLoginAttempts >= 2) return false;

  const action = findLandingLoginAction();
  if (!action) return false;

  const now = Date.now();
  if (now - STATE.lastLandingLoginClickAt > 3500) {
    STATE.lastLandingLoginClickAt = now;
    STATE.landingLoginAttempts += 1;
    setStatus('Opening login prompt');
    window.setTimeout(() => action.click(), 250);
  }
  return true;
}

function attemptFill() {
  if (STATE.settled) return;

  if (isEmailVerificationRoute()) {
    STATE.emailStepPending = true;
    setStatus('Waiting for OpenAI email step');
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

  if (attemptPasswordStep(credential)) return;
  if (attemptEmailStep(credential)) return;
  attemptLandingLogin();
  setStatus('Waiting for matching ChatGPT field');
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
  if (now - STATE.lastMutationHandledAt < 1200) {
    return;
  }

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
