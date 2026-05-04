import { useEffect, useRef, useState } from 'react';
import { useAuth } from '../context/AuthContext';
import { taskAPI } from '../services/api';
import {
  canUseWebPushBrowser,
  cleanupWebPushSubscription,
  WEB_PUSH_SERVICE_WORKER_URL,
} from '../utils/webPush';

const PERMISSION_PROMPTED_KEY = 'rmw_web_push_prompted_v1';
const PUBLIC_KEY_STORAGE_KEY = 'rmw_web_push_public_key_v1';

const urlBase64ToUint8Array = (base64String) => {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = window.atob(base64);
  return Uint8Array.from([...rawData].map((char) => char.charCodeAt(0)));
};

const readStoredPublicKey = () => {
  try {
    return window.localStorage.getItem(PUBLIC_KEY_STORAGE_KEY) || '';
  } catch {
    return '';
  }
};

const writeStoredPublicKey = (value) => {
  try {
    if (value) {
      window.localStorage.setItem(PUBLIC_KEY_STORAGE_KEY, value);
    } else {
      window.localStorage.removeItem(PUBLIC_KEY_STORAGE_KEY);
    }
  } catch {
    // no-op
  }
};

const getReadyWebPushRegistration = async () => {
  const registration = await navigator.serviceWorker.register(WEB_PUSH_SERVICE_WORKER_URL);
  const readyRegistration = await navigator.serviceWorker.ready;
  const activeRegistration = readyRegistration || registration;

  if (activeRegistration) {
    try {
      await activeRegistration.update();
    } catch {
      // Best-effort refresh in case the worker script changed.
    }
    return activeRegistration;
  }

  const fallbackRegistration = await navigator.serviceWorker.getRegistration();
  if (fallbackRegistration) {
    return fallbackRegistration;
  }

  if (!registration) {
    throw new Error('Push service worker is not ready yet.');
  }
  return registration;
};

export default function useWebPushNotifications() {
  const { user } = useAuth();
  const endpointRef = useRef('');
  const userIdRef = useRef(null);
  const [status, setStatus] = useState({
    code: 'checking',
    detail: 'Checking browser push support...',
  });

  useEffect(() => {
    if (!canUseWebPushBrowser()) {
      endpointRef.current = '';
      userIdRef.current = user?.id || null;
      setStatus({
        code: 'unsupported',
        detail: 'This browser does not support web push notifications.',
      });
      return undefined;
    }

    let cancelled = false;

    const syncSubscription = async () => {
      if (!user) return;
      setStatus({
        code: 'checking',
        detail: 'Checking push configuration...',
      });

      try {
        const config = await taskAPI.getWebPushConfig().catch(() => null);
        if (!config?.enabled || !config?.publicKey) {
          if (!cancelled) {
            setStatus({
              code: 'server_disabled',
              detail: config?.detail || 'Web push is not configured on the server yet.',
            });
          }
          return;
        }

        const registration = await getReadyWebPushRegistration();
        if (cancelled) return;

        let subscription = await registration.pushManager.getSubscription();
        const storedPublicKey = readStoredPublicKey();
        const shouldRefreshSubscription =
          !!subscription
          && !!storedPublicKey
          && storedPublicKey !== config.publicKey;

        if (shouldRefreshSubscription) {
          const staleEndpoint = subscription.endpoint || '';
          if (staleEndpoint) {
            try {
              await taskAPI.unsubscribeWebPush(staleEndpoint);
            } catch {
              // Best effort cleanup for rotated VAPID keys.
            }
          }
          await subscription.unsubscribe().catch(() => {});
          subscription = null;
          endpointRef.current = '';
        }

        if (!subscription) {
          if (Notification.permission !== 'granted') {
            if (!cancelled) {
              setStatus({
                code: Notification.permission === 'denied' ? 'permission_denied' : 'permission_required',
                detail:
                  Notification.permission === 'denied'
                    ? 'Browser notification permission is blocked.'
                    : 'Allow browser notifications to activate closed-tab alerts.',
              });
            }
            return;
          }
          subscription = await registration.pushManager.subscribe({
            userVisibleOnly: true,
            applicationServerKey: urlBase64ToUint8Array(config.publicKey),
          });
        }

        if (!subscription || cancelled) return;

        const serialized = subscription.toJSON ? subscription.toJSON() : {
          endpoint: subscription.endpoint,
          expirationTime: subscription.expirationTime,
          keys: {},
        };

        await taskAPI.subscribeWebPush(serialized);
        endpointRef.current = subscription.endpoint || serialized.endpoint || '';
        userIdRef.current = user.id;
        writeStoredPublicKey(config.publicKey);
        if (!cancelled) {
          setStatus({
            code: 'active',
            detail: 'Push is active for this browser. Closed-tab alerts should work while the browser is still running in the background.',
          });
        }
      } catch (error) {
        if (!cancelled) {
          setStatus({
            code: 'error',
            detail: error?.response?.data?.detail || 'Failed to activate web push for this browser.',
          });
        }
      }
    };

    const requestPermissionAndSync = async () => {
      if (Notification.permission === 'denied') return;

      try {
        window.sessionStorage.setItem(PERMISSION_PROMPTED_KEY, '1');
      } catch {
        // no-op
      }

      try {
        const permission = await Notification.requestPermission();
        if (permission === 'granted' && !cancelled) {
          await syncSubscription();
        } else if (!cancelled) {
          setStatus({
            code: permission === 'denied' ? 'permission_denied' : 'permission_required',
            detail:
              permission === 'denied'
                ? 'Browser notification permission is blocked.'
                : 'Allow browser notifications to activate closed-tab alerts.',
          });
        }
      } catch {
        // Browser rejected the permission request.
        if (!cancelled) {
          setStatus({
            code: 'error',
            detail: 'The browser rejected the notification permission request.',
          });
        }
      }
    };

    const attachPermissionListeners = () => {
      let prompted = false;
      try {
        prompted = window.sessionStorage.getItem(PERMISSION_PROMPTED_KEY) === '1';
      } catch {
        prompted = false;
      }
      if (prompted) return () => {};

      const onUserGesture = () => {
        void requestPermissionAndSync();
        window.removeEventListener('pointerdown', onUserGesture);
        window.removeEventListener('keydown', onUserGesture);
      };

      window.addEventListener('pointerdown', onUserGesture, { once: true });
      window.addEventListener('keydown', onUserGesture, { once: true });

      return () => {
        window.removeEventListener('pointerdown', onUserGesture);
        window.removeEventListener('keydown', onUserGesture);
      };
    };

    let detachPermissionListeners = () => {};

    if (!user) {
      void cleanupWebPushSubscription({
        removeServerSubscription: false,
        removeBrowserSubscription: true,
      });
      writeStoredPublicKey('');
      endpointRef.current = '';
      userIdRef.current = null;
      setStatus({
        code: 'inactive',
        detail: 'Log in to activate push notifications for this browser.',
      });
      return undefined;
    }

    if (endpointRef.current && userIdRef.current && userIdRef.current !== user.id) {
      setStatus({
        code: 'checking',
        detail: 'Refreshing push subscription for the current user...',
      });
      void cleanupWebPushSubscription({
        removeServerSubscription: true,
        removeBrowserSubscription: true,
      }).finally(() => {
        if (!cancelled) {
          void syncSubscription();
        }
      });
      return () => {
        cancelled = true;
        detachPermissionListeners();
      };
    }

    if (Notification.permission === 'granted') {
      void syncSubscription();
    } else if (Notification.permission === 'default') {
      setStatus({
        code: 'permission_required',
        detail: 'Allow browser notifications to activate closed-tab alerts.',
      });
      detachPermissionListeners = attachPermissionListeners();
    } else {
      setStatus({
        code: 'permission_denied',
        detail: 'Browser notification permission is blocked.',
      });
    }

    return () => {
      cancelled = true;
      detachPermissionListeners();
    };
  }, [user?.id]);

  return status;
}

