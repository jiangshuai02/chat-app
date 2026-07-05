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

// ========== Multer for file uploads ==========
const multer = require('multer');
const fs = require('fs');

const uploadsDir = path.join(__dirname, 'public', 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase() || '.jpg';
    const name = Date.now() + '-' + Math.round(Math.random() * 1e9) + ext;
    cb(null, name);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) cb(null, true);
    else cb(new Error('只允许上传图片文件'));
  }
});

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
    const { username, password } = req.body;
    let { email } = req.body;
    if (!username || !password) return res.status(400).json({ error: '请填写用户名和密码' });
    if (username.length < 2 || username.length > 20) return res.status(400).json({ error: '用户名长度为2-20个字符' });
    if (password.length < 6) return res.status(400).json({ error: '密码至少6个字符' });
    if (email && !email.includes('@')) return res.status(400).json({ error: '请输入有效的邮箱地址' });
    if (!email) email = `${username}@chatapp.local`; // auto-generate if not provided

    const ip = getClientIp(req);
    const location = await db.lookupIP(ip);
    const user = await db.createUser(username, email, password, ip, location);
    const isAdmin = await db.isUserAdmin(user.id);
    const isUltimateAdmin = user.is_ultimate_admin === 1;
    const token = jwt.sign({ id: user.id, username: user.username, isAdmin }, JWT_SECRET, { expiresIn: '7d' });
    
    // Record login with location
    await db.recordLogin(user.id, ip, location);
    
    res.json({ token, user: { ...user, isAdmin, isUltimateAdmin } });
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
    const location = await db.lookupIP(ip);
    await db.updateLastSeen(user.id, ip, location);
    await db.recordLogin(user.id, ip, location);
    
    const isAdmin = user.role === 'admin';
    const isUltimateAdmin = user.is_ultimate_admin === 1;
    const token = jwt.sign({ id: user.id, username: user.username, isAdmin }, JWT_SECRET, { expiresIn: '7d' });
    
    res.json({ token, user: { ...user, isAdmin, isUltimateAdmin } });
  } catch (err) {
    res.status(500).json({ error: '服务器错误' });
  }
});

app.get('/api/me', authenticateToken, async (req, res) => {
  const user = await db.getUserById(req.user.id);
  if (!user) return res.status(404).json({ error: '用户不存在' });
  const isAdmin = user.role === 'admin';
  const isUltimateAdmin = user.is_ultimate_admin === 1;
  res.json({ user: { ...user, isAdmin, isUltimateAdmin } });
});

// Image Upload Route
app.post('/api/upload', authenticateToken, upload.single('image'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: '没有上传图片' });
    const fileUrl = '/uploads/' + req.file.filename;
    res.json({ url: fileUrl });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Room Routes
app.get('/api/rooms', authenticateToken, async (req, res) => {
  try { const rooms = await db.getUserRooms(req.user.id); res.json({ rooms }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/rooms/all', authenticateToken, async (req, res) => {
  try { const rooms = await db.getAllRooms(req.user.id); res.json({ rooms }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/rooms', authenticateToken, async (req, res) => {
  try {
    const { name, description, password } = req.body;
    if (!name || name.trim().length === 0) return res.status(400).json({ error: '房间名不能为空' });
    if (name.length > 30) return res.status(400).json({ error: '房间名不能超过30个字符' });
    const room = await db.createRoom(name.trim(), description || '', req.user.id, password || '');
    res.json({ room });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.post('/api/rooms/:id/join', authenticateToken, async (req, res) => {
  try { 
    const isAdmin = req.user.isAdmin || await db.isUserAdmin(req.user.id);
    await db.joinRoom(parseInt(req.params.id), req.user.id, req.body.password || '', isAdmin); 
    res.json({ success: true }); 
  }
  catch (err) { res.status(400).json({ error: err.message }); }
});

app.post('/api/rooms/:id/leave', authenticateToken, async (req, res) => {
  try { await db.leaveRoom(parseInt(req.params.id), req.user.id); res.json({ success: true }); }
  catch (err) { res.status(400).json({ error: err.message }); }
});

app.get('/api/rooms/:id/members', authenticateToken, async (req, res) => {
  try {
    const roomId = parseInt(req.params.id);
    const members = await db.getRoomMembers(roomId);
    const online = members.map(m => ({ ...m, online: onlineUsers.has(String(m.id)) }));
    res.json({ members: online });
  } catch (err) { res.status(500).json({ error: err.message }); }
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

// Delete room: room admin or global admin can delete
app.delete('/api/rooms/:id', authenticateToken, async (req, res) => {
  try {
    const roomId = parseInt(req.params.id);
    const isAdmin = req.user.isAdmin || await db.isUserAdmin(req.user.id);
    const isRoomAdmin = await db.isRoomAdmin(roomId, req.user.id);
    if (!isAdmin && !isRoomAdmin) return res.status(403).json({ error: '只有房间管理员或超级管理员可以删除房间' });
    await db.deleteRoom(roomId);
    io.emit('room:deleted', roomId);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Friend Routes

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
    if (await db.isUltimateAdmin(userId)) return res.status(403).json({ error: '无法禁言最终超级管理员' });
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

// Message Recall (user can recall their own message, admin can recall any)
app.post('/api/messages/:id/recall', authenticateToken, async (req, res) => {
  try {
    const messageId = parseInt(req.params.id);
    const isAdmin = req.user.isAdmin || await db.isUserAdmin(req.user.id);
    const msg = await db.getMessageById(messageId);
    if (!msg) return res.status(404).json({ error: '消息不存在' });
    if (!isAdmin && msg.user_id !== req.user.id) return res.status(403).json({ error: '只能撤回自己的消息' });
    await db.recallMessage(messageId, msg.user_id);
    io.to(`room:${msg.room_id}`).emit('message:recalled', { messageId, roomId: msg.room_id });
    res.json({ success: true });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// Announcements (admin only)
app.get('/api/announcements', authenticateToken, async (req, res) => {
  try { res.json({ announcements: await db.getActiveAnnouncements() }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/admin/announcements', authenticateToken, requireAdmin, async (req, res) => {
  try { res.json({ announcements: await db.getAllAnnouncements() }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/admin/announcements', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { title, content } = req.body;
    if (!title || !content) return res.status(400).json({ error: '标题和内容不能为空' });
    const ann = await db.createAnnouncement(title, content, req.user.id);
    res.json({ announcement: ann });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.post('/api/admin/announcements/:id', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { title, content } = req.body;
    if (!title || !content) return res.status(400).json({ error: '标题和内容不能为空' });
    const ann = await db.updateAnnouncement(parseInt(req.params.id), title, content);
    res.json({ announcement: ann });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.delete('/api/admin/announcements/:id', authenticateToken, requireAdmin, async (req, res) => {
  try {
    await db.deleteAnnouncement(parseInt(req.params.id));
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/admin/announcements/:id/toggle', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { active } = req.body;
    await db.setAnnouncementActive(parseInt(req.params.id), active);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// User role management (admin only, cannot modify ultimate admin)
app.post('/api/admin/users/:id/role', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const userId = parseInt(req.params.id);
    const { role } = req.body;
    if (role !== 'admin' && role !== 'user') return res.status(400).json({ error: '无效的角色' });
    if (await db.isUltimateAdmin(userId)) return res.status(403).json({ error: '无法修改最终超级管理员' });
    await db.setUserRole(userId, role);
    // Notify the user about role change
    io.to(`user:${userId}`).emit('user:role-changed', { role });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ========== Friends API ==========

// Search users
app.get('/api/users/search', authenticateToken, async (req, res) => {
  try {
    const q = req.query.q || '';
    if (q.length < 1) return res.json({ users: [] });
    const users = await db.searchUsers(q, req.user.id);
    console.log(`🔍 User search: "${q}" by user ${req.user.id}, found ${users.length} results`);
    res.json({ users });
  } catch (err) {
    console.error('🔍 User search error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Send friend request
app.post('/api/friends/request', authenticateToken, async (req, res) => {
  try {
    const { friendId } = req.body;
    const friend = await db.sendFriendRequest(req.user.id, friendId);
    res.json({ success: true, friend });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// Accept friend request
app.post('/api/friends/accept', authenticateToken, async (req, res) => {
  try {
    const { requestId } = req.body;
    const friend = await db.acceptFriendRequest(req.user.id, requestId);
    io.to(`user:${req.user.id}`).emit('friend:updated');
    io.to(`user:${friend.id}`).emit('friend:updated');
    res.json({ success: true, friend });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// Reject friend request
app.post('/api/friends/reject', authenticateToken, async (req, res) => {
  try {
    const { requestId } = req.body;
    await db.rejectFriendRequest(req.user.id, requestId);
    res.json({ success: true });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// Get friend requests
app.get('/api/friends/requests', authenticateToken, async (req, res) => {
  try {
    const requests = await db.getFriendRequests(req.user.id);
    res.json({ requests });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Get friends list with online status
app.get('/api/friends', authenticateToken, async (req, res) => {
  try {
    const friends = await db.getFriends(req.user.id);
    const enriched = friends.map(f => ({ ...f, online: onlineUsers.has(String(f.id)) }));
    res.json({ friends: enriched });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Remove friend
app.delete('/api/friends/:friendId', authenticateToken, async (req, res) => {
  try {
    await db.removeFriend(req.user.id, parseInt(req.params.friendId));
    res.json({ success: true });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// ========== Private Messages API ==========

// Send private message
app.post('/api/private-messages', authenticateToken, async (req, res) => {
  try {
    const { receiverId, content, type, fileUrl } = req.body;
    if (!receiverId) return res.status(400).json({ error: '请指定接收者' });
    if (type !== 'image' && (!content || !content.trim())) return res.status(400).json({ error: '消息内容不能为空' });
    const message = await db.sendPrivateMessage(req.user.id, parseInt(receiverId), content || '', type || 'text', fileUrl || '');
    // Emit to recipient and sender
    const sender = await db.getUserById(req.user.id);
    const payload = {
      ...message,
      sender_username: sender.username,
      sender_display_name: sender.display_name,
      sender_avatar_color: sender.avatar_color
    };
    io.to(`user:${receiverId}`).emit('private:new', payload);
    io.to(`user:${req.user.id}`).emit('private:new', payload);
    res.json({ message });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// Get private messages with a friend
app.get('/api/private-messages/:friendId', authenticateToken, async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 50;
    const messages = await db.getPrivateMessages(req.user.id, parseInt(req.params.friendId), limit);
    res.json({ messages });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Recall private message
app.post('/api/private-messages/:id/recall', authenticateToken, async (req, res) => {
  try {
    const messageId = parseInt(req.params.id);
    const msg = await db.getPrivateMessageById ? await db.getPrivateMessageById(messageId) : null;
    // Use recallPrivateMessage which validates ownership
    const updated = await db.recallPrivateMessage(messageId, req.user.id);
    // Notify both parties
    io.to(`user:${updated.sender_id}`).emit('private:recalled', { messageId, senderId: updated.sender_id, receiverId: updated.receiver_id });
    io.to(`user:${updated.receiver_id}`).emit('private:recalled', { messageId, senderId: updated.sender_id, receiverId: updated.receiver_id });
    res.json({ success: true });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// Admin: Get all private messages for a user
app.get('/api/admin/private-messages/:userId', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const data = await db.getAllPrivateMessagesForAdmin(parseInt(req.params.userId));
    res.json(data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ========== Socket.IO ==========

const onlineUsers = new Map(); // userId -> Set of socketIds

io.use(async (socket, next) => {
  const token = socket.handshake.auth.token;
  if (!token) return next(new Error('未提供认证令牌'));
  jwt.verify(token, JWT_SECRET, async (err, decoded) => {
    if (err) return next(new Error('令牌无效'));
    // Verify user still exists in database (handles database resets/switches)
    try {
      const user = await db.getUserById(decoded.id);
      if (!user) return next(new Error('用户不存在，请重新登录'));
      socket.user = { ...decoded, ...user };
      next();
    } catch (e) {
      next(new Error('认证验证失败'));
    }
  });
});

io.on('connection', async (socket) => {
  const userId = String(socket.user.id);
  const username = socket.user.username;

  if (!onlineUsers.has(userId)) onlineUsers.set(userId, new Set());
  onlineUsers.get(userId).add(socket.id);

  // Update IP and location on every connection
  const clientIp = getClientIp({
    headers: socket.handshake.headers,
    ip: socket.handshake.address,
    connection: { remoteAddress: socket.handshake.address }
  });
  const location = await db.lookupIP(clientIp);
  await db.updateLastSeen(userId, clientIp, location);

  // Join user to their rooms
  const userRooms = await db.getUserRooms(userId);
  for (const room of userRooms) {
    socket.join(`room:${room.id}`);
  }
  socket.join(`user:${userId}`);

  broadcastUserStatus(userId, true);

  // ===== Socket Events =====

  socket.on('join:room', async (data) => {
    const roomId = typeof data === 'object' ? data.roomId : data;
    const password = typeof data === 'object' ? (data.password || '') : '';
    const room = await db.getRoomById(roomId);
    if (!room) return socket.emit('error', '房间不存在');
    
    // Check if room is banned
    const banned = await db.isRoomBanned(roomId);
    if (banned) return socket.emit('error', '该房间已被管理员禁用');
    
    // Super admin bypasses password
    const isSuperAdmin = socket.user.role === 'admin';
    const isMember = await db.isRoomMember(roomId, userId);
    
    await db.joinRoom(roomId, userId, password, isSuperAdmin);
    socket.join(`room:${roomId}`);
    const onlineInRoom = await getOnlineUsersInRoom(roomId);
    io.to(`room:${roomId}`).emit('room:online', onlineInRoom);
    const memberCount = await db.getRoomMemberCount(roomId);
    io.to(`room:${roomId}`).emit('room:members-changed', { roomId, memberCount });
    await broadcastUserStatus(userId, true);
  });

  socket.on('room:get-online', async (roomId) => {
    try {
      const onlineInRoom = await getOnlineUsersInRoom(roomId);
      socket.emit('room:online', onlineInRoom);
    } catch (err) { socket.emit('error', err.message); }
  });

  // Send message (with filtering)
  socket.on('message:send', async (data) => {
    try {
      const { roomId, content, type, fileUrl } = data;
      const msgType = type || 'text';
      const msgContent = content ? content.trim() : '';
      
      if (msgType === 'text') {
        if (!msgContent || msgContent.length === 0) return;
        if (msgContent.length > 2000) return socket.emit('error', '消息不能超过2000个字符');
      } else if (msgType === 'image') {
        if (!fileUrl) return socket.emit('error', '图片链接无效');
      } else {
        return socket.emit('error', '不支持的消息类型');
      }
      
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

      // Check keyword filter (only for text messages)
      if (msgType === 'text') {
        const blockedKeyword = await db.checkKeywordBlocked(msgContent);
        if (blockedKeyword) {
          socket.emit('message:blocked', `消息包含违禁关键词: "${blockedKeyword}"`);
          io.to(`room:${roomId}`).emit('admin:message-blocked', {
            userId, username, content: msgContent, keyword: blockedKeyword, roomId
          });
          return;
        }
      }

      const message = await db.saveMessage(roomId, userId, msgContent, msgType, fileUrl || '');
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

  socket.on('message:recall', async (messageId) => {
    try {
      const msg = await db.getMessageById(messageId);
      if (!msg) return socket.emit('error', '消息不存在');
      if (msg.user_id !== userId && socket.user.role !== 'admin') return socket.emit('error', '只能撤回自己的消息');
      await db.recallMessage(messageId, msg.user_id);
      io.to(`room:${msg.room_id}`).emit('message:recalled', { messageId, roomId: msg.room_id });
    } catch (err) { socket.emit('error', err.message); }
  });

  // ===== Private Message Events =====
  socket.on('private:send', async (data) => {
    try {
      const { receiverId, content, type, fileUrl } = data;
      if (!receiverId) return socket.emit('error', '请指定接收者');
      const msgType = type || 'text';
      const msgContent = content ? content.trim() : '';
      if (msgType === 'text' && (!msgContent || msgContent.length === 0)) return;
      if (msgType === 'text' && msgContent.length > 2000) return socket.emit('error', '消息不能超过2000个字符');
      
      const message = await db.sendPrivateMessage(userId, parseInt(receiverId), msgContent, msgType, fileUrl || '');
      io.to(`user:${receiverId}`).emit('private:new', { ...message, senderName: username, senderAvatar: socket.user.avatar_color });
      io.to(`user:${userId}`).emit('private:new', { ...message, senderName: username, senderAvatar: socket.user.avatar_color });
    } catch (err) { socket.emit('error', err.message); }
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
      const room = await db.createRoom(data.name, data.description || '', userId, data.password || '');
      socket.join(`room:${room.id}`);
      socket.emit('room:created', room);
      io.emit('room:new', room);
    } catch (err) {
      const msg = err.message?.includes('foreign key constraint') || err.message?.includes('created_by')
        ? '用户数据异常，请退出后重新登录注册'
        : err.message;
      socket.emit('error', msg);
    }
  });

  socket.on('room:leave', async (roomId) => {
    try {
      await db.leaveRoom(roomId, userId);
      socket.leave(`room:${roomId}`);
      const onlineInRoomLeft = await getOnlineUsersInRoom(roomId);
      io.to(`room:${roomId}`).emit('room:online', onlineInRoomLeft);
      const memberCountLeft = await db.getRoomMemberCount(roomId);
      io.to(`room:${roomId}`).emit('room:members-changed', { roomId, memberCount: memberCountLeft });
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

  // Emit friend:status-changed to the user's friends for real-time friend list updates
  try {
    const friends = await db.getFriends(userId);
    for (const friend of friends) {
      io.to(`user:${friend.id}`).emit('friend:status-changed', {
        userId: userId,
        username: user.username,
        online,
        last_seen: user.last_seen
      });
    }
  } catch (e) {
    // silently fail - friend status notification is best-effort
  }
}

async function getOnlineUsersInRoom(roomId) {
  const members = await db.getRoomMembers(roomId);
  return members.map(m => ({ ...m, online: onlineUsers.has(String(m.id)) }));
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
