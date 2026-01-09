const jwt = require('jsonwebtoken');

// JWT секрет из переменных окружения (ОБЯЗАТЕЛЬНО!)
const JWT_SECRET = process.env.JWT_SECRET;
const JWT_EXPIRES_IN = '7d';

// Проверка наличия секрета при загрузке модуля
if (!JWT_SECRET) {
    console.warn('⚠️  JWT_SECRET не установлен! Используется небезопасный дефолтный секрет.');
    console.warn('   Для продакшена обязательно установите JWT_SECRET в переменных окружения.');
}

// Fallback только для разработки
const EFFECTIVE_JWT_SECRET = JWT_SECRET || 'dev-only-insecure-secret-do-not-use-in-production';

/**
 * Генерация JWT токена
 */
function generateToken(user) {
    return jwt.sign(
        { id: user.id, username: user.username, role: user.role || 'user' },
        EFFECTIVE_JWT_SECRET,
        { expiresIn: JWT_EXPIRES_IN }
    );
}

/**
 * Верификация JWT токена
 */
function verifyToken(token) {
    try {
        const decoded = jwt.verify(token, EFFECTIVE_JWT_SECRET);
        if (process.env.NODE_ENV !== 'production') {
            console.log(`🔑 Token verified for user: ${decoded.username} (${decoded.id})`);
        }
        return decoded;
    } catch (error) {
        if (process.env.NODE_ENV !== 'production') {
            console.log(`❌ Token verification failed: ${error.message}`);
        }
        return null;
    }
}

/**
 * Middleware для защиты роутов
 */
function authMiddleware(req, res, next) {
    const authHeader = req.headers.authorization;
    
    if (process.env.NODE_ENV !== 'production') {
        console.log(`🔐 Auth check for ${req.method} ${req.path}`);
        console.log(`   Authorization header: ${authHeader ? 'present' : 'missing'}`);
        console.log(`   JWT_SECRET available: ${!!EFFECTIVE_JWT_SECRET}`);
    }
    
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        if (process.env.NODE_ENV !== 'production') {
            console.log(`❌ Auth failed: missing or invalid header`);
        }
        return res.status(401).json({ success: false, error: 'Требуется авторизация', code: 'NO_TOKEN' });
    }
    
    const token = authHeader.substring(7);
    if (process.env.NODE_ENV !== 'production') {
        console.log(`   Token: ${token.substring(0, 20)}...`);
    }
    
    const decoded = verifyToken(token);
    
    if (!decoded) {
        if (process.env.NODE_ENV !== 'production') {
            console.log(`❌ Auth failed: invalid token`);
        }
        return res.status(401).json({ success: false, error: 'Недействительный токен', code: 'INVALID_TOKEN' });
    }
    
    if (process.env.NODE_ENV !== 'production') {
        console.log(`✅ Auth success: user ${decoded.username} (${decoded.id})`);
    }
    req.user = decoded;
    next();
}

/**
 * Middleware для проверки владельца ресурса
 */
function ownerMiddleware(paramName = 'userId') {
    return (req, res, next) => {
        const resourceUserId = req.params[paramName];
        
        // Админы могут всё
        if (req.user.role === 'admin') {
            return next();
        }
        
        if (req.user.id !== resourceUserId) {
            return res.status(403).json({ success: false, error: 'Доступ запрещён' });
        }
        
        next();
    };
}

/**
 * Middleware для проверки админа
 */
function adminMiddleware(req, res, next) {
    if (req.user.role !== 'admin') {
        return res.status(403).json({ success: false, error: 'Требуются права администратора' });
    }
    next();
}

/**
 * Аутентификация Socket.IO
 */
function socketAuthMiddleware(socket, next) {
    const token = socket.handshake.auth.token || socket.handshake.query.token;
    
    if (!token) {
        return next(new Error('Требуется авторизация'));
    }
    
    const decoded = verifyToken(token);
    
    if (!decoded) {
        return next(new Error('Недействительный токен'));
    }
    
    socket.user = decoded;
    next();
}

module.exports = {
    generateToken,
    verifyToken,
    authMiddleware,
    ownerMiddleware,
    adminMiddleware,
    socketAuthMiddleware,
    JWT_SECRET: EFFECTIVE_JWT_SECRET
};
