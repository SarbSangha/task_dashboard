// content-chatgpt-event-builder.js — isolated world, loaded before
// content-chatgpt-dom-observer.js and content-chatgpt.js (see manifest.json).
//
// Turns raw network/DOM signals into Capture Contract-shaped events (see
// backend/providers/chatgpt/CAPTURE_CONTRACT.md and
// backend/providers/chatgpt/constants.py, which are the source of truth for
// event_type strings and per-type payload shapes). This file owns:
//   - client_event_id generation (the idempotency key)
//   - the envelope fields common to every event
//   - per-conversation sequence counters for prompt_captured
//   - defense-in-depth payload sanitization
//
// Deliberately has no knowledge of chrome.runtime/messaging or of how a
// signal was captured (network vs DOM) - that's content-chatgpt.js's job.
(function installRmwChatGptEventBuilder() {
  if (window.RMWChatGPTCapture) return;

  const CAPTURE_VERSION = 1;
  const PROVIDER = 'chatgpt';

  // Must match backend/providers/chatgpt/constants.py ALL_EVENT_TYPES exactly.
  const EVENT_TYPE = {
    CONVERSATION_OPENED: 'conversation_opened',
    CONVERSATION_CREATED: 'conversation_created',
    CONVERSATION_UPDATED: 'conversation_updated',
    CONVERSATION_RENAMED: 'conversation_renamed',
    CONVERSATION_ARCHIVED: 'conversation_archived',
    CONVERSATION_DELETED: 'conversation_deleted',
    PROMPT_CAPTURED: 'prompt_captured',
    MESSAGE_EDITED: 'message_edited',
    RESPONSE_STARTED: 'response_started',
    RESPONSE_COMPLETED: 'response_completed',
    GENERATION_CAPTURED: 'generation_captured',
    FILE_UPLOAD_DETECTED: 'file_upload_detected',
    FILE_DOWNLOAD_DETECTED: 'file_download_detected',
  };

  const CAPTURE_SOURCE = {
    NETWORK_INTERCEPT: 'network_intercept',
    DOM_FALLBACK: 'dom_fallback',
  };

  // ---- Feature flags ---------------------------------------------------
  // Kill switches for a capture system still built against unverified
  // (best-effort) endpoint shapes - see NETWORK_DISCOVERY_GUIDE.md. Stored
  // in chrome.storage.local (shared with the background service worker,
  // which reads the same key independently - see background-chatgpt-capture.js)
  // so any context can flip a flag without a shared module. Fail open
  // (capture stays on) except enableDebug, which fails quiet by default.
  const FEATURE_FLAGS_STORAGE_KEY = 'chatGptCaptureFeatureFlags';
  // NORMAL: capture -> queue -> uploaded to the backend, as normal.
  // DEBUG: same pipeline as NORMAL, but forces verbose console logging on
  //        regardless of enableDebug's stored value - for live-debugging a
  //        production install without flipping a separate flag long-term.
  // DRY_RUN: capture -> queue -> discarded at the upload step instead of
  //        POSTing - lets interception logic be exercised against real
  //        ChatGPT traffic without creating any backend rows at all.
  const CAPTURE_MODES = ['NORMAL', 'DEBUG', 'DRY_RUN'];
  const DEFAULT_FEATURE_FLAGS = {
    enableCapture: true,
    enableNetworkCapture: true,
    enableDomCapture: true,
    enableHealth: true,
    enableDebug: false,
    captureMode: 'NORMAL',
  };

  function normalizeFeatureFlags(flags) {
    const normalized = { ...flags };
    if (!CAPTURE_MODES.includes(normalized.captureMode)) normalized.captureMode = 'NORMAL';
    // DEBUG mode implies verbose logging without needing enableDebug set too.
    normalized.effectiveDebug = Boolean(normalized.enableDebug || normalized.captureMode === 'DEBUG');
    return normalized;
  }

  let cachedFlags = null;
  async function readFeatureFlags() {
    try {
      const stored = await chrome.storage.local.get([FEATURE_FLAGS_STORAGE_KEY]);
      cachedFlags = normalizeFeatureFlags({ ...DEFAULT_FEATURE_FLAGS, ...(stored[FEATURE_FLAGS_STORAGE_KEY] || {}) });
    } catch {
      cachedFlags = normalizeFeatureFlags({ ...DEFAULT_FEATURE_FLAGS });
    }
    return cachedFlags;
  }
  function getCachedFeatureFlags() {
    return cachedFlags || normalizeFeatureFlags({ ...DEFAULT_FEATURE_FLAGS });
  }

  let extensionVersion = '';
  function getExtensionVersion() {
    if (extensionVersion) return extensionVersion;
    try {
      extensionVersion = chrome.runtime.getManifest().version || '';
    } catch {
      extensionVersion = '';
    }
    return extensionVersion;
  }

  function generateClientEventId() {
    try {
      if (typeof crypto?.randomUUID === 'function') return crypto.randomUUID();
    } catch {}
    // Fallback UUID v4 - not cryptographically significant here, this is an
    // idempotency key, not a secret.
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (character) => {
      const random = (Math.random() * 16) | 0;
      const value = character === 'x' ? random : (random & 0x3) | 0x8;
      return value.toString(16);
    });
  }

  // Per-conversation prompt sequence counters. Informational only per the
  // contract (not enforced/deduped server-side), so a simple in-memory,
  // per-tab counter is sufficient - it resets on reload, which is fine since
  // its only purpose is same-session ordering context.
  const promptSequenceByConversation = new Map();
  function nextSequenceIndex(conversationKey) {
    const key = conversationKey || '__pending__';
    const next = (promptSequenceByConversation.get(key) || 0) + 1;
    promptSequenceByConversation.set(key, next);
    return next - 1;
  }

  const SENSITIVE_KEY_RE = /(authorization|cookie|session[-_]?id|access[-_]?token|refresh[-_]?token|api[-_]?key|secret|password)/i;

  // Defense-in-depth only: content-chatgpt-network.js never reads headers or
  // cookies, only request/response bodies, so this should never trigger in
  // practice. Kept because payload_json is opaque to the backend (capture.py
  // stores it as-is) - the extension is the only place that can strip a
  // field before it ever leaves the browser.
  function sanitizePayload(payload) {
    if (!payload || typeof payload !== 'object') return payload;
    const clean = Array.isArray(payload) ? [] : {};
    for (const [key, value] of Object.entries(payload)) {
      if (SENSITIVE_KEY_RE.test(key)) continue;
      clean[key] = value && typeof value === 'object' ? sanitizePayload(value) : value;
    }
    return clean;
  }

  function buildEvent(eventType, { conversationId, messageId, payload, captureSource } = {}) {
    const envelope = {
      event_type: eventType,
      client_event_id: generateClientEventId(),
      conversation_id: conversationId || undefined,
      message_id: messageId || undefined,
      payload: sanitizePayload({
        ...(payload || {}),
        captureSource: captureSource || CAPTURE_SOURCE.NETWORK_INTERCEPT,
      }),
      capture_version: CAPTURE_VERSION,
      extension_version: getExtensionVersion(),
      browser: `chrome/${(navigator.userAgentData?.brands || []).map((b) => b.version).find(Boolean) || ''}`.replace(/\/$/, '') || undefined,
      event_date: new Date().toISOString().slice(0, 10),
    };
    return envelope;
  }

  // ---- Response-turn state (response_started/response_completed pairing) --
  // Keyed by the network layer's own correlationId so exactly one
  // response_started and one response_completed are ever built per turn,
  // even if the underlying SSE stream is retried.
  const openTurns = new Map();

  function markTurnStarted(correlationId) {
    if (!correlationId || openTurns.has(correlationId)) return false;
    openTurns.set(correlationId, { startedAt: Date.now() });
    if (openTurns.size > 50) {
      const oldestKey = openTurns.keys().next().value;
      if (oldestKey) openTurns.delete(oldestKey);
    }
    return true;
  }

  function consumeTurn(correlationId) {
    const turn = openTurns.get(correlationId);
    if (correlationId) openTurns.delete(correlationId);
    return turn;
  }

  // ---- Tiny signal bus ------------------------------------------------------
  // content-chatgpt-network.js (MAIN world) can only reach this isolated
  // world via window.postMessage, but content-chatgpt-dom-observer.js runs
  // in this same isolated world and content-chatgpt.js loads right after it
  // (see manifest.json content_scripts ordering) - both can call emitSignal
  // directly. content-chatgpt.js is the single subscriber that maps a signal
  // to a Capture Contract event and forwards it to the background worker,
  // so the signal->event mapping lives in exactly one place.
  const signalHandlers = new Set();
  function subscribe(handler) {
    if (typeof handler === 'function') signalHandlers.add(handler);
    return () => signalHandlers.delete(handler);
  }
  function emitSignal(type, payload) {
    for (const handler of signalHandlers) {
      try { handler(type, payload || {}); } catch {}
    }
  }

  window.RMWChatGPTCapture = {
    EVENT_TYPE,
    CAPTURE_SOURCE,
    CAPTURE_VERSION,
    PROVIDER,
    buildEvent,
    nextSequenceIndex,
    markTurnStarted,
    consumeTurn,
    generateClientEventId,
    subscribe,
    emitSignal,
    readFeatureFlags,
    getCachedFeatureFlags,
  };
})();
