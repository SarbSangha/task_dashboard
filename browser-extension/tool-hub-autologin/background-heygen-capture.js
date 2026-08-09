// background-heygen-capture.js — loaded via importScripts() from
// background.js, before background-main.js (see manifest ordering there).
//
// Owns the HeyGen raw-capture outbox: one shared queue for the whole
// browser, persisted to chrome.storage.local so a crash or extension reload
// never loses a queued event before it's flushed. Mirrors
// background-freepik-capture.js (this file's template) near-verbatim,
// including its BEST_EFFORT posture (see providers/heygen/constants.py
// RELIABILITY_CLASS) - there is no webhook/server push for HeyGen, so an
// event that still can't upload after HEYGEN_CAPTURE_RETRY_MAX_ATTEMPTS is
// dropped rather than retried forever. Unlike Freepik, there is currently no
// reconciliation walker backstopping a dropped event (see
// providers/heygen/sync.py's docstring) - this is an explicit, documented
// limitation of this pass, not an oversight.
//
// getSettings(), buildApiErrorMessage(), and getActiveLaunch() are defined
// in background-main.js and reused here as-is (all three files run in the
// same classic service-worker global scope via importScripts).

const HEYGEN_CAPTURE_QUEUE_STORAGE_KEY = 'pendingHeygenCaptureEvents';
const HEYGEN_CAPTURE_SESSION_ID_STORAGE_KEY = 'heygenCaptureExtensionSessionId';
const HEYGEN_CAPTURE_RETRY_ALARM = 'retryPendingHeygenCaptureEvents';
const HEYGEN_CAPTURE_BATCH_MAX = 200;
const HEYGEN_CAPTURE_FLUSH_QUIET_MS = 500;
const HEYGEN_CAPTURE_FLUSH_MAX_WAIT_MS = 2000;
const HEYGEN_CAPTURE_FLUSH_EVENT_THRESHOLD = 50;
// BEST_EFFORT ceiling: after this many failed attempts on one event, it is
// dropped rather than retried forever - see this file's top comment.
const HEYGEN_CAPTURE_RETRY_MAX_ATTEMPTS = 12;
// Safety valve, not a normal operating ceiling - same reasoning as
// background-freepik-capture.js's FREEPIK_CAPTURE_QUEUE_HARD_LIMIT.
const HEYGEN_CAPTURE_QUEUE_HARD_LIMIT = 3000;
const HEYGEN_CAPTURE_HEALTH_MIN_INTERVAL_MS = 5 * 60 * 1000;

const heygenCaptureHealthState = {
  lastCaptureEventAt: 0,
  lastSuccessfulUploadAt: 0,
  lastFailedUploadAt: 0,
  offlineSince: 0,
  lastPingAt: 0,
  uploadDurationsMs: [],
};

const heygenCaptureTelemetry = {
  totalEnqueued: 0,
  totalCreated: 0,
  totalDuplicate: 0,
  totalRejected: 0,
  totalUploadFailures: 0,
  totalDroppedForRetryCeiling: 0,
  totalDroppedForQueueCeiling: 0,
};

let heygenCaptureQuietTimer = null;
let heygenCaptureMaxWaitTimer = null;
let heygenCaptureFlushInFlight = null;

function getHeygenCaptureRetryDelayMs(attempts) {
  const baseMs = 30 * 1000;
  const exponent = Math.max(0, Math.min(Number(attempts || 0), 6));
  return Math.min(baseMs * Math.pow(2, exponent), 30 * 60 * 1000);
}

async function getHeygenCaptureExtensionSessionId() {
  const stored = await chrome.storage.local.get([HEYGEN_CAPTURE_SESSION_ID_STORAGE_KEY]);
  const existing = `${stored[HEYGEN_CAPTURE_SESSION_ID_STORAGE_KEY] || ''}`.trim();
  if (existing) return existing;
  const generated = (typeof crypto?.randomUUID === 'function')
    ? crypto.randomUUID()
    : `sess_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  await chrome.storage.local.set({ [HEYGEN_CAPTURE_SESSION_ID_STORAGE_KEY]: generated });
  return generated;
}

// Serializes every read-modify-write cycle against the shared
// chrome.storage.local queue key - see background-freepik-capture.js's top
// comment for the exact near-simultaneous-completions race this prevents
// (multiple scenes rendering within milliseconds of each other is the HeyGen
// analog of Freepik's "auto" batch).
let heygenQueueChain = Promise.resolve();

function withHeygenQueueLock(criticalSection) {
  const result = heygenQueueChain.then(criticalSection, criticalSection);
  heygenQueueChain = result.then(() => {}, () => {});
  return result;
}

async function readHeygenCaptureQueue() {
  const stored = await chrome.storage.local.get([HEYGEN_CAPTURE_QUEUE_STORAGE_KEY]);
  const queue = stored[HEYGEN_CAPTURE_QUEUE_STORAGE_KEY];
  return Array.isArray(queue) ? queue.filter((item) => item && typeof item === 'object') : [];
}

async function writeHeygenCaptureQueue(queue) {
  if (queue.length > HEYGEN_CAPTURE_QUEUE_HARD_LIMIT) {
    const overflow = queue.length - HEYGEN_CAPTURE_QUEUE_HARD_LIMIT;
    heygenCaptureTelemetry.totalDroppedForQueueCeiling += overflow;
    console.error(
      '[RMW HeyGen Capture] Queue exceeded hard ceiling - dropping oldest events to protect chrome.storage.local',
      { overflow, ceiling: HEYGEN_CAPTURE_QUEUE_HARD_LIMIT }
    );
    queue = queue.slice(overflow);
  }
  await chrome.storage.local.set({ [HEYGEN_CAPTURE_QUEUE_STORAGE_KEY]: queue });
  return queue;
}

function scheduleHeygenCaptureRetry(delayMs = 60 * 1000) {
  try {
    if (chrome?.alarms?.create) {
      chrome.alarms.create(HEYGEN_CAPTURE_RETRY_ALARM, { when: Date.now() + Math.max(5000, delayMs) });
      return;
    }
  } catch {}
  setTimeout(() => flushHeygenCaptureQueue().catch(() => {}), Math.max(5000, delayMs));
}

function clearHeygenCaptureFlushTimers() {
  if (heygenCaptureQuietTimer) { clearTimeout(heygenCaptureQuietTimer); heygenCaptureQuietTimer = null; }
  if (heygenCaptureMaxWaitTimer) { clearTimeout(heygenCaptureMaxWaitTimer); heygenCaptureMaxWaitTimer = null; }
}

function scheduleHeygenCaptureFlush() {
  if (heygenCaptureQuietTimer) clearTimeout(heygenCaptureQuietTimer);
  heygenCaptureQuietTimer = setTimeout(() => {
    heygenCaptureQuietTimer = null;
    runHeygenCaptureFlush();
  }, HEYGEN_CAPTURE_FLUSH_QUIET_MS);

  if (!heygenCaptureMaxWaitTimer) {
    heygenCaptureMaxWaitTimer = setTimeout(() => {
      heygenCaptureMaxWaitTimer = null;
      runHeygenCaptureFlush();
    }, HEYGEN_CAPTURE_FLUSH_MAX_WAIT_MS);
  }
}

function runHeygenCaptureFlush() {
  clearHeygenCaptureFlushTimers();
  heygenCaptureFlushInFlight = flushHeygenCaptureQueue()
    .catch((error) => {
      console.error('[RMW HeyGen Capture] Flush failed unexpectedly', error);
    })
    .finally(() => {
      heygenCaptureFlushInFlight = null;
    });
  return heygenCaptureFlushInFlight;
}

async function enqueueHeygenCaptureEvent(event) {
  let shouldFlushNow = false;
  let shouldScheduleFlush = false;

  await withHeygenQueueLock(async () => {
    const now = Date.now();
    const queue = await readHeygenCaptureQueue();

    // A still-rendering generation generates the SAME client_event_id on
    // every poll until it settles (see content-heygen.js's heygenChangeToken
    // comment) - without this check, a slow render would pile up many
    // near-identical queue entries sharing one key before the first one even
    // gets a chance to flush. The server collapses them to 1 created + N
    // duplicates anyway, so this is pure local waste, not a correctness
    // issue - but worth avoiding, same as background-freepik-capture.js.
    const alreadyQueued = queue.some((item) => item.key === event.client_event_id);
    if (alreadyQueued) {
      heygenCaptureHealthState.lastCaptureEventAt = now;
      return;
    }

    queue.push({
      key: event.client_event_id,
      event,
      enqueuedAt: now,
      attempts: 0,
      lastError: '',
      nextAttemptAt: 0,
    });
    await writeHeygenCaptureQueue(queue);

    heygenCaptureHealthState.lastCaptureEventAt = now;
    heygenCaptureTelemetry.totalEnqueued += 1;

    const readyCount = queue.filter((item) => Number(item.nextAttemptAt || 0) <= now).length;
    if (readyCount >= HEYGEN_CAPTURE_FLUSH_EVENT_THRESHOLD) {
      shouldFlushNow = true;
    } else {
      shouldScheduleFlush = true;
    }
  });

  // Triggering the flush itself happens OUTSIDE the lock - see
  // background-freepik-capture.js's identical comment for why.
  if (shouldFlushNow) runHeygenCaptureFlush();
  else if (shouldScheduleFlush) scheduleHeygenCaptureFlush();
}

function recordHeygenCaptureUploadDuration(durationMs) {
  const durations = heygenCaptureHealthState.uploadDurationsMs;
  durations.push(durationMs);
  if (durations.length > 20) durations.shift();
}

function computeHeygenCaptureAverageUploadTimeMs() {
  const durations = heygenCaptureHealthState.uploadDurationsMs;
  if (!durations.length) return undefined;
  const total = durations.reduce((sum, value) => sum + value, 0);
  return Math.round(total / durations.length);
}

async function postHeygenCaptureEventsBatch(settings, events) {
  const headers = { 'Content-Type': 'application/json' };
  if (settings.sessionToken) headers['X-Session-Id'] = settings.sessionToken;

  const response = await fetch(`${settings.apiBase}/api/providers/heygen/capture/events`, {
    method: 'POST',
    credentials: 'include',
    headers,
    body: JSON.stringify({ events }),
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.success) {
    const error = new Error(buildApiErrorMessage(data, response, 'HeyGen capture upload failed', settings));
    error.status = response.status;
    throw error;
  }
  return data;
}

async function flushHeygenCaptureQueue() {
  const now = Date.now();
  const queue = await readHeygenCaptureQueue();
  if (!queue.length) return { attempted: 0, remaining: 0 };

  const readyItems = queue.filter((item) => Number(item.nextAttemptAt || 0) <= now);
  if (!readyItems.length) {
    const nextDueAt = queue.reduce((min, item) => Math.min(min, Number(item.nextAttemptAt || 0) || min), Number.POSITIVE_INFINITY);
    if (Number.isFinite(nextDueAt)) scheduleHeygenCaptureRetry(Math.max(5000, nextDueAt - now));
    return { attempted: 0, remaining: queue.length };
  }

  const batch = readyItems.slice(0, HEYGEN_CAPTURE_BATCH_MAX);
  const batchKeys = new Set(batch.map((item) => item.key));
  const startedAt = Date.now();

  // The network POST deliberately happens OUTSIDE withHeygenQueueLock - see
  // background-freepik-capture.js's identical comment for why.
  let uploadResponse = null;
  let uploadError = null;
  try {
    const settings = await getSettings();
    uploadResponse = await postHeygenCaptureEventsBatch(settings, batch.map((item) => ({
      ...item.event,
      session_id: item.event.session_id || settings.sessionToken || undefined,
    })));
  } catch (error) {
    uploadError = error;
  }

  await withHeygenQueueLock(async () => {
    if (uploadResponse) {
      recordHeygenCaptureUploadDuration(Date.now() - startedAt);
      heygenCaptureHealthState.lastSuccessfulUploadAt = Date.now();
      heygenCaptureHealthState.offlineSince = 0;

      const statusCounts = (uploadResponse.results || []).reduce((counts, result) => {
        counts[result.status] = (counts[result.status] || 0) + 1;
        return counts;
      }, {});
      heygenCaptureTelemetry.totalCreated += statusCounts.created || 0;
      heygenCaptureTelemetry.totalDuplicate += statusCounts.duplicate || 0;
      heygenCaptureTelemetry.totalRejected += statusCounts.rejected || 0;

      const resultByKey = new Map((uploadResponse.results || []).map((result) => [result.client_event_id, result]));
      // Re-read INSIDE the lock, not reused from the outer scope - see
      // background-freepik-capture.js's identical comment for why.
      const latestQueue = await readHeygenCaptureQueue();
      const remaining = latestQueue.filter((item) => {
        if (!batchKeys.has(item.key)) return true;
        const result = resultByKey.get(item.key);
        return !result;
      });
      await writeHeygenCaptureQueue(remaining);
    } else {
      recordHeygenCaptureUploadDuration(Date.now() - startedAt);
      heygenCaptureHealthState.lastFailedUploadAt = Date.now();
      if (!heygenCaptureHealthState.offlineSince) heygenCaptureHealthState.offlineSince = Date.now();
      heygenCaptureTelemetry.totalUploadFailures += 1;

      const latestQueue = await readHeygenCaptureQueue();
      const errorMessage = `${uploadError?.message || uploadError || 'HeyGen capture upload failed'}`.slice(0, 500);
      const updated = [];
      for (const item of latestQueue) {
        if (!batchKeys.has(item.key)) {
          updated.push(item);
          continue;
        }
        const attempts = Number(item.attempts || 0) + 1;
        if (attempts > HEYGEN_CAPTURE_RETRY_MAX_ATTEMPTS) {
          // BEST_EFFORT ceiling reached - drop, don't retry forever (see this
          // file's top comment).
          heygenCaptureTelemetry.totalDroppedForRetryCeiling += 1;
          continue;
        }
        updated.push({
          ...item,
          attempts,
          lastError: errorMessage,
          nextAttemptAt: now + getHeygenCaptureRetryDelayMs(attempts),
        });
      }
      await writeHeygenCaptureQueue(updated);
    }
  });

  maybeReportHeygenCaptureHealth().catch(() => {});

  const finalQueue = await readHeygenCaptureQueue();
  const stillReady = finalQueue.some((item) => Number(item.nextAttemptAt || 0) <= Date.now());
  if (stillReady) {
    return runHeygenCaptureFlush();
  }
  const nextDueAt = finalQueue.reduce((min, item) => Math.min(min, Number(item.nextAttemptAt || 0) || min), Number.POSITIVE_INFINITY);
  if (Number.isFinite(nextDueAt)) {
    scheduleHeygenCaptureRetry(Math.max(5000, nextDueAt - Date.now()));
  }
  return { attempted: batch.length, remaining: finalQueue.length };
}

async function maybeReportHeygenCaptureHealth(force = false) {
  const now = Date.now();
  if (!force && now - heygenCaptureHealthState.lastPingAt < HEYGEN_CAPTURE_HEALTH_MIN_INTERVAL_MS) return;
  heygenCaptureHealthState.lastPingAt = now;

  try {
    const [settings, queue, extensionSessionId] = await Promise.all([
      getSettings(),
      readHeygenCaptureQueue(),
      getHeygenCaptureExtensionSessionId(),
    ]);

    const oldestPendingEventAt = queue.length
      ? Math.min(...queue.map((item) => Number(item.enqueuedAt || now)))
      : 0;

    const headers = { 'Content-Type': 'application/json' };
    if (settings.sessionToken) headers['X-Session-Id'] = settings.sessionToken;

    await fetch(`${settings.apiBase}/api/providers/heygen/capture/health`, {
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
        last_capture_event_at: heygenCaptureHealthState.lastCaptureEventAt
          ? new Date(heygenCaptureHealthState.lastCaptureEventAt).toISOString() : undefined,
        last_successful_upload_at: heygenCaptureHealthState.lastSuccessfulUploadAt
          ? new Date(heygenCaptureHealthState.lastSuccessfulUploadAt).toISOString() : undefined,
        last_failed_upload_at: heygenCaptureHealthState.lastFailedUploadAt
          ? new Date(heygenCaptureHealthState.lastFailedUploadAt).toISOString() : undefined,
        average_upload_time_ms: computeHeygenCaptureAverageUploadTimeMs(),
        offline_since: heygenCaptureHealthState.offlineSince
          ? new Date(heygenCaptureHealthState.offlineSince).toISOString() : undefined,
      }),
    });
  } catch {
    // Health reporting is itself best-effort/non-critical - never queued or retried.
  }
}

async function handleHeygenCaptureEventMessage(message, senderTabId = 0, openerTabId = 0) {
  const event = message?.event;
  if (!event || typeof event !== 'object' || !event.event_type || !event.client_event_id) {
    return { ok: false, error: 'Invalid capture event payload' };
  }

  // Ticket attachment happens here (enqueue time), not at flush time - by
  // the time a batch actually uploads (possibly minutes later, after
  // retries), the originating tab may be closed and its launch record gone.
  // Mirrors handleFreepikCaptureEventMessage's exact resolution order.
  const tabId = message.tabId || senderTabId || 0;
  const directLaunch = await getActiveLaunch(tabId, 'heygen');
  const inheritedLaunch = directLaunch?.ticket ? null : await getActiveLaunch(openerTabId, 'heygen');
  const activeLaunch = directLaunch || inheritedLaunch;

  const enrichedEvent = {
    ...event,
    extension_ticket: event.extension_ticket || activeLaunch?.ticket || undefined,
    usage_ticket: event.usage_ticket || activeLaunch?.usageTrackingTicket || undefined,
    tab_id: tabId || undefined,
  };

  await enqueueHeygenCaptureEvent(enrichedEvent);
  return { ok: true, queued: true };
}

// Not currently called by content-heygen.js (no reconciliation walker exists
// yet in this pass - see providers/heygen/sync.py's docstring) but kept
// fully wired, mirroring handleFreepikSyncProgressMessage, so a future walker
// only needs to start sending this message type.
async function handleHeygenSyncProgressMessage(message, senderTabId = 0, openerTabId = 0) {
  const directLaunch = await getActiveLaunch(senderTabId, 'heygen');
  const inheritedLaunch = directLaunch?.ticket ? null : await getActiveLaunch(openerTabId, 'heygen');
  const activeLaunch = directLaunch || inheritedLaunch;

  try {
    const settings = await getSettings();
    const headers = { 'Content-Type': 'application/json' };
    if (settings.sessionToken) headers['X-Session-Id'] = settings.sessionToken;
    await fetch(`${settings.apiBase}/api/providers/heygen/sync/cursor`, {
      method: 'POST',
      credentials: 'include',
      headers,
      body: JSON.stringify({
        last_seen_video_id: message.lastSeenVideoId || null,
        last_synced_page: Number(message.lastSyncedPage || 0),
        is_full_reconciliation: Boolean(message.isFullReconciliation),
        status: message.status || 'idle',
        extension_ticket: activeLaunch?.ticket || undefined,
        usage_ticket: activeLaunch?.usageTrackingTicket || undefined,
      }),
    });
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error?.message || 'HeyGen sync progress report failed' };
  }
}

// Task Mapping: populates content-heygen-task-modal.js's picker. Called from
// heygen.com (a different origin than our dashboard), so identity is the
// same launch ticket every other HeyGen endpoint here uses - never a
// dashboard session cookie. Not queued/retried (unlike capture events): the
// generation is actively blocked waiting on this, so a failure must surface
// to the modal immediately as a "Retry" state, not silently retry later.
async function handleHeygenFetchMyActiveTasksMessage(message, senderTabId = 0, openerTabId = 0) {
  const tabId = message?.tabId || senderTabId || 0;
  const directLaunch = await getActiveLaunch(tabId, 'heygen');
  const inheritedLaunch = directLaunch?.ticket ? null : await getActiveLaunch(openerTabId, 'heygen');
  const activeLaunch = directLaunch || inheritedLaunch;

  if (!activeLaunch?.ticket && !activeLaunch?.usageTrackingTicket) {
    return { ok: false, error: 'Launch HeyGen from the dashboard before task selection can run.', reason: 'session_expired' };
  }

  try {
    const settings = await getSettings();
    const params = new URLSearchParams();
    if (activeLaunch.usageTrackingTicket) params.set('usage_ticket', activeLaunch.usageTrackingTicket);
    if (activeLaunch.ticket) params.set('extension_ticket', activeLaunch.ticket);
    // Tells the backend to validate the ticket against the HeyGen tool row
    // instead of defaulting to Freepik (see utils/generation_gate.py's
    // resolve_generation_gate_tool) - without this a perfectly valid HeyGen
    // ticket fails validation because it was checked against the wrong tool,
    // the same fix Kling's equivalent handler already applies.
    params.set('tool_slug', 'heygen');

    const headers = {};
    if (settings.sessionToken) headers['X-Session-Id'] = settings.sessionToken;

    const response = await fetch(`${settings.apiBase}/api/tasks/my-active?${params.toString()}`, {
      method: 'GET',
      credentials: 'include',
      headers,
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.success) {
      const reason = response.status === 410 || response.status === 403 ? 'session_expired' : undefined;
      return { ok: false, error: buildApiErrorMessage(data, response, 'Unable to load your tasks', settings), reason };
    }
    return { ok: true, tasks: Array.isArray(data.tasks) ? data.tasks : [] };
  } catch (error) {
    return { ok: false, error: error?.message || 'Unable to load your tasks' };
  }
}

// Client Mapping: populates content-heygen-task-modal.js's client picker -
// same ticket-based identity, same non-queued/immediate-failure posture as
// handleHeygenFetchMyActiveTasksMessage above.
async function handleHeygenFetchActiveClientsMessage(message, senderTabId = 0, openerTabId = 0) {
  const tabId = message?.tabId || senderTabId || 0;
  const directLaunch = await getActiveLaunch(tabId, 'heygen');
  const inheritedLaunch = directLaunch?.ticket ? null : await getActiveLaunch(openerTabId, 'heygen');
  const activeLaunch = directLaunch || inheritedLaunch;

  if (!activeLaunch?.ticket && !activeLaunch?.usageTrackingTicket) {
    return { ok: false, error: 'Launch HeyGen from the dashboard before client selection can run.', reason: 'session_expired' };
  }

  try {
    const settings = await getSettings();
    const params = new URLSearchParams();
    if (activeLaunch.usageTrackingTicket) params.set('usage_ticket', activeLaunch.usageTrackingTicket);
    if (activeLaunch.ticket) params.set('extension_ticket', activeLaunch.ticket);
    // See the identical comment in handleHeygenFetchMyActiveTasksMessage above.
    params.set('tool_slug', 'heygen');

    const headers = {};
    if (settings.sessionToken) headers['X-Session-Id'] = settings.sessionToken;

    const response = await fetch(`${settings.apiBase}/api/clients/active?${params.toString()}`, {
      method: 'GET',
      credentials: 'include',
      headers,
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.success) {
      const reason = response.status === 410 || response.status === 403 ? 'session_expired' : undefined;
      return { ok: false, error: buildApiErrorMessage(data, response, 'Unable to load clients', settings), reason };
    }
    return { ok: true, clients: Array.isArray(data.clients) ? data.clients : [] };
  } catch (error) {
    return { ok: false, error: error?.message || 'Unable to load clients' };
  }
}
