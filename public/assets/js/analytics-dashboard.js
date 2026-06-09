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
    const w = 640;
    const h = 220;
    const pad = { t: 16, r: 16, b: 32, l: 44 };
    const chartW = w - pad.l - pad.r;
    const chartH = h - pad.t - pad.b;
    const barGap = 4;
    const barW = Math.max(8, chartW / buckets.length - barGap);
    const ySteps = 4;
    const gridLines = [];
    for (let i = 0; i <= ySteps; i++) {
      const y = pad.t + (chartH / ySteps) * i;
      const val = Math.round(max - (max / ySteps) * i);
      gridLines.push(
        `<line x1="${pad.l}" y1="${y}" x2="${w - pad.r}" y2="${y}" class="ad-chart-grid-line"/>` +
        `<text x="${pad.l - 8}" y="${y + 4}" text-anchor="end" class="ad-chart-axis">${val >= 1000 ? (val / 1000).toFixed(1) + 'k' : val}</text>`
      );
    }
    const bars = buckets
      .map((b, i) => {
        const bh = Math.max(b.sent > 0 ? 6 : 0, (b.sent / max) * chartH);
        const x = pad.l + i * (chartW / buckets.length) + barGap / 2;
        const y = pad.t + chartH - bh;
        return `<rect class="ad-chart-bar" x="${x}" y="${y}" width="${barW}" height="${bh}" rx="5"><title>${b.label}: ${b.sent.toLocaleString()} sent</title></rect>`;
      })
      .join('');
    const labels = buckets
      .map((b, i) => {
        if (buckets.length > 14 && i % 2 !== 0) return '';
        const x = pad.l + i * (chartW / buckets.length) + barW / 2 + barGap / 2;
        return `<text x="${x}" y="${h - 10}" text-anchor="middle" class="ad-chart-axis">${b.label}</text>`;
      })
      .join('');
    box.innerHTML = `<svg class="ad-chart-svg" viewBox="0 0 ${w} ${h}" preserveAspectRatio="xMidYMid meet" role="img" aria-label="Delivery trend chart">
      <defs>
        <linearGradient id="adChartGrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#60a5fa"/>
          <stop offset="100%" stop-color="#0866ff"/>
        </linearGradient>
      </defs>
      <g class="ad-chart-grid">${gridLines.join('')}</g>
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

  function pagePictureUrl(page) {
    if (!page) return '';
    if (typeof page.picture === 'string') return page.picture;
    if (page.picture && page.picture.data && page.picture.data.url) return page.picture.data.url;
    return '';
  }

  function resolvePageMeta(pageId, fallbackName) {
    const pages = global.loadedPages || window.loadedPages || [];
    const match = pageId ? pages.find((p) => String(p.id) === String(pageId)) : null;
    const name = match?.name || fallbackName || 'Unknown page';
    return { name, picture: pagePictureUrl(match) };
  }

  function topPages(items, limit) {
    const map = new Map();
    items.forEach((it) => {
      const key = it.pageId || it.label || 'unknown';
      const name =
        it.pageName ||
        it.label ||
        (it.pageId ? `Page ${String(it.pageId).slice(-4)}` : 'Manual');
      const cur = map.get(key) || {
        pageId: it.pageId || null,
        name,
        sent: 0,
        failed: 0,
        runs: 0
      };
      cur.sent += Number(it.sent) || 0;
      cur.failed += Number(it.failed) || 0;
      cur.runs += 1;
      map.set(key, cur);
    });
    return Array.from(map.values())
      .map((p) => {
        const meta = resolvePageMeta(p.pageId, p.name);
        const total = p.sent + p.failed;
        return {
          ...p,
          name: meta.name,
          picture: meta.picture,
          rate: total ? Math.round((p.sent / total) * 100) : 0
        };
      })
      .sort((a, b) => b.sent - a.sent)
      .slice(0, limit || 5);
  }

  function leaderRankIcon(i) {
    if (i === 0) return '<i class="fa-solid fa-crown ad-leader-medal ad-leader-medal--gold"></i>';
    if (i === 1) return '<i class="fa-solid fa-medal ad-leader-medal ad-leader-medal--silver"></i>';
    if (i === 2) return '<i class="fa-solid fa-medal ad-leader-medal ad-leader-medal--bronze"></i>';
    return String(i + 1);
  }

  function leaderAvatarHtml(p) {
    const initial = (p.name || '?').trim().charAt(0).toUpperCase();
    if (p.picture) {
      return `<div class="ad-leader-avatar ad-leader-avatar--img">
        <img src="${escapeHtml(p.picture)}" alt="" loading="lazy" onerror="this.remove();this.parentElement.classList.remove('ad-leader-avatar--img');this.parentElement.querySelector('.ad-leader-avatar-fb').style.display=''">
        <span class="ad-leader-avatar-fb" style="display:none">${escapeHtml(initial)}</span>
      </div>`;
    }
    return `<div class="ad-leader-avatar"><span class="ad-leader-avatar-fb">${escapeHtml(initial)}</span></div>`;
  }

  function renderTopPages(items) {
    const list = $('analyticsTopPagesList');
    const sub = $('analyticsTopPagesSub');
    const caption = $('analyticsTopPagesCaption');
    if (!list) return;
    const top = topPages(items, 5);
    if (!top.length || top[0].sent === 0) {
      list.innerHTML = `<div class="analytics-empty analytics-empty--leader">
        <i class="fa-solid fa-chart-simple" aria-hidden="true"></i>
        <p>No page-level data yet</p>
        <span class="analytics-empty-hint">Broadcast from connected pages to build rankings.</span>
      </div>`;
      if (sub) sub.textContent = '—';
      if (caption) caption.textContent = 'Ranked by messages delivered';
      return;
    }
    const totalSent = top.reduce((s, p) => s + p.sent, 0);
    const totalAll = top.reduce((s, p) => s + p.sent + p.failed, 0);
    if (sub) {
      const successPct = Math.round((totalSent / Math.max(1, totalAll)) * 100);
      sub.textContent = `${top.length} page${top.length === 1 ? '' : 's'} · ${totalSent.toLocaleString()} sent · ${successPct}% success`;
    }
    if (caption) caption.textContent = 'Ranked by messages delivered in this period';
    const max = Math.max(1, ...top.map((p) => p.sent));
    const thead = `<div class="ad-leader-thead" aria-hidden="true">
      <span class="ad-leader-th ad-leader-th--rank">#</span>
      <span class="ad-leader-th ad-leader-th--page">Page</span>
      <span class="ad-leader-th ad-leader-th--stat">Delivered</span>
      <span class="ad-leader-th ad-leader-th--stat">Success</span>
    </div>`;
    list.innerHTML = thead + top
      .map((p, i) => {
        const share = Math.round((p.sent / max) * 100);
        const rateCls = p.rate >= 90 ? 'ad-leader-rate--good' : p.rate >= 70 ? 'ad-leader-rate--ok' : 'ad-leader-rate--warn';
        const rankTier = i === 0 ? 'ad-leader-row--first' : i === 1 ? 'ad-leader-row--second' : i === 2 ? 'ad-leader-row--third' : '';
        return `<article class="ad-leader-row ${rankTier}" data-rank="${i + 1}">
          <div class="ad-leader-rank" aria-label="Rank ${i + 1}">${leaderRankIcon(i)}</div>
          ${leaderAvatarHtml(p)}
          <div class="ad-leader-info">
            <div class="ad-leader-name" title="${escapeHtml(p.name)}">${escapeHtml(p.name)}</div>
            <div class="ad-leader-meta">
              <span><i class="fa-solid fa-repeat"></i>${p.runs} campaign${p.runs === 1 ? '' : 's'}</span>
              ${p.failed > 0 ? `<span class="ad-leader-meta--warn"><i class="fa-solid fa-circle-xmark"></i>${p.failed.toLocaleString()} failed</span>` : ''}
            </div>
            <div class="ad-leader-bar" role="presentation" aria-hidden="true">
              <div class="ad-leader-bar-fill" style="width:${share}%"></div>
            </div>
          </div>
          <div class="ad-leader-stat ad-leader-stat--sent">
            <span class="ad-leader-stat-val">${p.sent.toLocaleString()}</span>
            <span class="ad-leader-stat-lbl">sent</span>
          </div>
          <div class="ad-leader-stat ad-leader-stat--rate">
            <span class="ad-leader-stat-val ${rateCls}">${p.rate}%</span>
            <span class="ad-leader-stat-lbl">success</span>
          </div>
        </article>`;
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

  function formatHour12(h) {
    const ampm = h >= 12 ? 'PM' : 'AM';
    const h12 = h % 12 || 12;
    return `${h12}:00 ${ampm}`;
  }

  function hourPeriod(h) {
    if (h >= 5 && h < 12) return 'Morning';
    if (h >= 12 && h < 17) return 'Afternoon';
    if (h >= 17 && h < 21) return 'Evening';
    return 'Night';
  }

  function renderHeatmap(items) {
    const grid = $('analyticsHeatmap');
    const peak = $('analyticsHeatPeak');
    const insight = $('analyticsHeatInsight');
    if (!grid) return;
    const buckets = buildHourBuckets(items);
    const max = Math.max(...buckets);
    if (max === 0) {
      grid.innerHTML = '<div class="analytics-empty ad-heatmap-empty"><i class="fa-solid fa-clock"></i><p>No timing data yet.</p><span class="analytics-empty-hint">Complete broadcasts to discover optimal send windows.</span></div>';
      if (peak) peak.textContent = '—';
      if (insight) insight.hidden = true;
      return;
    }
    const peakHour = buckets.indexOf(max);
    const sortedHours = buckets
      .map((v, h) => ({ h, v }))
      .filter((x) => x.v > 0)
      .sort((a, b) => b.v - a.v);
    const top3 = sortedHours.slice(0, 3);

    if (peak) {
      peak.innerHTML = `<i class="fa-solid fa-bolt"></i> Peak ${formatHour12(peakHour)}`;
    }
    if (insight) {
      insight.hidden = false;
      const period = hourPeriod(peakHour);
      const topList = top3
        .map((x) => `<span class="ad-heatmap-top-slot"><strong>${formatHour12(x.h)}</strong> · ${x.v.toLocaleString()} sent</span>`)
        .join('');
      insight.innerHTML =
        `<div class="ad-heatmap-insight-main">
          <i class="fa-solid fa-lightbulb"></i>
          <div>
            <strong>${period} performs best</strong>
            <span>Schedule campaigns around ${formatHour12(peakHour)} for highest delivery volume.</span>
          </div>
        </div>
        <div class="ad-heatmap-top-hours">${topList}</div>`;
    }

    grid.innerHTML = buckets
      .map((v, h) => {
        const lvl = heatLevel(v, max);
        const ratio = max > 0 ? v / max : 0;
        const pct = v > 0 ? Math.round(14 + Math.sqrt(ratio) * 76) : 6;
        const isPeak = h === peakHour && v > 0;
        const label = h % 6 === 0 ? formatHour12(h).replace(':00', '') : '';
        return `<div class="ad-heat-col${isPeak ? ' ad-heat-col--peak' : ''}" title="${formatHour12(h)} — ${v.toLocaleString()} messages sent">
          <div class="ad-heat-bar-wrap">
            <div class="ad-heat-bar ad-heat-${lvl}" style="height:${pct}%"></div>
          </div>
          <div class="ad-heat-label">${label}</div>
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

  function updatePeriodSummary(days, agg) {
    const el = $('analyticsPeriodSummary');
    if (!el) return;
    const end = new Date();
    const start = new Date();
    start.setDate(start.getDate() - days);
    const fmt = (d) => d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
    const total = (agg.sent + agg.failed).toLocaleString();
    el.innerHTML =
      '<i class="fa-solid fa-calendar-days"></i>' +
      '<span>Period: <strong>' + fmt(start) + ' – ' + fmt(end) + '</strong>' +
      ' · ' + days + ' days · <strong>' + total + '</strong> total attempts</span>';
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

    const view = $('view-analytics');
    view?.classList.add('analytics-loading');

    try {
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
    updatePeriodSummary(currentPeriod, agg);
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
    } finally {
      view?.classList.remove('analytics-loading');
    }
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
