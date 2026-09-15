// content-chatgpt-attachment-capture.js — isolated world, document_idle.
//
// Captures the actual bytes of an image a user attaches to a ChatGPT prompt.
// Deliberately NOT network interception: ChatGPT's real upload wire format is
// a presigned-URL flow to a host this extension doesn't otherwise touch (the
// same pattern this app's own upload.py uses), so trying to reconstruct the
// image from network traffic would mean guessing at an unverified, likely
// cross-origin protocol. The reliable capture point is the browser's own
// File/Blob object at selection/preview time - a native, stable API
// regardless of whatever ChatGPT's frontend does with it afterward.
//
// Two capture inputs feed the same pending buffer:
//   1. DOM change/drop/paste listeners in this (isolated) world - the
//      original path, still first choice when it fires.
//   2. A URL.createObjectURL hook in the MAIN world
//      (content-chatgpt-network.js) that relays every image File/Blob ChatGPT
//      makes a thumbnail for, via the CHATGPT_ATTACHMENT_FILE_SEEN signal.
//      This catches entry paths #1 never sees - a file input inside a closed
//      shadow root (change events are composed:false), a drag from the
//      thread, etc.
//
// Conversation attribution: a captured file is held in a short-lived pending
// buffer and released once content-chatgpt.js reports the AUTHORITATIVE
// conversation_id (and the filename ChatGPT itself put in the send request)
// for the prompt that used it. Matching is by filename first; when that
// fails - ChatGPT normalizing the name, or a preview captured as a bare Blob
// with no name - and the send unambiguously declared image attachments, the
// still-unmatched pending images are paired to it FIFO. Best-effort: a
// wrongly-paired or dropped image only ever costs a thumbnail preview, never
// a captured prompt/response.
(function installRmwChatGptAttachmentCapture() {
  if (window.__rmwChatGptAttachmentCaptureInstalled) return;
  window.__rmwChatGptAttachmentCaptureInstalled = true;
  if (window.top !== window) return;

  const bus = window.RMWChatGPTCapture;
  if (!bus) return; // event-builder must load first (see manifest.json)

  const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024; // matches backend's MAX_ATTACHMENT_BYTES
  // How long a captured file's bytes wait in the pending buffer for the
  // prompt-submitted signal that names them. The old 30s was too tight - an
  // image-edit prompt is often attached first and only sent minutes later
  // while the user crafts the instruction, by which point the bytes had been
  // pruned and the message showed a bare "attached (preview not captured)"
  // placeholder even though the upload itself succeeded. The buffer holds at
  // most a handful of data URLs in memory and is still pruned; a generous
  // window costs nothing and closes that gap.
  const PENDING_ATTACHMENT_TTL_MS = 20 * 60 * 1000; // 20 minutes

  // FIFO - oldest attached file resolves first, matching selection order.
  const pendingAttachments = [];

  // The inverse race: content-chatgpt.js can call resolvePendingChatGptAttachments()
  // for a filename whose bytes haven't finished reading yet. This buffer
  // remembers that a resolution was already requested so the bytes can be
  // settled the moment they arrive instead of being lost.
  const pendingResolutions = [];

  // De-dupes the same underlying file arriving from more than one capture
  // input (a DOM change event AND the MAIN-world createObjectURL hook both
  // firing for one selection). Keyed by name+size; entries self-expire.
  const recentlyBuffered = new Map();

  function pruneExpiredPendingAttachments() {
    const cutoff = Date.now() - PENDING_ATTACHMENT_TTL_MS;
    for (let i = pendingAttachments.length - 1; i >= 0; i -= 1) {
      if (pendingAttachments[i].capturedAt < cutoff) pendingAttachments.splice(i, 1);
    }
  }

  function pruneExpiredPendingResolutions() {
    const cutoff = Date.now() - PENDING_ATTACHMENT_TTL_MS;
    for (let i = pendingResolutions.length - 1; i >= 0; i -= 1) {
      if (pendingResolutions[i].requestedAt < cutoff) pendingResolutions.splice(i, 1);
    }
  }

  function emitCaptured(conversationId, pending) {
    bus.emitSignal('CHATGPT_ATTACHMENT_CAPTURED', {
      conversationId,
      fileName: pending.fileName,
      mimeType: pending.mimeType,
      sizeBytes: pending.sizeBytes,
      dataUrl: pending.dataUrl,
    });
  }

  // The single entry point for a captured image's bytes, whichever capture
  // input produced them. Settles a waiting resolution immediately, else
  // parks the bytes in the pending buffer.
  function bufferCapturedImage({ fileName, mimeType, sizeBytes, dataUrl }) {
    if (!dataUrl) return;
    if (sizeBytes && sizeBytes > MAX_ATTACHMENT_BYTES) return;
    const name = fileName || '';
    // Keyed on the bytes, NOT the name - the DOM path and the MAIN-world
    // createObjectURL hook can report the same file with and without a name;
    // this collapses them to one buffer entry regardless.
    const dedupeKey = `${sizeBytes || 0}::${(dataUrl || '').length}::${(dataUrl || '').slice(0, 64)}`;
    if (recentlyBuffered.has(dedupeKey)) {
      // Same bytes already handled - but if this arrival carries a filename a
      // nameless earlier one lacked, backfill it onto the parked entry so
      // name-based resolution can still hit.
      if (name) {
        const parked = pendingAttachments.find((item) => !item.fileName
          && item.sizeBytes === sizeBytes && (item.dataUrl || '').length === (dataUrl || '').length);
        if (parked) parked.fileName = name;
      }
      return;
    }
    recentlyBuffered.set(dedupeKey, Date.now());
    if (recentlyBuffered.size > 64) {
      const cutoff = Date.now() - PENDING_ATTACHMENT_TTL_MS;
      for (const [key, at] of recentlyBuffered) if (at < cutoff) recentlyBuffered.delete(key);
    }

    pruneExpiredPendingResolutions();
    if (name) {
      const resolutionIndex = pendingResolutions.findIndex((item) => item.fileName === name);
      if (resolutionIndex !== -1) {
        const [resolution] = pendingResolutions.splice(resolutionIndex, 1);
        emitCaptured(resolution.conversationId, { fileName: name, mimeType, sizeBytes, dataUrl, capturedAt: Date.now() });
        return;
      }
    }
    // No name-exact resolution, but a send is already waiting on bytes it
    // couldn't match by name - settle the oldest one with these bytes,
    // adopting the name it reported (the filename-agnostic fallback, applied
    // to the "bytes arrived late" direction of the race).
    if (pendingResolutions.length > 0) {
      const [resolution] = pendingResolutions.splice(0, 1);
      emitCaptured(resolution.conversationId, {
        fileName: resolution.fileName || name, mimeType, sizeBytes, dataUrl, capturedAt: Date.now(),
      });
      return;
    }

    pruneExpiredPendingAttachments();
    pendingAttachments.push({ fileName: name, mimeType, sizeBytes, dataUrl, capturedAt: Date.now() });
  }

  // Called by content-chatgpt.js the moment it knows the true conversation_id
  // a just-submitted prompt landed in, with the image filenames ChatGPT
  // itself named in the send request.
  bus.resolvePendingChatGptAttachments = function resolvePendingChatGptAttachments(conversationId, fileNames) {
    if (!conversationId || !Array.isArray(fileNames) || !fileNames.length) return;
    pruneExpiredPendingAttachments();
    pruneExpiredPendingResolutions();

    const unresolvedNames = [];
    fileNames.forEach((fileName) => {
      const index = pendingAttachments.findIndex((item) => item.fileName && item.fileName === fileName);
      if (index === -1) {
        unresolvedNames.push(fileName);
        return;
      }
      const [pending] = pendingAttachments.splice(index, 1);
      emitCaptured(conversationId, pending);
    });

    // Filename-agnostic fallback. This send declared image attachments we
    // could not match by name; pair them, FIFO, to whatever image bytes are
    // still parked with nothing else claiming them, adopting the name ChatGPT
    // reported so the dashboard can correlate the stored file to the message
    // placeholder (which is keyed by that same name). Only ever runs because
    // the send genuinely had image attachments (fileNames non-empty), so a
    // text-only prompt can never sweep up a stale staged image. Covers
    // ChatGPT reporting a normalized/renamed filename and previews captured
    // as a nameless Blob.
    while (unresolvedNames.length > 0 && pendingAttachments.length > 0) {
      const reportedName = unresolvedNames.shift();
      const pending = pendingAttachments.shift();
      emitCaptured(conversationId, { ...pending, fileName: reportedName || pending.fileName });
    }

    // Anything still unresolved: the bytes genuinely haven't been read yet.
    // Remember the request so bufferCapturedImage() can settle it on arrival.
    unresolvedNames.forEach((fileName) => {
      pendingResolutions.push({ fileName, conversationId, requestedAt: Date.now() });
    });
  };

  // Fallback for the rare case a prompt is submitted before ChatGPT has
  // assigned the conversation an id at all - content-chatgpt.js calls this
  // once the id becomes known via the response stream.
  bus.resolveAllPendingChatGptAttachments = function resolveAllPendingChatGptAttachments(conversationId) {
    if (!conversationId) return;
    pruneExpiredPendingAttachments();
    while (pendingAttachments.length) {
      emitCaptured(conversationId, pendingAttachments.shift());
    }
  };

  async function captureImageFile(file) {
    if (!file || !file.type || !file.type.startsWith('image/')) return;
    if (file.size > MAX_ATTACHMENT_BYTES) return; // silently skip - best-effort, not an error worth surfacing
    try {
      const dataUrl = await bus.readFileAsDataUrl(file);
      bufferCapturedImage({
        fileName: file.name || '',
        mimeType: file.type,
        sizeBytes: file.size,
        dataUrl,
      });
    } catch {
      // FileReader failure or similar - drop silently (best-effort class).
    }
  }

  function handleFileList(fileList) {
    if (!fileList || !fileList.length) return;
    Array.from(fileList).forEach((file) => { captureImageFile(file); });
  }

  function handleChange(event) {
    const target = event.target;
    if (!target || target.tagName !== 'INPUT' || target.type !== 'file') return;
    handleFileList(target.files);
  }

  function handleDrop(event) {
    const files = event.dataTransfer?.files;
    if (files && files.length) handleFileList(files);
  }

  // Clipboard paste (Ctrl+V an image straight into the composer).
  function handlePaste(event) {
    const files = event.clipboardData?.files;
    if (files && files.length) {
      handleFileList(files);
      return;
    }
    const items = event.clipboardData?.items;
    if (!items || !items.length) return;
    const pastedFiles = Array.from(items)
      .filter((item) => item.kind === 'file')
      .map((item) => item.getAsFile())
      .filter(Boolean);
    if (pastedFiles.length) handleFileList(pastedFiles);
  }

  // Relayed from the MAIN-world URL.createObjectURL hook
  // (content-chatgpt-network.js) - the bytes are already read into a data URL
  // there, so this just feeds the shared buffer.
  bus.subscribe((type, payload) => {
    if (type !== 'CHATGPT_ATTACHMENT_FILE_SEEN' || !payload) return;
    bufferCapturedImage({
      fileName: payload.fileName || '',
      mimeType: payload.mimeType || 'image/png',
      sizeBytes: payload.sizeBytes || 0,
      dataUrl: payload.dataUrl || '',
    });
  });

  bus.readFeatureFlags().then((flags) => {
    if (!flags.enableCapture || !flags.enableDomCapture) return;
    document.addEventListener('change', handleChange, true);
    document.addEventListener('drop', handleDrop, true);
    document.addEventListener('paste', handlePaste, true);
  }).catch(() => {});
})();
