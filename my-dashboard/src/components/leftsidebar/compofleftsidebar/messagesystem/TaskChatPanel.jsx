import React, { useEffect, useRef, useState } from 'react';
import { fileAPI, taskAPI, subscribeRealtimeNotifications } from '../../../../services/api';
import { useCustomDialogs } from '../../../common/CustomDialogs';
import './TaskChatPanel.css';
import { formatDateTimeIndia } from '../../../../utils/dateTime';
import { useMinimizedWindowStack } from '../../../../hooks/useMinimizedWindowStack';
import ChatAttachmentGallery from '../../../common/chat/ChatAttachmentGallery';
import {
  getAttachmentDisplayName,
  mergeUniqueAttachments,
  openSystemFilePicker,
} from '../../../../utils/fileUploads';

const COMMENT_TYPES = ['general', 'suggestion', 'need_improvement', 'approved'];
const taskChatCache = new Map();

const getCacheKey = (taskId) => `task-${taskId}`;

const createInitialAttachmentUploadState = () => ({
  active: false,
  fileCount: 0,
  uploadedBytes: 0,
  totalBytes: 0,
  percent: 0,
  currentFileName: '',
  currentFileIndex: 0,
  currentFileUploadedBytes: 0,
  currentFileTotalBytes: 0,
  currentFilePercent: 0,
});

const getUploadBytesTotal = (files = []) =>
  files.reduce((sum, file) => sum + Math.max(Number(file?.size) || 0, 0), 0);

const toUploadPercent = (loaded = 0, total = 0) => {
  if (!total) return 0;
  return Math.min(100, Math.round((loaded * 100) / total));
};

const formatUploadSize = (bytes = 0) => {
  const safeBytes = Number.isFinite(bytes) ? Math.max(bytes, 0) : 0;
  if (safeBytes < 1024) return `${safeBytes} B`;

  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = safeBytes / 1024;
  let unitIndex = 0;

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  const decimals = value >= 100 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toFixed(decimals)} ${units[unitIndex]}`;
};

const buildAttachmentUploadState = (files = []) => {
  const firstFile = files[0] || null;
  const totalBytes = getUploadBytesTotal(files);
  const currentFileTotalBytes = Math.max(Number(firstFile?.size) || 0, 0);

  return {
    ...createInitialAttachmentUploadState(),
    active: files.length > 0,
    fileCount: files.length,
    totalBytes,
    currentFileName: firstFile ? getAttachmentDisplayName(firstFile) : '',
    currentFileIndex: firstFile ? 1 : 0,
    currentFileTotalBytes,
  };
};

function TaskAttachmentUploadStatus({ uploadState }) {
  if (!uploadState?.active) return null;

  const uploadLabel = uploadState.fileCount === 1 ? 'file' : 'items';
  const currentFileLine = [
    uploadState.currentFileIndex > 0
      ? `File ${uploadState.currentFileIndex} of ${uploadState.fileCount}`
      : '',
    `${formatUploadSize(uploadState.currentFileUploadedBytes)} of ${formatUploadSize(uploadState.currentFileTotalBytes)}`,
    uploadState.currentFileTotalBytes ? `${uploadState.currentFilePercent}%` : '',
  ]
    .filter(Boolean)
    .join(' • ');

  return (
    <div className="task-chat-upload-status" role="status" aria-live="polite">
      <div className="task-chat-upload-status-header">
        <div className="task-chat-upload-status-copy">
          <strong>Uploading {uploadState.fileCount} {uploadLabel}</strong>
          <span>
            {formatUploadSize(uploadState.uploadedBytes)} of {formatUploadSize(uploadState.totalBytes)} uploaded
          </span>
        </div>
        <div className="task-chat-upload-status-percent">{uploadState.percent}%</div>
      </div>
      <div className="task-chat-upload-status-bar" aria-hidden="true">
        <span style={{ width: `${uploadState.percent}%` }} />
      </div>
      <div className="task-chat-upload-status-file">
        <span>{uploadState.currentFileName || 'Preparing upload...'}</span>
        <small>{currentFileLine}</small>
      </div>
    </div>
  );
}

const TaskChatPanel = ({ task, isOpen, onClose }) => {
  const { showAlert } = useCustomDialogs();
  const [activeTab, setActiveTab] = useState('chat');
  const [comments, setComments] = useState([]);
  const [history, setHistory] = useState([]);
  const [seenBy, setSeenBy] = useState([]);
  const [commentType, setCommentType] = useState('general');
  const [commentText, setCommentText] = useState('');
  const [pendingAttachments, setPendingAttachments] = useState([]);
  const [loadingChat, setLoadingChat] = useState(false);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [sending, setSending] = useState(false);
  const [uploadingAttachment, setUploadingAttachment] = useState(false);
  const [attachmentUploadState, setAttachmentUploadState] = useState(createInitialAttachmentUploadState);
  const [chatLoaded, setChatLoaded] = useState(false);
  const [historyLoaded, setHistoryLoaded] = useState(false);
  const [isMinimized, setIsMinimized] = useState(false);
  const [isMaximized, setIsMaximized] = useState(false);
  const refreshTimerRef = useRef(null);
  const commentsEndRef = useRef(null);
  const minimizedWindowStyle = useMinimizedWindowStack('task-chat-panel', isOpen && isMinimized);

  const taskId = task?.id;

  const applyCachedState = (cacheEntry) => {
    if (!cacheEntry) return false;
    setComments(cacheEntry.comments || []);
    setHistory(cacheEntry.history || []);
    setSeenBy(cacheEntry.seenBy || []);
    setChatLoaded(Boolean(cacheEntry.chatLoaded));
    setHistoryLoaded(Boolean(cacheEntry.historyLoaded));
    return true;
  };

  const saveCache = (next) => {
    if (!taskId) return;
    taskChatCache.set(getCacheKey(taskId), {
      comments: next.comments ?? comments,
      history: next.history ?? history,
      seenBy: next.seenBy ?? seenBy,
      chatLoaded: next.chatLoaded ?? chatLoaded,
      historyLoaded: next.historyLoaded ?? historyLoaded,
    });
  };

  const loadChat = async ({ silent = false } = {}) => {
    if (!taskId) return;
    if (!silent) setLoadingChat(true);
    try {
      const response = await taskAPI.getComments(taskId, {
        include_history: false,
        include_seen_by: true,
        page_size: 40,
      });
      const nextComments = response.comments || [];
      const nextSeenBy = response.seenBy || [];
      setComments(nextComments);
      setSeenBy(nextSeenBy);
      setChatLoaded(true);
      saveCache({
        comments: nextComments,
        seenBy: nextSeenBy,
        chatLoaded: true,
      });
    } catch (error) {
      console.error('Failed to load task chat', error);
    } finally {
      if (!silent) setLoadingChat(false);
    }
  };

  const loadHistory = async ({ silent = false } = {}) => {
    if (!taskId) return;
    if (!silent) setLoadingHistory(true);
    try {
      const response = await taskAPI.getComments(taskId, {
        include_history: true,
        include_seen_by: false,
        page_size: 40,
      });
      const nextHistory = response.history || [];
      setHistory(nextHistory);
      setHistoryLoaded(true);
      saveCache({
        history: nextHistory,
        historyLoaded: true,
      });
    } catch (error) {
      console.error('Failed to load task history', error);
    } finally {
      if (!silent) setLoadingHistory(false);
    }
  };

  useEffect(() => {
    if (!isOpen || !taskId) return;
    setIsMinimized(false);
    setIsMaximized(false);
    setActiveTab('chat');
    setCommentText('');
    setCommentType('general');
    setPendingAttachments([]);
    setUploadingAttachment(false);
    setAttachmentUploadState(createInitialAttachmentUploadState());
    setComments([]);
    setHistory([]);
    setSeenBy([]);
    setChatLoaded(false);
    setHistoryLoaded(false);

    const cacheEntry = taskChatCache.get(getCacheKey(taskId));
    const hasCache = applyCachedState(cacheEntry);
    if (!hasCache || !cacheEntry?.chatLoaded) {
      void loadChat();
    } else {
      void loadChat({ silent: true });
    }
  }, [isOpen, taskId]);

  useEffect(() => {
    if (!isOpen || !taskId || activeTab !== 'history' || historyLoaded) return;
    void loadHistory();
  }, [activeTab, historyLoaded, isOpen, taskId]);

  useEffect(() => {
    if (!isOpen || !taskId) return undefined;

    const scheduleRefresh = (kind = 'chat') => {
      if (refreshTimerRef.current) return;
      refreshTimerRef.current = window.setTimeout(() => {
        refreshTimerRef.current = null;
        void loadChat({ silent: true });
        if (kind === 'history' || activeTab === 'history') {
          void loadHistory({ silent: true });
        }
      }, 120);
    };

    const unsubscribe = subscribeRealtimeNotifications({
      onMessage: (payload) => {
        if (!payload) return;
        const relatedTaskId = payload.taskId || payload?.metadata?.taskId;
        if (Number(relatedTaskId) !== Number(taskId)) return;
        if (payload.eventType === 'task_comment' || payload.eventType === 'commented') {
          scheduleRefresh('chat');
          return;
        }
        scheduleRefresh('history');
      },
      onOpen: () => {
        scheduleRefresh(activeTab === 'history' ? 'history' : 'chat');
      },
    });

    const interval = window.setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      void loadChat({ silent: true });
      if (activeTab === 'history') {
        void loadHistory({ silent: true });
      }
    }, 180000);

    return () => {
      unsubscribe();
      window.clearInterval(interval);
      if (refreshTimerRef.current) {
        window.clearTimeout(refreshTimerRef.current);
        refreshTimerRef.current = null;
      }
    };
  }, [activeTab, isOpen, taskId]);

  useEffect(() => {
    if (!isOpen || activeTab !== 'chat') return;
    const id = window.requestAnimationFrame(() => {
      commentsEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
    });
    return () => window.cancelAnimationFrame(id);
  }, [comments, activeTab, isOpen]);

  const sendComment = async () => {
    const value = commentText.trim();
    if (!taskId || sending || (!value && pendingAttachments.length === 0)) return;
    setSending(true);
    try {
      const response = await taskAPI.addComment(taskId, value, false, commentType, {
        attachments: pendingAttachments,
      });
      const nextComment = response?.comment;
      if (nextComment) {
        const nextSeenBy = seenBy.some((entry) => entry.id === nextComment.user?.id)
          ? seenBy
          : [
              ...seenBy,
              {
                id: nextComment.user?.id,
                name: nextComment.user?.name,
                role: nextComment.user?.role,
                department: nextComment.user?.department,
              },
            ];
        setComments((prev) => {
          const merged = [...prev, nextComment];
          saveCache({
            comments: merged,
            chatLoaded: true,
            seenBy: nextSeenBy,
          });
          return merged;
        });
        setSeenBy(nextSeenBy);
      }
      setCommentText('');
      setPendingAttachments([]);
      void loadChat({ silent: true });
    } catch (error) {
      await showAlert(error?.response?.data?.detail || 'Failed to send comment', { title: 'Error' });
    } finally {
      setSending(false);
    }
  };

  const handleAttachmentSelect = async (selectedFiles) => {
    const files = Array.from(selectedFiles || []);
    if (!files.length) return;
    const initialUploadState = buildAttachmentUploadState(files);
    setUploadingAttachment(true);
    setAttachmentUploadState(initialUploadState);
    try {
      const response = await fileAPI.uploadFiles(files, {
        onProgress: (_percent, metrics = {}) => {
          setAttachmentUploadState((prev) => {
            const totalBytes = prev.totalBytes || initialUploadState.totalBytes;
            const uploadedBytes = totalBytes
              ? Math.min(Math.max(Number(metrics.loaded) || 0, 0), totalBytes)
              : 0;
            return {
              ...prev,
              active: true,
              uploadedBytes,
              percent: toUploadPercent(uploadedBytes, totalBytes),
            };
          });
        },
        onFileProgress: (metrics = {}) => {
          const currentFileTotalBytes = Math.max(Number(metrics.file?.size) || Number(metrics.total) || 0, 0);
          const currentFileUploadedBytes = currentFileTotalBytes
            ? Math.min(Math.max(Number(metrics.loaded) || 0, 0), currentFileTotalBytes)
            : 0;
          setAttachmentUploadState((prev) => ({
            ...prev,
            active: true,
            currentFileName: metrics.file ? getAttachmentDisplayName(metrics.file) : prev.currentFileName,
            currentFileIndex: Number.isFinite(metrics.fileIndex) ? metrics.fileIndex + 1 : prev.currentFileIndex,
            currentFileUploadedBytes,
            currentFileTotalBytes,
            currentFilePercent: toUploadPercent(currentFileUploadedBytes, currentFileTotalBytes),
          }));
        },
      });
      setPendingAttachments((prev) => mergeUniqueAttachments(prev, response?.data || []));
    } catch (error) {
      await showAlert(error?.response?.data?.detail || 'Failed to upload attachment', { title: 'Upload Failed' });
    } finally {
      setUploadingAttachment(false);
      setAttachmentUploadState(createInitialAttachmentUploadState());
    }
  };

  const openAttachmentPickerForTaskChat = (mode) => {
    openSystemFilePicker({
      mode,
      onSelect: handleAttachmentSelect,
    });
  };

  if (!isOpen || !task) return null;

  const handleToggleMinimize = () => {
    if (isMinimized) {
      setIsMinimized(false);
      return;
    }
    setIsMaximized(false);
    setIsMinimized(true);
  };

  const handleToggleMaximize = () => {
    if (isMinimized) {
      setIsMinimized(false);
      return;
    }
    setIsMaximized((prev) => !prev);
  };

  return (
    <div
      className={`task-chat-overlay ${isMinimized ? 'minimized' : ''}`}
      onClick={!isMinimized ? onClose : undefined}
    >
      <div
        className={`task-chat-panel ${isMinimized ? 'minimized' : ''} ${isMaximized ? 'maximized' : ''}`}
        onClick={(e) => e.stopPropagation()}
        style={minimizedWindowStyle || undefined}
      >
        <div
          className="task-chat-header"
          onClick={isMinimized ? () => setIsMinimized(false) : undefined}
        >
          <div>
            <h3>Task Chat</h3>
            <p>{task.taskNumber || 'No Task ID'} • {task.projectId || 'No Project ID'}</p>
          </div>
          <div className="task-chat-window-controls">
            {!isMinimized && (
              <button
                className="task-chat-window-btn"
                onClick={(e) => {
                  e.stopPropagation();
                  handleToggleMinimize();
                }}
                title="Minimize"
              >
                ─
              </button>
            )}
            <button
              className="task-chat-window-btn"
              onClick={(e) => {
                e.stopPropagation();
                handleToggleMaximize();
              }}
              title={isMinimized ? 'Restore' : isMaximized ? 'Restore Window' : 'Maximize'}
            >
              {isMinimized ? '▢' : isMaximized ? '❐' : '□'}
            </button>
            <button
              className="task-chat-close-btn"
              onClick={(e) => {
                e.stopPropagation();
                onClose();
              }}
              title="Close"
            >
              ✕
            </button>
          </div>
        </div>

        {!isMinimized && (
          <div className="task-chat-tabs">
            <button className={activeTab === 'chat' ? 'active' : ''} onClick={() => setActiveTab('chat')}>Chat</button>
            <button className={activeTab === 'history' ? 'active' : ''} onClick={() => setActiveTab('history')}>History</button>
          </div>
        )}

        {!isMinimized && (
          <div className="task-chat-content">
            {activeTab === 'chat' && loadingChat ? <p className="task-chat-status">Loading chat...</p> : null}
            {activeTab === 'history' && loadingHistory ? <p className="task-chat-status">Loading history...</p> : null}

            {!loadingChat && activeTab === 'chat' && comments.length === 0 && (
              <p className="task-chat-status">No comments yet. Start the conversation.</p>
            )}

            {!loadingHistory && activeTab === 'history' && history.length === 0 && (
              <p className="task-chat-status">No history entries yet.</p>
            )}

            {!loadingChat && activeTab === 'chat' && (
              <>
                {comments.map((item) => (
                  <div className="chat-item" key={item.id}>
                    <div className="chat-meta">
                      <strong>{item.user?.name || 'Unknown'}</strong>
                      <span>{item.user?.role || 'unknown'} | {item.user?.department || 'N/A'}</span>
                      <span>{formatDateTimeIndia(item.createdAt)}</span>
                      <span className="chat-tag">{item.commentType || 'general'}</span>
                    </div>
                    {item.comment ? <p>{item.comment}</p> : null}
                    {!!item.attachments?.length && (
                      <div className="task-chat-comment-attachments">
                        <ChatAttachmentGallery attachments={item.attachments} />
                      </div>
                    )}
                  </div>
                ))}
                <div ref={commentsEndRef} />
              </>
            )}

            {!loadingHistory && activeTab === 'history' && (
              <>
                {history.map((h) => (
                  <div className="chat-item" key={h.id}>
                    <div className="chat-meta">
                      <strong>{h.editor?.name || 'Unknown'}</strong>
                      <span>{h.editor?.role || 'unknown'} | {h.editor?.department || 'N/A'}</span>
                      <span>{formatDateTimeIndia(h.timestamp)}</span>
                      <span className="chat-tag">{h.scope}</span>
                    </div>
                  </div>
                ))}
              </>
            )}
          </div>
        )}

        {!isMinimized && activeTab === 'chat' && (
          <div className="task-chat-input">
            <div className="task-chat-input-toolbar">
              <select value={commentType} onChange={(e) => setCommentType(e.target.value)}>
                {COMMENT_TYPES.map((ct) => (
                  <option key={ct} value={ct}>{ct}</option>
                ))}
              </select>
            </div>
            <TaskAttachmentUploadStatus uploadState={attachmentUploadState} />
            {!!pendingAttachments.length && (
              <div className="task-chat-attachment-strip">
                {pendingAttachments.map((attachment, index) => (
                  <div
                    key={`${attachment.path || attachment.url || attachment.filename || attachment.originalName}-${index}`}
                    className="task-chat-attachment-pill"
                  >
                    <span>{getAttachmentDisplayName(attachment)}</span>
                    <button
                      type="button"
                      onClick={() =>
                        setPendingAttachments((prev) => prev.filter((_, attachmentIndex) => attachmentIndex !== index))
                      }
                    >
                      x
                    </button>
                  </div>
                ))}
              </div>
            )}
            <div className="task-chat-composer-shell">
              <button
                type="button"
                className="task-chat-tool-btn"
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  openAttachmentPickerForTaskChat('files');
                }}
                title="Attach files"
                disabled={uploadingAttachment}
              >
                +
              </button>
              <button
                type="button"
                className="task-chat-tool-btn"
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  openAttachmentPickerForTaskChat('folder');
                }}
                title="Attach folder"
                disabled={uploadingAttachment}
              >
                <svg
                  className="task-chat-tool-icon"
                  viewBox="0 0 24 24"
                  aria-hidden="true"
                  focusable="false"
                >
                  <path
                    d="M3.75 6.75A2.25 2.25 0 0 1 6 4.5h3.12a2.25 2.25 0 0 1 1.59.66l1.35 1.34H18A2.25 2.25 0 0 1 20.25 8.75v7.5A2.25 2.25 0 0 1 18 18.5H6a2.25 2.25 0 0 1-2.25-2.25v-9.5Z"
                    fill="currentColor"
                    opacity="0.22"
                  />
                  <path
                    d="M3.75 8.5A2 2 0 0 1 5.75 6.5h5.38l1.32 1.3c.23.24.55.37.88.37h5.42a1.5 1.5 0 0 1 1.45 1.89l-1.16 4.32a2 2 0 0 1-1.93 1.48H5.95a2 2 0 0 1-1.98-1.74L3.75 8.5Z"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.7"
                    strokeLinejoin="round"
                  />
                </svg>
              </button>
              <input
                value={commentText}
                onChange={(e) => setCommentText(e.target.value)}
                placeholder="Write a comment..."
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    void sendComment();
                  }
                }}
              />
              <button
                type="button"
                className="task-chat-send-btn"
                onClick={sendComment}
                disabled={sending || uploadingAttachment || (!commentText.trim() && pendingAttachments.length === 0)}
              >
                {sending ? 'Sending...' : 'Send'}
              </button>
            </div>
          </div>
        )}

        {!isMinimized && (
          <div className="task-chat-seenby">
            Seen by: {seenBy.map((s) => s.name).join(', ') || 'No views yet'}
          </div>
        )}
      </div>
    </div>
  );
};

export default TaskChatPanel;
