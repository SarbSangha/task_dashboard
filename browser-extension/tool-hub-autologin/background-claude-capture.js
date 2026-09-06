// background-claude-capture.js — loaded via importScripts() from
// background.js, before background-main.js (see manifest ordering there).
//
// Owns the Claude raw-capture outbox: one shared queue for the whole
// browser, persisted to chrome.storage.local, batched per
// backend/providers/claude/constants.py's RELIABILITY_CLASS (LOSSLESS).
// This is a straight structural copy of background-chatgpt-capture.js's
// queue/retry/health machinery (same backoff formula, same chrome.alarms
// wake-up pattern, same MV3-service-worker-suspend reasoning - see that
// file's own comments for the full "why" on each piece), trimmed to just
// the two endpoints this provider implements (/capture/events,
// /capture/health) - no attachment/media binary-upload handlers, Claude
// capture doesn't upload binaries in this pass.
//
// getSettings() and buildApiErrorMessage() are defined in background-main.js
// and reused here as-is (same classic service-worker global scope via
// importScripts).

const CLAUDE_CAPTURE_QUEUE_STORAGE_KEY = 'pendingClaudeCaptureEvents';
const CLAUDE_CAPTURE_SESSION_ID_STORAGE_KEY = 'claudeCaptureExtensionSessionId';
const CLAUDE_CAPTURE_RETRY_ALARM = 'retryPendingClaudeCaptureEvents';
const CLAUDE_CAPTURE_HEALTH_ALARM = 'reportClaudeCaptureHealth';
const CLAUDE_CAPTURE_BATCH_MAX = 200;
const CLAUDE_CAPTURE_FLUSH_QUIET_MS = 500;
const CLAUDE_CAPTURE_FLUSH_MAX_WAIT_MS = 2000;
const CLAUDE_CAPTURE_FLUSH_EVENT_THRESHOLD = 50;
// See background-chatgpt-capture.js's identical constant for why this
// exists (a safety valve, not a normal operating ceiling) and why
// manifest.json's "unlimitedStorage" permission matters here.
const CLAUDE_CAPTURE_QUEUE_HARD_LIMIT = 5000;
const CLAUDE_CAPTURE_HEALTH_MIN_INTERVAL_MS = 5 * 60 * 1000;

// Duplicated (not imported) from content-claude-capture.js on purpose - see
// background-chatgpt-capture.js's identical comment on its own copy.
const CLAUDE_CAPTURE_FLAGS_STORAGE_KEY = 'claudeCaptureFeatureFlags';
const DEFAULT_CLAUDE_CAPTURE_FLAGS = { enableCapture: true, enableHealth: true, enableDebug: false };

async function readClaudeCaptureFeatureFlags() {
  try {
    const stored = await chrome.storage.local.get([CLAUDE_CAPTURE_FLAGS_STORAGE_KEY]);
    return { ...DEFAULT_CLAUDE_CAPTURE_FLAGS, ...(stored[CLAUDE_CAPTURE_FLAGS_STORAGE_KEY] || {}) };
  } catch {
    return { ...DEFAULT_CLAUDE_CAPTURE_FLAGS };
  }
}

const claudeCaptureHealthState = {
  lastCaptureEventAt: 0,
  lastSuccessfulUploadAt: 0,
  lastFailedUploadAt: 0,
  offlineSince: 0,
  lastPingAt: 0,
  uploadDurationsMs: [],
};

const claudeCaptureTelemetry = {
  totalEnqueued: 0,
  totalCreated: 0,
  totalDuplicate: 0,
  totalRejected: 0,
  totalUploadFailures: 0,
  totalDroppedForCeiling: 0,
};

let claudeCaptureQuietTimer = null;
let claudeCaptureMaxWaitTimer = null;
let claudeCaptureFlushInFlight = null;

function getClaudeCaptureRetryDelayMs(attempts) {
  const baseMs = 30 * 1000;
  const exponent = Math.max(0, Math.min(Number(attempts || 0), 6));
  return Math.min(baseMs * (2 ** exponent), 30 * 60 * 1000);
}

async function getClaudeCaptureExtensionSessionId() {
  const stored = await chrome.storage.local.get([CLAUDE_CAPTURE_SESSION_ID_STORAGE_KEY]);
  const existing = `${stored[CLAUDE_CAPTURE_SESSION_ID_STORAGE_KEY] || ''}`.trim();
  if (existing) return existing;
  const generated = (typeof crypto?.randomUUID === 'function')
    ? crypto.randomUUID()
    : `sess_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  await chrome.storage.local.set({ [CLAUDE_CAPTURE_SESSION_ID_STORAGE_KEY]: generated });
  return generated;
}

async function readClaudeCaptureQueue() {
  const stored = await chrome.storage.local.get([CLAUDE_CAPTURE_QUEUE_STORAGE_KEY]);
  const queue = stored[CLAUDE_CAPTURE_QUEUE_STORAGE_KEY];
  return Array.isArray(queue) ? queue.filter((item) => item && typeof item === 'object') : [];
}

async function writeClaudeCaptureQueue(queue) {
  if (queue.length > CLAUDE_CAPTURE_QUEUE_HARD_LIMIT) {
    const overflow = queue.length - CLAUDE_CAPTURE_QUEUE_HARD_LIMIT;
    claudeCaptureTelemetry.totalDroppedForCeiling += overflow;
    console.error(
      '[RMW Claude Capture] Queue exceeded hard ceiling - dropping oldest events to protect chrome.storage.local',
      { overflow, ceiling: CLAUDE_CAPTURE_QUEUE_HARD_LIMIT, totalDroppedForCeiling: claudeCaptureTelemetry.totalDroppedForCeiling }
    );
    queue = queue.slice(overflow);
  }
  await chrome.storage.local.set({ [CLAUDE_CAPTURE_QUEUE_STORAGE_KEY]: queue });
  return queue;
}

// Every mutation of the persisted queue is a read-modify-write with an
// `await` in the middle, and chrome.storage.local offers no compare-and-swap:
// two of them running concurrently both read the same array, each pushes its
// own event onto its own copy, and the second write silently erases the
// first.
//
// This was not theoretical. content-claude-capture.js processes one snapshot
// by sending every event it produced in a single synchronous burst -
// conversation_created, then prompt_captured, then response_completed - so
// all three enqueues ran concurrently and only the LAST of them survived.
// That is exactly what the database showed: for every Claude conversation
// captured since this queue shipped, the assistant's response was stored
// while the user's own prompt (and the conversation_created event ahead of
// it) was silently gone, leaving conversations with promptCount 0 and no
// prompt row for their attachments to hang off.
//
// Serializing the mutations - not the whole flush, whose network upload must
// not block incoming events - is enough to fix it.
let claudeCaptureQueueLock = Promise.resolve();

function withClaudeCaptureQueueLock(task) {
  const run = claudeCaptureQueueLock.then(() => task());
  // The chain must survive a failing task, or one rejection would deadlock
  // every later queue mutation for the life of the service worker.
  claudeCaptureQueueLock = run.then(() => undefined, () => undefined);
  return run;
}

function scheduleClaudeCaptureRetry(delayMs = 60 * 1000) {
  try {
    if (chrome?.alarms?.create) {
      chrome.alarms.create(CLAUDE_CAPTURE_RETRY_ALARM, { when: Date.now() + Math.max(5000, delayMs) });
      return;
    }
  } catch {}
  setTimeout(() => flushClaudeCaptureQueue().catch(() => {}), Math.max(5000, delayMs));
}

function clearClaudeCaptureFlushTimers() {
  if (claudeCaptureQuietTimer) { clearTimeout(claudeCaptureQuietTimer); claudeCaptureQuietTimer = null; }
  if (claudeCaptureMaxWaitTimer) { clearTimeout(claudeCaptureMaxWaitTimer); claudeCaptureMaxWaitTimer = null; }
}

function scheduleClaudeCaptureFlush() {
  if (claudeCaptureQuietTimer) clearTimeout(claudeCaptureQuietTimer);
  claudeCaptureQuietTimer = setTimeout(() => {
    claudeCaptureQuietTimer = null;
    runClaudeCaptureFlush();
  }, CLAUDE_CAPTURE_FLUSH_QUIET_MS);

  if (!claudeCaptureMaxWaitTimer) {
    claudeCaptureMaxWaitTimer = setTimeout(() => {
      claudeCaptureMaxWaitTimer = null;
      runClaudeCaptureFlush();
    }, CLAUDE_CAPTURE_FLUSH_MAX_WAIT_MS);
  }
}

function runClaudeCaptureFlush() {
  clearClaudeCaptureFlushTimers();
  claudeCaptureFlushInFlight = flushClaudeCaptureQueue()
    .catch((error) => {
      console.error('[RMW Claude Capture] Flush failed unexpectedly', error);
    })
    .finally(() => {
      claudeCaptureFlushInFlight = null;
    });
  return claudeCaptureFlushInFlight;
}

// See background-chatgpt-capture.js's identical function for the full
// MV3-service-worker-suspend reasoning this backstop exists for.
function armClaudeCaptureFlushBackstop() {
  try {
    if (chrome?.alarms?.create) {
      chrome.alarms.create(CLAUDE_CAPTURE_RETRY_ALARM, { delayInMinutes: 1 });
    }
  } catch {}
}

async function enqueueClaudeCaptureEvent(event) {
  const now = Date.now();
  const queue = await withClaudeCaptureQueueLock(async () => {
    const current = await readClaudeCaptureQueue();
    current.push({
      key: event.client_event_id,
      event,
      enqueuedAt: now,
      attempts: 0,
      lastError: '',
      nextAttemptAt: 0,
    });
    // writeClaudeCaptureQueue returns the queue it actually persisted (it can
    // trim for the hard ceiling), which is what the readyCount below must be
    // computed from.
    return writeClaudeCaptureQueue(current);
  });

  claudeCaptureHealthState.lastCaptureEventAt = now;
  claudeCaptureTelemetry.totalEnqueued += 1;

  armClaudeCaptureFlushBackstop();

  // See background-chatgpt-capture.js's identical incognito-instance
  // comment for why this can't just always debounce.
  const isIncognitoInstance = Boolean(chrome.extension?.inIncognitoContext);
  const readyCount = queue.filter((item) => Number(item.nextAttemptAt || 0) <= now).length;
  if (isIncognitoInstance || readyCount >= CLAUDE_CAPTURE_FLUSH_EVENT_THRESHOLD) {
    runClaudeCaptureFlush();
  } else {
    scheduleClaudeCaptureFlush();
  }
}

function recordClaudeCaptureUploadDuration(durationMs) {
  const durations = claudeCaptureHealthState.uploadDurationsMs;
  durations.push(durationMs);
  if (durations.length > 20) durations.shift();
}

function computeClaudeCaptureAverageUploadTimeMs() {
  const durations = claudeCaptureHealthState.uploadDurationsMs;
  if (!durations.length) return undefined;
  const total = durations.reduce((sum, value) => sum + value, 0);
  return Math.round(total / durations.length);
}

async function postClaudeCaptureEventsBatch(settings, events) {
  const headers = { 'Content-Type': 'application/json' };
  if (settings.sessionToken) headers['X-Session-Id'] = settings.sessionToken;

  const response = await fetch(`${settings.apiBase}/api/providers/claude/capture/events`, {
    method: 'POST',
    credentials: 'include',
    headers,
    body: JSON.stringify({ events }),
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.success) {
    const error = new Error(buildApiErrorMessage(data, response, 'Claude capture upload failed', settings));
    error.status = response.status;
    throw error;
  }
  return data;
}

async function flushClaudeCaptureQueue() {
  const now = Date.now();
  const queue = await readClaudeCaptureQueue();
  if (!queue.length) return { attempted: 0, remaining: 0 };

  const readyItems = queue.filter((item) => Number(item.nextAttemptAt || 0) <= now);
  if (!readyItems.length) {
    const nextDueAt = queue.reduce((min, item) => Math.min(min, Number(item.nextAttemptAt || 0) || min), Number.POSITIVE_INFINITY);
    if (Number.isFinite(nextDueAt)) scheduleClaudeCaptureRetry(Math.max(5000, nextDueAt - now));
    return { attempted: 0, remaining: queue.length };
  }

  const batch = readyItems.slice(0, CLAUDE_CAPTURE_BATCH_MAX);
  const batchKeys = new Set(batch.map((item) => item.key));
  const flags = await readClaudeCaptureFeatureFlags();
  const startedAt = Date.now();

  try {
    const settings = await getSettings();
    const response = await postClaudeCaptureEventsBatch(settings, batch.map((item) => ({
      ...item.event,
      session_id: item.event.session_id || settings.sessionToken || undefined,
    })));

    recordClaudeCaptureUploadDuration(Date.now() - startedAt);
    claudeCaptureHealthState.lastSuccessfulUploadAt = Date.now();
    claudeCaptureHealthState.offlineSince = 0;

    const statusCounts = (response.results || []).reduce((counts, result) => {
      counts[result.status] = (counts[result.status] || 0) + 1;
      return counts;
    }, {});
    claudeCaptureTelemetry.totalCreated += statusCounts.created || 0;
    claudeCaptureTelemetry.totalDuplicate += statusCounts.duplicate || 0;
    claudeCaptureTelemetry.totalRejected += statusCounts.rejected || 0;

    if (flags.enableDebug) {
      console.debug('[RMW Claude Capture] flush ok', {
        batchSize: batch.length,
        durationMs: Date.now() - startedAt,
        results: statusCounts,
        totals: { ...claudeCaptureTelemetry },
      });
    }

    const resultByKey = new Map((response.results || []).map((result) => [result.client_event_id, result]));
    await withClaudeCaptureQueueLock(async () => {
      const latestQueue = await readClaudeCaptureQueue();
      const remaining = latestQueue.filter((item) => {
        if (!batchKeys.has(item.key)) return true;
        const result = resultByKey.get(item.key);
        return !result;
      });
      await writeClaudeCaptureQueue(remaining);
    });
  } catch (error) {
    recordClaudeCaptureUploadDuration(Date.now() - startedAt);
    claudeCaptureHealthState.lastFailedUploadAt = Date.now();
    if (!claudeCaptureHealthState.offlineSince) claudeCaptureHealthState.offlineSince = Date.now();
    claudeCaptureTelemetry.totalUploadFailures += 1;

    const errorMessage = `${error?.message || error || 'Claude capture upload failed'}`.slice(0, 500);
    if (flags.enableDebug) {
      console.warn('[RMW Claude Capture] flush failed - will retry (lossless)', {
        batchSize: batch.length,
        reason: errorMessage,
        status: error?.status,
        totalUploadFailures: claudeCaptureTelemetry.totalUploadFailures,
      });
    }
    await withClaudeCaptureQueueLock(async () => {
      const latestQueue = await readClaudeCaptureQueue();
      const updated = latestQueue.map((item) => {
        if (!batchKeys.has(item.key)) return item;
        const attempts = Number(item.attempts || 0) + 1;
        return {
          ...item,
          attempts,
          lastError: errorMessage,
          // LOSSLESS: no max-attempts cutoff, same as ChatGPT's queue.
          nextAttemptAt: now + getClaudeCaptureRetryDelayMs(attempts),
        };
      });
      await writeClaudeCaptureQueue(updated);
    });
  }

  maybeReportClaudeCaptureHealth().catch(() => {});

  const finalQueue = await readClaudeCaptureQueue();
  const stillReady = finalQueue.some((item) => Number(item.nextAttemptAt || 0) <= Date.now());
  if (stillReady) {
    return runClaudeCaptureFlush();
  }
  const nextDueAt = finalQueue.reduce((min, item) => Math.min(min, Number(item.nextAttemptAt || 0) || min), Number.POSITIVE_INFINITY);
  if (Number.isFinite(nextDueAt)) {
    scheduleClaudeCaptureRetry(Math.max(5000, nextDueAt - Date.now()));
  }
  return { attempted: batch.length, remaining: finalQueue.length };
}

async function maybeReportClaudeCaptureHealth(force = false) {
  const now = Date.now();
  if (!force && now - claudeCaptureHealthState.lastPingAt < CLAUDE_CAPTURE_HEALTH_MIN_INTERVAL_MS) return;

  const flags = await readClaudeCaptureFeatureFlags();
  if (!flags.enableCapture || !flags.enableHealth) return;

  claudeCaptureHealthState.lastPingAt = now;

  try {
    const [settings, queue, extensionSessionId] = await Promise.all([
      getSettings(),
      readClaudeCaptureQueue(),
      getClaudeCaptureExtensionSessionId(),
    ]);

    const oldestPendingEventAt = queue.length
      ? Math.min(...queue.map((item) => Number(item.enqueuedAt || now)))
      : 0;

    const headers = { 'Content-Type': 'application/json' };
    if (settings.sessionToken) headers['X-Session-Id'] = settings.sessionToken;

    await fetch(`${settings.apiBase}/api/providers/claude/capture/health`, {
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
        last_capture_event_at: claudeCaptureHealthState.lastCaptureEventAt
          ? new Date(claudeCaptureHealthState.lastCaptureEventAt).toISOString() : undefined,
        last_successful_upload_at: claudeCaptureHealthState.lastSuccessfulUploadAt
          ? new Date(claudeCaptureHealthState.lastSuccessfulUploadAt).toISOString() : undefined,
        last_failed_upload_at: claudeCaptureHealthState.lastFailedUploadAt
          ? new Date(claudeCaptureHealthState.lastFailedUploadAt).toISOString() : undefined,
        average_upload_time_ms: computeClaudeCaptureAverageUploadTimeMs(),
        offline_since: claudeCaptureHealthState.offlineSince
          ? new Date(claudeCaptureHealthState.offlineSince).toISOString() : undefined,
      }),
    });
  } catch {
    // Health reporting is itself best-effort/non-critical - never queued or
    // retried, unlike the capture events themselves.
  }
}

async function handleClaudeCaptureEventMessage(message) {
  const event = message?.event;
  if (!event || typeof event !== 'object' || !event.event_type || !event.client_event_id) {
    return { ok: false, error: 'Invalid capture event payload' };
  }
  const flags = await readClaudeCaptureFeatureFlags();
  if (!flags.enableCapture) {
    return { ok: true, queued: false, reason: 'capture_disabled' };
  }
  await enqueueClaudeCaptureEvent(event);
  return { ok: true, queued: true };
}

async function postClaudeCaptureAttachment(settings, attachment) {
  const headers = { 'Content-Type': 'application/json' };
  if (settings.sessionToken) headers['X-Session-Id'] = settings.sessionToken;

  const response = await fetch(`${settings.apiBase}/api/providers/claude/capture/attachments`, {
    method: 'POST',
    credentials: 'include',
    headers,
    body: JSON.stringify(attachment),
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.success) {
    const error = new Error(buildApiErrorMessage(data, response, 'Claude attachment upload failed', settings));
    error.status = response.status;
    throw error;
  }
  return data;
}

// Best-effort, not lossless - see providers/claude/attachments.py's own
// docstring and content-claude-capture.js's captureFileAttachments: a large
// data: URL doesn't belong in the same persisted retry queue as tiny JSON
// capture events. One attempt, logged on failure, never retried - losing an
// attachment preview is an acceptable tradeoff the core prompt/response
// text capture never makes.
async function handleClaudeCaptureAttachmentMessage(message) {
  const attachment = message?.attachment;
  if (!attachment || typeof attachment !== 'object' || !attachment.data_url || !attachment.file_name) {
    return { ok: false, error: 'Invalid attachment payload' };
  }
  const flags = await readClaudeCaptureFeatureFlags();
  if (!flags.enableCapture) {
    return { ok: true, uploaded: false, reason: 'capture_disabled' };
  }
  try {
    const settings = await getSettings();
    await postClaudeCaptureAttachment(settings, attachment);
    return { ok: true, uploaded: true };
  } catch (error) {
    if (flags.enableDebug) {
      console.warn('[RMW Claude Capture] attachment upload failed (not retried)', error?.message || error);
    }
    return { ok: false, error: error?.message || 'Attachment upload failed' };
  }
}
