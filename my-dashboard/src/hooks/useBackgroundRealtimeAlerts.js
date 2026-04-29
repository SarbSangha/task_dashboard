import { useEffect, useRef } from 'react';
import { useAuth } from '../context/AuthContext';
import { subscribeRealtimeNotifications } from '../services/api';

const RECENT_EVENT_TTL_MS = 15000;
const SESSION_PERMISSION_KEY = 'rmw_browser_notifications_prompted_v1';
const ALWAYS_NOTIFY_EVENT_TYPES = new Set(['group_message', 'direct_message']);

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
  const audioContextRef = useRef(null);

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

    const playMessageTone = () => {
      if (typeof window === 'undefined') return;
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      if (!AudioContextClass) return;

      try {
        if (!audioContextRef.current) {
          audioContextRef.current = new AudioContextClass();
        }

        const ctx = audioContextRef.current;
        if (!ctx) return;
        if (ctx.state === 'suspended') {
          void ctx.resume().catch(() => {});
        }

        const nowAt = ctx.currentTime;
        const masterGain = ctx.createGain();
        masterGain.connect(ctx.destination);
        masterGain.gain.setValueAtTime(0.0001, nowAt);

        const notes = [
          { frequency: 880, start: 0, duration: 0.08, gain: 0.05 },
          { frequency: 1174.66, start: 0.11, duration: 0.12, gain: 0.04 },
        ];

        notes.forEach((note) => {
          const oscillator = ctx.createOscillator();
          const noteGain = ctx.createGain();
          oscillator.type = 'sine';
          oscillator.frequency.setValueAtTime(note.frequency, nowAt + note.start);
          noteGain.gain.setValueAtTime(0.0001, nowAt + note.start);
          noteGain.gain.exponentialRampToValueAtTime(note.gain, nowAt + note.start + 0.01);
          noteGain.gain.exponentialRampToValueAtTime(0.0001, nowAt + note.start + note.duration);
          oscillator.connect(noteGain);
          noteGain.connect(masterGain);
          oscillator.start(nowAt + note.start);
          oscillator.stop(nowAt + note.start + note.duration + 0.03);
        });
      } catch (error) {
        console.warn('Notification sound failed:', error);
      }
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

        const forceBrowserAlert = ALWAYS_NOTIFY_EVENT_TYPES.has(payload.eventType);
        const isHidden = document.visibilityState !== 'visible';
        const supportsWebPush = 'serviceWorker' in navigator && 'PushManager' in window;
        const shouldShowBrowserNotification = !isHidden || !supportsWebPush;

        const now = Date.now();
        pruneRecentEvents(now);

        const nextAlert = buildAlertPayload(payload);
        if (recentEventsRef.current.has(nextAlert.key)) return;
        recentEventsRef.current.set(nextAlert.key, now);

        if (isHidden) {
          hiddenAlertCountRef.current += 1;
          updateTitle();
        }
        if (forceBrowserAlert && !isHidden) {
          playMessageTone();
        }
        if (shouldShowBrowserNotification) {
          notifyBrowser(nextAlert.title, nextAlert.body, nextAlert.key);
        }
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
    if ('serviceWorker' in navigator && 'PushManager' in window) {
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
