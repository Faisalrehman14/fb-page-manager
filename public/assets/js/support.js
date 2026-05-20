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

  /**
   * Synchronously read the CSRF token. Falls back across:
   *   - APP_CONFIG.csrfToken (injected at SSR)
   *   - CSRF_TOKEN cookie (set by csrfBootstrap on every request)
   * NOTE: window.getCsrfToken() is intentionally NOT used here because it
   * is async and returns a Promise which would stringify to
   * "[object Promise]" in a header. We use the async resolveCsrf() below
   * for the actual fetch.
   */
  function getCsrfSync() {
    try {
      if (window.APP_CONFIG && window.APP_CONFIG.csrfToken) return window.APP_CONFIG.csrfToken;
      const m = document.cookie.match(/(?:^|; )CSRF_TOKEN=([^;]+)/);
      if (m && m[1]) return decodeURIComponent(m[1]);
    } catch (_) {}
    return '';
  }

  async function resolveCsrf() {
    try {
      if (typeof window.getCsrfToken === 'function') {
        const t = await window.getCsrfToken();
        if (t) return t;
      }
    } catch (_) {}
    return getCsrfSync();
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
    if (nameEl) nameEl.textContent = 'FBCast Pro Support';
    if (subEl) {
      const email = (p && p.email) ? String(p.email).trim() : '';
      if (email) {
        subEl.textContent = email;
        subEl.href = 'mailto:' + email;
      } else if (p && p.page_url) {
        subEl.textContent = p.page_handle ? ('@' + p.page_handle) : 'Visit our page';
        subEl.href = p.page_url;
        subEl.target = '_blank';
        subEl.rel = 'noopener';
      } else {
        subEl.textContent = 'Replies within minutes';
        subEl.removeAttribute('href');
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
      const failedCls = m._failed ? ' chatw__msg--failed' : '';
      lastSender = m.sender_type;
      const idAttr = m._failed ? ` data-msg-id="${escapeHtml(String(m.id))}"` : '';
      const meta = m._failed
        ? `<div class="chatw__msg-meta">
             <span class="chatw__msg-failed"><i class="fa-solid fa-circle-exclamation"></i> Not delivered</span>
             <button type="button" class="chatw__retry" onclick="window.fbcastSupport && window.fbcastSupport.retry('${escapeHtml(String(m.id))}')">Retry</button>
           </div>`
        : `<div class="chatw__time">${formatTime(m.created_at)}</div>`;
      html += `
        <div class="${cls}${groupCls}${failedCls}"${idAttr}>
          <div class="chatw__bubble">${linkify(m.body)}</div>
          ${meta}
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
      const serverMessages = Array.isArray(data.messages) ? data.messages : [];

      // Preserve any optimistic (temp-*) messages that haven't been confirmed
      const pendingLocal = state.messages.filter(m => String(m.id || '').startsWith('temp-'));
      state.messages = mergeMessages(serverMessages, pendingLocal);

      applyPageMeta(data.page);
      renderMessages();
      if (state.open) markRead();
    } catch (e) {
      console.warn('[support] fetchChat', e);
    }
  }

  function mergeMessages(a, b) {
    const seen = new Set();
    const out = [];
    for (const m of [...a, ...b]) {
      const key = String(m.id);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(m);
    }
    out.sort((x, y) => {
      const tx = new Date(x.created_at).getTime() || 0;
      const ty = new Date(y.created_at).getTime() || 0;
      return tx - ty;
    });
    return out;
  }

  function clearChat() {
    state.messages = [];
    state.lastSeenId = 0;
    renderMessages();
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
      const csrf = await resolveCsrf();
      await fetch('/api/support/chat/read', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
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

    const optimisticId = 'temp-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7);
    const optimistic = {
      id: optimisticId,
      thread_id: state.threadId,
      sender_type: 'user',
      body: body,
      created_at: new Date().toISOString()
    };
    state.messages.push(optimistic);
    renderMessages();

    let success = false;
    try {
      const csrf = await resolveCsrf();
      const r = await fetch('/api/support/chat/send', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
        body: JSON.stringify({ body })
      });
      if (!r.ok) {
        let errMsg = 'HTTP ' + r.status;
        try { const ej = await r.json(); if (ej && ej.error) errMsg = ej.error; } catch (_) {}
        throw new Error(errMsg);
      }
      const data = await r.json();
      state.threadId = data.thread_id || state.threadId;
      success = true;

      const idx = state.messages.findIndex(m => m.id === optimisticId);
      if (data.message) {
        const realExists = state.messages.some(m =>
          String(m.id) === String(data.message.id) && !String(m.id).startsWith('temp-')
        );
        if (idx >= 0) {
          if (realExists) {
            // Socket beat us to it — drop the optimistic and keep the real one
            state.messages.splice(idx, 1);
          } else {
            state.messages[idx] = data.message;
          }
        } else if (!realExists) {
          state.messages.push(data.message);
        }
      }
      renderMessages();
    } catch (e) {
      console.error('[support] send failed:', e.message || e);
      // Mark optimistic as failed; user can retry
      const idx = state.messages.findIndex(m => m.id === optimisticId);
      if (idx >= 0) {
        state.messages[idx]._failed = true;
        state.messages[idx]._error = String(e.message || 'Network error');
      }
      renderMessages();
    } finally {
      state.sending = false;
      if (sendBtn) sendBtn.disabled = false;
      if (success) {
        const input = $('chatwInput');
        if (input) { input.value = ''; autoGrow(input); input.focus(); }
      }
    }
  }

  async function retryMessage(messageId) {
    const idx = state.messages.findIndex(m => String(m.id) === String(messageId));
    if (idx < 0) return;
    const m = state.messages[idx];
    if (!m || !m._failed) return;
    // Remove the failed message and re-send the same body
    const body = m.body;
    state.messages.splice(idx, 1);
    renderMessages();
    await sendMessage(body);
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
        const incoming = payload.message;
        // 1) Already saved with the same real ID → skip
        if (state.messages.some(m => String(m.id) === String(incoming.id))) return;
        // 2) The user's own echo arrived before/after the REST response.
        //    Replace the optimistic (temp-*) message with the real one
        //    instead of appending a duplicate.
        const pendIdx = state.messages.findIndex(m =>
          String(m.id).startsWith('temp-') &&
          m.sender_type === incoming.sender_type &&
          m.body === incoming.body
        );
        if (pendIdx >= 0) {
          state.messages[pendIdx] = incoming;
        } else {
          state.messages.push(incoming);
        }
        renderMessages();
        if (incoming.sender_type === 'admin') {
          // Make the contact button pulse to signal live activity
          const btn = $('navContactBtn');
          if (btn) {
            btn.classList.add('nav-contact-btn--pulse');
            clearTimeout(state._pulseT);
            state._pulseT = setTimeout(() => btn.classList.remove('nav-contact-btn--pulse'), 4000);
          }
          if (state.open) {
            markRead();
          } else {
            setBadge(state.unreadBadge + 1);
            pingNotification(incoming);
          }
        }
      });
      state.socket.on('support:resolved', () => {
        clearChat();
        setBadge(0);
        if (state.open) {
          // Show a small one-time toast inside the widget
          showInlineNotice('This conversation was marked as resolved. Send a new message to start a fresh chat.');
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
      const sender = (state.page && state.page.name) || 'FBCast Pro Support';
      const text = String(msg.body || '').slice(0, 80);
      if (typeof t === 'function') t(`${sender}: ${text}`, 'info');
    } catch (_) {}
  }

  function showInlineNotice(message) {
    const body = $('chatwBody');
    if (!body) return;
    const old = body.querySelector('.chatw__notice');
    if (old) old.remove();
    const el = document.createElement('div');
    el.className = 'chatw__notice';
    el.innerHTML = '<i class="fa-solid fa-circle-check"></i><span>' +
                   message.replace(/&/g,'&amp;').replace(/</g,'&lt;') + '</span>';
    body.appendChild(el);
    setTimeout(() => { if (el && el.parentNode) el.remove(); }, 6000);
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

    const chips = $('chatwChips');
    if (chips) {
      chips.addEventListener('click', (e) => {
        const chip = e.target.closest('.chatw__chip');
        if (!chip) return;
        const msg = chip.getAttribute('data-msg') || chip.textContent.trim();
        const inp = $('chatwInput');
        if (inp) {
          inp.value = msg;
          autoGrow(inp);
          inp.focus();
          // Place caret at end
          const len = inp.value.length;
          try { inp.setSelectionRange(len, len); } catch (_) {}
        }
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
    refresh: fetchChat,
    retry: retryMessage
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})(window);
