// src/components/leftsidebar/compofleftsidebar/outbox/OutboxModal.jsx
import './Outbox.css';
import React, { useState, useEffect } from 'react';
import OutboxTaskCard from './OutboxTaskCard';

const OutboxModal = ({ isOpen, onClose }) => {
  const [tasks, setTasks] = useState([]);
  const [drafts, setDrafts] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [expandedTaskId, setExpandedTaskId] = useState(null);
  const [activeTab, setActiveTab] = useState('all-dispatched');
  const [filterStatus, setFilterStatus] = useState('all');
  const [currentUser, setCurrentUser] = useState(null); // NEW: Track current user

  // Fetch data when modal opens
  useEffect(() => {
    if (isOpen) {
      fetchData();
      // Auto-refresh every 5 seconds while modal is open
      const interval = setInterval(() => fetchData(true), 5000);
      return () => clearInterval(interval);
    }
  }, [isOpen]);

  const fetchData = async (silent = false) => {
    try {
      if (!silent) setLoading(true);
      
      // UPDATED: Fetch only current user's tasks from /outbox endpoint
      const tasksResponse = await fetch('http://localhost:8000/api/tasks/outbox', {
        credentials: 'include' // Important: Include credentials for session
      });
      const tasksData = await tasksResponse.json();
      
      if (tasksData.success) {
        setTasks(tasksData.data || []);
        // Store current user info if available
        if (tasksData.user) {
          setCurrentUser(tasksData.user);
        }
        console.log(`✅ Loaded ${tasksData.count} tasks for user: ${tasksData.user?.email}`);
      } else {
        // Handle authentication errors
        if (tasksResponse.status === 401) {
          setError('Please log in to view your outbox');
        } else {
          setError('Failed to load tasks');
        }
      }

      // Fetch drafts (keep existing logic)
      try {
        const draftsResponse = await fetch('http://localhost:8000/api/drafts', {
          credentials: 'include'
        });
        const draftsData = await draftsResponse.json();
        if (draftsData.success) {
          setDrafts(draftsData.data || []);
        }
      } catch (err) {
        console.warn('Drafts not available:', err);
        setDrafts([]);
      }
      
      setError(null);
    } catch (err) {
      console.error('Error fetching data:', err);
      if (!silent) setError('Failed to load tasks. Please check your connection.');
    } finally {
      if (!silent) setLoading(false);
    }
  };

  const handleRefresh = () => fetchData();

  const handleCardClick = (taskId) => {
    setExpandedTaskId(expandedTaskId === taskId ? null : taskId);
  };

  const getFilteredData = () => {
    let data = [];
    
    switch (activeTab) {
      case 'all-dispatched':
        data = tasks;
        break;
      case 'awaiting':
        data = tasks.filter(t => t.status === 'pending');
        break;
      case 'needs-reimprovement':
        data = tasks.filter(t => t.status === 'cancelled' || t.status === 'needs_improvement');
        break;
      case 'drafts':
        data = drafts;
        break;
      default:
        data = tasks;
    }

    if (filterStatus !== 'all') {
      data = data.filter(item => item.status?.toLowerCase() === filterStatus.toLowerCase());
    }

    return data;
  };

  const filteredData = getFilteredData();
  const allCount = tasks.length;
  const pendingCount = tasks.filter(t => t.status === 'pending').length;
  const inProgressCount = tasks.filter(t => t.status === 'in_progress').length;
  const completedCount = tasks.filter(t => t.status === 'completed').length;

  const formatDate = (dateString) => {
    if (!dateString) return 'N/A';
    const date = new Date(dateString);
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  };

  const formatTime = (dateString) => {
    if (!dateString) return 'N/A';
    const date = new Date(dateString);
    return date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
  };

  const getStatusClass = (status) => {
    switch (status?.toLowerCase()) {
      case 'pending': return 'status-pending';
      case 'in_progress': return 'status-in-progress';
      case 'completed': return 'status-completed';
      case 'cancelled': return 'status-cancelled';
      case 'draft': return 'status-draft';
      default: return 'status-pending';
    }
  };

  if (!isOpen) return null;

  return (
    <>
      {/* Backdrop */}
      <div className="outbox-modal-backdrop" onClick={onClose}></div>

      {/* Modal Content */}
      <div className="outbox-modal">
        {/* Main Header with Close Button */}
        <div className="outbox-main-header">
          <div className="header-title-section">
            <h1 className="outbox-main-title">MY OUTBOX</h1>
            {/* NEW: Display current user info */}
            {currentUser && (
              <span className="current-user-badge">
                {currentUser.name} ({currentUser.email})
              </span>
            )}
          </div>
          <button className="outbox-close-btn" onClick={onClose}>
            ✕
          </button>
        </div>

        {/* Top Tab Navigation */}
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

        {/* Secondary Filters */}
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

        {/* Content */}
        <div className="outbox-content">
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
                  formatDate={formatDate}
                  formatTime={formatTime}
                  getStatusClass={getStatusClass}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </>
  );
};

export default OutboxModal;
