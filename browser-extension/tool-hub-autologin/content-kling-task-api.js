// content-kling-task-api.js — Task API Service.
//
// Kling's equivalent of content-freepik-task-api.js. Thin wrapper around the
// KLING_FETCH_MY_ACTIVE_TASKS runtime message (handled in background-main.js's
// handleKlingFetchMyActiveTasksMessage, which resolves identity from the same
// launch ticket every other Kling message here uses). Loaded before
// content-kling-task-modal.js and content-kling.js in manifest.json's kling
// content_scripts entry, so its one function is available in the shared
// isolated-world global scope by the time either of those references it.
//
// content-kling.js defines its own msg()/sendRuntimeMessage-equivalent helper
// but it's declared later in load order - not usable here. This file talks to
// chrome.runtime directly instead, with the same never-rejects-normalize-
// into-{ok,error} shape content-freepik-task-api.js uses.

function fetchMyActiveKlingTasks() {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: 'KLING_FETCH_MY_ACTIVE_TASKS' }, (response) => {
      if (chrome.runtime.lastError) {
        resolve({ ok: false, error: chrome.runtime.lastError.message });
        return;
      }
      resolve(response || { ok: false, error: 'No response received' });
    });
  });
}

// Client Mapping - admin-curated, global list, independent of the task
// picker above (see backend/routers/clients_router.py GET /api/clients/active).
function fetchActiveKlingClients() {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: 'KLING_FETCH_ACTIVE_CLIENTS' }, (response) => {
      if (chrome.runtime.lastError) {
        resolve({ ok: false, error: chrome.runtime.lastError.message });
        return;
      }
      resolve(response || { ok: false, error: 'No response received' });
    });
  });
}
