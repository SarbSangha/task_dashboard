// src/components/outbox/OutboxTaskCard.jsx
import React, { useState } from 'react';
import PropTypes from 'prop-types';
import './OutboxTaskCard.css';
import { buildFileDownloadUrl } from '../../../../utils/fileLinks';
import FilePreviewModal from '../../../common/FilePreviewModal';

const OutboxTaskCard = ({ 
  task, 
  isExpanded, 
  onClick, 
  onTaskAction,
  onTrackClick,
  currentUser,
  formatDate, 
  formatTime, 
  getStatusClass 
}) => {
  const [menuOpen, setMenuOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [toastMessage, setToastMessage] = useState('');
  const [previewFile, setPreviewFile] = useState(null);
  const normalizedStatus = `${task?.status || ''}`.toLowerCase();

  const {
    id,
    projectName,
    projectId,
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
    updatedAt,
    attachments,
    links,
    taskTag,
    taskType,
    isResult,
    workflowStage,
    sentAt,
    receivedAt,
    startedAt,
    submittedAt,
    approvedAt,
    completedAt,
    creator,
    createdByName,
    createdByDepartment,
    createdBy,
    currentHolder,
    completedBy,
    assignedTo,
    forwardHistory,
    currentStageAssigneeNames,
    trackingInfo,
    journeyCount,
    isHeld,
    holdInfo
  } = task;
  const normalizedWorkflowStage = `${workflowStage || ''}`.toLowerCase();
  const isFinalApprovalPending =
    normalizedStatus === 'approved' && ['hod_approved', 'spoc_approved'].includes(normalizedWorkflowStage);
  const displayTaskName = taskName || title || 'Untitled Task';
  const displayTaskDetails = taskDetails || description || '';
  const summaryText = displayTaskDetails.length > 160
    ? `${displayTaskDetails.slice(0, 160)}...`
    : displayTaskDetails;
  const isDraft = normalizedStatus === 'draft';
  const statusLabel = `${status || 'pending'}`
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (char) => char.toUpperCase());
  const displayStatusLabel = isFinalApprovalPending ? 'Submitted' : statusLabel;
  const displayStatusForClass = isFinalApprovalPending ? 'submitted' : status;
  const statusFallsThroughReceived = [
    'assigned',
    'forwarded',
    'in_progress',
    'submitted',
    'approved',
    'completed',
    'need_improvement',
    'cancelled',
    'rejected',
  ].includes(normalizedStatus);
  const statusFallsThroughStarted = [
    'in_progress',
    'submitted',
    'approved',
    'completed',
    'need_improvement',
    'cancelled',
    'rejected',
  ].includes(normalizedStatus);
  const statusFallsThroughSubmitted = [
    'submitted',
    'approved',
    'completed',
    'need_improvement',
    'cancelled',
    'rejected',
  ].includes(normalizedStatus);
  const statusFallsThroughCompleted = normalizedStatus === 'completed' || (normalizedStatus === 'approved' && !isFinalApprovalPending);
  const submittedDisplayAt = submittedAt || (statusFallsThroughSubmitted ? (completedAt || approvedAt || updatedAt) : null);
  const approvalDisplayAt = completedAt || approvedAt || (statusFallsThroughCompleted ? updatedAt : null);
  const timelineSteps = [
    {
      key: 'sent',
      label: 'Sent',
      reached: Boolean(sentAt || createdAt || normalizedStatus),
    },
    {
      key: 'received',
      label: 'Receive',
      reached: Boolean(receivedAt || statusFallsThroughReceived),
    },
    {
      key: 'started',
      label: 'Start',
      reached: Boolean(startedAt || completedAt || statusFallsThroughStarted),
    },
    {
      key: 'submitted',
      label: 'Submit',
      reached: Boolean(task.submittedAt || completedAt || statusFallsThroughSubmitted),
    },
    {
      key: 'completed',
      label: 'Done',
      reached: Boolean(completedAt || statusFallsThroughCompleted),
    },
  ];
  const currentTimelineKey = (() => {
    const latestReachedStep = [...timelineSteps].reverse().find((step) => step.reached);
    return latestReachedStep?.key || '';
  })();
  const currentUserId = Number(currentUser?.id || currentUser?.userId || 0);
  const taskCreatorId = Number(task?.creatorId || creator?.id || createdBy || 0);
  const isCurrentUserCreator = Boolean(currentUserId && taskCreatorId && currentUserId === taskCreatorId);
  const isTerminalTask = ['completed', 'cancelled', 'rejected'].includes(normalizedStatus);
  const canEditTask = task?.canEditTask === true && isCurrentUserCreator;
  const canRevokeTask = task?.canRevokeTask === true && isCurrentUserCreator;
  const activeHoldInfo = isHeld || holdInfo?.active ? holdInfo : null;
  const canHoldTask = isCurrentUserCreator && !isTerminalTask && !activeHoldInfo;
  const canUnholdTask = isCurrentUserCreator && !isTerminalTask && Boolean(activeHoldInfo);
  const holdUntilLabel = activeHoldInfo?.until
    ? new Date(activeHoldInfo.until).toLocaleString('en-IN', {
        day: '2-digit',
        month: 'short',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      })
    : '';
  const menuActions = isDraft
    ? ['edit_draft', 'delete_draft']
    : Array.from(new Set([
        'track',
        'chat',
        ...(canUnholdTask ? ['unhold_task'] : []),
        ...(canHoldTask ? ['hold_task'] : []),
        ...(task.availableActions || []).filter((action) => {
          if (action === 'edit_task') return canEditTask;
          if (action === 'revoke_task') return canRevokeTask;
          if (action === 'hold_task') return canHoldTask;
          if (action === 'unhold_task') return canUnholdTask;
          return false;
        })
      ]));
  const requestTypeLabel = (() => {
    const type = (taskType || 'task').toLowerCase();
    if (type === 'task_approval') return 'Task Approval';
    if (type === 'submission_result') return 'Submission Result';
    return 'Task';
  })();

  const formatPeoplePreview = (items = []) => {
    const cleaned = items
      .map((value) => `${value || ''}`.trim())
      .filter(Boolean);

    if (!cleaned.length) return '';
    if (cleaned.length <= 2) return cleaned.join(', ');
    return `${cleaned.slice(0, 2).join(', ')} +${cleaned.length - 2}`;
  };

  const formatDepartmentPreview = (items = []) => {
    const unique = Array.from(
      new Set(
        items
          .map((value) => `${value || ''}`.trim())
          .filter(Boolean)
      )
    );

    if (!unique.length) return '';
    return unique.join(', ');
  };

  const latestForward = Array.isArray(forwardHistory)
    ? [...forwardHistory].reverse().find((entry) => entry?.toUser || entry?.toDepartment) || null
    : null;
  const assignedPeople = Array.isArray(assignedTo) ? assignedTo : [];
  const stagedPeople = Array.isArray(currentStageAssigneeNames) ? currentStageAssigneeNames : [];
  const workerSubmissionSummary = task.workerSubmissions || {};
  const workerSubmissionRows = Array.isArray(workerSubmissionSummary.workers) ? workerSubmissionSummary.workers : [];
  const hasWorkerSubmissionSummary = !task.workflowEnabled && workerSubmissionRows.length > 1;
  const normalizedSubmissionMode = workerSubmissionSummary.mode === 'all' || task.submissionMode === 'all'
    ? 'all'
    : 'any';
  const submissionModeLabel = normalizedSubmissionMode === 'all'
    ? 'Every employee must submit'
    : 'Any one employee can submit';

  const senderPrimary = `${createdByName || creator?.name || fromDepartment || 'Unknown sender'}`.trim();
  const senderSecondary = `${fromDepartment || createdByDepartment || creator?.department || ''}`.trim();

  const receiverPrimary = (
    formatPeoplePreview(assignedPeople.map((person) => person?.name)) ||
    `${latestForward?.toUser || ''}`.trim() ||
    formatPeoplePreview(stagedPeople) ||
    `${toDepartment || 'Pending receiver'}`
  ).trim();
  const receiverSecondary = (
    formatDepartmentPreview(assignedPeople.map((person) => person?.department)) ||
    `${latestForward?.toDepartment || ''}`.trim() ||
    `${toDepartment || ''}`.trim()
  ).trim();

  const senderSecondaryText = senderSecondary && senderSecondary.toLowerCase() !== senderPrimary.toLowerCase()
    ? senderSecondary
    : '';
  const receiverSecondaryText = receiverSecondary && receiverSecondary.toLowerCase() !== receiverPrimary.toLowerCase()
    ? receiverSecondary
    : '';
  const forceDownload = (file, filename) => {
    const downloadUrl = buildFileDownloadUrl(file, filename);
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

  const renderSubmissionLinks = (linksToRender = []) => {
    if (!Array.isArray(linksToRender) || linksToRender.length === 0) {
      return <div className="worker-submission-empty">No links shared.</div>;
    }
    return (
      <ul className="link-list">
        {linksToRender.map((link, idx) => (
          <li key={`${link}-${idx}`}>
            <span>{link.length > 48 ? `${link.substring(0, 48)}...` : link}</span>
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
    );
  };

  const renderSubmissionFiles = (filesToRender = []) => {
    if (!Array.isArray(filesToRender) || filesToRender.length === 0) {
      return <div className="worker-submission-empty">No files shared.</div>;
    }
    return (
      <ul className="attachment-list">
        {filesToRender.map((file, idx) => {
          const label = file?.originalName || file?.filename || `Attachment ${idx + 1}`;
          return (
            <li key={`${file?.url || file?.filename || idx}-${idx}`}>
              <span>{label}</span>
              <span className="attachment-actions">
                <button
                  type="button"
                  className="mini-action-btn"
                  onClick={(e) => {
                    e.stopPropagation();
                    setPreviewFile(file);
                  }}
                >
                  Open
                </button>
                <button
                  type="button"
                  className="mini-action-btn"
                  onClick={(e) => {
                    e.stopPropagation();
                    forceDownload(file, label);
                  }}
                >
                  Download
                </button>
              </span>
            </li>
          );
        })}
      </ul>
    );
  };

  const renderWorkerSubmissions = () => {
    if (!hasWorkerSubmissionSummary) return null;
    return (
      <div className="extra-col worker-submission-block">
        <div className="worker-submission-head">
          <h4>Employee Status</h4>
          <span>
            {submissionModeLabel} · {workerSubmissionSummary.submitted || 0}/{workerSubmissionSummary.total || workerSubmissionRows.length} submitted
          </span>
        </div>
        <div className="worker-submission-list">
          {workerSubmissionRows.map((worker) => {
            const submission = worker.submission || {};
            const submitted = Boolean(worker.submitted);
            return (
              <article
                key={worker.id || worker.name}
                className={`worker-submission-card ${submitted ? 'submitted' : 'pending'}`}
              >
                <div className="worker-submission-card-head">
                  <div>
                    <h5>{worker.name || 'Unknown employee'}</h5>
                    <p>{worker.department || 'No department'}</p>
                  </div>
                  <span className="worker-submission-status">
                    {submitted ? 'Submitted' : worker.started ? 'In Progress' : 'Not Started'}
                  </span>
                </div>
                {submitted ? (
                  <div className="worker-submission-body">
                    <div>
                      <label>Submitted at</label>
                      <p>{formatDate(submission.submittedAt) || 'N/A'} {formatTime(submission.submittedAt) || ''}</p>
                    </div>
                    <div>
                      <label>Output text</label>
                      <p>{submission.outputText || 'No text submitted.'}</p>
                    </div>
                    <div>
                      <label>Links</label>
                      {renderSubmissionLinks(submission.links || [])}
                    </div>
                    <div>
                      <label>Files</label>
                      {renderSubmissionFiles(submission.attachments || [])}
                    </div>
                  </div>
                ) : (
                  <div className="worker-submission-empty">
                    {worker.started
                      ? `Started${worker.startedAt ? ` at ${formatDate(worker.startedAt)} ${formatTime(worker.startedAt)}` : ''}. No result submitted yet.`
                      : 'This employee has not started yet.'}
                  </div>
                )}
              </article>
            );
          })}
        </div>
      </div>
    );
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
            <div className="outbox-title-row">
              <h3 className="outbox-task-title">
                {displayTaskName}
                {isResult && <span className="result-badge">Result</span>}
                {activeHoldInfo && <span className="hold-badge">Held</span>}
              </h3>
            </div>
            <div className="outbox-subtitle-row">
              <p className="outbox-project-name">📁 {projectName || 'No project'}</p>
              {(projectId || id) && (
                <span className="outbox-reference-pill">
                  {projectId || `Task #${id}`}
                </span>
              )}
            </div>
          </div>
          <div className="status-and-track">
            <span className={`outbox-status-pill ${getStatusClass(displayStatusForClass)}`}>
              {displayStatusLabel}
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
                      {action === 'track'
                        ? 'Track'
                        : action === 'chat'
                          ? 'Chat'
                          : action === 'edit_draft'
                            ? 'Edit Draft'
                            : action === 'delete_draft'
                              ? 'Delete Draft'
                          : action === 'edit_task'
                            ? 'Edit Task'
                            : action === 'hold_task'
                              ? 'Hold Task'
                              : action === 'unhold_task'
                                ? 'Unhold Task'
                                : 'Revoke Task'}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>

        {activeHoldInfo && (
          <div className="task-hold-banner">
            <strong>Task on hold</strong>
            <span>
              {holdUntilLabel
                ? `Auto-unholds on ${holdUntilLabel}`
                : 'Manual unhold required'}
              {activeHoldInfo.reason ? ` • ${activeHoldInfo.reason}` : ''}
            </span>
          </div>
        )}

        {/* Card Meta - Enhanced */}
        <div className="outbox-task-meta">
          <div className="meta-item">
            <span className="meta-icon">📤</span>
            <div className="outbox-meta-copy">
              <span className="outbox-label">From</span>
              <p className="outbox-value" title={senderPrimary}>{senderPrimary}</p>
              {senderSecondaryText ? (
                <p className="outbox-subvalue" title={senderSecondaryText}>{senderSecondaryText}</p>
              ) : null}
            </div>
          </div>
          <div className="meta-item">
            <span className="meta-icon">📥</span>
            <div className="outbox-meta-copy">
              <span className="outbox-label">To</span>
              <p className="outbox-value" title={receiverPrimary}>{receiverPrimary}</p>
              {receiverSecondaryText ? (
                <p className="outbox-subvalue" title={receiverSecondaryText}>{receiverSecondaryText}</p>
              ) : null}
            </div>
          </div>
          <div className="meta-item">
            <span className="meta-icon">📅</span>
            <div className="outbox-meta-copy">
              <span className="outbox-label">Sent</span>
              <p className="outbox-value">{formatDate(sentAt || createdAt)}</p>
            </div>
          </div>
          <div className="meta-item">
            <span className="meta-icon">⏰</span>
            <div className="outbox-meta-copy">
              <span className="outbox-label">Time</span>
              <p className="outbox-value">{formatTime(sentAt || createdAt)}</p>
            </div>
          </div>
          <div className="meta-item">
            <span className="meta-icon">✅</span>
            <div className="outbox-meta-copy">
              <span className="outbox-label">Submitted</span>
              <p className="outbox-value">{submittedDisplayAt ? formatDate(submittedDisplayAt) : 'Not reached'}</p>
              {submittedDisplayAt ? <p className="outbox-subvalue">{formatTime(submittedDisplayAt)}</p> : null}
            </div>
          </div>
          <div className="meta-item">
            <span className="meta-icon">🏁</span>
            <div className="outbox-meta-copy">
              <span className="outbox-label">Approval</span>
              <p className="outbox-value">{approvalDisplayAt ? formatDate(approvalDisplayAt) : 'Not reached'}</p>
              {approvalDisplayAt ? <p className="outbox-subvalue">{formatTime(approvalDisplayAt)}</p> : null}
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
          {hasWorkerSubmissionSummary && (
            <span className="type-badge worker-submission-badge">
              {workerSubmissionSummary.submitted || 0}/{workerSubmissionSummary.total || workerSubmissionRows.length} submitted · {submissionModeLabel}
            </span>
          )}
        </div>

        {summaryText && (
          <div className="outbox-summary-panel">
            <span className="outbox-summary-label">Summary</span>
            <p className="outbox-summary-text">{summaryText}</p>
          </div>
        )}

        {/* Timeline Progress */}
        {timelineSteps.some((step) => step.reached) && (
          <div className="timeline-progress">
            {timelineSteps.map((step, index) => (
              <React.Fragment key={step.key}>
                <div
                  className={`timeline-step ${step.reached ? 'completed' : ''} ${currentTimelineKey === step.key ? 'current' : ''}`}
                >
                  <div className="timeline-dot"></div>
                  <span className="timeline-label">{step.label}</span>
                </div>
                {index < timelineSteps.length - 1 ? (
                  <div className={`timeline-line ${timelineSteps[index].reached && timelineSteps[index + 1].reached ? 'reached' : ''}`}></div>
                ) : null}
              </React.Fragment>
            ))}
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
                        <button
                          type="button"
                          className="mini-action-btn"
                          onClick={(e) => {
                            e.stopPropagation();
                            setPreviewFile(att);
                          }}
                        >
                          Open
                        </button>
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
            {renderWorkerSubmissions()}
          </div>
        )}
      </div>
      {toastMessage && <div className="copy-toast">{toastMessage}</div>}
      {previewFile ? (
        <FilePreviewModal
          file={previewFile}
          title={previewFile?.originalName || previewFile?.filename || 'Attachment'}
          subtitle={`${displayTaskName}${id ? ` • ${id}` : ''}`}
          onClose={() => setPreviewFile(null)}
        />
      ) : null}

    </>
  );
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
    projectId: PropTypes.string,
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
    updatedAt: PropTypes.string,
    attachments: PropTypes.array,
    links: PropTypes.array,
    taskTag: PropTypes.string,
    taskType: PropTypes.string,
    isResult: PropTypes.bool,
    workflowStage: PropTypes.string,
    sentAt: PropTypes.string,
    receivedAt: PropTypes.string,
    startedAt: PropTypes.string,
    submittedAt: PropTypes.string,
    approvedAt: PropTypes.string,
    completedAt: PropTypes.string,
    creator: PropTypes.shape({
      id: PropTypes.number,
      name: PropTypes.string,
      department: PropTypes.string,
    }),
    createdByName: PropTypes.string,
    createdByDepartment: PropTypes.string,
    createdBy: PropTypes.number,
    currentHolder: PropTypes.number,
    completedBy: PropTypes.number,
    assignedTo: PropTypes.arrayOf(PropTypes.shape({
      id: PropTypes.number,
      name: PropTypes.string,
      department: PropTypes.string,
      role: PropTypes.string,
    })),
    forwardHistory: PropTypes.arrayOf(PropTypes.shape({
      id: PropTypes.number,
      fromUser: PropTypes.string,
      toUser: PropTypes.string,
      fromDepartment: PropTypes.string,
      toDepartment: PropTypes.string,
      createdAt: PropTypes.string,
    })),
    currentStageAssigneeNames: PropTypes.arrayOf(PropTypes.string),
    trackingInfo: PropTypes.object,
    journeyCount: PropTypes.number,
    isHeld: PropTypes.bool,
    holdInfo: PropTypes.shape({
      active: PropTypes.bool,
      until: PropTypes.string,
      reason: PropTypes.string,
    }),
    canEditTask: PropTypes.bool,
    canRevokeTask: PropTypes.bool,
    canHoldTask: PropTypes.bool,
    canUnholdTask: PropTypes.bool,
  }).isRequired,
  isExpanded: PropTypes.bool.isRequired,
  onClick: PropTypes.func.isRequired,
  onTaskAction: PropTypes.func,
  onTrackClick: PropTypes.func,
  currentUser: PropTypes.shape({
    id: PropTypes.oneOfType([PropTypes.number, PropTypes.string]),
    userId: PropTypes.oneOfType([PropTypes.number, PropTypes.string]),
  }),
  formatDate: PropTypes.func.isRequired,
  formatTime: PropTypes.func.isRequired,
  getStatusClass: PropTypes.func.isRequired,
};

export default OutboxTaskCard;
