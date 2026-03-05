// src/components/leftsidebar/compofleftsidebar/AssignTaskModal.jsx
import React, { useState, useEffect } from 'react';
import './AssignTaskModal.css';
import AttachmentBox from './Attachments';
import TaskForm from './LinkArea';
import { taskAPI, draftAPI, authAPI, fileAPI } from '../../../../services/api';

const AssignTaskModal = ({ isOpen, onClose, editingTask = null }) => {
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
    links: []
  });

  // NEW: Department and user data
  const [departments, setDepartments] = useState([]);
  const [departmentUsers, setDepartmentUsers] = useState([]);
  const [loadingUsers, setLoadingUsers] = useState(false);
  const [showUserDropdown, setShowUserDropdown] = useState(false);
  const [projectIdState, setProjectIdState] = useState({ status: 'idle', message: '' });
  const [taskIdState, setTaskIdState] = useState({ status: 'idle', message: '' });
  const [taskIdSuggestions, setTaskIdSuggestions] = useState([]);
  const [projectIdSuggestions, setProjectIdSuggestions] = useState([]);

  const [isSaving, setIsSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState('');
  const [currentDraftId, setCurrentDraftId] = useState(null);
  const [isMinimized, setIsMinimized] = useState(false);
  const [isMaximized, setIsMaximized] = useState(false);

  // ✅ ADDED: showMessage helper function
  const showMessage = (message, type) => {
    setSaveMessage({ text: message, type });
    setTimeout(() => setSaveMessage(''), 3000);
  };

  // NEW: Load current user and departments on mount
  useEffect(() => {
    if (isOpen) {
      loadCurrentUserDepartment();
      loadDepartments();
      loadIdSuggestions();
    }
  }, [isOpen]);

  const loadIdSuggestions = async () => {
    try {
      const response = await taskAPI.getAllTasks();
      const rows = response?.tasks || [];
      const uniqueTaskIds = Array.from(
        new Set(
          rows
            .map((row) => (row.taskNumber || '').trim())
            .filter(Boolean)
        )
      ).slice(0, 300);
      const uniqueProjectIds = Array.from(
        new Set(
          rows
            .map((row) => (row.projectId || '').trim())
            .filter(Boolean)
        )
      ).slice(0, 300);

      setTaskIdSuggestions(uniqueTaskIds);
      setProjectIdSuggestions(uniqueProjectIds);
    } catch (error) {
      console.warn('Unable to load ID suggestions:', error);
      setTaskIdSuggestions([]);
      setProjectIdSuggestions([]);
    }
  };

  // NEW: Load current user's department
  const loadCurrentUserDepartment = async () => {
    try {
      const response = await authAPI.getCurrentUser();
      if (response.user?.department) {
        setFormData(prev => ({
          ...prev,
          myDepartment: response.user.department
        }));
      }
    } catch (error) {
      console.error('Error loading current user:', error);
    }
  };

  // NEW: Load all departments
  const loadDepartments = async () => {
    try {
      const response = await authAPI.getDepartments();
      if (response.departments) {
        setDepartments(response.departments);
      }
    } catch (error) {
      console.error('Error loading departments:', error);
    }
  };

  // NEW: Load users when department changes
  const loadDepartmentUsers = async (departmentName) => {
    if (!departmentName) {
      setDepartmentUsers([]);
      return;
    }

    setLoadingUsers(true);
    try {
      const response = await authAPI.getUsersByDepartment(departmentName);
      if (response.users) {
        setDepartmentUsers(response.users);
      }
    } catch (error) {
      console.error('Error loading department users:', error);
      showMessage('Failed to load users', 'error');
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
        taskId: editingTask.taskNumber || '',
        projectId: editingTask.projectId || '',
        projectIdRaw: editingTask.projectIdRaw || '',
        projectIdHex: editingTask.projectIdHex || '',
        customerName: editingTask.customerName || '',
        taskName: editingTask.title || '',
        reference: editingTask.reference || '',
        myDepartment: editingTask.fromDepartment || '',
        selectedUserIds: (editingTask.assignedTo || []).map((u) => u.id),
        toDepartment: editingTask.toDepartment || 'Gen Ai',
        deadline: editingTask.deadline ? new Date(editingTask.deadline).toISOString().slice(0, 16) : '',
        priority: editingTask.priority
          ? editingTask.priority.charAt(0).toUpperCase() + editingTask.priority.slice(1).toLowerCase()
          : 'High',
        taskDetails: editingTask.description || '',
        taskTag: editingTask.taskTag || 'Audio',
        taskType: editingTask.taskType || 'task',
        attachments: editingTask.attachments || [],
        links: editingTask.links || []
      };
      setFormData(mappedEditData);
      if (editingTask.toDepartment) {
        loadDepartmentUsers(editingTask.toDepartment);
      }
      setCurrentDraftId(null);
      return;
    }

    loadDraft();
  }, [isOpen, editingTask]);

  useEffect(() => {
    if (isOpen) {
      setIsMinimized(false);
      setIsMaximized(false);
    }
  }, [isOpen]);

  // Auto-save every 30 seconds
  useEffect(() => {
    if (!isOpen || editingTask) return;

    const autoSaveInterval = setInterval(() => {
      if (hasFormData()) {
        saveDraft(true); // Silent auto-save
      }
    }, 30000);

    return () => clearInterval(autoSaveInterval);
  }, [isOpen, formData, editingTask]);

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
          myDepartment: result.data.myDepartment || '',
          selectedUserIds: result.data.selectedUserIds || [],
          toDepartment: result.data.toDepartment || 'Gen Ai',
          deadline: result.data.deadline || '',
          priority: result.data.priority ? 
            result.data.priority.charAt(0).toUpperCase() + result.data.priority.slice(1) : 'High',
          taskDetails: result.data.description || '',
          taskTag: result.data.taskTag || 'Audio',
          taskType: result.data.taskType || 'task',
          attachments: result.data.attachments || [],
          links: result.data.links || []
        };
        
        setFormData(mappedData);
        
        // Load users for toDepartment if available
        if (result.data.toDepartment) {
          loadDepartmentUsers(result.data.toDepartment);
        }
        
        if (result.data.id) {
          setCurrentDraftId(result.data.id);
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
        setFormData(JSON.parse(localDraft));
        showMessage('Local draft loaded', 'success');
      }
    }
  };

  // Check if form has data
  const hasFormData = () => {
    return Object.values(formData).some(value => {
      if (Array.isArray(value)) return value.length > 0;
      return value !== '' && value !== 'Gen Ai' && value !== 'High' && value !== 'Audio';
    });
  };

  // Handle input changes
  const handleChange = (field, value) => {
    setFormData(prev => ({
      ...prev,
      [field]: value
    }));

    if (field === 'projectId' || field === 'projectName' || field === 'customerName') {
      setProjectIdState({ status: 'idle', message: '' });
    }
    if (field === 'taskId' || field === 'projectName' || field === 'customerName') {
      setTaskIdState({ status: 'idle', message: '' });
    }

    // NEW: Load users when department changes
    if (field === 'toDepartment') {
      loadDepartmentUsers(value);
      setFormData(prev => ({
        ...prev,
        selectedUserIds: [] // Reset selected users
      }));
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
  const handleClear = () => {
    if (hasFormData()) {
      const confirmClear = window.confirm('Are you sure you want to clear all form data?');
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
      links: []
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
      localStorage.setItem('taskDraft', JSON.stringify(formData));

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
        deadline: formData.deadline || null
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
          }
        }
      } else {
        response = await draftAPI.saveDraft(draftPayload);
        if (response.data?.id) {
          setCurrentDraftId(response.data.id);
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
    if (!formData.taskName || (!editingTask && !formData.projectName)) {
      showMessage(
        editingTask
          ? 'Please fill required field (Task Name)'
          : 'Please fill required fields (Project Name & Task Name)',
        'error'
      );
      return;
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
      };

      console.log('📤 Sending task payload:', taskPayload);

      if (editingTask?.id) {
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
      handleClear();
      
      // Close modal after 1.5 seconds
      setTimeout(() => {
        onClose();
      }, 1500);
    } catch (error) {
      console.error('❌ Error creating task:', error);
      
      let errorMsg = editingTask?.id ? 'Failed to update task' : 'Failed to create task';
      
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
  const handleClose = () => {
    if (hasFormData()) {
      const confirmClose = window.confirm(
        'You have unsaved changes. Do you want to save as draft before closing?'
      );
      if (confirmClose) {
        saveDraft();
        setTimeout(onClose, 500);
      } else {
        onClose();
      }
    } else {
      onClose();
    }
  };

  const stopPropagation = (e) => e.stopPropagation();

  if (!isOpen) return null;

  const handleToggleMinimize = () => {
    if (isMinimized) {
      setIsMinimized(false);
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

  const handleGenerateProjectId = async () => {
    if (!formData.projectName || !formData.customerName) {
      setProjectIdState({ status: 'error', message: 'Project Name and Customer Name are required to generate ID.' });
      return;
    }
    try {
      const response = await taskAPI.generateProjectId(formData.projectName, formData.customerName);
      setFormData(prev => ({
        ...prev,
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
    if (!formData.projectName || !formData.customerName) {
      setTaskIdState({ status: 'error', message: 'Project Name and Customer Name are required to generate Task ID.' });
      return;
    }
    try {
      const response = await taskAPI.generateTaskId(formData.projectName, formData.customerName);
      setFormData(prev => ({
        ...prev,
        taskId: response.taskId || ''
      }));
      setTaskIdState({ status: 'success', message: 'Task ID generated.' });
    } catch (error) {
      setTaskIdState({ status: 'error', message: 'Could not generate Task ID.' });
    }
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
    <div className={`assign-modal-backdrop ${isMinimized ? 'disabled' : ''}`} onClick={!isMinimized ? handleClose : undefined}>
      <div className={`assign-modal ${isMinimized ? 'minimized' : ''} ${isMaximized ? 'maximized' : ''}`} onClick={stopPropagation}>
        {/* Top dark bar */}
        <div className="assign-modal-header-bar" onClick={isMinimized ? () => setIsMinimized(false) : undefined}>
          <span>{editingTask ? 'EDIT TASK' : 'CREATE NEW TASK'}</span>
          <div className="header-actions">
            {saveMessage && (
              <span className={`save-message ${saveMessage.type}`}>
                {saveMessage.text}
              </span>
            )}
            <button
              className="assign-window-btn"
              onClick={(e) => {
                e.stopPropagation();
                handleToggleMinimize();
              }}
              aria-label={isMinimized ? 'Restore' : 'Minimize'}
              title={isMinimized ? 'Restore' : 'Minimize'}
            >
              {isMinimized ? '▢' : '─'}
            </button>
            <button
              className="assign-window-btn"
              onClick={(e) => {
                e.stopPropagation();
                handleToggleMaximize();
              }}
              aria-label={isMaximized ? 'Restore window' : 'Maximize'}
              title={isMaximized ? 'Restore window' : 'Maximize'}
            >
              {isMaximized ? '❐' : '□'}
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
          <h2 className="assign-title">{editingTask ? 'EDIT TASK' : 'CREATE NEW TASK'}</h2>

          {/* Project & Task Name */}
          <div className="assign-row">
            <div className="assign-field">
              <label>Project Name <span className="required">*</span></label>
              <input 
                type="text" 
                placeholder="Project Alpha" 
                value={formData.projectName}
                onChange={(e) => handleChange('projectName', e.target.value)}
              />
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
                  Validate ID
                </button>
                <button type="button" className="assign-draft-btn" onClick={handleGenerateProjectId}>
                  Generate ID
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

          {/* Departments */}
          <div className="assign-row">
            <div className="assign-card">
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
            <div className='assign-card'>
              <div className="assign-field">
                <label>Send To Department</label>
                <select 
                  value={formData.toDepartment}
                  onChange={(e) => handleChange('toDepartment', e.target.value)}
                >
                  <option value="">-- Select Department --</option>
                  {departments.map(dept => (
                    <option key={dept} value={dept}>{dept}</option>
                  ))}
                </select>
              </div>
            </div>
          </div>

          {/* Department Users Selection */}
          {formData.toDepartment && (
            <div className="assign-row assign-card">
              <h3>Select Users from {formData.toDepartment} Department</h3>
              {loadingUsers ? (
                <p style={{ color: '#666', fontSize: '14px' }}>Loading users...</p>
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
                        {user.position && <small> ({user.position})</small>}
                      </span>
                    </label>
                  ))}
                </div>
              ) : (
                <p style={{ color: '#999', fontSize: '14px' }}>No users found in this department</p>
              )}
              {formData.selectedUserIds.length > 0 && (
                <p style={{ fontSize: '12px', color: '#0066cc', marginTop: '10px' }}>
                  ✓ {formData.selectedUserIds.length} user(s) selected
                </p>
              )}
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
                <option>Audio</option>
                <option>Video</option>
                <option>Content</option>
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
              {isSaving ? (editingTask ? 'UPDATING...' : 'CREATING...') : (editingTask ? 'UPDATE TASK' : 'CREATE TASK')}
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
