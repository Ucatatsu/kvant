const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const db = require('./database');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

app.use(express.static('public'));
app.use(express.json());

// Онлайн пользователи
const onlineUsers = new Map();

// Активные звонки: { oderId: { oderId, participants: [userId1, userId2], startTime, isVideo } }
const activeCalls = new Map();

// API роуты
app.post('/api/register', async (req, res) => {
  const { username, password } = req.body;
  const result = await db.createUser(username, password);
  res.json(result);
});

app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  const result = await db.loginUser(username, password);
  res.json(result);
});

app.get('/api/users', async (req, res) => {
  const { search } = req.query;
  const users = search ? await db.searchUsers(search) : await db.getAllUsers();
  res.json(users);
});

app.get('/api/contacts/:userId', async (req, res) => {
  const { userId } = req.params;
  const contacts = await db.getContacts(userId);
  res.json(contacts);
});

// Получить профиль пользователя
app.get('/api/user/:userId', async (req, res) => {
  const { userId } = req.params;
  const user = await db.getUser(userId);
  res.json(user);
});

// Обновить профиль
app.put('/api/user/:userId', async (req, res) => {
  const { userId } = req.params;
  const result = await db.updateUser(userId, req.body);
  res.json(result);
});

app.get('/api/messages/:oderId', async (req, res) => {
  const { oderId } = req.params;
  const userId = req.query.userId;
  const messages = await db.getMessages(userId, oderId);
  // Помечаем сообщения как прочитанные
  await db.markMessagesAsRead(oderId, userId);
  res.json(messages);
});

// Socket.io
io.on('connection', (socket) => {
  console.log('Пользователь подключился');

  socket.on('user-online', (userId) => {
    onlineUsers.set(userId, socket.id);
    io.emit('online-users', Array.from(onlineUsers.keys()));
  });

  socket.on('send-message', async (data) => {
    const { senderId, receiverId, text } = data;
    const message = await db.saveMessage(senderId, receiverId, text);
    
    const receiverSocket = onlineUsers.get(receiverId);
    if (receiverSocket) {
      io.to(receiverSocket).emit('new-message', message);
    }
    socket.emit('message-sent', message);
  });

  // WebRTC сигнализация для звонков
  socket.on('call-user', (data) => {
    const { to, from, fromName, offer, isVideo } = data;
    const receiverSocket = onlineUsers.get(to);
    if (receiverSocket) {
      // Создаём запись о звонке
      const callId = `${from}-${to}-${Date.now()}`;
      activeCalls.set(callId, {
        callId,
        participants: [from, to],
        caller: from,
        callerName: fromName,
        startTime: null, // Установится при ответе
        isVideo
      });
      io.to(receiverSocket).emit('incoming-call', { from, fromName, offer, isVideo, callId });
      socket.emit('call-initiated', { callId });
    } else {
      socket.emit('call-failed', { reason: 'Пользователь не в сети' });
    }
  });

  socket.on('call-answer', async (data) => {
    const { to, answer, callId } = data;
    const callerSocket = onlineUsers.get(to);
    if (callerSocket) {
      // Устанавливаем время начала звонка
      const call = activeCalls.get(callId);
      if (call) {
        call.startTime = Date.now();
        activeCalls.set(callId, call);
      }
      io.to(callerSocket).emit('call-answered', { answer, callId });
    }
  });

  socket.on('call-decline', async (data) => {
    const { to, callId } = data;
    const callerSocket = onlineUsers.get(to);
    if (callerSocket) {
      io.to(callerSocket).emit('call-declined');
    }
    // Удаляем звонок
    if (callId) activeCalls.delete(callId);
  });

  socket.on('call-end', async (data) => {
    const { to, callId } = data;
    const otherSocket = onlineUsers.get(to);
    
    const call = activeCalls.get(callId);
    if (call && call.startTime) {
      // Звонок состоялся - сохраняем в чат
      const duration = Math.floor((Date.now() - call.startTime) / 1000);
      const callType = call.isVideo ? 'video_call' : 'audio_call';
      const callText = call.isVideo ? 'Видеозвонок' : 'Аудиозвонок';
      
      // Сохраняем сообщение о звонке
      const message = await db.saveMessage(call.caller, call.participants.find(p => p !== call.caller), callText, callType, duration);
      
      // Отправляем обоим участникам
      const callerSocket = onlineUsers.get(call.caller);
      const receiverSocket = onlineUsers.get(call.participants.find(p => p !== call.caller));
      if (callerSocket) io.to(callerSocket).emit('call-message', message);
      if (receiverSocket) io.to(receiverSocket).emit('call-message', message);
    }
    
    if (otherSocket) {
      io.to(otherSocket).emit('call-ended', { callId });
    }
    
    // Удаляем звонок
    if (callId) activeCalls.delete(callId);
  });

  // Выход из звонка без завершения (можно вернуться)
  socket.on('call-leave', (data) => {
    const { to, callId } = data;
    const otherSocket = onlineUsers.get(to);
    if (otherSocket) {
      io.to(otherSocket).emit('call-user-left', { callId });
    }
  });

  // Возврат в звонок
  socket.on('call-rejoin', async (data) => {
    const { callId, userId, offer } = data;
    const call = activeCalls.get(callId);
    if (call) {
      const otherUserId = call.participants.find(p => p !== userId);
      const otherSocket = onlineUsers.get(otherUserId);
      if (otherSocket) {
        io.to(otherSocket).emit('call-rejoin-request', { callId, userId, offer });
      }
    } else {
      socket.emit('call-failed', { reason: 'Звонок завершён' });
    }
  });

  socket.on('call-rejoin-answer', (data) => {
    const { to, answer, callId } = data;
    const otherSocket = onlineUsers.get(to);
    if (otherSocket) {
      io.to(otherSocket).emit('call-rejoined', { answer, callId });
    }
  });

  socket.on('ice-candidate', (data) => {
    const { to, candidate } = data;
    const otherSocket = onlineUsers.get(to);
    if (otherSocket) {
      io.to(otherSocket).emit('ice-candidate', { candidate });
    }
  });

  // Пересогласование видео (когда включают камеру во время звонка)
  socket.on('video-renegotiate', (data) => {
    const { to, offer } = data;
    const otherSocket = onlineUsers.get(to);
    if (otherSocket) {
      io.to(otherSocket).emit('video-renegotiate', { offer });
    }
  });

  socket.on('video-renegotiate-answer', (data) => {
    const { to, answer } = data;
    const otherSocket = onlineUsers.get(to);
    if (otherSocket) {
      io.to(otherSocket).emit('video-renegotiate-answer', { answer });
    }
  });

  // Проверка активного звонка
  socket.on('check-active-call', (data) => {
    const { oderId, userId } = data;
    for (const [callId, call] of activeCalls.entries()) {
      if (call.participants.includes(userId) && call.participants.includes(oderId)) {
        socket.emit('active-call-found', { callId, call });
        return;
      }
    }
    socket.emit('no-active-call');
  });

  socket.on('disconnect', () => {
    for (const [userId, socketId] of onlineUsers.entries()) {
      if (socketId === socket.id) {
        onlineUsers.delete(userId);
        break;
      }
    }
    io.emit('online-users', Array.from(onlineUsers.keys()));
  });
});

const PORT = process.env.PORT || 3000;

db.initDB().then(() => {
  server.listen(PORT, () => {
    console.log(`Квант запущен на порту ${PORT}`);
  });
}).catch(err => {
  console.error('Ошибка инициализации БД:', err);
});
