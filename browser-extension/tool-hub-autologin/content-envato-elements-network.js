(function installRmwEnvatoElementsNetworkTelemetry() {
  if (window.__rmwEnvatoElementsNetworkTelemetryInstalled) return;
  window.__rmwEnvatoElementsNetworkTelemetryInstalled = true;

  // MAIN-world network interceptor for Envato Elements (elements.envato.com).
  // Built without any confirmed HAR/DOM sample of this host's real download/
  // stream response - same starting position content-envato-elements-capture.js's
  // own click-detection was built from (see that file's top comment). This
  // file exists to capture the actual playable bytes of a downloaded stock
  // asset, mirroring content-elevenlabs-network.js's design exactly: the
  // real download/stream response requires the browser's OWN authenticated
  // session (and likely deducts against the team's Envato license/download
  // quota), so the backend can never independently re-fetch it - only the
  // browser, which already legitimately received the bytes, can push them.
  //
  // Two independent capture paths, same split ElevenLabs' network file uses:
  //   1. Generic content-type observation (fetch/XHR) - catches a real
  //      network response IF Envato serves the download over one, gated on
  //      audio/*|video/* content-type (no confirmed URL shape to gate on
  //      instead). No deterministic id exists here, so every capture this
  //      way is reported "unattributed" and correlated in the isolated
  //      world against the most recently reported download click.
  //   2. Blob-URL/<a download> capture - catches a download served from an
  //      already-in-memory cached Blob (no network response at all for a
  //      while, if Envato behaves anything like the client-side-cache
  //      pattern already confirmed live for ElevenLabs' own Download
  //      button). A <a download> click whose blob:/data: href matches a
  //      Blob this file itself saw via a patched createObjectURL IS the
  //      confirmed download signal (isDownload: true) - the click itself,
  //      not a network response, is the ground truth here.
  const SOURCE = 'rmw-envato-elements-network-telemetry';
  const MAX_BYTES = 100 * 1024 * 1024; // mirrors the backend's own cap
  const HOST_RE = /(^|\.)elements\.envato\.com$/i;
  const MEDIA_CONTENT_TYPE_RE = /^(audio|video)\//i;

  function isEnvatoElementsHost(url) {
    try {
      return HOST_RE.test(new URL(url, location.href).hostname);
    } catch {
      return false;
    }
  }

  function arrayBufferToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    const CHUNK_SIZE = 0x8000;
    let binary = '';
    for (let i = 0; i < bytes.length; i += CHUNK_SIZE) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK_SIZE));
    }
    return btoa(binary);
  }

  function postMediaCapture(contentType, audioBase64, isDownload, sourceUrl) {
    console.debug('[RMW Envato Elements Network] captured media', {
      contentType, base64Length: audioBase64.length, isDownload, sourceUrl: sourceUrl || '(n/a)',
    });
    window.postMessage({
      source: SOURCE,
      type: 'ENVATO_ELEMENTS_NETWORK_MEDIA_UNATTRIBUTED',
      payload: {
        contentType: contentType || 'application/octet-stream',
        audioBase64,
        sourceUrl: `${sourceUrl || ''}`.slice(0, 2000),
        capturedAt: Date.now(),
        isDownload: Boolean(isDownload),
      },
    }, location.origin);
  }

  function maybeCaptureMediaResponse(url, contentType, getArrayBuffer) {
    if (!MEDIA_CONTENT_TYPE_RE.test(contentType || '')) return;
    getArrayBuffer().then((buffer) => {
      if (!buffer || !buffer.byteLength || buffer.byteLength > MAX_BYTES) return;
      postMediaCapture(contentType, arrayBufferToBase64(buffer), false, url);
    }).catch(() => {});
  }

  // ---- fetch ----
  const rawFetch = window.fetch;
  if (typeof rawFetch === 'function') {
    window.fetch = function rmwEnvatoElementsFetch(input, init) {
      const url = typeof input === 'string' ? input : (input && input.url) || '';
      const promise = rawFetch.apply(this, arguments);
      if (!isEnvatoElementsHost(url)) return promise;
      return promise.then((response) => {
        try {
          const contentType = `${response.headers?.get?.('content-type') || ''}`;
          if (MEDIA_CONTENT_TYPE_RE.test(contentType)) {
            maybeCaptureMediaResponse(url, contentType, () => response.clone().arrayBuffer());
          }
        } catch {}
        return response;
      });
    };
  }

  // ---- XMLHttpRequest ----
  const OriginalXHR = window.XMLHttpRequest;
  if (typeof OriginalXHR === 'function') {
    const rawOpen = OriginalXHR.prototype.open;
    const rawSend = OriginalXHR.prototype.send;

    OriginalXHR.prototype.open = function rmwEnvatoElementsXhrOpen(method, url, ...rest) {
      this.__rmwEnvatoElementsUrl = url;
      return rawOpen.call(this, method, url, ...rest);
    };

    OriginalXHR.prototype.send = function rmwEnvatoElementsXhrSend(...args) {
      const url = this.__rmwEnvatoElementsUrl || '';
      if (isEnvatoElementsHost(url)) {
        this.addEventListener('loadend', function () {
          try {
            if (this.status < 200 || this.status >= 300) return;
            const contentType = `${(this.getResponseHeader && this.getResponseHeader('content-type')) || ''}`;
            if (!MEDIA_CONTENT_TYPE_RE.test(contentType)) return;
            const responseType = this.responseType;
            if (responseType === 'arraybuffer' && this.response) {
              maybeCaptureMediaResponse(url, contentType, () => Promise.resolve(this.response));
            } else if (responseType === 'blob' && this.response) {
              maybeCaptureMediaResponse(url, contentType, () => this.response.arrayBuffer());
            }
          } catch {}
        });
      }
      return rawSend.apply(this, args);
    };
  }

  // ---- Blob-URL Download capture - see this file's header (path 2) and
  // content-elevenlabs-network.js's identical "Blob-URL Download capture"
  // section for the full reasoning, ported directly. ----
  const BLOB_URL_MAP_MAX_ENTRIES = 50;
  const blobUrlToMediaBlob = new Map(); // blob: URL string -> Blob (audio/video only)
  const DATA_URI_MEDIA_RE = /^data:(audio|video)\/[^;]+;base64,/i;

  const rawCreateObjectURL = URL.createObjectURL;
  if (typeof rawCreateObjectURL === 'function') {
    URL.createObjectURL = function rmwEnvatoElementsCreateObjectURL(obj) {
      const url = rawCreateObjectURL.call(URL, obj);
      try {
        const isBlob = typeof Blob !== 'undefined' && obj instanceof Blob;
        // DIAGNOSTIC: logs every call (not just audio/video/*) so the real
        // markup shows up in the console the next time a download is
        // attempted - no confirmed traffic sample exists for this host yet.
        console.debug('[RMW Envato Elements Network] createObjectURL called', {
          url, isBlob, type: isBlob ? obj.type : typeof obj, size: isBlob ? obj.size : undefined,
        });
        // Confirmed live 2026-08-14 (ElevenLabs' equivalent case): a
        // download-prep Blob can carry a non-MIME "type" like "arraybuffer"
        // rather than a real audio/video MIME string - accept those plus
        // untyped/generic-binary shapes too, not just a strict audio/video
        // regex match.
        const looksMediaLike = isBlob && (
          MEDIA_CONTENT_TYPE_RE.test(obj.type || '')
          || obj.type === '' || obj.type === 'arraybuffer' || obj.type === 'application/octet-stream'
        );
        if (looksMediaLike) {
          if (blobUrlToMediaBlob.size >= BLOB_URL_MAP_MAX_ENTRIES) {
            const oldestKey = blobUrlToMediaBlob.keys().next().value;
            if (oldestKey !== undefined) blobUrlToMediaBlob.delete(oldestKey);
          }
          blobUrlToMediaBlob.set(url, obj);
        }
      } catch {}
      return url;
    };
  }

  const rawRevokeObjectURL = URL.revokeObjectURL;
  if (typeof rawRevokeObjectURL === 'function') {
    URL.revokeObjectURL = function rmwEnvatoElementsRevokeObjectURL(url) {
      try { blobUrlToMediaBlob.delete(url); } catch {}
      return rawRevokeObjectURL.call(URL, url);
    };
  }

  function postBlobDownloadCaptureFromBlob(blob) {
    if (!blob || !blob.size || blob.size > MAX_BYTES) return;
    blob.arrayBuffer()
      .then((buffer) => postMediaCapture(blob.type, arrayBufferToBase64(buffer), true, '(anchor download click)'))
      .catch((error) => console.debug('[RMW Envato Elements Network] failed to read blob-URL download', error));
  }

  function postBlobDownloadCaptureFromDataUri(href) {
    try {
      const commaIndex = href.indexOf(',');
      if (commaIndex === -1) return;
      const meta = href.slice(5, commaIndex);
      const contentType = meta.split(';')[0] || 'application/octet-stream';
      const audioBase64 = href.slice(commaIndex + 1);
      if (audioBase64.length > MAX_BYTES * 1.4) return;
      postMediaCapture(contentType, audioBase64, true, '(data-uri download)');
    } catch (error) {
      console.debug('[RMW Envato Elements Network] failed to decode data-URI download', error);
    }
  }

  // DIAGNOSTIC: logs every click on anything that LOOKS download-related
  // (by aria-label/title/text or a nearby SVG "download" icon use-href) so
  // the real markup shows up in the console regardless of whether the
  // detection below matches it. Remove once confirmed.
  function envatoElementsDescribeClickTarget(element) {
    if (!element) return '';
    const parts = [
      element.innerText, element.textContent,
      element.getAttribute?.('aria-label'), element.getAttribute?.('title'), element.getAttribute?.('data-cy'),
    ];
    return parts.filter(Boolean).join(' ').trim().toLowerCase();
  }

  document.addEventListener('click', (event) => {
    try {
      const path = typeof event.composedPath === 'function' ? event.composedPath() : [];
      const candidates = (path.length ? path : [event.target]).filter((node) => node?.nodeType === Node.ELEMENT_NODE).slice(0, 8);
      for (const el of candidates) {
        const text = envatoElementsDescribeClickTarget(el);
        const svgUseHref = el.querySelector?.('svg use')?.getAttribute?.('href')
          || el.querySelector?.('svg use')?.getAttribute?.('xlink:href') || '';
        if (/download/i.test(text) || /download/i.test(svgUseHref)) {
          console.debug('[RMW Envato Elements Network] click on a download-related element', {
            tag: el.tagName, text: text || null, svgUseHref: svgUseHref || null,
            outerHTML: `${el.outerHTML || ''}`.slice(0, 500),
          });
          break;
        }
      }
    } catch {}
  }, true);

  function maybeReportAnchorDownloadClick(anchor) {
    try {
      if (!anchor?.hasAttribute?.('download')) return;
      const href = anchor.getAttribute('href') || '';
      if (href.startsWith('blob:')) {
        const blob = blobUrlToMediaBlob.get(href);
        if (blob) postBlobDownloadCaptureFromBlob(blob);
        else console.debug('[RMW Envato Elements Network] <a download> with an untracked blob: href', { href });
        return;
      }
      if (DATA_URI_MEDIA_RE.test(href)) {
        postBlobDownloadCaptureFromDataUri(href);
        return;
      }
      console.debug('[RMW Envato Elements Network] <a download> clicked with neither a tracked blob: nor audio/video data: href', { href: href.slice(0, 80) });
    } catch {}
  }

  document.addEventListener('click', (event) => {
    const anchor = typeof event.target?.closest === 'function' ? event.target.closest('a[download]') : null;
    if (anchor) maybeReportAnchorDownloadClick(anchor);
  }, true);

  const rawAnchorClick = HTMLAnchorElement.prototype.click;
  if (typeof rawAnchorClick === 'function') {
    HTMLAnchorElement.prototype.click = function rmwEnvatoElementsAnchorClick(...args) {
      maybeReportAnchorDownloadClick(this);
      return rawAnchorClick.apply(this, args);
    };
  }
})();
