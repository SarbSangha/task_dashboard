(function installRmwChatGptNetworkTelemetry() {
  if (window.__rmwChatGptNetworkTelemetryInstalled) return;
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

  // Applies a single JSON-Pointer-shaped patch operation ({p, o, v}) onto an
  // accumulating plain object. Generic on purpose: rather than hardcoding
  // exact field names for "the text delta path" or "the completion path", it
  // reconstructs whatever object shape the server is actually building so the
  // existing extractAssistantTextFromMessage()/end_turn checks - already
  // proven against the legacy full-message-per-frame shape - keep working
  // unchanged once applied to the reconstructed object.
  function applyJsonPointerPatch(root, pointer, value, op) {
    const parts = `${pointer || ''}`.split('/').filter((part) => part.length > 0);
    if (parts.length === 0) return root;
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
    if (op === 'append' && typeof value === 'string') {
      node[lastKey] = `${typeof node[lastKey] === 'string' ? node[lastKey] : ''}${value}`;
    } else {
      node[lastKey] = value;
    }
    return root;
  }

  async function pumpConversationStream(response, requestPrompt) {
    const correlationId = `turn_${Date.now()}_${(turnSequence += 1)}`;
    let startedFired = false;
    let assistantMessageId = '';
    let assistantModel = requestPrompt?.model || '';
    let conversationId = requestPrompt?.conversationId || '';
    let lastAssembledText = '';
    let stopReason = '';
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
    if (!reader) return;
    const decoder = new TextDecoder('utf-8');
    let buffer = '';

    function applyStreamPatch(operation) {
      if (!operation || typeof operation.p !== 'string' || !operation.o) return;
      const { p: path, o: op, v: value } = operation;

      if (path === '') {
        // Root add/replace: the value is typically the whole envelope
        // ({ message, conversation_id, error }), not the message alone.
        if (value && typeof value === 'object') {
          assembledMessage = value.message && typeof value.message === 'object' ? value.message : value;
          if (value.conversation_id && !conversationId) conversationId = `${value.conversation_id}`.trim();
        }
        return;
      }

      if (!assembledMessage || typeof assembledMessage !== 'object') assembledMessage = {};
      const messagePath = path.startsWith('/message') ? path.slice('/message'.length) : path;
      applyJsonPointerPatch(assembledMessage, messagePath, value, op);
    }

    function handleFrame(rawEvent) {
      const dataLines = rawEvent
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trim());
      if (!dataLines.length) return;
      const dataText = dataLines.join('\n');
      if (dataText === '[DONE]') {
        finalize();
        return;
      }
      const frame = parseJson(dataText);
      if (!frame || typeof frame !== 'object') return;

      if (!conversationId && frame.conversation_id) {
        conversationId = `${frame.conversation_id}`.trim();
      }

      if (frame.message && typeof frame.message === 'object') {
        assembledMessage = frame.message;
      } else if (frame.o === 'patch' && Array.isArray(frame.v)) {
        // A batch of operations doesn't necessarily carry its own top-level
        // "p" (only each inner operation does) - this must be checked before
        // the single-operation branch below, not gated behind frame.p being
        // present. Previously nested inside `typeof frame.p === 'string' &&
        // frame.o`, which silently dropped every batched delta whenever the
        // envelope itself had no "p" - the likely reason response_started
        // fired (role captured from the initial full-object frame) while
        // response_completed never did (no text ever accumulated).
        frame.v.forEach((operation) => applyStreamPatch(operation));
      } else if (typeof frame.p === 'string' && frame.o) {
        applyStreamPatch(frame);
      } else if (debugEnabled && !startedFired) {
        console.debug('[RMW ChatGPT Network] unrecognized SSE frame shape (no frame.message, no frame.p/o)', frame);
      }

      const role = assembledMessage?.author?.role;
      if (role === 'assistant') {
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
        }
        if (!startedFired) {
          startedFired = true;
          if (debugEnabled) {
            console.debug('[RMW ChatGPT Network] response_started detected', { conversationId, assistantMessageId, assistantModel });
          }
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

    function finalize() {
      if (!startedFired) {
        // Nothing assistant-authored was ever seen - if this keeps happening,
        // it means neither wire shape handleFrame() understands actually
        // matched what ChatGPT sent this turn. Surfacing the last reconstructed
        // state (rather than nothing) gives the next live debug session
        // something concrete to look at instead of a silent no-op.
        if (debugEnabled) {
          console.debug('[RMW ChatGPT Network] stream ended with no assistant message detected', { conversationId, assembledMessage });
        }
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
        const chunk = decoder.decode(value, { stream: true });
        if (debugEnabled && !loggedFirstChunk) {
          // The single most useful diagnostic this file can produce: the
          // actual raw bytes ChatGPT sent, before any framing assumption
          // (SSE "data:"-prefixed blocks vs. bare NDJSON vs. something else)
          // is applied. Two prior fix attempts guessed at the wire shape
          // without this and were unconfirmed - this removes the guessing.
          loggedFirstChunk = true;
          console.debug('[RMW ChatGPT Network] first raw stream chunk', chunk.slice(0, 2000));
        }
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
      finalize();
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
      // Stream aborted (navigation, stop button). Emit whatever was
      // assembled so far rather than silently losing the turn - lossless
      // capture per CAPTURE_CONTRACT.md reliability class.
      if (startedFired && lastAssembledText) {
        stopReason = stopReason || 'aborted';
        finalize();
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
  if (isChatGptHost() && typeof originalFetch === 'function') {
    window.fetch = async function rmwChatGptFetch(input, init) {
      const method = `${init?.method || input?.method || 'GET'}`.toUpperCase();
      const url = normalizeUrl(input);
      const response = await originalFetch.apply(this, arguments);

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
          const cloned = response.clone();
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
          if (cloned.body) {
            pumpConversationStream(cloned, prompt).catch((error) => {
              if (debugEnabled) console.debug('[RMW ChatGPT Network] pumpConversationStream failed', error);
            });
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
