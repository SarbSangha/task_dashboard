const TOOL_SLUG = 'chatgpt';
const TOOL_HOSTNAME = 'chatgpt.com';
const LOGIN_FLOW_STORAGE_KEY = 'rmw_chatgpt_login_flow_hints_v1';
const LOGIN_FLOW_HINT_TTL_MS = 45 * 24 * 60 * 60 * 1000;
const STATE = {
  credential: null,
  requested: false,
  requestAttempts: 0,
  lastRequestAt: 0,
  lastEmailSubmitAt: 0,
  lastPasswordSubmitAt: 0,
  lastAuxClickAt: 0,
  emailSubmitted: false,
  passwordSubmitted: false,
  auxSubmitted: false,
  scheduledTimer: null,
  keepAliveTimer: null,
  observer: null,
  lastRunAt: 0,
  lastMutationHandledAt: 0,
  launchChecked: false,
  launchAuthorized: false,
  passwordSavingInFlight: false,
  passwordSavingSuppressed: false,
  passwordSavingRestoreTimer: null,
  settled: false,
  status: 'Waiting for Microsoft sign-in',
};

const MIN_RUN_GAP_MS = 900;
const KEEP_ALIVE_MS = 3500;
const PASSWORD_PROMPT_RESTORE_DELAY_MS = 8000;
const EMAIL_SELECTORS = [
  '#i0116',
  'input[type="email"]',
  'input[name="loginfmt"]',
  'input[name="login"]',
  'input[autocomplete="username"]',
  'input[aria-label*="email" i]',
];
const PASSWORD_SELECTORS = [
  '#i0118',
  'input[type="password"]',
  'input[name="passwd"]',
  'input[autocomplete="current-password"]',
];
const ACTION_SELECTORS = [
  '#idSIButton9',
  '#idBtn_Back',
  'input[type="submit"]',
  'button[type="submit"]',
  'button',
  '[role="button"]',
  'a',
];

function getCredentialFlowKey(credential) {
  const identifier = `${credential?.loginIdentifier || ''}`.trim().toLowerCase();
  const domain = identifier.includes('@') ? identifier.split('@').pop() : identifier;
  return domain ? `${TOOL_SLUG}:${domain}` : `${TOOL_SLUG}:default`;
}

function rememberMicrosoftFlow(credential, evidence = 'microsoft_login_page') {
  const key = getCredentialFlowKey(credential);
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
        flow: 'microsoft_oauth',
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
    badge.textContent = `Microsoft auto-login\n${message}`;
  }
  console.debug('[RMW Microsoft Auto Login]', message);
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
  setStatus('Disabling Chrome password-save prompt...');

  ensurePasswordSavingSuppressed()
    .then((ok) => {
      STATE.passwordSavingInFlight = false;
      if (!ok) {
        STATE.settled = true;
        setStatus('Blocked: Chrome password-save prompt could not be disabled.');
        return;
      }
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

function actionText(action) {
  return `${action.innerText || action.textContent || action.value || action.getAttribute?.('aria-label') || ''}`
    .trim()
    .toLowerCase();
}

function actionCandidates() {
  return Array.from(document.querySelectorAll(ACTION_SELECTORS.join(',')))
    .filter((action) => !isDisabled(action) && isVisible(action));
}

function findActionByWords(words) {
  const normalized = words.map((word) => word.toLowerCase());
  return actionCandidates().find((action) => {
    const text = actionText(action);
    return normalized.some((word) => text === word || text.includes(word));
  }) || null;
}

function findNextButton(kind) {
  const primary = document.querySelector('#idSIButton9');
  if (primary && !isDisabled(primary) && isVisible(primary)) return primary;

  if (kind === 'email') {
    return findActionByWords(['next', 'continue']);
  }

  return findActionByWords(['sign in', 'next', 'continue']);
}

function findUseAnotherAccountAction() {
  return findActionByWords(['use another account', 'sign in with another account']);
}

function findStaySignedInNoAction() {
  const back = document.querySelector('#idBtn_Back');
  if (back && !isDisabled(back) && isVisible(back)) return back;
  return findActionByWords(['no']);
}

function hasStaySignedInPrompt() {
  const bodyText = `${document.body?.innerText || ''}`.toLowerCase();
  return bodyText.includes('stay signed in') || bodyText.includes('keep me signed in');
}

async function loadLaunchState() {
  const response = await sendRuntimeMessage({
    type: 'TOOL_HUB_GET_LAUNCH_STATE',
    toolSlug: TOOL_SLUG,
    hostname: TOOL_HOSTNAME,
    pageUrl: window.location.href,
  });

  STATE.launchChecked = true;
  STATE.launchAuthorized = Boolean(response?.ok && response.authorized);
}

function enforceDashboardOnlyAccess() {
  setStatus('Launch this tool from the dashboard first');
  STATE.settled = true;
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
      rememberMicrosoftFlow(STATE.credential);
      setStatus(STATE.credential ? 'Credential loaded' : 'Credential missing');
      scheduleAttempt(150);
    }
  );
}

function attemptUseAnotherAccount() {
  if (findInput(EMAIL_SELECTORS) || findInput(PASSWORD_SELECTORS)) return false;
  if (STATE.auxSubmitted) return true;

  const action = findUseAnotherAccountAction();
  if (!action) return false;

  const now = Date.now();
  if (now - STATE.lastAuxClickAt > 2500) {
    STATE.lastAuxClickAt = now;
    STATE.auxSubmitted = true;
    setStatus('Opening Microsoft email step');
    window.setTimeout(() => action.click(), 250);
  }
  return true;
}

function attemptStaySignedInStep() {
  if (!hasStaySignedInPrompt()) return false;

  const action = findStaySignedInNoAction();
  if (!action) {
    setStatus('Waiting at Microsoft stay-signed-in prompt');
    return true;
  }

  const now = Date.now();
  if (now - STATE.lastAuxClickAt > 2500) {
    STATE.lastAuxClickAt = now;
    setStatus('Finishing Microsoft sign-in');
    window.setTimeout(() => action.click(), 250);
  }
  return true;
}

function attemptEmailStep(credential) {
  const input = findInput(EMAIL_SELECTORS);
  if (!input) return false;

  if (input.value !== credential.loginIdentifier) {
    input.focus();
    setInputValue(input, credential.loginIdentifier);
  }

  if (STATE.emailSubmitted) {
    setStatus('Email filled, waiting for Microsoft password page');
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
    STATE.auxSubmitted = false;
    setStatus('Email filled, moving to Microsoft password');
    window.setTimeout(() => nextButton.click(), 300);
  }
  return true;
}

function attemptPasswordStep(credential) {
  const input = findInput(PASSWORD_SELECTORS);
  if (!input) return false;

  if (!STATE.passwordSavingSuppressed) {
    requestPasswordSavingSuppression();
    return true;
  }

  STATE.emailSubmitted = false;
  if (input.value !== credential.password) {
    input.focus();
    setInputValue(input, credential.password);
  }

  if (STATE.passwordSubmitted) {
    setStatus('Password filled, waiting for Microsoft sign-in');
    return true;
  }

  const nextButton = findNextButton('password');
  if (!nextButton) {
    setStatus('Password filled, Sign in button not found');
    return true;
  }

  const now = Date.now();
  if (input.value && now - STATE.lastPasswordSubmitAt > 2500) {
    STATE.lastPasswordSubmitAt = now;
    STATE.passwordSubmitted = true;
    setStatus('Password filled, signing in to Microsoft');
    window.setTimeout(() => {
      nextButton.click();
      releasePasswordSavingSuppressed(PASSWORD_PROMPT_RESTORE_DELAY_MS);
    }, 300);
  }
  return true;
}

function attemptFill() {
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
    if (findInput(EMAIL_SELECTORS) || findInput(PASSWORD_SELECTORS) || findUseAnotherAccountAction()) {
      requestCredential();
    }
    return;
  }

  if (attemptStaySignedInStep()) return;
  if (attemptPasswordStep(credential)) return;
  if (attemptEmailStep(credential)) return;
  if (attemptUseAnotherAccount()) return;

  setStatus('Waiting for Microsoft sign-in fields');
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
  STATE.observer = new MutationObserver(() => handleMutations());
  STATE.observer.observe(document.body || document.documentElement, { childList: true, subtree: true });
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
