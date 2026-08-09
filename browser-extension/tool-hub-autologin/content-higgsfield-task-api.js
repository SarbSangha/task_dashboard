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
// with the same never-rejects-normalize-into-{ok,error} shape.

function fetchMyActiveHiggsfieldTasks() {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: 'HIGGSFIELD_FETCH_MY_ACTIVE_TASKS' }, (response) => {
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
function fetchActiveHiggsfieldClients() {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: 'HIGGSFIELD_FETCH_ACTIVE_CLIENTS' }, (response) => {
      if (chrome.runtime.lastError) {
        resolve({ ok: false, error: chrome.runtime.lastError.message });
        return;
      }
      resolve(response || { ok: false, error: 'No response received' });
    });
  });
}
