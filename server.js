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
