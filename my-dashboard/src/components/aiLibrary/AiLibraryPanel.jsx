import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import WindowControls from '../common/WindowControls';
import { useCustomDialogs } from '../common/CustomDialogs';
import { useMinimizedWindowStack } from '../../hooks/useMinimizedWindowStack';
import { useDebouncedValue } from '../../hooks/useDebouncedValue';
import { isMobileViewport } from '../../utils/isMobileViewport';
import { clientsAPI } from '../../services/api';
import { aiLibraryAPI } from '../../services/aiLibrary';
import { startDriveUpload, UploadCancelledError } from '../../utils/driveResumableUpload';
import '../reports/TaskReportPanel.css';
import './AiLibraryPanel.css';

/**
 * AI Library: drop files here and they land in the connected Google Drive,
 * under AI Library / <date> / <user> / <client>.
 *
 * Each file goes browser -> Drive directly: the server only hands out a
 * one-time resumable upload URL (backend/routers/ai_library_router.py) and
 * verifies the result afterwards. Visibility is the "ai_library" Section
 * Access grant (Admin Queue -> Section Access); the endpoints enforce it
 * too. Only admins see the connect / disconnect controls.
 *
 * The queue lives in this component's state, which survives the panel being
 * closed or minimized (FunctionalMenu keeps it mounted), so uploads keep
 * going in the background. Reloading or leaving the page does stop them,
 * hence the beforeunload warning while any are active.
 */

const CONCURRENCY = 3;
const PAGE_SIZE = 25;
const PROGRESS_PAINT_MS = 200;
const CLIENT_STORAGE_KEY = 'aiLibrary.lastClientId';
const ACTIVE = new Set(['starting', 'uploading', 'verifying']);
const EMPTY_FILTERS = { start: '', end: '', clientId: '', userId: '', status: '', search: '' };

const STATUS_LABELS = {
  queued: 'Waiting',
  starting: 'Preparing',
  uploading: 'Uploading',
  verifying: 'Verifying',
  done: 'Uploaded',
  failed: 'Failed',
  cancelled: 'Cancelled',
  pending: 'Incomplete',
  complete: 'Uploaded',
};

const readError = (err, fallback) => {
  const detail = err?.response?.data?.detail;
  if (typeof detail === 'string') return detail;
  return err?.message || fallback;
};

const formatBytes = (bytes) => {
  const value = Number(bytes) || 0;
  if (value < 1024) return `${value} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let size = value / 1024;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) { size /= 1024; unit += 1; }
  return `${size >= 100 ? size.toFixed(0) : size.toFixed(1)} ${units[unit]}`;
};

const formatTime = (iso) => (iso ? new Date(iso).toLocaleString() : '—');

const readStoredClient = () => {
  try { return window.localStorage.getItem(CLIENT_STORAGE_KEY) || ''; } catch { return ''; }
};
const storeClient = (value) => {
  try { window.localStorage.setItem(CLIENT_STORAGE_KEY, value); } catch { /* storage blocked */ }
};

let _itemSeq = 0;

export default function AiLibraryPanel({ isOpen, onClose, onMinimizedChange, onActivate }) {
  const [isMinimized, setIsMinimized] = useState(false);
  const [isMaximized, setIsMaximized] = useState(isMobileViewport);
  const minimizedWindowStyle = useMinimizedWindowStack('ai-library-panel', isOpen && isMinimized);
  const { showConfirm } = useCustomDialogs();
  const [searchParams, setSearchParams] = useSearchParams();

  const [status, setStatus] = useState(null);
  const [statusError, setStatusError] = useState('');
  const [notice, setNotice] = useState(null);           // { tone: 'success' | 'error', text }
  const [connectBusy, setConnectBusy] = useState(false);

  const [clients, setClients] = useState([]);
  const [clientId, setClientId] = useState(readStoredClient);

  const [items, setItems] = useState([]);
  const [dragActive, setDragActive] = useState(false);
  const controlsRef = useRef(new Map());   // item key -> { cancel, cancelled }
  const fileInputRef = useRef(null);
  const dragDepthRef = useRef(0);

  const [filters, setFilters] = useState(EMPTY_FILTERS);
  const search = useDebouncedValue(filters.search, 400);
  const [page, setPage] = useState(1);
  const [history, setHistory] = useState({ items: [], total: 0 });
  const [historyOptions, setHistoryOptions] = useState({ clients: [], users: [] });
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState('');
  const [historyNonce, setHistoryNonce] = useState(0);
  const historyRequestRef = useRef(0);

  const canManage = !!status?.canManage;
  const connected = !!status?.connected;
  const selectedClient = clients.find((c) => String(c.id) === String(clientId)) || null;
  const canDrop = connected && !!selectedClient;

  // ── Connection status ────────────────────────────────────────────────
  const loadStatus = useCallback(async () => {
    try {
      setStatus(await aiLibraryAPI.status());
      setStatusError('');
    } catch (err) {
      setStatusError(readError(err, 'Could not load the AI Library status.'));
    }
  }, []);

  useEffect(() => {
    if (!isOpen) return;
    loadStatus();
    clientsAPI.getClientsForTasks()
      .then((data) => setClients(data?.clients || []))
      .catch(() => setClients([]));
  }, [isOpen, loadStatus]);

  // Google sends the admin back to /dashboard/ai-library?drive=connected
  // (or ?drive_error=...). Show it once, then strip it from the URL.
  useEffect(() => {
    const ok = searchParams.get('drive');
    const failed = searchParams.get('drive_error');
    if (!ok && !failed) return;
    setNotice(failed
      ? { tone: 'error', text: failed }
      : { tone: 'success', text: 'Google Drive connected.' });
    const next = new URLSearchParams(searchParams);
    next.delete('drive');
    next.delete('drive_error');
    setSearchParams(next, { replace: true });
    loadStatus();
  }, [searchParams, setSearchParams, loadStatus]);

  // ── History ──────────────────────────────────────────────────────────
  const historyParams = useMemo(() => ({
    start: filters.start || undefined,
    end: filters.end || undefined,
    clientId: filters.clientId || undefined,
    userId: filters.userId || undefined,
    status: filters.status || undefined,
    q: search || undefined,
  }), [filters.start, filters.end, filters.clientId, filters.userId, filters.status, search]);

  const loadHistory = useCallback(async () => {
    if (historyParams.start && historyParams.end && historyParams.start > historyParams.end) {
      setHistoryError('"From" date must be on or before the "To" date.');
      return;
    }
    const id = historyRequestRef.current + 1;
    historyRequestRef.current = id;
    setHistoryLoading(true);
    try {
      const [list, opts] = await Promise.all([
        aiLibraryAPI.list({ ...historyParams, page, pageSize: PAGE_SIZE }),
        aiLibraryAPI.options(),
      ]);
      if (historyRequestRef.current !== id) return;
      setHistory({ items: list.items || [], total: list.total || 0 });
      setHistoryOptions({ clients: opts.clients || [], users: opts.users || [] });
      setHistoryError('');
    } catch (err) {
      if (historyRequestRef.current === id) setHistoryError(readError(err, 'Could not load upload history.'));
    } finally {
      if (historyRequestRef.current === id) setHistoryLoading(false);
    }
  }, [historyParams, page]);

  useEffect(() => {
    if (isOpen) loadHistory();
  }, [isOpen, loadHistory, historyNonce]);

  // ── Upload queue ─────────────────────────────────────────────────────
  const patchItem = useCallback((key, patch) => {
    setItems((prev) => prev.map((item) => (item.key === key ? { ...item, ...patch } : item)));
  }, []);

  const runItem = useCallback(async (item) => {
    const control = { cancel: null, cancelled: false };
    controlsRef.current.set(item.key, control);
    let uploadId = item.uploadId || null;
    try {
      // Retrying an item whose bytes already reached Drive (only the
      // verify call failed) must not upload it a second time - that would
      // leave a duplicate file in the folder.
      let driveFileId = item.driveFileId || null;
      if (!(uploadId && driveFileId)) {
        patchItem(item.key, { status: 'starting', loaded: 0, error: '' });
        const session = await aiLibraryAPI.createUpload({
          fileName: item.file.name,
          sizeBytes: item.file.size,
          mimeType: item.file.type || undefined,
          clientId: item.clientId,
        });
        uploadId = session.upload.id;
        patchItem(item.key, { uploadId, folderPath: session.upload.folderPath });
        if (control.cancelled) throw new UploadCancelledError();

        // XHR progress fires many times a second per file; re-rendering the
        // whole panel (history table included) that often is wasted work.
        let lastPaint = 0;
        const upload = startDriveUpload({
          file: item.file,
          uploadUrl: session.uploadUrl,
          chunkSize: session.chunkSizeBytes || 8 * 1024 * 1024,
          onProgress: (loaded, total) => {
            const now = Date.now();
            if (now - lastPaint < PROGRESS_PAINT_MS && loaded < total) return;
            lastPaint = now;
            patchItem(item.key, { status: 'uploading', loaded });
          },
        });
        control.cancel = upload.cancel;
        const driveFile = await upload.promise;
        if (!driveFile?.id) throw new Error('Google Drive did not return the uploaded file.');
        driveFileId = driveFile.id;
        patchItem(item.key, { driveFileId });
      }

      patchItem(item.key, { status: 'verifying', loaded: item.file.size, error: '' });
      const done = await aiLibraryAPI.completeUpload(uploadId, driveFileId);
      patchItem(item.key, { status: 'done', driveLink: done.upload.driveLink });
      setHistoryNonce((n) => n + 1);
    } catch (err) {
      const cancelled = err instanceof UploadCancelledError || control.cancelled;
      const message = cancelled ? 'Cancelled' : readError(err, 'Upload failed.');
      patchItem(item.key, { status: cancelled ? 'cancelled' : 'failed', error: cancelled ? '' : message });
      if (uploadId) aiLibraryAPI.failUpload(uploadId, message).catch(() => {});
    } finally {
      controlsRef.current.delete(item.key);
    }
  }, [patchItem]);

  // Start queued files, CONCURRENCY at a time.
  useEffect(() => {
    const running = items.filter((i) => ACTIVE.has(i.status)).length;
    const next = items.filter((i) => i.status === 'queued').slice(0, Math.max(0, CONCURRENCY - running));
    if (!next.length) return;
    // Mark them first so this effect does not pick them up twice.
    setItems((prev) => prev.map((i) => (next.some((n) => n.key === i.key) ? { ...i, status: 'starting' } : i)));
    next.forEach((item) => { runItem(item); });
  }, [items, runItem]);

  // FunctionalMenu keeps this panel mounted while the dashboard is, so this
  // runs on logout: without it the XHRs keep streaming to Drive after the
  // session is gone.
  useEffect(() => {
    const controls = controlsRef.current;
    return () => {
      controls.forEach((control) => {
        control.cancelled = true;
        control.cancel?.();
      });
    };
  }, []);

  const hasActiveUploads = items.some((i) => i.status === 'queued' || ACTIVE.has(i.status));

  useEffect(() => {
    if (!hasActiveUploads) return undefined;
    const warn = (e) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [hasActiveUploads]);

  const enqueue = (fileList, directoryNames = []) => {
    if (!selectedClient) return;
    const maxSize = status?.maxFileSizeBytes || Infinity;
    const added = Array.from(fileList || []).map((file) => {
      _itemSeq += 1;
      const tooBig = file.size > maxSize;
      return {
        key: `f${_itemSeq}`,
        file,
        clientId: selectedClient.id,
        clientName: selectedClient.name,
        status: tooBig ? 'failed' : 'queued',
        loaded: 0,
        error: tooBig ? `Larger than the ${formatBytes(maxSize)} limit.` : '',
        retryable: !tooBig,
      };
    });
    const folders = directoryNames.map((name) => {
      _itemSeq += 1;
      return {
        key: `f${_itemSeq}`,
        file: { name, size: 0 },
        clientId: selectedClient.id,
        clientName: selectedClient.name,
        status: 'failed',
        loaded: 0,
        error: 'Folders cannot be uploaded. Open the folder and drop the files inside it.',
        isFolder: true,
        retryable: false,
      };
    });
    if (added.length || folders.length) setItems((prev) => [...added, ...folders, ...prev]);
  };

  const handleDrop = (e) => {
    e.preventDefault();
    dragDepthRef.current = 0;
    setDragActive(false);
    if (!canDrop) return;
    const entries = Array.from(e.dataTransfer.items || []);
    const directoryNames = [];
    const files = [];
    if (entries.length && typeof entries[0].webkitGetAsEntry === 'function') {
      entries.forEach((entry) => {
        if (entry.kind !== 'file') return;
        const fsEntry = entry.webkitGetAsEntry();
        if (fsEntry?.isDirectory) directoryNames.push(fsEntry.name);
        else {
          const file = entry.getAsFile();
          if (file) files.push(file);
        }
      });
    } else {
      files.push(...Array.from(e.dataTransfer.files || []));
    }
    enqueue(files, directoryNames);
  };

  const handleDragEnter = (e) => {
    e.preventDefault();
    dragDepthRef.current += 1;
    setDragActive(true);
  };
  const handleDragLeave = (e) => {
    e.preventDefault();
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) setDragActive(false);
  };

  const cancelItem = (key) => {
    const control = controlsRef.current.get(key);
    if (control) {
      control.cancelled = true;
      control.cancel?.();
    } else {
      patchItem(key, { status: 'cancelled' });
    }
  };
  // An item that already reached Drive keeps its ids, so the retry only
  // re-runs the verification instead of uploading the bytes again.
  const retryItem = (key) => setItems((prev) => prev.map((item) => {
    if (item.key !== key) return item;
    return item.driveFileId
      ? { ...item, status: 'queued', error: '' }
      : { ...item, status: 'queued', loaded: 0, error: '', uploadId: null };
  }));
  const clearFinished = () => setItems((prev) => prev.filter((i) => i.status === 'queued' || ACTIVE.has(i.status)));

  // ── Connect / disconnect (admins) ────────────────────────────────────
  const connectDrive = async () => {
    if (hasActiveUploads) {
      const ok = await showConfirm('Uploads in progress will stop when you leave to sign in with Google. Continue?',
        { confirmText: 'Continue' });
      if (!ok) return;
    }
    setConnectBusy(true);
    try {
      const { url } = await aiLibraryAPI.connectUrl();
      window.location.assign(url);
    } catch (err) {
      setNotice({ tone: 'error', text: readError(err, 'Could not start the Google sign-in.') });
      setConnectBusy(false);
    }
  };

  const disconnectDrive = async () => {
    const ok = await showConfirm(
      'Disconnect Google Drive? Uploads stop working until an admin connects it again. Files already in Drive stay there.',
      { confirmText: 'Disconnect' },
    );
    if (!ok) return;
    setConnectBusy(true);
    try {
      const next = await aiLibraryAPI.disconnect();
      setStatus((prev) => ({ ...prev, ...next }));
      setNotice({ tone: 'success', text: 'Google Drive disconnected.' });
    } catch (err) {
      setNotice({ tone: 'error', text: readError(err, 'Could not disconnect Google Drive.') });
    } finally {
      setConnectBusy(false);
    }
  };

  // ── Window chrome ────────────────────────────────────────────────────
  useEffect(() => {
    onMinimizedChange?.(isOpen && isMinimized);
  }, [isMinimized, isOpen, onMinimizedChange]);

  useEffect(() => {
    if (!isOpen) {
      setIsMinimized(false);
      setIsMaximized(false);
    } else {
      setIsMaximized(isMobileViewport());
    }
  }, [isOpen]);

  const handleToggleMinimize = () => {
    if (isMinimized) { onActivate?.(); setIsMinimized(false); return; }
    setIsMinimized(true);
  };
  const handleToggleMaximize = () => {
    if (isMinimized) { onActivate?.(); setIsMinimized(false); return; }
    setIsMaximized((prev) => !prev);
  };

  const setFilter = (key) => (e) => {
    setPage(1);
    setFilters((prev) => ({ ...prev, [key]: e.target.value }));
  };

  if (!isOpen) return null;

  const totalPages = Math.max(1, Math.ceil(history.total / PAGE_SIZE));
  const hasFilters = Object.entries(filters).some(([k, v]) => v !== EMPTY_FILTERS[k]);
  const hasFinished = items.some((i) => !(i.status === 'queued' || ACTIVE.has(i.status)));
  const activeCount = items.filter((i) => i.status === 'queued' || ACTIVE.has(i.status)).length;
  const showUserColumn = canManage;

  return (
    <>
      <div className={`trp-overlay ${isMinimized ? 'disabled' : ''}`} onClick={!isMinimized ? onClose : undefined} />
      <div
        className={`trp-panel ail-panel ${isMinimized ? 'minimized' : ''} ${isMaximized ? 'maximized' : ''}`}
        style={minimizedWindowStyle || undefined}
        onClick={isMinimized ? handleToggleMinimize : undefined}
        role="dialog"
        aria-modal="true"
        aria-label="AI Library"
      >
        <div className="trp-header">
          <div className="trp-brand">
            <span className="trp-brand-mark" aria-hidden="true">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M7 18a4.5 4.5 0 0 1-.6-8.96A6 6 0 0 1 18 8.5a4 4 0 0 1-.5 9.5" />
                <polyline points="9 14 12 11 15 14" /><line x1="12" y1="11" x2="12" y2="20" />
              </svg>
            </span>
            <h2 className="trp-title">AI Library</h2>
            {isMinimized && activeCount > 0 && <span className="ail-mini-count">{activeCount} uploading</span>}
          </div>
          <div className="trp-header-spacer" />
          <WindowControls
            isMinimized={isMinimized}
            isMaximized={isMaximized}
            onMinimize={handleToggleMinimize}
            onMaximize={handleToggleMaximize}
            onClose={onClose}
          />
        </div>

        {!isMinimized && (
          <div className="trp-body">
            {notice && (
              <div className={`ail-notice ail-notice--${notice.tone}`} role="status">
                <span>{notice.text}</span>
                <button type="button" className="ail-link-btn" onClick={() => setNotice(null)} aria-label="Dismiss">×</button>
              </div>
            )}
            {statusError && <div className="trp-error" role="alert">{statusError}</div>}

            {/* ── Connection ── */}
            {status && (
              <div className={`ail-connection${connected ? ' ail-connection--on' : ''}`}>
                <span className={`ail-dot${connected ? ' ail-dot--on' : ''}`} aria-hidden="true" />
                <div className="ail-connection-text">
                  {connected ? (
                    <>
                      <strong>Connected to Google Drive</strong>
                      <span>
                        Files go to {status.accountEmail || 'the connected account'}
                        {status.rootFolderLink && (
                          <> · <a href={status.rootFolderLink} target="_blank" rel="noreferrer">Open “{status.rootFolderName}” folder</a></>
                        )}
                      </span>
                    </>
                  ) : !status.configured ? (
                    <>
                      <strong>Google Drive is not set up on the server</strong>
                      <span>{canManage
                        ? 'Add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET to backend/.env and restart the backend.'
                        : 'Ask an administrator to set up the AI Library.'}</span>
                    </>
                  ) : (
                    <>
                      <strong>Google Drive is not connected</strong>
                      <span>{canManage
                        ? 'Connect the Google account whose Drive should hold the AI Library.'
                        : 'Ask an administrator to connect Google Drive.'}</span>
                    </>
                  )}
                </div>
                {canManage && status.configured && (
                  connected ? (
                    <button type="button" className="ail-secondary-btn" onClick={disconnectDrive} disabled={connectBusy}>
                      Disconnect
                    </button>
                  ) : (
                    <button type="button" className="trp-generate-btn" onClick={connectDrive} disabled={connectBusy}>
                      {connectBusy ? 'Opening Google…' : 'Connect Google Drive'}
                    </button>
                  )
                )}
              </div>
            )}

            {/* ── Upload ── */}
            <section className="ail-upload">
              <div className="trp-filters ail-upload-controls">
                <label className="trp-field ail-client-field">
                  <span>Client</span>
                  <select
                    value={clientId}
                    onChange={(e) => { setClientId(e.target.value); storeClient(e.target.value); }}
                    disabled={!connected}
                  >
                    <option value="">Select a client…</option>
                    {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                  </select>
                </label>
                {selectedClient && (
                  <span className="ail-destination" title="Where these files will be saved">
                    Saves to <code>{status?.rootFolderName || 'AI Library'} / today / you / {selectedClient.name}</code>
                  </span>
                )}
              </div>

              <div
                className={`ail-dropzone${dragActive && canDrop ? ' ail-dropzone--active' : ''}${canDrop ? '' : ' ail-dropzone--disabled'}`}
                onDragEnter={handleDragEnter}
                onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = canDrop ? 'copy' : 'none'; }}
                onDragLeave={handleDragLeave}
                onDrop={handleDrop}
                onClick={() => canDrop && fileInputRef.current?.click()}
                onKeyDown={(e) => { if (canDrop && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); fileInputRef.current?.click(); } }}
                role="button"
                tabIndex={canDrop ? 0 : -1}
                aria-disabled={!canDrop}
                aria-label="Drop files here or press to choose files"
              >
                <svg className="ail-dropzone-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M7 18a4.5 4.5 0 0 1-.6-8.96A6 6 0 0 1 18 8.5a4 4 0 0 1-.5 9.5" />
                  <polyline points="9 14 12 11 15 14" /><line x1="12" y1="11" x2="12" y2="20" />
                </svg>
                {!connected ? (
                  <p>Uploads are available once Google Drive is connected.</p>
                ) : !selectedClient ? (
                  <p>Select a client first, then drop files here.</p>
                ) : (
                  <>
                    <p><strong>Drop files here</strong> or click to choose</p>
                    <span className="ail-hint">
                      Up to {formatBytes(status?.maxFileSizeBytes)} per file · sent straight to Google Drive
                    </span>
                  </>
                )}
                <input
                  ref={fileInputRef}
                  type="file"
                  multiple
                  hidden
                  onChange={(e) => { enqueue(e.target.files); e.target.value = ''; }}
                />
              </div>

              {items.length > 0 && (
                <div className="ail-queue">
                  <div className="ail-queue-head">
                    <h3>This session</h3>
                    {hasFinished && <button type="button" className="ail-link-btn" onClick={clearFinished}>Clear finished</button>}
                  </div>
                  <ul>
                    {items.map((item) => {
                      const pct = item.file.size ? Math.round((item.loaded / item.file.size) * 100) : (item.status === 'done' ? 100 : 0);
                      const active = item.status === 'queued' || ACTIVE.has(item.status);
                      return (
                        <li key={item.key} className={`ail-item ail-item--${item.status}`}>
                          <div className="ail-item-main">
                            <span className="ail-item-name" title={item.file.name}>{item.file.name}</span>
                            <span className="ail-item-meta">
                              {item.isFolder ? 'Folder' : formatBytes(item.file.size)} · {item.clientName}
                            </span>
                          </div>
                          <div className="ail-progress" aria-hidden={item.status !== 'uploading'}>
                            <span style={{ width: `${pct}%` }} />
                          </div>
                          <span className="ail-item-status">
                            {item.status === 'uploading' ? `${pct}%` : STATUS_LABELS[item.status]}
                          </span>
                          <span className="ail-item-actions">
                            {active && <button type="button" className="ail-link-btn" onClick={() => cancelItem(item.key)}>Cancel</button>}
                            {(item.status === 'failed' || item.status === 'cancelled') && item.retryable && (
                              <button type="button" className="ail-link-btn" onClick={() => retryItem(item.key)}>Retry</button>
                            )}
                            {item.status === 'done' && item.driveLink && (
                              <a href={item.driveLink} target="_blank" rel="noreferrer">Open</a>
                            )}
                          </span>
                          {item.error && <span className="ail-item-error">{item.error}</span>}
                        </li>
                      );
                    })}
                  </ul>
                </div>
              )}
            </section>

            {/* ── History ── */}
            <section className="ail-history">
              <h3>Upload history{!canManage && ' (yours)'}</h3>
              <div className="trp-filters">
                <label className="trp-field">
                  <span>From</span>
                  <input type="date" value={filters.start} onChange={setFilter('start')} max={filters.end || undefined} />
                </label>
                <label className="trp-field">
                  <span>To</span>
                  <input type="date" value={filters.end} onChange={setFilter('end')} min={filters.start || undefined} />
                </label>
                <label className="trp-field">
                  <span>Client</span>
                  <select value={filters.clientId} onChange={setFilter('clientId')}>
                    <option value="">All clients</option>
                    {historyOptions.clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                  </select>
                </label>
                {showUserColumn && (
                  <label className="trp-field">
                    <span>Uploaded by</span>
                    <select value={filters.userId} onChange={setFilter('userId')}>
                      <option value="">Everyone</option>
                      {historyOptions.users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
                    </select>
                  </label>
                )}
                <label className="trp-field">
                  <span>Status</span>
                  <select value={filters.status} onChange={setFilter('status')}>
                    <option value="">Any</option>
                    <option value="complete">Uploaded</option>
                    <option value="pending">Incomplete</option>
                    <option value="failed">Failed</option>
                  </select>
                </label>
                <label className="trp-field ail-search">
                  <span>Search</span>
                  <input type="search" placeholder="File name…" value={filters.search} onChange={setFilter('search')} />
                </label>
                <div className="ail-history-actions">
                  {hasFilters && (
                    <button type="button" className="ail-secondary-btn" onClick={() => { setPage(1); setFilters(EMPTY_FILTERS); }}>
                      Reset
                    </button>
                  )}
                  <button type="button" className="ail-secondary-btn" onClick={loadHistory} disabled={historyLoading}>
                    {historyLoading ? 'Loading…' : 'Refresh'}
                  </button>
                </div>
              </div>

              {historyError && <div className="trp-error" role="alert">{historyError}</div>}

              {history.items.length === 0 ? (
                <p className="trp-empty">{historyLoading ? 'Loading…' : 'No uploads yet.'}</p>
              ) : (
                <div className="trp-table-wrap">
                  <table className="trp-table ail-table">
                    <thead>
                      <tr>
                        <th>Uploaded</th>
                        <th>File</th>
                        <th>Client</th>
                        {showUserColumn && <th>By</th>}
                        <th>Size</th>
                        <th>Status</th>
                        <th aria-label="Drive link" />
                      </tr>
                    </thead>
                    <tbody>
                      {history.items.map((row) => (
                        <tr key={row.id}>
                          <td>{formatTime(row.completedAt || row.createdAt)}</td>
                          <td className="ail-file-cell" title={row.folderPath ? `${row.folderPath} / ${row.fileName}` : row.fileName}>
                            {row.fileName}
                          </td>
                          <td>{row.clientName || '—'}</td>
                          {showUserColumn && <td>{row.userName || '—'}</td>}
                          <td>{formatBytes(row.sizeBytes)}</td>
                          <td>
                            <span className={`ail-pill ail-pill--${row.status}`} title={row.error || undefined}>
                              {STATUS_LABELS[row.status] || row.status}
                            </span>
                          </td>
                          <td>
                            {row.driveLink && <a href={row.driveLink} target="_blank" rel="noreferrer">Open in Drive</a>}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              {history.total > PAGE_SIZE && (
                <div className="ail-pager">
                  <button type="button" className="ail-secondary-btn" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>Previous</button>
                  <span>Page {page} of {totalPages} · {history.total.toLocaleString()} uploads</span>
                  <button type="button" className="ail-secondary-btn" disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}>Next</button>
                </div>
              )}
            </section>
          </div>
        )}
      </div>
    </>
  );
}
