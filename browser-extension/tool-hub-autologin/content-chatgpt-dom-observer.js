// content-chatgpt-dom-observer.js — isolated world, document_idle.
//
// Narrow DOM fallback ONLY. Network interception (content-chatgpt-network.js)
// is the primary capture mechanism for every event type in the Capture
// Contract - this file exists solely for the handful of signals that don't
// reliably show up on the network layer (see EXTENSION_CAPTURE_DESIGN.md
// section 1). Every signal emitted here is tagged captureSource:
// 'dom_fallback' downstream so Phase 3 normalization/analytics can tell
// network-observed events apart from DOM-inferred ones.
//
// Deliberately does NOT use a document-wide MutationObserver - only the
// <title> element and the sidebar conversation-list container are watched,
// per the task's performance requirements. Canvas/artifact panel detection
// uses a low-frequency polling check instead of an observer, since its
// mount point varies and isn't worth a broad subtree watch.
(function installRmwChatGptDomObserver() {
  if (window.__rmwChatGptDomObserverInstalled) return;
  window.__rmwChatGptDomObserverInstalled = true;
  if (window.top !== window) return; // top frame only - no iframe noise

  const bus = window.RMWChatGPTCapture;
  if (!bus) return; // event-builder must load first (see manifest.json)

  const SIDEBAR_CONTAINER_SELECTORS = [
    '[data-testid*="history" i]',
    '[data-testid*="sidebar" i]',
    'nav',
  ];
  const CANVAS_PANEL_SELECTORS = [
    '[data-testid*="canvas" i]',
    '[data-testid*="artifact" i]',
    '[class*="canvas" i][class*="panel" i]',
  ];
  const CANVAS_POLL_MS = 2000;
  const CANVAS_POLL_MAX_TICKS = 900; // ~30 min ceiling, then rely on nav/reload to reset
  const SIDEBAR_ATTACH_RETRY_MS = 1500;
  const SIDEBAR_ATTACH_MAX_RETRIES = 20;

  const observers = [];
  let canvasPollTimer = null;
  let canvasPollTicks = 0;
  let sidebarRetryTimer = null;
  let sidebarItemCount = -1;
  let lastSeenTitle = document.title;
  let lastCanvasSeen = false;

  function currentConversationId() {
    const match = location.pathname.match(/\/c\/([^/?#]+)/i);
    return match ? match[1] : '';
  }

  function disconnectAll() {
    observers.forEach((observer) => { try { observer.disconnect(); } catch {} });
    observers.length = 0;
    if (canvasPollTimer) { clearInterval(canvasPollTimer); canvasPollTimer = null; }
    if (sidebarRetryTimer) { clearTimeout(sidebarRetryTimer); sidebarRetryTimer = null; }
  }

  // ---- Title -> rename fallback --------------------------------------------
  function observeTitle() {
    const titleEl = document.querySelector('title');
    if (!titleEl) return;
    const observer = new MutationObserver(() => {
      const nextTitle = document.title;
      if (nextTitle === lastSeenTitle) return;
      const previousTitle = lastSeenTitle;
      lastSeenTitle = nextTitle;
      const conversationId = currentConversationId();
      if (!conversationId) return; // landing page title churn, not a conversation
      bus.emitSignal('CHATGPT_DOM_TITLE_CHANGED', {
        conversationId,
        previousTitle,
        newTitle: nextTitle.replace(/\s*[-|]\s*ChatGPT\s*$/i, '').trim(),
      });
    });
    observer.observe(titleEl, { childList: true, characterData: true, subtree: true });
    observers.push(observer);
  }

  // ---- Sidebar -> best-effort delete fallback -------------------------------
  function findSidebarContainer() {
    for (const selector of SIDEBAR_CONTAINER_SELECTORS) {
      try {
        const match = document.querySelector(selector);
        if (match) return match;
      } catch {}
    }
    return null;
  }

  function observeSidebar(attempt = 0) {
    const container = findSidebarContainer();
    if (!container) {
      if (attempt >= SIDEBAR_ATTACH_MAX_RETRIES) return;
      sidebarRetryTimer = setTimeout(() => observeSidebar(attempt + 1), SIDEBAR_ATTACH_RETRY_MS);
      return;
    }

    const countLinks = () => container.querySelectorAll('a[href*="/c/"]').length;
    sidebarItemCount = countLinks();

    const observer = new MutationObserver(() => {
      const nextCount = countLinks();
      if (nextCount < sidebarItemCount) {
        // Best-effort only: we can't reliably identify *which* conversation id
        // vanished without a stable per-item id in the DOM, so this fires a
        // low-confidence signal scoped to whatever conversation is currently
        // open (if it's the one that disappeared) - otherwise it's dropped by
        // the orchestrator. Documented limitation, not a bug.
        const conversationId = currentConversationId();
        if (conversationId) {
          bus.emitSignal('CHATGPT_DOM_SIDEBAR_ITEM_REMOVED', { conversationId });
        }
      }
      sidebarItemCount = nextCount;
    });
    observer.observe(container, { childList: true, subtree: true });
    observers.push(observer);
  }

  // ---- Canvas/artifact panel -> generation_captured fallback ---------------
  function detectCanvasPanel() {
    for (const selector of CANVAS_PANEL_SELECTORS) {
      try {
        const match = document.querySelector(selector);
        if (match) return match;
      } catch {}
    }
    return null;
  }

  function pollCanvasPanel() {
    canvasPollTicks += 1;
    if (canvasPollTicks > CANVAS_POLL_MAX_TICKS) {
      clearInterval(canvasPollTimer);
      canvasPollTimer = null;
      return;
    }
    const panel = detectCanvasPanel();
    const seen = Boolean(panel);
    if (seen && !lastCanvasSeen) {
      const conversationId = currentConversationId();
      bus.emitSignal('CHATGPT_DOM_CANVAS_DETECTED', { conversationId });
    }
    lastCanvasSeen = seen;
  }

  // Feature-flag gate: if DOM fallback capture is disabled, skip installing
  // any observer/timer at all - not just suppressing what they'd emit. This
  // is the real perf win of the flag (vs. just dropping events downstream).
  bus.readFeatureFlags().then((flags) => {
    if (!flags.enableCapture || !flags.enableDomCapture) return;
    observeTitle();
    observeSidebar();
    canvasPollTimer = setInterval(pollCanvasPanel, CANVAS_POLL_MS);
  }).catch(() => {});

  window.addEventListener('pagehide', disconnectAll, { once: true });
})();
