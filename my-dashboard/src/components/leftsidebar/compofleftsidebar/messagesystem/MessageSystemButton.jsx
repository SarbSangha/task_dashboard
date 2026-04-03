import React, { useEffect, useRef, useState } from 'react';
import '../MenuButton.css';
import { useAuth } from '../../../../context/AuthContext';
import { directMessageAPI, groupAPI, subscribeRealtimeNotifications } from '../../../../services/api';
import {
  buildTaskPanelCacheKey,
  getTaskPanelCache,
  setTaskPanelCache,
} from '../../../../utils/taskPanelCache';

const MESSAGE_BADGE_CACHE_TTL_MS = 90 * 1000;

const getMessageSeenStorageKey = (userId) => `rmw_message_system_last_seen_${userId}`;

const parseTimestamp = (value) => {
  if (!value) return 0;
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? timestamp : 0;
};

const ensureLastSeenTimestamp = (userId) => {
  if (!userId || typeof window === 'undefined') return Date.now();
  const storageKey = getMessageSeenStorageKey(userId);
  const existingValue = window.localStorage.getItem(storageKey);
  if (existingValue) {
    const parsed = Number(existingValue);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }
  const now = Date.now();
  window.localStorage.setItem(storageKey, `${now}`);
  return now;
};

const markMessageSystemSeen = (userId) => {
  if (!userId || typeof window === 'undefined') return Date.now();
  const now = Date.now();
  window.localStorage.setItem(getMessageSeenStorageKey(userId), `${now}`);
  return now;
};

const MessageSystemButton = ({ isActive, onClick, isOpen = false }) => {
  const { user } = useAuth();
  const [unseenCount, setUnseenCount] = useState(0);
  const inFlightRef = useRef(false);
  const refreshTimerRef = useRef(null);
  const unseenGroupIdsRef = useRef(new Set());
  const unseenSenderIdsRef = useRef(new Set());
  const setsHydratedRef = useRef(false);
  const badgeCacheKey = user?.id ? buildTaskPanelCacheKey(user.id, 'message_system_badge') : null;

  useEffect(() => {
    if (!user?.id) {
      unseenGroupIdsRef.current = new Set();
      unseenSenderIdsRef.current = new Set();
      setsHydratedRef.current = false;
      setUnseenCount(0);
      return undefined;
    }

    const cachedBadge = badgeCacheKey
      ? getTaskPanelCache(badgeCacheKey, MESSAGE_BADGE_CACHE_TTL_MS)
      : null;
    if (typeof cachedBadge?.unseenCount === 'number') {
      setUnseenCount(cachedBadge.unseenCount);
    }

    ensureLastSeenTimestamp(user.id);

    const scheduleRefresh = () => {
      if (refreshTimerRef.current) return;
      refreshTimerRef.current = window.setTimeout(() => {
        refreshTimerRef.current = null;
        fetchUnseenCount();
      }, 200);
    };

    if (isOpen) {
      clearUnseenCount();
    } else {
      fetchUnseenCount();
    }

    const unsubscribe = subscribeRealtimeNotifications({
      onMessage: (payload) => {
        if (!payload) return;
        const eventType = `${payload.eventType || ''}`.toLowerCase();
        if (eventType !== 'group_message' && eventType !== 'direct_message') return;
        if (isOpen) {
          clearUnseenCount();
          return;
        }

        if (!setsHydratedRef.current) {
          scheduleRefresh();
          return;
        }

        if (eventType === 'group_message') {
          const groupId = Number(payload?.metadata?.groupId);
          if (groupId) {
            unseenGroupIdsRef.current.add(groupId);
          }
        } else {
          const senderId = Number(payload?.metadata?.senderId);
          if (senderId && senderId !== user.id) {
            unseenSenderIdsRef.current.add(senderId);
          }
        }

        const nextCount = unseenGroupIdsRef.current.size + unseenSenderIdsRef.current.size;
        setUnseenCount(nextCount);
        if (badgeCacheKey) {
          setTaskPanelCache(badgeCacheKey, { unseenCount: nextCount });
        }
      },
      onOpen: () => {
        if (!isOpen) scheduleRefresh();
      },
    });

    const interval = window.setInterval(() => {
      if (document.visibilityState !== 'visible' || isOpen) return;
      fetchUnseenCount();
    }, 180000);

    return () => {
      unsubscribe();
      window.clearInterval(interval);
      if (refreshTimerRef.current) {
        window.clearTimeout(refreshTimerRef.current);
        refreshTimerRef.current = null;
      }
    };
  }, [badgeCacheKey, isOpen, user?.id]);

  useEffect(() => {
    if (!user?.id || !isOpen) return;
    clearUnseenCount();
  }, [isOpen, user?.id]);

  const clearUnseenCount = () => {
    if (!user?.id) return;
    unseenGroupIdsRef.current = new Set();
    unseenSenderIdsRef.current = new Set();
    setsHydratedRef.current = true;
    markMessageSystemSeen(user.id);
    setUnseenCount(0);
    if (badgeCacheKey) {
      setTaskPanelCache(badgeCacheKey, { unseenCount: 0 });
    }
  };

  const fetchUnseenCount = async () => {
    if (!user?.id || !badgeCacheKey || inFlightRef.current) return;
    inFlightRef.current = true;
    try {
      const seenAt = ensureLastSeenTimestamp(user.id);
      const [groupsResponse, directResponse] = await Promise.all([
        groupAPI.listGroups(),
        directMessageAPI.listConversations(),
      ]);

      const unseenGroupIds = new Set(
        (groupsResponse?.data || [])
          .filter((group) => parseTimestamp(group?.lastMessageAt) > seenAt)
          .map((group) => group?.id)
          .filter(Boolean)
      );
      const unseenSenderIds = new Set(
        (directResponse?.data || [])
          .filter((conversation) => {
            const lastMessageAt = parseTimestamp(conversation?.lastMessageAt);
            return lastMessageAt > seenAt && conversation?.lastMessageSenderId !== user.id;
          })
          .map((conversation) => conversation?.user?.id)
          .filter(Boolean)
      );

      unseenGroupIdsRef.current = unseenGroupIds;
      unseenSenderIdsRef.current = unseenSenderIds;
      setsHydratedRef.current = true;

      const nextCount = unseenGroupIds.size + unseenSenderIds.size;
      setUnseenCount(nextCount);
      setTaskPanelCache(badgeCacheKey, { unseenCount: nextCount });
    } catch (error) {
      console.error('Error fetching message unseen count:', error);
    } finally {
      inFlightRef.current = false;
    }
  };

  const handleClick = () => {
    clearUnseenCount();
    onClick?.();
  };

  return (
    <button 
      className={`menu-button ${isActive ? 'active' : ''} ${unseenCount > 0 ? 'highlighted' : ''}`}
      onClick={handleClick}
    >
      <div className="menu-button-icon">
        <svg viewBox="0 0 24 24" fill="currentColor">
          <path d="M20 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 4l-8 5-8-5V6l8 5 8-5v2z"/>
        </svg>
      </div>
      <span className="menu-button-label">
        Message
        {unseenCount > 0 && (
          <span className="notification-badge">{unseenCount}</span>
        )}
      </span>
    </button>
  );
};

export default MessageSystemButton;
