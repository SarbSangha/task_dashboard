import React, { useState, useEffect } from 'react';
import TaskWorkflow from '../../taskWorkflow/TaskWorkflow';
import { taskAPI } from '../../../services/api';
import TaskChatPanel from './TaskChatPanel';
import './TrackingPanel.css';

const TrackingPanel = ({ isOpen, onClose }) => {
  const [tasks, setTasks] = useState([]);
  const [selectedTask, setSelectedTask] = useState(null);
  const [workflowOpen, setWorkflowOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState('all');
  const [isMinimized, setIsMinimized] = useState(false);
  const [isMaximized, setIsMaximized] = useState(false);
  const [openActionMenuId, setOpenActionMenuId] = useState(null);
  const [chatTask, setChatTask] = useState(null);

  useEffect(() => {
    if (isOpen) {
      loadTasks();
    }
  }, [isOpen]);

  const loadTasks = async () => {
    setLoading(true);
    try {
      console.log('📊 Fetching tasks from API...');
      // Fetch tasks from API
      const response = await fetch(
        `${import.meta.env.VITE_API_URL || 'http://localhost:8000'}/api/tasks/all`,
        {
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' }
        }
      );

      console.log('Response status:', response.status);
      
      if (response.ok) {
        const data = await response.json();
        console.log('✅ Tasks fetched successfully:', data);
        
        if (data.tasks && Array.isArray(data.tasks)) {
          const nonDraftTasks = data.tasks.filter((task) => task.status !== 'draft');
          setTasks(nonDraftTasks);
          console.log(`📋 Loaded ${nonDraftTasks.length} non-draft tasks`);
        } else if (data.success === false) {
          console.error('API returned error:', data);
          setTasks([]);
        } else {
          console.warn('Unexpected response format:', data);
          setTasks([]);
        }
      } else {
        const errorData = await response.json().catch(() => ({}));
        console.error('Failed to load tasks. Status:', response.status, 'Error:', errorData);
        setTasks([]);
      }
    } catch (error) {
      console.error('❌ Error loading tasks:', error);
      setTasks([]);
    } finally {
      setLoading(false);
    }
  };

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

  const runTaskAction = async (task, action) => {
    try {
      if (action === 'chat') {
        setChatTask(task);
        setOpenActionMenuId(null);
        return;
      }
      if (action === 'approve') {
        const comments = window.prompt('Approval comment (optional):', '') ?? '';
        await taskAPI.approveTask(task.id, comments);
      } else if (action === 'need_improvement') {
        const comments = window.prompt('Need Improvement note:', '') ?? '';
        if (!comments) return;
        await taskAPI.needImprovement(task.id, comments);
      } else if (action === 'submit') {
        const resultText = window.prompt('Submit result details:', '') ?? '';
        await taskAPI.submitTask(task.id, resultText);
      } else if (action === 'assign') {
        const idsRaw = window.prompt('Enter assignee user IDs (comma-separated):', '') ?? '';
        if (!idsRaw.trim()) return;
        const ids = idsRaw.split(',').map((x) => Number(x.trim())).filter(Boolean);
        await taskAPI.assignTaskMembers(task.id, ids, 'Assigned from tracking panel');
      } else if (action === 'forward') {
        const toDepartment = window.prompt('Forward to department name:', '') ?? '';
        if (!toDepartment) return;
        const comments = window.prompt('Forward note (optional):', '') ?? '';
        await taskAPI.forwardTask(task.id, { to_department: toDepartment, comments });
      } else if (action === 'edit_task') {
        const description = window.prompt('Update task description:', task.description || '') ?? '';
        if (!description) return;
        await taskAPI.editTask(task.id, { description });
      } else if (action === 'edit_result') {
        const result = window.prompt('Update result text:', task.resultText || '') ?? '';
        if (!result) return;
        await taskAPI.editResult(task.id, result);
      }
      await loadTasks();
    } catch (error) {
      console.error('Action failed', error);
      alert(error?.response?.data?.detail || 'Action failed');
    } finally {
      setOpenActionMenuId(null);
    }
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
      <div className={`tracking-panel ${isMinimized ? 'minimized' : ''} ${isMaximized ? 'maximized' : ''}`}>
        {/* Header */}
        <div className="tracking-header">
          <h2>Task Tracking</h2>
          
          {/* Control Buttons */}
          <div className="tracking-controls">
            {/* Minimize Button */}
            <button
              className="tracking-control-btn minimize-btn"
              onClick={() => setIsMinimized(!isMinimized)}
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
              className="tracking-control-btn maximize-btn"
              onClick={() => setIsMaximized(!isMaximized)}
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
            <button className="close-btn" onClick={onClose}>
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
            {loading ? (
              <div className="loading-state">
                <div className="spinner"></div>
                <p>Loading tasks...</p>
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
    </>
  );
};

export default TrackingPanel;
