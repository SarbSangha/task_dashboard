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
// task-api file. Helper names below are namespaced
// ("elevenlabsTaskApi...") rather than generic, since this file shares its
// isolated-world global scope with content-elevenlabs-capture.js and a name
// collision there would silently break whichever declaration loses.

function elevenlabsTaskApiSendMessage(message) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(message, (response) => {
        if (chrome.runtime.lastError) {
          resolve({ ok: false, error: chrome.runtime.lastError.message });
          return;
        }
        resolve(response || { ok: false, error: 'No response received' });
      });
    } catch (error) {
      // chrome.runtime.sendMessage throws synchronously - bypassing the
      // lastError callback above entirely - once the background context has
      // been invalidated since this content script was injected (extension
      // reloaded/updated while this tab stayed open). Left uncaught, that
      // throw rejects this Promise, which nothing downstream catches, so the
      // Task/Client picker's spinner would be stuck on "Loading…" forever
      // instead of surfacing a Retry state (see content-heygen-task-api.js's
      // identical fix, 2026-09-11, for the reported case this mirrors).
      resolve({
        ok: false,
        error: error?.message || 'Extension was updated or reloaded - please refresh this tab.',
        reason: 'extension_context_invalidated',
      });
    }
  });
}

function elevenlabsTaskApiDelay(ms) {
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
async function elevenlabsTaskApiSendMessageWithRetry(message, attempts = 3, gapMs = 300) {
  let lastResponse = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    lastResponse = await elevenlabsTaskApiSendMessage(message);
    if (lastResponse?.ok) return lastResponse;
    if (attempt < attempts) await elevenlabsTaskApiDelay(gapMs);
  }
  return lastResponse;
}

function fetchMyActiveElevenlabsTasks() {
  return elevenlabsTaskApiSendMessageWithRetry({ type: 'ELEVENLABS_FETCH_MY_ACTIVE_TASKS' });
}

// Client Mapping - admin-curated, global list, independent of the task
// picker above (see backend/routers/clients_router.py GET /api/clients/active).
function fetchActiveElevenlabsClients() {
  return elevenlabsTaskApiSendMessageWithRetry({ type: 'ELEVENLABS_FETCH_ACTIVE_CLIENTS' });
}
