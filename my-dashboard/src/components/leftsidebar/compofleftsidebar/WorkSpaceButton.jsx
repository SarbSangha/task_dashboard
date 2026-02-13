import React from 'react';
import './MenuButton.css';

const WorkspaceButton = ({ isActive, onClick }) => {
  return (
    <button 
      className={`menu-button ${isActive ? 'active' : ''}`}
      onClick={onClick}
    >
      <div className="menu-button-icon">
        <svg viewBox="0 0 24 24" fill="currentColor">
          {/* Briefcase Icon */}
          <path d="M10 4V3c0-1.1.9-2 2-2s2 .9 2 2v1h4c1.1 0 2 .9 2 2v3H0V6c0-1.1.9-2 2-2h4zm2-2c-.55 0-1 .45-1 1v1h2V3c0-.55-.45-1-1-1zM0 10h24v8c0 1.1-.9 2-2 2H2c-1.1 0-2-.9-2-2v-8z"/>
        </svg>
      </div>
      <span className="menu-button-label">Workspace</span>
    </button>
  );
};

export default WorkspaceButton;
