import React, { Fragment, useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import './TaskWorkflow.css';
import { formatDateTimeIndia } from '../../utils/dateTime';

const TaskWorkflow = ({ task, isOpen, onClose }) => {
  const [workflowSteps, setWorkflowSteps] = useState([]);
  const [loading, setLoading] = useState(true);
  const [isMinimized, setIsMinimized] = useState(false);
  const [isMaximized, setIsMaximized] = useState(false);

  useEffect(() => {
    if (isOpen && task) {
      generateWorkflowSteps(task);
    }
  }, [isOpen, task]);

  useEffect(() => {
    if (isOpen) {
      setIsMinimized(false);
      setIsMaximized(false);
    }
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return undefined;
    const originalOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = originalOverflow;
    };
  }, [isOpen]);

  const generateWorkflowSteps = (task) => {
    setLoading(true);

    const status = (task.status || '').toLowerCase();
    const workingStates = new Set(['assigned', 'in_progress']);
    const submittedStates = new Set(['submitted', 'approved', 'completed', 'need_improvement']);
    const approvedStates = new Set(['approved', 'completed']);
    const finalStates = new Set(['completed']);

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
        status: submittedStates.has(status) ? 'completed' : (workingStates.has(status) ? 'active' : 'pending'),
        timestamp: task.startedAt,
        actor: (task.assignedTo || []).map((p) => p.name).join(', ') || 'Assignee',
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

    setWorkflowSteps(steps);
    setLoading(false);
  };

  if (!isOpen || !task) return null;

  const getStatusBadgeStyle = (status) => {
    if (status === 'rejected') return { background: '#fee2e2', color: '#991b1b' };
    if (status === 'completed') return { background: '#dcfce7', color: '#166534' };
    if (status === 'active') return { background: '#dbeafe', color: '#1e40af' };
    return { background: '#f3f4f6', color: '#6b7280' };
  };

  const renderWorkflowNode = (step, index) => {
    const statusClass = step.status === 'active' ? 'current' : (step.status === 'returned' ? 'pending returned' : step.status);
    const [titleLine, detailLine] = step.label.split('\n');

    const getModuleIcon = () => {
      if (step.type === 'start') return 'L';
      if (step.type === 'process') return 'i';
      if (step.type === 'decision') return 'Q';
      if (step.type === 'action') return 'AI';
      if (step.type === 'circle') return 'S';
      if (step.type === 'end') return 'OK';
      return 'N';
    };

    const getStatusText = () => {
      if (step.status === 'active') return 'CURRENT';
      if (step.status === 'returned') return 'REWORK';
      if (step.status === 'completed') return 'COMPLETED';
      return 'UPCOMING';
    };

    const baseProps = {
      className: `workflow-node ${step.type} ${statusClass}`,
      key: step.id
    };

    const formatDateTime = (value) => {
      return formatDateTimeIndia(value);
    };

    const workerNames = (task.assignedTo || []).map((p) => p.name).join(', ') || 'Not assigned yet';
    const isUpcoming = step.status === 'pending';
    const isCurrent = step.status === 'active';
    const isCompleted = step.status === 'completed';
    const loopCount = Math.max(0, Number(task.resultVersion || 0) - 1);
    const isLoopStep = step.keyName === 'loop';

    const getWorkedBy = () => {
      if (step.keyName === 'created') return task.creator?.name || 'Creator';
      if (step.keyName === 'approval') return task.creator?.name || 'Creator';
      if (step.keyName === 'submitted') return task.submittedBy ? `User #${task.submittedBy}` : workerNames;
      if (isLoopStep) return workerNames;
      if (isUpcoming) return 'Not reached yet';
      return step.actor || workerNames;
    };

    const getCurrentOwner = () => {
      if (isUpcoming) return 'N/A';
      if (step.keyName === 'created') return task.creator?.name || 'Creator';
      if (step.keyName === 'working') return workerNames;
      if (step.keyName === 'submitted') return task.creator?.name || 'Creator';
      if (step.keyName === 'approval') return task.creator?.name || 'Creator';
      if (isLoopStep) return workerNames;
      if (step.keyName === 'final') return task.creator?.name || 'Creator';
      return step.actor || task.creator?.name || workerNames;
    };

    const getStepStartedAt = () => {
      if (isUpcoming) return null;
      if (step.keyName === 'created') return task.createdAt;
      if (step.keyName === 'working') return task.startedAt || task.createdAt;
      if (step.keyName === 'submitted') return task.submittedAt || task.updatedAt;
      if (step.keyName === 'approval') return task.submittedAt || task.updatedAt;
      if (isLoopStep) return task.updatedAt || task.submittedAt;
      if (step.keyName === 'final') return task.completedAt || task.updatedAt;
      return step.timestamp || task.updatedAt || task.createdAt;
    };

    const getStepEndedAt = () => {
      if (isUpcoming || isCurrent) return null;
      if (step.keyName === 'created') return task.createdAt;
      if (step.keyName === 'working') return task.submittedAt || task.updatedAt;
      if (step.keyName === 'submitted') return task.updatedAt || task.submittedAt;
      if (step.keyName === 'approval') return task.updatedAt;
      if (isLoopStep) return task.updatedAt;
      if (step.keyName === 'final') return task.completedAt || task.updatedAt;
      return task.updatedAt || task.completedAt;
    };

    const stepDetails = [
      { label: 'Worked By', value: getWorkedBy() },
      { label: 'Current Owner', value: getCurrentOwner() },
      { label: 'Started', value: formatDateTime(getStepStartedAt()) },
      { label: 'Ended', value: formatDateTime(getStepEndedAt()) },
      { label: 'Status', value: (step.status || 'pending').toUpperCase() },
      { label: 'Priority', value: (task.priority || 'medium').toUpperCase() }
    ];
    if (isLoopStep) {
      stepDetails.push(
        { label: 'Need Improvement Loops', value: `${Math.max(1, loopCount)} time(s)` },
        { label: 'Latest Update', value: formatDateTime(task.updatedAt) },
      );
    }

    switch (step.type) {
      case 'start':
      case 'end':
      case 'decision':
      case 'action':
      case 'process':
      case 'circle':
        return (
          <div {...baseProps}>
            <div className="node-content module-card">
              <div className="module-card-head">
                <span className="module-icon" aria-hidden="true">{getModuleIcon()}</span>
                <span className="module-status">{getStatusText()}</span>
              </div>
              <div className="module-card-body">
                <h4>{titleLine || step.label}</h4>
                <p>{detailLine || step.actor || 'Workflow Step'}</p>
              </div>
            </div>
            <div className="workflow-hover-card">
              <h5>{titleLine || step.label}</h5>
              {stepDetails.map((detail) => (
                <div className="workflow-hover-row" key={`${step.id}-${detail.label}`}>
                  <span>{detail.label}</span>
                  <strong>{detail.value}</strong>
                </div>
              ))}
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

    const baseWidth = Math.min(1700, Math.max(1000, workflowSteps.length * 150));
    const modalWidth = isMaximized ? '100vw' : `min(98vw, ${baseWidth}px)`;
    const modalHeight = isMaximized
      ? '100vh'
      : `min(96vh, ${Math.min(980, Math.max(840, 760 + workflowSteps.length * 20))}px)`;

    const nodeScale = isMaximized ? 1.24 : baseWidth >= 1500 ? 1.12 : 1.02;
    const connectorWidth = isMaximized ? 106 : baseWidth >= 1500 ? 92 : 82;

    return {
      '--workflow-modal-width': modalWidth,
      '--workflow-modal-height': modalHeight,
      '--workflow-node-scale': nodeScale,
      '--workflow-connector-width': `${connectorWidth}px`
    };
  })();

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
        style={dynamicModalStyle}
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
            {/* Minimize Button */}
            <button
              className="workflow-control-btn minimize-btn"
              onClick={(event) => {
                event.stopPropagation();
                handleToggleMinimize();
              }}
              title={isMinimized ? 'Restore' : 'Minimize'}
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                {isMinimized ? (
                  <polyline points="8 18 16 18 16 6 8 6" />
                ) : (
                  <line x1="5" y1="12" x2="19" y2="12" />
                )}
              </svg>
            </button>

            {/* Maximize Button */}
            <button
              className="workflow-control-btn maximize-btn"
              onClick={(event) => {
                event.stopPropagation();
                handleToggleMaximize();
              }}
              title={isMaximized ? 'Restore Window' : 'Maximize'}
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                {isMaximized ? (
                  <path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3" />
                ) : (
                  <rect x="3" y="3" width="18" height="18" rx="2" />
                )}
              </svg>
            </button>

            {/* Close Button */}
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
                {/* Horizontal Workflow */}
                <div className="workflow-horizontal">
                  <div className="workflow-track">
                    {workflowSteps.map((step, index, arr) => (
                      <Fragment key={step.id}>
                        {renderWorkflowNode(step, index)}
                        {index < arr.length - 1 && renderConnector(step.id, step.status)}
                      </Fragment>
                    ))}
                  </div>
                </div>

                {/* Footer summary intentionally hidden to keep focus on workflow boxes */}
              </>
            )}
          </div>
        )}
      </div>
    </>
  );

  return createPortal(modalContent, document.body);
};

export default TaskWorkflow;
