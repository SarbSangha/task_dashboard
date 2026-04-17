// src/components/leftsidebar/compofleftsidebar/outbox/OutboxModal.jsx
import './Outbox.css';
import React, { useState, useEffect } from 'react';
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

const OutboxModal = ({ isOpen, onClose, onEditTask, onMinimizedChange, onActivate }) => {
  const queryClient = useQueryClient();
  const { showAlert, showConfirm, showPrompt } = useCustomDialogs();
  const [expandedTaskId, setExpandedTaskId] = useState(null);
  const [activeTab, setActiveTab] = useState('all-dispatched');
  const [filterStatus, setFilterStatus] = useState('all');
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

  const tasks = outboxData?.tasks || [];
  const currentUser = outboxData?.user || null;

  const { data: drafts = [] } = useDrafts({
    enabled: isOpen && activeTab === 'drafts',
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

  const invalidateOutboxCache = () => {
    queryClient.invalidateQueries({ queryKey: ['outbox'] });
    queryClient.invalidateQueries({ queryKey: ['tracking'] });
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

  const getFilteredData = () => {
    let data = [];
    
    switch (activeTab) {
      case 'all-dispatched':
        data = tasks.filter((t) => t.status !== 'draft');
        break;
      case 'awaiting':
        data = tasks.filter(t => ['pending', 'forwarded', 'assigned'].includes(t.status));
        break;
      case 'needs-reimprovement':
        data = tasks.filter(t => t.status === 'need_improvement');
        break;
      case 'drafts':
        data = mergeUniqueById([
          ...tasks.filter((t) => t.status === 'draft'),
          ...drafts
        ]);
        break;
      default:
        data = tasks.filter((t) => t.status !== 'draft');
    }

    if (filterStatus !== 'all') {
      data = data.filter(item => item.status?.toLowerCase() === filterStatus.toLowerCase());
    }

    return data;
  };

  const filteredData = getFilteredData();
  const allCount = tasks.length;
  const pendingCount = tasks.filter(t => ['pending', 'forwarded', 'assigned'].includes(t.status)).length;
  const inProgressCount = tasks.filter(t => t.status === 'in_progress').length;
  const submittedCount = tasks.filter(t => t.status === 'submitted').length;
  const completedCount = tasks.filter(t => t.status === 'completed').length;

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

        {/* Top Tab Navigation */}
        {!isMinimized && (
        <div className="outbox-top-tabs">
          <button
            className={`top-tab-btn ${activeTab === 'all-dispatched' ? 'active' : ''}`}
            onClick={() => setActiveTab('all-dispatched')}
          >
            All Dispatched
          </button>
          <button
            className={`top-tab-btn ${activeTab === 'awaiting' ? 'active' : ''}`}
            onClick={() => setActiveTab('awaiting')}
          >
            Awaiting Acceptance
          </button>
          <button
            className={`top-tab-btn ${activeTab === 'needs-reimprovement' ? 'active' : ''}`}
            onClick={() => setActiveTab('needs-reimprovement')}
          >
            Needs Reimprovement
          </button>
          <button
            className={`top-tab-btn ${activeTab === 'drafts' ? 'active' : ''}`}
            onClick={() => setActiveTab('drafts')}
          >
            Drafts
          </button>
        </div>
        )}

        {/* Secondary Filters */}
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
              Pending ({pendingCount})
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
              className={`secondary-filter-btn ${filterStatus === 'completed' ? 'active' : ''}`}
              onClick={() => setFilterStatus('completed')}
            >
              Completed ({completedCount})
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
