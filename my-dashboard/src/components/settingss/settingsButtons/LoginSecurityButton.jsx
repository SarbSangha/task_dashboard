import React from 'react';
import './SettingsButtons.css';

const LoginSecurityButton = ({ onClick }) => {
  return (
    <button className="settings-item-btn" onClick={onClick}>
      <div className="settings-btn-icon blue">
        <svg viewBox="0 0 24 24" fill="currentColor">
          <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 3c1.66 0 3 1.34 3 3s-1.34 3-3 3-3-1.34-3-3 1.34-3 3-3zm0 14.2c-2.5 0-4.71-1.28-6-3.22.03-1.99 4-3.08 6-3.08 1.99 0 5.97 1.09 6 3.08-1.29 1.94-3.5 3.22-6 3.22z"/>
        </svg>
      </div>
      <div className="settings-btn-info">
        <span className="settings-btn-label">Login & Security</span>
        <span className="settings-btn-description">Manage passwords and security</span>
      </div>
      <svg className="arrow-icon" viewBox="0 0 24 24" fill="currentColor">
        <path d="M8.59 16.59L13.17 12 8.59 7.41 10 6l6 6-6 6-1.41-1.41z"/>
      </svg>
    </button>
  );
};

export default LoginSecurityButton;
