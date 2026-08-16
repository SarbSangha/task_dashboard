// background-envato-capture.js — loaded via importScripts() from
// background.js, before background-main.js (see manifest ordering there).
//
// Owns the Envato raw-capture outbox: one shared queue for the whole
// browser, persisted to chrome.storage.local. Mirrors
// background-freepik-capture.js exactly - same retry-backoff formula,
// chrome.alarms wake-up pattern, and BEST_EFFORT posture (no webhook/server
// push exists for Envato's `.data` endpoints either; the reconciliation walk
// in content-envato-capture.js is the backstop for anything dropped here).
//
// getSettings(), buildApiErrorMessage(), and getActiveLaunch() are defined
// in background-main.js and reused here as-is (see background-freepik-
// capture.js's identical comment for why forward references resolve fine).

const ENVATO_CAPTURE_QUEUE_STORAGE_KEY = 'pendingEnvatoCaptureEvents';
const ENVATO_CAPTURE_SESSION_ID_STORAGE_KEY = 'envatoCaptureExtensionSessionId';
const ENVATO_CAPTURE_RETRY_ALARM = 'retryPendingEnvatoCaptureEvents';
const ENVATO_CAPTURE_HEALTH_ALARM = 'reportEnvatoCaptureHealth';
const ENVATO_CAPTURE_BATCH_MAX = 200;
const ENVATO_CAPTURE_FLUSH_QUIET_MS = 500;
const ENVATO_CAPTURE_FLUSH_MAX_WAIT_MS = 2000;
const ENVATO_CAPTURE_FLUSH_EVENT_THRESHOLD = 50;
const ENVATO_CAPTURE_RETRY_MAX_ATTEMPTS = 12;
const ENVATO_CAPTURE_QUEUE_HARD_LIMIT = 3000;
const ENVATO_CAPTURE_HEALTH_MIN_INTERVAL_MS = 5 * 60 * 1000;

const envatoCaptureHealthState = {
  lastCaptureEventAt: 0,
  lastSuccessfulUploadAt: 0,
  lastFailedUploadAt: 0,
  offlineSince: 0,
  lastPingAt: 0,
  uploadDurationsMs: [],
};

const envatoCaptureTelemetry = {
  totalEnqueued: 0,
  totalCreated: 0,
  totalDuplicate: 0,
  totalRejected: 0,
  totalUploadFailures: 0,
  totalDroppedForRetryCeiling: 0,
  totalDroppedForQueueCeiling: 0,
};

let envatoCaptureQuietTimer = null;
let envatoCaptureMaxWaitTimer = null;
let envatoCaptureFlushInFlight = null;

function getEnvatoCaptureRetryDelayMs(attempts) {
  const baseMs = 30 * 1000;
  const exponent = Math.max(0, Math.min(Number(attempts || 0), 6));
  return Math.min(baseMs * Math.pow(2, exponent), 30 * 60 * 1000);
}

async function getEnvatoCaptureExtensionSessionId() {
  const stored = await chrome.storage.local.get([ENVATO_CAPTURE_SESSION_ID_STORAGE_KEY]);
  const existing = `${stored[ENVATO_CAPTURE_SESSION_ID_STORAGE_KEY] || ''}`.trim();
  if (existing) return existing;
  const generated = (typeof crypto?.randomUUID === 'function')
    ? crypto.randomUUID()
    : `sess_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  await chrome.storage.local.set({ [ENVATO_CAPTURE_SESSION_ID_STORAGE_KEY]: generated });
  return generated;
}

// Serializes every read-modify-write cycle against the shared
// chrome.storage.local queue key - see background-freepik-capture.js's
// identical withFreepikQueueLock comment for the lost-update race this
// prevents (several near-simultaneous generation completions each racing
// their own read-then-write of the queue).
let envatoQueueChain = Promise.resolve();

function withEnvatoQueueLock(criticalSection) {
  const result = envatoQueueChain.then(criticalSection, criticalSection);
  envatoQueueChain = result.then(() => {}, () => {});
  return result;
}

async function readEnvatoCaptureQueue() {
  const stored = await chrome.storage.local.get([ENVATO_CAPTURE_QUEUE_STORAGE_KEY]);
  const queue = stored[ENVATO_CAPTURE_QUEUE_STORAGE_KEY];
  return Array.isArray(queue) ? queue.filter((item) => item && typeof item === 'object') : [];
}

async function writeEnvatoCaptureQueue(queue) {
  if (queue.length > ENVATO_CAPTURE_QUEUE_HARD_LIMIT) {
    const overflow = queue.length - ENVATO_CAPTURE_QUEUE_HARD_LIMIT;
    envatoCaptureTelemetry.totalDroppedForQueueCeiling += overflow;
    console.error(
      '[RMW Envato Capture] Queue exceeded hard ceiling - dropping oldest events to protect chrome.storage.local',
      { overflow, ceiling: ENVATO_CAPTURE_QUEUE_HARD_LIMIT }
    );
    queue = queue.slice(overflow);
  }
  await chrome.storage.local.set({ [ENVATO_CAPTURE_QUEUE_STORAGE_KEY]: queue });
  return queue;
}

function scheduleEnvatoCaptureRetry(delayMs = 60 * 1000) {
  try {
    if (chrome?.alarms?.create) {
      chrome.alarms.create(ENVATO_CAPTURE_RETRY_ALARM, { when: Date.now() + Math.max(5000, delayMs) });
      return;
    }
  } catch {}
  setTimeout(() => flushEnvatoCaptureQueue().catch(() => {}), Math.max(5000, delayMs));
}

function clearEnvatoCaptureFlushTimers() {
  if (envatoCaptureQuietTimer) { clearTimeout(envatoCaptureQuietTimer); envatoCaptureQuietTimer = null; }
  if (envatoCaptureMaxWaitTimer) { clearTimeout(envatoCaptureMaxWaitTimer); envatoCaptureMaxWaitTimer = null; }
}

function scheduleEnvatoCaptureFlush() {
  if (envatoCaptureQuietTimer) clearTimeout(envatoCaptureQuietTimer);
  envatoCaptureQuietTimer = setTimeout(() => {
    envatoCaptureQuietTimer = null;
    runEnvatoCaptureFlush();
  }, ENVATO_CAPTURE_FLUSH_QUIET_MS);

  if (!envatoCaptureMaxWaitTimer) {
    envatoCaptureMaxWaitTimer = setTimeout(() => {
      envatoCaptureMaxWaitTimer = null;
      runEnvatoCaptureFlush();
    }, ENVATO_CAPTURE_FLUSH_MAX_WAIT_MS);
  }
}

function runEnvatoCaptureFlush() {
  clearEnvatoCaptureFlushTimers();
  envatoCaptureFlushInFlight = flushEnvatoCaptureQueue()
    .catch((error) => {
      console.error('[RMW Envato Capture] Flush failed unexpectedly', error);
    })
    .finally(() => {
      envatoCaptureFlushInFlight = null;
    });
  return envatoCaptureFlushInFlight;
}

async function enqueueEnvatoCaptureEvent(event) {
  let shouldFlushNow = false;
  let shouldScheduleFlush = false;

  await withEnvatoQueueLock(async () => {
    const now = Date.now();
    const queue = await readEnvatoCaptureQueue();

    const alreadyQueued = queue.some((item) => item.key === event.client_event_id);
    if (alreadyQueued) {
      envatoCaptureHealthState.lastCaptureEventAt = now;
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
    await writeEnvatoCaptureQueue(queue);

    envatoCaptureHealthState.lastCaptureEventAt = now;
    envatoCaptureTelemetry.totalEnqueued += 1;

    const readyCount = queue.filter((item) => Number(item.nextAttemptAt || 0) <= now).length;
    if (readyCount >= ENVATO_CAPTURE_FLUSH_EVENT_THRESHOLD) {
      shouldFlushNow = true;
    } else {
      shouldScheduleFlush = true;
    }
  });

  if (shouldFlushNow) runEnvatoCaptureFlush();
  else if (shouldScheduleFlush) scheduleEnvatoCaptureFlush();
}

function recordEnvatoCaptureUploadDuration(durationMs) {
  const durations = envatoCaptureHealthState.uploadDurationsMs;
  durations.push(durationMs);
  if (durations.length > 20) durations.shift();
}

function computeEnvatoCaptureAverageUploadTimeMs() {
  const durations = envatoCaptureHealthState.uploadDurationsMs;
  if (!durations.length) return undefined;
  const total = durations.reduce((sum, value) => sum + value, 0);
  return Math.round(total / durations.length);
}

async function postEnvatoCaptureEventsBatch(settings, events) {
  const headers = { 'Content-Type': 'application/json' };
  if (settings.sessionToken) headers['X-Session-Id'] = settings.sessionToken;

  const response = await fetch(`${settings.apiBase}/api/providers/envato/capture/events`, {
    method: 'POST',
    credentials: 'include',
    headers,
    body: JSON.stringify({ events }),
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.success) {
    const error = new Error(buildApiErrorMessage(data, response, 'Envato capture upload failed', settings));
    error.status = response.status;
    throw error;
  }
  return data;
}

async function flushEnvatoCaptureQueue() {
  const now = Date.now();
  const queue = await readEnvatoCaptureQueue();
  if (!queue.length) return { attempted: 0, remaining: 0 };

  const readyItems = queue.filter((item) => Number(item.nextAttemptAt || 0) <= now);
  if (!readyItems.length) {
    const nextDueAt = queue.reduce((min, item) => Math.min(min, Number(item.nextAttemptAt || 0) || min), Number.POSITIVE_INFINITY);
    if (Number.isFinite(nextDueAt)) scheduleEnvatoCaptureRetry(Math.max(5000, nextDueAt - now));
    return { attempted: 0, remaining: queue.length };
  }

  const batch = readyItems.slice(0, ENVATO_CAPTURE_BATCH_MAX);
  const batchKeys = new Set(batch.map((item) => item.key));
  const startedAt = Date.now();

  let uploadResponse = null;
  let uploadError = null;
  try {
    const settings = await getSettings();
    uploadResponse = await postEnvatoCaptureEventsBatch(settings, batch.map((item) => ({
      ...item.event,
      session_id: item.event.session_id || settings.sessionToken || undefined,
    })));
  } catch (error) {
    uploadError = error;
  }

  await withEnvatoQueueLock(async () => {
    if (uploadResponse) {
      recordEnvatoCaptureUploadDuration(Date.now() - startedAt);
      envatoCaptureHealthState.lastSuccessfulUploadAt = Date.now();
      envatoCaptureHealthState.offlineSince = 0;

      const statusCounts = (uploadResponse.results || []).reduce((counts, result) => {
        counts[result.status] = (counts[result.status] || 0) + 1;
        return counts;
      }, {});
      envatoCaptureTelemetry.totalCreated += statusCounts.created || 0;
      envatoCaptureTelemetry.totalDuplicate += statusCounts.duplicate || 0;
      envatoCaptureTelemetry.totalRejected += statusCounts.rejected || 0;

      const resultByKey = new Map((uploadResponse.results || []).map((result) => [result.client_event_id, result]));
      const latestQueue = await readEnvatoCaptureQueue();
      const remaining = latestQueue.filter((item) => {
        if (!batchKeys.has(item.key)) return true;
        const result = resultByKey.get(item.key);
        return !result;
      });
      await writeEnvatoCaptureQueue(remaining);
    } else {
      recordEnvatoCaptureUploadDuration(Date.now() - startedAt);
      envatoCaptureHealthState.lastFailedUploadAt = Date.now();
      if (!envatoCaptureHealthState.offlineSince) envatoCaptureHealthState.offlineSince = Date.now();
      envatoCaptureTelemetry.totalUploadFailures += 1;

      const latestQueue = await readEnvatoCaptureQueue();
      const errorMessage = `${uploadError?.message || uploadError || 'Envato capture upload failed'}`.slice(0, 500);
      const updated = [];
      for (const item of latestQueue) {
        if (!batchKeys.has(item.key)) {
          updated.push(item);
          continue;
        }
        const attempts = Number(item.attempts || 0) + 1;
        if (attempts > ENVATO_CAPTURE_RETRY_MAX_ATTEMPTS) {
          envatoCaptureTelemetry.totalDroppedForRetryCeiling += 1;
          continue;
        }
        updated.push({
          ...item,
          attempts,
          lastError: errorMessage,
          nextAttemptAt: now + getEnvatoCaptureRetryDelayMs(attempts),
        });
      }
      await writeEnvatoCaptureQueue(updated);
    }
  });

  maybeReportEnvatoCaptureHealth().catch(() => {});

  const finalQueue = await readEnvatoCaptureQueue();
  const stillReady = finalQueue.some((item) => Number(item.nextAttemptAt || 0) <= Date.now());
  if (stillReady) {
    return runEnvatoCaptureFlush();
  }
  const nextDueAt = finalQueue.reduce((min, item) => Math.min(min, Number(item.nextAttemptAt || 0) || min), Number.POSITIVE_INFINITY);
  if (Number.isFinite(nextDueAt)) {
    scheduleEnvatoCaptureRetry(Math.max(5000, nextDueAt - Date.now()));
  }
  return { attempted: batch.length, remaining: finalQueue.length };
}

async function maybeReportEnvatoCaptureHealth(force = false) {
  const now = Date.now();
  if (!force && now - envatoCaptureHealthState.lastPingAt < ENVATO_CAPTURE_HEALTH_MIN_INTERVAL_MS) return;
  envatoCaptureHealthState.lastPingAt = now;

  try {
    const [settings, queue, extensionSessionId] = await Promise.all([
      getSettings(),
      readEnvatoCaptureQueue(),
      getEnvatoCaptureExtensionSessionId(),
    ]);

    const oldestPendingEventAt = queue.length
      ? Math.min(...queue.map((item) => Number(item.enqueuedAt || now)))
      : 0;

    const headers = { 'Content-Type': 'application/json' };
    if (settings.sessionToken) headers['X-Session-Id'] = settings.sessionToken;

    await fetch(`${settings.apiBase}/api/providers/envato/capture/health`, {
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
        last_capture_event_at: envatoCaptureHealthState.lastCaptureEventAt
          ? new Date(envatoCaptureHealthState.lastCaptureEventAt).toISOString() : undefined,
        last_successful_upload_at: envatoCaptureHealthState.lastSuccessfulUploadAt
          ? new Date(envatoCaptureHealthState.lastSuccessfulUploadAt).toISOString() : undefined,
        last_failed_upload_at: envatoCaptureHealthState.lastFailedUploadAt
          ? new Date(envatoCaptureHealthState.lastFailedUploadAt).toISOString() : undefined,
        average_upload_time_ms: computeEnvatoCaptureAverageUploadTimeMs(),
        offline_since: envatoCaptureHealthState.offlineSince
          ? new Date(envatoCaptureHealthState.offlineSince).toISOString() : undefined,
      }),
    });
  } catch {
    // Health reporting is itself best-effort/non-critical - never queued or retried.
  }
}

async function handleEnvatoCaptureEventMessage(message, senderTabId = 0, openerTabId = 0) {
  const event = message?.event;
  if (!event || typeof event !== 'object' || !event.event_type || !event.client_event_id) {
    return { ok: false, error: 'Invalid capture event payload' };
  }

  const tabId = message.tabId || senderTabId || 0;
  const directLaunch = await getActiveLaunch(tabId, 'envato');
  const inheritedLaunch = directLaunch?.ticket ? null : await getActiveLaunch(openerTabId, 'envato');
  const activeLaunch = directLaunch || inheritedLaunch;

  const enrichedEvent = {
    ...event,
    extension_ticket: event.extension_ticket || activeLaunch?.ticket || undefined,
    usage_ticket: event.usage_ticket || activeLaunch?.usageTrackingTicket || undefined,
    tab_id: tabId || undefined,
  };

  await enqueueEnvatoCaptureEvent(enrichedEvent);
  return { ok: true, queued: true };
}

// Real audio/video bytes for a stock-asset download, pushed by
// content-envato-elements-capture.js - mirrors
// handleElevenlabsCaptureAudioMessage exactly (see that function's own
// comment for why this is deliberately NOT routed through the durable
// outbox queue above: large payload, no ticket/ownership resolution needed
// - the backend looks the row up by client_event_id alone - and a miss is
// self-healing since the same media re-fires every time the item is
// downloaded again).
async function handleEnvatoCaptureDownloadMediaMessage(message) {
  const clientEventId = `${message?.clientEventId || ''}`.trim();
  const audioBase64 = message?.audioBase64;
  if (!clientEventId || !audioBase64) {
    return { ok: false, error: 'Invalid download media payload' };
  }

  try {
    const settings = await getSettings();
    const headers = { 'Content-Type': 'application/json' };
    if (settings.sessionToken) headers['X-Session-Id'] = settings.sessionToken;

    const response = await fetch(`${settings.apiBase}/api/providers/envato/capture/download-media`, {
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
      return { ok: false, error: buildApiErrorMessage(data, response, 'Envato download media push failed', settings) };
    }
    if (data.success) {
      return { ok: true, status: data.status };
    }
    return { ok: false, status: data.status, error: data.status || 'Envato download media push not applied' };
  } catch (error) {
    return { ok: false, error: error?.message || 'Envato download media push failed' };
  }
}

async function handleEnvatoSyncProgressMessage(message, senderTabId = 0, openerTabId = 0) {
  const directLaunch = await getActiveLaunch(senderTabId, 'envato');
  const inheritedLaunch = directLaunch?.ticket ? null : await getActiveLaunch(openerTabId, 'envato');
  const activeLaunch = directLaunch || inheritedLaunch;

  try {
    const settings = await getSettings();
    const headers = { 'Content-Type': 'application/json' };
    if (settings.sessionToken) headers['X-Session-Id'] = settings.sessionToken;
    await fetch(`${settings.apiBase}/api/providers/envato/sync/cursor`, {
      method: 'POST',
      credentials: 'include',
      headers,
      body: JSON.stringify({
        last_seen_item_uuid: message.lastSeenItemUuid || null,
        last_synced_page: Number(message.lastSyncedPage || 0),
        is_full_reconciliation: Boolean(message.isFullReconciliation),
        status: message.status || 'idle',
        extension_ticket: activeLaunch?.ticket || undefined,
        usage_ticket: activeLaunch?.usageTrackingTicket || undefined,
      }),
    });
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error?.message || 'Envato sync progress report failed' };
  }
}

// Task Mapping: populates content-envato-task-modal.js's picker. Same
// non-queued/immediate-failure posture as
// handleFreepikFetchMyActiveTasksMessage - the generation is actively
// blocked waiting on this.
async function handleEnvatoFetchMyActiveTasksMessage(message, senderTabId = 0, openerTabId = 0) {
  const tabId = message?.tabId || senderTabId || 0;
  const directLaunch = await getActiveLaunch(tabId, 'envato');
  const inheritedLaunch = directLaunch?.ticket ? null : await getActiveLaunch(openerTabId, 'envato');
  const activeLaunch = directLaunch || inheritedLaunch;

  if (!activeLaunch?.ticket && !activeLaunch?.usageTrackingTicket) {
    return { ok: false, error: 'Launch Envato from the dashboard before task selection can run.', reason: 'session_expired' };
  }

  try {
    const settings = await getSettings();
    const params = new URLSearchParams();
    if (activeLaunch.usageTrackingTicket) params.set('usage_ticket', activeLaunch.usageTrackingTicket);
    if (activeLaunch.ticket) params.set('extension_ticket', activeLaunch.ticket);
    // Without this, resolve_generation_gate_tool (utils/generation_gate.py)
    // defaults to Freepik's ITPortalTool row - a perfectly valid Envato
    // ticket then fails validation because its embedded toolId is checked
    // against the wrong tool ("Launch this tool from the dashboard before
    // usage tracking can run", confirmed live 2026-08-08). Same fix
    // background-heygen-capture.js's identical handler already applies.
    params.set('tool_slug', 'envato');

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

// Client Mapping: populates content-envato-task-modal.js's client picker.
async function handleEnvatoFetchActiveClientsMessage(message, senderTabId = 0, openerTabId = 0) {
  const tabId = message?.tabId || senderTabId || 0;
  const directLaunch = await getActiveLaunch(tabId, 'envato');
  const inheritedLaunch = directLaunch?.ticket ? null : await getActiveLaunch(openerTabId, 'envato');
  const activeLaunch = directLaunch || inheritedLaunch;

  if (!activeLaunch?.ticket && !activeLaunch?.usageTrackingTicket) {
    return { ok: false, error: 'Launch Envato from the dashboard before client selection can run.', reason: 'session_expired' };
  }

  try {
    const settings = await getSettings();
    const params = new URLSearchParams();
    if (activeLaunch.usageTrackingTicket) params.set('usage_ticket', activeLaunch.usageTrackingTicket);
    if (activeLaunch.ticket) params.set('extension_ticket', activeLaunch.ticket);
    // See the identical comment in handleEnvatoFetchMyActiveTasksMessage above.
    params.set('tool_slug', 'envato');

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
