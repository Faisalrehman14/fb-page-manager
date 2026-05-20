/**
 * FBCast Pro — Analytics dashboard (DB-backed history + schedules)
 */
(function (global) {
  'use strict';

  let currentPeriod = 7;

  function $(id) {
    return document.getElementById(id);
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
        pages: Array.isArray(s.pages) ? s.pages.length : 1,
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

  async function fetchDbHistory(days) {
    if (global.fbcastUserData && typeof global.fbcastUserData.fetchBroadcastHistory === 'function') {
      return global.fbcastUserData.fetchBroadcastHistory(days);
    }
    try {
      const res = await fetch(`/api/broadcasts/history?days=${days || 90}`, { credentials: 'same-origin' });
      if (!res.ok) return [];
      const data = await res.json();
      return data.history || [];
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
        return `<rect class="pro-chart-bar" x="${x}" y="${y}" width="${barW}" height="${bh}" rx="4"><title>${b.label}: ${b.sent.toLocaleString()} sent</title></rect>`;
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

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function renderHistory(items) {
    const list = $('analyticsHistoryList');
    if (!list) return;
    const sorted = [...items].sort((a, b) => new Date(b.ts) - new Date(a.ts)).slice(0, 25);
    if (!sorted.length) {
      list.innerHTML =
        '<div class="analytics-empty"><p>No broadcast history yet. Your sends are saved to your account.</p></div>';
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

  function fmtDelta(curr, prev, isRate) {
    if (!prev && !curr) return { text: '—', dir: 'flat' };
    if (!prev) return { text: '+ new', dir: 'up' };
    const diff = curr - prev;
    if (isRate) {
      const sign = diff >= 0 ? '+' : '';
      return { text: `${sign}${diff.toFixed(0)} pp`, dir: diff > 0 ? 'up' : diff < 0 ? 'down' : 'flat' };
    }
    const pct = Math.round((diff / prev) * 100);
    const sign = pct >= 0 ? '+' : '';
    return { text: `${sign}${pct}%`, dir: pct > 0 ? 'up' : pct < 0 ? 'down' : 'flat' };
  }

  function setDelta(id, curr, prev, isRate, invertGood) {
    const el = $(id);
    if (!el) return;
    const d = fmtDelta(curr, prev, isRate);
    let cls = 'akpi-delta--flat';
    if (d.dir === 'up') cls = invertGood ? 'akpi-delta--bad' : 'akpi-delta--good';
    else if (d.dir === 'down') cls = invertGood ? 'akpi-delta--good' : 'akpi-delta--bad';
    el.className = 'akpi-delta ' + cls;
    const arrow = d.dir === 'up' ? '▲' : d.dir === 'down' ? '▼' : '–';
    el.innerHTML = `<span class="akpi-delta-arrow">${arrow}</span> ${d.text} <span class="akpi-delta-lbl">vs prev</span>`;
  }

  function topPages(items, limit) {
    const map = new Map();
    items.forEach((it) => {
      const key = it.pageId || it.label || 'unknown';
      const name = it.pageName || it.label || (it.pageId ? `Page ${String(it.pageId).slice(-4)}` : 'Manual');
      const cur = map.get(key) || { name, sent: 0, failed: 0, runs: 0 };
      cur.sent += Number(it.sent) || 0;
      cur.failed += Number(it.failed) || 0;
      cur.runs += 1;
      map.set(key, cur);
    });
    return Array.from(map.values())
      .map((p) => {
        const total = p.sent + p.failed;
        return { ...p, rate: total ? Math.round((p.sent / total) * 100) : 0 };
      })
      .sort((a, b) => b.sent - a.sent)
      .slice(0, limit || 5);
  }

  function renderTopPages(items) {
    const list = $('analyticsTopPagesList');
    const sub = $('analyticsTopPagesSub');
    if (!list) return;
    const top = topPages(items, 5);
    if (!top.length || top[0].sent === 0) {
      list.innerHTML = '<div class="analytics-empty"><p>No page-level data yet.</p></div>';
      if (sub) sub.textContent = '—';
      return;
    }
    if (sub) sub.textContent = `${top.length} active`;
    const max = Math.max(1, ...top.map((p) => p.sent));
    list.innerHTML = top
      .map((p, i) => {
        const pct = Math.round((p.sent / max) * 100);
        const initial = (p.name || '?').trim().charAt(0).toUpperCase();
        return `<div class="leader-row">
          <div class="leader-rank">${i + 1}</div>
          <div class="leader-avatar">${escapeHtml(initial)}</div>
          <div class="leader-body">
            <div class="leader-name">${escapeHtml(p.name)}</div>
            <div class="leader-meta">${p.sent.toLocaleString()} sent · ${p.runs} run${p.runs === 1 ? '' : 's'} · ${p.rate}% rate</div>
            <div class="leader-bar"><div class="leader-bar-fill" style="width:${pct}%"></div></div>
          </div>
        </div>`;
      })
      .join('');
  }

  function buildHourBuckets(items) {
    const buckets = new Array(24).fill(0);
    items.forEach((it) => {
      const d = new Date(it.ts);
      if (isNaN(d.getTime())) return;
      buckets[d.getHours()] += Number(it.sent) || 0;
    });
    return buckets;
  }

  function heatLevel(v, max) {
    if (max <= 0) return 0;
    const r = v / max;
    if (r === 0) return 0;
    if (r < 0.2) return 1;
    if (r < 0.4) return 2;
    if (r < 0.6) return 3;
    if (r < 0.8) return 4;
    return 5;
  }

  function renderHeatmap(items) {
    const grid = $('analyticsHeatmap');
    const peak = $('analyticsHeatPeak');
    if (!grid) return;
    const buckets = buildHourBuckets(items);
    const max = Math.max(...buckets);
    if (max === 0) {
      grid.innerHTML = '<div class="analytics-empty"><p>No timing data yet.</p></div>';
      if (peak) peak.textContent = '—';
      return;
    }
    const peakHour = buckets.indexOf(max);
    if (peak) {
      const ampm = peakHour >= 12 ? 'PM' : 'AM';
      const h12 = peakHour % 12 || 12;
      peak.textContent = `Peak: ${h12}:00 ${ampm}`;
    }
    grid.innerHTML = buckets
      .map((v, h) => {
        const lvl = heatLevel(v, max);
        const ampm = h >= 12 ? 'PM' : 'AM';
        const h12 = h % 12 || 12;
        const showLabel = h % 3 === 0;
        return `<div class="heat-col" title="${h12}:00 ${ampm} — ${v.toLocaleString()} sent">
          <div class="heat-cell heat-${lvl}"></div>
          <div class="heat-label">${showLabel ? h12 + (h === 0 ? 'a' : ampm === 'PM' ? 'p' : 'a') : ''}</div>
        </div>`;
      })
      .join('');
  }

  function renderBreakdown(items) {
    const sub = $('analyticsBreakdownSub');
    const map = { manual: 0, auto: 0, scheduled: 0 };
    items.forEach((it) => {
      const m = (it.mode || 'manual').toLowerCase();
      if (map[m] === undefined) return;
      map[m] += Number(it.sent) || 0;
    });
    const total = map.manual + map.auto + map.scheduled;
    const pct = (n) => (total > 0 ? Math.round((n / total) * 100) : 0);
    const setBar = (fillId, valId, n) => {
      const f = $(fillId);
      const v = $(valId);
      if (f) f.style.width = pct(n) + '%';
      if (v) v.textContent = `${n.toLocaleString()} (${pct(n)}%)`;
    };
    setBar('brManualFill', 'brManualVal', map.manual);
    setBar('brAutoFill', 'brAutoVal', map.auto);
    setBar('brSchedFill', 'brSchedVal', map.scheduled);
    if (sub) sub.textContent = total > 0 ? `${total.toLocaleString()} total` : '—';
  }

  function renderChartMeta(items, days) {
    const el = $('analyticsChartMeta');
    if (!el) return;
    if (!items.length) {
      el.textContent = '';
      return;
    }
    const total = items.reduce((s, it) => s + (Number(it.sent) || 0), 0);
    const avg = Math.round(total / Math.min(days, 14));
    el.textContent = `~${avg.toLocaleString()} / day avg`;
  }

  function exportCsv(items) {
    if (!items.length) {
      alert('Nothing to export — no broadcast data yet.');
      return;
    }
    const headers = ['timestamp', 'mode', 'page_id', 'pages', 'sent', 'failed', 'success_rate', 'label'];
    const rows = items.map((it) => {
      const total = (Number(it.sent) || 0) + (Number(it.failed) || 0);
      const rate = total > 0 ? Math.round(((Number(it.sent) || 0) / total) * 100) : 0;
      return [
        new Date(it.ts).toISOString(),
        it.mode || 'manual',
        it.pageId || '',
        it.pages || 1,
        Number(it.sent) || 0,
        Number(it.failed) || 0,
        rate + '%',
        (it.label || '').replace(/[\r\n,]+/g, ' ').slice(0, 200)
      ];
    });
    const csv = [headers, ...rows]
      .map((row) => row.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(','))
      .join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `fbcast-analytics-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      URL.revokeObjectURL(url);
      a.remove();
    }, 0);
  }

  function setPeriodActive(days) {
    document.querySelectorAll('#view-analytics .period-btn').forEach((btn) => {
      const d = parseInt(btn.dataset.period, 10);
      btn.classList.toggle('active', d === days);
    });
  }

  function filterByRange(items, fromMs, toMs) {
    return items.filter((i) => {
      const t = new Date(i.ts).getTime();
      return t >= fromMs && t < toMs;
    });
  }

  let lastFiltered = [];

  async function refresh(periodDays) {
    if (periodDays) currentPeriod = periodDays;
    setPeriodActive(currentPeriod);

    const fetchDays = currentPeriod * 2;
    const [dbHistory, schedules] = await Promise.all([
      fetchDbHistory(fetchDays),
      fetchSchedules()
    ]);
    const fromSched = scheduleToHistory(schedules);
    const merged = [...dbHistory, ...fromSched];

    const now = Date.now();
    const oneDay = 86400000;
    const currStart = now - currentPeriod * oneDay;
    const prevStart = now - currentPeriod * 2 * oneDay;

    const filtered = filterByRange(merged, currStart, now);
    const previous = filterByRange(merged, prevStart, currStart);
    lastFiltered = filtered;

    const agg = aggregate(filtered);
    const aggPrev = aggregate(previous);

    setKpis(agg);
    setDelta('analyticsTotalSentDelta', agg.sent, aggPrev.sent, false, false);
    setDelta('analyticsDeliveredDelta', agg.sent, aggPrev.sent, false, false);
    setDelta('analyticsFailedDelta', agg.failed, aggPrev.failed, false, true);
    setDelta('analyticsRateDelta', agg.rate, aggPrev.rate, true, false);

    renderChart(dailyBuckets(filtered, Math.min(currentPeriod, 14)));
    renderChartMeta(filtered, currentPeriod);
    renderTopPages(filtered);
    renderHeatmap(filtered);
    renderBreakdown(filtered);
    renderHistory(filtered);
  }

  function bindPeriodButtons() {
    document.querySelectorAll('#view-analytics .period-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const days = parseInt(btn.dataset.period, 10) || 7;
        refresh(days);
      });
    });

    const refreshBtn = $('analyticsRefreshBtn');
    if (refreshBtn) {
      refreshBtn.addEventListener('click', () => {
        refreshBtn.classList.add('is-spinning');
        refresh().finally(() => setTimeout(() => refreshBtn.classList.remove('is-spinning'), 400));
      });
    }
    const exportBtn = $('analyticsExportBtn');
    if (exportBtn) {
      exportBtn.addEventListener('click', () => exportCsv(lastFiltered));
    }
  }

  function recordBroadcast(entry) {
    if (global.fbcastUserData && typeof global.fbcastUserData.recordBroadcast === 'function') {
      global.fbcastUserData.recordBroadcast(entry);
    }
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

  global.analyticsDashboard = { refresh, recordBroadcast };
})(window);
