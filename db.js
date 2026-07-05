const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');

const DATABASE_URL = process.env.DATABASE_URL || '';
let db;
let isPostgres = false;
let fetch; // loaded lazily

// ========== PostgreSQL ==========
async function initPostgres(databaseUrl) {
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: databaseUrl, ssl: { rejectUnauthorized: false } });
  const client = await pool.connect();
  console.log('✅ Connected to PostgreSQL (Supabase)');
  const PG = {
    async exec(sql, params = []) {
      const n = sql.trim().toUpperCase();
      if (n.startsWith('SELECT')||n.startsWith('WITH')||n.startsWith('RETURNING')) {
        const r = await pool.query(sql, params); return r.rows;
      }
      if (n.startsWith('INSERT')||n.startsWith('UPDATE')||n.startsWith('DELETE')) {
        const r = await pool.query(sql, params); return r.rows||[];
      }
      await pool.query(sql, params); return [];
    },
    async run(sql, p=[]) { const r = await pool.query(sql, p); return { changes: r.rowCount }; },
    async get(sql, p=[]) { const r = await pool.query(sql, p); return r.rows[0]; },
    async all(sql, p=[]) { const r = await pool.query(sql, p); return r.rows; },
    get lastInsertRowid() { return 0; },
    async execMulti(sql) { await pool.query(sql); }
  };
  client.release();
  return { pool, PG };
}

// ========== SQLite ==========
async function initSQLite() {
  const initSqlJs = require('sql.js');
  const SQL = await initSqlJs();
  const DB_PATH = path.join(__dirname, 'chat.db');
  let buffer = null;
  try { if (fs.existsSync(DB_PATH)) buffer = fs.readFileSync(DB_PATH); } catch(e) {}
  const sqliteDb = buffer ? new SQL.Database(buffer) : new SQL.Database();
  sqliteDb.run('PRAGMA journal_mode=WAL');
  sqliteDb.run('PRAGMA foreign_keys=ON');
  console.log('✅ Connected to SQLite (local development)');
  const saveDb = () => {
    try { fs.writeFileSync(DB_PATH, Buffer.from(sqliteDb.export())); } catch(e) {}
  };
  const LITE = {
    _norm(sql) { return sql.replace(/\$\d+/g,'?').replace(/::int/g,'').replace(/\bILIKE\b/g,'LIKE').replace(/ON CONFLICT DO NOTHING/g,'OR IGNORE'); },
    exec(sql,p=[]) {
      sql=this._norm(sql);
      try {
        const st=sqliteDb.prepare(sql); if(st){st.bind(p);const r=[];while(st.step())r.push(st.getAsObject());st.free();return r;}
        return [];
      } catch(e) {
        if(/^(SELECT|WITH|PRAGMA)/i.test(sql.trim())) throw e;
        sqliteDb.run(sql,p); return [];
      }
    },
    run(sql,p=[]) { sql=this._norm(sql); sqliteDb.run(sql,p); return {changes:sqliteDb.getRowsModified()}; },
    get(sql,p=[]) { const r=LITE.exec(sql,p); return r[0]; },
    all(sql,p=[]) { return LITE.exec(sql,p); },
    get lastInsertRowid() { const r=LITE.get('SELECT last_insert_rowid() as id'); return r?r.id:0; },
    execMulti(sql) { sqliteDb.exec(sql); }
  };
  return { pool:null, PG:LITE, saveDb };
}

async function query(sql, p=[]) { return isPostgres?await db.exec(sql,p):db.all(sql,p); }
async function queryOne(sql, p=[]) { return db.get(sql,p); }
async function execute(sql, p=[]) { return db.run(sql,p); }
async function executeMulti(sql) { return db.execMulti(sql); }

// ========== Init ==========
async function initDatabase() {
  if (DATABASE_URL) {
    isPostgres = true;
    const r = await initPostgres(DATABASE_URL);
    db = r.PG;
    await createTables();
    await runMigrations();
  } else {
    isPostgres = false;
    const r = await initSQLite();
    db = r.PG;
    createTablesSQLite();
    await runMigrations();
    r.saveDb();
  }
}

async function createTables() {
  await executeMulti(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      username VARCHAR(50) UNIQUE NOT NULL,
      email VARCHAR(255) UNIQUE NOT NULL,
      password VARCHAR(255) NOT NULL,
      display_name VARCHAR(100),
      avatar_color VARCHAR(7) DEFAULT '#4f46e5',
      role VARCHAR(10) DEFAULT 'user',
      created_at TIMESTAMP DEFAULT NOW(),
      last_seen TIMESTAMP DEFAULT NOW(),
      last_login_ip VARCHAR(45) DEFAULT '',
      last_login_location VARCHAR(100) DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS rooms (
      id SERIAL PRIMARY KEY,
      name VARCHAR(100) NOT NULL,
      description TEXT DEFAULT '',
      created_by INTEGER REFERENCES users(id),
      created_at TIMESTAMP DEFAULT NOW(),
      is_banned INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS room_members (
      id SERIAL PRIMARY KEY,
      room_id INTEGER REFERENCES rooms(id) ON DELETE CASCADE,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      joined_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(room_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS messages (
      id SERIAL PRIMARY KEY,
      room_id INTEGER NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      type VARCHAR(20) DEFAULT 'text',
      content TEXT NOT NULL,
      file_url TEXT DEFAULT '',
      created_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS banned_keywords (
      id SERIAL PRIMARY KEY,
      keyword VARCHAR(200) NOT NULL,
      created_by INTEGER REFERENCES users(id),
      created_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS muted_users (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      room_id INTEGER REFERENCES rooms(id) ON DELETE CASCADE,
      muted_by INTEGER REFERENCES users(id),
      muted_until TIMESTAMP NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS login_history (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      ip_address VARCHAR(45) NOT NULL,
      location VARCHAR(100) DEFAULT '',
      logged_in_at TIMESTAMP DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_messages_room ON messages(room_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_room_members_room ON room_members(room_id);
    CREATE INDEX IF NOT EXISTS idx_room_members_user ON room_members(user_id);
    CREATE INDEX IF NOT EXISTS idx_muted_users ON muted_users(user_id);
    CREATE INDEX IF NOT EXISTS idx_login_history ON login_history(user_id);
  `);
  await ensureDefaultRooms();
}

function createTablesSQLite() {
  const L = db;
  L.execMulti(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      email TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      display_name TEXT,
      avatar_color TEXT DEFAULT '#4f46e5',
      role TEXT DEFAULT 'user',
      created_at DATETIME DEFAULT (datetime('now','localtime')),
      last_seen DATETIME DEFAULT (datetime('now','localtime')),
      last_login_ip TEXT DEFAULT '',
      last_login_location TEXT DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS rooms (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL, description TEXT DEFAULT '',
      created_by INTEGER REFERENCES users(id),
      created_at DATETIME DEFAULT (datetime('now','localtime')),
      is_banned INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS room_members (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      room_id INTEGER REFERENCES rooms(id) ON DELETE CASCADE,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      joined_at DATETIME DEFAULT (datetime('now','localtime')),
      UNIQUE(room_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      room_id INTEGER NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      type TEXT DEFAULT 'text',
      content TEXT NOT NULL,
      file_url TEXT DEFAULT '',
      created_at DATETIME DEFAULT (datetime('now','localtime'))
    );
    CREATE TABLE IF NOT EXISTS banned_keywords (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      keyword TEXT NOT NULL,
      created_by INTEGER REFERENCES users(id),
      created_at DATETIME DEFAULT (datetime('now','localtime'))
    );
    CREATE TABLE IF NOT EXISTS muted_users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      room_id INTEGER REFERENCES rooms(id) ON DELETE CASCADE,
      muted_by INTEGER REFERENCES users(id),
      muted_until DATETIME NOT NULL,
      created_at DATETIME DEFAULT (datetime('now','localtime'))
    );
    CREATE TABLE IF NOT EXISTS login_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      ip_address TEXT NOT NULL,
      location TEXT DEFAULT '',
      logged_in_at DATETIME DEFAULT (datetime('now','localtime'))
    );
  `);
  try { L.run("CREATE INDEX IF NOT EXISTS idx_messages_room ON messages(room_id,created_at)"); }catch(e){}
  try { L.run("CREATE INDEX IF NOT EXISTS idx_room_members_room ON room_members(room_id)"); }catch(e){}
  try { L.run("CREATE INDEX IF NOT EXISTS idx_room_members_user ON room_members(user_id)"); }catch(e){}
  try { L.run("CREATE INDEX IF NOT EXISTS idx_muted_users ON muted_users(user_id)"); }catch(e){}
  try { L.run("CREATE INDEX IF NOT EXISTS idx_login_history ON login_history(user_id)"); }catch(e){}
  ensureDefaultRoomsSQLite();
}

async function ensureDefaultRooms() {
  const rs = await query('SELECT id,name FROM rooms');
  const ns = rs.map(r=>r.name);
  for (const [n,d] of [['General','公共聊天室，欢迎所有人！'],['Random','随意聊天，畅所欲言'],['Tech Talk','技术交流讨论区']]) {
    if (!ns.includes(n)) await execute('INSERT INTO rooms (name,description,created_by) VALUES ($1,$2,NULL)', [n,d]);
  }
}

function ensureDefaultRoomsSQLite() {
  const L = db;
  const rs = L.all('SELECT id,name FROM rooms');
  const ns = rs.map(r=>r.name);
  if (!ns.includes('General')) L.run('INSERT INTO rooms (name,description,created_by) VALUES (?,?,NULL)',['General','公共聊天室，欢迎所有人！']);
  if (!ns.includes('Random')) L.run('INSERT INTO rooms (name,description,created_by) VALUES (?,?,NULL)',['Random','随意聊天，畅所欲言']);
  if (!ns.includes('Tech Talk')) L.run('INSERT INTO rooms (name,description,created_by) VALUES (?,?,NULL)',['Tech Talk','技术交流讨论区']);
}

// ========== Migrations for existing databases ==========
async function runMigrations() {
  // Messages table: add type and file_url columns
  // Users table: add last_login_location column
  // Login history: add location column
  if (isPostgres) {
    await execute("ALTER TABLE messages ADD COLUMN IF NOT EXISTS type VARCHAR(20) DEFAULT 'text'");
    await execute("ALTER TABLE messages ADD COLUMN IF NOT EXISTS file_url TEXT DEFAULT ''");
    await execute("ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login_location VARCHAR(100) DEFAULT ''");
    await execute("ALTER TABLE login_history ADD COLUMN IF NOT EXISTS location VARCHAR(100) DEFAULT ''");
  } else {
    const msgCols = db.all("PRAGMA table_info(messages)");
    const hasMsgType = msgCols.some(c => c.name === 'type');
    const hasMsgFileUrl = msgCols.some(c => c.name === 'file_url');
    if (!hasMsgType) db.run("ALTER TABLE messages ADD COLUMN type TEXT DEFAULT 'text'");
    if (!hasMsgFileUrl) db.run("ALTER TABLE messages ADD COLUMN file_url TEXT DEFAULT ''");

    const userCols = db.all("PRAGMA table_info(users)");
    if (!userCols.some(c => c.name === 'last_login_location')) db.run("ALTER TABLE users ADD COLUMN last_login_location TEXT DEFAULT ''");

    const historyCols = db.all("PRAGMA table_info(login_history)");
    if (!historyCols.some(c => c.name === 'location')) db.run("ALTER TABLE login_history ADD COLUMN location TEXT DEFAULT ''");
  }
}

// ========== User Operations ==========

async function createUser(username, email, password, ip, location) {
  const existing = await queryOne('SELECT id FROM users WHERE username=$1 OR email=$2', [username, email]);
  if (existing) throw new Error('用户名或邮箱已被注册');

  const hashedPassword = bcrypt.hashSync(password, 10);
  const colors = ['#4f46e5','#0891b2','#059669','#d97706','#dc2626','#7c3aed','#db2777','#2563eb'];
  const color = colors[Math.floor(Math.random()*colors.length)];

  // First user is admin
  const userCount = await queryOne('SELECT COUNT(*) as cnt FROM users');
  const role = (userCount && userCount.cnt === 0) ? 'admin' : 'user';

  let userId;
  if (isPostgres) {
    const r = await db.all('INSERT INTO users (username,email,password,display_name,avatar_color,role,last_login_ip,last_login_location) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id',
      [username,email,hashedPassword,username,color,role,ip||'',location||'']);
    userId = r[0].id;
  } else {
    db.run('INSERT INTO users (username,email,password,display_name,avatar_color,role,last_login_ip,last_login_location) VALUES (?,?,?,?,?,?,?,?)',
      [username,email,hashedPassword,username,color,role,ip||'',location||'']);
    userId = db.lastInsertRowid;
  }

  const defaultRooms = isPostgres ? await query('SELECT id FROM rooms') : db.all('SELECT id FROM rooms');
  for (const room of defaultRooms) {
    try { await execute('INSERT INTO room_members (room_id,user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [room.id, userId]); }
    catch(e) { try { execute('INSERT OR IGNORE INTO room_members (room_id,user_id) VALUES (?,?)', [room.id, userId]); } catch(e2) {} }
  }

  return await getUserById(userId);
}

async function authenticateUser(username, password) {
  const user = await queryOne('SELECT * FROM users WHERE username=$1', [username]);
  if (!user) {
    const u2 = await queryOne('SELECT * FROM users WHERE email=$1', [username]);
    if (!u2 || !bcrypt.compareSync(password, u2.password)) return null;
    return sanitizeUser(u2);
  }
  if (!bcrypt.compareSync(password, user.password)) return null;
  return sanitizeUser(user);
}

async function getUserById(id) {
  const user = await queryOne('SELECT * FROM users WHERE id=$1', [id]);
  return user ? sanitizeUser(user) : null;
}

async function getUserByUsername(username) {
  const user = await queryOne('SELECT * FROM users WHERE username=$1', [username]);
  return user ? sanitizeUser(user) : null;
}

function sanitizeUser(user) {
  const { password, ...safe } = user;
  return safe;
}

async function updateLastSeen(userId, ip, location) {
  if (isPostgres) {
    await execute("UPDATE users SET last_seen=NOW(), last_login_ip=$2, last_login_location=$3 WHERE id=$1", [userId, ip||'', location||'']);
  } else {
    await execute("UPDATE users SET last_seen=datetime('now','localtime'), last_login_ip=$2, last_login_location=$3 WHERE id=$1", [userId, ip||'', location||'']);
  }
}

async function recordLogin(userId, ip, location) {
  if (isPostgres) {
    await execute('INSERT INTO login_history (user_id, ip_address, location) VALUES ($1,$2,$3)', [userId, ip||'', location||'']);
  } else {
    await execute('INSERT INTO login_history (user_id, ip_address, location) VALUES ($1,$2,$3)', [userId, ip||'', location||'']);
  }
}

async function searchUsers(query, excludeUserId) {
  return await query(
    'SELECT id,username,display_name,avatar_color,last_seen FROM users WHERE (username ILIKE $1 OR display_name ILIKE $1) AND id!=$2 LIMIT 20',
    [`%${query}%`, excludeUserId]);
}

async function isUserAdmin(userId) {
  const u = await queryOne('SELECT role FROM users WHERE id=$1', [userId]);
  return u && u.role === 'admin';
}

// ========== Room Operations ==========

async function createRoom(name, description, userId) {
  const existing = await queryOne('SELECT id FROM rooms WHERE name=$1', [name]);
  if (existing) throw new Error('该房间名已存在');
  let roomId;
  if (isPostgres) {
    const r = await db.all('INSERT INTO rooms (name,description,created_by) VALUES ($1,$2,$3) RETURNING id', [name,description,userId]);
    roomId = r[0].id;
  } else {
    db.run('INSERT INTO rooms (name,description,created_by) VALUES (?,?,?)', [name,description,userId]);
    roomId = db.lastInsertRowid;
  }
  await execute('INSERT INTO room_members (room_id,user_id) VALUES ($1,$2)', [roomId, userId]);
  return await getRoomById(roomId);
}

async function getRoomById(roomId) {
  return await queryOne('SELECT * FROM rooms WHERE id=$1', [roomId]);
}

async function getUserRooms(userId) {
  return await query(`
    SELECT r.*, rm.joined_at,
      (SELECT COUNT(*) FROM room_members WHERE room_id=r.id)::int as member_count,
      (SELECT content FROM messages WHERE room_id=r.id ORDER BY created_at DESC LIMIT 1) as last_message,
      (SELECT username FROM messages m JOIN users u ON m.user_id=u.id WHERE m.room_id=r.id ORDER BY m.created_at DESC LIMIT 1) as last_message_user
    FROM rooms r JOIN room_members rm ON rm.room_id=r.id AND rm.user_id=$1
    ORDER BY rm.joined_at DESC`, [userId]);
}

async function getAllRooms() {
  if (isPostgres) {
    return await query(`SELECT r.*, (SELECT COUNT(*)::int FROM room_members WHERE room_id=r.id) as member_count FROM rooms r ORDER BY r.created_at ASC`);
  }
  return db.all(`SELECT r.*, (SELECT COUNT(*) FROM room_members WHERE room_id=r.id) as member_count FROM rooms r ORDER BY r.created_at ASC`);
}

async function joinRoom(roomId, userId) {
  try { await execute('INSERT INTO room_members (room_id,user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [roomId,userId]); }
  catch(e) { try { await execute('INSERT OR IGNORE INTO room_members (room_id,user_id) VALUES (?,?)', [roomId,userId]); } catch(e2) {} }
}

async function leaveRoom(roomId, userId) {
  await execute('DELETE FROM room_members WHERE room_id=$1 AND user_id=$2', [roomId, userId]);
}

async function getRoomMembers(roomId) {
  return await query(`SELECT u.id,u.username,u.display_name,u.avatar_color,u.last_seen,u.role FROM users u JOIN room_members rm ON rm.user_id=u.id WHERE rm.room_id=$1`, [roomId]);
}

async function isRoomMember(roomId, userId) {
  const r = await queryOne('SELECT id FROM room_members WHERE room_id=$1 AND user_id=$2', [roomId, userId]);
  return !!r;
}

async function deleteRoom(roomId) {
  await execute('DELETE FROM messages WHERE room_id=$1', [roomId]);
  await execute('DELETE FROM room_members WHERE room_id=$1', [roomId]);
  await execute('DELETE FROM rooms WHERE id=$1', [roomId]);
}

async function setRoomBanned(roomId, banned) {
  await execute('UPDATE rooms SET is_banned=$2 WHERE id=$1', [roomId, banned ? 1 : 0]);
}

async function isRoomBanned(roomId) {
  const r = await queryOne('SELECT is_banned FROM rooms WHERE id=$1', [roomId]);
  return r && r.is_banned === 1;
}

// ========== Message Operations ==========

async function saveMessage(roomId, userId, content, type, fileUrl) {
  const msgType = type || 'text';
  const msgFileUrl = fileUrl || '';
  let messageId;
  if (isPostgres) {
    const r = await db.all('INSERT INTO messages (room_id,user_id,content,type,file_url) VALUES ($1,$2,$3,$4,$5) RETURNING id', [roomId,userId,content,msgType,msgFileUrl]);
    messageId = r[0].id;
  } else {
    db.run('INSERT INTO messages (room_id,user_id,content,type,file_url) VALUES (?,?,?,?,?)', [roomId,userId,content,msgType,msgFileUrl]);
    messageId = db.lastInsertRowid;
  }
  return await getMessageById(messageId);
}

async function getMessageById(messageId) {
  return await queryOne(`SELECT m.*,u.username,u.display_name,u.avatar_color FROM messages m JOIN users u ON u.id=m.user_id WHERE m.id=$1`, [messageId]);
}

async function getRoomMessages(roomId, limit=50, beforeId=null) {
  if (beforeId) {
    const r = await query(`SELECT m.*,u.username,u.display_name,u.avatar_color FROM messages m JOIN users u ON u.id=m.user_id WHERE m.room_id=$1 AND m.id<$2 ORDER BY m.created_at DESC LIMIT $3`, [roomId,beforeId,limit]);
    return r.reverse();
  }
  return await query(`SELECT m.*,u.username,u.display_name,u.avatar_color FROM messages m JOIN users u ON u.id=m.user_id WHERE m.room_id=$1 ORDER BY m.created_at ASC LIMIT $2`, [roomId,limit]);
}

async function getUserMessages(userId, limit=100) {
  return await query(`SELECT m.*,r.name as room_name,u.username,u.display_name,u.avatar_color FROM messages m JOIN rooms r ON r.id=m.room_id JOIN users u ON u.id=m.user_id WHERE m.user_id=$1 ORDER BY m.created_at DESC LIMIT $2`, [userId, limit]);
}

async function getUserCreatedRooms(userId) {
  return await query(`SELECT r.*,(SELECT COUNT(*)::int FROM room_members WHERE room_id=r.id) as member_count FROM rooms r WHERE r.created_by=$1 ORDER BY r.created_at DESC`, [userId]);
}

// ========== Admin: Banned Keywords ==========

async function addBannedKeyword(keyword, adminId) {
  const existing = await queryOne('SELECT id FROM banned_keywords WHERE keyword=$1', [keyword]);
  if (existing) throw new Error('该关键词已存在');
  if (isPostgres) {
    const r = await db.all('INSERT INTO banned_keywords (keyword, created_by) VALUES ($1,$2) RETURNING id', [keyword, adminId]);
    return r[0].id;
  }
  db.run('INSERT INTO banned_keywords (keyword, created_by) VALUES (?,?)', [keyword, adminId]);
  return db.lastInsertRowid;
}

async function removeBannedKeyword(id) {
  await execute('DELETE FROM banned_keywords WHERE id=$1', [id]);
}

async function getBannedKeywords() {
  return await query('SELECT bk.*, u.username as created_by_name FROM banned_keywords bk LEFT JOIN users u ON u.id=bk.created_by ORDER BY bk.created_at DESC');
}

async function checkKeywordBlocked(content) {
  const keywords = await query('SELECT keyword FROM banned_keywords');
  const lower = content.toLowerCase();
  for (const k of keywords) {
    if (lower.includes(k.keyword.toLowerCase())) return k.keyword;
  }
  return null;
}

// ========== Admin: Mute ==========

async function muteUser(userId, roomId, mutedBy, durationMinutes) {
  let mutedUntil;
  if (isPostgres) {
    const r = await db.all(`SELECT NOW() + interval '${durationMinutes} minutes' as t`);
    mutedUntil = r[0].t;
  } else {
    // SQLite: calculate based on current time
    const now = new Date();
    const future = new Date(now.getTime() + durationMinutes * 60000);
    mutedUntil = future.toISOString().replace('T', ' ').substring(0, 19);
  }
  // Remove old mute records then add new one
  await execute('DELETE FROM muted_users WHERE user_id=$1 AND (room_id=$2 OR room_id IS NULL)', [userId, roomId || null]);
  await execute('INSERT INTO muted_users (user_id, room_id, muted_by, muted_until) VALUES ($1,$2,$3,$4)', [userId, roomId || null, mutedBy, mutedUntil]);
  return mutedUntil;
}

async function unmuteUser(userId, roomId) {
  await execute('DELETE FROM muted_users WHERE user_id=$1 AND (room_id=$2 OR room_id IS NULL)', [userId, roomId || null]);
}

async function isUserMuted(userId, roomId) {
  let mutes;
  if (isPostgres) {
    mutes = await query(
      'SELECT muted_until FROM muted_users WHERE user_id=$1 AND (room_id=$2 OR room_id IS NULL) AND muted_until > NOW() ORDER BY muted_until DESC LIMIT 1',
      [userId, roomId || null]);
  } else {
    mutes = await query(
      "SELECT muted_until FROM muted_users WHERE user_id=$1 AND (room_id=$2 OR room_id IS NULL) AND muted_until > datetime('now','localtime') ORDER BY muted_until DESC LIMIT 1",
      [userId, roomId || null]);
  }
  return mutes.length > 0 ? mutes[0].muted_until : null;
}

// ========== Admin: User/Room Info ==========

async function getAllUsers() {
  return await query(
    'SELECT id,username,email,display_name,avatar_color,role,created_at,last_seen,last_login_ip,last_login_location FROM users ORDER BY created_at DESC');
}

async function getUserPasswordHash(userId) {
  const r = await queryOne('SELECT password FROM users WHERE id=$1', [userId]);
  return r ? r.password : null;
}

async function getLoginHistory(userId, limit=20) {
  return await query('SELECT * FROM login_history WHERE user_id=$1 ORDER BY logged_in_at DESC LIMIT $2', [userId, limit]);
}

// ========== IP Geolocation ==========
async function lookupIP(ip) {
  // Local / private IPs
  if (!ip || ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1' || ip.startsWith('192.168.') || ip.startsWith('10.') || ip.startsWith('172.')) {
    return '本地网络';
  }
  try {
    if (!fetch) fetch = (await import('node-fetch')).default;
    const res = await fetch(`https://ipapi.co/${ip}/json/`, { timeout: 5000 });
    if (!res.ok) return '';
    const data = await res.json();
    if (data.error) return '';
    const parts = [];
    if (data.city) parts.push(data.city);
    if (data.region) parts.push(data.region);
    if (data.country_name) parts.push(data.country_name);
    return parts.join(' ') || '';
  } catch (e) {
    return '';
  }
}

module.exports = {
  initDatabase,
  createUser,
  authenticateUser,
  getUserById,
  getUserByUsername,
  updateLastSeen,
  recordLogin,
  searchUsers,
  isUserAdmin,
  createRoom,
  getRoomById,
  getUserRooms,
  getAllRooms,
  joinRoom,
  leaveRoom,
  getRoomMembers,
  isRoomMember,
  deleteRoom,
  setRoomBanned,
  isRoomBanned,
  saveMessage,
  getMessageById,
  getRoomMessages,
  getUserMessages,
  getUserCreatedRooms,
  addBannedKeyword,
  removeBannedKeyword,
  getBannedKeywords,
  checkKeywordBlocked,
  muteUser,
  unmuteUser,
  isUserMuted,
  getAllUsers,
  getUserPasswordHash,
  getLoginHistory,
  lookupIP,
};
