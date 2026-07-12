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
  const CONVERSATION_ID_WAIT_INTERVAL_MS = 500;
  const CONVERSATION_ID_WAIT_MAX_TICKS = 16; // ~8s - covers "attach then immediately send"

  function currentConversationId() {
    const match = location.pathname.match(/\/c\/([^/?#]+)/i);
    return match ? match[1] : '';
  }

  function waitForConversationId() {
    return new Promise((resolve) => {
      const immediate = currentConversationId();
      if (immediate) { resolve(immediate); return; }
      let ticks = 0;
      const timer = setInterval(() => {
        ticks += 1;
        const found = currentConversationId();
        if (found || ticks >= CONVERSATION_ID_WAIT_MAX_TICKS) {
          clearInterval(timer);
          resolve(found);
        }
      }, CONVERSATION_ID_WAIT_INTERVAL_MS);
    });
  }

  function readFileAsDataUrl(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    });
  }

  async function captureImageFile(file) {
    if (!file || !file.type || !file.type.startsWith('image/')) return;
    if (file.size > MAX_ATTACHMENT_BYTES) return; // silently skip - best-effort, not an error worth surfacing

    try {
      const [conversationId, dataUrl] = await Promise.all([
        waitForConversationId(),
        readFileAsDataUrl(file),
      ]);
      bus.emitSignal('CHATGPT_ATTACHMENT_CAPTURED', {
        conversationId,
        fileName: file.name || 'image',
        mimeType: file.type,
        sizeBytes: file.size,
        dataUrl,
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
