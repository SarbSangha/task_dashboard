import React from 'react';
import '../MenuButton.css';

const TrackingButton = ({ isActive, onClick }) => {
  return (
    <button
      className={`menu-button${isActive ? ' active' : ''}`}
      onClick={onClick}
      data-label="Tracking"
      aria-label="Tracking"
      aria-current={isActive ? 'page' : undefined}
    >
      <span className="menu-button-icon" aria-hidden="true">
        {/* Clipboard with checkmark — clear "task status" metaphor */}
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
          <path d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2" />
          <rect x="9" y="3" width="6" height="4" rx="1" />
          <path d="M9 12l2 2 4-4" />
        </svg>
      </span>
      <span className="menu-button-label">Tracking</span>
    </button>
  );
};

export default TrackingButton;
