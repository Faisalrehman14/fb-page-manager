/**
 * FBCast Pro — Inline Support Chat Widget
 *
 * Small Intercom-style chat box that opens in the bottom-right when the user
 * clicks the sidebar "Contact us" button. Messages are stored server-side and
 * delivered in real-time over Socket.IO so the admin sees them instantly in
 * the admin panel and replies appear here without a refresh.
 */
(function (global) {
  'use strict';

  const FALLBACK_EMAIL =
    (global.APP_CONFIG && global.APP_CONFIG.contactEmail) || '';

  const state = {
    open: false,
    booted: false,
    threadId: null,
    messages: [],
    page: null,
    socket: null,
    socketBound: false,
    sending: false,
    lastSeenId: 0,
    unreadBadge: 0
  };

  function $(id) { return document.getElementById(id); }
  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function linkify(text) {
    const html = escapeHtml(text);
    return html.replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>');
  }
  function formatTime(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    const today = new Date();
    const sameDay = d.toDateString() === today.toDateString();
    const opts = sameDay
      ? { hour: 'numeric', minute: '2-digit' }
      : { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' };
    try { return d.toLocaleString([], opts); } catch (_) { return ''; }
  }

  function getCsrf() {
    try { return (window.getCsrfToken && window.getCsrfToken()) || (window.APP_CONFIG && window.APP_CONFIG.csrfToken) || ''; }
    catch (_) { return ''; }
  }

  function setBadge(n) {
    state.unreadBadge = Number(n) || 0;
    const btn = $('navContactBtn');
    if (!btn) return;
    let dot = btn.querySelector('.nav-contact-badge');
    if (state.unreadBadge > 0) {
      if (!dot) {
        dot = document.createElement('span');
        dot.className = 'nav-contact-badge';
        btn.appendChild(dot);
      }
      dot.textContent = state.unreadBadge > 9 ? '9+' : String(state.unreadBadge);
      dot.hidden = false;
    } else if (dot) {
      dot.hidden = true;
    }
  }

  function applyPageMeta(p) {
    state.page = p || {};
    const nameEl = $('chatwPageName');
    const subEl  = $('chatwPageSub');
    const linkBtn = $('chatwPageLink');
    if (nameEl) nameEl.textContent = (p && p.name) || 'Support team';
    if (subEl)  subEl.textContent  = (p && p.handle) ? ('@' + p.handle + ' · Replies within minutes') : 'Replies within minutes';
    if (linkBtn) {
      if (p && p.page_url) {
        linkBtn.hidden = false;
        linkBtn.onclick = () => window.open(p.page_url, '_blank', 'noopener');
      } else {
        linkBtn.hidden = true;
      }
    }
  }

  function renderMessages() {
    const box = $('chatwMessages');
    const welcome = $('chatwWelcome');
    if (!box) return;
    if (!state.messages.length) {
      box.innerHTML = '';
      if (welcome) welcome.style.display = '';
      return;
    }
    if (welcome) welcome.style.display = 'none';

    let html = '';
    let lastDate = '';
    let lastSender = null;
    for (const m of state.messages) {
      const d = new Date(m.created_at);
      const day = isNaN(d.getTime()) ? '' : d.toDateString();
      if (day && day !== lastDate) {
        lastDate = day;
        const today = new Date().toDateString();
        const label = day === today ? 'Today' : d.toLocaleDateString([], { month: 'short', day: 'numeric' });
        html += `<div class="chatw__date">${label}</div>`;
        lastSender = null;
      }
      const cls = m.sender_type === 'admin' ? 'chatw__msg chatw__msg--in' : 'chatw__msg chatw__msg--out';
      const groupCls = lastSender === m.sender_type ? ' chatw__msg--cont' : '';
      lastSender = m.sender_type;
      html += `
        <div class="${cls}${groupCls}">
          <div class="chatw__bubble">${linkify(m.body)}</div>
          <div class="chatw__time">${formatTime(m.created_at)}</div>
        </div>`;
    }
    box.innerHTML = html;
    box.scrollTop = box.scrollHeight;

    const last = state.messages[state.messages.length - 1];
    if (last && Number(last.id) > state.lastSeenId) state.lastSeenId = Number(last.id);
  }

  async function fetchChat() {
    try {
      const r = await fetch('/api/support/chat', { credentials: 'same-origin' });
      if (!r.ok) throw new Error('http ' + r.status);
      const data = await r.json();
      state.threadId = data.thread ? data.thread.id : null;
      state.messages = Array.isArray(data.messages) ? data.messages : [];
      applyPageMeta(data.page);
      renderMessages();
      if (state.open) markRead();
    } catch (e) {
      console.warn('[support] fetchChat', e);
    }
  }

  async function fetchUnread() {
    try {
      const r = await fetch('/api/support/chat/unread', { credentials: 'same-origin' });
      if (!r.ok) return;
      const d = await r.json();
      if (!state.open) setBadge(d.unread || 0);
    } catch (_) {}
  }

  async function markRead() {
    if (!state.threadId) return;
    try {
      await fetch('/api/support/chat/read', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': getCsrf() },
        body: JSON.stringify({})
      });
      setBadge(0);
    } catch (_) {}
  }

  async function sendMessage(body) {
    if (!body || state.sending) return;
    state.sending = true;
    const sendBtn = $('chatwSend');
    if (sendBtn) sendBtn.disabled = true;

    // Optimistic message
    const optimistic = {
      id: 'temp-' + Date.now(),
      thread_id: state.threadId,
      sender_type: 'user',
      body: body,
      created_at: new Date().toISOString()
    };
    state.messages.push(optimistic);
    renderMessages();

    try {
      const r = await fetch('/api/support/chat/send', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': getCsrf() },
        body: JSON.stringify({ body })
      });
      if (!r.ok) throw new Error('http ' + r.status);
      const data = await r.json();
      // Replace optimistic with real
      const idx = state.messages.findIndex(m => m.id === optimistic.id);
      if (idx >= 0 && data.message) state.messages[idx] = data.message;
      state.threadId = data.thread_id || state.threadId;
      renderMessages();
    } catch (e) {
      console.warn('[support] send failed', e);
      // Mark optimistic message as failed (no UI yet — leave for now)
    } finally {
      state.sending = false;
      if (sendBtn) sendBtn.disabled = false;
      const input = $('chatwInput');
      if (input) { input.value = ''; autoGrow(input); input.focus(); }
    }
  }

  function autoGrow(el) {
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(120, el.scrollHeight) + 'px';
    const sendBtn = $('chatwSend');
    if (sendBtn) sendBtn.disabled = !el.value.trim() || state.sending;
  }

  function bindSocket() {
    if (state.socketBound) return;
    if (typeof io !== 'function') return;
    try {
      state.socket = io({ path: '/socket.io', transports: ['websocket', 'polling'] });
      state.socket.on('connect', () => { /* connected */ });
      state.socket.on('support:message', (payload) => {
        if (!payload || !payload.message) return;
        // Only append if not already in list
        if (state.messages.some(m => Number(m.id) === Number(payload.message.id))) return;
        state.messages.push(payload.message);
        renderMessages();
        if (payload.message.sender_type === 'admin') {
          if (state.open) {
            markRead();
          } else {
            setBadge(state.unreadBadge + 1);
            pingNotification(payload.message);
          }
        }
      });
      state.socketBound = true;
    } catch (e) {
      console.warn('[support] socket bind failed', e);
    }
  }

  function pingNotification(msg) {
    try {
      const t = window.showNotification || window.showToast;
      const sender = (state.page && state.page.name) || 'Support';
      const text = String(msg.body || '').slice(0, 80);
      if (typeof t === 'function') t(`${sender}: ${text}`, 'info');
    } catch (_) {}
  }

  function openWidget() {
    const w = $('supportWidget');
    if (!w) return;
    w.hidden = false;
    w.setAttribute('aria-hidden', 'false');
    requestAnimationFrame(() => w.classList.add('chatw--open'));
    state.open = true;
    const input = $('chatwInput');
    if (input) setTimeout(() => input.focus(), 200);
    fetchChat();
    markRead();
  }

  function closeWidget() {
    const w = $('supportWidget');
    if (!w) return;
    w.classList.remove('chatw--open');
    state.open = false;
    setTimeout(() => {
      if (!state.open) {
        w.hidden = true;
        w.setAttribute('aria-hidden', 'true');
      }
    }, 220);
  }

  function toggleWidget() {
    if (state.open) closeWidget();
    else openWidget();
  }

  function bindEvents() {
    const btn = $('navContactBtn');
    if (btn) {
      // Replace the inline onclick handler behaviour
      btn.onclick = (e) => { e.preventDefault(); toggleWidget(); };
    }
    const closeBtn = $('chatwClose');
    if (closeBtn) closeBtn.addEventListener('click', closeWidget);

    const form = $('chatwForm');
    const input = $('chatwInput');
    if (input) {
      input.addEventListener('input', () => autoGrow(input));
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          const v = input.value.trim();
          if (v) sendMessage(v);
        }
      });
    }
    if (form) {
      form.addEventListener('submit', (e) => {
        e.preventDefault();
        if (!input) return;
        const v = input.value.trim();
        if (v) sendMessage(v);
      });
    }

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && state.open) closeWidget();
    });
  }

  function showButton() {
    const btn = $('navContactBtn');
    if (btn) btn.style.display = '';
  }

  function boot() {
    if (state.booted) return;
    if (!$('navContactBtn') || !$('supportWidget')) return;
    state.booted = true;
    bindEvents();
    showButton();
    fetchUnread();
    setInterval(fetchUnread, 30000);
    bindSocket();
  }

  function init() {
    // Defer until app dashboard is visible (post-login)
    const appPage = document.getElementById('appPage');
    if (!appPage || appPage.style.display === 'none' || appPage.hidden) {
      if (typeof window.showAppDashboard === 'function') {
        const orig = window.showAppDashboard;
        window.showAppDashboard = function () {
          const r = orig.apply(this, arguments);
          setTimeout(boot, 100);
          return r;
        };
      }
      if (appPage) {
        const obs = new MutationObserver(() => {
          if (appPage.style.display !== 'none' && !appPage.hidden) {
            boot();
            obs.disconnect();
          }
        });
        obs.observe(appPage, { attributes: true, attributeFilter: ['style', 'hidden'] });
      }
      return;
    }
    boot();
  }

  global.fbcastSupport = {
    open: openWidget,
    close: closeWidget,
    toggle: toggleWidget,
    refresh: fetchChat
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})(window);
