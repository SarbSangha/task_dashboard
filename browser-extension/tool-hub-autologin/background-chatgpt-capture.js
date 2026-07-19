// background-chatgpt-capture.js — loaded via importScripts() from
// background.js, before background-main.js (see manifest ordering there).
//
// Owns the ChatGPT raw-capture outbox: one shared queue for the whole
// browser (not per-tab, not per-window - see EXTENSION_CAPTURE_DESIGN.md
// "Multi-tab isolation"), persisted to chrome.storage.local so a crash or
// extension reload never loses a queued event, batched per
// CAPTURE_CONTRACT.md's reliability class (LOSSLESS - see
// backend/providers/chatgpt/constants.py RELIABILITY_CLASS). Reuses the
// exact retry-backoff formula and chrome.alarms wake-up pattern
// background-main.js already uses for Kling's usage-event queue
// (readUsageRetryQueue/writeUsageRetryQueue/scheduleUsageRetry) rather than
// inventing a second retry mechanism - the only real difference is this
// queue never gives up after N attempts.
//
// getSettings() and buildApiErrorMessage() are defined in background-main.js
// and reused here as-is (both files run in the same classic service-worker
// global scope via importScripts, so no re-declaration is needed).

const CHATGPT_CAPTURE_QUEUE_STORAGE_KEY = 'pendingChatGptCaptureEvents';
const CHATGPT_CAPTURE_SESSION_ID_STORAGE_KEY = 'chatGptCaptureExtensionSessionId';
const CHATGPT_CAPTURE_RETRY_ALARM = 'retryPendingChatGptCaptureEvents';
const CHATGPT_CAPTURE_HEALTH_ALARM = 'reportChatGptCaptureHealth';
const CHATGPT_CAPTURE_BATCH_MAX = 200;
const CHATGPT_CAPTURE_FLUSH_QUIET_MS = 500;
const CHATGPT_CAPTURE_FLUSH_MAX_WAIT_MS = 2000;
const CHATGPT_CAPTURE_FLUSH_EVENT_THRESHOLD = 50;
// Safety valve only, not a normal operating ceiling - see EXTENSION_CAPTURE_DESIGN.md
// "bounded by queue size, not age or attempt count". Hitting this is a Capture
// Health signal (queue_length pinned, offline_since growing), not an
// expected steady state; exists purely so a backend outage of weeks doesn't
// grow chrome.storage.local without bound. manifest.json requests the
// "unlimitedStorage" permission specifically because capture events carry
// full prompt/response text (up to ~20KB each, truncated) - without it,
// storage.local's default ~10MB quota would be exhausted by this ceiling
// alone (5000 * 20KB = ~100MB), turning "lossless" into silent write
// failures well before this constant is ever consulted.
const CHATGPT_CAPTURE_QUEUE_HARD_LIMIT = 5000;
const CHATGPT_CAPTURE_HEALTH_MIN_INTERVAL_MS = 5 * 60 * 1000;

// Duplicated (not imported) from content-chatgpt-event-builder.js on
// purpose: that file runs in a content-script world and this one runs in
// the service worker - there's no bundler to share a module between them,
// and both read the exact same chrome.storage.local key, so they stay in
// sync without a shared file. Keep the defaults identical if either copy
// changes.
const CHATGPT_CAPTURE_FLAGS_STORAGE_KEY = 'chatGptCaptureFeatureFlags';
// NORMAL/DEBUG/DRY_RUN - see content-chatgpt-event-builder.js's CAPTURE_MODES
// comment for the full semantics. DRY_RUN is enforced here in
// flushChatGptCaptureQueue() (this is the only context that actually POSTs
// to the backend); DEBUG's "force verbose logging" is enforced via
// effectiveDebug below, same as the content-script copy.
const CHATGPT_CAPTURE_MODES = ['NORMAL', 'DEBUG', 'DRY_RUN'];
const DEFAULT_CHATGPT_CAPTURE_FLAGS = {
  enableCapture: true,
  enableNetworkCapture: true,
  enableDomCapture: true,
  enableHealth: true,
  enableDebug: false,
  captureMode: 'NORMAL',
};

function normalizeChatGptCaptureFlags(flags) {
  const normalized = { ...flags };
  if (!CHATGPT_CAPTURE_MODES.includes(normalized.captureMode)) normalized.captureMode = 'NORMAL';
  normalized.effectiveDebug = Boolean(normalized.enableDebug || normalized.captureMode === 'DEBUG');
  return normalized;
}

async function readChatGptCaptureFeatureFlags() {
  try {
    const stored = await chrome.storage.local.get([CHATGPT_CAPTURE_FLAGS_STORAGE_KEY]);
    return normalizeChatGptCaptureFlags({ ...DEFAULT_CHATGPT_CAPTURE_FLAGS, ...(stored[CHATGPT_CAPTURE_FLAGS_STORAGE_KEY] || {}) });
  } catch {
    return normalizeChatGptCaptureFlags({ ...DEFAULT_CHATGPT_CAPTURE_FLAGS });
  }
}

const chatGptCaptureHealthState = {
  lastCaptureEventAt: 0,
  lastSuccessfulUploadAt: 0,
  lastFailedUploadAt: 0,
  offlineSince: 0,
  lastPingAt: 0,
  uploadDurationsMs: [],
};

// Local-only counters (not part of CaptureHealthPingIn's fixed backend
// schema - see providers/chatgpt/schemas.py - extending that is a Phase 2A
// backend change, out of scope here). Surfaced via console.debug, gated by
// enableDebug, so they're available during testing without spamming
// production consoles.
const chatGptCaptureTelemetry = {
  totalEnqueued: 0,
  totalCreated: 0,
  totalDuplicate: 0,
  totalRejected: 0,
  totalUploadFailures: 0,
  totalDroppedForCeiling: 0,
  totalDryRunDiscarded: 0,
  // capture_version -> count seen at enqueue time, in-memory delta since the
  // last flush cycle merged it into the durable storage copy below.
  captureVersionDeltaCounts: {},
};

// Durable (survives service-worker restarts, unlike chatGptCaptureTelemetry
// above) running total of how many events have been enqueued per
// capture_version. Answers "what % of installs are still on an old
// extension version's capture_version" after a schema bump - see
// CAPTURE_CONTRACT.md's versioning rule. Merged from the in-memory delta
// once per flush cycle (batching every enqueue since the last flush into
// one storage write) rather than on every single enqueue, to keep
// chrome.storage.local writes bounded to O(flushes) instead of O(events).
const CHATGPT_CAPTURE_VERSION_DISTRIBUTION_STORAGE_KEY = 'chatGptCaptureVersionDistribution';

async function mergeCaptureVersionDistribution() {
  const delta = chatGptCaptureTelemetry.captureVersionDeltaCounts;
  const deltaKeys = Object.keys(delta);
  if (!deltaKeys.length) return null;
  try {
    const stored = await chrome.storage.local.get([CHATGPT_CAPTURE_VERSION_DISTRIBUTION_STORAGE_KEY]);
    const distribution = { ...(stored[CHATGPT_CAPTURE_VERSION_DISTRIBUTION_STORAGE_KEY] || {}) };
    for (const key of deltaKeys) {
      distribution[key] = Number(distribution[key] || 0) + delta[key];
    }
    await chrome.storage.local.set({ [CHATGPT_CAPTURE_VERSION_DISTRIBUTION_STORAGE_KEY]: distribution });
    chatGptCaptureTelemetry.captureVersionDeltaCounts = {};
    return distribution;
  } catch {
    return null; // leave the delta in place, merged on the next cycle instead
  }
}

let chatGptCaptureQuietTimer = null;
let chatGptCaptureMaxWaitTimer = null;
let chatGptCaptureFlushInFlight = null;

function getChatGptCaptureRetryDelayMs(attempts) {
  const baseMs = 30 * 1000;
  const exponent = Math.max(0, Math.min(Number(attempts || 0), 6));
  return Math.min(baseMs * (2 ** exponent), 30 * 60 * 1000);
}

async function getChatGptCaptureExtensionSessionId() {
  const stored = await chrome.storage.local.get([CHATGPT_CAPTURE_SESSION_ID_STORAGE_KEY]);
  const existing = `${stored[CHATGPT_CAPTURE_SESSION_ID_STORAGE_KEY] || ''}`.trim();
  if (existing) return existing;
  const generated = (typeof crypto?.randomUUID === 'function')
    ? crypto.randomUUID()
    : `sess_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  await chrome.storage.local.set({ [CHATGPT_CAPTURE_SESSION_ID_STORAGE_KEY]: generated });
  return generated;
}

async function readChatGptCaptureQueue() {
  const stored = await chrome.storage.local.get([CHATGPT_CAPTURE_QUEUE_STORAGE_KEY]);
  const queue = stored[CHATGPT_CAPTURE_QUEUE_STORAGE_KEY];
  return Array.isArray(queue) ? queue.filter((item) => item && typeof item === 'object') : [];
}

async function writeChatGptCaptureQueue(queue) {
  if (queue.length > CHATGPT_CAPTURE_QUEUE_HARD_LIMIT) {
    const overflow = queue.length - CHATGPT_CAPTURE_QUEUE_HARD_LIMIT;
    chatGptCaptureTelemetry.totalDroppedForCeiling += overflow;
    // Always logs regardless of enableDebug - this is an operational alarm
    // (real, unrecoverable data loss), not routine capture chatter.
    console.error(
      '[RMW ChatGPT Capture] Queue exceeded hard ceiling - dropping oldest events to protect chrome.storage.local',
      { overflow, ceiling: CHATGPT_CAPTURE_QUEUE_HARD_LIMIT, totalDroppedForCeiling: chatGptCaptureTelemetry.totalDroppedForCeiling }
    );
    queue = queue.slice(overflow);
  }
  await chrome.storage.local.set({ [CHATGPT_CAPTURE_QUEUE_STORAGE_KEY]: queue });
  return queue;
}

function scheduleChatGptCaptureRetry(delayMs = 60 * 1000) {
  try {
    if (chrome?.alarms?.create) {
      chrome.alarms.create(CHATGPT_CAPTURE_RETRY_ALARM, { when: Date.now() + Math.max(5000, delayMs) });
      return;
    }
  } catch {}
  setTimeout(() => flushChatGptCaptureQueue().catch(() => {}), Math.max(5000, delayMs));
}

function clearChatGptCaptureFlushTimers() {
  if (chatGptCaptureQuietTimer) { clearTimeout(chatGptCaptureQuietTimer); chatGptCaptureQuietTimer = null; }
  if (chatGptCaptureMaxWaitTimer) { clearTimeout(chatGptCaptureMaxWaitTimer); chatGptCaptureMaxWaitTimer = null; }
}

function scheduleChatGptCaptureFlush() {
  if (chatGptCaptureQuietTimer) clearTimeout(chatGptCaptureQuietTimer);
  chatGptCaptureQuietTimer = setTimeout(() => {
    chatGptCaptureQuietTimer = null;
    runChatGptCaptureFlush();
  }, CHATGPT_CAPTURE_FLUSH_QUIET_MS);

  if (!chatGptCaptureMaxWaitTimer) {
    chatGptCaptureMaxWaitTimer = setTimeout(() => {
      chatGptCaptureMaxWaitTimer = null;
      runChatGptCaptureFlush();
    }, CHATGPT_CAPTURE_FLUSH_MAX_WAIT_MS);
  }
}

function runChatGptCaptureFlush() {
  clearChatGptCaptureFlushTimers();
  chatGptCaptureFlushInFlight = flushChatGptCaptureQueue()
    .catch((error) => {
      console.error('[RMW ChatGPT Capture] Flush failed unexpectedly', error);
    })
    .finally(() => {
      chatGptCaptureFlushInFlight = null;
    });
  return chatGptCaptureFlushInFlight;
}

async function enqueueChatGptCaptureEvent(event) {
  const now = Date.now();
  const queue = await readChatGptCaptureQueue();
  queue.push({
    key: event.client_event_id,
    event,
    enqueuedAt: now,
    attempts: 0,
    lastError: '',
    nextAttemptAt: 0,
  });
  await writeChatGptCaptureQueue(queue);

  chatGptCaptureHealthState.lastCaptureEventAt = now;
  chatGptCaptureTelemetry.totalEnqueued += 1;
  const captureVersionKey = `${event.capture_version || 'unknown'}`;
  chatGptCaptureTelemetry.captureVersionDeltaCounts[captureVersionKey] =
    Number(chatGptCaptureTelemetry.captureVersionDeltaCounts[captureVersionKey] || 0) + 1;

  const readyCount = queue.filter((item) => Number(item.nextAttemptAt || 0) <= now).length;
  if (readyCount >= CHATGPT_CAPTURE_FLUSH_EVENT_THRESHOLD) {
    runChatGptCaptureFlush();
  } else {
    scheduleChatGptCaptureFlush();
  }
}

function recordChatGptCaptureUploadDuration(durationMs) {
  const durations = chatGptCaptureHealthState.uploadDurationsMs;
  durations.push(durationMs);
  if (durations.length > 20) durations.shift();
}

function computeChatGptCaptureAverageUploadTimeMs() {
  const durations = chatGptCaptureHealthState.uploadDurationsMs;
  if (!durations.length) return undefined;
  const total = durations.reduce((sum, value) => sum + value, 0);
  return Math.round(total / durations.length);
}

async function postChatGptCaptureEventsBatch(settings, events) {
  const headers = { 'Content-Type': 'application/json' };
  if (settings.sessionToken) headers['X-Session-Id'] = settings.sessionToken;

  const response = await fetch(`${settings.apiBase}/api/providers/chatgpt/capture/events`, {
    method: 'POST',
    credentials: 'include',
    headers,
    body: JSON.stringify({ events }),
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.success) {
    const error = new Error(buildApiErrorMessage(data, response, 'ChatGPT capture upload failed', settings));
    error.status = response.status;
    throw error;
  }
  return data;
}

async function postChatGptCaptureAttachment(settings, attachment) {
  const headers = { 'Content-Type': 'application/json' };
  if (settings.sessionToken) headers['X-Session-Id'] = settings.sessionToken;

  const response = await fetch(`${settings.apiBase}/api/providers/chatgpt/capture/attachments`, {
    method: 'POST',
    credentials: 'include',
    headers,
    body: JSON.stringify(attachment),
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.success) {
    const error = new Error(buildApiErrorMessage(data, response, 'ChatGPT attachment upload failed', settings));
    error.status = response.status;
    throw error;
  }
  return data;
}

// Best-effort, not lossless: a large data: URL doesn't belong in the same
// persisted retry queue as tiny JSON capture events (see
// content-chatgpt-attachment-capture.js's file-level comment). One attempt,
// logged on failure, never retried - losing a thumbnail preview is an
// acceptable tradeoff the core prompt/response capture never makes.
async function handleChatGptCaptureAttachmentMessage(message) {
  const attachment = message?.attachment;
  if (!attachment || typeof attachment !== 'object' || !attachment.data_url || !attachment.file_name) {
    return { ok: false, error: 'Invalid attachment payload' };
  }
  const flags = await readChatGptCaptureFeatureFlags();
  if (!flags.enableCapture) {
    return { ok: true, uploaded: false, reason: 'capture_disabled' };
  }
  if (flags.captureMode === 'DRY_RUN') {
    return { ok: true, uploaded: false, reason: 'dry_run' };
  }
  try {
    const settings = await getSettings();
    await postChatGptCaptureAttachment(settings, attachment);
    return { ok: true, uploaded: true };
  } catch (error) {
    if (flags.effectiveDebug) {
      console.warn('[RMW ChatGPT Capture] attachment upload failed (not retried)', error?.message || error);
    }
    return { ok: false, error: error?.message || 'Attachment upload failed' };
  }
}

async function postChatGptCaptureMedia(settings, media) {
  const headers = { 'Content-Type': 'application/json' };
  if (settings.sessionToken) headers['X-Session-Id'] = settings.sessionToken;

  const response = await fetch(`${settings.apiBase}/api/providers/chatgpt/capture/media`, {
    method: 'POST',
    credentials: 'include',
    headers,
    body: JSON.stringify(media),
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.success) {
    const error = new Error(buildApiErrorMessage(data, response, 'ChatGPT media upload failed', settings));
    error.status = response.status;
    throw error;
  }
  // httpStatus attached (not part of the backend's own response body) so the
  // content-script trace can log it without a second round-trip - the body
  // itself (data.data: the CaptureMediaOut asset dict, including id/
  // enrichmentStatus) was already being fetched and discarded before this
  // instrumentation pass; nothing about the request/response itself changes.
  return { ...data, httpStatus: response.status };
}

// Additive media-capture layer (Phase 2) - same best-effort, not-lossless
// posture as postChatGptCaptureAttachment/handleChatGptCaptureAttachmentMessage
// just above: a media asset (image/video bytes or metadata) doesn't belong
// in the persisted retry queue used for tiny JSON capture events. One
// attempt, logged on failure, never retried - losing a generated-image
// capture is an acceptable tradeoff text capture never makes.
async function handleChatGptCaptureMediaMessage(message) {
  const media = message?.media;
  if (!media || typeof media !== 'object' || !media.media_type) {
    return { ok: false, error: 'Invalid media payload' };
  }
  const flags = await readChatGptCaptureFeatureFlags();
  if (!flags.enableCapture) {
    return { ok: true, uploaded: false, reason: 'capture_disabled' };
  }
  if (flags.captureMode === 'DRY_RUN') {
    return { ok: true, uploaded: false, reason: 'dry_run' };
  }
  try {
    const settings = await getSettings();
    const data = await postChatGptCaptureMedia(settings, media);
    // Threads the backend response (httpStatus, and data.data - the stored
    // ConversationMediaAsset dict, including id/enrichmentStatus) back to
    // the content script - previously fetched and silently discarded, which
    // is why stage 8 (Backend Response) of the media capture trace couldn't
    // be observed at all. Upload behavior/retries are unchanged.
    return { ok: true, uploaded: true, data };
  } catch (error) {
    if (flags.effectiveDebug) {
      console.warn('[RMW ChatGPT Capture] media upload failed (not retried)', error?.message || error);
    }
    return { ok: false, error: error?.message || 'Media upload failed', httpStatus: error?.status || null };
  }
}

async function flushChatGptCaptureQueue() {
  const now = Date.now();
  const queue = await readChatGptCaptureQueue();
  if (!queue.length) return { attempted: 0, remaining: 0 };

  const readyItems = queue.filter((item) => Number(item.nextAttemptAt || 0) <= now);
  if (!readyItems.length) {
    const nextDueAt = queue.reduce((min, item) => Math.min(min, Number(item.nextAttemptAt || 0) || min), Number.POSITIVE_INFINITY);
    if (Number.isFinite(nextDueAt)) scheduleChatGptCaptureRetry(Math.max(5000, nextDueAt - now));
    return { attempted: 0, remaining: queue.length };
  }

  const batch = readyItems.slice(0, CHATGPT_CAPTURE_BATCH_MAX);
  const batchKeys = new Set(batch.map((item) => item.key));
  const flags = await readChatGptCaptureFeatureFlags();
  const startedAt = Date.now();

  if (flags.captureMode === 'DRY_RUN') {
    // Exercise capture + queueing against real ChatGPT traffic without ever
    // POSTing - no backend row is created, no session/API call happens.
    // Still removes the batch from the queue (as if uploaded) so DRY_RUN
    // testing doesn't just pile up an ever-growing local queue.
    chatGptCaptureTelemetry.totalDryRunDiscarded += batch.length;
    if (flags.effectiveDebug) {
      console.debug('[RMW ChatGPT Capture] DRY_RUN - discarding batch without upload', {
        batchSize: batch.length,
        totalDryRunDiscarded: chatGptCaptureTelemetry.totalDryRunDiscarded,
      });
    }
    const latestQueue = await readChatGptCaptureQueue();
    const remaining = latestQueue.filter((item) => !batchKeys.has(item.key));
    await writeChatGptCaptureQueue(remaining);
  } else {
    try {
      const settings = await getSettings();
      const response = await postChatGptCaptureEventsBatch(settings, batch.map((item) => ({
        ...item.event,
        session_id: item.event.session_id || settings.sessionToken || undefined,
      })));

      recordChatGptCaptureUploadDuration(Date.now() - startedAt);
      chatGptCaptureHealthState.lastSuccessfulUploadAt = Date.now();
      chatGptCaptureHealthState.offlineSince = 0;

      const statusCounts = (response.results || []).reduce((counts, result) => {
        counts[result.status] = (counts[result.status] || 0) + 1;
        return counts;
      }, {});
      chatGptCaptureTelemetry.totalCreated += statusCounts.created || 0;
      chatGptCaptureTelemetry.totalDuplicate += statusCounts.duplicate || 0;
      chatGptCaptureTelemetry.totalRejected += statusCounts.rejected || 0;

      // Sanitized observability only - counts and status, never event
      // payload content (the actual conversation text never reaches console.*).
      if (flags.effectiveDebug) {
        console.debug('[RMW ChatGPT Capture] flush ok', {
          batchSize: batch.length,
          durationMs: Date.now() - startedAt,
          results: statusCounts,
          totals: { ...chatGptCaptureTelemetry },
        });
      }

      const resultByKey = new Map((response.results || []).map((result) => [result.client_event_id, result]));
      const latestQueue = await readChatGptCaptureQueue();
      const remaining = latestQueue.filter((item) => {
        if (!batchKeys.has(item.key)) return true;
        const result = resultByKey.get(item.key);
        // created/duplicate/rejected are all definitive backend responses -
        // none of them are retried. Only a whole-batch transport failure
        // (network error, 5xx) below is retryable.
        return !result;
      });
      await writeChatGptCaptureQueue(remaining);
    } catch (error) {
      recordChatGptCaptureUploadDuration(Date.now() - startedAt);
      chatGptCaptureHealthState.lastFailedUploadAt = Date.now();
      if (!chatGptCaptureHealthState.offlineSince) chatGptCaptureHealthState.offlineSince = Date.now();
      chatGptCaptureTelemetry.totalUploadFailures += 1;

      const latestQueue = await readChatGptCaptureQueue();
      const errorMessage = `${error?.message || error || 'ChatGPT capture upload failed'}`.slice(0, 500);
      if (flags.effectiveDebug) {
        console.warn('[RMW ChatGPT Capture] flush failed - will retry (lossless)', {
          batchSize: batch.length,
          reason: errorMessage,
          status: error?.status,
          totalUploadFailures: chatGptCaptureTelemetry.totalUploadFailures,
        });
      }
      const updated = latestQueue.map((item) => {
        if (!batchKeys.has(item.key)) return item;
        const attempts = Number(item.attempts || 0) + 1;
        return {
          ...item,
          attempts,
          lastError: errorMessage,
          // LOSSLESS: no max-attempts cutoff - once getChatGptCaptureRetryDelayMs
          // caps out at 30 minutes it just keeps retrying at that cadence
          // forever, per EXTENSION_CAPTURE_DESIGN.md "Queue behavior under
          // connectivity loss".
          nextAttemptAt: now + getChatGptCaptureRetryDelayMs(attempts),
        };
      });
      await writeChatGptCaptureQueue(updated);
    }
  }

  // Local-only, independent of enableHealth (that flag only controls the
  // network ping) - a pure chrome.storage.local write with no upload.
  mergeCaptureVersionDistribution().catch(() => {});
  maybeReportChatGptCaptureHealth().catch(() => {});

  const finalQueue = await readChatGptCaptureQueue();
  const stillReady = finalQueue.some((item) => Number(item.nextAttemptAt || 0) <= Date.now());
  if (stillReady) {
    // More ready work than one batch could hold - keep draining without
    // waiting for the debounce window again.
    return runChatGptCaptureFlush();
  }
  const nextDueAt = finalQueue.reduce((min, item) => Math.min(min, Number(item.nextAttemptAt || 0) || min), Number.POSITIVE_INFINITY);
  if (Number.isFinite(nextDueAt)) {
    scheduleChatGptCaptureRetry(Math.max(5000, nextDueAt - Date.now()));
  }
  return { attempted: batch.length, remaining: finalQueue.length };
}

async function maybeReportChatGptCaptureHealth(force = false) {
  const now = Date.now();
  if (!force && now - chatGptCaptureHealthState.lastPingAt < CHATGPT_CAPTURE_HEALTH_MIN_INTERVAL_MS) return;

  const flags = await readChatGptCaptureFeatureFlags();
  if (!flags.enableCapture || !flags.enableHealth) return;

  chatGptCaptureHealthState.lastPingAt = now;

  try {
    const [settings, queue, extensionSessionId] = await Promise.all([
      getSettings(),
      readChatGptCaptureQueue(),
      getChatGptCaptureExtensionSessionId(),
    ]);

    const oldestPendingEventAt = queue.length
      ? Math.min(...queue.map((item) => Number(item.enqueuedAt || now)))
      : 0;

    const headers = { 'Content-Type': 'application/json' };
    if (settings.sessionToken) headers['X-Session-Id'] = settings.sessionToken;

    await fetch(`${settings.apiBase}/api/providers/chatgpt/capture/health`, {
      method: 'POST',
      credentials: 'include',
      headers,
      body: JSON.stringify({
        extension_session_id: extensionSessionId,
        extension_version: chrome.runtime.getManifest().version,
        queue_length: queue.length,
        events_waiting: queue.filter((item) => Number(item.nextAttemptAt || 0) <= now).length,
        oldest_pending_event_at: oldestPendingEventAt ? new Date(oldestPendingEventAt).toISOString() : undefined,
        retry_count: queue.reduce((sum, item) => sum + Number(item.attempts || 0), 0),
        last_capture_event_at: chatGptCaptureHealthState.lastCaptureEventAt
          ? new Date(chatGptCaptureHealthState.lastCaptureEventAt).toISOString() : undefined,
        last_successful_upload_at: chatGptCaptureHealthState.lastSuccessfulUploadAt
          ? new Date(chatGptCaptureHealthState.lastSuccessfulUploadAt).toISOString() : undefined,
        last_failed_upload_at: chatGptCaptureHealthState.lastFailedUploadAt
          ? new Date(chatGptCaptureHealthState.lastFailedUploadAt).toISOString() : undefined,
        average_upload_time_ms: computeChatGptCaptureAverageUploadTimeMs(),
        offline_since: chatGptCaptureHealthState.offlineSince
          ? new Date(chatGptCaptureHealthState.offlineSince).toISOString() : undefined,
      }),
    });
  } catch {
    // Health reporting is itself best-effort/non-critical - never queued or
    // retried, unlike the capture events themselves.
  }
}

async function handleChatGptCaptureEventMessage(message) {
  const event = message?.event;
  if (!event || typeof event !== 'object' || !event.event_type || !event.client_event_id) {
    return { ok: false, error: 'Invalid capture event payload' };
  }
  // Second gate (defense-in-depth) behind the same flag content-chatgpt.js's
  // orchestrator already checks before it even subscribes - a stale flag
  // cached in a long-lived tab shouldn't be the only thing standing between
  // "capture disabled" and data still reaching the backend. Deliberately
  // does NOT gate flushChatGptCaptureQueue()/runChatGptCaptureFlush() -
  // events already queued before the flag flipped off still drain normally;
  // this only stops *new* events from being accepted.
  const flags = await readChatGptCaptureFeatureFlags();
  if (!flags.enableCapture) {
    return { ok: true, queued: false, reason: 'capture_disabled' };
  }
  await enqueueChatGptCaptureEvent(event);
  return { ok: true, queued: true };
}
