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
// into-{ok,error} shape content-freepik-task-api.js uses. Helper names below
// are namespaced ("klingTaskApi...") rather than generic, since this file
// shares its isolated-world global scope with content-kling.js and a name
// collision there would silently break whichever declaration loses.

function klingTaskApiSendMessage(message) {
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

function klingTaskApiDelay(ms) {
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
async function klingTaskApiSendMessageWithRetry(message, attempts = 3, gapMs = 300) {
  let lastResponse = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    lastResponse = await klingTaskApiSendMessage(message);
    if (lastResponse?.ok) return lastResponse;
    if (attempt < attempts) await klingTaskApiDelay(gapMs);
  }
  return lastResponse;
}

function fetchMyActiveKlingTasks() {
  return klingTaskApiSendMessageWithRetry({ type: 'KLING_FETCH_MY_ACTIVE_TASKS' });
}

// Client Mapping - admin-curated, global list, independent of the task
// picker above (see backend/routers/clients_router.py GET /api/clients/active).
function fetchActiveKlingClients() {
  return klingTaskApiSendMessageWithRetry({ type: 'KLING_FETCH_ACTIVE_CLIENTS' });
}
