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
        max: 5, // Уменьшаем количество подключений для бесплатного плана
        idleTimeoutMillis: 60000, // 60 секунд простоя
        connectionTimeoutMillis: 30000, // 30 секунд на подключение
        acquireTimeoutMillis: 60000, // 60 секунд на получение подключения
        statement_timeout: 30000, // 30 секунд на выполнение запроса
        query_timeout: 30000 // 30 секунд на запрос
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

async function initDB(retryCount = 0) {
    const maxRetries = 3;
    
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
                bubble_style TEXT DEFAULT 'default',
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

        // === ЗАКРЕПЛЁННЫЕ ЧАТЫ ===
        sqlite.exec(`
            CREATE TABLE IF NOT EXISTS pinned_chats (
                id TEXT PRIMARY KEY,
                user_id TEXT NOT NULL,
                chat_id TEXT NOT NULL,
                chat_type TEXT DEFAULT 'user',
                pinned_at TEXT DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(user_id, chat_id, chat_type),
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
            )
        `);
        try { sqlite.exec('CREATE INDEX idx_pinned_chats_user ON pinned_chats(user_id)'); } catch {}
        
        // Миграция: добавляем self_destruct_at в messages
        try { sqlite.exec('ALTER TABLE messages ADD COLUMN self_destruct_at TEXT'); } catch {}
        
        // Миграция: добавляем reply_to_id в messages
        try { sqlite.exec('ALTER TABLE messages ADD COLUMN reply_to_id TEXT'); } catch {}
        
        // Миграция: добавляем premium_plan в users
        try { sqlite.exec("ALTER TABLE users ADD COLUMN premium_plan TEXT DEFAULT 'premium'"); } catch {}
        
        // Миграция: делаем все серверы публичными
        try { sqlite.exec('UPDATE servers SET is_public = 1 WHERE is_public = 0'); } catch {}
        
        // Миграция: добавляем invite_slug для каналов и серверов
        try { sqlite.exec('ALTER TABLE channels ADD COLUMN invite_slug TEXT UNIQUE'); } catch {}
        try { sqlite.exec('ALTER TABLE servers ADD COLUMN invite_slug TEXT UNIQUE'); } catch {}
        
        // === СТАТИСТИКА ПОЛЬЗОВАТЕЛЕЙ ===
        sqlite.exec(`
            CREATE TABLE IF NOT EXISTS user_stats (
                user_id TEXT PRIMARY KEY,
                messages_sent INTEGER DEFAULT 0,
                time_online INTEGER DEFAULT 0,
                call_minutes INTEGER DEFAULT 0,
                reactions_given INTEGER DEFAULT 0,
                files_sent INTEGER DEFAULT 0,
                last_online TEXT,
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
            )
        `);
        
        console.log('✅ SQLite база данных инициализирована');
        return;
    }
    
    // PostgreSQL инициализация с retry логикой
    let client;
    let retries = 3;
    
    while (retries > 0) {
        try {
            console.log(`🔄 Попытка подключения к PostgreSQL (осталось попыток: ${retries})`);
            client = await pool.connect();
            console.log('✅ Подключение к PostgreSQL установлено');
            break;
        } catch (error) {
            retries--;
            console.error(`❌ Ошибка подключения к PostgreSQL:`, error.message);
            
            if (retries === 0) {
                console.error('💥 Не удалось подключиться к PostgreSQL после 3 попыток');
                throw error;
            }
            
            console.log(`⏳ Ожидание 5 секунд перед повторной попыткой...`);
            await new Promise(resolve => setTimeout(resolve, 5000));
        }
    }
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
            'ALTER TABLE users ADD COLUMN IF NOT EXISTS premium_plan TEXT DEFAULT \'premium\'',
            'ALTER TABLE users ADD COLUMN IF NOT EXISTS name_color TEXT',
            'ALTER TABLE users ADD COLUMN IF NOT EXISTS profile_theme TEXT DEFAULT \'default\'',
            'ALTER TABLE users ADD COLUMN IF NOT EXISTS profile_color TEXT',
            'ALTER TABLE users ADD COLUMN IF NOT EXISTS custom_tag TEXT',
            'ALTER TABLE users ADD COLUMN IF NOT EXISTS custom_id TEXT',
            'ALTER TABLE users ADD COLUMN IF NOT EXISTS bubble_style TEXT DEFAULT \'default\'',
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
        await client.query('ALTER TABLE messages ADD COLUMN IF NOT EXISTS self_destruct_at TIMESTAMP').catch(() => {});
        await client.query('ALTER TABLE messages ADD COLUMN IF NOT EXISTS reply_to_id TEXT').catch(() => {});

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

        // === ЗАКРЕПЛЁННЫЕ ЧАТЫ ===
        await client.query(`
            CREATE TABLE IF NOT EXISTS pinned_chats (
                id TEXT PRIMARY KEY,
                user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                chat_id TEXT NOT NULL,
                chat_type TEXT DEFAULT 'user',
                pinned_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(user_id, chat_id, chat_type)
            )
        `);
        await client.query('CREATE INDEX IF NOT EXISTS idx_pinned_chats_user ON pinned_chats(user_id)').catch(() => {});

        // Миграция: делаем все серверы публичными
        await client.query('UPDATE servers SET is_public = true WHERE is_public = false').catch(() => {});

        // Миграция: добавляем invite_slug для каналов и серверов
        await client.query('ALTER TABLE channels ADD COLUMN IF NOT EXISTS invite_slug TEXT UNIQUE').catch(() => {});
        await client.query('ALTER TABLE servers ADD COLUMN IF NOT EXISTS invite_slug TEXT UNIQUE').catch(() => {});

        // === СТАТИСТИКА ПОЛЬЗОВАТЕЛЕЙ ===
        await client.query(`
            CREATE TABLE IF NOT EXISTS user_stats (
                user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
                messages_sent INTEGER DEFAULT 0,
                time_online INTEGER DEFAULT 0,
                call_minutes INTEGER DEFAULT 0,
                reactions_given INTEGER DEFAULT 0,
                files_sent INTEGER DEFAULT 0,
                last_online TIMESTAMP
            )
        `);

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
            user = sqlite.prepare(`SELECT id, username, tag, role, premium_until, premium_plan, display_name, phone, bio, avatar_url, banner_url, 
                    name_color, profile_theme, profile_color, custom_id, bubble_style, hide_online, created_at FROM users WHERE id = ?`).get(userId);
        } else {
            const result = await pool.query(
                `SELECT id, username, tag, role, premium_until, premium_plan, display_name, phone, bio, avatar_url, banner_url, 
                        name_color, profile_theme, profile_color, custom_tag, custom_id, bubble_style, hide_online, created_at 
                 FROM users WHERE id = $1`,
                [userId]
            );
            user = result.rows[0];
        }
        if (!user) return null;
        user.isPremium = user.premium_until && new Date(user.premium_until) > new Date();
        user.premiumPlan = user.premium_plan || 'premium';
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
            `SELECT id, username, tag, role, premium_until, premium_plan, display_name, avatar_url, created_at
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
                premiumPlan: u.premium_plan || 'premium'
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
        const { name_color, profile_theme, profile_color, custom_id, bubble_style, hide_online } = data;
        await pool.query(
            `UPDATE users SET 
                name_color = COALESCE($2, name_color),
                profile_theme = COALESCE($3, profile_theme),
                profile_color = COALESCE($4, profile_color),
                custom_id = COALESCE($5, custom_id),
                bubble_style = COALESCE($6, bubble_style),
                hide_online = COALESCE($7, hide_online),
                updated_at = CURRENT_TIMESTAMP
            WHERE id = $1`,
            [userId, name_color || null, profile_theme || null, profile_color || null, custom_id || null, bubble_style || null, hide_online]
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

async function saveMessage(senderId, receiverId, text, messageType = 'text', callDuration = 0, selfDestructMinutes = null, replyToId = null) {
    try {
        const id = uuidv4();
        const created_at = new Date().toISOString();
        let self_destruct_at = null;
        
        if (selfDestructMinutes && selfDestructMinutes > 0) {
            const destructDate = new Date(Date.now() + selfDestructMinutes * 60 * 1000);
            self_destruct_at = destructDate.toISOString();
        }
        
        if (USE_SQLITE) {
            sqlite.prepare(`INSERT INTO messages (id, sender_id, receiver_id, text, message_type, call_duration, created_at, self_destruct_at, reply_to_id) 
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, senderId, receiverId, text, messageType, callDuration, created_at, self_destruct_at, replyToId);
        } else {
            await pool.query(
                `INSERT INTO messages (id, sender_id, receiver_id, text, message_type, call_duration, created_at, self_destruct_at, reply_to_id) 
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
                [id, senderId, receiverId, text, messageType, callDuration, created_at, self_destruct_at, replyToId]
            );
        }
        
        return { id, sender_id: senderId, receiver_id: receiverId, text, created_at, message_type: messageType, call_duration: callDuration, self_destruct_at, reply_to_id: replyToId };
    } catch (error) {
        console.error('Save message error:', error);
        throw error;
    }
}

async function getMessageById(messageId) {
    try {
        if (USE_SQLITE) {
            return sqlite.prepare('SELECT * FROM messages WHERE id = ?').get(messageId) || null;
        } else {
            const result = await pool.query('SELECT * FROM messages WHERE id = $1', [messageId]);
            return result.rows[0] || null;
        }
    } catch (error) {
        console.error('Get message by id error:', error);
        return null;
    }
}

async function getMessages(userId1, userId2, limit = 50, before = null) {
    try {
        if (USE_SQLITE) {
            let query = `
                SELECT m.id, m.sender_id, m.receiver_id, m.text, m.message_type, m.call_duration, m.created_at, m.updated_at, m.reply_to_id,
                       u.bubble_style as sender_bubble_style,
                       rm.id as reply_id, rm.text as reply_text, rm.sender_id as reply_sender_id, rm.message_type as reply_message_type,
                       ru.username as reply_sender_username, ru.display_name as reply_sender_display_name
                FROM messages m
                LEFT JOIN users u ON m.sender_id = u.id
                LEFT JOIN messages rm ON m.reply_to_id = rm.id
                LEFT JOIN users ru ON rm.sender_id = ru.id
                WHERE (m.sender_id = ? AND m.receiver_id = ?) OR (m.sender_id = ? AND m.receiver_id = ?)
            `;
            const params = [userId1, userId2, userId2, userId1];
            
            if (before) {
                query += ` AND m.created_at < ?`;
                params.push(before);
            }
            
            query += ` ORDER BY m.created_at DESC LIMIT ?`;
            params.push(Math.min(limit, 100));
            
            const rows = sqlite.prepare(query).all(...params);
            const messages = rows.reverse().map(row => ({
                id: row.id,
                sender_id: row.sender_id,
                receiver_id: row.receiver_id,
                text: row.text,
                message_type: row.message_type,
                call_duration: row.call_duration,
                created_at: row.created_at,
                updated_at: row.updated_at,
                reply_to_id: row.reply_to_id,
                sender_bubble_style: row.sender_bubble_style,
                reply_to: row.reply_id ? {
                    id: row.reply_id,
                    text: row.reply_text,
                    sender_id: row.reply_sender_id,
                    message_type: row.reply_message_type,
                    sender_username: row.reply_sender_username,
                    sender_display_name: row.reply_sender_display_name
                } : null
            }));
            
            if (messages.length > 0) {
                const messageIds = messages.map(m => m.id);
                const placeholders = messageIds.map(() => '?').join(',');
                const reactionsRows = sqlite.prepare(
                    `SELECT message_id, emoji, COUNT(*) as count, GROUP_CONCAT(user_id) as user_ids
                     FROM message_reactions WHERE message_id IN (${placeholders}) GROUP BY message_id, emoji`
                ).all(...messageIds);
                const reactionsMap = {};
                for (const r of reactionsRows) {
                    if (!reactionsMap[r.message_id]) reactionsMap[r.message_id] = [];
                    reactionsMap[r.message_id].push({ emoji: r.emoji, count: parseInt(r.count), user_ids: r.user_ids ? r.user_ids.split(',') : [] });
                }
                for (const msg of messages) msg.reactions = reactionsMap[msg.id] || [];
            }
            
            return messages;
        }
        
        let query = `
            SELECT m.id, m.sender_id, m.receiver_id, m.text, m.message_type, m.call_duration, m.created_at, m.updated_at, m.reply_to_id,
                   u.bubble_style as sender_bubble_style,
                   rm.id as reply_id, rm.text as reply_text, rm.sender_id as reply_sender_id, rm.message_type as reply_message_type,
                   ru.username as reply_sender_username, ru.display_name as reply_sender_display_name
            FROM messages m
            LEFT JOIN users u ON m.sender_id = u.id
            LEFT JOIN messages rm ON m.reply_to_id = rm.id
            LEFT JOIN users ru ON rm.sender_id = ru.id
            WHERE (m.sender_id = $1 AND m.receiver_id = $2) OR (m.sender_id = $2 AND m.receiver_id = $1)
        `;
        const params = [userId1, userId2];
        
        if (before) {
            query += ` AND m.created_at < $3`;
            params.push(before);
        }
        
        query += ` ORDER BY m.created_at DESC LIMIT $${params.length + 1}`;
        params.push(Math.min(limit, 100));
        
        const result = await pool.query(query, params);
        const messages = result.rows.reverse().map(row => ({
            id: row.id,
            sender_id: row.sender_id,
            receiver_id: row.receiver_id,
            text: row.text,
            message_type: row.message_type,
            call_duration: row.call_duration,
            created_at: row.created_at,
            updated_at: row.updated_at,
            reply_to_id: row.reply_to_id,
            sender_bubble_style: row.sender_bubble_style,
            reply_to: row.reply_id ? {
                id: row.reply_id,
                text: row.reply_text,
                sender_id: row.reply_sender_id,
                message_type: row.reply_message_type,
                sender_username: row.reply_sender_username,
                sender_display_name: row.reply_sender_display_name
            } : null
        }));
        
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
                SELECT DISTINCT u.id, u.username, u.tag, u.display_name, u.avatar_url, u.role, u.premium_until, u.premium_plan, u.name_color, u.custom_id,
                    (SELECT COUNT(*) FROM messages m WHERE m.sender_id = u.id AND m.receiver_id = ? AND m.is_read = 0) as unread_count,
                    (SELECT MAX(created_at) FROM messages m WHERE (m.sender_id = u.id AND m.receiver_id = ?) OR (m.sender_id = ? AND m.receiver_id = u.id)) as last_message_at,
                    (SELECT 1 FROM pinned_chats pc WHERE pc.user_id = ? AND pc.chat_id = u.id AND pc.chat_type = 'user') as is_pinned,
                    (SELECT pinned_at FROM pinned_chats pc WHERE pc.user_id = ? AND pc.chat_id = u.id AND pc.chat_type = 'user') as pinned_at
                FROM users u
                WHERE u.id IN (
                    SELECT DISTINCT sender_id FROM messages WHERE receiver_id = ?
                    UNION
                    SELECT DISTINCT receiver_id FROM messages WHERE sender_id = ?
                )
                ORDER BY is_pinned DESC, pinned_at ASC, last_message_at DESC
            `).all(userId, userId, userId, userId, userId, userId, userId);
        } else {
            const result = await pool.query(`
                SELECT DISTINCT u.id, u.username, u.tag, u.display_name, u.avatar_url, u.role, u.premium_until, u.premium_plan, u.name_color, u.custom_id,
                    (SELECT COUNT(*) FROM messages m WHERE m.sender_id = u.id AND m.receiver_id = $1 AND m.is_read = FALSE) as unread_count,
                    (SELECT MAX(created_at) FROM messages m WHERE (m.sender_id = u.id AND m.receiver_id = $1) OR (m.sender_id = $1 AND m.receiver_id = u.id)) as last_message_at,
                    (SELECT 1 FROM pinned_chats pc WHERE pc.user_id = $1 AND pc.chat_id = u.id AND pc.chat_type = 'user') as is_pinned,
                    (SELECT pinned_at FROM pinned_chats pc WHERE pc.user_id = $1 AND pc.chat_id = u.id AND pc.chat_type = 'user') as pinned_at
                FROM users u
                WHERE u.id IN (
                    SELECT DISTINCT sender_id FROM messages WHERE receiver_id = $1
                    UNION
                    SELECT DISTINCT receiver_id FROM messages WHERE sender_id = $1
                )
                ORDER BY is_pinned DESC NULLS LAST, pinned_at ASC NULLS LAST, last_message_at DESC NULLS LAST
            `, [userId]);
            rows = result.rows;
        }
        return rows.map(u => ({
            ...u,
            isPremium: u.role === 'admin' || (u.premium_until && new Date(u.premium_until) > new Date()),
            premiumPlan: u.premium_plan || 'premium',
            isPinned: !!u.is_pinned
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
        if (sanitized.length < 2) return { users: [], messages: [], channels: [], servers: [] };
        
        let users, messages, channels, servers;
        
        if (USE_SQLITE) {
            users = sqlite.prepare(`SELECT id, username, tag, custom_id, display_name, avatar_url 
                FROM users WHERE (username LIKE ? OR display_name LIKE ?) AND id != ? LIMIT 10`)
                .all(`%${sanitized}%`, `%${sanitized}%`, userId);
            
            messages = sqlite.prepare(`SELECT m.id, m.text, m.created_at, m.sender_id, m.receiver_id,
                    u.username as sender_username, u.display_name as sender_display_name, u.avatar_url as sender_avatar
                FROM messages m JOIN users u ON u.id = m.sender_id
                WHERE (m.sender_id = ? OR m.receiver_id = ?) AND m.text LIKE ? AND m.message_type = 'text'
                ORDER BY m.created_at DESC LIMIT 20`)
                .all(userId, userId, `%${sanitized}%`);
            
            // Поиск публичных каналов
            channels = sqlite.prepare(`SELECT id, name, description, avatar_url, subscriber_count 
                FROM channels WHERE is_public = 1 AND name LIKE ? LIMIT 10`)
                .all(`%${sanitized}%`);
            
            // Поиск публичных серверов
            servers = sqlite.prepare(`SELECT id, name, description, icon_url, member_count 
                FROM servers WHERE is_public = 1 AND name LIKE ? LIMIT 10`)
                .all(`%${sanitized}%`);
        } else {
            const usersResult = await pool.query(
                `SELECT id, username, tag, custom_id, display_name, avatar_url 
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
            
            // Поиск публичных каналов
            const channelsResult = await pool.query(
                `SELECT id, name, description, avatar_url, subscriber_count 
                 FROM channels WHERE is_public = true AND name ILIKE $1 LIMIT 10`,
                [`%${sanitized}%`]
            );
            channels = channelsResult.rows;
            
            // Поиск публичных серверов
            const serversResult = await pool.query(
                `SELECT id, name, description, icon_url, member_count 
                 FROM servers WHERE is_public = true AND name ILIKE $1 LIMIT 10`,
                [`%${sanitized}%`]
            );
            servers = serversResult.rows;
        }
        
        return { users, messages, channels, servers };
    } catch (error) {
        console.error('Global search error:', error);
        return { users: [], messages: [], channels: [], servers: [] };
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

async function deleteMessage(messageId, userId, deleteForAll = false, isOwnMessage = true) {
    try {
        if (USE_SQLITE) {
            const msg = sqlite.prepare('SELECT sender_id, receiver_id FROM messages WHERE id = ?').get(messageId);
            if (!msg) {
                return { success: false, error: 'Сообщение не найдено' };
            }
            
            // Проверяем что пользователь участник чата
            if (msg.sender_id !== userId && msg.receiver_id !== userId) {
                return { success: false, error: 'Нет прав на удаление' };
            }
            
            sqlite.prepare('DELETE FROM messages WHERE id = ?').run(messageId);
            return { success: true, receiverId: msg.receiver_id, deleteForAll };
        } else {
            // Сначала получаем сообщение
            const msgResult = await pool.query(
                'SELECT sender_id, receiver_id FROM messages WHERE id = $1',
                [messageId]
            );
            
            if (msgResult.rows.length === 0) {
                return { success: false, error: 'Сообщение не найдено' };
            }
            
            const msg = msgResult.rows[0];
            
            // Проверяем что пользователь участник чата
            if (msg.sender_id !== userId && msg.receiver_id !== userId) {
                return { success: false, error: 'Нет прав на удаление' };
            }
            
            await pool.query('DELETE FROM messages WHERE id = $1', [messageId]);
            return { success: true, receiverId: msg.receiver_id, deleteForAll };
        }
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

async function getGroupMedia(groupId, limit = 50) {
    try {
        let media;
        if (USE_SQLITE) {
            media = sqlite.prepare(`
                SELECT id, text as url, message_type as type, created_at
                FROM group_messages
                WHERE group_id = ? AND message_type IN ('image', 'video', 'gif')
                ORDER BY created_at DESC LIMIT ?
            `).all(groupId, limit);
        } else {
            const result = await pool.query(`
                SELECT id, text as url, message_type as type, created_at
                FROM group_messages
                WHERE group_id = $1 AND message_type IN ('image', 'video', 'gif')
                ORDER BY created_at DESC LIMIT $2
            `, [groupId, limit]);
            media = result.rows;
        }
        return media;
    } catch (error) {
        console.error('Get group media error:', error);
        return [];
    }
}

async function updateGroupAvatar(groupId, avatarUrl) {
    try {
        if (USE_SQLITE) {
            sqlite.prepare('UPDATE group_chats SET avatar_url = ? WHERE id = ?').run(avatarUrl, groupId);
        } else {
            await pool.query('UPDATE group_chats SET avatar_url = $1 WHERE id = $2', [avatarUrl, groupId]);
        }
        return { success: true };
    } catch (error) {
        console.error('Update group avatar error:', error);
        return { success: false, error: 'Ошибка обновления аватарки' };
    }
}

async function updateGroupBanner(groupId, bannerUrl) {
    try {
        // Сначала проверим есть ли колонка banner_url
        if (USE_SQLITE) {
            // Добавляем колонку если её нет
            try {
                sqlite.exec('ALTER TABLE group_chats ADD COLUMN banner_url TEXT');
            } catch (e) {
                // Колонка уже существует
            }
            sqlite.prepare('UPDATE group_chats SET banner_url = ? WHERE id = ?').run(bannerUrl, groupId);
        } else {
            await pool.query('ALTER TABLE group_chats ADD COLUMN IF NOT EXISTS banner_url TEXT').catch(() => {});
            await pool.query('UPDATE group_chats SET banner_url = $1 WHERE id = $2', [bannerUrl, groupId]);
        }
        return { success: true };
    } catch (error) {
        console.error('Update group banner error:', error);
        return { success: false, error: 'Ошибка обновления баннера' };
    }
}

async function updateGroup(groupId, data) {
    try {
        const { name, description } = data;
        if (USE_SQLITE) {
            if (name !== undefined) {
                sqlite.prepare('UPDATE group_chats SET name = ? WHERE id = ?').run(name, groupId);
            }
            if (description !== undefined) {
                sqlite.prepare('UPDATE group_chats SET description = ? WHERE id = ?').run(description, groupId);
            }
        } else {
            if (name !== undefined) {
                await pool.query('UPDATE group_chats SET name = $1 WHERE id = $2', [name, groupId]);
            }
            if (description !== undefined) {
                await pool.query('UPDATE group_chats SET description = $1 WHERE id = $2', [description, groupId]);
            }
        }
        return { success: true };
    } catch (error) {
        console.error('Update group error:', error);
        return { success: false, error: 'Ошибка обновления группы' };
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

// Получить канал по ID или invite_slug
async function getChannelByIdOrSlug(idOrSlug) {
    try {
        let channel;
        if (USE_SQLITE) {
            channel = sqlite.prepare('SELECT * FROM channels WHERE id = ? OR invite_slug = ?').get(idOrSlug, idOrSlug);
        } else {
            const result = await pool.query('SELECT * FROM channels WHERE id = $1 OR invite_slug = $1', [idOrSlug]);
            channel = result.rows[0];
        }
        return channel || null;
    } catch (error) {
        console.error('Get channel by id or slug error:', error);
        return null;
    }
}

// Обновить invite_slug канала
async function updateChannelSlug(channelId, slug) {
    try {
        // Проверяем уникальность
        if (slug) {
            let existing;
            if (USE_SQLITE) {
                existing = sqlite.prepare('SELECT id FROM channels WHERE invite_slug = ? AND id != ?').get(slug, channelId);
            } else {
                const result = await pool.query('SELECT id FROM channels WHERE invite_slug = $1 AND id != $2', [slug, channelId]);
                existing = result.rows[0];
            }
            if (existing) {
                return { success: false, error: 'Этот slug уже занят' };
            }
        }
        
        if (USE_SQLITE) {
            sqlite.prepare('UPDATE channels SET invite_slug = ? WHERE id = ?').run(slug || null, channelId);
        } else {
            await pool.query('UPDATE channels SET invite_slug = $1 WHERE id = $2', [slug || null, channelId]);
        }
        return { success: true };
    } catch (error) {
        console.error('Update channel slug error:', error);
        return { success: false, error: 'Ошибка обновления' };
    }
}

async function isChannelAdmin(channelId, userId) {
    try {
        if (USE_SQLITE) {
            const admin = sqlite.prepare('SELECT 1 FROM channel_admins WHERE channel_id = ? AND user_id = ?').get(channelId, userId);
            return !!admin;
        } else {
            const result = await pool.query('SELECT 1 FROM channel_admins WHERE channel_id = $1 AND user_id = $2', [channelId, userId]);
            return result.rows.length > 0;
        }
    } catch (error) {
        console.error('Check channel admin error:', error);
        return false;
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

async function getChannelMedia(channelId, limit = 50) {
    try {
        let media;
        if (USE_SQLITE) {
            media = sqlite.prepare(`
                SELECT id, media_url as url, media_type as type, created_at
                FROM channel_posts
                WHERE channel_id = ? AND media_url IS NOT NULL AND media_url != ''
                ORDER BY created_at DESC LIMIT ?
            `).all(channelId, limit);
        } else {
            const result = await pool.query(`
                SELECT id, media_url as url, media_type as type, created_at
                FROM channel_posts
                WHERE channel_id = $1 AND media_url IS NOT NULL AND media_url != ''
                ORDER BY created_at DESC LIMIT $2
            `, [channelId, limit]);
            media = result.rows;
        }
        return media;
    } catch (error) {
        console.error('Get channel media error:', error);
        return [];
    }
}

async function updateChannel(channelId, data) {
    try {
        const { name, description } = data;
        if (USE_SQLITE) {
            if (name !== undefined) {
                sqlite.prepare('UPDATE channels SET name = ? WHERE id = ?').run(name, channelId);
            }
            if (description !== undefined) {
                sqlite.prepare('UPDATE channels SET description = ? WHERE id = ?').run(description, channelId);
            }
        } else {
            if (name !== undefined) {
                await pool.query('UPDATE channels SET name = $1 WHERE id = $2', [name, channelId]);
            }
            if (description !== undefined) {
                await pool.query('UPDATE channels SET description = $1 WHERE id = $2', [description, channelId]);
            }
        }
        return { success: true };
    } catch (error) {
        console.error('Update channel error:', error);
        return { success: false, error: 'Ошибка обновления канала' };
    }
}

// === СЕРВЕРЫ (Discord-style) ===

async function createServer(ownerId, name, description = '', iconUrl = null) {
    try {
        const id = uuidv4();
        const created_at = new Date().toISOString();
        
        if (USE_SQLITE) {
            sqlite.prepare('INSERT INTO servers (id, name, description, icon_url, owner_id, is_public, member_count, created_at) VALUES (?, ?, ?, ?, ?, 1, 1, ?)').run(id, name, description, iconUrl, ownerId, created_at);
            const everyoneRoleId = uuidv4();
            sqlite.prepare('INSERT INTO server_roles (id, server_id, name, is_default, position) VALUES (?, ?, ?, 1, 0)').run(everyoneRoleId, id, '@everyone');
            sqlite.prepare('INSERT INTO server_members (id, server_id, user_id) VALUES (?, ?, ?)').run(uuidv4(), id, ownerId);
            // Текстовые каналы
            const textCategoryId = uuidv4();
            sqlite.prepare('INSERT INTO server_categories (id, server_id, name, position) VALUES (?, ?, ?, 0)').run(textCategoryId, id, 'Текстовые каналы');
            sqlite.prepare('INSERT INTO server_channels (id, server_id, category_id, name, type, position) VALUES (?, ?, ?, ?, ?, 0)').run(uuidv4(), id, textCategoryId, 'общий', 'text');
            // Голосовые каналы
            const voiceCategoryId = uuidv4();
            sqlite.prepare('INSERT INTO server_categories (id, server_id, name, position) VALUES (?, ?, ?, 1)').run(voiceCategoryId, id, 'Голосовые каналы');
            sqlite.prepare('INSERT INTO server_channels (id, server_id, category_id, name, type, position) VALUES (?, ?, ?, ?, ?, 0)').run(uuidv4(), id, voiceCategoryId, 'Общий', 'voice');
        } else {
            await pool.query('INSERT INTO servers (id, name, description, icon_url, owner_id, is_public, member_count, created_at) VALUES ($1, $2, $3, $4, $5, true, 1, $6)', [id, name, description, iconUrl, ownerId, created_at]);
            const everyoneRoleId = uuidv4();
            await pool.query('INSERT INTO server_roles (id, server_id, name, is_default, position) VALUES ($1, $2, $3, true, 0)', [everyoneRoleId, id, '@everyone']);
            await pool.query('INSERT INTO server_members (id, server_id, user_id) VALUES ($1, $2, $3)', [uuidv4(), id, ownerId]);
            // Текстовые каналы
            const textCategoryId = uuidv4();
            await pool.query('INSERT INTO server_categories (id, server_id, name, position) VALUES ($1, $2, $3, 0)', [textCategoryId, id, 'Текстовые каналы']);
            await pool.query('INSERT INTO server_channels (id, server_id, category_id, name, type, position) VALUES ($1, $2, $3, $4, $5, 0)', [uuidv4(), id, textCategoryId, 'общий', 'text']);
            // Голосовые каналы
            const voiceCategoryId = uuidv4();
            await pool.query('INSERT INTO server_categories (id, server_id, name, position) VALUES ($1, $2, $3, 1)', [voiceCategoryId, id, 'Голосовые каналы']);
            await pool.query('INSERT INTO server_channels (id, server_id, category_id, name, type, position) VALUES ($1, $2, $3, $4, $5, 0)', [uuidv4(), id, voiceCategoryId, 'Общий', 'voice']);
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

// Получить сервер по ID или invite_slug
async function getServerByIdOrSlug(idOrSlug) {
    try {
        let server;
        if (USE_SQLITE) {
            server = sqlite.prepare('SELECT * FROM servers WHERE id = ? OR invite_slug = ?').get(idOrSlug, idOrSlug);
        } else {
            const result = await pool.query('SELECT * FROM servers WHERE id = $1 OR invite_slug = $1', [idOrSlug]);
            server = result.rows[0];
        }
        return server || null;
    } catch (error) {
        console.error('Get server by id or slug error:', error);
        return null;
    }
}

// Обновить invite_slug сервера
async function updateServerSlug(serverId, slug) {
    try {
        // Проверяем уникальность
        if (slug) {
            let existing;
            if (USE_SQLITE) {
                existing = sqlite.prepare('SELECT id FROM servers WHERE invite_slug = ? AND id != ?').get(slug, serverId);
            } else {
                const result = await pool.query('SELECT id FROM servers WHERE invite_slug = $1 AND id != $2', [slug, serverId]);
                existing = result.rows[0];
            }
            if (existing) {
                return { success: false, error: 'Этот slug уже занят' };
            }
        }
        
        if (USE_SQLITE) {
            sqlite.prepare('UPDATE servers SET invite_slug = ? WHERE id = ?').run(slug || null, serverId);
        } else {
            await pool.query('UPDATE servers SET invite_slug = $1 WHERE id = $2', [slug || null, serverId]);
        }
        return { success: true };
    } catch (error) {
        console.error('Update server slug error:', error);
        return { success: false, error: 'Ошибка обновления' };
    }
}

async function updateServer(serverId, data) {
    try {
        const { name, description } = data;
        if (USE_SQLITE) {
            if (name !== undefined) {
                sqlite.prepare('UPDATE servers SET name = ? WHERE id = ?').run(name, serverId);
            }
            if (description !== undefined) {
                sqlite.prepare('UPDATE servers SET description = ? WHERE id = ?').run(description, serverId);
            }
        } else {
            if (name !== undefined) {
                await pool.query('UPDATE servers SET name = $1 WHERE id = $2', [name, serverId]);
            }
            if (description !== undefined) {
                await pool.query('UPDATE servers SET description = $1 WHERE id = $2', [description, serverId]);
            }
        }
        return { success: true };
    } catch (error) {
        console.error('Update server error:', error);
        return { success: false, error: 'Ошибка обновления сервера' };
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

async function createServerCategory(serverId, name) {
    try {
        const id = uuidv4();
        if (USE_SQLITE) {
            const maxPos = sqlite.prepare('SELECT MAX(position) as max FROM server_categories WHERE server_id = ?').get(serverId);
            const position = (maxPos?.max || 0) + 1;
            sqlite.prepare('INSERT INTO server_categories (id, server_id, name, position) VALUES (?, ?, ?, ?)').run(id, serverId, name, position);
        } else {
            const maxPos = await pool.query('SELECT MAX(position) as max FROM server_categories WHERE server_id = $1', [serverId]);
            const position = (maxPos.rows[0]?.max || 0) + 1;
            await pool.query('INSERT INTO server_categories (id, server_id, name, position) VALUES ($1, $2, $3, $4)', [id, serverId, name, position]);
        }
        return { success: true, category: { id, server_id: serverId, name, position } };
    } catch (error) {
        console.error('Create server category error:', error);
        return { success: false };
    }
}

async function updateServerChannel(channelId, data) {
    try {
        const { name, topic, is_private } = data;
        if (USE_SQLITE) {
            sqlite.prepare('UPDATE server_channels SET name = COALESCE(?, name), topic = COALESCE(?, topic) WHERE id = ?').run(name, topic, channelId);
        } else {
            await pool.query('UPDATE server_channels SET name = COALESCE($1, name), topic = COALESCE($2, topic) WHERE id = $3', [name, topic, channelId]);
        }
        return { success: true };
    } catch (error) {
        console.error('Update server channel error:', error);
        return { success: false };
    }
}

async function deleteServerChannel(channelId) {
    try {
        if (USE_SQLITE) {
            sqlite.prepare('DELETE FROM server_messages WHERE channel_id = ?').run(channelId);
            sqlite.prepare('DELETE FROM server_channels WHERE id = ?').run(channelId);
        } else {
            await pool.query('DELETE FROM server_messages WHERE channel_id = $1', [channelId]);
            await pool.query('DELETE FROM server_channels WHERE id = $1', [channelId]);
        }
        return { success: true };
    } catch (error) {
        console.error('Delete server channel error:', error);
        return { success: false };
    }
}

async function updateServerCategory(categoryId, data) {
    try {
        const { name } = data;
        if (USE_SQLITE) {
            sqlite.prepare('UPDATE server_categories SET name = COALESCE(?, name) WHERE id = ?').run(name, categoryId);
        } else {
            await pool.query('UPDATE server_categories SET name = COALESCE($1, name) WHERE id = $2', [name, categoryId]);
        }
        return { success: true };
    } catch (error) {
        console.error('Update server category error:', error);
        return { success: false };
    }
}

async function deleteServerCategory(categoryId) {
    try {
        if (USE_SQLITE) {
            // Перемещаем каналы в "без категории"
            sqlite.prepare('UPDATE server_channels SET category_id = NULL WHERE category_id = ?').run(categoryId);
            sqlite.prepare('DELETE FROM server_categories WHERE id = ?').run(categoryId);
        } else {
            await pool.query('UPDATE server_channels SET category_id = NULL WHERE category_id = $1', [categoryId]);
            await pool.query('DELETE FROM server_categories WHERE id = $1', [categoryId]);
        }
        return { success: true };
    } catch (error) {
        console.error('Delete server category error:', error);
        return { success: false };
    }
}

async function getServerChannel(channelId) {
    try {
        let channel;
        if (USE_SQLITE) {
            channel = sqlite.prepare('SELECT * FROM server_channels WHERE id = ?').get(channelId);
        } else {
            const result = await pool.query('SELECT * FROM server_channels WHERE id = $1', [channelId]);
            channel = result.rows[0];
        }
        return channel || null;
    } catch (error) {
        console.error('Get server channel error:', error);
        return null;
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

async function getServerMedia(serverId, limit = 50) {
    try {
        let media;
        if (USE_SQLITE) {
            media = sqlite.prepare(`
                SELECT sm.id, sm.text as url, sm.message_type as type, sm.created_at
                FROM server_messages sm
                JOIN server_channels sc ON sc.id = sm.channel_id
                WHERE sc.server_id = ? AND sm.message_type IN ('image', 'video', 'gif')
                ORDER BY sm.created_at DESC LIMIT ?
            `).all(serverId, limit);
        } else {
            const result = await pool.query(`
                SELECT sm.id, sm.text as url, sm.message_type as type, sm.created_at
                FROM server_messages sm
                JOIN server_channels sc ON sc.id = sm.channel_id
                WHERE sc.server_id = $1 AND sm.message_type IN ('image', 'video', 'gif')
                ORDER BY sm.created_at DESC LIMIT $2
            `, [serverId, limit]);
            media = result.rows;
        }
        return media;
    } catch (error) {
        console.error('Get server media error:', error);
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

// === РОЛИ СЕРВЕРА ===

async function getServerRoles(serverId) {
    try {
        let roles;
        if (USE_SQLITE) {
            roles = sqlite.prepare(`
                SELECT * FROM server_roles WHERE server_id = ? ORDER BY position DESC
            `).all(serverId);
        } else {
            const result = await pool.query(`
                SELECT * FROM server_roles WHERE server_id = $1 ORDER BY position DESC
            `, [serverId]);
            roles = result.rows;
        }
        return roles;
    } catch (error) {
        console.error('Get server roles error:', error);
        return [];
    }
}

async function createServerRole(serverId, name, color = '#99aab5', permissions = 0) {
    try {
        const id = uuidv4();
        if (USE_SQLITE) {
            const maxPos = sqlite.prepare('SELECT MAX(position) as max FROM server_roles WHERE server_id = ?').get(serverId);
            const position = (maxPos?.max || 0) + 1;
            sqlite.prepare(`
                INSERT INTO server_roles (id, server_id, name, color, position, permissions)
                VALUES (?, ?, ?, ?, ?, ?)
            `).run(id, serverId, name, color, position, permissions);
        } else {
            const maxPos = await pool.query('SELECT MAX(position) as max FROM server_roles WHERE server_id = $1', [serverId]);
            const position = (maxPos.rows[0]?.max || 0) + 1;
            await pool.query(`
                INSERT INTO server_roles (id, server_id, name, color, position, permissions)
                VALUES ($1, $2, $3, $4, $5, $6)
            `, [id, serverId, name, color, position, permissions]);
        }
        return { success: true, roleId: id };
    } catch (error) {
        console.error('Create server role error:', error);
        return { success: false, error: 'Ошибка создания роли' };
    }
}

async function updateServerRole(roleId, data) {
    try {
        const { name, color, permissions } = data;
        if (USE_SQLITE) {
            sqlite.prepare(`
                UPDATE server_roles SET name = ?, color = ?, permissions = ? WHERE id = ?
            `).run(name, color, permissions, roleId);
        } else {
            await pool.query(`
                UPDATE server_roles SET name = $1, color = $2, permissions = $3 WHERE id = $4
            `, [name, color, permissions, roleId]);
        }
        return { success: true };
    } catch (error) {
        console.error('Update server role error:', error);
        return { success: false, error: 'Ошибка обновления роли' };
    }
}

async function deleteServerRole(roleId) {
    try {
        if (USE_SQLITE) {
            // Удаляем назначения роли
            sqlite.prepare('DELETE FROM server_member_roles WHERE role_id = ?').run(roleId);
            // Удаляем роль
            sqlite.prepare('DELETE FROM server_roles WHERE id = ?').run(roleId);
        } else {
            await pool.query('DELETE FROM server_member_roles WHERE role_id = $1', [roleId]);
            await pool.query('DELETE FROM server_roles WHERE id = $1', [roleId]);
        }
        return { success: true };
    } catch (error) {
        console.error('Delete server role error:', error);
        return { success: false, error: 'Ошибка удаления роли' };
    }
}

// === ЗАКРЕПЛЁННЫЕ ЧАТЫ ===

async function pinChat(userId, chatId, chatType = 'user') {
    try {
        const id = uuidv4();
        if (USE_SQLITE) {
            sqlite.prepare(`
                INSERT OR REPLACE INTO pinned_chats (id, user_id, chat_id, chat_type, pinned_at)
                VALUES (?, ?, ?, ?, datetime('now'))
            `).run(id, userId, chatId, chatType);
        } else {
            await pool.query(`
                INSERT INTO pinned_chats (id, user_id, chat_id, chat_type, pinned_at)
                VALUES ($1, $2, $3, $4, NOW())
                ON CONFLICT (user_id, chat_id, chat_type) DO UPDATE SET pinned_at = NOW()
            `, [id, userId, chatId, chatType]);
        }
        return { success: true };
    } catch (error) {
        console.error('Pin chat error:', error);
        return { success: false, error: error.message };
    }
}

async function unpinChat(userId, chatId, chatType = 'user') {
    try {
        if (USE_SQLITE) {
            sqlite.prepare('DELETE FROM pinned_chats WHERE user_id = ? AND chat_id = ? AND chat_type = ?').run(userId, chatId, chatType);
        } else {
            await pool.query('DELETE FROM pinned_chats WHERE user_id = $1 AND chat_id = $2 AND chat_type = $3', [userId, chatId, chatType]);
        }
        return { success: true };
    } catch (error) {
        console.error('Unpin chat error:', error);
        return { success: false, error: error.message };
    }
}

async function getPinnedChatsCount(userId, chatType = 'user') {
    try {
        if (USE_SQLITE) {
            const result = sqlite.prepare('SELECT COUNT(*) as count FROM pinned_chats WHERE user_id = ? AND chat_type = ?').get(userId, chatType);
            return result?.count || 0;
        } else {
            const result = await pool.query('SELECT COUNT(*) as count FROM pinned_chats WHERE user_id = $1 AND chat_type = $2', [userId, chatType]);
            return parseInt(result.rows[0]?.count) || 0;
        }
    } catch (error) {
        console.error('Get pinned chats count error:', error);
        return 0;
    }
}

async function isPinned(userId, chatId, chatType = 'user') {
    try {
        if (USE_SQLITE) {
            const result = sqlite.prepare('SELECT 1 FROM pinned_chats WHERE user_id = ? AND chat_id = ? AND chat_type = ?').get(userId, chatId, chatType);
            return !!result;
        } else {
            const result = await pool.query('SELECT 1 FROM pinned_chats WHERE user_id = $1 AND chat_id = $2 AND chat_type = $3', [userId, chatId, chatType]);
            return result.rows.length > 0;
        }
    } catch (error) {
        console.error('Is pinned error:', error);
        return false;
    }
}

// === САМОУНИЧТОЖАЮЩИЕСЯ СООБЩЕНИЯ ===
async function cleanupSelfDestructMessages() {
    try {
        const now = new Date().toISOString();
        let deletedIds = [];
        
        if (USE_SQLITE) {
            const messages = sqlite.prepare('SELECT id, sender_id, receiver_id FROM messages WHERE self_destruct_at IS NOT NULL AND self_destruct_at <= ?').all(now);
            deletedIds = messages.map(m => ({ id: m.id, senderId: m.sender_id, receiverId: m.receiver_id }));
            sqlite.prepare('DELETE FROM messages WHERE self_destruct_at IS NOT NULL AND self_destruct_at <= ?').run(now);
        } else {
            const result = await pool.query(
                'DELETE FROM messages WHERE self_destruct_at IS NOT NULL AND self_destruct_at <= $1 RETURNING id, sender_id, receiver_id',
                [now]
            );
            deletedIds = result.rows.map(r => ({ id: r.id, senderId: r.sender_id, receiverId: r.receiver_id }));
        }
        
        return deletedIds;
    } catch (error) {
        console.error('Cleanup self-destruct messages error:', error);
        return [];
    }
}

// === СТАТИСТИКА ПОЛЬЗОВАТЕЛЕЙ ===

async function getUserStats(userId) {
    try {
        if (USE_SQLITE) {
            let stats = sqlite.prepare('SELECT * FROM user_stats WHERE user_id = ?').get(userId);
            if (!stats) {
                sqlite.prepare('INSERT INTO user_stats (user_id) VALUES (?)').run(userId);
                stats = { user_id: userId, messages_sent: 0, time_online: 0, call_minutes: 0, reactions_given: 0, files_sent: 0 };
            }
            return stats;
        } else {
            let result = await pool.query('SELECT * FROM user_stats WHERE user_id = $1', [userId]);
            if (result.rows.length === 0) {
                await pool.query('INSERT INTO user_stats (user_id) VALUES ($1) ON CONFLICT DO NOTHING', [userId]);
                return { user_id: userId, messages_sent: 0, time_online: 0, call_minutes: 0, reactions_given: 0, files_sent: 0 };
            }
            return result.rows[0];
        }
    } catch (error) {
        console.error('Get user stats error:', error);
        return { messages_sent: 0, time_online: 0, call_minutes: 0, reactions_given: 0, files_sent: 0 };
    }
}

async function incrementStat(userId, stat, amount = 1) {
    try {
        if (USE_SQLITE) {
            sqlite.prepare(`INSERT INTO user_stats (user_id, ${stat}) VALUES (?, ?) 
                ON CONFLICT(user_id) DO UPDATE SET ${stat} = ${stat} + ?`).run(userId, amount, amount);
        } else {
            await pool.query(
                `INSERT INTO user_stats (user_id, ${stat}) VALUES ($1, $2) 
                 ON CONFLICT(user_id) DO UPDATE SET ${stat} = user_stats.${stat} + $2`,
                [userId, amount]
            );
        }
        return { success: true };
    } catch (error) {
        console.error('Increment stat error:', error);
        return { success: false };
    }
}

async function updateLastOnline(userId) {
    try {
        const now = new Date().toISOString();
        if (USE_SQLITE) {
            sqlite.prepare(`INSERT INTO user_stats (user_id, last_online) VALUES (?, ?) 
                ON CONFLICT(user_id) DO UPDATE SET last_online = ?`).run(userId, now, now);
        } else {
            await pool.query(
                `INSERT INTO user_stats (user_id, last_online) VALUES ($1, $2) 
                 ON CONFLICT(user_id) DO UPDATE SET last_online = $2`,
                [userId, now]
            );
        }
    } catch (error) {
        console.error('Update last online error:', error);
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
    getMessageById,
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
    getGroupMedia,
    updateGroupAvatar,
    updateGroupBanner,
    updateGroup,
    // Каналы
    createChannel,
    updateChannel,
    getChannel,
    getChannelByIdOrSlug,
    updateChannelSlug,
    isChannelAdmin,
    getUserChannels,
    subscribeToChannel,
    unsubscribeFromChannel,
    createChannelPost,
    getChannelPosts,
    getChannelMedia,
    // Серверы
    createServer,
    getServer,
    getServerByIdOrSlug,
    updateServerSlug,
    updateServer,
    getUserServers,
    joinServer,
    leaveServer,
    getServerChannels,
    createServerChannel,
    createServerCategory,
    updateServerCategory,
    updateServerChannel,
    deleteServerChannel,
    deleteServerCategory,
    getServerChannel,
    saveServerMessage,
    getServerMessages,
    getServerMedia,
    getServerMembers,
    // Роли сервера
    getServerRoles,
    createServerRole,
    updateServerRole,
    deleteServerRole,
    // Закреплённые чаты
    pinChat,
    unpinChat,
    getPinnedChatsCount,
    isPinned,
    // Самоуничтожающиеся сообщения
    cleanupSelfDestructMessages,
    // Статистика
    getUserStats,
    incrementStat,
    updateLastOnline
};
