const TOOL_SLUG = 'grammarly';
const LOGIN_URL = 'https://www.grammarly.com/signin';
const PREPARED_LAUNCH_KEY = 'rmw_grammarly_prepared_launch';
const BLOCKED_NOTICE_KEY = 'rmw_grammarly_blocked_notice';
const EXTENSION_TICKET_KEY = 'rmw_extension_ticket';
const PASSWORD_SUBMIT_ATTEMPTS_KEY = 'rmw_grammarly_password_submit_attempts';
const PASSWORD_SUBMIT_PENDING_UNTIL_KEY = 'rmw_grammarly_password_submit_pending_until';

const STATE = {
  credential: null,
  requested: false,
  requestAttempts: 0,
  lastRequestAt: 0,
  lastSubmitAt: 0,
  lastLoginOpenAt: 0,
  loginOpenAttempts: 0,
  lastRunAt: 0,
  lastMutationHandledAt: 0,
  scheduledTimer: null,
  keepAliveTimer: null,
  observer: null,
  settled: false,
  launchChecked: false,
  launchAuthorized: false,
  launchPrepared: false,
  launchExpiresAt: 0,
  passwordSavingInFlight: false,
  passwordSavingSuppressed: false,
  passwordSavingRestoreTimer: null,
  passwordRevealGuardAttached: false,
  passwordSubmitPendingUntil: 0,
  passwordSubmitGuardAttached: false,
  passwordSubmitAttempts: 0,
  lastEmailFilledAt: 0,
  lastPasswordFilledAt: 0,
  status: 'Waiting for Grammarly login form',
};

const MIN_RUN_GAP_MS = 900;
const KEEP_ALIVE_MS = 4000;
const PASSWORD_PROMPT_RESTORE_DELAY_MS = 8000;
const PASSWORD_SUBMIT_PENDING_MS = 15000;
const MAX_PASSWORD_SUBMIT_ATTEMPTS = 1;
const FIELD_SETTLE_DELAY_MS = 1200;

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

const PASSWORD_REVEAL_ACTION_HINTS = ['show', 'hide', 'view', 'reveal', 'toggle'];
const PASSWORD_REVEAL_SUBJECT_HINTS = ['password', 'passcode'];
const PASSWORD_REVEAL_ICON_HINTS = ['eye', 'visibility', 'visible'];

const ACTION_SELECTORS = [
  'button',
  'input[type="submit"]',
  'a[href]',
  '[role="button"]',
];

const NON_SUBMIT_ACTION_HINTS = [
  "can't sign in",
  'cannot sign in',
  'cant sign in',
  'forgot',
  'remind me',
  'support',
  'help',
  "i don't have an account",
  'privacy',
  'terms',
  'notice at collection',
];

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
    badge.textContent = `Grammarly auto-login\n${message}`;
  }
  console.debug('[RMW Grammarly Auto Login]', message);
}

function readLaunchTicketFromUrl() {
  const searchParams = new URLSearchParams(window.location.search || '');
  const directQueryTicket = `${searchParams.get('rmw_extension_ticket') || ''}`.trim();
  if (directQueryTicket) {
    return directQueryTicket;
  }

  const hash = `${window.location.hash || ''}`.replace(/^#/, '');
  if (!hash) return '';
  const hashParams = new URLSearchParams(hash);
  return `${hashParams.get('rmw_extension_ticket') || ''}`.trim();
}

function getStoredLaunchTicket() {
  try {
    return `${window.sessionStorage.getItem(EXTENSION_TICKET_KEY) || ''}`.trim();
  } catch {
    return '';
  }
}

function getPreparedLaunchKey() {
  try {
    return `${window.sessionStorage.getItem(PREPARED_LAUNCH_KEY)
      || window.localStorage.getItem(PREPARED_LAUNCH_KEY)
      || ''}`.trim();
  } catch {
    return '';
  }
}

function clearStoredLaunchTicket() {
  try {
    window.sessionStorage.removeItem(EXTENSION_TICKET_KEY);
  } catch {}
}

function getSessionNumber(key) {
  try {
    const value = Number(window.sessionStorage.getItem(key) || 0);
    return Number.isFinite(value) ? value : 0;
  } catch {
    return 0;
  }
}

function setSessionNumber(key, value) {
  try {
    if (!value) {
      window.sessionStorage.removeItem(key);
      return;
    }
    window.sessionStorage.setItem(key, `${value}`);
  } catch {}
}

function syncPasswordSubmitStateFromStorage() {
  STATE.passwordSubmitAttempts = getSessionNumber(PASSWORD_SUBMIT_ATTEMPTS_KEY);
  STATE.passwordSubmitPendingUntil = getSessionNumber(PASSWORD_SUBMIT_PENDING_UNTIL_KEY);
}

function persistPasswordSubmitState() {
  setSessionNumber(PASSWORD_SUBMIT_ATTEMPTS_KEY, STATE.passwordSubmitAttempts);
  setSessionNumber(PASSWORD_SUBMIT_PENDING_UNTIL_KEY, STATE.passwordSubmitPendingUntil);
}

function clearPasswordSubmitState() {
  STATE.passwordSubmitAttempts = 0;
  STATE.passwordSubmitPendingUntil = 0;
  persistPasswordSubmitState();
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

function captureLaunchTicketFromHash() {
  const ticket = readLaunchTicketFromUrl();
  if (!ticket) return '';

  storeLaunchTicket(ticket);
  try {
    const searchParams = new URLSearchParams(window.location.search || '');
    searchParams.delete('rmw_extension_ticket');
    searchParams.delete('rmw_tool_slug');
    const nextSearch = searchParams.toString();
    const cleanUrl = `${window.location.pathname}${nextSearch ? `?${nextSearch}` : ''}`;
    window.history.replaceState(null, '', cleanUrl);
  } catch {}
  return ticket;
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

function buttonText(button) {
  return `${button.innerText || button.textContent || button.value || button.getAttribute?.('aria-label') || ''}`
    .trim()
    .toLowerCase();
}

function buttonDescriptorText(button) {
  if (!button) return '';

  const textParts = [
    button.innerText,
    button.textContent,
    button.value,
    button.getAttribute?.('aria-label'),
    button.getAttribute?.('title'),
    button.getAttribute?.('data-provider'),
    button.getAttribute?.('href'),
  ];

  button.querySelectorAll?.('img[alt], [aria-label], [title], [data-provider]').forEach((node) => {
    textParts.push(
      node.getAttribute?.('alt'),
      node.getAttribute?.('aria-label'),
      node.getAttribute?.('title'),
      node.getAttribute?.('data-provider')
    );
  });

  return textParts
    .filter(Boolean)
    .join(' ')
    .trim()
    .toLowerCase();
}

function isThirdPartyAuthAction(button) {
  const text = buttonDescriptorText(button);
  return text.includes('google')
    || text.includes('apple')
    || text.includes('facebook')
    || text.includes('single sign-on')
    || text.includes('sso')
    || text.includes('continue as ');
}

function findInput(selectors) {
  for (const selector of selectors) {
    const inputs = Array.from(document.querySelectorAll(selector));
    const match = inputs.find((input) => !input.disabled && !input.readOnly && isVisible(input));
    if (match) return match;
  }
  return null;
}

function clearPageStorage() {
  const preparedLaunch = getPreparedLaunchKey();
  try {
    window.localStorage.clear();
  } catch {}
  try {
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
  if (preparedLaunch) {
    try {
      window.localStorage.setItem(PREPARED_LAUNCH_KEY, preparedLaunch);
    } catch {}
    try {
      window.sessionStorage.setItem(PREPARED_LAUNCH_KEY, preparedLaunch);
    } catch {}
  }
  clearPasswordSubmitState();
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

function findStepContainer(...inputs) {
  const seed = inputs.find(Boolean);
  if (!seed) return [document];

  const containers = [];
  let current = seed.parentElement;

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

function collectActionCandidates(root) {
  return Array.from((root || document).querySelectorAll(ACTION_SELECTORS.join(',')))
    .filter((button) => !isDisabled(button) && isVisible(button) && !isThirdPartyAuthAction(button));
}

function isNonSubmitAction(element) {
  const text = buttonDescriptorText(element);
  return NON_SUBMIT_ACTION_HINTS.some((hint) => text.includes(hint));
}

function normalizeNodeText(value) {
  return `${value || ''}`.replace(/\s+/g, ' ').trim().toLowerCase();
}

function controlHintText(element) {
  return normalizeNodeText([
    element?.innerText,
    element?.textContent,
    element?.value,
    element?.getAttribute?.('aria-label'),
    element?.getAttribute?.('title'),
    element?.getAttribute?.('name'),
    element?.getAttribute?.('id'),
    element?.getAttribute?.('class'),
    element?.getAttribute?.('data-testid'),
  ].filter(Boolean).join(' '));
}

function findSubmitButton(emailInput, passwordInput) {
  const words = ['log in', 'login', 'sign in', 'continue', 'submit'];

  for (const root of findStepContainer(passwordInput, emailInput)) {
    const candidates = collectActionCandidates(root);
    if (!candidates.length) continue;

    const filteredCandidates = candidates.filter((button) => !isNonSubmitAction(button));
    if (!filteredCandidates.length) continue;

    const primaryCandidates = filteredCandidates.filter((button) => {
      const tagName = `${button.tagName || ''}`.toLowerCase();
      return tagName === 'button' || (tagName === 'input' && `${button.type || ''}`.toLowerCase() === 'submit');
    });
    const rankedCandidates = primaryCandidates.length ? primaryCandidates : filteredCandidates;

    const exactMatch = rankedCandidates.find((button) => {
      const text = buttonText(button);
      return text === 'log in' || text === 'login' || text === 'sign in' || text === 'continue';
    });
    if (exactMatch) return exactMatch;

    const wordMatch = rankedCandidates.find((button) => words.some((word) => buttonText(button).includes(word)));
    if (wordMatch) return wordMatch;

    const submitMatch = rankedCandidates.find((button) => button.type === 'submit');
    if (submitMatch) return submitMatch;
  }

  return null;
}

function collectPasswordFieldScopes(passwordInput) {
  return findStepContainer(passwordInput)
    .filter(Boolean)
    .filter((root, index, items) => items.indexOf(root) === index);
}

function isNearPasswordInput(passwordInput, element) {
  if (!passwordInput || !element || passwordInput === element) return false;
  const inputRect = passwordInput.getBoundingClientRect();
  const elementRect = element.getBoundingClientRect();
  const horizontalDistance = Math.min(
    Math.abs(elementRect.left - inputRect.right),
    Math.abs(inputRect.left - elementRect.right),
    Math.abs(elementRect.left - inputRect.left),
    Math.abs(elementRect.right - inputRect.right)
  );
  const verticalDistance = Math.min(
    Math.abs(elementRect.top - inputRect.bottom),
    Math.abs(inputRect.top - elementRect.bottom),
    Math.abs(elementRect.top - inputRect.top),
    Math.abs(elementRect.bottom - inputRect.bottom)
  );
  return horizontalDistance <= 120 && verticalDistance <= 48;
}

function enforcePasswordMask(passwordInput) {
  if (!passwordInput) return;
  try {
    passwordInput.type = 'password';
    passwordInput.setAttribute('type', 'password');
  } catch {}
}

function blockPasswordToggleEvent(event, passwordInput) {
  enforcePasswordMask(passwordInput);
  event.preventDefault();
  event.stopImmediatePropagation();
  event.stopPropagation();
}

function findPasswordToggleCandidates(passwordInput) {
  const roots = collectPasswordFieldScopes(passwordInput);
  const rawCandidates = roots.flatMap((root) =>
    Array.from(root.querySelectorAll('button, [role="button"], [tabindex], [aria-label], [title], svg, img, span, div'))
  );

  return Array.from(new Set(rawCandidates))
    .map((element) => element.closest?.('button, [role="button"], [tabindex]') || element)
    .filter((element) => element && element !== passwordInput && !element.contains(passwordInput) && !passwordInput.contains(element))
    .filter((element) => {
      const hints = controlHintText(element);
      const hasSubjectHint = PASSWORD_REVEAL_SUBJECT_HINTS.some((hint) => hints.includes(hint));
      const hasActionHint = PASSWORD_REVEAL_ACTION_HINTS.some((hint) => hints.includes(hint));
      const hasIconHint = PASSWORD_REVEAL_ICON_HINTS.some((hint) => hints.includes(hint));
      const classHints = normalizeNodeText(`${element.className || ''}`);
      const hasIconChild = Boolean(element.querySelector?.('svg, img'));
      const looksLikeEye = hasIconChild || /eye|visibility|show|hide|view/.test(classHints);

      return (hasSubjectHint && (hasActionHint || hasIconHint))
        || (isNearPasswordInput(passwordInput, element) && (hasIconHint || looksLikeEye));
    });
}

function findPasswordToggleFromTarget(target, passwordInput) {
  if (!target || !passwordInput) return null;

  const path = typeof target.composedPath === 'function' ? target.composedPath() : [];
  const pathElements = path.filter((node) => node?.nodeType === Node.ELEMENT_NODE);
  const ancestors = [];
  let current = target?.nodeType === Node.ELEMENT_NODE ? target : target?.parentElement;
  while (current && current !== document.body) {
    ancestors.push(current);
    current = current.parentElement;
  }

  const candidates = Array.from(new Set([...pathElements, ...ancestors]))
    .map((element) => element.closest?.('button, [role="button"], [tabindex]') || element);
  const knownToggles = findPasswordToggleCandidates(passwordInput);
  return candidates.find((element) => knownToggles.includes(element)) || null;
}

function ensurePasswordRevealGuard() {
  if (STATE.passwordRevealGuardAttached) return;
  STATE.passwordRevealGuardAttached = true;

  ['click', 'mousedown', 'mouseup', 'pointerdown', 'pointerup', 'touchstart', 'touchend', 'keydown', 'keyup']
    .forEach((eventName) => {
      document.addEventListener(eventName, (event) => {
        const passwordInput = findInput(PASSWORD_SELECTORS);
        if (!passwordInput) return;
        const toggle = findPasswordToggleFromTarget(event.target, passwordInput);
        if (!toggle) return;
        blockPasswordToggleEvent(event, passwordInput);
      }, true);
    });
}

function lockPasswordVisibility(passwordInput) {
  if (!passwordInput) return;
  enforcePasswordMask(passwordInput);
  ensurePasswordRevealGuard();

  findPasswordToggleCandidates(passwordInput).forEach((toggle) => {
    if (!toggle || toggle.dataset.rmwPasswordToggleLocked === '1') return;

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

    const blockToggle = (event) => blockPasswordToggleEvent(event, passwordInput);
    ['click', 'mousedown', 'mouseup', 'pointerdown', 'pointerup', 'touchstart', 'touchend', 'keydown', 'keyup']
      .forEach((eventName) => toggle.addEventListener(eventName, blockToggle, true));
  });
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
  passwordInput.addEventListener('dragstart', blockEvent, true);
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

function isPasswordStepSubmitAction(element) {
  if (!element) return false;

  const action = element.closest?.(ACTION_SELECTORS.join(','));
  if (!action || isDisabled(action) || !isVisible(action) || isThirdPartyAuthAction(action)) {
    return false;
  }

  const passwordInput = findInput(PASSWORD_SELECTORS);
  if (!passwordInput) return false;

  const emailInput = findInput(EMAIL_SELECTORS);
  const expectedSubmit = findSubmitButton(emailInput, passwordInput);
  if (expectedSubmit && (action === expectedSubmit || expectedSubmit.contains?.(action) || action.contains?.(expectedSubmit))) {
    return true;
  }

  const text = normalizeNodeText(
    action.innerText
      || action.textContent
      || action.value
      || action.getAttribute?.('aria-label')
      || ''
  );
  return text === 'sign in' || text === 'log in' || text === 'login';
}

function markPasswordSubmissionPending() {
  if (STATE.passwordSubmitPendingUntil > Date.now()) {
    return;
  }
  STATE.passwordSubmitAttempts += 1;
  STATE.passwordSubmitPendingUntil = Date.now() + PASSWORD_SUBMIT_PENDING_MS;
  persistPasswordSubmitState();
  setStatus('Waiting for Grammarly sign-in');
}

function ensurePasswordSubmitGuard() {
  if (STATE.passwordSubmitGuardAttached) return;
  STATE.passwordSubmitGuardAttached = true;

  document.addEventListener('click', (event) => {
    if (isPasswordStepSubmitAction(event.target)) {
      markPasswordSubmissionPending();
    }
  }, true);

  document.addEventListener('submit', (event) => {
    const form = event.target;
    if (!(form instanceof HTMLFormElement)) return;
    const passwordInput = findInput(PASSWORD_SELECTORS);
    if (passwordInput && form.contains(passwordInput)) {
      markPasswordSubmissionPending();
    }
  }, true);
}

function clickElement(element) {
  if (!element || isDisabled(element) || !isVisible(element)) return false;
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

function submitCurrentStep(button, fallbackInput) {
  if (button && clickElement(button)) {
    return true;
  }
  return pressEnter(fallbackInput);
}

function findLandingLoginAction() {
  const candidates = Array.from(document.querySelectorAll(ACTION_SELECTORS.join(',')))
    .filter((element) => !isDisabled(element) && isVisible(element));

  return candidates.find((element) => {
    if (isThirdPartyAuthAction(element) || isNonSubmitAction(element)) return false;

    const text = buttonText(element);
    if (
      text.includes('log in')
      || text.includes('login')
      || text.includes('sign in')
      || text.includes('continue with email')
      || text === 'email'
    ) {
      return true;
    }

    const href = `${element.getAttribute?.('href') || ''}`.toLowerCase();
    return href.includes('/signin') || href.includes('/sign-in') || href.includes('/login');
  }) || null;
}

function looksLikeAuthenticatedWorkspace() {
  const host = window.location.hostname.toLowerCase();
  if (host === 'app.grammarly.com') {
    return !findInput(EMAIL_SELECTORS) && !findInput(PASSWORD_SELECTORS);
  }
  return false;
}

function isLoginPage() {
  const path = window.location.pathname.toLowerCase();
  return path.includes('/signin')
    || path.includes('/sign-in')
    || path.includes('/login')
    || Boolean(findInput(EMAIL_SELECTORS))
    || Boolean(findInput(PASSWORD_SELECTORS))
    || Boolean(findLandingLoginAction());
}

async function loadLaunchState() {
  const directTicket = captureLaunchTicketFromHash() || getStoredLaunchTicket();
  if (directTicket) {
    const activation = await sendRuntimeMessage({
      type: 'TOOL_HUB_ACTIVATE_LAUNCH',
      toolSlug: TOOL_SLUG,
      hostname: window.location.hostname,
      pageUrl: window.location.href,
      extensionTicket: directTicket,
    });

    if (activation?.ok && activation.authorized) {
      clearStoredLaunchTicket();
      STATE.launchChecked = true;
      STATE.launchAuthorized = true;
      STATE.launchPrepared = Boolean(activation.prepared);
      STATE.launchExpiresAt = Number(activation.expiresAt || 0);
      return;
    }

    clearStoredLaunchTicket();
  }

  const response = await sendRuntimeMessage({
    type: 'TOOL_HUB_GET_LAUNCH_STATE',
    toolSlug: TOOL_SLUG,
    hostname: window.location.hostname,
    pageUrl: window.location.href,
  });

  STATE.launchChecked = true;
  STATE.launchAuthorized = Boolean(response?.ok && response.authorized);
  STATE.launchPrepared = Boolean(response?.ok && response.authorized && response.prepared);
  STATE.launchExpiresAt = Number(response?.ok && response.authorized ? response.expiresAt || 0 : 0);
}

async function clearToolSession(options = {}) {
  clearPageStorage();
  await sendRuntimeMessage({
    type: 'TOOL_HUB_CLEAR_TOOL_SESSION',
    toolSlug: TOOL_SLUG,
    preserveLaunch: Boolean(options.preserveLaunch),
  });
}

async function enforceDashboardOnlyAccess() {
  const alreadyNotified = window.sessionStorage.getItem(BLOCKED_NOTICE_KEY) === '1';
  if (!isLoginPage()) {
    await clearToolSession();
    window.sessionStorage.setItem(BLOCKED_NOTICE_KEY, '1');
    window.location.replace(LOGIN_URL);
    return false;
  }

  if (!alreadyNotified) {
    window.sessionStorage.setItem(BLOCKED_NOTICE_KEY, '1');
  }

  setStatus('Launch this tool from the dashboard first');
  STATE.settled = true;
  return false;
}

async function ensureFreshLaunchSession() {
  const launchKey = `${STATE.launchExpiresAt || 0}`;
  if (!launchKey || launchKey === '0') {
    return false;
  }

  if (STATE.launchPrepared) {
    return true;
  }

  await clearToolSession({ preserveLaunch: true });
  const preparedResponse = await sendRuntimeMessage({
    type: 'TOOL_HUB_MARK_FRESH_SESSION_PREPARED',
    toolSlug: TOOL_SLUG,
  });
  if (preparedResponse?.ok) {
    STATE.launchPrepared = true;
  }
  try {
    window.sessionStorage.setItem(PREPARED_LAUNCH_KEY, launchKey);
  } catch {}
  try {
    window.localStorage.setItem(PREPARED_LAUNCH_KEY, launchKey);
  } catch {}
  window.sessionStorage.removeItem(BLOCKED_NOTICE_KEY);
  setStatus('Preparing fresh Grammarly session');

  if (window.location.href !== LOGIN_URL) {
    window.location.replace(LOGIN_URL);
    return false;
  }

  window.location.reload();
  return false;
}

async function revokeDashboardLaunch() {
  const response = await sendRuntimeMessage({
    type: 'TOOL_HUB_REVOKE_ACTIVE_LAUNCH',
    toolSlug: TOOL_SLUG,
  });
  if (response?.ok) {
    STATE.launchAuthorized = false;
    STATE.launchPrepared = false;
    STATE.launchExpiresAt = 0;
  }
  return Boolean(response?.ok);
}

function finalizeAutofill(message, { revokeLaunch = true } = {}) {
  clearPasswordSubmitState();
  STATE.settled = true;
  releasePasswordSavingSuppressed(0);
  setStatus(message);
  if (revokeLaunch) {
    revokeDashboardLaunch().catch(() => {});
  }
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
      extensionTicket: getStoredLaunchTicket(),
    },
    (response) => {
      STATE.requested = false;

      if (chrome.runtime.lastError) {
        setStatus(`Extension error: ${chrome.runtime.lastError.message}`);
        STATE.settled = true;
        return;
      }

      if (!response?.ok) {
        if ((response?.error || '').toLowerCase().includes('launch this tool from the dashboard first')) {
          clearStoredLaunchTicket();
        }
        setStatus(response?.error || 'Credential unavailable');
        return;
      }

      clearStoredLaunchTicket();
      STATE.credential = response.data?.credential || null;
      setStatus(STATE.credential ? 'Credential loaded' : 'Credential missing');
      scheduleAttempt(150);
    }
  );
}

function attemptLandingLogin() {
  const emailInput = findInput(EMAIL_SELECTORS);
  const passwordInput = findInput(PASSWORD_SELECTORS);
  if (emailInput || passwordInput) return false;
  if (STATE.loginOpenAttempts >= 2) return false;

  const action = findLandingLoginAction();
  if (!action) return false;

  const now = Date.now();
  if (now - STATE.lastLoginOpenAt > 3500) {
    STATE.lastLoginOpenAt = now;
    STATE.loginOpenAttempts += 1;
    setStatus('Opening login prompt');
    window.setTimeout(() => clickElement(action), 250);
  }
  return true;
}

function looksSignedInAfterSubmit() {
  if (!STATE.lastSubmitAt) return false;
  if (Date.now() - STATE.lastSubmitAt < 1500) return false;
  if (isLoginPage()) return false;
  if (findInput(EMAIL_SELECTORS) || findInput(PASSWORD_SELECTORS)) return false;
  return true;
}

function attemptFill() {
  if (STATE.settled) return;
  if (!STATE.launchChecked) {
    setStatus('Checking dashboard launch');
    return;
  }
  if (!STATE.launchAuthorized) {
    scheduleAsyncStep(enforceDashboardOnlyAccess);
    return;
  }
  if (STATE.launchExpiresAt && !STATE.launchPrepared) {
    scheduleAsyncStep(ensureFreshLaunchSession);
    return;
  }

  if (looksLikeAuthenticatedWorkspace()) {
    finalizeAutofill('Signed in successfully');
    return;
  }

  const emailInput = findInput(EMAIL_SELECTORS);
  const passwordInput = findInput(PASSWORD_SELECTORS);

  if (passwordInput) {
    lockPasswordVisibility(passwordInput);
    protectPasswordField(passwordInput);
  }

  if (looksSignedInAfterSubmit()) {
    finalizeAutofill('Signed in successfully');
    return;
  }

  if (STATE.passwordSubmitPendingUntil > Date.now()) {
    if (passwordInput || emailInput) {
      setStatus('Waiting for Grammarly sign-in');
      return;
    }
    STATE.passwordSubmitPendingUntil = 0;
    persistPasswordSubmitState();
  } else if (STATE.passwordSubmitPendingUntil) {
    STATE.passwordSubmitPendingUntil = 0;
    persistPasswordSubmitState();
    if (emailInput || passwordInput || findLandingLoginAction()) {
      finalizeAutofill('Grammarly returned to sign-in. Check the credential or continue manually.');
      return;
    }
  }

  if (!STATE.credential?.loginIdentifier || !STATE.credential?.password) {
    if (emailInput || passwordInput || findLandingLoginAction()) {
      requestCredential();
    }

    if (!emailInput && !passwordInput && !attemptLandingLogin()) {
      setStatus('Waiting for Grammarly login field');
    }
    return;
  }

  if (emailInput && emailInput.value !== STATE.credential.loginIdentifier) {
    emailInput.focus();
    setInputValue(emailInput, STATE.credential.loginIdentifier);
    STATE.lastEmailFilledAt = Date.now();
  }

  if (!passwordInput) {
    if (!emailInput) {
      if (!attemptLandingLogin()) {
        setStatus('Waiting for Grammarly login field');
      }
      return;
    }

    const now = Date.now();
    const continueButton = findSubmitButton(emailInput, null);
    if (!continueButton) {
      setStatus('Email filled, waiting for password step');
      return;
    }

    if (now - STATE.lastSubmitAt > 3000) {
      if (STATE.lastEmailFilledAt && now - STATE.lastEmailFilledAt < FIELD_SETTLE_DELAY_MS) {
        setStatus('Email filled, waiting to continue');
        return;
      }
      STATE.lastSubmitAt = now;
      setStatus('Email filled, continuing');
      window.setTimeout(() => submitCurrentStep(continueButton, emailInput), 300);
      return;
    }

    setStatus('Waiting for password step');
    return;
  }

  if (passwordInput.value !== STATE.credential.password) {
    if (!STATE.passwordSavingSuppressed) {
      requestPasswordSavingSuppression();
      return;
    }
    passwordInput.focus();
    setInputValue(passwordInput, STATE.credential.password);
    STATE.lastPasswordFilledAt = Date.now();
  }

  const readyForSubmit = (!emailInput || emailInput.value) && passwordInput.value;
  if (!readyForSubmit) {
    setStatus('Waiting for credential fields');
    return;
  }

  const now = Date.now();
  const submitButton = findSubmitButton(emailInput, passwordInput);
  if (STATE.lastPasswordFilledAt && now - STATE.lastPasswordFilledAt < FIELD_SETTLE_DELAY_MS) {
    setStatus('Password filled, waiting to sign in');
    return;
  }
  if (STATE.passwordSubmitAttempts >= MAX_PASSWORD_SUBMIT_ATTEMPTS) {
    finalizeAutofill('Grammarly sign-in already attempted. Continue manually.');
    return;
  }
  if (now - STATE.lastSubmitAt > 3000) {
    STATE.lastSubmitAt = now;
    markPasswordSubmissionPending();
    setStatus('Credential filled, signing in');
    window.setTimeout(() => {
      submitCurrentStep(submitButton, passwordInput || emailInput);
      releasePasswordSavingSuppressed(PASSWORD_PROMPT_RESTORE_DELAY_MS);
    }, 350);
    return;
  }

  setStatus('Credential filled');
}

function scheduleAsyncStep(task) {
  if (STATE.settled) return;
  STATE.settled = true;
  Promise.resolve()
    .then(task)
    .catch((error) => {
      setStatus(`Session check failed: ${error?.message || 'Unknown error'}`);
      releasePasswordSavingSuppressed(0);
    });
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
  ensurePasswordSubmitGuard();
  syncPasswordSubmitStateFromStorage();
  captureLaunchTicketFromHash();
  STATE.observer = new MutationObserver(() => handleMutations());
  STATE.observer.observe(document.body || document.documentElement, { childList: true, subtree: true });
  STATE.keepAliveTimer = window.setInterval(() => scheduleAttempt(0), KEEP_ALIVE_MS);
  loadLaunchState()
    .catch(() => {
      STATE.launchChecked = true;
      STATE.launchAuthorized = false;
      STATE.launchExpiresAt = 0;
    })
    .finally(() => {
      STATE.settled = false;
      scheduleAttempt(0);
    });
}

start();
