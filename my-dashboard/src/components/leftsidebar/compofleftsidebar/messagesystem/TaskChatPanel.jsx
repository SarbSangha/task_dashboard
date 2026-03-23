import React, { useEffect, useRef, useState } from 'react';
import { taskAPI, subscribeRealtimeNotifications } from '../../../../services/api';
import { useCustomDialogs } from '../../../common/CustomDialogs';
import './TaskChatPanel.css';
import { formatDateTimeIndia } from '../../../../utils/dateTime';

const COMMENT_TYPES = ['general', 'suggestion', 'need_improvement', 'approved'];
const taskChatCache = new Map();

const getCacheKey = (taskId) => `task-${taskId}`;

const TaskChatPanel = ({ task, isOpen, onClose }) => {
  const { showAlert } = useCustomDialogs();
  const [activeTab, setActiveTab] = useState('chat');
  const [comments, setComments] = useState([]);
  const [history, setHistory] = useState([]);
  const [seenBy, setSeenBy] = useState([]);
  const [commentType, setCommentType] = useState('general');
  const [commentText, setCommentText] = useState('');
  const [loadingChat, setLoadingChat] = useState(false);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [sending, setSending] = useState(false);
  const [chatLoaded, setChatLoaded] = useState(false);
  const [historyLoaded, setHistoryLoaded] = useState(false);
  const refreshTimerRef = useRef(null);
  const commentsEndRef = useRef(null);

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
    setActiveTab('chat');
    setCommentText('');
    setCommentType('general');

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
    if (!taskId || !value || sending) return;
    setSending(true);
    try {
      const response = await taskAPI.addComment(taskId, value, false, commentType);
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
      void loadChat({ silent: true });
    } catch (error) {
      await showAlert(error?.response?.data?.detail || 'Failed to send comment', { title: 'Error' });
    } finally {
      setSending(false);
    }
  };

  if (!isOpen || !task) return null;

  return (
    <div className="task-chat-overlay" onClick={onClose}>
      <div className="task-chat-panel" onClick={(e) => e.stopPropagation()}>
        <div className="task-chat-header">
          <div>
            <h3>Task Chat</h3>
            <p>{task.taskNumber || 'No Task ID'} • {task.projectId || 'No Project ID'}</p>
          </div>
          <button onClick={onClose}>✕</button>
        </div>

        <div className="task-chat-tabs">
          <button className={activeTab === 'chat' ? 'active' : ''} onClick={() => setActiveTab('chat')}>Chat</button>
          <button className={activeTab === 'history' ? 'active' : ''} onClick={() => setActiveTab('history')}>History</button>
        </div>

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
                  <p>{item.comment}</p>
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

        {activeTab === 'chat' && (
          <div className="task-chat-input">
            <select value={commentType} onChange={(e) => setCommentType(e.target.value)}>
              {COMMENT_TYPES.map((ct) => (
                <option key={ct} value={ct}>{ct}</option>
              ))}
            </select>
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
            <button onClick={sendComment} disabled={sending || !commentText.trim()}>
              {sending ? 'Sending...' : 'Send'}
            </button>
          </div>
        )}

        <div className="task-chat-seenby">
          Seen by: {seenBy.map((s) => s.name).join(', ') || 'No views yet'}
        </div>
      </div>
    </div>
  );
};

export default TaskChatPanel;
