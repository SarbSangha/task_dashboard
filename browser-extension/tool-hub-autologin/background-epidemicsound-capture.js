// background-epidemicsound-capture.js — loaded via importScripts() from
// background.js, before background-main.js (see manifest ordering there).
//
// Owns the Epidemic Sound raw-capture outbox: one shared queue for the whole
// browser, persisted to chrome.storage.local. Structurally a direct copy of
// background-envato-capture.js (this file's template, per the explicit build
// instructions), every Envato/ENVATO/envato identifier renamed to
// EpidemicSound/EPIDEMIC/epidemic. Same retry-backoff formula, chrome.alarms
// wake-up pattern, and BEST_EFFORT posture.
//
// Unlike Envato Elements, there is no ENVATO_SYNC_PROGRESS equivalent here -
// Epidemic Sound has no reconciliation walker on the content-script side (see
// content-epidemicsound-capture.js's own header comment: every download is a
// single synchronous request/response pair, there is no "still generating"
// state to reconcile against), so no sync/cursor endpoint is needed either.
//
// getSettings(), buildApiErrorMessage(), and getActiveLaunch() are defined
// in background-main.js and reused here as-is (all files run in the same
// classic service-worker global scope via importScripts, so no
// re-declaration or explicit import is needed - see
// background-envato-capture.js's identical comment).
//
// A recent real incident on this codebase: Suno's background handlers were
// built but never wired into background-main.js's message dispatch, leaving
// them unreachable dead code until caught. The five EPIDEMIC_* message types
// this file's handlers respond to (EPIDEMIC_CAPTURE_EVENT,
// EPIDEMIC_CAPTURE_DOWNLOAD_MEDIA, EPIDEMIC_CAPTURE_ADAPTATION_MEDIA,
// EPIDEMIC_FETCH_MY_ACTIVE_TASKS, EPIDEMIC_FETCH_ACTIVE_CLIENTS) are wired
// into background-main.js's handleRuntimeMessage AS PART OF THE SAME CHANGE
// that added this file (EPIDEMIC_CAPTURE_ADAPTATION_MEDIA added later,
// alongside the Adapt capture surface - same discipline applied then too,
// not repeating the Suno gap) - see that file's own EPIDEMIC_* blocks. The
// retry/health alarms below are likewise wired into background-main.js's
// onStartup/onInstalled/onAlarm listeners in full (mirroring Envato's
// complete wiring, not the ElevenLabs/Suno/Flow queues, whose retry alarms
// are notably NOT listened for in background-main.js's onAlarm handler at
// the time this was written - an existing gap in this codebase, not
// repeated here). EPIDEMIC_CAPTURE_EVENT itself needed no change to support
// the new adaptation_version event_type - see enqueueEpidemicCaptureEvent/
// postEpidemicCaptureEventsBatch below, neither of which filter or branch on
// event_type at all, it is purely a payload field the backend interprets.

const EPIDEMIC_CAPTURE_QUEUE_STORAGE_KEY = 'pendingEpidemicCaptureEvents';
const EPIDEMIC_CAPTURE_SESSION_ID_STORAGE_KEY = 'epidemicCaptureExtensionSessionId';
const EPIDEMIC_CAPTURE_RETRY_ALARM = 'retryPendingEpidemicCaptureEvents';
const EPIDEMIC_CAPTURE_HEALTH_ALARM = 'reportEpidemicCaptureHealth';
const EPIDEMIC_CAPTURE_BATCH_MAX = 200;
const EPIDEMIC_CAPTURE_FLUSH_QUIET_MS = 500;
const EPIDEMIC_CAPTURE_FLUSH_MAX_WAIT_MS = 2000;
const EPIDEMIC_CAPTURE_FLUSH_EVENT_THRESHOLD = 50;
const EPIDEMIC_CAPTURE_RETRY_MAX_ATTEMPTS = 12;
const EPIDEMIC_CAPTURE_QUEUE_HARD_LIMIT = 3000;
const EPIDEMIC_CAPTURE_HEALTH_MIN_INTERVAL_MS = 5 * 60 * 1000;

const epidemicCaptureHealthState = {
  lastCaptureEventAt: 0,
  lastSuccessfulUploadAt: 0,
  lastFailedUploadAt: 0,
  offlineSince: 0,
  lastPingAt: 0,
  uploadDurationsMs: [],
};

const epidemicCaptureTelemetry = {
  totalEnqueued: 0,
  totalCreated: 0,
  totalDuplicate: 0,
  totalRejected: 0,
  totalUploadFailures: 0,
  totalDroppedForRetryCeiling: 0,
  totalDroppedForQueueCeiling: 0,
};

let epidemicCaptureQuietTimer = null;
let epidemicCaptureMaxWaitTimer = null;
let epidemicCaptureFlushInFlight = null;

function getEpidemicCaptureRetryDelayMs(attempts) {
  const baseMs = 30 * 1000;
  const exponent = Math.max(0, Math.min(Number(attempts || 0), 6));
  return Math.min(baseMs * Math.pow(2, exponent), 30 * 60 * 1000);
}

async function getEpidemicCaptureExtensionSessionId() {
  const stored = await chrome.storage.local.get([EPIDEMIC_CAPTURE_SESSION_ID_STORAGE_KEY]);
  const existing = `${stored[EPIDEMIC_CAPTURE_SESSION_ID_STORAGE_KEY] || ''}`.trim();
  if (existing) return existing;
  const generated = (typeof crypto?.randomUUID === 'function')
    ? crypto.randomUUID()
    : `sess_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  await chrome.storage.local.set({ [EPIDEMIC_CAPTURE_SESSION_ID_STORAGE_KEY]: generated });
  return generated;
}

// Serializes every read-modify-write cycle against the shared
// chrome.storage.local queue key - see background-envato-capture.js's
// identical withEnvatoQueueLock comment for the lost-update race this
// prevents.
let epidemicQueueChain = Promise.resolve();

function withEpidemicQueueLock(criticalSection) {
  const result = epidemicQueueChain.then(criticalSection, criticalSection);
  epidemicQueueChain = result.then(() => {}, () => {});
  return result;
}

async function readEpidemicCaptureQueue() {
  const stored = await chrome.storage.local.get([EPIDEMIC_CAPTURE_QUEUE_STORAGE_KEY]);
  const queue = stored[EPIDEMIC_CAPTURE_QUEUE_STORAGE_KEY];
  return Array.isArray(queue) ? queue.filter((item) => item && typeof item === 'object') : [];
}

async function writeEpidemicCaptureQueue(queue) {
  if (queue.length > EPIDEMIC_CAPTURE_QUEUE_HARD_LIMIT) {
    const overflow = queue.length - EPIDEMIC_CAPTURE_QUEUE_HARD_LIMIT;
    epidemicCaptureTelemetry.totalDroppedForQueueCeiling += overflow;
    console.error(
      '[RMW Epidemic Sound Capture] Queue exceeded hard ceiling - dropping oldest events to protect chrome.storage.local',
      { overflow, ceiling: EPIDEMIC_CAPTURE_QUEUE_HARD_LIMIT }
    );
    queue = queue.slice(overflow);
  }
  await chrome.storage.local.set({ [EPIDEMIC_CAPTURE_QUEUE_STORAGE_KEY]: queue });
  return queue;
}

function scheduleEpidemicCaptureRetry(delayMs = 60 * 1000) {
  try {
    if (chrome?.alarms?.create) {
      chrome.alarms.create(EPIDEMIC_CAPTURE_RETRY_ALARM, { when: Date.now() + Math.max(5000, delayMs) });
      return;
    }
  } catch {}
  setTimeout(() => flushEpidemicCaptureQueue().catch(() => {}), Math.max(5000, delayMs));
}

function clearEpidemicCaptureFlushTimers() {
  if (epidemicCaptureQuietTimer) { clearTimeout(epidemicCaptureQuietTimer); epidemicCaptureQuietTimer = null; }
  if (epidemicCaptureMaxWaitTimer) { clearTimeout(epidemicCaptureMaxWaitTimer); epidemicCaptureMaxWaitTimer = null; }
}

function scheduleEpidemicCaptureFlush() {
  if (epidemicCaptureQuietTimer) clearTimeout(epidemicCaptureQuietTimer);
  epidemicCaptureQuietTimer = setTimeout(() => {
    epidemicCaptureQuietTimer = null;
    runEpidemicCaptureFlush();
  }, EPIDEMIC_CAPTURE_FLUSH_QUIET_MS);

  if (!epidemicCaptureMaxWaitTimer) {
    epidemicCaptureMaxWaitTimer = setTimeout(() => {
      epidemicCaptureMaxWaitTimer = null;
      runEpidemicCaptureFlush();
    }, EPIDEMIC_CAPTURE_FLUSH_MAX_WAIT_MS);
  }
}

function runEpidemicCaptureFlush() {
  clearEpidemicCaptureFlushTimers();
  epidemicCaptureFlushInFlight = flushEpidemicCaptureQueue()
    .catch((error) => {
      console.error('[RMW Epidemic Sound Capture] Flush failed unexpectedly', error);
    })
    .finally(() => {
      epidemicCaptureFlushInFlight = null;
    });
  return epidemicCaptureFlushInFlight;
}

async function enqueueEpidemicCaptureEvent(event) {
  let shouldFlushNow = false;
  let shouldScheduleFlush = false;

  await withEpidemicQueueLock(async () => {
    const now = Date.now();
    const queue = await readEpidemicCaptureQueue();

    const alreadyQueued = queue.some((item) => item.key === event.client_event_id);
    if (alreadyQueued) {
      epidemicCaptureHealthState.lastCaptureEventAt = now;
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
    await writeEpidemicCaptureQueue(queue);

    epidemicCaptureHealthState.lastCaptureEventAt = now;
    epidemicCaptureTelemetry.totalEnqueued += 1;

    const readyCount = queue.filter((item) => Number(item.nextAttemptAt || 0) <= now).length;
    if (readyCount >= EPIDEMIC_CAPTURE_FLUSH_EVENT_THRESHOLD) {
      shouldFlushNow = true;
    } else {
      shouldScheduleFlush = true;
    }
  });

  if (shouldFlushNow) runEpidemicCaptureFlush();
  else if (shouldScheduleFlush) scheduleEpidemicCaptureFlush();
}

function recordEpidemicCaptureUploadDuration(durationMs) {
  const durations = epidemicCaptureHealthState.uploadDurationsMs;
  durations.push(durationMs);
  if (durations.length > 20) durations.shift();
}

function computeEpidemicCaptureAverageUploadTimeMs() {
  const durations = epidemicCaptureHealthState.uploadDurationsMs;
  if (!durations.length) return undefined;
  const total = durations.reduce((sum, value) => sum + value, 0);
  return Math.round(total / durations.length);
}

async function postEpidemicCaptureEventsBatch(settings, events) {
  const headers = { 'Content-Type': 'application/json' };
  if (settings.sessionToken) headers['X-Session-Id'] = settings.sessionToken;

  // Path segment is "epidemicsound" (no hyphen, matches the backend
  // provider module folder) - NOT the same string as the hyphenated
  // "epidemic-sound" tool_slug used below for task/client lookups. Confirmed
  // exactly against backend/constants.py's EVENT_TYPE_DOWNLOAD_CLICK; a
  // mismatch on either string silently breaks capture with no visible
  // error, exactly what happened with Suno recently.
  const response = await fetch(`${settings.apiBase}/api/providers/epidemicsound/capture/events`, {
    method: 'POST',
    credentials: 'include',
    headers,
    body: JSON.stringify({ events }),
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.success) {
    const error = new Error(buildApiErrorMessage(data, response, 'Epidemic Sound capture upload failed', settings));
    error.status = response.status;
    throw error;
  }
  return data;
}

async function flushEpidemicCaptureQueue() {
  const now = Date.now();
  const queue = await readEpidemicCaptureQueue();
  if (!queue.length) return { attempted: 0, remaining: 0 };

  const readyItems = queue.filter((item) => Number(item.nextAttemptAt || 0) <= now);
  if (!readyItems.length) {
    const nextDueAt = queue.reduce((min, item) => Math.min(min, Number(item.nextAttemptAt || 0) || min), Number.POSITIVE_INFINITY);
    if (Number.isFinite(nextDueAt)) scheduleEpidemicCaptureRetry(Math.max(5000, nextDueAt - now));
    return { attempted: 0, remaining: queue.length };
  }

  const batch = readyItems.slice(0, EPIDEMIC_CAPTURE_BATCH_MAX);
  const batchKeys = new Set(batch.map((item) => item.key));
  const startedAt = Date.now();

  let uploadResponse = null;
  let uploadError = null;
  try {
    const settings = await getSettings();
    uploadResponse = await postEpidemicCaptureEventsBatch(settings, batch.map((item) => ({
      ...item.event,
      session_id: item.event.session_id || settings.sessionToken || undefined,
    })));
  } catch (error) {
    uploadError = error;
  }

  await withEpidemicQueueLock(async () => {
    if (uploadResponse) {
      recordEpidemicCaptureUploadDuration(Date.now() - startedAt);
      epidemicCaptureHealthState.lastSuccessfulUploadAt = Date.now();
      epidemicCaptureHealthState.offlineSince = 0;

      const statusCounts = (uploadResponse.results || []).reduce((counts, result) => {
        counts[result.status] = (counts[result.status] || 0) + 1;
        return counts;
      }, {});
      epidemicCaptureTelemetry.totalCreated += statusCounts.created || 0;
      epidemicCaptureTelemetry.totalDuplicate += statusCounts.duplicate || 0;
      epidemicCaptureTelemetry.totalRejected += statusCounts.rejected || 0;

      const resultByKey = new Map((uploadResponse.results || []).map((result) => [result.client_event_id, result]));
      const latestQueue = await readEpidemicCaptureQueue();
      const remaining = latestQueue.filter((item) => {
        if (!batchKeys.has(item.key)) return true;
        const result = resultByKey.get(item.key);
        return !result;
      });
      await writeEpidemicCaptureQueue(remaining);
    } else {
      recordEpidemicCaptureUploadDuration(Date.now() - startedAt);
      epidemicCaptureHealthState.lastFailedUploadAt = Date.now();
      if (!epidemicCaptureHealthState.offlineSince) epidemicCaptureHealthState.offlineSince = Date.now();
      epidemicCaptureTelemetry.totalUploadFailures += 1;

      const latestQueue = await readEpidemicCaptureQueue();
      const errorMessage = `${uploadError?.message || uploadError || 'Epidemic Sound capture upload failed'}`.slice(0, 500);
      const updated = [];
      for (const item of latestQueue) {
        if (!batchKeys.has(item.key)) {
          updated.push(item);
          continue;
        }
        const attempts = Number(item.attempts || 0) + 1;
        if (attempts > EPIDEMIC_CAPTURE_RETRY_MAX_ATTEMPTS) {
          epidemicCaptureTelemetry.totalDroppedForRetryCeiling += 1;
          continue;
        }
        updated.push({
          ...item,
          attempts,
          lastError: errorMessage,
          nextAttemptAt: now + getEpidemicCaptureRetryDelayMs(attempts),
        });
      }
      await writeEpidemicCaptureQueue(updated);
    }
  });

  maybeReportEpidemicCaptureHealth().catch(() => {});

  const finalQueue = await readEpidemicCaptureQueue();
  const stillReady = finalQueue.some((item) => Number(item.nextAttemptAt || 0) <= Date.now());
  if (stillReady) {
    return runEpidemicCaptureFlush();
  }
  const nextDueAt = finalQueue.reduce((min, item) => Math.min(min, Number(item.nextAttemptAt || 0) || min), Number.POSITIVE_INFINITY);
  if (Number.isFinite(nextDueAt)) {
    scheduleEpidemicCaptureRetry(Math.max(5000, nextDueAt - Date.now()));
  }
  return { attempted: batch.length, remaining: finalQueue.length };
}

async function maybeReportEpidemicCaptureHealth(force = false) {
  const now = Date.now();
  if (!force && now - epidemicCaptureHealthState.lastPingAt < EPIDEMIC_CAPTURE_HEALTH_MIN_INTERVAL_MS) return;
  epidemicCaptureHealthState.lastPingAt = now;

  try {
    const [settings, queue, extensionSessionId] = await Promise.all([
      getSettings(),
      readEpidemicCaptureQueue(),
      getEpidemicCaptureExtensionSessionId(),
    ]);

    const oldestPendingEventAt = queue.length
      ? Math.min(...queue.map((item) => Number(item.enqueuedAt || now)))
      : 0;

    const headers = { 'Content-Type': 'application/json' };
    if (settings.sessionToken) headers['X-Session-Id'] = settings.sessionToken;

    await fetch(`${settings.apiBase}/api/providers/epidemicsound/capture/health`, {
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
        last_capture_event_at: epidemicCaptureHealthState.lastCaptureEventAt
          ? new Date(epidemicCaptureHealthState.lastCaptureEventAt).toISOString() : undefined,
        last_successful_upload_at: epidemicCaptureHealthState.lastSuccessfulUploadAt
          ? new Date(epidemicCaptureHealthState.lastSuccessfulUploadAt).toISOString() : undefined,
        last_failed_upload_at: epidemicCaptureHealthState.lastFailedUploadAt
          ? new Date(epidemicCaptureHealthState.lastFailedUploadAt).toISOString() : undefined,
        average_upload_time_ms: computeEpidemicCaptureAverageUploadTimeMs(),
        offline_since: epidemicCaptureHealthState.offlineSince
          ? new Date(epidemicCaptureHealthState.offlineSince).toISOString() : undefined,
      }),
    });
  } catch {
    // Health reporting is itself best-effort/non-critical - never queued or retried.
  }
}

async function handleEpidemicCaptureEventMessage(message, senderTabId = 0, openerTabId = 0) {
  const event = message?.event;
  if (!event || typeof event !== 'object' || !event.event_type || !event.client_event_id) {
    return { ok: false, error: 'Invalid capture event payload' };
  }

  const tabId = message.tabId || senderTabId || 0;
  const directLaunch = await getActiveLaunch(tabId, 'epidemic-sound');
  const inheritedLaunch = directLaunch?.ticket ? null : await getActiveLaunch(openerTabId, 'epidemic-sound');
  const activeLaunch = directLaunch || inheritedLaunch;

  const enrichedEvent = {
    ...event,
    extension_ticket: event.extension_ticket || activeLaunch?.ticket || undefined,
    usage_ticket: event.usage_ticket || activeLaunch?.usageTrackingTicket || undefined,
    tab_id: tabId || undefined,
  };

  await enqueueEpidemicCaptureEvent(enrichedEvent);
  return { ok: true, queued: true };
}

// Real audio bytes for a track/sound-effect download, pushed by
// content-epidemicsound-capture.js once it has fetched assetUrl itself -
// mirrors handleEnvatoCaptureDownloadMediaMessage exactly (see that
// function's own comment for why this is deliberately NOT routed through the
// durable outbox queue above: large payload, no ticket/ownership resolution
// needed - the backend looks the row up by client_event_id alone).
async function handleEpidemicCaptureDownloadMediaMessage(message) {
  const clientEventId = `${message?.clientEventId || ''}`.trim();
  const audioBase64 = message?.audioBase64;
  if (!clientEventId || !audioBase64) {
    return { ok: false, error: 'Invalid download media payload' };
  }

  try {
    const settings = await getSettings();
    const headers = { 'Content-Type': 'application/json' };
    if (settings.sessionToken) headers['X-Session-Id'] = settings.sessionToken;

    const response = await fetch(`${settings.apiBase}/api/providers/epidemicsound/capture/download-media`, {
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
      return { ok: false, error: buildApiErrorMessage(data, response, 'Epidemic Sound download media push failed', settings) };
    }
    if (data.success) {
      return { ok: true, status: data.status };
    }
    return { ok: false, status: data.status, error: data.status || 'Epidemic Sound download media push not applied' };
  } catch (error) {
    return { ok: false, error: error?.message || 'Epidemic Sound download media push failed' };
  }
}

// Real audio bytes for a completed Adapt version, pushed by
// content-epidemicsound-capture.js once it has fetched asset.previewUrl
// itself - mirrors handleEpidemicCaptureDownloadMediaMessage above exactly
// (see that function's own comment for why this is deliberately NOT routed
// through the durable outbox queue: large payload, no ticket/ownership
// resolution needed, the backend looks the row up by client_event_id
// alone). Posts to a NEW, separate endpoint (/capture/adaptation-media, not
// /capture/download-media) even though the request/response shape is
// identical - the metadata event above instead reuses the SAME
// /capture/events endpoint via a distinct event_type value, so this is the
// one place the two surfaces genuinely diverge server-side.
async function handleEpidemicCaptureAdaptationMediaMessage(message) {
  const clientEventId = `${message?.clientEventId || ''}`.trim();
  const audioBase64 = message?.audioBase64;
  if (!clientEventId || !audioBase64) {
    return { ok: false, error: 'Invalid adaptation media payload' };
  }

  try {
    const settings = await getSettings();
    const headers = { 'Content-Type': 'application/json' };
    if (settings.sessionToken) headers['X-Session-Id'] = settings.sessionToken;

    const response = await fetch(`${settings.apiBase}/api/providers/epidemicsound/capture/adaptation-media`, {
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
      return { ok: false, error: buildApiErrorMessage(data, response, 'Epidemic Sound adaptation media push failed', settings) };
    }
    if (data.success) {
      return { ok: true, status: data.status };
    }
    return { ok: false, status: data.status, error: data.status || 'Epidemic Sound adaptation media push not applied' };
  } catch (error) {
    return { ok: false, error: error?.message || 'Epidemic Sound adaptation media push failed' };
  }
}

// Task Mapping: populates content-epidemicsound-task-modal.js's picker. Same
// non-queued/immediate-failure posture as
// handleEnvatoFetchMyActiveTasksMessage - the download is actively blocked
// waiting on this.
async function handleEpidemicFetchMyActiveTasksMessage(message, senderTabId = 0, openerTabId = 0) {
  const tabId = message?.tabId || senderTabId || 0;
  const directLaunch = await getActiveLaunch(tabId, 'epidemic-sound');
  const inheritedLaunch = directLaunch?.ticket ? null : await getActiveLaunch(openerTabId, 'epidemic-sound');
  const activeLaunch = directLaunch || inheritedLaunch;

  if (!activeLaunch?.ticket && !activeLaunch?.usageTrackingTicket) {
    return { ok: false, error: 'Launch Epidemic Sound from the dashboard before task selection can run.', reason: 'session_expired' };
  }

  try {
    const settings = await getSettings();
    const params = new URLSearchParams();
    if (activeLaunch.usageTrackingTicket) params.set('usage_ticket', activeLaunch.usageTrackingTicket);
    if (activeLaunch.ticket) params.set('extension_ticket', activeLaunch.ticket);
    // Without this, resolve_generation_gate_tool (utils/generation_gate.py)
    // defaults to Freepik's ITPortalTool row - a perfectly valid Epidemic
    // Sound ticket then fails validation because its embedded toolId is
    // checked against the wrong tool. Same fix background-envato-capture.js's
    // identical handler already applies. Hyphenated "epidemic-sound" - the
    // real seeded slug, confirmed - NOT "epidemicsound"/"epidemic_sound".
    params.set('tool_slug', 'epidemic-sound');

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

// Client Mapping: populates content-epidemicsound-task-modal.js's client picker.
async function handleEpidemicFetchActiveClientsMessage(message, senderTabId = 0, openerTabId = 0) {
  const tabId = message?.tabId || senderTabId || 0;
  const directLaunch = await getActiveLaunch(tabId, 'epidemic-sound');
  const inheritedLaunch = directLaunch?.ticket ? null : await getActiveLaunch(openerTabId, 'epidemic-sound');
  const activeLaunch = directLaunch || inheritedLaunch;

  if (!activeLaunch?.ticket && !activeLaunch?.usageTrackingTicket) {
    return { ok: false, error: 'Launch Epidemic Sound from the dashboard before client selection can run.', reason: 'session_expired' };
  }

  try {
    const settings = await getSettings();
    const params = new URLSearchParams();
    if (activeLaunch.usageTrackingTicket) params.set('usage_ticket', activeLaunch.usageTrackingTicket);
    if (activeLaunch.ticket) params.set('extension_ticket', activeLaunch.ticket);
    // See the identical comment in handleEpidemicFetchMyActiveTasksMessage above.
    params.set('tool_slug', 'epidemic-sound');

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
