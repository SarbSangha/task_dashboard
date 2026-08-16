// content-chatgpt-attachment-capture.js — isolated world, document_idle.
//
// Captures the actual bytes of an image a user attaches to a ChatGPT prompt.
// Deliberately NOT network interception: ChatGPT's real upload wire format is
// a presigned-URL flow to a host this extension doesn't otherwise touch (the
// same pattern this app's own upload.py uses), so trying to reconstruct the
// image from network traffic would mean guessing at an unverified, likely
// cross-origin protocol. The reliable capture point is the browser's own
// File object at selection time - a native, stable API regardless of
// whatever ChatGPT's frontend does with it afterward.
//
// Conversation attribution: a captured file is held in a short-lived pending
// buffer keyed by filename and only released once content-chatgpt.js reports
// the AUTHORITATIVE conversation_id for the send that actually used it - the
// same value content-chatgpt-network.js reads straight off ChatGPT's own
// request body and the text-capture pipeline already relies on for
// prompt_captured. This file used to resolve its own conversation_id by
// polling location.pathname for up to 8s after the file was selected, which
// raced against the user simply navigating elsewhere during that window
// (e.g. browsing an old conversation while their new message was still
// sending) - the photo would silently get attributed to whatever
// conversation happened to be open when the poll resolved, not the one it
// was actually attached to. Correlating through the same signal the text
// pipeline uses removes the guess entirely.
//
// Best-effort (not part of the lossless event queue): a dropped image here
// only means a conversation's text is captured without a thumbnail preview,
// never a lost prompt/response.
(function installRmwChatGptAttachmentCapture() {
  if (window.__rmwChatGptAttachmentCaptureInstalled) return;
  window.__rmwChatGptAttachmentCaptureInstalled = true;
  if (window.top !== window) return;

  const bus = window.RMWChatGPTCapture;
  if (!bus) return; // event-builder must load first (see manifest.json)

  const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024; // matches backend's MAX_ATTACHMENT_BYTES
  const PENDING_ATTACHMENT_TTL_MS = 30000; // best-effort - longer than any plausible "attach then type then send" gap

  // FIFO per filename - oldest attached file with a given name resolves
  // first, matching the order files were actually selected in.
  const pendingAttachments = [];

  // The inverse race: content-chatgpt.js can call resolvePendingChatGptAttachments()
  // for a filename whose bytes haven't finished reading yet -
  // captureImageFile() is async (FileReader over a real image file, possibly
  // several MB) and only pushes into pendingAttachments AFTER that read
  // resolves. If the user attaches an image and sends a short prompt (e.g.
  // "add a text hi") fast enough, CHATGPT_PROMPT_SUBMITTED - and therefore
  // resolvePendingChatGptAttachments's ONE-SHOT lookup - can fire before the
  // read finishes. That lookup finding nothing used to just return and
  // forget: nothing ever looks at pendingAttachments again for that filename,
  // so the bytes land moments later with no one listening and the message
  // stays permanently "uploaded but not associated". This buffer remembers
  // that a resolution was already requested, so captureImageFile() can
  // settle it immediately once the bytes actually arrive instead of losing
  // it - the mirror image of pendingAttachments, keyed the same way.
  const pendingResolutions = [];

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

  // Called by content-chatgpt.js the moment it knows the true conversation_id
  // a just-submitted prompt landed in (CHATGPT_PROMPT_SUBMITTED), matched by
  // filename against whatever this script captured off the DOM.
  bus.resolvePendingChatGptAttachments = function resolvePendingChatGptAttachments(conversationId, fileNames) {
    if (!conversationId || !Array.isArray(fileNames) || !fileNames.length) return;
    pruneExpiredPendingAttachments();
    pruneExpiredPendingResolutions();
    fileNames.forEach((fileName) => {
      const index = pendingAttachments.findIndex((item) => item.fileName === fileName);
      if (index === -1) {
        // Bytes not captured yet - remember this request so
        // captureImageFile() can settle it the moment they arrive, instead
        // of the attachment being silently lost (see pendingResolutions'
        // own comment above for the race this closes).
        pendingResolutions.push({ fileName, conversationId, requestedAt: Date.now() });
        return;
      }
      const [pending] = pendingAttachments.splice(index, 1);
      emitCaptured(conversationId, pending);
    });
  };

  // Fallback for the rare case a prompt is submitted before ChatGPT has
  // assigned the conversation an id at all (empty conversationId at submit
  // time) - content-chatgpt.js calls this once the id becomes known via the
  // response stream (CHATGPT_CONVERSATION_CREATED). At most one brand-new
  // conversation can be in flight at that point, so anything still waiting
  // is safe to resolve to it.
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
      const fileName = file.name || 'image';

      pruneExpiredPendingResolutions();
      const resolutionIndex = pendingResolutions.findIndex((item) => item.fileName === fileName);
      if (resolutionIndex !== -1) {
        // A resolution request for this exact filename already arrived
        // while these bytes were still being read - settle it right now
        // instead of buffering into pendingAttachments, where nothing would
        // ever look at it again.
        const [resolution] = pendingResolutions.splice(resolutionIndex, 1);
        emitCaptured(resolution.conversationId, {
          fileName, mimeType: file.type, sizeBytes: file.size, dataUrl, capturedAt: Date.now(),
        });
        return;
      }

      pruneExpiredPendingAttachments();
      pendingAttachments.push({
        fileName,
        mimeType: file.type,
        sizeBytes: file.size,
        dataUrl,
        capturedAt: Date.now(),
      });
    } catch {
      // FileReader failure or similar - drop silently, matches the
      // best-effort reliability class for attachments.
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

  // Clipboard paste (Ctrl+V an image straight into the composer) is a third,
  // equally common way to attach an image in ChatGPT's UI, alongside the
  // file picker (change) and drag-and-drop (drop) above - and previously had
  // no listener at all, so every pasted image silently never entered
  // pendingAttachments: no bytes captured, nothing to upload, and the
  // message permanently showed its attachment placeholder as "uploaded but
  // not associated with this message" in the Capture Center (confirmed
  // against a real production conversation where 100% of image attachments
  // were unassociated). event.clipboardData.files covers the common case;
  // some browsers/paste sources only populate .items with kind:'file'
  // entries instead, so that's checked too rather than assuming either shape
  // is always present.
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

  bus.readFeatureFlags().then((flags) => {
    if (!flags.enableCapture || !flags.enableDomCapture) return;
    document.addEventListener('change', handleChange, true);
    document.addEventListener('drop', handleDrop, true);
    document.addEventListener('paste', handlePaste, true);
  }).catch(() => {});
})();
