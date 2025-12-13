const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');

// Подключение к PostgreSQL
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL?.includes('render.com') ? { rejectUnauthorized: false } : false,
    max: 20,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 2000,
});

// Обработка ошибок пула
pool.on('error', (err) => {
    console.error('Unexpected database error:', err);
});

// Генерация уникального короткого ID (типа Discord: #1234)
async function generateUniqueTag(client) {
    for (let i = 0; i < 100; i++) {
        const tag = Math.floor(1000 + Math.random() * 9000).toString(); // 1000-9999
        const exists = await client.query('SELECT 1 FROM users WHERE tag = $1', [tag]);
        if (exists.rows.length === 0) return tag;
    }
    // Если 4-значные закончились, генерируем 5-значный
    return Math.floor(10000 + Math.random() * 90000).toString();
}

async function initDB() {
    const client = await pool.connect();
    try {
        await client.query(`
            CREATE TABLE IF NOT EXISTS users (
                id TEXT PRIMARY KEY,
                username TEXT UNIQUE NOT NULL,
                password TEXT NOT NULL,
                tag TEXT UNIQUE,
                role TEXT DEFAULT 'user',
                premium_until TIMESTAMP,
                display_name TEXT,
                phone TEXT,
                bio TEXT,
                avatar_url TEXT,
                banner_url TEXT,
                avatar_color TEXT DEFAULT '#4fc3f7',
                banner_color TEXT DEFAULT '#1976d2',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
        
        // Добавляем новые колонки
        const alterQueries = [
            'ALTER TABLE users ADD COLUMN IF NOT EXISTS display_name TEXT',
            'ALTER TABLE users ADD COLUMN IF NOT EXISTS phone TEXT',
            'ALTER TABLE users ADD COLUMN IF NOT EXISTS bio TEXT',
            'ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_url TEXT',
            'ALTER TABLE users ADD COLUMN IF NOT EXISTS banner_url TEXT',
            'ALTER TABLE users ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP',
            'ALTER TABLE users ADD COLUMN IF NOT EXISTS tag TEXT UNIQUE',
            'ALTER TABLE users ADD COLUMN IF NOT EXISTS role TEXT DEFAULT \'user\'',
            'ALTER TABLE users ADD COLUMN IF NOT EXISTS premium_until TIMESTAMP'
        ];
        
        for (const query of alterQueries) {
            await client.query(query).catch(() => {});
        }
        
        // Генерируем tag для пользователей без него
        const usersWithoutTag = await client.query('SELECT id FROM users WHERE tag IS NULL');
        for (const user of usersWithoutTag.rows) {
            const tag = await generateUniqueTag(client);
            await client.query('UPDATE users SET tag = $1 WHERE id = $2', [tag, user.id]);
        }
        
        // Создаём индекс для tag
        await client.query('CREATE INDEX IF NOT EXISTS idx_users_tag ON users(tag)').catch(() => {});
        
        // Очищаем локальные URL аватарок/баннеров (они не работают после редеплоя)
        // Оставляем только Cloudinary URL (начинаются с https://)
        await client.query(`
            UPDATE users SET avatar_url = NULL 
            WHERE avatar_url IS NOT NULL AND avatar_url NOT LIKE 'https://%'
        `).catch(() => {});
        await client.query(`
            UPDATE users SET banner_url = NULL 
            WHERE banner_url IS NOT NULL AND banner_url NOT LIKE 'https://%'
        `).catch(() => {});

        await client.query(`
            CREATE TABLE IF NOT EXISTS messages (
                id TEXT PRIMARY KEY,
                sender_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                receiver_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                text TEXT NOT NULL,
                is_read BOOLEAN DEFAULT FALSE,
                message_type TEXT DEFAULT 'text',
                call_duration INTEGER DEFAULT 0,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
        
        await client.query('ALTER TABLE messages ADD COLUMN IF NOT EXISTS is_read BOOLEAN DEFAULT FALSE').catch(() => {});
        await client.query('ALTER TABLE messages ADD COLUMN IF NOT EXISTS message_type TEXT DEFAULT \'text\'').catch(() => {});
        await client.query('ALTER TABLE messages ADD COLUMN IF NOT EXISTS call_duration INTEGER DEFAULT 0').catch(() => {});

        // Индексы
        await client.query('CREATE INDEX IF NOT EXISTS idx_messages_sender ON messages(sender_id)').catch(() => {});
        await client.query('CREATE INDEX IF NOT EXISTS idx_messages_receiver ON messages(receiver_id)').catch(() => {});
        await client.query('CREATE INDEX IF NOT EXISTS idx_messages_created ON messages(created_at DESC)').catch(() => {});
        await client.query('CREATE INDEX IF NOT EXISTS idx_users_username ON users(username)').catch(() => {});

        // Push подписки
        await client.query(`
            CREATE TABLE IF NOT EXISTS push_subscriptions (
                id TEXT PRIMARY KEY,
                user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                endpoint TEXT NOT NULL,
                p256dh TEXT NOT NULL,
                auth TEXT NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(user_id, endpoint)
            )
        `);

        console.log('✅ База данных инициализирована');
    } finally {
        client.release();
    }
}

// === ПОЛЬЗОВАТЕЛИ ===

async function createUser(username, password) {
    const client = await pool.connect();
    try {
        // Проверяем существование
        const existing = await client.query('SELECT id FROM users WHERE LOWER(username) = LOWER($1)', [username]);
        if (existing.rows.length > 0) {
            return { success: false, error: 'Пользователь уже существует' };
        }
        
        const hash = await bcrypt.hash(password, 12);
        const id = uuidv4();
        const tag = await generateUniqueTag(client);
        
        // Проверяем, есть ли username в списке админов из env
        const adminUsernames = (process.env.ADMIN_USERNAMES || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
        const role = adminUsernames.includes(username.toLowerCase()) ? 'admin' : 'user';
        
        await client.query(
            'INSERT INTO users (id, username, password, tag, role) VALUES ($1, $2, $3, $4, $5)',
            [id, username, hash, tag, role]
        );
        
        if (role === 'admin') {
            console.log(`👑 Пользователь ${username} назначен админом (из ADMIN_USERNAMES)`);
        }
        
        return { success: true, user: { id, username, tag } };
    } catch (error) {
        console.error('Create user error:', error);
        return { success: false, error: 'Ошибка создания пользователя' };
    } finally {
        client.release();
    }
}

async function loginUser(username, password) {
    try {
        const result = await pool.query(
            'SELECT id, username, password, tag, role, premium_until FROM users WHERE LOWER(username) = LOWER($1)',
            [username]
        );
        
        if (result.rows.length === 0) {
            await bcrypt.compare(password, '$2a$12$dummy.hash.for.timing.attack.protection');
            return { success: false, error: 'Неверный логин или пароль' };
        }
        
        const user = result.rows[0];
        const isValid = await bcrypt.compare(password, user.password);
        
        if (!isValid) {
            return { success: false, error: 'Неверный логин или пароль' };
        }
        
        // Проверяем, есть ли в списке админов из env (обновляем роль если нужно)
        const adminUsernames = (process.env.ADMIN_USERNAMES || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
        let role = user.role;
        
        if (adminUsernames.includes(user.username.toLowerCase()) && role !== 'admin') {
            role = 'admin';
            await pool.query('UPDATE users SET role = $1 WHERE id = $2', ['admin', user.id]);
            console.log(`👑 Пользователь ${user.username} повышен до админа (из ADMIN_USERNAMES)`);
        }
        
        // Проверяем премиум статус
        const isPremium = role === 'admin' || 
                          (user.premium_until && new Date(user.premium_until) > new Date());
        
        return { 
            success: true, 
            user: { 
                id: user.id, 
                username: user.username, 
                tag: user.tag,
                role: role,
                isPremium
            } 
        };
    } catch (error) {
        console.error('Login error:', error);
        return { success: false, error: 'Ошибка входа' };
    }
}

async function getUser(userId) {
    try {
        const result = await pool.query(
            `SELECT id, username, tag, role, premium_until, display_name, phone, bio, avatar_url, banner_url, created_at 
             FROM users WHERE id = $1`,
            [userId]
        );
        if (result.rows.length === 0) return null;
        
        const user = result.rows[0];
        user.isPremium = user.role === 'admin' || 
                         (user.premium_until && new Date(user.premium_until) > new Date());
        return user;
    } catch (error) {
        console.error('Get user error:', error);
        return null;
    }
}

// Поиск по тегу (username#tag)
async function getUserByTag(username, tag) {
    try {
        const result = await pool.query(
            `SELECT id, username, tag, role, display_name, avatar_url, bio 
             FROM users WHERE LOWER(username) = LOWER($1) AND tag = $2`,
            [username, tag]
        );
        return result.rows[0] || null;
    } catch (error) {
        console.error('Get user by tag error:', error);
        return null;
    }
}

// === АДМИН ФУНКЦИИ ===

async function setUserRole(userId, role) {
    try {
        if (!['user', 'premium', 'admin'].includes(role)) {
            return { success: false, error: 'Неверная роль' };
        }
        
        // Админы получают пожизненный премиум
        if (role === 'admin') {
            await pool.query(
                'UPDATE users SET role = $2, premium_until = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = $1',
                [userId, role]
            );
        } else {
            await pool.query(
                'UPDATE users SET role = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $1',
                [userId, role]
            );
        }
        return { success: true };
    } catch (error) {
        console.error('Set user role error:', error);
        return { success: false, error: 'Ошибка изменения роли' };
    }
}

async function setPremium(userId, days) {
    try {
        const premiumUntil = new Date();
        premiumUntil.setDate(premiumUntil.getDate() + days);
        
        await pool.query(
            'UPDATE users SET premium_until = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $1',
            [userId, premiumUntil]
        );
        return { success: true, premiumUntil };
    } catch (error) {
        console.error('Set premium error:', error);
        return { success: false, error: 'Ошибка выдачи премиума' };
    }
}

async function getAllUsers(limit = 50, offset = 0) {
    try {
        const result = await pool.query(
            `SELECT id, username, tag, role, premium_until, display_name, avatar_url, created_at 
             FROM users ORDER BY created_at DESC LIMIT $1 OFFSET $2`,
            [limit, offset]
        );
        
        const countResult = await pool.query('SELECT COUNT(*) FROM users');
        
        return {
            users: result.rows.map(u => ({
                ...u,
                isPremium: u.role === 'admin' || (u.premium_until && new Date(u.premium_until) > new Date())
            })),
            total: parseInt(countResult.rows[0].count)
        };
    } catch (error) {
        console.error('Get all users error:', error);
        return { users: [], total: 0 };
    }
}

async function deleteUser(userId) {
    try {
        await pool.query('DELETE FROM users WHERE id = $1', [userId]);
        return { success: true };
    } catch (error) {
        console.error('Delete user error:', error);
        return { success: false, error: 'Ошибка удаления' };
    }
}

async function updateUser(userId, data) {
    try {
        const { display_name, phone, bio } = data;
        await pool.query(
            `UPDATE users SET 
                display_name = COALESCE($2, display_name),
                phone = COALESCE($3, phone),
                bio = COALESCE($4, bio),
                updated_at = CURRENT_TIMESTAMP
            WHERE id = $1`,
            [userId, display_name || null, phone || null, bio || null]
        );
        return { success: true };
    } catch (error) {
        console.error('Update user error:', error);
        return { success: false, error: 'Ошибка обновления' };
    }
}

async function updateUserAvatar(userId, avatarUrl) {
    try {
        await pool.query('UPDATE users SET avatar_url = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $1', [userId, avatarUrl]);
        return { success: true };
    } catch (error) {
        console.error('Update avatar error:', error);
        return { success: false };
    }
}

async function updateUserBanner(userId, bannerUrl) {
    try {
        await pool.query('UPDATE users SET banner_url = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $1', [userId, bannerUrl]);
        return { success: true };
    } catch (error) {
        console.error('Update banner error:', error);
        return { success: false };
    }
}

async function updateUsername(userId, username) {
    try {
        const existing = await pool.query(
            'SELECT id FROM users WHERE LOWER(username) = LOWER($1) AND id != $2', 
            [username, userId]
        );
        if (existing.rows.length > 0) {
            return { success: false, error: 'Этот ник уже занят' };
        }
        await pool.query('UPDATE users SET username = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $1', [userId, username]);
        return { success: true };
    } catch (error) {
        console.error('Update username error:', error);
        return { success: false, error: 'Ошибка смены ника' };
    }
}

async function searchUsers(query, excludeUserId) {
    try {
        // Санитизация и ограничение
        const sanitized = query.replace(/[%_]/g, '').substring(0, 50);
        if (sanitized.length < 2) return [];
        
        const result = await pool.query(
            `SELECT id, username, display_name, avatar_url 
             FROM users 
             WHERE (username ILIKE $1 OR display_name ILIKE $1) AND id != $2
             LIMIT 20`,
            [`%${sanitized}%`, excludeUserId]
        );
        return result.rows;
    } catch (error) {
        console.error('Search users error:', error);
        return [];
    }
}

// === СООБЩЕНИЯ ===

async function saveMessage(senderId, receiverId, text, messageType = 'text', callDuration = 0) {
    try {
        const id = uuidv4();
        const created_at = new Date().toISOString();
        
        await pool.query(
            `INSERT INTO messages (id, sender_id, receiver_id, text, message_type, call_duration, created_at) 
             VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [id, senderId, receiverId, text, messageType, callDuration, created_at]
        );
        
        return { 
            id, 
            sender_id: senderId, 
            receiver_id: receiverId, 
            text, 
            created_at, 
            message_type: messageType, 
            call_duration: callDuration 
        };
    } catch (error) {
        console.error('Save message error:', error);
        throw error;
    }
}

async function getMessages(userId1, userId2, limit = 50, before = null) {
    try {
        let query = `
            SELECT id, sender_id, receiver_id, text, message_type, call_duration, created_at 
            FROM messages 
            WHERE (sender_id = $1 AND receiver_id = $2) OR (sender_id = $2 AND receiver_id = $1)
        `;
        const params = [userId1, userId2];
        
        if (before) {
            query += ` AND created_at < $3`;
            params.push(before);
        }
        
        query += ` ORDER BY created_at DESC LIMIT $${params.length + 1}`;
        params.push(Math.min(limit, 100)); // Максимум 100
        
        const result = await pool.query(query, params);
        return result.rows.reverse(); // Возвращаем в хронологическом порядке
    } catch (error) {
        console.error('Get messages error:', error);
        return [];
    }
}

async function getContacts(userId) {
    try {
        const result = await pool.query(`
            SELECT DISTINCT u.id, u.username, u.display_name, u.avatar_url,
                (SELECT COUNT(*) FROM messages m 
                 WHERE m.sender_id = u.id AND m.receiver_id = $1 AND m.is_read = FALSE) as unread_count,
                (SELECT MAX(created_at) FROM messages m 
                 WHERE (m.sender_id = u.id AND m.receiver_id = $1) OR (m.sender_id = $1 AND m.receiver_id = u.id)) as last_message_at
            FROM users u
            WHERE u.id IN (
                SELECT DISTINCT sender_id FROM messages WHERE receiver_id = $1
                UNION
                SELECT DISTINCT receiver_id FROM messages WHERE sender_id = $1
            )
            ORDER BY last_message_at DESC NULLS LAST
        `, [userId]);
        return result.rows;
    } catch (error) {
        console.error('Get contacts error:', error);
        return [];
    }
}

async function markMessagesAsRead(senderId, receiverId) {
    try {
        await pool.query(
            'UPDATE messages SET is_read = TRUE WHERE sender_id = $1 AND receiver_id = $2 AND is_read = FALSE',
            [senderId, receiverId]
        );
        return { success: true };
    } catch (error) {
        console.error('Mark as read error:', error);
        return { success: false };
    }
}

// === PUSH ПОДПИСКИ ===

async function savePushSubscription(userId, subscription) {
    try {
        const id = uuidv4();
        await pool.query(
            `INSERT INTO push_subscriptions (id, user_id, endpoint, p256dh, auth) 
             VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT (user_id, endpoint) DO UPDATE SET p256dh = $4, auth = $5`,
            [id, userId, subscription.endpoint, subscription.keys.p256dh, subscription.keys.auth]
        );
        return { success: true };
    } catch (error) {
        console.error('Save push subscription error:', error);
        return { success: false };
    }
}

async function getPushSubscriptions(userId) {
    try {
        const result = await pool.query(
            'SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = $1',
            [userId]
        );
        return result.rows.map(row => ({
            endpoint: row.endpoint,
            keys: { p256dh: row.p256dh, auth: row.auth }
        }));
    } catch (error) {
        console.error('Get push subscriptions error:', error);
        return [];
    }
}

async function deletePushSubscription(endpoint) {
    try {
        await pool.query('DELETE FROM push_subscriptions WHERE endpoint = $1', [endpoint]);
    } catch (error) {
        console.error('Delete push subscription error:', error);
    }
}

// === ГЛОБАЛЬНЫЙ ПОИСК ===

async function globalSearch(userId, query) {
    try {
        const sanitized = query.replace(/[%_]/g, '').substring(0, 100);
        if (sanitized.length < 2) return { users: [], messages: [] };
        
        // Поиск пользователей
        const usersResult = await pool.query(
            `SELECT id, username, tag, display_name, avatar_url 
             FROM users 
             WHERE (username ILIKE $1 OR display_name ILIKE $1) AND id != $2
             LIMIT 10`,
            [`%${sanitized}%`, userId]
        );
        
        // Поиск сообщений (только в чатах текущего пользователя)
        const messagesResult = await pool.query(
            `SELECT m.id, m.text, m.created_at, m.sender_id, m.receiver_id,
                    u.username as sender_username, u.display_name as sender_display_name, u.avatar_url as sender_avatar
             FROM messages m
             JOIN users u ON u.id = m.sender_id
             WHERE (m.sender_id = $1 OR m.receiver_id = $1)
               AND m.text ILIKE $2
               AND m.message_type = 'text'
             ORDER BY m.created_at DESC
             LIMIT 20`,
            [userId, `%${sanitized}%`]
        );
        
        return {
            users: usersResult.rows,
            messages: messagesResult.rows
        };
    } catch (error) {
        console.error('Global search error:', error);
        return { users: [], messages: [] };
    }
}

module.exports = { 
    initDB, 
    createUser, 
    loginUser, 
    getUser,
    getUserByTag,
    updateUser, 
    updateUserAvatar, 
    updateUserBanner, 
    updateUsername, 
    searchUsers, 
    saveMessage, 
    getMessages, 
    getContacts, 
    markMessagesAsRead, 
    savePushSubscription, 
    getPushSubscriptions, 
    deletePushSubscription,
    // Админ функции
    setUserRole,
    setPremium,
    getAllUsers,
    deleteUser,
    // Поиск
    globalSearch
};
