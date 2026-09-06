// background-grammarly-docs-capture.js — loaded via importScripts() from
// background.js, before background-main.js (see manifest ordering there).
//
// Owns the Grammarly Docs raw-capture outbox: one shared queue for the whole
// browser, persisted to chrome.storage.local. Structurally a trimmed copy of
// background-splice-capture.js (same queue/retry/backoff machinery), minus
// everything that provider has that this one doesn't need yet:
//   - no CAPTURE_DOWNLOAD_MEDIA handler (no binary asset to push - a doc
//     session has no file)
//   - no capture-health ping/alarm (matches ElevenLabs/Suno's own posture -
//     "no health-check alarm ... only a retry-flush kick on startup" - see
//     background-main.js's identical comment on those two)
//   - no FETCH_MY_ACTIVE_TASKS/FETCH_ACTIVE_CLIENTS handlers (opening a doc
//     is not gated behind a Task/Client picker the way a download/generation
//     is - see backend providers/grammarly_docs/CAPTURE_CONTRACT.md)
//
// getSettings(), buildApiErrorMessage(), and getActiveLaunch() are defined
// in background-main.js and reused here as-is (all files run in the same
// classic service-worker global scope via importScripts, so no
// re-declaration or explicit import is needed - see every other capture
// file's identical comment).
//
// A recent real incident on this codebase: Suno's background handlers were
// built but never wired into background-main.js's message dispatch, leaving
// them unreachable dead code until caught, and separately, alarms were
// created for a provider but never listened for in onAlarm because only
// 2-of-3 wiring spots (onStartup/onInstalled/onAlarm) were updated. This
// file's GRAMMARLY_DOCS_CAPTURE_EVENT message type is wired into
// background-main.js's handleRuntimeMessage, and the retry alarm below is
// wired into ALL THREE of background-main.js's own
// onStartup/onInstalled/onAlarm listeners, as part of the same change that
// added this file - see that file's own GRAMMARLY_DOCS_* blocks.

const GRAMMARLY_DOCS_CAPTURE_QUEUE_STORAGE_KEY = 'pendingGrammarlyDocsCaptureEvents';
const GRAMMARLY_DOCS_CAPTURE_RETRY_ALARM = 'retryPendingGrammarlyDocsCaptureEvents';
const GRAMMARLY_DOCS_CAPTURE_BATCH_MAX = 200;
const GRAMMARLY_DOCS_CAPTURE_FLUSH_QUIET_MS = 500;
const GRAMMARLY_DOCS_CAPTURE_FLUSH_MAX_WAIT_MS = 2000;
const GRAMMARLY_DOCS_CAPTURE_FLUSH_EVENT_THRESHOLD = 50;
const GRAMMARLY_DOCS_CAPTURE_RETRY_MAX_ATTEMPTS = 12;
const GRAMMARLY_DOCS_CAPTURE_QUEUE_HARD_LIMIT = 3000;

const grammarlyDocsCaptureTelemetry = {
  totalEnqueued: 0,
  totalCreated: 0,
  totalDuplicate: 0,
  totalRejected: 0,
  totalUploadFailures: 0,
  totalDroppedForRetryCeiling: 0,
  totalDroppedForQueueCeiling: 0,
};

let grammarlyDocsCaptureQuietTimer = null;
let grammarlyDocsCaptureMaxWaitTimer = null;
let grammarlyDocsCaptureFlushInFlight = null;

function getGrammarlyDocsCaptureRetryDelayMs(attempts) {
  const baseMs = 30 * 1000;
  const exponent = Math.max(0, Math.min(Number(attempts || 0), 6));
  return Math.min(baseMs * Math.pow(2, exponent), 30 * 60 * 1000);
}

// Serializes every read-modify-write cycle against the shared
// chrome.storage.local queue key - see background-splice-capture.js's
// identical withSpliceQueueLock comment for the lost-update race this
// prevents.
let grammarlyDocsQueueChain = Promise.resolve();

function withGrammarlyDocsQueueLock(criticalSection) {
  const result = grammarlyDocsQueueChain.then(criticalSection, criticalSection);
  grammarlyDocsQueueChain = result.then(() => {}, () => {});
  return result;
}

async function readGrammarlyDocsCaptureQueue() {
  const stored = await chrome.storage.local.get([GRAMMARLY_DOCS_CAPTURE_QUEUE_STORAGE_KEY]);
  const queue = stored[GRAMMARLY_DOCS_CAPTURE_QUEUE_STORAGE_KEY];
  return Array.isArray(queue) ? queue.filter((item) => item && typeof item === 'object') : [];
}

async function writeGrammarlyDocsCaptureQueue(queue) {
  if (queue.length > GRAMMARLY_DOCS_CAPTURE_QUEUE_HARD_LIMIT) {
    const overflow = queue.length - GRAMMARLY_DOCS_CAPTURE_QUEUE_HARD_LIMIT;
    grammarlyDocsCaptureTelemetry.totalDroppedForQueueCeiling += overflow;
    console.error(
      '[RMW Grammarly Docs Capture] Queue exceeded hard ceiling - dropping oldest events to protect chrome.storage.local',
      { overflow, ceiling: GRAMMARLY_DOCS_CAPTURE_QUEUE_HARD_LIMIT }
    );
    queue = queue.slice(overflow);
  }
  await chrome.storage.local.set({ [GRAMMARLY_DOCS_CAPTURE_QUEUE_STORAGE_KEY]: queue });
  return queue;
}

function scheduleGrammarlyDocsCaptureRetry(delayMs = 60 * 1000) {
  try {
    if (chrome?.alarms?.create) {
      chrome.alarms.create(GRAMMARLY_DOCS_CAPTURE_RETRY_ALARM, { when: Date.now() + Math.max(5000, delayMs) });
      return;
    }
  } catch {}
  setTimeout(() => flushGrammarlyDocsCaptureQueue().catch(() => {}), Math.max(5000, delayMs));
}

function clearGrammarlyDocsCaptureFlushTimers() {
  if (grammarlyDocsCaptureQuietTimer) { clearTimeout(grammarlyDocsCaptureQuietTimer); grammarlyDocsCaptureQuietTimer = null; }
  if (grammarlyDocsCaptureMaxWaitTimer) { clearTimeout(grammarlyDocsCaptureMaxWaitTimer); grammarlyDocsCaptureMaxWaitTimer = null; }
}

function scheduleGrammarlyDocsCaptureFlush() {
  if (grammarlyDocsCaptureQuietTimer) clearTimeout(grammarlyDocsCaptureQuietTimer);
  grammarlyDocsCaptureQuietTimer = setTimeout(() => {
    grammarlyDocsCaptureQuietTimer = null;
    runGrammarlyDocsCaptureFlush();
  }, GRAMMARLY_DOCS_CAPTURE_FLUSH_QUIET_MS);

  if (!grammarlyDocsCaptureMaxWaitTimer) {
    grammarlyDocsCaptureMaxWaitTimer = setTimeout(() => {
      grammarlyDocsCaptureMaxWaitTimer = null;
      runGrammarlyDocsCaptureFlush();
    }, GRAMMARLY_DOCS_CAPTURE_FLUSH_MAX_WAIT_MS);
  }
}

function runGrammarlyDocsCaptureFlush() {
  clearGrammarlyDocsCaptureFlushTimers();
  grammarlyDocsCaptureFlushInFlight = flushGrammarlyDocsCaptureQueue()
    .catch((error) => {
      console.error('[RMW Grammarly Docs Capture] Flush failed unexpectedly', error);
    })
    .finally(() => {
      grammarlyDocsCaptureFlushInFlight = null;
    });
  return grammarlyDocsCaptureFlushInFlight;
}

async function enqueueGrammarlyDocsCaptureEvent(event) {
  let shouldFlushNow = false;
  let shouldScheduleFlush = false;

  await withGrammarlyDocsQueueLock(async () => {
    const now = Date.now();
    const queue = await readGrammarlyDocsCaptureQueue();

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
    await writeGrammarlyDocsCaptureQueue(queue);

    grammarlyDocsCaptureTelemetry.totalEnqueued += 1;

    const readyCount = queue.filter((item) => Number(item.nextAttemptAt || 0) <= now).length;
    if (readyCount >= GRAMMARLY_DOCS_CAPTURE_FLUSH_EVENT_THRESHOLD) {
      shouldFlushNow = true;
    } else {
      shouldScheduleFlush = true;
    }
  });

  if (shouldFlushNow) runGrammarlyDocsCaptureFlush();
  else if (shouldScheduleFlush) scheduleGrammarlyDocsCaptureFlush();
}

async function postGrammarlyDocsCaptureEventsBatch(settings, events) {
  const headers = { 'Content-Type': 'application/json' };
  if (settings.sessionToken) headers['X-Session-Id'] = settings.sessionToken;

  // Path segment is "grammarly-docs" - confirmed exactly against
  // providers/grammarly_docs/router.py's router prefix. A mismatch here
  // silently breaks capture with no visible error, exactly what happened
  // with Suno's event_type string previously.
  const response = await fetch(`${settings.apiBase}/api/providers/grammarly-docs/capture/events`, {
    method: 'POST',
    credentials: 'include',
    headers,
    body: JSON.stringify({ events }),
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.success) {
    const error = new Error(buildApiErrorMessage(data, response, 'Grammarly Docs capture upload failed', settings));
    error.status = response.status;
    throw error;
  }
  return data;
}

async function flushGrammarlyDocsCaptureQueue() {
  const now = Date.now();
  const queue = await readGrammarlyDocsCaptureQueue();
  if (!queue.length) return { attempted: 0, remaining: 0 };

  const readyItems = queue.filter((item) => Number(item.nextAttemptAt || 0) <= now);
  if (!readyItems.length) {
    const nextDueAt = queue.reduce((min, item) => Math.min(min, Number(item.nextAttemptAt || 0) || min), Number.POSITIVE_INFINITY);
    if (Number.isFinite(nextDueAt)) scheduleGrammarlyDocsCaptureRetry(Math.max(5000, nextDueAt - now));
    return { attempted: 0, remaining: queue.length };
  }

  const batch = readyItems.slice(0, GRAMMARLY_DOCS_CAPTURE_BATCH_MAX);
  const batchKeys = new Set(batch.map((item) => item.key));

  let uploadResponse = null;
  let uploadError = null;
  try {
    const settings = await getSettings();
    uploadResponse = await postGrammarlyDocsCaptureEventsBatch(settings, batch.map((item) => ({
      ...item.event,
      session_id: item.event.session_id || settings.sessionToken || undefined,
    })));
  } catch (error) {
    uploadError = error;
  }

  await withGrammarlyDocsQueueLock(async () => {
    if (uploadResponse) {
      const statusCounts = (uploadResponse.results || []).reduce((counts, result) => {
        counts[result.status] = (counts[result.status] || 0) + 1;
        return counts;
      }, {});
      grammarlyDocsCaptureTelemetry.totalCreated += statusCounts.created || 0;
      grammarlyDocsCaptureTelemetry.totalDuplicate += statusCounts.duplicate || 0;
      grammarlyDocsCaptureTelemetry.totalRejected += statusCounts.rejected || 0;

      const resultByKey = new Map((uploadResponse.results || []).map((result) => [result.client_event_id, result]));
      const latestQueue = await readGrammarlyDocsCaptureQueue();
      const remaining = latestQueue.filter((item) => {
        if (!batchKeys.has(item.key)) return true;
        const result = resultByKey.get(item.key);
        return !result;
      });
      await writeGrammarlyDocsCaptureQueue(remaining);
    } else {
      grammarlyDocsCaptureTelemetry.totalUploadFailures += 1;

      const latestQueue = await readGrammarlyDocsCaptureQueue();
      const errorMessage = `${uploadError?.message || uploadError || 'Grammarly Docs capture upload failed'}`.slice(0, 500);
      const updated = [];
      for (const item of latestQueue) {
        if (!batchKeys.has(item.key)) {
          updated.push(item);
          continue;
        }
        const attempts = Number(item.attempts || 0) + 1;
        if (attempts > GRAMMARLY_DOCS_CAPTURE_RETRY_MAX_ATTEMPTS) {
          grammarlyDocsCaptureTelemetry.totalDroppedForRetryCeiling += 1;
          continue;
        }
        updated.push({
          ...item,
          attempts,
          lastError: errorMessage,
          nextAttemptAt: now + getGrammarlyDocsCaptureRetryDelayMs(attempts),
        });
      }
      await writeGrammarlyDocsCaptureQueue(updated);
    }
  });

  const finalQueue = await readGrammarlyDocsCaptureQueue();
  const stillReady = finalQueue.some((item) => Number(item.nextAttemptAt || 0) <= Date.now());
  if (stillReady) {
    return runGrammarlyDocsCaptureFlush();
  }
  const nextDueAt = finalQueue.reduce((min, item) => Math.min(min, Number(item.nextAttemptAt || 0) || min), Number.POSITIVE_INFINITY);
  if (Number.isFinite(nextDueAt)) {
    scheduleGrammarlyDocsCaptureRetry(Math.max(5000, nextDueAt - Date.now()));
  }
  return { attempted: batch.length, remaining: finalQueue.length };
}

async function handleGrammarlyDocsCaptureEventMessage(message, senderTabId = 0, openerTabId = 0) {
  const event = message?.event;
  if (!event || typeof event !== 'object' || !event.event_type || !event.client_event_id) {
    return { ok: false, error: 'Invalid capture event payload' };
  }
  if (!event.session_key) {
    return { ok: false, error: 'Invalid capture event payload: session_key is required' };
  }

  const tabId = message.tabId || senderTabId || 0;
  const directLaunch = await getActiveLaunch(tabId, 'grammarly');
  const inheritedLaunch = directLaunch?.ticket ? null : await getActiveLaunch(openerTabId, 'grammarly');
  const activeLaunch = directLaunch || inheritedLaunch;

  const enrichedEvent = {
    ...event,
    extension_ticket: event.extension_ticket || activeLaunch?.ticket || undefined,
    usage_ticket: event.usage_ticket || activeLaunch?.usageTrackingTicket || undefined,
    tab_id: tabId || undefined,
  };

  await enqueueGrammarlyDocsCaptureEvent(enrichedEvent);
  return { ok: true, queued: true };
}

// Client Mapping - populates content-grammarly-docs-task-modal.js's picker,
// shown by content-grammarly-new-doc-gate.js before a new doc is created.
// Mirrors handleSpliceFetchActiveClientsMessage exactly (same non-queued/
// immediate-failure posture - the doc-creation click is actively blocked
// waiting on this) - see that function's own comments.
async function handleGrammarlyDocsFetchActiveClientsMessage(message, senderTabId = 0, openerTabId = 0) {
  const tabId = message?.tabId || senderTabId || 0;
  const directLaunch = await getActiveLaunch(tabId, 'grammarly');
  const inheritedLaunch = directLaunch?.ticket ? null : await getActiveLaunch(openerTabId, 'grammarly');
  const activeLaunch = directLaunch || inheritedLaunch;

  if (!activeLaunch?.ticket && !activeLaunch?.usageTrackingTicket) {
    return { ok: false, error: 'Launch Grammarly from the dashboard before client selection can run.', reason: 'session_expired' };
  }

  try {
    const settings = await getSettings();
    const params = new URLSearchParams();
    if (activeLaunch.usageTrackingTicket) params.set('usage_ticket', activeLaunch.usageTrackingTicket);
    if (activeLaunch.ticket) params.set('extension_ticket', activeLaunch.ticket);
    // Without this, resolve_generation_gate_tool (utils/generation_gate.py)
    // defaults to Freepik's ITPortalTool row - see the identical comment in
    // every other provider's own FETCH_ACTIVE_CLIENTS handler. "grammarly" is
    // the real seeded tool_slug (see content-grammarly.js's own TOOL_SLUG).
    params.set('tool_slug', 'grammarly');

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
