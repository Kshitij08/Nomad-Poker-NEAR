// Retires the old Unity build's service worker. Until 14 Nov 2026 this domain served the Unity WebGL build, which
// registered /sw.js (scope /) and cached its files. Browsers keep that worker after the site changed, so the new game's
// first load ran through it (assets served from the old cache, audio stalled until the page was reopened). When a
// returning browser checks for an update it gets this script instead: it takes over at once, deletes every cache the
// old worker made, unregisters itself and reloads open tabs, which then load straight from the network.
// The new game registers no service worker; keep this file until old visitors have all been through.
self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k)));
      await self.registration.unregister();
      const tabs = await self.clients.matchAll({ type: 'window' });
      for (const tab of tabs) tab.navigate(tab.url).catch(() => {});
    })(),
  );
});

// No fetch handler: requests go straight to the network.
