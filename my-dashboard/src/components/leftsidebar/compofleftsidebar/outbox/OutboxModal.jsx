// src/components/leftsidebar/compofleftsidebar/outbox/OutboxModal.jsx
import './Outbox.css';
import { useState, useEffect, useMemo } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import OutboxTaskCard from './OutboxTaskCard';
import TaskWorkflow from '../../../taskWorkflow/TaskWorkflow';
import TaskChatPanel from '../messagesystem/TaskChatPanel';
import { draftAPI, taskAPI } from '../../../../services/api';
import { formatDateIndia, formatTimeIndia } from '../../../../utils/dateTime';
import { useCustomDialogs } from '../../../common/CustomDialogs';
import { useMinimizedWindowStack } from '../../../../hooks/useMinimizedWindowStack';
import { useDrafts, useOutbox } from '../../../../hooks/useOutbox';
import { OutboxSkeleton } from '../../../ui/OutboxSkeleton';
import { useAuth } from '../../../../context/AuthContext';

const getTaskSearchText = (task) => [
  task?.title,
  task?.taskNumber,
  task?.projectName,
  task?.customerName,
  task?.reference,
  task?.status,
  task?.priority,
  task?.description,
  task?.currentStageTitle,
  task?.creator?.name,
  task?.creator?.email,
  ...(Array.isArray(task?.assignedTo) ? task.assignedTo.map((person) => `${person?.name || ''} ${person?.email || ''}`) : []),
].filter(Boolean).join(' ').toLowerCase();

const getLocalDateKey = (value) => {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const month = `${date.getMonth() + 1}`.padStart(2, '0');
  const day = `${date.getDate()}`.padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
};

const doesTaskMatchDate = (task, selectedDate) => {
  if (!selectedDate) return true;
  return [
    task?.createdAt,
    task?.updatedAt,
    task?.sentAt,
    task?.submittedAt,
    task?.completedAt,
    task?.approvedAt,
    task?.currentStageStartedAt,
    task?.currentStageEndedAt,
  ].some((value) => getLocalDateKey(value) === selectedDate);
};

const OutboxModal = ({ isOpen, onClose, onEditTask, onMinimizedChange, onActivate }) => {
  const queryClient = useQueryClient();
  const { showAlert, showConfirm, showPrompt } = useCustomDialogs();
  const { user: authUser } = useAuth();
  const [expandedTaskId, setExpandedTaskId] = useState(null);
  const [filterStatus, setFilterStatus] = useState('all');
  const [taskSearch, setTaskSearch] = useState('');
  const [taskDateFilter, setTaskDateFilter] = useState('');
  const [isMinimized, setIsMinimized] = useState(false);
  const [isMaximized, setIsMaximized] = useState(false);
  const [selectedTaskForWorkflow, setSelectedTaskForWorkflow] = useState(null);
  const [workflowOpen, setWorkflowOpen] = useState(false);
  const [chatTask, setChatTask] = useState(null);
  const minimizedWindowStyle = useMinimizedWindowStack('outbox-modal', isOpen && isMinimized);

  const {
    data: outboxData,
    isLoading: loading,
    isFetching,
    isError,
    refetch,
  } = useOutbox({}, { enabled: isOpen });

  const tasks = useMemo(() => outboxData?.tasks || [], [outboxData?.tasks]);
  const currentUser = outboxData?.user || authUser || null;

  const buildHoldUntil = (dateTimeText) => {
    const value = `${dateTimeText || ''}`.trim();
    if (!value) return null;
    const selectedDate = new Date(value);
    if (Number.isNaN(selectedDate.getTime())) {
      throw new Error('Select a valid date and time, or leave it blank for a manual hold.');
    }
    if (selectedDate.getTime() <= Date.now()) {
      throw new Error('Select a future date and time, or leave it blank for a manual hold.');
    }
    return selectedDate.toISOString();
  };

  const { data: drafts = [] } = useDrafts({
    enabled: isOpen,
  });

  useEffect(() => {
    if (isOpen) {
      setIsMinimized(false);
      setIsMaximized(false);
    }
  }, [isOpen]);

  useEffect(() => {
    onMinimizedChange?.(isOpen && isMinimized);
  }, [isMinimized, isOpen, onMinimizedChange]);

  useEffect(() => {
    if (!Array.isArray(tasks) || tasks.length === 0) return;

    setSelectedTaskForWorkflow((prev) => {
      if (!prev?.id) return prev;
      return tasks.find((task) => task.id === prev.id) || prev;
    });

    setChatTask((prev) => {
      if (!prev?.id) return prev;
      return tasks.find((task) => task.id === prev.id) || prev;
    });
  }, [tasks]);

  const invalidateOutboxCache = () => {
    queryClient.invalidateQueries({ queryKey: ['outbox'] });
    queryClient.invalidateQueries({ queryKey: ['inbox'] });
    queryClient.invalidateQueries({ queryKey: ['tracking'] });
    queryClient.invalidateQueries({ queryKey: ['tasks'] });
    queryClient.invalidateQueries({ queryKey: ['drafts'] });
  };

  const handleRefresh = () => void refetch();

  const handleCardClick = (taskId) => {
    setExpandedTaskId(expandedTaskId === taskId ? null : taskId);
  };

  const handleTaskAction = async (task, action) => {
    if (action === 'chat') {
      setChatTask(task);
      return;
    }

    if (action === 'edit_task' && onEditTask) {
      onEditTask(task);
      return;
    }

    if (action === 'edit_draft' && onEditTask) {
      onEditTask(task);
      return;
    }

    if (action === 'delete_draft') {
      const confirmed = await showConfirm(
        'Delete this draft? This cannot be undone.',
        { title: 'Delete Draft' }
      );
      if (!confirmed) return;

      try {
        await draftAPI.deleteDraft(task.id);
        const localDraftRaw = localStorage.getItem('taskDraft');
        if (localDraftRaw) {
          try {
            const parsedLocalDraft = JSON.parse(localDraftRaw);
            if (Number(parsedLocalDraft?.__draftId) === Number(task.id)) {
              localStorage.removeItem('taskDraft');
            }
          } catch (storageError) {
            console.warn('Failed to inspect local draft cache during delete:', storageError);
          }
        }
        invalidateOutboxCache();
        await refetch();
      } catch (error) {
        await showAlert(error?.response?.data?.detail || 'Failed to delete draft', { title: 'Delete Draft Failed' });
      }
      return;
    }

    if (action === 'hold_task') {
      const confirmed = await showConfirm(
        'Hold this task? Workers will not be able to start, submit, approve, forward, or edit results until you unhold it.',
        { title: 'Hold Task' }
      );
      if (!confirmed) return;

      const holdUntilText = await showPrompt(
        'Optional auto-unhold date and time. Leave blank if you want to unhold manually:',
        { title: 'Hold Until', defaultValue: '', inputType: 'datetime-local' }
      );
      if (holdUntilText === null) return;

      const comments = (await showPrompt('Optional reason for holding this task:', {
        title: 'Hold Reason',
        defaultValue: '',
      })) ?? '';

      try {
        await taskAPI.holdTask(task.id, {
          comments: comments.trim(),
          hold_until: buildHoldUntil(holdUntilText),
        });
        invalidateOutboxCache();
        await refetch();
      } catch (error) {
        await showAlert(error?.response?.data?.detail || error?.message || 'Failed to hold task', { title: 'Hold Failed' });
      }
      return;
    }

    if (action === 'unhold_task') {
      const confirmed = await showConfirm(
        'Unhold this task now? Work actions will become available again.',
        { title: 'Unhold Task' }
      );
      if (!confirmed) return;
      const comments = (await showPrompt('Optional note for resuming this task:', {
        title: 'Unhold Note',
        defaultValue: '',
      })) ?? '';
      try {
        await taskAPI.unholdTask(task.id, comments.trim());
        invalidateOutboxCache();
        await refetch();
      } catch (error) {
        await showAlert(error?.response?.data?.detail || 'Failed to unhold task', { title: 'Unhold Failed' });
      }
      return;
    }

    if (action === 'revoke_task') {
      const confirmed = await showConfirm(
        'Revoke this task? This will mark it as revoked (regularised) for receivers.',
        { title: 'Revoke Task' }
      );
      if (!confirmed) return;
      const comments = (await showPrompt('Optional reason for revoking this task:', {
        title: 'Revoke Reason',
        defaultValue: '',
      })) ?? '';
      try {
        await taskAPI.revokeTask(task.id, comments.trim());
        invalidateOutboxCache();
        await refetch();
      } catch (error) {
        await showAlert(error?.response?.data?.detail || 'Failed to revoke task', { title: 'Revoke Failed' });
      }
    }
  };

  const handleTrackWorkflow = (task) => {
    setSelectedTaskForWorkflow(task);
    setWorkflowOpen(true);
  };

  const mergeUniqueById = (items = []) => {
    const seen = new Map();
    items.forEach((item) => {
      if (!item?.id) return;
      seen.set(item.id, item);
    });
    return Array.from(seen.values());
  };

  const isTaskHeld = (task) => Boolean(task?.isHeld || task?.holdInfo?.active);

  const isTaskRevoked = (task) => {
    const normalizedStatus = `${task?.status || ''}`.toLowerCase();
    return normalizedStatus === 'cancelled';
  };

  const getFilteredData = () => {
    if (filterStatus === 'draft') {
      let draftData = mergeUniqueById([
        ...tasks.filter((item) => `${item.status || ''}`.toLowerCase() === 'draft'),
        ...drafts,
      ]).filter((item) => doesTaskMatchDate(item, taskDateFilter));

      const query = taskSearch.trim().toLowerCase();
      if (query) {
        draftData = draftData.filter((item) => getTaskSearchText(item).includes(query));
      }
      return draftData;
    }

    let data = tasks.filter((t) => (
      `${t.status || ''}`.toLowerCase() !== 'draft' && doesTaskMatchDate(t, taskDateFilter)
    ));

    if (filterStatus !== 'all') {
      const normalizedFilter = filterStatus.toLowerCase();
      if (normalizedFilter === 'pending') {
        data = data.filter((item) => ['pending', 'forwarded', 'assigned'].includes(`${item.status || ''}`.toLowerCase()));
      } else if (normalizedFilter === 'completed') {
        data = data.filter((item) => ['approved', 'completed'].includes(`${item.status || ''}`.toLowerCase()));
      } else if (normalizedFilter === 'task_hold') {
        data = data.filter(isTaskHeld);
      } else if (normalizedFilter === 'revoked') {
        data = data.filter(isTaskRevoked);
      } else {
        data = data.filter(item => item.status?.toLowerCase() === normalizedFilter);
      }
    }

    const query = taskSearch.trim().toLowerCase();
    if (query) {
      data = data.filter((item) => getTaskSearchText(item).includes(query));
    }

    return data;
  };

  const filteredData = getFilteredData();
  const nonDraftTasks = tasks.filter((t) => (
    `${t.status || ''}`.toLowerCase() !== 'draft' && doesTaskMatchDate(t, taskDateFilter)
  ));
  const allCount = nonDraftTasks.length;
  const pendingCount = nonDraftTasks.filter(t => ['pending', 'forwarded', 'assigned'].includes(`${t.status || ''}`.toLowerCase())).length;
  const inProgressCount = nonDraftTasks.filter(t => `${t.status || ''}`.toLowerCase() === 'in_progress').length;
  const submittedCount = nonDraftTasks.filter(t => `${t.status || ''}`.toLowerCase() === 'submitted').length;
  const needsImprovementCount = nonDraftTasks.filter(t => `${t.status || ''}`.toLowerCase() === 'need_improvement').length;
  const taskHoldCount = nonDraftTasks.filter(isTaskHeld).length;
  const revokedCount = nonDraftTasks.filter(isTaskRevoked).length;
  const completedCount = tasks.filter((t) => (
    ['approved', 'completed'].includes(`${t.status || ''}`.toLowerCase()) && doesTaskMatchDate(t, taskDateFilter)
  )).length;
  const draftCount = mergeUniqueById([
    ...tasks.filter((t) => `${t.status || ''}`.toLowerCase() === 'draft'),
    ...drafts,
  ]).filter((item) => doesTaskMatchDate(item, taskDateFilter)).length;

  const formatDate = (dateString) => {
    return formatDateIndia(dateString);
  };

  const formatTime = (dateString) => {
    return formatTimeIndia(dateString);
  };

  const getStatusClass = (status) => {
    switch (status?.toLowerCase()) {
      case 'pending': return 'status-pending';
      case 'assigned':
      case 'forwarded':
        return 'status-pending';
      case 'in_progress': return 'status-in-progress';
      case 'need_improvement':
      case 'submitted': return 'status-in-progress';
      case 'approved':
      case 'completed': return 'status-completed';
      case 'cancelled': return 'status-cancelled';
      case 'draft': return 'status-draft';
      default: return 'status-pending';
    }
  };

  if (!isOpen) return null;

  const restoreWindow = () => {
    onActivate?.();
    setIsMinimized(false);
  };

  const handleToggleMinimize = () => {
    if (isMinimized) {
      restoreWindow();
      return;
    }

    setIsMaximized(false);
    setIsMinimized(true);
  };

  const handleToggleMaximize = () => {
    if (isMinimized) {
      restoreWindow();
      return;
    }

    setIsMaximized((prev) => !prev);
  };

  return (
    <>
      {/* Backdrop */}
      <div className={`outbox-modal-backdrop ${isMinimized ? 'disabled' : ''}`} onClick={!isMinimized ? onClose : undefined}></div>

      {/* Modal Content */}
      <div
        className={`outbox-modal ${isMinimized ? 'minimized' : ''} ${isMaximized ? 'maximized' : ''}`}
        style={minimizedWindowStyle || undefined}
      >
        {/* Main Header with Close Button */}
        <div className="outbox-main-header" onClick={isMinimized ? restoreWindow : undefined}>
          <div className="header-title-section">
            <h1 className="outbox-main-title">Outbox</h1>
            {/* NEW: Display current user info */}
            {currentUser && (
              <span className="current-user-badge">
                {currentUser.name} ({currentUser.email})
              </span>
            )}
          </div>
          {!isMinimized && (
            <div className="outbox-header-tools" onClick={(event) => event.stopPropagation()}>
              <div className="outbox-header-search">
                <svg className="outbox-header-search-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <circle cx="11" cy="11" r="8" />
                  <line x1="21" y1="21" x2="16.65" y2="16.65" />
                </svg>
                <input
                  type="search"
                  value={taskSearch}
                  onChange={(event) => setTaskSearch(event.target.value)}
                  placeholder="Search tasks, projects..."
                  aria-label="Search outbox tasks"
                />
              </div>
              <label className="outbox-header-date-filter">
                <span>Date</span>
                <input
                  type="date"
                  value={taskDateFilter}
                  onChange={(event) => setTaskDateFilter(event.target.value)}
                  aria-label="Filter outbox tasks by date"
                />
                {taskDateFilter && (
                  <button type="button" onClick={() => setTaskDateFilter('')} aria-label="Clear outbox date filter">
                    ×
                  </button>
                )}
              </label>
            </div>
          )}
          <div className="outbox-window-controls">
            {!isMinimized && (
              <button className="outbox-window-btn" onClick={(e) => { e.stopPropagation(); handleToggleMinimize(); }} title="Minimize">
                ─
              </button>
            )}
            <button className="outbox-window-btn" onClick={(e) => { e.stopPropagation(); handleToggleMaximize(); }} title={isMinimized ? 'Restore' : isMaximized ? 'Restore Window' : 'Maximize'}>
              {isMinimized ? '▢' : isMaximized ? '❐' : '□'}
            </button>
            <button className="outbox-close-btn" onClick={(e) => { e.stopPropagation(); onClose(); }}>
              ✕
            </button>
          </div>
        </div>

        {/* Outbox Filters */}
        {!isMinimized && (
        <div className="outbox-secondary-filters">
          <div className="filter-buttons-group">
            <button 
              className={`secondary-filter-btn ${filterStatus === 'all' ? 'active' : ''}`}
              onClick={() => setFilterStatus('all')}
            >
              All ({allCount})
            </button>
            <button 
              className={`secondary-filter-btn ${filterStatus === 'pending' ? 'active' : ''}`}
              onClick={() => setFilterStatus('pending')}
            >
              In Pending ({pendingCount})
            </button>
            <button 
              className={`secondary-filter-btn ${filterStatus === 'in_progress' ? 'active' : ''}`}
              onClick={() => setFilterStatus('in_progress')}
            >
              In Progress ({inProgressCount})
            </button>
            <button 
              className={`secondary-filter-btn ${filterStatus === 'submitted' ? 'active' : ''}`}
              onClick={() => setFilterStatus('submitted')}
            >
              Submitted ({submittedCount})
            </button>
            <button
              className={`secondary-filter-btn ${filterStatus === 'need_improvement' ? 'active' : ''}`}
              onClick={() => setFilterStatus('need_improvement')}
            >
              Needs Reimprovement ({needsImprovementCount})
            </button>
            <button 
              className={`secondary-filter-btn ${filterStatus === 'completed' ? 'active' : ''}`}
              onClick={() => setFilterStatus('completed')}
            >
              Completed ({completedCount})
            </button>
            <button 
              className={`secondary-filter-btn ${filterStatus === 'draft' ? 'active' : ''}`}
              onClick={() => setFilterStatus('draft')}
            >
              Drafts ({draftCount})
            </button>
            <button
              className={`secondary-filter-btn ${filterStatus === 'task_hold' ? 'active' : ''}`}
              onClick={() => setFilterStatus('task_hold')}
            >
              Task Hold ({taskHoldCount})
            </button>
            <button
              className={`secondary-filter-btn ${filterStatus === 'revoked' ? 'active' : ''}`}
              onClick={() => setFilterStatus('revoked')}
            >
              Revoked ({revokedCount})
            </button>
          </div>
          
          <button onClick={handleRefresh} className="refresh-btn">
            🔄 Refresh
          </button>
        </div>
        )}
        
        {/* Content */}
        {!isMinimized && (
        <div className="outbox-content" aria-busy={isFetching && !loading}>
          {loading ? (
            <OutboxSkeleton count={4} />
          ) : isError ? (
            <div className="error-banner">
              ⚠️ Failed to load tasks. Please check your connection.
              <button onClick={() => void refetch()} className="retry-btn">Retry</button>
            </div>
          ) : filteredData.length === 0 ? (
            <div className="no-tasks">
              <p>📭 No tasks found</p>
              {currentUser && (
                <small style={{ color: '#666', marginTop: '8px' }}>
                  Showing only tasks created by you
                </small>
              )}
            </div>
          ) : (
            <div className="outbox-task-grid">
              {filteredData.map(task => (
                <OutboxTaskCard
                  key={task.id}
                  task={task}
                  isExpanded={expandedTaskId === task.id}
                  onClick={handleCardClick}
                  onTaskAction={handleTaskAction}
                  onTrackClick={handleTrackWorkflow}
                  currentUser={currentUser}
                  formatDate={formatDate}
                  formatTime={formatTime}
                  getStatusClass={getStatusClass}
                />
              ))}
            </div>
          )}
        </div>
        )}
      </div>

      <TaskWorkflow
        task={selectedTaskForWorkflow}
        isOpen={workflowOpen}
        onClose={() => {
          setWorkflowOpen(false);
          setSelectedTaskForWorkflow(null);
        }}
      />
      <TaskChatPanel
        task={chatTask}
        isOpen={!!chatTask}
        onClose={() => setChatTask(null)}
      />
    </>
  );
};

export default OutboxModal;
