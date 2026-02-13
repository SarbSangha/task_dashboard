import React from 'react';
import './MenuButton.css';

const AssignTaskButton = ({ isActive, onClick }) => {
  return (
    <button 
      className={`menu-button ${isActive ? 'active' : ''}`}
      onClick={onClick}
    >
      <div className="menu-button-icon">
        <svg viewBox="0 0 24 24" fill="currentColor">
          <path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/>
        </svg>
      </div>
      <span className="menu-button-label">Assign Task</span>
    </button>
  );
};

export default AssignTaskButton;
