// === КВАНТ МЕССЕНДЖЕР - КЛИЕНТ ===

// === СОСТОЯНИЕ ПРИЛОЖЕНИЯ ===
const state = {
    currentUser: null,
    currentUserProfile: null,
    selectedUser: null,
    selectedUserProfile: null,
    onlineUsers: {},  // Теперь объект: { odataId: status }
    typingUsers: new Map(),
    token: null,
    socket: null,
    notificationsEnabled: localStorage.getItem('notifications') !== 'false',
    swRegistration: null,
    settings: JSON.parse(localStorage.getItem('kvant_settings') || '{}'),
    userStatus: localStorage.getItem('kvant_status') || 'online',
    micMuted: false,
    camMuted: false,
    // Кэш DOM элементов
    dom: {},
    // Локальные данные пользователей (никнеймы, отключённые уведомления)
    userLocalData: JSON.parse(localStorage.getItem('kvant_user_local_data') || '{}'),
    // Новые типы чатов
    currentTab: 'chats',
    groups: [],
    channels: [],
    servers: [],
    selectedGroup: null,
    selectedChannel: null,
    selectedServer: null,
    selectedServerChannel: null
};

// Сохранение локальных данных пользователей
function saveUserLocalData() {
    localStorage.setItem('kvant_user_local_data', JSON.stringify(state.userLocalData));
}

// Получить локальный никнейм пользователя
function getLocalNickname(userId) {
    return state.userLocalData[userId]?.nickname || null;
}

// Установить локальный никнейм
function setLocalNickname(userId, nickname) {
    if (!state.userLocalData[userId]) {
        state.userLocalData[userId] = {};
    }
    state.userLocalData[userId].nickname = nickname || null;
    saveUserLocalData();
}

// Проверить отключены ли уведомления для пользователя
function isUserMuted(userId) {
    return state.userLocalData[userId]?.muted || false;
}

// Переключить уведомления для пользователя
function toggleUserMuted(userId) {
    if (!state.userLocalData[userId]) {
        state.userLocalData[userId] = {};
    }
    state.userLocalData[userId].muted = !state.userLocalData[userId].muted;
    saveUserLocalData();
    return state.userLocalData[userId].muted;
}

// === ЗВУКОВАЯ СИСТЕМА ===
const sounds = {
    message: null,
    call: null,
    notification: null
};

// Создаём звуки программно (Web Audio API)
function initSounds() {
    const audioContext = new (window.AudioContext || window.webkitAudioContext)();
    
    // Получить текущую громкость (0-1)
    function getVolume() {
        const vol = state.settings.volume ?? 50;
        return vol / 100;
    }
    
    // Функция для создания звука уведомления
    function createNotificationSound() {
        const now = audioContext.currentTime;
        const volume = getVolume();
        
        [800, 1000].forEach((freq, i) => {
            const oscillator = audioContext.createOscillator();
            const gainNode = audioContext.createGain();
            
            oscillator.connect(gainNode);
            gainNode.connect(audioContext.destination);
            
            oscillator.type = 'sine';
            oscillator.frequency.setValueAtTime(freq, now + i * 0.15);
            
            gainNode.gain.setValueAtTime(0.8 * volume, now + i * 0.15);
            gainNode.gain.exponentialRampToValueAtTime(0.01, now + i * 0.15 + 0.2);
            
            oscillator.start(now + i * 0.15);
            oscillator.stop(now + i * 0.15 + 0.2);
        });
    }
    
    // Функция для создания звука звонка
    function createCallSound() {
        let isPlaying = true;
        let ringCount = 0;
        
        const playRing = () => {
            if (!isPlaying) return;
            
            const now = audioContext.currentTime;
            const volume = getVolume();
            
            [0, 0.15].forEach((delay) => {
                const oscillator = audioContext.createOscillator();
                const gainNode = audioContext.createGain();
                
                oscillator.connect(gainNode);
                gainNode.connect(audioContext.destination);
                
                oscillator.type = 'sine';
                oscillator.frequency.setValueAtTime(440, now + delay);
                oscillator.frequency.setValueAtTime(520, now + delay + 0.1);
                
                gainNode.gain.setValueAtTime(1.0 * volume, now + delay);
                gainNode.gain.exponentialRampToValueAtTime(0.3 * volume, now + delay + 0.15);
                gainNode.gain.exponentialRampToValueAtTime(0.01, now + delay + 0.25);
                
                oscillator.start(now + delay);
                oscillator.stop(now + delay + 0.25);
            });
            
            ringCount++;
            setTimeout(playRing, ringCount % 2 === 0 ? 1500 : 400);
        };
        
        playRing();
        return () => { isPlaying = false; };
    }
    
    sounds.playMessage = () => {
        if (state.settings.sounds === false) return;
        try {
            if (audioContext.state === 'suspended') audioContext.resume();
            createNotificationSound();
        } catch (e) { console.log('Sound error:', e); }
    };
    
    sounds.playCall = () => {
        if (state.settings.sounds === false) return null;
        try {
            if (audioContext.state === 'suspended') audioContext.resume();
            return createCallSound();
        } catch (e) { 
            console.log('Sound error:', e); 
            return null;
        }
    };
}

// Инициализируем звуки при первом взаимодействии
let soundsInitialized = false;
function ensureSoundsInitialized() {
    if (!soundsInitialized) {
        initSounds();
        soundsInitialized = true;
    }
}

// === УТИЛИТЫ ОПТИМИЗАЦИИ ===
function debounce(fn, delay) {
    let timeout;
    return (...args) => {
        clearTimeout(timeout);
        timeout = setTimeout(() => fn(...args), delay);
    };
}

function throttle(fn, limit) {
    let inThrottle;
    return (...args) => {
        if (!inThrottle) {
            fn(...args);
            inThrottle = true;
            setTimeout(() => inThrottle = false, limit);
        }
    };
}

// Выполнить задачу когда браузер свободен
const runWhenIdle = window.requestIdleCallback || ((cb) => setTimeout(cb, 1));

// Batch DOM updates
let pendingUpdates = [];
let updateScheduled = false;

function scheduleDOMUpdate(fn) {
    pendingUpdates.push(fn);
    if (!updateScheduled) {
        updateScheduled = true;
        requestAnimationFrame(() => {
            const updates = pendingUpdates;
            pendingUpdates = [];
            updateScheduled = false;
            updates.forEach(f => f());
        });
    }
}

// Кэширование DOM элементов
function getEl(id) {
    if (!state.dom[id]) {
        state.dom[id] = document.getElementById(id);
    }
    return state.dom[id];
}

// Очистка кэша при необходимости
function clearDomCache() {
    state.dom = {};
}

// === API КЛИЕНТ ===
const api = {
    async request(endpoint, options = {}) {
        const headers = {
            'Content-Type': 'application/json',
            ...options.headers
        };
        
        if (state.token) {
            headers['Authorization'] = `Bearer ${state.token}`;
        }
        
        try {
            const response = await fetch(endpoint, { ...options, headers });
            
            if (response.status === 401) {
                // Токен истёк - выходим
                logout();
                throw new Error('Сессия истекла');
            }
            
            return response;
        } catch (error) {
            console.error('API Error:', error);
            throw error;
        }
    },
    
    async get(endpoint) {
        return this.request(endpoint);
    },
    
    async post(endpoint, data) {
        return this.request(endpoint, {
            method: 'POST',
            body: JSON.stringify(data)
        });
    },
    
    async put(endpoint, data) {
        return this.request(endpoint, {
            method: 'PUT',
            body: JSON.stringify(data)
        });
    },
    
    async uploadFile(endpoint, formData) {
        const headers = {};
        if (state.token) {
            headers['Authorization'] = `Bearer ${state.token}`;
        }
        
        return fetch(endpoint, {
            method: 'POST',
            headers,
            body: formData
        });
    }
};

// === CUSTOM CONFIRM DIALOG ===
function customConfirm({ title = 'Подтверждение', message = 'Вы уверены?', icon = '⚠️', variant = '', okText = 'Подтвердить', cancelText = 'Отмена' }) {
    return new Promise((resolve) => {
        const modal = document.getElementById('confirm-modal');
        const content = modal.querySelector('.confirm-modal-content');
        const iconEl = document.getElementById('confirm-icon');
        const titleEl = document.getElementById('confirm-title');
        const messageEl = document.getElementById('confirm-message');
        const okBtn = document.getElementById('confirm-ok');
        const cancelBtn = document.getElementById('confirm-cancel');
        
        // Устанавливаем контент
        iconEl.textContent = icon;
        titleEl.textContent = title;
        messageEl.textContent = message;
        okBtn.textContent = okText;
        cancelBtn.textContent = cancelText;
        
        // Устанавливаем вариант стиля
        content.className = 'confirm-modal-content';
        if (variant) content.classList.add(variant);
        
        // Показываем модалку
        modal.classList.remove('hidden');
        okBtn.focus();
        
        // Обработчики
        const cleanup = () => {
            modal.classList.add('hidden');
            okBtn.removeEventListener('click', handleOk);
            cancelBtn.removeEventListener('click', handleCancel);
            modal.querySelector('.modal-overlay').removeEventListener('click', handleCancel);
            document.removeEventListener('keydown', handleKeydown);
        };
        
        const handleOk = () => {
            cleanup();
            resolve(true);
        };
        
        const handleCancel = () => {
            cleanup();
            resolve(false);
        };
        
        const handleKeydown = (e) => {
            if (e.key === 'Escape') handleCancel();
            if (e.key === 'Enter') handleOk();
        };
        
        okBtn.addEventListener('click', handleOk);
        cancelBtn.addEventListener('click', handleCancel);
        modal.querySelector('.modal-overlay').addEventListener('click', handleCancel);
        document.addEventListener('keydown', handleKeydown);
    });
}

// === CUSTOM PROMPT DIALOG ===
function customPrompt({ title = 'Введите значение', message = '', icon = '✏️', variant = '', placeholder = '', defaultValue = '', okText = 'OK', cancelText = 'Отмена' }) {
    return new Promise((resolve) => {
        const modal = document.getElementById('prompt-modal');
        const content = modal.querySelector('.prompt-modal-content');
        const iconEl = document.getElementById('prompt-icon');
        const titleEl = document.getElementById('prompt-title');
        const messageEl = document.getElementById('prompt-message');
        const input = document.getElementById('prompt-input');
        const okBtn = document.getElementById('prompt-ok');
        const cancelBtn = document.getElementById('prompt-cancel');
        
        // Устанавливаем контент
        iconEl.textContent = icon;
        titleEl.textContent = title;
        messageEl.textContent = message;
        messageEl.style.display = message ? 'block' : 'none';
        input.placeholder = placeholder;
        input.value = defaultValue;
        okBtn.textContent = okText;
        cancelBtn.textContent = cancelText;
        
        // Устанавливаем вариант стиля
        content.className = 'prompt-modal-content';
        if (variant) content.classList.add(variant);
        
        // Показываем модалку
        modal.classList.remove('hidden');
        input.focus();
        input.select();
        
        // Обработчики
        const cleanup = () => {
            modal.classList.add('hidden');
            okBtn.removeEventListener('click', handleOk);
            cancelBtn.removeEventListener('click', handleCancel);
            modal.querySelector('.modal-overlay').removeEventListener('click', handleCancel);
            document.removeEventListener('keydown', handleKeydown);
        };
        
        const handleOk = () => {
            const value = input.value.trim();
            cleanup();
            resolve(value || null);
        };
        
        const handleCancel = () => {
            cleanup();
            resolve(null);
        };
        
        const handleKeydown = (e) => {
            if (e.key === 'Escape') handleCancel();
            if (e.key === 'Enter') handleOk();
        };
        
        okBtn.addEventListener('click', handleOk);
        cancelBtn.addEventListener('click', handleCancel);
        modal.querySelector('.modal-overlay').addEventListener('click', handleCancel);
        document.addEventListener('keydown', handleKeydown);
    });
}

// === SERVICE WORKER ===
async function registerServiceWorker() {
    if ('serviceWorker' in navigator && 'PushManager' in window) {
        try {
            state.swRegistration = await navigator.serviceWorker.register('/sw.js');
            console.log('Service Worker зарегистрирован');
            
            // Проверка обновлений SW
            state.swRegistration.addEventListener('updatefound', () => {
                const newWorker = state.swRegistration.installing;
                console.log('Найдено обновление Service Worker');
                
                newWorker.addEventListener('statechange', () => {
                    if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
                        // Новая версия готова, показываем уведомление
                        showUpdateNotification();
                    }
                });
            });
            
            // Обработка сообщений от Service Worker
            navigator.serviceWorker.addEventListener('message', (event) => {
                const data = event.data;
                
                // Уведомление о новой версии от SW
                if (data.type === 'sw-updated') {
                    console.log('SW обновлён до версии:', data.version);
                    showUpdateNotification();
                }
                
                if (data.type === 'call-answer-from-notification') {
                    // Пользователь ответил на звонок из уведомления
                    console.log('Answer call from notification:', data);
                    // Звонок уже должен быть в incomingCallData, просто принимаем
                    if (incomingCallData && incomingCallData.callId === data.callId) {
                        acceptCall();
                    }
                }
                
                if (data.type === 'call-declined-from-notification') {
                    // Пользователь отклонил звонок из уведомления
                    console.log('Decline call from notification:', data);
                    if (incomingCallData && incomingCallData.callId === data.callId) {
                        declineCall();
                    }
                }
                
                if (data.type === 'notification-click') {
                    // Открыть чат с отправителем
                    if (data.senderId) {
                        openChatWithUser(data.senderId);
                    }
                }
            });
            
            // Периодическая проверка обновлений (каждые 5 минут)
            setInterval(() => {
                state.swRegistration.update();
            }, 5 * 60 * 1000);
            
        } catch (e) {
            console.error('Ошибка регистрации SW:', e);
        }
    }
}

// Показать уведомление об обновлении
function showUpdateNotification() {
    // Проверяем, не показано ли уже
    if (document.getElementById('update-banner')) return;
    
    const banner = document.createElement('div');
    banner.id = 'update-banner';
    banner.className = 'update-banner';
    banner.innerHTML = `
        <div class="update-banner-content">
            <span class="update-icon">🔄</span>
            <span class="update-text">Доступна новая версия Квант!</span>
            <button class="update-btn" id="update-now-btn">Обновить</button>
            <button class="update-close" id="update-close-btn">✕</button>
        </div>
    `;
    document.body.appendChild(banner);
    
    // Анимация появления
    requestAnimationFrame(() => {
        banner.classList.add('show');
    });
    
    // Обработчики
    document.getElementById('update-now-btn').addEventListener('click', () => {
        applyUpdate();
    });
    
    document.getElementById('update-close-btn').addEventListener('click', () => {
        banner.classList.remove('show');
        setTimeout(() => banner.remove(), 300);
    });
}

// Применить обновление
function applyUpdate() {
    if (state.swRegistration && state.swRegistration.waiting) {
        // Говорим новому SW активироваться
        state.swRegistration.waiting.postMessage('skipWaiting');
    }
    // Перезагружаем страницу
    window.location.reload(true);
}

async function subscribeToPush() {
    if (!state.swRegistration || !state.currentUser) return;
    
    try {
        const res = await api.get('/api/vapid-public-key');
        if (!res.ok) return;
        
        const { publicKey } = await res.json();
        
        let subscription = await state.swRegistration.pushManager.getSubscription();
        
        if (!subscription) {
            subscription = await state.swRegistration.pushManager.subscribe({
                userVisibleOnly: true,
                applicationServerKey: urlBase64ToUint8Array(publicKey)
            });
        }
        
        await api.post('/api/push-subscribe', { subscription: subscription.toJSON() });
        console.log('Push подписка активирована');
    } catch (e) {
        console.error('Ошибка подписки на push:', e);
    }
}

function urlBase64ToUint8Array(base64String) {
    const padding = '='.repeat((4 - base64String.length % 4) % 4);
    const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
    const rawData = window.atob(base64);
    const outputArray = new Uint8Array(rawData.length);
    for (let i = 0; i < rawData.length; ++i) {
        outputArray[i] = rawData.charCodeAt(i);
    }
    return outputArray;
}

async function requestNotificationPermission() {
    if ('Notification' in window && Notification.permission === 'default') {
        const permission = await Notification.requestPermission();
        if (permission === 'granted') {
            await subscribeToPush();
        }
    } else if (Notification.permission === 'granted') {
        await subscribeToPush();
    }
}

function showNotification(title, body, onClick) {
    if (!state.notificationsEnabled) return;
    if ('Notification' in window && Notification.permission === 'granted') {
        const notification = new Notification(title, {
            body,
            icon: '/icon.png',
            badge: '/icon.png'
        });
        notification.onclick = () => {
            window.focus();
            if (onClick) onClick();
            notification.close();
        };
    }
}

// === SOCKET.IO ===
function initSocket() {
    if (state.socket) {
        state.socket.disconnect();
    }
    
    state.socket = io({
        auth: { token: state.token },
        reconnection: true,
        reconnectionDelay: 1000,
        reconnectionAttempts: 10
    });
    
    state.socket.on('connect', () => {
        console.log('Socket подключён');
        // Инициализируем события для групп/каналов/серверов
        initGroupChannelServerSockets();
    });
    
    state.socket.on('connect_error', (error) => {
        console.error('Socket ошибка:', error.message);
        if (error.message.includes('авторизация') || error.message.includes('токен')) {
            logout();
        }
    });
    
    // Throttled обновление онлайн-статусов (не чаще раза в 500ms)
    const throttledOnlineUpdate = throttle(() => {
        updateContactsList();
        updateChatStatus();
    }, 500);
    
    state.socket.on('online-users', (users) => {
        state.onlineUsers = users; // Теперь объект { odataId: status }
        throttledOnlineUpdate();
    });
    
    state.socket.on('message-sent', (message) => {
        appendMessage(message);
        updateContactsList();
    });
    
    state.socket.on('new-message', (message) => {
        // Проверяем не отключены ли уведомления от этого пользователя
        const isMuted = isUserMuted(message.sender_id);
        
        // Воспроизводим звук если не muted и это не наше сообщение
        if (!isMuted && message.sender_id !== state.currentUser.id) {
            ensureSoundsInitialized();
            sounds.playMessage?.();
        }
        
        // Проверяем, относится ли сообщение к текущему открытому чату
        const isCurrentChat = state.selectedUser && (
            message.sender_id === state.selectedUser.id || 
            message.receiver_id === state.selectedUser.id
        );
        
        if (isCurrentChat) {
            appendMessage(message);
            if (message.sender_id !== state.currentUser.id) {
                markAsRead();
            }
        } else if (!isMuted && message.sender_id !== state.currentUser.id) {
            // Показываем уведомление только если не muted и не наше сообщение
            const localNickname = getLocalNickname(message.sender_id);
            const senderName = localNickname || message.sender_name || 'Новое сообщение';
            showNotification(senderName, message.text, () => {
                openChatWithUser(message.sender_id);
            });
        }
        updateContactsList();
    });
    
    state.socket.on('user-typing', (data) => {
        const { userId, typing } = data;
        
        if (typing) {
            if (state.typingUsers.has(userId)) {
                clearTimeout(state.typingUsers.get(userId));
            }
            const timeout = setTimeout(() => {
                state.typingUsers.delete(userId);
                updateChatStatus();
            }, 3000);
            state.typingUsers.set(userId, timeout);
        } else {
            if (state.typingUsers.has(userId)) {
                clearTimeout(state.typingUsers.get(userId));
                state.typingUsers.delete(userId);
            }
        }
        updateChatStatus();
    });
    
    // Звонки
    state.socket.on('call-initiated', (data) => {
        console.log('📞 call-initiated:', data);
        currentCallId = data.callId;
        if (data.waitingForUser) {
            document.getElementById('call-status').textContent = 'Ожидание ответа...';
        }
    });
    
    state.socket.on('incoming-call', handleIncomingCall);
    state.socket.on('call-answered', handleCallAnswered);
    state.socket.on('call-declined', handleCallDeclined);
    state.socket.on('call-ended', handleCallEnded);
    state.socket.on('call-failed', handleCallFailed);
    state.socket.on('ice-candidate', handleIceCandidate);
    state.socket.on('call-message', handleCallMessage);
    state.socket.on('video-renegotiate', handleVideoRenegotiate);
    state.socket.on('video-renegotiate-answer', handleVideoRenegotiateAnswer);
    state.socket.on('screen-share-started', handleScreenShareStarted);
    state.socket.on('screen-share-stopped', handleScreenShareStopped);
    state.socket.on('video-state-changed', handleVideoStateChanged);
    
    // Редактирование и удаление сообщений
    state.socket.on('message-edited', (data) => {
        const msgEl = document.querySelector(`[data-message-id="${data.messageId}"]`);
        if (msgEl) {
            const bubble = msgEl.querySelector('.message-bubble');
            const timeEl = msgEl.querySelector('.message-time');
            if (bubble) bubble.textContent = data.text;
            if (timeEl && !timeEl.querySelector('.message-edited')) {
                timeEl.innerHTML += '<span class="message-edited">(ред.)</span>';
            }
        }
    });
    
    state.socket.on('message-deleted', (data) => {
        const msgEl = document.querySelector(`[data-message-id="${data.messageId}"]`);
        if (msgEl) {
            msgEl.style.animation = 'fadeOut 0.3s ease';
            setTimeout(() => msgEl.remove(), 300);
        }
    });
    
    // Реакции
    state.socket.on('reaction-added', (data) => {
        updateMessageReaction(data.messageId, data.emoji, data.odataId, true);
    });
    
    state.socket.on('reaction-removed', (data) => {
        updateMessageReaction(data.messageId, data.emoji, data.odataId, false);
    });
    
    state.socket.on('error', (error) => {
        console.error('Socket error:', error);
        showToast(error.message || 'Ошибка соединения', 'error');
    });
}

function updateMessageReaction(messageId, emoji, odataId, isAdd) {
    const msgEl = document.querySelector(`[data-message-id="${messageId}"]`);
    if (!msgEl) return;
    
    let reactionsDiv = msgEl.querySelector('.message-reactions');
    if (!reactionsDiv) {
        reactionsDiv = document.createElement('div');
        reactionsDiv.className = 'message-reactions';
        msgEl.querySelector('.message-content').appendChild(reactionsDiv);
    }
    
    let badge = reactionsDiv.querySelector(`[data-emoji="${emoji}"]`);
    
    if (isAdd) {
        if (badge) {
            const countEl = badge.querySelector('.reaction-count');
            countEl.textContent = parseInt(countEl.textContent) + 1;
            if (odataId === state.currentUser.id) badge.classList.add('own');
        } else {
            badge = document.createElement('span');
            badge.className = `reaction-badge ${odataId === state.currentUser.id ? 'own' : ''}`;
            badge.dataset.emoji = emoji;
            badge.dataset.messageId = messageId;
            badge.innerHTML = `${emoji}<span class="reaction-count">1</span>`;
            badge.addEventListener('click', () => toggleReaction(messageId, emoji));
            reactionsDiv.appendChild(badge);
        }
    } else {
        if (badge) {
            const countEl = badge.querySelector('.reaction-count');
            const newCount = parseInt(countEl.textContent) - 1;
            if (newCount <= 0) {
                badge.remove();
            } else {
                countEl.textContent = newCount;
                if (odataId === state.currentUser.id) badge.classList.remove('own');
            }
        }
    }
}

function toggleReaction(messageId, emoji) {
    const badge = document.querySelector(`[data-message-id="${messageId}"] .reaction-badge[data-emoji="${emoji}"]`);
    const isOwn = badge?.classList.contains('own');
    
    if (isOwn) {
        state.socket.emit('remove-reaction', { messageId, emoji, receiverId: state.selectedUser.id });
    } else {
        state.socket.emit('add-reaction', { messageId, emoji, receiverId: state.selectedUser.id });
    }
}

// === АУТЕНТИФИКАЦИЯ ===
async function login(username, password) {
    try {
        const res = await fetch('/api/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password })
        });
        
        const data = await res.json();
        
        if (data.success) {
            state.currentUser = data.user;
            state.token = data.token;
            
            localStorage.setItem('kvant_user', JSON.stringify(data.user));
            localStorage.setItem('kvant_token', data.token);
            
            showChat();
            return { success: true };
        } else {
            return { success: false, error: data.error };
        }
    } catch (error) {
        console.error('Login error:', error);
        return { success: false, error: 'Ошибка сети' };
    }
}

async function register(username, password) {
    try {
        const res = await fetch('/api/register', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password })
        });
        
        return await res.json();
    } catch (error) {
        console.error('Register error:', error);
        return { success: false, error: 'Ошибка сети' };
    }
}

function logout() {
    state.currentUser = null;
    state.currentUserProfile = null;
    state.selectedUser = null;
    state.token = null;
    
    localStorage.removeItem('kvant_user');
    localStorage.removeItem('kvant_token');
    
    if (state.socket) {
        state.socket.disconnect();
        state.socket = null;
    }
    
    // Сбрасываем стили пузырей (убираем Premium+ стили)
    document.querySelectorAll('.message').forEach(msg => {
        msg.classList.forEach(cls => {
            if (cls.startsWith('bubble-')) {
                msg.classList.remove(cls);
            }
        });
    });
    
    document.getElementById('settings-modal')?.classList.add('hidden');
    document.getElementById('chat-screen').classList.add('hidden');
    document.getElementById('login-screen').classList.remove('hidden');
    
    document.getElementById('login-username').value = '';
    document.getElementById('login-password').value = '';
    document.getElementById('messages').innerHTML = '';
}

// === ИНИЦИАЛИЗАЦИЯ ===
function restoreSession() {
    const savedUser = localStorage.getItem('kvant_user');
    const savedToken = localStorage.getItem('kvant_token');
    
    if (savedUser && savedToken) {
        try {
            state.currentUser = JSON.parse(savedUser);
            state.token = savedToken;
            return true;
        } catch {
            localStorage.removeItem('kvant_user');
            localStorage.removeItem('kvant_token');
        }
    }
    return false;
}

async function showChat() {
    const loginScreen = document.getElementById('login-screen');
    const registerScreen = document.getElementById('register-screen');
    const chatScreen = document.getElementById('chat-screen');
    
    // Анимация исчезновения экрана входа
    const activeAuthScreen = !loginScreen.classList.contains('hidden') ? loginScreen : registerScreen;
    activeAuthScreen.classList.add('fade-out');
    
    // Ждём завершения анимации исчезновения
    await new Promise(resolve => setTimeout(resolve, 400));
    
    loginScreen.classList.add('hidden');
    registerScreen.classList.add('hidden');
    activeAuthScreen.classList.remove('fade-out');
    
    // Показываем чат с анимацией элементов
    chatScreen.classList.remove('hidden');
    chatScreen.classList.add('animate-in');
    
    // Убираем класс анимации после завершения всех анимаций
    setTimeout(() => {
        chatScreen.classList.remove('animate-in');
    }, 1000);
    
    const initial = state.currentUser.username[0].toUpperCase();
    document.getElementById('current-user-avatar').textContent = initial;
    document.querySelector('.current-user').textContent = state.currentUser.username;
    
    initSocket();
    
    // Отправляем сохранённый статус на сервер после подключения
    setTimeout(() => {
        if (state.socket && state.userStatus) {
            state.socket.emit('status-change', { status: state.userStatus });
        }
    }, 500);
    
    await loadMyProfile();
    await loadContacts();
    await loadGroups();
    await loadChannels();
    await loadServers();
    await loadSettingsFromServer();
    requestNotificationPermission();
    applySettings();
    
    // Обработка инвайт-ссылок после загрузки
    handleInviteLink();
    
    // Проверяем сохранённый инвайт (если был до авторизации)
    checkPendingInvite();
}

// Загрузка настроек с сервера
async function loadSettingsFromServer() {
    try {
        const res = await fetch('/api/settings', {
            headers: { 'Authorization': `Bearer ${state.token}` }
        });
        if (res.ok) {
            const serverSettings = await res.json();
            // Сохраняем локальные настройки (звук, громкость)
            const localSounds = state.settings.sounds;
            const localVolume = state.settings.volume;
            // Мержим серверные настройки с локальными
            state.settings = { ...state.settings, ...serverSettings };
            // Восстанавливаем локальные настройки
            if (localSounds !== undefined) state.settings.sounds = localSounds;
            if (localVolume !== undefined) state.settings.volume = localVolume;
            localStorage.setItem('kvant_settings', JSON.stringify(state.settings));
        }
    } catch (e) {
        console.log('Failed to load settings from server:', e);
    }
}

// === КОНТАКТЫ ===
async function loadContacts() {
    try {
        const res = await api.get(`/api/contacts/${state.currentUser.id}`);
        if (!res.ok) throw new Error('Ошибка загрузки');
        
        const contacts = await res.json();
        renderUsers(contacts);
    } catch (e) {
        console.error('Ошибка загрузки контактов:', e);
        document.getElementById('users-list').innerHTML = 
            '<div class="empty-list">Ошибка загрузки</div>';
    }
}

// === ГРУППЫ ===
async function loadGroups() {
    try {
        const res = await api.get('/api/groups');
        if (!res.ok) throw new Error('Ошибка загрузки');
        state.groups = await res.json();
        renderGroups();
    } catch (e) {
        console.error('Ошибка загрузки групп:', e);
    }
}

function renderGroups() {
    const list = document.getElementById('groups-list');
    if (!list) return;
    
    if (state.groups.length === 0) {
        list.innerHTML = `
            <div class="empty-tab">
                <div class="empty-tab-icon"><img src="/assets/group.svg" class="icon-xl"></div>
                <div class="empty-tab-text">У вас пока нет групп. Создайте первую!</div>
            </div>`;
        return;
    }
    
    list.innerHTML = state.groups.map(g => `
        <div class="group-item ${state.selectedGroup?.id === g.id ? 'active' : ''}" data-group-id="${g.id}">
            <div class="group-avatar">${g.avatar_url ? `<img src="${g.avatar_url}">` : '<img src="/assets/group.svg" class="icon">'}</div>
            <div class="group-info">
                <div class="group-name">${escapeHtml(g.name)}</div>
                <div class="group-members-count">${g.member_count || 0} участников</div>
            </div>
        </div>
    `).join('');
    
    list.querySelectorAll('.group-item').forEach(el => {
        el.addEventListener('click', () => selectGroup(el.dataset.groupId));
    });
}

async function selectGroup(groupId) {
    const group = state.groups.find(g => g.id === groupId);
    if (!group) return;
    
    state.selectedGroup = group;
    state.selectedUser = null;
    state.selectedChannel = null;
    state.selectedServer = null;
    state.selectedServerChannel = null;
    
    // Присоединяемся к комнате группы
    state.socket?.emit('join-group', groupId);
    
    // Обновляем UI списка
    document.querySelectorAll('.group-item').forEach(i => i.classList.remove('active'));
    document.querySelector(`[data-group-id="${groupId}"]`)?.classList.add('active');
    
    // Обновляем UI
    renderGroups();
    updateChatHeader(group.name, `${group.member_count || 0} участников`, group.avatar_url);
    await loadGroupMessages(groupId);
    
    // Включаем инпут
    document.getElementById('message-input').disabled = false;
    document.getElementById('message-input').placeholder = 'Сообщение...';
    document.querySelector('.send-btn').disabled = false;
    
    handleMobileAfterSelect();
}

async function loadGroupMessages(groupId) {
    try {
        const res = await api.get(`/api/groups/${groupId}/messages`);
        if (!res.ok) throw new Error('Ошибка загрузки');
        const messages = await res.json();
        renderGroupMessages(messages);
    } catch (e) {
        console.error('Ошибка загрузки сообщений группы:', e);
    }
}

function renderGroupMessages(messages) {
    const container = getEl('messages');
    container.innerHTML = '';
    
    messages.forEach(msg => {
        const isSent = msg.sender_id === state.currentUser.id;
        const div = document.createElement('div');
        div.className = `message ${isSent ? 'sent' : 'received'}`;
        div.dataset.messageId = msg.id;
        
        div.innerHTML = `
            <div class="message-sender-info">
                <span class="message-sender-name" style="color: ${getNameColor(msg)}">${escapeHtml(msg.display_name || msg.username)}</span>
            </div>
            <div class="message-content">
                <div class="message-bubble">${escapeHtml(msg.text)}</div>
                <div class="message-time">${formatTime(msg.created_at)}</div>
            </div>
        `;
        container.appendChild(div);
    });
    
    container.scrollTop = container.scrollHeight;
}

// === КАНАЛЫ ===
async function loadChannels() {
    try {
        const res = await api.get('/api/channels');
        if (!res.ok) throw new Error('Ошибка загрузки');
        state.channels = await res.json();
        renderChannels();
    } catch (e) {
        console.error('Ошибка загрузки каналов:', e);
    }
}

function renderChannels() {
    const list = document.getElementById('channels-list');
    if (!list) return;
    
    if (state.channels.length === 0) {
        list.innerHTML = `
            <div class="empty-tab">
                <div class="empty-tab-icon"><img src="/assets/megaphone.svg" class="icon-xl"></div>
                <div class="empty-tab-text">У вас пока нет каналов. Создайте или подпишитесь!</div>
            </div>`;
        return;
    }
    
    list.innerHTML = state.channels.map(c => `
        <div class="channel-item ${state.selectedChannel?.id === c.id ? 'active' : ''}" data-channel-id="${c.id}">
            <div class="channel-avatar">${c.avatar_url ? `<img src="${c.avatar_url}">` : '<img src="/assets/megaphone.svg" class="icon">'}</div>
            <div class="channel-info">
                <div class="channel-name">${escapeHtml(c.name)}</div>
                <div class="channel-subscribers">${c.subscriber_count || 0} подписчиков</div>
            </div>
        </div>
    `).join('');
    
    list.querySelectorAll('.channel-item').forEach(el => {
        el.addEventListener('click', () => selectChannel(el.dataset.channelId));
        el.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            showChannelContextMenu(e, el.dataset.channelId);
        });
    });
}

// Контекстное меню для канала (Telegram-style)
function showChannelContextMenu(e, channelId) {
    hideAllContextMenus();
    
    const channel = state.channels.find(c => c.id === channelId);
    if (!channel) return;
    
    const isOwner = channel.owner_id === state.currentUser?.id;
    
    const menu = document.createElement('div');
    menu.className = 'context-menu channel-context-menu';
    menu.innerHTML = `
        <div class="context-menu-item" data-action="copy-link">
            <img src="/assets/copy.svg" class="icon-sm"> Скопировать ссылку
        </div>
        ${isOwner ? `
        <div class="context-menu-item danger" data-action="leave">
            <img src="/assets/Right-from-bracket.svg" class="icon-sm"> Удалить канал
        </div>
        ` : `
        <div class="context-menu-item danger" data-action="leave">
            <img src="/assets/Right-from-bracket.svg" class="icon-sm"> Отписаться
        </div>
        `}
    `;
    
    document.body.appendChild(menu);
    positionContextMenu(menu, e.clientX, e.clientY);
    
    menu.querySelectorAll('.context-menu-item').forEach(item => {
        item.addEventListener('click', async () => {
            const action = item.dataset.action;
            
            switch (action) {
                case 'copy-link':
                    const link = `${window.location.origin}/invite/channel/${channelId}`;
                    navigator.clipboard.writeText(link).then(() => {
                        showToast('Ссылка скопирована!');
                    }).catch(() => {
                        showToast('Не удалось скопировать ссылку', 'error');
                    });
                    break;
                case 'leave':
                    if (isOwner) {
                        const confirmed = await customConfirm({
                            title: 'Удалить канал?',
                            message: 'Канал будет удалён навсегда. Это действие нельзя отменить.',
                            icon: '🗑️',
                            variant: 'danger',
                            okText: 'Удалить',
                            cancelText: 'Отмена'
                        });
                        if (confirmed) {
                            // TODO: Добавить API удаления канала
                            showToast('Удаление канала в разработке', 'info');
                        }
                    } else {
                        const confirmed = await customConfirm({
                            title: 'Отписаться от канала?',
                            message: `Вы уверены, что хотите отписаться от "${channel.name}"?`,
                            icon: '📢',
                            okText: 'Отписаться',
                            cancelText: 'Отмена'
                        });
                        if (confirmed) {
                            try {
                                const res = await api.post(`/api/channels/${channelId}/unsubscribe`);
                                if (res.ok) {
                                    showToast('Вы отписались от канала');
                                    await loadChannels();
                                    if (state.selectedChannel?.id === channelId) {
                                        state.selectedChannel = null;
                                        document.getElementById('messages').innerHTML = '';
                                    }
                                }
                            } catch (err) {
                                showToast('Ошибка отписки', 'error');
                            }
                        }
                    }
                    break;
            }
            
            menu.remove();
        });
    });
    
    // Закрытие по клику вне меню
    setTimeout(() => {
        document.addEventListener('click', function closeMenu(e) {
            if (!menu.contains(e.target)) {
                menu.remove();
                document.removeEventListener('click', closeMenu);
            }
        });
    }, 0);
}

async function selectChannel(channelId) {
    const channel = state.channels.find(c => c.id === channelId);
    if (!channel) return;
    
    state.selectedChannel = channel;
    state.selectedUser = null;
    state.selectedGroup = null;
    state.selectedServer = null;
    state.selectedServerChannel = null;
    
    state.socket?.emit('join-channel', channelId);
    
    // Обновляем UI списка
    document.querySelectorAll('.channel-item').forEach(i => i.classList.remove('active'));
    document.querySelector(`[data-channel-id="${channelId}"]`)?.classList.add('active');
    
    renderChannels();
    updateChatHeader(channel.name, `${channel.subscriber_count || 0} подписчиков`, channel.avatar_url);
    await loadChannelPosts(channelId);
    
    // Включаем инпут (только для админов канала можно постить)
    const isAdmin = channel.owner_id === state.currentUser?.id;
    document.getElementById('message-input').disabled = !isAdmin;
    document.getElementById('message-input').placeholder = isAdmin ? 'Написать пост...' : 'Только админы могут постить';
    document.querySelector('.send-btn').disabled = !isAdmin;
    
    handleMobileAfterSelect();
}

async function loadChannelPosts(channelId) {
    try {
        const res = await api.get(`/api/channels/${channelId}/posts`);
        if (!res.ok) throw new Error('Ошибка загрузки');
        const posts = await res.json();
        renderChannelPosts(posts);
    } catch (e) {
        console.error('Ошибка загрузки постов канала:', e);
    }
}

function renderChannelPosts(posts) {
    const container = getEl('messages');
    container.innerHTML = '';
    
    posts.forEach(post => {
        const div = document.createElement('div');
        const isOwn = post.author_id === state.currentUser?.id;
        div.className = `message channel-post ${isOwn ? 'sent' : 'received'}`;
        div.dataset.postId = post.id;
        
        let content = '';
        if (post.media_url) {
            if (post.media_type === 'image') {
                content += `<img src="${escapeAttr(post.media_url)}" class="message-media" alt="Изображение">`;
            } else if (post.media_type === 'video') {
                content += `<video src="${escapeAttr(post.media_url)}" class="message-media" controls></video>`;
            }
        }
        if (post.text) {
            content += `<div class="message-bubble">${escapeHtml(post.text)}</div>`;
        }
        
        div.innerHTML = `
            <div class="message-content">
                ${content}
                <div class="message-time">${formatTime(post.created_at)} · 👁 ${post.views || 0}</div>
            </div>
        `;
        container.appendChild(div);
    });
    
    container.scrollTop = container.scrollHeight;
}

// === СЕРВЕРЫ ===
async function loadServers() {
    try {
        const res = await api.get('/api/servers');
        if (!res.ok) throw new Error('Ошибка загрузки');
        state.servers = await res.json();
        renderServers();
    } catch (e) {
        console.error('Ошибка загрузки серверов:', e);
    }
}

function renderServers() {
    const list = document.getElementById('servers-list');
    if (!list) return;
    
    if (state.servers.length === 0) {
        list.innerHTML = `
            <div class="empty-tab">
                <div class="empty-tab-icon"><img src="/assets/Castle.svg" class="icon-xl"></div>
                <div class="empty-tab-text">У вас пока нет серверов. Создайте или присоединитесь!</div>
            </div>`;
        return;
    }
    
    list.innerHTML = state.servers.map(s => `
        <div class="server-item ${state.selectedServer?.id === s.id ? 'active' : ''}" data-server-id="${s.id}">
            <div class="server-icon">${s.icon_url ? `<img src="${s.icon_url}">` : '<img src="/assets/Castle.svg" class="icon">'}</div>
            <div class="server-info">
                <div class="server-name">${escapeHtml(s.name)}</div>
                <div class="server-members">${s.member_count || 0} участников</div>
            </div>
        </div>
    `).join('');
    
    list.querySelectorAll('.server-item').forEach(el => {
        el.addEventListener('click', () => selectServer(el.dataset.serverId));
    });
}

async function selectServer(serverId) {
    const server = state.servers.find(s => s.id === serverId);
    if (!server) return;
    
    state.selectedServer = server;
    state.selectedUser = null;
    state.selectedGroup = null;
    state.selectedChannel = null;
    state.selectedServerChannel = null;
    
    state.socket?.emit('join-server', serverId);
    
    // Обновляем UI списка
    document.querySelectorAll('.server-item').forEach(i => i.classList.remove('active'));
    document.querySelector(`[data-server-id="${serverId}"]`)?.classList.add('active');
    
    // Показываем панель каналов сервера
    await showServerChannelsPanel(server);
}

async function showServerChannelsPanel(server) {
    const container = document.getElementById('sidebar-lists-container');
    const nameEl = document.getElementById('server-panel-name');
    const metaEl = document.getElementById('server-panel-meta');
    const menuBtn = document.getElementById('server-panel-menu');
    
    // Заполняем хедер
    nameEl.textContent = server.name;
    metaEl.textContent = `${server.member_count || 0} участников`;
    
    // Проверяем права (владелец или админ)
    const isOwner = server.owner_id === state.currentUser.id;
    const isAdmin = state.currentUser.role === 'admin';
    const canManage = isOwner || isAdmin;
    
    // Показываем/скрываем кнопку меню
    menuBtn.style.display = canManage ? 'flex' : 'none';
    
    // Загружаем каналы
    try {
        const res = await api.get(`/api/servers/${server.id}/channels`);
        const data = await res.json();
        renderServerChannels(data.categories || [], data.channels || [], canManage);
    } catch (e) {
        console.error('Error loading server channels:', e);
    }
    
    // Показываем панель с анимацией слайда
    container.classList.add('server-open');
}

function renderServerChannels(categories, channels, canManage) {
    const list = document.getElementById('server-channels-list');
    
    // Группируем каналы по категориям
    const uncategorized = channels.filter(c => !c.category_id);
    const categorized = {};
    
    categories.forEach(cat => {
        categorized[cat.id] = {
            ...cat,
            channels: channels.filter(c => c.category_id === cat.id)
        };
    });
    
    let html = '';
    
    // Каналы без категории
    if (uncategorized.length > 0) {
        html += uncategorized.map(ch => renderServerChannelItem(ch, canManage)).join('');
    }
    
    // Категории с каналами
    Object.values(categorized).forEach(cat => {
        html += `
            <div class="server-category" data-category-id="${cat.id}">
                <div class="server-category-header">
                    <span class="server-category-arrow">▼</span>
                    <span class="server-category-name">${escapeHtml(cat.name)}</span>
                    ${canManage ? `<button class="server-category-add" data-category-id="${cat.id}" title="Создать канал"><img src="/assets/Plus.svg" class="icon-xs"></button>` : ''}
                </div>
                <div class="server-category-channels">
                    ${cat.channels.map(ch => renderServerChannelItem(ch, canManage)).join('')}
                </div>
            </div>
        `;
    });
    
    if (!html) {
        html = '<div class="empty-list">Нет каналов</div>';
    }
    
    list.innerHTML = html;
    
    // Обработчики кликов на каналы
    list.querySelectorAll('.server-channel-item').forEach(el => {
        el.addEventListener('click', (e) => {
            if (e.target.closest('.server-category-add') || e.target.closest('.server-channel-settings')) return;
            selectServerChannel(el.dataset.channelId);
        });
        
        // Контекстное меню для каналов
        el.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            showServerChannelContextMenu(e, el.dataset.channelId, canManage);
        });
    });
    
    // Кнопки настроек каналов
    list.querySelectorAll('.server-channel-settings').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            openChannelSettingsModal(btn.dataset.channelId);
        });
    });
    
    // Сворачивание категорий (клик на стрелку или название)
    list.querySelectorAll('.server-category-header').forEach(el => {
        el.addEventListener('click', (e) => {
            if (e.target.closest('.server-category-add')) return;
            el.closest('.server-category').classList.toggle('collapsed');
        });
        
        // Контекстное меню для категорий
        if (canManage) {
            el.addEventListener('contextmenu', (e) => {
                e.preventDefault();
                e.stopPropagation();
                const categoryId = el.closest('.server-category').dataset.categoryId;
                showServerCategoryContextMenu(e, categoryId);
            });
        }
    });
    
    // Кнопки добавления канала в категорию
    list.querySelectorAll('.server-category-add').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            openCreateServerChannelModal(btn.dataset.categoryId);
        });
    });
    
    // Контекстное меню на пустом месте списка или на самом списке
    if (canManage) {
        list.addEventListener('contextmenu', (e) => {
            // Если клик не на канале и не на категории - показываем меню создания
            const isOnChannel = e.target.closest('.server-channel-item');
            const isOnCategory = e.target.closest('.server-category-header');
            
            if (!isOnChannel && !isOnCategory) {
                e.preventDefault();
                showServerListContextMenu(e);
            }
        });
    }
}

function renderServerChannelItem(channel, canManage) {
    const icon = channel.type === 'voice' ? '🔊' : '#';
    const isActive = state.selectedServerChannel?.id === channel.id;
    
    return `
        <div class="server-channel-item ${isActive ? 'active' : ''}" data-channel-id="${channel.id}" data-channel-type="${channel.type}">
            <span class="server-channel-icon">${icon}</span>
            <span class="server-channel-name">${escapeHtml(channel.name)}</span>
            ${canManage ? `<button class="server-channel-settings" data-channel-id="${channel.id}" title="Настройки"><img src="/assets/settings.svg" class="icon-xs"></button>` : ''}
        </div>
    `;
}

async function selectServerChannel(channelId) {
    if (!state.selectedServer) return;
    
    const res = await api.get(`/api/servers/${state.selectedServer.id}/channels`);
    const data = await res.json();
    const channel = data.channels?.find(c => c.id === channelId);
    
    if (!channel) return;
    
    // Для голосового канала — подключаемся к войсу, но не меняем чат
    if (channel.type === 'voice') {
        // Сохраняем информацию о голосовом подключении
        state.voiceConnection = {
            type: 'server',
            serverId: state.selectedServer.id,
            serverName: state.selectedServer.name,
            serverIcon: state.selectedServer.icon_url,
            channelId: channelId,
            channelName: channel.name,
            status: 'connecting'
        };
        
        state.socket?.emit('join-voice-channel', { serverId: state.selectedServer.id, channelId });
        
        // Обновляем UI — показываем что мы в голосовом канале
        document.querySelectorAll('.server-channel-item').forEach(i => i.classList.remove('in-voice'));
        document.querySelector(`[data-channel-id="${channelId}"]`)?.classList.add('in-voice');
        
        // Показываем voice connection pill
        showVoiceConnectionPill();
        
        // Имитируем подключение (TODO: реальный WebRTC)
        setTimeout(() => {
            if (state.voiceConnection?.channelId === channelId) {
                state.voiceConnection.status = 'connected';
                updateVoiceConnectionPill();
            }
        }, 1500);
        
        return;
    }
    
    // Для текстового канала — обычное поведение
    state.selectedServerChannel = channel;
    state.socket?.emit('join-server-channel', channelId);
    
    // Сбрасываем выбранного пользователя/группу при переходе в текстовый канал сервера
    state.selectedUser = null;
    state.selectedGroup = null;
    state.selectedChannel = null;
    
    // Обновляем UI
    document.querySelectorAll('.server-channel-item').forEach(i => i.classList.remove('active'));
    document.querySelector(`[data-channel-id="${channelId}"]`)?.classList.add('active');
    
    // Обновляем хедер чата
    const serverName = state.selectedServer.name;
    updateChatHeader(`${serverName} / #${channel.name}`, channel.topic || '', null);
    
    // Загружаем сообщения
    await loadServerChannelMessages(channelId);
    
    // Включаем инпут
    const messageInput = document.getElementById('message-input');
    const sendBtn = document.querySelector('.send-btn');
    messageInput.disabled = false;
    messageInput.placeholder = `Сообщение в #${channel.name}`;
    sendBtn.disabled = false;
    
    handleMobileAfterSelect();
}

async function loadServerChannelMessages(channelId) {
    try {
        const res = await api.get(`/api/server-channels/${channelId}/messages`);
        const messages = await res.json();
        
        const messagesEl = getEl('messages');
        if (!messagesEl) return;
        
        if (messages.length === 0) {
            messagesEl.innerHTML = '<div class="empty-list">Начните общение!</div>';
            return;
        }
        
        messagesEl.innerHTML = messages.map(msg => renderServerMessage(msg)).join('');
        messagesEl.scrollTop = messagesEl.scrollHeight;
    } catch (e) {
        console.error('Error loading server messages:', e);
    }
}

function renderServerMessage(msg) {
    const isMine = msg.sender_id === state.currentUser.id;
    const time = new Date(msg.created_at).toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit' });
    const avatar = msg.avatar_url 
        ? `<img src="${msg.avatar_url}" style="width:100%;height:100%;object-fit:cover;border-radius:50%">`
        : (msg.username?.[0]?.toUpperCase() || '?');
    
    return `
        <div class="message ${isMine ? 'sent' : 'received'}" data-message-id="${msg.id}">
            <div class="message-avatar" style="background: ${getNameColor(msg)}">${avatar}</div>
            <div class="message-content">
                <div class="message-sender" style="color: ${getNameColor(msg)}">${msg.display_name || msg.username}</div>
                <div class="message-bubble">${escapeHtml(msg.text || '')}</div>
                <div class="message-time">${time}</div>
            </div>
        </div>
    `;
}

function hideServerChannelsPanel() {
    const container = document.getElementById('sidebar-lists-container');
    container.classList.remove('server-open');
    
    state.selectedServer = null;
    state.selectedServerChannel = null;
    
    // Очищаем хедер
    updateChatHeader('Выберите чат', '', null);
    
    // Отключаем инпут
    document.getElementById('message-input').disabled = true;
    document.getElementById('message-input').placeholder = 'Выберите чат...';
    document.querySelector('.send-btn').disabled = true;
}

// === VOICE CONNECTION PILL (in header) ===
function showVoiceConnectionPill() {
    const pill = document.getElementById('voice-connection-pill');
    if (!pill || !state.voiceConnection) return;
    
    // Сначала убираем hidden и добавляем connecting
    pill.classList.remove('hidden');
    pill.classList.add('connecting');
    
    // Небольшая задержка для запуска анимации
    requestAnimationFrame(() => {
        pill.classList.add('visible');
    });
    
    updateVoiceConnectionPill();
}

function updateVoiceConnectionPill() {
    const pill = document.getElementById('voice-connection-pill');
    if (!pill || !state.voiceConnection) return;
    
    const avatarEl = document.getElementById('voice-pill-avatar');
    const nameEl = document.getElementById('voice-pill-name');
    const statusEl = document.getElementById('voice-pill-status');
    
    const vc = state.voiceConnection;
    
    // Аватар
    if (avatarEl) {
        if (vc.type === 'server' && vc.serverIcon) {
            avatarEl.style.backgroundImage = `url(${vc.serverIcon})`;
            avatarEl.textContent = '';
        } else if (vc.type === 'call' && vc.userAvatar) {
            avatarEl.style.backgroundImage = `url(${vc.userAvatar})`;
            avatarEl.textContent = '';
        } else {
            avatarEl.style.backgroundImage = '';
            avatarEl.textContent = vc.type === 'server' ? '🔊' : '📞';
        }
    }
    
    // Название
    if (nameEl) {
        if (vc.type === 'server') {
            nameEl.textContent = vc.channelName;
        } else {
            nameEl.textContent = vc.userName || 'Звонок';
        }
    }
    
    // Статус
    if (statusEl) {
        statusEl.className = 'voice-pill-status';
        
        // Убираем старые классы статуса с pill
        pill.classList.remove('connecting', 'connected');
        
        switch (vc.status) {
            case 'connecting':
                statusEl.textContent = 'Подключение...';
                statusEl.classList.add('connecting');
                pill.classList.add('connecting');
                break;
            case 'connected':
                statusEl.textContent = 'Подключено';
                statusEl.classList.add('connected');
                pill.classList.add('connected');
                break;
            case 'reconnecting':
                statusEl.textContent = 'Переподключение...';
                statusEl.classList.add('connecting');
                pill.classList.add('connecting');
                break;
            default:
                statusEl.textContent = vc.status || '';
        }
    }
}

function hideVoiceConnectionPill() {
    const pill = document.getElementById('voice-connection-pill');
    if (!pill) return;
    
    // Анимация скрытия
    pill.classList.remove('visible', 'connecting', 'connected');
    pill.classList.add('hidden');
}

function disconnectVoiceChannel() {
    if (!state.voiceConnection) return;
    
    const vc = state.voiceConnection;
    
    if (vc.type === 'server') {
        state.socket?.emit('leave-voice-channel', { serverId: vc.serverId, channelId: vc.channelId });
        
        // Убираем индикатор с канала
        document.querySelectorAll('.server-channel-item').forEach(i => i.classList.remove('in-voice'));
        
        showToast('Отключено от голосового канала');
    } else if (vc.type === 'call') {
        // Завершаем звонок
        endCall();
    }
    
    state.voiceConnection = null;
    hideVoiceConnectionPill();
}

function initVoiceConnectionPill() {
    // Кнопка отключения в voice pill
    document.getElementById('voice-pill-disconnect')?.addEventListener('click', disconnectVoiceChannel);
    
    // Кнопки мута/deafen в сайдбаре
    document.getElementById('panel-mute-btn')?.addEventListener('click', toggleVoiceMute);
    document.getElementById('panel-deafen-btn')?.addEventListener('click', toggleVoiceDeafen);
}

function toggleVoiceMute() {
    // Работает даже без активного голосового подключения (для будущих звонков)
    state.micMuted = !state.micMuted;
    
    const btn = document.getElementById('panel-mute-btn');
    const icon = btn?.querySelector('img');
    
    if (state.micMuted) {
        btn?.classList.add('muted');
        if (icon) icon.src = '/assets/Block-microphone.svg';
        showToast('Микрофон выключен');
    } else {
        btn?.classList.remove('muted');
        if (icon) icon.src = '/assets/microphone.svg';
        showToast('Микрофон включён');
    }
    
    // Если есть активное подключение — отправляем на сервер
    if (state.voiceConnection) {
        state.socket?.emit('voice-mute', { 
            channelId: state.voiceConnection.channelId, 
            muted: state.micMuted 
        });
    }
}

function toggleVoiceDeafen() {
    state.deafened = !state.deafened;
    
    const btn = document.getElementById('panel-deafen-btn');
    const muteBtn = document.getElementById('panel-mute-btn');
    const muteIcon = muteBtn?.querySelector('img');
    
    if (state.deafened) {
        btn?.classList.add('muted');
        showToast('Звук выключен');
        
        // Запоминаем был ли микрофон выключен ДО deafen
        state.mutedBeforeDeafen = state.micMuted;
        
        // Если deafen — мутим микрофон тоже (если ещё не замучен)
        if (!state.micMuted) {
            state.micMuted = true;
            muteBtn?.classList.add('muted');
            if (muteIcon) muteIcon.src = '/assets/Block-microphone.svg';
        }
    } else {
        btn?.classList.remove('muted');
        showToast('Звук включён');
        
        // Если микрофон был выключен только из-за deafen — включаем обратно
        if (!state.mutedBeforeDeafen && state.micMuted) {
            state.micMuted = false;
            muteBtn?.classList.remove('muted');
            if (muteIcon) muteIcon.src = '/assets/microphone.svg';
        }
    }
    
    // Если есть активное подключение — отправляем на сервер
    if (state.voiceConnection) {
        state.socket?.emit('voice-deafen', { 
            channelId: state.voiceConnection.channelId, 
            deafened: state.deafened,
            muted: state.micMuted
        });
    }
}

function updateChatHeader(name, subtitle, avatarUrl) {
    const header = document.querySelector('.chat-header');
    if (!header) return;
    
    const avatarEl = header.querySelector('.chat-header-avatar');
    const nameEl = header.querySelector('.chat-user-name');
    const statusEl = header.querySelector('.chat-user-status');
    
    if (avatarEl) {
        // Очищаем backgroundImage от предыдущего чата
        avatarEl.style.backgroundImage = '';
        avatarEl.innerHTML = avatarUrl ? `<img src="${avatarUrl}">` : name[0]?.toUpperCase() || '?';
    }
    if (nameEl) nameEl.textContent = name;
    if (statusEl) statusEl.textContent = subtitle;
    
    // Включаем инпут для ввода сообщений
    const messageInput = getEl('message-input');
    const sendBtn = document.querySelector('.send-btn');
    if (messageInput) messageInput.disabled = false;
    if (sendBtn) sendBtn.disabled = false;
}

function getNameColor(msg) {
    // Простая функция для цвета имени в группе
    const colors = ['#4fc3f7', '#81c784', '#ffb74d', '#f06292', '#ba68c8', '#4dd0e1'];
    const hash = msg.sender_id.split('').reduce((a, c) => a + c.charCodeAt(0), 0);
    return colors[hash % colors.length];
}

async function searchUsers(query) {
    if (!query) {
        loadContacts();
        return;
    }
    
    try {
        const res = await api.get(`/api/users?search=${encodeURIComponent(query)}`);
        if (!res.ok) throw new Error('Ошибка поиска');
        
        const users = await res.json();
        const filtered = users.filter(u => u.id !== state.currentUser.id);
        
        if (filtered.length === 0) {
            document.getElementById('users-list').innerHTML = 
                '<div class="empty-list">Пользователи не найдены</div>';
        } else {
            renderUsers(filtered);
        }
    } catch (e) {
        console.error('Ошибка поиска:', e);
    }
}

// Debounced версия для предотвращения частых обновлений
const updateContactsList = debounce(() => {
    const query = document.querySelector('.search-input')?.value.trim();
    if (query) {
        searchUsers(query);
    } else {
        loadContacts();
    }
}, 300); // Увеличено для плавности

// Оптимизированный рендеринг с DocumentFragment и делегированием событий
function renderUsers(users) {
    const usersList = getEl('users-list');
    
    if (!users.length) {
        usersList.innerHTML = '<div class="empty-list">Нет контактов<br>Найдите пользователя через поиск</div>';
        return;
    }
    
    const fragment = document.createDocumentFragment();
    
    users.forEach(user => {
        const userStatus = state.onlineUsers[user.id]; // undefined если оффлайн
        const isOnline = !!userStatus;
        const unread = parseInt(user.unread_count) || 0;
        
        // Определяем текст статуса
        let statusText = 'Не в сети';
        let statusClass = 'offline';
        if (userStatus === 'online') {
            statusText = 'В сети';
            statusClass = '';
        } else if (userStatus === 'idle') {
            statusText = 'Отошёл';
            statusClass = 'idle';
        } else if (userStatus === 'dnd') {
            statusText = 'Не беспокоить';
            statusClass = 'dnd';
        }
        
        const item = document.createElement('div');
        const isPinned = user.isPinned;
        item.className = `user-item ${statusClass} ${state.selectedUser?.id === user.id ? 'active' : ''} ${isPinned ? 'pinned' : ''}`;
        item.dataset.id = user.id;
        item.dataset.name = user.username;
        item.dataset.status = userStatus || 'offline';
        
        const avatarStyle = user.avatar_url 
            ? `background-image: url(${escapeAttr(user.avatar_url)}); background-size: cover; background-position: center;`
            : 'background: var(--message-sent);';
        const avatarContent = user.avatar_url ? '' : user.username[0].toUpperCase();
        // Используем локальный никнейм если есть
        const localNickname = getLocalNickname(user.id);
        const displayName = localNickname || user.display_name || user.username;
        const isMuted = isUserMuted(user.id);
        const isPremiumUser = user.isPremium || user.role === 'admin';
        const premiumPlan = (user.premiumPlan || user.premium_plan || 'premium').toString().toLowerCase().trim();
        const avatarClass = 'user-avatar';
        const nameStyle = user.name_color ? `style="--name-color: ${escapeAttr(user.name_color)}" data-name-color` : '';
        
        // Бейдж P или P+ в списке контактов
        let premiumBadge = '';
        if (isPremiumUser) {
            const isPremiumPlus = premiumPlan === 'premium_plus' || premiumPlan === 'premiumplus' || premiumPlan === 'premium+';
            if (isPremiumPlus) {
                premiumBadge = ' <span class="premium-indicator premium-plus-badge">P+</span>';
            } else {
                premiumBadge = ' <span class="premium-indicator premium-badge">P</span>';
            }
        }
        
        item.innerHTML = `
            ${isPinned ? '<span class="pin-indicator"><img src="/assets/bookmark.svg" alt="" class="icon-sm"></span>' : ''}
            <div class="${avatarClass}" style="${avatarStyle}">
                ${avatarContent}
                <div class="online-indicator ${userStatus || 'offline'}"></div>
            </div>
            <div class="user-info">
                <div class="user-name" ${nameStyle}>${escapeHtml(displayName)}${premiumBadge}${isMuted ? ' <span class="muted-indicator"><img src="/assets/bell.svg" alt="muted" class="icon-sm" style="opacity:0.5"></span>' : ''}</div>
                <div class="user-last-message">${localNickname ? `@${escapeHtml(user.username)} · ` : ''}${statusText}</div>
            </div>
            ${unread > 0 ? `<div class="unread-badge">${unread}</div>` : ''}
        `;
        
        fragment.appendChild(item);
    });
    
    usersList.innerHTML = '';
    usersList.appendChild(fragment);
}

// Делегирование событий для списка пользователей (один раз при инициализации)
function initUserListEvents() {
    getEl('users-list')?.addEventListener('click', (e) => {
        const item = e.target.closest('.user-item');
        if (item) {
            selectUser(item.dataset.id, item.dataset.name);
        }
    });
}

// === ЧАТ ===
async function selectUser(userId, username) {
    state.selectedUser = { id: userId, username };
    
    try {
        const res = await api.get(`/api/user/${userId}`);
        if (res.ok) {
            state.selectedUserProfile = await res.json();
        }
    } catch (e) {
        console.error('Ошибка загрузки профиля:', e);
        state.selectedUserProfile = null;
    }
    
    document.querySelectorAll('.user-item').forEach(i => i.classList.remove('active'));
    document.querySelector(`[data-id="${userId}"]`)?.classList.add('active');
    
    // Убираем badge
    const badge = document.querySelector(`[data-id="${userId}"] .unread-badge`);
    if (badge) badge.remove();
    
    // Используем локальный никнейм если есть
    const localNickname = getLocalNickname(userId);
    const displayName = localNickname || state.selectedUserProfile?.display_name || username;
    document.querySelector('.chat-user-name').textContent = displayName;
    updateChatStatus();
    updateChatHeaderAvatar();
    
    document.getElementById('message-input').disabled = false;
    document.querySelector('.send-btn').disabled = false;
    
    await loadMessages();
    handleMobileAfterSelect();
}

async function loadMessages() {
    try {
        const res = await api.get(`/api/messages/${state.selectedUser.id}`);
        if (!res.ok) throw new Error('Ошибка загрузки');
        
        const messages = await res.json();
        renderMessages(messages);
    } catch (e) {
        console.error('Ошибка загрузки сообщений:', e);
        document.getElementById('messages').innerHTML = 
            '<div class="empty-list">Ошибка загрузки сообщений</div>';
    }
}

// Оптимизированный рендеринг сообщений
function renderMessages(messages) {
    const messagesDiv = getEl('messages');
    const fragment = document.createDocumentFragment();
    
    // Отключаем анимации при массовой загрузке
    messagesDiv.classList.add('loading');
    
    messages.forEach(msg => {
        const isSent = msg.sender_id === state.currentUser.id;
        
        if (msg.message_type === 'audio_call' || msg.message_type === 'video_call') {
            fragment.appendChild(createCallMessageElement(msg, isSent));
        } else {
            fragment.appendChild(createMessageElement(msg, isSent));
        }
    });
    
    messagesDiv.innerHTML = '';
    messagesDiv.appendChild(fragment);
    
    // Используем requestAnimationFrame для плавной прокрутки
    requestAnimationFrame(() => {
        messagesDiv.scrollTop = messagesDiv.scrollHeight;
        // Включаем анимации обратно после рендера
        messagesDiv.classList.remove('loading');
    });
}

function createMessageElement(msg, isSent) {
    const div = document.createElement('div');
    // Для своих сообщений - свой стиль, для чужих - стиль отправителя
    const bubbleStyleClass = isSent 
        ? getBubbleStyleClass() 
        : getBubbleStyleClass(msg.sender_bubble_style);
    const selfDestructClass = msg.self_destruct_at ? 'self-destruct' : '';
    div.className = `message ${isSent ? 'sent' : 'received'} ${bubbleStyleClass} ${selfDestructClass}`.trim();
    div.dataset.messageId = msg.id;
    div.dataset.senderId = msg.sender_id;
    
    const editedMark = msg.updated_at ? '<span class="message-edited">(ред.)</span>' : '';
    const reactionsHtml = renderReactions(msg.reactions || [], msg.id);
    
    // Определяем контент в зависимости от типа сообщения
    let bubbleContent;
    let isMedia = msg.message_type === 'image' || msg.message_type === 'gif';
    let isVideo = msg.message_type === 'video';
    
    // Автодетект изображений по URL (для старых сообщений без message_type)
    if (!isMedia && !isVideo && msg.text) {
        const text = msg.text.trim();
        const imageExtensions = /\.(jpg|jpeg|png|gif|webp)(\?.*)?$/i;
        const videoExtensions = /\.(mp4|webm)(\?.*)?$/i;
        const cloudinaryImage = /res\.cloudinary\.com.*\/(image|video)\/upload/i;
        
        // Проверяем только если это чистый URL (без другого текста)
        const isJustUrl = /^https?:\/\/\S+$/i.test(text);
        
        if (isJustUrl) {
            if (imageExtensions.test(text) || (cloudinaryImage.test(text) && !text.includes('/video/'))) {
                isMedia = true;
            } else if (videoExtensions.test(text) || (cloudinaryImage.test(text) && text.includes('/video/'))) {
                isVideo = true;
            }
        }
    }
    
    if (isMedia) {
        bubbleContent = `<img src="${escapeAttr(msg.text)}" class="message-media" alt="Изображение" loading="lazy">`;
    } else if (isVideo) {
        // Telegram-style: превью с временем, автоплей без звука
        bubbleContent = `
            <div class="video-message" data-src="${escapeAttr(msg.text)}">
                <video class="video-preview" loop muted playsinline preload="metadata" src="${escapeAttr(msg.text)}">
                </video>
                <span class="video-duration">0:00</span>
                <div class="video-mute-indicator">🔇</div>
            </div>`;
    } else {
        // Преобразуем URL в кликабельные ссылки
        bubbleContent = linkifyText(escapeHtml(msg.text));
    }
    
    div.innerHTML = `
        ${getAvatarHtml(isSent)}
        <div class="message-content">
            <div class="message-bubble">${bubbleContent}</div>
            <div class="message-time">${formatTime(msg.created_at)}${editedMark}</div>
            ${reactionsHtml}
            <button class="add-reaction-btn" title="Добавить реакцию">😊</button>
        </div>
    `;
    
    // Клик на изображение - открыть просмотр
    if (isMedia) {
        div.querySelector('.message-media')?.addEventListener('click', () => {
            openMediaViewer(msg.text);
        });
    }
    
    // Инициализация видео (Telegram-style)
    if (isVideo) {
        initVideoMessage(div.querySelector('.video-message'));
    }
    
    // Контекстное меню: ПК — правый клик, мобильные — обычный тап
    div.addEventListener('contextmenu', (e) => showMessageContextMenu(e, msg, isSent));
    
    // На мобильных открываем меню по обычному тапу на сообщение
    if (isMobile()) {
        div.addEventListener('click', (e) => {
            // Не открываем если кликнули на ссылку, кнопку или медиа
            if (e.target.closest('a, button, img, video, .add-reaction-btn')) return;
            e.stopPropagation();
            showMessageContextMenu(e, msg, isSent);
        });
    }
    
    // Добавление реакции
    div.querySelector('.add-reaction-btn')?.addEventListener('click', (e) => {
        e.stopPropagation();
        showReactionPicker(msg.id, e.target);
    });
    
    return div;
}

// Просмотр медиа в полном размере
function openMediaViewer(url) {
    // Удаляем старый просмотрщик если есть
    document.querySelector('.media-viewer')?.remove();
    
    const viewer = document.createElement('div');
    viewer.className = 'media-viewer';
    viewer.innerHTML = `
        <div class="media-viewer-overlay"></div>
        <img src="${escapeAttr(url)}" class="media-viewer-content" alt="Просмотр">
        <button class="media-viewer-close">✕</button>
        <a class="media-viewer-download" href="${escapeAttr(url)}" download target="_blank">⬇️</a>
    `;
    
    // Закрытие по клику на оверлей или кнопку
    viewer.querySelector('.media-viewer-overlay').addEventListener('click', () => viewer.remove());
    viewer.querySelector('.media-viewer-close').addEventListener('click', () => viewer.remove());
    
    // Закрытие по Escape
    const handleEscape = (e) => {
        if (e.key === 'Escape') {
            viewer.remove();
            document.removeEventListener('keydown', handleEscape);
        }
    };
    document.addEventListener('keydown', handleEscape);
    
    document.body.appendChild(viewer);
}

// Делаем функцию глобальной для onclick в HTML
window.openMediaViewer = openMediaViewer;

// === TELEGRAM-STYLE VIDEO MESSAGE ===
function initVideoMessage(container) {
    if (!container) return;
    
    const video = container.querySelector('.video-preview');
    const durationEl = container.querySelector('.video-duration');
    const muteIndicator = container.querySelector('.video-mute-indicator');
    
    if (!video) return;
    
    const formatDuration = (seconds) => {
        if (!seconds || isNaN(seconds)) return '0:00';
        const mins = Math.floor(seconds / 60);
        const secs = Math.floor(seconds % 60);
        return `${mins}:${secs.toString().padStart(2, '0')}`;
    };
    
    // Обработка ошибок загрузки
    video.addEventListener('error', (e) => {
        console.error('Video load error:', video.src, e);
        durationEl.textContent = '⚠️';
        container.style.opacity = '0.5';
    });
    
    // Показать длительность когда загрузится
    video.addEventListener('loadedmetadata', () => {
        durationEl.textContent = formatDuration(video.duration);
    });
    
    // Автоплей когда видео в зоне видимости
    const observer = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
            if (entry.isIntersecting) {
                video.play().catch(() => {});
            } else {
                video.pause();
            }
        });
    }, { threshold: 0.5 });
    
    observer.observe(container);
    
    // Клик - открыть полноэкранный плеер
    container.addEventListener('click', () => {
        openVideoViewer(container.dataset.src, video.currentTime);
    });
    
    // Клик на индикатор звука - включить/выключить
    muteIndicator?.addEventListener('click', (e) => {
        e.stopPropagation();
        video.muted = !video.muted;
        muteIndicator.textContent = video.muted ? '🔇' : '🔊';
        muteIndicator.classList.toggle('unmuted', !video.muted);
    });
}

// === YOUTUBE-STYLE FULLSCREEN VIDEO PLAYER ===
function openVideoViewer(url, startTime = 0) {
    document.querySelector('.video-fullscreen-player')?.remove();
    
    const player = document.createElement('div');
    player.className = 'video-fullscreen-player';
    player.innerHTML = `
        <div class="vfp-overlay"></div>
        <div class="vfp-container">
            <video class="vfp-video" playsinline src="${escapeAttr(url)}">
            </video>
            <div class="vfp-controls">
                <div class="vfp-progress-container">
                    <div class="vfp-progress">
                        <div class="vfp-progress-buffered"></div>
                        <div class="vfp-progress-played"></div>
                    </div>
                </div>
                <div class="vfp-buttons">
                    <div class="vfp-left">
                        <button class="vfp-btn vfp-play">▶</button>
                        <div class="vfp-volume">
                            <button class="vfp-btn vfp-mute">🔊</button>
                            <input type="range" class="vfp-volume-slider" min="0" max="1" step="0.1" value="1">
                        </div>
                        <span class="vfp-time">0:00 / 0:00</span>
                    </div>
                    <div class="vfp-right">
                        <button class="vfp-btn vfp-pip" title="Картинка в картинке">⧉</button>
                        <button class="vfp-btn vfp-fullscreen" title="Полный экран">⛶</button>
                        <button class="vfp-btn vfp-close">✕</button>
                    </div>
                </div>
            </div>
            <div class="vfp-center-play hidden">▶</div>
        </div>
    `;
    
    document.body.appendChild(player);
    
    const video = player.querySelector('.vfp-video');
    const controls = player.querySelector('.vfp-controls');
    const progressContainer = player.querySelector('.vfp-progress-container');
    const progressPlayed = player.querySelector('.vfp-progress-played');
    const progressBuffered = player.querySelector('.vfp-progress-buffered');
    const playBtn = player.querySelector('.vfp-play');
    const muteBtn = player.querySelector('.vfp-mute');
    const volumeSlider = player.querySelector('.vfp-volume-slider');
    const timeDisplay = player.querySelector('.vfp-time');
    const pipBtn = player.querySelector('.vfp-pip');
    const fullscreenBtn = player.querySelector('.vfp-fullscreen');
    const closeBtn = player.querySelector('.vfp-close');
    const overlay = player.querySelector('.vfp-overlay');
    const centerPlay = player.querySelector('.vfp-center-play');
    
    const formatTime = (s) => {
        if (!s || isNaN(s)) return '0:00';
        const m = Math.floor(s / 60);
        const sec = Math.floor(s % 60);
        return `${m}:${sec.toString().padStart(2, '0')}`;
    };
    
    let hideControlsTimeout;
    const showControls = () => {
        controls.classList.add('visible');
        clearTimeout(hideControlsTimeout);
        if (!video.paused) {
            hideControlsTimeout = setTimeout(() => {
                controls.classList.remove('visible');
            }, 3000);
        }
    };
    
    // Video events
    video.addEventListener('loadedmetadata', () => {
        video.currentTime = startTime;
        video.play().catch(() => {});
        timeDisplay.textContent = `${formatTime(video.currentTime)} / ${formatTime(video.duration)}`;
    });
    
    video.addEventListener('timeupdate', () => {
        const percent = (video.currentTime / video.duration) * 100;
        progressPlayed.style.width = `${percent}%`;
        timeDisplay.textContent = `${formatTime(video.currentTime)} / ${formatTime(video.duration)}`;
    });
    
    video.addEventListener('progress', () => {
        if (video.buffered.length > 0) {
            const buffered = (video.buffered.end(video.buffered.length - 1) / video.duration) * 100;
            progressBuffered.style.width = `${buffered}%`;
        }
    });
    
    video.addEventListener('play', () => {
        playBtn.textContent = '⏸';
        centerPlay.classList.add('hidden');
    });
    
    video.addEventListener('pause', () => {
        playBtn.textContent = '▶';
        centerPlay.classList.remove('hidden');
        controls.classList.add('visible');
    });
    
    video.addEventListener('ended', () => {
        playBtn.textContent = '↺';
    });
    
    // Controls
    const togglePlay = () => {
        if (video.ended) {
            video.currentTime = 0;
        }
        video.paused ? video.play() : video.pause();
    };
    
    playBtn.addEventListener('click', togglePlay);
    video.addEventListener('click', togglePlay);
    centerPlay.addEventListener('click', togglePlay);
    
    // Progress seek
    progressContainer.addEventListener('click', (e) => {
        const rect = progressContainer.getBoundingClientRect();
        const percent = (e.clientX - rect.left) / rect.width;
        video.currentTime = percent * video.duration;
    });
    
    // Volume - загружаем сохранённую громкость
    const savedVolume = parseFloat(localStorage.getItem('videoVolume') || '1');
    video.volume = savedVolume;
    volumeSlider.value = savedVolume;
    updateVolumeSliderVisual(volumeSlider, savedVolume);
    muteBtn.textContent = savedVolume === 0 ? '🔇' : '🔊';
    
    function updateVolumeSliderVisual(slider, value) {
        const percent = value * 100;
        slider.style.background = `linear-gradient(to right, white ${percent}%, rgba(255,255,255,0.3) ${percent}%)`;
    }
    
    muteBtn.addEventListener('click', () => {
        video.muted = !video.muted;
        muteBtn.textContent = video.muted ? '🔇' : '🔊';
        volumeSlider.value = video.muted ? 0 : video.volume;
        updateVolumeSliderVisual(volumeSlider, video.muted ? 0 : video.volume);
    });
    
    volumeSlider.addEventListener('input', (e) => {
        const vol = parseFloat(e.target.value);
        video.volume = vol;
        video.muted = vol === 0;
        muteBtn.textContent = vol === 0 ? '🔇' : '🔊';
        updateVolumeSliderVisual(volumeSlider, vol);
        localStorage.setItem('videoVolume', vol.toString());
    });
    
    // PiP
    pipBtn.addEventListener('click', async () => {
        try {
            if (document.pictureInPictureElement) {
                await document.exitPictureInPicture();
            } else {
                await video.requestPictureInPicture();
            }
        } catch (e) {
            console.log('PiP not supported');
        }
    });
    
    // Fullscreen
    fullscreenBtn.addEventListener('click', () => {
        if (document.fullscreenElement) {
            document.exitFullscreen();
        } else {
            player.requestFullscreen().catch(() => {});
        }
    });
    
    // Keyboard handler (defined before closePlayer so it can be removed)
    const handleKeydown = (e) => {
        // Игнорируем если фокус в поле ввода
        if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.isContentEditable) {
            return;
        }
        if (e.key === 'Escape') closePlayer();
        if (e.key === ' ' || e.key === 'k') { e.preventDefault(); togglePlay(); }
        if (e.key === 'ArrowLeft') video.currentTime -= 5;
        if (e.key === 'ArrowRight') video.currentTime += 5;
        if (e.key === 'ArrowUp') { 
            e.preventDefault(); 
            video.volume = Math.min(1, video.volume + 0.1);
            volumeSlider.value = video.volume;
            updateVolumeSliderVisual(volumeSlider, video.volume);
            localStorage.setItem('videoVolume', video.volume.toString());
        }
        if (e.key === 'ArrowDown') { 
            e.preventDefault(); 
            video.volume = Math.max(0, video.volume - 0.1);
            volumeSlider.value = video.volume;
            updateVolumeSliderVisual(volumeSlider, video.volume);
            localStorage.setItem('videoVolume', video.volume.toString());
        }
        if (e.key === 'm') { 
            video.muted = !video.muted; 
            muteBtn.textContent = video.muted ? '🔇' : '🔊';
            updateVolumeSliderVisual(volumeSlider, video.muted ? 0 : video.volume);
        }
        if (e.key === 'f') fullscreenBtn.click();
    };
    
    // Close
    const closePlayer = () => {
        document.removeEventListener('keydown', handleKeydown);
        video.pause();
        player.remove();
    };
    
    closeBtn.addEventListener('click', closePlayer);
    overlay.addEventListener('click', closePlayer);
    document.addEventListener('keydown', handleKeydown);
    
    // Show/hide controls on mouse move
    player.addEventListener('mousemove', showControls);
    player.addEventListener('mouseleave', () => {
        if (!video.paused) controls.classList.remove('visible');
    });
    
    showControls();
}

function renderReactions(reactions, messageId) {
    if (!reactions || reactions.length === 0) return '';
    
    const html = reactions.map(r => {
        const isOwn = r.user_ids?.includes(state.currentUser.id) ? 'own' : '';
        return `<span class="reaction-badge ${isOwn}" data-emoji="${r.emoji}" data-message-id="${messageId}">
            ${r.emoji}<span class="reaction-count">${r.count}</span>
        </span>`;
    }).join('');
    
    return `<div class="message-reactions">${html}</div>`;
}

function showMessageContextMenu(e, msg, isSent) {
    e.preventDefault();
    
    // Удаляем старое меню
    document.querySelector('.message-context-menu')?.remove();
    
    const menu = document.createElement('div');
    menu.className = 'message-context-menu';
    
    let menuItems = `
        <div class="context-menu-item" data-action="react"><img src="/assets/emoji.svg" alt="" class="icon-sm ctx-icon"> Реакция</div>
        <div class="context-menu-item" data-action="copy"><img src="/assets/copy.svg" alt="" class="icon-sm ctx-icon"> Копировать</div>
    `;
    
    if (isSent) {
        const isPremiumPlus = state.currentUserProfile?.premiumPlan === 'premium_plus' || state.currentUser?.role === 'admin';
        menuItems += `
            <div class="context-menu-divider"></div>
            <div class="context-menu-item" data-action="edit"><img src="/assets/edit.svg" alt="" class="icon-sm ctx-icon"> Редактировать</div>
            <div class="context-menu-item danger" data-action="delete"><img src="/assets/trash.svg" alt="" class="icon-sm ctx-icon"> Удалить у себя</div>
            ${isPremiumPlus ? '<div class="context-menu-item danger" data-action="delete-all"><img src="/assets/trash.svg" alt="" class="icon-sm ctx-icon"> Удалить у всех <span class="badge-premium-plus">P+</span></div>' : ''}
        `;
    }
    
    menu.innerHTML = menuItems;
    document.body.appendChild(menu);
    
    // Позиционирование с учётом границ экрана
    const menuRect = menu.getBoundingClientRect();
    let left = e.clientX;
    let top = e.clientY;
    
    // Проверяем правую границу
    if (left + menuRect.width > window.innerWidth) {
        left = window.innerWidth - menuRect.width - 10;
    }
    // Проверяем нижнюю границу
    if (top + menuRect.height > window.innerHeight) {
        top = window.innerHeight - menuRect.height - 10;
    }
    // Проверяем левую границу
    if (left < 10) left = 10;
    // Проверяем верхнюю границу
    if (top < 10) top = 10;
    
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
    
    // Обработчики
    menu.addEventListener('click', async (ev) => {
        const action = ev.target.closest('.context-menu-item')?.dataset.action;
        if (!action) return;
        
        switch (action) {
            case 'copy':
                navigator.clipboard.writeText(msg.text);
                showToast('Скопировано');
                break;
            case 'edit':
                editMessage(msg);
                break;
            case 'delete':
                deleteMessagePrompt(msg, false);
                break;
            case 'delete-all':
                deleteMessagePrompt(msg, true);
                break;
            case 'react':
                showReactionPicker(msg.id, ev.target);
                break;
        }
        menu.remove();
    });
    
    // Закрытие по клику вне
    setTimeout(() => {
        document.addEventListener('click', () => menu.remove(), { once: true });
    }, 10);
}

async function editMessage(msg) {
    const newText = await customPrompt({
        title: 'Редактировать сообщение',
        icon: '✏️',
        defaultValue: msg.text,
        okText: 'Сохранить'
    });
    
    if (newText && newText !== msg.text) {
        state.socket.emit('edit-message', {
            messageId: msg.id,
            text: newText,
            receiverId: state.selectedUser.id
        });
    }
}

async function deleteMessagePrompt(msg, deleteForAll = false) {
    const message = deleteForAll 
        ? 'Сообщение будет удалено у всех участников чата'
        : 'Сообщение будет удалено только у вас';
    
    const confirmed = await customConfirm({
        title: deleteForAll ? 'Удалить у всех?' : 'Удалить сообщение?',
        message,
        icon: '🗑️',
        variant: 'danger',
        okText: 'Удалить'
    });
    
    if (confirmed) {
        state.socket.emit('delete-message', {
            messageId: msg.id,
            receiverId: state.selectedUser.id,
            deleteForAll
        });
    }
}

function showReactionPicker(messageId, target) {
    const emojis = ['👍', '❤️', '😂', '😮', '😢', '😡', '🔥', '👏'];
    
    // Удаляем старый пикер
    document.querySelector('.reaction-picker')?.remove();
    
    const picker = document.createElement('div');
    picker.className = 'emoji-picker reaction-picker';
    picker.innerHTML = `<div class="emoji-grid">${emojis.map(e => 
        `<div class="emoji-item" data-emoji="${e}">${e}</div>`
    ).join('')}</div>`;
    
    const rect = target.getBoundingClientRect();
    picker.style.bottom = `${window.innerHeight - rect.top + 10}px`;
    picker.style.left = `${rect.left}px`;
    picker.style.right = 'auto';
    
    document.body.appendChild(picker);
    
    picker.addEventListener('click', (e) => {
        const emoji = e.target.dataset.emoji;
        if (emoji) {
            state.socket.emit('add-reaction', {
                messageId,
                emoji,
                receiverId: state.selectedUser.id
            });
            picker.remove();
        }
    });
    
    setTimeout(() => {
        document.addEventListener('click', () => picker.remove(), { once: true });
    }, 10);
}

function createCallMessageElement(msg, isSent) {
    const duration = msg.call_duration || 0;
    const mins = Math.floor(duration / 60);
    const secs = duration % 60;
    const durationText = duration > 0 ? `${mins}:${secs.toString().padStart(2, '0')}` : '';
    const iconSrc = msg.message_type === 'video_call' ? '/assets/video.svg' : '/assets/phone-call.svg';
    
    const div = document.createElement('div');
    div.className = `message ${isSent ? 'sent' : 'received'} call-message`;
    div.innerHTML = `
        <div class="message-content">
            <div class="message-bubble call-bubble">
                <span class="call-icon"><img src="${iconSrc}" alt="" class="icon-sm"></span>
                <span class="call-text">${escapeHtml(msg.text)}</span>
                ${durationText ? `<span class="call-duration">${durationText}</span>` : ''}
            </div>
            <div class="message-time">${formatTime(msg.created_at)}</div>
        </div>
    `;
    return div;
}



function getAvatarHtml(isSent) {
    if (isSent) {
        if (state.currentUserProfile?.avatar_url) {
            return `<div class="message-avatar" style="background-image: url(${escapeAttr(state.currentUserProfile.avatar_url)}); background-size: cover;"></div>`;
        }
        return `<div class="message-avatar">${state.currentUser.username[0].toUpperCase()}</div>`;
    } else {
        if (state.selectedUserProfile?.avatar_url) {
            return `<div class="message-avatar" style="background-image: url(${escapeAttr(state.selectedUserProfile.avatar_url)}); background-size: cover;"></div>`;
        }
        return `<div class="message-avatar">${state.selectedUser.username[0].toUpperCase()}</div>`;
    }
}

function appendMessage(msg) {
    const messagesDiv = getEl('messages');
    const isSent = msg.sender_id === state.currentUser.id;
    
    // Проверяем, находится ли пользователь внизу (читает новые сообщения)
    const isAtBottom = messagesDiv.scrollHeight - messagesDiv.scrollTop - messagesDiv.clientHeight < 100;
    
    messagesDiv.appendChild(createMessageElement(msg, isSent));
    
    // Скроллим только если пользователь был внизу или это его сообщение
    if (isAtBottom || isSent) {
        requestAnimationFrame(() => {
            messagesDiv.scrollTop = messagesDiv.scrollHeight;
        });
    }
}

function sendMessage() {
    const input = document.getElementById('message-input');
    const text = input.value.trim();
    
    if (!text || !state.socket) return;
    
    // Проверяем что выбран какой-то чат
    if (!state.selectedUser && !state.selectedGroup && !state.selectedChannel && !state.selectedServerChannel) return;
    
    stopTyping();
    
    // Получаем время самоуничтожения
    const selfDestructMinutes = state.selfDestructMinutes || 0;
    
    // Отправляем в зависимости от типа чата
    if (state.selectedGroup) {
        state.socket.emit('group-message', {
            groupId: state.selectedGroup.id,
            text,
            messageType: 'text'
        });
    } else if (state.selectedChannel) {
        state.socket.emit('channel-post', {
            channelId: state.selectedChannel.id,
            text
        });
    } else if (state.selectedServerChannel) {
        state.socket.emit('server-message', {
            channelId: state.selectedServerChannel.id,
            text,
            messageType: 'text'
        });
    } else if (state.selectedUser) {
        state.socket.emit('send-message', {
            receiverId: state.selectedUser.id,
            text,
            selfDestructMinutes
        });
    }
    
    input.value = '';
}

// Прикрепление файла
async function handleAttachFile(e) {
    const file = e.target.files[0];
    if (!file) return;
    
    // Проверяем что выбран какой-то чат
    const hasChat = state.selectedUser || state.selectedGroup || state.selectedChannel || state.selectedServerChannel;
    if (!hasChat) {
        showToast('Сначала выберите чат', 'error');
        e.target.value = '';
        return;
    }
    
    // Проверка размера
    const isPremium = state.currentUserProfile?.isPremium || state.currentUser?.role === 'admin';
    const maxSize = isPremium ? 25 * 1024 * 1024 : 5 * 1024 * 1024;
    
    if (file.size > maxSize) {
        const limitMB = maxSize / (1024 * 1024);
        showToast(`Максимальный размер файла: ${limitMB}MB`, 'error');
        e.target.value = '';
        return;
    }
    
    try {
        showToast('Загрузка файла...', 'info');
        
        const formData = new FormData();
        formData.append('file', file);
        
        const res = await api.uploadFile('/api/upload-message-file', formData);
        const result = await res.json();
        
        if (result.success) {
            // Отправляем сообщение с файлом в зависимости от типа чата
            if (state.selectedUser) {
                state.socket.emit('send-message', {
                    receiverId: state.selectedUser.id,
                    text: result.fileUrl,
                    messageType: result.fileType
                });
            } else if (state.selectedGroup) {
                state.socket.emit('group-message', {
                    groupId: state.selectedGroup.id,
                    text: result.fileUrl,
                    messageType: result.fileType
                });
            } else if (state.selectedChannel) {
                state.socket.emit('channel-message', {
                    channelId: state.selectedChannel.id,
                    text: result.fileUrl,
                    messageType: result.fileType
                });
            } else if (state.selectedServerChannel) {
                state.socket.emit('server-message', {
                    channelId: state.selectedServerChannel.id,
                    text: result.fileUrl,
                    messageType: result.fileType
                });
            }
            showToast('Файл отправлен!', 'success');
        } else {
            showToast(result.error || 'Ошибка загрузки', 'error');
        }
    } catch (err) {
        console.error('Upload error:', err);
        showToast('Ошибка загрузки файла', 'error');
    }
    
    e.target.value = '';
}

async function markAsRead() {
    if (!state.selectedUser) return;
    try {
        await api.get(`/api/messages/${state.selectedUser.id}`);
    } catch {}
}

// === TYPING INDICATOR ===
let typingTimeout = null;
let isTyping = false;

function startTyping() {
    if (!state.selectedUser || !state.socket || state.settings.typing === false) return;
    
    if (!isTyping) {
        isTyping = true;
        state.socket.emit('typing-start', { receiverId: state.selectedUser.id });
    }
    
    clearTimeout(typingTimeout);
    typingTimeout = setTimeout(stopTyping, 2000);
}

function stopTyping() {
    if (!state.selectedUser || !state.socket) return;
    
    if (isTyping) {
        isTyping = false;
        state.socket.emit('typing-stop', { receiverId: state.selectedUser.id });
    }
    clearTimeout(typingTimeout);
}

// Throttled для предотвращения частых обновлений DOM
const updateChatStatus = throttle(() => {
    if (!state.selectedUser) return;
    
    const statusEl = document.querySelector('.chat-user-status');
    if (!statusEl) return;
    
    const userStatus = state.onlineUsers[state.selectedUser.id];
    const isUserTyping = state.typingUsers.has(state.selectedUser.id);
    
    if (isUserTyping) {
        statusEl.textContent = 'печатает...';
        statusEl.style.color = 'var(--accent)';
    } else if (userStatus === 'online') {
        statusEl.textContent = 'В сети';
        statusEl.style.color = 'var(--online)';
    } else if (userStatus === 'idle') {
        statusEl.textContent = 'Отошёл';
        statusEl.style.color = '#f59e0b';
    } else if (userStatus === 'dnd') {
        statusEl.textContent = 'Не беспокоить';
        statusEl.style.color = '#ef4444';
    } else {
        statusEl.textContent = 'Не в сети';
        statusEl.style.color = 'var(--text-muted)';
    }
}, 100);

// === ПРОФИЛЬ ===
async function loadMyProfile() {
    try {
        const res = await api.get(`/api/user/${state.currentUser.id}`);
        if (res.ok) {
            state.currentUserProfile = await res.json();
            updateCurrentUserAvatar();
            // Обновляем видимость Premium+ фич
            if (window.updateSelfDestructVisibility) {
                window.updateSelfDestructVisibility();
            }
        }
    } catch (e) {
        console.error('Ошибка загрузки профиля:', e);
    }
}

function updateCurrentUserAvatar() {
    const avatarEl = document.getElementById('current-user-avatar');
    if (state.currentUserProfile?.avatar_url) {
        avatarEl.style.backgroundImage = `url(${state.currentUserProfile.avatar_url})`;
        avatarEl.style.backgroundSize = 'cover';
        avatarEl.textContent = '';
    } else {
        avatarEl.style.backgroundImage = '';
        avatarEl.textContent = state.currentUser.username[0].toUpperCase();
    }
}

async function openChatWithUser(userId) {
    try {
        const res = await api.get(`/api/user/${userId}`);
        if (res.ok) {
            const user = await res.json();
            if (user) {
                selectUser(userId, user.username);
            }
        }
    } catch (e) {
        console.error('Ошибка открытия чата:', e);
    }
}

// === УТИЛИТЫ ===
function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

function escapeAttr(text) {
    return text.replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// Преобразует URL в кликабельные ссылки
function linkifyText(text) {
    const urlRegex = /(https?:\/\/[^\s<]+)/gi;
    return text.replace(urlRegex, (url) => {
        // Проверяем это инвайт-ссылка на канал/сервер
        const inviteMatch = url.match(/\/invite\/(channel|server)\/([^\/\s]+)/);
        if (inviteMatch) {
            return `<a href="${url}" class="message-link invite-link" onclick="event.preventDefault(); handleInviteLink('${url}')">${url}</a>`;
        }
        return `<a href="${url}" class="message-link" target="_blank" rel="noopener">${url}</a>`;
    });
}

function formatTime(dateStr) {
    const date = new Date(dateStr);
    return date.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

function escapeAttr(text) {
    return String(text).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function formatTime(dateStr) {
    const date = new Date(dateStr);
    return date.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
}

function showToast(message, type = 'info') {
    // Создаём контейнер если его нет
    let container = document.querySelector('.toast-container');
    if (!container) {
        container = document.createElement('div');
        container.className = 'toast-container';
        document.body.appendChild(container);
    }
    
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.textContent = message;
    container.appendChild(toast);
    
    setTimeout(() => {
        toast.remove();
    }, 3000);
}

// === МОБИЛЬНАЯ НАВИГАЦИЯ ===
function isMobile() {
    return window.innerWidth <= 768;
}

function handleMobileAfterSelect() {
    if (isMobile()) {
        document.querySelector('.sidebar')?.classList.add('hidden-mobile');
        document.getElementById('chat-screen')?.classList.add('chat-open');
        
        // Лёгкая вибрация
        if (navigator.vibrate) {
            navigator.vibrate(10);
        }
    }
}

// === НАСТРОЙКИ ===
function saveSettings() {
    localStorage.setItem('kvant_settings', JSON.stringify(state.settings));
    // Синхронизируем с сервером (без customBg - слишком большой)
    syncSettingsToServer();
}

let settingsSyncTimeout = null;
function syncSettingsToServer() {
    // Дебаунс - отправляем не чаще раза в секунду
    if (settingsSyncTimeout) clearTimeout(settingsSyncTimeout);
    settingsSyncTimeout = setTimeout(async () => {
        try {
            const settingsToSync = { ...state.settings };
            // Локальные настройки - не синхронизируем
            delete settingsToSync.sounds; // Звук - локальная настройка
            delete settingsToSync.volume; // Громкость - локальная настройка
            // customBg синхронизируем для привязки к аккаунту
            
            await fetch('/api/settings', {
                method: 'PUT',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${state.token}`
                },
                body: JSON.stringify(settingsToSync)
            });
        } catch (e) {
            console.log('Settings sync failed:', e);
        }
    }, 1000);
}

function adjustColor(color, amount) {
    const hex = color.replace('#', '');
    const r = Math.max(0, Math.min(255, parseInt(hex.substr(0, 2), 16) + amount));
    const g = Math.max(0, Math.min(255, parseInt(hex.substr(2, 2), 16) + amount));
    const b = Math.max(0, Math.min(255, parseInt(hex.substr(4, 2), 16) + amount));
    return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
}

function applyPanelOpacity(opacity) {
    // Конвертируем проценты в значение 0-1
    const value = opacity / 100;
    document.documentElement.style.setProperty('--panel-opacity', value);
}

function applyBgBlur(blur) {
    document.documentElement.style.setProperty('--bg-blur', `${blur}px`);
    const chatScreen = document.getElementById('chat-screen');
    if (chatScreen) {
        if (blur > 0) {
            chatScreen.style.backdropFilter = `blur(${blur}px)`;
        } else {
            chatScreen.style.backdropFilter = '';
        }
    }
}

function applyBgDim(dim) {
    document.documentElement.style.setProperty('--bg-dim', dim / 100);
    const chatScreen = document.getElementById('chat-screen');
    if (chatScreen) {
        // Добавляем overlay для затемнения
        let overlay = chatScreen.querySelector('.bg-dim-overlay');
        if (dim > 0) {
            if (!overlay) {
                overlay = document.createElement('div');
                overlay.className = 'bg-dim-overlay';
                overlay.style.cssText = 'position:absolute;inset:0;pointer-events:none;z-index:-1;';
                chatScreen.style.position = 'relative';
                chatScreen.insertBefore(overlay, chatScreen.firstChild);
            }
            overlay.style.background = `rgba(0,0,0,${dim/100})`;
        } else if (overlay) {
            overlay.remove();
        }
    }
}

function applyBubbleRadius(radius) {
    document.documentElement.style.setProperty('--bubble-radius', `${radius}px`);
    // Обновляем превью
    document.querySelectorAll('.preview-bubble').forEach(el => {
        el.style.borderRadius = `${radius}px`;
    });
}

function applyDensity(density) {
    const root = document.documentElement;
    switch (density) {
        case 'compact':
            root.style.setProperty('--message-gap', '4px');
            root.style.setProperty('--message-padding', '8px 12px');
            break;
        case 'cozy':
            root.style.setProperty('--message-gap', '16px');
            root.style.setProperty('--message-padding', '14px 18px');
            break;
        default: // normal
            root.style.setProperty('--message-gap', '8px');
            root.style.setProperty('--message-padding', '12px 16px');
    }
}

function applyAnimations(enabled) {
    document.documentElement.classList.toggle('no-animations', !enabled);
}

function applyTimestamps(show) {
    document.documentElement.classList.toggle('hide-timestamps', !show);
}

function applyTheme(theme) {
    const root = document.documentElement;
    
    // Убираем data-theme атрибут
    root.removeAttribute('data-theme');
    
    // Сбрасываем inline стили CSS переменных (чтобы CSS темы работали)
    const cssVars = ['--bg-darkest', '--bg-dark', '--bg-medium', '--bg-light', '--text', '--text-muted', 
                     '--message-received', '--glass', '--glass-border', '--accent', '--accent-light', '--accent-glow'];
    cssVars.forEach(v => root.style.removeProperty(v));
    
    if (theme === 'system') {
        theme = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    }
    
    // Темы через CSS data-theme (premium и midnight)
    if (['neon', 'sunset', 'ocean', 'forest', 'cherry', 'amoled', 'midnight'].includes(theme)) {
        root.setAttribute('data-theme', theme);
        return;
    }
    
    if (theme === 'light') {
        root.style.setProperty('--bg-darkest', '#f5f5f5');
        root.style.setProperty('--bg-dark', '#e8e8e8');
        root.style.setProperty('--bg-medium', '#ddd');
        root.style.setProperty('--bg-light', '#ccc');
        root.style.setProperty('--text', '#1a1a1a');
        root.style.setProperty('--text-muted', '#666');
        root.style.setProperty('--message-received', '#e0e0e0');
        root.style.setProperty('--glass', 'rgba(255, 255, 255, 0.8)');
        root.style.setProperty('--glass-border', 'rgba(0, 0, 0, 0.1)');
    } else {
        // dark - дефолтная тема, используем CSS :root
    }
}

// Системная тема
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (state.settings.theme === 'system') {
        applyTheme('system');
    }
});


// === WEBRTC ЗВОНКИ ===
let localStream = null;
let screenStream = null;
let peerConnection = null;
let callTimer = null;
let callSeconds = 0;
let currentCallUser = null;
let currentCallId = null;
let isVideoCall = false;
let isScreenSharing = false;
let isMuted = false;
let incomingCallData = null;

// ICE серверы для WebRTC
// ВАЖНО: Для надёжной работы через мобильный интернет нужны TURN серверы
const iceServers = {
    iceServers: [
        // STUN от Metered
        { urls: 'stun:stun.relay.metered.ca:80' },
        // TURN серверы Metered.ca (зарегистрированный аккаунт)
        {
            urls: 'turn:global.relay.metered.ca:80',
            username: '569a0840c6ddd4085c474f32',
            credential: 'dyQoNr8tELSuIR//'
        },
        {
            urls: 'turn:global.relay.metered.ca:80?transport=tcp',
            username: '569a0840c6ddd4085c474f32',
            credential: 'dyQoNr8tELSuIR//'
        },
        {
            urls: 'turn:global.relay.metered.ca:443',
            username: '569a0840c6ddd4085c474f32',
            credential: 'dyQoNr8tELSuIR//'
        },
        {
            urls: 'turns:global.relay.metered.ca:443?transport=tcp',
            username: '569a0840c6ddd4085c474f32',
            credential: 'dyQoNr8tELSuIR//'
        }
    ],
    iceCandidatePoolSize: 10,
    iceTransportPolicy: 'all'
};

function startCall(video = false) {
    console.log('📞 startCall called:', { video, selectedUser: state.selectedUser?.id, socketConnected: state.socket?.connected });
    
    if (!state.selectedUser) {
        console.warn('❌ Нет выбранного пользователя для звонка');
        return;
    }
    if (!state.socket || !state.socket.connected) {
        console.warn('❌ Socket не подключён');
        showToast('Нет соединения с сервером', 'error');
        return;
    }
    
    isVideoCall = video;
    currentCallUser = state.selectedUser;
    
    const callModal = document.getElementById('call-modal');
    const callAvatar = document.getElementById('call-avatar');
    const callName = document.getElementById('call-name');
    const callStatus = document.getElementById('call-status');
    
    callAvatar.textContent = state.selectedUser.username[0].toUpperCase();
    callName.textContent = state.selectedUser.username;
    callStatus.textContent = 'Вызов...';
    document.getElementById('call-timer').classList.add('hidden');
    document.getElementById('call-videos').classList.add('hidden');
    callModal.classList.remove('hidden');
    hideCallBar();
    
    initCall(video);
}

async function initCall(video) {
    console.log('📞 initCall started:', { video });
    
    try {
        console.log('🎤 Запрашиваем доступ к медиа...');
        localStream = await navigator.mediaDevices.getUserMedia({
            audio: true,
            video: video
        });
        console.log('✅ Медиа получено:', localStream.getTracks().map(t => t.kind));
        
        if (video) {
            document.getElementById('local-video').srcObject = localStream;
            document.getElementById('call-videos').classList.remove('hidden');
        }
        
        console.log('🔗 Создаём RTCPeerConnection...');
        peerConnection = new RTCPeerConnection(iceServers);
        
        localStream.getTracks().forEach(track => {
            peerConnection.addTrack(track, localStream);
        });
        
        peerConnection.ontrack = (event) => {
            console.log('📥 Получен remote track:', event.track.kind);
            const remoteVideo = document.getElementById('remote-video');
            if (event.streams && event.streams[0]) {
                remoteVideo.srcObject = event.streams[0];
            } else {
                if (!remoteVideo.srcObject) {
                    remoteVideo.srcObject = new MediaStream();
                }
                remoteVideo.srcObject.addTrack(event.track);
            }
            
            if (event.track.kind === 'video') {
                document.getElementById('call-videos').classList.remove('hidden');
            }
            
            // Обработка отключения трека
            event.track.onended = () => {
                console.log('📥 Remote track ended:', event.track.kind);
                if (event.track.kind === 'video') {
                    remoteVideo.srcObject = null;
                }
                checkHideVideos();
            };
            
            // Обработка mute/unmute (когда трек отключается без удаления)
            event.track.onmute = () => {
                console.log('📥 Remote track muted:', event.track.kind);
                if (event.track.kind === 'video') {
                    checkHideVideos();
                }
            };
            
            event.track.onunmute = () => {
                console.log('📥 Remote track unmuted:', event.track.kind);
                if (event.track.kind === 'video') {
                    document.getElementById('call-videos').classList.remove('hidden');
                }
            };
        };
        
        peerConnection.onicecandidate = (event) => {
            if (event.candidate && currentCallUser) {
                // Логируем тип кандидата для диагностики
                const candidateType = event.candidate.candidate.includes('relay') ? 'relay (TURN)' :
                                     event.candidate.candidate.includes('srflx') ? 'srflx (STUN)' :
                                     event.candidate.candidate.includes('host') ? 'host (local)' : 'unknown';
                console.log(`🧊 ICE candidate [${candidateType}]:`, event.candidate.candidate.substring(0, 80));
                state.socket.emit('ice-candidate', {
                    to: currentCallUser.id,
                    candidate: event.candidate
                });
            } else if (!event.candidate) {
                console.log('🧊 ICE gathering завершён');
            }
        };
        
        // Отслеживаем процесс сбора ICE кандидатов
        peerConnection.onicegatheringstatechange = () => {
            console.log('🧊 ICE gathering state:', peerConnection.iceGatheringState);
            if (peerConnection.iceGatheringState === 'complete') {
                console.log('✅ Все ICE кандидаты собраны');
            }
        };
        
        peerConnection.oniceconnectionstatechange = () => {
            console.log('🧊 ICE connection state:', peerConnection.iceConnectionState);
            const statusEl = document.getElementById('call-status');
            
            if (peerConnection.iceConnectionState === 'connected' || peerConnection.iceConnectionState === 'completed') {
                statusEl.textContent = 'Соединено';
                if (!callTimer) startCallTimer();
            } else if (peerConnection.iceConnectionState === 'failed') {
                statusEl.textContent = 'Ошибка соединения';
                console.error('❌ ICE connection failed! Возможно TURN серверы недоступны');
                // Показываем пользователю понятное сообщение
                showToast('Не удалось установить соединение. Проверьте интернет.', 'error');
            } else if (peerConnection.iceConnectionState === 'disconnected') {
                statusEl.textContent = 'Переподключение...';
            } else if (peerConnection.iceConnectionState === 'checking') {
                statusEl.textContent = 'Подключение...';
            }
        };
        
        // Добавляем обработчик состояния сигнализации
        peerConnection.onsignalingstatechange = () => {
            console.log('📡 Signaling state:', peerConnection.signalingState);
        };
        
        // Добавляем обработчик состояния соединения
        peerConnection.onconnectionstatechange = () => {
            console.log('🔌 Connection state:', peerConnection.connectionState);
            if (peerConnection.connectionState === 'failed') {
                console.error('❌ Connection failed');
                document.getElementById('call-status').textContent = 'Ошибка соединения';
            }
        };
        
        console.log('📤 Создаём offer...');
        const offer = await peerConnection.createOffer();
        await peerConnection.setLocalDescription(offer);
        console.log('✅ Offer создан, отправляем call-user');
        
        state.socket.emit('call-user', {
            to: state.selectedUser.id,
            offer: offer,
            isVideo: video
        });
        
        updateVideoButtonState();
    } catch (err) {
        console.error('❌ Ошибка доступа к медиа:', err);
        endCall(false);
        showToast('Не удалось получить доступ к камере/микрофону', 'error');
    }
}

let stopCallSound = null;

function handleIncomingCall(data) {
    console.log('📞 Входящий звонок:', data);
    incomingCallData = data;
    document.getElementById('incoming-call-avatar').textContent = data.fromName[0].toUpperCase();
    document.getElementById('incoming-call-name').textContent = data.fromName;
    document.getElementById('incoming-call-type').textContent = data.isVideo ? '📹 Видеозвонок' : '📞 Аудиозвонок';
    document.getElementById('incoming-call-modal').classList.remove('hidden');
    
    // Воспроизводим звук звонка
    ensureSoundsInitialized();
    stopCallSound = sounds.playCall?.();
}

async function acceptCall() {
    console.log('📞 acceptCall called:', incomingCallData);
    if (!incomingCallData) {
        console.warn('❌ Нет данных входящего звонка');
        return;
    }
    
    // Останавливаем звук звонка
    if (stopCallSound) {
        stopCallSound();
        stopCallSound = null;
    }
    
    document.getElementById('incoming-call-modal').classList.add('hidden');
    isVideoCall = incomingCallData.isVideo;
    currentCallUser = { id: incomingCallData.from, username: incomingCallData.fromName };
    currentCallId = incomingCallData.callId;
    
    const callModal = document.getElementById('call-modal');
    document.getElementById('call-avatar').textContent = incomingCallData.fromName[0].toUpperCase();
    document.getElementById('call-name').textContent = incomingCallData.fromName;
    document.getElementById('call-status').textContent = 'Подключение...';
    document.getElementById('call-videos').classList.add('hidden');
    callModal.classList.remove('hidden');
    
    try {
        console.log('🎤 Запрашиваем доступ к медиа (acceptCall)...');
        localStream = await navigator.mediaDevices.getUserMedia({
            audio: true,
            video: isVideoCall
        });
        console.log('✅ Медиа получено');
        
        if (isVideoCall) {
            document.getElementById('local-video').srcObject = localStream;
            document.getElementById('call-videos').classList.remove('hidden');
        }
        
        console.log('🔗 Создаём RTCPeerConnection (acceptCall)...');
        peerConnection = new RTCPeerConnection(iceServers);
        
        localStream.getTracks().forEach(track => {
            peerConnection.addTrack(track, localStream);
        });
        
        peerConnection.ontrack = (event) => {
            console.log('📥 Получен remote track (acceptCall):', event.track.kind);
            const remoteVideo = document.getElementById('remote-video');
            if (event.streams && event.streams[0]) {
                remoteVideo.srcObject = event.streams[0];
            } else {
                if (!remoteVideo.srcObject) {
                    remoteVideo.srcObject = new MediaStream();
                }
                remoteVideo.srcObject.addTrack(event.track);
            }
            
            if (event.track.kind === 'video') {
                document.getElementById('call-videos').classList.remove('hidden');
            }
            
            // Обработка отключения трека
            event.track.onended = () => {
                console.log('📥 Remote track ended (acceptCall):', event.track.kind);
                if (event.track.kind === 'video') {
                    remoteVideo.srcObject = null;
                }
                checkHideVideos();
            };
            
            // Обработка mute/unmute
            event.track.onmute = () => {
                console.log('📥 Remote track muted (acceptCall):', event.track.kind);
                if (event.track.kind === 'video') {
                    checkHideVideos();
                }
            };
            
            event.track.onunmute = () => {
                console.log('📥 Remote track unmuted (acceptCall):', event.track.kind);
                if (event.track.kind === 'video') {
                    document.getElementById('call-videos').classList.remove('hidden');
                }
            };
        };
        
        peerConnection.onicecandidate = (event) => {
            if (event.candidate && currentCallUser) {
                console.log('🧊 Отправляем ICE candidate (acceptCall)');
                state.socket.emit('ice-candidate', {
                    to: currentCallUser.id,
                    candidate: event.candidate
                });
            }
        };
        
        peerConnection.oniceconnectionstatechange = () => {
            console.log('🧊 ICE state (acceptCall):', peerConnection.iceConnectionState);
            const statusEl = document.getElementById('call-status');
            
            if (peerConnection.iceConnectionState === 'connected' || peerConnection.iceConnectionState === 'completed') {
                statusEl.textContent = 'Соединено';
                if (!callTimer) startCallTimer();
            } else if (peerConnection.iceConnectionState === 'failed') {
                statusEl.textContent = 'Ошибка соединения';
                console.warn('❌ ICE connection failed (acceptCall), restarting...');
                peerConnection.restartIce();
            } else if (peerConnection.iceConnectionState === 'disconnected') {
                statusEl.textContent = 'Переподключение...';
            }
        };
        
        peerConnection.onsignalingstatechange = () => {
            console.log('📡 Signaling state (acceptCall):', peerConnection.signalingState);
        };
        
        peerConnection.onconnectionstatechange = () => {
            console.log('🔌 Connection state (acceptCall):', peerConnection.connectionState);
        };
        
        console.log('📥 Устанавливаем remote description (offer)...');
        await peerConnection.setRemoteDescription(incomingCallData.offer);
        
        console.log('📤 Создаём answer...');
        const answer = await peerConnection.createAnswer();
        await peerConnection.setLocalDescription(answer);
        
        console.log('✅ Answer создан, отправляем call-answer');
        state.socket.emit('call-answer', {
            to: incomingCallData.from,
            answer: answer,
            callId: currentCallId
        });
        
        updateVideoButtonState();
    } catch (err) {
        console.error('❌ Ошибка acceptCall:', err);
        endCall(false);
        showToast('Не удалось принять звонок', 'error');
    }
}

function declineCall() {
    // Останавливаем звук звонка
    if (stopCallSound) {
        stopCallSound();
        stopCallSound = null;
    }
    
    if (incomingCallData) {
        state.socket.emit('call-decline', { to: incomingCallData.from, callId: incomingCallData.callId });
    }
    document.getElementById('incoming-call-modal').classList.add('hidden');
    incomingCallData = null;
}

async function handleCallAnswered(data) {
    console.log('📞 handleCallAnswered:', data);
    currentCallId = data.callId;
    if (peerConnection) {
        try {
            console.log('📥 Устанавливаем remote description (answer)...');
            const answer = new RTCSessionDescription(data.answer);
            await peerConnection.setRemoteDescription(answer);
            console.log('✅ Remote description установлен');
            document.getElementById('call-status').textContent = 'Подключение...';
        } catch (e) {
            console.error('❌ Error setting remote description:', e);
        }
    } else {
        console.warn('❌ peerConnection не существует в handleCallAnswered');
    }
}

function handleCallDeclined() {
    console.log('📞 handleCallDeclined');
    document.getElementById('call-status').textContent = 'Звонок отклонён';
    setTimeout(() => endCall(false), 2000);
}

function handleCallEnded() {
    cleanupCall();
    document.getElementById('call-modal').classList.add('hidden');
    hideCallBar();
}

function handleCallFailed(data) {
    console.log('📞 handleCallFailed:', data);
    document.getElementById('call-status').textContent = data.reason;
    setTimeout(() => endCall(false), 2000);
}

async function handleIceCandidate(data) {
    if (peerConnection && data.candidate) {
        try {
            const candidate = new RTCIceCandidate(data.candidate);
            await peerConnection.addIceCandidate(candidate);
            console.log('🧊 ICE candidate добавлен');
        } catch (e) {
            // Игнорируем ошибки если remote description ещё не установлен
            if (e.name !== 'InvalidStateError') {
                console.error('❌ ICE candidate error:', e);
            }
        }
    }
}

function handleCallMessage(message) {
    if (state.selectedUser && (message.sender_id === state.selectedUser.id || message.receiver_id === state.selectedUser.id)) {
        appendCallMessage(message);
    }
    updateContactsList();
}

async function handleVideoRenegotiate(data) {
    if (!peerConnection || !currentCallUser) return;
    
    try {
        // Создаём RTCSessionDescription из полученных данных
        const offer = new RTCSessionDescription(data.offer);
        await peerConnection.setRemoteDescription(offer);
        
        const answer = await peerConnection.createAnswer();
        await peerConnection.setLocalDescription(answer);
        
        state.socket.emit('video-renegotiate-answer', {
            to: currentCallUser.id,
            answer: answer
        });
    } catch (e) {
        console.error('Renegotiate error:', e);
    }
}

async function handleVideoRenegotiateAnswer(data) {
    if (!peerConnection) return;
    
    try {
        const answer = new RTCSessionDescription(data.answer);
        await peerConnection.setRemoteDescription(answer);
    } catch (e) {
        console.error('Renegotiate answer error:', e);
    }
}

function handleScreenShareStarted(data) {
    // Собеседник начал демонстрацию экрана
    console.log('Screen share started by:', data.from);
    // Показываем видео контейнер
    document.getElementById('call-videos').classList.remove('hidden');
}

function handleScreenShareStopped(data) {
    // Собеседник закончил демонстрацию экрана
    console.log('Screen share stopped by:', data.from);
    
    // Скрываем remote video если это была демонстрация экрана
    const remoteVideo = document.getElementById('remote-video');
    if (remoteVideo) {
        remoteVideo.srcObject = null;
    }
    
    checkHideVideos();
}

function handleVideoStateChanged(data) {
    // Собеседник включил/выключил камеру
    console.log('Video state changed by:', data.from, 'enabled:', data.videoEnabled);
    
    const remoteVideo = document.getElementById('remote-video');
    if (!remoteVideo) return;
    
    if (!data.videoEnabled) {
        // Собеседник выключил камеру - скрываем его видео
        remoteVideo.srcObject = null;
        checkHideVideos();
    }
}

function startCallTimer() {
    callSeconds = 0;
    const timerEl = document.getElementById('call-timer');
    timerEl.classList.remove('hidden');
    
    callTimer = setInterval(() => {
        callSeconds++;
        const mins = Math.floor(callSeconds / 60).toString().padStart(2, '0');
        const secs = (callSeconds % 60).toString().padStart(2, '0');
        timerEl.textContent = `${mins}:${secs}`;
        updateCallBarTimer();
    }, 1000);
}

function cleanupCall() {
    if (callTimer) {
        clearInterval(callTimer);
        callTimer = null;
    }
    
    if (localStream) {
        localStream.getTracks().forEach(track => {
            track.stop();
            track.enabled = false;
        });
        localStream = null;
    }
    
    if (screenStream) {
        screenStream.getTracks().forEach(track => {
            track.stop();
            track.enabled = false;
        });
        screenStream = null;
    }
    
    if (peerConnection) {
        // Удаляем все обработчики
        peerConnection.ontrack = null;
        peerConnection.onicecandidate = null;
        peerConnection.oniceconnectionstatechange = null;
        peerConnection.close();
        peerConnection = null;
    }
    
    // Очищаем видео элементы
    const localVideo = document.getElementById('local-video');
    const remoteVideo = document.getElementById('remote-video');
    if (localVideo) localVideo.srcObject = null;
    if (remoteVideo) remoteVideo.srcObject = null;
    
    isScreenSharing = false;
    isMuted = false;
    isVideoCall = false;
    currentCallUser = null;
    currentCallId = null;
    incomingCallData = null;
    hideCallBar();
}

function endCall(sendEnd = true) {
    if (sendEnd && currentCallUser && currentCallId && state.socket) {
        state.socket.emit('call-end', { to: currentCallUser.id, callId: currentCallId });
    }
    
    cleanupCall();
    document.getElementById('call-modal').classList.add('hidden');
    hideCallBar();
}

async function toggleMute() {
    if (localStream) {
        isMuted = !isMuted;
        
        const audioTrack = localStream.getAudioTracks()[0];
        
        // Если трек сломан (ended) и мы пытаемся включить микрофон - восстанавливаем
        if (!isMuted && (!audioTrack || audioTrack.readyState === 'ended')) {
            console.log('🎤 Audio track broken, restoring...');
            await restoreAudioAfterScreenShare();
        } else if (audioTrack) {
            audioTrack.enabled = !isMuted;
        }
        
        const muteBtn = document.getElementById('mute-btn');
        const muteBtnIcon = document.getElementById('mute-btn-icon');
        muteBtn.classList.toggle('active', !isMuted);
        if (muteBtnIcon) {
            muteBtnIcon.src = isMuted ? '/assets/Block-microphone.svg' : '/assets/microphone.svg';
        }
    }
}

async function toggleVideo() {
    if (!localStream || !peerConnection || !currentCallUser) return;
    
    let videoTrack = localStream.getVideoTracks()[0];
    const videoSender = peerConnection.getSenders().find(s => s.track?.kind === 'video' || s.track === null);
    
    // Проверяем текущее состояние видео
    const isVideoEnabled = videoTrack?.enabled && videoTrack?.readyState === 'live';
    
    if (isVideoEnabled) {
        // Выключаем видео
        videoTrack.enabled = false;
        
        // Уведомляем собеседника
        state.socket.emit('video-state-changed', {
            to: currentCallUser.id,
            videoEnabled: false
        });
        
        // Заменяем трек на null в sender
        if (videoSender) {
            await videoSender.replaceTrack(null);
        }
        
        checkHideVideos();
    } else {
        // Включаем видео - всегда пересоздаём трек для надёжности
        try {
            console.log('📹 Включаем видео, создаём новый трек...');
            
            // Останавливаем старый трек если есть
            if (videoTrack) {
                videoTrack.stop();
                localStream.removeTrack(videoTrack);
            }
            
            // Создаём новый видео трек
            const newStream = await navigator.mediaDevices.getUserMedia({ video: true });
            const newVideoTrack = newStream.getVideoTracks()[0];
            
            localStream.addTrack(newVideoTrack);
            document.getElementById('local-video').srcObject = localStream;
            document.getElementById('call-videos').classList.remove('hidden');
            
            // Заменяем или добавляем трек в sender
            if (videoSender) {
                await videoSender.replaceTrack(newVideoTrack);
                console.log('📹 Видео трек заменён в sender');
            } else {
                peerConnection.addTrack(newVideoTrack, localStream);
                console.log('📹 Видео трек добавлен, нужен renegotiation');
                
                const offer = await peerConnection.createOffer();
                await peerConnection.setLocalDescription(offer);
                
                state.socket.emit('video-renegotiate', {
                    to: currentCallUser.id,
                    offer: offer
                });
            }
            
            // Уведомляем собеседника
            state.socket.emit('video-state-changed', {
                to: currentCallUser.id,
                videoEnabled: true
            });
            
        } catch (e) {
            console.error('📹 Не удалось включить видео:', e);
            alert('Не удалось получить доступ к камере');
            return;
        }
    }
    
    updateVideoButtonState();
}


function updateVideoButtonState() {
    const videoTrack = localStream?.getVideoTracks()[0];
    const toggleVideoBtn = document.getElementById('toggle-video-btn');
    const videoBtnIcon = document.getElementById('video-btn-icon');
    if (toggleVideoBtn) {
        const hasVideo = videoTrack?.enabled;
        toggleVideoBtn.classList.toggle('active', hasVideo);
        if (videoBtnIcon) {
            videoBtnIcon.src = hasVideo ? '/assets/video.svg' : '/assets/video-off.svg';
        }
    }
}

function checkHideVideos() {
    const localVideo = document.getElementById('local-video');
    const remoteVideo = document.getElementById('remote-video');
    const callVideos = document.getElementById('call-videos');
    
    // Проверяем есть ли активное видео
    const localHasVideo = isScreenSharing || (localStream?.getVideoTracks().some(t => t.enabled && !t.muted));
    const localSrcValid = localVideo?.srcObject?.getVideoTracks().some(t => t.readyState === 'live');
    const remoteHasVideo = remoteVideo?.srcObject?.getVideoTracks().some(t => t.enabled && !t.muted && t.readyState === 'live');
    
    console.log('checkHideVideos:', { localHasVideo, localSrcValid, remoteHasVideo, isScreenSharing });
    
    // Скрываем local video если нет видео и не демонстрация экрана
    if (localVideo && !localHasVideo && !localSrcValid) {
        localVideo.srcObject = null;
    }
    
    // Скрываем remote video если нет видео
    if (remoteVideo && !remoteHasVideo) {
        remoteVideo.srcObject = null;
    }
    
    // Скрываем весь контейнер если нет ни одного видео
    const shouldHide = !localHasVideo && !localSrcValid && !remoteHasVideo;
    if (shouldHide) {
        callVideos?.classList.add('hidden');
    }
}

async function toggleScreenShare() {
    if (!peerConnection || !currentCallUser) return;
    
    const screenShareBtn = document.getElementById('screen-share-btn');
    
    if (isScreenSharing) {
        await stopScreenShare();
    } else {
        try {
            // Запрашиваем только видео, аудио оставляем от микрофона
            screenStream = await navigator.mediaDevices.getDisplayMedia({
                video: {
                    cursor: 'always',
                    displaySurface: 'monitor'
                },
                audio: false // НЕ берём аудио от экрана, чтобы не ломать микрофон
            });
            
            const screenTrack = screenStream.getVideoTracks()[0];
            
            // Находим видео sender и заменяем трек
            const videoSender = peerConnection.getSenders().find(s => s.track?.kind === 'video');
            if (videoSender) {
                await videoSender.replaceTrack(screenTrack);
            } else {
                // Если нет видео трека, добавляем новый и делаем renegotiation
                peerConnection.addTrack(screenTrack, screenStream);
                
                const offer = await peerConnection.createOffer();
                await peerConnection.setLocalDescription(offer);
                
                state.socket.emit('video-renegotiate', {
                    to: currentCallUser.id,
                    offer: offer
                });
            }
            
            // Уведомляем собеседника о начале демонстрации
            state.socket.emit('screen-share-started', { to: currentCallUser.id });
            
            document.getElementById('local-video').srcObject = screenStream;
            document.getElementById('call-videos').classList.remove('hidden');
            isScreenSharing = true;
            screenShareBtn?.classList.add('active');
            const screenBtnIcon = document.getElementById('screen-btn-icon');
            if (screenBtnIcon) screenBtnIcon.src = '/assets/screen-share-off.svg';
            
            // Когда пользователь останавливает демонстрацию через браузер
            screenTrack.onended = () => stopScreenShare();
        } catch (e) {
            console.error('Ошибка демонстрации экрана:', e);
            if (e.name !== 'NotAllowedError') {
                alert('Не удалось начать демонстрацию экрана');
            }
        }
    }
}

// Восстановление аудио после демонстрации экрана
async function restoreAudioAfterScreenShare() {
    if (!peerConnection || !localStream) return;
    
    console.log('🎤 Restoring audio after screen share...');
    
    // Получаем текущий аудио трек и sender
    const currentAudioTrack = localStream.getAudioTracks()[0];
    let audioSender = peerConnection.getSenders().find(s => s.track?.kind === 'audio' || (s.track === null && !s._isVideo));
    
    console.log('🎤 Current audio track:', currentAudioTrack?.readyState, 'enabled:', currentAudioTrack?.enabled);
    console.log('🎤 Audio sender track:', audioSender?.track?.kind, audioSender?.track?.readyState);
    
    // Проверяем все senders
    const allSenders = peerConnection.getSenders();
    console.log('🎤 All senders:', allSenders.map(s => ({ kind: s.track?.kind, state: s.track?.readyState })));
    
    // Всегда пересоздаём аудио трек для надёжности
    try {
        console.log('🎤 Recreating audio track...');
        const newAudioStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        const newAudioTrack = newAudioStream.getAudioTracks()[0];
        
        // Останавливаем старый трек если есть
        if (currentAudioTrack) {
            currentAudioTrack.stop();
            localStream.removeTrack(currentAudioTrack);
        }
        
        // Добавляем новый трек в localStream
        localStream.addTrack(newAudioTrack);
        
        // Находим audio sender (может быть с null треком)
        audioSender = peerConnection.getSenders().find(s => 
            s.track?.kind === 'audio' || 
            (s.track === null && allSenders.indexOf(s) === allSenders.findIndex(x => x.track?.kind !== 'video' && x.track !== null ? x.track.kind === 'audio' : true))
        );
        
        // Если нет audio sender, ищем любой sender без video трека
        if (!audioSender) {
            audioSender = peerConnection.getSenders().find(s => s.track?.kind !== 'video');
        }
        
        if (audioSender) {
            await audioSender.replaceTrack(newAudioTrack);
            console.log('🎤 Audio track replaced in sender');
        } else {
            // Если sender не найден, добавляем трек напрямую
            console.log('🎤 No audio sender found, adding track directly');
            peerConnection.addTrack(newAudioTrack, localStream);
        }
        
        // Применяем текущее состояние mute
        newAudioTrack.enabled = !isMuted;
        console.log('🎤 Audio restored successfully, enabled:', newAudioTrack.enabled, 'muted:', isMuted);
        
    } catch (e) {
        console.error('🎤 Failed to restore audio:', e);
    }
}

async function stopScreenShare() {
    if (!isScreenSharing || !peerConnection) return;
    
    console.log('🖥️ Stopping screen share...');
    
    // Останавливаем треки демонстрации экрана
    if (screenStream) {
        screenStream.getTracks().forEach(track => {
            console.log('🖥️ Stopping screen track:', track.kind, track.label);
            track.stop();
        });
        screenStream = null;
    }
    
    const localVideo = document.getElementById('local-video');
    const videoTrack = localStream?.getVideoTracks()[0];
    const videoSender = peerConnection.getSenders().find(s => s.track?.kind === 'video' || s.track === null);
    
    if (videoTrack && videoTrack.enabled && videoSender) {
        // Возвращаем камеру
        await videoSender.replaceTrack(videoTrack);
        localVideo.srcObject = localStream;
    } else {
        // Если камеры нет, очищаем local video и отправляем null трек
        localVideo.srcObject = null;
        if (videoSender) {
            await videoSender.replaceTrack(null);
        }
    }
    
    // ВАЖНО: Восстанавливаем аудио трек после демонстрации экрана
    // Всегда пересоздаём аудио, т.к. демонстрация экрана может сломать его
    await restoreAudioAfterScreenShare();
    
    // Уведомляем собеседника об окончании демонстрации
    if (currentCallUser && state.socket) {
        state.socket.emit('screen-share-stopped', { to: currentCallUser.id });
        // Также отправляем что видео выключено
        state.socket.emit('video-state-changed', {
            to: currentCallUser.id,
            videoEnabled: !!(videoTrack && videoTrack.enabled)
        });
    }
    
    isScreenSharing = false;
    document.getElementById('screen-share-btn')?.classList.remove('active');
    const screenBtnIcon = document.getElementById('screen-btn-icon');
    if (screenBtnIcon) screenBtnIcon.src = '/assets/screen-share.svg';
    
    // Проверяем нужно ли скрыть видео контейнер
    checkHideVideos();
}

// Drag для local-video (перетаскивание по углам)
function initLocalVideoDrag() {
    const localVideo = document.getElementById('local-video');
    if (!localVideo) return;
    
    let isDragging = false;
    let startX, startY;
    let currentPos = 'bottom-right'; // Начальная позиция
    
    const positions = ['top-left', 'top-right', 'bottom-left', 'bottom-right'];
    
    function getPosition(x, y, container) {
        const rect = container.getBoundingClientRect();
        const centerX = rect.left + rect.width / 2;
        const centerY = rect.top + rect.height / 2;
        
        const isTop = y < centerY;
        const isLeft = x < centerX;
        
        if (isTop && isLeft) return 'top-left';
        if (isTop && !isLeft) return 'top-right';
        if (!isTop && isLeft) return 'bottom-left';
        return 'bottom-right';
    }
    
    function setPosition(pos) {
        positions.forEach(p => localVideo.classList.remove(`pos-${p}`));
        localVideo.classList.add(`pos-${pos}`);
        currentPos = pos;
    }
    
    // Mouse events
    localVideo.addEventListener('mousedown', (e) => {
        isDragging = true;
        startX = e.clientX;
        startY = e.clientY;
        localVideo.classList.add('dragging');
        e.preventDefault();
    });
    
    document.addEventListener('mousemove', (e) => {
        if (!isDragging) return;
        
        const container = document.getElementById('call-videos');
        if (!container) return;
        
        const newPos = getPosition(e.clientX, e.clientY, container);
        if (newPos !== currentPos) {
            setPosition(newPos);
        }
    });
    
    document.addEventListener('mouseup', () => {
        if (isDragging) {
            isDragging = false;
            localVideo.classList.remove('dragging');
        }
    });
    
    // Touch events
    localVideo.addEventListener('touchstart', (e) => {
        isDragging = true;
        const touch = e.touches[0];
        startX = touch.clientX;
        startY = touch.clientY;
        localVideo.classList.add('dragging');
    }, { passive: true });
    
    document.addEventListener('touchmove', (e) => {
        if (!isDragging) return;
        
        const container = document.getElementById('call-videos');
        if (!container) return;
        
        const touch = e.touches[0];
        const newPos = getPosition(touch.clientX, touch.clientY, container);
        if (newPos !== currentPos) {
            setPosition(newPos);
        }
    }, { passive: true });
    
    document.addEventListener('touchend', () => {
        if (isDragging) {
            isDragging = false;
            localVideo.classList.remove('dragging');
        }
    });
    
    // Двойной клик для смены позиции
    localVideo.addEventListener('dblclick', () => {
        const currentIndex = positions.indexOf(currentPos);
        const nextIndex = (currentIndex + 1) % positions.length;
        setPosition(positions[nextIndex]);
    });
}

function appendCallMessage(msg) {
    const messagesDiv = document.getElementById('messages');
    const isSent = msg.sender_id === state.currentUser.id;
    const duration = msg.call_duration || 0;
    const mins = Math.floor(duration / 60);
    const secs = duration % 60;
    const durationText = duration > 0 ? `${mins}:${secs.toString().padStart(2, '0')}` : '';
    const iconSrc = msg.message_type === 'video_call' ? '/assets/video.svg' : '/assets/phone-call.svg';
    
    const div = document.createElement('div');
    div.className = `message ${isSent ? 'sent' : 'received'} call-message`;
    div.innerHTML = `
        <div class="message-content">
            <div class="message-bubble call-bubble">
                <span class="call-icon"><img src="${iconSrc}" alt="" class="icon-sm"></span>
                <span class="call-text">${escapeHtml(msg.text)}</span>
                ${durationText ? `<span class="call-duration">${durationText}</span>` : ''}
            </div>
            <div class="message-time">${formatTime(msg.created_at)}</div>
        </div>
    `;
    messagesDiv.appendChild(div);
    messagesDiv.scrollTop = messagesDiv.scrollHeight;
}

// Call bar (Dynamic Island style)
function showCallBar() {
    if (currentCallUser) {
        const bar = document.getElementById('active-call-bar');
        document.getElementById('call-bar-name').textContent = currentCallUser.username;
        bar.classList.remove('hidden');
    }
}

function hideCallBar() {
    const bar = document.getElementById('active-call-bar');
    bar.classList.add('hidden');
}

function updateCallBarTimer() {
    const mins = Math.floor(callSeconds / 60).toString().padStart(2, '0');
    const secs = (callSeconds % 60).toString().padStart(2, '0');
    document.getElementById('call-bar-timer').textContent = `${mins}:${secs}`;
}

function expandCall() {
    document.getElementById('call-modal').classList.remove('hidden');
    hideCallBar();
}


// === ИНИЦИАЛИЗАЦИЯ DOM ===
document.addEventListener('DOMContentLoaded', () => {
    // Регистрация Service Worker
    registerServiceWorker();
    
    // Инициализация делегирования событий
    initUserListEvents();
    
    // Инициализация звуков при первом взаимодействии
    document.addEventListener('click', ensureSoundsInitialized, { once: true });
    document.addEventListener('keydown', ensureSoundsInitialized, { once: true });
    
    // Сохраняем инвайт-ссылку до авторизации
    savePendingInvite();
    
    // Восстановление сессии
    if (restoreSession()) {
        showChat();
    }
    
    // Применяем настройки
    applySettings();
    
    // === ФОРМЫ АВТОРИЗАЦИИ ===
    
    const loginForm = getEl('login-form');
    const registerForm = getEl('register-form');
    const loginError = getEl('login-error');
    const registerError = getEl('register-error');
    
    // Переключение форм
    document.getElementById('to-register-btn')?.addEventListener('click', () => {
        document.getElementById('login-screen').classList.add('hidden');
        document.getElementById('register-screen').classList.remove('hidden');
        loginError.textContent = '';
    });
    
    document.getElementById('to-login-btn')?.addEventListener('click', () => {
        document.getElementById('register-screen').classList.add('hidden');
        document.getElementById('login-screen').classList.remove('hidden');
        registerError.textContent = '';
    });
    
    // Галочки согласия при регистрации
    const agreeTerms = document.getElementById('agree-terms');
    const agreePrivacy = document.getElementById('agree-privacy');
    const registerBtn = document.getElementById('register-btn');
    
    function updateRegisterButton() {
        if (registerBtn) {
            registerBtn.disabled = !(agreeTerms?.checked && agreePrivacy?.checked);
        }
    }
    
    agreeTerms?.addEventListener('change', updateRegisterButton);
    agreePrivacy?.addEventListener('change', updateRegisterButton);
    
    // Вход
    loginForm?.addEventListener('submit', async (e) => {
        e.preventDefault();
        loginError.textContent = '';
        
        const username = document.getElementById('login-username').value;
        const password = document.getElementById('login-password').value;
        
        const result = await login(username, password);
        
        if (!result.success) {
            loginError.textContent = result.error;
        }
    });
    
    // Регистрация
    registerForm?.addEventListener('submit', async (e) => {
        e.preventDefault();
        registerError.textContent = '';
        registerError.className = 'error';
        
        const username = document.getElementById('reg-username').value;
        const password = document.getElementById('reg-password').value;
        const confirm = document.getElementById('reg-password-confirm').value;
        
        const usernameRegex = /^[a-zA-Z0-9_]{3,20}$/;
        if (!usernameRegex.test(username)) {
            registerError.textContent = 'Ник: 3-20 символов, только буквы, цифры и _';
            return;
        }
        
        if (password !== confirm) {
            registerError.textContent = 'Пароли не совпадают';
            return;
        }
        
        if (password.length < 6) {
            registerError.textContent = 'Пароль минимум 6 символов';
            return;
        }
        
        const result = await register(username, password);
        
        if (result.success) {
            registerError.className = 'success';
            registerError.textContent = 'Успешно! Переход...';
            setTimeout(() => {
                document.getElementById('register-screen').classList.add('hidden');
                document.getElementById('login-screen').classList.remove('hidden');
                document.getElementById('login-username').value = username;
                registerError.textContent = '';
            }, 1000);
        } else {
            registerError.textContent = result.error;
        }
    });
    
    // === ПОИСК ===
    
    const searchInput = document.querySelector('.search-input');
    let searchTimeout;
    
    searchInput?.addEventListener('input', (e) => {
        clearTimeout(searchTimeout);
        searchTimeout = setTimeout(() => {
            searchUsers(e.target.value.trim());
        }, 300);
    });
    
    // === СООБЩЕНИЯ ===
    
    const messageForm = document.getElementById('message-form');
    const messageInput = document.getElementById('message-input');
    
    messageForm?.addEventListener('submit', (e) => {
        e.preventDefault();
        sendMessage();
    });
    
    messageInput?.addEventListener('input', () => {
        if (messageInput.value.trim()) {
            startTyping();
        } else {
            stopTyping();
        }
    });
    
    // Кнопка прикрепления файла
    document.getElementById('attach-btn')?.addEventListener('click', () => {
        if (!state.selectedUser && !state.selectedGroup && !state.selectedChannel && !state.selectedServerChannel) {
            showToast('Сначала выберите чат', 'error');
            return;
        }
        document.getElementById('attach-input')?.click();
    });
    
    document.getElementById('attach-input')?.addEventListener('change', handleAttachFile);
    
    // === САМОУНИЧТОЖАЮЩИЕСЯ СООБЩЕНИЯ (Premium+) ===
    const selfDestructBtn = document.getElementById('self-destruct-btn');
    const selfDestructMenu = document.getElementById('self-destruct-menu');
    
    // Показываем кнопку только для Premium+
    function updateSelfDestructVisibility() {
        const isPremiumPlus = state.currentUserProfile?.premiumPlan === 'premium_plus' || state.currentUser?.role === 'admin';
        if (selfDestructBtn) {
            selfDestructBtn.classList.toggle('hidden', !isPremiumPlus);
        }
    }
    
    selfDestructBtn?.addEventListener('click', (e) => {
        e.stopPropagation();
        
        // Позиционируем меню над кнопкой
        if (selfDestructMenu && selfDestructBtn) {
            const btnRect = selfDestructBtn.getBoundingClientRect();
            selfDestructMenu.style.left = `${btnRect.left}px`;
            selfDestructMenu.style.bottom = `${window.innerHeight - btnRect.top + 10}px`;
        }
        
        selfDestructMenu?.classList.toggle('hidden');
    });
    
    document.querySelectorAll('.self-destruct-option').forEach(opt => {
        opt.addEventListener('click', () => {
            const minutes = parseInt(opt.dataset.minutes);
            state.selfDestructMinutes = minutes;
            
            // Обновляем UI
            document.querySelectorAll('.self-destruct-option').forEach(o => o.classList.remove('active'));
            opt.classList.add('active');
            selfDestructBtn?.classList.toggle('active', minutes > 0);
            selfDestructMenu?.classList.add('hidden');
            
            if (minutes > 0) {
                showToast(`Сообщения будут удалены через ${formatSelfDestructTime(minutes)}`);
            } else {
                showToast('Самоуничтожение отключено');
            }
        });
    });
    
    // Закрытие меню при клике вне
    document.addEventListener('click', (e) => {
        if (selfDestructMenu && !selfDestructMenu.contains(e.target) && e.target !== selfDestructBtn) {
            selfDestructMenu.classList.add('hidden');
        }
    });
    
    // Форматирование времени самоуничтожения
    function formatSelfDestructTime(minutes) {
        if (minutes < 60) return `${minutes} мин`;
        if (minutes < 1440) return `${Math.floor(minutes / 60)} ч`;
        return `${Math.floor(minutes / 1440)} д`;
    }
    
    // Вызываем при загрузке профиля
    window.updateSelfDestructVisibility = updateSelfDestructVisibility;
    
    // === ПРОФИЛЬ ===
    
    // Аватарка теперь часть user-panel, обработчик там
    document.getElementById('close-profile')?.addEventListener('click', () => {
        document.getElementById('profile-modal').classList.add('hidden');
    });
    
    document.getElementById('edit-profile-btn')?.addEventListener('click', showEditProfile);
    document.getElementById('close-edit-profile')?.addEventListener('click', () => {
        document.getElementById('edit-profile-modal').classList.add('hidden');
    });
    
    document.getElementById('save-profile-btn')?.addEventListener('click', saveProfile);
    
    // Аватарка и баннер
    document.getElementById('edit-avatar-preview')?.addEventListener('click', () => {
        document.getElementById('edit-avatar-input').click();
    });
    
    document.getElementById('edit-banner-preview')?.addEventListener('click', () => {
        document.getElementById('edit-banner-input').click();
    });
    
    document.getElementById('edit-avatar-input')?.addEventListener('change', handleAvatarChange);
    document.getElementById('edit-banner-input')?.addEventListener('change', handleBannerChange);
    
    // Профиль собеседника / информация о чате (клик на аватар/имя)
    function handleHeaderClick(e) {
        e.stopPropagation();
        if (state.selectedUser) {
            showUserProfile(state.selectedUser.id);
        } else if (state.selectedGroup) {
            showGroupInfo(state.selectedGroup.id);
        } else if (state.selectedChannel) {
            showChannelInfo(state.selectedChannel.id);
        } else if (state.selectedServer) {
            showServerInfo(state.selectedServer.id);
        }
    }
    
    document.querySelector('.chat-header-info')?.addEventListener('click', handleHeaderClick);
    document.querySelector('.chat-header-avatar')?.addEventListener('click', handleHeaderClick);
    
    // Контекстное меню чата (3 точки)
    const chatMenuBtn = document.getElementById('chat-menu-btn');
    const chatContextMenu = document.getElementById('chat-context-menu');
    
    chatMenuBtn?.addEventListener('click', (e) => {
        e.stopPropagation();
        if (!state.selectedUser) return;
        
        // Обновляем состояние уведомлений
        const isMuted = isUserMuted(state.selectedUser.id);
        document.getElementById('ctx-notif-icon').innerHTML = isMuted 
            ? '<img src="/assets/bell.svg" alt="" class="icon-sm" style="opacity:0.5">' 
            : '<img src="/assets/bell.svg" alt="" class="icon-sm">';
        document.getElementById('ctx-notif-text').textContent = isMuted ? 'Включить уведомления' : 'Отключить уведомления';
        
        // Обновляем состояние закрепления
        const userItem = document.querySelector(`[data-id="${state.selectedUser.id}"]`);
        const isPinned = userItem?.classList.contains('pinned');
        document.getElementById('ctx-pin-icon').innerHTML = isPinned 
            ? '<img src="/assets/bookmark-slash.svg" alt="" class="icon-sm">' 
            : '<img src="/assets/bookmark.svg" alt="" class="icon-sm">';
        document.getElementById('ctx-pin-text').textContent = isPinned ? 'Открепить чат' : 'Закрепить чат';
        
        // Позиционируем меню под кнопкой
        const btnRect = chatMenuBtn.getBoundingClientRect();
        chatContextMenu.style.top = `${btnRect.bottom + 8}px`;
        chatContextMenu.style.right = `${window.innerWidth - btnRect.right}px`;
        chatContextMenu.style.left = 'auto';
        
        chatContextMenu?.classList.toggle('hidden');
    });
    
    // Закрытие меню при клике вне
    document.addEventListener('click', (e) => {
        if (chatContextMenu && !chatContextMenu.contains(e.target) && e.target !== chatMenuBtn) {
            chatContextMenu.classList.add('hidden');
        }
    });
    
    // Пункты контекстного меню
    document.getElementById('ctx-view-profile')?.addEventListener('click', () => {
        chatContextMenu?.classList.add('hidden');
        if (state.selectedUser) {
            showUserProfile(state.selectedUser.id);
        }
    });
    
    document.getElementById('ctx-set-nickname')?.addEventListener('click', async () => {
        chatContextMenu?.classList.add('hidden');
        if (!state.selectedUser) return;
        
        const currentNickname = getLocalNickname(state.selectedUser.id);
        const nickname = await customPrompt({
            title: 'Записать как...',
            message: 'Этот никнейм будете видеть только вы',
            icon: '✏️',
            placeholder: 'Введите никнейм',
            defaultValue: currentNickname || '',
            okText: 'Сохранить',
            cancelText: 'Отмена'
        });
        
        if (nickname !== null) {
            setLocalNickname(state.selectedUser.id, nickname);
            // Обновляем отображение
            const displayName = nickname || state.selectedUserProfile?.display_name || state.selectedUser.username;
            document.querySelector('.chat-user-name').textContent = displayName;
            updateContactsList();
            showToast(nickname ? 'Никнейм сохранён' : 'Никнейм удалён');
        }
    });
    
    document.getElementById('ctx-toggle-notifications')?.addEventListener('click', () => {
        chatContextMenu?.classList.add('hidden');
        if (!state.selectedUser) return;
        
        const isMuted = toggleUserMuted(state.selectedUser.id);
        showToast(isMuted ? 'Уведомления отключены' : 'Уведомления включены');
    });
    
    document.getElementById('ctx-clear-chat')?.addEventListener('click', async () => {
        chatContextMenu?.classList.add('hidden');
        if (!state.selectedUser) return;
        
        const confirmed = await customConfirm({
            title: 'Очистить чат',
            message: 'Сообщения будут удалены только у вас',
            icon: '🗑️',
            variant: 'danger',
            okText: 'Очистить',
            cancelText: 'Отмена'
        });
        
        if (confirmed) {
            document.getElementById('messages').innerHTML = '';
            showToast('Чат очищен');
        }
    });
    
    // Закрепление чата
    document.getElementById('ctx-pin-chat')?.addEventListener('click', async () => {
        chatContextMenu?.classList.add('hidden');
        if (!state.selectedUser) return;
        
        const userItem = document.querySelector(`[data-id="${state.selectedUser.id}"]`);
        const isPinned = userItem?.classList.contains('pinned');
        
        try {
            if (isPinned) {
                // Открепить
                const res = await api.request(`/api/chats/${state.selectedUser.id}/pin?chatType=user`, { method: 'DELETE' });
                const data = await res.json();
                if (data.success) {
                    showToast('Чат откреплён');
                    updateContactsList();
                } else {
                    showToast(data.error || 'Ошибка', 'error');
                }
            } else {
                // Закрепить
                const res = await api.post(`/api/chats/${state.selectedUser.id}/pin`, { chatType: 'user' });
                const data = await res.json();
                if (data.success) {
                    showToast(`Чат закреплён (${data.currentCount}/${data.limit})`);
                    updateContactsList();
                } else {
                    showToast(data.error || 'Ошибка', 'error');
                }
            }
        } catch (error) {
            console.error('Pin chat error:', error);
            showToast('Ошибка закрепления', 'error');
        }
    });
    
    document.getElementById('close-user-profile')?.addEventListener('click', () => {
        document.getElementById('user-profile-modal').classList.add('hidden');
    });
    
    // Закрытие модалок групп/каналов/серверов
    document.getElementById('close-group-info')?.addEventListener('click', () => {
        document.getElementById('group-info-modal').classList.add('hidden');
    });
    document.getElementById('close-channel-info')?.addEventListener('click', () => {
        document.getElementById('channel-info-modal').classList.add('hidden');
    });
    document.getElementById('close-server-info')?.addEventListener('click', () => {
        document.getElementById('server-info-modal').classList.add('hidden');
    });
    
    // Закрытие по клику на overlay
    ['group-info-modal', 'channel-info-modal', 'server-info-modal'].forEach(modalId => {
        document.querySelector(`#${modalId} .modal-overlay`)?.addEventListener('click', () => {
            document.getElementById(modalId).classList.add('hidden');
        });
    });
    
    // === РЕДАКТИРОВАНИЕ ГРУППЫ/КАНАЛА/СЕРВЕРА (одна кнопка) ===
    
    // Открыть модалку редактирования группы
    document.getElementById('edit-group-btn')?.addEventListener('click', () => {
        const groupId = document.getElementById('group-info-modal').dataset.groupId;
        if (!groupId) return;
        openEditGroupModal(groupId);
    });
    
    // Закрыть модалку редактирования группы
    document.getElementById('close-edit-group')?.addEventListener('click', () => {
        document.getElementById('edit-group-modal').classList.add('hidden');
    });
    document.querySelector('#edit-group-modal .modal-overlay')?.addEventListener('click', () => {
        document.getElementById('edit-group-modal').classList.add('hidden');
    });
    
    // Клик на баннер/аватар группы для загрузки
    document.getElementById('edit-group-banner-preview')?.addEventListener('click', () => {
        document.getElementById('edit-group-banner-input').click();
    });
    document.getElementById('edit-group-avatar-preview')?.addEventListener('click', () => {
        document.getElementById('edit-group-avatar-input').click();
    });
    
    // Загрузка баннера группы
    document.getElementById('edit-group-banner-input')?.addEventListener('change', async (e) => {
        const file = e.target.files[0];
        if (!file) return;
        const preview = document.getElementById('edit-group-banner-preview');
        preview.style.backgroundImage = `url(${URL.createObjectURL(file)})`;
        e.target.value = '';
    });
    
    // Загрузка аватара группы
    document.getElementById('edit-group-avatar-input')?.addEventListener('change', async (e) => {
        const file = e.target.files[0];
        if (!file) return;
        const preview = document.getElementById('edit-group-avatar-preview');
        preview.style.backgroundImage = `url(${URL.createObjectURL(file)})`;
        e.target.value = '';
    });
    
    // Сохранить группу
    document.getElementById('save-group-btn')?.addEventListener('click', saveGroupChanges);
    
    // === РЕДАКТИРОВАНИЕ КАНАЛА ===
    
    document.getElementById('edit-channel-btn')?.addEventListener('click', () => {
        const channelId = document.getElementById('channel-info-modal').dataset.channelId;
        if (!channelId) return;
        openEditChannelModal(channelId);
    });
    
    document.getElementById('close-edit-channel')?.addEventListener('click', () => {
        document.getElementById('edit-channel-modal').classList.add('hidden');
    });
    document.querySelector('#edit-channel-modal .modal-overlay')?.addEventListener('click', () => {
        document.getElementById('edit-channel-modal').classList.add('hidden');
    });
    
    document.getElementById('edit-channel-avatar-preview')?.addEventListener('click', () => {
        document.getElementById('edit-channel-avatar-input').click();
    });
    
    document.getElementById('edit-channel-avatar-input')?.addEventListener('change', async (e) => {
        const file = e.target.files[0];
        if (!file) return;
        const preview = document.getElementById('edit-channel-avatar-preview');
        preview.style.backgroundImage = `url(${URL.createObjectURL(file)})`;
        e.target.value = '';
    });
    
    document.getElementById('save-channel-btn')?.addEventListener('click', saveChannelChanges);
    
    // === РЕДАКТИРОВАНИЕ СЕРВЕРА ===
    
    document.getElementById('edit-server-btn')?.addEventListener('click', () => {
        const serverId = document.getElementById('server-info-modal').dataset.serverId;
        if (!serverId) return;
        openEditServerModal(serverId);
    });
    
    document.getElementById('close-edit-server')?.addEventListener('click', () => {
        document.getElementById('edit-server-modal').classList.add('hidden');
    });
    document.querySelector('#edit-server-modal .modal-overlay')?.addEventListener('click', () => {
        document.getElementById('edit-server-modal').classList.add('hidden');
    });
    
    document.getElementById('edit-server-banner-preview')?.addEventListener('click', () => {
        document.getElementById('edit-server-banner-input').click();
    });
    document.getElementById('edit-server-avatar-preview')?.addEventListener('click', () => {
        document.getElementById('edit-server-avatar-input').click();
    });
    
    document.getElementById('edit-server-banner-input')?.addEventListener('change', async (e) => {
        const file = e.target.files[0];
        if (!file) return;
        const preview = document.getElementById('edit-server-banner-preview');
        preview.style.backgroundImage = `url(${URL.createObjectURL(file)})`;
        e.target.value = '';
    });
    
    document.getElementById('edit-server-avatar-input')?.addEventListener('change', async (e) => {
        const file = e.target.files[0];
        if (!file) return;
        const preview = document.getElementById('edit-server-avatar-preview');
        preview.style.backgroundImage = `url(${URL.createObjectURL(file)})`;
        e.target.value = '';
    });
    
    document.getElementById('save-server-btn')?.addEventListener('click', saveServerChanges);
    
    // === НАСТРОЙКИ ===
    
    document.getElementById('settings-btn')?.addEventListener('click', showSettings);
    document.getElementById('close-settings')?.addEventListener('click', () => {
        document.getElementById('settings-modal').classList.add('hidden');
    });
    
    // Обработчик выхода (для обеих кнопок)
    const handleLogout = async () => {
        const confirmed = await customConfirm({
            title: 'Выход из аккаунта',
            message: 'Вы уверены, что хотите выйти?',
            icon: '🚪',
            variant: 'warning',
            okText: 'Выйти',
            cancelText: 'Остаться'
        });
        if (confirmed) logout();
    };
    
    document.getElementById('logout-btn')?.addEventListener('click', handleLogout);
    document.getElementById('logout-btn-mobile')?.addEventListener('click', handleLogout);
    document.getElementById('nav-logout-btn')?.addEventListener('click', handleLogout);
    
    // Кнопка админ-панели
    document.getElementById('admin-btn')?.addEventListener('click', () => {
        document.getElementById('settings-modal').classList.add('hidden');
        showAdminPanel();
    });
    
    // Навигация по разделам настроек
    document.querySelectorAll('.settings-nav-item').forEach(item => {
        item.addEventListener('click', () => {
            document.querySelectorAll('.settings-nav-item').forEach(i => i.classList.remove('active'));
            document.querySelectorAll('.settings-section').forEach(s => s.classList.remove('active'));
            item.classList.add('active');
            document.getElementById(`section-${item.dataset.section}`)?.classList.add('active');
        });
    });
    
    // Настройки уведомлений
    document.getElementById('notifications-checkbox')?.addEventListener('change', (e) => {
        state.notificationsEnabled = e.target.checked;
        localStorage.setItem('notifications', state.notificationsEnabled);
        if (state.notificationsEnabled) {
            requestNotificationPermission();
        }
    });
    
    document.getElementById('sounds-checkbox')?.addEventListener('change', (e) => {
        state.settings.sounds = e.target.checked;
        saveSettings();
    });
    
    document.getElementById('setting-compact')?.addEventListener('change', (e) => {
        state.settings.compact = e.target.checked;
        saveSettings();
        applySettings();
    });
    
    document.getElementById('setting-avatars')?.addEventListener('change', (e) => {
        state.settings.hideAvatars = !e.target.checked;
        saveSettings();
        applySettings();
    });
    
    // Фон чата
    document.querySelectorAll('.bg-option').forEach(opt => {
        opt.addEventListener('click', () => {
            if (opt.dataset.bg === 'custom') {
                document.getElementById('custom-bg-input').click();
                return;
            }
            document.querySelectorAll('.bg-option').forEach(o => o.classList.remove('active'));
            opt.classList.add('active');
            state.settings.background = opt.dataset.bg;
            saveSettings();
            applySettings();
        });
    });
    
    // Размер сообщений
    document.querySelectorAll('.size-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.size-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            state.settings.messageSize = btn.dataset.size;
            saveSettings();
            applySettings();
        });
    });
    
    // Акцентный цвет
    document.querySelectorAll('.color-option').forEach(opt => {
        opt.addEventListener('click', () => {
            document.querySelectorAll('.color-option').forEach(o => o.classList.remove('active'));
            opt.classList.add('active');
            state.settings.accentColor = opt.dataset.color;
            saveSettings();
            applySettings();
        });
    });
    
    // Тема
    document.querySelectorAll('.theme-option').forEach(opt => {
        opt.addEventListener('click', () => {
            document.querySelectorAll('.theme-option').forEach(o => o.classList.remove('active'));
            opt.classList.add('active');
            state.settings.theme = opt.dataset.theme;
            saveSettings();
            applyTheme(opt.dataset.theme);
        });
    });
    
    // === EMOJI ===
    
    const emojiBtn = document.querySelector('.emoji-btn');
    const emojiPicker = document.getElementById('emoji-picker');
    const emojiGrid = document.querySelector('.emoji-grid');
    
    const emojis = [
        '😀', '😃', '😄', '😁', '😅', '😂', '🤣', '😊',
        '😇', '🙂', '😉', '😍', '🥰', '😘', '😋', '😜',
        '🤪', '😎', '🤩', '🥳', '😏', '😒', '😞', '😢',
        '😭', '😤', '😡', '🤬', '😱', '😨', '😰', '😥',
        '🤔', '🤫', '🤭', '🙄', '😬', '😮', '😯', '😲',
        '🥱', '😴', '🤤', '😷', '🤒', '🤕', '🤢', '🤮',
        '👍', '👎', '👌', '✌️', '🤞', '🤟', '🤘', '👋',
        '👏', '🙌', '👐', '🤲', '🤝', '🙏', '💪', '🦾',
        '❤️', '🧡', '💛', '💚', '💙', '💜', '🖤', '🤍',
        '💯', '💢', '💥', '💫', '💦', '💨', '🔥', '⭐',
        '🎉', '🎊', '🎁', '🎈', '🏆', '🥇', '🎯', '🎮'
    ];
    
    if (emojiGrid) {
        emojis.forEach(emoji => {
            const span = document.createElement('span');
            span.className = 'emoji-item';
            span.textContent = emoji;
            span.addEventListener('click', () => {
                messageInput.value += emoji;
                messageInput.focus();
                emojiPicker.classList.add('hidden');
            });
            emojiGrid.appendChild(span);
        });
    }
    
    emojiBtn?.addEventListener('click', (e) => {
        e.stopPropagation();
        if (!state.selectedUser && !state.selectedGroup && !state.selectedChannel && !state.selectedServerChannel) {
            showToast('Сначала выберите чат', 'error');
            return;
        }
        emojiPicker?.classList.toggle('hidden');
    });
    
    document.addEventListener('click', (e) => {
        if (emojiPicker && !emojiPicker.contains(e.target) && e.target !== emojiBtn) {
            emojiPicker.classList.add('hidden');
        }
    });
    
    // === МОБИЛЬНАЯ НАВИГАЦИЯ ===
    
    document.getElementById('back-btn')?.addEventListener('click', () => {
        document.querySelector('.sidebar')?.classList.remove('hidden-mobile');
        document.getElementById('chat-screen')?.classList.remove('chat-open');
    });
    
    window.addEventListener('resize', () => {
        if (!isMobile()) {
            document.querySelector('.sidebar')?.classList.remove('hidden-mobile');
            document.getElementById('chat-screen')?.classList.remove('chat-open');
        }
    });
    
    // === ЗВОНКИ ===
    
    document.getElementById('mute-btn')?.addEventListener('click', toggleMute);
    document.getElementById('toggle-video-btn')?.addEventListener('click', toggleVideo);
    document.getElementById('screen-share-btn')?.addEventListener('click', toggleScreenShare);
    document.getElementById('end-call-btn')?.addEventListener('click', () => endCall(true));
    
    document.getElementById('accept-call-btn')?.addEventListener('click', acceptCall);
    document.getElementById('decline-call-btn')?.addEventListener('click', declineCall);
    
    // Drag для local-video
    initLocalVideoDrag();
    
    // Call bar
    document.getElementById('active-call-bar')?.addEventListener('click', (e) => {
        if (!e.target.closest('.call-bar-btn')) {
            expandCall();
        }
    });
    
    document.getElementById('call-bar-expand')?.addEventListener('click', expandCall);
    document.getElementById('call-bar-end')?.addEventListener('click', () => endCall(true));
    
    // Сворачивание звонка
    document.querySelector('.call-overlay')?.addEventListener('click', () => {
        if (currentCallUser && callTimer) {
            document.getElementById('call-modal').classList.add('hidden');
            showCallBar();
        }
    });
    
    // === МОДАЛЬНЫЕ ОКНА ===
    
    document.querySelectorAll('.modal-overlay').forEach(overlay => {
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) {
                const modal = overlay.closest('.modal');
                if (modal && !modal.id.includes('call')) {
                    modal.classList.add('hidden');
                }
            }
        });
    });
    
    // Системная тема
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
        if (state.settings.theme === 'system') {
            applyTheme('system');
        }
    });
});

// === ПРОФИЛЬ ФУНКЦИИ ===

let pendingAvatarFile = null;
let pendingBannerFile = null;

async function showMyProfile() {
    await loadMyProfile();
    
    const profile = state.currentUserProfile;
    const modalContent = document.querySelector('#profile-modal .profile-modal-content');
    const avatarEl = document.getElementById('profile-avatar');
    const bannerEl = document.getElementById('profile-banner');
    
    // Применяем кастомный цвет фона профиля к модалке
    if (profile?.profile_color && modalContent) {
        modalContent.style.setProperty('--profile-color', profile.profile_color);
        modalContent.setAttribute('data-profile-color', '');
    } else if (modalContent) {
        modalContent.style.removeProperty('--profile-color');
        modalContent.removeAttribute('data-profile-color');
    }
    
    if (profile?.avatar_url) {
        avatarEl.style.backgroundImage = `url(${profile.avatar_url})`;
        avatarEl.style.backgroundSize = 'cover';
        avatarEl.style.backgroundPosition = 'center';
        avatarEl.textContent = '';
    } else {
        avatarEl.style.backgroundImage = '';
        avatarEl.style.background = 'var(--message-sent)';
        avatarEl.textContent = state.currentUser.username[0].toUpperCase();
    }
    
    if (profile?.banner_url) {
        bannerEl.style.backgroundImage = `url(${profile.banner_url})`;
        bannerEl.style.backgroundSize = 'cover';
        bannerEl.style.backgroundPosition = 'center';
        bannerEl.className = 'profile-banner';
    } else if (profile?.profile_theme && profile.profile_theme !== 'default') {
        bannerEl.style.backgroundImage = '';
        bannerEl.className = `profile-banner theme-${profile.profile_theme}`;
    } else {
        bannerEl.style.backgroundImage = '';
        bannerEl.style.background = 'linear-gradient(135deg, #4fc3f7, #1976d2)';
        bannerEl.className = 'profile-banner';
    }
    
    document.getElementById('profile-name').textContent = profile?.display_name || state.currentUser.username;
    document.getElementById('profile-username').textContent = '@' + state.currentUser.username;
    
    // Отображаем тег (ID) - используем custom_id если есть (Premium), иначе обычный tag
    const displayTag = profile?.custom_id || profile?.tag || state.currentUser.tag;
    const tagEl = document.getElementById('profile-tag');
    if (tagEl) {
        tagEl.textContent = displayTag ? `${state.currentUser.username}#${displayTag}` : '';
        tagEl.title = 'Нажмите чтобы скопировать';
        tagEl.onclick = () => {
            navigator.clipboard.writeText(`${state.currentUser.username}#${displayTag}`);
            showToast('ID скопирован!');
        };
    }
    
    // Отображаем бейджи (несколько рядом как в Discord)
    const badgesEl = document.getElementById('profile-badges');
    if (badgesEl) {
        const role = profile?.role || state.currentUser.role;
        const isPremium = profile?.isPremium;
        let badges = '';
        
        if (role === 'admin') {
            badges += '<span class="profile-badge admin">Админ</span>';
        }
        if (isPremium) {
            const premiumPlan = profile?.premiumPlan || profile?.premium_plan;
            if (premiumPlan === 'premium_plus') {
                badges += '<span class="profile-badge premium-plus">Premium+</span>';
            } else {
                badges += '<span class="profile-badge premium">Premium</span>';
            }
        }
        
        badgesEl.innerHTML = badges;
    }
    
    document.getElementById('profile-bio').textContent = profile?.bio || '';
    
    document.getElementById('profile-modal').classList.remove('hidden');
}

function showEditProfile() {
    document.getElementById('profile-modal').classList.add('hidden');
    
    document.getElementById('edit-username').value = state.currentUser.username || '';
    document.getElementById('edit-display-name').value = state.currentUserProfile?.display_name || '';
    document.getElementById('edit-bio').value = state.currentUserProfile?.bio || '';
    
    const avatarPreview = document.getElementById('edit-avatar-preview');
    if (state.currentUserProfile?.avatar_url) {
        avatarPreview.style.backgroundImage = `url(${state.currentUserProfile.avatar_url})`;
        avatarPreview.innerHTML = '';
    } else {
        avatarPreview.style.backgroundImage = '';
        avatarPreview.innerHTML = '<span class="edit-avatar-icon">📷</span>';
    }
    
    const bannerPreview = document.getElementById('edit-banner-preview');
    if (state.currentUserProfile?.banner_url) {
        bannerPreview.style.backgroundImage = `url(${state.currentUserProfile.banner_url})`;
        bannerPreview.style.background = '';
    } else {
        bannerPreview.style.backgroundImage = '';
        bannerPreview.style.background = 'linear-gradient(135deg, #4fc3f7, #1976d2)';
    }
    
    pendingAvatarFile = null;
    pendingBannerFile = null;
    document.getElementById('username-hint').textContent = '';
    
    // Premium настройки - показываем всем, но блокируем для не-премиум
    const premiumSection = document.getElementById('premium-settings-section');
    const premiumOverlay = document.getElementById('premium-lock-overlay');
    const isPremium = state.currentUserProfile?.isPremium || state.currentUser?.role === 'admin';
    
    if (premiumSection) {
        document.getElementById('edit-name-color').value = state.currentUserProfile?.name_color || '#4fc3f7';
        document.getElementById('edit-profile-color').value = state.currentUserProfile?.profile_color || '#1976d2';
        document.getElementById('edit-custom-id').value = state.currentUserProfile?.custom_id || '';
        
        if (isPremium) {
            premiumSection.classList.remove('locked');
            premiumOverlay?.classList.add('hidden');
        } else {
            premiumSection.classList.add('locked');
            premiumOverlay?.classList.remove('hidden');
        }
    }
    
    document.getElementById('edit-profile-modal').classList.remove('hidden');
}

function handleAvatarChange(e) {
    const file = e.target.files[0];
    if (file) {
        pendingAvatarFile = file;
        const reader = new FileReader();
        reader.onload = (e) => {
            const preview = document.getElementById('edit-avatar-preview');
            preview.style.backgroundImage = `url(${e.target.result})`;
            preview.innerHTML = '';
        };
        reader.readAsDataURL(file);
    }
}

function handleBannerChange(e) {
    const file = e.target.files[0];
    if (file) {
        pendingBannerFile = file;
        const reader = new FileReader();
        reader.onload = (e) => {
            document.getElementById('edit-banner-preview').style.backgroundImage = `url(${e.target.result})`;
        };
        reader.readAsDataURL(file);
    }
}

async function saveProfile() {
    const saveBtn = document.getElementById('save-profile-btn');
    const usernameHint = document.getElementById('username-hint');
    
    saveBtn.disabled = true;
    saveBtn.textContent = 'Сохранение...';
    
    try {
        // Загружаем аватарку
        if (pendingAvatarFile) {
            const formData = new FormData();
            formData.append('avatar', pendingAvatarFile);
            await api.uploadFile(`/api/user/${state.currentUser.id}/avatar`, formData);
        }
        
        // Загружаем баннер
        if (pendingBannerFile) {
            const formData = new FormData();
            formData.append('banner', pendingBannerFile);
            await api.uploadFile(`/api/user/${state.currentUser.id}/banner`, formData);
        }
        
        // Меняем username
        const newUsername = document.getElementById('edit-username').value.trim();
        if (newUsername && newUsername !== state.currentUser.username) {
            const res = await api.put(`/api/user/${state.currentUser.id}/username`, { username: newUsername });
            const result = await res.json();
            
            if (result.success) {
                state.currentUser.username = newUsername;
                localStorage.setItem('kvant_user', JSON.stringify(state.currentUser));
                document.querySelector('.current-user').textContent = newUsername;
            } else {
                usernameHint.textContent = result.error || 'Ошибка смены ника';
                usernameHint.className = 'form-hint error';
                saveBtn.disabled = false;
                saveBtn.textContent = 'Сохранить';
                return;
            }
        }
        
        // Сохраняем остальные данные
        await api.put(`/api/user/${state.currentUser.id}`, {
            display_name: document.getElementById('edit-display-name').value,
            bio: document.getElementById('edit-bio').value
        });
        
        // Сохраняем премиум-настройки
        const isPremium = state.currentUserProfile?.isPremium || state.currentUser?.role === 'admin';
        if (isPremium) {
            const nameColor = document.getElementById('edit-name-color')?.value;
            const profileColor = document.getElementById('edit-profile-color')?.value;
            const customId = document.getElementById('edit-custom-id')?.value?.trim();
            
            await api.put(`/api/user/${state.currentUser.id}/premium-settings`, {
                name_color: nameColor !== '#4fc3f7' ? nameColor : null,
                profile_color: profileColor !== '#1976d2' ? profileColor : null,
                custom_id: customId || null
            });
        }
        
        document.getElementById('edit-profile-modal').classList.add('hidden');
        await loadMyProfile();
        updateCurrentUserAvatar();
        showMyProfile();
    } catch (e) {
        console.error('Save profile error:', e);
        usernameHint.textContent = 'Ошибка сохранения';
        usernameHint.className = 'form-hint error';
    }
    
    saveBtn.disabled = false;
    saveBtn.textContent = 'Сохранить';
}

async function showUserProfile(userId) {
    try {
        const res = await api.get(`/api/user/${userId}`);
        const profile = await res.json();
        
        if (!profile) return;
        
        const modalContent = document.querySelector('#user-profile-modal .profile-modal-content');
        const avatarEl = document.getElementById('user-profile-avatar');
        const bannerEl = document.getElementById('user-profile-banner');
        
        // Применяем кастомный цвет фона профиля к модалке
        if (profile.profile_color && modalContent) {
            modalContent.style.setProperty('--profile-color', profile.profile_color);
            modalContent.setAttribute('data-profile-color', '');
        } else if (modalContent) {
            modalContent.style.removeProperty('--profile-color');
            modalContent.removeAttribute('data-profile-color');
        }
        
        if (profile.avatar_url) {
            avatarEl.style.backgroundImage = `url(${profile.avatar_url})`;
            avatarEl.style.backgroundSize = 'cover';
            avatarEl.style.backgroundPosition = 'center';
            avatarEl.textContent = '';
        } else {
            avatarEl.style.backgroundImage = '';
            avatarEl.style.background = 'var(--message-sent)';
            avatarEl.textContent = profile.username[0].toUpperCase();
        }
        
        if (profile.banner_url) {
            bannerEl.style.backgroundImage = `url(${profile.banner_url})`;
            bannerEl.style.backgroundSize = 'cover';
            bannerEl.style.backgroundPosition = 'center';
        } else {
            bannerEl.style.backgroundImage = '';
            bannerEl.style.background = 'linear-gradient(135deg, #4fc3f7, #1976d2)';
        }
        
        document.getElementById('user-profile-name').textContent = profile.display_name || profile.username;
        document.getElementById('user-profile-username').textContent = '@' + profile.username;
        
        // Тег - используем custom_id если есть (Premium), иначе обычный tag
        const tagEl = document.getElementById('user-profile-tag');
        const userDisplayTag = profile.custom_id || profile.tag;
        if (tagEl && userDisplayTag) {
            tagEl.textContent = `${profile.username}#${userDisplayTag}`;
            tagEl.onclick = () => {
                navigator.clipboard.writeText(`${profile.username}#${userDisplayTag}`);
                showToast('ID скопирован!');
            };
        }
        
        // Бейджи (несколько рядом как в Discord)
        const badgesEl = document.getElementById('user-profile-badges');
        if (badgesEl) {
            let badges = '';
            if (profile.role === 'admin') {
                badges += '<span class="profile-badge admin">Админ</span>';
            }
            if (profile.isPremium) {
                const premiumPlan = profile.premiumPlan || profile.premium_plan;
                if (premiumPlan === 'premium_plus') {
                    badges += '<span class="profile-badge premium-plus">Premium+</span>';
                } else {
                    badges += '<span class="profile-badge premium">Premium</span>';
                }
            }
            badgesEl.innerHTML = badges;
        }
        
        document.getElementById('user-profile-bio').textContent = profile.bio || '';
        
        document.getElementById('user-profile-modal').classList.remove('hidden');
    } catch (e) {
        console.error('Error loading user profile:', e);
    }
}

// === ИНФОРМАЦИЯ О ГРУППАХ/КАНАЛАХ/СЕРВЕРАХ ===

async function showGroupInfo(groupId) {
    try {
        const [groupRes, membersRes, mediaRes] = await Promise.all([
            api.get(`/api/groups/${groupId}`),
            api.get(`/api/groups/${groupId}/members`),
            api.get(`/api/groups/${groupId}/media`)
        ]);
        
        const group = await groupRes.json();
        const members = await membersRes.json();
        const media = await mediaRes.json();
        
        if (!group) return;
        
        // Проверяем владельца
        const isOwner = group.owner_id === state.currentUser.id;
        
        // Баннер
        const bannerEl = document.getElementById('group-info-banner');
        if (group.banner_url) {
            bannerEl.style.backgroundImage = `url(${group.banner_url})`;
        } else {
            bannerEl.style.backgroundImage = '';
        }
        
        // Аватар
        const avatarEl = document.getElementById('group-info-avatar');
        if (group.avatar_url) {
            avatarEl.style.backgroundImage = `url(${group.avatar_url})`;
            avatarEl.innerHTML = '';
        } else {
            avatarEl.style.backgroundImage = '';
            avatarEl.innerHTML = '<img src="/assets/group.svg" alt="" class="icon-lg">';
        }
        
        // Показываем/скрываем кнопку редактирования
        document.getElementById('edit-group-btn')?.classList.toggle('hidden', !isOwner);
        
        // Инфо
        document.getElementById('group-info-name').textContent = group.name;
        document.getElementById('group-info-meta').textContent = `${members.length} участников`;
        document.getElementById('group-info-desc').textContent = group.description || 'Нет описания';
        
        // Участники
        const membersList = document.getElementById('group-members-list');
        membersList.innerHTML = members.map(m => `
            <div class="chat-info-member" data-user-id="${m.user_id}">
                <div class="chat-info-member-avatar" style="${m.avatar_url ? `background-image: url(${m.avatar_url})` : ''}">
                    ${m.avatar_url ? '' : (m.username?.[0]?.toUpperCase() || '?')}
                </div>
                <div class="chat-info-member-info">
                    <div class="chat-info-member-name">${m.display_name || m.username}</div>
                    <div class="chat-info-member-role ${m.role}">${m.role === 'owner' ? 'Владелец' : m.role === 'admin' ? 'Админ' : ''}</div>
                </div>
            </div>
        `).join('');
        
        // Клик на участника
        membersList.querySelectorAll('.chat-info-member').forEach(el => {
            el.addEventListener('click', () => {
                document.getElementById('group-info-modal').classList.add('hidden');
                showUserProfile(el.dataset.userId);
            });
        });
        
        // Медиа
        renderMediaGrid('group-media-grid', media);
        
        // Табы
        setupInfoTabs('group-info-modal');
        
        // Сохраняем ID группы для редактирования
        document.getElementById('group-info-modal').dataset.groupId = groupId;
        
        document.getElementById('group-info-modal').classList.remove('hidden');
    } catch (e) {
        console.error('Error loading group info:', e);
    }
}

async function showChannelInfo(channelId) {
    try {
        const [channelRes, mediaRes] = await Promise.all([
            api.get(`/api/channels/${channelId}`),
            api.get(`/api/channels/${channelId}/media`)
        ]);
        
        const channel = await channelRes.json();
        const media = await mediaRes.json();
        
        if (!channel) return;
        
        // Проверяем владельца
        const isOwner = channel.owner_id === state.currentUser.id;
        
        // Аватар
        const avatarEl = document.getElementById('channel-info-avatar');
        if (channel.avatar_url) {
            avatarEl.style.backgroundImage = `url(${channel.avatar_url})`;
            avatarEl.innerHTML = '';
        } else {
            avatarEl.style.backgroundImage = '';
            avatarEl.innerHTML = '<img src="/assets/megaphone.svg" alt="" class="icon-lg">';
        }
        
        // Показываем/скрываем кнопку редактирования
        document.getElementById('edit-channel-btn')?.classList.toggle('hidden', !isOwner);
        
        // Инфо
        document.getElementById('channel-info-name').textContent = channel.name;
        document.getElementById('channel-info-meta').textContent = `${channel.subscriber_count || 0} подписчиков`;
        document.getElementById('channel-info-desc').textContent = channel.description || 'Нет описания';
        
        // Сохраняем ID канала для редактирования
        document.getElementById('channel-info-modal').dataset.channelId = channelId;
        
        // Ссылка-приглашение
        const linkEl = document.getElementById('channel-info-link');
        const channelLink = `${window.location.origin}/invite/channel/${channelId}`;
        linkEl.innerHTML = `
            <span class="chat-info-link-text">${channelLink}</span>
            <img src="/assets/copy.svg" alt="" class="chat-info-link-copy">
        `;
        linkEl.onclick = () => {
            navigator.clipboard.writeText(channelLink);
            showToast('Ссылка скопирована!');
        };
        
        // Медиа
        renderMediaGrid('channel-media-grid', media);
        
        document.getElementById('channel-info-modal').classList.remove('hidden');
    } catch (e) {
        console.error('Error loading channel info:', e);
    }
}

async function showServerInfo(serverId) {
    try {
        const [serverRes, membersRes, mediaRes] = await Promise.all([
            api.get(`/api/servers/${serverId}`),
            api.get(`/api/servers/${serverId}/members`),
            api.get(`/api/servers/${serverId}/media`)
        ]);
        
        const server = await serverRes.json();
        const members = await membersRes.json();
        const media = await mediaRes.json();
        
        if (!server) return;
        
        // Проверяем владельца
        const isOwner = server.owner_id === state.currentUser.id;
        
        // Аватар
        const avatarEl = document.getElementById('server-info-avatar');
        if (server.icon_url) {
            avatarEl.style.backgroundImage = `url(${server.icon_url})`;
            avatarEl.innerHTML = '';
        } else {
            avatarEl.style.backgroundImage = '';
            avatarEl.innerHTML = '<img src="/assets/Castle.svg" alt="" class="icon-lg">';
        }
        
        // Баннер
        const bannerEl = document.getElementById('server-info-banner');
        if (server.banner_url) {
            bannerEl.style.backgroundImage = `url(${server.banner_url})`;
        } else {
            bannerEl.style.backgroundImage = '';
        }
        
        // Показываем/скрываем кнопку редактирования
        document.getElementById('edit-server-btn')?.classList.toggle('hidden', !isOwner);
        
        // Инфо
        document.getElementById('server-info-name').textContent = server.name;
        document.getElementById('server-info-meta').textContent = `${members.length} участников`;
        document.getElementById('server-info-desc').textContent = server.description || 'Нет описания';
        
        // Сохраняем ID сервера для редактирования
        document.getElementById('server-info-modal').dataset.serverId = serverId;
        
        // Ссылка-приглашение
        const linkEl = document.getElementById('server-info-link');
        if (linkEl) {
            const serverLink = `${window.location.origin}/invite/server/${serverId}`;
            linkEl.innerHTML = `
                <span class="chat-info-link-text">${serverLink}</span>
                <img src="/assets/copy.svg" alt="" class="chat-info-link-copy">
            `;
            linkEl.onclick = () => {
                navigator.clipboard.writeText(serverLink);
                showToast('Ссылка скопирована!');
            };
        }
        
        // Участники
        const membersList = document.getElementById('server-members-list');
        membersList.innerHTML = members.map(m => `
            <div class="chat-info-member" data-user-id="${m.user_id}">
                <div class="chat-info-member-avatar" style="${m.avatar_url ? `background-image: url(${m.avatar_url})` : ''}">
                    ${m.avatar_url ? '' : (m.username?.[0]?.toUpperCase() || '?')}
                </div>
                <div class="chat-info-member-info">
                    <div class="chat-info-member-name">${m.nickname || m.display_name || m.username}</div>
                    <div class="chat-info-member-role">${m.role || ''}</div>
                </div>
            </div>
        `).join('');
        
        // Клик на участника
        membersList.querySelectorAll('.chat-info-member').forEach(el => {
            el.addEventListener('click', () => {
                document.getElementById('server-info-modal').classList.add('hidden');
                showUserProfile(el.dataset.userId);
            });
        });
        
        // Медиа
        renderMediaGrid('server-media-grid', media);
        
        // Табы
        setupInfoTabs('server-info-modal');
        
        document.getElementById('server-info-modal').classList.remove('hidden');
    } catch (e) {
        console.error('Error loading server info:', e);
    }
}

// === ФУНКЦИИ РЕДАКТИРОВАНИЯ ГРУППЫ/КАНАЛА/СЕРВЕРА ===

let editingGroupId = null;
let editingChannelId = null;
let editingServerId = null;

async function openEditGroupModal(groupId) {
    editingGroupId = groupId;
    const name = document.getElementById('group-info-name').textContent;
    const desc = document.getElementById('group-info-desc').textContent;
    const banner = document.getElementById('group-info-banner').style.backgroundImage;
    const avatar = document.getElementById('group-info-avatar').style.backgroundImage;
    
    document.getElementById('edit-group-name-input').value = name;
    document.getElementById('edit-group-desc-input').value = desc === 'Нет описания' ? '' : desc;
    
    const bannerPreview = document.getElementById('edit-group-banner-preview');
    bannerPreview.style.backgroundImage = banner || '';
    
    const avatarPreview = document.getElementById('edit-group-avatar-preview');
    if (avatar) {
        avatarPreview.style.backgroundImage = avatar;
    } else {
        avatarPreview.style.backgroundImage = '';
        avatarPreview.innerHTML = '<img src="/assets/group.svg" alt="" class="icon-lg">';
    }
    
    document.getElementById('edit-group-modal').classList.remove('hidden');
}

async function saveGroupChanges() {
    if (!editingGroupId) return;
    
    const name = document.getElementById('edit-group-name-input').value.trim();
    const description = document.getElementById('edit-group-desc-input').value.trim();
    
    if (!name) {
        showToast('Название не может быть пустым', 'error');
        return;
    }
    
    try {
        // Сохраняем название и описание
        const res = await api.put(`/api/groups/${editingGroupId}`, { name, description });
        const data = await res.json();
        
        if (!data.success) {
            showToast(data.error || 'Ошибка', 'error');
            return;
        }
        
        // Загружаем аватар если выбран
        const avatarInput = document.getElementById('edit-group-avatar-input');
        if (avatarInput.files[0]) {
            const formData = new FormData();
            formData.append('avatar', avatarInput.files[0]);
            await api.uploadFile(`/api/groups/${editingGroupId}/avatar`, formData);
        }
        
        // Загружаем баннер если выбран
        const bannerInput = document.getElementById('edit-group-banner-input');
        if (bannerInput.files[0]) {
            const formData = new FormData();
            formData.append('banner', bannerInput.files[0]);
            await api.uploadFile(`/api/groups/${editingGroupId}/banner`, formData);
        }
        
        showToast('Группа обновлена!');
        document.getElementById('edit-group-modal').classList.add('hidden');
        
        // Обновляем информацию
        showGroupInfo(editingGroupId);
        loadGroups();
    } catch (err) {
        console.error('Save group error:', err);
        showToast('Ошибка сохранения', 'error');
    }
}

async function openEditChannelModal(channelId) {
    editingChannelId = channelId;
    const name = document.getElementById('channel-info-name').textContent;
    const desc = document.getElementById('channel-info-desc').textContent;
    const avatar = document.getElementById('channel-info-avatar').style.backgroundImage;
    
    document.getElementById('edit-channel-name-input').value = name;
    document.getElementById('edit-channel-desc-input').value = desc === 'Нет описания' ? '' : desc;
    
    const avatarPreview = document.getElementById('edit-channel-avatar-preview');
    if (avatar) {
        avatarPreview.style.backgroundImage = avatar;
    } else {
        avatarPreview.style.backgroundImage = '';
        avatarPreview.innerHTML = '<img src="/assets/megaphone.svg" alt="" class="icon-lg">';
    }
    
    document.getElementById('edit-channel-modal').classList.remove('hidden');
}

async function saveChannelChanges() {
    if (!editingChannelId) return;
    
    const name = document.getElementById('edit-channel-name-input').value.trim();
    const description = document.getElementById('edit-channel-desc-input').value.trim();
    
    if (!name) {
        showToast('Название не может быть пустым', 'error');
        return;
    }
    
    try {
        const res = await api.put(`/api/channels/${editingChannelId}`, { name, description });
        const data = await res.json();
        
        if (!data.success) {
            showToast(data.error || 'Ошибка', 'error');
            return;
        }
        
        showToast('Канал обновлён!');
        document.getElementById('edit-channel-modal').classList.add('hidden');
        
        showChannelInfo(editingChannelId);
        loadChannels();
    } catch (err) {
        console.error('Save channel error:', err);
        showToast('Ошибка сохранения', 'error');
    }
}

async function openEditServerModal(serverId) {
    editingServerId = serverId;
    const name = document.getElementById('server-info-name').textContent;
    const desc = document.getElementById('server-info-desc').textContent;
    const banner = document.getElementById('server-info-banner').style.backgroundImage;
    const avatar = document.getElementById('server-info-avatar').style.backgroundImage;
    
    document.getElementById('edit-server-name-input').value = name;
    document.getElementById('edit-server-desc-input').value = desc === 'Нет описания' ? '' : desc;
    
    const bannerPreview = document.getElementById('edit-server-banner-preview');
    bannerPreview.style.backgroundImage = banner || '';
    
    const avatarPreview = document.getElementById('edit-server-avatar-preview');
    if (avatar) {
        avatarPreview.style.backgroundImage = avatar;
    } else {
        avatarPreview.style.backgroundImage = '';
        avatarPreview.innerHTML = '<img src="/assets/Castle.svg" alt="" class="icon-lg">';
    }
    
    document.getElementById('edit-server-modal').classList.remove('hidden');
}

async function saveServerChanges() {
    if (!editingServerId) return;
    
    const name = document.getElementById('edit-server-name-input').value.trim();
    const description = document.getElementById('edit-server-desc-input').value.trim();
    
    if (!name) {
        showToast('Название не может быть пустым', 'error');
        return;
    }
    
    try {
        const res = await api.put(`/api/servers/${editingServerId}`, { name, description });
        const data = await res.json();
        
        if (!data.success) {
            showToast(data.error || 'Ошибка', 'error');
            return;
        }
        
        showToast('Сервер обновлён!');
        document.getElementById('edit-server-modal').classList.add('hidden');
        
        showServerInfo(editingServerId);
        loadServers();
    } catch (err) {
        console.error('Save server error:', err);
        showToast('Ошибка сохранения', 'error');
    }
}

function renderMediaGrid(containerId, media) {
    const container = document.getElementById(containerId);
    if (!container) return;
    
    if (!media || media.length === 0) {
        container.innerHTML = '<div class="chat-info-empty">Медиа пока нет</div>';
        return;
    }
    
    container.innerHTML = media.map(item => {
        const url = item.text || item.media_url;
        const type = item.message_type || item.media_type || 'image';
        
        if (type === 'video' || type === 'mp4') {
            return `
                <div class="chat-info-media-item" data-url="${url}">
                    <video src="${url}" muted></video>
                </div>
            `;
        } else {
            return `
                <div class="chat-info-media-item" data-url="${url}">
                    <img src="${url}" alt="" loading="lazy">
                </div>
            `;
        }
    }).join('');
    
    // Клик для просмотра
    container.querySelectorAll('.chat-info-media-item').forEach(item => {
        item.addEventListener('click', () => {
            const url = item.dataset.url;
            window.open(url, '_blank');
        });
    });
}

// Храним инициализированные модалки чтобы не добавлять обработчики повторно
const initializedInfoModals = new Set();

function setupInfoTabs(modalId) {
    // Если уже инициализировано — просто сбрасываем на первый таб
    const modal = document.getElementById(modalId);
    const tabs = modal.querySelectorAll('.chat-info-tab');
    const contents = modal.querySelectorAll('.chat-info-tab-content');
    
    // Сбрасываем на первый таб
    tabs.forEach((t, i) => t.classList.toggle('active', i === 0));
    contents.forEach((c, i) => c.classList.toggle('active', i === 0));
    
    if (initializedInfoModals.has(modalId)) return;
    initializedInfoModals.add(modalId);
    
    tabs.forEach(tab => {
        tab.addEventListener('click', () => {
            tabs.forEach(t => t.classList.remove('active'));
            contents.forEach(c => c.classList.remove('active'));
            
            tab.classList.add('active');
            const tabName = tab.dataset.tab;
            // Формируем ID: group-info-modal -> group, channel-info-modal -> channel
            const prefix = modalId.replace('-info-modal', '');
            modal.querySelector(`#${prefix}-${tabName}-tab`)?.classList.add('active');
        });
    });
}

function showSettings() {
    const settingsAvatar = document.getElementById('settings-avatar');
    const settingsUsername = document.getElementById('settings-username');
    
    if (state.currentUserProfile?.avatar_url) {
        settingsAvatar.style.backgroundImage = `url(${state.currentUserProfile.avatar_url})`;
        settingsAvatar.textContent = '';
    } else {
        settingsAvatar.style.backgroundImage = '';
        settingsAvatar.textContent = state.currentUser.username[0].toUpperCase();
    }
    settingsUsername.textContent = state.currentUserProfile?.display_name || state.currentUser.username;
    
    // Загружаем текущие значения
    const notifCheckbox = document.getElementById('notifications-checkbox');
    const soundsCheckbox = document.getElementById('sounds-checkbox');
    const avatarsCheckbox = document.getElementById('setting-avatars');
    
    if (notifCheckbox) notifCheckbox.checked = state.notificationsEnabled;
    if (soundsCheckbox) soundsCheckbox.checked = state.settings.sounds !== false;
    if (avatarsCheckbox) avatarsCheckbox.checked = !state.settings.hideAvatars;
    
    // Premium статус
    const isPremium = state.currentUserProfile?.isPremium || state.currentUser?.role === 'admin';
    
    // Premium: скрытый онлайн
    const hideOnlineCheckbox = document.getElementById('setting-hide-online');
    if (hideOnlineCheckbox) {
        hideOnlineCheckbox.checked = state.currentUserProfile?.hide_online || false;
        const hideOnlineSetting = document.getElementById('hide-online-setting');
        if (hideOnlineSetting) {
            hideOnlineSetting.classList.toggle('locked', !isPremium);
        }
    }
    
    // Блокируем премиум-темы для не-премиум пользователей
    document.querySelectorAll('.theme-option.premium-theme').forEach(opt => {
        opt.classList.toggle('locked', !isPremium);
    });
    
    // Активируем текущие опции
    document.querySelectorAll('.bg-option').forEach(opt => {
        opt.classList.toggle('active', opt.dataset.bg === (state.settings.background || 'default'));
    });
    document.querySelectorAll('.size-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.size === (state.settings.messageSize || 'medium'));
    });
    document.querySelectorAll('.color-option').forEach(opt => {
        opt.classList.toggle('active', opt.dataset.color === (state.settings.accentColor || '#4fc3f7'));
    });
    document.querySelectorAll('.theme-option').forEach(opt => {
        opt.classList.toggle('active', opt.dataset.theme === (state.settings.theme || 'dark'));
    });
    
    // Стиль пузырей (из профиля, не из локальных настроек)
    const currentBubbleStyle = state.currentUserProfile?.bubble_style || 'default';
    document.querySelectorAll('.bubble-style-option').forEach(opt => {
        opt.classList.toggle('active', opt.dataset.style === currentBubbleStyle);
    });
    
    // Блокируем стили пузырей для не-Premium+ пользователей
    const isPremiumPlus = state.currentUserProfile?.premiumPlan === 'premium_plus' || state.currentUser?.role === 'admin';
    const bubbleStyleSetting = document.getElementById('bubble-style-setting');
    const bubbleStylePicker = document.getElementById('bubble-style-picker');
    if (bubbleStyleSetting) {
        bubbleStyleSetting.classList.toggle('locked', !isPremiumPlus);
    }
    if (bubbleStylePicker) {
        bubbleStylePicker.classList.toggle('locked', !isPremiumPlus);
    }
    
    // Сбрасываем на первый раздел
    document.querySelectorAll('.settings-nav-item').forEach(i => i.classList.remove('active'));
    document.querySelectorAll('.settings-section').forEach(s => s.classList.remove('active'));
    document.querySelector('.settings-nav-item')?.classList.add('active');
    document.querySelector('.settings-section')?.classList.add('active');
    
    // Показываем кнопку админки только для админов
    // Проверяем роль из профиля (актуальные данные с сервера)
    const adminBtn = document.getElementById('admin-btn');
    if (adminBtn) {
        const isAdmin = state.currentUserProfile?.role === 'admin' || state.currentUser?.role === 'admin';
        if (isAdmin) {
            adminBtn.classList.remove('hidden');
            // Обновляем роль в state если изменилась
            if (state.currentUserProfile?.role === 'admin' && state.currentUser?.role !== 'admin') {
                state.currentUser.role = 'admin';
                localStorage.setItem('kvant_user', JSON.stringify(state.currentUser));
            }
        } else {
            adminBtn.classList.add('hidden');
        }
    }
    
    document.getElementById('settings-modal').classList.remove('hidden');
}

// === АДМИН-ПАНЕЛЬ ===

async function showAdminPanel() {
    // Проверяем роль из профиля (актуальные данные с сервера)
    const isAdmin = state.currentUserProfile?.role === 'admin' || state.currentUser?.role === 'admin';
    if (!isAdmin) {
        showToast('Нет доступа', 'error');
        return;
    }
    
    try {
        const res = await api.get('/api/admin/users?limit=100');
        console.log('Admin API response status:', res.status);
        const data = await res.json();
        console.log('Admin API data:', data);
        
        // Статистика
        const statsEl = document.getElementById('admin-stats');
        const totalUsers = data.total || 0;
        const premiumUsers = data.users?.filter(u => u.isPremium).length || 0;
        const adminUsers = data.users?.filter(u => u.role === 'admin').length || 0;
        
        statsEl.innerHTML = `
            <div class="admin-stat">
                <div class="admin-stat-value">${totalUsers}</div>
                <div class="admin-stat-label">Всего пользователей</div>
            </div>
            <div class="admin-stat">
                <div class="admin-stat-value">${premiumUsers}</div>
                <div class="admin-stat-label">Premium</div>
            </div>
            <div class="admin-stat">
                <div class="admin-stat-value">${adminUsers}</div>
                <div class="admin-stat-label">Админов</div>
            </div>
        `;
        
        // Список пользователей
        renderAdminUsers(data.users || []);
        
        document.getElementById('admin-modal').classList.remove('hidden');
    } catch (error) {
        console.error('Admin panel error:', error);
        showToast('Ошибка загрузки', 'error');
    }
}

let adminListenerAdded = false;

function renderAdminUsers(users) {
    const container = document.getElementById('admin-users');
    
    container.innerHTML = users.map(user => {
        // Определяем текущие роли
        const badges = [];
        if (user.role === 'admin') badges.push('<span class="profile-badge admin">Админ</span>');
        if (user.isPremium && user.premiumPlan === 'premium_plus') {
            badges.push('<span class="profile-badge premium-plus">P+</span>');
        } else if (user.isPremium) {
            badges.push('<span class="profile-badge premium">P</span>');
        }
        // В админке оставляем короткие P/P+ для компактности
        
        return `
        <div class="admin-user" data-user-id="${user.id}" data-user-role="${user.role}" data-user-premium="${user.isPremium ? user.premiumPlan : ''}" data-username="${user.display_name || user.username}">
            <div class="admin-user-avatar" style="${user.avatar_url ? `background-image: url(${user.avatar_url})` : ''}">
                ${user.avatar_url ? '' : user.username[0].toUpperCase()}
            </div>
            <div class="admin-user-info">
                <div class="admin-user-name">
                    ${user.display_name || user.username}
                    <span class="profile-badges">${badges.join('')}</span>
                </div>
                <div class="admin-user-tag">${user.username}#${user.custom_id || user.tag || '????'}</div>
            </div>
            <div class="admin-user-actions">
                <button class="admin-btn admin-btn-remove" data-action="remove-roles" title="Снять роли">
                    <img src="/assets/block-user.svg" class="icon-sm">
                </button>
                <button class="admin-btn admin-btn-status" data-action="add-roles" title="Добавить роли">
                    <img src="/assets/Badge-check.svg" class="icon-sm">
                </button>
                ${user.id !== state.currentUser.id ? `
                    <button class="admin-btn admin-btn-delete" data-action="delete-user" title="Удалить">
                        <img src="/assets/trash.svg" class="icon-sm">
                    </button>
                ` : ''}
            </div>
        </div>
    `}).join('');
    
    // Делегирование событий - добавляем только один раз
    if (!adminListenerAdded) {
        container.addEventListener('click', handleAdminAction);
        adminListenerAdded = true;
    }
}

async function handleAdminAction(e) {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    
    const userEl = btn.closest('.admin-user');
    if (!userEl) return;
    
    const userId = userEl.dataset.userId;
    const userRole = userEl.dataset.userRole;
    const userPremium = userEl.dataset.userPremium;
    const username = userEl.dataset.username;
    const action = btn.dataset.action;
    
    if (action === 'add-roles') {
        await showAddRolesModal(userId, username, userRole, userPremium);
    } else if (action === 'remove-roles') {
        await showRemoveRolesModal(userId, username, userRole, userPremium);
    } else if (action === 'delete-user') {
        await deleteUserAdmin(userId);
    }
}

// Модалка добавления ролей
async function showAddRolesModal(userId, username, currentRole, currentPremium) {
    const isAdmin = currentRole === 'admin';
    const hasPremium = currentPremium === 'premium';
    const hasPremiumPlus = currentPremium === 'premium_plus';
    
    // Создаём модалку
    const modal = document.createElement('div');
    modal.className = 'admin-role-modal';
    modal.innerHTML = `
        <div class="admin-role-modal-overlay"></div>
        <div class="admin-role-modal-content">
            <h3>Добавить роль: ${username}</h3>
            <div class="admin-role-options">
                ${!isAdmin ? `
                    <button class="admin-role-option" data-role="admin">
                        <span class="role-icon">👑</span>
                        <span class="role-name">Администратор</span>
                    </button>
                ` : ''}
                ${!hasPremium && !hasPremiumPlus ? `
                    <button class="admin-role-option" data-role="premium">
                        <img src="/assets/dimond.svg" class="icon-sm">
                        <span class="role-name">Premium</span>
                    </button>
                ` : ''}
                ${!hasPremiumPlus ? `
                    <button class="admin-role-option" data-role="premium_plus">
                        <img src="/assets/dimond-plus.svg" class="icon-sm">
                        <span class="role-name">Premium+</span>
                        ${hasPremium ? '<span class="role-note">(заменит Premium)</span>' : ''}
                    </button>
                ` : ''}
            </div>
            <button class="admin-role-cancel">Отмена</button>
        </div>
    `;
    document.body.appendChild(modal);
    
    return new Promise((resolve) => {
        modal.querySelector('.admin-role-modal-overlay').addEventListener('click', () => {
            modal.remove();
            resolve(null);
        });
        modal.querySelector('.admin-role-cancel').addEventListener('click', () => {
            modal.remove();
            resolve(null);
        });
        modal.querySelectorAll('.admin-role-option').forEach(btn => {
            btn.addEventListener('click', async () => {
                const role = btn.dataset.role;
                modal.remove();
                
                if (role === 'admin') {
                    await toggleAdmin(userId, currentRole);
                } else {
                    await givePremium(userId, role);
                }
                resolve(role);
            });
        });
    });
}

// Модалка снятия ролей
async function showRemoveRolesModal(userId, username, currentRole, currentPremium) {
    const isAdmin = currentRole === 'admin';
    const hasPremium = currentPremium === 'premium' || currentPremium === 'premium_plus';
    
    if (!isAdmin && !hasPremium) {
        showToast('У пользователя нет ролей для снятия', 'info');
        return;
    }
    
    const modal = document.createElement('div');
    modal.className = 'admin-role-modal';
    modal.innerHTML = `
        <div class="admin-role-modal-overlay"></div>
        <div class="admin-role-modal-content">
            <h3>Снять роль: ${username}</h3>
            <div class="admin-role-options">
                ${isAdmin ? `
                    <button class="admin-role-option danger" data-role="remove-admin">
                        <span class="role-icon">👑</span>
                        <span class="role-name">Снять админа</span>
                    </button>
                ` : ''}
                ${hasPremium ? `
                    <button class="admin-role-option danger" data-role="remove-premium">
                        <img src="/assets/dimond.svg" class="icon-sm">
                        <span class="role-name">Снять ${currentPremium === 'premium_plus' ? 'Premium+' : 'Premium'}</span>
                    </button>
                ` : ''}
            </div>
            <button class="admin-role-cancel">Отмена</button>
        </div>
    `;
    document.body.appendChild(modal);
    
    return new Promise((resolve) => {
        modal.querySelector('.admin-role-modal-overlay').addEventListener('click', () => {
            modal.remove();
            resolve(null);
        });
        modal.querySelector('.admin-role-cancel').addEventListener('click', () => {
            modal.remove();
            resolve(null);
        });
        modal.querySelectorAll('.admin-role-option').forEach(btn => {
            btn.addEventListener('click', async () => {
                const role = btn.dataset.role;
                modal.remove();
                
                if (role === 'remove-admin') {
                    await toggleAdmin(userId, 'admin');
                } else if (role === 'remove-premium') {
                    await removePremiumAdmin(userId);
                }
                resolve(role);
            });
        });
    });
}

// Снять премиум
async function removePremiumAdmin(userId) {
    try {
        const res = await api.request(`/api/admin/user/${userId}/premium`, { method: 'DELETE' });
        const data = await res.json();
        
        if (data.success) {
            showToast('Подписка снята');
            showAdminPanel();
        } else {
            showToast(data.error || 'Ошибка', 'error');
        }
    } catch (error) {
        showToast('Ошибка сети', 'error');
    }
}

async function toggleAdmin(userId, currentRole) {
    const isAdmin = currentRole === 'admin';
    const newRole = isAdmin ? 'user' : 'admin';
    
    const confirmed = await customConfirm({
        title: isAdmin ? 'Снять админа' : 'Назначить админом',
        message: isAdmin ? 'Снять права администратора?' : 'Назначить пользователя администратором?',
        icon: '👑',
        variant: isAdmin ? 'warning' : 'info',
        okText: isAdmin ? 'Снять' : 'Назначить',
        cancelText: 'Отмена'
    });
    if (!confirmed) return;
    
    try {
        const res = await api.put(`/api/admin/user/${userId}/role`, { role: newRole });
        const data = await res.json();
        
        if (data.success) {
            showToast(isAdmin ? 'Права админа сняты' : 'Назначен администратором');
            showAdminPanel();
        } else {
            showToast(data.error || 'Ошибка', 'error');
        }
    } catch (error) {
        showToast('Ошибка сети', 'error');
    }
}

async function givePremium(userId, planType = 'premium') {
    const planName = planType === 'premium_plus' ? 'Premium+' : 'Premium';
    const icon = planType === 'premium_plus' ? '💎' : '⭐';
    const days = await customPrompt({
        title: `Выдать ${planName}`,
        message: 'Введите количество дней:',
        icon: icon,
        variant: planType === 'premium_plus' ? 'premium-plus' : 'premium',
        placeholder: 'Дней',
        defaultValue: '30',
        okText: 'Выдать',
        cancelText: 'Отмена'
    });
    if (!days || isNaN(days)) return;
    
    try {
        const res = await api.post(`/api/admin/user/${userId}/premium`, { 
            days: parseInt(days),
            plan: planType
        });
        const data = await res.json();
        
        if (data.success) {
            showToast(`${planName} выдан на ${days} дней`);
            showAdminPanel();
        } else {
            showToast(data.error || 'Ошибка', 'error');
        }
    } catch (error) {
        showToast('Ошибка сети', 'error');
    }
}

async function deleteUserAdmin(userId) {
    const confirmed = await customConfirm({
        title: 'Удаление пользователя',
        message: 'Удалить пользователя? Это действие необратимо!',
        icon: '🗑️',
        variant: 'danger',
        okText: 'Удалить',
        cancelText: 'Отмена'
    });
    if (!confirmed) return;
    
    try {
        const res = await api.request(`/api/admin/user/${userId}`, { method: 'DELETE' });
        const data = await res.json();
        
        if (data.success) {
            showToast('Пользователь удалён');
            showAdminPanel();
        } else {
            showToast(data.error || 'Ошибка', 'error');
        }
    } catch (error) {
        showToast('Ошибка сети', 'error');
    }
}

// Поиск в админке
document.getElementById('admin-search')?.addEventListener('input', async (e) => {
    const query = e.target.value.trim().toLowerCase();
    
    if (!query) {
        showAdminPanel();
        return;
    }
    
    try {
        const res = await api.get('/api/admin/users?limit=100');
        const data = await res.json();
        
        const filtered = data.users.filter(u => 
            u.username.toLowerCase().includes(query) ||
            u.tag?.includes(query) ||
            u.display_name?.toLowerCase().includes(query)
        );
        
        renderAdminUsers(filtered);
    } catch (error) {
        console.error('Search error:', error);
    }
});

// Закрытие админки
document.getElementById('close-admin')?.addEventListener('click', () => {
    document.getElementById('admin-modal').classList.add('hidden');
});


// === USER CARD POPUP & STATUS ===

const statusLabels = {
    online: 'В сети',
    idle: 'Неактивен',
    dnd: 'Не беспокоить',
    invisible: 'Невидимый'
};

function showUserCardPopup() {
    const popup = document.getElementById('user-card-popup');
    const profile = state.currentUserProfile;
    
    // Аватарка
    const avatarEl = document.getElementById('user-card-avatar');
    if (profile?.avatar_url) {
        avatarEl.style.backgroundImage = `url(${profile.avatar_url})`;
        avatarEl.textContent = '';
    } else {
        avatarEl.style.backgroundImage = '';
        avatarEl.textContent = state.currentUser.username[0].toUpperCase();
    }
    
    // Баннер
    const bannerEl = document.getElementById('user-card-banner');
    if (profile?.banner_url) {
        bannerEl.style.backgroundImage = `url(${profile.banner_url})`;
    } else {
        bannerEl.style.backgroundImage = '';
        bannerEl.style.background = 'linear-gradient(135deg, #4fc3f7, #1976d2)';
    }
    
    // Имя
    document.getElementById('user-card-name').textContent = profile?.display_name || state.currentUser.username;
    
    // Bio
    document.getElementById('user-card-bio').textContent = profile?.bio || '';
    
    // Статус
    updateStatusDisplay();
    
    popup.classList.remove('hidden');
}

function hideUserCardPopup() {
    document.getElementById('user-card-popup').classList.add('hidden');
    document.getElementById('status-dropdown').classList.add('hidden');
}

function toggleUserCardPopup(e) {
    e.stopPropagation();
    const popup = document.getElementById('user-card-popup');
    if (popup.classList.contains('hidden')) {
        showUserCardPopup();
    } else {
        hideUserCardPopup();
    }
}

function updateStatusDisplay() {
    const status = state.userStatus;
    const label = statusLabels[status] || 'В сети';
    
    // В popup
    const dotEl = document.getElementById('status-dot');
    const textEl = document.getElementById('status-text');
    if (dotEl) {
        dotEl.className = `status-dot ${status}`;
    }
    if (textEl) {
        textEl.textContent = label;
    }
    
    // В нижней панели
    const panelStatus = document.getElementById('current-user-status');
    if (panelStatus) {
        const panelDot = panelStatus.querySelector('.status-dot');
        const panelText = panelStatus.querySelector('.status-text');
        if (panelDot) panelDot.className = `status-dot ${status}`;
        if (panelText) panelText.textContent = label;
    }
    
    // Отмечаем активный в dropdown
    document.querySelectorAll('.status-option').forEach(opt => {
        opt.classList.toggle('active', opt.dataset.status === status);
    });
}

function setUserStatus(newStatus) {
    state.userStatus = newStatus;
    localStorage.setItem('kvant_status', newStatus);
    updateStatusDisplay();
    
    // Скрываем dropdown
    document.getElementById('status-dropdown').classList.add('hidden');
    
    // Отправляем на сервер
    state.socket?.emit('status-change', { status: newStatus });
}

function toggleStatusDropdown(e) {
    e.stopPropagation();
    const dropdown = document.getElementById('status-dropdown');
    dropdown.classList.toggle('hidden');
}

function togglePanelMic() {
    state.micMuted = !state.micMuted;
    const btn = document.getElementById('panel-mic-btn');
    btn.classList.toggle('muted', state.micMuted);
    btn.innerHTML = state.micMuted 
        ? '<img src="/assets/Block-microphone.svg" alt="" class="icon">' 
        : '<img src="/assets/microphone.svg" alt="" class="icon">';
}

function togglePanelCam() {
    state.camMuted = !state.camMuted;
    const btn = document.getElementById('panel-cam-btn');
    btn.classList.toggle('muted', state.camMuted);
    btn.innerHTML = state.camMuted 
        ? '<img src="/assets/camera-off.svg" alt="" class="icon">' 
        : '<img src="/assets/camera.svg" alt="" class="icon">';
}

// Инициализация событий для карточки
document.addEventListener('DOMContentLoaded', () => {
    // Клик на панель пользователя
    const userPanel = document.getElementById('user-panel');
    userPanel?.addEventListener('click', (e) => {
        // Не открываем popup если кликнули на кнопки
        if (e.target.closest('.panel-action-btn')) return;
        toggleUserCardPopup(e);
    });
    
    // Кнопки микрофона и камеры
    document.getElementById('panel-mic-btn')?.addEventListener('click', (e) => {
        e.stopPropagation();
        togglePanelMic();
    });
    
    document.getElementById('panel-cam-btn')?.addEventListener('click', (e) => {
        e.stopPropagation();
        togglePanelCam();
    });
    
    // Кнопка настроек в карточке
    document.getElementById('user-card-settings')?.addEventListener('click', (e) => {
        e.stopPropagation();
        hideUserCardPopup();
        showSettings();
    });
    
    // Кнопка открытия полного профиля
    document.getElementById('user-card-profile-btn')?.addEventListener('click', (e) => {
        e.stopPropagation();
        hideUserCardPopup();
        showMyProfile();
    });
    
    // Клик на статус для открытия dropdown
    document.getElementById('status-current')?.addEventListener('click', toggleStatusDropdown);
    
    // Выбор статуса
    document.querySelectorAll('.status-option').forEach(opt => {
        opt.addEventListener('click', (e) => {
            e.stopPropagation();
            setUserStatus(opt.dataset.status);
        });
    });
    
    // Закрытие popup при клике вне
    document.addEventListener('click', (e) => {
        const popup = document.getElementById('user-card-popup');
        const panel = document.getElementById('user-panel');
        if (popup && !popup.contains(e.target) && !panel?.contains(e.target)) {
            hideUserCardPopup();
        }
    });
    
    // Применяем сохранённый статус
    updateStatusDisplay();
});


// === RESIZABLE SIDEBAR ===

function initSidebarResizer() {
    const resizer = document.getElementById('sidebar-resizer');
    const chatScreen = document.getElementById('chat-screen');
    
    if (!resizer || !chatScreen) return;
    
    let isResizing = false;
    let startX = 0;
    let startWidth = 0;
    
    // Загружаем сохранённую ширину
    const savedWidth = localStorage.getItem('kvant_sidebar_width');
    if (savedWidth) {
        chatScreen.style.setProperty('--sidebar-width', savedWidth + 'px');
    }
    
    resizer.addEventListener('mousedown', (e) => {
        isResizing = true;
        startX = e.clientX;
        startWidth = parseInt(getComputedStyle(chatScreen).getPropertyValue('--sidebar-width')) || 320;
        
        resizer.classList.add('resizing');
        document.body.style.cursor = 'col-resize';
        document.body.style.userSelect = 'none';
        
        e.preventDefault();
    });
    
    document.addEventListener('mousemove', (e) => {
        if (!isResizing) return;
        
        const diff = e.clientX - startX;
        let newWidth = startWidth + diff;
        
        // Ограничения: минимум 200px, максимум 500px
        newWidth = Math.max(200, Math.min(500, newWidth));
        
        chatScreen.style.setProperty('--sidebar-width', newWidth + 'px');
    });
    
    document.addEventListener('mouseup', () => {
        if (!isResizing) return;
        
        isResizing = false;
        resizer.classList.remove('resizing');
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        
        // Сохраняем ширину
        const currentWidth = parseInt(getComputedStyle(chatScreen).getPropertyValue('--sidebar-width')) || 320;
        localStorage.setItem('kvant_sidebar_width', currentWidth);
    });
    
    // Touch support для мобильных
    resizer.addEventListener('touchstart', (e) => {
        isResizing = true;
        startX = e.touches[0].clientX;
        startWidth = parseInt(getComputedStyle(chatScreen).getPropertyValue('--sidebar-width')) || 320;
        resizer.classList.add('resizing');
    });
    
    document.addEventListener('touchmove', (e) => {
        if (!isResizing) return;
        
        const diff = e.touches[0].clientX - startX;
        let newWidth = startWidth + diff;
        newWidth = Math.max(200, Math.min(500, newWidth));
        chatScreen.style.setProperty('--sidebar-width', newWidth + 'px');
    });
    
    document.addEventListener('touchend', () => {
        if (!isResizing) return;
        isResizing = false;
        resizer.classList.remove('resizing');
        
        const currentWidth = parseInt(getComputedStyle(chatScreen).getPropertyValue('--sidebar-width')) || 320;
        localStorage.setItem('kvant_sidebar_width', currentWidth);
    });
}

// Обновление аватарки в хедере чата
function updateChatHeaderAvatar() {
    const avatarEl = document.getElementById('chat-header-avatar');
    if (!avatarEl || !state.selectedUserProfile) return;
    
    if (state.selectedUserProfile.avatar_url) {
        avatarEl.style.backgroundImage = `url(${state.selectedUserProfile.avatar_url})`;
        avatarEl.textContent = '';
    } else {
        avatarEl.style.backgroundImage = '';
        avatarEl.textContent = state.selectedUser?.username?.[0]?.toUpperCase() || '?';
    }
}

// Инициализация при загрузке
document.addEventListener('DOMContentLoaded', () => {
    initSidebarResizer();
    initVoiceConnectionPill();
    
    // Обработчики для кнопок в хедере (звонки)
    document.querySelectorAll('.header-action-btn').forEach((btn, index) => {
        // Пропускаем кнопку меню - у неё свой обработчик
        if (btn.id === 'chat-menu-btn') return;
        
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            if (!state.selectedUser) return;
            
            if (index === 0) {
                startCall(false); // Аудио
            } else if (index === 1) {
                startCall(true); // Видео
            }
        });
    });
    
    // === ПАНЕЛЬ КАНАЛОВ СЕРВЕРА ===
    
    // Кнопка "Назад" в панели сервера
    document.getElementById('server-panel-back')?.addEventListener('click', () => {
        hideServerChannelsPanel();
    });
    
    // Кнопка меню сервера (три точки)
    const serverMenuBtn = document.getElementById('server-panel-menu');
    const serverMenu = document.getElementById('server-menu');
    
    serverMenuBtn?.addEventListener('click', (e) => {
        e.stopPropagation();
        serverMenu?.classList.toggle('hidden');
    });
    
    // Закрытие меню при клике вне
    document.addEventListener('click', (e) => {
        if (!serverMenu?.contains(e.target) && e.target !== serverMenuBtn) {
            serverMenu?.classList.add('hidden');
        }
    });
    
    // Пункты меню сервера
    document.getElementById('server-create-channel')?.addEventListener('click', () => {
        serverMenu?.classList.add('hidden');
        openCreateServerChannelModal();
    });
    
    document.getElementById('server-manage-roles')?.addEventListener('click', () => {
        serverMenu?.classList.add('hidden');
        openServerRolesModal();
    });
    
    document.getElementById('server-settings')?.addEventListener('click', () => {
        serverMenu?.classList.add('hidden');
        openServerSettingsModal();
    });
    
    // Клик на хедер панели сервера (открыть инфо)
    document.getElementById('server-panel-info')?.addEventListener('click', () => {
        if (state.selectedServer) {
            showServerInfo(state.selectedServer.id);
        }
    });
    
    // === МОДАЛКА СОЗДАНИЯ КАНАЛА НА СЕРВЕРЕ ===
    
    document.getElementById('close-create-channel')?.addEventListener('click', () => {
        document.getElementById('create-server-channel-modal')?.classList.add('hidden');
    });
    
    document.querySelector('#create-server-channel-modal .modal-overlay')?.addEventListener('click', () => {
        document.getElementById('create-server-channel-modal')?.classList.add('hidden');
    });
    
    // Выбор типа канала
    document.querySelectorAll('.channel-type-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.channel-type-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
        });
    });
    
    // Создание канала
    document.getElementById('create-channel-btn')?.addEventListener('click', async () => {
        const name = document.getElementById('new-channel-name')?.value.trim();
        const categoryId = document.getElementById('new-channel-category')?.value || null;
        const type = document.querySelector('.channel-type-btn.active')?.dataset.type || 'text';
        
        if (!name) {
            showToast('Введите название канала', 'error');
            return;
        }
        
        if (!state.selectedServer) {
            showToast('Сервер не выбран', 'error');
            return;
        }
        
        try {
            const res = await api.post(`/api/servers/${state.selectedServer.id}/channels`, {
                name, type, categoryId
            });
            
            if (res.ok) {
                showToast('Канал создан!');
                document.getElementById('create-server-channel-modal')?.classList.add('hidden');
                // Перезагружаем каналы
                await showServerChannelsPanel(state.selectedServer);
            } else {
                const data = await res.json();
                showToast(data.error || 'Ошибка создания', 'error');
            }
        } catch (e) {
            showToast('Ошибка создания канала', 'error');
        }
    });
    
    // === МОДАЛКА УПРАВЛЕНИЯ РОЛЯМИ ===
    
    document.getElementById('close-manage-roles')?.addEventListener('click', () => {
        document.getElementById('manage-roles-modal')?.classList.add('hidden');
    });
    
    document.querySelector('#manage-roles-modal .modal-overlay')?.addEventListener('click', () => {
        document.getElementById('manage-roles-modal')?.classList.add('hidden');
    });
    
    // Добавление новой роли
    document.getElementById('add-role-btn')?.addEventListener('click', async () => {
        if (!state.selectedServer) return;
        
        const name = await customPrompt({
            title: 'Новая роль',
            message: 'Введите название роли',
            icon: '🎭',
            placeholder: 'Модератор'
        });
        
        if (!name) return;
        
        try {
            const res = await api.post(`/api/servers/${state.selectedServer.id}/roles`, { name });
            if (res.ok) {
                showToast('Роль создана!');
                openServerRolesModal(); // Перезагружаем
            } else {
                showToast('Ошибка создания роли', 'error');
            }
        } catch (e) {
            showToast('Ошибка создания роли', 'error');
        }
    });
});

// Функции для модалок сервера
async function openCreateServerChannelModal(preselectedCategoryId = null) {
    if (!state.selectedServer) {
        showToast('Сначала выберите сервер', 'error');
        return;
    }
    
    const modal = document.getElementById('create-server-channel-modal');
    if (!modal) return;
    
    // Сбрасываем форму
    document.getElementById('new-channel-name').value = '';
    document.querySelectorAll('.channel-type-btn').forEach((btn, i) => {
        btn.classList.toggle('active', i === 0);
    });
    
    // Загружаем категории
    try {
        const res = await api.get(`/api/servers/${state.selectedServer.id}/channels`);
        const data = await res.json();
        const categorySelect = document.getElementById('new-channel-category');
        categorySelect.innerHTML = '<option value="">Без категории</option>';
        (data.categories || []).forEach(cat => {
            const selected = preselectedCategoryId === cat.id ? 'selected' : '';
            categorySelect.innerHTML += `<option value="${cat.id}" ${selected}>${escapeHtml(cat.name)}</option>`;
        });
    } catch (e) {
        console.error('Error loading categories:', e);
    }
    
    modal.classList.remove('hidden');
}

// Контекстное меню для канала сервера
function showServerChannelContextMenu(e, channelId, canManage) {
    hideAllContextMenus();
    
    const menu = document.createElement('div');
    menu.className = 'context-menu server-channel-context-menu';
    menu.innerHTML = `
        <div class="context-menu-item" data-action="mark-read">
            <img src="/assets/Check.svg" class="icon-sm"> Пометить как прочитанное
        </div>
        <div class="context-menu-item" data-action="mute">
            <img src="/assets/bell.svg" class="icon-sm"> Заглушить канал
        </div>
        ${canManage ? `
        <div class="context-menu-divider"></div>
        <div class="context-menu-item" data-action="settings">
            <img src="/assets/settings.svg" class="icon-sm"> Настройки канала
        </div>
        <div class="context-menu-item" data-action="invite">
            <img src="/assets/Plus.svg" class="icon-sm"> Пригласить людей
        </div>
        <div class="context-menu-item danger" data-action="delete">
            <img src="/assets/trash.svg" class="icon-sm"> Удалить канал
        </div>
        ` : ''}
    `;
    
    document.body.appendChild(menu);
    positionContextMenu(menu, e.clientX, e.clientY);
    
    menu.querySelectorAll('.context-menu-item').forEach(item => {
        item.addEventListener('click', async () => {
            const action = item.dataset.action;
            menu.remove();
            
            switch (action) {
                case 'mark-read':
                    showToast('Канал помечен как прочитанный');
                    break;
                case 'mute':
                    showToast('Канал заглушен');
                    break;
                case 'settings':
                    openChannelSettingsModal(channelId);
                    break;
                case 'invite':
                    copyServerInviteLink();
                    break;
                case 'delete':
                    await deleteServerChannel(channelId);
                    break;
            }
        });
    });
    
    // Закрытие по клику вне меню
    setTimeout(() => {
        document.addEventListener('click', function closeMenu(e) {
            if (!menu.contains(e.target)) {
                menu.remove();
                document.removeEventListener('click', closeMenu);
            }
        });
    }, 10);
}

// Контекстное меню для пустого места в списке каналов
function showServerListContextMenu(e) {
    hideAllContextMenus();
    
    const menu = document.createElement('div');
    menu.className = 'context-menu server-list-context-menu';
    menu.innerHTML = `
        <div class="context-menu-item" data-action="create-channel">
            <img src="/assets/Plus.svg" class="icon-sm"> Создать канал
        </div>
        <div class="context-menu-item" data-action="create-category">
            <img src="/assets/group.svg" class="icon-sm"> Создать категорию
        </div>
    `;
    
    document.body.appendChild(menu);
    positionContextMenu(menu, e.clientX, e.clientY);
    
    menu.querySelectorAll('.context-menu-item').forEach(item => {
        item.addEventListener('click', async () => {
            const action = item.dataset.action;
            menu.remove();
            
            if (action === 'create-channel') {
                openCreateServerChannelModal();
            } else if (action === 'create-category') {
                await createServerCategory();
            }
        });
    });
    
    setTimeout(() => {
        document.addEventListener('click', function closeMenu(e) {
            if (!menu.contains(e.target)) {
                menu.remove();
                document.removeEventListener('click', closeMenu);
            }
        });
    }, 10);
}

// Создать категорию на сервере
async function createServerCategory() {
    if (!state.selectedServer) return;
    
    const name = await customPrompt({
        title: 'Новая категория',
        message: 'Введите название категории',
        placeholder: 'Название категории',
        icon: '📁'
    });
    
    if (!name) return;
    
    try {
        const res = await api.post(`/api/servers/${state.selectedServer.id}/categories`, { name });
        if (res.ok) {
            showToast('Категория создана!');
            await showServerChannelsPanel(state.selectedServer);
        } else {
            const data = await res.json();
            showToast(data.error || 'Ошибка создания категории', 'error');
        }
    } catch (e) {
        console.error('Error creating category:', e);
        showToast('Ошибка создания категории', 'error');
    }
}

// Контекстное меню для категории сервера
function showServerCategoryContextMenu(e, categoryId) {
    hideAllContextMenus();
    
    const menu = document.createElement('div');
    menu.className = 'context-menu server-category-context-menu';
    menu.innerHTML = `
        <div class="context-menu-item" data-action="create-channel">
            <img src="/assets/Plus.svg" class="icon-sm"> Создать канал
        </div>
        <div class="context-menu-item" data-action="edit">
            <img src="/assets/edit.svg" class="icon-sm"> Редактировать категорию
        </div>
        <div class="context-menu-divider"></div>
        <div class="context-menu-item danger" data-action="delete">
            <img src="/assets/trash.svg" class="icon-sm"> Удалить категорию
        </div>
    `;
    
    document.body.appendChild(menu);
    positionContextMenu(menu, e.clientX, e.clientY);
    
    menu.querySelectorAll('.context-menu-item').forEach(item => {
        item.addEventListener('click', async () => {
            const action = item.dataset.action;
            menu.remove();
            
            switch (action) {
                case 'create-channel':
                    openCreateServerChannelModal(categoryId);
                    break;
                case 'edit':
                    await editServerCategory(categoryId);
                    break;
                case 'delete':
                    await deleteServerCategory(categoryId);
                    break;
            }
        });
    });
    
    setTimeout(() => {
        document.addEventListener('click', function closeMenu(e) {
            if (!menu.contains(e.target)) {
                menu.remove();
                document.removeEventListener('click', closeMenu);
            }
        });
    }, 10);
}

// Редактировать категорию
async function editServerCategory(categoryId) {
    if (!state.selectedServer) return;
    
    // Получаем текущее название
    const res = await api.get(`/api/servers/${state.selectedServer.id}/channels`);
    const data = await res.json();
    const category = data.categories?.find(c => c.id === categoryId);
    
    if (!category) {
        showToast('Категория не найдена', 'error');
        return;
    }
    
    const newName = await customPrompt({
        title: 'Редактировать категорию',
        message: 'Название категории',
        placeholder: 'Название',
        defaultValue: category.name,
        icon: '📁'
    });
    
    if (!newName || newName === category.name) return;
    
    try {
        const res = await api.put(`/api/server-categories/${categoryId}`, { name: newName });
        if (res.ok) {
            showToast('Категория обновлена');
            await showServerChannelsPanel(state.selectedServer);
        } else {
            const data = await res.json();
            showToast(data.error || 'Ошибка обновления', 'error');
        }
    } catch (e) {
        console.error('Error updating category:', e);
        showToast('Ошибка обновления категории', 'error');
    }
}

// Удалить категорию
async function deleteServerCategory(categoryId) {
    const confirmed = await customConfirm({
        title: 'Удалить категорию?',
        message: 'Каналы в этой категории станут без категории. Это действие нельзя отменить.',
        icon: '🗑️',
        variant: 'danger',
        okText: 'Удалить',
        cancelText: 'Отмена'
    });
    
    if (!confirmed) return;
    
    try {
        const res = await api.request(`/api/server-categories/${categoryId}`, { method: 'DELETE' });
        if (res.ok) {
            showToast('Категория удалена');
            await showServerChannelsPanel(state.selectedServer);
        } else {
            const data = await res.json();
            showToast(data.error || 'Ошибка удаления', 'error');
        }
    } catch (e) {
        console.error('Error deleting category:', e);
        showToast('Ошибка удаления категории', 'error');
    }
}

// Удалить канал сервера
async function deleteServerChannel(channelId) {
    const confirmed = await customConfirm({
        title: 'Удалить канал?',
        message: 'Все сообщения в канале будут удалены. Это действие нельзя отменить.',
        icon: '🗑️',
        variant: 'danger',
        okText: 'Удалить',
        cancelText: 'Отмена'
    });
    
    if (!confirmed) return;
    
    try {
        const res = await api.request(`/api/server-channels/${channelId}`, { method: 'DELETE' });
        if (res.ok) {
            showToast('Канал удалён');
            // Если удалили текущий канал, сбрасываем выбор
            if (state.selectedServerChannel?.id === channelId) {
                state.selectedServerChannel = null;
                updateChatHeader('Выберите канал', '', null);
                document.getElementById('messages').innerHTML = '';
            }
            await showServerChannelsPanel(state.selectedServer);
        } else {
            const data = await res.json();
            showToast(data.error || 'Ошибка удаления канала', 'error');
        }
    } catch (e) {
        console.error('Error deleting channel:', e);
        showToast('Ошибка удаления канала', 'error');
    }
}

// Модалка настроек канала
async function openChannelSettingsModal(channelId) {
    // Получаем данные канала
    const res = await api.get(`/api/servers/${state.selectedServer.id}/channels`);
    const data = await res.json();
    const channel = data.channels?.find(c => c.id === channelId);
    
    if (!channel) {
        showToast('Канал не найден', 'error');
        return;
    }
    
    const newName = await customPrompt({
        title: 'Настройки канала',
        message: 'Название канала',
        placeholder: 'Название',
        defaultValue: channel.name,
        icon: '⚙️'
    });
    
    if (newName === null) return;
    if (newName === channel.name) return;
    
    try {
        const res = await api.put(`/api/server-channels/${channelId}`, { name: newName });
        if (res.ok) {
            showToast('Канал обновлён');
            await showServerChannelsPanel(state.selectedServer);
        } else {
            const data = await res.json();
            showToast(data.error || 'Ошибка обновления канала', 'error');
        }
    } catch (e) {
        console.error('Error updating channel:', e);
        showToast('Ошибка обновления канала', 'error');
    }
}

// Скопировать ссылку-приглашение на канал
function copyChannelInviteLink() {
    if (!state.selectedChannel) return;
    
    const link = `${window.location.origin}/invite/channel/${state.selectedChannel.id}`;
    navigator.clipboard.writeText(link).then(() => {
        showToast('Ссылка скопирована!');
    }).catch(() => {
        showToast('Не удалось скопировать ссылку', 'error');
    });
}

// Скопировать ссылку-приглашение на сервер
function copyServerInviteLink() {
    if (!state.selectedServer) return;
    
    const link = `${window.location.origin}/invite/server/${state.selectedServer.id}`;
    navigator.clipboard.writeText(link).then(() => {
        showToast('Ссылка скопирована!');
    }).catch(() => {
        showToast('Не удалось скопировать ссылку', 'error');
    });
}

// Обработка инвайт-ссылок при загрузке страницы
async function handleInviteLink() {
    const path = window.location.pathname;
    // Поддержка любых slug (буквы, цифры, _, -, UUID)
    const inviteMatch = path.match(/^\/invite\/(channel|server)\/([a-zA-Z0-9_-]+)$/i);
    
    if (!inviteMatch) return;
    
    const [, type, idOrSlug] = inviteMatch;
    
    // Очищаем URL
    window.history.replaceState({}, '', '/');
    
    try {
        const res = await api.get(`/api/invite/${type}/${idOrSlug}`);
        if (!res.ok) {
            showToast('Приглашение не найдено или недействительно', 'error');
            return;
        }
        
        const data = await res.json();
        
        // Показываем превью с контентом
        showInvitePreview(type, data);
    } catch (error) {
        console.error('Handle invite link error:', error);
        showToast('Ошибка обработки приглашения', 'error');
    }
}

// Сохранить инвайт-ссылку для обработки после авторизации
function savePendingInvite() {
    const path = window.location.pathname;
    const inviteMatch = path.match(/^\/invite\/(channel|server)\/([a-zA-Z0-9_-]+)$/i);
    if (inviteMatch) {
        localStorage.setItem('kvant_pending_invite', path);
    }
}

// Проверить и обработать сохранённый инвайт
function checkPendingInvite() {
    const pending = localStorage.getItem('kvant_pending_invite');
    if (pending) {
        localStorage.removeItem('kvant_pending_invite');
        window.history.replaceState({}, '', pending);
        handleInviteLink();
    }
}

// Показать превью канала/сервера с контентом
async function showInvitePreview(type, data) {
    const isChannel = type === 'channel';
    const icon = isChannel ? '📢' : '🏰';
    const typeName = isChannel ? 'канал' : 'сервер';
    const avatarUrl = isChannel ? data.avatar_url : data.icon_url;
    const memberCount = isChannel ? data.subscriber_count : data.member_count;
    const memberLabel = isChannel ? 'подписчиков' : 'участников';
    
    // Проверяем, уже подписан ли пользователь
    const alreadyJoined = isChannel 
        ? state.channels.some(c => c.id === data.id)
        : state.servers.some(s => s.id === data.id);
    
    const modal = document.createElement('div');
    modal.className = 'modal invite-preview-modal';
    modal.innerHTML = `
        <div class="modal-overlay"></div>
        <div class="modal-content invite-preview-content">
            <button class="modal-close invite-close-btn">&times;</button>
            <div class="invite-preview-header">
                <div class="invite-avatar ${isChannel ? 'channel-avatar' : 'server-avatar'}" 
                     style="${avatarUrl ? `background-image: url(${avatarUrl})` : ''}">
                    ${avatarUrl ? '' : icon}
                </div>
                <div class="invite-preview-info">
                    <h2 class="invite-title">${escapeHtml(data.name)}</h2>
                    ${data.description ? `<p class="invite-description">${escapeHtml(data.description)}</p>` : ''}
                    <div class="invite-stats">${memberCount || 0} ${memberLabel}</div>
                </div>
            </div>
            <div class="invite-preview-content-area">
                <div class="invite-preview-loading">Загрузка...</div>
            </div>
            <div class="invite-preview-footer">
                ${alreadyJoined ? `
                    <button class="btn btn-primary invite-open-btn" data-type="${type}" data-id="${data.id}">
                        Открыть ${typeName}
                    </button>
                ` : `
                    <button class="btn btn-primary invite-join-btn" data-type="${type}" data-id="${data.id}">
                        Присоединиться к ${typeName}у
                    </button>
                `}
                <button class="btn btn-secondary invite-cancel-btn">Закрыть</button>
            </div>
        </div>
    `;
    
    document.body.appendChild(modal);
    
    // Загружаем контент для превью
    const contentArea = modal.querySelector('.invite-preview-content-area');
    if (isChannel) {
        try {
            const res = await fetch(`/api/invite/channel/${data.id}/posts?limit=10`);
            if (res.ok) {
                const posts = await res.json();
                if (posts.length > 0) {
                    contentArea.innerHTML = posts.map(post => `
                        <div class="invite-preview-post">
                            ${post.media_url ? `<img src="${escapeAttr(post.media_url)}" class="invite-preview-media" alt="">` : ''}
                            ${post.text ? `<div class="invite-preview-text">${escapeHtml(post.text)}</div>` : ''}
                            <div class="invite-preview-time">${formatTime(post.created_at)}</div>
                        </div>
                    `).join('');
                } else {
                    contentArea.innerHTML = '<div class="invite-preview-empty">Пока нет постов</div>';
                }
            } else {
                contentArea.innerHTML = '<div class="invite-preview-empty">Не удалось загрузить посты</div>';
            }
        } catch (e) {
            contentArea.innerHTML = '<div class="invite-preview-empty">Ошибка загрузки</div>';
        }
    } else {
        // Для серверов показываем описание
        contentArea.innerHTML = `<div class="invite-preview-empty">Присоединитесь, чтобы увидеть каналы сервера</div>`;
    }
    
    // Обработчики
    const closeModal = () => modal.remove();
    modal.querySelector('.modal-overlay').addEventListener('click', closeModal);
    modal.querySelector('.invite-cancel-btn').addEventListener('click', closeModal);
    modal.querySelector('.invite-close-btn').addEventListener('click', closeModal);
    
    // Кнопка "Открыть" (если уже подписан)
    modal.querySelector('.invite-open-btn')?.addEventListener('click', () => {
        modal.remove();
        if (isChannel) {
            switchSidebarTab('channels');
            selectChannel(data.id);
        } else {
            switchSidebarTab('servers');
            selectServer(data.id);
        }
    });
    
    // Кнопка "Присоединиться"
    modal.querySelector('.invite-join-btn')?.addEventListener('click', async (e) => {
        const btn = e.target;
        btn.disabled = true;
        btn.textContent = 'Присоединение...';
        
        try {
            const res = await api.post(`/api/invite/${type}/${data.id}/join`);
            if (res.ok) {
                showToast(`Вы присоединились к ${typeName}у!`, 'success');
                modal.remove();
                
                if (isChannel) {
                    await loadChannels();
                    switchSidebarTab('channels');
                    selectChannel(data.id);
                } else {
                    await loadServers();
                    switchSidebarTab('servers');
                    selectServer(data.id);
                }
            } else {
                const error = await res.json();
                showToast(error.error || 'Ошибка присоединения', 'error');
                btn.disabled = false;
                btn.textContent = `Присоединиться к ${typeName}у`;
            }
        } catch (error) {
            console.error('Join via invite error:', error);
            showToast('Ошибка присоединения', 'error');
            btn.disabled = false;
            btn.textContent = `Присоединиться к ${typeName}у`;
        }
    });
}

// Показать простую модалку приглашения (для поиска)
function showInviteModal(type, data) {
    showInvitePreview(type, data);
}

// Скрыть все контекстные меню
function hideAllContextMenus() {
    document.querySelectorAll('.context-menu').forEach(m => m.remove());
}

// Позиционирование контекстного меню
function positionContextMenu(menu, x, y) {
    menu.style.position = 'fixed';
    menu.style.left = x + 'px';
    menu.style.top = y + 'px';
    menu.style.zIndex = '10001';
    
    // Корректируем если выходит за границы экрана
    requestAnimationFrame(() => {
        const rect = menu.getBoundingClientRect();
        if (rect.right > window.innerWidth) {
            menu.style.left = (window.innerWidth - rect.width - 10) + 'px';
        }
        if (rect.bottom > window.innerHeight) {
            menu.style.top = (window.innerHeight - rect.height - 10) + 'px';
        }
    });
}

async function openServerRolesModal() {
    if (!state.selectedServer) {
        showToast('Сначала выберите сервер', 'error');
        return;
    }
    
    const modal = document.getElementById('manage-roles-modal');
    if (!modal) {
        showToast('Управление ролями в разработке', 'info');
        return;
    }
    
    // Загружаем роли
    try {
        const res = await api.get(`/api/servers/${state.selectedServer.id}/roles`);
        if (res.ok) {
            const roles = await res.json();
            renderRolesList(roles);
        }
    } catch (e) {
        console.error('Error loading roles:', e);
    }
    
    modal.classList.remove('hidden');
}

function renderRolesList(roles) {
    const list = document.getElementById('roles-list');
    if (!list) return;
    
    if (!roles || roles.length === 0) {
        list.innerHTML = '<div class="roles-empty-list">Нет ролей</div>';
        return;
    }
    
    list.innerHTML = roles.map(role => `
        <div class="role-item" data-role-id="${role.id}" style="border-left: 3px solid ${role.color || '#99aab5'}">
            <span class="role-name">${role.name}</span>
            ${role.is_default ? '<span class="role-badge">По умолчанию</span>' : ''}
        </div>
    `).join('');
    
    // Обработчики кликов
    list.querySelectorAll('.role-item').forEach(item => {
        item.addEventListener('click', () => selectRoleForEdit(item.dataset.roleId, roles));
    });
}

function selectRoleForEdit(roleId, roles) {
    const role = roles.find(r => r.id === roleId);
    if (!role) return;
    
    document.querySelectorAll('.role-item').forEach(i => i.classList.remove('active'));
    document.querySelector(`[data-role-id="${roleId}"]`)?.classList.add('active');
    
    const editor = document.getElementById('roles-editor');
    editor.innerHTML = `
        <div class="role-edit-form">
            <div class="form-group">
                <label>Название роли</label>
                <input type="text" id="edit-role-name" value="${escapeAttr(role.name)}" maxlength="50">
            </div>
            <div class="form-group">
                <label>Цвет</label>
                <input type="color" id="edit-role-color" value="${role.color || '#99aab5'}">
            </div>
            <div class="role-permissions">
                <h4>Права</h4>
                <label class="checkbox-label">
                    <input type="checkbox" id="perm-manage-channels" ${role.permissions & 1 ? 'checked' : ''}>
                    <span>Управление каналами</span>
                </label>
                <label class="checkbox-label">
                    <input type="checkbox" id="perm-manage-roles" ${role.permissions & 2 ? 'checked' : ''}>
                    <span>Управление ролями</span>
                </label>
                <label class="checkbox-label">
                    <input type="checkbox" id="perm-kick-members" ${role.permissions & 4 ? 'checked' : ''}>
                    <span>Кикать участников</span>
                </label>
                <label class="checkbox-label">
                    <input type="checkbox" id="perm-ban-members" ${role.permissions & 8 ? 'checked' : ''}>
                    <span>Банить участников</span>
                </label>
            </div>
            <div class="role-actions">
                <button class="btn-primary" id="save-role-btn">Сохранить</button>
                ${!role.is_default ? `<button class="btn-danger" id="delete-role-btn">Удалить</button>` : ''}
            </div>
        </div>
    `;
    
    // Добавляем обработчики событий
    document.getElementById('save-role-btn')?.addEventListener('click', () => saveRole(roleId));
    document.getElementById('delete-role-btn')?.addEventListener('click', () => deleteRole(roleId));
}

async function saveRole(roleId) {
    const name = document.getElementById('edit-role-name')?.value;
    const color = document.getElementById('edit-role-color')?.value;
    
    let permissions = 0;
    if (document.getElementById('perm-manage-channels')?.checked) permissions |= 1;
    if (document.getElementById('perm-manage-roles')?.checked) permissions |= 2;
    if (document.getElementById('perm-kick-members')?.checked) permissions |= 4;
    if (document.getElementById('perm-ban-members')?.checked) permissions |= 8;
    
    try {
        const res = await api.put(`/api/servers/${state.selectedServer.id}/roles/${roleId}`, {
            name, color, permissions
        });
        if (res.ok) {
            showToast('Роль сохранена');
            openServerRolesModal(); // Перезагружаем
        } else {
            showToast('Ошибка сохранения', 'error');
        }
    } catch (e) {
        showToast('Ошибка сохранения', 'error');
    }
}

async function deleteRole(roleId) {
    const confirmed = await customConfirm({
        title: 'Удалить роль?',
        message: 'Это действие нельзя отменить',
        icon: '🗑️',
        variant: 'danger',
        okText: 'Удалить',
        cancelText: 'Отмена'
    });
    
    if (!confirmed) return;
    
    try {
        const res = await api.request(`/api/servers/${state.selectedServer.id}/roles/${roleId}`, {
            method: 'DELETE'
        });
        if (res.ok) {
            showToast('Роль удалена');
            openServerRolesModal();
        }
    } catch (e) {
        showToast('Ошибка удаления', 'error');
    }
}

function openServerSettingsModal() {
    if (!state.selectedServer) {
        showToast('Сначала выберите сервер', 'error');
        return;
    }
    showToast('Настройки сервера в разработке', 'info');
}


// === GLOBAL SEARCH ===

let searchTimeout = null;

function openSearchModal() {
    document.getElementById('search-modal').classList.remove('hidden');
    const input = document.getElementById('global-search-input');
    input.value = '';
    input.focus();
    renderSearchEmpty();
}

function closeSearchModal() {
    document.getElementById('search-modal').classList.add('hidden');
    document.getElementById('global-search-input').value = '';
}

function renderSearchEmpty() {
    document.getElementById('search-results').innerHTML = `
        <div class="search-empty">
            <div class="search-empty-text">Начните вводить для поиска</div>
            <div class="search-empty-hint">Поиск по пользователям и сообщениям</div>
        </div>
    `;
}

function renderSearchLoading() {
    document.getElementById('search-results').innerHTML = `
        <div class="search-loading">Поиск...</div>
    `;
}

function renderSearchNotFound() {
    document.getElementById('search-results').innerHTML = `
        <div class="search-empty">
            <div class="search-empty-text">Ничего не найдено</div>
            <div class="search-empty-hint">Попробуйте изменить запрос</div>
        </div>
    `;
}

function highlightText(text, query) {
    if (!query) return escapeHtml(text);
    const escaped = escapeHtml(text);
    const regex = new RegExp(`(${query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi');
    return escaped.replace(regex, '<mark>$1</mark>');
}

async function performGlobalSearch(query) {
    if (!query || query.length < 2) {
        renderSearchEmpty();
        return;
    }
    
    renderSearchLoading();
    
    try {
        const res = await api.get(`/api/search?q=${encodeURIComponent(query)}`);
        if (!res.ok) throw new Error('Search failed');
        
        const { users, messages, channels, servers } = await res.json();
        
        const hasResults = users?.length > 0 || messages?.length > 0 || channels?.length > 0 || servers?.length > 0;
        
        if (!hasResults) {
            renderSearchNotFound();
            return;
        }
        
        let html = '';
        
        // Пользователи
        if (users?.length > 0) {
            html += `<div class="search-section">
                <div class="search-section-title">Люди</div>`;
            
            users.forEach(user => {
                const avatarStyle = user.avatar_url 
                    ? `background-image: url(${escapeAttr(user.avatar_url)})`
                    : '';
                const avatarText = user.avatar_url ? '' : user.username[0].toUpperCase();
                const displayName = user.display_name || user.username;
                
                html += `
                    <div class="search-item" data-type="user" data-id="${escapeAttr(user.id)}" data-name="${escapeAttr(user.username)}">
                        <div class="search-item-avatar" style="${avatarStyle}">${avatarText}</div>
                        <div class="search-item-info">
                            <div class="search-item-name">${highlightText(displayName, query)}</div>
                            <div class="search-item-text">@${highlightText(user.username, query)}#${user.custom_id || user.tag || '????'}</div>
                        </div>
                    </div>
                `;
            });
            
            html += '</div>';
        }
        
        // Каналы
        if (channels?.length > 0) {
            html += `<div class="search-section">
                <div class="search-section-title">Каналы</div>`;
            
            channels.forEach(channel => {
                const avatarStyle = channel.avatar_url 
                    ? `background-image: url(${escapeAttr(channel.avatar_url)})`
                    : '';
                const avatarText = channel.avatar_url ? '' : '📢';
                
                html += `
                    <div class="search-item" data-type="channel" data-id="${escapeAttr(channel.id)}">
                        <div class="search-item-avatar channel-avatar" style="${avatarStyle}">${avatarText}</div>
                        <div class="search-item-info">
                            <div class="search-item-name">${highlightText(channel.name, query)}</div>
                            <div class="search-item-text">${channel.subscriber_count || 0} подписчиков</div>
                        </div>
                    </div>
                `;
            });
            
            html += '</div>';
        }
        
        // Серверы
        if (servers?.length > 0) {
            html += `<div class="search-section">
                <div class="search-section-title">Серверы</div>`;
            
            servers.forEach(server => {
                const avatarStyle = server.icon_url 
                    ? `background-image: url(${escapeAttr(server.icon_url)})`
                    : '';
                const avatarText = server.icon_url ? '' : '🏰';
                
                html += `
                    <div class="search-item" data-type="server" data-id="${escapeAttr(server.id)}">
                        <div class="search-item-avatar server-avatar" style="${avatarStyle}">${avatarText}</div>
                        <div class="search-item-info">
                            <div class="search-item-name">${highlightText(server.name, query)}</div>
                            <div class="search-item-text">${server.member_count || 0} участников</div>
                        </div>
                    </div>
                `;
            });
            
            html += '</div>';
        }
        
        // Сообщения
        if (messages?.length > 0) {
            html += `<div class="search-section">
                <div class="search-section-title">Сообщения</div>`;
            
            messages.forEach(msg => {
                const senderName = msg.sender_display_name || msg.sender_username;
                const avatarStyle = msg.sender_avatar 
                    ? `background-image: url(${escapeAttr(msg.sender_avatar)})`
                    : '';
                const avatarText = msg.sender_avatar ? '' : msg.sender_username[0].toUpperCase();
                const time = formatTime(msg.created_at);
                
                // Определяем с кем был чат
                const chatPartnerId = msg.sender_id === state.currentUser.id ? msg.receiver_id : msg.sender_id;
                
                html += `
                    <div class="search-item" data-type="message" data-chat-id="${escapeAttr(chatPartnerId)}" data-sender="${escapeAttr(msg.sender_username)}">
                        <div class="search-item-avatar" style="${avatarStyle}">${avatarText}</div>
                        <div class="search-item-info">
                            <div class="search-item-name">${escapeHtml(senderName)}</div>
                            <div class="search-item-text">${highlightText(msg.text.substring(0, 100), query)}</div>
                        </div>
                        <div class="search-item-time">${time}</div>
                    </div>
                `;
            });
            
            html += '</div>';
        }
        
        document.getElementById('search-results').innerHTML = html;
        
        // Обработчики кликов
        document.querySelectorAll('.search-item').forEach(item => {
            item.addEventListener('click', async () => {
                const type = item.dataset.type;
                const id = item.dataset.id;
                
                if (type === 'user') {
                    selectUser(id, item.dataset.name);
                    closeSearchModal();
                } else if (type === 'message') {
                    selectUser(item.dataset.chatId, item.dataset.sender);
                    closeSearchModal();
                } else if (type === 'channel') {
                    // Проверяем, подписан ли пользователь на канал
                    const existingChannel = state.channels.find(c => c.id === id);
                    if (existingChannel) {
                        switchSidebarTab('channels');
                        selectChannel(id);
                        closeSearchModal();
                    } else {
                        // Показываем модалку присоединения
                        closeSearchModal();
                        const channelData = channels.find(c => c.id === id);
                        if (channelData) {
                            showInviteModal('channel', channelData);
                        }
                    }
                } else if (type === 'server') {
                    // Проверяем, состоит ли пользователь на сервере
                    const existingServer = state.servers.find(s => s.id === id);
                    if (existingServer) {
                        switchSidebarTab('servers');
                        selectServer(id);
                        closeSearchModal();
                    } else {
                        // Показываем модалку присоединения
                        closeSearchModal();
                        const serverData = servers.find(s => s.id === id);
                        if (serverData) {
                            showInviteModal('server', serverData);
                        }
                    }
                }
            });
        });
        
    } catch (error) {
        console.error('Search error:', error);
        renderSearchNotFound();
    }
}

// Инициализация поиска
document.addEventListener('DOMContentLoaded', () => {
    // Кнопка открытия поиска
    document.getElementById('global-search-btn')?.addEventListener('click', openSearchModal);
    
    // Закрытие поиска
    document.getElementById('close-search')?.addEventListener('click', closeSearchModal);
    
    // Клик на overlay
    document.querySelector('#search-modal .modal-overlay')?.addEventListener('click', closeSearchModal);
    
    // Ввод в поиск
    document.getElementById('global-search-input')?.addEventListener('input', (e) => {
        clearTimeout(searchTimeout);
        searchTimeout = setTimeout(() => {
            performGlobalSearch(e.target.value.trim());
        }, 300);
    });
    
    // Escape для закрытия
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            const searchModal = document.getElementById('search-modal');
            if (searchModal && !searchModal.classList.contains('hidden')) {
                closeSearchModal();
            }
        }
        
        // Ctrl+K или Cmd+K для открытия поиска
        if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
            e.preventDefault();
            const searchModal = document.getElementById('search-modal');
            if (searchModal?.classList.contains('hidden')) {
                openSearchModal();
            } else {
                closeSearchModal();
            }
        }
    });
});


// === LEGAL DOCUMENTS ===

function parseMarkdown(md) {
    // Простой парсер Markdown
    let html = md
        // Headers
        .replace(/^### (.*$)/gim, '<h3>$1</h3>')
        .replace(/^## (.*$)/gim, '<h2>$1</h2>')
        .replace(/^# (.*$)/gim, '<h1>$1</h1>')
        // Bold
        .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
        // Italic
        .replace(/\*(.*?)\*/g, '<em>$1</em>')
        // Code
        .replace(/`(.*?)`/g, '<code>$1</code>')
        // Lists
        .replace(/^\* (.*$)/gim, '<li>$1</li>')
        .replace(/^\d+\. (.*$)/gim, '<li>$1</li>')
        // Line breaks
        .replace(/\n\n/g, '</p><p>')
        // Tables (basic)
        .replace(/\|([^|]+)\|/g, (match) => {
            const cells = match.split('|').filter(c => c.trim());
            if (cells.some(c => c.includes('---'))) return '';
            const tag = cells[0]?.includes('**') ? 'th' : 'td';
            return '<tr>' + cells.map(c => `<${tag}>${c.trim().replace(/\*\*/g, '')}</${tag}>`).join('') + '</tr>';
        });
    
    // Wrap lists
    html = html.replace(/(<li>.*<\/li>)/gs, '<ul>$1</ul>');
    // Wrap in paragraphs
    html = '<p>' + html + '</p>';
    // Clean up
    html = html.replace(/<p><\/p>/g, '').replace(/<p>(<h[123]>)/g, '$1').replace(/(<\/h[123]>)<\/p>/g, '$1');
    
    return html;
}

async function openLegalDocument(docType) {
    const modal = document.getElementById('legal-modal');
    const title = document.getElementById('legal-title');
    const body = document.getElementById('legal-body');
    
    title.textContent = docType === 'privacy' ? 'Политика конфиденциальности' : 'Условия использования';
    body.innerHTML = '<div class="legal-loading">Загрузка...</div>';
    modal.classList.remove('hidden');
    
    try {
        const res = await fetch(`/api/legal/${docType}`);
        if (!res.ok) throw new Error('Failed to load');
        
        const { content } = await res.json();
        body.innerHTML = parseMarkdown(content);
    } catch (error) {
        console.error('Error loading legal doc:', error);
        body.innerHTML = '<div class="legal-loading">Ошибка загрузки документа</div>';
    }
}

function closeLegalModal() {
    document.getElementById('legal-modal').classList.add('hidden');
}

// Инициализация
document.addEventListener('DOMContentLoaded', () => {
    // Клики на ссылки документов
    document.querySelectorAll('.legal-link').forEach(link => {
        link.addEventListener('click', (e) => {
            e.preventDefault();
            const docType = link.dataset.doc;
            if (docType) {
                openLegalDocument(docType);
            }
        });
    });
    
    // Закрытие модалки
    document.getElementById('close-legal')?.addEventListener('click', closeLegalModal);
    document.querySelector('#legal-modal .modal-overlay')?.addEventListener('click', closeLegalModal);
});

// === PREMIUM FEATURES ===

function updatePremiumHints() {
    const isPremium = state.currentUserProfile?.isPremium || state.currentUser?.role === 'admin';
    const hint = document.getElementById('avatar-premium-hint');
    
    if (hint) {
        if (isPremium) {
            hint.textContent = '✨ GIF/MP4 доступны (Premium)';
            hint.className = 'edit-premium-hint premium';
        } else {
            hint.textContent = 'GIF/MP4 доступны только для Premium';
            hint.className = 'edit-premium-hint';
        }
    }
}

// Вызываем при открытии редактирования профиля
const originalShowEditProfile = window.showEditProfile;
if (typeof originalShowEditProfile === 'function') {
    window.showEditProfile = function() {
        originalShowEditProfile();
        updatePremiumHints();
    };
}

// Обновляем подсказку при загрузке профиля
document.addEventListener('DOMContentLoaded', () => {
    const editProfileBtn = document.getElementById('edit-profile-btn');
    if (editProfileBtn) {
        editProfileBtn.addEventListener('click', () => {
            setTimeout(updatePremiumHints, 100);
        });
    }
});


// === RESIZABLE SIDEBAR ===

function initSidebarResizer() {
    const resizer = document.getElementById('sidebar-resizer');
    const chatScreen = document.getElementById('chat-screen');
    const panelActions = document.querySelector('.user-panel-actions');
    
    if (!resizer || !chatScreen) return;
    
    let isResizing = false;
    let startX = 0;
    let startWidth = 0;
    
    // Загружаем сохранённую ширину
    const savedWidth = localStorage.getItem('kvant_sidebar_width');
    const initialWidth = savedWidth ? parseInt(savedWidth) : 320;
    if (savedWidth) {
        chatScreen.style.setProperty('--sidebar-width', savedWidth + 'px');
    }
    updatePanelButtons(initialWidth);
    
    function updatePanelButtons(width) {
        if (panelActions) {
            panelActions.style.display = width < 250 ? 'none' : 'flex';
        }
        // Добавляем класс narrow для узкого сайдбара
        const sidebar = document.querySelector('.sidebar');
        if (sidebar) {
            sidebar.classList.toggle('narrow', width < 280);
        }
    }
    
    resizer.addEventListener('mousedown', (e) => {
        isResizing = true;
        startX = e.clientX;
        startWidth = parseInt(getComputedStyle(chatScreen).getPropertyValue('--sidebar-width')) || 320;
        
        resizer.classList.add('resizing');
        document.body.style.cursor = 'col-resize';
        document.body.style.userSelect = 'none';
        
        e.preventDefault();
    });
    
    document.addEventListener('mousemove', (e) => {
        if (!isResizing) return;
        
        const diff = e.clientX - startX;
        let newWidth = startWidth + diff;
        
        // Ограничения: минимум 200px, максимум 500px
        newWidth = Math.max(200, Math.min(500, newWidth));
        
        chatScreen.style.setProperty('--sidebar-width', newWidth + 'px');
        updatePanelButtons(newWidth);
    });
    
    document.addEventListener('mouseup', () => {
        if (!isResizing) return;
        
        isResizing = false;
        resizer.classList.remove('resizing');
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        
        // Сохраняем ширину
        const currentWidth = parseInt(getComputedStyle(chatScreen).getPropertyValue('--sidebar-width')) || 320;
        localStorage.setItem('kvant_sidebar_width', currentWidth);
    });
}

// Инициализация при загрузке
document.addEventListener('DOMContentLoaded', () => {
    initSidebarResizer();
});


// === SETTINGS HANDLERS ===

document.addEventListener('DOMContentLoaded', () => {
    // FAQ аккордеон
    document.querySelectorAll('.faq-question').forEach(btn => {
        btn.addEventListener('click', () => {
            const item = btn.closest('.faq-item');
            const wasOpen = item.classList.contains('open');
            
            // Закрываем все
            document.querySelectorAll('.faq-item').forEach(i => i.classList.remove('open'));
            
            // Открываем текущий если был закрыт
            if (!wasOpen) {
                item.classList.add('open');
            }
        });
    });
    
    // Форма поддержки
    document.getElementById('support-form')?.addEventListener('submit', async (e) => {
        e.preventDefault();
        
        const category = document.getElementById('support-category').value;
        const message = document.getElementById('support-message').value.trim();
        
        if (!category || !message) {
            showToast('Заполните все поля', 'error');
            return;
        }
        
        const btn = e.target.querySelector('.support-submit-btn');
        btn.disabled = true;
        btn.innerHTML = '<span>Отправка...</span>';
        
        try {
            const res = await api.post('/api/support/ticket', { category, message });
            const data = await res.json();
            
            if (res.ok) {
                showToast('Обращение отправлено!', 'success');
                e.target.reset();
                loadSupportTickets();
            } else {
                showToast(data.error || 'Ошибка отправки', 'error');
            }
        } catch (err) {
            showToast('Ошибка сети', 'error');
        } finally {
            btn.disabled = false;
            btn.innerHTML = '<span>Отправить</span>';
        }
    });
    
    // Уведомления
    document.getElementById('notifications-checkbox')?.addEventListener('change', (e) => {
        state.notificationsEnabled = e.target.checked;
        localStorage.setItem('notifications', state.notificationsEnabled);
        if (state.notificationsEnabled) {
            requestNotificationPermission();
        }
        showToast(e.target.checked ? 'Уведомления включены' : 'Уведомления выключены');
    });
    
    // Звуки
    document.getElementById('sounds-checkbox')?.addEventListener('change', (e) => {
        state.settings.sounds = e.target.checked;
        saveSettings();
        showToast(e.target.checked ? 'Звуки включены' : 'Звуки выключены');
    });
    
    // Функция для обновления визуального прогресса ползунка
    function updateSliderProgress(slider) {
        const min = parseFloat(slider.min) || 0;
        const max = parseFloat(slider.max) || 100;
        const value = parseFloat(slider.value);
        const percent = ((value - min) / (max - min)) * 100;
        slider.style.setProperty('--value-percent', `${percent}%`);
    }
    
    // Громкость
    const volumeSlider = document.getElementById('volume-slider');
    const volumeValue = document.getElementById('volume-value');
    if (volumeSlider) {
        volumeSlider.value = state.settings.volume ?? 50;
        if (volumeValue) volumeValue.textContent = volumeSlider.value;
        updateSliderProgress(volumeSlider);
        
        volumeSlider.addEventListener('input', (e) => {
            const vol = parseInt(e.target.value);
            state.settings.volume = vol;
            if (volumeValue) volumeValue.textContent = vol;
            updateSliderProgress(e.target);
            saveSettings();
        });
    }
    
    // Прозрачность панелей
    const opacitySlider = document.getElementById('opacity-slider');
    const opacityValue = document.getElementById('opacity-value');
    if (opacitySlider) {
        opacitySlider.value = state.settings.panelOpacity ?? 85;
        opacityValue.textContent = `${opacitySlider.value}%`;
        applyPanelOpacity(state.settings.panelOpacity ?? 85);
        updateSliderProgress(opacitySlider);
        
        opacitySlider.addEventListener('input', (e) => {
            const opacity = parseInt(e.target.value);
            state.settings.panelOpacity = opacity;
            opacityValue.textContent = `${opacity}%`;
            applyPanelOpacity(opacity);
            updateSliderProgress(e.target);
            saveSettings();
        });
    }
    
    // Размытие фона
    const bgBlurSlider = document.getElementById('bg-blur-slider');
    const bgBlurValue = document.getElementById('bg-blur-value');
    if (bgBlurSlider) {
        bgBlurSlider.value = state.settings.bgBlur ?? 0;
        bgBlurValue.textContent = `${bgBlurSlider.value}px`;
        applyBgBlur(state.settings.bgBlur ?? 0);
        
        bgBlurSlider.addEventListener('input', (e) => {
            const blur = parseInt(e.target.value);
            state.settings.bgBlur = blur;
            bgBlurValue.textContent = `${blur}px`;
            applyBgBlur(blur);
            saveSettings();
        });
    }
    
    // Затемнение фона
    const bgDimSlider = document.getElementById('bg-dim-slider');
    const bgDimValue = document.getElementById('bg-dim-value');
    if (bgDimSlider) {
        bgDimSlider.value = state.settings.bgDim ?? 0;
        bgDimValue.textContent = `${bgDimSlider.value}%`;
        applyBgDim(state.settings.bgDim ?? 0);
        
        bgDimSlider.addEventListener('input', (e) => {
            const dim = parseInt(e.target.value);
            state.settings.bgDim = dim;
            bgDimValue.textContent = `${dim}%`;
            applyBgDim(dim);
            saveSettings();
        });
    }
    
    // Скругление пузырей
    const bubbleRadiusSlider = document.getElementById('bubble-radius-slider');
    const bubbleRadiusValue = document.getElementById('bubble-radius-value');
    if (bubbleRadiusSlider) {
        bubbleRadiusSlider.value = state.settings.bubbleRadius ?? 18;
        bubbleRadiusValue.textContent = `${bubbleRadiusSlider.value}px`;
        applyBubbleRadius(state.settings.bubbleRadius ?? 18);
        
        bubbleRadiusSlider.addEventListener('input', (e) => {
            const radius = parseInt(e.target.value);
            state.settings.bubbleRadius = radius;
            bubbleRadiusValue.textContent = `${radius}px`;
            applyBubbleRadius(radius);
            saveSettings();
        });
    }
    
    // Плотность интерфейса
    document.querySelectorAll('.density-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.density-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            state.settings.density = btn.dataset.density;
            applyDensity(btn.dataset.density);
            saveSettings();
        });
    });
    
    // Инициализация плотности
    if (state.settings.density) {
        document.querySelectorAll('.density-btn').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.density === state.settings.density);
        });
        applyDensity(state.settings.density);
    }
    
    // Анимации сообщений
    document.getElementById('setting-animations')?.addEventListener('change', (e) => {
        state.settings.animations = e.target.checked;
        saveSettings();
        applyAnimations(e.target.checked);
    });
    
    // Время отправки
    document.getElementById('setting-timestamps')?.addEventListener('change', (e) => {
        state.settings.timestamps = e.target.checked;
        saveSettings();
        applyTimestamps(e.target.checked);
    });
    
    // Показывать аватарки
    document.getElementById('setting-avatars')?.addEventListener('change', (e) => {
        state.settings.hideAvatars = !e.target.checked;
        saveSettings();
        applySettings();
    });
    
    // Статус онлайн
    document.getElementById('setting-online-status')?.addEventListener('change', (e) => {
        state.settings.showOnlineStatus = e.target.checked;
        saveSettings();
    });
    
    // Индикатор набора
    document.getElementById('setting-typing')?.addEventListener('change', (e) => {
        state.settings.typing = e.target.checked;
        saveSettings();
    });
    
    // Скрытый онлайн (Premium)
    document.getElementById('setting-hide-online')?.addEventListener('change', async (e) => {
        const isPremium = state.currentUserProfile?.isPremium || state.currentUser?.role === 'admin';
        if (!isPremium) {
            e.target.checked = false;
            showToast('Эта функция доступна только для Premium', 'error');
            return;
        }
        
        try {
            await api.put(`/api/user/${state.currentUser.id}/premium-settings`, {
                hide_online: e.target.checked
            });
            showToast(e.target.checked ? 'Вы теперь невидимы' : 'Статус онлайн виден');
        } catch (err) {
            e.target.checked = !e.target.checked;
            showToast('Ошибка сохранения', 'error');
        }
    });
    
    // Сброс цвета ника
    document.getElementById('reset-name-color')?.addEventListener('click', () => {
        document.getElementById('edit-name-color').value = '#4fc3f7';
    });
    
    // Сброс цвета профиля
    document.getElementById('reset-profile-color')?.addEventListener('click', () => {
        document.getElementById('edit-profile-color').value = '#1976d2';
        document.getElementById('edit-banner-preview').style.background = '#1976d2';
    });
    
    // Выбор стиля пузырей (Premium+) - сохраняется на сервер
    document.querySelectorAll('.bubble-style-option').forEach(opt => {
        opt.addEventListener('click', async () => {
            // Проверка Premium+
            const isPremiumPlus = state.currentUserProfile?.premiumPlan === 'premium_plus' || state.currentUser?.role === 'admin';
            if (!isPremiumPlus && opt.dataset.style !== 'default') {
                showToast('Стили пузырей доступны только для Premium+', 'error');
                return;
            }
            
            document.querySelectorAll('.bubble-style-option').forEach(o => o.classList.remove('active'));
            opt.classList.add('active');
            
            // Сохраняем на сервер
            try {
                await api.put(`/api/user/${state.currentUser.id}/premium-settings`, {
                    bubble_style: opt.dataset.style
                });
                // Обновляем локальный профиль
                if (state.currentUserProfile) {
                    state.currentUserProfile.bubble_style = opt.dataset.style;
                }
                applyBubbleStyle();
                showToast('Стиль пузырей обновлён');
            } catch (e) {
                showToast('Ошибка сохранения', 'error');
            }
        });
    });
    
    // Превью цвета баннера при изменении
    document.getElementById('edit-profile-color')?.addEventListener('input', (e) => {
        const bannerPreview = document.getElementById('edit-banner-preview');
        if (bannerPreview && !bannerPreview.style.backgroundImage) {
            bannerPreview.style.background = e.target.value;
        }
    });
    
    // Фон чата
    document.querySelectorAll('.bg-option').forEach(opt => {
        opt.addEventListener('click', () => {
            if (opt.dataset.bg === 'custom') {
                document.getElementById('custom-bg-input')?.click();
                return;
            }
            document.querySelectorAll('.bg-option').forEach(o => o.classList.remove('active'));
            opt.classList.add('active');
            state.settings.background = opt.dataset.bg;
            saveSettings();
            applySettings();
            updateBgModeVisibility();
        });
    });
    
    // Кастомный фон с кроппером
    const customBgInput = document.getElementById('custom-bg-input');
    if (customBgInput) {
        // Сбрасываем при клике чтобы можно было выбрать тот же файл
        customBgInput.addEventListener('click', () => {
            customBgInput.value = '';
        });
        customBgInput.addEventListener('change', (e) => {
            const file = e.target.files[0];
            if (file) {
                const reader = new FileReader();
                reader.onload = (ev) => {
                    openBgCropper(ev.target.result);
                };
                reader.readAsDataURL(file);
            }
        });
    }
    
    // Режим отображения фона
    function updateBgModeVisibility() {
        const bgModeSetting = document.getElementById('bg-mode-setting');
        if (bgModeSetting) {
            const showMode = state.settings.background === 'custom' || state.settings.background === 'default';
            bgModeSetting.style.display = showMode ? 'flex' : 'none';
        }
    }
    
    document.querySelectorAll('.bg-mode-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.bg-mode-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            state.settings.bgMode = btn.dataset.mode;
            saveSettings();
            applySettings();
        });
    });
    
    // Инициализация режима фона
    if (state.settings.bgMode) {
        document.querySelectorAll('.bg-mode-btn').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.mode === state.settings.bgMode);
        });
    }
    updateBgModeVisibility();
    
    // Размер сообщений
    document.querySelectorAll('.size-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.size-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            state.settings.messageSize = btn.dataset.size;
            saveSettings();
            applySettings();
        });
    });
    
    // Акцентный цвет
    document.querySelectorAll('.color-option').forEach(opt => {
        opt.addEventListener('click', () => {
            document.querySelectorAll('.color-option').forEach(o => o.classList.remove('active'));
            opt.classList.add('active');
            state.settings.accentColor = opt.dataset.color;
            saveSettings();
            applySettings();
            showToast('Цвет изменён');
        });
    });
    
    // Тема (с проверкой премиум)
    document.querySelectorAll('.theme-option').forEach(opt => {
        opt.addEventListener('click', () => {
            // Проверка премиум-тем
            const premiumThemes = ['neon', 'sunset', 'ocean', 'forest', 'cherry', 'amoled'];
            if (premiumThemes.includes(opt.dataset.theme)) {
                const isPremium = state.currentUserProfile?.isPremium || state.currentUser?.role === 'admin';
                if (!isPremium) {
                    showToast('Эта тема доступна только для Premium', 'error');
                    return;
                }
            }
            
            document.querySelectorAll('.theme-option').forEach(o => o.classList.remove('active'));
            opt.classList.add('active');
            state.settings.theme = opt.dataset.theme;
            saveSettings();
            applyTheme(opt.dataset.theme);
        });
    });
    
    // Навигация по разделам настроек
    document.querySelectorAll('.settings-nav-item').forEach(item => {
        item.addEventListener('click', () => {
            document.querySelectorAll('.settings-nav-item').forEach(i => i.classList.remove('active'));
            document.querySelectorAll('.settings-section').forEach(s => s.classList.remove('active'));
            item.classList.add('active');
            document.getElementById(`section-${item.dataset.section}`)?.classList.add('active');
        });
    });
    
    // Кнопка настроек
    document.getElementById('settings-btn')?.addEventListener('click', showSettings);
    
    // Закрытие настроек
    document.getElementById('close-settings')?.addEventListener('click', () => {
        document.getElementById('settings-modal').classList.add('hidden');
    });
    
});

// Функции сохранения и применения настроек
function saveSettings() {
    localStorage.setItem('kvant_settings', JSON.stringify(state.settings));
    // Синхронизируем с сервером
    syncSettingsToServer();
}

function applySettings() {
    const chatScreen = document.getElementById('chat-screen');
    const messagesDiv = document.getElementById('messages');
    
    if (chatScreen) {
        chatScreen.classList.remove('bg-gradient1', 'bg-gradient2', 'bg-gradient3', 'bg-solid', 'bg-custom', 'bg-mode-contain');
        chatScreen.style.backgroundImage = '';
        
        if (state.settings.background && state.settings.background !== 'default') {
            if (state.settings.background === 'custom' && state.settings.customBg) {
                chatScreen.classList.add('bg-custom');
                chatScreen.style.backgroundImage = `url(${state.settings.customBg})`;
            } else {
                chatScreen.classList.add(`bg-${state.settings.background}`);
            }
        }
        
        // Применяем режим отображения фона
        if (state.settings.bgMode === 'contain') {
            chatScreen.classList.add('bg-mode-contain');
        }
    }
    
    if (messagesDiv) {
        messagesDiv.className = 'messages';
        
        if (state.settings.messageSize && state.settings.messageSize !== 'medium') {
            messagesDiv.classList.add(`size-${state.settings.messageSize}`);
        }
        
        if (state.settings.compact) {
            messagesDiv.classList.add('compact');
        }
        
        if (state.settings.hideAvatars) {
            messagesDiv.classList.add('no-avatars');
        }
    }
    
    if (state.settings.accentColor) {
        document.documentElement.style.setProperty('--accent', state.settings.accentColor);
        document.documentElement.style.setProperty('--message-sent', 
            `linear-gradient(135deg, ${state.settings.accentColor}, ${adjustColor(state.settings.accentColor, -30)})`);
        
        // Устанавливаем filter параметры для иконок на основе акцентного цвета
        const filterParams = getAccentFilterParams(state.settings.accentColor);
        document.documentElement.style.setProperty('--accent-invert', filterParams.invert);
        document.documentElement.style.setProperty('--accent-sepia', filterParams.sepia);
        document.documentElement.style.setProperty('--accent-saturate', filterParams.saturate);
        document.documentElement.style.setProperty('--accent-hue', filterParams.hue);
    }
    
    if (state.settings.theme) {
        applyTheme(state.settings.theme);
    }
    
    // Применяем новые настройки оформления
    applyBubbleRadius(state.settings.bubbleRadius ?? 18);
    applyDensity(state.settings.density || 'normal');
    applyBgBlur(state.settings.bgBlur ?? 0);
    applyBgDim(state.settings.bgDim ?? 0);
    applyPanelOpacity(state.settings.panelOpacity ?? 85);
    
    // Применяем стиль пузырей
    applyBubbleStyle();
}

// Получить параметры filter для акцентного цвета
function getAccentFilterParams(hexColor) {
    // Конвертируем hex в HSL
    const hex = hexColor.replace('#', '');
    const r = parseInt(hex.substr(0, 2), 16) / 255;
    const g = parseInt(hex.substr(2, 2), 16) / 255;
    const b = parseInt(hex.substr(4, 2), 16) / 255;
    
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    let h, s, l = (max + min) / 2;
    
    if (max === min) {
        h = s = 0;
    } else {
        const d = max - min;
        s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
        switch (max) {
            case r: h = ((g - b) / d + (g < b ? 6 : 0)) / 6; break;
            case g: h = ((b - r) / d + 2) / 6; break;
            case b: h = ((r - g) / d + 4) / 6; break;
        }
    }
    
    // Преобразуем HSL в параметры filter
    const hue = Math.round(h * 360);
    const saturate = Math.round(s * 2000) + 500;
    const invert = l > 0.5 ? '80%' : '50%';
    const sepia = '80%';
    
    return {
        hue: `${hue}deg`,
        saturate: `${saturate}%`,
        invert,
        sepia
    };
}

// Применить стиль пузырей сообщений (Premium+)
function applyBubbleStyle() {
    const style = state.currentUserProfile?.bubble_style || 'default';
    
    // Применяем к реальным сообщениям
    const messages = document.querySelectorAll('.message.sent');
    messages.forEach(msg => {
        msg.classList.forEach(cls => {
            if (cls.startsWith('bubble-')) {
                msg.classList.remove(cls);
            }
        });
        if (style !== 'default') {
            msg.classList.add(`bubble-${style}`);
        }
    });
    
    // Применяем к превью в настройках
    const previewMessages = document.querySelectorAll('.preview-message.sent');
    previewMessages.forEach(msg => {
        msg.classList.forEach(cls => {
            if (cls.startsWith('bubble-')) {
                msg.classList.remove(cls);
            }
        });
        if (style !== 'default') {
            msg.classList.add(`bubble-${style}`);
        }
    });
}

// Получить класс стиля пузыря для сообщения (свой или чужой)
function getBubbleStyleClass(senderBubbleStyle = null) {
    // Если передан стиль отправителя - используем его
    if (senderBubbleStyle && senderBubbleStyle !== 'default') {
        return `bubble-${senderBubbleStyle}`;
    }
    // Для своих сообщений используем свой стиль
    const style = state.currentUserProfile?.bubble_style || 'default';
    return style !== 'default' ? `bubble-${style}` : '';
}

function adjustColor(color, amount) {
    const hex = color.replace('#', '');
    const r = Math.max(0, Math.min(255, parseInt(hex.substr(0, 2), 16) + amount));
    const g = Math.max(0, Math.min(255, parseInt(hex.substr(2, 2), 16) + amount));
    const b = Math.max(0, Math.min(255, parseInt(hex.substr(4, 2), 16) + amount));
    return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
}

// === SIDEBAR NAVIGATION ===
document.addEventListener('DOMContentLoaded', () => {
    // Dock навигация
    const dockContainer = document.getElementById('sidebar-dock');
    if (dockContainer && window.Dock) {
        const dockItems = [
            { icon: '<img src="/assets/message.svg" class="dock-img">', label: 'Чаты', tab: 'chats' },
            { icon: '<img src="/assets/group.svg" class="dock-img">', label: 'Группы', tab: 'groups' },
            { icon: '<img src="/assets/megaphone.svg" class="dock-img">', label: 'Каналы', tab: 'channels' },
            { icon: '<img src="/assets/Castle.svg" class="dock-img">', label: 'Серверы', tab: 'servers' },
            { icon: '<img src="/assets/badge-dollar.svg" class="dock-img">', label: 'Подписка', action: 'subscription' },
            { icon: '<img src="/assets/Plus.svg" class="dock-img">', label: 'Создать', action: 'create' }
        ];
        
        window.sidebarDock = new Dock(dockContainer, {
            items: dockItems,
            baseSize: 40,
            magnification: 54,
            distance: 80,
            onItemClick: (item, index) => {
                if (item.action === 'create') {
                    openCreateModal();
                } else if (item.action === 'subscription') {
                    openSubscriptionModal();
                } else {
                    switchSidebarTab(item.tab);
                }
            }
        });
    }
    
    // Закрытие модалки создания
    document.getElementById('create-modal-close')?.addEventListener('click', closeCreateModal);
    document.querySelector('#create-modal .modal-overlay')?.addEventListener('click', closeCreateModal);
    
    // Табы в модалке создания
    document.querySelectorAll('.create-tab').forEach(tab => {
        tab.addEventListener('click', () => {
            document.querySelectorAll('.create-tab').forEach(t => t.classList.remove('active'));
            tab.classList.add('active');
            updateCreateModalUI(tab.dataset.create);
        });
    });
    
    // Форма создания
    document.getElementById('create-form')?.addEventListener('submit', handleCreateSubmit);
    
    // Поиск участников для группы
    document.getElementById('create-members-search')?.addEventListener('input', debounce(searchMembersForGroup, 300));
    
    // Выбор аватарки при создании
    const avatarPreview = document.getElementById('create-avatar-preview');
    const avatarInput = document.getElementById('create-avatar-input');
    
    avatarPreview?.addEventListener('click', () => avatarInput?.click());
    avatarInput?.addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (file) {
            const reader = new FileReader();
            reader.onload = (ev) => {
                avatarPreview.innerHTML = `<img src="${ev.target.result}" alt="Preview">`;
            };
            reader.readAsDataURL(file);
        }
    });
});

function switchSidebarTab(tab) {
    state.currentTab = tab;
    
    // Обновляем dock
    const tabs = ['chats', 'groups', 'channels', 'servers'];
    const tabIndex = tabs.indexOf(tab);
    if (window.sidebarDock && tabIndex >= 0) {
        window.sidebarDock.setActive(tabIndex);
    }
    
    // Обновляем списки
    document.querySelectorAll('.sidebar-tab').forEach(el => {
        el.classList.toggle('active', el.dataset.tab === tab);
    });
    
    // Загружаем данные если нужно
    if (tab === 'groups' && state.groups.length === 0) loadGroups();
    if (tab === 'channels' && state.channels.length === 0) loadChannels();
    if (tab === 'servers' && state.servers.length === 0) loadServers();
}

function openCreateModal() {
    const modal = document.getElementById('create-modal');
    if (!modal) return;
    
    modal.classList.remove('hidden');
    document.getElementById('create-name').value = '';
    document.getElementById('create-description').value = '';
    document.getElementById('create-selected-members').innerHTML = '';
    document.getElementById('create-members-results').innerHTML = '';
    
    // Устанавливаем активный таб в зависимости от текущего раздела
    const createType = state.currentTab === 'channels' ? 'channel' : 
                       state.currentTab === 'servers' ? 'server' : 'group';
    document.querySelectorAll('.create-tab').forEach(t => {
        t.classList.toggle('active', t.dataset.create === createType);
    });
    updateCreateModalUI(createType);
}

function closeCreateModal() {
    document.getElementById('create-modal')?.classList.add('hidden');
}

// === МОДАЛКА ПОДПИСКИ ===
function openSubscriptionModal() {
    const modal = document.getElementById('subscription-modal');
    if (!modal) return;
    
    modal.classList.remove('hidden');
    loadSubscriptionStatus();
    
    // Инициализируем электрические рамки
    setTimeout(() => {
        document.querySelectorAll('.subscription-card').forEach((card, i) => {
            if (!card.querySelector('.eb-layers')) {
                const color = card.dataset.plan === 'premium_plus' ? '#a855f7' : '#FFD700';
                initElectricBorder(card, color, { chaos: 0.4, thickness: 3 });
            }
        });
    }, 100);
}

// === ELECTRIC BORDER EFFECT ===
// === ELECTRIC BORDER EFFECT (Optimized CSS-only version) ===
function initElectricBorder(element, color = '#FFD700', options = {}) {
    const { thickness = 2 } = options;
    
    element.classList.add('electric-border');
    element.style.setProperty('--electric-border-color', color);
    element.style.setProperty('--eb-border-width', `${thickness}px`);
    
    // Проверяем, не добавлены ли уже слои
    if (element.querySelector('.eb-layers')) return;
    
    // Создаём слои (без тяжёлых SVG фильтров)
    const layers = document.createElement('div');
    layers.className = 'eb-layers';
    layers.innerHTML = `
        <div class="eb-stroke"></div>
        <div class="eb-glow-1"></div>
        <div class="eb-glow-2"></div>
        <div class="eb-background-glow"></div>
    `;
    
    // Оборачиваем контент
    const content = document.createElement('div');
    content.className = 'eb-content';
    while (element.firstChild) {
        content.appendChild(element.firstChild);
    }
    
    element.appendChild(layers);
    element.appendChild(content);
}

function closeSubscriptionModal() {
    document.getElementById('subscription-modal')?.classList.add('hidden');
}

async function loadSubscriptionStatus() {
    try {
        const res = await api.get('/api/subscription/status');
        if (res.ok) {
            const data = await res.json();
            updateSubscriptionUI(data);
        }
    } catch (e) {
        console.log('Failed to load subscription:', e);
    }
}

function updateSubscriptionUI(data) {
    const statusEl = document.getElementById('subscription-current');
    const premiumBtn = document.getElementById('subscribe-premium-btn');
    const premiumPlusBtn = document.getElementById('subscribe-premium-plus-btn');
    
    if (!statusEl) return;
    
    // Обновляем статус
    statusEl.className = 'subscription-current ' + (data.plan || 'free');
    
    const icons = { 
        free: '<img src="/assets/Sparkles.svg" class="icon-sm">', 
        premium: '<img src="/assets/dimond.svg" class="icon-sm">', 
        premium_plus: '<img src="/assets/dimond-plus.svg" class="icon-sm">' 
    };
    const names = { free: 'Бесплатный план', premium: 'Premium', premium_plus: 'Premium+' };
    const descs = { 
        free: 'Базовые функции мессенджера',
        premium: 'Активна до ' + (data.expires ? new Date(data.expires).toLocaleDateString('ru') : ''),
        premium_plus: 'Активна до ' + (data.expires ? new Date(data.expires).toLocaleDateString('ru') : '')
    };
    
    statusEl.innerHTML = `
        <span class="subscription-icon">${icons[data.plan] || icons.free}</span>
        <div class="subscription-info">
            <span class="subscription-plan">${names[data.plan] || names.free}</span>
            <span class="subscription-desc">${descs[data.plan] || descs.free}</span>
        </div>
    `;
    
    // Обновляем кнопки
    if (premiumBtn) {
        premiumBtn.textContent = data.plan === 'premium' ? 'Активно' : 'Оформить';
        premiumBtn.disabled = data.plan === 'premium' || data.plan === 'premium_plus';
    }
    if (premiumPlusBtn) {
        premiumPlusBtn.textContent = data.plan === 'premium_plus' ? 'Активно' : 'Оформить';
        premiumPlusBtn.disabled = data.plan === 'premium_plus';
    }
}

// Обработчики кнопок подписки
const DONATION_ALERTS_URL = 'https://www.donationalerts.com/r/ucatatsu';

function showSubscriptionWarning(planName, price) {
    const modal = document.getElementById('subscription-warning-modal');
    if (!modal) return;
    
    const planNameEl = document.getElementById('warning-plan-name');
    const priceEl = document.getElementById('warning-price');
    const usernameEl = document.getElementById('warning-username');
    
    if (planNameEl) planNameEl.textContent = planName;
    if (priceEl) priceEl.textContent = price;
    if (usernameEl) usernameEl.textContent = state.currentUser?.username || 'ваш_ник';
    
    modal.classList.remove('hidden');
}

function closeSubscriptionWarning() {
    document.getElementById('subscription-warning-modal')?.classList.add('hidden');
}

function proceedToPayment() {
    closeSubscriptionWarning();
    window.open(DONATION_ALERTS_URL, '_blank');
}

document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('subscription-modal-close')?.addEventListener('click', closeSubscriptionModal);
    document.querySelector('#subscription-modal .modal-overlay')?.addEventListener('click', closeSubscriptionModal);
    
    document.getElementById('subscribe-premium-btn')?.addEventListener('click', () => {
        showSubscriptionWarning('Premium', '120 ₽');
    });
    
    document.getElementById('subscribe-premium-plus-btn')?.addEventListener('click', () => {
        showSubscriptionWarning('Premium+', '200 ₽');
    });
    
    // Модалка предупреждения
    document.getElementById('warning-modal-close')?.addEventListener('click', closeSubscriptionWarning);
    document.querySelector('#subscription-warning-modal .modal-overlay')?.addEventListener('click', closeSubscriptionWarning);
    document.getElementById('warning-cancel-btn')?.addEventListener('click', closeSubscriptionWarning);
    document.getElementById('warning-proceed-btn')?.addEventListener('click', proceedToPayment);
});

// === SUPPORT TICKETS ===
async function loadSupportTickets() {
    const container = document.getElementById('support-tickets');
    if (!container) return;
    
    try {
        const res = await api.get('/api/support/tickets');
        if (!res.ok) throw new Error('Failed to load');
        
        const tickets = await res.json();
        
        if (!tickets.length) {
            container.innerHTML = `
                <div class="tickets-empty">
                    <span class="tickets-empty-icon">📭</span>
                    <p>У вас пока нет обращений</p>
                </div>
            `;
            return;
        }
        
        const categoryLabels = {
            bug: '🐛 Ошибка',
            feature: '💡 Предложение',
            account: '👤 Аккаунт',
            payment: '💳 Оплата',
            other: '📝 Другое'
        };
        
        const statusLabels = {
            open: 'Открыт',
            answered: 'Отвечен',
            closed: 'Закрыт'
        };
        
        container.innerHTML = tickets.map(t => `
            <div class="ticket-item" data-ticket-id="${t.id}">
                <div class="ticket-info">
                    <span class="ticket-category">${categoryLabels[t.category] || t.category}</span>
                    <span class="ticket-preview">${escapeHtml(t.message.substring(0, 50))}${t.message.length > 50 ? '...' : ''}</span>
                </div>
                <div class="ticket-meta">
                    <span class="ticket-date">${formatDate(t.created_at)}</span>
                    <span class="ticket-status ${t.status}">${statusLabels[t.status] || t.status}</span>
                </div>
            </div>
        `).join('');
        
    } catch (e) {
        console.log('Failed to load tickets:', e);
    }
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

function formatDate(dateStr) {
    const date = new Date(dateStr);
    const now = new Date();
    const diff = now - date;
    
    if (diff < 60000) return 'только что';
    if (diff < 3600000) return Math.floor(diff / 60000) + ' мин назад';
    if (diff < 86400000) return Math.floor(diff / 3600000) + ' ч назад';
    
    return date.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });
}

function updateCreateModalUI(type) {
    const membersSection = document.getElementById('create-members-section');
    const channelOptions = document.getElementById('create-channel-options');
    const title = document.getElementById('create-modal-title');
    
    membersSection?.classList.toggle('hidden', type !== 'group');
    channelOptions?.classList.toggle('hidden', type !== 'channel');
    
    if (title) {
        title.textContent = type === 'group' ? 'Создать группу' :
                           type === 'channel' ? 'Создать канал' : 'Создать сервер';
    }
}

let selectedMemberIds = [];

async function searchMembersForGroup(e) {
    const query = e.target.value.trim();
    const results = document.getElementById('create-members-results');
    if (!results) return;
    
    if (query.length < 2) {
        results.innerHTML = '';
        return;
    }
    
    try {
        const res = await api.get(`/api/users?search=${encodeURIComponent(query)}`);
        const users = await res.json();
        
        results.innerHTML = users
            .filter(u => u.id !== state.currentUser.id && !selectedMemberIds.includes(u.id))
            .map(u => `
                <div class="create-member-item" data-user-id="${u.id}" data-username="${escapeAttr(u.username)}">
                    <div class="user-avatar">${u.avatar_url ? `<img src="${u.avatar_url}">` : u.username[0].toUpperCase()}</div>
                    <span>${escapeHtml(u.display_name || u.username)}</span>
                </div>
            `).join('');
        
        results.querySelectorAll('.create-member-item').forEach(el => {
            el.addEventListener('click', () => addMemberToSelection(el.dataset.userId, el.dataset.username));
        });
    } catch (e) {
        console.error('Search members error:', e);
    }
}

function addMemberToSelection(userId, username) {
    if (selectedMemberIds.includes(userId)) return;
    
    selectedMemberIds.push(userId);
    
    const container = document.getElementById('create-selected-members');
    const tag = document.createElement('span');
    tag.className = 'selected-member-tag';
    tag.dataset.userId = userId;
    tag.innerHTML = `${escapeHtml(username)} <span class="remove">✕</span>`;
    
    tag.querySelector('.remove').addEventListener('click', () => {
        selectedMemberIds = selectedMemberIds.filter(id => id !== userId);
        tag.remove();
    });
    
    container.appendChild(tag);
    
    // Убираем из результатов поиска
    document.querySelector(`.create-member-item[data-user-id="${userId}"]`)?.remove();
}

async function handleCreateSubmit(e) {
    e.preventDefault();
    
    const activeTab = document.querySelector('.create-tab.active');
    const type = activeTab?.dataset.create || 'group';
    const name = document.getElementById('create-name').value.trim();
    const description = document.getElementById('create-description').value.trim();
    const avatarInput = document.getElementById('create-avatar-input');
    const avatarFile = avatarInput?.files[0];
    
    if (!name) {
        showToast('Укажите название', 'error');
        return;
    }
    
    try {
        showToast('Создание...', 'info');
        
        // Сначала загружаем аватарку если есть
        let avatarUrl = null;
        if (avatarFile) {
            const formData = new FormData();
            formData.append('file', avatarFile);
            const uploadRes = await api.uploadFile('/api/upload-message-file', formData);
            const uploadResult = await uploadRes.json();
            if (uploadResult.success) {
                avatarUrl = uploadResult.fileUrl;
            }
        }
        
        let res;
        if (type === 'group') {
            res = await api.post('/api/groups', { name, description, memberIds: selectedMemberIds, avatarUrl });
        } else if (type === 'channel') {
            const isPublic = document.getElementById('create-channel-public')?.checked;
            res = await api.post('/api/channels', { name, description, isPublic, avatarUrl });
        } else {
            res = await api.post('/api/servers', { name, description, iconUrl: avatarUrl });
        }
        
        const result = await res.json();
        
        if (result.success) {
            showToast(`${type === 'group' ? 'Группа' : type === 'channel' ? 'Канал' : 'Сервер'} создан!`, 'success');
            closeCreateModal();
            selectedMemberIds = [];
            // Сбрасываем превью аватарки
            document.getElementById('create-avatar-preview').innerHTML = '📷';
            avatarInput.value = '';
            
            // Перезагружаем список
            if (type === 'group') { await loadGroups(); switchSidebarTab('groups'); }
            if (type === 'channel') { await loadChannels(); switchSidebarTab('channels'); }
            if (type === 'server') { await loadServers(); switchSidebarTab('servers'); }
        } else {
            showToast(result.error || 'Ошибка создания', 'error');
        }
    } catch (e) {
        console.error('Create error:', e);
        showToast('Ошибка создания', 'error');
    }
}

// === SOCKET EVENTS FOR GROUPS/CHANNELS/SERVERS ===
function initGroupChannelServerSockets() {
    if (!state.socket) return;
    
    // Групповые сообщения
    state.socket.on('group-message', (message) => {
        if (state.selectedGroup?.id === message.group_id) {
            appendGroupMessage(message);
        }
        // TODO: обновить превью в списке групп
    });
    
    state.socket.on('group-typing', (data) => {
        if (state.selectedGroup && data.userId !== state.currentUser.id) {
            // TODO: показать индикатор печати
        }
    });
    
    // Посты каналов
    state.socket.on('channel-post', (post) => {
        if (state.selectedChannel?.id === post.channel_id) {
            appendChannelPost(post);
        }
    });
    
    // Сообщения серверов
    state.socket.on('server-message', (message) => {
        if (state.selectedServerChannel?.id === message.channel_id) {
            appendServerMessage(message);
        }
    });
}

function appendGroupMessage(msg) {
    const container = getEl('messages');
    const isSent = msg.sender_id === state.currentUser.id;
    
    const div = document.createElement('div');
    div.className = `message ${isSent ? 'sent' : 'received'}`;
    div.dataset.messageId = msg.id;
    
    div.innerHTML = `
        <div class="message-sender-info">
            <span class="message-sender-name" style="color: ${getNameColor(msg)}">${escapeHtml(msg.display_name || msg.username)}</span>
        </div>
        <div class="message-content">
            <div class="message-bubble">${escapeHtml(msg.text)}</div>
            <div class="message-time">${formatTime(msg.created_at)}</div>
        </div>
    `;
    
    container.appendChild(div);
    container.scrollTop = container.scrollHeight;
}

function appendChannelPost(post) {
    const container = getEl('messages');
    
    const div = document.createElement('div');
    const isOwn = post.author_id === state.currentUser?.id;
    div.className = `message channel-post ${isOwn ? 'sent' : 'received'}`;
    div.dataset.postId = post.id;
    
    let content = '';
    if (post.media_url) {
        if (post.media_type === 'image') {
            content += `<img src="${escapeAttr(post.media_url)}" class="message-media" alt="Изображение">`;
        } else if (post.media_type === 'video') {
            content += `<video src="${escapeAttr(post.media_url)}" class="message-media" controls></video>`;
        }
    }
    if (post.text) {
        content += `<div class="message-bubble">${escapeHtml(post.text)}</div>`;
    }
    
    div.innerHTML = `
        <div class="message-content">
            ${content}
            <div class="message-time">${formatTime(post.created_at)} · 👁 ${post.views || 0}</div>
        </div>
    `;
    
    container.appendChild(div);
    container.scrollTop = container.scrollHeight;
}

function appendServerMessage(msg) {
    appendGroupMessage(msg); // Пока используем тот же формат
}

// Модифицируем отправку сообщений для поддержки групп
function sendMessageToCurrentChat() {
    const input = getEl('message-input');
    const text = input.value.trim();
    if (!text) return;
    
    if (state.selectedGroup) {
        state.socket?.emit('group-message', {
            groupId: state.selectedGroup.id,
            text,
            messageType: 'text'
        });
    } else if (state.selectedChannel) {
        // Каналы - только админы могут постить
        state.socket?.emit('channel-post', {
            channelId: state.selectedChannel.id,
            text
        });
    } else if (state.selectedServerChannel) {
        state.socket?.emit('server-message', {
            channelId: state.selectedServerChannel.id,
            text,
            messageType: 'text'
        });
    } else if (state.selectedUser) {
        state.socket?.emit('send-message', {
            receiverId: state.selectedUser.id,
            text,
            messageType: 'text'
        });
    }
    
    input.value = '';
    stopTyping();
}


// === ELASTIC VOLUME SLIDER ===
class ElasticSlider {
    constructor(container, options = {}) {
        this.container = container;
        this.value = options.defaultValue ?? 50;
        this.min = options.min ?? 0;
        this.max = options.max ?? 100;
        this.step = options.step ?? 1;
        this.onChange = options.onChange || (() => {});
        this.leftIcon = options.leftIcon || '🔈';
        this.rightIcon = options.rightIcon || '🔊';
        
        this.isDragging = false;
        this.overflow = 0;
        this.maxOverflow = 50;
        
        this.render();
        this.bindEvents();
    }
    
    render() {
        this.container.innerHTML = `
            <div class="elastic-slider-container">
                <div class="elastic-slider-wrapper">
                    <span class="elastic-slider-icon left-icon">${this.leftIcon}</span>
                    <div class="elastic-slider-track-container">
                        <div class="elastic-slider-track-wrapper">
                            <div class="elastic-slider-track">
                                <div class="elastic-slider-range"></div>
                            </div>
                        </div>
                        <div class="elastic-slider-thumb"></div>
                    </div>
                    <span class="elastic-slider-icon right-icon">${this.rightIcon}</span>
                </div>
                <span class="elastic-slider-value">${Math.round(this.value)}</span>
            </div>
        `;
        
        this.wrapper = this.container.querySelector('.elastic-slider-wrapper');
        this.trackContainer = this.container.querySelector('.elastic-slider-track-container');
        this.trackWrapper = this.container.querySelector('.elastic-slider-track-wrapper');
        this.range = this.container.querySelector('.elastic-slider-range');
        this.thumb = this.container.querySelector('.elastic-slider-thumb');
        this.valueDisplay = this.container.querySelector('.elastic-slider-value');
        this.leftIconEl = this.container.querySelector('.left-icon');
        this.rightIconEl = this.container.querySelector('.right-icon');
        
        this.updateVisuals();
    }
    
    bindEvents() {
        this.trackContainer.addEventListener('pointerdown', this.onPointerDown.bind(this));
        document.addEventListener('pointermove', this.onPointerMove.bind(this));
        document.addEventListener('pointerup', this.onPointerUp.bind(this));
        
        // Touch support
        this.trackContainer.addEventListener('touchstart', (e) => e.preventDefault());
    }
    
    onPointerDown(e) {
        this.isDragging = true;
        this.wrapper.classList.add('active');
        this.trackContainer.setPointerCapture(e.pointerId);
        this.updateFromPointer(e);
    }
    
    onPointerMove(e) {
        if (!this.isDragging) return;
        this.updateFromPointer(e);
    }
    
    onPointerUp() {
        if (!this.isDragging) return;
        this.isDragging = false;
        this.wrapper.classList.remove('active');
        
        // Animate overflow back to 0
        this.animateOverflow(0);
    }
    
    updateFromPointer(e) {
        const rect = this.trackContainer.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const width = rect.width;
        
        // Calculate overflow for elastic effect
        if (x < 0) {
            this.overflow = this.decay(-x, this.maxOverflow);
            this.trackWrapper.classList.add('overflow-left');
            this.trackWrapper.classList.remove('overflow-right');
            this.bounceIcon('left');
        } else if (x > width) {
            this.overflow = this.decay(x - width, this.maxOverflow);
            this.trackWrapper.classList.add('overflow-right');
            this.trackWrapper.classList.remove('overflow-left');
            this.bounceIcon('right');
        } else {
            this.overflow = 0;
            this.trackWrapper.classList.remove('overflow-left', 'overflow-right');
        }
        
        // Calculate value
        let percent = Math.max(0, Math.min(1, x / width));
        let newValue = this.min + percent * (this.max - this.min);
        
        // Apply step
        if (this.step > 0) {
            newValue = Math.round(newValue / this.step) * this.step;
        }
        
        newValue = Math.max(this.min, Math.min(this.max, newValue));
        
        if (newValue !== this.value) {
            this.value = newValue;
            this.onChange(this.value);
        }
        
        this.updateVisuals();
    }
    
    updateVisuals() {
        const percent = ((this.value - this.min) / (this.max - this.min)) * 100;
        this.range.style.width = `${percent}%`;
        this.thumb.style.left = `${percent}%`;
        this.valueDisplay.textContent = Math.round(this.value);
        
        // Apply elastic scale
        const scaleX = 1 + this.overflow / 200;
        const scaleY = 1 - this.overflow / 250;
        this.trackWrapper.style.transform = `scaleX(${scaleX}) scaleY(${scaleY})`;
    }
    
    bounceIcon(side) {
        const icon = side === 'left' ? this.leftIconEl : this.rightIconEl;
        const className = side === 'left' ? 'bounce-left' : 'bounce-right';
        
        if (!icon.classList.contains(className)) {
            icon.classList.add(className);
            setTimeout(() => icon.classList.remove(className), 250);
        }
    }
    
    animateOverflow(target) {
        const start = this.overflow;
        const duration = 300;
        const startTime = performance.now();
        
        const animate = (currentTime) => {
            const elapsed = currentTime - startTime;
            const progress = Math.min(elapsed / duration, 1);
            
            // Elastic easing
            const eased = 1 - Math.pow(1 - progress, 3) * Math.cos(progress * Math.PI * 2);
            this.overflow = start + (target - start) * eased;
            this.updateVisuals();
            
            if (progress < 1) {
                requestAnimationFrame(animate);
            } else {
                this.overflow = target;
                this.trackWrapper.classList.remove('overflow-left', 'overflow-right');
                this.updateVisuals();
            }
        };
        
        requestAnimationFrame(animate);
    }
    
    decay(value, max) {
        if (max === 0) return 0;
        const entry = value / max;
        const sigmoid = 2 * (1 / (1 + Math.exp(-entry)) - 0.5);
        return sigmoid * max;
    }
    
    setValue(newValue) {
        this.value = Math.max(this.min, Math.min(this.max, newValue));
        this.updateVisuals();
    }
    
    getValue() {
        return this.value;
    }
}

// Make it globally available
window.ElasticSlider = ElasticSlider;


// === STEPPER REGISTRATION ===
class RegistrationStepper {
    constructor() {
        this.currentStep = 1;
        this.totalSteps = 4;
        this.data = {
            username: '',
            password: '',
            passwordConfirm: '',
            avatarFile: null,
            avatarPreview: null,
            agreeTerms: false,
            agreePrivacy: false
        };
        
        this.init();
    }
    
    init() {
        // Elements
        this.container = document.getElementById('register-stepper');
        if (!this.container) return;
        
        this.indicators = this.container.querySelectorAll('.step-indicator');
        this.connectors = this.container.querySelectorAll('.step-connector');
        this.panels = this.container.querySelectorAll('.step-panel');
        this.backBtn = document.getElementById('stepper-back');
        this.nextBtn = document.getElementById('stepper-next');
        this.footer = document.getElementById('stepper-footer');
        
        // Inputs
        this.usernameInput = document.getElementById('reg-username');
        this.passwordInput = document.getElementById('reg-password');
        this.passwordConfirmInput = document.getElementById('reg-password-confirm');
        this.avatarPreview = document.getElementById('reg-avatar-preview');
        this.avatarInput = document.getElementById('reg-avatar-input');
        this.skipAvatarBtn = document.getElementById('skip-avatar-btn');
        this.agreeTermsCheckbox = document.getElementById('agree-terms');
        this.agreePrivacyCheckbox = document.getElementById('agree-privacy');
        
        this.bindEvents();
        this.updateUI();
    }
    
    bindEvents() {
        // Navigation
        this.backBtn?.addEventListener('click', () => this.prevStep());
        this.nextBtn?.addEventListener('click', () => this.nextStep());
        
        // Step indicators click
        this.indicators.forEach(ind => {
            ind.addEventListener('click', () => {
                const step = parseInt(ind.dataset.step);
                if (step < this.currentStep) {
                    this.goToStep(step);
                }
            });
        });
        
        // Input validation
        this.usernameInput?.addEventListener('input', (e) => {
            this.data.username = e.target.value;
            this.validateCurrentStep();
        });
        
        this.passwordInput?.addEventListener('input', (e) => {
            this.data.password = e.target.value;
            this.validateCurrentStep();
        });
        
        this.passwordConfirmInput?.addEventListener('input', (e) => {
            this.data.passwordConfirm = e.target.value;
            this.validateCurrentStep();
        });
        
        // Avatar
        this.avatarPreview?.addEventListener('click', () => this.avatarInput?.click());
        this.avatarInput?.addEventListener('change', (e) => {
            const file = e.target.files[0];
            if (file) {
                this.data.avatarFile = file;
                const reader = new FileReader();
                reader.onload = (ev) => {
                    this.data.avatarPreview = ev.target.result;
                    this.avatarPreview.innerHTML = `<img src="${ev.target.result}" alt="Avatar">`;
                };
                reader.readAsDataURL(file);
            }
            this.validateCurrentStep();
        });
        
        this.skipAvatarBtn?.addEventListener('click', () => this.nextStep());
        
        // Checkboxes
        this.agreeTermsCheckbox?.addEventListener('change', (e) => {
            this.data.agreeTerms = e.target.checked;
            this.validateCurrentStep();
        });
        
        this.agreePrivacyCheckbox?.addEventListener('change', (e) => {
            this.data.agreePrivacy = e.target.checked;
            this.validateCurrentStep();
        });
        
        // Enter key
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && this.isRegisterScreenVisible()) {
                e.preventDefault();
                if (!this.nextBtn.disabled) {
                    this.nextStep();
                }
            }
        });
    }
    
    isRegisterScreenVisible() {
        const screen = document.getElementById('register-screen');
        return screen && !screen.classList.contains('hidden');
    }
    
    goToStep(step) {
        const direction = step > this.currentStep ? 1 : -1;
        const oldStep = this.currentStep;
        this.currentStep = step;
        this.animateTransition(oldStep, step, direction);
        this.updateUI();
    }
    
    nextStep() {
        if (this.currentStep === this.totalSteps) {
            this.complete();
            return;
        }
        
        if (!this.validateCurrentStep()) return;
        
        const oldStep = this.currentStep;
        this.currentStep++;
        this.animateTransition(oldStep, this.currentStep, 1);
        this.updateUI();
    }
    
    prevStep() {
        if (this.currentStep <= 1) return;
        
        const oldStep = this.currentStep;
        this.currentStep--;
        this.animateTransition(oldStep, this.currentStep, -1);
        this.updateUI();
    }
    
    animateTransition(from, to, direction) {
        const fromPanel = this.container.querySelector(`.step-panel[data-step="${from}"]`);
        const toPanel = this.container.querySelector(`.step-panel[data-step="${to}"]`);
        
        if (fromPanel) {
            fromPanel.classList.remove('active');
            fromPanel.classList.add(direction > 0 ? 'exit-left' : 'exit-right');
            setTimeout(() => {
                fromPanel.classList.remove('exit-left', 'exit-right');
            }, 400);
        }
        
        if (toPanel) {
            toPanel.style.transform = direction > 0 ? 'translateX(100%)' : 'translateX(-100%)';
            toPanel.classList.add('active');
            
            requestAnimationFrame(() => {
                toPanel.style.transform = '';
            });
        }
    }
    
    updateUI() {
        // Update indicators
        this.indicators.forEach((ind, i) => {
            const step = i + 1;
            ind.classList.remove('active', 'complete');
            
            if (step === this.currentStep) {
                ind.classList.add('active');
                ind.querySelector('.step-indicator-inner').innerHTML = '<div class="active-dot"></div>';
            } else if (step < this.currentStep) {
                ind.classList.add('complete');
                ind.querySelector('.step-indicator-inner').innerHTML = '<svg class="check-icon" viewBox="0 0 24 24"><path d="M5 13l4 4L19 7"/></svg>';
            } else {
                ind.querySelector('.step-indicator-inner').textContent = step;
            }
        });
        
        // Update connectors
        this.connectors.forEach((conn, i) => {
            conn.classList.toggle('complete', i + 1 < this.currentStep);
        });
        
        // Update footer
        this.footer.classList.toggle('has-back', this.currentStep > 1);
        this.backBtn.classList.toggle('hidden', this.currentStep <= 1);
        
        // Update next button text
        if (this.currentStep === this.totalSteps) {
            this.nextBtn.textContent = 'Создать аккаунт';
        } else {
            this.nextBtn.textContent = 'Далее';
        }
        
        // Validate
        this.validateCurrentStep();
        
        // Focus input
        setTimeout(() => {
            if (this.currentStep === 1) this.usernameInput?.focus();
            if (this.currentStep === 2) this.passwordInput?.focus();
        }, 400);
    }
    
    validateCurrentStep() {
        let isValid = false;
        const usernameHint = document.getElementById('username-hint');
        const passwordHint = document.getElementById('password-hint');
        
        switch (this.currentStep) {
            case 1:
                const usernameRegex = /^[a-zA-Z0-9_]{3,20}$/;
                isValid = usernameRegex.test(this.data.username);
                if (usernameHint) {
                    usernameHint.classList.toggle('input-error', this.data.username.length > 0 && !isValid);
                }
                break;
                
            case 2:
                const passValid = this.data.password.length >= 6;
                const passMatch = this.data.password === this.data.passwordConfirm;
                isValid = passValid && passMatch && this.data.passwordConfirm.length > 0;
                if (passwordHint) {
                    if (!passValid && this.data.password.length > 0) {
                        passwordHint.textContent = 'Минимум 6 символов';
                        passwordHint.classList.add('input-error');
                    } else if (!passMatch && this.data.passwordConfirm.length > 0) {
                        passwordHint.textContent = 'Пароли не совпадают';
                        passwordHint.classList.add('input-error');
                    } else {
                        passwordHint.textContent = 'Минимум 6 символов';
                        passwordHint.classList.remove('input-error');
                    }
                }
                break;
                
            case 3:
                isValid = true; // Avatar is optional
                break;
                
            case 4:
                isValid = this.data.agreeTerms && this.data.agreePrivacy;
                break;
        }
        
        this.nextBtn.disabled = !isValid;
        return isValid;
    }
    
    async complete() {
        this.nextBtn.disabled = true;
        this.nextBtn.textContent = 'Создание...';
        
        try {
            // Register user
            const res = await fetch('/api/register', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    username: this.data.username,
                    password: this.data.password
                })
            });
            
            const result = await res.json();
            
            if (!result.success) {
                throw new Error(result.error || 'Ошибка регистрации');
            }
            
            // Show completion
            this.currentStep = 'complete';
            this.animateTransition(4, 'complete', 1);
            this.footer.classList.add('hidden');
            
            // Auto login after 1.5s
            setTimeout(async () => {
                const loginResult = await login(this.data.username, this.data.password);
                if (loginResult.success) {
                    // Upload avatar if selected
                    if (this.data.avatarFile && state.currentUser) {
                        try {
                            const formData = new FormData();
                            formData.append('avatar', this.data.avatarFile);
                            await api.uploadFile(`/api/user/${state.currentUser.id}/avatar`, formData);
                        } catch (e) {
                            console.log('Avatar upload failed:', e);
                        }
                    }
                }
            }, 1500);
            
        } catch (error) {
            console.error('Registration error:', error);
            document.getElementById('register-error').textContent = error.message;
            this.nextBtn.disabled = false;
            this.nextBtn.textContent = 'Создать аккаунт';
        }
    }
    
    reset() {
        this.currentStep = 1;
        this.data = {
            username: '',
            password: '',
            passwordConfirm: '',
            avatarFile: null,
            avatarPreview: null,
            agreeTerms: false,
            agreePrivacy: false
        };
        
        // Reset inputs
        if (this.usernameInput) this.usernameInput.value = '';
        if (this.passwordInput) this.passwordInput.value = '';
        if (this.passwordConfirmInput) this.passwordConfirmInput.value = '';
        if (this.avatarPreview) this.avatarPreview.innerHTML = '📷';
        if (this.agreeTermsCheckbox) this.agreeTermsCheckbox.checked = false;
        if (this.agreePrivacyCheckbox) this.agreePrivacyCheckbox.checked = false;
        
        // Reset panels
        this.panels.forEach(panel => {
            panel.classList.remove('active', 'exit-left', 'exit-right');
        });
        this.container.querySelector('.step-panel[data-step="1"]')?.classList.add('active');
        
        this.footer.classList.remove('hidden');
        this.updateUI();
    }
}

// Initialize stepper when DOM ready
let registrationStepper = null;
document.addEventListener('DOMContentLoaded', () => {
    registrationStepper = new RegistrationStepper();
    
    // Reset stepper when switching to register screen
    document.getElementById('to-register-btn')?.addEventListener('click', () => {
        registrationStepper?.reset();
    });
});

// === BACKGROUND CROPPER ===
let cropperState = {
    originalImage: null,
    imgWidth: 0,
    imgHeight: 0,
    selection: { x: 0, y: 0, width: 0, height: 0 },
    isDragging: false,
    isResizing: false,
    resizeHandle: null,
    dragStart: { x: 0, y: 0 },
    aspectRatio: 16 / 9,
    minWidth: 100,
    listenersAttached: false
};

function openBgCropper(imageDataUrl) {
    const modal = document.getElementById('bg-cropper-modal');
    const img = document.getElementById('cropper-image');
    
    cropperState.originalImage = imageDataUrl;
    img.src = imageDataUrl;
    
    // Показываем модал сразу, чтобы изображение могло отрендериться
    modal.classList.remove('hidden');
    
    // Ждём загрузки изображения
    const initCropper = () => {
        // Даём время на рендер (два кадра для надёжности)
        requestAnimationFrame(() => {
            requestAnimationFrame(() => {
                const rect = img.getBoundingClientRect();
                cropperState.imgWidth = rect.width;
                cropperState.imgHeight = rect.height;
                
                console.log('Cropper init - img size:', cropperState.imgWidth, 'x', cropperState.imgHeight);
                
                // Начальный размер с соотношением 16:9
                let selWidth, selHeight;
                const imgRatio = cropperState.imgWidth / cropperState.imgHeight;
                
                if (imgRatio > cropperState.aspectRatio) {
                    // Изображение шире чем 16:9 - ограничиваем по высоте
                    selHeight = cropperState.imgHeight * 0.8;
                    selWidth = selHeight * cropperState.aspectRatio;
                } else {
                    // Изображение уже чем 16:9 - ограничиваем по ширине
                    selWidth = cropperState.imgWidth * 0.8;
                    selHeight = selWidth / cropperState.aspectRatio;
                }
                
                // Центрируем выделение
                cropperState.selection = {
                    x: (cropperState.imgWidth - selWidth) / 2,
                    y: (cropperState.imgHeight - selHeight) / 2,
                    width: selWidth,
                    height: selHeight
                };
                
                console.log('Cropper selection:', cropperState.selection);
                
                updateCropperSelection();
                if (!cropperState.listenersAttached) {
                    initCropperDrag();
                    cropperState.listenersAttached = true;
                }
            });
        });
    };
    
    if (img.complete && img.naturalWidth > 0) {
        initCropper();
    } else {
        img.onload = initCropper;
    }
}

function updateCropperSelection() {
    const selection = document.getElementById('cropper-selection');
    const s = cropperState.selection;
    selection.style.left = s.x + 'px';
    selection.style.top = s.y + 'px';
    selection.style.width = s.width + 'px';
    selection.style.height = s.height + 'px';
}

function initCropperDrag() {
    const selection = document.getElementById('cropper-selection');
    const wrapper = document.getElementById('cropper-wrapper');
    const img = document.getElementById('cropper-image');
    
    const getRelativeCoords = (e) => {
        const rect = img.getBoundingClientRect();
        // Обновляем размеры изображения при каждом движении
        cropperState.imgWidth = rect.width;
        cropperState.imgHeight = rect.height;
        
        const clientX = e.touches ? e.touches[0].clientX : e.clientX;
        const clientY = e.touches ? e.touches[0].clientY : e.clientY;
        return {
            x: clientX - rect.left,
            y: clientY - rect.top
        };
    };
    
    // Drag для перемещения
    const onMouseDown = (e) => {
        if (e.target.classList.contains('cropper-handle')) return;
        e.preventDefault();
        cropperState.isDragging = true;
        const coords = getRelativeCoords(e);
        cropperState.dragStart = {
            x: coords.x - cropperState.selection.x,
            y: coords.y - cropperState.selection.y
        };
        console.log('Drag start - imgSize:', cropperState.imgWidth, 'x', cropperState.imgHeight);
    };
    
    // Resize для изменения размера
    const onHandleDown = (e) => {
        e.preventDefault();
        e.stopPropagation();
        cropperState.isResizing = true;
        cropperState.resizeHandle = e.target.dataset.handle;
        cropperState.dragStart = getRelativeCoords(e);
    };
    
    const onMouseMove = (e) => {
        if (!cropperState.isDragging && !cropperState.isResizing) return;
        e.preventDefault();
        
        const coords = getRelativeCoords(e);
        const s = cropperState.selection;
        const ratio = cropperState.aspectRatio;
        
        if (cropperState.isResizing) {
            const handle = cropperState.resizeHandle;
            let newX = s.x, newY = s.y, newW = s.width, newH = s.height;
            
            // Вычисляем новую ширину на основе перемещения
            if (handle === 'se') {
                newW = coords.x - s.x;
                newH = newW / ratio;
            } else if (handle === 'sw') {
                newW = s.x + s.width - coords.x;
                newH = newW / ratio;
                newX = coords.x;
            } else if (handle === 'ne') {
                newW = coords.x - s.x;
                newH = newW / ratio;
                newY = s.y + s.height - newH;
            } else if (handle === 'nw') {
                newW = s.x + s.width - coords.x;
                newH = newW / ratio;
                newX = coords.x;
                newY = s.y + s.height - newH;
            }
            
            // Минимальный размер
            if (newW < cropperState.minWidth) {
                newW = cropperState.minWidth;
                newH = newW / ratio;
                if (handle.includes('w')) newX = s.x + s.width - newW;
                if (handle.includes('n')) newY = s.y + s.height - newH;
            }
            
            // Ограничиваем границами изображения
            if (newX < 0) { newW += newX; newH = newW / ratio; newX = 0; }
            if (newY < 0) { newH += newY; newW = newH * ratio; newY = 0; }
            if (newX + newW > cropperState.imgWidth) { 
                newW = cropperState.imgWidth - newX; 
                newH = newW / ratio; 
            }
            if (newY + newH > cropperState.imgHeight) { 
                newH = cropperState.imgHeight - newY; 
                newW = newH * ratio; 
            }
            
            cropperState.selection = { x: newX, y: newY, width: newW, height: newH };
        } else {
            // Обычное перемещение
            let newX = coords.x - cropperState.dragStart.x;
            let newY = coords.y - cropperState.dragStart.y;
            
            // Ограничиваем перемещение границами изображения
            newX = Math.max(0, Math.min(newX, cropperState.imgWidth - s.width));
            newY = Math.max(0, Math.min(newY, cropperState.imgHeight - s.height));
            
            cropperState.selection.x = newX;
            cropperState.selection.y = newY;
        }
        
        updateCropperSelection();
    };
    
    const onMouseUp = () => {
        cropperState.isDragging = false;
        cropperState.isResizing = false;
        cropperState.resizeHandle = null;
    };
    
    selection.addEventListener('mousedown', onMouseDown);
    selection.addEventListener('touchstart', onMouseDown);
    
    // Обработчики для ручек ресайза
    document.querySelectorAll('.cropper-handle').forEach(handle => {
        handle.addEventListener('mousedown', onHandleDown);
        handle.addEventListener('touchstart', onHandleDown);
    });
    
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('touchmove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
    document.addEventListener('touchend', onMouseUp);
}

function applyCrop() {
    const img = document.getElementById('cropper-image');
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    
    // Вычисляем масштаб между отображаемым и реальным размером
    const scaleX = img.naturalWidth / cropperState.imgWidth;
    const scaleY = img.naturalHeight / cropperState.imgHeight;
    
    // Размеры обрезки в реальных пикселях
    const cropX = cropperState.selection.x * scaleX;
    const cropY = cropperState.selection.y * scaleY;
    const cropW = cropperState.selection.width * scaleX;
    const cropH = cropperState.selection.height * scaleY;
    
    console.log('applyCrop - selection:', cropperState.selection);
    console.log('applyCrop - crop area:', cropX, cropY, cropW, cropH);
    
    // Выходной размер - Full HD максимум для баланса качества и размера
    const maxDim = 1920;
    let outputW = cropW;
    let outputH = cropH;
    
    if (outputW > maxDim || outputH > maxDim) {
        const ratio = maxDim / Math.max(outputW, outputH);
        outputW = Math.round(outputW * ratio);
        outputH = Math.round(outputH * ratio);
    }
    
    canvas.width = outputW;
    canvas.height = outputH;
    
    // Рисуем с высоким качеством
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, cropX, cropY, cropW, cropH, 0, 0, outputW, outputH);
    
    // Качество 0.92 - хороший баланс
    const croppedImage = canvas.toDataURL('image/jpeg', 0.92);
    console.log('applyCrop - result size:', Math.round(croppedImage.length / 1024), 'KB');
    
    state.settings.background = 'custom';
    state.settings.customBg = croppedImage;
    
    try {
        saveSettings();
        applySettings();
        
        document.querySelectorAll('.bg-option').forEach(o => o.classList.remove('active'));
        document.querySelector('[data-bg="custom"]')?.classList.add('active');
        
        const bgModeSetting = document.getElementById('bg-mode-setting');
        if (bgModeSetting) bgModeSetting.style.display = 'flex';
        
        closeBgCropper();
        showToast('Фон установлен');
    } catch (e) {
        console.error('Save settings error:', e);
        showToast('Не удалось сохранить (очистите кэш браузера)', 'error');
    }
}

function closeBgCropper() {
    document.getElementById('bg-cropper-modal').classList.add('hidden');
    // Сбрасываем input чтобы можно было выбрать тот же файл снова
    const input = document.getElementById('custom-bg-input');
    if (input) input.value = '';
    // Сбрасываем состояние
    cropperState.isDragging = false;
    cropperState.isResizing = false;
}

// Инициализация кнопок кроппера
document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('cropper-apply')?.addEventListener('click', applyCrop);
    document.getElementById('cropper-cancel')?.addEventListener('click', closeBgCropper);
    document.getElementById('close-cropper')?.addEventListener('click', closeBgCropper);
    document.querySelector('#bg-cropper-modal .modal-overlay')?.addEventListener('click', closeBgCropper);
});


// === DOCK NAVIGATION (macOS-style) ===
class Dock {
    constructor(container, options = {}) {
        this.container = container;
        this.items = options.items || [];
        this.baseSize = options.baseSize || 40;
        this.magnification = options.magnification || 56;
        this.distance = options.distance || 100;
        this.onItemClick = options.onItemClick || (() => {});
        
        this.mouseX = Infinity;
        this.isHovered = false;
        this.activeIndex = 0;
        
        this.render();
        this.bindEvents();
    }
    
    render() {
        this.container.innerHTML = `
            <div class="dock-outer">
                <div class="dock-panel">
                    ${this.items.map((item, i) => `
                        <div class="dock-item ${i === this.activeIndex ? 'active' : ''}" 
                             data-index="${i}" 
                             tabindex="0"
                             role="button">
                            <div class="dock-icon">${item.icon}</div>
                            <div class="dock-label">${item.label}</div>
                        </div>
                    `).join('')}
                </div>
            </div>
        `;
        
        this.panel = this.container.querySelector('.dock-panel');
        this.dockItems = this.container.querySelectorAll('.dock-item');
    }
    
    bindEvents() {
        // Mouse move for magnification
        this.panel.addEventListener('mousemove', (e) => {
            this.isHovered = true;
            this.mouseX = e.pageX;
            this.updateMagnification();
        });
        
        this.panel.addEventListener('mouseleave', () => {
            this.isHovered = false;
            this.mouseX = Infinity;
            this.resetMagnification();
        });
        
        // Click handlers
        this.dockItems.forEach((item, index) => {
            item.addEventListener('click', () => {
                // Не делаем активной кнопку с action (например "+")
                if (!this.items[index].action) {
                    this.setActive(index);
                }
                this.onItemClick(this.items[index], index);
            });
            
            item.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    if (!this.items[index].action) {
                        this.setActive(index);
                    }
                    this.onItemClick(this.items[index], index);
                }
            });
        });
    }
    
    updateMagnification() {
        this.dockItems.forEach((item) => {
            const rect = item.getBoundingClientRect();
            const itemCenterX = rect.left + this.baseSize / 2;
            const dist = Math.abs(this.mouseX - itemCenterX);
            
            // Calculate scale based on distance
            let scale = 1;
            if (dist < this.distance) {
                const ratio = 1 - (dist / this.distance);
                const eased = Math.cos((1 - ratio) * Math.PI / 2);
                scale = 1 + ((this.magnification / this.baseSize) - 1) * eased;
            }
            
            item.style.transform = `scale(${scale})`;
        });
    }
    
    resetMagnification() {
        this.dockItems.forEach((item) => {
            item.style.transform = 'scale(1)';
        });
    }
    
    setActive(index) {
        this.activeIndex = index;
        this.dockItems.forEach((item, i) => {
            item.classList.toggle('active', i === index);
        });
    }
    
    getActiveIndex() {
        return this.activeIndex;
    }
}

// Make globally available
window.Dock = Dock;
