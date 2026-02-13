// src/components/leftsidebar/compofleftsidebar/inbox/InboxPanel.jsx
import React, { useState, useEffect } from 'react';
import InboxCard from './InboxCard';
import TaskDetailModal from './TaskDetailModal';
import './InboxPanel.css';

const InboxPanel = ({ isOpen, onClose }) => {
  const [tasks, setTasks] = useState([]);
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState('all');
  const [selectedTask, setSelectedTask] = useState(null);

  useEffect(() => {
    if (isOpen) {
      fetchInboxTasks();
    }
  }, [isOpen]);

  const fetchInboxTasks = async () => {
    setLoading(true);
    try {
      const response = await fetch('http://localhost:8000/api/tasks/inbox', {
        credentials: 'include'
      });
      const data = await response.json();
      if (data.success) {
        setTasks(data.data);
      }
    } catch (error) {
      console.error('Error fetching inbox:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleTaskClick = (task) => {
    setSelectedTask(task);
  };

  const handleCloseDetail = () => {
    setSelectedTask(null);
    fetchInboxTasks();
  };

  const filteredTasks = tasks.filter(task => {
    if (filter === 'unread') return !task.isRead;
    if (filter === 'working') return task.status === 'working';
    return true;
  });

  if (!isOpen) return null;

  return (
    <>
      <div className="inbox-panel-overlay" onClick={onClose}>
        <div className="inbox-panel-container" onClick={(e) => e.stopPropagation()}>
          {/* Header */}
          <div className="inbox-panel-header">
            <h2>📥 Inbox</h2>
            <button className="inbox-close-btn" onClick={onClose}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </div>

          {/* Filters */}
          <div className="inbox-filters">
            <button 
              className={`filter-btn ${filter === 'all' ? 'active' : ''}`}
              onClick={() => setFilter('all')}
            >
              All ({tasks.length})
            </button>
            <button 
              className={`filter-btn ${filter === 'unread' ? 'active' : ''}`}
              onClick={() => setFilter('unread')}
            >
              Unread ({tasks.filter(t => !t.isRead).length})
            </button>
            <button 
              className={`filter-btn ${filter === 'working' ? 'active' : ''}`}
              onClick={() => setFilter('working')}
            >
              Working ({tasks.filter(t => t.status === 'working').length})
            </button>
          </div>

          {/* Task List */}
          <div className="inbox-panel-content">
            {loading ? (
              <div className="inbox-loading">
                <div className="spinner"></div>
                <p>Loading tasks...</p>
              </div>
            ) : filteredTasks.length === 0 ? (
              <div className="inbox-empty">
                <div className="empty-icon">📭</div>
                <h3>No tasks found</h3>
                <p>You're all caught up!</p>
              </div>
            ) : (
              <div className="inbox-task-list">
                {filteredTasks.map(task => (
                  <InboxCard
                    key={task.id}
                    task={task}
                    onClick={() => handleTaskClick(task)}
                  />
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Task Detail Modal */}
      {selectedTask && (
        <TaskDetailModal
          task={selectedTask}
          onClose={handleCloseDetail}
          onRefresh={fetchInboxTasks}
        />
      )}
    </>
  );
};

export default InboxPanel;
