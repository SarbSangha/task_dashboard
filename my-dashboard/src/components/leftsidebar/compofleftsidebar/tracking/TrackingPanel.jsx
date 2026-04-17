import React, { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import TaskWorkflow from '../../../taskWorkflow/TaskWorkflow';
import { taskAPI } from '../../../../services/api';
import TaskChatPanel from '../messagesystem/TaskChatPanel';
import SubmitSection from '../inbox/SubmitSection';
import { useCustomDialogs } from '../../../common/CustomDialogs';
import { useMinimizedWindowStack } from '../../../../hooks/useMinimizedWindowStack';
import { useTracking } from '../../../../hooks/useTracking';
import { useUpdateTaskStatus } from '../../../../hooks/useTaskActions';
import { TrackingPanelSkeleton } from '../../../ui/TrackingPanelSkeleton';
import './TrackingPanel.css';

const isWorkflowTask = (task) => Boolean(task?.workflowEnabled);
const getActiveStageLabel = (task) => {
  if (!isWorkflowTask(task)) return '';
  const order = Number(task?.currentStageOrder || 0);
  const title = `${task?.currentStageTitle || ''}`.trim();
  if (order && title) return `Stage ${order}: ${title}`;
  if (order) return `Stage ${order}`;
  return title;
};

const getActionLabel = (task, action) => {
  if (action === 'approve') return isWorkflowTask(task) ? 'approve stage' : 'approve';
  if (action === 'need_improvement') return isWorkflowTask(task) ? 'request revision' : 'need improvement';
  if (action === 'submit') return isWorkflowTask(task) ? 'submit stage' : 'submit';
  if (action === 'start') return isWorkflowTask(task) ? 'start stage' : 'start task';
  if (action === 'revoke_task') return 'revoke task';
  return action.replace(/_/g, ' ');
};

const TRACKING_FILTERS = [
  {
    key: 'all',
    label: 'All Tasks',
    matches: () => true,
  },
  {
    key: 'active',
    label: 'Active',
    matches: (task) => ['pending', 'assigned', 'forwarded', 'in_progress'].includes(task?.status),
  },
  {
    key: 'submitted',
    label: 'Waiting Review',
    matches: (task) => ['submitted', 'under_review', 'approved'].includes(task?.status),
  },
  {
    key: 'revision',
    label: 'Revisions',
    matches: (task) => task?.status === 'need_improvement',
  },
  {
    key: 'completed',
    label: 'Completed',
    matches: (task) => ['completed', 'cancelled', 'rejected'].includes(task?.status),
  },
];

const TrackingPanel = ({ isOpen, onClose, onMinimizedChange, onActivate }) => {
  const queryClient = useQueryClient();
  const { showAlert, showConfirm, showPrompt } = useCustomDialogs();
  const [selectedTask, setSelectedTask] = useState(null);
  const [workflowOpen, setWorkflowOpen] = useState(false);
  const [filter, setFilter] = useState('all');
  const [isMinimized, setIsMinimized] = useState(false);
  const [isMaximized, setIsMaximized] = useState(false);
  const [openActionMenuId, setOpenActionMenuId] = useState(null);
  const [chatTask, setChatTask] = useState(null);
  const [submitTask, setSubmitTask] = useState(null);
  const minimizedWindowStyle = useMinimizedWindowStack('tracking-panel', isOpen && isMinimized);
  const [selectionModal, setSelectionModal] = useState({
    open: false,
    mode: 'forward',
    task: null,
    targets: [],
    departments: [],
    selectedDepartment: '',
    selectedUserIds: [],
    comments: '',
    loading: false,
    submitting: false,
    error: '',
  });

  const {
    data: trackingData,
    isLoading: loading,
    isFetching,
    error,
    refetch,
  } = useTracking({}, { enabled: isOpen });

  React.useEffect(() => {
    onMinimizedChange?.(isOpen && isMinimized);
  }, [isMinimized, isOpen, onMinimizedChange]);

  const tasks = trackingData?.tasks || [];
  const isRefreshing = isFetching && !loading;
  const trackingError = error?.response?.data?.detail || error?.message || '';

  const invalidateTrackingCaches = () => {
    queryClient.invalidateQueries({ queryKey: ['tracking'] });
    queryClient.invalidateQueries({ queryKey: ['inbox'] });
    queryClient.invalidateQueries({ queryKey: ['outbox'] });
  };

  const { mutateAsync: updateTaskStatus } = useUpdateTaskStatus({
    onOptimisticUpdate: ({ taskId, status }) => {
      const optimisticPatch = {
        status,
        updatedAt: new Date().toISOString(),
      };
      const snapshot = {
        selectedTask,
        chatTask,
      };

      setSelectedTask((prev) => (prev?.id === taskId ? { ...prev, ...optimisticPatch } : prev));
      setChatTask((prev) => (prev?.id === taskId ? { ...prev, ...optimisticPatch } : prev));

      return snapshot;
    },
    onRollback: (snapshot) => {
      if (!snapshot) return;
      setSelectedTask(snapshot.selectedTask || null);
      setChatTask(snapshot.chatTask || null);
    },
    onSettled: async () => {
      invalidateTrackingCaches();
      await refetch();
    },
  });

  const getStatusColor = (status) => {
    const colors = {
      draft: '#9ca3af',
      pending: '#fbbf24',
      in_progress: '#3b82f6',
      submitted: '#8b5cf6',
      under_review: '#06b6d4',
      approved: '#22c55e',
      need_improvement: '#ef4444',
      rejected: '#ef4444',
      completed: '#10b981',
      cancelled: '#6b7280'
    };
    return colors[status] || '#d1d5db';
  };

  const filteredTasks = tasks.filter((task) => {
    const activeFilter = TRACKING_FILTERS.find((entry) => entry.key === filter) || TRACKING_FILTERS[0];
    return activeFilter.matches(task);
  });

  const handleSubmitComplete = async () => {
    setSubmitTask(null);
    invalidateTrackingCaches();
    await refetch();
  };

  const handleTrackClick = (task) => {
    setSelectedTask(task);
    setWorkflowOpen(true);
  };

  const openSelectionModal = async (task, mode) => {
    setSelectionModal({
      open: true,
      mode,
      task,
      targets: [],
      departments: [],
      selectedDepartment: '',
      selectedUserIds: [],
      comments: '',
      loading: true,
      submitting: false,
      error: '',
    });
    try {
      const response = await taskAPI.getForwardTargets(task.id);
      const targets = response?.users || [];
      const departments = Array.from(
        new Set(targets.map((user) => (user.department || '').trim()).filter(Boolean))
      ).sort((a, b) => a.localeCompare(b));
      setSelectionModal((prev) => ({
        ...prev,
        targets,
        departments,
        selectedDepartment: departments[0] || '',
        loading: false,
      }));
    } catch (error) {
      setSelectionModal((prev) => ({
        ...prev,
        loading: false,
        error: error?.response?.data?.detail || 'Failed to load departments/users',
      }));
    }
  };

  const closeSelectionModal = () => {
    setSelectionModal({
      open: false,
      mode: 'forward',
      task: null,
      targets: [],
      departments: [],
      selectedDepartment: '',
      selectedUserIds: [],
      comments: '',
      loading: false,
      submitting: false,
      error: '',
    });
  };

  const toggleSelectionUser = (userId) => {
    setSelectionModal((prev) => ({
      ...prev,
      selectedUserIds: prev.selectedUserIds.includes(userId)
        ? prev.selectedUserIds.filter((id) => id !== userId)
        : [...prev.selectedUserIds, userId],
    }));
  };

  const submitSelectionModal = async () => {
    if (!selectionModal.task) return;
    if (selectionModal.selectedUserIds.length === 0) {
      setSelectionModal((prev) => ({ ...prev, error: 'Select at least one member.' }));
      return;
    }

    setSelectionModal((prev) => ({ ...prev, submitting: true, error: '' }));
    try {
      const comments = (selectionModal.comments || '').trim();
      if (selectionModal.mode === 'forward') {
        await taskAPI.forwardTask(selectionModal.task.id, {
          to_department: selectionModal.selectedDepartment || undefined,
          to_user_ids: selectionModal.selectedUserIds,
          comments,
        });
      } else {
        await taskAPI.assignTaskMembers(
          selectionModal.task.id,
          selectionModal.selectedUserIds,
          comments || 'Assigned from tracking panel'
        );
      }

      closeSelectionModal();
      invalidateTrackingCaches();
      await refetch();
    } catch (error) {
      setSelectionModal((prev) => ({
        ...prev,
        submitting: false,
        error: error?.response?.data?.detail || 'Action failed',
      }));
    }
  };

  const runTaskAction = async (task, action) => {
    try {
      if (action === 'chat') {
        setChatTask(task);
        setOpenActionMenuId(null);
        return;
      }
      if (action === 'approve') {
        const stageLabel = getActiveStageLabel(task);
        const comments = (await showPrompt('Approval comment (optional):', {
          title: stageLabel ? `Approve ${stageLabel}` : 'Approve Task',
          defaultValue: '',
        })) ?? '';
        await updateTaskStatus({
          taskId: task.id,
          status: 'approved',
          execute: () =>
            (isWorkflowTask(task) && task.currentStageId
              ? taskAPI.approveStage(task.id, task.currentStageId, comments)
              : taskAPI.approveTask(task.id, comments)),
        });
      } else if (action === 'start') {
        const confirmed = await showConfirm(
          isWorkflowTask(task) ? 'Start this workflow stage?' : 'Start working on this task?',
          { title: isWorkflowTask(task) ? 'Start Stage' : 'Start Task' }
        );
        if (!confirmed) return;
        await updateTaskStatus({
          taskId: task.id,
          status: 'in_progress',
          execute: () => taskAPI.startTask(task.id),
        });
      } else if (action === 'need_improvement') {
        const stageLabel = getActiveStageLabel(task);
        const comments = (await showPrompt('Need Improvement note:', {
          title: stageLabel ? `Request Revision For ${stageLabel}` : 'Need Improvement',
          defaultValue: '',
          multiline: true,
          rows: 6,
          placeholder: 'Describe what needs to be improved...',
        })) ?? '';
        if (!comments) return;
        await updateTaskStatus({
          taskId: task.id,
          status: 'need_improvement',
          execute: () =>
            (isWorkflowTask(task) && task.currentStageId
              ? taskAPI.requestStageImprovement(task.id, task.currentStageId, comments)
              : taskAPI.needImprovement(task.id, comments)),
        });
      } else if (action === 'submit') {
        setSubmitTask(task);
        return;
      } else if (action === 'assign') {
        await openSelectionModal(task, 'assign');
        return;
      } else if (action === 'forward') {
        await openSelectionModal(task, 'forward');
        return;
      } else if (action === 'edit_task') {
        const description = (await showPrompt('Update task description:', {
          title: 'Edit Task',
          defaultValue: task.description || '',
        })) ?? '';
        if (!description) return;
        await taskAPI.editTask(task.id, { description });
      } else if (action === 'edit_result') {
        const result = (await showPrompt('Update result text:', {
          title: 'Edit Result',
          defaultValue: task.resultText || '',
        })) ?? '';
        if (!result) return;
        await taskAPI.editResult(task.id, result);
      } else if (action === 'revoke_task') {
        const confirmed = await showConfirm(
          'Revoke this task? This will mark it as revoked for receivers.',
          { title: 'Revoke Task' }
        );
        if (!confirmed) return;
        const comments = (await showPrompt('Optional reason for revoking this task:', {
          title: 'Revoke Reason',
          defaultValue: '',
        })) ?? '';
        await taskAPI.revokeTask(task.id, comments.trim());
      }
      if (!['approve', 'need_improvement'].includes(action)) {
        invalidateTrackingCaches();
        await refetch();
      }
    } catch (error) {
      console.error('Action failed', error);
      await showAlert(error?.response?.data?.detail || 'Action failed', { title: 'Action Failed' });
    } finally {
      setOpenActionMenuId(null);
    }
  };

  const handleToggleMinimize = () => {
    if (isMinimized) {
      onActivate?.();
      setIsMinimized(false);
      return;
    }

    setIsMaximized(false);
    setIsMinimized(true);
  };

  const handleToggleMaximize = () => {
    if (isMinimized) {
      onActivate?.();
      setIsMinimized(false);
      return;
    }

    setIsMaximized((prev) => !prev);
  };

  if (!isOpen) return null;

  return (
    <>
      {/* Overlay - Disabled when minimized */}
      <div 
        className={`tracking-overlay ${isMinimized ? 'disabled' : ''}`} 
        onClick={!isMinimized ? onClose : null} 
      />

      {/* Main Panel */}
      <div
        className={`tracking-panel ${isMinimized ? 'minimized' : ''} ${isMaximized ? 'maximized' : ''}`}
        style={minimizedWindowStyle || undefined}
      >
        {/* Header */}
        <div className="tracking-header" onClick={isMinimized ? () => { onActivate?.(); setIsMinimized(false); } : undefined}>
          <h2>Tracking</h2>
          
          {/* Control Buttons */}
          <div className="tracking-controls">
            {!isMinimized && (
              <button
                className="tracking-control-btn minimize-btn"
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
              className="tracking-control-btn maximize-btn"
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

            <button className="tracking-close-btn" onClick={(event) => { event.stopPropagation(); onClose(); }}>
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </div>
        </div>

        {/* Filter Tabs - Only show when not minimized */}
        {!isMinimized && (
          <div className="tracking-filters">
            {TRACKING_FILTERS.map((filterOption) => (
              <button
                key={filterOption.key}
                className={`filter-btn ${filter === filterOption.key ? 'active' : ''}`}
                onClick={() => setFilter(filterOption.key)}
              >
                {filterOption.label}
              </button>
            ))}
          </div>
        )}

        {/* Tasks List - Only show when not minimized */}
        {!isMinimized && (
          <div className="tracking-content" aria-busy={isRefreshing}>
            {loading ? (
              <TrackingPanelSkeleton />
            ) : trackingError ? (
              <div className="empty-state">
                <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                  <circle cx="12" cy="12" r="10" />
                  <line x1="12" y1="8" x2="12" y2="12" />
                  <circle cx="12" cy="16" r="0.8" fill="currentColor" stroke="none" />
                </svg>
                <p>{trackingError || 'Unable to load tracking right now.'}</p>
                <button
                  type="button"
                  className="track-workflow-btn"
                  onClick={() => void refetch()}
                >
                  Retry
                </button>
              </div>
            ) : filteredTasks.length === 0 ? (
              <div className="empty-state">
                <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                  <path d="M9 12l2 2 4-4" />
                  <circle cx="12" cy="12" r="10" />
                </svg>
                <p>No tasks found</p>
              </div>
            ) : (
              <div className="tasks-grid">
                {filteredTasks.map((task) => (
                  <div key={task.id} className="tracking-task-card">
                    {/* Status Indicator */}
                    <div
                      className="status-indicator"
                      style={{ backgroundColor: getStatusColor(task.status) }}
                      title={task.status.replace(/[_]/g, ' ').toUpperCase()}
                    />

                    {/* Task Info */}
                    <div className="task-info">
                      <h4 className="task-title">{task.title}</h4>
                      <p className="task-number">{task.taskNumber}</p>
                      {isWorkflowTask(task) && (
                        <p className="task-number">{getActiveStageLabel(task) || 'Workflow task'}</p>
                      )}
                      <div className="task-meta">
                        <span className="meta-item">
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
                          </svg>
                          {task.projectName || 'N/A'}
                        </span>
                        <span className="meta-item">
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <circle cx="12" cy="12" r="10" />
                          </svg>
                          {task.priority?.toUpperCase() || 'MEDIUM'}
                        </span>
                      </div>
                    </div>

                    {/* Track Button */}
                    <button
                      className="track-workflow-btn"
                      onClick={() => handleTrackClick(task)}
                      title="View workflow path"
                    >
                      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
                      </svg>
                    </button>
                    <div className="task-action-menu-wrap">
                      <button
                        className="task-action-trigger"
                        onClick={() => setOpenActionMenuId(openActionMenuId === task.id ? null : task.id)}
                        title="Task actions"
                      >
                        ⋮
                      </button>
                      {openActionMenuId === task.id && (
                        <div className="task-action-menu">
                          {(task.availableActions || []).map((action) => (
                            <button key={action} onClick={() => runTaskAction(task, action)}>
                              {getActionLabel(task, action)}
                            </button>
                          ))}
                          {(!task.availableActions || task.availableActions.length === 0) && (
                            <span className="task-action-empty">No actions</span>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Workflow Modal */}
      <TaskWorkflow
        task={selectedTask}
        isOpen={workflowOpen}
        onClose={() => {
          setWorkflowOpen(false);
          setSelectedTask(null);
        }}
      />
      <TaskChatPanel
        task={chatTask}
        isOpen={!!chatTask}
        onClose={() => setChatTask(null)}
      />
      {submitTask && (
        <SubmitSection
          taskId={submitTask.id}
          task={submitTask}
          onClose={() => setSubmitTask(null)}
          onSubmitComplete={() => void handleSubmitComplete()}
        />
      )}

      {selectionModal.open && (
        <div className="tracking-selection-overlay" onClick={closeSelectionModal}>
          <div className="tracking-selection-modal" onClick={(event) => event.stopPropagation()}>
            <h3>{selectionModal.mode === 'forward' ? 'Forward Task' : 'Assign Members'}</h3>
            <p className="tracking-selection-subtitle">
              {selectionModal.task?.title || 'Select recipients'}
            </p>

            {selectionModal.loading ? (
              <p className="tracking-selection-loading">Loading departments and members...</p>
            ) : (
              <>
                <label htmlFor="tracking-selection-department">Department</label>
                <select
                  id="tracking-selection-department"
                  value={selectionModal.selectedDepartment}
                  onChange={(event) =>
                    setSelectionModal((prev) => ({
                      ...prev,
                      selectedDepartment: event.target.value,
                      selectedUserIds: [],
                    }))
                  }
                >
                  <option value="">Choose department...</option>
                  {selectionModal.departments.map((dept) => (
                    <option key={dept} value={dept}>{dept}</option>
                  ))}
                </select>

                <label>Members (single or multiple)</label>
                <div className="tracking-selection-user-list">
                  {selectionModal.targets
                    .filter((target) => {
                      if (!selectionModal.selectedDepartment) return false;
                      return (target.department || '') === selectionModal.selectedDepartment;
                    })
                    .map((target) => (
                      <label key={target.id} className="tracking-selection-user-item">
                        <input
                          type="checkbox"
                          checked={selectionModal.selectedUserIds.includes(target.id)}
                          onChange={() => toggleSelectionUser(target.id)}
                        />
                        <span>
                          {target.name} ({target.position || 'User'})
                        </span>
                      </label>
                    ))}
                  {selectionModal.selectedDepartment &&
                    selectionModal.targets.filter((target) => (target.department || '') === selectionModal.selectedDepartment).length === 0 && (
                      <p className="tracking-selection-loading">No members found in selected department.</p>
                    )}
                </div>

                <label htmlFor="tracking-selection-comments">Note (optional)</label>
                <textarea
                  id="tracking-selection-comments"
                  rows={3}
                  value={selectionModal.comments}
                  onChange={(event) =>
                    setSelectionModal((prev) => ({ ...prev, comments: event.target.value }))
                  }
                  placeholder="Add note..."
                />

                {selectionModal.error && (
                  <p className="tracking-selection-error">{selectionModal.error}</p>
                )}

                <div className="tracking-selection-actions">
                  <button type="button" onClick={closeSelectionModal}>Cancel</button>
                  <button
                    type="button"
                    className="primary"
                    disabled={selectionModal.submitting}
                    onClick={submitSelectionModal}
                  >
                    {selectionModal.submitting
                      ? (selectionModal.mode === 'forward' ? 'Forwarding...' : 'Assigning...')
                      : (selectionModal.mode === 'forward' ? 'Forward' : 'Assign')}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </>
  );
};

export default TrackingPanel;
