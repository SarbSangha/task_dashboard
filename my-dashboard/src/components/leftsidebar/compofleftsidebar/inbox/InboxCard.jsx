import React, { useEffect, useRef, useState } from 'react';
import './InboxCard.css';
import '../../../common/taskCard/TaskCard.css';
import { formatDateTimeIndia } from '../../../../utils/dateTime';
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
  IconAlert,
  IconArrowRight,
  IconCalendar,
  IconChat,
  IconCheckCircle,
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
import { taskAPI } from '../../../../services/api';

const InboxCard = ({ task, isUnread = false, onMarkSeen, onTrackClick, onTaskAction, onOpenChat }) => {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef(null);
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
  const viewerSubmission = workerSubmissionSummary.viewerSubmission || null;
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
    ? 'Every employee must submit'
    : 'Any one employee can submit';
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
    (
      normalizedStatus === 'in_progress'
      || (
        normalizedStatus === 'submitted'
        && (
          Number(viewerSubmission?.submittedByUserId || 0) === Number(task.submittedBy || 0)
          || isCreatorTask
        )
      )
    );
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
      // A self-assigned creator who named a designated approver has handed
      // their own sign-off to that approver - the backend's can_approve
      // agrees and 403s the creator here, so don't infer a button that
      // would just fail (see compute_available_actions in tasks_router.py).
      const creatorSelfApprovalDelegated = isCreatorTask
        && Array.isArray(task.approverIds) && task.approverIds.length > 0
        && assignedPeople.some((person) => Number(person.id) === Number(task.creatorId));
      if (isCreatorTask && canReviewTask && !creatorSelfApprovalDelegated) {
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
  const visibleActions = actions;
  // The next step for this person is promoted to a primary button; the rest
  // stay in the menu. Chat has its own button.
  const primaryAction = ['approve', 'submit', 'start', 'edit_submit'].find((action) => visibleActions.includes(action)) || null;
  const menuActions = visibleActions.filter((action) => action !== primaryAction && action !== 'chat');
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
  const statusTone = getStatusTone(normalizedStatus);
  // Authoritative "require all" roster from the backend
  // (_effective_required_approver_ids) - includes the creator even when
  // they're HOD/admin and so hold no APPROVER participant row, which
  // task.approvers alone would miss.
  const requiredApprovers = Array.isArray(task.requiredApprovers) ? task.requiredApprovers : [];
  const pendingApprovalStatuses = ['submitted', 'under_review', 'approved'];
  const showApprovalProgress = !isWorkflowTask
    && requiredApprovers.length > 1
    && pendingApprovalStatuses.includes(normalizedStatus);
  const approvedApproverNames = requiredApprovers
    .filter((approver) => approver.approved)
    .map((approver) => approver.name);
  const pendingApproverNames = requiredApprovers
    .filter((approver) => !approver.approved)
    .map((approver) => approver.name);
  const statusDisplayLabel = (() => {
    if (!isWorkflowTask && normalizedStatus === 'approved') {
      const pendingApproverName = task.creator?.name || 'Creator';
      if (normalizedWorkflowStage === 'hod_approved' || normalizedWorkflowStage === 'spoc_approved') {
        const reviewerLabel = task.lastApproverName
          || (normalizedWorkflowStage === 'hod_approved' ? 'HOD' : 'SPOC');
        return `${reviewerLabel} approved - final approval pending (${pendingApproverName})`;
      }
    }
    if (showApprovalProgress && approvedApproverNames.length > 0) {
      return `Approved by ${approvedApproverNames.join(', ')} - waiting on ${pendingApproverNames.join(', ')}`;
    }
    return (task.status || '').replace(/_/g, ' ') || '-';
  })();
  const deadlineInfo = getDeadlineInfo(task);
  // Plain status codes ("in_progress") get tidied; composed sentences such as
  // "Approved by X - waiting on Y" keep their own wording.
  const statusText = statusDisplayLabel === (task.status || '').replace(/_/g, ' ')
    ? humanize(task.status)
    : `${statusDisplayLabel.charAt(0).toUpperCase()}${statusDisplayLabel.slice(1)}`;
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

  const renderActionMenu = () => {
    if (menuActions.length === 0) return null;
    return (
      <div className="tc-menu-wrap" ref={menuRef}>
        <button
          type="button"
          className="tc-btn tc-btn--icon tc-btn--ghost"
          onClick={() => setMenuOpen((open) => !open)}
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
                className={action === 'revoke_task' ? 'is-danger' : ''}
                onClick={() => {
                  setMenuOpen(false);
                  onTaskAction(task, action);
                }}
              >
                {humanize(actionLabel(action))}
              </button>
            ))}
          </div>
        )}
      </div>
    );
  };

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
          <strong>Employee Status</strong>
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
                    <h4>{worker.name || 'Unknown employee'}</h4>
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

  const renderWorkerStatusStrip = () => {
    if (!hasWorkerSubmissionSummary) return null;
    return (
      <div className="worker-status-strip">
        <div className="worker-status-strip-head">
          <strong>Employee Status</strong>
          <span>{submissionModeLabel}</span>
        </div>
        <div className="worker-status-chip-list">
          {workerStatusRows.map((worker) => {
            const status = worker.submitted ? 'Submitted' : worker.started ? 'In Progress' : 'Not Started';
            const workerSubmittedAt = worker.submission?.submittedAt;
            return (
              <span
                key={worker.id || worker.name}
                className={`worker-status-chip ${worker.submitted ? 'submitted' : worker.started ? 'progress' : 'pending'}`}
              >
                <b>{worker.name || 'Unknown employee'}</b>
                <span className="worker-status-chip-meta">
                  <em>{status}</em>
                  {worker.submitted && workerSubmittedAt ? (
                    <small>{formatDateTimeIndia(workerSubmittedAt)}</small>
                  ) : null}
                </span>
              </span>
            );
          })}
        </div>
      </div>
    );
  };

  const renderTcLinks = (links = [], prefix) => (
    <ul className="tc-file-list">
      {links.map((link, idx) => (
        <li key={`${prefix}-link-${idx}`} className="tc-file">
          <IconLink size={14} />
          <a className="tc-file-name" href={link} target="_blank" rel="noreferrer" title={link}>{link}</a>
          <span className="tc-file-actions">
            <button
              type="button"
              className="tc-mini"
              onClick={() => copyToClipboard(link, `${prefix}-link-${idx}`)}
              title={copiedKey === `${prefix}-link-${idx}` ? 'Copied' : 'Copy link'}
              aria-label="Copy link"
            >
              <IconCopy size={14} />
            </button>
          </span>
        </li>
      ))}
    </ul>
  );

  const renderTcFiles = (files = [], prefix) => (
    <ul className="tc-file-list">
      {files.map((file, idx) => {
        const label = file?.originalName || file?.filename || `Attachment ${idx + 1}`;
        return (
          <li key={`${prefix}-file-${file?.url || file?.filename || idx}-${idx}`} className="tc-file">
            <IconPaperclip size={14} />
            <span className="tc-file-name" title={label}>{label}</span>
            <span className="tc-file-actions">
              <button type="button" className="tc-mini" onClick={() => setPreviewFile(file)} title="Preview" aria-label={`Preview ${label}`}>
                <IconEye size={15} />
              </button>
              <button type="button" className="tc-mini" onClick={() => forceDownload(file, label)} title="Download" aria-label={`Download ${label}`}>
                <IconDownload size={15} />
              </button>
            </span>
          </li>
        );
      })}
    </ul>
  );

  const taskLinks = Array.isArray(task.links) ? task.links : [];
  const taskAttachments = Array.isArray(task.attachments) ? task.attachments : [];
  const resultLinks = Array.isArray(task.resultLinks) ? task.resultLinks : [];
  const resultAttachments = Array.isArray(task.resultAttachments) ? task.resultAttachments : [];
  const hasSubmittedResult = !hasWorkerSubmissionSummary
    && Boolean(task.resultText || resultLinks.length || resultAttachments.length);
  const forwardHistory = Array.isArray(task.forwardHistory) ? task.forwardHistory : [];
  const seenPeople = Array.isArray(task.seenBy) ? task.seenBy : [];
  const creatorName = task.creator?.name || 'Unknown';
  const detailRows = [
    ['Priority', task.priority ? humanize(task.priority) : ''],
    ['Tag', task.taskTag],
    ['Request type', requestTypeLabel],
    ['Departments', [task.fromDepartment, task.toDepartment].filter(Boolean).join(' → ')],
    ['Stage', isWorkflowTask ? activeStageLabel : humanize(task.workflowStage)],
    ['Customer', task.customerName],
    ['Created', formatDateTimeIndia(task.createdAt)],
    ['Last updated', formatDateTimeIndia(task.updatedAt)],
    ['Deadline', deadlineInfo.full],
    ['Last forwarded by', task.lastForwardedBy],
  ].filter(([, value]) => value && value !== 'N/A' && value !== '-');

  return (
    <article
      className={[
        'tc-card',
        `tone-${statusTone}`,
        isUnread ? 'is-unread' : '',
        isRevoked ? 'is-revoked' : '',
        expanded ? 'is-expanded' : '',
      ].filter(Boolean).join(' ')}
    >
      {isRevoked && (
        <div className="tc-alert tc-alert--revoked" role="note">
          <IconAlert size={14} />
          <span>
            <strong>Revoked</strong>
            {` by ${revokedBy}${revokedAt ? ` on ${revokedAt}` : ''}${revokedReason ? ` — ${revokedReason}` : ''}`}
          </span>
        </div>
      )}
      {isHeld && !isRevoked && (
        <div className="tc-alert tc-alert--held" role="note">
          <IconPause size={14} />
          <span>
            <strong>On hold.</strong>
            {holdUntilLabel ? ` Auto-unholds on ${holdUntilLabel}.` : ' The creator must unhold it before work can continue.'}
            {task.holdInfo?.reason ? ` Reason: ${task.holdInfo.reason}` : ''}
          </span>
        </div>
      )}

      <div className="tc-main">
        <span
          className="tc-avatar"
          style={{ '--tc-avatar-hue': `${getAvatarHue(creatorName)}deg` }}
          title={`From ${creatorName}`}
          aria-hidden="true"
        >
          {getInitials(creatorName)}
        </span>

        <div className="tc-body">
          <div className="tc-title-line">
            {isUnread && <span className="tc-unread-dot" title="Unread" aria-label="Unread" />}
            <button type="button" className="tc-title" onClick={handleToggleExpanded} title={displayTaskName}>
              {displayTaskName}
            </button>
            {requestTypeLabel !== 'Task' && <span className="tc-chip tc-chip--accent">{requestTypeLabel}</span>}
            {isWorkflowTask && activeStageLabel && <span className="tc-chip">{activeStageLabel}</span>}
          </div>
          <div className="tc-sub">
            {displayProjectName !== '-' && (
              <span className="tc-truncate"><IconFolder size={13} /> {displayProjectName}</span>
            )}
            <span className="tc-truncate">
              From <strong>{creatorName}</strong>
              {task.creator?.department ? ` · ${task.creator.department}` : ''}
            </span>
            {task.taskNumber && <span className="tc-ref">{task.taskNumber}</span>}
          </div>
          <div className="tc-meta">
            <span className="tc-truncate" title={`Assigned to ${assignedNames}`}>
              <IconUsers size={13} /> {assignedNames}
            </span>
            {task.createdAt && (
              <span title={formatDateTimeIndia(task.createdAt)}>
                <IconCalendar size={13} /> Created {formatShortDateTime(task.createdAt)}
              </span>
            )}
            {task.submittedAt && (
              <span title={formatDateTimeIndia(task.submittedAt)}>
                <IconCheckCircle size={13} /> Submitted {formatShortDateTime(task.submittedAt)}
              </span>
            )}
          </div>
        </div>

        <div className="tc-side">
          <span className={`tc-status tone-${statusTone}`}>{statusText}</span>
          <div className="tc-side-chips">
            {task.priority && (
              <span className={`tc-priority tc-priority--${getPriorityTone(task.priority)}`}>
                <IconFlag size={12} /> {task.priority}
              </span>
            )}
            <span className={`tc-deadline tc-deadline--${deadlineInfo.tone}`} title={deadlineInfo.full ? `Deadline: ${deadlineInfo.full}` : 'No deadline'}>
              <IconClock size={12} />
              {deadlineInfo.tone === 'none'
                ? 'No deadline'
                : <><b>{deadlineInfo.meta}</b> · {deadlineInfo.label}</>}
            </span>
          </div>
        </div>
      </div>

      {renderWorkerStatusStrip()}

      {expanded && (
        <div className="tc-details">
          <section className="tc-section tc-section--wide">
            <div className="tc-section-head">
              <h4 className="tc-section-title">Brief</h4>
              {description && (
                <button
                  type="button"
                  className="tc-mini"
                  onClick={() => copyToClipboard(description, 'task-details')}
                  title={copiedKey === 'task-details' ? 'Copied' : 'Copy brief'}
                  aria-label="Copy brief"
                >
                  <IconCopy size={14} />
                </button>
              )}
            </div>
            {description ? <p className="tc-text">{description}</p> : <p className="tc-muted">No brief was added to this task.</p>}
            {task.reference && (
              <p className="tc-muted" style={{ marginTop: 8 }}><strong>Reference:</strong> {task.reference}</p>
            )}
          </section>

          <section className="tc-section">
            <div className="tc-section-head"><h4 className="tc-section-title">Details</h4></div>
            <dl className="tc-kv">
              {detailRows.map(([label, value]) => (
                <div key={label}>
                  <dt>{label}</dt>
                  <dd>{value}</dd>
                </div>
              ))}
            </dl>
          </section>

          <section className="tc-section">
            <div className="tc-section-head">
              <h4 className="tc-section-title">Links &amp; files</h4>
            </div>
            {taskLinks.length === 0 && taskAttachments.length === 0 ? (
              <p className="tc-muted">No links or files were shared with this task.</p>
            ) : (
              <>
                {taskLinks.length > 0 && renderTcLinks(taskLinks, 'task')}
                {taskAttachments.length > 0 && (
                  <div style={{ marginTop: taskLinks.length ? 6 : 0 }}>{renderTcFiles(taskAttachments, 'task')}</div>
                )}
              </>
            )}
          </section>

          {hasSubmittedResult && (
            <section className="tc-section tc-section--wide tc-section--result">
              <div className="tc-section-head">
                <h4 className="tc-section-title"><IconCheckCircle size={13} /> Submitted result</h4>
                {task.resultText && (
                  <button
                    type="button"
                    className="tc-mini"
                    onClick={() => copyToClipboard(task.resultText, 'result-text')}
                    title={copiedKey === 'result-text' ? 'Copied' : 'Copy result'}
                    aria-label="Copy result"
                  >
                    <IconCopy size={14} />
                  </button>
                )}
              </div>
              {task.resultText && <p className="tc-text">{task.resultText}</p>}
              {resultLinks.length > 0 && <div style={{ marginTop: 8 }}>{renderTcLinks(resultLinks, 'result')}</div>}
              {resultAttachments.length > 0 && <div style={{ marginTop: 6 }}>{renderTcFiles(resultAttachments, 'result')}</div>}
            </section>
          )}

          {isWorkflowTask && <div className="tc-wide">{renderWorkflowStages()}</div>}
          {hasWorkerSubmissionSummary && <div className="tc-wide">{renderWorkerSubmissions()}</div>}

          {forwardHistory.length > 0 && (
            <section className="tc-section tc-section--wide">
              <div className="tc-section-head"><h4 className="tc-section-title">Forward history</h4></div>
              <ul className="tc-history">
                {forwardHistory.map((entry) => (
                  <li key={entry.id}>
                    <strong>{entry.fromUser}</strong>
                    {entry.fromDepartment ? <small>({entry.fromDepartment})</small> : null}
                    <IconArrowRight size={12} />
                    <strong>{entry.toUser || entry.toDepartment || '-'}</strong>
                    {entry.createdAt ? <small>· {formatDateTimeIndia(entry.createdAt)}</small> : null}
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
      )}

      <div className="tc-footer">
        <span className="tc-seen" title={seenPeople.length ? `Seen by ${seenPeople.map((person) => person.name).join(', ')}` : 'Not seen yet'}>
          {seenPeople.length > 0 ? (
            <>
              <span className="tc-seen-stack" aria-hidden="true">
                {seenPeople.slice(0, 4).map((person) => (
                  <span
                    key={person.id || person.name}
                    className="tc-seen-avatar"
                    style={{ '--tc-avatar-hue': `${getAvatarHue(person.name)}deg` }}
                  >
                    {getInitials(person.name)}
                  </span>
                ))}
              </span>
              <span className="tc-truncate">
                Seen by {seenPeople.slice(0, 2).map((person) => person.name).join(', ')}
                {seenPeople.length > 2 ? ` +${seenPeople.length - 2}` : ''}
              </span>
            </>
          ) : (
            <span>Not seen yet</span>
          )}
        </span>

        <div className="tc-actions">
          {primaryAction && (
            <button type="button" className="tc-btn tc-btn--primary" onClick={() => onTaskAction(task, primaryAction)}>
              {actionLabel(primaryAction)}
            </button>
          )}
          <button type="button" className="tc-btn tc-btn--ghost" onClick={handleToggleExpanded} aria-expanded={expanded}>
            {expanded ? 'Hide details' : 'Details'}
            <IconChevronDown size={14} className="tc-chevron" />
          </button>
          <button type="button" className="tc-btn tc-btn--ghost" onClick={handleTrack}>
            <IconRoute size={14} /> Track
          </button>
          {!isRevoked && (
            <button
              type="button"
              className="tc-btn tc-btn--icon tc-btn--ghost"
              onClick={handleOpenChat}
              title="Open task chat"
              aria-label={`Open task chat${task.chatCount ? `, ${task.chatCount} messages` : ''}`}
            >
              <IconChat size={15} />
              {Number(task.chatCount) > 0 && <span className="tc-count">{task.chatCount > 99 ? '99+' : task.chatCount}</span>}
            </button>
          )}
          {renderActionMenu()}
        </div>
      </div>

      {toastMessage && <div className="tc-toast" role="status">{toastMessage}</div>}
      {previewFile ? (
        <FilePreviewModal
          file={previewFile}
          title={previewFile?.originalName || previewFile?.filename || 'Attachment'}
          subtitle={`${task.title || 'Task'}${task.taskNumber ? ` • ${task.taskNumber}` : ''}`}
          onClose={() => setPreviewFile(null)}
        />
      ) : null}
    </article>
  );
};

export default InboxCard;
