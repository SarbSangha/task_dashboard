import React, { useState, useEffect, useMemo } from 'react';
import TaskWorkflow from '../../../taskWorkflow/TaskWorkflow';
import { taskAPI } from '../../../../services/api';
import TaskChatPanel from '../messagesystem/TaskChatPanel';
import { useCustomDialogs } from '../../../common/CustomDialogs';
import CacheStatusBanner from '../../../common/CacheStatusBanner';
import { useAuth } from '../../../../context/AuthContext';
import {
  buildTaskPanelCacheKey,
  getTaskPanelCacheEntry,
  invalidateTaskPanelCache,
  setTaskPanelCache,
} from '../../../../utils/taskPanelCache';
import { useMinimizedWindowStack } from '../../../../hooks/useMinimizedWindowStack';
import { useUpdateTaskStatus } from '../../../../hooks/useTaskActions';
import { TrackingPanelSkeleton } from '../../../ui/TrackingPanelSkeleton';
import './TrackingPanel.css';

const dedupeTasks = (rows = []) =>
  Array.from(new Map(rows.map((task) => [task.id, task])).values());

const TRACKING_CACHE_TTL_MS = 90 * 1000;

const TrackingPanel = ({ isOpen, onClose }) => {
  const { user } = useAuth();
  const { showAlert, showPrompt } = useCustomDialogs();
  const [tasks, setTasks] = useState([]);
  const [selectedTask, setSelectedTask] = useState(null);
  const [workflowOpen, setWorkflowOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [cacheStatus, setCacheStatus] = useState({
    showingCached: false,
    cachedAt: 0,
    liveUpdatedAt: 0,
  });
  const [filter, setFilter] = useState('all');
  const [isMinimized, setIsMinimized] = useState(false);
  const [isMaximized, setIsMaximized] = useState(false);
  const [openActionMenuId, setOpenActionMenuId] = useState(null);
  const [chatTask, setChatTask] = useState(null);
  const minimizedWindowStyle = useMinimizedWindowStack('tracking-panel', isOpen && isMinimized);
  const tasksRef = React.useRef([]);
  const selectedTaskRef = React.useRef(null);
  const chatTaskRef = React.useRef(null);
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

  const cacheKeys = useMemo(() => {
    if (!user?.id) return null;
    return {
      inbox: buildTaskPanelCacheKey(user.id, 'inbox'),
      outbox: buildTaskPanelCacheKey(user.id, 'outbox'),
      tracking: buildTaskPanelCacheKey(user.id, 'tracking'),
    };
  }, [user?.id]);

  useEffect(() => {
    tasksRef.current = tasks;
  }, [tasks]);

  useEffect(() => {
    selectedTaskRef.current = selectedTask;
  }, [selectedTask]);

  useEffect(() => {
    chatTaskRef.current = chatTask;
  }, [chatTask]);

  useEffect(() => {
    if (!isOpen || !cacheKeys) return;

    const cachedInboxEntry = getTaskPanelCacheEntry(cacheKeys.inbox, TRACKING_CACHE_TTL_MS);
    const cachedOutboxEntry = getTaskPanelCacheEntry(cacheKeys.outbox, TRACKING_CACHE_TTL_MS);
    const cachedTrackingEntry = getTaskPanelCacheEntry(cacheKeys.tracking, TRACKING_CACHE_TTL_MS);
    const cachedTasks = dedupeTasks([
      ...(Array.isArray(cachedTrackingEntry?.value?.tasks) ? cachedTrackingEntry.value.tasks : []),
      ...(Array.isArray(cachedInboxEntry?.value?.tasks) ? cachedInboxEntry.value.tasks : []),
      ...(Array.isArray(cachedOutboxEntry?.value?.tasks) ? cachedOutboxEntry.value.tasks : []),
    ]).filter((task) => task.status !== 'draft');

    if (cachedTasks.length > 0) {
      setTasks(cachedTasks);
      setLoading(false);
      setCacheStatus({
        showingCached: true,
        cachedAt: cachedTrackingEntry?.cachedAt || cachedInboxEntry?.cachedAt || cachedOutboxEntry?.cachedAt || 0,
        liveUpdatedAt: 0,
      });
    }

    loadTasks({ silent: cachedTasks.length > 0 });
  }, [cacheKeys, isOpen]);

  const loadTasks = async ({ silent = false } = {}) => {
    if (silent) {
      setIsRefreshing(true);
    } else {
      setLoading(true);
    }

    try {
      console.log('📊 Fetching tracking tasks from inbox and outbox...');
      const [inboxData, outboxData] = await Promise.all([
        taskAPI.getInbox().catch((error) => {
          console.warn('Inbox tasks unavailable for tracking:', error);
          return { data: [] };
        }),
        taskAPI.getOutbox().catch((error) => {
          console.warn('Outbox tasks unavailable for tracking:', error);
          return { data: [] };
        }),
      ]);

      const mergedTasks = dedupeTasks([
        ...(Array.isArray(inboxData?.data) ? inboxData.data : []),
        ...(Array.isArray(outboxData?.data) ? outboxData.data : []),
      ]);
      const nonDraftTasks = mergedTasks.filter((task) => task.status !== 'draft');
      setTasks(nonDraftTasks);
      if (cacheKeys) {
        setTaskPanelCache(cacheKeys.inbox, {
          tasks: Array.isArray(inboxData?.data) ? inboxData.data : [],
        });
        setTaskPanelCache(cacheKeys.outbox, {
          tasks: Array.isArray(outboxData?.data) ? outboxData.data : [],
        });
        setTaskPanelCache(cacheKeys.tracking, {
          tasks: nonDraftTasks,
        });
      }
      setCacheStatus((prev) => ({
        showingCached: false,
        cachedAt: prev.cachedAt,
        liveUpdatedAt: Date.now(),
      }));
      console.log(`📋 Loaded ${nonDraftTasks.length} tracking tasks from user scope`);
    } catch (error) {
      console.error('❌ Error loading tasks:', error);
      if (!silent) {
        setTasks([]);
      }
    } finally {
      if (silent) {
        setIsRefreshing(false);
      } else {
        setLoading(false);
      }
    }
  };

  const invalidateTrackingCaches = () => {
    if (!cacheKeys) return;
    invalidateTaskPanelCache(cacheKeys.inbox);
    invalidateTaskPanelCache(cacheKeys.outbox);
    invalidateTaskPanelCache(cacheKeys.tracking);
  };

  const { mutateAsync: updateTaskStatus } = useUpdateTaskStatus({
    onOptimisticUpdate: ({ taskId, status }) => {
      const optimisticPatch = {
        status,
        updatedAt: new Date().toISOString(),
      };
      const snapshot = {
        tasks: tasksRef.current,
        selectedTask: selectedTaskRef.current,
        chatTask: chatTaskRef.current,
      };

      setTasks((prev) => prev.map((row) => (row.id === taskId ? { ...row, ...optimisticPatch } : row)));
      setSelectedTask((prev) => (prev?.id === taskId ? { ...prev, ...optimisticPatch } : prev));
      setChatTask((prev) => (prev?.id === taskId ? { ...prev, ...optimisticPatch } : prev));

      return snapshot;
    },
    onRollback: (snapshot) => {
      if (!snapshot) return;
      setTasks(snapshot.tasks || []);
      setSelectedTask(snapshot.selectedTask || null);
      setChatTask(snapshot.chatTask || null);
    },
    onSettled: async () => {
      invalidateTrackingCaches();
      await loadTasks({ silent: true });
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

  const filteredTasks = filter === 'all' 
    ? tasks 
    : tasks.filter(task => task.status === filter);

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
      await loadTasks({ silent: true });
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
        const comments = (await showPrompt('Approval comment (optional):', {
          title: 'Approve Task',
          defaultValue: '',
        })) ?? '';
        await updateTaskStatus({
          taskId: task.id,
          status: 'approved',
          execute: () => taskAPI.approveTask(task.id, comments),
        });
      } else if (action === 'need_improvement') {
        const comments = (await showPrompt('Need Improvement note:', {
          title: 'Need Improvement',
          defaultValue: '',
          multiline: true,
          rows: 6,
          placeholder: 'Describe what needs to be improved...',
        })) ?? '';
        if (!comments) return;
        await updateTaskStatus({
          taskId: task.id,
          status: 'need_improvement',
          execute: () => taskAPI.needImprovement(task.id, comments),
        });
      } else if (action === 'submit') {
        const resultText = (await showPrompt('Submit result details:', {
          title: 'Submit Result',
          defaultValue: '',
        })) ?? '';
        await updateTaskStatus({
          taskId: task.id,
          status: 'submitted',
          execute: () => taskAPI.submitTask(task.id, resultText),
        });
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
      }
      if (!['approve', 'need_improvement', 'submit'].includes(action)) {
        invalidateTrackingCaches();
        await loadTasks({ silent: true });
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
      setIsMinimized(false);
      return;
    }

    setIsMaximized(false);
    setIsMinimized(true);
  };

  const handleToggleMaximize = () => {
    if (isMinimized) {
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
        <div className="tracking-header" onClick={isMinimized ? () => setIsMinimized(false) : undefined}>
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
            <button
              className={`filter-btn ${filter === 'all' ? 'active' : ''}`}
              onClick={() => setFilter('all')}
            >
              All Tasks
            </button>
            <button
              className={`filter-btn ${filter === 'pending' ? 'active' : ''}`}
              onClick={() => setFilter('pending')}
            >
              Pending
            </button>
            <button
              className={`filter-btn ${filter === 'in_progress' ? 'active' : ''}`}
              onClick={() => setFilter('in_progress')}
            >
              In Progress
            </button>
            <button
              className={`filter-btn ${filter === 'completed' ? 'active' : ''}`}
              onClick={() => setFilter('completed')}
            >
              Completed
            </button>
          </div>
        )}

        {/* Tasks List - Only show when not minimized */}
        {!isMinimized && (
          <div className="tracking-content">
            <CacheStatusBanner
              showingCached={cacheStatus.showingCached}
              isRefreshing={isRefreshing}
              cachedAt={cacheStatus.cachedAt}
              liveUpdatedAt={cacheStatus.liveUpdatedAt}
              refreshingLabel="Refreshing latest tracking data..."
              liveLabel="Tracking data is up to date"
              cachedLabel="Showing cached tracking data"
            />
            {loading ? (
              <TrackingPanelSkeleton />
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
                              {action.replace(/_/g, ' ')}
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
