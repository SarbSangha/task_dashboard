const DEFAULT_API_BASE = 'https://dashboard.ritzmediaworld.in';
const ACTIVE_TAB_LAUNCHES_STORAGE_KEY = 'activeExtensionTabLaunches';
const TOOL_SESSION_DOMAINS = {
  freepik: ['freepik.com', 'www.freepik.com'],
  'kling-ai': ['kling.ai', 'www.kling.ai', 'klingai.com', 'www.klingai.com', 'app.klingai.com'],
  klingai: ['kling.ai', 'www.kling.ai', 'klingai.com', 'www.klingai.com', 'app.klingai.com'],
};

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

async function getAuthorizedLaunchForTabs(primaryTabId, fallbackTabId, toolSlug) {
  const primaryLaunch = await getActiveLaunch(primaryTabId, toolSlug);
  if (primaryLaunch?.ticket) {
    return primaryLaunch;
  }

  if (!fallbackTabId || fallbackTabId === primaryTabId) {
    return null;
  }

  return getActiveLaunch(fallbackTabId, toolSlug);
}

async function setActiveLaunch(tabId, launch) {
  if (!tabId || !launch?.ticket || !launch?.expiresAt) return;
  const launchMap = await getActiveLaunchMap();
  const existingLaunch = launchMap[`${tabId}`] || {};
  launchMap[`${tabId}`] = {
    toolSlug: normalizeToolSlug(launch.toolSlug),
    ticket: `${launch.ticket}`.trim(),
    expiresAt: Number(launch.expiresAt || 0),
    hostname: normalizeHostname(launch.hostname),
    activatedAt: Date.now(),
    directCredentialIssuedAt: Number(existingLaunch.directCredentialIssuedAt || 0),
    inheritedCredentialIssuedAt: Number(existingLaunch.inheritedCredentialIssuedAt || 0),
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

async function markCredentialIssued(tabId, mode = 'direct') {
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
  if (!storedLaunch?.ticket || `${storedLaunch.ticket}`.trim() !== `${extensionTicket}`.trim()) {
    throw new Error('Open this tool from the dashboard first.');
  }

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

async function clearToolSession(toolSlug) {
  const normalizedSlug = normalizeToolSlug(toolSlug);
  const domains = TOOL_SESSION_DOMAINS[normalizedSlug] || [];
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

async function getSettings() {
  const stored = await chrome.storage.local.get(['apiBase', 'sessionToken']);
  return {
    apiBase: (stored.apiBase || DEFAULT_API_BASE).replace(/\/+$/, ''),
    sessionToken: (stored.sessionToken || '').trim(),
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

  if (launchMode === 'direct' && Number(activeLaunch?.directCredentialIssuedAt || 0) > 0) {
    throw new Error('Open this tool from the dashboard first.');
  }

  if (launchMode === 'inherited' && Number(activeLaunch?.inheritedCredentialIssuedAt || 0) > 0) {
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
    await markCredentialIssued(tabId, 'direct');
  } else if (launchMode === 'inherited' && openerTabId) {
    await markCredentialIssued(openerTabId, 'inherited');
  }

  return data;
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
      }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === 'TOOL_HUB_GET_LAUNCH_STATE') {
    getAuthorizedLaunchForTabs(senderTabId, senderOpenerTabId, message.toolSlug)
      .then((launch) => sendResponse({
        ok: true,
        authorized: Boolean(launch?.ticket),
        expiresAt: Number(launch?.expiresAt || 0),
        remainingUses: Number(launch?.remainingUses || 0),
        remembered: false,
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

  if (message?.type === 'TOOL_HUB_CLEAR_TOOL_SESSION') {
    clearToolSession(message.toolSlug)
      .then(async (result) => {
        await clearActiveLaunch(senderTabId, message.toolSlug);
        sendResponse({ ok: true, ...result });
      })
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
  clearActiveLaunch(tabId).catch(() => {});
});
