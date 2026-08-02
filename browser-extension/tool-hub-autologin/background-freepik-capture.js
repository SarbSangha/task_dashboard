// background-freepik-capture.js — loaded via importScripts() from
// background.js, before background-main.js (see manifest ordering there).
//
// Owns the Freepik/Magnific raw-capture outbox: one shared queue for the
// whole browser, persisted to chrome.storage.local so a crash or extension
// reload never loses a queued event before it's flushed. Reuses the same
// retry-backoff formula and chrome.alarms wake-up pattern
// background-main.js already uses for Kling's usage-event queue and
// background-chatgpt-capture.js uses for ChatGPT's, with one deliberate
// difference: this queue is BEST_EFFORT (see
// backend/providers/freepik/constants.py RELIABILITY_CLASS), not LOSSLESS -
// there is no webhook/server push for Freepik, so an event that still can't
// upload after FREEPIK_CAPTURE_RETRY_MAX_ATTEMPTS is dropped rather than
// retried forever (the reconciliation walk in content-freepik.js is the
// backstop for anything lost this way).
//
// getSettings(), buildApiErrorMessage(), and getActiveLaunch() are defined
// in background-main.js and reused here as-is (all three files run in the
// same classic service-worker global scope via importScripts, so no
// re-declaration or explicit import is needed - forward references resolve
// fine because none of these functions are actually *called* until after
// every importScripts'd file has finished loading).

const FREEPIK_CAPTURE_QUEUE_STORAGE_KEY = 'pendingFreepikCaptureEvents';
const FREEPIK_CAPTURE_SESSION_ID_STORAGE_KEY = 'freepikCaptureExtensionSessionId';
const FREEPIK_CAPTURE_RETRY_ALARM = 'retryPendingFreepikCaptureEvents';
const FREEPIK_CAPTURE_HEALTH_ALARM = 'reportFreepikCaptureHealth';
const FREEPIK_CAPTURE_BATCH_MAX = 200;
const FREEPIK_CAPTURE_FLUSH_QUIET_MS = 500;
const FREEPIK_CAPTURE_FLUSH_MAX_WAIT_MS = 2000;
const FREEPIK_CAPTURE_FLUSH_EVENT_THRESHOLD = 50;
// BEST_EFFORT ceiling: after this many failed attempts on one event, it is
// dropped rather than retried forever - the defining difference from
// ChatGPT's LOSSLESS queue (which never gives up). A generation missed this
// way is still recoverable later via the reconciliation walk (unattributed,
// per CAPTURE_CONTRACT.md's ownership decision table), so dropping here is
// "degrade to unattributed", never "lose the row permanently".
const FREEPIK_CAPTURE_RETRY_MAX_ATTEMPTS = 12;
// Safety valve, not a normal operating ceiling - same reasoning as
// background-chatgpt-capture.js's CHATGPT_CAPTURE_QUEUE_HARD_LIMIT.
const FREEPIK_CAPTURE_QUEUE_HARD_LIMIT = 3000;
const FREEPIK_CAPTURE_HEALTH_MIN_INTERVAL_MS = 5 * 60 * 1000;

const freepikCaptureHealthState = {
  lastCaptureEventAt: 0,
  lastSuccessfulUploadAt: 0,
  lastFailedUploadAt: 0,
  offlineSince: 0,
  lastPingAt: 0,
  uploadDurationsMs: [],
};

const freepikCaptureTelemetry = {
  totalEnqueued: 0,
  totalCreated: 0,
  totalDuplicate: 0,
  totalRejected: 0,
  totalUploadFailures: 0,
  totalDroppedForRetryCeiling: 0,
  totalDroppedForQueueCeiling: 0,
};

let freepikCaptureQuietTimer = null;
let freepikCaptureMaxWaitTimer = null;
let freepikCaptureFlushInFlight = null;

function getFreepikCaptureRetryDelayMs(attempts) {
  const baseMs = 30 * 1000;
  const exponent = Math.max(0, Math.min(Number(attempts || 0), 6));
  return Math.min(baseMs * Math.pow(2, exponent), 30 * 60 * 1000);
}

async function getFreepikCaptureExtensionSessionId() {
  const stored = await chrome.storage.local.get([FREEPIK_CAPTURE_SESSION_ID_STORAGE_KEY]);
  const existing = `${stored[FREEPIK_CAPTURE_SESSION_ID_STORAGE_KEY] || ''}`.trim();
  if (existing) return existing;
  const generated = (typeof crypto?.randomUUID === 'function')
    ? crypto.randomUUID()
    : `sess_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  await chrome.storage.local.set({ [FREEPIK_CAPTURE_SESSION_ID_STORAGE_KEY]: generated });
  return generated;
}

// Serializes every read-modify-write cycle against the shared
// chrome.storage.local queue key. This is the fix for a real, confirmed bug:
// when several images in the same "auto" batch finish rendering within
// milliseconds of each other, each one's completion triggers its own call
// into enqueueFreepikCaptureEvent()/flushFreepikCaptureQueue()'s write-back
// step. Every one of those is `await read(); ...mutate...; await write();` -
// and `await` yields control back to the event loop, so if two calls start
// close together, BOTH read the same (stale) queue before EITHER writes
// back, and the second write silently clobbers the first (last-write-wins).
// This was the actual cause of "only one image out of several near-
// simultaneous completions gets captured" - a textbook lost-update race,
// not a logic bug in what gets captured. Every place that reads-then-writes
// this queue MUST go through withFreepikQueueLock; a plain async function
// with its own await read/write is not sufficient on its own.
let freepikQueueChain = Promise.resolve();

function withFreepikQueueLock(criticalSection) {
  const result = freepikQueueChain.then(criticalSection, criticalSection);
  // The chain must always resolve regardless of one section's outcome, or a
  // single failure would permanently wedge every future call behind a
  // rejected promise.
  freepikQueueChain = result.then(() => {}, () => {});
  return result;
}

async function readFreepikCaptureQueue() {
  const stored = await chrome.storage.local.get([FREEPIK_CAPTURE_QUEUE_STORAGE_KEY]);
  const queue = stored[FREEPIK_CAPTURE_QUEUE_STORAGE_KEY];
  return Array.isArray(queue) ? queue.filter((item) => item && typeof item === 'object') : [];
}

async function writeFreepikCaptureQueue(queue) {
  if (queue.length > FREEPIK_CAPTURE_QUEUE_HARD_LIMIT) {
    const overflow = queue.length - FREEPIK_CAPTURE_QUEUE_HARD_LIMIT;
    freepikCaptureTelemetry.totalDroppedForQueueCeiling += overflow;
    console.error(
      '[RMW Freepik Capture] Queue exceeded hard ceiling - dropping oldest events to protect chrome.storage.local',
      { overflow, ceiling: FREEPIK_CAPTURE_QUEUE_HARD_LIMIT }
    );
    queue = queue.slice(overflow);
  }
  await chrome.storage.local.set({ [FREEPIK_CAPTURE_QUEUE_STORAGE_KEY]: queue });
  return queue;
}

function scheduleFreepikCaptureRetry(delayMs = 60 * 1000) {
  try {
    if (chrome?.alarms?.create) {
      chrome.alarms.create(FREEPIK_CAPTURE_RETRY_ALARM, { when: Date.now() + Math.max(5000, delayMs) });
      return;
    }
  } catch {}
  setTimeout(() => flushFreepikCaptureQueue().catch(() => {}), Math.max(5000, delayMs));
}

function clearFreepikCaptureFlushTimers() {
  if (freepikCaptureQuietTimer) { clearTimeout(freepikCaptureQuietTimer); freepikCaptureQuietTimer = null; }
  if (freepikCaptureMaxWaitTimer) { clearTimeout(freepikCaptureMaxWaitTimer); freepikCaptureMaxWaitTimer = null; }
}

function scheduleFreepikCaptureFlush() {
  if (freepikCaptureQuietTimer) clearTimeout(freepikCaptureQuietTimer);
  freepikCaptureQuietTimer = setTimeout(() => {
    freepikCaptureQuietTimer = null;
    runFreepikCaptureFlush();
  }, FREEPIK_CAPTURE_FLUSH_QUIET_MS);

  if (!freepikCaptureMaxWaitTimer) {
    freepikCaptureMaxWaitTimer = setTimeout(() => {
      freepikCaptureMaxWaitTimer = null;
      runFreepikCaptureFlush();
    }, FREEPIK_CAPTURE_FLUSH_MAX_WAIT_MS);
  }
}

function runFreepikCaptureFlush() {
  clearFreepikCaptureFlushTimers();
  freepikCaptureFlushInFlight = flushFreepikCaptureQueue()
    .catch((error) => {
      console.error('[RMW Freepik Capture] Flush failed unexpectedly', error);
    })
    .finally(() => {
      freepikCaptureFlushInFlight = null;
    });
  return freepikCaptureFlushInFlight;
}

async function enqueueFreepikCaptureEvent(event) {
  let shouldFlushNow = false;
  let shouldScheduleFlush = false;

  await withFreepikQueueLock(async () => {
    const now = Date.now();
    const queue = await readFreepikCaptureQueue();

    // A still-processing row generates the SAME client_event_id on every poll
    // until it settles (see content-freepik.js's changeToken comment) -
    // without this check, a slow-to-render generation would pile up many
    // near-identical queue entries sharing one key, each independently
    // tracked/retried, before the first one even gets a chance to flush. The
    // server would collapse them all to 1 created + N duplicates anyway, so
    // this is pure local waste, not a correctness issue - but worth avoiding.
    const alreadyQueued = queue.some((item) => item.key === event.client_event_id);
    if (alreadyQueued) {
      freepikCaptureHealthState.lastCaptureEventAt = now;
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
    await writeFreepikCaptureQueue(queue);

    freepikCaptureHealthState.lastCaptureEventAt = now;
    freepikCaptureTelemetry.totalEnqueued += 1;

    const readyCount = queue.filter((item) => Number(item.nextAttemptAt || 0) <= now).length;
    if (readyCount >= FREEPIK_CAPTURE_FLUSH_EVENT_THRESHOLD) {
      shouldFlushNow = true;
    } else {
      shouldScheduleFlush = true;
    }
  });

  // Triggering the flush itself happens OUTSIDE the lock - runFreepikCaptureFlush
  // only schedules/starts a flush cycle, it doesn't touch the queue directly
  // (flushFreepikCaptureQueue's own critical sections take the lock
  // themselves) - keeping it outside avoids the flush's slow network POST
  // ever being awaited while holding this lock, which would otherwise block
  // every other enqueue call for the duration of that request.
  if (shouldFlushNow) runFreepikCaptureFlush();
  else if (shouldScheduleFlush) scheduleFreepikCaptureFlush();
}

function recordFreepikCaptureUploadDuration(durationMs) {
  const durations = freepikCaptureHealthState.uploadDurationsMs;
  durations.push(durationMs);
  if (durations.length > 20) durations.shift();
}

function computeFreepikCaptureAverageUploadTimeMs() {
  const durations = freepikCaptureHealthState.uploadDurationsMs;
  if (!durations.length) return undefined;
  const total = durations.reduce((sum, value) => sum + value, 0);
  return Math.round(total / durations.length);
}

async function postFreepikCaptureEventsBatch(settings, events) {
  const headers = { 'Content-Type': 'application/json' };
  if (settings.sessionToken) headers['X-Session-Id'] = settings.sessionToken;

  const response = await fetch(`${settings.apiBase}/api/providers/freepik/capture/events`, {
    method: 'POST',
    credentials: 'include',
    headers,
    body: JSON.stringify({ events }),
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.success) {
    const error = new Error(buildApiErrorMessage(data, response, 'Freepik capture upload failed', settings));
    error.status = response.status;
    throw error;
  }
  return data;
}

async function flushFreepikCaptureQueue() {
  const now = Date.now();
  const queue = await readFreepikCaptureQueue();
  if (!queue.length) return { attempted: 0, remaining: 0 };

  const readyItems = queue.filter((item) => Number(item.nextAttemptAt || 0) <= now);
  if (!readyItems.length) {
    const nextDueAt = queue.reduce((min, item) => Math.min(min, Number(item.nextAttemptAt || 0) || min), Number.POSITIVE_INFINITY);
    if (Number.isFinite(nextDueAt)) scheduleFreepikCaptureRetry(Math.max(5000, nextDueAt - now));
    return { attempted: 0, remaining: queue.length };
  }

  const batch = readyItems.slice(0, FREEPIK_CAPTURE_BATCH_MAX);
  const batchKeys = new Set(batch.map((item) => item.key));
  const startedAt = Date.now();

  // The network POST deliberately happens OUTSIDE withFreepikQueueLock - it
  // can take seconds, and holding the lock for its duration would block
  // every enqueue call (i.e. every OTHER image's capture event) for that
  // entire time. Only the actual read-modify-write of the stored queue
  // (below) needs exclusivity.
  let uploadResponse = null;
  let uploadError = null;
  try {
    const settings = await getSettings();
    uploadResponse = await postFreepikCaptureEventsBatch(settings, batch.map((item) => ({
      ...item.event,
      session_id: item.event.session_id || settings.sessionToken || undefined,
    })));
  } catch (error) {
    uploadError = error;
  }

  await withFreepikQueueLock(async () => {
    if (uploadResponse) {
      recordFreepikCaptureUploadDuration(Date.now() - startedAt);
      freepikCaptureHealthState.lastSuccessfulUploadAt = Date.now();
      freepikCaptureHealthState.offlineSince = 0;

      const statusCounts = (uploadResponse.results || []).reduce((counts, result) => {
        counts[result.status] = (counts[result.status] || 0) + 1;
        return counts;
      }, {});
      freepikCaptureTelemetry.totalCreated += statusCounts.created || 0;
      freepikCaptureTelemetry.totalDuplicate += statusCounts.duplicate || 0;
      freepikCaptureTelemetry.totalRejected += statusCounts.rejected || 0;

      const resultByKey = new Map((uploadResponse.results || []).map((result) => [result.client_event_id, result]));
      // Re-read INSIDE the lock, not reused from the outer scope - items may
      // have been enqueued (or even flushed by another concurrent call, now
      // impossible thanks to this same lock) since the batch was selected
      // above, and this write must be based on current state, not a stale
      // snapshot from before the network round trip.
      const latestQueue = await readFreepikCaptureQueue();
      const remaining = latestQueue.filter((item) => {
        if (!batchKeys.has(item.key)) return true;
        const result = resultByKey.get(item.key);
        // created/duplicate/rejected are all definitive backend responses -
        // none of them are retried. Only a whole-batch transport failure
        // (network error, 5xx) below is retryable.
        return !result;
      });
      await writeFreepikCaptureQueue(remaining);
    } else {
      recordFreepikCaptureUploadDuration(Date.now() - startedAt);
      freepikCaptureHealthState.lastFailedUploadAt = Date.now();
      if (!freepikCaptureHealthState.offlineSince) freepikCaptureHealthState.offlineSince = Date.now();
      freepikCaptureTelemetry.totalUploadFailures += 1;

      const latestQueue = await readFreepikCaptureQueue();
      const errorMessage = `${uploadError?.message || uploadError || 'Freepik capture upload failed'}`.slice(0, 500);
      const updated = [];
      for (const item of latestQueue) {
        if (!batchKeys.has(item.key)) {
          updated.push(item);
          continue;
        }
        const attempts = Number(item.attempts || 0) + 1;
        if (attempts > FREEPIK_CAPTURE_RETRY_MAX_ATTEMPTS) {
          // BEST_EFFORT ceiling reached - drop, don't retry forever (see this
          // file's top comment for why that's an acceptable degrade, not data
          // loss in the "we'll never know this happened" sense).
          freepikCaptureTelemetry.totalDroppedForRetryCeiling += 1;
          continue;
        }
        updated.push({
          ...item,
          attempts,
          lastError: errorMessage,
          nextAttemptAt: now + getFreepikCaptureRetryDelayMs(attempts),
        });
      }
      await writeFreepikCaptureQueue(updated);
    }
  });

  maybeReportFreepikCaptureHealth().catch(() => {});

  const finalQueue = await readFreepikCaptureQueue();
  const stillReady = finalQueue.some((item) => Number(item.nextAttemptAt || 0) <= Date.now());
  if (stillReady) {
    return runFreepikCaptureFlush();
  }
  const nextDueAt = finalQueue.reduce((min, item) => Math.min(min, Number(item.nextAttemptAt || 0) || min), Number.POSITIVE_INFINITY);
  if (Number.isFinite(nextDueAt)) {
    scheduleFreepikCaptureRetry(Math.max(5000, nextDueAt - Date.now()));
  }
  return { attempted: batch.length, remaining: finalQueue.length };
}

async function maybeReportFreepikCaptureHealth(force = false) {
  const now = Date.now();
  if (!force && now - freepikCaptureHealthState.lastPingAt < FREEPIK_CAPTURE_HEALTH_MIN_INTERVAL_MS) return;
  freepikCaptureHealthState.lastPingAt = now;

  try {
    const [settings, queue, extensionSessionId] = await Promise.all([
      getSettings(),
      readFreepikCaptureQueue(),
      getFreepikCaptureExtensionSessionId(),
    ]);

    const oldestPendingEventAt = queue.length
      ? Math.min(...queue.map((item) => Number(item.enqueuedAt || now)))
      : 0;

    const headers = { 'Content-Type': 'application/json' };
    if (settings.sessionToken) headers['X-Session-Id'] = settings.sessionToken;

    await fetch(`${settings.apiBase}/api/providers/freepik/capture/health`, {
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
        last_capture_event_at: freepikCaptureHealthState.lastCaptureEventAt
          ? new Date(freepikCaptureHealthState.lastCaptureEventAt).toISOString() : undefined,
        last_successful_upload_at: freepikCaptureHealthState.lastSuccessfulUploadAt
          ? new Date(freepikCaptureHealthState.lastSuccessfulUploadAt).toISOString() : undefined,
        last_failed_upload_at: freepikCaptureHealthState.lastFailedUploadAt
          ? new Date(freepikCaptureHealthState.lastFailedUploadAt).toISOString() : undefined,
        average_upload_time_ms: computeFreepikCaptureAverageUploadTimeMs(),
        offline_since: freepikCaptureHealthState.offlineSince
          ? new Date(freepikCaptureHealthState.offlineSince).toISOString() : undefined,
      }),
    });
  } catch {
    // Health reporting is itself best-effort/non-critical - never queued or retried.
  }
}

async function handleFreepikCaptureEventMessage(message, senderTabId = 0, openerTabId = 0) {
  const event = message?.event;
  if (!event || typeof event !== 'object' || !event.event_type || !event.client_event_id) {
    return { ok: false, error: 'Invalid capture event payload' };
  }

  // Ticket attachment happens here (enqueue time), not at flush time - by
  // the time a batch actually uploads (possibly minutes later, after
  // retries), the originating tab may be closed and its launch record gone.
  // Mirrors reportUsageEvent()'s exact resolution order (direct tab launch,
  // falling back to the opener tab for popup/inherited launches).
  const tabId = message.tabId || senderTabId || 0;
  const directLaunch = await getActiveLaunch(tabId, 'freepik');
  const inheritedLaunch = directLaunch?.ticket ? null : await getActiveLaunch(openerTabId, 'freepik');
  const activeLaunch = directLaunch || inheritedLaunch;

  const enrichedEvent = {
    ...event,
    extension_ticket: event.extension_ticket || activeLaunch?.ticket || undefined,
    usage_ticket: event.usage_ticket || activeLaunch?.usageTrackingTicket || undefined,
    tab_id: tabId || undefined,
  };

  await enqueueFreepikCaptureEvent(enrichedEvent);
  return { ok: true, queued: true };
}

async function handleFreepikSyncProgressMessage(message, senderTabId = 0, openerTabId = 0) {
  // Best-effort, fire-and-forget - never queued/retried. A missed progress
  // report just means the next walk repeats or starts a little further
  // back, which is safe (server-side dedupe on creation_id) - not worth the
  // complexity of a durable queue for a pure optimization hint.
  const directLaunch = await getActiveLaunch(senderTabId, 'freepik');
  const inheritedLaunch = directLaunch?.ticket ? null : await getActiveLaunch(openerTabId, 'freepik');
  const activeLaunch = directLaunch || inheritedLaunch;

  try {
    const settings = await getSettings();
    const headers = { 'Content-Type': 'application/json' };
    if (settings.sessionToken) headers['X-Session-Id'] = settings.sessionToken;
    await fetch(`${settings.apiBase}/api/providers/freepik/sync/cursor`, {
      method: 'POST',
      credentials: 'include',
      headers,
      body: JSON.stringify({
        last_seen_creation_id: message.lastSeenCreationId || null,
        last_synced_page: Number(message.lastSyncedPage || 0),
        is_full_reconciliation: Boolean(message.isFullReconciliation),
        status: message.status || 'idle',
        extension_ticket: activeLaunch?.ticket || undefined,
        usage_ticket: activeLaunch?.usageTrackingTicket || undefined,
      }),
    });
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error?.message || 'Freepik sync progress report failed' };
  }
}

// Task Mapping: populates content-freepik-task-modal.js's picker. Called
// from freepik.com (a different origin than our dashboard), so identity is
// the same launch ticket every other Freepik endpoint here uses - never a
// dashboard session cookie. Not queued/retried (unlike capture events): the
// generation is actively blocked waiting on this, so a failure must surface
// to the modal immediately as a "Retry" state, not silently retry later.
async function handleFreepikFetchMyActiveTasksMessage(message, senderTabId = 0, openerTabId = 0) {
  const tabId = message?.tabId || senderTabId || 0;
  const directLaunch = await getActiveLaunch(tabId, 'freepik');
  const inheritedLaunch = directLaunch?.ticket ? null : await getActiveLaunch(openerTabId, 'freepik');
  const activeLaunch = directLaunch || inheritedLaunch;

  if (!activeLaunch?.ticket && !activeLaunch?.usageTrackingTicket) {
    return { ok: false, error: 'Launch Freepik from the dashboard before task selection can run.', reason: 'session_expired' };
  }

  try {
    const settings = await getSettings();
    const params = new URLSearchParams();
    if (activeLaunch.usageTrackingTicket) params.set('usage_ticket', activeLaunch.usageTrackingTicket);
    if (activeLaunch.ticket) params.set('extension_ticket', activeLaunch.ticket);

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

// Client Mapping: populates content-freepik-task-modal.js's client picker -
// same ticket-based identity, same non-queued/immediate-failure posture as
// handleFreepikFetchMyActiveTasksMessage above, since this list is also
// unrelated to task ownership and just needs the extension to prove which
// employee is asking.
async function handleFreepikFetchActiveClientsMessage(message, senderTabId = 0, openerTabId = 0) {
  const tabId = message?.tabId || senderTabId || 0;
  const directLaunch = await getActiveLaunch(tabId, 'freepik');
  const inheritedLaunch = directLaunch?.ticket ? null : await getActiveLaunch(openerTabId, 'freepik');
  const activeLaunch = directLaunch || inheritedLaunch;

  if (!activeLaunch?.ticket && !activeLaunch?.usageTrackingTicket) {
    return { ok: false, error: 'Launch Freepik from the dashboard before client selection can run.', reason: 'session_expired' };
  }

  try {
    const settings = await getSettings();
    const params = new URLSearchParams();
    if (activeLaunch.usageTrackingTicket) params.set('usage_ticket', activeLaunch.usageTrackingTicket);
    if (activeLaunch.ticket) params.set('extension_ticket', activeLaunch.ticket);

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
