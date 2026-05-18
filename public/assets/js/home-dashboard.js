/**
 * Home dashboard — live data sync (poll + socket + broadcast progress).
 */
(function () {
  const POLL_MS = 12000;
  let pollTimer = null;
  let refreshing = false;
  let homeVisible = false;

  window.homeDashboardState = {
    schedules: [],
    scheduleStats: { total: 0, pending: 0, done: 0, failed: 0 },
    unread: { total: 0, byPage: {} },
    pagesCount: 0,
    quota: null,
    updatedAt: null
  };

  function mapSchedulesToBroadcasts(schedules) {
    return (schedules || []).map(s => ({
      message: s.message,
      scheduled_at: s.scheduled_at,
      created_at: s.created_at,
      status: s.status === 'done' ? 'completed'
        : s.status === 'running' ? 'sending'
        : s.status === 'pending' ? 'scheduled'
        : s.status,
      page_name: s.page_name,
      page_id: s.page_id,
      pages: s.pages
    }));
  }

  function formatRelativeTime(iso) {
    if (!iso) return 'Just now';
    const sec = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
    if (sec < 5) return 'Just now';
    if (sec < 60) return sec + 's ago';
    if (sec < 3600) return Math.floor(sec / 60) + 'm ago';
    return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  function setLiveStatus(syncing) {
    const dot = document.getElementById('homeLiveDot');
    const label = document.getElementById('homeLiveLabel');
    const bar = document.getElementById('homeLiveBar');
    if (dot) {
      dot.classList.toggle('hv-live-dot--sync', !!syncing);
    }
    if (label) label.textContent = syncing ? 'Syncing…' : 'Live';
    if (bar) bar.classList.toggle('hv-live-bar--sync', !!syncing);
  }

  function updateLiveBar(iso) {
    const el = document.getElementById('homeLastUpdated');
    if (el) el.textContent = 'Updated ' + formatRelativeTime(iso);
    const isoEl = document.getElementById('homeUpdatedIso');
    if (isoEl) isoEl.textContent = iso || '';
  }

  function animateStat(el, nextVal) {
    if (!el) return;
    const next = String(nextVal);
    if (el.textContent === next) return;
    el.classList.remove('hv-stat-flash');
    void el.offsetWidth;
    el.textContent = next;
    el.classList.add('hv-stat-flash');
  }

  function applyUnreadToPages(byPage) {
    if (!window.loadedPages || !byPage) return;
    window.loadedPages.forEach(p => {
      p.unreadCount = byPage[p.id] || 0;
    });
  }

  function applyQuota(quota) {
    if (!quota || typeof window.saveQuota !== 'function') return;
    const q = window.getQuota ? window.getQuota() : {};
    window.saveQuota({
      messagesUsed: quota.messagesUsed ?? q.messagesUsed ?? 0,
      messageLimit: quota.messageLimit ?? q.messageLimit ?? 2000,
      subscriptionStatus: quota.subscriptionStatus || q.subscriptionStatus || 'free'
    });
    if (window.updateQuotaUI) window.updateQuotaUI();
  }

  function applySummary(data) {
    window.homeDashboardState = {
      schedules: data.schedules || [],
      scheduleStats: data.scheduleStats || { total: 0, pending: 0, done: 0, failed: 0 },
      unread: data.unread || { total: 0, byPage: {} },
      pagesCount: data.pagesCount ?? 0,
      quota: data.quota || null,
      updatedAt: data.updatedAt || new Date().toISOString()
    };

    window.allBroadcasts = mapSchedulesToBroadcasts(data.schedules);
    applyUnreadToPages(data.unread?.byPage);
    if (data.quota) applyQuota(data.quota);

    const pages = window.loadedPages?.length || data.pagesCount || 0;
    const recs = window.allRecipients || [];
    const sent = recs.filter(r => r.status === 'sent').length;
    const pending = recs.filter(r => r.status === 'pending' || r.status === 'sending').length;
    const total = recs.length;
    const rate = total > 0 ? Math.round((sent / total) * 100) + '%' : '0%';

    animateStat(document.getElementById('kpiPages'), pages);
    animateStat(document.getElementById('kpiSent'), sent.toLocaleString());
    animateStat(document.getElementById('kpiDelivery'), rate);
    animateStat(document.getElementById('kpiPending'), pending.toLocaleString());
    animateStat(document.getElementById('kpiUnread'), (data.unread?.total || 0).toLocaleString());

    const schedBadge = document.getElementById('homeSchedNavBadge');
    if (schedBadge) {
      const n = data.scheduleStats?.pending || 0;
      schedBadge.textContent = n > 99 ? '99+' : String(n);
      schedBadge.style.display = n > 0 ? 'inline-flex' : 'none';
    }

    updateLiveBar(window.homeDashboardState.updatedAt);

    if (typeof window.updateHomeViewStats === 'function') {
      window.updateHomeViewStats();
    }
  }

  async function refresh(force) {
    if (refreshing && !force) return;
    refreshing = true;
    setLiveStatus(true);
    try {
      const res = await fetch('/api/dashboard/summary', {
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { Accept: 'application/json' }
      });
      if (!res.ok) throw new Error('summary failed');
      const data = await res.json();
      applySummary(data);
    } catch (_) {
      const el = document.getElementById('homeLastUpdated');
      if (el) el.textContent = 'Reconnecting…';
    } finally {
      refreshing = false;
      setLiveStatus(false);
    }
  }

  function isHomeActive() {
    const home = document.getElementById('view-home');
    return home && home.style.display !== 'none';
  }

  function tick() {
    if (!isHomeActive()) return;
    refresh(false);
  }

  function start() {
    homeVisible = true;
    refresh(true);
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(tick, POLL_MS);
  }

  function stop() {
    homeVisible = false;
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  function onVisibilityChange() {
    if (document.hidden) {
      if (pollTimer) clearInterval(pollTimer);
      pollTimer = null;
    } else if (homeVisible && isHomeActive()) {
      refresh(true);
      if (!pollTimer) pollTimer = setInterval(tick, POLL_MS);
    }
  }

  window.addEventListener('fbc:conversation-changed', () => {
    if (isHomeActive()) refresh(false);
  });

  window.addEventListener('fbc:broadcast-progress', () => {
    if (isHomeActive() && typeof window.updateHomeViewStats === 'function') {
      window.updateHomeViewStats();
    }
  });

  document.addEventListener('visibilitychange', onVisibilityChange);

  const refreshBtn = () => document.getElementById('homeRefreshBtn');
  document.addEventListener('click', (e) => {
    if (e.target.closest('#homeRefreshBtn')) {
      e.preventDefault();
      refresh(true);
    }
  });

  window.homeDashboard = { refresh, start, stop, isActive: isHomeActive };

  function bootstrapIfHome() {
    const app = document.getElementById('appPage');
    if (!app || app.style.display === 'none') return;
    const home = document.getElementById('view-home');
    if (!home || home.style.display === 'none') return;
    start();
  }

  document.addEventListener('DOMContentLoaded', () => {
    setTimeout(bootstrapIfHome, 400);
  });
  window.addEventListener('fbc:pages-ready', bootstrapIfHome);
})();
