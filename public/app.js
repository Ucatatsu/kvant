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
