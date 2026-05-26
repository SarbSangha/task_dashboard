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
const INITIAL_MESSAGE_FETCH_DELAY_MS = 3000;

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

    const scheduleRefresh = () => {
      if (refreshTimerRef.current) return;
      refreshTimerRef.current = window.setTimeout(() => {
        refreshTimerRef.current = null;
        fetchUnseenCount();
      }, 200);
    };

    if (isOpen) {
      fetchUnseenCount();
    } else {
      const initialTimer = window.setTimeout(() => {
        if (document.visibilityState !== 'visible') return;
        fetchUnseenCount();
      }, INITIAL_MESSAGE_FETCH_DELAY_MS);

      const unsubscribe = subscribeRealtimeNotifications({
        onMessage: (payload) => {
          if (!payload) return;
          const eventType = `${payload.eventType || ''}`.toLowerCase();
          if (
            eventType !== 'group_message' &&
            eventType !== 'direct_message' &&
            eventType !== 'message_read_receipt'
          ) return;
          if (isOpen) {
            scheduleRefresh();
            return;
          }

          if (eventType === 'message_read_receipt') {
            scheduleRefresh();
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
        window.clearTimeout(initialTimer);
        if (refreshTimerRef.current) {
          window.clearTimeout(refreshTimerRef.current);
          refreshTimerRef.current = null;
        }
      };
    }

    const unsubscribe = subscribeRealtimeNotifications({
      onMessage: (payload) => {
        if (!payload) return;
        const eventType = `${payload.eventType || ''}`.toLowerCase();
        if (
          eventType !== 'group_message' &&
          eventType !== 'direct_message' &&
          eventType !== 'message_read_receipt'
        ) return;
        scheduleRefresh();
      },
    });

    return () => {
      unsubscribe();
      if (refreshTimerRef.current) {
        window.clearTimeout(refreshTimerRef.current);
        refreshTimerRef.current = null;
      }
    };
  }, [badgeCacheKey, isOpen, user?.id]);

  useEffect(() => {
    if (!user?.id || !isOpen) return;
    fetchUnseenCount();
  }, [isOpen, user?.id]);

  const fetchUnseenCount = async () => {
    if (!user?.id || !badgeCacheKey || inFlightRef.current) return;
    inFlightRef.current = true;
    try {
      const [groupUnreadResponse, directUnreadResponse] = await Promise.all([
        groupAPI.listUnreadCounts(),
        directMessageAPI.listUnreadCounts(),
      ]);

      const unseenGroupIds = new Set(
        (groupUnreadResponse?.data?.groups || [])
          .map((group) => group?.groupId)
          .filter(Boolean)
      );
      const unseenSenderIds = new Set(
        (directUnreadResponse?.data?.conversations || [])
          .map((conversation) => conversation?.userId)
          .filter(Boolean)
      );

      unseenGroupIdsRef.current = unseenGroupIds;
      unseenSenderIdsRef.current = unseenSenderIds;
      setsHydratedRef.current = true;

      const nextCount =
        Number(groupUnreadResponse?.data?.totalUnreadThreads || 0) +
        Number(directUnreadResponse?.data?.totalUnreadThreads || 0);
      setUnseenCount(nextCount);
      setTaskPanelCache(badgeCacheKey, { unseenCount: nextCount });
    } catch (error) {
      console.error('Error fetching message unseen count:', error);
    } finally {
      inFlightRef.current = false;
    }
  };

  const handleClick = () => {
    onClick?.();
    fetchUnseenCount();
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
