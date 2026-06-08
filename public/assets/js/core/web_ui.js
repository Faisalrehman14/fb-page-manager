// web_ui.js — Web/localhost UI controller for Pro Facebook Page Messenger
// Version: 2.1.0 - Production UI improvements (2026-04-15)
// Requires fb_api.js to be loaded first. Calls fb_api.js functions directly.

const $ = (id) => document.getElementById(id);
const pct = (n) => `${Math.round((n || 0) * 100)}%`;
const uiTrackEvent = (name, props) => { if (typeof window.trackEvent === 'function') window.trackEvent(name, props || {}); };

function escHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

let sendStartTime = null;
let allRecipients = [];
let recipientsPageId = null;
let isManualBroadcastRunning = false;
let activeBroadcastPageId = null;

function riskClass(level) {
  if (level === 'low') return 'intel-good';
  if (level === 'medium') return 'intel-warn';
  if (level === 'high') return 'intel-bad';
  return 'intel-neutral';
}

function setIntelValue(id, text, cls) {
  const el = $(id);
  if (!el) return;
  el.textContent = text;
  el.classList.remove('intel-good', 'intel-warn', 'intel-bad', 'intel-neutral');
  if (cls) el.classList.add(cls);
}

function formatEta(ms) {
  if (!ms || ms < 0) return '';
  const s = Math.round(ms / 1000);
  if (s < 60) return `~${s}s left`;
  const m = Math.floor(s / 60), rem = s % 60;
  return rem > 0 ? `~${m}m ${rem}s left` : `~${m}m left`;
}

function updateCampaignIntel() {
  const pageId = $('pageSelect')?.value || '';
  const message = ($('messageText')?.value || '').trim();
  const delay = Math.max(25, parseInt($('delayMs')?.value, 10) || 400);
  const adviceEl = $('intelAdvice');

  const hasLoadedAudience = !!allRecipients.length && recipientsPageId === pageId;
  const audienceCount = hasLoadedAudience ? allRecipients.length : 0;
  const audienceLabel = hasLoadedAudience
    ? `${audienceCount.toLocaleString()} loaded`
    : (pageId ? 'Auto-load on start' : 'Select page first');
  setIntelValue('intelAudience', audienceLabel);

  let pace = 'Balanced';
  let paceRisk = 'low';
  if (delay < 200) { pace = 'Aggressive'; paceRisk = 'high'; }
  else if (delay < 800) { pace = 'Balanced'; paceRisk = 'medium'; }
  else { pace = 'Safe'; paceRisk = 'low'; }
  setIntelValue('intelPace', pace, riskClass(paceRisk));

  const urlCount = (message.match(/https?:\/\/|www\./gi) || []).length;
  const exclamations = (message.match(/!/g) || []).length;
  const upperChars = (message.match(/[A-Z]/g) || []).length;
  const letterChars = (message.match(/[A-Za-z]/g) || []).length;
  const upperRatio = letterChars > 0 ? (upperChars / letterChars) : 0;
  const spamTerms = /(free money|guaranteed|urgent offer|click now|limited time)/i.test(message);

  let riskPoints = 0;
  if (message.length > 900) riskPoints += 1;
  if (urlCount > 1) riskPoints += 1;
  if (exclamations >= 4) riskPoints += 1;
  if (upperRatio > 0.45 && message.length > 30) riskPoints += 1;
  if (delay < 200) riskPoints += 1;
  if (spamTerms) riskPoints += 1;

  let riskLabel = 'Low';
  let riskLevel = 'low';
  if (riskPoints >= 4) { riskLabel = 'High'; riskLevel = 'high'; }
  else if (riskPoints >= 2) { riskLabel = 'Medium'; riskLevel = 'medium'; }
  setIntelValue('intelRisk', riskLabel, riskClass(riskLevel));

  const etaText = audienceCount > 0 ? formatEta(audienceCount * delay) : 'After load';
  setIntelValue('intelEta', etaText || 'After load');

  if (!pageId) {
    if (adviceEl) adviceEl.textContent = 'Select a page to enable broadcast readiness checks.';
    return;
  }
  if (!message) {
    if (adviceEl) adviceEl.textContent = 'Write a message to preview risk level and estimated campaign speed.';
    return;
  }

  const messages = [];
  if (message.length < 15) messages.push('Message is very short; add context for better trust.');
  if (urlCount > 1) messages.push('Multiple links detected; fewer links usually perform better.');
  if (riskLevel === 'high') messages.push('High risk detected; increase delay and soften wording.');
  if (paceRisk === 'high') messages.push('Aggressive pace can trigger rate limits on large audiences.');
  if (!messages.length) messages.push('Looks healthy. You are ready to start this campaign.');
  if (adviceEl) adviceEl.textContent = messages[0];
}

function updateEta(done, total, delayMs) {
  const el = $('etaText');
  if (!el) return;
  if (!done || !total || done >= total) { el.textContent = ''; return; }
  const remaining = total - done;
  const elapsedMs = Date.now() - (sendStartTime || Date.now());
  const msPerItem = elapsedMs / done;
  const eta = remaining * (msPerItem || delayMs);
  el.textContent = formatEta(eta);
}

function setLoading(btn, loading) {
  if (!btn) return;
  btn.disabled = !!loading;
  btn.classList.toggle('is-loading', !!loading);
  /* Never add global class "loading" — inbox.css defines .loading as a full panel (breaks sidebar btn). */
}

async function runWithRetry(action, options = {}) {
  const maxAttempts = Math.max(1, Number(options.maxAttempts || 2));
  const label = options.label || 'request';
  let lastErr = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await action(attempt);
    } catch (err) {
      lastErr = err;
      const errorId = (typeof window.reportClientError === 'function')
        ? window.reportClientError(err, { source: 'web_ui', label, attempt, maxAttempts })
        : null;
      if (attempt < maxAttempts) {
        showStatus(`${label} failed, retrying… (${attempt}/${maxAttempts - 1})`, 'warning');
        await new Promise((resolve) => setTimeout(resolve, 350 * attempt));
        continue;
      }
      if (errorId) showStatus(`${label} failed (${errorId}).`, 'error');
      else showStatus(`${label} failed.`, 'error');
    }
  }
  throw lastErr || new Error(label + ' failed');
}

async function loadPagesFromFacebook(options = {}) {
  const silent = !!options.silent;
  const pageCards = $('pageCards');
  const scrollEl = pageCards?.closest('.sidebar-pages');
  if (pageCards) pageCards.classList.add('pages-syncing');
  try {
    const pages = await runWithRetry(async () => fetchUserPages(), { label: 'Loading pages', maxAttempts: 2 });
    renderPages(pages || [], { scrollEl });
    window.dispatchEvent(new CustomEvent('fbc:pages-ready', { detail: { count: (pages || []).length } }));
    if (typeof window.updateHomeViewStats === 'function') window.updateHomeViewStats();
    uiTrackEvent('pages_refresh_success', { count: (pages || []).length, source: silent ? 'auto' : 'manual' });
    if (!silent && typeof window.showToast === 'function') {
      if ((pages || []).length === 0) {
        window.showToast('No pages found. Check Facebook permissions.', 'warning');
      } else {
        window.showToast(`${(pages || []).length} page(s) synced.`, 'success');
      }
    }
    return pages || [];
  } finally {
    if (pageCards) pageCards.classList.remove('pages-syncing');
  }
}

let statusTimer;
let recipientsStatusTimer;

function ensureRecipientsStatusCard() {
  const recipients = document.getElementById('recipients');
  if (!recipients) return null;
  let card = document.getElementById('recipientsStatusCard');
  if (!card) {
    card = document.createElement('div');
    card.id = 'recipientsStatusCard';
    card.className = 'rec-status-card';
    card.setAttribute('role', 'status');
    card.setAttribute('aria-live', 'polite');
    recipients.prepend(card);
  }
  return card;
}

function showStatus(msg, type = 'info', count = null) {
  const sb = document.getElementById('statusBar');
  const inlineCard = ensureRecipientsStatusCard();
  if (!sb && !inlineCard) return;
  clearTimeout(statusTimer);
  clearTimeout(recipientsStatusTimer);
  
  const icons = {
    success: 'fa-circle-check',
    error: 'fa-circle-xmark',
    warning: 'fa-triangle-exclamation',
    info: 'fa-circle-info'
  };
  const icon = icons[type] || icons.info;
  
  let html = `<i class="fa-solid ${icon}"></i><span>${String(msg).replace(/</g,'&lt;').replace(/>/g,'&gt;')}</span>`;
  if (count !== null) {
    html += `<span class="sb-count">${count.toLocaleString()} fetched</span>`;
  }

  if (sb) {
    sb.innerHTML = html;
    sb.style.display = 'flex';
    sb.className = `sb-${type}`;
    statusTimer = setTimeout(() => { sb.className = ''; sb.style.display = 'none'; }, 5000);
  }

  if (inlineCard) {
    inlineCard.innerHTML = html;
    inlineCard.className = `rec-status-card rs-${type}`;
    recipientsStatusTimer = setTimeout(() => {
      inlineCard.className = 'rec-status-card';
    }, 5000);
  }
}

function setLoginOnline() {
  const ls = document.getElementById('loginStatus');
  if (ls) ls.classList.add('online');
  const lt = document.getElementById('loginStatusText');
  if (lt) lt.textContent = 'Connected';
}

function updateSendHint() {
  const sendHint = $('sendHint');
  const pageSelect = $('pageSelect');
  if (!sendHint) return;
  const pageId = pageSelect?.value;
  if (!pageId) { sendHint.textContent = 'Select a page first'; return; }
  if (!allRecipients.length || recipientsPageId !== pageId) {
    sendHint.textContent = 'Ready to start. Recipients will load automatically.';
    updateCampaignIntel();
    return;
  }
  const filtered = getFilteredRecipients().length;
  sendHint.textContent = `Will send to ${filtered} recipient${filtered !== 1 ? 's' : ''}`;
  updateCampaignIntel();
}

function pagePictureUrl(p) {
  if (!p) return '';
  if (typeof p.picture === 'string') return p.picture;
  if (p.picture && p.picture.data && p.picture.data.url) return p.picture.data.url;
  return '';
}

function renderPages(pages, opts) {
  const container = $('pageCards');
  const select = $('pageSelect');
  if (!container || !select) return;

  const previousPageId = select.value || null;
  const scrollEl = (opts && opts.scrollEl) || container.closest('.sidebar-pages') || container;
  const scrollTop = scrollEl.scrollTop;

  container.innerHTML = '';
  select.innerHTML = '';

  const pgCount = document.getElementById('sidebarPageCount');
  if (!pages || pages.length === 0) {
    const sched = document.body.classList.contains('shell-scheduling');
    const emptyIcon = sched ? 'fa-solid fa-clock' : 'fa-brands fa-facebook';
    const emptyMsg = sched
      ? 'No Facebook pages yet. Sync your account to start scheduling broadcasts.'
      : 'No pages found.';
    container.innerHTML = `<div class="pages-empty"><i class="${emptyIcon}"></i><p>${emptyMsg}</p></div>`;
    if (pgCount) pgCount.hidden = true;
    window.loadedPages = [];
    if (typeof svUpdateSidebarPageCount === 'function') svUpdateSidebarPageCount();
    return;
  }
  if (pgCount) { pgCount.textContent = pages.length; pgCount.hidden = false; }
  window.loadedPages = pages;

  pages.forEach(p => {
    const opt = document.createElement('option');
    opt.value = p.id;
    select.appendChild(opt);

    const picUrl = pagePictureUrl(p);
    const initial = (p.name || '?').charAt(0).toUpperCase();
    const card = document.createElement('div');
    card.className = 'page-card';
    card.dataset.id = p.id;
    card.innerHTML = `
      ${picUrl
        ? `<img class="page-avatar" src="${escHtml(picUrl)}" alt="">`
        : ''}
      <div class="page-avatar-fallback" style="${picUrl ? 'display:none' : ''}">${escHtml(initial)}</div>
      <div class="page-info">
        <div class="page-name">${escHtml(p.name)}</div>
        ${p.category ? `<div class="page-category">${escHtml(p.category)}</div>` : ''}
      </div>
      <div class="page-indicator"></div>
    `;
    card.addEventListener('click', () => {
      if (document.body.classList.contains('shell-scheduling')) {
        card.classList.toggle('sched-selected');
        if (typeof svUpdateSidebarPageCount === 'function') svUpdateSidebarPageCount();
        return;
      }
      if (document.body.classList.contains('shell-multi-broadcast')) {
        card.classList.toggle('multi-selected');
        if (typeof rebuildMultiPageMessages === 'function') rebuildMultiPageMessages();
        if (typeof updateMultiPageCount === 'function') updateMultiPageCount();
        return;
      }
      if (isManualBroadcastRunning && activeBroadcastPageId && p.id !== activeBroadcastPageId) {
        showStatus('Broadcast is running on another page. Pause/Stop first.', 'warning');
        return;
      }
      const previousPageId = select.value || null;
      container.querySelectorAll('.page-card').forEach(c => c.classList.remove('selected'));
      card.classList.add('selected');
      select.value = p.id;
      window.currentPageToken = p.access_token || '';
      if (previousPageId && previousPageId !== p.id) {
        allRecipients = [];
        recipientsPageId = null;
        window.allRecipients = allRecipients;
        renderRecipients();
        updateStats();
      }
      updateSendHint();
      updateCampaignIntel();
    });
    const imgEl = card.querySelector('.page-avatar');
    const fbEl = card.querySelector('.page-avatar-fallback');
    if (imgEl && fbEl) {
      imgEl.addEventListener('error', () => {
        imgEl.style.display = 'none';
        fbEl.style.display = 'flex';
      });
    }
    container.appendChild(card);
  });
  const targetId = (previousPageId && pages.some(p => p.id === previousPageId))
    ? previousPageId
    : pages[0].id;
  const targetCard = container.querySelector('.page-card[data-id="' + targetId + '"]');
  if (targetCard) {
    targetCard.classList.add('selected');
    select.value = targetId;
    window.currentPageToken = (pages.find(p => p.id === targetId) || {}).access_token || '';
    updateSendHint();
    updateCampaignIntel();
  }
  scrollEl.scrollTop = scrollTop;
  if (document.body.classList.contains('shell-scheduling') && typeof svInitSchedulingPageSelection === 'function') {
    svInitSchedulingPageSelection();
  }
}

function svGetSchedulePagesFromSidebar() {
  const cards = Array.from(document.querySelectorAll('#pageCards .page-card.sched-selected'));
  const pages = window.loadedPages || [];
  return cards.map(card => {
    const p = pages.find(x => x.id === card.dataset.id);
    if (!p) return null;
    return { id: p.id, name: p.name || p.id, token: p.access_token || '' };
  }).filter(Boolean);
}

window.svUpdateSidebarPageCount = function () {
  const n = document.querySelectorAll('#pageCards .page-card.sched-selected').length;
  const total = (window.loadedPages || []).length;
  let label;
  if (n === 0) {
    label = total > 0 ? 'No pages selected' : '0 selected';
  } else if (n === total && total > 0) {
    label = `All ${n} pages selected`;
  } else {
    label = `${n} of ${total} selected`;
  }

  const composeEl = $('svSidebarPageCount');
  if (composeEl) composeEl.textContent = label;

  const sidebarEl = $('sidebarSchedSelection');
  if (sidebarEl) sidebarEl.textContent = label;

  const hintEl = $('sidebarSchedHint');
  if (hintEl) {
    if (total === 0) {
      hintEl.textContent = 'Connect Facebook to load your pages';
    } else if (n === 0) {
      hintEl.textContent = 'Click pages below to include in this broadcast';
    } else if (n === total) {
      hintEl.textContent = 'All pages selected — ready to schedule';
    } else {
      hintEl.textContent = 'Selected pages will receive this broadcast';
    }
  }
};

window.svInitSchedulingPageSelection = function () {
  document.querySelectorAll('#pageCards .page-card.sched-selected').forEach(c => {
    c.classList.remove('sched-selected');
  });
  svUpdateSidebarPageCount();
};

window.svClearSchedulingPageSelection = function () {
  document.querySelectorAll('#pageCards .page-card.sched-selected').forEach(c => {
    c.classList.remove('sched-selected');
  });
  svUpdateSidebarPageCount();
};

function getFilteredRecipients() {
  const filter = $('recipientFilter')?.value || 'all';
  if (filter === 'all') return allRecipients;
  if (filter.startsWith('status:')) {
    const s = filter.slice(7);
    return allRecipients.filter(r => r.status === s);
  }
  if (filter.startsWith('label:')) {
    const lbl = filter.slice(6);
    return allRecipients.filter(r => (r.labels || []).includes(lbl));
  }
  return allRecipients;
}

function buildFilterOptions(labelMap) {
  const rf = $('recipientFilter');
  if (!rf) return;
  rf.querySelectorAll('[data-label]').forEach(o => o.remove());
  const allLabels = new Set();
  Object.values(labelMap || {}).forEach(labels => labels.forEach(l => allLabels.add(l)));
  if (allLabels.size === 0) return;
  const sep = document.createElement('option');
  sep.disabled = true; sep.textContent = '── Labels ──'; sep.dataset.label = '1';
  rf.appendChild(sep);
  allLabels.forEach(label => {
    const opt = document.createElement('option');
    opt.value = `label:${label}`; opt.textContent = label.charAt(0).toUpperCase() + label.slice(1); opt.dataset.label = '1';
    rf.appendChild(opt);
  });
}

function renderRecipients() {
  const list = getFilteredRecipients();
  const rc = $('recipientCount');
  const rd = $('recipients');
  if (rc) rc.textContent = list.length;
  if (!rd) return;
  const statusCard = document.getElementById('recipientsStatusCard');
  rd.innerHTML = '';
  if (statusCard) rd.prepend(statusCard);

  if (list.length === 0) {
    rd.innerHTML = `<div class="table-empty"><div class="table-empty-icon">${allRecipients.length === 0 ? '💬' : '🔍'}</div><div>${allRecipients.length === 0 ? 'No recipients yet.<br>Press Start Broadcast to load and send.' : 'No recipients match the current filter.'}</div></div>`;
    return;
  }

  list.forEach(r => {
    const row = document.createElement('div');
    row.className = 'table-row';
    row.dataset.id = r.id;
    const statusClass = {
      sent: 'badge-sent', failed: 'badge-failed', pending: 'badge-pending', cancelled: 'badge-cancelled'
    }[r.status] || 'badge-pending';
    const labelBadges = (r.labels || []).slice(0, 2).map(l => `<span class="badge badge-label" title="${escHtml(l)}">${escHtml(l)}</span>`).join('');
    const labelsSummary = (r.labels || []).length > 2 ? `<span class="badge badge-label">+${(r.labels || []).length - 2}</span>` : '';
    row.innerHTML = `<div class="mono truncate">${escHtml(r.id)}</div><div><span class="badge ${statusClass}">${escHtml(r.status)}</span>${labelBadges}${labelsSummary}</div><div class="err" title="${escHtml(r.error || '')}">${escHtml(r.error || '')}</div>`;
    rd.appendChild(row);
  });
  updateSendHint();
  updateCampaignIntel();
}

function updateStats() {
  const total = allRecipients.length;
  const sent = allRecipients.filter(r => r.status === 'sent').length;
  const failed = allRecipients.filter(r => r.status === 'failed').length;
  const pending = allRecipients.filter(r => r.status === 'pending').length;
  const st = $('statTotal'), ss = $('statSent'), sf = $('statFailed'), pb = $('progressBar'), pp = $('progressPct'), rc = $('recipientCount');
  if (st) st.textContent = total;
  if (ss) ss.textContent = sent;
  if (sf) sf.textContent = failed;
  const ratio = total ? (sent + failed) / total : 0;
  if (pb) pb.style.width = pct(ratio);
  if (pp) pp.textContent = pct(ratio);
  if (rc) rc.textContent = getFilteredRecipients().length;
  // sync mini stats in col 3
  const ms = $('miniStatTotal'), mss = $('miniStatSent'), msf = $('miniStatFailed');
  if (ms) ms.textContent = total;
  if (mss) mss.textContent = sent;
  if (msf) msf.textContent = failed;
  // enable retry button when there are failed messages
  const retryBtn = $('btnRetryFailed');
  if (retryBtn) retryBtn.disabled = failed === 0;
  // update quick stats
  const qsSr = $('qsSuccessRate'), qsSp = $('qsSpeed'), qsPd = $('qsPending'), qsAd = $('qsAudience');
  if (qsSr) qsSr.textContent = total > 0 ? Math.round((sent / total) * 100) + '%' : '0%';
  if (qsPd) qsPd.textContent = pending.toLocaleString();
  if (qsAd) qsAd.textContent = total.toLocaleString();
  if (qsSp) {
    const recentWindow = Date.now() - 60000;
    const recentSent = allRecipients.filter(r => r.sentAt && r.sentAt > recentWindow).length;
    qsSp.textContent = recentSent + '/min';
  }
  const qaRetry = $('qaRetryAll'), qaExport = $('qaExport');
  if (qaRetry) qaRetry.disabled = failed === 0;
  if (qaExport) qaExport.disabled = (sent + failed) === 0;
  window.dispatchEvent(new CustomEvent('fbc:broadcast-progress'));
}

function setManualBroadcastButtons(state) {
  const btnStart = $('btnStart');
  const btnMultiStart = $('btnMultiStart');
  const btnPause = $('btnPause');
  const btnResume = $('btnResume');
  const btnStop = $('btnStop');
  const startBtn = document.body.classList.contains('shell-multi-broadcast') ? btnMultiStart : btnStart;
  if (!startBtn && !btnPause) return;
  const idle = state === 'idle';
  const running = state === 'running';
  const paused = state === 'paused';
  if (btnStart) {
    btnStart.disabled = !idle || document.body.classList.contains('shell-multi-broadcast');
    if (idle) setLoading(btnStart, false);
  }
  if (btnMultiStart) {
    const inMulti = document.body.classList.contains('shell-multi-broadcast');
    if (inMulti && typeof window.updateMultiStartButton === 'function') {
      window.updateMultiStartButton();
    } else {
      btnMultiStart.disabled = true;
    }
  }
  if (btnPause) btnPause.disabled = !running;
  if (btnResume) btnResume.disabled = !paused;
  if (btnStop) btnStop.disabled = idle;
}

function finishManualBroadcast(summary) {
  const reason = (summary && summary.reason) || 'completed';
  isManualBroadcastRunning = false;
  activeBroadcastPageId = null;
  $('progressBar')?.classList.remove('progress-bar--active');
  setLoading(btnStart, false);
  if ($('etaText')) $('etaText').textContent = '';
  setManualBroadcastButtons('idle');

  if (reason === 'stopped') {
    allRecipients.forEach(r => {
      if (r.status === 'pending') {
        r.status = 'cancelled';
        r.error = 'Stopped by user';
      }
    });
    renderRecipients();
    updateStats();
    const sent = summary?.sent ?? allRecipients.filter(r => r.status === 'sent').length;
    const cancelled = summary?.cancelled ?? allRecipients.filter(r => r.status === 'cancelled').length;
    showStatus(`Stopped. ${sent.toLocaleString()} sent, ${cancelled.toLocaleString()} cancelled.`, 'warning');
    return;
  }

  if (reason === 'quota') {
    updateStats();
    showStatus('Broadcast stopped: message quota exceeded.', 'error');
    return;
  }

  const sent = summary?.sent ?? allRecipients.filter(r => r.status === 'sent').length;
  const failed = summary?.failed ?? allRecipients.filter(r => r.status === 'failed').length;
  showStatus('All messages processed.', 'success');
  if (typeof window.maybeNotifyBroadcast === 'function') {
    window.maybeNotifyBroadcast('complete', `Broadcast complete: ${sent.toLocaleString()} sent${failed ? ', ' + failed + ' failed' : ''}.`);
  }
}

function updateRecipientRow(item) {
  const r = allRecipients.find(r => r.id === item.id);
  if (r) { r.status = item.status; r.error = item.error || ''; if(item.status==='sent') r.sentAt = Date.now(); }
  const row = $('recipients')?.querySelector(`[data-id="${item.id}"]`);
  if (!row) return;
  const badge = row.querySelector('.badge');
  const error = row.querySelector('.err');
  const statusClass = {
    sent: 'badge-sent', failed: 'badge-failed', pending: 'badge-pending', cancelled: 'badge-cancelled'
  }[item.status] || 'badge-pending';
  if (badge) { badge.className = `badge ${statusClass}`; badge.textContent = item.status; }
  if (error) { error.textContent = item.error || ''; error.title = item.error || ''; }
}

function initFromStorage() {
  try {
    const queue = JSON.parse(localStorage.getItem('send_queue') || '[]');
    if (queue.length > 0) {
      allRecipients = queue;
      recipientsPageId = null;
      window.allRecipients = queue; // Update global reference
      renderRecipients();
      updateStats();
    }
  } catch (_) {}
}

async function loadRecipientsForPage(pageId) {
  const { psids, labelMap, nameMap } = await runWithRetry(async () => fetchConversations(pageId, ({ fetched, total, pct }) => {
    const progressMsg = (pct != null)
      ? `Loading recipients… ${pct}%${total ? ` (${fetched.toLocaleString()} of ${total.toLocaleString()})` : ''}`
      : 'Loading recipients…';
    showStatus(progressMsg, 'info', fetched);
  }), { label: 'Loading recipients', maxAttempts: 2 });

  window.recipientNames = nameMap || {};
  const list = (psids || []).map(id => ({ id, status: 'pending', error: '', labels: labelMap?.[id] || [], name: nameMap?.[id] || '' }));
  allRecipients = list;
  recipientsPageId = pageId;
  window.allRecipients = list;
  buildFilterOptions(labelMap || {});
  renderRecipients();
  updateStats();
  updateSendHint();
  updateCampaignIntel();
  return list;
}

// ── Personalization tag insert ─────────────────────────
window.insertPersonalizationTag = function(tag) {
  const ta = document.getElementById('messageText');
  if (!ta) return;
  const start = ta.selectionStart, end = ta.selectionEnd;
  ta.value = ta.value.slice(0, start) + tag + ta.value.slice(end);
  ta.selectionStart = ta.selectionEnd = start + tag.length;
  ta.focus();
  ta.dispatchEvent(new Event('input'));
};

// ── Image Attachment Panel ─────────────────────────────
let currentImageUrl = '';

function updateImageOnlyPaceHint() {
  const hint = $('imageOnlyPaceHint');
  if (!hint) return;
  const hasImage = !!(currentImageUrl || window._imgAttachUrl);
  const hasText = !!($('messageText')?.value || '').trim();
  hint.style.display = hasImage && !hasText ? '' : 'none';
}

function initImagePanel() {
  const toggle     = $('imgAttachToggle');
  const panel      = $('imgAttachPanel');
  const tabUrl     = $('imgTabUrl');
  const tabUpload  = $('imgTabUpload');
  const urlArea    = $('imgUrlArea');
  const uploadArea = $('imgUploadArea');
  const urlInput   = $('imgUrlInput');
  const urlLoad    = $('imgUrlLoad');
  const fileInput  = $('imgFileInput');
  const dropZone   = $('imgDropZone');
  const uploadProg = $('imgUploadProgress');
  const uploadTxt  = $('imgUploadProgressText');
  const previewWrap= $('imgPreviewWrap');
  const previewImg = $('imgPreviewThumb');
  const previewLbl = $('imgPreviewLabel');
  const clearBtn   = $('imgClearBtn');
  const badge      = $('imgAttachBadge');
  if (!toggle || !panel) return;

  function showPreview(url, label) {
    currentImageUrl = url;
    if (previewImg) previewImg.src = url;
    if (previewLbl) previewLbl.textContent = label || 'Image ready to send';
    if (previewWrap) previewWrap.style.display = '';
    if (badge) badge.style.display = '';
    if (urlArea) urlArea.style.display = 'none';
    if (uploadArea) uploadArea.style.display = 'none';
    updateImageOnlyPaceHint();
  }

  function resetUploadZoneUi() {
    if (dropZone) dropZone.style.display = '';
    if (uploadProg) uploadProg.style.display = 'none';
    if (fileInput) fileInput.value = '';
  }

  function clearImage() {
    currentImageUrl = '';
    if (previewImg) previewImg.src = '';
    if (previewWrap) previewWrap.style.display = 'none';
    if (badge) badge.style.display = 'none';
    if (urlInput) urlInput.value = '';
    resetUploadZoneUi();
    // Show back the active tab area
    const isUpload = tabUpload && tabUpload.classList.contains('active');
    if (urlArea) urlArea.style.display = isUpload ? 'none' : '';
    if (uploadArea) uploadArea.style.display = isUpload ? '' : 'none';
    updateImageOnlyPaceHint();
  }

  // Toggle panel open/close
  toggle.addEventListener('click', () => {
    const hidden = panel.hasAttribute('hidden');
    if (hidden) { panel.removeAttribute('hidden'); toggle.setAttribute('aria-expanded', 'true'); }
    else { panel.setAttribute('hidden', ''); toggle.setAttribute('aria-expanded', 'false'); }
  });

  // Tab switching
  function switchTab(tab) {
    const isUpload = tab === 'upload';
    if (tabUrl)    { tabUrl.classList.toggle('active', !isUpload); tabUrl.setAttribute('aria-selected', String(!isUpload)); }
    if (tabUpload) { tabUpload.classList.toggle('active', isUpload); tabUpload.setAttribute('aria-selected', String(isUpload)); }
    if (urlArea)    urlArea.style.display    = isUpload ? 'none' : '';
    if (uploadArea) uploadArea.style.display = isUpload ? '' : 'none';
    if (previewWrap) previewWrap.style.display = 'none';
    clearImage();
  }
  tabUrl?.addEventListener('click', () => switchTab('url'));
  tabUpload?.addEventListener('click', () => switchTab('upload'));

  // URL load
  function loadFromUrl() {
    const url = (urlInput?.value || '').trim();
    if (!url) return;
    if (!/^https?:\/\/.+\.(jpg|jpeg|png|gif|webp)(\?.*)?$/i.test(url) && !/^https?:\/\/.+/i.test(url)) {
      if (window.showToast) window.showToast('Please enter a valid image URL.', 'warning');
      return;
    }
    const img = new Image();
    img.onload = () => showPreview(url, 'URL image ready');
    img.onerror = () => {
      if (window.showToast) window.showToast('Could not load image from URL. Check the link.', 'error');
    };
    img.src = url;
  }
  urlLoad?.addEventListener('click', loadFromUrl);
  urlInput?.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); loadFromUrl(); } });

  // File input — drop zone is a div (not <label>) so one click opens the picker once
  fileInput?.addEventListener('change', () => {
    const file = fileInput.files && fileInput.files[0];
    fileInput.value = '';
    if (file) handleFile(file);
  });
  function openFilePicker() {
    if (fileInput) fileInput.click();
  }
  dropZone?.addEventListener('click', openFilePicker);
  dropZone?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openFilePicker(); }
  });
  dropZone?.addEventListener('dragover', e => { e.preventDefault(); dropZone.classList.add('drag-over'); });
  dropZone?.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
  dropZone?.addEventListener('drop', e => {
    e.preventDefault();
    dropZone.classList.remove('drag-over');
    if (e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]);
  });

  async function handleFile(file) {
    const allowed = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
    if (!allowed.includes(file.type)) {
      if (window.showToast) window.showToast('Only JPEG, PNG, GIF, WebP images allowed.', 'error');
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      if (window.showToast) window.showToast('File too large. Maximum 5 MB.', 'error');
      return;
    }
    // Show upload progress
    if (uploadProg) uploadProg.style.display = '';
    if (uploadTxt)  uploadTxt.textContent = 'Uploading…';
    if (dropZone)   dropZone.style.display = 'none';

    try {
      const csrfToken = (typeof window.getCsrfToken === 'function') ? await window.getCsrfToken() : '';
      const formData = new FormData();
      formData.append('image', file);
      const res  = await fetch('/api/upload-image', {
        method: 'POST',
        headers: { 'X-CSRF-Token': csrfToken },
        body: formData
      });
      const data = await res.json();
      if (data.success && data.url) {
        showPreview(data.url, file.name);
        if (window.showToast) window.showToast('Image uploaded successfully.', 'success');
      } else {
        throw new Error(data.error || 'Upload failed.');
      }
    } catch (e) {
      if (window.showToast) window.showToast('Upload error: ' + (e.message || 'Unknown error'), 'error');
      resetUploadZoneUi();
    } finally {
      if (uploadProg) uploadProg.style.display = 'none';
      // Success hides upload area via showPreview; restore drop zone only when no image attached
      if (!currentImageUrl) resetUploadZoneUi();
    }
  }

  // Clear button
  clearBtn?.addEventListener('click', clearImage);
}

// ── DOM Initialization ─────────────────────────────────
function initScheduleImageZone() {
  const zone = $('svImgZone');
  const fileInput = $('svImgFile');
  if (!zone || !fileInput) return;
  const openPicker = () => fileInput.click();
  zone.addEventListener('click', openPicker);
  zone.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openPicker(); }
  });
}

document.addEventListener('DOMContentLoaded', () => {
  initFromStorage();
  initImagePanel();
  initScheduleImageZone();

  const btnLogin = $('btnLogin'), btnFetchPages = $('btnFetchPages'),
        btnStart = $('btnStart'), btnPause = $('btnPause'), btnResume = $('btnResume'), btnStop = $('btnStop'),
        recipientFilter = $('recipientFilter'), messageText = $('messageText'), delayMs = $('delayMs');

  recipientFilter?.addEventListener('change', () => { renderRecipients(); updateSendHint(); });

  messageText?.addEventListener('input', () => {
    updateImageOnlyPaceHint();
    const charCount = $('charCount');
    const len = messageText.value.length;
    if (charCount) {
      charCount.textContent = `${len} / 2000`;
      charCount.classList.remove('warn', 'danger');
      if (len >= 2000) charCount.classList.add('danger');
      else if (len >= 1600) charCount.classList.add('warn');
    }
    updateCampaignIntel();
  });

  delayMs?.addEventListener('change', updateCampaignIntel);
  document.querySelectorAll('.delay-preset').forEach(btn => {
    btn.addEventListener('click', () => setTimeout(updateCampaignIntel, 0));
  });

  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      if (btnStart && !btnStart.disabled) btnStart.click();
    }
  });

  btnLogin?.addEventListener('click', async () => {
    setLoading(btnLogin, true);
    try {
      uiTrackEvent('login_attempt', { source: 'web_ui_btnLogin' });
      await startFacebookLogin();
      if (typeof window.openDashboardAfterLogin === 'function') window.openDashboardAfterLogin();
      setLoginOnline();
      uiTrackEvent('login_success', { source: 'web_ui_btnLogin' });
      showStatus('Logged in. Loading your pages…', 'success');
      try { await loadPagesFromFacebook({ silent: true }); } catch (_) {}
    } catch (e) {
      uiTrackEvent('login_error', { source: 'web_ui_btnLogin', message: e.message || 'login_failed' });
      showStatus(e.message || 'Login failed.', 'error');
    }
    setLoading(btnLogin, false);
  });

  btnFetchPages?.addEventListener('click', async () => {
    if (btnFetchPages.disabled) return;
    btnFetchPages.disabled = true;
    btnFetchPages.classList.add('spinning');
    uiTrackEvent('pages_refresh_click', { source: 'manual' });
    try {
      await loadPagesFromFacebook({ silent: false });
    } catch (e) {
      uiTrackEvent('pages_refresh_error', { message: e.message || 'failed_to_fetch_pages' });
      const msg = e && e.message ? e.message : 'Failed to fetch pages.';
      if (typeof window.showToast === 'function') {
        window.showToast('Refresh failed: ' + msg, 'error');
      }
    } finally {
      btnFetchPages.classList.remove('spinning');
      btnFetchPages.disabled = false;
    }
  });

  btnStart?.addEventListener('click', async () => {
    const pageId = $('pageSelect')?.value, text = messageText?.value.trim(), delay = Math.max(25, parseInt(delayMs?.value, 10) || 400);
    if (!pageId) return showStatus('Select a page first.', 'warning');
    if (!text && !currentImageUrl) return showStatus('Enter a message or attach an image.', 'warning');

    // Get FB User ID from storage, and ensure it's loaded from server
    let fbUserId = null;
    try {
      const storedUser = JSON.parse(localStorage.getItem('fbcast_user') || '{}');
      fbUserId = storedUser.fb_user_id || storedUser.id || null;
    } catch (e) {}

    // If fbcast_user not loaded, try syncing from server before sending
    if (!fbUserId && typeof window.syncQuotaFromServer === 'function') {
      showStatus('Initializing quota from server…', 'info');
      await window.syncQuotaFromServer();
      try {
        const storedUser = JSON.parse(localStorage.getItem('fbcast_user') || '{}');
        fbUserId = storedUser.fb_user_id || storedUser.id || null;
      } catch (e) {}
    }

    if (!fbUserId) {
      setManualBroadcastButtons('idle');
      return showStatus('User session not initialized. Please refresh the page.', 'warning');
    }

    setManualBroadcastButtons('running');
    setLoading(btnStart, true);
    let recipientIds = [];
    try {
      if (!allRecipients.length || recipientsPageId !== pageId) {
        uiTrackEvent('recipients_auto_load_start', { pageId });
        const loaded = await loadRecipientsForPage(pageId);
        uiTrackEvent('recipients_auto_load_success', { pageId, count: loaded.length });
      }
      recipientIds = getFilteredRecipients().map(r => r.id);
    } catch (e) {
      uiTrackEvent('recipients_auto_load_error', { pageId, message: e.message || 'failed_to_load_recipients' });
      showStatus(e.message || 'Failed to load recipients.', 'error');
      setManualBroadcastButtons('idle');
      return;
    }

    if (!recipientIds.length) {
      showStatus('No conversations found for this page.', 'warning');
      setManualBroadcastButtons('idle');
      return;
    }

    uiTrackEvent('broadcast_start', { mode: 'manual', pageId, recipients: recipientIds.length, delayMs: delay });
    isManualBroadcastRunning = true;
    activeBroadcastPageId = pageId;
    sendStartTime = Date.now();
    allRecipients.forEach(r => { r.status = 'pending'; r.error = ''; });
    renderRecipients();
    updateStats();
    $('progressBar')?.classList.add('progress-bar--active');
    // Build name map from loaded recipients (covers cached & freshly loaded cases)
    const recipientNamesMap = Object.fromEntries(
      allRecipients.filter(r => r.name).map(r => [r.id, r.name])
    );
    // Merge with freshly fetched names (window.recipientNames) if available
    const mergedNames = Object.assign({}, window.recipientNames || {}, recipientNamesMap);
    try {
      await enqueueAndSendUtility({
        pageId, messageText: text, imageUrl: currentImageUrl, recipientIds,
        recipientNames: mergedNames,
        delayMs: delay,
        fbUserId,
        onProgress: ({ index, total, item }) => { updateRecipientRow(item); updateStats(); updateEta(index, total, delay); if(window.updateQuotaUI) window.updateQuotaUI(); },
        onDone: (summary) => {
          const sent = summary?.sent ?? allRecipients.filter(r => r.status === 'sent').length;
          const failed = summary?.failed ?? allRecipients.filter(r => r.status === 'failed').length;
          const total = allRecipients.length;
          const reason = summary?.reason || 'completed';
          uiTrackEvent(reason === 'stopped' ? 'broadcast_stop' : 'broadcast_complete', {
            mode: 'manual', pageId, total, sent, failed, reason
          });
          finishManualBroadcast(summary);
          if (window.updateQuotaUI) window.updateQuotaUI();
        }
      });
    } catch (e) {
      isManualBroadcastRunning = false;
      activeBroadcastPageId = null;
      $('progressBar')?.classList.remove('progress-bar--active');
      uiTrackEvent('broadcast_error', { mode: 'manual', pageId, message: e.message || 'failed_to_start' });
      showStatus(e.message || 'Failed to start.', 'error');
      setManualBroadcastButtons('idle');
    }
  });

  btnPause?.addEventListener('click', () => {
    if (!pauseSending()) {
      showStatus('No broadcast is running.', 'warning');
      return;
    }
    uiTrackEvent('broadcast_pause', { mode: 'manual' });
    showStatus('Paused — click Resume to continue.', 'warning');
  });
  btnResume?.addEventListener('click', () => {
    if (!resumeSending()) {
      showStatus('Broadcast is not paused.', 'warning');
      return;
    }
    uiTrackEvent('broadcast_resume', { mode: 'manual' });
    showStatus('Resumed.', 'info');
  });
  btnStop?.addEventListener('click', () => {
    if (!stopSending()) {
      showStatus('No broadcast is running.', 'warning');
      return;
    }
    uiTrackEvent('broadcast_stop', { mode: 'manual' });
    showStatus('Stopping…', 'warning');
  });

  window.addEventListener('fbc:broadcast-state', (e) => {
    const d = e.detail || {};
    if (!d.isSending) {
      if (!isManualBroadcastRunning) setManualBroadcastButtons('idle');
      return;
    }
    if (isManualBroadcastRunning) {
      setManualBroadcastButtons(d.paused ? 'paused' : 'running');
    }
  });
  setManualBroadcastButtons('idle');

  updateCampaignIntel();

  // Retry failed messages
  btnRetryFailed?.addEventListener('click', () => {
    const failed = allRecipients.filter(r => r.status === 'failed');
    if (!failed.length) { showStatus('No failed messages to retry.', 'warning'); return; }
    failed.forEach(r => { r.status = 'pending'; r.error = ''; });
    renderRecipients();
    updateStats();
    showStatus(`Queued ${failed.length} failed messages for retry.`, 'info');
  });

  // Quick action: retry all
  $('qaRetryAll')?.addEventListener('click', () => btnRetryFailed?.click());
  // Quick action: clear results
  $('qaClear')?.addEventListener('click', () => {
    if (!confirm('Clear all results?')) return;
    allRecipients = [];
    window.allRecipients = allRecipients;
    renderRecipients();
    updateStats();
    showStatus('Results cleared.', 'info');
  });
});

// Expose globals for other scripts
window.showStatus = showStatus;
window.loadPagesFromFacebook = loadPagesFromFacebook;
window.renderPages = renderPages;
window.renderRecipients = renderRecipients;
window.updateStats = updateStats;
window.buildFilterOptions = buildFilterOptions;
window.allRecipients = allRecipients;
// switchDashboardView is defined in assets/js/app-shell.js (do not assign here)
window.updateHomeViewStats = updateHomeViewStats;
// Image URL getter for auto-send (index-page.js)
Object.defineProperty(window, '_imgAttachUrl', { get: () => currentImageUrl, configurable: true });

// ── Scheduling View ───────────────────────────────────────────────────────────

async function getCsrfToken() {
  if (window.getCsrfToken && window.getCsrfToken !== getCsrfToken) return window.getCsrfToken();
  const r = await fetch('/api/csrf-token', { credentials: 'same-origin' });
  const d = await r.json();
  return d.csrfToken || d.token || '';
}

window.svUpdateCharCount = function () {
  const ta = $('svMessage');
  const cc = $('svCharCount');
  if (!ta || !cc) return;
  const len = ta.value.length;
  cc.textContent = `${len} / 2000`;
  cc.style.color = len > 1900 ? '#f87171' : '';
};

window.svSelectAllPages = function () {
  if (document.body.classList.contains('shell-multi-broadcast')) {
    if (typeof multiSelectAllPages === 'function') multiSelectAllPages();
    return;
  }
  document.querySelectorAll('#pageCards .page-card').forEach(c => c.classList.add('sched-selected'));
  svUpdateSidebarPageCount();
};
window.svSelectNonePages = function () {
  if (document.body.classList.contains('shell-multi-broadcast')) {
    if (typeof multiSelectNonePages === 'function') multiSelectNonePages();
    return;
  }
  document.querySelectorAll('#pageCards .page-card').forEach(c => c.classList.remove('sched-selected'));
  svUpdateSidebarPageCount();
};

function svPopulatePages() {
  if (document.body.classList.contains('shell-scheduling')) svInitSchedulingPageSelection();
}

window.svLoadSchedules = async function () {
  try {
    const res  = await fetch('/api/schedules', { credentials: 'same-origin' });
    const data = await res.json();
    svRenderSchedules(data.schedules || []);
  } catch (_) {}
};

function svEnsureScheduleListHeader() {
  const panel = document.querySelector('#view-scheduling .sv2-list-panel');
  if (!panel || panel.querySelector('.sv2-list-hdr')) return;
  const hdr = document.createElement('div');
  hdr.className = 'sv2-list-hdr';
  hdr.innerHTML = [
    '<div class="sv2-list-hdr-top">',
    '  <div><h2 class="sv2-list-title">Your schedule</h2>',
    '  <p class="sv2-list-sub">Upcoming and completed broadcasts across all pages</p></div>',
    '</div>',
    '<div class="sv2-stats" id="svStatsRow" aria-label="Schedule statistics">',
    '  <div class="sv2-stat"><span class="sv2-stat-val" id="svStatTotal">0</span><span class="sv2-stat-lbl">Total</span></div>',
    '  <div class="sv2-stat sv2-stat--pending"><span class="sv2-stat-val" id="svStatPending">0</span><span class="sv2-stat-lbl">Pending</span></div>',
    '  <div class="sv2-stat sv2-stat--running"><span class="sv2-stat-val" id="svStatRunning">0</span><span class="sv2-stat-lbl">Sending</span></div>',
    '  <div class="sv2-stat sv2-stat--done"><span class="sv2-stat-val" id="svStatDone">0</span><span class="sv2-stat-lbl">Done</span></div>',
    '</div>'
  ].join('');
  const listInner = $('svList');
  if (listInner) panel.insertBefore(hdr, listInner);
}

function svUpdateScheduleStats(list) {
  const total = list.length;
  const pending = list.filter(s => s.status === 'pending').length;
  const running = list.filter(s => s.status === 'running').length;
  const done = list.filter(s => s.status === 'done').length;
  const set = (id, n) => { const el = document.getElementById(id); if (el) el.textContent = String(n); };
  set('svStatTotal', total);
  set('svStatPending', pending);
  set('svStatRunning', running);
  set('svStatDone', done);
}

function svRenderSchedules(list) {
  const listEl  = $('svList');
  const emptyEl = $('svListEmpty');
  const badge   = $('svBadge');
  if (!listEl) return;

  svEnsureScheduleListHeader();
  svUpdateScheduleStats(list);

  const active = list.filter(s => s.status === 'pending' || s.status === 'running');
  if (badge) {
    const countEl = document.getElementById('svBadgeCount');
    if (countEl) countEl.textContent = active.length;
    badge.style.display = active.length ? '' : 'none';
  }

  if (!list.length) {
    if (emptyEl) emptyEl.style.display = '';
    return;
  }
  if (emptyEl) emptyEl.style.display = 'none';

  const iconMap   = { pending: 'fa-clock', running: 'fa-spinner fa-spin', done: 'fa-circle-check', failed: 'fa-circle-xmark' };
  const statusLbl = { pending: 'Pending', running: 'Sending…', done: 'Done', failed: 'Failed' };

  const items = list.map(s => {
    const icon    = iconMap[s.status] || 'fa-clock';
    const dt      = new Date(s.scheduled_at);
    const timeStr = dt.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    const msg     = (s.message || '').length > 80 ? s.message.slice(0, 77) + '…' : (s.message || '');
    const pages   = Array.isArray(s.pages) && s.pages.length
      ? s.pages.map(p => escHtml(p.name || p.id)).join(', ')
      : escHtml(s.page_name || s.page_id || '—');
    const statsLine = s.status === 'done'
      ? `<span class="sv2-card-stat"><i class="fa-solid fa-paper-plane"></i> ${s.sent_count || 0}/${s.total_recipients || 0} sent</span>`
      : s.status === 'failed'
        ? `<span class="sv2-card-stat sv2-card-stat--err"><i class="fa-solid fa-triangle-exclamation"></i> ${escHtml((s.error_message || 'Error').substring(0, 60))}</span>`
        : '';
    const cancelBtn = s.status === 'pending'
      ? `<button class="sv2-card-cancel" onclick="svCancelSchedule(${s.id})" title="Cancel"><i class="fa-solid fa-xmark"></i></button>`
      : '';
    return `<div class="sv2-card">
      <div class="sv2-card-icon sv2-card-icon--${s.status}"><i class="fa-solid ${icon}"></i></div>
      <div class="sv2-card-body">
        <div class="sv2-card-pages"><i class="fa-solid fa-layer-group"></i> ${pages}</div>
        <div class="sv2-card-msg">${escHtml(msg)}</div>
        <div class="sv2-card-meta">
          <i class="${s.status === 'done' ? 'fa-solid fa-circle-check' : s.status === 'failed' ? 'fa-solid fa-circle-xmark' : 'fa-regular fa-clock'}"></i> ${timeStr}
          ${statsLine ? ' · ' + statsLine : ''}
        </div>
      </div>
      <div class="sv2-card-right">
        <span class="sv2-pill sv2-pill--${s.status}">${statusLbl[s.status] || s.status}</span>
        ${cancelBtn}
      </div>
    </div>`;
  });

  listEl.innerHTML = items.join('');
}

window.svCancelSchedule = async function (id) {
  if (!confirm('Cancel this scheduled broadcast?')) return;
  try {
    const csrf = await window.getCsrfToken();
    const res  = await fetch(`/api/schedules/${id}`, {
      method: 'DELETE', credentials: 'same-origin',
      headers: { 'X-CSRF-Token': csrf }
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed');
    showStatus('Schedule cancelled.', 'info');
    svLoadSchedules();
  } catch (e) {
    showStatus(e.message, 'error');
  }
};

window.svSaveSchedule = async function () {
  const pages = svGetSchedulePagesFromSidebar();
  if (!pages.length) { showStatus('Select at least one page in the sidebar.', 'warning'); return; }
  const message = ($('svMessage')?.value || '').trim();
  const imageUrl    = ($('svImageUrl')?.value || '').trim();
  if (!message && !imageUrl) { showStatus('Write a message or add an image.', 'warning'); return; }

  const dtVal = $('svDateTime')?.value;
  if (!dtVal) { showStatus('Select a scheduled date and time.', 'warning'); return; }

  const scheduledAt = new Date(dtVal).toISOString();
  const delayMs     = parseInt($('svDelay')?.value, 10) || 400;

  const btn = $('svSubmitBtn');
  btn.disabled = true;
  btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Scheduling…';

  try {
    const csrf = await window.getCsrfToken();
    const res  = await fetch('/api/schedules', {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
      body: JSON.stringify({ pages, message, image_url: imageUrl || null, delay_ms: delayMs, scheduled_at: scheduledAt })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to schedule');
    showStatus(`Broadcast scheduled for ${pages.length} page${pages.length > 1 ? 's' : ''}!`, 'success');
    $('svMessage').value = '';
    svClearImage();
    svUpdateCharCount();
    svLoadSchedules();
  } catch (e) {
    showStatus(e.message || 'Failed to schedule.', 'error');
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<i class="fa-solid fa-calendar-check"></i> Schedule Broadcast';
  }
};

// Image upload helpers for scheduling view
window.svHandleImageFile = async function (input) {
  const file = input.files[0];
  if (!file) return;

  const preview    = $('svImgPreview');
  const placeholder = $('svImgPlaceholder');
  const uploading  = $('svImgUploading');
  const actions    = $('svImgActions');

  // Show local preview immediately
  const reader = new FileReader();
  reader.onload = e => {
    preview.src = e.target.result;
    preview.style.display = '';
    placeholder.style.display = 'none';
  };
  reader.readAsDataURL(file);

  // Upload to server
  uploading.style.display = '';
  try {
    const csrf = await window.getCsrfToken();
    const form = new FormData();
    form.append('image', file);
    const res  = await fetch('/api/upload-image', {
      method: 'POST',
      headers: { 'X-CSRF-Token': csrf },
      credentials: 'same-origin',
      body: form
    });
    const data = await res.json();
    if (!data.success) throw new Error(data.error || 'Upload failed');
    $('svImageUrl').value = data.url;
    actions.style.display = '';
  } catch (e) {
    showStatus(e.message || 'Image upload failed', 'error');
    svClearImage();
  } finally {
    uploading.style.display = 'none';
    input.value = '';
  }
};

window.svHandleUrlInput = function (input) {
  const url = (input.value || '').trim();
  const preview    = $('svImgPreview');
  const placeholder = $('svImgPlaceholder');
  const actions    = $('svImgActions');
  if (url) {
    preview.src = url;
    preview.style.display = '';
    placeholder.style.display = 'none';
    actions.style.display = '';
    const okEl = $('svImgOk');
    if (okEl) okEl.innerHTML = '<i class="fa-solid fa-link"></i> URL set';
  } else {
    svClearImage();
  }
};

window.svClearImage = function (e) {
  if (e) e.stopPropagation();
  $('svImageUrl').value = '';
  const fileInput = $('svImgFile');
  if (fileInput) fileInput.value = '';
  const preview = $('svImgPreview');
  if (preview) { preview.src = ''; preview.style.display = 'none'; }
  const placeholder = $('svImgPlaceholder');
  if (placeholder) placeholder.style.display = '';
  const actions = $('svImgActions');
  if (actions) actions.style.display = 'none';
  const okEl = $('svImgOk');
  if (okEl) okEl.innerHTML = '<i class="fa-solid fa-circle-check"></i> Image ready';
};

// Set min datetime to 2 minutes from now
function svSetMinDatetime() {
  const dtInput = $('svDateTime');
  if (!dtInput) return;
  const now = new Date(Date.now() + 2 * 60 * 1000);
  const pad = n => String(n).padStart(2, '0');
  const minVal = `${now.getFullYear()}-${pad(now.getMonth()+1)}-${pad(now.getDate())}T${pad(now.getHours())}:${pad(now.getMinutes())}`;
  dtInput.min = minVal;
  if (!dtInput.value || dtInput.value < minVal) dtInput.value = minVal;
}

// Auto-refresh schedules every 30s when scheduling view is active
setInterval(() => {
  if (document.getElementById('view-scheduling')?.style.display !== 'none') svLoadSchedules();
}, 30_000);

// View routing: see assets/js/app-shell.js (AppShell.navigate / switchDashboardView)

// Update home view stats with real data
function updateHomeViewStats() {
  const total = allRecipients.length;
  const sent = allRecipients.filter(r => r.status === 'sent').length;
  const failed = allRecipients.filter(r => r.status === 'failed').length;
  const pending = allRecipients.filter(r => r.status === 'pending' || r.status === 'sending').length;
  const successRate = total > 0 ? Math.round((sent / total) * 100) : 0;

  // Update hero stats
  const hTotal = document.getElementById('homeTotalMessages');
  const hSent = document.getElementById('homeSentCount');
  const hFailed = document.getElementById('homeFailedCount');
  const hPending = document.getElementById('homePendingCount');
  const hSuccess = document.getElementById('homeSuccessRate');
  const hPages = document.getElementById('homePagesCount');
  const hBroadcasts = document.getElementById('homeTotalBroadcasts');

  if (hTotal) hTotal.textContent = total.toLocaleString();
  if (hSent) hSent.textContent = sent.toLocaleString();
  if (hFailed) hFailed.textContent = failed.toLocaleString();
  if (hPending) hPending.textContent = pending.toLocaleString();
  if (hSuccess) hSuccess.textContent = successRate + '%';
  if (hPages) hPages.textContent = window.totalPagesCount || '0';
  if (hBroadcasts) hBroadcasts.textContent = window.totalBroadcastsCount || '0';
  // Sync KPI row (duplicated IDs with suffix 2)
  const el2 = (id) => document.getElementById(id);
  const t2 = el2('homeTotalMessages2'); if (t2) t2.textContent = total.toLocaleString();
  const s2 = el2('homeSentCount2');     if (s2) s2.textContent = sent.toLocaleString();
  const b2 = el2('homeTotalBroadcasts2'); if (b2) b2.textContent = window.totalBroadcastsCount || '0';

  // Delivery rate
  const deliveryRate = total > 0 ? Math.round((sent / total) * 100) : 0;
  const failRate     = total > 0 ? Math.round((failed / total) * 100) : 0;
  const setT = (id, v) => { const e = document.getElementById(id); if (e) e.textContent = v; };
  const setW = (id, w) => { const e = document.getElementById(id); if (e) e.style.width = w; };
  setT('perfDeliveryRate', deliveryRate + '%');
  setT('perfTotalReach',   sent.toLocaleString());
  setT('perfFailRate',     failRate + '%');
  setT('perfPending',      pending.toLocaleString());
  setT('heroDeliveryPct',  deliveryRate + '%');
  setW('heroDeliveryFill', deliveryRate + '%');

  // Update plan banner
  const planName = document.getElementById('homePlanName');
  const msgUsed = document.getElementById('homeMsgUsed');
  const msgTotal = document.getElementById('homeMsgTotal');
  const planProgress = document.getElementById('homePlanProgress');
  const planPct = document.getElementById('homePlanPct');
  const planBadge = document.getElementById('planBadge');
  const quotaVal = document.getElementById('quotaVal');
  const quotaTotal = document.getElementById('quotaTotal');

  if (planBadge) {
    const plan = planBadge.textContent || 'Free';
    if (planName) planName.textContent = plan + ' Plan';
  }
  if (typeof window.getQuota === 'function') {
    const q = window.getQuota();
    const used = q.messagesUsed || 0;
    const total2 = q.messageLimit || 2000;
    if (msgUsed) msgUsed.textContent = used.toLocaleString();
    if (msgTotal) msgTotal.textContent = total2.toLocaleString();
    const pct = total2 > 0 ? Math.min(100, Math.round((used / total2) * 100)) : 0;
    if (planProgress) planProgress.style.width = pct + '%';
    if (planPct) planPct.textContent = pct + '%';
  } else if (quotaVal && quotaTotal) {
    const rem = parseInt(quotaVal.textContent.replace(/,/g, '') || '0');
    const total2 = parseInt(quotaTotal.textContent.replace(/,/g, '') || '2000');
    const used = Math.max(0, total2 - rem);
    if (msgUsed) msgUsed.textContent = used.toLocaleString();
    if (msgTotal) msgTotal.textContent = total2.toLocaleString();
    const pct = total2 > 0 ? Math.round((used / total2) * 100) : 0;
    if (planProgress) planProgress.style.width = pct + '%';
    if (planPct) planPct.textContent = pct + '%';
  }

  // Update connected pages grid — premium card design
  const pagesList = document.getElementById('homePagesList');
  const countBadge = document.getElementById('homePagesCountBadge');
  if (pagesList && window.loadedPages && window.loadedPages.length > 0) {
    const n = window.loadedPages.length;
    if (countBadge) countBadge.textContent = n + ' Page' + (n !== 1 ? 's' : '');
    pagesList.innerHTML = window.loadedPages.map(p => {
      const initial   = (p.name || 'P').charAt(0).toUpperCase();
      const pic       = p.picture?.data?.url || p.picture || '';
      const followers = p.followers_count || p.fan_count || 0;
      const reachable = followers ? Math.floor(followers * 0.7) : 0;
      const fmtNum    = n => n >= 1000 ? (n / 1000).toFixed(1) + 'K' : (n || '0');
      const unread    = p.unreadCount || 0;
      return `
        <div class="cp-page-card" onclick="switchDashboardView('broadcast')">
          <div class="cp-card-header">
            <div class="cp-card-cover"></div>
            <div class="cp-card-avatar-wrap">
              ${pic
                ? `<img class="cp-card-avatar" src="${pic}" alt="${escHtml(p.name)}" onerror="this.outerHTML='<div class=\\"cp-card-avatar-ph\\">${escHtml(initial)}</div>'">`
                : `<div class="cp-card-avatar-ph">${escHtml(initial)}</div>`}
              <span class="cp-card-active-dot" title="Connected"></span>
            </div>
          </div>
          <div class="cp-card-body">
            <div class="cp-card-name">${escHtml(p.name)}</div>
            ${p.category ? `<div class="cp-card-cat">${escHtml(p.category)}</div>` : ''}
            <div class="cp-card-stats">
              <div class="cp-card-stat">
                <div class="cp-stat-val">${fmtNum(followers)}</div>
                <div class="cp-stat-lbl">Followers</div>
              </div>
              <div class="cp-card-stat-div"></div>
              <div class="cp-card-stat">
                <div class="cp-stat-val">${fmtNum(reachable)}</div>
                <div class="cp-stat-lbl">Reachable</div>
              </div>
              <div class="cp-card-stat-div"></div>
              <div class="cp-card-stat">
                <div class="cp-stat-val ${unread > 0 ? 'cp-stat-unread' : ''}">${unread > 99 ? '99+' : unread}</div>
                <div class="cp-stat-lbl">Unread</div>
              </div>
            </div>
          </div>
          <div class="cp-card-actions">
            <button class="cp-btn-broadcast" onclick="event.stopPropagation();switchDashboardView('broadcast')">
              <i class="fa-solid fa-bullhorn"></i> Broadcast
            </button>
            <button class="cp-btn-chat" onclick="event.stopPropagation();switchDashboardView('messenger')">
              <i class="fa-brands fa-facebook-messenger"></i> Chat
            </button>
          </div>
        </div>
      `;
    }).join('');
  } else if (pagesList) {
    if (countBadge) countBadge.textContent = '0 Pages';
    pagesList.innerHTML = `
      <div class="cp-empty">
        <div class="cp-empty-icon"><i class="fa-brands fa-facebook-messenger"></i></div>
        <h4>No pages connected</h4>
        <p>Connect your Facebook account to start broadcasting to your audience.</p>
        <button class="cp-connect-btn" onclick="triggerConnect()">
          <i class="fa-brands fa-facebook"></i> Connect Facebook
        </button>
      </div>
    `;
  }

  // Update latest results if there's data
  if (sent > 0 || failed > 0) {
    const resultsSection = document.getElementById('homeResultsSection');
    const hrsBadge = document.getElementById('hrsBadge');
    const hrsGrid = document.getElementById('hrsResultsGrid');
    if (resultsSection) resultsSection.style.display = '';
    if (hrsBadge) hrsBadge.textContent = sent + ' sent';
    if (hrsGrid) {
      hrsGrid.innerHTML = `
        <div class="hrs-result-card">
          <div class="hrs-result-page">Last Broadcast</div>
          <div class="hrs-result-stats">
            <div class="hrs-stat">
              <div class="hrs-stat-val">${sent}</div>
              <div class="hrs-stat-lbl">Sent</div>
            </div>
            <div class="hrs-stat">
              <div class="hrs-stat-val failed">${failed}</div>
              <div class="hrs-stat-lbl">Failed</div>
            </div>
            <div class="hrs-stat">
              <div class="hrs-stat-val">${successRate}%</div>
              <div class="hrs-stat-lbl">Rate</div>
            </div>
          </div>
          <div class="hrs-result-time">${new Date().toLocaleString()}</div>
        </div>
      `;
    }
  }

  // Update user name
  const userNameEl = document.getElementById('homeUserName');
  const navUserNameEl = document.getElementById('navUserName');
  const navUserAvatarEl = document.getElementById('navUserAvatar');
  const topbarUserName = document.getElementById('topbarUserName');
  const topbarAvatar = document.getElementById('topbarAvatar');

  const userName = topbarUserName?.textContent || 'User';
  if (userNameEl) userNameEl.textContent = userName;
  if (navUserNameEl) navUserNameEl.textContent = userName;
  if (topbarAvatar) {
    const initial = userName.charAt(0).toUpperCase();
    if (navUserAvatarEl) navUserAvatarEl.textContent = initial;
  }

  // Render scheduling widgets
  renderSchedulerWidgets();
}

function renderSchedulerWidgets() {
  const broadcasts = window.allBroadcasts || [];
  const recipients = window.allRecipients || allRecipients || [];

  // Separate scheduled vs sent (API schedules use pending/running/done)
  const scheduled = broadcasts.filter(b => {
    const st = (b.status || '').toLowerCase();
    return st === 'scheduled' || st === 'pending' || st === 'running' || st === 'sending';
  });
  const sent = broadcasts.filter(b => {
    const st = (b.status || '').toLowerCase();
    return st === 'sent' || st === 'completed' || st === 'done';
  });
  const totalReach = recipients.filter(r => r.status === 'sent').length;

  const set = (id, v) => { const e = document.getElementById(id); if (e) e.textContent = v; };

  // Scheduler stats
  set('schedTotalCount',   broadcasts.length.toLocaleString());
  set('schedSentCount',    sent.length.toLocaleString());
  set('schedPendingCount', scheduled.length.toLocaleString());
  set('schedTotalReach',   totalReach.toLocaleString());

  // Performance Hub stats
  const total   = recipients.length;
  const deliv   = recipients.filter(r => r.status === 'sent').length;
  const failed  = recipients.filter(r => r.status === 'failed').length;
  const pending = recipients.filter(r => r.status === 'pending' || r.status === 'sending').length;
  const rate    = total > 0 ? Math.round((deliv / total) * 100) : 0;

  set('phTotalSent', total.toLocaleString());
  set('phDelivered', deliv.toLocaleString());
  set('phFailed',    failed.toLocaleString());
  set('phPending',   pending.toLocaleString());

  // Animate donut
  const circ = 2 * Math.PI * 48;
  const fill = document.getElementById('phDonutFill');
  const pctEl = document.getElementById('phDonutPct');
  if (fill) {
    requestAnimationFrame(() => {
      fill.setAttribute('stroke-dasharray', `${(rate / 100) * circ} ${circ}`);
      fill.setAttribute('stroke', rate >= 80 ? '#34D399' : rate >= 50 ? '#FCD34D' : '#F87171');
      fill.style.filter = rate >= 80
        ? 'drop-shadow(0 0 8px rgba(52,211,153,.6))'
        : rate >= 50
        ? 'drop-shadow(0 0 8px rgba(252,211,77,.5))'
        : 'drop-shadow(0 0 8px rgba(248,113,113,.5))';
    });
  }
  if (pctEl) pctEl.textContent = rate + '%';

  // Hero mini widget
  _renderHeroSchedList(scheduled);

  // Main panel list
  _renderMainSchedList(scheduled, broadcasts);
}

function _renderHeroSchedList(scheduled) {
  const listEl  = document.getElementById('heroSchedList');
  const badgeEl = document.getElementById('heroSchedBadge');
  if (!listEl) return;

  if (badgeEl) {
    badgeEl.textContent = scheduled.length;
    badgeEl.style.display = scheduled.length > 0 ? 'inline-flex' : 'none';
  }

  if (scheduled.length === 0) {
    listEl.innerHTML = `
      <div class="hv-hero-sched-empty">
        <i class="fa-solid fa-calendar-xmark"></i>
        <span>No upcoming broadcasts scheduled</span>
      </div>`;
    return;
  }

  listEl.innerHTML = scheduled.slice(0, 3).map(b => {
    const name = b.message ? b.message.substring(0, 30) + (b.message.length > 30 ? '…' : '') : 'Scheduled Broadcast';
    const t    = b.scheduled_at || b.schedule_time || b.created_at;
    const time = t ? new Date(t).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : 'Pending';
    return `
      <div class="hv-hero-sched-item">
        <div class="hv-hero-sched-dot"></div>
        <div class="hv-hero-sched-item-info">
          <div class="hv-hero-sched-item-name">${name}</div>
          <div class="hv-hero-sched-item-time">${time}</div>
        </div>
      </div>`;
  }).join('');
}

function _renderMainSchedList(scheduled, allBroadcasts) {
  const listEl  = document.getElementById('schedMainList');
  const badgeEl = document.getElementById('schedMainBadge');
  if (!listEl) return;

  const items = scheduled.length > 0 ? scheduled : allBroadcasts.slice(-6).reverse();

  if (badgeEl) {
    if (scheduled.length > 0) {
      badgeEl.textContent = scheduled.length + ' upcoming';
      badgeEl.style.display = 'inline-flex';
    } else {
      badgeEl.style.display = 'none';
    }
  }

  if (items.length === 0) {
    listEl.innerHTML = `
      <div class="hv-sched-empty-state">
        <div class="hv-sched-empty-icon"><i class="fa-solid fa-calendar-xmark"></i></div>
        <div class="hv-sched-empty-title">No scheduled broadcasts</div>
        <div class="hv-sched-empty-sub">Schedule a broadcast to automatically send messages to your followers at a specific date and time.</div>
        <button class="hv-sched-empty-btn" onclick="switchDashboardView('broadcast')">
          <i class="fa-solid fa-calendar-plus"></i> Schedule Your First Broadcast
        </button>
      </div>`;
    return;
  }

  listEl.innerHTML = items.map(b => {
    const name   = b.message ? b.message.substring(0, 40) + (b.message.length > 40 ? '…' : '') : 'Broadcast';
    const t      = b.scheduled_at || b.schedule_time || b.created_at;
    const time   = t ? new Date(t).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—';
    const status = b.status || 'pending';
    const stCls  = status === 'sent' || status === 'completed' ? 'hv-sched-status-sent'
                 : status === 'sending' ? 'hv-sched-status-sending'
                 : 'hv-sched-status-pending';
    const stLbl  = status === 'sent' || status === 'completed' ? 'Sent'
                 : status === 'sending' ? 'Sending…'
                 : 'Scheduled';
    return `
      <div class="hv-sched-main-item">
        <div class="hv-sched-main-icon"><i class="fa-solid fa-calendar-check"></i></div>
        <div class="hv-sched-main-info">
          <div class="hv-sched-main-name">${name}</div>
          <div class="hv-sched-main-time">
            <i class="fa-solid fa-clock"></i>${time}
          </div>
        </div>
        <div class="hv-sched-main-status ${stCls}">${stLbl}</div>
      </div>`;
  }).join('');
}

// ─────────────────────────────────────────────────────────
// MESSENGER MODULE
// ─────────────────────────────────────────────────────────
let messengerConversations = [];
let currentChatPsid = null;
let currentChatPageId = null;
let messengerPollInterval = null;
let lastPollTime = null;

// Helper to get clean PSID (remove t_ prefix)
function cleanPsid(psid) {
  return String(psid || '').replace(/^t_/, '');
}

async function loadMessengerConversations() {
  const pageSelect = document.getElementById('pageSelect');
  const pageId = pageSelect?.value || window.current_page_id || window.currentPageId || '';

  // Single messenger stack (messenger.js) — DB cache + poll + socket
  if (typeof window.msngInit === 'function') {
    if (pageId) window.currentPageId = pageId;
    window.msngInit(0);
    return;
  }

  if (typeof window.initInboxForMainSite === 'function') {
    await window.initInboxForMainSite();
    return;
  }

  showStatus('Messenger module not loaded — refresh the page', 'warn');
}


function renderMessengerConvs() {
  const listEl = document.getElementById('messengerConvList');
  const countEl = document.getElementById('messengerConvCount');
  if (!listEl) return;

  if (countEl) countEl.textContent = messengerConversations.length;

  if (messengerConversations.length === 0) {
    listEl.innerHTML = '<div class="mc-empty"><i class="fa-brands fa-facebook-messenger"></i><p>No conversations found.<br>Messages will appear here after users message your page.</p></div>';
    return;
  }

  listEl.innerHTML = messengerConversations.map(c => {
    const initial = (c.user_name || 'U').charAt(0).toUpperCase();
    const time = formatChatTime(c.last_message_at);
    const isUnread = c.unread_count > 0;
    const isActive = c.psid === currentChatPsid;
    // psid = user's PSID for sending, conversation_id = thread ID for loading messages
    return `
      <div class="mc-item ${isUnread ? 'unread' : ''} ${isActive ? 'active' : ''}" onclick="openChat('${escHtml(c.psid)}', '${escHtml(c.user_name)}', '${escHtml(c.user_picture || '')}', '${escHtml(c.page_id || currentChatPageId || '')}', '${escHtml(c.conversation_id || '')}')">
        ${c.user_picture
          ? `<img src="${c.user_picture}" class="mc-avatar" alt="" onerror="this.style.display='none'">`
          : `<div class="mc-avatar-placeholder">${initial}</div>`
        }
        <div class="mc-info">
          <div class="mc-name ${isUnread ? 'unread-name' : ''}">${escHtml(c.user_name)}</div>
          <div class="mc-last-msg">${escHtml(c.last_message || 'No messages yet')}</div>
        </div>
        <div class="mc-meta">
          <span class="mc-time">${time}</span>
          ${isUnread ? `<span class="mc-unread-badge">${c.unread_count}</span>` : ''}
        </div>
      </div>
    `;
  }).join('');
}

function formatChatTime(dateStr) {
  if (!dateStr) return '';
  const date = new Date(dateStr);
  const now = new Date();
  const diff = now - date;
  const mins = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);
  if (mins < 1) return 'now';
  if (mins < 60) return mins + 'm';
  if (hours < 24) return hours + 'h';
  if (days < 7) return days + 'd';
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

async function openChat(psid, userName, userPicture, pageId, conversationId) {
  // Validate inputs
  if (!psid) {
    showStatus('Error: Conversation ID not found', 'error');
    return;
  }

  currentChatPsid = String(psid);
  currentChatPageId = pageId || currentChatPageId || window.currentPageId;
  window.currentConversationId = conversationId || psid; // Use conversation_id for loading messages

  console.log('Opening chat:', { psid: currentChatPsid, userName, pageId, conversationId, currentPageId: currentChatPageId });

  const chatEmpty = document.getElementById('chatEmpty');
  const chatContent = document.getElementById('chatContent');
  const chatName = document.getElementById('chatName');
  const chatAvatar = document.getElementById('chatAvatar');
  const chatMessages = document.getElementById('chatMessages');

  if (chatEmpty) chatEmpty.style.display = 'none';
  if (chatContent) chatContent.style.display = 'flex';
  if (chatContent) chatContent.style.flexDirection = 'column';
  if (chatContent) chatContent.style.height = '100%';
  if (chatName) chatName.textContent = userName;
  if (chatAvatar) {
    if (userPicture) {
      chatAvatar.src = userPicture;
    } else {
      const initial = (userName || 'U').charAt(0).toUpperCase();
      chatAvatar.style.display = 'none';
    }
  }

  // Render conversations list with active state
  renderMessengerConvs();

  // Load messages
  await loadChatMessages(psid, pageId || currentChatPageId, conversationId);

  // Start polling
  startMessengerPolling();
}

async function loadChatMessages(psid, pageId, conversationId) {
  const chatMessages = document.getElementById('chatMessages');
  if (!chatMessages) return;

  chatMessages.innerHTML = '<div style="text-align:center;padding:20px;color:var(--text3)"><i class="fa-solid fa-spinner fa-spin"></i> Loading messages...</div>';

  console.log('Loading messages for PSID:', psid, 'Page:', pageId);

  const cleanPsid = String(psid || '').replace(/^t_/, '');

  // Load from database only (webhook stores all messages here)
  try {
    const resp = await fetch(`messenger_api.php?action=load_messages&page_id=${encodeURIComponent(pageId)}&psid=${encodeURIComponent(cleanPsid)}`, {
      headers: { 'Authorization': 'Bearer ' + (window.APP_CONFIG?.csrfToken || '') }
    });

    if (resp.ok) {
      const data = await resp.json();
      if (data.messages && data.messages.length > 0) {
        // Map DB fields to app fields
        const messages = data.messages.map(m => ({
          id: m.id,
          content: m.message || m.content || '',
          sent_at: m.created_at || m.sent_at,
          is_from_user: m.from_me === 0 ? 1 : 0, // DB: 1=from_user, 0=from_me
          has_attachment: m.attachment_url ? 1 : 0,
          attachment_url: m.attachment_url || null,
          attachment_type: m.attachment_type || null,
        }));
        // Sort oldest first (top) to newest (bottom)
        const sorted = [...messages].sort((a, b) => new Date(a.sent_at) - new Date(b.sent_at));
        renderChatMessages(sorted);
        showStatus(`Loaded ${messages.length} messages from database`, 'success');
        return;
      }
    }
  } catch (e) {
    console.log('DB load error:', e);
  }

  // If no messages in DB, show empty state
  chatMessages.innerHTML = '<div style="text-align:center;padding:20px;color:var(--text3)"><i class="fa-brands fa-facebook-messenger"></i><br>No messages yet.<br>Messages from users will appear here automatically.</div>';
}

function renderChatMessages(messages) {
  const chatMessages = document.getElementById('chatMessages');
  if (!chatMessages || !messages) return;

  if (messages.length === 0) {
    chatMessages.innerHTML = '<div style="text-align:center;padding:20px;color:var(--text3)">No messages yet</div>';
    return;
  }

  chatMessages.innerHTML = messages.map(m => {
    const isMe = m.is_from_user === 0;
    const time = formatChatTime(m.sent_at);
    let content = escHtml(m.content || '');
    if (m.has_attachment && m.attachment_url) {
      if (m.attachment_type === 'image') {
        content += '<br><img src="' + m.attachment_url + '" style="max-width:200px;border-radius:8px;margin-top:6px">';
      } else {
        content += '<br><a href="' + m.attachment_url + '" target="_blank" style="color:var(--primary-light)"><i class="fa-solid fa-paperclip"></i> Attachment</a>';
      }
    }
    return `
      <div class="chat-msg ${isMe ? 'from-me' : 'from-user'}">
        <div class="chat-msg-bubble">${content}</div>
        <div class="chat-msg-time">${time}</div>
      </div>
    `;
  }).join('');

  chatMessages.scrollTop = chatMessages.scrollHeight;
}

async function sendChatMessage() {
  const chatInput = document.getElementById('chatInput');
  if (!chatInput || !chatInput.value.trim()) return;

  const text = chatInput.value.trim();
  chatInput.value = '';

  // Validate we have required data
  if (!currentChatPsid) {
    showStatus('No conversation selected', 'error');
    return;
  }

  if (!currentChatPageId) {
    showStatus('No page selected', 'error');
    return;
  }

  // Show immediately
  const chatMessages = document.getElementById('chatMessages');
  if (chatMessages) {
    const html = `
      <div class="chat-msg from-me" id="tempMsg">
        <div class="chat-msg-bubble">${escHtml(text)}</div>
        <div class="chat-msg-time">sending...</div>
      </div>
    `;
    chatMessages.insertAdjacentHTML('beforeend', html);
    chatMessages.scrollTop = chatMessages.scrollHeight;
  }

  if (typeof fbGet === 'undefined') {
    showStatus('Facebook API not available', 'error');
    return;
  }

  try {
    const pageData = window.loadedPages?.find(p => p.id === currentChatPageId);
    const token = pageData?.access_token;

    if (!token) {
      showStatus('Page access token not found. Please re-connect your page.', 'error');
      return;
    }

    // Always use fbPost (same technique as broadcast) - works regardless of 24hr window
    await sendNormalMessage(text, token);

    // Update temp message
    const tempMsg = document.getElementById('tempMsg');
    if (tempMsg) {
      tempMsg.querySelector('.chat-msg-time').textContent = 'sent';
    }

    // Save sent message to database
    saveMessagesToDB(currentChatPageId, currentChatPsid.replace(/^t_/, ''), [{
      id: 'sent_' + Date.now(),
      content: text,
      sent_at: new Date().toISOString(),
      is_from_user: 0, // 0 = from me (page)
      has_attachment: 0,
      attachment_url: null,
      attachment_type: null,
    }]);

    // Update conversation last message
    updateConversationLastMessage(currentChatPageId, currentChatPsid, text);

    showStatus('Message sent!', 'success');
  } catch (err) {
    const errorMsg = err?.message || err?.error?.message || JSON.stringify(err) || 'Unknown error';
    showStatus('Failed to send: ' + errorMsg, 'error');
    console.error('Send message error:', err);
  }
}

// Check if 24-hour messaging window is still open
async function check24HourWindow(psid, pageId) {
  try {
    // Get conversation to check last message time
    const resp = await fetch(`messenger_api.php?action=get_conversation&page_id=${encodeURIComponent(pageId)}&psid=${encodeURIComponent(psid)}`, {
      headers: { 'Authorization': 'Bearer ' + (window.APP_CONFIG?.csrfToken || '') }
    });
    if (resp.ok) {
      const data = await resp.json();
      if (data.conversation?.last_message_at) {
        const lastMsgTime = new Date(data.conversation.last_message_at);
        const now = new Date();
        const hoursDiff = (now - lastMsgTime) / (1000 * 60 * 60);
        return hoursDiff < 24;
      }
    }
  } catch (e) {
    // Fallback: check from loaded conversations
  }

  // Also check local data (use psid for comparison)
  const conv = messengerConversations.find(c => c.psid === psid);
  if (conv?.last_message_at) {
    const lastMsgTime = new Date(conv.last_message_at);
    const now = new Date();
    const hoursDiff = (now - lastMsgTime) / (1000 * 60 * 60);
    return hoursDiff < 24;
  }

  // If no data, assume window is closed (safer)
  return false;
}

// Send normal Messenger message (free, within 24hr)
async function sendNormalMessage(text, token) {
  const cleanId = cleanPsid(currentChatPsid);
  console.log('Sending message:', {
    originalPsid: currentChatPsid,
    cleanPsid: cleanId,
    pageId: currentChatPageId,
    text: text.substring(0, 50),
    tokenExists: !!token
  });

  if (!cleanId || !cleanId.match(/^\d+$/)) {
    throw new Error('Invalid PSID: ' + JSON.stringify(currentChatPsid));
  }

  if (!token) {
    throw new Error('Page access token is missing. Please re-connect your page.');
  }

  if (!currentChatPageId) {
    throw new Error('Page ID is missing. Please re-select the page.');
  }

  const resp = await fbPost(`${currentChatPageId}/messages`, token, {
    recipient: { id: cleanId },
    message: { text: text }
  });
  console.log('Message sent successfully:', resp);
  return resp;
}

async function sendBroadcastMessage(text, token) {
  const cleanId = cleanPsid(currentChatPsid);
  if (!currentChatPageId) {
    throw new Error('Page ID is missing. Please re-select the page.');
  }
  const resp = await fbPost(`${currentChatPageId}/messages`, token, {
    recipient: { id: cleanId },
    message: { text: text }
  });
  return resp;
}

function handleChatKeydown(e) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendChatMessage();
  }
}

function filterConversations() {
  const searchInput = document.getElementById('messengerSearch');
  const query = (searchInput?.value || '').toLowerCase();

  if (!query) {
    renderMessengerConvs();
    return;
  }

  const filtered = messengerConversations.filter(c =>
    (c.user_name || '').toLowerCase().includes(query) ||
    (c.last_message || '').toLowerCase().includes(query)
  );

  const listEl = document.getElementById('messengerConvList');
  if (!listEl) return;

  if (filtered.length === 0) {
    listEl.innerHTML = '<div class="mc-empty"><i class="fa-solid fa-search"></i><p>No results found</p></div>';
    return;
  }

  // Temporarily swap for filtered render
  const saved = messengerConversations;
  messengerConversations = filtered;
  renderMessengerConvs();
  messengerConversations = saved;
}

function startMessengerPolling() {
  stopMessengerPolling();
  const msngView = document.getElementById('view-messenger');
  if (msngView && msngView.style.display !== 'none') {
    return;
  }
  // Poll every 5 seconds using efficient API
  messengerPollInterval = setInterval(async () => {
    if (document.getElementById('view-messenger')?.style.display !== 'none') {
      stopMessengerPolling();
      return;
    }
    if (!currentChatPageId) return;
    try {
      const resp = await fetch(`messenger_api.php?action=recent_changes&page_id=${encodeURIComponent(currentChatPageId)}&since=${encodeURIComponent(lastPollTime || '')}`, {
        headers: { 'Authorization': 'Bearer ' + (window.APP_CONFIG?.csrfToken || '') }
      });
      if (resp.ok) {
        const data = await resp.json();
        lastPollTime = data.server_time;

        // Update unread badge
        const countEl = document.getElementById('messengerConvCount');
        if (countEl && data.total_unread > 0) {
          countEl.textContent = data.total_unread;
        }

        // If in chat, check for new messages
        // messages have user_id field (psid), not psid
        const cleanPsidForFilter = String(currentChatPsid || '').replace(/^t_/, '');
        if (currentChatPsid && data.messages) {
          const myMessages = data.messages.filter(m => m.user_id === cleanPsidForFilter);
          if (myMessages.length > 0) {
            await loadChatMessages(currentChatPsid, currentChatPageId);
          }
        }

        // Update conversation list if changed
        if (data.conversations && data.conversations.length > 0) {
          messengerConversations = data.conversations;
          renderMessengerConvs();
        }
      }
    } catch (e) {
      // Silent poll fail
    }
  }, 5000);
}

function stopMessengerPolling() {
  if (messengerPollInterval) {
    clearInterval(messengerPollInterval);
    messengerPollInterval = null;
  }
}

async function saveMessengerToDB(pageId, conversations) {
  if (!pageId || !conversations || conversations.length === 0) return;
  try {
    const formData = new FormData();
    formData.append('action', 'save_conversations');
    formData.append('fb_user_id', window.fbUserId || '');
    formData.append('page_id', pageId);
    // Map conversations to DB format: unread_count -> is_unread
    const dbConversations = conversations.map(c => ({
      ...c,
      snippet: c.last_message || c.snippet || '',
      is_unread: c.unread_count || 0,
    }));
    formData.append('conversations', JSON.stringify(dbConversations));
    const resp = await fetch('messenger_api.php', { method: 'POST', body: formData });
    if (!resp.ok) console.error('Failed to save conversations:', resp.status);
  } catch (e) {
    console.error('Error saving conversations:', e);
  }
}

async function saveMessagesToDB(pageId, psid, messages) {
  if (!pageId || !psid || !messages || messages.length === 0) return;
  try {
    const formData = new FormData();
    formData.append('action', 'save_messages');
    formData.append('page_id', pageId);
    formData.append('psid', psid);
    formData.append('messages', JSON.stringify(messages));
    await fetch('messenger_api.php', {
      method: 'POST',
      body: formData,
      headers: { 'Authorization': 'Bearer ' + (window.APP_CONFIG?.csrfToken || '') }
    });
  } catch (e) {
    console.error('Failed to save messages:', e);
  }
}

async function updateConversationLastMessage(pageId, psid, lastMessage) {
  try {
    const formData = new FormData();
    formData.append('action', 'update_conversation');
    formData.append('page_id', pageId);
    formData.append('psid', psid);
    formData.append('last_message', lastMessage);
    await fetch('messenger_api.php', { method: 'POST', body: formData });
  } catch (e) {
    // Silent fail
  }
}
