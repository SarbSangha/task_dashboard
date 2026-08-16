// content-flow-task-api.js — Task API Service.
//
// Thin wrapper around the FLOW_FETCH_MY_ACTIVE_TASKS runtime message
// (handled in background-flow-capture.js's handleFlowFetchMyActiveTasksMessage,
// which resolves identity from the same launch ticket every other Flow
// message here uses). Loaded before content-flow-task-modal.js and
// content-flow.js in manifest.json's flow content_scripts entry, so its one
// function is available in the shared isolated-world global scope by the
// time either of those references it - same load-order convention this
// extension already uses everywhere else (see content-freepik-task-api.js,
// this file's template).
//
// sendRuntimeMessage() is defined in content-flow.js, loaded after this
// file - not usable here. This file talks to chrome.runtime directly instead,
// with the same never-rejects-normalize-into-{ok,error} shape.

function fetchMyActiveFlowTasks() {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: 'FLOW_FETCH_MY_ACTIVE_TASKS' }, (response) => {
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
function fetchActiveFlowClients() {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: 'FLOW_FETCH_ACTIVE_CLIENTS' }, (response) => {
      if (chrome.runtime.lastError) {
        resolve({ ok: false, error: chrome.runtime.lastError.message });
        return;
      }
      resolve(response || { ok: false, error: 'No response received' });
    });
  });
}
