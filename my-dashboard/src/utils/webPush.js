import { taskAPI } from '../services/api';

export const WEB_PUSH_SERVICE_WORKER_URL = '/push-sw.js';

export const canUseWebPushBrowser = () =>
  typeof window !== 'undefined'
  && 'Notification' in window
  && 'serviceWorker' in navigator
  && 'PushManager' in window;

export const getWebPushRegistration = async () => {
  if (!canUseWebPushBrowser()) return null;
  return navigator.serviceWorker.getRegistration();
};

export const getCurrentWebPushSubscription = async () => {
  const registration = await getWebPushRegistration();
  if (!registration) return null;

  const subscription = await registration.pushManager.getSubscription();
  if (!subscription) return null;

  return { registration, subscription };
};

export const cleanupWebPushSubscription = async ({
  removeServerSubscription = true,
  removeBrowserSubscription = true,
} = {}) => {
  const current = await getCurrentWebPushSubscription();
  if (!current?.subscription) return false;

  const endpoint = current.subscription.endpoint || '';

  if (removeServerSubscription && endpoint) {
    try {
      await taskAPI.unsubscribeWebPush(endpoint);
    } catch {
      // Best effort server cleanup.
    }
  }

  if (removeBrowserSubscription) {
    try {
      await current.subscription.unsubscribe();
    } catch {
      // Best effort browser cleanup.
    }
  }

  return true;
};
