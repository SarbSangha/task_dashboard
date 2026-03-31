import { useEffect, useRef } from 'react';
import { useAuth } from '../context/AuthContext';
import { subscribeRealtimeNotifications } from '../services/api';

const RECENT_EVENT_TTL_MS = 15000;
const SESSION_PERMISSION_KEY = 'rmw_browser_notifications_prompted_v1';

const trimText = (value, fallback = '') => `${value || fallback}`.trim();

const buildAlertPayload = (payload) => {
  const metadata = payload?.metadata || {};
  const title = trimText(payload?.title, 'New update');
  const body = trimText(payload?.message, 'You have a new notification.');
  const key = [
    payload?.eventType || 'event',
    payload?.taskId || '',
    payload?.taskNumber || metadata.taskNumber || '',
    metadata.groupId || '',
    metadata.messageId || '',
    title,
    body,
  ].join('::');

  return { title, body, key };
};

export default function useBackgroundRealtimeAlerts() {
  const { user } = useAuth();
  const baseTitleRef = useRef('');
  const hiddenAlertCountRef = useRef(0);
  const recentEventsRef = useRef(new Map());

  useEffect(() => {
    if (typeof document === 'undefined') return undefined;
    if (!baseTitleRef.current) {
      baseTitleRef.current = document.title || 'Dashboard';
    }
    return undefined;
  }, []);

  useEffect(() => {
    if (!user || typeof window === 'undefined' || typeof document === 'undefined') {
      return undefined;
    }

    const restoreTitle = () => {
      hiddenAlertCountRef.current = 0;
      document.title = baseTitleRef.current || document.title || 'Dashboard';
    };

    const updateTitle = () => {
      if (document.visibilityState === 'visible') {
        restoreTitle();
        return;
      }
      const baseTitle = baseTitleRef.current || document.title || 'Dashboard';
      document.title = `(${hiddenAlertCountRef.current}) ${baseTitle}`;
    };

    const pruneRecentEvents = (now) => {
      recentEventsRef.current.forEach((timestamp, key) => {
        if (now - timestamp > RECENT_EVENT_TTL_MS) {
          recentEventsRef.current.delete(key);
        }
      });
    };

    const notifyBrowser = (title, body, tag) => {
      if (!('Notification' in window)) return;
      if (Notification.permission !== 'granted') return;

      try {
        const browserNotification = new Notification(title, {
          body,
          tag,
          silent: false,
        });
        browserNotification.onclick = () => {
          window.focus();
          browserNotification.close();
        };
        window.setTimeout(() => browserNotification.close(), 10000);
      } catch (error) {
        console.warn('Browser notification failed:', error);
      }
    };

    const unsubscribe = subscribeRealtimeNotifications({
      onMessage: (payload) => {
        if (!payload?.eventType) return;
        if (document.visibilityState === 'visible') return;

        const now = Date.now();
        pruneRecentEvents(now);

        const nextAlert = buildAlertPayload(payload);
        if (recentEventsRef.current.has(nextAlert.key)) return;
        recentEventsRef.current.set(nextAlert.key, now);

        hiddenAlertCountRef.current += 1;
        updateTitle();
        notifyBrowser(nextAlert.title, nextAlert.body, nextAlert.key);
      },
    });

    const handleVisibleAgain = () => restoreTitle();
    document.addEventListener('visibilitychange', handleVisibleAgain);
    window.addEventListener('focus', handleVisibleAgain);

    return () => {
      unsubscribe();
      document.removeEventListener('visibilitychange', handleVisibleAgain);
      window.removeEventListener('focus', handleVisibleAgain);
      restoreTitle();
    };
  }, [user]);

  useEffect(() => {
    if (!user || typeof window === 'undefined' || !('Notification' in window)) {
      return undefined;
    }
    if (Notification.permission !== 'default') {
      return undefined;
    }

    let prompted = false;
    try {
      prompted = window.sessionStorage.getItem(SESSION_PERMISSION_KEY) === '1';
    } catch {
      prompted = false;
    }
    if (prompted) {
      return undefined;
    }

    const requestPermission = () => {
      try {
        window.sessionStorage.setItem(SESSION_PERMISSION_KEY, '1');
      } catch {
        // no-op
      }
      Notification.requestPermission().catch(() => {});
      window.removeEventListener('pointerdown', requestPermission);
      window.removeEventListener('keydown', requestPermission);
    };

    window.addEventListener('pointerdown', requestPermission, { once: true });
    window.addEventListener('keydown', requestPermission, { once: true });

    return () => {
      window.removeEventListener('pointerdown', requestPermission);
      window.removeEventListener('keydown', requestPermission);
    };
  }, [user]);
}
