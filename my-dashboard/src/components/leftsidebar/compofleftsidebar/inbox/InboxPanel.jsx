// src/components/leftsidebar/compofleftsidebar/inbox/InboxPanel.jsx
import React, { useState, useEffect } from 'react';
import InboxCard from './InboxCard';
import TaskWorkflow from '../../../taskWorkflow/TaskWorkflow';
import TaskChatPanel from '../messagesystem/TaskChatPanel';
import { fileAPI, taskAPI } from '../../../../services/api';
import { useAuth } from '../../../../context/AuthContext';
import './InboxPanel.css';

const InboxPanel = ({ isOpen, onClose, onStartTaskToWorkspace }) => {
  const { user } = useAuth();
  const [tasks, setTasks] = useState([]);
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState('all');
  const [selectedTaskForWorkflow, setSelectedTaskForWorkflow] = useState(null);
  const [workflowOpen, setWorkflowOpen] = useState(false);
  const [chatTask, setChatTask] = useState(null);
  const [isMinimized, setIsMinimized] = useState(false);
  const [isMaximized, setIsMaximized] = useState(false);
  const [forwardModal, setForwardModal] = useState({
    open: false,
    task: null,
    targets: [],
    searchQuery: '',
    selectedUserId: '',
    comments: '',
    loading: false,
    submitting: false,
    error: ''
  });
  const [submitModal, setSubmitModal] = useState({
    open: false,
    task: null,
    resultText: '',
    comments: '',
    links: [],
    linkInput: '',
    attachments: [],
    submitting: false,
    error: '',
  });

  useEffect(() => {
    if (isOpen) {
      fetchInboxTasks();
    }
  }, [isOpen]);

  useEffect(() => {
    if (isOpen) {
      setIsMinimized(false);
      setIsMaximized(false);
    }
  }, [isOpen]);

  const fetchInboxTasks = async () => {
    setLoading(true);
    try {
      const data = await taskAPI.getInbox();
      if (data.success) setTasks(data.data || []);
    } catch (error) {
      console.error('Error fetching inbox:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleTrackClick = (task) => {
    setSelectedTaskForWorkflow(task);
    setWorkflowOpen(true);
  };

  const closeWorkflow = () => {
    setWorkflowOpen(false);
    setSelectedTaskForWorkflow(null);
  };

  const openForwardModal = async (task) => {
    setForwardModal({
      open: true,
      task,
      targets: [],
      searchQuery: '',
      selectedUserId: '',
      comments: '',
      loading: true,
      submitting: false,
      error: ''
    });

    try {
      const response = await taskAPI.getForwardTargets(task.id);
      setForwardModal((prev) => ({
        ...prev,
        targets: response?.users || [],
        loading: false
      }));
    } catch (error) {
      setForwardModal((prev) => ({
        ...prev,
        loading: false,
        error: error?.response?.data?.detail || 'Failed to load users'
      }));
    }
  };

  const closeForwardModal = () => {
    setForwardModal({
      open: false,
      task: null,
      targets: [],
      searchQuery: '',
      selectedUserId: '',
      comments: '',
      loading: false,
      submitting: false,
      error: ''
    });
  };

  const openSubmitModal = (task) => {
    setSubmitModal({
      open: true,
      task,
      resultText: task?.resultText || '',
      comments: '',
      links: Array.isArray(task?.resultLinks) ? [...task.resultLinks] : [],
      linkInput: '',
      attachments: [],
      submitting: false,
      error: '',
    });
  };

  const closeSubmitModal = () => {
    setSubmitModal({
      open: false,
      task: null,
      resultText: '',
      comments: '',
      links: [],
      linkInput: '',
      attachments: [],
      submitting: false,
      error: '',
    });
  };

  const addSubmitLink = () => {
    const value = (submitModal.linkInput || '').trim();
    if (!value) return;
    let normalized = value;
    if (!/^https?:\/\//i.test(normalized)) {
      normalized = `https://${normalized}`;
    }
    try {
      // Validate URL format.
      // eslint-disable-next-line no-new
      new URL(normalized);
    } catch {
      setSubmitModal((prev) => ({ ...prev, error: 'Enter a valid link URL.' }));
      return;
    }
    setSubmitModal((prev) => ({
      ...prev,
      links: [...prev.links, normalized],
      linkInput: '',
      error: '',
    }));
  };

  const removeSubmitLink = (index) => {
    setSubmitModal((prev) => ({
      ...prev,
      links: prev.links.filter((_, i) => i !== index),
    }));
  };

  const removeSubmitAttachment = (index) => {
    setSubmitModal((prev) => ({
      ...prev,
      attachments: prev.attachments.filter((_, i) => i !== index),
    }));
  };

  const submitTaskFromModal = async () => {
    const task = submitModal.task;
    if (!task) return;
    const hasPayload =
      submitModal.resultText.trim() ||
      submitModal.links.length > 0 ||
      submitModal.attachments.length > 0;
    if (!hasPayload) {
      setSubmitModal((prev) => ({ ...prev, error: 'Add result text, links, or attachments before submitting.' }));
      return;
    }

    setSubmitModal((prev) => ({ ...prev, submitting: true, error: '' }));
    try {
      let uploadedAttachments = [];
      if (submitModal.attachments.length > 0) {
        const uploadRes = await fileAPI.uploadFiles(submitModal.attachments);
        uploadedAttachments = uploadRes?.data || [];
      }

      await taskAPI.submitTask(task.id, {
        result_text: submitModal.resultText.trim(),
        comments: submitModal.comments.trim(),
        result_links: submitModal.links,
        result_attachments: uploadedAttachments,
      });

      closeSubmitModal();
      await fetchInboxTasks();
    } catch (error) {
      setSubmitModal((prev) => ({
        ...prev,
        submitting: false,
        error: error?.response?.data?.detail || 'Submit failed',
      }));
    }
  };

  const submitForwardTask = async () => {
    if (!forwardModal.task || !forwardModal.selectedUserId) return;

    setForwardModal((prev) => ({ ...prev, submitting: true, error: '' }));
    try {
      await taskAPI.forwardTask(forwardModal.task.id, {
        to_user_id: Number(forwardModal.selectedUserId),
        comments: forwardModal.comments
      });
      closeForwardModal();
      await fetchInboxTasks();
    } catch (error) {
      setForwardModal((prev) => ({
        ...prev,
        submitting: false,
        error: error?.response?.data?.detail || 'Forward failed'
      }));
    }
  };

  const filteredForwardTargets = (forwardModal.targets || []).filter((target) => {
    const search = (forwardModal.searchQuery || '').trim().toLowerCase();
    if (!search) return true;
    const haystack = `${target.name || ''} ${target.department || ''} ${target.position || ''}`.toLowerCase();
    return haystack.includes(search);
  });

  const runTaskAction = async (task, action) => {
    try {
      if (action === 'approve') {
        const comments = window.prompt('Approval comment (optional):', '') ?? '';
        await taskAPI.approveTask(task.id, comments);
      } else if (action === 'start') {
        try {
          await taskAPI.startTask(task.id);
          await fetchInboxTasks();
        } catch (error) {
          console.warn('Start task API failed:', error);
        }
        if (typeof onStartTaskToWorkspace === 'function') {
          onStartTaskToWorkspace(task);
        }
        // Move to Tools immediately after trying to persist status change.
        return;
      } else if (action === 'need_improvement') {
        const comments = window.prompt('Need Improvement note:', '') ?? '';
        if (!comments) return;
        await taskAPI.needImprovement(task.id, comments);
      } else if (action === 'submit') {
        openSubmitModal(task);
        return;
      } else if (action === 'assign') {
        const idsRaw = window.prompt('Enter assignee user IDs (comma-separated):', '') ?? '';
        if (!idsRaw.trim()) return;
        const ids = idsRaw.split(',').map((x) => Number(x.trim())).filter(Boolean);
        await taskAPI.assignTaskMembers(task.id, ids, 'Assigned from inbox');
      } else if (action === 'forward') {
        await openForwardModal(task);
        return;
      } else if (action === 'edit_task') {
        const description = window.prompt('Update task description:', task.description || '') ?? '';
        if (!description) return;
        await taskAPI.editTask(task.id, { description });
      } else if (action === 'edit_result') {
        const result = window.prompt('Update result text:', task.resultText || '') ?? '';
        if (!result) return;
        await taskAPI.editResult(task.id, result);
      }
      await fetchInboxTasks();
    } catch (error) {
      alert(error?.response?.data?.detail || 'Action failed');
    }
  };

  const filteredTasks = tasks.filter(task => {
    const isCreatorTask = task.creator?.id === user?.id;
    const isMySubmission = task.submittedBy === user?.id;
    if (filter === 'unread') return !task.isRead;
    if (filter === 'working') return ['assigned', 'in_progress', 'need_improvement'].includes(task.status);
    if (filter === 'submitted') return task.status === 'submitted' && isMySubmission;
    if (filter === 'result') return task.status === 'submitted' && isCreatorTask;
    if (filter === 'need_improvement') return task.status === 'need_improvement';
    if (filter === 'final_result') return ['approved', 'completed'].includes(task.status) && isCreatorTask;
    return true;
  });

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
      <div className={`inbox-panel-overlay ${isMinimized ? 'disabled' : ''}`} onClick={!isMinimized ? onClose : undefined} />
      <div className={`inbox-panel-container ${isMinimized ? 'minimized' : ''} ${isMaximized ? 'maximized' : ''}`} onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="inbox-panel-header" onClick={isMinimized ? () => setIsMinimized(false) : undefined}>
          <h2>📥 Inbox</h2>
          <div className="inbox-window-controls">
            <button className="inbox-window-btn" onClick={(e) => { e.stopPropagation(); handleToggleMinimize(); }} title={isMinimized ? 'Restore' : 'Minimize'}>
              {isMinimized ? '▢' : '─'}
            </button>
            <button className="inbox-window-btn" onClick={(e) => { e.stopPropagation(); handleToggleMaximize(); }} title={isMaximized ? 'Restore Window' : 'Maximize'}>
              {isMaximized ? '❐' : '□'}
            </button>
            <button className="inbox-close-btn" onClick={(e) => { e.stopPropagation(); onClose(); }}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </div>
        </div>

        {/* Filters */}
        {!isMinimized && (
        <div className="inbox-filters">
          <button 
            className={`filter-btn ${filter === 'all' ? 'active' : ''}`}
            onClick={() => setFilter('all')}
          >
            All ({tasks.length})
          </button>
          <button 
            className={`filter-btn ${filter === 'unread' ? 'active' : ''}`}
            onClick={() => setFilter('unread')}
          >
            Unread ({tasks.filter(t => !t.isRead).length})
          </button>
          <button 
            className={`filter-btn ${filter === 'working' ? 'active' : ''}`}
            onClick={() => setFilter('working')}
          >
            Working ({tasks.filter(t => ['assigned', 'in_progress', 'need_improvement'].includes(t.status)).length})
          </button>
          <button 
            className={`filter-btn ${filter === 'submitted' ? 'active' : ''}`}
            onClick={() => setFilter('submitted')}
          >
            Submitted ({tasks.filter(t => t.status === 'submitted' && t.submittedBy === user?.id).length})
          </button>
          <button 
            className={`filter-btn ${filter === 'result' ? 'active' : ''}`}
            onClick={() => setFilter('result')}
          >
            Result ({tasks.filter(t => t.status === 'submitted' && t.creator?.id === user?.id).length})
          </button>
          <button 
            className={`filter-btn ${filter === 'need_improvement' ? 'active' : ''}`}
            onClick={() => setFilter('need_improvement')}
          >
            Need Improvement ({tasks.filter(t => t.status === 'need_improvement').length})
          </button>
          <button 
            className={`filter-btn ${filter === 'final_result' ? 'active' : ''}`}
            onClick={() => setFilter('final_result')}
          >
            Final Result ({tasks.filter(t => ['approved', 'completed'].includes(t.status) && t.creator?.id === user?.id).length})
          </button>
        </div>
        )}

        {/* Task List */}
        {!isMinimized && (
        <div className="inbox-panel-content">
          {loading ? (
            <div className="inbox-loading">
              <div className="spinner"></div>
              <p>Loading tasks...</p>
            </div>
          ) : filteredTasks.length === 0 ? (
            <div className="inbox-empty">
              <div className="empty-icon">📭</div>
              <h3>No tasks found</h3>
              <p>You're all caught up!</p>
            </div>
          ) : (
            <div className="inbox-task-list">
              {filteredTasks.map(task => (
                <InboxCard
                  key={task.id}
                  task={task}
                  onTrackClick={handleTrackClick}
                  onTaskAction={runTaskAction}
                  onOpenChat={(t) => setChatTask(t)}
                />
              ))}
            </div>
          )}
        </div>
        )}
      </div>

      {/* Task Workflow Visualization */}
      <TaskWorkflow
        task={selectedTaskForWorkflow}
        isOpen={workflowOpen}
        onClose={closeWorkflow}
      />
      <TaskChatPanel
        task={chatTask}
        isOpen={!!chatTask}
        onClose={() => setChatTask(null)}
      />

      {forwardModal.open && (
        <div className="forward-modal-overlay" onClick={closeForwardModal}>
          <div className="forward-modal" onClick={(e) => e.stopPropagation()}>
            <h3>Forward Task</h3>
            <p className="forward-modal-title">{forwardModal.task?.title}</p>

            {forwardModal.loading ? (
              <p className="forward-modal-loading">Loading users...</p>
            ) : (
              <>
                <label htmlFor="forward-target-select">Select user</label>
                <input
                  id="forward-target-search"
                  type="text"
                  value={forwardModal.searchQuery}
                  onChange={(e) => setForwardModal((prev) => ({ ...prev, searchQuery: e.target.value }))}
                  placeholder="Search by name, department, position..."
                />
                <select
                  id="forward-target-select"
                  value={forwardModal.selectedUserId}
                  onChange={(e) => setForwardModal((prev) => ({ ...prev, selectedUserId: e.target.value }))}
                >
                  <option value="">Choose user...</option>
                  {filteredForwardTargets.map((target) => (
                    <option key={target.id} value={target.id}>
                      {target.name} ({target.department || 'N/A'} - {target.position || 'User'})
                    </option>
                  ))}
                </select>
                {!filteredForwardTargets.length && (
                  <p className="forward-modal-loading">No matching users found.</p>
                )}

                <label htmlFor="forward-note-input">Note (optional)</label>
                <textarea
                  id="forward-note-input"
                  rows={3}
                  value={forwardModal.comments}
                  onChange={(e) => setForwardModal((prev) => ({ ...prev, comments: e.target.value }))}
                  placeholder="Add forwarding note..."
                />

                {forwardModal.error && <p className="forward-modal-error">{forwardModal.error}</p>}

                <div className="forward-modal-actions">
                  <button type="button" onClick={closeForwardModal}>Cancel</button>
                  <button
                    type="button"
                    className="primary"
                    disabled={!forwardModal.selectedUserId || forwardModal.submitting}
                    onClick={submitForwardTask}
                  >
                    {forwardModal.submitting ? 'Forwarding...' : 'Forward'}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {submitModal.open && (
        <div className="forward-modal-overlay" onClick={closeSubmitModal}>
          <div className="submit-modal" onClick={(e) => e.stopPropagation()}>
            <h3>Submit Task Result</h3>
            <p className="submit-modal-subtitle">{submitModal.task?.title}</p>

            <div className="submit-task-info">
              <p><strong>Task ID:</strong> {submitModal.task?.taskNumber || '-'}</p>
              <p><strong>Project ID:</strong> {submitModal.task?.projectId || '-'}</p>
              <p><strong>Creator:</strong> {submitModal.task?.creator?.name || 'Unknown'}</p>
            </div>

            <label htmlFor="submit-result-text">Result Details</label>
            <textarea
              id="submit-result-text"
              rows={4}
              value={submitModal.resultText}
              onChange={(e) => setSubmitModal((prev) => ({ ...prev, resultText: e.target.value }))}
              placeholder="Add result summary, steps completed, and outcome..."
            />

            <label htmlFor="submit-result-notes">Submission Note (optional)</label>
            <textarea
              id="submit-result-notes"
              rows={2}
              value={submitModal.comments}
              onChange={(e) => setSubmitModal((prev) => ({ ...prev, comments: e.target.value }))}
              placeholder="Optional note for reviewer..."
            />

            <label htmlFor="submit-link-input">Result Links</label>
            <div className="submit-link-row">
              <input
                id="submit-link-input"
                type="text"
                value={submitModal.linkInput}
                onChange={(e) => setSubmitModal((prev) => ({ ...prev, linkInput: e.target.value }))}
                placeholder="https://example.com/file-or-resource"
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    addSubmitLink();
                  }
                }}
              />
              <button type="button" onClick={addSubmitLink}>Add Link</button>
            </div>
            {submitModal.links.length > 0 && (
              <div className="submit-link-list">
                {submitModal.links.map((link, idx) => (
                  <div key={`${link}-${idx}`} className="submit-link-item">
                    <a href={link} target="_blank" rel="noreferrer">{link}</a>
                    <button type="button" onClick={() => removeSubmitLink(idx)}>Remove</button>
                  </div>
                ))}
              </div>
            )}

            <label htmlFor="submit-file-input">Attach Files (PDF, video, audio, docs)</label>
            <input
              id="submit-file-input"
              type="file"
              multiple
              onChange={(e) => {
                const selected = Array.from(e.target.files || []);
                if (!selected.length) return;
                setSubmitModal((prev) => ({
                  ...prev,
                  attachments: [...prev.attachments, ...selected],
                }));
                e.target.value = '';
              }}
            />
            {submitModal.attachments.length > 0 && (
              <div className="submit-attachment-list">
                {submitModal.attachments.map((file, idx) => (
                  <div key={`${file.name}-${idx}`} className="submit-attachment-item">
                    <span>{file.name} ({Math.max(1, Math.round(file.size / 1024))} KB)</span>
                    <button type="button" onClick={() => removeSubmitAttachment(idx)}>Remove</button>
                  </div>
                ))}
              </div>
            )}

            {submitModal.error && <p className="forward-modal-error">{submitModal.error}</p>}

            <div className="forward-modal-actions">
              <button type="button" onClick={closeSubmitModal}>Cancel</button>
              <button
                type="button"
                className="primary"
                disabled={submitModal.submitting}
                onClick={submitTaskFromModal}
              >
                {submitModal.submitting ? 'Submitting...' : 'Submit Result'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
};

export default InboxPanel;
