const DEFAULT_API_BASE = 'https://dashboard.ritzmediaworld.in';
const REMEMBERED_TOOLS_STORAGE_KEY = 'rememberedToolLaunches';
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

function resolveRememberedToolKey(rememberedTools, toolSlug, hostname) {
  const normalizedSlug = normalizeToolSlug(toolSlug);
  if (normalizedSlug && rememberedTools[normalizedSlug]?.hostname) {
    return normalizedSlug;
  }

  const normalizedHostname = normalizeHostname(hostname);
  if (!normalizedHostname) {
    return '';
  }

  return Object.keys(rememberedTools).find((key) => normalizeHostname(rememberedTools[key]?.hostname) === normalizedHostname) || '';
}

async function getRememberedTool(toolSlug, hostname) {
  const stored = await chrome.storage.local.get([REMEMBERED_TOOLS_STORAGE_KEY]);
  const rememberedTools = { ...(stored[REMEMBERED_TOOLS_STORAGE_KEY] || {}) };
  const rememberedKey = resolveRememberedToolKey(rememberedTools, toolSlug, hostname);
  return rememberedTools[rememberedKey] || null;
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

async function fetchCredential(message) {
  const settings = await getSettings();
  let extensionTicket = `${message.extensionTicket || ''}`.trim();
  let rememberedTool = null;
  if (!extensionTicket) {
    try {
      extensionTicket = await consumePendingLaunch(message.toolSlug, message.hostname || message.pageUrl);
    } catch {
      rememberedTool = await getRememberedTool(message.toolSlug, message.hostname || message.pageUrl);
      extensionTicket = '';
    }
  }

  if (!extensionTicket && !rememberedTool) {
    throw new Error('Open this tool once from the dashboard so the extension can remember it.');
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

  return data;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'TOOL_HUB_GET_LAUNCH_STATE') {
    Promise.all([
      getPendingLaunch(message.toolSlug, message.hostname || message.pageUrl),
      getRememberedTool(message.toolSlug, message.hostname || message.pageUrl),
    ])
      .then(([launch, rememberedTool]) => sendResponse({
        ok: true,
        authorized: Boolean(launch?.ticket || rememberedTool),
        expiresAt: Number(launch?.expiresAt || 0),
        remainingUses: Number(launch?.remainingUses || 0),
        remembered: Boolean(rememberedTool),
      }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === 'TOOL_HUB_LIST_REMEMBERED_TOOLS') {
    chrome.storage.local.get([REMEMBERED_TOOLS_STORAGE_KEY])
      .then((stored) => {
        const rememberedTools = Object.values(stored[REMEMBERED_TOOLS_STORAGE_KEY] || {})
          .filter((item) => item && item.toolSlug && item.hostname)
          .sort((left, right) => Number(right?.lastLaunchedAt || 0) - Number(left?.lastLaunchedAt || 0));
        sendResponse({ ok: true, tools: rememberedTools });
      })
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === 'TOOL_HUB_CLEAR_REMEMBERED_TOOLS') {
    chrome.storage.local.remove(REMEMBERED_TOOLS_STORAGE_KEY)
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === 'TOOL_HUB_CLEAR_TOOL_SESSION') {
    clearToolSession(message.toolSlug)
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (!message || message.type !== 'TOOL_HUB_GET_CREDENTIAL') {
    return false;
  }

  fetchCredential(message)
    .then((data) => sendResponse({ ok: true, data }))
    .catch((error) => sendResponse({ ok: false, error: error.message }));

  return true;
});
