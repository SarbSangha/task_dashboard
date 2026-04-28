const DEFAULT_API_BASE = 'https://dashboard.ritzmediaworld.in';
const ACTIVE_TAB_LAUNCHES_STORAGE_KEY = 'activeExtensionTabLaunches';
const PASSWORD_SAVING_STATE_STORAGE_KEY = 'passwordSavingSuppressionState';
const FLOW_HOME_URL = 'https://labs.google/fx';
const FLOW_DIRECT_ROUTE_URL = 'https://labs.google/fx/tools/flow';
const CREDENTIAL_CONTINUATION_LIMIT = 6;
const TOOL_SESSION_DOMAINS = {
  envato: ['envato.com', 'elements.envato.com', 'market.envato.com'],
  freepik: ['freepik.com', 'www.freepik.com'],
  flow: ['labs.google'],
  higgsfield: ['higgsfield.ai', 'app.higgsfield.ai', 'beta.higgsfield.ai'],
  heygen: ['heygen.com', 'auth.heygen.com', 'app.heygen.com'],
  'kling-ai': ['kling.ai', 'www.kling.ai', 'klingai.com', 'www.klingai.com', 'app.klingai.com'],
  klingai: ['kling.ai', 'www.kling.ai', 'klingai.com', 'www.klingai.com', 'app.klingai.com'],
};
const TOOL_OPTIONAL_SESSION_DOMAINS = {
  flow: ['accounts.google.com', 'google.com', '.google.com'],
};
const TOOL_LOGIN_CONTINUATION_HOSTS = {
  chatgpt: [
    'chatgpt.com',
    'chat.openai.com',
    'auth.openai.com',
    'accounts.google.com',
    'login.microsoftonline.com',
    'login.live.com',
    'login.microsoft.com',
  ],
  envato: [
    'envato.com',
    'elements.envato.com',
    'market.envato.com',
  ],
  freepik: [
    'freepik.com',
    'www.freepik.com',
    'accounts.google.com',
  ],
  higgsfield: [
    'higgsfield.ai',
    'app.higgsfield.ai',
    'beta.higgsfield.ai',
  ],
  heygen: [
    'heygen.com',
    'auth.heygen.com',
    'app.heygen.com',
  ],
  flow: [
    'labs.google',
    'accounts.google.com',
  ],
  'kling-ai': [
    'kling.ai',
    'www.kling.ai',
    'klingai.com',
    'www.klingai.com',
    'app.klingai.com',
  ],
  klingai: [
    'kling.ai',
    'www.kling.ai',
    'klingai.com',
    'www.klingai.com',
    'app.klingai.com',
  ],
};

function decodeExtensionTicketPayload(ticket) {
  const rawTicket = `${ticket || ''}`.trim();
  if (!rawTicket) return null;

  const [body] = rawTicket.split('.', 1);
  if (!body) return null;

  try {
    const normalized = body.replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
    const decoded = atob(padded);
    const payload = JSON.parse(decoded);
    return payload && typeof payload === 'object' ? payload : null;
  } catch {
    return null;
  }
}

function buildLaunchFromExtensionTicket(toolSlug, hostname, extensionTicket) {
  const payload = decodeExtensionTicketPayload(extensionTicket);
  const expiresAt = Number(payload?.exp || 0) * 1000;
  if (!payload || payload.kind !== 'extension_autofill' || !Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
    return null;
  }

  return {
    toolSlug,
    hostname,
    ticket: `${extensionTicket}`.trim(),
    expiresAt,
  };
}

function normalizeFlowLaunchUrl(value) {
  const raw = `${value || ''}`.trim();
  if (!raw) return FLOW_DIRECT_ROUTE_URL;

  try {
    const url = new URL(raw);
    if (normalizeToolSlug(url.searchParams.get('rmw_tool_slug')) !== 'flow') {
      url.searchParams.set('rmw_tool_slug', 'flow');
    }
    if (url.origin === 'https://labs.google' && /^\/fx\/?$/.test(url.pathname)) {
      url.pathname = '/fx/tools/flow';
    }
    if (url.origin === 'https://labs.google' && url.href === FLOW_HOME_URL) {
      return FLOW_DIRECT_ROUTE_URL;
    }
    return url.toString();
  } catch {
    return FLOW_DIRECT_ROUTE_URL;
  }
}

function normalizeToolSlug(value) {
  return `${value || ''}`.trim().toLowerCase();
}

function normalizeHostname(value) {
  const raw = `${value || ''}`.trim().toLowerCase();
  if (!raw) return '';

  try {
    const url = raw.includes('://') ? new URL(raw) : new URL(`https://${raw}`);
    return `${url.hostname || ''}`.replace(/^www\./, '');
  } catch {
    return raw.replace(/^www\./, '').split('/')[0];
  }
}

function normalizeApiBase(value) {
  const raw = `${value || ''}`.trim();
  if (!raw) return '';

  try {
    const url = new URL(raw);
    return `${url.origin}`.replace(/\/+$/, '');
  } catch {
    return '';
  }
}

function toCookieUrl(value) {
  const raw = `${value || ''}`.trim();
  if (!raw) return '';

  try {
    const url = new URL(raw);
    if (!/^https?:$/i.test(url.protocol)) {
      return '';
    }
    return `${url.origin}/`;
  } catch {
    return '';
  }
}

function buildAuthCookieCandidateUrls(apiBase, dashboardUrl) {
  const seen = new Set();
  const urls = [];

  [apiBase, dashboardUrl, DEFAULT_API_BASE].forEach((value) => {
    const nextUrl = toCookieUrl(value);
    if (!nextUrl || seen.has(nextUrl)) {
      return;
    }
    seen.add(nextUrl);
    urls.push(nextUrl);
  });

  return urls;
}

async function readSessionTokenFromCookies(apiBase, dashboardUrl) {
  const candidateUrls = buildAuthCookieCandidateUrls(apiBase, dashboardUrl);

  for (const url of candidateUrls) {
    try {
      const cookie = await chrome.cookies.get({
        url,
        name: 'session_id',
      });
      const value = `${cookie?.value || ''}`.trim();
      if (value) {
        return value;
      }
    } catch {
      // Ignore cookie lookup failures and continue through other candidate origins.
    }
  }

  return '';
}

async function syncAuthContext(message = {}) {
  const apiBase = normalizeApiBase(message.apiBase) || DEFAULT_API_BASE;
  const dashboardUrl = `${message.dashboardUrl || ''}`.trim();
  let sessionToken = `${message.sessionToken || ''}`.trim();

  if (!sessionToken) {
    sessionToken = await readSessionTokenFromCookies(apiBase, dashboardUrl);
  }

  const stored = await chrome.storage.local.get(['apiBase', 'sessionToken', 'sessionTokenSyncedAt']);
  const nextValues = {};
  const removeKeys = [];

  if (`${stored.apiBase || ''}`.trim() !== apiBase) {
    nextValues.apiBase = apiBase;
  }

  if (sessionToken) {
    if (`${stored.sessionToken || ''}`.trim() !== sessionToken) {
      nextValues.sessionToken = sessionToken;
    }
    nextValues.sessionTokenSyncedAt = Date.now();
  } else if (`${stored.sessionToken || ''}`.trim()) {
    removeKeys.push('sessionToken');
    removeKeys.push('sessionTokenSyncedAt');
  }

  if (removeKeys.length > 0) {
    await chrome.storage.local.remove(removeKeys);
  }

  if (Object.keys(nextValues).length > 0) {
    await chrome.storage.local.set(nextValues);
  }

  return {
    apiBase,
    sessionToken,
  };
}

function hostnameFromPageUrl(value) {
  const raw = `${value || ''}`.trim();
  if (!raw) return '';

  try {
    return normalizeHostname(new URL(raw).hostname);
  } catch {
    return '';
  }
}

function isLoginContinuationPage(toolSlug, pageUrl, hostname) {
  const allowedHosts = TOOL_LOGIN_CONTINUATION_HOSTS[normalizeToolSlug(toolSlug)] || [];
  if (!allowedHosts.length) return false;

  const pageHost = hostnameFromPageUrl(pageUrl) || normalizeHostname(hostname);
  return Boolean(pageHost && allowedHosts.includes(pageHost));
}

function resolvePendingLaunchKey(launches, toolSlug, hostname) {
  const normalizedSlug = normalizeToolSlug(toolSlug);
  if (normalizedSlug && launches[normalizedSlug]?.ticket) {
    return normalizedSlug;
  }

  const normalizedHostname = normalizeHostname(hostname);
  if (!normalizedHostname) {
    return '';
  }

  return Object.keys(launches).find((key) => normalizeHostname(launches[key]?.hostname) === normalizedHostname) || '';
}

async function consumePendingLaunch(toolSlug, hostname) {
  if (!normalizeToolSlug(toolSlug) && !normalizeHostname(hostname)) {
    throw new Error('Launch this tool from the dashboard first.');
  }

  const stored = await chrome.storage.local.get(['pendingExtensionLaunches']);
  const launches = { ...(stored.pendingExtensionLaunches || {}) };
  const now = Date.now();
  let changed = false;

  Object.keys(launches).forEach((key) => {
    const item = launches[key];
    if (!item || Number(item.expiresAt || 0) <= now || Number(item.remainingUses || 0) <= 0) {
      delete launches[key];
      changed = true;
    }
  });

  const launchKey = resolvePendingLaunchKey(launches, toolSlug, hostname);
  const launch = launches[launchKey];
  if (!launch?.ticket) {
    if (changed) {
      await chrome.storage.local.set({ pendingExtensionLaunches: launches });
    }
    throw new Error('Launch this tool from the dashboard first.');
  }

  launch.remainingUses = Math.max(0, Number(launch.remainingUses || 0) - 1);
  if (launch.remainingUses <= 0) {
    delete launches[launchKey];
  } else {
    launches[launchKey] = launch;
  }

  await chrome.storage.local.set({ pendingExtensionLaunches: launches });
  return launch.ticket;
}

async function getPendingLaunch(toolSlug, hostname) {
  const stored = await chrome.storage.local.get(['pendingExtensionLaunches']);
  const launches = { ...(stored.pendingExtensionLaunches || {}) };
  const now = Date.now();
  let changed = false;

  Object.keys(launches).forEach((key) => {
    const item = launches[key];
    if (!item || Number(item.expiresAt || 0) <= now || Number(item.remainingUses || 0) <= 0) {
      delete launches[key];
      changed = true;
    }
  });

  if (changed) {
    await chrome.storage.local.set({ pendingExtensionLaunches: launches });
  }

  const launchKey = resolvePendingLaunchKey(launches, toolSlug, hostname);
  return launches[launchKey] || null;
}

async function getActiveLaunchMap() {
  const stored = await chrome.storage.local.get([ACTIVE_TAB_LAUNCHES_STORAGE_KEY]);
  const launchMap = { ...(stored[ACTIVE_TAB_LAUNCHES_STORAGE_KEY] || {}) };
  const now = Date.now();
  let changed = false;

  Object.keys(launchMap).forEach((key) => {
    const item = launchMap[key];
    if (!item || Number(item.expiresAt || 0) <= now) {
      delete launchMap[key];
      changed = true;
    }
  });

  if (changed) {
    await chrome.storage.local.set({ [ACTIVE_TAB_LAUNCHES_STORAGE_KEY]: launchMap });
  }

  return launchMap;
}

async function getActiveLaunch(tabId, toolSlug) {
  if (!tabId) return null;
  const launchMap = await getActiveLaunchMap();
  const item = launchMap[`${tabId}`];
  if (!item) return null;
  if (toolSlug && normalizeToolSlug(item.toolSlug) !== normalizeToolSlug(toolSlug)) {
    return null;
  }
  return item;
}

async function getRecentContinuationLaunch(toolSlug, hostname, pageUrl) {
  if (!isLoginContinuationPage(toolSlug, pageUrl, hostname)) {
    return null;
  }

  const now = Date.now();
  const launchMap = await getActiveLaunchMap();
  const matches = Object.values(launchMap)
    .filter((item) => item
      && normalizeToolSlug(item.toolSlug) === normalizeToolSlug(toolSlug)
      && `${item.ticket || ''}`.trim()
      && Number(item.expiresAt || 0) > now
    )
    .sort((left, right) => Number(right.activatedAt || 0) - Number(left.activatedAt || 0));

  if (!matches.length) {
    return null;
  }

  const freshest = matches[0];
  const freshestAgeMs = now - Number(freshest.activatedAt || 0);
  if (freshestAgeMs > 15 * 60 * 1000) {
    return null;
  }

  return freshest;
}

async function getAuthorizedLaunchForTabs(primaryTabId, fallbackTabId, toolSlug, hostname = '', pageUrl = '') {
  const primaryLaunch = await getActiveLaunch(primaryTabId, toolSlug);
  if (primaryLaunch?.ticket) {
    return primaryLaunch;
  }

  if (fallbackTabId && fallbackTabId !== primaryTabId) {
    const fallbackLaunch = await getActiveLaunch(fallbackTabId, toolSlug);
    if (fallbackLaunch?.ticket) {
      if (primaryTabId) {
        await setActiveLaunch(primaryTabId, fallbackLaunch);
      }
      return fallbackLaunch;
    }
  }

  const continuationLaunch = await getRecentContinuationLaunch(toolSlug, hostname, pageUrl);
  if (continuationLaunch?.ticket && primaryTabId) {
    await setActiveLaunch(primaryTabId, continuationLaunch);
  }
  return continuationLaunch;
}

async function activatePendingLaunchForTab(tabId, toolSlug, hostname, pageUrl) {
  if (!tabId) return null;

  const resolvedHostname = hostnameFromPageUrl(pageUrl) || normalizeHostname(hostname);
  const storedLaunch = await getPendingLaunch(toolSlug, resolvedHostname);
  if (!storedLaunch?.ticket) {
    return null;
  }

  await consumePendingLaunch(toolSlug, resolvedHostname);
  const launch = {
    toolSlug: normalizeToolSlug(toolSlug) || normalizeToolSlug(storedLaunch.toolSlug),
    hostname: resolvedHostname || normalizeHostname(storedLaunch.hostname),
    ticket: `${storedLaunch.ticket}`.trim(),
    expiresAt: Number(storedLaunch.expiresAt || 0),
  };
  await setActiveLaunch(tabId, launch);
  return launch;
}

async function setActiveLaunch(tabId, launch) {
  if (!tabId || !launch?.ticket || !launch?.expiresAt) return;
  const launchMap = await getActiveLaunchMap();
  const existingLaunch = launchMap[`${tabId}`] || {};
  const nextTicket = `${launch.ticket}`.trim();
  const sameTicket = `${existingLaunch.ticket || ''}`.trim() === nextTicket;
  launchMap[`${tabId}`] = {
    toolSlug: normalizeToolSlug(launch.toolSlug),
    ticket: nextTicket,
    expiresAt: Number(launch.expiresAt || 0),
    hostname: normalizeHostname(launch.hostname),
    activatedAt: Date.now(),
    freshSessionPreparedAt: sameTicket ? Number(existingLaunch.freshSessionPreparedAt || 0) : 0,
    authTransitionAt: sameTicket ? Number(existingLaunch.authTransitionAt || 0) : 0,
    directCredentialIssuedAt: sameTicket ? Number(existingLaunch.directCredentialIssuedAt || 0) : 0,
    inheritedCredentialIssuedAt: sameTicket ? Number(existingLaunch.inheritedCredentialIssuedAt || 0) : 0,
    credentialContinuationCount: sameTicket ? Number(existingLaunch.credentialContinuationCount || 0) : 0,
  };
  await chrome.storage.local.set({ [ACTIVE_TAB_LAUNCHES_STORAGE_KEY]: launchMap });
}

async function clearActiveLaunch(tabId, toolSlug = '') {
  if (!tabId) return;
  const launchMap = await getActiveLaunchMap();
  const key = `${tabId}`;
  const current = launchMap[key];
  if (!current) return;
  if (toolSlug && normalizeToolSlug(current.toolSlug) !== normalizeToolSlug(toolSlug)) {
    return;
  }
  delete launchMap[key];
  await chrome.storage.local.set({ [ACTIVE_TAB_LAUNCHES_STORAGE_KEY]: launchMap });
}

async function markFreshSessionPrepared(tabId, toolSlug = '') {
  if (!tabId) return false;
  const launchMap = await getActiveLaunchMap();
  const key = `${tabId}`;
  const current = launchMap[key];
  if (!current) return false;
  if (toolSlug && normalizeToolSlug(current.toolSlug) !== normalizeToolSlug(toolSlug)) {
    return false;
  }

  current.freshSessionPreparedAt = Date.now();
  launchMap[key] = current;
  await chrome.storage.local.set({ [ACTIVE_TAB_LAUNCHES_STORAGE_KEY]: launchMap });
  return true;
}

async function markAuthTransition(tabId, toolSlug = '') {
  if (!tabId) return false;
  const launchMap = await getActiveLaunchMap();
  const key = `${tabId}`;
  const current = launchMap[key];
  if (!current) return false;
  if (toolSlug && normalizeToolSlug(current.toolSlug) !== normalizeToolSlug(toolSlug)) {
    return false;
  }

  current.authTransitionAt = Date.now();
  launchMap[key] = current;
  await chrome.storage.local.set({ [ACTIVE_TAB_LAUNCHES_STORAGE_KEY]: launchMap });
  return true;
}

async function markCredentialIssued(tabId, mode = 'direct', isContinuation = false) {
  if (!tabId) return;
  const launchMap = await getActiveLaunchMap();
  const key = `${tabId}`;
  const current = launchMap[key];
  if (!current) return;

  if (mode === 'inherited') {
    current.inheritedCredentialIssuedAt = Date.now();
  } else {
    current.directCredentialIssuedAt = Date.now();
  }

  if (isContinuation) {
    current.credentialContinuationCount = Number(current.credentialContinuationCount || 0) + 1;
  }

  launchMap[key] = current;
  await chrome.storage.local.set({ [ACTIVE_TAB_LAUNCHES_STORAGE_KEY]: launchMap });
}

async function activateLaunchForTab(tabId, toolSlug, hostname, extensionTicket) {
  if (!tabId || !extensionTicket) {
    throw new Error('Dashboard launch ticket required.');
  }

  const activeLaunch = await getActiveLaunch(tabId, toolSlug);
  if (activeLaunch?.ticket === `${extensionTicket}`.trim()) {
    return activeLaunch;
  }

  const storedLaunch = await getPendingLaunch(toolSlug, hostname);
  if (storedLaunch?.ticket && `${storedLaunch.ticket}`.trim() === `${extensionTicket}`.trim()) {
    await consumePendingLaunch(toolSlug, hostname);
    const launch = {
      toolSlug,
      hostname,
      ticket: extensionTicket,
      expiresAt: Number(storedLaunch.expiresAt || 0),
    };
    await setActiveLaunch(tabId, launch);
    return launch;
  }

  const directTicketLaunch = buildLaunchFromExtensionTicket(toolSlug, hostname, extensionTicket);
  if (!directTicketLaunch) {
    throw new Error('Open this tool from the dashboard first.');
  }

  await setActiveLaunch(tabId, directTicketLaunch);
  return directTicketLaunch;
}

function getToolSessionDomains(toolSlug, options = {}) {
  const normalizedSlug = normalizeToolSlug(toolSlug);
  const domains = [...(TOOL_SESSION_DOMAINS[normalizedSlug] || [])];
  if (options.includeGoogle) {
    domains.push(...(TOOL_OPTIONAL_SESSION_DOMAINS[normalizedSlug] || []));
  }
  return Array.from(new Set(domains.filter(Boolean)));
}

async function clearToolSession(toolSlug, options = {}) {
  const domains = getToolSessionDomains(toolSlug, options);
  let removed = 0;

  for (const domain of domains) {
    const cookies = await chrome.cookies.getAll({ domain });
    for (const cookie of cookies) {
      const host = `${cookie.domain || ''}`.replace(/^\./, '');
      if (!host) continue;
      const url = `${cookie.secure ? 'https' : 'http'}://${host}${cookie.path || '/'}`;
      const result = await chrome.cookies.remove({
        url,
        name: cookie.name,
        storeId: cookie.storeId,
      }).catch(() => null);
      if (result) {
        removed += 1;
      }
    }
  }

  return { removed };
}

function getPasswordSavingEnabledDetails() {
  return new Promise((resolve, reject) => {
    if (!chrome.privacy?.services?.passwordSavingEnabled) {
      reject(new Error('Chrome password-saving control is unavailable.'));
      return;
    }

    chrome.privacy.services.passwordSavingEnabled.get({}, (details) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(details || {});
    });
  });
}

function setPasswordSavingEnabled(value) {
  return new Promise((resolve, reject) => {
    if (!chrome.privacy?.services?.passwordSavingEnabled) {
      reject(new Error('Chrome password-saving control is unavailable.'));
      return;
    }

    chrome.privacy.services.passwordSavingEnabled.set({ value }, () => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve();
    });
  });
}

async function getPasswordSavingSuppressionState() {
  const stored = await chrome.storage.local.get([PASSWORD_SAVING_STATE_STORAGE_KEY]);
  const state = stored[PASSWORD_SAVING_STATE_STORAGE_KEY] || {};
  return {
    tabIds: Array.isArray(state.tabIds) ? state.tabIds.map((tabId) => Number(tabId)).filter((tabId) => Number.isFinite(tabId) && tabId > 0) : [],
    previousValue: typeof state.previousValue === 'boolean' ? state.previousValue : true,
  };
}

async function savePasswordSavingSuppressionState(state) {
  await chrome.storage.local.set({
    [PASSWORD_SAVING_STATE_STORAGE_KEY]: {
      tabIds: Array.from(new Set((state.tabIds || []).map((tabId) => Number(tabId)).filter((tabId) => Number.isFinite(tabId) && tabId > 0))),
      previousValue: typeof state.previousValue === 'boolean' ? state.previousValue : true,
    },
  });
}

async function setPasswordSavingSuppressedForTab(tabId, suppressed) {
  if (!tabId) {
    throw new Error('Active tab required.');
  }

  let state = await getPasswordSavingSuppressionState();
  const activeTabIds = new Set(state.tabIds);

  if (suppressed) {
    if (activeTabIds.has(tabId)) {
      return { suppressed: true };
    }

    if (!activeTabIds.size) {
      const details = await getPasswordSavingEnabledDetails();
      const levelOfControl = `${details.levelOfControl || ''}`.trim();
      if (!['controllable_by_this_extension', 'controlled_by_this_extension'].includes(levelOfControl)) {
        throw new Error('Chrome does not allow this extension to control the password-save prompt.');
      }

      state.previousValue = Boolean(details.value);
      await setPasswordSavingEnabled(false);
    }

    activeTabIds.add(tabId);
    state.tabIds = Array.from(activeTabIds);
    await savePasswordSavingSuppressionState(state);
    return { suppressed: true };
  }

  if (!activeTabIds.has(tabId)) {
    return { suppressed: false };
  }

  activeTabIds.delete(tabId);
  state.tabIds = Array.from(activeTabIds);

  if (!activeTabIds.size) {
    await setPasswordSavingEnabled(Boolean(state.previousValue));
  }

  await savePasswordSavingSuppressionState(state);
  return { suppressed: false };
}

async function openFlowIsolatedWindow(launchUrl) {
  const url = normalizeFlowLaunchUrl(launchUrl);
  if (!url) {
    throw new Error('Flow launch URL is missing.');
  }

  const incognitoAllowed = await chrome.extension.isAllowedIncognitoAccess();
  if (!incognitoAllowed) {
    throw new Error('Enable "Allow in Incognito" for this extension, then launch Flow again.');
  }

  const createdWindow = await chrome.windows.create({
    url,
    incognito: true,
    focused: true,
  });

  return {
    windowId: Number(createdWindow?.id || 0),
    incognito: Boolean(createdWindow?.incognito),
  };
}

async function cleanupToolSessionForClosedTab(tabId) {
  if (!tabId) return;

  const launchMap = await getActiveLaunchMap();
  const closedLaunch = launchMap[`${tabId}`];
  const normalizedSlug = normalizeToolSlug(closedLaunch?.toolSlug);

  if (!closedLaunch) {
    return;
  }

  const shouldClearSessionOnClose = normalizedSlug === 'flow';
    if (shouldClearSessionOnClose) {
      const hasOtherToolTabs = Object.entries(launchMap).some(([key, item]) => {
        if (key === `${tabId}`) return false;
        return normalizeToolSlug(item?.toolSlug) === normalizedSlug;
      });

      if (!hasOtherToolTabs) {
        await clearToolSession(normalizedSlug, { includeGoogle: true });
      }
    }

  await clearActiveLaunch(tabId);
}

async function getSettings() {
  const stored = await chrome.storage.local.get(['apiBase', 'sessionToken']);
  const apiBase = (stored.apiBase || DEFAULT_API_BASE).replace(/\/+$/, '');
  let sessionToken = (stored.sessionToken || '').trim();

  if (!sessionToken) {
    sessionToken = await readSessionTokenFromCookies(apiBase, apiBase);
    if (sessionToken) {
      await chrome.storage.local.set({
        sessionToken,
        sessionTokenSyncedAt: Date.now(),
      });
    }
  }

  return {
    apiBase,
    sessionToken,
  };
}

async function fetchCredential(message, senderTabId = 0, openerTabId = 0) {
  const settings = await getSettings();
  const tabId = message.tabId || senderTabId || 0;
  const directLaunch = await getActiveLaunch(tabId, message.toolSlug);
  const inheritedLaunch = directLaunch?.ticket ? null : await getActiveLaunch(openerTabId, message.toolSlug);
  const activeLaunch = directLaunch || inheritedLaunch;
  const launchMode = directLaunch?.ticket ? 'direct' : 'inherited';
  const extensionTicket = `${message.extensionTicket || activeLaunch?.ticket || ''}`.trim();

  if (!extensionTicket) {
    throw new Error('Open this tool from the dashboard first.');
  }

  const isContinuation = isLoginContinuationPage(message.toolSlug, message.pageUrl, message.hostname);
  const continuationAllowed = isContinuation
    && Number(activeLaunch?.credentialContinuationCount || 0) < CREDENTIAL_CONTINUATION_LIMIT;

  if (launchMode === 'direct' && Number(activeLaunch?.directCredentialIssuedAt || 0) > 0 && !continuationAllowed) {
    throw new Error('Open this tool from the dashboard first.');
  }

  if (launchMode === 'inherited' && Number(activeLaunch?.inheritedCredentialIssuedAt || 0) > 0 && !continuationAllowed) {
    throw new Error('Open this tool from the dashboard first.');
  }

  const headers = {
    'Content-Type': 'application/json',
  };

  if (settings.sessionToken) {
    headers['X-Session-Id'] = settings.sessionToken;
  }

  const response = await fetch(`${settings.apiBase}/api/it-tools/extension/credential`, {
    method: 'POST',
    credentials: 'include',
    headers,
    body: JSON.stringify({
      tool_slug: message.toolSlug,
      hostname: message.hostname,
      page_url: message.pageUrl,
      extension_ticket: extensionTicket || null,
    }),
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.success) {
    const parts = [
      data.detail || data.message || `Credential request failed (${response.status})`,
      `api=${settings.apiBase}`,
      `sessionHeader=${settings.sessionToken ? 'yes' : 'no'}`,
      `http=${response.status}`,
    ];
    throw new Error(parts.join(' | '));
  }

  if (launchMode === 'direct' && tabId) {
    await markCredentialIssued(tabId, 'direct', isContinuation);
  } else if (launchMode === 'inherited' && openerTabId) {
    await markCredentialIssued(openerTabId, 'inherited', isContinuation);
  }

  return data;
}

async function fetchOtp(message, senderTabId = 0, openerTabId = 0) {
  const settings = await getSettings();
  const tabId = message.tabId || senderTabId || 0;
  const directLaunch = await getActiveLaunch(tabId, message.toolSlug);
  const inheritedLaunch = directLaunch?.ticket ? null : await getActiveLaunch(openerTabId, message.toolSlug);
  const activeLaunch = directLaunch || inheritedLaunch;
  const extensionTicket = `${message.extensionTicket || activeLaunch?.ticket || ''}`.trim();

  if (!extensionTicket) {
    throw new Error('Open this tool from the dashboard first.');
  }

  const headers = {
    'Content-Type': 'application/json',
  };

  if (settings.sessionToken) {
    headers['X-Session-Id'] = settings.sessionToken;
  }

  const response = await fetch(`${settings.apiBase}/api/it-tools/extension/otp`, {
    method: 'POST',
    credentials: 'include',
    headers,
    body: JSON.stringify({
      tool_slug: message.toolSlug,
      hostname: message.hostname,
      page_url: message.pageUrl,
      extension_ticket: extensionTicket || null,
    }),
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.success || !data.otp) {
    const parts = [
      data.detail || data.message || `OTP request failed (${response.status})`,
      `api=${settings.apiBase}`,
      `sessionHeader=${settings.sessionToken ? 'yes' : 'no'}`,
      `http=${response.status}`,
    ];
    throw new Error(parts.join(' | '));
  }

  return data.otp;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const senderTabId = sender?.tab?.id || 0;
  const senderOpenerTabId = sender?.tab?.openerTabId || 0;

  if (message?.type === 'TOOL_HUB_ACTIVATE_LAUNCH') {
    activateLaunchForTab(
      senderTabId,
      message.toolSlug,
      message.hostname || message.pageUrl,
      `${message.extensionTicket || ''}`.trim()
    )
      .then((launch) => sendResponse({
        ok: true,
        authorized: true,
        expiresAt: Number(launch?.expiresAt || 0),
        prepared: Boolean(launch?.freshSessionPreparedAt),
      }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === 'TOOL_HUB_GET_LAUNCH_STATE') {
    getAuthorizedLaunchForTabs(
      senderTabId,
      senderOpenerTabId,
      message.toolSlug,
      message.hostname,
      message.pageUrl
    )
      .then(async (launch) => {
        if (launch?.ticket) {
          return launch;
        }

        return activatePendingLaunchForTab(
          senderTabId,
          message.toolSlug,
          message.hostname,
          message.pageUrl
        );
      })
      .then((launch) => sendResponse({
        ok: true,
        authorized: Boolean(launch?.ticket),
        expiresAt: Number(launch?.expiresAt || 0),
        prepared: Boolean(launch?.freshSessionPreparedAt),
        authTransitionAt: Number(launch?.authTransitionAt || 0),
        remainingUses: Number(launch?.remainingUses || 0),
        remembered: false,
        toolSlug: normalizeToolSlug(launch?.toolSlug),
        hostname: normalizeHostname(launch?.hostname),
      }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === 'TOOL_HUB_LIST_REMEMBERED_TOOLS') {
    sendResponse({ ok: true, tools: [] });
    return true;
  }

  if (message?.type === 'TOOL_HUB_CLEAR_REMEMBERED_TOOLS') {
    chrome.storage.local.remove('rememberedToolLaunches')
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === 'TOOL_HUB_MARK_FRESH_SESSION_PREPARED') {
    markFreshSessionPrepared(senderTabId, message.toolSlug)
      .then((ok) => sendResponse({ ok }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === 'TOOL_HUB_MARK_AUTH_TRANSITION') {
    markAuthTransition(senderTabId, message.toolSlug)
      .then((ok) => sendResponse({ ok }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === 'TOOL_HUB_CLEAR_TOOL_SESSION') {
    clearToolSession(message.toolSlug, { includeGoogle: Boolean(message.includeGoogle) })
      .then(async (result) => {
        if (!message.preserveLaunch) {
          await clearActiveLaunch(senderTabId, message.toolSlug);
        }
        sendResponse({ ok: true, ...result });
      })
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === 'TOOL_HUB_SET_PASSWORD_SAVING_SUPPRESSED') {
    setPasswordSavingSuppressedForTab(senderTabId, Boolean(message.suppressed))
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === 'TOOL_HUB_SYNC_AUTH_CONTEXT') {
    syncAuthContext(message)
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === 'TOOL_HUB_OPEN_FLOW_ISOLATED_WINDOW') {
    if (normalizeToolSlug(message.toolSlug) !== 'flow') {
      sendResponse({ ok: false, error: 'Isolated window launch is only configured for Flow.' });
      return true;
    }

    openFlowIsolatedWindow(message.launchUrl)
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === 'TOOL_HUB_FETCH_OTP') {
    fetchOtp(message, senderTabId, senderOpenerTabId)
      .then((otp) => sendResponse({ ok: true, otp }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (!message || message.type !== 'TOOL_HUB_GET_CREDENTIAL') {
    return false;
  }

  fetchCredential(message, senderTabId, senderOpenerTabId)
    .then((data) => sendResponse({ ok: true, data }))
    .catch((error) => sendResponse({ ok: false, error: error.message }));

  return true;
});

chrome.storage.local.remove('rememberedToolLaunches').catch(() => {});

chrome.tabs.onRemoved.addListener((tabId) => {
  setPasswordSavingSuppressedForTab(tabId, false).catch(() => {});
  cleanupToolSessionForClosedTab(tabId).catch(() => {});
});
