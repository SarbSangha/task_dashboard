// src/components/leftsidebar/compofleftsidebar/inbox/InboxPanel.jsx
import React, { useState, useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import InboxCard from './InboxCard';
import TaskWorkflow from '../../../taskWorkflow/TaskWorkflow';
import TaskChatPanel from '../messagesystem/TaskChatPanel';
import { fileAPI, isRequestCanceled, taskAPI, subscribeRealtimeNotifications } from '../../../../services/api';
import { useAuth } from '../../../../context/AuthContext';
import { useCustomDialogs } from '../../../common/CustomDialogs';
import {
  getAttachmentDisplayName,
  mergeUniqueAttachments,
  openSystemFilePicker,
} from '../../../../utils/fileUploads';
import {
  buildTaskPanelCacheKey,
  setTaskPanelCache,
} from '../../../../utils/taskPanelCache';
import { useMinimizedWindowStack } from '../../../../hooks/useMinimizedWindowStack';
import { useInbox } from '../../../../hooks/useInbox';
import { useUpdateTaskStatus } from '../../../../hooks/useTaskActions';
import { InboxSkeleton } from '../../../ui/InboxSkeleton';
import './InboxPanel.css';

const isWorkflowTask = (task) => Boolean(task?.workflowEnabled);
const getActiveStageLabel = (task) => {
  if (!isWorkflowTask(task)) return '';
  const order = Number(task?.currentStageOrder || 0);
  const title = `${task?.currentStageTitle || ''}`.trim();
  if (order && title) return `Stage ${order}: ${title}`;
  if (order) return `Stage ${order}`;
  return title;
};

const InboxPanel = ({ isOpen, onClose, onStartTaskToWorkspace, onMinimizedChange, onActivate }) => {
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
    uploadProgress: {},
    uploadStatus: {},
  });
  const refreshTimerRef = React.useRef(null);
  const seenTaskIdsRef = React.useRef(new Set());
  const submitUploadControllersRef = React.useRef(new Map());
  const canceledSubmitUploadKeysRef = React.useRef(new Set());
  const submitAttachmentKeyMapRef = React.useRef(new WeakMap());
  const submitAttachmentKeySeqRef = React.useRef(0);
  const minimizedWindowStyle = useMinimizedWindowStack('inbox-panel', isOpen && isMinimized);
  const {
    data: inboxData,
    isLoading,
    isFetching,
    isError,
    refetch,
  } = useInbox({}, { enabled: isOpen });
  const tasks = inboxData?.tasks || [];
  const currentUserId = user?.id != null ? String(user.id) : '';
  const loading = isLoading;
  const isRefreshing = isFetching && !isLoading;
  const { mutateAsync: updateTaskStatus } = useUpdateTaskStatus();

  const getSubmitAttachmentKey = React.useCallback((file) => {
    if (!file || typeof file !== 'object') {
      return `attachment-${submitAttachmentKeySeqRef.current++}`;
    }
    if (!submitAttachmentKeyMapRef.current.has(file)) {
      const name = getAttachmentDisplayName(file);
      const size = Number(file?.size || 0);
      const lastModified = Number(file?.lastModified || 0);
      const relativePath = `${file?.webkitRelativePath || file?.relativePath || ''}`;
      const nextKey = `${name}:${size}:${lastModified}:${relativePath}:${submitAttachmentKeySeqRef.current++}`;
      submitAttachmentKeyMapRef.current.set(file, nextKey);
    }
    return submitAttachmentKeyMapRef.current.get(file);
  }, []);

  const getTaskFilterMeta = React.useCallback((task) => {
    const normalizedStatus = `${task?.status || ''}`.toLowerCase();
    const creatorId = task?.creator?.id ?? task?.creatorId;
    const submittedBy = task?.submittedBy;
    const assignedTo = Array.isArray(task?.assignedTo) ? task.assignedTo : [];
    const isCreatorTask = task?.myRole === 'creator'
      || (currentUserId !== '' && creatorId != null && String(creatorId) === currentUserId);
    const isAssignedToMe = currentUserId !== ''
      && assignedTo.some((person) => person?.id != null && String(person.id) === currentUserId);
    const isSubmittedByMe =
      currentUserId !== ''
      && submittedBy != null
      && String(submittedBy) === currentUserId;
    const isSelfAssignedTask = isCreatorTask && (
      isAssignedToMe
      || task?.myRole === 'assignee'
      || task?.myRole === 'creator'
    );

    return {
      normalizedStatus,
      isCreatorTask,
      isSelfAssignedTask,
      isSubmittedByMe,
      isParticipantTask: !isCreatorTask,
    };
  }, [currentUserId]);

  const doesTaskMatchFilter = React.useCallback((task, currentFilter) => {
    const {
      normalizedStatus,
      isCreatorTask,
      isSelfAssignedTask,
      isSubmittedByMe,
      isParticipantTask,
    } = getTaskFilterMeta(task);

    if (currentFilter === 'unread') return !(task?.isRead ?? false);
    if (currentFilter === 'self_assigned') return isSelfAssignedTask;
    if (currentFilter === 'working') return ['assigned', 'in_progress', 'need_improvement'].includes(normalizedStatus);
    if (currentFilter === 'submitted') {
      return normalizedStatus === 'submitted' && (isSubmittedByMe || isParticipantTask);
    }
    if (currentFilter === 'result') return normalizedStatus === 'submitted' && isCreatorTask;
    if (currentFilter === 'need_improvement') return normalizedStatus === 'need_improvement';
    if (currentFilter === 'final_result') return ['approved', 'completed'].includes(normalizedStatus);
    return true;
  }, [getTaskFilterMeta]);

  const getFilterCount = React.useCallback(
    (currentFilter) => tasks.filter((task) => doesTaskMatchFilter(task, currentFilter)).length,
    [doesTaskMatchFilter, tasks],
  );

  useEffect(() => {
    onMinimizedChange?.(isOpen && isMinimized);
  }, [isMinimized, isOpen, onMinimizedChange]);

  const refreshTaskQueries = React.useCallback(async () => {
    const userKey = user?.id ?? 'anonymous';
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['inbox', userKey] }),
      queryClient.invalidateQueries({ queryKey: ['outbox', userKey] }),
      queryClient.invalidateQueries({ queryKey: ['tracking', userKey] }),
    ]);
  }, [queryClient, user?.id]);

  const markTaskSeen = React.useCallback(async (task) => {
    if (!task?.id || task.isRead || seenTaskIdsRef.current.has(task.id)) {
      return;
    }

    seenTaskIdsRef.current.add(task.id);

    const userKey = user?.id ?? 'anonymous';
    let nextTasksForCache = null;
    let nextUnreadCount = null;

    queryClient.setQueriesData({ queryKey: ['inbox', userKey] }, (current) => {
      if (!current || !Array.isArray(current.tasks)) {
        return current;
      }

      let changed = false;
      const nextTasks = current.tasks.map((entry) => {
        if (entry?.id !== task.id || entry?.isRead) {
          return entry;
        }
        changed = true;
        return {
          ...entry,
          isRead: true,
        };
      });

      if (!changed) {
        return current;
      }

      nextTasksForCache = nextTasks;
      nextUnreadCount = typeof current.unreadCount === 'number'
        ? Math.max(0, current.unreadCount - 1)
        : nextTasks.filter((entry) => !entry?.isRead).length;

      return {
        ...current,
        tasks: nextTasks,
        unreadCount: nextUnreadCount,
      };
    });

    if (user?.id && Array.isArray(nextTasksForCache)) {
      setTaskPanelCache(buildTaskPanelCacheKey(user.id, 'inbox'), {
        tasks: nextTasksForCache,
      });
    }
    if (user?.id && typeof nextUnreadCount === 'number') {
      setTaskPanelCache(buildTaskPanelCacheKey(user.id, 'inbox_unread_count'), {
        unreadCount: nextUnreadCount,
      });
    }

    try {
      await taskAPI.markSeen(task.id);
    } catch (error) {
      seenTaskIdsRef.current.delete(task.id);
      await refreshTaskQueries();
      console.warn('Mark seen failed:', error);
    }
  }, [queryClient, refreshTaskQueries, user?.id]);

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
      uploadProgress: {},
      uploadStatus: {},
    });
  };

  const closeSubmitModal = () => {
    submitUploadControllersRef.current.forEach((controller) => controller.abort());
    submitUploadControllersRef.current.clear();
    canceledSubmitUploadKeysRef.current.clear();
    submitAttachmentKeyMapRef.current = new WeakMap();
    submitAttachmentKeySeqRef.current = 0;
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
      uploadProgress: {},
      uploadStatus: {},
    });
  };

  const cancelSubmitAttachment = (index) => {
    setSubmitModal((prev) => {
      const target = prev.attachments[index];
      if (!target) return prev;
      const key = getSubmitAttachmentKey(target);
      if (prev.submitting) {
        canceledSubmitUploadKeysRef.current.add(key);
        const activeController = submitUploadControllersRef.current.get(key);
        if (activeController) {
          activeController.abort();
        }
      }

      const nextAttachments = prev.attachments.filter((_, itemIndex) => itemIndex !== index);
      const nextUploadProgress = { ...prev.uploadProgress };
      const nextUploadStatus = { ...prev.uploadStatus };
      delete nextUploadProgress[key];
      delete nextUploadStatus[key];

      return {
        ...prev,
        attachments: nextAttachments,
        uploadProgress: nextUploadProgress,
        uploadStatus: nextUploadStatus,
      };
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
    cancelSubmitAttachment(index);
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
      const selectedAttachments = [...submitModal.attachments];
      if (selectedAttachments.length > 0) {
        for (let index = 0; index < selectedAttachments.length; index += 1) {
          const file = selectedAttachments[index];
          const key = getSubmitAttachmentKey(file);
          if (canceledSubmitUploadKeysRef.current.has(key)) {
            continue;
          }

          const controller = new AbortController();
          submitUploadControllersRef.current.set(key, controller);
          setSubmitModal((prev) => ({
            ...prev,
            uploadProgress: {
              ...prev.uploadProgress,
              [key]: 0,
            },
            uploadStatus: {
              ...prev.uploadStatus,
              [key]: 'uploading',
            },
          }));

          try {
            const uploadRes = await fileAPI.uploadFiles([file], {
              signal: controller.signal,
              onFileProgress: ({ percent }) => {
                setSubmitModal((prev) => ({
                  ...prev,
                  uploadProgress: {
                    ...prev.uploadProgress,
                    [key]: percent,
                  },
                }));
              },
            });
            uploadedAttachments = [...uploadedAttachments, ...(uploadRes?.data || [])];
            setSubmitModal((prev) => ({
              ...prev,
              uploadProgress: {
                ...prev.uploadProgress,
                [key]: 100,
              },
              uploadStatus: {
                ...prev.uploadStatus,
                [key]: 'uploaded',
              },
            }));
          } catch (error) {
            if (isRequestCanceled(error)) {
              setSubmitModal((prev) => ({
                ...prev,
                uploadStatus: {
                  ...prev.uploadStatus,
                  [key]: 'canceled',
                },
              }));
              continue;
            }
            throw error;
          } finally {
            submitUploadControllersRef.current.delete(key);
          }
        }
      }

      const hasFinalPayload =
        submitModal.resultText.trim()
        || submitModal.links.length > 0
        || uploadedAttachments.length > 0;
      if (!hasFinalPayload) {
        setSubmitModal((prev) => ({
          ...prev,
          submitting: false,
          error: 'All selected uploads were canceled. Add result text, links, or keep at least one file.',
        }));
        return;
      }

      await updateTaskStatus({
        taskId: task.id,
        status: 'submitted',
        execute: () =>
          (isWorkflowTask(task) && task.currentStageId
            ? taskAPI.submitStage(task.id, task.currentStageId, {
                result_text: submitModal.resultText.trim(),
                comments: submitModal.comments.trim(),
                result_links: submitModal.links,
                result_attachments: uploadedAttachments,
              })
            : taskAPI.submitTask(task.id, {
                result_text: submitModal.resultText.trim(),
                comments: submitModal.comments.trim(),
                result_links: submitModal.links,
                result_attachments: uploadedAttachments,
              })),
      });

      closeSubmitModal();
    } catch (error) {
      setSubmitModal((prev) => ({
        ...prev,
        submitting: false,
        error: error?.response?.data?.detail || error?.message || 'Submit failed',
      }));
    } finally {
      submitUploadControllersRef.current.clear();
      canceledSubmitUploadKeysRef.current.clear();
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
      void markTaskSeen(task);
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
        const description = await showPrompt('Update task description:', {
          title: 'Edit Task',
          defaultValue: task.description || '',
        });
        if (description === null) return;
        await taskAPI.editTask(task.id, { description });
      } else if (action === 'edit_result') {
        const result = await showPrompt('Update result text:', {
          title: 'Edit Result',
          defaultValue: task.resultText || '',
        });
        if (result === null) return;
        await taskAPI.editResult(task.id, result);
      }
      if (!['approve', 'need_improvement'].includes(action)) {
        await refreshTaskQueries();
      }
    } catch (error) {
      await showAlert(error?.response?.data?.detail || 'Action failed', { title: 'Action Failed' });
    }
  };

  const filteredTasks = tasks.filter((task) => doesTaskMatchFilter(task, filter));

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
      onActivate?.();
      setIsMinimized(false);
      setIsMaximized(true);
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
        <div className="inbox-panel-header" onClick={isMinimized ? restoreWindow : undefined}>
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
            Unread ({getFilterCount('unread')})
          </button>
          <button 
            className={`filter-btn ${filter === 'self_assigned' ? 'active' : ''}`}
            onClick={() => setFilter('self_assigned')}
          >
            Self Assigned ({getFilterCount('self_assigned')})
          </button>
          <button 
            className={`filter-btn ${filter === 'working' ? 'active' : ''}`}
            onClick={() => setFilter('working')}
          >
            Working ({getFilterCount('working')})
          </button>
          <button 
            className={`filter-btn ${filter === 'submitted' ? 'active' : ''}`}
            onClick={() => setFilter('submitted')}
          >
            Submitted ({getFilterCount('submitted')})
          </button>
          <button 
            className={`filter-btn ${filter === 'result' ? 'active' : ''}`}
            onClick={() => setFilter('result')}
          >
            Result ({getFilterCount('result')})
          </button>
          <button 
            className={`filter-btn ${filter === 'need_improvement' ? 'active' : ''}`}
            onClick={() => setFilter('need_improvement')}
          >
            Need Improvement ({getFilterCount('need_improvement')})
          </button>
          <button 
            className={`filter-btn ${filter === 'final_result' ? 'active' : ''}`}
            onClick={() => setFilter('final_result')}
          >
            Completed ({getFilterCount('final_result')})
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
                  onMarkSeen={markTaskSeen}
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
        <div className="forward-modal-overlay" onClick={submitModal.submitting ? undefined : closeSubmitModal}>
          <div className="submit-modal" onClick={(e) => e.stopPropagation()}>
            <h3>{isWorkflowTask(submitModal.task) ? 'Submit Stage Result' : 'Submit Task Result'}</h3>
            <p className="submit-modal-subtitle">{submitModal.task?.title}</p>

            <div className="submit-task-info">
              <p><strong>Task ID:</strong> {submitModal.task?.taskNumber || '-'}</p>
              <p><strong>Project ID:</strong> {submitModal.task?.projectId || '-'}</p>
              <p><strong>Creator:</strong> {submitModal.task?.creator?.name || 'Unknown'}</p>
              {isWorkflowTask(submitModal.task) && (
                <p><strong>Active Stage:</strong> {getActiveStageLabel(submitModal.task) || 'Current stage'}</p>
              )}
            </div>

            <label htmlFor="submit-result-text">
              {isWorkflowTask(submitModal.task) ? 'Stage Output Details' : 'Result Details'}
            </label>
            <textarea
              id="submit-result-text"
              rows={4}
              value={submitModal.resultText}
              onChange={(e) => setSubmitModal((prev) => ({ ...prev, resultText: e.target.value }))}
              placeholder={
                isWorkflowTask(submitModal.task)
                  ? 'Summarize what this stage completed, what the next stage should use, and any important handoff notes...'
                  : 'Add result summary, steps completed, and outcome...'
              }
            />

            <label htmlFor="submit-result-notes">
              {isWorkflowTask(submitModal.task) ? 'Handoff Note (optional)' : 'Submission Note (optional)'}
            </label>
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
                disabled={submitModal.submitting}
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
                disabled={submitModal.submitting}
              >
                Choose Folder
              </button>
            </div>
            {submitModal.attachments.length > 0 && (
              <div className="submit-attachment-list">
                {submitModal.attachments.map((file, idx) => {
                  const attachmentKey = getSubmitAttachmentKey(file);
                  const uploadStatus = submitModal.uploadStatus?.[attachmentKey] || (submitModal.submitting ? 'queued' : 'pending');
                  const uploadProgress = submitModal.uploadProgress?.[attachmentKey] || 0;
                  const uploadLabel = uploadStatus === 'uploading'
                    ? `Uploading ${uploadProgress}%`
                    : uploadStatus === 'uploaded'
                      ? 'Uploaded'
                      : uploadStatus === 'queued'
                        ? 'Queued'
                        : 'Ready';

                  return (
                  <div key={attachmentKey} className="submit-attachment-item">
                    <div className="submit-attachment-copy">
                      <span>{getAttachmentDisplayName(file)} ({Math.max(1, Math.round(file.size / 1024))} KB)</span>
                      <small>{uploadLabel}</small>
                    </div>
                    <button type="button" onClick={() => removeSubmitAttachment(idx)}>
                      {submitModal.submitting ? (uploadStatus === 'uploading' ? 'Cancel Upload' : 'Cancel File') : 'Remove'}
                    </button>
                  </div>
                )})}
              </div>
            )}

            {submitModal.error && <p className="forward-modal-error">{submitModal.error}</p>}

            <div className="forward-modal-actions">
              <button type="button" onClick={closeSubmitModal} disabled={submitModal.submitting}>Cancel</button>
              <button
                type="button"
                className="primary"
                disabled={submitModal.submitting}
                onClick={submitTaskFromModal}
              >
                {submitModal.submitting ? 'Submitting...' : (isWorkflowTask(submitModal.task) ? 'Submit Stage' : 'Submit Result')}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
};

export default InboxPanel;
