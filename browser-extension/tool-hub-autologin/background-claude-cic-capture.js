// background-claude-cic-capture.js — loaded via importScripts() from
// background.js, after background-claude-capture.js (whose
// enqueueClaudeCaptureEvent/readClaudeCaptureFeatureFlags it reuses) and
// before background-main.js.
//
// Captures Claude in Chrome (the official Claude extension's side panel)
// conversations. Those cannot go through content-claude-*.js like a normal
// claude.ai tab, for two confirmed reasons (2026-10-01):
//   1. The side panel is chrome-extension://fcoeoabgfenejglbffodgkkbkcdhcgfn/
//      sidepanel.html embedding https://claude.ai/cic/... in an iframe, and
//      Chrome never injects one extension's content scripts into frames
//      inside another extension's page - window.__rmwClaudeNetworkTelemetry-
//      Installed was undefined inside that frame even with all_frames.
//   2. The side panel does not use the chat_conversations API at all. Each
//      chat is a "code session" (id cse_...) driven through
//      https://claude.ai/v1/code/sessions/{id}/events, carrying Claude Agent
//      SDK-shaped messages (user / assistant / result events).
//
// So instead this module (a) notices side panel activity through
// chrome.webRequest - the iframe's requests are ordinary https://claude.ai
// requests - and (b) reads the session back itself:
//   GET /v1/code/sessions/{id}          -> title, created_at, model
//   GET /v1/code/sessions/{id}/events   -> newest-first pages of events,
//                                          {data, next_cursor}
// then turns each completed turn into the same prompt_captured /
// response_completed events content-claude-capture.js produces, and hands
// them to the existing lossless Claude capture queue. client_event_ids are
// deterministic, so re-reading a session can never create duplicates.

const CLAUDE_CIC_STATE_STORAGE_KEY = 'claudeCicCaptureState';
const CLAUDE_CIC_POLL_ALARM = 'syncClaudeInChromeSessions';
const CLAUDE_CIC_API_BASE = 'https://claude.ai/v1/code/sessions';
const CLAUDE_CIC_SESSION_URL_RE = /^https:\/\/claude\.ai\/v1\/code\/sessions\/(cse_[A-Za-z0-9]+)(?:[/?#]|$)/;
const CLAUDE_CIC_HEADERS = {
  'anthropic-version': '2023-06-01',
  'anthropic-beta': 'ccr-byoc-2025-07-29',
  'anthropic-client-feature': 'ccr',
  'anthropic-client-platform': 'web_claude_ai',
};
const CLAUDE_CIC_PAGE_LIMIT = 100;
const CLAUDE_CIC_MAX_PAGES = 30;
const CLAUDE_CIC_SYNC_DEBOUNCE_MS = 4000;
// The side panel pings presence/mark_read every few seconds while open;
// without this every ping would re-read the whole recent event page.
const CLAUDE_CIC_MIN_SYNC_INTERVAL_MS = 15000;
// Sessions with activity inside this window keep being re-synced by the
// alarm, which catches a reply that finishes after the last request we saw.
const CLAUDE_CIC_ACTIVE_WINDOW_MS = 20 * 60 * 1000;
const CLAUDE_CIC_MAX_TRACKED_SESSIONS = 200;
const CLAUDE_CIC_MAX_EMITTED_KEYS_PER_SESSION = 3000;
const CLAUDE_CIC_MAX_TYPED_PROMPTS_PER_SESSION = 1000;
// Same rule as content-claude-capture.js's NEW_CONVERSATION_AGE_THRESHOLD_MS.
const CLAUDE_CIC_NEW_SESSION_AGE_MS = 5 * 60 * 1000;

const claudeCicSyncTimers = new Map();
const claudeCicSyncInFlight = new Map();
const claudeCicSurfaceBySession = new Map();

function claudeCicLog(...args) {
  console.info('[RMW Claude-in-Chrome]', ...args);
}

// Bump when the parsing rules change, so a reload is visible in the console.
const CLAUDE_CIC_PARSER_VERSION = 5;
claudeCicLog(`capture module loaded (parser v${CLAUDE_CIC_PARSER_VERSION})`);

// ---- Persisted per-session state ------------------------------------------
// { [sessionId]: { lastActivityAt, lastSyncAt, isNew, title, updatedAt,
//                  surface, emitted: [clientEventId, ...] } }
let claudeCicStateLock = Promise.resolve();
function withClaudeCicState(task) {
  const run = claudeCicStateLock.then(async () => {
    const stored = await chrome.storage.local.get([CLAUDE_CIC_STATE_STORAGE_KEY]);
    const state = stored[CLAUDE_CIC_STATE_STORAGE_KEY] && typeof stored[CLAUDE_CIC_STATE_STORAGE_KEY] === 'object'
      ? stored[CLAUDE_CIC_STATE_STORAGE_KEY]
      : {};
    const result = await task(state);
    const ids = Object.keys(state);
    if (ids.length > CLAUDE_CIC_MAX_TRACKED_SESSIONS) {
      ids
        .sort((a, b) => Number(state[a]?.lastActivityAt || 0) - Number(state[b]?.lastActivityAt || 0))
        .slice(0, ids.length - CLAUDE_CIC_MAX_TRACKED_SESSIONS)
        .forEach((id) => { delete state[id]; });
    }
    await chrome.storage.local.set({ [CLAUDE_CIC_STATE_STORAGE_KEY]: state });
    return result;
  });
  claudeCicStateLock = run.then(() => undefined, () => undefined);
  return run;
}

// ---- Reading the session from claude.ai -----------------------------------
// Direct fetch from the service worker first (host permission for claude.ai
// makes Chrome attach the user's claude.ai cookies). If claude.ai refuses
// that (401/403, or a network-level refusal), relay the same GET through an
// open claude.ai tab, whose content script fetches same-origin.
async function claudeCicFetchJsonDirect(path) {
  const response = await fetch(`${CLAUDE_CIC_API_BASE}${path}`, {
    method: 'GET',
    credentials: 'include',
    headers: CLAUDE_CIC_HEADERS,
  });
  const body = await response.json().catch(() => null);
  return { status: response.status, body };
}

async function claudeCicFetchJsonViaTab(path) {
  const tabs = await chrome.tabs.query({ url: ['https://claude.ai/*'] }).catch(() => []);
  for (const tab of tabs) {
    if (typeof tab.id !== 'number') continue;
    try {
      const result = await chrome.tabs.sendMessage(
        tab.id,
        { type: 'CLAUDE_CIC_FETCH', url: `${CLAUDE_CIC_API_BASE}${path}`, headers: CLAUDE_CIC_HEADERS },
        { frameId: 0 }
      );
      if (result && typeof result.status === 'number') return result;
    } catch {}
  }
  return null;
}

async function claudeCicFetchJson(path) {
  let direct = null;
  try {
    direct = await claudeCicFetchJsonDirect(path);
    if (direct.status >= 200 && direct.status < 300) return direct.body;
  } catch (error) {
    direct = { status: 0, error: `${error?.message || error}` };
  }
  const relayed = await claudeCicFetchJsonViaTab(path);
  if (relayed && relayed.status >= 200 && relayed.status < 300) return relayed.body;
  const error = new Error(
    `claude.ai ${path} failed (direct=${direct?.status ?? 'n/a'}${direct?.error ? ` ${direct.error}` : ''}, `
    + `via tab=${relayed ? relayed.status : 'no claude.ai tab'})`
  );
  error.status = relayed?.status || direct?.status || 0;
  throw error;
}

// Newest-first pages. Stops as soon as a page reaches events this session
// already fully emitted (older history is done), when there is no further
// cursor, or if the cursor stops moving.
async function claudeCicFetchRecentEvents(sessionId, alreadyEmittedEventIds) {
  const collected = [];
  const seenEventIds = new Set();
  let cursor = '';
  for (let page = 0; page < CLAUDE_CIC_MAX_PAGES; page += 1) {
    const query = new URLSearchParams({ limit: String(CLAUDE_CIC_PAGE_LIMIT) });
    if (cursor) query.set('cursor', cursor);
    const body = await claudeCicFetchJson(`/${encodeURIComponent(sessionId)}/events?${query.toString()}`);
    const data = Array.isArray(body?.data) ? body.data : [];
    let fresh = 0;
    let reachedKnown = false;
    for (const item of data) {
      const id = item?.event_id || item?.payload?.uuid;
      if (!id || seenEventIds.has(id)) continue;
      seenEventIds.add(id);
      fresh += 1;
      collected.push(item);
      if (alreadyEmittedEventIds.has(id)) reachedKnown = true;
    }
    const nextCursor = `${body?.next_cursor ?? ''}`;
    if (!fresh || reachedKnown || !nextCursor || nextCursor === cursor) break;
    cursor = nextCursor;
  }
  return collected;
}

// ---- Turning SDK events into capture events --------------------------------
function claudeCicTextFromContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n\n');
}

function claudeCicIsToolResultMessage(content) {
  return Array.isArray(content) && content.some((block) => block?.type === 'tool_result');
}

function claudeCicCodeBlocks(text) {
  const blocks = [];
  const pattern = /```([a-zA-Z0-9_+-]*)\n([\s\S]*?)```/g;
  let match = pattern.exec(text || '');
  while (match && blocks.length < 20) {
    blocks.push({ language: match[1] || undefined, code: (match[2] || '').slice(0, 8000) });
    match = pattern.exec(text || '');
  }
  return blocks;
}

// Claude in Chrome sends extra user-role messages right after the real
// prompt that are context for the model, not something the user typed
// (confirmed 2026-10-01: availableTabs JSON, "You are running in the Claude
// in Chrome side panel...", "The user's timezone is ..."), each wrapped in
// <system-reminder>. Stripping them leaves the real prompt; a message that
// was only reminders is not a prompt at all.
const CLAUDE_CIC_REMINDER_RE = /<system-reminder>[\s\S]*?<\/system-reminder>/g;
function claudeCicCleanPromptText(text) {
  return `${text || ''}`.replace(CLAUDE_CIC_REMINDER_RE, '').trim();
}

// A turn = a real user prompt (not a tool_result echo, not a subagent
// message), every top-level assistant message after it, and the 'result'
// event that marks the turn finished. A turn without its result yet is
// still running: its prompt is emitted now, its response on a later sync.
// `events` arrives newest-first (API page order, older pages appended), so
// reversing gives the session's own sequence. Deliberately not re-sorted by
// created_at: events posted in one batch share near-identical timestamps,
// and the API's order is the authoritative one.
function claudeCicBuildTurns(events) {
  const ordered = events.slice().reverse();
  const turns = [];
  let current = null;
  let mentionsClaudeInChrome = false;
  for (const item of ordered) {
    const type = item?.event_type || item?.payload?.type;
    const payload = item?.payload || {};
    if (payload.parent_tool_use_id) continue; // subagent traffic
    if (type === 'user') {
      const content = payload.message?.content;
      if (claudeCicIsToolResultMessage(content)) {
        if (current) current.endsWithResult = false;
        continue;
      }
      const rawText = claudeCicTextFromContent(content);
      if (/Claude in Chrome/i.test(rawText)) mentionsClaudeInChrome = true;
      const text = claudeCicCleanPromptText(rawText);
      if (!text) continue;
      current = {
        promptId: payload.uuid || item.event_id,
        promptText: text,
        promptAt: item.created_at,
        responseTexts: [],
        tools: [],
        model: '',
        result: null,
      };
      turns.push(current);
    } else if (type === 'assistant' && current) {
      current.sawAssistant = true;
      current.endsWithResult = false;
      const message = payload.message || {};
      if (message.model) current.model = message.model;
      const text = claudeCicTextFromContent(message.content).trim();
      if (text) current.responseTexts.push(text);
      (Array.isArray(message.content) ? message.content : [])
        .filter((block) => block?.type === 'tool_use')
        .forEach((block) => {
          current.tools.push({
            type: 'tool_use',
            name: block.name || undefined,
            description: `${block.input?.description || ''}`.slice(0, 300) || undefined,
          });
        });
    } else if (type === 'result' && current) {
      // Not the end of the turn by itself: a turn can log more than one
      // result event (confirmed 2026-10-01 - replies captured empty because
      // the first result closed the turn before the answer's own assistant
      // event). The LAST result before the next prompt wins; whether the
      // turn is actually over is decided below.
      current.result = { id: item.event_id || payload.uuid, at: item.created_at, isError: Boolean(payload.is_error) };
      // Confirmed timeline (2026-10-01): prompt -> result -> thinking ->
      // tool_use/tool_result ... -> text -> result. The early result has
      // no assistant event before it; the closing one does and nothing
      // follows it.
      current.endsWithResult = Boolean(current.sawAssistant);
    }
  }
  // A turn is final once a later real prompt exists, or - for the newest
  // turn - once the session reports it is idle (sessionIdle is applied by
  // the caller). Only final turns get a response_completed, so the reply
  // text is never captured half-written.
  turns.forEach((turn, index) => { turn.followedByPrompt = index < turns.length - 1; });
  return { turns, mentionsClaudeInChrome };
}

// Compact view of what a sync read, for diagnosing from the console.
function claudeCicTimeline(events) {
  return events.slice().reverse()
    .filter((item) => ['user', 'assistant', 'result'].includes(item?.event_type))
    .map((item) => {
      const message = item.payload?.message || {};
      const content = message.content;
      const blocks = Array.isArray(content) ? content.map((block) => block?.type).join('+') : typeof content;
      const text = item.event_type === 'result' ? '' : claudeCicTextFromContent(content).replace(/\s+/g, ' ').slice(0, 60);
      return `${item.event_type}${item.payload?.parent_tool_use_id ? '(sub)' : ''} [${blocks}] ${text}`;
    });
}

function claudeCicEnvelope(eventType, { conversationId, messageId, clientEventId, payload }) {
  let extensionVersion;
  try { extensionVersion = chrome.runtime.getManifest().version; } catch {}
  return {
    event_type: eventType,
    client_event_id: clientEventId,
    conversation_id: conversationId,
    message_id: messageId || undefined,
    payload: payload || {},
    capture_version: 1,
    extension_version: extensionVersion || undefined,
    browser: 'chrome',
    event_date: new Date().toISOString().slice(0, 10),
  };
}

// ---- Sync ------------------------------------------------------------------
async function claudeCicSyncSession(sessionId) {
  if (claudeCicSyncInFlight.has(sessionId)) return claudeCicSyncInFlight.get(sessionId);
  const run = claudeCicSyncSessionNow(sessionId).finally(() => claudeCicSyncInFlight.delete(sessionId));
  claudeCicSyncInFlight.set(sessionId, run);
  return run;
}

// Event ids (not client_event_ids) of prompts/results already emitted, used
// only to stop paging once we reach already-captured history.
function claudeCicFetchRecentEventsForSession(sessionId, prior) {
  const emittedEventIds = new Set(
    (Array.isArray(prior.emitted) ? prior.emitted : []).map((key) => key.split(':').pop()).filter(Boolean)
  );
  return claudeCicFetchRecentEvents(sessionId, emittedEventIds);
}

async function claudeCicSyncSessionNow(sessionId) {
  const flags = await readClaudeCaptureFeatureFlags();
  if (!flags.enableCapture) return { skipped: 'capture_disabled' };

  const prior = await withClaudeCicState((state) => {
    const entry = state[sessionId] || (state[sessionId] = { emitted: [] });
    entry.lastSyncAt = Date.now();
    return JSON.parse(JSON.stringify(entry));
  });
  const emitted = new Set(Array.isArray(prior.emitted) ? prior.emitted : []);
  const typedPromptIds = new Set(Array.isArray(prior.typedPromptIds) ? prior.typedPromptIds : []);

  const session = await claudeCicFetchJson(`/${encodeURIComponent(sessionId)}`);
  const events = await claudeCicFetchRecentEventsForSession(sessionId, prior);
  const { turns, mentionsClaudeInChrome } = claudeCicBuildTurns(events);
  // Decided once, at first observation - same ownership rule the normal
  // claude.ai capture uses (backend _is_attributable): only a chat that
  // started in front of this browser is claimed for this user. Measured
  // from the first real prompt, not session.created_at: Claude in Chrome
  // creates its session ahead of time (confirmed: sessions were already
  // older than 5 minutes when their first prompt was sent), so created_at
  // made every side panel chat look old and left it unowned.
  const firstPromptAtMs = Date.parse(turns[0]?.promptAt || '') || 0;
  const isNew = typeof prior.isNew === 'boolean'
    ? prior.isNew
    : (!turns.length || Boolean(firstPromptAtMs && Date.now() - firstPromptAtMs <= CLAUDE_CIC_NEW_SESSION_AGE_MS));
  // The side panel's own context reminder is the reliable signal - tabId
  // is not: confirmed a side panel session whose requests carried a real
  // tabId.
  const surface = mentionsClaudeInChrome
    ? 'claude_in_chrome'
    : (prior.surface || claudeCicSurfaceBySession.get(sessionId) || 'claude_in_chrome');
  const title = `${session?.title || ''}`.trim();
  // Session fields seen live: worker_status "idle", status_bucket
  // "completed" once Claude has finished replying.
  const sessionIdle = session?.worker_status === 'idle'
    || session?.status_bucket === 'completed'
    || session?.post_turn_summary?.status_category === 'completed';
  const model = session?.config?.model || session?.external_metadata?.last_served_model || '';
  const context = {
    isNewConversation: isNew,
    providerCreatedAt: turns[0]?.promptAt || session?.created_at || undefined,
    surface,
    sessionKind: 'code_session',
  };


  const outgoing = [];
  const conversationKey = `claude:${sessionId}:session-meta:${title}|${session?.updated_at || ''}`;
  if (!emitted.has(`claude:${sessionId}:session-opened`)) {
    outgoing.push({
      key: `claude:${sessionId}:session-opened`,
      event: claudeCicEnvelope(isNew ? 'conversation_created' : 'conversation_opened', {
        conversationId: sessionId,
        clientEventId: `claude:${sessionId}:session-opened`,
        payload: {
          title: title || undefined,
          url: session?.session_url || `https://claude.ai/cic/task/${sessionId}`,
          model: model || undefined,
          providerUpdatedAt: session?.updated_at || undefined,
          ...context,
        },
      }),
    });
  } else if (title && title !== prior.title) {
    // Title arrives after the first turn (auto-titling) - refresh it.
    outgoing.push({
      key: conversationKey,
      transient: true,
      event: claudeCicEnvelope('conversation_opened', {
        conversationId: sessionId,
        clientEventId: conversationKey.slice(0, 160),
        payload: {
          title,
          url: session?.session_url || `https://claude.ai/cic/task/${sessionId}`,
          model: model || undefined,
          providerUpdatedAt: session?.updated_at || undefined,
          ...context,
        },
      }),
    });
  }

  turns.forEach((turn, index) => {
    const typedHere = typedPromptIds.has(turn.promptId);
    // Typed prompts use their own key so a prompt first emitted without the
    // flag (its send request recorded a moment after a sync) is sent again
    // once with it; the backend upserts the same prompt row by message id.
    const promptKey = typedHere
      ? `claude:${sessionId}:prompt:typed:${turn.promptId}`
      : `claude:${sessionId}:prompt:${turn.promptId}`;
    if (!emitted.has(promptKey)) {
      outgoing.push({
        key: promptKey,
        event: claudeCicEnvelope('prompt_captured', {
          conversationId: sessionId,
          messageId: turn.promptId,
          clientEventId: promptKey,
          payload: {
            text: turn.promptText,
            textLength: turn.promptText.length,
            codeBlocks: claudeCicCodeBlocks(turn.promptText),
            promptTimestamp: turn.promptAt || undefined,
            sequenceIndex: index,
            ...context,
            typedInThisBrowser: typedPromptIds.has(turn.promptId) || undefined,
          },
        }),
      });
    }
    // sessionIdle alone is not enough: with the side panel still open the
    // session never reports idle (confirmed), which held back the newest
    // reply indefinitely.
    const turnIsFinal = turn.followedByPrompt || turn.endsWithResult || sessionIdle;
    if (turn.result?.id && turnIsFinal) {
      // v3 in the key: earlier parser versions emitted these same turns with
      // empty text under the plain key. Same message_id (the result id), so
      // the backend updates that existing response row in place.
      const responseKey = `claude:${sessionId}:response:v3:${turn.result.id}`;
      if (!emitted.has(responseKey)) {
        const text = turn.responseTexts.join('\n\n');
        outgoing.push({
          key: responseKey,
          event: claudeCicEnvelope('response_completed', {
            conversationId: sessionId,
            messageId: turn.result.id,
            clientEventId: responseKey,
            payload: {
              text,
              textLength: text.length,
              codeBlocks: claudeCicCodeBlocks(text),
              hasMarkdown: /(^|\n)#{1,6}\s|\*\*[^*]+\*\*|`[^`]+`|(^|\n)[-*]\s/.test(text),
              hasTables: /\|.+\|\n\|[-:| ]+\|/.test(text),
              contentParts: turn.tools.length ? turn.tools.slice(0, 100) : undefined,
              model: turn.model || model || undefined,
              completedAt: turn.result.at || undefined,
              parentMessageId: turn.promptId,
              isError: turn.result.isError || undefined,
              ...context,
            },
          }),
        });
      }
    }
  });

  const enqueuedKeys = [];
  for (const item of outgoing) {
    try {
      await enqueueClaudeCaptureEvent(item.event);
      if (!item.transient) enqueuedKeys.push(item.key);
    } catch (error) {
      claudeCicLog('enqueue failed, will retry next sync', item.key, error?.message || error);
    }
  }

  await withClaudeCicState((state) => {
    const entry = state[sessionId] || (state[sessionId] = { emitted: [] });
    const merged = new Set([...(entry.emitted || []), ...enqueuedKeys]);
    entry.emitted = [...merged].slice(-CLAUDE_CIC_MAX_EMITTED_KEYS_PER_SESSION);
    entry.isNew = isNew;
    entry.surface = surface;
    if (title) entry.title = title;
    entry.updatedAt = session?.updated_at || entry.updatedAt;
    entry.lastSyncAt = Date.now();
  });

  if (outgoing.length) {
    claudeCicLog(`session ${sessionId}: queued ${enqueuedKeys.length} new event(s)`, {
      parserVersion: CLAUDE_CIC_PARSER_VERSION, title: title || '(untitled)', turns: turns.length, eventsRead: events.length, isNew, surface,
    });
  }
  return {
    parserVersion: CLAUDE_CIC_PARSER_VERSION,
    queued: enqueuedKeys.length,
    turns: turns.length,
    eventsRead: events.length,
    surface,
    timeline: claudeCicTimeline(events),
  };
}

function scheduleClaudeCicSync(sessionId, { immediate = false } = {}) {
  withClaudeCicState((state) => {
    const entry = state[sessionId] || (state[sessionId] = { emitted: [] });
    entry.lastActivityAt = Date.now();
    return Number(entry.lastSyncAt || 0);
  }).then((lastSyncAt) => {
    if (claudeCicSyncTimers.has(sessionId)) return;
    const now = Date.now();
    const delay = immediate
      ? 0
      : Math.max(CLAUDE_CIC_SYNC_DEBOUNCE_MS, lastSyncAt + CLAUDE_CIC_MIN_SYNC_INTERVAL_MS - now);
    claudeCicSyncTimers.set(sessionId, setTimeout(() => {
      claudeCicSyncTimers.delete(sessionId);
      claudeCicSyncSession(sessionId).catch((error) => {
        claudeCicLog(`sync failed for ${sessionId} - will retry`, error?.message || error);
      });
    }, delay));
  }).catch(() => {});

  try {
    chrome.alarms.create(CLAUDE_CIC_POLL_ALARM, { periodInMinutes: 1 });
  } catch {}
}

async function syncActiveClaudeCicSessions() {
  const stored = await chrome.storage.local.get([CLAUDE_CIC_STATE_STORAGE_KEY]);
  const state = stored[CLAUDE_CIC_STATE_STORAGE_KEY] || {};
  const now = Date.now();
  const active = Object.keys(state).filter(
    (id) => now - Number(state[id]?.lastActivityAt || 0) < CLAUDE_CIC_ACTIVE_WINDOW_MS
  );
  if (!active.length) {
    try { chrome.alarms.clear(CLAUDE_CIC_POLL_ALARM); } catch {}
    return;
  }
  for (const id of active) {
    await claudeCicSyncSession(id).catch((error) => {
      claudeCicLog(`periodic sync failed for ${id}`, error?.message || error);
    });
  }
}

// ---- Who typed it ------------------------------------------------------------
// The side panel sends each prompt with POST /v1/code/sessions/{id}/events,
// body {events: [{payload: {type: "user", uuid, message}}, ...]} (confirmed
// 2026-10-01). Seeing that request in THIS browser is direct proof the
// prompt was typed here, by the dashboard user this extension is logged in
// as - unlike merely opening an old chat from the side panel's history,
// which only issues GETs. Recorded per prompt uuid; the sync marks those
// prompts typedInThisBrowser, and the backend lets that claim an unowned
// conversation (providers/claude/normalization.py).
function claudeCicTypedPromptIdsFromBody(requestBody) {
  try {
    const raw = requestBody?.raw;
    if (!Array.isArray(raw) || !raw.length) return [];
    const decoder = new TextDecoder();
    const text = raw.map((part) => (part?.bytes ? decoder.decode(part.bytes) : '')).join('');
    const body = JSON.parse(text);
    return (Array.isArray(body?.events) ? body.events : [])
      .map((entry) => entry?.payload)
      .filter((payload) => {
        if (payload?.type !== 'user' || !payload.uuid || payload.parent_tool_use_id) return false;
        const content = payload.message?.content;
        if (claudeCicIsToolResultMessage(content)) return false;
        return Boolean(claudeCicCleanPromptText(claudeCicTextFromContent(content)));
      })
      .map((payload) => payload.uuid);
  } catch {
    return [];
  }
}

function recordClaudeCicTypedPrompts(sessionId, promptIds) {
  if (!promptIds.length) return Promise.resolve();
  return withClaudeCicState((state) => {
    const entry = state[sessionId] || (state[sessionId] = { emitted: [] });
    const merged = new Set([...(entry.typedPromptIds || []), ...promptIds]);
    entry.typedPromptIds = [...merged].slice(-CLAUDE_CIC_MAX_TYPED_PROMPTS_PER_SESSION);
    entry.lastActivityAt = Date.now();
  }).then(() => {
    claudeCicLog(`prompt typed in this browser: ${sessionId}`, promptIds);
  }).catch(() => {});
}

// ---- Wiring ------------------------------------------------------------------
try {
  chrome.webRequest.onBeforeRequest.addListener(
    (details) => {
      if (details.method !== 'POST') return;
      const match = /^https:\/\/claude\.ai\/v1\/code\/sessions\/(cse_[A-Za-z0-9]+)\/events(?:[?#]|$)/.exec(details.url || '');
      if (!match) return;
      recordClaudeCicTypedPrompts(match[1], claudeCicTypedPromptIdsFromBody(details.requestBody));
    },
    { urls: ['https://claude.ai/v1/code/sessions/*'] },
    ['requestBody']
  );
} catch (error) {
  console.error('[RMW Claude-in-Chrome] could not watch prompt sends - typed-prompt attribution disabled', error);
}

// Registered at top level so the MV3 service worker is woken for them.
try {
  chrome.webRequest.onCompleted.addListener(
    (details) => {
      const match = CLAUDE_CIC_SESSION_URL_RE.exec(details.url || '');
      if (!match) return;
      const sessionId = match[1];
      // The side panel is not a tab, so its requests carry tabId -1; the same
      // API used from a normal tab is Claude Code on the web.
      if (!claudeCicSurfaceBySession.has(sessionId)) {
        claudeCicSurfaceBySession.set(sessionId, details.tabId >= 0 ? 'claude_code_web' : 'claude_in_chrome');
        claudeCicLog(`session seen: ${sessionId}`, { tabId: details.tabId, method: details.method });
      }
      scheduleClaudeCicSync(sessionId);
    },
    { urls: ['https://claude.ai/v1/code/sessions/*'] }
  );
} catch (error) {
  console.error('[RMW Claude-in-Chrome] webRequest listener unavailable - side panel capture disabled', error);
}

try {
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm?.name === CLAUDE_CIC_POLL_ALARM) {
      syncActiveClaudeCicSessions().catch(() => {});
    }
  });
} catch {}

// Manual hook for testing from the service worker console:
//   claudeCicCaptureNow('cse_...')
function claudeCicCaptureNow(sessionId) {
  return claudeCicSyncSession(`${sessionId || ''}`.trim()).then((result) => {
    claudeCicLog('manual sync result', result);
    return result;
  });
}
