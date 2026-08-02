// content-freepik-task-api.js — Task API Service.
//
// Thin wrapper around the FREEPIK_FETCH_MY_ACTIVE_TASKS runtime message
// (handled in background-freepik-capture.js's handleFreepikFetchMyActiveTasksMessage,
// which resolves identity from the same launch ticket every other Freepik
// message here uses). Loaded before content-freepik-task-modal.js and
// content-freepik.js in manifest.json's freepik content_scripts entry, so its
// one function is available in the shared isolated-world global scope by the
// time either of those references it - same load-order convention this
// extension already uses everywhere else (see content-freepik.js's own
// header comment on background-freepik-capture.js).
//
// sendRuntimeMessage() is defined in content-freepik.js, loaded after this
// file - not usable here. This file talks to chrome.runtime directly instead,
// with the same never-rejects-normalize-into-{ok,error} shape.

function fetchMyActiveFreepikTasks() {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: 'FREEPIK_FETCH_MY_ACTIVE_TASKS' }, (response) => {
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
function fetchActiveFreepikClients() {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: 'FREEPIK_FETCH_ACTIVE_CLIENTS' }, (response) => {
      if (chrome.runtime.lastError) {
        resolve({ ok: false, error: chrome.runtime.lastError.message });
        return;
      }
      resolve(response || { ok: false, error: 'No response received' });
    });
  });
}
