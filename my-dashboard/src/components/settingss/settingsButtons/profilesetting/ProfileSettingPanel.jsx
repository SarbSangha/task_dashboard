import React, { useState } from 'react';
import '../../SettingSidebar.css';
import { useAuth } from '../../../../context/AuthContext';
import { AvatarUpload } from '../../../profile/AvatarUpload';
import './ProfileSettingsPanel.css';

const ProfileSettingsPanel = ({ isOpen, onClose }) => {
  const { user } = useAuth();
  
  const [profileData, setProfileData] = useState({
    name: user?.name || '',
    email: user?.email || '',
    position: user?.position || '',
    department: 'Engineering',
    employeeId: 'EMP-2024-1234',
    flag: user?.department || '',
    avatar: user?.avatar || null
  });

  const [requestChangeFlag, setRequestChangeFlag] = useState('');

  const handleAvatarUpdate = (newAvatar) => {
    setProfileData(prev => ({ ...prev, avatar: newAvatar }));
  };

  const handleSubmitFlagRequest = () => {
    if (requestChangeFlag.trim()) {
      alert(`Flag change request submitted: ${requestChangeFlag}`);
      setRequestChangeFlag('');
    }
  };

  const handleSaveProfile = () => {
    console.log('Saving profile:', profileData);
    alert('Profile updated successfully!');
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
              <input
                type="text"
                value={profileData.position}
                onChange={(e) => setProfileData({ ...profileData, position: e.target.value })}
                placeholder="Your position"
              />
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
            
            <div className="profile-field readonly">
              <label>Employee ID</label>
              <div className="readonly-value">
                <svg viewBox="0 0 24 24" fill="currentColor">
                  <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 3c1.66 0 3 1.34 3 3s-1.34 3-3 3-3-1.34-3-3 1.34-3 3-3zm0 14.2c-2.5 0-4.71-1.28-6-3.22.03-1.99 4-3.08 6-3.08 1.99 0 5.97 1.09 6 3.08-1.29 1.94-3.5 3.22-6 3.22z"/>
                </svg>
                <span>{profileData.employeeId}</span>
              </div>
            </div>

            <div className="profile-field">
              <label>Department</label>
              <select
                value={profileData.department}
                onChange={(e) => setProfileData({ ...profileData, department: e.target.value })}
              >
                <option  className="department-option" value="Engineering">Engineering</option>
                <option className="department-option" value="Marketing">Marketing</option>
                <option className="department-option" value="Sales">Sales</option>
                <option className="department-option" value="HR">Human Resources</option>
                <option className="department-option" value="Finance">Finance</option>
                <option className="department-option" value="Operations">Operations</option>
              </select>
            </div>
          </div>

          {/* Save Button */}
          <div className="profile-actions">
            <button className="save-profile-btn" onClick={handleSaveProfile}>
              Save Changes
            </button>
          </div>
        </div>
      </div>
    </>
  );
};

export default ProfileSettingsPanel;
