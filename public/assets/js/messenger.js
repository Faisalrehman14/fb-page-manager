/**
 * messenger.js — Senior-level Messenger frontend
 *
 * Key design decisions:
 *  - setTimeout chain (not setInterval) → no concurrent poll requests
 *  - Keyed conv list updates → no flicker, no full DOM rebuild every 3s
 *  - Set-based message dedup → O(1), handles webhook retries correctly
 *  - Optimistic send with data-temp-id → correct rollback on failure
 *  - visibilitychange → polling pauses when tab is hidden
 *  - Event delegation on conv list → no inline onclick in generated HTML
 */

(function () {
  'use strict';

  // ══════════════════════════════════════════════════════════
  // STATE
  // One flat object. Every field has one owner.
  // Mutations happen in named functions, never inline.
  // ══════════════════════════════════════════════════════════
  const M = {
    pages:        [],
    activePageId: null,
    activeToken:  null,

    convs:        [],
    convOffset:   0,
    convHasMore:  true,

    activePsid:      null,
    activeConvName:  '',
    activeConvPic:   '',
    msgs:            [],        // ordered oldest→newest
    renderedMsgIds:  new Set(), // dedup — O(1) via message_id or content hash
    oldestMsgTime:   null,
    hasOlderMessages: false,
    msgPageSize:     50,
    contactMedia:    null,
    _contactMediaPsid: null,
    _contactMediaTimer: null,

    poll: { timer: null, since: null, failures: 0 },
    pagePoll: { timer: null, since: null },

    search: { query: '', timer: null, active: false, abort: null, cache: new Map() },

    ui: { sending: false, loadingMore: false, syncing: false, loadingConvs: false },
    _convLoadSeq: 0,
    _loadingConvsFor: null,

    msgStatus: { delivered: 0, read: 0 }, // unix-ms watermarks for active conversation

    pageUnread: {},    // { pageId: unreadCount } — drives red dot on page icons

    retentionDays: 7,  // from API — messages + active conv window

    convFilter: 'all', // 'all' | 'unread' — inbox filter chips

    _msgAbort: null,   // AbortController for in-flight loadMessages request
    _offline:  false,  // true while socket is disconnected
    _convByPsid: new Map(), // O(1) conv lookup during poll
    _joinedThread: null,    // socket.io thread room id
    _syncPollTimer: null,
    _syncPollAttempts: 0,
    _graphMsgReloadAt: 0,
    _listReloadAt: 0,
    _convListRefreshTimer: null,
    _listRefreshInFlight: false,
    _metaListRefreshAt: 0,
    _lastConvRenderSig: '',
    _lastConvOrderSig: '',
    _convOrder: [],       // Meta order: updated_at DESC from API
    _renderConvsRaf: 0,
    _readLocked: new Set(),
    _readLockAt: new Map(),     // psid → ms when marked read locally
    _readMarkTimers: new Map(), // psid → debounce timer
    _readMarkInflight: new Map(), // psid → Promise
    _lastNotifKey: '',
    _lastNotifAt: 0,
    cannedReplies: [],
    _editingCannedId: null,
    _srpBody: '',
    pendingImage: null, // { file, previewUrl }
  };

  /** DB + Meta inbox poll while messenger is open (~1 req/s, setTimeout chain). */
  const POLL_MS = 1000;
  const POLL_SOCKET_MS = 1000;
  /** Background poll for unread + notifications on non-active pages. */
  const PAGE_POLL_MS = 3500;
  const CONV_PAGE_SIZE = 30;
  const CONV_LIST_CACHE_MS = 30_000;
  const CONV_LIST_RELOAD_MS = 600_000; // 10 min — avoid background list reshuffle
  /** Full list merge from API — Meta order only, not every poll (keeps list stable). */
  const CONV_LIST_META_ORDER_MS = 20_000;
  const SEARCH_MIN_CHARS = 1;
  const SEARCH_DEBOUNCE_MS = 400;
  const SEARCH_CACHE_MS = 15_000;
  const _convListCache = new Map();

  // ══════════════════════════════════════════════════════════
  // NOTIFICATION SOUND
  // Web Audio API — no file dependency, works everywhere.
  // Two-tone chime: 880 Hz → 1100 Hz over 220ms.
  // User preference persisted in localStorage.
  // ══════════════════════════════════════════════════════════
  let _soundEnabled = localStorage.getItem('msng_sound') !== 'false';
  const _audioCtx   = (() => {
    try { return typeof AudioContext !== 'undefined' ? new AudioContext() : null; } catch { return null; }
  })();

  function _playNotifSound() {
    if (!_soundEnabled || !_audioCtx) return;
    try {
      if (_audioCtx.state === 'suspended') _audioCtx.resume();
      const o = _audioCtx.createOscillator();
      const g = _audioCtx.createGain();
      o.connect(g); g.connect(_audioCtx.destination);
      o.type = 'sine';
      o.frequency.setValueAtTime(880,  _audioCtx.currentTime);
      o.frequency.setValueAtTime(1100, _audioCtx.currentTime + 0.07);
      g.gain.setValueAtTime(0.18, _audioCtx.currentTime);
      g.gain.exponentialRampToValueAtTime(0.001, _audioCtx.currentTime + 0.22);
      o.start(); o.stop(_audioCtx.currentTime + 0.22);
    } catch (_) {}
  }

  // ══════════════════════════════════════════════════════════
  // IMAGE LIGHTBOX — click any chat image to expand fullscreen
  // ══════════════════════════════════════════════════════════
  function openLightbox(src) {
    if (!src) return;
    const overlay = document.createElement('div');
    overlay.className = 'msng-lightbox';
    overlay.innerHTML =
      `<button class="msng-lb-close" aria-label="Close"><i class="fa-solid fa-xmark"></i></button>` +
      `<a class="msng-lb-ext" href="${esc(src)}" target="_blank" rel="noopener" title="Open original"><i class="fa-solid fa-arrow-up-right-from-square"></i></a>` +
      `<img class="msng-lb-img" src="${esc(src)}" alt="Image">`;
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
    overlay.querySelector('.msng-lb-close').addEventListener('click', () => overlay.remove());
    document.body.appendChild(overlay);
    requestAnimationFrame(() => overlay.classList.add('show'));
    const onKey = (e) => {
      if (e.key === 'Escape') { overlay.remove(); document.removeEventListener('keydown', onKey); }
    };
    document.addEventListener('keydown', onKey);
  }

  // ══════════════════════════════════════════════════════════
  // EMOJI PICKER — 30 common business emojis, pure JS panel
  // ══════════════════════════════════════════════════════════
  const _EMOJIS = ['😊','😂','❤️','👍','👏','🙏','🔥','✅','⭐','💯',
                   '🎉','😍','👋','🤝','💪','✨','🙂','😀','🤙','💬',
                   '📦','🚀','🛒','💰','🔔','⏰','📞','🏷️','📱','💻'];

  function _buildOrToggleEmoji() {
    let panel = $('msngEmojiPanel');
    if (panel) {
      const isHidden = panel.style.display === 'none';
      panel.style.display = isHidden ? 'grid' : 'none';
      $('msngEmojiBtn')?.classList.toggle('active', isHidden);
      return;
    }
    panel = document.createElement('div');
    panel.id = 'msngEmojiPanel';
    panel.className = 'msng-emoji-panel';
    panel.innerHTML = _EMOJIS.map(e =>
      `<button class="msng-emoji-btn" type="button">${e}</button>`
    ).join('');
    panel.addEventListener('click', (ev) => {
      const btn = ev.target.closest('.msng-emoji-btn');
      if (!btn) return;
      const ta = $('msngMsgTextarea');
      if (!ta) return;
      const pos = ta.selectionStart ?? ta.value.length;
      ta.value = ta.value.slice(0, pos) + btn.textContent + ta.value.slice(pos);
      ta.selectionStart = ta.selectionEnd = pos + btn.textContent.length;
      ta.focus();
      window.msngUpdateCharCount(ta);
    });
    // Anchor above the input bar
    const anchor = $('msngEmojiAnchor');
    if (anchor) anchor.appendChild(panel);
    else document.body.appendChild(panel);
    $('msngEmojiBtn')?.classList.add('active');
    // Close on outside click
    setTimeout(() => {
      document.addEventListener('click', function _closeEmoji(e) {
        if (!panel.contains(e.target) && e.target.id !== 'msngEmojiBtn' && !e.target.closest('#msngEmojiBtn')) {
          panel.style.display = 'none';
          $('msngEmojiBtn')?.classList.remove('active');
          document.removeEventListener('click', _closeEmoji);
        }
      });
    }, 0);
  }

  // ══════════════════════════════════════════════════════════
  // HTTP
  // ══════════════════════════════════════════════════════════
  async function get(action, params = {}) {
    const qs  = new URLSearchParams(params).toString();
    const url = '/api/messenger?action=' + encodeURIComponent(action) + (qs ? '&' + qs : '');
    if (typeof window.requestJson === 'function') {
      return window.requestJson(url, { method: 'GET' });
    }
    const r = await fetch(url, { credentials: 'same-origin' });
    if (r.status === 401) return { error: 'Session expired — please reload the page', messages: [], conversations: [] };
    if (!r.ok && r.status !== 200) {
      try { return await r.json(); } catch { return { error: 'Server error (' + r.status + ')' }; }
    }
    return r.json();
  }

  async function post(payload) {
    if (typeof window.requestJson === 'function') {
      return window.requestJson('/api/messenger', {
        method:  'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-CSRF-Token': await window.getCsrfToken?.() || ''
        },
        body: JSON.stringify(payload)
      });
    }
    const r = await fetch('/api/messenger', {
      method:      'POST',
      headers:     { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body:        JSON.stringify(payload),
    });
    if (r.status === 401) return { error: 'Session expired — please reload the page' };
    if (r.status === 429) return { error: 'Too many requests — slow down' };
    if (!r.ok) {
      let data = {};
      try { data = await r.json(); } catch { /* ignore */ }
      const msg = (data && (data.error || data.message))
        ? String(data.error || data.message)
        : 'Server error (' + r.status + ')';
      throw new Error(msg);
    }
    return r.json();
  }

  const MSG_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

  function _retentionCutoffMs() {
    return Date.now() - MSG_RETENTION_MS;
  }

  function _filterMsgsByRetention(msgs) {
    const cutoff = _retentionCutoffMs();
    return (msgs || []).filter(m => {
      const t = new Date(m.created_at || 0).getTime();
      return !isNaN(t) && t >= cutoff;
    });
  }

  function _atRetentionBoundary() {
    if (!M.oldestMsgTime) return false;
    return new Date(M.oldestMsgTime).getTime() <= _retentionCutoffMs() + 60_000;
  }

  // ══════════════════════════════════════════════════════════
  // FORMATTING
  // ══════════════════════════════════════════════════════════
  function esc(s) {
    return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  function $(id) { return document.getElementById(id); }

  function parseMsgDate(dateStr) {
    if (!dateStr) return null;
    const d = new Date(dateStr);
    if (!isNaN(d.getTime())) return d;
    const s = String(dateStr).trim();
    if (!s) return null;
    const local = new Date(s.includes('T') ? s : s.replace(' ', 'T'));
    if (!isNaN(local.getTime())) return local;
    const utc = new Date(s.replace(' ', 'T') + 'Z');
    return isNaN(utc.getTime()) ? null : utc;
  }

  function fmtTime(dateStr) {
    if (!dateStr) return '';
    const d = parseMsgDate(dateStr);
    if (!d) return '';
    const diff  = Date.now() - d.getTime();
    const mins  = Math.floor(diff / 60_000);
    const hours = Math.floor(diff / 3_600_000);
    const days  = Math.floor(diff / 86_400_000);
    if (mins  < 1)  return 'now';
    if (mins  < 60) return mins  + 'm';
    if (hours < 24) return hours + 'h';
    if (days  < 7)  return days  + 'd';
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  }

  function fmtMsgTime(dateStr) {
    if (!dateStr) return '';
    const d = parseMsgDate(dateStr);
    return !d ? '' : d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true });
  }

  function fmtDate(dateStr) {
    if (!dateStr) return '';
    const d = parseMsgDate(dateStr);
    if (!d) return '';
    const today  = new Date(); today.setHours(0,0,0,0);
    const msgDay = new Date(d); msgDay.setHours(0,0,0,0);
    const diff   = Math.round((today - msgDay) / 86_400_000);
    if (diff === 0) return 'Today';
    if (diff === 1) return 'Yesterday';
    return d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
  }

  /** Unique per page — same customer can message multiple pages. */
  function convKey(pageId, psid) {
    return `${String(pageId || M.activePageId || '')}:${String(psid || '')}`;
  }

  function getConv(pageId, psid) {
    return M._convByPsid.get(convKey(pageId, psid))
      || M.convs.find(c => String(c.page_id) === String(pageId) && String(c.psid) === String(psid));
  }

  function rebuildConvIndex() {
    M._convByPsid = new Map(
      M.convs.map(c => [convKey(c.page_id || M.activePageId, c.psid), c])
    );
  }

  function invalidateConvListRender() {
    M._lastConvRenderSig = '';
    M._lastConvOrderSig = '';
  }

  function setConvOrderFromList(list) {
    M._convOrder = (list || []).map(c => String(c.psid));
  }

  function lockConvRead(psid) {
    if (!psid) return;
    const key = String(psid);
    M._readLocked.add(key);
    M._readLockAt.set(key, Date.now());
  }

  function isConvReadLocked(psid) {
    return M._readLocked.has(String(psid));
  }

  function clearConvReadLock(psid) {
    if (!psid) return;
    const key = String(psid);
    M._readLocked.delete(key);
    M._readLockAt.delete(key);
    const t = M._readMarkTimers.get(key);
    if (t) clearTimeout(t);
    M._readMarkTimers.delete(key);
  }

  /**
   * Resolve unread for UI — ignore stale DB/Facebook sync after read or page reply.
   */
  function resolveConvUnread(psid, serverUnread, updatedAt, lastFromMe) {
    const key = String(psid);
    const nu = parseInt(serverUnread, 10) || 0;
    const fromPage = lastFromMe === true || lastFromMe === 1;

    if (fromPage) return 0;
    if (isConvReadLocked(psid)) return 0;
    if (key === String(M.activePsid)) {
      if (nu > 0) queueMarkConvRead(key, { immediate: true });
      return 0;
    }
    return nu > 0 ? nu : 0;
  }

  function commitConvReadState(psid, unread) {
    const conv = getConv(M.activePageId, psid);
    if (conv) conv.unread = Math.max(0, parseInt(unread, 10) || 0);
    if (conv && conv.unread === 0) lockConvRead(psid);
    else clearConvReadLock(psid);
    invalidateConvListRender();
    renderConvs({ immediate: true });
    syncPageBadge(M.activePageId);
  }

  async function runMarkReadRequest(psid) {
    const key = String(psid);
    if (!M.activePageId || !key) return;
    if (M._readMarkInflight.has(key)) return M._readMarkInflight.get(key);

    const job = (async () => {
      let attempt = 0;
      while (attempt < 4) {
        attempt++;
        try {
          const res = await post({
            action: 'mark_read',
            page_id: M.activePageId,
            psid: key,
            page_token: M.activeToken
          });
          if (res && res.error) throw new Error(res.error);
          lockConvRead(key);
          commitConvReadState(key, 0);
          return;
        } catch (e) {
          if (attempt >= 4) {
            console.warn('[Messenger] mark_read failed:', e.message || e);
            return;
          }
          await new Promise(r => setTimeout(r, 400 * attempt));
        }
      }
    })();

    M._readMarkInflight.set(key, job);
    try {
      await job;
    } finally {
      M._readMarkInflight.delete(key);
    }
  }

  function queueMarkConvRead(psid, opts = {}) {
    if (!psid || !M.activePageId) return;
    const key = String(psid);

    if (opts.markUnread) {
      clearConvReadLock(key);
      commitConvReadState(key, 1);
      post({
        action: 'mark_unread',
        page_id: M.activePageId,
        psid: key
      }).catch(() => showToast('Could not mark unread', 'warning', 2500));
      return;
    }

    lockConvRead(key);
    commitConvReadState(key, 0);

    const prev = M._readMarkTimers.get(key);
    if (prev) clearTimeout(prev);
    const delay = opts.immediate ? 0 : 350;
    const timer = setTimeout(() => {
      M._readMarkTimers.delete(key);
      runMarkReadRequest(key);
    }, delay);
    M._readMarkTimers.set(key, timer);
  }

  /** Re-sort sidebar to match Meta (updated_at DESC from API). */
  function resortConvsByMeta() {
    if (!M.convs.length) return false;
    const sorted = [...M.convs].sort((a, b) => {
      const ta = new Date(a.lastMsgAt || 0).getTime();
      const tb = new Date(b.lastMsgAt || 0).getTime();
      return tb - ta;
    });
    const next = sorted.map(c => String(c.psid));
    if (next.join(',') === M._convOrder.join(',')) return false;
    M.convs = sorted;
    M._convOrder = next;
    invalidateConvListRender();
    return true;
  }

  /** After we send from this inbox — bump sidebar row to top immediately. */
  /** Keep open-thread sidebar row in sync with the message pane (poll excludes it from DB patches). */
  function syncOpenConvSidebarFromMessages() {
    if (!M.activePsid || !M.msgs.length) return false;
    const conv = getConv(M.activePageId, M.activePsid);
    if (!conv) return false;
    const last = [...M.msgs].reverse().find(m => !m._pending && !m._failed);
    if (!last) return false;
    let changed = false;
    const preview = msgPreviewText(last);
    if (conv.lastMsg !== preview) { conv.lastMsg = preview; changed = true; }
    const fromMe = !!last.from_me;
    if (conv.lastFromMe !== fromMe) { conv.lastFromMe = fromMe; changed = true; }
    if (last.created_at && String(conv.lastMsgAt) !== String(last.created_at)) {
      conv.lastMsgAt = last.created_at;
      changed = true;
    }
    return changed;
  }

  function bumpConvAfterPageSend(psid, { lastMsg, lastMsgAt } = {}) {
    const conv = getConv(M.activePageId, psid);
    if (!conv) return;
    if (lastMsg != null) conv.lastMsg = lastMsg;
    conv.lastFromMe = true;
    conv.unread = 0;
    conv.lastMsgAt = lastMsgAt != null ? lastMsgAt : new Date().toISOString();
    lockConvRead(psid);
    resortConvsByMeta();
    const cached = _convListCache.get(M.activePageId);
    if (cached) {
      cached.convs = M.convs;
      cached.order = M._convOrder.slice();
    }
    renderConvs({ immediate: true });
  }

  function convRowSig(c) {
    const preview = formatConvPreview(c);
    return [
      c.psid,
      c.unread || 0,
      preview,
      fmtTime(c.lastMsgAt),
      c.name || '',
      c.lastFromMe ? 1 : 0
    ].join('|');
  }

  function patchConvListNode(node, c) {
    const isActive = c.psid === M.activePsid;
    node.classList.toggle('active', isActive);
    node.classList.toggle('unread', c.unread > 0);

    const preview = formatConvPreview(c);
    const short   = preview.length > 42 ? preview.slice(0, 42) + '…' : preview;
    const nameEl  = node.querySelector('.msng-ci-name');
    const lastEl  = node.querySelector('.msng-ci-last');
    const timeEl  = node.querySelector('.msng-ci-time');
    let   badgeEl = node.querySelector('.msng-ci-badge');
    const timeStr = fmtTime(c.lastMsgAt);

    if (nameEl && nameEl.textContent !== c.name) nameEl.textContent = c.name;
    if (lastEl && lastEl.textContent !== short) lastEl.textContent = short;
    if (timeEl && timeEl.textContent !== timeStr) timeEl.textContent = timeStr;

    const pageLbl = activePageName();
    let pageEl = node.querySelector('.msng-ci-page');
    if (pageLbl) {
      if (!pageEl) {
        const row1 = node.querySelector('.msng-ci-row1');
        if (row1) row1.insertAdjacentHTML('afterend', `<div class="msng-ci-page">${esc(pageLbl)}</div>`);
      } else if (pageEl.textContent !== pageLbl) {
        pageEl.textContent = pageLbl;
      }
    } else if (pageEl) {
      pageEl.remove();
    }

    if (c.unread > 0) {
      const badgeTxt = c.unread > 9 ? '9+' : String(c.unread);
      if (!badgeEl) {
        node.insertAdjacentHTML('beforeend', `<span class="msng-ci-badge">${badgeTxt}</span>`);
      } else if (badgeEl.textContent !== badgeTxt) {
        badgeEl.textContent = badgeTxt;
      }
    } else if (badgeEl) {
      badgeEl.remove();
    }
  }

  /** Apply Meta/DB sort (updated_at DESC) — same order as Facebook inbox. */
  function applyMetaConvOrder(incoming) {
    if (!incoming?.length) return false;
    const head = incoming.map(c => String(c.psid));
    const headSet = new Set(head);
    const tail = M._convOrder.filter(id => !headSet.has(id));
    const next = head.concat(tail);
    if (next.join(',') === M._convOrder.join(',')) return false;
    M._convOrder = next;
    invalidateConvListRender();
    return true;
  }

  function mergeConvListFromServer(incoming) {
    if (!incoming?.length) return false;
    let changed = false;
    for (const row of incoming) {
      const key = String(row.psid);
      const ex = getConv(row.page_id || M.activePageId, key);
      if (ex) {
        const patch = { ...row };
        if (patch.lastMsg != null) patch.lastMsg = normalizePreviewText(patch.lastMsg);
        patch.unread = resolveConvUnread(key, patch.unread, patch.lastMsgAt, patch.lastFromMe);
        if (ex.unread !== patch.unread || ex.lastMsg !== patch.lastMsg
            || ex.name !== patch.name || ex.lastFromMe !== patch.lastFromMe) {
          Object.assign(ex, patch);
          changed = true;
        } else if (patch.lastMsgAt && String(ex.lastMsgAt) !== String(patch.lastMsgAt)) {
          ex.lastMsgAt = patch.lastMsgAt;
          changed = true;
        }
      } else {
        row.lastMsg = normalizePreviewText(row.lastMsg || '');
        M.convs.push(row);
        changed = true;
      }
    }
    if (changed) rebuildConvIndex();
    return changed;
  }

  function applyPollConvUpdates(updates) {
    if (!updates?.length) return false;
    let dirty = false;
    for (const uc of updates) {
      const ucPage = String(uc.page_id || M.activePageId || '');
      if (ucPage !== String(M.activePageId)) continue;

      const key = convKey(M.activePageId, uc.fb_user_id);
      const existing = M._convByPsid.get(key);
      if (existing) {
        let rowChanged = false;
        const nu = resolveConvUnread(
          uc.fb_user_id,
          uc.is_unread,
          uc.updated_at || uc.last_msg_at,
          uc.last_from_me == 1
        );
        const prevSnippet = normalizePreviewText(existing.lastMsg || '');
        if (existing.unread !== nu) {
          existing.unread = nu;
          rowChanged = true;
        }
        if (uc.snippet) {
          const norm = normalizePreviewText(uc.snippet);
          if (norm !== prevSnippet) {
            existing.lastMsg = norm;
            rowChanged = true;
          }
        }
        if (uc.last_from_me != null) {
          const lfm = uc.last_from_me == 1;
          if (existing.lastFromMe !== lfm) { existing.lastFromMe = lfm; rowChanged = true; }
        }
        const newAt = uc.updated_at || uc.last_msg_at;
        if (newAt && String(existing.lastMsgAt) !== String(newAt)) {
          existing.lastMsgAt = newAt;
          rowChanged = true;
        }
        if (rowChanged) dirty = true;
      } else {
        const row = {
          id: uc.id, psid: uc.fb_user_id,
          name: uc.user_name || 'User', picture: uc.user_picture || null,
          lastMsg: normalizePreviewText(uc.snippet || uc.last_msg || ''),
          lastFromMe: uc.last_from_me == 1,
          lastMsgAt: uc.updated_at || uc.last_msg_at,
          unread: resolveConvUnread(
            uc.fb_user_id,
            uc.is_unread,
            uc.updated_at || uc.last_msg_at,
            uc.last_from_me == 1
          ),
          page_id: M.activePageId,
        };
        M.convs.push(row);
        M._convByPsid.set(key, row);
        dirty = true;
      }
    }
    if (dirty) {
      rebuildConvIndex();
      resortConvsByMeta();
    }
    return dirty;
  }

  function nextPollDelayMs() {
    return POLL_MS;
  }

  function setPollSince(serverTime) {
    const t = serverTime ? new Date(serverTime).getTime() : Date.now();
    M.poll.since = new Date(t - 1500).toISOString();
  }

  function getDisplayConvs() {
    if (M.search.active) return [];
    const seen = new Set();
    const list = [];
    for (const psid of M._convOrder) {
      const c = getConv(M.activePageId, psid);
      if (c && !seen.has(String(c.psid))) {
        seen.add(String(c.psid));
        list.push(c);
      }
    }
    for (const c of M.convs) {
      if (!seen.has(String(c.psid))) list.push(c);
    }
    if (M.convFilter === 'unread') return list.filter(c => (c.unread || 0) > 0);
    return list;
  }

  function updateMessengerChrome() {
    const totalUnread = M.convs.reduce((s, c) => s + (c.unread || 0), 0);
    const convCount   = M.convs.length;
    const page        = M.pages.find(p => p.id === M.activePageId);

    const label = $('msngActivePageLabel');
    if (label) label.textContent = page?.name || 'Select a page';

    const cc = $('msngConvCount');
    if (cc) cc.textContent = String(convCount);

    const sub = $('msngConvsSub');
    if (sub) {
      if (M.convFilter === 'unread') {
        sub.textContent = totalUnread
          ? `${totalUnread} unread conversation${totalUnread !== 1 ? 's' : ''}`
          : 'No unread messages';
      } else {
        sub.textContent = convCount
          ? `${convCount} conversation${convCount !== 1 ? 's' : ''}`
          : 'All customer chats';
      }
    }

    const unreadPill  = $('msngUnreadPill');
    const unreadTotal = $('msngUnreadTotal');
    if (unreadTotal) unreadTotal.textContent = totalUnread > 99 ? '99+' : String(totalUnread);
    if (unreadPill) unreadPill.style.display = totalUnread > 0 ? 'inline-flex' : 'none';

    // Browser tab title badge — strip any existing badge then re-add if needed
    const baseTitle = document.title.replace(/^\(\d+\+?\)\s*/, '');
    document.title = totalUnread > 0
      ? `(${totalUnread > 99 ? '99+' : totalUnread}) ${baseTitle}`
      : baseTitle;
  }

  function setLivePillState(online) {
    const pill = $('msngLivePill');
    if (!pill) return;
    pill.classList.toggle('offline', !online);
    const text = pill.querySelector('.msng-live-label');
    if (text) text.textContent = online ? 'Live' : 'Polling';
  }

  // ══════════════════════════════════════════════════════════
  // TEMPLATES — single source of truth for HTML
  // ══════════════════════════════════════════════════════════

  function avatarHtml(picture, name, cls) {
    const initial = (name || 'U').charAt(0).toUpperCase();
    return picture
      ? `<img class="${cls}" src="${esc(picture)}" alt="${esc(name)}"
             onerror="this.outerHTML='<div class=\'${cls}-ph\'>${esc(initial)}</div>'">`
      : `<div class="${cls}-ph">${esc(initial)}</div>`;
  }

  function isBrokenLikeSnippet(s) {
    const t = String(s || '').trim();
    if (!t || t === '👍') return false;
    if (/^[\uFFFD\uFFFC\u25A1\u25A0]$/.test(t) || t === '□') return true;
    if (/^\[(sticker|like|attachment)\]$/i.test(t)) return true;
    return false;
  }

  function normalizePreviewText(raw) {
    let last = String(raw || '').trim();
    while (/^you:\s*/i.test(last)) last = last.replace(/^you:\s*/i, '').trim();
    last = last.replace(/^you\s+sent\s+(a\s+)?/i, '').trim();
    if (isBrokenLikeSnippet(last)) return '👍';
    if (/^\[(sticker|like|image|attachment)\]$/i.test(last) || last === '👍') return '👍';
    if (/thumbs?\s*up/i.test(last) || /sent\s+(a\s+)?thumbs/i.test(last)) return '👍';
    if (/^attachment$/i.test(last)) return '👍';
    return last;
  }

  function formatConvPreview(c) {
    const last = normalizePreviewText(c.lastMsg);
    if (c.lastFromMe) return 'You: ' + (last || '');
    return last || 'No messages yet';
  }

  function activePageName() {
    return (M.pages.find(p => p.id === M.activePageId) || {}).name || '';
  }

  function convItemHtml(c, activePsid) {
    const isActive = c.psid === activePsid;
    const isUnread = c.unread > 0;
    const preview  = formatConvPreview(c);
    const short    = preview.length > 42 ? preview.slice(0, 42) + '…' : preview;
    const badge    = isUnread ? `<span class="msng-ci-badge">${c.unread > 9 ? '9+' : c.unread}</span>` : '';
    const pageLbl  = activePageName();
    const pageRow  = pageLbl
      ? `<div class="msng-ci-page">${esc(pageLbl)}</div>`
      : '';

    return `<div class="msng-conv-item ${isActive ? 'active' : ''} ${isUnread ? 'unread' : ''}"
                 data-psid="${esc(c.psid)}"
                 data-name="${esc(c.name)}"
                 data-pic="${esc(c.picture || '')}"
                 data-page="${esc(c.page_id || M.activePageId)}">
      <div class="msng-ci-avatar">${avatarHtml(c.picture, c.name, 'msng-ci-avatar-img')}</div>
      <div class="msng-ci-body">
        <div class="msng-ci-row1">
          <span class="msng-ci-name">${esc(c.name)}</span>
          <span class="msng-ci-time">${esc(fmtTime(c.lastMsgAt))}</span>
        </div>
        ${pageRow}
        <div class="msng-ci-last">${esc(short)}</div>
      </div>
      ${badge}
    </div>`;
  }

  /** API already normalizes content — client only maps fields + pending send state. */
  function isThumbsUpUrl(url) {
    const u = String(url || '').toLowerCase();
    if (!u) return false;
    if (/36923926\d{6,}/.test(u)) return true;
    if (/sticker[_-]?id[=\/]36923926/.test(u)) return true;
    if (/sticker.*thumbs|thumbs.*sticker|like_sticker/i.test(u)) return true;
    return false;
  }

  function looksLikeThumbsMsg(raw) {
    if (!raw) return false;
    const attType = String(raw.attachment_type || '').toLowerCase();
    const attUrl  = raw.attachment_url || '';
    const text    = String(raw.message || raw.text || '').trim();
    if (raw.is_like || raw._isLike || attType === 'like' || attType === 'thumbs_up') return true;
    if (text === '👍' || /^[\u{1F44D}\u{1F3FB}-\u{1F3FF}]/u.test(text)) return true;
    if (/^\[(sticker|like|attachment)\]$/i.test(text)) return true;
    if (isBrokenLikeSnippet(text)) return true;
    if (isThumbsUpUrl(attUrl)) return true;
    if (attType === 'sticker' && !text) return true;
    return false;
  }

  function resolveMsgFromMe(raw) {
    if (raw.from_me == 1 || raw.from_me === true) return 1;
    if (raw.from_me == 0 || raw.from_me === false) return 0;
    const dir = String(raw.direction || '').toUpperCase();
    if (dir === 'OUT' || dir === 'OUTBOUND') return 1;
    if (dir === 'IN' || dir === 'INBOUND') return 0;
    return 0;
  }

  function resolveMsgTime(raw) {
    return raw.fb_created_at || raw.created_at || raw.createdTime || null;
  }

  function unwrapMessagesResponse(data) {
    if (!data || data.error) return data;
    if (data.success === true && data.data && Array.isArray(data.data.messages)) {
      return {
        ...data,
        messages: data.data.messages,
        nextCursor: data.data.nextCursor,
        backfillPending: data.data.backfillPending,
        hasMore: data.data.hasMore ?? data.hasMore,
        conv_id: data.conv_id || data.data.conversation_id
      };
    }
    return data;
  }

  function mergeOlderMessages(older, current) {
    const keys = new Set(current.map(msgStableKey));
    const unique = older.filter((m) => !keys.has(msgStableKey(m)));
    return [...unique, ...current];
  }

  function updateHasOlderMessages(fresh, payload, before) {
    const limit = M.msgPageSize;
    const fromApi = payload.hasMore === true || payload.data?.hasMore === true;
    const fromCount = fresh.length >= limit;
    if (before) {
      M.hasOlderMessages = fresh.length > 0 && (fromApi || fromCount) && !_atRetentionBoundary();
    } else {
      M.hasOlderMessages = (fromApi || fromCount) && !_atRetentionBoundary();
    }
    if (before && fresh.length === 0) M.hasOlderMessages = false;
  }

  function applyMsgStatusFromMessages(msgs) {
    let delivered = 0;
    let read = 0;
    for (const m of msgs) {
      if (m.from_me != 1) continue;
      const seen = m.seen_at ? new Date(m.seen_at).getTime() : 0;
      const del = m.delivered_at ? new Date(m.delivered_at).getTime() : 0;
      if (seen && seen > read) read = seen;
      if (del && del > delivered) delivered = del;
    }
    if (read) M.msgStatus.read = Math.max(M.msgStatus.read, read);
    if (delivered) M.msgStatus.delivered = Math.max(M.msgStatus.delivered, delivered);
    if (read || delivered) updateTicksInDom();
  }

  function normalizeMsg(raw) {
    if (!raw) return raw;
    const like = looksLikeThumbsMsg(raw);
    const att0 = Array.isArray(raw.attachments) && raw.attachments[0] ? raw.attachments[0] : null;
    const attUrl = like ? null : (
      raw.media_permanent_url || raw.attachment_url || att0?.url || att0?.u || null
    );
    const attType = like ? 'like' : (
      raw.attachment_type || att0?.type || att0?.t || null
    );
    return {
      message_id: raw.fb_message_id || raw.message_id || raw.mid || raw.id || null,
      message: like ? '👍' : (raw.message || raw.text || ''),
      from_me: resolveMsgFromMe(raw),
      created_at: resolveMsgTime(raw),
      attachment_url: attUrl,
      attachment_type: attType,
      delivered_at: raw.delivered_at || null,
      seen_at: raw.seen_at || null,
      is_like: like,
      _tempId: raw._tempId,
      _pending: raw._pending,
      _failed: raw._failed,
      _isLike: like || raw._isLike
    };
  }

  function isLikeMessage(msg) {
    return looksLikeThumbsMsg(msg);
  }

  function msgPreviewText(msg) {
    if (!msg) return '';
    if (isLikeMessage(msg)) return '👍';
    const t = String(msg.message || '').trim();
    if (t) return t;
    const type = String(msg.attachment_type || '').toLowerCase();
    if (type === 'image') return '📷 Photo';
    if (type === 'video') return '🎬 Video';
    if (type === 'audio') return '🎵 Audio';
    if (msg.attachment_url) return '📎 Attachment';
    return '';
  }

  function bubbleHtml(msg) {
    msg = normalizeMsg(msg);
    const fromMe  = msg.from_me == 1;
    const txt     = String(msg.message || '').trim();
    const attUrl  = msg.attachment_url;
    const attType = String(msg.attachment_type || '').toLowerCase();
    const tempId  = msg._tempId  || '';

    const isLike  = isLikeMessage(msg);
    const likeHtml = '<span class="msng-like-bubble" aria-label="Thumbs up">👍</span>';
    const likeImgFallback = "this.outerHTML='<span class=\\'msng-like-bubble\\' aria-label=\\'Thumbs up\\'>👍</span>'";

    let content = '';
    if (isLike) {
      content = likeHtml;
    } else if (attUrl && (attType === 'image' || attType === 'photo' || attType === 'sticker')) {
      if (isThumbsUpUrl(attUrl)) {
        content = likeHtml;
      } else {
        content = `<img class="msng-att-img" src="${esc(attUrl)}" alt="Photo" role="button" tabindex="0" loading="lazy" onerror="${likeImgFallback}">`;
        if (txt) content += `<div style="margin-top:4px">${esc(txt)}</div>`;
      }
    } else if (txt) {
      content = esc(txt).replace(/\n/g, '<br>');
    } else if (attUrl) {
      content = isThumbsUpUrl(attUrl)
        ? likeHtml
        : `<a class="msng-media-link" href="${esc(attUrl)}" target="_blank" rel="noopener">${attType === 'video' ? '🎬 Video' : attType === 'audio' ? '🎵 Audio' : '📷 Photo'}</a>`;
    } else if (attType === 'image' || attType === 'video' || attType === 'audio') {
      const label = attType === 'video' ? '🎬 Video' : attType === 'audio' ? '🎵 Audio' : '📷 Photo';
      content = `<span class="msng-media-placeholder">${label}</span>`;
    } else if (attType === 'sticker' || attType === 'like') {
      content = likeHtml;
    }

    if (!content && (isLike || attType === 'sticker' || attType === 'like' || isThumbsUpUrl(attUrl))) {
      content = likeHtml;
    }

    const avatar = !fromMe
      ? `<div class="msng-msg-avatar-wrap">${avatarHtml(M.activeConvPic, M.activeConvName, 'msng-msg-avatar')}</div>`
      : '';

    // Page name label on sent messages (like competitor's "FBCast Pro")
    const pageName = fromMe
      ? esc(M.pages.find(p => p.id === M.activePageId)?.name || 'FBCast Pro')
      : '';
    const senderLabel = fromMe
      ? `<div class="msng-msg-sender"><i class="fa-brands fa-facebook-messenger" style="font-size:9px;opacity:.7"></i> ${pageName}</div>`
      : '';

    // Delivery status tick
    let tick = '';
    if (fromMe) {
      const msgTs = msg.created_at ? new Date(msg.created_at).getTime() : 0;
      if (msg._pending) {
        tick = `<span class="msng-tick msng-tick--sending" title="Sending…"><i class="fa-regular fa-clock"></i></span>`;
      } else if (msg._failed) {
        tick = `<span class="msng-tick msng-tick--failed" title="Failed"><i class="fa-solid fa-circle-exclamation"></i></span>`;
      } else if (M.msgStatus.read > 0 && msgTs > 0 && msgTs <= M.msgStatus.read) {
        tick = `<span class="msng-tick msng-tick--read" title="Seen"><i class="fa-solid fa-check-double"></i></span>`;
      } else if (M.msgStatus.delivered > 0 && msgTs > 0 && msgTs <= M.msgStatus.delivered) {
        tick = `<span class="msng-tick msng-tick--delivered" title="Delivered"><i class="fa-solid fa-check-double"></i></span>`;
      } else {
        tick = `<span class="msng-tick msng-tick--sent" title="Sent"><i class="fa-solid fa-check"></i></span>`;
      }
    }

    const createdTs = fromMe && msg.created_at ? new Date(msg.created_at).getTime() : 0;
    return `<div class="msng-msg ${fromMe ? 'from-me' : ''} ${msg._pending ? 'pending' : ''} ${msg._failed ? 'failed' : ''}"
                 ${tempId ? `data-temp-id="${esc(tempId)}"` : ''}
                 ${msg.message_id ? `data-msg-id="${esc(msg.message_id)}"` : ''}
                 ${createdTs ? `data-created-ts="${createdTs}"` : ''}>
      ${avatar}
      <div class="msng-msg-group">
        ${senderLabel}
        <div class="msng-bubble">${content}</div>
        <div class="msng-msg-meta">
          <span class="msng-msg-time">${esc(fmtMsgTime(msg.created_at))}</span>
          ${tick}
        </div>
      </div>
    </div>`;
  }

  // ══════════════════════════════════════════════════════════
  // CONV LIST — keyed DOM update (no full innerHTML replace)
  //
  // Why: renderConvs() is called on every poll tick (every 3s).
  // Full innerHTML wipes and rebuilds 50–200 nodes each time.
  // This causes: flickering, scroll jumping, lost hover states,
  // re-fetching avatar images, and unnecessary paint calls.
  //
  // Keyed update: identify each node by data-psid. Update only
  // what changed. Move nodes for reordering. Remove stale ones.
  // Result: smooth, zero-flicker conv list at any poll rate.
  // ══════════════════════════════════════════════════════════

  /** Remove loading placeholders so skeleton rows do not sit above real conversations. */
  function clearConvListPlaceholders(listEl) {
    if (!listEl) return;
    listEl.querySelectorAll('.msng-skeleton, #msngConvLoadMore').forEach(el => el.remove());
  }

  /** Unread filter empty state — must clear before showing conversation rows again. */
  function clearConvListEmptyState(listEl) {
    if (!listEl) return;
    listEl.querySelectorAll('.msng-empty').forEach(el => el.remove());
  }

  /** Count unread conversations (matches Unread filter chip). */
  function countUnreadConvsForPage(pageId) {
    if (String(pageId) !== String(M.activePageId) || !M.convs.length) return null;
    return M.convs.filter(c => (c.unread || 0) > 0).length;
  }

  /**
   * Page sidebar badge — on the active page use loaded conv list so the badge
   * matches what the Unread filter shows (poll DB totals can lag behind read locks).
   */
  function syncPageBadge(pageId, serverHint) {
    if (!pageId) return;
    const local = countUnreadConvsForPage(pageId);
    const n = local != null
      ? local
      : (typeof serverHint === 'number' ? serverHint : (M.pageUnread[pageId] || 0));
    updatePageBadge(pageId, n);
  }

  function renderConvsNow(opts) {
    if (M.search.active) return; // search results own the list — don't overwrite them
    const listEl = $('msngConvList');
    if (!listEl) return;
    const forceRebuild = !!(opts && opts.forceRebuild);

    const q    = M.search.query.toLowerCase();
    const list = getDisplayConvs();
    const sig  = list.map(convRowSig).join('\n');
    const order = list.map(c => c.psid).join(',');

    syncPageBadge(M.activePageId);
    updateMessengerChrome();
    schedulePageUnreadRefresh(600);

    if (list.length) {
      clearConvListPlaceholders(listEl);
      clearConvListEmptyState(listEl);
    }

    if (!list.length) {
      invalidateConvListRender();
      if (q) {
        listEl.innerHTML = `<div class="msng-empty">
          <i class="fa-brands fa-facebook-messenger"></i>
          <p>No results for "<strong>${esc(q)}</strong>"</p>
        </div>`;
      } else if (M.convFilter === 'unread') {
        listEl.innerHTML = `<div class="msng-empty">
          <i class="fa-solid fa-inbox"></i>
          <h4>All caught up</h4>
          <p>No unread conversations on this page.</p>
        </div>`;
      } else if (M.ui.syncing) {
        listEl.innerHTML = `<div class="msng-empty">
          <i class="fa-solid fa-rotate fa-spin" style="font-size:28px;color:var(--primary-color);margin-bottom:10px"></i>
          <h4>Loading conversations…</h4>
          <p style="font-size:12px;opacity:.7">Updating automatically from Facebook</p>
        </div>`;
      } else {
        listEl.innerHTML = `<div class="msng-empty">
          <i class="fa-brands fa-facebook-messenger"></i>
          <h4>No chats yet</h4>
          <p>Conversations appear here when customers message your page.</p>
        </div>`;
      }
      return;
    }

    const orderChanged   = order !== M._lastConvOrderSig;
    const contentChanged = sig !== M._lastConvRenderSig;
    if (!forceRebuild && !orderChanged && !contentChanged) return;
    M._lastConvRenderSig = sig;
    M._lastConvOrderSig  = order;

    const existing = {};
    if (forceRebuild) {
      listEl.querySelectorAll('.msng-conv-item[data-psid]').forEach(el => el.remove());
    } else {
      listEl.querySelectorAll('.msng-conv-item[data-psid]').forEach(el => {
        existing[el.dataset.psid] = el;
      });
    }

    const wanted = new Set(list.map(c => String(c.psid)));
    if (!forceRebuild) {
      Object.keys(existing).forEach(psid => { if (!wanted.has(psid)) existing[psid].remove(); });
    }

    if (forceRebuild || orderChanged) {
      const frag = document.createDocumentFragment();
      list.forEach((c) => {
        let node = existing[c.psid];
        if (node) {
          patchConvListNode(node, c);
        } else {
          const tmp = document.createElement('div');
          tmp.innerHTML = convItemHtml(c, M.activePsid);
          node = tmp.firstElementChild;
          existing[c.psid] = node;
        }
        frag.appendChild(node);
      });
      listEl.appendChild(frag);
    } else {
      list.forEach((c) => {
        let node = existing[c.psid];
        if (node) {
          patchConvListNode(node, c);
        } else {
          const tmp = document.createElement('div');
          tmp.innerHTML = convItemHtml(c, M.activePsid);
          node = tmp.firstElementChild;
          existing[c.psid] = node;
          listEl.appendChild(node);
        }
      });
    }
  }

  function renderConvs(opts) {
    if (opts && opts.immediate) {
      if (M._renderConvsRaf) {
        cancelAnimationFrame(M._renderConvsRaf);
        M._renderConvsRaf = 0;
      }
      renderConvsNow(opts);
      return;
    }
    if (M._renderConvsRaf) return;
    const passOpts = opts;
    M._renderConvsRaf = requestAnimationFrame(() => {
      M._renderConvsRaf = 0;
      renderConvsNow(passOpts);
    });
  }

  function showConvSkeleton() {
    const listEl = $('msngConvList');
    if (!listEl) return;
    const sk = () => `<div class="msng-skeleton">
      <div class="msng-sk-circle"></div>
      <div class="msng-sk-lines">
        <div class="msng-sk-line w80"></div>
        <div class="msng-sk-line w60"></div>
      </div>
    </div>`;
    invalidateConvListRender();
    listEl.innerHTML = sk() + sk() + sk() + sk() + sk();
  }

  function updateDocumentUnreadTitle() {
    const total = Object.values(M.pageUnread).reduce((s, n) => s + (parseInt(n, 10) || 0), 0);
    const base = document.title.replace(/^\(\d+\)\s*/, '') || 'Messenger';
    document.title = total > 0 ? `(${total > 99 ? '99+' : total}) ${base}` : base;
  }

  function applyUnreadByPage(unreadByPage) {
    const map = {};
    if (unreadByPage && typeof unreadByPage === 'object') {
      Object.entries(unreadByPage).forEach(([pid, n]) => {
        map[String(pid)] = Math.max(0, parseInt(n, 10) || 0);
      });
    }
    (M.pages || []).forEach((p) => {
      const id = String(p.id);
      const serverCount = map[id] ?? 0;
      if (id === String(M.activePageId)) {
        syncPageBadge(id, serverCount);
      } else {
        updatePageBadge(id, serverCount);
      }
    });
    renderPages();
    updateDocumentUnreadTitle();
  }

  async function fetchPageUnreadCounts() {
    if (!M.pages.length) return {};
    try {
      const params = {};
      if (M.pagePoll.since) params.since = M.pagePoll.since;
      if (M.activePageId) params.active_page_id = M.activePageId;
      if (M.activePsid) params.active_psid = M.activePsid;
      const data = await get('poll_pages', params);
      if (data?.server_time) M.pagePoll.since = data.server_time;
      if (data?.unread_by_page) applyUnreadByPage(data.unread_by_page);
      return data?.unread_by_page || {};
    } catch (e) {
      console.warn('[Messenger] fetchPageUnreadCounts:', e.message);
      return {};
    }
  }

  let _pageUnreadRefreshTimer = null;
  function schedulePageUnreadRefresh(delayMs = 400) {
    clearTimeout(_pageUnreadRefreshTimer);
    _pageUnreadRefreshTimer = setTimeout(() => {
      _pageUnreadRefreshTimer = null;
      fetchPageUnreadCounts();
    }, delayMs);
  }

  function updatePageBadge(pageId, count) {
    if (!pageId) return;
    const id = String(pageId);
    const prev = M.pageUnread[id] || 0;
    const n = parseInt(count, 10) || 0;
    M.pageUnread[id] = n;
    const badge = $('msngPageBadge_' + id);
    if (badge) {
      badge.style.display = n > 0 ? 'flex' : 'none';
      badge.textContent   = n > 99 ? '99+' : String(n);
      if (n > prev) {
        badge.classList.remove('msng-page-badge--pop');
        void badge.offsetWidth;
        badge.classList.add('msng-page-badge--pop');
        setTimeout(() => badge.classList.remove('msng-page-badge--pop'), 500);
      }
    }
    const sub = $('msngPageSub_' + id);
    if (sub) sub.textContent = n > 0 ? `${n} unread` : 'No unread';
    const item = document.querySelector(`.msng-page-item[data-page-id="${CSS.escape(id)}"]`);
    if (item) item.classList.toggle('has-unread', n > 0);
    const dot = item?.querySelector('.msng-page-unread-dot');
    if (dot) dot.style.display = n > 0 ? 'block' : 'none';
    updateDocumentUnreadTitle();
  }

  function pageNameById(pageId) {
    return M.pages.find(p => String(p.id) === String(pageId))?.name || 'Page';
  }

  function maybeNotifyIncoming({ pageId, psid, sender, pageName, preview } = {}) {
    if (!pageId || !psid) return;
    const isActivePage = String(pageId) === String(M.activePageId);
    const isOpenConv   = isActivePage && String(psid) === String(M.activePsid);
    if (isOpenConv || document.hidden) return;

    const key = `${pageId}:${psid}:${String(preview || '').slice(0, 80)}`;
    const now = Date.now();
    if (M._lastNotifKey === key && now - (M._lastNotifAt || 0) < 2500) return;
    M._lastNotifKey = key;
    M._lastNotifAt  = now;

    showMessageToast({
      sender: sender || 'Customer',
      pageName: pageName || pageNameById(pageId),
      preview: preview || '',
      pageId,
      psid
    });
    _playNotifSound();
  }

  // ══════════════════════════════════════════════════════════
  // CHAT WINDOW
  // ══════════════════════════════════════════════════════════

  function renderMessages(mode = 'replace', opts = {}) {
    const msgsEl = $('msngMsgs');
    if (!msgsEl) return;

    sortMsgsInPlace();

    if (!M.msgs.length) {
      msgsEl.innerHTML = `<div class="msng-empty" style="margin-top:60px">
        <i class="fa-regular fa-comments"></i>
        <p>No messages yet. Start the conversation!</p>
      </div>`;
      return;
    }

    const showLoadMore = M.hasOlderMessages && !_atRetentionBoundary();
    const showStart    = M.msgs.length > 0 && !showLoadMore;
    let html = showLoadMore
      ? `<div class="msng-load-more" id="msngLoadMoreWrap">
           <div class="msng-load-more-hint"><i class="fa-solid fa-chevron-up"></i> Scroll up for older messages</div>
         </div>`
      : showStart
      ? `<div class="msng-conv-start">
           <div class="msng-conv-start-avatar">${avatarHtml(M.activeConvPic, M.activeConvName, 'msng-conv-start-img')}</div>
           <div class="msng-conv-start-name">${esc(M.activeConvName)}</div>
           <div class="msng-conv-start-sub">Beginning of your conversation on Facebook Messenger</div>
         </div>`
      : '';

    let lastDate = '';
    M.msgs.forEach(raw => {
      const msg = normalizeMsg(raw);
      const dateStr = fmtDate(msg.created_at);
      if (dateStr !== lastDate) {
        html    += `<div class="msng-date-sep"><span>${esc(dateStr)}</span></div>`;
        lastDate = dateStr;
      }
      html += bubbleHtml(msg);
      trackMsgId(msg);
    });

    if (mode === 'replace') {
      const prevTop    = msgsEl.scrollTop;
      const prevHeight = msgsEl.scrollHeight;
      const nearBottom = isMsgsNearBottom(msgsEl);
      msgsEl.innerHTML = html;
      const scrollMode = opts.scroll || 'bottom';
      if (scrollMode === 'force') {
        scrollToBottom(false, true);
      } else if (scrollMode === 'preserve') {
        msgsEl.scrollTop = prevTop + (msgsEl.scrollHeight - prevHeight);
      } else if (nearBottom) {
        scrollToBottom(false, true);
      }
    } else {
      // Preserve scroll position (load-more prepend)
      const prevHeight = msgsEl.scrollHeight;
      const prevTop    = msgsEl.scrollTop;
      msgsEl.innerHTML = html;
      msgsEl.scrollTop = msgsEl.scrollHeight - prevHeight + prevTop;
    }

    bindScrollListener(msgsEl);
    if ($('msngContactPanel')?.classList.contains('is-open')) renderContactMedia();
  }

  function appendNewMessagesFromIndex(startIndex, opts = {}) {
    for (let i = startIndex; i < M.msgs.length; i++) {
      const msg = M.msgs[i];
      if (isDuplicate(msg)) continue;
      appendBubble(msg, opts);
    }
  }

  // Append one bubble without rebuilding the list.
  // Used by real-time poll and optimistic send.
  function appendBubble(msg, opts = {}) {
    msg = normalizeMsg(msg);
    const msgsEl = $('msngMsgs');
    if (!msgsEl) return;

    // Replace empty-state div if it's the only content
    if (msgsEl.querySelector('.msng-empty') && !msgsEl.querySelector('.msng-msg')) {
      msgsEl.innerHTML = M.hasOlderMessages
        ? `<div class="msng-load-more" id="msngLoadMoreWrap">
             <div class="msng-load-more-hint"><i class="fa-solid fa-chevron-up"></i> Scroll up for older messages</div>
           </div>`
        : '';
    }

    // Add date separator if needed
    const dateStr = fmtDate(msg.created_at || new Date().toISOString());
    const lastSep = msgsEl.querySelector('.msng-date-sep:last-of-type');
    if (!lastSep || lastSep.querySelector('span')?.textContent !== dateStr) {
      msgsEl.insertAdjacentHTML('beforeend', `<div class="msng-date-sep"><span>${esc(dateStr)}</span></div>`);
    }

    msgsEl.insertAdjacentHTML('beforeend', bubbleHtml(msg));
    const newEl = msgsEl.lastElementChild;
    if (newEl?.classList.contains('msng-msg') && opts.animate !== false) {
      newEl.classList.add('msng-msg-new');
      setTimeout(() => newEl.classList.remove('msng-msg-new'), 350);
    }
    trackMsgId(msg);
    const stick = isMsgsNearBottom(msgsEl) || msg.from_me == 1;
    if (stick) scrollToBottom(true, true);
    if ($('msngContactPanel')?.classList.contains('is-open')) renderContactMedia();
  }

  function trackMsgId(msg) {
    if (msg.message_id) M.renderedMsgIds.add(msg.message_id);
    if (msg._tempId)    M.renderedMsgIds.add(msg._tempId);
  }

  // O(1) dedup check. Fallback content hash for messages without IDs.
  function isDuplicate(msg) {
    if (msg.message_id && M.renderedMsgIds.has(msg.message_id)) return true;
    if (!msg.message_id && msg.created_at && msg.message !== undefined) {
      const hash = msg.created_at + '|' + msg.from_me + '|' + msg.message;
      if (M.renderedMsgIds.has(hash)) return true;
      M.renderedMsgIds.add(hash);
    }
    return false;
  }

  function msgStableKey(m) {
    if (m.message_id) return 'id:' + m.message_id;
    if (m._tempId) return 't:' + m._tempId;
    return 'h:' + (m.created_at || '') + '|' + m.from_me + '|' + String(m.message || '').slice(0, 120);
  }

  function msgsSignature(msgs) {
    return msgs.map(msgStableKey).join('\n');
  }

  function msgTimeMs(m) {
    const t = new Date(m?.created_at || 0).getTime();
    return Number.isFinite(t) ? t : 0;
  }

  /** True when an optimistic outgoing bubble matches a server row (avoid duplicates on reload). */
  function pendingMatchesServer(pending, server) {
    if (!pending || !server) return false;
    if (pending.from_me != 1 || server.from_me != 1) return false;
    if (pending.message_id && server.message_id && pending.message_id === server.message_id) return true;
    if (isLikeMessage(pending) && isLikeMessage(server)) {
      return Math.abs(msgTimeMs(pending) - msgTimeMs(server)) < 180_000;
    }
    if (pending.attachment_type === 'image' && server.attachment_type === 'image') {
      return Math.abs(msgTimeMs(pending) - msgTimeMs(server)) < 180_000;
    }
    const pt = String(pending.message || '').trim();
    const st = String(server.message || '').trim();
    if (!pt || !st || pt !== st) return false;
    return Math.abs(msgTimeMs(pending) - msgTimeMs(server)) < 180_000;
  }

  /** Drop pending rows that already exist on the server; confirm matching bubbles in the DOM. */
  function reconcilePendingWithFresh(fresh, pending) {
    const serverIds = new Set(fresh.map(m => m.message_id).filter(Boolean));
    const keep = [];
    for (const p of pending) {
      if (p._failed) {
        keep.push(p);
        continue;
      }
      if (p.message_id && serverIds.has(p.message_id)) continue;
      const match = fresh.find(s => pendingMatchesServer(p, s));
      if (match) {
        if (p._pending) {
          _tryConfirmPending({
            from_me: 1,
            message_id: match.message_id,
            message: match.message || p.message,
            created_at: match.created_at || p.created_at,
            attachment_type: match.attachment_type || p.attachment_type,
            attachment_url: match.attachment_url || p.attachment_url
          });
        }
        continue;
      }
      keep.push(p);
    }
    return keep;
  }

  function sortMsgsInPlace() {
    M.msgs.sort((a, b) => msgTimeMs(a) - msgTimeMs(b));
  }

  /** @returns {'noop'|'append'|'full'} */
  function planMessagesDomUpdate(prev, next) {
    if (!prev.length && !next.length) return 'noop';
    if (!prev.length && next.length) return 'full';
    if (msgsSignature(prev) === msgsSignature(next)) return 'noop';
    const prevKeys = prev.map(msgStableKey);
    const nextKeys = next.map(msgStableKey);
    if (nextKeys.length >= prevKeys.length
        && nextKeys.slice(0, prevKeys.length).join('|') === prevKeys.join('|')) {
      return 'append';
    }
    return 'full';
  }

  // Race-condition guard: Facebook echoes our sent message back before the POST
  // response arrives → renderedMsgIds doesn't have the message_id yet → duplicate.
  // Fix: find the matching pending bubble and confirm it in-place.
  function _tryConfirmPending(msg) {
    if (msg.from_me != 1 || !msg.message_id) return false;
    const pending = M.msgs.find(m => {
      if (!m._pending || m.message_id) return false;
      if (pendingMatchesServer(m, msg)) return true;
      return (m.message || '').trim() === (msg.message || '').trim();
    });
    if (!pending) return false;

    pending.message_id = msg.message_id;
    pending._pending   = false;
    if (msg.attachment_url && pending.attachment_type === 'image') {
      pending.attachment_url = msg.attachment_url;
    }
    if (msg.message && !pending.message) pending.message = msg.message;
    M.renderedMsgIds.add(msg.message_id);

    if (pending._tempId) {
      const bubble = document.querySelector(`[data-temp-id="${pending._tempId}"]`);
      if (bubble) {
        bubble.removeAttribute('data-temp-id');
        bubble.classList.remove('pending');
        bubble.dataset.msgId = msg.message_id;
        if (msg.created_at) bubble.dataset.createdTs = new Date(msg.created_at).getTime();
        const tickEl = bubble.querySelector('.msng-tick');
        if (tickEl) {
          tickEl.className = 'msng-tick msng-tick--sent';
          tickEl.title     = 'Sent';
          tickEl.innerHTML = '<i class="fa-solid fa-check"></i>';
        }
      }
      delete pending._tempId;
    }
    return true;
  }

  function isMsgsNearBottom(msgsEl, threshold = 96) {
    if (!msgsEl) return true;
    return msgsEl.scrollHeight - msgsEl.scrollTop - msgsEl.clientHeight <= threshold;
  }

  function scrollToBottom(smooth = false, force = false) {
    const msgsEl = $('msngMsgs');
    if (!msgsEl) return;
    if (!force && !isMsgsNearBottom(msgsEl)) return;
    msgsEl.scrollTo({ top: msgsEl.scrollHeight, behavior: smooth ? 'smooth' : 'instant' });
    $('msngScrollBtn')?.classList.remove('visible');
  }

  function updateTicksInDom() {
    const msgsEl = $('msngMsgs');
    if (!msgsEl) return;
    msgsEl.querySelectorAll('.msng-msg.from-me[data-created-ts]').forEach(el => {
      const ts     = parseInt(el.dataset.createdTs || '0');
      const tickEl = el.querySelector('.msng-tick');
      if (!tickEl || !ts || el.classList.contains('pending') || el.classList.contains('failed')) return;
      if (M.msgStatus.read > 0 && ts <= M.msgStatus.read) {
        tickEl.className = 'msng-tick msng-tick--read';
        tickEl.title     = 'Seen';
        tickEl.innerHTML = '<i class="fa-solid fa-check-double"></i>';
      } else if (M.msgStatus.delivered > 0 && ts <= M.msgStatus.delivered) {
        tickEl.className = 'msng-tick msng-tick--delivered';
        tickEl.title     = 'Delivered';
        tickEl.innerHTML = '<i class="fa-solid fa-check-double"></i>';
      }
    });
  }

  const SCROLL_LOAD_TOP_PX = 100;
  let _scrollLoadDebounce = null;

  function bindScrollListener(msgsEl) {
    const btn = $('msngScrollBtn');
    msgsEl.onscroll = () => {
      const atBottom = msgsEl.scrollHeight - msgsEl.scrollTop - msgsEl.clientHeight < 60;
      if (btn) btn.classList.toggle('visible', !atBottom);

      if (msgsEl.scrollTop > SCROLL_LOAD_TOP_PX) return;
      if (!M.hasOlderMessages || M.ui.loadingMore || !M.oldestMsgTime || !M.activePsid) return;
      clearTimeout(_scrollLoadDebounce);
      _scrollLoadDebounce = setTimeout(() => {
        if (msgsEl.scrollTop <= SCROLL_LOAD_TOP_PX && M.hasOlderMessages && !M.ui.loadingMore) {
          window.msngLoadMore();
        }
      }, 120);
    };
  }

  function contactNoteKey() {
    if (!M.activePageId || !M.activePsid) return '';
    return `msng_note_${M.activePageId}_${M.activePsid}`;
  }

  function mediaUrlsFromMsgs(msgs) {
    const items = [];
    const seen = new Set();
    for (const m of msgs) {
      const url = m.attachment_url;
      const t = String(m.attachment_type || '').toLowerCase();
      if (!url || isThumbsUpUrl(url) || seen.has(url)) continue;
      if (t === 'image' || t === 'photo' || t === 'sticker' || /\.(jpe?g|png|gif|webp)(\?|$)/i.test(url)) {
        seen.add(url);
        items.push(url);
      }
    }
    return items;
  }

  function scheduleContactMediaRefresh() {
    clearTimeout(M._contactMediaTimer);
    M._contactMediaTimer = setTimeout(() => loadContactMedia(), 450);
  }

  async function loadContactMedia() {
    if (!M.activePageId || !M.activePsid) return;
    const forPsid = M.activePsid;
    try {
      const qs = new URLSearchParams({
        action: 'conversation_media',
        page_id: M.activePageId,
        psid: forPsid,
        limit: '120'
      }).toString();
      const r = await fetch('/api/messenger?' + qs, { credentials: 'same-origin' });
      if (!r.ok || M.activePsid !== forPsid) return;
      const data = await r.json();
      if (M.activePsid !== forPsid) return;
      M.contactMedia = data.data?.media || data.media || [];
      M._contactMediaPsid = forPsid;
    } catch {
      if (M.activePsid === forPsid) M.contactMedia = null;
    }
    renderContactMedia();
  }

  function renderContactMedia() {
    const grid = $('msngContactMedia');
    if (!grid) return;

    const seen = new Set();
    const urls = [];

    const fromApi = (M._contactMediaPsid === M.activePsid && Array.isArray(M.contactMedia))
      ? M.contactMedia : [];
    for (const item of fromApi) {
      const u = item?.url || item;
      if (!u || seen.has(u) || isThumbsUpUrl(u)) continue;
      seen.add(u);
      urls.push(u);
    }
    for (const u of mediaUrlsFromMsgs(M.msgs)) {
      if (!seen.has(u)) {
        seen.add(u);
        urls.push(u);
      }
    }

    if (!urls.length) {
      grid.innerHTML = '<p class="msng-contact-empty">No shared images in this chat yet.</p>';
      return;
    }
    grid.innerHTML = urls.slice(0, 24).map((u) =>
      `<a href="${esc(u)}" target="_blank" rel="noopener noreferrer" class="msng-media-thumb">` +
      `<img src="${esc(u)}" alt="" loading="lazy" decoding="async"></a>`
    ).join('');
  }

  function updateContactPanel() {
    const panel = $('msngContactPanel');
    if (!panel || !M.activePsid) return;

    const nameEl = $('msngContactName');
    if (nameEl) nameEl.textContent = M.activeConvName || 'Contact';

    const av = $('msngContactAvatar');
    if (av) av.innerHTML = avatarHtml(M.activeConvPic, M.activeConvName, 'msng-contact-av');

    const groups = $('msngContactGroups');
    if (groups) groups.textContent = activePageName() || 'Facebook Page';

    const note = $('msngContactNote');
    if (note) note.value = localStorage.getItem(contactNoteKey()) || '';

    renderContactMedia();
    loadContactMedia();

    const toggle = $('msngContactToggleBtn');
    if (toggle) toggle.setAttribute('aria-expanded', panel.classList.contains('is-open') ? 'true' : 'false');
  }

  function showChatWindow(name, picture) {
    $('msngChatEmpty').style.display  = 'none';
    $('msngChatWindow').style.display = 'flex';
    $('msngChatHdrName').textContent  = name || 'User';
    $('msngChatHdrSub').innerHTML = `<span class="msng-online-dot"></span> Facebook Messenger`;
    const wrap = $('msngChatHdrAvatar');
    if (wrap) wrap.innerHTML = avatarHtml(picture, name, 'msng-hdr-avatar');
    updateContactPanel();
    const panel = $('msngContactPanel');
    if (panel && window.innerWidth > 1200) {
      panel.classList.add('is-open');
      panel.setAttribute('aria-hidden', 'false');
      updateContactPanel();
    }
  }

  function showChatEmpty() {
    const w = $('msngChatWindow'), e = $('msngChatEmpty');
    if (w) w.style.display = 'none';
    if (e) e.style.display = 'flex';
    const panel = $('msngContactPanel');
    if (panel) {
      panel.classList.remove('is-open');
      panel.setAttribute('aria-hidden', 'true');
    }
    const toggle = $('msngContactToggleBtn');
    if (toggle) toggle.setAttribute('aria-expanded', 'false');
  }

  // ══════════════════════════════════════════════════════════
  // POLLING — setTimeout chain (not setInterval)
  //
  // Why setTimeout over setInterval:
  //   setInterval fires on a fixed clock regardless of whether
  //   the previous request finished. Under slow networks, you
  //   get concurrent requests, which produces race conditions
  //   in state updates (e.g. M.lastPollTime gets written twice).
  //
  //   setTimeout-chain schedules the next poll only AFTER the
  //   current response is fully processed — clean sequencing.
  //
  // Exponential backoff on failure:
  //   3s → 6s → 12s → 24s → 30s (cap). Resets on any success.
  //   Prevents hammering the server when the DB is slow or the
  //   network is flaky.
  //
  // Tab visibility (visibilitychange):
  //   Polling is suspended when the browser tab is hidden.
  //   Resumes with a short delay when the tab becomes active.
  //   Saves server load and battery on background tabs.
  // ══════════════════════════════════════════════════════════

  function resetReadState() {
    M._readLocked.clear();
    M._readLockAt.clear();
    M._readMarkTimers.forEach(t => clearTimeout(t));
    M._readMarkTimers.clear();
    M._readMarkInflight.clear();
  }

  function startPolling() {
    stopPolling();
    M.poll.since    = new Date(Date.now() - 3000).toISOString();
    M._metaListRefreshAt = 0;
    resetReadState();
    M.poll.failures = 0;
    schedulePoll(nextPollDelayMs());
    startConvListAutoRefresh();
    startPagePolling();
  }

  function stopPollTimer() {
    if (M.poll.timer) { clearTimeout(M.poll.timer); M.poll.timer = null; }
  }

  function stopPagePollTimer() {
    if (M.pagePoll.timer) { clearTimeout(M.pagePoll.timer); M.pagePoll.timer = null; }
  }

  function schedulePagePoll(delayMs) {
    stopPagePollTimer();
    if (!M.pages.length) return;
    M.pagePoll.timer = setTimeout(runPagePoll, delayMs);
  }

  async function runPagePoll() {
    M.pagePoll.timer = null;
    if (document.hidden || !M.pages.length) return;

    try {
      const params = {};
      if (M.pagePoll.since) params.since = M.pagePoll.since;
      if (M.activePageId) params.active_page_id = M.activePageId;
      if (M.activePsid) params.active_psid = M.activePsid;

      const data = await get('poll_pages', params);
      if (data.error) {
        schedulePagePoll(PAGE_POLL_MS * 2);
        return;
      }

      if (data.server_time) M.pagePoll.since = data.server_time;
      applyUnreadByPage(data.unread_by_page);

      (data.notifications || []).forEach((n) => {
        const pid = n.page_id;
        if (!pid) return;
        if (String(pid) === String(M.activePageId)) return;
        maybeNotifyIncoming({
          pageId: pid,
          psid: n.fb_user_id,
          sender: n.user_name || 'Customer',
          pageName: pageNameById(pid),
          preview: normalizePreviewText(n.snippet || '')
        });
      });

      schedulePagePoll(PAGE_POLL_MS);
    } catch (e) {
      console.warn('[Messenger] page poll:', e.message);
      schedulePagePoll(PAGE_POLL_MS * 2);
    }
  }

  function startPagePolling() {
    stopPagePollTimer();
    if (!M.pages.length) return;
    if (!M.pagePoll.since) {
      M.pagePoll.since = new Date(Date.now() - 5000).toISOString();
    }
    schedulePagePoll(800);
  }

  function stopPagePolling() {
    stopPagePollTimer();
  }

  function stopPolling() {
    stopPollTimer();
    stopPagePolling();
    stopConvListAutoRefresh();
  }

  /** Silent merge refresh — no skeleton, no full list replace (no flicker). */
  async function refreshConvListSilent() {
    if (!M.activePageId || !M.convs.length || M.search.active || M._listRefreshInFlight) {
      return false;
    }
    M._listRefreshInFlight = true;
    try {
      const data = await get('load_conversations', {
        page_id: M.activePageId,
        limit: CONV_PAGE_SIZE,
        offset: 0
      });
      if (data.error) return false;

      const newConvs = _mapConvRows(data.conversations);
      const merged   = mergeConvListFromServer(newConvs);
      const reordered = applyMetaConvOrder(newConvs) || resortConvsByMeta();
      if (merged || reordered) renderConvs();

      _convListCache.set(M.activePageId, {
        convs: M.convs,
        order: M._convOrder.slice(),
        offset: M.convOffset,
        hasMore: M.convHasMore,
        ts: Date.now()
      });
      if (typeof data.total_unread === 'number') {
        syncPageBadge(M.activePageId, data.total_unread);
      } else {
        syncPageBadge(M.activePageId);
      }
      return merged || reordered;
    } catch (e) {
      console.warn('[Messenger] refreshConvListSilent:', e.message);
      return false;
    } finally {
      M._listRefreshInFlight = false;
    }
  }

  function startConvListAutoRefresh() {
    stopConvListAutoRefresh();
    const btn = $('msngRefreshBtn');
    if (btn) btn.classList.add('spinning');

    const tick = async () => {
      M._convListRefreshTimer = null;
      const now = Date.now();
      if (M.activePageId && !document.hidden && !M.search.active && M.convs.length
          && now - (M._metaListRefreshAt || 0) >= CONV_LIST_META_ORDER_MS) {
        M._metaListRefreshAt = now;
        await refreshConvListSilent();
      }
      if (M.activePageId) {
        M._convListRefreshTimer = setTimeout(tick, CONV_LIST_META_ORDER_MS);
      }
    };

    tick();
  }

  function stopConvListAutoRefresh() {
    if (M._convListRefreshTimer) {
      clearTimeout(M._convListRefreshTimer);
      M._convListRefreshTimer = null;
    }
    const btn = $('msngRefreshBtn');
    if (btn) btn.classList.remove('spinning');
  }

  function schedulePoll(delayMs) {
    stopPollTimer();
    M.poll.timer = setTimeout(runPoll, delayMs);
  }

  async function runPoll() {
    M.poll.timer = null;
    if (!M.activePageId || document.hidden) return;
    if (M.ui.loadingConvs && String(M._loadingConvsFor) === String(M.activePageId)) {
      schedulePoll(nextPollDelayMs());
      return;
    }

    try {
      const params = { page_id: M.activePageId, since: M.poll.since };
      if (M.activePsid) params.psid = M.activePsid;

      const data = await get('poll', params);
      if (data.error && data.error.includes('Session')) {
        showToast(data.error, 'error', 8000);
        stopPolling();
        return;
      }
      const wasOffline = M.poll.failures >= 3;
      setPollSince(data.server_time);
      M.poll.failures = 0;
      if (wasOffline) { hideConnBanner(); showToast('Back online', 'success', 2500); }

      if (typeof data.total_unread === 'number') {
        syncPageBadge(M.activePageId, data.total_unread);
      } else {
        syncPageBadge(M.activePageId);
      }

      // Quiet poll — badge already updated; skip DOM
      if (data.has_changes === false) {
        schedulePoll(nextPollDelayMs());
        return;
      }

      const msgLoadBusy = !!M._msgAbort;

      // New messages in the open conversation
      let gotNewMsg = false;
      if (!msgLoadBusy) {
        (data.new_messages || []).forEach(raw => {
          const msg = normalizeMsg(raw);
          if (_tryConfirmPending(msg)) return;
          if (!isDuplicate(msg)) {
            M.msgs.push(msg);
            appendBubble(msg, { animate: false });
            gotNewMsg = true;
          }
        });
      }
      if (gotNewMsg) {
        syncOpenConvSidebarFromMessages();
        const msgsEl = $('msngMsgs');
        if (isMsgsNearBottom(msgsEl)) scrollToBottom(true, true);
      }

      // Open thread: Meta sync may have landed in DB without appearing in poll slice
      if (M.activePsid && data.meta_sync && !gotNewMsg && !msgLoadBusy && !M.ui.sending) {
        const now = Date.now();
        if (now - (M._graphMsgReloadAt || 0) > 12_000) {
          M._graphMsgReloadAt = now;
          loadMessages(null, { silent: true }).catch(() => {});
        }
      }

      // Updated conversations (unread counts, snippets, new convs from other senders)
      let convListDirty = false;
      if (data.updated_convs?.length) {
        convListDirty = applyPollConvUpdates(data.updated_convs);

        const newFromOthers = data.updated_convs.filter(c =>
          c.fb_user_id !== M.activePsid && parseInt(c.is_unread) > 0
        );
        if (newFromOthers.length) {
          const nc = newFromOthers[0];
          maybeNotifyIncoming({
            pageId: M.activePageId,
            psid: nc.fb_user_id,
            sender: nc.user_name || 'A customer',
            pageName: pageNameById(M.activePageId),
            preview: nc.snippet ? normalizePreviewText(nc.snippet) : ''
          });
        }
      }

      if (convListDirty || gotNewMsg || syncOpenConvSidebarFromMessages()) {
        renderConvs();
      }

      schedulePoll(nextPollDelayMs());

    } catch (e) {
      M.poll.failures++;
      const base  = Math.min(POLL_MS * (2 ** M.poll.failures), 30_000);
      const jitter = Math.floor(Math.random() * 1000); // spread clients
      schedulePoll(base + jitter);

      if (M.poll.failures === 3) {
        showToast('Connection is slow — retrying…', 'warning', 5000);
      } else if (M.poll.failures >= 6) {
        showConnBanner('Reconnecting… check your network');
      }
      console.warn('[Messenger] poll error (attempt ' + M.poll.failures + '):', e.message);
    }
  }

  // Pause when tab hidden, resume when visible
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      stopPolling();
    } else if (M.activePageId) {
      schedulePoll(500);
      startConvListAutoRefresh();
      startPagePolling();
    }
  });

  // ══════════════════════════════════════════════════════════
  // SEND MESSAGE — optimistic UI with correct rollback
  //
  // Why not M.msgs.pop() for rollback:
  //   Between the optimistic append and the server response,
  //   a poll tick can add new messages to M.msgs. pop() would
  //   remove that new message, not the failed one.
  //
  // Correct approach: tag the pending bubble with a unique
  // tempId. On failure, find that specific DOM node and bubble
  // by tempId and mark it .failed — everything else is untouched.
  // The user can retry without losing the conversation context.
  // ══════════════════════════════════════════════════════════

  async function doSend(text, retryTempId = null) {
    if (M.ui.sending || !text.trim()) return;
    if (!M.activePsid || !M.activePageId || !M.activeToken) {
      showToast('Select a page and conversation first', 'warning');
      return;
    }
    M.ui.sending = true;
    const sendBtn = $('msngSendBtn');
    if (sendBtn) { sendBtn.disabled = true; sendBtn.innerHTML = '<i class="fa-solid fa-circle-notch fa-spin"></i>'; }

    // Remove old failed bubble if retrying
    if (retryTempId) {
      document.querySelector(`[data-temp-id="${retryTempId}"]`)?.remove();
      const idx = M.msgs.findIndex(m => m._tempId === retryTempId);
      if (idx !== -1) M.msgs.splice(idx, 1);
    }

    const tempId = retryTempId || ('temp_' + Date.now());
    const nowIso = new Date().toISOString();
    const tempMsg = { message: text, from_me: 1, created_at: nowIso, _tempId: tempId, _pending: true };

    M.msgs.push(tempMsg);
    M.renderedMsgIds.add(tempId);
    appendBubble(tempMsg);
    scrollToBottom(true, true); // Always scroll when sending — user just typed this message

    try {
      const sendPayload = {
        action: 'send_message', page_id: M.activePageId,
        psid: M.activePsid, message: text, page_token: M.activeToken,
      };
      const sendOpts = {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-CSRF-Token': await window.getCsrfToken?.() || ''
        },
        body: JSON.stringify(sendPayload)
      };
      const res = (typeof window.fetchJsonWithRetry === 'function')
        ? await window.fetchJsonWithRetry('/api/messenger', sendOpts, { attempts: 1, timeoutMs: 18000, backoffMs: 0 })
        : await post(sendPayload);

      if (res.error) throw new Error(res.error);

      // Confirm the bubble — swap temp state for real
      const bubble = document.querySelector(`[data-temp-id="${tempId}"]`);
      if (bubble) {
        bubble.removeAttribute('data-temp-id');
        bubble.classList.remove('pending');
        if (res.message_id) {
          bubble.dataset.msgId = res.message_id;
          if (nowIso) bubble.dataset.createdTs = new Date(nowIso).getTime();
          M.renderedMsgIds.add(res.message_id);
        }
        // Clock → single checkmark (sent)
        const tickEl = bubble.querySelector('.msng-tick');
        if (tickEl) {
          tickEl.className = 'msng-tick msng-tick--sent';
          tickEl.title     = 'Sent';
          tickEl.innerHTML = '<i class="fa-solid fa-check"></i>';
        }
      }
      const entry = M.msgs.find(m => m._tempId === tempId);
      if (entry) { entry.message_id = res.message_id; entry._pending = false; delete entry._tempId; }

      bumpConvAfterPageSend(M.activePsid, { lastMsg: text, lastMsgAt: nowIso });
      queueMarkConvRead(M.activePsid, { immediate: true });

    } catch (e) {
      const data = e?.data || {};
      showToast(data.error || 'Send failed', 'error', 5000);

      // Mark the specific bubble as failed — do NOT remove it
      const bubble = document.querySelector(`[data-temp-id="${tempId}"]`);
      if (bubble) {
        bubble.classList.add('failed');
        bubble.classList.remove('pending');
        bubble.querySelector('.msng-msg-meta')?.insertAdjacentHTML('beforeend',
          `<div class="msng-msg-failed">
             <i class="fa-solid fa-circle-exclamation"></i>
             <button onclick="msngRetry('${esc(tempId)}','${esc(text.replace(/'/g, "\\'"))}')">Retry</button>
           </div>`
        );
      }
      const entry = M.msgs.find(m => m._tempId === tempId);
      if (entry) entry._failed = true;

    } finally {
      M.ui.sending = false;
      if (sendBtn) { sendBtn.disabled = false; sendBtn.innerHTML = '<i class="fa-solid fa-paper-plane"></i>'; }
      updateLikeBtnVisibility();
    }
  }

  // ══════════════════════════════════════════════════════════
  // SEARCH
  // ══════════════════════════════════════════════════════════

  function mergeSearchConvs(apiConvs, localConvs) {
    const byPsid = new Map();
    (apiConvs || []).forEach(c => {
      if (c.fb_user_id) byPsid.set(String(c.fb_user_id), c);
    });
    (localConvs || []).forEach(c => {
      const psid = String(c.psid || '');
      if (!psid || byPsid.has(psid)) return;
      byPsid.set(psid, {
        fb_user_id: psid,
        user_name: c.name || 'User',
        user_picture: c.picture || '',
        snippet: c.lastMsg || '',
        last_msg_at: c.lastMsgAt,
        updated_at: c.lastMsgAt,
        page_id: c.page_id || M.activePageId
      });
    });
    return [...byPsid.values()];
  }

  function filterLocalConvs(q) {
    const ql = String(q || '').trim().toLowerCase();
    if (!ql) return [];
    const words = ql.split(/\s+/).filter(Boolean);
    return M.convs.filter(c => {
      const name = (c.name || 'User').toLowerCase();
      const psid = String(c.psid || '');
      const last = (c.lastMsg || '').toLowerCase();
      return words.every(w => name.includes(w) || psid.includes(w) || last.includes(w));
    });
  }

  function renderLocalSearchResults(q, list) {
    const listEl = $('msngConvList');
    if (!listEl) return;
    if (!list.length) {
      showSearchHint(`No names matching "<strong>${esc(q)}</strong>" on this page`);
      return;
    }
    let html = `<div class="msng-search-meta">${list.length} match(es) in loaded chats</div>`;
    list.forEach(c => { html += convItemHtml(c, M.activePsid); });
    listEl.innerHTML = html;
  }

  function showSearchHint(msg) {
    const listEl = $('msngConvList');
    if (!listEl) return;
    listEl.innerHTML = `<div class="msng-empty msng-search-hint">
      <i class="fa-solid fa-magnifying-glass"></i>
      <p>${esc(msg)}</p>
    </div>`;
  }

  function renderSearchResults(q, convMatches, msgMatches) {
    const listEl = $('msngConvList');
    if (!listEl) return;

    if (!convMatches.length && !msgMatches.length) {
      listEl.innerHTML = `<div class="msng-empty">
        <i class="fa-solid fa-magnifying-glass"></i>
        <p>No results for "<strong>${esc(q)}</strong>"</p>
        <p class="msng-search-sub">Try the full name, or wait a moment — we also search Facebook</p>
      </div>`;
      return;
    }

    const msgByPsid = {};
    msgMatches.forEach(m => {
      const psid = m.psid || m.user_id;
      if (!psid) return;
      if (!msgByPsid[psid]) msgByPsid[psid] = { name: m.user_name, pic: m.user_picture, msgs: [] };
      msgByPsid[psid].msgs.push(m);
    });

    const convPsids = new Set(convMatches.map(c => c.fb_user_id));
    let html = `<div class="msng-search-meta">${convMatches.length + Object.keys(msgByPsid).length} result(s)</div>`;

    convMatches.forEach(c => {
      html += searchRow(c.fb_user_id, c.user_name, c.user_picture,
        c.snippet || c.last_msg || '', c.last_msg_at || c.updated_at,
        c.page_id || M.activePageId, null);
    });

    Object.entries(msgByPsid).forEach(([psid, info]) => {
      if (convPsids.has(psid)) return;
      const preview = info.msgs.slice(0, 2).map(m => {
        const prefix = m.from_me == 1 ? 'You: ' : '';
        return `<span class="msng-search-match">${prefix}${highlight(m.message || '', q)}</span>`;
      }).join('<br>');
      html += searchRow(psid, info.name, info.pic, '', info.msgs[0]?.created_at, M.activePageId, preview);
    });

    listEl.innerHTML = html;
  }

  async function doSearch(q) {
    if (!M.activePageId) return;
    const listEl = $('msngConvList');
    if (!listEl) return;

    M.search.active = true;
    const localMatches = filterLocalConvs(q);

    const key = `${M.activePageId}:${q.toLowerCase()}`;
    const cached = M.search.cache.get(key);
    if (cached && Date.now() - cached.ts < SEARCH_CACHE_MS) {
      renderSearchResults(q, mergeSearchConvs(cached.conversations, localMatches), cached.messages);
      return;
    }

    if (M.search.abort) M.search.abort.abort();
    const controller = new AbortController();
    M.search.abort = controller;

    if (localMatches.length) {
      renderLocalSearchResults(q, localMatches);
    } else {
      listEl.innerHTML = `<div class="msng-empty">
        <i class="fa-solid fa-magnifying-glass fa-bounce"></i><p>Searching Facebook &amp; inbox…</p>
      </div>`;
    }

    try {
      const qs = new URLSearchParams({ action: 'search', page_id: M.activePageId, q }).toString();
      const r = await fetch('/api/messenger?' + qs, { credentials: 'same-origin', signal: controller.signal });
      if (M.search.query !== q) return;

      const data = r.ok ? await r.json() : { conversations: [], messages: [], error: 'Search failed' };
      const convMatches = data.conversations || [];
      const msgMatches  = data.messages || [];

      if (data.hint && !convMatches.length && !msgMatches.length) {
        if (localMatches.length) {
          renderLocalSearchResults(q, localMatches);
        } else {
          showSearchHint(data.hint);
        }
        return;
      }

      M.search.cache.set(key, { conversations: convMatches, messages: msgMatches, ts: Date.now() });
      if (M.search.cache.size > 40) M.search.cache.delete(M.search.cache.keys().next().value);

      if (!convMatches.length && !msgMatches.length && localMatches.length) {
        renderLocalSearchResults(q, localMatches);
        return;
      }

      renderSearchResults(q, mergeSearchConvs(convMatches, localMatches), msgMatches);
    } catch (e) {
      if (e.name === 'AbortError') return;
      if (localMatches.length) renderLocalSearchResults(q, localMatches);
      else showSearchHint('Search failed — try again');
    } finally {
      if (M.search.abort === controller) M.search.abort = null;
    }
  }

  function searchRow(psid, name, pic, preview, time, pageId, customPreview) {
    const short = preview.length > 42 ? preview.slice(0, 42) + '…' : preview;
    return `<div class="msng-conv-item"
                 data-psid="${esc(psid)}"
                 data-name="${esc(name || 'User')}"
                 data-pic="${esc(pic || '')}"
                 data-page="${esc(pageId)}">
      <div class="msng-ci-avatar">${avatarHtml(pic, name, 'msng-ci-avatar-img')}</div>
      <div class="msng-ci-body">
        <div class="msng-ci-row1">
          <span class="msng-ci-name">${esc(name || 'User')}</span>
          <span class="msng-ci-time">${esc(fmtTime(time))}</span>
        </div>
        <div class="msng-ci-last">${customPreview || esc(short)}</div>
      </div>
    </div>`;
  }

  function highlight(text, q) {
    const safe  = esc(text);
    const safeQ = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return safe.replace(new RegExp('(' + safeQ + ')', 'gi'), '<mark>$1</mark>');
  }

  function clearSyncPoll() {
    if (M._syncPollTimer) {
      clearTimeout(M._syncPollTimer);
      M._syncPollTimer = null;
    }
    M._syncPollAttempts = 0;
  }

  /** Retry list while server sync runs — avoids infinite "Loading conversations…" */
  function startSyncPoll(pageId) {
    clearSyncPoll();
    if (!pageId) return;
    const tick = () => {
      M._syncPollAttempts += 1;
      if (!M.ui.syncing || M.convs.length || M._syncPollAttempts > 25) {
        if (M.ui.syncing && !M.convs.length) M.ui.syncing = false;
        clearSyncPoll();
        renderConvs();
        return;
      }
      loadConvs(pageId, false, { background: true, syncOnly: true })
        .finally(() => {
          if (M.ui.syncing && !M.convs.length && M._syncPollAttempts <= 25) {
            M._syncPollTimer = setTimeout(tick, 8000);
          }
        });
    };
    M._syncPollTimer = setTimeout(tick, 8000);
  }

  // ══════════════════════════════════════════════════════════
  // SYNC BANNER & TOAST
  // ══════════════════════════════════════════════════════════

  function showSyncBanner(msg, autoHide = false) {
    let b = $('msngSyncBanner');
    if (!b) {
      b = document.createElement('div');
      b.id = 'msngSyncBanner'; b.className = 'msng-sync-banner';
      const col = $('msngConvsCol');
      if (col) col.insertBefore(b, col.querySelector('.msng-search'));
    }
    b.innerHTML = `<i class="fa-solid fa-rotate fa-spin"></i> ${msg}`;
    b.style.display = 'flex';
    if (!M.convs.length) renderConvs(); // switch list to syncing state
    if (autoHide) setTimeout(() => { b.style.display = 'none'; }, 3000);
  }

  function hideSyncBanner() {
    const b = $('msngSyncBanner');
    if (b) b.style.display = 'none';
  }

  // ══════════════════════════════════════════════════════════
  // TOAST QUEUE — sequential toasts, no overlapping/flickering.
  // If a toast is showing, new ones queue up and play after.
  // ══════════════════════════════════════════════════════════
  const _toastQ   = [];
  let _toastBusy  = false;
  const _TOAST_ICONS = {
    error: 'fa-circle-exclamation',
    success: 'fa-circle-check',
    warning: 'fa-triangle-exclamation',
    info: 'fa-circle-info',
    message: 'fa-brands fa-facebook-messenger'
  };

  function _dismissToastEl(t) {
    if (!t) return;
    clearTimeout(t._hideTimer);
    t.classList.remove('show');
    setTimeout(_drainToastQ, 320);
  }

  function _buildToastHtml(msg, type, opts = {}) {
    const isMessage = !!(opts.message || type === 'message' || /^new message/i.test(String(msg)));
    if (isMessage) {
      let sender = opts.sender || '';
      let page   = opts.pageName || '';
      const fromM = String(msg).match(/^New message from\s+(.+)$/i);
      const onM   = String(msg).match(/^New message\s+on\s+(.+)$/i);
      if (fromM) sender = fromM[1];
      if (onM) page = onM[1];
      const senderLabel = esc(sender || 'Customer');
      const pageLabel   = page ? esc(page) : '';
      const preview     = opts.preview ? esc(String(opts.preview).slice(0, 120)) : '';
      return `<div class="msng-toast-inner msng-toast-inner--message">
        <div class="msng-toast-icon-wrap msng-toast-icon-wrap--message" aria-hidden="true">
          <i class="fa-brands fa-facebook-messenger"></i>
        </div>
        <div class="msng-toast-copy">
          <div class="msng-toast-label">New message</div>
          <div class="msng-toast-headline">${senderLabel}</div>
          ${pageLabel ? `<div class="msng-toast-meta"><i class="fa-solid fa-store"></i> ${pageLabel}</div>` : ''}
          ${preview ? `<div class="msng-toast-preview">${preview}</div>` : ''}
        </div>
        <button type="button" class="msng-toast-close" aria-label="Dismiss"><i class="fa-solid fa-xmark"></i></button>
      </div>`;
    }
    const icon = _TOAST_ICONS[type] || _TOAST_ICONS.info;
    return `<div class="msng-toast-inner">
      <div class="msng-toast-icon-wrap" aria-hidden="true"><i class="fa-solid ${icon}"></i></div>
      <div class="msng-toast-copy"><div class="msng-toast-body">${esc(msg)}</div></div>
    </div>`;
  }

  function _drainToastQ() {
    if (!_toastQ.length) { _toastBusy = false; return; }
    _toastBusy = true;
    const { msg, type, duration, opts } = _toastQ.shift();
    const t = $('msngToast');
    if (!t) { _toastBusy = false; return; }
    const toastType = (opts && opts.message) || type === 'message' ? 'message' : type;
    t.innerHTML = _buildToastHtml(msg, toastType, opts || {});
    t.className = `msng-toast msng-toast--${toastType} show`;
    const closeBtn = t.querySelector('.msng-toast-close');
    if (closeBtn) {
      closeBtn.onclick = (e) => { e.stopPropagation(); _dismissToastEl(t); };
    }
    t.onclick = () => {
      const pid = opts?.pageId;
      const sid = opts?.psid;
      const senderName = opts?.sender || 'Customer';
      _dismissToastEl(t);
      if (pid && sid) {
        if (String(pid) !== String(M.activePageId)) {
          window.msngSelectPage(pid);
          setTimeout(() => window.msngOpenConv(sid, senderName, '', pid), 400);
        } else {
          window.msngOpenConv(sid, senderName, '', pid);
        }
      }
    };
    clearTimeout(t._hideTimer);
    t._hideTimer = setTimeout(() => _dismissToastEl(t), duration);
  }

  // type: 'info' | 'success' | 'error' | 'warning' | 'message'
  function showToast(msg, type = 'info', duration = 3500, opts = null) {
    _toastQ.push({ msg, type, duration, opts: opts || {} });
    if (!_toastBusy) _drainToastQ();
  }

  function showMessageToast({ sender, pageName, preview, pageId, psid } = {}) {
    showToast('', 'message', 5500, {
      message: true,
      sender: sender || 'Customer',
      pageName: pageName || '',
      preview: preview || '',
      pageId: pageId || '',
      psid: psid || ''
    });
  }

  function showConnBanner(msg) {
    let b = $('msngConnBanner');
    if (!b) {
      b = document.createElement('div');
      b.id = 'msngConnBanner';
      b.className = 'msng-conn-banner';
      const toolbar = document.querySelector('.msng-toolbar');
      if (toolbar) toolbar.appendChild(b);
    }
    b.innerHTML = `<i class="fa-solid fa-wifi" style="opacity:.6"></i> ${esc(msg)}`;
    b.style.display = 'flex';
    setLivePillState(false);
  }

  function hideConnBanner() {
    const b = $('msngConnBanner');
    if (b) b.style.display = 'none';
    if (!M._offline) setLivePillState(true);
  }

  // ══════════════════════════════════════════════════════════
  // EVENT DELEGATION
  //
  // One listener on the conv list handles all conv clicks.
  // All items use data-psid/data-name/etc. instead of
  // inline onclick="msngOpenConv(...)". Reasons:
  //   - No repeated string escaping in HTML generation
  //   - Works for dynamically inserted nodes (search results)
  //   - Easy to unit test (dispatch synthetic click event)
  //   - One listener to remove when messenger view unmounts
  // ══════════════════════════════════════════════════════════

  let _convListListener = null;

  function bindConvListDelegate() {
    const listEl = $('msngConvList');
    if (!listEl) return;

    // Click handler (delegated)
    if (_convListListener) listEl.removeEventListener('click', _convListListener);
    _convListListener = e => {
      const item = e.target.closest('[data-psid]');
      if (item) openConv(item.dataset.psid, item.dataset.name, item.dataset.pic, item.dataset.page);
    };
    listEl.addEventListener('click', _convListListener);

    // Infinite scroll handler
    listEl.onscroll = () => {
      if (M.search.active || M.ui.loadingConvs || !M.convHasMore) return;
      const nearBottom = listEl.scrollHeight - listEl.scrollTop - listEl.clientHeight < 100;
      if (nearBottom) loadConvs(M.activePageId, true);
    };
  }

  // ══════════════════════════════════════════════════════════
  // DATA LOADING
  // ══════════════════════════════════════════════════════════

  function _showConvLoadingMore() {
    const listEl = $('msngConvList');
    if (!listEl || listEl.querySelector('#msngConvLoadMore')) return;
    const el = document.createElement('div');
    el.id = 'msngConvLoadMore';
    el.style.cssText = 'text-align:center;padding:12px;color:var(--text-muted);font-size:12px';
    el.innerHTML = '<i class="fa-solid fa-rotate fa-spin"></i> Loading…';
    listEl.appendChild(el);
  }
  function _hideConvLoadingMore() {
    $('msngConvLoadMore')?.remove();
  }

  function _applyConvRows(rows, isMore) {
    if (isMore) {
      M.convs = [...M.convs, ...rows];
      rows.forEach(c => {
        const id = String(c.psid);
        if (!M._convOrder.includes(id)) M._convOrder.push(id);
      });
    } else {
      M.convs = rows;
      setConvOrderFromList(rows);
    }
    rebuildConvIndex();
    renderConvs();
  }

  function _mapConvRows(conversations) {
    return (conversations || []).map(c => ({
      id:         c.id,
      psid:       c.fb_user_id,
      name:       c.user_name    || 'User',
      picture:    c.user_picture || null,
      lastMsg:    c.last_msg     || c.snippet || '',
      lastFromMe: c.last_from_me == 1,
      lastMsgAt:  c.last_msg_at  || c.updated_at,
      unread:     resolveConvUnread(c.fb_user_id, c.is_unread, c.updated_at || c.updated_time, c.last_from_me == 1),
      page_id:    c.page_id,
    }));
  }

  async function loadConvs(pageId, isMore = false, opts = {}) {
    const pageKey = String(pageId);
    const loadSeq = opts.loadSeq;

    if (M.ui.loadingConvs && !opts.background && !isMore
        && pageKey === String(M._loadingConvsFor)) {
      return;
    }
    if (isMore && !M.convHasMore) return;

    if (!isMore && !opts.background) {
      M.convOffset = 0;
      M.convHasMore = true;
      if (!opts.fresh && !opts.skipCacheRestore) {
        const hit = _convListCache.get(pageId);
        if (hit && Date.now() - hit.ts < CONV_LIST_CACHE_MS && hit.convs.length) {
          M.convs = hit.convs.map(c => ({ ...c }));
          M._convOrder = hit.order?.length
            ? hit.order.slice()
            : hit.convs.map(c => String(c.psid));
          M.convOffset = hit.offset;
          M.convHasMore = hit.hasMore;
          rebuildConvIndex();
          renderConvs({ immediate: true });
          loadConvs(pageId, false, { background: true, skipCacheRestore: true, loadSeq });
          return;
        }
      }
      if (!opts.silentRefresh) showConvSkeleton();
    } else if (isMore) {
      _showConvLoadingMore();
    }
    M._loadingConvsFor = pageKey;
    M.ui.loadingConvs = true;

    try {
      const limit = CONV_PAGE_SIZE;
      const loadParams = { page_id: pageId, limit, offset: M.convOffset };
      if (opts.fresh) loadParams.refresh = 1;
      const data = await get('load_conversations', loadParams);
      if (loadSeq && loadSeq !== M._convLoadSeq) return;
      if (pageKey !== String(M.activePageId)) return;
      if (data.error) throw new Error(data.error);

      if (data.message_retention_days) M.retentionDays = data.message_retention_days;
      if (data.error && !data.conversations?.length) {
        M.ui.syncing = false;
        clearSyncPoll();
        throw new Error(data.error);
      }

      const newConvs = _mapConvRows(data.conversations);
      M.ui.syncing = !!data.syncing && !newConvs.length;

      if (isMore) {
        M.convs = [...M.convs, ...newConvs];
        newConvs.forEach(c => {
          const id = String(c.psid);
          if (!M._convOrder.includes(id)) M._convOrder.push(id);
        });
        invalidateConvListRender();
      } else if (opts.background && M.convs.length) {
        const orderBefore = M._convOrder.join(',');
        const merged = mergeConvListFromServer(newConvs);
        let reordered = applyMetaConvOrder(newConvs);
        if (!reordered) reordered = resortConvsByMeta();
        const orderAfter = M._convOrder.join(',');
        if (merged || orderBefore !== orderAfter) {
          renderConvs({ immediate: orderBefore !== orderAfter });
        }
        if (opts.syncOnly) {
          rebuildConvIndex();
          if (newConvs.length) {
            M.ui.syncing = false;
            clearSyncPoll();
          } else if (M.ui.syncing) {
            startSyncPoll(pageId);
          }
          return;
        }
      } else {
        M.convs = newConvs;
        setConvOrderFromList(newConvs);
        invalidateConvListRender();
      }

      M.convOffset += newConvs.length;
      if (data.has_more === false || newConvs.length < limit) M.convHasMore = false;

      if (!isMore) {
        _convListCache.set(pageId, {
          convs: M.convs.map(c => ({ ...c })),
          order: M._convOrder.slice(),
          offset: M.convOffset,
          hasMore: M.convHasMore,
          ts: Date.now()
        });
      }

      rebuildConvIndex();
      if (newConvs.length) {
        M.ui.syncing = false;
        clearSyncPoll();
      } else if (M.ui.syncing) {
        startSyncPoll(pageId);
      } else {
        clearSyncPoll();
      }
      const hasSkeleton = !!$('msngConvList')?.querySelector('.msng-skeleton');
      if (!opts.background) {
        renderConvs({ immediate: true });
      } else if (hasSkeleton) {
        renderConvs();
      }
      syncPageBadge(M.activePageId);
      schedulePageUnreadRefresh(400);
    } catch (e) {
      console.error('[Messenger] loadConvs:', e);
      M.ui.syncing = false;
      clearSyncPoll();
      if (!isMore) {
        const listEl = $('msngConvList');
        if (listEl) listEl.innerHTML = `<div class="msng-empty">
          <i class="fa-solid fa-triangle-exclamation" style="color:#f87171;font-size:24px;margin-bottom:8px"></i>
          <p style="color:#f87171;font-size:13px;margin:0 0 12px">Could not load conversations</p>
          <button onclick="window.msngRefresh()" class="msng-retry-btn">
            <i class="fa-solid fa-rotate-right"></i> Retry
          </button>
        </div>`;
        showToast('Failed to load chats', 'error');
      }
      // isMore failure: silently allow retry on next scroll
      if (isMore) M.convHasMore = true;
    } finally {
      if (!loadSeq || loadSeq === M._convLoadSeq) {
        if (pageKey === String(M._loadingConvsFor)) {
          M.ui.loadingConvs = false;
          M._loadingConvsFor = null;
        }
      }
      _hideConvLoadingMore();
    }
  }

  async function loadMessages(before = null, opts = {}) {
    if (!M.activePageId || !M.activePsid) return;
    const silent = !!opts.silent;
    if (silent && M.ui.sending) return;
    // Snapshot the psid at call time — used to detect stale responses
    const forPsid = M.activePsid;
    const msgsEl  = $('msngMsgs');

    // Only show skeleton when there are no cached messages already displayed
    if (!before && msgsEl && !M.msgs.length && !silent) {
      msgsEl.innerHTML = `<div class="msng-empty" style="margin-top:60px">
        <div class="msng-sk-circle" style="margin:0 auto 12px"></div>
        <p style="opacity:.5">Loading messages…</p>
      </div>`;
    }

    // Abort any in-flight message fetch before starting a new one
    if (M._msgAbort) { M._msgAbort.abort(); }
    const controller = new AbortController();
    M._msgAbort = controller;
    const isTimeout = { v: false };

    // 12-second hard timeout — skeleton will not spin forever
    const timeout = setTimeout(() => { isTimeout.v = true; controller.abort(); }, 12000);

    try {
      const qs  = new URLSearchParams({ page_id: M.activePageId, psid: forPsid, limit: 50, before: before || '' }).toString();
      const url = '/api/messenger?action=load_messages&' + qs;
      const r   = await fetch(url, { credentials: 'same-origin', signal: controller.signal });

      // Stale check: user switched conversations while this request was in flight
      if (M.activePsid !== forPsid) return;

      if (r.status === 401) throw Object.assign(new Error('Session expired — please reload the page'), { _userFacing: true });
      if (!r.ok) throw new Error('Server error (' + r.status + ')');

      const payload = unwrapMessagesResponse(await r.json());
      if (M.activePsid !== forPsid) return; // second stale check after JSON parse

      if (payload.error) {
        if (!before && msgsEl) _showMsgError(msgsEl, payload.error);
        return;
      }

        const fresh = _filterMsgsByRetention((payload.messages || []).map(normalizeMsg));
      applyMsgStatusFromMessages(fresh);
      updateHasOlderMessages(fresh, payload, before);
      if (before) {
        M.msgs = mergeOlderMessages(fresh, M.msgs);
        sortMsgsInPlace();
        renderMessages('prepend');
        scheduleContactMediaRefresh();
      } else {
        const prevMsgs = M.msgs.slice();
        const pending   = M.msgs.filter(m => m._pending || m._failed);
        const toKeep    = reconcilePendingWithFresh(fresh, pending);
        M.msgs = _filterMsgsByRetention([...fresh, ...toKeep]);
        sortMsgsInPlace();
        const plan = planMessagesDomUpdate(prevMsgs, M.msgs);
        if (plan === 'noop') {
          /* DOM unchanged — no flicker */
        } else if (plan === 'append') {
          appendNewMessagesFromIndex(prevMsgs.length, { animate: false });
          if (isMsgsNearBottom(msgsEl)) scrollToBottom(false);
        } else {
          M.renderedMsgIds = new Set();
          renderMessages('replace', { scroll: silent ? 'preserve' : 'bottom' });
        }
      }
      if (M.msgs.length > 0) M.oldestMsgTime = M.msgs[0].created_at;
      _cacheSave(forPsid);
      if (!before) scheduleContactMediaRefresh();
      if (!before && syncOpenConvSidebarFromMessages()) renderConvs();

    } catch (e) {
      if (e.name === 'AbortError') {
        // Only show timeout error — not when aborted by a conversation switch
        if (isTimeout.v && M.activePsid === forPsid && !before && msgsEl) {
          _showMsgError(msgsEl, 'Request timed out. Check your connection.');
        }
        return;
      }
      console.error('[Messenger] loadMessages:', e);
      if (M.activePsid === forPsid && !before && msgsEl) {
        _showMsgError(msgsEl, e._userFacing ? e.message : 'Failed to load messages. Try again.');
      }
    } finally {
      clearTimeout(timeout);
      if (M._msgAbort === controller) M._msgAbort = null;
    }
  }

  function _showMsgError(msgsEl, msg) {
    msgsEl.innerHTML = `<div class="msng-empty" style="margin-top:60px">
      <i class="fa-solid fa-triangle-exclamation" style="color:#f87171;font-size:28px;margin-bottom:10px"></i>
      <p style="color:#f87171;margin:0 0 12px;font-size:13px;max-width:260px;text-align:center">${esc(msg)}</p>
      <button onclick="window.msngRefresh()" class="msng-retry-btn">
        <i class="fa-solid fa-rotate-right"></i> Try Again
      </button>
    </div>`;
  }

  // ── Per-conversation message cache (max 30 conversations) ───────────────────
  // Why: every openConv() previously cleared M.msgs and re-fetched from the
  // server. Switching back to a conversation showed a loading skeleton every
  // time. Cache stores { msgs, oldestMsgTime } keyed by psid. On return we
  // render from cache instantly, then refresh silently in the background.
  const _msgCache = new Map(); // psid → { msgs, oldestMsgTime }
  const MSG_CACHE_MAX = 30;

  function _cacheSave(psid) {
    if (!psid || !M.msgs.length) return;
    const stable = M.msgs.filter(m => !m._pending && !m._failed);
    if (!stable.length) return;
    _msgCache.set(psid, {
      msgs: _filterMsgsByRetention(stable),
      oldestMsgTime: M.oldestMsgTime,
      hasOlderMessages: M.hasOlderMessages
    });
    // Evict oldest entry when over limit
    if (_msgCache.size > MSG_CACHE_MAX) {
      _msgCache.delete(_msgCache.keys().next().value);
    }
  }

  function _cacheLoad(psid) {
    return _msgCache.get(psid) || null;
  }

  async function openConv(psid, name, picture, pageId) {
    // Save current conversation to cache before switching
    if (M.activePsid && M.activePsid !== psid) _cacheSave(M.activePsid);

    msngClearPendingImage();
    M.activePsid     = psid;
    M.activeConvName = name;
    M.activeConvPic  = picture;
    M.msgStatus      = { delivered: 0, read: 0 };
    M.hasOlderMessages = false;
    M.contactMedia = null;
    M._contactMediaPsid = null;
    if (pageId) {
      M.activePageId = pageId;
      M.activeToken  = (M.pages.find(p => p.id === pageId) || {}).access_token || M.activeToken;
    }

    lockConvRead(psid);
    const conv = getConv(pageId || M.activePageId, psid);
    if (conv) conv.unread = 0;
    invalidateConvListRender();
    renderConvs({ immediate: true });

    if (_socket?.connected) {
      if (M._joinedThread) _socket.emit('leave_thread', M._joinedThread);
      M._joinedThread = conv?.id || null;
      if (M._joinedThread) _socket.emit('join_thread', M._joinedThread);
      if (M._joinedThread && M.activePageId) {
        _socket.emit('viewing_thread', {
          pageId: M.activePageId,
          threadId: M._joinedThread,
          psid: M.activePsid,
          agentName: M._agentName || 'Agent'
        });
      }
    }

    // Hide customer typing when switching conversations
    const typingEl = $('msngCustomerTyping');
    if (typingEl) { clearTimeout(typingEl._hideTimer); typingEl.classList.remove('visible'); }

    showChatWindow(name, picture);

    const cached = _cacheLoad(psid);
    if (cached && cached.msgs.length) {
      // Restore from cache instantly — no skeleton, no wait
      M.msgs           = _filterMsgsByRetention(cached.msgs);
      M.renderedMsgIds = new Set();
      M.oldestMsgTime  = cached.oldestMsgTime;
      M.hasOlderMessages = cached.hasOlderMessages ?? (cached.msgs.length >= M.msgPageSize);
      renderMessages('replace', { scroll: 'force' });
      // Silent background refresh — patch DOM only if messages changed
      loadMessages(null, { silent: true }).catch(() => {});
    } else {
      M.msgs = []; M.renderedMsgIds = new Set(); M.oldestMsgTime = null;
      await loadMessages();
    }

    queueMarkConvRead(psid, { immediate: true });

    $('msngMsgTextarea')?.focus();
    updateLikeBtnVisibility();
    if (window.innerWidth <= 640) $('msngConvsCol')?.classList.add('slide-out');
  }

  // ══════════════════════════════════════════════════════════
  // PUBLIC API
  // Only expose what external code (HTML, web_ui.js) needs.
  // ══════════════════════════════════════════════════════════

  // msngInit and msngSelectPage are defined below with pages column + Socket.io

  window.loadMessengerConversations = function () { window.msngInit(0); };

  window.msngOpenConv = function (psid, name, picture, pageId) { openConv(psid, name, picture, pageId); };
  window.msngRetry    = function (tempId, text) { doSend(text, tempId); };

  window.msngToggleContact = function (force) {
    const panel = $('msngContactPanel');
    if (!panel || !M.activePsid) return;
    const next = typeof force === 'boolean' ? force : !panel.classList.contains('is-open');
    panel.classList.toggle('is-open', next);
    panel.setAttribute('aria-hidden', next ? 'false' : 'true');
    const btn = $('msngContactToggleBtn');
    if (btn) btn.setAttribute('aria-expanded', next ? 'true' : 'false');
    if (next) {
      updateContactPanel();
      loadContactMedia();
    }
  };

  window.msngSaveContactNote = function () {
    const key = contactNoteKey();
    const note = $('msngContactNote');
    if (!key || !note) return;
    const text = note.value.trim();
    if (text) localStorage.setItem(key, text);
    else localStorage.removeItem(key);
    showToast('Note saved', 'success', 1600);
  };

  window.msngSend = async function () {
    const ta = $('msngMsgTextarea');
    const text = ta ? ta.value.trim() : '';
    const pending = M.pendingImage;

    if (!pending && !text) return;

    if (pending) {
      const file = pending.file;
      msngClearPendingImage();
      await msngSendImageFile(file);
    }

    if (text && ta) {
      ta.value = '';
      ta.style.height = 'auto';
      window.msngUpdateCharCount(ta);
      updateLikeBtnVisibility();
      doSend(text);
    }
  };

  window.msngKeydown = function (e) {
    const panel = $('msngCannedPanel');
    const panelOpen = panel && panel.style.display !== 'none';

    if (e.key === 'Escape') {
      if (panelOpen) { msngHideCannedPanel(); e.preventDefault(); return; }
      msngHideSavedPreview();
      return;
    }

    if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && panelOpen) {
      e.preventDefault();
      const items = panel.querySelectorAll('.msng-canned-row');
      if (!items.length) return;
      const active = panel.querySelector('.msng-canned-row.focused');
      let idx = Array.from(items).indexOf(active);
      if (active) active.classList.remove('focused');
      idx = e.key === 'ArrowDown' ? Math.min(idx + 1, items.length - 1) : Math.max(idx - 1, 0);
      items[idx].classList.add('focused');
      items[idx].scrollIntoView({ block: 'nearest' });
      return;
    }

    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (panelOpen) {
        const focused = panel.querySelector('.msng-canned-row.focused');
        if (focused) { focused.click(); return; }
      }
      const srp = $('msngSavedReplyPreview');
      if (srp && srp.style.display !== 'none') {
        msngUseSavedPreview();
        return;
      }
      window.msngSend();
    }
  };

  // Typing emit state — throttled: start fires once, stop fires after 3s idle
  let _typingEmitTimer = null;
  let _typingActive    = false;

  function updateLikeBtnVisibility() {
    const likeBtn = $('msngLikeBtn');
    const ta = $('msngMsgTextarea');
    if (!likeBtn || !ta) return;
    const hasText = !!ta.value.trim();
    const hasImage = !!M.pendingImage;
    likeBtn.style.display = (hasText || hasImage) ? 'none' : 'flex';
  }

  window.msngTextareaInput = function (ta) {
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, 120) + 'px';
    updateLikeBtnVisibility();

    const val = ta.value;
    if (val === '/' || (val.startsWith('/') && !val.includes(' '))) {
      msngShowCannedPanel(val.slice(1));
      msngHideSavedPreview();
    } else {
      msngHideCannedPanel();
      const q = val.trim().toLowerCase();
      if (q.length >= 1) {
        const match = M.cannedReplies.find(r => r.title.toLowerCase().startsWith(q));
        if (match) msngShowSavedPreview(match);
        else msngHideSavedPreview();
      } else {
        msngHideSavedPreview();
      }
    }

    // Emit typing_start to socket once per burst
    if (_socket?.connected && M._joinedThread && !_typingActive) {
      _typingActive = true;
      _socket.emit('typing_start', { threadId: M._joinedThread, agentName: 'Agent' });
    }
    clearTimeout(_typingEmitTimer);
    _typingEmitTimer = setTimeout(() => {
      _typingActive = false;
      if (_socket?.connected && M._joinedThread) {
        _socket.emit('typing_stop', { threadId: M._joinedThread });
      }
    }, 3000);
  };

  window.msngUpdateCharCount = function (ta) {
    const el  = $('msngCharCount');
    if (!el) return;
    const len = ta.value.length;
    if (len === 0) { el.textContent = ''; el.className = 'msng-char-count'; return; }
    el.textContent = len + '/2000';
    el.className   = 'msng-char-count' + (len > 1800 ? ' msng-char-count--warn' : '') + (len >= 2000 ? ' msng-char-count--over' : '');
    if (len >= 2000) ta.value = ta.value.slice(0, 2000);
  };

  async function apiCanned(method, url, body) {
    const headers = { 'Content-Type': 'application/json' };
    const csrf = typeof window.getCsrfToken === 'function' ? await window.getCsrfToken() : '';
    if (csrf) headers['X-CSRF-Token'] = csrf;
    const opts = { method, headers, credentials: 'same-origin' };
    if (body != null) opts.body = JSON.stringify(body);
    const r = await fetch(url, opts);
    if (!r.ok) {
      try { return await r.json(); } catch { return { error: 'Request failed (' + r.status + ')' }; }
    }
    return r.json();
  }

  async function loadCannedReplies() {
    try {
      const data = await apiCanned('GET', '/api/canned-replies');
      M.cannedReplies = data?.replies || [];
    } catch {
      M.cannedReplies = [];
    }
    renderCannedListPanel($('msngCannedSearch')?.value || '');
  }

  function renderCannedListPanel(query) {
    const list = $('msngCannedList');
    if (!list) return;
    const q = String(query || '').trim().toLowerCase();
    const filtered = q
      ? M.cannedReplies.filter(r =>
          r.title.toLowerCase().includes(q) || String(r.body || '').toLowerCase().includes(q))
      : M.cannedReplies;

    if (!filtered.length) {
      list.innerHTML = `<div class="msng-canned-empty">${q
        ? 'No results for “' + esc(q) + '”'
        : 'No saved replies yet.<br><button type="button" class="msng-canned-add" style="margin-top:10px" onclick="msngOpenCannedModal()"><i class="fa-solid fa-plus"></i> Create one</button>'}</div>`;
      return;
    }

    list.innerHTML = filtered.map(r => `
      <div class="msng-canned-row" data-id="${r.id}" onclick="msngInsertCannedById(${r.id})">
        <div class="msng-canned-row-icon"><i class="fa-solid fa-bookmark"></i></div>
        <div class="msng-canned-row-body">
          <div class="msng-canned-row-title"><code>/${esc(r.title)}</code></div>
          <div class="msng-canned-row-text">${esc(r.body)}</div>
        </div>
        <div class="msng-canned-row-actions">
          <button type="button" class="msng-canned-more" title="More"
            onclick="event.stopPropagation();msngToggleCannedMenu(${r.id})">···</button>
          <div class="msng-canned-dd" id="msngCannedDd_${r.id}" style="display:none">
            <button type="button" onclick="event.stopPropagation();msngEditCanned(${r.id})">Edit</button>
            <button type="button" class="danger" onclick="event.stopPropagation();msngDeleteCanned(${r.id})">Delete</button>
          </div>
        </div>
      </div>`).join('');
  }

  function msngInsertCannedText(body) {
    const ta = $('msngMsgTextarea');
    if (!ta) return;
    ta.value = String(body || '');
    ta.focus();
    window.msngTextareaInput(ta);
    window.msngUpdateCharCount(ta);
    msngHideCannedPanel();
    msngHideSavedPreview();
  }

  window.msngInsertCannedById = function (id) {
    const row = M.cannedReplies.find(r => r.id === id);
    if (row) msngInsertCannedText(row.body);
  };

  window.msngShowCannedPanel = function (query) {
    const panel = $('msngCannedPanel');
    const btn   = $('msngCannedBtn');
    if (!panel) return;
    panel.style.display = 'flex';
    btn?.classList.add('active');
    const search = $('msngCannedSearch');
    if (search && typeof query === 'string') {
      search.value = query;
    }
    renderCannedListPanel(search?.value || query || '');
    setTimeout(() => search?.focus(), 40);
  };

  window.msngHideCannedPanel = function () {
    const panel = $('msngCannedPanel');
    const btn   = $('msngCannedBtn');
    if (panel) panel.style.display = 'none';
    btn?.classList.remove('active');
    document.querySelectorAll('.msng-canned-dd').forEach(d => { d.style.display = 'none'; });
  };

  window.msngToggleCanned = function () {
    const panel = $('msngCannedPanel');
    if (!panel) return;
    if (panel.style.display !== 'none') {
      msngHideCannedPanel();
    } else {
      loadCannedReplies().then(() => msngShowCannedPanel(''));
    }
  };

  window.msngCannedSearch = function (q) {
    renderCannedListPanel(q);
  };

  window.msngToggleCannedMenu = function (id) {
    document.querySelectorAll('.msng-canned-dd').forEach(d => {
      if (d.id !== 'msngCannedDd_' + id) d.style.display = 'none';
    });
    const dd = $('msngCannedDd_' + id);
    if (dd) dd.style.display = dd.style.display === 'none' ? 'block' : 'none';
  };

  window.msngShowSavedPreview = function (reply) {
    const bar = $('msngSavedReplyPreview');
    const bodyEl = $('msngSrpBody');
    if (!bar || !bodyEl) return;
    M._srpBody = reply.body || '';
    bodyEl.textContent = (reply.title ? '/' + reply.title + ' · ' : '') + (reply.body || '');
    bar.style.display = 'flex';
  };

  window.msngHideSavedPreview = function () {
    const bar = $('msngSavedReplyPreview');
    if (bar) bar.style.display = 'none';
    M._srpBody = '';
  };

  window.msngUseSavedPreview = function () {
    if (M._srpBody) msngInsertCannedText(M._srpBody);
  };

  window.msngOpenCannedModal = function (editId) {
    const modal = $('msngCannedModal');
    if (!modal) return;
    msngHideCannedPanel();
    const titleEl = $('msngCrTitle');
    const bodyEl  = $('msngCrBody');
    const saveBtn = $('msngCrSaveBtn');
    const hdr     = $('msngCannedModalTitle');

    if (editId) {
      const row = M.cannedReplies.find(r => r.id === editId);
      if (!row) return;
      M._editingCannedId = editId;
      if (titleEl) titleEl.value = row.title;
      if (bodyEl) bodyEl.value = row.body;
      if (saveBtn) saveBtn.textContent = 'Update reply';
      if (hdr) hdr.textContent = 'Edit saved reply';
    } else {
      M._editingCannedId = null;
      if (titleEl) titleEl.value = '';
      if (bodyEl) bodyEl.value = '';
      if (saveBtn) saveBtn.textContent = 'Save reply';
      if (hdr) hdr.textContent = 'Save reply';
    }

    modal.style.display = 'flex';
    modal.setAttribute('aria-hidden', 'false');
    setTimeout(() => titleEl?.focus(), 50);
  };

  window.msngCloseCannedModal = function () {
    const modal = $('msngCannedModal');
    if (modal) {
      modal.style.display = 'none';
      modal.setAttribute('aria-hidden', 'true');
    }
    M._editingCannedId = null;
  };

  window.msngEditCanned = function (id) {
    document.querySelectorAll('.msng-canned-dd').forEach(d => { d.style.display = 'none'; });
    msngOpenCannedModal(id);
  };

  window.msngSaveCanned = async function () {
    const title = ($('msngCrTitle')?.value || '').trim();
    const body  = ($('msngCrBody')?.value || '').trim();
    if (!title || !body) {
      showToast('Title and message are required', 'warning');
      return;
    }

    try {
      let data;
      if (M._editingCannedId) {
        data = await apiCanned('PUT', '/api/canned-replies/' + M._editingCannedId, { title, body });
        if (data?.reply) {
          const i = M.cannedReplies.findIndex(r => r.id === M._editingCannedId);
          if (i >= 0) M.cannedReplies[i] = data.reply;
        }
      } else {
        data = await apiCanned('POST', '/api/canned-replies', { title, body });
        if (data?.reply) M.cannedReplies.push(data.reply);
      }
      if (data?.error) throw new Error(data.error);

      const wasEdit = !!M._editingCannedId;
      M.cannedReplies.sort((a, b) => String(a.title).localeCompare(String(b.title)));
      msngCloseCannedModal();
      renderCannedListPanel($('msngCannedSearch')?.value || '');
      showToast(wasEdit ? 'Reply updated' : 'Reply saved', 'success');
    } catch (e) {
      showToast('Failed to save: ' + e.message, 'error');
    }
  };

  window.msngDeleteCanned = async function (id) {
    document.querySelectorAll('.msng-canned-dd').forEach(d => { d.style.display = 'none'; });
    if (!confirm('Delete this saved reply?')) return;
    try {
      const data = await apiCanned('DELETE', '/api/canned-replies/' + id);
      if (data?.error) throw new Error(data.error);
      M.cannedReplies = M.cannedReplies.filter(r => r.id !== id);
      renderCannedListPanel($('msngCannedSearch')?.value || '');
      showToast('Deleted', 'success');
    } catch (e) {
      showToast('Delete failed: ' + e.message, 'error');
    }
  };

  window.msngUseCanned = function (el) {
    if (el?.dataset?.body != null) {
      msngInsertCannedText(el.dataset.body);
    } else if (el?.textContent) {
      msngInsertCannedText(el.textContent.trim());
    }
  };

  function msngClearPendingImage() {
    if (M.pendingImage?.previewUrl) URL.revokeObjectURL(M.pendingImage.previewUrl);
    M.pendingImage = null;
    const box = $('msngImagePreview');
    const img = $('msngImagePreviewImg');
    if (box) { box.style.display = 'none'; box.setAttribute('aria-hidden', 'true'); }
    if (img) img.removeAttribute('src');
    updateLikeBtnVisibility();
  }

  function msngStageImageFile(file) {
    if (!file) return;
    if (!M.activePsid || !M.activePageId) {
      showToast('Select a conversation first', 'warning');
      return;
    }
    if (!file.type || !file.type.startsWith('image/')) {
      showToast('Only images can be attached here', 'warning');
      return;
    }
    if (file.size > 8 * 1024 * 1024) {
      showToast('Image too large — max 8 MB', 'error');
      return;
    }
    msngClearPendingImage();
    const previewUrl = URL.createObjectURL(file);
    M.pendingImage = { file, previewUrl };
    const box = $('msngImagePreview');
    const img = $('msngImagePreviewImg');
    if (img) img.src = previewUrl;
    if (box) { box.style.display = 'flex'; box.setAttribute('aria-hidden', 'false'); }
    $('msngMsgTextarea')?.focus();
    updateLikeBtnVisibility();
  }

  window.msngSendLike = async function () {
    if (M.ui.sending || !M.activePsid || !M.activePageId || !M.activeToken) {
      showToast('Select a conversation first', 'warning');
      return;
    }
    msngClearPendingImage();
    const tempId = 'temp_like_' + Date.now();
    const tempMsg = {
      message: '👍', from_me: 1, created_at: new Date().toISOString(),
      _tempId: tempId, _pending: true, attachment_type: 'like', _isLike: true
    };
    M.msgs.push(tempMsg);
    M.renderedMsgIds.add(tempId);
    appendBubble(tempMsg);
    scrollToBottom(true, true);

    M.ui.sending = true;
    const likeBtn = $('msngLikeBtn');
    if (likeBtn) likeBtn.disabled = true;

    try {
      const res = await post({
        action: 'send_like',
        page_id: M.activePageId,
        psid: M.activePsid,
        page_token: M.activeToken
      });
      if (res.error) throw new Error(res.error);
      const bubble = document.querySelector(`[data-temp-id="${tempId}"]`);
      if (bubble) {
        bubble.removeAttribute('data-temp-id');
        bubble.classList.remove('pending');
        if (res.message_id) bubble.dataset.msgId = res.message_id;
      }
      const entry = M.msgs.find(m => m._tempId === tempId);
      if (entry) {
        entry.message_id = res.message_id;
        entry._pending = false;
        delete entry._tempId;
      }
      if (res.message_id) M.renderedMsgIds.add(res.message_id);
      bumpConvAfterPageSend(M.activePsid, {
        lastMsg: '👍',
        lastMsgAt: entry?.created_at || new Date().toISOString()
      });
    } catch (e) {
      const bubble = document.querySelector(`[data-temp-id="${tempId}"]`);
      if (bubble) { bubble.classList.add('failed'); bubble.classList.remove('pending'); }
      const entry = M.msgs.find(m => m._tempId === tempId);
      if (entry) entry._failed = true;
      showToast('Thumbs up failed: ' + e.message, 'error');
    } finally {
      M.ui.sending = false;
      if (likeBtn) likeBtn.disabled = false;
      updateLikeBtnVisibility();
    }
  };

  async function msngSendImageFile(file) {
    if (!file) return;
    if (!M.activePsid || !M.activePageId || !M.activeToken) {
      showToast('Select a conversation first', 'warning');
      return;
    }
    if (!file.type || !file.type.startsWith('image/')) {
      showToast('Only images can be sent here', 'warning');
      return;
    }
    if (file.size > 8 * 1024 * 1024) {
      showToast('Image too large — max 8 MB', 'error');
      return;
    }

    const objUrl  = URL.createObjectURL(file);
    const tempId  = 'temp_img_' + Date.now();
    const previewMsg = {
      message: '', from_me: 1, created_at: new Date().toISOString(),
      _tempId: tempId, _pending: true, attachment_url: objUrl, attachment_type: 'image'
    };
    M.msgs.push(previewMsg);
    M.renderedMsgIds.add(tempId);
    appendBubble(previewMsg);

    try {
      const form = new FormData();
      form.append('file', file);
      form.append('page_id', M.activePageId);
      form.append('psid', M.activePsid);
      form.append('page_token', M.activeToken);

      const r = await fetch('/api/messenger/upload', { method: 'POST', credentials: 'same-origin', body: form });
      const d = await r.json();
      if (d.error) throw new Error(d.error);

      const bubble = document.querySelector(`[data-temp-id="${tempId}"]`);
      const entry = M.msgs.find(m => m._tempId === tempId);
      if (bubble) {
        bubble.removeAttribute('data-temp-id');
        bubble.classList.remove('pending');
        if (d.message_id) bubble.dataset.msgId = d.message_id;
        const tickEl = bubble.querySelector('.msng-tick');
        if (tickEl) {
          tickEl.className = 'msng-tick msng-tick--sent';
          tickEl.title = 'Sent';
          tickEl.innerHTML = '<i class="fa-solid fa-check"></i>';
        }
        if (d.attachment_url) {
          const img = bubble.querySelector('.msng-att-img');
          if (img) img.src = d.attachment_url;
        }
      }
      if (entry) {
        entry.message_id = d.message_id;
        entry._pending = false;
        delete entry._tempId;
        if (d.attachment_url) entry.attachment_url = d.attachment_url;
        if (!entry.message) entry.message = d.message || '[Image]';
      }
      if (d.message_id) M.renderedMsgIds.add(d.message_id);
      bumpConvAfterPageSend(M.activePsid, {
        lastMsg: entry?.message || '[Image]',
        lastMsgAt: entry?.created_at || new Date().toISOString()
      });
      URL.revokeObjectURL(objUrl);
    } catch (e) {
      const bubble = document.querySelector(`[data-temp-id="${tempId}"]`);
      if (bubble) { bubble.classList.add('failed'); bubble.classList.remove('pending'); }
      const entry = M.msgs.find(m => m._tempId === tempId);
      if (entry) entry._failed = true;
      showToast('Image send failed: ' + e.message, 'error');
    } finally {
      updateLikeBtnVisibility();
    }
  }

  window.msngClearPendingImage = msngClearPendingImage;

  window.msngOnFileSelect = function (input) {
    const file = input.files[0];
    if (!file) return;
    input.value = '';
    msngStageImageFile(file);
  };

  window.msngOnPaste = function (e) {
    const cd = e.clipboardData;
    if (!cd) return;

    const items = cd.items || [];
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (item.kind === 'file' && item.type && item.type.startsWith('image/')) {
        e.preventDefault();
        const file = item.getAsFile();
        if (file) msngStageImageFile(file);
        return;
      }
    }

    const files = cd.files;
    if (files?.length) {
      for (let i = 0; i < files.length; i++) {
        if (files[i].type && files[i].type.startsWith('image/')) {
          e.preventDefault();
          msngStageImageFile(files[i]);
          return;
        }
      }
    }
  };

  window.msngSearch = function (input) {
    const q = input.value.trim();
    M.search.query = q;
    clearTimeout(M.search.timer);
    if (M.search.abort) { M.search.abort.abort(); M.search.abort = null; }

    if (!q) {
      M.search.active = false;
      renderConvs();
      return;
    }

    M.search.active = true;
    renderLocalSearchResults(q, filterLocalConvs(q));

    M.search.timer = setTimeout(() => doSearch(q), SEARCH_DEBOUNCE_MS);
  };

  window.msngSetFilter = function (filter) {
    M.convFilter = filter === 'unread' ? 'unread' : 'all';
    document.querySelectorAll('.msng-filter-chip').forEach(el => {
      el.classList.toggle('active', el.dataset.filter === M.convFilter);
    });
    invalidateConvListRender();
    const listEl = $('msngConvList');
    if (M.convFilter === 'all' && listEl) clearConvListEmptyState(listEl);
    renderConvs({ immediate: true, forceRebuild: true });
    syncPageBadge(M.activePageId);
  };

  window.msngLoadMore = async function () {
    if (!M.oldestMsgTime || M.ui.loadingMore || !M.hasOlderMessages) return;
    M.ui.loadingMore = true;
    const wrap = $('msngLoadMoreWrap');
    const msgsEl = $('msngMsgs');
    const origHtml = wrap?.innerHTML;
    if (wrap) wrap.innerHTML = '<div class="msng-sk-line" style="width:120px;margin:auto"></div>';
    if (msgsEl) msgsEl.classList.add('msng-loading-older');
    try {
      await loadMessages(M.oldestMsgTime);
    } catch (e) {
      if (wrap && origHtml) wrap.innerHTML = origHtml;
      showToast('Could not load earlier messages', 'error');
    } finally {
      M.ui.loadingMore = false;
      if (msgsEl) msgsEl.classList.remove('msng-loading-older');
    }
  };

  window.msngRefresh = async function () {
    if (!M.activePageId) return;
    const btn = $('msngRefreshBtn');
    if (btn) btn.classList.add('spinning');
    try {
      if (!M.convs.length) {
        _convListCache.delete(M.activePageId);
        await loadConvs(M.activePageId);
      } else {
        await refreshConvListSilent();
      }
      await fetchPageUnreadCounts();
    } finally {
      if (!M._convListRefreshTimer && btn) btn.classList.remove('spinning');
    }
  };

  window.msngBack = function () {
    $('msngConvsCol')?.classList.remove('slide-out');
    M.activePsid = null;
    showChatEmpty();
  };

  window.msngScrollToBottom = () => scrollToBottom(true);

  window.msngToggleEmoji = _buildOrToggleEmoji;

  window.msngToggleSound = function () {
    _soundEnabled = !_soundEnabled;
    localStorage.setItem('msng_sound', _soundEnabled);
    const btn = $('msngSoundBtn');
    if (btn) btn.innerHTML = `<i class="fa-solid fa-${_soundEnabled ? 'volume-high' : 'volume-xmark'}"></i>`;
    showToast(_soundEnabled ? 'Sound notifications on' : 'Sound notifications off', 'info', 2000);
  };

  window.msngMarkRead = function () {
    if (!M.activePsid || !M.activePageId) return;
    queueMarkConvRead(M.activePsid, { immediate: true });
    showToast('Marked as read', 'success', 1800);
  };

  window.msngMarkUnread = function () {
    if (!M.activePsid || !M.activePageId) return;
    queueMarkConvRead(M.activePsid, { markUnread: true });
    showToast('Marked as unread', 'info', 1800);
  };

  function syncPageSelectDropdown() {
    const wrap = $('msngPageSelectWrap');
    const sel = $('msngPageSelect');
    if (!sel) return;
    if (!M.pages.length) {
      if (wrap) wrap.hidden = true;
      return;
    }
    sel.innerHTML = M.pages.map((p) =>
      `<option value="${esc(p.id)}"${p.id === M.activePageId ? ' selected' : ''}>${esc(p.name || 'Page')}</option>`
    ).join('');
    if (wrap) wrap.hidden = M.pages.length <= 1;
  }

  // ── Page Selector Column Renderer ────────────────────────────────────────────
  function renderPages() {
    const listEl = document.getElementById('msngPagesList');
    if (!listEl) return;

    if (!M.pages.length) {
      const loading = !Array.isArray(window.loadedPages);
      listEl.innerHTML = loading
        ? `<div class="msng-no-page msng-no-page--loading">
            <i class="fa-solid fa-spinner fa-spin"></i>
            <h4>Loading pages</h4>
            <p>Syncing your Facebook pages…</p>
          </div>`
        : `<div class="msng-no-page">
            <i class="fa-brands fa-facebook"></i>
            <h4>No pages connected</h4>
            <p>Connect a Facebook Page from Settings to use Messenger.</p>
            <button type="button" class="msng-no-page-btn" onclick="typeof showView==='function'&&showView('settings')">Open Settings</button>
          </div>`;
      return;
    }

    listEl.innerHTML = M.pages.map(p => {
      const isActive = p.id === M.activePageId;
      const initial  = (p.name || 'P').charAt(0).toUpperCase();
      const pic      = p.picture?.data?.url || p.picture || '';
      const avatar   = pic
        ? `<img class="msng-page-avatar" src="${esc(pic)}" alt="${esc(p.name)}" onerror="this.outerHTML='<div class=\\'msng-page-avatar-ph\\'>${esc(initial)}</div>'">`
        : `<div class="msng-page-avatar-ph">${esc(initial)}</div>`;

      const pid = String(p.id);
      const pgUnread = M.pageUnread[pid] || 0;
      const subText  = pgUnread > 0 ? `${pgUnread} unread chat${pgUnread !== 1 ? 's' : ''}` : 'No unread';
      const pgBadge  = `<span class="msng-page-badge" id="msngPageBadge_${esc(pid)}"
                              style="display:${pgUnread > 0 ? 'flex' : 'none'}">${pgUnread > 99 ? '99+' : pgUnread}</span>`;
      const unreadDot = `<span class="msng-page-unread-dot" style="display:${pgUnread > 0 ? 'block' : 'none'}" aria-hidden="true"></span>`;
      return `<div class="msng-page-item ${isActive ? 'active' : ''} ${pgUnread > 0 ? 'has-unread' : ''}" data-page-id="${esc(pid)}">
        <div class="msng-page-avatar-wrap">${avatar}${unreadDot}</div>
        <div class="msng-page-info">
          <div class="msng-page-name">${esc(p.name)}</div>
          <div class="msng-page-sub" id="msngPageSub_${esc(p.id)}">${esc(subText)}</div>
        </div>
        ${pgBadge}
      </div>`;
    }).join('');

    updateMessengerChrome();
    syncPageSelectDropdown();

    // Click handlers
    listEl.querySelectorAll('.msng-page-item').forEach(el => {
      el.addEventListener('click', () => {
        const pageId = el.dataset.pageId;
        if (pageId && pageId !== M.activePageId) {
          window.msngSelectPage(pageId);
          renderPages(); // Update active highlight
        }
      });
    });
  }

  // ── Socket.io Real-time Integration ─────────────────────────────────────────
  let _socket = null;

  function initSocketListeners() {
    if (typeof io === 'undefined') return;
    if (_socket?.connected) return; // already live

    _socket = io({ reconnectionDelay: 2000, reconnectionDelayMax: 15000, reconnectionAttempts: Infinity });

    _socket.on('connect', () => {
      M._offline = false;
      hideConnBanner();
      setLivePillState(true);
      // Re-join rooms after every reconnect
      M.pages.forEach(p => _socket.emit('join_page', p.id));
    });

    _socket.on('connect_error', (err) => {
      console.warn('[Socket] connect_error:', err.message);
      if (!M._offline) {
        M._offline = true;
        showConnBanner('Real-time updates unavailable — using polling');
      }
    });

    _socket.on('disconnect', (reason) => {
      console.warn('[Socket] disconnected:', reason);
      M._offline = true;
      if (reason !== 'io client disconnect') {
        showConnBanner('Reconnecting to real-time updates…');
      }
    });

    _socket.on('reconnect', (attempt) => {
      M._offline = false;
      hideConnBanner();
      showToast('Real-time reconnected', 'success', 2500);
      M.pages.forEach(p => _socket.emit('join_page', p.id));
    });

    // New message from webhook → all joined page rooms
    _socket.on('new_message', (msg) => {
      if (!msg || typeof msg !== 'object') return;
      if (!msg.pageId || !msg.participantId) return;

      const msgPageId = String(msg.pageId);
      const msgPsid   = String(msg.participantId);
      const isActivePage = msgPageId === String(M.activePageId);
      const isOpenConv   = isActivePage && msgPsid === String(M.activePsid);
      const normalized = normalizeMsg({
        message_id: msg.id || null,
        message: typeof msg.text === 'string' ? msg.text : '',
        from_me: msg.isFromPage ? 1 : 0,
        created_at: msg.createdTime || new Date().toISOString(),
        attachment_url: msg.attachment_url || null,
        attachment_type: msg.attachment_type || null,
        is_like: msg.is_like
      });

      if (isOpenConv) {
        const confirmedPending = _tryConfirmPending(normalized);
        if (!confirmedPending && !isDuplicate(normalized)) {
          M.msgs.push(normalized);
          appendBubble(normalized);
        }
      }

      if (!isActivePage) {
        if (!msg.isFromPage) {
          updatePageBadge(msgPageId, (M.pageUnread[msgPageId] || 0) + 1);
          maybeNotifyIncoming({
            pageId: msgPageId,
            psid: msgPsid,
            sender: 'Customer',
            pageName: pageNameById(msgPageId),
            preview: msgPreviewText(normalized) || normalizePreviewText(msg.text || '')
          });
        }
        window.dispatchEvent(new CustomEvent('fbc:conversation-changed', { detail: msg }));
        return;
      }

      const conv = getConv(M.activePageId, msgPsid);
      if (conv) {
        conv.lastMsg    = msgPreviewText(normalized) || normalizePreviewText(msg.text || '');
        conv.lastFromMe = !!msg.isFromPage;
        conv.lastMsgAt  = msg.createdTime || new Date().toISOString();
        if (!isOpenConv && !msg.isFromPage) {
          conv.unread = (conv.unread || 0) + 1;
        } else if (isOpenConv && !msg.isFromPage) {
          conv.unread = 0;
          queueMarkConvRead(msgPsid, { immediate: true });
        }
        resortConvsByMeta();
        renderConvs();
      } else if (!msg.isFromPage && msg.participantId) {
        const row = {
          id: msg.threadId, psid: msg.participantId,
          name: 'New User', picture: null,
          lastMsg: msgPreviewText(normalized) || 'Message', lastFromMe: false,
          lastMsgAt: msg.createdTime || new Date().toISOString(),
          unread: 1, page_id: M.activePageId
        };
        M.convs.push(row);
        M._convByPsid.set(convKey(M.activePageId, msg.participantId), row);
        resortConvsByMeta();
        renderConvs();
      }

      if (!msg.isFromPage) {
        syncPageBadge(M.activePageId);
        if (!isOpenConv) {
          const convRow = getConv(M.activePageId, msgPsid);
          maybeNotifyIncoming({
            pageId: msgPageId,
            psid: msgPsid,
            sender: convRow?.name || 'Customer',
            pageName: pageNameById(msgPageId),
            preview: msgPreviewText(normalized) || normalizePreviewText(msg.text || '')
          });
          const flashEl = document.querySelector(`.msng-conv-item[data-psid="${CSS.escape(msgPsid)}"]`);
          if (flashEl) {
            flashEl.classList.remove('msng-flash');
            void flashEl.offsetWidth;
            flashEl.classList.add('msng-flash');
            setTimeout(() => flashEl.classList.remove('msng-flash'), 800);
            const badge = flashEl.querySelector('.msng-ci-badge');
            if (badge) {
              badge.classList.remove('msng-badge-pop');
              void badge.offsetWidth;
              badge.classList.add('msng-badge-pop');
              setTimeout(() => badge.classList.remove('msng-badge-pop'), 400);
            }
          }
        }
      }

      window.dispatchEvent(new CustomEvent('fbc:conversation-changed', { detail: msg }));
    });

    // Conversation metadata refresh (snippet, unread count)
    _socket.on('conversation_updated', (data) => {
      if (!data || typeof data !== 'object') return;
      const dataPageId = data.pageId ? String(data.pageId) : '';
      const isActivePage = dataPageId === String(M.activePageId);

      if (dataPageId && !isActivePage) {
        if (!data.lastMessageFromPage && data.last_from_me != 1) {
          updatePageBadge(dataPageId, (M.pageUnread[dataPageId] || 0) + 1);
          if (data.participantId) {
            maybeNotifyIncoming({
              pageId: dataPageId,
              psid: data.participantId,
              sender: data.user_name || 'Customer',
              pageName: pageNameById(dataPageId),
              preview: normalizePreviewText(data.snippet || '')
            });
          }
        }
        window.dispatchEvent(new CustomEvent('fbc:conversation-changed', { detail: data }));
        return;
      }

      const conv = data.participantId
        ? getConv(M.activePageId, data.participantId)
        : M.convs.find(c => c.id === data.id);
      if (conv) {
        let changed = false;
        const pageSent = data.lastMessageFromPage === true || data.last_from_me == 1;
        if (data.snippet) {
          const norm = normalizePreviewText(data.snippet);
          if (norm !== normalizePreviewText(conv.lastMsg || '')) {
            conv.lastMsg = norm;
            changed = true;
          }
        }
        if (data.participantId !== M.activePsid) {
          const nu = resolveConvUnread(
            conv.psid,
            data.unreadCount != null ? data.unreadCount : 1,
            data.updatedTime || conv.lastMsgAt,
            pageSent || conv.lastFromMe
          );
          if (conv.unread !== nu) {
            conv.unread = nu;
            changed = true;
          }
        } else {
          lockConvRead(conv.psid);
          conv.unread = 0;
          changed = true;
          if (pageSent && data.updatedTime) conv.lastMsgAt = data.updatedTime;
        }
        if (changed) {
          resortConvsByMeta();
          renderConvs();
          if (!pageSent && data.participantId && String(data.participantId) !== String(M.activePsid)) {
            maybeNotifyIncoming({
              pageId: M.activePageId,
              psid: data.participantId,
              sender: conv.name || 'Customer',
              pageName: pageNameById(M.activePageId),
              preview: normalizePreviewText(conv.lastMsg || data.snippet || '')
            });
          }
          syncPageBadge(M.activePageId);
        }
      }
      window.dispatchEvent(new CustomEvent('fbc:conversation-changed', { detail: data }));
    });

    // Typing indicator — server emits 'agent_typing' (not 'typing')
    _socket.on('agent_typing', (data) => {
      if (!data) return;
      const el = $('msngTyping');
      if (!el) return;
      el.style.display = 'flex';
      clearTimeout(el._hideTimer);
      el._hideTimer = setTimeout(() => { el.style.display = 'none'; }, 3000);
    });

    // Delivery / read receipts — update tick icons
    _socket.on('msg_status', (data) => {
      if (!data || typeof data !== 'object') return;
      if (String(data.pageId) !== String(M.activePageId)) return;
      if (String(data.participantId) !== String(M.activePsid)) return;
      const watermark = parseInt(data.watermark);
      if (isNaN(watermark)) return;
      if (data.type === 'delivered') {
        if (watermark > M.msgStatus.delivered) M.msgStatus.delivered = watermark;
      } else if (data.type === 'read') {
        if (watermark > M.msgStatus.read)      M.msgStatus.read      = watermark;
        if (watermark > M.msgStatus.delivered) M.msgStatus.delivered = watermark;
      }
      updateTicksInDom();
    });

    // Sync progress (initial or incremental sync running on server)
    _socket.on('sync_progress', (prog) => {
      if (!prog) return;
      const pageMatch = !prog.pageId || String(prog.pageId) === String(M.activePageId);
      if (!pageMatch) return;
      if (prog.phase === 'done') {
        M.ui.syncing = false;
        clearSyncPoll();
        hideSyncBanner();
        if (M.activePageId) {
          _convListCache.delete(M.activePageId);
          loadConvs(M.activePageId, false, {
            fresh: true,
            silentRefresh: true,
            loadSeq: ++M._convLoadSeq
          });
        }
      }
    });

    // ── Customer typing (Facebook sends typing_on via webhook) ──────────────
    _socket.on('customer_typing', (data) => {
      if (!data || String(data.pageId) !== String(M.activePageId)) return;
      if (String(data.participantId) !== String(M.activePsid)) return;
      const el = $('msngCustomerTyping');
      if (!el) return;
      if (data.typing !== false) {
        el.classList.add('visible');
        clearTimeout(el._hideTimer);
        // Auto-hide after 6s — FB doesn't always send typing_off
        el._hideTimer = setTimeout(() => el.classList.remove('visible'), 6000);
      } else {
        el.classList.remove('visible');
      }
    });

    // ── thread_read — another agent marked thread read ───────────────────────
    _socket.on('thread_read', (data) => {
      if (!data || String(data.pageId) !== String(M.activePageId)) return;
      lockConvRead(data.psid);
      const conv = M.convs.find(c => String(c.psid) === String(data.psid));
      if (conv) {
        conv.unread = 0;
        renderConvs();
        syncPageBadge(M.activePageId);
      }
    });

    // ── agent_viewing — presence: another agent is looking at this thread ───
    _socket.on('agent_viewing', (data) => {
      if (!data || String(data.pageId) !== String(M.activePageId)) return;
      // Briefly show "Agent viewing" on that conv item — clears after 8s
      const conv = M.convs.find(c => String(c.id) === String(data.threadId));
      const convItem = conv
        ? document.querySelector(`.msng-conv-item[data-psid="${CSS.escape(String(conv.psid))}"]`)
        : null;
      if (!convItem) return;
      let badge = convItem.querySelector('.msng-viewing-badge');
      if (!badge) {
        badge = document.createElement('span');
        badge.className = 'msng-viewing-badge';
        badge.title = data.agentName + ' is viewing';
        convItem.querySelector('.msng-ci-right')?.appendChild(badge);
      }
      clearTimeout(badge._clearTimer);
      badge._clearTimer = setTimeout(() => badge.remove(), 8000);
    });
  }

  // ── Updated msngInit ────────────────────────────────────────────────────────
  const _origMsngInit = window.msngInit;
  window.msngInit = function (retries = 0) {
    M.pages = (window.loadedPages || []).filter(p => p?.id && p?.access_token);
    M.pages.forEach(p => {
      const id = String(p.id);
      if (M.pageUnread[id] == null) {
        M.pageUnread[id] = Math.max(0, parseInt(p.unreadCount, 10) || 0);
      }
    });
    loadCannedReplies().catch(() => {});
    if (!M.pages.length) {
      renderPages();
      if (retries < 10) { setTimeout(() => window.msngInit(retries + 1), 500); return; }
      const listEl = $('msngConvList');
      if (listEl) listEl.innerHTML = `<div class="msng-empty">
        <i class="fa-brands fa-facebook-messenger"></i>
        <h4>No pages connected</h4>
        <p>Connect a Facebook Page from Settings to use Messenger.</p>
      </div>`;
      showChatEmpty();
      return;
    }

    renderPages();
    const _sb = $('msngSoundBtn');
    if (_sb) _sb.innerHTML = `<i class="fa-solid fa-${_soundEnabled ? 'volume-high' : 'volume-xmark'}"></i>`;

    const preferredId = window.currentPageId || M.pages[0].id;
    (async () => {
      await fetchPageUnreadCounts();
      if (!M.activePageId || !M.pages.find(p => String(p.id) === String(M.activePageId))) {
        window.msngSelectPage(preferredId);
      } else {
        renderConvs();
      }
      bindConvListDelegate();
      startPolling();
      initSocketListeners();
    })();
  };

  window.msngRefreshPageUnread = fetchPageUnreadCounts;

  // ── Updated msngSelectPage ──────────────────────────────────────────────────
  window.msngSelectPage = function (pageId) {
    const loadSeq = ++M._convLoadSeq;
    const prevPageId = M.activePageId;
    if (prevPageId && String(prevPageId) !== String(pageId) && M.convs.length) {
      _convListCache.set(prevPageId, {
        convs: M.convs.map(c => ({ ...c })),
        order: M._convOrder.slice(),
        offset: M.convOffset,
        hasMore: M.convHasMore,
        ts: Date.now()
      });
    }

    clearSyncPoll();
    M.ui.syncing = false;
    M.activePageId = pageId;
    M.activeToken  = (M.pages.find(p => p.id === pageId) || {}).access_token || null;
    M.activePsid   = null;
    resetReadState();
    M.search.query = '';
    M.search.active = false;
    M.search.cache.clear();
    const searchInput = $('msngSearchInput');
    if (searchInput) searchInput.value = '';
    M.poll.since = new Date(Date.now() - 2000).toISOString();

    renderPages();
    showChatEmpty();

    // Never show cached list on page switch — stale previews/order flash for seconds.
    _convListCache.delete(pageId);
    M.convs = [];
    M._convOrder = [];
    M.convOffset = 0;
    M.convHasMore = true;
    invalidateConvListRender();
    rebuildConvIndex();
    showConvSkeleton();
    renderConvs({ immediate: true });
    loadConvs(pageId, false, { loadSeq, fresh: true });
  };

  // ── Outer page selector integration ─────────────────────────────────────────
  document.addEventListener('DOMContentLoaded', () => {
    const sel = document.getElementById('pageSelect');
    if (sel) {
      sel.addEventListener('change', function () {
        const view = document.getElementById('view-messenger');
        if (view?.style.display !== 'none' && this.value) {
          window.currentPageId = this.value;
          M.pages = (window.loadedPages || []).filter(p => p?.id && p?.access_token);
          window.msngSelectPage(this.value);
        }
      });
    }

    // Load earlier messages button click handler
    document.addEventListener('click', function(e) {
      const btn = e.target.closest('.msng-load-more-btn');
      if (btn && M.oldestMsgTime) {
        e.preventDefault();
        btn.disabled = true;
        btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Loading...';
        loadMessages(M.oldestMsgTime).finally(() => {
          btn.disabled = false;
          btn.innerHTML = '<i class="fa-solid fa-chevron-up"></i> Load earlier messages';
        });
      }
    });

    // Image lightbox — delegate on document so it works for dynamically added images
    document.addEventListener('click', (e) => {
      const img = e.target.closest('.msng-att-img');
      if (!img || !img.src) return;
      e.preventDefault();
      e.stopPropagation();
      openLightbox(img.src);
    });

    window.addEventListener('fbc:conversation-changed', () => schedulePageUnreadRefresh(700));
    window.addEventListener('fbc:pages-ready', () => {
      if (document.getElementById('view-messenger')?.style.display !== 'none') {
        M.pages = (window.loadedPages || []).filter(p => p?.id && p?.access_token);
        fetchPageUnreadCounts();
      }
    });

    // Search input handler
    const searchInput = document.getElementById('msngSearchInput');
    if (searchInput) {
      searchInput.addEventListener('input', function() {
        window.msngSearch(this);
      });
      searchInput.addEventListener('keyup', function(e) {
        if (e.key === 'Escape') {
          this.value = '';
          window.msngSearch(this);
        }
      });
    }
  });

  // ── Stop polling when messenger view is not active ───────────────────────────
  const _origSwitch = window.switchDashboardView;
  if (_origSwitch) {
    window.switchDashboardView = function (view) {
      document.body.classList.toggle('in-messenger', view === 'messenger');
      view === 'messenger' ? startPolling() : stopPolling();
      _origSwitch(view);
    };
  }

  window.addEventListener('fbcast:logout', () => {
    try {
      if (_socket) {
        _socket.disconnect();
        _socket = null;
      }
    } catch (_) {}
    stopPolling();
    stopConvListAutoRefresh();
    M.pages = [];
    M.activePageId = null;
    M.activePsid = null;
  });

  // ── After Facebook login: reload inbox from DB (server sync runs in background) ─
  window.addEventListener('fbcast:sync-done', () => {
    _convListCache.clear();
    if (M.activePageId) loadConvs(M.activePageId);
    else if (M.pages.length) window.msngSelectPage(M.pages[0].id);
  });

  // ═══════════════════════════════════════════════════════════════════════════════
  // KEYBOARD SHORTCUTS — Senior Dev Power Features
  // ═══════════════════════════════════════════════════════════════════════════════
  document.addEventListener('keydown', (e) => {
    // Ignore if typing in input/textarea
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') {
      // Escape clears input
      if (e.key === 'Escape') {
        e.target.blur();
        return;
      }
      // Ctrl+Enter sends message
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        window.msngSend();
      }
      return;
    }

    // Navigation shortcuts (when NOT in input)
    if (!M.convs.length) return;

    if (e.key === 'j') {
      // J = next conversation
      const currentIdx = M.activePsid ? M.convs.findIndex(c => c.psid === M.activePsid) : -1;
      const nextIdx = (currentIdx + 1) % M.convs.length;
      window.msngOpenConv(M.convs[nextIdx].psid, M.convs[nextIdx].name, M.convs[nextIdx].picture);
    } else if (e.key === 'k') {
      // K = previous conversation
      const currentIdx = M.activePsid ? M.convs.findIndex(c => c.psid === M.activePsid) : M.convs.length;
      const prevIdx = currentIdx <= 0 ? M.convs.length - 1 : currentIdx - 1;
      window.msngOpenConv(M.convs[prevIdx].psid, M.convs[prevIdx].name, M.convs[prevIdx].picture);
    } else if (e.key === 'r' && (e.altKey || e.metaKey)) {
      // Alt+R = focus reply input
      const input = $('msngMsgTextarea');
      if (input) { input.focus(); e.preventDefault(); }
    } else if (e.key === 'Escape') {
      // Escape = close conversation / clear selection
      if (M.activePsid) {
        M.activePsid = null;
        M.msgs = [];
        showChatEmpty();
      }
    }
  });

  document.addEventListener('click', (e) => {
    if (!e.target.closest('.msng-canned-row-actions')) {
      document.querySelectorAll('.msng-canned-dd').forEach(d => { d.style.display = 'none'; });
    }
  });

  })();
