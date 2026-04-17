const SESSION_TOKEN_STORAGE_KEY = 'rmw_session_token_v1';
const EXTENSION_LAUNCH_EVENT = 'rmw:tool-hub-extension-launch';
const EXTENSION_LAUNCH_STORED_EVENT = 'rmw:tool-hub-extension-launch-stored';
const EXTENSION_LAUNCH_MESSAGE_TYPE = 'RMW_TOOL_HUB_EXTENSION_LAUNCH';
const EXTENSION_LAUNCH_STORED_MESSAGE_TYPE = 'RMW_TOOL_HUB_EXTENSION_LAUNCH_STORED';
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

function handleLaunchDetail(detail) {
  savePendingLaunch(detail)
    .then(() => {
      emitLaunchStored(detail?.toolSlug);
    })
    .catch(() => {});
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

async function syncSessionToken() {
  const sessionToken = readStoredToken();
  const apiBase = resolveApiBaseFromDashboard();

  const stored = await chrome.storage.local.get(['sessionToken', 'apiBase']);
  const nextValues = {};
  const removeKeys = [];

  if (sessionToken && `${stored.sessionToken || ''}`.trim() !== sessionToken) {
    nextValues.sessionToken = sessionToken;
    nextValues.sessionTokenSyncedAt = Date.now();
  }
  if (!sessionToken && `${stored.sessionToken || ''}`.trim()) {
    removeKeys.push('sessionToken');
    removeKeys.push('sessionTokenSyncedAt');
  }

  if (`${stored.apiBase || ''}`.trim() !== apiBase) {
    nextValues.apiBase = apiBase;
  }

  if (Object.keys(nextValues).length === 0 && removeKeys.length === 0) {
    return;
  }

  if (removeKeys.length > 0) {
    await chrome.storage.local.remove(removeKeys);
  }
  if (Object.keys(nextValues).length > 0) {
    await chrome.storage.local.set(nextValues);
  }
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
window.addEventListener('message', (event) => {
  if (event.source !== window) return;
  if (event.origin !== window.location.origin) return;
  if (event.data?.source !== 'rmw-tool-hub-page') return;
  if (event.data?.type !== EXTENSION_LAUNCH_MESSAGE_TYPE) return;
  handleLaunchDetail(event.data);
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
