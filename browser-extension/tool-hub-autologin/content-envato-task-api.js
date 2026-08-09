// content-envato-task-api.js — Task API Service.
//
// Thin wrapper around the ENVATO_FETCH_MY_ACTIVE_TASKS runtime message
// (handled in background-envato-capture.js's handleEnvatoFetchMyActiveTasksMessage,
// which resolves identity from the same launch ticket every other Envato
// message here uses). Loaded before content-envato-task-modal.js and
// content-envato-capture.js in manifest.json's app.envato.com content_scripts
// entry, so its functions are available in the shared isolated-world global
// scope by the time either of those references it - mirrors
// content-freepik-task-api.js exactly.

function fetchMyActiveEnvatoTasks() {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: 'ENVATO_FETCH_MY_ACTIVE_TASKS' }, (response) => {
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
function fetchActiveEnvatoClients() {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: 'ENVATO_FETCH_ACTIVE_CLIENTS' }, (response) => {
      if (chrome.runtime.lastError) {
        resolve({ ok: false, error: chrome.runtime.lastError.message });
        return;
      }
      resolve(response || { ok: false, error: 'No response received' });
    });
  });
}
