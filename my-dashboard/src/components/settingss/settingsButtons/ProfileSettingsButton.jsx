import React from 'react';
import './SettingsButtons.css';

const ProfileSettingsButton = ({ onClick }) => {
  return (
    <button className="settings-item-btn" onClick={onClick}>
      <div className="settings-btn-icon">
        <svg viewBox="0 0 24 24" fill="currentColor">
          <path d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z"/>
        </svg>
      </div>
      <div className="settings-btn-info">
        <span className="settings-btn-label">Profile Settings</span>
        <span className="settings-btn-description">Edit your personal information</span>
      </div>
      <svg className="arrow-icon" viewBox="0 0 24 24" fill="currentColor">
        <path d="M8.59 16.59L13.17 12 8.59 7.41 10 6l6 6-6 6-1.41-1.41z"/>
      </svg>
    </button>
  );
};

export default ProfileSettingsButton;
