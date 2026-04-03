// src/components/leftsidebar/compofleftsidebar/InboxButton.jsx
import React, { useState, useEffect, useRef } from 'react';
import './MenuButton.css';
import { useAuth } from '../../../context/AuthContext';
import { subscribeRealtimeNotifications, taskAPI } from '../../../services/api';
import {
  buildTaskPanelCacheKey,
  getTaskPanelCache,
  setTaskPanelCache,
} from '../../../utils/taskPanelCache';

const INBOX_BADGE_CACHE_TTL_MS = 90 * 1000;

const getUnreadCountFromTasks = (rows = []) =>
  rows.filter((task) => !(task?.isRead ?? task?.is_read ?? false)).length;

const InboxButton = ({ isActive, onClick }) => {
  const { user } = useAuth();
  const [unreadCount, setUnreadCount] = useState(0);
  const inFlightRef = useRef(false);
  const refreshTimerRef = useRef(null);
  const unreadCacheKey = user?.id ? buildTaskPanelCacheKey(user.id, 'inbox_unread_count') : null;
  const inboxCacheKey = user?.id ? buildTaskPanelCacheKey(user.id, 'inbox') : null;

  useEffect(() => {
    if (!user) {
      setUnreadCount(0);
      return undefined;
    }

    const scheduleUnreadRefresh = () => {
      if (refreshTimerRef.current) return;
      refreshTimerRef.current = window.setTimeout(() => {
        refreshTimerRef.current = null;
        fetchUnreadCount();
      }, 250);
    };

    const cachedUnread = unreadCacheKey
      ? getTaskPanelCache(unreadCacheKey, INBOX_BADGE_CACHE_TTL_MS)
      : null;
    const cachedInbox = inboxCacheKey
      ? getTaskPanelCache(inboxCacheKey, INBOX_BADGE_CACHE_TTL_MS)
      : null;

    if (typeof cachedUnread?.unreadCount === 'number') {
      setUnreadCount(cachedUnread.unreadCount);
    } else if (Array.isArray(cachedInbox?.tasks)) {
      setUnreadCount(getUnreadCountFromTasks(cachedInbox.tasks));
    }

    fetchUnreadCount();
    // Fallback polling every 3 minutes (WebSocket drives real-time updates).
    const interval = setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      fetchUnreadCount();
    }, 180000);
    const unsubscribe = subscribeRealtimeNotifications({
      onMessage: (payload) => {
        if (!payload || payload.eventType === 'group_message') return;
        scheduleUnreadRefresh();
      },
      onOpen: () => {
        scheduleUnreadRefresh();
      },
    });

    return () => {
      clearInterval(interval);
      unsubscribe();
      if (refreshTimerRef.current) {
        window.clearTimeout(refreshTimerRef.current);
        refreshTimerRef.current = null;
      }
    };
  }, [inboxCacheKey, unreadCacheKey, user]);

  const fetchUnreadCount = async () => {
    if (!user) return;
    if (!unreadCacheKey) return;
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    try {
      const data = await taskAPI.getInboxUnreadCount();
      if (data.success) {
        setUnreadCount(data.unreadCount);
        setTaskPanelCache(unreadCacheKey, {
          unreadCount: data.unreadCount,
        });
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
