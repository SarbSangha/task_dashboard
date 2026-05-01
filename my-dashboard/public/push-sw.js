self.addEventListener('install', (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.isDashboardClientUrl = (urlValue) => {
  try {
    const clientUrl = new URL(urlValue);
    const hash = `${clientUrl.hash || ''}`.toLowerCase();
    return hash === '#/dashboard' || hash.startsWith('#/dashboard/');
  } catch {
    return false;
  }
};

self.addEventListener('push', (event) => {
  event.waitUntil((async () => {
    let payload = {
      title: 'New update',
      body: 'You have a new notification.',
      tag: 'rmw-notification',
      url: '/#/dashboard',
      data: {},
    };

    if (event.data) {
      try {
        payload = { ...payload, ...event.data.json() };
      } catch {
        payload.body = event.data.text() || payload.body;
      }
    }

    const clients = await self.clients.matchAll({
      type: 'window',
      includeUncontrolled: true,
    });

    const hasVisibleClient = clients.some((client) => {
      try {
        const clientUrl = new URL(client.url);
        return (
          clientUrl.origin === self.location.origin
          && client.visibilityState === 'visible'
          && self.isDashboardClientUrl(client.url)
        );
      } catch {
        return false;
      }
    });

    if (hasVisibleClient) {
      return;
    }

    await self.registration.showNotification(payload.title, {
      body: payload.body,
      tag: payload.tag || 'rmw-notification',
      data: {
        ...(payload.data || {}),
        url: payload.url || '/#/dashboard',
      },
      icon: '/rmweye.svg',
      badge: '/rmweye.svg',
      renotify: true,
      requireInteraction: false,
      silent: false,
    });
  })());
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  event.waitUntil((async () => {
    const targetUrl = event.notification?.data?.url || '/#/dashboard';
    const absoluteTargetUrl = new URL(targetUrl, self.location.origin).toString();
    const clients = await self.clients.matchAll({
      type: 'window',
      includeUncontrolled: true,
    });

    for (const client of clients) {
      try {
        const clientUrl = new URL(client.url);
        if (clientUrl.origin !== self.location.origin) {
          continue;
        }
        if ('focus' in client) {
          await client.focus();
        }
        if ('navigate' in client && client.url !== absoluteTargetUrl) {
          await client.navigate(absoluteTargetUrl);
        }
        return;
      } catch {
        // Try the next client.
      }
    }

    if (self.clients.openWindow) {
      await self.clients.openWindow(absoluteTargetUrl);
    }
  })());
});
