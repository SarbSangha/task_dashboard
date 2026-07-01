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
const INITIAL_UNREAD_FETCH_DELAY_MS = 1500;

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
    if (!user) { setUnreadCount(0); return undefined; }

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

    const initialTimer = window.setTimeout(() => {
      if (document.visibilityState !== 'visible') return;
      fetchUnreadCount();
    }, INITIAL_UNREAD_FETCH_DELAY_MS);

    const interval = setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      fetchUnreadCount();
    }, 180000);

    const unsubscribe = subscribeRealtimeNotifications({
      onMessage: (payload) => {
        if (!payload || payload.eventType === 'group_message') return;
        scheduleUnreadRefresh();
      },
      onOpen: () => scheduleUnreadRefresh(),
    });

    return () => {
      clearInterval(interval);
      unsubscribe();
      window.clearTimeout(initialTimer);
      if (refreshTimerRef.current) {
        window.clearTimeout(refreshTimerRef.current);
        refreshTimerRef.current = null;
      }
    };
  }, [inboxCacheKey, unreadCacheKey, user]);

  const fetchUnreadCount = async () => {
    if (!user || !unreadCacheKey || inFlightRef.current) return;
    inFlightRef.current = true;
    try {
      const data = await taskAPI.getInboxUnreadCount();
      if (data.success) {
        setUnreadCount(data.unreadCount);
        setTaskPanelCache(unreadCacheKey, { unreadCount: data.unreadCount });
      }
    } catch (error) {
      console.error('Error fetching unread count:', error);
    } finally {
      inFlightRef.current = false;
    }
  };

  const displayCount = unreadCount > 99 ? '99+' : unreadCount;

  return (
    <button
      className={`menu-button${isActive ? ' active' : ''}${unreadCount > 0 ? ' highlighted' : ''}`}
      onClick={onClick}
      data-label="Inbox"
      aria-label={`Inbox${unreadCount > 0 ? `, ${unreadCount} unread` : ''}`}
      aria-current={isActive ? 'page' : undefined}
    >
      <span className="menu-button-icon" aria-hidden="true">
        {/* Inbox tray — arrow into a tray */}
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="8 17 12 21 16 17" />
          <line x1="12" y1="12" x2="12" y2="21" />
          <path d="M20.88 18.09A5 5 0 0018 9h-1.26A8 8 0 103 16.29" />
        </svg>
      </span>
      <span className="menu-button-label">Inbox</span>
      {unreadCount > 0 && (
        <span className="notification-badge" aria-hidden="true">{displayCount}</span>
      )}
    </button>
  );
};

export default InboxButton;
