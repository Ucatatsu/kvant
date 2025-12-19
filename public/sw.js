// === КВАНТ - SERVICE WORKER ===

const CACHE_NAME = 'kvant-v48';
const APP_VERSION = '1B0d4'; // KVS версия - синхронизируй с package.json
const STATIC_ASSETS = [
    '/',
    '/index.html',
    '/style.css',
    '/app.js',
    '/icon.png',
    '/background.jpg',
    '/loading.html',
    // SVG иконки
    '/assets/arrow-left.svg',
    '/assets/phone-call.svg',
    '/assets/phone-off.svg',
    '/assets/video.svg',
    '/assets/video-off.svg',
    '/assets/microphone.svg',
    '/assets/Block-microphone.svg',
    '/assets/camera.svg',
    '/assets/camera-off.svg',
    '/assets/screen-share.svg',
    '/assets/screen-share-off.svg',
    '/assets/send.svg',
    '/assets/Clip.svg',
    '/assets/emoji.svg',
    '/assets/settings.svg',
    '/assets/profile.svg',
    '/assets/edit.svg',
    '/assets/trash.svg',
    '/assets/bell.svg',
    '/assets/cross.svg',
    '/assets/Expand.svg',
    '/assets/menu dots vertical.svg',
    '/assets/power.svg',
    '/assets/Badge-check.svg',
    '/assets/image.svg',
    '/assets/message.svg',
    '/assets/messenga-lock.svg',
    '/assets/messenge-info.svg',
    '/assets/messenge-question.svg'
];

// Установка - кэширование статических ресурсов
self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then((cache) => cache.addAll(STATIC_ASSETS))
            .then(() => self.skipWaiting())
    );
});

// Активация перенесена в обработчик message для уведомления клиентов

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
    
    // Определяем тип уведомления
    const isCall = data.type === 'incoming-call';
    
    const options = {
        body: data.body || (isCall ? 'Входящий звонок' : 'Новое сообщение'),
        icon: '/icon.png',
        badge: '/icon.png',
        vibrate: isCall ? [300, 100, 300, 100, 300] : [200, 100, 200],
        tag: data.tag || (isCall ? 'call' : 'message'),
        renotify: true,
        requireInteraction: isCall, // Звонки требуют взаимодействия
        silent: false,
        data: {
            url: data.url || '/',
            senderId: data.senderId,
            type: data.type || 'message',
            callId: data.callId,
            isVideo: data.isVideo
        },
        actions: isCall 
            ? [
                { action: 'answer', title: '📞 Ответить' },
                { action: 'decline', title: '❌ Отклонить' }
            ]
            : [
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
    const notificationData = event.notification.data || {};
    const isCall = notificationData.type === 'incoming-call';
    
    // Обработка действий для звонков
    if (isCall) {
        if (event.action === 'decline') {
            event.notification.close();
            // Отправляем отклонение звонка
            event.waitUntil(
                clients.matchAll({ type: 'window', includeUncontrolled: true })
                    .then((clientList) => {
                        for (const client of clientList) {
                            if (client.url.includes(self.location.origin)) {
                                client.postMessage({
                                    type: 'call-declined-from-notification',
                                    senderId: notificationData.senderId,
                                    callId: notificationData.callId
                                });
                                return;
                            }
                        }
                    })
            );
            return;
        }
        
        if (event.action === 'answer' || !event.action) {
            event.notification.close();
            event.waitUntil(
                clients.matchAll({ type: 'window', includeUncontrolled: true })
                    .then((clientList) => {
                        for (const client of clientList) {
                            if (client.url.includes(self.location.origin) && 'focus' in client) {
                                client.postMessage({
                                    type: 'call-answer-from-notification',
                                    senderId: notificationData.senderId,
                                    callId: notificationData.callId,
                                    isVideo: notificationData.isVideo
                                });
                                return client.focus();
                            }
                        }
                        if (clients.openWindow) {
                            return clients.openWindow('/?answerCall=' + notificationData.callId);
                        }
                    })
            );
            return;
        }
    }
    
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
                            senderId: notificationData.senderId
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
    
    // Запрос версии от клиента
    if (event.data.type === 'getVersion') {
        event.ports[0].postMessage({ version: APP_VERSION, cacheName: CACHE_NAME });
    }
});

// Уведомление клиентов о новой версии при активации
self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys()
            .then((cacheNames) => {
                return Promise.all(
                    cacheNames
                        .filter((name) => name.startsWith('kvant-') && name !== CACHE_NAME)
                        .map((name) => caches.delete(name))
                );
            })
            .then(() => self.clients.claim())
            .then(() => {
                // Уведомляем все открытые вкладки о новой версии
                return self.clients.matchAll({ type: 'window' });
            })
            .then((clients) => {
                clients.forEach((client) => {
                    client.postMessage({
                        type: 'sw-updated',
                        version: APP_VERSION
                    });
                });
            })
    );
}, { once: false });

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
