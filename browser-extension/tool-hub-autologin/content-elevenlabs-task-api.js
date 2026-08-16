// content-elevenlabs-task-api.js — Task API Service.
//
// Thin wrapper around the ELEVENLABS_FETCH_MY_ACTIVE_TASKS runtime message
// (handled in background-elevenlabs-capture.js's
// handleElevenlabsFetchMyActiveTasksMessage, which resolves identity from
// the same launch ticket every other ElevenLabs message here uses). Loaded
// before content-elevenlabs-task-modal.js and content-elevenlabs-capture.js
// in manifest.json's elevenlabs content_scripts entry, so its functions are
// available in the shared isolated-world global scope by the time either of
// those references them - same load-order convention this extension already
// uses everywhere else (see content-flow-task-api.js, this file's template).
//
// This file talks to chrome.runtime directly, with the same
// never-rejects-normalize-into-{ok,error} shape as every other tool's
// task-api file.

function fetchMyActiveElevenlabsTasks() {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: 'ELEVENLABS_FETCH_MY_ACTIVE_TASKS' }, (response) => {
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
function fetchActiveElevenlabsClients() {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: 'ELEVENLABS_FETCH_ACTIVE_CLIENTS' }, (response) => {
      if (chrome.runtime.lastError) {
        resolve({ ok: false, error: chrome.runtime.lastError.message });
        return;
      }
      resolve(response || { ok: false, error: 'No response received' });
    });
  });
}
