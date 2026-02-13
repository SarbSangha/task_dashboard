// OutboxButton.jsx - Matches MenuButton.css styling
import React from 'react';
import './MenuButton.css';

const OutboxButton = ({ onClick, isActive }) => {
  return (
    <button 
      className={`menu-button ${isActive ? 'active' : ''}`}
      onClick={onClick}
    >
      <span className="menu-button-icon">
        <svg 
          viewBox="0 0 24 24" 
          fill="none" 
          stroke="currentColor" 
          strokeWidth="2" 
          strokeLinecap="round" 
          strokeLinejoin="round"
        >
          <path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8" />
          <polyline points="16 6 12 2 8 6" />
          <line x1="12" y1="2" x2="12" y2="15" />
        </svg>
      </span>
      <span className="menu-button-label">Outbox</span>
    </button>
  );
};

export default OutboxButton;
