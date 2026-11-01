// content-figma-capture.js - Figma AI credit capture (isolated world, figma.com).
//
// Forwards what content-figma-network.js (MAIN world) reads - one FIGMA_PROMPT
// per prompt sent to Figma's AI agent, with the credits Figma itself charged,
// and FIGMA_BALANCE for the account's credit bucket - to the background
// outbox (background-figma-capture.js), which adds the tab's dashboard launch
// ticket so the backend knows whose prompt it was.
//
// No Task/Client gate: a prompt is sent from Figma's own chat box, and its
// cost is only known after the reply. Its own file and entry in
// manifest.json, separate from content-figma.js (the login automation), and
// wrapped in a function because both share this isolated world's globals.
(function installRmwFigmaCapture() {
  if (window.__rmwFigmaCaptureInstalled) return;
  window.__rmwFigmaCaptureInstalled = true;

  const SOURCE = 'rmw-figma-network-telemetry';
  let hideTimer = null;

  function sendRuntimeMessage(message) {
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
        resolve({ ok: false, error: error?.message || 'Extension unavailable' });
      }
    });
  }

  function showStatus(text) {
    let badge = document.getElementById('rmw-figma-capture-status');
    if (!badge) {
      badge = document.createElement('div');
      badge.id = 'rmw-figma-capture-status';
      Object.assign(badge.style, {
        position: 'fixed', bottom: '72px', right: '16px', zIndex: '2147483647', maxWidth: '300px',
        padding: '8px 12px', borderRadius: '10px', background: 'rgba(15, 23, 42, 0.92)', color: '#f8fafc',
        font: '12px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif', pointerEvents: 'none',
        boxShadow: '0 8px 24px rgba(15, 23, 42, 0.28)', display: 'none',
      });
      (document.body || document.documentElement).appendChild(badge);
    }
    badge.textContent = text;
    badge.style.display = 'block';
    if (hideTimer) window.clearTimeout(hideTimer);
    hideTimer = window.setTimeout(() => { badge.style.display = 'none'; }, 5000);
  }

  async function forward(eventType, clientEventId, payload) {
    const result = await sendRuntimeMessage({
      type: 'FIGMA_CAPTURE_EVENT',
      event: { event_type: eventType, client_event_id: clientEventId, payload, capture_version: 1 },
    });
    if (!result?.ok) console.warn('[RMW Figma Capture] not queued', { eventType, error: result?.error });
    return result;
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.source !== SOURCE || !data.payload) return;

    if (data.type === 'FIGMA_PROMPT') {
      const p = data.payload;
      if (!p.userActionUuid) return;
      // One id per credit figure: a prompt is reported again when Figma's
      // number for it changes (content-figma-network.js keeps re-reading it),
      // and the outbox would drop a repeat of the same id as already queued.
      // The backend upserts on userActionUuid and keeps the newest figure.
      const id = p.credits == null ? p.userActionUuid : `${p.userActionUuid}:c${p.credits}`;
      forward('prompt', id, p).then((result) => {
        if (!result?.ok) return;
        showStatus(p.credits == null
          ? 'Figma prompt recorded - credits not known yet'
          : `Figma prompt recorded - ${p.credits} AI credit${p.credits === 1 ? '' : 's'}`);
      });
    } else if (data.type === 'FIGMA_BALANCE') {
      const b = data.payload;
      forward('balance', `balance:${b.figmaUserId || 'unknown'}:${b.capturedAtMs}`, b);
    }
  });
})();
