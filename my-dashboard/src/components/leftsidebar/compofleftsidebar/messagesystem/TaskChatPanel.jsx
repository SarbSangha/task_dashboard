import React, { useEffect, useState } from 'react';
import { taskAPI } from '../../../../services/api';
import './TaskChatPanel.css';
import { formatDateTimeIndia } from '../../../../utils/dateTime';

const COMMENT_TYPES = ['general', 'suggestion', 'need_improvement', 'approved'];

const TaskChatPanel = ({ task, isOpen, onClose }) => {
  const [activeTab, setActiveTab] = useState('chat');
  const [comments, setComments] = useState([]);
  const [history, setHistory] = useState([]);
  const [seenBy, setSeenBy] = useState([]);
  const [commentType, setCommentType] = useState('general');
  const [commentText, setCommentText] = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (isOpen && task?.id) {
      loadChat();
    }
  }, [isOpen, task?.id]);

  const loadChat = async () => {
    setLoading(true);
    try {
      const response = await taskAPI.getComments(task.id);
      setComments(response.comments || []);
      setHistory(response.history || []);
      setSeenBy(response.seenBy || []);
    } catch (error) {
      console.error('Failed to load chat', error);
    } finally {
      setLoading(false);
    }
  };

  const sendComment = async () => {
    if (!commentText.trim()) return;
    try {
      await taskAPI.addComment(task.id, commentText.trim(), false, commentType);
      setCommentText('');
      await loadChat();
    } catch (error) {
      alert(error?.response?.data?.detail || 'Failed to send comment');
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
          {loading ? <p>Loading...</p> : null}
          {!loading && activeTab === 'chat' && (
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
            </>
          )}
          {!loading && activeTab === 'history' && (
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
            <input value={commentText} onChange={(e) => setCommentText(e.target.value)} placeholder="Write a comment..." />
            <button onClick={sendComment}>Send</button>
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
