import React, { useEffect, useState } from 'react';
import './InboxCard.css';
import { formatDateTimeIndia } from '../../../../utils/dateTime';
import { buildFileDownloadUrl } from '../../../../utils/fileLinks';
import FilePreviewModal from '../../../common/FilePreviewModal';
import { taskAPI } from '../../../../services/api';

const InboxCard = ({ task, onMarkSeen, onTrackClick, onTaskAction, onOpenChat }) => {
  const [menuOpen, setMenuOpen] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [copiedKey, setCopiedKey] = useState('');
  const [toastMessage, setToastMessage] = useState('');
  const [previewFile, setPreviewFile] = useState(null);
  const [workflowDetail, setWorkflowDetail] = useState(null);
  const [workflowLoading, setWorkflowLoading] = useState(false);
  const [workflowError, setWorkflowError] = useState('');
  const isWorkflowTask = Boolean(task.workflowEnabled);
  const normalizedStatus = `${task.status || ''}`.toLowerCase();
  const normalizedWorkflowStatus = `${task.workflowStatus || ''}`.toLowerCase();
  const isCreatorTask = task.creator?.id === task.creatorId || task.myRole === 'creator';
  const isRevoked = task.status === 'cancelled' && !!(task.revocation || `${task.workflowStage || ''}`.includes('revoked'));
  const revokedBy = task.revocation?.revokedBy || task.creator?.name || 'Creator';
  const revokedAt = task.revocation?.revokedAt ? formatDateTimeIndia(task.revocation.revokedAt) : '';
  const revokedReason = task.revocation?.reason || '';

  const baseActions = (task.availableActions || []).filter((action) => {
    if (action !== 'edit_task') return true;
    return task.status === 'need_improvement';
  });
  const canShowStartTask =
    !isWorkflowTask &&
    task.myRole === 'assignee' &&
    !['completed', 'cancelled', 'rejected'].includes(task.status);
  const canShowSubmitTask =
    !isWorkflowTask &&
    task.myRole === 'assignee' &&
    !['completed', 'cancelled', 'rejected', 'submitted'].includes(task.status);
  const withStart = canShowStartTask && !baseActions.includes('start')
    ? ['start', ...baseActions]
    : baseActions;
  const computedActions = canShowSubmitTask && !withStart.includes('submit')
    ? [...withStart, 'submit']
    : withStart;
  const inferFallbackActions = () => {
    const inferred = [];
    const terminalStatuses = ['completed', 'cancelled', 'rejected'];

    if (isWorkflowTask) {
      const workflowWaitingApproval =
        normalizedWorkflowStatus === 'waiting_approval'
        || (normalizedStatus === 'submitted' && Boolean(task.currentStageApprovalRequired))
        || (normalizedStatus === 'approved' && Boolean(task.finalApprovalRequired) && isCreatorTask);

      if (
        task.myRole === 'assignee'
        && ['active', 'revision_requested'].includes(normalizedWorkflowStatus)
      ) {
        if (['assigned', 'pending', 'need_improvement'].includes(normalizedStatus)) {
          inferred.push('start');
        }
        inferred.push('submit');
      }

      if (isCreatorTask && workflowWaitingApproval) {
        inferred.push('approve', 'need_improvement');
      }

      if (isCreatorTask && !terminalStatuses.includes(normalizedStatus)) {
        inferred.push('revoke_task');
      }

      if (
        isCreatorTask
        && ['not_started', 'active'].includes(normalizedWorkflowStatus)
        && !terminalStatuses.includes(normalizedStatus)
      ) {
        inferred.push('edit_task');
      }
    } else {
      if (isCreatorTask && ['submitted', 'approved'].includes(normalizedStatus)) {
        inferred.push('approve', 'need_improvement');
      }
      if (isCreatorTask && !terminalStatuses.includes(normalizedStatus)) {
        inferred.push('revoke_task');
      }
    }

    return inferred;
  };

  const mergedActions = [...computedActions, ...inferFallbackActions()];
  const dedupedActions = [];
  mergedActions.forEach((action) => {
    if (!dedupedActions.includes(action)) {
      dedupedActions.push(action);
    }
  });

  const withChat = !dedupedActions.includes('chat')
    ? ['chat', ...dedupedActions]
    : dedupedActions;
  const actions = isRevoked ? [] : withChat;
  const assignedNames = (task.assignedTo || []).map((x) => x.name).join(', ') || 'Unassigned';
  const description = task.description || '';
  const shortDescription = description.length > 120 ? `${description.slice(0, 120)}...` : description;
  const requestTypeLabel = (() => {
    const type = (task.taskType || 'task').toLowerCase();
    if (type === 'task_approval') return 'Task Approval';
    if (type === 'submission_result') return 'Submission Result';
    return 'Task';
  })();
  const actionLabel = (action) => {
    if (action === 'chat') return 'Chat';
    if (action === 'start') return isWorkflowTask ? 'Start Stage' : 'Start Task';
    if (action === 'submit') return isWorkflowTask ? 'Submit Stage' : 'Submit Task';
    if (action === 'approve') return isWorkflowTask ? 'Approve Stage' : 'Approve';
    if (action === 'need_improvement') return isWorkflowTask ? 'Request Revision' : 'Need Improvement';
    if (action === 'forward') return 'Forward To';
    return action.replace(/_/g, ' ');
  };
  const editCount = Number(task.editCount ?? ((task.taskVersion || 1) - 1));
  const showEditBadge = task.myRole !== 'creator' && editCount > 0;
  const activeStageLabel = isWorkflowTask
    ? [task.currentStageOrder ? `Stage ${task.currentStageOrder}` : '', task.currentStageTitle || ''].filter(Boolean).join(': ')
    : '';

  useEffect(() => {
    let cancelled = false;

    const loadWorkflowDetail = async () => {
      if (!expanded || !isWorkflowTask || !task?.id) return;
      setWorkflowLoading(true);
      setWorkflowError('');
      try {
        const response = await taskAPI.getWorkflow(task.id);
        if (!cancelled) {
          setWorkflowDetail(response);
        }
      } catch (error) {
        if (!cancelled) {
          setWorkflowError(error?.response?.data?.detail || 'Unable to load stage-wise workflow details right now.');
        }
      } finally {
        if (!cancelled) {
          setWorkflowLoading(false);
        }
      }
    };

    if (!expanded) return undefined;

    if (!isWorkflowTask) {
      setWorkflowDetail(null);
      setWorkflowLoading(false);
      setWorkflowError('');
      return undefined;
    }

    void loadWorkflowDetail();

    return () => {
      cancelled = true;
    };
  }, [expanded, isWorkflowTask, task?.id]);

  const forceDownload = (file, filename) => {
    const downloadUrl = buildFileDownloadUrl(file, filename);
    const link = document.createElement('a');
    link.href = downloadUrl;
    link.style.display = 'none';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };
  const copyToClipboard = async (text, key) => {
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
      setCopiedKey(key);
      setToastMessage('Copied to clipboard');
      window.setTimeout(() => setCopiedKey(''), 1200);
      window.setTimeout(() => setToastMessage(''), 1400);
    } catch (error) {
      console.warn('Copy failed:', error);
    }
  };

  const handleOpenChat = () => {
    if (typeof onMarkSeen === 'function') {
      void onMarkSeen(task);
    }
    onOpenChat(task);
  };

  const handleTrack = () => {
    if (typeof onMarkSeen === 'function') {
      void onMarkSeen(task);
    }
    onTrackClick(task);
  };

  const handleToggleExpanded = () => {
    if (!expanded && typeof onMarkSeen === 'function') {
      void onMarkSeen(task);
    }
    setExpanded((s) => !s);
  };

  const renderLinkList = (links = [], prefix) => {
    if (!Array.isArray(links) || links.length === 0) {
      return <div className="workflow-stage-empty">No links shared.</div>;
    }
    return (
      <div className="stage-resource-list">
        {links.map((link, idx) => (
          <div key={`${prefix}-link-${idx}`} className="stage-resource-item">
            <span>{link}</span>
            <span className="attachment-actions">
              <a href={link} target="_blank" rel="noreferrer">Open</a>
              <button
                type="button"
                className="mini-action-btn"
                onClick={() => copyToClipboard(link, `${prefix}-link-${idx}`)}
              >
                {copiedKey === `${prefix}-link-${idx}` ? 'Copied' : 'Copy'}
              </button>
            </span>
          </div>
        ))}
      </div>
    );
  };

  const renderFileList = (files = [], prefix) => {
    if (!Array.isArray(files) || files.length === 0) {
      return <div className="workflow-stage-empty">No files shared.</div>;
    }
    return (
      <div className="stage-resource-list">
        {files.map((file, idx) => {
          const label = file?.originalName || file?.filename || `Attachment ${idx + 1}`;
          return (
            <div key={`${prefix}-file-${idx}`} className="stage-resource-item">
              <span>{label}</span>
              <span className="attachment-actions">
                <button
                  type="button"
                  className="mini-action-btn"
                  onClick={() => setPreviewFile(file)}
                >
                  Open
                </button>
                <button
                  type="button"
                  className="mini-action-btn"
                  onClick={() => forceDownload(file, label)}
                >
                  Download
                </button>
              </span>
            </div>
          );
        })}
      </div>
    );
  };

  const renderWorkflowStages = () => {
    if (!isWorkflowTask) return null;
    if (workflowLoading) {
      return (
        <div className="workflow-stage-summary-block full-span">
          <div className="workflow-stage-summary-head">
            <strong>Stage-wise flow</strong>
            <span>Loading workflow details...</span>
          </div>
        </div>
      );
    }

    if (workflowError) {
      return (
        <div className="workflow-stage-summary-block full-span">
          <div className="workflow-stage-summary-head">
            <strong>Stage-wise flow</strong>
            <span className="workflow-stage-error">{workflowError}</span>
          </div>
        </div>
      );
    }

    const stages = Array.isArray(workflowDetail?.stages) ? workflowDetail.stages : [];
    if (stages.length === 0) {
      return (
        <div className="workflow-stage-summary-block full-span">
          <div className="workflow-stage-summary-head">
            <strong>Stage-wise flow</strong>
            <span>No stage details available.</span>
          </div>
        </div>
      );
    }

    return (
      <div className="workflow-stage-summary-block full-span">
        <div className="workflow-stage-summary-head">
          <strong>Stage-wise flow</strong>
          <span>{stages.length} stage{stages.length === 1 ? '' : 's'} with input and output details</span>
        </div>
        <div className="workflow-stage-card-list">
          {stages.map((stage) => {
            const submission = stage.currentSubmission || null;
            const links = Array.isArray(submission?.links) ? submission.links : [];
            const attachments = Array.isArray(submission?.attachments) ? submission.attachments : [];
            const comments = Array.isArray(stage.comments) ? stage.comments : [];
            const eventLog = Array.isArray(stage.eventLog) ? stage.eventLog.slice(0, 2) : [];
            const assigneeNames = (stage.assignees || []).map((assignee) => assignee.name).join(', ') || 'Unassigned';
            const stageStatusLabel = `${stage.status || 'pending'}`.replace(/_/g, ' ');
            const isCurrentStage = Number(task.currentStageId) === Number(stage.id);
            const activityCount = (stage.history || []).length + comments.length;

            return (
              <article
                key={stage.id}
                className={`workflow-stage-card ${isCurrentStage ? 'current' : ''} status-${(stage.status || 'pending').toLowerCase()}`}
              >
                <div className="workflow-stage-card-head">
                  <div className="workflow-stage-card-title">
                    <span className="workflow-stage-chip">Stage {stage.order}</span>
                    <h4>{stage.title}</h4>
                    <p>{stage.description || 'No stage instructions added yet.'}</p>
                  </div>
                  <div className="workflow-stage-badges">
                    {isCurrentStage ? <span className="workflow-stage-badge current">Current</span> : null}
                    <span className="workflow-stage-badge">{stageStatusLabel}</span>
                    <span className="workflow-stage-badge subtle">
                      {stage.approvalRequired ? 'Approval required' : 'Auto handoff'}
                    </span>
                  </div>
                </div>

                <div className="workflow-stage-metrics">
                  <div>
                    <span>Owners</span>
                    <strong>{assigneeNames}</strong>
                  </div>
                  <div>
                    <span>Started</span>
                    <strong>{formatDateTimeIndia(stage.startedAt) || 'N/A'}</strong>
                  </div>
                  <div>
                    <span>Submitted</span>
                    <strong>{formatDateTimeIndia(stage.submittedAt) || 'N/A'}</strong>
                  </div>
                  <div>
                    <span>Completed</span>
                    <strong>{formatDateTimeIndia(stage.completedAt) || 'N/A'}</strong>
                  </div>
                </div>

                <div className="workflow-stage-io-grid">
                  <section className="workflow-stage-pane">
                    <div className="workflow-stage-pane-head">
                      <span>Input</span>
                      <strong>{stage.approvalRequired ? 'Review gate' : 'Auto flow'}</strong>
                    </div>
                    <div className="workflow-stage-field">
                      <label>Instructions</label>
                      <p>{stage.description || 'No instructions added for this stage.'}</p>
                    </div>
                    <div className="workflow-stage-field">
                      <label>Assignees</label>
                      <p>{assigneeNames}</p>
                    </div>
                    <div className="workflow-stage-field">
                      <label>Handoff type</label>
                      <p>{stage.approvalRequired ? 'Requires review before moving ahead.' : 'Moves to next stage automatically.'}</p>
                    </div>
                    {stage.revisionNotes ? (
                      <div className="workflow-stage-field">
                        <label>Revision note</label>
                        <p>{stage.revisionNotes}</p>
                      </div>
                    ) : null}
                  </section>

                  <section className="workflow-stage-pane">
                    <div className="workflow-stage-pane-head">
                      <span>Output</span>
                      <strong>{submission?.version ? `v${submission.version}` : 'No submission yet'}</strong>
                    </div>
                    <div className="workflow-stage-field">
                      <label>Output text</label>
                      <p>{submission?.outputText || 'No output submitted yet.'}</p>
                    </div>
                    <div className="workflow-stage-field">
                      <label>Links</label>
                      {renderLinkList(links, `stage-${stage.id}`)}
                    </div>
                    <div className="workflow-stage-field">
                      <label>Files</label>
                      {renderFileList(attachments, `stage-${stage.id}`)}
                    </div>
                  </section>
                </div>

                <div className="workflow-stage-activity">
                  <div className="workflow-stage-pane-head">
                    <span>Stage activity</span>
                    <strong>{activityCount} item{activityCount === 1 ? '' : 's'}</strong>
                  </div>
                  {eventLog.length > 0 ? (
                    <div className="workflow-stage-event-list">
                      {eventLog.map((event) => (
                        <div key={event.id} className="workflow-stage-event-item">
                          <div className="workflow-stage-event-head">
                            <strong>{event.label || event.action}</strong>
                            <span>{formatDateTimeIndia(event.timestamp) || 'N/A'}</span>
                          </div>
                          {event.user?.name ? (
                            <small>
                              {event.user.name}
                              {event.user.department ? ` • ${event.user.department}` : ''}
                            </small>
                          ) : null}
                          {event.comments ? <p>{event.comments}</p> : null}
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="workflow-stage-empty">No activity recorded for this stage yet.</div>
                  )}
                  {comments.length > 0 ? (
                    <div className="workflow-stage-comment-summary">
                      <label>Latest comment</label>
                      <p>{comments[comments.length - 1]?.comment || 'No stage comments yet.'}</p>
                    </div>
                  ) : null}
                </div>
              </article>
            );
          })}
        </div>
      </div>
    );
  };

  return (
    <div className={`inbox-card ${isRevoked ? 'revoked-card' : ''}`}>
      <div className="card-header">
        <div>
          <div className="card-title-row">
            <h3 className="card-title">{task.title}</h3>
            {showEditBadge && (
              <span className="task-edit-badge">Edit #{editCount}</span>
            )}
          </div>
          <p className="card-subtitle">{shortDescription}</p>
        </div>
        <div className="card-menu-wrap">
          <button className="card-menu-btn" onClick={() => setMenuOpen((s) => !s)}>⋮</button>
          {menuOpen && (
            <div className="card-menu">
              {actions.map((action) => (
                <button
                  key={action}
                  onClick={() => {
                    setMenuOpen(false);
                    if (action === 'chat') handleOpenChat();
                    else onTaskAction(task, action);
                  }}
                >
                  {actionLabel(action)}
                </button>
              ))}
              {actions.length === 0 && <span className="card-menu-empty">No actions</span>}
            </div>
          )}
        </div>
      </div>
      {isRevoked && (
        <div className="revoked-banner">
          <strong>This task has been revoked (regularised).</strong>
          <span>
            {` By ${revokedBy}${revokedAt ? ` on ${revokedAt}` : ''}${revokedReason ? `. Reason: ${revokedReason}` : ''}`}
          </span>
        </div>
      )}

      <div className="card-grid">
        <span><strong>Task ID:</strong> {task.taskNumber || '-'}</span>
        <span><strong>Project ID:</strong> {task.projectId || '-'}</span>
        <span><strong>Creator:</strong> {task.creator?.name || 'Unknown'} ({task.creator?.department || 'N/A'})</span>
        <span><strong>Status:</strong> {(task.status || '').replace(/_/g, ' ')}</span>
        {isWorkflowTask && (
          <span><strong>Active Stage:</strong> {activeStageLabel || '-'}</span>
        )}
        <span><strong>Assigned To:</strong> {assignedNames}</span>
        <span><strong>Request Type:</strong> {requestTypeLabel}</span>
        <span><strong>Chat:</strong> {task.chatCount || 0}</span>
        <span><strong>Created:</strong> {task.createdAt ? formatDateTimeIndia(task.createdAt) : '-'}</span>
        <span><strong>Updated:</strong> {task.updatedAt ? formatDateTimeIndia(task.updatedAt) : '-'}</span>
      </div>

      {expanded && (
        <div className="card-details">
          <div><strong>Project Name:</strong> {task.projectName || '-'}</div>
          <div><strong>Customer Name:</strong> {task.customerName || '-'}</div>
          <div className="full-span"><strong>Reference:</strong> {task.reference || '-'}</div>
          <div className="full-span">
            <div className="detail-head">
              <strong>Task Details:</strong>
              <button
                type="button"
                className="mini-action-btn"
                onClick={() => copyToClipboard(task.description, 'task-details')}
                disabled={!task.description}
              >
                {copiedKey === 'task-details' ? 'Copied' : 'Copy'}
              </button>
            </div>
            <div className="forward-item">{task.description || '-'}</div>
          </div>
          <div><strong>Deadline:</strong> {task.deadline ? formatDateTimeIndia(task.deadline) : 'Not set'}</div>
          <div><strong>Priority:</strong> {task.priority || '-'}</div>
          <div><strong>Request Type:</strong> {requestTypeLabel}</div>
          <div><strong>Tag:</strong> {task.taskTag || '-'}</div>
          <div><strong>From Department:</strong> {task.fromDepartment || '-'}</div>
          <div><strong>To Department:</strong> {task.toDepartment || '-'}</div>
          <div><strong>Workflow Stage:</strong> {task.workflowStage || '-'}</div>
          {isWorkflowTask && <div><strong>Current Stage:</strong> {activeStageLabel || '-'}</div>}
          <div><strong>Created By:</strong> {task.creator?.name || '-'}</div>
          <div><strong>Last Forwarded By:</strong> {task.lastForwardedBy || '-'}</div>
          {renderWorkflowStages()}
          <div className="forward-history">
            <strong>Task Links:</strong>
            {(task.links || []).length === 0 && <div className="forward-item">-</div>}
            {(task.links || []).map((link, idx) => (
              <div key={`${link}-${idx}`} className="forward-item">
                <span>{link}</span>
                <span className="attachment-actions">
                  <a href={link} target="_blank" rel="noreferrer">Open</a>
                  <button
                    type="button"
                    className="mini-action-btn"
                    onClick={() => copyToClipboard(link, `task-link-${idx}`)}
                  >
                    {copiedKey === `task-link-${idx}` ? 'Copied' : 'Copy Link'}
                  </button>
                </span>
              </div>
            ))}
          </div>
          <div className="forward-history">
            <strong>Task Attachments:</strong>
            {(task.attachments || []).length === 0 && <div className="forward-item">No attachments</div>}
            {(task.attachments || []).map((file, idx) => (
              <div key={`${file?.url || file?.filename || idx}-${idx}`} className="forward-item">
                <span>{file?.originalName || file?.filename || `Attachment ${idx + 1}`}</span>
                <span className="attachment-actions">
                  <button
                    type="button"
                    className="mini-action-btn"
                    onClick={() => setPreviewFile(file)}
                  >
                    Open
                  </button>
                  <button
                    type="button"
                    className="mini-action-btn"
                    onClick={() => forceDownload(file, file?.originalName || file?.filename || `attachment-${idx + 1}`)}
                  >
                    Download
                  </button>
                </span>
              </div>
            ))}
          </div>
          {(task.forwardHistory || []).length > 0 && (
            <div className="forward-history">
              <strong>Forward History:</strong>
              {(task.forwardHistory || []).map((f) => (
                <div key={f.id} className="forward-item">
                  {f.fromUser} ({f.fromDepartment || '-'}) → {f.toUser || f.toDepartment || '-'} {f.createdAt ? `| ${formatDateTimeIndia(f.createdAt)}` : ''}
                </div>
              ))}
            </div>
          )}
          {(task.resultText || (task.resultLinks || []).length > 0 || (task.resultAttachments || []).length > 0) && (
            <div className="forward-history">
              <div className="detail-head">
                <strong>Submitted Result:</strong>
                <button
                  type="button"
                  className="mini-action-btn"
                  onClick={() => copyToClipboard(task.resultText, 'result-text')}
                  disabled={!task.resultText}
                >
                  {copiedKey === 'result-text' ? 'Copied' : 'Copy'}
                </button>
              </div>
              {task.resultText && <div className="forward-item">{task.resultText}</div>}
              {(task.resultLinks || []).map((link, idx) => (
                <div key={`${link}-${idx}`} className="forward-item">
                  <span>{link}</span>
                  <span className="attachment-actions">
                    <a href={link} target="_blank" rel="noreferrer">Open</a>
                    <button
                      type="button"
                      className="mini-action-btn"
                      onClick={() => copyToClipboard(link, `result-link-${idx}`)}
                    >
                      {copiedKey === `result-link-${idx}` ? 'Copied' : 'Copy Link'}
                    </button>
                  </span>
                </div>
              ))}
              {(task.resultAttachments || []).map((file, idx) => (
                <div key={`${file?.url || file?.filename || idx}-${idx}`} className="forward-item">
                  <span>{file?.originalName || file?.filename || `Attachment ${idx + 1}`}</span>
                  <span className="attachment-actions">
                    <button
                      type="button"
                      className="mini-action-btn"
                      onClick={() => setPreviewFile(file)}
                    >
                      Open
                    </button>
                    <button
                      type="button"
                      className="mini-action-btn"
                      onClick={() => forceDownload(file, file?.originalName || file?.filename || `result-attachment-${idx + 1}`)}
                    >
                      Download
                    </button>
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      <div className="card-footer">
        <span className="seenby">Seen by: {(task.seenBy || []).map((s) => s.name).join(', ') || 'None'}</span>
        <div className="card-footer-actions">
          <button className="track-btn" onClick={handleToggleExpanded}>
            {expanded ? 'Hide Details' : 'Show Details'}
          </button>
          <button className="track-btn" onClick={handleTrack}>Track</button>
        </div>
      </div>
      {toastMessage && <div className="copy-toast">{toastMessage}</div>}
      {previewFile ? (
        <FilePreviewModal
          file={previewFile}
          title={previewFile?.originalName || previewFile?.filename || 'Attachment'}
          subtitle={`${task.title || 'Task'}${task.taskNumber ? ` • ${task.taskNumber}` : ''}`}
          onClose={() => setPreviewFile(null)}
        />
      ) : null}
    </div>
  );
};

export default InboxCard;
