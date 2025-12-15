const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');

// Определяем какую БД использовать
const USE_SQLITE = !process.env.DATABASE_URL || process.env.USE_SQLITE === 'true';

let pool = null;
let sqlite = null;

if (USE_SQLITE) {
    // SQLite для локальной разработки
    const Database = require('better-sqlite3');
    sqlite = new Database('kvant_local.db');
    sqlite.pragma('journal_mode = WAL');
    console.log('📦 Используется SQLite (локальная разработка)');
} else {
    // PostgreSQL для продакшена
    const { Pool } = require('pg');
    pool = new Pool({
        connectionString: process.env.DATABASE_URL,
        ssl: process.env.DATABASE_URL?.includes('render.com') ? { rejectUnauthorized: false } : false,
        max: 20,
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 2000,
    });
    
    pool.on('error', (err) => {
        console.error('Unexpected database error:', err);
    });
}

// Генерация уникального короткого ID (типа Discord: #1234)
async function generateUniqueTag(clientOrDb) {
    for (let i = 0; i < 100; i++) {
        const tag = Math.floor(1000 + Math.random() * 9000).toString();
        if (USE_SQLITE) {
            const exists = sqlite.prepare('SELECT 1 FROM users WHERE tag = ?').get(tag);
            if (!exists) return tag;
        } else {
            const exists = await clientOrDb.query('SELECT 1 FROM users WHERE tag = $1', [tag]);
            if (exists.rows.length === 0) return tag;
        }
    }
    return Math.floor(10000 + Math.random() * 90000).toString();
}

async function initDB() {
    if (USE_SQLITE) {
        // SQLite инициализация
        sqlite.exec(`
            CREATE TABLE IF NOT EXISTS users (
                id TEXT PRIMARY KEY,
                username TEXT UNIQUE NOT NULL,
                password TEXT NOT NULL,
                tag TEXT UNIQUE,
                role TEXT DEFAULT 'user',
                premium_until TEXT,
                display_name TEXT,
                phone TEXT,
                bio TEXT,
                avatar_url TEXT,
                banner_url TEXT,
                name_color TEXT,
                profile_theme TEXT DEFAULT 'default',
                profile_color TEXT,
                custom_id TEXT,
                hide_online INTEGER DEFAULT 0,
                settings TEXT DEFAULT '{}',
                created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                updated_at TEXT DEFAULT CURRENT_TIMESTAMP
            )
        `);
        
        sqlite.exec(`
            CREATE TABLE IF NOT EXISTS messages (
                id TEXT PRIMARY KEY,
                sender_id TEXT NOT NULL,
                receiver_id TEXT NOT NULL,
                text TEXT NOT NULL,
                is_read INTEGER DEFAULT 0,
                message_type TEXT DEFAULT 'text',
                call_duration INTEGER DEFAULT 0,
                created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                updated_at TEXT,
                FOREIGN KEY (sender_id) REFERENCES users(id) ON DELETE CASCADE,
                FOREIGN KEY (receiver_id) REFERENCES users(id) ON DELETE CASCADE
            )
        `);
        
        sqlite.exec(`
            CREATE TABLE IF NOT EXISTS push_subscriptions (
                id TEXT PRIMARY KEY,
                user_id TEXT NOT NULL,
                endpoint TEXT NOT NULL,
                p256dh TEXT NOT NULL,
                auth TEXT NOT NULL,
                created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(user_id, endpoint),
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
            )
        `);
        
        sqlite.exec(`
            CREATE TABLE IF NOT EXISTS message_reactions (
                id TEXT PRIMARY KEY,
                message_id TEXT NOT NULL,
                user_id TEXT NOT NULL,
                emoji TEXT NOT NULL,
                created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(message_id, user_id, emoji),
                FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE,
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
            )
        `);
        
        // === SUPPORT TICKETS ===
        sqlite.exec(`
            CREATE TABLE IF NOT EXISTS support_tickets (
                id TEXT PRIMARY KEY,
                user_id TEXT NOT NULL,
                category TEXT NOT NULL,
                message TEXT NOT NULL,
                status TEXT DEFAULT 'open',
                created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
            )
        `);
        
        sqlite.exec(`
            CREATE TABLE IF NOT EXISTS support_replies (
                id TEXT PRIMARY KEY,
                ticket_id TEXT NOT NULL,
                user_id TEXT NOT NULL,
                message TEXT NOT NULL,
                is_admin INTEGER DEFAULT 0,
                created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (ticket_id) REFERENCES support_tickets(id) ON DELETE CASCADE,
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
            )
        `);
        
        // === ГРУППОВЫЕ ЧАТЫ ===
        sqlite.exec(`
            CREATE TABLE IF NOT EXISTS group_chats (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                description TEXT,
                avatar_url TEXT,
                owner_id TEXT NOT NULL,
                is_public INTEGER DEFAULT 0,
                created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE
            )
        `);

        sqlite.exec(`
            CREATE TABLE IF NOT EXISTS group_members (
                id TEXT PRIMARY KEY,
                group_id TEXT NOT NULL,
                user_id TEXT NOT NULL,
                role TEXT DEFAULT 'member',
                joined_at TEXT DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(group_id, user_id),
                FOREIGN KEY (group_id) REFERENCES group_chats(id) ON DELETE CASCADE,
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
            )
        `);

        sqlite.exec(`
            CREATE TABLE IF NOT EXISTS group_messages (
                id TEXT PRIMARY KEY,
                group_id TEXT NOT NULL,
                sender_id TEXT NOT NULL,
                text TEXT NOT NULL,
                message_type TEXT DEFAULT 'text',
                reply_to TEXT,
                created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                updated_at TEXT,
                FOREIGN KEY (group_id) REFERENCES group_chats(id) ON DELETE CASCADE,
                FOREIGN KEY (sender_id) REFERENCES users(id) ON DELETE CASCADE
            )
        `);

        // === КАНАЛЫ (Telegram-style) ===
        sqlite.exec(`
            CREATE TABLE IF NOT EXISTS channels (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                description TEXT,
                avatar_url TEXT,
                owner_id TEXT NOT NULL,
                is_public INTEGER DEFAULT 1,
                subscriber_count INTEGER DEFAULT 0,
                created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE
            )
        `);

        sqlite.exec(`
            CREATE TABLE IF NOT EXISTS channel_admins (
                id TEXT PRIMARY KEY,
                channel_id TEXT NOT NULL,
                user_id TEXT NOT NULL,
                can_post INTEGER DEFAULT 1,
                can_edit INTEGER DEFAULT 1,
                can_delete INTEGER DEFAULT 1,
                added_at TEXT DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(channel_id, user_id),
                FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE CASCADE,
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
            )
        `);

        sqlite.exec(`
            CREATE TABLE IF NOT EXISTS channel_subscribers (
                id TEXT PRIMARY KEY,
                channel_id TEXT NOT NULL,
                user_id TEXT NOT NULL,
                subscribed_at TEXT DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(channel_id, user_id),
                FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE CASCADE,
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
            )
        `);

        sqlite.exec(`
            CREATE TABLE IF NOT EXISTS channel_posts (
                id TEXT PRIMARY KEY,
                channel_id TEXT NOT NULL,
                author_id TEXT NOT NULL,
                text TEXT,
                media_url TEXT,
                media_type TEXT,
                views INTEGER DEFAULT 0,
                created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                updated_at TEXT,
                FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE CASCADE,
                FOREIGN KEY (author_id) REFERENCES users(id) ON DELETE CASCADE
            )
        `);

        // === СЕРВЕРЫ (Discord-style) ===
        sqlite.exec(`
            CREATE TABLE IF NOT EXISTS servers (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                description TEXT,
                icon_url TEXT,
                banner_url TEXT,
                owner_id TEXT NOT NULL,
                is_public INTEGER DEFAULT 0,
                member_count INTEGER DEFAULT 0,
                created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE
            )
        `);

        sqlite.exec(`
            CREATE TABLE IF NOT EXISTS server_roles (
                id TEXT PRIMARY KEY,
                server_id TEXT NOT NULL,
                name TEXT NOT NULL,
                color TEXT DEFAULT '#99aab5',
                position INTEGER DEFAULT 0,
                permissions INTEGER DEFAULT 0,
                is_default INTEGER DEFAULT 0,
                created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE
            )
        `);

        sqlite.exec(`
            CREATE TABLE IF NOT EXISTS server_members (
                id TEXT PRIMARY KEY,
                server_id TEXT NOT NULL,
                user_id TEXT NOT NULL,
                nickname TEXT,
                joined_at TEXT DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(server_id, user_id),
                FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE,
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
            )
        `);

        sqlite.exec(`
            CREATE TABLE IF NOT EXISTS server_member_roles (
                id TEXT PRIMARY KEY,
                server_id TEXT NOT NULL,
                user_id TEXT NOT NULL,
                role_id TEXT NOT NULL,
                UNIQUE(server_id, user_id, role_id),
                FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE,
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
                FOREIGN KEY (role_id) REFERENCES server_roles(id) ON DELETE CASCADE
            )
        `);

        sqlite.exec(`
            CREATE TABLE IF NOT EXISTS server_categories (
                id TEXT PRIMARY KEY,
                server_id TEXT NOT NULL,
                name TEXT NOT NULL,
                position INTEGER DEFAULT 0,
                created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE
            )
        `);

        sqlite.exec(`
            CREATE TABLE IF NOT EXISTS server_channels (
                id TEXT PRIMARY KEY,
                server_id TEXT NOT NULL,
                category_id TEXT,
                name TEXT NOT NULL,
                topic TEXT,
                type TEXT DEFAULT 'text',
                position INTEGER DEFAULT 0,
                is_nsfw INTEGER DEFAULT 0,
                slowmode INTEGER DEFAULT 0,
                created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE,
                FOREIGN KEY (category_id) REFERENCES server_categories(id) ON DELETE SET NULL
            )
        `);

        sqlite.exec(`
            CREATE TABLE IF NOT EXISTS server_messages (
                id TEXT PRIMARY KEY,
                channel_id TEXT NOT NULL,
                sender_id TEXT NOT NULL,
                text TEXT,
                message_type TEXT DEFAULT 'text',
                reply_to TEXT,
                created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                updated_at TEXT,
                FOREIGN KEY (channel_id) REFERENCES server_channels(id) ON DELETE CASCADE,
                FOREIGN KEY (sender_id) REFERENCES users(id) ON DELETE CASCADE
            )
        `);

        // Индексы
        try { sqlite.exec('CREATE INDEX idx_messages_sender ON messages(sender_id)'); } catch {}
        try { sqlite.exec('CREATE INDEX idx_messages_receiver ON messages(receiver_id)'); } catch {}
        try { sqlite.exec('CREATE INDEX idx_messages_created ON messages(created_at DESC)'); } catch {}
        try { sqlite.exec('CREATE INDEX idx_users_username ON users(username)'); } catch {}
        try { sqlite.exec('CREATE INDEX idx_users_tag ON users(tag)'); } catch {}
        try { sqlite.exec('CREATE INDEX idx_reactions_message ON message_reactions(message_id)'); } catch {}
        try { sqlite.exec('CREATE INDEX idx_group_members_group ON group_members(group_id)'); } catch {}
        try { sqlite.exec('CREATE INDEX idx_group_members_user ON group_members(user_id)'); } catch {}
        try { sqlite.exec('CREATE INDEX idx_group_messages_group ON group_messages(group_id)'); } catch {}
        try { sqlite.exec('CREATE INDEX idx_channel_subs_channel ON channel_subscribers(channel_id)'); } catch {}
        try { sqlite.exec('CREATE INDEX idx_channel_subs_user ON channel_subscribers(user_id)'); } catch {}
        try { sqlite.exec('CREATE INDEX idx_channel_posts_channel ON channel_posts(channel_id)'); } catch {}
        try { sqlite.exec('CREATE INDEX idx_server_members_server ON server_members(server_id)'); } catch {}
        try { sqlite.exec('CREATE INDEX idx_server_members_user ON server_members(user_id)'); } catch {}
        try { sqlite.exec('CREATE INDEX idx_server_channels_server ON server_channels(server_id)'); } catch {}
        try { sqlite.exec('CREATE INDEX idx_server_messages_channel ON server_messages(channel_id)'); } catch {}
        
        console.log('✅ SQLite база данных инициализирована');
        return;
    }
    
    // PostgreSQL инициализация
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
        
        const alterQueries = [
            'ALTER TABLE users ADD COLUMN IF NOT EXISTS display_name TEXT',
            'ALTER TABLE users ADD COLUMN IF NOT EXISTS phone TEXT',
            'ALTER TABLE users ADD COLUMN IF NOT EXISTS bio TEXT',
            'ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_url TEXT',
            'ALTER TABLE users ADD COLUMN IF NOT EXISTS banner_url TEXT',
            'ALTER TABLE users ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP',
            'ALTER TABLE users ADD COLUMN IF NOT EXISTS tag TEXT UNIQUE',
            'ALTER TABLE users ADD COLUMN IF NOT EXISTS role TEXT DEFAULT \'user\'',
            'ALTER TABLE users ADD COLUMN IF NOT EXISTS premium_until TIMESTAMP',
            'ALTER TABLE users ADD COLUMN IF NOT EXISTS name_color TEXT',
            'ALTER TABLE users ADD COLUMN IF NOT EXISTS profile_theme TEXT DEFAULT \'default\'',
            'ALTER TABLE users ADD COLUMN IF NOT EXISTS profile_color TEXT',
            'ALTER TABLE users ADD COLUMN IF NOT EXISTS custom_tag TEXT',
            'ALTER TABLE users ADD COLUMN IF NOT EXISTS custom_id TEXT',
            'ALTER TABLE users ADD COLUMN IF NOT EXISTS hide_online BOOLEAN DEFAULT FALSE',
            'ALTER TABLE users ADD COLUMN IF NOT EXISTS settings JSONB DEFAULT \'{}\''
        ];
        
        for (const query of alterQueries) {
            await client.query(query).catch(() => {});
        }
        
        const usersWithoutTag = await client.query('SELECT id FROM users WHERE tag IS NULL');
        for (const user of usersWithoutTag.rows) {
            const tag = await generateUniqueTag(client);
            await client.query('UPDATE users SET tag = $1 WHERE id = $2', [tag, user.id]);
        }
        
        await client.query('CREATE INDEX IF NOT EXISTS idx_users_tag ON users(tag)').catch(() => {});

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
        await client.query('ALTER TABLE messages ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP').catch(() => {});

        await client.query('CREATE INDEX IF NOT EXISTS idx_messages_sender ON messages(sender_id)').catch(() => {});
        await client.query('CREATE INDEX IF NOT EXISTS idx_messages_receiver ON messages(receiver_id)').catch(() => {});
        await client.query('CREATE INDEX IF NOT EXISTS idx_messages_created ON messages(created_at DESC)').catch(() => {});
        await client.query('CREATE INDEX IF NOT EXISTS idx_users_username ON users(username)').catch(() => {});

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

        await client.query(`
            CREATE TABLE IF NOT EXISTS message_reactions (
                id TEXT PRIMARY KEY,
                message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
                user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                emoji TEXT NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(message_id, user_id, emoji)
            )
        `);
        await client.query('CREATE INDEX IF NOT EXISTS idx_reactions_message ON message_reactions(message_id)').catch(() => {});

        // === SUPPORT TICKETS ===
        await client.query(`
            CREATE TABLE IF NOT EXISTS support_tickets (
                id TEXT PRIMARY KEY,
                user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                category TEXT NOT NULL,
                message TEXT NOT NULL,
                status TEXT DEFAULT 'open',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
        
        await client.query(`
            CREATE TABLE IF NOT EXISTS support_replies (
                id TEXT PRIMARY KEY,
                ticket_id TEXT NOT NULL REFERENCES support_tickets(id) ON DELETE CASCADE,
                user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                message TEXT NOT NULL,
                is_admin BOOLEAN DEFAULT FALSE,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // === ГРУППОВЫЕ ЧАТЫ ===
        await client.query(`
            CREATE TABLE IF NOT EXISTS group_chats (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                description TEXT,
                avatar_url TEXT,
                owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                is_public BOOLEAN DEFAULT FALSE,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        await client.query(`
            CREATE TABLE IF NOT EXISTS group_members (
                id TEXT PRIMARY KEY,
                group_id TEXT NOT NULL REFERENCES group_chats(id) ON DELETE CASCADE,
                user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                role TEXT DEFAULT 'member',
                joined_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(group_id, user_id)
            )
        `);

        await client.query(`
            CREATE TABLE IF NOT EXISTS group_messages (
                id TEXT PRIMARY KEY,
                group_id TEXT NOT NULL REFERENCES group_chats(id) ON DELETE CASCADE,
                sender_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                text TEXT NOT NULL,
                message_type TEXT DEFAULT 'text',
                reply_to TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP
            )
        `);

        // === КАНАЛЫ (Telegram-style) ===
        await client.query(`
            CREATE TABLE IF NOT EXISTS channels (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                description TEXT,
                avatar_url TEXT,
                owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                is_public BOOLEAN DEFAULT TRUE,
                subscriber_count INTEGER DEFAULT 0,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        await client.query(`
            CREATE TABLE IF NOT EXISTS channel_admins (
                id TEXT PRIMARY KEY,
                channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
                user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                can_post BOOLEAN DEFAULT TRUE,
                can_edit BOOLEAN DEFAULT TRUE,
                can_delete BOOLEAN DEFAULT TRUE,
                added_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(channel_id, user_id)
            )
        `);

        await client.query(`
            CREATE TABLE IF NOT EXISTS channel_subscribers (
                id TEXT PRIMARY KEY,
                channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
                user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                subscribed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(channel_id, user_id)
            )
        `);

        await client.query(`
            CREATE TABLE IF NOT EXISTS channel_posts (
                id TEXT PRIMARY KEY,
                channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
                author_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                text TEXT,
                media_url TEXT,
                media_type TEXT,
                views INTEGER DEFAULT 0,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP
            )
        `);

        // === СЕРВЕРЫ (Discord-style) ===
        await client.query(`
            CREATE TABLE IF NOT EXISTS servers (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                description TEXT,
                icon_url TEXT,
                banner_url TEXT,
                owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                is_public BOOLEAN DEFAULT FALSE,
                member_count INTEGER DEFAULT 0,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        await client.query(`
            CREATE TABLE IF NOT EXISTS server_roles (
                id TEXT PRIMARY KEY,
                server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
                name TEXT NOT NULL,
                color TEXT DEFAULT '#99aab5',
                position INTEGER DEFAULT 0,
                permissions BIGINT DEFAULT 0,
                is_default BOOLEAN DEFAULT FALSE,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        await client.query(`
            CREATE TABLE IF NOT EXISTS server_members (
                id TEXT PRIMARY KEY,
                server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
                user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                nickname TEXT,
                joined_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(server_id, user_id)
            )
        `);

        await client.query(`
            CREATE TABLE IF NOT EXISTS server_member_roles (
                id TEXT PRIMARY KEY,
                server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
                user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                role_id TEXT NOT NULL REFERENCES server_roles(id) ON DELETE CASCADE,
                UNIQUE(server_id, user_id, role_id)
            )
        `);

        await client.query(`
            CREATE TABLE IF NOT EXISTS server_categories (
                id TEXT PRIMARY KEY,
                server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
                name TEXT NOT NULL,
                position INTEGER DEFAULT 0,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        await client.query(`
            CREATE TABLE IF NOT EXISTS server_channels (
                id TEXT PRIMARY KEY,
                server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
                category_id TEXT REFERENCES server_categories(id) ON DELETE SET NULL,
                name TEXT NOT NULL,
                topic TEXT,
                type TEXT DEFAULT 'text',
                position INTEGER DEFAULT 0,
                is_nsfw BOOLEAN DEFAULT FALSE,
                slowmode INTEGER DEFAULT 0,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        await client.query(`
            CREATE TABLE IF NOT EXISTS server_messages (
                id TEXT PRIMARY KEY,
                channel_id TEXT NOT NULL REFERENCES server_channels(id) ON DELETE CASCADE,
                sender_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                text TEXT,
                message_type TEXT DEFAULT 'text',
                reply_to TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP
            )
        `);

        // Индексы для новых таблиц
        await client.query('CREATE INDEX IF NOT EXISTS idx_group_members_group ON group_members(group_id)').catch(() => {});
        await client.query('CREATE INDEX IF NOT EXISTS idx_group_members_user ON group_members(user_id)').catch(() => {});
        await client.query('CREATE INDEX IF NOT EXISTS idx_group_messages_group ON group_messages(group_id)').catch(() => {});
        await client.query('CREATE INDEX IF NOT EXISTS idx_channel_subs_channel ON channel_subscribers(channel_id)').catch(() => {});
        await client.query('CREATE INDEX IF NOT EXISTS idx_channel_subs_user ON channel_subscribers(user_id)').catch(() => {});
        await client.query('CREATE INDEX IF NOT EXISTS idx_channel_posts_channel ON channel_posts(channel_id)').catch(() => {});
        await client.query('CREATE INDEX IF NOT EXISTS idx_server_members_server ON server_members(server_id)').catch(() => {});
        await client.query('CREATE INDEX IF NOT EXISTS idx_server_members_user ON server_members(user_id)').catch(() => {});
        await client.query('CREATE INDEX IF NOT EXISTS idx_server_channels_server ON server_channels(server_id)').catch(() => {});
        await client.query('CREATE INDEX IF NOT EXISTS idx_server_messages_channel ON server_messages(channel_id)').catch(() => {});

        console.log('✅ PostgreSQL база данных инициализирована');
    } finally {
        client.release();
    }
}

// === ПОЛЬЗОВАТЕЛИ ===

async function createUser(username, password) {
    if (USE_SQLITE) {
        try {
            const existing = sqlite.prepare('SELECT id FROM users WHERE LOWER(username) = LOWER(?)').get(username);
            if (existing) {
                return { success: false, error: 'Пользователь уже существует' };
            }
            
            const hash = await bcrypt.hash(password, 12);
            const id = uuidv4();
            const tag = await generateUniqueTag();
            
            const adminUsernames = (process.env.ADMIN_USERNAMES || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
            const role = adminUsernames.includes(username.toLowerCase()) ? 'admin' : 'user';
            
            sqlite.prepare('INSERT INTO users (id, username, password, tag, role) VALUES (?, ?, ?, ?, ?)').run(id, username, hash, tag, role);
            
            if (role === 'admin') {
                console.log(`👑 Пользователь ${username} назначен админом`);
            }
            
            return { success: true, user: { id, username, tag } };
        } catch (error) {
            console.error('Create user error:', error);
            return { success: false, error: 'Ошибка создания пользователя' };
        }
    }
    
    const client = await pool.connect();
    try {
        const existing = await client.query('SELECT id FROM users WHERE LOWER(username) = LOWER($1)', [username]);
        if (existing.rows.length > 0) {
            return { success: false, error: 'Пользователь уже существует' };
        }
        
        const hash = await bcrypt.hash(password, 12);
        const id = uuidv4();
        const tag = await generateUniqueTag(client);
        
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
        let user;
        if (USE_SQLITE) {
            user = sqlite.prepare('SELECT id, username, password, tag, role, premium_until FROM users WHERE LOWER(username) = LOWER(?)').get(username);
        } else {
            const result = await pool.query(
                'SELECT id, username, password, tag, role, premium_until FROM users WHERE LOWER(username) = LOWER($1)',
                [username]
            );
            user = result.rows[0];
        }
        
        if (!user) {
            await bcrypt.compare(password, '$2a$12$dummy.hash.for.timing.attack.protection');
            return { success: false, error: 'Неверный логин или пароль' };
        }
        
        const isValid = await bcrypt.compare(password, user.password);
        if (!isValid) {
            return { success: false, error: 'Неверный логин или пароль' };
        }
        
        const adminUsernames = (process.env.ADMIN_USERNAMES || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
        let role = user.role;
        
        if (adminUsernames.includes(user.username.toLowerCase()) && role !== 'admin') {
            role = 'admin';
            if (USE_SQLITE) {
                sqlite.prepare('UPDATE users SET role = ? WHERE id = ?').run('admin', user.id);
            } else {
                await pool.query('UPDATE users SET role = $1 WHERE id = $2', ['admin', user.id]);
            }
            console.log(`👑 Пользователь ${user.username} повышен до админа`);
        }
        
        const isPremium = role === 'admin' || (user.premium_until && new Date(user.premium_until) > new Date());
        
        return { 
            success: true, 
            user: { id: user.id, username: user.username, tag: user.tag, role, isPremium } 
        };
    } catch (error) {
        console.error('Login error:', error);
        return { success: false, error: 'Ошибка входа' };
    }
}

async function getUser(userId) {
    try {
        let user;
        if (USE_SQLITE) {
            user = sqlite.prepare(`SELECT id, username, tag, role, premium_until, display_name, phone, bio, avatar_url, banner_url, 
                    name_color, profile_theme, profile_color, custom_id, hide_online, created_at FROM users WHERE id = ?`).get(userId);
        } else {
            const result = await pool.query(
                `SELECT id, username, tag, role, premium_until, display_name, phone, bio, avatar_url, banner_url, 
                        name_color, profile_theme, profile_color, custom_tag, custom_id, hide_online, created_at 
                 FROM users WHERE id = $1`,
                [userId]
            );
            user = result.rows[0];
        }
        if (!user) return null;
        user.isPremium = user.role === 'admin' || (user.premium_until && new Date(user.premium_until) > new Date());
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

async function setPremium(userId, days, plan = 'premium') {
    try {
        const premiumUntil = new Date();
        premiumUntil.setDate(premiumUntil.getDate() + days);
        
        await pool.query(
            'UPDATE users SET premium_until = $2, premium_plan = $3, updated_at = CURRENT_TIMESTAMP WHERE id = $1',
            [userId, premiumUntil, plan]
        );
        return { success: true, premiumUntil, plan };
    } catch (error) {
        console.error('Set premium error:', error);
        return { success: false, error: 'Ошибка выдачи премиума' };
    }
}

async function getAllUsers(limit = 50, offset = 0) {
    try {
        console.log('getAllUsers called with limit:', limit, 'offset:', offset);
        // Используем только базовые колонки которые точно есть
        const result = await pool.query(
            `SELECT id, username, tag, role, premium_until, display_name, avatar_url, created_at
             FROM users ORDER BY created_at DESC LIMIT $1 OFFSET $2`,
            [limit, offset]
        );
        console.log('getAllUsers query result rows:', result.rows.length);
        
        const countResult = await pool.query('SELECT COUNT(*) FROM users');
        console.log('getAllUsers total count:', countResult.rows[0].count);
        
        return {
            users: result.rows.map(u => ({
                ...u,
                custom_id: u.tag,
                isPremium: u.premium_until && new Date(u.premium_until) > new Date(),
                premiumPlan: 'premium' // По умолчанию premium, пока нет колонки
            })),
            total: parseInt(countResult.rows[0].count)
        };
    } catch (error) {
        console.error('Get all users error:', error);
        console.error('Error stack:', error.stack);
        return { users: [], total: 0 };
    }
}

async function removePremium(userId) {
    try {
        await pool.query(
            'UPDATE users SET premium_until = NULL, premium_plan = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = $1',
            [userId]
        );
        return { success: true };
    } catch (error) {
        console.error('Remove premium error:', error);
        return { success: false, error: 'Ошибка снятия премиума' };
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

// Premium: обновление настроек профиля
async function updatePremiumSettings(userId, data) {
    try {
        const { name_color, profile_theme, profile_color, custom_id, hide_online } = data;
        await pool.query(
            `UPDATE users SET 
                name_color = COALESCE($2, name_color),
                profile_theme = COALESCE($3, profile_theme),
                profile_color = COALESCE($4, profile_color),
                custom_id = COALESCE($5, custom_id),
                hide_online = COALESCE($6, hide_online),
                updated_at = CURRENT_TIMESTAMP
            WHERE id = $1`,
            [userId, name_color || null, profile_theme || null, profile_color || null, custom_id || null, hide_online]
        );
        return { success: true };
    } catch (error) {
        console.error('Update premium settings error:', error);
        return { success: false, error: 'Ошибка обновления' };
    }
}

// Проверка уникальности кастомного ID
async function isCustomIdAvailable(customId, excludeUserId) {
    try {
        const result = await pool.query(
            'SELECT id FROM users WHERE custom_id = $1 AND id != $2',
            [customId, excludeUserId]
        );
        return result.rows.length === 0;
    } catch (error) {
        console.error('Check custom id error:', error);
        return false;
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
        const sanitized = query.replace(/[%_]/g, '').substring(0, 50);
        if (sanitized.length < 2) return [];
        
        let rows;
        if (USE_SQLITE) {
            rows = sqlite.prepare(`SELECT id, username, tag, display_name, avatar_url, role, premium_until, name_color, custom_id
                FROM users 
                WHERE (username LIKE ? OR display_name LIKE ? OR custom_id LIKE ? OR tag LIKE ?) AND id != ?
                LIMIT 20`).all(`%${sanitized}%`, `%${sanitized}%`, `%${sanitized}%`, `%${sanitized}%`, excludeUserId);
        } else {
            const result = await pool.query(
                `SELECT id, username, tag, display_name, avatar_url, role, premium_until, name_color, custom_id
                 FROM users 
                 WHERE (username ILIKE $1 OR display_name ILIKE $1 OR custom_id ILIKE $1 OR tag ILIKE $1) AND id != $2
                 LIMIT 20`,
                [`%${sanitized}%`, excludeUserId]
            );
            rows = result.rows;
        }
        return rows.map(u => ({
            ...u,
            isPremium: u.role === 'admin' || (u.premium_until && new Date(u.premium_until) > new Date())
        }));
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
        
        if (USE_SQLITE) {
            sqlite.prepare(`INSERT INTO messages (id, sender_id, receiver_id, text, message_type, call_duration, created_at) 
                VALUES (?, ?, ?, ?, ?, ?, ?)`).run(id, senderId, receiverId, text, messageType, callDuration, created_at);
        } else {
            await pool.query(
                `INSERT INTO messages (id, sender_id, receiver_id, text, message_type, call_duration, created_at) 
                 VALUES ($1, $2, $3, $4, $5, $6, $7)`,
                [id, senderId, receiverId, text, messageType, callDuration, created_at]
            );
        }
        
        return { id, sender_id: senderId, receiver_id: receiverId, text, created_at, message_type: messageType, call_duration: callDuration };
    } catch (error) {
        console.error('Save message error:', error);
        throw error;
    }
}

async function getMessages(userId1, userId2, limit = 50, before = null) {
    try {
        let query = `
            SELECT id, sender_id, receiver_id, text, message_type, call_duration, created_at, updated_at
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
        const messages = result.rows.reverse();
        
        // Загружаем реакции
        if (messages.length > 0) {
            const messageIds = messages.map(m => m.id);
            const reactionsResult = await pool.query(
                `SELECT message_id, emoji, COUNT(*) as count, array_agg(user_id) as user_ids
                 FROM message_reactions WHERE message_id = ANY($1) GROUP BY message_id, emoji`,
                [messageIds]
            );
            const reactionsMap = {};
            for (const r of reactionsResult.rows) {
                if (!reactionsMap[r.message_id]) reactionsMap[r.message_id] = [];
                reactionsMap[r.message_id].push({ emoji: r.emoji, count: parseInt(r.count), user_ids: r.user_ids });
            }
            for (const msg of messages) msg.reactions = reactionsMap[msg.id] || [];
        }
        
        return messages;
    } catch (error) {
        console.error('Get messages error:', error);
        return [];
    }
}

async function getContacts(userId) {
    try {
        let rows;
        if (USE_SQLITE) {
            rows = sqlite.prepare(`
                SELECT DISTINCT u.id, u.username, u.tag, u.display_name, u.avatar_url, u.role, u.premium_until, u.name_color, u.custom_id,
                    (SELECT COUNT(*) FROM messages m WHERE m.sender_id = u.id AND m.receiver_id = ? AND m.is_read = 0) as unread_count,
                    (SELECT MAX(created_at) FROM messages m WHERE (m.sender_id = u.id AND m.receiver_id = ?) OR (m.sender_id = ? AND m.receiver_id = u.id)) as last_message_at
                FROM users u
                WHERE u.id IN (
                    SELECT DISTINCT sender_id FROM messages WHERE receiver_id = ?
                    UNION
                    SELECT DISTINCT receiver_id FROM messages WHERE sender_id = ?
                )
                ORDER BY last_message_at DESC
            `).all(userId, userId, userId, userId, userId);
        } else {
            const result = await pool.query(`
                SELECT DISTINCT u.id, u.username, u.tag, u.display_name, u.avatar_url, u.role, u.premium_until, u.name_color, u.custom_id,
                    (SELECT COUNT(*) FROM messages m WHERE m.sender_id = u.id AND m.receiver_id = $1 AND m.is_read = FALSE) as unread_count,
                    (SELECT MAX(created_at) FROM messages m WHERE (m.sender_id = u.id AND m.receiver_id = $1) OR (m.sender_id = $1 AND m.receiver_id = u.id)) as last_message_at
                FROM users u
                WHERE u.id IN (
                    SELECT DISTINCT sender_id FROM messages WHERE receiver_id = $1
                    UNION
                    SELECT DISTINCT receiver_id FROM messages WHERE sender_id = $1
                )
                ORDER BY last_message_at DESC NULLS LAST
            `, [userId]);
            rows = result.rows;
        }
        return rows.map(u => ({
            ...u,
            isPremium: u.role === 'admin' || (u.premium_until && new Date(u.premium_until) > new Date())
        }));
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
        
        let users, messages;
        
        if (USE_SQLITE) {
            users = sqlite.prepare(`SELECT id, username, tag, display_name, avatar_url 
                FROM users WHERE (username LIKE ? OR display_name LIKE ?) AND id != ? LIMIT 10`)
                .all(`%${sanitized}%`, `%${sanitized}%`, userId);
            
            messages = sqlite.prepare(`SELECT m.id, m.text, m.created_at, m.sender_id, m.receiver_id,
                    u.username as sender_username, u.display_name as sender_display_name, u.avatar_url as sender_avatar
                FROM messages m JOIN users u ON u.id = m.sender_id
                WHERE (m.sender_id = ? OR m.receiver_id = ?) AND m.text LIKE ? AND m.message_type = 'text'
                ORDER BY m.created_at DESC LIMIT 20`)
                .all(userId, userId, `%${sanitized}%`);
        } else {
            const usersResult = await pool.query(
                `SELECT id, username, tag, display_name, avatar_url 
                 FROM users WHERE (username ILIKE $1 OR display_name ILIKE $1) AND id != $2 LIMIT 10`,
                [`%${sanitized}%`, userId]
            );
            users = usersResult.rows;
            
            const messagesResult = await pool.query(
                `SELECT m.id, m.text, m.created_at, m.sender_id, m.receiver_id,
                        u.username as sender_username, u.display_name as sender_display_name, u.avatar_url as sender_avatar
                 FROM messages m JOIN users u ON u.id = m.sender_id
                 WHERE (m.sender_id = $1 OR m.receiver_id = $1) AND m.text ILIKE $2 AND m.message_type = 'text'
                 ORDER BY m.created_at DESC LIMIT 20`,
                [userId, `%${sanitized}%`]
            );
            messages = messagesResult.rows;
        }
        
        return { users, messages };
    } catch (error) {
        console.error('Global search error:', error);
        return { users: [], messages: [] };
    }
}

// === СООБЩЕНИЯ: редактирование и удаление ===

async function editMessage(messageId, userId, newText) {
    try {
        const result = await pool.query(
            `UPDATE messages SET text = $3, updated_at = CURRENT_TIMESTAMP 
             WHERE id = $1 AND sender_id = $2 
             RETURNING id, text, updated_at`,
            [messageId, userId, newText]
        );
        if (result.rows.length === 0) {
            return { success: false, error: 'Сообщение не найдено или нет прав' };
        }
        return { success: true, message: result.rows[0] };
    } catch (error) {
        console.error('Edit message error:', error);
        return { success: false, error: 'Ошибка редактирования' };
    }
}

async function deleteMessage(messageId, odataId) {
    try {
        const result = await pool.query(
            'DELETE FROM messages WHERE id = $1 AND sender_id = $2 RETURNING id',
            [messageId, odataId]
        );
        if (result.rows.length === 0) {
            return { success: false, error: 'Сообщение не найдено или нет прав' };
        }
        return { success: true };
    } catch (error) {
        console.error('Delete message error:', error);
        return { success: false, error: 'Ошибка удаления' };
    }
}

// === РЕАКЦИИ НА СООБЩЕНИЯ ===

async function addReaction(messageId, odataId, emoji) {
    try {
        await pool.query(
            `INSERT INTO message_reactions (id, message_id, user_id, emoji) 
             VALUES ($1, $2, $3, $4)
             ON CONFLICT (message_id, user_id, emoji) DO NOTHING`,
            [uuidv4(), messageId, odataId, emoji]
        );
        return { success: true };
    } catch (error) {
        console.error('Add reaction error:', error);
        return { success: false };
    }
}

async function removeReaction(messageId, odataId, emoji) {
    try {
        await pool.query(
            'DELETE FROM message_reactions WHERE message_id = $1 AND user_id = $2 AND emoji = $3',
            [messageId, odataId, emoji]
        );
        return { success: true };
    } catch (error) {
        console.error('Remove reaction error:', error);
        return { success: false };
    }
}

async function getMessageReactions(messageId) {
    try {
        const result = await pool.query(
            `SELECT emoji, COUNT(*) as count, 
                    array_agg(user_id) as user_ids
             FROM message_reactions 
             WHERE message_id = $1 
             GROUP BY emoji`,
            [messageId]
        );
        return result.rows;
    } catch (error) {
        console.error('Get reactions error:', error);
        return [];
    }
}

// === НАСТРОЙКИ ПОЛЬЗОВАТЕЛЯ ===

async function getUserSettings(userId) {
    try {
        const result = await pool.query(
            'SELECT settings FROM users WHERE id = $1',
            [userId]
        );
        if (result.rows.length === 0) return {};
        return result.rows[0].settings || {};
    } catch (error) {
        console.error('Get user settings error:', error);
        return {};
    }
}

async function saveUserSettings(userId, settings) {
    try {
        await pool.query(
            'UPDATE users SET settings = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $1',
            [userId, JSON.stringify(settings)]
        );
        return { success: true };
    } catch (error) {
        console.error('Save user settings error:', error);
        return { success: false, error: 'Ошибка сохранения настроек' };
    }
}

// === ГРУППОВЫЕ ЧАТЫ ===

async function createGroup(ownerId, name, memberIds = [], description = '', avatarUrl = null) {
    try {
        const id = uuidv4();
        const created_at = new Date().toISOString();
        
        if (USE_SQLITE) {
            sqlite.prepare('INSERT INTO group_chats (id, name, description, avatar_url, owner_id, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(id, name, description, avatarUrl, ownerId, created_at);
            sqlite.prepare('INSERT INTO group_members (id, group_id, user_id, role) VALUES (?, ?, ?, ?)').run(uuidv4(), id, ownerId, 'admin');
            for (const memberId of memberIds) {
                if (memberId !== ownerId) {
                    sqlite.prepare('INSERT INTO group_members (id, group_id, user_id, role) VALUES (?, ?, ?, ?)').run(uuidv4(), id, memberId, 'member');
                }
            }
        } else {
            await pool.query('INSERT INTO group_chats (id, name, description, avatar_url, owner_id, created_at) VALUES ($1, $2, $3, $4, $5, $6)', [id, name, description, avatarUrl, ownerId, created_at]);
            await pool.query('INSERT INTO group_members (id, group_id, user_id, role) VALUES ($1, $2, $3, $4)', [uuidv4(), id, ownerId, 'admin']);
            for (const memberId of memberIds) {
                if (memberId !== ownerId) {
                    await pool.query('INSERT INTO group_members (id, group_id, user_id, role) VALUES ($1, $2, $3, $4)', [uuidv4(), id, memberId, 'member']);
                }
            }
        }
        
        return { success: true, group: { id, name, description, avatar_url: avatarUrl, owner_id: ownerId, created_at } };
    } catch (error) {
        console.error('Create group error:', error);
        return { success: false, error: 'Ошибка создания группы' };
    }
}

async function getGroup(groupId) {
    try {
        let group;
        if (USE_SQLITE) {
            group = sqlite.prepare('SELECT * FROM group_chats WHERE id = ?').get(groupId);
        } else {
            const result = await pool.query('SELECT * FROM group_chats WHERE id = $1', [groupId]);
            group = result.rows[0];
        }
        return group || null;
    } catch (error) {
        console.error('Get group error:', error);
        return null;
    }
}

async function getGroupMembers(groupId) {
    try {
        let members;
        if (USE_SQLITE) {
            members = sqlite.prepare(`
                SELECT gm.*, u.username, u.display_name, u.avatar_url, u.tag
                FROM group_members gm
                JOIN users u ON u.id = gm.user_id
                WHERE gm.group_id = ?
            `).all(groupId);
        } else {
            const result = await pool.query(`
                SELECT gm.*, u.username, u.display_name, u.avatar_url, u.tag
                FROM group_members gm
                JOIN users u ON u.id = gm.user_id
                WHERE gm.group_id = $1
            `, [groupId]);
            members = result.rows;
        }
        return members;
    } catch (error) {
        console.error('Get group members error:', error);
        return [];
    }
}

async function getUserGroups(userId) {
    try {
        let groups;
        if (USE_SQLITE) {
            groups = sqlite.prepare(`
                SELECT g.*, gm.role as my_role,
                    (SELECT COUNT(*) FROM group_members WHERE group_id = g.id) as member_count
                FROM group_chats g
                JOIN group_members gm ON gm.group_id = g.id AND gm.user_id = ?
                ORDER BY g.created_at DESC
            `).all(userId);
        } else {
            const result = await pool.query(`
                SELECT g.*, gm.role as my_role,
                    (SELECT COUNT(*) FROM group_members WHERE group_id = g.id) as member_count
                FROM group_chats g
                JOIN group_members gm ON gm.group_id = g.id AND gm.user_id = $1
                ORDER BY g.created_at DESC
            `, [userId]);
            groups = result.rows;
        }
        return groups;
    } catch (error) {
        console.error('Get user groups error:', error);
        return [];
    }
}

async function addGroupMember(groupId, userId, role = 'member') {
    try {
        const id = uuidv4();
        if (USE_SQLITE) {
            sqlite.prepare('INSERT OR IGNORE INTO group_members (id, group_id, user_id, role) VALUES (?, ?, ?, ?)').run(id, groupId, userId, role);
        } else {
            await pool.query('INSERT INTO group_members (id, group_id, user_id, role) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING', [id, groupId, userId, role]);
        }
        return { success: true };
    } catch (error) {
        console.error('Add group member error:', error);
        return { success: false };
    }
}

async function removeGroupMember(groupId, userId) {
    try {
        if (USE_SQLITE) {
            sqlite.prepare('DELETE FROM group_members WHERE group_id = ? AND user_id = ?').run(groupId, userId);
        } else {
            await pool.query('DELETE FROM group_members WHERE group_id = $1 AND user_id = $2', [groupId, userId]);
        }
        return { success: true };
    } catch (error) {
        console.error('Remove group member error:', error);
        return { success: false };
    }
}

async function saveGroupMessage(groupId, senderId, text, messageType = 'text') {
    try {
        const id = uuidv4();
        const created_at = new Date().toISOString();
        
        if (USE_SQLITE) {
            sqlite.prepare('INSERT INTO group_messages (id, group_id, sender_id, text, message_type, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(id, groupId, senderId, text, messageType, created_at);
        } else {
            await pool.query('INSERT INTO group_messages (id, group_id, sender_id, text, message_type, created_at) VALUES ($1, $2, $3, $4, $5, $6)', [id, groupId, senderId, text, messageType, created_at]);
        }
        
        return { id, group_id: groupId, sender_id: senderId, text, message_type: messageType, created_at };
    } catch (error) {
        console.error('Save group message error:', error);
        throw error;
    }
}

async function getGroupMessages(groupId, limit = 50, before = null) {
    try {
        let messages;
        if (USE_SQLITE) {
            if (before) {
                messages = sqlite.prepare(`
                    SELECT gm.*, u.username, u.display_name, u.avatar_url
                    FROM group_messages gm
                    JOIN users u ON u.id = gm.sender_id
                    WHERE gm.group_id = ? AND gm.created_at < ?
                    ORDER BY gm.created_at DESC LIMIT ?
                `).all(groupId, before, limit);
            } else {
                messages = sqlite.prepare(`
                    SELECT gm.*, u.username, u.display_name, u.avatar_url
                    FROM group_messages gm
                    JOIN users u ON u.id = gm.sender_id
                    WHERE gm.group_id = ?
                    ORDER BY gm.created_at DESC LIMIT ?
                `).all(groupId, limit);
            }
        } else {
            const params = before ? [groupId, before, limit] : [groupId, limit];
            const query = before 
                ? `SELECT gm.*, u.username, u.display_name, u.avatar_url FROM group_messages gm JOIN users u ON u.id = gm.sender_id WHERE gm.group_id = $1 AND gm.created_at < $2 ORDER BY gm.created_at DESC LIMIT $3`
                : `SELECT gm.*, u.username, u.display_name, u.avatar_url FROM group_messages gm JOIN users u ON u.id = gm.sender_id WHERE gm.group_id = $1 ORDER BY gm.created_at DESC LIMIT $2`;
            const result = await pool.query(query, params);
            messages = result.rows;
        }
        return messages.reverse();
    } catch (error) {
        console.error('Get group messages error:', error);
        return [];
    }
}

// === КАНАЛЫ (Telegram-style) ===

async function createChannel(ownerId, name, description = '', isPublic = true, avatarUrl = null) {
    try {
        const id = uuidv4();
        const created_at = new Date().toISOString();
        
        if (USE_SQLITE) {
            sqlite.prepare('INSERT INTO channels (id, name, description, avatar_url, owner_id, is_public, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, name, description, avatarUrl, ownerId, isPublic ? 1 : 0, created_at);
            sqlite.prepare('INSERT INTO channel_admins (id, channel_id, user_id) VALUES (?, ?, ?)').run(uuidv4(), id, ownerId);
            sqlite.prepare('INSERT INTO channel_subscribers (id, channel_id, user_id) VALUES (?, ?, ?)').run(uuidv4(), id, ownerId);
        } else {
            await pool.query('INSERT INTO channels (id, name, description, avatar_url, owner_id, is_public, subscriber_count, created_at) VALUES ($1, $2, $3, $4, $5, $6, 1, $7)', [id, name, description, avatarUrl, ownerId, isPublic, created_at]);
            await pool.query('INSERT INTO channel_admins (id, channel_id, user_id) VALUES ($1, $2, $3)', [uuidv4(), id, ownerId]);
            await pool.query('INSERT INTO channel_subscribers (id, channel_id, user_id) VALUES ($1, $2, $3)', [uuidv4(), id, ownerId]);
        }
        
        return { success: true, channel: { id, name, description, avatar_url: avatarUrl, owner_id: ownerId, is_public: isPublic, subscriber_count: 1, created_at } };
    } catch (error) {
        console.error('Create channel error:', error);
        return { success: false, error: 'Ошибка создания канала' };
    }
}

async function getChannel(channelId) {
    try {
        let channel;
        if (USE_SQLITE) {
            channel = sqlite.prepare('SELECT * FROM channels WHERE id = ?').get(channelId);
        } else {
            const result = await pool.query('SELECT * FROM channels WHERE id = $1', [channelId]);
            channel = result.rows[0];
        }
        return channel || null;
    } catch (error) {
        console.error('Get channel error:', error);
        return null;
    }
}

async function getUserChannels(userId) {
    try {
        let channels;
        if (USE_SQLITE) {
            channels = sqlite.prepare(`
                SELECT c.*, 
                    CASE WHEN ca.user_id IS NOT NULL THEN 1 ELSE 0 END as is_admin,
                    CASE WHEN c.owner_id = ? THEN 1 ELSE 0 END as is_owner
                FROM channels c
                JOIN channel_subscribers cs ON cs.channel_id = c.id AND cs.user_id = ?
                LEFT JOIN channel_admins ca ON ca.channel_id = c.id AND ca.user_id = ?
                ORDER BY c.created_at DESC
            `).all(userId, userId, userId);
        } else {
            const result = await pool.query(`
                SELECT c.*, 
                    CASE WHEN ca.user_id IS NOT NULL THEN true ELSE false END as is_admin,
                    CASE WHEN c.owner_id = $1 THEN true ELSE false END as is_owner
                FROM channels c
                JOIN channel_subscribers cs ON cs.channel_id = c.id AND cs.user_id = $1
                LEFT JOIN channel_admins ca ON ca.channel_id = c.id AND ca.user_id = $1
                ORDER BY c.created_at DESC
            `, [userId]);
            channels = result.rows;
        }
        return channels;
    } catch (error) {
        console.error('Get user channels error:', error);
        return [];
    }
}

async function subscribeToChannel(channelId, userId) {
    try {
        const id = uuidv4();
        if (USE_SQLITE) {
            sqlite.prepare('INSERT OR IGNORE INTO channel_subscribers (id, channel_id, user_id) VALUES (?, ?, ?)').run(id, channelId, userId);
            sqlite.prepare('UPDATE channels SET subscriber_count = subscriber_count + 1 WHERE id = ?').run(channelId);
        } else {
            await pool.query('INSERT INTO channel_subscribers (id, channel_id, user_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [id, channelId, userId]);
            await pool.query('UPDATE channels SET subscriber_count = subscriber_count + 1 WHERE id = $1', [channelId]);
        }
        return { success: true };
    } catch (error) {
        console.error('Subscribe to channel error:', error);
        return { success: false };
    }
}

async function unsubscribeFromChannel(channelId, userId) {
    try {
        if (USE_SQLITE) {
            sqlite.prepare('DELETE FROM channel_subscribers WHERE channel_id = ? AND user_id = ?').run(channelId, userId);
            sqlite.prepare('UPDATE channels SET subscriber_count = MAX(0, subscriber_count - 1) WHERE id = ?').run(channelId);
        } else {
            await pool.query('DELETE FROM channel_subscribers WHERE channel_id = $1 AND user_id = $2', [channelId, userId]);
            await pool.query('UPDATE channels SET subscriber_count = GREATEST(0, subscriber_count - 1) WHERE id = $1', [channelId]);
        }
        return { success: true };
    } catch (error) {
        console.error('Unsubscribe from channel error:', error);
        return { success: false };
    }
}

async function createChannelPost(channelId, authorId, text, mediaUrl = null, mediaType = null) {
    try {
        const id = uuidv4();
        const created_at = new Date().toISOString();
        
        if (USE_SQLITE) {
            sqlite.prepare('INSERT INTO channel_posts (id, channel_id, author_id, text, media_url, media_type, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, channelId, authorId, text, mediaUrl, mediaType, created_at);
        } else {
            await pool.query('INSERT INTO channel_posts (id, channel_id, author_id, text, media_url, media_type, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7)', [id, channelId, authorId, text, mediaUrl, mediaType, created_at]);
        }
        
        return { id, channel_id: channelId, author_id: authorId, text, media_url: mediaUrl, media_type: mediaType, views: 0, created_at };
    } catch (error) {
        console.error('Create channel post error:', error);
        throw error;
    }
}

async function getChannelPosts(channelId, limit = 20, before = null) {
    try {
        let posts;
        if (USE_SQLITE) {
            if (before) {
                posts = sqlite.prepare(`SELECT cp.*, u.username, u.display_name, u.avatar_url FROM channel_posts cp JOIN users u ON u.id = cp.author_id WHERE cp.channel_id = ? AND cp.created_at < ? ORDER BY cp.created_at DESC LIMIT ?`).all(channelId, before, limit);
            } else {
                posts = sqlite.prepare(`SELECT cp.*, u.username, u.display_name, u.avatar_url FROM channel_posts cp JOIN users u ON u.id = cp.author_id WHERE cp.channel_id = ? ORDER BY cp.created_at DESC LIMIT ?`).all(channelId, limit);
            }
        } else {
            const params = before ? [channelId, before, limit] : [channelId, limit];
            const query = before 
                ? `SELECT cp.*, u.username, u.display_name, u.avatar_url FROM channel_posts cp JOIN users u ON u.id = cp.author_id WHERE cp.channel_id = $1 AND cp.created_at < $2 ORDER BY cp.created_at DESC LIMIT $3`
                : `SELECT cp.*, u.username, u.display_name, u.avatar_url FROM channel_posts cp JOIN users u ON u.id = cp.author_id WHERE cp.channel_id = $1 ORDER BY cp.created_at DESC LIMIT $2`;
            const result = await pool.query(query, params);
            posts = result.rows;
        }
        return posts.reverse();
    } catch (error) {
        console.error('Get channel posts error:', error);
        return [];
    }
}

// === СЕРВЕРЫ (Discord-style) ===

async function createServer(ownerId, name, description = '', iconUrl = null) {
    try {
        const id = uuidv4();
        const created_at = new Date().toISOString();
        
        if (USE_SQLITE) {
            sqlite.prepare('INSERT INTO servers (id, name, description, icon_url, owner_id, member_count, created_at) VALUES (?, ?, ?, ?, ?, 1, ?)').run(id, name, description, iconUrl, ownerId, created_at);
            const everyoneRoleId = uuidv4();
            sqlite.prepare('INSERT INTO server_roles (id, server_id, name, is_default, position) VALUES (?, ?, ?, 1, 0)').run(everyoneRoleId, id, '@everyone');
            sqlite.prepare('INSERT INTO server_members (id, server_id, user_id) VALUES (?, ?, ?)').run(uuidv4(), id, ownerId);
            const categoryId = uuidv4();
            sqlite.prepare('INSERT INTO server_categories (id, server_id, name, position) VALUES (?, ?, ?, 0)').run(categoryId, id, 'Текстовые каналы');
            sqlite.prepare('INSERT INTO server_channels (id, server_id, category_id, name, type, position) VALUES (?, ?, ?, ?, ?, 0)').run(uuidv4(), id, categoryId, 'общий', 'text');
        } else {
            await pool.query('INSERT INTO servers (id, name, description, icon_url, owner_id, member_count, created_at) VALUES ($1, $2, $3, $4, $5, 1, $6)', [id, name, description, iconUrl, ownerId, created_at]);
            const everyoneRoleId = uuidv4();
            await pool.query('INSERT INTO server_roles (id, server_id, name, is_default, position) VALUES ($1, $2, $3, true, 0)', [everyoneRoleId, id, '@everyone']);
            await pool.query('INSERT INTO server_members (id, server_id, user_id) VALUES ($1, $2, $3)', [uuidv4(), id, ownerId]);
            const categoryId = uuidv4();
            await pool.query('INSERT INTO server_categories (id, server_id, name, position) VALUES ($1, $2, $3, 0)', [categoryId, id, 'Текстовые каналы']);
            await pool.query('INSERT INTO server_channels (id, server_id, category_id, name, type, position) VALUES ($1, $2, $3, $4, $5, 0)', [uuidv4(), id, categoryId, 'общий', 'text']);
        }
        
        return { success: true, server: { id, name, description, icon_url: iconUrl, owner_id: ownerId, member_count: 1, created_at } };
    } catch (error) {
        console.error('Create server error:', error);
        return { success: false, error: 'Ошибка создания сервера' };
    }
}

async function getServer(serverId) {
    try {
        let server;
        if (USE_SQLITE) {
            server = sqlite.prepare('SELECT * FROM servers WHERE id = ?').get(serverId);
        } else {
            const result = await pool.query('SELECT * FROM servers WHERE id = $1', [serverId]);
            server = result.rows[0];
        }
        return server || null;
    } catch (error) {
        console.error('Get server error:', error);
        return null;
    }
}

async function getUserServers(userId) {
    try {
        let servers;
        if (USE_SQLITE) {
            servers = sqlite.prepare(`
                SELECT s.*, CASE WHEN s.owner_id = ? THEN 1 ELSE 0 END as is_owner
                FROM servers s
                JOIN server_members sm ON sm.server_id = s.id AND sm.user_id = ?
                ORDER BY s.created_at DESC
            `).all(userId, userId);
        } else {
            const result = await pool.query(`
                SELECT s.*, CASE WHEN s.owner_id = $1 THEN true ELSE false END as is_owner
                FROM servers s
                JOIN server_members sm ON sm.server_id = s.id AND sm.user_id = $1
                ORDER BY s.created_at DESC
            `, [userId]);
            servers = result.rows;
        }
        return servers;
    } catch (error) {
        console.error('Get user servers error:', error);
        return [];
    }
}

async function joinServer(serverId, userId) {
    try {
        const id = uuidv4();
        if (USE_SQLITE) {
            sqlite.prepare('INSERT OR IGNORE INTO server_members (id, server_id, user_id) VALUES (?, ?, ?)').run(id, serverId, userId);
            sqlite.prepare('UPDATE servers SET member_count = member_count + 1 WHERE id = ?').run(serverId);
        } else {
            await pool.query('INSERT INTO server_members (id, server_id, user_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [id, serverId, userId]);
            await pool.query('UPDATE servers SET member_count = member_count + 1 WHERE id = $1', [serverId]);
        }
        return { success: true };
    } catch (error) {
        console.error('Join server error:', error);
        return { success: false };
    }
}

async function leaveServer(serverId, userId) {
    try {
        if (USE_SQLITE) {
            sqlite.prepare('DELETE FROM server_members WHERE server_id = ? AND user_id = ?').run(serverId, userId);
            sqlite.prepare('UPDATE servers SET member_count = MAX(0, member_count - 1) WHERE id = ?').run(serverId);
        } else {
            await pool.query('DELETE FROM server_members WHERE server_id = $1 AND user_id = $2', [serverId, userId]);
            await pool.query('UPDATE servers SET member_count = GREATEST(0, member_count - 1) WHERE id = $1', [serverId]);
        }
        return { success: true };
    } catch (error) {
        console.error('Leave server error:', error);
        return { success: false };
    }
}

async function getServerChannels(serverId) {
    try {
        let channels, categories;
        if (USE_SQLITE) {
            categories = sqlite.prepare('SELECT * FROM server_categories WHERE server_id = ? ORDER BY position').all(serverId);
            channels = sqlite.prepare('SELECT * FROM server_channels WHERE server_id = ? ORDER BY position').all(serverId);
        } else {
            const catResult = await pool.query('SELECT * FROM server_categories WHERE server_id = $1 ORDER BY position', [serverId]);
            const chanResult = await pool.query('SELECT * FROM server_channels WHERE server_id = $1 ORDER BY position', [serverId]);
            categories = catResult.rows;
            channels = chanResult.rows;
        }
        return { categories, channels };
    } catch (error) {
        console.error('Get server channels error:', error);
        return { categories: [], channels: [] };
    }
}

async function createServerChannel(serverId, categoryId, name, type = 'text') {
    try {
        const id = uuidv4();
        if (USE_SQLITE) {
            const maxPos = sqlite.prepare('SELECT MAX(position) as max FROM server_channels WHERE server_id = ?').get(serverId);
            const position = (maxPos?.max || 0) + 1;
            sqlite.prepare('INSERT INTO server_channels (id, server_id, category_id, name, type, position) VALUES (?, ?, ?, ?, ?, ?)').run(id, serverId, categoryId, name, type, position);
        } else {
            const maxPos = await pool.query('SELECT MAX(position) as max FROM server_channels WHERE server_id = $1', [serverId]);
            const position = (maxPos.rows[0]?.max || 0) + 1;
            await pool.query('INSERT INTO server_channels (id, server_id, category_id, name, type, position) VALUES ($1, $2, $3, $4, $5, $6)', [id, serverId, categoryId, name, type, position]);
        }
        return { success: true, channel: { id, server_id: serverId, category_id: categoryId, name, type } };
    } catch (error) {
        console.error('Create server channel error:', error);
        return { success: false };
    }
}

async function saveServerMessage(channelId, senderId, text, messageType = 'text') {
    try {
        const id = uuidv4();
        const created_at = new Date().toISOString();
        
        if (USE_SQLITE) {
            sqlite.prepare('INSERT INTO server_messages (id, channel_id, sender_id, text, message_type, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(id, channelId, senderId, text, messageType, created_at);
        } else {
            await pool.query('INSERT INTO server_messages (id, channel_id, sender_id, text, message_type, created_at) VALUES ($1, $2, $3, $4, $5, $6)', [id, channelId, senderId, text, messageType, created_at]);
        }
        
        return { id, channel_id: channelId, sender_id: senderId, text, message_type: messageType, created_at };
    } catch (error) {
        console.error('Save server message error:', error);
        throw error;
    }
}

async function getServerMessages(channelId, limit = 50, before = null) {
    try {
        let messages;
        if (USE_SQLITE) {
            if (before) {
                messages = sqlite.prepare(`SELECT sm.*, u.username, u.display_name, u.avatar_url FROM server_messages sm JOIN users u ON u.id = sm.sender_id WHERE sm.channel_id = ? AND sm.created_at < ? ORDER BY sm.created_at DESC LIMIT ?`).all(channelId, before, limit);
            } else {
                messages = sqlite.prepare(`SELECT sm.*, u.username, u.display_name, u.avatar_url FROM server_messages sm JOIN users u ON u.id = sm.sender_id WHERE sm.channel_id = ? ORDER BY sm.created_at DESC LIMIT ?`).all(channelId, limit);
            }
        } else {
            const params = before ? [channelId, before, limit] : [channelId, limit];
            const query = before 
                ? `SELECT sm.*, u.username, u.display_name, u.avatar_url FROM server_messages sm JOIN users u ON u.id = sm.sender_id WHERE sm.channel_id = $1 AND sm.created_at < $2 ORDER BY sm.created_at DESC LIMIT $3`
                : `SELECT sm.*, u.username, u.display_name, u.avatar_url FROM server_messages sm JOIN users u ON u.id = sm.sender_id WHERE sm.channel_id = $1 ORDER BY sm.created_at DESC LIMIT $2`;
            const result = await pool.query(query, params);
            messages = result.rows;
        }
        return messages.reverse();
    } catch (error) {
        console.error('Get server messages error:', error);
        return [];
    }
}

async function getServerMembers(serverId) {
    try {
        let members;
        if (USE_SQLITE) {
            members = sqlite.prepare(`
                SELECT sm.*, u.username, u.display_name, u.avatar_url, u.tag
                FROM server_members sm
                JOIN users u ON u.id = sm.user_id
                WHERE sm.server_id = ?
            `).all(serverId);
        } else {
            const result = await pool.query(`
                SELECT sm.*, u.username, u.display_name, u.avatar_url, u.tag
                FROM server_members sm
                JOIN users u ON u.id = sm.user_id
                WHERE sm.server_id = $1
            `, [serverId]);
            members = result.rows;
        }
        return members;
    } catch (error) {
        console.error('Get server members error:', error);
        return [];
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
    removePremium,
    getAllUsers,
    deleteUser,
    // Поиск
    globalSearch,
    // Premium
    updatePremiumSettings,
    isCustomIdAvailable,
    // Сообщения
    editMessage,
    deleteMessage,
    addReaction,
    removeReaction,
    getMessageReactions,
    // Настройки
    getUserSettings,
    saveUserSettings,
    // Групповые чаты
    createGroup,
    getGroup,
    getGroupMembers,
    getUserGroups,
    addGroupMember,
    removeGroupMember,
    saveGroupMessage,
    getGroupMessages,
    // Каналы
    createChannel,
    getChannel,
    getUserChannels,
    subscribeToChannel,
    unsubscribeFromChannel,
    createChannelPost,
    getChannelPosts,
    // Серверы
    createServer,
    getServer,
    getUserServers,
    joinServer,
    leaveServer,
    getServerChannels,
    createServerChannel,
    saveServerMessage,
    getServerMessages,
    getServerMembers
};
