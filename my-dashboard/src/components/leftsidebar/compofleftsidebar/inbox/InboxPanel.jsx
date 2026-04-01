// src/components/leftsidebar/compofleftsidebar/inbox/InboxPanel.jsx
import React, { useState, useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import InboxCard from './InboxCard';
import TaskWorkflow from '../../../taskWorkflow/TaskWorkflow';
import TaskChatPanel from '../messagesystem/TaskChatPanel';
import { fileAPI, taskAPI, subscribeRealtimeNotifications } from '../../../../services/api';
import { useAuth } from '../../../../context/AuthContext';
import { useCustomDialogs } from '../../../common/CustomDialogs';
import {
  getAttachmentDisplayName,
  mergeUniqueAttachments,
  openSystemFilePicker,
} from '../../../../utils/fileUploads';
import { useMinimizedWindowStack } from '../../../../hooks/useMinimizedWindowStack';
import { useInbox } from '../../../../hooks/useInbox';
import { useUpdateTaskStatus } from '../../../../hooks/useTaskActions';
import { InboxSkeleton } from '../../../ui/InboxSkeleton';
import './InboxPanel.css';

const InboxPanel = ({ isOpen, onClose, onStartTaskToWorkspace }) => {
  const { showAlert, showPrompt } = useCustomDialogs();
  const { user } = useAuth();
  const queryClient = useQueryClient();
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
    selectedUserIds: [],
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
  const refreshTimerRef = React.useRef(null);
  const minimizedWindowStyle = useMinimizedWindowStack('inbox-panel', isOpen && isMinimized);
  const {
    data: inboxData,
    isLoading,
    isFetching,
    isError,
    refetch,
  } = useInbox({}, { enabled: isOpen });
  const tasks = inboxData?.tasks || [];
  const loading = isLoading;
  const isRefreshing = isFetching && !isLoading;
  const { mutateAsync: updateTaskStatus } = useUpdateTaskStatus();

  useEffect(() => {
    if (!isOpen) return undefined;

    const scheduleRefresh = () => {
      if (refreshTimerRef.current) return;
      refreshTimerRef.current = window.setTimeout(() => {
        refreshTimerRef.current = null;
        void refetch();
      }, 250);
    };

    const unsubscribe = subscribeRealtimeNotifications({
      onMessage: (payload) => {
        if (!payload || payload.eventType === 'group_message') return;
        scheduleRefresh();
      },
      onOpen: () => {
        scheduleRefresh();
      },
    });

    const interval = window.setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      void refetch();
    }, 180000);

    const onFocus = () => scheduleRefresh();
    window.addEventListener('focus', onFocus);

    return () => {
      unsubscribe();
      window.clearInterval(interval);
      window.removeEventListener('focus', onFocus);
      if (refreshTimerRef.current) {
        window.clearTimeout(refreshTimerRef.current);
        refreshTimerRef.current = null;
      }
    };
  }, [isOpen, refetch, user?.id]);

  useEffect(() => {
    if (isOpen) {
      setIsMinimized(false);
      setIsMaximized(false);
    }
  }, [isOpen]);

  const refreshTaskQueries = async () => {
    const userKey = user?.id ?? 'anonymous';
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['inbox', userKey] }),
      queryClient.invalidateQueries({ queryKey: ['outbox', userKey] }),
      queryClient.invalidateQueries({ queryKey: ['tracking', userKey] }),
    ]);
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
      selectedUserIds: [],
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
      selectedUserIds: [],
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

  const appendSubmitAttachments = (selectedFiles) => {
    const selected = Array.from(selectedFiles || []);
    if (!selected.length) return;

    setSubmitModal((prev) => ({
      ...prev,
      attachments: mergeUniqueAttachments(prev.attachments, selected),
    }));
  };

  const openSubmitPicker = (mode) => {
    openSystemFilePicker({
      mode,
      onSelect: appendSubmitAttachments,
    });
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

      await updateTaskStatus({
        taskId: task.id,
        status: 'submitted',
        execute: () =>
          taskAPI.submitTask(task.id, {
            result_text: submitModal.resultText.trim(),
            comments: submitModal.comments.trim(),
            result_links: submitModal.links,
            result_attachments: uploadedAttachments,
          }),
      });

      closeSubmitModal();
    } catch (error) {
      setSubmitModal((prev) => ({
        ...prev,
        submitting: false,
        error: error?.response?.data?.detail || 'Submit failed',
      }));
    }
  };

  const submitForwardTask = async () => {
    if (!forwardModal.task || forwardModal.selectedUserIds.length === 0) return;

    setForwardModal((prev) => ({ ...prev, submitting: true, error: '' }));
    try {
      await taskAPI.forwardTask(forwardModal.task.id, {
        to_user_ids: forwardModal.selectedUserIds.map((id) => Number(id)),
        comments: forwardModal.comments
      });
      closeForwardModal();
      await refreshTaskQueries();
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
  const selectedForwardTargets = (forwardModal.targets || []).filter((target) =>
    forwardModal.selectedUserIds.includes(String(target.id))
  );

  const toggleForwardRecipient = (targetId, targetName = '') => {
    setForwardModal((prev) => {
      const nextSelectedUserIds = prev.selectedUserIds.includes(String(targetId))
        ? prev.selectedUserIds.filter((id) => id !== String(targetId))
        : [...prev.selectedUserIds, String(targetId)];

      return {
        ...prev,
        selectedUserIds: nextSelectedUserIds,
        searchQuery: nextSelectedUserIds.includes(String(targetId)) && targetName ? '' : prev.searchQuery,
      };
    });
  };

  const runTaskAction = async (task, action) => {
    try {
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
      } else if (action === 'start') {
        try {
          await updateTaskStatus({
            taskId: task.id,
            status: 'in_progress',
            execute: () => taskAPI.startTask(task.id),
          });
        } catch (error) {
          console.warn('Start task API failed:', error);
        }
        if (typeof onStartTaskToWorkspace === 'function') {
          onStartTaskToWorkspace({ ...task, status: 'in_progress' });
        }
        // Move to Tools immediately after trying to persist status change.
        return;
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
        openSubmitModal(task);
        return;
      } else if (action === 'assign') {
        const idsRaw = (await showPrompt('Enter assignee user IDs (comma-separated):', {
          title: 'Assign Members',
          defaultValue: '',
        })) ?? '';
        if (!idsRaw.trim()) return;
        const ids = idsRaw.split(',').map((x) => Number(x.trim())).filter(Boolean);
        await taskAPI.assignTaskMembers(task.id, ids, 'Assigned from inbox');
      } else if (action === 'forward') {
        await openForwardModal(task);
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
      if (!['approve', 'need_improvement'].includes(action)) {
        await refreshTaskQueries();
      }
    } catch (error) {
      await showAlert(error?.response?.data?.detail || 'Action failed', { title: 'Action Failed' });
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
      return;
    }

    setIsMaximized((prev) => !prev);
  };

  return (
    <>
      <div className={`inbox-panel-overlay ${isMinimized ? 'disabled' : ''}`} onClick={!isMinimized ? onClose : undefined} />
      <div
        className={`inbox-panel-container ${isMinimized ? 'minimized' : ''} ${isMaximized ? 'maximized' : ''}`}
        onClick={(e) => e.stopPropagation()}
        style={minimizedWindowStyle || undefined}
      >
        {/* Header */}
        <div className="inbox-panel-header" onClick={isMinimized ? () => setIsMinimized(false) : undefined}>
          <h2>Inbox</h2>
          <div className="inbox-window-controls">
            {!isMinimized && (
              <button className="inbox-window-btn" onClick={(e) => { e.stopPropagation(); handleToggleMinimize(); }} title="Minimize">
                ─
              </button>
            )}
            <button className="inbox-window-btn" onClick={(e) => { e.stopPropagation(); handleToggleMaximize(); }} title={isMinimized ? 'Restore' : isMaximized ? 'Restore Window' : 'Maximize'}>
              {isMinimized ? '▢' : isMaximized ? '❐' : '□'}
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
          {isRefreshing ? <div className="inbox-refresh-bar" aria-hidden="true" /> : null}
          {loading ? (
            <InboxSkeleton />
          ) : isError && tasks.length === 0 ? (
            <div className="inbox-error-state">
              <div className="empty-icon">⚠️</div>
              <h3>Could not load inbox</h3>
              <p>There was a problem fetching your latest tasks.</p>
              <button type="button" className="inbox-retry-btn" onClick={() => void refetch()}>
                Retry
              </button>
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
            <div className="forward-modal-header">
              <div>
                <h3>Forward Task</h3>
                <p className="forward-modal-subtitle">Send this task to the right teammate with a clear handoff note.</p>
              </div>
            </div>

            <div className="forward-modal-task-card">
              <span className="forward-modal-task-label">Task</span>
              <p className="forward-modal-title">{forwardModal.task?.title}</p>
            </div>

            {forwardModal.loading ? (
              <p className="forward-modal-loading">Loading users...</p>
            ) : (
              <>
                <div className="forward-modal-section">
                  <label htmlFor="forward-target-search">Find teammate</label>
                  <input
                    id="forward-target-search"
                    type="text"
                    value={forwardModal.searchQuery}
                    onChange={(e) => setForwardModal((prev) => ({ ...prev, searchQuery: e.target.value }))}
                    placeholder="Search by name, department, position..."
                  />
                  <p className="forward-modal-hint">Click a result below to add more teammates to this forward action.</p>
                </div>

                <div className="forward-modal-section">
                  <div className="forward-modal-label-row">
                    <label>Selected teammates</label>
                    <span>{selectedForwardTargets.length} chosen</span>
                  </div>

                  {selectedForwardTargets.length > 0 ? (
                    <div className="forward-modal-selected-list">
                      {selectedForwardTargets.map((target) => (
                        <div key={target.id} className="forward-modal-target-card active">
                          <div className="forward-modal-target-copy">
                            <strong>{target.name}</strong>
                            <span>
                              {[target.department, target.position].filter(Boolean).join(' | ') || 'User'}
                            </span>
                          </div>
                          <button
                            type="button"
                            className="forward-modal-remove-btn"
                            onClick={() => toggleForwardRecipient(target.id)}
                          >
                            Remove
                          </button>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="forward-modal-target-card">
                      <strong>No teammate selected yet</strong>
                      <span>Choose one or more people from the matching list below.</span>
                    </div>
                  )}

                  {filteredForwardTargets.length > 0 && (
                    <div className="forward-modal-match-list">
                      {filteredForwardTargets.slice(0, 6).map((target) => {
                        const isActive = forwardModal.selectedUserIds.includes(String(target.id));
                        return (
                          <button
                            key={target.id}
                            type="button"
                            className={`forward-modal-match-chip ${isActive ? 'active' : ''}`}
                            onClick={() => toggleForwardRecipient(target.id, target.name || '')}
                          >
                            <strong>{target.name}</strong>
                            <span>{[target.department, target.position].filter(Boolean).join(' | ') || 'User'}</span>
                            <em>{isActive ? 'Selected' : 'Add member'}</em>
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>

                {!filteredForwardTargets.length && (
                  <p className="forward-modal-empty">No matching users found for your search.</p>
                )}

                <div className="forward-modal-section">
                  <div className="forward-modal-label-row">
                    <label htmlFor="forward-note-input">Forwarding note</label>
                    <span>Optional</span>
                  </div>
                  <textarea
                    id="forward-note-input"
                    rows={4}
                    value={forwardModal.comments}
                    onChange={(e) => setForwardModal((prev) => ({ ...prev, comments: e.target.value }))}
                    placeholder="Add context, instructions, or expectations for the next teammate..."
                  />
                </div>

                {forwardModal.error && <p className="forward-modal-error">{forwardModal.error}</p>}

                <div className="forward-modal-actions">
                  <button type="button" onClick={closeForwardModal}>Cancel</button>
                  <button
                    type="button"
                    className="primary"
                    disabled={forwardModal.selectedUserIds.length === 0 || forwardModal.submitting}
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

            <label>Attach Files Or Folder (PDF, video, audio, docs)</label>
            <div className="submit-file-actions">
              <button
                type="button"
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  openSubmitPicker('files');
                }}
              >
                Choose Files
              </button>
              <button
                type="button"
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  openSubmitPicker('folder');
                }}
              >
                Choose Folder
              </button>
            </div>
            {submitModal.attachments.length > 0 && (
              <div className="submit-attachment-list">
                {submitModal.attachments.map((file, idx) => (
                  <div key={`${getAttachmentDisplayName(file)}-${idx}`} className="submit-attachment-item">
                    <span>{getAttachmentDisplayName(file)} ({Math.max(1, Math.round(file.size / 1024))} KB)</span>
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
