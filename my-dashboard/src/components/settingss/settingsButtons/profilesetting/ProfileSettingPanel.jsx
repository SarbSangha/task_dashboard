import React, { useState, useEffect } from 'react';
import '../../SettingSidebar.css';
import { useAuth } from '../../../../context/AuthContext';
import { AvatarUpload } from '../../../profile/AvatarUpload';
import { authAPI } from '../../../../services/api';
import { useCustomDialogs } from '../../../common/CustomDialogs';
import './ProfileSettingsPanel.css';

const ProfileSettingsPanel = ({ isOpen, onClose }) => {
  const { showAlert } = useCustomDialogs();
  const { user } = useAuth();
  
  const [profileData, setProfileData] = useState({
    name: user?.name || '',
    email: user?.email || '',
    position: user?.position || '',
    department: user?.department || '',
    employeeId: user?.employeeId || '',
    flag: user?.department || '',
    avatar: user?.avatar || null
  });

  const [requestChangeFlag, setRequestChangeFlag] = useState('');
  const [statusMessage, setStatusMessage] = useState('');
  const [departmentOptions, setDepartmentOptions] = useState([]);
  const [employeeIdOptions, setEmployeeIdOptions] = useState([]);

  const POSITION_OPTIONS = ['NORMAL', 'FACULTY', 'HOD', 'SPOC', 'ADMIN'];

  useEffect(() => {
    if (!isOpen) return;
    const loadOptions = async () => {
      try {
        const [departmentsRes, employeeIdsRes] = await Promise.all([
          authAPI.getDepartments(),
          authAPI.getEmployeeIdOptions()
        ]);
        setDepartmentOptions(departmentsRes.departments || []);
        setEmployeeIdOptions(employeeIdsRes.options || []);
        if (!profileData.employeeId && employeeIdsRes.suggested) {
          setProfileData(prev => ({ ...prev, employeeId: employeeIdsRes.suggested }));
        }
      } catch (error) {
        setStatusMessage(error?.response?.data?.detail || 'Failed to load dropdown options');
      }
    };
    loadOptions();
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    const loadLatestStatus = async () => {
      try {
        const response = await authAPI.getLatestProfileChange();
        const request = response?.request;
        if (request?.status === 'rejected' && request?.reviewNotes) {
          setStatusMessage(`Your previous profile request was denied: ${request.reviewNotes}`);
        }
      } catch {
        // silent
      }
    };
    loadLatestStatus();
  }, [isOpen]);

  const handleAvatarUpdate = (newAvatar) => {
    setProfileData(prev => ({ ...prev, avatar: newAvatar }));
  };

  const handleSubmitFlagRequest = async () => {
    if (requestChangeFlag.trim()) {
      await showAlert(`Flag change request submitted: ${requestChangeFlag}`, { title: 'Request Submitted' });
      setRequestChangeFlag('');
    }
  };

  const handleSaveProfile = async () => {
    try {
      const response = await authAPI.requestProfileChange({
        name: profileData.name,
        email: profileData.email,
        employee_id: profileData.employeeId,
        position: profileData.position,
        department: profileData.department
      });
      setStatusMessage(response.message || 'Request submitted');
    } catch (error) {
      const detail = error?.response?.data?.detail;
      if (Array.isArray(detail)) {
        setStatusMessage(detail.map((d) => `${d.loc?.[d.loc.length - 1]}: ${d.msg}`).join(', '));
      } else {
        setStatusMessage(detail || error.message || 'Failed to submit request');
      }
    }
  };


  if (!isOpen) return null;

  return (
    <>
      {/* Overlay */}
      <div className="settings-overlay" onClick={onClose} />

      {/* Panel */}
      <div className="profile-settings-panel">
        <div className="profile-settings-header">
          <h3>Profile Settings</h3>
          <button className="close-panel-btn" onClick={onClose}>
            ✕
          </button>
        </div>

        <div className="profile-settings-content">
          
          {/* Avatar Section */}
          <div className="profile-section">
            <h4 className="section-title">Profile Picture</h4>
            <AvatarUpload 
              currentAvatar={profileData.avatar}
              onAvatarUpdate={handleAvatarUpdate}
            />
          </div>

          {/* Profile Info */}
          <div className="profile-section">
            <h4 className="section-title">Profile Information</h4>
            
            <div className="profile-field">
              <label>Full Name</label>
              <input
                type="text"
                value={profileData.name}
                onChange={(e) => setProfileData({ ...profileData, name: e.target.value })}
                placeholder="Enter your full name"
              />
            </div>

            <div className="profile-field">
              <label>Email</label>
              <input
                type="email"
                value={profileData.email}
                onChange={(e) => setProfileData({ ...profileData, email: e.target.value })}
                placeholder="your@email.com"
              />
            </div>

            <div className="profile-field">
              <label>Position</label>
              <select
                value={profileData.position}
                onChange={(e) => setProfileData({ ...profileData, position: e.target.value })}
              >
                {POSITION_OPTIONS.map((opt) => (
                  <option key={opt} value={opt} className="department-option">{opt}</option>
                ))}
              </select>
            </div>
          </div>

          {/* Position Flag */}
          <div className="profile-section">
            <h4 className="section-title">Position Flag</h4>
            <div className="flag-display">
              <div className="flag-icon">
                <svg viewBox="0 0 24 24" fill="currentColor">
                  <path d="M14.4 6L14 4H5v17h2v-7h5.6l.4 2h7V6z"/>
                </svg>
              </div>
              <span className="flag-value">{profileData.flag}</span>
            </div>
          </div>

          {/* Request to Change Flag */}
          <div className="profile-section">
            <h4 className="section-title">Request to Change Flag</h4>
            <div className="flag-request-container">
              <select
                className="flag-select"
                value={requestChangeFlag}
                onChange={(e) => setRequestChangeFlag(e.target.value)}
              >
                <option className="flag-option" value="">Select New Flag</option>
                <option className="flag-option" value="HOD">HOD</option>
                <option className="flag-option" value="FACULTY">FACULTY</option>
                <option className="flag-option" value="NORMAL">NORMAL</option>
              </select>
              <button
                className="flag-request-btn"
                onClick={handleSubmitFlagRequest}
                disabled={!requestChangeFlag}
              >
                Submit Request
              </button>
            </div>
          </div>

          {/* Employee ID & Department */}
          <div className="profile-section">
            <h4 className="section-title">Organization Details</h4>
            
            <div className="profile-field">
              <label>Employee ID</label>
              <input
                type="text"
                value={profileData.employeeId}
                onChange={(e) => setProfileData({ ...profileData, employeeId: e.target.value })}
                list="employee-id-options"
                placeholder="EMP-2026-0001"
              />
              <datalist id="employee-id-options">
                {employeeIdOptions.map((id) => (
                  <option key={id} value={id} />
                ))}
              </datalist>
            </div>

            <div className="profile-field">
              <label>Department</label>
              <select
                value={profileData.department}
                onChange={(e) => setProfileData({ ...profileData, department: e.target.value })}
              >
                {departmentOptions.length === 0 && (
                  <option className="department-option" value={profileData.department || ''}>
                    {profileData.department || 'Select Department'}
                  </option>
                )}
                {departmentOptions.map((dep) => (
                  <option key={dep} className="department-option" value={dep}>{dep}</option>
                ))}
              </select>
            </div>
          </div>

          {/* Save Button */}
          <div className="profile-actions">
            <button className="save-profile-btn" onClick={handleSaveProfile}>
              Submit
            </button>
          </div>
          {statusMessage && (
            <div className="profile-status-message">{statusMessage}</div>
          )}

        </div>
      </div>
    </>
  );
};

export default ProfileSettingsPanel;
