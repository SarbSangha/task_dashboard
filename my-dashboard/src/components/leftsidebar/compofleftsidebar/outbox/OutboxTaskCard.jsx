// src/components/outbox/OutboxTaskCard.jsx
import React, { useEffect, useRef, useState } from 'react';
import PropTypes from 'prop-types';
import './OutboxTaskCard.css';
import '../../../common/taskCard/TaskCard.css';
import {
  formatShortDateTime,
  getAvatarHue,
  getDeadlineInfo,
  getInitials,
  getPriorityTone,
  getStatusTone,
  humanize,
} from '../../../../utils/taskPresentation';
import {
  IconArrowRight,
  IconChevronDown,
  IconClock,
  IconCopy,
  IconDownload,
  IconEye,
  IconFlag,
  IconFolder,
  IconLink,
  IconMore,
  IconPaperclip,
  IconPause,
  IconRoute,
  IconUsers,
} from '../../../common/taskCard/taskIcons';
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
}) => {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef(null);

  useEffect(() => {
    if (!menuOpen) return undefined;
    const closeOnOutside = (event) => {
      if (!menuRef.current?.contains(event.target)) setMenuOpen(false);
    };
    const closeOnEscape = (event) => {
      if (event.key === 'Escape') setMenuOpen(false);
    };
    document.addEventListener('mousedown', closeOnOutside);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('mousedown', closeOnOutside);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [menuOpen]);
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

  const statusTone = isFinalApprovalPending ? 'review' : getStatusTone(status);
  const deadlineInfo = getDeadlineInfo(task);
  const priorityTone = getPriorityTone(priority);
  const sentAtValue = sentAt || createdAt;
  const menuLabel = (action) => ({
    track: 'Track',
    chat: 'Chat',
    edit_draft: 'Edit draft',
    delete_draft: 'Delete draft',
    edit_task: 'Edit task',
    hold_task: 'Hold task',
    unhold_task: 'Unhold task',
    revoke_task: 'Revoke task',
  }[action] || humanize(action));
  const stopCardToggle = (event) => event.stopPropagation();

  return (
    <>
      <article
        className={`tc-card tc-card--tile tone-${statusTone} ${isExpanded ? 'is-expanded' : ''}`}
        onClick={() => onClick(id)}
      >
        {activeHoldInfo && (
          <div className="tc-alert tc-alert--held" role="note">
            <IconPause size={14} />
            <span>
              <strong>On hold.</strong>
              {holdUntilLabel ? ` Auto-unholds on ${holdUntilLabel}.` : ' Manual unhold required.'}
              {activeHoldInfo.reason ? ` ${activeHoldInfo.reason}` : ''}
            </span>
          </div>
        )}

        <div className="tc-main">
          <span
            className="tc-avatar"
            style={{ '--tc-avatar-hue': `${getAvatarHue(receiverPrimary)}deg` }}
            title={`To ${receiverPrimary}`}
            aria-hidden="true"
          >
            {getInitials(receiverPrimary)}
          </span>
          <div className="tc-body">
            <div className="tc-title-line">
              <h3 className="tc-title" title={displayTaskName}>{displayTaskName}</h3>
            </div>
            <div className="tc-sub">
              <span className="tc-truncate"><IconFolder size={13} /> {projectName || 'No project'}</span>
              {isResult && <span className="tc-chip tc-chip--accent">Result</span>}
              {activeHoldInfo && <span className="tc-chip tc-chip--warning">Held</span>}
            </div>
          </div>
          <div className="tc-tile-head-side" onClick={stopCardToggle}>
            <span className={`tc-status tone-${statusTone}`}>{displayStatusLabel}</span>
            <div className="tc-menu-wrap" ref={menuRef}>
              <button
                type="button"
                className="tc-btn tc-btn--icon"
                onClick={() => setMenuOpen((prev) => !prev)}
                aria-haspopup="menu"
                aria-expanded={menuOpen}
                aria-label="More actions"
                title="More actions"
              >
                <IconMore size={16} />
              </button>
              {menuOpen && (
                <div className="tc-menu" role="menu">
                  {menuActions.map((action) => (
                    <button
                      key={action}
                      type="button"
                      role="menuitem"
                      className={['revoke_task', 'delete_draft'].includes(action) ? 'is-danger' : ''}
                      onClick={(e) => {
                        setMenuOpen(false);
                        if (action === 'track') {
                          handleTrackClick(e);
                          return;
                        }
                        onTaskAction?.(task, action);
                      }}
                    >
                      {menuLabel(action)}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>

        <div className="tc-route">
          <div className="tc-route-end">
            <span className="tc-route-label">From</span>
            <span className="tc-route-name" title={senderPrimary}>{senderPrimary}</span>
            {senderSecondaryText && <span className="tc-route-dept" title={senderSecondaryText}>{senderSecondaryText}</span>}
          </div>
          <IconArrowRight size={16} className="tc-route-arrow" />
          <div className="tc-route-end">
            <span className="tc-route-label">To</span>
            <span className="tc-route-name" title={receiverPrimary}>{receiverPrimary}</span>
            {receiverSecondaryText && <span className="tc-route-dept" title={receiverSecondaryText}>{receiverSecondaryText}</span>}
          </div>
        </div>

        {isDraft ? (
          <div className="tc-times">
            <div className="tc-time">
              <span>Last saved</span>
              <strong>{formatShortDateTime(updatedAt || createdAt) || '—'}</strong>
            </div>
          </div>
        ) : (
        <div className="tc-times">
          <div className="tc-time" title={sentAtValue ? `${formatDate(sentAtValue)} ${formatTime(sentAtValue)}` : ''}>
            <span>Sent</span>
            <strong>{formatShortDateTime(sentAtValue) || '—'}</strong>
          </div>
          <div className={`tc-time ${submittedDisplayAt ? '' : 'is-pending'}`}>
            <span>Submitted</span>
            <strong>{submittedDisplayAt ? formatShortDateTime(submittedDisplayAt) : 'Not yet'}</strong>
          </div>
          <div className={`tc-time ${approvalDisplayAt ? '' : 'is-pending'}`}>
            <span>Approved</span>
            <strong>{approvalDisplayAt ? formatShortDateTime(approvalDisplayAt) : 'Not yet'}</strong>
          </div>
        </div>
        )}

        <div className="tc-chips">
          {priority && (
            <span className={`tc-priority ${priorityTone ? `tc-priority--${priorityTone}` : ''}`}>
              <IconFlag size={12} /> {priority}
            </span>
          )}
          <span className={`tc-deadline tc-deadline--${deadlineInfo.tone}`} title={deadlineInfo.full ? `Deadline: ${deadlineInfo.full}` : 'No deadline'}>
            <IconClock size={12} />
            {deadlineInfo.tone === 'none' ? 'No deadline' : <><b>{deadlineInfo.meta}</b> · {deadlineInfo.label}</>}
          </span>
          {taskTag && <span className="tc-chip">{taskTag}</span>}
          {requestTypeLabel !== 'Task' && <span className="tc-chip tc-chip--accent">{requestTypeLabel}</span>}
          {hasWorkerSubmissionSummary && (
            <span className="tc-chip" title={submissionModeLabel}>
              <IconUsers size={12} /> {workerSubmissionSummary.submitted || 0}/{workerSubmissionSummary.total || workerSubmissionRows.length} submitted
            </span>
          )}
        </div>

        {summaryText && !isExpanded && <p className="tc-summary">{summaryText}</p>}

        {!isDraft && timelineSteps.some((step) => step.reached) && (
          <ol className="tc-steps" aria-label="Task progress">
            {timelineSteps.map((step) => (
              <li
                key={step.key}
                className={`tc-step ${step.reached ? 'is-reached' : ''} ${currentTimelineKey === step.key ? 'is-current' : ''}`}
                aria-current={currentTimelineKey === step.key ? 'step' : undefined}
              >
                <span className="tc-step-dot" />
                <span className="tc-step-label">{step.label}</span>
              </li>
            ))}
          </ol>
        )}

        {isExpanded && (
          <div className="tc-details" onClick={stopCardToggle}>
            <section className="tc-section">
              <div className="tc-section-head">
                <h4 className="tc-section-title">Brief</h4>
                {displayTaskDetails && (
                  <button
                    type="button"
                    className="tc-mini"
                    onClick={() => copyToClipboard(displayTaskDetails)}
                    title={copied ? 'Copied' : 'Copy brief'}
                    aria-label="Copy brief"
                  >
                    <IconCopy size={14} />
                  </button>
                )}
              </div>
              {displayTaskDetails ? <p className="tc-text">{displayTaskDetails}</p> : <p className="tc-muted">No brief was added.</p>}
            </section>

            {(attachments?.length > 0 || links?.length > 0) && (
              <section className="tc-section">
                <div className="tc-section-head"><h4 className="tc-section-title">Links &amp; files</h4></div>
                {links?.length > 0 && (
                  <ul className="tc-file-list">
                    {links.map((link, idx) => (
                      <li key={`${link}-${idx}`} className="tc-file">
                        <IconLink size={14} />
                        <a className="tc-file-name" href={link} target="_blank" rel="noopener noreferrer" title={link}>{link}</a>
                        <span className="tc-file-actions">
                          <button type="button" className="tc-mini" onClick={(e) => copyLink(link, e)} title="Copy link" aria-label="Copy link">
                            <IconCopy size={14} />
                          </button>
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
                {attachments?.length > 0 && (
                  <ul className="tc-file-list" style={{ marginTop: links?.length ? 6 : 0 }}>
                    {attachments.map((att, idx) => {
                      const label = att.originalName || att.filename || `Attachment ${idx + 1}`;
                      return (
                        <li key={`${att.url || att.filename || idx}-${idx}`} className="tc-file">
                          <IconPaperclip size={14} />
                          <span className="tc-file-name" title={label}>{label}</span>
                          <span className="tc-file-actions">
                            <button type="button" className="tc-mini" onClick={() => setPreviewFile(att)} title="Preview" aria-label={`Preview ${label}`}>
                              <IconEye size={15} />
                            </button>
                            <button type="button" className="tc-mini" onClick={() => forceDownload(att, label)} title="Download" aria-label={`Download ${label}`}>
                              <IconDownload size={15} />
                            </button>
                          </span>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </section>
            )}
            {renderWorkerSubmissions()}
          </div>
        )}

        <div className="tc-tile-footer" onClick={stopCardToggle}>
          <span className="tc-ref" title={projectId || `Task #${id}`}>{projectId || `Task #${id}`}</span>
          <div className="tc-actions">
            {isDraft && (
              <button type="button" className="tc-btn tc-btn--primary" onClick={() => onTaskAction?.(task, 'edit_draft')}>
                Edit draft
              </button>
            )}
            <button type="button" className="tc-btn tc-btn--ghost" onClick={() => onClick(id)} aria-expanded={isExpanded}>
              {isExpanded ? 'Less' : 'Details'}
              <IconChevronDown size={14} className="tc-chevron" />
            </button>
            {!isDraft && (
              <button type="button" className="tc-btn tc-btn--ghost" onClick={handleTrackClick}>
                <IconRoute size={14} /> Track
              </button>
            )}
          </div>
        </div>
      </article>
      {toastMessage && <div className="tc-toast" role="status">{toastMessage}</div>}
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
};

export default OutboxTaskCard;
