/**
 * FBCast Pro — Analytics dashboard (client history + schedules)
 */
(function (global) {
  'use strict';

  const HISTORY_KEY = 'fbcast_broadcast_history';
  const MAX_HISTORY = 80;
  let currentPeriod = 7;

  function $(id) {
    return document.getElementById(id);
  }

  function loadHistory() {
    try {
      const raw = localStorage.getItem(HISTORY_KEY);
      return raw ? JSON.parse(raw) : [];
    } catch (_) {
      return [];
    }
  }

  function saveHistory(list) {
    try {
      localStorage.setItem(HISTORY_KEY, JSON.stringify(list.slice(-MAX_HISTORY)));
    } catch (_) {}
  }

  function recordBroadcast(entry) {
    if (!entry) return;
    const sent = Number(entry.sent) || 0;
    const failed = Number(entry.failed) || 0;
    if (sent + failed === 0 && !entry.total) return;
    const list = loadHistory();
    list.push({
      id: 'b_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7),
      ts: new Date().toISOString(),
      mode: entry.mode || 'manual',
      pageId: entry.pageId || '',
      pages: entry.pages || 1,
      total: Number(entry.total) || 0,
      sent: Number(entry.sent) || 0,
      failed: Number(entry.failed) || 0
    });
    saveHistory(list);
  }

  function filterByPeriod(items, days) {
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
    return items.filter((i) => new Date(i.ts).getTime() >= cutoff);
  }

  function aggregate(items) {
    let sent = 0;
    let failed = 0;
    items.forEach((i) => {
      sent += Number(i.sent) || 0;
      failed += Number(i.failed) || 0;
    });
    const total = sent + failed;
    const rate = total > 0 ? Math.round((sent / total) * 100) : 0;
    return { sent, failed, total, rate };
  }

  function scheduleToHistory(schedules) {
    return (schedules || [])
      .filter((s) => s.status === 'done' || s.status === 'failed')
      .map((s) => ({
        id: 'sched_' + s.id,
        ts: s.updated_at || s.scheduled_at || s.created_at,
        mode: 'scheduled',
        pages: Array.isArray(s.pages) ? s.pages.length : (Array.isArray(s.pages_data) ? s.pages_data.length : 1),
        total: (Number(s.sent_count) || 0) + (Number(s.failed_count) || 0),
        sent: Number(s.sent_count) || 0,
        failed: Number(s.failed_count) || 0,
        label: (s.message || '').slice(0, 60)
      }));
  }

  async function fetchSchedules() {
    try {
      const csrf = typeof global.getCsrfToken === 'function' ? await global.getCsrfToken() : '';
      const res = await fetch('/api/schedules', {
        credentials: 'same-origin',
        headers: csrf ? { 'X-CSRF-Token': csrf } : {}
      });
      if (!res.ok) return [];
      const data = await res.json();
      return data.schedules || [];
    } catch (_) {
      return [];
    }
  }

  function dailyBuckets(items, days) {
    const buckets = [];
    const now = new Date();
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(now);
      d.setDate(d.getDate() - i);
      const key = d.toISOString().slice(0, 10);
      buckets.push({ key, label: d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }), sent: 0 });
    }
    const map = Object.fromEntries(buckets.map((b) => [b.key, b]));
    items.forEach((item) => {
      const key = new Date(item.ts).toISOString().slice(0, 10);
      if (map[key]) map[key].sent += Number(item.sent) || 0;
    });
    return buckets;
  }

  function renderChart(buckets) {
    const box = $('analyticsChartBox');
    if (!box) return;
    const max = Math.max(1, ...buckets.map((b) => b.sent));
    if (!buckets.some((b) => b.sent > 0)) {
      box.innerHTML =
        '<div class="analytics-empty"><i class="fa-solid fa-chart-line"></i><p>No delivery data in this period. Run a broadcast to see trends.</p></div>';
      return;
    }
    const w = 600;
    const h = 180;
    const pad = { t: 12, r: 12, b: 28, l: 12 };
    const chartW = w - pad.l - pad.r;
    const chartH = h - pad.t - pad.b;
    const barW = chartW / buckets.length - 6;
    const bars = buckets
      .map((b, i) => {
        const bh = Math.max(4, (b.sent / max) * chartH);
        const x = pad.l + i * (chartW / buckets.length) + 3;
        const y = pad.t + chartH - bh;
        return `<rect class="pro-chart-bar" x="${x}" y="${y}" width="${barW}" height="${bh}" rx="4" data-sent="${b.sent}" data-label="${b.label}"><title>${b.label}: ${b.sent.toLocaleString()} sent</title></rect>`;
      })
      .join('');
    const labels = buckets
      .map((b, i) => {
        const x = pad.l + i * (chartW / buckets.length) + barW / 2 + 3;
        return `<text x="${x}" y="${h - 6}" fill="rgba(136,150,180,0.8)" font-size="9" text-anchor="middle" font-family="Plus Jakarta Sans,sans-serif">${b.label}</text>`;
      })
      .join('');
    box.innerHTML = `<svg class="pro-chart-svg" viewBox="0 0 ${w} ${h}" preserveAspectRatio="xMidYMid meet" role="img" aria-label="Delivery trend chart">
      <defs>
        <linearGradient id="proChartGrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#60a5fa"/>
          <stop offset="100%" stop-color="#0866ff"/>
        </linearGradient>
      </defs>
      ${bars}
      ${labels}
    </svg>`;
  }

  function modeLabel(mode) {
    if (mode === 'auto') return 'Auto All Pages';
    if (mode === 'scheduled') return 'Scheduled broadcast';
    return 'Manual broadcast';
  }

  function modeIcon(mode) {
    if (mode === 'auto') return 'fa-layer-group';
    if (mode === 'scheduled') return 'fa-calendar-check';
    return 'fa-bullhorn';
  }

  function renderHistory(items) {
    const list = $('analyticsHistoryList');
    if (!list) return;
    const sorted = [...items].sort((a, b) => new Date(b.ts) - new Date(a.ts)).slice(0, 25);
    if (!sorted.length) {
      list.innerHTML = '<div class="analytics-empty"><p>No broadcast history yet. Your sends will appear here.</p></div>';
      return;
    }
    list.innerHTML = sorted
      .map((item) => {
        const total = (Number(item.sent) || 0) + (Number(item.failed) || 0);
        const rate = total > 0 ? Math.round(((Number(item.sent) || 0) / total) * 100) : 0;
        const when = new Date(item.ts).toLocaleString(undefined, {
          month: 'short',
          day: 'numeric',
          hour: '2-digit',
          minute: '2-digit'
        });
        const iconClass =
          item.mode === 'auto' ? 'pro-history-item__icon--auto' : item.mode === 'scheduled' ? 'pro-history-item__icon--scheduled' : 'pro-history-item__icon--manual';
        return `<div class="pro-history-item">
          <div class="pro-history-item__icon ${iconClass}"><i class="fa-solid ${modeIcon(item.mode)}"></i></div>
          <div class="pro-history-item__body">
            <div class="pro-history-item__title">${item.label ? escapeHtml(item.label) : modeLabel(item.mode)}</div>
            <div class="pro-history-item__meta">
              <span>${when}</span>
              <span>${item.pages > 1 ? item.pages + ' pages' : '1 page'}</span>
            </div>
          </div>
          <div class="pro-history-item__stats">
            <div class="pro-history-item__sent">${(Number(item.sent) || 0).toLocaleString()} sent</div>
            <div class="pro-history-item__rate">${rate}% success</div>
          </div>
        </div>`;
      })
      .join('');
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function setKpis(agg) {
    const elSent = $('analyticsTotalSent');
    const elDel = $('analyticsDelivered');
    const elFail = $('analyticsFailed');
    const elRate = $('analyticsRate');
    if (elSent) elSent.textContent = agg.sent.toLocaleString();
    if (elDel) elDel.textContent = agg.sent.toLocaleString();
    if (elFail) elFail.textContent = agg.failed.toLocaleString();
    if (elRate) elRate.textContent = agg.rate + '%';
  }

  function setPeriodActive(days) {
    document.querySelectorAll('#view-analytics .period-btn').forEach((btn) => {
      const d = parseInt(btn.dataset.period, 10);
      btn.classList.toggle('active', d === days);
    });
  }

  async function refresh(periodDays) {
    if (periodDays) currentPeriod = periodDays;
    setPeriodActive(currentPeriod);

    const local = loadHistory();
    const schedules = await fetchSchedules();
    const fromSched = scheduleToHistory(schedules);
    const merged = [...local, ...fromSched];
    const filtered = filterByPeriod(merged, currentPeriod);
    const agg = aggregate(filtered);

    setKpis(agg);
    renderChart(dailyBuckets(filtered, Math.min(currentPeriod, 14)));
    renderHistory(filtered);
  }

  function bindPeriodButtons() {
    document.querySelectorAll('#view-analytics .period-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const days = parseInt(btn.dataset.period, 10) || 7;
        refresh(days);
      });
    });
  }

  function listenBroadcastEvents() {
    window.addEventListener('fbcast:analytics', (e) => {
      const d = e.detail;
      if (!d || d.name !== 'broadcast_complete') return;
      const p = d.props || {};
      recordBroadcast({
        mode: p.mode || 'manual',
        pageId: p.pageId,
        pages: p.pages || 1,
        total: p.total,
        sent: p.sent,
        failed: p.failed
      });
      if (global.appShell && global.appShell.getCurrentView() === 'analytics') refresh();
    });
  }

  function init() {
    bindPeriodButtons();
    listenBroadcastEvents();
    global.recordBroadcastHistory = recordBroadcast;
    global.refreshAnalyticsDashboard = refresh;
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  global.analyticsDashboard = { refresh, recordBroadcast, loadHistory };
})(window);
