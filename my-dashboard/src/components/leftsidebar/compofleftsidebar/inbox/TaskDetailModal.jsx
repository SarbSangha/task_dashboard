import React, { useState } from 'react';
import SubmitSection from './SubmitSection';
import './TaskDetailModal.css';
import { formatDateIndia, formatDateTimeIndia } from '../../../../utils/dateTime';
import { buildFileOpenUrl } from '../../../../utils/fileLinks';
import { useCustomDialogs } from '../../../common/CustomDialogs';
import { taskAPI } from '../../../../services/api';
import FilePreviewModal from '../../../common/FilePreviewModal';

const isWorkflowTask = (task) => Boolean(task?.workflowEnabled);
const getActiveStageLabel = (task) => {
  if (!isWorkflowTask(task)) return '';
  const order = Number(task?.currentStageOrder || 0);
  const title = `${task?.currentStageTitle || ''}`.trim();
  if (order && title) return `Stage ${order}: ${title}`;
  if (order) return `Stage ${order}`;
  return title;
};

const TaskDetailModal = ({ task, onClose, onRefresh }) => {
  const { showAlert, showConfirm, showPrompt } = useCustomDialogs();
  const [showSubmitSection, setShowSubmitSection] = useState(false);
  const [actionLoading, setActionLoading] = useState(false);
  const [previewFile, setPreviewFile] = useState(null);

  const taskDetails = task || null;

  const handleStartWork = async () => {
    const confirmed = await showConfirm('Start working on this task?', { title: 'Start Work' });
    if (!confirmed) return;

    setActionLoading(true);
    try {
      await taskAPI.startTask(task.id);
      await showAlert('Work started! You can now access the workspace tools.', { title: 'Success' });
      onRefresh?.();
      onClose?.();
    } catch (error) {
      console.error('Error starting work:', error);
      await showAlert(error?.response?.data?.detail || 'Failed to start work.', { title: 'Start Work Failed' });
    } finally {
      setActionLoading(false);
    }
  };

  const handleApprove = async () => {
    const stageLabel = getActiveStageLabel(task);
    const comments = await showPrompt('Add approval comments (optional):', {
      title: stageLabel ? `Approve ${stageLabel}` : 'Approve Task',
      defaultValue: '',
    });
    if (comments === null) return;

    setActionLoading(true);
    try {
      if (isWorkflowTask(task) && task.currentStageId) {
        await taskAPI.approveStage(task.id, task.currentStageId, comments);
      } else {
        await taskAPI.approveTask(task.id, comments);
      }
      await showAlert('Task approved successfully.', { title: 'Approved' });
      onRefresh?.();
      onClose?.();
    } catch (error) {
      console.error('Error approving task:', error);
      await showAlert(error?.response?.data?.detail || 'Failed to approve task.', { title: 'Approval Failed' });
    } finally {
      setActionLoading(false);
    }
  };

  const handleReject = async () => {
    const stageLabel = getActiveStageLabel(task);
    const reason = await showPrompt('Enter revision reason:', {
      title: stageLabel ? `Request Revision For ${stageLabel}` : 'Reject Task',
      defaultValue: '',
      multiline: true,
      rows: 5,
      placeholder: 'Describe what needs to be improved...',
    });
    if (!reason) {
      await showAlert('A revision reason is required.', { title: 'Reason Required' });
      return;
    }

    setActionLoading(true);
    try {
      if (isWorkflowTask(task) && task.currentStageId) {
        await taskAPI.requestStageImprovement(task.id, task.currentStageId, reason);
      } else {
        await taskAPI.needImprovement(task.id, reason);
      }
      await showAlert('Task sent back for revision.', { title: 'Revision Requested' });
      onRefresh?.();
      onClose?.();
    } catch (error) {
      console.error('Error requesting revision:', error);
      await showAlert(error?.response?.data?.detail || 'Failed to request revision.', { title: 'Request Failed' });
    } finally {
      setActionLoading(false);
    }
  };

  const handleSubmitComplete = () => {
    setShowSubmitSection(false);
    onRefresh?.();
    onClose?.();
  };

  if (!taskDetails) {
    return (
      <div className="modal-overlay">
        <div className="modal-content loading">Loading task details...</div>
      </div>
    );
  }

  const availableActions = taskDetails.availableActions || [];
  const activeStageLabel = getActiveStageLabel(taskDetails);
  const normalizedStatus = `${taskDetails.status || ''}`.replace(/_/g, ' ');
  const attachments = Array.isArray(taskDetails.attachments) ? taskDetails.attachments : [];
  const links = Array.isArray(taskDetails.links) ? taskDetails.links : [];

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content task-detail-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <div>
            <h2>{taskDetails.title || taskDetails.taskName}</h2>
            <p className="project-name">Project: {taskDetails.projectName || '-'}</p>
          </div>
          <button className="close-modal-btn" onClick={onClose}>✕</button>
        </div>

        <div className="modal-body">
          <div className="info-grid">
            <div className="info-item">
              <label>Status:</label>
              <span className={`status-chip ${taskDetails.status}`}>
                {normalizedStatus || '-'}
              </span>
            </div>

            <div className="info-item">
              <label>Priority:</label>
              <span className={`priority-chip ${`${taskDetails.priority || 'medium'}`.toLowerCase()}`}>
                {taskDetails.priority || 'Medium'}
              </span>
            </div>

            <div className="info-item">
              <label>From:</label>
              <span>{taskDetails.creator?.name || 'Unknown'} ({taskDetails.fromDepartment || taskDetails.creator?.department || 'N/A'})</span>
            </div>

            <div className="info-item">
              <label>Deadline:</label>
              <span>{taskDetails.deadline ? formatDateIndia(taskDetails.deadline) : 'No deadline'}</span>
            </div>

            <div className="info-item">
              <label>Department:</label>
              <span>{taskDetails.toDepartment || '-'}</span>
            </div>

            <div className="info-item">
              <label>Tag:</label>
              <span>{taskDetails.taskTag || '-'}</span>
            </div>

            {isWorkflowTask(taskDetails) && (
              <div className="info-item">
                <label>Active Stage:</label>
                <span>{activeStageLabel || 'Workflow task'}</span>
              </div>
            )}
          </div>

          {taskDetails.description && (
            <div className="detail-section">
              <h3>Task Description</h3>
              <p className="task-details-text">{taskDetails.description}</p>
            </div>
          )}

          {links.length > 0 && (
            <div className="detail-section">
              <h3>Task Links ({links.length})</h3>
              <div className="attachments-list">
                {links.map((link, index) => (
                  <a key={`${link}-${index}`} href={link} target="_blank" rel="noopener noreferrer" className="attachment-item">
                    {link}
                  </a>
                ))}
              </div>
            </div>
          )}

          {attachments.length > 0 && (
            <div className="detail-section">
              <h3>Attachments ({attachments.length})</h3>
              <div className="attachments-list">
                {attachments.map((file, index) => (
                  <button
                    key={`${file?.url || file?.filename || index}-${index}`}
                    type="button"
                    className="attachment-item"
                    onClick={() => {
                      if (buildFileOpenUrl(file)) setPreviewFile(file);
                    }}
                  >
                    📎 {file?.originalName || file?.filename || `Attachment ${index + 1}`}
                  </button>
                ))}
              </div>
            </div>
          )}

          {taskDetails.resultText && (
            <div className="detail-section">
              <h3>{isWorkflowTask(taskDetails) ? 'Latest Stage Output' : 'Submitted Result'}</h3>
              <p className="task-details-text">{taskDetails.resultText}</p>
              {taskDetails.updatedAt && (
                <small className="journey-time">Updated {formatDateTimeIndia(taskDetails.updatedAt)}</small>
              )}
            </div>
          )}
        </div>

        <div className="modal-footer">
          {(availableActions.includes('start') || availableActions.includes('start_work')) && (
            <button
              className="action-btn primary"
              onClick={handleStartWork}
              disabled={actionLoading}
            >
              {isWorkflowTask(taskDetails) ? '🚀 Start Stage' : '🚀 Start Work'}
            </button>
          )}

          {availableActions.includes('submit') && (
            <button
              className="action-btn success"
              onClick={() => setShowSubmitSection(true)}
              disabled={actionLoading}
            >
              {isWorkflowTask(taskDetails) ? '📤 Submit Stage' : '📤 Submit Result'}
            </button>
          )}

          {availableActions.includes('approve') && (
            <button
              className="action-btn success"
              onClick={handleApprove}
              disabled={actionLoading}
            >
              {isWorkflowTask(taskDetails) ? '✓ Approve Stage' : '✓ Approve'}
            </button>
          )}

          {(availableActions.includes('need_improvement') || availableActions.includes('reject')) && (
            <button
              className="action-btn danger"
              onClick={handleReject}
              disabled={actionLoading}
            >
              {isWorkflowTask(taskDetails) ? '↺ Request Revision' : '✕ Reject'}
            </button>
          )}

          <button className="action-btn secondary" onClick={onClose}>
            Close
          </button>
        </div>

        {showSubmitSection && (
          <SubmitSection
            taskId={task.id}
            task={taskDetails}
            onClose={() => setShowSubmitSection(false)}
            onSubmitComplete={handleSubmitComplete}
          />
        )}
        {previewFile ? (
          <FilePreviewModal
            file={previewFile}
            title={previewFile?.originalName || previewFile?.filename || 'Attachment'}
            subtitle={`${taskDetails?.title || task?.title || 'Task'}${taskDetails?.taskNumber || task?.taskNumber ? ` • ${taskDetails?.taskNumber || task?.taskNumber}` : ''}`}
            onClose={() => setPreviewFile(null)}
          />
        ) : null}
      </div>
    </div>
  );
};

export default TaskDetailModal;
