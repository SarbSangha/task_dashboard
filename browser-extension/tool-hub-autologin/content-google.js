(() => {
const LOGIN_FLOW_STORAGE_KEY = 'rmw_chatgpt_login_flow_hints_v1';
const LOGIN_FLOW_HINT_TTL_MS = 45 * 24 * 60 * 60 * 1000;
const FLOW_EXTENSION_TICKET_STORAGE_KEY = 'rmw_flow_google_extension_ticket';
const LAST_GOOGLE_TOOL_SLUG_STORAGE_KEY = 'rmw_google_extension_ticket_last_tool_slug';
const STATE = {
  credential: null,
  requested: false,
  requestAttempts: 0,
  lastRequestAt: 0,
  lastEmailFilledAt: 0,
  lastEmailSubmitAt: 0,
  lastPasswordFilledAt: 0,
  lastPasswordSubmitAt: 0,
  lastConsentSubmitAt: 0,
  lastTotpFilledAt: 0,
  lastTotpSubmitAt: 0,
  lastBackupCodeFilledAt: 0,
  lastBackupCodeSubmitAt: 0,
  emailSubmitted: false,
  passwordSubmitted: false,
  totpSubmitted: false,
  backupCodeSubmitted: false,
  backupCodeIndex: 0,
  scheduledTimer: null,
  keepAliveTimer: null,
  observer: null,
  lastRunAt: 0,
  runInFlight: false,
  lastMutationHandledAt: 0,
  launchChecked: false,
  launchAuthorized: false,
  launchRetryAttempts: 0,
  lastLaunchRetryAt: 0,
  toolSlug: '',
  passwordSavingInFlight: false,
  passwordSavingSuppressed: false,
  passwordSavingBypass: false,
  passwordSavingRestoreTimer: null,
  totpValue: '',
  totpFetching: false,
  totpRequestAttempts: 0,
  totpLastRequestAt: 0,
  totpFetchedAt: 0,
  totpExpiresInSec: 0,
  totpUnavailable: false,
  authTransitionMarkedAt: 0,
  embeddedButtonClickedAt: 0,
  developerInfoDismissedAt: 0,
  googleAddAccountPendingAt: 0,
  passwordTypeObserver: null,
  passwordTypeTarget: null,
  settled: false,
  status: 'Waiting for Google sign-in',
};

const MIN_RUN_GAP_MS = 900;
const KEEP_ALIVE_MS = 3500;
const STEP_PENDING_RETRY_MS = 5000;
const INPUT_SETTLE_MS = 300;
const GOOGLE_PASSWORD_SETTLE_MS = 260;
const NEXT_BUTTON_WAIT_MS = 2500;
const NEXT_BUTTON_POLL_MS = 120;
const PASSWORD_PROMPT_RESTORE_DELAY_MS = 8000;
const PASSWORD_REVEAL_ACTION_HINTS = ['show', 'hide', 'view', 'reveal', 'toggle'];
const PASSWORD_REVEAL_SUBJECT_HINTS = ['password', 'passcode'];
const PASSWORD_REVEAL_ICON_HINTS = ['eye', 'visibility', 'visible'];
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
const BACKUP_CODE_INPUT_SELECTORS = [
  'input[autocomplete="one-time-code"]',
  'input[inputmode="numeric"]',
  'input[type="tel"]',
  'input[type="number"]',
  'input[name*="code" i]',
  'input[id*="code" i]',
  'input[aria-label*="code" i]',
  'input[placeholder*="code" i]',
  'input[type="text"]',
];
const NEXT_SELECTORS = [
  '#identifierNext button',
  '#passwordNext button',
  'button[jsname]',
  'button',
  '[role="button"]',
];
const ACTION_SELECTORS = [
  'button',
  '[role="button"]',
  'a[href]',
  'div[tabindex]',
  'li[tabindex]',
].join(',');

function normalizeToolSlug(value) {
  const normalized = `${value || ''}`.trim().toLowerCase();
  if (normalized === 'chat-gpt') return 'chatgpt';
  if (['enhencor', 'enhencer', 'enhancer'].includes(normalized)) return 'enhancor';
  return normalized;
}

function normalizeText(value) {
  return `${value || ''}`.replace(/\s+/g, ' ').trim().toLowerCase();
}

function isEmbeddedGoogleButtonFrame() {
  try {
    if (window.top === window.self) {
      return false;
    }
  } catch {
    return false;
  }

  try {
    const url = new URL(window.location.href);
    const host = normalizeText(url.hostname);
    const path = normalizeText(url.pathname);
    const text = normalizeText(document.body?.innerText || '');
    if (!host.includes('accounts.google.com')) {
      return false;
    }
    return path.includes('/gsi/')
      || text.includes('continue with google')
      || text.includes('sign in with google');
  } catch {
    return false;
  }
}

function shouldRunOnCurrentPage() {
  if (isEmbeddedGoogleButtonFrame()) {
    return true;
  }

  try {
    if (window.top !== window.self) {
      return false;
    }
  } catch {
    return false;
  }

  try {
    const url = new URL(window.location.href);
    const host = normalizeText(url.hostname);
    const path = normalizeText(url.pathname);
    if (!host.includes('accounts.google.com')) {
      return false;
    }
    if (
      path.includes('/signin/')
      || path.includes('/v3/signin/')
      || path.includes('/o/oauth2/')
      || path.includes('/interactivelogin/')
    ) {
      return true;
    }
  } catch {
    return false;
  }

  return isGoogleAccountChooserPage() || Boolean(findGoogleEmailInput()) || Boolean(findGooglePasswordInput());
}

function isKlingGoogleFlow(toolSlug = STATE.toolSlug) {
  const normalizedToolSlug = normalizeToolSlug(toolSlug || inferToolSlugFromGooglePage());
  return normalizedToolSlug === 'kling' || normalizedToolSlug === 'kling-ai' || normalizedToolSlug === 'klingai';
}

function shouldProtectGooglePasswordReveal(toolSlug = STATE.toolSlug) {
  const normalizedToolSlug = normalizeToolSlug(toolSlug || inferToolSlugFromGooglePage());
  return normalizedToolSlug === 'enhancor'
    || normalizedToolSlug === 'freepik'
    || normalizedToolSlug === 'kling'
    || normalizedToolSlug === 'kling-ai'
    || normalizedToolSlug === 'klingai';
}

function isFlowTool() {
  return normalizeToolSlug(STATE.toolSlug) === 'flow';
}

function supportsGoogleAuthenticatorAutomation(toolSlug = STATE.toolSlug) {
  const normalizedToolSlug = normalizeToolSlug(toolSlug || inferToolSlugFromGooglePage());
  return normalizedToolSlug === 'flow'
    || normalizedToolSlug === 'chatgpt'
    || normalizedToolSlug === 'enhancor'
    || normalizedToolSlug === 'freepik'
    || normalizedToolSlug === 'genspark'
    || normalizedToolSlug === 'kling'
    || normalizedToolSlug === 'kling-ai'
    || normalizedToolSlug === 'klingai';
}

function getToolDisplayName(toolSlug = STATE.toolSlug) {
  const normalizedToolSlug = normalizeToolSlug(toolSlug || inferToolSlugFromGooglePage());
  if (normalizedToolSlug === 'flow') return 'Flow';
  if (normalizedToolSlug === 'chatgpt') return 'ChatGPT';
  if (normalizedToolSlug === 'enhancor') return 'Enhancor';
  if (normalizedToolSlug === 'freepik') return 'Freepik';
  if (normalizedToolSlug === 'genspark') return 'Genspark';
  if (normalizedToolSlug === 'kling' || normalizedToolSlug === 'kling-ai' || normalizedToolSlug === 'klingai') return 'Kling';
  return 'Google';
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
  if (isEmbeddedGoogleButtonFrame()) {
    return null;
  }
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

function findEmbeddedGoogleButtonAction() {
  return findVisibleActionByText([
    'continue with google',
    'sign in with google',
    'continue using google',
  ]);
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
  if (STATE.passwordSavingSuppressed || STATE.passwordSavingBypass) return true;

  const response = await sendRuntimeMessage({
    type: 'TOOL_HUB_SET_PASSWORD_SAVING_SUPPRESSED',
    suppressed: true,
  });

  if (!response?.ok) {
    STATE.passwordSavingBypass = true;
    setStatus(`Warning: ${response?.error || 'Could not suppress Chrome password prompt'} Continuing anyway...`);
    return false;
  }

  STATE.passwordSavingSuppressed = true;
  STATE.passwordSavingBypass = false;
  return true;
}

function requestPasswordSavingSuppression() {
  if (STATE.passwordSavingSuppressed || STATE.passwordSavingBypass || STATE.passwordSavingInFlight) {
    return;
  }

  STATE.passwordSavingInFlight = true;
  setStatus('Disabling Chrome password-save prompt...');

  ensurePasswordSavingSuppressed()
    .then((ok) => {
      STATE.passwordSavingInFlight = false;
      if (!ok) {
        scheduleAttempt(50);
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

  if (STATE.passwordSavingBypass) {
    STATE.passwordSavingBypass = false;
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

function isChooserLikeAction(element) {
  if (!element) return false;
  return Boolean(
    element.hasAttribute?.('data-view-id')
    || element.hasAttribute?.('data-identifier')
    || element.hasAttribute?.('data-email')
    || element.tabIndex >= 0
    || typeof element.onclick === 'function'
    || window.getComputedStyle(element).cursor === 'pointer'
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

async function typeInputValueLikeUser(input, value, { perCharDelayMs = 16 } = {}) {
  if (!input) return;
  const nextValue = `${value || ''}`;
  const setter = getValueSetter(input);

  try {
    input.focus({ preventScroll: true });
  } catch {
    input.focus?.();
  }

  if (setter) setter.call(input, '');
  else input.value = '';
  input.setAttribute('value', '');
  if (input._valueTracker?.setValue) {
    input._valueTracker.setValue(`${input.value || ''}`);
  }
  input.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));

  let currentValue = '';
  for (const char of nextValue) {
    try {
      input.dispatchEvent(new KeyboardEvent('keydown', {
        key: char,
        code: char.length === 1 ? `Key${char.toUpperCase()}` : '',
        bubbles: true,
        cancelable: true,
      }));
    } catch {}

    try {
      input.dispatchEvent(new InputEvent('beforeinput', {
        bubbles: true,
        cancelable: true,
        data: char,
        inputType: 'insertText',
      }));
    } catch {}

    currentValue += char;
    if (setter) setter.call(input, currentValue);
    else input.value = currentValue;
    input.setAttribute('value', currentValue);
    if (input._valueTracker?.setValue) {
      input._valueTracker.setValue(currentValue.slice(0, -1));
    }

    try {
      input.dispatchEvent(new InputEvent('input', {
        bubbles: true,
        cancelable: true,
        data: char,
        inputType: 'insertText',
      }));
    } catch {
      input.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
    }

    try {
      input.dispatchEvent(new KeyboardEvent('keyup', {
        key: char,
        code: char.length === 1 ? `Key${char.toUpperCase()}` : '',
        bubbles: true,
        cancelable: true,
      }));
    } catch {}

    if (perCharDelayMs > 0) {
      await sleep(perCharDelayMs);
    }
  }

  input.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
}

function sleep(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, Math.max(0, ms)));
}

function getGoogleExtensionTicketStorageKey(toolSlug = STATE.toolSlug) {
  const normalizedToolSlug = normalizeToolSlug(
    toolSlug
    || inferToolSlugFromGooglePage()
    || readStoredGoogleLastToolSlug()
  );
  if (normalizedToolSlug === 'flow') {
    return FLOW_EXTENSION_TICKET_STORAGE_KEY;
  }
  return `rmw_google_extension_ticket_${normalizedToolSlug || 'default'}`;
}

function readStoredGoogleLastToolSlug() {
  try {
    const sessionToolSlug = normalizeToolSlug(window.sessionStorage.getItem(LAST_GOOGLE_TOOL_SLUG_STORAGE_KEY));
    if (sessionToolSlug) return sessionToolSlug;

    const localToolSlug = normalizeToolSlug(window.localStorage.getItem(LAST_GOOGLE_TOOL_SLUG_STORAGE_KEY));
    if (localToolSlug) {
      try { window.sessionStorage.setItem(LAST_GOOGLE_TOOL_SLUG_STORAGE_KEY, localToolSlug); } catch {}
      return localToolSlug;
    }
  } catch {}

  return '';
}

function listKnownGoogleToolSlugs() {
  return ['flow', 'chatgpt', 'enhancor', 'freepik', 'genspark', 'kling-ai'];
}

function inferStoredGoogleToolSlug() {
  const rememberedToolSlug = readStoredGoogleLastToolSlug();
  if (rememberedToolSlug && readStoredGoogleExtensionTicket(rememberedToolSlug)) {
    return rememberedToolSlug;
  }

  const matchingToolSlugs = listKnownGoogleToolSlugs()
    .filter((toolSlug) => Boolean(readStoredGoogleExtensionTicket(toolSlug)));

  return matchingToolSlugs.length === 1 ? matchingToolSlugs[0] : '';
}

function readStoredGoogleExtensionTicket(toolSlug = STATE.toolSlug) {
  try {
    const storageKey = getGoogleExtensionTicketStorageKey(toolSlug);
    const sessionTicket = `${window.sessionStorage.getItem(storageKey) || ''}`.trim();
    if (sessionTicket) return sessionTicket;

    const localTicket = `${window.localStorage.getItem(storageKey) || ''}`.trim();
    if (localTicket) {
      try { window.sessionStorage.setItem(storageKey, localTicket); } catch {}
      return localTicket;
    }
    return '';
  } catch {
    return '';
  }
}

function storeGoogleExtensionTicket(ticket, toolSlug = STATE.toolSlug) {
  try {
    const normalizedToolSlug = normalizeToolSlug(toolSlug || inferToolSlugFromGooglePage());
    const storageKey = getGoogleExtensionTicketStorageKey(normalizedToolSlug);
    if (ticket) {
      window.sessionStorage.setItem(storageKey, ticket);
      window.localStorage.setItem(storageKey, ticket);
      if (normalizedToolSlug) {
        window.sessionStorage.setItem(LAST_GOOGLE_TOOL_SLUG_STORAGE_KEY, normalizedToolSlug);
        window.localStorage.setItem(LAST_GOOGLE_TOOL_SLUG_STORAGE_KEY, normalizedToolSlug);
      }
    } else {
      window.sessionStorage.removeItem(storageKey);
      window.localStorage.removeItem(storageKey);
    }
  } catch {}
}

function extractExtensionTicketFromValue(value) {
  const raw = `${value || ''}`.trim();
  if (!raw) return '';

  try {
    const url = new URL(raw, window.location.href);
    const queryTicket = `${url.searchParams.get('rmw_extension_ticket') || ''}`.trim();
    if (queryTicket) return queryTicket;

    const hash = `${url.hash || ''}`.replace(/^#/, '');
    return `${new URLSearchParams(hash).get('rmw_extension_ticket') || ''}`.trim();
  } catch {
    return '';
  }
}

function captureGoogleExtensionTicket(toolSlug = STATE.toolSlug) {
  try {
    const url = new URL(window.location.href);
    const directTicket = `${url.searchParams.get('rmw_extension_ticket') || ''}`.trim()
      || `${new URLSearchParams((url.hash || '').replace(/^#/, '')).get('rmw_extension_ticket') || ''}`.trim();
    if (directTicket) {
      storeGoogleExtensionTicket(directTicket, toolSlug);
      return directTicket;
    }

    const nestedValues = [
      url.searchParams.get('continue'),
      url.searchParams.get('redirect_uri'),
      url.searchParams.get('app_domain'),
      document.referrer,
    ];
    for (const value of nestedValues) {
      const nestedTicket = extractExtensionTicketFromValue(value);
      if (nestedTicket) {
        storeGoogleExtensionTicket(nestedTicket, toolSlug);
        return nestedTicket;
      }
    }
  } catch {}

  return readStoredGoogleExtensionTicket(toolSlug);
}

function captureFlowExtensionTicket() {
  return captureGoogleExtensionTicket('flow');
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

    if (values.some((value) => (
      value.includes('chatgpt.com')
      || value.includes('chat.openai.com')
      || value.includes('auth.openai.com')
      || value.includes('openai.com')
    ))) {
      return 'chatgpt';
    }

    if (values.some((value) => (
      value.includes('enhancor.ai')
      || value.includes('app.enhancor.ai')
    ))) {
      return 'enhancor';
    }

    if (values.some((value) => (
      value.includes('kling.ai')
      || value.includes('klingai.com')
      || value.includes('app.klingai.com')
    ))) {
      return 'kling-ai';
    }

    if (values.some((value) => (
      value.includes('freepik.com')
      || value.includes('magnific.com')
      || value.includes('www.freepik.com')
      || value.includes('www.magnific.com')
    ))) {
      return 'freepik';
    }

    if (values.some((value) => (
      value.includes('genspark.ai')
      || value.includes('login.genspark.ai')
    ))) {
      return 'genspark';
    }
  } catch {}

  const currentPageText = pageText();
  if (
    currentPageText.includes('continue to openai')
    || currentPageText.includes('continue to chatgpt')
    || currentPageText.includes('to continue to openai')
  ) {
    return 'chatgpt';
  }

  if (
    currentPageText.includes('continue to enhancor.ai')
    || currentPageText.includes('continue to enhancor')
    || currentPageText.includes('to continue to enhancor.ai')
    || currentPageText.includes('to continue to enhancor')
  ) {
    return 'enhancor';
  }

  if (
    currentPageText.includes('continue to kling.ai')
    || currentPageText.includes('continue to kling ai')
    || currentPageText.includes('to continue to kling.ai')
    || currentPageText.includes('to continue to kling ai')
    || currentPageText.includes('to continue to kling')
  ) {
    return 'kling-ai';
  }

  if (
    currentPageText.includes('continue to magnific.com')
    || currentPageText.includes('continue to magnific')
    || currentPageText.includes('continue to freepik.com')
    || currentPageText.includes('continue to freepik')
    || currentPageText.includes('to continue to magnific.com')
    || currentPageText.includes('to continue to magnific')
    || currentPageText.includes('to continue to freepik.com')
    || currentPageText.includes('to continue to freepik')
  ) {
    return 'freepik';
  }

  if (
    currentPageText.includes('continue to genspark.ai')
    || currentPageText.includes('continue to genspark')
    || currentPageText.includes('to continue to genspark.ai')
    || currentPageText.includes('to continue to genspark')
  ) {
    return 'genspark';
  }

  return inferStoredGoogleToolSlug();
}

function supportsPasswordOptionalGoogleCredential(toolSlug = STATE.toolSlug) {
  const normalizedToolSlug = normalizeToolSlug(toolSlug || inferToolSlugFromGooglePage());
  return normalizedToolSlug === 'enhancor'
    || normalizedToolSlug === 'genspark'
    || normalizedToolSlug === 'kling'
    || normalizedToolSlug === 'kling-ai'
    || normalizedToolSlug === 'klingai';
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

function getGoogleAddAccountDirectUrl() {
  try {
    const url = new URL(window.location.href);
    if (!url.hostname.includes('accounts.google.com')) {
      return '';
    }

    if (url.pathname.includes('/accountchooser')) {
      url.pathname = url.pathname.replace('/accountchooser', '/identifier');
      return url.toString();
    }

    if (url.pathname.includes('/AccountChooser')) {
      url.pathname = url.pathname.replace('/AccountChooser', '/identifier');
      return url.toString();
    }
  } catch {}

  return '';
}

function getContinuationRequestContext(toolSlug = STATE.toolSlug) {
  const normalizedToolSlug = normalizeToolSlug(toolSlug || inferToolSlugFromGooglePage());
  if (normalizedToolSlug === 'chatgpt') {
    return {
      hostname: 'chatgpt.com',
      pageUrl: 'https://chatgpt.com/',
    };
  }

  try {
    const url = new URL(window.location.href);
    if (url.hostname.includes('accounts.google.com') && normalizedToolSlug) {
      return {
        hostname: 'accounts.google.com',
        pageUrl: 'https://accounts.google.com/',
      };
    }
  } catch {}

  return {
    hostname: window.location.hostname,
    pageUrl: window.location.href,
  };
}

function buttonText(button) {
  return `${button.innerText || button.textContent || button.value || button.getAttribute?.('aria-label') || ''}`
    .trim()
    .toLowerCase();
}

function actionText(element) {
  return normalizeText([
    element?.innerText,
    element?.textContent,
    element?.value,
    element?.getAttribute?.('aria-label'),
    element?.getAttribute?.('title'),
  ].filter(Boolean).join(' '));
}

function disablePasswordRevealControl(element) {
  if (!element || element.dataset?.rmwGooglePasswordRevealDisabled === 'true') return;
  element.dataset.rmwGooglePasswordRevealDisabled = 'true';
  element.setAttribute('aria-disabled', 'true');
  element.setAttribute('tabindex', '-1');
  if (element.matches?.('input[type="checkbox"], input[type="radio"]')) {
    try { element.checked = false; } catch {}
    try { element.defaultChecked = false; } catch {}
    try { element.setAttribute('aria-checked', 'false'); } catch {}
  }
  if ('disabled' in element) {
    try { element.disabled = true; } catch {}
  }
  ['click', 'mousedown', 'mouseup', 'pointerdown', 'pointerup', 'touchstart', 'touchend', 'keydown', 'keyup', 'change', 'input']
    .forEach((eventName) => element.addEventListener(eventName, blockRevealControlEvent, true));
  element.style.setProperty('pointer-events', 'none', 'important');
  element.style.setProperty('cursor', 'not-allowed', 'important');
  element.style.setProperty('opacity', '0.6', 'important');
}

function blockRevealControlEvent(event) {
  event.preventDefault();
  event.stopPropagation();
  event.stopImmediatePropagation();
}

function keepProtectedGoogleRevealControlsUnchecked(passInput) {
  findExplicitGoogleShowPasswordControls(passInput).forEach((control) => {
    if (control.matches?.('input[type="checkbox"], input[type="radio"]')) {
      try { control.checked = false; } catch {}
      try { control.defaultChecked = false; } catch {}
      try { control.setAttribute('aria-checked', 'false'); } catch {}
    }
    if (control.getAttribute?.('role') === 'checkbox') {
      try { control.setAttribute('aria-checked', 'false'); } catch {}
    }
  });
}

function scheduleProtectedGooglePasswordRemask(passInput) {
  if (!passInput) return;
  [0, 40, 120, 260].forEach((delayMs) => {
    window.setTimeout(() => {
      const activePasswordInput = passInput.isConnected ? passInput : findGooglePasswordInput();
      if (!activePasswordInput) return;
      enforceProtectedGooglePasswordMask(activePasswordInput);
      disableExactGoogleShowPasswordTargets(activePasswordInput);
    }, delayMs);
  });
}

function findExactGoogleShowPasswordCheckbox(passInput) {
  if (!passInput) return null;

  const scopes = [];
  let current = passInput.parentElement;
  let depth = 0;
  while (current && current !== document.body && depth < 4) {
    scopes.push(current);
    current = current.parentElement;
    depth += 1;
  }
  scopes.push(document);

  for (const scope of scopes) {
    const checkbox = Array.from(scope.querySelectorAll('input[type="checkbox"][jsname="YPqjbf"]'))
      .find((element) => isVisible(element) && isNearPasswordInput(passInput, element));
    if (checkbox) {
      return checkbox;
    }
  }
  return null;
}

function findExactGoogleShowPasswordTargets(passInput) {
  if (!passInput) return null;

  const exactCheckbox = findExactGoogleShowPasswordCheckbox(passInput);
  if (!exactCheckbox) return [];

  const targets = [exactCheckbox];
  const ariaLabelledBy = `${exactCheckbox.getAttribute('aria-labelledby') || ''}`.trim();
  if (ariaLabelledBy) {
    ariaLabelledBy.split(/\s+/).filter(Boolean).forEach((id) => {
      const labelNode = document.getElementById(id);
      if (labelNode) {
        targets.push(labelNode);
        const clickableLabelWrapper = labelNode.closest('div[jsname="ornU0b"], div[jsaction*="click"], [data-is-touch-wrapper="true"], label, div, span');
        if (clickableLabelWrapper) {
          targets.push(clickableLabelWrapper);
        }
      }
    });
  }

  [
    exactCheckbox.closest('div[jsname="ornU0b"]'),
    exactCheckbox.closest('div[jsaction*="click"]'),
    exactCheckbox.closest('[data-is-touch-wrapper="true"]'),
    exactCheckbox.parentElement,
  ].forEach((element) => {
    if (element) {
      targets.push(element);
    }
  });

  return Array.from(new Set(targets)).filter((element) => (
    element
    && element.nodeType === Node.ELEMENT_NODE
    && isVisible(element)
    && isNearPasswordInput(passInput, element)
  ));
}

function neutralizeGoogleRevealActionElement(element) {
  if (!element) return;
  try { element.onclick = null; } catch {}
  try { element.onmousedown = null; } catch {}
  try { element.onmouseup = null; } catch {}
  if (element.hasAttribute?.('jsaction')) {
    try {
      if (!element.dataset.rmwOriginalJsaction) {
        element.dataset.rmwOriginalJsaction = element.getAttribute('jsaction') || '';
      }
      element.removeAttribute('jsaction');
    } catch {}
  }
}

function findGoogleShowPasswordRow(passInput) {
  const targets = findExactGoogleShowPasswordTargets(passInput);
  if (!targets.length) return null;

  const preferred = [
    targets.find((element) => element.matches?.('[data-is-touch-wrapper="true"]')),
    targets.find((element) => element.matches?.('div[jsname="ornU0b"]')),
    targets.find((element) => element.matches?.('div[jsaction*="click"]')),
    targets.find((element) => normalizeText(element.textContent || '') === 'show password'),
    targets.find((element) => element !== targets[0]),
  ].find(Boolean);

  return preferred || targets[0] || null;
}

function disableExactGoogleShowPasswordTargets(passInput) {
  findExactGoogleShowPasswordTargets(passInput).forEach((target) => {
    neutralizeGoogleRevealActionElement(target);
    disablePasswordRevealControl(target);
  });
}

function ensureProtectedGoogleRevealShield(passInput) {
  const existing = document.getElementById('rmw-google-show-password-shield');
  const target = findGoogleShowPasswordRow(passInput);
  if (!target) {
    existing?.remove();
    return;
  }

  const rect = target.getBoundingClientRect();
  if (!rect.width || !rect.height) {
    existing?.remove();
    return;
  }

  const shield = existing || document.createElement('div');
  shield.id = 'rmw-google-show-password-shield';
  shield.setAttribute('aria-hidden', 'true');
  shield.style.position = 'fixed';
  shield.style.left = `${Math.max(0, rect.left - 2)}px`;
  shield.style.top = `${Math.max(0, rect.top - 2)}px`;
  shield.style.width = `${rect.width + 4}px`;
  shield.style.height = `${rect.height + 4}px`;
  shield.style.zIndex = '2147483646';
  shield.style.background = 'transparent';
  shield.style.pointerEvents = 'auto';
  shield.style.cursor = 'not-allowed';
  ['click', 'mousedown', 'mouseup', 'pointerdown', 'pointerup', 'touchstart', 'touchend']
    .forEach((eventName) => shield.addEventListener(eventName, blockRevealControlEvent, true));
  if (!existing) {
    (document.body || document.documentElement).appendChild(shield);
  }
}

function ensureProtectedGooglePasswordTypeObserver(passInput) {
  if (!passInput) return;
  if (STATE.passwordTypeTarget === passInput && STATE.passwordTypeObserver) {
    enforceProtectedGooglePasswordMask(passInput);
    return;
  }

  if (STATE.passwordTypeObserver) {
    try { STATE.passwordTypeObserver.disconnect(); } catch {}
  }

  STATE.passwordTypeTarget = passInput;
  const observer = new MutationObserver(() => {
    const activePasswordInput = passInput.isConnected ? passInput : findGooglePasswordInput();
    if (!activePasswordInput) return;
    enforceProtectedGooglePasswordMask(activePasswordInput);
    ensureProtectedGoogleRevealShield(activePasswordInput);
    disableExactGoogleShowPasswordTargets(activePasswordInput);
  });
  observer.observe(passInput, {
    attributes: true,
    attributeFilter: ['type', 'checked', 'aria-checked'],
  });
  STATE.passwordTypeObserver = observer;
}

function verticalOverlapAmount(aRect, bRect) {
  return Math.max(0, Math.min(aRect.bottom, bRect.bottom) - Math.max(aRect.top, bRect.top));
}

function isNearPasswordInput(passInput, candidate) {
  if (!passInput || !candidate || !isVisible(candidate)) return false;
  const passRect = passInput.getBoundingClientRect();
  const candidateRect = candidate.getBoundingClientRect();
  const verticalOverlap = verticalOverlapAmount(passRect, candidateRect);
  const horizontalGap = candidateRect.left - passRect.right;
  const candidateCenterX = candidateRect.left + (candidateRect.width / 2);
  return verticalOverlap >= Math.min(passRect.height, candidateRect.height) * 0.4
    && candidateCenterX >= passRect.right - 40
    && horizontalGap <= 80;
}

function findGooglePasswordRevealCandidates(passInput) {
  if (!passInput) return [];
  const scopes = [];
  let current = passInput.parentElement;
  let depth = 0;
  while (current && current !== document.body && depth < 4) {
    scopes.push(current);
    current = current.parentElement;
    depth += 1;
  }

  const seen = new Set();
  const candidates = [];
  scopes.forEach((scope) => {
    Array.from(scope.querySelectorAll('button,[role="button"],[tabindex],svg,img,span,div,label,input[type="checkbox"],input[type="radio"]'))
      .map((element) => findRealClickableTarget(element) || element)
      .forEach((candidate) => {
        if (!candidate || seen.has(candidate) || candidate === passInput || candidate.contains(passInput) || passInput.contains(candidate)) {
          return;
        }
        seen.add(candidate);
        candidates.push(candidate);
      });
  });

  return candidates.filter((candidate) => {
    const hints = actionText(candidate);
    const hasSubjectHint = PASSWORD_REVEAL_SUBJECT_HINTS.some((hint) => hints.includes(hint));
    const hasActionHint = PASSWORD_REVEAL_ACTION_HINTS.some((hint) => hints.includes(hint));
    const hasIconHint = PASSWORD_REVEAL_ICON_HINTS.some((hint) => hints.includes(hint));
    const iconChild = candidate.querySelector?.('svg,img');
    const classHints = normalizeText(`${candidate.className || ''}`);
    const inputType = normalizeText(candidate.getAttribute?.('type'));
    const roleHints = normalizeText(candidate.getAttribute?.('role'));
    const looksLikeEyeIcon = Boolean(iconChild) || /eye|visibility|show|hide|view/.test(classHints);
    const looksLikeToggleInput = inputType === 'checkbox' || inputType === 'radio' || roleHints.includes('checkbox') || roleHints.includes('switch');
    return hasSubjectHint && (hasActionHint || hasIconHint || looksLikeToggleInput || looksLikeEyeIcon);
  });
}

function findExplicitGoogleShowPasswordControls(passInput) {
  if (!passInput) return [];

  const exactTargets = findExactGoogleShowPasswordTargets(passInput);
  if (exactTargets.length) {
    return exactTargets;
  }

  const scopes = [];
  let current = passInput.parentElement;
  let depth = 0;
  while (current && current !== document.body && depth < 4) {
    scopes.push(current);
    current = current.parentElement;
    depth += 1;
  }
  scopes.push(document);

  const controls = [];
  const seen = new Set();
  scopes.forEach((scope) => {
    Array.from(scope.querySelectorAll([
      'input[type="checkbox"]',
      'input[type="radio"]',
      '[role="checkbox"]',
      'label',
      'button',
      '[role="button"]',
    ].join(','))).forEach((candidate) => {
      if (!candidate || seen.has(candidate) || !isVisible(candidate)) return;
      seen.add(candidate);

      const text = actionText(candidate);
      const ariaLabel = normalizeText(candidate.getAttribute?.('aria-label'));
      const looksLikeShowPassword = text.includes('show password') || ariaLabel.includes('show password');
      if (!looksLikeShowPassword) return;

      if (candidate.matches?.('label')) {
        controls.push(candidate);
        const forId = `${candidate.getAttribute('for') || ''}`.trim();
        if (forId) {
          const linkedInput = document.getElementById(forId);
          if (linkedInput && isVisible(linkedInput)) controls.push(linkedInput);
        }
        const nestedInput = candidate.querySelector?.('input[type="checkbox"], input[type="radio"]');
        if (nestedInput && isVisible(nestedInput)) controls.push(nestedInput);
        return;
      }

      controls.push(candidate);
      const clickableAncestor = candidate.closest('button, [role="button"], label, div[tabindex], span[tabindex], li, [data-view-id], [jsaction], [jscontroller]');
      if (clickableAncestor && isVisible(clickableAncestor) && isNearPasswordInput(passInput, clickableAncestor)) {
        controls.push(clickableAncestor);
      }
    });
  });

  return Array.from(new Set(controls)).filter(Boolean);
}

function findGooglePasswordRevealControlFromTarget(target, passInput) {
  if (!target || !passInput) return null;
  const eventTarget = target?.nodeType === Node.ELEMENT_NODE ? target : target?.parentElement;
  if (!eventTarget) return null;

  const revealCandidates = findExplicitGoogleShowPasswordControls(passInput);
  const directMatch = revealCandidates.find((candidate) => (
    candidate === eventTarget
    || candidate.contains?.(eventTarget)
    || eventTarget.contains?.(candidate)
  ));
  if (directMatch) return directMatch;

  let current = eventTarget;
  while (current && current !== document.body) {
    if (isVisible(current) && isNearPasswordInput(passInput, current)) {
      const label = actionText(current);
      const ariaLabel = normalizeText(current.getAttribute?.('aria-label'));
      const hasShowPasswordHint = label.includes('show password') || ariaLabel.includes('show password');
      if (hasShowPasswordHint) {
        return current;
      }
    }
    current = current.parentElement;
  }

  return null;
}

function handleProtectedGooglePasswordRevealAttempt(event) {
  if (!shouldProtectGooglePasswordReveal()) return;
  const passInput = findGooglePasswordInput();
  if (!passInput) return;
  const revealControl = findGooglePasswordRevealControlFromTarget(event.target, passInput);
  if (!revealControl) return;
  disablePasswordRevealControl(revealControl);
  enforceProtectedGooglePasswordMask(passInput);
  scheduleProtectedGooglePasswordRemask(passInput);
  blockRevealControlEvent(event);
}

function ensureProtectedGooglePasswordRevealGuards() {
  if (!shouldProtectGooglePasswordReveal()) return;
  if (document.documentElement?.dataset?.rmwGoogleRevealGuardAttached === 'true') return;
  document.documentElement.dataset.rmwGoogleRevealGuardAttached = 'true';
  ['click', 'mousedown', 'mouseup', 'pointerdown', 'pointerup', 'touchstart', 'touchend', 'keydown', 'keyup', 'change', 'input']
    .forEach((eventName) => document.addEventListener(eventName, handleProtectedGooglePasswordRevealAttempt, true));
}

function enforceProtectedGooglePasswordMask(passInput) {
  if (!passInput) return;
  try { passInput.type = 'password'; } catch {}
  try { passInput.setAttribute('type', 'password'); } catch {}
  keepProtectedGoogleRevealControlsUnchecked(passInput);
}

function findVisibleActionByText(matchers = []) {
  const normalizedMatchers = matchers.map(normalizeText).filter(Boolean);
  if (!normalizedMatchers.length) return null;

  const fallbackSelectors = [
    ACTION_SELECTORS,
    '[data-view-id]',
    '[data-email]',
    '[data-identifier]',
    'li',
    'div',
    'span',
  ].join(',');

  return Array.from(document.querySelectorAll(fallbackSelectors))
    .find((element) => {
      if (isDisabled(element) || !isVisible(element)) return false;
      const label = actionText(element);
      return normalizedMatchers.some((matcher) => label.includes(matcher));
    }) || null;
}

function findGoogleAccountChooserAction(credential) {
  const loginIdentifier = normalizeText(credential?.loginIdentifier || '');
  if (!loginIdentifier) return null;

  const candidates = Array.from(document.querySelectorAll(ACTION_SELECTORS))
    .filter((element) => !isDisabled(element) && isVisible(element));

  return candidates.find((element) => {
    const label = actionText(element);
    return label.includes(loginIdentifier);
  }) || null;
}

function shouldPreferGoogleAddAccount(toolSlug = STATE.toolSlug) {
  const normalized = normalizeToolSlug(toolSlug);
  return normalized === 'enhancor'
    || normalized === 'freepik'
    || normalized === 'genspark'
    || normalized === 'kling'
    || normalized === 'kling-ai'
    || normalized === 'klingai';
}

function findGoogleChooserPanel() {
  const panels = Array.from(document.querySelectorAll('[role="dialog"], [aria-modal="true"], main, section, article, div[data-view-id], div[data-identifier], div'))
    .filter((element) => isVisible(element));
  return panels.find((element) => {
    const text = actionText(element);
    return text.includes('choose an account') && text.includes('use another account');
  }) || null;
}

function collectChooserActionCandidates(root = document) {
  return Array.from(root.querySelectorAll('button, [role="button"], [data-view-id], [data-email], [data-identifier], li, div[tabindex], span[tabindex]'))
    .filter((element) => isVisible(element) && !isDisabled(element));
}

function findGoogleUseAnotherAccountAction() {
  const chooserPanel = findGoogleChooserPanel() || document;
  const rows = collectChooserActionCandidates(chooserPanel);

  const exactRow = rows.find((element) => {
    const label = actionText(element);
    return label === 'use another account'
      || label === 'add another account'
      || label === 'add account';
  });
  if (exactRow) {
    return exactRow;
  }

  const nestedTextNode = Array.from(chooserPanel.querySelectorAll('span, div, p'))
    .find((element) => {
      if (!isVisible(element)) return false;
      const label = actionText(element);
      return label === 'use another account'
        || label === 'add another account'
        || label === 'add account';
    });
  if (nestedTextNode) {
    const ancestor = nestedTextNode.closest('button, [role="button"], [data-view-id], [data-email], [data-identifier], li, div[tabindex], span[tabindex]');
    if (ancestor && isVisible(ancestor) && !isDisabled(ancestor)) {
      return ancestor;
    }
  }

  const partialRow = rows.find((element) => {
    const label = actionText(element);
    return label.includes('use another account')
      || label.includes('add another account')
      || label.includes('add account');
  });
  return partialRow || null;
}

function isGoogleAccountChooserPage() {
  const text = pageText();
  return text.includes('choose an account') || text.includes('use another account');
}

function isGoogleDeveloperInfoDialogVisible() {
  const text = pageText();
  return text.includes('developer info')
    && text.includes('choosing an account will redirect you');
}

function findGoogleDeveloperInfoDialog() {
  const dialogs = Array.from(document.querySelectorAll('[role="dialog"], [aria-modal="true"], div, section, article'))
    .filter((element) => isVisible(element));
  return dialogs.find((element) => {
    const text = actionText(element);
    return text.includes('developer info')
      && text.includes('choosing an account will redirect you');
  }) || null;
}

function findGoogleDeveloperInfoDismissAction() {
  if (!isGoogleDeveloperInfoDialogVisible()) return null;

  const dialog = findGoogleDeveloperInfoDialog();
  const root = dialog || document;

  const directButtons = collectChooserActionCandidates(root)
    .filter((element) => isVisible(element) && !isDisabled(element))
    .filter((element) => actionText(element) === 'got it');
  for (const candidate of directButtons) {
    if (candidate && isVisible(candidate) && !isDisabled(candidate)) {
      return candidate;
    }
  }

  const nestedTextNode = Array.from(root.querySelectorAll('span, div, p'))
    .find((element) => isVisible(element) && actionText(element) === 'got it');
  if (nestedTextNode) {
    const ancestor = nestedTextNode.closest('button, [role="button"], div[tabindex], span[tabindex]');
    if (ancestor && isVisible(ancestor) && !isDisabled(ancestor)) {
      return ancestor;
    }
  }

  return null;
}

function pageText() {
  return normalizeText(document.body?.innerText || '');
}

function isFlowAuthenticatorScreen() {
  if (!supportsGoogleAuthenticatorAutomation()) return false;

  const text = pageText();
  return (
    text.includes('google authenticator app')
    || text.includes('verification code from the google authenticator app')
    || text.includes('verification code from google authenticator')
    || text.includes('get a verification code from the google authenticator app')
  );
}

function isFlowBackupCodeScreen() {
  if (!isFlowTool()) return false;

  const text = pageText();
  return (
    text.includes('enter one of your 8-digit backup codes')
    || text.includes('enter one of your 8 digit backup codes')
    || text.includes('8-digit backup code')
    || text.includes('8 digit backup code')
  );
}

function getFlowBackupCodes(credential) {
  const rawCodes = Array.isArray(credential?.backupCodes)
    ? credential.backupCodes
    : `${credential?.backupCodes || ''}`.split(/[\r\n,;]+/);

  const normalizedCodes = [];
  const seenCodes = new Set();
  rawCodes.forEach((value) => {
    const digitsOnly = `${value || ''}`.replace(/\D/g, '');
    if (digitsOnly.length !== 8 || seenCodes.has(digitsOnly)) return;
    seenCodes.add(digitsOnly);
    normalizedCodes.push(digitsOnly);
  });
  return normalizedCodes;
}

function resetFlowTotpProgress() {
  STATE.lastTotpFilledAt = 0;
  STATE.lastTotpSubmitAt = 0;
  STATE.totpSubmitted = false;
  STATE.totpValue = '';
  STATE.totpFetching = false;
  STATE.totpRequestAttempts = 0;
  STATE.totpLastRequestAt = 0;
  STATE.totpFetchedAt = 0;
  STATE.totpExpiresInSec = 0;
  STATE.totpUnavailable = false;
}

function findFlowAuthenticatorChoiceButton() {
  if (!supportsGoogleAuthenticatorAutomation()) return null;

  return findVisibleActionByText([
    'google authenticator',
    'authenticator app',
    'verification code from the google authenticator app',
    'verification code from google authenticator',
  ]);
}

function findFlowTotpInput() {
  if (!supportsGoogleAuthenticatorAutomation()) return null;

  const currentPageText = pageText();
  if (
    !currentPageText.includes('authenticator')
    && !currentPageText.includes('verification code')
    && !currentPageText.includes('6-digit code')
    && !currentPageText.includes('6 digit code')
  ) {
    return null;
  }
  if (isFlowBackupCodeScreen()) {
    return null;
  }

  const candidates = Array.from(new Set(
    BACKUP_CODE_INPUT_SELECTORS.flatMap((selector) => Array.from(document.querySelectorAll(selector)))
  ));

  return candidates.find((input) => {
    if (!input || input.readOnly || isDisabled(input) || !isVisible(input)) return false;

    const descriptor = normalizeText([
      input.id,
      input.name,
      input.type,
      input.autocomplete,
      input.inputMode,
      input.getAttribute('aria-label'),
      input.getAttribute('placeholder'),
      input.closest('form, main, section, div')?.innerText,
    ].filter(Boolean).join(' '));

    if (descriptor.includes('backup code')) {
      return false;
    }

    if (descriptor.includes('authenticator')) {
      return true;
    }

    if (
      descriptor.includes('verification code')
      || descriptor.includes('6-digit code')
      || descriptor.includes('6 digit code')
      || descriptor.includes('one-time code')
      || descriptor.includes('one time code')
      || descriptor.includes('code')
    ) {
      return true;
    }

    const inputType = `${input.type || ''}`.trim().toLowerCase();
    return ['tel', 'text', 'number'].includes(inputType);
  }) || null;
}

function findFlowTotpSubmitButton(input) {
  return findNextButton('password', input) || findVisibleActionByText([
    'next',
    'continue',
    'done',
    'verify',
    'confirm',
  ]);
}

function isFlowTotpValueExpired() {
  if (!STATE.totpValue || !STATE.totpFetchedAt || !STATE.totpExpiresInSec) return false;
  const ageMs = Date.now() - STATE.totpFetchedAt;
  const ttlMs = Math.max(0, (STATE.totpExpiresInSec - 2) * 1000);
  return ageMs >= ttlMs;
}

function isFlowTotpValueNearExpiry() {
  if (!STATE.totpValue || !STATE.totpFetchedAt || !STATE.totpExpiresInSec) return false;
  const ageMs = Date.now() - STATE.totpFetchedAt;
  const remainingMs = Math.max(0, (STATE.totpExpiresInSec * 1000) - ageMs);
  return remainingMs > 0 && remainingMs <= 8000;
}

function shouldRetryFlowTotp(input) {
  if (!input) return false;

  if (`${input.getAttribute('aria-invalid') || ''}`.trim().toLowerCase() === 'true') {
    return true;
  }

  const contextText = normalizeText([
    document.body?.innerText,
    input.closest('form, main, section, article, div')?.innerText,
    input.getAttribute('aria-describedby'),
  ].filter(Boolean).join(' '));

  return [
    'wrong code',
    'incorrect code',
    'invalid code',
    'try again',
  ].some((token) => contextText.includes(token));
}

function resetFlowTotpValue() {
  STATE.lastTotpFilledAt = 0;
  STATE.lastTotpSubmitAt = 0;
  STATE.totpSubmitted = false;
  STATE.totpValue = '';
  STATE.totpFetchedAt = 0;
  STATE.totpExpiresInSec = 0;
  STATE.totpLastRequestAt = 0;
}

function getCurrentFlowBackupCode(credential) {
  return getFlowBackupCodes(credential)[STATE.backupCodeIndex] || '';
}

function moveToNextFlowBackupCode(credential) {
  const codes = getFlowBackupCodes(credential);
  if (STATE.backupCodeIndex + 1 >= codes.length) {
    return false;
  }

  STATE.backupCodeIndex += 1;
  STATE.lastBackupCodeFilledAt = 0;
  STATE.lastBackupCodeSubmitAt = 0;
  STATE.backupCodeSubmitted = false;
  return true;
}

function resetFlowBackupCodeProgress() {
  STATE.backupCodeIndex = 0;
  STATE.lastBackupCodeFilledAt = 0;
  STATE.lastBackupCodeSubmitAt = 0;
  STATE.backupCodeSubmitted = false;
}

function findFlowBackupCodeChoiceButton() {
  if (!isFlowTool()) return null;

  return findVisibleActionByText([
    'enter one of your 8-digit backup codes',
    'enter one of your 8 digit backup codes',
    'backup code',
    'backup codes',
  ]);
}

function findFlowTryAnotherWayButton() {
  if (!isFlowTool()) return null;

  return findVisibleActionByText([
    'try another way',
    'choose another way',
  ]);
}

function findFlowBackupCodeInput() {
  if (!isFlowTool()) return null;

  if (isFlowAuthenticatorScreen()) {
    return null;
  }

  const currentPageText = pageText();
  const candidates = Array.from(new Set(
    BACKUP_CODE_INPUT_SELECTORS.flatMap((selector) => Array.from(document.querySelectorAll(selector)))
  ));

  return candidates.find((input) => {
    if (!input || input.readOnly || isDisabled(input) || !isVisible(input)) return false;

    const descriptor = normalizeText([
      input.id,
      input.name,
      input.type,
      input.autocomplete,
      input.inputMode,
      input.getAttribute('aria-label'),
      input.getAttribute('placeholder'),
      input.closest('form, main, section, div')?.innerText,
    ].filter(Boolean).join(' '));

    if (descriptor.includes('backup') && descriptor.includes('code')) {
      return true;
    }

    if (!isFlowBackupCodeScreen()) {
      return false;
    }

    if (descriptor.includes('8-digit') || descriptor.includes('8 digit') || descriptor.includes('code')) {
      return true;
    }

    const inputType = `${input.type || ''}`.trim().toLowerCase();
    return ['tel', 'text', 'number'].includes(inputType);
  }) || null;
}

function findFlowBackupCodeSubmitButton(input) {
  return findNextButton('password', input) || findVisibleActionByText([
    'next',
    'continue',
    'done',
    'verify',
    'confirm',
  ]);
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
    element.querySelectorAll?.('button, a[href], input[type="button"], input[type="submit"], [role="button"], [data-view-id], [data-identifier], [data-email], li, div[tabindex], span[tabindex]') || []
  ).find((candidate) => !isDisabled(candidate) && isVisible(candidate));
  if (descendant) {
    return descendant;
  }

  let current = element;
  while (current && current !== document.body) {
    if (
      (
        current.matches?.('button, a[href], input[type="button"], input[type="submit"], [role="button"]')
        || isChooserLikeAction(current)
      )
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

function safeCenterClick(element) {
  const target = findRealClickableTarget(element);
  if (!target || isDisabled(target) || !isVisible(target)) return false;

  const rect = target.getBoundingClientRect();
  if (!rect.width || !rect.height) return false;

  const centerX = rect.left + (rect.width / 2);
  const centerY = rect.top + (rect.height / 2);
  const pointed = document.elementFromPoint(centerX, centerY);
  const resolved = findRealClickableTarget(pointed) || pointed || target;
  if (!resolved || isDisabled(resolved) || !isVisible(resolved)) {
    return false;
  }

  try {
    resolved.scrollIntoView({ block: 'center', inline: 'nearest' });
  } catch {}
  try {
    resolved.focus({ preventScroll: true });
  } catch {
    resolved.focus?.();
  }

  dispatchMouseSequence(resolved);

  try {
    resolved.click?.();
    return true;
  } catch {}

  try {
    resolved.dispatchEvent(new MouseEvent('click', {
      bubbles: true,
      cancelable: true,
      composed: true,
      view: window,
      clientX: centerX,
      clientY: centerY,
    }));
    return true;
  } catch {
    return false;
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

function pressSpace(element) {
  if (!element) return false;

  try {
    element.focus({ preventScroll: true });
  } catch {
    element.focus?.();
  }

  ['keydown', 'keypress', 'keyup'].forEach((eventName) => {
    try {
      element.dispatchEvent(new KeyboardEvent(eventName, {
        key: ' ',
        code: 'Space',
        keyCode: 32,
        which: 32,
        bubbles: true,
        cancelable: true,
      }));
    } catch {}
  });
  return true;
}

function activateActionElement(element) {
  const target = element || null;
  if (!target || isDisabled(target) || !isVisible(target)) return false;

  try {
    target.scrollIntoView({ block: 'center', inline: 'nearest' });
  } catch {}
  try {
    target.focus({ preventScroll: true });
  } catch {
    target.focus?.();
  }

  if (safeCenterClick(target)) return true;
  if (safeClick(target)) return true;
  if (pressEnter(target)) return true;
  if (pressSpace(target)) return true;
  return false;
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

function isGoogleConsentContinueScreen() {
  if (!isKlingGoogleFlow()) return false;
  if (findGoogleEmailInput() || findGooglePasswordInput()) return false;

  const text = pageText();
  const mentionsKling = text.includes("you're signing back in to kling.ai")
    || text.includes('youre signing back in to kling.ai')
    || text.includes('signing back in to kling.ai')
    || text.includes('review kling.ai')
    || text.includes('kling.ai privacy policy')
    || text.includes('kling.ai terms of service');

  return mentionsKling
    && text.includes('sign in with google')
    && text.includes('continue');
}

function findGoogleConsentContinueButton() {
  return findVisibleActionByText([
    'continue',
    'yes, continue',
    'confirm',
    'allow',
  ]);
}

async function attemptGoogleConsentContinueStep() {
  if (!isGoogleConsentContinueScreen()) return false;

  if (STATE.lastConsentSubmitAt && Date.now() - STATE.lastConsentSubmitAt < STEP_PENDING_RETRY_MS) {
    setStatus('Google consent accepted, waiting to continue');
    scheduleAttempt(700);
    return true;
  }

  const continueButton = findGoogleConsentContinueButton();
  if (!continueButton) {
    setStatus('Waiting for Google consent continue button');
    scheduleAttempt(300);
    return true;
  }

  setStatus('Continuing Google sign-in');
  if (!activateActionElement(continueButton)) {
    setStatus('Google consent continue not ready');
    scheduleAttempt(300);
    return true;
  }

  STATE.lastConsentSubmitAt = Date.now();
  setStatus('Google consent accepted, continuing sign-in');
  scheduleAttempt(600);
  return true;
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
  const waitAfterSubmitMs = kind === 'password' ? 1800 : 700;
  const didAdvance = kind === 'password' ? didGooglePasswordAdvance : didGoogleEmailAdvance;

  const nextButton = await waitForGoogleNextButton(
    kind,
    input,
    kind === 'password' ? Math.max(NEXT_BUTTON_WAIT_MS, 4000) : NEXT_BUTTON_WAIT_MS
  );
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
  if (!STATE.passwordSavingSuppressed && !STATE.passwordSavingBypass) return false;

  try {
    input.focus({ preventScroll: true });
  } catch {
    input.focus?.();
  }

  if (`${input.value || ''}` !== passwordValue) {
    await typeInputValueLikeUser(input, passwordValue, { perCharDelayMs: 8 });
    await sleep(Math.max(INPUT_SETTLE_MS, GOOGLE_PASSWORD_SETTLE_MS));
    if (`${input.value || ''}` !== passwordValue) {
      await typeInputValueLikeUser(input, passwordValue, { perCharDelayMs: 4 });
      await sleep(180);
    }
  }

  if (`${input.value || ''}` !== passwordValue) {
    return false;
  }

  input.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
  input.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
  input.dispatchEvent(new Event('blur', { bubbles: true, cancelable: true }));
  await sleep(Math.max(INPUT_SETTLE_MS, 350));

  if (`${input.value || ''}` !== passwordValue) {
    return false;
  }

  const submitted = await submitGoogleNextStep('password', input);
  if (submitted) {
    releasePasswordSavingSuppressed(PASSWORD_PROMPT_RESTORE_DELAY_MS);
  }
  return submitted;
}

async function submitFlowBackupCodeStep(input) {
  if (!input) return false;

  const submitButton = findFlowBackupCodeSubmitButton(input);
  if (submitButton && safeClick(submitButton)) {
    await sleep(900);
    return true;
  }

  if (pressEnter(input)) {
    await sleep(900);
    return true;
  }

  const form = input.closest('form');
  if (form) {
    try {
      if (typeof form.requestSubmit === 'function') form.requestSubmit();
      else form.submit?.();
      await sleep(900);
      return true;
    } catch {}
  }

  return false;
}

async function requestFlowTotp() {
  if (!supportsGoogleAuthenticatorAutomation() || STATE.totpUnavailable || STATE.totpFetching) return;
  if (STATE.totpValue && !isFlowTotpValueExpired()) return;
  if (STATE.totpRequestAttempts >= 4) {
    setStatus(`${getToolDisplayName()} authenticator code fetch failed after 4 attempts`);
    return;
  }

  const now = Date.now();
  if (now - STATE.totpLastRequestAt < 2000) return;

  STATE.totpFetching = true;
  STATE.totpLastRequestAt = now;
  STATE.totpRequestAttempts += 1;
  setStatus(`Fetching ${getToolDisplayName()} authenticator code (attempt ${STATE.totpRequestAttempts})...`);

  const extensionTicket = captureGoogleExtensionTicket(STATE.toolSlug);
  const response = await sendRuntimeMessage({
    type: 'TOOL_HUB_FETCH_TOTP',
    toolSlug: STATE.toolSlug,
    hostname: window.location.hostname,
    pageUrl: window.location.href,
    extensionTicket,
    loginIdentifier: STATE.credential?.loginIdentifier || '',
  });

  STATE.totpFetching = false;

  if (!response?.ok || !response.otp) {
    const errorMessage = `${response?.error || `${getToolDisplayName()} authenticator code not available`}`;
    if (errorMessage.includes('No TOTP secret configured')) {
      STATE.totpUnavailable = true;
      STATE.totpValue = '';
      STATE.totpExpiresInSec = 0;
      STATE.totpFetchedAt = 0;
      if (isFlowTool()) {
        setStatus(`No ${getToolDisplayName()} authenticator seed is configured. Falling back to backup codes if available.`);
      } else {
        setStatus(`No ${getToolDisplayName()} authenticator seed is configured. Choose another verification method or add it in the dashboard.`);
      }
      scheduleAttempt(250);
      return;
    }

    if (errorMessage.includes('No matching tool found')) {
      STATE.totpValue = '';
      setStatus(`${getToolDisplayName()} verification could not be matched to the configured tool. Reload the extension, then launch it again from the dashboard.`);
      scheduleAttempt(1500);
      return;
    }

    STATE.totpValue = '';
    setStatus(errorMessage);
    scheduleAttempt(1500);
    return;
  }

  STATE.totpUnavailable = false;
  STATE.totpValue = `${response.otp}`.trim();
  STATE.totpExpiresInSec = Number(response.expiresInSec || 0);
  STATE.totpFetchedAt = Date.now();
  scheduleAttempt(100);
}

async function submitFlowTotpStep(input) {
  if (!input) return false;

  const submitButton = findFlowTotpSubmitButton(input);
  if (submitButton && safeClick(submitButton)) {
    await sleep(900);
    return true;
  }

  if (pressEnter(input)) {
    await sleep(900);
    return true;
  }

  const form = input.closest('form');
  if (form) {
    try {
      if (typeof form.requestSubmit === 'function') form.requestSubmit();
      else form.submit?.();
      await sleep(900);
      return true;
    } catch {}
  }

  return false;
}

async function loadLaunchState() {
  const inferredToolSlug = normalizeToolSlug(STATE.toolSlug || inferToolSlugFromGooglePage());
  const extensionTicket = supportsGoogleAuthenticatorAutomation(inferredToolSlug)
    ? captureGoogleExtensionTicket(inferredToolSlug)
    : '';
  const response = extensionTicket
    ? await sendRuntimeMessage({
        type: 'TOOL_HUB_ACTIVATE_LAUNCH',
        toolSlug: inferredToolSlug,
        hostname: window.location.hostname,
        pageUrl: window.location.href,
        extensionTicket,
      })
    : await sendRuntimeMessage({
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

  if (inferredToolSlug === 'flow' && !extensionTicket) {
    STATE.launchAuthorized = false;
  }
}

async function retryLaunchStateIfNeeded() {
  const inferredToolSlug = normalizeToolSlug(
    STATE.toolSlug
    || inferToolSlugFromGooglePage()
    || inferStoredGoogleToolSlug()
  );
  if (!inferredToolSlug) return false;
  if (STATE.launchRetryAttempts >= 3) return false;

  const now = Date.now();
  if (now - STATE.lastLaunchRetryAt < 500) {
    return true;
  }

  STATE.toolSlug = inferredToolSlug;
  STATE.launchRetryAttempts += 1;
  STATE.lastLaunchRetryAt = now;
  STATE.launchChecked = false;
  setStatus(`Re-checking ${getToolDisplayName(inferredToolSlug)} dashboard launch`);

  try {
    await loadLaunchState();
  } catch {
    STATE.launchChecked = true;
    STATE.launchAuthorized = false;
  }

  return true;
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
  const requestContext = getContinuationRequestContext(toolSlug);
  const extensionTicket = supportsGoogleAuthenticatorAutomation(toolSlug)
    ? captureGoogleExtensionTicket(toolSlug)
    : '';

  chrome.runtime.sendMessage(
    {
      type: 'TOOL_HUB_GET_CREDENTIAL',
      toolSlug,
      hostname: requestContext.hostname,
      pageUrl: requestContext.pageUrl,
      extensionTicket,
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

async function markAuthTransition() {
  if (!isFlowTool()) return false;
  if (STATE.authTransitionMarkedAt && Date.now() - STATE.authTransitionMarkedAt < 15000) {
    return true;
  }

  const response = await sendRuntimeMessage({
    type: 'TOOL_HUB_MARK_AUTH_TRANSITION',
    toolSlug: STATE.toolSlug,
  });
  if (response?.ok) {
    STATE.authTransitionMarkedAt = Date.now();
    return true;
  }
  return false;
}

async function attemptEmailStep(credential) {
  const directAddAccountUrl = (
    isGoogleAccountChooserPage()
    && shouldPreferGoogleAddAccount()
    && !findGoogleEmailInput()
    && getGoogleAddAccountDirectUrl()
  );
  if (directAddAccountUrl) {
    if (!STATE.googleAddAccountPendingAt || Date.now() - STATE.googleAddAccountPendingAt > 2500) {
      STATE.googleAddAccountPendingAt = Date.now();
      setStatus('Opening Google add-account flow');
      window.location.replace(directAddAccountUrl);
      return true;
    }
  }

  const developerInfoDismissAction = findGoogleDeveloperInfoDismissAction();
  if (developerInfoDismissAction) {
    setStatus('Dismissing Google developer info');
    if (!activateActionElement(developerInfoDismissAction)) {
      setStatus('Google developer info dialog not ready');
      scheduleAttempt(250);
      return true;
    }

    STATE.developerInfoDismissedAt = Date.now();
    if (STATE.lastEmailSubmitAt) {
      STATE.googleAddAccountPendingAt = Date.now();
    }
    scheduleAttempt(400);
    return true;
  }

  if (STATE.developerInfoDismissedAt && Date.now() - STATE.developerInfoDismissedAt < 1200) {
    setStatus('Developer info dismissed, returning to account chooser');
    scheduleAttempt(350);
    return true;
  }

  if (STATE.googleAddAccountPendingAt) {
    const elapsed = Date.now() - STATE.googleAddAccountPendingAt;
    if (findGoogleEmailInput() || isGoogleIdentifierUrl()) {
      STATE.googleAddAccountPendingAt = 0;
    } else if (elapsed < 5000) {
      setStatus('Waiting for Google add-account redirect');
      scheduleAttempt(500);
      return true;
    } else {
      STATE.googleAddAccountPendingAt = 0;
    }
  }

  const useAnotherAccountAction = (
    isGoogleAccountChooserPage()
    && shouldPreferGoogleAddAccount()
    && findGoogleUseAnotherAccountAction()
  );
  if (useAnotherAccountAction) {
    if (STATE.lastEmailSubmitAt && Date.now() - STATE.lastEmailSubmitAt < 1800) {
      setStatus('Opening Google add-account flow');
      scheduleAttempt(700);
      return true;
    }

    setStatus('Choosing Google add account');
    if (!activateActionElement(useAnotherAccountAction)) {
      setStatus('Google add-account option not ready');
      scheduleAttempt(300);
      return true;
    }

    STATE.lastEmailSubmitAt = Date.now();
    STATE.emailSubmitted = false;
    STATE.googleAddAccountPendingAt = Date.now();
    scheduleAttempt(450);
    return true;
  }

  const accountChooserAction = findGoogleAccountChooserAction(credential);
  if (accountChooserAction) {
    if (STATE.emailSubmitted && Date.now() - STATE.lastEmailSubmitAt < STEP_PENDING_RETRY_MS) {
      setStatus('Google account selected, waiting to continue');
      scheduleAttempt(700);
      return true;
    }

    setStatus('Selecting Google account');
    if (!submitStep(accountChooserAction, accountChooserAction)) {
      setStatus('Google account chooser not ready');
      scheduleAttempt(300);
      return true;
    }

    STATE.lastEmailSubmitAt = Date.now();
    STATE.emailSubmitted = true;
    scheduleAttempt(450);
    return true;
  }

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
    scheduleAttempt(450);
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
  const passwordValue = `${credential?.password || ''}`;

  if (!passwordValue && supportsPasswordOptionalGoogleCredential()) {
    STATE.settled = true;
    setStatus('Google password step needs manual completion for this Kling account.');
    releasePasswordSavingSuppressed(0);
    return true;
  }

  if (!STATE.passwordSavingSuppressed && !STATE.passwordSavingBypass) {
    requestPasswordSavingSuppression();
    return true;
  }

  if (isGooglePasswordUrl() || document.querySelector('#passwordNext')) {
    STATE.emailSubmitted = false;
    if (STATE.passwordSubmitted && Date.now() - STATE.lastPasswordSubmitAt < STEP_PENDING_RETRY_MS) {
      setStatus('Password submitted, waiting for Google sign-in');
      scheduleAttempt(700);
      return true;
    }

    if (input.value !== passwordValue) {
      try {
        input.focus({ preventScroll: true });
      } catch {
        input.focus?.();
      }
      await typeInputValueLikeUser(input, passwordValue, { perCharDelayMs: 8 });
      ensureProtectedGoogleRevealShield(input);
      disableExactGoogleShowPasswordTargets(input);
      enforceProtectedGooglePasswordMask(input);
      STATE.lastPasswordFilledAt = Date.now();
      STATE.passwordSubmitted = false;
      setStatus('Password filled, waiting to continue');
      scheduleAttempt(Math.max(INPUT_SETTLE_MS, GOOGLE_PASSWORD_SETTLE_MS));
      return true;
    }

    if (STATE.lastPasswordFilledAt > 0) {
      ensureProtectedGoogleRevealShield(input);
      disableExactGoogleShowPasswordTargets(input);
      enforceProtectedGooglePasswordMask(input);
      const settleRemaining = Math.max(INPUT_SETTLE_MS, GOOGLE_PASSWORD_SETTLE_MS) - (Date.now() - STATE.lastPasswordFilledAt);
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

    const now = Date.now();
    if (`${input.value || ''}` === passwordValue && now - STATE.lastPasswordSubmitAt > 1200) {
      const submitted = await submitGooglePasswordStep(credential);
      if (!submitted) {
        setStatus('Google password step not ready');
        scheduleAttempt(500);
        return true;
      }

      STATE.lastPasswordSubmitAt = now;
      STATE.passwordSubmitted = true;
      resetFlowTotpProgress();
      resetFlowBackupCodeProgress();
      await markAuthTransition();
      setStatus('Password submitted, signing in');
      scheduleAttempt(350);
      return true;
    }

    setStatus('Password filled, waiting to continue');
    scheduleAttempt(250);
    return true;
  }

  STATE.emailSubmitted = false;
  if (input.value !== passwordValue) {
    try {
      input.focus({ preventScroll: true });
    } catch {
      input.focus?.();
    }
    await typeInputValueLikeUser(input, passwordValue, { perCharDelayMs: 8 });
    ensureProtectedGoogleRevealShield(input);
    disableExactGoogleShowPasswordTargets(input);
    enforceProtectedGooglePasswordMask(input);
    STATE.lastPasswordFilledAt = Date.now();
    STATE.passwordSubmitted = false;
    setStatus('Password filled, waiting to continue');
    scheduleAttempt(Math.max(INPUT_SETTLE_MS, GOOGLE_PASSWORD_SETTLE_MS));
    return true;
  }

  if (STATE.lastPasswordFilledAt > 0) {
    ensureProtectedGoogleRevealShield(input);
    disableExactGoogleShowPasswordTargets(input);
    enforceProtectedGooglePasswordMask(input);
    const settleRemaining = Math.max(INPUT_SETTLE_MS, GOOGLE_PASSWORD_SETTLE_MS) - (Date.now() - STATE.lastPasswordFilledAt);
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

  const now = Date.now();
  if (`${input.value || ''}` === passwordValue && now - STATE.lastPasswordSubmitAt > 2500) {
    const submitted = await submitGooglePasswordStep(credential);
    if (!submitted) {
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

async function attemptFlowTotpStep() {
  if (!supportsGoogleAuthenticatorAutomation()) return false;

  const totpInput = findFlowTotpInput();
  const authenticatorChoiceButton = findFlowAuthenticatorChoiceButton();

  if (!totpInput && !authenticatorChoiceButton) {
    return false;
  }

  if (STATE.totpUnavailable) {
    if (totpInput) {
      const tryAnotherWayButton = findFlowTryAnotherWayButton();
      if (tryAnotherWayButton) {
        setStatus(`${getToolDisplayName()} authenticator seed missing. Returning to other verification methods...`);
        if (!safeClick(tryAnotherWayButton)) {
          scheduleAttempt(400);
          return true;
        }
        scheduleAttempt(900);
        return true;
      }
      setStatus(`${getToolDisplayName()} authenticator verification is not available right now. Reload the extension, then launch it again from the dashboard if this keeps happening.`);
      return true;
    }
    return false;
  }

  if (authenticatorChoiceButton && !totpInput) {
    if (!STATE.totpValue && !STATE.totpFetching && !STATE.totpRequestAttempts) {
      requestFlowTotp();
      setStatus(`Checking for a stored ${getToolDisplayName()} authenticator seed...`);
      return true;
    }
    if (STATE.totpFetching) {
      setStatus(`Checking for a stored ${getToolDisplayName()} authenticator seed...`);
      return true;
    }
    if (!STATE.totpValue) {
      return false;
    }
    setStatus(`Choosing ${getToolDisplayName()} authenticator-app sign-in...`);
    if (!safeClick(authenticatorChoiceButton)) {
      setStatus(`${getToolDisplayName()} authenticator option is visible but not clickable yet`);
      scheduleAttempt(400);
      return true;
    }
    scheduleAttempt(900);
    return true;
  }

  if (!totpInput) {
    return false;
  }

  if (shouldRetryFlowTotp(totpInput)) {
    resetFlowTotpValue();
    setStatus(`${getToolDisplayName()} authenticator code was rejected. Fetching a fresh code...`);
    requestFlowTotp();
    scheduleAttempt(700);
    return true;
  }

  if (STATE.totpSubmitted) {
    if (Date.now() - STATE.lastTotpSubmitAt < STEP_PENDING_RETRY_MS) {
      setStatus(`Authenticator code submitted, waiting for ${getToolDisplayName()} sign-in`);
      scheduleAttempt(700);
      return true;
    }

    resetFlowTotpValue();
  }

  if (isFlowTotpValueExpired()) {
    resetFlowTotpValue();
  }

  if (isFlowTotpValueNearExpiry()) {
    resetFlowTotpValue();
    requestFlowTotp();
    setStatus(`Refreshing ${getToolDisplayName()} authenticator code before it expires...`);
    scheduleAttempt(500);
    return true;
  }

  if (!STATE.totpValue) {
    await requestFlowTotp();
    if (!STATE.totpValue && STATE.totpFetching) {
      setStatus(`Fetching ${getToolDisplayName()} authenticator code...`);
    }
    return true;
  }

  if (`${totpInput.value || ''}` !== STATE.totpValue) {
    totpInput.focus?.();
    setInputValue(totpInput, STATE.totpValue);
    totpInput.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
    totpInput.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
    totpInput.dispatchEvent(new Event('blur', { bubbles: true, cancelable: true }));
    STATE.lastTotpFilledAt = Date.now();
    STATE.totpSubmitted = false;
    setStatus(`Filling ${getToolDisplayName()} authenticator code...`);
    scheduleAttempt(INPUT_SETTLE_MS);
    return true;
  }

  if (STATE.lastTotpFilledAt > 0) {
    const settleRemaining = INPUT_SETTLE_MS - (Date.now() - STATE.lastTotpFilledAt);
    if (settleRemaining > 0) {
      setStatus(`${getToolDisplayName()} authenticator code filled, waiting to continue`);
      scheduleAttempt(settleRemaining);
      return true;
    }
  }

  const submitted = await submitFlowTotpStep(totpInput);
  if (!submitted) {
    setStatus(`${getToolDisplayName()} authenticator code filled, submit action not ready`);
    scheduleAttempt(250);
    return true;
  }

  STATE.lastTotpSubmitAt = Date.now();
  STATE.totpSubmitted = true;
  await markAuthTransition();
  setStatus(`Authenticator code submitted, completing ${getToolDisplayName()} sign-in`);
  scheduleAttempt(800);
  return true;
}

async function attemptFlowBackupCodeStep(credential) {
  if (!isFlowTool()) return false;

  const backupCodeInput = findFlowBackupCodeInput();
  const backupCodeChoiceButton = findFlowBackupCodeChoiceButton();
  const tryAnotherWayButton = findFlowTryAnotherWayButton();
  const backupCodes = getFlowBackupCodes(credential);

  if (!backupCodeInput && !backupCodeChoiceButton && !isFlowBackupCodeScreen()) {
    return false;
  }

  if (!backupCodes.length) {
    setStatus('Flow needs backup codes. Add them in the dashboard or enter one manually.');
    return true;
  }

  if (backupCodeChoiceButton && !backupCodeInput) {
    setStatus('Choosing Flow backup-code sign-in...');
    if (!safeClick(backupCodeChoiceButton)) {
      setStatus('Flow backup-code option is visible but not clickable yet');
      scheduleAttempt(400);
      return true;
    }
    scheduleAttempt(900);
    return true;
  }

  if (!backupCodeInput && tryAnotherWayButton) {
    setStatus('Opening alternate Flow verification options...');
    if (!safeClick(tryAnotherWayButton)) {
      setStatus('Flow verification menu is not clickable yet');
      scheduleAttempt(400);
      return true;
    }
    scheduleAttempt(900);
    return true;
  }

  if (!backupCodeInput) {
    setStatus('Waiting for Flow backup-code field');
    scheduleAttempt(500);
    return true;
  }

  if (STATE.backupCodeSubmitted) {
    if (Date.now() - STATE.lastBackupCodeSubmitAt < STEP_PENDING_RETRY_MS) {
      setStatus('Backup code submitted, waiting for Flow sign-in');
      scheduleAttempt(700);
      return true;
    }

    if (!moveToNextFlowBackupCode(credential)) {
      STATE.settled = true;
      setStatus('All stored Flow backup codes were tried. Update them in the dashboard or enter a code manually.');
      releasePasswordSavingSuppressed(0);
      return true;
    }

    setStatus('Retrying Flow sign-in with the next backup code...');
  }

  const backupCode = getCurrentFlowBackupCode(credential);
  if (!backupCode) {
    setStatus('Flow backup codes are missing. Add them in the dashboard.');
    return true;
  }

  if (`${backupCodeInput.value || ''}` !== backupCode) {
    backupCodeInput.focus?.();
    setInputValue(backupCodeInput, backupCode);
    backupCodeInput.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
    backupCodeInput.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
    backupCodeInput.dispatchEvent(new Event('blur', { bubbles: true, cancelable: true }));
    STATE.lastBackupCodeFilledAt = Date.now();
    STATE.backupCodeSubmitted = false;
    setStatus('Filling Flow backup code...');
    scheduleAttempt(INPUT_SETTLE_MS);
    return true;
  }

  if (STATE.lastBackupCodeFilledAt > 0) {
    const settleRemaining = INPUT_SETTLE_MS - (Date.now() - STATE.lastBackupCodeFilledAt);
    if (settleRemaining > 0) {
      setStatus('Flow backup code filled, waiting to continue');
      scheduleAttempt(settleRemaining);
      return true;
    }
  }

  const submitted = await submitFlowBackupCodeStep(backupCodeInput);
  if (!submitted) {
    setStatus('Flow backup code filled, submit action not ready');
    scheduleAttempt(250);
    return true;
  }

  STATE.lastBackupCodeSubmitAt = Date.now();
  STATE.backupCodeSubmitted = true;
  await markAuthTransition();
  setStatus('Backup code submitted, completing Flow sign-in');
  scheduleAttempt(800);
  return true;
}

async function attemptFill() {
  if (STATE.settled) return;
  if (!STATE.launchChecked) {
    setStatus('Checking dashboard launch');
    return;
  }
  if (!STATE.launchAuthorized) {
    if (await retryLaunchStateIfNeeded()) {
      scheduleAttempt(250);
      return;
    }
    enforceDashboardOnlyAccess();
    return;
  }
  STATE.launchRetryAttempts = 0;

  const credential = STATE.credential;
  if (isEmbeddedGoogleButtonFrame()) {
    if (!credential?.loginIdentifier) {
      requestCredential();
      return;
    }
    if (`${credential?.loginMethod || ''}`.trim().toLowerCase() !== 'google') {
      STATE.settled = true;
      return;
    }
    if (STATE.embeddedButtonClickedAt && Date.now() - STATE.embeddedButtonClickedAt < 3000) {
      return;
    }

    const googleButton = findEmbeddedGoogleButtonAction();
    if (!googleButton) {
      setStatus('Waiting for embedded Google button');
      return;
    }

    if (safeClick(googleButton)) {
      STATE.embeddedButtonClickedAt = Date.now();
      STATE.settled = true;
      return;
    }

    setStatus('Embedded Google button not clickable yet');
    scheduleAttempt(250);
    return;
  }

  if (!credential?.loginIdentifier || (!credential?.password && !supportsPasswordOptionalGoogleCredential(STATE.toolSlug))) {
    if (findGoogleEmailInput() || findGooglePasswordInput() || isGoogleAccountChooserPage() || findGoogleAccountChooserAction(credential)) {
      requestCredential();
    }
    return;
  }

  if (await attemptPasswordStep(credential)) return;
  if (await attemptGoogleConsentContinueStep()) return;
  if (await attemptEmailStep(credential)) return;
  if (await attemptFlowTotpStep()) return;
  if (await attemptFlowBackupCodeStep(credential)) return;

  setStatus('Waiting for Google sign-in fields');
}

async function runAttempt() {
  STATE.scheduledTimer = null;

  if (STATE.runInFlight) {
    scheduleAttempt(200);
    return;
  }

  const now = Date.now();
  if (now - STATE.lastRunAt < MIN_RUN_GAP_MS) {
    scheduleAttempt(MIN_RUN_GAP_MS - (now - STATE.lastRunAt));
    return;
  }

  STATE.runInFlight = true;
  STATE.lastRunAt = now;

  try {
    await attemptFill();
  } catch (error) {
    STATE.settled = true;
    setStatus(`Script error: ${error?.message || 'Unknown error'}`);
    releasePasswordSavingSuppressed(0);
  } finally {
    STATE.runInFlight = false;
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
  if (!shouldRunOnCurrentPage()) {
    return;
  }

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
      ensureStatusBadge();
      scheduleAttempt(0);
    });
}

start();
})();
