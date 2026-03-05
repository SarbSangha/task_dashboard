import React from 'react';
import '../MenuButton.css';

const AdminQueueButton = ({ isActive, onClick }) => {
  return (
    <button
      className={`menu-button ${isActive ? 'active' : ''}`}
      onClick={onClick}
    >
      <div className="menu-button-icon">
        <svg viewBox="0 0 24 24" fill="currentColor">
          <path d="M12 2l8 4v6c0 5.25-3.4 10.74-8 12-4.6-1.26-8-6.75-8-12V6l8-4zm0 4.2L7 8.4v3.6c0 3.96 2.46 8.27 5 9.55 2.54-1.28 5-5.59 5-9.55V8.4l-5-2.2z"/>
        </svg>
      </div>
      <span className="menu-button-label">Admin Queue</span>
    </button>
  );
};

export default AdminQueueButton;
