(function () {
  const AUTH_URL = (window.ENV && window.ENV.AUTH_URL) || '/auth';
  const CHAT_URL = (window.ENV && window.ENV.CHAT_URL) || '/chat';
  const SOCKET_PATH = (window.ENV && window.ENV.SOCKET_PATH) || '/chat/socket.io';

  const $ = (sel) => document.querySelector(sel);
  const tokenKey = 'auth_token';
  let socket = null;
  let me = null;

  // Current chat state
  let currentType = null; // 'dm' | 'group'
  let currentPeer = null; // for DM
  let currentGroup = null; // { id, name }
  let currentConvId = null;

  // Conversations and Groups
  const convs = new Map(); // convId -> { convId, type, with, lastFrom, lastMessageText, lastMessageAt, unread }
  const myGroups = new Map(); // groupId -> { id, name, membersCount?, members? }

  // Elements
  const elAuth = $('#auth-section');
  const elChat = $('#chat-section');
  const elMe = $('#me-name');
  const elMsgs = $('#messages');
  const elSend = $('#btn-send');
  const elInput = $('#msg-input');
  const elPeer = $('#peer-input');
  const elOpen = $('#btn-open');
  const elChatTitle = $('#chat-title');
  const elStatus = $('#chat-status');
  const elConvList = $('#conv-list');
  const elRefresh = $('#btn-refresh');

  const elGroupStatus = $('#group-status');
  const elGroupName = $('#group-name');
  const elCreateGroup = $('#btn-create-group');
  const elGroupList = $('#group-list');

  const elMemberControls = $('#member-controls');
  const elMemberUser = $('#member-username');
  const elAddMember = $('#btn-add-member');
  const elMemberStatus = $('#member-status');

  // Wire events
  $('#btn-register').addEventListener('click', register);
  $('#btn-login').addEventListener('click', login);
  $('#btn-logout').addEventListener('click', logout);
  elSend.addEventListener('click', sendMessage);
  elInput.addEventListener('keypress', (e) => { if (e.key === 'Enter') sendMessage(); });
  elOpen.addEventListener('click', openChatFromInput);
  elPeer.addEventListener('keypress', (e) => { if (e.key === 'Enter') openChatFromInput(); });
  elRefresh.addEventListener('click', () => { refreshConversations(); refreshGroups(); });

  elCreateGroup.addEventListener('click', createGroup);
  elAddMember.addEventListener('click', addMemberToCurrent);

  // Init
  init();

  async function init() {
    const token = localStorage.getItem(tokenKey);
    if (!token) { showAuth(); return; }
    const ok = await fetchMe(token);
    if (!ok) { showAuth(); return; }
    showChat();
    connectSocket(token);
    await refreshConversations();
    await refreshGroups();
    tryRequestNotificationPermission();
    updateMemberControls();
  }

  // Auth
  async function register() {
    const username = $('#reg-username').value.trim();
    const password = $('#reg-password').value;
    $('#reg-msg').textContent = '';
    if (!username || !password) return ($('#reg-msg').textContent = 'Please enter username and password');
    try {
      const res = await fetch(`${AUTH_URL}/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }) });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Register failed');
      $('#reg-msg').textContent = 'Registered! You can login now.';
    } catch (e) { $('#reg-msg').textContent = e.message; }
  }
  async function login() {
    const username = $('#login-username').value.trim();
    const password = $('#login-password').value;
    $('#login-msg').textContent = '';
    if (!username || !password) return ($('#login-msg').textContent = 'Please enter username and password');
    try {
      const res = await fetch(`${AUTH_URL}/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }) });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Login failed');
      localStorage.setItem(tokenKey, data.token);
      const ok = await fetchMe(data.token);
      if (!ok) throw new Error('Failed to fetch user');
      showChat();
      connectSocket(data.token);
      await refreshConversations();
      await refreshGroups();
      tryRequestNotificationPermission();
    } catch (e) { $('#login-msg').textContent = e.message; }
  }
  function logout() {
    localStorage.removeItem(tokenKey);
    try { socket && socket.disconnect(); } catch {}
    socket = null;
    me = null;
    resetCurrentChat();
    convs.clear();
    myGroups.clear();
    elMsgs.innerHTML = '';
    elConvList.innerHTML = '';
    elGroupList.innerHTML = '';
    elChatTitle.textContent = 'None';
    showAuth();
  }
  async function fetchMe(token) {
    try {
      const res = await fetch(`${AUTH_URL}/me`, { headers: { 'Authorization': `Bearer ${token}` } });
      if (!res.ok) return false;
      me = await res.json();
      return true;
    } catch { return false; }
  }

  // Socket
  function connectSocket(token) {
    try {
      socket = io({
      path: SOCKET_PATH,
      transports: ['websocket'],
      auth: { token },
      reconnection: true
    });

    socket.on('connect', () => {
      console.log('socket connected', socket.id);
      elStatus.textContent = '';
    });

      // DM history
      socket.on('chat:history', (payload) => {
        const { conversationId, with: peer, messages } = payload || {};
        currentType = 'dm';
        currentPeer = peer || null;
        currentGroup = null;
        currentConvId = conversationId || (peer ? dmConvIdFor(me.username, peer) : null);
        elChatTitle.textContent = currentPeer || 'None';
        elMsgs.innerHTML = '';
        (messages || []).forEach(renderMessage);
        scrollMessagesToEnd();
        elStatus.textContent = '';
        bumpConvSummary({
          convId: currentConvId, type: 'dm', with: currentPeer,
          lastFrom: messages?.length ? messages[messages.length - 1].from : undefined,
          lastMessageText: messages?.length ? messages[messages.length - 1].text : undefined,
          lastMessageAt: messages?.length ? messages[messages.length - 1].at : undefined
        }, { resetUnread: true });
        updateMemberControls();
      });

      // DM message
      socket.on('chat:message', (msg) => {
        if (!msg || !msg.convId) return;
        const expected = currentType === 'dm' && currentPeer ? dmConvIdFor(me.username, currentPeer) : null;
        const isCurrent = (expected && msg.convId === expected) || msg.convId === currentConvId;
        if (isCurrent && currentType === 'dm') {
          if (!currentConvId) currentConvId = msg.convId;
          renderMessage(msg);
          scrollMessagesToEnd();
          bumpConvSummary({
            convId: msg.convId, type: 'dm', with: otherOf(msg, me.username),
            lastFrom: msg.from, lastMessageText: msg.text, lastMessageAt: msg.at
          }, { resetUnread: true });
        }
      });

      // Group history
      socket.on('group:history', (payload) => {
        const { groupId, name, conversationId, messages } = payload || {};
        currentType = 'group';
        currentGroup = { id: groupId, name };
        currentPeer = null;
        currentConvId = conversationId || groupConvIdFor(groupId);
        elChatTitle.textContent = `#${name}`;
        elMsgs.innerHTML = '';
        (messages || []).forEach(renderMessage);
        scrollMessagesToEnd();
        elStatus.textContent = '';
        bumpConvSummary({
          convId: currentConvId, type: 'group', with: name,
          lastFrom: messages?.length ? messages[messages.length - 1].from : undefined,
          lastMessageText: messages?.length ? messages[messages.length - 1].text : undefined,
          lastMessageAt: messages?.length ? messages[messages.length - 1].at : undefined
        }, { resetUnread: true });
        updateMemberControls();
      });

      // Group message
      socket.on('group:message', (msg) => {
        if (!msg || !msg.convId) return;
        const expected = currentType === 'group' && currentGroup ? groupConvIdFor(currentGroup.id) : null;
        const isCurrent = (expected && msg.convId === expected) || msg.convId === currentConvId;
        if (isCurrent && currentType === 'group') {
          if (!currentConvId) currentConvId = msg.convId;
          renderMessage(msg);
          scrollMessagesToEnd();
          bumpConvSummary({
            convId: msg.convId, type: 'group', with: msg.groupName,
            lastFrom: msg.from, lastMessageText: msg.text, lastMessageAt: msg.at
          }, { resetUnread: true });
        }
      });

      // Unified notifications for DM + Group
      socket.on('chat:notify', (summary) => {
        if (!summary) return;
        const normalized = {
          convId: summary.convId,
          type: summary.type || 'dm',
          with: summary.with,
          lastFrom: summary.lastFrom,
          lastMessageText: summary.lastMessageText,
          lastMessageAt: summary.lastMessageAt
        };
        const isCurrent = normalized.convId === currentConvId;
        bumpConvSummary(normalized, { incrementUnread: !isCurrent });
        if (!document.hasFocus() || !isCurrent) {
          showBrowserNotification(normalized);
        }
      });

      socket.on('chat:error', (e) => { elStatus.textContent = e?.error || 'Error'; });
      socket.on('disconnect', () => {});
    } catch (e) { console.error('socket error', e); }
  }

  // Open DM
  async function openChatFromInput() {
    elStatus.textContent = '';
    const peer = (elPeer.value || '').trim();
    if (!peer) return (elStatus.textContent = 'Enter a username to chat with.');
    await openDM(peer);
  }
  async function openDM(peer) {
    if (!socket) return (elStatus.textContent = 'Not connected.');
    if (me && peer.toLowerCase() === me.username.toLowerCase()) return (elStatus.textContent = 'Cannot chat with yourself.');
    const exists = await userExists(peer);
    if (!exists) return (elStatus.textContent = 'User does not exist.');
    currentType = 'dm';
    currentPeer = peer;
    currentGroup = null;
    currentConvId = dmConvIdFor(me.username, peer);
    elChatTitle.textContent = currentPeer || 'None';
    elMsgs.innerHTML = '';
    socket.emit('chat:open', { with: peer });
    updateMemberControls();
  }

  // Open Group
  async function openGroup(group) {
    if (!socket) return (elStatus.textContent = 'Not connected.');
    if (!group?.id) return;
    currentType = 'group';
    currentPeer = null;
    currentGroup = { id: group.id, name: group.name };
    currentConvId = groupConvIdFor(group.id);
    elChatTitle.textContent = `#${group.name}`;
    elMsgs.innerHTML = '';
    socket.emit('group:open', { groupId: group.id });
    updateMemberControls();
  }

  // Send
  function sendMessage() {
    const text = elInput.value.trim();
    if (!text) return;
    if (!socket) return;
    if (currentType === 'dm') {
      if (!currentPeer) return (elStatus.textContent = 'Open a DM first.');
      socket.emit('chat:send', { to: currentPeer, text });
    } else if (currentType === 'group') {
      if (!currentGroup) return (elStatus.textContent = 'Open a group first.');
      socket.emit('group:send', { groupId: currentGroup.id, text });
    } else {
      return (elStatus.textContent = 'Open a chat first.');
    }
    elInput.value = '';
  }

  // Conversations list
  async function refreshConversations() {
    const token = localStorage.getItem(tokenKey);
    if (!token) return;
    try {
      const res = await fetch(`${CHAT_URL}/conversations`, { headers: { 'Authorization': `Bearer ${token}` } });
      if (!res.ok) throw new Error('Failed to load conversations');
      const list = await res.json();
      list.forEach(item => {
        const prev = convs.get(item.convId);
        convs.set(item.convId, {
          ...item,
          unread: prev ? prev.unread : 0
        });
      });
      renderConvList();
    } catch (e) { console.error('conv load error', e); }
  }

  function bumpConvSummary(summary, opts = {}) {
    if (!summary || !summary.convId) return;
    const prev = convs.get(summary.convId) || { convId: summary.convId, type: summary.type || 'dm', with: summary.with, unread: 0 };
    const updated = {
      ...prev,
      type: summary.type || prev.type || 'dm',
      with: summary.with || prev.with,
      lastFrom: summary.lastFrom || prev.lastFrom,
      lastMessageText: summary.lastMessageText || prev.lastMessageText,
      lastMessageAt: summary.lastMessageAt || prev.lastMessageAt,
      unread: opts.resetUnread ? 0 : (opts.incrementUnread ? (prev.unread || 0) + 1 : (prev.unread || 0))
    };
    convs.set(summary.convId, updated);
    renderConvList();
  }

  function renderConvList() {
    const items = Array.from(convs.values()).sort((a, b) => new Date(b.lastMessageAt || 0) - new Date(a.lastMessageAt || 0));
    elConvList.innerHTML = '';
    items.forEach(item => {
      const div = document.createElement('div');
      div.className = 'conv-item' + (item.convId === currentConvId ? ' active' : '');
      const typeTag = item.type === 'group'
        ? `<span class="type-tag type-group">Group</span>`
        : `<span class="type-tag type-dm">DM</span>`;
      div.innerHTML = `
        <div>
          <div><strong>${escapeHtml(item.with || '')}</strong> ${typeTag}</div>
          <div class="meta">${escapeHtml(item.lastFrom || '')}: ${escapeHtml((item.lastMessageText || '').slice(0, 40))}</div>
        </div>
        <div>${item.unread ? `<span class="badge">${item.unread}</span>` : ''}</div>
      `;
      div.addEventListener('click', () => {
        if (item.type === 'group') {
          const groupId = groupIdFromConvId(item.convId);
          const g = myGroups.get(groupId);
          if (g) openGroup(g);
        } else {
          elPeer.value = item.with || '';
          openDM(item.with || '');
        }
      });
      elConvList.appendChild(div);
    });
  }

  // Groups section
  async function refreshGroups() {
    const token = localStorage.getItem(tokenKey);
    if (!token) return;
    try {
      const res = await fetch(`${CHAT_URL}/groups`, { headers: { 'Authorization': `Bearer ${token}` } });
      if (!res.ok) throw new Error('Failed to load groups');
      const list = await res.json();
      myGroups.clear();
      list.forEach(g => {
        myGroups.set(g.id, { id: g.id, name: g.name, members: g.members, membersCount: g.members?.length || 0 });
      });
      renderGroupList();
    } catch (e) {
      console.error('groups load error', e);
    }
  }

  function renderGroupList() {
    elGroupList.innerHTML = '';
    Array.from(myGroups.values()).forEach(g => {
      const div = document.createElement('div');
      div.className = 'conv-item' + ((currentType === 'group' && currentGroup?.id === g.id) ? ' active' : '');
      div.innerHTML = `
        <div>
          <div><strong>#${escapeHtml(g.name)}</strong> <span class="type-tag type-group">Group</span></div>
          <div class="meta">${g.membersCount || (g.members?.length || 0)} members</div>
        </div>
      `;
      div.addEventListener('click', () => openGroup(g));
      elGroupList.appendChild(div);
    });
  }

  async function createGroup() {
    elGroupStatus.textContent = '';
    const name = (elGroupName.value || '').trim();
    if (!name) return (elGroupStatus.textContent = 'Enter a group name.');
    const token = localStorage.getItem(tokenKey);
    try {
      const res = await fetch(`${CHAT_URL}/groups`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({ name })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to create group');
      elGroupName.value = '';
      await refreshGroups();
      // Auto-open the new group
      const g = myGroups.get(data.id) || { id: data.id, name: data.name, members: data.members };
      openGroup(g);
    } catch (e) {
      elGroupStatus.textContent = e.message;
    }
  }

  async function addMemberToCurrent() {
    elMemberStatus.textContent = '';
    if (currentType !== 'group' || !currentGroup) {
      elMemberStatus.textContent = 'Open a group first.';
      return;
    }
    const username = (elMemberUser.value || '').trim();
    if (!username) return (elMemberStatus.textContent = 'Enter a username.');
    // Client-side validate via auth-service
    const exists = await userExists(username);
    if (!exists) return (elMemberStatus.textContent = 'User does not exist.');

    const token = localStorage.getItem(tokenKey);
    try {
      const res = await fetch(`${CHAT_URL}/groups/${encodeURIComponent(currentGroup.id)}/members`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({ username })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to add member');
      elMemberUser.value = '';
      elMemberStatus.textContent = `Added ${username}`;
      await refreshGroups();
    } catch (e) {
      elMemberStatus.textContent = e.message;
    }
  }

  // Utilities
  async function userExists(username) {
    try {
      const res = await fetch(`${AUTH_URL}/users/${encodeURIComponent(username)}`);
      if (res.status === 404) return false;
      if (!res.ok) return false;
      const data = await res.json();
      return !!data.exists;
    } catch { return false; }
  }
  function otherOf(msg, meName) {
    const meLower = (meName || '').toLowerCase();
    return (msg.from || '').toLowerCase() !== meLower ? msg.from : msg.to;
  }
  function dmConvIdFor(a, b) {
    const x = (a || '').toLowerCase();
    const y = (b || '').toLowerCase();
    const [left, right] = [x, y].sort();
    return `dm:${left}__${right}`;
  }
  function groupConvIdFor(groupId) { return `grp:${groupId}`; }
  function groupIdFromConvId(convId) { return (convId || '').startsWith('grp:') ? (convId.slice(4)) : null; }

  function renderMessage(msg) {
    const div = document.createElement('div');
    div.className = 'message';
    const when = new Date(msg.at);
    const isGroup = (msg.type === 'group') || !!msg.groupId || (msg.convId || '').startsWith('grp:');
    const meta = isGroup
      ? `${escapeHtml(msg.from)} → #${escapeHtml(msg.groupName || currentGroup?.name || '')} • ${when.toLocaleString()}`
      : `${escapeHtml(msg.from)} → ${escapeHtml(msg.to)} • ${when.toLocaleString()}`;
    div.innerHTML = `
      <div class="meta">${meta}</div>
      <div class="text">${escapeHtml(msg.text)}</div>
    `;
    elMsgs.appendChild(div);
  }

  function scrollMessagesToEnd() { elMsgs.scrollTop = elMsgs.scrollHeight; }

  function resetCurrentChat() {
    currentType = null; currentPeer = null; currentGroup = null; currentConvId = null;
    elChatTitle.textContent = 'None';
  }
  function updateMemberControls() {
    // Show add-member controls only when in a group chat
    elMemberControls.style.display = (currentType === 'group' && currentGroup) ? '' : 'none';
    elMemberStatus.textContent = '';
  }

  function showAuth() { elAuth.classList.remove('hidden'); elChat.classList.add('hidden'); }
  function showChat() { elMe.textContent = me?.username || ''; elAuth.classList.add('hidden'); elChat.classList.remove('hidden'); }

  function escapeHtml(s) {
    return (s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[c]));
  }

  function tryRequestNotificationPermission() {
    if (!('Notification' in window)) return;
    if (Notification.permission === 'default') { Notification.requestPermission().catch(() => {}); }
  }
  function showBrowserNotification(summary) {
    if (!('Notification' in window)) return;
    if (Notification.permission !== 'granted') return;
    try {
      const title = summary.type === 'group'
        ? `#${summary.with}: ${summary.lastFrom}`
        : `New message from ${summary.lastFrom}`;
      const body = summary.lastMessageText || '';
      const n = new Notification(title, { body }); setTimeout(() => n.close(), 4000);
    } catch {}
  }
})();