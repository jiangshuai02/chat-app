const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const path = require('path');

const db = require('./db');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

const JWT_SECRET = process.env.JWT_SECRET || 'chat-app-secret-key-2024';
const PORT = process.env.PORT || 3000;

// ========== Middleware ==========
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

function getClientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (xff) return xff.split(',')[0].trim();
  return req.ip || req.connection?.remoteAddress || '';
}

// JWT Auth Middleware
function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ error: '未提供认证令牌' });
  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ error: '令牌无效或已过期' });
    req.user = user;
    next();
  });
}

// Admin Auth Middleware
async function requireAdmin(req, res, next) {
  const isAdmin = await db.isUserAdmin(req.user.id);
  if (!isAdmin) return res.status(403).json({ error: '权限不足，需要管理员身份' });
  next();
}

// ========== REST API ==========

// Auth Routes
app.post('/api/register', async (req, res) => {
  try {
    const { username, email, password } = req.body;
    if (!username || !email || !password) return res.status(400).json({ error: '请填写所有必填字段' });
    if (username.length < 2 || username.length > 20) return res.status(400).json({ error: '用户名长度为2-20个字符' });
    if (password.length < 6) return res.status(400).json({ error: '密码至少6个字符' });
    if (!email.includes('@')) return res.status(400).json({ error: '请输入有效的邮箱地址' });

    const ip = getClientIp(req);
    const user = await db.createUser(username, email, password, ip);
    const isAdmin = await db.isUserAdmin(user.id);
    const token = jwt.sign({ id: user.id, username: user.username, isAdmin }, JWT_SECRET, { expiresIn: '7d' });
    
    // Record login
    await db.recordLogin(user.id, ip);
    
    res.json({ token, user: { ...user, isAdmin } });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: '请填写用户名和密码' });

    const user = await db.authenticateUser(username, password);
    if (!user) return res.status(401).json({ error: '用户名或密码错误' });

    const ip = getClientIp(req);
    await db.updateLastSeen(user.id, ip);
    await db.recordLogin(user.id, ip);
    
    const isAdmin = user.role === 'admin';
    const token = jwt.sign({ id: user.id, username: user.username, isAdmin }, JWT_SECRET, { expiresIn: '7d' });
    
    res.json({ token, user: { ...user, isAdmin } });
  } catch (err) {
    res.status(500).json({ error: '服务器错误' });
  }
});

app.get('/api/me', authenticateToken, async (req, res) => {
  const user = await db.getUserById(req.user.id);
  if (!user) return res.status(404).json({ error: '用户不存在' });
  const isAdmin = user.role === 'admin';
  res.json({ user: { ...user, isAdmin } });
});

// Room Routes
app.get('/api/rooms', authenticateToken, async (req, res) => {
  try { const rooms = await db.getUserRooms(req.user.id); res.json({ rooms }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/rooms/all', authenticateToken, async (req, res) => {
  try { const rooms = await db.getAllRooms(); res.json({ rooms }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/rooms', authenticateToken, async (req, res) => {
  try {
    const { name, description } = req.body;
    if (!name || name.trim().length === 0) return res.status(400).json({ error: '房间名不能为空' });
    if (name.length > 30) return res.status(400).json({ error: '房间名不能超过30个字符' });
    const room = await db.createRoom(name.trim(), description || '', req.user.id);
    res.json({ room });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.post('/api/rooms/:id/join', authenticateToken, async (req, res) => {
  try { await db.joinRoom(parseInt(req.params.id), req.user.id); res.json({ success: true }); }
  catch (err) { res.status(400).json({ error: err.message }); }
});

app.post('/api/rooms/:id/leave', authenticateToken, async (req, res) => {
  try { await db.leaveRoom(parseInt(req.params.id), req.user.id); res.json({ success: true }); }
  catch (err) { res.status(400).json({ error: err.message }); }
});

app.get('/api/rooms/:id/members', authenticateToken, async (req, res) => {
  try { const members = await db.getRoomMembers(parseInt(req.params.id)); res.json({ members }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// Message Routes
app.get('/api/rooms/:id/messages', authenticateToken, async (req, res) => {
  try {
    const roomId = parseInt(req.params.id);
    const isMember = await db.isRoomMember(roomId, req.user.id);
    if (!isMember) return res.status(403).json({ error: '你未加入该房间' });
    const limit = parseInt(req.query.limit) || 50;
    const beforeId = req.query.before ? parseInt(req.query.before) : null;
    const messages = await db.getRoomMessages(roomId, limit, beforeId);
    res.json({ messages });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/users/search', authenticateToken, async (req, res) => {
  try {
    const query = req.query.q || '';
    if (query.length < 1) return res.json({ users: [] });
    const users = await db.searchUsers(query, req.user.id);
    res.json({ users });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ========== Admin Routes ==========

// Keywords
app.get('/api/admin/keywords', authenticateToken, requireAdmin, async (req, res) => {
  try { const keywords = await db.getBannedKeywords(); res.json({ keywords }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/admin/keywords', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { keyword } = req.body;
    if (!keyword || keyword.trim().length === 0) return res.status(400).json({ error: '关键词不能为空' });
    await db.addBannedKeyword(keyword.trim(), req.user.id);
    const keywords = await db.getBannedKeywords();
    io.emit('admin:keywords-updated', keywords);
    res.json({ keywords });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.delete('/api/admin/keywords/:id', authenticateToken, requireAdmin, async (req, res) => {
  try {
    await db.removeBannedKeyword(parseInt(req.params.id));
    const keywords = await db.getBannedKeywords();
    io.emit('admin:keywords-updated', keywords);
    res.json({ keywords });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Users
app.get('/api/admin/users', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const users = await db.getAllUsers();
    res.json({ users });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/admin/users/:id', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const userId = parseInt(req.params.id);
    const user = await db.getUserById(userId);
    if (!user) return res.status(404).json({ error: '用户不存在' });
    
    const passwordHash = await db.getUserPasswordHash(userId);
    const rooms = await db.getUserCreatedRooms(userId);
    const messages = await db.getUserMessages(userId, 50);
    const loginHistory = await db.getLoginHistory(userId, 20);
    
    res.json({ user, passwordHash, rooms, messages, loginHistory });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Mute
app.post('/api/admin/users/:id/mute', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const userId = parseInt(req.params.id);
    const { roomId, durationMinutes } = req.body;
    const mins = parseInt(durationMinutes) || 60;
    const mutedUntil = await db.muteUser(userId, roomId || null, req.user.id, mins);
    res.json({ success: true, mutedUntil });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/admin/users/:id/unmute', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const userId = parseInt(req.params.id);
    const { roomId } = req.body;
    await db.unmuteUser(userId, roomId || null);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Rooms
app.get('/api/admin/rooms', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const rooms = await db.getAllRooms();
    // Enrich with creator info
    const enriched = [];
    for (const room of rooms) {
      const creator = room.created_by ? await db.getUserById(room.created_by) : null;
      enriched.push({ ...room, creator_name: creator ? creator.username : '系统' });
    }
    res.json({ rooms: enriched });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/admin/rooms/:id', authenticateToken, requireAdmin, async (req, res) => {
  try {
    await db.deleteRoom(parseInt(req.params.id));
    io.emit('room:deleted', parseInt(req.params.id));
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/admin/rooms/:id/ban', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const roomId = parseInt(req.params.id);
    const { banned } = req.body;
    await db.setRoomBanned(roomId, banned);
    io.emit('room:banned', { roomId, banned: !!banned });
    res.json({ success: true, banned: !!banned });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ========== Socket.IO ==========

const onlineUsers = new Map(); // userId -> Set of socketIds

io.use((socket, next) => {
  const token = socket.handshake.auth.token;
  if (!token) return next(new Error('未提供认证令牌'));
  jwt.verify(token, JWT_SECRET, (err, decoded) => {
    if (err) return next(new Error('令牌无效'));
    socket.user = decoded;
    next();
  });
});

io.on('connection', async (socket) => {
  const userId = socket.user.id;
  const username = socket.user.username;

  if (!onlineUsers.has(userId)) onlineUsers.set(userId, new Set());
  onlineUsers.get(userId).add(socket.id);

  await db.updateLastSeen(userId);

  // Join user to their rooms
  const userRooms = await db.getUserRooms(userId);
  for (const room of userRooms) {
    socket.join(`room:${room.id}`);
  }
  socket.join(`user:${userId}`);

  broadcastUserStatus(userId, true);

  // ===== Socket Events =====

  socket.on('join:room', async (roomId) => {
    const room = await db.getRoomById(roomId);
    if (!room) return socket.emit('error', '房间不存在');
    
    // Check if room is banned
    const banned = await db.isRoomBanned(roomId);
    if (banned) return socket.emit('error', '该房间已被管理员禁用');
    
    await db.joinRoom(roomId, userId);
    socket.join(`room:${roomId}`);
    const onlineInRoom = await getOnlineUsersInRoom(roomId);
    io.to(`room:${roomId}`).emit('room:online', onlineInRoom);
    await broadcastUserStatus(userId, true);
  });

  // Send message (with filtering)
  socket.on('message:send', async (data) => {
    try {
      const { roomId, content } = data;
      if (!content || content.trim().length === 0) return;
      if (content.length > 2000) return socket.emit('error', '消息不能超过2000个字符');
      
      const isMember = await db.isRoomMember(roomId, userId);
      if (!isMember) return socket.emit('error', '你未加入该房间');

      // Check if room is banned
      const roomBanned = await db.isRoomBanned(roomId);
      if (roomBanned) return socket.emit('error', '该房间已被管理员禁用，无法发送消息');

      // Check if user is muted
      const mutedUntil = await db.isUserMuted(userId, roomId);
      if (mutedUntil) {
        return socket.emit('error', `你已被禁言，解禁时间: ${mutedUntil}`);
      }

      // Check keyword filter
      const blockedKeyword = await db.checkKeywordBlocked(content.trim());
      if (blockedKeyword) {
        // Notify only the sender that their message was blocked
        socket.emit('message:blocked', `消息包含违禁关键词: "${blockedKeyword}"`);
        // Notify admins who are in this room
        io.to(`room:${roomId}`).emit('admin:message-blocked', {
          userId, username, content: content.trim(), keyword: blockedKeyword, roomId
        });
        return;
      }

      const message = await db.saveMessage(roomId, userId, content.trim());
      const user = await db.getUserById(userId);
      if (!user) return;

      io.to(`room:${roomId}`).emit('message:new', {
        ...message,
        user: { id: user.id, username: user.username, display_name: user.display_name, avatar_color: user.avatar_color }
      });
    } catch (err) {
      socket.emit('error', err.message);
    }
  });

  socket.on('typing:start', (roomId) => {
    socket.to(`room:${roomId}`).emit('typing:update', { userId, username, action: 'start' });
  });
  socket.on('typing:stop', (roomId) => {
    socket.to(`room:${roomId}`).emit('typing:update', { userId, username, action: 'stop' });
  });

  socket.on('messages:load-more', async (data) => {
    try {
      const { roomId, beforeId } = data;
      const messages = await db.getRoomMessages(roomId, 30, beforeId);
      socket.emit('messages:loaded', { roomId, messages });
    } catch (err) { socket.emit('error', err.message); }
  });

  socket.on('room:create', async (data) => {
    try {
      const room = await db.createRoom(data.name, data.description || '', userId);
      socket.join(`room:${room.id}`);
      socket.emit('room:created', room);
      io.emit('room:new', room);
    } catch (err) { socket.emit('error', err.message); }
  });

  socket.on('room:leave', async (roomId) => {
    try {
      await db.leaveRoom(roomId, userId);
      socket.leave(`room:${roomId}`);
      const onlineInRoomLeft = await getOnlineUsersInRoom(roomId);
      io.to(`room:${roomId}`).emit('room:online', onlineInRoomLeft);
      socket.emit('room:left', roomId);
    } catch (err) { socket.emit('error', err.message); }
  });

  socket.on('disconnect', async () => {
    const sockets = onlineUsers.get(userId);
    if (sockets) {
      sockets.delete(socket.id);
      if (sockets.size === 0) {
        onlineUsers.delete(userId);
        await broadcastUserStatus(userId, false);
      }
    }
  });
});

async function broadcastUserStatus(userId, online) {
  const user = await db.getUserById(userId);
  if (!user) return;
  const userRooms = await db.getUserRooms(userId);
  for (const room of userRooms) {
    io.to(`room:${room.id}`).emit('user:status', { userId, username: user.username, online, last_seen: user.last_seen });
  }
}

async function getOnlineUsersInRoom(roomId) {
  const members = await db.getRoomMembers(roomId);
  return members.map(m => ({ ...m, online: onlineUsers.has(m.id) }));
}

// ========== Start Server ==========

async function startServer() {
  await db.initDatabase();
  app.get('/chat', (req, res) => res.sendFile(path.join(__dirname, 'public', 'chat.html')));
  app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Chat App 已启动！\n📡 http://localhost:${PORT}`);
  });
}

startServer().catch(err => { console.error('启动失败:', err); process.exit(1); });

module.exports = { app, server, io };
