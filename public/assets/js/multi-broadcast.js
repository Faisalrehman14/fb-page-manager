/**
 * Multi-page parallel broadcast — different message per page, sent at the same time.
 */
(function () {
  'use strict';

  let multiRunning = false;

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
    const el = document.getElementById('multiPageCount');
    if (!el) return;
    const n = document.querySelectorAll('#pageCards .page-card.multi-selected').length;
    const total = getPages().length;
    if (!n) el.textContent = 'No pages selected — click pages in the sidebar';
    else if (n === total && total > 0) el.textContent = `All ${n} pages selected`;
    else el.textContent = `${n} page${n === 1 ? '' : 's'} selected`;
  }

  function rebuildMultiPageMessages() {
    const wrap = document.getElementById('multiPageMessages');
    if (!wrap) return;
    const selected = getMultiSelectedPages();
    const existing = {};
    wrap.querySelectorAll('[data-page-id]').forEach((row) => {
      const id = row.getAttribute('data-page-id');
      const ta = row.querySelector('textarea');
      if (id && ta) existing[id] = ta.value;
    });
    if (!selected.length) {
      wrap.innerHTML =
        '<p class="multi-page-empty">Select one or more pages in the sidebar to set a message for each.</p>';
      return;
    }
    const mainMsg = document.getElementById('messageText')?.value?.trim() || '';
    wrap.innerHTML = selected
      .map((p) => {
        const val = existing[p.id] !== undefined ? existing[p.id] : mainMsg;
        return `<div class="multi-page-row" data-page-id="${esc(p.id)}">
          <label class="multi-page-label" for="multi-msg-${esc(p.id)}">${esc(p.name || p.id)}</label>
          <textarea id="multi-msg-${esc(p.id)}" class="multi-page-textarea" rows="3" maxlength="2000" placeholder="Message for this page…">${escTextarea(val)}</textarea>
        </div>`;
      })
      .join('');
  }

  function getPerPageMessages() {
    const map = {};
    document.querySelectorAll('#multiPageMessages .multi-page-row').forEach((row) => {
      const id = row.getAttribute('data-page-id');
      const ta = row.querySelector('textarea');
      if (id && ta) map[id] = ta.value.trim();
    });
    return map;
  }

  function applyMainMessageToAll() {
    const main = document.getElementById('messageText')?.value?.trim() || '';
    if (!main) {
      if (typeof window.showToast === 'function') window.showToast('Write a message in the main box first.', 'warning');
      return;
    }
    document.querySelectorAll('#multiPageMessages .multi-page-textarea').forEach((ta) => {
      ta.value = main;
    });
    if (typeof window.showToast === 'function') window.showToast('Applied to all selected pages', 'success');
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

  function setMultiButtons(state) {
    const start = document.getElementById('btnMultiStart');
    const pause = document.getElementById('btnPause');
    const resume = document.getElementById('btnResume');
    const stop = document.getElementById('btnStop');
    const idle = state === 'idle';
    if (start) start.disabled = !idle;
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
      if (mode === 'multi') hint.textContent = 'Select pages, set each message, then start parallel broadcast';
      else if (mode === 'auto') hint.textContent = 'Same message to all pages, one after another';
      else hint.textContent = 'Select a page, write message, then start broadcast';
    }
    const transport = document.getElementById('broadcastTransport');
    const miniStats = document.getElementById('broadcastMiniStats');
    const sendHint = document.getElementById('sendHint');
    const showManualMulti = mode === 'manual' || mode === 'multi';
    if (transport) transport.style.display = showManualMulti ? '' : 'none';
    if (miniStats) miniStats.style.display = showManualMulti ? '' : 'none';
    if (sendHint) sendHint.style.display = showManualMulti ? '' : 'none';
    const schedActions = document.getElementById('sidebarSchedActions');
    if (schedActions) schedActions.style.display = mode === 'multi' ? 'inline-flex' : '';
    if (mode !== 'multi') clearMultiSelection();
    else {
      rebuildMultiPageMessages();
      updateMultiPageCount();
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
    const imgUrl =
      (typeof currentImageUrl !== 'undefined' ? currentImageUrl : '') || window._imgAttachUrl || '';
    const delay = Math.max(500, parseInt(document.getElementById('delayMs')?.value, 10) || 1200);

    const jobs = selected.map((page) => ({
      page,
      message: perPage[page.id] || ''
    }));

    const missing = jobs.filter((j) => !j.message && !imgUrl);
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
      const { page, message } = job;
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
          imageUrl: imgUrl,
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
    document.getElementById('btnMultiApplyMain')?.addEventListener('click', applyMainMessageToAll);

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
})();
