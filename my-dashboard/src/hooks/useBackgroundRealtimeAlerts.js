import { useEffect, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../context/AuthContext';
import { directMessageAPI, groupAPI, subscribeRealtimeNotifications } from '../services/api';
import { buildTaskPanelCacheKey, invalidateTaskPanelCache } from '../utils/taskPanelCache';
import { isViewingChat } from '../utils/activeChat';
import { getCurrentWebPushSubscription } from '../utils/webPush';

const RECENT_EVENT_TTL_MS = 15000;
const SESSION_PERMISSION_KEY = 'rmw_browser_notifications_prompted_v1';
const ALERT_CLAIMS_STORAGE_KEY = 'rmw_alert_claims_v1';
const ALERT_CLAIM_TTL_MS = 20000;
const UNREAD_BASELINE_REFRESH_MS = 2 * 60 * 1000;
const PUSH_STATUS_REFRESH_MS = 60 * 1000;
const MESSAGE_EVENT_TYPES = new Set(['group_message', 'direct_message']);
// Events that play the chime (task events only show a popup, as before).
const SOUND_EVENT_TYPES = new Set(['group_message', 'direct_message', 'notification_test']);
// Sync-only events: they keep open panels fresh but are never an alert. They
// used to fall through to notifyBrowser(), popping "New update" for typing.
const SILENT_EVENT_TYPES = new Set([
  'chat_typing',
  'message_read_receipt',
  'message_delivery_receipt',
  'message_updated',
  'message_deleted',
  'message_pinned',
  'message_reaction',
]);
const TASK_EVENT_TYPES = new Set([
  'assigned',
  'approved',
  'completed',
  'forwarded',
  'need_improvement',
  'rejected',
  'started',
  'submitted',
  'task_received',
  'workflow_stage_assigned',
  'workflow_stage_approved',
  'workflow_stage_submitted',
]);

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
    metadata.sentAt || '',
    title,
    body,
  ].join('::');

  return { title, body, key };
};

const getChatTarget = (payload) => {
  const metadata = payload?.metadata || {};
  if (payload?.eventType === 'group_message') return { scope: 'group', threadId: metadata.groupId };
  if (payload?.eventType === 'direct_message') return { scope: 'direct', threadId: metadata.senderId };
  return null;
};

// With several dashboard tabs open, only the first tab to claim an event
// alerts; the others stay quiet instead of chiming in unison.
const claimAlert = (key) => {
  try {
    const now = Date.now();
    const claims = JSON.parse(window.localStorage.getItem(ALERT_CLAIMS_STORAGE_KEY) || '{}');
    if (claims[key] && now - claims[key] < ALERT_CLAIM_TTL_MS) return false;
    const pruned = Object.fromEntries(
      Object.entries(claims).filter(([, claimedAt]) => now - claimedAt < ALERT_CLAIM_TTL_MS)
    );
    pruned[key] = now;
    window.localStorage.setItem(ALERT_CLAIMS_STORAGE_KEY, JSON.stringify(pruned));
    return true;
  } catch {
    return true;
  }
};

const fetchUnreadTotal = async () => {
  const [groupResponse, directResponse] = await Promise.all([
    groupAPI.listUnreadCounts(),
    directMessageAPI.listUnreadCounts(),
  ]);
  // Totals already leave muted chats out (see the unread-counts endpoints).
  return Number(groupResponse?.data?.totalUnreadMessages || 0)
    + Number(directResponse?.data?.totalUnreadMessages || 0);
};

export default function useBackgroundRealtimeAlerts() {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const baseTitleRef = useRef('');
  const hiddenAlertCountRef = useRef(0);
  const recentEventsRef = useRef(new Map());
  const audioContextRef = useRef(null);
  const pushCoversHiddenTabRef = useRef(false);
  const unreadBaselineRef = useRef(null);

  useEffect(() => {
    if (typeof document === 'undefined') return undefined;
    if (!baseTitleRef.current) {
      baseTitleRef.current = document.title || 'Dashboard';
    }
    return undefined;
  }, []);

  // Browsers keep an AudioContext created without a user gesture suspended,
  // so the first chime after page load was often silent. Create/resume it on
  // the first click or key press instead.
  useEffect(() => {
    if (!user || typeof window === 'undefined') return undefined;
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) return undefined;

    const unlockAudio = () => {
      try {
        if (!audioContextRef.current) {
          audioContextRef.current = new AudioContextClass();
        }
        if (audioContextRef.current.state === 'suspended') {
          void audioContextRef.current.resume().catch(() => {});
        }
      } catch {
        // no-op
      }
    };

    window.addEventListener('pointerdown', unlockAudio, { capture: true });
    window.addEventListener('keydown', unlockAudio, { capture: true });
    return () => {
      window.removeEventListener('pointerdown', unlockAudio, { capture: true });
      window.removeEventListener('keydown', unlockAudio, { capture: true });
    };
  }, [user]);

  // Whether a web push subscription will show OS notifications for this
  // browser while the tab is hidden (push-sw.js stays quiet while any
  // dashboard tab is visible). Without one, the tab must alert by itself.
  useEffect(() => {
    if (!user || typeof window === 'undefined') return undefined;
    let cancelled = false;

    const refreshPushStatus = async () => {
      try {
        const current = await getCurrentWebPushSubscription();
        if (!cancelled) {
          pushCoversHiddenTabRef.current = !!current?.subscription
            && 'Notification' in window
            && Notification.permission === 'granted';
        }
      } catch {
        if (!cancelled) pushCoversHiddenTabRef.current = false;
      }
    };

    void refreshPushStatus();
    const interval = window.setInterval(refreshPushStatus, PUSH_STATUS_REFRESH_MS);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [user]);

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

    const playMessageTone = async () => {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      if (!AudioContextClass) return;

      try {
        if (!audioContextRef.current) {
          audioContextRef.current = new AudioContextClass();
        }
        const ctx = audioContextRef.current;
        if (ctx.state === 'suspended') {
          // Notes scheduled before resume() settles land in the past and are
          // never heard - wait for it (briefly) before scheduling.
          await Promise.race([
            ctx.resume(),
            new Promise((resolve) => window.setTimeout(resolve, 400)),
          ]);
        }
        if (ctx.state !== 'running') return;

        const nowAt = ctx.currentTime + 0.02;
        const masterGain = ctx.createGain();
        masterGain.connect(ctx.destination);
        masterGain.gain.setValueAtTime(1, nowAt);

        const notes = [
          { frequency: 880, start: 0, duration: 0.09, gain: 0.12 },
          { frequency: 1174.66, start: 0.12, duration: 0.14, gain: 0.1 },
        ];

        notes.forEach((note) => {
          const oscillator = ctx.createOscillator();
          const noteGain = ctx.createGain();
          oscillator.type = 'sine';
          oscillator.frequency.setValueAtTime(note.frequency, nowAt + note.start);
          noteGain.gain.setValueAtTime(0.0001, nowAt + note.start);
          noteGain.gain.exponentialRampToValueAtTime(note.gain, nowAt + note.start + 0.012);
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
          icon: '/rmweye.svg',
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

    const refreshTaskLanes = () => {
      const userKey = user?.id ?? 'anonymous';
      ['inbox', 'tracking', 'outbox'].forEach((lane) => {
        queryClient.invalidateQueries({ queryKey: [lane, userKey] });
      });
      if (user?.id) {
        [
          'inbox',
          'inbox_unread_count',
          'tracking',
          'outbox',
          'outbox_badge',
        ].forEach((panelKey) => {
          invalidateTaskPanelCache(buildTaskPanelCacheKey(user.id, panelKey));
        });
      }
    };

    const alertUser = ({ title, body, key, withSound }) => {
      const isHidden = document.visibilityState !== 'visible';
      if (!claimAlert(key)) return;

      if (isHidden) {
        hiddenAlertCountRef.current += 1;
        updateTitle();
      }
      if (withSound) {
        void playMessageTone();
      }
      // While hidden, push-sw.js shows the OS notification if this browser is
      // subscribed; otherwise the tab has to do it or nothing appears.
      if (!isHidden || !pushCoversHiddenTabRef.current) {
        notifyBrowser(title, body, key);
      }
    };

    const refreshUnreadBaseline = async () => {
      try {
        unreadBaselineRef.current = await fetchUnreadTotal();
      } catch {
        // Keep the previous baseline; the next refresh will try again.
      }
    };

    // Messages sent while the socket was down never arrive as events. After a
    // reconnect, compare the server's unread total with what we last knew and
    // alert once for anything that slipped through.
    const catchUpAfterReconnect = async () => {
      const previous = unreadBaselineRef.current;
      try {
        const current = await fetchUnreadTotal();
        unreadBaselineRef.current = current;
        if (previous === null || current <= previous) return;
        const missed = current - previous;
        alertUser({
          title: 'New messages',
          body: `You have ${missed} new message${missed === 1 ? '' : 's'} you may have missed.`,
          key: `catch-up::${current}`,
          withSound: true,
        });
      } catch {
        // Offline again; the next reconnect retries.
      }
    };

    const unsubscribe = subscribeRealtimeNotifications({
      onOpen: (info) => {
        if (info?.reconnected) {
          void catchUpAfterReconnect();
        } else {
          void refreshUnreadBaseline();
        }
      },
      onMessage: (payload) => {
        if (!payload?.eventType) return;
        if (TASK_EVENT_TYPES.has(payload.eventType) || payload.taskId) {
          refreshTaskLanes();
        }
        if (SILENT_EVENT_TYPES.has(payload.eventType)) return;
        // Muted chat threads still sync in the open panel, but never alert.
        if (payload.metadata?.muted) return;

        const isMessage = MESSAGE_EVENT_TYPES.has(payload.eventType);
        if (isMessage && unreadBaselineRef.current !== null) {
          unreadBaselineRef.current += 1;
        }

        const chatTarget = getChatTarget(payload);
        if (chatTarget && isViewingChat(chatTarget.scope, chatTarget.threadId)) return;

        const now = Date.now();
        pruneRecentEvents(now);
        const nextAlert = buildAlertPayload(payload);
        if (recentEventsRef.current.has(nextAlert.key)) return;
        recentEventsRef.current.set(nextAlert.key, now);

        alertUser({
          ...nextAlert,
          withSound: SOUND_EVENT_TYPES.has(payload.eventType),
        });
      },
    });

    const baselineInterval = window.setInterval(() => {
      if (document.visibilityState === 'visible') void refreshUnreadBaseline();
    }, UNREAD_BASELINE_REFRESH_MS);

    const handleVisibleAgain = () => restoreTitle();
    document.addEventListener('visibilitychange', handleVisibleAgain);
    window.addEventListener('focus', handleVisibleAgain);

    return () => {
      unsubscribe();
      window.clearInterval(baselineInterval);
      document.removeEventListener('visibilitychange', handleVisibleAgain);
      window.removeEventListener('focus', handleVisibleAgain);
      restoreTitle();
    };
  }, [queryClient, user]);

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
