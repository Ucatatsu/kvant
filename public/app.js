const socket = io();

let currentUser = null;
let selectedUser = null;
let onlineUsers = [];
let notificationsEnabled = localStorage.getItem('notifications') !== 'false';

// Запрос разрешения на уведомления
async function requestNotificationPermission() {
  if ('Notification' in window && Notification.permission === 'default') {
    await Notification.requestPermission();
  }
}

function showNotification(title, body, onClick) {
  if (!notificationsEnabled) return;
  if ('Notification' in window && Notification.permission === 'granted') {
    const notification = new Notification(title, {
      body: body,
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

// Проверяем сохранённую сессию при загрузке
const savedUser = localStorage.getItem('kvant_user');
if (savedUser) {
  try {
    currentUser = JSON.parse(savedUser);
    // Отложенный запуск после загрузки DOM
    document.addEventListener('DOMContentLoaded', () => {
      showChat();
    });
  } catch (e) {
    localStorage.removeItem('kvant_user');
  }
}

// DOM элементы - Auth
const loginScreen = document.getElementById('login-screen');
const registerScreen = document.getElementById('register-screen');
const chatScreen = document.getElementById('chat-screen');

const loginForm = document.getElementById('login-form');
const loginUsername = document.getElementById('login-username');
const loginPassword = document.getElementById('login-password');
const loginError = document.getElementById('login-error');
const toRegisterBtn = document.getElementById('to-register-btn');

const registerForm = document.getElementById('register-form');
const regUsername = document.getElementById('reg-username');
const regPassword = document.getElementById('reg-password');
const regPasswordConfirm = document.getElementById('reg-password-confirm');
const registerError = document.getElementById('register-error');
const toLoginBtn = document.getElementById('to-login-btn');

// DOM элементы - Chat
const logoutBtn = document.getElementById('logout-btn');
const usersList = document.getElementById('users-list');
const chatHeader = document.getElementById('chat-header');
const messagesDiv = document.getElementById('messages');
const messageForm = document.getElementById('message-form');
const messageInput = document.getElementById('message-input');
const sendBtn = document.querySelector('.send-btn');

// Переключение форм
toRegisterBtn.addEventListener('click', () => {
  loginScreen.classList.add('hidden');
  registerScreen.classList.remove('hidden');
  loginError.textContent = '';
});

toLoginBtn.addEventListener('click', () => {
  registerScreen.classList.add('hidden');
  loginScreen.classList.remove('hidden');
  registerError.textContent = '';
});

// Вход
loginForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  loginError.textContent = '';
  
  const res = await fetch('/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username: loginUsername.value,
      password: loginPassword.value
    })
  });
  const data = await res.json();
  
  if (data.success) {
    currentUser = data.user;
    localStorage.setItem('kvant_user', JSON.stringify(currentUser));
    showChat();
  } else {
    loginError.textContent = data.error;
  }
});

// Регистрация
registerForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  registerError.textContent = '';
  registerError.className = 'error';
  
  if (regPassword.value !== regPasswordConfirm.value) {
    registerError.textContent = 'Пароли не совпадают';
    return;
  }
  
  if (regPassword.value.length < 4) {
    registerError.textContent = 'Пароль минимум 4 символа';
    return;
  }
  
  const res = await fetch('/api/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username: regUsername.value,
      password: regPassword.value
    })
  });
  const data = await res.json();
  
  if (data.success) {
    registerError.className = 'success';
    registerError.textContent = 'Успешно! Переход...';
    setTimeout(() => {
      registerScreen.classList.add('hidden');
      loginScreen.classList.remove('hidden');
      loginUsername.value = regUsername.value;
      registerError.textContent = '';
    }, 1000);
  } else {
    registerError.textContent = data.error;
  }
});


// Показать чат
function showChat() {
  loginScreen.classList.add('hidden');
  registerScreen.classList.add('hidden');
  chatScreen.classList.remove('hidden');
  
  const initial = currentUser.username[0].toUpperCase();
  document.getElementById('current-user-avatar').textContent = initial;
  document.querySelector('.current-user').textContent = currentUser.username;
  
  socket.emit('user-online', currentUser.id);
  // Загружаем контакты (с кем есть переписка)
  loadContacts();
  // Запрашиваем разрешение на уведомления
  requestNotificationPermission();
}

// Выход (перенесён в настройки)

// Загрузка контактов (с кем есть переписка)
async function loadContacts() {
  const res = await fetch(`/api/contacts/${currentUser.id}`);
  const contacts = await res.json();
  if (contacts.length === 0) {
    usersList.innerHTML = '<div class="empty-list">Нет контактов<br>Найдите пользователя через поиск</div>';
  } else {
    renderUsers(contacts);
  }
}

// Поиск пользователей
async function searchUsers(query) {
  if (!query) {
    loadContacts();
    return;
  }
  const res = await fetch(`/api/users?search=${encodeURIComponent(query)}`);
  const users = await res.json();
  const filtered = users.filter(u => u.id !== currentUser.id);
  if (filtered.length === 0) {
    usersList.innerHTML = '<div class="empty-list">Пользователи не найдены</div>';
  } else {
    renderUsers(filtered);
  }
}

const searchInput = document.querySelector('.search-input');
let searchTimeout;

searchInput.addEventListener('input', (e) => {
  clearTimeout(searchTimeout);
  searchTimeout = setTimeout(() => {
    searchUsers(e.target.value.trim());
  }, 300);
});

function renderUsers(users) {
  usersList.innerHTML = users.map(user => {
    const isOnline = onlineUsers.includes(user.id);
    const unread = user.unread_count || 0;
    return `
      <div class="user-item ${isOnline ? '' : 'offline'} ${selectedUser?.id === user.id ? 'active' : ''}" 
           data-id="${user.id}" data-name="${user.username}">
        <div class="user-avatar" style="background: ${user.avatar_color || '#4fc3f7'}">
          ${user.username[0].toUpperCase()}
          <div class="online-indicator"></div>
        </div>
        <div class="user-info">
          <div class="user-name">${user.display_name || user.username}</div>
          <div class="user-last-message">${isOnline ? 'В сети' : 'Не в сети'}</div>
        </div>
        ${unread > 0 ? `<div class="unread-badge">${unread}</div>` : ''}
      </div>
    `;
  }).join('');

  document.querySelectorAll('.user-item').forEach(item => {
    item.addEventListener('click', () => selectUser(item.dataset.id, item.dataset.name));
  });
}

async function selectUser(userId, username) {
  selectedUser = { id: userId, username };
  
  document.querySelectorAll('.user-item').forEach(i => i.classList.remove('active'));
  document.querySelector(`[data-id="${userId}"]`)?.classList.add('active');
  
  // Убираем badge непрочитанных сообщений при открытии чата
  const userItem = document.querySelector(`[data-id="${userId}"]`);
  const badge = userItem?.querySelector('.unread-badge');
  if (badge) badge.remove();
  
  const isOnline = onlineUsers.includes(userId);
  document.querySelector('.chat-user-name').textContent = username;
  document.querySelector('.chat-user-status').textContent = isOnline ? 'В сети' : 'Не в сети';
  document.querySelector('.chat-user-status').style.color = isOnline ? 'var(--online)' : 'var(--text-muted)';
  
  messageInput.disabled = false;
  sendBtn.disabled = false;
  
  await loadMessages();
}

async function loadMessages() {
  const res = await fetch(`/api/messages/${selectedUser.id}?userId=${currentUser.id}`);
  const messages = await res.json();
  renderMessages(messages);
}

function renderMessages(messages) {
  messagesDiv.innerHTML = messages.map(msg => {
    const isSent = msg.sender_id === currentUser.id;
    const initial = isSent ? currentUser.username[0] : selectedUser.username[0];
    
    // Проверяем тип сообщения
    if (msg.message_type === 'audio_call' || msg.message_type === 'video_call') {
      const duration = msg.call_duration || 0;
      const mins = Math.floor(duration / 60);
      const secs = duration % 60;
      const durationText = duration > 0 ? `${mins}:${secs.toString().padStart(2, '0')}` : '';
      const icon = msg.message_type === 'video_call' ? '📹' : '📞';
      
      return `
        <div class="message ${isSent ? 'sent' : 'received'} call-message">
          <div class="message-content">
            <div class="message-bubble call-bubble">
              <span class="call-icon">${icon}</span>
              <span class="call-text">${msg.text}</span>
              ${durationText ? `<span class="call-duration">${durationText}</span>` : ''}
            </div>
            <div class="message-time">${formatTime(msg.created_at)}</div>
          </div>
        </div>
      `;
    }
    
    return `
      <div class="message ${isSent ? 'sent' : 'received'}">
        <div class="message-avatar">${initial.toUpperCase()}</div>
        <div class="message-content">
          <div class="message-bubble">${escapeHtml(msg.text)}</div>
          <div class="message-time">${formatTime(msg.created_at)}</div>
        </div>
      </div>
    `;
  }).join('');
  messagesDiv.scrollTop = messagesDiv.scrollHeight;
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function formatTime(dateStr) {
  const date = new Date(dateStr);
  return date.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
}

// Отправка сообщений
messageForm.addEventListener('submit', (e) => {
  e.preventDefault();
  if (!messageInput.value.trim() || !selectedUser) return;
  
  socket.emit('send-message', {
    senderId: currentUser.id,
    receiverId: selectedUser.id,
    text: messageInput.value.trim()
  });
  messageInput.value = '';
});

// Socket события
socket.on('online-users', (users) => {
  onlineUsers = users;
  // Обновляем список
  const query = searchInput.value.trim();
  if (query) {
    searchUsers(query);
  } else {
    loadContacts();
  }
  
  // Обновить статус в хедере если выбран чат
  if (selectedUser) {
    const isOnline = onlineUsers.includes(selectedUser.id);
    document.querySelector('.chat-user-status').textContent = isOnline ? 'В сети' : 'Не в сети';
    document.querySelector('.chat-user-status').style.color = isOnline ? 'var(--online)' : 'var(--text-muted)';
  }
});

socket.on('message-sent', (message) => {
  appendMessage(message);
  // Обновить контакты после отправки сообщения
  if (!searchInput.value.trim()) {
    loadContacts();
  }
});

socket.on('new-message', (message) => {
  if (selectedUser && message.sender_id === selectedUser.id) {
    appendMessage(message);
    // Помечаем как прочитанное если чат открыт
    fetch(`/api/messages/${selectedUser.id}?userId=${currentUser.id}`);
  } else {
    // Показываем уведомление если чат не открыт
    showNotification('Новое сообщение', message.text, () => {
      // При клике на уведомление открываем чат
    });
  }
  // Обновить контакты при получении сообщения
  if (!searchInput.value.trim()) {
    loadContacts();
  }
});

function appendMessage(msg) {
  const isSent = msg.sender_id === currentUser.id;
  const initial = isSent ? currentUser.username[0] : selectedUser.username[0];
  
  const div = document.createElement('div');
  div.className = `message ${isSent ? 'sent' : 'received'}`;
  div.innerHTML = `
    <div class="message-avatar">${initial.toUpperCase()}</div>
    <div class="message-content">
      <div class="message-bubble">${escapeHtml(msg.text)}</div>
      <div class="message-time">${formatTime(msg.created_at)}</div>
    </div>
  `;
  messagesDiv.appendChild(div);
  messagesDiv.scrollTop = messagesDiv.scrollHeight;
}


// ===== PROFILE MODAL =====
const profileModal = document.getElementById('profile-modal');
const closeProfileBtn = document.getElementById('close-profile');
const currentUserAvatarBtn = document.getElementById('current-user-avatar');
const editProfileBtn = document.getElementById('edit-profile-btn');
const editProfileModal = document.getElementById('edit-profile-modal');
const closeEditProfileBtn = document.getElementById('close-edit-profile');
const saveProfileBtn = document.getElementById('save-profile-btn');

let currentUserProfile = null;

async function loadMyProfile() {
  const res = await fetch(`/api/user/${currentUser.id}`);
  currentUserProfile = await res.json();
  return currentUserProfile;
}

async function showMyProfile() {
  const profile = await loadMyProfile();
  
  document.getElementById('profile-avatar').textContent = currentUser.username[0].toUpperCase();
  document.getElementById('profile-avatar').style.background = profile?.avatar_color || '#4fc3f7';
  document.getElementById('profile-banner').style.background = profile?.banner_color || 'linear-gradient(135deg, #4fc3f7, #1976d2)';
  document.getElementById('profile-name').textContent = profile?.display_name || currentUser.username;
  document.getElementById('profile-username').textContent = '@' + currentUser.username;
  document.getElementById('profile-bio').textContent = profile?.bio || '';
  document.getElementById('profile-phone').textContent = profile?.phone || 'Не указан';
  
  profileModal.classList.remove('hidden');
}

currentUserAvatarBtn.addEventListener('click', showMyProfile);

closeProfileBtn.addEventListener('click', () => {
  profileModal.classList.add('hidden');
});

// Edit profile
editProfileBtn.addEventListener('click', () => {
  profileModal.classList.add('hidden');
  document.getElementById('edit-display-name').value = currentUserProfile?.display_name || '';
  document.getElementById('edit-phone').value = currentUserProfile?.phone || '';
  document.getElementById('edit-bio').value = currentUserProfile?.bio || '';
  document.getElementById('edit-avatar-color').value = currentUserProfile?.avatar_color || '#4fc3f7';
  document.getElementById('edit-banner-color').value = currentUserProfile?.banner_color || '#1976d2';
  editProfileModal.classList.remove('hidden');
});

closeEditProfileBtn.addEventListener('click', () => {
  editProfileModal.classList.add('hidden');
});

saveProfileBtn.addEventListener('click', async () => {
  const data = {
    display_name: document.getElementById('edit-display-name').value,
    phone: document.getElementById('edit-phone').value,
    bio: document.getElementById('edit-bio').value,
    avatar_color: document.getElementById('edit-avatar-color').value,
    banner_color: document.getElementById('edit-banner-color').value
  };
  
  await fetch(`/api/user/${currentUser.id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data)
  });
  
  editProfileModal.classList.add('hidden');
  showMyProfile();
});

// ===== SETTINGS MODAL =====
const settingsModal = document.getElementById('settings-modal');
const settingsBtn = document.getElementById('settings-btn');
const closeSettingsBtn = document.getElementById('close-settings');

settingsBtn.addEventListener('click', () => {
  document.getElementById('notifications-checkbox').checked = notificationsEnabled;
  settingsModal.classList.remove('hidden');
});

document.getElementById('notifications-checkbox').addEventListener('change', (e) => {
  notificationsEnabled = e.target.checked;
  localStorage.setItem('notifications', notificationsEnabled);
  if (notificationsEnabled) {
    requestNotificationPermission();
  }
});

closeSettingsBtn.addEventListener('click', () => {
  settingsModal.classList.add('hidden');
});

logoutBtn.addEventListener('click', () => {
  currentUser = null;
  selectedUser = null;
  localStorage.removeItem('kvant_user');
  settingsModal.classList.add('hidden');
  chatScreen.classList.add('hidden');
  loginScreen.classList.remove('hidden');
  loginUsername.value = '';
  loginPassword.value = '';
  messagesDiv.innerHTML = '';
});

// ===== USER PROFILE MODAL (собеседник) =====
const userProfileModal = document.getElementById('user-profile-modal');
const closeUserProfileBtn = document.getElementById('close-user-profile');
const chatUserInfoBtn = document.getElementById('chat-user-info-btn');

async function showUserProfile(userId) {
  const res = await fetch(`/api/user/${userId}`);
  const profile = await res.json();
  
  if (!profile) return;
  
  document.getElementById('user-profile-avatar').textContent = profile.username[0].toUpperCase();
  document.getElementById('user-profile-avatar').style.background = profile.avatar_color || '#4fc3f7';
  document.getElementById('user-profile-banner').style.background = profile.banner_color || 'linear-gradient(135deg, #4fc3f7, #1976d2)';
  document.getElementById('user-profile-name').textContent = profile.display_name || profile.username;
  document.getElementById('user-profile-username').textContent = '@' + profile.username;
  document.getElementById('user-profile-bio').textContent = profile.bio || '';
  document.getElementById('user-profile-phone').textContent = profile.phone || 'Не указан';
  
  userProfileModal.classList.remove('hidden');
}

chatUserInfoBtn.addEventListener('click', () => {
  if (selectedUser) {
    showUserProfile(selectedUser.id);
  }
});

closeUserProfileBtn.addEventListener('click', () => {
  userProfileModal.classList.add('hidden');
});

// Close modals on overlay click
document.querySelectorAll('.modal-overlay').forEach(overlay => {
  overlay.addEventListener('click', () => {
    document.querySelectorAll('.modal').forEach(m => m.classList.add('hidden'));
  });
});

// ===== EMOJI PICKER =====
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

// Заполняем emoji grid
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

emojiBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  emojiPicker.classList.toggle('hidden');
});

// Закрыть emoji picker при клике вне
document.addEventListener('click', (e) => {
  if (!emojiPicker.contains(e.target) && e.target !== emojiBtn) {
    emojiPicker.classList.add('hidden');
  }
});


// ===== MOBILE NAVIGATION =====
const sidebar = document.querySelector('.sidebar');
const backBtn = document.getElementById('back-btn');

function isMobile() {
  return window.innerWidth <= 768;
}

// При выборе чата на мобильном — скрыть sidebar
const originalSelectUser = selectUser;
selectUser = async function(userId, username) {
  await originalSelectUser(userId, username);
  if (isMobile()) {
    sidebar.classList.add('hidden-mobile');
  }
};

// Кнопка назад — показать sidebar
backBtn.addEventListener('click', () => {
  sidebar.classList.remove('hidden-mobile');
});

// При изменении размера окна
window.addEventListener('resize', () => {
  if (!isMobile()) {
    sidebar.classList.remove('hidden-mobile');
  }
});


// ===== WEBRTC CALLS =====
let localStream = null;
let screenStream = null;
let peerConnection = null;
let callTimer = null;
let callSeconds = 0;
let currentCallUser = null;
let currentCallId = null;
let isVideoCall = false;
let isScreenSharing = false;
let isCallMinimized = false;

const callModal = document.getElementById('call-modal');
const incomingCallModal = document.getElementById('incoming-call-modal');
const callAvatar = document.getElementById('call-avatar');
const callName = document.getElementById('call-name');
const callStatus = document.getElementById('call-status');
const callTimerEl = document.getElementById('call-timer');
const callVideos = document.getElementById('call-videos');
const localVideo = document.getElementById('local-video');
const remoteVideo = document.getElementById('remote-video');
const muteBtn = document.getElementById('mute-btn');
const endCallBtn = document.getElementById('end-call-btn');
const toggleVideoBtn = document.getElementById('toggle-video-btn');
const screenShareBtn = document.getElementById('screen-share-btn');
const acceptCallBtn = document.getElementById('accept-call-btn');
const declineCallBtn = document.getElementById('decline-call-btn');

// Полоска активного звонка
const activeCallBar = document.getElementById('active-call-bar');
const callBarName = document.getElementById('call-bar-name');
const callBarTimer = document.getElementById('call-bar-timer');
const callBarExpand = document.getElementById('call-bar-expand');
const callBarEnd = document.getElementById('call-bar-end');

const iceServers = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' }
  ]
};

// Показать/скрыть полоску звонка
function showCallBar() {
  if (currentCallUser) {
    callBarName.textContent = currentCallUser.username;
    activeCallBar.classList.remove('hidden');
    isCallMinimized = true;
  }
}

function hideCallBar() {
  activeCallBar.classList.add('hidden');
  isCallMinimized = false;
}

// Обновление таймера на полоске
function updateCallBarTimer() {
  const mins = Math.floor(callSeconds / 60).toString().padStart(2, '0');
  const secs = (callSeconds % 60).toString().padStart(2, '0');
  callBarTimer.textContent = `${mins}:${secs}`;
}

// Клик по полоске - развернуть звонок
activeCallBar.addEventListener('click', (e) => {
  if (e.target === callBarEnd || e.target === callBarExpand) return;
  expandCall();
});

callBarExpand.addEventListener('click', expandCall);

function expandCall() {
  callModal.classList.remove('hidden');
  hideCallBar();
}

callBarEnd.addEventListener('click', () => {
  endCall(true);
});

// Сворачивание звонка - клик по оверлею
document.querySelector('.call-overlay')?.addEventListener('click', () => {
  if (currentCallUser && callTimer) {
    callModal.classList.add('hidden');
    showCallBar();
  }
});

// Кнопки звонка в хедере
let pendingCallType = false;

document.querySelectorAll('.action-btn').forEach((btn, index) => {
  btn.addEventListener('click', () => {
    if (!selectedUser) return;
    pendingCallType = index === 1;
    startCall(pendingCallType);
  });
});

async function startCall(video = false) {
  if (!selectedUser) return;
  
  isVideoCall = video;
  currentCallUser = selectedUser;
  
  callAvatar.textContent = selectedUser.username[0].toUpperCase();
  callName.textContent = selectedUser.username;
  callStatus.textContent = 'Вызов...';
  callTimerEl.classList.add('hidden');
  callVideos.classList.add('hidden');
  callModal.classList.remove('hidden');
  hideCallBar();
  
  try {
    localStream = await navigator.mediaDevices.getUserMedia({
      audio: true,
      video: video
    });
    
    if (video) {
      localVideo.srcObject = localStream;
      callVideos.classList.remove('hidden');
    }
    
    peerConnection = new RTCPeerConnection(iceServers);
    
    localStream.getTracks().forEach(track => {
      peerConnection.addTrack(track, localStream);
    });
    
    peerConnection.ontrack = (event) => {
      remoteVideo.srcObject = event.streams[0];
      // Показываем видео если есть входящий видеопоток
      if (event.streams[0].getVideoTracks().length > 0) {
        callVideos.classList.remove('hidden');
      }
    };
    
    peerConnection.onicecandidate = (event) => {
      if (event.candidate) {
        socket.emit('ice-candidate', {
          to: currentCallUser.id,
          candidate: event.candidate
        });
      }
    };
    
    const offer = await peerConnection.createOffer();
    await peerConnection.setLocalDescription(offer);
    
    socket.emit('call-user', {
      to: selectedUser.id,
      from: currentUser.id,
      fromName: currentUser.username,
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

socket.on('call-initiated', (data) => {
  currentCallId = data.callId;
});

let incomingCallData = null;

socket.on('incoming-call', async (data) => {
  incomingCallData = data;
  document.getElementById('incoming-call-avatar').textContent = data.fromName[0].toUpperCase();
  document.getElementById('incoming-call-name').textContent = data.fromName;
  document.getElementById('incoming-call-type').textContent = data.isVideo ? '📹 Видеозвонок' : '📞 Аудиозвонок';
  incomingCallModal.classList.remove('hidden');
});

acceptCallBtn.addEventListener('click', async () => {
  if (!incomingCallData) return;
  
  incomingCallModal.classList.add('hidden');
  isVideoCall = incomingCallData.isVideo;
  currentCallUser = { id: incomingCallData.from, username: incomingCallData.fromName };
  currentCallId = incomingCallData.callId;
  
  callAvatar.textContent = incomingCallData.fromName[0].toUpperCase();
  callName.textContent = incomingCallData.fromName;
  callStatus.textContent = 'Подключение...';
  callVideos.classList.add('hidden');
  callModal.classList.remove('hidden');
  
  try {
    localStream = await navigator.mediaDevices.getUserMedia({
      audio: true,
      video: isVideoCall
    });
    
    if (isVideoCall) {
      localVideo.srcObject = localStream;
      callVideos.classList.remove('hidden');
    }
    
    peerConnection = new RTCPeerConnection(iceServers);
    
    localStream.getTracks().forEach(track => {
      peerConnection.addTrack(track, localStream);
    });
    
    peerConnection.ontrack = (event) => {
      remoteVideo.srcObject = event.streams[0];
      if (event.streams[0].getVideoTracks().length > 0) {
        callVideos.classList.remove('hidden');
      }
    };
    
    peerConnection.onicecandidate = (event) => {
      if (event.candidate) {
        socket.emit('ice-candidate', {
          to: currentCallUser.id,
          candidate: event.candidate
        });
      }
    };
    
    await peerConnection.setRemoteDescription(incomingCallData.offer);
    const answer = await peerConnection.createAnswer();
    await peerConnection.setLocalDescription(answer);
    
    socket.emit('call-answer', {
      to: incomingCallData.from,
      answer: answer,
      callId: currentCallId
    });
    
    startCallTimer();
    updateVideoButtonState();
    
  } catch (err) {
    console.error('Ошибка:', err);
    endCall(false);
  }
});

declineCallBtn.addEventListener('click', () => {
  if (incomingCallData) {
    socket.emit('call-decline', { to: incomingCallData.from, callId: incomingCallData.callId });
  }
  incomingCallModal.classList.add('hidden');
  incomingCallData = null;
});

socket.on('call-answered', async (data) => {
  currentCallId = data.callId;
  await peerConnection.setRemoteDescription(data.answer);
  callStatus.textContent = 'Соединено';
  startCallTimer();
});

socket.on('call-declined', () => {
  callStatus.textContent = 'Звонок отклонён';
  setTimeout(() => endCall(false), 2000);
});

socket.on('call-ended', () => {
  cleanupCall();
  callModal.classList.add('hidden');
  hideCallBar();
});

socket.on('call-failed', (data) => {
  callStatus.textContent = data.reason;
  setTimeout(() => endCall(false), 2000);
});

socket.on('ice-candidate', async (data) => {
  if (peerConnection) {
    try {
      await peerConnection.addIceCandidate(data.candidate);
    } catch (e) {
      console.error('ICE candidate error:', e);
    }
  }
});

socket.on('call-message', (message) => {
  if (selectedUser && (message.sender_id === selectedUser.id || message.receiver_id === selectedUser.id)) {
    appendCallMessage(message);
  }
  if (!searchInput.value.trim()) {
    loadContacts();
  }
});

function startCallTimer() {
  callSeconds = 0;
  callTimerEl.classList.remove('hidden');
  callTimer = setInterval(() => {
    callSeconds++;
    const mins = Math.floor(callSeconds / 60).toString().padStart(2, '0');
    const secs = (callSeconds % 60).toString().padStart(2, '0');
    callTimerEl.textContent = `${mins}:${secs}`;
    updateCallBarTimer();
  }, 1000);
}

function cleanupCall() {
  if (callTimer) {
    clearInterval(callTimer);
    callTimer = null;
  }
  
  if (localStream) {
    localStream.getTracks().forEach(track => track.stop());
    localStream = null;
  }
  
  if (screenStream) {
    screenStream.getTracks().forEach(track => track.stop());
    screenStream = null;
  }
  
  if (peerConnection) {
    peerConnection.close();
    peerConnection = null;
  }
  
  isScreenSharing = false;
  currentCallUser = null;
  currentCallId = null;
  hideCallBar();
}

function endCall(sendEnd = true) {
  if (sendEnd && currentCallUser && currentCallId) {
    socket.emit('call-end', { to: currentCallUser.id, callId: currentCallId, userId: currentUser.id });
  }
  
  cleanupCall();
  callModal.classList.add('hidden');
  hideCallBar();
}

endCallBtn.addEventListener('click', () => endCall(true));

let isMuted = false;
muteBtn.addEventListener('click', () => {
  if (localStream) {
    isMuted = !isMuted;
    localStream.getAudioTracks().forEach(track => track.enabled = !isMuted);
    muteBtn.classList.toggle('active', !isMuted);
    muteBtn.textContent = isMuted ? '🔇' : '🎤';
  }
});

function updateVideoButtonState() {
  const videoTrack = localStream?.getVideoTracks()[0];
  if (toggleVideoBtn) {
    const hasVideo = videoTrack?.enabled;
    toggleVideoBtn.classList.toggle('active', hasVideo);
    toggleVideoBtn.textContent = hasVideo ? '📹' : '📷';
  }
}

toggleVideoBtn.addEventListener('click', async () => {
  if (!localStream || !peerConnection) return;
  
  const videoTrack = localStream.getVideoTracks()[0];
  
  if (videoTrack) {
    // Есть видео - переключаем
    videoTrack.enabled = !videoTrack.enabled;
    if (videoTrack.enabled) {
      callVideos.classList.remove('hidden');
      localVideo.srcObject = localStream;
    } else {
      // Проверяем нужно ли скрыть видео окно
      checkHideVideos();
    }
  } else {
    // Нет видео - добавляем и пересогласовываем
    try {
      const newStream = await navigator.mediaDevices.getUserMedia({ video: true });
      const newVideoTrack = newStream.getVideoTracks()[0];
      
      localStream.addTrack(newVideoTrack);
      localVideo.srcObject = localStream;
      callVideos.classList.remove('hidden');
      
      // Добавляем трек и пересогласовываем
      peerConnection.addTrack(newVideoTrack, localStream);
      
      // Создаём новый offer для пересогласования
      const offer = await peerConnection.createOffer();
      await peerConnection.setLocalDescription(offer);
      
      socket.emit('video-renegotiate', {
        to: currentCallUser.id,
        offer: offer
      });
      
    } catch (e) {
      console.error('Не удалось включить видео:', e);
      alert('Не удалось получить доступ к камере');
      return;
    }
  }
  
  updateVideoButtonState();
});

// Проверка нужно ли скрыть видео окно
function checkHideVideos() {
  const localHasVideo = localStream?.getVideoTracks().some(t => t.enabled);
  const remoteHasVideo = remoteVideo.srcObject?.getVideoTracks().some(t => t.enabled);
  
  if (!localHasVideo && !remoteHasVideo && !isScreenSharing) {
    callVideos.classList.add('hidden');
  }
}

// Обработка пересогласования видео
socket.on('video-renegotiate', async (data) => {
  if (!peerConnection) return;
  
  try {
    await peerConnection.setRemoteDescription(data.offer);
    const answer = await peerConnection.createAnswer();
    await peerConnection.setLocalDescription(answer);
    
    socket.emit('video-renegotiate-answer', {
      to: currentCallUser.id,
      answer: answer
    });
  } catch (e) {
    console.error('Renegotiate error:', e);
  }
});

socket.on('video-renegotiate-answer', async (data) => {
  if (!peerConnection) return;
  
  try {
    await peerConnection.setRemoteDescription(data.answer);
  } catch (e) {
    console.error('Renegotiate answer error:', e);
  }
});

if (screenShareBtn) {
  screenShareBtn.addEventListener('click', async () => {
    if (!peerConnection) return;
    
    if (isScreenSharing) {
      stopScreenShare();
    } else {
      try {
        screenStream = await navigator.mediaDevices.getDisplayMedia({
          video: true,
          audio: true
        });
        
        const screenTrack = screenStream.getVideoTracks()[0];
        
        const sender = peerConnection.getSenders().find(s => s.track?.kind === 'video');
        if (sender) {
          sender.replaceTrack(screenTrack);
        } else {
          peerConnection.addTrack(screenTrack, screenStream);
        }
        
        localVideo.srcObject = screenStream;
        callVideos.classList.remove('hidden');
        isScreenSharing = true;
        screenShareBtn.classList.add('active');
        
        screenTrack.onended = () => {
          stopScreenShare();
        };
        
      } catch (e) {
        console.error('Ошибка демонстрации экрана:', e);
      }
    }
  });
}

async function stopScreenShare() {
  if (!isScreenSharing || !peerConnection) return;
  
  if (screenStream) {
    screenStream.getTracks().forEach(track => track.stop());
    screenStream = null;
  }
  
  const videoTrack = localStream?.getVideoTracks()[0];
  if (videoTrack && videoTrack.enabled) {
    const sender = peerConnection.getSenders().find(s => s.track?.kind === 'video');
    if (sender) {
      sender.replaceTrack(videoTrack);
    }
    localVideo.srcObject = localStream;
  } else {
    // Нет активного видео - скрываем окно
    checkHideVideos();
  }
  
  isScreenSharing = false;
  if (screenShareBtn) {
    screenShareBtn.classList.remove('active');
  }
}

function appendCallMessage(msg) {
  const isSent = msg.sender_id === currentUser.id;
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
        <span class="call-text">${msg.text}</span>
        ${durationText ? `<span class="call-duration">${durationText}</span>` : ''}
      </div>
      <div class="message-time">${formatTime(msg.created_at)}</div>
    </div>
  `;
  messagesDiv.appendChild(div);
  messagesDiv.scrollTop = messagesDiv.scrollHeight;
}
