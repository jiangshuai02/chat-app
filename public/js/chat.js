// ========== State ==========
const state = {
  token: localStorage.getItem('token') || '',
  user: JSON.parse(localStorage.getItem('user') || '{}'),
  socket: null,
  currentRoom: null,
  rooms: [],
  messages: new Map(),
  typingUsers: new Map(),
  hasMoreMessages: new Map(),
  loadMoreIds: new Map(),
  isAdmin: false,
};

if (!state.token || !state.user.id) window.location.href = '/';

const API = window.location.origin;

// ========== Socket Connection ==========
function connectSocket() {
  state.socket = io({
    auth: { token: state.token },
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 10000,
  });

  state.socket.on('connect', () => {
    hideConnectionStatus();
    loadRooms();
  });

  state.socket.on('disconnect', () => {
    showConnectionStatus('disconnected', '与服务器断开连接，正在重连...');
  });

  state.socket.on('connect_error', (err) => {
    if (err.message === '令牌无效') {
      localStorage.removeItem('token'); localStorage.removeItem('user');
      window.location.href = '/'; return;
    }
    showConnectionStatus('connecting', '正在连接...');
  });

  state.socket.on('message:new', (message) => {
    if (message.room_id === state.currentRoom?.id) { appendMessage(message); scrollToBottom(); }
    updateRoomLastMessage(message.room_id, message);
  });

  state.socket.on('messages:loaded', (data) => {
    const { roomId, messages } = data;
    if (roomId === state.currentRoom?.id) {
      prependMessages(messages);
      if (messages.length < 30) { state.hasMoreMessages.set(roomId, false); document.getElementById('loadMore').style.display = 'none'; }
    }
  });

  state.socket.on('room:created', (room) => {
    state.rooms.unshift(room); renderRooms(); switchRoom(room.id); closeCreateRoom();
  });

  state.socket.on('room:new', (room) => {
    if (!state.rooms.find(r=>r.id===room.id)) { state.rooms.push(room); renderRooms(); }
  });

  state.socket.on('room:left', (roomId) => {
    if (state.currentRoom?.id === roomId) { state.currentRoom = null; showEmptyState(); }
    loadRooms();
  });

  state.socket.on('room:online', (members) => {
    if (state.currentRoom) updateMembersDisplay(members);
    if (document.getElementById('membersModal').classList.contains('show')) renderMembers(members);
  });

  state.socket.on('user:status', (data) => {
    if (state.currentRoom) updateRoomOnlineCount();
  });

  state.socket.on('typing:update', (data) => {
    if (data.userId === state.user.id) return;
    if (data.action === 'start') state.typingUsers.set(data.userId, data.username);
    else state.typingUsers.delete(data.userId);
    updateTypingIndicator();
  });

  state.socket.on('error', (msg) => showToast(msg, 'error'));

  // ===== Admin Socket Events =====
  state.socket.on('message:blocked', (msg) => showToast(msg, 'error'));
  
  state.socket.on('admin:message-blocked', (data) => {
    if (state.isAdmin) {
      showToast(`🚫 ${data.username} 的消息被屏蔽: "${data.keyword}"`, 'error');
    }
  });

  state.socket.on('admin:keywords-updated', (keywords) => {
    if (state.isAdmin) renderKeywords(keywords);
  });

  state.socket.on('room:deleted', (roomId) => {
    if (state.currentRoom?.id === roomId) { state.currentRoom = null; showEmptyState(); }
    state.rooms = state.rooms.filter(r => r.id !== roomId);
    renderRooms();
  });

  state.socket.on('room:banned', ({ roomId, banned }) => {
    if (state.currentRoom?.id === roomId) {
      showToast(banned ? '该房间已被管理员禁用' : '该房间已解除禁用', 'error');
    }
  });
}

// ========== Connection Status ==========
function showConnectionStatus(type, msg) {
  const e = document.querySelector('.connection-status');
  if (e) e.remove();
  const el = document.createElement('div');
  el.className = `connection-status ${type}`;
  el.textContent = msg;
  document.body.prepend(el);
}
function hideConnectionStatus() { const e = document.querySelector('.connection-status'); if (e) e.remove(); }

// ========== Sidebar ==========
function toggleSidebar() {
  document.getElementById('sidebar').classList.toggle('open');
  document.getElementById('sidebarOverlay').classList.toggle('show');
}
function closeSidebar() { if (window.innerWidth <= 768) { document.getElementById('sidebar').classList.remove('open'); document.getElementById('sidebarOverlay').classList.remove('show'); } }

// ========== Room Management ==========
async function loadRooms() {
  try {
    const res = await fetch(`${API}/api/rooms`, { headers: { 'Authorization': `Bearer ${state.token}` } });
    const data = await res.json();
    state.rooms = data.rooms || [];
    renderRooms();
  } catch(e) { console.error(e); }
}

function renderRooms() {
  const container = document.getElementById('roomsList');
  const q = (document.getElementById('roomSearch')?.value || '').toLowerCase();
  let filtered = q ? state.rooms.filter(r => r.name.toLowerCase().includes(q)) : state.rooms;
  if (!filtered.length) {
    container.innerHTML = `<div style="text-align:center;padding:24px;color:var(--gray-400);font-size:13px;">${q?'没有匹配的房间':'暂无房间，点击上方 + 创建一个'}</div>`;
    return;
  }
  const colors = ['#4f46e5','#0891b2','#059669','#d97706','#dc2626','#7c3aed','#db2777','#2563eb'];
  container.innerHTML = filtered.map(room => {
    const active = state.currentRoom?.id === room.id;
    return `<div class="room-item${active?' active':''}" onclick="switchRoom(${room.id})">
      <div class="room-avatar" style="background:${colors[room.id%colors.length]}">${room.name.charAt(0).toUpperCase()}</div>
      <div class="room-info"><div class="room-name">${esc(room.name)}</div>
        <div class="room-last-msg">${room.last_message_user?`${esc(room.last_message_user)}: ${esc(room.last_message||'')}`:'暂无消息'}</div></div>
      <div class="room-meta"><div class="room-member-count">${room.member_count || 0} 人</div></div>
    </div>`;
  }).join('');
}

function filterRooms(q) { renderRooms(); }

async function switchRoom(roomId) {
  if (state.currentRoom?.id === roomId) return;
  if (state.currentRoom) state.typingUsers.clear();
  const room = state.rooms.find(r => r.id === roomId);
  if (!room) return;
  state.currentRoom = room;
  document.querySelectorAll('.room-item').forEach(el => el.classList.remove('active'));
  renderRooms();
  document.getElementById('currentRoomTitle').textContent = room.name;
  document.getElementById('currentRoomMeta').textContent = `${room.member_count||0} 位成员`;
  document.getElementById('membersBtn').style.display = 'inline-flex';
  document.getElementById('emptyState').style.display = 'none';
  document.getElementById('messagesContainer').style.display = 'flex';
  document.getElementById('inputArea').style.display = 'flex';
  document.getElementById('messagesList').innerHTML = '';
  state.messages.delete(roomId);
  state.socket.emit('join:room', roomId);
  await loadMessages(roomId);
  scrollToBottom();
  closeSidebar();
}

async function loadMessages(roomId) {
  try {
    const res = await fetch(`${API}/api/rooms/${roomId}/messages?limit=50`, { headers: { 'Authorization': `Bearer ${state.token}` } });
    if (!res.ok) {
      if (res.status === 403) {
        await fetch(`${API}/api/rooms/${roomId}/join`, { method: 'POST', headers: { 'Authorization': `Bearer ${state.token}` } });
        return loadMessages(roomId);
      }
      throw new Error('加载消息失败');
    }
    const data = await res.json();
    const msgs = data.messages || [];
    state.messages.set(roomId, msgs);
    state.hasMoreMessages.set(roomId, msgs.length >= 50);
    document.getElementById('loadMore').style.display = msgs.length >= 50 ? 'block' : 'none';
    if (msgs.length >= 50) state.loadMoreIds.set(roomId, msgs[0]?.id);
    renderMessages(msgs);
  } catch(e) { showToast('加载消息失败', 'error'); }
}

function loadMoreMessages() {
  if (!state.currentRoom) return;
  const beforeId = state.loadMoreIds.get(state.currentRoom.id);
  if (!beforeId) return;
  state.socket.emit('messages:load-more', { roomId: state.currentRoom.id, beforeId });
}

// ========== Message Rendering ==========
function renderMessages(msgs) { document.getElementById('messagesList').innerHTML = ''; msgs.forEach(m => appendMessageToContainer(document.getElementById('messagesList'), m)); }
function appendMessage(msg) { appendMessageToContainer(document.getElementById('messagesList'), msg); }

function appendMessageToContainer(container, msg) {
  const own = msg.user_id === state.user.id;
  const username = msg.display_name || msg.username || 'Unknown';
  const time = formatTime(msg.created_at);
  const div = document.createElement('div');
  div.className = `message${own?' own':''}`;
  div.dataset.messageId = msg.id;
  
  let contentHtml = '';
  if (msg.type === 'image' || msg.file_url) {
    contentHtml = `<div class="message-image"><a href="${esc(msg.file_url)}" target="_blank"><img src="${esc(msg.file_url)}" alt="图片" loading="lazy"></a></div>${msg.content ? `<div class="message-bubble">${esc(msg.content)}</div>` : ''}`;
  } else {
    contentHtml = `<div class="message-bubble">${esc(msg.content)}</div>`;
  }
  
  div.innerHTML = `<div class="message-avatar" style="background:${msg.avatar_color||'#4f46e5'}">${username.charAt(0).toUpperCase()}</div>
    <div class="message-body"><div class="message-header"><span class="message-username">${esc(username)}</span><span class="message-time">${time}</span></div>
    ${contentHtml}</div>`;
  container.appendChild(div);
}

function prependMessages(msgs) {
  const container = document.getElementById('messagesList');
  const first = container.firstChild;
  const frag = document.createDocumentFragment();
  msgs.forEach(m => appendMessageToContainer(frag, m));
  if (first) container.insertBefore(frag, first); else container.appendChild(frag);
  if (msgs.length > 0) {
    state.loadMoreIds.set(state.currentRoom.id, msgs[0]?.id);
    state.hasMoreMessages.set(state.currentRoom.id, msgs.length >= 30);
    if (msgs.length < 30) document.getElementById('loadMore').style.display = 'none';
  }
}

function updateRoomLastMessage(roomId, msg) {
  const room = state.rooms.find(r => r.id === roomId);
  if (room) { 
    room.last_message = msg.type === 'image' ? '[图片]' : msg.content;
    room.last_message_user = msg.username || msg.display_name;
    renderRooms();
  }
}

// ========== Sending Messages ==========
async function sendMessage() {
  const input = document.getElementById('messageInput');
  const content = input.value.trim();
  if (!content || !state.currentRoom) return;
  state.socket.emit('message:send', { roomId: state.currentRoom.id, content, type: 'text' });
  input.value = '';
  autoResize(input);
  state.socket.emit('typing:stop', state.currentRoom.id);
  document.getElementById('sendBtn').disabled = true;
  setTimeout(() => { document.getElementById('sendBtn').disabled = false; }, 200);
}

async function handleImageUpload(event) {
  const file = event.target.files[0];
  if (!file || !state.currentRoom) return;
  if (!file.type.startsWith('image/')) {
    showToast('请选择图片文件', 'error');
    return;
  }
  if (file.size > 5 * 1024 * 1024) {
    showToast('图片不能超过 5MB', 'error');
    return;
  }
  
  const formData = new FormData();
  formData.append('image', file);
  
  try {
    showToast('正在上传图片...', 'info');
    const res = await fetch(`${API}/api/upload`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${state.token}` },
      body: formData
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || '上传失败');
    
    state.socket.emit('message:send', { roomId: state.currentRoom.id, type: 'image', fileUrl: data.url });
    event.target.value = '';
  } catch (err) {
    showToast(err.message || '上传失败', 'error');
  }
}

function handleKeyDown(e) { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); } }
function autoResize(t) { t.style.height = 'auto'; t.style.height = Math.min(t.scrollHeight, 120) + 'px'; }

// ========== Typing ==========
let typingTimeout = null;
function onTyping() {
  if (!state.currentRoom) return;
  if (!typingTimeout) state.socket.emit('typing:start', state.currentRoom.id);
  clearTimeout(typingTimeout);
  typingTimeout = setTimeout(() => { state.socket.emit('typing:stop', state.currentRoom.id); typingTimeout = null; }, 2000);
}

function updateTypingIndicator() {
  const container = document.getElementById('typingIndicator');
  const users = Array.from(state.typingUsers.values());
  if (users.length === 0) { container.innerHTML = ''; return; }
  let text = users.length === 1 ? `${esc(users[0])} 正在输入` : users.length === 2 ? `${esc(users[0])} 和 ${esc(users[1])} 正在输入` : `${esc(users[0])} 和其他 ${users.length-1} 人正在输入`;
  container.innerHTML = `${text}<div class="typing-dots"><span></span><span></span><span></span></div>`;
}

// ========== Emoji Picker ==========
function toggleEmojiPicker() {
  const picker = document.getElementById('emojiPicker');
  picker.style.display = picker.style.display === 'none' ? 'block' : 'none';
  if (picker.style.display === 'block' && !picker.hasChildNodes) {
    const emojis = ['😀','😃','😄','😁','😅','😂','🤣','😊','😇','🙂','😉','😌','😍','🥰','😘','😗','😋','😛','😜','🤪','😝','🤑','🤗','🤭','🤫','🤔','🤐','🤨','😐','😑','😶','😏','😒','🙄','😬','🤥','😌','😔','😪','🤤','😴','😷','🤒','🤕','🤢','🤮','🥴','😵','👍','👎','👊','✊','🤛','🤜','👏','🙌','👐','🤲','🤝','🙏','✌️','🤟','🤘','👌','❤️','🧡','💛','💚','💙','💜','🖤','🤍','🤎','💔','❤️‍🔥','❤️‍🩹','💖','💗','💓','💞','🔥','⭐','✨','💫','🌟','💥','💯','🎉','🎊','🎈','🎁','🎀','🏆','🥇','🥈','🥉'];
    document.getElementById('emojiGrid').innerHTML = emojis.map(e => `<button onclick="insertEmoji('${e}')">${e}</button>`).join('');
  }
}
function insertEmoji(emoji) { document.getElementById('messageInput').value += emoji; document.getElementById('messageInput').focus(); toggleEmojiPicker(); }
document.addEventListener('click', (e) => {
  const picker = document.getElementById('emojiPicker');
  const btn = document.querySelector('.emoji-btn');
  if (!picker.contains(e.target) && !btn.contains(e.target)) picker.style.display = 'none';
});

// ========== Create Room ==========
function showCreateRoom() {
  document.getElementById('createRoomModal').classList.add('show');
  document.getElementById('roomName').value = ''; document.getElementById('roomDesc').value = ''; document.getElementById('roomError').textContent = '';
  document.getElementById('roomName').focus();
}
function closeCreateRoom() { document.getElementById('createRoomModal').classList.remove('show'); }
function createRoom() {
  const name = document.getElementById('roomName').value.trim();
  const description = document.getElementById('roomDesc').value.trim();
  const err = document.getElementById('roomError');
  if (!name) { err.textContent = '请输入房间名称'; return; }
  if (name.length > 30) { err.textContent = '房间名不能超过30个字符'; return; }
  state.socket.emit('room:create', { name, description });
}

// ========== Room Members ==========
async function showRoomMembers() {
  if (!state.currentRoom) return;
  document.getElementById('membersModal').classList.add('show');
  try {
    const res = await fetch(`${API}/api/rooms/${state.currentRoom.id}/members`, { headers: { 'Authorization': `Bearer ${state.token}` } });
    const data = await res.json();
    renderMembers(data.members || []);
  } catch(e) { console.error(e); }
}
function renderMembers(members) {
  document.getElementById('membersList').innerHTML = !members?.length
    ? '<div style="text-align:center;padding:20px;color:var(--gray-400);">暂无成员</div>'
    : members.map(m => `<div class="member-item" data-user-id="${m.id}">
      <div class="member-avatar" style="background:${m.avatar_color||'#4f46e5'}">${(m.display_name||m.username).charAt(0).toUpperCase()}</div>
      <div class="member-info"><div class="member-name">${esc(m.display_name||m.username)}</div>
      <div class="member-status${m.online?' online':''}">${m.online?'在线':'离线'}${m.role==='admin'?' · 管理员':''}</div></div>
    </div>`).join('');
}
function closeMembers() { document.getElementById('membersModal').classList.remove('show'); }
function updateMembersDisplay(members) {
  if (state.currentRoom) {
    const on = members.filter(m=>m.online).length;
    document.getElementById('currentRoomMeta').textContent = `${on} 人在线 · ${members.length} 位成员`;
  }
}
function updateRoomOnlineCount() {}

// ========== Helpers ==========
function formatTime(d) {
  if (!d) return '';
  // Handle PostgreSQL timestamps already containing timezone, SQLite strings without Z, etc.
  const raw = typeof d === 'string' ? d.trim() : d;
  const date = new Date(raw.endsWith('Z') || raw.includes('+') ? raw : raw + 'Z');
  if (isNaN(date.getTime())) return '';
  const now = new Date();
  const h = String(date.getHours()).padStart(2,'0');
  const m = String(date.getMinutes()).padStart(2,'0');
  if (date.toDateString() === now.toDateString()) return `${h}:${m}`;
  const y = new Date(now); y.setDate(y.getDate()-1);
  if (date.toDateString() === y.toDateString()) return `昨天 ${h}:${m}`;
  return `${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')} ${h}:${m}`;
}
function scrollToBottom() { setTimeout(() => { document.getElementById('messagesList').scrollTop = document.getElementById('messagesList').scrollHeight; }, 50); }
function esc(t) { if (!t) return ''; const d = document.createElement('div'); d.textContent = t; return d.innerHTML; }
function showEmptyState() {
  document.getElementById('emptyState').style.display = 'flex';
  document.getElementById('messagesContainer').style.display = 'none';
  document.getElementById('inputArea').style.display = 'none';
  document.getElementById('currentRoomTitle').textContent = '选择一个房间';
  document.getElementById('currentRoomMeta').textContent = '';
  document.getElementById('membersBtn').style.display = 'none';
}

function showToast(msg, type) {
  const existing = document.querySelector('.toast');
  if (existing) existing.remove();
  const t = document.createElement('div');
  t.className = 'toast';
  t.style.cssText = `position:fixed;bottom:80px;left:50%;transform:translateX(-50%);background:${type==='error'?'#ef4444':'#1e293b'};color:white;padding:10px 20px;border-radius:8px;font-size:14px;z-index:500;animation:messageIn 0.2s ease;box-shadow:0 4px 12px rgba(0,0,0,0.15);max-width:90vw;text-align:center;`;
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => { t.style.opacity = '0'; t.style.transition = 'opacity 0.3s'; setTimeout(() => t.remove(), 300); }, 3000);
}

function handleLogout() {
  localStorage.removeItem('token'); localStorage.removeItem('user');
  if (state.socket) state.socket.disconnect();
  window.location.href = '/';
}

// ========== Admin Panel ==========
let adminKeywords = [];

async function checkAdminStatus() {
  try {
    const res = await fetch(`${API}/api/me`, { headers: { 'Authorization': `Bearer ${state.token}` } });
    const data = await res.json();
    if (data.user?.isAdmin) {
      state.isAdmin = true;
      document.getElementById('adminBtn').style.display = 'inline-flex';
    }
  } catch(e) {}
}

function showAdminPanel() {
  document.getElementById('adminModal').classList.add('show');
  switchAdminTab('keywords');
  loadAdminData('keywords');
}

function closeAdminPanel() { document.getElementById('adminModal').classList.remove('show'); }

function switchAdminTab(tab) {
  document.querySelectorAll('.admin-tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.admin-tab-content').forEach(c => c.classList.remove('active'));
  document.querySelector(`[data-tab="${tab}"]`).classList.add('active');
  document.getElementById(`admin${tab.charAt(0).toUpperCase()+tab.slice(1)}`).classList.add('active');
  loadAdminData(tab);
}

async function loadAdminData(tab) {
  if (tab === 'keywords') await loadKeywords();
  else if (tab === 'users') await loadUsers();
  else if (tab === 'rooms') await loadAdminRooms();
}

// ---- Keywords ----
async function loadKeywords() {
  try {
    const res = await fetch(`${API}/api/admin/keywords`, { headers: { 'Authorization': `Bearer ${state.token}` } });
    const data = await res.json();
    adminKeywords = data.keywords || [];
    renderKeywords(adminKeywords);
  } catch(e) { console.error(e); }
}

function renderKeywords(keywords) {
  const container = document.getElementById('keywordList');
  if (!keywords?.length) { container.innerHTML = '<div style="text-align:center;padding:20px;color:var(--gray-400);font-size:13px;">暂无屏蔽关键词</div>'; return; }
  container.innerHTML = keywords.map(k => `
    <div class="admin-item">
      <div class="admin-item-info">
        <span class="admin-item-title">${esc(k.keyword)}</span>
        <span class="admin-item-sub">由 ${esc(k.created_by_name||'管理员')} 添加 · ${formatTime(k.created_at)}</span>
      </div>
      <button class="btn btn-secondary btn-sm" onclick="deleteKeyword(${k.id})">删除</button>
    </div>
  `).join('');
}

async function addKeyword() {
  const input = document.getElementById('keywordInput');
  const keyword = input.value.trim();
  if (!keyword) return;
  try {
    const res = await fetch(`${API}/api/admin/keywords`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${state.token}` },
      body: JSON.stringify({ keyword })
    });
    if (!res.ok) { const d = await res.json(); showToast(d.error, 'error'); return; }
    input.value = '';
  } catch(e) { showToast('添加失败', 'error'); }
}

async function deleteKeyword(id) {
  try {
    await fetch(`${API}/api/admin/keywords/${id}`, { method: 'DELETE', headers: { 'Authorization': `Bearer ${state.token}` } });
  } catch(e) { showToast('删除失败', 'error'); }
}

// ---- Users ----
async function loadUsers() {
  try {
    const res = await fetch(`${API}/api/admin/users`, { headers: { 'Authorization': `Bearer ${state.token}` } });
    const data = await res.json();
    renderUsers(data.users || []);
  } catch(e) { console.error(e); }
}

function renderUsers(users) {
  const container = document.getElementById('userList');
  if (!users.length) { container.innerHTML = '<div style="text-align:center;padding:20px;color:var(--gray-400);">暂无用户</div>'; return; }
  container.innerHTML = users.map(u => `
    <div class="admin-item">
      <div class="user-avatar-sm" style="background:${u.avatar_color||'#4f46e5'}">${(u.display_name||u.username).charAt(0).toUpperCase()}</div>
      <div class="admin-item-info">
        <span class="admin-item-title">${esc(u.display_name||u.username)} ${u.role==='admin'?'<span class="admin-badge">管理员</span>':''}</span>
        <span class="admin-item-sub">${esc(u.email)} · ${u.last_login_location ? esc(u.last_login_location) : '未知位置'} · IP: ${u.last_login_ip||'未知'} · 注册: ${u.created_at}</span>
      </div>
      <div class="admin-item-actions">
        <button class="btn btn-secondary btn-sm" onclick="viewUserDetail(${u.id})">详情</button>
        <button class="btn btn-danger btn-sm" onclick="showMuteModal(${u.id},'${esc(u.username)}')">禁言</button>
      </div>
    </div>
  `).join('');
}

async function viewUserDetail(userId) {
  document.getElementById('userDetailModal').classList.add('show');
  document.getElementById('userDetailContent').innerHTML = '<div class="loading-spinner"></div>';
  try {
    const res = await fetch(`${API}/api/admin/users/${userId}`, { headers: { 'Authorization': `Bearer ${state.token}` } });
    if (!res.ok) { document.getElementById('userDetailContent').innerHTML = '<p style="color:var(--danger);text-align:center;">获取用户详情失败</p>'; return; }
    const data = await res.json();
    document.getElementById('userDetailTitle').textContent = `用户详情: ${esc(data.user.username)}`;
    let html = `<div class="detail-section">
      <h4>基本信息</h4>
      <table class="detail-table">
        <tr><td>用户名</td><td>${esc(data.user.username)}</td></tr>
        <tr><td>邮箱</td><td>${esc(data.user.email)}</td></tr>
        <tr><td>角色</td><td>${data.user.role === 'admin' ? '管理员' : '普通用户'}</td></tr>
        <tr><td>注册时间</td><td>${data.user.created_at}</td></tr>
        <tr><td>最后在线</td><td>${data.user.last_seen}</td></tr>
        <tr><td>最近IP</td><td>${data.user.last_login_ip || '未知'}</td></tr>
        <tr><td>IP归属地</td><td>${data.user.last_login_location || '未知'}</td></tr>
        <tr><td>密码哈希</td><td style="font-size:11px;word-break:break-all;font-family:monospace;">${data.passwordHash || '无法获取'}</td></tr>
      </table>
    </div>`;

    if (data.loginHistory?.length) {
      html += `<div class="detail-section"><h4>登录记录 (IP/时间)</h4>`;
      data.loginHistory.forEach(h => {
        html += `<div class="login-record"><span class="login-ip">${h.ip_address||'未知'}</span><span class="login-location">${h.location||''}</span><span class="login-time">${h.logged_in_at}</span></div>`;
      });
      html += `</div>`;
    }

    if (data.rooms?.length) {
      html += `<div class="detail-section"><h4>创建的聊天室 (${data.rooms.length})</h4>`;
      data.rooms.forEach(r => {
        html += `<div class="login-record"><span>🏠 ${esc(r.name)}</span><span>成员: ${r.member_count||0}</span></div>`;
      });
      html += `</div>`;
    }

    if (data.messages?.length) {
      html += `<div class="detail-section"><h4>最近消息 (${data.messages.length})</h4>`;
      data.messages.slice(0, 20).forEach(m => {
        html += `<div class="user-msg-item"><span class="msg-room">${esc(m.room_name||'')}</span><span class="msg-content">${esc(m.content)}</span><span class="msg-time">${formatTime(m.created_at)}</span></div>`;
      });
      html += `</div>`;
    }

    document.getElementById('userDetailContent').innerHTML = html;
  } catch(e) {
    document.getElementById('userDetailContent').innerHTML = '<p style="color:var(--danger);text-align:center;">加载失败</p>';
  }
}

function closeUserDetail() { document.getElementById('userDetailModal').classList.remove('show'); }

// ---- Mute ----
let muteTargetUserId = null;
let muteTargetUsername = '';

function showMuteModal(userId, username) {
  muteTargetUserId = userId;
  muteTargetUsername = username;
  document.getElementById('muteUserLabel').textContent = `禁言用户: ${username}`;
  document.getElementById('muteModal').classList.add('show');
  document.getElementById('muteError').textContent = '';
}

function closeMuteModal() { document.getElementById('muteModal').classList.remove('show'); }

async function confirmMute() {
  const durationMinutes = parseInt(document.getElementById('muteDuration').value);
  const scope = document.getElementById('muteScope').value;
  const roomId = scope === 'current' && state.currentRoom ? state.currentRoom.id : null;
  try {
    const res = await fetch(`${API}/api/admin/users/${muteTargetUserId}/mute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${state.token}` },
      body: JSON.stringify({ roomId, durationMinutes })
    });
    if (!res.ok) { const d = await res.json(); document.getElementById('muteError').textContent = d.error; return; }
    showToast(`已禁言 ${muteTargetUsername} ${durationMinutes} 分钟`, 'error');
    closeMuteModal();
  } catch(e) { showToast('禁言失败', 'error'); }
}

// ---- Admin Rooms ----
async function loadAdminRooms() {
  try {
    const res = await fetch(`${API}/api/admin/rooms`, { headers: { 'Authorization': `Bearer ${state.token}` } });
    const data = await res.json();
    renderAdminRooms(data.rooms || []);
  } catch(e) { console.error(e); }
}

function renderAdminRooms(rooms) {
  const container = document.getElementById('adminRoomList');
  if (!rooms.length) { container.innerHTML = '<div style="text-align:center;padding:20px;color:var(--gray-400);">暂无房间</div>'; return; }
  const colors = ['#4f46e5','#0891b2','#059669','#d97706','#dc2626','#7c3aed','#db2777','#2563eb'];
  container.innerHTML = rooms.map(r => `
    <div class="admin-item">
      <div class="room-avatar-sm" style="background:${colors[r.id%colors.length]}">${r.name.charAt(0).toUpperCase()}</div>
      <div class="admin-item-info">
        <span class="admin-item-title">${esc(r.name)} ${r.is_banned?'<span class="badge-danger">已禁用</span>':''}</span>
        <span class="admin-item-sub">创建者: ${esc(r.creator_name||'系统')} · 成员: ${r.member_count||0} · ${r.created_at}</span>
      </div>
      <div class="admin-item-actions">
        <button class="btn btn-secondary btn-sm" onclick="toggleRoomBan(${r.id},${r.is_banned?0:1})">${r.is_banned?'启用':'禁用'}</button>
        <button class="btn btn-danger btn-sm" onclick="deleteAdminRoom(${r.id})">删除</button>
      </div>
    </div>
  `).join('');
}

async function toggleRoomBan(roomId, banned) {
  try {
    await fetch(`${API}/api/admin/rooms/${roomId}/ban`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${state.token}` },
      body: JSON.stringify({ banned: !!banned })
    });
    loadAdminRooms();
  } catch(e) { showToast('操作失败', 'error'); }
}

async function deleteAdminRoom(roomId) {
  if (!confirm('确定要永久删除这个房间吗？所有消息也会被删除！')) return;
  try {
    await fetch(`${API}/api/admin/rooms/${roomId}`, { method: 'DELETE', headers: { 'Authorization': `Bearer ${state.token}` } });
    loadAdminRooms();
  } catch(e) { showToast('删除失败', 'error'); }
}

// Modal close handler
function closeModal(e) { if (e.target.classList.contains('modal-overlay')) e.target.classList.remove('show'); }

// Escape key
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    closeCreateRoom(); closeMembers(); closeAdminPanel(); closeUserDetail(); closeMuteModal();
  }
});

// Scroll to top to trigger load more
document.getElementById('messagesList')?.addEventListener('scroll', function() {
  if (this.scrollTop < 50 && state.currentRoom && state.hasMoreMessages.get(state.currentRoom.id)) {
    if (document.getElementById('loadMore').style.display !== 'none') loadMoreMessages();
  }
});

// ========== Init ==========
async function initPage() {
  const avatar = document.getElementById('userAvatar');
  const userName = document.getElementById('userName');
  if (state.user.display_name || state.user.username) {
    userName.textContent = state.user.display_name || state.user.username;
    avatar.style.background = state.user.avatar_color || '#4f46e5';
    avatar.textContent = (state.user.display_name || state.user.username).charAt(0).toUpperCase();
  }
  await checkAdminStatus();
  connectSocket();
}

initPage();
