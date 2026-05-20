const TOOL_SLUG = 'genspark';
const PREPARED_LAUNCH_KEY = 'rmw_genspark_prepared_launch';
const BLOCKED_NOTICE_KEY = 'rmw_genspark_blocked_notice';
const EXTENSION_TICKET_KEY = 'rmw_extension_ticket';

const MIN_RUN_GAP_MS = 500;
const KEEP_ALIVE_MS = 2500;
const ACTION_COOLDOWN_MS = 1800;
const SUBMIT_COOLDOWN_MS = 5000;
const PASSWORD_PROMPT_RESTORE_DELAY_MS = 8000;
const AUTHENTICATED_CONFIRM_MS = 1500;

const EMAIL_SELECTORS = [
  'input[type="email"]',
  'input[name="email"]',
  'input[id*="email"]',
  'input[name*="email"]',
  'input[autocomplete="username"]',
  'input[autocomplete="email"]',
  'input[placeholder*="email" i]',
  'input[aria-label*="email" i]',
].join(',');

const PASSWORD_SELECTORS = [
  'input[type="password"]',
  'input[name="password"]',
  'input[id*="password"]',
  'input[name*="password"]',
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

const BROAD_ACTION_SELECTORS = [
  ACTION_SELECTORS,
  '[tabindex]',
  '[onclick]',
  '[aria-label]',
  '[data-testid]',
  '[class*="button"]',
  '[class*="btn"]',
  '[class*="login"]',
  '[class*="sign"]',
].join(',');

const STATE = {
  status: 'Waiting for Genspark',
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
  authenticatedSeenAt: 0,
  passwordSavingInFlight: false,
  passwordSavingSuppressed: false,
  passwordSavingRestoreTimer: null,
  upgradeDialogCache: { at: 0, dialog: null },
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
  badge.textContent = `Genspark auto-login\n${STATE.status}`;
  (document.body || document.documentElement).appendChild(badge);
  return badge;
}

function setStatus(message) {
  if (STATE.status === message) return;
  STATE.status = message;
  ensureStatusBadge().textContent = `Genspark auto-login\n${message}`;
  console.debug('[RMW Genspark Auto Login]', message);
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
  releasePasswordSavingSuppressed(0);
  setStatus(message);
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
  if (STATE.passwordSavingSuppressed || STATE.passwordSavingInFlight) return;

  STATE.passwordSavingInFlight = true;
  setStatus('Disabling Chrome password-save prompt');

  ensurePasswordSavingSuppressed()
    .then((ok) => {
      STATE.passwordSavingInFlight = false;
      if (!ok) {
        stop('Blocked: Chrome password-save prompt could not be disabled.');
        return;
      }
      scheduleAttempt(50);
    })
    .catch((error) => {
      STATE.passwordSavingInFlight = false;
      stop(`Blocked: ${error?.message || 'Could not disable Chrome password-save prompt.'}`);
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
    if (ticket) {
      window.sessionStorage.setItem(EXTENSION_TICKET_KEY, ticket);
    } else {
      window.sessionStorage.removeItem(EXTENSION_TICKET_KEY);
    }
  } catch {}
}

function clearStoredLaunchTicket() {
  try {
    window.sessionStorage.removeItem(EXTENSION_TICKET_KEY);
  } catch {}
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

function hasLocalLaunchEvidence() {
  return Boolean(readLaunchTicketFromUrl() || getStoredLaunchTicket());
}

function captureLaunchTicket() {
  const ticket = readLaunchTicketFromUrl();
  if (!ticket) {
    return '';
  }

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
  const launchTicket = captureLaunchTicket() || getStoredLaunchTicket();
  if (launchTicket) {
    const activation = await sendRuntimeMessage({
      type: 'TOOL_HUB_ACTIVATE_LAUNCH',
      toolSlug: TOOL_SLUG,
      hostname: window.location.hostname,
      pageUrl: window.location.href,
      extensionTicket: launchTicket,
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
    element?.getAttribute?.('jsname'),
  ].filter(Boolean).join(' '));
}

function textSnippet(element, maxLength = 500) {
  return normalizeText(`${element?.textContent || ''}`.slice(0, maxLength));
}

function isUpgradeOrBillingAction(element) {
  const normalizedText = normalizeText(`${actionText(element)} ${controlHintText(element)} ${element?.getAttribute?.('href') || ''}`);
  const ownText = actionText(element);
  if (['sign in', 'sign up', 'login', 'log in'].includes(ownText)
    || normalizedText.includes('sign in')
    || normalizedText.includes('login')) {
    return false;
  }

  const containerText = textSnippet(
    element?.closest?.('[role="dialog"], [aria-modal="true"], dialog, section, article, main')
      || element?.parentElement,
    700
  );
  const text = `${normalizedText} ${containerText}`;
  return [
    'upgrade',
    'pricing',
    'subscribe',
    'subscription',
    'billing',
    'payment',
    'checkout',
    'buy credits',
    'buy plan',
    'get pro',
    'go pro',
    'pro plan',
    'premium',
    'get started - save',
    'save 20%',
    'credits / month',
    'credits/month',
    'billed annually',
    'professional workspace',
  ].some((blockedText) => text.includes(blockedText));
}

function findUpgradeDialog() {
  const now = Date.now();
  if (now - STATE.upgradeDialogCache.at < 700) {
    const cached = STATE.upgradeDialogCache.dialog;
    if (!cached || document.documentElement.contains(cached)) return cached;
  }

  const matches = Array.from(document.querySelectorAll('[role="dialog"], [aria-modal="true"], dialog'))
    .filter((element) => {
      if (!isVisible(element)) return false;
      const text = textSnippet(element, 1200);
      return text.includes('upgrade your plan')
        || (text.includes('credits / month') && text.includes('get started'))
        || (text.includes('billed annually') && text.includes('professional workspace'));
    });

  const dialog = matches
    .sort((left, right) => {
      const leftRect = left.getBoundingClientRect();
      const rightRect = right.getBoundingClientRect();
      return (leftRect.width * leftRect.height) - (rightRect.width * rightRect.height);
    })[0] || null;

  STATE.upgradeDialogCache = { at: now, dialog };
  return dialog;
}

function isInsideUpgradeDialog(element, dialog = findUpgradeDialog()) {
  return Boolean(dialog && element && (dialog === element || dialog.contains(element)));
}

function dismissUpgradeDialog() {
  const dialog = findUpgradeDialog();
  if (!dialog) return false;

  let closeAction = Array.from(dialog.querySelectorAll(ACTION_SELECTORS))
    .filter((element) => isVisible(element) && !isDisabled(element))
    .find((element) => {
      const text = actionText(element);
      const hints = controlHintText(element);
      return text === '×'
        || text === 'x'
        || text === 'close'
        || hints.includes('close')
        || hints.includes('dismiss');
    });

  if (!closeAction) {
    const dialogRect = dialog.getBoundingClientRect();
    closeAction = Array.from(dialog.querySelectorAll('button, [role="button"], [tabindex], div, span'))
      .map((element) => findClickableAncestor(element))
      .filter((element) => element && isVisible(element) && !isDisabled(element))
      .sort((left, right) => {
        const leftRect = left.getBoundingClientRect();
        const rightRect = right.getBoundingClientRect();
        const leftScore = Math.abs(leftRect.right - dialogRect.right) + Math.abs(leftRect.top - dialogRect.top);
        const rightScore = Math.abs(rightRect.right - dialogRect.right) + Math.abs(rightRect.top - dialogRect.top);
        return leftScore - rightScore;
      })[0] || null;
  }

  if (!closeAction || !canActNow()) return true;

  markActionTaken();
  setStatus('Closing Genspark upgrade prompt');
  clickElement(closeAction);
  scheduleAttempt(500);
  return true;
}

function collectActionCandidates(root = document) {
  const upgradeDialog = findUpgradeDialog();
  return Array.from(root.querySelectorAll(ACTION_SELECTORS))
    .filter((element) => isVisible(element)
      && !isDisabled(element)
      && !isInsideUpgradeDialog(element, upgradeDialog)
      && !isUpgradeOrBillingAction(element));
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
  const upgradeDialog = findUpgradeDialog();
  const textNodes = Array.from(document.querySelectorAll(BROAD_ACTION_SELECTORS))
    .map((element) => findClickableAncestor(element));
  return Array.from(new Set([
    ...collectActionCandidates(),
    ...textNodes.filter(Boolean),
  ])).filter((element) => isVisible(element)
    && !isDisabled(element)
      && !isInsideUpgradeDialog(element, upgradeDialog)
      && !isUpgradeOrBillingAction(element));
}

function rootContains(root, element) {
  return root === document || root.contains(element);
}

function hasVisibleSignedOutAction() {
  const directSignedOutAction = Array.from(document.querySelectorAll([
    ACTION_SELECTORS,
    '[tabindex]',
    '[onclick]',
    '[aria-label]',
    '[data-testid]',
    'div',
    'span',
  ].join(','))).some((element) => {
    if (!isVisible(element) || isDisabled(element)) return false;
    const text = normalizeText(element.textContent || element.getAttribute?.('aria-label') || '');
    return text === 'sign in'
      || text === 'sign up'
      || text === 'login'
      || text === 'log in';
  });
  if (directSignedOutAction) return true;

  return collectBroadActionCandidates().some((element) => {
    const text = actionText(element);
    const hints = controlHintText(element);
    return text === 'sign in'
      || text === 'sign up'
      || text === 'login'
      || text === 'log in'
      || hints.includes('sign in')
      || hints.includes('sign up')
      || hints.includes('login');
  });
}

function hasAuthenticatedWorkspaceSignal(pageText) {
  return pageText.includes('upgrade plan')
    || pageText.includes('business edition')
    || pageText.includes('sign out')
    || Boolean(document.querySelector([
      '[aria-label*="account" i]',
      '[aria-label*="profile" i]',
      '[data-testid*="user" i]',
      '[data-testid*="avatar" i]',
    ].join(',')));
}

function isAuthenticatedGensparkPage() {
  const host = window.location.hostname;
  if (!host.includes('genspark.ai') || host === 'login.genspark.ai') return false;
  if (findInput(EMAIL_SELECTORS) || findInput(PASSWORD_SELECTORS)) return false;

  const path = normalizeText(window.location.pathname || '');
  if (path.includes('login') || path.includes('signin') || path.includes('sign-in') || path.includes('auth')) {
    return false;
  }

  const pageText = textSnippet(document.body || document.documentElement, 8000);
  const hasAuthPrompt = pageText.includes('login with email')
    || pageText.includes('continue with google')
    || pageText.includes('sign in or sign up')
    || pageText.includes('sign in sign up')
    || pageText.includes('sign up sign in');
  if (pageText.includes('sign in') && pageText.includes('sign up')) return false;
  if (hasVisibleSignedOutAction()) return false;
  if (!hasAuthPrompt && hasAuthenticatedWorkspaceSignal(pageText)) return true;

  const hasWorkspaceSignal = pageText.includes('new chat')
    || pageText.includes('library')
    || pageText.includes('genspark ai workspace')
    || pageText.includes('ask anything, create anything')
    || (pageText.includes('ai slides') && pageText.includes('ai sheets') && pageText.includes('ai docs'))
    || Boolean(document.querySelector('[aria-label*="account" i], [aria-label*="profile" i], [data-testid*="user" i], [data-testid*="avatar" i]'));

  return hasWorkspaceSignal && !hasAuthPrompt;
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

function supportsRegexpVFlag() {
  try {
    new RegExp('', 'v');
    return true;
  } catch {
    return false;
  }
}

function isGensparkAuthContinuationPage() {
  return window.location.hostname === 'login.genspark.ai'
    && /onmicrosoft\.com|oauth2|authorize/i.test(window.location.href);
}

function dispatchSyntheticClick(element) {
  try {
    const rect = element.getBoundingClientRect();
    element.dispatchEvent(new MouseEvent('click', {
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

function disableInvalidInputPatterns(root = document, options = {}) {
  let removed = 0;
  try {
    Array.from(root.querySelectorAll?.('input[pattern]') || []).forEach((input) => {
      const pattern = input.getAttribute('pattern');
      if (!pattern) return;

      if (options.removeAll) {
        input.dataset.rmwOriginalPattern = pattern;
        input.removeAttribute('pattern');
        removed += 1;
        return;
      }

      try {
        // Chrome validates input[pattern] during native clicks/submits. Some
        // third-party auth pages ship patterns that throw before our click
        // fallback can run, so remove only patterns the browser rejects.
        if (supportsRegexpVFlag()) {
          new RegExp(`^(?:${pattern})$`, 'v');
        } else {
          new RegExp(`^(?:${pattern})$`);
        }
      } catch {
        input.dataset.rmwOriginalPattern = pattern;
        input.removeAttribute('pattern');
        removed += 1;
      }
    });
  } catch {}
  return removed;
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

  const isAuthContinuation = isGensparkAuthContinuationPage();
  const removedPatterns = disableInvalidInputPatterns(document, { removeAll: isAuthContinuation });
  dispatchMouseSequence(resolvedTarget);

  if (isAuthContinuation || removedPatterns > 0) {
    return dispatchSyntheticClick(resolvedTarget);
  }

  try {
    resolvedTarget.click();
    return true;
  } catch {
    return dispatchSyntheticClick(resolvedTarget);
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

function getAuthRoots() {
  const roots = [];
  const visibleDialogs = Array.from(document.querySelectorAll('[role="dialog"], [aria-modal="true"], dialog'))
    .filter((element) => isVisible(element));
  roots.push(...visibleDialogs);

  const authSections = Array.from(document.querySelectorAll('main, form, section, article'))
    .filter((element) => {
      if (!isVisible(element)) return false;
      const text = textSnippet(element, 1200);
      return (
        text.includes('sign in or sign up')
        || text.includes('continue with google')
        || text.includes('login with email')
        || text.includes('genspark ai workspace')
      );
    });
  roots.push(...authSections);

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
        && !text.includes('microsoft')
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
      disableInvalidInputPatterns(form);
      if (typeof form.requestSubmit === 'function') form.requestSubmit();
      else form.submit?.();
      return true;
    } catch {}
  }
  return false;
}

function findSignInOpenAction() {
  const candidates = collectBroadActionCandidates();
  const exactMatches = candidates.filter((element) => {
    const text = actionText(element);
    const hints = controlHintText(element);
    return text === 'sign in'
      || (text.includes('sign in') && !text.includes('sign up') && hints.includes('sign in'));
  });
  if (exactMatches.length) {
    return exactMatches.sort((left, right) => {
      const leftRect = left.getBoundingClientRect();
      const rightRect = right.getBoundingClientRect();
      if (Math.abs(leftRect.top - rightRect.top) > 24) return leftRect.top - rightRect.top;
      return rightRect.right - leftRect.right;
    })[0];
  }

  const broadMatch = candidates.find((element) => {
    const text = actionText(element);
    const href = normalizeText(element.getAttribute?.('href') || '');
    const hints = controlHintText(element);
    return (
      (text === 'sign in' || text === 'login' || text === 'log in' || text.includes('sign in'))
      && !text.includes('google')
      && !text.includes('microsoft')
      && !text.includes('apple')
      && !text.includes('email')
      && !text.includes('more options')
    )
      || href.includes('login.genspark.ai')
      || (hints.includes('sign in') && !hints.includes('google') && !hints.includes('apple'))
      || (hints.includes('login') && hints.includes('genspark'));
  });
  if (broadMatch) return broadMatch;

  return candidates.find((element) => {
    const text = actionText(element);
    const hints = controlHintText(element);
    return (text.includes('sign in') || text.includes('login'))
      && !text.includes('google')
      && !text.includes('apple')
      && !text.includes('email')
      && !text.includes('more options')
      && !hints.includes('sign up');
  }) || null;
}

function findVisibleActionByExactText(...labels) {
  const normalizedLabels = labels.map((label) => normalizeText(label)).filter(Boolean);
  return Array.from(document.querySelectorAll([
    ACTION_SELECTORS,
    '[tabindex]',
    '[onclick]',
    '[aria-label]',
    '[data-testid]',
    '[class*="button"]',
    '[class*="btn"]',
    '[class*="login"]',
    '[class*="sign"]',
    'div',
    'span',
  ].join(',')))
    .map((element) => findClickableAncestor(element) || element)
    .find((element) => {
      if (!element || !isVisible(element) || isDisabled(element)) return false;
      const text = actionText(element) || normalizeText(element.textContent || element.getAttribute?.('aria-label') || '');
      if (!normalizedLabels.includes(text)) return false;
      const rect = element.getBoundingClientRect();
      return rect.top < Math.max(window.innerHeight, 1) * 0.35;
    }) || null;
}

function findVisibleActionByExactTextAnywhere(...labels) {
  const normalizedLabels = labels.map((label) => normalizeText(label)).filter(Boolean);
  return Array.from(document.querySelectorAll([
    ACTION_SELECTORS,
    '[tabindex]',
    '[onclick]',
    '[aria-label]',
    '[data-testid]',
    '[class*="button"]',
    '[class*="btn"]',
    'div',
    'span',
  ].join(',')))
    .map((element) => findClickableAncestor(element) || element)
    .find((element) => {
      if (!element || !isVisible(element) || isDisabled(element)) return false;
      const text = actionText(element) || normalizeText(element.textContent || element.getAttribute?.('aria-label') || '');
      return normalizedLabels.includes(text);
    }) || null;
}

function findMoreOptionsAction() {
  const roots = getAuthRoots();
  const broadMatch = collectBroadActionCandidates()
    .find((element) => {
      if (!roots.some((root) => rootContains(root, element))) return false;
      const text = actionText(element);
      const hints = controlHintText(element);
      return text.includes('more options')
        || text.includes('load more')
        || text.includes('show more')
        || text.includes('more sign-in')
        || hints.includes('more options')
        || hints.includes('load more');
    });
  if (broadMatch) return broadMatch;

  const exactMatch = findVisibleActionByExactTextAnywhere('more options', 'load more', 'show more');
  if (exactMatch && roots.some((root) => rootContains(root, exactMatch))) return exactMatch;
  return null;
}

function findGoogleLoginAction() {
  const isLoginHost = window.location.hostname === 'login.genspark.ai';
  const roots = getAuthRoots();
  const candidates = collectBroadActionCandidates();

  for (const root of roots) {
    const exact = candidates.find((element) => {
      if (!rootContains(root, element)) return false;
      const text = actionText(element);
      return text === 'continue with google'
        || text === 'sign in with google'
        || text === 'login with google';
    });
    if (exact) return exact;
  }

  if (isLoginHost) {
    for (const root of roots) {
      const exactGoogle = candidates.find((element) => {
        if (!rootContains(root, element)) return false;
        const text = actionText(element);
        const hints = controlHintText(element);
        return text === 'google'
          || hints.includes('login with google')
          || hints.includes('sign in with google');
      });
      if (exactGoogle) return exactGoogle;
    }
  }

  return null;
}

function findEmailLoginAction() {
  const roots = getAuthRoots();
  const candidates = collectBroadActionCandidates();
  for (const root of roots) {
    const match = candidates.find((element) => {
      if (!rootContains(root, element)) return false;
      const text = actionText(element);
      return text.includes('login with email')
        || text.includes('continue with email')
        || text.includes('sign in with email')
        || (window.location.hostname === 'login.genspark.ai' && text === 'email');
    });
    if (match) return match;
  }

  return null;
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
      requireDirectTicket: true,
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

function attemptOpenGensparkAuth() {
  const signInAction = findSignInOpenAction() || findVisibleActionByExactText('sign in', 'login', 'log in');
  if (!signInAction) return false;
  if (!canActNow()) return true;

  markActionTaken();
  setStatus('Opening Genspark sign-in');
  clickElement(signInAction);
  scheduleAttempt(500);
  return true;
}

function attemptOpenMoreOptions() {
  const moreOptionsAction = findMoreOptionsAction();
  if (!moreOptionsAction) return false;
  if (!canActNow()) return true;

  markActionTaken();
  setStatus('Opening more sign-in options');
  clickElement(moreOptionsAction);
  scheduleAttempt(500);
  return true;
}

function attemptOpenGoogle() {
  const googleAction = findGoogleLoginAction();
  if (!googleAction) return false;
  if (!canActNow()) return true;

  markActionTaken();
  setStatus('Opening Google sign-in');
  clickElement(googleAction);
  scheduleAttempt(700);
  return true;
}

function attemptOpenEmailLogin() {
  const emailAction = findEmailLoginAction();
  if (!emailAction) return false;
  if (!canActNow()) return true;

  markActionTaken();
  setStatus('Opening email sign-in');
  clickElement(emailAction);
  scheduleAttempt(700);
  return true;
}

function attemptFlow() {
  if (isAuthenticatedGensparkPage()) {
    if (!STATE.authenticatedSeenAt) {
      STATE.authenticatedSeenAt = Date.now();
      setStatus('Checking Genspark login state');
      scheduleAttempt(AUTHENTICATED_CONFIRM_MS);
      return;
    }

    if (Date.now() - STATE.authenticatedSeenAt >= AUTHENTICATED_CONFIRM_MS) {
      stop('Genspark login complete');
      return;
    }

    scheduleAttempt(AUTHENTICATED_CONFIRM_MS - (Date.now() - STATE.authenticatedSeenAt));
    return;
  }
  STATE.authenticatedSeenAt = 0;

  if (!STATE.launchChecked) {
    setStatus('Checking launch authorization');
    return;
  }

  if (!STATE.launchAuthorized && !hasLocalLaunchEvidence()) {
    stop('Launch this tool from the dashboard first');
    return;
  }

  const emailInput = findInput(EMAIL_SELECTORS);
  const passwordInput = findInput(PASSWORD_SELECTORS);
  const hasCredentialInputs = Boolean(emailInput || passwordInput);

  if (!hasCredentialInputs && dismissUpgradeDialog()) return;

  if (!STATE.credential) {
    requestCredential();
  }

  if (!hasCredentialInputs) {
    if (attemptOpenMoreOptions()) return;
    if (attemptOpenGensparkAuth()) return;
    if (isGoogleCredential() && attemptOpenGoogle()) return;
    if (!isGoogleCredential() && attemptOpenEmailLogin()) return;

    setStatus(isGoogleCredential()
      ? 'Waiting for Genspark Google sign-in option'
      : 'Waiting for Genspark email sign-in option');
    return;
  }

  if (!STATE.credential?.loginIdentifier || (!STATE.credential?.password && !isGoogleCredential())) {
    setStatus('Waiting for credential');
    return;
  }

  if (isGoogleCredential()) {
    if (attemptOpenGoogle()) return;
    setStatus('Waiting for Google sign-in');
    return;
  }

  if (emailInput && emailInput.value !== STATE.credential.loginIdentifier) {
    emailInput.focus?.();
    setInputValue(emailInput, STATE.credential.loginIdentifier);
  }

  if (passwordInput && passwordInput.value !== STATE.credential.password) {
    if (!STATE.passwordSavingSuppressed) {
      requestPasswordSavingSuppression();
      return;
    }
    passwordInput.focus?.();
    setInputValue(passwordInput, STATE.credential.password);
  }

  if (!isReadyForSubmit(emailInput, passwordInput)) {
    setStatus('Filling Genspark login form');
    return;
  }

  if (Date.now() - STATE.lastSubmitAt < SUBMIT_COOLDOWN_MS) {
    setStatus('Waiting for Genspark sign-in');
    return;
  }

  const submitButton = findLoginSubmitButton(emailInput, passwordInput);
  STATE.lastSubmitAt = Date.now();
  setStatus('Submitting Genspark login');
  submitLogin(emailInput, passwordInput, submitButton);
  releasePasswordSavingSuppressed(PASSWORD_PROMPT_RESTORE_DELAY_MS);
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
