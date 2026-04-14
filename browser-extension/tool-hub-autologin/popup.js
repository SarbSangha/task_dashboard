const DEFAULT_API_BASE = 'https://dashboard.ritzmediaworld.in';

const apiBaseInput = document.getElementById('apiBase');
const sessionTokenInput = document.getElementById('sessionToken');
const statusEl = document.getElementById('status');
const saveButton = document.getElementById('save');
const clearButton = document.getElementById('clearToken');
const clearRememberedButton = document.getElementById('clearRemembered');
const rememberedSitesEl = document.getElementById('rememberedSites');
const rememberedCountEl = document.getElementById('rememberedCount');

function setStatus(message) {
  statusEl.textContent = message;
}

function escapeHtml(value) {
  return `${value || ''}`
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function buildRememberedLaunchUrl(tool) {
  const launchUrl = `${tool?.launchUrl || ''}`.trim();
  if (launchUrl) return launchUrl;
  const hostname = `${tool?.hostname || ''}`.trim();
  return hostname ? `https://${hostname}` : '#';
}

async function loadRememberedSites() {
  const response = await chrome.runtime.sendMessage({ type: 'TOOL_HUB_LIST_REMEMBERED_TOOLS' });
  const tools = response?.ok ? (response.tools || []) : [];
  rememberedCountEl.textContent = `${tools.length}`;

  if (!tools.length) {
    rememberedSitesEl.innerHTML = '<p class="empty-state">Launch a tool from the dashboard once and it will appear here for quick access.</p>';
    return;
  }

  rememberedSitesEl.innerHTML = tools.map((tool) => {
    const label = escapeHtml(tool.toolName || tool.toolSlug || tool.hostname || 'Saved tool');
    const hostname = escapeHtml(tool.hostname || '');
    const href = escapeHtml(buildRememberedLaunchUrl(tool));
    return `
      <a class="remembered-site" href="${href}" target="_blank" rel="noreferrer">
        <span class="remembered-site-name">${label}</span>
        <span class="remembered-site-host">${hostname}</span>
      </a>
    `;
  }).join('');
}

async function loadSettings() {
  const stored = await chrome.storage.local.get(['apiBase', 'sessionToken', 'sessionTokenSyncedAt']);
  apiBaseInput.value = stored.apiBase || DEFAULT_API_BASE;
  sessionTokenInput.value = stored.sessionToken || '';
  if (stored.sessionToken) {
    setStatus(stored.sessionTokenSyncedAt ? 'Session token synced.' : 'Session token saved.');
  } else {
    setStatus('Open the dashboard in another tab to sync your session automatically.');
  }
  await loadRememberedSites();
}

async function saveSettings() {
  const apiBase = (apiBaseInput.value || DEFAULT_API_BASE).trim().replace(/\/+$/, '');
  const sessionToken = (sessionTokenInput.value || '').trim();
  await chrome.storage.local.set({ apiBase, sessionToken });
  setStatus('Saved.');
}

async function clearToken() {
  await chrome.storage.local.remove('sessionToken');
  sessionTokenInput.value = '';
  setStatus('Session token cleared.');
}

async function clearRememberedSites() {
  const response = await chrome.runtime.sendMessage({ type: 'TOOL_HUB_CLEAR_REMEMBERED_TOOLS' });
  if (response?.ok) {
    setStatus('Remembered sites cleared.');
    await loadRememberedSites();
    return;
  }

  setStatus(response?.error || 'Unable to clear remembered sites.');
}

saveButton.addEventListener('click', saveSettings);
clearButton.addEventListener('click', clearToken);
clearRememberedButton.addEventListener('click', clearRememberedSites);
loadSettings();
