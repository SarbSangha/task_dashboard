// components/Inbox/InboxCard.jsx
import React from 'react';
import './InboxCard.css';

const InboxCard = ({ task, onClick, onRefresh }) => {
  const getStatusBadge = (status) => {
    const badges = {
      'pending': { color: '#fbbf24', icon: '⏳', text: 'Pending' },
      'working': { color: '#3b82f6', icon: '⚙️', text: 'Working' },
      'submitted': { color: '#8b5cf6', icon: '📤', text: 'Submitted' },
      'approved': { color: '#22c55e', icon: '✓', text: 'Approved' },
      'revision_required': { color: '#ef4444', icon: '↩️', text: 'Revision' },
      'completed': { color: '#10b981', icon: '✓✓', text: 'Completed' }
    };
    return badges[status] || badges['pending'];
  };

  const getPriorityColor = (priority) => {
    const colors = {
      'High': '#ef4444',
      'Medium': '#f59e0b',
      'Low': '#22c55e'
    };
    return colors[priority] || colors['Medium'];
  };

  const formatDate = (dateString) => {
    if (!dateString) return '';
    const date = new Date(dateString);
    const now = new Date();
    const diffMs = now - date;
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);

    if (diffMins < 1) return 'Just now';
    if (diffMins < 60) return `${diffMins}m ago`;
    if (diffHours < 24) return `${diffHours}h ago`;
    if (diffDays < 7) return `${diffDays}d ago`;
    return date.toLocaleDateString();
  };

  const statusBadge = getStatusBadge(task.status);

  return (
    <div 
      className={`inbox-card ${!task.isRead ? 'unread' : ''}`}
      onClick={onClick}
    >
      {/* Card Header */}
      <div className="card-header">
        <div className="card-title-row">
          <h3 className="card-title">{task.taskName}</h3>
          {!task.isRead && <span className="unread-dot"></span>}
        </div>
        <span 
          className="status-badge" 
          style={{ background: statusBadge.color }}
        >
          {statusBadge.icon} {statusBadge.text}
        </span>
      </div>

      {/* Card Content */}
      <div className="card-content">
        <div className="card-row">
          <span className="label">Project:</span>
          <span className="value">{task.projectName}</span>
        </div>
        
        <div className="card-row">
          <span className="label">From:</span>
          <span className="value">
            {task.senderName || 'Unknown'} 
            {task.senderDepartment && ` (${task.senderDepartment})`}
          </span>
        </div>

        <div className="card-row">
          <span className="label">Priority:</span>
          <span 
            className="priority-badge" 
            style={{ color: getPriorityColor(task.priority) }}
          >
            {task.priority}
          </span>
        </div>

        {task.deadline && (
          <div className="card-row">
            <span className="label">Deadline:</span>
            <span className="value deadline">
              {new Date(task.deadline).toLocaleDateString()}
            </span>
          </div>
        )}

        {task.taskDetails && (
          <p className="task-description">
            {task.taskDetails.substring(0, 100)}
            {task.taskDetails.length > 100 && '...'}
          </p>
        )}
      </div>

      {/* Card Footer */}
      <div className="card-footer">
        <span className="received-time">
          📅 {formatDate(task.receivedAt)}
        </span>
        <span className="view-details">View Details →</span>
      </div>
    </div>
  );
};

export default InboxCard;
