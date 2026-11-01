// background-figma-capture.js - loaded via importScripts() from background.js,
// before background-main.js.
//
// The Figma capture outbox: one queue for the whole browser, persisted to
// chrome.storage.local, same shape and retry backoff as
// background-splice-capture.js (its template) minus what Figma doesn't have
// (media pushes, the Task/Client picker, a health ping).
//
// Each event gets the tab's dashboard launch tickets here - the Figma login
// is a shared company account, so the ticket is what says whose prompt it
// was. getSettings(), buildApiErrorMessage() and getActiveLaunch() come from
// background-main.js (same service-worker global scope).
//
// Wired into background-main.js: FIGMA_CAPTURE_EVENT in handleRuntimeMessage,
// and runFigmaCaptureFlush / FIGMA_CAPTURE_RETRY_ALARM in all three of
// onStartup / onInstalled / onAlarm.

const FIGMA_CAPTURE_QUEUE_STORAGE_KEY = 'pendingFigmaCaptureEvents';
const FIGMA_CAPTURE_RETRY_ALARM = 'retryPendingFigmaCaptureEvents';
const FIGMA_CAPTURE_BATCH_MAX = 200;
const FIGMA_CAPTURE_FLUSH_QUIET_MS = 500;
const FIGMA_CAPTURE_FLUSH_MAX_WAIT_MS = 2000;
const FIGMA_CAPTURE_RETRY_MAX_ATTEMPTS = 12;
const FIGMA_CAPTURE_QUEUE_HARD_LIMIT = 3000;

let figmaCaptureQuietTimer = null;
let figmaCaptureMaxWaitTimer = null;
let figmaQueueChain = Promise.resolve();

function getFigmaCaptureRetryDelayMs(attempts) {
  const exponent = Math.max(0, Math.min(Number(attempts || 0), 6));
  return Math.min(30 * 1000 * Math.pow(2, exponent), 30 * 60 * 1000);
}

// Serializes read-modify-write of the stored queue (see
// background-splice-capture.js's withSpliceQueueLock).
function withFigmaQueueLock(criticalSection) {
  const result = figmaQueueChain.then(criticalSection, criticalSection);
  figmaQueueChain = result.then(() => {}, () => {});
  return result;
}

async function readFigmaCaptureQueue() {
  const stored = await chrome.storage.local.get([FIGMA_CAPTURE_QUEUE_STORAGE_KEY]);
  const queue = stored[FIGMA_CAPTURE_QUEUE_STORAGE_KEY];
  return Array.isArray(queue) ? queue.filter((item) => item && typeof item === 'object') : [];
}

async function writeFigmaCaptureQueue(queue) {
  if (queue.length > FIGMA_CAPTURE_QUEUE_HARD_LIMIT) {
    console.error('[RMW Figma Capture] queue over its ceiling - dropping the oldest events',
      { overflow: queue.length - FIGMA_CAPTURE_QUEUE_HARD_LIMIT });
    queue = queue.slice(queue.length - FIGMA_CAPTURE_QUEUE_HARD_LIMIT);
  }
  await chrome.storage.local.set({ [FIGMA_CAPTURE_QUEUE_STORAGE_KEY]: queue });
}

function scheduleFigmaCaptureRetry(delayMs) {
  try {
    if (chrome?.alarms?.create) {
      chrome.alarms.create(FIGMA_CAPTURE_RETRY_ALARM, { when: Date.now() + Math.max(5000, delayMs) });
      return;
    }
  } catch {}
  setTimeout(() => runFigmaCaptureFlush(), Math.max(5000, delayMs));
}

function scheduleFigmaCaptureFlush() {
  if (figmaCaptureQuietTimer) clearTimeout(figmaCaptureQuietTimer);
  figmaCaptureQuietTimer = setTimeout(runFigmaCaptureFlush, FIGMA_CAPTURE_FLUSH_QUIET_MS);
  if (!figmaCaptureMaxWaitTimer) {
    figmaCaptureMaxWaitTimer = setTimeout(runFigmaCaptureFlush, FIGMA_CAPTURE_FLUSH_MAX_WAIT_MS);
  }
}

function runFigmaCaptureFlush() {
  if (figmaCaptureQuietTimer) { clearTimeout(figmaCaptureQuietTimer); figmaCaptureQuietTimer = null; }
  if (figmaCaptureMaxWaitTimer) { clearTimeout(figmaCaptureMaxWaitTimer); figmaCaptureMaxWaitTimer = null; }
  return flushFigmaCaptureQueue().catch((error) => {
    console.error('[RMW Figma Capture] flush failed unexpectedly', error);
  });
}

async function enqueueFigmaCaptureEvent(event) {
  await withFigmaQueueLock(async () => {
    const queue = await readFigmaCaptureQueue();
    if (queue.some((item) => item.key === event.client_event_id)) return;
    queue.push({ key: event.client_event_id, event, enqueuedAt: Date.now(), attempts: 0, lastError: '', nextAttemptAt: 0 });
    await writeFigmaCaptureQueue(queue);
  });
  scheduleFigmaCaptureFlush();
}

async function postFigmaCaptureEventsBatch(settings, events) {
  const headers = { 'Content-Type': 'application/json' };
  if (settings.sessionToken) headers['X-Session-Id'] = settings.sessionToken;
  const response = await fetch(`${settings.apiBase}/api/providers/figma/capture/events`, {
    method: 'POST',
    credentials: 'include',
    headers,
    body: JSON.stringify({ events }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.success) {
    throw new Error(buildApiErrorMessage(data, response, 'Figma capture upload failed', settings));
  }
  return data;
}

async function flushFigmaCaptureQueue() {
  const now = Date.now();
  const queue = await readFigmaCaptureQueue();
  const ready = queue.filter((item) => Number(item.nextAttemptAt || 0) <= now);
  if (!ready.length) {
    const nextDueAt = queue.reduce((min, item) => Math.min(min, Number(item.nextAttemptAt || 0) || min), Infinity);
    if (Number.isFinite(nextDueAt)) scheduleFigmaCaptureRetry(nextDueAt - now);
    return;
  }

  const batch = ready.slice(0, FIGMA_CAPTURE_BATCH_MAX);
  const batchKeys = new Set(batch.map((item) => item.key));
  let uploaded = null;
  let uploadError = null;
  try {
    uploaded = await postFigmaCaptureEventsBatch(await getSettings(), batch.map((item) => item.event));
  } catch (error) {
    uploadError = error;
  }

  await withFigmaQueueLock(async () => {
    const latest = await readFigmaCaptureQueue();
    if (uploaded) {
      // An event the backend answered is done (created / updated / duplicate /
      // rejected); one it skipped after a server error stays for a retry.
      const answered = new Set((uploaded.results || []).map((r) => r.client_event_id));
      (uploaded.results || []).filter((r) => r.status === 'rejected')
        .forEach((r) => console.warn('[RMW Figma Capture] event rejected', r));
      const remaining = [];
      for (const item of latest) {
        if (!batchKeys.has(item.key)) { remaining.push(item); continue; }
        if (answered.has(item.key)) continue;
        const attempts = Number(item.attempts || 0) + 1;
        if (attempts <= FIGMA_CAPTURE_RETRY_MAX_ATTEMPTS) {
          remaining.push({ ...item, attempts, lastError: 'not answered', nextAttemptAt: now + getFigmaCaptureRetryDelayMs(attempts) });
        }
      }
      await writeFigmaCaptureQueue(remaining);
    } else {
      const message = `${uploadError?.message || uploadError || 'Figma capture upload failed'}`.slice(0, 500);
      const updated = [];
      for (const item of latest) {
        if (!batchKeys.has(item.key)) { updated.push(item); continue; }
        const attempts = Number(item.attempts || 0) + 1;
        if (attempts > FIGMA_CAPTURE_RETRY_MAX_ATTEMPTS) continue;
        updated.push({ ...item, attempts, lastError: message, nextAttemptAt: now + getFigmaCaptureRetryDelayMs(attempts) });
      }
      await writeFigmaCaptureQueue(updated);
    }
  });

  const finalQueue = await readFigmaCaptureQueue();
  if (finalQueue.some((item) => Number(item.nextAttemptAt || 0) <= Date.now())) {
    return flushFigmaCaptureQueue();
  }
  const nextDueAt = finalQueue.reduce((min, item) => Math.min(min, Number(item.nextAttemptAt || 0) || min), Infinity);
  if (Number.isFinite(nextDueAt)) scheduleFigmaCaptureRetry(nextDueAt - Date.now());
}

async function handleFigmaCaptureEventMessage(message, senderTabId = 0, openerTabId = 0) {
  const event = message?.event;
  if (!event || typeof event !== 'object' || !event.event_type || !event.client_event_id) {
    return { ok: false, error: 'Invalid capture event payload' };
  }
  const tabId = message.tabId || senderTabId || 0;
  // A file opened from Figma's file browser is a new tab: it carries its
  // opener's launch (getAuthorizedLaunchForTabs binds it), or we read the opener's.
  const directLaunch = await getActiveLaunch(tabId, 'figma');
  const activeLaunch = directLaunch?.ticket || directLaunch?.usageTrackingTicket
    ? directLaunch
    : await getActiveLaunch(openerTabId, 'figma');
  if (!activeLaunch?.ticket && !activeLaunch?.usageTrackingTicket) {
    return { ok: false, error: 'This Figma tab was not opened from the dashboard - prompt not recorded.' };
  }
  await enqueueFigmaCaptureEvent({
    ...event,
    extension_ticket: activeLaunch.ticket || undefined,
    usage_ticket: activeLaunch.usageTrackingTicket || undefined,
    extension_version: chrome.runtime.getManifest().version,
    tab_id: tabId || undefined,
  });
  return { ok: true, queued: true };
}
