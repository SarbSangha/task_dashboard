(function installRmwClaudeNetworkTelemetry() {
  // MAIN-world network interception for Claude (claude.ai) raw capture.
  // Same reason as content-chatgpt-network.js/content-kling-network.js: the
  // isolated world cannot see the page's real fetch calls, so this hooks
  // window.fetch in the page's own JS realm and hands structured signals
  // across via window.postMessage to the isolated-world adapter
  // (content-claude-capture.js), which builds Capture Contract events and
  // forwards them to the background worker.
  //
  // MUCH simpler than ChatGPT's network script on purpose - see
  // backend/providers/claude/CAPTURE_CONTRACT.md's "How this differs from
  // ChatGPT's capture" section. Claude's own web client re-fetches the
  // COMPLETE, authoritative message tree via
  // GET /api/organizations/{orgId}/chat_conversations/{conversationId}?tree=True&...
  // after every turn, on every page load, and on every conversation switch
  // (confirmed live: captured immediately after two ordinary chat turns,
  // header-to-body). There is no SSE frame protocol to reconstruct here -
  // capture means reading that one response and letting the isolated world
  // diff it against messages already seen in this tab. The completion POST
  // is only used as a belt-and-suspenders trigger for a manual re-fetch of
  // that same snapshot (see maybeTriggerFollowUpSnapshotFetch below), not as
  // a content source itself.

  if (window.__rmwClaudeNetworkTelemetryInstalled) return;
  window.__rmwClaudeNetworkTelemetryInstalled = true;

  const SOURCE = 'rmw-claude-network';

  const CLAUDE_HOST_RE = /(^|\.)claude\.ai$/i;
  function isClaudeHost() {
    try {
      return CLAUDE_HOST_RE.test(location.hostname || '');
    } catch {
      return false;
    }
  }
  if (!isClaudeHost()) return;

  // Captures {orgId, conversationUuid} - deliberately does NOT match a
  // sub-path (.../completion, .../title, etc.): the (?:[?#]|$) terminator
  // only matches immediately after the uuid, so a completion POST's URL
  // (which continues with "/completion") never matches this pattern.
  //
  // `chat_conversations(?:_v\d+)?`: confirmed live 2026-09-30, claude.ai
  // started calling chat_conversations_v2 (list endpoint seen directly) and
  // capture silently stopped - the old literal `chat_conversations/` never
  // matched again. Accepting any _vN suffix keeps the next rename from
  // doing the same.
  const SNAPSHOT_URL_RE = /\/api\/organizations\/([^/]+)\/chat_conversations(?:_v\d+)?\/([0-9a-fA-F-]{36})(?:[?#]|$)/;
  const COMPLETION_URL_RE = /\/api\/organizations\/([^/]+)\/chat_conversations(?:_v\d+)?\/([0-9a-fA-F-]{36})\/completion(?:[?#]|$)/;
  // Any request scoped to one conversation (snapshot, completion, title,
  // whatever sub-path a future client uses) - the fallback observer below
  // treats the end of any of these as "this conversation may have changed".
  const CONVERSATION_SCOPED_URL_RE = /\/api\/organizations\/([^/]+)\/chat_conversations(?:_v\d+)?\/([0-9a-fA-F-]{36})(?:[/?#]|$)/;
  const ORG_URL_RE = /\/api\/organizations\/([0-9a-fA-F-]{36})\//;
  // /cic/{uuid}: Claude in Chrome's side panel embeds claude.ai in an iframe
  // under /cic/ (sidepanel loads https://claude.ai/cic/new?surface=cic_sidepanel)
  // - same web app, same conversation APIs, different page path.
  const CHAT_PAGE_RE = /^\/(?:chat|cic)\/([0-9a-fA-F-]{36})/;

  function normalizeUrl(input) {
    try {
      if (typeof input === 'string') return new URL(input, location.href).href;
      if (input && typeof input.url === 'string') return new URL(input.url, location.href).href;
    } catch {}
    return `${input || ''}`;
  }

  function normalizeMethod(input, init) {
    const raw = init?.method || (input && typeof input === 'object' ? input.method : null) || 'GET';
    return `${raw}`.toUpperCase();
  }

  function postSignal(type, payload) {
    try {
      window.postMessage({ source: SOURCE, type, payload: { ...payload, capturedAt: Date.now() } }, location.origin);
    } catch {}
  }

  // conversationUuid -> last time a snapshot for it was seen by the fetch
  // hook or requested by us - lets the PerformanceObserver fallback below
  // skip conversations the hook is already covering, and skip the entries
  // our own follow-up fetches produce (which would otherwise loop).
  const lastSnapshotActivityAt = new Map();
  function markSnapshotActivity(conversationUuid) {
    if (conversationUuid) lastSnapshotActivityAt.set(conversationUuid, Date.now());
  }
  function hadRecentSnapshotActivity(conversationUuid, windowMs) {
    return Date.now() - (lastSnapshotActivityAt.get(conversationUuid) || 0) < windowMs;
  }

  // Resolves true only when a usable snapshot was actually posted. Activity
  // is marked only then, so an unusable page response (e.g. a v2 body shape
  // this parser doesn't know) doesn't stop the fallback observer from
  // fetching a usable snapshot itself.
  async function handleSnapshotResponse(url, response, match) {
    if (!response.ok) return false;
    let body;
    try {
      body = await response.json();
    } catch {
      return false; // not JSON, or body already unusable - nothing to capture
    }
    if (!body || typeof body !== 'object') return false;
    const messages = Array.isArray(body.chat_messages) ? body.chat_messages
      : Array.isArray(body.messages) ? body.messages
      : null;
    if (!messages) return false;
    markSnapshotActivity(match[2]);
    postSignal('CLAUDE_CONVERSATION_SNAPSHOT', {
      organizationId: match[1],
      conversationUuid: match[2] || body.uuid,
      url,
      conversation: body.chat_messages === messages ? body : { ...body, chat_messages: messages },
    });
    return true;
  }

  function handleDeleteResponse(url, response, match) {
    if (!response.ok) return;
    postSignal('CLAUDE_CONVERSATION_DELETED', {
      organizationId: match[1],
      conversationUuid: match[2],
      url,
    });
  }

  // Belt-and-suspenders only (see file header) - drains a CLONED copy of the
  // completion stream (never touches the body the page itself reads) purely
  // to learn when the assistant's turn has finished, then performs our own
  // authenticated GET of the exact same snapshot endpoint Claude's own
  // client already calls in the common case. A short grace delay after the
  // stream ends gives Claude's own client a chance to finish its own write/
  // refetch cycle first; our own fetch still fires regardless, since two
  // observations of the same message are a free no-op downstream (see
  // CAPTURE_CONTRACT.md's deterministic client_event_id).
  const FOLLOW_UP_GRACE_MS = 500;
  const FOLLOW_UP_MAX_DRAIN_MS = 5 * 60 * 1000; // a very long response should still eventually resolve this

  // The v1 URL is the one confirmed live to return the full message tree;
  // _v2 is tried only if v1 stops yielding a usable snapshot.
  const SNAPSHOT_ENDPOINT_NAMES = ['chat_conversations', 'chat_conversations_v2'];
  function buildSnapshotUrl(orgId, conversationUuid, endpointName = SNAPSHOT_ENDPOINT_NAMES[0]) {
    return `${location.origin}/api/organizations/${orgId}/${endpointName}/${conversationUuid}?tree=True&rendering_mode=messages&render_all_tools=true&include_inline_comparison=true&consistency=eventual`;
  }

  async function drainToCompletion(response) {
    const reader = response.body?.getReader?.();
    if (!reader) return;
    const deadline = Date.now() + FOLLOW_UP_MAX_DRAIN_MS;
    try {
      // eslint-disable-next-line no-constant-condition
      while (true) {
        if (Date.now() > deadline) return;
        const { done } = await reader.read();
        if (done) return;
      }
    } catch {
      // Aborted (navigation, stop button) - fine, just stop draining.
    }
  }

  // Always the native fetch captured at document_start, never window.fetch:
  // see the PerformanceObserver fallback below for why window.fetch can't be
  // trusted to still be ours later in the page's life.
  async function fetchSnapshotDirectly(orgId, conversationUuid) {
    for (const endpointName of SNAPSHOT_ENDPOINT_NAMES) {
      // Marked before each request so the observer ignores the resource
      // entry our own fetch produces (which would otherwise loop).
      markSnapshotActivity(conversationUuid);
      try {
        const snapshotResponse = await originalFetch.call(
          window,
          buildSnapshotUrl(orgId, conversationUuid, endpointName),
          { credentials: 'include' }
        );
        if (await handleSnapshotResponse(snapshotResponse.url, snapshotResponse, [null, orgId, conversationUuid])) return true;
      } catch {}
    }
    return false;
  }

  function maybeTriggerFollowUpSnapshotFetch(orgId, conversationUuid, response) {
    drainToCompletion(response)
      .then(() => new Promise((resolve) => setTimeout(resolve, FOLLOW_UP_GRACE_MS)))
      .then(() => fetchSnapshotDirectly(orgId, conversationUuid))
      .catch(() => {});
  }

  const originalFetch = window.fetch;
  window.fetch = function rmwClaudeFetch(input, init) {
    const url = normalizeUrl(input);
    const method = normalizeMethod(input, init);
    const resultPromise = originalFetch.call(this, input, init);

    try {
      const snapshotMatch = SNAPSHOT_URL_RE.exec(url);
      const completionMatch = COMPLETION_URL_RE.exec(url);

      if (snapshotMatch && method === 'GET') {
        resultPromise.then((response) => handleSnapshotResponse(url, response.clone(), snapshotMatch)).catch(() => {});
      } else if (snapshotMatch && method === 'DELETE') {
        resultPromise.then((response) => handleDeleteResponse(url, response.clone(), snapshotMatch)).catch(() => {});
      } else if (completionMatch && method === 'POST') {
        resultPromise
          .then((response) => maybeTriggerFollowUpSnapshotFetch(completionMatch[1], completionMatch[2], response.clone()))
          .catch(() => {});
      }
    } catch {}

    return resultPromise;
  };

  // Fallback that does not depend on window.fetch staying hooked. Confirmed
  // live (2026-09-30): after capturing a conversation normally, a claude.ai
  // tab stopped producing ANY capture events - window.__rmwClaudeNetwork-
  // TelemetryInstalled was still true, but window.fetch.name was '' instead
  // of 'rmwClaudeFetch': something later in the page's life replaced
  // window.fetch with a wrapper that never calls through to ours, so every
  // later snapshot/completion request bypassed the hook silently.
  //
  // Resource Timing entries are recorded by the browser itself for every
  // fetch, however it was issued, and nothing on the page can intercept
  // them. An entry only arrives once its response has fully ended
  // (responseEnd) - for a completion stream, exactly "the assistant's turn
  // is done".
  //
  // Deliberately keyed on "a request touching this conversation just
  // finished", not on specific endpoint names: the same day, claude.ai
  // moved to chat_conversations_v2 and a tab showed no request matching the
  // old snapshot/completion names at all. Two triggers:
  //   1. any request scoped to a conversation (any chat_conversations[_vN]
  //      sub-path) -> that conversation;
  //   2. any other same-origin /api/ request while a /chat/{uuid} page is
  //      open -> that page's conversation (covers endpoint shapes that
  //      don't carry the conversation id in their path at all), throttled
  //      since unrelated background calls also land here.
  // Both are debounced per conversation, then fetch the authoritative
  // snapshot ourselves via the native fetch - unless the hook already
  // delivered one moments ago. A redundant snapshot is harmless: the
  // isolated world dedups by message uuid, the backend by client_event_id.
  const OBSERVER_SKIP_IF_HOOK_ACTIVE_MS = 5000;
  const OBSERVER_DEBOUNCE_MS = 1500;
  const OBSERVER_PAGE_ACTIVITY_MIN_INTERVAL_MS = 15000;

  let lastKnownOrgId = '';
  function readOrgIdFromCookie() {
    try {
      const match = document.cookie.match(/(?:^|;\s*)lastActiveOrg=([0-9a-fA-F-]{36})/);
      return match ? match[1] : '';
    } catch {
      return '';
    }
  }

  const pendingObserverTimers = new Map();
  const lastPageActivityFetchAt = new Map();

  function scheduleObserverSnapshot(orgId, conversationUuid, delayMs = OBSERVER_DEBOUNCE_MS) {
    if (!orgId || !conversationUuid) return;
    clearTimeout(pendingObserverTimers.get(conversationUuid));
    pendingObserverTimers.set(conversationUuid, setTimeout(() => {
      pendingObserverTimers.delete(conversationUuid);
      if (hadRecentSnapshotActivity(conversationUuid, OBSERVER_SKIP_IF_HOOK_ACTIVE_MS)) return;
      fetchSnapshotDirectly(orgId, conversationUuid).catch(() => {});
    }, delayMs));
  }

  function handleResourceEntry(entry) {
    if (entry.initiatorType !== 'fetch' && entry.initiatorType !== 'xmlhttprequest') return;
    const url = entry.name || '';
    if (!url.startsWith(`${location.origin}/api/`)) return;

    const orgMatch = ORG_URL_RE.exec(url);
    if (orgMatch) lastKnownOrgId = orgMatch[1];

    const scopedMatch = CONVERSATION_SCOPED_URL_RE.exec(url);
    if (scopedMatch) {
      scheduleObserverSnapshot(scopedMatch[1], scopedMatch[2]);
      return;
    }

    const pageMatch = CHAT_PAGE_RE.exec(location.pathname || '');
    if (!pageMatch) return;
    const pageConversationUuid = pageMatch[1];
    // A snapshot is already on its way - rescheduling it here would let a
    // steady trickle of background requests postpone it indefinitely.
    if (pendingObserverTimers.has(pageConversationUuid)) return;
    const orgId = lastKnownOrgId || readOrgIdFromCookie();
    if (!orgId) return;
    // Throttled by postponing, never by dropping: a reply that finishes
    // inside the interval still gets a (slightly later) snapshot.
    const now = Date.now();
    const earliestAt = (lastPageActivityFetchAt.get(pageConversationUuid) || 0) + OBSERVER_PAGE_ACTIVITY_MIN_INTERVAL_MS;
    const fireAt = Math.max(now + OBSERVER_DEBOUNCE_MS, earliestAt);
    lastPageActivityFetchAt.set(pageConversationUuid, fireAt);
    scheduleObserverSnapshot(orgId, pageConversationUuid, fireAt - now);
  }

  try {
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        try { handleResourceEntry(entry); } catch {}
      }
    });
    observer.observe({ type: 'resource', buffered: false });
  } catch {}
})();
