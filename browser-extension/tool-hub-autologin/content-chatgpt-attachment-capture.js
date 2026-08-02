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

  function pruneExpiredPendingAttachments() {
    const cutoff = Date.now() - PENDING_ATTACHMENT_TTL_MS;
    for (let i = pendingAttachments.length - 1; i >= 0; i -= 1) {
      if (pendingAttachments[i].capturedAt < cutoff) pendingAttachments.splice(i, 1);
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
    fileNames.forEach((fileName) => {
      const index = pendingAttachments.findIndex((item) => item.fileName === fileName);
      if (index === -1) return;
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
      pruneExpiredPendingAttachments();
      pendingAttachments.push({
        fileName: file.name || 'image',
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

  bus.readFeatureFlags().then((flags) => {
    if (!flags.enableCapture || !flags.enableDomCapture) return;
    document.addEventListener('change', handleChange, true);
    document.addEventListener('drop', handleDrop, true);
  }).catch(() => {});
})();
