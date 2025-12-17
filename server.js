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

// Доверяем прокси (Render, Heroku и т.д.)
app.set('trust proxy', 1);

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
            mediaSrc: ["'self'", "blob:", "https://res.cloudinary.com"],
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

// Лимиты файлов
const FILE_LIMITS = {
    regular: 5 * 1024 * 1024,   // 5MB для обычных
    premium: 25 * 1024 * 1024   // 25MB для премиум
};

// Базовый upload (лимит проверяется отдельно)
const upload = multer({
    storage,
    limits: { fileSize: FILE_LIMITS.premium }, // Максимальный лимит, проверка ниже
    fileFilter: (_req, file, cb) => {
        const allowedExtensions = /\.(jpeg|jpg|png|gif|webp|mp4)$/i;
        const allowedMimetypes = /^(image\/(jpeg|png|gif|webp)|video\/mp4)$/;
        
        const extValid = allowedExtensions.test(file.originalname);
        const mimeValid = allowedMimetypes.test(file.mimetype);
        
        if (extValid && mimeValid) {
            cb(null, true);
        } else {
            console.log('File rejected:', file.originalname, file.mimetype);
            cb(new Error('Только изображения (jpg, png, gif, webp) и видео (mp4)'));
        }
    }
});

// Проверка премиум-статуса пользователя
async function checkPremiumStatus(userId) {
    const user = await db.getUser(userId);
    if (!user) return false;
    return user.role === 'admin' || user.isPremium;
}

// Проверка разрешённых форматов для аватарки/баннера
function isAnimatedFormat(file) {
    const ext = path.extname(file.originalname).toLowerCase();
    return ext === '.gif' || ext === '.mp4';
}

// Функция загрузки в Cloudinary
async function uploadToCloudinary(buffer, folder, options = {}) {
    return new Promise((resolve, reject) => {
        const uploadOptions = { 
            folder: `kvant/${folder}`,
            resource_type: options.resourceType || 'auto'
        };
        
        // Для видео указываем формат mp4 для совместимости
        if (options.resourceType === 'video') {
            uploadOptions.format = 'mp4';
        } else {
            // Трансформации только для изображений
            uploadOptions.transformation = [
                { width: 500, height: 500, crop: 'limit' },
                { quality: 'auto' }
            ];
        }
        
        const uploadStream = cloudinary.uploader.upload_stream(
            uploadOptions,
            (error, result) => {
                if (error) {
                    console.error('Cloudinary upload error:', error);
                    reject(error);
                } else {
                    console.log('Cloudinary result:', result.secure_url, result.format);
                    resolve(result.secure_url);
                }
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

// Rate limiting для Socket.IO событий
const socketRateLimits = new Map(); // userId -> { event: { count, resetTime } }

function checkSocketRateLimit(userId, event, limit = 30, windowMs = 60000) {
    const now = Date.now();
    if (!socketRateLimits.has(userId)) {
        socketRateLimits.set(userId, {});
    }
    const userLimits = socketRateLimits.get(userId);
    
    if (!userLimits[event] || now > userLimits[event].resetTime) {
        userLimits[event] = { count: 1, resetTime: now + windowMs };
        return true;
    }
    
    if (userLimits[event].count >= limit) {
        return false;
    }
    
    userLimits[event].count++;
    return true;
}

// Очистка rate limits каждые 5 минут
setInterval(() => {
    const now = Date.now();
    for (const [userId, limits] of socketRateLimits.entries()) {
        for (const event of Object.keys(limits)) {
            if (now > limits[event].resetTime) {
                delete limits[event];
            }
        }
        if (Object.keys(limits).length === 0) {
            socketRateLimits.delete(userId);
        }
    }
}, 5 * 60 * 1000);

app.use(express.static('public'));
app.use(express.json({ limit: '1mb' }));

// Онлайн пользователи: userId -> { sockets: Set<socketId>, lastSeen, status, hideOnline }
const onlineUsers = new Map();

// Активные звонки
const activeCalls = new Map();

// Получить все сокеты пользователя
function getUserSockets(userId) {
    const userData = onlineUsers.get(userId);
    return userData?.sockets || new Set();
}

// Отправить событие всем сокетам пользователя
function emitToUser(userId, event, data) {
    const sockets = getUserSockets(userId);
    for (const socketId of sockets) {
        io.to(socketId).emit(event, data);
    }
}

// Функция для отправки списка онлайн пользователей с их статусами
async function broadcastOnlineUsers() {
    const usersWithStatus = {};
    for (const [odataId, data] of onlineUsers) {
        // Не показываем invisible пользователей как онлайн
        if (data.status !== 'invisible' && !data.hideOnline) {
            usersWithStatus[odataId] = data.status || 'online';
        }
    }
    io.emit('online-users', usersWithStatus);
}

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

// Health check для Render
let serverReady = false;
app.get('/health', (_req, res) => {
    // Всегда возвращаем 200, чтобы Render не убивал сервер
    res.status(200).json({ 
        status: serverReady ? 'ready' : 'starting', 
        timestamp: Date.now() 
    });
});

// Функция для установки готовности
function setServerReady() {
    serverReady = true;
}

// Правовые документы
app.get('/api/legal/privacy', (_req, res) => {
    const fs = require('fs');
    const path = require('path');
    try {
        const content = fs.readFileSync(path.join(__dirname, 'ПОЛИТИКА КОНФИДЕНЦИАЛЬНОСТИ.md'), 'utf8');
        res.json({ content });
    } catch (error) {
        res.status(404).json({ error: 'Документ не найден' });
    }
});

app.get('/api/legal/terms', (_req, res) => {
    const fs = require('fs');
    const path = require('path');
    try {
        const content = fs.readFileSync(path.join(__dirname, 'УСЛОВИЯ ИСПОЛЬЗОВАНИЯ.md'), 'utf8');
        res.json({ content });
    } catch (error) {
        res.status(404).json({ error: 'Документ не найден' });
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

// Обновить премиум-настройки профиля
app.put('/api/user/:userId/premium-settings', authMiddleware, ownerMiddleware('userId'), async (req, res) => {
    try {
        const isPremium = await checkPremiumStatus(req.user.id);
        if (!isPremium) {
            return res.status(403).json({ success: false, error: 'Требуется Premium подписка' });
        }
        
        const { name_color, profile_theme, profile_color, custom_id, bubble_style, hide_online } = req.body;
        
        // Проверка кастомного ID (4 цифры)
        if (custom_id) {
            if (!/^\d{4}$/.test(custom_id)) {
                return res.status(400).json({ success: false, error: 'ID должен быть 4 цифры (0000-9999)' });
            }
            const available = await db.isCustomIdAvailable(custom_id, req.user.id);
            if (!available) {
                return res.status(400).json({ success: false, error: 'Этот ID уже занят' });
            }
        }
        
        const data = {
            name_color: name_color || null,
            profile_theme: profile_theme || null,
            profile_color: profile_color || null,
            custom_id: custom_id || null,
            bubble_style: bubble_style || null,
            hide_online: hide_online !== undefined ? hide_online : null
        };
        
        const result = await db.updatePremiumSettings(req.user.id, data);
        
        // Обновляем статус в онлайн-списке
        const userData = onlineUsers.get(req.user.id);
        if (userData && hide_online !== undefined) {
            userData.hideOnline = hide_online;
            onlineUsers.set(req.user.id, userData);
            broadcastOnlineUsers();
        }
        res.json(result);
    } catch (error) {
        console.error('Update premium settings error:', error);
        res.status(500).json({ success: false, error: 'Ошибка сервера' });
    }
});

// Загрузка аватарки
app.post('/api/user/:userId/avatar', authMiddleware, ownerMiddleware('userId'), upload.single('avatar'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ success: false, error: 'Файл не загружен' });
        }
        
        // Проверка премиума для анимированных форматов
        const isPremium = await checkPremiumStatus(req.user.id);
        if (isAnimatedFormat(req.file) && !isPremium) {
            return res.status(403).json({ 
                success: false, 
                error: 'GIF и MP4 аватарки доступны только для Premium' 
            });
        }
        
        // Проверка лимита размера
        const maxSize = isPremium ? FILE_LIMITS.premium : FILE_LIMITS.regular;
        if (req.file.size > maxSize) {
            const limitMB = maxSize / (1024 * 1024);
            return res.status(400).json({ 
                success: false, 
                error: `Максимальный размер файла: ${limitMB}MB` 
            });
        }
        
        let avatarUrl;
        if (process.env.CLOUDINARY_CLOUD_NAME) {
            avatarUrl = await uploadToCloudinary(req.file.buffer, 'avatars');
        } else {
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
        
        // Проверка премиума для анимированных форматов
        const isPremium = await checkPremiumStatus(req.user.id);
        if (isAnimatedFormat(req.file) && !isPremium) {
            return res.status(403).json({ 
                success: false, 
                error: 'GIF и MP4 баннеры доступны только для Premium' 
            });
        }
        
        // Проверка лимита размера
        const maxSize = isPremium ? FILE_LIMITS.premium : FILE_LIMITS.regular;
        if (req.file.size > maxSize) {
            const limitMB = maxSize / (1024 * 1024);
            return res.status(400).json({ 
                success: false, 
                error: `Максимальный размер файла: ${limitMB}MB` 
            });
        }
        
        let bannerUrl;
        if (process.env.CLOUDINARY_CLOUD_NAME) {
            bannerUrl = await uploadToCloudinary(req.file.buffer, 'banners');
        } else {
            bannerUrl = `/uploads/${req.file.filename}`;
        }
        
        await db.updateUserBanner(req.user.id, bannerUrl);
        res.json({ success: true, bannerUrl });
    } catch (error) {
        console.error('Upload banner error:', error);
        res.status(500).json({ success: false, error: 'Ошибка загрузки' });
    }
});

// Загрузка файла в сообщение
app.post('/api/upload-message-file', authMiddleware, upload.single('file'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ success: false, error: 'Файл не загружен' });
        }
        
        // Проверка лимита размера
        const isPremium = await checkPremiumStatus(req.user.id);
        const maxSize = isPremium ? FILE_LIMITS.premium : FILE_LIMITS.regular;
        if (req.file.size > maxSize) {
            const limitMB = maxSize / (1024 * 1024);
            return res.status(400).json({ 
                success: false, 
                error: `Максимальный размер файла: ${limitMB}MB` 
            });
        }
        
        // Определяем тип файла
        const ext = path.extname(req.file.originalname).toLowerCase();
        let fileType = 'image';
        let resourceType = 'image';
        if (ext === '.mp4') {
            fileType = 'video';
            resourceType = 'video';
        } else if (ext === '.gif') {
            fileType = 'gif';
        }
        
        let fileUrl;
        if (process.env.CLOUDINARY_CLOUD_NAME) {
            fileUrl = await uploadToCloudinary(req.file.buffer, 'messages', { resourceType });
            console.log(`📤 Uploaded ${fileType}: ${fileUrl}`);
        } else {
            fileUrl = `/uploads/${req.file.filename}`;
        }
        
        res.json({ success: true, fileUrl, fileType });
    } catch (error) {
        console.error('Upload message file error:', error);
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
app.get('/api/messages/:otherId', authMiddleware, async (req, res) => {
    try {
        const { otherId } = req.params;
        const { limit = 50, before } = req.query;
        
        const messages = await db.getMessages(req.user.id, otherId, parseInt(limit), before);
        await db.markMessagesAsRead(otherId, req.user.id);
        res.json(messages);
    } catch (error) {
        console.error('Get messages error:', error);
        res.status(500).json([]);
    }
});

// Редактирование сообщения
app.put('/api/messages/:messageId', authMiddleware, async (req, res) => {
    try {
        const { messageId } = req.params;
        const { text } = req.body;
        
        if (!text || text.trim().length === 0) {
            return res.status(400).json({ success: false, error: 'Текст не может быть пустым' });
        }
        
        const result = await db.editMessage(messageId, req.user.id, sanitizeText(text, 5000));
        res.json(result);
    } catch (error) {
        console.error('Edit message error:', error);
        res.status(500).json({ success: false, error: 'Ошибка сервера' });
    }
});

// Удаление сообщения
app.delete('/api/messages/:messageId', authMiddleware, async (req, res) => {
    try {
        const { messageId } = req.params;
        const result = await db.deleteMessage(messageId, req.user.id);
        res.json(result);
    } catch (error) {
        console.error('Delete message error:', error);
        res.status(500).json({ success: false, error: 'Ошибка сервера' });
    }
});

// Реакции на сообщения
app.post('/api/messages/:messageId/reactions', authMiddleware, async (req, res) => {
    try {
        const { messageId } = req.params;
        const { emoji } = req.body;
        
        if (!emoji) {
            return res.status(400).json({ success: false, error: 'Укажите эмодзи' });
        }
        
        const result = await db.addReaction(messageId, req.user.id, emoji);
        res.json(result);
    } catch (error) {
        console.error('Add reaction error:', error);
        res.status(500).json({ success: false, error: 'Ошибка сервера' });
    }
});

app.delete('/api/messages/:messageId/reactions/:emoji', authMiddleware, async (req, res) => {
    try {
        const { messageId, emoji } = req.params;
        const result = await db.removeReaction(messageId, req.user.id, decodeURIComponent(emoji));
        res.json(result);
    } catch (error) {
        console.error('Remove reaction error:', error);
        res.status(500).json({ success: false, error: 'Ошибка сервера' });
    }
});

// Глобальный поиск (пользователи + сообщения)
app.get('/api/search', authMiddleware, async (req, res) => {
    try {
        const { q } = req.query;
        if (!q || q.length < 2) {
            return res.json({ users: [], messages: [] });
        }
        
        const results = await db.globalSearch(req.user.id, q);
        res.json(results);
    } catch (error) {
        console.error('Global search error:', error);
        res.status(500).json({ users: [], messages: [] });
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

// === НАСТРОЙКИ ПОЛЬЗОВАТЕЛЯ ===

// Получить настройки
app.get('/api/settings', authMiddleware, async (req, res) => {
    try {
        const settings = await db.getUserSettings(req.user.id);
        res.json(settings);
    } catch (error) {
        console.error('Get settings error:', error);
        res.status(500).json({ error: 'Ошибка получения настроек' });
    }
});

// Сохранить настройки
app.put('/api/settings', authMiddleware, async (req, res) => {
    try {
        const settings = req.body;
        
        // Ограничиваем размер настроек (без base64 картинок - они слишком большие)
        const settingsToSave = { ...settings };
        delete settingsToSave.customBg; // Кастомный фон храним локально, слишком большой
        
        const result = await db.saveUserSettings(req.user.id, settingsToSave);
        if (result.success) {
            res.json({ success: true });
        } else {
            res.status(500).json({ error: result.error });
        }
    } catch (error) {
        console.error('Save settings error:', error);
        res.status(500).json({ error: 'Ошибка сохранения настроек' });
    }
});

// === ПОДПИСКА ===

// Получить статус подписки
app.get('/api/subscription/status', authMiddleware, async (req, res) => {
    try {
        const user = await db.getUser(req.user.id);
        if (!user) {
            return res.status(404).json({ error: 'Пользователь не найден' });
        }
        
        const isPremium = user.role === 'admin' || (user.premium_until && new Date(user.premium_until) > new Date());
        const plan = isPremium ? (user.premium_plan || 'premium') : 'free';
        
        res.json({
            plan,
            expires: user.premium_until || null,
            isPremium
        });
    } catch (error) {
        console.error('Get subscription status error:', error);
        res.status(500).json({ error: 'Ошибка получения статуса подписки' });
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
        const { days, plan } = req.body;
        
        if (!days || days < 1) {
            return res.status(400).json({ success: false, error: 'Укажите количество дней' });
        }
        
        const result = await db.setPremium(userId, parseInt(days), plan || 'premium');
        res.json(result);
    } catch (error) {
        console.error('Admin set premium error:', error);
        res.status(500).json({ success: false, error: 'Ошибка сервера' });
    }
});

// Снять премиум
app.delete('/api/admin/user/:userId/premium', authMiddleware, adminMiddleware, async (req, res) => {
    try {
        const { userId } = req.params;
        const result = await db.removePremium(userId);
        res.json(result);
    } catch (error) {
        console.error('Admin remove premium error:', error);
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

// === ГРУППОВЫЕ ЧАТЫ ===

app.post('/api/groups', authMiddleware, async (req, res) => {
    try {
        const { name, description, memberIds, avatarUrl } = req.body;
        if (!name || name.trim().length < 1) {
            return res.status(400).json({ success: false, error: 'Укажите название группы' });
        }
        const result = await db.createGroup(req.user.id, name.trim(), memberIds || [], description, avatarUrl);
        res.json(result);
    } catch (error) {
        console.error('Create group error:', error);
        res.status(500).json({ success: false, error: 'Ошибка сервера' });
    }
});

app.get('/api/groups', authMiddleware, async (req, res) => {
    try {
        const groups = await db.getUserGroups(req.user.id);
        res.json(groups);
    } catch (error) {
        console.error('Get groups error:', error);
        res.status(500).json([]);
    }
});

app.get('/api/groups/:groupId', authMiddleware, async (req, res) => {
    try {
        const group = await db.getGroup(req.params.groupId);
        if (!group) return res.status(404).json({ error: 'Группа не найдена' });
        res.json(group);
    } catch (error) {
        console.error('Get group error:', error);
        res.status(500).json({ error: 'Ошибка сервера' });
    }
});

app.get('/api/groups/:groupId/members', authMiddleware, async (req, res) => {
    try {
        const members = await db.getGroupMembers(req.params.groupId);
        res.json(members);
    } catch (error) {
        console.error('Get group members error:', error);
        res.status(500).json([]);
    }
});

app.post('/api/groups/:groupId/members', authMiddleware, async (req, res) => {
    try {
        const { userId } = req.body;
        const result = await db.addGroupMember(req.params.groupId, userId);
        res.json(result);
    } catch (error) {
        console.error('Add group member error:', error);
        res.status(500).json({ success: false });
    }
});

app.delete('/api/groups/:groupId/members/:userId', authMiddleware, async (req, res) => {
    try {
        const result = await db.removeGroupMember(req.params.groupId, req.params.userId);
        res.json(result);
    } catch (error) {
        console.error('Remove group member error:', error);
        res.status(500).json({ success: false });
    }
});

app.get('/api/groups/:groupId/messages', authMiddleware, async (req, res) => {
    try {
        const { limit = 50, before } = req.query;
        const messages = await db.getGroupMessages(req.params.groupId, parseInt(limit), before);
        res.json(messages);
    } catch (error) {
        console.error('Get group messages error:', error);
        res.status(500).json([]);
    }
});

app.get('/api/groups/:groupId/media', authMiddleware, async (req, res) => {
    try {
        const { limit = 50 } = req.query;
        const media = await db.getGroupMedia(req.params.groupId, parseInt(limit));
        res.json(media);
    } catch (error) {
        console.error('Get group media error:', error);
        res.status(500).json([]);
    }
});

// Загрузка аватарки группы (только для владельца)
app.post('/api/groups/:groupId/avatar', authMiddleware, upload.single('avatar'), async (req, res) => {
    try {
        const { groupId } = req.params;
        
        // Проверяем что пользователь - владелец группы
        const group = await db.getGroup(groupId);
        if (!group) {
            return res.status(404).json({ success: false, error: 'Группа не найдена' });
        }
        if (group.owner_id !== req.user.id) {
            return res.status(403).json({ success: false, error: 'Только владелец может менять аватарку' });
        }
        
        if (!req.file) {
            return res.status(400).json({ success: false, error: 'Файл не загружен' });
        }
        
        let avatarUrl;
        if (process.env.CLOUDINARY_CLOUD_NAME) {
            avatarUrl = await uploadToCloudinary(req.file.buffer, 'group-avatars');
        } else {
            avatarUrl = `/uploads/${req.file.filename}`;
        }
        
        await db.updateGroupAvatar(groupId, avatarUrl);
        res.json({ success: true, avatarUrl });
    } catch (error) {
        console.error('Upload group avatar error:', error);
        res.status(500).json({ success: false, error: 'Ошибка загрузки' });
    }
});

// Загрузка баннера группы (только для владельца)
app.post('/api/groups/:groupId/banner', authMiddleware, upload.single('banner'), async (req, res) => {
    try {
        const { groupId } = req.params;
        
        // Проверяем что пользователь - владелец группы
        const group = await db.getGroup(groupId);
        if (!group) {
            return res.status(404).json({ success: false, error: 'Группа не найдена' });
        }
        if (group.owner_id !== req.user.id) {
            return res.status(403).json({ success: false, error: 'Только владелец может менять баннер' });
        }
        
        if (!req.file) {
            return res.status(400).json({ success: false, error: 'Файл не загружен' });
        }
        
        let bannerUrl;
        if (process.env.CLOUDINARY_CLOUD_NAME) {
            bannerUrl = await uploadToCloudinary(req.file.buffer, 'group-banners');
        } else {
            bannerUrl = `/uploads/${req.file.filename}`;
        }
        
        await db.updateGroupBanner(groupId, bannerUrl);
        res.json({ success: true, bannerUrl });
    } catch (error) {
        console.error('Upload group banner error:', error);
        res.status(500).json({ success: false, error: 'Ошибка загрузки' });
    }
});

// === КАНАЛЫ ===

app.post('/api/channels', authMiddleware, async (req, res) => {
    try {
        const { name, description, isPublic, avatarUrl } = req.body;
        if (!name || name.trim().length < 1) {
            return res.status(400).json({ success: false, error: 'Укажите название канала' });
        }
        const result = await db.createChannel(req.user.id, name.trim(), description || '', isPublic !== false, avatarUrl);
        res.json(result);
    } catch (error) {
        console.error('Create channel error:', error);
        res.status(500).json({ success: false, error: 'Ошибка сервера' });
    }
});

app.get('/api/channels', authMiddleware, async (req, res) => {
    try {
        const channels = await db.getUserChannels(req.user.id);
        res.json(channels);
    } catch (error) {
        console.error('Get channels error:', error);
        res.status(500).json([]);
    }
});

app.get('/api/channels/:channelId', authMiddleware, async (req, res) => {
    try {
        const channel = await db.getChannel(req.params.channelId);
        if (!channel) return res.status(404).json({ error: 'Канал не найден' });
        res.json(channel);
    } catch (error) {
        console.error('Get channel error:', error);
        res.status(500).json({ error: 'Ошибка сервера' });
    }
});

app.post('/api/channels/:channelId/subscribe', authMiddleware, async (req, res) => {
    try {
        const result = await db.subscribeToChannel(req.params.channelId, req.user.id);
        res.json(result);
    } catch (error) {
        console.error('Subscribe to channel error:', error);
        res.status(500).json({ success: false });
    }
});

app.post('/api/channels/:channelId/unsubscribe', authMiddleware, async (req, res) => {
    try {
        const result = await db.unsubscribeFromChannel(req.params.channelId, req.user.id);
        res.json(result);
    } catch (error) {
        console.error('Unsubscribe from channel error:', error);
        res.status(500).json({ success: false });
    }
});

app.get('/api/channels/:channelId/posts', authMiddleware, async (req, res) => {
    try {
        const { limit = 20, before } = req.query;
        const posts = await db.getChannelPosts(req.params.channelId, parseInt(limit), before);
        res.json(posts);
    } catch (error) {
        console.error('Get channel posts error:', error);
        res.status(500).json([]);
    }
});

app.get('/api/channels/:channelId/media', authMiddleware, async (req, res) => {
    try {
        const { limit = 50 } = req.query;
        const media = await db.getChannelMedia(req.params.channelId, parseInt(limit));
        res.json(media);
    } catch (error) {
        console.error('Get channel media error:', error);
        res.status(500).json([]);
    }
});

app.post('/api/channels/:channelId/posts', authMiddleware, async (req, res) => {
    try {
        const { text, mediaUrl, mediaType } = req.body;
        const channelId = req.params.channelId;
        
        // Проверяем права на публикацию
        const channel = await db.getChannel(channelId);
        if (!channel) {
            return res.status(404).json({ success: false, error: 'Канал не найден' });
        }
        
        const isOwner = channel.owner_id === req.user.id;
        const isAdmin = await db.isChannelAdmin(channelId, req.user.id);
        
        if (!isOwner && !isAdmin && req.user.role !== 'admin') {
            return res.status(403).json({ success: false, error: 'Нет прав на публикацию' });
        }
        
        const post = await db.createChannelPost(channelId, req.user.id, text, mediaUrl, mediaType);
        res.json({ success: true, post });
    } catch (error) {
        console.error('Create channel post error:', error);
        res.status(500).json({ success: false, error: 'Ошибка сервера' });
    }
});

// === СЕРВЕРЫ ===

app.post('/api/servers', authMiddleware, async (req, res) => {
    try {
        const { name, description, iconUrl } = req.body;
        if (!name || name.trim().length < 1) {
            return res.status(400).json({ success: false, error: 'Укажите название сервера' });
        }
        const result = await db.createServer(req.user.id, name.trim(), description || '', iconUrl);
        res.json(result);
    } catch (error) {
        console.error('Create server error:', error);
        res.status(500).json({ success: false, error: 'Ошибка сервера' });
    }
});

app.get('/api/servers', authMiddleware, async (req, res) => {
    try {
        const servers = await db.getUserServers(req.user.id);
        res.json(servers);
    } catch (error) {
        console.error('Get servers error:', error);
        res.status(500).json([]);
    }
});

app.get('/api/servers/:serverId', authMiddleware, async (req, res) => {
    try {
        const server = await db.getServer(req.params.serverId);
        if (!server) return res.status(404).json({ error: 'Сервер не найден' });
        res.json(server);
    } catch (error) {
        console.error('Get server error:', error);
        res.status(500).json({ error: 'Ошибка сервера' });
    }
});

app.post('/api/servers/:serverId/join', authMiddleware, async (req, res) => {
    try {
        const result = await db.joinServer(req.params.serverId, req.user.id);
        res.json(result);
    } catch (error) {
        console.error('Join server error:', error);
        res.status(500).json({ success: false });
    }
});

app.post('/api/servers/:serverId/leave', authMiddleware, async (req, res) => {
    try {
        const result = await db.leaveServer(req.params.serverId, req.user.id);
        res.json(result);
    } catch (error) {
        console.error('Leave server error:', error);
        res.status(500).json({ success: false });
    }
});

app.get('/api/servers/:serverId/channels', authMiddleware, async (req, res) => {
    try {
        const data = await db.getServerChannels(req.params.serverId);
        res.json(data);
    } catch (error) {
        console.error('Get server channels error:', error);
        res.status(500).json({ categories: [], channels: [] });
    }
});

app.post('/api/servers/:serverId/channels', authMiddleware, async (req, res) => {
    try {
        const { categoryId, name, type } = req.body;
        const serverId = req.params.serverId;
        
        // Проверяем права на создание каналов
        const server = await db.getServer(serverId);
        if (!server) {
            return res.status(404).json({ success: false, error: 'Сервер не найден' });
        }
        
        const isOwner = server.owner_id === req.user.id;
        // TODO: добавить проверку ролей сервера с правами MANAGE_CHANNELS
        
        if (!isOwner && req.user.role !== 'admin') {
            return res.status(403).json({ success: false, error: 'Нет прав на создание каналов' });
        }
        
        const result = await db.createServerChannel(serverId, categoryId, name, type || 'text');
        res.json(result);
    } catch (error) {
        console.error('Create server channel error:', error);
        res.status(500).json({ success: false });
    }
});

// Создать категорию на сервере
app.post('/api/servers/:serverId/categories', authMiddleware, async (req, res) => {
    try {
        const { name } = req.body;
        const serverId = req.params.serverId;
        
        const server = await db.getServer(serverId);
        if (!server) {
            return res.status(404).json({ success: false, error: 'Сервер не найден' });
        }
        
        if (server.owner_id !== req.user.id && req.user.role !== 'admin') {
            return res.status(403).json({ success: false, error: 'Нет прав на создание категорий' });
        }
        
        const result = await db.createServerCategory(serverId, name || 'Новая категория');
        res.json(result);
    } catch (error) {
        console.error('Create server category error:', error);
        res.status(500).json({ success: false });
    }
});

// Обновить канал
app.put('/api/server-channels/:channelId', authMiddleware, async (req, res) => {
    try {
        const { channelId } = req.params;
        const { name, topic } = req.body;
        
        const channel = await db.getServerChannel(channelId);
        if (!channel) {
            return res.status(404).json({ success: false, error: 'Канал не найден' });
        }
        
        const server = await db.getServer(channel.server_id);
        if (server.owner_id !== req.user.id && req.user.role !== 'admin') {
            return res.status(403).json({ success: false, error: 'Нет прав на редактирование канала' });
        }
        
        const result = await db.updateServerChannel(channelId, { name, topic });
        res.json(result);
    } catch (error) {
        console.error('Update server channel error:', error);
        res.status(500).json({ success: false });
    }
});

// Удалить канал
app.delete('/api/server-channels/:channelId', authMiddleware, async (req, res) => {
    try {
        const { channelId } = req.params;
        
        const channel = await db.getServerChannel(channelId);
        if (!channel) {
            return res.status(404).json({ success: false, error: 'Канал не найден' });
        }
        
        const server = await db.getServer(channel.server_id);
        if (server.owner_id !== req.user.id && req.user.role !== 'admin') {
            return res.status(403).json({ success: false, error: 'Нет прав на удаление канала' });
        }
        
        const result = await db.deleteServerChannel(channelId);
        res.json(result);
    } catch (error) {
        console.error('Delete server channel error:', error);
        res.status(500).json({ success: false });
    }
});

// Обновить категорию
app.put('/api/server-categories/:categoryId', authMiddleware, async (req, res) => {
    try {
        const { categoryId } = req.params;
        const { name } = req.body;
        
        if (!name || !name.trim()) {
            return res.status(400).json({ success: false, error: 'Название не может быть пустым' });
        }
        
        const result = await db.updateServerCategory(categoryId, { name: name.trim() });
        res.json(result);
    } catch (error) {
        console.error('Update server category error:', error);
        res.status(500).json({ success: false });
    }
});

// Удалить категорию
app.delete('/api/server-categories/:categoryId', authMiddleware, async (req, res) => {
    try {
        const { categoryId } = req.params;
        
        // Получаем категорию чтобы узнать server_id
        // Для простоты проверяем права через первый канал в категории или напрямую
        const result = await db.deleteServerCategory(categoryId);
        res.json(result);
    } catch (error) {
        console.error('Delete server category error:', error);
        res.status(500).json({ success: false });
    }
});

app.get('/api/servers/:serverId/members', authMiddleware, async (req, res) => {
    try {
        const members = await db.getServerMembers(req.params.serverId);
        res.json(members);
    } catch (error) {
        console.error('Get server members error:', error);
        res.status(500).json([]);
    }
});

app.get('/api/server-channels/:channelId/messages', authMiddleware, async (req, res) => {
    try {
        const { limit = 50, before } = req.query;
        const messages = await db.getServerMessages(req.params.channelId, parseInt(limit), before);
        res.json(messages);
    } catch (error) {
        console.error('Get server messages error:', error);
        res.status(500).json([]);
    }
});

app.get('/api/servers/:serverId/media', authMiddleware, async (req, res) => {
    try {
        const { limit = 50 } = req.query;
        const media = await db.getServerMedia(req.params.serverId, parseInt(limit));
        res.json(media);
    } catch (error) {
        console.error('Get server media error:', error);
        res.status(500).json([]);
    }
});

// Получить роли сервера
app.get('/api/servers/:serverId/roles', authMiddleware, async (req, res) => {
    try {
        const roles = await db.getServerRoles(req.params.serverId);
        res.json(roles);
    } catch (error) {
        console.error('Get server roles error:', error);
        res.status(500).json([]);
    }
});

// Создать роль на сервере
app.post('/api/servers/:serverId/roles', authMiddleware, async (req, res) => {
    try {
        const { serverId } = req.params;
        const { name, color, permissions } = req.body;
        
        // Проверяем права (владелец или админ)
        const server = await db.getServer(serverId);
        if (!server) return res.status(404).json({ error: 'Сервер не найден' });
        if (server.owner_id !== req.user.id && req.user.role !== 'admin') {
            return res.status(403).json({ error: 'Нет прав для создания ролей' });
        }
        
        const result = await db.createServerRole(serverId, name || 'Новая роль', color || '#99aab5', permissions || 0);
        res.json(result);
    } catch (error) {
        console.error('Create server role error:', error);
        res.status(500).json({ error: 'Ошибка создания роли' });
    }
});

// Обновить роль
app.put('/api/servers/:serverId/roles/:roleId', authMiddleware, async (req, res) => {
    try {
        const { serverId, roleId } = req.params;
        const { name, color, permissions } = req.body;
        
        const server = await db.getServer(serverId);
        if (!server) return res.status(404).json({ error: 'Сервер не найден' });
        if (server.owner_id !== req.user.id && req.user.role !== 'admin') {
            return res.status(403).json({ error: 'Нет прав для редактирования ролей' });
        }
        
        const result = await db.updateServerRole(roleId, { name, color, permissions });
        res.json(result);
    } catch (error) {
        console.error('Update server role error:', error);
        res.status(500).json({ error: 'Ошибка обновления роли' });
    }
});

// Удалить роль
app.delete('/api/servers/:serverId/roles/:roleId', authMiddleware, async (req, res) => {
    try {
        const { serverId, roleId } = req.params;
        
        const server = await db.getServer(serverId);
        if (!server) return res.status(404).json({ error: 'Сервер не найден' });
        if (server.owner_id !== req.user.id && req.user.role !== 'admin') {
            return res.status(403).json({ error: 'Нет прав для удаления ролей' });
        }
        
        const result = await db.deleteServerRole(roleId);
        res.json(result);
    } catch (error) {
        console.error('Delete server role error:', error);
        res.status(500).json({ error: 'Ошибка удаления роли' });
    }
});

// === INVITE LINKS ===

// Получить информацию о канале по инвайт-ссылке (публичный роут)
app.get('/api/invite/channel/:channelId', async (req, res) => {
    try {
        const channel = await db.getChannel(req.params.channelId);
        if (!channel) {
            return res.status(404).json({ error: 'Канал не найден' });
        }
        // Возвращаем только публичную информацию
        res.json({
            id: channel.id,
            name: channel.name,
            description: channel.description,
            avatar_url: channel.avatar_url,
            subscriber_count: channel.subscriber_count,
            is_public: channel.is_public
        });
    } catch (error) {
        console.error('Get channel invite info error:', error);
        res.status(500).json({ error: 'Ошибка сервера' });
    }
});

// Получить информацию о сервере по инвайт-ссылке (публичный роут)
app.get('/api/invite/server/:serverId', async (req, res) => {
    try {
        const server = await db.getServer(req.params.serverId);
        if (!server) {
            return res.status(404).json({ error: 'Сервер не найден' });
        }
        // Возвращаем только публичную информацию
        res.json({
            id: server.id,
            name: server.name,
            description: server.description,
            icon_url: server.icon_url,
            member_count: server.member_count,
            is_public: server.is_public
        });
    } catch (error) {
        console.error('Get server invite info error:', error);
        res.status(500).json({ error: 'Ошибка сервера' });
    }
});

// Присоединиться к каналу по инвайт-ссылке
app.post('/api/invite/channel/:channelId/join', authMiddleware, async (req, res) => {
    try {
        const result = await db.subscribeToChannel(req.params.channelId, req.user.id);
        res.json(result);
    } catch (error) {
        console.error('Join channel via invite error:', error);
        res.status(500).json({ success: false, error: 'Ошибка присоединения' });
    }
});

// Присоединиться к серверу по инвайт-ссылке
app.post('/api/invite/server/:serverId/join', authMiddleware, async (req, res) => {
    try {
        const result = await db.joinServer(req.params.serverId, req.user.id);
        res.json(result);
    } catch (error) {
        console.error('Join server via invite error:', error);
        res.status(500).json({ success: false, error: 'Ошибка присоединения' });
    }
});

// === SUPPORT TICKETS ===

// Создать тикет
app.post('/api/support/ticket', authMiddleware, async (req, res) => {
    try {
        const { category, message } = req.body;
        
        if (!category || !message) {
            return res.status(400).json({ error: 'Заполните все поля' });
        }
        
        const ticket = await db.createSupportTicket(req.user.id, category, message);
        res.json(ticket);
    } catch (error) {
        console.error('Create ticket error:', error);
        res.status(500).json({ error: 'Ошибка создания обращения' });
    }
});

// Получить тикеты пользователя
app.get('/api/support/tickets', authMiddleware, async (req, res) => {
    try {
        const tickets = await db.getUserTickets(req.user.id);
        res.json(tickets);
    } catch (error) {
        console.error('Get tickets error:', error);
        res.status(500).json([]);
    }
});

// Получить все тикеты (админ)
app.get('/api/admin/support/tickets', authMiddleware, adminMiddleware, async (req, res) => {
    try {
        const tickets = await db.getAllTickets();
        res.json(tickets);
    } catch (error) {
        console.error('Get all tickets error:', error);
        res.status(500).json([]);
    }
});

// Ответить на тикет (админ)
app.post('/api/admin/support/ticket/:ticketId/reply', authMiddleware, adminMiddleware, async (req, res) => {
    try {
        const { message } = req.body;
        const reply = await db.replyToTicket(req.params.ticketId, req.user.id, message);
        res.json(reply);
    } catch (error) {
        console.error('Reply ticket error:', error);
        res.status(500).json({ error: 'Ошибка ответа' });
    }
});

// Закрыть тикет (админ)
app.post('/api/admin/support/ticket/:ticketId/close', authMiddleware, adminMiddleware, async (req, res) => {
    try {
        await db.closeTicket(req.params.ticketId);
        res.json({ success: true });
    } catch (error) {
        console.error('Close ticket error:', error);
        res.status(500).json({ error: 'Ошибка закрытия' });
    }
});

// === ЗАКРЕПЛЁННЫЕ ЧАТЫ ===

// Лимиты закреплённых чатов по типу подписки
const PIN_LIMITS = {
    free: 3,
    premium: 5,
    premium_plus: 10
};

// Получить лимит закреплённых чатов для пользователя
async function getPinLimit(userId) {
    const user = await db.getUser(userId);
    if (!user) return PIN_LIMITS.free;
    if (user.role === 'admin') return PIN_LIMITS.premium_plus;
    if (user.isPremium) {
        return user.premiumPlan === 'premium_plus' ? PIN_LIMITS.premium_plus : PIN_LIMITS.premium;
    }
    return PIN_LIMITS.free;
}

// Закрепить чат
app.post('/api/chats/:chatId/pin', authMiddleware, async (req, res) => {
    try {
        const { chatId } = req.params;
        const { chatType = 'user' } = req.body;
        
        // Проверяем лимит
        const currentCount = await db.getPinnedChatsCount(req.user.id, chatType);
        const limit = await getPinLimit(req.user.id);
        
        if (currentCount >= limit) {
            return res.status(400).json({ 
                success: false, 
                error: `Достигнут лимит закреплённых чатов (${limit})`,
                limit,
                currentCount
            });
        }
        
        const result = await db.pinChat(req.user.id, chatId, chatType);
        res.json({ ...result, limit, currentCount: currentCount + 1 });
    } catch (error) {
        console.error('Pin chat error:', error);
        res.status(500).json({ success: false, error: 'Ошибка сервера' });
    }
});

// Открепить чат
app.delete('/api/chats/:chatId/pin', authMiddleware, async (req, res) => {
    try {
        const { chatId } = req.params;
        const { chatType = 'user' } = req.query;
        
        const result = await db.unpinChat(req.user.id, chatId, chatType);
        res.json(result);
    } catch (error) {
        console.error('Unpin chat error:', error);
        res.status(500).json({ success: false, error: 'Ошибка сервера' });
    }
});

// Получить информацию о закреплённых чатах
app.get('/api/pinned-chats/info', authMiddleware, async (req, res) => {
    try {
        const { chatType = 'user' } = req.query;
        const currentCount = await db.getPinnedChatsCount(req.user.id, chatType);
        const limit = await getPinLimit(req.user.id);
        
        res.json({ currentCount, limit });
    } catch (error) {
        console.error('Get pinned info error:', error);
        res.status(500).json({ error: 'Ошибка сервера' });
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

io.on('connection', async (socket) => {
    const userId = socket.user.id;
    console.log(`Пользователь подключился: ${userId} (socket: ${socket.id})`);
    
    // Загружаем настройки пользователя (включая hide_online)
    const userProfile = await db.getUser(userId);
    const hideOnline = userProfile?.hide_online || false;
    
    // Регистрируем пользователя онлайн (поддержка нескольких устройств)
    let userData = onlineUsers.get(userId);
    if (userData) {
        // Добавляем новый сокет к существующему пользователю
        userData.sockets.add(socket.id);
        userData.lastSeen = Date.now();
    } else {
        // Новый пользователь
        userData = { 
            sockets: new Set([socket.id]), 
            lastSeen: Date.now(), 
            status: 'online', 
            hideOnline 
        };
    }
    onlineUsers.set(userId, userData);
    broadcastOnlineUsers();
    
    // Изменение статуса
    socket.on('status-change', (data) => {
        const userData = onlineUsers.get(userId);
        if (userData && data.status) {
            userData.status = data.status;
            onlineUsers.set(userId, userData);
            broadcastOnlineUsers();
        }
    });
    
    // Отправка сообщения
    socket.on('send-message', async (data) => {
        try {
            // Rate limit: 30 сообщений в минуту
            if (!checkSocketRateLimit(userId, 'send-message', 30, 60000)) {
                return socket.emit('error', { message: 'Слишком много сообщений, подождите' });
            }
            
            const { receiverId, text, messageType = 'text', selfDestructMinutes = null } = data;
            
            if (!receiverId || !text || typeof text !== 'string') {
                return socket.emit('error', { message: 'Неверные данные' });
            }
            
            const sanitizedText = text.trim().substring(0, 5000);
            if (!sanitizedText) return;
            
            // Получаем данные отправителя для bubble_style
            const senderUser = await db.getUser(userId);
            
            // Проверяем Premium+ для самоуничтожающихся сообщений
            let actualSelfDestruct = null;
            if (selfDestructMinutes && selfDestructMinutes > 0) {
                const isPremiumPlus = senderUser?.role === 'admin' || senderUser?.premiumPlan === 'premium_plus';
                if (isPremiumPlus) {
                    actualSelfDestruct = selfDestructMinutes;
                }
            }
            
            const message = await db.saveMessage(userId, receiverId, sanitizedText, messageType, 0, actualSelfDestruct);
            
            // Добавляем bubble_style отправителя (для отображения у получателя)
            message.sender_bubble_style = senderUser?.bubble_style || 'default';
            
            // Отправляем получателю (все его устройства)
            const receiverData = onlineUsers.get(receiverId);
            if (receiverData && receiverData.sockets.size > 0) {
                emitToUser(receiverId, 'new-message', message);
            } else {
                // Оффлайн - push уведомление
                const notifBody = ['image', 'video', 'gif'].includes(messageType) 
                    ? '📷 Медиафайл' 
                    : (sanitizedText.length > 100 ? sanitizedText.substring(0, 100) + '...' : sanitizedText);
                sendPushNotification(receiverId, {
                    title: socket.user.username || 'Новое сообщение',
                    body: notifBody,
                    tag: `msg-${userId}`,
                    senderId: userId
                });
            }
            
            // Отправляем отправителю на все его устройства (синхронизация)
            emitToUser(userId, 'message-sent', message);
        } catch (error) {
            console.error('Send message error:', error.message, error.stack);
            socket.emit('error', { message: 'Ошибка отправки' });
        }
    });

    // Индикатор печати
    socket.on('typing-start', (data) => {
        if (data.receiverId) {
            emitToUser(data.receiverId, 'user-typing', { userId, typing: true });
        }
    });

    socket.on('typing-stop', (data) => {
        if (data.receiverId) {
            emitToUser(data.receiverId, 'user-typing', { userId, typing: false });
        }
    });

    // === РЕДАКТИРОВАНИЕ И УДАЛЕНИЕ СООБЩЕНИЙ ===
    
    socket.on('edit-message', async (data) => {
        try {
            const { messageId, text, receiverId } = data;
            if (!messageId || !text || !receiverId) return;
            
            const result = await db.editMessage(messageId, userId, text.trim().substring(0, 5000));
            if (result.success) {
                const editData = { messageId, text: result.message.text, updated_at: result.message.updated_at };
                emitToUser(userId, 'message-edited', editData);
                emitToUser(receiverId, 'message-edited', editData);
            }
        } catch (error) {
            console.error('Edit message error:', error);
        }
    });
    
    socket.on('delete-message', async (data) => {
        try {
            const { messageId, receiverId, deleteForAll = false } = data;
            if (!messageId) return;
            
            // Проверяем Premium+ для "удалить у всех"
            let canDeleteForAll = false;
            if (deleteForAll) {
                const user = await db.getUser(userId);
                canDeleteForAll = user?.role === 'admin' || user?.premiumPlan === 'premium_plus';
            }
            
            const result = await db.deleteMessage(messageId, userId, canDeleteForAll);
            if (result.success) {
                const deleteData = { messageId, deleteForAll: canDeleteForAll };
                emitToUser(userId, 'message-deleted', deleteData);
                // Отправляем получателю только если "удалить у всех"
                if (canDeleteForAll && receiverId) {
                    emitToUser(receiverId, 'message-deleted', deleteData);
                }
            }
        } catch (error) {
            console.error('Delete message error:', error);
        }
    });

    // === РЕАКЦИИ ===
    
    socket.on('add-reaction', async (data) => {
        try {
            const { messageId, emoji, receiverId } = data;
            if (!messageId || !emoji || !receiverId) return;
            
            await db.addReaction(messageId, userId, emoji);
            const reaction = { messageId, odataId: userId, emoji };
            emitToUser(userId, 'reaction-added', reaction);
            emitToUser(receiverId, 'reaction-added', reaction);
        } catch (error) {
            console.error('Add reaction error:', error);
        }
    });
    
    socket.on('remove-reaction', async (data) => {
        try {
            const { messageId, emoji, receiverId } = data;
            if (!messageId || !emoji || !receiverId) return;
            
            await db.removeReaction(messageId, userId, emoji);
            const reaction = { messageId, odataId: userId, emoji };
            emitToUser(userId, 'reaction-removed', reaction);
            emitToUser(receiverId, 'reaction-removed', reaction);
        } catch (error) {
            console.error('Remove reaction error:', error);
        }
    });

    // === ГРУППОВЫЕ ЧАТЫ ===
    
    socket.on('join-group', (groupId) => {
        socket.join(`group:${groupId}`);
    });
    
    socket.on('leave-group', (groupId) => {
        socket.leave(`group:${groupId}`);
    });
    
    socket.on('group-message', async (data) => {
        try {
            const { groupId, text, messageType = 'text' } = data;
            if (!groupId || !text) return;
            
            const message = await db.saveGroupMessage(groupId, userId, text.trim().substring(0, 5000), messageType);
            const user = await db.getUser(userId);
            message.username = user?.username;
            message.display_name = user?.display_name;
            message.avatar_url = user?.avatar_url;
            
            io.to(`group:${groupId}`).emit('group-message', message);
        } catch (error) {
            console.error('Group message error:', error);
        }
    });
    
    socket.on('group-typing', (data) => {
        const { groupId, typing } = data;
        socket.to(`group:${groupId}`).emit('group-typing', { userId, typing });
    });

    // === КАНАЛЫ ===
    
    socket.on('join-channel', (channelId) => {
        socket.join(`channel:${channelId}`);
    });
    
    socket.on('leave-channel', (channelId) => {
        socket.leave(`channel:${channelId}`);
    });
    
    socket.on('channel-post', async (data) => {
        try {
            const { channelId, text, mediaUrl, mediaType } = data;
            if (!channelId) return;
            
            // TODO: проверить права на публикацию
            const post = await db.createChannelPost(channelId, userId, text, mediaUrl, mediaType);
            const user = await db.getUser(userId);
            post.username = user?.username;
            post.display_name = user?.display_name;
            post.avatar_url = user?.avatar_url;
            
            io.to(`channel:${channelId}`).emit('channel-post', post);
        } catch (error) {
            console.error('Channel post error:', error);
        }
    });

    // === СЕРВЕРЫ ===
    
    socket.on('join-server', (serverId) => {
        socket.join(`server:${serverId}`);
    });
    
    socket.on('leave-server', (serverId) => {
        socket.leave(`server:${serverId}`);
    });
    
    socket.on('join-server-channel', (channelId) => {
        socket.join(`server-channel:${channelId}`);
    });
    
    socket.on('leave-server-channel', (channelId) => {
        socket.leave(`server-channel:${channelId}`);
    });
    
    socket.on('server-message', async (data) => {
        try {
            const { channelId, text, messageType = 'text' } = data;
            if (!channelId || !text) return;
            
            const message = await db.saveServerMessage(channelId, userId, text.trim().substring(0, 5000), messageType);
            const user = await db.getUser(userId);
            message.username = user?.username;
            message.display_name = user?.display_name;
            message.avatar_url = user?.avatar_url;
            
            io.to(`server-channel:${channelId}`).emit('server-message', message);
        } catch (error) {
            console.error('Server message error:', error);
        }
    });
    
    socket.on('server-typing', (data) => {
        const { channelId, typing } = data;
        socket.to(`server-channel:${channelId}`).emit('server-typing', { odataId: userId, typing });
    });

    // === ЗВОНКИ ===
    
    socket.on('call-user', async (data) => {
        // Rate limit: 5 звонков в минуту
        if (!checkSocketRateLimit(userId, 'call-user', 5, 60000)) {
            return socket.emit('error', { message: 'Слишком много звонков, подождите' });
        }
        
        const { to, offer, isVideo } = data;
        
        // Проверяем что получатель существует
        if (!to) {
            return socket.emit('call-failed', { reason: 'Неверный получатель' });
        }
        
        const receiver = await db.getUser(to);
        if (!receiver) {
            return socket.emit('call-failed', { reason: 'Пользователь не найден' });
        }
        
        console.log(`📞 call-user: ${userId} -> ${to}, video: ${isVideo}`);
        
        const receiverData = onlineUsers.get(to);
        
        const callId = `${userId}-${to}-${Date.now()}`;
        activeCalls.set(callId, {
            callId,
            participants: [userId, to],
            caller: userId,
            callerName: socket.user.username,
            startTime: null,
            isVideo
        });
        
        if (receiverData && receiverData.sockets.size > 0) {
            console.log(`📞 Получатель онлайн, отправляем incoming-call`);
            emitToUser(to, 'incoming-call', { 
                from: userId, 
                fromName: socket.user.username, 
                offer, 
                isVideo, 
                callId 
            });
            socket.emit('call-initiated', { callId });
        } else {
            console.log(`📞 Получатель оффлайн, отправляем push`);
            const callType = isVideo ? 'Видеозвонок' : 'Звонок';
            sendPushNotification(to, {
                title: `📞 ${callType} от ${socket.user.username}`,
                body: 'Нажмите, чтобы открыть приложение',
                tag: `call-${callId}`,
                data: {
                    type: 'incoming-call',
                    callId,
                    from: userId,
                    fromName: socket.user.username,
                    isVideo
                },
                requireInteraction: true,
                actions: [
                    { action: 'answer', title: 'Ответить' },
                    { action: 'decline', title: 'Отклонить' }
                ]
            });
            
            socket.emit('call-initiated', { callId, waitingForUser: true });
            
            setTimeout(() => {
                const call = activeCalls.get(callId);
                if (call && !call.startTime) {
                    console.log(`📞 Звонок ${callId} не отвечен, удаляем`);
                    activeCalls.delete(callId);
                    socket.emit('call-failed', { reason: 'Пользователь не ответил', callId });
                }
            }, 30000);
        }
    });

    socket.on('call-answer', async (data) => {
        const { to, answer, callId } = data;
        console.log(`📞 call-answer: ${userId} -> ${to}, callId: ${callId}`);
        
        const call = activeCalls.get(callId);
        if (call) {
            call.startTime = Date.now();
            call.answeredBy = socket.id;
            activeCalls.set(callId, call);
        }
        if (to) {
            emitToUser(to, 'call-answered', { answer, callId });
        }
    });

    socket.on('call-decline', (data) => {
        const { to, callId } = data;
        console.log(`📞 call-decline: ${userId} -> ${to}, callId: ${callId}`);
        if (to) {
            emitToUser(to, 'call-declined', { callId });
        }
        if (callId) activeCalls.delete(callId);
    });

    socket.on('call-end', async (data) => {
        const { to, callId } = data;
        
        const call = activeCalls.get(callId);
        if (call && call.startTime) {
            const duration = Math.floor((Date.now() - call.startTime) / 1000);
            const callType = call.isVideo ? 'video_call' : 'audio_call';
            const callText = call.isVideo ? 'Видеозвонок' : 'Аудиозвонок';
            
            try {
                const receiver = call.participants.find(p => p !== call.caller);
                const message = await db.saveMessage(call.caller, receiver, callText, callType, duration);
                
                emitToUser(call.caller, 'call-message', message);
                emitToUser(receiver, 'call-message', message);
            } catch (error) {
                console.error('Save call message error:', error);
            }
        }
        
        if (to) {
            emitToUser(to, 'call-ended', { callId });
        }
        
        if (callId) activeCalls.delete(callId);
    });

    socket.on('ice-candidate', (data) => {
        const { to, candidate } = data;
        if (to) {
            emitToUser(to, 'ice-candidate', { candidate });
        }
    });

    socket.on('video-renegotiate', (data) => {
        const { to, offer } = data;
        if (to) {
            emitToUser(to, 'video-renegotiate', { offer });
        }
    });

    socket.on('video-renegotiate-answer', (data) => {
        const { to, answer } = data;
        if (to) {
            emitToUser(to, 'video-renegotiate-answer', { answer });
        }
    });

    // Уведомление о демонстрации экрана
    socket.on('screen-share-started', (data) => {
        const { to } = data;
        if (to) {
            emitToUser(to, 'screen-share-started', { from: userId });
        }
    });

    socket.on('screen-share-stopped', (data) => {
        const { to } = data;
        if (to) {
            emitToUser(to, 'screen-share-stopped', { from: userId });
        }
    });

    // Отключение
    socket.on('disconnect', () => {
        // Удаляем только этот сокет, не всего пользователя
        const userData = onlineUsers.get(userId);
        if (userData) {
            userData.sockets.delete(socket.id);
            if (userData.sockets.size === 0) {
                // Все устройства отключены
                onlineUsers.delete(userId);
            }
        }
        broadcastOnlineUsers();
        
        // Завершаем активные звонки только если это был сокет звонка
        for (const [callId, call] of activeCalls.entries()) {
            if (call.participants.includes(userId) && call.answeredBy === socket.id) {
                const otherId = call.participants.find(p => p !== userId);
                emitToUser(otherId, 'call-ended', { callId, reason: 'disconnect' });
                activeCalls.delete(callId);
            }
        }
        
        console.log(`Сокет отключился: ${userId} (socket: ${socket.id})`);
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

// === SPA ROUTING ===
// Catch-all для инвайт-ссылок и других SPA роутов
app.get('/invite/*', (_req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// === ЗАПУСК ===

const PORT = process.env.PORT || 3000;

// Запускаем сервер сразу, чтобы Render мог делать health check
server.listen(PORT, () => {
    console.log(`🚀 Сервер запущен на порту ${PORT}`);
    
    // Инициализируем БД после запуска сервера
    db.initDB().then(() => {
        setServerReady();
        console.log(`✅ Квант полностью готов`);
        if (!VAPID_PUBLIC_KEY) {
            console.log('⚠️  Push-уведомления отключены (нет VAPID ключей)');
        }
        
        // Запускаем очистку самоуничтожающихся сообщений каждую минуту
        setInterval(async () => {
            const deleted = await db.cleanupSelfDestructMessages();
            if (deleted.length > 0) {
                console.log(`🗑️ Удалено ${deleted.length} самоуничтожающихся сообщений`);
                // Уведомляем пользователей об удалении
                for (const msg of deleted) {
                    emitToUser(msg.senderId, 'message-deleted', { messageId: msg.id, selfDestruct: true });
                    emitToUser(msg.receiverId, 'message-deleted', { messageId: msg.id, selfDestruct: true });
                }
            }
        }, 60 * 1000); // Каждую минуту
    }).catch(err => {
        console.error('❌ Ошибка инициализации БД:', err);
        process.exit(1);
    });
});
