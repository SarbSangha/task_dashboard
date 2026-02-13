import React, { useState } from 'react';
import './SettingSidebar.css';
import LoginSecurityPanel from './settingsButtons/profilesetting/LoginSecurityPanel';
import ProfileSettingsPanel from './settingsButtons/profilesetting/ProfileSettingPanel';
import { useAuth } from '../../context/AuthContext';
const SettingsSidebar = ({ isOpen, onClose }) => {
  const [showLoginSecurity, setShowLoginSecurity] = useState(false);
  const [showProfileSettings, setShowProfileSettings] = useState(false);
  const {logout } = useAuth();
  const handleLogout = async () => {
    await logout();
  };

  if (!isOpen) return null;

  return (
    <>
      {/* Login & Security Panel */}
      <LoginSecurityPanel
        isOpen={showLoginSecurity}
        onClose={() => setShowLoginSecurity(false)}
      />

      {/* Profile Settings Panel */}
      <ProfileSettingsPanel
        isOpen={showProfileSettings}
        onClose={() => setShowProfileSettings(false)}
      />

      {/* Main Settings Sidebar */}
      <aside className={`settings-sidebar ${isOpen ? 'open' : ''}`}>
        <div className="settings-header">
          <h2>Settings</h2>
          <button className="settings-close-btn" onClick={onClose}>
            ✕
          </button>
        </div>

        <nav className="settings-menu">
          {/* Login & Security Button */}
          <button
            className="settings-menu-item"
            onClick={() => setShowLoginSecurity(true)}
          >
            <svg viewBox="0 0 24 24" fill="currentColor">
              <path d="M12 1L3 5v6c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V5l-9-4zm0 10.99h7c-.53 4.12-3.28 7.79-7 8.94V12H5V6.3l7-3.11v8.8z"/>
            </svg>
            <span>Login & Security</span>
            <svg className="chevron-right" viewBox="0 0 24 24" fill="currentColor">
              <path d="M9.29 6.71a.996.996 0 000 1.41L13.17 12l-3.88 3.88a.996.996 0 101.41 1.41l4.59-4.59a.996.996 0 000-1.41L10.7 6.7c-.38-.39-1.02-.39-1.41-.01z"/>
            </svg>
          </button>

          {/* Profile Settings Button */}
          <button
            className="settings-menu-item"
            onClick={() => setShowProfileSettings(true)}
          >
            <svg viewBox="0 0 24 24" fill="currentColor">
              <path d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z"/>
            </svg>
            <span>Profile Settings</span>
            <svg className="chevron-right" viewBox="0 0 24 24" fill="currentColor">
              <path d="M9.29 6.71a.996.996 0 000 1.41L13.17 12l-3.88 3.88a.996.996 0 101.41 1.41l4.59-4.59a.996.996 0 000-1.41L10.7 6.7c-.38-.39-1.02-.39-1.41-.01z"/>
            </svg>
          </button>

          {/* Dark Mode */}
          <button className="settings-menu-item">
            <svg viewBox="0 0 24 24" fill="currentColor">
              <path d="M9 2c-1.05 0-2.05.16-3 .46 4.06 1.27 7 5.06 7 9.54 0 4.48-2.94 8.27-7 9.54.95.3 1.95.46 3 .46 5.52 0 10-4.48 10-10S14.52 2 9 2z"/>
            </svg>
            <span>Dark Mode</span>
          </button>

          {/* Notifications */}
          <button className="settings-menu-item">
            <svg viewBox="0 0 24 24" fill="currentColor">
              <path d="M12 22c1.1 0 2-.9 2-2h-4c0 1.1.9 2 2 2zm6-6v-5c0-3.07-1.63-5.64-4.5-6.32V4c0-.83-.67-1.5-1.5-1.5s-1.5.67-1.5 1.5v.68C7.64 5.36 6 7.92 6 11v5l-2 2v1h16v-1l-2-2zm-2 1H8v-6c0-2.48 1.51-4.5 4-4.5s4 2.02 4 4.5v6z"/>
            </svg>
            <span>Notifications</span>
          </button>

          {/* Logout */}
          <button className="settings-menu-item" onClick={handleLogout}>
            <svg viewBox="0 0 24 24" fill="currentColor">
              <path d="M17 7l-1.41 1.41L18.17 11H8v2h10.17l-2.58 2.58L17 17l5-5zM4 5h8V3H4c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h8v-2H4V5z"/>
            </svg>
            <span>Logout</span>
          </button>
          {/* <button
          onClick={handleLogout}
          style={{
            padding: '8px 16px',
            background: '#dc3545',
            color: '#fff',
            border: 'none',
            borderRadius: '6px',
            cursor: 'pointer',
            fontWeight: '600'
          }}
        >
          Logout
        </button> */}
        </nav>
      </aside>

      {/* Backdrop overlay */}
      {isOpen && <div className="settings-backdrop" onClick={onClose} />}
    </>
  );
};

export default SettingsSidebar;
