// background-suno-capture.js — loaded via importScripts() from
// background.js, before background-main.js (see manifest ordering there).
//
// Owns the Suno (suno.com) raw-capture outbox: one shared queue for the
// whole browser, persisted to chrome.storage.local so a crash or extension
// reload never loses a queued event before it's flushed. Structurally a
// direct copy of background-elevenlabs-capture.js (this file's template -
// see its own top comment for the full reasoning, itself copied from
// background-flow-capture.js), every ElevenLabs/ELEVENLABS/elevenlabs
// identifier renamed to Suno/SUNO/suno. Same BEST_EFFORT reliability class
// as Flow/Freepik/ElevenLabs (see backend/providers/suno/constants.py
// RELIABILITY_CLASS) - an event that still can't upload after
// SUNO_CAPTURE_RETRY_MAX_ATTEMPTS is dropped rather than retried forever.
// The reconciliation walker in content-suno-capture.js is this provider's
// backstop for anything lost this way, same role Envato's/ElevenLabs' walker
// plays for those providers.
//
// getSettings(), buildApiErrorMessage(), and getActiveLaunch() are defined
// in background-main.js and reused here as-is (all files run in the same
// classic service-worker global scope via importScripts, so no
// re-declaration or explicit import is needed).

const SUNO_CAPTURE_QUEUE_STORAGE_KEY = 'pendingSunoCaptureEvents';
const SUNO_CAPTURE_RETRY_ALARM = 'retryPendingSunoCaptureEvents';
const SUNO_CAPTURE_BATCH_MAX = 200;
const SUNO_CAPTURE_FLUSH_QUIET_MS = 500;
const SUNO_CAPTURE_FLUSH_MAX_WAIT_MS = 2000;
const SUNO_CAPTURE_FLUSH_EVENT_THRESHOLD = 50;
// BEST_EFFORT ceiling - see this file's own top comment for why dropping
// here is "degrade to unattributed", not "lose the row permanently"
// (identical reasoning to background-elevenlabs-capture.js's constant of the
// same name).
const SUNO_CAPTURE_RETRY_MAX_ATTEMPTS = 12;
// Safety valve, not a normal operating ceiling.
const SUNO_CAPTURE_QUEUE_HARD_LIMIT = 3000;

const sunoCaptureTelemetry = {
  totalEnqueued: 0,
  totalCreated: 0,
  totalDuplicate: 0,
  totalRejected: 0,
  totalUploadFailures: 0,
  totalDroppedForRetryCeiling: 0,
  totalDroppedForQueueCeiling: 0,
};

let sunoCaptureQuietTimer = null;
let sunoCaptureMaxWaitTimer = null;
let sunoCaptureFlushInFlight = null;

function getSunoCaptureRetryDelayMs(attempts) {
  const baseMs = 30 * 1000;
  const exponent = Math.max(0, Math.min(Number(attempts || 0), 6));
  return Math.min(baseMs * Math.pow(2, exponent), 30 * 60 * 1000);
}

// Serializes every read-modify-write cycle against the shared
// chrome.storage.local queue key - see background-flow-capture.js's
// withFlowQueueLock for the exact lost-update race this prevents (two
// near-simultaneous generations both reading the queue before either writes
// back, silently clobbering one).
let sunoQueueChain = Promise.resolve();

function withSunoQueueLock(criticalSection) {
  const result = sunoQueueChain.then(criticalSection, criticalSection);
  sunoQueueChain = result.then(() => {}, () => {});
  return result;
}

async function readSunoCaptureQueue() {
  const stored = await chrome.storage.local.get([SUNO_CAPTURE_QUEUE_STORAGE_KEY]);
  const queue = stored[SUNO_CAPTURE_QUEUE_STORAGE_KEY];
  return Array.isArray(queue) ? queue.filter((item) => item && typeof item === 'object') : [];
}

async function writeSunoCaptureQueue(queue) {
  if (queue.length > SUNO_CAPTURE_QUEUE_HARD_LIMIT) {
    const overflow = queue.length - SUNO_CAPTURE_QUEUE_HARD_LIMIT;
    sunoCaptureTelemetry.totalDroppedForQueueCeiling += overflow;
    console.error(
      '[RMW Suno Capture] Queue exceeded hard ceiling - dropping oldest events to protect chrome.storage.local',
      { overflow, ceiling: SUNO_CAPTURE_QUEUE_HARD_LIMIT }
    );
    queue = queue.slice(overflow);
  }
  await chrome.storage.local.set({ [SUNO_CAPTURE_QUEUE_STORAGE_KEY]: queue });
  return queue;
}

function scheduleSunoCaptureRetry(delayMs = 60 * 1000) {
  try {
    if (chrome?.alarms?.create) {
      chrome.alarms.create(SUNO_CAPTURE_RETRY_ALARM, { when: Date.now() + Math.max(5000, delayMs) });
      return;
    }
  } catch {}
  setTimeout(() => flushSunoCaptureQueue().catch(() => {}), Math.max(5000, delayMs));
}

function clearSunoCaptureFlushTimers() {
  if (sunoCaptureQuietTimer) { clearTimeout(sunoCaptureQuietTimer); sunoCaptureQuietTimer = null; }
  if (sunoCaptureMaxWaitTimer) { clearTimeout(sunoCaptureMaxWaitTimer); sunoCaptureMaxWaitTimer = null; }
}

function scheduleSunoCaptureFlush() {
  if (sunoCaptureQuietTimer) clearTimeout(sunoCaptureQuietTimer);
  sunoCaptureQuietTimer = setTimeout(() => {
    sunoCaptureQuietTimer = null;
    runSunoCaptureFlush();
  }, SUNO_CAPTURE_FLUSH_QUIET_MS);

  if (!sunoCaptureMaxWaitTimer) {
    sunoCaptureMaxWaitTimer = setTimeout(() => {
      sunoCaptureMaxWaitTimer = null;
      runSunoCaptureFlush();
    }, SUNO_CAPTURE_FLUSH_MAX_WAIT_MS);
  }
}

function runSunoCaptureFlush() {
  clearSunoCaptureFlushTimers();
  sunoCaptureFlushInFlight = flushSunoCaptureQueue()
    .catch((error) => {
      console.error('[RMW Suno Capture] Flush failed unexpectedly', error);
    })
    .finally(() => {
      sunoCaptureFlushInFlight = null;
    });
  return sunoCaptureFlushInFlight;
}

async function enqueueSunoCaptureEvent(event) {
  let shouldFlushNow = false;
  let shouldScheduleFlush = false;

  await withSunoQueueLock(async () => {
    const now = Date.now();
    const queue = await readSunoCaptureQueue();

    // A still-settling row can generate the SAME client_event_id across a
    // couple of near-simultaneous captures (see content-suno-capture.js's
    // changeToken comment) - without this check those would pile up as
    // separate queue entries before the first even flushes. The server would
    // collapse them to 1 created + N duplicates anyway - pure local waste,
    // not a correctness issue, but worth avoiding.
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
    await writeSunoCaptureQueue(queue);

    sunoCaptureTelemetry.totalEnqueued += 1;

    const readyCount = queue.filter((item) => Number(item.nextAttemptAt || 0) <= now).length;
    if (readyCount >= SUNO_CAPTURE_FLUSH_EVENT_THRESHOLD) {
      shouldFlushNow = true;
    } else {
      shouldScheduleFlush = true;
    }
  });

  // Triggering the flush itself happens OUTSIDE the lock - see
  // background-flow-capture.js's identical comment for why (the flush's
  // slow network POST must never be awaited while holding this lock).
  if (shouldFlushNow) runSunoCaptureFlush();
  else if (shouldScheduleFlush) scheduleSunoCaptureFlush();
}

async function postSunoCaptureEventsBatch(settings, events) {
  const headers = { 'Content-Type': 'application/json' };
  if (settings.sessionToken) headers['X-Session-Id'] = settings.sessionToken;

  const response = await fetch(`${settings.apiBase}/api/providers/suno/capture/events`, {
    method: 'POST',
    credentials: 'include',
    headers,
    body: JSON.stringify({ events }),
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.success) {
    const error = new Error(buildApiErrorMessage(data, response, 'Suno capture upload failed', settings));
    error.status = response.status;
    throw error;
  }
  return data;
}

async function flushSunoCaptureQueue() {
  const now = Date.now();
  const queue = await readSunoCaptureQueue();
  if (!queue.length) return { attempted: 0, remaining: 0 };

  const readyItems = queue.filter((item) => Number(item.nextAttemptAt || 0) <= now);
  if (!readyItems.length) {
    const nextDueAt = queue.reduce((min, item) => Math.min(min, Number(item.nextAttemptAt || 0) || min), Number.POSITIVE_INFINITY);
    if (Number.isFinite(nextDueAt)) scheduleSunoCaptureRetry(Math.max(5000, nextDueAt - now));
    return { attempted: 0, remaining: queue.length };
  }

  const batch = readyItems.slice(0, SUNO_CAPTURE_BATCH_MAX);
  const batchKeys = new Set(batch.map((item) => item.key));

  // The network POST deliberately happens OUTSIDE withSunoQueueLock - see
  // background-flow-capture.js's identical comment for why.
  let uploadResponse = null;
  let uploadError = null;
  try {
    const settings = await getSettings();
    uploadResponse = await postSunoCaptureEventsBatch(settings, batch.map((item) => ({
      ...item.event,
      session_id: item.event.session_id || settings.sessionToken || undefined,
    })));
  } catch (error) {
    uploadError = error;
  }

  await withSunoQueueLock(async () => {
    if (uploadResponse) {
      const statusCounts = (uploadResponse.results || []).reduce((counts, result) => {
        counts[result.status] = (counts[result.status] || 0) + 1;
        return counts;
      }, {});
      sunoCaptureTelemetry.totalCreated += statusCounts.created || 0;
      sunoCaptureTelemetry.totalDuplicate += statusCounts.duplicate || 0;
      sunoCaptureTelemetry.totalRejected += statusCounts.rejected || 0;

      const resultByKey = new Map((uploadResponse.results || []).map((result) => [result.client_event_id, result]));
      // Re-read INSIDE the lock, not reused from the outer scope - see
      // background-flow-capture.js's identical comment for why.
      const latestQueue = await readSunoCaptureQueue();
      const remaining = latestQueue.filter((item) => {
        if (!batchKeys.has(item.key)) return true;
        const result = resultByKey.get(item.key);
        // created/duplicate/rejected are all definitive backend responses -
        // none of them are retried. Only a whole-batch transport failure
        // (network error, 5xx) below is retryable.
        return !result;
      });
      await writeSunoCaptureQueue(remaining);
    } else {
      sunoCaptureTelemetry.totalUploadFailures += 1;

      const latestQueue = await readSunoCaptureQueue();
      const errorMessage = `${uploadError?.message || uploadError || 'Suno capture upload failed'}`.slice(0, 500);
      const updated = [];
      for (const item of latestQueue) {
        if (!batchKeys.has(item.key)) {
          updated.push(item);
          continue;
        }
        const attempts = Number(item.attempts || 0) + 1;
        if (attempts > SUNO_CAPTURE_RETRY_MAX_ATTEMPTS) {
          sunoCaptureTelemetry.totalDroppedForRetryCeiling += 1;
          continue;
        }
        updated.push({
          ...item,
          attempts,
          lastError: errorMessage,
          nextAttemptAt: now + getSunoCaptureRetryDelayMs(attempts),
        });
      }
      await writeSunoCaptureQueue(updated);
    }
  });

  const finalQueue = await readSunoCaptureQueue();
  const stillReady = finalQueue.some((item) => Number(item.nextAttemptAt || 0) <= Date.now());
  if (stillReady) {
    return runSunoCaptureFlush();
  }
  const nextDueAt = finalQueue.reduce((min, item) => Math.min(min, Number(item.nextAttemptAt || 0) || min), Number.POSITIVE_INFINITY);
  if (Number.isFinite(nextDueAt)) {
    scheduleSunoCaptureRetry(Math.max(5000, nextDueAt - Date.now()));
  }
  return { attempted: batch.length, remaining: finalQueue.length };
}

async function handleSunoCaptureEventMessage(message, senderTabId = 0, openerTabId = 0) {
  const event = message?.event;
  if (!event || typeof event !== 'object' || !event.event_type || !event.client_event_id) {
    return { ok: false, error: 'Invalid capture event payload' };
  }

  // Ticket attachment happens here (enqueue time), not at flush time - by
  // the time a batch actually uploads (possibly minutes later, after
  // retries), the originating tab may be closed and its launch record gone.
  const tabId = message.tabId || senderTabId || 0;
  const directLaunch = await getActiveLaunch(tabId, 'suno');
  const inheritedLaunch = directLaunch?.ticket ? null : await getActiveLaunch(openerTabId, 'suno');
  const activeLaunch = directLaunch || inheritedLaunch;

  const enrichedEvent = {
    ...event,
    extension_ticket: event.extension_ticket || activeLaunch?.ticket || undefined,
    usage_ticket: event.usage_ticket || activeLaunch?.usageTrackingTicket || undefined,
    tab_id: tabId || undefined,
  };

  await enqueueSunoCaptureEvent(enrichedEvent);
  return { ok: true, queued: true };
}

// Audio asset push - see content-suno-network.js's "AUDIO DELIVERY" comment
// and providers/suno/router.py's POST /capture/audio for the full reasoning.
// Unlike ElevenLabs (history row carries no downloadable audio URL at all,
// audio requires the browser's own authenticated session), Suno's row
// carries its own audio_url/media_urls once ready, and the proactive fetch
// in content-suno-capture.js appears to need no browser-session auth to
// retrieve it (best-effort, unconfirmed) - but the shape of this push is
// otherwise identical: the browser pushes bytes it already legitimately
// received, rather than the backend trying (and failing, or needlessly
// duplicating the browser's own fetch) to pull them independently.
//
// Deliberately NOT routed through the durable outbox queue above: audio
// payloads are large (a base64-encoded clip, potentially several MB), no
// ticket/ownership resolution is needed (the backend looks the row up by
// clip id alone), and a miss here is self-healing - the exact same clip gets
// re-observed and re-pushed on the next reconciliation walk, so persisting/
// retrying it in chrome.storage.local would add complexity for no real
// reliability gain. Mirrors handleElevenlabsCaptureAudioMessage's identical
// posture.
async function handleSunoCaptureAudioMessage(message) {
  const clipId = `${message?.clipId || ''}`.trim();
  const audioBase64 = message?.audioBase64;
  if (!clipId || !audioBase64) {
    return { ok: false, error: 'Invalid audio capture payload' };
  }

  try {
    const settings = await getSettings();
    const headers = { 'Content-Type': 'application/json' };
    if (settings.sessionToken) headers['X-Session-Id'] = settings.sessionToken;

    const response = await fetch(`${settings.apiBase}/api/providers/suno/capture/audio`, {
      method: 'POST',
      credentials: 'include',
      headers,
      body: JSON.stringify({
        clip_id: clipId,
        content_type: message.contentType || 'audio/mpeg',
        audio_base64: audioBase64,
      }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      return { ok: false, error: buildApiErrorMessage(data, response, 'Suno audio push failed', settings) };
    }
    // Same "success is a JSON field, not the HTTP status" convention as
    // handleElevenlabsCaptureAudioMessage - see that function's own comment
    // for the incident this posture prevents (a generation_not_found result
    // silently reported back as a full success, permanently eating a
    // race-losing capture with no retry ever scheduled).
    if (data.success) {
      return { ok: true, status: data.status };
    }
    return { ok: false, status: data.status, error: data.status || 'Suno audio push not applied' };
  } catch (error) {
    return { ok: false, error: error?.message || 'Suno audio push failed' };
  }
}

// Task Mapping: populates content-suno-task-modal.js's picker. Called from
// suno.com (a different origin than our dashboard), so identity is the same
// launch ticket every other Suno endpoint here uses - never a dashboard
// session cookie. Not queued/retried (unlike capture events): the
// generation is actively blocked waiting on this, so a failure must surface
// to the modal immediately as a "Retry" state, not silently retry later.
//
// tool_slug=suno is REQUIRED on both calls below - GET /api/tasks/my-active
// and GET /api/clients/active both default to the wrong tool row when it's
// omitted (see utils/generation_gate.py::resolve_generation_gate_tool's own
// docstring, and content-elevenlabs-task-api.js's/content-flow-task-api.js's
// identical requirement - this is a documented past bug class, not a
// hypothetical one).
async function handleSunoFetchMyActiveTasksMessage(message, senderTabId = 0, openerTabId = 0) {
  const tabId = message?.tabId || senderTabId || 0;
  const directLaunch = await getActiveLaunch(tabId, 'suno');
  const inheritedLaunch = directLaunch?.ticket ? null : await getActiveLaunch(openerTabId, 'suno');
  const activeLaunch = directLaunch || inheritedLaunch;

  if (!activeLaunch?.ticket && !activeLaunch?.usageTrackingTicket) {
    return { ok: false, error: 'Launch Suno from the dashboard before task selection can run.', reason: 'session_expired' };
  }

  try {
    const settings = await getSettings();
    const params = new URLSearchParams();
    params.set('tool_slug', 'suno');
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
// failure posture as handleSunoFetchMyActiveTasksMessage above (and the same
// tool_slug=suno requirement - see that function's comment).
async function handleSunoFetchActiveClientsMessage(message, senderTabId = 0, openerTabId = 0) {
  const tabId = message?.tabId || senderTabId || 0;
  const directLaunch = await getActiveLaunch(tabId, 'suno');
  const inheritedLaunch = directLaunch?.ticket ? null : await getActiveLaunch(openerTabId, 'suno');
  const activeLaunch = directLaunch || inheritedLaunch;

  if (!activeLaunch?.ticket && !activeLaunch?.usageTrackingTicket) {
    return { ok: false, error: 'Launch Suno from the dashboard before client selection can run.', reason: 'session_expired' };
  }

  try {
    const settings = await getSettings();
    const params = new URLSearchParams();
    params.set('tool_slug', 'suno');
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
