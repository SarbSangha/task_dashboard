// content-heygen-task-api.js — Task API Service.
//
// Thin wrapper around the HEYGEN_FETCH_MY_ACTIVE_TASKS runtime message
// (handled in background-heygen-capture.js's handleHeygenFetchMyActiveTasksMessage,
// which resolves identity from the same launch ticket every other HeyGen
// message here uses). Loaded before content-heygen-task-modal.js and
// content-heygen.js in manifest.json's heygen content_scripts entry, so its
// one function is available in the shared isolated-world global scope by the
// time either of those references it - mirrors content-freepik-task-api.js
// (this file's template) exactly.
//
// sendRuntimeMessage() (if content-heygen.js defines one) is loaded after
// this file - not usable here. This file talks to chrome.runtime directly
// instead, with the same never-rejects-normalize-into-{ok,error} shape.

function fetchMyActiveHeygenTasks() {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: 'HEYGEN_FETCH_MY_ACTIVE_TASKS' }, (response) => {
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
function fetchActiveHeygenClients() {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: 'HEYGEN_FETCH_ACTIVE_CLIENTS' }, (response) => {
      if (chrome.runtime.lastError) {
        resolve({ ok: false, error: chrome.runtime.lastError.message });
        return;
      }
      resolve(response || { ok: false, error: 'No response received' });
    });
  });
}
