// OutboxButton.jsx - Matches MenuButton.css styling
import React, { useEffect, useRef, useState } from 'react';
import './MenuButton.css';
import { useAuth } from '../../../context/AuthContext';
import { subscribeRealtimeNotifications, taskAPI } from '../../../services/api';
import {
  buildTaskPanelCacheKey,
  getTaskPanelCache,
  setTaskPanelCache,
} from '../../../utils/taskPanelCache';

const OUTBOX_BADGE_CACHE_TTL_MS = 90 * 1000;
const INITIAL_OUTBOX_FETCH_DELAY_MS = 2200;

const isOutboxNotification = (notification, outboxTaskIds) => {
  if (!notification?.taskId || !outboxTaskIds.has(notification.taskId)) return false;
  const eventType = `${notification.eventType || ''}`.toLowerCase();
  if (!eventType || eventType === 'group_message' || eventType === 'direct_message') return false;
  if (eventType.startsWith('admin_')) return false;
  return true;
};

const OutboxButton = ({ onClick, isActive, isOpen = false }) => {
  const { user } = useAuth();
  const [unreadCount, setUnreadCount] = useState(0);
  const unreadIdsRef = useRef([]);
  const inFlightRef = useRef(false);
  const markingReadRef = useRef(false);
  const refreshTimerRef = useRef(null);
  const badgeCacheKey = user?.id ? buildTaskPanelCacheKey(user.id, 'outbox_badge') : null;
  const outboxCacheKey = user?.id ? buildTaskPanelCacheKey(user.id, 'outbox') : null;

  useEffect(() => {
    if (!user?.id) {
      setUnreadCount(0);
      unreadIdsRef.current = [];
      return undefined;
    }

    const cachedBadge = badgeCacheKey
      ? getTaskPanelCache(badgeCacheKey, OUTBOX_BADGE_CACHE_TTL_MS)
      : null;
    if (typeof cachedBadge?.unreadCount === 'number') {
      setUnreadCount(cachedBadge.unreadCount);
      unreadIdsRef.current = Array.isArray(cachedBadge.notificationIds)
        ? cachedBadge.notificationIds
        : [];
    }

    const scheduleRefresh = () => {
      if (refreshTimerRef.current) return;
      refreshTimerRef.current = window.setTimeout(() => {
        refreshTimerRef.current = null;
        fetchUnreadCount();
      }, 250);
    };

    const initialTimer = window.setTimeout(() => {
      if (document.visibilityState !== 'visible') return;
      fetchUnreadCount();
    }, INITIAL_OUTBOX_FETCH_DELAY_MS);

    const unsubscribe = subscribeRealtimeNotifications({
      onMessage: (payload) => {
        if (!payload) return;
        const eventType = `${payload.eventType || ''}`.toLowerCase();
        if (eventType === 'group_message' || eventType === 'direct_message') return;
        scheduleRefresh();
      },
      onOpen: () => scheduleRefresh(),
    });

    const interval = window.setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      fetchUnreadCount();
    }, 180000);

    return () => {
      unsubscribe();
      window.clearInterval(interval);
      window.clearTimeout(initialTimer);
      if (refreshTimerRef.current) {
        window.clearTimeout(refreshTimerRef.current);
        refreshTimerRef.current = null;
      }
    };
  }, [badgeCacheKey, outboxCacheKey, user?.id]);

  useEffect(() => {
    if (!isOpen || unreadCount === 0) return;
    markNotificationsAsRead(unreadIdsRef.current);
  }, [isOpen, unreadCount]);

  const fetchUnreadCount = async () => {
    if (!user?.id || !badgeCacheKey || inFlightRef.current) return;
    inFlightRef.current = true;
    try {
      const data = await taskAPI.getOutboxUnreadCount();
      const nextCount = data?.success ? (data.unreadCount ?? 0) : 0;
      unreadIdsRef.current = [];
      setUnreadCount(nextCount);
      setTaskPanelCache(badgeCacheKey, {
        unreadCount: nextCount,
        notificationIds: [],
      });
    } catch (error) {
      console.error('Error fetching outbox unread count:', error);
    } finally {
      inFlightRef.current = false;
    }
  };

  const markNotificationsAsRead = async (notificationIds = null) => {
    if (markingReadRef.current) return;
    markingReadRef.current = true;

    let ids = [...new Set((notificationIds || []).filter(Boolean))];
    if (ids.length === 0) {
      if (!user?.id || !outboxCacheKey) {
        markingReadRef.current = false;
        return;
      }

      try {
        const cachedOutbox = getTaskPanelCache(outboxCacheKey, OUTBOX_BADGE_CACHE_TTL_MS);
        const [notificationsResponse, outboxResponse] = await Promise.all([
          taskAPI.getNotifications(true),
          cachedOutbox?.tasks
            ? Promise.resolve({ success: true, data: cachedOutbox.tasks })
            : taskAPI.getOutbox(),
        ]);

        const outboxTaskIds = new Set((outboxResponse?.data || []).map((task) => task?.id).filter(Boolean));
        ids = (notificationsResponse?.notifications || [])
          .filter((notification) => isOutboxNotification(notification, outboxTaskIds))
          .map((notification) => notification.id)
          .filter(Boolean);
      } catch (error) {
        console.error('Error loading outbox notifications to mark as read:', error);
        markingReadRef.current = false;
        return;
      }
    }

    if (ids.length === 0) {
      markingReadRef.current = false;
      return;
    }

    unreadIdsRef.current = [];
    setUnreadCount(0);
    if (badgeCacheKey) {
      setTaskPanelCache(badgeCacheKey, {
        unreadCount: 0,
        notificationIds: [],
      });
    }

    try {
      await Promise.allSettled(ids.map((notificationId) => taskAPI.markNotificationRead(notificationId)));
    } catch (error) {
      console.error('Error marking outbox notifications as read:', error);
    } finally {
      markingReadRef.current = false;
    }
  };

  const handleClick = () => {
    onClick?.();
  };

  return (
    <button 
      className={`menu-button ${isActive ? 'active' : ''} ${unreadCount > 0 ? 'highlighted' : ''}`}
      onClick={handleClick}
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
      <span className="menu-button-label">
        Outbox
        {unreadCount > 0 && (
          <span className="notification-badge">{unreadCount}</span>
        )}
      </span>
    </button>
  );
};

export default OutboxButton;
