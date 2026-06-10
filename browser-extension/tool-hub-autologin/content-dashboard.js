const SESSION_TOKEN_STORAGE_KEY = 'rmw_session_token_v1';
const EXTENSION_LAUNCH_EVENT = 'rmw:tool-hub-extension-launch';
const EXTENSION_LAUNCH_STORED_EVENT = 'rmw:tool-hub-extension-launch-stored';
const EXTENSION_WINDOW_LAUNCH_EVENT = 'rmw:tool-hub-extension-window-launch';
const EXTENSION_WINDOW_LAUNCH_RESULT_EVENT = 'rmw:tool-hub-extension-window-launch-result';
const EXTENSION_LAUNCH_MESSAGE_TYPE = 'RMW_TOOL_HUB_EXTENSION_LAUNCH';
const EXTENSION_LAUNCH_STORED_MESSAGE_TYPE = 'RMW_TOOL_HUB_EXTENSION_LAUNCH_STORED';
const EXTENSION_WINDOW_LAUNCH_MESSAGE_TYPE = 'RMW_TOOL_HUB_EXTENSION_WINDOW_LAUNCH';
const EXTENSION_WINDOW_LAUNCH_RESULT_MESSAGE_TYPE = 'RMW_TOOL_HUB_EXTENSION_WINDOW_LAUNCH_RESULT';
const EXTENSION_AUTH_SYNC_MESSAGE_TYPE = 'TOOL_HUB_SYNC_AUTH_CONTEXT';
const MAX_LAUNCH_USES = 3;
const DASHBOARD_HOSTS = new Set([
  'dashboard.ritzmediaworld.in',
  'dashboard.ritzmediaworld.com',
  'localhost',
  '127.0.0.1',
  '192.168.1.15',
]);
const DASHBOARD_HOST_SUFFIXES = [
  '.ritzmediaworld.in',
  '.ritzmediaworld.com',
  '.onrender.com',
  '.workers.dev',
];

function isAllowedDashboardPage() {
  const hostname = `${window.location.hostname || ''}`.toLowerCase();
  if (DASHBOARD_HOSTS.has(hostname)) return true;
  if (/^192\.168\.\d{1,3}\.\d{1,3}$/.test(hostname)) return true;
  return DASHBOARD_HOST_SUFFIXES.some((suffix) => hostname.endsWith(suffix));
}

function normalizeToolSlug(value) {
  const normalized = `${value || ''}`.trim().toLowerCase();
  if (normalized === 'chat-gpt') return 'chatgpt';
  if (['enhencor', 'enhencer', 'enhancer'].includes(normalized)) return 'enhancor';
  if (['eleven-labs', 'eleven-lab'].includes(normalized)) return 'elevenlabs';
  if (normalized === 'pintrest') return 'pinterest';
  return normalized;
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

function ignoreChromePromise(result) {
  if (result && typeof result.catch === 'function') {
    result.catch(() => {});
  }
}

async function savePendingLaunch(detail) {
  const toolSlug = normalizeToolSlug(detail?.toolSlug);
  const ticket = `${detail?.ticket || ''}`.trim();
  const expiresAt = Number(detail?.expiresAt || 0);
  const hostname = normalizeHostname(detail?.launchUrl || detail?.hostname);

  if (!toolSlug || !ticket || !expiresAt) {
    return;
  }

  const stored = await chrome.storage.local.get(['pendingExtensionLaunches']);
  const launches = { ...(stored.pendingExtensionLaunches || {}) };
  const now = Date.now();

  Object.keys(launches).forEach((key) => {
    const item = launches[key];
    if (!item || Number(item.expiresAt || 0) <= now) {
      delete launches[key];
    }
  });

  launches[toolSlug] = {
    ticket,
    expiresAt,
    hostname,
    usageTrackingTicket: `${detail?.usageTrackingTicket || ''}`.trim(),
    usageTrackingTicketExpiresAt: Number(detail?.usageTrackingTicketExpiresAt || 0),
    remainingUses: MAX_LAUNCH_USES,
    savedAt: now,
  };

  await chrome.storage.local.set({ pendingExtensionLaunches: launches });
}

function emitLaunchStored(toolSlug) {
  const normalizedSlug = normalizeToolSlug(toolSlug);
  window.dispatchEvent(new CustomEvent(EXTENSION_LAUNCH_STORED_EVENT, {
    detail: { toolSlug: normalizedSlug },
  }));
  window.postMessage({
    source: 'rmw-tool-hub-extension',
    type: EXTENSION_LAUNCH_STORED_MESSAGE_TYPE,
    toolSlug: normalizedSlug,
  }, window.location.origin);
}

function emitWindowLaunchResult(detail) {
  const payload = {
    toolSlug: normalizeToolSlug(detail?.toolSlug),
    ok: Boolean(detail?.ok),
    error: `${detail?.error || ''}`.trim(),
  };

  window.dispatchEvent(new CustomEvent(EXTENSION_WINDOW_LAUNCH_RESULT_EVENT, {
    detail: payload,
  }));
  window.postMessage({
    source: 'rmw-tool-hub-extension',
    type: EXTENSION_WINDOW_LAUNCH_RESULT_MESSAGE_TYPE,
    ...payload,
  }, window.location.origin);
}

function handleLaunchDetail(detail) {
  if (!isAllowedDashboardPage()) return;

  Promise.resolve()
    .then(() => syncSessionToken())
    .catch(() => {})
    .then(() => savePendingLaunch(detail))
    .then(() => {
      emitLaunchStored(detail?.toolSlug);
    })
    .catch(() => {});
}

function getIncognitoLaunchToolName(toolSlug) {
  if (toolSlug === 'behance') return 'Behance';
  if (toolSlug === 'canva') return 'Canva';
  if (toolSlug === 'chatgpt') return 'ChatGPT';
  if (toolSlug === 'flow') return 'Flow';
  if (toolSlug === 'enhancor') return 'Enhancor';
  if (toolSlug === 'freepik') return 'Freepik';
  if (toolSlug === 'elevenlabs') return 'ElevenLabs';
  if (toolSlug === 'pinterest') return 'Pinterest';
  return 'this tool';
}

function appendExtensionLaunchParams(launchUrl, detail) {
  const rawUrl = `${launchUrl || ''}`.trim();
  if (!rawUrl) return '';

  const ticket = `${detail?.ticket || detail?.extensionTicket || ''}`.trim();
  const usageTicket = `${detail?.usageTrackingTicket || ''}`.trim();
  const toolSlug = normalizeToolSlug(detail?.toolSlug);
  if (!ticket && !usageTicket && !toolSlug) return rawUrl;

  try {
    const url = new URL(rawUrl);
    if (ticket && !url.searchParams.get('rmw_extension_ticket')) {
      url.searchParams.set('rmw_extension_ticket', ticket);
    }
    if (usageTicket && !url.searchParams.get('rmw_usage_ticket')) {
      url.searchParams.set('rmw_usage_ticket', usageTicket);
    }
    if (toolSlug && !url.searchParams.get('rmw_tool_slug')) {
      url.searchParams.set('rmw_tool_slug', toolSlug);
    }

    const hashParams = new URLSearchParams((url.hash || '').replace(/^#/, ''));
    if (ticket && !hashParams.get('rmw_extension_ticket')) {
      hashParams.set('rmw_extension_ticket', ticket);
    }
    if (usageTicket && !hashParams.get('rmw_usage_ticket')) {
      hashParams.set('rmw_usage_ticket', usageTicket);
    }
    if (toolSlug && !hashParams.get('rmw_tool_slug')) {
      hashParams.set('rmw_tool_slug', toolSlug);
    }
    url.hash = hashParams.toString();
    return url.toString();
  } catch {
    return rawUrl;
  }
}

function requestIncognitoWindow(detail) {
  if (!isAllowedDashboardPage()) {
    emitWindowLaunchResult({
      toolSlug: normalizeToolSlug(detail?.toolSlug),
      ok: false,
      error: 'Tool launches are only allowed from the dashboard.',
    });
    return;
  }

  const toolSlug = normalizeToolSlug(detail?.toolSlug);
  const launchUrl = appendExtensionLaunchParams(detail?.launchUrl, detail);
  const toolName = `${detail?.toolName || ''}`.trim() || getIncognitoLaunchToolName(toolSlug);
  if (!toolSlug || !launchUrl) {
    emitWindowLaunchResult({
      toolSlug,
      ok: false,
      error: `${toolName} launch details are incomplete.`,
    });
    return;
  }

  chrome.runtime.sendMessage(
    {
      type: 'TOOL_HUB_OPEN_INCOGNITO_WINDOW',
      toolSlug,
      toolName,
      launchUrl,
      extensionTicket: `${detail?.ticket || detail?.extensionTicket || ''}`.trim(),
      usageTrackingTicket: `${detail?.usageTrackingTicket || ''}`.trim(),
    },
    (response) => {
      if (chrome.runtime.lastError) {
        emitWindowLaunchResult({
          toolSlug,
          ok: false,
          error: chrome.runtime.lastError.message,
        });
        return;
      }

      emitWindowLaunchResult({
        toolSlug,
        ok: Boolean(response?.ok),
        error: response?.ok ? '' : (response?.error || `Unable to open ${toolName} in an incognito window.`),
      });
    }
  );
}

function readStoredToken() {
  const localToken = safelyReadStorage(window.localStorage);
  if (localToken) return localToken;
  return safelyReadStorage(window.sessionStorage);
}

function resolveApiBaseFromDashboard() {
  const { protocol, hostname } = window.location;

  if (hostname === 'localhost' || hostname === '127.0.0.1') {
    return `${protocol}//${hostname}:8000`;
  }

  return `${protocol}//${hostname}`;
}

function safelyReadStorage(storage) {
  try {
    return `${storage?.getItem(SESSION_TOKEN_STORAGE_KEY) || ''}`.trim();
  } catch (error) {
    return '';
  }
}

function sendRuntimeMessage(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(response || {});
    });
  });
}

async function syncSessionToken() {
  const sessionToken = readStoredToken();
  const apiBase = resolveApiBaseFromDashboard();
  await sendRuntimeMessage({
    type: EXTENSION_AUTH_SYNC_MESSAGE_TYPE,
    sessionToken,
    apiBase,
    dashboardUrl: window.location.href,
  });
}

function queueSync() {
  if (!isAllowedDashboardPage()) return;

  window.setTimeout(() => {
    syncSessionToken().catch(() => {});
  }, 250);
}

window.addEventListener('load', queueSync);
window.addEventListener('focus', queueSync);
window.addEventListener(EXTENSION_LAUNCH_EVENT, (event) => {
  if (!isAllowedDashboardPage()) return;
  handleLaunchDetail(event.detail);
});
window.addEventListener(EXTENSION_WINDOW_LAUNCH_EVENT, (event) => {
  if (!isAllowedDashboardPage()) return;
  requestIncognitoWindow(event.detail);
});
window.addEventListener('message', (event) => {
  if (!isAllowedDashboardPage()) return;
  if (event.source !== window) return;
  if (event.origin !== window.location.origin) return;
  if (event.data?.source !== 'rmw-tool-hub-page') return;
  if (event.data?.type === EXTENSION_LAUNCH_MESSAGE_TYPE) {
    handleLaunchDetail(event.data);
    return;
  }
  if (event.data?.type === EXTENSION_WINDOW_LAUNCH_MESSAGE_TYPE) {
    requestIncognitoWindow(event.data);
  }
});
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) {
    queueSync();
  }
});

window.setInterval(() => {
  syncSessionToken().catch(() => {});
}, 5000);

ignoreChromePromise(chrome.storage?.local?.remove?.('rememberedToolLaunches'));
queueSync();
