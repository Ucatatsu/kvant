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
    userLocalData: JSON.parse(localStorage.getItem('kvant_user_local_data') || '{}')
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
            
            // Обработка сообщений от Service Worker (для звонков из уведомлений)
            navigator.serviceWorker.addEventListener('message', (event) => {
                const data = event.data;
                
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
        } catch (e) {
            console.error('Ошибка регистрации SW:', e);
        }
    }
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
    });
    
    state.socket.on('connect_error', (error) => {
        console.error('Socket ошибка:', error.message);
        if (error.message.includes('авторизация') || error.message.includes('токен')) {
            logout();
        }
    });
    
    state.socket.on('online-users', (users) => {
        state.onlineUsers = users; // Теперь объект { odataId: status }
        updateContactsList();
        updateChatStatus();
    });
    
    state.socket.on('message-sent', (message) => {
        appendMessage(message);
        updateContactsList();
    });
    
    state.socket.on('new-message', (message) => {
        // Проверяем не отключены ли уведомления от этого пользователя
        const isMuted = isUserMuted(message.sender_id);
        
        // Воспроизводим звук если не muted
        if (!isMuted) {
            ensureSoundsInitialized();
            sounds.playMessage?.();
        }
        
        if (state.selectedUser && message.sender_id === state.selectedUser.id) {
            appendMessage(message);
            markAsRead();
        } else if (!isMuted) {
            // Показываем уведомление только если не muted
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
        currentCallId = data.callId;
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
    document.getElementById('login-screen').classList.add('hidden');
    document.getElementById('register-screen').classList.add('hidden');
    document.getElementById('chat-screen').classList.remove('hidden');
    
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
    requestNotificationPermission();
    applySettings();
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
}, 150);

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
        item.className = `user-item ${statusClass} ${state.selectedUser?.id === user.id ? 'active' : ''}`;
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
        const isPremium = user.isPremium || user.role === 'admin';
        const avatarClass = 'user-avatar';
        const nameStyle = user.name_color ? `style="--name-color: ${escapeAttr(user.name_color)}" data-name-color` : '';
        
        item.innerHTML = `
            <div class="${avatarClass}" style="${avatarStyle}">
                ${avatarContent}
                <div class="online-indicator ${userStatus || 'offline'}"></div>
            </div>
            <div class="user-info">
                <div class="user-name" ${nameStyle}>${escapeHtml(displayName)}${isPremium ? ' <span class="premium-indicator">👑</span>' : ''}${isMuted ? ' <span class="muted-indicator">🔕</span>' : ''}</div>
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
    });
}

function createMessageElement(msg, isSent) {
    const div = document.createElement('div');
    div.className = `message ${isSent ? 'sent' : 'received'}`;
    div.dataset.messageId = msg.id;
    div.dataset.senderId = msg.sender_id;
    
    const editedMark = msg.updated_at ? '<span class="message-edited">(ред.)</span>' : '';
    const reactionsHtml = renderReactions(msg.reactions || [], msg.id);
    
    // Определяем контент в зависимости от типа сообщения
    let bubbleContent;
    const isMedia = msg.message_type === 'image' || msg.message_type === 'gif';
    const isVideo = msg.message_type === 'video';
    
    if (isMedia) {
        bubbleContent = `<img src="${escapeAttr(msg.text)}" class="message-media" alt="Изображение" loading="lazy">`;
    } else if (isVideo) {
        bubbleContent = `<video src="${escapeAttr(msg.text)}" class="message-media" controls preload="metadata"></video>`;
    } else {
        bubbleContent = escapeHtml(msg.text);
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
    
    // Контекстное меню по правому клику
    div.addEventListener('contextmenu', (e) => showMessageContextMenu(e, msg, isSent));
    
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
        <div class="context-menu-item" data-action="react">😊 Реакция</div>
        <div class="context-menu-item" data-action="copy">📋 Копировать</div>
    `;
    
    if (isSent) {
        menuItems += `
            <div class="context-menu-divider"></div>
            <div class="context-menu-item" data-action="edit">✏️ Редактировать</div>
            <div class="context-menu-item danger" data-action="delete">🗑️ Удалить</div>
        `;
    }
    
    menu.innerHTML = menuItems;
    menu.style.left = `${e.clientX}px`;
    menu.style.top = `${e.clientY}px`;
    
    document.body.appendChild(menu);
    
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
                deleteMessagePrompt(msg);
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

async function deleteMessagePrompt(msg) {
    const confirmed = await customConfirm({
        title: 'Удалить сообщение?',
        message: 'Сообщение будет удалено у всех участников чата',
        icon: '🗑️',
        variant: 'danger',
        okText: 'Удалить'
    });
    
    if (confirmed) {
        state.socket.emit('delete-message', {
            messageId: msg.id,
            receiverId: state.selectedUser.id
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
    const icon = msg.message_type === 'video_call' ? '📹' : '📞';
    
    const div = document.createElement('div');
    div.className = `message ${isSent ? 'sent' : 'received'} call-message`;
    div.innerHTML = `
        <div class="message-content">
            <div class="message-bubble call-bubble">
                <span class="call-icon">${icon}</span>
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
    
    messagesDiv.appendChild(createMessageElement(msg, isSent));
    
    requestAnimationFrame(() => {
        messagesDiv.scrollTop = messagesDiv.scrollHeight;
    });
}

function sendMessage() {
    const input = document.getElementById('message-input');
    const text = input.value.trim();
    
    if (!text || !state.selectedUser || !state.socket) return;
    
    stopTyping();
    
    state.socket.emit('send-message', {
        receiverId: state.selectedUser.id,
        text
    });
    
    input.value = '';
}

// Прикрепление файла
async function handleAttachFile(e) {
    const file = e.target.files[0];
    if (!file || !state.selectedUser) return;
    
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
        formData.append('receiverId', state.selectedUser.id);
        
        const res = await api.uploadFile('/api/upload-message-file', formData);
        const result = await res.json();
        
        if (result.success) {
            // Отправляем сообщение с файлом
            state.socket.emit('send-message', {
                receiverId: state.selectedUser.id,
                text: result.fileUrl,
                messageType: result.fileType
            });
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

function formatTime(dateStr) {
    const date = new Date(dateStr);
    return date.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
}

// === УТИЛИТЫ ===

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
    }
}

// === НАСТРОЙКИ ===
function saveSettings() {
    localStorage.setItem('kvant_settings', JSON.stringify(state.settings));
}

function applySettings() {
    const chatScreen = document.getElementById('chat-screen');
    const messagesDiv = document.getElementById('messages');
    
    if (chatScreen) {
        chatScreen.classList.remove('bg-gradient1', 'bg-gradient2', 'bg-gradient3', 'bg-solid', 'bg-custom');
        chatScreen.style.backgroundImage = '';
        
        if (state.settings.background && state.settings.background !== 'default') {
            if (state.settings.background === 'custom' && state.settings.customBg) {
                chatScreen.classList.add('bg-custom');
                chatScreen.style.backgroundImage = `url(${state.settings.customBg})`;
            } else {
                chatScreen.classList.add(`bg-${state.settings.background}`);
            }
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
    }
    
    if (state.settings.theme) {
        applyTheme(state.settings.theme);
    }
}

function adjustColor(color, amount) {
    const hex = color.replace('#', '');
    const r = Math.max(0, Math.min(255, parseInt(hex.substr(0, 2), 16) + amount));
    const g = Math.max(0, Math.min(255, parseInt(hex.substr(2, 2), 16) + amount));
    const b = Math.max(0, Math.min(255, parseInt(hex.substr(4, 2), 16) + amount));
    return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
}

function applyTheme(theme) {
    const root = document.documentElement;
    
    if (theme === 'system') {
        theme = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
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
        root.style.setProperty('--bg-darkest', '#0a1628');
        root.style.setProperty('--bg-dark', '#0f2140');
        root.style.setProperty('--bg-medium', '#162d50');
        root.style.setProperty('--bg-light', '#1e3a5f');
        root.style.setProperty('--text', '#e2e8f0');
        root.style.setProperty('--text-muted', '#94a3b8');
        root.style.setProperty('--message-received', '#162d50');
        root.style.setProperty('--glass', 'rgba(15, 33, 64, 0.6)');
        root.style.setProperty('--glass-border', 'rgba(79, 195, 247, 0.15)');
    }
}


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

const iceServers = {
    iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        { urls: 'stun:stun2.l.google.com:19302' },
        { urls: 'stun:stun3.l.google.com:19302' },
        { urls: 'stun:stun4.l.google.com:19302' },
        // Бесплатные TURN серверы для NAT traversal
        {
            urls: 'turn:openrelay.metered.ca:80',
            username: 'openrelayproject',
            credential: 'openrelayproject'
        },
        {
            urls: 'turn:openrelay.metered.ca:443',
            username: 'openrelayproject',
            credential: 'openrelayproject'
        },
        {
            urls: 'turn:openrelay.metered.ca:443?transport=tcp',
            username: 'openrelayproject',
            credential: 'openrelayproject'
        }
    ],
    iceCandidatePoolSize: 10
};

function startCall(video = false) {
    if (!state.selectedUser || !state.socket) return;
    
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
    try {
        localStream = await navigator.mediaDevices.getUserMedia({
            audio: true,
            video: video
        });
        
        if (video) {
            document.getElementById('local-video').srcObject = localStream;
            document.getElementById('call-videos').classList.remove('hidden');
        }
        
        peerConnection = new RTCPeerConnection(iceServers);
        
        localStream.getTracks().forEach(track => {
            peerConnection.addTrack(track, localStream);
        });
        
        peerConnection.ontrack = (event) => {
            const remoteVideo = document.getElementById('remote-video');
            // Всегда обновляем srcObject при получении нового трека
            if (event.streams && event.streams[0]) {
                remoteVideo.srcObject = event.streams[0];
            } else {
                // Fallback: создаём новый MediaStream если streams пустой
                if (!remoteVideo.srcObject) {
                    remoteVideo.srcObject = new MediaStream();
                }
                remoteVideo.srcObject.addTrack(event.track);
            }
            
            // Показываем видео контейнер если есть видео трек
            if (event.track.kind === 'video') {
                document.getElementById('call-videos').classList.remove('hidden');
            }
            
            // Обработка завершения трека
            event.track.onended = () => {
                checkHideVideos();
            };
        };
        
        peerConnection.onicecandidate = (event) => {
            if (event.candidate && currentCallUser) {
                state.socket.emit('ice-candidate', {
                    to: currentCallUser.id,
                    candidate: event.candidate
                });
            }
        };
        
        // Обработка изменения состояния ICE соединения
        peerConnection.oniceconnectionstatechange = () => {
            console.log('ICE state:', peerConnection.iceConnectionState);
            const statusEl = document.getElementById('call-status');
            
            if (peerConnection.iceConnectionState === 'connected' || peerConnection.iceConnectionState === 'completed') {
                statusEl.textContent = 'Соединено';
                if (!callTimer) startCallTimer();
            } else if (peerConnection.iceConnectionState === 'failed') {
                statusEl.textContent = 'Ошибка соединения';
                peerConnection.restartIce();
            } else if (peerConnection.iceConnectionState === 'disconnected') {
                statusEl.textContent = 'Переподключение...';
            }
        };
        
        const offer = await peerConnection.createOffer();
        await peerConnection.setLocalDescription(offer);
        
        state.socket.emit('call-user', {
            to: state.selectedUser.id,
            offer: offer,
            isVideo: video
        });
        
        updateVideoButtonState();
    } catch (err) {
        console.error('Ошибка доступа к медиа:', err);
        endCall(false);
        alert('Не удалось получить доступ к камере/микрофону');
    }
}

let stopCallSound = null;

function handleIncomingCall(data) {
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
    if (!incomingCallData) return;
    
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
        localStream = await navigator.mediaDevices.getUserMedia({
            audio: true,
            video: isVideoCall
        });
        
        if (isVideoCall) {
            document.getElementById('local-video').srcObject = localStream;
            document.getElementById('call-videos').classList.remove('hidden');
        }
        
        peerConnection = new RTCPeerConnection(iceServers);
        
        localStream.getTracks().forEach(track => {
            peerConnection.addTrack(track, localStream);
        });
        
        peerConnection.ontrack = (event) => {
            const remoteVideo = document.getElementById('remote-video');
            // Всегда обновляем srcObject при получении нового трека
            if (event.streams && event.streams[0]) {
                remoteVideo.srcObject = event.streams[0];
            } else {
                // Fallback: создаём новый MediaStream если streams пустой
                if (!remoteVideo.srcObject) {
                    remoteVideo.srcObject = new MediaStream();
                }
                remoteVideo.srcObject.addTrack(event.track);
            }
            
            // Показываем видео контейнер если есть видео трек
            if (event.track.kind === 'video') {
                document.getElementById('call-videos').classList.remove('hidden');
            }
            
            // Обработка завершения трека
            event.track.onended = () => {
                checkHideVideos();
            };
        };
        
        peerConnection.onicecandidate = (event) => {
            if (event.candidate && currentCallUser) {
                state.socket.emit('ice-candidate', {
                    to: currentCallUser.id,
                    candidate: event.candidate
                });
            }
        };
        
        // Обработка изменения состояния ICE соединения
        peerConnection.oniceconnectionstatechange = () => {
            console.log('ICE state:', peerConnection.iceConnectionState);
            const statusEl = document.getElementById('call-status');
            
            if (peerConnection.iceConnectionState === 'connected' || peerConnection.iceConnectionState === 'completed') {
                statusEl.textContent = 'Соединено';
                if (!callTimer) startCallTimer();
            } else if (peerConnection.iceConnectionState === 'failed') {
                statusEl.textContent = 'Ошибка соединения';
                peerConnection.restartIce();
            } else if (peerConnection.iceConnectionState === 'disconnected') {
                statusEl.textContent = 'Переподключение...';
            }
        };
        
        await peerConnection.setRemoteDescription(incomingCallData.offer);
        const answer = await peerConnection.createAnswer();
        await peerConnection.setLocalDescription(answer);
        
        state.socket.emit('call-answer', {
            to: incomingCallData.from,
            answer: answer,
            callId: currentCallId
        });
        
        updateVideoButtonState();
    } catch (err) {
        console.error('Ошибка:', err);
        endCall(false);
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
    currentCallId = data.callId;
    if (peerConnection) {
        try {
            const answer = new RTCSessionDescription(data.answer);
            await peerConnection.setRemoteDescription(answer);
            // Статус обновится через oniceconnectionstatechange когда соединение установится
            document.getElementById('call-status').textContent = 'Подключение...';
        } catch (e) {
            console.error('Error setting remote description:', e);
        }
    }
}

function handleCallDeclined() {
    document.getElementById('call-status').textContent = 'Звонок отклонён';
    setTimeout(() => endCall(false), 2000);
}

function handleCallEnded() {
    cleanupCall();
    document.getElementById('call-modal').classList.add('hidden');
    hideCallBar();
}

function handleCallFailed(data) {
    document.getElementById('call-status').textContent = data.reason;
    setTimeout(() => endCall(false), 2000);
}

async function handleIceCandidate(data) {
    if (peerConnection && data.candidate) {
        try {
            const candidate = new RTCIceCandidate(data.candidate);
            await peerConnection.addIceCandidate(candidate);
        } catch (e) {
            // Игнорируем ошибки если remote description ещё не установлен
            if (e.name !== 'InvalidStateError') {
                console.error('ICE candidate error:', e);
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
    checkHideVideos();
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

function toggleMute() {
    if (localStream) {
        isMuted = !isMuted;
        localStream.getAudioTracks().forEach(track => track.enabled = !isMuted);
        const muteBtn = document.getElementById('mute-btn');
        muteBtn.classList.toggle('active', !isMuted);
        muteBtn.textContent = isMuted ? '🔇' : '🎤';
    }
}

async function toggleVideo() {
    if (!localStream || !peerConnection || !currentCallUser) return;
    
    const videoTrack = localStream.getVideoTracks()[0];
    
    if (videoTrack) {
        // Переключаем существующий видео трек
        videoTrack.enabled = !videoTrack.enabled;
        
        // Находим sender и обновляем трек
        const sender = peerConnection.getSenders().find(s => s.track?.kind === 'video');
        if (sender) {
            // Заменяем трек на null или обратно для синхронизации с собеседником
            await sender.replaceTrack(videoTrack.enabled ? videoTrack : null);
        }
        
        if (videoTrack.enabled) {
            document.getElementById('call-videos').classList.remove('hidden');
            document.getElementById('local-video').srcObject = localStream;
        } else {
            checkHideVideos();
        }
    } else {
        // Добавляем новый видео трек
        try {
            const newStream = await navigator.mediaDevices.getUserMedia({ video: true });
            const newVideoTrack = newStream.getVideoTracks()[0];
            
            localStream.addTrack(newVideoTrack);
            document.getElementById('local-video').srcObject = localStream;
            document.getElementById('call-videos').classList.remove('hidden');
            
            // Проверяем есть ли уже video sender
            const existingSender = peerConnection.getSenders().find(s => s.track === null || s.track?.kind === 'video');
            if (existingSender) {
                await existingSender.replaceTrack(newVideoTrack);
            } else {
                peerConnection.addTrack(newVideoTrack, localStream);
                
                // Нужен renegotiation только если добавили новый трек
                const offer = await peerConnection.createOffer();
                await peerConnection.setLocalDescription(offer);
                
                state.socket.emit('video-renegotiate', {
                    to: currentCallUser.id,
                    offer: offer
                });
            }
        } catch (e) {
            console.error('Не удалось включить видео:', e);
            alert('Не удалось получить доступ к камере');
            return;
        }
    }
    
    updateVideoButtonState();
}

function updateVideoButtonState() {
    const videoTrack = localStream?.getVideoTracks()[0];
    const toggleVideoBtn = document.getElementById('toggle-video-btn');
    if (toggleVideoBtn) {
        const hasVideo = videoTrack?.enabled;
        toggleVideoBtn.classList.toggle('active', hasVideo);
        toggleVideoBtn.textContent = hasVideo ? '📹' : '📷';
    }
}

function checkHideVideos() {
    const localHasVideo = localStream?.getVideoTracks().some(t => t.enabled);
    const remoteVideo = document.getElementById('remote-video');
    const remoteHasVideo = remoteVideo?.srcObject?.getVideoTracks().some(t => t.enabled);
    
    if (!localHasVideo && !remoteHasVideo && !isScreenSharing) {
        document.getElementById('call-videos').classList.add('hidden');
    }
}

async function toggleScreenShare() {
    if (!peerConnection || !currentCallUser) return;
    
    const screenShareBtn = document.getElementById('screen-share-btn');
    
    if (isScreenSharing) {
        await stopScreenShare();
    } else {
        try {
            screenStream = await navigator.mediaDevices.getDisplayMedia({
                video: {
                    cursor: 'always',
                    displaySurface: 'monitor'
                },
                audio: true
            });
            
            const screenTrack = screenStream.getVideoTracks()[0];
            
            // Находим видео sender и заменяем трек
            const sender = peerConnection.getSenders().find(s => s.track?.kind === 'video');
            if (sender) {
                await sender.replaceTrack(screenTrack);
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

async function stopScreenShare() {
    if (!isScreenSharing || !peerConnection) return;
    
    if (screenStream) {
        screenStream.getTracks().forEach(track => track.stop());
        screenStream = null;
    }
    
    const videoTrack = localStream?.getVideoTracks()[0];
    const sender = peerConnection.getSenders().find(s => s.track?.kind === 'video');
    
    if (videoTrack && videoTrack.enabled && sender) {
        // Возвращаем камеру
        await sender.replaceTrack(videoTrack);
        document.getElementById('local-video').srcObject = localStream;
    } else if (sender) {
        // Если камеры нет, отправляем null трек
        await sender.replaceTrack(null);
        checkHideVideos();
    } else {
        checkHideVideos();
    }
    
    // Уведомляем собеседника об окончании демонстрации
    if (currentCallUser && state.socket) {
        state.socket.emit('screen-share-stopped', { to: currentCallUser.id });
    }
    
    isScreenSharing = false;
    document.getElementById('screen-share-btn')?.classList.remove('active');
}

function appendCallMessage(msg) {
    const messagesDiv = document.getElementById('messages');
    const isSent = msg.sender_id === state.currentUser.id;
    const duration = msg.call_duration || 0;
    const mins = Math.floor(duration / 60);
    const secs = duration % 60;
    const durationText = duration > 0 ? `${mins}:${secs.toString().padStart(2, '0')}` : '';
    const icon = msg.message_type === 'video_call' ? '📹' : '📞';
    
    const div = document.createElement('div');
    div.className = `message ${isSent ? 'sent' : 'received'} call-message`;
    div.innerHTML = `
        <div class="message-content">
            <div class="message-bubble call-bubble">
                <span class="call-icon">${icon}</span>
                <span class="call-text">${escapeHtml(msg.text)}</span>
                ${durationText ? `<span class="call-duration">${durationText}</span>` : ''}
            </div>
            <div class="message-time">${formatTime(msg.created_at)}</div>
        </div>
    `;
    messagesDiv.appendChild(div);
    messagesDiv.scrollTop = messagesDiv.scrollHeight;
}

// Call bar
function showCallBar() {
    if (currentCallUser) {
        document.getElementById('call-bar-name').textContent = currentCallUser.username;
        document.getElementById('active-call-bar').classList.remove('hidden');
    }
}

function hideCallBar() {
    document.getElementById('active-call-bar').classList.add('hidden');
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
        if (!state.selectedUser) {
            showToast('Сначала выберите чат', 'error');
            return;
        }
        document.getElementById('attach-input')?.click();
    });
    
    document.getElementById('attach-input')?.addEventListener('change', handleAttachFile);
    
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
    
    // Профиль собеседника (клик на аватар/имя)
    document.querySelector('.chat-header-info')?.addEventListener('click', (e) => {
        e.stopPropagation();
        if (state.selectedUser) {
            showUserProfile(state.selectedUser.id);
        }
    });
    
    document.querySelector('.chat-header-avatar')?.addEventListener('click', (e) => {
        e.stopPropagation();
        if (state.selectedUser) {
            showUserProfile(state.selectedUser.id);
        }
    });
    
    // Контекстное меню чата (3 точки)
    const chatMenuBtn = document.getElementById('chat-menu-btn');
    const chatContextMenu = document.getElementById('chat-context-menu');
    
    chatMenuBtn?.addEventListener('click', (e) => {
        e.stopPropagation();
        if (!state.selectedUser) return;
        
        // Обновляем состояние уведомлений
        const isMuted = isUserMuted(state.selectedUser.id);
        document.getElementById('ctx-notif-icon').textContent = isMuted ? '🔕' : '🔔';
        document.getElementById('ctx-notif-text').textContent = isMuted ? 'Включить уведомления' : 'Отключить уведомления';
        
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
    
    document.getElementById('close-user-profile')?.addEventListener('click', () => {
        document.getElementById('user-profile-modal').classList.add('hidden');
    });
    
    // === НАСТРОЙКИ ===
    
    document.getElementById('settings-btn')?.addEventListener('click', showSettings);
    document.getElementById('close-settings')?.addEventListener('click', () => {
        document.getElementById('settings-modal').classList.add('hidden');
    });
    
    document.getElementById('logout-btn')?.addEventListener('click', async () => {
        const confirmed = await customConfirm({
            title: 'Выход из аккаунта',
            message: 'Вы уверены, что хотите выйти?',
            icon: '🚪',
            variant: 'warning',
            okText: 'Выйти',
            cancelText: 'Остаться'
        });
        if (confirmed) logout();
    });
    
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
    
    document.getElementById('custom-bg-input')?.addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (file) {
            const reader = new FileReader();
            reader.onload = (e) => {
                state.settings.background = 'custom';
                state.settings.customBg = e.target.result;
                saveSettings();
                applySettings();
                document.querySelectorAll('.bg-option').forEach(o => o.classList.remove('active'));
                document.querySelector('[data-bg="custom"]')?.classList.add('active');
            };
            reader.readAsDataURL(file);
        }
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
        if (!state.selectedUser) {
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
    });
    
    window.addEventListener('resize', () => {
        if (!isMobile()) {
            document.querySelector('.sidebar')?.classList.remove('hidden-mobile');
        }
    });
    
    // === ЗВОНКИ ===
    
    document.querySelectorAll('.action-btn').forEach((btn, index) => {
        btn.addEventListener('click', () => {
            if (state.selectedUser) {
                startCall(index === 1);
            }
        });
    });
    
    document.getElementById('mute-btn')?.addEventListener('click', toggleMute);
    document.getElementById('toggle-video-btn')?.addEventListener('click', toggleVideo);
    document.getElementById('screen-share-btn')?.addEventListener('click', toggleScreenShare);
    document.getElementById('end-call-btn')?.addEventListener('click', () => endCall(true));
    
    document.getElementById('accept-call-btn')?.addEventListener('click', acceptCall);
    document.getElementById('decline-call-btn')?.addEventListener('click', declineCall);
    
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
            badges += '<span class="profile-badge premium">Premium</span>';
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
                badges += '<span class="profile-badge premium">Premium</span>';
            }
            badgesEl.innerHTML = badges;
        }
        
        document.getElementById('user-profile-bio').textContent = profile.bio || '';
        
        document.getElementById('user-profile-modal').classList.remove('hidden');
    } catch (e) {
        console.error('Error loading user profile:', e);
    }
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
    document.getElementById('notifications-checkbox').checked = state.notificationsEnabled;
    document.getElementById('sounds-checkbox').checked = state.settings.sounds !== false;
    document.getElementById('setting-compact').checked = state.settings.compact || false;
    document.getElementById('setting-avatars').checked = !state.settings.hideAvatars;
    
    // Premium: скрытый онлайн
    const hideOnlineCheckbox = document.getElementById('setting-hide-online');
    if (hideOnlineCheckbox) {
        hideOnlineCheckbox.checked = state.currentUserProfile?.hide_online || false;
        // Блокируем если не премиум
        const isPremium = state.currentUserProfile?.isPremium || state.currentUser?.role === 'admin';
        const hideOnlineSetting = document.getElementById('hide-online-setting');
        if (hideOnlineSetting) {
            hideOnlineSetting.classList.toggle('locked', !isPremium);
        }
    }
    
    // Блокируем премиум-темы для не-премиум пользователей
    const isPremium = state.currentUserProfile?.isPremium || state.currentUser?.role === 'admin';
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
        const data = await res.json();
        
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
    
    container.innerHTML = users.map(user => `
        <div class="admin-user" data-user-id="${user.id}" data-user-role="${user.role}">
            <div class="admin-user-avatar" style="${user.avatar_url ? `background-image: url(${user.avatar_url})` : ''}">
                ${user.avatar_url ? '' : user.username[0].toUpperCase()}
            </div>
            <div class="admin-user-info">
                <div class="admin-user-name">
                    ${user.display_name || user.username}
                    <span class="profile-badges">
                        ${user.role === 'admin' ? '<span class="profile-badge admin">Админ</span>' : ''}
                        ${user.isPremium ? '<span class="profile-badge premium">Premium</span>' : ''}
                    </span>
                </div>
                <div class="admin-user-tag">${user.username}#${user.custom_id || user.tag || '????'}</div>
            </div>
            <div class="admin-user-actions">
                ${user.id !== state.currentUser.id ? `
                    <button class="admin-btn admin-btn-admin ${user.role === 'admin' ? 'active' : ''}" data-action="toggle-admin">
                        ${user.role === 'admin' ? 'Снять админа' : 'Админ'}
                    </button>
                ` : ''}
                <button class="admin-btn admin-btn-premium" data-action="give-premium">
                    +Premium
                </button>
                ${user.id !== state.currentUser.id ? `
                    <button class="admin-btn admin-btn-delete" data-action="delete-user">
                        Удалить
                    </button>
                ` : ''}
            </div>
        </div>
    `).join('');
    
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
    const action = btn.dataset.action;
    
    if (action === 'toggle-admin') {
        await toggleAdmin(userId, userRole);
    } else if (action === 'give-premium') {
        await givePremium(userId);
    } else if (action === 'delete-user') {
        await deleteUserAdmin(userId);
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

async function givePremium(userId) {
    const days = await customPrompt({
        title: 'Выдать Premium',
        message: 'Введите количество дней:',
        icon: '👑',
        variant: 'premium',
        placeholder: 'Дней',
        defaultValue: '30',
        okText: 'Выдать',
        cancelText: 'Отмена'
    });
    if (!days || isNaN(days)) return;
    
    try {
        const res = await api.post(`/api/admin/user/${userId}/premium`, { days: parseInt(days) });
        const data = await res.json();
        
        if (data.success) {
            showToast(`Premium выдан на ${days} дней`);
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
    btn.textContent = state.micMuted ? '🔇' : '🎤';
}

function togglePanelCam() {
    state.camMuted = !state.camMuted;
    const btn = document.getElementById('panel-cam-btn');
    btn.classList.toggle('muted', state.camMuted);
    btn.textContent = state.camMuted ? '📷' : '📹';
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
    
    // Обработчики для кнопок в хедере
    document.querySelectorAll('.header-action-btn').forEach((btn, index) => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            if (!state.selectedUser) return;
            
            if (index === 0) {
                startCall(false); // Аудио
            } else if (index === 1) {
                startCall(true); // Видео
            } else if (index === 2) {
                // Меню - можно добавить dropdown
                showUserProfile(state.selectedUser.id);
            }
        });
    });
});


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
        
        const { users, messages } = await res.json();
        
        if (users.length === 0 && messages.length === 0) {
            renderSearchNotFound();
            return;
        }
        
        let html = '';
        
        // Пользователи
        if (users.length > 0) {
            html += `<div class="search-section">
                <div class="search-section-title">Пользователи</div>`;
            
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
        
        // Сообщения
        if (messages.length > 0) {
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
            item.addEventListener('click', () => {
                const type = item.dataset.type;
                
                if (type === 'user') {
                    selectUser(item.dataset.id, item.dataset.name);
                } else if (type === 'message') {
                    // Открываем чат с этим пользователем
                    selectUser(item.dataset.chatId, item.dataset.sender);
                }
                
                closeSearchModal();
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
    if (savedWidth) {
        chatScreen.style.setProperty('--sidebar-width', savedWidth + 'px');
        updatePanelButtons(parseInt(savedWidth));
    }
    
    function updatePanelButtons(width) {
        if (panelActions) {
            panelActions.style.display = width < 250 ? 'none' : 'flex';
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
    
    // Громкость
    const volumeSlider = document.getElementById('volume-slider');
    const volumeValue = document.getElementById('volume-value');
    if (volumeSlider) {
        volumeSlider.value = state.settings.volume ?? 50;
        volumeValue.textContent = `${volumeSlider.value}%`;
        
        volumeSlider.addEventListener('input', (e) => {
            const vol = parseInt(e.target.value);
            state.settings.volume = vol;
            volumeValue.textContent = `${vol}%`;
            saveSettings();
        });
    }
    
    // Компактный режим
    document.getElementById('setting-compact')?.addEventListener('change', (e) => {
        state.settings.compact = e.target.checked;
        saveSettings();
        applySettings();
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
        });
    });
    
    // Кастомный фон
    document.getElementById('custom-bg-input')?.addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (file) {
            const reader = new FileReader();
            reader.onload = (ev) => {
                state.settings.background = 'custom';
                state.settings.customBg = ev.target.result;
                saveSettings();
                applySettings();
                document.querySelectorAll('.bg-option').forEach(o => o.classList.remove('active'));
                document.querySelector('[data-bg="custom"]')?.classList.add('active');
            };
            reader.readAsDataURL(file);
        }
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
            showToast('Цвет изменён');
        });
    });
    
    // Тема (с проверкой премиум)
    document.querySelectorAll('.theme-option').forEach(opt => {
        opt.addEventListener('click', () => {
            // Проверка премиум-тем
            const premiumThemes = ['neon', 'sunset', 'ocean'];
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
}

function applySettings() {
    const chatScreen = document.getElementById('chat-screen');
    const messagesDiv = document.getElementById('messages');
    
    if (chatScreen) {
        chatScreen.classList.remove('bg-gradient1', 'bg-gradient2', 'bg-gradient3', 'bg-solid', 'bg-custom');
        chatScreen.style.backgroundImage = '';
        
        if (state.settings.background && state.settings.background !== 'default') {
            if (state.settings.background === 'custom' && state.settings.customBg) {
                chatScreen.classList.add('bg-custom');
                chatScreen.style.backgroundImage = `url(${state.settings.customBg})`;
            } else {
                chatScreen.classList.add(`bg-${state.settings.background}`);
            }
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
    }
    
    if (state.settings.theme) {
        applyTheme(state.settings.theme);
    }
}

function adjustColor(color, amount) {
    const hex = color.replace('#', '');
    const r = Math.max(0, Math.min(255, parseInt(hex.substr(0, 2), 16) + amount));
    const g = Math.max(0, Math.min(255, parseInt(hex.substr(2, 2), 16) + amount));
    const b = Math.max(0, Math.min(255, parseInt(hex.substr(4, 2), 16) + amount));
    return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
}

function applyTheme(theme) {
    const root = document.documentElement;
    
    // Убираем data-theme атрибут
    root.removeAttribute('data-theme');
    
    if (theme === 'system') {
        theme = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    }
    
    // Premium темы
    if (['neon', 'sunset', 'ocean'].includes(theme)) {
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
        root.style.setProperty('--bg-darkest', '#0a1628');
        root.style.setProperty('--bg-dark', '#0f2140');
        root.style.setProperty('--bg-medium', '#162d50');
        root.style.setProperty('--bg-light', '#1e3a5f');
        root.style.setProperty('--text', '#e2e8f0');
        root.style.setProperty('--text-muted', '#94a3b8');
        root.style.setProperty('--message-received', '#162d50');
        root.style.setProperty('--glass', 'rgba(15, 33, 64, 0.6)');
        root.style.setProperty('--glass-border', 'rgba(79, 195, 247, 0.15)');
    }
}

// Системная тема
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (state.settings.theme === 'system') {
        applyTheme('system');
    }
});
