// content-claude-capture.js — isolated world, loaded on claude.ai.
//
// Turns the raw conversation-snapshot signal content-claude-network.js
// (MAIN world) posts into Capture Contract-shaped events (see
// backend/providers/claude/CAPTURE_CONTRACT.md and
// backend/providers/claude/constants.py, the source of truth for
// event_type strings and per-type payload shapes) and forwards them to the
// background worker (background-claude-capture.js) for queued, retried
// upload.
//
// Much simpler than content-chatgpt.js/content-chatgpt-event-builder.js on
// purpose - there is exactly one signal type to handle
// (CLAUDE_CONVERSATION_SNAPSHOT, Claude's own authoritative full-message-
// tree response), so there is no separate event-builder file, no DOM
// observer, no stream/SSE state machine. One file owns the whole pipeline:
// dedup a snapshot's messages against what this tab has already sent,
// build an envelope per new message, and hand it to chrome.runtime.
(function installRmwClaudeCapture() {
  if (window.__rmwClaudeCaptureInstalled) return;
  window.__rmwClaudeCaptureInstalled = true;

  const CAPTURE_VERSION = 1;
  const PROVIDER = 'claude';
  const NEW_CONVERSATION_AGE_THRESHOLD_MS = 5 * 60 * 1000;

  const EVENT_TYPE = {
    CONVERSATION_OPENED: 'conversation_opened',
    CONVERSATION_CREATED: 'conversation_created',
    CONVERSATION_RENAMED: 'conversation_renamed',
    CONVERSATION_DELETED: 'conversation_deleted',
    PROMPT_CAPTURED: 'prompt_captured',
    RESPONSE_COMPLETED: 'response_completed',
  };

  // ---- Feature flag (single kill switch - see background-claude-capture.js,
  // which reads the same chrome.storage.local key independently) ----------
  const FEATURE_FLAGS_STORAGE_KEY = 'claudeCaptureFeatureFlags';
  let captureEnabled = true;
  async function readCaptureEnabled() {
    try {
      const stored = await chrome.storage.local.get([FEATURE_FLAGS_STORAGE_KEY]);
      const flags = stored[FEATURE_FLAGS_STORAGE_KEY] || {};
      captureEnabled = flags.enableCapture !== false;
    } catch {
      captureEnabled = true;
    }
  }
  readCaptureEnabled();

  let extensionVersion = '';
  try {
    extensionVersion = chrome.runtime.getManifest().version || '';
  } catch {}

  function generateClientEventId() {
    try {
      if (typeof crypto?.randomUUID === 'function') return crypto.randomUUID();
    } catch {}
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (character) => {
      const random = (Math.random() * 16) | 0;
      const value = character === 'x' ? random : (random & 0x3) | 0x8;
      return value.toString(16);
    });
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
      blocks.push({ language: match[1] || undefined, code: (match[2] || '').slice(0, 8000) });
      match = pattern.exec(text || '');
    }
    return blocks;
  }

  function buildEnvelope(eventType, { conversationId, messageId, clientEventId, payload } = {}) {
    return {
      event_type: eventType,
      client_event_id: clientEventId || generateClientEventId(),
      conversation_id: conversationId || undefined,
      message_id: messageId || undefined,
      payload: payload || {},
      capture_version: CAPTURE_VERSION,
      extension_version: extensionVersion || undefined,
      browser: `chrome/${(navigator.userAgentData?.brands || []).map((b) => b.version).find(Boolean) || ''}`.replace(/\/$/, '') || undefined,
      event_date: new Date().toISOString().slice(0, 10),
    };
  }

  // Resolves true only once the background worker has confirmed the event was
  // actually queued. Callers use that to decide whether the message may be
  // recorded as "seen" - see processMessage/processSnapshot below.
  //
  // The old version was fire-and-forget, and its comment claimed a dropped
  // send would simply "get picked up again on the next snapshot observation".
  // It could not: seenMessageUuids.add() ran BEFORE the send, so a dropped
  // event was permanently marked as handled for the life of the tab and no
  // later snapshot ever re-sent it. Losing the send and remembering it as
  // done is the worst of both worlds, so delivery is confirmed now.
  function sendEvent(event) {
    if (!captureEnabled) return Promise.resolve(false);
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage({ type: 'CLAUDE_CAPTURE_EVENT', event }, (response) => {
          // chrome.runtime.lastError is read (even if unused) so a torn-down
          // context (extension reloaded mid-navigation) doesn't spam the
          // console with "Unchecked runtime.lastError".
          const failed = Boolean(chrome.runtime.lastError);
          resolve(!failed && response?.ok !== false);
        });
      } catch {
        resolve(false);
      }
    });
  }

  // ---- Per-tab dedup state ----------------------------------------------
  // Session-scoped (in-memory, not persisted) on purpose: the backend's own
  // idempotency (deterministic client_event_id - see
  // backend/providers/claude/capture.py) is the real source of truth for
  // "was this already captured", this is purely a bandwidth optimization so
  // a long-lived tab doesn't re-POST every historical message on every
  // snapshot re-observation.
  const seenMessageUuids = new Set();
  const seenConversationUuids = new Set();
  const titleByConversation = new Map();
  // Separate from seenMessageUuids: a message can be marked "seen" (its
  // prompt_captured event sent) while its attachment upload is still
  // pending, retried, or simply skipped this pass (best-effort, not gated
  // by the message's own seen-state - see captureFileAttachments below).
  const capturedAttachmentUuids = new Set();

  // Marks the id as seen BEFORE the send (so a second snapshot arriving while
  // this one is still in flight cannot double-send it), then removes it again
  // if delivery was not confirmed - which is what makes the next snapshot
  // observation a real second chance instead of a no-op.
  function sendTracked(seenSet, id, event) {
    if (id) seenSet.add(id);
    return sendEvent(event).then((delivered) => {
      if (!delivered && id) seenSet.delete(id);
      return delivered;
    });
  }

  function isNewConversation(conversation) {
    const createdAt = Date.parse(conversation.created_at || '');
    if (!Number.isFinite(createdAt)) return false;
    return Date.now() - createdAt < NEW_CONVERSATION_AGE_THRESHOLD_MS;
  }

  function extractMessageText(message) {
    const content = Array.isArray(message?.content) ? message.content : [];
    return content
      .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text)
      .join('\n\n');
  }

  function buildContentParts(message) {
    const content = Array.isArray(message?.content) ? message.content : [];
    return content.map((block, index) => {
      if (block && block.type === 'text' && typeof block.text === 'string') {
        return { type: 'markdown', order: index, text: block.text };
      }
      return { type: 'attachment', order: index, raw: block };
    });
  }

  function extractCitations(message) {
    const content = Array.isArray(message?.content) ? message.content : [];
    const citations = [];
    for (const block of content) {
      if (Array.isArray(block?.citations)) citations.push(...block.citations);
    }
    return citations;
  }

  function extractAttachments(message) {
    // Claude's own "attachments" array is for pasted text/large snippets
    // (no downloadable bytes, no preview_url) - metadata-only, same as
    // ChatGPT's contract's identical field. Real uploaded FILES (images,
    // PDFs, etc, with actual bytes to capture) are message.files instead -
    // see extractFiles/captureFileAttachments below.
    return (Array.isArray(message?.attachments) ? message.attachments : []).map((attachment) => ({
      type: `${attachment?.file_type || ''}`.startsWith('image') ? 'image' : 'file',
      name: `${attachment?.file_name || ''}`.slice(0, 300) || undefined,
    }));
  }

  function extractFiles(message) {
    // uuid carried through so the eventual captured-bytes upload (see
    // captureFileAttachments) can be correlated back to this exact prompt
    // message on the read side - backend/providers/claude/queries.py's
    // list_conversation_attachments returns rows keyed by fileName, which
    // captureFileAttachments sets to this same uuid.
    return (Array.isArray(message?.files) ? message.files : []).map((file) => ({
      name: `${file?.file_name || ''}`.slice(0, 300) || undefined,
      mimeType: file?.file_kind || undefined,
      uuid: file?.file_uuid || undefined,
      // The whole file object, verbatim. It is a small metadata blob, and
      // throwing it away is what made the PDF case unanswerable: the event
      // recorded that a document was attached but not which URL fields Claude
      // offered for it, so there was no way to tell from captured data alone
      // why its bytes never arrived. Lossless capture means keeping this.
      raw: file && typeof file === 'object' ? file : undefined,
    }));
  }

  function readBlobAsDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    });
  }

  // Best-effort capture of a prompt's actual uploaded file bytes (image,
  // PDF, etc) - separate from the lossless prompt_captured event, matching
  // content-chatgpt.js's own resolveAndUploadImagePart posture ("losing one
  // occasionally... is an acceptable tradeoff", see
  // backend/providers/claude/attachments.py). Unlike ChatGPT (whose API
  // never hands back a fetchable URL for an uploaded input file, forcing DOM
  // file-input/drop interception instead), Claude's own snapshot already
  // gives every attached file a same-origin, cookie-authenticated preview
  // URL right on the message object - confirmed live
  // (`/api/{orgId}/files/{fileUuid}/preview`, `image/webp`, a few hundred KB
  // - a reasonably-sized, reviewable representation, not the multi-MB
  // original). Fetched directly from this isolated-world content script:
  // same-origin requests from a content script carry the page's own cookies
  // without needing to bounce through the MAIN world.
  //
  // preview_url is tried before thumbnail_url (same fields, larger/smaller
  // rendition) - whichever exists first that this fetch actually succeeds
  // for wins; a fetch failure (transient, or a file type Claude doesn't
  // generate a preview for - e.g. some non-image files might only ever get
  // a thumbnail_url, or neither) falls through to trying the other, then
  // gives up on that one file without affecting any other file or the
  // prompt_captured event itself, which has already been sent by the time
  // this runs.
  // Which URL fields a file object carries depends on its file_kind.
  // preview_url/thumbnail_url are confirmed live for file_kind:"image".
  // They are NOT sufficient for file_kind:"document": confirmed live
  // 2026-09-06, an uploaded PDF produced a prompt_captured event with
  // files[0].mimeType "document" and a correct uuid, but no
  // ConversationCaptureAttachment row at all - so the dashboard showed the
  // filename with nothing behind it to open.
  //
  // Rather than hard-code another guessed endpoint name, take every *_url
  // string the file object actually carries and try them most-complete-first.
  // That picks up whatever Claude calls the document URL without this file
  // having to know the name in advance, and is a no-op for images (which
  // still resolve via preview_url exactly as before).
  const FILE_URL_FIELD_PRIORITY = [
    'document_url',
    'file_url',
    'download_url',
    'url',
    'preview_url',
    'thumbnail_url',
  ];

  function candidateFileUrls(file, organizationId) {
    const urls = [];
    const push = (value) => {
      const trimmed = `${value || ''}`.trim();
      if (trimmed && !urls.includes(trimmed)) urls.push(trimmed);
    };

    FILE_URL_FIELD_PRIORITY.forEach((field) => push(file?.[field]));
    // Anything else ending in _url that Claude ships and this list does not
    // know about yet - the whole point of collecting these from the data.
    Object.keys(file || {}).forEach((key) => {
      if (/_url$/i.test(key) && typeof file[key] === 'string') push(file[key]);
    });

    // UNVERIFIED derived fallback, deliberately tried last and only when the
    // snapshot told us the org id: a 404 here costs one request and falls
    // through to giving up on this file, exactly as before. The `raw` field
    // now preserved on every captured file (see extractFiles) is what will
    // let this guess be replaced with the real endpoint once a document's
    // actual field shape has been read back out of a captured event.
    const fileUuid = file?.file_uuid;
    if (organizationId && fileUuid) {
      push(`/api/${organizationId}/files/${fileUuid}/document`);
      push(`/api/organizations/${organizationId}/files/${fileUuid}/document`);
    }
    return urls;
  }

  async function captureFileAttachments(conversationUuid, message, organizationId) {
    if (!captureEnabled) return;
    const files = Array.isArray(message?.files) ? message.files : [];
    for (const file of files) {
      const fileUuid = file?.file_uuid;
      if (!fileUuid || capturedAttachmentUuids.has(fileUuid)) continue;
      // Marked before the attempt so two overlapping snapshots don't both
      // upload the same file, and un-marked below if nothing was captured -
      // otherwise one failed fetch permanently gives up on that file for the
      // life of the tab, which is precisely how the PDF above ended up with a
      // metadata badge and no bytes. Same optimistic-mark-then-roll-back
      // shape as sendTracked() above.
      capturedAttachmentUuids.add(fileUuid);
      let captured = false;

      const candidateUrls = candidateFileUrls(file, organizationId);
      if (!candidateUrls.length) {
        console.debug('[RMW Claude Capture] file has no fetchable url field', {
          fileUuid, kind: file?.file_kind, fields: Object.keys(file || {}),
        });
      }
      for (const relativeUrl of candidateUrls) {
        try {
          const absoluteUrl = new URL(relativeUrl, location.origin).href;
          const response = await fetch(absoluteUrl, { credentials: 'include' });
          if (!response.ok) continue;
          const blob = await response.blob();
          if (!blob || !blob.size) continue;
          const dataUrl = await readBlobAsDataUrl(blob);
          chrome.runtime.sendMessage({
            type: 'CLAUDE_CAPTURE_ATTACHMENT',
            attachment: {
              conversation_id: conversationUuid || undefined,
              kind: 'input',
              // The file's own uuid, not its human filename - this is the key
              // ConversationPrompt.files_json[].uuid is matched against on the
              // read side (see claudeCaptureUtils.js matchStoredAttachments).
              file_name: fileUuid,
              // The blob's real content type, so a PDF is stored as
              // application/pdf and the dashboard's FilePreviewModal renders
              // it as a document rather than as an unknown binary.
              mime_type: blob.type || undefined,
              data_url: dataUrl,
            },
          }, () => { void chrome.runtime.lastError; });
          captured = true;
          console.debug('[RMW Claude Capture] captured file bytes', {
            fileUuid, kind: file?.file_kind, via: relativeUrl, type: blob.type, size: blob.size,
          });
          break; // succeeded - no need to also try the other candidate URLs
        } catch {
          // Try the next candidate URL, if any.
        }
      }

      if (!captured) {
        capturedAttachmentUuids.delete(fileUuid);
        console.debug('[RMW Claude Capture] no bytes captured for file - will retry on a later snapshot', {
          fileUuid, kind: file?.file_kind, tried: candidateUrls,
        });
      }
    }
  }

  function firstTimestamp(message) {
    const content = Array.isArray(message?.content) ? message.content : [];
    return content[0]?.start_timestamp || message?.created_at || undefined;
  }

  function lastTimestamp(message) {
    const content = Array.isArray(message?.content) ? message.content : [];
    return content[content.length - 1]?.stop_timestamp || message?.updated_at || undefined;
  }

  function conversationContextFields(conversation, newConversation) {
    return {
      isNewConversation: newConversation,
      providerCreatedAt: conversation.created_at || undefined,
    };
  }

  // Reported bug: a message that failed to build/send (any exception inside
  // this function - text/content-part extraction is defensive but not
  // proven exception-free against every real message shape) was still
  // permanently marked as "already handled" in seenMessageUuids, since that
  // used to happen unconditionally at the top of this function, before any
  // of the extraction/sendEvent calls that could actually fail. That
  // message's event was then never retried by ANY later snapshot
  // observation for the rest of this tab's lifetime, even though it was
  // never actually sent - a real capture gap masquerading as "already
  // captured". seenMessageUuids is now only updated once the corresponding
  // sendEvent() call has actually been made (see the two call sites below),
  // and the whole per-message body runs inside its own try/catch so one
  // malformed message can never block ITS OWN retry, let alone (were this
  // called from a loop that didn't already isolate each iteration - see
  // processSnapshot below) any other message in the same snapshot.
  function processMessage(conversation, message, conversationUuid, newConversation, organizationId) {
    if (!message?.uuid || seenMessageUuids.has(message.uuid)) return;

    try {
      if (message.sender === 'human') {
        const text = extractMessageText(message);
        const envelope = buildEnvelope(EVENT_TYPE.PROMPT_CAPTURED, {
          conversationId: conversationUuid,
          messageId: message.uuid,
          clientEventId: `${PROVIDER}:${conversationUuid}:prompt:${message.uuid}`,
          payload: {
            text,
            textLength: text.length,
            attachments: extractAttachments(message),
            files: extractFiles(message),
            codeBlocks: extractCodeBlocks(text),
            sequenceIndex: message.index,
            promptTimestamp: firstTimestamp(message),
            parentMessageId: message.parent_message_uuid || undefined,
            ...conversationContextFields(conversation, newConversation),
          },
        });
        // Only recorded as "seen" once the envelope is fully built and
        // handed to sendEvent() - see this function's own header comment -
        // and un-recorded again if that send was never confirmed.
        sendTracked(seenMessageUuids, message.uuid, envelope);
        // Fire-and-forget: file bytes are a separate, best-effort capture
        // (see captureFileAttachments's own docstring) that must never block
        // or fail this message's own prompt_captured send, which has
        // already happened by this point.
        captureFileAttachments(conversationUuid, message, organizationId).catch(() => {});
      } else if (message.sender === 'assistant') {
        const text = extractMessageText(message);
        // Reported bug: a response_completed event that happens to be the
        // FIRST event this backend ever normalizes for a given conversation
        // (common - see the belt-and-suspenders re-fetch in
        // content-claude-network.js, and Claude's own tool-use turns taking
        // long enough that the response snapshot can land before the
        // prompt's own event does) left that conversation permanently
        // unattributed without these fields: backend
        // providers/claude/normalization.py's _is_attributable had nothing
        // to go on and always answered "no" - and ownership is sticky
        // (decided once, at record creation, never revisited by a later
        // event), so a LATER prompt_captured/conversation_opened event for
        // the very same conversation, even with these fields correctly
        // present, could no longer fix it. Every event type now carries the
        // same conversation-identity context, matching
        // prompt_captured/conversation_opened/conversation_created below.
        const envelope = buildEnvelope(EVENT_TYPE.RESPONSE_COMPLETED, {
          conversationId: conversationUuid,
          messageId: message.uuid,
          clientEventId: `${PROVIDER}:${conversationUuid}:response:${message.uuid}`,
          payload: {
            text,
            textLength: text.length,
            codeBlocks: extractCodeBlocks(text),
            hasMarkdown: looksLikeMarkdown(text),
            hasTables: looksLikeTable(text),
            contentSource: 'authoritative_fetch',
            contentParts: buildContentParts(message),
            citations: extractCitations(message),
            completedAt: lastTimestamp(message),
            stopReason: message.stop_reason || undefined,
            parentMessageId: message.parent_message_uuid || undefined,
            sequenceIndex: message.index,
            model: conversation.model || undefined,
            ...conversationContextFields(conversation, newConversation),
          },
        });
        sendTracked(seenMessageUuids, message.uuid, envelope);
      }
      // Any other sender value is left uncaptured (documented event types
      // only cover human/assistant - see CAPTURE_CONTRACT.md) rather than
      // guessed at; nothing here silently mislabels it as one of the two.
    } catch (error) {
      // Deliberately does NOT mark this message as seen - see this
      // function's own header comment. A later snapshot observation (the
      // extension's normal recovery path for anything it hasn't captured
      // yet) gets a real second chance at it instead of it being silently
      // and permanently dropped.
      try { console.debug('[RMW Claude Capture] failed to process message', message?.uuid, error); } catch {}
    }
  }

  function processSnapshot(payload) {
    const conversation = payload?.conversation;
    const conversationUuid = payload?.conversationUuid || conversation?.uuid;
    if (!conversation || !conversationUuid || !Array.isArray(conversation.chat_messages)) return;

    const alreadyTracked = seenConversationUuids.has(conversationUuid);
    const newConversation = isNewConversation(conversation);
    const previousTitle = titleByConversation.get(conversationUuid);
    const currentTitle = conversation.name || '';

    if (!alreadyTracked) {
      sendTracked(
        seenConversationUuids,
        conversationUuid,
        buildEnvelope(newConversation ? EVENT_TYPE.CONVERSATION_CREATED : EVENT_TYPE.CONVERSATION_OPENED, {
          conversationId: conversationUuid,
          payload: {
            title: currentTitle || undefined,
            url: payload.url || location.href,
            model: conversation.model || undefined,
            providerUpdatedAt: conversation.updated_at || undefined,
            ...conversationContextFields(conversation, newConversation),
          },
        })
      );
    } else {
      // Refresh metadata (title/model/last-activity) on every later
      // observation of an already-tracked conversation, via the same
      // conversation_opened event type - see
      // providers/claude/normalization.py's _handle_conversation_snapshot_metadata.
      sendEvent(
        buildEnvelope(EVENT_TYPE.CONVERSATION_OPENED, {
          conversationId: conversationUuid,
          payload: {
            title: currentTitle || undefined,
            url: payload.url || location.href,
            model: conversation.model || undefined,
            providerUpdatedAt: conversation.updated_at || undefined,
            ...conversationContextFields(conversation, newConversation),
          },
        })
      );
      if (previousTitle && currentTitle && previousTitle !== currentTitle) {
        sendEvent(
          buildEnvelope(EVENT_TYPE.CONVERSATION_RENAMED, {
            conversationId: conversationUuid,
            payload: { previousTitle, newTitle: currentTitle },
          })
        );
      }
    }
    titleByConversation.set(conversationUuid, currentTitle);

    const messages = conversation.chat_messages
      .slice()
      .sort((a, b) => (Number(a?.index) || 0) - (Number(b?.index) || 0));
    for (const message of messages) {
      processMessage(conversation, message, conversationUuid, newConversation, payload?.organizationId);
    }
  }

  function processDeletion(payload) {
    if (!payload?.conversationUuid) return;
    sendEvent(
      buildEnvelope(EVENT_TYPE.CONVERSATION_DELETED, {
        conversationId: payload.conversationUuid,
        payload: { detectedVia: 'explicit_delete_action' },
      })
    );
  }

  window.addEventListener(
    'message',
    (event) => {
      if (event.source !== window) return;
      if (event.origin !== location.origin) return;
      const data = event.data;
      if (!data || data.source !== 'rmw-claude-network') return;
      try {
        if (data.type === 'CLAUDE_CONVERSATION_SNAPSHOT') {
          processSnapshot(data.payload);
        } else if (data.type === 'CLAUDE_CONVERSATION_DELETED') {
          processDeletion(data.payload);
        }
      } catch {
        // A malformed/unexpected snapshot shape should never break the rest
        // of the page - see CAPTURE_CONTRACT.md's lossless posture: losing
        // one snapshot's events is still recoverable next time this
        // conversation is opened, which re-sends its full history anyway.
      }
    },
    false
  );
})();
