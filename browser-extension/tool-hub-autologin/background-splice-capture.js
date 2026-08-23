// background-splice-capture.js — loaded via importScripts() from
// background.js, before background-main.js (see manifest ordering there).
//
// Owns the Splice raw-capture outbox: one shared queue for the whole
// browser, persisted to chrome.storage.local. Structurally a direct copy of
// background-epidemicsound-capture.js (this file's template, per the
// explicit build instructions), every EpidemicSound/EPIDEMIC/epidemic
// identifier renamed to Splice/SPLICE/splice. Same retry-backoff formula,
// chrome.alarms wake-up pattern, and BEST_EFFORT posture.
//
// Unlike Epidemic Sound, there is no Adapt-equivalent second capture
// surface here - Splice is download-only - so there is no
// SPLICE_CAPTURE_ADAPTATION_MEDIA handler/endpoint, only the download-media
// one.
//
// getSettings(), buildApiErrorMessage(), and getActiveLaunch() are defined
// in background-main.js and reused here as-is (all files run in the same
// classic service-worker global scope via importScripts, so no
// re-declaration or explicit import is needed - see
// background-epidemicsound-capture.js's identical comment).
//
// A recent real incident on this codebase: Suno's background handlers were
// built but never wired into background-main.js's message dispatch, leaving
// them unreachable dead code until caught, and separately, alarms were
// created for a provider but never listened for in onAlarm because only
// 2-of-3 wiring spots (onStartup/onInstalled/onAlarm) were updated. The four
// SPLICE_* message types this file's handlers respond to
// (SPLICE_CAPTURE_EVENT, SPLICE_CAPTURE_DOWNLOAD_MEDIA,
// SPLICE_FETCH_MY_ACTIVE_TASKS, SPLICE_FETCH_ACTIVE_CLIENTS) are wired into
// background-main.js's handleRuntimeMessage, and the retry/health alarms
// below are wired into ALL THREE of background-main.js's own
// onStartup/onInstalled/onAlarm listeners, as part of the same change that
// added this file - see that file's own SPLICE_* blocks.

const SPLICE_CAPTURE_QUEUE_STORAGE_KEY = 'pendingSpliceCaptureEvents';
const SPLICE_CAPTURE_SESSION_ID_STORAGE_KEY = 'spliceCaptureExtensionSessionId';
const SPLICE_CAPTURE_RETRY_ALARM = 'retryPendingSpliceCaptureEvents';
const SPLICE_CAPTURE_HEALTH_ALARM = 'reportSpliceCaptureHealth';
const SPLICE_CAPTURE_BATCH_MAX = 200;
const SPLICE_CAPTURE_FLUSH_QUIET_MS = 500;
const SPLICE_CAPTURE_FLUSH_MAX_WAIT_MS = 2000;
const SPLICE_CAPTURE_FLUSH_EVENT_THRESHOLD = 50;
const SPLICE_CAPTURE_RETRY_MAX_ATTEMPTS = 12;
const SPLICE_CAPTURE_QUEUE_HARD_LIMIT = 3000;
const SPLICE_CAPTURE_HEALTH_MIN_INTERVAL_MS = 5 * 60 * 1000;

const spliceCaptureHealthState = {
  lastCaptureEventAt: 0,
  lastSuccessfulUploadAt: 0,
  lastFailedUploadAt: 0,
  offlineSince: 0,
  lastPingAt: 0,
  uploadDurationsMs: [],
};

const spliceCaptureTelemetry = {
  totalEnqueued: 0,
  totalCreated: 0,
  totalDuplicate: 0,
  totalRejected: 0,
  totalUploadFailures: 0,
  totalDroppedForRetryCeiling: 0,
  totalDroppedForQueueCeiling: 0,
};

let spliceCaptureQuietTimer = null;
let spliceCaptureMaxWaitTimer = null;
let spliceCaptureFlushInFlight = null;

function getSpliceCaptureRetryDelayMs(attempts) {
  const baseMs = 30 * 1000;
  const exponent = Math.max(0, Math.min(Number(attempts || 0), 6));
  return Math.min(baseMs * Math.pow(2, exponent), 30 * 60 * 1000);
}

async function getSpliceCaptureExtensionSessionId() {
  const stored = await chrome.storage.local.get([SPLICE_CAPTURE_SESSION_ID_STORAGE_KEY]);
  const existing = `${stored[SPLICE_CAPTURE_SESSION_ID_STORAGE_KEY] || ''}`.trim();
  if (existing) return existing;
  const generated = (typeof crypto?.randomUUID === 'function')
    ? crypto.randomUUID()
    : `sess_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  await chrome.storage.local.set({ [SPLICE_CAPTURE_SESSION_ID_STORAGE_KEY]: generated });
  return generated;
}

// Serializes every read-modify-write cycle against the shared
// chrome.storage.local queue key - see background-epidemicsound-capture.js's
// identical withEpidemicQueueLock comment for the lost-update race this
// prevents.
let spliceQueueChain = Promise.resolve();

function withSpliceQueueLock(criticalSection) {
  const result = spliceQueueChain.then(criticalSection, criticalSection);
  spliceQueueChain = result.then(() => {}, () => {});
  return result;
}

async function readSpliceCaptureQueue() {
  const stored = await chrome.storage.local.get([SPLICE_CAPTURE_QUEUE_STORAGE_KEY]);
  const queue = stored[SPLICE_CAPTURE_QUEUE_STORAGE_KEY];
  return Array.isArray(queue) ? queue.filter((item) => item && typeof item === 'object') : [];
}

async function writeSpliceCaptureQueue(queue) {
  if (queue.length > SPLICE_CAPTURE_QUEUE_HARD_LIMIT) {
    const overflow = queue.length - SPLICE_CAPTURE_QUEUE_HARD_LIMIT;
    spliceCaptureTelemetry.totalDroppedForQueueCeiling += overflow;
    console.error(
      '[RMW Splice Capture] Queue exceeded hard ceiling - dropping oldest events to protect chrome.storage.local',
      { overflow, ceiling: SPLICE_CAPTURE_QUEUE_HARD_LIMIT }
    );
    queue = queue.slice(overflow);
  }
  await chrome.storage.local.set({ [SPLICE_CAPTURE_QUEUE_STORAGE_KEY]: queue });
  return queue;
}

function scheduleSpliceCaptureRetry(delayMs = 60 * 1000) {
  try {
    if (chrome?.alarms?.create) {
      chrome.alarms.create(SPLICE_CAPTURE_RETRY_ALARM, { when: Date.now() + Math.max(5000, delayMs) });
      return;
    }
  } catch {}
  setTimeout(() => flushSpliceCaptureQueue().catch(() => {}), Math.max(5000, delayMs));
}

function clearSpliceCaptureFlushTimers() {
  if (spliceCaptureQuietTimer) { clearTimeout(spliceCaptureQuietTimer); spliceCaptureQuietTimer = null; }
  if (spliceCaptureMaxWaitTimer) { clearTimeout(spliceCaptureMaxWaitTimer); spliceCaptureMaxWaitTimer = null; }
}

function scheduleSpliceCaptureFlush() {
  if (spliceCaptureQuietTimer) clearTimeout(spliceCaptureQuietTimer);
  spliceCaptureQuietTimer = setTimeout(() => {
    spliceCaptureQuietTimer = null;
    runSpliceCaptureFlush();
  }, SPLICE_CAPTURE_FLUSH_QUIET_MS);

  if (!spliceCaptureMaxWaitTimer) {
    spliceCaptureMaxWaitTimer = setTimeout(() => {
      spliceCaptureMaxWaitTimer = null;
      runSpliceCaptureFlush();
    }, SPLICE_CAPTURE_FLUSH_MAX_WAIT_MS);
  }
}

function runSpliceCaptureFlush() {
  clearSpliceCaptureFlushTimers();
  spliceCaptureFlushInFlight = flushSpliceCaptureQueue()
    .catch((error) => {
      console.error('[RMW Splice Capture] Flush failed unexpectedly', error);
    })
    .finally(() => {
      spliceCaptureFlushInFlight = null;
    });
  return spliceCaptureFlushInFlight;
}

async function enqueueSpliceCaptureEvent(event) {
  let shouldFlushNow = false;
  let shouldScheduleFlush = false;

  await withSpliceQueueLock(async () => {
    const now = Date.now();
    const queue = await readSpliceCaptureQueue();

    const alreadyQueued = queue.some((item) => item.key === event.client_event_id);
    if (alreadyQueued) {
      spliceCaptureHealthState.lastCaptureEventAt = now;
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
    await writeSpliceCaptureQueue(queue);

    spliceCaptureHealthState.lastCaptureEventAt = now;
    spliceCaptureTelemetry.totalEnqueued += 1;

    const readyCount = queue.filter((item) => Number(item.nextAttemptAt || 0) <= now).length;
    if (readyCount >= SPLICE_CAPTURE_FLUSH_EVENT_THRESHOLD) {
      shouldFlushNow = true;
    } else {
      shouldScheduleFlush = true;
    }
  });

  if (shouldFlushNow) runSpliceCaptureFlush();
  else if (shouldScheduleFlush) scheduleSpliceCaptureFlush();
}

function recordSpliceCaptureUploadDuration(durationMs) {
  const durations = spliceCaptureHealthState.uploadDurationsMs;
  durations.push(durationMs);
  if (durations.length > 20) durations.shift();
}

function computeSpliceCaptureAverageUploadTimeMs() {
  const durations = spliceCaptureHealthState.uploadDurationsMs;
  if (!durations.length) return undefined;
  const total = durations.reduce((sum, value) => sum + value, 0);
  return Math.round(total / durations.length);
}

async function postSpliceCaptureEventsBatch(settings, events) {
  const headers = { 'Content-Type': 'application/json' };
  if (settings.sessionToken) headers['X-Session-Id'] = settings.sessionToken;

  // Path segment is "splice" - confirmed exactly against the backend team's
  // provider module folder/route contract. A mismatch here silently breaks
  // capture with no visible error, exactly what happened with Suno's
  // event_type string recently.
  const response = await fetch(`${settings.apiBase}/api/providers/splice/capture/events`, {
    method: 'POST',
    credentials: 'include',
    headers,
    body: JSON.stringify({ events }),
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.success) {
    const error = new Error(buildApiErrorMessage(data, response, 'Splice capture upload failed', settings));
    error.status = response.status;
    throw error;
  }
  return data;
}

async function flushSpliceCaptureQueue() {
  const now = Date.now();
  const queue = await readSpliceCaptureQueue();
  if (!queue.length) return { attempted: 0, remaining: 0 };

  const readyItems = queue.filter((item) => Number(item.nextAttemptAt || 0) <= now);
  if (!readyItems.length) {
    const nextDueAt = queue.reduce((min, item) => Math.min(min, Number(item.nextAttemptAt || 0) || min), Number.POSITIVE_INFINITY);
    if (Number.isFinite(nextDueAt)) scheduleSpliceCaptureRetry(Math.max(5000, nextDueAt - now));
    return { attempted: 0, remaining: queue.length };
  }

  const batch = readyItems.slice(0, SPLICE_CAPTURE_BATCH_MAX);
  const batchKeys = new Set(batch.map((item) => item.key));
  const startedAt = Date.now();

  let uploadResponse = null;
  let uploadError = null;
  try {
    const settings = await getSettings();
    uploadResponse = await postSpliceCaptureEventsBatch(settings, batch.map((item) => ({
      ...item.event,
      session_id: item.event.session_id || settings.sessionToken || undefined,
    })));
  } catch (error) {
    uploadError = error;
  }

  await withSpliceQueueLock(async () => {
    if (uploadResponse) {
      recordSpliceCaptureUploadDuration(Date.now() - startedAt);
      spliceCaptureHealthState.lastSuccessfulUploadAt = Date.now();
      spliceCaptureHealthState.offlineSince = 0;

      const statusCounts = (uploadResponse.results || []).reduce((counts, result) => {
        counts[result.status] = (counts[result.status] || 0) + 1;
        return counts;
      }, {});
      spliceCaptureTelemetry.totalCreated += statusCounts.created || 0;
      spliceCaptureTelemetry.totalDuplicate += statusCounts.duplicate || 0;
      spliceCaptureTelemetry.totalRejected += statusCounts.rejected || 0;

      const resultByKey = new Map((uploadResponse.results || []).map((result) => [result.client_event_id, result]));
      const latestQueue = await readSpliceCaptureQueue();
      const remaining = latestQueue.filter((item) => {
        if (!batchKeys.has(item.key)) return true;
        const result = resultByKey.get(item.key);
        return !result;
      });
      await writeSpliceCaptureQueue(remaining);
    } else {
      recordSpliceCaptureUploadDuration(Date.now() - startedAt);
      spliceCaptureHealthState.lastFailedUploadAt = Date.now();
      if (!spliceCaptureHealthState.offlineSince) spliceCaptureHealthState.offlineSince = Date.now();
      spliceCaptureTelemetry.totalUploadFailures += 1;

      const latestQueue = await readSpliceCaptureQueue();
      const errorMessage = `${uploadError?.message || uploadError || 'Splice capture upload failed'}`.slice(0, 500);
      const updated = [];
      for (const item of latestQueue) {
        if (!batchKeys.has(item.key)) {
          updated.push(item);
          continue;
        }
        const attempts = Number(item.attempts || 0) + 1;
        if (attempts > SPLICE_CAPTURE_RETRY_MAX_ATTEMPTS) {
          spliceCaptureTelemetry.totalDroppedForRetryCeiling += 1;
          continue;
        }
        updated.push({
          ...item,
          attempts,
          lastError: errorMessage,
          nextAttemptAt: now + getSpliceCaptureRetryDelayMs(attempts),
        });
      }
      await writeSpliceCaptureQueue(updated);
    }
  });

  maybeReportSpliceCaptureHealth().catch(() => {});

  const finalQueue = await readSpliceCaptureQueue();
  const stillReady = finalQueue.some((item) => Number(item.nextAttemptAt || 0) <= Date.now());
  if (stillReady) {
    return runSpliceCaptureFlush();
  }
  const nextDueAt = finalQueue.reduce((min, item) => Math.min(min, Number(item.nextAttemptAt || 0) || min), Number.POSITIVE_INFINITY);
  if (Number.isFinite(nextDueAt)) {
    scheduleSpliceCaptureRetry(Math.max(5000, nextDueAt - Date.now()));
  }
  return { attempted: batch.length, remaining: finalQueue.length };
}

async function maybeReportSpliceCaptureHealth(force = false) {
  const now = Date.now();
  if (!force && now - spliceCaptureHealthState.lastPingAt < SPLICE_CAPTURE_HEALTH_MIN_INTERVAL_MS) return;
  spliceCaptureHealthState.lastPingAt = now;

  try {
    const [settings, queue, extensionSessionId] = await Promise.all([
      getSettings(),
      readSpliceCaptureQueue(),
      getSpliceCaptureExtensionSessionId(),
    ]);

    const oldestPendingEventAt = queue.length
      ? Math.min(...queue.map((item) => Number(item.enqueuedAt || now)))
      : 0;

    const headers = { 'Content-Type': 'application/json' };
    if (settings.sessionToken) headers['X-Session-Id'] = settings.sessionToken;

    await fetch(`${settings.apiBase}/api/providers/splice/capture/health`, {
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
        last_capture_event_at: spliceCaptureHealthState.lastCaptureEventAt
          ? new Date(spliceCaptureHealthState.lastCaptureEventAt).toISOString() : undefined,
        last_successful_upload_at: spliceCaptureHealthState.lastSuccessfulUploadAt
          ? new Date(spliceCaptureHealthState.lastSuccessfulUploadAt).toISOString() : undefined,
        last_failed_upload_at: spliceCaptureHealthState.lastFailedUploadAt
          ? new Date(spliceCaptureHealthState.lastFailedUploadAt).toISOString() : undefined,
        average_upload_time_ms: computeSpliceCaptureAverageUploadTimeMs(),
        offline_since: spliceCaptureHealthState.offlineSince
          ? new Date(spliceCaptureHealthState.offlineSince).toISOString() : undefined,
      }),
    });
  } catch {
    // Health reporting is itself best-effort/non-critical - never queued or retried.
  }
}

async function handleSpliceCaptureEventMessage(message, senderTabId = 0, openerTabId = 0) {
  const event = message?.event;
  if (!event || typeof event !== 'object' || !event.event_type || !event.client_event_id) {
    return { ok: false, error: 'Invalid capture event payload' };
  }

  const tabId = message.tabId || senderTabId || 0;
  const directLaunch = await getActiveLaunch(tabId, 'splice');
  const inheritedLaunch = directLaunch?.ticket ? null : await getActiveLaunch(openerTabId, 'splice');
  const activeLaunch = directLaunch || inheritedLaunch;

  const enrichedEvent = {
    ...event,
    extension_ticket: event.extension_ticket || activeLaunch?.ticket || undefined,
    usage_ticket: event.usage_ticket || activeLaunch?.usageTrackingTicket || undefined,
    tab_id: tabId || undefined,
  };

  await enqueueSpliceCaptureEvent(enrichedEvent);
  return { ok: true, queued: true };
}

// Real audio bytes for a sample download, pushed by
// content-splice-capture.js once it has fetched the "source" file's signed
// URL itself - mirrors handleEpidemicCaptureDownloadMediaMessage exactly
// (see that function's own comment for why this is deliberately NOT routed
// through the durable outbox queue above: large payload, no
// ticket/ownership resolution needed - the backend looks the row up by
// client_event_id alone).
async function handleSpliceCaptureDownloadMediaMessage(message) {
  const clientEventId = `${message?.clientEventId || ''}`.trim();
  const audioBase64 = message?.audioBase64;
  if (!clientEventId || !audioBase64) {
    return { ok: false, error: 'Invalid download media payload' };
  }

  try {
    const settings = await getSettings();
    const headers = { 'Content-Type': 'application/json' };
    if (settings.sessionToken) headers['X-Session-Id'] = settings.sessionToken;

    const response = await fetch(`${settings.apiBase}/api/providers/splice/capture/download-media`, {
      method: 'POST',
      credentials: 'include',
      headers,
      body: JSON.stringify({
        client_event_id: clientEventId,
        content_type: message.contentType || 'application/octet-stream',
        media_base64: audioBase64,
        is_download: Boolean(message.isDownload),
      }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      return { ok: false, error: buildApiErrorMessage(data, response, 'Splice download media push failed', settings) };
    }
    if (data.success) {
      return { ok: true, status: data.status };
    }
    return { ok: false, status: data.status, error: data.status || 'Splice download media push not applied' };
  } catch (error) {
    return { ok: false, error: error?.message || 'Splice download media push failed' };
  }
}

// Task Mapping: populates content-splice-task-modal.js's picker. Same
// non-queued/immediate-failure posture as
// handleEpidemicFetchMyActiveTasksMessage - the download is actively
// blocked waiting on this.
async function handleSpliceFetchMyActiveTasksMessage(message, senderTabId = 0, openerTabId = 0) {
  const tabId = message?.tabId || senderTabId || 0;
  const directLaunch = await getActiveLaunch(tabId, 'splice');
  const inheritedLaunch = directLaunch?.ticket ? null : await getActiveLaunch(openerTabId, 'splice');
  const activeLaunch = directLaunch || inheritedLaunch;

  if (!activeLaunch?.ticket && !activeLaunch?.usageTrackingTicket) {
    return { ok: false, error: 'Launch Splice from the dashboard before task selection can run.', reason: 'session_expired' };
  }

  try {
    const settings = await getSettings();
    const params = new URLSearchParams();
    if (activeLaunch.usageTrackingTicket) params.set('usage_ticket', activeLaunch.usageTrackingTicket);
    if (activeLaunch.ticket) params.set('extension_ticket', activeLaunch.ticket);
    // Without this, resolve_generation_gate_tool (utils/generation_gate.py)
    // defaults to Freepik's ITPortalTool row - a perfectly valid Splice
    // ticket then fails validation because its embedded toolId is checked
    // against the wrong tool. Same fix background-epidemicsound-capture.js's
    // identical handler already applies. "splice" is the real seeded
    // tool_slug - confirmed already used by DIRECT_TICKET_ONLY_TOOLS/
    // TOOL_SESSION_DOMAINS in background-main.js.
    params.set('tool_slug', 'splice');

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

// Client Mapping: populates content-splice-task-modal.js's client picker.
async function handleSpliceFetchActiveClientsMessage(message, senderTabId = 0, openerTabId = 0) {
  const tabId = message?.tabId || senderTabId || 0;
  const directLaunch = await getActiveLaunch(tabId, 'splice');
  const inheritedLaunch = directLaunch?.ticket ? null : await getActiveLaunch(openerTabId, 'splice');
  const activeLaunch = directLaunch || inheritedLaunch;

  if (!activeLaunch?.ticket && !activeLaunch?.usageTrackingTicket) {
    return { ok: false, error: 'Launch Splice from the dashboard before client selection can run.', reason: 'session_expired' };
  }

  try {
    const settings = await getSettings();
    const params = new URLSearchParams();
    if (activeLaunch.usageTrackingTicket) params.set('usage_ticket', activeLaunch.usageTrackingTicket);
    if (activeLaunch.ticket) params.set('extension_ticket', activeLaunch.ticket);
    // See the identical comment in handleSpliceFetchMyActiveTasksMessage above.
    params.set('tool_slug', 'splice');

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
