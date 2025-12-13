const jwt = require('jsonwebtoken');

// JWT секрет из переменных окружения
const JWT_SECRET = process.env.JWT_SECRET || 'kvant-super-secret-key-change-in-production';
const JWT_EXPIRES_IN = '7d';

/**
 * Генерация JWT токена
 */
function generateToken(user) {
    return jwt.sign(
        { id: user.id, username: user.username, role: user.role || 'user' },
        JWT_SECRET,
        { expiresIn: JWT_EXPIRES_IN }
    );
}

/**
 * Верификация JWT токена
 */
function verifyToken(token) {
    try {
        return jwt.verify(token, JWT_SECRET);
    } catch (error) {
        return null;
    }
}

/**
 * Middleware для защиты роутов
 */
function authMiddleware(req, res, next) {
    const authHeader = req.headers.authorization;
    
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ success: false, error: 'Требуется авторизация' });
    }
    
    const token = authHeader.substring(7);
    const decoded = verifyToken(token);
    
    if (!decoded) {
        return res.status(401).json({ success: false, error: 'Недействительный токен' });
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
    JWT_SECRET
};
