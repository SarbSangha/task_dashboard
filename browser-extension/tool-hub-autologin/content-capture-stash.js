// Shared by the HeyGen and Higgsfield capture scripts (loaded before them in
// manifest.json, same isolated world).
//
// When the extension is reloaded or auto-updated while a tool tab stays open,
// that tab's content scripts lose their link to the extension: every
// chrome.runtime.sendMessage throws "Extension context invalidated." and the
// capture is gone. Seen live 2026-11-01 - a whole Higgsfield Assets sweep
// (dozens of events) failed this way in an incognito tool tab. Instead of
// dropping them, the capture scripts park the message here (sessionStorage:
// this tab only, survives a refresh) and the fresh script the refresh loads
// sends them on startup.
(function installRmwCaptureStash() {
  if (globalThis.rmwCaptureStash) return;
  const MAX_ITEMS = 300;

  function isInvalidated(errorOrMessage) {
    const text = `${errorOrMessage?.message || errorOrMessage || ''}`;
    if (/extension context invalidated/i.test(text)) return true;
    try {
      return !chrome.runtime?.id;
    } catch {
      return true;
    }
  }

  function read(key) {
    try {
      const list = JSON.parse(window.sessionStorage.getItem(key) || '[]');
      return Array.isArray(list) ? list : [];
    } catch {
      return [];
    }
  }

  function write(key, list) {
    try {
      if (list.length) window.sessionStorage.setItem(key, JSON.stringify(list.slice(-MAX_ITEMS)));
      else window.sessionStorage.removeItem(key);
    } catch {}
  }

  // Returns how many messages are waiting.
  function stash(key, message) {
    const list = read(key);
    const id = message?.event?.client_event_id;
    if (!id || !list.some((item) => item?.event?.client_event_id === id)) list.push(message);
    write(key, list);
    return Math.min(list.length, MAX_ITEMS);
  }

  // Sends every parked message through `send` (the script's own
  // sendRuntimeMessage); anything that still fails stays parked.
  async function drain(key, send) {
    const list = read(key);
    if (!list.length) return 0;
    write(key, []);
    const failed = [];
    for (const message of list) {
      try {
        const result = await send(message);
        if (!result?.ok) failed.push(message);
      } catch {
        failed.push(message);
      }
    }
    if (failed.length) write(key, [...failed, ...read(key)]);
    return list.length - failed.length;
  }

  globalThis.rmwCaptureStash = { isInvalidated, stash, drain };
})();
