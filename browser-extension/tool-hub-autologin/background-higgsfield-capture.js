// background-higgsfield-capture.js — loaded via importScripts() from
// background.js, before background-main.js (see manifest ordering there).
//
// Owns the Higgsfield raw-capture outbox: one shared queue for the whole
// browser, persisted to chrome.storage.local so a crash or extension reload
// never loses a queued event before it's flushed. Mirrors
// background-heygen-capture.js (this file's template) near-verbatim,
// including its BEST_EFFORT posture (see providers/higgsfield/constants.py
// RELIABILITY_CLASS) - there is no webhook/server push for Higgsfield, so an
// event that still can't upload after HIGGSFIELD_CAPTURE_RETRY_MAX_ATTEMPTS
// is dropped rather than retried forever. Like HeyGen, there is currently no
// reconciliation walker backstopping a dropped event (see
// providers/higgsfield/sync.py's docstring) - this is an explicit,
// documented limitation of this pass, not an oversight.
//
// getSettings(), buildApiErrorMessage(), and getActiveLaunch() are defined
// in background-main.js and reused here as-is (all three files run in the
// same classic service-worker global scope via importScripts).

const HIGGSFIELD_CAPTURE_QUEUE_STORAGE_KEY = 'pendingHiggsfieldCaptureEvents';
const HIGGSFIELD_CAPTURE_SESSION_ID_STORAGE_KEY = 'higgsfieldCaptureExtensionSessionId';
const HIGGSFIELD_CAPTURE_RETRY_ALARM = 'retryPendingHiggsfieldCaptureEvents';
const HIGGSFIELD_CAPTURE_HEALTH_ALARM = 'reportHiggsfieldCaptureHealth';
const HIGGSFIELD_CAPTURE_BATCH_MAX = 200;
const HIGGSFIELD_CAPTURE_FLUSH_QUIET_MS = 500;
const HIGGSFIELD_CAPTURE_FLUSH_MAX_WAIT_MS = 2000;
const HIGGSFIELD_CAPTURE_FLUSH_EVENT_THRESHOLD = 50;
// BEST_EFFORT ceiling: after this many failed attempts on one event, it is
// dropped rather than retried forever - see this file's top comment.
const HIGGSFIELD_CAPTURE_RETRY_MAX_ATTEMPTS = 12;
// Safety valve, not a normal operating ceiling - same reasoning as
// background-heygen-capture.js's HEYGEN_CAPTURE_QUEUE_HARD_LIMIT.
const HIGGSFIELD_CAPTURE_QUEUE_HARD_LIMIT = 3000;
const HIGGSFIELD_CAPTURE_HEALTH_MIN_INTERVAL_MS = 5 * 60 * 1000;

const higgsfieldCaptureHealthState = {
  lastCaptureEventAt: 0,
  lastSuccessfulUploadAt: 0,
  lastFailedUploadAt: 0,
  offlineSince: 0,
  lastPingAt: 0,
  uploadDurationsMs: [],
};

const higgsfieldCaptureTelemetry = {
  totalEnqueued: 0,
  totalCreated: 0,
  totalDuplicate: 0,
  totalRejected: 0,
  totalUploadFailures: 0,
  totalDroppedForRetryCeiling: 0,
  totalDroppedForQueueCeiling: 0,
};

let higgsfieldCaptureQuietTimer = null;
let higgsfieldCaptureMaxWaitTimer = null;
let higgsfieldCaptureFlushInFlight = null;

function getHiggsfieldCaptureRetryDelayMs(attempts) {
  const baseMs = 30 * 1000;
  const exponent = Math.max(0, Math.min(Number(attempts || 0), 6));
  return Math.min(baseMs * Math.pow(2, exponent), 30 * 60 * 1000);
}

async function getHiggsfieldCaptureExtensionSessionId() {
  const stored = await chrome.storage.local.get([HIGGSFIELD_CAPTURE_SESSION_ID_STORAGE_KEY]);
  const existing = `${stored[HIGGSFIELD_CAPTURE_SESSION_ID_STORAGE_KEY] || ''}`.trim();
  if (existing) return existing;
  const generated = (typeof crypto?.randomUUID === 'function')
    ? crypto.randomUUID()
    : `sess_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  await chrome.storage.local.set({ [HIGGSFIELD_CAPTURE_SESSION_ID_STORAGE_KEY]: generated });
  return generated;
}

// Serializes every read-modify-write cycle against the shared
// chrome.storage.local queue key - see background-heygen-capture.js's top
// comment for the exact near-simultaneous-completions race this prevents.
let higgsfieldQueueChain = Promise.resolve();

function withHiggsfieldQueueLock(criticalSection) {
  const result = higgsfieldQueueChain.then(criticalSection, criticalSection);
  higgsfieldQueueChain = result.then(() => {}, () => {});
  return result;
}

async function readHiggsfieldCaptureQueue() {
  const stored = await chrome.storage.local.get([HIGGSFIELD_CAPTURE_QUEUE_STORAGE_KEY]);
  const queue = stored[HIGGSFIELD_CAPTURE_QUEUE_STORAGE_KEY];
  return Array.isArray(queue) ? queue.filter((item) => item && typeof item === 'object') : [];
}

async function writeHiggsfieldCaptureQueue(queue) {
  if (queue.length > HIGGSFIELD_CAPTURE_QUEUE_HARD_LIMIT) {
    const overflow = queue.length - HIGGSFIELD_CAPTURE_QUEUE_HARD_LIMIT;
    higgsfieldCaptureTelemetry.totalDroppedForQueueCeiling += overflow;
    console.error(
      '[RMW Higgsfield Capture] Queue exceeded hard ceiling - dropping oldest events to protect chrome.storage.local',
      { overflow, ceiling: HIGGSFIELD_CAPTURE_QUEUE_HARD_LIMIT }
    );
    queue = queue.slice(overflow);
  }
  await chrome.storage.local.set({ [HIGGSFIELD_CAPTURE_QUEUE_STORAGE_KEY]: queue });
  return queue;
}

function scheduleHiggsfieldCaptureRetry(delayMs = 60 * 1000) {
  try {
    if (chrome?.alarms?.create) {
      chrome.alarms.create(HIGGSFIELD_CAPTURE_RETRY_ALARM, { when: Date.now() + Math.max(5000, delayMs) });
      return;
    }
  } catch {}
  setTimeout(() => flushHiggsfieldCaptureQueue().catch(() => {}), Math.max(5000, delayMs));
}

function clearHiggsfieldCaptureFlushTimers() {
  if (higgsfieldCaptureQuietTimer) { clearTimeout(higgsfieldCaptureQuietTimer); higgsfieldCaptureQuietTimer = null; }
  if (higgsfieldCaptureMaxWaitTimer) { clearTimeout(higgsfieldCaptureMaxWaitTimer); higgsfieldCaptureMaxWaitTimer = null; }
}

function scheduleHiggsfieldCaptureFlush() {
  if (higgsfieldCaptureQuietTimer) clearTimeout(higgsfieldCaptureQuietTimer);
  higgsfieldCaptureQuietTimer = setTimeout(() => {
    higgsfieldCaptureQuietTimer = null;
    runHiggsfieldCaptureFlush();
  }, HIGGSFIELD_CAPTURE_FLUSH_QUIET_MS);

  if (!higgsfieldCaptureMaxWaitTimer) {
    higgsfieldCaptureMaxWaitTimer = setTimeout(() => {
      higgsfieldCaptureMaxWaitTimer = null;
      runHiggsfieldCaptureFlush();
    }, HIGGSFIELD_CAPTURE_FLUSH_MAX_WAIT_MS);
  }
}

function runHiggsfieldCaptureFlush() {
  clearHiggsfieldCaptureFlushTimers();
  higgsfieldCaptureFlushInFlight = flushHiggsfieldCaptureQueue()
    .catch((error) => {
      console.error('[RMW Higgsfield Capture] Flush failed unexpectedly', error);
    })
    .finally(() => {
      higgsfieldCaptureFlushInFlight = null;
    });
  return higgsfieldCaptureFlushInFlight;
}

async function enqueueHiggsfieldCaptureEvent(event) {
  let shouldFlushNow = false;
  let shouldScheduleFlush = false;

  await withHiggsfieldQueueLock(async () => {
    const now = Date.now();
    const queue = await readHiggsfieldCaptureQueue();

    // A still-rendering generation generates the SAME client_event_id on
    // every poll until it settles (see content-higgsfield.js's
    // higgsfieldChangeToken comment) - without this check, a slow render
    // would pile up many near-identical queue entries sharing one key before
    // the first one even gets a chance to flush. The server collapses them
    // to 1 created + N duplicates anyway, so this is pure local waste, not a
    // correctness issue - but worth avoiding, same as
    // background-heygen-capture.js.
    const alreadyQueued = queue.some((item) => item.key === event.client_event_id);
    if (alreadyQueued) {
      higgsfieldCaptureHealthState.lastCaptureEventAt = now;
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
    await writeHiggsfieldCaptureQueue(queue);

    higgsfieldCaptureHealthState.lastCaptureEventAt = now;
    higgsfieldCaptureTelemetry.totalEnqueued += 1;

    const readyCount = queue.filter((item) => Number(item.nextAttemptAt || 0) <= now).length;
    if (readyCount >= HIGGSFIELD_CAPTURE_FLUSH_EVENT_THRESHOLD) {
      shouldFlushNow = true;
    } else {
      shouldScheduleFlush = true;
    }
  });

  // Triggering the flush itself happens OUTSIDE the lock - see
  // background-heygen-capture.js's identical comment for why.
  if (shouldFlushNow) runHiggsfieldCaptureFlush();
  else if (shouldScheduleFlush) scheduleHiggsfieldCaptureFlush();
}

function recordHiggsfieldCaptureUploadDuration(durationMs) {
  const durations = higgsfieldCaptureHealthState.uploadDurationsMs;
  durations.push(durationMs);
  if (durations.length > 20) durations.shift();
}

function computeHiggsfieldCaptureAverageUploadTimeMs() {
  const durations = higgsfieldCaptureHealthState.uploadDurationsMs;
  if (!durations.length) return undefined;
  const total = durations.reduce((sum, value) => sum + value, 0);
  return Math.round(total / durations.length);
}

async function postHiggsfieldCaptureEventsBatch(settings, events) {
  const headers = { 'Content-Type': 'application/json' };
  if (settings.sessionToken) headers['X-Session-Id'] = settings.sessionToken;

  const response = await fetch(`${settings.apiBase}/api/providers/higgsfield/capture/events`, {
    method: 'POST',
    credentials: 'include',
    headers,
    body: JSON.stringify({ events }),
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.success) {
    const error = new Error(buildApiErrorMessage(data, response, 'Higgsfield capture upload failed', settings));
    error.status = response.status;
    throw error;
  }
  return data;
}

async function flushHiggsfieldCaptureQueue() {
  const now = Date.now();
  const queue = await readHiggsfieldCaptureQueue();
  if (!queue.length) return { attempted: 0, remaining: 0 };

  const readyItems = queue.filter((item) => Number(item.nextAttemptAt || 0) <= now);
  if (!readyItems.length) {
    const nextDueAt = queue.reduce((min, item) => Math.min(min, Number(item.nextAttemptAt || 0) || min), Number.POSITIVE_INFINITY);
    if (Number.isFinite(nextDueAt)) scheduleHiggsfieldCaptureRetry(Math.max(5000, nextDueAt - now));
    return { attempted: 0, remaining: queue.length };
  }

  const batch = readyItems.slice(0, HIGGSFIELD_CAPTURE_BATCH_MAX);
  const batchKeys = new Set(batch.map((item) => item.key));
  const startedAt = Date.now();

  // The network POST deliberately happens OUTSIDE withHiggsfieldQueueLock -
  // see background-heygen-capture.js's identical comment for why.
  let uploadResponse = null;
  let uploadError = null;
  try {
    const settings = await getSettings();
    uploadResponse = await postHiggsfieldCaptureEventsBatch(settings, batch.map((item) => ({
      ...item.event,
      session_id: item.event.session_id || settings.sessionToken || undefined,
    })));
  } catch (error) {
    uploadError = error;
  }

  await withHiggsfieldQueueLock(async () => {
    if (uploadResponse) {
      recordHiggsfieldCaptureUploadDuration(Date.now() - startedAt);
      higgsfieldCaptureHealthState.lastSuccessfulUploadAt = Date.now();
      higgsfieldCaptureHealthState.offlineSince = 0;

      const statusCounts = (uploadResponse.results || []).reduce((counts, result) => {
        counts[result.status] = (counts[result.status] || 0) + 1;
        return counts;
      }, {});
      higgsfieldCaptureTelemetry.totalCreated += statusCounts.created || 0;
      higgsfieldCaptureTelemetry.totalDuplicate += statusCounts.duplicate || 0;
      higgsfieldCaptureTelemetry.totalRejected += statusCounts.rejected || 0;

      const resultByKey = new Map((uploadResponse.results || []).map((result) => [result.client_event_id, result]));
      // Re-read INSIDE the lock, not reused from the outer scope - see
      // background-heygen-capture.js's identical comment for why.
      const latestQueue = await readHiggsfieldCaptureQueue();
      const remaining = latestQueue.filter((item) => {
        if (!batchKeys.has(item.key)) return true;
        const result = resultByKey.get(item.key);
        return !result;
      });
      await writeHiggsfieldCaptureQueue(remaining);
    } else {
      recordHiggsfieldCaptureUploadDuration(Date.now() - startedAt);
      higgsfieldCaptureHealthState.lastFailedUploadAt = Date.now();
      if (!higgsfieldCaptureHealthState.offlineSince) higgsfieldCaptureHealthState.offlineSince = Date.now();
      higgsfieldCaptureTelemetry.totalUploadFailures += 1;

      const latestQueue = await readHiggsfieldCaptureQueue();
      const errorMessage = `${uploadError?.message || uploadError || 'Higgsfield capture upload failed'}`.slice(0, 500);
      const updated = [];
      for (const item of latestQueue) {
        if (!batchKeys.has(item.key)) {
          updated.push(item);
          continue;
        }
        const attempts = Number(item.attempts || 0) + 1;
        if (attempts > HIGGSFIELD_CAPTURE_RETRY_MAX_ATTEMPTS) {
          // BEST_EFFORT ceiling reached - drop, don't retry forever (see this
          // file's top comment).
          higgsfieldCaptureTelemetry.totalDroppedForRetryCeiling += 1;
          continue;
        }
        updated.push({
          ...item,
          attempts,
          lastError: errorMessage,
          nextAttemptAt: now + getHiggsfieldCaptureRetryDelayMs(attempts),
        });
      }
      await writeHiggsfieldCaptureQueue(updated);
    }
  });

  maybeReportHiggsfieldCaptureHealth().catch(() => {});

  const finalQueue = await readHiggsfieldCaptureQueue();
  const stillReady = finalQueue.some((item) => Number(item.nextAttemptAt || 0) <= Date.now());
  if (stillReady) {
    return runHiggsfieldCaptureFlush();
  }
  const nextDueAt = finalQueue.reduce((min, item) => Math.min(min, Number(item.nextAttemptAt || 0) || min), Number.POSITIVE_INFINITY);
  if (Number.isFinite(nextDueAt)) {
    scheduleHiggsfieldCaptureRetry(Math.max(5000, nextDueAt - Date.now()));
  }
  return { attempted: batch.length, remaining: finalQueue.length };
}

async function maybeReportHiggsfieldCaptureHealth(force = false) {
  const now = Date.now();
  if (!force && now - higgsfieldCaptureHealthState.lastPingAt < HIGGSFIELD_CAPTURE_HEALTH_MIN_INTERVAL_MS) return;
  higgsfieldCaptureHealthState.lastPingAt = now;

  try {
    const [settings, queue, extensionSessionId] = await Promise.all([
      getSettings(),
      readHiggsfieldCaptureQueue(),
      getHiggsfieldCaptureExtensionSessionId(),
    ]);

    const oldestPendingEventAt = queue.length
      ? Math.min(...queue.map((item) => Number(item.enqueuedAt || now)))
      : 0;

    const headers = { 'Content-Type': 'application/json' };
    if (settings.sessionToken) headers['X-Session-Id'] = settings.sessionToken;

    await fetch(`${settings.apiBase}/api/providers/higgsfield/capture/health`, {
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
        last_capture_event_at: higgsfieldCaptureHealthState.lastCaptureEventAt
          ? new Date(higgsfieldCaptureHealthState.lastCaptureEventAt).toISOString() : undefined,
        last_successful_upload_at: higgsfieldCaptureHealthState.lastSuccessfulUploadAt
          ? new Date(higgsfieldCaptureHealthState.lastSuccessfulUploadAt).toISOString() : undefined,
        last_failed_upload_at: higgsfieldCaptureHealthState.lastFailedUploadAt
          ? new Date(higgsfieldCaptureHealthState.lastFailedUploadAt).toISOString() : undefined,
        average_upload_time_ms: computeHiggsfieldCaptureAverageUploadTimeMs(),
        offline_since: higgsfieldCaptureHealthState.offlineSince
          ? new Date(higgsfieldCaptureHealthState.offlineSince).toISOString() : undefined,
      }),
    });
  } catch {
    // Health reporting is itself best-effort/non-critical - never queued or retried.
  }
}

async function handleHiggsfieldCaptureEventMessage(message, senderTabId = 0, openerTabId = 0) {
  const event = message?.event;
  if (!event || typeof event !== 'object' || !event.event_type || !event.client_event_id) {
    return { ok: false, error: 'Invalid capture event payload' };
  }

  // Ticket attachment happens here (enqueue time), not at flush time - by
  // the time a batch actually uploads (possibly minutes later, after
  // retries), the originating tab may be closed and its launch record gone.
  // Mirrors handleHeygenCaptureEventMessage's exact resolution order.
  const tabId = message.tabId || senderTabId || 0;
  const directLaunch = await getActiveLaunch(tabId, 'higgsfield');
  const inheritedLaunch = directLaunch?.ticket ? null : await getActiveLaunch(openerTabId, 'higgsfield');
  const activeLaunch = directLaunch || inheritedLaunch;

  const enrichedEvent = {
    ...event,
    extension_ticket: event.extension_ticket || activeLaunch?.ticket || undefined,
    usage_ticket: event.usage_ticket || activeLaunch?.usageTrackingTicket || undefined,
    tab_id: tabId || undefined,
  };

  await enqueueHiggsfieldCaptureEvent(enrichedEvent);
  return { ok: true, queued: true };
}

// Not currently called by content-higgsfield.js (no reconciliation walker
// exists yet in this pass - see providers/higgsfield/sync.py's docstring)
// but kept fully wired, mirroring handleHeygenSyncProgressMessage, so a
// future walker only needs to start sending this message type.
async function handleHiggsfieldSyncProgressMessage(message, senderTabId = 0, openerTabId = 0) {
  const directLaunch = await getActiveLaunch(senderTabId, 'higgsfield');
  const inheritedLaunch = directLaunch?.ticket ? null : await getActiveLaunch(openerTabId, 'higgsfield');
  const activeLaunch = directLaunch || inheritedLaunch;

  try {
    const settings = await getSettings();
    const headers = { 'Content-Type': 'application/json' };
    if (settings.sessionToken) headers['X-Session-Id'] = settings.sessionToken;
    await fetch(`${settings.apiBase}/api/providers/higgsfield/sync/cursor`, {
      method: 'POST',
      credentials: 'include',
      headers,
      body: JSON.stringify({
        last_seen_generation_id: message.lastSeenGenerationId || null,
        last_synced_page: Number(message.lastSyncedPage || 0),
        is_full_reconciliation: Boolean(message.isFullReconciliation),
        status: message.status || 'idle',
        extension_ticket: activeLaunch?.ticket || undefined,
        usage_ticket: activeLaunch?.usageTrackingTicket || undefined,
      }),
    });
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error?.message || 'Higgsfield sync progress report failed' };
  }
}

// Task Mapping: populates content-higgsfield-task-modal.js's picker. Called
// from higgsfield.ai (a different origin than our dashboard), so identity is
// the same launch ticket every other Higgsfield endpoint here uses - never a
// dashboard session cookie. Not queued/retried (unlike capture events): the
// generation is actively blocked waiting on this, so a failure must surface
// to the modal immediately as a "Retry" state, not silently retry later.
async function handleHiggsfieldFetchMyActiveTasksMessage(message, senderTabId = 0, openerTabId = 0) {
  const tabId = message?.tabId || senderTabId || 0;
  const directLaunch = await getActiveLaunch(tabId, 'higgsfield');
  const inheritedLaunch = directLaunch?.ticket ? null : await getActiveLaunch(openerTabId, 'higgsfield');
  const activeLaunch = directLaunch || inheritedLaunch;

  if (!activeLaunch?.ticket && !activeLaunch?.usageTrackingTicket) {
    return { ok: false, error: 'Launch Higgsfield from the dashboard before task selection can run.', reason: 'session_expired' };
  }

  try {
    const settings = await getSettings();
    const params = new URLSearchParams();
    if (activeLaunch.usageTrackingTicket) params.set('usage_ticket', activeLaunch.usageTrackingTicket);
    if (activeLaunch.ticket) params.set('extension_ticket', activeLaunch.ticket);
    // Tells the backend to validate the ticket against the Higgsfield tool
    // row instead of defaulting to Freepik (see
    // utils/generation_gate.py's resolve_generation_gate_tool) - without
    // this a perfectly valid Higgsfield ticket fails validation because it
    // was checked against the wrong tool. Freepik's own equivalent handler
    // omits this param and silently relies on being the gate's default
    // fallback - deliberately NOT repeating that omission here for a second
    // unguarded provider.
    params.set('tool_slug', 'higgsfield');

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

// Client Mapping: populates content-higgsfield-task-modal.js's client picker
// - same ticket-based identity, same non-queued/immediate-failure posture as
// handleHiggsfieldFetchMyActiveTasksMessage above.
async function handleHiggsfieldFetchActiveClientsMessage(message, senderTabId = 0, openerTabId = 0) {
  const tabId = message?.tabId || senderTabId || 0;
  const directLaunch = await getActiveLaunch(tabId, 'higgsfield');
  const inheritedLaunch = directLaunch?.ticket ? null : await getActiveLaunch(openerTabId, 'higgsfield');
  const activeLaunch = directLaunch || inheritedLaunch;

  if (!activeLaunch?.ticket && !activeLaunch?.usageTrackingTicket) {
    return { ok: false, error: 'Launch Higgsfield from the dashboard before client selection can run.', reason: 'session_expired' };
  }

  try {
    const settings = await getSettings();
    const params = new URLSearchParams();
    if (activeLaunch.usageTrackingTicket) params.set('usage_ticket', activeLaunch.usageTrackingTicket);
    if (activeLaunch.ticket) params.set('extension_ticket', activeLaunch.ticket);
    // See the identical comment in handleHiggsfieldFetchMyActiveTasksMessage above.
    params.set('tool_slug', 'higgsfield');

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
