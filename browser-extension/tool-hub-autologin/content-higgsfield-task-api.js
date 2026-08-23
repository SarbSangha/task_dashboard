// content-higgsfield-task-api.js — Task API Service.
//
// Thin wrapper around the HIGGSFIELD_FETCH_MY_ACTIVE_TASKS runtime message
// (handled in background-higgsfield-capture.js's
// handleHiggsfieldFetchMyActiveTasksMessage, which resolves identity from the
// same launch ticket every other Higgsfield message here uses). Loaded
// before content-higgsfield-task-modal.js and content-higgsfield.js in
// manifest.json's higgsfield content_scripts entry, so its functions are
// available in the shared isolated-world global scope by the time either of
// those references it - same load-order convention this extension already
// uses everywhere else (see content-freepik-task-api.js).
//
// sendRuntimeMessage() is defined in content-higgsfield.js, loaded after this
// file - not usable here. This file talks to chrome.runtime directly instead,
// with the same never-rejects-normalize-into-{ok,error} shape. Helper names
// below are namespaced ("higgsfieldTaskApi...") rather than generic, since
// this file shares its isolated-world global scope with content-higgsfield.js
// and a name collision there would silently break whichever declaration
// loses.

function higgsfieldTaskApiSendMessage(message) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) {
        resolve({ ok: false, error: chrome.runtime.lastError.message });
        return;
      }
      resolve(response || { ok: false, error: 'No response received' });
    });
  });
}

function higgsfieldTaskApiDelay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// A page load is often the very first thing that wakes the (MV3,
// non-persistent) background service worker, so the first message here can
// race its cold start and come back empty/disconnected even though the
// request itself was fine - confirmed as the cause of the Task/Client picker
// sometimes showing an empty list or error state the first time it opens
// (see content-epidemicsound.js's sendRuntimeMessageWithRetry for the fuller
// account of this exact race). Retry a few times before treating the
// response as a real failure.
async function higgsfieldTaskApiSendMessageWithRetry(message, attempts = 3, gapMs = 300) {
  let lastResponse = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    lastResponse = await higgsfieldTaskApiSendMessage(message);
    if (lastResponse?.ok) return lastResponse;
    if (attempt < attempts) await higgsfieldTaskApiDelay(gapMs);
  }
  return lastResponse;
}

function fetchMyActiveHiggsfieldTasks() {
  return higgsfieldTaskApiSendMessageWithRetry({ type: 'HIGGSFIELD_FETCH_MY_ACTIVE_TASKS' });
}

// Client Mapping - admin-curated, global list, independent of the task
// picker above (see backend/routers/clients_router.py GET /api/clients/active).
function fetchActiveHiggsfieldClients() {
  return higgsfieldTaskApiSendMessageWithRetry({ type: 'HIGGSFIELD_FETCH_ACTIVE_CLIENTS' });
}
