// === КВАНТ - SERVICE WORKER ===

const CACHE_NAME = 'kvant-v2';
const STATIC_ASSETS = [
    '/',
    '/index.html',
    '/style.css',
    '/app.js',
    '/icon.png',
    '/background.jpg',
    '/loading.html'
];

// Установка - кэширование статических ресурсов
self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then((cache) => cache.addAll(STATIC_ASSETS))
            .then(() => self.skipWaiting())
    );
});

// Активация - очистка старых кэшей
self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys()
            .then((cacheNames) => {
                return Promise.all(
                    cacheNames
                        .filter((name) => name !== CACHE_NAME)
                        .map((name) => caches.delete(name))
                );
            })
            .then(() => self.clients.claim())
    );
});

// Fetch - стратегия Network First с fallback на кэш
self.addEventListener('fetch', (event) => {
    const { request } = event;
    const url = new URL(request.url);
    
    // Пропускаем API, WebSocket и внешние запросы
    if (
        url.pathname.startsWith('/api/') ||
        url.pathname.startsWith('/socket.io/') ||
        url.protocol === 'ws:' ||
        url.protocol === 'wss:' ||
        url.origin !== self.location.origin
    ) {
        return;
    }
    
    // Для статических ресурсов - Cache First
    if (STATIC_ASSETS.some(asset => url.pathname === asset || url.pathname.endsWith(asset))) {
        event.respondWith(
            caches.match(request)
                .then((cached) => {
                    if (cached) {
                        // Обновляем кэш в фоне
                        fetch(request)
                            .then((response) => {
                                if (response.ok) {
                                    caches.open(CACHE_NAME)
                                        .then((cache) => cache.put(request, response));
                                }
                            })
                            .catch(() => {});
                        return cached;
                    }
                    return fetch(request)
                        .then((response) => {
                            if (response.ok) {
                                const clone = response.clone();
                                caches.open(CACHE_NAME)
                                    .then((cache) => cache.put(request, clone));
                            }
                            return response;
                        });
                })
        );
        return;
    }
    
    // Для остальных - Network First
    event.respondWith(
        fetch(request)
            .then((response) => {
                if (response.ok && request.method === 'GET') {
                    const clone = response.clone();
                    caches.open(CACHE_NAME)
                        .then((cache) => cache.put(request, clone));
                }
                return response;
            })
            .catch(() => caches.match(request))
    );
});

// Push уведомления
self.addEventListener('push', (event) => {
    if (!event.data) return;
    
    let data;
    try {
        data = event.data.json();
    } catch {
        data = {
            title: 'Квант',
            body: event.data.text()
        };
    }
    
    const options = {
        body: data.body || 'Новое сообщение',
        icon: '/icon.png',
        badge: '/icon.png',
        vibrate: [200, 100, 200],
        tag: data.tag || 'message',
        renotify: true,
        requireInteraction: false,
        data: {
            url: data.url || '/',
            senderId: data.senderId
        },
        actions: [
            { action: 'open', title: 'Открыть' },
            { action: 'close', title: 'Закрыть' }
        ]
    };
    
    event.waitUntil(
        self.registration.showNotification(data.title || 'Квант', options)
    );
});

// Клик по уведомлению
self.addEventListener('notificationclick', (event) => {
    event.notification.close();
    
    if (event.action === 'close') return;
    
    event.waitUntil(
        clients.matchAll({ type: 'window', includeUncontrolled: true })
            .then((clientList) => {
                // Ищем открытое окно
                for (const client of clientList) {
                    if (client.url.includes(self.location.origin) && 'focus' in client) {
                        // Отправляем сообщение клиенту
                        client.postMessage({
                            type: 'notification-click',
                            senderId: event.notification.data?.senderId
                        });
                        return client.focus();
                    }
                }
                // Открываем новое окно
                if (clients.openWindow) {
                    return clients.openWindow('/');
                }
            })
    );
});

// Закрытие уведомления
self.addEventListener('notificationclose', (event) => {
    // Можно отправить аналитику
    console.log('Notification closed:', event.notification.tag);
});

// Сообщения от клиента
self.addEventListener('message', (event) => {
    if (event.data === 'skipWaiting') {
        self.skipWaiting();
    }
    
    if (event.data.type === 'clearCache') {
        caches.delete(CACHE_NAME);
    }
});

// Background Sync (для отправки сообщений офлайн)
self.addEventListener('sync', (event) => {
    if (event.tag === 'send-messages') {
        event.waitUntil(sendPendingMessages());
    }
});

async function sendPendingMessages() {
    // Получаем сообщения из IndexedDB и отправляем
    // Это заглушка - нужна реализация с IndexedDB
    console.log('Syncing pending messages...');
}
