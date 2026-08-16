const DEFAULT_API_BASE = 'https://dashboard.ritzmediaworld.in';
const ACTIVE_TAB_LAUNCHES_STORAGE_KEY = 'activeExtensionTabLaunches';
const PASSWORD_SAVING_STATE_STORAGE_KEY = 'passwordSavingSuppressionState';
const USAGE_EVENT_RETRY_QUEUE_STORAGE_KEY = 'pendingUsageEventReports';
const USAGE_EVENT_RETRY_ALARM = 'retryPendingUsageEvents';
const USAGE_EVENT_RETRY_QUEUE_LIMIT = 200;
const USAGE_EVENT_RETRY_MAX_ATTEMPTS = 8;
const USAGE_EVENT_RETRY_BATCH_LIMIT = 20;
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
const FLOW_HOME_URL = 'https://labs.google/fx';
const FLOW_DIRECT_ROUTE_URL = 'https://labs.google/fx/tools/flow';
const CREDENTIAL_CONTINUATION_LIMIT = 6;
// Reported bug: a DIRECT_TICKET_ONLY_TOOLS user (Claude) would finish their
// email verification and get bounced straight back to the login page,
// storage wiped, as if signing in had cleared their own cookies. Root cause:
// markAuthTransition() (called right before content-claude.js navigates to
// the fetched magic-link URL) already recorded authTransitionAt, but nothing
// ever consulted it - getActiveLaunchMap()'s pruning below only looked at
// the ticket's own 20min expiresAt. Waiting for/fetching the actual
// verification email can itself eat deep into that 20min budget on a slow
// mail delivery, so the ticket could expire moments into (or during) the
// final redirect back to the authenticated workspace. These tools have no
// continuation-launch fallback by design (that's the whole point of
// "direct ticket only"), so the very next launch-state check right after
// verification found nothing, was treated as an unauthorized manual visit,
// and enforceDashboardOnlyAccess() wiped everything. This grants a fresh,
// generous grace window from the moment of that final hand-off - separate
// from and not a general extension of the original ticket clock - so the
// last leg of a real in-flight verification survives even if the earlier
// email wait nearly used up the ticket's normal lifetime.
const AUTH_TRANSITION_GRACE_MS = 10 * 60 * 1000;
// Strict dashboard-only: these tools only auto-fill when opened with a direct
// per-tab launch ticket from the dashboard. Pending-launch activation, opener
// inheritance and recent-launch reuse are all refused, so a manual/direct visit
// (typed URL, bookmark, or navigating to the login page) can never auto-fill.
const DIRECT_TICKET_ONLY_TOOLS = new Set([
  'behance', 'claude', 'genspark', 'pinterest', 'suno', 'epidemic-sound', 'splice', 'enhancor',
  'canva', 'chatgpt', 'elevenlabs', 'envato', 'flow', 'freepik', 'grammarly', 'heygen',
  'higgsfield', 'kling', 'kling-ai', 'klingai',
]);
// Tools whose session is wiped when the launched tab closes, so a shared
// dashboard login does not linger. Google-login tools launch in incognito and
// clear automatically; the email/password tools below launch in a normal
// window where cookies would otherwise persist and leak the shared session.
const CLEAR_SESSION_ON_CLOSE_TOOLS = new Set([
  'behance', 'claude', 'freepik', 'genspark', 'pinterest', 'flow',
  'envato', 'grammarly', 'higgsfield',
]);
const TOOL_SESSION_DOMAINS = {
  behance: [
    'behance.net',
    'www.behance.net',
    'adobe.com',
    'www.adobe.com',
    'account.adobe.com',
    'auth.services.adobe.com',
    'adobeid-na1.services.adobe.com',
    'ims-na1.adobelogin.com',
  ],
  canva: ['canva.com', 'www.canva.com'],
  claude: ['claude.ai', 'www.claude.ai'],
  enhancor: ['enhancor.ai', 'www.enhancor.ai', 'app.enhancor.ai'],
  envato: ['envato.com', 'www.envato.com', 'app.envato.com', 'elements.envato.com', 'market.envato.com'],
  freepik: ['freepik.com', 'www.freepik.com', 'magnific.com', 'www.magnific.com'],
  flow: ['labs.google'],
  genspark: ['genspark.ai', 'www.genspark.ai', 'login.genspark.ai'],
  grammarly: ['grammarly.com', 'www.grammarly.com', 'app.grammarly.com', 'coda.grammarly.com'],
  higgsfield: ['higgsfield.ai', 'app.higgsfield.ai', 'beta.higgsfield.ai'],
  heygen: ['heygen.com', 'auth.heygen.com', 'app.heygen.com'],
  elevenlabs: ['elevenlabs.io', 'www.elevenlabs.io', 'app.elevenlabs.io'],
  kling: ['kling.ai', 'www.kling.ai', 'klingai.com', 'www.klingai.com', 'app.klingai.com'],
  'kling-ai': ['kling.ai', 'www.kling.ai', 'klingai.com', 'www.klingai.com', 'app.klingai.com'],
  klingai: ['kling.ai', 'www.kling.ai', 'klingai.com', 'www.klingai.com', 'app.klingai.com'],
  pinterest: ['pinterest.com', 'www.pinterest.com', 'in.pinterest.com'],
  suno: ['suno.com', 'www.suno.com', 'studio-api.prod.suno.com'],
  'epidemic-sound': ['epidemicsound.com', 'www.epidemicsound.com', 'login.epidemicsound.com'],
  splice: ['splice.com', 'www.splice.com', 'auth.splice.com'],
};
const TOOL_OPTIONAL_SESSION_DOMAINS = {
  behance: ['accounts.google.com', 'google.com', '.google.com'],
  flow: ['accounts.google.com', 'google.com', '.google.com'],
  genspark: ['accounts.google.com', 'google.com', '.google.com'],
  pinterest: ['accounts.google.com', 'google.com', '.google.com'],
};
const TOOL_LOGIN_CONTINUATION_HOSTS = {
  behance: [
    'behance.net',
    'www.behance.net',
    'auth.services.adobe.com',
    'adobeid-na1.services.adobe.com',
    'ims-na1.adobelogin.com',
    'accounts.google.com',
  ],
  canva: [
    'canva.com',
    'www.canva.com',
  ],
  chatgpt: [
    'chatgpt.com',
    'chat.openai.com',
    'auth.openai.com',
    'accounts.google.com',
    'login.microsoftonline.com',
    'login.live.com',
    'login.microsoft.com',
  ],
  claude: [
    'claude.ai',
    'www.claude.ai',
  ],
  enhancor: [
    'enhancor.ai',
    'www.enhancor.ai',
    'app.enhancor.ai',
    'accounts.google.com',
  ],
  envato: [
    'envato.com',
    'elements.envato.com',
    'market.envato.com',
  ],
  freepik: [
    'freepik.com',
    'www.freepik.com',
    'magnific.com',
    'www.magnific.com',
    'accounts.google.com',
  ],
  genspark: [
    'genspark.ai',
    'www.genspark.ai',
    'login.genspark.ai',
    'accounts.google.com',
  ],
  grammarly: [
    'grammarly.com',
    'www.grammarly.com',
    'app.grammarly.com',
    'coda.grammarly.com',
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
    'accounts.google.com',
  ],
  elevenlabs: [
    'elevenlabs.io',
    'www.elevenlabs.io',
    'app.elevenlabs.io',
    'accounts.google.com',
  ],
  flow: [
    'labs.google',
    'accounts.google.com',
  ],
  kling: [
    'kling.ai',
    'www.kling.ai',
    'klingai.com',
    'www.klingai.com',
    'app.klingai.com',
    'accounts.google.com',
  ],
  'kling-ai': [
    'kling.ai',
    'www.kling.ai',
    'klingai.com',
    'www.klingai.com',
    'app.klingai.com',
    'accounts.google.com',
  ],
  klingai: [
    'kling.ai',
    'www.kling.ai',
    'klingai.com',
    'www.klingai.com',
    'app.klingai.com',
    'accounts.google.com',
  ],
  pinterest: [
    'pinterest.com',
    'www.pinterest.com',
    'in.pinterest.com',
    'accounts.google.com',
  ],
  suno: [
    'suno.com',
    'www.suno.com',
    'studio-api.prod.suno.com',
    'accounts.google.com',
  ],
  'epidemic-sound': [
    'epidemicsound.com',
    'www.epidemicsound.com',
    'login.epidemicsound.com',
    'accounts.google.com',
  ],
  splice: [
    'splice.com',
    'www.splice.com',
    'auth.splice.com',
    'accounts.google.com',
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

function ignoreChromePromise(result) {
  if (result && typeof result.catch === 'function') {
    result.catch(() => {});
  }
}

function runSafeStartupTask(task) {
  try {
    const result = task?.();
    if (result && typeof result.catch === 'function') {
      result.catch(() => {});
    }
  } catch {
    // Keep service-worker registration alive even if a startup API is unavailable.
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

function isAllowedDashboardUrl(value) {
  try {
    const url = new URL(`${value || ''}`);
    const hostname = `${url.hostname || ''}`.toLowerCase();
    if (DASHBOARD_HOSTS.has(hostname)) return true;
    if (/^192\.168\.\d{1,3}\.\d{1,3}$/.test(hostname)) return true;
    return DASHBOARD_HOST_SUFFIXES.some((suffix) => hostname.endsWith(suffix));
  } catch {
    return false;
  }
}

function isLoginContinuationPage(toolSlug, pageUrl, hostname) {
  const allowedHosts = TOOL_LOGIN_CONTINUATION_HOSTS[normalizeToolSlug(toolSlug)] || [];
  if (!allowedHosts.length) return false;

  const pageHost = hostnameFromPageUrl(pageUrl) || normalizeHostname(hostname);
  return Boolean(pageHost && allowedHosts.includes(pageHost));
}

function isRecentContinuationReuseAllowed(toolSlug, pageUrl, hostname) {
  if (!isLoginContinuationPage(toolSlug, pageUrl, hostname)) {
    return false;
  }

  const normalizedToolSlug = normalizeToolSlug(toolSlug);
  const pageHost = hostnameFromPageUrl(pageUrl) || normalizeHostname(hostname);

  if (['enhancor', 'freepik'].includes(normalizedToolSlug)) {
    return false;
  }

  if (['elevenlabs', 'genspark', 'flow', 'kling', 'kling-ai', 'klingai'].includes(normalizedToolSlug)) {
    return pageHost === 'accounts.google.com';
  }

  if (normalizedToolSlug === 'epidemic-sound') {
    // Epidemic Sound hands off from the marketing site to a separate login
    // origin (login.epidemicsound.com) before Google, so allow the launch to be
    // re-bound on that origin and on accounts.google.com.
    return pageHost === 'login.epidemicsound.com' || pageHost === 'accounts.google.com';
  }

  if (normalizedToolSlug === 'splice') {
    // Splice uses a separate Auth0 login origin (auth.splice.com) before Google.
    return pageHost === 'auth.splice.com' || pageHost === 'accounts.google.com';
  }

  if (normalizedToolSlug === 'grammarly') {
    // isLoginContinuationPage() above already confirmed pageHost is one of
    // TOOL_LOGIN_CONTINUATION_HOSTS.grammarly (app/coda/www/grammarly.com).
    return true;
  }

  if (normalizedToolSlug !== 'chatgpt') {
    return false;
  }

  return [
    'auth.openai.com',
    'accounts.google.com',
    'login.microsoftonline.com',
    'login.live.com',
    'login.microsoft.com',
  ].includes(pageHost);
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

  // `ticket` (the short-lived, 20min extension_autofill ticket) and
  // `usageTrackingTicket` (24h) expire independently - see
  // handleKlingFetchMyActiveTasksMessage/handleKlingFetchActiveClientsMessage
  // above, which already explicitly accept usageTrackingTicket alone as
  // sufficient, and get_my_active_tasks_for_generation (tasks_router.py)
  // which already resolves the actor from usage_ticket alone server-side.
  // The bug this fixes (reported 2026-08-05): this function used to delete
  // the WHOLE record - both tickets - the moment the record's single
  // `expiresAt` (always the shorter 20min ticket's expiry, see
  // setActiveLaunch) passed, silently discarding the still-valid 24h
  // usageTrackingTicket right along with it. That's why Kling's task/client
  // picker started failing with "Launch Kling from the dashboard..." only
  // ~20 minutes after launch, well before the 24h ticket it actually needs
  // for that specific check had expired. Each ticket is now cleared on its
  // own expiry, and the whole record is only dropped once neither survives.
  Object.keys(launchMap).forEach((key) => {
    const item = launchMap[key];
    if (!item) {
      delete launchMap[key];
      changed = true;
      return;
    }
    if (item.ticket && Number(item.expiresAt || 0) <= now) {
      item.ticket = '';
      item.expiresAt = 0;
      changed = true;
    }
    if (item.usageTrackingTicket && Number(item.usageTrackingTicketExpiresAt || 0) <= now) {
      item.usageTrackingTicket = '';
      item.usageTrackingTicketExpiresAt = 0;
      changed = true;
    }
    if (!item.ticket && !item.usageTrackingTicket) {
      delete launchMap[key];
      changed = true;
    }
  });

  if (changed) {
    await chrome.storage.local.set({ [ACTIVE_TAB_LAUNCHES_STORAGE_KEY]: launchMap });
  }

  return launchMap;
}

async function getStoredActiveLaunchMap() {
  const stored = await chrome.storage.local.get([ACTIVE_TAB_LAUNCHES_STORAGE_KEY]);
  return { ...(stored[ACTIVE_TAB_LAUNCHES_STORAGE_KEY] || {}) };
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
  if (!isRecentContinuationReuseAllowed(toolSlug, pageUrl, hostname)) {
    return null;
  }

  const normalizedToolSlug = normalizeToolSlug(toolSlug);
  const pageHost = hostnameFromPageUrl(pageUrl) || normalizeHostname(hostname);
  if (['kling', 'kling-ai', 'klingai'].includes(normalizedToolSlug) && pageHost !== 'accounts.google.com') {
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
  if (DIRECT_TICKET_ONLY_TOOLS.has(normalizeToolSlug(toolSlug))) {
    const directLaunch = await getActiveLaunch(primaryTabId, toolSlug);
    if (directLaunch?.ticket) {
      return directLaunch;
    }
    // Google/OAuth often opens in a separate popup or tab. Inherit the direct
    // launch from the opener tab (which must itself hold a real dashboard
    // launch) and bind it to this tab. This does NOT reopen the manual-visit
    // gap: a directly/manually opened tab has no launch to inherit, and
    // pending-launch activation + recent-launch reuse remain refused.
    if (fallbackTabId && fallbackTabId !== primaryTabId) {
      const inheritedDirectLaunch = await getActiveLaunch(fallbackTabId, toolSlug);
      if (inheritedDirectLaunch?.ticket) {
        if (primaryTabId) {
          await setActiveLaunch(primaryTabId, inheritedDirectLaunch);
        }
        return inheritedDirectLaunch;
      }
    }
    return null;
  }

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
  const normalizedToolSlug = normalizeToolSlug(toolSlug);
  if (normalizedToolSlug === 'chatgpt' || DIRECT_TICKET_ONLY_TOOLS.has(normalizedToolSlug)) {
    return null;
  }

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
    usageTrackingTicket: `${storedLaunch.usageTrackingTicket || ''}`.trim(),
    usageTrackingTicketExpiresAt: Number(storedLaunch.usageTrackingTicketExpiresAt || 0),
  };
  await setActiveLaunch(tabId, launch);
  return launch;
}

async function setActiveLaunch(tabId, launch) {
  if (!tabId || !launch?.ticket || !launch?.expiresAt) return;
  const launchMap = await getActiveLaunchMap();
  const existingLaunch = launchMap[`${tabId}`] || {};
  const normalizedToolSlug = normalizeToolSlug(launch.toolSlug);
  const nextTicket = `${launch.ticket}`.trim();
  const sameTicket = `${existingLaunch.ticket || ''}`.trim() === nextTicket;
  launchMap[`${tabId}`] = {
    toolSlug: normalizedToolSlug,
    ticket: nextTicket,
    expiresAt: Number(launch.expiresAt || 0),
    hostname: normalizeHostname(launch.hostname),
    usageTrackingTicket: `${launch.usageTrackingTicket || existingLaunch.usageTrackingTicket || ''}`.trim(),
    usageTrackingTicketExpiresAt: Number(
      launch.usageTrackingTicketExpiresAt
      || existingLaunch.usageTrackingTicketExpiresAt
      || 0
    ),
    returnUrl: `${launch.returnUrl || (sameTicket ? existingLaunch.returnUrl : '') || ''}`.trim(),
    activatedAt: Date.now(),
    // Prefer continuity fields carried on the incoming `launch` object itself first
    // (e.g. when getAuthorizedLaunchForTabs() copies an opener/continuation tab's
    // already-prepared record onto a brand new tab id — that new tab has no
    // `existingLaunch`, so relying on `sameTicket` alone would wrongly reset
    // freshSessionPreparedAt to 0 and force a repeat "fresh session" login on
    // every new tab, e.g. clicking "New doc"). Genuinely new launches built from
    // a pending-launch ticket don't set these fields, so they still default to 0.
    freshSessionPreparedAt: Number(
      launch.freshSessionPreparedAt || (sameTicket ? existingLaunch.freshSessionPreparedAt : 0) || 0
    ),
    authTransitionAt: Number(
      launch.authTransitionAt || (sameTicket ? existingLaunch.authTransitionAt : 0) || 0
    ),
    directCredentialIssuedAt: Number(
      launch.directCredentialIssuedAt || (sameTicket ? existingLaunch.directCredentialIssuedAt : 0) || 0
    ),
    inheritedCredentialIssuedAt: Number(
      launch.inheritedCredentialIssuedAt || (sameTicket ? existingLaunch.inheritedCredentialIssuedAt : 0) || 0
    ),
    credentialContinuationCount: Number(
      launch.credentialContinuationCount || (sameTicket ? existingLaunch.credentialContinuationCount : 0) || 0
    ),
    clearSessionOnClose: Boolean(
      normalizedToolSlug === 'genspark'
      || normalizedToolSlug === 'claude'
      || normalizedToolSlug === 'behance'
      || normalizedToolSlug === 'freepik'
      || normalizedToolSlug === 'pinterest'
      || launch.clearSessionOnClose
      || (sameTicket && existingLaunch.clearSessionOnClose)
    ),
    clearGoogleOnClose: Boolean(
      normalizedToolSlug === 'genspark'
      || normalizedToolSlug === 'behance'
      || normalizedToolSlug === 'pinterest'
      || launch.clearGoogleOnClose
      || (sameTicket && existingLaunch.clearGoogleOnClose)
    ),
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

async function revokeActiveLaunch(tabId, toolSlug = '') {
  await clearActiveLaunch(tabId, toolSlug);
  return true;
}

async function markFreshSessionPrepared(tabId, toolSlug = '', returnUrl = '') {
  if (!tabId) return false;
  const launchMap = await getActiveLaunchMap();
  const key = `${tabId}`;
  const current = launchMap[key];
  if (!current) return false;
  if (toolSlug && normalizeToolSlug(current.toolSlug) !== normalizeToolSlug(toolSlug)) {
    return false;
  }

  current.freshSessionPreparedAt = Date.now();
  if (returnUrl) {
    current.returnUrl = `${returnUrl}`.trim();
  }
  launchMap[key] = current;
  await chrome.storage.local.set({ [ACTIVE_TAB_LAUNCHES_STORAGE_KEY]: launchMap });
  return true;
}

async function consumeReturnUrl(tabId, toolSlug = '') {
  if (!tabId) return '';
  const launchMap = await getActiveLaunchMap();
  const key = `${tabId}`;
  const current = launchMap[key];
  if (!current) return '';
  if (toolSlug && normalizeToolSlug(current.toolSlug) !== normalizeToolSlug(toolSlug)) {
    return '';
  }

  const returnUrl = `${current.returnUrl || ''}`.trim();
  if (!returnUrl) return '';

  delete current.returnUrl;
  launchMap[key] = current;
  await chrome.storage.local.set({ [ACTIVE_TAB_LAUNCHES_STORAGE_KEY]: launchMap });
  return returnUrl;
}

async function markAuthTransition(tabId, toolSlug = '') {
  if (!tabId) return false;
  // Reads chrome.storage directly rather than going through
  // getActiveLaunchMap() - that helper prunes any ticket already past its
  // expiresAt (and, for a DIRECT_TICKET_ONLY_TOOLS record with no
  // usageTrackingTicket, like Claude's, deletes the whole entry once the
  // ticket's gone) as a side effect of being READ. Waiting for/fetching the
  // real verification email (the step immediately before this call - see
  // requestAuthLink() in content-claude.js) can itself eat deep into the
  // ticket's 20min budget on a slow mail delivery, so by the time this
  // fires the ticket can already look expired. Going through the pruning
  // helper here would wipe (or fully delete) the record in that exact
  // moment, before authTransitionAt is even set - silently defeating the
  // whole point of this call. Reading raw storage instead means a
  // technically-expired-but-not-yet-pruned record can still be found and
  // revived.
  const stored = await chrome.storage.local.get([ACTIVE_TAB_LAUNCHES_STORAGE_KEY]);
  const launchMap = { ...(stored[ACTIVE_TAB_LAUNCHES_STORAGE_KEY] || {}) };
  const key = `${tabId}`;
  const current = launchMap[key];
  if (!current) return false;
  if (toolSlug && normalizeToolSlug(current.toolSlug) !== normalizeToolSlug(toolSlug)) {
    return false;
  }

  const now = Date.now();
  current.authTransitionAt = now;
  // The actual fix: push the ticket's own clock out by a fresh grace
  // window from THIS moment - the final leg (Claude's own server-side
  // verification + redirect back to the authenticated workspace) is
  // normally a few seconds, decoupled here from whatever the original
  // ticket clock was doing during the earlier, more variable email wait.
  if (current.ticket) {
    current.expiresAt = Math.max(Number(current.expiresAt || 0), now + AUTH_TRANSITION_GRACE_MS);
  }
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

async function markSessionCleanupOnClose(tabId, toolSlug = '', options = {}) {
  if (!tabId) return false;
  const launchMap = await getActiveLaunchMap();
  const key = `${tabId}`;
  const current = launchMap[key];
  if (!current) return false;
  if (toolSlug && normalizeToolSlug(current.toolSlug) !== normalizeToolSlug(toolSlug)) {
    return false;
  }

  const ticket = `${current.ticket || ''}`.trim();
  Object.keys(launchMap).forEach((launchKey) => {
    const item = launchMap[launchKey];
    if (!item) return;
    if (normalizeToolSlug(item.toolSlug) !== normalizeToolSlug(current.toolSlug)) return;
    if (ticket && `${item.ticket || ''}`.trim() !== ticket) return;

    item.clearSessionOnClose = true;
    item.clearGoogleOnClose = Boolean(options.includeGoogle);
    launchMap[launchKey] = item;
  });
  await chrome.storage.local.set({ [ACTIVE_TAB_LAUNCHES_STORAGE_KEY]: launchMap });
  return true;
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
      usageTrackingTicket: `${storedLaunch.usageTrackingTicket || ''}`.trim(),
      usageTrackingTicketExpiresAt: Number(storedLaunch.usageTrackingTicketExpiresAt || 0),
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

function domainsToOrigins(domains) {
  return Array.from(new Set(
    domains
      .map((domain) => `${domain || ''}`.trim().replace(/^\./, ''))
      .filter(Boolean)
      .flatMap((domain) => [`https://${domain}`, `http://${domain}`])
  ));
}

function removeBrowsingData(options, dataTypes) {
  return new Promise((resolve) => {
    if (!chrome.browsingData?.remove) {
      resolve(false);
      return;
    }

    chrome.browsingData.remove(options, dataTypes, () => {
      resolve(!chrome.runtime.lastError);
    });
  });
}

async function clearToolSession(toolSlug, options = {}) {
  const startedAt = Date.now();
  const baseDomains = getToolSessionDomains(toolSlug, { includeGoogle: false });
  const domains = getToolSessionDomains(toolSlug, options);
  let removed = 0;

  // Clear from every cookie store (default AND incognito). Tools launched in
  // incognito keep their session in a separate store, so clearing only the
  // default store would leave the shared login usable in the incognito session.
  let storeIds = [undefined];
  try {
    const cookieStores = await chrome.cookies.getAllCookieStores();
    if (Array.isArray(cookieStores) && cookieStores.length) {
      storeIds = cookieStores.map((store) => store.id);
    }
  } catch {}
  const storesResolvedAt = Date.now();

  // Look up every store x domain combination concurrently, then remove every
  // found cookie concurrently, rather than awaiting each lookup/removal one at
  // a time. With multiple cookie stores and several tool domains this loop can
  // cover dozens of cookies; serializing each round trip to the cookies API
  // added up to several real seconds of wait before the fresh-session redirect
  // could fire, which showed up as the tool tab looking stuck/slow to load.
  const cookieLists = await Promise.all(
    storeIds.flatMap((storeId) => domains.map((domain) => {
      const query = storeId ? { domain, storeId } : { domain };
      return chrome.cookies.getAll(query).catch(() => []);
    }))
  );

  const removalResults = await Promise.all(
    cookieLists.flat().map((cookie) => {
      const host = `${cookie.domain || ''}`.replace(/^\./, '');
      if (!host) return null;
      const url = `${cookie.secure ? 'https' : 'http'}://${host}${cookie.path || '/'}`;
      return chrome.cookies.remove({
        url,
        name: cookie.name,
        storeId: cookie.storeId,
      }).catch(() => null);
    })
  );
  removed = removalResults.filter(Boolean).length;
  const cookiesClearedAt = Date.now();

  const siteDataCleared = await removeBrowsingData(
    { origins: domainsToOrigins(baseDomains) },
    {
      cacheStorage: true,
      fileSystems: true,
      indexedDB: true,
      localStorage: true,
      serviceWorkers: true,
      webSQL: true,
    }
  );

  const finishedAt = Date.now();
  console.log('[RMW clearToolSession] timing', {
    toolSlug,
    cookiesRemoved: removed,
    storeCount: storeIds.length,
    domainCount: domains.length,
    getCookieStoresMs: storesResolvedAt - startedAt,
    cookieClearMs: cookiesClearedAt - storesResolvedAt,
    browsingDataClearMs: finishedAt - cookiesClearedAt,
    totalMs: finishedAt - startedAt,
  });

  return { removed, siteDataCleared };
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

async function setPasswordSavingSuppressedForTab(tabId, suppressed, isIncognito = false) {
  if (!tabId) {
    throw new Error('Active tab required.');
  }

  // Incognito never persists saved passwords, so there is nothing to suppress
  // and Chrome doesn't let the extension flip the (regular-profile) setting for
  // an incognito tab. Report success so the auto-login proceeds to fill.
  if (isIncognito) {
    return { suppressed: Boolean(suppressed), incognito: true };
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

function getIncognitoWindowToolName(toolSlug, toolName = '') {
  const explicitToolName = `${toolName || ''}`.trim();
  if (explicitToolName) return explicitToolName;
  const normalizedSlug = normalizeToolSlug(toolSlug);
  if (normalizedSlug === 'behance') return 'Behance';
  if (normalizedSlug === 'canva') return 'Canva';
  if (normalizedSlug === 'chatgpt') return 'ChatGPT';
  if (normalizedSlug === 'flow') return 'Flow';
  if (normalizedSlug === 'enhancor') return 'Enhancor';
  if (normalizedSlug === 'freepik') return 'Freepik';
  if (normalizedSlug === 'elevenlabs') return 'ElevenLabs';
  if (normalizedSlug === 'pinterest') return 'Pinterest';
  return 'this tool';
}

function appendExtensionLaunchParamsToUrl(launchUrl, toolSlug, extensionTicket = '', usageTrackingTicket = '') {
  const rawUrl = `${launchUrl || ''}`.trim();
  if (!rawUrl) return '';

  const normalizedSlug = normalizeToolSlug(toolSlug);
  const ticket = `${extensionTicket || ''}`.trim();
  const usageTicket = `${usageTrackingTicket || ''}`.trim();
  if (!normalizedSlug && !ticket && !usageTicket) return rawUrl;

  try {
    const url = new URL(rawUrl);
    if (ticket && !url.searchParams.get('rmw_extension_ticket')) {
      url.searchParams.set('rmw_extension_ticket', ticket);
    }
    if (usageTicket && !url.searchParams.get('rmw_usage_ticket')) {
      url.searchParams.set('rmw_usage_ticket', usageTicket);
    }
    if (normalizedSlug && !url.searchParams.get('rmw_tool_slug')) {
      url.searchParams.set('rmw_tool_slug', normalizedSlug);
    }

    const hashParams = new URLSearchParams((url.hash || '').replace(/^#/, ''));
    if (ticket && !hashParams.get('rmw_extension_ticket')) {
      hashParams.set('rmw_extension_ticket', ticket);
    }
    if (usageTicket && !hashParams.get('rmw_usage_ticket')) {
      hashParams.set('rmw_usage_ticket', usageTicket);
    }
    if (normalizedSlug && !hashParams.get('rmw_tool_slug')) {
      hashParams.set('rmw_tool_slug', normalizedSlug);
    }
    url.hash = hashParams.toString();
    return url.toString();
  } catch {
    return rawUrl;
  }
}

function getIncognitoLaunchUrl(toolSlug, launchUrl, extensionTicket = '', usageTrackingTicket = '') {
  const normalizedSlug = normalizeToolSlug(toolSlug);
  const ticketedUrl = appendExtensionLaunchParamsToUrl(launchUrl, normalizedSlug, extensionTicket, usageTrackingTicket);
  if (normalizedSlug === 'flow') {
    return normalizeFlowLaunchUrl(ticketedUrl);
  }
  return ticketedUrl;
}

async function openToolIncognitoWindow(toolSlug, launchUrl, toolName = '', extensionTicket = '', usageTrackingTicket = '') {
  const normalizedSlug = normalizeToolSlug(toolSlug);
  const resolvedToolName = getIncognitoWindowToolName(normalizedSlug, toolName);
  const url = getIncognitoLaunchUrl(normalizedSlug, launchUrl, extensionTicket, usageTrackingTicket);
  if (!url) {
    throw new Error(`${resolvedToolName} launch URL is missing.`);
  }

  const incognitoAllowed = await chrome.extension.isAllowedIncognitoAccess();
  if (!incognitoAllowed) {
    throw new Error(`Enable "Allow in Incognito" for this extension, then launch ${resolvedToolName} again.`);
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

  const launchMap = await getStoredActiveLaunchMap();
  const closedLaunch = launchMap[`${tabId}`];
  const normalizedSlug = normalizeToolSlug(closedLaunch?.toolSlug);

  if (!closedLaunch) {
    return;
  }

  const shouldClearSessionOnClose = CLEAR_SESSION_ON_CLOSE_TOOLS.has(normalizedSlug)
    || Boolean(closedLaunch.clearSessionOnClose);
  if (shouldClearSessionOnClose) {
    const closedTicket = `${closedLaunch.ticket || ''}`.trim();
    const hasOtherToolTabs = Object.entries(launchMap).some(([key, item]) => {
      if (key === `${tabId}`) return false;
      if (normalizeToolSlug(item?.toolSlug) !== normalizedSlug) return false;
      return closedTicket && `${item?.ticket || ''}`.trim() === closedTicket;
    });

    if (!hasOtherToolTabs) {
      const cleanupResult = await clearToolSession(normalizedSlug, {
        includeGoogle: normalizedSlug === 'flow'
          || normalizedSlug === 'genspark'
          || normalizedSlug === 'behance'
          || normalizedSlug === 'pinterest'
          || Boolean(closedLaunch.clearGoogleOnClose),
      });
      console.debug('[RMW Tool Hub Auto Login] Cleared closed-tab session', {
        toolSlug: normalizedSlug,
        tabId,
        ...cleanupResult,
      });
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

function formatApiErrorDetail(detail, fallback = 'Request failed') {
  if (Array.isArray(detail)) {
    const message = detail
      .map((item) => {
        if (!item || typeof item !== 'object') return `${item || ''}`.trim();
        const loc = Array.isArray(item.loc) ? item.loc.join('.') : item.loc;
        const msg = item.msg || item.message || item.type || '';
        return [loc, msg].filter(Boolean).join(': ');
      })
      .filter(Boolean)
      .join('; ');
    return message || fallback;
  }

  if (detail && typeof detail === 'object') {
    return detail.message || detail.msg || JSON.stringify(detail);
  }

  return `${detail || fallback}`;
}

async function fetchCredential(message, senderTabId = 0, openerTabId = 0) {
  const settings = await getSettings();
  const tabId = message.tabId || senderTabId || 0;
  const normalizedToolSlug = normalizeToolSlug(message.toolSlug);
  const providedExtensionTicket = `${message.extensionTicket || ''}`.trim();
  let directLaunch = await getActiveLaunch(tabId, message.toolSlug);
  const requiresDirectTicket = DIRECT_TICKET_ONLY_TOOLS.has(normalizedToolSlug);
  // Direct-ticket tools whose Google/OAuth step opened in a popup or new tab:
  // inherit the direct launch from the opener tab (which holds the real
  // dashboard launch) and bind it to this tab so it counts as a direct launch.
  if (requiresDirectTicket && !directLaunch?.ticket && openerTabId && openerTabId !== tabId) {
    const openerLaunch = await getActiveLaunch(openerTabId, message.toolSlug);
    if (openerLaunch?.ticket) {
      if (tabId) {
        await setActiveLaunch(tabId, openerLaunch);
      }
      directLaunch = openerLaunch;
    }
  }
  const inheritedLaunch = directLaunch?.ticket || requiresDirectTicket
    ? null
    : await getActiveLaunch(openerTabId, message.toolSlug);
  const activeLaunch = directLaunch || inheritedLaunch;
  const launchMode = directLaunch?.ticket ? 'direct' : 'inherited';
  const extensionTicket = `${providedExtensionTicket || activeLaunch?.ticket || ''}`.trim();

  if (!extensionTicket) {
    throw new Error('Open this tool from the dashboard first.');
  }

  if (requiresDirectTicket && !directLaunch?.ticket) {
    throw new Error('Open this tool from the dashboard first.');
  }

  if (requiresDirectTicket && providedExtensionTicket && providedExtensionTicket !== `${directLaunch?.ticket || ''}`.trim()) {
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
      otp_not_before_epoch_ms: Number.isFinite(Number(message.otpNotBeforeMs)) ? Number(message.otpNotBeforeMs) : undefined,
    }),
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.success) {
    const parts = [
      formatApiErrorDetail(data.detail || data.message, `Credential request failed (${response.status})`),
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

  const credential = data?.data?.credential || {};
  const loginMethod = `${credential.loginMethod || credential.login_method || ''}`.trim().toLowerCase();
  if (normalizedToolSlug === 'genspark' && loginMethod === 'google') {
    await markSessionCleanupOnClose(
      launchMode === 'direct' ? tabId : openerTabId,
      'genspark',
      { includeGoogle: true }
    );
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
      otp_not_before_epoch_ms: Number.isFinite(Number(message.otpNotBeforeMs)) ? Number(message.otpNotBeforeMs) : undefined,
      otp_after_uid: message.otpAfterUid ? `${message.otpAfterUid}` : undefined,
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

async function fetchOtpBaseline(message, senderTabId = 0, openerTabId = 0) {
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

  const response = await fetch(`${settings.apiBase}/api/it-tools/extension/otp-baseline`, {
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
    throw new Error(data.detail || data.message || `OTP baseline request failed (${response.status})`);
  }

  return data.latestUid || '';
}

async function fetchAuthLink(message, senderTabId = 0, openerTabId = 0) {
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

  const response = await fetch(`${settings.apiBase}/api/it-tools/extension/auth-link`, {
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
  if (!response.ok || !data.success || !data.authLink) {
    const parts = [
      data.detail || data.message || `Auth link request failed (${response.status})`,
      `api=${settings.apiBase}`,
      `sessionHeader=${settings.sessionToken ? 'yes' : 'no'}`,
      `http=${response.status}`,
    ];
    throw new Error(parts.join(' | '));
  }

  return data.authLink;
}

function buildApiErrorMessage(data, response, fallbackLabel, settings) {
  const parts = [
    data.detail || data.message || `${fallbackLabel} (${response.status})`,
    `api=${settings.apiBase}`,
    `sessionHeader=${settings.sessionToken ? 'yes' : 'no'}`,
    `http=${response.status}`,
  ];
  return parts.join(' | ');
}

async function postTotpRequest(settings, payload) {
  const headers = {
    'Content-Type': 'application/json',
  };

  if (settings.sessionToken) {
    headers['X-Session-Id'] = settings.sessionToken;
  }

  const response = await fetch(`${settings.apiBase}/api/it-tools/extension/totp`, {
    method: 'POST',
    credentials: 'include',
    headers,
    body: JSON.stringify(payload),
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.success || !data.otp) {
    throw new Error(buildApiErrorMessage(data, response, 'TOTP request failed', settings));
  }

  return {
    otp: `${data.otp}`.trim(),
    expiresInSec: Number(data.expiresInSec || 0),
  };
}

async function postCredentialRequest(settings, payload) {
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
    body: JSON.stringify(payload),
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.success) {
    throw new Error(buildApiErrorMessage(data, response, 'Credential request failed', settings));
  }

  return data;
}

async function postUsageEvent(settings, payload) {
  const headers = {
    'Content-Type': 'application/json',
  };

  if (settings.sessionToken) {
    headers['X-Session-Id'] = settings.sessionToken;
  }

  const response = await fetch(`${settings.apiBase}/api/it-tools/extension/usage-event`, {
    method: 'POST',
    credentials: 'include',
    headers,
    body: JSON.stringify(payload),
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.success) {
    const error = new Error(buildApiErrorMessage(data, response, 'Usage event request failed', settings));
    error.status = response.status;
    throw error;
  }

  return data;
}

async function uploadCapturedMedia(message) {
  const settings = await getSettings();
  const dataUrl = `${message.dataUrl || ''}`;
  const filename = `${message.filename || 'kling-mediasource.mp4'}`.trim() || 'kling-mediasource.mp4';
  const relativePath = `${message.relativePath || 'tool-captures/kling'}`.trim();
  const contentType = `${message.contentType || 'video/mp4'}`.trim() || 'video/mp4';
  if (!dataUrl.startsWith('data:')) {
    throw new Error('Captured media payload is missing file data.');
  }

  const blob = await fetch(dataUrl).then((response) => response.blob());
  if (!blob?.size) {
    throw new Error('Captured media file is empty.');
  }

  const formData = new FormData();
  formData.append('files', blob, filename);
  if (relativePath) {
    formData.append('relative_paths', relativePath);
  }

  const headers = {};
  if (settings.sessionToken) {
    headers['X-Session-Id'] = settings.sessionToken;
  }

  const response = await fetch(`${settings.apiBase}/upload`, {
    method: 'POST',
    credentials: 'include',
    headers,
    body: formData,
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.success) {
    const error = new Error(buildApiErrorMessage(data, response, 'Captured media upload failed', settings));
    error.status = response.status;
    throw error;
  }

  const uploaded = Array.isArray(data.data) ? data.data[0] : null;
  if (!uploaded?.url && !uploaded?.path) {
    throw new Error('Captured media upload did not return a permanent URL.');
  }

  const apiBase = `${settings.apiBase || ''}`.replace(/\/+$/, '');
  const openParams = new URLSearchParams();
  if (uploaded.path) {
    openParams.set('path', uploaded.path);
  } else if (uploaded.url) {
    openParams.set('url', uploaded.url);
  }

  const downloadParams = new URLSearchParams(openParams);
  downloadParams.set('filename', uploaded.originalName || uploaded.filename || filename);

  const openUrl = apiBase && openParams.toString()
    ? `${apiBase}/api/files/open?${openParams.toString()}`
    : '';
  const downloadUrl = apiBase && downloadParams.toString()
    ? `${apiBase}/api/files/download?${downloadParams.toString()}`
    : '';
  const storageUrl = `${uploaded.url || ''}`;

  return {
    ...uploaded,
    rawUrl: storageUrl,
    storageUrl,
    openUrl,
    downloadUrl,
    // MediaSource uploads are private R2 objects. Use the app endpoint so the
    // dashboard opens a fresh signed URL instead of storing an expiring blob or
    // an unsigned R2 endpoint that fails with Authorization XML.
    url: openUrl || storageUrl,
    permanentUrl: openUrl || storageUrl,
  };
}

function isAllowedGoogleOauthRecoveryUrl(value = '') {
  try {
    const url = new URL(`${value || ''}`);
    return url.protocol === 'https:'
      && url.hostname === 'accounts.google.com'
      && (
        /oauth|signin|identifier|servicelogin/i.test(url.pathname)
        || /client_id|redirect_uri|oauth/i.test(url.search)
      );
  } catch {
    return false;
  }
}

function isKlingTabUrl(value = '') {
  const hostname = normalizeHostname(value || '');
  return /(^|\.)kling\.ai$|(^|\.)klingai\.com$/.test(hostname);
}

function isElevenLabsTabUrl(value = '') {
  const hostname = normalizeHostname(value || '');
  return /(^|\.)elevenlabs\.io$/.test(hostname);
}

async function allowGooglePopupsForPrimaryPatterns(primaryPatterns, probeUrl, toolLabel) {
  if (!chrome?.contentSettings?.popups?.set) {
    throw new Error('Chrome popup content setting API is unavailable.');
  }

  const secondaryPatterns = [
    undefined,
    '<all_urls>',
    'https://accounts.google.com/*',
    'https://[*.]google.com/*',
    'https://*.google.com/*',
  ];
  const scopes = ['regular', 'incognito_session_only'];
  const applied = [];
  const errors = [];

  for (const primaryPattern of primaryPatterns) {
    for (const secondaryPattern of secondaryPatterns) {
      for (const scope of scopes) {
        const details = {
          primaryPattern,
          setting: 'allow',
          scope,
        };
        if (secondaryPattern) details.secondaryPattern = secondaryPattern;
        try {
          await chrome.contentSettings.popups.set(details);
          applied.push(`${primaryPattern}${secondaryPattern ? ` -> ${secondaryPattern}` : ''}:${scope}`);
        } catch (error) {
          errors.push({
            primaryPattern,
            secondaryPattern: secondaryPattern || '',
            scope,
            error: `${error?.message || error || ''}`.slice(0, 240),
          });
        }
      }
    }
  }

  if (!applied.length) {
    throw new Error(errors[0]?.error || `Chrome rejected all ${toolLabel} popup content settings.`);
  }

  const probes = [];
  if (chrome?.contentSettings?.popups?.get) {
    for (const incognito of [false, true]) {
      try {
        const result = await chrome.contentSettings.popups.get({
          primaryUrl: probeUrl,
          secondaryUrl: 'https://accounts.google.com/',
          incognito,
        });
        probes.push({ incognito, setting: result?.setting || '', source: result?.source || '' });
      } catch (error) {
        probes.push({ incognito, error: `${error?.message || error || ''}`.slice(0, 240) });
      }
    }
  }

  return { applied, errors: errors.slice(0, 12), probes };
}

async function allowKlingGooglePopups() {
  return allowGooglePopupsForPrimaryPatterns(
    [
      'https://kling.ai/*',
      'https://[*.]kling.ai/*',
      'https://*.kling.ai/*',
      'https://klingai.com/*',
      'https://[*.]klingai.com/*',
      'https://*.klingai.com/*',
    ],
    'https://kling.ai/app',
    'Kling'
  );
}

async function allowElevenLabsGooglePopups() {
  return allowGooglePopupsForPrimaryPatterns(
    [
      'https://elevenlabs.io/*',
      'https://[*.]elevenlabs.io/*',
      'https://*.elevenlabs.io/*',
    ],
    'https://elevenlabs.io/app/sign-in',
    'ElevenLabs'
  );
}

const googleOauthRecoveryWindows = new Map();

function buildGoogleOauthRecoveryKey(url, senderTab = null) {
  return [
    Number(senderTab?.windowId || 0) || 'window',
    Number(senderTab?.id || 0) || 'tab',
    `${url || ''}`.slice(0, 1000),
  ].join('|');
}

async function openRecoveredGoogleOauthPopup(url, senderTab = null) {
  if (!isAllowedGoogleOauthRecoveryUrl(url)) {
    throw new Error('Blocked non-Google OAuth recovery URL.');
  }
  const now = Date.now();
  const recoveryKey = buildGoogleOauthRecoveryKey(url, senderTab);
  const existing = googleOauthRecoveryWindows.get(recoveryKey);
  if (existing?.windowId && now - Number(existing.openedAt || 0) < 60000) {
    try {
      const existingWindow = await chrome.windows.get(existing.windowId, { populate: true });
      const existingTab = Array.isArray(existingWindow?.tabs) ? existingWindow.tabs[0] : null;
      if (existingTab?.id) {
        await chrome.tabs.update(existingTab.id, { active: true });
        await chrome.windows.update(existingWindow.id, { focused: true });
        return {
          tabId: Number(existingTab.id || 0) || null,
          windowId: Number(existingWindow.id || 0) || null,
          incognito: Boolean(existingTab.incognito),
          popup: true,
          reused: true,
        };
      }
    } catch {
      googleOauthRecoveryWindows.delete(recoveryKey);
    }
  }
  try {
    const createdWindow = await chrome.windows.create({
      url,
      type: 'popup',
      focused: true,
      incognito: Boolean(senderTab?.incognito),
    });
    const popupTabId = Array.isArray(createdWindow?.tabs) ? Number(createdWindow.tabs[0]?.id || 0) || null : null;
    if (popupTabId && senderTab?.id) {
      const openerLaunch = await getActiveLaunch(senderTab.id, 'kling-ai')
        || await getActiveLaunch(senderTab.id, 'kling')
        || await getActiveLaunch(senderTab.id, 'elevenlabs');
      if (openerLaunch?.ticket) {
        await setActiveLaunch(popupTabId, openerLaunch);
      }
    }
    googleOauthRecoveryWindows.set(recoveryKey, {
      tabId: popupTabId,
      windowId: Number(createdWindow?.id || 0) || null,
      openedAt: now,
    });
    return {
      tabId: popupTabId,
      windowId: Number(createdWindow?.id || 0) || null,
      incognito: Boolean(createdWindow?.incognito),
      popup: true,
    };
  } catch (error) {
    const createParams = {
      url,
      active: true,
    };
    if (senderTab?.windowId != null) {
      createParams.windowId = senderTab.windowId;
    }
    if (senderTab?.id != null) {
      createParams.openerTabId = senderTab.id;
    }
    const createdTab = await chrome.tabs.create(createParams);
    if (createdTab?.id && senderTab?.id) {
      const openerLaunch = await getActiveLaunch(senderTab.id, 'kling-ai')
        || await getActiveLaunch(senderTab.id, 'kling');
      if (openerLaunch?.ticket) {
        await setActiveLaunch(createdTab.id, openerLaunch);
      }
    }
    googleOauthRecoveryWindows.set(recoveryKey, {
      tabId: Number(createdTab?.id || 0) || null,
      windowId: Number(createdTab?.windowId || senderTab?.windowId || 0) || null,
      openedAt: now,
    });
    return {
      tabId: Number(createdTab?.id || 0) || null,
      windowId: Number(createdTab?.windowId || senderTab?.windowId || 0) || null,
      incognito: Boolean(createdTab?.incognito || senderTab?.incognito),
      fallback: true,
      firstError: `${error?.message || error || ''}`.slice(0, 500),
    };
  } finally {
    for (const [key, entry] of googleOauthRecoveryWindows.entries()) {
      if (now - Number(entry?.openedAt || 0) > 5 * 60 * 1000) {
        googleOauthRecoveryWindows.delete(key);
      }
    }
  }
}

function buildUsageEventPayload(message, activeLaunch) {
  return {
    event_id: message.eventId,
    credential_id: message.credentialId,
    tool_slug: message.toolSlug,
    hostname: message.hostname,
    page_url: message.pageUrl,
    event_date: message.eventDate,
    extension_ticket: `${message.extensionTicket || activeLaunch?.ticket || ''}`.trim() || null,
    usage_ticket: `${message.usageTicket || activeLaunch?.usageTrackingTicket || ''}`.trim() || null,
    event_type: message.eventType,
    status: message.status,
    model_label: message.modelLabel,
    duration_label: message.durationLabel,
    resolution_label: message.resolutionLabel,
    prompt_text: message.promptText,
    expected_credits: message.expectedCredits,
    credits_before: message.creditsBefore,
    credits_after: message.creditsAfter,
    credits_burned: message.creditsBurned,
    external_event_id: message.externalEventId,
    generation_id: message.generationId,
    request_id: message.requestId,
    fingerprint: message.fingerprint,
    source: message.source,
    schema_version: message.schemaVersion,
    confidence: message.confidence,
    task_id: message.taskId ?? null,
    client_id: message.clientId ?? null,
    metadata: message.metadata || {},
  };
}

function usageRetryKey(payload) {
  return [
    payload.tool_slug,
    payload.credential_id,
    payload.generation_id,
    payload.request_id,
    payload.external_event_id,
    payload.fingerprint,
    payload.status,
    payload.credits_burned,
  ].filter((value) => value !== undefined && value !== null && `${value}`.trim() !== '').join('|');
}

function isRetryableUsageEventError(error) {
  const status = Number(error?.status || 0);
  if (!status) return true;
  return status === 408 || status === 429 || status >= 500;
}

function getUsageRetryDelayMs(attempts) {
  const baseMs = 30 * 1000;
  const exponent = Math.max(0, Math.min(Number(attempts || 0), 6));
  return Math.min(baseMs * (2 ** exponent), 30 * 60 * 1000);
}

async function readUsageRetryQueue() {
  const stored = await chrome.storage.local.get([USAGE_EVENT_RETRY_QUEUE_STORAGE_KEY]);
  const queue = stored[USAGE_EVENT_RETRY_QUEUE_STORAGE_KEY];
  return Array.isArray(queue) ? queue.filter((item) => item && typeof item === 'object') : [];
}

async function writeUsageRetryQueue(queue) {
  const trimmed = queue.slice(-USAGE_EVENT_RETRY_QUEUE_LIMIT);
  await chrome.storage.local.set({ [USAGE_EVENT_RETRY_QUEUE_STORAGE_KEY]: trimmed });
  return trimmed;
}

function scheduleUsageRetry(delayMs = 60 * 1000) {
  try {
    if (chrome?.alarms?.create) {
      chrome.alarms.create(USAGE_EVENT_RETRY_ALARM, { when: Date.now() + Math.max(5000, delayMs) });
      return;
    }
  } catch {}
  setTimeout(() => flushPendingUsageEvents().catch(() => {}), Math.max(5000, delayMs));
}

async function enqueueUsageEventRetry(payload, error) {
  const now = Date.now();
  const queue = await readUsageRetryQueue();
  const key = usageRetryKey(payload) || `usage_${now}_${Math.random().toString(36).slice(2)}`;
  const existingIndex = queue.findIndex((item) => item.key === key);
  const existing = existingIndex >= 0 ? queue[existingIndex] : null;
  const attempts = Number(existing?.attempts || 0);
  const queuedItem = {
    key,
    payload,
    attempts,
    firstQueuedAt: Number(existing?.firstQueuedAt || now),
    lastError: `${error?.message || error || 'Usage event request failed'}`.slice(0, 500),
    nextAttemptAt: now + getUsageRetryDelayMs(attempts),
  };

  if (existingIndex >= 0) {
    queue[existingIndex] = queuedItem;
  } else {
    queue.push(queuedItem);
  }

  await writeUsageRetryQueue(queue);
  scheduleUsageRetry(getUsageRetryDelayMs(attempts));
  return queuedItem;
}

async function flushPendingUsageEvents() {
  const queue = await readUsageRetryQueue();
  if (!queue.length) return { attempted: 0, remaining: 0 };

  const settings = await getSettings();
  const now = Date.now();
  const remaining = [];
  let attempted = 0;

  for (const item of queue) {
    if (attempted >= USAGE_EVENT_RETRY_BATCH_LIMIT || Number(item.nextAttemptAt || 0) > now) {
      remaining.push(item);
      continue;
    }

    attempted += 1;
    try {
      await postUsageEvent(settings, item.payload);
    } catch (error) {
      const attempts = Number(item.attempts || 0) + 1;
      if (attempts < USAGE_EVENT_RETRY_MAX_ATTEMPTS && isRetryableUsageEventError(error)) {
        remaining.push({
          ...item,
          attempts,
          lastError: `${error?.message || error || 'Usage event retry failed'}`.slice(0, 500),
          nextAttemptAt: now + getUsageRetryDelayMs(attempts),
        });
      }
    }
  }

  await writeUsageRetryQueue(remaining);
  const nextDueAt = remaining.reduce((min, item) => {
    const nextAttemptAt = Number(item.nextAttemptAt || 0);
    return nextAttemptAt > 0 ? Math.min(min, nextAttemptAt) : min;
  }, Number.POSITIVE_INFINITY);
  if (Number.isFinite(nextDueAt)) {
    scheduleUsageRetry(Math.max(5000, nextDueAt - Date.now()));
  }

  return { attempted, remaining: remaining.length };
}

async function getToolsForCurrentUser(settings) {
  const headers = {};
  if (settings.sessionToken) {
    headers['X-Session-Id'] = settings.sessionToken;
  }

  const response = await fetch(`${settings.apiBase}/api/it-tools/tools`, {
    method: 'GET',
    credentials: 'include',
    headers,
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.success || !Array.isArray(data.tools)) {
    throw new Error(buildApiErrorMessage(data, response, 'Tool list request failed', settings));
  }

  return data.tools;
}

async function launchExtensionTool(settings, toolId) {
  const headers = {};
  if (settings.sessionToken) {
    headers['X-Session-Id'] = settings.sessionToken;
  }

  const response = await fetch(`${settings.apiBase}/api/it-tools/tools/${toolId}/launch`, {
    method: 'POST',
    credentials: 'include',
    headers,
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.success || !data.extensionAutoFill || !data.extensionTicket) {
    throw new Error(buildApiErrorMessage(data, response, 'Tool launch request failed', settings));
  }

  return data;
}

function isMissingTotpSecretErrorMessage(errorMessage) {
  const normalized = `${errorMessage || ''}`.trim();
  return normalized.includes('No TOTP secret configured') || normalized.includes('http=404');
}

function normalizeLoginIdentifier(value) {
  return `${value || ''}`.trim().toLowerCase();
}

async function findFlowTotpFallbackLaunch(openerTabId = 0, hostname = '', pageUrl = '') {
  const openerLaunch = await getActiveLaunch(openerTabId, 'flow');
  if (openerLaunch?.ticket) {
    return openerLaunch;
  }

  const recentLaunch = await getRecentContinuationLaunch('flow', hostname, pageUrl);
  if (recentLaunch?.ticket) {
    return recentLaunch;
  }

  return null;
}

async function createFlowTotpFallbackLaunch(settings) {
  const tools = await getToolsForCurrentUser(settings);
  const flowTool = tools.find((tool) => normalizeToolSlug(tool?.slug) === 'flow');
  if (!flowTool?.id) {
    return null;
  }

  const launchResponse = await launchExtensionTool(settings, flowTool.id);
  const extensionTicket = `${launchResponse.extensionTicket || ''}`.trim();
  const expiresAtSec = Number(launchResponse.extensionTicketExpiresAt || 0);
  if (!extensionTicket || !expiresAtSec) {
    return null;
  }

  return {
    toolSlug: 'flow',
    ticket: extensionTicket,
    expiresAt: expiresAtSec * 1000,
    hostname: normalizeHostname(flowTool.websiteUrl || flowTool.loginUrl || ''),
  };
}

async function tryFetchChatgptTotpFromFlow(settings, message, openerTabId = 0) {
  if (normalizeToolSlug(message.toolSlug) !== 'chatgpt') {
    return null;
  }

  const flowLaunch = await findFlowTotpFallbackLaunch(openerTabId, message.hostname, message.pageUrl)
    || await createFlowTotpFallbackLaunch(settings);
  if (!flowLaunch?.ticket) {
    return null;
  }

  const expectedLoginIdentifier = normalizeLoginIdentifier(message.loginIdentifier);
  if (expectedLoginIdentifier) {
    try {
      const flowCredential = await postCredentialRequest(settings, {
        tool_slug: 'flow',
        hostname: message.hostname,
        page_url: message.pageUrl,
        extension_ticket: flowLaunch.ticket,
      });
      const flowLoginIdentifier = normalizeLoginIdentifier(flowCredential?.credential?.loginIdentifier);
      if (!flowLoginIdentifier || flowLoginIdentifier !== expectedLoginIdentifier) {
        return null;
      }
    } catch {
      return null;
    }
  }

  return postTotpRequest(settings, {
    tool_slug: 'flow',
    hostname: message.hostname,
    page_url: message.pageUrl,
    extension_ticket: flowLaunch.ticket,
  });
}

async function fetchTotp(message, senderTabId = 0, openerTabId = 0) {
  const settings = await getSettings();
  const tabId = message.tabId || senderTabId || 0;
  const directLaunch = await getActiveLaunch(tabId, message.toolSlug);
  const inheritedLaunch = directLaunch?.ticket ? null : await getActiveLaunch(openerTabId, message.toolSlug);
  const activeLaunch = directLaunch || inheritedLaunch;
  const extensionTicket = `${message.extensionTicket || activeLaunch?.ticket || ''}`.trim();

  if (!extensionTicket) {
    throw new Error('Open this tool from the dashboard first.');
  }

  try {
    return await postTotpRequest(settings, {
      tool_slug: message.toolSlug,
      hostname: message.hostname,
      page_url: message.pageUrl,
      extension_ticket: extensionTicket || null,
    });
  } catch (error) {
    const errorMessage = `${error?.message || error || ''}`;
    if (isMissingTotpSecretErrorMessage(errorMessage)) {
      const fallbackResult = await tryFetchChatgptTotpFromFlow(settings, message, openerTabId);
      if (fallbackResult?.otp) {
        return fallbackResult;
      }
    }
    throw error;
  }
}

// Kling equivalents of background-freepik-capture.js's
// handleFreepikFetchMyActiveTasksMessage/handleFreepikFetchActiveClientsMessage -
// same generic /api/tasks/my-active and /api/clients/active endpoints (see
// utils/task_gate.py, utils/client_gate.py), just resolved against the
// Kling launch ticket instead of Freepik's. Kept here rather than in a new
// background-kling-capture.js since Kling's background-side footprint is
// otherwise just reportUsageEvent below - not worth a whole new file yet.
// content-kling.js's own TOOL_SLUG constant is 'kling-ai' - that's what
// actually gets stamped into the stored launch map entry (setActiveLaunch),
// and normalizeToolSlug() does NOT alias it to 'kling'. Every other
// kling-flavored getActiveLaunch() call in this file already tries
// 'kling-ai' before falling back to 'kling' (see e.g. line ~1846) - this
// mirrors that instead of hardcoding the wrong slug.
async function getActiveKlingLaunch(tabId) {
  return (await getActiveLaunch(tabId, 'kling-ai')) || (await getActiveLaunch(tabId, 'kling'));
}

async function handleKlingFetchMyActiveTasksMessage(message, senderTabId = 0, openerTabId = 0) {
  const tabId = message?.tabId || senderTabId || 0;
  const directLaunch = await getActiveKlingLaunch(tabId);
  const inheritedLaunch = directLaunch?.ticket ? null : await getActiveKlingLaunch(openerTabId);
  const activeLaunch = directLaunch || inheritedLaunch;

  if (!activeLaunch?.ticket && !activeLaunch?.usageTrackingTicket) {
    return { ok: false, error: 'Launch Kling from the dashboard before task selection can run.', reason: 'session_expired' };
  }

  try {
    const settings = await getSettings();
    const params = new URLSearchParams();
    if (activeLaunch.usageTrackingTicket) params.set('usage_ticket', activeLaunch.usageTrackingTicket);
    if (activeLaunch.ticket) params.set('extension_ticket', activeLaunch.ticket);
    // Tells the backend to validate the ticket against the Kling tool row
    // instead of defaulting to Freepik (see tasks_router.py's
    // _resolve_generation_gate_tool) - without this a perfectly valid Kling
    // ticket fails validation because it was checked against the wrong tool.
    params.set('tool_slug', 'kling-ai');

    const headers = {};
    if (settings.sessionToken) headers['X-Session-Id'] = settings.sessionToken;

    const response = await fetch(`${settings.apiBase}/api/tasks/my-active?${params.toString()}`, {
      method: 'GET',
      credentials: 'include',
      headers,
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.success) {
      const reason = response.status === 410 || response.status === 403 ? 'session_expired' : undefined;
      return { ok: false, error: buildApiErrorMessage(data, response, 'Unable to load your tasks', settings), reason };
    }
    return { ok: true, tasks: Array.isArray(data.tasks) ? data.tasks : [] };
  } catch (error) {
    return { ok: false, error: error?.message || 'Unable to load your tasks' };
  }
}

async function handleKlingFetchActiveClientsMessage(message, senderTabId = 0, openerTabId = 0) {
  const tabId = message?.tabId || senderTabId || 0;
  const directLaunch = await getActiveKlingLaunch(tabId);
  const inheritedLaunch = directLaunch?.ticket ? null : await getActiveKlingLaunch(openerTabId);
  const activeLaunch = directLaunch || inheritedLaunch;

  if (!activeLaunch?.ticket && !activeLaunch?.usageTrackingTicket) {
    return { ok: false, error: 'Launch Kling from the dashboard before client selection can run.', reason: 'session_expired' };
  }

  try {
    const settings = await getSettings();
    const params = new URLSearchParams();
    if (activeLaunch.usageTrackingTicket) params.set('usage_ticket', activeLaunch.usageTrackingTicket);
    if (activeLaunch.ticket) params.set('extension_ticket', activeLaunch.ticket);
    // See the identical comment in handleKlingFetchMyActiveTasksMessage above.
    params.set('tool_slug', 'kling-ai');

    const headers = {};
    if (settings.sessionToken) headers['X-Session-Id'] = settings.sessionToken;

    const response = await fetch(`${settings.apiBase}/api/clients/active?${params.toString()}`, {
      method: 'GET',
      credentials: 'include',
      headers,
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.success) {
      const reason = response.status === 410 || response.status === 403 ? 'session_expired' : undefined;
      return { ok: false, error: buildApiErrorMessage(data, response, 'Unable to load clients', settings), reason };
    }
    return { ok: true, clients: Array.isArray(data.clients) ? data.clients : [] };
  } catch (error) {
    return { ok: false, error: error?.message || 'Unable to load clients' };
  }
}

async function reportUsageEvent(message, senderTabId = 0, openerTabId = 0) {
  const settings = await getSettings();
  const tabId = message.tabId || senderTabId || 0;
  const directLaunch = await getActiveLaunch(tabId, message.toolSlug);
  const inheritedLaunch = directLaunch?.ticket ? null : await getActiveLaunch(openerTabId, message.toolSlug);
  const activeLaunch = directLaunch || inheritedLaunch;
  const payload = buildUsageEventPayload(message, activeLaunch);

  try {
    return await postUsageEvent(settings, payload);
  } catch (error) {
    if (!isRetryableUsageEventError(error)) {
      throw error;
    }
    const queued = await enqueueUsageEventRetry(payload, error);
    return {
      success: true,
      queued: true,
      retryKey: queued.key,
      retryAttempts: queued.attempts,
      retryAt: queued.nextAttemptAt,
    };
  }
}

function handleRuntimeMessage(message, sender, sendResponse) {
  const senderTabId = sender?.tab?.id || 0;
  const senderOpenerTabId = sender?.tab?.openerTabId || 0;
  const senderUrl = sender?.url || sender?.tab?.url || '';
  const senderIsDashboard = isAllowedDashboardUrl(senderUrl);

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
        authTransitionAt: Number(launch?.authTransitionAt || 0),
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

  if (message?.type === 'TOOL_HUB_GET_TAB_ID') {
    sendResponse({
      ok: true,
      tabId: senderTabId || 0,
      openerTabId: senderOpenerTabId || 0,
    });
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
    markFreshSessionPrepared(senderTabId, message.toolSlug, message.returnUrl)
      .then((ok) => sendResponse({ ok }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === 'TOOL_HUB_CONSUME_RETURN_URL') {
    consumeReturnUrl(senderTabId, message.toolSlug)
      .then((returnUrl) => sendResponse({ ok: true, returnUrl }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === 'TOOL_HUB_MARK_AUTH_TRANSITION') {
    markAuthTransition(senderTabId, message.toolSlug)
      .then((ok) => sendResponse({ ok }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === 'TOOL_HUB_REVOKE_ACTIVE_LAUNCH') {
    revokeActiveLaunch(senderTabId, message.toolSlug)
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
    setPasswordSavingSuppressedForTab(senderTabId, Boolean(message.suppressed), Boolean(sender?.tab?.incognito))
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === 'TOOL_HUB_SYNC_AUTH_CONTEXT') {
    if (!senderIsDashboard) {
      sendResponse({ ok: false, error: 'Auth sync is only allowed from the dashboard.' });
      return true;
    }

    syncAuthContext(message)
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === 'TOOL_HUB_OPEN_INCOGNITO_WINDOW' || message?.type === 'TOOL_HUB_OPEN_FLOW_ISOLATED_WINDOW') {
    if (!senderIsDashboard) {
      sendResponse({ ok: false, error: 'Tool launches are only allowed from the dashboard.' });
      return true;
    }

    if (!normalizeToolSlug(message.toolSlug) || !`${message.launchUrl || ''}`.trim()) {
      sendResponse({ ok: false, error: 'Incognito window launch details are incomplete.' });
      return true;
    }

    openToolIncognitoWindow(
      message.toolSlug,
      message.launchUrl,
      message.toolName,
      message.extensionTicket,
      message.usageTrackingTicket
    )
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === 'TOOL_HUB_OPEN_GOOGLE_OAUTH_POPUP') {
    if (!isKlingTabUrl(sender?.tab?.url || '') && !isElevenLabsTabUrl(sender?.tab?.url || '')) {
      sendResponse({ ok: false, error: 'Google OAuth popup recovery is only allowed from Kling or ElevenLabs tabs.' });
      return true;
    }
    openRecoveredGoogleOauthPopup(`${message.url || ''}`.trim(), sender?.tab || null)
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === 'TOOL_HUB_ALLOW_KLING_GOOGLE_POPUPS') {
    if (!isKlingTabUrl(sender?.tab?.url || '')) {
      sendResponse({ ok: false, error: 'Kling popup allowance is only allowed from Kling tabs.' });
      return true;
    }

    allowKlingGooglePopups()
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === 'TOOL_HUB_ALLOW_ELEVENLABS_GOOGLE_POPUPS') {
    if (!isElevenLabsTabUrl(sender?.tab?.url || '')) {
      sendResponse({ ok: false, error: 'ElevenLabs popup allowance is only allowed from ElevenLabs tabs.' });
      return true;
    }

    allowElevenLabsGooglePopups()
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

  if (message?.type === 'TOOL_HUB_PREPARE_OTP_BASELINE') {
    fetchOtpBaseline(message, senderTabId, senderOpenerTabId)
      .then((latestUid) => sendResponse({ ok: true, latestUid }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === 'TOOL_HUB_FETCH_AUTH_LINK') {
    fetchAuthLink(message, senderTabId, senderOpenerTabId)
      .then((authLink) => sendResponse({ ok: true, authLink }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === 'TOOL_HUB_FETCH_TOTP') {
    fetchTotp(message, senderTabId, senderOpenerTabId)
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === 'TOOL_HUB_REPORT_USAGE_EVENT') {
    reportUsageEvent(message, senderTabId, senderOpenerTabId)
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === 'TOOL_HUB_UPLOAD_CAPTURED_MEDIA') {
    uploadCapturedMedia(message)
      .then((uploaded) => sendResponse({ ok: true, uploaded }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === 'CHATGPT_CAPTURE_EVENT') {
    handleChatGptCaptureEventMessage(message)
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === 'CHATGPT_CAPTURE_ATTACHMENT') {
    handleChatGptCaptureAttachmentMessage(message)
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === 'CHATGPT_MEDIA_CAPTURED') {
    handleChatGptCaptureMediaMessage(message)
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === 'FREEPIK_CAPTURE_EVENT') {
    handleFreepikCaptureEventMessage(message, senderTabId, senderOpenerTabId)
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === 'FREEPIK_SYNC_PROGRESS') {
    handleFreepikSyncProgressMessage(message, senderTabId, senderOpenerTabId)
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === 'FREEPIK_FETCH_MY_ACTIVE_TASKS') {
    handleFreepikFetchMyActiveTasksMessage(message, senderTabId, senderOpenerTabId)
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === 'FREEPIK_FETCH_ACTIVE_CLIENTS') {
    handleFreepikFetchActiveClientsMessage(message, senderTabId, senderOpenerTabId)
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === 'FLOW_CAPTURE_EVENT') {
    handleFlowCaptureEventMessage(message, senderTabId, senderOpenerTabId)
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === 'FLOW_FETCH_MY_ACTIVE_TASKS') {
    handleFlowFetchMyActiveTasksMessage(message, senderTabId, senderOpenerTabId)
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === 'FLOW_FETCH_ACTIVE_CLIENTS') {
    handleFlowFetchActiveClientsMessage(message, senderTabId, senderOpenerTabId)
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === 'ELEVENLABS_CAPTURE_EVENT') {
    handleElevenlabsCaptureEventMessage(message, senderTabId, senderOpenerTabId)
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === 'ELEVENLABS_FETCH_MY_ACTIVE_TASKS') {
    handleElevenlabsFetchMyActiveTasksMessage(message, senderTabId, senderOpenerTabId)
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === 'ELEVENLABS_FETCH_ACTIVE_CLIENTS') {
    handleElevenlabsFetchActiveClientsMessage(message, senderTabId, senderOpenerTabId)
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === 'ELEVENLABS_CAPTURE_AUDIO') {
    handleElevenlabsCaptureAudioMessage(message)
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === 'HEYGEN_CAPTURE_EVENT') {
    handleHeygenCaptureEventMessage(message, senderTabId, senderOpenerTabId)
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === 'HEYGEN_SYNC_PROGRESS') {
    handleHeygenSyncProgressMessage(message, senderTabId, senderOpenerTabId)
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === 'HEYGEN_FETCH_MY_ACTIVE_TASKS') {
    handleHeygenFetchMyActiveTasksMessage(message, senderTabId, senderOpenerTabId)
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === 'HEYGEN_FETCH_ACTIVE_CLIENTS') {
    handleHeygenFetchActiveClientsMessage(message, senderTabId, senderOpenerTabId)
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === 'HIGGSFIELD_CAPTURE_EVENT') {
    handleHiggsfieldCaptureEventMessage(message, senderTabId, senderOpenerTabId)
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === 'HIGGSFIELD_SYNC_PROGRESS') {
    handleHiggsfieldSyncProgressMessage(message, senderTabId, senderOpenerTabId)
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === 'HIGGSFIELD_FETCH_MY_ACTIVE_TASKS') {
    handleHiggsfieldFetchMyActiveTasksMessage(message, senderTabId, senderOpenerTabId)
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === 'HIGGSFIELD_FETCH_ACTIVE_CLIENTS') {
    handleHiggsfieldFetchActiveClientsMessage(message, senderTabId, senderOpenerTabId)
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === 'ENVATO_CAPTURE_EVENT') {
    handleEnvatoCaptureEventMessage(message, senderTabId, senderOpenerTabId)
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === 'ENVATO_CAPTURE_DOWNLOAD_MEDIA') {
    handleEnvatoCaptureDownloadMediaMessage(message)
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === 'ENVATO_SYNC_PROGRESS') {
    handleEnvatoSyncProgressMessage(message, senderTabId, senderOpenerTabId)
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === 'ENVATO_FETCH_MY_ACTIVE_TASKS') {
    handleEnvatoFetchMyActiveTasksMessage(message, senderTabId, senderOpenerTabId)
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === 'ENVATO_FETCH_ACTIVE_CLIENTS') {
    handleEnvatoFetchActiveClientsMessage(message, senderTabId, senderOpenerTabId)
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === 'KLING_FETCH_MY_ACTIVE_TASKS') {
    handleKlingFetchMyActiveTasksMessage(message, senderTabId, senderOpenerTabId)
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === 'KLING_FETCH_ACTIVE_CLIENTS') {
    handleKlingFetchActiveClientsMessage(message, senderTabId, senderOpenerTabId)
      .then((result) => sendResponse(result))
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
}

if (chrome?.runtime?.onMessage) {
  chrome.runtime.onMessage.addListener(handleRuntimeMessage);
}

runSafeStartupTask(() => chrome.storage?.local?.remove?.('rememberedToolLaunches'));

if (chrome?.runtime?.onStartup) {
  chrome.runtime.onStartup.addListener(() => {
    runSafeStartupTask(flushPendingUsageEvents);
    runSafeStartupTask(runChatGptCaptureFlush);
    runSafeStartupTask(() => maybeReportChatGptCaptureHealth(true));
    runSafeStartupTask(() => chrome.alarms.create(CHATGPT_CAPTURE_HEALTH_ALARM, { periodInMinutes: 5 }));
    runSafeStartupTask(runFreepikCaptureFlush);
    runSafeStartupTask(() => maybeReportFreepikCaptureHealth(true));
    runSafeStartupTask(() => chrome.alarms.create(FREEPIK_CAPTURE_HEALTH_ALARM, { periodInMinutes: 5 }));
    runSafeStartupTask(runHiggsfieldCaptureFlush);
    runSafeStartupTask(() => maybeReportHiggsfieldCaptureHealth(true));
    runSafeStartupTask(() => chrome.alarms.create(HIGGSFIELD_CAPTURE_HEALTH_ALARM, { periodInMinutes: 5 }));
    runSafeStartupTask(runEnvatoCaptureFlush);
    runSafeStartupTask(() => maybeReportEnvatoCaptureHealth(true));
    runSafeStartupTask(() => chrome.alarms.create(ENVATO_CAPTURE_HEALTH_ALARM, { periodInMinutes: 5 }));
  });
}

if (chrome?.runtime?.onInstalled) {
  chrome.runtime.onInstalled.addListener(() => {
    runSafeStartupTask(flushPendingUsageEvents);
    runSafeStartupTask(runChatGptCaptureFlush);
    runSafeStartupTask(() => chrome.alarms.create(CHATGPT_CAPTURE_HEALTH_ALARM, { periodInMinutes: 5 }));
    runSafeStartupTask(runFreepikCaptureFlush);
    runSafeStartupTask(() => chrome.alarms.create(FREEPIK_CAPTURE_HEALTH_ALARM, { periodInMinutes: 5 }));
    runSafeStartupTask(runHiggsfieldCaptureFlush);
    runSafeStartupTask(() => chrome.alarms.create(HIGGSFIELD_CAPTURE_HEALTH_ALARM, { periodInMinutes: 5 }));
    runSafeStartupTask(runEnvatoCaptureFlush);
    runSafeStartupTask(() => chrome.alarms.create(ENVATO_CAPTURE_HEALTH_ALARM, { periodInMinutes: 5 }));
  });
}

if (chrome?.alarms?.onAlarm) {
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm?.name === USAGE_EVENT_RETRY_ALARM) {
      runSafeStartupTask(flushPendingUsageEvents);
    }
    if (alarm?.name === CHATGPT_CAPTURE_RETRY_ALARM) {
      runSafeStartupTask(runChatGptCaptureFlush);
    }
    if (alarm?.name === CHATGPT_CAPTURE_HEALTH_ALARM) {
      runSafeStartupTask(() => maybeReportChatGptCaptureHealth(true));
      // Belt-and-suspenders alongside armChatGptCaptureFlushBackstop()'s
      // per-enqueue alarm: this periodic, always-reliable alarm also nudges
      // the queue on every tick. A harmless no-op if it's already empty.
      runSafeStartupTask(() => runChatGptCaptureFlush());
    }
    if (alarm?.name === FREEPIK_CAPTURE_RETRY_ALARM) {
      runSafeStartupTask(runFreepikCaptureFlush);
    }
    if (alarm?.name === FREEPIK_CAPTURE_HEALTH_ALARM) {
      runSafeStartupTask(() => maybeReportFreepikCaptureHealth(true));
    }
    if (alarm?.name === HIGGSFIELD_CAPTURE_RETRY_ALARM) {
      runSafeStartupTask(runHiggsfieldCaptureFlush);
    }
    if (alarm?.name === HIGGSFIELD_CAPTURE_HEALTH_ALARM) {
      runSafeStartupTask(() => maybeReportHiggsfieldCaptureHealth(true));
    }
    if (alarm?.name === ENVATO_CAPTURE_RETRY_ALARM) {
      runSafeStartupTask(runEnvatoCaptureFlush);
    }
    if (alarm?.name === ENVATO_CAPTURE_HEALTH_ALARM) {
      runSafeStartupTask(() => maybeReportEnvatoCaptureHealth(true));
    }
  });
}

if (chrome?.tabs?.onRemoved) {
  chrome.tabs.onRemoved.addListener((tabId) => {
    runSafeStartupTask(() => setPasswordSavingSuppressedForTab(tabId, false));
    runSafeStartupTask(() => cleanupToolSessionForClosedTab(tabId));
  });
}
