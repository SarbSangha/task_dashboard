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
// Helper names below are namespaced ("heygenTaskApi...") rather than
// generic, since this file shares its isolated-world global scope with
// content-heygen.js and a name collision there would silently break
// whichever declaration loses.

function heygenTaskApiSendMessage(message) {
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
      // reloaded/updated while this HeyGen tab stayed open; confirmed
      // 2026-09-11 after a tab left open 30+ min during a dev reload cycle
      // started hitting this on every click). Left uncaught, that throw
      // rejects this Promise, which neither heygenTaskApiSendMessageWithRetry
      // below nor content-heygen-task-modal.js's load() ever catches, so the
      // Task/Client picker's spinner was observed stuck on "Loading…"
      // forever instead of surfacing a Retry state. Resolving here (instead
      // of letting the throw propagate as a rejection) is what lets it reach
      // that Retry UI.
      resolve({
        ok: false,
        error: error?.message || 'Extension was updated or reloaded - please refresh this tab.',
        reason: 'extension_context_invalidated',
      });
    }
  });
}

function heygenTaskApiDelay(ms) {
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
async function heygenTaskApiSendMessageWithRetry(message, attempts = 3, gapMs = 300) {
  let lastResponse = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    lastResponse = await heygenTaskApiSendMessage(message);
    if (lastResponse?.ok) return lastResponse;
    if (attempt < attempts) await heygenTaskApiDelay(gapMs);
  }
  return lastResponse;
}

function fetchMyActiveHeygenTasks() {
  return heygenTaskApiSendMessageWithRetry({ type: 'HEYGEN_FETCH_MY_ACTIVE_TASKS' });
}

// Client Mapping - admin-curated, global list, independent of the task
// picker above (see backend/routers/clients_router.py GET /api/clients/active).
function fetchActiveHeygenClients() {
  return heygenTaskApiSendMessageWithRetry({ type: 'HEYGEN_FETCH_ACTIVE_CLIENTS' });
}
