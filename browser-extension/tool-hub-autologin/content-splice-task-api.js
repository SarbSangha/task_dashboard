// content-splice-task-api.js — Task API Service.
//
// Thin wrapper around the SPLICE_FETCH_MY_ACTIVE_TASKS runtime message
// (handled in background-splice-capture.js's
// handleSpliceFetchMyActiveTasksMessage, which resolves identity from the
// same launch ticket every other Splice message here uses). Loaded before
// content-splice-task-modal.js and content-splice-capture.js in
// manifest.json's splice.com content_scripts entry, so its functions are
// available in the shared isolated-world global scope by the time either of
// those references it - mirrors content-epidemicsound-task-api.js exactly,
// renamed.
//
// Function names are namespaced with "Splice" rather than reusing generic
// names, because this file shares its isolated-world global scope with
// content-splice.js (the login-automation script, registered as its own
// separate manifest.json entry but matching the same host) - that file may
// declare generic top-level names. Redeclaring any of those here would throw
// at content-script injection time. See content-epidemicsound-capture.js's
// own header comment for the fuller version of this reasoning.

function spliceTaskApiSendMessage(message) {
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

function spliceTaskApiDelay(ms) {
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
async function spliceTaskApiSendMessageWithRetry(message, attempts = 3, gapMs = 300) {
  let lastResponse = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    lastResponse = await spliceTaskApiSendMessage(message);
    if (lastResponse?.ok) return lastResponse;
    if (attempt < attempts) await spliceTaskApiDelay(gapMs);
  }
  return lastResponse;
}

function fetchMyActiveSpliceTasks() {
  return spliceTaskApiSendMessageWithRetry({ type: 'SPLICE_FETCH_MY_ACTIVE_TASKS' });
}

// Client Mapping - admin-curated, global list, independent of the task
// picker above (see backend/routers/clients_router.py GET /api/clients/active).
function fetchActiveSpliceClients() {
  return spliceTaskApiSendMessageWithRetry({ type: 'SPLICE_FETCH_ACTIVE_CLIENTS' });
}
