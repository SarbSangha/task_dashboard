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
  const SNAPSHOT_URL_RE = /\/api\/organizations\/([^/]+)\/chat_conversations\/([0-9a-fA-F-]{36})(?:[?#]|$)/;
  const COMPLETION_URL_RE = /\/api\/organizations\/([^/]+)\/chat_conversations\/([0-9a-fA-F-]{36})\/completion(?:[?#]|$)/;

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

  async function handleSnapshotResponse(url, response, match) {
    if (!response.ok) return;
    let body;
    try {
      body = await response.json();
    } catch {
      return; // not JSON, or body already unusable - nothing to capture
    }
    if (!body || typeof body !== 'object' || !Array.isArray(body.chat_messages)) return;
    postSignal('CLAUDE_CONVERSATION_SNAPSHOT', {
      organizationId: match[1],
      conversationUuid: match[2] || body.uuid,
      url,
      conversation: body,
    });
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

  function buildSnapshotUrl(orgId, conversationUuid) {
    return `${location.origin}/api/organizations/${orgId}/chat_conversations/${conversationUuid}?tree=True&rendering_mode=messages&render_all_tools=true&include_inline_comparison=true&consistency=eventual`;
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

  function maybeTriggerFollowUpSnapshotFetch(orgId, conversationUuid, response) {
    drainToCompletion(response)
      .then(() => new Promise((resolve) => setTimeout(resolve, FOLLOW_UP_GRACE_MS)))
      .then(() => fetch(buildSnapshotUrl(orgId, conversationUuid), { credentials: 'include' }))
      .then((snapshotResponse) => handleSnapshotResponse(snapshotResponse.url, snapshotResponse, [null, orgId, conversationUuid]))
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
})();
