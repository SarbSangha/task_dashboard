// src/components/leftsidebar/compofleftsidebar/InboxButton.jsx
import React, { useState, useEffect, useRef } from 'react';
import './MenuButton.css';
import { useAuth } from '../../../context/AuthContext';

const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:8000';

const InboxButton = ({ isActive, onClick }) => {
  const { user } = useAuth();
  const [unreadCount, setUnreadCount] = useState(0);
  const inFlightRef = useRef(false);

  useEffect(() => {
    if (!user) {
      setUnreadCount(0);
      return undefined;
    }

    fetchUnreadCount();
    // Poll for new messages every 30 seconds
    const interval = setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      fetchUnreadCount();
    }, 30000);
    return () => clearInterval(interval);
  }, [user]);

  const fetchUnreadCount = async () => {
    if (!user) return;
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    try {
      const response = await fetch(`${API_BASE}/api/tasks/inbox/unread-count`, {
        credentials: 'include'
      });
      const data = await response.json();
      if (data.success) {
        setUnreadCount(data.unreadCount);
      }
    } catch (error) {
      console.error('Error fetching unread count:', error);
    } finally {
      inFlightRef.current = false;
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
