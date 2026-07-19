import React from 'react';
import './MenuButton.css';

const ReportsButton = ({ isActive, onClick }) => {
  return (
    <button
      className={`menu-button${isActive ? ' active' : ''}`}
      onClick={onClick}
      data-label="Reports"
      aria-label="Reports"
      aria-current={isActive ? 'page' : undefined}
    >
      <span className="menu-button-icon" aria-hidden="true">
        {/* Bar-chart / analytics metaphor */}
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
          <path d="M3 3v18h18" />
          <rect x="7" y="10" width="3" height="7" />
          <rect x="12" y="6" width="3" height="11" />
          <rect x="17" y="13" width="3" height="4" />
        </svg>
      </span>
      <span className="menu-button-label">Reports</span>
    </button>
  );
};

export default ReportsButton;
