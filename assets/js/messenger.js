/**
 * messenger.js — Pro 3-column Messenger
 * Webhook-driven real-time chat (3s polling on DB)
 */

(function () {
  'use strict';

  // ── State ───────────────────────────────────────────────────
  const M = {
    pages:         [],          // loaded Facebook pages
    activePageId:  null,        // selected page ID
    activeToken:   null,        // selected page access_token
    convs:         [],          // conversations array
    activePsid:    null,        // open conversation PSID
    activeConvName:'',
    activeConvPic: '',
    msgs:          [],          // messages for open conv
    pollTimer:     null,        // setInterval handle
    lastPollTime:  null,        // ISO string
    searchQuery:   '',
    oldestMsgTime: null,        // for load-more
    sending:       false,
    userNameCache: {},          // psid → name
    socket:        null,        // Socket.io instance
  };

  // ── Socket.io Initialization ────────────────────────────────
  async function initSocket() {
    if (M.socket) return;
    
    // Safety: Wait for Socket.io library if not yet loaded
    if (typeof io === 'undefined') {
      console.warn('[Messenger] Socket.io not ready, retrying in 200ms...');
      setTimeout(initSocket, 200);
      return;
    }
    
    const isLocal = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
    const socketUrl = isLocal 
      ? window.location.protocol + '//' + window.location.hostname + ':3000'
      : window.location.protocol + '//' + window.location.hostname;
      
    console.log('[Messenger] Connecting to Socket:', socketUrl);
    
    M.socket = io(socketUrl);

    M.socket.on('connect', () => {
      console.log('[Messenger] Socket connected:', M.socket.id);
      if (M.activePageId) M.socket.emit('join_page', M.activePageId);
      if (M.activePsid) M.socket.emit('join_conversation', M.activePsid);
    });

    M.socket.on('new_message', (msg) => {
      console.log('[Messenger] Socket new_message:', msg);
      // If this message is for the active conversation, append it
      if (M.activePsid === msg.user_id) {
        const exists = M.msgs.find(m => m.id === msg.id);
        if (!exists) {
          appendMessage(msg);
          // Mark as read in DB via background API call
          apiPost('mark-read', { pageId: M.activePageId, psid: M.activePsid }).catch(() => {});
        }
      }
      
      // Update the conversation in the sidebar regardless
      updateConvInSidebar(msg);
    });

    M.socket.on('webhook_event', (event) => {
      console.log('[Messenger] Socket webhook_event:', event);
      // Handle other event types like delivery, read, etc.
    });

    M.socket.on('disconnect', () => {
      console.log('[Messenger] Socket disconnected');
    });
  }

  function updateConvInSidebar(msg) {
    const psid = msg.user_id;
    const existing = M.convs.find(c => c.psid === psid);
    if (existing) {
      if (psid !== M.activePsid) {
        existing.unread = (existing.unread || 0) + 1;
      }
      existing.lastMsg = msg.message;
      existing.lastMsgAt = msg.created_at;
      existing.lastFromMe = msg.from_me == 1;
    } else {
      // New conversation from socket
      M.convs.unshift({
        psid:     psid,
        name:     'New User', // Will be updated on next DB load
        picture:  null,
        lastMsg:  msg.message,
        lastFromMe: msg.from_me == 1,
        lastMsgAt:  msg.created_at,
        unread:   1,
        page_id:  M.activePageId,
      });
    }
    M.convs.sort((a, b) => new Date(b.lastMsgAt) - new Date(a.lastMsgAt));
    renderConvs();
  }


  // ── Helpers ──────────────────────────────────────────────────
  function esc(str) {
    return String(str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }
  function el(id) { return document.getElementById(id); }

  function fmtTime(dateStr) {
    if (!dateStr) return '';
    const d = new Date(dateStr);
    if (isNaN(d)) return '';
    const now = new Date();
    const diffMs = now - d;
    const mins  = Math.floor(diffMs / 60000);
    const hours = Math.floor(diffMs / 3600000);
    const days  = Math.floor(diffMs / 86400000);
    if (mins < 1)  return 'now';
    if (mins < 60) return mins + 'm';
    if (hours < 24) return hours + 'h';
    if (days < 7)  return days + 'd';
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  }

  function fmtMsgTime(dateStr) {
    if (!dateStr) return '';
    const d = new Date(dateStr);
    if (isNaN(d)) return '';
    return d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true });
  }

  function fmtDate(dateStr) {
    if (!dateStr) return '';
    const d = new Date(dateStr);
    if (isNaN(d)) return '';
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const msgDay = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    const diff = Math.round((today - msgDay) / 86400000);
    if (diff === 0) return 'Today';
    if (diff === 1) return 'Yesterday';
    return d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
  }

  // Smart API Base: Use :3000 for local dev, but use standard port for Production (Railway)
  const API_BASE = (function() {
    const isLocal = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
    const protocol = window.location.protocol;
    const host = window.location.hostname;
    return isLocal ? `${protocol}//${host}:3000/api/messenger` : `${protocol}//${host}/api/messenger`;
  })();

  async function api(endpoint, params = {}) {
    const qs = Object.entries(params).map(([k,v]) => k + '=' + encodeURIComponent(v)).join('&');
    const url = `${API_BASE}/${endpoint}${qs ? '?' + qs : ''}`;
    
    try {
      const r = await fetch(url);
      const contentType = r.headers.get('content-type');
      if (!contentType || !contentType.includes('application/json')) {
        const text = await r.text();
        console.error('[Messenger] API returned non-JSON:', text.substring(0, 100));
        throw new Error('Server returned HTML instead of JSON. Check backend routing.');
      }
      return await r.json();
    } catch (e) {
      console.error('[Messenger] API Fetch Error:', e);
      throw e;
    }
  }

  async function apiPost(endpoint, payload) {
    const url = `${API_BASE}/${endpoint}`;
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    return r.json();
  }

  function showMsngToast(msg) {
    let t = el('msngToast');
    if (!t) return;
    t.textContent = msg;
    t.classList.add('show');
    setTimeout(() => t.classList.remove('show'), 3000);
  }

  // ── Init ────────────────────────────────────────────────────
  window.msngInit = function (retries) {
    retries = retries || 0;
    M.pages = (window.loadedPages || []).filter(p => p && p.id && p.access_token);

    if (!M.pages.length) {
      if (retries < 10) {
        // Pages not loaded yet — retry up to 10 times (5 seconds total)
        setTimeout(() => window.msngInit(retries + 1), 500);
        return;
      }
      renderNoPages();
      return;
    }

    // Prefer currentPageId (set by outer app when user picks a page)
    const preferredId = window.currentPageId || (M.pages[0] && M.pages[0].id);

    // Select page
    if (!M.activePageId || !M.pages.find(p => p.id === M.activePageId)) {
      msngSelectPage(preferredId);
    } else {
      renderConvs();
    }

    initSocket();
    startPolling();
  };

  // Called by web_ui.js when switching to messenger view
  window.loadMessengerConversations = function () {
    window.msngInit(0);
  };

  // ── Pages ────────────────────────────────────────────────────
  function renderPagesList() {
    const wrap = el('msngPagesList');
    if (!wrap) return;

    wrap.innerHTML = M.pages.map(p => {
      const initial = (p.name || 'P').charAt(0).toUpperCase();
      const pic = p.picture?.data?.url || '';
      const isActive = p.id === M.activePageId;
      return `
        <button class="msng-page-btn ${isActive ? 'active' : ''}"
                id="msngPageBtn_${esc(p.id)}"
                onclick="msngSelectPage('${esc(p.id)}')"
                title="${esc(p.name)}">
          ${pic
            ? `<img src="${esc(pic)}" alt="${esc(p.name)}" onerror="this.style.display='none'">`
            : `<span class="msng-page-initial">${esc(initial)}</span>`
          }
          <span class="msng-page-tooltip">${esc(p.name)}</span>
          <span class="msng-page-badge" id="msngPageBadge_${esc(p.id)}" style="display:none">0</span>
        </button>`;
    }).join('');
  }

  function renderNoPages() {
    const convEl = el('msngConvList');
    if (convEl) convEl.innerHTML = `
      <div class="msng-no-page">
        <i class="fa-brands fa-facebook-messenger"></i>
        <h4>No pages connected</h4>
        <p>Connect a Facebook page first to use the Messenger.</p>
      </div>`;
  }

  window.msngSelectPage = function (pageId) {
    M.activePageId = pageId;
    const page = M.pages.find(p => p.id === pageId);
    M.activeToken = page?.access_token || null;

    // Join socket room for this page
    if (M.socket) M.socket.emit('join_page', pageId);

    // Update page button styles
    M.pages.forEach(p => {
      const btn = el('msngPageBtn_' + p.id);
      if (btn) btn.classList.toggle('active', p.id === pageId);
    });

    // Clear chat
    M.activePsid  = null;
    showChatEmpty();

    // Load from DB first (instant), then refresh from Facebook in background
    loadConvsFromDB(pageId);
  };

  // ── Sync history on demand ───────────────────────────────────
  window.msngSyncPage = async function (pageId, token) {
    if (!pageId || !token) return;
    showSyncBanner('Syncing messages from Facebook…');
    try {
      const resp = await fetch('sync_history.php', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ page_id: pageId, page_token: token }),
      });
      const data = await resp.json();
      if (data.success) {
        showSyncBanner('Synced ' + data.conversations_synced + ' conversations, ' + data.messages_synced + ' messages', true);
        loadConvsFromDB(pageId);
      } else {
        hideSyncBanner();
      }
    } catch (e) {
      hideSyncBanner();
      console.error('[Messenger] sync error:', e);
    }
  };

  function showSyncBanner(msg, autoHide) {
    let b = el('msngSyncBanner');
    if (!b) {
      b = document.createElement('div');
      b.id = 'msngSyncBanner';
      b.className = 'msng-sync-banner';
      const convs = el('msngConvsCol');
      if (convs) convs.insertBefore(b, convs.querySelector('.msng-search'));
    }
    b.innerHTML = `<i class="fa-solid fa-rotate fa-spin"></i> ${msg}`;
    b.style.display = 'flex';
    if (autoHide) setTimeout(hideSyncBanner, 3000);
  }

  function hideSyncBanner() {
    const b = el('msngSyncBanner');
    if (b) b.style.display = 'none';
  }

  // Listen for sync events from fb_api.js (triggered after OAuth login)
  window.addEventListener('fbcast:sync-started', function (e) {
    showSyncBanner('Syncing your Facebook message history…');
  });

  window.addEventListener('fbcast:sync-done', function (e) {
    hideSyncBanner();
    // Reload conversations now that history is in DB
    if (M.activePageId) loadConvsFromDB(M.activePageId);
  });

  // ── Conversations ────────────────────────────────────────────
  async function loadConvsFromDB(pageId) {
    showConvSkeleton();
    try {
      const data = await api('conversations', { pageId: pageId });
      if (data.error) throw new Error(data.error);
      if (data.conversations) {
        M.convs = data.conversations.map(c => ({
          id:          c.id,
          psid:        c.fb_user_id,
          name:        c.user_name || 'User',
          picture:     c.user_picture || null,
          lastMsg:     c.last_msg || c.snippet || '',
          lastFromMe:  c.last_from_me == 1,
          lastMsgAt:   c.last_msg_at || c.updated_at,
          unread:      parseInt(c.is_unread) || 0,
          page_id:     c.page_id,
        }));
        renderConvs();

        // Refresh from Facebook in background
        refreshConvsFromFB(pageId);
      } else {
        showConvEmpty('No conversations yet. Messages from your Facebook page will appear here.');
      }
    } catch (e) {
      console.error('[Messenger] loadConvsFromDB error:', e);
      showConvEmpty('Connection error. Check your network and try again.');
    }
  }

  function showConvEmpty(msg) {
    const el2 = el('msngConvList');
    if (el2) el2.innerHTML = `<div class="msng-empty"><i class="fa-brands fa-facebook-messenger"></i><p>${msg}</p></div>`;
  }

  async function refreshConvsFromFB(pageId) {
    if (!M.activeToken || !window.fbGet) return;
    try {
      const data = await window.fbGet(pageId + '/conversations', M.activeToken, {
        fields: 'id,updated_time,participants,snippet',
        limit: 100,
      });
      if (!data?.data?.length) return;

      const convs = data.data.map(c => {
        const others = (c.participants?.data || []).filter(p => p.id !== pageId);
        const sender = others[0] || {};
        return {
          fb_conv_id: c.id || '',
          psid:       sender.id || '',
          name:       sender.name || 'User',
          picture:    null,
          lastMsg:    c.snippet || '',
          lastFromMe: false,
          lastMsgAt:  c.updated_time,
          unread:     0,
          page_id:    pageId,
        };
      }).filter(c => c.psid);

      // Merge into M.convs (new ones get added, existing ones updated)
      convs.forEach(fc => {
        const existing = M.convs.find(mc => mc.psid === fc.psid);
        if (!existing) {
          M.convs.push(fc);
        } else {
          existing.fb_conv_id = fc.fb_conv_id;
          if (fc.name && fc.name !== 'User') existing.name = fc.name;
          if (!existing.lastMsg && fc.lastMsg) existing.lastMsg = fc.lastMsg;
        }
      });

      // Sort by time
      M.convs.sort((a, b) => new Date(b.lastMsgAt) - new Date(a.lastMsgAt));
      renderConvs();

      // Persist to DB
      apiPost('conversations', {
        pageId: pageId,
        conversations: convs,
      }).catch(() => {});
    } catch (e) {
      console.error('[Messenger] refreshConvsFromFB error (non-fatal):', e);
    }
  }

  function renderConvs() {
    const listEl = el('msngConvList');
    if (!listEl) return;

    const q = M.searchQuery.toLowerCase();
    const filtered = q
      ? M.convs.filter(c => c.name.toLowerCase().includes(q) || (c.lastMsg || '').toLowerCase().includes(q))
      : M.convs;

    // Update page unread badge
    const totalUnread = M.convs.reduce((s, c) => s + (c.unread || 0), 0);
    updateUnreadBadge(M.activePageId, totalUnread);

    if (!filtered.length) {
      listEl.innerHTML = `<div class="msng-empty">
        <i class="fa-brands fa-facebook-messenger"></i>
        <p>${q ? 'No results for "' + esc(q) + '"' : 'No conversations yet.<br>When users message your page, they\'ll appear here.'}</p>
      </div>`;
      return;
    }

    listEl.innerHTML = filtered.map(c => {
      const initial  = (c.name || 'U').charAt(0).toUpperCase();
      const isActive = c.psid === M.activePsid;
      const isUnread = c.unread > 0;
      const time     = fmtTime(c.lastMsgAt);
      const preview  = c.lastMsg ? (c.lastMsg.length > 38 ? c.lastMsg.slice(0, 38) + '…' : c.lastMsg) : '';

      return `<div class="msng-conv-item ${isActive ? 'active' : ''} ${isUnread ? 'unread' : ''}"
                   onclick="msngOpenConv('${esc(c.psid)}','${esc(c.name)}','${esc(c.picture||'')}','${esc(c.page_id||M.activePageId)}')">
        <div class="msng-ci-avatar">
          ${c.picture
            ? `<img src="${esc(c.picture)}" alt="" onerror="this.parentNode.innerHTML='<div class=\'msng-ci-initial\'>${esc(initial)}</div>'">`
            : `<div class="msng-ci-initial">${esc(initial)}</div>`
          }
        </div>
        <div class="msng-ci-body">
          <div class="msng-ci-row1">
            <span class="msng-ci-name">${esc(c.name)}</span>
            <span class="msng-ci-time">${esc(time)}</span>
          </div>
          <div class="msng-ci-last">
            ${c.lastFromMe ? '<span class="from-me">You: </span>' : ''}
            ${esc(preview || 'No messages yet')}
          </div>
        </div>
        ${isUnread ? `<span class="msng-ci-badge">${c.unread > 9 ? '9+' : c.unread}</span>` : ''}
      </div>`;
    }).join('');
  }

  function showConvSkeleton() {
    const listEl = el('msngConvList');
    if (!listEl) return;
    const sk = n => `<div class="msng-skeleton"><div class="msng-sk-circle"></div><div class="msng-sk-lines"><div class="msng-sk-line w80"></div><div class="msng-sk-line w60"></div></div></div>`;
    listEl.innerHTML = sk(1) + sk(1) + sk(1) + sk(1) + sk(1);
  }

  function updateUnreadBadge(pageId, count) {
    if (!pageId) return;
    const badge = el('msngPageBadge_' + pageId);
    if (!badge) return;
    if (count > 0) {
      badge.style.display = 'flex';
      badge.textContent = count > 99 ? '99+' : count;
    } else {
      badge.style.display = 'none';
    }
  }

  // ── Open Conversation ────────────────────────────────────────
  window.msngOpenConv = async function (psid, name, picture, pageId) {
    M.activePsid    = psid;
    M.activeConvName = name;
    M.activeConvPic  = picture;

    // Join socket room for this conversation
    if (M.socket) M.socket.emit('join_conversation', psid);

    if (pageId) {
      M.activePageId = pageId;
      M.activeToken  = (M.pages.find(p => p.id === pageId) || {}).access_token || M.activeToken;
    }

    // Mark active in conv list
    document.querySelectorAll('.msng-conv-item').forEach(el => {
      el.classList.remove('active');
    });
    const conv = M.convs.find(c => c.psid === psid);
    if (conv) conv.unread = 0;
    renderConvs();

    // Show chat window
    showChatWindow(name, picture);

    // Load messages
    el('msngMsgs').innerHTML = '';
    M.msgs = [];
    M.oldestMsgTime = null;
    await loadMessages();

    // Mark as read in DB
    apiPost('mark-read', { pageId: M.activePageId, psid }).catch(() => {});

    renderMessages();
    const ta = el('msngMsgTextarea');
    if (ta) ta.focus();

    // Mobile: slide out conv list
    const convCol = el('msngConvsCol');
    if (convCol && window.innerWidth <= 640) convCol.classList.add('slide-out');
  };

  function showChatWindow(name, picture) {
    el('msngChatEmpty').style.display  = 'none';
    el('msngChatWindow').style.display = 'flex';

    // Set header
    const initial = (name || 'U').charAt(0).toUpperCase();
    el('msngChatHdrName').textContent = name || 'User';
    el('msngChatHdrSub').innerHTML = `<i class="fa-solid fa-circle dot-green" style="font-size:7px;color:#22c55e"></i> Facebook Messenger`;

    const avatarWrap = el('msngChatHdrAvatar');
    if (picture) {
      avatarWrap.innerHTML = `<img src="${esc(picture)}" alt="" onerror="this.parentNode.innerHTML='<div class=\'msng-hdr-initial\'>${esc(initial)}</div>'">`;
    } else {
      avatarWrap.innerHTML = `<div class="msng-hdr-initial">${esc(initial)}</div>`;
    }
  }

  function showChatEmpty() {
    const w = el('msngChatWindow');
    const e = el('msngChatEmpty');
    if (w) w.style.display = 'none';
    if (e) e.style.display = 'flex';
  }

  // ── Messages ─────────────────────────────────────────────────
  async function loadMessages(before = null) {
    if (!M.activePageId || !M.activePsid) return;

    try {
      const data = await api('messages', { psid: M.activePsid, pageId: M.activePageId, limit: 50, before: before });
      if (data.error) throw new Error(data.error);

      if (before) {
        // Prepend older messages
        M.msgs = [...data.messages, ...M.msgs];
      } else {
        M.msgs = data.messages;
      }

      if (M.msgs.length > 0) {
        M.oldestMsgTime = M.msgs[0].created_at;
      }

      renderMessages(before ? 'prepend' : 'replace');

      } catch (e) {
      console.error('[Messenger] loadMessages error:', e);
    }
  }

  function renderMessages(mode = 'replace') {
    const msgsEl = el('msngMsgs');
    if (!msgsEl) return;

    if (!M.msgs.length) {
      msgsEl.innerHTML = `<div class="msng-empty" style="margin-top:60px">
        <i class="fa-regular fa-comments"></i>
        <p>No messages yet. Start the conversation!</p>
      </div>`;
      return;
    }

    let html = '';
    let lastDate = '';
    let prevFromMe = null;

    // Load more button
    html += `<div class="msng-load-more" id="msngLoadMoreWrap">
      <button class="msng-load-more-btn" onclick="msngLoadMore()">
        <i class="fa-solid fa-chevron-up"></i> Load earlier messages
      </button>
    </div>`;

    M.msgs.forEach((msg, i) => {
      const fromMe  = msg.from_me == 1;
      const dateStr = fmtDate(msg.created_at);
      const timeStr = fmtMsgTime(msg.created_at);
      const txt     = msg.message || '';
      const attUrl  = msg.attachment_url;
      const attType = msg.attachment_type;

      // Date separator
      if (dateStr !== lastDate) {
        html += `<div class="msng-date-sep"><span>${esc(dateStr)}</span></div>`;
        lastDate = dateStr;
      }

      const isGrouped = prevFromMe === fromMe;
      const isLast    = (i === M.msgs.length - 1) || (M.msgs[i+1]?.from_me != msg.from_me);
      const showAvatar = !fromMe && isLast;

      // Build bubble content
      let bubbleContent = '';
      if (attType === 'image' && attUrl) {
        bubbleContent = `<img class="msng-att-img" src="${esc(attUrl)}" alt="Image" onclick="window.open('${esc(attUrl)}','_blank')">`;
        if (txt && txt !== '[Image]') bubbleContent += `<br>${esc(txt)}`;
      } else if (txt) {
        bubbleContent = esc(txt).replace(/\n/g, '<br>');
      } else {
        bubbleContent = '<em style="opacity:.5">Attachment</em>';
      }

      html += `<div class="msng-msg ${fromMe ? 'from-me' : ''}">`;

      // Avatar for received messages
      if (!fromMe) {
        if (showAvatar) {
          const initial = (M.activeConvName || 'U').charAt(0).toUpperCase();
          html += M.activeConvPic
            ? `<img class="msng-msg-avatar" src="${esc(M.activeConvPic)}" alt="" onerror="this.outerHTML='<div class=\'msng-msg-avatar-ph\'>${esc(initial)}</div>'">`
            : `<div class="msng-msg-avatar-ph">${esc(initial)}</div>`;
        } else {
          html += `<div style="width:28px;flex-shrink:0"></div>`;
        }
      }

      html += `<div class="msng-msg-group">
        <div class="msng-bubble">${bubbleContent}</div>
        ${isLast ? `<div class="msng-msg-time">${esc(timeStr)}</div>` : ''}
      </div>`;

      html += `</div>`;
      prevFromMe = fromMe;
    });

    if (mode === 'replace') {
      msgsEl.innerHTML = html;
      scrollToBottom();
    } else {
      const oldHeight = msgsEl.scrollHeight;
      msgsEl.innerHTML = html;
      msgsEl.scrollTop = msgsEl.scrollHeight - oldHeight;
    }

    // Scroll-to-bottom button logic
    setupScrollBtn(msgsEl);
  }

  function appendMessage(msg) {
    M.msgs.push(msg);
    const msgsEl = el('msngMsgs');
    if (!msgsEl) return;

    const fromMe    = msg.from_me == 1;
    const timeStr   = fmtMsgTime(msg.created_at || new Date().toISOString());
    const txt       = msg.message || '';
    const attUrl    = msg.attachment_url;
    const attType   = msg.attachment_type;

    let bubbleContent = '';
    if (attType === 'image' && attUrl) {
      bubbleContent = `<img class="msng-att-img" src="${esc(attUrl)}" alt="Image">`;
      if (txt && txt !== '[Image]') bubbleContent += `<br>${esc(txt)}`;
    } else {
      bubbleContent = esc(txt).replace(/\n/g, '<br>');
    }

    const initial = (M.activeConvName || 'U').charAt(0).toUpperCase();
    const div = document.createElement('div');
    div.className = 'msng-msg ' + (fromMe ? 'from-me' : '');
    div.innerHTML = `
      ${!fromMe ? (M.activeConvPic
        ? `<img class="msng-msg-avatar" src="${esc(M.activeConvPic)}" alt="">`
        : `<div class="msng-msg-avatar-ph">${esc(initial)}</div>`) : ''}
      <div class="msng-msg-group">
        <div class="msng-bubble">${bubbleContent}</div>
        <div class="msng-msg-time">${esc(timeStr)}</div>
      </div>`;

    msgsEl.appendChild(div);
    scrollToBottom();
  }

  function scrollToBottom() {
    const msgsEl = el('msngMsgs');
    if (msgsEl) {
      msgsEl.scrollTop = msgsEl.scrollHeight;
      const btn = el('msngScrollBtn');
      if (btn) btn.classList.remove('visible');
    }
  }

  function setupScrollBtn(msgsEl) {
    const btn = el('msngScrollBtn');
    if (!btn || !msgsEl) return;
    msgsEl.onscroll = () => {
      const atBottom = msgsEl.scrollTop + msgsEl.clientHeight >= msgsEl.scrollHeight - 60;
      btn.classList.toggle('visible', !atBottom);
    };
  }

  window.msngLoadMore = async function () {
    if (!M.oldestMsgTime) return;
    const btn = el('msngLoadMoreWrap');
    if (btn) btn.innerHTML = '<div class="msng-sk-line" style="width:120px;margin:auto"></div>';
    await loadMessages(M.oldestMsgTime);
  };

  // ── Send Message ─────────────────────────────────────────────
  window.msngSend = async function () {
    if (M.sending) return;
    const ta = el('msngMsgTextarea');
    if (!ta) return;

    const text = ta.value.trim();
    if (!text) return;
    if (!M.activePsid || !M.activePageId || !M.activeToken) {
      showMsngToast('Select a page and conversation first');
      return;
    }

    M.sending = true;
    const sendBtn = el('msngSendBtn');
    if (sendBtn) { sendBtn.disabled = true; sendBtn.classList.add('sending'); sendBtn.innerHTML = '<i class="fa-solid fa-circle-notch"></i>'; }

    ta.value = '';
    ta.style.height = 'auto';

    // Optimistic UI
    const tempMsg = {
      message:    text,
      from_me:    1,
      created_at: new Date().toISOString(),
    };
    appendMessage(tempMsg);

    try {
      const res = await apiPost('reply', {
        pageId:     M.activePageId,
        psid:        M.activePsid,
        message:     text,
        page_token:  M.activeToken,
      });

      if (res.error) {
        showMsngToast('Failed: ' + res.error);
        // Remove optimistic message
        M.msgs.pop();
        renderMessages('replace');
      } else {
        // Update last message in conv list
        const conv = M.convs.find(c => c.psid === M.activePsid);
        if (conv) { conv.lastMsg = text; conv.lastFromMe = true; conv.lastMsgAt = new Date().toISOString(); }
        renderConvs();
      }
    } catch (e) {
      showMsngToast('Network error. Please try again.');
      M.msgs.pop();
      renderMessages('replace');
    } finally {
      M.sending = false;
      if (sendBtn) { sendBtn.disabled = false; sendBtn.classList.remove('sending'); sendBtn.innerHTML = '<i class="fa-solid fa-paper-plane"></i>'; }
      if (ta) ta.focus();
    }
  };

  // Handle Enter key (Shift+Enter = newline)
  window.msngKeydown = function (e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      window.msngSend();
    }
  };

  // Auto-resize textarea
  window.msngTextareaInput = function (ta) {
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, 120) + 'px';
  };

  // ── Polling (every 3s for new messages via webhook-stored data) ──
  function startPolling() {
    stopPolling();
    M.lastPollTime = new Date(Date.now() - 5000).toISOString().replace('T', ' ').slice(0, 19);
    M.pollTimer = setInterval(poll, 3000);
  }

  function stopPolling() {
    if (M.pollTimer) { clearInterval(M.pollTimer); M.pollTimer = null; }
  }

  async function poll() {
    if (!M.activePageId) return;
    try {
      const params = { page_id: M.activePageId, since: M.lastPollTime };
      if (M.activePsid) params.psid = M.activePsid;

      const data = await api('poll', params);
      M.lastPollTime = data.server_time || new Date().toISOString().replace('T', ' ').slice(0, 19);

      // New messages in open conversation
      if (data.new_messages?.length) {
        data.new_messages.forEach(msg => {
          // Skip if already shown
          const exists = M.msgs.find(m => m.id === msg.id || (m.created_at === msg.created_at && m.message === msg.message));
          if (!exists) {
            appendMessage(msg);
          }
        });
      }

      // Updated conversations (unread counts, last messages)
      if (data.updated_convs?.length) {
        data.updated_convs.forEach(uc => {
          const existing = M.convs.find(c => c.psid === uc.fb_user_id);
          if (existing) {
            if (uc.fb_user_id !== M.activePsid) {
              existing.unread = parseInt(uc.is_unread) || 0;
            }
            if (uc.snippet) existing.lastMsg = uc.snippet;
            existing.lastMsgAt = uc.updated_at;
          } else {
            // New conversation appeared
            M.convs.unshift({
              id:       uc.id,
              psid:     uc.fb_user_id,
              name:     uc.user_name || 'User',
              picture:  uc.user_picture || null,
              lastMsg:  uc.snippet || '',
              lastFromMe: false,
              lastMsgAt:  uc.updated_at,
              unread:   parseInt(uc.is_unread) || 0,
              page_id:  uc.page_id,
            });
          }
        });

        M.convs.sort((a, b) => new Date(b.lastMsgAt) - new Date(a.lastMsgAt));
        renderConvs();

        // Show notification for new messages not in active conv
        const newFromOther = data.updated_convs.filter(c => c.fb_user_id !== M.activePsid && parseInt(c.is_unread) > 0);
        if (newFromOther.length) {
          showMsngToast('New message from ' + (newFromOther[0].user_name || 'a customer'));
        }
      }

      // Update total unread badge
      if (typeof data.total_unread === 'number') {
        updateUnreadBadge(M.activePageId, data.total_unread);
      }
    } catch (e) {
      // Silent — polling errors are expected during network hiccups
    }
  }

  // ── Search ───────────────────────────────────────────────────
  window.msngSearch = function (input) {
    M.searchQuery = input.value;
    renderConvs();
  };

  // ── Refresh button ───────────────────────────────────────────
  window.msngRefresh = function () {
    if (!M.activePageId) return;
    const btn = el('msngRefreshBtn');
    if (btn) btn.classList.add('spinning');
    loadConvsFromDB(M.activePageId).finally(() => {
      if (btn) btn.classList.remove('spinning');
    });
  };

  window.msngSyncNow = function () {
    if (!M.activePageId || !M.activeToken) {
      showMsngToast('No page selected');
      return;
    }
    window.msngSyncPage(M.activePageId, M.activeToken);
  };

  // ── Mobile back button ───────────────────────────────────────
  window.msngBack = function () {
    const convCol = el('msngConvsCol');
    if (convCol) convCol.classList.remove('slide-out');
    M.activePsid = null;
    showChatEmpty();
  };

  // ── Scroll to bottom btn ─────────────────────────────────────
  window.msngScrollToBottom = function () { scrollToBottom(); };

  // ── Mark read (header button) ─────────────────────────────────
  window.msngMarkRead = function () {
    if (!M.activePsid || !M.activePageId) return;
    apiPost('mark-read', { pageId: M.activePageId, psid: M.activePsid });
    const conv = M.convs.find(c => c.psid === M.activePsid);
    if (conv) conv.unread = 0;
    renderConvs();
  };

  // ── Stop polling when view is switched ───────────────────────
  const origSwitch = window.switchDashboardView;
  if (origSwitch) {
    window.switchDashboardView = function (view) {
      if (view !== 'messenger') stopPolling();
      else startPolling();
      origSwitch(view);
    };
  }

  // ── Sync with outer page selector ────────────────────────────
  // When the user picks a different page in the outer sidebar while
  // the messenger view is open, switch the active messenger page too.
  document.addEventListener('DOMContentLoaded', function () {
    const pageSelect = document.getElementById('pageSelect');
    if (pageSelect) {
      pageSelect.addEventListener('change', function () {
        const view = document.getElementById('view-messenger');
        if (view && view.style.display !== 'none' && this.value) {
          window.currentPageId = this.value;
          const page = (window.loadedPages || []).find(p => p.id === this.value);
          if (page) {
            M.pages = (window.loadedPages || []).filter(p => p && p.id && p.access_token);
            msngSelectPage(this.value);
          }
        }
      });
    }
  });

})();
