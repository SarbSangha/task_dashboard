// content-grammarly-docs-task-api.js — Client API Service.
//
// Thin wrapper around the GRAMMARLY_DOCS_FETCH_ACTIVE_CLIENTS runtime
// message (handled in background-grammarly-docs-capture.js's
// handleGrammarlyDocsFetchActiveClientsMessage, which resolves identity from
// the same launch ticket every other Grammarly message here uses). Loaded
// before content-grammarly-docs-task-modal.js and
// content-grammarly-new-doc-gate.js in manifest.json's app.grammarly.com
// content_scripts entry, so its function is available in the shared
// isolated-world global scope by the time either references it - mirrors
// content-splice-task-api.js exactly, minus the Task counterpart (this gate
// is Client-only - see content-grammarly-docs-task-modal.js's own header
// comment for why).

function grammarlyDocsTaskApiSendMessage(message) {
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

function grammarlyDocsTaskApiDelay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// A page load is often the very first thing that wakes the (MV3,
// non-persistent) background service worker, so the first message here can
// race its cold start and come back empty/disconnected even though the
// request itself was fine - see content-splice-task-api.js's identical
// comment for the fuller account of this race. Retry a few times before
// treating the response as a real failure.
async function grammarlyDocsTaskApiSendMessageWithRetry(message, attempts = 3, gapMs = 300) {
  let lastResponse = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    lastResponse = await grammarlyDocsTaskApiSendMessage(message);
    if (lastResponse?.ok) return lastResponse;
    if (attempt < attempts) await grammarlyDocsTaskApiDelay(gapMs);
  }
  return lastResponse;
}

// Client Mapping - admin-curated, global list, independent of any task
// concept (see backend/routers/clients_router.py GET /api/clients/active).
function fetchActiveGrammarlyDocsClients() {
  return grammarlyDocsTaskApiSendMessageWithRetry({ type: 'GRAMMARLY_DOCS_FETCH_ACTIVE_CLIENTS' });
}
