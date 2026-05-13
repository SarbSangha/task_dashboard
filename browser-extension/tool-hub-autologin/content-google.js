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
  passwordSubmitReadyAt: 0,
  lastPasswordSubmitAt: 0,
  googleTransitionLock: false,
  googleTransitionStartedAt: 0,
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
  passwordSavingInFlightSince: 0,
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
  passwordMaskLoopTimer: null,
  passwordTypeObserver: null,
  passwordTypeTarget: null,
  settled: false,
  status: 'Waiting for Google sign-in',
};

const MIN_RUN_GAP_MS = 900;
const KEEP_ALIVE_MS = 10000;
const STEP_PENDING_RETRY_MS = 5000;
const LAUNCH_RETRY_DELAY_MS = 10000;
const MAX_LAUNCH_RETRIES = 2;
const INPUT_SETTLE_MS = 300;
const GOOGLE_PASSWORD_SETTLE_MS = 450;
const GOOGLE_PASSWORD_STABLE_MS = 700;
const GOOGLE_PASSWORD_POST_SUBMIT_WAIT_MS = 18000;
const GOOGLE_AUTH_TRANSITION_TIMEOUT_MS = 60000;
const GOOGLE_AUTH_TRANSITION_POLL_MS = 2500;
const GOOGLE_PASSWORD_CHAR_DELAY_MIN_MS = 110;
const GOOGLE_PASSWORD_CHAR_DELAY_MAX_MS = 220;
const GOOGLE_PASSWORD_PRE_SUBMIT_PAUSE_MIN_MS = 900;
const GOOGLE_PASSWORD_PRE_SUBMIT_PAUSE_MAX_MS = 2200;
const GOOGLE_PASSWORD_RETRY_DELAY_MS = 1200;
const NEXT_BUTTON_WAIT_MS = 2500;
const NEXT_BUTTON_POLL_MS = 120;
const PASSWORD_PROMPT_RESTORE_DELAY_MS = 8000;
const RUNTIME_MESSAGE_TIMEOUT_MS = 2000;
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
  'input[name*="passwd" i]',
  'input[name*="password" i]',
  'input[id*="passwd" i]',
  'input[id*="password" i]',
  'input[autocomplete="current-password"]',
  'input[aria-label*="password" i]',
  'input[placeholder*="password" i]',
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
  void toolSlug;
  return false;
}

function shouldAggressivelyDisableGoogleRevealControls(toolSlug = STATE.toolSlug) {
  return false;
}

function isFlowTool() {
  return normalizeToolSlug(STATE.toolSlug) === 'flow';
}

function supportsGoogleAuthenticatorAutomation(toolSlug = STATE.toolSlug) {
  const normalizedToolSlug = normalizeToolSlug(toolSlug || inferToolSlugFromGooglePage());
  return normalizedToolSlug === 'flow'
    || normalizedToolSlug === 'chatgpt'
    || normalizedToolSlug === 'enhancor'
    || normalizedToolSlug === 'elevenlabs'
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
  if (normalizedToolSlug === 'elevenlabs') return 'ElevenLabs';
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
    let settled = false;
    const finish = (response) => {
      if (settled) return;
      settled = true;
      resolve(response);
    };

    const timeoutId = window.setTimeout(() => {
      finish({ ok: false, error: 'Runtime message timed out' });
    }, RUNTIME_MESSAGE_TIMEOUT_MS);

    try {
      if (!chrome?.runtime?.id || typeof chrome.runtime.sendMessage !== 'function') {
        window.clearTimeout(timeoutId);
        finish({ ok: false, error: 'Extension runtime unavailable' });
        return;
      }

      chrome.runtime.sendMessage(message, (response) => {
        window.clearTimeout(timeoutId);
        if (chrome.runtime.lastError) {
          finish({ ok: false, error: chrome.runtime.lastError.message });
          return;
        }
        finish(response || { ok: false, error: 'No response received' });
      });
    } catch (error) {
      window.clearTimeout(timeoutId);
      finish({ ok: false, error: error?.message || 'Runtime messaging failed' });
    }
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
  if (STATE.passwordSavingSuppressed || STATE.passwordSavingBypass) {
    return;
  }

  if (STATE.passwordSavingInFlight) {
    if (
      STATE.passwordSavingInFlightSince
      && Date.now() - STATE.passwordSavingInFlightSince > 4000
    ) {
      STATE.passwordSavingInFlight = false;
      STATE.passwordSavingInFlightSince = 0;
      STATE.passwordSavingBypass = true;
      setStatus('Warning: Password-save suppression timed out. Continuing anyway...');
      scheduleAttempt(50);
    }
    return;
  }

  STATE.passwordSavingInFlight = true;
  STATE.passwordSavingInFlightSince = Date.now();
  setStatus('Disabling Chrome password-save prompt...');

  ensurePasswordSavingSuppressed()
    .then((ok) => {
      STATE.passwordSavingInFlight = false;
      STATE.passwordSavingInFlightSince = 0;
      if (!ok) {
        scheduleAttempt(50);
        return;
      }
      scheduleAttempt(50);
    })
    .catch((error) => {
      STATE.passwordSavingInFlight = false;
      STATE.passwordSavingInFlightSince = 0;
      STATE.passwordSavingBypass = true;
      setStatus(`Warning: ${error?.message || 'Could not disable Chrome password-save prompt'} Continuing anyway...`);
      scheduleAttempt(50);
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

function collectQueryRoots(root = document) {
  const roots = [];
  const seen = new Set();
  const queue = [root];

  while (queue.length) {
    const currentRoot = queue.shift();
    if (!currentRoot || seen.has(currentRoot)) continue;
    seen.add(currentRoot);
    roots.push(currentRoot);

    const elements = currentRoot.querySelectorAll ? Array.from(currentRoot.querySelectorAll('*')) : [];
    elements.forEach((element) => {
      if (element?.shadowRoot && !seen.has(element.shadowRoot)) {
        queue.push(element.shadowRoot);
      }

      if (element?.tagName?.toLowerCase?.() === 'iframe') {
        try {
          const frameDoc = element.contentDocument;
          if (frameDoc && !seen.has(frameDoc)) {
            queue.push(frameDoc);
          }
        } catch {}
      }
    });
  }

  return roots;
}

function queryAllDeep(selectors) {
  const selectorList = Array.isArray(selectors) ? selectors : [selectors];
  const results = [];
  const seen = new Set();

  collectQueryRoots(document).forEach((root) => {
    selectorList.forEach((selector) => {
      if (!selector || !root.querySelectorAll) return;
      Array.from(root.querySelectorAll(selector)).forEach((element) => {
        if (!element || seen.has(element)) return;
        seen.add(element);
        results.push(element);
      });
    });
  });

  return results;
}

function findInput(selectors) {
  for (const selector of selectors) {
    const matches = queryAllDeep(selector);
    const input = matches.find((item) => !item.readOnly && !isDisabled(item) && isVisible(item));
    if (input) return input;
  }
  return null;
}

function findRelaxedVisibleInput(selectors) {
  for (const selector of selectors) {
    const matches = queryAllDeep(selector);
    const input = matches.find((item) => item && isVisible(item) && `${item.type || ''}`.trim().toLowerCase() !== 'hidden');
    if (input) return input;
  }
  return null;
}

function readReferencedNodeText(idsValue) {
  return `${idsValue || ''}`
    .trim()
    .split(/\s+/)
    .map((id) => document.getElementById(id)?.innerText || '')
    .filter(Boolean)
    .join(' ');
}

function isGooglePasswordPageLikely() {
  const currentPageText = pageText();
  return isGooglePasswordUrl()
    || Boolean(document.querySelector('#passwordNext'))
    || currentPageText.includes('enter your password')
    || currentPageText.includes('show password')
    || currentPageText.includes('forgot password');
}

function findGoogleEmailInput() {
  const direct = findInput(EMAIL_SELECTORS);
  if (direct) return direct;

  const candidates = queryAllDeep('input')
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
  const direct = findInput(PASSWORD_SELECTORS);
  if (direct) return direct;

  const relaxedDirect = findRelaxedVisibleInput(PASSWORD_SELECTORS);
  if (relaxedDirect) return relaxedDirect;

  const passwordPageLikely = isGooglePasswordPageLikely();
  if (!passwordPageLikely) return null;

  const candidates = queryAllDeep(['input', 'textarea', '[role="textbox"]'])
    .filter((input) => input && isVisible(input) && `${input.type || ''}`.trim().toLowerCase() !== 'hidden');

  const scored = candidates
    .map((input) => ({ input, score: scoreGooglePasswordCandidate(input) }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score);

  if (scored[0]?.input) return scored[0].input;
  if (candidates.length === 1) return candidates[0];
  return null;
}

function findGooglePasswordFallbackInput() {
  if (!isGooglePasswordPageLikely()) return null;

  const candidates = queryAllDeep(['input', 'textarea', '[role="textbox"]'])
    .filter((input) => input && isVisible(input) && `${input.type || ''}`.trim().toLowerCase() !== 'hidden');

  const nonIdentifierCandidates = candidates.filter((input) => {
    const descriptor = normalizeText([
      input.id,
      input.name,
      input.type,
      input.autocomplete,
      input.inputMode,
      input.getAttribute('aria-label'),
      input.getAttribute('placeholder'),
      readReferencedNodeText(input.getAttribute('aria-labelledby')),
      readReferencedNodeText(input.getAttribute('aria-describedby')),
      input.closest('form, main, section, article, div')?.innerText,
    ].filter(Boolean).join(' '));

    return !descriptor.includes('email or phone')
      && !descriptor.includes('forgot email')
      && !descriptor.includes('identifier');
  });

  if (nonIdentifierCandidates.length === 1) {
    return nonIdentifierCandidates[0];
  }

  const nearPasswordNext = nonIdentifierCandidates.find((input) => input.closest?.('#password') || input.closest?.('form'));
  return nearPasswordNext || nonIdentifierCandidates[0] || (candidates.length === 1 ? candidates[0] : null);
}

function findProtectedGooglePasswordInput() {
  return findGooglePasswordInput() || findGooglePasswordFallbackInput();
}

function getGooglePasswordFieldDebugSummary() {
  const selectorMatches = queryAllDeep(PASSWORD_SELECTORS).filter((element) => element && isVisible(element));
  const broadCandidates = queryAllDeep(['input', 'textarea', '[role="textbox"]'])
    .filter((element) => element && isVisible(element) && `${element.type || ''}`.trim().toLowerCase() !== 'hidden');

  const sample = broadCandidates.slice(0, 3).map((element) => {
    const descriptor = normalizeText([
      element.tagName,
      element.id,
      element.name,
      element.type,
      element.autocomplete,
      element.getAttribute?.('role'),
      element.getAttribute?.('aria-label'),
      element.getAttribute?.('placeholder'),
      readReferencedNodeText(element.getAttribute?.('aria-labelledby')),
      readReferencedNodeText(element.getAttribute?.('aria-describedby')),
    ].filter(Boolean).join(' '));
    return `${element.tagName.toLowerCase()}:${descriptor || 'no-desc'}:ro=${Boolean(element.readOnly)}:dis=${isDisabled(element)}`;
  }).join(' | ');

  return `pwdUrl=${isGooglePasswordUrl()} next=${Boolean(document.querySelector('#passwordNext'))} sel=${selectorMatches.length} broad=${broadCandidates.length}${sample ? ` sample=${sample}` : ''}`;
}

function scoreGooglePasswordCandidate(input) {
  if (!input) return 0;

  const descriptor = normalizeText([
    input.id,
    input.name,
    input.type,
    input.autocomplete,
    input.inputMode,
    input.getAttribute('aria-label'),
    input.getAttribute('placeholder'),
    readReferencedNodeText(input.getAttribute('aria-labelledby')),
    readReferencedNodeText(input.getAttribute('aria-describedby')),
    input.closest('form, main, section, article, div')?.innerText,
  ].filter(Boolean).join(' '));
  const passwordPageLikely = isGooglePasswordPageLikely();

  let score = 0;
  if (descriptor.includes('password')) score += 6;
  if (descriptor.includes('passwd')) score += 6;
  if (descriptor.includes('current-password')) score += 5;
  if (descriptor.includes('enter your password')) score += 8;
  if (descriptor.includes('show password')) score += 4;
  if (descriptor.includes('forgot password')) score += 3;
  if (descriptor.includes('forgot email')) score -= 6;
  if (descriptor.includes('email or phone')) score -= 6;
  if (descriptor.includes('identifier')) score += passwordPageLikely ? -1 : -6;
  if (descriptor.includes('verification code')) score -= 8;
  if (descriptor.includes('backup code')) score -= 8;
  if (descriptor.includes('authenticator')) score -= 8;

  const type = `${input.type || ''}`.trim().toLowerCase();
  if (type === 'password') score += 10;
  if (type === 'text' || type === 'email' || type === 'tel') score += 1;
  if (!input.readOnly) score += 2;
  if (!isDisabled(input)) score += 2;
  if (input.readOnly) score -= 1;
  if (isDisabled(input)) score -= 1;
  if (passwordPageLikely) score += 2;
  if (input === document.activeElement && passwordPageLikely) score += 8;

  if (input.closest?.('#password, #passwordNext')) score += 8;
  if (document.querySelector('#passwordNext')) score += 2;

  return score;
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

function isGooglePasswordInput(input) {
  if (!input) return false;
  const type = `${input.type || input.getAttribute?.('type') || ''}`.trim().toLowerCase();
  const name = `${input.name || input.getAttribute?.('name') || ''}`.trim().toLowerCase();
  const autocomplete = `${input.autocomplete || input.getAttribute?.('autocomplete') || ''}`.trim().toLowerCase();
  return type === 'password'
    || name === 'passwd'
    || autocomplete === 'current-password'
    || (isGooglePasswordPageLikely() && scoreGooglePasswordCandidate(input) >= 8);
}

function getGooglePasswordTypedMarker(input) {
  return `${input?.dataset?.rmwGoogleTypedPasswordValue || ''}`;
}

function setGooglePasswordTypedMarker(input, value) {
  if (!input?.dataset) return;
  input.dataset.rmwGoogleTypedPasswordValue = `${value || ''}`;
}

function randomIntBetween(min, max) {
  const lower = Math.ceil(Math.min(min, max));
  const upper = Math.floor(Math.max(min, max));
  return Math.floor(Math.random() * ((upper - lower) + 1)) + lower;
}

function armGooglePasswordSubmitPause() {
  STATE.passwordSubmitReadyAt = Date.now() + randomIntBetween(
    GOOGLE_PASSWORD_PRE_SUBMIT_PAUSE_MIN_MS,
    GOOGLE_PASSWORD_PRE_SUBMIT_PAUSE_MAX_MS
  );
}

function getGooglePasswordSubmitPauseRemaining() {
  return Math.max(0, Number(STATE.passwordSubmitReadyAt || 0) - Date.now());
}

function beginGoogleTransitionLock(startedAt = Date.now()) {
  STATE.googleTransitionLock = true;
  STATE.googleTransitionStartedAt = Number(startedAt || Date.now());
}

function clearGoogleTransitionLock() {
  STATE.googleTransitionLock = false;
  STATE.googleTransitionStartedAt = 0;
}

function isGoogleTransitionLocked() {
  return Boolean(
    STATE.googleTransitionLock
    && STATE.googleTransitionStartedAt
    && (Date.now() - Number(STATE.googleTransitionStartedAt || 0)) < GOOGLE_AUTH_TRANSITION_TIMEOUT_MS
  );
}

function getGoogleTransitionElapsedMs() {
  if (!STATE.googleTransitionStartedAt) return 0;
  return Math.max(0, Date.now() - Number(STATE.googleTransitionStartedAt || 0));
}

function getGoogleTransitionRemainingMs() {
  return Math.max(0, GOOGLE_AUTH_TRANSITION_TIMEOUT_MS - getGoogleTransitionElapsedMs());
}

async function isGooglePasswordReadyForSubmit(input, value) {
  if (!input) return false;
  const expectedValue = `${value || ''}`;
  if (`${input.value || ''}` !== expectedValue) return false;

  const typedPasswordReady = getGooglePasswordTypedMarker(input) === expectedValue;
  if (!typedPasswordReady && STATE.lastPasswordFilledAt > 0) {
    const settleRemaining = Math.max(INPUT_SETTLE_MS, GOOGLE_PASSWORD_SETTLE_MS) - (Date.now() - STATE.lastPasswordFilledAt);
    if (settleRemaining > 0) {
      return false;
    }
  }

  return waitForInputValueStability(input, expectedValue);
}

async function waitForInputValueStability(input, value, { durationMs = GOOGLE_PASSWORD_STABLE_MS, intervalMs = 80 } = {}) {
  if (!input) return false;
  const expectedValue = `${value || ''}`;
  if (`${input.value || ''}` !== expectedValue) return false;

  const deadline = Date.now() + Math.max(0, durationMs);
  while (Date.now() < deadline) {
    await sleep(intervalMs);
    if (!input.isConnected) return false;
    if (`${input.value || ''}` !== expectedValue) return false;
  }
  return `${input.value || ''}` === expectedValue;
}

async function typeInputValueLikeUser(input, value, { perCharDelayMs = null } = {}) {
  if (!input) return;
  const passwordInput = isGooglePasswordInput(input);
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
    currentValue += char;
    const previousValue = `${input.value || ''}`;
    if (setter) setter.call(input, currentValue);
    else input.value = currentValue;
    input.setAttribute('value', currentValue);
    if (input._valueTracker?.setValue) {
      input._valueTracker.setValue(previousValue);
    }

    try {
      input.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
    } catch {
      input.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
    }

    const delayMs = Number.isFinite(perCharDelayMs) && perCharDelayMs >= 0
      ? perCharDelayMs
      : randomIntBetween(GOOGLE_PASSWORD_CHAR_DELAY_MIN_MS, GOOGLE_PASSWORD_CHAR_DELAY_MAX_MS);
    await sleep(delayMs);
  }

  input.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
  if (passwordInput) {
    setGooglePasswordTypedMarker(input, nextValue);
  }
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
      value.includes('elevenlabs.io')
      || value.includes('app.elevenlabs.io')
    ))) {
      return 'elevenlabs';
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
    || currentPageText.includes("kling.ai's privacy")
    || currentPageText.includes("kling.ai's terms")
    || currentPageText.includes('review kling.ai')
    || currentPageText.includes('signing back in to kling')
    || currentPageText.includes('kling.ai terms of service')
    || currentPageText.includes('kling.ai privacy policy')
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
      && (
        url.pathname.includes('/signin/challenge')
        || url.pathname.includes('/signin/v2/challenge')
        || url.pathname.includes('/v3/signin/challenge')
      );
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
  void passInput;
}

function scheduleProtectedGooglePasswordRemask(passInput) {
  if (!passInput) return;
  [0, 40, 120, 260].forEach((delayMs) => {
    window.setTimeout(() => {
      const activePasswordInput = passInput.isConnected ? passInput : findGooglePasswordInput();
      if (!activePasswordInput) return;
      if (`${activePasswordInput.type || ''}`.trim().toLowerCase() !== 'password') {
        enforceProtectedGooglePasswordMask(activePasswordInput);
      }
    }, delayMs);
  });
}

function clearProtectedGooglePasswordMaskLoop() {
  if (STATE.passwordMaskLoopTimer) {
    window.clearInterval(STATE.passwordMaskLoopTimer);
    STATE.passwordMaskLoopTimer = null;
  }
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
      .find((element) => isVisible(element) && isSafeGoogleRevealTarget(passInput, element));
    if (checkbox) {
      return checkbox;
    }

    const fallback = Array.from(scope.querySelectorAll('input[type="checkbox"]'))
      .find((element) => isVisible(element) && isSafeGoogleRevealTarget(passInput, element));
    if (fallback) {
      return fallback;
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
    isSafeGoogleRevealTarget(passInput, element)
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
  if (!shouldAggressivelyDisableGoogleRevealControls()) return;
  findExactGoogleShowPasswordTargets(passInput).forEach((target) => {
    neutralizeGoogleRevealActionElement(target);
    disablePasswordRevealControl(target);
  });
}

function ensureProtectedGoogleRevealShield(passInput) {
  document.getElementById('rmw-google-show-password-shield')?.remove();
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
    const activePasswordInput = passInput.isConnected ? passInput : findProtectedGooglePasswordInput();
    if (!activePasswordInput) return;
    enforceProtectedGooglePasswordMask(activePasswordInput);
  });
  observer.observe(passInput, {
    attributes: true,
    attributeFilter: ['type', 'checked', 'aria-checked'],
  });
  STATE.passwordTypeObserver = observer;
}

function ensureProtectedGooglePasswordMaskLoop(passInput) {
  if (!shouldProtectGooglePasswordReveal()) return;

  const protect = () => {
    const activePasswordInput = passInput?.isConnected ? passInput : findProtectedGooglePasswordInput();
    if (!activePasswordInput) {
      clearProtectedGooglePasswordMaskLoop();
      return;
    }

    enforceProtectedGooglePasswordMask(activePasswordInput);
    ensureProtectedGooglePasswordTypeObserver(activePasswordInput);
  };

  protect();
  if (STATE.passwordMaskLoopTimer) return;
  STATE.passwordMaskLoopTimer = window.setInterval(protect, 500);
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

function isSafeGoogleRevealTarget(passInput, element) {
  if (!passInput || !element || element.nodeType !== Node.ELEMENT_NODE || !isVisible(element)) return false;
  if (element === passInput || element.contains?.(passInput) || passInput.contains?.(element)) return false;
  if (element.closest?.('#passwordNext, #identifierNext')) return false;
  if (element.querySelector?.('#passwordNext, #identifierNext')) return false;

  const passRect = passInput.getBoundingClientRect();
  const rect = element.getBoundingClientRect();
  if (!rect.width || !rect.height) return false;

  const maxAllowedWidth = Math.max(220, Math.round(passRect.width * 0.8));
  const maxAllowedHeight = Math.max(64, Math.round(passRect.height * 1.8));
  if (rect.width > maxAllowedWidth || rect.height > maxAllowedHeight) return false;

  const passBottom = passRect.bottom;
  const verticalGap = rect.top - passBottom;
  const sameRow = isNearPasswordInput(passInput, element);
  const belowPassword = verticalGap >= -12 && verticalGap <= 72 && rect.left < passRect.right && rect.right > passRect.left;
  return sameRow || belowPassword;
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
          if (isSafeGoogleRevealTarget(passInput, linkedInput)) controls.push(linkedInput);
        }
        const nestedInput = candidate.querySelector?.('input[type="checkbox"], input[type="radio"]');
        if (isSafeGoogleRevealTarget(passInput, nestedInput)) controls.push(nestedInput);
        return;
      }

      controls.push(candidate);
      const clickableAncestor = candidate.closest('button, [role="button"], label, div[tabindex], span[tabindex], li, [data-view-id], [jsaction]');
      if (isSafeGoogleRevealTarget(passInput, clickableAncestor)) {
        controls.push(clickableAncestor);
      }
    });
  });

  return Array.from(new Set(controls)).filter((control) => isSafeGoogleRevealTarget(passInput, control));
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
  enforceProtectedGooglePasswordMask(passInput);
  scheduleProtectedGooglePasswordRemask(passInput);
  void revealControl;
}

function ensureProtectedGooglePasswordRevealGuards() {
  void handleProtectedGooglePasswordRevealAttempt;
}

function enforceProtectedGooglePasswordMask(passInput) {
  if (!passInput) return;
  // Let the browser render native password masking. Fighting the reveal
  // control directly caused Google to re-render the field unpredictably.
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
    || normalized === 'elevenlabs'
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
  // The password challenge page can still show "Use another account",
  // but that is not a chooser surface.
  if (isGooglePasswordUrl()) return false;
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

function readGooglePasswordContext(input) {
  const describedBy = `${input?.getAttribute?.('aria-describedby') || ''}`.trim();
  const describedText = describedBy
    ? describedBy
        .split(/\s+/)
        .map((id) => document.getElementById(id)?.innerText || '')
        .filter(Boolean)
        .join(' ')
    : '';
  return normalizeText([
    document.body?.innerText,
    input?.closest('form, main, section, article, div')?.innerText,
    describedText,
  ].filter(Boolean).join(' '));
}

function hasGooglePasswordMissingError(input) {
  if (!input) return false;
  const contextText = readGooglePasswordContext(input);
  const invalid = `${input.getAttribute('aria-invalid') || ''}`.trim().toLowerCase() === 'true';
  return invalid && (
    contextText.includes('enter a password')
    || contextText.includes('enter your password')
  );
}

function hasGooglePasswordRejectedError(input) {
  if (!input) return false;
  const contextText = readGooglePasswordContext(input);
  const invalid = `${input.getAttribute('aria-invalid') || ''}`.trim().toLowerCase() === 'true';
  return invalid && [
    'wrong password',
    'incorrect password',
    'password is incorrect',
    "couldn't sign you in",
    'couldnt sign you in',
    'enter the correct password',
    'verify it\'s you',
    'verify its you',
    'too many failed attempts',
  ].some((token) => contextText.includes(token));
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
    isGooglePasswordUrl()
    || findGooglePasswordInput()
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
  const waitAfterSubmitMs = kind === 'password' ? 2600 : 700;
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

  if (kind === 'password') {
    const retryButton = getGoogleNextButton(kind, input);
    if (retryButton && retryButton !== nextButton && safeClick(retryButton)) {
      await sleep(waitAfterSubmitMs);
      if (didAdvance()) return true;
    }
    return didAdvance();
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
    await typeInputValueLikeUser(input, passwordValue);
    await sleep(Math.max(INPUT_SETTLE_MS, GOOGLE_PASSWORD_SETTLE_MS));
    if (`${input.value || ''}` !== passwordValue) {
      await typeInputValueLikeUser(input, passwordValue);
      await sleep(Math.max(INPUT_SETTLE_MS, GOOGLE_PASSWORD_SETTLE_MS));
    }
  }

  if (`${input.value || ''}` !== passwordValue) {
    return false;
  }

  STATE.lastPasswordFilledAt = Date.now();
  armGooglePasswordSubmitPause();

  input.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
  input.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
  await sleep(Math.max(INPUT_SETTLE_MS, 350));

  if (!(await isGooglePasswordReadyForSubmit(input, passwordValue))) {
    return false;
  }

  const submitPauseRemaining = getGooglePasswordSubmitPauseRemaining();
  if (submitPauseRemaining > 0) {
    await sleep(submitPauseRemaining);
  }

  const submitted = await submitGoogleNextStep('password', input);
  if (submitted) {
    beginGoogleTransitionLock();
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
  if (isGoogleTransitionLocked()) return false;
  const inferredToolSlug = normalizeToolSlug(
    STATE.toolSlug
    || inferToolSlugFromGooglePage()
    || inferStoredGoogleToolSlug()
  );
  if (!inferredToolSlug) return false;
  if (STATE.launchRetryAttempts >= MAX_LAUNCH_RETRIES) return false;

  const now = Date.now();
  if (now - STATE.lastLaunchRetryAt < LAUNCH_RETRY_DELAY_MS) {
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
  if (STATE.authTransitionMarkedAt && Date.now() - STATE.authTransitionMarkedAt < GOOGLE_AUTH_TRANSITION_TIMEOUT_MS) {
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

async function handleGoogleTransitionLock() {
  if (!STATE.googleTransitionLock) return false;

  if (!isGoogleTransitionLocked()) {
    clearGoogleTransitionLock();
    STATE.passwordSubmitted = false;
    STATE.passwordSubmitReadyAt = 0;
    setStatus('Google sign-in wait timed out. Retrying...');
    scheduleAttempt(0);
    return true;
  }

  const passwordInput = findGooglePasswordInput();
  if (passwordInput && hasGooglePasswordRejectedError(passwordInput)) {
    clearProtectedGooglePasswordMaskLoop();
    clearGoogleTransitionLock();
    STATE.settled = true;
    setStatus('Google rejected the password. Check the credential or continue manually.');
    releasePasswordSavingSuppressed(0);
    return true;
  }

  if (passwordInput && hasGooglePasswordMissingError(passwordInput)) {
    ensureProtectedGooglePasswordMaskLoop(passwordInput);
    clearGoogleTransitionLock();
    STATE.passwordSubmitted = false;
    STATE.lastPasswordFilledAt = 0;
    STATE.passwordSubmitReadyAt = 0;
    setGooglePasswordTypedMarker(passwordInput, '');
    setStatus('Google did not accept the password input. Retyping...');
    scheduleAttempt(GOOGLE_PASSWORD_RETRY_DELAY_MS);
    return true;
  }

  if (passwordInput) {
    ensureProtectedGooglePasswordMaskLoop(passwordInput);
  }

  const remainingSec = Math.max(1, Math.round(getGoogleTransitionRemainingMs() / 1000));
  setStatus(`Waiting for Google to finish sign-in... (${remainingSec}s)`);
  scheduleAttempt(GOOGLE_AUTH_TRANSITION_POLL_MS);
  return true;
}

function isKlingGoogleRelevantSurface() {
  return Boolean(
    isGoogleAccountChooserPage()
    || isGoogleIdentifierUrl()
    || isGooglePasswordUrl()
    || isGoogleDeveloperInfoDialogVisible()
    || isGoogleConsentContinueScreen()
    || document.querySelector('#identifierNext')
    || document.querySelector('#passwordNext')
    || findGoogleEmailInput()
    || findGooglePasswordInput()
  );
}

function isKlingGoogleEmailScreen() {
  // Once Google has advanced to /challenge/pwd, the email step must stay off.
  if (isGooglePasswordUrl()) return false;
  if (isGoogleAccountChooserPage() || isGoogleConsentContinueScreen() || isGoogleDeveloperInfoDialogVisible()) {
    return false;
  }
  if (isKlingGooglePasswordScreen()) return false;

  const text = pageText();
  return Boolean(
    isGoogleIdentifierUrl()
    || document.querySelector('#identifierNext')
    || findGoogleEmailInput()
    || text.includes('email or phone')
    || text.includes('forgot email')
  );
}

function isKlingGooglePasswordScreen() {
  if (isGoogleConsentContinueScreen()) return false;

  const text = pageText();
  return Boolean(
    isGooglePasswordUrl()
    || document.querySelector('#passwordNext')
    || findGooglePasswordInput()
    || (
      text.includes('enter your password')
      && (
        text.includes('show password')
        || text.includes('forgot password')
      )
    )
  );
}

async function attemptKlingGoogleDeveloperInfoStep() {
  const dismissAction = findGoogleDeveloperInfoDismissAction();
  if (!dismissAction) return false;

  setStatus('Dismissing Google developer info');
  if (!activateActionElement(dismissAction)) {
    setStatus('Google developer info dialog not ready');
    scheduleAttempt(250);
    return true;
  }

  scheduleAttempt(450);
  return true;
}

async function attemptKlingGoogleChooserStep(credential) {
  if (!isGoogleAccountChooserPage()) return false;

  if (
    STATE.googleAddAccountPendingAt
    && Date.now() - STATE.googleAddAccountPendingAt < STEP_PENDING_RETRY_MS
    && !findGoogleEmailInput()
    && !isGoogleIdentifierUrl()
  ) {
    setStatus('Waiting for Google add-account page');
    scheduleAttempt(500);
    return true;
  }

  const addAccountAction = shouldPreferGoogleAddAccount() ? findGoogleUseAnotherAccountAction() : null;
  if (addAccountAction) {
    setStatus('Choosing Google add account');
    if (!activateActionElement(addAccountAction)) {
      setStatus('Google add-account option not ready');
      scheduleAttempt(300);
      return true;
    }

    STATE.googleAddAccountPendingAt = Date.now();
    STATE.emailSubmitted = false;
    scheduleAttempt(700);
    return true;
  }

  const chooserAction = findGoogleAccountChooserAction(credential);
  if (chooserAction) {
    if (STATE.emailSubmitted && Date.now() - STATE.lastEmailSubmitAt < STEP_PENDING_RETRY_MS) {
      setStatus('Google account selected, waiting to continue');
      scheduleAttempt(700);
      return true;
    }

    setStatus('Selecting Google account');
    if (!activateActionElement(chooserAction)) {
      setStatus('Google account chooser not ready');
      scheduleAttempt(300);
      return true;
    }

    STATE.lastEmailSubmitAt = Date.now();
    STATE.emailSubmitted = true;
    STATE.passwordSubmitted = false;
    scheduleAttempt(700);
    return true;
  }

  setStatus('Waiting for Google account chooser');
  scheduleAttempt(400);
  return true;
}

async function attemptKlingGoogleEmailStep(credential) {
  if (isGooglePasswordUrl() || document.querySelector('#passwordNext')) return false;
  if (!isKlingGoogleEmailScreen()) return false;

  const input = findGoogleEmailInput();
  if (!input) {
    setStatus('Waiting for Google email field');
    scheduleAttempt(250);
    return true;
  }

  const emailValue = getGoogleEmailValue(credential?.loginIdentifier, input);
  if (!emailValue) {
    setStatus('Google credential email missing');
    return true;
  }

  if (`${input.value || ''}`.trim() !== `${emailValue}`.trim()) {
    setInputValue(input, emailValue);
    STATE.lastEmailFilledAt = Date.now();
    STATE.emailSubmitted = false;
    STATE.passwordSubmitted = false;
    setStatus('Filled Google email');
    scheduleAttempt(INPUT_SETTLE_MS + 150);
    return true;
  }

  if (STATE.lastEmailFilledAt > 0) {
    const settleRemaining = INPUT_SETTLE_MS - (Date.now() - STATE.lastEmailFilledAt);
    if (settleRemaining > 0) {
      setStatus('Waiting for Google email to settle');
      scheduleAttempt(settleRemaining);
      return true;
    }
  }

  if (STATE.emailSubmitted && Date.now() - STATE.lastEmailSubmitAt < 2000) {
    setStatus('Google email submitted, waiting for password step');
    scheduleAttempt(400);
    return true;
  }

  const nextButton = await waitForGoogleNextButton('email', input, 1500);
  setStatus('Submitting Google email');
  if (!submitStep(nextButton, input)) {
    setStatus('Google email Next button not ready');
    scheduleAttempt(300);
    return true;
  }

  STATE.lastEmailSubmitAt = Date.now();
  STATE.emailSubmitted = true;
  STATE.passwordSubmitted = false;
  STATE.googleAddAccountPendingAt = 0;
  setStatus('Google email submitted, waiting for password step');
  scheduleAttempt(750);
  return true;
}

async function attemptKlingGooglePasswordStep(credential) {
  if (!(isKlingGooglePasswordScreen() || isGooglePasswordUrl() || document.querySelector('#passwordNext'))) return false;

  STATE.emailSubmitted = false;
  const input = findGooglePasswordInput() || findGooglePasswordFallbackInput();
  if (!input) {
    setStatus(`Google password page detected, waiting for password field\n${getGooglePasswordFieldDebugSummary()}`);
    scheduleAttempt(250);
    return true;
  }

  const passwordValue = `${credential?.password || ''}`;
  if (!passwordValue && supportsPasswordOptionalGoogleCredential()) {
    STATE.settled = true;
    setStatus('Google password step needs manual completion for this Kling account.');
    releasePasswordSavingSuppressed(0);
    return true;
  }

  if (!STATE.passwordSavingSuppressed && !STATE.passwordSavingBypass) {
    if (
      STATE.passwordSavingInFlight
      && STATE.passwordSavingInFlightSince
      && Date.now() - STATE.passwordSavingInFlightSince > 4000
    ) {
      STATE.passwordSavingInFlight = false;
      STATE.passwordSavingInFlightSince = 0;
      STATE.passwordSavingBypass = true;
      setStatus('Warning: Password-save suppression timed out. Continuing anyway...');
      scheduleAttempt(50);
      return true;
    }
    requestPasswordSavingSuppression();
    return true;
  }

  if (hasGooglePasswordRejectedError(input)) {
    clearProtectedGooglePasswordMaskLoop();
    STATE.settled = true;
    setStatus('Google rejected the password. Check the credential or continue manually.');
    releasePasswordSavingSuppressed(0);
    return true;
  }

  if (hasGooglePasswordMissingError(input)) {
    STATE.passwordSubmitted = false;
    STATE.lastPasswordFilledAt = 0;
    setGooglePasswordTypedMarker(input, '');
  }

  if (`${input.value || ''}` !== passwordValue) {
    try {
      input.focus({ preventScroll: true });
    } catch {
      input.focus?.();
    }
    await typeInputValueLikeUser(input, passwordValue);
    STATE.lastPasswordFilledAt = Date.now();
    STATE.passwordSubmitted = false;
    setStatus('Filled Google password');
    scheduleAttempt(Math.max(INPUT_SETTLE_MS, GOOGLE_PASSWORD_SETTLE_MS));
    return true;
  }

  if (STATE.lastPasswordFilledAt > 0) {
    const settleRemaining = Math.max(INPUT_SETTLE_MS, GOOGLE_PASSWORD_SETTLE_MS) - (Date.now() - STATE.lastPasswordFilledAt);
    if (settleRemaining > 0) {
      setStatus('Waiting for Google password to settle');
      scheduleAttempt(settleRemaining);
      return true;
    }
  }

  if (STATE.passwordSubmitted && Date.now() - STATE.lastPasswordSubmitAt < GOOGLE_PASSWORD_POST_SUBMIT_WAIT_MS) {
    setStatus('Google password submitted, waiting for sign-in');
    scheduleAttempt(GOOGLE_AUTH_TRANSITION_POLL_MS);
    return true;
  }

  const nextButton = await waitForGoogleNextButton('password', input, 1500);
  setStatus('Submitting Google password');
  if (!submitStep(nextButton, input)) {
    setStatus('Google password Next button not ready');
    scheduleAttempt(300);
    return true;
  }

  STATE.lastPasswordSubmitAt = Date.now();
  STATE.passwordSubmitted = true;
  resetFlowTotpProgress();
  resetFlowBackupCodeProgress();
  beginGoogleTransitionLock();
  releasePasswordSavingSuppressed(PASSWORD_PROMPT_RESTORE_DELAY_MS);
  setStatus('Google password submitted, waiting for sign-in');
  scheduleAttempt(GOOGLE_AUTH_TRANSITION_POLL_MS);
  return true;
}

async function attemptKlingGooglePopupFlow(credential) {
  if (!isKlingGoogleFlow()) return false;

  const toolSlug = normalizeToolSlug(STATE.toolSlug || inferToolSlugFromGooglePage());
  if (toolSlug) {
    STATE.toolSlug = toolSlug;
  }

  if (!credential?.loginIdentifier || (!credential?.password && !supportsPasswordOptionalGoogleCredential(toolSlug))) {
    if (isKlingGoogleRelevantSurface()) {
      requestCredential();
      return true;
    }
    return false;
  }

  if (`${credential?.loginMethod || ''}`.trim().toLowerCase() && `${credential?.loginMethod || ''}`.trim().toLowerCase() !== 'google') {
    setStatus('Selected credential is not configured for Google sign-in');
    STATE.settled = true;
    return true;
  }

  if (await attemptKlingGoogleDeveloperInfoStep()) return true;
  // Google can show "Use another account" on the password page, but we should
  // never re-enter chooser logic once already on /challenge/pwd.
  if (!isGooglePasswordUrl() && await attemptKlingGoogleChooserStep(credential)) return true;
  if (await attemptKlingGooglePasswordStep(credential)) return true;
  if (await attemptGoogleConsentContinueStep()) return true;
  if (await attemptKlingGoogleEmailStep(credential)) return true;

  if (isKlingGoogleRelevantSurface()) {
    setStatus('Waiting for Kling Google popup step');
    scheduleAttempt(300);
    return true;
  }
  return false;
}

async function attemptEmailStep(credential) {
  // Never process the email step once already on the password challenge page.
  if (isGooglePasswordUrl()) return false;

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

  ensureProtectedGooglePasswordMaskLoop(input);

  if (!passwordValue && supportsPasswordOptionalGoogleCredential()) {
    STATE.settled = true;
    setStatus('Google password step needs manual completion for this Kling account.');
    releasePasswordSavingSuppressed(0);
    return true;
  }

  if (!STATE.passwordSavingSuppressed && !STATE.passwordSavingBypass) {
    if (
      STATE.passwordSavingInFlight
      && STATE.passwordSavingInFlightSince
      && Date.now() - STATE.passwordSavingInFlightSince > 4000
    ) {
      STATE.passwordSavingInFlight = false;
      STATE.passwordSavingInFlightSince = 0;
      STATE.passwordSavingBypass = true;
      setStatus('Warning: Password-save suppression timed out. Continuing anyway...');
      scheduleAttempt(50);
      return true;
    }
    requestPasswordSavingSuppression();
    return true;
  }

  if (isGooglePasswordUrl() || document.querySelector('#passwordNext')) {
    STATE.emailSubmitted = false;
    if (hasGooglePasswordRejectedError(input)) {
      clearProtectedGooglePasswordMaskLoop();
      STATE.settled = true;
      setStatus('Google rejected the password. Check the credential or continue manually.');
      releasePasswordSavingSuppressed(0);
      return true;
    }
    if (hasGooglePasswordMissingError(input)) {
      STATE.passwordSubmitted = false;
      STATE.lastPasswordFilledAt = 0;
      STATE.passwordSubmitReadyAt = 0;
      setGooglePasswordTypedMarker(input, '');
      setStatus('Google did not accept the password input. Retyping...');
      scheduleAttempt(GOOGLE_PASSWORD_RETRY_DELAY_MS);
      return true;
    }
    if (STATE.passwordSubmitted) {
      const submitAgeMs = Date.now() - STATE.lastPasswordSubmitAt;
      if (submitAgeMs < GOOGLE_PASSWORD_POST_SUBMIT_WAIT_MS) {
        setStatus('Password submitted, waiting for Google sign-in');
        scheduleAttempt(1400);
        return true;
      }
      STATE.settled = true;
      setStatus('Google kept returning to the password step. Continue manually or relaunch the flow.');
      releasePasswordSavingSuppressed(0);
      return true;
    }

    if (`${input.value || ''}` !== passwordValue) {
      try {
        input.focus({ preventScroll: true });
      } catch {
        input.focus?.();
      }
      await typeInputValueLikeUser(input, passwordValue);
      enforceProtectedGooglePasswordMask(input);
      STATE.lastPasswordFilledAt = Date.now();
      armGooglePasswordSubmitPause();
      STATE.passwordSubmitted = false;
      setStatus('Password filled, pausing before submit');
      scheduleAttempt(Math.max(INPUT_SETTLE_MS, GOOGLE_PASSWORD_SETTLE_MS));
      return true;
    }

    if (STATE.lastPasswordFilledAt > 0) {
      enforceProtectedGooglePasswordMask(input);
      const settleRemaining = Math.max(INPUT_SETTLE_MS, GOOGLE_PASSWORD_SETTLE_MS) - (Date.now() - STATE.lastPasswordFilledAt);
      if (settleRemaining > 0) {
        setStatus('Password filled, pausing before submit');
        scheduleAttempt(settleRemaining);
        return true;
      }
    }

    const submitPauseRemaining = getGooglePasswordSubmitPauseRemaining();
    if (submitPauseRemaining > 0) {
      setStatus('Password filled, pausing before submit');
      scheduleAttempt(submitPauseRemaining);
      return true;
    }

    const now = Date.now();
    if (
      `${input.value || ''}` === passwordValue
      && await isGooglePasswordReadyForSubmit(input, passwordValue)
      && now - STATE.lastPasswordSubmitAt > 1200
    ) {
      const submitted = await submitGooglePasswordStep(credential);
      if (!submitted) {
        setStatus('Google password step not ready');
        scheduleAttempt(GOOGLE_PASSWORD_RETRY_DELAY_MS);
        return true;
      }

      STATE.lastPasswordSubmitAt = now;
      STATE.passwordSubmitted = true;
      resetFlowTotpProgress();
      resetFlowBackupCodeProgress();
      await markAuthTransition();
      setStatus('Password submitted, waiting for Google to finish sign-in');
      scheduleAttempt(GOOGLE_AUTH_TRANSITION_POLL_MS);
      return true;
    }

    setStatus('Password filled, pausing before submit');
    scheduleAttempt(700);
    return true;
  }

  STATE.emailSubmitted = false;
    if (hasGooglePasswordRejectedError(input)) {
      clearProtectedGooglePasswordMaskLoop();
      STATE.settled = true;
      setStatus('Google rejected the password. Check the credential or continue manually.');
      releasePasswordSavingSuppressed(0);
      return true;
    }
  if (hasGooglePasswordMissingError(input)) {
    STATE.passwordSubmitted = false;
    STATE.lastPasswordFilledAt = 0;
    STATE.passwordSubmitReadyAt = 0;
    setGooglePasswordTypedMarker(input, '');
    setStatus('Google did not accept the password input. Retyping...');
    scheduleAttempt(GOOGLE_PASSWORD_RETRY_DELAY_MS);
    return true;
  }
  if (STATE.passwordSubmitted) {
    const submitAgeMs = Date.now() - STATE.lastPasswordSubmitAt;
    if (submitAgeMs < GOOGLE_PASSWORD_POST_SUBMIT_WAIT_MS) {
      setStatus('Password submitted, waiting for Google sign-in');
      scheduleAttempt(1400);
      return true;
    }
    STATE.settled = true;
    setStatus('Google kept returning to the password step. Continue manually or relaunch the flow.');
    releasePasswordSavingSuppressed(0);
    return true;
  }
  if (`${input.value || ''}` !== passwordValue) {
    try {
      input.focus({ preventScroll: true });
    } catch {
      input.focus?.();
    }
    await typeInputValueLikeUser(input, passwordValue);
    enforceProtectedGooglePasswordMask(input);
    STATE.lastPasswordFilledAt = Date.now();
    armGooglePasswordSubmitPause();
    STATE.passwordSubmitted = false;
    setStatus('Password filled, pausing before submit');
    scheduleAttempt(Math.max(INPUT_SETTLE_MS, GOOGLE_PASSWORD_SETTLE_MS));
    return true;
  }

  if (STATE.lastPasswordFilledAt > 0) {
    enforceProtectedGooglePasswordMask(input);
    const settleRemaining = Math.max(INPUT_SETTLE_MS, GOOGLE_PASSWORD_SETTLE_MS) - (Date.now() - STATE.lastPasswordFilledAt);
    if (settleRemaining > 0) {
      setStatus('Password filled, pausing before submit');
      scheduleAttempt(settleRemaining);
      return true;
    }
  }

  const submitPauseRemaining = getGooglePasswordSubmitPauseRemaining();
  if (submitPauseRemaining > 0) {
    setStatus('Password filled, pausing before submit');
    scheduleAttempt(submitPauseRemaining);
    return true;
  }

  const now = Date.now();
  if (
    `${input.value || ''}` === passwordValue
    && await isGooglePasswordReadyForSubmit(input, passwordValue)
    && now - STATE.lastPasswordSubmitAt > 2500
  ) {
    const submitted = await submitGooglePasswordStep(credential);
    if (!submitted) {
      setStatus('Password filled, submit action not ready');
      scheduleAttempt(GOOGLE_PASSWORD_RETRY_DELAY_MS);
      return true;
    }

    STATE.lastPasswordSubmitAt = now;
    STATE.passwordSubmitted = true;
    setStatus('Password submitted, waiting for Google to finish sign-in');
    scheduleAttempt(GOOGLE_AUTH_TRANSITION_POLL_MS);
    return true;
  }
  setStatus('Password filled, pausing before submit');
  scheduleAttempt(700);
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
  if (await handleGoogleTransitionLock()) return;
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

  if (await attemptKlingGooglePopupFlow(credential)) return;

  if (!credential?.loginIdentifier || (!credential?.password && !supportsPasswordOptionalGoogleCredential(STATE.toolSlug))) {
    if (
      findGoogleEmailInput()
      || findGooglePasswordInput()
      || isGoogleAccountChooserPage()
      || findGoogleAccountChooserAction(credential)
      || isGooglePasswordUrl()
    ) {
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
  const passwordInput = findGooglePasswordInput();
  if (passwordInput) {
    ensureProtectedGooglePasswordMaskLoop(passwordInput);
  } else if (STATE.passwordMaskLoopTimer) {
    clearProtectedGooglePasswordMaskLoop();
  }
  if (isGoogleTransitionLocked()) return;
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

  ensureProtectedGooglePasswordRevealGuards();
  STATE.observer = new MutationObserver(() => handleMutations());
  STATE.observer.observe(document.body || document.documentElement, { childList: true, subtree: true });
  STATE.keepAliveTimer = window.setInterval(() => {
    if (!isGoogleTransitionLocked()) {
      scheduleAttempt(0);
    }
  }, KEEP_ALIVE_MS);
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
