const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');

// Подключение к PostgreSQL (Railway автоматически задаёт DATABASE_URL)
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

async function initDB() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        username TEXT UNIQUE NOT NULL,
        password TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        sender_id TEXT NOT NULL REFERENCES users(id),
        receiver_id TEXT NOT NULL REFERENCES users(id),
        text TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Индексы для быстрого поиска
    await client.query(`CREATE INDEX IF NOT EXISTS idx_messages_sender ON messages(sender_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_messages_receiver ON messages(receiver_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_users_username ON users(username)`);

    console.log('База данных инициализирована');
  } finally {
    client.release();
  }
}

async function createUser(username, password) {
  try {
    const hash = bcrypt.hashSync(password, 10);
    const id = uuidv4();
    await pool.query(
      'INSERT INTO users (id, username, password) VALUES ($1, $2, $3)',
      [id, username, hash]
    );
    return { success: true, user: { id, username } };
  } catch (e) {
    console.error('Create user error:', e);
    return { success: false, error: 'Пользователь уже существует' };
  }
}

async function loginUser(username, password) {
  try {
    const result = await pool.query(
      'SELECT id, username, password FROM users WHERE username = $1',
      [username]
    );
    if (result.rows.length === 0) {
      return { success: false, error: 'Пользователь не найден' };
    }
    const user = result.rows[0];
    if (!bcrypt.compareSync(password, user.password)) {
      return { success: false, error: 'Неверный пароль' };
    }
    return { success: true, user: { id: user.id, username: user.username } };
  } catch (e) {
    console.error('Login error:', e);
    return { success: false, error: 'Ошибка входа' };
  }
}


async function getAllUsers() {
  try {
    const result = await pool.query('SELECT id, username FROM users');
    return result.rows;
  } catch (e) {
    console.error('Get users error:', e);
    return [];
  }
}

async function searchUsers(query) {
  try {
    const result = await pool.query(
      'SELECT id, username FROM users WHERE username ILIKE $1 LIMIT 20',
      [`%${query}%`]
    );
    return result.rows;
  } catch (e) {
    console.error('Search users error:', e);
    return [];
  }
}

async function saveMessage(senderId, receiverId, text) {
  const id = uuidv4();
  const created_at = new Date().toISOString();
  await pool.query(
    'INSERT INTO messages (id, sender_id, receiver_id, text, created_at) VALUES ($1, $2, $3, $4, $5)',
    [id, senderId, receiverId, text, created_at]
  );
  return { id, sender_id: senderId, receiver_id: receiverId, text, created_at };
}

async function getMessages(userId1, userId2) {
  try {
    const result = await pool.query(`
      SELECT id, sender_id, receiver_id, text, created_at FROM messages 
      WHERE (sender_id = $1 AND receiver_id = $2) OR (sender_id = $2 AND receiver_id = $1)
      ORDER BY created_at ASC
    `, [userId1, userId2]);
    return result.rows;
  } catch (e) {
    console.error('Get messages error:', e);
    return [];
  }
}

async function getContacts(userId) {
  try {
    const result = await pool.query(`
      SELECT DISTINCT u.id, u.username FROM users u
      WHERE u.id IN (
        SELECT DISTINCT sender_id FROM messages WHERE receiver_id = $1
        UNION
        SELECT DISTINCT receiver_id FROM messages WHERE sender_id = $1
      )
    `, [userId]);
    return result.rows;
  } catch (e) {
    console.error('Get contacts error:', e);
    return [];
  }
}

module.exports = { initDB, createUser, loginUser, getAllUsers, searchUsers, saveMessage, getMessages, getContacts };
