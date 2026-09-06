import React from 'react';
import './MenuButton.css';

const TaskReportButton = ({ isActive, onClick }) => {
  return (
    <button
      className={`menu-button${isActive ? ' active' : ''}`}
      onClick={onClick}
      data-label="Task Report"
      aria-label="Task Report"
      aria-current={isActive ? 'page' : undefined}
    >
      <span className="menu-button-icon" aria-hidden="true">
        {/* Checklist / task-report metaphor */}
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
          <path d="M9 11l2 2 4-4" />
          <rect x="3" y="4" width="18" height="16" rx="2" />
          <line x1="7" y1="16" x2="13" y2="16" />
        </svg>
      </span>
      <span className="menu-button-label">Task Report</span>
    </button>
  );
};

export default TaskReportButton;
