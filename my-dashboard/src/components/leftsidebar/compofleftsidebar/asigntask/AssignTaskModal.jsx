// src/components/leftsidebar/compofleftsidebar/AssignTaskModal.jsx
import React, { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import './AssignTaskModal.css';
import AttachmentBox from './Attachments';
import TaskForm from './LinkArea';
import { taskAPI, draftAPI, authAPI, fileAPI, clientsAPI } from '../../../../services/api';
import { useCustomDialogs } from '../../../common/CustomDialogs';
import { useAuth } from '../../../../context/AuthContext';
import CacheStatusBanner from '../../../common/CacheStatusBanner';
import {
  buildTaskPanelCacheKey,
  getTaskPanelCache,
  getTaskPanelCacheEntry,
  invalidateTaskPanelCache,
  setTaskPanelCache,
} from '../../../../utils/taskPanelCache';
import { useMinimizedWindowStack } from '../../../../hooks/useMinimizedWindowStack';
import { isMobileViewport } from '../../../../utils/isMobileViewport';
import WindowControls from '../../../common/WindowControls';
import { formatDateTimeLocalInputIndia } from '../../../../utils/dateTime';

const TASK_TAG_OPTIONS = [
  'Gen Ai Frames',
  'Gen Ai Vedio',
  'Image and Video',
  'Graphic Design',
  'Video Editing',
  'Motion Graphics',
  'Social Media',
  'Script',
  'Animation',
  'Audio',
  'Video',
  'Content',
  'Banner',
  'Thumbnail',
  'Others',
];

const PRIORITY_OPTIONS = [
  { value: 'High', tone: 'high', hint: 'Time-sensitive - jump the queue' },
  { value: 'Medium', tone: 'medium', hint: 'Normal turnaround' },
  { value: 'Low', tone: 'low', hint: 'No rush' },
];

const ASSIGN_REFERENCE_CACHE_TTL_MS = 5 * 60 * 1000;
const ASSIGN_DEPARTMENT_USERS_CACHE_TTL_MS = 3 * 60 * 1000;
const createEmptyWorkflowStage = (order = 1) => ({
  order,
  title: `Stage ${order}`,
  description: '',
  approvalRequired: false,
  assigneeIds: [],
  approverIds: [],
  approvalMode: 'any',
});

const normalizeUserId = (value) => {
  const numericValue = Number(value);
  return Number.isInteger(numericValue) && numericValue > 0 ? numericValue : null;
};

const normalizeUserIds = (values = []) => (
  Array.from(new Set(
    (Array.isArray(values) ? values : [])
      .map(normalizeUserId)
      .filter(Boolean)
  ))
);

const getMinimumDeadlineInputValue = () => formatDateTimeLocalInputIndia(new Date());

// Quick-pick deadline shortcuts - end of day N days out, IST, so "Tomorrow"
// means end of tomorrow rather than exactly-24-hours-from-now (which drifts
// into an odd time of day depending on when the task happens to be created).
const getQuickDeadlineValue = (daysFromNow) => {
  const target = new Date();
  target.setDate(target.getDate() + daysFromNow);
  target.setHours(18, 0, 0, 0);
  return formatDateTimeLocalInputIndia(target);
};

// "EOD" - today's date, 6:30 PM specifically (half an hour later than the
// other quick-picks' end-of-day time), per how this team actually defines
// end-of-day for same-day deadlines.
const getEndOfDayDeadlineValue = () => {
  const target = new Date();
  target.setHours(18, 30, 0, 0);
  return formatDateTimeLocalInputIndia(target);
};

const validateDeadlineNotInPast = (deadlineValue) => {
  const value = `${deadlineValue || ''}`.trim();
  if (!value) return true;
  const selectedDate = new Date(value);
  if (Number.isNaN(selectedDate.getTime())) return false;
  return selectedDate.getTime() >= Date.now() - 60 * 1000;
};

const getStageAssigneeIds = (stage = {}) => normalizeUserIds([
  ...(Array.isArray(stage.assigneeIds) ? stage.assigneeIds : []),
  ...(Array.isArray(stage.assignees) ? stage.assignees.map((assignee) => assignee?.id) : []),
]);

// Approvers are sourced separately from assignees (any company user, not
// just people already on the task's receiver list - see the department
// browser reused for this in the Stage Setup card below).
const getStageApproverIds = (stage = {}) => normalizeUserIds([
  ...(Array.isArray(stage.approverIds) ? stage.approverIds : []),
  ...(Array.isArray(stage.approvers) ? stage.approvers.map((approver) => approver?.id) : []),
]);

const normalizeApprovalMode = (value) => (`${value || ''}`.trim().toLowerCase() === 'all' ? 'all' : 'any');

const buildWorkflowSnapshot = (formData = {}) => {
  const workflowStages = Array.isArray(formData.workflowStages) ? formData.workflowStages : [];
  return JSON.stringify({
    workflowEnabled: Boolean(formData.workflowEnabled),
    finalApprovalRequired: Boolean(formData.finalApprovalRequired),
    workflowStages: workflowStages.map((stage, index) => ({
      order: Number(stage?.order || index + 1),
      title: `${stage?.title || ''}`.trim(),
      description: `${stage?.description || ''}`.trim(),
      approvalRequired: Boolean(stage?.approvalRequired),
      assigneeIds: getStageAssigneeIds(stage).sort((left, right) => left - right),
      approverIds: getStageApproverIds(stage).sort((left, right) => left - right),
      approvalMode: normalizeApprovalMode(stage?.approvalMode),
    })),
  });
};

const buildDirtySnapshot = (formData = {}) => {
  const attachments = Array.isArray(formData.attachments) ? formData.attachments : [];
  const links = Array.isArray(formData.links) ? formData.links : [];
  const workflowStages = Array.isArray(formData.workflowStages) ? formData.workflowStages : [];

  return JSON.stringify({
    projectName: `${formData.projectName || ''}`.trim(),
    taskId: `${formData.taskId || ''}`.trim(),
    projectId: `${formData.projectId || ''}`.trim(),
    projectIdRaw: `${formData.projectIdRaw || ''}`.trim(),
    projectIdHex: `${formData.projectIdHex || ''}`.trim(),
    customerName: `${formData.customerName || ''}`.trim(),
    taskName: `${formData.taskName || ''}`.trim(),
    reference: `${formData.reference || ''}`.trim(),
    toDepartment: `${formData.toDepartment || ''}`.trim(),
    deadline: `${formData.deadline || ''}`.trim(),
    priority: `${formData.priority || ''}`.trim(),
    taskDetails: `${formData.taskDetails || ''}`.trim(),
    taskTag: `${formData.taskTag || ''}`.trim(),
    taskType: `${formData.taskType || ''}`.trim(),
    workflowEnabled: Boolean(formData.workflowEnabled),
    finalApprovalRequired: Boolean(formData.finalApprovalRequired),
    submissionMode: formData.submissionMode === 'any' ? 'any' : 'all',
    approverIds: normalizeUserIds(formData.approverIds).sort((left, right) => left - right),
    approvalMode: normalizeApprovalMode(formData.approvalMode),
    selectedUserIds: (Array.isArray(formData.selectedUserIds) ? formData.selectedUserIds : [])
      .map((value) => `${value || ''}`)
      .sort(),
    attachments: attachments.map((file) => ({
      name: `${file?.name || file?.filename || file?.original_name || ''}`.trim(),
      size: Number(file?.size || 0),
      url: `${file?.url || ''}`.trim(),
    })),
    links: links.map((link) => {
      if (typeof link === 'string') {
        return `${link}`.trim();
      }

      return {
        title: `${link?.title || ''}`.trim(),
        url: `${link?.url || ''}`.trim(),
      };
    }),
    workflowStages: workflowStages.map((stage, index) => ({
      order: Number(stage?.order || index + 1),
      title: `${stage?.title || ''}`.trim(),
      description: `${stage?.description || ''}`.trim(),
      approvalRequired: Boolean(stage?.approvalRequired),
      assigneeIds: getStageAssigneeIds(stage).sort((left, right) => left - right),
      approverIds: getStageApproverIds(stage).sort((left, right) => left - right),
      approvalMode: normalizeApprovalMode(stage?.approvalMode),
    })),
  });
};

const createEmptyFormData = (myDepartment = '') => ({
  projectName: '',
  taskId: '',
  projectId: '',
  projectIdRaw: '',
  projectIdHex: '',
  customerName: '',
  taskName: '',
  reference: '',
  myDepartment: myDepartment || '',
  selectedUserIds: [],
  toDepartment: 'Gen Ai',
  deadline: '',
  priority: 'High',
  taskDetails: '',
  taskTag: '',
  taskType: 'task',
  attachments: [],
  links: [],
  submissionMode: 'all',
  // Designated approver(s) for the normal (non-staged) flow - e.g. someone
  // who self-assigns wants a specific person to sign off instead of
  // relying on the default creator/HOD/SPOC approval. See the "Task
  // Approvers" section shown for single-step tasks below.
  approverIds: [],
  approvalMode: 'any',
  workflowEnabled: false,
  finalApprovalRequired: false,
  workflowStages: [],
});

const isMeaningfulWorkflowStage = (stage) => {
  const title = `${stage?.title || ''}`.trim();
  const description = `${stage?.description || ''}`.trim();
  const assigneeIds = Array.isArray(stage?.assigneeIds) ? stage.assigneeIds.filter(Boolean) : [];
  const defaultStageTitle = /^stage\s+\d+$/i.test(title);
  return Boolean(description || stage?.approvalRequired || assigneeIds.length || (title && !defaultStageTitle));
};

const createInitialSubmitUploadState = () => ({
  active: false,
  phase: '',
  fileCount: 0,
  uploadedBytes: 0,
  totalBytes: 0,
  percent: 0,
  currentFileName: '',
  currentFileIndex: 0,
  currentFileUploadedBytes: 0,
  currentFileTotalBytes: 0,
  currentFilePercent: 0,
});

const getUploadBytesTotal = (files = []) =>
  files.reduce((sum, file) => sum + Math.max(Number(file?.size) || 0, 0), 0);

const toUploadPercent = (loaded = 0, total = 0) => {
  if (!total) return 0;
  return Math.min(100, Math.round((loaded * 100) / total));
};

const formatUploadSize = (bytes = 0) => {
  const safeBytes = Number.isFinite(bytes) ? Math.max(bytes, 0) : 0;
  if (safeBytes < 1024) return `${safeBytes} B`;

  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = safeBytes / 1024;
  let unitIndex = 0;

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  const decimals = value >= 100 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toFixed(decimals)} ${units[unitIndex]}`;
};

const AssignTaskModal = forwardRef(({ isOpen, onClose, editingTask = null, onMinimizedChange, onActivate }, ref) => {
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const { showConfirm } = useCustomDialogs();
  const isDraftEdit = Boolean(editingTask && `${editingTask.status || ''}`.toLowerCase() === 'draft');
  const isTaskEditMode = Boolean(editingTask && !isDraftEdit);
  // Form state
  const [formData, setFormData] = useState(createEmptyFormData());

  // NEW: Department and user data
  const [departments, setDepartments] = useState([]);
  const [departmentUsers, setDepartmentUsers] = useState([]);
  // Independent department browser for the Stage Approvers pickers - see
  // loadApproverDepartmentUsers for why this is separate from
  // departmentUsers/formData.toDepartment (the receiver pool's browser).
  const [approverBrowseDepartment, setApproverBrowseDepartment] = useState('');
  const [approverDepartmentUsers, setApproverDepartmentUsers] = useState([]);
  const [loadingApproverUsers, setLoadingApproverUsers] = useState(false);
  const [knownUsersById, setKnownUsersById] = useState({});
  const [loadingUsers, setLoadingUsers] = useState(false);
  const [showUserDropdown, setShowUserDropdown] = useState(false);
  const [projectIdState, setProjectIdState] = useState({ status: 'idle', message: '' });
  const [taskIdState, setTaskIdState] = useState({ status: 'idle', message: '' });
  const [taskIdSuggestions, setTaskIdSuggestions] = useState([]);
  const [projectIdSuggestions, setProjectIdSuggestions] = useState([]);
  const [projectNameSuggestions, setProjectNameSuggestions] = useState([]);
  const [clientOptions, setClientOptions] = useState([]);
  const [knownProjects, setKnownProjects] = useState({});
  const [currentUserDepartment, setCurrentUserDepartment] = useState('');
  const [isReferenceRefreshing, setIsReferenceRefreshing] = useState(false);
  const [cacheStatus, setCacheStatus] = useState({
    showingCached: false,
    cachedAt: 0,
    liveUpdatedAt: 0,
  });

  const [isSaving, setIsSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState('');
  const [submitUploadState, setSubmitUploadState] = useState(createInitialSubmitUploadState);
  const [currentDraftId, setCurrentDraftId] = useState(null);
  const [isMinimized, setIsMinimized] = useState(false);
  const [isMaximized, setIsMaximized] = useState(isMobileViewport);
  const allowNavigationRef = useRef(false);
  const initialFormSnapshotRef = useRef(buildDirtySnapshot(createEmptyFormData()));
  const initialWorkflowSnapshotRef = useRef(buildWorkflowSnapshot(createEmptyFormData()));
  const latestFormDataRef = useRef(formData);
  const currentDraftIdRef = useRef(null);
  const draftSaveInFlightRef = useRef(false);
  const closeConfirmationInFlightRef = useRef(false);
  const lastAutoSaveSnapshotRef = useRef('');
  const minimizedWindowStyle = useMinimizedWindowStack('assign-task-modal', isOpen && isMinimized);

  const updateCurrentDraftId = useCallback((draftId) => {
    const normalizedDraftId = draftId ? Number(draftId) : null;
    currentDraftIdRef.current = normalizedDraftId;
    setCurrentDraftId(normalizedDraftId);
  }, []);

  useEffect(() => {
    latestFormDataRef.current = formData;
  }, [formData]);

  const cacheKeys = useMemo(() => {
    if (!user?.id) return null;
    return {
      bootstrap: buildTaskPanelCacheKey(user.id, 'assign_task_bootstrap'),
      departmentUsers: (departmentName) =>
        buildTaskPanelCacheKey(user.id, `assign_task_department_${String(departmentName || '').toLowerCase()}`),
    };
  }, [user?.id]);

  useEffect(() => {
    onMinimizedChange?.(isOpen && isMinimized);
  }, [isMinimized, isOpen, onMinimizedChange]);

  // ✅ ADDED: showMessage helper function
  const showMessage = (message, type) => {
    setSaveMessage({ text: message, type });
    setTimeout(() => setSaveMessage(''), 3000);
  };

  const normalizeDepartmentName = (departmentName, departmentOptions = departments) => {
    const value = `${departmentName || ''}`.trim();
    if (!value) return '';
    const match = (departmentOptions || []).find(
      (department) => `${department || ''}`.trim().toLowerCase() === value.toLowerCase()
    );
    return match || value;
  };

  const rememberUsers = useCallback((users = []) => {
    if (!Array.isArray(users) || users.length === 0) return;
    setKnownUsersById((prev) => {
      const next = { ...prev };
      users.forEach((entry) => {
        const userId = normalizeUserId(entry?.id);
        if (!userId) return;
        next[userId] = { ...entry, id: userId };
      });
      return next;
    });
  }, []);

  // NEW: Load current user and departments on mount
  useEffect(() => {
    if (!isOpen || !cacheKeys) return;

    const cachedBootstrapEntry = getTaskPanelCacheEntry(cacheKeys.bootstrap, ASSIGN_REFERENCE_CACHE_TTL_MS);
    const cachedBootstrap = cachedBootstrapEntry?.value || null;
    if (cachedBootstrap) {
      if (!editingTask && cachedBootstrap.myDepartment) {
        setFormData((prev) => ({
          ...prev,
          myDepartment: prev.myDepartment || cachedBootstrap.myDepartment,
        }));
      }
      setDepartments(cachedBootstrap.departments || []);
      setTaskIdSuggestions(cachedBootstrap.taskIdSuggestions || []);
      setProjectIdSuggestions(cachedBootstrap.projectIdSuggestions || []);
      setProjectNameSuggestions(cachedBootstrap.projectNameSuggestions || []);
      setKnownProjects(cachedBootstrap.knownProjects || {});
      setCacheStatus({
        showingCached: true,
        cachedAt: cachedBootstrapEntry?.cachedAt || 0,
        liveUpdatedAt: 0,
      });
    }

    if (!cachedBootstrap) {
      void loadBootstrapData();
    }
  }, [cacheKeys, editingTask, isOpen]);

  // Populates the Customer Name dropdown from Admin Queue > Manage Clients.
  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    clientsAPI.getClientsForTasks()
      .then((response) => {
        if (cancelled) return;
        setClientOptions(Array.isArray(response?.clients) ? response.clients : []);
      })
      .catch((error) => {
        console.warn('Unable to load client list:', error);
      });
    return () => { cancelled = true; };
  }, [isOpen]);

  const fetchIdSuggestions = async () => {
    const response = await taskAPI.getTaskReferenceSuggestions();
    return {
      taskIdSuggestions: Array.isArray(response?.taskIdSuggestions) ? response.taskIdSuggestions : [],
      projectIdSuggestions: Array.isArray(response?.projectIdSuggestions) ? response.projectIdSuggestions : [],
      projectNameSuggestions: Array.isArray(response?.projectNameSuggestions) ? response.projectNameSuggestions : [],
      knownProjects: response?.knownProjects || {},
    };
  };

  const loadBootstrapData = async ({ silent = false } = {}) => {
    if (!cacheKeys) return;

    if (silent) {
      setIsReferenceRefreshing(true);
    }
    try {
      const departmentsResponse = await authAPI.getDepartments().catch(() => ({ departments: [] }));
      const myDepartment = user?.department || '';
      const nextDepartments = departmentsResponse?.departments || [];
      setCurrentUserDepartment(myDepartment);
      if ((!editingTask || !formData.myDepartment) && myDepartment) {
        setFormData((prev) => ({
          ...prev,
          myDepartment: prev.myDepartment || myDepartment,
        }));
      }
      setDepartments(nextDepartments);
      setFormData((prev) => ({
        ...prev,
        myDepartment: prev.myDepartment
          ? normalizeDepartmentName(prev.myDepartment, nextDepartments)
          : (myDepartment ? normalizeDepartmentName(myDepartment, nextDepartments) : ''),
        toDepartment: prev.toDepartment
          ? normalizeDepartmentName(prev.toDepartment, nextDepartments)
          : prev.toDepartment,
      }));
      setTaskPanelCache(cacheKeys.bootstrap, {
        myDepartment,
        departments: nextDepartments,
        taskIdSuggestions: [],
        projectIdSuggestions: [],
        projectNameSuggestions: [],
        knownProjects: {},
      });
      setCacheStatus((prev) => ({
        showingCached: false,
        cachedAt: prev.cachedAt,
        liveUpdatedAt: Date.now(),
      }));

      try {
        const suggestions = await fetchIdSuggestions();
        setTaskIdSuggestions(suggestions.taskIdSuggestions || []);
        setProjectIdSuggestions(suggestions.projectIdSuggestions || []);
        setProjectNameSuggestions(suggestions.projectNameSuggestions || []);
        setKnownProjects(suggestions.knownProjects || {});
        setTaskPanelCache(cacheKeys.bootstrap, {
          myDepartment,
          departments: nextDepartments,
          ...suggestions,
        });
      } catch (suggestionError) {
        console.warn('Unable to load Assign Task suggestions:', suggestionError);
      }
    } catch (error) {
      console.warn('Unable to load Assign Task bootstrap data:', error);
      if (!silent) {
        setTaskIdSuggestions([]);
        setProjectIdSuggestions([]);
        setProjectNameSuggestions([]);
        setKnownProjects({});
      }
    } finally {
      if (silent) {
        setIsReferenceRefreshing(false);
      }
    }
  };

  // NEW: Load users when department changes
  const loadDepartmentUsers = async (departmentName) => {
    const normalizedDepartment = normalizeDepartmentName(departmentName);
    if (!normalizedDepartment) {
      setDepartmentUsers([]);
      return;
    }

    const cacheKey = cacheKeys?.departmentUsers(normalizedDepartment);
    const cachedUsers = cacheKey
      ? getTaskPanelCache(cacheKey, ASSIGN_DEPARTMENT_USERS_CACHE_TTL_MS)
      : null;

    if (cachedUsers?.users) {
      setDepartmentUsers(cachedUsers.users);
      rememberUsers(cachedUsers.users);
      setLoadingUsers(false);
      return;
    }
    setLoadingUsers(true);
    try {
      const response = await authAPI.getUsersByDepartment(normalizedDepartment);
      if (response.users) {
        setDepartmentUsers(response.users);
        rememberUsers(response.users);
        if (cacheKey) {
          setTaskPanelCache(cacheKey, {
            users: response.users,
          });
        }
      }
    } catch (error) {
      console.error('Error loading department users:', error);
      if (!cachedUsers?.users) {
        showMessage('Failed to load users', 'error');
      }
    } finally {
      setLoadingUsers(false);
    }
  };

  // Approvers browse departments independently of the receiver pool above -
  // otherwise picking an approver from a different department than the one
  // currently browsed for receivers meant scrolling all the way back up to
  // Step 1, changing it there (which also disturbs the receiver list's own
  // department view), then scrolling back down to the stage card. Shares
  // the same department-users cache key as loadDepartmentUsers (keyed only
  // by department name) so browsing the same department for both never
  // double-fetches.
  const loadApproverDepartmentUsers = async (departmentName) => {
    const normalizedDepartment = normalizeDepartmentName(departmentName);
    if (!normalizedDepartment) {
      setApproverDepartmentUsers([]);
      return;
    }

    const cacheKey = cacheKeys?.departmentUsers(normalizedDepartment);
    const cachedUsers = cacheKey
      ? getTaskPanelCache(cacheKey, ASSIGN_DEPARTMENT_USERS_CACHE_TTL_MS)
      : null;

    if (cachedUsers?.users) {
      setApproverDepartmentUsers(cachedUsers.users);
      rememberUsers(cachedUsers.users);
      setLoadingApproverUsers(false);
      return;
    }
    setLoadingApproverUsers(true);
    try {
      const response = await authAPI.getUsersByDepartment(normalizedDepartment);
      if (response.users) {
        setApproverDepartmentUsers(response.users);
        rememberUsers(response.users);
        if (cacheKey) {
          setTaskPanelCache(cacheKey, {
            users: response.users,
          });
        }
      }
    } catch (error) {
      console.error('Error loading approver department users:', error);
      if (!cachedUsers?.users) {
        showMessage('Failed to load users', 'error');
      }
    } finally {
      setLoadingApproverUsers(false);
    }
  };

  // Initialize form when modal opens.
  useEffect(() => {
    if (!isOpen) return;

    if (editingTask) {
      const selectedUserIds = Array.isArray(editingTask.selectedUserIds)
        ? normalizeUserIds(editingTask.selectedUserIds)
        : normalizeUserIds((editingTask.assignedTo || []).map((u) => u.id));
      const mappedWorkflowStages = Array.isArray(editingTask.workflowStages) && editingTask.workflowStages.length > 0
        ? editingTask.workflowStages.map((stage, index) => ({
            order: Number(stage.order || stage.stageOrder || index + 1),
            title: stage.title || stage.stageTitle || `Stage ${index + 1}`,
            description: stage.description || '',
            approvalRequired: Boolean(stage.approvalRequired),
            assigneeIds: getStageAssigneeIds(stage),
            approverIds: getStageApproverIds(stage),
            approvalMode: normalizeApprovalMode(stage.approvalMode),
          }))
        : (
            editingTask.workflowEnabled
              ? [{
                  order: Number(editingTask.currentStageOrder || 1),
                  title: editingTask.currentStageTitle || 'Current Stage',
                  description: '',
                  approvalRequired: Boolean(editingTask.currentStageApprovalRequired),
                  assigneeIds: normalizeUserIds(
                    Array.isArray(editingTask.currentStageAssigneeIds) && editingTask.currentStageAssigneeIds.length > 0
                      ? editingTask.currentStageAssigneeIds
                      : selectedUserIds
                  ),
                  approverIds: [],
                  approvalMode: 'any',
                }]
              : []
          );
      const workflowAssigneeIds = normalizeUserIds(
        mappedWorkflowStages.flatMap((stage) => stage.assigneeIds || [])
      );
      const editSelectedUserIds = normalizeUserIds([
        ...selectedUserIds,
        ...workflowAssigneeIds,
      ]);
      const mappedEditData = {
        projectName: editingTask.projectName || '',
        taskId: editingTask.taskId || editingTask.taskNumber || '',
        projectId: editingTask.projectId || '',
        projectIdRaw: editingTask.projectIdRaw || '',
        projectIdHex: editingTask.projectIdHex || '',
        customerName: editingTask.customerName || '',
        taskName: editingTask.title || '',
        reference: editingTask.reference || '',
        myDepartment: editingTask.fromDepartment || currentUserDepartment || '',
        selectedUserIds: editSelectedUserIds,
        toDepartment: normalizeDepartmentName(editingTask.toDepartment || 'Gen Ai'),
        deadline: editingTask.deadline ? formatDateTimeLocalInputIndia(editingTask.deadline) : '',
        priority: editingTask.priority
          ? editingTask.priority.charAt(0).toUpperCase() + editingTask.priority.slice(1).toLowerCase()
          : 'High',
        taskDetails: editingTask.description || '',
        taskTag: editingTask.taskTag || '',
        taskType: editingTask.taskType || 'task',
        attachments: editingTask.attachments || [],
        links: editingTask.links || [],
        submissionMode: editingTask.submissionMode === 'all' ? 'all' : 'any',
        approverIds: normalizeUserIds(editingTask.approverIds),
        approvalMode: normalizeApprovalMode(editingTask.approvalMode),
        workflowEnabled: Boolean(editingTask.workflowEnabled),
        finalApprovalRequired: Boolean(editingTask.finalApprovalRequired),
        workflowStages: mappedWorkflowStages,
      };
      setFormData(mappedEditData);
      initialFormSnapshotRef.current = buildDirtySnapshot(mappedEditData);
      initialWorkflowSnapshotRef.current = buildWorkflowSnapshot(mappedEditData);
      rememberUsers([
        ...(Array.isArray(editingTask.assignedTo) ? editingTask.assignedTo : []),
        ...(Array.isArray(editingTask.approvers) ? editingTask.approvers : []),
        ...(Array.isArray(editingTask.workflowStages)
          ? editingTask.workflowStages.flatMap((stage) => ([
              ...(Array.isArray(stage?.assignees) ? stage.assignees : []),
              ...(Array.isArray(stage?.approvers) ? stage.approvers : []),
            ]))
          : []),
      ]);
      updateCurrentDraftId(isDraftEdit ? editingTask.id : null);
      lastAutoSaveSnapshotRef.current = '';
      return;
    }

    const emptyForm = createEmptyFormData(currentUserDepartment);
    setFormData(emptyForm);
    initialFormSnapshotRef.current = buildDirtySnapshot(emptyForm);
    initialWorkflowSnapshotRef.current = buildWorkflowSnapshot(emptyForm);
    updateCurrentDraftId(null);
    lastAutoSaveSnapshotRef.current = '';
    setProjectIdState({ status: 'idle', message: '' });
    setTaskIdState({ status: 'idle', message: '' });
    setShowUserDropdown(false);
  }, [isOpen, editingTask, isDraftEdit, updateCurrentDraftId]);

  useEffect(() => {
    if (isOpen) {
      setIsMinimized(false);
      setIsMaximized(isMobileViewport());
      allowNavigationRef.current = false;
    }
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    if (!formData.myDepartment && currentUserDepartment) {
      setFormData((prev) => ({
        ...prev,
        myDepartment: currentUserDepartment,
      }));
    }
  }, [currentUserDepartment, formData.myDepartment, isOpen]);

  useEffect(() => {
    if (!isOpen || approverBrowseDepartment) return;
    const defaultDepartment = formData.toDepartment || currentUserDepartment;
    if (defaultDepartment) {
      setApproverBrowseDepartment(normalizeDepartmentName(defaultDepartment));
    }
  }, [isOpen, approverBrowseDepartment, formData.toDepartment, currentUserDepartment]);

  useEffect(() => {
    if (!isOpen) return;
    const normalizedToDepartment = normalizeDepartmentName(formData.toDepartment);
    if (normalizedToDepartment && normalizedToDepartment !== formData.toDepartment) {
      setFormData((prev) => ({
        ...prev,
        toDepartment: normalizedToDepartment,
      }));
      return;
    }
    if (normalizedToDepartment) {
      void loadDepartmentUsers(normalizedToDepartment);
    } else {
      setDepartmentUsers([]);
    }
  }, [departments, formData.toDepartment, isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    const normalizedApproverDepartment = normalizeDepartmentName(approverBrowseDepartment);
    if (normalizedApproverDepartment && normalizedApproverDepartment !== approverBrowseDepartment) {
      setApproverBrowseDepartment(normalizedApproverDepartment);
      return;
    }
    if (normalizedApproverDepartment) {
      void loadApproverDepartmentUsers(normalizedApproverDepartment);
    } else {
      setApproverDepartmentUsers([]);
    }
  }, [departments, approverBrowseDepartment, isOpen]);

  // Drafts are saved only after an explicit user action:
  // the Save Draft button, or choosing Save Draft from the close confirmation.

  // Compare against the form state when the modal was opened.
  const hasFormData = () => {
    return buildDirtySnapshot(latestFormDataRef.current) !== initialFormSnapshotRef.current;
  };
  const isDirty = isOpen && hasFormData();

  useEffect(() => {
    if (!isDirty) return undefined;

    const handleBeforeUnload = (event) => {
      event.preventDefault();
      event.returnValue = '';
    };

    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [isDirty]);

  // Handle input changes
  const handleChange = (field, value) => {
    const knownProject = field === 'projectName'
      ? knownProjects[(value || '').trim().toLowerCase()]
      : null;

    setFormData(prev => {
      const next = {
        ...prev,
        [field]: value
      };

      if (field === 'projectName' && knownProject) {
        if (!next.projectId && knownProject.projectId) {
          next.projectId = knownProject.projectId;
        }
        if (!next.projectIdRaw && knownProject.projectIdRaw) {
          next.projectIdRaw = knownProject.projectIdRaw;
        }
        if (!next.projectIdHex && knownProject.projectIdHex) {
          next.projectIdHex = knownProject.projectIdHex;
        }
      }

      return next;
    });

    if (field === 'projectId' || field === 'projectName' || field === 'customerName') {
      setProjectIdState({ status: 'idle', message: '' });
    }
    if (field === 'taskId' || field === 'projectName' || field === 'customerName') {
      setTaskIdState({ status: 'idle', message: '' });
    }
    if (field === 'projectName' && knownProject?.projectId) {
      setProjectIdState({ status: 'success', message: 'Existing project linked by name.' });
    }

  };

  // NEW: Toggle user selection
  const toggleUserSelection = (userId) => {
    const normalizedUserId = normalizeUserId(userId);
    if (!normalizedUserId) return;
    setFormData(prev => ({
      ...prev,
      selectedUserIds: normalizeUserIds(prev.selectedUserIds).includes(normalizedUserId)
        ? normalizeUserIds(prev.selectedUserIds).filter(id => id !== normalizedUserId)
        : [...normalizeUserIds(prev.selectedUserIds), normalizedUserId]
    }));
  };

  // Bulk toggle for the currently-browsed department's user list - a real
  // time-saver once a department has more than a handful of people.
  // Deselects instead of selecting when everyone visible is already picked,
  // so the one control does both jobs depending on current state.
  const areAllDepartmentUsersSelected = departmentUsers.length > 0 && departmentUsers.every(
    (candidate) => normalizeUserIds(formData.selectedUserIds).includes(normalizeUserId(candidate.id))
  );

  const toggleSelectAllDepartmentUsers = () => {
    const departmentUserIds = departmentUsers
      .map((candidate) => normalizeUserId(candidate.id))
      .filter(Boolean);
    if (departmentUserIds.length === 0) return;
    setFormData((prev) => {
      const currentIds = normalizeUserIds(prev.selectedUserIds);
      const allSelected = departmentUserIds.every((id) => currentIds.includes(id));
      return {
        ...prev,
        selectedUserIds: allSelected
          ? currentIds.filter((id) => !departmentUserIds.includes(id))
          : normalizeUserIds([...currentIds, ...departmentUserIds]),
      };
    });
  };

  const toggleSelfAssignment = () => {
    const normalizedUserId = normalizeUserId(user?.id);
    if (!normalizedUserId) return;
    const ownDepartment = normalizeDepartmentName(user?.department || currentUserDepartment || formData.myDepartment);
    setFormData((prev) => {
      const selectedUserIds = normalizeUserIds(prev.selectedUserIds);
      const isSelected = selectedUserIds.includes(normalizedUserId);
      return {
        ...prev,
        selectedUserIds: isSelected
          ? selectedUserIds.filter((id) => id !== normalizedUserId)
          : [...selectedUserIds, normalizedUserId],
        toDepartment: !isSelected && ownDepartment ? ownDepartment : prev.toDepartment,
      };
    });
  };

  const setWorkflowEnabled = (enabled) => {
    setFormData((prev) => {
      return {
        ...prev,
        workflowEnabled: enabled,
        workflowStages: enabled
          ? (prev.workflowStages.length > 0 ? prev.workflowStages : [createEmptyWorkflowStage(1)])
          : [],
      };
    });
  };

  const toggleWorkflowEnabled = () => {
    setWorkflowEnabled(!formData.workflowEnabled);
  };

  const addWorkflowStage = () => {
    setFormData((prev) => ({
      ...prev,
      workflowStages: [...prev.workflowStages, createEmptyWorkflowStage(prev.workflowStages.length + 1)],
    }));
  };

  const updateWorkflowStage = (stageIndex, patch) => {
    setFormData((prev) => ({
      ...prev,
      workflowStages: prev.workflowStages.map((stage, index) => (
        index === stageIndex ? { ...stage, ...patch } : stage
      )),
    }));
  };

  const removeWorkflowStage = (stageIndex) => {
    setFormData((prev) => {
      const nextStages = prev.workflowStages
        .filter((_, index) => index !== stageIndex)
        .map((stage, index) => ({
          ...stage,
          order: index + 1,
          title: stage.title || `Stage ${index + 1}`,
        }));
      return {
        ...prev,
        workflowStages: nextStages,
      };
    });
  };

  const toggleStageAssignee = (stageIndex, userId) => {
    const normalizedUserId = normalizeUserId(userId);
    if (!normalizedUserId) return;
    setFormData((prev) => ({
      ...prev,
      workflowStages: prev.workflowStages.map((stage, index) => {
        if (index !== stageIndex) return stage;
        const currentAssigneeIds = normalizeUserIds(stage.assigneeIds);
        const assigneeIds = currentAssigneeIds.includes(normalizedUserId)
          ? currentAssigneeIds.filter((id) => id !== normalizedUserId)
          : [...currentAssigneeIds, normalizedUserId];
        return { ...stage, assigneeIds };
      }),
    }));
  };

  // Approvers are picked from any company user (not just the receiver
  // pool - see the department browser reused for this below), so a picked
  // user might not already be in knownUsersById the way a receiver always
  // is. Remember them here so their name resolves in the selected-approver
  // chips even after the creator browses away to a different department.
  const toggleStageApprover = (stageIndex, userId, userMeta) => {
    const normalizedUserId = normalizeUserId(userId);
    if (!normalizedUserId) return;
    if (userMeta) {
      rememberUsers([{ ...userMeta, id: normalizedUserId }]);
    }
    setFormData((prev) => ({
      ...prev,
      workflowStages: prev.workflowStages.map((stage, index) => {
        if (index !== stageIndex) return stage;
        const currentApproverIds = normalizeUserIds(stage.approverIds);
        const approverIds = currentApproverIds.includes(normalizedUserId)
          ? currentApproverIds.filter((id) => id !== normalizedUserId)
          : [...currentApproverIds, normalizedUserId];
        return { ...stage, approverIds };
      }),
    }));
  };

  // Task-level equivalent of toggleStageApprover, for the normal
  // (non-staged) single-step flow's own "Task Approvers" picker.
  const toggleTaskApprover = (userId, userMeta) => {
    const normalizedUserId = normalizeUserId(userId);
    if (!normalizedUserId) return;
    if (userMeta) {
      rememberUsers([{ ...userMeta, id: normalizedUserId }]);
    }
    setFormData((prev) => {
      const currentApproverIds = normalizeUserIds(prev.approverIds);
      const approverIds = currentApproverIds.includes(normalizedUserId)
        ? currentApproverIds.filter((id) => id !== normalizedUserId)
        : [...currentApproverIds, normalizedUserId];
      return { ...prev, approverIds };
    });
  };

  const selectedReceivers = useMemo(
    () => normalizeUserIds(formData.selectedUserIds).map((userId) => (
      knownUsersById[userId] || {
        id: userId,
        name: `User #${userId}`,
        department: '',
        position: '',
      }
    )),
    [formData.selectedUserIds, knownUsersById]
  );
  const isSelfAssigned = Boolean(user?.id && normalizeUserIds(formData.selectedUserIds).includes(normalizeUserId(user.id)));

  const workflowAssignedStageCount = useMemo(
    () => formData.workflowStages.filter((stage) => normalizeUserIds(stage.assigneeIds).length > 0).length,
    [formData.workflowStages]
  );

  const workflowApprovalStageCount = useMemo(
    () => formData.workflowStages.filter((stage) => Boolean(stage.approvalRequired)).length,
    [formData.workflowStages]
  );

  useEffect(() => {
    if (!formData.workflowEnabled) return;
    setFormData((prev) => ({
      ...prev,
      workflowStages: prev.workflowStages.map((stage) => ({
        ...stage,
        assigneeIds: normalizeUserIds(stage.assigneeIds).filter((userId) => normalizeUserIds(prev.selectedUserIds).includes(userId)),
      })),
    }));
  }, [formData.selectedUserIds, formData.workflowEnabled]);

  useEffect(() => {
    if (!user?.id) return;
    rememberUsers([{
      id: user.id,
      name: user.name || 'You',
      department: user.department || currentUserDepartment || '',
      position: user.position || '',
    }]);
  }, [currentUserDepartment, rememberUsers, user]);

  // Handle attachments update
  const handleAttachmentsChange = (attachments) => {
    setFormData(prev => ({
      ...prev,
      attachments
    }));
  };

  // Handle links update
  const handleLinksChange = (links) => {
    setFormData(prev => ({
      ...prev,
      links
    }));
  };

  const resetFormState = () => {
    const emptyForm = createEmptyFormData(currentUserDepartment);
    setFormData(emptyForm);
    initialFormSnapshotRef.current = buildDirtySnapshot(emptyForm);
    initialWorkflowSnapshotRef.current = buildWorkflowSnapshot(emptyForm);
    latestFormDataRef.current = emptyForm;
    updateCurrentDraftId(null);
    lastAutoSaveSnapshotRef.current = '';
    localStorage.removeItem('taskDraft');
  };

  // Clear form
  const handleClear = async () => {
    if (hasFormData()) {
      const confirmClear = await showConfirm('Are you sure you want to clear all form data?', {
        title: 'Clear Form',
      });
      if (!confirmClear) return;
    }

    resetFormState();
    showMessage('Form cleared', 'success');
  };

  // ✅ FIXED: Save as draft with field mapping
  const saveDraft = async (silent = false) => {
    if (draftSaveInFlightRef.current) return;

    const draftFormData = latestFormDataRef.current;
    const draftSnapshot = buildDirtySnapshot(draftFormData);

    if (draftSnapshot === initialFormSnapshotRef.current) {
      if (!silent) showMessage('Nothing to save', 'warning');
      return;
    }

    if (silent && draftSnapshot === lastAutoSaveSnapshotRef.current) {
      return;
    }

    draftSaveInFlightRef.current = true;
    setIsSaving(true);
    setSubmitUploadState(createInitialSubmitUploadState());

    try {
      const activeDraftId = currentDraftIdRef.current || currentDraftId || null;

      // Save to localStorage with original field names
      localStorage.setItem('taskDraft', JSON.stringify({
        ...draftFormData,
        __draftId: activeDraftId,
      }));

      // ✅ Map to backend schema
      const draftPayload = {
        title: draftFormData.taskName || '',
        description: draftFormData.taskDetails || '',
        projectName: draftFormData.projectName || '',
        taskId: draftFormData.taskId || '',
        projectId: draftFormData.projectId || '',
        projectIdRaw: draftFormData.projectIdRaw || '',
        projectIdHex: draftFormData.projectIdHex || '',
        customerName: draftFormData.customerName || '',
        reference: draftFormData.reference || '',
        myDepartment: draftFormData.myDepartment || currentUserDepartment || '',
        taskType: draftFormData.taskType || 'task',
        taskTag: draftFormData.taskTag || '',
        priority: (draftFormData.priority || 'medium').toLowerCase(),
        toDepartment: draftFormData.toDepartment || '',
        selectedUserIds: normalizeUserIds(draftFormData.selectedUserIds),
        deadline: draftFormData.deadline || null,
        links: Array.isArray(draftFormData.links) ? draftFormData.links : [],
        attachments: Array.isArray(draftFormData.attachments) ? draftFormData.attachments : [],
        workflowEnabled: Boolean(draftFormData.workflowEnabled),
        finalApprovalRequired: Boolean(draftFormData.finalApprovalRequired),
        workflowStages: Array.isArray(draftFormData.workflowStages)
          ? draftFormData.workflowStages.map((stage, index) => ({
              order: Number(stage.order || index + 1),
              title: `${stage.title || ''}`.trim(),
              description: `${stage.description || ''}`.trim(),
              approvalRequired: Boolean(stage.approvalRequired),
              assigneeIds: normalizeUserIds(stage.assigneeIds),
              approverIds: normalizeUserIds(stage.approverIds),
              approvalMode: normalizeApprovalMode(stage.approvalMode),
            }))
          : [],
      };

      let response;
      if (activeDraftId) {
        try {
          response = await draftAPI.updateDraft(activeDraftId, draftPayload);
        } catch (updateError) {
          if (silent) {
            console.warn('Silent draft update failed; skipping duplicate draft creation:', updateError);
            lastAutoSaveSnapshotRef.current = draftSnapshot;
            return;
          }
          console.log('Draft not found, creating new one');
          response = await draftAPI.saveDraft(draftPayload);
          const savedDraftId = response?.id || response?.data?.id || null;
          if (savedDraftId) {
            updateCurrentDraftId(savedDraftId);
            localStorage.setItem('taskDraft', JSON.stringify({
              ...draftFormData,
              __draftId: savedDraftId,
            }));
          }
        }
      } else {
        response = await draftAPI.saveDraft(draftPayload);
        const savedDraftId = response?.id || response?.data?.id || null;
        if (savedDraftId) {
          updateCurrentDraftId(savedDraftId);
          localStorage.setItem('taskDraft', JSON.stringify({
            ...draftFormData,
            __draftId: savedDraftId,
          }));
        }
      }

      lastAutoSaveSnapshotRef.current = draftSnapshot;

      if (!silent) {
        showMessage('Draft saved successfully', 'success');
      }
    } catch (error) {
      console.error('Error saving draft:', error);
      if (!silent) {
        showMessage('Draft saved locally (server error)', 'warning');
      }
    } finally {
      draftSaveInFlightRef.current = false;
      setIsSaving(false);
    }
  };

  // ✅ FIXED: Create task with proper field mapping
  const handleCreateTask = async () => {
    // Validation
    if (!formData.taskName || (!isTaskEditMode && !formData.projectName)) {
      showMessage(
        isTaskEditMode
          ? 'Please fill required field (Task Name)'
          : 'Please fill required fields (Project Name & Task Name)',
        'error'
      );
      return;
    }

    if (!formData.taskTag) {
      showMessage('Please select a Tag of Task.', 'error');
      return;
    }

    if (!validateDeadlineNotInPast(formData.deadline)) {
      showMessage('Deadline cannot be in the past. Select a future date and time.', 'error');
      return;
    }

    const normalizedWorkflowStages = formData.workflowEnabled
      ? formData.workflowStages.map((stage, index) => ({
          order: index + 1,
          title: `${stage.title || ''}`.trim(),
          description: `${stage.description || ''}`.trim(),
          approvalRequired: Boolean(stage.approvalRequired),
          assigneeIds: Array.isArray(stage.assigneeIds)
            ? Array.from(new Set(stage.assigneeIds.map((id) => Number(id)).filter(Boolean)))
            : [],
          approverIds: Array.isArray(stage.approverIds)
            ? Array.from(new Set(stage.approverIds.map((id) => Number(id)).filter(Boolean)))
            : [],
          approvalMode: normalizeApprovalMode(stage.approvalMode),
        }))
      : [];

    const hasWorkflowStagesForSubmit = normalizedWorkflowStages.length > 0;
    const workflowChanged = buildWorkflowSnapshot(formData) !== initialWorkflowSnapshotRef.current;
    const shouldValidateWorkflow = formData.workflowEnabled && (!isTaskEditMode || workflowChanged || hasWorkflowStagesForSubmit);

    if (shouldValidateWorkflow) {
      if (normalizedWorkflowStages.length === 0) {
        showMessage('Add at least one workflow stage before creating the task.', 'error');
        return;
      }

      const invalidStage = normalizedWorkflowStages.find(
        (stage) => !stage.title || stage.assigneeIds.length === 0
      );
      if (invalidStage) {
        showMessage(
          `Stage ${invalidStage.order} needs a title and at least one assigned receiver.`,
          'error'
        );
        return;
      }
    }

    setIsSaving(true);

    try {
      const selectedAttachments = Array.isArray(formData.attachments) ? formData.attachments : [];
      const existingAttachmentMeta = selectedAttachments.filter(
        (item) => item && typeof item === 'object' && item.url
      );
      const filesToUpload = selectedAttachments.filter(
        (item) => item instanceof File
      );
      let uploadedAttachments = [];
      if (filesToUpload.length > 0) {
        const totalBytes = getUploadBytesTotal(filesToUpload);
        setSubmitUploadState({
          active: true,
          phase: 'Uploading attachments...',
          fileCount: filesToUpload.length,
          uploadedBytes: 0,
          totalBytes,
          percent: 0,
          currentFileName: filesToUpload[0]?.name || '',
          currentFileIndex: filesToUpload[0] ? 1 : 0,
          currentFileUploadedBytes: 0,
          currentFileTotalBytes: Math.max(Number(filesToUpload[0]?.size) || 0, 0),
          currentFilePercent: 0,
        });
        const uploadRes = await fileAPI.uploadFiles(filesToUpload, {
          onProgress: (_percent, metrics = {}) => {
            const safeTotalBytes = Math.max(Number(metrics?.total) || totalBytes || 0, 0);
            const uploadedBytes = safeTotalBytes
              ? Math.min(Math.max(Number(metrics?.loaded) || 0, 0), safeTotalBytes)
              : 0;
            setSubmitUploadState((current) => ({
              ...current,
              active: true,
              phase: 'Uploading attachments...',
              fileCount: filesToUpload.length,
              uploadedBytes,
              totalBytes: safeTotalBytes || totalBytes,
              percent: toUploadPercent(uploadedBytes, safeTotalBytes || totalBytes),
            }));
          },
          onFileProgress: ({ fileIndex, file, loaded, total, percent }) => {
            setSubmitUploadState((current) => ({
              ...current,
              active: true,
              phase: 'Uploading attachments...',
              fileCount: filesToUpload.length,
              currentFileName: file?.name || current.currentFileName,
              currentFileIndex: Number(fileIndex) + 1,
              currentFileUploadedBytes: Math.max(Number(loaded) || 0, 0),
              currentFileTotalBytes: Math.max(Number(total) || 0, 0),
              currentFilePercent: Math.max(Number(percent) || 0, 0),
            }));
          },
        });
        uploadedAttachments = uploadRes?.data || [];
        setSubmitUploadState((current) => ({
          ...current,
          active: true,
          phase: isTaskEditMode ? 'Updating task details...' : isDraftEdit ? 'Sending task details...' : 'Creating task details...',
          uploadedBytes: current.totalBytes,
          percent: current.totalBytes ? 100 : current.percent,
          currentFileUploadedBytes: current.currentFileTotalBytes,
          currentFilePercent: current.currentFileTotalBytes ? 100 : current.currentFilePercent,
        }));
      }
      const finalAttachments = [...existingAttachmentMeta, ...uploadedAttachments];

      // ✅ Map form data to backend schema
      const workflowPayload = formData.workflowEnabled
        ? (
            hasWorkflowStagesForSubmit
              ? {
                  enabled: true,
                  finalApprovalRequired: Boolean(formData.finalApprovalRequired),
                  stages: normalizedWorkflowStages,
                }
              : undefined
          )
        : null;
      const shouldSendWorkflow = !isTaskEditMode || workflowChanged;

      const taskPayload = {
        title: formData.taskName,
        description: formData.taskDetails || '',
        projectName: formData.projectName,
        taskId: formData.taskId || null,
        projectId: formData.projectId || null,
        projectIdRaw: formData.projectIdRaw || null,
        projectIdHex: formData.projectIdHex || null,
        customerName: formData.customerName || '',
        taskType: formData.taskType || 'task',
        // No fallback here on purpose - handleCreateTask's validation above
        // already blocks submission unless a real tag is picked, and
        // silently substituting "Audio" would defeat that requirement.
        taskTag: formData.taskTag,
        priority: formData.priority.toLowerCase(),
        toDepartment: formData.toDepartment,
        deadline: formData.deadline || null,
        assigneeIds: normalizeUserIds(formData.selectedUserIds),
        reference: formData.reference || '',
        links: formData.links || [],
        attachments: finalAttachments,
        submissionMode: formData.submissionMode === 'any' ? 'any' : 'all',
        approverIds: normalizeUserIds(formData.approverIds),
        approvalMode: normalizeApprovalMode(formData.approvalMode),
        ...(shouldSendWorkflow ? { workflow: workflowPayload } : {}),
      };

      console.log('📤 Sending task payload:', taskPayload);

      if (isTaskEditMode && editingTask?.id) {
        const response = await taskAPI.editTask(editingTask.id, taskPayload);
        console.log('✅ Task updated:', response);
        showMessage('Task updated successfully!', 'success');
      } else {
        const response = await taskAPI.createTask(taskPayload);
        console.log('✅ Task created:', response);
        showMessage('Task created successfully!', 'success');
      }

      if (cacheKeys?.bootstrap) {
        invalidateTaskPanelCache(cacheKeys.bootstrap);
      }
      if (user?.id) {
        invalidateTaskPanelCache(buildTaskPanelCacheKey(user.id, 'outbox'));
        invalidateTaskPanelCache(buildTaskPanelCacheKey(user.id, 'tracking'));
        invalidateTaskPanelCache(buildTaskPanelCacheKey(user.id, 'inbox'));
        invalidateTaskPanelCache(buildTaskPanelCacheKey(user.id, 'workspace_team_directory'));
        invalidateTaskPanelCache(buildTaskPanelCacheKey(user.id, 'workspace_company_directory'));
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: ['outbox', user.id] }),
          queryClient.invalidateQueries({ queryKey: ['tracking', user.id] }),
          queryClient.invalidateQueries({ queryKey: ['inbox', user.id] }),
        ]);
      }
      
      // Clear draft from localStorage and API
      localStorage.removeItem('taskDraft');
      const draftIdToDelete = currentDraftIdRef.current || currentDraftId;
      if (draftIdToDelete) {
        try {
          await draftAPI.deleteDraft(draftIdToDelete);
        } catch (err) {
          console.log('Draft cleanup error:', err);
        }
      }

      // Clear form without re-triggering the manual clear confirmation.
      resetFormState();
      
      // Close modal after 1.5 seconds
      setTimeout(() => {
        onClose();
      }, 1500);
    } catch (error) {
      console.error('❌ Error creating task:', error);
      
      let errorMsg = isTaskEditMode ? 'Failed to update task' : 'Failed to create task';
      
      if (error.response?.data?.detail) {
        const detail = error.response.data.detail;
        
        if (Array.isArray(detail)) {
          errorMsg = detail.map(err => {
            const field = err.loc[err.loc.length - 1];
            return `${field}: ${err.msg}`;
          }).join(', ');
        } else if (typeof detail === 'string') {
          errorMsg = detail;
        }
      }
      
      showMessage(errorMsg, 'error');
    } finally {
      setIsSaving(false);
      setSubmitUploadState(createInitialSubmitUploadState());
    }
  };

  const confirmBeforeExit = async () => {
    if (!hasFormData()) {
      allowNavigationRef.current = true;
      return true;
    }

    if (closeConfirmationInFlightRef.current) {
      return false;
    }

    closeConfirmationInFlightRef.current = true;

    try {
      const confirmClose = await showConfirm(
        'You have unsaved changes. Do you want to save as draft before closing?',
        {
          title: 'Unsaved Changes',
          confirmText: 'Save Draft',
          confirmValue: 'save',
          cancelText: 'Discard',
          cancelValue: 'discard',
          tertiaryText: 'Stay Here',
          tertiaryValue: 'stay',
          dismissValue: 'stay',
        }
      );

      if (confirmClose === 'save') {
        await saveDraft();
        allowNavigationRef.current = true;
        return true;
      }

      if (confirmClose === 'discard') {
        localStorage.removeItem('taskDraft');
        updateCurrentDraftId(null);
        lastAutoSaveSnapshotRef.current = '';
        const emptyForm = createEmptyFormData(currentUserDepartment);
        setFormData(emptyForm);
        latestFormDataRef.current = emptyForm;
        initialFormSnapshotRef.current = buildDirtySnapshot(emptyForm);
        allowNavigationRef.current = true;
        return true;
      }

      return false;
    } finally {
      closeConfirmationInFlightRef.current = false;
    }
  };

  useImperativeHandle(ref, () => ({
    confirmBeforeExit,
    hasUnsavedChanges: () => hasFormData(),
    consumeNavigationAllowance: () => {
      const allowed = allowNavigationRef.current;
      allowNavigationRef.current = false;
      return allowed;
    },
  }));

  // Handle modal close
  const handleClose = async () => {
    const canClose = await confirmBeforeExit();
    if (!canClose) {
      return;
    }

    onClose();
  };

  const stopPropagation = (e) => e.stopPropagation();

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

    setIsMinimized(true);
  };

  const handleValidateProjectId = async () => {
    const value = (formData.projectId || '').trim();
    if (!value) {
      setProjectIdState({ status: 'error', message: 'Enter a Project ID first.' });
      return;
    }
    try {
      const response = await taskAPI.validateProjectId(value);
      if (response.exists) {
        setProjectIdState({ status: 'success', message: 'Project ID found and linked.' });
      } else {
        setProjectIdState({ status: 'error', message: response.message || 'Project ID not found.' });
      }
    } catch (error) {
      setProjectIdState({ status: 'error', message: 'Failed to validate Project ID.' });
    }
  };

  const getIdGenerationInputs = () => ({
    projectName: `${formData.projectName || ''}`.trim(),
    customerName: `${formData.customerName || ''}`.trim(),
  });

  const handleGenerateProjectId = async () => {
    const { projectName, customerName } = getIdGenerationInputs();
    if (!projectName) {
      setProjectIdState({ status: 'error', message: 'Project Name is required to generate Project ID.' });
      return;
    }
    try {
      const response = await taskAPI.generateProjectId(projectName, customerName);
      setFormData(prev => ({
        ...prev,
        projectName,
        customerName,
        projectId: response.projectId || '',
        projectIdRaw: response.projectIdRaw || '',
        projectIdHex: response.projectIdHex || ''
      }));
      setProjectIdState({ status: 'success', message: 'Project ID generated.' });
    } catch (error) {
      setProjectIdState({ status: 'error', message: 'Could not generate Project ID.' });
    }
  };

  const handleValidateTaskId = async () => {
    const value = (formData.taskId || '').trim();
    if (!value) {
      setTaskIdState({ status: 'error', message: 'Enter a Task ID first.' });
      return;
    }
    try {
      const response = await taskAPI.validateTaskId(value);
      if (response.exists) {
        setTaskIdState({ status: 'error', message: 'Task ID already exists. Use another ID.' });
      } else {
        setTaskIdState({ status: 'success', message: 'Task ID is available.' });
      }
    } catch (error) {
      setTaskIdState({ status: 'error', message: 'Failed to validate Task ID.' });
    }
  };

  const handleGenerateTaskId = async () => {
    const { projectName, customerName } = getIdGenerationInputs();
    if (!projectName) {
      setTaskIdState({ status: 'error', message: 'Project Name is required to generate Task ID.' });
      return;
    }
    try {
      const response = await taskAPI.generateTaskId(projectName, customerName);
      setFormData(prev => ({
        ...prev,
        projectName,
        customerName,
        taskId: response.taskId || ''
      }));
      setTaskIdState({ status: 'success', message: 'Task ID generated.' });
    } catch (error) {
      setTaskIdState({ status: 'error', message: 'Could not generate Task ID.' });
    }
  };

  const handleToggleMaximize = () => {
    if (isMinimized) {
      restoreWindow();
      return;
    }

    setIsMaximized((prev) => !prev);
  };

  return (
    <div className={`assign-modal-backdrop ${isMinimized ? 'disabled' : ''}`} onClick={!isMinimized ? handleClose : undefined}>
      <div
        className={`assign-modal ${isMinimized ? 'minimized' : ''} ${isMaximized ? 'maximized' : ''}`}
        onClick={stopPropagation}
        style={minimizedWindowStyle || undefined}
      >
        {/* Top dark bar */}
        <div className="assign-modal-header-bar" onClick={isMinimized ? restoreWindow : undefined}>
          <span>{isTaskEditMode ? 'EDIT TASK' : isDraftEdit ? 'EDIT DRAFT' : 'CREATE NEW TASK'}</span>
          <div className="header-actions">
            {saveMessage && (
              <span className={`save-message ${saveMessage.type}`}>
                {saveMessage.text}
              </span>
            )}
            <WindowControls
              isMinimized={isMinimized}
              isMaximized={isMaximized}
              onMinimize={handleToggleMinimize}
              onMaximize={handleToggleMaximize}
              onClose={handleClose}
            />
          </div>
        </div>

        {!isMinimized && (
        <div className="assign-modal-body">
          {isTaskEditMode && (
            <div className="assign-edit-note">
              Edit mode currently updates only Task Name, Task Details, Deadline, and Priority. Other fields are shown read-only.
            </div>
          )}
          <CacheStatusBanner
            showingCached={cacheStatus.showingCached}
            isRefreshing={isReferenceRefreshing}
            cachedAt={cacheStatus.cachedAt}
            liveUpdatedAt={cacheStatus.liveUpdatedAt}
            refreshingLabel="Refreshing latest task references..."
            liveLabel="Task references are up to date"
            cachedLabel="Showing cached task references"
            className="assign-cache-status"
          />

          {/* Project & Task Name */}
          <div className="assign-row">
            <div className="assign-field">
              <label>Project Name <span className="required">*</span></label>
              <input 
                type="text" 
                placeholder="Project Alpha" 
                value={formData.projectName}
                onChange={(e) => handleChange('projectName', e.target.value)}
                list="project-name-suggestions"
              />
              <datalist id="project-name-suggestions">
                {projectNameSuggestions.map((projectName) => (
                  <option key={projectName} value={projectName} />
                ))}
              </datalist>
            </div>
            <div className="assign-field">
              <label>Customer Name</label>
              <select
                value={formData.customerName}
                onChange={(e) => handleChange('customerName', e.target.value)}
              >
                <option value="">Select client…</option>
                {formData.customerName && !clientOptions.some((client) => client.name === formData.customerName) && (
                  <option value={formData.customerName}>{formData.customerName}</option>
                )}
                {clientOptions.map((client) => (
                  <option key={client.id} value={client.name}>{client.name}</option>
                ))}
              </select>
            </div>
            <div className="assign-field">
              <label>Task Name <span className="required">*</span></label>
              <input 
                type="text" 
                placeholder="Task Name" 
                value={formData.taskName}
                onChange={(e) => handleChange('taskName', e.target.value)}
              />
            </div>
          </div>

          <div className="assign-row">
            <div className="assign-field">
              <label>Task ID <span className="assign-field-hint-inline">(existing or generated)</span></label>
              <input
                type="text"
                placeholder="TASK-XXXX-YYYYMMDD-ZZZZ"
                value={formData.taskId}
                onChange={(e) => handleChange('taskId', e.target.value)}
                list="task-id-suggestions"
              />
              <datalist id="task-id-suggestions">
                {taskIdSuggestions.map((taskId) => (
                  <option key={taskId} value={taskId} />
                ))}
              </datalist>
              {taskIdState.message && (
                <small className={`project-id-status ${taskIdState.status}`}>{taskIdState.message}</small>
              )}
            </div>
            <div className="assign-field project-id-actions">
              <div className="project-id-btn-row">
                <button type="button" className="assign-secondary-btn" onClick={handleValidateTaskId} aria-label="Validate Task ID">
                  Validate
                </button>
                <button type="button" className="assign-draft-btn id-generate-btn" onClick={handleGenerateTaskId} aria-label="Generate a new Task ID">
                  Generate New
                </button>
              </div>
            </div>
          </div>

          <div className="assign-row">
            <div className="assign-field">
              <label>Project ID <span className="assign-field-hint-inline">(existing or generated)</span></label>
              <input
                type="text"
                placeholder="PROJ-XXXX-YYYYMMDD-ZZZZ"
                value={formData.projectId}
                onChange={(e) => handleChange('projectId', e.target.value)}
                list="project-id-suggestions"
              />
              <datalist id="project-id-suggestions">
                {projectIdSuggestions.map((projectId) => (
                  <option key={projectId} value={projectId} />
                ))}
              </datalist>
              {projectIdState.message && (
                <small className={`project-id-status ${projectIdState.status}`}>{projectIdState.message}</small>
              )}
            </div>
            <div className="assign-field project-id-actions">
              <div className="project-id-btn-row">
                <button type="button" className="assign-secondary-btn" onClick={handleValidateProjectId} aria-label="Validate Project ID">
                  Validate
                </button>
                <button type="button" className="assign-draft-btn id-generate-btn" onClick={handleGenerateProjectId} aria-label="Generate a new Project ID">
                  Generate New
                </button>
              </div>
            </div>
          </div>

          {/* Reference */}
          <div className="assign-row">
            <div className="assign-field">
              <label>Reference / Related</label>
              <input 
                type="text" 
                placeholder="PN/TN/REF" 
                value={formData.reference}
                onChange={(e) => handleChange('reference', e.target.value)}
              />
            </div>
          </div>

          <div className="assign-row">
            <div className="assign-card full-width assignment-flow-card">
                <div className="assignment-flow-header">
                  <div>
                    <h3>Assignment Flow</h3>
                    <p>
                      Choose whether this task goes to one receiver as a normal assignment, or moves through ordered stages with handoffs.
                    </p>
                  </div>
                  {formData.workflowEnabled && (
                    <span className="assignment-flow-live-badge">Staged workflow on</span>
                  )}
                </div>

                <div className="assignment-flow-options">
                  <button
                    type="button"
                    className={`assignment-flow-option ${!formData.workflowEnabled ? 'active' : ''}`}
                    onClick={() => setWorkflowEnabled(false)}
                    aria-pressed={!formData.workflowEnabled}
                  >
                    {!formData.workflowEnabled && <span className="assignment-flow-check" aria-hidden="true">✓</span>}
                    <span className="assignment-flow-option-icon" aria-hidden="true">
                      <span className="flow-dot" />
                    </span>
                    <strong>Single-step task</strong>
                    <span className="assignment-flow-option-desc">Assign the task normally and let one receiver or shared receiver pool handle it.</span>
                  </button>

                  <button
                    type="button"
                    className={`assignment-flow-option ${formData.workflowEnabled ? 'active' : ''}`}
                    onClick={() => setWorkflowEnabled(true)}
                    aria-pressed={formData.workflowEnabled}
                  >
                    {formData.workflowEnabled && <span className="assignment-flow-check" aria-hidden="true">✓</span>}
                    <span className="assignment-flow-option-icon" aria-hidden="true">
                      <span className="flow-dot" />
                      <span className="flow-arrow" />
                      <span className="flow-dot" />
                      <span className="flow-arrow" />
                      <span className="flow-dot" />
                    </span>
                    <strong>Staged workflow</strong>
                    <span className="assignment-flow-option-desc">Create Stage 1, 2, 3 handoffs where each stage can have its own assignee and approval gate.</span>
                  </button>
                </div>

                <div className="assignment-flow-summary">
                  {formData.workflowEnabled ? (
                    <>
                      <div className="assignment-flow-summary-copy">
                        <strong>How this works</strong>
                        <p>
                          Step 1: build the receiver pool below. Step 2: assign those receivers into stages. Step 3: create the task and the handoff flow will start from Stage 1.
                        </p>
                      </div>
                      <div className="assignment-flow-metrics">
                        <span>{formData.workflowStages.length} stage{formData.workflowStages.length === 1 ? '' : 's'}</span>
                        <span>{selectedReceivers.length} receiver{selectedReceivers.length === 1 ? '' : 's'} in pool</span>
                        <span>{workflowAssignedStageCount} stage{workflowAssignedStageCount === 1 ? '' : 's'} assigned</span>
                        <span>{workflowApprovalStageCount} approval gate{workflowApprovalStageCount === 1 ? '' : 's'}</span>
                      </div>
                    </>
                  ) : (
                    <div className="assignment-flow-summary-copy">
                      <strong>Normal task flow</strong>
                      <p>
                        Keep this off when you just want to assign the task without stage-by-stage handoff setup.
                      </p>
                    </div>
                  )}
                </div>
            </div>
          </div>

          <div className="assign-receiver-shell">
            {formData.workflowEnabled && (
              <div className="workflow-step-banner">
                <span className="workflow-step-badge">Step 1</span>
                <div>
                  <strong>Build your receiver pool</strong>
                  <p>Add everyone who might work on this task. You will place them into specific stages in the next section.</p>
                </div>
              </div>
            )}

            <div className="assign-receiver-top-grid">
              <div className="assign-card assign-receiver-control-card">
                <div className="assign-field">
                  <label>My Department</label>
                  <input 
                    type="text" 
                    placeholder='Your department' 
                    value={formData.myDepartment}
                    readOnly
                    disabled
                  />
                  <label className="assign-self-toggle">
                    <input
                      type="checkbox"
                      checked={isSelfAssigned}
                      disabled={!user?.id}
                      onChange={toggleSelfAssignment}
                    />
                    <span>
                      Assign to myself
                      <small>
                        Add yourself to the receiver list so Start and Submit are available on the task.
                      </small>
                    </span>
                  </label>
                </div>
              </div>
              <div className="assign-card assign-receiver-control-card">
                <div className="assign-field">
                  <label>Browse Department</label>
                  <select 
                    value={formData.toDepartment}
                    onChange={(e) => handleChange('toDepartment', e.target.value)}
                  >
                    <option value="">-- Select Department --</option>
                    {departments.map(dept => (
                      <option key={dept} value={dept}>{dept}</option>
                    ))}
                  </select>
                  <small className="assign-help-text">
                    This controls the user list below. Selected receivers can come from more than one department.
                  </small>
                </div>
              </div>
            </div>

            <div className="assign-receiver-grid">
              <div className="assign-card assign-receiver-panel">
                <div className="selected-receivers-header">
                  <div>
                    <h3>Selected Receivers</h3>
                    <p>People already added to this task from one or more departments.</p>
                  </div>
                  <span>{selectedReceivers.length} picked</span>
                </div>

                {selectedReceivers.length > 0 ? (
                  <div className="selected-receivers-list">
                    {selectedReceivers.map((receiver) => (
                      <div key={receiver.id} className="selected-receiver-chip">
                        <div className="selected-receiver-copy">
                          <strong>{receiver.name}</strong>
                          <small>
                            {[receiver.department, receiver.position].filter(Boolean).join(' | ') || `User ID ${receiver.id}`}
                          </small>
                        </div>
                        <button
                          type="button"
                          className="selected-receiver-remove"
                          onClick={() => toggleUserSelection(receiver.id)}
                        >
                          Remove
                        </button>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="selected-receivers-empty">
                    Start by choosing a department on the right, then pick users to build your receiver list.
                  </div>
                )}
                {!formData.workflowEnabled && (
                  <div className="submission-mode-toggle">
                    <label className="workflow-toggle compact">
                      <input
                        type="checkbox"
                        checked={formData.submissionMode === 'all'}
                        onChange={(event) => handleChange('submissionMode', event.target.checked ? 'all' : 'any')}
                      />
                      <span>
                        Require every selected person to submit
                        <small>
                          {formData.submissionMode === 'all'
                        ? 'Task goes to review only after all selected people submit their own result.'
                        : 'Task goes to review when any one selected person submits.'}
                        </small>
                      </span>
                    </label>
                  </div>
                )}
              </div>

              <div className="assign-card assign-receiver-panel">
                <div className="receiver-panel-header">
                  <div>
                    <h3>{formData.toDepartment ? `Add Users from ${formData.toDepartment}` : 'Choose a Department'}</h3>
                    <p>
                      {formData.toDepartment
                        ? 'Checked users are added instantly to the selected receiver list.'
                        : 'Select a department above to browse and add available users.'}
                    </p>
                  </div>
                  {normalizeUserIds(formData.selectedUserIds).length > 0 && (
                    <span className="receiver-selection-badge">
                      {normalizeUserIds(formData.selectedUserIds).length} selected
                    </span>
                  )}
                </div>

                {formData.toDepartment && departmentUsers.length > 1 && (
                  <button type="button" className="receiver-select-all-btn" onClick={toggleSelectAllDepartmentUsers}>
                    {areAllDepartmentUsersSelected ? 'Deselect all' : `Select all ${departmentUsers.length}`}
                  </button>
                )}

                {formData.toDepartment ? (
                  loadingUsers ? (
                    <div className="receiver-panel-state">Loading users...</div>
                  ) : departmentUsers.length > 0 ? (
                    <div className="department-users-list">
                      {departmentUsers.map(user => {
                        const userId = normalizeUserId(user.id);
                        return (
                        <label key={userId || user.id} className="user-checkbox-item">
                          <input 
                            type="checkbox"
                            checked={Boolean(userId && normalizeUserIds(formData.selectedUserIds).includes(userId))}
                            onChange={() => toggleUserSelection(userId)}
                          />
                          <span className="user-checkbox-label">
                            <strong>{user.name}</strong>
                            <small>
                              {[user.department, user.position].filter(Boolean).join(' | ')}
                            </small>
                          </span>
                        </label>
                        );
                      })}
                    </div>
                  ) : (
                    <div className="receiver-panel-state">No users found in this department.</div>
                  )
                ) : (
                  <div className="receiver-panel-state">Pick a department to start adding receivers.</div>
                )}
              </div>
            </div>
          </div>

          {!formData.workflowEnabled && (
            <div className="assign-row">
              <div className="assign-card full-width workflow-builder-card">
                <div className="workflow-builder-header">
                  <div>
                    <div className="workflow-builder-title-row">
                      <h3>Task Approvers (optional)</h3>
                    </div>
                    <p>
                      Pick specific people to approve this task once it's submitted, instead of the
                      default flow (creator, HOD, or SPOC). Especially useful when you assign the task
                      to yourself - naming an approver here means someone other than you signs off on
                      your own work. Leave empty to keep the default.
                    </p>
                  </div>
                </div>

                <div className="workflow-stage-approvers">
                  {normalizeUserIds(formData.approverIds).length > 0 && (
                    <div className="workflow-stage-approver-chips">
                      {normalizeUserIds(formData.approverIds).map((approverId) => {
                        const approver = knownUsersById[approverId] || { id: approverId, name: `User #${approverId}` };
                        return (
                          <span key={`task-approver-${approverId}`} className="workflow-stage-approver-chip">
                            {approver.name}
                            <button
                              type="button"
                              onClick={() => toggleTaskApprover(approverId)}
                              aria-label={`Remove ${approver.name} as approver`}
                            >
                              ×
                            </button>
                          </span>
                        );
                      })}
                    </div>
                  )}

                  <div className="assign-field workflow-stage-approver-department">
                    <label>Find approvers in department</label>
                    <select
                      value={approverBrowseDepartment}
                      onChange={(e) => setApproverBrowseDepartment(e.target.value)}
                    >
                      <option value="">-- Select Department --</option>
                      {departments.map((dept) => (
                        <option key={dept} value={dept}>{dept}</option>
                      ))}
                    </select>
                  </div>

                  {approverBrowseDepartment ? (
                    loadingApproverUsers ? (
                      <div className="workflow-stage-empty">Loading users...</div>
                    ) : approverDepartmentUsers.length > 0 ? (
                      <div className="workflow-stage-assignee-list">
                        {approverDepartmentUsers.map((candidate) => {
                          const candidateId = normalizeUserId(candidate.id);
                          if (!candidateId) return null;
                          return (
                            <label key={`task-approver-option-${candidateId}`} className="workflow-stage-assignee-option">
                              <input
                                type="checkbox"
                                checked={normalizeUserIds(formData.approverIds).includes(candidateId)}
                                onChange={() => toggleTaskApprover(candidateId, candidate)}
                              />
                              <span>
                                <strong>{candidate.name}</strong>
                                <small>
                                  {[candidate.department, candidate.position].filter(Boolean).join(' | ')}
                                </small>
                              </span>
                            </label>
                          );
                        })}
                      </div>
                    ) : (
                      <div className="workflow-stage-empty">No users found in this department.</div>
                    )
                  ) : (
                    <div className="workflow-stage-empty">
                      Pick a department above to find approvers from that team.
                    </div>
                  )}

                  {normalizeUserIds(formData.approverIds).length > 1 && (
                    <label className="workflow-toggle compact workflow-stage-approval-mode">
                      <input
                        type="checkbox"
                        checked={normalizeApprovalMode(formData.approvalMode) === 'all'}
                        onChange={(e) => handleChange('approvalMode', e.target.checked ? 'all' : 'any')}
                      />
                      <span>
                        Require every approver to approve
                        <small>
                          {normalizeApprovalMode(formData.approvalMode) === 'all'
                            ? 'This task only completes once all selected approvers have approved.'
                            : 'This task completes as soon as any one selected approver approves.'}
                        </small>
                      </span>
                    </label>
                  )}
                </div>
              </div>
            </div>
          )}

          <div className="assign-row">
            <div className="assign-card full-width workflow-builder-card">
                <div className="workflow-builder-header">
                  <div>
                    <div className="workflow-builder-title-row">
                      <span className="workflow-step-badge">Step 2</span>
                      <h3>Stage Setup</h3>
                    </div>
                    <p>
                      Break this task into ordered handoff stages. Each stage can have its own assignee and approval gate.
                    </p>
                  </div>
                  <label className="workflow-toggle">
                    <input
                      type="checkbox"
                      checked={formData.workflowEnabled}
                      onChange={toggleWorkflowEnabled}
                    />
                    <span>Enable staged workflow</span>
                  </label>
                </div>

                {formData.workflowEnabled ? (
                  <div className="workflow-builder-body">
                    <div className="workflow-setup-summary">
                      <span>{formData.workflowStages.length} stage{formData.workflowStages.length === 1 ? '' : 's'}</span>
                      <span>{selectedReceivers.length} receiver{selectedReceivers.length === 1 ? '' : 's'} available for assignment</span>
                      <span>{workflowApprovalStageCount} approval stage{workflowApprovalStageCount === 1 ? '' : 's'}</span>
                    </div>

                    <div className="workflow-builder-meta">
                      <label className="workflow-toggle compact">
                        <input
                          type="checkbox"
                          checked={formData.finalApprovalRequired}
                          onChange={(e) => handleChange('finalApprovalRequired', e.target.checked)}
                        />
                        <span>Final stage needs creator approval</span>
                      </label>
                      <span className="workflow-builder-hint">
                        Only receivers selected above can be assigned into workflow stages.
                      </span>
                    </div>

                    {formData.workflowStages.map((stage, stageIndex) => (
                      <div key={`workflow-stage-${stageIndex}`} className="workflow-stage-card">
                        <div className="workflow-stage-top">
                          <div>
                            <span className="workflow-stage-order">Stage {stageIndex + 1}</span>
                            <strong>{stage.title || `Stage ${stageIndex + 1}`}</strong>
                          </div>
                          <div className="workflow-stage-top-actions">
                            <label className="workflow-toggle compact">
                              <input
                                type="checkbox"
                                checked={Boolean(stage.approvalRequired)}
                                onChange={(e) => updateWorkflowStage(stageIndex, { approvalRequired: e.target.checked })}
                              />
                              <span>Need approval</span>
                            </label>
                            <button
                              type="button"
                              className="assign-secondary-btn workflow-stage-remove"
                              onClick={() => removeWorkflowStage(stageIndex)}
                              disabled={formData.workflowStages.length <= 1}
                            >
                              Remove
                            </button>
                          </div>
                        </div>

                        <div className="assign-row workflow-stage-fields">
                          <div className="assign-field">
                            <label>Stage Title</label>
                            <input
                              type="text"
                              placeholder={`Stage ${stageIndex + 1}`}
                              value={stage.title}
                              onChange={(e) => updateWorkflowStage(stageIndex, { title: e.target.value })}
                            />
                          </div>
                        </div>

                        <div className="assign-row workflow-stage-fields">
                          <div className="assign-field">
                            <label>Stage Instructions</label>
                            <textarea
                              className="task-textarea workflow-stage-textarea"
                              rows={3}
                              placeholder="Describe what this stage needs to deliver."
                              value={stage.description}
                              onChange={(e) => updateWorkflowStage(stageIndex, { description: e.target.value })}
                            />
                          </div>
                        </div>

                        <div className="workflow-stage-assignees">
                          <div className="workflow-stage-assignees-copy">
                            <h4>Stage Assignees</h4>
                            <p>
                              Pick one or more people from the selected receiver pool for this handoff.
                            </p>
                          </div>
                          {selectedReceivers.length > 0 ? (
                            <div className="workflow-stage-assignee-list">
                              {selectedReceivers.map((receiver) => (
                                <label key={`${stageIndex}-${receiver.id}`} className="workflow-stage-assignee-option">
                                  <input
                                    type="checkbox"
                                    checked={normalizeUserIds(stage.assigneeIds).includes(receiver.id)}
                                    onChange={() => toggleStageAssignee(stageIndex, receiver.id)}
                                  />
                                  <span>
                                    <strong>{receiver.name}</strong>
                                    <small>
                                      {[receiver.department, receiver.position].filter(Boolean).join(' | ') || `User ID ${receiver.id}`}
                                    </small>
                                  </span>
                                </label>
                              ))}
                            </div>
                          ) : (
                            <div className="workflow-stage-empty">
                              Add receivers above first, then assign them into stages here.
                            </div>
                          )}
                        </div>

                        <div className="workflow-stage-approvers">
                          <div className="workflow-stage-assignees-copy">
                            <h4>Stage Approvers (optional)</h4>
                            <p>
                              Pick specific people to approve this stage instead of the default flow
                              (creator, HOD, or SPOC). Leave empty to keep the default. Approvers can be
                              anyone in the company, from any department - not just this task's receivers.
                            </p>
                          </div>

                          {normalizeUserIds(stage.approverIds).length > 0 && (
                            <div className="workflow-stage-approver-chips">
                              {normalizeUserIds(stage.approverIds).map((approverId) => {
                                const approver = knownUsersById[approverId] || { id: approverId, name: `User #${approverId}` };
                                return (
                                  <span key={`${stageIndex}-approver-${approverId}`} className="workflow-stage-approver-chip">
                                    {approver.name}
                                    <button
                                      type="button"
                                      onClick={() => toggleStageApprover(stageIndex, approverId)}
                                      aria-label={`Remove ${approver.name} as approver`}
                                    >
                                      ×
                                    </button>
                                  </span>
                                );
                              })}
                            </div>
                          )}

                          <div className="assign-field workflow-stage-approver-department">
                            <label>Find approvers in department</label>
                            <select
                              value={approverBrowseDepartment}
                              onChange={(e) => setApproverBrowseDepartment(e.target.value)}
                            >
                              <option value="">-- Select Department --</option>
                              {departments.map((dept) => (
                                <option key={dept} value={dept}>{dept}</option>
                              ))}
                            </select>
                          </div>

                          {approverBrowseDepartment ? (
                            loadingApproverUsers ? (
                              <div className="workflow-stage-empty">Loading users...</div>
                            ) : approverDepartmentUsers.length > 0 ? (
                              <div className="workflow-stage-assignee-list">
                                {approverDepartmentUsers.map((candidate) => {
                                  const candidateId = normalizeUserId(candidate.id);
                                  if (!candidateId) return null;
                                  return (
                                    <label key={`${stageIndex}-approver-option-${candidateId}`} className="workflow-stage-assignee-option">
                                      <input
                                        type="checkbox"
                                        checked={normalizeUserIds(stage.approverIds).includes(candidateId)}
                                        onChange={() => toggleStageApprover(stageIndex, candidateId, candidate)}
                                      />
                                      <span>
                                        <strong>{candidate.name}</strong>
                                        <small>
                                          {[candidate.department, candidate.position].filter(Boolean).join(' | ')}
                                        </small>
                                      </span>
                                    </label>
                                  );
                                })}
                              </div>
                            ) : (
                              <div className="workflow-stage-empty">No users found in this department.</div>
                            )
                          ) : (
                            <div className="workflow-stage-empty">
                              Pick a department above to find approvers from that team.
                            </div>
                          )}

                          {normalizeUserIds(stage.approverIds).length > 1 && (
                            <label className="workflow-toggle compact workflow-stage-approval-mode">
                              <input
                                type="checkbox"
                                checked={normalizeApprovalMode(stage.approvalMode) === 'all'}
                                onChange={(e) => updateWorkflowStage(stageIndex, { approvalMode: e.target.checked ? 'all' : 'any' })}
                              />
                              <span>
                                Require every approver to approve
                                <small>
                                  {normalizeApprovalMode(stage.approvalMode) === 'all'
                                    ? 'This stage only advances once all selected approvers have approved.'
                                    : 'This stage advances as soon as any one selected approver approves.'}
                                </small>
                              </span>
                            </label>
                          )}
                        </div>
                      </div>
                    ))}

                    <div className="workflow-builder-actions">
                      <button type="button" className="assign-draft-btn" onClick={addWorkflowStage}>
                        Add Stage
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="workflow-builder-empty">
                    This task will follow the normal single-step assignment flow unless staged workflow is enabled.
                  </div>
                )}
            </div>
          </div>

          {/* Timeline & Priority */}
          <div className="assign-row">
            <div className="assign-card full-width">
              <div className="assign-card-header">
                <h3>Timeline</h3>
                <p>When this is due, and how urgently it should be picked up.</p>
              </div>
              <div className="assign-timeline-row">
                <div className="assign-field">
                  <label>Deadline <span className="assign-field-hint-inline">(IST)</span></label>
                  <div className="deadline-input-row">
                    <span className="deadline-input-icon" aria-hidden="true">📅</span>
                    <input
                      type="datetime-local"
                      value={formData.deadline}
                      min={getMinimumDeadlineInputValue()}
                      onChange={(e) => handleChange('deadline', e.target.value)}
                    />
                  </div>
                  <div className="deadline-quick-picks">
                    <button type="button" onClick={() => handleChange('deadline', getEndOfDayDeadlineValue())}>
                      EOD
                    </button>
                    <button type="button" onClick={() => handleChange('deadline', getQuickDeadlineValue(1))}>
                      Tomorrow
                    </button>
                    <button type="button" onClick={() => handleChange('deadline', getQuickDeadlineValue(3))}>
                      +3 days
                    </button>
                    <button type="button" onClick={() => handleChange('deadline', getQuickDeadlineValue(7))}>
                      +1 week
                    </button>
                    {formData.deadline && (
                      <button
                        type="button"
                        className="deadline-clear-btn"
                        onClick={() => handleChange('deadline', '')}
                      >
                        Clear
                      </button>
                    )}
                  </div>
                </div>
                <div className="assign-card priority-card">
                  <h3>Priority</h3>
                  <div className="assign-priority-options">
                    {PRIORITY_OPTIONS.map((option) => (
                      <label
                        key={option.value}
                        className={`priority-pill priority-${option.tone} ${formData.priority === option.value ? 'active' : ''}`}
                        title={option.hint}
                      >
                        <input
                          type="radio"
                          name="priority"
                          checked={formData.priority === option.value}
                          onChange={() => handleChange('priority', option.value)}
                        />
                        <span className="priority-pill-dot" aria-hidden="true" />
                        {option.value}
                      </label>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* Task Details */}
          <div className="assign-row assign-card">
            <div className="task-details-box">
              <div className="assign-card-header">
                <h3>Task Details</h3>
                <p>Be specific: goals, references, and any constraints the assignee needs to know.</p>
              </div>
              <textarea
                placeholder="Enter detailed description..."
                className="task-textarea"
                rows={4}
                value={formData.taskDetails}
                onChange={(e) => handleChange('taskDetails', e.target.value)}
              />
              {formData.taskDetails?.trim() ? (
                <div className="task-textarea-footer">
                  <span>{formData.taskDetails.trim().length} characters</span>
                </div>
              ) : null}
            </div>
          </div>

          {/* Request Type + Task Tag */}
          <div className="assign-row">
            <div className="assign-card full-width">
              <div className="assign-card-header">
                <h3>Task Classification</h3>
                <p>How this task should be categorized and routed.</p>
              </div>
              <div className="assign-classification-row">
                <div className="assign-field">
                  <label>Request Type</label>
                  <select
                    value={formData.taskType}
                    onChange={(e) => handleChange('taskType', e.target.value)}
                  >
                    <option value="task">Task</option>
                    <option value="task_approval">Task Approval</option>
                    <option value="submission_result">Submission Result</option>
                  </select>
                </div>
                <div className="assign-field">
                  <label>Tag of Task <span className="required">*</span></label>
                  <select
                    value={formData.taskTag}
                    onChange={(e) => handleChange('taskTag', e.target.value)}
                  >
                    <option value="">-- Select Tag --</option>
                    {TASK_TAG_OPTIONS.map((tag) => (
                      <option key={tag} value={tag}>{tag}</option>
                    ))}
                  </select>
                </div>
              </div>
            </div>
          </div>

          {/* Attachments */}
          <div className="assign-row">
            <AttachmentBox 
              attachments={formData.attachments}
              onChange={handleAttachmentsChange}
            />
          </div>

          {submitUploadState.active && (
            <div className="assign-row">
              <div className="assign-upload-status" role="status" aria-live="polite">
                <div className="assign-upload-status-header">
                  <div className="assign-upload-status-copy">
                    <strong>{submitUploadState.phase || 'Uploading attachments...'}</strong>
                    <span>
                      {formatUploadSize(submitUploadState.uploadedBytes)} of {formatUploadSize(submitUploadState.totalBytes)} transferred
                    </span>
                  </div>
                  <div className="assign-upload-status-percent">{submitUploadState.percent}%</div>
                </div>
                <div className="assign-upload-status-bar" aria-hidden="true">
                  <span style={{ width: `${submitUploadState.percent}%` }} />
                </div>
                <div className="assign-upload-status-file">
                  <span>{submitUploadState.currentFileName || 'Preparing upload...'}</span>
                  <small>
                    {submitUploadState.currentFileIndex > 0 ? `File ${submitUploadState.currentFileIndex} of ${submitUploadState.fileCount} • ` : ''}
                    {formatUploadSize(submitUploadState.currentFileUploadedBytes)} of {formatUploadSize(submitUploadState.currentFileTotalBytes)}
                    {submitUploadState.currentFileTotalBytes ? ` • ${submitUploadState.currentFilePercent}%` : ''}
                  </small>
                </div>
              </div>
            </div>
          )}

          {/* Links */}
          <div className="assign-row">
            <TaskForm 
              links={formData.links}
              onChange={handleLinksChange}
            />
          </div>

          {/* Actions */}
          <div className="assign-actions">
            <button 
              className="assign-primary-btn" 
              onClick={handleCreateTask}
              disabled={isSaving}
            >
              {isSaving
                ? submitUploadState.active
                  ? `${submitUploadState.phase || 'UPLOADING...'} ${submitUploadState.percent}%`
                  : (isTaskEditMode ? 'UPDATING...' : isDraftEdit ? 'SENDING...' : 'CREATING...')
                : (isTaskEditMode ? 'UPDATE TASK' : isDraftEdit ? 'SEND TASK' : 'CREATE TASK')}
            </button>
            
            <button 
              className="assign-draft-btn" 
              onClick={() => saveDraft(false)}
              disabled={isSaving || !hasFormData()}
            >
              {isSaving ? 'SAVING...' : 'SAVE AS DRAFT'}
            </button>

            <button 
              className="assign-clear-btn" 
              onClick={handleClear}
              disabled={isSaving}
            >
              CLEAR FORM
            </button>

            <button 
              className="assign-secondary-btn" 
              onClick={handleClose}
            >
              CANCEL
            </button>
          </div>
        </div>
        )}
      </div>
    </div>
  );
});

AssignTaskModal.displayName = 'AssignTaskModal';

export default AssignTaskModal;
