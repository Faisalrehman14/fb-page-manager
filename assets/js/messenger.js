/**
 * ═══════════════════════════════════════════════════════════
 *  FBCast Pro — ELITE FRONTEND LOGIC (v3.0)
 *  Architecture: Reactive Modular State Management
 *  Features: Optimistic UI, Real-Time Sockets, Smart Scroll
 * ═══════════════════════════════════════════════════════════
 */

(function () {
  // --- CENTRAL STATE STORE ---
  const State = {
    socket: null,
    activePageId: null,
    activePsid: null,
    activeToken: null,
    conversations: [],
    messages: [],
    isMobile: window.innerWidth < 768,
    isFirstLoad: true
  };

  const API_BASE = '/api/messenger';

  // --- CORE INITIALIZATION ---
  window.msngInit = function (pageId) {
    if (!pageId) {
      // Fallback: Try to get pageId from URL or global state if missing
      pageId = State.activePageId || window.current_page_id;
    }
    if (!pageId) return console.warn('[Messenger] msngInit called without Page ID');
    
    State.activePageId = pageId;
    console.log('[Messenger] Initializing for Page:', pageId);

    initSocket();
    loadConversations();
  };

  async function initSocket() {
    if (State.socket) return;

    // Senior Practice: Robust Socket Handshake
    if (typeof io === 'undefined') {
      console.warn('[Messenger] Socket.io not ready, retrying...');
      return setTimeout(initSocket, 200);
    }

    const socketUrl = window.location.hostname === 'localhost' ? 'http://localhost:3000' : window.location.origin;
    State.socket = io(socketUrl);

    State.socket.on('connect', () => {
      console.log('[Messenger] Real-time link established.');
      if (State.activePageId) State.socket.emit('join_page', State.activePageId);
    });

    State.socket.on('webhook_event', (payload) => {
      if (payload.type === 'new_message') handleIncomingMessage(payload.data);
    });
  }

  // --- DATA LOADING ---
  async function loadConversations() {
    renderSkeletons();
    try {
      const res = await api('conversations', { pageId: State.activePageId });
      State.conversations = res.conversations || [];
      renderConversations();
    } catch (e) {
      console.error('[Messenger] Load Error:', e);
      showError('Could not load conversations.');
    }
  }

  async function selectConversation(conv) {
    State.activePsid = conv.psid;
    State.activeToken = window.M_TOKEN || ''; // Use global token if available

    // UI Update: Instant active state
    document.querySelectorAll('.msng-conv-item').forEach(el => el.classList.remove('active'));
    document.querySelector(`[data-psid="${conv.psid}"]`)?.classList.add('active');

    // Reset view
    const win = document.getElementById('msngChatWindow');
    const empty = document.getElementById('msngChatEmpty');
    if (win) win.style.display = 'flex';
    if (empty) empty.style.display = 'none';

    // Header info
    document.getElementById('msngChatHdrName').innerText = conv.name || 'User';
    document.getElementById('msngChatHdrAvatar').innerHTML = `<img src="${conv.picture || 'assets/images/default-avatar.png'}" alt="">`;

    await loadMessages();
    if (State.socket) State.socket.emit('join_conv', conv.psid);
  }

  async function loadMessages() {
    const container = document.getElementById('msngMsgList');
    if (container) container.innerHTML = '<div class="msng-loading">Syncing messages...</div>';

    try {
      const res = await api('messages', { psid: State.activePsid, pageId: State.activePageId });
      State.messages = res.messages || [];
      renderMessages();
      scrollToBottom();
    } catch (e) {
      console.error('[Messenger] Msg Load Error:', e);
    }
  }

  // --- RENDERING ENGINE ---
  function renderConversations() {
    const list = document.getElementById('msngConvList');
    if (!list) return;

    if (State.conversations.length === 0) {
      list.innerHTML = '<div class="msng-empty-state">No active chats found.</div>';
      return;
    }

    list.innerHTML = State.conversations.map(c => `
      <div class="msng-conv-item ${State.activePsid === c.psid ? 'active' : ''}" 
           data-psid="${c.psid}" onclick="msngSelectConv('${c.psid}')">
        <div class="msng-ci-avatar">
          <img src="${c.user_picture || 'assets/images/default-avatar.png'}" alt="">
          ${parseInt(c.unread_count) > 0 ? '<div class="msng-ci-badge"></div>' : ''}
        </div>
        <div class="msng-ci-info" style="flex:1; min-width:0">
          <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:4px">
            <span style="font-weight:700; color:#fff; font-size:15px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis">${c.user_name || 'Customer'}</span>
            <span style="font-size:12px; color:var(--msng-text-muted)">${formatTime(c.last_message_at)}</span>
          </div>
          <div style="font-size:13px; color:var(--msng-text-muted); white-space:nowrap; overflow:hidden; text-overflow:ellipsis">
            ${c.last_message || 'No messages yet'}
          </div>
        </div>
      </div>
    `).join('');
  }

  function renderMessages() {
    const list = document.getElementById('msngMsgList');
    if (!list) return;

    list.innerHTML = State.messages.map(m => `
      <div class="msng-msg ${m.from_me ? 'from-me' : ''}">
        <div class="msng-bubble">${escapeHtml(m.message)}</div>
        <div style="font-size:11px; color:var(--msng-text-muted); margin-top:4px; padding:0 4px">
          ${formatTime(m.created_at)}
        </div>
      </div>
    `).join('');
  }

  // --- ACTIONS ---
  window.msngSendMessage = async function() {
    const input = document.getElementById('msngMsgTextarea');
    const text = input.value.trim();
    if (!text || !State.activePsid) return;

    // Optimistic UI: Add to screen instantly
    const tempMsg = { message: text, from_me: 1, created_at: new Date().toISOString() };
    State.messages.push(tempMsg);
    renderMessages();
    scrollToBottom();
    input.value = '';

    try {
      await apiPost('reply', {
        pageId: State.activePageId,
        psid: State.activePsid,
        message: text,
        page_token: State.activeToken
      });
    } catch (e) {
      console.error('[Messenger] Send Failed:', e);
      alert('Message could not be sent. Please retry.');
    }
  };

  function handleIncomingMessage(msg) {
    // 1. If it belongs to active chat, add it
    if (msg.user_id === State.activePsid) {
      State.messages.push(msg);
      renderMessages();
      scrollToBottom();
    }

    // 2. Refresh conversation list to show update/unread
    loadConversations();
  }

  // --- HELPERS ---
  async function api(endpoint, params = {}) {
    const qs = new URLSearchParams(params).toString();
    const res = await fetch(`${API_BASE}/${endpoint}?${qs}`);
    return res.json();
  }

  async function apiPost(endpoint, body) {
    const res = await fetch(`${API_BASE}/${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    return res.json();
  }

  function scrollToBottom() {
    const container = document.getElementById('msngMsgList');
    if (container) container.scrollTop = container.scrollHeight;
  }

  function formatTime(str) {
    if (!str) return '';
    const date = new Date(str);
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  function renderSkeletons() {
    const list = document.getElementById('msngConvList');
    if (list) list.innerHTML = Array(5).fill('<div class="msng-conv-skeleton"></div>').join('');
  }

  // Exposed for HTML onclicks
  window.msngSelectConv = function(psid) {
    const conv = State.conversations.find(c => c.psid === psid);
    if (conv) selectConversation(conv);
  };

  window.msngSyncNow = function() {
    console.log('[Messenger] Manual sync triggered...');
    loadConversations();
  };

  window.msngScrollToBottom = function() {
    scrollToBottom();
  };

})();
