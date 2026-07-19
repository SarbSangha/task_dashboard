(function installRmwChatGptNetworkTelemetry() {
  // ---- Diagnostic trace (temporary, instrumentation-only) -----------------
  // Forensic instrumentation for the "response_started/response_completed
  // never emitted" investigation - NOT part of the Capture Contract, never
  // becomes a ConversationCaptureEvent, never reaches the backend. Posted
  // unconditionally (not gated on the debug flag here) because the two
  // earliest checkpoints below happen before the isolated world's flag-sync
  // message could possibly have arrived - gating here would silently lose
  // exactly the events most relevant to a content-script-injection-timing
  // hypothesis. The isolated world (content-chatgpt.js) decides whether to
  // actually persist/log what it receives, based on the existing debug flag.
  const TRACE_SOURCE = 'rmw-chatgpt-capture-trace';
  function trace(step, detail) {
    try {
      window.postMessage({
        source: TRACE_SOURCE,
        step,
        at: Date.now(),
        detail: detail || {},
      }, location.origin);
    } catch {}
  }
  trace('content_script_injected_main_world', { href: location.href, readyState: document.readyState });

  if (window.__rmwChatGptNetworkTelemetryInstalled) {
    trace('main_world_script_reinjected_skipped', {});
    return;
  }
  window.__rmwChatGptNetworkTelemetryInstalled = true;

  // MAIN-world network interception for ChatGPT raw capture (Phase 2B).
  // Mirrors content-kling-network.js's philosophy: hook fetch/XHR/history in
  // the page's own JS realm (the isolated world cannot see the page's real
  // fetch/XHR/history calls), then hand off structured signals via
  // window.postMessage to the isolated-world adapter (content-chatgpt.js +
  // content-chatgpt-event-builder.js), which builds Capture Contract events
  // and forwards them to the background worker.
  //
  // Verified pipeline (see backend/providers/chatgpt/EXTENSION_CAPTURE_DESIGN.md
  // and the task brief): POST /backend-api/f/conversation/prepare ->
  // POST /backend-api/f/conversation (SSE) -> GET /backend-api/conversation/{id}/stream_status.
  // Endpoint shapes below beyond that verified pipeline (rename/archive/delete/
  // file upload) are best-effort pattern matches against ChatGPT's publicly
  // documented backend-api surface, NOT confirmed against a live HAR capture -
  // see NETWORK_DISCOVERY_GUIDE.md. Flagged in the Known Risks section of the
  // Phase 2B report; safe by construction because the backend never rejects
  // an unrecognized event_type/shape, it just logs it (CAPTURE_CONTRACT.md).

  const SOURCE = 'rmw-chatgpt-network-telemetry';
  const MAX_TEXT_LENGTH = 40000;
  const MAX_BODY_LENGTH = 20000;

  const PREPARE_URL_RE = /\/backend-api\/f\/conversation\/prepare(?:[/?#]|$)/i;
  // Deliberately does NOT allow a trailing "/" before the terminator (unlike
  // the other URL patterns below) - "/backend-api/f/conversation/prepare"
  // would otherwise also match this, since "/prepare" starts with "/". Order
  // of checks in the fetch/XHR hooks below still checks PREPARE_URL_RE first
  // as a second layer of defense against the same collision.
  const CONVERSATION_SEND_URL_RE = /\/backend-api\/f\/conversation(?:[?#]|$)/i;
  const STREAM_STATUS_URL_RE = /\/backend-api\/conversation\/([^/?#]+)\/stream_status(?:[/?#]|$)/i;
  // Best-effort (not verified live): per-conversation metadata mutations.
  const CONVERSATION_ITEM_URL_RE = /\/backend-api\/conversation\/([^/?#]+)(?:[/?#]|$)/i;
  // Best-effort (not verified live): attachment upload.
  const FILE_UPLOAD_URL_RE = /\/backend-api\/files(?:[/?#]|$)/i;
  const IGNORED_URL_RE = /(telemetry|sentinel|\bping\b|\/stats\b|analytics|heartbeat|beacon)/i;
  const CHATGPT_HOST_RE = /(^|\.)chatgpt\.com$|(^|\.)chat\.openai\.com$/i;

  function isChatGptHost() {
    try {
      return CHATGPT_HOST_RE.test(location.hostname || '');
    } catch {
      return false;
    }
  }

  function toText(value) {
    try {
      if (value == null) return '';
      if (typeof value === 'string') return value;
      if (value instanceof URLSearchParams) return value.toString();
      if (value instanceof FormData) {
        const parts = [];
        value.forEach((entryValue, key) => {
          parts.push(`${key}=${typeof entryValue === 'string' ? entryValue : '[file]'}`);
        });
        return parts.join('&');
      }
      if (value instanceof Blob || value instanceof ArrayBuffer) return '';
      return JSON.stringify(value);
    } catch {
      return '';
    }
  }

  function limitText(value, maxLength = MAX_TEXT_LENGTH) {
    const text = toText(value);
    return text.length > maxLength ? text.slice(0, maxLength) : text;
  }

  // Feature-flag state, synced down from the isolated world (this MAIN-world
  // script has no chrome.storage access at all, so it can't read the flags
  // itself - see content-chatgpt.js's syncFlagsToNetworkScript()). Fails
  // open (capture stays on) until the sync message arrives, since that
  // arrives well before any real user action on a freshly loaded tab.
  let captureEnabled = true;
  let debugEnabled = false;
  let parseFailureCount = 0;

  window.addEventListener('message', (event) => {
    try {
      if (event.source !== window) return;
      if (event.origin !== location.origin) return;
      if (event.data?.source !== 'rmw-chatgpt-capture-orchestrator') return;
      if (event.data?.type !== 'CHATGPT_CAPTURE_FLAGS_SYNC') return;
      captureEnabled = Boolean(event.data.payload?.enabled);
      debugEnabled = Boolean(event.data.payload?.debug);
    } catch {}
  }, false);

  function parseJson(text) {
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      parseFailureCount += 1;
      if (debugEnabled) {
        console.debug('[RMW ChatGPT Network] JSON parse failure', {
          totalParseFailures: parseFailureCount,
          textLength: text.length,
        });
      }
      return null;
    }
  }

  function normalizeUrl(input) {
    try {
      if (typeof input === 'string') return new URL(input, location.href).href;
      if (input && typeof input.url === 'string') return new URL(input.url, location.href).href;
    } catch {}
    return `${input || ''}`;
  }

  function postSignal(type, payload) {
    if (!captureEnabled) return; // single choke point for the enableCapture/enableNetworkCapture kill switch
    try {
      window.postMessage({ source: SOURCE, type, payload: { ...payload, capturedAt: Date.now() } }, location.origin);
    } catch {}
  }

  async function requestBodyFromFetchArgs(input, init) {
    if (init && Object.prototype.hasOwnProperty.call(init, 'body')) {
      return limitText(init.body, MAX_BODY_LENGTH);
    }
    try {
      if (input && typeof input.clone === 'function') {
        return limitText(await input.clone().text(), MAX_BODY_LENGTH);
      }
    } catch {}
    return '';
  }

  function shouldIgnoreUrl(url) {
    return IGNORED_URL_RE.test(url || '');
  }

  // ---- Conversation identity helpers ------------------------------------

  function extractCurrentConversationIdFromUrl(url = location.href) {
    try {
      const match = new URL(url, location.href).pathname.match(/\/c\/([^/?#]+)/i);
      return match ? match[1] : '';
    } catch {
      return '';
    }
  }

  // ---- prepare / conversation send ---------------------------------------

  function extractPromptFromRequestJson(requestJson) {
    if (!requestJson || typeof requestJson !== 'object') return null;
    const messages = Array.isArray(requestJson.messages) ? requestJson.messages : [];
    const lastUserMessage = [...messages].reverse().find((message) => {
      const role = message?.author?.role || message?.role;
      return role === 'user';
    });
    const parts = lastUserMessage?.content?.parts;
    const text = Array.isArray(parts)
      ? parts.filter((part) => typeof part === 'string').join('\n')
      : (typeof lastUserMessage?.content === 'string' ? lastUserMessage.content : '');

    const attachments = Array.isArray(lastUserMessage?.metadata?.attachments)
      ? lastUserMessage.metadata.attachments.map((attachment) => ({
        type: `${attachment?.mimeType || attachment?.mime_type || ''}`.startsWith('image/') ? 'image' : 'file',
        name: `${attachment?.name || attachment?.file_name || ''}`.slice(0, 300),
        url: undefined,
      }))
      : [];

    return {
      text: limitText(text, 20000),
      model: `${requestJson.model || ''}`.trim(),
      conversationId: `${requestJson.conversation_id || ''}`.trim(),
      parentMessageId: `${requestJson.parent_message_id || ''}`.trim(),
      action: `${requestJson.action || ''}`.trim(),
      // Whether *this* request carries a new user-authored message at all -
      // used to tell an edit-and-resend apart from a pure regenerate below,
      // both of which share action: "variant"/"regenerate" in the observed
      // public ChatGPT API shape.
      hasUserMessage: messages.some((message) => (message?.author?.role || message?.role) === 'user'),
      newMessageId: `${lastUserMessage?.id || ''}`.trim(),
      attachments,
    };
  }

  function handlePrepareRequest(url, requestJson) {
    const prompt = extractPromptFromRequestJson(requestJson);
    if (!prompt) return;
    postSignal('CHATGPT_PREPARE_DETECTED', {
      url,
      conversationId: prompt.conversationId,
      model: prompt.model,
    });
  }

  function isRegenerateAction(action) {
    return /^(variant|regenerate)$/i.test(action || '');
  }

  function handleConversationSendRequest(url, requestJson) {
    const prompt = extractPromptFromRequestJson(requestJson);
    if (!prompt) return null;

    if (isRegenerateAction(prompt.action)) {
      // Best-effort (not verified live): the public ChatGPT API shape uses
      // the same action ("variant"/"regenerate") for both a plain
      // "regenerate this response" (no new user message attached) and an
      // "edit this message and resend" (a new user message replacing the
      // original is included). hasUserMessage is how we tell them apart -
      // a pure regenerate emits neither prompt_captured nor message_edited,
      // only response_started/response_completed for the new turn.
      if (prompt.hasUserMessage && prompt.text) {
        postSignal('CHATGPT_MESSAGE_EDITED', {
          conversationId: prompt.conversationId,
          originalMessageId: prompt.parentMessageId,
          newMessageId: prompt.newMessageId || undefined,
          newText: prompt.text,
        });
      }
    } else if (prompt.text) {
      postSignal('CHATGPT_PROMPT_SUBMITTED', {
        conversationId: prompt.conversationId,
        parentMessageId: prompt.parentMessageId,
        newMessageId: prompt.newMessageId || undefined,
        model: prompt.model,
        text: prompt.text,
        attachments: prompt.attachments,
        isNewConversation: !prompt.conversationId,
      });
    }

    return prompt;
  }

  function extractAssistantTextFromMessage(message) {
    const parts = message?.content?.parts;
    if (Array.isArray(parts)) {
      return parts.filter((part) => typeof part === 'string').join('');
    }
    if (typeof message?.content?.text === 'string') return message.content.text;
    return '';
  }

  // Additive support for asynchronous tool-backed responses (e.g. image
  // generation), per the image-generation protocol investigation: some
  // turns' user-visible response never gets authored by role "assistant"/
  // "system" at all - it arrives as author.role "tool" (see
  // RESPONSE_RECONSTRUCTION_REPORT.md's image-generation addendum). The
  // fix is deliberately NOT "also treat role==='tool' as visible whenever
  // recipient==='all'" - recipient==='all' alone is unverified evidence for
  // a tool-authored frame (unlike for assistant/system, where it was
  // confirmed live - see isVisibleResponseMessage below), so a tool message
  // must ALSO carry an explicit, named signal that it's meant to be shown,
  // not just internal tool telemetry that happens to reach recipient:'all'.
  // This function only recognizes visibility - it never reclassifies a
  // tool message's role, and assembledMessage.author.role is never
  // rewritten anywhere in this file.
  //
  // Each check is independent evidence, not a guess:
  //   - metadata.image_gen_async / metadata.trigger_async_ux: the specific
  //     async-image-generation signals this investigation was looking for
  //   - metadata.ui_card: a general "render this as a UI card" flag -
  //     covers other tool-backed visible response types without needing a
  //     new special case per tool
  //   - a content.parts entry with content_type 'image_asset_pointer': the
  //     exact same criterion content-chatgpt.js's buildContentPartsFromMessage()
  //     already uses to recognize a generated image - if the tool message
  //     itself already carries the finished asset, that's direct evidence
  //     this is the real response, not scaffolding
  // None of these field names are confirmed against a live no_response_started
  // trace yet - if none match in practice, this function returns false and
  // isVisibleResponseMessage behaves exactly as isVisibleAssistantMessage
  // did before (a safe no-op, not a new failure mode).
  function hasExplicitUserVisibleSignal(message) {
    const metadata = message?.metadata || {};
    if (metadata.image_gen_async === true) return true;
    if (metadata.trigger_async_ux === true) return true;
    if (metadata.ui_card) return true;
    const parts = message?.content?.parts;
    if (Array.isArray(parts) && parts.some((part) => part && typeof part === 'object' && part.content_type === 'image_asset_pointer')) {
      return true;
    }
    return false;
  }

  function looksLikeMarkdown(text) {
    return /(^|\n)#{1,6}\s|\*\*[^*]+\*\*|`[^`]+`|(^|\n)[-*]\s/.test(text || '');
  }

  function looksLikeTable(text) {
    return /\|.+\|\n\|[-:| ]+\|/.test(text || '');
  }

  function extractCodeBlocks(text) {
    const blocks = [];
    const pattern = /```([a-zA-Z0-9_+-]*)\n([\s\S]*?)```/g;
    let match = pattern.exec(text || '');
    while (match && blocks.length < 20) {
      blocks.push({ language: match[1] || undefined, code: limitText(match[2], 8000) });
      match = pattern.exec(text || '');
    }
    return blocks;
  }

  // Tracks in-flight SSE turns keyed by a locally generated correlation id
  // (one per outgoing conversation-send request), so response_started fires
  // exactly once and response_completed carries the fully assembled text -
  // never raw streaming deltas (see CAPTURE_CONTRACT.md "Streaming capture").
  let turnSequence = 0;

  // ---- Raw frame archive (module-level, MAIN world) ------------------------
  // Complete, UNtruncated record of every frame this page has seen, for
  // offline replay (see protocol-replay-engine.js) - deliberately separate
  // from the size-capped trace() calls used for live human inspection,
  // which truncate values to keep chrome.storage entries small. This lives
  // in the MAIN world, which is the page's own JS realm (unlike the
  // isolated world's separate `window`) - so it's reachable directly from
  // the DevTools console's default "top" context, no context-switching
  // needed, unlike the higher-level processed trace. manifest.json grants
  // "unlimitedStorage", so an in-memory array here (not chrome.storage) is
  // the simpler choice - this is a per-page-load, per-tab debugging aid,
  // not meant to survive a navigation.
  const rawFrameArchive = [];
  function archiveRawFrame(correlationId, frameIndex, frame) {
    rawFrameArchive.push({ correlationId, frameIndex, arrivalTimestamp: Date.now(), frame });
  }
  try {
    window.__rmwRawFrameArchive = rawFrameArchive;
    window.__rmwExportRawFrames = () => {
      const filename = `raw-frame-archive-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
      const blob = new Blob([JSON.stringify(rawFrameArchive, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = filename;
      document.body.appendChild(anchor);
      anchor.click();
      document.body.removeChild(anchor);
      setTimeout(() => URL.revokeObjectURL(url), 5000);
      return { entries: rawFrameArchive.length, filename };
    };
    window.__rmwClearRawFrameArchive = () => { rawFrameArchive.length = 0; };
  } catch {}

  // ---- Stream identity registry (module-level, shared across every
  // concurrent pumpConversationStream() call on this page) ------------------
  // Answers "did two different fetch streams ever write into the same
  // assembled message" - a real, previously-invisible way duplication could
  // occur (as opposed to the single-stream replace/append semantics already
  // instrumented). Keyed by ChatGPT's own message id, not our correlationId,
  // since that's the actual shared resource two streams could collide on.
  const messageOwnerByMessageId = new Map(); // messageId -> { correlationId, fetchInstanceId }
  let fetchInstanceCounter = 0;

  function registerMessageOwnership(messageId, correlationId, fetchInstanceId) {
    if (!messageId) return;
    const existing = messageOwnerByMessageId.get(messageId);
    if (existing && existing.correlationId !== correlationId) {
      trace('stream_collision_detected', {
        messageId,
        streamA: existing.correlationId,
        streamAFetchInstance: existing.fetchInstanceId,
        streamB: correlationId,
        streamBFetchInstance: fetchInstanceId,
      });
      return;
    }
    messageOwnerByMessageId.set(messageId, { correlationId, fetchInstanceId });
  }

  // ---- Protocol frame classification ---------------------------------------
  // Best-effort categorization from observed shape only - never used to
  // decide whether to apply a frame (that stays purely op-driven and
  // deterministic), purely for the evidence trail. UNKNOWN is a legitimate,
  // logged outcome, never a silent drop.
  function classifyFrame(frame, resolvedPointer) {
    if (frame.message && typeof frame.message === 'object') return 'ROOT_PATCH';
    if (frame.p === '' || resolvedPointer === '') return 'ROOT_PATCH';
    const pointer = `${resolvedPointer ?? frame.p ?? ''}`;
    if (pointer) {
      if (/\/status$/.test(pointer) || /\/end_turn$/.test(pointer)) return 'STATUS_PATCH';
      if (/content_references/.test(pointer) && /images/.test(pointer)) return 'IMAGE_TOKEN';
      if (/content_references/.test(pointer)) return 'ENTITY_TOKEN';
      if (/\/metadata/.test(pointer)) return 'METADATA';
      if (/content\/parts\/\d+$/.test(pointer)) return 'TEXT_DELTA';
    }
    if (!frame.type && typeof frame.v === 'string' && !frame.p && !frame.o) return 'TEXT_DELTA';
    if (frame.type === 'title_generation') return 'TITLE_PATCH';
    if (frame.type === 'message_marker') return 'MESSAGE_MARKER';
    return 'UNKNOWN';
  }

  // ---- Pure frame-dispatch decision -----------------------------------
  // Deliberately factored out of handleFrame() and dependency-free (no
  // closure state, no chrome.*, no DOM) so the exact same decision logic
  // can run two places: live, inside pumpConversationStream(), and offline,
  // inside protocol-replay-engine.js, fed from an archived frame instead of
  // a live SSE frame. Any future change to "what kind of frame is this and
  // what should happen to it" only ever needs to happen here, once, so live
  // capture and replay can never silently drift apart. Returns a plain
  // description of what to do - it does not perform any mutation itself.
  function determineFrameAction(frame) {
    if (frame.message && typeof frame.message === 'object') {
      return { action: 'full_message_replace', message: frame.message };
    }
    if (frame.o === 'patch' && Array.isArray(frame.v)) {
      return {
        action: 'batched_patch',
        operations: frame.v.map((operation) => ({ operation, cursor: operation?.c ?? frame.c })),
      };
    }
    if (typeof frame.p === 'string' && frame.o) {
      return { action: 'single_patch', operation: frame, cursor: frame.c };
    }
    if (typeof frame.v === 'string' && !frame.type) {
      return {
        action: 'bare_delta',
        operation: { p: '/message/content/parts/0', o: 'append', v: frame.v },
        cursor: frame.c,
      };
    }
    return { action: 'unrecognized' };
  }

  // Applies a single JSON-Pointer-shaped patch operation ({p, o, v}) onto an
  // accumulating plain object. Generic on purpose: rather than hardcoding
  // exact field names for "the text delta path" or "the completion path", it
  // reconstructs whatever object shape the server is actually building so the
  // existing extractAssistantTextFromMessage()/end_turn checks - already
  // proven against the legacy full-message-per-frame shape - keep working
  // unchanged once applied to the reconstructed object.
  // Deterministic, protocol-literal semantics only - no text heuristics
  // (prefix-matching, length comparison, or any other guess from content
  // was tried and proven unsound: it fixed one failure mode while causing
  // a different one - duplicated reconstruction - elsewhere). This applies
  // exactly what the frame's own "o" field says, nothing more, and returns
  // enough detail (before/after value, whether this was an append or an
  // overwrite) for the caller to log a full mutation trace - see
  // applyStreamPatch, which is where that trace is emitted (this function
  // has no access to correlationId/trace()).
  function applyJsonPointerPatch(root, pointer, value, op) {
    const parts = `${pointer || ''}`.split('/').filter((part) => part.length > 0);
    if (parts.length === 0) return { before: undefined, after: undefined, mutated: false };
    let node = root;
    for (let i = 0; i < parts.length - 1; i += 1) {
      const key = parts[i];
      const nextKey = parts[i + 1];
      if (node[key] == null || typeof node[key] !== 'object') {
        node[key] = /^\d+$/.test(nextKey) ? [] : {};
      }
      node = node[key];
    }
    const lastKey = parts[parts.length - 1];
    const before = node[lastKey];
    if (op === 'append' && typeof value === 'string') {
      node[lastKey] = `${typeof before === 'string' ? before : ''}${value}`;
    } else {
      node[lastKey] = value;
    }
    return { before, after: node[lastKey], mutated: true };
  }

  async function pumpConversationStream(response, requestPrompt) {
    const correlationId = `turn_${Date.now()}_${(turnSequence += 1)}`;
    const fetchInstanceId = (fetchInstanceCounter += 1);
    trace('pump_conversation_stream_entered', { correlationId, fetchInstanceId, conversationId: requestPrompt?.conversationId || null });

    // ---- State machine ----------------------------------------------------
    let parserState = 'WAITING_FOR_ROOT';
    function transitionState(newState, triggerFrameIdx, detail) {
      if (newState === parserState) return;
      trace('state_transition', {
        correlationId,
        frameIndex: triggerFrameIdx ?? null,
        previousState: parserState,
        newState,
        detail: detail || {},
      });
      parserState = newState;
    }

    // ---- Cursor tracking (global per-turn, not per-pointer - unproven
    // whether "c" is scoped per-part or per-stream, tracked at the widest
    // scope first since narrowing is easy once evidence comes back) --------
    let previousCursor = null;
    let cursorRegressionCount = 0;

    // ---- Duplicate frame detection -----------------------------------------
    const seenFrameHashes = new Set();
    let duplicateFrameCount = 0;

    // ---- Protocol-level aggregate stats, printed once at the end ----------
    const protocolStats = {
      framesReceived: 0,
      framesIgnored: 0, // UNKNOWN classification
      classificationCounts: {},
      framesApplied: 0, // mutations that actually wrote a value
      duplicateFrames: 0,
      cursorRegressions: 0,
      unknownFrameTypes: new Set(),
      maxCursor: null,
      maxContentLength: 0,
      bufferOverwrites: 0,
      bufferAppends: 0,
      bufferShrinks: 0,
    };

    let startedFired = false;
    let firstChunkTraced = false;
    let firstFrameParsedTraced = false;
    let roleDetectedTraced = false;
    let lastAssistantIdentityKey = null;
    let assistantMessageId = '';
    let assistantModel = requestPrompt?.model || '';
    let conversationId = requestPrompt?.conversationId || '';
    let lastAssembledText = '';
    let stopReason = '';
    // handleFrame() calls finalize() on the [DONE] sentinel, and the read
    // loop below unconditionally calls it again after the loop ends -
    // without this guard both fire on every normal-completion turn,
    // producing two response_completed events (confirmed in production:
    // duplicate rows sharing provider_message_id, ~0.3s apart, distinct
    // client_event_id so the backend's client_event_id dedupe never catches
    // it).
    let finalized = false;
    // Reconstructed incrementally across frames - see applyStreamPatch(). Two
    // wire shapes are handled: (a) a bare full message object per frame
    // (frame.message - the only shape previously handled, kept as-is), and
    // (b) an incremental JSON-patch operation (frame.p/frame.o/frame.v, or a
    // batch of these under frame.v when frame.o === 'patch') applied on top
    // of whatever has accumulated so far. (b) is untested against a live HAR
    // (see NETWORK_DISCOVERY_GUIDE.md) - if response_started/response_completed
    // are still never observed after this change with debug logging on,
    // the console.debug output below will show the actual frame shape ChatGPT
    // is sending, which is the fastest path to a real fix.
    let assembledMessage = null;

    const reader = response.body?.getReader?.();
    trace('reader_acquisition', { correlationId, readerAcquired: Boolean(reader) });
    if (!reader) {
      trace('pump_conversation_stream_exited_no_reader', { correlationId });
      return;
    }
    const decoder = new TextDecoder('utf-8');
    let buffer = '';
    // Diagnostic-instrumentation pass: uncapped (within reason) for one full
    // turn, since the goal here is a complete frame-by-frame protocol
    // timeline, not a lightweight spot-check. 4000 comfortably covers even
    // a very long response's full delta count.
    let patchOpTraceCount = 0;
    const MAX_PATCH_OP_TRACES = 4000;
    let frameIndex = 0;

    function firstLast80(value) {
      if (typeof value !== 'string') return { first80: null, last80: null };
      return {
        first80: value.slice(0, 80),
        last80: value.length > 80 ? value.slice(-80) : value,
      };
    }

    // Mutation-level trace: before/after value (length + first/last 80
    // chars, not the full string, to keep entries small), the operation
    // actually applied, and full buffer-growth metrics. This is the ground
    // truth for "did this frame overwrite or extend what we had, and did it
    // lose anything." A content buffer should almost never shrink - when it
    // does, that's logged as its own explicit event, not just a number in a
    // table that's easy to miss.
    function traceMutation(reason, { pointer, op, cursor, before, after }) {
      const beforeStr = typeof before === 'string' ? before : null;
      const afterStr = typeof after === 'string' ? after : null;
      const beforeLength = beforeStr ? beforeStr.length : (before === undefined ? null : 0);
      const afterLength = afterStr ? afterStr.length : (after === undefined ? null : 0);
      const appended = op === 'append';
      const overwrote = !appended && beforeStr && afterStr && !afterStr.startsWith(beforeStr);
      const grew = beforeLength !== null && afterLength !== null && afterLength > beforeLength;
      const shrank = beforeLength !== null && afterLength !== null && afterLength < beforeLength;

      if (appended) protocolStats.bufferAppends += 1;
      if (overwrote) protocolStats.bufferOverwrites += 1;
      if (shrank) protocolStats.bufferShrinks += 1;
      if (afterLength !== null && afterLength > protocolStats.maxContentLength) protocolStats.maxContentLength = afterLength;
      protocolStats.framesApplied += 1;

      if (shrank) {
        trace('buffer_shrink_detected', { correlationId, frameIndex, pointer, op, cursor: cursor ?? null, beforeLength, afterLength });
      }

      if (/content\/parts\/\d+$/.test(pointer)) {
        transitionState('STREAMING', frameIndex, { pointer });
      } else if (/\/status$|\/end_turn$/.test(pointer)) {
        transitionState('FINAL_PATCH', frameIndex, { pointer, value: after });
      }

      if (patchOpTraceCount >= MAX_PATCH_OP_TRACES) return;
      patchOpTraceCount += 1;
      trace('mutation', {
        correlationId,
        frameIndex,
        reason,
        pointer,
        op,
        cursor: cursor ?? null,
        beforeLength,
        afterLength,
        deltaLength: beforeLength !== null && afterLength !== null ? afterLength - beforeLength : null,
        ...(beforeStr ? { beforeFirst80: firstLast80(beforeStr).first80, beforeLast80: firstLast80(beforeStr).last80 } : {}),
        ...(afterStr ? { afterFirst80: firstLast80(afterStr).first80, afterLast80: firstLast80(afterStr).last80 } : {}),
        overwrote,
        appended,
        grew,
        shrank,
      });
    }

    function applyStreamPatch(operation, cursor) {
      if (!operation || typeof operation.p !== 'string' || !operation.o) return;
      const { p: path, o: op, v: value } = operation;

      if (path === '') {
        // Root add/replace: the value is typically the whole envelope
        // ({ message, conversation_id, error }), not the message alone.
        if (value && typeof value === 'object') {
          const nextMessage = value.message && typeof value.message === 'object' ? value.message : value;
          trace('patch_root_replace', {
            correlationId,
            frameIndex,
            previousMessageId: assembledMessage?.id || null,
            nextMessageId: nextMessage?.id || null,
            nextRecipient: nextMessage?.recipient || null,
            nextChannel: nextMessage?.channel || null,
            nextRole: nextMessage?.author?.role || null,
            nextContentPartsPreview: Array.isArray(nextMessage?.content?.parts)
              ? nextMessage.content.parts.map((part) => (typeof part === 'string' ? `${part.length}chars:"${part.slice(0, 40)}"` : typeof part))
              : null,
          });
          assembledMessage = nextMessage;
          registerMessageOwnership(nextMessage?.id, correlationId, fetchInstanceId);
          transitionState('ROOT_RECEIVED', frameIndex, { messageId: nextMessage?.id || null });
          if (value.conversation_id && !conversationId) conversationId = `${value.conversation_id}`.trim();
        }
        return;
      }

      if (!assembledMessage || typeof assembledMessage !== 'object') assembledMessage = {};
      const messagePath = path.startsWith('/message') ? path.slice('/message'.length) : path;
      const result = applyJsonPointerPatch(assembledMessage, messagePath, value, op);
      traceMutation('patch_operation', { pointer: messagePath, op, cursor, before: result.before, after: result.after });
    }

    function handleFrame(rawEvent) {
      const dataLines = rawEvent
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trim());
      if (!dataLines.length) return;
      const dataText = dataLines.join('\n');
      if (dataText === '[DONE]') {
        finalize('done_sentinel');
        return;
      }
      const frame = parseJson(dataText);
      if (!frame || typeof frame !== 'object') return;
      frameIndex += 1;
      if (!firstFrameParsedTraced) {
        firstFrameParsedTraced = true;
        trace('first_json_frame_parsed', { correlationId, frameKeys: Object.keys(frame) });
      }

      // Complete raw record of EVERY frame, before any interpretation -
      // the ground truth for reconstructing the actual protocol timeline.
      // Kept small per-entry (value truncated to first/last 80 chars, not
      // the full payload) since this fires once per frame, not once per
      // turn.
      if (patchOpTraceCount < MAX_PATCH_OP_TRACES) {
        patchOpTraceCount += 1;
        const vIsString = typeof frame.v === 'string';
        const vIsArray = Array.isArray(frame.v);
        trace('frame_received', {
          correlationId,
          frameIndex,
          conversationId,
          currentMessageId: assembledMessage?.id || null,
          frameType: frame.type || null,
          op: frame.o || null,
          pointer: frame.p ?? null,
          cursor: frame.c ?? null,
          hasMessage: Boolean(frame.message),
          vKind: vIsString ? 'string' : (vIsArray ? 'array' : typeof frame.v),
          vLength: vIsString ? frame.v.length : (vIsArray ? frame.v.length : null),
          vFirst80: vIsString ? frame.v.slice(0, 80) : null,
          vLast80: vIsString ? (frame.v.length > 80 ? frame.v.slice(-80) : frame.v) : null,
        });
      }

      if (!conversationId && frame.conversation_id) {
        conversationId = `${frame.conversation_id}`.trim();
      }

      // ---- Duplicate frame detection ----------------------------------
      // Hash of (pointer + op + cursor + value) - per spec, an exact repeat
      // is logged and NOT re-applied (a genuine repeat of the same op/
      // cursor/value pair has nothing new to contribute, and re-applying an
      // "append" twice would double it).
      const frameHash = `${frame.p ?? ''}|${frame.o ?? ''}|${frame.c ?? ''}|${typeof frame.v === 'string' ? frame.v : JSON.stringify(frame.v ?? null)}`;
      const isDuplicateFrame = seenFrameHashes.has(frameHash);
      if (isDuplicateFrame) {
        duplicateFrameCount += 1;
        protocolStats.duplicateFrames += 1;
        trace('duplicate_frame_detected', { correlationId, frameIndex, frameHashPreview: frameHash.slice(0, 200) });
      } else {
        seenFrameHashes.add(frameHash);
      }

      // ---- Cursor analysis ---------------------------------------------
      // Do not assume what "c" means - just record the relationship between
      // its progression and the frame's own value length, frame by frame,
      // so the actual semantics can be read off real data.
      if (typeof frame.c === 'number') {
        const cursorDelta = previousCursor === null ? null : frame.c - previousCursor;
        const valueLength = typeof frame.v === 'string' ? frame.v.length : null;
        if (cursorDelta !== null && cursorDelta < 0) {
          cursorRegressionCount += 1;
          protocolStats.cursorRegressions += 1;
          trace('cursor_regression', { correlationId, frameIndex, previousCursor, currentCursor: frame.c, cursorDelta });
        }
        trace('cursor_analysis', {
          correlationId,
          frameIndex,
          previousCursor,
          currentCursor: frame.c,
          cursorDelta,
          valueLength,
          deltaEqualsValueLength: cursorDelta !== null && valueLength !== null ? cursorDelta === valueLength : null,
        });
        previousCursor = frame.c;
        if (protocolStats.maxCursor === null || frame.c > protocolStats.maxCursor) protocolStats.maxCursor = frame.c;
      }

      // ---- Protocol classification --------------------------------------
      const classification = classifyFrame(frame, frame.p);
      protocolStats.classificationCounts[classification] = (protocolStats.classificationCounts[classification] || 0) + 1;
      if (classification === 'UNKNOWN') {
        protocolStats.framesIgnored += 1;
        protocolStats.unknownFrameTypes.add(frame.type || `keys:${Object.keys(frame).sort().join(',')}`);
      }
      protocolStats.framesReceived += 1;

      if (isDuplicateFrame) return; // logged above - do not apply a second time

      // Archive the complete, untruncated raw frame for offline replay -
      // separate from the size-capped, preview-truncated trace() calls
      // above/below, which exist for live human inspection, not bit-exact
      // reproduction. See protocol-replay-engine.js.
      archiveRawFrame(correlationId, frameIndex, frame);

      const decision = determineFrameAction(frame);

      if (decision.action === 'full_message_replace') {
        trace('frame_full_message_replace', {
          correlationId,
          frameIndex,
          previousMessageId: assembledMessage?.id || null,
          nextMessageId: decision.message.id || null,
          nextRecipient: decision.message.recipient || null,
          nextChannel: decision.message.channel || null,
          nextRole: decision.message?.author?.role || null,
          nextContentPartsPreview: Array.isArray(decision.message?.content?.parts)
            ? decision.message.content.parts.map((part) => (typeof part === 'string' ? `${part.length}chars:"${part.slice(0, 40)}"` : typeof part))
            : null,
        });
        assembledMessage = decision.message;
        registerMessageOwnership(decision.message?.id, correlationId, fetchInstanceId);
        transitionState('ROOT_RECEIVED', frameIndex, { messageId: decision.message?.id || null });
      } else if (decision.action === 'batched_patch') {
        // A batch of operations doesn't necessarily carry its own top-level
        // "p" (only each inner operation does) - this must be checked before
        // the single-operation branch below, not gated behind frame.p being
        // present. Previously nested inside `typeof frame.p === 'string' &&
        // frame.o`, which silently dropped every batched delta whenever the
        // envelope itself had no "p" - the likely reason response_started
        // fired (role captured from the initial full-object frame) while
        // response_completed never did (no text ever accumulated).
        decision.operations.forEach(({ operation, cursor }) => applyStreamPatch(operation, cursor));
      } else if (decision.action === 'single_patch') {
        applyStreamPatch(decision.operation, decision.cursor);
      } else if (decision.action === 'bare_delta') {
        // Bare per-token delta frame - {v: "<text>", c: <cursor>}, no p/o/
        // message/type. Confirmed live via trace instrumentation: this is
        // the actual streaming format for the bulk of a response's body -
        // dozens of these arrive at a steady ~200ms cadence for a long
        // answer, entirely separate from the {p,o,v} JSON-patch envelope
        // used only for the structural frames (root message, final status/
        // end_turn/metadata). Previously fell into the unrecognized-shape
        // branch and was silently discarded in full. Routed through the
        // same deterministic append path as {p,o,v} patches - cursor (c) is
        // passed through untouched to the mutation trace so its actual
        // semantics can be read off real data instead of assumed.
        applyStreamPatch(decision.operation, decision.cursor);
      } else {
        // Previously only logged (and only in debug mode) before
        // response_started fired - once startedFired became true this went
        // completely silent for the rest of the stream, no matter what
        // arrived. Multi-second gaps with zero trace activity on long,
        // image-heavy responses are exactly what that blind spot would
        // produce if ChatGPT sends a frame shape unrecognized by
        // applyStreamPatch partway through.
        trace('unrecognized_frame_shape', { correlationId, frameIndex, frameKeys: Object.keys(frame), frameType: frame.type || null, frameO: frame.o || null });
        if (debugEnabled) {
          console.debug('[RMW ChatGPT Network] unrecognized SSE frame shape (no frame.message, no frame.p/o)', frame);
        }
      }

      const role = assembledMessage?.author?.role;
      const recipient = assembledMessage?.recipient;
      // Confirmed live via trace instrumentation (see
      // RESPONSE_RECONSTRUCTION_REPORT.md addendum): ChatGPT now authors the
      // user-visible final answer with author.role "system" for at least
      // some turns, not just the historically-documented "assistant" - a
      // captured trace showed nextRole:"system", nextRecipient:"all", with
      // content.parts text identical, word-for-word, to what was actually
      // showing on screen. role alone is no longer a reliable "is this the
      // visible answer" signal; recipient === 'all' is (it's ChatGPT's own
      // "this message is shown to the user" marker, independent of which
      // role authored it).
      //
      // Classification is by VISIBILITY, not by role - isVisibleResponseMessage
      // (renamed from isVisibleAssistantMessage) recognizes a user-visible
      // response regardless of which internal role authored it, without
      // ever reclassifying a tool message AS an assistant message:
      //   - assistant/system + recipient:'all' - the original, confirmed-live
      //     criterion, completely unchanged, still evaluated first and still
      //     the only thing that matters for every existing text conversation
      //   - tool + recipient:'all' + an explicit user-visible signal (see
      //     hasExplicitUserVisibleSignal above) - additive, covers
      //     asynchronous tool-backed responses (e.g. image generation) whose
      //     visible result is authored by role "tool" and was previously
      //     invisible to this parser entirely (outcome: no_response_started,
      //     zero events emitted - see the image-generation protocol
      //     investigation)
      // recipient:'all' alone is NOT sufficient for role==='tool' (unlike
      // for assistant/system, where it was directly confirmed) - an
      // unrelated tool doing internal telemetry could plausibly also reach
      // recipient:'all' without being a genuine user-visible response, so an
      // additional explicit signal is required only for that role.
      const isVisibleResponseMessage = recipient === 'all' && (
        role === 'assistant'
        || role === 'system'
        || (role === 'tool' && hasExplicitUserVisibleSignal(assembledMessage))
      );
      if (isVisibleResponseMessage) {
        transitionState('MESSAGE_IDENTIFIED', frameIndex, { messageId: assembledMessage?.id || null, role, recipient });
      }
      if (isVisibleResponseMessage && !roleDetectedTraced) {
        roleDetectedTraced = true;
        trace('assistant_role_detected', { correlationId, role, recipient, assembledMessageKeys: assembledMessage && typeof assembledMessage === 'object' ? Object.keys(assembledMessage) : null });
      }
      if (isVisibleResponseMessage) {
        // Tests the "multiple different assistant-authored messages
        // conflated into one" hypothesis directly: if a turn legitimately
        // involves a tool/search call plus the final visible answer, both
        // are author.role === 'assistant' but should differ in id/recipient/
        // channel. Traced once per distinct identity seen (not every frame)
        // so a long stream doesn't flood the log with the same identity
        // repeated on every delta.
        const identityKey = `${assembledMessage?.id || ''}|${assembledMessage?.recipient || ''}|${assembledMessage?.channel || ''}`;
        if (identityKey !== lastAssistantIdentityKey) {
          lastAssistantIdentityKey = identityKey;
          trace('assistant_message_identity_seen', {
            correlationId,
            messageId: assembledMessage?.id || null,
            recipient: assembledMessage?.recipient || null,
            channel: assembledMessage?.channel || null,
            contentType: assembledMessage?.content?.content_type || null,
            endTurn: assembledMessage?.end_turn ?? null,
            textSoFarPreview: (extractAssistantTextFromMessage(assembledMessage) || '').slice(0, 200),
          });
        }
        const text = extractAssistantTextFromMessage(assembledMessage);
        if (text) lastAssembledText = text;
        if (assembledMessage?.id) assistantMessageId = `${assembledMessage.id}`;
        if (assembledMessage?.metadata?.model_slug) assistantModel = `${assembledMessage.metadata.model_slug}`;
        if (
          assembledMessage?.end_turn === true
          || assembledMessage?.status === 'finished_successfully'
          || frame.is_completion === true
        ) {
          stopReason = 'end_turn';
          transitionState('END_TURN', frameIndex, { endTurn: assembledMessage?.end_turn ?? null, status: assembledMessage?.status ?? null });
        }
        if (!startedFired) {
          startedFired = true;
          if (debugEnabled) {
            console.debug('[RMW ChatGPT Network] response_started detected', { conversationId, assistantMessageId, assistantModel });
          }
          trace('response_started_emitted', { correlationId, conversationId, assistantMessageId });
          postSignal('CHATGPT_RESPONSE_STARTED', {
            conversationId,
            messageId: assistantMessageId,
            model: assistantModel,
            correlationId,
          });
        }
      }

      if (frame.error) {
        stopReason = 'error';
      }
    }

    // Prints (and traces) the complete protocol summary for this turn -
    // deliberately called both on a normal finish and on the "no response
    // started" early exit, so an outright-broken turn still produces
    // evidence instead of nothing.
    function printProtocolSummary(outcome) {
      const summary = {
        correlationId,
        fetchInstanceId,
        conversationId,
        assistantMessageId: assistantMessageId || null,
        outcome,
        finalState: parserState,
        framesReceived: protocolStats.framesReceived,
        framesIgnored: protocolStats.framesIgnored,
        classificationCounts: { ...protocolStats.classificationCounts },
        framesApplied: protocolStats.framesApplied,
        duplicateFrames: protocolStats.duplicateFrames,
        cursorRegressions: protocolStats.cursorRegressions,
        unknownFrameTypes: Array.from(protocolStats.unknownFrameTypes),
        maxCursor: protocolStats.maxCursor,
        maxContentLength: protocolStats.maxContentLength,
        finalTextLength: lastAssembledText.length,
        bufferOverwrites: protocolStats.bufferOverwrites,
        bufferAppends: protocolStats.bufferAppends,
        bufferShrinks: protocolStats.bufferShrinks,
      };
      trace('protocol_summary', summary);
      if (debugEnabled) {
        console.debug('[RMW ChatGPT Network] PROTOCOL SUMMARY', summary);
      }
    }

    function finalize(calledFrom) {
      trace('finalize_called', { correlationId, calledFrom: calledFrom || 'unknown', alreadyFinalized: finalized, startedFired });
      if (finalized) return;
      finalized = true;
      if (!startedFired) {
        // Nothing assistant-authored was ever seen - if this keeps happening,
        // it means neither wire shape handleFrame() understands actually
        // matched what ChatGPT sent this turn. Surfacing the last reconstructed
        // state (rather than nothing) gives the next live debug session
        // something concrete to look at instead of a silent no-op.
        if (debugEnabled) {
          console.debug('[RMW ChatGPT Network] stream ended with no assistant message detected', { conversationId, assembledMessage });
        }
        trace('finalize_exited_no_response_started', { correlationId });
        printProtocolSummary('no_response_started');
        return;
      }
      if (debugEnabled) {
        console.debug('[RMW ChatGPT Network] finalize() sending response_completed', {
          conversationId,
          textLength: lastAssembledText.length,
          stopReason,
          assembledMessageKeys: assembledMessage ? Object.keys(assembledMessage) : null,
        });
      }
      transitionState('FETCH_AUTHORITATIVE', frameIndex, { textLength: lastAssembledText.length });
      trace('response_completed_emitted', { correlationId, conversationId, textLength: lastAssembledText.length, stopReason });
      printProtocolSummary('completed');
      postSignal('CHATGPT_RESPONSE_COMPLETED', {
        conversationId,
        messageId: assistantMessageId,
        model: assistantModel,
        text: lastAssembledText,
        codeBlocks: extractCodeBlocks(lastAssembledText),
        hasMarkdown: looksLikeMarkdown(lastAssembledText),
        hasTables: looksLikeTable(lastAssembledText),
        stopReason,
        correlationId,
        isNewConversation: !requestPrompt?.conversationId && Boolean(conversationId),
      });
      if (!requestPrompt?.conversationId && conversationId) {
        postSignal('CHATGPT_CONVERSATION_CREATED', {
          conversationId,
          model: assistantModel,
        });
      }
    }

    let loggedFirstChunk = false;

    try {
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!firstChunkTraced) {
          firstChunkTraced = true;
          trace('first_chunk_received', { correlationId, byteLength: value?.byteLength ?? null });
        }
        const chunk = decoder.decode(value, { stream: true });
        if (loggedFirstChunk === false) {
          trace('first_chunk_decoded', { correlationId, decodedLength: chunk.length, preview: chunk.slice(0, 500) });
        }
        if (debugEnabled && !loggedFirstChunk) {
          // The single most useful diagnostic this file can produce: the
          // actual raw bytes ChatGPT sent, before any framing assumption
          // (SSE "data:"-prefixed blocks vs. bare NDJSON vs. something else)
          // is applied. Two prior fix attempts guessed at the wire shape
          // without this and were unconfirmed - this removes the guessing.
          console.debug('[RMW ChatGPT Network] first raw stream chunk', chunk.slice(0, 2000));
        }
        loggedFirstChunk = true;
        buffer += chunk;
        let boundary = buffer.indexOf('\n\n');
        while (boundary !== -1) {
          const rawEvent = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          safeHandleFrame(rawEvent);
          boundary = buffer.indexOf('\n\n');
        }
      }
      if (buffer.trim()) safeHandleFrame(buffer);
      finalize('read_loop_ended');
    } catch (streamError) {
      // A bug in handleFrame() (e.g. a malformed patch operation) used to
      // propagate all the way out here indistinguishably from a genuine
      // network-level stream abort (navigation, stop button, connection
      // reset) - silently discarding the whole turn with zero logging
      // either way. safeHandleFrame() below now isolates parsing bugs so
      // they can't reach this catch at all; what's left here should only be
      // real stream errors, and it's now always logged instead of silent.
      if (debugEnabled) {
        console.debug('[RMW ChatGPT Network] stream read loop aborted', {
          conversationId,
          textLengthSoFar: lastAssembledText.length,
          startedFired,
          error: streamError?.message || streamError,
        });
      }
      trace('stream_read_loop_error', { correlationId, startedFired, textLengthSoFar: lastAssembledText.length, error: `${streamError?.message || streamError}` });
      // Stream aborted (navigation, stop button). Emit whatever was
      // assembled so far rather than silently losing the turn - lossless
      // capture per CAPTURE_CONTRACT.md reliability class.
      if (startedFired && lastAssembledText) {
        stopReason = stopReason || 'aborted';
        finalize('stream_error_catch');
      }
    }

    function safeHandleFrame(rawEvent) {
      try {
        handleFrame(rawEvent);
      } catch (frameError) {
        // Isolate one bad frame from the whole turn - see the catch block
        // above for why this matters.
        if (debugEnabled) {
          console.debug('[RMW ChatGPT Network] handleFrame threw on one frame - continuing', {
            error: frameError?.message || frameError,
            rawEventPreview: rawEvent.slice(0, 500),
          });
        }
      }
    }
  }

  // ---- stream_status polling (auxiliary confirmation only) ---------------

  function handleStreamStatus(url, responseJson) {
    const match = url.match(STREAM_STATUS_URL_RE);
    const conversationId = match ? match[1] : '';
    if (!conversationId) return;
    postSignal('CHATGPT_STREAM_STATUS', {
      conversationId,
      status: `${responseJson?.status || responseJson?.state || ''}`,
    });
  }

  // ---- conversation mutation (rename/archive/delete) - best effort -------

  function handleConversationMutation(url, method, requestJson) {
    if (!/^(PATCH|DELETE)$/.test(method)) return;
    const match = url.match(CONVERSATION_ITEM_URL_RE);
    const conversationId = match ? match[1] : '';
    if (!conversationId || CONVERSATION_SEND_URL_RE.test(url) || PREPARE_URL_RE.test(url)) return;

    if (method === 'DELETE' || requestJson?.is_visible === false) {
      postSignal('CHATGPT_CONVERSATION_MUTATED', {
        conversationId,
        kind: 'deleted',
        detectedVia: 'explicit_delete_action',
      });
      return;
    }
    if (typeof requestJson?.title === 'string') {
      postSignal('CHATGPT_CONVERSATION_MUTATED', {
        conversationId,
        kind: 'renamed',
        newTitle: requestJson.title,
      });
      return;
    }
    if (typeof requestJson?.is_archived === 'boolean') {
      postSignal('CHATGPT_CONVERSATION_MUTATED', {
        conversationId,
        kind: 'archived',
        archived: requestJson.is_archived,
      });
      return;
    }
    if (requestJson && typeof requestJson === 'object') {
      postSignal('CHATGPT_CONVERSATION_MUTATED', {
        conversationId,
        kind: 'updated',
        changedFields: Object.keys(requestJson).slice(0, 20),
        values: requestJson,
      });
    }
  }

  // ---- file upload (best effort) -----------------------------------------

  function handleFileUploadRequest(requestJson) {
    const fileName = `${requestJson?.file_name || requestJson?.name || ''}`.trim();
    if (!fileName) return;
    postSignal('CHATGPT_FILE_UPLOAD_DETECTED', {
      fileName: fileName.slice(0, 300),
      mimeType: `${requestJson?.mime_type || requestJson?.content_type || ''}`.trim() || undefined,
      sizeBytes: Number(requestJson?.file_size || requestJson?.size || 0) || undefined,
      attachedTo: 'prompt',
    });
  }

  function routeInterceptedRequest({ url, method, requestJson }) {
    if (shouldIgnoreUrl(url)) return;
    if (PREPARE_URL_RE.test(url) && method === 'POST') {
      handlePrepareRequest(url, requestJson);
      return;
    }
    if (FILE_UPLOAD_URL_RE.test(url) && method === 'POST') {
      handleFileUploadRequest(requestJson);
      return;
    }
    if (CONVERSATION_ITEM_URL_RE.test(url) && !CONVERSATION_SEND_URL_RE.test(url) && !PREPARE_URL_RE.test(url)) {
      handleConversationMutation(url, method, requestJson);
    }
  }

  // ---- history/SPA navigation ---------------------------------------------

  let lastNavConversationId = extractCurrentConversationIdFromUrl();

  function reportNavIfChanged() {
    const conversationId = extractCurrentConversationIdFromUrl();
    if (conversationId === lastNavConversationId) return;
    lastNavConversationId = conversationId;
    postSignal('CHATGPT_NAV_CHANGED', {
      url: location.href,
      conversationId,
      isNewConversation: !conversationId,
    });
  }

  ['pushState', 'replaceState'].forEach((methodName) => {
    try {
      const original = history[methodName];
      if (typeof original !== 'function') return;
      history[methodName] = function rmwChatGptHistoryPatch(...args) {
        const result = original.apply(this, args);
        try { reportNavIfChanged(); } catch {}
        return result;
      };
    } catch {}
  });

  window.addEventListener('popstate', () => {
    try { reportNavIfChanged(); } catch {}
  });

  // ---- fetch hook ----------------------------------------------------------

  const originalFetch = window.fetch;
  trace('fetch_patch_attempt', { isChatGptHost: isChatGptHost(), hasOriginalFetch: typeof originalFetch === 'function' });
  if (isChatGptHost() && typeof originalFetch === 'function') {
    window.fetch = async function rmwChatGptFetch(input, init) {
      const method = `${init?.method || input?.method || 'GET'}`.toUpperCase();
      const url = normalizeUrl(input);
      if (CONVERSATION_SEND_URL_RE.test(url) && method === 'POST') {
        trace('fetch_intercepted', { method, url });
      }
      const response = await originalFetch.apply(this, arguments);
      if (CONVERSATION_SEND_URL_RE.test(url) && method === 'POST') {
        trace('response_received', { url, status: response.status, bodyExists: Boolean(response.body) });
      }

      try {
        if (shouldIgnoreUrl(url)) return response;

        if (PREPARE_URL_RE.test(url) && method === 'POST') {
          const requestText = await requestBodyFromFetchArgs(input, init);
          routeInterceptedRequest({ url, method, requestJson: parseJson(requestText) });
          return response;
        }

        if (CONVERSATION_SEND_URL_RE.test(url) && method === 'POST') {
          const requestText = await requestBodyFromFetchArgs(input, init);
          const requestJson = parseJson(requestText);
          const prompt = handleConversationSendRequest(url, requestJson);
          trace('conversation_send_request_parsed', { conversationId: prompt?.conversationId || null, hasPrompt: Boolean(prompt) });

          // response.clone() can legitimately throw (TypeError: body already
          // used/locked) - previously that exception was swallowed silently
          // by this function's outer try/catch below, indistinguishable from
          // every other silent failure. Local try/catch here changes nothing
          // about the resulting behavior (the outer catch was already a
          // no-op, and this still returns the original `response` either
          // way) - it only makes an otherwise-invisible failure observable.
          let cloned;
          try {
            cloned = response.clone();
          } catch (cloneError) {
            trace('response_clone_failed', { error: `${cloneError?.message || cloneError}` });
            return response;
          }

          const contentType = `${cloned.headers?.get?.('content-type') || ''}`;
          // Previously gated strictly on content-type === text/event-stream -
          // if ChatGPT ever serves this response under a different/missing
          // content-type (proxy stripping the header, a non-SSE streaming
          // format, etc.), pumpConversationStream was never even invoked and
          // response_started/response_completed silently never fired, with
          // no log anywhere to explain why (all prior debug logging lived
          // INSIDE pumpConversationStream, which never ran). Now: log the
          // real content-type unconditionally, and attempt the SSE pump
          // whenever there's a body to read at all, not just on an exact
          // content-type match - worst case for a genuinely non-streaming
          // response is a harmless no-op (no "data:"-prefixed lines found).
          if (debugEnabled) {
            console.debug('[RMW ChatGPT Network] conversation-send response', {
              contentType,
              hasBody: Boolean(cloned.body),
              status: cloned.status,
            });
          }
          trace('response_cloned', { contentType, cloneBodyExists: Boolean(cloned.body), status: cloned.status });
          if (cloned.body) {
            trace('pump_conversation_stream_invoking', { conversationId: prompt?.conversationId || null });
            pumpConversationStream(cloned, prompt).catch((error) => {
              trace('pump_conversation_stream_rejected', { error: `${error?.message || error}` });
              if (debugEnabled) console.debug('[RMW ChatGPT Network] pumpConversationStream failed', error);
            });
          } else {
            trace('pump_conversation_stream_skipped_no_body', {});
          }
          return response;
        }

        if (STREAM_STATUS_URL_RE.test(url) && method === 'GET') {
          response.clone().text().then((text) => {
            handleStreamStatus(url, parseJson(limitText(text)));
          }).catch(() => {});
          return response;
        }

        if (FILE_UPLOAD_URL_RE.test(url) && method === 'POST') {
          const requestText = await requestBodyFromFetchArgs(input, init);
          routeInterceptedRequest({ url, method, requestJson: parseJson(requestText) });
          return response;
        }

        if (CONVERSATION_ITEM_URL_RE.test(url) && /^(PATCH|DELETE)$/.test(method)) {
          const requestText = await requestBodyFromFetchArgs(input, init);
          routeInterceptedRequest({ url, method, requestJson: parseJson(requestText) });
          return response;
        }
      } catch {}

      return response;
    };
  }

  // ---- XHR hook (fallback path for any XHR-based calls) --------------------

  const OriginalXhr = window.XMLHttpRequest;
  if (isChatGptHost() && typeof OriginalXhr === 'function') {
    const originalOpen = OriginalXhr.prototype.open;
    const originalSend = OriginalXhr.prototype.send;

    OriginalXhr.prototype.open = function rmwChatGptXhrOpen(method, url) {
      this.__rmwChatGptMethod = `${method || 'GET'}`.toUpperCase();
      this.__rmwChatGptUrl = normalizeUrl(url);
      return originalOpen.apply(this, arguments);
    };

    OriginalXhr.prototype.send = function rmwChatGptXhrSend(body) {
      const method = this.__rmwChatGptMethod || 'GET';
      const url = this.__rmwChatGptUrl || '';
      const requestText = limitText(body, MAX_BODY_LENGTH);

      this.addEventListener('loadend', () => {
        try {
          if (shouldIgnoreUrl(url)) return;
          const requestJson = parseJson(requestText);

          if (PREPARE_URL_RE.test(url) && method === 'POST') {
            routeInterceptedRequest({ url, method, requestJson });
            return;
          }
          if (FILE_UPLOAD_URL_RE.test(url) && method === 'POST') {
            routeInterceptedRequest({ url, method, requestJson });
            return;
          }
          if (STREAM_STATUS_URL_RE.test(url) && method === 'GET') {
            handleStreamStatus(url, parseJson(limitText(this.responseText)));
            return;
          }
          if (CONVERSATION_ITEM_URL_RE.test(url) && /^(PATCH|DELETE)$/.test(method)) {
            routeInterceptedRequest({ url, method, requestJson });
          }
          // Note: ChatGPT's conversation-send/SSE path is fetch-based in
          // practice, not XHR - the streaming reader above only supports
          // fetch's ReadableStream. If XHR-based streaming is ever observed
          // live, this branch needs its own SSE pump against
          // this.responseText polled incrementally (XHR does support
          // readyState 3 partial responses) - documented as a Known Risk.
        } catch {}
      });

      return originalSend.apply(this, arguments);
    };
  }
})();
