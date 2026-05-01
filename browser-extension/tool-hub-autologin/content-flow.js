const TOOL_SLUG = 'flow';
const LABS_HOST = 'labs.google';
const ONE_GOOGLE_HOST = 'one.google.com';
const LABS_HOME_URL = 'https://labs.google/fx';
const FLOW_TOOL_URL = 'https://labs.google/fx/tools/flow';
const LOGIN_URL = FLOW_TOOL_URL;
const EXTENSION_TICKET_KEY = 'rmw_extension_ticket';

const KEEP_ALIVE_MS = 1500;
const MUTATION_DEBOUNCE_MS = 200;
const MIN_RUN_GAP_MS = 150;
const SUBMIT_LOCK_MS = 8000;
const FLOW_TOOL_PATH_RE = /^\/fx(?:\/[^/]+)?\/tools\/flow\/?$/i;
const CHECKPOINT_KEY = 'rmw_flow_google_checkpoint';
const UNAUTHORIZED_RESET_KEY = 'rmw_flow_unauthorized_reset';
const FORCED_REAUTH_KEY = 'rmw_flow_forced_reauth';
const FLOW_ENTRY_CLICK_KEY = 'rmw_flow_entry_click';
const ONE_GOOGLE_REDIRECT_KEY = 'rmw_flow_offer_redirect';
const PAGE_OPEN_BRIDGE_MESSAGE_TYPE = 'RMW_FLOW_PAGE_OPEN';
const PAGE_OPEN_BRIDGE_SOURCE = 'rmw-flow-open-bridge';
const MAX_LAUNCH_RETRIES = 6;
const FLOW_ENTRY_AUTO_RETRY_WINDOW_MS = 45000;
const MAX_FLOW_ENTRY_AUTO_RETRIES = 3;
const ONE_GOOGLE_REDIRECT_RETRY_WINDOW_MS = 45000;
const MAX_ONE_GOOGLE_REDIRECT_RETRIES = 3;
const SCREEN_WAIT_MS = 500;
const LABS_SIGNIN_WAIT_MS = 1800;
const ACTION_SELECTORS = [
  'button',
  'a[href]',
  'input[type="button"]',
  'input[type="submit"]',
  '[role="button"]',
  '[data-identifier]',
  'div[tabindex]',
  'li[tabindex]',
].join(',');
const EMAIL_INPUT_SELECTORS = [
  'input[type="email"]',
  'input[type="text"]',
  'input[autocomplete="username"]',
  'input[aria-label*="email" i]',
  'input[name*="identifier" i]',
  'input[name="identifier"]',
  'input[id="identifierId"]',
  'input[inputmode="email"]',
];
const PASSWORD_INPUT_SELECTORS = [
  'input[type="password"]',
  'input[name="Passwd"]',
  'input[autocomplete="current-password"]',
];

const P = {
  BOOT: 'boot',
  AUTHORIZE: 'authorize',
  PREPARE_SESSION: 'prepareSession',
  LOAD_CRED: 'loadCredential',
  OPEN_GOOGLE: 'openGoogle',
  CHOOSER: 'chooser',
  EMAIL: 'email',
  PASSWORD: 'password',
  WAIT_REDIRECT: 'waitRedirect',
  DONE: 'done',
  BLOCKED: 'blocked',
};

const CTX = {
  phase: P.BOOT,
  busy: false,
  stopped: false,
  timer: null,
  keepAlive: null,
  observer: null,
  credential: null,
  submitAt: 0,
  submitLockUntil: 0,
  lastRunAt: 0,
  lastMutationAt: 0,
  ticket: '',
  launchRetries: 0,
  prepared: false,
  expiresAt: 0,
  authTransitionAt: 0,
  sessionClearDone: false,
  pageBridgeInstalled: false,
};

function ensureBadge() {
  let el = document.getElementById('rmw-google-badge');
  if (el) return el;

  el = document.createElement('div');
  el.id = 'rmw-google-badge';
  Object.assign(el.style, {
    position: 'fixed',
    top: '10px',
    right: '10px',
    zIndex: '2147483647',
    maxWidth: '320px',
    padding: '8px 12px',
    borderRadius: '8px',
    background: 'rgba(10, 15, 30, 0.90)',
    color: '#f0f4ff',
    font: '12px/1.5 system-ui, sans-serif',
    boxShadow: '0 4px 16px rgba(0, 0, 0, 0.4)',
    pointerEvents: 'none',
    whiteSpace: 'pre-wrap',
  });

  (document.body || document.documentElement).appendChild(el);
  return el;
}

function setStatus(message) {
  console.debug('[RMW Flow Google]', message);
  const badge = ensureBadge();
  if (badge) {
    badge.textContent = `Google auto-login\n${message}`;
  }
}

function msg(payload) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(payload, (response) => {
      if (chrome.runtime.lastError) {
        resolve({ ok: false, error: chrome.runtime.lastError.message });
        return;
      }
      resolve(response || { ok: false, error: 'No response' });
    });
  });
}

function writeCheckpoint(data) {
  try {
    window.sessionStorage.setItem(CHECKPOINT_KEY, JSON.stringify({ ...data, ts: Date.now() }));
  } catch {}
}

function readCheckpoint() {
  try {
    const raw = window.sessionStorage.getItem(CHECKPOINT_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw);
    if (Date.now() - Number(data.ts || 0) > 60000) {
      clearCheckpoint();
      return null;
    }
    return data;
  } catch {
    return null;
  }
}

function clearCheckpoint() {
  try {
    window.sessionStorage.removeItem(CHECKPOINT_KEY);
  } catch {}
}

function markUnauthorizedResetAttempt() {
  try {
    window.sessionStorage.setItem(UNAUTHORIZED_RESET_KEY, `${Date.now()}`);
  } catch {}
}

function hasRecentUnauthorizedResetAttempt() {
  try {
    const raw = `${window.sessionStorage.getItem(UNAUTHORIZED_RESET_KEY) || ''}`.trim();
    if (!raw) return false;
    return (Date.now() - Number(raw || 0)) < 15000;
  } catch {
    return false;
  }
}

function clearUnauthorizedResetAttempt() {
  try {
    window.sessionStorage.removeItem(UNAUTHORIZED_RESET_KEY);
  } catch {}
}

function markForcedReauthAttempt() {
  try {
    window.sessionStorage.setItem(FORCED_REAUTH_KEY, `${Date.now()}`);
  } catch {}
}

function hasRecentForcedReauthAttempt() {
  try {
    const raw = `${window.sessionStorage.getItem(FORCED_REAUTH_KEY) || ''}`.trim();
    if (!raw) return false;
    return (Date.now() - Number(raw || 0)) < 20000;
  } catch {
    return false;
  }
}

function clearForcedReauthAttempt() {
  try {
    window.sessionStorage.removeItem(FORCED_REAUTH_KEY);
  } catch {}
}

function readRecentAttemptState(key, maxAgeMs) {
  try {
    const raw = `${window.sessionStorage.getItem(key) || ''}`.trim();
    if (!raw) return { count: 0, ts: 0 };

    let ts = 0;
    let count = 0;
    if (raw.startsWith('{')) {
      const parsed = JSON.parse(raw);
      ts = Number(parsed?.ts || 0);
      count = Math.max(0, Number(parsed?.count || 0));
    } else {
      ts = Number(raw || 0);
      count = ts ? 1 : 0;
    }

    if (!ts || (Date.now() - ts) >= maxAgeMs) return { count: 0, ts: 0 };
    return { count, ts };
  } catch {
    return { count: 0, ts: 0 };
  }
}

function markRecentAttempt(key, maxAgeMs) {
  const state = readRecentAttemptState(key, maxAgeMs);
  const next = {
    count: Math.max(0, Number(state.count || 0)) + 1,
    ts: Date.now(),
  };
  try {
    window.sessionStorage.setItem(key, JSON.stringify(next));
  } catch {}
  return next.count;
}

function getRecentAttemptCount(key, maxAgeMs) {
  return readRecentAttemptState(key, maxAgeMs).count;
}

function clearRecentAttempt(key) {
  try {
    window.sessionStorage.removeItem(key);
  } catch {}
}

function markFlowEntryClickAttempt() {
  return markRecentAttempt(FLOW_ENTRY_CLICK_KEY, FLOW_ENTRY_AUTO_RETRY_WINDOW_MS);
}

function getRecentFlowEntryClickAttemptCount() {
  return getRecentAttemptCount(FLOW_ENTRY_CLICK_KEY, FLOW_ENTRY_AUTO_RETRY_WINDOW_MS);
}

function hasRecentFlowEntryClickAttempt() {
  return getRecentFlowEntryClickAttemptCount() > 0;
}

function clearFlowEntryClickAttempt() {
  clearRecentAttempt(FLOW_ENTRY_CLICK_KEY);
}

function markOneGoogleRedirectAttempt() {
  return markRecentAttempt(ONE_GOOGLE_REDIRECT_KEY, ONE_GOOGLE_REDIRECT_RETRY_WINDOW_MS);
}

function getRecentOneGoogleRedirectAttemptCount() {
  return getRecentAttemptCount(ONE_GOOGLE_REDIRECT_KEY, ONE_GOOGLE_REDIRECT_RETRY_WINDOW_MS);
}

function hasRecentOneGoogleRedirectAttempt() {
  return getRecentOneGoogleRedirectAttemptCount() > 0;
}

function clearOneGoogleRedirectAttempt() {
  clearRecentAttempt(ONE_GOOGLE_REDIRECT_KEY);
}

function readTicketFromUrl() {
  try {
    const searchParams = new URLSearchParams(window.location.search || '');
    const queryTicket = `${searchParams.get('rmw_extension_ticket') || ''}`.trim();
    if (queryTicket) return queryTicket;

    const hash = `${window.location.hash || ''}`.replace(/^#/, '');
    if (!hash) return '';
    return `${new URLSearchParams(hash).get('rmw_extension_ticket') || ''}`.trim();
  } catch {
    return '';
  }
}

function storeTicket(ticket) {
  try {
    if (ticket) {
      window.sessionStorage.setItem(EXTENSION_TICKET_KEY, ticket);
    } else {
      window.sessionStorage.removeItem(EXTENSION_TICKET_KEY);
    }
  } catch {}
}

function loadStoredTicket() {
  try {
    return `${window.sessionStorage.getItem(EXTENSION_TICKET_KEY) || ''}`.trim();
  } catch {
    return '';
  }
}

function clearTicket() {
  try {
    window.sessionStorage.removeItem(EXTENSION_TICKET_KEY);
  } catch {}
}

function captureTicket() {
  const ticket = readTicketFromUrl();
  if (!ticket) return loadStoredTicket();

  storeTicket(ticket);
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

function isVisible(element) {
  if (!element) return false;
  const rect = element.getBoundingClientRect();
  const style = window.getComputedStyle(element);
  return rect.width > 0
    && rect.height > 0
    && style.display !== 'none'
    && style.visibility !== 'hidden'
    && style.opacity !== '0';
}

function isEnabled(element) {
  return Boolean(element) && !element.disabled && element.getAttribute('aria-disabled') !== 'true';
}

function textOf(element) {
  return normalizeText(
    `${element?.innerText || element?.textContent || element?.value || element?.getAttribute?.('aria-label') || ''}`
  );
}

function normalizeText(value) {
  return `${value || ''}`.replace(/\s+/g, ' ').trim().toLowerCase();
}

function descriptorText(element) {
  if (!element) return '';

  const parts = [
    element.innerText,
    element.textContent,
    element.value,
    element.getAttribute?.('aria-label'),
    element.getAttribute?.('title'),
    element.getAttribute?.('data-identifier'),
  ];
  element.querySelectorAll?.('img[alt], [aria-label], [title]').forEach((node) => {
    parts.push(
      node.getAttribute?.('alt'),
      node.getAttribute?.('aria-label'),
      node.getAttribute?.('title')
    );
  });

  return normalizeText(parts.filter(Boolean).join(' '));
}

function valuesMatch(left, right) {
  return `${left || ''}`.trim() === `${right || ''}`.trim();
}

function normalizeIdentifier(value) {
  return `${value || ''}`.trim().toLowerCase();
}

function findClickableAncestor(element) {
  let current = element;
  while (current && current !== document.body) {
    if (isActionLikeElement(current)) return current;
    current = current.parentElement;
  }
  return isActionLikeElement(element) ? element : null;
}

function isActionLikeElement(element) {
  if (!element || !isVisible(element) || !isEnabled(element)) return false;
  if (element.matches?.('button, a[href], input[type="button"], input[type="submit"], [role="button"]')) {
    return true;
  }

  if (element.tabIndex >= 0) return true;

  const style = window.getComputedStyle(element);
  return style.cursor === 'pointer' || typeof element.onclick === 'function';
}

function collectUniqueElements(elements) {
  return Array.from(new Set(elements.filter(Boolean)));
}

function collectActionCandidates(root = document) {
  return collectUniqueElements(
    Array.from(root.querySelectorAll(ACTION_SELECTORS))
      .map((element) => findClickableAncestor(element))
  ).filter(Boolean);
}

function findByText(selectors, matcher) {
  return Array.from(document.querySelectorAll(selectors))
    .find((element) => isVisible(element) && isEnabled(element) && matcher(textOf(element))) || null;
}

function matchesActionText(element, exactTexts = [], partialTexts = [], excludedTexts = []) {
  const label = textOf(element);
  const descriptor = descriptorText(element);
  if (excludedTexts.some((text) => label.includes(text) || descriptor.includes(text))) {
    return false;
  }

  if (exactTexts.some((text) => label === text || descriptor === text)) {
    return true;
  }

  return partialTexts.some((text) => label.includes(text) || descriptor.includes(text));
}

function getFieldRoots(anchor) {
  const roots = [];
  let current = anchor?.parentElement || null;
  while (current && current !== document.body) {
    roots.push(current);
    if (current.matches?.('form, [role="dialog"], [aria-modal="true"], main, section, article, c-wiz')) {
      break;
    }
    current = current.parentElement;
  }
  roots.push(document);
  return collectUniqueElements(roots);
}

function findActionByText(options = {}) {
  const roots = (options.roots || [document]).filter(Boolean);
  const exactTexts = (options.exact || []).map(normalizeText);
  const partialTexts = (options.partial || []).map(normalizeText);
  const excludedTexts = (options.exclude || []).map(normalizeText);

  for (const root of roots) {
    const candidates = collectActionCandidates(root)
      .filter((element) => (options.filter ? options.filter(element) : true));

    const matched = candidates.find((element) => matchesActionText(
      element,
      exactTexts,
      partialTexts,
      excludedTexts
    ));

    if (matched) return matched;
  }

  return null;
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

function findRealClickableTarget(element) {
  const descendant = Array.from(
    element?.querySelectorAll?.('button, a[href], input[type="button"], input[type="submit"], [role="button"]') || []
  ).find((candidate) => isVisible(candidate) && isEnabled(candidate));
  if (descendant) return descendant;

  let current = element;
  while (current && current !== document.body) {
    if (
      current.matches?.('button, a[href], input[type="button"], input[type="submit"], [role="button"]')
      && isVisible(current)
      && isEnabled(current)
    ) {
      return current;
    }
    current = current.parentElement;
  }
  return element;
}

function resolveActionUrl(element) {
  const anchor = element?.closest?.('a[href]')
    || (element?.matches?.('a[href]') ? element : null)
    || element?.querySelector?.('a[href]');

  const rawHref = `${anchor?.getAttribute?.('href') || anchor?.href || element?.getAttribute?.('href') || element?.getAttribute?.('data-href') || ''}`.trim();
  if (!rawHref || rawHref === '#' || rawHref.toLowerCase().startsWith('javascript:')) {
    return '';
  }

  try {
    return new URL(rawHref, window.location.href).toString();
  } catch {
    return '';
  }
}

function attachExtensionTicket(urlValue, ticket = CTX.ticket || loadStoredTicket()) {
  const resolvedTicket = `${ticket || ''}`.trim();
  if (!urlValue || !resolvedTicket) return urlValue;

  try {
    const url = new URL(urlValue, window.location.href);
    url.searchParams.set('rmw_extension_ticket', resolvedTicket);
    url.searchParams.set('rmw_tool_slug', TOOL_SLUG);
    return url.toString();
  } catch {
    return urlValue;
  }
}

function isGoogleAuthUrl(urlValue) {
  try {
    const url = new URL(urlValue, window.location.href);
    return url.hostname.includes('accounts.google.com') || url.hostname.endsWith('.google.com');
  } catch {
    return false;
  }
}

function handlePageOpenBridgeMessage(event) {
  if (event.source !== window) return;
  if (event.data?.source !== PAGE_OPEN_BRIDGE_SOURCE) return;
  if (event.data?.type !== PAGE_OPEN_BRIDGE_MESSAGE_TYPE) return;

  const targetUrl = `${event.data?.url || ''}`.trim();
  if (!targetUrl || !isGoogleAuthUrl(targetUrl)) return;
  if (!onLabsPage()) return;

  const nextUrl = attachExtensionTicket(targetUrl);
  setStatus('Opening Labs sign-in...');
  writeCheckpoint({ phase: P.CHOOSER });
  window.location.assign(nextUrl);
}

function installLabsOpenBridge() {
  if (CTX.pageBridgeInstalled || !onLabsPage()) return;
  CTX.pageBridgeInstalled = true;
  window.addEventListener('message', handlePageOpenBridgeMessage);

  const script = document.createElement('script');
  script.dataset.rmwFlowBridge = '1';
  script.textContent = `
    (() => {
      const source = '${PAGE_OPEN_BRIDGE_SOURCE}';
      const type = '${PAGE_OPEN_BRIDGE_MESSAGE_TYPE}';
      const originalOpen = window.open;
      const originalFetch = window.fetch;
      const OriginalXHR = window.XMLHttpRequest;
      const shouldCapture = (value) => {
        try {
          const url = new URL(String(value || ''), window.location.href);
          return url.hostname.includes('accounts.google.com') || url.hostname.endsWith('.google.com');
        } catch {
          return false;
        }
      };
      const extractGoogleUrl = (value) => {
        const text = String(value || '');
        const match = text.match(/https:\\/\\/accounts\\.google\\.com[^"'\\s<]+/i);
        return match ? match[0] : '';
      };
      const postCapturedUrl = (value) => {
        const directUrl = shouldCapture(value) ? String(value) : '';
        const extractedUrl = directUrl || extractGoogleUrl(value);
        if (!extractedUrl || !shouldCapture(extractedUrl)) return;
        window.postMessage({ source, type, url: extractedUrl }, window.location.origin);
      };
      window.open = function patchedOpen(url, ...rest) {
        postCapturedUrl(url);
        return typeof originalOpen === 'function' ? originalOpen.call(this, url, ...rest) : null;
      };
      if (typeof originalFetch === 'function') {
        window.fetch = async function patchedFetch(...args) {
          const response = await originalFetch.apply(this, args);
          try {
            response.clone().text().then((text) => {
              postCapturedUrl(text);
            }).catch(() => {});
          } catch {}
          return response;
        };
      }
      if (typeof OriginalXHR === 'function') {
        window.XMLHttpRequest = function PatchedXHR() {
          const xhr = new OriginalXHR();
          xhr.addEventListener('load', function onLoad() {
            try {
              postCapturedUrl(xhr.responseURL);
              postCapturedUrl(xhr.responseText);
            } catch {}
          });
          return xhr;
        };
        window.XMLHttpRequest.prototype = OriginalXHR.prototype;
      }
    })();
  `;
  (document.documentElement || document.head || document.body).appendChild(script);
  script.remove();
}

function safeClick(element) {
  const target = findRealClickableTarget(element);
  if (!target || !isVisible(target) || !isEnabled(target)) return false;

  const anchor = target.closest?.('a[href]') || (target.matches?.('a[href]') ? target : null);
  if (anchor) {
    const href = `${anchor.getAttribute('href') || ''}`.trim();
    const linkTarget = `${anchor.getAttribute('target') || ''}`.trim().toLowerCase();
    if (href && href !== '#' && !href.toLowerCase().startsWith('javascript:') && linkTarget === '_blank') {
      try {
        anchor.setAttribute('target', '_self');
      } catch {}
    }
  }

  try {
    target.scrollIntoView({ block: 'center', inline: 'nearest' });
  } catch {}
  try {
    target.focus({ preventScroll: true });
  } catch {}

  dispatchMouseSequence(target);

  try {
    target.click();
    return true;
  } catch {
    try {
      target.dispatchEvent(new window.MouseEvent('click', {
        bubbles: true,
        cancelable: true,
        composed: true,
        view: window,
      }));
      return true;
    } catch {
      if (element && element !== target && isVisible(element) && isEnabled(element)) {
        try {
          dispatchMouseSequence(element);
          element.click?.();
          return true;
        } catch {}
      }
      return false;
    }
  }
}

function maybeForceGoogleAccountSelection(element) {
  const anchor = element?.closest?.('a[href]') || (element?.matches?.('a[href]') ? element : null);
  if (!anchor) return;

  try {
    const url = new URL(anchor.href, window.location.href);
    if (!url.hostname.includes('google.com')) return;
    if (!url.searchParams.get('prompt')) {
      url.searchParams.set('prompt', 'select_account');
      anchor.href = url.toString();
    }
  } catch {}
}

function buildForcedGoogleIdentifierUrl() {
  const signInUrl = resolveActionUrl(findGoogleSignInButton());
  if (signInUrl) {
    try {
      const url = new URL(attachExtensionTicket(signInUrl), window.location.href);
      url.searchParams.set('prompt', 'select_account');
      return url.toString();
    } catch {}
  }

  try {
    return attachExtensionTicket(LOGIN_URL);
  } catch {
    return attachExtensionTicket(LOGIN_URL);
  }
}

function findInput(selectors) {
  for (const selector of selectors) {
    const found = Array.from(document.querySelectorAll(selector))
      .find((element) => isVisible(element) && !element.disabled && !element.readOnly);
    if (found) return found;
  }
  return null;
}

function elementArea(element) {
  if (!element) return Number.POSITIVE_INFINITY;
  const rect = element.getBoundingClientRect();
  return Math.max(1, rect.width * rect.height);
}

function findLabsModalRoot() {
  if (!onLabsPage()) return null;

  const candidates = Array.from(document.querySelectorAll('div, section, main, [role="dialog"], [aria-modal="true"], c-wiz'))
    .filter((element) => isVisible(element))
    .filter((element) => {
      const text = normalizeText(element.innerText || element.textContent || '');
      return text.includes('labs.google/fx') && text.includes('sign in with google');
    })
    .sort((left, right) => elementArea(left) - elementArea(right));

  return candidates[0] || null;
}

function findLabsModalSignInButton() {
  const modalRoot = findLabsModalRoot();
  if (!modalRoot) return null;

  const matched = findActionByText({
    roots: [modalRoot],
    exact: ['sign in'],
    partial: ['sign in'],
    exclude: ['sign out'],
  });
  if (matched) return matched;

  const fallbackCandidates = collectActionCandidates(modalRoot)
    .filter((element) => {
      const label = textOf(element);
      const descriptor = descriptorText(element);
      return (
        label.includes('sign in')
        || descriptor.includes('sign in')
        || descriptor.includes('google')
      );
    })
    .sort((left, right) => elementArea(left) - elementArea(right));

  return fallbackCandidates[0] || null;
}

function hasNavigableActionUrl(element) {
  const actionUrl = resolveActionUrl(element);
  return Boolean(actionUrl && !actionUrl.endsWith('#'));
}

function findFlowEntryButton() {
  if (!onFlowToolPage() || !isSignedOutFlowRoute()) return null;

  const getStarted = findActionByText({
    exact: ['get started', 'create with flow'],
    partial: ['get started', 'start creating', 'create with flow'],
    exclude: ['overview', 'capabilities', 'partners', 'gallery', 'pricing', 'faq'],
    filter: (element) => hasNavigableActionUrl(element),
  });
  if (getStarted) return getStarted;

  return findActionByText({
    exact: ['create'],
    partial: ['create'],
    exclude: ['overview', 'capabilities', 'partners', 'gallery', 'pricing', 'faq', 'refine', 'compose'],
    filter: (element) => hasNavigableActionUrl(element) || element.matches?.('button, [role="button"]'),
  });
}

function findGoogleSignInButton() {
  const flowEntryButton = findFlowEntryButton();
  if (flowEntryButton) return flowEntryButton;

  if (onLabsPage()) {
    const modalButton = findLabsModalSignInButton();
    if (modalButton) return modalButton;

    return findActionByText({
      exact: ['sign in with google', 'sign in'],
      partial: ['sign in with google', 'continue with google', 'google sign in', 'sign in'],
      exclude: ['sign out'],
    });
  }

  return findActionByText({
    exact: ['sign in with google', 'continue with google'],
    partial: ['sign in with google', 'continue with google', 'google sign in'],
    exclude: ['sign out'],
  });
}

function findUseAnotherAccountButton() {
  return findActionByText({
    exact: ['use another account', 'choose another account', 'add another account'],
    partial: ['use another account', 'choose another account', 'add another account', 'use another'],
  });
}

function findTryAnotherWayButton() {
  return findActionByText({
    exact: ['try another way', 'choose another way'],
    partial: ['try another way', 'choose another way'],
  });
}

function findPasswordChoiceButton() {
  return findActionByText({
    exact: ['enter your password', 'use your password'],
    partial: ['enter your password', 'use your password', 'password instead'],
    exclude: ['forgot password', 'show password'],
  });
}

function findEmailInput() {
  return findInput(EMAIL_INPUT_SELECTORS);
}

function findPasswordInput() {
  return findInput(PASSWORD_INPUT_SELECTORS);
}

function getGoogleEmailValue(loginIdentifier, input) {
  const full = `${loginIdentifier || ''}`.trim();
  if (!full.includes('@')) return full;

  const screenText = `${input?.closest('form, main, section, div')?.innerText || document.body?.innerText || ''}`.toLowerCase();
  const domain = full.split('@')[1].toLowerCase();
  if (domain && screenText.includes(`@${domain}`)) {
    return full.split('@')[0];
  }

  return full;
}

function findNextButton(kind = 'generic', anchor = null) {
  const explicitSelector = kind === 'email'
    ? '#identifierNext button, #identifierNext [role="button"]'
    : kind === 'password'
      ? '#passwordNext button, #passwordNext [role="button"]'
      : '';

  if (explicitSelector) {
    const direct = Array.from(document.querySelectorAll(explicitSelector))
      .find((element) => isVisible(element) && isEnabled(element));
    if (direct) return direct;
  }

  return findActionByText({
    roots: getFieldRoots(anchor),
    exact: kind === 'password' ? ['next', 'continue', 'sign in'] : ['next', 'continue'],
    partial: kind === 'password'
      ? ['next', 'continue', 'sign in', 'yes, continue', 'confirm']
      : ['next', 'continue', 'yes, continue'],
    exclude: ['use another account', 'try another way'],
  });
}

function focusField(input) {
  try {
    input.scrollIntoView({ block: 'center', inline: 'nearest' });
  } catch {}
  try {
    input.focus({ preventScroll: true });
  } catch {}
  try {
    input.select?.();
  } catch {}
}

function fillField(input, value) {
  if (!input) return;

  focusField(input);

  const descriptor = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value');
  if (descriptor?.set) {
    descriptor.set.call(input, value);
  } else {
    input.value = value;
  }
  input.setAttribute('value', value);

  try {
    input.dispatchEvent(typeof window.InputEvent === 'function'
      ? new window.InputEvent('input', {
        bubbles: true,
        cancelable: true,
        data: `${value || ''}`,
        inputType: 'insertText',
      })
      : new Event('input', { bubbles: true, cancelable: true }));
  } catch {
    input.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
  }

  ['change', 'blur'].forEach((eventName) => {
    input.dispatchEvent(new Event(eventName, { bubbles: true, cancelable: true }));
  });
}

function pressEnter(input) {
  if (!input) return false;

  focusField(input);
  ['keydown', 'keypress', 'keyup'].forEach((eventName) => {
    try {
      input.dispatchEvent(new window.KeyboardEvent(eventName, {
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

function submitStep(button, fallbackInput) {
  if (button && safeClick(button)) return true;
  return pressEnter(fallbackInput);
}

function onLabsPage() {
  return window.location.hostname === LABS_HOST && window.location.pathname.startsWith('/fx');
}

function onLabsHomePage() {
  return window.location.hostname === LABS_HOST && /^\/fx\/?$/.test(window.location.pathname);
}

function onFlowToolPage() {
  return window.location.hostname === LABS_HOST && FLOW_TOOL_PATH_RE.test(window.location.pathname);
}

function onGooglePage() {
  return window.location.hostname.includes('accounts.google.com');
}

function onOneGoogleFlowOfferPage() {
  if (window.location.hostname !== ONE_GOOGLE_HOST) return false;
  if (!window.location.pathname.startsWith('/ai')) return false;

  const searchParams = new URLSearchParams(window.location.search || '');
  const toolSlug = `${searchParams.get('rmw_tool_slug') || ''}`.trim().toLowerCase();
  const utmSource = `${searchParams.get('utm_source') || ''}`.trim().toLowerCase();
  const landingPage = `${searchParams.get('g1_landing_page') || ''}`.trim();
  return toolSlug === TOOL_SLUG || utmSource === TOOL_SLUG || Boolean(landingPage);
}

function cameFromLabs() {
  return `${document.referrer || ''}`.includes('https://labs.google');
}

function cameFromGoogle() {
  return `${document.referrer || ''}`.includes('https://accounts.google.com');
}

function hasFlowPageContext() {
  return Boolean(
    onLabsPage()
    || onOneGoogleFlowOfferPage()
    || loadStoredTicket()
    || readCheckpoint()
    || cameFromLabs()
  );
}

function hasLaunchEvidence() {
  return Boolean(
    onOneGoogleFlowOfferPage()
    || loadStoredTicket()
    || readCheckpoint()
    || cameFromLabs()
  );
}

function redirectOneGoogleOfferToFlow() {
  const redirectAttempts = getRecentOneGoogleRedirectAttemptCount();
  if (redirectAttempts >= MAX_ONE_GOOGLE_REDIRECT_RETRIES) {
    stop('Flow offer page is looping. Click Create with Flow once manually if it stays here.', P.DONE);
    return false;
  }
  const nextAttempt = markOneGoogleRedirectAttempt();
  const nextUrl = attachExtensionTicket(FLOW_TOOL_URL, CTX.ticket || loadStoredTicket());
  setStatus(
    nextAttempt > 1
      ? `Flow offer page returned again. Redirecting back to Flow (${nextAttempt}/${MAX_ONE_GOOGLE_REDIRECT_RETRIES})...`
      : 'Redirecting Google AI offer back to Flow...'
  );
  window.location.replace(nextUrl);
  return true;
}

function hasSignedInGoogleAccount() {
  const text = `${document.body?.innerText || ''}`.toLowerCase();
  return text.includes('you have signed in') || text.includes('welcome to labs.google/fx');
}

function getPageText() {
  return `${document.body?.innerText || ''}`.trim().toLowerCase();
}

function isSignedOutFlowRoute() {
  if (!onFlowToolPage()) return false;
  const text = getPageText();
  if (
    text.includes('where the next wave of storytelling happens')
    || text.includes('sign in to get a sneak peek')
    || text.includes('without a google ai subscription')
    || text.includes('flow is an ai creative studio')
    || text.includes('receive 100 credits free of charge')
    || text.includes('100 credits free of charge')
    || text.includes('50 credits daily')
    || text.includes('explore google ai subscriptions')
  ) {
    return true;
  }

  const marketingSignals = [
    'overview',
    'capabilities',
    'partners',
    'gallery',
    'pricing',
    'start creating',
    'google ai pro',
    'google ai ultra',
    'create with flow',
  ];
  const matchedSignals = marketingSignals.filter((signal) => text.includes(signal)).length;
  return matchedSignals >= 3;
}

function hasLabsLaunchSurface() {
  if (!onLabsPage()) return false;

  const body = getPageText();
  if (onFlowToolPage()) {
    if (body.length < 80) return false;
    return !isSignedOutFlowRoute();
  }
  if (body.includes('project genie') && body.includes('flow') && body.includes('musicfx')) {
    return true;
  }

  return Boolean(
    findByText('button, a, [role="button"]', (text) => (
      text.includes('launch flow')
      || text.includes('launch genie')
      || text.includes('launch musicfx')
    ))
  );
}

function isAuthenticated() {
  if (!onLabsPage()) return false;
  if (!document.body || document.readyState === 'loading') return false;
  if (findGoogleSignInButton()) return false;
  return hasLabsLaunchSurface();
}

async function checkAuthorization() {
  const storedTicket = loadStoredTicket();
  if (storedTicket) {
    const activation = await msg({
      type: 'TOOL_HUB_ACTIVATE_LAUNCH',
      toolSlug: TOOL_SLUG,
      hostname: window.location.hostname,
      pageUrl: window.location.href,
      extensionTicket: storedTicket,
    });
    if (activation?.ok && activation.authorized) {
      return {
        authorized: true,
        prepared: Boolean(activation.prepared),
        expiresAt: Number(activation.expiresAt || 0),
        authTransitionAt: Number(activation.authTransitionAt || 0),
      };
    }
  }

  const response = await msg({
    type: 'TOOL_HUB_GET_LAUNCH_STATE',
    toolSlug: TOOL_SLUG,
    hostname: window.location.hostname,
    pageUrl: window.location.href,
  });

  return {
    authorized: Boolean(response?.ok && response.authorized),
    prepared: Boolean(response?.ok && response.authorized && response.prepared),
    expiresAt: Number(response?.ok && response.authorized ? response.expiresAt || 0 : 0),
    authTransitionAt: Number(response?.ok && response.authorized ? response.authTransitionAt || 0 : 0),
  };
}

async function refreshAuthorizationState() {
  try {
    const auth = await checkAuthorization();
    CTX.prepared = Boolean(auth.prepared);
    CTX.expiresAt = Number(auth.expiresAt || 0);
    CTX.authTransitionAt = Number(auth.authTransitionAt || 0);
    return auth;
  } catch {
    CTX.authTransitionAt = 0;
    return { authorized: false, prepared: false, expiresAt: 0, authTransitionAt: 0 };
  }
}

let credFetchPromise = null;

function clearCredentialCache() {
  credFetchPromise = null;
  CTX.credential = null;
}

async function loadCredential() {
  if (CTX.credential) return CTX.credential;
  if (credFetchPromise) return credFetchPromise;

  credFetchPromise = msg({
    type: 'TOOL_HUB_GET_CREDENTIAL',
    toolSlug: TOOL_SLUG,
    hostname: window.location.hostname,
    pageUrl: window.location.href,
    extensionTicket: loadStoredTicket(),
  })
    .then((response) => {
      credFetchPromise = null;
      if (!response?.ok) {
        throw new Error(response?.error || 'Credential unavailable');
      }
      CTX.credential = response.data?.credential || null;
      return CTX.credential;
    })
    .catch((error) => {
      credFetchPromise = null;
      throw error;
    });

  return credFetchPromise;
}

async function clearFlowSession(options = {}) {
  return msg({
    type: 'TOOL_HUB_CLEAR_TOOL_SESSION',
    toolSlug: TOOL_SLUG,
    preserveLaunch: Boolean(options.preserveLaunch),
    includeGoogle: Boolean(options.includeGoogle),
  });
}

async function clearFlowSessionSafe(options = {}) {
  clearCredentialCache();
  clearCheckpoint();
  clearUnauthorizedResetAttempt();
  clearForcedReauthAttempt();
  const response = await clearFlowSession({
    preserveLaunch: Boolean(options.preserveLaunch),
    includeGoogle: Boolean(options.includeGoogle),
  });
  if (response?.ok) CTX.sessionClearDone = true;
  return response;
}

async function markFreshSessionPrepared() {
  const response = await msg({ type: 'TOOL_HUB_MARK_FRESH_SESSION_PREPARED', toolSlug: TOOL_SLUG });
  if (response?.ok) CTX.prepared = true;
  return Boolean(response?.ok);
}

async function cleanupFlowSessionOnFinish({ includeGoogle = false } = {}) {
  const response = await clearFlowSession({ includeGoogle, preserveLaunch: false });
  if (!response?.ok) {
    setStatus(`Flow cleanup failed: ${response?.error || 'unknown error'}`);
    return false;
  }

  CTX.credential = null;
  CTX.submitAt = 0;
  CTX.submitLockUntil = 0;
  CTX.launchRetries = 0;
  clearCheckpoint();
  clearUnauthorizedResetAttempt();
  clearForcedReauthAttempt();
  clearTicket();

  try {
    window.sessionStorage.removeItem(EXTENSION_TICKET_KEY);
    window.sessionStorage.removeItem(CHECKPOINT_KEY);
    window.sessionStorage.removeItem(UNAUTHORIZED_RESET_KEY);
    window.sessionStorage.removeItem(FORCED_REAUTH_KEY);
  } catch {}

  setStatus('Flow session cleaned');
  return true;
}

function stop(message, phase = P.DONE) {
  CTX.phase = phase;
  CTX.stopped = true;
  if (CTX.timer) {
    window.clearTimeout(CTX.timer);
    CTX.timer = null;
  }
  if (CTX.keepAlive) {
    window.clearInterval(CTX.keepAlive);
    CTX.keepAlive = null;
  }
  if (CTX.observer) {
    CTX.observer.disconnect();
    CTX.observer = null;
  }
  clearCheckpoint();
  clearUnauthorizedResetAttempt();
  clearForcedReauthAttempt();
  clearFlowEntryClickAttempt();
  clearOneGoogleRedirectAttempt();
  clearTicket();
  setStatus(message);
}

function stopSilently(phase = P.BLOCKED) {
  CTX.phase = phase;
  CTX.stopped = true;
  if (CTX.timer) {
    window.clearTimeout(CTX.timer);
    CTX.timer = null;
  }
  if (CTX.keepAlive) {
    window.clearInterval(CTX.keepAlive);
    CTX.keepAlive = null;
  }
  if (CTX.observer) {
    CTX.observer.disconnect();
    CTX.observer = null;
  }
  clearCheckpoint();
  clearForcedReauthAttempt();
  clearFlowEntryClickAttempt();
  clearOneGoogleRedirectAttempt();
  clearTicket();
}

function canTreatCurrentSessionAsSuccess() {
  return CTX.phase === P.WAIT_REDIRECT || cameFromGoogle() || hasRecentAuthTransition();
}

function hasRecentAuthTransition(maxAgeMs = 120000) {
  return Number(CTX.authTransitionAt || 0) > 0
    && (Date.now() - Number(CTX.authTransitionAt || 0)) < maxAgeMs;
}

function forceFreshGoogleSignIn() {
  if (hasRecentForcedReauthAttempt()) {
    stop('Existing browser Google session is taking over. Sign out of Google in this Chrome profile and launch Flow again.', P.BLOCKED);
    return true;
  }

  const targetUrl = buildForcedGoogleIdentifierUrl();
  clearCheckpoint();
  markForcedReauthAttempt();
  setStatus('Existing Google session detected. Forcing fresh sign-in...');
  window.location.replace(targetUrl);
  return true;
}

async function handleUnauthorizedAuthenticatedVisit() {
  if (!onLabsPage()) {
    stopSilently(P.BLOCKED);
    return;
  }

  if (onFlowToolPage() && isSignedOutFlowRoute()) {
    setStatus('Flow is still on the public entry page. Continuing sign-in...');
    CTX.phase = P.OPEN_GOOGLE;
    wake(0);
    return;
  }

  if (hasRecentUnauthorizedResetAttempt()) {
    stop('Launch this tool from the dashboard first', P.BLOCKED);
    return;
  }

  setStatus('Direct Flow access is blocked. Clearing session...');
  await cleanupFlowSessionOnFinish();
  markUnauthorizedResetAttempt();
  window.location.replace(LOGIN_URL);
}

function wake(delay = 0) {
  if (CTX.stopped || CTX.timer) return;
  CTX.timer = window.setTimeout(run, Math.max(0, delay));
}

async function run() {
  CTX.timer = null;
  if (CTX.stopped || CTX.busy) return;

  const now = Date.now();
  if (now - CTX.lastRunAt < MIN_RUN_GAP_MS) {
    wake(MIN_RUN_GAP_MS - (now - CTX.lastRunAt));
    return;
  }

  CTX.lastRunAt = now;
  CTX.busy = true;
  try {
    await tick();
  } catch (error) {
    setStatus(`Error: ${error?.message || 'Unknown'}`);
    wake(2000);
  } finally {
    CTX.busy = false;
  }
}

async function tick() {
  if (isAuthenticated()) {
    if (!hasLaunchEvidence()) {
      const auth = await refreshAuthorizationState();
      if (auth.authorized) {
        if (canTreatCurrentSessionAsSuccess()) {
          stop('Signed in successfully', P.DONE);
          return;
        }
        forceFreshGoogleSignIn();
        return;
      }
      await handleUnauthorizedAuthenticatedVisit();
      return;
    }
    if (canTreatCurrentSessionAsSuccess()) {
      stop('Signed in successfully', P.DONE);
      return;
    }
    forceFreshGoogleSignIn();
    return;
  }
  

  switch (CTX.phase) {
    case P.BOOT: {
      CTX.ticket = captureTicket();
      const checkpoint = readCheckpoint();
      if (checkpoint?.phase) {
        CTX.phase = checkpoint.phase;
        CTX.submitAt = Number(checkpoint.submitAt || 0);
        CTX.submitLockUntil = Number(checkpoint.submitLockUntil || 0);
        wake(300);
        return;
      }
      CTX.phase = P.AUTHORIZE;
      wake(0);
      return;
    }

    case P.AUTHORIZE: {
      const flowPageContext = hasFlowPageContext();
      if (!flowPageContext && !onGooglePage()) {
        stopSilently(P.BLOCKED);
        return;
      }

      if (flowPageContext) {
        setStatus('Checking dashboard authorization...');
      }
      let auth;
      try {
        auth = await checkAuthorization();
      } catch {
        auth = { authorized: false, prepared: false, expiresAt: 0 };
      }

      CTX.prepared = Boolean(auth.prepared);
      CTX.expiresAt = Number(auth.expiresAt || 0);
      CTX.authTransitionAt = Number(auth.authTransitionAt || 0);

      if (!auth.authorized && !flowPageContext) {
        stopSilently(P.BLOCKED);
        return;
      }

      if (!auth.authorized) {
        CTX.launchRetries += 1;
        if (CTX.launchRetries > MAX_LAUNCH_RETRIES) {
          stop('Launch this tool from the dashboard first', P.BLOCKED);
          return;
        }

        setStatus('Launch this tool from the dashboard first');
        wake(1200);
        return;
      }

      clearUnauthorizedResetAttempt();
      CTX.phase = P.PREPARE_SESSION;
      wake(0);
      return;
    }

    case P.PREPARE_SESSION: {
      if (CTX.expiresAt && !CTX.prepared && !CTX.sessionClearDone) {
        setStatus('Preparing fresh Flow session...');
        const cleared = await clearFlowSessionSafe({ preserveLaunch: true, includeGoogle: true });
        if (!cleared?.ok) {
          setStatus(`Flow session clear failed: ${cleared?.error || 'unknown error'}`);
          wake(1500);
          return;
        }
        await markFreshSessionPrepared();
        setStatus('Fresh Flow session prepared. Reloading sign-in...');
        window.location.replace(LOGIN_URL);
        return;
      }

      if (isAuthenticated()) {
        forceFreshGoogleSignIn();
        return;
      }

      CTX.phase = P.LOAD_CRED;
      wake(0);
      return;
    }

    case P.LOAD_CRED: {
      setStatus('Fetching credentials...');
      try {
        const credential = await loadCredential();
        if (!credential?.loginIdentifier || !credential?.password) {
          setStatus('Credential missing');
          wake(2000);
          return;
        }
      } catch (error) {
        const message = error?.message || 'Unavailable';
        if (message.toLowerCase().includes('dashboard first')) {
          CTX.credential = null;
          CTX.prepared = false;
          CTX.expiresAt = 0;
          CTX.phase = P.AUTHORIZE;
          setStatus('Launch expired. Re-checking authorization...');
          wake(1200);
          return;
        }

        setStatus(`Credential error: ${message}`);
        wake(2000);
        return;
      }

      if (onLabsPage()) CTX.phase = P.OPEN_GOOGLE;
      else if (findUseAnotherAccountButton()) CTX.phase = P.CHOOSER;
      else if (findEmailInput()) CTX.phase = P.EMAIL;
      else if (findPasswordInput()) CTX.phase = P.PASSWORD;
      else CTX.phase = P.OPEN_GOOGLE;
      wake(0);
      return;
    }

    case P.OPEN_GOOGLE: {
      if (onOneGoogleFlowOfferPage()) {
        redirectOneGoogleOfferToFlow();
        return;
      }

      if (onLabsHomePage()) {
        setStatus('Opening Flow tool...');
        window.location.replace(attachExtensionTicket(FLOW_TOOL_URL));
        return;
      }
      if (findPasswordInput()) {
        CTX.phase = P.PASSWORD;
        wake(0);
        return;
      }
      if (findEmailInput()) {
        CTX.phase = P.EMAIL;
        wake(0);
        return;
      }
      if (findUseAnotherAccountButton()) {
        CTX.phase = P.CHOOSER;
        wake(0);
        return;
      }

      if (!onLabsPage()) {
        setStatus('Opening Labs Flow...');
        window.location.replace(LOGIN_URL);
        return;
      }

      const signInButton = findGoogleSignInButton();
      const isFlowEntry = onFlowToolPage() && isSignedOutFlowRoute();
      if (!signInButton) {
        if (isFlowEntry) {
          setStatus('Waiting for Flow entry button...');
          wake(SCREEN_WAIT_MS);
          return;
        }
        setStatus('Waiting for Labs sign-in button...');
        wake(SCREEN_WAIT_MS);
        return;
      }

      setStatus(isFlowEntry ? 'Opening Flow entry...' : 'Clicking Labs sign-in...');
      console.debug('[RMW Flow Google] Labs sign-in target', signInButton, signInButton?.outerHTML || '');
      maybeForceGoogleAccountSelection(signInButton);

      if (isFlowEntry && safeClick(signInButton)) {
        markFlowEntryClickAttempt();
        const submittedAt = Date.now();
        const submitLockUntil = submittedAt + SUBMIT_LOCK_MS;
        writeCheckpoint({
          phase: P.WAIT_REDIRECT,
          submitAt: submittedAt,
          submitLockUntil,
        });
        CTX.submitAt = submittedAt;
        CTX.submitLockUntil = submitLockUntil;
        CTX.phase = P.WAIT_REDIRECT;
        wake(LABS_SIGNIN_WAIT_MS);
        return;
      }

      if (isFlowEntry) {
        setStatus('Flow entry button not clickable yet...');
        wake(SCREEN_WAIT_MS);
        return;
      }

      const signInUrl = attachExtensionTicket(resolveActionUrl(signInButton));
      if (signInUrl) {
        setStatus(isFlowEntry ? 'Opening Flow destination...' : 'Opening Labs sign-in...');
        writeCheckpoint({ phase: P.CHOOSER });
        window.location.assign(signInUrl);
        return;
      }
      if (!safeClick(signInButton)) {
        setStatus('Labs sign-in button not clickable yet...');
        wake(SCREEN_WAIT_MS);
        return;
      }
      console.debug('[RMW Flow Google] Clicked Labs sign-in, URL:', window.location.href);
      writeCheckpoint({ phase: P.CHOOSER });
      CTX.phase = P.CHOOSER;
      wake(LABS_SIGNIN_WAIT_MS);
      return;
    }

    case P.CHOOSER: {
      if (onFlowToolPage() && isSignedOutFlowRoute()) {
        const flowEntryAttempts = getRecentFlowEntryClickAttemptCount();
        if (flowEntryAttempts >= MAX_FLOW_ENTRY_AUTO_RETRIES) {
          stop('Flow returned to the landing page after sign-in. Click Create with Flow once manually.', P.DONE);
          return;
        }
        setStatus(
          flowEntryAttempts > 0
            ? `Flow returned to landing page after sign-in. Retrying Create with Flow (${flowEntryAttempts + 1}/${MAX_FLOW_ENTRY_AUTO_RETRIES})...`
            : 'Flow returned to landing page. Continuing sign-in...'
        );
        CTX.phase = P.OPEN_GOOGLE;
        wake(flowEntryAttempts > 0 ? 1200 : 0);
        return;
      }

      if (findPasswordInput()) {
        CTX.phase = P.PASSWORD;
        wake(0);
        return;
      }
      if (findEmailInput()) {
        CTX.phase = P.EMAIL;
        wake(0);
        return;
      }

      if (findLabsModalSignInButton()) {
        setStatus('Labs modal sign-in is still visible. Retrying...');
        CTX.phase = P.OPEN_GOOGLE;
        wake(0);
        return;
      }

      const anotherAccount = findUseAnotherAccountButton();
      if (anotherAccount) {
        setStatus('Clicking Use another account...');
        if (!safeClick(anotherAccount)) {
          setStatus('Use another account is not clickable yet...');
          wake(SCREEN_WAIT_MS);
          return;
        }
        CTX.phase = P.EMAIL;
        writeCheckpoint({ phase: P.EMAIL });
        wake(1000);
        return;
      }

      const tryAnotherWayButton = findTryAnotherWayButton();
      if (tryAnotherWayButton) {
        setStatus('Trying alternate Google chooser...');
        if (!safeClick(tryAnotherWayButton)) {
          setStatus('Try another way is not clickable yet...');
          wake(SCREEN_WAIT_MS);
          return;
        }
        writeCheckpoint({ phase: P.CHOOSER });
        wake(900);
        return;
      }

      const passwordChoiceButton = findPasswordChoiceButton();
      if (passwordChoiceButton) {
        setStatus('Waiting for Google account switch option...');
        wake(SCREEN_WAIT_MS);
        return;
      }

      setStatus(onGooglePage() ? 'Waiting for account chooser...' : 'Waiting for Google account page...');
      wake(SCREEN_WAIT_MS);
      return;
    }

    case P.EMAIL: {
      clearForcedReauthAttempt();
      if (findPasswordInput()) {
        CTX.phase = P.PASSWORD;
        wake(0);
        return;
      }

      const emailInput = findEmailInput();
      if (!emailInput) {
        setStatus('Waiting for Google email field...');
        wake(SCREEN_WAIT_MS);
        return;
      }

      if (!CTX.credential?.loginIdentifier) {
        CTX.phase = P.LOAD_CRED;
        wake(0);
        return;
      }

      const emailValue = getGoogleEmailValue(CTX.credential.loginIdentifier, emailInput);
      if (!valuesMatch(emailInput.value, emailValue)) {
        fillField(emailInput, emailValue);
      }

      const nextButton = findNextButton('email', emailInput);

      setStatus(nextButton ? 'Submitting email...' : 'Submitting email with Enter fallback...');
      const submittedAt = Date.now();
      const submitLockUntil = submittedAt + SUBMIT_LOCK_MS;
      if (!submitStep(nextButton, emailInput)) {
        setStatus('Email is filled. Waiting for a submit control...');
        wake(300);
        return;
      }
      writeCheckpoint({
        phase: P.PASSWORD,
        submitAt: submittedAt,
        submitLockUntil,
      });
      CTX.submitAt = submittedAt;
      CTX.submitLockUntil = submitLockUntil;
      CTX.phase = P.PASSWORD;
      wake(1200);
      return;
    }

    case P.PASSWORD: {
      clearForcedReauthAttempt();
      const passwordInput = findPasswordInput();
      if (!passwordInput) {
        const passwordChoiceButton = findPasswordChoiceButton();
        if (passwordChoiceButton) {
          setStatus('Opening password sign-in option...');
          if (!safeClick(passwordChoiceButton)) {
            setStatus('Password sign-in option not clickable yet...');
            wake(SCREEN_WAIT_MS);
            return;
          }
          wake(900);
          return;
        }

        const tryAnotherWayButton = findTryAnotherWayButton();
        if (tryAnotherWayButton) {
          setStatus('Trying alternate Google sign-in option...');
          if (!safeClick(tryAnotherWayButton)) {
            setStatus('Try another way is not clickable yet...');
            wake(SCREEN_WAIT_MS);
            return;
          }
          wake(900);
          return;
        }

        if (findEmailInput()) {
          CTX.phase = P.EMAIL;
          wake(0);
          return;
        }

        if (findUseAnotherAccountButton()) {
          CTX.phase = P.CHOOSER;
          wake(0);
          return;
        }

        if (Date.now() < CTX.submitLockUntil) {
          setStatus('Waiting for password screen...');
          wake(400);
          return;
        }
        setStatus('Password screen not found yet...');
        wake(SCREEN_WAIT_MS);
        return;
      }

      if (!CTX.credential?.password) {
        CTX.phase = P.LOAD_CRED;
        wake(0);
        return;
      }

      if (!valuesMatch(passwordInput.value, CTX.credential.password)) {
        fillField(passwordInput, CTX.credential.password);
      }

      const nextButton = findNextButton('password', passwordInput);

      setStatus(nextButton ? 'Submitting password...' : 'Submitting password with Enter fallback...');
      const submittedAt = Date.now();
      const submitLockUntil = submittedAt + SUBMIT_LOCK_MS;
      if (!submitStep(nextButton, passwordInput)) {
        setStatus('Password is filled. Waiting for a submit control...');
        wake(300);
        return;
      }
      writeCheckpoint({
        phase: P.WAIT_REDIRECT,
        submitAt: submittedAt,
        submitLockUntil,
      });
      CTX.submitAt = submittedAt;
      CTX.submitLockUntil = submitLockUntil;
      CTX.phase = P.WAIT_REDIRECT;
      wake(1500);
      return;
    }

    case P.WAIT_REDIRECT: {
      const elapsed = Date.now() - CTX.submitAt;

      if (onFlowToolPage() && isSignedOutFlowRoute()) {
        const auth = await refreshAuthorizationState();
        if (auth.authorized && hasRecentAuthTransition()) {
          const flowEntryAttempts = getRecentFlowEntryClickAttemptCount();
          if (flowEntryAttempts >= MAX_FLOW_ENTRY_AUTO_RETRIES) {
            stop('Flow returned to the landing page after sign-in. Click Create with Flow once manually.', P.DONE);
            return;
          }
          setStatus(
            flowEntryAttempts > 0
              ? `Google accepted sign-in. Retrying Flow entry (${flowEntryAttempts + 1}/${MAX_FLOW_ENTRY_AUTO_RETRIES})...`
              : 'Google accepted sign-in. Re-entering Flow...'
          );
          CTX.phase = P.OPEN_GOOGLE;
          wake(flowEntryAttempts > 0 ? 1200 : 0);
          return;
        }
      }

      if (isAuthenticated()) {
        stop('Signed in successfully', P.DONE);
        return;
      }

      if (hasSignedInGoogleAccount()) {
        setStatus('Google accepted login. Waiting for Labs Flow...');
        wake(1000);
        return;
      }

      if (findPasswordChoiceButton() && elapsed > 1200) {
        CTX.submitLockUntil = 0;
        CTX.phase = P.PASSWORD;
        wake(0);
        return;
      }

      if (findTryAnotherWayButton() && elapsed > 1200) {
        CTX.submitLockUntil = 0;
        CTX.phase = P.PASSWORD;
        wake(0);
        return;
      }

      if (findPasswordInput() && elapsed > 1200) {
        CTX.submitLockUntil = 0;
        CTX.phase = P.PASSWORD;
        wake(0);
        return;
      }

      if (findEmailInput() && elapsed > 1200) {
        CTX.submitLockUntil = 0;
        CTX.phase = P.EMAIL;
        wake(0);
        return;
      }

      if (findUseAnotherAccountButton() && elapsed > 1200) {
        CTX.submitLockUntil = 0;
        CTX.phase = P.CHOOSER;
        wake(0);
        return;
      }

      if (onLabsPage() && findGoogleSignInButton() && elapsed > 3000) {
        setStatus('Back on Labs sign-in screen. Retrying...');
        CTX.phase = P.OPEN_GOOGLE;
        wake(0);
        return;
      }

      if (elapsed > 12000) {
        setStatus('Login timed out. Retrying...');
        CTX.phase = P.OPEN_GOOGLE;
        wake(0);
        return;
      }

      setStatus('Waiting for Labs Flow to load...');
      wake(600);
      return;
    }

    case P.DONE:
    case P.BLOCKED:
    default:
      return;
  }
}

function onMutation() {
  if (CTX.stopped) return;
  const now = Date.now();
  if (now - CTX.lastMutationAt < MUTATION_DEBOUNCE_MS) return;
  CTX.lastMutationAt = now;
  if ([P.OPEN_GOOGLE, P.CHOOSER, P.EMAIL, P.PASSWORD, P.WAIT_REDIRECT].includes(CTX.phase)) {
    wake(100);
  }
}

function start() {
  globalThis.cleanupFlowSessionOnFinish = cleanupFlowSessionOnFinish;
  CTX.ticket = captureTicket();
  if (onGooglePage()) return;
  ensureBadge();
  setStatus('Booting Flow auto-login');
  if (onOneGoogleFlowOfferPage()) {
    redirectOneGoogleOfferToFlow();
    return;
  }
  if (onLabsHomePage() && hasLaunchEvidence()) {
    setStatus('Opening Flow tool...');
    window.location.replace(attachExtensionTicket(FLOW_TOOL_URL, CTX.ticket || loadStoredTicket()));
    return;
  }
  installLabsOpenBridge();
  CTX.observer = new MutationObserver(onMutation);
  CTX.observer.observe(document.body || document.documentElement, {
    childList: true,
    subtree: true,
    attributes: false,
  });
  CTX.keepAlive = window.setInterval(() => {
    if (!CTX.stopped && !CTX.busy && !CTX.timer) {
      wake(0);
    }
  }, KEEP_ALIVE_MS);
  wake(0);
}

start();
