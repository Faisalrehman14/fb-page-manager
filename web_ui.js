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
  const delay = Math.max(500, parseInt($('delayMs')?.value, 10) || 1200);
  const adviceEl = $('intelAdvice');

  const hasLoadedAudience = !!allRecipients.length && recipientsPageId === pageId;
  const audienceCount = hasLoadedAudience ? allRecipients.length : 0;
  const audienceLabel = hasLoadedAudience
    ? `${audienceCount.toLocaleString()} loaded`
    : (pageId ? 'Auto-load on start' : 'Select page first');
  setIntelValue('intelAudience', audienceLabel);

  let pace = 'Balanced';
  let paceRisk = 'low';
  if (delay < 900) { pace = 'Aggressive'; paceRisk = 'high'; }
  else if (delay < 1800) { pace = 'Balanced'; paceRisk = 'medium'; }
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
  if (delay < 900) riskPoints += 1;
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
  btn.classList.toggle('loading', !!loading);
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
  if (!silent) {
    showStatus('Loading pages from Facebook…', 'info');
  }
  const pages = await runWithRetry(async () => fetchUserPages(), { label: 'Loading pages', maxAttempts: 2 });
  renderPages(pages || []);
  uiTrackEvent('pages_refresh_success', { count: (pages || []).length, source: silent ? 'auto' : 'manual' });
  if (!silent) {
    if ((pages || []).length === 0) {
      showStatus('No pages found. Confirm app permissions and page admin access.', 'warning');
    } else {
      showStatus(`${(pages || []).length} page(s) loaded.`, 'success');
    }
  }
  return pages || [];
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

function renderPages(pages) {
  const container = $('pageCards');
  const select = $('pageSelect');
  if (!container || !select) return;
  container.innerHTML = '';
  select.innerHTML = '';

  const pgCount = document.getElementById('sidebarPageCount');
  if (!pages || pages.length === 0) {
    container.innerHTML = `<div class="pages-empty"><i class="fa-brands fa-facebook"></i><p>No pages found.</p></div>`;
    if (pgCount) pgCount.style.display = 'none';
    return;
  }
  if (pgCount) { pgCount.textContent = pages.length; pgCount.style.display = ''; }
  window.loadedPages = pages;

  pages.forEach(p => {
    const opt = document.createElement('option');
    opt.value = p.id;
    select.appendChild(opt);

    const picUrl = p.picture?.data?.url || '';
    const initial = (p.name || '?').charAt(0).toUpperCase();
    const card = document.createElement('div');
    card.className = 'page-card';
    card.dataset.id = p.id;
    card.innerHTML = `
      ${picUrl
        ? `<img class="page-avatar" src="${escHtml(picUrl)}" alt="" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'">`
        : ''}
      <div class="page-avatar-fallback" style="${picUrl ? 'display:none' : ''}">${escHtml(initial)}</div>
      <div class="page-info">
        <div class="page-name">${escHtml(p.name)}</div>
        ${p.category ? `<div class="page-category">${escHtml(p.category)}</div>` : ''}
      </div>
      <div class="page-indicator"></div>
    `;
    card.addEventListener('click', () => {
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
    container.appendChild(card);
  });
  if (pages.length > 0) container.querySelector('.page-card')?.click();
}

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
    const statusClass = { sent: 'badge-sent', failed: 'badge-failed', pending: 'badge-pending' }[r.status] || 'badge-pending';
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
  // enable retry/export when there's data
  const retryBtn = $('btnRetryFailed'), exportBtn = $('btnExportCSV');
  if (retryBtn) retryBtn.disabled = failed === 0;
  if (exportBtn) exportBtn.disabled = (sent + failed) === 0;
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
}

function updateRecipientRow(item) {
  const r = allRecipients.find(r => r.id === item.id);
  if (r) { r.status = item.status; r.error = item.error || ''; if(item.status==='sent') r.sentAt = Date.now(); }
  const row = $('recipients')?.querySelector(`[data-id="${item.id}"]`);
  if (!row) return;
  const badge = row.querySelector('.badge');
  const error = row.querySelector('.err');
  const statusClass = { sent: 'badge-sent', failed: 'badge-failed', pending: 'badge-pending' }[item.status] || 'badge-pending';
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
  }

  function clearImage() {
    currentImageUrl = '';
    if (previewImg) previewImg.src = '';
    if (previewWrap) previewWrap.style.display = 'none';
    if (badge) badge.style.display = 'none';
    if (urlInput) urlInput.value = '';
    if (fileInput) fileInput.value = '';
    // Show back the active tab area
    const isUpload = tabUpload && tabUpload.classList.contains('active');
    if (urlArea) urlArea.style.display = isUpload ? 'none' : '';
    if (uploadArea) uploadArea.style.display = isUpload ? '' : 'none';
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

  // File input
  fileInput?.addEventListener('change', () => { if (fileInput.files[0]) handleFile(fileInput.files[0]); });
  dropZone?.addEventListener('click', () => fileInput?.click());
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
      if (dropZone)   dropZone.style.display = '';
    } finally {
      if (uploadProg) uploadProg.style.display = 'none';
    }
  }

  // Clear button
  clearBtn?.addEventListener('click', clearImage);
}

// ── DOM Initialization ─────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  initFromStorage();
  initImagePanel();

  const btnLogin = $('btnLogin'), btnFetchPages = $('btnFetchPages'),
        btnStart = $('btnStart'), btnPause = $('btnPause'), btnResume = $('btnResume'), btnStop = $('btnStop'),
        recipientFilter = $('recipientFilter'), messageText = $('messageText'), delayMs = $('delayMs');

  recipientFilter?.addEventListener('change', () => { renderRecipients(); updateSendHint(); });

  messageText?.addEventListener('input', () => {
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
    setLoading(btnFetchPages, true);
    btnFetchPages.classList.add('spinning');
    uiTrackEvent('pages_refresh_click', { source: 'manual' });
    try {
      await loadPagesFromFacebook({ silent: false });
    } catch (e) {
      uiTrackEvent('pages_refresh_error', { message: e.message || 'failed_to_fetch_pages' });
      const msg = e && e.message ? e.message : 'Failed to fetch pages.';
      showStatus(msg, 'error');
      if (typeof window.showToast === 'function') {
        window.showToast('Refresh failed: ' + msg, 'error');
      }
    }
    btnFetchPages.classList.remove('spinning');
    setLoading(btnFetchPages, false);
  });

  btnStart?.addEventListener('click', async () => {
    const pageId = $('pageSelect')?.value, text = messageText?.value.trim(), delay = Math.max(500, parseInt(delayMs?.value, 10) || 1200);
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
      return showStatus('User session not initialized. Please refresh the page.', 'warning');
    }

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
      setLoading(btnStart, false);
      return;
    }

    if (!recipientIds.length) {
      showStatus('No conversations found for this page.', 'warning');
      setLoading(btnStart, false);
      return;
    }

    uiTrackEvent('broadcast_start', { mode: 'manual', pageId, recipients: recipientIds.length, delayMs: delay });
    isManualBroadcastRunning = true;
    activeBroadcastPageId = pageId;
    sendStartTime = Date.now();
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
        onDone: () => {
          isManualBroadcastRunning = false;
          activeBroadcastPageId = null;
          $('progressBar')?.classList.remove('progress-bar--active');
          setLoading(btnStart, false);
          if ($('etaText')) $('etaText').textContent = '';
          showStatus('All messages processed.', 'success');
          uiTrackEvent('broadcast_complete', { mode: 'manual', pageId });
          if(window.updateQuotaUI) window.updateQuotaUI();
        }
      });
    } catch (e) {
      isManualBroadcastRunning = false;
      activeBroadcastPageId = null;
      $('progressBar')?.classList.remove('progress-bar--active');
      uiTrackEvent('broadcast_error', { mode: 'manual', pageId, message: e.message || 'failed_to_start' });
      showStatus(e.message || 'Failed to start.', 'error');
      setLoading(btnStart, false);
    }
  });

  btnPause?.addEventListener('click', () => { pauseSending(); uiTrackEvent('broadcast_pause', { mode: 'manual' }); showStatus('Paused.', 'warning'); });
  btnResume?.addEventListener('click', () => { resumeSending(); uiTrackEvent('broadcast_resume', { mode: 'manual' }); showStatus('Resumed.', 'info'); });
  btnStop?.addEventListener('click', () => {
    stopSending();
    isManualBroadcastRunning = false;
    activeBroadcastPageId = null;
    uiTrackEvent('broadcast_stop', { mode: 'manual' });
    $('progressBar')?.classList.remove('progress-bar--active');
    setLoading(btnStart, false);
    if ($('etaText')) $('etaText').textContent = '';
    showStatus('Stopped.', 'error');
  });

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

  // Export results as CSV
  btnExportCSV?.addEventListener('click', () => {
    const rows = allRecipients.filter(r => r.status === 'sent' || r.status === 'failed');
    if (!rows.length) { showStatus('No results to export.', 'warning'); return; }
    const csv = ['PSID,Status,Error', ...rows.map(r => `"${r.id}","${r.status}","${(r.error||'').replace(/"/g,'""')}"`)].join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
    a.download = `fbcast_results_${Date.now()}.csv`;
    a.click();
    showStatus(`Exported ${rows.length} results.`, 'success');
  });

  // Quick action: retry all
  $('qaRetryAll')?.addEventListener('click', () => btnRetryFailed?.click());
  // Quick action: export
  $('qaExport')?.addEventListener('click', () => btnExportCSV?.click());
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
window.switchDashboardView = switchDashboardView;
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
  document.querySelectorAll('#svPagesList .sv2-page-item').forEach(el => {
    el.classList.add('selected');
    const cb = el.querySelector('input[type=checkbox]');
    if (cb) cb.checked = true;
  });
};
window.svSelectNonePages = function () {
  document.querySelectorAll('#svPagesList .sv2-page-item').forEach(el => {
    el.classList.remove('selected');
    const cb = el.querySelector('input[type=checkbox]');
    if (cb) cb.checked = false;
  });
};

function svPopulatePages() {
  const box = $('svPagesList');
  if (!box) return;
  const pages = window.loadedPages || [];
  if (!pages.length) {
    box.innerHTML = '<div class="sv2-pages-empty"><i class="fa-solid fa-circle-info"></i> No pages connected yet.</div>';
    return;
  }
  box.innerHTML = pages.map(p => {
    const initial = (p.name || p.id || '?')[0].toUpperCase();
    return `<div class="sv2-page-item" onclick="this.classList.toggle('selected');this.querySelector('input').checked=this.classList.contains('selected')" >
      <input type="checkbox" value="${escHtml(p.id)}" data-token="${escHtml(p.access_token || '')}" data-name="${escHtml(p.name || p.id)}" checked style="display:none">
      <div class="sv2-page-avatar">${initial}</div>
      <div class="sv2-page-name">${escHtml(p.name || p.id)}</div>
      <i class="fa-solid fa-circle-check sv2-page-check-icon"></i>
    </div>`;
  }).join('');
  box.querySelectorAll('.sv2-page-item').forEach(el => el.classList.add('selected'));
}

window.svLoadSchedules = async function () {
  try {
    const res  = await fetch('/api/schedules', { credentials: 'same-origin' });
    const data = await res.json();
    svRenderSchedules(data.schedules || []);
  } catch (_) {}
};

function svRenderSchedules(list) {
  const listEl  = $('svList');
  const emptyEl = $('svListEmpty');
  const badge   = $('svBadge');
  if (!listEl) return;

  const pending = list.filter(s => s.status === 'pending' || s.status === 'running');
  if (badge) {
    const countEl = document.getElementById('svBadgeCount');
    if (countEl) countEl.textContent = pending.length;
    badge.style.display = pending.length ? '' : 'none';
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
          <i class="fa-regular fa-clock"></i> ${timeStr}
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
  const checks = Array.from(document.querySelectorAll('#svPagesList input[type=checkbox]:checked'));
  if (!checks.length) { showStatus('Select at least one page.', 'warning'); return; }

  const pages = checks.map(cb => ({ id: cb.value, name: cb.dataset.name, token: cb.dataset.token }));
  const message = ($('svMessage')?.value || '').trim();
  if (!message) { showStatus('Write a message first.', 'warning'); return; }

  const dtVal = $('svDateTime')?.value;
  if (!dtVal) { showStatus('Select a scheduled date and time.', 'warning'); return; }

  const scheduledAt = new Date(dtVal).toISOString();
  const imageUrl    = ($('svImageUrl')?.value || '').trim();
  const delayMs     = parseInt($('svDelay')?.value, 10) || 1200;

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

// Switch between dashboard views
// NOTE: #view-scheduling lives INSIDE #view-broadcast (broadcast-view), same as
// view-analytics/settings/help. To show scheduling, we must show broadcast-view
// and hide compose/broadcast-col/stats-panel, then show view-scheduling.
function switchDashboardView(view) {
  // Update nav active state
  document.querySelectorAll('.nav-side-item').forEach(item => item.classList.remove('active'));
  const activeItem = document.getElementById('navItem' + view.charAt(0).toUpperCase() + view.slice(1));
  if (activeItem) activeItem.classList.add('active');

  // Top-level views: home, messenger, broadcast
  // 'scheduling' shows broadcast-view as its container
  const topSections = ['home', 'messenger', 'broadcast'];
  topSections.forEach(s => {
    const el = document.getElementById('view-' + s);
    if (!el) return;
    const show = s === view || (s === 'broadcast' && view === 'scheduling');
    if (show) {
      el.style.display = s === 'messenger' ? 'flex' : '';
    } else {
      el.style.display = 'none';
    }
  });

  // Inside broadcast-view: compose, broadcast-col, stats-panel visible only for 'broadcast'
  const compose   = document.querySelector('#view-broadcast .compose');
  const bcastCol  = document.querySelector('#view-broadcast .broadcast-col');
  const statsPanel = document.querySelector('.stats-panel');
  const isBroadcast = view === 'broadcast';
  if (compose)    compose.style.display    = isBroadcast ? '' : 'none';
  if (bcastCol)   bcastCol.style.display   = isBroadcast ? '' : 'none';
  if (statsPanel) statsPanel.style.display = isBroadcast ? '' : 'none';

  // Inside broadcast-view: scheduling panel
  const schedEl = document.getElementById('view-scheduling');
  if (schedEl) schedEl.style.display = view === 'scheduling' ? 'flex' : 'none';

  // Hide the main nav sidebar when in scheduling view (full-width layout)
  const mainSidebar = document.querySelector('.sidebar');
  if (mainSidebar) mainSidebar.style.display = view === 'scheduling' ? 'none' : '';

  // Load data
  if (view === 'home')       updateHomeViewStats();
  if (view === 'messenger')  loadMessengerConversations();
  if (view === 'scheduling') { svPopulatePages(); svSetMinDatetime(); svLoadSchedules(); }

  if (view !== 'broadcast') showStatus('Viewing ' + view + '...', 'info');
}

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
  if (quotaVal && quotaTotal) {
    const used = parseInt(quotaTotal.textContent.replace(/,/g, '') || '0') - parseInt(quotaVal.textContent.replace(/,/g, '') || '0');
    const total2 = parseInt(quotaTotal.textContent.replace(/,/g, '') || '2000');
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
  let pageId = pageSelect?.value || window.current_page_id || window.currentPageId || '';

  // Primary: Messenger system (messenger.js) — matches the msng-* HTML in dashboard
  if (typeof window.msngInit === 'function') {
    if (pageId) window.currentPageId = pageId;
    window.msngInit(0);
    return;
  }

  // Fallback: Inbox system (inbox.js) — only if standalone inbox.html is used
  if (typeof window.initInboxForMainSite === 'function') {
    await window.initInboxForMainSite();
    return;
  }

  // If no page selected, try to get first loaded page
  if (!pageId && window.loadedPages && window.loadedPages.length > 0) {
    pageId = window.loadedPages[0].id;
    if (pageSelect) pageSelect.value = pageId;
  }

  if (!pageId) {
    showStatus('Select a page first to load conversations', 'warn');
    return;
  }

  window.currentPageId = pageId;

  const listEl = document.getElementById('messengerConvList');
  const countEl = document.getElementById('messengerConvCount');
  if (!listEl) return;

  showStatus('Loading conversations...', 'info');

  // Load from DB API first (fast)
  let hasDBData = false;
  try {
    const resp = await fetch(`messenger_api.php?action=load_conversations&fb_user_id=${encodeURIComponent(window.fbUserId || '')}&page_id=${encodeURIComponent(pageId)}`, {
      headers: { 'Authorization': 'Bearer ' + (window.APP_CONFIG?.csrfToken || '') }
    });
    if (resp.ok) {
      const data = await resp.json();
      if (data.conversations && data.conversations.length > 0) {
        // Map DB fields to app fields
        messengerConversations = data.conversations.map(c => ({
          id: c.id,
          psid: c.fb_user_id || c.page_id || '', // fb_user_id is actually the PSID in DB
          user_name: c.user_name || 'Unknown',
          user_picture: c.user_picture || null,
          last_message: c.snippet || c.last_message || '',
          last_message_at: c.updated_at || c.last_message_at,
          unread_count: c.is_unread || c.unread_count || 0,
          page_id: c.page_id
        }));
        renderMessengerConvs();
        hasDBData = true;
        showStatus('Loaded ' + messengerConversations.length + ' conversations from DB', 'success');
      }
    }
  } catch (e) {
    console.log('DB load failed:', e);
  }

  // Also refresh from Facebook API
  if (typeof fbGet !== 'undefined') {
    try {
      const pageData = window.loadedPages?.find(p => p.id === pageId);
      const token = pageData?.access_token;
      if (!token) {
        showStatus('Page access token not found. Re-connect your page.', 'warn');
        return;
      }

      const data = await fbGet(`${pageId}/conversations`, token, {
        fields: 'id,updated_time,senders{data=name,picture},last_message',
        limit: 100
      });
      if (data && data.data && data.data.length > 0) {
        const newConvs = data.data.map(c => {
          const sender = c.senders?.data?.[0] || {};
          const lastMsg = c.last_message || {};
          // Keep raw ID for API calls, clean for sending
          const rawId = c.id || ''; // This is the thread/conversation ID (t_xxx)
          const senderId = sender.id || ''; // This is the actual PSID of the user
          return {
            psid: senderId, // User's actual PSID for sending messages
            conversation_id: rawId, // Conversation/thread ID for loading messages
            user_name: sender.name || 'Unknown',
            user_picture: sender.picture?.data?.url || null,
            last_message: lastMsg.text || '',
            last_message_at: c.updated_time,
            unread_count: 0,
            is_blocked: 0,
            page_id: pageId
          };
        });

        // Sync to DB
        saveMessengerToDB(pageId, newConvs);

        messengerConversations = newConvs;
        renderMessengerConvs();
        showStatus('Loaded ' + messengerConversations.length + ' conversations from Facebook', 'success');
      } else if (!hasDBData) {
        listEl.innerHTML = '<div class="mc-empty"><i class="fa-brands fa-facebook-messenger"></i><p>No conversations found.<br>Messages will appear here when users message your page on Facebook.</p><button class="hcp-connect-btn" onclick="switchDashboardView(\'broadcast\')"><i class="fa-solid fa-bullhorn"></i> Go to Broadcast</button></div>';
        showStatus('No conversations yet', 'info');
      }
    } catch (err) {
      console.error('Facebook API error:', err);
      if (!hasDBData) {
        showStatus('Facebook API error: ' + err.message, 'error');
      }
    }
  } else if (!hasDBData && messengerConversations.length === 0) {
    listEl.innerHTML = '<div class="mc-empty"><i class="fa-solid fa-plug"></i><p>Facebook API not loaded.<br>Make sure you are connected with Facebook.</p></div>';
  }

  // Set initial poll time
  lastPollTime = new Date().toISOString();
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

  const resp = await fbPost('me/messages', token, {
    recipient: { id: cleanId },
    message: { text: text }
  });
  console.log('Message sent successfully:', resp);
  return resp;
}

async function sendBroadcastMessage(text, token) {
  const cleanId = cleanPsid(currentChatPsid);
  // 24hr window closed - try sending anyway (may fail if no prior opt-in)
  // Remove the tag since it requires Facebook approval
  const resp = await fbPost('me/messages', token, {
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
  // Poll every 5 seconds using efficient API
  messengerPollInterval = setInterval(async () => {
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
