// src/components/outbox/OutboxTaskCard.jsx
import React, { useState } from 'react';
import PropTypes from 'prop-types';
import axios from 'axios';
import './OutboxTaskCard.css';

const OutboxTaskCard = ({ 
  task, 
  isExpanded, 
  onClick, 
  formatDate, 
  formatTime, 
  getStatusClass 
}) => {
  const [showJourneyModal, setShowJourneyModal] = useState(false);
  const [journey, setJourney] = useState([]);
  const [loadingJourney, setLoadingJourney] = useState(false);

  const {
    id,
    projectName,
    taskName,
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

  // Fetch journey when Track button is clicked
  const handleTrackClick = async (e) => {
    e.stopPropagation(); // Prevent card expansion
    setShowJourneyModal(true);
    setLoadingJourney(true);

    try {
      const response = await axios.get(`http://localhost:8000/api/tasks/${id}/journey`, {
        withCredentials: true
      });
      
      if (response.data.success) {
        setJourney(response.data.journey);
      }
    } catch (error) {
      console.error('Error fetching journey:', error);
      alert('Failed to load journey');
    } finally {
      setLoadingJourney(false);
    }
  };

  const closeModal = (e) => {
    e.stopPropagation();
    setShowJourneyModal(false);
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
              {taskName}
              {isResult && <span className="result-badge">📊 Result</span>}
            </h3>
            <p className="outbox-project-name">📁 {projectName}</p>
          </div>
          <div className="status-and-track">
            <span className={`outbox-status-pill ${getStatusClass(status)}`}>
              {status?.replace('_', ' ')}
            </span>
            {/* Track Button */}
            <button 
              className="track-button"
              onClick={handleTrackClick}
              title="View Journey"
            >
              🛤️ Track
            </button>
          </div>
        </div>

        {/* Workflow Stage Badge */}
        {workflowStage && (
          <div className="workflow-stage-badge">
            <span className={`stage-indicator stage-${workflowStage}`}>
              {getStageIcon(workflowStage)} {workflowStage?.replace('_', ' ')}
            </span>
            {journeyCount > 0 && (
              <span className="journey-count-badge">
                {journeyCount} {journeyCount === 1 ? 'entry' : 'entries'}
              </span>
            )}
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
              <h4>📋 Task Details</h4>
              <p>{taskDetails || 'No details provided'}</p>
            </div>

            {/* Attachments */}
            {attachments && attachments.length > 0 && (
              <div className="extra-col">
                <h4>📎 Attachments ({attachments.length})</h4>
                <ul className="attachment-list">
                  {attachments.map((att, idx) => (
                    <li key={idx}>
                      <a href={att.url || '#'} target="_blank" rel="noopener noreferrer">
                        {att.originalName || att.filename || `Attachment ${idx + 1}`}
                      </a>
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
                      <a href={link} target="_blank" rel="noopener noreferrer">
                        {link.length > 40 ? link.substring(0, 40) + '...' : link}
                      </a>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Journey Modal */}
      {showJourneyModal && (
        <div className="journey-modal-overlay" onClick={closeModal}>
          <div className="journey-modal" onClick={(e) => e.stopPropagation()}>
            <div className="journey-modal-header">
              <h2>🛤️ Task Journey</h2>
              <button className="close-modal" onClick={closeModal}>✕</button>
            </div>
            
            <div className="journey-modal-info">
              <div className="journey-info-item">
                <span className="journey-info-label">Task:</span>
                <span className="journey-info-value">{taskName}</span>
              </div>
              <div className="journey-info-item">
                <span className="journey-info-label">Project:</span>
                <span className="journey-info-value">{projectName}</span>
              </div>
              <div className="journey-info-item">
                <span className="journey-info-label">Current Status:</span>
                <span className={`journey-status ${getStatusClass(status)}`}>
                  {status?.replace('_', ' ')}
                </span>
              </div>
            </div>

            <div className="journey-modal-body">
              {loadingJourney ? (
                <div className="journey-loading">
                  <div className="spinner"></div>
                  <p>Loading journey...</p>
                </div>
              ) : journey.length > 0 ? (
                <div className="journey-timeline">
                  {journey.map((entry, index) => (
                    <div key={entry.id} className="journey-entry">
                      <div className="journey-entry-icon">
                        {getActionIcon(entry.action)}
                      </div>
                      <div className="journey-entry-content">
                        <div className="journey-entry-header">
                          <span className="journey-action">{entry.action}</span>
                          <span className="journey-time">
                            {formatDate(entry.timestamp)} at {formatTime(entry.timestamp)}
                          </span>
                        </div>
                        <div className="journey-entry-details">
                          <div className="journey-detail-row">
                            <span className="journey-detail-icon">👤</span>
                            <span><strong>{entry.userName}</strong></span>
                            {entry.userPosition && (
                              <span className="user-position">({entry.userPosition})</span>
                            )}
                          </div>
                          {entry.userDepartment && (
                            <div className="journey-detail-row">
                              <span className="journey-detail-icon">🏢</span>
                              <span>{entry.userDepartment}</span>
                            </div>
                          )}
                          {(entry.fromDepartment || entry.toDepartment) && (
                            <div className="journey-detail-row">
                              <span className="journey-detail-icon">📍</span>
                              <span>
                                {entry.fromDepartment && `${entry.fromDepartment} → `}
                                {entry.toDepartment}
                              </span>
                            </div>
                          )}
                          {entry.statusBefore && (
                            <div className="journey-detail-row">
                              <span className="journey-detail-icon">📊</span>
                              <span>
                                Status: <span className="status-change">
                                  {entry.statusBefore} → {entry.statusAfter}
                                </span>
                              </span>
                            </div>
                          )}
                          {entry.comments && (
                            <div className="journey-comment">
                              <span className="journey-detail-icon">💬</span>
                              <span>{entry.comments}</span>
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="no-journey">
                  <p>No journey entries yet</p>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
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

const getActionIcon = (action) => {
  const icons = {
    'created': '✨',
    'sent': '📤',
    'received': '✅',
    'started': '🚀',
    'paused': '⏸️',
    'completed': '🎉',
    'forwarded': '➡️',
    'rejected': '❌',
    'under_review': '👁️'
  };
  return icons[action] || '📌';
};

// PropTypes
OutboxTaskCard.propTypes = {
  task: PropTypes.shape({
    id: PropTypes.number.isRequired,
    projectName: PropTypes.string.isRequired,
    taskName: PropTypes.string.isRequired,
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
  formatDate: PropTypes.func.isRequired,
  formatTime: PropTypes.func.isRequired,
  getStatusClass: PropTypes.func.isRequired,
};

export default OutboxTaskCard;
