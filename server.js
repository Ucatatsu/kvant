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
        const allowedTypes = /jpeg|jpg|png|gif|webp|mp4/;
        const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
        const mimetype = /image\/(jpeg|jpg|png|gif|webp)|video\/mp4/.test(file.mimetype);
        if (extname && mimetype) {
            cb(null, true);
        } else {
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
        
        const { name_color, profile_theme, profile_color, custom_id, hide_online } = req.body;
        
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
        
        let fileUrl;
        if (process.env.CLOUDINARY_CLOUD_NAME) {
            fileUrl = await uploadToCloudinary(req.file.buffer, 'messages');
        } else {
            fileUrl = `/uploads/${req.file.filename}`;
        }
        
        // Определяем тип файла
        const ext = path.extname(req.file.originalname).toLowerCase();
        let fileType = 'image';
        if (ext === '.mp4') fileType = 'video';
        else if (ext === '.gif') fileType = 'gif';
        
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
            const { receiverId, text, messageType = 'text' } = data;
            
            if (!receiverId || !text || typeof text !== 'string') {
                return socket.emit('error', { message: 'Неверные данные' });
            }
            
            const sanitizedText = text.trim().substring(0, 5000);
            if (!sanitizedText) return;
            
            const message = await db.saveMessage(userId, receiverId, sanitizedText, messageType);
            
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
            console.error('Send message error:', error);
            socket.emit('error', { message: 'Ошибка отправки' });
        }
    });

    // Индикатор печати
    socket.on('typing-start', (data) => {
        emitToUser(data.receiverId, 'user-typing', { userId, typing: true });
    });

    socket.on('typing-stop', (data) => {
        emitToUser(data.receiverId, 'user-typing', { userId, typing: false });
    });

    // === РЕДАКТИРОВАНИЕ И УДАЛЕНИЕ СООБЩЕНИЙ ===
    
    socket.on('edit-message', async (data) => {
        try {
            const { messageId, text, receiverId } = data;
            if (!messageId || !text) return;
            
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
            const { messageId, receiverId } = data;
            if (!messageId) return;
            
            const result = await db.deleteMessage(messageId, userId);
            if (result.success) {
                const deleteData = { messageId };
                emitToUser(userId, 'message-deleted', deleteData);
                emitToUser(receiverId, 'message-deleted', deleteData);
            }
        } catch (error) {
            console.error('Delete message error:', error);
        }
    });

    // === РЕАКЦИИ ===
    
    socket.on('add-reaction', async (data) => {
        try {
            const { messageId, emoji, receiverId } = data;
            if (!messageId || !emoji) return;
            
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
            if (!messageId || !emoji) return;
            
            await db.removeReaction(messageId, userId, emoji);
            const reaction = { messageId, odataId: userId, emoji };
            emitToUser(userId, 'reaction-removed', reaction);
            emitToUser(receiverId, 'reaction-removed', reaction);
        } catch (error) {
            console.error('Remove reaction error:', error);
        }
    });

    // === ЗВОНКИ ===
    
    socket.on('call-user', async (data) => {
        const { to, offer, isVideo } = data;
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
            // Отправляем на все устройства получателя
            emitToUser(to, 'incoming-call', { 
                from: userId, 
                fromName: socket.user.username, 
                offer, 
                isVideo, 
                callId 
            });
            socket.emit('call-initiated', { callId });
        } else {
            // Пользователь оффлайн - отправляем push-уведомление о звонке
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
            
            // Даём время на получение push и открытие приложения
            socket.emit('call-initiated', { callId, waitingForUser: true });
            
            // Автоматически завершаем звонок через 30 секунд если не ответили
            setTimeout(() => {
                const call = activeCalls.get(callId);
                if (call && !call.startTime) {
                    activeCalls.delete(callId);
                    socket.emit('call-failed', { reason: 'Пользователь не ответил', callId });
                }
            }, 30000);
        }
    });

    socket.on('call-answer', async (data) => {
        const { to, answer, callId } = data;
        
        const call = activeCalls.get(callId);
        if (call) {
            call.startTime = Date.now();
            call.answeredBy = socket.id; // Запоминаем кто ответил
            activeCalls.set(callId, call);
        }
        emitToUser(to, 'call-answered', { answer, callId });
    });

    socket.on('call-decline', (data) => {
        const { to, callId } = data;
        emitToUser(to, 'call-declined', { callId });
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
                
                emitToUser(call.caller, 'call-message', message);
                emitToUser(receiver, 'call-message', message);
            } catch (error) {
                console.error('Save call message error:', error);
            }
        }
        
        emitToUser(to, 'call-ended', { callId });
        
        if (callId) activeCalls.delete(callId);
    });

    socket.on('ice-candidate', (data) => {
        const { to, candidate } = data;
        emitToUser(to, 'ice-candidate', { candidate });
    });

    socket.on('video-renegotiate', (data) => {
        const { to, offer } = data;
        emitToUser(to, 'video-renegotiate', { offer });
    });

    socket.on('video-renegotiate-answer', (data) => {
        const { to, answer } = data;
        emitToUser(to, 'video-renegotiate-answer', { answer });
    });

    // Уведомление о демонстрации экрана
    socket.on('screen-share-started', (data) => {
        const { to } = data;
        emitToUser(to, 'screen-share-started', { from: userId });
    });

    socket.on('screen-share-stopped', (data) => {
        const { to } = data;
        emitToUser(to, 'screen-share-stopped', { from: userId });
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
