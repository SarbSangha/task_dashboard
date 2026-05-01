(() => {
const LOGIN_FLOW_STORAGE_KEY = 'rmw_chatgpt_login_flow_hints_v1';
const LOGIN_FLOW_HINT_TTL_MS = 45 * 24 * 60 * 60 * 1000;
const FLOW_EXTENSION_TICKET_STORAGE_KEY = 'rmw_flow_google_extension_ticket';
const STATE = {
  credential: null,
  requested: false,
  requestAttempts: 0,
  lastRequestAt: 0,
  lastEmailFilledAt: 0,
  lastEmailSubmitAt: 0,
  lastPasswordFilledAt: 0,
  lastPasswordSubmitAt: 0,
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
  lastMutationHandledAt: 0,
  launchChecked: false,
  launchAuthorized: false,
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
  settled: false,
  status: 'Waiting for Google sign-in',
};

const MIN_RUN_GAP_MS = 900;
const KEEP_ALIVE_MS = 3500;
const STEP_PENDING_RETRY_MS = 5000;
const INPUT_SETTLE_MS = 300;
const NEXT_BUTTON_WAIT_MS = 2500;
const NEXT_BUTTON_POLL_MS = 120;
const PASSWORD_PROMPT_RESTORE_DELAY_MS = 8000;
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
  return normalized;
}

function normalizeText(value) {
  return `${value || ''}`.replace(/\s+/g, ' ').trim().toLowerCase();
}

function isFlowTool() {
  return normalizeToolSlug(STATE.toolSlug) === 'flow';
}

function supportsGoogleAuthenticatorAutomation(toolSlug = STATE.toolSlug) {
  const normalizedToolSlug = normalizeToolSlug(toolSlug || inferToolSlugFromGooglePage());
  return normalizedToolSlug === 'flow' || normalizedToolSlug === 'chatgpt';
}

function getToolDisplayName(toolSlug = STATE.toolSlug) {
  const normalizedToolSlug = normalizeToolSlug(toolSlug || inferToolSlugFromGooglePage());
  if (normalizedToolSlug === 'flow') return 'Flow';
  if (normalizedToolSlug === 'chatgpt') return 'ChatGPT';
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

function readStoredFlowExtensionTicket() {
  try {
    return `${window.sessionStorage.getItem(FLOW_EXTENSION_TICKET_STORAGE_KEY) || ''}`.trim();
  } catch {
    return '';
  }
}

function storeFlowExtensionTicket(ticket) {
  try {
    if (ticket) window.sessionStorage.setItem(FLOW_EXTENSION_TICKET_STORAGE_KEY, ticket);
    else window.sessionStorage.removeItem(FLOW_EXTENSION_TICKET_STORAGE_KEY);
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

function captureFlowExtensionTicket() {
  try {
    const url = new URL(window.location.href);
    const directTicket = `${url.searchParams.get('rmw_extension_ticket') || ''}`.trim()
      || `${new URLSearchParams((url.hash || '').replace(/^#/, '')).get('rmw_extension_ticket') || ''}`.trim();
    if (directTicket) {
      storeFlowExtensionTicket(directTicket);
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
        storeFlowExtensionTicket(nestedTicket);
        return nestedTicket;
      }
    }
  } catch {}

  return readStoredFlowExtensionTicket();
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
  } catch {}

  const currentPageText = pageText();
  if (
    currentPageText.includes('continue to openai')
    || currentPageText.includes('continue to chatgpt')
    || currentPageText.includes('to continue to openai')
  ) {
    return 'chatgpt';
  }

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

function getContinuationRequestContext(toolSlug = STATE.toolSlug) {
  const normalizedToolSlug = normalizeToolSlug(toolSlug || inferToolSlugFromGooglePage());
  if (normalizedToolSlug === 'chatgpt') {
    return {
      hostname: 'chatgpt.com',
      pageUrl: 'https://chatgpt.com/',
    };
  }

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

function findVisibleActionByText(matchers = []) {
  const normalizedMatchers = matchers.map(normalizeText).filter(Boolean);
  if (!normalizedMatchers.length) return null;

  return Array.from(document.querySelectorAll(ACTION_SELECTORS))
    .find((element) => {
      if (isDisabled(element) || !isVisible(element)) return false;
      const label = actionText(element);
      return normalizedMatchers.some((matcher) => label.includes(matcher));
    }) || null;
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
  if (!STATE.passwordSavingSuppressed && !STATE.passwordSavingBypass) return false;

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

  const extensionTicket = captureFlowExtensionTicket();
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
    if (
      errorMessage.includes('No TOTP secret configured')
      || errorMessage.includes('http=404')
    ) {
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
  const extensionTicket = inferredToolSlug === 'flow' ? captureFlowExtensionTicket() : '';
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
  const extensionTicket = toolSlug === 'flow' ? captureFlowExtensionTicket() : '';

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
    resetFlowTotpProgress();
    resetFlowBackupCodeProgress();
    await markAuthTransition();
    setStatus('Password submitted, signing in');
    scheduleAttempt(700);
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
      setStatus(`${getToolDisplayName()} authenticator seed is not configured. Choose another verification method or add it in the dashboard.`);
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

  if (STATE.totpSubmitted) {
    if (Date.now() - STATE.lastTotpSubmitAt < STEP_PENDING_RETRY_MS) {
      setStatus(`Authenticator code submitted, waiting for ${getToolDisplayName()} sign-in`);
      scheduleAttempt(700);
      return true;
    }

    STATE.lastTotpSubmitAt = 0;
    STATE.totpSubmitted = false;
    STATE.totpValue = '';
    STATE.totpFetchedAt = 0;
    STATE.totpExpiresInSec = 0;
  }

  if (isFlowTotpValueExpired()) {
    STATE.totpValue = '';
    STATE.totpFetchedAt = 0;
    STATE.totpExpiresInSec = 0;
  }

  if (!STATE.totpValue) {
    requestFlowTotp();
    setStatus(STATE.totpFetching ? `Fetching ${getToolDisplayName()} authenticator code...` : `Waiting for ${getToolDisplayName()} authenticator code...`);
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
  if (await attemptFlowTotpStep()) return;
  if (await attemptFlowBackupCodeStep(credential)) return;

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
