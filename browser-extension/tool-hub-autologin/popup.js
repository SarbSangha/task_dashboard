const DEFAULT_API_BASE = 'https://dashboard.ritzmediaworld.in';

const apiBaseInput = document.getElementById('apiBase');
const sessionTokenInput = document.getElementById('sessionToken');
const statusEl = document.getElementById('status');
const saveButton = document.getElementById('save');
const clearButton = document.getElementById('clearToken');

function setStatus(message) {
  statusEl.textContent = message;
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

saveButton.addEventListener('click', saveSettings);
clearButton.addEventListener('click', clearToken);
loadSettings();
