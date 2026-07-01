import React from 'react';
import { useTheme } from '../../../context/ThemeContext';
import './SettingsButtons.css';

const DarkModeToggle = () => {
  const { isDarkMode, toggleTheme } = useTheme();

  return (
    <button
      type="button"
      className="settings-menu-item settings-menu-toggle"
      onClick={toggleTheme}
      aria-label={`Switch to ${isDarkMode ? 'light' : 'dark'} theme`}
    >
      <svg viewBox="0 0 24 24" fill="currentColor">
          <path d="M20 8.69V4h-4.69L12 .69 8.69 4H4v4.69L.69 12 4 15.31V20h4.69L12 23.31 15.31 20H20v-4.69L23.31 12 20 8.69zM12 18c-3.31 0-6-2.69-6-6s2.69-6 6-6 6 2.69 6 6-2.69 6-6 6zm0-10c-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4-1.79-4-4-4z"/>
      </svg>
      <span>{isDarkMode ? 'Dark Mode' : 'Light Mode'}</span>
      <label className="toggle-switch" onClick={(e) => e.stopPropagation()}>
        <input 
          type="checkbox" 
          checked={isDarkMode}
          onChange={toggleTheme}
        />
        <span className="toggle-slider"></span>
      </label>
    </button>
  );
};

export default DarkModeToggle;
