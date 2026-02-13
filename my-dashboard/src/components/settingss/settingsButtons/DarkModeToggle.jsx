import React, { useState } from 'react';
import './SettingsButtons.css';

const DarkModeToggle = () => {
  const [isDarkMode, setIsDarkMode] = useState(false);

  const handleToggle = () => {
    setIsDarkMode(!isDarkMode);
    console.log('Dark Mode:', !isDarkMode ? 'Enabled' : 'Disabled');
  };

  return (
    <button className="settings-item-btn no-hover" onClick={handleToggle}>
      <div className="settings-btn-icon purple">
        <svg viewBox="0 0 24 24" fill="currentColor">
          <path d="M20 8.69V4h-4.69L12 .69 8.69 4H4v4.69L.69 12 4 15.31V20h4.69L12 23.31 15.31 20H20v-4.69L23.31 12 20 8.69zM12 18c-3.31 0-6-2.69-6-6s2.69-6 6-6 6 2.69 6 6-2.69 6-6 6zm0-10c-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4-1.79-4-4-4z"/>
        </svg>
      </div>
      <div className="settings-btn-info">
        <span className="settings-btn-label">Dark Mode</span>
        <span className="settings-btn-description">Toggle dark theme</span>
      </div>
      <label className="toggle-switch" onClick={(e) => e.stopPropagation()}>
        <input 
          type="checkbox" 
          checked={isDarkMode}
          onChange={handleToggle}
        />
        <span className="toggle-slider"></span>
      </label>
    </button>
  );
};

export default DarkModeToggle;
