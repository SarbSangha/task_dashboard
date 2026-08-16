// background-flow-capture.js — loaded via importScripts() from
// background.js, before background-main.js (see manifest ordering there).
//
// Owns the Flow (labs.google/fx/tools/flow) raw-capture outbox: one shared
// queue for the whole browser, persisted to chrome.storage.local so a crash
// or extension reload never loses a queued event before it's flushed.
// Structurally a direct copy of background-freepik-capture.js (this file's
// template - see its own top comment for the full reasoning) with two
// intentional omissions for this first pass, since neither has a backend
// endpoint built yet (see providers/flow/CAPTURE_CONTRACT.md's known gaps):
//   - No capture/health ping reporting (no /api/providers/flow/capture/health).
//   - No sync/cursor reconciliation reporting (no reconciliation walker
//     exists for Flow yet, unlike content-freepik.js's).
// Same BEST_EFFORT reliability class as Freepik (see
// backend/providers/flow/constants.py RELIABILITY_CLASS) - an event that
// still can't upload after FLOW_CAPTURE_RETRY_MAX_ATTEMPTS is dropped
// rather than retried forever. Unlike Freepik, there is currently no
// reconciliation backstop for anything lost this way - see this file's own
// top-level plan history for why that's an accepted gap in this pass, not
// an oversight.
//
// getSettings(), buildApiErrorMessage(), and getActiveLaunch() are defined
// in background-main.js and reused here as-is (all files run in the same
// classic service-worker global scope via importScripts, so no
// re-declaration or explicit import is needed).

const FLOW_CAPTURE_QUEUE_STORAGE_KEY = 'pendingFlowCaptureEvents';
const FLOW_CAPTURE_RETRY_ALARM = 'retryPendingFlowCaptureEvents';
const FLOW_CAPTURE_BATCH_MAX = 200;
const FLOW_CAPTURE_FLUSH_QUIET_MS = 500;
const FLOW_CAPTURE_FLUSH_MAX_WAIT_MS = 2000;
const FLOW_CAPTURE_FLUSH_EVENT_THRESHOLD = 50;
// BEST_EFFORT ceiling - see this file's own top comment for why dropping
// here is "degrade to unattributed", not "lose the row permanently"
// (identical reasoning to background-freepik-capture.js's constant of the
// same name).
const FLOW_CAPTURE_RETRY_MAX_ATTEMPTS = 12;
// Safety valve, not a normal operating ceiling.
const FLOW_CAPTURE_QUEUE_HARD_LIMIT = 3000;

const flowCaptureTelemetry = {
  totalEnqueued: 0,
  totalCreated: 0,
  totalDuplicate: 0,
  totalRejected: 0,
  totalUploadFailures: 0,
  totalDroppedForRetryCeiling: 0,
  totalDroppedForQueueCeiling: 0,
};

let flowCaptureQuietTimer = null;
let flowCaptureMaxWaitTimer = null;
let flowCaptureFlushInFlight = null;

function getFlowCaptureRetryDelayMs(attempts) {
  const baseMs = 30 * 1000;
  const exponent = Math.max(0, Math.min(Number(attempts || 0), 6));
  return Math.min(baseMs * Math.pow(2, exponent), 30 * 60 * 1000);
}

// Serializes every read-modify-write cycle against the shared
// chrome.storage.local queue key - see background-freepik-capture.js's
// withFreepikQueueLock for the exact lost-update race this prevents (two
// near-simultaneous generations both reading the queue before either writes
// back, silently clobbering one).
let flowQueueChain = Promise.resolve();

function withFlowQueueLock(criticalSection) {
  const result = flowQueueChain.then(criticalSection, criticalSection);
  flowQueueChain = result.then(() => {}, () => {});
  return result;
}

async function readFlowCaptureQueue() {
  const stored = await chrome.storage.local.get([FLOW_CAPTURE_QUEUE_STORAGE_KEY]);
  const queue = stored[FLOW_CAPTURE_QUEUE_STORAGE_KEY];
  return Array.isArray(queue) ? queue.filter((item) => item && typeof item === 'object') : [];
}

async function writeFlowCaptureQueue(queue) {
  if (queue.length > FLOW_CAPTURE_QUEUE_HARD_LIMIT) {
    const overflow = queue.length - FLOW_CAPTURE_QUEUE_HARD_LIMIT;
    flowCaptureTelemetry.totalDroppedForQueueCeiling += overflow;
    console.error(
      '[RMW Flow Capture] Queue exceeded hard ceiling - dropping oldest events to protect chrome.storage.local',
      { overflow, ceiling: FLOW_CAPTURE_QUEUE_HARD_LIMIT }
    );
    queue = queue.slice(overflow);
  }
  await chrome.storage.local.set({ [FLOW_CAPTURE_QUEUE_STORAGE_KEY]: queue });
  return queue;
}

function scheduleFlowCaptureRetry(delayMs = 60 * 1000) {
  try {
    if (chrome?.alarms?.create) {
      chrome.alarms.create(FLOW_CAPTURE_RETRY_ALARM, { when: Date.now() + Math.max(5000, delayMs) });
      return;
    }
  } catch {}
  setTimeout(() => flushFlowCaptureQueue().catch(() => {}), Math.max(5000, delayMs));
}

function clearFlowCaptureFlushTimers() {
  if (flowCaptureQuietTimer) { clearTimeout(flowCaptureQuietTimer); flowCaptureQuietTimer = null; }
  if (flowCaptureMaxWaitTimer) { clearTimeout(flowCaptureMaxWaitTimer); flowCaptureMaxWaitTimer = null; }
}

function scheduleFlowCaptureFlush() {
  if (flowCaptureQuietTimer) clearTimeout(flowCaptureQuietTimer);
  flowCaptureQuietTimer = setTimeout(() => {
    flowCaptureQuietTimer = null;
    runFlowCaptureFlush();
  }, FLOW_CAPTURE_FLUSH_QUIET_MS);

  if (!flowCaptureMaxWaitTimer) {
    flowCaptureMaxWaitTimer = setTimeout(() => {
      flowCaptureMaxWaitTimer = null;
      runFlowCaptureFlush();
    }, FLOW_CAPTURE_FLUSH_MAX_WAIT_MS);
  }
}

function runFlowCaptureFlush() {
  clearFlowCaptureFlushTimers();
  flowCaptureFlushInFlight = flushFlowCaptureQueue()
    .catch((error) => {
      console.error('[RMW Flow Capture] Flush failed unexpectedly', error);
    })
    .finally(() => {
      flowCaptureFlushInFlight = null;
    });
  return flowCaptureFlushInFlight;
}

async function enqueueFlowCaptureEvent(event) {
  let shouldFlushNow = false;
  let shouldScheduleFlush = false;

  await withFlowQueueLock(async () => {
    const now = Date.now();
    const queue = await readFlowCaptureQueue();

    // A still-settling row can generate the SAME client_event_id across a
    // couple of near-simultaneous captures (see content-flow.js's
    // changeToken comment) - without this check those would pile up as
    // separate queue entries before the first even flushes. The server
    // would collapse them to 1 created + N duplicates anyway - pure local
    // waste, not a correctness issue, but worth avoiding.
    const alreadyQueued = queue.some((item) => item.key === event.client_event_id);
    if (alreadyQueued) return;

    queue.push({
      key: event.client_event_id,
      event,
      enqueuedAt: now,
      attempts: 0,
      lastError: '',
      nextAttemptAt: 0,
    });
    await writeFlowCaptureQueue(queue);

    flowCaptureTelemetry.totalEnqueued += 1;

    const readyCount = queue.filter((item) => Number(item.nextAttemptAt || 0) <= now).length;
    if (readyCount >= FLOW_CAPTURE_FLUSH_EVENT_THRESHOLD) {
      shouldFlushNow = true;
    } else {
      shouldScheduleFlush = true;
    }
  });

  // Triggering the flush itself happens OUTSIDE the lock - see
  // background-freepik-capture.js's identical comment for why (the flush's
  // slow network POST must never be awaited while holding this lock).
  if (shouldFlushNow) runFlowCaptureFlush();
  else if (shouldScheduleFlush) scheduleFlowCaptureFlush();
}

async function postFlowCaptureEventsBatch(settings, events) {
  const headers = { 'Content-Type': 'application/json' };
  if (settings.sessionToken) headers['X-Session-Id'] = settings.sessionToken;

  const response = await fetch(`${settings.apiBase}/api/providers/flow/capture/events`, {
    method: 'POST',
    credentials: 'include',
    headers,
    body: JSON.stringify({ events }),
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.success) {
    const error = new Error(buildApiErrorMessage(data, response, 'Flow capture upload failed', settings));
    error.status = response.status;
    throw error;
  }
  return data;
}

async function flushFlowCaptureQueue() {
  const now = Date.now();
  const queue = await readFlowCaptureQueue();
  if (!queue.length) return { attempted: 0, remaining: 0 };

  const readyItems = queue.filter((item) => Number(item.nextAttemptAt || 0) <= now);
  if (!readyItems.length) {
    const nextDueAt = queue.reduce((min, item) => Math.min(min, Number(item.nextAttemptAt || 0) || min), Number.POSITIVE_INFINITY);
    if (Number.isFinite(nextDueAt)) scheduleFlowCaptureRetry(Math.max(5000, nextDueAt - now));
    return { attempted: 0, remaining: queue.length };
  }

  const batch = readyItems.slice(0, FLOW_CAPTURE_BATCH_MAX);
  const batchKeys = new Set(batch.map((item) => item.key));

  // The network POST deliberately happens OUTSIDE withFlowQueueLock - see
  // background-freepik-capture.js's identical comment for why.
  let uploadResponse = null;
  let uploadError = null;
  try {
    const settings = await getSettings();
    uploadResponse = await postFlowCaptureEventsBatch(settings, batch.map((item) => ({
      ...item.event,
      session_id: item.event.session_id || settings.sessionToken || undefined,
    })));
  } catch (error) {
    uploadError = error;
  }

  await withFlowQueueLock(async () => {
    if (uploadResponse) {
      const statusCounts = (uploadResponse.results || []).reduce((counts, result) => {
        counts[result.status] = (counts[result.status] || 0) + 1;
        return counts;
      }, {});
      flowCaptureTelemetry.totalCreated += statusCounts.created || 0;
      flowCaptureTelemetry.totalDuplicate += statusCounts.duplicate || 0;
      flowCaptureTelemetry.totalRejected += statusCounts.rejected || 0;

      const resultByKey = new Map((uploadResponse.results || []).map((result) => [result.client_event_id, result]));
      // Re-read INSIDE the lock, not reused from the outer scope - see
      // background-freepik-capture.js's identical comment for why.
      const latestQueue = await readFlowCaptureQueue();
      const remaining = latestQueue.filter((item) => {
        if (!batchKeys.has(item.key)) return true;
        const result = resultByKey.get(item.key);
        // created/duplicate/rejected are all definitive backend responses -
        // none of them are retried. Only a whole-batch transport failure
        // (network error, 5xx) below is retryable.
        return !result;
      });
      await writeFlowCaptureQueue(remaining);
    } else {
      flowCaptureTelemetry.totalUploadFailures += 1;

      const latestQueue = await readFlowCaptureQueue();
      const errorMessage = `${uploadError?.message || uploadError || 'Flow capture upload failed'}`.slice(0, 500);
      const updated = [];
      for (const item of latestQueue) {
        if (!batchKeys.has(item.key)) {
          updated.push(item);
          continue;
        }
        const attempts = Number(item.attempts || 0) + 1;
        if (attempts > FLOW_CAPTURE_RETRY_MAX_ATTEMPTS) {
          flowCaptureTelemetry.totalDroppedForRetryCeiling += 1;
          continue;
        }
        updated.push({
          ...item,
          attempts,
          lastError: errorMessage,
          nextAttemptAt: now + getFlowCaptureRetryDelayMs(attempts),
        });
      }
      await writeFlowCaptureQueue(updated);
    }
  });

  const finalQueue = await readFlowCaptureQueue();
  const stillReady = finalQueue.some((item) => Number(item.nextAttemptAt || 0) <= Date.now());
  if (stillReady) {
    return runFlowCaptureFlush();
  }
  const nextDueAt = finalQueue.reduce((min, item) => Math.min(min, Number(item.nextAttemptAt || 0) || min), Number.POSITIVE_INFINITY);
  if (Number.isFinite(nextDueAt)) {
    scheduleFlowCaptureRetry(Math.max(5000, nextDueAt - Date.now()));
  }
  return { attempted: batch.length, remaining: finalQueue.length };
}

async function handleFlowCaptureEventMessage(message, senderTabId = 0, openerTabId = 0) {
  const event = message?.event;
  if (!event || typeof event !== 'object' || !event.event_type || !event.client_event_id) {
    return { ok: false, error: 'Invalid capture event payload' };
  }

  // Ticket attachment happens here (enqueue time), not at flush time - by
  // the time a batch actually uploads (possibly minutes later, after
  // retries), the originating tab may be closed and its launch record gone.
  const tabId = message.tabId || senderTabId || 0;
  const directLaunch = await getActiveLaunch(tabId, 'flow');
  const inheritedLaunch = directLaunch?.ticket ? null : await getActiveLaunch(openerTabId, 'flow');
  const activeLaunch = directLaunch || inheritedLaunch;

  const enrichedEvent = {
    ...event,
    extension_ticket: event.extension_ticket || activeLaunch?.ticket || undefined,
    usage_ticket: event.usage_ticket || activeLaunch?.usageTrackingTicket || undefined,
    tab_id: tabId || undefined,
  };

  await enqueueFlowCaptureEvent(enrichedEvent);
  return { ok: true, queued: true };
}

// Task Mapping: populates content-flow-task-modal.js's picker. Called from
// labs.google (a different origin than our dashboard), so identity is the
// same launch ticket every other Flow endpoint here uses - never a
// dashboard session cookie. Not queued/retried (unlike capture events): the
// generation is actively blocked waiting on this, so a failure must surface
// to the modal immediately as a "Retry" state, not silently retry later.
//
// tool_slug=flow is REQUIRED on both calls below - GET /api/tasks/my-active
// and GET /api/clients/active both default to Freepik's tool row when it's
// omitted (see utils/generation_gate.py::resolve_generation_gate_tool's own
// docstring: "Defaults to Freepik... when tool_slug is omitted"). Freepik's
// own extension code can skip sending it because it - relies on that exact
// default; Flow cannot, or a Flow ticket would be validated against
// Freepik's tool row and 403 instead of resolving correctly.
async function handleFlowFetchMyActiveTasksMessage(message, senderTabId = 0, openerTabId = 0) {
  const tabId = message?.tabId || senderTabId || 0;
  const directLaunch = await getActiveLaunch(tabId, 'flow');
  const inheritedLaunch = directLaunch?.ticket ? null : await getActiveLaunch(openerTabId, 'flow');
  const activeLaunch = directLaunch || inheritedLaunch;

  if (!activeLaunch?.ticket && !activeLaunch?.usageTrackingTicket) {
    return { ok: false, error: 'Launch Flow from the dashboard before task selection can run.', reason: 'session_expired' };
  }

  try {
    const settings = await getSettings();
    const params = new URLSearchParams();
    params.set('tool_slug', 'flow');
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

// Client Mapping - same ticket-based identity, same non-queued/immediate-
// failure posture as handleFlowFetchMyActiveTasksMessage above (and the
// same tool_slug=flow requirement - see that function's comment).
async function handleFlowFetchActiveClientsMessage(message, senderTabId = 0, openerTabId = 0) {
  const tabId = message?.tabId || senderTabId || 0;
  const directLaunch = await getActiveLaunch(tabId, 'flow');
  const inheritedLaunch = directLaunch?.ticket ? null : await getActiveLaunch(openerTabId, 'flow');
  const activeLaunch = directLaunch || inheritedLaunch;

  if (!activeLaunch?.ticket && !activeLaunch?.usageTrackingTicket) {
    return { ok: false, error: 'Launch Flow from the dashboard before client selection can run.', reason: 'session_expired' };
  }

  try {
    const settings = await getSettings();
    const params = new URLSearchParams();
    params.set('tool_slug', 'flow');
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
