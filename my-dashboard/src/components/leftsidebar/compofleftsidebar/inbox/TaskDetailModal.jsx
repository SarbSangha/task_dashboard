// components/Inbox/TaskDetailModal.jsx
import React, { useState, useEffect } from 'react';
import SubmitSection from './SubmitSection';
import './TaskDetailModal.css';

const TaskDetailModal = ({ task, onClose, onRefresh }) => {
  const [taskDetails, setTaskDetails] = useState(null);
  const [loading, setLoading] = useState(false);
  const [showSubmitSection, setShowSubmitSection] = useState(false);
  const [actionLoading, setActionLoading] = useState(false);

  useEffect(() => {
    fetchTaskDetails();
  }, [task.id]);

  const fetchTaskDetails = async () => {
    setLoading(true);
    try {
      const response = await fetch(`http://localhost:8000/api/tasks/inbox/${task.id}`, {
        credentials: 'include'
      });
      const data = await response.json();
      if (data.success) {
        setTaskDetails(data.data);
      }
    } catch (error) {
      console.error('Error fetching task details:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleStartWork = async () => {
    if (!confirm('Start working on this task?')) return;
    
    setActionLoading(true);
    try {
      const response = await fetch(`http://localhost:8000/api/tasks/${task.id}/start-work`, {
        method: 'POST',
        credentials: 'include'
      });
      const data = await response.json();
      
      if (data.success) {
        alert('✅ Work started! You can now access the workspace tools.');
        fetchTaskDetails();
        onRefresh();
        // Optionally redirect to workspace
        // window.location.href = '/workspace';
      } else {
        alert('❌ ' + data.detail);
      }
    } catch (error) {
      console.error('Error starting work:', error);
      alert('❌ Failed to start work');
    } finally {
      setActionLoading(false);
    }
  };

  const handleApprove = async () => {
    const comments = prompt('Add approval comments (optional):');
    if (comments === null) return; // Cancelled
    
    setActionLoading(true);
    try {
      const response = await fetch(`http://localhost:8000/api/tasks/${task.id}/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ comments })
      });
      const data = await response.json();
      
      if (data.success) {
        alert('✅ Task approved and forwarded!');
        onClose();
        onRefresh();
      } else {
        alert('❌ ' + data.detail);
      }
    } catch (error) {
      console.error('Error approving task:', error);
      alert('❌ Failed to approve task');
    } finally {
      setActionLoading(false);
    }
  };

  const handleReject = async () => {
    const reason = prompt('Enter rejection reason:');
    if (!reason) {
      alert('Rejection reason is required');
      return;
    }
    
    setActionLoading(true);
    try {
      const response = await fetch(`http://localhost:8000/api/tasks/${task.id}/reject`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ reason, revisionRequired: true })
      });
      const data = await response.json();
      
      if (data.success) {
        alert('⚠️ Task rejected and sent back for revisions');
        onClose();
        onRefresh();
      } else {
        alert('❌ ' + data.detail);
      }
    } catch (error) {
      console.error('Error rejecting task:', error);
      alert('❌ Failed to reject task');
    } finally {
      setActionLoading(false);
    }
  };

  const handleSubmitComplete = () => {
    setShowSubmitSection(false);
    fetchTaskDetails();
    onRefresh();
  };

  if (loading || !taskDetails) {
    return (
      <div className="modal-overlay">
        <div className="modal-content loading">Loading task details...</div>
      </div>
    );
  }

  const availableActions = taskDetails.availableActions || [];

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content task-detail-modal" onClick={e => e.stopPropagation()}>
        {/* Modal Header */}
        <div className="modal-header">
          <div>
            <h2>{taskDetails.taskName}</h2>
            <p className="project-name">Project: {taskDetails.projectName}</p>
          </div>
          <button className="close-modal-btn" onClick={onClose}>✕</button>
        </div>

        {/* Task Information */}
        <div className="modal-body">
          <div className="info-grid">
            <div className="info-item">
              <label>Status:</label>
              <span className={`status-chip ${taskDetails.status}`}>
                {taskDetails.status}
              </span>
            </div>

            <div className="info-item">
              <label>Priority:</label>
              <span className={`priority-chip ${taskDetails.priority.toLowerCase()}`}>
                {taskDetails.priority}
              </span>
            </div>

            <div className="info-item">
              <label>From:</label>
              <span>{taskDetails.sender?.name} ({taskDetails.sender?.department})</span>
            </div>

            <div className="info-item">
              <label>Deadline:</label>
              <span>{taskDetails.deadline ? new Date(taskDetails.deadline).toLocaleDateString() : 'No deadline'}</span>
            </div>

            <div className="info-item">
              <label>Department:</label>
              <span>{taskDetails.toDepartment}</span>
            </div>

            <div className="info-item">
              <label>Tag:</label>
              <span>{taskDetails.taskTag}</span>
            </div>
          </div>

          {/* Task Details */}
          {taskDetails.taskDetails && (
            <div className="detail-section">
              <h3>Task Description</h3>
              <p className="task-details-text">{taskDetails.taskDetails}</p>
            </div>
          )}

          {/* Attachments */}
          {taskDetails.attachments && taskDetails.attachments.length > 0 && (
            <div className="detail-section">
              <h3>Attachments ({taskDetails.attachments.length})</h3>
              <div className="attachments-list">
                {taskDetails.attachments.map((file, index) => (
                  <a key={index} href={file} target="_blank" rel="noopener noreferrer" className="attachment-item">
                    📎 {file.split('/').pop()}
                  </a>
                ))}
              </div>
            </div>
          )}

          {/* Journey History */}
          {taskDetails.journey && taskDetails.journey.length > 0 && (
            <div className="detail-section">
              <h3>Task Journey ({taskDetails.journey.length} events)</h3>
              <div className="journey-timeline">
                {taskDetails.journey.map((entry, index) => (
                  <div key={entry.id} className="journey-entry">
                    <div className="journey-icon">{index + 1}</div>
                    <div className="journey-content">
                      <div className="journey-header">
                        <strong>{entry.action}</strong>
                        <span className="journey-time">
                          {new Date(entry.timestamp).toLocaleString()}
                        </span>
                      </div>
                      <p>{entry.comments}</p>
                      {entry.userName && (
                        <small>By: {entry.userName} ({entry.userPosition})</small>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Action Buttons */}
        <div className="modal-footer">
          {availableActions.includes('start_work') && (
            <button 
              className="action-btn primary" 
              onClick={handleStartWork}
              disabled={actionLoading}
            >
              🚀 Start Work
            </button>
          )}

          {availableActions.includes('submit') && (
            <button 
              className="action-btn success" 
              onClick={() => setShowSubmitSection(true)}
              disabled={actionLoading}
            >
              📤 Submit Result
            </button>
          )}

          {availableActions.includes('approve') && (
            <button 
              className="action-btn success" 
              onClick={handleApprove}
              disabled={actionLoading}
            >
              ✓ Approve
            </button>
          )}

          {availableActions.includes('reject') && (
            <button 
              className="action-btn danger" 
              onClick={handleReject}
              disabled={actionLoading}
            >
              ✕ Reject
            </button>
          )}

          <button className="action-btn secondary" onClick={onClose}>
            Close
          </button>
        </div>

        {/* Submit Section Modal */}
        {showSubmitSection && (
          <SubmitSection
            taskId={task.id}
            onClose={() => setShowSubmitSection(false)}
            onSubmitComplete={handleSubmitComplete}
          />
        )}
      </div>
    </div>
  );
};

export default TaskDetailModal;
