import React from 'react';
import './SettingsButtons.css';

const LogoutButton = ({ onClick }) => {
  const handleLogout = () => {
    console.log('Logging out...');
    if (onClick) {
      onClick();
    }
    // Add your logout logic here
  };

  return (
    <button className="logout-button" onClick={handleLogout}>
      <svg viewBox="0 0 24 24" fill="currentColor">
        <path d="M17 7l-1.41 1.41L18.17 11H8v2h10.17l-2.58 2.58L17 17l5-5zM4 5h8V3H4c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h8v-2H4V5z"/>
      </svg>
      Logout
    </button>
  );
};

export default LogoutButton;
