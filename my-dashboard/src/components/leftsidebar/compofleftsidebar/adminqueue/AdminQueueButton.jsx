import React from 'react';
import '../MenuButton.css';

const AdminQueueButton = ({ isActive, onClick }) => {
  return (
    <button
      className={`menu-button${isActive ? ' active' : ''}`}
      onClick={onClick}
      data-label="Admin Queue"
      aria-label="Admin Queue"
      aria-current={isActive ? 'page' : undefined}
    >
      <span className="menu-button-icon" aria-hidden="true">
        {/* Shield with check — clear admin/security metaphor */}
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
          <polyline points="9 12 11 14 15 10" />
        </svg>
      </span>
      <span className="menu-button-label">Admin Queue</span>
    </button>
  );
};

export default AdminQueueButton;
