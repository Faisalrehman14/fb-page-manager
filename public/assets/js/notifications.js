/**
 * FBCast Pro — User Notifications
 *
 * Topbar bell + dropdown panel. Pulls /api/notifications, tracks read state,
 * shows toast for new admin-pushed notifications via Socket.IO.
 */
(function (global) {
  'use strict';

  const POLL_MS = 60_000; // fallback poll when socket isn't connected
  const TOAST_DURATION = 6000;

  let notifications = [];
  let unread = 0;
  let pollTimer = null;
  let booted = false;

  function $(id) { return document.getElementById(id); }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function timeAgo(iso) {
    const t = new Date(iso).getTime();
    if (!t) return '';
    const s = Math.floor((Date.now() - t) / 1000);
    if (s < 60) return 'Just now';
    if (s < 3600) return Math.floor(s / 60) + 'm ago';
    if (s < 86400) return Math.floor(s / 3600) + 'h ago';
    if (s < 2592000) return Math.floor(s / 86400) + 'd ago';
    return new Date(iso).toLocaleDateString();
  }

  function sevIcon(sev) {
    switch (sev) {
      case 'success':  return 'fa-circle-check';
      case 'warning':  return 'fa-triangle-exclamation';
      case 'critical': return 'fa-circle-exclamation';
      default:         return 'fa-circle-info';
    }
  }

  async function csrf() {
    try {
      if (typeof global.getCsrfToken === 'function') return await global.getCsrfToken();
    } catch (_) {}
    return global.APP_CONFIG?.csrfToken || '';
  }

  async function api(path, opts) {
    opts = opts || {};
    const init = {
      method: opts.method || 'GET',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' }
    };
    if (opts.body) init.body = JSON.stringify(opts.body);
    if (init.method !== 'GET') {
      const t = await csrf();
      if (t) init.headers['X-CSRF-Token'] = t;
    }
    const r = await fetch(path, init);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.json();
  }

  function setBadge(n) {
    unread = Math.max(0, parseInt(n, 10) || 0);
    const b = $('notifBadge');
    const bell = $('notifBellBtn');
    if (!b || !bell) return;
    if (unread > 0) {
      b.textContent = unread > 99 ? '99+' : String(unread);
      b.hidden = false;
      bell.classList.add('has-unread');
    } else {
      b.hidden = true;
      bell.classList.remove('has-unread');
    }
  }

  function render() {
    const list = $('notifList');
    const meta = $('notifFooterMeta');
    if (!list) return;
    if (!notifications.length) {
      list.innerHTML = '<div class="notif-empty"><i class="fa-solid fa-bell-slash"></i><p>You\'re all caught up.</p></div>';
      if (meta) meta.textContent = 'No notifications yet';
      return;
    }
    list.innerHTML = notifications.map(n => {
      const sev = n.severity || 'info';
      const unreadCls = n.is_read ? '' : 'is-unread';
      const link = n.link_url
        ? `<a class="notif-card-link" href="${esc(n.link_url)}" target="_blank" rel="noopener">Open link →</a>`
        : '';
      return `<div class="notif-card ${unreadCls}" data-id="${n.id}">
        <div class="notif-card-icon notif-icon--${sev}">
          <i class="fa-solid ${sevIcon(sev)}"></i>
        </div>
        <div class="notif-card-body">
          <div class="notif-card-title">${esc(n.title || '')}</div>
          <div class="notif-card-text">${esc(n.body || '')}</div>
          ${link}
          <div class="notif-card-meta">${timeAgo(n.created_at)}${n.target_type === 'user' ? ' · Personal' : ''}</div>
        </div>
      </div>`;
    }).join('');
    if (meta) meta.textContent = unread > 0 ? `${unread} unread` : `${notifications.length} total`;
  }

  async function load(silent) {
    try {
      const d = await api('/api/notifications?limit=25');
      notifications = d.notifications || [];
      setBadge(d.unread || 0);
      render();
    } catch (e) {
      if (!silent) console.warn('notif load failed', e);
    }
  }

  async function fetchUnreadOnly() {
    try {
      const d = await api('/api/notifications/unread-count');
      setBadge(d.unread || 0);
    } catch (_) {}
  }

  async function markAllRead() {
    try {
      await api('/api/notifications/read-all', { method: 'POST', body: {} });
      notifications = notifications.map(n => ({ ...n, is_read: 1 }));
      setBadge(0);
      render();
    } catch (e) {
      console.warn('mark all read failed', e);
    }
  }

  async function markOneRead(id) {
    try {
      await api('/api/notifications/' + id + '/read', { method: 'POST', body: {} });
      notifications = notifications.map(n => n.id === id ? { ...n, is_read: 1 } : n);
      setBadge(Math.max(0, unread - 1));
      render();
    } catch (_) {}
  }

  function togglePanel(force) {
    const panel = $('notifPanel');
    const bell = $('notifBellBtn');
    if (!panel || !bell) return;
    const willOpen = force !== undefined ? force : panel.hidden;
    panel.hidden = !willOpen;
    bell.setAttribute('aria-expanded', String(willOpen));
    if (willOpen) {
      load(true);
    }
  }

  function attachEvents() {
    const bell = $('notifBellBtn');
    const panel = $('notifPanel');
    const markAll = $('notifMarkAll');
    if (!bell || !panel) return;

    bell.addEventListener('click', (e) => {
      e.stopPropagation();
      togglePanel();
    });

    markAll.addEventListener('click', (e) => {
      e.stopPropagation();
      markAllRead();
    });

    panel.addEventListener('click', (e) => {
      const card = e.target.closest('.notif-card');
      if (!card) return;
      const id = parseInt(card.dataset.id, 10);
      if (!id) return;
      if (card.classList.contains('is-unread')) {
        markOneRead(id);
      }
      const a = e.target.closest('a');
      if (a) e.stopPropagation();
    });

    document.addEventListener('click', (e) => {
      if (panel.hidden) return;
      if (!panel.contains(e.target) && !bell.contains(e.target)) {
        togglePanel(false);
      }
    });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !panel.hidden) togglePanel(false);
    });
  }

  function showToast(notif) {
    const root = document.body;
    const sev = notif.severity || 'info';
    const el = document.createElement('div');
    el.className = 'notif-toast notif-toast--' + sev;
    el.innerHTML = `
      <div class="notif-toast__icon"><i class="fa-solid ${sevIcon(sev)}"></i></div>
      <div class="notif-toast__body">
        <div class="notif-toast__title">${esc(notif.title || 'New notification')}</div>
        <div class="notif-toast__text">${esc((notif.body || '').slice(0, 200))}</div>
      </div>
      <button type="button" class="notif-toast__close" aria-label="Dismiss">&times;</button>
    `;
    root.appendChild(el);
    requestAnimationFrame(() => el.classList.add('is-in'));
    const close = () => {
      el.classList.remove('is-in');
      setTimeout(() => el.remove(), 280);
    };
    el.querySelector('.notif-toast__close').addEventListener('click', close);
    setTimeout(close, sev === 'critical' ? 12000 : TOAST_DURATION);
  }

  let socket = null;

  function handleIncoming(payload) {
    if (!payload || !payload.id) return;
    showToast(payload);
    load(true);
    if (typeof global.Notification !== 'undefined' && global.Notification.permission === 'granted') {
      try {
        new Notification(payload.title || 'New notification', {
          body: (payload.body || '').slice(0, 120),
          tag: 'fbcast-admin-' + payload.id
        });
      } catch (_) {}
    }
  }

  function bindSocket() {
    if (typeof global.io !== 'function') {
      setTimeout(bindSocket, 1000);
      return;
    }
    if (socket) return;
    try {
      socket = global.io({
        transports: ['websocket', 'polling'],
        reconnection: true,
        reconnectionDelay: 1500,
        reconnectionDelayMax: 15000,
        reconnectionAttempts: Infinity,
        withCredentials: true
      });
      socket.on('admin_notification', handleIncoming);
      socket.on('connect', () => fetchUnreadOnly());
      socket.on('reconnect', () => load(true));
    } catch (e) {
      socket = null;
      setTimeout(bindSocket, 5000);
    }
  }

  function startPolling() {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(fetchUnreadOnly, POLL_MS);
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) fetchUnreadOnly();
    });
  }

  function isAppVisible() {
    const app = document.getElementById('appPage');
    return !!(app && app.style.display !== 'none' && app.offsetParent !== null);
  }

  function boot() {
    if (booted) return;
    if (!$('notifBellBtn')) return;
    booted = true;
    attachEvents();
    load(true);
    bindSocket();
    startPolling();
  }

  function init() {
    if (!$('notifBellBtn')) return;
    if (isAppVisible()) {
      boot();
      return;
    }
    const prev = global.showAppDashboard;
    global.showAppDashboard = function () {
      try {
        if (typeof prev === 'function') prev.apply(this, arguments);
      } finally {
        setTimeout(boot, 200);
      }
    };
    const appPage = document.getElementById('appPage');
    if (appPage) {
      const obs = new MutationObserver(() => {
        if (isAppVisible()) {
          obs.disconnect();
          setTimeout(boot, 200);
        }
      });
      obs.observe(appPage, { attributes: true, attributeFilter: ['style', 'class'] });
    }
  }

  global.fbcastNotifications = {
    refresh: load,
    open:    () => togglePanel(true),
    close:   () => togglePanel(false),
    badge:   () => unread
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})(window);
