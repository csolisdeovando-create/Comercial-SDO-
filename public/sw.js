// Service worker mínimo: permite instalar el panel como app en Android (Chrome antiguos, Samsung Internet).
// No guarda nada en caché: todas las páginas se cargan siempre desde el servidor.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => {});
