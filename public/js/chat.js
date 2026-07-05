// ========== State ==========
const state = {
  token: localStorage.getItem('token') || '',
  user: JSON.parse(localStorage.getItem('user') || '{}'),
  socket: null,
  currentRoom: null,
  currentFriend: null,
  rooms: [],
  messages: new Map(),
  privateMessages: [],
  typingUsers: new Map(),
  hasMoreMessages: new Map(),
  loadMoreIds: new Map(),
  isAdmin: false,
  isUltimateAdmin: false,
  pendingRoomPassword: null,
  friends: [],
  dnd: localStorage.getItem('dnd') === 'true',
  missedCount: 0,
  missedMessages: [],
  notificationGranted: false,
};

let mobileBannerTimer = null;

if (!state.token || !state.user.id) window.location.href = '/';

const API = window.location.origin;

// ========== Audio (iOS-friendly) ==========
let audioCtx = null;
let audioResumed = false;
let audioEl = null;

function getAudioContext() {
  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  if (!AudioCtx) return null;
  if (!audioCtx || audioCtx.state === 'closed') {
    audioCtx = new AudioCtx();
  }
  return audioCtx;
}

function getAudioElement() {
  if (!audioEl) {
    audioEl = new Audio('/assets/beep.wav');
    audioEl.volume = 0.5;
  }
  return audioEl;
}

function resumeAudioContext() {
  const ctx = getAudioContext();
  if (ctx && ctx.state === 'suspended') {
    ctx.resume().then(() => { audioResumed = true; }).catch(() => {});
  } else if (ctx) {
    audioResumed = true;
  }
}

function setupAudioResume() {
  const handler = () => {
    resumeAudioContext();
    // Prime audio element on iOS (required before playback)
    const el = getAudioElement();
    el.play().then(() => el.pause()).catch(() => {});
    document.removeEventListener('click', handler);
    document.removeEventListener('touchstart', handler);
    document.removeEventListener('keydown', handler);
  };
  document.addEventListener('click', handler);
  document.addEventListener('touchstart', handler);
  document.addEventListener('keydown', handler);
}

function playMessageSound() {
  try {
    const ctx = getAudioContext();
    if (ctx && ctx.state !== 'closed') {
      if (ctx.state === 'suspended') {
        ctx.resume().then(() => playBeep(ctx)).catch(() => playAudioElement());
      } else {
        playBeep(ctx);
      }
      return;
    }
    playAudioElement();
  } catch (e) { playAudioElement(); }
}

function playBeep(ctx) {
  try {
    const oscillator = ctx.createOscillator();
    const gain = ctx.createGain();
    oscillator.connect(gain);
    gain.connect(ctx.destination);
    oscillator.type = 'sine';
    oscillator.frequency.setValueAtTime(800, ctx.currentTime);
    gain.gain.setValueAtTime(0.1, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.15);
    oscillator.start();
    oscillator.stop(ctx.currentTime + 0.15);
  } catch (e) { playAudioElement(); }
}

function playAudioElement() {
  try {
    const el = getAudioElement();
    el.currentTime = 0;
    el.play().catch(() => {});
  } catch (e) {}
}

// ========== Socket Connection ==========
function connectSocket() {
  if (state.socket) {
    state.socket.removeAllListeners();
    state.socket.close();
    state.socket = null;
  }
  state.socket = io({
    auth: { token: state.token },
    reconnection: true,
    reconnectionAttempts: 5,
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
    const isOwn = message.user_id === state.user.id;
    if (message.room_id === state.currentRoom?.id) { appendMessage(message); scrollToBottom(); }
    updateRoomLastMessage(message.room_id, message);
    if (!isOwn) {
      if (document.hidden) {
        state.missedCount++;
        state.missedMessages.push(message);
        showNativeNotification(
          message.display_name || message.username || '新消息',
          message.type === 'image' ? '[图片]' : (message.content || '')
        );
      } else {
        playMessageSound();
        showMobileBanner(message);
      }
    }
  });

  state.socket.on('message:recalled', ({ messageId }) => {
    if (state.currentRoom) updateRecalledMessage(messageId);
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

  state.socket.on('room:members-changed', ({ roomId, memberCount }) => {
    const room = state.rooms.find(r => r.id === roomId);
    if (room) { room.member_count = memberCount; renderRooms(); }
    if (state.currentRoom?.id === roomId) {
      document.getElementById('currentRoomMeta').textContent = `${memberCount} 位成员`;
    }
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

  state.socket.on('friend:updated', () => {
    loadFriends();
  });

  state.socket.on('friend:status-changed', (data) => {
    // Update a specific friend's online status in the rendered list without a full reload
    const friend = state.friends.find(f => Number(f.id) === Number(data.userId));
    if (friend) {
      friend.online = data.online;
      friend.last_seen = data.last_seen;
      // Re-render the friends list
      renderFriends(state.friends);
      // If this friend is the current private chat partner, update the topbar status
      if (state.currentFriend && Number(state.currentFriend.id) === Number(data.userId)) {
        document.getElementById('currentRoomMeta').textContent = data.online ? '在线' : '离线';
        state.currentFriend.online = data.online;
      }
    }
  });

  // ===== Private Message Events =====
  state.socket.on('private:new', (message) => {
    const isOwn = message.sender_id === state.user.id;
    const otherId = isOwn ? message.receiver_id : message.sender_id;
    if (state.currentFriend && Number(state.currentFriend.id) === Number(otherId)) {
      appendPrivateMessage(message);
      scrollToBottom();
    }
    // Update friend list last message
    if (state.friends.length > 0) {
      loadFriends();
    }
    if (!isOwn) {
      if (document.hidden) {
        state.missedCount++;
        const senderName = message.sender_display_name || message.sender_username || message.display_name || message.username || '新消息';
        state.missedMessages.push(message);
        showNativeNotification(senderName, message.type === 'image' ? '[图片]' : (message.content || ''));
      } else {
        playMessageSound();
        showMobileBanner(message);
      }
    }
  });

  state.socket.on('private:recalled', ({ messageId }) => {
    if (state.currentFriend) updatePrivateRecalledMessage(messageId);
  });

  state.socket.on('user:role-changed', (data) => {
    state.user.isAdmin = data.role === 'admin';
    state.isAdmin = data.role === 'admin';
    localStorage.setItem('user', JSON.stringify({ ...state.user, isAdmin: state.isAdmin }));
    if (data.role === 'admin') {
      showToast('🎉 你已被提升为超级管理员', 'success');
      document.getElementById('adminBtn').style.display = 'inline-flex';
    } else {
      showToast('你的管理员权限已被取消', 'error');
      document.getElementById('adminBtn').style.display = 'none';
    }
  });

  // ===== Admin Socket Events =====
  state.socket.on('message:blocked', (msg) => showToast(msg, 'error'));
  
  state.socket.on('admin:message-blocked', (data) => {
    if (state.isAdmin) {
      showToast(`🚫 ${data.username} 的消息被屏蔽: "${data.keyword}"`, 'error');
    }
  });

  state.socket.on('user:muted', (data) => {
    if (state.currentRoom) {
      appendMuteNotice(data.userId, data.durationMinutes);
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

// ========== Reconnect ==========
function reconnect() {
  if (state.socket) {
    state.socket.removeAllListeners();
    state.socket.close();
  }
  state.socket = null;
  connectSocket();
}

// ========== Sidebar ==========
function toggleSidebar() {
  document.getElementById('sidebar').classList.toggle('open');
  document.getElementById('sidebarOverlay').classList.toggle('show');
}
function closeSidebar() { if (window.innerWidth <= 768) { document.getElementById('sidebar').classList.remove('open'); document.getElementById('sidebarOverlay').classList.remove('show'); } }

// ========== Room Management ==========
async function loadRooms() {
  try {
    const res = await fetch(`${API}/api/rooms/all`, { headers: { 'Authorization': `Bearer ${state.token}` } });
    const data = await res.json();
    state.rooms = data.rooms || [];
    renderRooms();
  } catch(e) { console.error(e); }
}

function renderRooms() {
  const container = document.getElementById('roomsList');
  const q = (document.getElementById('roomSearch')?.value || '').toLowerCase().trim();
  let filtered = q ? state.rooms.filter(r => {
    const search = q;
    return (r.name && r.name.toLowerCase().includes(search)) ||
           (r.description && r.description.toLowerCase().includes(search)) ||
           (r.creator_name && r.creator_name.toLowerCase().includes(search));
  }) : state.rooms;
  if (!filtered.length) {
    container.innerHTML = `<div style="text-align:center;padding:24px;color:var(--gray-400);font-size:13px;">${q?'没有匹配的房间':'暂无房间，点击上方 + 创建一个'}</div>`;
    return;
  }
  const colors = ['#4f46e5','#0891b2','#059669','#d97706','#dc2626','#7c3aed','#db2777','#2563eb'];
  container.innerHTML = filtered.map(room => {
    const active = state.currentRoom?.id === room.id;
    const isJoined = room.is_joined || state.isAdmin;
    const isRoomAdmin = room.is_room_admin || room.created_by === state.user.id;
    const lockIcon = room.has_password ? '🔒' : '';
    const adminBadge = isRoomAdmin ? '<span class="room-admin-badge">管</span>' : '';
    const joinBadge = !isJoined ? '<span class="badge-join">未加入</span>' : '';
    return `<div class="room-item${active?' active':''}" onclick="switchRoom(${room.id})">
      <div class="room-avatar" style="background:${colors[room.id%colors.length]}">${room.name.charAt(0).toUpperCase()}</div>
      <div class="room-info"><div class="room-name">${esc(room.name)} ${lockIcon} ${adminBadge} ${joinBadge}</div>
        <div class="room-last-msg">${room.last_message_user?`${esc(room.last_message_user)}: ${esc(room.last_message||'')}`:'暂无消息'}</div></div>
      <div class="room-meta"><div class="room-member-count">${room.member_count || 0} 人</div></div>
    </div>`;
  }).join('');
}

function filterRooms(q) {
  const clearBtn = document.getElementById('searchClear');
  if (clearBtn) clearBtn.style.display = q ? 'inline-flex' : 'none';
  renderRooms();
}

function clearRoomSearch() {
  document.getElementById('roomSearch').value = '';
  filterRooms('');
}

async function switchRoom(roomId, password = '') {
  if (state.currentRoom?.id === roomId) return;
  if (state.currentRoom) state.typingUsers.clear();
  const room = state.rooms.find(r => r.id === roomId);
  if (!room) return;

  // Check password-protected room
  if (room.has_password && !room.is_joined && !state.isAdmin && !password) {
    state.pendingRoomPassword = roomId;
    document.getElementById('roomPasswordLabel').textContent = `房间 "${esc(room.name)}" 需要密码`;
    document.getElementById('roomPasswordInput').value = '';
    document.getElementById('roomPasswordError').textContent = '';
    document.getElementById('roomPasswordModal').classList.add('show');
    return;
  }

  state.currentRoom = room;
  state.currentFriend = null;
  document.querySelectorAll('.room-item').forEach(el => el.classList.remove('active'));
  renderRooms();
  renderFriends(state.friends);
  document.getElementById('currentRoomTitle').textContent = room.name;
  document.getElementById('currentRoomMeta').textContent = `${room.member_count||0} 位成员`;
  document.getElementById('membersBtn').style.display = 'inline-flex';
  document.getElementById('backToRoomBtn').style.display = 'none';
  document.getElementById('mobileBackBtn').style.display = 'none';
  document.getElementById('hamburgerBtn').style.display = '';
  const isRoomAdmin = room.is_room_admin || room.created_by === state.user.id;
  document.getElementById('deleteRoomBtn').style.display = (isRoomAdmin || state.isAdmin) ? 'inline-flex' : 'none';
  document.getElementById('emptyState').style.display = 'none';
  document.getElementById('messagesContainer').style.display = 'flex';
  document.getElementById('inputArea').style.display = 'flex';
  document.getElementById('messagesList').innerHTML = '';
  state.messages.delete(roomId);
  state.socket.emit('join:room', { roomId, password });
  await loadMessages(roomId);
  scrollToBottom();
  closeSidebar();
}

async function loadMessages(roomId) {
  try {
    const res = await fetch(`${API}/api/rooms/${roomId}/messages?limit=50`, { headers: { 'Authorization': `Bearer ${state.token}` } });
    if (!res.ok) {
      if (res.status === 403) {
        // Try joining via API (for password-protected rooms this will fail without password)
        const joinRes = await fetch(`${API}/api/rooms/${roomId}/join`, { method: 'POST', headers: { 'Authorization': `Bearer ${state.token}` } });
        if (!joinRes.ok) {
          const room = state.rooms.find(r => r.id === roomId);
          if (room) {
            state.pendingRoomPassword = roomId;
            document.getElementById('roomPasswordLabel').textContent = `房间 "${esc(room.name)}" 需要密码`;
            document.getElementById('roomPasswordInput').value = '';
            document.getElementById('roomPasswordError').textContent = '需要密码才能进入';
            document.getElementById('roomPasswordModal').classList.add('show');
          }
          return;
        }
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
  div.className = `message${own?' own':''}${msg.is_recalled?' recalled':''}`;
  div.dataset.messageId = msg.id;
  div.dataset.userId = msg.user_id;
  
  const canRecall = own || state.isAdmin;
  const recallBtn = canRecall ? `<button class="msg-recall-btn" onclick="recallMessage(${msg.id})" title="撤回">↩️</button>` : '';
  
  let contentHtml = '';
  if (msg.is_recalled) {
    if (state.isAdmin) {
      // Admin sees original content with recalled label
      contentHtml = `<div class="message-bubble recalled-bubble"><span class="recall-label">[已撤回] </span>${msg.type === 'image' && msg.file_url ? `<div class="message-image"><a href="${esc(msg.file_url)}" target="_blank"><img src="${esc(msg.file_url)}" alt="图片" loading="lazy"></a></div>` : ''}${msg.content ? esc(msg.content) : ''}</div>`;
    } else {
      contentHtml = `<div class="message-bubble recalled-bubble">消息已撤回</div>`;
    }
  } else if (msg.type === 'image' || msg.file_url) {
    contentHtml = `<div class="message-image"><a href="${esc(msg.file_url)}" target="_blank"><img src="${esc(msg.file_url)}" alt="图片" loading="lazy"></a></div>${msg.content ? `<div class="message-bubble">${esc(msg.content)}</div>` : ''}`;
  } else {
    contentHtml = `<div class="message-bubble">${esc(msg.content)}</div>`;
  }
  
  const avatarClickable = !own ? ' clickable' : '';
  div.innerHTML = `<div class="message-avatar${avatarClickable}" style="background:${msg.avatar_color||'#4f46e5'}">${username.charAt(0).toUpperCase()}</div>
    <div class="message-body"><div class="message-header"><span class="message-username">${esc(username)}</span><span class="message-time">${time}</span>${recallBtn}</div>
    ${contentHtml}</div>`;
  container.appendChild(div);
}

function updateRecalledMessage(messageId) {
  const container = document.getElementById('messagesList');
  const div = container.querySelector(`[data-message-id="${messageId}"]`);
  if (div && state.currentRoom) {
    const msgs = state.messages.get(state.currentRoom.id) || [];
    const msg = msgs.find(m => String(m.id) === String(messageId));
    if (msg) {
      msg.is_recalled = 1;
      // Update only bubble content, not the whole message
      const bubble = div.querySelector('.message-bubble');
      if (bubble) {
        if (state.isAdmin) {
          const original = msg.content || '';
          bubble.className = 'message-bubble recalled-bubble';
          bubble.innerHTML = `<span class="recall-label">[已撤回] </span>${original ? esc(original) : ''}`;
        } else {
          bubble.className = 'message-bubble recalled-bubble';
          bubble.textContent = '消息已撤回';
        }
      }
      div.classList.add('recalled');
    }
  }
}

async function recallMessage(messageId) {
  try {
    const res = await fetch(`${API}/api/messages/${messageId}/recall`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${state.token}` }
    });
    if (!res.ok) { const d = await res.json(); showToast(d.error, 'error'); return; }
    updateRecalledMessage(messageId);
  } catch (e) { showToast('撤回失败', 'error'); }
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
function toggleEmojiPicker(event) {
  if (event) event.stopPropagation();
  const picker = document.getElementById('emojiPicker');
  const grid = document.getElementById('emojiGrid');
  picker.style.display = picker.style.display === 'none' ? 'block' : 'none';
  if (picker.style.display === 'block' && !grid.children.length) {
    const emojis = ['😀','😃','😄','😁','😅','😂','🤣','😊','😇','🙂','😉','😌','😍','🥰','😘','😗','😋','😛','😜','🤪','😝','🤑','🤗','🤭','🤫','🤔','🤐','🤨','😐','😑','😶','😏','😒','🙄','😬','🤥','😌','😔','😪','🤤','😴','😷','🤒','🤕','🤢','🤮','🥴','😵','👍','👎','👊','✊','🤛','🤜','👏','🙌','👐','🤲','🤝','🙏','✌️','🤟','🤘','👌','❤️','🧡','💛','💚','💙','💜','🖤','🤍','🤎','💔','💖','💗','💓','💞','🔥','⭐','✨','💫','🌟','💥','💯','🎉','🎊','🎈','🎁','🎀','🏆','🥇','🥈','🥉'];
    grid.innerHTML = emojis.map(e => `<button type="button" onclick="insertEmoji('${e}')">${e}</button>`).join('');
  }
}
function insertEmoji(emoji) {
  if (event) event.stopPropagation();
  const input = document.getElementById('messageInput');
  input.value += emoji;
  input.focus();
  autoResize(input);
  toggleEmojiPicker();
}
document.addEventListener('click', (e) => {
  const picker = document.getElementById('emojiPicker');
  const btn = document.querySelector('.emoji-btn');
  if (picker.style.display === 'block' && !picker.contains(e.target) && !btn.contains(e.target)) picker.style.display = 'none';
});

// ========== Create Room ==========
function showCreateRoom() {
  document.getElementById('createRoomModal').classList.add('show');
  document.getElementById('roomName').value = ''; document.getElementById('roomDesc').value = ''; document.getElementById('roomPassword').value = ''; document.getElementById('roomError').textContent = '';
  document.getElementById('roomName').focus();
}
function closeCreateRoom() { document.getElementById('createRoomModal').classList.remove('show'); }
function createRoom() {
  const name = document.getElementById('roomName').value.trim();
  const description = document.getElementById('roomDesc').value.trim();
  const password = document.getElementById('roomPassword').value;
  const err = document.getElementById('roomError');
  if (!name) { err.textContent = '请输入房间名称'; return; }
  if (name.length > 30) { err.textContent = '房间名不能超过30个字符'; return; }
  state.socket.emit('room:create', { name, description, password });
}

async function deleteCurrentRoom() {
  if (!state.currentRoom) return;
  if (!confirm(`确定要删除房间 "${state.currentRoom.name}" 吗？该操作不可恢复。`)) return;
  try {
    const res = await fetch(`${API}/api/rooms/${state.currentRoom.id}`, { method: 'DELETE', headers: { 'Authorization': `Bearer ${state.token}` } });
    if (!res.ok) { const d = await res.json(); showToast(d.error, 'error'); return; }
    state.rooms = state.rooms.filter(r => r.id !== state.currentRoom.id);
    state.currentRoom = null;
    document.getElementById('currentRoomTitle').textContent = '选择一个房间';
    document.getElementById('currentRoomMeta').textContent = '';
    document.getElementById('membersBtn').style.display = 'none';
    document.getElementById('deleteRoomBtn').style.display = 'none';
    document.getElementById('messagesContainer').style.display = 'none';
    document.getElementById('inputArea').style.display = 'none';
    document.getElementById('emptyState').style.display = 'flex';
    renderRooms();
    showToast('房间已删除', 'success');
  } catch (e) { showToast('删除失败', 'error'); }
}

// ========== Room Password Modal ==========
function closeRoomPasswordModal() {
  document.getElementById('roomPasswordModal').classList.remove('show');
  state.pendingRoomPassword = null;
}
async function confirmRoomPassword() {
  const roomId = state.pendingRoomPassword;
  const password = document.getElementById('roomPasswordInput').value;
  if (!roomId) return;
  try {
    const res = await fetch(`${API}/api/rooms/${roomId}/join`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${state.token}` },
      body: JSON.stringify({ password })
    });
    if (!res.ok) {
      const data = await res.json();
      document.getElementById('roomPasswordError').textContent = data.error || '密码错误';
      return;
    }
    closeRoomPasswordModal();
    await switchRoom(roomId, password);
  } catch (e) {
    document.getElementById('roomPasswordError').textContent = '进入房间失败';
  }
}

// ========== Room Members ==========
async function showRoomMembers() {
  if (!state.currentRoom) return;
  document.getElementById('membersModal').classList.add('show');
  try {
    const res = await fetch(`${API}/api/rooms/${state.currentRoom.id}/members`, { headers: { 'Authorization': `Bearer ${state.token}` } });
    const data = await res.json();
    renderMembers(data.members || []);
    // Also request fresh online status via socket
    state.socket.emit('room:get-online', state.currentRoom.id);
  } catch(e) { console.error(e); }
}
function renderMembers(members) {
  document.getElementById('membersList').innerHTML = !members?.length
    ? '<div style="text-align:center;padding:20px;color:var(--gray-400);">暂无成员</div>'
    : members.map(m => {
      const isSuperAdmin = m.role === 'admin';
      const isRoomAdmin = m.is_admin;
      const badge = isSuperAdmin ? '<span class="badge-gold">超管</span>' : (isRoomAdmin ? '<span class="admin-badge">房管</span>' : '');
      return `<div class="member-item" data-user-id="${m.id}">
      <div class="member-avatar" style="background:${m.avatar_color||'#4f46e5'}">${(m.display_name||m.username).charAt(0).toUpperCase()}</div>
      <div class="member-info"><div class="member-name">${esc(m.display_name||m.username)} ${badge}</div>
      <div class="member-status${m.online?' online':''}">${m.online?'在线':'离线'}</div></div>
    </div>`;
    }).join('');
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
  state.currentFriend = null;
  document.getElementById('emptyState').style.display = 'flex';
  document.getElementById('messagesContainer').style.display = 'none';
  document.getElementById('inputArea').style.display = 'none';
  document.getElementById('currentRoomTitle').textContent = '选择一个房间';
  document.getElementById('currentRoomMeta').textContent = '';
  document.getElementById('membersBtn').style.display = 'none';
  document.getElementById('backToRoomBtn').style.display = 'none';
  document.getElementById('mobileBackBtn').style.display = 'none';
  document.getElementById('hamburgerBtn').style.display = '';
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

// ========== Do Not Disturb ==========
function toggleDND() {
  state.dnd = !state.dnd;
  localStorage.setItem('dnd', state.dnd);
  const btn = document.getElementById('dndToggle');
  if (state.dnd) {
    btn.style.color = 'var(--danger)';
    btn.style.background = 'var(--gray-100)';
    showToast('免打扰已开启', 'info');
  } else {
    btn.style.color = '';
    btn.style.background = '';
    showToast('免打扰已关闭', 'info');
  }
}

// Apply DND styling on init
function initDNDButton() {
  const btn = document.getElementById('dndToggle');
  if (state.dnd) {
    btn.style.color = 'var(--danger)';
    btn.style.background = 'var(--gray-100)';
  }
}

// ========== Mobile Banner (WeChat Style) ==========
function showMobileBanner(message) {
  if (window.innerWidth > 768) return;
  if (state.dnd) return;
  if (mobileBannerTimer) {
    clearTimeout(mobileBannerTimer);
    const existing = document.querySelector('.mobile-banner');
    if (existing) existing.remove();
  }
  const isRoomMsg = message.room_id !== undefined;
  const senderName = message.senderName || message.username || message.display_name || (isRoomMsg ? '' : 'Unknown');
  const contentPreview = message.type === 'image' ? '[图片]' : (message.content || '');
  const avatarColor = message.avatar_color || message.sender_avatar_color || '#4f46e5';
  const now = new Date();
  const timeStr = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

  const banner = document.createElement('div');
  banner.className = 'mobile-banner';

  // Avatar circle
  const avatar = document.createElement('div');
  avatar.className = 'banner-avatar';
  avatar.style.background = avatarColor;
  avatar.textContent = senderName.charAt(0).toUpperCase();

  // Content area
  const content = document.createElement('div');
  content.className = 'banner-content';
  const nameLine = document.createElement('div');
  nameLine.className = 'banner-name';
  nameLine.textContent = senderName;
  const textLine = document.createElement('div');
  textLine.className = 'banner-text';
  textLine.textContent = contentPreview;
  content.appendChild(nameLine);
  content.appendChild(textLine);

  // Time
  const timeEl = document.createElement('div');
  timeEl.className = 'banner-time';
  timeEl.textContent = timeStr;

  banner.appendChild(avatar);
  banner.appendChild(content);
  banner.appendChild(timeEl);

  // Click navigates to the chat
  banner.addEventListener('click', () => {
    banner.classList.add('dismissing');
    setTimeout(() => {
      banner.remove();
      if (isRoomMsg && message.room_id) {
        switchRoom(message.room_id);
      } else if (!isRoomMsg) {
        const otherId = message.sender_id === state.user.id ? message.receiver_id : message.sender_id;
        if (otherId) openPrivateChat(otherId);
      }
    }, 200);
  });

  document.body.appendChild(banner);
  mobileBannerTimer = setTimeout(() => {
    banner.classList.add('dismissing');
    setTimeout(() => {
      banner.remove();
      mobileBannerTimer = null;
    }, 300);
  }, 2000);
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
    if (data.user?.isUltimateAdmin) {
      state.isUltimateAdmin = true;
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
  else if (tab === 'announcements') await loadAnnouncements();
  else if (tab === 'private-msgs') await loadAdminPrivateUsers();
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
  container.innerHTML = users.map(u => {
    const isUltimate = u.is_ultimate_admin === 1;
    const isAdmin = u.role === 'admin';
    const canManageRole = state.isAdmin && !isUltimate;
    const roleBtn = canManageRole
      ? `<button class="btn btn-${isAdmin?'danger':'primary'} btn-sm" onclick="toggleUserRole(${u.id},'${isAdmin?'user':'admin'}')">${isAdmin?'取消管理员':'设为管理员'}</button>`
      : '';
    const isMuted = u.is_muted;
    const muteBtn = isUltimate ? '' : (isMuted
      ? `<button class="btn btn-primary btn-sm" onclick="unmuteUser(${u.id})">解除禁言</button>`
      : `<button class="btn btn-danger btn-sm" onclick="showMuteModal(${u.id},'${esc(u.username)}')">禁言</button>`);
    const badge = isUltimate ? '<span class="badge-gold">终极超管</span>' : (isAdmin ? '<span class="admin-badge">超管</span>' : '');
    return `
    <div class="admin-item">
      <div class="user-avatar-sm" style="background:${u.avatar_color||'#4f46e5'}">${(u.display_name||u.username).charAt(0).toUpperCase()}</div>
      <div class="admin-item-info">
        <span class="admin-item-title">${esc(u.display_name||u.username)} ${badge}</span>
        <span class="admin-item-sub">${esc(u.email)} · ${u.last_login_location ? esc(u.last_login_location) : '未知位置'} · IP: ${u.last_login_ip||'未知'} · 最后登录: ${formatTime(u.last_seen) || '未知'} · 注册: ${u.created_at}</span>
      </div>
      <div class="admin-item-actions">
        <button class="btn btn-secondary btn-sm" onclick="viewUserDetail(${u.id})">详情</button>
        ${muteBtn}
        ${roleBtn}
      </div>
    </div>
  `}).join('');
}

async function unmuteUser(userId) {
  if (!confirm('确定要解除该用户的禁言吗？')) return;
  try {
    const res = await fetch(`${API}/api/admin/users/${userId}/unmute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${state.token}` },
      body: JSON.stringify({ roomId: null })
    });
    if (!res.ok) { const d = await res.json(); showToast(d.error, 'error'); return; }
    showToast('已解除禁言', 'success');
    await loadUsers();
  } catch (e) { showToast('操作失败', 'error'); }
}

async function toggleUserRole(userId, newRole) {
  try {
    const res = await fetch(`${API}/api/admin/users/${userId}/role`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${state.token}` },
      body: JSON.stringify({ role: newRole })
    });
    if (!res.ok) { const d = await res.json(); showToast(d.error, 'error'); return; }
    showToast(newRole === 'admin' ? '已设为管理员' : '已取消管理员', 'info');
    await loadUsers();
  } catch (e) { showToast('操作失败', 'error'); }
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

async function loadAnnouncements() {
  try {
    const res = await fetch(`${API}/api/admin/announcements`, { headers: { 'Authorization': `Bearer ${state.token}` } });
    const data = await res.json();
    renderAnnouncements(data.announcements || []);
  } catch (e) { console.error(e); }
}

function renderAnnouncements(announcements) {
  const container = document.getElementById('announcementList');
  if (!announcements.length) { container.innerHTML = '<div style="text-align:center;padding:20px;color:var(--gray-400);">暂无公告</div>'; return; }
  container.innerHTML = announcements.map(a => `
    <div class="admin-item">
      <div class="admin-item-info" style="min-width:0;">
        <span class="admin-item-title">${esc(a.title)} ${a.is_active?'<span class="admin-badge">已发布</span>':'<span class="badge-danger">已下架</span>'}</span>
        <span class="admin-item-sub">${esc(a.created_by_name||'管理员')} · ${a.created_at}</span>
      </div>
      <div class="admin-item-actions">
        <button class="btn btn-secondary btn-sm" onclick="editAnnouncement(${a.id})">编辑</button>
        <button class="btn btn-${a.is_active?'danger':'primary'} btn-sm" onclick="toggleAnnouncement(${a.id},${a.is_active?0:1})">${a.is_active?'下架':'发布'}</button>
        <button class="btn btn-danger btn-sm" onclick="deleteAnnouncement(${a.id})">删除</button>
      </div>
    </div>
  `).join('');
}

async function addAnnouncement() {
  const title = document.getElementById('announcementTitle').value.trim();
  const content = document.getElementById('announcementContent').value.trim();
  if (!title || !content) { showToast('标题和内容不能为空', 'error'); return; }
  try {
    const res = await fetch(`${API}/api/admin/announcements`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${state.token}` },
      body: JSON.stringify({ title, content })
    });
    if (!res.ok) { const d = await res.json(); showToast(d.error, 'error'); return; }
    document.getElementById('announcementTitle').value = '';
    document.getElementById('announcementContent').value = '';
    await loadAnnouncements();
  } catch (e) { showToast('发布失败', 'error'); }
}

async function toggleAnnouncement(id, active) {
  try {
    await fetch(`${API}/api/admin/announcements/${id}/toggle`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${state.token}` },
      body: JSON.stringify({ active: !!active })
    });
    await loadAnnouncements();
  } catch (e) { showToast('操作失败', 'error'); }
}

async function deleteAnnouncement(id) {
  if (!confirm('确定删除这条公告吗？')) return;
  try {
    await fetch(`${API}/api/admin/announcements/${id}`, { method: 'DELETE', headers: { 'Authorization': `Bearer ${state.token}` } });
    await loadAnnouncements();
  } catch (e) { showToast('删除失败', 'error'); }
}

async function editAnnouncement(id) {
  try {
    const res = await fetch(`${API}/api/admin/announcements`, { headers: { 'Authorization': `Bearer ${state.token}` } });
    const data = await res.json();
    const ann = (data.announcements || []).find(a => a.id === id);
    if (!ann) return;
    document.getElementById('editAnnouncementId').value = ann.id;
    document.getElementById('editAnnouncementTitle').value = ann.title;
    document.getElementById('editAnnouncementContent').value = ann.content;
    document.getElementById('editAnnouncementModal').classList.add('show');
  } catch (e) { console.error(e); }
}

async function saveAnnouncement() {
  const id = document.getElementById('editAnnouncementId').value;
  const title = document.getElementById('editAnnouncementTitle').value.trim();
  const content = document.getElementById('editAnnouncementContent').value.trim();
  if (!title || !content) { showToast('标题和内容不能为空', 'error'); return; }
  try {
    const res = await fetch(`${API}/api/admin/announcements/${id}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${state.token}` },
      body: JSON.stringify({ title, content })
    });
    if (!res.ok) { const d = await res.json(); showToast(d.error, 'error'); return; }
    closeEditAnnouncementModal();
    await loadAnnouncements();
  } catch (e) { showToast('保存失败', 'error'); }
}

function closeEditAnnouncementModal() { document.getElementById('editAnnouncementModal').classList.remove('show'); }
function closeAnnouncementModal() { document.getElementById('announcementModal').classList.remove('show'); }

// ---- Admin: Private Messages ----
let adminPrivateUsers = [];

async function loadAdminPrivateUsers() {
  try {
    const res = await fetch(`${API}/api/admin/users`, { headers: { 'Authorization': `Bearer ${state.token}` } });
    const data = await res.json();
    adminPrivateUsers = data.users || [];
    const select = document.getElementById('adminPrivateUserSelect');
    select.innerHTML = '<option value="">请选择用户...</option>' + adminPrivateUsers.map(u => `<option value="${u.id}">${esc(u.display_name||u.username)} (${esc(u.email)})</option>`).join('');
  } catch(e) { console.error(e); }
}

async function loadAdminPrivateMessages() {
  const select = document.getElementById('adminPrivateUserSelect');
  const userId = select.value;
  if (!userId) { showToast('请选择用户', 'error'); return; }
  const container = document.getElementById('privateMsgList');
  container.innerHTML = '<div class="loading-spinner"></div>';
  try {
    const res = await fetch(`${API}/api/admin/private-messages/${userId}`, {
      headers: { 'Authorization': `Bearer ${state.token}` }
    });
    if (!res.ok) throw new Error('加载失败');
    const data = await res.json();
    const messages = data.messages || [];
    const partners = data.partners || [];
    
    let html = `<div class="detail-section"><h4>聊天对象 (${partners.length})</h4>`;
    partners.forEach(p => {
      html += `<div class="admin-item"><div class="user-avatar-sm" style="background:${p.avatar_color||'#4f46e5'}">${(p.display_name||p.username).charAt(0).toUpperCase()}</div><div class="admin-item-info"><span class="admin-item-title">${esc(p.display_name||p.username)}</span></div></div>`;
    });
    html += `</div>`;
    
    if (!messages.length) {
      html += '<div style="text-align:center;padding:20px;color:var(--gray-400);font-size:13px;">暂无私聊记录</div>';
    } else {
      html += `<div class="detail-section"><h4>私聊记录 (${messages.length})</h4>`;
      messages.forEach(m => {
        const isSent = Number(m.sender_id) === Number(userId);
        const partnerName = isSent ? (m.receiver_display_name || m.receiver_username) : (m.sender_display_name || m.sender_username);
        const direction = isSent ? '→' : '←';
        const content = m.is_recalled ? '[已撤回]' : (m.type === 'image' ? '[图片]' : esc(m.content));
        html += `<div class="user-msg-item"><span class="msg-room">${direction} ${esc(partnerName)}</span><span class="msg-content ${m.is_recalled ? 'recall-label' : ''}">${content}</span><span class="msg-time">${formatTime(m.created_at)}</span></div>`;
      });
      html += `</div>`;
    }
    
    container.innerHTML = html;
  } catch(e) {
    container.innerHTML = '<p style="color:var(--danger);text-align:center;">加载失败</p>';
  }
}

async function showActiveAnnouncements() {
  try {
    const res = await fetch(`${API}/api/announcements`, { headers: { 'Authorization': `Bearer ${state.token}` } });
    const data = await res.json();
    const announcements = data.announcements || [];
    if (announcements.length > 0) {
      const latest = announcements[0];
      document.getElementById('announcementPopupTitle').textContent = `📢 ${esc(latest.title)}`;
      document.getElementById('announcementPopupContent').textContent = latest.content;
      document.getElementById('announcementModal').classList.add('show');
    }
  } catch (e) { console.error(e); }
}

// Modal close handler
function closeModal(e) { if (e.target.classList.contains('modal-overlay')) e.target.classList.remove('show'); }

// Escape key
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    closeCreateRoom(); closeMembers(); closeAdminPanel(); closeUserDetail(); closeMuteModal(); closeMuteDurationModal(); closeRoomPasswordModal(); closeAnnouncementModal(); closeEditAnnouncementModal();
  }
});

// Scroll to top to trigger load more
document.getElementById('messagesList')?.addEventListener('scroll', function() {
  if (this.scrollTop < 50 && state.currentRoom && state.hasMoreMessages.get(state.currentRoom.id)) {
    if (document.getElementById('loadMore').style.display !== 'none') loadMoreMessages();
  }
});

// ========== Avatar Click (Add Friend / Mute with Duration Picker) ==========
document.getElementById('messagesList')?.addEventListener('click', function(e) {
  const avatar = e.target.closest('.message-avatar.clickable');
  if (!avatar) return;
  const msgDiv = avatar.closest('.message');
  if (!msgDiv) return;
  const userId = Number(msgDiv.dataset.userId);
  const username = msgDiv.querySelector('.message-username')?.textContent || 'Unknown';
  if (!userId || userId === state.user.id) return;
  handleAvatarClick(userId, username);
});

function handleAvatarClick(userId, username) {
  // Admin: show mute duration picker
  if (state.isAdmin) {
    // Cannot mute self (already checked above, but double-check)
    if (userId === state.user.id) return;
    // Cannot mute other admins/ultimate admins
    // Check by looking at the user's role from friends list or state
    showMuteDurationModal(userId, username);
    return;
  }
  // Check if already friends
  const isFriend = state.friends.some(f => Number(f.id) === userId);
  if (isFriend) {
    showToast(`${username} 已是你的好友`, 'info');
    return;
  }
  // Send friend request
  sendFriendRequestFromAvatar(userId, username);
}

// ========== Mute Duration Modal ==========
let muteDurationTargetId = null;
let muteDurationTargetName = '';

function showMuteDurationModal(userId, username) {
  muteDurationTargetId = userId;
  muteDurationTargetName = username;
  document.getElementById('muteDurationLabel').textContent = `选择禁言时长 - ${username}`;
  document.getElementById('muteDurationError').textContent = '';
  document.getElementById('muteDurationCustom').value = '';
  // Deselect all duration buttons
  document.querySelectorAll('.mute-duration-btn').forEach(b => b.classList.remove('selected'));
  document.getElementById('muteDurationModal').classList.add('show');
}

function closeMuteDurationModal() {
  document.getElementById('muteDurationModal').classList.remove('show');
}

function selectMuteDuration(minutes) {
  document.querySelectorAll('.mute-duration-btn').forEach(b => {
    b.classList.toggle('selected', parseInt(b.dataset.minutes) === minutes);
  });
  document.getElementById('muteDurationCustom').value = '';
}

async function confirmMuteDuration() {
  const userId = muteDurationTargetId;
  const username = muteDurationTargetName;
  if (!userId) return;

  // Check if target is self
  if (userId === state.user.id) {
    document.getElementById('muteDurationError').textContent = '不能禁言自己';
    return;
  }

  // Get duration: check if a preset button is selected, otherwise use custom input
  let durationMinutes = null;
  const selected = document.querySelector('.mute-duration-btn.selected');
  if (selected) {
    durationMinutes = parseInt(selected.dataset.minutes);
  } else {
    const custom = parseInt(document.getElementById('muteDurationCustom').value);
    if (custom && custom > 0) {
      durationMinutes = custom;
    } else {
      document.getElementById('muteDurationError').textContent = '请选择禁言时长或输入分钟数';
      return;
    }
  }

  const roomId = state.currentRoom?.id || null;
  try {
    const res = await fetch(`${API}/api/admin/users/${userId}/mute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${state.token}` },
      body: JSON.stringify({ roomId, durationMinutes })
    });
    if (!res.ok) { const d = await res.json(); document.getElementById('muteDurationError').textContent = d.error; return; }
    showToast(`已禁言 ${username} ${durationMinutes} 分钟`, 'error');
    closeMuteDurationModal();
  } catch (e) { showToast('禁言失败', 'error'); }
}

async function muteUserFromAvatar(userId, username) {
  // Legacy function - no longer used directly from avatar click
  try {
    const roomId = state.currentRoom?.id || null;
    const res = await fetch(`${API}/api/admin/users/${userId}/mute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${state.token}` },
      body: JSON.stringify({ roomId, durationMinutes: 60 })
    });
    if (!res.ok) { const d = await res.json(); showToast(d.error, 'error'); return; }
    showToast(`已禁言 ${username} 1小时`, 'error');
  } catch (e) { showToast('操作失败', 'error'); }
}

async function sendFriendRequestFromAvatar(userId, username) {
  try {
    const res = await fetch(`${API}/api/friends/request`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${state.token}` },
      body: JSON.stringify({ friendId: userId })
    });
    if (!res.ok) { const d = await res.json(); showToast(d.error || '操作失败', 'error'); return; }
    showToast(`好友申请已发送给 ${username}`, 'success');
  } catch (e) { showToast('操作失败', 'error'); }
}

// ========== Duration Formatting ==========
function formatDuration(minutes) {
  const m = parseInt(minutes);
  if (m < 60) return `${m}分钟`;
  if (m === 60) return `1小时`;
  if (m < 1440) return `${Math.floor(m/60)}小时`;
  if (m === 1440) return `1天`;
  if (m < 43200) return `${Math.floor(m/1440)}天`;
  return `${Math.floor(m/43200)}个月`;
}

// ========== Mute Notice ==========
function appendMuteNotice(userId, durationMinutes) {
  if (!state.currentRoom) return;
  const container = document.getElementById('messagesList');
  // Find the last message from this user
  const userMessages = container.querySelectorAll(`[data-user-id="${userId}"]`);
  if (!userMessages.length) return;
  const lastMsg = userMessages[userMessages.length - 1];
  // Remove any existing mute notice for this user
  const existing = container.querySelector(`.muted-notice[data-muted-user="${userId}"]`);
  if (existing) existing.remove();
  const notice = document.createElement('div');
  notice.className = 'muted-notice';
  notice.dataset.mutedUser = userId;
  notice.textContent = `该用户因违反规定已被禁言 ${formatDuration(durationMinutes)}`;
  lastMsg.parentNode.insertBefore(notice, lastMsg.nextSibling);
}

// ========== Background Notifications ==========
function requestNotificationPermission() {
  if (!('Notification' in window)) return;
  if (Notification.permission === 'default') {
    Notification.requestPermission().then(perm => {
      state.notificationGranted = perm === 'granted';
    });
  } else {
    state.notificationGranted = Notification.permission === 'granted';
  }
}

function showNativeNotification(title, body) {
  if (!state.notificationGranted) return;
  if (state.dnd) return;
  try {
    const notif = new Notification(title, { body, icon: '/favicon.ico' });
    setTimeout(() => notif.close(), 5000);
  } catch (e) { /* notification failed silently */ }
}

function showMissedMessagesBanner(count) {
  if (count <= 0) return;
  const existing = document.querySelector('.missed-banner');
  if (existing) existing.remove();
  const banner = document.createElement('div');
  banner.className = 'missed-banner';
  banner.textContent = `你有 ${count} 条新消息`;
  banner.addEventListener('click', () => {
    banner.remove();
    scrollToBottom();
  });
  const container = document.getElementById('messagesContainer');
  if (container) container.prepend(banner);
  // Auto-dismiss after 5 seconds
  setTimeout(() => {
    if (banner.parentNode) {
      banner.style.opacity = '0';
      setTimeout(() => banner.remove(), 300);
    }
  }, 5000);
}

async function loadFriends() {
  try {
    const res = await fetch(`${API}/api/friends`, { headers: { 'Authorization': `Bearer ${state.token}` } });
    const data = await res.json();
    renderFriends(data.friends || []);
    const reqRes = await fetch(`${API}/api/friends/requests`, { headers: { 'Authorization': `Bearer ${state.token}` } });
    const reqData = await reqRes.json();
    renderFriendRequests(reqData.requests || []);
  } catch(e) { console.error(e); }
}

function renderFriends(friends) {
  state.friends = friends;
  const container = document.getElementById('friendsList');
  if (!friends.length) {
    container.innerHTML = '<div style="text-align:center;padding:16px;color:var(--gray-400);font-size:12px;">暂无好友，点击上方 + 添加</div>';
    return;
  }
  container.innerHTML = friends.map(f => {
    const isDefaultFriend = f.is_ultimate_admin === 1;
    const isActive = state.currentFriend && Number(state.currentFriend.id) === Number(f.id);
    const lastMsgHtml = f.last_message ? `<span class="friend-last-msg">${esc(f.last_message_user)}: ${esc(f.last_message || '')}</span>` : '';
    return `<div class="friend-item${isActive?' active':''}" onclick="openPrivateChat(${f.id})" data-friend-id="${f.id}">
      <div class="friend-avatar" style="background:${f.avatar_color||'#4f46e5'}">${(f.display_name||f.username).charAt(0).toUpperCase()}</div>
      <div class="friend-info">
        <span class="friend-name">${esc(f.display_name||f.username)}${f.role==='admin'?' <span class="admin-badge" style="font-size:10px">管理</span>':''}</span>
        <span class="friend-status${f.online?' online':''}">${f.online?'在线':'离线'}</span>
        ${lastMsgHtml}
      </div>
      <button class="btn-icon friend-remove-btn" onclick="event.stopPropagation();removeFriend(${f.id})" title="删除好友" style="${isDefaultFriend?'display:none':''}">
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
      </button>
    </div>`;
  }).join('');
}

function renderFriendRequests(requests) {
  const container = document.getElementById('friendRequests');
  if (!requests.length) { container.style.display = 'none'; return; }
  container.style.display = 'block';
  container.innerHTML = `<div class="friends-header" style="color:var(--warning);">好友请求 (${requests.length})</div>
    ${requests.map(r => `
      <div class="friend-request-item">
        <div class="friend-avatar" style="background:${r.avatar_color||'#4f46e5'};width:28px;height:28px;font-size:12px;">${r.username.charAt(0).toUpperCase()}</div>
        <span class="friend-name">${esc(r.username)}</span>
        <button class="btn btn-primary btn-sm" onclick="acceptFriendRequest(${r.id})">接受</button>
        <button class="btn btn-secondary btn-sm" onclick="rejectFriendRequest(${r.id})">拒绝</button>
      </div>
    `).join('')}`;
}

function showAddFriend() {
  document.getElementById('addFriendModal').classList.add('show');
  document.getElementById('friendSearchInput').value = '';
  document.getElementById('friendSearchResults').innerHTML = '';
  document.getElementById('friendError').textContent = '';
  document.getElementById('friendSearchInput').focus();
  loadFriends(); // refresh friend list / requests when opening modal
}

function closeAddFriendModal() {
  document.getElementById('addFriendModal').classList.remove('show');
}

async function searchUsersForFriend(q) {
  const results = document.getElementById('friendSearchResults');
  if (q.length < 1) { results.innerHTML = ''; return; }
  try {
    const res = await fetch(`${API}/api/users/search?q=${encodeURIComponent(q)}`, { headers: { 'Authorization': `Bearer ${state.token}` } });
    const data = await res.json();
    const users = (data.users || []).filter(u => u.id !== state.user.id);
    if (!users.length) { results.innerHTML = '<div style="color:var(--gray-400);font-size:13px;padding:8px;">未找到用户</div>'; return; }
    results.innerHTML = users.map(u => `
      <div class="friend-search-item">
        <div class="friend-avatar" style="background:${u.avatar_color||'#4f46e5'}">${(u.display_name||u.username).charAt(0).toUpperCase()}</div>
        <span class="friend-name">${esc(u.display_name||u.username)}</span>
        <button class="btn btn-primary btn-sm" onclick="sendFriendRequest(${u.id})">添加</button>
      </div>
    `).join('');
  } catch(e) { results.innerHTML = ''; }
}

async function sendFriendRequest(friendId) {
  try {
    const res = await fetch(`${API}/api/friends/request`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${state.token}` },
      body: JSON.stringify({ friendId })
    });
    if (!res.ok) { const d = await res.json(); document.getElementById('friendError').textContent = d.error; return; }
    showToast('好友申请已发送', 'success');
    document.getElementById('friendSearchResults').innerHTML = '';
  } catch(e) { showToast('操作失败', 'error'); }
}

async function acceptFriendRequest(requestId) {
  try {
    await fetch(`${API}/api/friends/accept`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${state.token}` },
      body: JSON.stringify({ requestId })
    });
    loadFriends();
    showToast('已接受好友申请', 'success');
  } catch(e) { showToast('操作失败', 'error'); }
}

async function rejectFriendRequest(requestId) {
  try {
    await fetch(`${API}/api/friends/reject`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${state.token}` },
      body: JSON.stringify({ requestId })
    });
    loadFriends();
  } catch(e) { showToast('操作失败', 'error'); }
}

// ========== Private Chat ==========

function openPrivateChat(friendId) {
  // Close private chat state for room
  if (state.currentRoom) state.typingUsers.clear();
  const friend = state.friends.find(f => Number(f.id) === Number(friendId));
  if (!friend) {
    loadFriends();
    return;
  }
  state.currentFriend = friend;
  state.currentRoom = null;
  
  // Update UI
  document.getElementById('currentRoomTitle').textContent = `💬 ${esc(friend.display_name||friend.username)}`;
  document.getElementById('currentRoomMeta').textContent = friend.online ? '在线' : '离线';
  document.getElementById('membersBtn').style.display = 'none';
  document.getElementById('deleteRoomBtn').style.display = 'none';
  
  // Show only the appropriate back button based on screen size
  const isMobile = window.innerWidth <= 768;
  document.getElementById('backToRoomBtn').style.display = isMobile ? 'none' : 'flex';
  document.getElementById('mobileBackBtn').style.display = isMobile ? 'flex' : 'none';
  document.getElementById('hamburgerBtn').style.display = 'none';
  
  document.getElementById('emptyState').style.display = 'none';
  document.getElementById('messagesContainer').style.display = 'flex';
  document.getElementById('inputArea').style.display = 'flex';
  document.getElementById('messagesList').innerHTML = '';
  
  renderRooms();
  renderFriends(state.friends);
  closeSidebar();
  loadPrivateMessages(friendId);
}

function backToRoom() {
  if (state.currentRoom) {
    // Switch back to current room
    state.currentFriend = null;
    const room = state.currentRoom;
    state.currentRoom = null;
    switchRoom(room.id);
    return;
  }
  state.currentFriend = null;
  showEmptyState();
  document.getElementById('backToRoomBtn').style.display = 'none';
  renderFriends(state.friends);
}

// Mobile back button handler: returns to sidebar/friends list from private chat
function mobileBack() {
  if (state.currentFriend) {
    backToRoom();
  }
  // On mobile, open the sidebar so the user can select a room or friend
  if (window.innerWidth <= 768) {
    setTimeout(() => {
      toggleSidebar();
    }, 100);
  }
}

async function loadPrivateMessages(friendId) {
  try {
    const res = await fetch(`${API}/api/private-messages/${friendId}?limit=50`, {
      headers: { 'Authorization': `Bearer ${state.token}` }
    });
    if (!res.ok) throw new Error('加载私聊消息失败');
    const data = await res.json();
    state.privateMessages = data.messages || [];
    renderPrivateMessages(state.privateMessages);
    scrollToBottom();
  } catch(e) { showToast('加载私聊消息失败', 'error'); }
}

function renderPrivateMessages(msgs) {
  const container = document.getElementById('messagesList');
  container.innerHTML = '';
  msgs.forEach(m => appendPrivateMessageToContainer(container, m));
}

function appendPrivateMessage(msg) {
  appendPrivateMessageToContainer(document.getElementById('messagesList'), msg);
}

function appendPrivateMessageToContainer(container, msg) {
  const own = Number(msg.sender_id) === Number(state.user.id);
  const username = own ? (state.user.display_name || state.user.username) : (msg.sender_display_name || msg.sender_username || msg.display_name || msg.username || 'Unknown');
  const avatarColor = own ? (state.user.avatar_color || '#4f46e5') : (msg.sender_avatar_color || msg.avatar_color || '#4f46e5');
  const time = formatTime(msg.created_at);
  const div = document.createElement('div');
  div.className = `message${own?' own':''}${msg.is_recalled?' recalled':''}`;
  div.dataset.messageId = msg.id;
  
  const canRecall = own || state.isAdmin;
  const recallBtn = canRecall ? `<button class="msg-recall-btn" onclick="recallPrivateMessage(${msg.id})" title="撤回">↩️</button>` : '';
  
  let contentHtml = '';
  if (msg.is_recalled) {
    contentHtml = `<div class="message-bubble recalled-bubble">消息已撤回</div>`;
  } else if (msg.type === 'image' && msg.file_url) {
    contentHtml = `<div class="message-image"><a href="${esc(msg.file_url)}" target="_blank"><img src="${esc(msg.file_url)}" alt="图片" loading="lazy"></a></div>${msg.content ? `<div class="message-bubble">${esc(msg.content)}</div>` : ''}`;
  } else {
    contentHtml = `<div class="message-bubble">${esc(msg.content)}</div>`;
  }
  
  div.innerHTML = `<div class="message-avatar" style="background:${avatarColor}">${username.charAt(0).toUpperCase()}</div>
    <div class="message-body"><div class="message-header"><span class="message-username">${esc(username)}</span><span class="message-time">${time}</span>${recallBtn}</div>
    ${contentHtml}</div>`;
  container.appendChild(div);
}

function updatePrivateRecalledMessage(messageId) {
  const container = document.getElementById('messagesList');
  const div = container.querySelector(`[data-message-id="${messageId}"]`);
  if (div) {
    const msg = state.privateMessages.find(m => Number(m.id) === Number(messageId));
    if (msg) {
      msg.is_recalled = 1;
      const bubble = div.querySelector('.message-bubble');
      if (bubble) {
        bubble.className = 'message-bubble recalled-bubble';
        bubble.textContent = '消息已撤回';
      }
      div.classList.add('recalled');
    }
  }
}

async function recallPrivateMessage(messageId) {
  try {
    const res = await fetch(`${API}/api/private-messages/${messageId}/recall`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${state.token}` }
    });
    if (!res.ok) { const d = await res.json(); showToast(d.error, 'error'); return; }
    updatePrivateRecalledMessage(messageId);
  } catch (e) { showToast('撤回失败', 'error'); }
}

async function removeFriend(friendId) {
  if (!confirm('确定要删除该好友吗？')) return;
  try {
    const res = await fetch(`${API}/api/friends/${friendId}`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${state.token}` }
    });
    if (!res.ok) {
      const data = await res.json();
      showToast(data.error || '删除失败', 'error');
      return;
    }
    if (state.currentFriend && Number(state.currentFriend.id) === Number(friendId)) {
      state.currentFriend = null;
      showEmptyState();
      document.getElementById('backToRoomBtn').style.display = 'none';
    }
    loadFriends();
    showToast('已删除好友', 'success');
  } catch(e) { showToast('删除失败', 'error'); }
}

// Override sendMessage to handle private chat
const originalSendMessage = sendMessage;
sendMessage = function() {
  const input = document.getElementById('messageInput');
  const content = input.value.trim();
  
  if (state.currentFriend) {
    if (!content) return;
    // Send via socket for private chat
    state.socket.emit('private:send', {
      receiverId: state.currentFriend.id,
      content,
      type: 'text'
    });
    input.value = '';
    autoResize(input);
    document.getElementById('sendBtn').disabled = true;
    setTimeout(() => { document.getElementById('sendBtn').disabled = false; }, 200);
    return;
  }
  originalSendMessage();
};

// Override handleImageUpload for private chat
const originalHandleImageUpload = handleImageUpload;
handleImageUpload = async function(event) {
  const file = event.target.files[0];
  if (!file) return;
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
    
    if (state.currentFriend) {
      state.socket.emit('private:send', {
        receiverId: state.currentFriend.id,
        type: 'image',
        fileUrl: data.url
      });
    } else if (state.currentRoom) {
      state.socket.emit('message:send', { roomId: state.currentRoom.id, type: 'image', fileUrl: data.url });
    }
    event.target.value = '';
  } catch (err) {
    showToast(err.message || '上传失败', 'error');
  }
};

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
  setupAudioResume(); // Resume AudioContext on first user interaction (iOS fix)
  initDNDButton();
  requestNotificationPermission(); // Request notification permission
  connectSocket();
  loadFriends();
  showActiveAnnouncements();

  // iOS Safari: keep input above keyboard using visualViewport
  if (window.visualViewport) {
    let initialViewportHeight = window.visualViewport.height;
    const setInputPosition = () => {
      const vv = window.visualViewport;
      const inputArea = document.getElementById('inputArea');
      const chatArea = document.getElementById('chatArea');
      const emptyState = document.getElementById('emptyState');
      if (!inputArea) return;
      
      // iOS: vv.offsetTop is negative when keyboard is open
      // The visual viewport is "scrolled up" to show the focused element
      const offset = Math.abs(Math.min(0, vv.offsetTop || 0));
      const keyboardHeight = offset > 50 ? offset : 0;
      
      inputArea.style.position = 'fixed';
      inputArea.style.bottom = keyboardHeight + 'px';
      inputArea.style.left = '0';
      inputArea.style.right = '0';
      inputArea.style.zIndex = '50';
      
      const bottomPadding = 56 + keyboardHeight;
      if (chatArea) {
        chatArea.style.position = 'absolute';
        chatArea.style.top = '52px';
        chatArea.style.bottom = bottomPadding + 'px';
        chatArea.style.left = '0';
        chatArea.style.right = '0';
      }
      if (emptyState) {
        emptyState.style.position = 'absolute';
        emptyState.style.top = '52px';
        emptyState.style.bottom = bottomPadding + 'px';
        emptyState.style.left = '0';
        emptyState.style.right = '0';
      }
    };
    window.visualViewport.addEventListener('resize', setInputPosition);
    window.visualViewport.addEventListener('scroll', setInputPosition);
    // Run once after init
    setTimeout(setInputPosition, 500);
  }

  // Handle page visibility changes (background → foreground)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      // Resume AudioContext when returning to page
      resumeAudioContext();
      // Reconnect socket if disconnected
      if (state.socket && !state.socket.connected) {
        reconnect();
      } else if (!state.socket) {
        connectSocket();
      }
      // Show missed messages notification
      if (state.missedCount > 0) {
        showMissedMessagesBanner(state.missedCount);
        playMessageSound();
        state.missedCount = 0;
        state.missedMessages = [];
      }
    }
  });

  // Handle page show events (including bfcache restore on mobile Safari)
  window.addEventListener('pageshow', (event) => {
    if (event.persisted || document.visibilityState === 'visible') {
      resumeAudioContext();
      if (!state.socket || !state.socket.connected) {
        reconnect();
      }
    }
  });
}

initPage();
