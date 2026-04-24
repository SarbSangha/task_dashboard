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
  Promise.resolve()
    .then(() => syncSessionToken())
    .catch(() => {})
    .then(() => savePendingLaunch(detail))
    .then(() => {
      emitLaunchStored(detail?.toolSlug);
    })
    .catch(() => {});
}

function requestFlowIsolatedWindow(detail) {
  const toolSlug = normalizeToolSlug(detail?.toolSlug);
  const launchUrl = `${detail?.launchUrl || ''}`.trim();
  if (toolSlug !== 'flow' || !launchUrl) {
    emitWindowLaunchResult({
      toolSlug,
      ok: false,
      error: 'Flow launch details are incomplete.',
    });
    return;
  }

  chrome.runtime.sendMessage(
    {
      type: 'TOOL_HUB_OPEN_FLOW_ISOLATED_WINDOW',
      toolSlug,
      launchUrl,
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
        error: response?.ok ? '' : (response?.error || 'Unable to open Flow in an isolated window.'),
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
  window.setTimeout(() => {
    syncSessionToken().catch(() => {});
  }, 250);
}

window.addEventListener('load', queueSync);
window.addEventListener('focus', queueSync);
window.addEventListener(EXTENSION_LAUNCH_EVENT, (event) => {
  handleLaunchDetail(event.detail);
});
window.addEventListener(EXTENSION_WINDOW_LAUNCH_EVENT, (event) => {
  requestFlowIsolatedWindow(event.detail);
});
window.addEventListener('message', (event) => {
  if (event.source !== window) return;
  if (event.origin !== window.location.origin) return;
  if (event.data?.source !== 'rmw-tool-hub-page') return;
  if (event.data?.type === EXTENSION_LAUNCH_MESSAGE_TYPE) {
    handleLaunchDetail(event.data);
    return;
  }
  if (event.data?.type === EXTENSION_WINDOW_LAUNCH_MESSAGE_TYPE) {
    requestFlowIsolatedWindow(event.data);
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

chrome.storage.local.remove('rememberedToolLaunches').catch(() => {});
queueSync();
