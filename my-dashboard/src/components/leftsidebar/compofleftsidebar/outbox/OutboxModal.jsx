// src/components/leftsidebar/compofleftsidebar/outbox/OutboxModal.jsx
import './Outbox.css';
import React, { useState, useEffect, useRef } from 'react';
import OutboxTaskCard from './OutboxTaskCard';
import TaskWorkflow from '../../../taskWorkflow/TaskWorkflow';
import { taskAPI, draftAPI } from '../../../../services/api';
import { formatDateIndia, formatTimeIndia } from '../../../../utils/dateTime';
import { useCustomDialogs } from '../../../common/CustomDialogs';
import { useAuth } from '../../../../context/AuthContext';
import CacheStatusBanner from '../../../common/CacheStatusBanner';
import {
  buildTaskPanelCacheKey,
  getTaskPanelCacheEntry,
  invalidateTaskPanelCache,
  setTaskPanelCache,
} from '../../../../utils/taskPanelCache';

const OUTBOX_CACHE_TTL_MS = 90 * 1000;

const OutboxModal = ({ isOpen, onClose, onEditTask }) => {
  const { showAlert, showConfirm, showPrompt } = useCustomDialogs();
  const { user } = useAuth();
  const [tasks, setTasks] = useState([]);
  const [drafts, setDrafts] = useState([]);
  const [loading, setLoading] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [cacheStatus, setCacheStatus] = useState({
    showingCached: false,
    cachedAt: 0,
    liveUpdatedAt: 0,
  });
  const [error, setError] = useState(null);
  const [expandedTaskId, setExpandedTaskId] = useState(null);
  const [activeTab, setActiveTab] = useState('all-dispatched');
  const [filterStatus, setFilterStatus] = useState('all');
  const [currentUser, setCurrentUser] = useState(null); // NEW: Track current user
  const [isMinimized, setIsMinimized] = useState(false);
  const [isMaximized, setIsMaximized] = useState(false);
  const [selectedTaskForWorkflow, setSelectedTaskForWorkflow] = useState(null);
  const [workflowOpen, setWorkflowOpen] = useState(false);
  const fetchInFlightRef = useRef(false);
  const cacheKey = user?.id ? buildTaskPanelCacheKey(user.id, 'outbox') : null;

  // Fetch data when modal opens
  useEffect(() => {
    if (!isOpen || !user?.id) return undefined;

    const cachedOutboxEntry = cacheKey ? getTaskPanelCacheEntry(cacheKey, OUTBOX_CACHE_TTL_MS) : null;
    const cachedOutbox = cachedOutboxEntry?.value || null;
    const hasCachedOutbox = Boolean(cachedOutbox);
    if (cachedOutbox) {
      setTasks(cachedOutbox.tasks || []);
      setDrafts(cachedOutbox.drafts || []);
      setCurrentUser(cachedOutbox.currentUser || null);
      setError(null);
      setCacheStatus({
        showingCached: true,
        cachedAt: cachedOutboxEntry?.cachedAt || 0,
        liveUpdatedAt: 0,
      });
    }

    fetchData({ silent: hasCachedOutbox, includeDrafts: activeTab === 'drafts' });
    // Auto-refresh every 30 seconds while modal is open (reduced API load)
    const interval = setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      fetchData({ silent: true, includeDrafts: activeTab === 'drafts' });
    }, 30000);

    return () => clearInterval(interval);
  }, [activeTab, cacheKey, isOpen, user?.id]);

  useEffect(() => {
    if (isOpen) {
      setIsMinimized(false);
      setIsMaximized(false);
    }
  }, [isOpen]);

  const invalidateOutboxCache = () => {
    if (cacheKey) {
      invalidateTaskPanelCache(cacheKey);
    }
  };

  const fetchData = async ({ silent = false, includeDrafts = false } = {}) => {
    if (!user?.id || !cacheKey) return;
    if (fetchInFlightRef.current) return;
    fetchInFlightRef.current = true;
    try {
      if (silent) {
        setIsRefreshing(true);
      } else {
        setLoading(true);
      }
      
      const tasksData = await taskAPI.getOutbox();
      let nextTasks = tasks;
      let nextCurrentUser = currentUser;
      
      if (tasksData.success) {
        nextTasks = tasksData.data || [];
        setTasks(nextTasks);
        // Store current user info if available
        if (tasksData.user) {
          nextCurrentUser = tasksData.user;
          setCurrentUser(tasksData.user);
        }
        console.log(`✅ Loaded ${tasksData.count} tasks for user: ${tasksData.user?.email}`);
      } else {
        setError('Failed to load tasks');
      }

      // Fetch drafts only when drafts tab is active or when explicitly requested
      let nextDrafts = drafts;
      if (includeDrafts) {
        try {
          const draftsData = await draftAPI.getDrafts();
          if (draftsData.success) {
            nextDrafts = draftsData.data || [];
            setDrafts(nextDrafts);
          }
        } catch (err) {
          console.warn('Drafts not available:', err);
          nextDrafts = [];
          setDrafts([]);
        }
      }
      
      setTaskPanelCache(cacheKey, {
        tasks: nextTasks,
        drafts: nextDrafts,
        currentUser: nextCurrentUser,
      });
      setCacheStatus((prev) => ({
        showingCached: false,
        cachedAt: prev.cachedAt,
        liveUpdatedAt: Date.now(),
      }));
      setError(null);
    } catch (err) {
      console.error('Error fetching data:', err);
      if (!silent) setError('Failed to load tasks. Please check your connection.');
    } finally {
      if (silent) {
        setIsRefreshing(false);
      } else {
        setLoading(false);
      }
      fetchInFlightRef.current = false;
    }
  };

  const handleRefresh = () => fetchData({ silent: false, includeDrafts: activeTab === 'drafts' });

  const handleCardClick = (taskId) => {
    setExpandedTaskId(expandedTaskId === taskId ? null : taskId);
  };

  const handleTaskAction = async (task, action) => {
    if (action === 'edit_task' && onEditTask) {
      onEditTask(task);
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
        await fetchData({ silent: true, includeDrafts: activeTab === 'drafts' });
      } catch (error) {
        await showAlert(error?.response?.data?.detail || 'Failed to revoke task', { title: 'Revoke Failed' });
      }
    }
  };

  const handleTrackWorkflow = (task) => {
    setSelectedTaskForWorkflow(task);
    setWorkflowOpen(true);
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
        data = [
          ...tasks.filter((t) => t.status === 'draft'),
          ...drafts
        ];
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
      case 'in_progress': return 'status-in-progress';
      case 'submitted': return 'status-in-progress';
      case 'completed': return 'status-completed';
      case 'cancelled': return 'status-cancelled';
      case 'draft': return 'status-draft';
      default: return 'status-pending';
    }
  };

  if (!isOpen) return null;

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

  return (
    <>
      {/* Backdrop */}
      <div className={`outbox-modal-backdrop ${isMinimized ? 'disabled' : ''}`} onClick={!isMinimized ? onClose : undefined}></div>

      {/* Modal Content */}
      <div className={`outbox-modal ${isMinimized ? 'minimized' : ''} ${isMaximized ? 'maximized' : ''}`}>
        {/* Main Header with Close Button */}
        <div className="outbox-main-header" onClick={isMinimized ? () => setIsMinimized(false) : undefined}>
          <div className="header-title-section">
            <h1 className="outbox-main-title">MY OUTBOX</h1>
            {/* NEW: Display current user info */}
            {currentUser && (
              <span className="current-user-badge">
                {currentUser.name} ({currentUser.email})
              </span>
            )}
          </div>
          <div className="outbox-window-controls">
            <button className="outbox-window-btn" onClick={(e) => { e.stopPropagation(); handleToggleMinimize(); }} title={isMinimized ? 'Restore' : 'Minimize'}>
              {isMinimized ? '▢' : '─'}
            </button>
            <button className="outbox-window-btn" onClick={(e) => { e.stopPropagation(); handleToggleMaximize(); }} title={isMaximized ? 'Restore Window' : 'Maximize'}>
              {isMaximized ? '❐' : '□'}
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
        <div className="outbox-content">
          <CacheStatusBanner
            showingCached={cacheStatus.showingCached}
            isRefreshing={isRefreshing}
            cachedAt={cacheStatus.cachedAt}
            liveUpdatedAt={cacheStatus.liveUpdatedAt}
            refreshingLabel="Refreshing latest outbox..."
            liveLabel="Outbox is up to date"
            cachedLabel="Showing cached outbox"
          />
          {loading && tasks.length === 0 ? (
            <div className="outbox-loading">
              <div className="spinner"></div>
              <p>Loading tasks...</p>
            </div>
          ) : error ? (
            <div className="error-banner">
              ⚠️ {error}
              <button onClick={handleRefresh} className="retry-btn">Retry</button>
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
    </>
  );
};

export default OutboxModal;
