/**
 * Multi-page parallel broadcast — different message per page, sent at the same time.
 */
(function () {
  'use strict';

  let multiRunning = false;
  /** @type {Record<string, { url: string, label?: string }>} */
  const multiPageImages = {};

  function toDisplayUrl(url) {
    if (!url) return '';
    if (/^https?:\/\//i.test(url) || url.startsWith('data:')) return url;
    if (url.startsWith('/')) return window.location.origin + url;
    return url;
  }

  function imageLabelFromUrl(url, fallback) {
    if (fallback) return fallback;
    return (url || '').split('/').pop()?.split('?')[0] || 'Image';
  }

  function setPageImage(pageId, url, label) {
    if (!pageId || !url) return;
    multiPageImages[String(pageId)] = {
      url,
      label: label || imageLabelFromUrl(url)
    };
  }

  function clearPageImage(pageId) {
    delete multiPageImages[String(pageId)];
  }

  function getPageImage(pageId) {
    return multiPageImages[String(pageId)] || null;
  }

  function resolvePageImageUrl(pageId) {
    const custom = getPageImage(pageId);
    if (custom?.url) return custom.url;
    return getMultiImageUrl();
  }

  function esc(s) {
    return String(s ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function escTextarea(s) {
    return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;');
  }

  function getPages() {
    return window.loadedPages || JSON.parse(localStorage.getItem('fb_pages') || '[]') || [];
  }

  function getMultiSelectedPages() {
    const cards = Array.from(document.querySelectorAll('#pageCards .page-card.multi-selected'));
    const pages = getPages();
    return cards
      .map((card) => pages.find((p) => String(p.id) === String(card.dataset.id)))
      .filter(Boolean);
  }

  function updateMultiPageCount() {
    const n = document.querySelectorAll('#pageCards .page-card.multi-selected').length;
    const total = getPages().length;
    let label;
    if (!n) label = 'No pages selected';
    else if (n === total && total > 0) label = `All ${n} pages selected`;
    else label = `${n} of ${total} selected`;

    const el = document.getElementById('multiPageCount');
    if (el) {
      el.textContent = !n
        ? 'No pages selected — click pages in the sidebar'
        : (n === total && total > 0 ? `All ${n} pages selected` : `${n} page${n === 1 ? '' : 's'} selected`);
    }

    const sidebarEl = document.getElementById('sidebarSchedSelection');
    if (sidebarEl) sidebarEl.textContent = label;

    const hintEl = document.getElementById('sidebarSchedHint');
    if (hintEl) {
      if (!total) hintEl.textContent = 'Connect Facebook to load your pages';
      else if (!n) hintEl.textContent = 'Click pages below to set per-page messages & images';
      else if (n === total) hintEl.textContent = 'All pages selected — ready to broadcast';
      else hintEl.textContent = 'Selected pages will receive custom messages';
    }

    updateMultiStartButton();
  }

  function rebuildMultiPageMessages() {
    const wrap = document.getElementById('multiPageMessages');
    if (!wrap) return;
    const selected = getMultiSelectedPages();
    const existingMsg = {};
    const existingUrl = {};
    wrap.querySelectorAll('[data-page-id]').forEach((row) => {
      const id = row.getAttribute('data-page-id');
      const ta = row.querySelector('textarea');
      const urlInput = row.querySelector('.bcast-page-msg__url');
      if (id && ta) existingMsg[id] = ta.value;
      if (id && urlInput) existingUrl[id] = urlInput.value;
    });
    if (!selected.length) {
      wrap.innerHTML =
        '<p class="bcast-page-msgs__empty">Click pages in the sidebar to set per-page messages and images.</p>';
      updateMultiImageAttach();
      return;
    }
    const mainMsg = document.getElementById('messageText')?.value?.trim() || '';
    const sharedImg = getMultiImageUrl();
    const hasMainImg = !!sharedImg;
    wrap.innerHTML = selected
      .map((p) => {
        const val = existingMsg[p.id] !== undefined ? existingMsg[p.id] : mainMsg;
        const pageImg = getPageImage(p.id);
        const imgUrl = pageImg?.url || '';
        const urlField = existingUrl[p.id] !== undefined ? existingUrl[p.id] : '';
        const placeholder = imgUrl || sharedImg
          ? 'Optional caption (leave blank for image-only)…'
          : 'Message for this page…';
        const preview = imgUrl
          ? `<div class="bcast-page-msg__img-preview">
              <img src="${esc(toDisplayUrl(imgUrl))}" alt="${esc(pageImg.label || '')}">
              <button type="button" class="bcast-page-msg__img-clear" data-action="clear-img" data-page-id="${esc(p.id)}" title="Remove image"><i class="fa-solid fa-xmark"></i></button>
            </div>`
          : '';
        const useMainBtn = hasMainImg
          ? `<button type="button" class="bcast-page-msg__mini-btn" data-action="use-main" data-page-id="${esc(p.id)}"><i class="fa-solid fa-link"></i> Main image</button>`
          : '';
        return `<div class="bcast-page-msg" data-page-id="${esc(p.id)}">
          <label class="bcast-page-msg__label" for="multi-msg-${esc(p.id)}">${esc(p.name || p.id)}</label>
          <textarea id="multi-msg-${esc(p.id)}" class="bcast-page-msg__input" rows="3" maxlength="2000" placeholder="${esc(placeholder)}">${escTextarea(val)}</textarea>
          ${preview}
          <div class="bcast-page-msg__img-row">
            <label class="bcast-page-msg__upload-btn">
              <i class="fa-solid fa-cloud-arrow-up"></i> Upload
              <input type="file" class="bcast-page-msg__file" accept="image/jpeg,image/png,image/gif,image/webp" data-page-id="${esc(p.id)}" hidden>
            </label>
            <input type="url" class="bcast-page-msg__url" placeholder="Image URL…" data-page-id="${esc(p.id)}" value="${esc(urlField)}">
            <button type="button" class="bcast-page-msg__mini-btn" data-action="load-url" data-page-id="${esc(p.id)}">Load</button>
            ${useMainBtn}
          </div>
        </div>`;
      })
      .join('');
    updateMultiImageAttach();
    updateMultiStartButton();
  }

  function getPerPageMessages() {
    const map = {};
    document.querySelectorAll('#multiPageMessages .bcast-page-msg').forEach((row) => {
      const id = row.getAttribute('data-page-id');
      const ta = row.querySelector('textarea');
      if (id && ta) map[id] = ta.value.trim();
    });
    return map;
  }

  function getMultiImageUrl() {
    if (typeof window.getBroadcastImageUrl === 'function') {
      const url = window.getBroadcastImageUrl();
      if (url) return url;
    }
    return window._imgAttachUrl || '';
  }

  function updateMultiImageAttach() {
    const card = document.getElementById('multiImageAttach');
    const thumb = document.getElementById('multiImageThumb');
    const nameEl = document.getElementById('multiImageName');
    const hint = document.getElementById('multiImageHint');
    const imgUrl = getMultiImageUrl();
    const show = !!imgUrl && document.body.classList.contains('shell-multi-broadcast');

    if (card) card.hidden = !show;
    if (hint) hint.style.display = 'none';

    if (!show) return;

    const label =
      (typeof window.getBroadcastImageLabel === 'function' && window.getBroadcastImageLabel()) ||
      imgUrl.split('/').pop()?.split('?')[0] ||
      'Attached image';

    if (thumb) {
      thumb.src = toDisplayUrl(imgUrl);
      thumb.alt = label;
    }
    if (nameEl) nameEl.textContent = label.length > 42 ? label.slice(0, 40) + '…' : label;
  }

  function updateMultiImageHint() {
    updateMultiImageAttach();
  }

  function hasMultiBroadcastReady() {
    const selected = getMultiSelectedPages();
    if (!selected.length) return false;
    const perPage = getPerPageMessages();
    const mainMsg = document.getElementById('messageText')?.value?.trim() || '';
    return selected.every((p) => {
      const msg = (perPage[p.id] || mainMsg).trim();
      const img = resolvePageImageUrl(p.id);
      return msg.length > 0 || !!img;
    });
  }

  function updateMultiStartButton() {
    const start = document.getElementById('btnMultiStart');
    if (!start || !document.body.classList.contains('shell-multi-broadcast')) return;
    updateMultiImageHint();
    if (multiRunning) return;
    const canStart = hasMultiBroadcastReady();
    start.disabled = !canStart;
    start.setAttribute('aria-disabled', canStart ? 'false' : 'true');
  }

  function applyMainImageToAll() {
    const url = getMultiImageUrl();
    const label =
      (typeof window.getBroadcastImageLabel === 'function' && window.getBroadcastImageLabel()) || '';
    if (!url) {
      if (typeof window.showToast === 'function') {
        window.showToast('Attach an image in the compose area first.', 'warning');
      }
      return;
    }
    getMultiSelectedPages().forEach((p) => setPageImage(p.id, url, label));
    rebuildMultiPageMessages();
    if (typeof window.showToast === 'function') {
      window.showToast('Main image applied to all selected pages', 'success');
    }
  }

  async function uploadPageImage(pageId, file) {
    const allowed = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
    if (!allowed.includes(file.type)) {
      if (typeof window.showToast === 'function') {
        window.showToast('Only JPEG, PNG, GIF, WebP allowed.', 'error');
      }
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      if (typeof window.showToast === 'function') {
        window.showToast('File too large. Max 5 MB.', 'error');
      }
      return;
    }
    try {
      const csrfToken = typeof window.getCsrfToken === 'function' ? await window.getCsrfToken() : '';
      const formData = new FormData();
      formData.append('image', file);
      const res = await fetch('/api/upload-image', {
        method: 'POST',
        headers: csrfToken ? { 'X-CSRF-Token': csrfToken } : {},
        body: formData
      });
      const data = await res.json();
      if (data.success && data.url) {
        setPageImage(pageId, data.url, file.name);
        rebuildMultiPageMessages();
        if (typeof window.showToast === 'function') {
          window.showToast('Image uploaded for page', 'success');
        }
      } else {
        throw new Error(data.error || 'Upload failed');
      }
    } catch (e) {
      if (typeof window.showToast === 'function') {
        window.showToast(e.message || 'Upload failed', 'error');
      }
    }
  }

  function loadPageImageFromUrl(pageId) {
    const input = document.querySelector(`.bcast-page-msg__url[data-page-id="${pageId}"]`);
    const url = (input?.value || '').trim();
    if (!url) {
      if (typeof window.showToast === 'function') window.showToast('Enter an image URL.', 'warning');
      return;
    }
    const img = new Image();
    img.onload = () => {
      setPageImage(pageId, url, imageLabelFromUrl(url));
      rebuildMultiPageMessages();
      if (typeof window.showToast === 'function') window.showToast('Image loaded for page', 'success');
    };
    img.onerror = () => {
      if (typeof window.showToast === 'function') {
        window.showToast('Could not load image from URL.', 'error');
      }
    };
    img.src = url;
  }

  function handleMultiPageMediaClick(e) {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const pageId = btn.getAttribute('data-page-id');
    const action = btn.getAttribute('data-action');
    if (!pageId) return;
    if (action === 'clear-img') {
      clearPageImage(pageId);
      rebuildMultiPageMessages();
      return;
    }
    if (action === 'use-main') {
      const url = getMultiImageUrl();
      if (!url) {
        if (typeof window.showToast === 'function') {
          window.showToast('No main compose image attached.', 'warning');
        }
        return;
      }
      setPageImage(pageId, url, window.getBroadcastImageLabel?.() || '');
      rebuildMultiPageMessages();
      return;
    }
    if (action === 'load-url') loadPageImageFromUrl(pageId);
  }

  function syncMultiSelectionFromManual() {
    const cards = document.querySelectorAll('#pageCards .page-card');
    const multiSelected = document.querySelectorAll('#pageCards .page-card.multi-selected');
    if (multiSelected.length) return;
    const manualSelected = document.querySelector('#pageCards .page-card.selected');
    if (manualSelected) manualSelected.classList.add('multi-selected');
    else if (cards.length === 1) cards[0].classList.add('multi-selected');
  }

  function applyMainMessageToAll() {
    const main = document.getElementById('messageText')?.value?.trim() || '';
    const imgUrl = getMultiImageUrl();
    if (!main && !imgUrl) {
      if (typeof window.showToast === 'function') {
        window.showToast('Write a message in the main box or attach an image first.', 'warning');
      }
      return;
    }
    document.querySelectorAll('#multiPageMessages .bcast-page-msg__input').forEach((ta) => {
      ta.value = main;
    });
    const msg = main
      ? 'Applied message to all selected pages'
      : 'Cleared per-page captions — image-only send for all pages';
    if (typeof window.showToast === 'function') window.showToast(msg, 'success');
    updateMultiStartButton();
  }

  function multiSelectAllPages() {
    document.querySelectorAll('#pageCards .page-card').forEach((c) => c.classList.add('multi-selected'));
    rebuildMultiPageMessages();
    updateMultiPageCount();
  }

  function multiSelectNonePages() {
    document.querySelectorAll('#pageCards .page-card.multi-selected').forEach((c) =>
      c.classList.remove('multi-selected')
    );
    rebuildMultiPageMessages();
    updateMultiPageCount();
  }

  function clearMultiSelection() {
    multiSelectNonePages();
  }

  function setMultiStartButtonRunning(running) {
    const start = document.getElementById('btnMultiStart');
    if (!start) return;
    const idleLabel = start.dataset.labelIdle || 'Start parallel broadcast';
    const runLabel = start.dataset.labelRun || 'Broadcasting…';
    if (running) {
      start.disabled = true;
      start.classList.add('is-running');
      start.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> ' + runLabel;
    } else {
      start.classList.remove('is-running');
      start.innerHTML = '<i class="fa-solid fa-play"></i> ' + idleLabel;
    }
  }

  function setMultiButtons(state) {
    const pause = document.getElementById('btnPause');
    const resume = document.getElementById('btnResume');
    const stop = document.getElementById('btnStop');
    const idle = state === 'idle';
    if (idle) {
      setMultiStartButtonRunning(false);
      updateMultiStartButton();
    } else {
      setMultiStartButtonRunning(true);
    }
    if (pause) pause.disabled = idle;
    if (resume) resume.disabled = state !== 'paused';
    if (stop) stop.disabled = idle;
  }

  function setBroadcastMode(mode) {
    const btnManual = document.getElementById('modeManualBtn');
    const btnAuto = document.getElementById('modeAutoBtn');
    const btnMulti = document.getElementById('modeMultiBtn');
    const manual = document.getElementById('manualControls');
    const auto = document.getElementById('autoControls');
    const multi = document.getElementById('multiControls');
    document.body.classList.toggle('shell-multi-broadcast', mode === 'multi');
    [btnManual, btnAuto, btnMulti].forEach((b) => b && b.classList.remove('active'));
    if (mode === 'manual' && btnManual) btnManual.classList.add('active');
    if (mode === 'auto' && btnAuto) btnAuto.classList.add('active');
    if (mode === 'multi' && btnMulti) btnMulti.classList.add('active');
    if (manual) manual.style.display = mode === 'manual' ? '' : 'none';
    if (auto) auto.style.display = mode === 'auto' ? '' : 'none';
    if (multi) multi.style.display = mode === 'multi' ? '' : 'none';
    const hint = document.getElementById('sendHint');
    if (hint) {
      if (mode === 'multi') hint.textContent = 'Select pages, set each message/image, then start';
      else if (mode === 'auto') hint.textContent = 'Same message to all pages, one after another';
      else hint.textContent = 'Select a page, write message, then start broadcast';
    }
    const transport = document.getElementById('broadcastTransport');
    const miniStats = document.getElementById('broadcastMiniStats');
    const sendHint = document.getElementById('sendHint');
    if (transport) transport.style.display = '';
    if (miniStats) miniStats.style.display = '';
    if (sendHint) sendHint.style.display = '';
    const schedActions = document.getElementById('sidebarSchedActions');
    if (schedActions) schedActions.style.display = mode === 'multi' ? 'inline-flex' : '';
    if (mode !== 'multi') {
      clearMultiSelection();
    } else {
      syncMultiSelectionFromManual();
      rebuildMultiPageMessages();
      updateMultiPageCount();
      setMultiButtons('idle');
      updateMultiStartButton();
      updateMultiImageAttach();
    }
    window.__broadcastMode = mode;
  }

  async function resolveFbUserId() {
    let fbUserId = null;
    try {
      const storedUser = JSON.parse(localStorage.getItem('fbcast_user') || '{}');
      fbUserId = storedUser.fb_user_id || storedUser.id || null;
    } catch (_) {}
    if (!fbUserId && typeof window.syncQuotaFromServer === 'function') {
      await window.syncQuotaFromServer({ force: true, source: 'multi_send_init' });
      try {
        const storedUser = JSON.parse(localStorage.getItem('fbcast_user') || '{}');
        fbUserId = storedUser.fb_user_id || storedUser.id || null;
      } catch (_) {}
    }
    return fbUserId;
  }

  async function startMultiParallelSend() {
    if (multiRunning) return;
    if (typeof window.fbcastGuardBroadcast === 'function') {
      const guard = window.fbcastGuardBroadcast('multi');
      if (!guard.ok) {
        if (typeof window.showToast === 'function') window.showToast(guard.message, 'warning');
        return;
      }
    }
    if (typeof window.getRemaining === 'function' && window.getRemaining() <= 0) {
      if (typeof window.showUpgradeModal === 'function') window.showUpgradeModal('pro_exhausted');
      return;
    }

    const selected = getMultiSelectedPages();
    if (!selected.length) {
      if (typeof window.showToast === 'function') window.showToast('Select at least one page in the sidebar.', 'warning');
      return;
    }

    const perPage = getPerPageMessages();
    const mainMsg = document.getElementById('messageText')?.value?.trim() || '';
    const delay = Math.max(25, parseInt(document.getElementById('delayMs')?.value, 10) || 400);

    const jobs = selected.map((page) => ({
      page,
      message: (perPage[page.id] || mainMsg || '').trim(),
      imageUrl: resolvePageImageUrl(page.id) || ''
    }));

    const missing = jobs.filter((j) => !j.message && !j.imageUrl);
    if (missing.length) {
      if (typeof window.showToast === 'function') {
        window.showToast(
          `Add a message or image for: ${missing.map((j) => j.page.name).join(', ')}`,
          'warning'
        );
      }
      return;
    }

    const fbUserId = await resolveFbUserId();
    if (!fbUserId) {
      if (typeof window.showToast === 'function') {
        window.showToast('Session not ready. Refresh and connect Facebook.', 'warning');
      }
      return;
    }

    if (typeof window.fbTrackEvent === 'function') {
      window.fbTrackEvent('broadcast_start', {
        mode: 'multi_parallel',
        pages: jobs.length,
        delayMs: delay
      });
    }

    multiRunning = true;
    if (typeof runtime !== 'undefined') {
      runtime.isSending = true;
      runtime.paused = false;
    }
    setMultiButtons('running');

    if (typeof window.clearRecipients === 'function') window.clearRecipients();
    let gTotal = 0;
    let gSent = 0;
    let gFailed = 0;
    const updStats = () => {
      const t = document.getElementById('statTotal');
      const s = document.getElementById('statSent');
      const f = document.getElementById('statFailed');
      if (t) t.textContent = gTotal;
      if (s) s.textContent = gSent;
      if (f) f.textContent = gFailed;
      const mt = document.getElementById('miniStatTotal');
      const ms = document.getElementById('miniStatSent');
      const mf = document.getElementById('miniStatFailed');
      if (mt) mt.textContent = gTotal;
      if (ms) ms.textContent = gSent;
      if (mf) mf.textContent = gFailed;
    };
    updStats();

    const statusEl = document.getElementById('multiStatusText');
    const setStatus = (msg) => {
      if (statusEl) statusEl.textContent = msg;
      if (typeof window.showStatus === 'function') window.showStatus(msg, 'info');
    };

    setStatus(`Starting parallel broadcast on ${jobs.length} page(s)…`);

    const runPageJob = async (job, index, total) => {
      const { page, message, imageUrl } = job;
      const rt =
        typeof window.createIsolatedBroadcastRuntime === 'function'
          ? window.createIsolatedBroadcastRuntime()
          : null;
      if (!rt || typeof window.enqueueAndSendUtility !== 'function') {
        throw new Error('Broadcast engine not loaded');
      }

      if (typeof window.getRemaining === 'function' && window.getRemaining() <= 0) {
        rt.isSending = false;
        return { skipped: true, reason: 'quota' };
      }

      setStatus(`Loading recipients: ${page.name} (${index + 1}/${total})…`);
      let psids = [];
      try {
        const result = await window.fetchConversations(page.id, (prog) => {
          setStatus(
            `"${page.name}": ${prog.fetched}${prog.total ? ' / ' + prog.total : ''} conversations…`
          );
        });
        psids = result.psids || [];
      } catch (e) {
        if (typeof window.reportClientError === 'function') {
          window.reportClientError(e, { source: 'multi_broadcast.fetch', pageId: page.id });
        }
        return { error: e.message || 'Failed to load conversations' };
      }

      if (!psids.length) return { empty: true };

      gTotal += psids.length;
      updStats();

      if (typeof window.addPageSeparator === 'function') {
        window.addPageSeparator(page.name, index + 1, total);
      }

      return new Promise((resolve) => {
        window.enqueueAndSendUtility({
          pageId: page.id,
          messageText: message,
          imageUrl: imageUrl,
          recipientIds: psids,
          delayMs: delay,
          fbUserId,
          isolatedRuntime: rt,
          onProgress: (data) => {
            if (data.item.status === 'sent') gSent++;
            if (data.item.status === 'failed') gFailed++;
            updStats();
            if (typeof window.updateQuotaUI === 'function') window.updateQuotaUI();
            if (typeof window.addRecipientRow === 'function') window.addRecipientRow(data.item);
            const pct = data.total ? Math.round((data.index / data.total) * 100) : 0;
            const bar = document.getElementById('progressBar');
            const pctEl = document.getElementById('progressPct');
            if (bar) bar.style.width = pct + '%';
            if (pctEl) pctEl.textContent = pct + '%';
            setStatus(`"${page.name}" — ${data.index} / ${data.total} sent (parallel)`);
          },
          onDone: (summary) => resolve(summary)
        });
      });
    };

    try {
      const results = await Promise.allSettled(
        jobs.map((job, i) => runPageJob(job, i, jobs.length))
      );

      let stopped = false;
      results.forEach((r, i) => {
        if (r.status === 'rejected') {
          gFailed++;
          if (typeof window.showToast === 'function') {
            window.showToast(`"${jobs[i].page.name}": ${r.reason?.message || 'failed'}`, 'error');
          }
        } else if (r.value?.reason === 'stopped') {
          stopped = true;
        }
      });

      const bar = document.getElementById('progressBar');
      const pctEl = document.getElementById('progressPct');
      if (bar) bar.style.width = '100%';
      if (pctEl) pctEl.textContent = '100%';

      const msg = stopped
        ? `Stopped — ${gSent.toLocaleString()} sent, ${gFailed.toLocaleString()} failed`
        : `Parallel complete — ${gSent.toLocaleString()} sent across ${jobs.length} page(s)`;
      setStatus(msg);
      if (typeof window.showToast === 'function') window.showToast(msg, stopped ? 'warning' : 'success');
      if (typeof window.fbTrackEvent === 'function') {
        window.fbTrackEvent('broadcast_complete', {
          mode: 'multi_parallel',
          pages: jobs.length,
          total: gTotal,
          sent: gSent,
          failed: gFailed
        });
      }
      if (typeof window.maybeNotifyBroadcast === 'function') {
        window.maybeNotifyBroadcast('complete', msg);
      }
    } finally {
      multiRunning = false;
      if (typeof runtime !== 'undefined') {
        runtime.isSending = false;
        runtime.paused = false;
      }
      window.__fbcIsolatedRuntimes?.clear();
      setMultiButtons('idle');
    }
  }

  document.addEventListener('DOMContentLoaded', () => {
    const btnManual = document.getElementById('modeManualBtn');
    const btnAuto = document.getElementById('modeAutoBtn');
    const btnMulti = document.getElementById('modeMultiBtn');
    if (!btnManual) return;

    btnManual.addEventListener('click', () => setBroadcastMode('manual'));
    btnAuto.addEventListener('click', () => setBroadcastMode('auto'));
    btnMulti?.addEventListener('click', () => setBroadcastMode('multi'));

    document.getElementById('btnMultiStart')?.addEventListener('click', startMultiParallelSend);
    document.getElementById('btnMultiApplyMain')?.addEventListener('click', () => {
      applyMainMessageToAll();
      updateMultiStartButton();
    });
    document.getElementById('btnMultiApplyMainImage')?.addEventListener('click', applyMainImageToAll);

    const multiMsgs = document.getElementById('multiPageMessages');
    multiMsgs?.addEventListener('click', handleMultiPageMediaClick);
    multiMsgs?.addEventListener('change', (e) => {
      const input = e.target.closest('.bcast-page-msg__file');
      if (!input?.files?.[0]) return;
      const pageId = input.getAttribute('data-page-id');
      if (pageId) uploadPageImage(pageId, input.files[0]);
      input.value = '';
    });
    document.getElementById('messageText')?.addEventListener('input', () => {
      if (document.body.classList.contains('shell-multi-broadcast')) updateMultiStartButton();
    });

    document.getElementById('multiPageMessages')?.addEventListener('input', (e) => {
      if (e.target.matches('.bcast-page-msg__input')) updateMultiStartButton();
    });

    window.addEventListener('fbc:image-attached', () => {
      if (document.body.classList.contains('shell-multi-broadcast')) {
        rebuildMultiPageMessages();
        updateMultiStartButton();
      }
    });
    window.addEventListener('fbc:image-cleared', () => {
      if (document.body.classList.contains('shell-multi-broadcast')) {
        rebuildMultiPageMessages();
        updateMultiStartButton();
      }
    });

    window.addEventListener('fbc:broadcast-state', (e) => {
      if (!document.body.classList.contains('shell-multi-broadcast')) return;
      const d = e.detail || {};
      if (!d.isSending) setMultiButtons('idle');
      else setMultiButtons(d.paused ? 'paused' : 'running');
    });

    setBroadcastMode('manual');
  });

  window.getMultiSelectedPages = getMultiSelectedPages;
  window.rebuildMultiPageMessages = rebuildMultiPageMessages;
  window.updateMultiPageCount = updateMultiPageCount;
  window.multiSelectAllPages = multiSelectAllPages;
  window.multiSelectNonePages = multiSelectNonePages;
  window.setBroadcastMode = setBroadcastMode;
  window.startMultiParallelSend = startMultiParallelSend;
  window.updateMultiStartButton = updateMultiStartButton;
  window.updateMultiImageAttach = updateMultiImageAttach;
})();
