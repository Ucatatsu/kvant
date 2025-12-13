// Загружаем переменные окружения из .env
require('dotenv').config();

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const webpush = require('web-push');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const validator = require('validator');
const cloudinary = require('cloudinary').v2;
const db = require('./database');
const { generateToken, authMiddleware, ownerMiddleware, adminMiddleware, socketAuthMiddleware } = require('./middleware/auth');

// Настройка Cloudinary
if (process.env.CLOUDINARY_URL || process.env.CLOUDINARY_CLOUD_NAME) {
    cloudinary.config({
        cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
        api_key: process.env.CLOUDINARY_API_KEY,
        api_secret: process.env.CLOUDINARY_API_SECRET
    });
    console.log('☁️  Cloudinary настроен');
} else {
    console.warn('⚠️  Cloudinary не настроен! Изображения будут храниться локально.');
}

const app = express();

// === БЕЗОПАСНОСТЬ ===

// Helmet для HTTP заголовков безопасности
app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            styleSrc: ["'self'", "'unsafe-inline'"],
            scriptSrc: ["'self'"],
            imgSrc: ["'self'", "data:", "blob:", "https://res.cloudinary.com"],
            connectSrc: ["'self'", "wss:", "ws:"],
            mediaSrc: ["'self'", "blob:"],
        },
    },
    crossOriginEmbedderPolicy: false,
}));

// Rate limiting - общий
const generalLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 минут
    max: 1000, // максимум запросов
    message: { success: false, error: 'Слишком много запросов, попробуйте позже' },
    standardHeaders: true,
    legacyHeaders: false,
});

// Rate limiting - для авторизации (строже)
const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 минут
    max: 10, // максимум 10 попыток входа
    message: { success: false, error: 'Слишком много попыток входа, попробуйте через 15 минут' },
    standardHeaders: true,
    legacyHeaders: false,
});

app.use(generalLimiter);

// Создаём папку для загрузок
const uploadsDir = path.join(__dirname, 'public', 'uploads');
if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir, { recursive: true });
}

// Настройка multer для загрузки файлов
const storage = process.env.CLOUDINARY_CLOUD_NAME 
    ? multer.memoryStorage()  // В память для Cloudinary
    : multer.diskStorage({    // На диск для локальной разработки
        destination: (_req, _file, cb) => cb(null, uploadsDir),
        filename: (_req, file, cb) => {
            const uniqueName = `${Date.now()}-${Math.random().toString(36).substring(2, 11)}${path.extname(file.originalname)}`;
            cb(null, uniqueName);
        }
    });

const upload = multer({
    storage,
    limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
    fileFilter: (_req, file, cb) => {
        const allowedTypes = /jpeg|jpg|png|gif|webp/;
        const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
        const mimetype = allowedTypes.test(file.mimetype);
        if (extname && mimetype) {
            cb(null, true);
        } else {
            cb(new Error('Только изображения (jpg, png, gif, webp)'));
        }
    }
});

// Функция загрузки в Cloudinary
async function uploadToCloudinary(buffer, folder) {
    return new Promise((resolve, reject) => {
        const uploadStream = cloudinary.uploader.upload_stream(
            { 
                folder: `kvant/${folder}`,
                transformation: [
                    { width: 500, height: 500, crop: 'limit' },
                    { quality: 'auto' }
                ]
            },
            (error, result) => {
                if (error) reject(error);
                else resolve(result.secure_url);
            }
        );
        uploadStream.end(buffer);
    });
}

// VAPID ключи из переменных окружения (ОБЯЗАТЕЛЬНО!)
const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY;

if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
    webpush.setVapidDetails(
        'mailto:admin@kvant.app',
        VAPID_PUBLIC_KEY,
        VAPID_PRIVATE_KEY
    );
} else {
    console.warn('⚠️  VAPID ключи не настроены! Push-уведомления отключены.');
    console.warn('   Сгенерируйте ключи: npx web-push generate-vapid-keys');
}

const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: process.env.CORS_ORIGIN || "*",
        methods: ["GET", "POST"]
    },
    connectionStateRecovery: {
        maxDisconnectionDuration: 2 * 60 * 1000,
    }
});

// Socket.IO аутентификация
io.use(socketAuthMiddleware);

app.use(express.static('public'));
app.use(express.json({ limit: '1mb' }));

// Онлайн пользователи: userId -> { socketId, lastSeen }
const onlineUsers = new Map();

// Активные звонки
const activeCalls = new Map();

// === ВАЛИДАЦИЯ ===

function isValidUsername(username) {
    return typeof username === 'string' && 
           /^[a-zA-Z0-9_]{3,20}$/.test(username);
}

function isValidPassword(password) {
    return typeof password === 'string' && 
           password.length >= 6 && 
           password.length <= 100;
}

function sanitizeText(text, maxLength = 5000) {
    if (typeof text !== 'string') return '';
    return validator.escape(text.trim().substring(0, maxLength));
}

// === ПУБЛИЧНЫЕ РОУТЫ (без авторизации) ===

// Регистрация
app.post('/api/register', authLimiter, async (req, res) => {
    try {
        const { username, password } = req.body;
        
        if (!username || !password) {
            return res.status(400).json({ success: false, error: 'Заполните все поля' });
        }
        
        if (!isValidUsername(username)) {
            return res.status(400).json({ success: false, error: 'Ник: 3-20 символов, только буквы, цифры и _' });
        }
        
        if (!isValidPassword(password)) {
            return res.status(400).json({ success: false, error: 'Пароль: от 6 до 100 символов' });
        }
        
        const result = await db.createUser(username, password);
        res.json(result);
    } catch (error) {
        console.error('Register error:', error);
        res.status(500).json({ success: false, error: 'Ошибка сервера' });
    }
});

// Вход
app.post('/api/login', authLimiter, async (req, res) => {
    try {
        const { username, password } = req.body;
        
        if (!username || !password) {
            return res.status(400).json({ success: false, error: 'Заполните все поля' });
        }
        
        const result = await db.loginUser(username, password);
        
        if (result.success) {
            const token = generateToken(result.user);
            res.json({ 
                success: true, 
                user: result.user,
                token 
            });
        } else {
            res.status(401).json(result);
        }
    } catch (error) {
        console.error('Login error:', error);
        res.status(500).json({ success: false, error: 'Ошибка сервера' });
    }
});

// VAPID публичный ключ
app.get('/api/vapid-public-key', (_req, res) => {
    if (VAPID_PUBLIC_KEY) {
        res.json({ publicKey: VAPID_PUBLIC_KEY });
    } else {
        res.status(503).json({ error: 'Push-уведомления не настроены' });
    }
});

// === ЗАЩИЩЁННЫЕ РОУТЫ ===

// Поиск пользователей
app.get('/api/users', authMiddleware, async (req, res) => {
    try {
        const { search } = req.query;
        const users = search ? await db.searchUsers(search, req.user.id) : [];
        res.json(users);
    } catch (error) {
        console.error('Search users error:', error);
        res.status(500).json([]);
    }
});

// Контакты пользователя
app.get('/api/contacts/:userId', authMiddleware, ownerMiddleware('userId'), async (req, res) => {
    try {
        const contacts = await db.getContacts(req.user.id);
        res.json(contacts);
    } catch (error) {
        console.error('Get contacts error:', error);
        res.status(500).json([]);
    }
});

// Получить свой профиль
app.get('/api/user/:userId', authMiddleware, async (req, res) => {
    try {
        const { userId } = req.params;
        const user = await db.getUser(userId);
        
        if (!user) {
            return res.status(404).json({ error: 'Пользователь не найден' });
        }
        
        // Скрываем приватные данные если это не свой профиль
        if (userId !== req.user.id) {
            delete user.phone;
        }
        
        res.json(user);
    } catch (error) {
        console.error('Get user error:', error);
        res.status(500).json({ error: 'Ошибка сервера' });
    }
});

// Обновить свой профиль
app.put('/api/user/:userId', authMiddleware, ownerMiddleware('userId'), async (req, res) => {
    try {
        const data = {
            display_name: sanitizeText(req.body.display_name, 50),
            phone: sanitizeText(req.body.phone, 20),
            bio: sanitizeText(req.body.bio, 500)
        };
        
        const result = await db.updateUser(req.user.id, data);
        res.json(result);
    } catch (error) {
        console.error('Update user error:', error);
        res.status(500).json({ success: false, error: 'Ошибка сервера' });
    }
});

// Загрузка аватарки
app.post('/api/user/:userId/avatar', authMiddleware, ownerMiddleware('userId'), upload.single('avatar'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ success: false, error: 'Файл не загружен' });
        }
        
        let avatarUrl;
        if (process.env.CLOUDINARY_CLOUD_NAME) {
            // Загружаем в Cloudinary
            avatarUrl = await uploadToCloudinary(req.file.buffer, 'avatars');
        } else {
            // Локальное хранение
            avatarUrl = `/uploads/${req.file.filename}`;
        }
        
        await db.updateUserAvatar(req.user.id, avatarUrl);
        res.json({ success: true, avatarUrl });
    } catch (error) {
        console.error('Upload avatar error:', error);
        res.status(500).json({ success: false, error: 'Ошибка загрузки' });
    }
});

// Загрузка баннера
app.post('/api/user/:userId/banner', authMiddleware, ownerMiddleware('userId'), upload.single('banner'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ success: false, error: 'Файл не загружен' });
        }
        
        let bannerUrl;
        if (process.env.CLOUDINARY_CLOUD_NAME) {
            // Загружаем в Cloudinary (баннер шире)
            bannerUrl = await uploadToCloudinary(req.file.buffer, 'banners');
        } else {
            // Локальное хранение
            bannerUrl = `/uploads/${req.file.filename}`;
        }
        
        await db.updateUserBanner(req.user.id, bannerUrl);
        res.json({ success: true, bannerUrl });
    } catch (error) {
        console.error('Upload banner error:', error);
        res.status(500).json({ success: false, error: 'Ошибка загрузки' });
    }
});

// Смена username
app.put('/api/user/:userId/username', authMiddleware, ownerMiddleware('userId'), async (req, res) => {
    try {
        const { username } = req.body;
        
        if (!isValidUsername(username)) {
            return res.status(400).json({ success: false, error: 'Ник: 3-20 символов, только буквы, цифры и _' });
        }
        
        const result = await db.updateUsername(req.user.id, username);
        res.json(result);
    } catch (error) {
        console.error('Update username error:', error);
        res.status(500).json({ success: false, error: 'Ошибка сервера' });
    }
});

// Сообщения
app.get('/api/messages/:oderId', authMiddleware, async (req, res) => {
    try {
        const { oderId } = req.params;
        const { limit = 50, before } = req.query;
        
        const messages = await db.getMessages(req.user.id, oderId, parseInt(limit), before);
        await db.markMessagesAsRead(oderId, req.user.id);
        res.json(messages);
    } catch (error) {
        console.error('Get messages error:', error);
        res.status(500).json([]);
    }
});

// Поиск по тегу (username#tag)
app.get('/api/user/tag/:username/:tag', authMiddleware, async (req, res) => {
    try {
        const { username, tag } = req.params;
        const user = await db.getUserByTag(username, tag);
        
        if (!user) {
            return res.status(404).json({ error: 'Пользователь не найден' });
        }
        
        res.json(user);
    } catch (error) {
        console.error('Get user by tag error:', error);
        res.status(500).json({ error: 'Ошибка сервера' });
    }
});

// === АДМИН РОУТЫ ===

// Получить всех пользователей
app.get('/api/admin/users', authMiddleware, adminMiddleware, async (req, res) => {
    try {
        const { limit = 50, offset = 0 } = req.query;
        const result = await db.getAllUsers(parseInt(limit), parseInt(offset));
        res.json(result);
    } catch (error) {
        console.error('Admin get users error:', error);
        res.status(500).json({ error: 'Ошибка сервера' });
    }
});

// Изменить роль пользователя
app.put('/api/admin/user/:userId/role', authMiddleware, adminMiddleware, async (req, res) => {
    try {
        const { userId } = req.params;
        const { role } = req.body;
        
        const result = await db.setUserRole(userId, role);
        res.json(result);
    } catch (error) {
        console.error('Admin set role error:', error);
        res.status(500).json({ success: false, error: 'Ошибка сервера' });
    }
});

// Выдать премиум
app.post('/api/admin/user/:userId/premium', authMiddleware, adminMiddleware, async (req, res) => {
    try {
        const { userId } = req.params;
        const { days } = req.body;
        
        if (!days || days < 1) {
            return res.status(400).json({ success: false, error: 'Укажите количество дней' });
        }
        
        const result = await db.setPremium(userId, parseInt(days));
        res.json(result);
    } catch (error) {
        console.error('Admin set premium error:', error);
        res.status(500).json({ success: false, error: 'Ошибка сервера' });
    }
});

// Удалить пользователя
app.delete('/api/admin/user/:userId', authMiddleware, adminMiddleware, async (req, res) => {
    try {
        const { userId } = req.params;
        
        // Нельзя удалить себя
        if (userId === req.user.id) {
            return res.status(400).json({ success: false, error: 'Нельзя удалить себя' });
        }
        
        const result = await db.deleteUser(userId);
        res.json(result);
    } catch (error) {
        console.error('Admin delete user error:', error);
        res.status(500).json({ success: false, error: 'Ошибка сервера' });
    }
});

// Push подписка
app.post('/api/push-subscribe', authMiddleware, async (req, res) => {
    try {
        const { subscription } = req.body;
        
        if (!subscription || !subscription.endpoint) {
            return res.status(400).json({ success: false, error: 'Неверные данные подписки' });
        }
        
        const result = await db.savePushSubscription(req.user.id, subscription);
        res.json(result);
    } catch (error) {
        console.error('Push subscribe error:', error);
        res.status(500).json({ success: false, error: 'Ошибка сервера' });
    }
});

// === PUSH УВЕДОМЛЕНИЯ ===

async function sendPushNotification(userId, payload) {
    if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) return;
    
    try {
        const subscriptions = await db.getPushSubscriptions(userId);
        
        for (const subscription of subscriptions) {
            try {
                await webpush.sendNotification(subscription, JSON.stringify(payload));
            } catch (error) {
                if (error.statusCode === 410 || error.statusCode === 404) {
                    await db.deletePushSubscription(subscription.endpoint);
                }
            }
        }
    } catch (error) {
        console.error('Push notification error:', error);
    }
}

// === SOCKET.IO ===

io.on('connection', (socket) => {
    const userId = socket.user.id;
    console.log(`Пользователь подключился: ${userId}`);
    
    // Регистрируем пользователя онлайн
    onlineUsers.set(userId, { socketId: socket.id, lastSeen: Date.now() });
    io.emit('online-users', Array.from(onlineUsers.keys()));
    
    // Отправка сообщения
    socket.on('send-message', async (data) => {
        try {
            const { receiverId, text } = data;
            
            if (!receiverId || !text || typeof text !== 'string') {
                return socket.emit('error', { message: 'Неверные данные' });
            }
            
            const sanitizedText = text.trim().substring(0, 5000);
            if (!sanitizedText) return;
            
            const message = await db.saveMessage(userId, receiverId, sanitizedText);
            
            const receiverData = onlineUsers.get(receiverId);
            if (receiverData) {
                io.to(receiverData.socketId).emit('new-message', message);
            } else {
                // Оффлайн - push уведомление
                sendPushNotification(receiverId, {
                    title: socket.user.username || 'Новое сообщение',
                    body: sanitizedText.length > 100 ? sanitizedText.substring(0, 100) + '...' : sanitizedText,
                    tag: `msg-${userId}`,
                    senderId: userId
                });
            }
            
            socket.emit('message-sent', message);
        } catch (error) {
            console.error('Send message error:', error);
            socket.emit('error', { message: 'Ошибка отправки' });
        }
    });

    // Индикатор печати
    socket.on('typing-start', (data) => {
        const receiverData = onlineUsers.get(data.receiverId);
        if (receiverData) {
            io.to(receiverData.socketId).emit('user-typing', { userId, typing: true });
        }
    });

    socket.on('typing-stop', (data) => {
        const receiverData = onlineUsers.get(data.receiverId);
        if (receiverData) {
            io.to(receiverData.socketId).emit('user-typing', { userId, typing: false });
        }
    });

    // === ЗВОНКИ ===
    
    socket.on('call-user', (data) => {
        const { to, offer, isVideo } = data;
        const receiverData = onlineUsers.get(to);
        
        if (receiverData) {
            const callId = `${userId}-${to}-${Date.now()}`;
            activeCalls.set(callId, {
                callId,
                participants: [userId, to],
                caller: userId,
                callerName: socket.user.username,
                startTime: null,
                isVideo
            });
            
            io.to(receiverData.socketId).emit('incoming-call', { 
                from: userId, 
                fromName: socket.user.username, 
                offer, 
                isVideo, 
                callId 
            });
            socket.emit('call-initiated', { callId });
        } else {
            socket.emit('call-failed', { reason: 'Пользователь не в сети' });
        }
    });

    socket.on('call-answer', async (data) => {
        const { to, answer, callId } = data;
        const callerData = onlineUsers.get(to);
        
        if (callerData) {
            const call = activeCalls.get(callId);
            if (call) {
                call.startTime = Date.now();
                activeCalls.set(callId, call);
            }
            io.to(callerData.socketId).emit('call-answered', { answer, callId });
        }
    });

    socket.on('call-decline', (data) => {
        const { to, callId } = data;
        const callerData = onlineUsers.get(to);
        
        if (callerData) {
            io.to(callerData.socketId).emit('call-declined');
        }
        if (callId) activeCalls.delete(callId);
    });

    socket.on('call-end', async (data) => {
        const { to, callId } = data;
        const otherData = onlineUsers.get(to);
        
        const call = activeCalls.get(callId);
        if (call && call.startTime) {
            const duration = Math.floor((Date.now() - call.startTime) / 1000);
            const callType = call.isVideo ? 'video_call' : 'audio_call';
            const callText = call.isVideo ? 'Видеозвонок' : 'Аудиозвонок';
            
            try {
                const receiver = call.participants.find(p => p !== call.caller);
                const message = await db.saveMessage(call.caller, receiver, callText, callType, duration);
                
                const callerData = onlineUsers.get(call.caller);
                const receiverData = onlineUsers.get(receiver);
                
                if (callerData) io.to(callerData.socketId).emit('call-message', message);
                if (receiverData) io.to(receiverData.socketId).emit('call-message', message);
            } catch (error) {
                console.error('Save call message error:', error);
            }
        }
        
        if (otherData) {
            io.to(otherData.socketId).emit('call-ended', { callId });
        }
        
        if (callId) activeCalls.delete(callId);
    });

    socket.on('ice-candidate', (data) => {
        const { to, candidate } = data;
        const otherData = onlineUsers.get(to);
        if (otherData) {
            io.to(otherData.socketId).emit('ice-candidate', { candidate });
        }
    });

    socket.on('video-renegotiate', (data) => {
        const { to, offer } = data;
        const otherData = onlineUsers.get(to);
        if (otherData) {
            io.to(otherData.socketId).emit('video-renegotiate', { offer });
        }
    });

    socket.on('video-renegotiate-answer', (data) => {
        const { to, answer } = data;
        const otherData = onlineUsers.get(to);
        if (otherData) {
            io.to(otherData.socketId).emit('video-renegotiate-answer', { answer });
        }
    });

    // Отключение
    socket.on('disconnect', () => {
        onlineUsers.delete(userId);
        io.emit('online-users', Array.from(onlineUsers.keys()));
        
        // Завершаем активные звонки пользователя
        for (const [callId, call] of activeCalls.entries()) {
            if (call.participants.includes(userId)) {
                const otherId = call.participants.find(p => p !== userId);
                const otherData = onlineUsers.get(otherId);
                if (otherData) {
                    io.to(otherData.socketId).emit('call-ended', { callId, reason: 'disconnect' });
                }
                activeCalls.delete(callId);
            }
        }
        
        console.log(`Пользователь отключился: ${userId}`);
    });
});

// Очистка зависших звонков каждые 5 минут
setInterval(() => {
    const now = Date.now();
    for (const [callId, call] of activeCalls.entries()) {
        // Удаляем звонки старше 2 часов
        if (call.startTime && (now - call.startTime) > 2 * 60 * 60 * 1000) {
            activeCalls.delete(callId);
        }
        // Удаляем неотвеченные звонки старше 2 минут
        if (!call.startTime && (now - parseInt(callId.split('-')[2])) > 2 * 60 * 1000) {
            activeCalls.delete(callId);
        }
    }
}, 5 * 60 * 1000);

// === ЗАПУСК ===

const PORT = process.env.PORT || 3000;

db.initDB().then(() => {
    server.listen(PORT, () => {
        console.log(`✅ Квант запущен на порту ${PORT}`);
        if (!VAPID_PUBLIC_KEY) {
            console.log('⚠️  Push-уведомления отключены (нет VAPID ключей)');
        }
    });
}).catch(err => {
    console.error('❌ Ошибка инициализации БД:', err);
    process.exit(1);
});
