import React from 'react';
import '../MenuButton.css';

const TrendingsButton = ({ isActive, onClick }) => {
  return (
    <button
      className={`menu-button ${isActive ? 'active' : ''}`}
      onClick={onClick}
    >
      <div className="menu-button-icon">
        <svg viewBox="0 0 24 24" fill="currentColor">
          <path d="M3 17h3l3-5 4 4 5-8 3 2v7H3v-2zm0-9h5v2H3V8zm7 0h11v2H10V8z" />
        </svg>
      </div>
      <span className="menu-button-label">RMW Data</span>
    </button>
  );
};

export default TrendingsButton;
