// background-elevenlabs-capture.js — loaded via importScripts() from
// background.js, before background-main.js (see manifest ordering there).
//
// Owns the ElevenLabs (elevenlabs.io) raw-capture outbox: one shared queue
// for the whole browser, persisted to chrome.storage.local so a crash or
// extension reload never loses a queued event before it's flushed.
// Structurally a direct copy of background-flow-capture.js (this file's
// template - see its own top comment for the full reasoning), every
// Flow/FLOW/flow identifier renamed to Elevenlabs/ELEVENLABS/elevenlabs.
// Same BEST_EFFORT reliability class as Flow/Freepik (see
// backend/providers/elevenlabs/constants.py RELIABILITY_CLASS) - an event
// that still can't upload after ELEVENLABS_CAPTURE_RETRY_MAX_ATTEMPTS is
// dropped rather than retried forever. The reconciliation walker in
// content-elevenlabs-capture.js is this provider's backstop for anything
// lost this way, same role Envato's walker plays for Envato.
//
// getSettings(), buildApiErrorMessage(), and getActiveLaunch() are defined
// in background-main.js and reused here as-is (all files run in the same
// classic service-worker global scope via importScripts, so no
// re-declaration or explicit import is needed).

const ELEVENLABS_CAPTURE_QUEUE_STORAGE_KEY = 'pendingElevenlabsCaptureEvents';
const ELEVENLABS_CAPTURE_RETRY_ALARM = 'retryPendingElevenlabsCaptureEvents';
const ELEVENLABS_CAPTURE_BATCH_MAX = 200;
const ELEVENLABS_CAPTURE_FLUSH_QUIET_MS = 500;
const ELEVENLABS_CAPTURE_FLUSH_MAX_WAIT_MS = 2000;
const ELEVENLABS_CAPTURE_FLUSH_EVENT_THRESHOLD = 50;
// BEST_EFFORT ceiling - see this file's own top comment for why dropping
// here is "degrade to unattributed", not "lose the row permanently"
// (identical reasoning to background-flow-capture.js's constant of the same
// name).
const ELEVENLABS_CAPTURE_RETRY_MAX_ATTEMPTS = 12;
// Safety valve, not a normal operating ceiling.
const ELEVENLABS_CAPTURE_QUEUE_HARD_LIMIT = 3000;

const elevenlabsCaptureTelemetry = {
  totalEnqueued: 0,
  totalCreated: 0,
  totalDuplicate: 0,
  totalRejected: 0,
  totalUploadFailures: 0,
  totalDroppedForRetryCeiling: 0,
  totalDroppedForQueueCeiling: 0,
};

let elevenlabsCaptureQuietTimer = null;
let elevenlabsCaptureMaxWaitTimer = null;
let elevenlabsCaptureFlushInFlight = null;

function getElevenlabsCaptureRetryDelayMs(attempts) {
  const baseMs = 30 * 1000;
  const exponent = Math.max(0, Math.min(Number(attempts || 0), 6));
  return Math.min(baseMs * Math.pow(2, exponent), 30 * 60 * 1000);
}

// Serializes every read-modify-write cycle against the shared
// chrome.storage.local queue key - see background-flow-capture.js's
// withFlowQueueLock for the exact lost-update race this prevents (two
// near-simultaneous generations both reading the queue before either writes
// back, silently clobbering one).
let elevenlabsQueueChain = Promise.resolve();

function withElevenlabsQueueLock(criticalSection) {
  const result = elevenlabsQueueChain.then(criticalSection, criticalSection);
  elevenlabsQueueChain = result.then(() => {}, () => {});
  return result;
}

async function readElevenlabsCaptureQueue() {
  const stored = await chrome.storage.local.get([ELEVENLABS_CAPTURE_QUEUE_STORAGE_KEY]);
  const queue = stored[ELEVENLABS_CAPTURE_QUEUE_STORAGE_KEY];
  return Array.isArray(queue) ? queue.filter((item) => item && typeof item === 'object') : [];
}

async function writeElevenlabsCaptureQueue(queue) {
  if (queue.length > ELEVENLABS_CAPTURE_QUEUE_HARD_LIMIT) {
    const overflow = queue.length - ELEVENLABS_CAPTURE_QUEUE_HARD_LIMIT;
    elevenlabsCaptureTelemetry.totalDroppedForQueueCeiling += overflow;
    console.error(
      '[RMW ElevenLabs Capture] Queue exceeded hard ceiling - dropping oldest events to protect chrome.storage.local',
      { overflow, ceiling: ELEVENLABS_CAPTURE_QUEUE_HARD_LIMIT }
    );
    queue = queue.slice(overflow);
  }
  await chrome.storage.local.set({ [ELEVENLABS_CAPTURE_QUEUE_STORAGE_KEY]: queue });
  return queue;
}

function scheduleElevenlabsCaptureRetry(delayMs = 60 * 1000) {
  try {
    if (chrome?.alarms?.create) {
      chrome.alarms.create(ELEVENLABS_CAPTURE_RETRY_ALARM, { when: Date.now() + Math.max(5000, delayMs) });
      return;
    }
  } catch {}
  setTimeout(() => flushElevenlabsCaptureQueue().catch(() => {}), Math.max(5000, delayMs));
}

function clearElevenlabsCaptureFlushTimers() {
  if (elevenlabsCaptureQuietTimer) { clearTimeout(elevenlabsCaptureQuietTimer); elevenlabsCaptureQuietTimer = null; }
  if (elevenlabsCaptureMaxWaitTimer) { clearTimeout(elevenlabsCaptureMaxWaitTimer); elevenlabsCaptureMaxWaitTimer = null; }
}

function scheduleElevenlabsCaptureFlush() {
  if (elevenlabsCaptureQuietTimer) clearTimeout(elevenlabsCaptureQuietTimer);
  elevenlabsCaptureQuietTimer = setTimeout(() => {
    elevenlabsCaptureQuietTimer = null;
    runElevenlabsCaptureFlush();
  }, ELEVENLABS_CAPTURE_FLUSH_QUIET_MS);

  if (!elevenlabsCaptureMaxWaitTimer) {
    elevenlabsCaptureMaxWaitTimer = setTimeout(() => {
      elevenlabsCaptureMaxWaitTimer = null;
      runElevenlabsCaptureFlush();
    }, ELEVENLABS_CAPTURE_FLUSH_MAX_WAIT_MS);
  }
}

function runElevenlabsCaptureFlush() {
  clearElevenlabsCaptureFlushTimers();
  elevenlabsCaptureFlushInFlight = flushElevenlabsCaptureQueue()
    .catch((error) => {
      console.error('[RMW ElevenLabs Capture] Flush failed unexpectedly', error);
    })
    .finally(() => {
      elevenlabsCaptureFlushInFlight = null;
    });
  return elevenlabsCaptureFlushInFlight;
}

async function enqueueElevenlabsCaptureEvent(event) {
  let shouldFlushNow = false;
  let shouldScheduleFlush = false;

  await withElevenlabsQueueLock(async () => {
    const now = Date.now();
    const queue = await readElevenlabsCaptureQueue();

    // A still-settling row can generate the SAME client_event_id across a
    // couple of near-simultaneous captures (see content-elevenlabs-
    // capture.js's changeToken comment) - without this check those would
    // pile up as separate queue entries before the first even flushes. The
    // server would collapse them to 1 created + N duplicates anyway - pure
    // local waste, not a correctness issue, but worth avoiding.
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
    await writeElevenlabsCaptureQueue(queue);

    elevenlabsCaptureTelemetry.totalEnqueued += 1;

    const readyCount = queue.filter((item) => Number(item.nextAttemptAt || 0) <= now).length;
    if (readyCount >= ELEVENLABS_CAPTURE_FLUSH_EVENT_THRESHOLD) {
      shouldFlushNow = true;
    } else {
      shouldScheduleFlush = true;
    }
  });

  // Triggering the flush itself happens OUTSIDE the lock - see
  // background-flow-capture.js's identical comment for why (the flush's
  // slow network POST must never be awaited while holding this lock).
  if (shouldFlushNow) runElevenlabsCaptureFlush();
  else if (shouldScheduleFlush) scheduleElevenlabsCaptureFlush();
}

async function postElevenlabsCaptureEventsBatch(settings, events) {
  const headers = { 'Content-Type': 'application/json' };
  if (settings.sessionToken) headers['X-Session-Id'] = settings.sessionToken;

  const response = await fetch(`${settings.apiBase}/api/providers/elevenlabs/capture/events`, {
    method: 'POST',
    credentials: 'include',
    headers,
    body: JSON.stringify({ events }),
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.success) {
    const error = new Error(buildApiErrorMessage(data, response, 'ElevenLabs capture upload failed', settings));
    error.status = response.status;
    throw error;
  }
  return data;
}

async function flushElevenlabsCaptureQueue() {
  const now = Date.now();
  const queue = await readElevenlabsCaptureQueue();
  if (!queue.length) return { attempted: 0, remaining: 0 };

  const readyItems = queue.filter((item) => Number(item.nextAttemptAt || 0) <= now);
  if (!readyItems.length) {
    const nextDueAt = queue.reduce((min, item) => Math.min(min, Number(item.nextAttemptAt || 0) || min), Number.POSITIVE_INFINITY);
    if (Number.isFinite(nextDueAt)) scheduleElevenlabsCaptureRetry(Math.max(5000, nextDueAt - now));
    return { attempted: 0, remaining: queue.length };
  }

  const batch = readyItems.slice(0, ELEVENLABS_CAPTURE_BATCH_MAX);
  const batchKeys = new Set(batch.map((item) => item.key));

  // The network POST deliberately happens OUTSIDE withElevenlabsQueueLock -
  // see background-flow-capture.js's identical comment for why.
  let uploadResponse = null;
  let uploadError = null;
  try {
    const settings = await getSettings();
    uploadResponse = await postElevenlabsCaptureEventsBatch(settings, batch.map((item) => ({
      ...item.event,
      session_id: item.event.session_id || settings.sessionToken || undefined,
    })));
  } catch (error) {
    uploadError = error;
  }

  await withElevenlabsQueueLock(async () => {
    if (uploadResponse) {
      const statusCounts = (uploadResponse.results || []).reduce((counts, result) => {
        counts[result.status] = (counts[result.status] || 0) + 1;
        return counts;
      }, {});
      elevenlabsCaptureTelemetry.totalCreated += statusCounts.created || 0;
      elevenlabsCaptureTelemetry.totalDuplicate += statusCounts.duplicate || 0;
      elevenlabsCaptureTelemetry.totalRejected += statusCounts.rejected || 0;

      const resultByKey = new Map((uploadResponse.results || []).map((result) => [result.client_event_id, result]));
      // Re-read INSIDE the lock, not reused from the outer scope - see
      // background-flow-capture.js's identical comment for why.
      const latestQueue = await readElevenlabsCaptureQueue();
      const remaining = latestQueue.filter((item) => {
        if (!batchKeys.has(item.key)) return true;
        const result = resultByKey.get(item.key);
        // created/duplicate/rejected are all definitive backend responses -
        // none of them are retried. Only a whole-batch transport failure
        // (network error, 5xx) below is retryable.
        return !result;
      });
      await writeElevenlabsCaptureQueue(remaining);
    } else {
      elevenlabsCaptureTelemetry.totalUploadFailures += 1;

      const latestQueue = await readElevenlabsCaptureQueue();
      const errorMessage = `${uploadError?.message || uploadError || 'ElevenLabs capture upload failed'}`.slice(0, 500);
      const updated = [];
      for (const item of latestQueue) {
        if (!batchKeys.has(item.key)) {
          updated.push(item);
          continue;
        }
        const attempts = Number(item.attempts || 0) + 1;
        if (attempts > ELEVENLABS_CAPTURE_RETRY_MAX_ATTEMPTS) {
          elevenlabsCaptureTelemetry.totalDroppedForRetryCeiling += 1;
          continue;
        }
        updated.push({
          ...item,
          attempts,
          lastError: errorMessage,
          nextAttemptAt: now + getElevenlabsCaptureRetryDelayMs(attempts),
        });
      }
      await writeElevenlabsCaptureQueue(updated);
    }
  });

  const finalQueue = await readElevenlabsCaptureQueue();
  const stillReady = finalQueue.some((item) => Number(item.nextAttemptAt || 0) <= Date.now());
  if (stillReady) {
    return runElevenlabsCaptureFlush();
  }
  const nextDueAt = finalQueue.reduce((min, item) => Math.min(min, Number(item.nextAttemptAt || 0) || min), Number.POSITIVE_INFINITY);
  if (Number.isFinite(nextDueAt)) {
    scheduleElevenlabsCaptureRetry(Math.max(5000, nextDueAt - Date.now()));
  }
  return { attempted: batch.length, remaining: finalQueue.length };
}

async function handleElevenlabsCaptureEventMessage(message, senderTabId = 0, openerTabId = 0) {
  const event = message?.event;
  if (!event || typeof event !== 'object' || !event.event_type || !event.client_event_id) {
    return { ok: false, error: 'Invalid capture event payload' };
  }

  // Ticket attachment happens here (enqueue time), not at flush time - by
  // the time a batch actually uploads (possibly minutes later, after
  // retries), the originating tab may be closed and its launch record gone.
  const tabId = message.tabId || senderTabId || 0;
  const directLaunch = await getActiveLaunch(tabId, 'elevenlabs');
  const inheritedLaunch = directLaunch?.ticket ? null : await getActiveLaunch(openerTabId, 'elevenlabs');
  const activeLaunch = directLaunch || inheritedLaunch;

  const enrichedEvent = {
    ...event,
    extension_ticket: event.extension_ticket || activeLaunch?.ticket || undefined,
    usage_ticket: event.usage_ticket || activeLaunch?.usageTrackingTicket || undefined,
    tab_id: tabId || undefined,
  };

  await enqueueElevenlabsCaptureEvent(enrichedEvent);
  return { ok: true, queued: true };
}

// Audio asset push - see content-elevenlabs-network.js's "AUDIO DELIVERY"
// comment and providers/elevenlabs/router.py's POST /capture/audio for the
// full reasoning: ElevenLabs' history row carries no downloadable audio URL,
// the real audio endpoint requires the browser's own session, so the
// backend can never pull it independently (unlike Freepik/HeyGen's signed-
// URL asset_mirror.py sweep) - the browser has to push the bytes it already
// legitimately received instead.
//
// Deliberately NOT routed through the durable outbox queue above: audio
// payloads are large (a base64-encoded clip, potentially several MB), no
// ticket/ownership resolution is needed (the backend looks the row up by
// history_item_id alone), and a miss here is self-healing - the exact same
// clip gets re-observed and re-pushed every time it's played/downloaded
// again, so persisting/retrying it in chrome.storage.local would add
// complexity for no real reliability gain. Mirrors the same
// "best-effort, fire-and-forget, never queued" posture
// handleFreepikSyncProgressMessage already uses for its own non-critical,
// naturally-repeating signal.
async function handleElevenlabsCaptureAudioMessage(message) {
  const historyItemId = `${message?.historyItemId || ''}`.trim();
  const audioBase64 = message?.audioBase64;
  if (!historyItemId || !audioBase64) {
    return { ok: false, error: 'Invalid audio capture payload' };
  }

  try {
    const settings = await getSettings();
    const headers = { 'Content-Type': 'application/json' };
    if (settings.sessionToken) headers['X-Session-Id'] = settings.sessionToken;

    const response = await fetch(`${settings.apiBase}/api/providers/elevenlabs/capture/audio`, {
      method: 'POST',
      credentials: 'include',
      headers,
      body: JSON.stringify({
        history_item_id: historyItemId,
        content_type: message.contentType || 'audio/mpeg',
        audio_base64: audioBase64,
        is_download: Boolean(message.isDownload),
      }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      return { ok: false, error: buildApiErrorMessage(data, response, 'ElevenLabs audio push failed', settings) };
    }
    // Reported bug, root-caused 2026-08-13: POST /capture/audio deliberately
    // returns HTTP 200 for every SOFT/business-logic outcome, including
    // "generation_not_found" (see CaptureAudioResult in
    // providers/elevenlabs/router.py - `success` is a JSON field, not an
    // HTTP status) - only a real transport/server error is a non-2xx. This
    // function used to map `response.ok` straight to `{ok: true}` without
    // checking `data.success` at all, so a `generation_not_found` result
    // (the exact race condition reportElevenlabsAudioCapture's retry logic
    // exists to handle) was reported back as a full success. Since that
    // retry logic is gated behind `if (result?.ok) { ...; return; }`, the
    // retry branch never ran even once - the very first attempt, win or
    // lose, always looked like a win, permanently eating every race-losing
    // capture with no retry ever scheduled. Confirmed live: two generations
    // in a row got stuck at asset_mirror_status="pending" forever this way.
    // Fixed: `ok` now reflects `data.success`, not just the HTTP status.
    if (data.success) {
      return { ok: true, status: data.status };
    }
    return { ok: false, status: data.status, error: data.status || 'ElevenLabs audio push not applied' };
  } catch (error) {
    return { ok: false, error: error?.message || 'ElevenLabs audio push failed' };
  }
}

// Task Mapping: populates content-elevenlabs-task-modal.js's picker. Called
// from elevenlabs.io (a different origin than our dashboard), so identity is
// the same launch ticket every other ElevenLabs endpoint here uses - never a
// dashboard session cookie. Not queued/retried (unlike capture events): the
// generation is actively blocked waiting on this, so a failure must surface
// to the modal immediately as a "Retry" state, not silently retry later.
//
// tool_slug=elevenlabs is REQUIRED on both calls below - GET
// /api/tasks/my-active and GET /api/clients/active both default to the
// wrong tool row when it's omitted (see utils/generation_gate.py::
// resolve_generation_gate_tool's own docstring, and content-flow-task-
// api.js's identical requirement for Flow - this is a documented past bug
// class, not a hypothetical one). Flow's own extension code sets
// tool_slug=flow explicitly for the exact same reason; ElevenLabs' version
// must do the same rather than relying on any default.
async function handleElevenlabsFetchMyActiveTasksMessage(message, senderTabId = 0, openerTabId = 0) {
  const tabId = message?.tabId || senderTabId || 0;
  const directLaunch = await getActiveLaunch(tabId, 'elevenlabs');
  const inheritedLaunch = directLaunch?.ticket ? null : await getActiveLaunch(openerTabId, 'elevenlabs');
  const activeLaunch = directLaunch || inheritedLaunch;

  if (!activeLaunch?.ticket && !activeLaunch?.usageTrackingTicket) {
    return { ok: false, error: 'Launch ElevenLabs from the dashboard before task selection can run.', reason: 'session_expired' };
  }

  try {
    const settings = await getSettings();
    const params = new URLSearchParams();
    params.set('tool_slug', 'elevenlabs');
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
// failure posture as handleElevenlabsFetchMyActiveTasksMessage above (and
// the same tool_slug=elevenlabs requirement - see that function's comment).
async function handleElevenlabsFetchActiveClientsMessage(message, senderTabId = 0, openerTabId = 0) {
  const tabId = message?.tabId || senderTabId || 0;
  const directLaunch = await getActiveLaunch(tabId, 'elevenlabs');
  const inheritedLaunch = directLaunch?.ticket ? null : await getActiveLaunch(openerTabId, 'elevenlabs');
  const activeLaunch = directLaunch || inheritedLaunch;

  if (!activeLaunch?.ticket && !activeLaunch?.usageTrackingTicket) {
    return { ok: false, error: 'Launch ElevenLabs from the dashboard before client selection can run.', reason: 'session_expired' };
  }

  try {
    const settings = await getSettings();
    const params = new URLSearchParams();
    params.set('tool_slug', 'elevenlabs');
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
