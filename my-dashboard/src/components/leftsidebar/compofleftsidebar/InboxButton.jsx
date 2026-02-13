// src/components/leftsidebar/compofleftsidebar/InboxButton.jsx
import React, { useState, useEffect } from 'react';
import './MenuButton.css';

const InboxButton = ({ isActive, onClick }) => {
  const [unreadCount, setUnreadCount] = useState(0);

  useEffect(() => {
    fetchUnreadCount();
    // Poll for new messages every 30 seconds
    const interval = setInterval(fetchUnreadCount, 30000);
    return () => clearInterval(interval);
  }, []);

  const fetchUnreadCount = async () => {
    try {
      const response = await fetch('http://localhost:8000/api/tasks/inbox/unread-count', {
        credentials: 'include'
      });
      const data = await response.json();
      if (data.success) {
        setUnreadCount(data.unreadCount);
      }
    } catch (error) {
      console.error('Error fetching unread count:', error);
    }
  };

  return (
    <button 
      className={`menu-button ${isActive ? 'active' : ''} ${unreadCount > 0 ? 'highlighted' : ''}`}
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
          <path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z" />
          <polyline points="22,6 12,13 2,6" />
        </svg>
      </span>
      <span className="menu-button-label">
        Inbox
        {unreadCount > 0 && (
          <span className="notification-badge">{unreadCount}</span>
        )}
      </span>
    </button>
  );
};

export default InboxButton;
