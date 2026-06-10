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
  const normalizedWorkflowStage = `${task.workflowStage || ''}`.toLowerCase();
  const isCreatorTask = Boolean(task.isCreator) || task.myRole === 'creator';
  const isRevoked = task.status === 'cancelled' && !!(task.revocation || `${task.workflowStage || ''}`.includes('revoked'));
  const isHeld = Boolean(task.isHeld || task.holdInfo?.active);
  const holdUntilLabel = task.holdInfo?.until ? formatDateTimeIndia(task.holdInfo.until) : '';
  const revokedBy = task.revocation?.revokedBy || task.creator?.name || 'Creator';
  const revokedAt = task.revocation?.revokedAt ? formatDateTimeIndia(task.revocation.revokedAt) : '';
  const revokedReason = task.revocation?.reason || '';
  const assignedPeople = Array.isArray(task.assignedTo) ? task.assignedTo : [];
  const workerSubmissionSummary = task.workerSubmissions || {};
  const workerSubmissionRows = Array.isArray(workerSubmissionSummary.workers) ? workerSubmissionSummary.workers : [];
  const normalizedSubmissionMode = workerSubmissionSummary.mode === 'all' || task.submissionMode === 'all'
    ? 'all'
    : 'any';
  const workerStatusRows = workerSubmissionRows.length > 0
    ? workerSubmissionRows
    : assignedPeople.map((worker) => ({
        id: worker.id,
        name: worker.name,
        department: worker.department,
        status: 'pending',
        started: false,
        submitted: false,
      }));
  const viewerStartedPart = Boolean(workerSubmissionSummary.viewerStarted);
  const viewerHasSubmittedPart = Boolean(workerSubmissionSummary.viewerSubmitted);
  const viewerSubmittedPart = normalizedSubmissionMode === 'all' && viewerHasSubmittedPart;
  const hasWorkerSubmissionSummary = !isWorkflowTask && workerStatusRows.length > 1;
  const submissionModeLabel = normalizedSubmissionMode === 'all'
    ? 'Every worker must submit'
    : 'Any one worker can submit';
  const startableStatuses = ['pending', 'forwarded', 'assigned', 'need_improvement'];
  const submittableStatuses = ['in_progress'];
  const approvableStatuses = ['submitted', 'under_review', 'approved'];
  const workflowWaitingApproval =
    approvableStatuses.includes(normalizedStatus)
    && (normalizedWorkflowStatus === 'waiting_approval'
    || (normalizedStatus === 'submitted' && Boolean(task.currentStageApprovalRequired))
    || (normalizedStatus === 'approved' && Boolean(task.finalApprovalRequired) && isCreatorTask));
  const canReviewTask = isWorkflowTask
    ? workflowWaitingApproval
    : approvableStatuses.includes(normalizedStatus);
  const canStartOwnPart = normalizedStatus === 'in_progress' && hasWorkerSubmissionSummary && !viewerStartedPart && !viewerSubmittedPart;
  const canSubmitOwnPart = !hasWorkerSubmissionSummary || viewerStartedPart || viewerSubmittedPart;

  const baseActions = (task.availableActions || []).filter((action) => {
    if (action === 'start') return startableStatuses.includes(normalizedStatus) || canStartOwnPart;
    if (action === 'submit') return submittableStatuses.includes(normalizedStatus) && canSubmitOwnPart;
    if (action === 'approve' || action === 'need_improvement') return canReviewTask;
    if (action !== 'edit_task') return true;
    return task.status === 'need_improvement';
  });
  const canShowStartTask =
    !isWorkflowTask &&
    task.myRole === 'assignee' &&
    !isHeld &&
    (startableStatuses.includes(normalizedStatus) || canStartOwnPart);
  const canShowSubmitTask =
    !isWorkflowTask &&
    task.myRole === 'assignee' &&
    !isHeld &&
    !viewerHasSubmittedPart &&
    canSubmitOwnPart &&
    submittableStatuses.includes(normalizedStatus);
  const canShowEditSubmitTask =
    !isWorkflowTask &&
    task.myRole === 'assignee' &&
    !isHeld &&
    viewerHasSubmittedPart &&
    ['in_progress', 'submitted', 'under_review'].includes(normalizedStatus);
  const withStart = canShowStartTask && !baseActions.includes('start')
    ? ['start', ...baseActions]
    : baseActions;
  const withSubmit = canShowSubmitTask && !withStart.includes('submit')
    ? [...withStart, 'submit']
    : withStart;
  const computedActions = canShowEditSubmitTask && !withSubmit.includes('edit_submit')
    ? [...withSubmit, 'edit_submit']
    : withSubmit;
  const inferFallbackActions = () => {
    const inferred = [];
    const terminalStatuses = ['completed', 'cancelled', 'rejected'];
    if (isHeld) return inferred;

    if (isWorkflowTask) {
      if (
        task.myRole === 'assignee'
        && ['active', 'revision_requested'].includes(normalizedWorkflowStatus)
      ) {
        if (['assigned', 'pending', 'need_improvement'].includes(normalizedStatus)) {
          inferred.push('start');
        }
        if (normalizedStatus === 'in_progress') {
          inferred.push('submit');
        }
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
      if (isCreatorTask && canReviewTask) {
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
  const visibleActions = isCreatorTask ? actions : actions.filter((action) => action !== 'approve');
  const showInlineApprove = isCreatorTask && visibleActions.includes('approve');
  const menuActions = showInlineApprove ? visibleActions.filter((action) => action !== 'approve') : visibleActions;
  const assignedNames = assignedPeople.map((x) => x.name).join(', ') || 'Unassigned';
  const description = task.description || '';
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
    if (action === 'edit_submit') return isWorkflowTask ? 'Edit Stage Submit' : 'Edit Submit';
    if (action === 'approve') return isWorkflowTask ? 'Approve Stage' : 'Approve';
    if (action === 'need_improvement') return isWorkflowTask ? 'Request Revision' : 'Need Improvement';
    if (action === 'forward') return 'Forward To';
    if (action === 'hold_task') return 'Hold Task';
    if (action === 'unhold_task') return 'Unhold Task';
    return action.replace(/_/g, ' ');
  };
  const activeStageLabel = isWorkflowTask
    ? [task.currentStageOrder ? `Stage ${task.currentStageOrder}` : '', task.currentStageTitle || ''].filter(Boolean).join(': ')
    : '';
  const displayTaskName = task.taskName || task.title || task.taskNumber || '-';
  const displayProjectName = task.projectName || task.projectId || '-';
  const statusTileClass = (() => {
    if (['pending', 'assigned', 'forwarded'].includes(normalizedStatus)) return 'status-pending';
    if (normalizedStatus === 'in_progress') return 'status-progress';
    if (['submitted', 'under_review'].includes(normalizedStatus)) return 'status-submitted';
    if (normalizedStatus === 'need_improvement') return 'status-improvement';
    if (['approved', 'completed'].includes(normalizedStatus)) return 'status-complete';
    if (['cancelled', 'rejected'].includes(normalizedStatus)) return 'status-cancelled';
    if (normalizedStatus === 'draft') return 'status-draft';
    return 'status-default';
  })();
  const statusDisplayLabel = (() => {
    if (!isWorkflowTask && normalizedStatus === 'approved' && isCreatorTask) {
      if (normalizedWorkflowStage === 'hod_approved') return 'HOD approved - final approval pending';
      if (normalizedWorkflowStage === 'spoc_approved') return 'SPOC approved - final approval pending';
    }
    return (task.status || '').replace(/_/g, ' ') || '-';
  })();
  const deadlineInfo = (() => {
    if (!task.deadline) {
      return {
        className: 'deadline-none',
        label: 'Not set',
        meta: 'No deadline',
      };
    }

    const deadlineDate = new Date(task.deadline);
    if (Number.isNaN(deadlineDate.getTime())) {
      return {
        className: 'deadline-none',
        label: formatDateTimeIndia(task.deadline) || 'Invalid date',
        meta: 'Check date',
      };
    }

    const terminalStatuses = new Set(['completed', 'cancelled', 'rejected']);
    const now = Date.now();
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const deadlineDayStart = new Date(deadlineDate);
    deadlineDayStart.setHours(0, 0, 0, 0);
    const diffMs = deadlineDate.getTime() - now;
    const diffDays = Math.round((deadlineDayStart.getTime() - todayStart.getTime()) / (24 * 60 * 60 * 1000));
    const label = formatDateTimeIndia(task.deadline);

    const isDeadlineMissed = diffMs < 0;

    if (isDeadlineMissed && !terminalStatuses.has(normalizedStatus)) {
      return {
        className: 'deadline-overdue',
        label,
        meta: 'Overdue',
      };
    }
    if (terminalStatuses.has(normalizedStatus)) {
      return {
        className: isDeadlineMissed ? 'deadline-closed-missed' : 'deadline-complete',
        label,
        meta: isDeadlineMissed ? 'Closed late' : 'Closed',
      };
    }
    if (diffDays <= 1) {
      return {
        className: 'deadline-today',
        label,
        meta: diffDays <= 0 ? 'Due today' : 'Due tomorrow',
      };
    }
    if (diffDays <= 3) {
      return {
        className: 'deadline-soon',
        label,
        meta: `${diffDays} days left`,
      };
    }
    return {
      className: 'deadline-ok',
      label,
      meta: `${diffDays} days left`,
    };
  })();
  const renderActionMenu = () => (
    <div className="card-menu-wrap">
      <button className="card-menu-btn" onClick={() => setMenuOpen((s) => !s)}>⋮</button>
      {menuOpen && (
        <div className="card-menu">
          {menuActions.map((action) => (
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
          {menuActions.length === 0 && <span className="card-menu-empty">No actions</span>}
        </div>
      )}
    </div>
  );

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

  const renderWorkerSubmissions = () => {
    if (!hasWorkerSubmissionSummary) return null;

    return (
      <div className="worker-submission-block full-span">
        <div className="worker-submission-head">
          <strong>Worker Status</strong>
          <span>
            {submissionModeLabel} · {workerSubmissionSummary.submitted || 0}/{workerSubmissionSummary.total || workerStatusRows.length} submitted
          </span>
        </div>
        <div className="worker-submission-list">
          {workerStatusRows.map((worker) => {
            const submission = worker.submission || {};
            const submitted = Boolean(worker.submitted);
            const prefix = `worker-${worker.id || worker.name}`;
            return (
              <article
                key={worker.id || worker.name}
                className={`worker-submission-card ${submitted ? 'submitted' : 'pending'}`}
              >
                <div className="worker-submission-card-head">
                  <div>
                    <h4>{worker.name || 'Unknown worker'}</h4>
                    <p>{worker.department || 'No department'}</p>
                  </div>
                  <span className="worker-submission-status">
                    {submitted ? 'Submitted' : worker.started ? 'In Progress' : 'Not Started'}
                  </span>
                </div>
                {submitted ? (
                  <>
                    <div className="workflow-stage-field">
                      <label>Submitted at</label>
                      <p>{formatDateTimeIndia(submission.submittedAt) || 'N/A'}</p>
                    </div>
                    <div className="workflow-stage-field">
                      <label>Output text</label>
                      <p>{submission.outputText || 'No text submitted.'}</p>
                    </div>
                    <div className="workflow-stage-field">
                      <label>Links</label>
                      {renderLinkList(submission.links || [], `${prefix}-links`)}
                    </div>
                    <div className="workflow-stage-field">
                      <label>Files</label>
                      {renderFileList(submission.attachments || [], `${prefix}-files`)}
                    </div>
                  </>
                ) : (
                  <div className="workflow-stage-empty">
                    {worker.started
                      ? `Started${worker.startedAt ? ` at ${formatDateTimeIndia(worker.startedAt)}` : ''}. No result submitted yet.`
                      : 'This worker has not started yet.'}
                  </div>
                )}
              </article>
            );
          })}
        </div>
      </div>
    );
  };

  const renderWorkerStatusStrip = () => {
    if (!hasWorkerSubmissionSummary) return null;
    return (
      <div className="worker-status-strip">
        <div className="worker-status-strip-head">
          <strong>Worker Status</strong>
          <span>{submissionModeLabel}</span>
        </div>
        <div className="worker-status-chip-list">
          {workerStatusRows.map((worker) => {
            const status = worker.submitted ? 'Submitted' : worker.started ? 'In Progress' : 'Not Started';
            return (
              <span
                key={worker.id || worker.name}
                className={`worker-status-chip ${worker.submitted ? 'submitted' : worker.started ? 'progress' : 'pending'}`}
              >
                <b>{worker.name || 'Unknown worker'}</b>
                <em>{status}</em>
              </span>
            );
          })}
        </div>
      </div>
    );
  };

  return (
    <div className={`inbox-card ${isRevoked ? 'revoked-card' : ''}`}>
      {isRevoked && (
        <div className="revoked-banner">
          <strong>This task has been revoked (regularised).</strong>
          <span>
            {` By ${revokedBy}${revokedAt ? ` on ${revokedAt}` : ''}${revokedReason ? `. Reason: ${revokedReason}` : ''}`}
          </span>
        </div>
      )}
      {isHeld && !isRevoked && (
        <div className="held-banner">
          <strong>This task is on hold.</strong>
          <span>
            {holdUntilLabel ? ` Auto-unholds on ${holdUntilLabel}.` : ' The creator must unhold it before work can continue.'}
            {task.holdInfo?.reason ? ` Reason: ${task.holdInfo.reason}` : ''}
          </span>
        </div>
      )}

      <div className="card-grid">
        <span><strong>Task Name:</strong> {displayTaskName}</span>
        <span><strong>Project Name:</strong> {displayProjectName}</span>
        <span><strong>Creator:</strong> {task.creator?.name || 'Unknown'} ({task.creator?.department || 'N/A'})</span>
        <span className={`status-tile ${statusTileClass}`}>
          <strong>Overall Status:</strong>
          <em>{statusDisplayLabel}</em>
        </span>
        {isWorkflowTask && (
          <span><strong>Active Stage:</strong> {activeStageLabel || '-'}</span>
        )}
        <span><strong>Assigned To:</strong> {assignedNames}</span>
        <span><strong>Request Type:</strong> {requestTypeLabel}</span>
        <span><strong>Chat:</strong> {task.chatCount || 0}</span>
        <span><strong>Created:</strong> {task.createdAt ? formatDateTimeIndia(task.createdAt) : '-'}</span>
        <span><strong>Updated:</strong> {task.updatedAt ? formatDateTimeIndia(task.updatedAt) : '-'}</span>
        <span className={`deadline-tile ${deadlineInfo.className}`}>
          <strong>Deadline:</strong>
          <em>{deadlineInfo.label}</em>
          <small>{deadlineInfo.meta}</small>
        </span>
      </div>
      {renderWorkerStatusStrip()}

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
          {renderWorkerSubmissions()}
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
          {!hasWorkerSubmissionSummary && (task.resultText || (task.resultLinks || []).length > 0 || (task.resultAttachments || []).length > 0) && (
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
          {showInlineApprove && (
            <button
              type="button"
              className="track-btn approve-inline-btn"
              onClick={() => onTaskAction(task, 'approve')}
            >
              {actionLabel('approve')}
            </button>
          )}
          {renderActionMenu()}
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
