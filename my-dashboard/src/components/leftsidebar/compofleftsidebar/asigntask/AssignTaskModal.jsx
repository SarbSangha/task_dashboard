// src/components/leftsidebar/compofleftsidebar/AssignTaskModal.jsx
import React, { useMemo, useState, useEffect } from 'react';
import './AssignTaskModal.css';
import AttachmentBox from './Attachments';
import TaskForm from './LinkArea';
import { taskAPI, draftAPI, authAPI, fileAPI } from '../../../../services/api';
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

const TASK_TAG_OPTIONS = [
  'Audio',
  'Video',
  'Image',
  'Image and Vedio',
  'Script',
  'Content',
  'Animation',
  'Banner',
  'Graphic Design',
  'Motion Graphics',
  'Thumbnail',
  'Social Media',
  'Others',
];

const ASSIGN_REFERENCE_CACHE_TTL_MS = 5 * 60 * 1000;
const ASSIGN_DEPARTMENT_USERS_CACHE_TTL_MS = 3 * 60 * 1000;
const createEmptyWorkflowStage = (order = 1) => ({
  order,
  title: `Stage ${order}`,
  description: '',
  approvalRequired: false,
  assigneeIds: [],
});

const isMeaningfulWorkflowStage = (stage) => {
  const title = `${stage?.title || ''}`.trim();
  const description = `${stage?.description || ''}`.trim();
  const assigneeIds = Array.isArray(stage?.assigneeIds) ? stage.assigneeIds.filter(Boolean) : [];
  const defaultStageTitle = /^stage\s+\d+$/i.test(title);
  return Boolean(description || stage?.approvalRequired || assigneeIds.length || (title && !defaultStageTitle));
};

const AssignTaskModal = ({ isOpen, onClose, editingTask = null, onMinimizedChange, onActivate }) => {
  const { user } = useAuth();
  const { showConfirm } = useCustomDialogs();
  const isDraftEdit = Boolean(editingTask && `${editingTask.status || ''}`.toLowerCase() === 'draft');
  const isTaskEditMode = Boolean(editingTask && !isDraftEdit);
  // Form state
  const [formData, setFormData] = useState({
    projectName: '',
    taskId: '',
    projectId: '',
    projectIdRaw: '',
    projectIdHex: '',
    customerName: '',
    taskName: '',
    reference: '',
    myDepartment: '',
    selectedUserIds: [], // NEW: Array of selected user IDs
    toDepartment: 'Gen Ai',
    deadline: '',
    priority: 'High',
    taskDetails: '',
    taskTag: 'Audio',
    taskType: 'task',
    attachments: [],
    links: [],
    workflowEnabled: false,
    finalApprovalRequired: false,
    workflowStages: [],
  });

  // NEW: Department and user data
  const [departments, setDepartments] = useState([]);
  const [departmentUsers, setDepartmentUsers] = useState([]);
  const [knownUsersById, setKnownUsersById] = useState({});
  const [loadingUsers, setLoadingUsers] = useState(false);
  const [showUserDropdown, setShowUserDropdown] = useState(false);
  const [projectIdState, setProjectIdState] = useState({ status: 'idle', message: '' });
  const [taskIdState, setTaskIdState] = useState({ status: 'idle', message: '' });
  const [taskIdSuggestions, setTaskIdSuggestions] = useState([]);
  const [projectIdSuggestions, setProjectIdSuggestions] = useState([]);
  const [projectNameSuggestions, setProjectNameSuggestions] = useState([]);
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
  const [currentDraftId, setCurrentDraftId] = useState(null);
  const [isMinimized, setIsMinimized] = useState(false);
  const [isMaximized, setIsMaximized] = useState(false);
  const minimizedWindowStyle = useMinimizedWindowStack('assign-task-modal', isOpen && isMinimized);

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

  const rememberUsers = (users = []) => {
    if (!Array.isArray(users) || users.length === 0) return;
    setKnownUsersById((prev) => {
      const next = { ...prev };
      users.forEach((entry) => {
        if (!entry?.id) return;
        next[entry.id] = entry;
      });
      return next;
    });
  };

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

  // Load draft when modal opens
  useEffect(() => {
    if (!isOpen) return;

    if (editingTask) {
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
        selectedUserIds: Array.isArray(editingTask.selectedUserIds)
          ? editingTask.selectedUserIds
          : (editingTask.assignedTo || []).map((u) => u.id),
        toDepartment: normalizeDepartmentName(editingTask.toDepartment || 'Gen Ai'),
        deadline: editingTask.deadline ? new Date(editingTask.deadline).toISOString().slice(0, 16) : '',
        priority: editingTask.priority
          ? editingTask.priority.charAt(0).toUpperCase() + editingTask.priority.slice(1).toLowerCase()
          : 'High',
        taskDetails: editingTask.description || '',
        taskTag: editingTask.taskTag || 'Audio',
        taskType: editingTask.taskType || 'task',
        attachments: editingTask.attachments || [],
        links: editingTask.links || [],
        workflowEnabled: Boolean(editingTask.workflowEnabled),
        finalApprovalRequired: Boolean(editingTask.finalApprovalRequired),
        workflowStages: Array.isArray(editingTask.workflowStages)
          ? editingTask.workflowStages.map((stage, index) => ({
              order: Number(stage.order || index + 1),
              title: stage.title || `Stage ${index + 1}`,
              description: stage.description || '',
              approvalRequired: Boolean(stage.approvalRequired),
              assigneeIds: Array.isArray(stage.assigneeIds) ? stage.assigneeIds : [],
            }))
          : [],
      };
      setFormData(mappedEditData);
      rememberUsers(editingTask.assignedTo || []);
      setCurrentDraftId(isDraftEdit ? editingTask.id : null);
      return;
    }

    loadDraft();
  }, [currentUserDepartment, isOpen, editingTask, isDraftEdit]);

  useEffect(() => {
    if (isOpen) {
      setIsMinimized(false);
      setIsMaximized(false);
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

  // Auto-save every 30 seconds
  useEffect(() => {
    if (!isOpen || isTaskEditMode) return;

    const autoSaveInterval = setInterval(() => {
      if (hasFormData()) {
        saveDraft(true); // Silent auto-save
      }
    }, 30000);

    return () => clearInterval(autoSaveInterval);
  }, [isOpen, formData, isTaskEditMode]);

  // Load draft from API or localStorage
  const loadDraft = async () => {
    try {
      const result = await draftAPI.loadLatestDraft();
      
      if (result.data) {
        // ✅ Map backend fields back to form fields
      const mappedData = {
          projectName: result.data.projectName || '',
          taskId: result.data.taskId || '',
          projectId: result.data.projectId || '',
          projectIdRaw: result.data.projectIdRaw || '',
          projectIdHex: result.data.projectIdHex || '',
          customerName: result.data.customerName || '',
          taskName: result.data.title || '',
          reference: result.data.reference || '',
          myDepartment: normalizeDepartmentName(result.data.myDepartment || currentUserDepartment || ''),
          selectedUserIds: result.data.selectedUserIds || [],
          toDepartment: normalizeDepartmentName(result.data.toDepartment || 'Gen Ai'),
          deadline: result.data.deadline || '',
          priority: result.data.priority ? 
            result.data.priority.charAt(0).toUpperCase() + result.data.priority.slice(1) : 'High',
          taskDetails: result.data.description || '',
          taskTag: result.data.taskTag || 'Audio',
          taskType: result.data.taskType || 'task',
          attachments: result.data.attachments || [],
          links: result.data.links || [],
          workflowEnabled: Boolean(result.data.workflowEnabled),
          finalApprovalRequired: Boolean(result.data.finalApprovalRequired),
          workflowStages: Array.isArray(result.data.workflowStages)
            ? result.data.workflowStages.map((stage, index) => ({
                order: Number(stage.order || index + 1),
                title: stage.title || `Stage ${index + 1}`,
                description: stage.description || '',
                approvalRequired: Boolean(stage.approvalRequired),
                assigneeIds: Array.isArray(stage.assigneeIds) ? stage.assigneeIds : [],
              }))
            : []
        };
        
        setFormData(mappedData);

        if (result.data.id) {
          setCurrentDraftId(result.data.id);
        } else if (result.data.__draftId) {
          setCurrentDraftId(result.data.__draftId);
        }
        
        showMessage(
          result.source === 'local' ? 'Local draft loaded' : 'Draft loaded from server',
          'success'
        );
      }
    } catch (error) {
      console.error('Error loading draft:', error);
      
      // Fallback to localStorage
      const localDraft = localStorage.getItem('taskDraft');
      if (localDraft) {
        const parsedDraft = JSON.parse(localDraft);
        if (parsedDraft?.__draftId) {
          setCurrentDraftId(parsedDraft.__draftId);
        }
        const { __draftId, ...draftFormData } = parsedDraft || {};
        setFormData(draftFormData);
        showMessage('Local draft loaded', 'success');
      }
    }
  };

  // Check if the draft has meaningful user-entered content.
  const hasFormData = () => {
    const textFields = [
      formData.projectName,
      formData.taskId,
      formData.projectId,
      formData.customerName,
      formData.taskName,
      formData.reference,
      formData.taskDetails,
      formData.deadline,
    ];

    if (textFields.some((value) => `${value || ''}`.trim())) {
      return true;
    }
    if ((formData.selectedUserIds || []).length > 0) {
      return true;
    }
    if ((formData.attachments || []).length > 0 || (formData.links || []).length > 0) {
      return true;
    }
    if (formData.workflowEnabled && (formData.workflowStages || []).some((stage) => isMeaningfulWorkflowStage(stage))) {
      return true;
    }
    return false;
  };

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
    setFormData(prev => ({
      ...prev,
      selectedUserIds: prev.selectedUserIds.includes(userId)
        ? prev.selectedUserIds.filter(id => id !== userId)
        : [...prev.selectedUserIds, userId]
    }));
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
    setFormData((prev) => ({
      ...prev,
      workflowStages: prev.workflowStages.map((stage, index) => {
        if (index !== stageIndex) return stage;
        const assigneeIds = stage.assigneeIds.includes(userId)
          ? stage.assigneeIds.filter((id) => id !== userId)
          : [...stage.assigneeIds, userId];
        return { ...stage, assigneeIds };
      }),
    }));
  };

  const selectedReceivers = useMemo(
    () => formData.selectedUserIds.map((userId) => (
      knownUsersById[userId] || {
        id: userId,
        name: `User #${userId}`,
        department: '',
        position: '',
      }
    )),
    [formData.selectedUserIds, knownUsersById]
  );

  const workflowAssignedStageCount = useMemo(
    () => formData.workflowStages.filter((stage) => Array.isArray(stage.assigneeIds) && stage.assigneeIds.length > 0).length,
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
        assigneeIds: (stage.assigneeIds || []).filter((userId) => prev.selectedUserIds.includes(userId)),
      })),
    }));
  }, [formData.selectedUserIds, formData.workflowEnabled]);

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

  // Clear form
  const handleClear = async () => {
    if (hasFormData()) {
      const confirmClear = await showConfirm('Are you sure you want to clear all form data?', {
        title: 'Clear Form',
      });
      if (!confirmClear) return;
    }

    const emptyForm = {
      projectName: '',
      taskId: '',
      projectId: '',
      projectIdRaw: '',
      projectIdHex: '',
      customerName: '',
      taskName: '',
      reference: '',
      myDepartment: '',
      selectedUserIds: [],
      toDepartment: 'Gen Ai',
      deadline: '',
      priority: 'High',
      taskDetails: '',
      taskTag: 'Audio',
      taskType: 'task',
      attachments: [],
      links: [],
      workflowEnabled: false,
      finalApprovalRequired: false,
      workflowStages: [],
    };

    setFormData(emptyForm);
    setCurrentDraftId(null);
    localStorage.removeItem('taskDraft');
    showMessage('Form cleared', 'success');
  };

  // ✅ FIXED: Save as draft with field mapping
  const saveDraft = async (silent = false) => {
    if (!hasFormData()) {
      if (!silent) showMessage('Nothing to save', 'warning');
      return;
    }

    setIsSaving(true);

    try {
      // Save to localStorage with original field names
      localStorage.setItem('taskDraft', JSON.stringify({
        ...formData,
        __draftId: currentDraftId || null,
      }));

      // ✅ Map to backend schema
      const draftPayload = {
        title: formData.taskName || '',
        description: formData.taskDetails || '',
        projectName: formData.projectName || '',
        taskId: formData.taskId || '',
        projectId: formData.projectId || '',
        projectIdRaw: formData.projectIdRaw || '',
        projectIdHex: formData.projectIdHex || '',
        customerName: formData.customerName || '',
        taskType: formData.taskType || 'task',
        taskTag: formData.taskTag || 'Audio',
        priority: (formData.priority || 'medium').toLowerCase(),
        toDepartment: formData.toDepartment || '',
        selectedUserIds: formData.selectedUserIds || [],
        deadline: formData.deadline || null,
        workflowEnabled: Boolean(formData.workflowEnabled),
        finalApprovalRequired: Boolean(formData.finalApprovalRequired),
        workflowStages: Array.isArray(formData.workflowStages)
          ? formData.workflowStages.map((stage, index) => ({
              order: Number(stage.order || index + 1),
              title: `${stage.title || ''}`.trim(),
              description: `${stage.description || ''}`.trim(),
              approvalRequired: Boolean(stage.approvalRequired),
              assigneeIds: Array.isArray(stage.assigneeIds) ? stage.assigneeIds : [],
            }))
          : [],
      };

      let response;
      if (currentDraftId) {
        try {
          response = await draftAPI.updateDraft(currentDraftId, draftPayload);
        } catch (updateError) {
          console.log('Draft not found, creating new one');
          response = await draftAPI.saveDraft(draftPayload);
          if (response.data?.id) {
            setCurrentDraftId(response.data.id);
            localStorage.setItem('taskDraft', JSON.stringify({
              ...formData,
              __draftId: response.data.id,
            }));
          }
        }
      } else {
        response = await draftAPI.saveDraft(draftPayload);
        if (response.data?.id) {
          setCurrentDraftId(response.data.id);
          localStorage.setItem('taskDraft', JSON.stringify({
            ...formData,
            __draftId: response.data.id,
          }));
        }
      }

      if (!silent) {
        showMessage('Draft saved successfully', 'success');
      }
    } catch (error) {
      console.error('Error saving draft:', error);
      if (!silent) {
        showMessage('Draft saved locally (server error)', 'warning');
      }
    } finally {
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

    const normalizedWorkflowStages = formData.workflowEnabled
      ? formData.workflowStages.map((stage, index) => ({
          order: index + 1,
          title: `${stage.title || ''}`.trim(),
          description: `${stage.description || ''}`.trim(),
          approvalRequired: Boolean(stage.approvalRequired),
          assigneeIds: Array.isArray(stage.assigneeIds)
            ? Array.from(new Set(stage.assigneeIds.map((id) => Number(id)).filter(Boolean)))
            : [],
        }))
      : [];

    if (formData.workflowEnabled) {
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
        const uploadRes = await fileAPI.uploadFiles(filesToUpload);
        uploadedAttachments = uploadRes?.data || [];
      }
      const finalAttachments = [...existingAttachmentMeta, ...uploadedAttachments];

      // ✅ Map form data to backend schema
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
        taskTag: formData.taskTag || 'Audio',
        priority: formData.priority.toLowerCase(),
        toDepartment: formData.toDepartment,
        deadline: formData.deadline || null,
        assigneeIds: formData.selectedUserIds || [],
        reference: formData.reference || '',
        links: formData.links || [],
        attachments: finalAttachments,
        workflow: formData.workflowEnabled
          ? {
              enabled: true,
              finalApprovalRequired: Boolean(formData.finalApprovalRequired),
              stages: normalizedWorkflowStages,
            }
          : null,
      };

      console.log('📤 Sending task payload:', taskPayload);

      if (isTaskEditMode && editingTask?.id) {
        const updatePayload = {
          title: taskPayload.title,
          description: taskPayload.description,
          priority: taskPayload.priority,
          deadline: taskPayload.deadline
        };
        const response = await taskAPI.editTask(editingTask.id, updatePayload);
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
      }
      
      // Clear draft from localStorage and API
      localStorage.removeItem('taskDraft');
      if (currentDraftId) {
        try {
          await draftAPI.deleteDraft(currentDraftId);
        } catch (err) {
          console.log('Draft cleanup error:', err);
        }
      }

      // Clear form
      await handleClear();
      
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
    }
  };

  // Handle modal close
  const handleClose = async () => {
    if (hasFormData()) {
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
        onClose();
      } else if (confirmClose === 'discard') {
        onClose();
      }
    } else {
      onClose();
    }
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

    setIsMaximized(false);
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
            {!isMinimized && (
              <button
                className="assign-window-btn"
                onClick={(e) => {
                  e.stopPropagation();
                  handleToggleMinimize();
                }}
                aria-label="Minimize"
                title="Minimize"
              >
                ─
              </button>
            )}
            <button
              className="assign-window-btn"
              onClick={(e) => {
                e.stopPropagation();
                handleToggleMaximize();
              }}
              aria-label={isMinimized ? 'Restore' : isMaximized ? 'Restore window' : 'Maximize'}
              title={isMinimized ? 'Restore' : isMaximized ? 'Restore window' : 'Maximize'}
            >
              {isMinimized ? '▢' : isMaximized ? '❐' : '□'}
            </button>
            <button
              className="assign-close-icon"
              onClick={(e) => {
                e.stopPropagation();
                handleClose();
              }}
              aria-label="Close"
            >
              ✕
            </button>
          </div>
        </div>

        {!isMinimized && (
        <div className="assign-modal-body">
          <h2 className="assign-title">{isTaskEditMode ? 'EDIT TASK' : isDraftEdit ? 'EDIT DRAFT' : 'CREATE NEW TASK'}</h2>
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
              <input
                type="text"
                placeholder="Customer / Client"
                value={formData.customerName}
                onChange={(e) => handleChange('customerName', e.target.value)}
              />
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
              <label>Task ID (existing or generated)</label>
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
              <label>&nbsp;</label>
              <div className="project-id-btn-row">
                <button type="button" className="assign-secondary-btn" onClick={handleValidateTaskId}>
                  Validate Task ID
                </button>
                <button type="button" className="assign-draft-btn" onClick={handleGenerateTaskId}>
                  Generate Task ID
                </button>
              </div>
            </div>
          </div>

          <div className="assign-row">
            <div className="assign-field">
              <label>Project ID (existing or generated)</label>
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
              <label>&nbsp;</label>
              <div className="project-id-btn-row">
                <button type="button" className="assign-secondary-btn" onClick={handleValidateProjectId}>
                  Validate Proj ID
                </button>
                <button type="button" className="assign-draft-btn" onClick={handleGenerateProjectId}>
                  Generate Proj ID
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

          {!isTaskEditMode && (
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
                    <strong>Single-step task</strong>
                    <span>Assign the task normally and let one receiver or shared receiver pool handle it.</span>
                  </button>

                  <button
                    type="button"
                    className={`assignment-flow-option ${formData.workflowEnabled ? 'active' : ''}`}
                    onClick={() => setWorkflowEnabled(true)}
                    aria-pressed={formData.workflowEnabled}
                  >
                    <strong>Staged workflow</strong>
                    <span>Create Stage 1, 2, 3 handoffs where each stage can have its own assignee and approval gate.</span>
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
          )}

          <div className="assign-receiver-shell">
            {formData.workflowEnabled && !isTaskEditMode && (
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
                    Switch departments to keep building one mixed receiver list. Remove anyone anytime from the selected panel.
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
                  {formData.selectedUserIds.length > 0 && (
                    <span className="receiver-selection-badge">
                      {formData.selectedUserIds.length} selected
                    </span>
                  )}
                </div>

                {formData.toDepartment ? (
                  loadingUsers ? (
                    <div className="receiver-panel-state">Loading users...</div>
                  ) : departmentUsers.length > 0 ? (
                    <div className="department-users-list">
                      {departmentUsers.map(user => (
                        <label key={user.id} className="user-checkbox-item">
                          <input 
                            type="checkbox"
                            checked={formData.selectedUserIds.includes(user.id)}
                            onChange={() => toggleUserSelection(user.id)}
                          />
                          <span className="user-checkbox-label">
                            <strong>{user.name}</strong>
                            <small>
                              {[user.department, user.position].filter(Boolean).join(' | ')}
                            </small>
                          </span>
                        </label>
                      ))}
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

          {!isTaskEditMode && (
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
                                    checked={stage.assigneeIds.includes(receiver.id)}
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
          )}

          {/* Timeline & Priority */}
          <div className="assign-row">
            <div className="assign-card full-width">
              <h3>Timeline</h3>
              <div className="assign-timeline-row">
                <div className="assign-field">
                  <label>Deadline</label>
                  <input 
                    type="datetime-local" 
                    value={formData.deadline}
                    onChange={(e) => handleChange('deadline', e.target.value)}
                  />
                </div>
                <div className="assign-card">
                  <h3>Priority</h3>
                  <div className="assign-priority-options">
                    <label>
                      <input 
                        type="radio" 
                        name="priority" 
                        checked={formData.priority === 'High'}
                        onChange={() => handleChange('priority', 'High')}
                      /> High
                    </label>
                    <label>
                      <input 
                        type="radio" 
                        name="priority" 
                        checked={formData.priority === 'Medium'}
                        onChange={() => handleChange('priority', 'Medium')}
                      /> Medium
                    </label>
                    <label>
                      <input 
                        type="radio" 
                        name="priority" 
                        checked={formData.priority === 'Low'}
                        onChange={() => handleChange('priority', 'Low')}
                      /> Low
                    </label>
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* Task Details */}
          <div className="assign-row assign-card">
            <div className="task-details-box">
              <h3>Task Details</h3>
              <textarea
                placeholder="Enter detailed description..."
                className="task-textarea"
                rows={4}
                value={formData.taskDetails}
                onChange={(e) => handleChange('taskDetails', e.target.value)}
              />
            </div>
          </div>

          {/* Request Type + Task Tag */}
          <div className="assign-row">
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
              <label>Tag of Task</label>
              <select 
                value={formData.taskTag}
                onChange={(e) => handleChange('taskTag', e.target.value)}
              >
                {TASK_TAG_OPTIONS.map((tag) => (
                  <option key={tag} value={tag}>{tag}</option>
                ))}
              </select>
            </div>
          </div>

          {/* Attachments */}
          <div className="assign-row">
            <AttachmentBox 
              attachments={formData.attachments}
              onChange={handleAttachmentsChange}
            />
          </div>

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
                ? (isTaskEditMode ? 'UPDATING...' : isDraftEdit ? 'SENDING...' : 'CREATING...')
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
};

export default AssignTaskModal;
