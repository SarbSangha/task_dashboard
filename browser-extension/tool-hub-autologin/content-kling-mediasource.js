(function installRmwKlingMediaSourceCapture() {
  if (window.__rmwKlingMediaSourceCaptureInstalled) return;
  window.__rmwKlingMediaSourceCaptureInstalled = true;

  const SOURCE = 'rmw-kling-mediasource-capture';
  const FEATURE_FLAGS = {
    enableMediaSourceCapture: true,
  };
  const COMPLETE_IDLE_MS = 4000;
  const MAX_ACTIVE_SESSIONS = 6;
  const MAX_SESSION_BYTES = 512 * 1024 * 1024;
  const MAX_SESSION_CHUNKS = 2000;

  let nextSessionNumber = 1;
  const sessionsBySourceBuffer = new WeakMap();
  const activeSessions = new Map();

  function isEnabled() {
    try {
      const override = window.__rmwKlingFeatureFlags?.enableMediaSourceCapture;
      if (typeof override === 'boolean') return override;
    } catch {}
    return FEATURE_FLAGS.enableMediaSourceCapture;
  }

  function isVideoMimeType(mimeType = '') {
    return /^video\/mp4\b/i.test(`${mimeType || ''}`.trim());
  }

  function createSession(mimeType = '') {
    const now = Date.now();
    const session = {
      sessionId: `kling-mediasource-${now}-${nextSessionNumber++}`,
      startedAt: now,
      lastChunkTime: now,
      chunks: [],
      totalBytes: 0,
      chunkCount: 0,
      mimeType: `${mimeType || 'video/mp4'}`.slice(0, 200),
      completeTimer: null,
      completed: false,
      abandoned: false,
    };
    activeSessions.set(session.sessionId, session);
    pruneActiveSessions();
    return session;
  }

  function clearSessionTimer(session) {
    if (session?.completeTimer) {
      clearTimeout(session.completeTimer);
      session.completeTimer = null;
    }
  }

  function releaseSession(session) {
    if (!session) return;
    clearSessionTimer(session);
    // The completed Blob owns its bytes after assembly. Dropping chunk references
    // here prevents long Kling sessions from growing extension/page memory.
    session.chunks = [];
    session.totalBytes = 0;
    activeSessions.delete(session.sessionId);
  }

  function abandonSession(session, reason = 'abandoned') {
    if (!session || session.completed || session.abandoned) return;
    session.abandoned = true;
    try {
      window.postMessage({
        source: SOURCE,
        type: 'KLING_MEDIASOURCE_VIDEO_DROPPED',
        payload: {
          sessionId: session.sessionId,
          reason,
          chunkCount: session.chunkCount,
          totalBytes: session.totalBytes,
          startedAt: session.startedAt,
          droppedAt: Date.now(),
        },
      }, location.origin);
    } catch {}
    releaseSession(session);
  }

  function pruneActiveSessions() {
    while (activeSessions.size > MAX_ACTIVE_SESSIONS) {
      const oldest = activeSessions.values().next().value;
      if (!oldest) break;
      abandonSession(oldest, 'max_active_sessions');
    }
  }

  function copyAppendBufferData(input) {
    try {
      if (input instanceof ArrayBuffer) {
        return input.slice(0);
      }
      if (ArrayBuffer.isView(input) && input.buffer instanceof ArrayBuffer) {
        return input.buffer.slice(input.byteOffset, input.byteOffset + input.byteLength);
      }
    } catch {}
    return null;
  }

  function scheduleCompletion(session) {
    clearSessionTimer(session);
    session.completeTimer = setTimeout(() => {
      const idleForMs = Date.now() - Number(session.lastChunkTime || 0);
      if (idleForMs < COMPLETE_IDLE_MS) {
        scheduleCompletion(session);
        return;
      }
      completeSession(session);
    }, COMPLETE_IDLE_MS);
  }

  function completeSession(session) {
    if (!session || session.completed || session.abandoned) return;
    if (!session.chunks.length || session.totalBytes <= 0) {
      abandonSession(session, 'empty_session');
      return;
    }

    session.completed = true;
    const completedAt = Date.now();
    const chunks = session.chunks;
    const totalBytes = session.totalBytes;
    const chunkCount = session.chunkCount;

    try {
      const blob = new Blob(chunks, { type: 'video/mp4' });
      window.postMessage({
        source: SOURCE,
        type: 'KLING_MEDIASOURCE_VIDEO_COMPLETE',
        payload: {
          sessionId: session.sessionId,
          blob,
          size: blob.size || totalBytes,
          chunkCount,
          totalBytes,
          mimeType: 'video/mp4',
          sourceMimeType: session.mimeType,
          startedAt: session.startedAt,
          completedAt,
          idleMs: completedAt - Number(session.lastChunkTime || completedAt),
        },
      }, location.origin);
    } catch (error) {
      try {
        window.postMessage({
          source: SOURCE,
          type: 'KLING_MEDIASOURCE_VIDEO_DROPPED',
          payload: {
            sessionId: session.sessionId,
            reason: 'blob_assembly_failed',
            error: `${error?.message || error || ''}`.slice(0, 300),
            chunkCount,
            totalBytes,
            startedAt: session.startedAt,
            droppedAt: Date.now(),
          },
        }, location.origin);
      } catch {}
    } finally {
      releaseSession(session);
    }
  }

  function recordChunk(session, input) {
    if (!session || session.completed || session.abandoned) return;
    const copiedBuffer = copyAppendBufferData(input);
    if (!copiedBuffer || !copiedBuffer.byteLength) return;

    const nextTotalBytes = session.totalBytes + copiedBuffer.byteLength;
    const nextChunkCount = session.chunkCount + 1;
    if (nextTotalBytes > MAX_SESSION_BYTES || nextChunkCount > MAX_SESSION_CHUNKS) {
      abandonSession(session, 'session_size_limit');
      return;
    }

    session.chunks.push(copiedBuffer);
    session.totalBytes = nextTotalBytes;
    session.chunkCount = nextChunkCount;
    session.lastChunkTime = Date.now();
    scheduleCompletion(session);
  }

  try {
    const originalAddSourceBuffer = window.MediaSource?.prototype?.addSourceBuffer;
    const originalAppendBuffer = window.SourceBuffer?.prototype?.appendBuffer;
    if (typeof originalAddSourceBuffer !== 'function' || typeof originalAppendBuffer !== 'function') return;

    window.MediaSource.prototype.addSourceBuffer = function rmwKlingAddSourceBuffer(mimeType) {
      const sourceBuffer = originalAddSourceBuffer.apply(this, arguments);
      if (!isEnabled() || !isVideoMimeType(mimeType)) return sourceBuffer;

      try {
        const session = createSession(mimeType);
        sessionsBySourceBuffer.set(sourceBuffer, session);
        window.postMessage({
          source: SOURCE,
          type: 'KLING_MEDIASOURCE_SESSION_STARTED',
          payload: {
            sessionId: session.sessionId,
            mimeType: session.mimeType,
            startedAt: session.startedAt,
          },
        }, location.origin);
      } catch {}

      return sourceBuffer;
    };

    window.SourceBuffer.prototype.appendBuffer = function rmwKlingAppendBuffer(buffer) {
      try {
        if (isEnabled()) {
          recordChunk(sessionsBySourceBuffer.get(this), buffer);
        }
      } catch {}
      return originalAppendBuffer.apply(this, arguments);
    };
  } catch {}

  window.addEventListener('pagehide', () => {
    for (const session of Array.from(activeSessions.values())) {
      abandonSession(session, 'pagehide');
    }
  }, true);
})();
