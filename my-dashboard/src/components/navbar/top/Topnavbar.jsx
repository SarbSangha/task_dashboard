import React, { useState } from 'react';
import './Topnav.css';
import SettingsSidebar from '../../settingss/SettingSidebar';
import { useAuth } from '../../../context/AuthContext';
import { UserAvatar } from '../../common/UserAvatar'; 
const Topnavbar = () => {
  const [searchQuery, setSearchQuery] = useState('');
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);

  const handleSearchChange = (e) => {
    setSearchQuery(e.target.value);
  };

  const toggleSettings = () => {
    setIsSettingsOpen(!isSettingsOpen);
  };

  const closeSettings = () => {
    setIsSettingsOpen(false);
  };
  const { user } = useAuth();

  return (
    <>
      <nav className="topnav">
        {/* Left Section - Logo */}
        <div className="topnav-left">
          <div className="logo-container">
            <div className="logo-icon">
              <svg viewBox="0 0 24 24" className="eye-icon">
                <path d="M12 4.5C7 4.5 2.73 7.61 1 12c1.73 4.39 6 7.5 11 7.5s9.27-3.11 11-7.5c-1.73-4.39-6-7.5-11-7.5zM12 17c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5zm0-8c-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3-1.34-3-3-3z"/>
              </svg>
            </div>
            <span className="logo-text">RMW eye</span>
          </div>
        </div>

        {/* Center Section - Search Bar */}
        <div className="topnav-center">
          <div className="search-container">
            <svg className="search-icon" viewBox="0 0 24 24">
              <path d="M15.5 14h-.79l-.28-.27C15.41 12.59 16 11.11 16 9.5 16 5.91 13.09 3 9.5 3S3 5.91 3 9.5 5.91 16 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z"/>
            </svg>
            <input
              type="text"
              className="search-input"
              placeholder="Search tasks, projects..."
              value={searchQuery}
              onChange={handleSearchChange}
            />
          </div>
        </div>

        {/* Right Section - User Profile & Icons */}
        <div className="topnav-right">
          <div className="user-profile">
            <div className="user-avatar">
              <UserAvatar avatar={user?.avatar} name={user?.name} size={40} />
            </div>
            <div className="user-info">
              <span className="user-name">{user?.name}</span>
              <span className="user-badge">{user?.position}</span>
            </div>
          </div>
          
          {/* WiFi Icon */}
          <div className="icon-button">
            <svg viewBox="0 0 24 24">
              <path d="M1 9l2 2c4.97-4.97 13.03-4.97 18 0l2-2C16.93 2.93 7.08 2.93 1 9zm8 8l3 3 3-3c-1.65-1.66-4.34-1.66-6 0zm-4-4l2 2c2.76-2.76 7.24-2.76 10 0l2-2C15.14 9.14 8.87 9.14 5 13z"/>
            </svg>
          </div>

          {/* Settings Icon - WITH CLICK HANDLER */}
          <div 
            className={`icon-button ${isSettingsOpen ? 'active' : ''}`}
            onClick={toggleSettings}
            aria-label="Open settings"
          >
            <svg viewBox="0 0 24 24">
              <path d="M19.14,12.94c0.04-0.3,0.06-0.61,0.06-0.94c0-0.32-0.02-0.64-0.07-0.94l2.03-1.58c0.18-0.14,0.23-0.41,0.12-0.61l-1.92-3.32c-0.12-0.22-0.37-0.29-0.59-0.22l-2.39,0.96c-0.5-0.38-1.03-0.7-1.62-0.94L14.4,2.81c-0.04-0.24-0.24-0.41-0.48-0.41h-3.84c-0.24,0-0.43,0.17-0.47,0.41L9.25,5.35C8.66,5.59,8.12,5.92,7.63,6.29L5.24,5.33c-0.22-0.08-0.47,0-0.59,0.22L2.74,8.87C2.62,9.08,2.66,9.34,2.86,9.48l2.03,1.58C4.84,11.36,4.8,11.69,4.8,12s0.02,0.64,0.07,0.94l-2.03,1.58c-0.18,0.14-0.23,0.41-0.12,0.61l1.92,3.32c0.12,0.22,0.37,0.29,0.59,0.22l2.39-0.96c0.5,0.38,1.03,0.7,1.62,0.94l0.36,2.54c0.05,0.24,0.24,0.41,0.48,0.41h3.84c0.24,0,0.44-0.17,0.47-0.41l0.36-2.54c0.59-0.24,1.13-0.56,1.62-0.94l2.39,0.96c0.22,0.08,0.47,0,0.59-0.22l1.92-3.32c0.12-0.22,0.07-0.47-0.12-0.61L19.14,12.94z M12,15.6c-1.98,0-3.6-1.62-3.6-3.6s1.62-3.6,3.6-3.6s3.6,1.62,3.6,3.6S13.98,15.6,12,15.6z"/>
            </svg>
          </div>
        </div>
      </nav>

      {/* Settings Sidebar Component */}
      <SettingsSidebar isOpen={isSettingsOpen} onClose={closeSettings} />
    </>
  );
};

export default Topnavbar;
