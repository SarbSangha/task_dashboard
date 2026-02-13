// // src/components/leftsidebar/compofleftsidebar/AssignTaskModal.jsx
// import React from 'react';
// import './AssignTaskModal.css';
// import AttachmentBox from './Attachments';
// import TaskForm from './LinkArea';

// const AssignTaskModal = ({ isOpen, onClose }) => {
//   if (!isOpen) return null;

//   const stopPropagation = (e) => e.stopPropagation();

//   return (
//     <div className="assign-modal-backdrop" onClick={onClose}>
//       <div className="assign-modal" onClick={stopPropagation}>
//         {/* Top dark bar */}
//         <div className="assign-modal-header-bar">
//           <span>ASSIGN NEW TASK</span>
//           <button
//             className="assign-close-icon"
//             onClick={onClose}
//             aria-label="Close"
//           >
//             ✕
//           </button>
//         </div>

//         <div className="assign-modal-body">
//           <h2 className="assign-title">ASSIGN NEW TASK</h2>

//           {/* Task name / description */}
//           <div className="assign-row">
//             <div className="assign-field">
//               <label>Project Name</label>
//               <input type="text" placeholder="Project Alpha" />
//             </div>
//             <div className="assign-field">
//               <label>Task Name</label>
//               <input type="text" placeholder="Task Name " />
//             </div>
//           </div>

//           {/* Reference / hours */}
//           <div className="assign-row">
//             <div className="assign-field">
//               <label>Reference / Related</label>
//               <input type="text" placeholder="PN/TN/REF" />
//             </div>
              
//           </div>

//           {/* Assignment + Priority */}
//           <div className="assign-row">
//             <div className="assign-card">
//               <div className="assign-field">
//                 <label>My Department</label>
//                 <input type="text" placeholder='list of Emp of dept' />
//               </div>
//               </div>
//               <div className='assign-card'>
//                 <div className="assign-field">
//                 <label>To The Department</label>
//                 <select>
//                   <option>Gen Ai</option>
//                   <option>Creative </option>
//                   <option>Account</option>
//                   <option>Hr</option>
//                 </select>
//               </div>
//               </div>
//           </div>

//           {/* Timeline */}
//           <div className="assign-row">
//             <div className="assign-card full-width">
//               <h3>Timeline</h3>
//               <div className="assign-timeline-row">

//                 <div className="assign-field">
//                   <label>DeadLine</label>
//                   <input   type="datetime-local" />
//                 </div>
//               <div className="assign-card">
//               <h3>Priority</h3>
//               <div className="assign-priority-options">
//                 <label>
//                   <input type="radio" name="priority" defaultChecked /> High
//                 </label>
//                 <label>
//                   <input type="radio" name="priority" /> Medium
//                 </label>
//                 <label>
//                   <input type="radio" name="priority" /> Low
//                 </label>
//               </div>
//             </div>

//               </div>
//             </div>
//           </div>

//               {/* Task Details */}
//               <div className="assign-row assign-card">
//                 {/* <div className="assign-card"> */}

//                   <div className="task-details-box">
//                   <h3>Task Details</h3>
//                     <textarea
//                       placeholder="Enter detailed description..."
//                       className="task-textarea"
//                       rows={4}
//                     />
//                   </div>
//                 {/* </div> */}
//               </div>


//             {/*Task Tag*/}
//             <div className="assign-row">
//             <div className="assign-field">
//                 <label>Tag of Task</label>
//                 <select>
//                   <option>Audio</option>
//                   <option>vedio</option>
//                   <option>content</option>
//                 </select>
//               </div>
//               </div>



//           {/* Attachments + Assignees */}
//           <div className="assign-row">

//           <AttachmentBox></AttachmentBox>
//           </div>

//           {/* link box */}
//           <div className="assign-row">

//           <TaskForm></TaskForm>
//           </div>

//           {/* Actions */}
//           <div className="assign-actions">
//             <button className="assign-primary-btn">CREATE TASK</button>
//             <button className="assign-secondary-btn" onClick={onClose}>
//               CANCEL
//             </button>
//           </div>
//         </div>
//       </div>
//     </div>
//   );
// };

// export default AssignTaskModal;






// src/components/leftsidebar/compofleftsidebar/AssignTaskModal.jsx
import React, { useState, useEffect } from 'react';
import './AssignTaskModal.css';
import AttachmentBox from './Attachments';
import TaskForm from './LinkArea';
import { taskAPI, draftAPI } from '../../../../services/api';

const AssignTaskModal = ({ isOpen, onClose }) => {
  // Form state
  const [formData, setFormData] = useState({
    projectName: '',
    taskName: '',
    reference: '',
    myDepartment: '',
    toDepartment: 'Gen Ai',
    deadline: '',
    priority: 'High',
    taskDetails: '',
    taskTag: 'Audio',
    attachments: [],
    links: []
  });

  const [isSaving, setIsSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState('');
  const [currentDraftId, setCurrentDraftId] = useState(null);

  // Load draft when modal opens
  useEffect(() => {
    if (isOpen) {
      loadDraft();
    }
  }, [isOpen]);

  // Auto-save every 30 seconds
  useEffect(() => {
    if (!isOpen) return;

    const autoSaveInterval = setInterval(() => {
      if (hasFormData()) {
        saveDraft(true); // Silent auto-save
      }
    }, 30000);

    return () => clearInterval(autoSaveInterval);
  }, [isOpen, formData]);

  // Load draft from API or localStorage
  const loadDraft = async () => {
    try {
      // Try API first
      const result = await draftAPI.loadLatestDraft();
      
      if (result.data) {
        setFormData(result.data);
        if (result.data._id || result.data.id) {
          setCurrentDraftId(result.data._id || result.data.id);
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
      const confirm = window.confirm('Are you sure you want to clear all form data?');
      if (!confirm) return;
    }

    const emptyForm = {
      projectName: '',
      taskName: '',
      reference: '',
      myDepartment: '',
      toDepartment: 'Gen Ai',
      deadline: '',
      priority: 'High',
      taskDetails: '',
      taskTag: 'Audio',
      attachments: [],
      links: []
    };

    setFormData(emptyForm);
    setCurrentDraftId(null);
    localStorage.removeItem('taskDraft');
    showMessage('Form cleared', 'success');
  };

  // Save as draft
  const saveDraft = async (silent = false) => {
  if (!hasFormData()) {
    if (!silent) showMessage('Nothing to save', 'warning');
    return;
  }

  setIsSaving(true);

  try {
    // Save to localStorage immediately
    localStorage.setItem('taskDraft', JSON.stringify(formData));

    let response;
    if (currentDraftId) {
      // Try to update existing draft
      try {
        response = await draftAPI.updateDraft(currentDraftId, formData);
      } catch (updateError) {
        // If update fails (404), create new draft
        console.log('Draft not found, creating new one');
        response = await draftAPI.saveDraft(formData);
        if (response.id || response._id) {
          setCurrentDraftId(response.id || response._id);
        }
      }
    } else {
      // Create new draft
      response = await draftAPI.saveDraft(formData);
      if (response.id || response._id) {
        setCurrentDraftId(response.id || response._id);
      }
    }

    if (!silent) {
      showMessage('Draft saved successfully', 'success');
    }
  } catch (error) {
    console.error('Error saving draft:', error);
    
    // Even if API fails, localStorage worked
    if (!silent) {
      showMessage('Draft saved locally (server error)', 'warning');
    }
  } finally {
    setIsSaving(false);
  }
};

  // Create task (submit)
  const handleCreateTask = async () => {
    // Validation
    if (!formData.projectName || !formData.taskName) {
      showMessage('Please fill required fields (Project Name & Task Name)', 'error');
      return;
    }

    setIsSaving(true);

    try {
      // Send to FastAPI backend
      const response = await taskAPI.createTask(formData);

      showMessage('Task created successfully!', 'success');
      
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
      console.error('Error creating task:', error);
      const errorMsg = error.response?.data?.detail || 'Failed to create task';
      showMessage(errorMsg, 'error');
    } finally {
      setIsSaving(false);
    }
  };

  // Show message helper
  const showMessage = (message, type) => {
    setSaveMessage({ text: message, type });
    setTimeout(() => setSaveMessage(''), 3000);
  };

  // Handle modal close
  const handleClose = () => {
    if (hasFormData()) {
      const confirm = window.confirm(
        'You have unsaved changes. Do you want to save as draft before closing?'
      );
      if (confirm) {
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

  return (
    <div className="assign-modal-backdrop" onClick={handleClose}>
      <div className="assign-modal" onClick={stopPropagation}>
        {/* Top dark bar */}
        <div className="assign-modal-header-bar">
          <span>ASSIGN NEW TASK</span>
          <div className="header-actions">
            {saveMessage && (
              <span className={`save-message ${saveMessage.type}`}>
                {saveMessage.text}
              </span>
            )}
            <button
              className="assign-close-icon"
              onClick={handleClose}
              aria-label="Close"
            >
              ✕
            </button>
          </div>
        </div>

        <div className="assign-modal-body">
          <h2 className="assign-title">ASSIGN NEW TASK</h2>

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
              <label>Task Name <span className="required">*</span></label>
              <input 
                type="text" 
                placeholder="Task Name" 
                value={formData.taskName}
                onChange={(e) => handleChange('taskName', e.target.value)}
              />
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
                  placeholder='List of Emp of dept' 
                  value={formData.myDepartment}
                  onChange={(e) => handleChange('myDepartment', e.target.value)}
                />
              </div>
            </div>
            <div className='assign-card'>
              <div className="assign-field">
                <label>To The Department</label>
                <select 
                  value={formData.toDepartment}
                  onChange={(e) => handleChange('toDepartment', e.target.value)}
                >
                  <option>Gen Ai</option>
                  <option>Creative</option>
                  <option>Account</option>
                  <option>Hr</option>
                </select>
              </div>
            </div>
          </div>

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

          {/* Task Tag */}
          <div className="assign-row">
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
              {isSaving ? 'CREATING...' : 'CREATE TASK'}
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
      </div>
    </div>
  );
};

export default AssignTaskModal;
