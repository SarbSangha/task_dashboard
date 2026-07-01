import React from 'react';
import './MenuButton.css';

const WorkspaceButton = ({ isActive, onClick }) => {
  return (
    <button
      className={`menu-button${isActive ? ' active' : ''}`}
      onClick={onClick}
      data-label="Workspace"
      aria-label="Workspace"
      aria-current={isActive ? 'page' : undefined}
    >
      <span className="menu-button-icon" aria-hidden="true">
        {/* Four-square grid — universally understood "workspace/apps" */}
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
          <rect x="3" y="3" width="7" height="7" rx="1.5" />
          <rect x="14" y="3" width="7" height="7" rx="1.5" />
          <rect x="14" y="14" width="7" height="7" rx="1.5" />
          <rect x="3" y="14" width="7" height="7" rx="1.5" />
        </svg>
      </span>
      <span className="menu-button-label">Workspace</span>
    </button>
  );
};

export default WorkspaceButton;
