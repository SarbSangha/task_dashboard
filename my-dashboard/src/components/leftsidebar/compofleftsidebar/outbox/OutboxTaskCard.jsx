// src/components/outbox/OutboxTaskCard.jsx
import React, { useState } from 'react';
import PropTypes from 'prop-types';
import './OutboxTaskCard.css';

const OutboxTaskCard = ({ 
  task, 
  isExpanded, 
  onClick, 
  onTaskAction,
  onTrackClick,
  formatDate, 
  formatTime, 
  getStatusClass 
}) => {
  const apiBase = import.meta.env.VITE_API_URL || 'http://localhost:8000';
  const [menuOpen, setMenuOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [toastMessage, setToastMessage] = useState('');

  const {
    id,
    projectName,
    title,
    taskName,
    description,
    toDepartment,
    fromDepartment,
    status,
    priority,
    taskDetails,
    deadline,
    createdAt,
    attachments,
    links,
    taskTag,
    taskType,
    isResult,
    workflowStage,
    sentAt,
    receivedAt,
    startedAt,
    completedAt,
    createdBy,
    currentHolder,
    completedBy,
    trackingInfo,
    journeyCount
  } = task;
  const displayTaskName = taskName || title || 'Untitled Task';
  const displayTaskDetails = taskDetails || description || '';

  const menuActions = [
    'track',
    ...(task.availableActions || []).filter((action) => action === 'edit_task' || action === 'revoke_task')
  ];
  const requestTypeLabel = (() => {
    const type = (taskType || 'task').toLowerCase();
    if (type === 'task_approval') return 'Task Approval';
    if (type === 'submission_result') return 'Submission Result';
    return 'Task';
  })();
  const buildFileActionUrl = (file, action, fallbackName) => {
    const params = new URLSearchParams();
    if (file?.url) params.set('url', file.url);
    if (file?.path) params.set('path', file.path);
    if (action === 'download') {
      params.set('filename', fallbackName || file?.originalName || file?.filename || 'download');
    }
    return `${apiBase}/api/files/${action}?${params.toString()}`;
  };
  const forceDownload = (file, filename) => {
    const downloadUrl = buildFileActionUrl(file, 'download', filename);
    const link = document.createElement('a');
    link.href = downloadUrl;
    link.style.display = 'none';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };
  const copyToClipboard = async (text) => {
    const value = `${text || ''}`.trim();
    if (!value) return;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(value);
      } else {
        const temp = document.createElement('textarea');
        temp.value = value;
        document.body.appendChild(temp);
        temp.select();
        document.execCommand('copy');
        document.body.removeChild(temp);
      }
      setCopied(true);
      setToastMessage('Copied to clipboard');
      window.setTimeout(() => setCopied(false), 1200);
      window.setTimeout(() => setToastMessage(''), 1400);
    } catch (error) {
      console.warn('Copy failed:', error);
    }
  };
  const copyLink = async (link, e) => {
    if (e) e.stopPropagation();
    await copyToClipboard(link);
  };

  const handleTrackClick = (e) => {
    e.stopPropagation();
    onTrackClick?.(task);
  };

  return (
    <>
      <div
        className={`outbox-task-card ${isExpanded ? 'expanded' : ''}`}
        onClick={() => onClick(id)}
      >
        {/* Card Header */}
        <div className="outbox-task-header">
          <div className="outbox-avatar">
            <span>{toDepartment?.[0] || 'T'}</span>
          </div>
          <div className="outbox-header-text">
            <h3 className="outbox-task-title">
              {displayTaskName}
              {isResult && <span className="result-badge">📊 Result</span>}
            </h3>
            <p className="outbox-project-name">📁 {projectName}</p>
          </div>
          <div className="status-and-track">
            <span className={`outbox-status-pill ${getStatusClass(status)}`}>
              {status?.replace('_', ' ')}
            </span>
            <div className="outbox-card-menu-wrap" onClick={(e) => e.stopPropagation()}>
              <button className="outbox-card-menu-btn" onClick={() => setMenuOpen((prev) => !prev)}>⋮</button>
              {menuOpen && (
                <div className="outbox-card-menu">
                  {menuActions.map((action) => (
                    <button
                      key={action}
                      onClick={(e) => {
                        setMenuOpen(false);
                        if (action === 'track') {
                          handleTrackClick(e);
                          return;
                        }
                        onTaskAction?.(task, action);
                      }}
                    >
                      {action === 'track' ? 'Track' : action === 'edit_task' ? 'Edit Task' : 'Revoke Task'}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Workflow Stage Badge */}
        {workflowStage && (
          <div className="workflow-stage-badge">
            <span className={`stage-indicator stage-${workflowStage}`}>
              {getStageIcon(workflowStage)} {workflowStage?.replace('_', ' ')}
            </span>
          </div>
        )}

        {/* Card Meta - Enhanced */}
        <div className="outbox-task-meta">
          <div className="meta-item">
            <span className="meta-icon">📤</span>
            <div>
              <span className="outbox-label">From</span>
              <p className="outbox-value">{fromDepartment || 'Me'}</p>
            </div>
          </div>
          <div className="meta-item">
            <span className="meta-icon">📥</span>
            <div>
              <span className="outbox-label">To</span>
              <p className="outbox-value">{toDepartment}</p>
            </div>
          </div>
          <div className="meta-item">
            <span className="meta-icon">📅</span>
            <div>
              <span className="outbox-label">Sent</span>
              <p className="outbox-value">{formatDate(sentAt || createdAt)}</p>
            </div>
          </div>
          <div className="meta-item">
            <span className="meta-icon">⏰</span>
            <div>
              <span className="outbox-label">Time</span>
              <p className="outbox-value">{formatTime(sentAt || createdAt)}</p>
            </div>
          </div>
        </div>

        {/* Badges */}
        <div className="outbox-task-badges">
          <span className="type-badge request-type">📨 {requestTypeLabel}</span>
          <span className={`priority-badge priority-${priority?.toLowerCase()}`}>
            {getPriorityIcon(priority)} {priority}
          </span>
          <span className="tag-badge">🏷️ {taskTag}</span>
          {taskType === 'result' && (
            <span className="type-badge result-type">📊 Result</span>
          )}
          {deadline && (
            <span className="deadline-badge">
              ⏳ Deadline: {formatDate(deadline)},{formatTime(deadline)}
            </span>
          )}
        </div>

        {/* Timeline Progress */}
        {(sentAt || receivedAt || startedAt || completedAt) && (
          <div className="timeline-progress">
            <div className={`timeline-step ${sentAt ? 'completed' : ''}`}>
              <div className="timeline-dot"></div>
              <span className="timeline-label">Sent</span>
            </div>
            <div className="timeline-line"></div>
            <div className={`timeline-step ${receivedAt ? 'completed' : ''}`}>
              <div className="timeline-dot"></div>
              <span className="timeline-label">Received</span>
            </div>
            <div className="timeline-line"></div>
            <div className={`timeline-step ${startedAt ? 'completed' : ''}`}>
              <div className="timeline-dot"></div>
              <span className="timeline-label">Started</span>
            </div>
            <div className="timeline-line"></div>
            <div className={`timeline-step ${completedAt ? 'completed' : ''}`}>
              <div className="timeline-dot"></div>
              <span className="timeline-label">Completed</span>
            </div>
          </div>
        )}

        {/* Expanded Details */}
        {isExpanded && (
          <div className="outbox-task-extra">
            {/* Task Details */}
            <div className="extra-col">
              <div className="extra-head">
                <h4>📋 Task Details</h4>
                <button
                  type="button"
                  className="mini-action-btn"
                  onClick={(e) => {
                    e.stopPropagation();
                    copyToClipboard(displayTaskDetails);
                  }}
                  disabled={!displayTaskDetails}
                >
                  {copied ? 'Copied' : 'Copy'}
                </button>
              </div>
              <p>{displayTaskDetails || 'No details provided'}</p>
            </div>

            {/* Attachments */}
            {attachments && attachments.length > 0 && (
              <div className="extra-col">
                <h4>📎 Attachments ({attachments.length})</h4>
                <ul className="attachment-list">
                  {attachments.map((att, idx) => (
                    <li key={idx}>
                      <span>{att.originalName || att.filename || `Attachment ${idx + 1}`}</span>
                      <span className="attachment-actions">
                        <a href={buildFileActionUrl(att, 'open')} target="_blank" rel="noopener noreferrer">Open</a>
                        <button
                          type="button"
                          className="mini-action-btn"
                          onClick={(e) => {
                            e.stopPropagation();
                            forceDownload(att, att.originalName || att.filename || `attachment-${idx + 1}`);
                          }}
                        >
                          Download
                        </button>
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {/* Links */}
            {links && links.length > 0 && (
              <div className="extra-col">
                <h4>🔗 Links ({links.length})</h4>
                <ul className="link-list">
                  {links.map((link, idx) => (
                    <li key={idx}>
                      <span>{link.length > 40 ? link.substring(0, 40) + '...' : link}</span>
                      <span className="attachment-actions">
                        <a
                          href={link}
                          target="_blank"
                          rel="noopener noreferrer"
                          onClick={(e) => e.stopPropagation()}
                        >
                          Open
                        </a>
                        <button
                          type="button"
                          className="mini-action-btn"
                          onClick={(e) => copyLink(link, e)}
                        >
                          Copy Link
                        </button>
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
      </div>
      {toastMessage && <div className="copy-toast">{toastMessage}</div>}

    </>
  );
};

// Helper functions for icons
const getStageIcon = (stage) => {
  const icons = {
    'sent': '📤',
    'received': '✅',
    'in_progress': '🔄',
    'under_review': '👁️',
    'completed': '🎉'
  };
  return icons[stage] || '📌';
};

const getPriorityIcon = (priority) => {
  const icons = {
    'High': '🔴',
    'Medium': '🟡',
    'Low': '🟢'
  };
  return icons[priority] || '⚪';
};

// PropTypes
OutboxTaskCard.propTypes = {
  task: PropTypes.shape({
    id: PropTypes.number.isRequired,
    projectName: PropTypes.string.isRequired,
    title: PropTypes.string,
    taskName: PropTypes.string,
    description: PropTypes.string,
    toDepartment: PropTypes.string,
    fromDepartment: PropTypes.string,
    status: PropTypes.string,
    priority: PropTypes.string,
    taskDetails: PropTypes.string,
    deadline: PropTypes.string,
    createdAt: PropTypes.string,
    attachments: PropTypes.array,
    links: PropTypes.array,
    taskTag: PropTypes.string,
    taskType: PropTypes.string,
    isResult: PropTypes.bool,
    workflowStage: PropTypes.string,
    sentAt: PropTypes.string,
    receivedAt: PropTypes.string,
    startedAt: PropTypes.string,
    completedAt: PropTypes.string,
    createdBy: PropTypes.number,
    currentHolder: PropTypes.number,
    completedBy: PropTypes.number,
    trackingInfo: PropTypes.object,
    journeyCount: PropTypes.number,
  }).isRequired,
  isExpanded: PropTypes.bool.isRequired,
  onClick: PropTypes.func.isRequired,
  onTaskAction: PropTypes.func,
  onTrackClick: PropTypes.func,
  formatDate: PropTypes.func.isRequired,
  formatTime: PropTypes.func.isRequired,
  getStatusClass: PropTypes.func.isRequired,
};

export default OutboxTaskCard;
