import React, { Fragment, useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import './TaskWorkflow.css';
import { formatDateTimeIndia } from '../../utils/dateTime';
import { buildFileOpenUrl } from '../../utils/fileLinks';
import { taskAPI } from '../../services/api';
import FilePreviewModal from '../common/FilePreviewModal';
import { useMinimizedWindowStack } from '../../hooks/useMinimizedWindowStack';

const WORKFLOW_CACHE_TTL_MS = 30 * 1000;
const workflowDetailCache = new Map();

const getWorkflowCache = (taskId) => {
  const cached = workflowDetailCache.get(taskId);
  if (!cached) return null;
  if (Date.now() - cached.cachedAt > WORKFLOW_CACHE_TTL_MS) return null;
  return cached.data;
};

const setWorkflowCache = (taskId, data) => {
  workflowDetailCache.set(taskId, {
    data,
    cachedAt: Date.now(),
  });
};

const buildLegacyWorkflowSteps = (task) => {
  const status = (task.status || '').toLowerCase();
  const workflowStage = (task.workflowStage || task.workflow_stage || '').toLowerCase();
  const assignedUsers = Array.isArray(task.assignedTo) ? task.assignedTo : [];
  const hasAssignedWorkers = assignedUsers.length > 0;
  const workingStates = new Set(['assigned', 'in_progress']);
  const submittedStates = new Set(['submitted', 'approved', 'completed', 'need_improvement']);
  const approvedStates = new Set(['approved', 'completed']);
  const finalStates = new Set(['completed']);
  const hasWorkStarted = Boolean(task.startedAt);
  const workIsAllocated = workingStates.has(status)
    || workflowStage === 'assigned'
    || workflowStage === 'in_progress'
    || (hasAssignedWorkers && !submittedStates.has(status) && !finalStates.has(status));
  const workingStepStatus = submittedStates.has(status)
    ? 'completed'
    : (workIsAllocated ? 'active' : 'pending');

  let loopCount = Math.max(0, Number(task.resultVersion || 0) - 1);
  if (status === 'need_improvement' && loopCount === 0) {
    loopCount = 1;
  }

  const steps = [
    {
      id: 1,
      keyName: 'created',
      label: 'Task Created',
      type: 'start',
      status: 'completed',
      timestamp: task.createdAt,
      actor: task.creator?.name || 'Creator',
    },
    {
      id: 2,
      keyName: 'working',
      label: 'Received &\nWorking',
      type: 'process',
      status: workingStepStatus,
      timestamp: task.startedAt,
      actor: assignedUsers.map((p) => p.name).join(', ') || 'Assignee',
      meta: {
        hasWorkStarted,
      },
    },
    {
      id: 3,
      keyName: 'submitted',
      label: 'Task Submitted',
      type: 'circle',
      status: submittedStates.has(status) ? (status === 'submitted' ? 'active' : 'completed') : 'pending',
      timestamp: task.submittedAt,
      actor: task.submittedBy ? `User #${task.submittedBy}` : 'Assignee',
    },
    {
      id: 4,
      keyName: 'approval',
      label: 'Waiting for\nCreator Approval',
      type: 'decision',
      status: approvedStates.has(status) ? 'completed' : (status === 'submitted' ? 'active' : (status === 'need_improvement' ? 'returned' : 'pending')),
      timestamp: task.updatedAt,
      actor: task.creator?.name || 'Creator',
    },
    {
      id: 5,
      keyName: 'final',
      label: 'Final Result',
      type: 'end',
      status: finalStates.has(status) ? 'completed' : 'pending',
      timestamp: task.completedAt,
      actor: task.creator?.name || 'Creator',
    }
  ];

  if (loopCount > 0 || status === 'need_improvement') {
    steps.splice(4, 0, {
      id: 90,
      keyName: 'loop',
      label: `Rework Loop\nx${loopCount}`,
      type: 'action',
      status: status === 'need_improvement' ? 'active' : 'completed',
      timestamp: task.updatedAt || task.submittedAt,
      actor: (task.assignedTo || []).map((p) => p.name).join(', ') || 'Assignee',
      loopCount,
    });
  }

  return steps;
};

const mapStageStatusToStepStatus = (status) => {
  switch ((status || '').toLowerCase()) {
    case 'completed':
    case 'approved':
      return 'completed';
    case 'active':
    case 'submitted':
      return 'active';
    case 'revision_requested':
      return 'returned';
    default:
      return 'pending';
  }
};

const buildWorkflowStageSteps = (stages = []) =>
  stages.map((stage) => {
    const assigneeNames = (stage.assignees || []).map((assignee) => assignee.name).join(', ') || 'Unassigned';
    return {
      id: stage.id,
      keyName: `stage-${stage.order}`,
      label: `Stage ${stage.order}\n${stage.title}`,
      type: stage.isFinalStage ? 'end' : (stage.approvalRequired ? 'decision' : 'process'),
      status: mapStageStatusToStepStatus(stage.status),
      timestamp: stage.completedAt || stage.submittedAt || stage.startedAt,
      actor: assigneeNames,
      stageData: stage,
    };
  });

const getStepStatusText = (status) => {
  if (status === 'active') return 'CURRENT';
  if (status === 'returned') return 'REWORK';
  if (status === 'completed') return 'COMPLETED';
  return 'UPCOMING';
};

const TaskWorkflow = ({ task, isOpen, onClose }) => {
  const [workflowSteps, setWorkflowSteps] = useState([]);
  const [loading, setLoading] = useState(true);
  const [workflowError, setWorkflowError] = useState('');
  const [selectedNodeId, setSelectedNodeId] = useState(null);
  const [stageCommentText, setStageCommentText] = useState('');
  const [submittingStageComment, setSubmittingStageComment] = useState(false);
  const [previewFile, setPreviewFile] = useState(null);
  const [isMinimized, setIsMinimized] = useState(false);
  const [isMaximized, setIsMaximized] = useState(false);
  const minimizedWindowStyle = useMinimizedWindowStack('task-workflow-modal', isOpen && isMinimized);

  const applyWorkflowPayload = (response, nextSelectedNodeId = null) => {
    setWorkflowCache(task.id, response);
    setWorkflowSteps(buildWorkflowStageSteps(response.stages || []));
    if (nextSelectedNodeId) {
      setSelectedNodeId(nextSelectedNodeId);
    }
  };

  const loadWorkflowDetail = async ({ preferredStageId = null, showLoader = false } = {}) => {
    if (!task?.workflowEnabled) return;
    if (showLoader) setLoading(true);
    const response = await taskAPI.getWorkflow(task.id);
    applyWorkflowPayload(response, preferredStageId);
    setWorkflowError('');
  };

  useEffect(() => {
    if (!isOpen || !task) return;

    let isCancelled = false;

    const loadWorkflow = async () => {
      setWorkflowError('');

      if (!task.workflowEnabled) {
        setWorkflowSteps(buildLegacyWorkflowSteps(task));
        setLoading(false);
        return;
      }

      const cachedWorkflow = getWorkflowCache(task.id);
      if (cachedWorkflow?.stages) {
        setWorkflowSteps(buildWorkflowStageSteps(cachedWorkflow.stages));
        setLoading(false);
      }

      if (!cachedWorkflow?.stages) {
        setLoading(true);
      }

      try {
        const response = await taskAPI.getWorkflow(task.id);
        if (isCancelled) return;
        applyWorkflowPayload(response);
      } catch (error) {
        if (isCancelled) return;
        if (!cachedWorkflow?.stages) {
          setWorkflowSteps(buildLegacyWorkflowSteps(task));
        }
        setWorkflowError(task.workflowEnabled ? 'Unable to load the live stage workflow right now.' : '');
      } finally {
        if (!isCancelled) {
          setLoading(false);
        }
      }
    };

    void loadWorkflow();

    return () => {
      isCancelled = true;
    };
  }, [isOpen, task]);

  useEffect(() => {
    if (isOpen) {
      setIsMinimized(false);
      setIsMaximized(false);
    }
  }, [isOpen]);

  useEffect(() => {
    if (!workflowSteps.length) {
      setSelectedNodeId(null);
      return;
    }
    if (selectedNodeId && workflowSteps.some((step) => step.id === selectedNodeId)) {
      return;
    }
    const activeStep = workflowSteps.find((step) => step.status === 'active' || step.status === 'returned');
    setSelectedNodeId((activeStep || workflowSteps[0]).id);
  }, [selectedNodeId, workflowSteps]);

  useEffect(() => {
    setStageCommentText('');
  }, [selectedNodeId]);

  useEffect(() => {
    if (!isOpen) return undefined;
    const originalOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = originalOverflow;
    };
  }, [isOpen]);

  if (!isOpen || !task) return null;
  const selectedStep = workflowSteps.find((step) => step.id === selectedNodeId) || null;
  const selectedStage = selectedStep?.stageData || null;

  const getStepInsight = (step) => {
    if (!step) return null;

    const stageData = step.stageData;
    const taskStatus = (task.status || 'pending').toUpperCase();
    const workflowStage = (task.workflowStage || task.workflow_stage || '').toLowerCase();
    const workerNames = stageData
      ? ((stageData.assignees || []).map((person) => person.name).join(', ') || 'Not assigned yet')
      : ((task.assignedTo || []).map((person) => person.name).join(', ') || 'Not assigned yet');
    const hasAssignedWorkers = workerNames !== 'Not assigned yet';
    const isUpcoming = step.status === 'pending';
    const isCurrent = step.status === 'active';
    const loopCount = Math.max(0, Number(task.resultVersion || 0) - 1);
    const isLoopStep = step.keyName === 'loop';
    const legacyWorkingStarted = Boolean(task.startedAt);
    const workAllocated = hasAssignedWorkers
      || workflowStage === 'assigned'
      || workflowStage === 'in_progress';

    const getWorkedBy = () => {
      if (stageData) return workerNames;
      if (step.keyName === 'created') return task.creator?.name || 'Creator';
      if (step.keyName === 'approval') return task.creator?.name || 'Creator';
      if (step.keyName === 'submitted') return task.submittedBy ? `User #${task.submittedBy}` : workerNames;
      if (isLoopStep) return workerNames;
      if (isUpcoming) return 'Not reached yet';
      return step.actor || workerNames;
    };

    const getCurrentOwner = () => {
      if (stageData) {
        if (isUpcoming) return 'Not reached yet';
        if (step.status === 'active' || step.status === 'returned') return workerNames;
        if (stageData.approvalRequired && step.status === 'completed') return task.creator?.name || 'Creator';
        return workerNames;
      }
      if (isUpcoming) return 'N/A';
      if (step.keyName === 'created') return workAllocated ? workerNames : (task.creator?.name || 'Creator');
      if (step.keyName === 'working') return workerNames;
      if (step.keyName === 'submitted') return task.creator?.name || 'Creator';
      if (step.keyName === 'approval') return task.creator?.name || 'Creator';
      if (isLoopStep) return workerNames;
      if (step.keyName === 'final') return task.creator?.name || 'Creator';
      return step.actor || task.creator?.name || workerNames;
    };

    const getStepStartedAt = () => {
      if (stageData) return stageData.startedAt || stageData.submittedAt || stageData.completedAt;
      if (isUpcoming) return null;
      if (step.keyName === 'created') return task.createdAt;
      if (step.keyName === 'working') return legacyWorkingStarted ? task.startedAt : null;
      if (step.keyName === 'submitted') return task.submittedAt || null;
      if (step.keyName === 'approval') return task.submittedAt || null;
      if (isLoopStep) return task.updatedAt || task.submittedAt;
      if (step.keyName === 'final') return task.completedAt || null;
      return step.timestamp || null;
    };

    const getStepEndedAt = () => {
      if (stageData) {
        if (isUpcoming || isCurrent) return null;
        return stageData.completedAt || stageData.approvedAt || stageData.submittedAt;
      }
      if (isUpcoming || isCurrent) return null;
      if (step.keyName === 'created') return task.createdAt;
      if (step.keyName === 'working') return task.submittedAt || null;
      if (step.keyName === 'submitted') return task.completedAt || null;
      if (step.keyName === 'approval') return task.completedAt || null;
      if (isLoopStep) return task.updatedAt;
      if (step.keyName === 'final') return task.completedAt || null;
      return null;
    };

    const details = [
      { label: 'Worked By', value: getWorkedBy() },
      { label: 'Current Owner', value: getCurrentOwner() },
      { label: 'Started', value: formatDateTimeIndia(getStepStartedAt()) || 'N/A' },
      { label: 'Ended', value: formatDateTimeIndia(getStepEndedAt()) || 'N/A' },
      { label: 'Status', value: (step.status || 'pending').toUpperCase() },
      { label: 'Priority', value: (task.priority || 'medium').toUpperCase() },
    ];

    if (!stageData && step.keyName === 'created') {
      details.splice(
        2,
        4,
        { label: 'Created', value: formatDateTimeIndia(task.createdAt) || 'N/A' },
        { label: 'Last Activity', value: formatDateTimeIndia(task.updatedAt) || 'N/A' },
        { label: 'Task Status', value: taskStatus },
        { label: 'Workflow Stage', value: workflowStage ? workflowStage.replace(/_/g, ' ').toUpperCase() : 'NOT STARTED' },
      );
    }

    if (!stageData && step.keyName === 'working' && !legacyWorkingStarted) {
      details[2] = { label: 'Started', value: 'Not started yet' };
      details[3] = { label: 'Ended', value: 'Not submitted yet' };
      details[4] = { label: 'Status', value: workAllocated ? 'ASSIGNED' : taskStatus };
    }

    if (isLoopStep) {
      details.push(
        { label: 'Rework Count', value: `${Math.max(1, loopCount)} time(s)` },
        { label: 'Latest Update', value: formatDateTimeIndia(task.updatedAt) || 'N/A' },
      );
    }

    return {
      title: step.label.split('\n')[0] || step.label,
      subtitle: step.label.split('\n')[1] || step.actor || 'Workflow step',
      statusText: getStepStatusText(step.status),
      details,
    };
  };

  const submitStageComment = async () => {
    const comment = `${stageCommentText || ''}`.trim();
    if (!selectedStage?.id || !comment) return;

    setSubmittingStageComment(true);
    try {
      await taskAPI.addComment(task.id, comment, false, 'general', { stageId: selectedStage.id });
      setStageCommentText('');
      await loadWorkflowDetail({ preferredStageId: selectedStage.id });
    } catch (error) {
      setWorkflowError(error?.response?.data?.detail || 'Unable to add the stage comment right now.');
    } finally {
      setSubmittingStageComment(false);
    }
  };

  const renderWorkflowNode = (step) => {
    const statusClass = step.status === 'active' ? 'current' : (step.status === 'returned' ? 'pending returned' : step.status);
    const [titleLine, detailLine] = step.label.split('\n');
    const stageData = step.stageData;

    const getModuleIcon = () => {
      if (stageData?.order) return `${stageData.order}`;
      if (step.type === 'start') return 'L';
      if (step.type === 'process') return 'i';
      if (step.type === 'decision') return 'Q';
      if (step.type === 'action') return 'AI';
      if (step.type === 'circle') return 'S';
      if (step.type === 'end') return 'OK';
      return 'N';
    };

    const baseProps = {
      className: `workflow-node ${step.type} ${statusClass} ${selectedNodeId === step.id ? 'selected' : ''}`,
      key: step.id
    };

    switch (step.type) {
      case 'start':
      case 'end':
      case 'decision':
      case 'action':
      case 'process':
      case 'circle':
        return (
          <div
            {...baseProps}
            onClick={() => setSelectedNodeId(step.id)}
            role="button"
            tabIndex={0}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                setSelectedNodeId(step.id);
              }
            }}
          >
            <div className="node-content module-card">
              <div className="module-card-head">
                <span className="module-icon" aria-hidden="true">{getModuleIcon()}</span>
                <span className="module-status">{getStepStatusText(step.status)}</span>
              </div>
              <div className="module-card-body">
                <h4>{titleLine || step.label}</h4>
                <p>{detailLine || step.actor || 'Workflow Step'}</p>
              </div>
            </div>
          </div>
        );

      case 'rejected':
        return (
          <div {...baseProps}>
            <div className="node-content denied">
              <span className="denied-icon">⚠️</span>
              <span>{step.label}</span>
            </div>
          </div>
        );

      default:
        return null;
    }
  };

  const renderConnector = (id, status) => {
    const isActive = status === 'completed' || status === 'active';
    return (
      <div className={`workflow-connector ${isActive ? 'active' : ''}`} key={`connector-${id}`} aria-hidden="true">
        <div className="connector-line">
          {isActive && <span className="connector-dot"></span>}
        </div>
      </div>
    );
  };

  const renderLegacyDetailPanel = () => {
    if (!selectedStep || selectedStage) return null;
    const stepInsight = getStepInsight(selectedStep);
    if (!stepInsight) return null;

    return (
      <div className="workflow-legacy-detail">
        <div className="workflow-legacy-detail-header">
          <div>
            <span className="workflow-stage-detail-badge">Simple task flow</span>
            <h3>{stepInsight.title}</h3>
            <p>{stepInsight.subtitle}</p>
          </div>
          <span className="workflow-stage-detail-pill status">{stepInsight.statusText}</span>
        </div>
        <div className="workflow-legacy-detail-grid">
          {stepInsight.details.map((detail) => (
            <div key={`${selectedStep.id}-${detail.label}`} className="workflow-legacy-detail-item">
              <span>{detail.label}</span>
              <strong>{detail.value}</strong>
            </div>
          ))}
        </div>
      </div>
    );
  };

  const handleToggleMinimize = () => {
    if (isMinimized) {
      setIsMinimized(false);
      return;
    }

    setIsMaximized(false);
    setIsMinimized(true);
  };

  const handleToggleMaximize = () => {
    if (isMinimized) {
      setIsMinimized(false);
      setIsMaximized(true);
      return;
    }

    setIsMaximized((prev) => !prev);
  };

  const dynamicModalStyle = (() => {
    if (isMinimized) return undefined;

    const stepCount = Math.max(1, workflowSteps.length);
    const baseTrackWidth = (stepCount * 220) + (Math.max(0, stepCount - 1) * 82) + 120;
    const baseWidth = Math.min(1760, Math.max(task.workflowEnabled ? 1100 : 1380, baseTrackWidth));
    const modalWidth = isMaximized ? '100vw' : `min(98vw, ${baseWidth}px)`;
    const modalHeight = isMaximized
      ? '100vh'
      : `min(96vh, ${Math.min(1040, Math.max(900, 800 + workflowSteps.length * 28))}px)`;

    const nodeScale = isMaximized ? 1.24 : baseWidth >= 1500 ? 1.12 : 1.02;
    const connectorWidth = isMaximized ? 106 : baseWidth >= 1500 ? 92 : 82;

    return {
      '--workflow-modal-width': modalWidth,
      '--workflow-modal-height': modalHeight,
      '--workflow-node-scale': nodeScale,
      '--workflow-connector-width': `${connectorWidth}px`
    };
  })();

  const renderStageDetailPanel = () => {
    if (!selectedStage) return null;

    const attachments = Array.isArray(selectedStage.currentSubmission?.attachments)
      ? selectedStage.currentSubmission.attachments
      : [];
    const links = Array.isArray(selectedStage.currentSubmission?.links)
      ? selectedStage.currentSubmission.links
      : [];
    const comments = Array.isArray(selectedStage.comments) ? selectedStage.comments : [];
    const eventLog = Array.isArray(selectedStage.eventLog) ? selectedStage.eventLog : [];
    const assigneeNames = (selectedStage.assignees || []).map((assignee) => assignee.name).join(', ') || 'Unassigned';
    const stageStatusLabel = (selectedStage.status || 'pending').replace(/_/g, ' ');
    const latestActivityAt = selectedStage.completedAt
      || selectedStage.submittedAt
      || selectedStage.startedAt
      || selectedStage.updatedAt;
    const overviewItems = [
      { label: 'Owners', value: assigneeNames },
      { label: 'Handoff', value: selectedStage.approvalRequired ? 'Approval required' : 'Auto handoff' },
      {
        label: 'Submission version',
        value: selectedStage.currentSubmission?.version ? `v${selectedStage.currentSubmission.version}` : 'No submission yet',
      },
      { label: 'Last activity', value: formatDateTimeIndia(latestActivityAt) || 'No activity yet' },
    ];

    return (
      <div className="workflow-stage-detail">
        <div className="workflow-stage-detail-header">
          <div className="workflow-stage-detail-header-copy">
            <span className="workflow-stage-detail-badge">Stage {selectedStage.order}</span>
            <h3>{selectedStage.title}</h3>
            <p>{selectedStage.description || 'No stage instructions added yet.'}</p>
          </div>
          <div className="workflow-stage-detail-meta">
            <span className="workflow-stage-detail-pill">{selectedStage.approvalRequired ? 'Approval required' : 'Auto handoff'}</span>
            <span className="workflow-stage-detail-pill status">Status: {stageStatusLabel}</span>
          </div>
        </div>

        <div className="workflow-stage-overview">
          {overviewItems.map((item) => (
            <div key={item.label} className="workflow-stage-overview-item">
              <span>{item.label}</span>
              <strong>{item.value}</strong>
            </div>
          ))}
        </div>

        <div className="workflow-stage-detail-grid">
          <div className="workflow-stage-detail-card">
            <h4>Owners</h4>
            <p>{assigneeNames}</p>
            <div className="workflow-stage-stat-list">
              <span>Started: {formatDateTimeIndia(selectedStage.startedAt) || 'Not started yet'}</span>
              <span>Submitted: {formatDateTimeIndia(selectedStage.submittedAt) || 'Not submitted yet'}</span>
              <span>Completed: {formatDateTimeIndia(selectedStage.completedAt) || 'Not completed yet'}</span>
            </div>
          </div>

          <div className="workflow-stage-detail-card">
            <h4>Latest Output</h4>
            <p>{selectedStage.currentSubmission?.outputText || 'No output submitted yet.'}</p>
            <div className="workflow-stage-stat-list">
              <span>Version: {selectedStage.currentSubmission?.version ? `v${selectedStage.currentSubmission.version}` : '-'}</span>
              <span>Submitted By: {selectedStage.currentSubmission?.submittedByName || '-'}</span>
            </div>
          </div>

          <div className="workflow-stage-detail-card">
            <h4>Links</h4>
            {links.length > 0 ? (
              <div className="workflow-stage-link-list">
                {links.map((link, index) => (
                  <a key={`${link}-${index}`} href={link} target="_blank" rel="noreferrer">
                    {link}
                  </a>
                ))}
              </div>
            ) : (
              <p className="workflow-empty-state">No links submitted for this stage.</p>
            )}
          </div>

          <div className="workflow-stage-detail-card">
            <h4>Files</h4>
            {attachments.length > 0 ? (
              <div className="workflow-stage-link-list">
                {attachments.map((file, index) => {
                  const label = file?.originalName || file?.filename || `Attachment ${index + 1}`;
                  const openUrl = buildFileOpenUrl(file);
                  return openUrl ? (
                    <button
                      key={`${label}-${index}`}
                      type="button"
                      className="workflow-stage-file-link"
                      title={`Preview ${label}`}
                      onClick={() => setPreviewFile(file)}
                    >
                      <span>{label}</span>
                      <strong>Open</strong>
                    </button>
                  ) : (
                    <span key={`${label}-${index}`} className="workflow-stage-file-link disabled">
                      <span>{label}</span>
                      <strong>Unavailable</strong>
                    </span>
                  );
                })}
              </div>
            ) : (
              <p className="workflow-empty-state">No files submitted for this stage.</p>
            )}
          </div>
        </div>

        <div className="workflow-stage-detail-split">
          <div className="workflow-stage-detail-card tall">
            <h4>Stage Comments</h4>
            <div className="workflow-stage-comment-composer">
              <textarea
                value={stageCommentText}
                onChange={(event) => setStageCommentText(event.target.value)}
                placeholder="Add a note for this stage..."
                rows={3}
              />
              <button
                type="button"
                onClick={submitStageComment}
                disabled={submittingStageComment || !stageCommentText.trim()}
              >
                {submittingStageComment ? 'Posting...' : 'Add Comment'}
              </button>
            </div>
            {comments.length > 0 ? (
              <div className="workflow-stage-comment-list">
                {comments.map((comment) => (
                  <div key={comment.id} className="workflow-stage-comment-item">
                    <div className="workflow-stage-comment-head">
                      <strong>{comment.user?.name || 'Unknown'}</strong>
                      <span>{formatDateTimeIndia(comment.createdAt) || '-'}</span>
                    </div>
                    <p>{comment.comment}</p>
                    <small>{(comment.commentType || 'general').replace(/_/g, ' ')}</small>
                  </div>
                ))}
              </div>
            ) : (
              <p className="workflow-empty-state">No stage comments yet.</p>
            )}
          </div>

          <div className="workflow-stage-detail-card tall">
            <h4>Stage History</h4>
            {eventLog.length > 0 ? (
              <div className="workflow-stage-history-list">
                {eventLog.map((event) => (
                  <div key={event.id} className="workflow-stage-history-item">
                    <div className="workflow-stage-comment-head">
                      <strong>{event.label || event.action}</strong>
                      <span>{formatDateTimeIndia(event.timestamp) || '-'}</span>
                    </div>
                    {event.user?.name ? (
                      <small>{event.user.name}{event.user.department ? ` • ${event.user.department}` : ''}</small>
                    ) : null}
                    {event.comments ? <p>{event.comments}</p> : null}
                  </div>
                ))}
              </div>
            ) : (
              <p className="workflow-empty-state">No stage events recorded yet.</p>
            )}
          </div>
        </div>
      </div>
    );
  };

  const modalContent = (
    <>
      {/* Overlay - Disabled when minimized */}
      <div 
        className={`workflow-overlay ${isMinimized ? 'disabled' : ''}`} 
        onClick={!isMinimized ? onClose : null} 
      />

      {/* Workflow Modal */}
      <div
        className={`workflow-modal ${isMinimized ? 'minimized' : ''} ${isMaximized ? 'maximized' : ''}`}
        style={isMinimized ? (minimizedWindowStyle || undefined) : dynamicModalStyle}
      >
        {/* Header */}
        <div
          className="workflow-modal-header"
          onClick={isMinimized ? () => setIsMinimized(false) : undefined}
        >
          <div className="workflow-title-section">
            <h2 className="workflow-title">Task Workflow Path</h2>
            {!isMinimized && (
              <>
                <p className="workflow-task-name">{task.title}</p>
                <span className="workflow-task-id">{task.taskNumber}</span>
              </>
            )}
          </div>
          
          {/* Control Buttons */}
          <div className="workflow-controls">
            {!isMinimized && (
              <button
                className="workflow-control-btn minimize-btn"
                onClick={(event) => {
                  event.stopPropagation();
                  handleToggleMinimize();
                }}
                title="Minimize"
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <line x1="5" y1="12" x2="19" y2="12" />
                </svg>
              </button>
            )}

            <button
              className="workflow-control-btn maximize-btn"
              onClick={(event) => {
                event.stopPropagation();
                handleToggleMaximize();
              }}
              title={isMinimized ? 'Restore' : isMaximized ? 'Restore Window' : 'Maximize'}
            >
              {isMinimized ? (
                '▢'
              ) : (
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  {isMaximized ? (
                    <path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3" />
                  ) : (
                    <rect x="3" y="3" width="18" height="18" rx="2" />
                  )}
                </svg>
              )}
            </button>

            <button
              className="workflow-close-btn"
              onClick={(event) => {
                event.stopPropagation();
                onClose();
              }}
            >
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </div>
        </div>

        {/* Content */}
        {!isMinimized && (
          <div className="workflow-modal-content">
            {loading ? (
              <div className="workflow-loading">Loading workflow...</div>
            ) : (
              <>
                {workflowError && (
                  <div className="workflow-inline-warning">{workflowError}</div>
                )}
                <div className={`workflow-horizontal ${task.workflowEnabled ? 'stage-flow' : 'simple-flow'}`}>
                  <div className="workflow-section-heading">
                    <div>
                      <span className="workflow-section-kicker">Workflow map</span>
                      <h3>Stage progression</h3>
                      <p>
                        {task.workflowEnabled
                          ? 'Select a stage card to review output, files, comments, and history.'
                          : 'Select a workflow step to review owners, dates, status, and progress details.'}
                      </p>
                    </div>
                  </div>
                  <div className={`workflow-track ${task.workflowEnabled ? 'stage-track' : 'legacy-track'}`}>
                    {workflowSteps.map((step, index, arr) => (
                      <Fragment key={step.id}>
                        {renderWorkflowNode(step)}
                        {index < arr.length - 1 && renderConnector(step.id, step.status)}
                      </Fragment>
                    ))}
                  </div>
                </div>

                {task.workflowEnabled && renderStageDetailPanel()}
                {!task.workflowEnabled && renderLegacyDetailPanel()}

                {/* Footer summary intentionally hidden to keep focus on workflow boxes */}
              </>
            )}
          </div>
        )}
      </div>
      {previewFile ? (
        <FilePreviewModal
          file={previewFile}
          title={previewFile?.originalName || previewFile?.filename || 'Attachment'}
          subtitle={`${task?.title || 'Task'}${task?.taskNumber ? ` • ${task.taskNumber}` : ''}`}
          onClose={() => setPreviewFile(null)}
        />
      ) : null}
    </>
  );

  return createPortal(modalContent, document.body);
};

export default TaskWorkflow;
