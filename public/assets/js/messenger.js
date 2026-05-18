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

    poll: { timer: null, since: null, failures: 0 },

    search: { query: '', timer: null, active: false, abort: null, cache: new Map() },

    ui: { sending: false, loadingMore: false, syncing: false, loadingConvs: false },

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
  };

  const POLL_MS = 3000;
  const POLL_SOCKET_MS = 8000;
  const CONV_PAGE_SIZE = 30;
  const CONV_LIST_CACHE_MS = 30_000;
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
      try { return await r.json(); } catch { return { error: 'Server error (' + r.status + ')' }; }
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

  function fmtTime(dateStr) {
    if (!dateStr) return '';
    const d    = new Date(dateStr);
    if (isNaN(d)) return '';
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
    const d = new Date(dateStr);
    return isNaN(d) ? '' : d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true });
  }

  function fmtDate(dateStr) {
    if (!dateStr) return '';
    const d     = new Date(dateStr);
    if (isNaN(d)) return '';
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

  function nextPollDelayMs() {
    if (M.activePsid) return Math.min(POLL_MS, POLL_SOCKET_MS);
    if (_socket?.connected && !M._offline) return POLL_SOCKET_MS;
    return POLL_MS;
  }

  function getDisplayConvs() {
    if (M.search.active) return [];
    let list = M.convs;
    if (M.convFilter === 'unread') list = list.filter(c => (c.unread || 0) > 0);
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

  function convItemHtml(c, activePsid) {
    const isActive = c.psid === activePsid;
    const isUnread = c.unread > 0;
    const preview  = c.lastFromMe ? 'You: ' + (c.lastMsg || '') : (c.lastMsg || 'No messages yet');
    const short    = preview.length > 42 ? preview.slice(0, 42) + '…' : preview;
    const badge    = isUnread ? `<span class="msng-ci-badge">${c.unread > 9 ? '9+' : c.unread}</span>` : '';

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
        <div class="msng-ci-last">${esc(short)}</div>
      </div>
      ${badge}
    </div>`;
  }

  function bubbleHtml(msg) {
    const fromMe  = msg.from_me == 1;
    const txt     = msg.message  || '';
    const attUrl  = msg.attachment_url;
    const attType = msg.attachment_type;
    const tempId  = msg._tempId  || '';

    let content = '';
    if (attType === 'image' && attUrl) {
      content = `<img class="msng-att-img" src="${esc(attUrl)}" alt="Image" role="button" tabindex="0">`;
      if (txt && txt !== '[Image]') content += `<div style="margin-top:4px">${esc(txt)}</div>`;
    } else if (txt) {
      content = esc(txt).replace(/\n/g, '<br>');
    } else {
      content = '<em style="opacity:.5">Attachment</em>';
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

  function renderConvs() {
    if (M.search.active) return; // search results own the list — don't overwrite them
    const listEl = $('msngConvList');
    if (!listEl) return;

    const q    = M.search.query.toLowerCase();
    const list = getDisplayConvs();

    updatePageBadge(M.activePageId, M.convs.reduce((s, c) => s + (c.unread || 0), 0));
    updateMessengerChrome();

    if (!list.length) {
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

    // Index existing nodes by psid
    const existing = {};
    listEl.querySelectorAll('[data-psid]').forEach(el => { existing[el.dataset.psid] = el; });

    // Remove nodes not in the new list
    const wanted = new Set(list.map(c => c.psid));
    Object.keys(existing).forEach(psid => { if (!wanted.has(psid)) existing[psid].remove(); });

    list.forEach((c, i) => {
      let node = existing[c.psid];

      if (node) {
        // Patch only what changed — no DOM teardown
        const isActive = c.psid === M.activePsid;
        node.classList.toggle('active',  isActive);
        node.classList.toggle('unread',  c.unread > 0);

        const preview = c.lastFromMe ? 'You: ' + (c.lastMsg || '') : (c.lastMsg || 'No messages yet');
        const short   = preview.length > 42 ? preview.slice(0, 42) + '…' : preview;

        const nameEl  = node.querySelector('.msng-ci-name');
        const lastEl  = node.querySelector('.msng-ci-last');
        const timeEl  = node.querySelector('.msng-ci-time');
        let   badgeEl = node.querySelector('.msng-ci-badge');

        if (nameEl) nameEl.textContent = c.name;
        if (lastEl) lastEl.textContent = short;
        if (timeEl) timeEl.textContent = fmtTime(c.lastMsgAt);

        if (c.unread > 0) {
          if (!badgeEl) {
            node.insertAdjacentHTML('beforeend', `<span class="msng-ci-badge">${c.unread > 9 ? '9+' : c.unread}</span>`);
          } else {
            badgeEl.textContent = c.unread > 9 ? '9+' : c.unread;
          }
        } else if (badgeEl) {
          badgeEl.remove();
        }
      } else {
        // New conv — create node
        const tmp = document.createElement('div');
        tmp.innerHTML = convItemHtml(c, M.activePsid);
        node = tmp.firstElementChild;
        existing[c.psid] = node;
      }

      // Ensure correct visual order (insertBefore is a no-op if already in position)
      if (listEl.children[i] !== node) listEl.insertBefore(node, listEl.children[i] || null);
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
    listEl.innerHTML = sk() + sk() + sk() + sk() + sk();
  }

  function updatePageBadge(pageId, count) {
    if (!pageId) return;
    const n = parseInt(count) || 0;
    M.pageUnread[pageId] = n;
    const badge = $('msngPageBadge_' + pageId);
    if (badge) {
      badge.style.display = n > 0 ? 'flex' : 'none';
      badge.textContent   = n > 99 ? '99+' : n;
    }
    const sub = $('msngPageSub_' + pageId);
    if (sub) sub.textContent = n > 0 ? n + ' unread' : 'No unread';
  }

  // ══════════════════════════════════════════════════════════
  // CHAT WINDOW
  // ══════════════════════════════════════════════════════════

  function renderMessages(mode = 'replace', opts = {}) {
    const msgsEl = $('msngMsgs');
    if (!msgsEl) return;

    // Sort by timestamp (oldest first)
    M.msgs.sort((a, b) => new Date(a.created_at || 0) - new Date(b.created_at || 0));

    if (!M.msgs.length) {
      msgsEl.innerHTML = `<div class="msng-empty" style="margin-top:60px">
        <i class="fa-regular fa-comments"></i>
        <p>No messages yet. Start the conversation!</p>
      </div>`;
      return;
    }

    const showLoadMore = M.msgs.length > 30 && !_atRetentionBoundary();
    const showStart    = M.msgs.length > 0 && !showLoadMore;
    let html = showLoadMore
      ? `<div class="msng-load-more" id="msngLoadMoreWrap">
           <button class="msng-load-more-btn" data-action="load-more">
             <i class="fa-solid fa-chevron-up"></i> Load earlier messages
           </button>
         </div>`
      : showStart
      ? `<div class="msng-conv-start">
           <div class="msng-conv-start-avatar">${avatarHtml(M.activeConvPic, M.activeConvName, 'msng-conv-start-img')}</div>
           <div class="msng-conv-start-name">${esc(M.activeConvName)}</div>
           <div class="msng-conv-start-sub">Beginning of your conversation on Facebook Messenger</div>
         </div>`
      : '';

    let lastDate = '';
    M.msgs.forEach(msg => {
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
  }

  function appendNewMessagesFromIndex(startIndex, opts = {}) {
    for (let i = startIndex; i < M.msgs.length; i++) {
      appendBubble(M.msgs[i], opts);
    }
  }

  // Append one bubble without rebuilding the list.
  // Used by real-time poll and optimistic send.
  function appendBubble(msg, opts = {}) {
    const msgsEl = $('msngMsgs');
    if (!msgsEl) return;

    // Replace empty-state div if it's the only content
    if (msgsEl.querySelector('.msng-empty') && !msgsEl.querySelector('.msng-msg')) {
      msgsEl.innerHTML = `<div class="msng-load-more" id="msngLoadMoreWrap">
        <button class="msng-load-more-btn" data-action="load-more">
          <i class="fa-solid fa-chevron-up"></i> Load earlier messages
        </button>
      </div>`;
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
    const pending = M.msgs.find(m => m._pending && !m.message_id && m.message === (msg.message || ''));
    if (!pending) return false;

    pending.message_id = msg.message_id;
    pending._pending   = false;
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

  function bindScrollListener(msgsEl) {
    const btn = $('msngScrollBtn');
    if (!btn) return;
    msgsEl.onscroll = () => {
      const atBottom = msgsEl.scrollHeight - msgsEl.scrollTop - msgsEl.clientHeight < 60;
      btn.classList.toggle('visible', !atBottom);
    };
  }

  function showChatWindow(name, picture) {
    $('msngChatEmpty').style.display  = 'none';
    $('msngChatWindow').style.display = 'flex';
    $('msngChatHdrName').textContent  = name || 'User';
    $('msngChatHdrSub').innerHTML = `<span class="msng-online-dot"></span> Facebook Messenger · real-time`;
    const wrap = $('msngChatHdrAvatar');
    if (wrap) wrap.innerHTML = avatarHtml(picture, name, 'msng-hdr-avatar');
  }

  function showChatEmpty() {
    const w = $('msngChatWindow'), e = $('msngChatEmpty');
    if (w) w.style.display = 'none';
    if (e) e.style.display = 'flex';
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

  function startPolling() {
    stopPolling();
    M.poll.since    = new Date(Date.now() - 5000).toISOString();
    M.poll.failures = 0;
    schedulePoll(nextPollDelayMs());
  }

  function stopPolling() {
    if (M.poll.timer) { clearTimeout(M.poll.timer); M.poll.timer = null; }
  }

  function schedulePoll(delayMs) {
    stopPolling();
    M.poll.timer = setTimeout(runPoll, delayMs);
  }

  async function runPoll() {
    M.poll.timer = null;
    if (!M.activePageId || document.hidden) return;

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
      M.poll.since    = data.server_time || new Date().toISOString();
      M.poll.failures = 0;
      if (wasOffline) { hideConnBanner(); showToast('Back online', 'success', 2500); }

      // Server short-circuit: skip DOM work when quiet (unless FB list sync ran)
      if (data.has_changes === false && !M.activePsid && !data.list_synced) {
        schedulePoll(nextPollDelayMs());
        return;
      }

      // New messages in the open conversation — always scroll to bottom
      let gotNewMsg = false;
      (data.new_messages || []).forEach(msg => {
        if (_tryConfirmPending(msg)) return; // our own echo — confirm pending bubble, skip append
        if (!isDuplicate(msg)) {
          M.msgs.push(msg);
          appendBubble(msg, { animate: false });
          gotNewMsg = true;
        }
      });
      if (gotNewMsg) {
        const msgsEl = $('msngMsgs');
        if (isMsgsNearBottom(msgsEl)) scrollToBottom(true, true);
      }

      // Graph sync — silent refresh at most every 45s (avoids full-list flicker)
      if (M.activePsid && data.graph_synced && !gotNewMsg && !(data.new_messages || []).length) {
        const now = Date.now();
        if (now - (M._graphMsgReloadAt || 0) > 45_000) {
          M._graphMsgReloadAt = now;
          loadMessages(null, { silent: true }).catch(() => {});
        }
      }

      // Updated conversations (unread counts, snippets, new convs from other senders)
      let convListDirty = false;
      if (data.updated_convs?.length) {
        data.updated_convs.forEach(uc => {
          const ucPage = String(uc.page_id || M.activePageId || '');
          if (ucPage !== String(M.activePageId)) return;

          const key = convKey(M.activePageId, uc.fb_user_id);
          const existing = M._convByPsid.get(key);
          if (existing) {
            if (uc.fb_user_id !== M.activePsid) {
              existing.unread = parseInt(uc.is_unread) || 0;
            } else if (parseInt(uc.is_unread) > 0) {
              existing.unread = parseInt(uc.is_unread);
            }
            if (uc.snippet) existing.lastMsg = uc.snippet;
            if (uc.last_from_me != null) existing.lastFromMe = uc.last_from_me == 1;
            const newAt = uc.updated_at || uc.last_msg_at;
            if (newAt) existing.lastMsgAt = newAt;
          } else {
            const row = {
              id: uc.id, psid: uc.fb_user_id,
              name: uc.user_name || 'User', picture: uc.user_picture || null,
              lastMsg: uc.snippet || uc.last_msg || '',
              lastFromMe: uc.last_from_me == 1,
              lastMsgAt: uc.updated_at || uc.last_msg_at,
              unread: parseInt(uc.is_unread) || 0,
              page_id: M.activePageId,
            };
            M.convs.unshift(row);
            M._convByPsid.set(key, row);
          }
          convListDirty = true;
        });

        M.convs.sort((a, b) => new Date(b.lastMsgAt || 0) - new Date(a.lastMsgAt || 0));
        rebuildConvIndex();

        const newFromOthers = data.updated_convs.filter(c =>
          c.fb_user_id !== M.activePsid && parseInt(c.is_unread) > 0
        );
        if (newFromOthers.length) {
          showToast('New message from ' + (newFromOthers[0].user_name || 'a customer'), 'info');
          _playNotifSound();
        }
      }

      // FB list sync — refresh sidebar if poll missed updated_at window
      if (data.list_synced && M.activePageId) {
        _convListCache.delete(M.activePageId);
        if (!convListDirty) {
          loadConvs(M.activePageId, false, { background: true });
        }
      }

      // Only re-render if there are actual changes (optimization)
      if (convListDirty || data.new_messages?.length) renderConvs();

      if (typeof data.total_unread === 'number') updatePageBadge(M.activePageId, data.total_unread);

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
    const now    = new Date().toISOString().replace('T', ' ').slice(0, 19);
    const tempMsg = { message: text, from_me: 1, created_at: now, _tempId: tempId, _pending: true };

    M.msgs.push(tempMsg);
    M.renderedMsgIds.add(tempId);
    appendBubble(tempMsg);
    scrollToBottom(true, true); // Always scroll when sending — user just typed this message

    try {
      const res = await post({
        action: 'send_message', page_id: M.activePageId,
        psid: M.activePsid, message: text, page_token: M.activeToken,
      });

      if (res.error) throw new Error(res.error);

      // Confirm the bubble — swap temp state for real
      const bubble = document.querySelector(`[data-temp-id="${tempId}"]`);
      if (bubble) {
        bubble.removeAttribute('data-temp-id');
        bubble.classList.remove('pending');
        if (res.message_id) {
          bubble.dataset.msgId = res.message_id;
          if (now) bubble.dataset.createdTs = new Date(now).getTime();
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

      const conv = M.convs.find(c => c.psid === M.activePsid);
      if (conv) { conv.lastMsg = text; conv.lastFromMe = true; conv.lastMsgAt = now; }
      renderConvs();

    } catch (e) {
      showToast('Send failed — tap Retry to try again', 'error');

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
      clearInterval(M._syncPollTimer);
      M._syncPollTimer = null;
    }
    M._syncPollAttempts = 0;
  }

  /** Retry list while server sync runs — avoids infinite "Loading conversations…" */
  function startSyncPoll(pageId) {
    clearSyncPoll();
    if (!pageId) return;
    M._syncPollTimer = setInterval(() => {
      M._syncPollAttempts += 1;
      if (!M.ui.syncing || M.convs.length || M._syncPollAttempts > 25) {
        if (M.ui.syncing && !M.convs.length) M.ui.syncing = false;
        clearSyncPoll();
        renderConvs();
        return;
      }
      loadConvs(pageId, false, { background: true });
    }, 4000);
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

  function _drainToastQ() {
    if (!_toastQ.length) { _toastBusy = false; return; }
    _toastBusy = true;
    const { msg, type, duration } = _toastQ.shift();
    const t = $('msngToast');
    if (!t) { _toastBusy = false; return; }
    t.textContent = msg;
    t.className   = `msng-toast msng-toast--${type} show`;
    clearTimeout(t._hideTimer);
    t._hideTimer = setTimeout(() => {
      t.classList.remove('show');
      setTimeout(_drainToastQ, 300);
    }, duration);
  }

  // type: 'info' | 'success' | 'error' | 'warning'
  function showToast(msg, type = 'info', duration = 3500) {
    _toastQ.push({ msg, type, duration });
    if (!_toastBusy) _drainToastQ();
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
    } else {
      M.convs = rows;
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
      unread:     parseInt(c.is_unread) || 0,
      page_id:    c.page_id,
    }));
  }

  async function loadConvs(pageId, isMore = false, opts = {}) {
    if (M.ui.loadingConvs && !opts.background) return;
    if (isMore && !M.convHasMore) return;

    if (!isMore && !opts.background) {
      M.convOffset = 0;
      M.convHasMore = true;
      const hit = _convListCache.get(pageId);
      if (hit && Date.now() - hit.ts < CONV_LIST_CACHE_MS && hit.convs.length) {
        M.convs = hit.convs;
        M.convOffset = hit.offset;
        M.convHasMore = hit.hasMore;
        rebuildConvIndex();
        renderConvs();
        loadConvs(pageId, false, { background: true });
        return;
      }
      showConvSkeleton();
    } else if (isMore) {
      _showConvLoadingMore();
    }
    M.ui.loadingConvs = true;

    try {
      const limit = CONV_PAGE_SIZE;
      const data = await get('load_conversations', { page_id: pageId, limit, offset: M.convOffset });
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
      } else {
        M.convs = newConvs;
      }

      M.convOffset += newConvs.length;
      if (data.has_more === false || newConvs.length < limit) M.convHasMore = false;

      if (!isMore) {
        _convListCache.set(pageId, {
          convs: M.convs,
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
      if (!opts.background) renderConvs();
      else if (newConvs.length) renderConvs();
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
      M.ui.loadingConvs = false;
      _hideConvLoadingMore();
    }
  }

  async function loadMessages(before = null, opts = {}) {
    if (!M.activePageId || !M.activePsid) return;
    const silent = !!opts.silent;
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

      const data = await r.json();
      if (M.activePsid !== forPsid) return; // second stale check after JSON parse

      if (data.error) {
        if (!before && msgsEl) _showMsgError(msgsEl, data.error);
        return;
      }

      const fresh = _filterMsgsByRetention(data.messages || []);
      if (before) {
        // "Load earlier" — prepend older messages
        M.msgs = [...fresh, ...M.msgs];
        renderMessages('prepend');
      } else {
        const prevMsgs = M.msgs.slice();
        const serverIds = new Set(fresh.map(m => m.message_id).filter(Boolean));
        const pending   = M.msgs.filter(m => m._pending || m._failed);
        const toKeep    = pending.filter(m => !m.message_id || !serverIds.has(m.message_id));
        M.msgs = _filterMsgsByRetention([...fresh, ...toKeep]);
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
      // Update cache with fresh data
      _cacheSave(forPsid);

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
    _msgCache.set(psid, { msgs: _filterMsgsByRetention(M.msgs), oldestMsgTime: M.oldestMsgTime });
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

    M.activePsid     = psid;
    M.activeConvName = name;
    M.activeConvPic  = picture;
    M.msgStatus      = { delivered: 0, read: 0 };
    if (pageId) {
      M.activePageId = pageId;
      M.activeToken  = (M.pages.find(p => p.id === pageId) || {}).access_token || M.activeToken;
    }

    const conv = getConv(pageId || M.activePageId, psid);
    if (conv) conv.unread = 0;
    renderConvs();

    if (_socket?.connected) {
      if (M._joinedThread) _socket.emit('leave_thread', M._joinedThread);
      M._joinedThread = conv?.id || null;
      if (M._joinedThread) _socket.emit('join_thread', M._joinedThread);
      if (M._joinedThread && M.activePageId) {
        _socket.emit('viewing_thread', {
          pageId: M.activePageId,
          threadId: M._joinedThread,
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
      renderMessages('replace', { scroll: 'force' });
      // Silent background refresh — patch DOM only if messages changed
      loadMessages(null, { silent: true }).catch(() => {});
    } else {
      M.msgs = []; M.renderedMsgIds = new Set(); M.oldestMsgTime = null;
      await loadMessages();
    }

    post({ action: 'mark_read', page_id: M.activePageId, psid }).catch(() => {});

    $('msngMsgTextarea')?.focus();
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

  window.msngSend = function () {
    const ta = $('msngMsgTextarea');
    if (!ta) return;
    const text = ta.value.trim();
    if (!text) return;
    ta.value = ''; ta.style.height = 'auto';
    doSend(text);
  };

  window.msngKeydown = function (e) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); window.msngSend(); }
  };

  // Typing emit state — throttled: start fires once, stop fires after 3s idle
  let _typingEmitTimer = null;
  let _typingActive    = false;

  window.msngTextareaInput = function (ta) {
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, 120) + 'px';
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

  window.msngToggleCanned = function () {
    const panel = $('msngCannedPanel');
    const btn   = $('msngCannedBtn');
    if (!panel) return;
    const open = panel.style.display !== 'none';
    panel.style.display = open ? 'none' : 'flex';
    btn?.classList.toggle('active', !open);
  };

  window.msngUseCanned = function (el) {
    const ta = $('msngMsgTextarea');
    if (ta) {
      ta.value = el.textContent.trim();
      ta.focus();
      window.msngTextareaInput(ta);
      window.msngUpdateCharCount(ta);
    }
    window.msngToggleCanned();
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
      if (bubble) { bubble.removeAttribute('data-temp-id'); bubble.classList.remove('pending'); }
      if (d.message_id) M.renderedMsgIds.add(d.message_id);
      URL.revokeObjectURL(objUrl);
    } catch (e) {
      const bubble = document.querySelector(`[data-temp-id="${tempId}"]`);
      if (bubble) { bubble.classList.add('failed'); bubble.classList.remove('pending'); }
      showToast('Image send failed: ' + e.message, 'error');
    }
  }

  window.msngOnFileSelect = async function (input) {
    const file = input.files[0];
    if (!file) return;
    input.value = '';
    await msngSendImageFile(file);
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
        if (file) msngSendImageFile(file);
        return;
      }
    }

    // Screenshot paste on some browsers (image/png in files list only)
    const files = cd.files;
    if (files?.length) {
      for (let i = 0; i < files.length; i++) {
        if (files[i].type && files[i].type.startsWith('image/')) {
          e.preventDefault();
          msngSendImageFile(files[i]);
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
    renderConvs();
  };

  window.msngLoadMore = async function () {
    if (!M.oldestMsgTime || M.ui.loadingMore) return;
    M.ui.loadingMore = true;
    const wrap = $('msngLoadMoreWrap');
    const origHtml = wrap?.innerHTML;
    if (wrap) wrap.innerHTML = '<div class="msng-sk-line" style="width:120px;margin:auto"></div>';
    try {
      await loadMessages(M.oldestMsgTime);
    } catch (e) {
      if (wrap && origHtml) wrap.innerHTML = origHtml;
      showToast('Could not load earlier messages', 'error');
    } finally {
      M.ui.loadingMore = false;
    }
  };

  window.msngRefresh = async function () {
    if (!M.activePageId) return;
    const btn = $('msngRefreshBtn');
    if (btn) btn.classList.add('spinning');
    _convListCache.delete(M.activePageId);
    try {
      await loadConvs(M.activePageId);
    } finally {
      btn?.classList.remove('spinning');
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
    post({ action: 'mark_read', page_id: M.activePageId, psid: M.activePsid });
    const conv = M.convs.find(c => c.psid === M.activePsid);
    if (conv) { conv.unread = 0; renderConvs(); }
  };

  // ── Page Selector Column Renderer ────────────────────────────────────────────
  function renderPages() {
    const listEl = document.getElementById('msngPagesList');
    if (!listEl) return;

    listEl.innerHTML = M.pages.map(p => {
      const isActive = p.id === M.activePageId;
      const initial  = (p.name || 'P').charAt(0).toUpperCase();
      const pic      = p.picture?.data?.url || p.picture || '';
      const avatar   = pic
        ? `<img class="msng-page-avatar" src="${esc(pic)}" alt="${esc(p.name)}" onerror="this.outerHTML='<div class=\\'msng-page-avatar-ph\\'>${esc(initial)}</div>'">`
        : `<div class="msng-page-avatar-ph">${esc(initial)}</div>`;

      const pgUnread = M.pageUnread[p.id] || 0;
      const subText  = pgUnread > 0 ? `${pgUnread} unread` : 'No unread';
      const pgBadge  = `<span class="msng-page-badge" id="msngPageBadge_${esc(p.id)}"
                              style="display:${pgUnread > 0 ? 'flex' : 'none'}">${pgUnread > 99 ? '99+' : pgUnread}</span>`;
      return `<div class="msng-page-item ${isActive ? 'active' : ''}" data-page-id="${esc(p.id)}">
        <div class="msng-page-avatar-wrap">${avatar}</div>
        <div class="msng-page-info">
          <div class="msng-page-name">${esc(p.name)}</div>
          <div class="msng-page-sub" id="msngPageSub_${esc(p.id)}">${esc(subText)}</div>
        </div>
        ${pgBadge}
      </div>`;
    }).join('');

    updateMessengerChrome();

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

    // New message from webhook → push into open conversation
    _socket.on('new_message', (msg) => {
      if (!msg || typeof msg !== 'object') return;
      if (!msg.pageId || !msg.participantId) return;

      const msgPageId = String(msg.pageId);
      const msgPsid   = String(msg.participantId);

      if (msgPageId === String(M.activePageId) && msgPsid === String(M.activePsid)) {
        const normalized = {
          message_id:      msg.id             || null,
          conversation_id: msg.threadId       || null,
          page_id:         msg.pageId,
          user_id:         msg.participantId,
          message:         typeof msg.text === 'string' ? msg.text : '',
          from_me:         msg.isFromPage ? 1 : 0,
          created_at:      msg.createdTime    || new Date().toISOString(),
          attachment_url:  msg.attachments?.[0]?.u || null,
          attachment_type: msg.attachments?.[0]?.t || null
        };
        const confirmedPending = _tryConfirmPending(normalized); // race-condition guard for own echo
        if (!confirmedPending && !isDuplicate(normalized)) {
          M.msgs.push(normalized);
          appendBubble(normalized);
        }
      }

      // Sidebar: only update conversations for the page currently shown
      if (msgPageId !== String(M.activePageId)) return;

      const conv = getConv(M.activePageId, msgPsid);
      if (conv) {
        conv.lastMsg    = msg.text || '[Attachment]';
        conv.lastFromMe = !!msg.isFromPage;
        conv.lastMsgAt  = msg.createdTime || new Date().toISOString();
        if (msg.participantId !== M.activePsid && !msg.isFromPage) {
          conv.unread = (conv.unread || 0) + 1;
        }
        M.convs.sort((a, b) => new Date(b.lastMsgAt || 0) - new Date(a.lastMsgAt || 0));
        renderConvs();
      } else if (!msg.isFromPage && msg.participantId) {
        const row = {
          id: msg.threadId, psid: msg.participantId,
          name: 'New User', picture: null,
          lastMsg: msg.text || '[Attachment]', lastFromMe: false,
          lastMsgAt: msg.createdTime || new Date().toISOString(),
          unread: 1, page_id: M.activePageId
        };
        M.convs.unshift(row);
        M._convByPsid.set(convKey(M.activePageId, msg.participantId), row);
        renderConvs();
      }

      // Increment page badge when message comes for a different page
      if (!msg.isFromPage && msg.pageId && msg.pageId !== M.activePageId) {
        updatePageBadge(msg.pageId, (M.pageUnread[msg.pageId] || 0) + 1);
      }

      if (!msg.isFromPage && msg.participantId !== M.activePsid) {
        const pageName = M.pages.find(p => p.id === msg.pageId)?.name || '';
        showToast('New message' + (pageName ? ' on ' + pageName : ''), 'info');
        _playNotifSound();
        // Flash the conversation item in the sidebar
        const flashEl = document.querySelector(`.msng-conv-item[data-psid="${CSS.escape(String(msg.participantId))}"]`);
        if (flashEl) {
          flashEl.classList.remove('msng-flash');
          void flashEl.offsetWidth; // reflow to restart animation
          flashEl.classList.add('msng-flash');
          setTimeout(() => flashEl.classList.remove('msng-flash'), 800);
          // Pop the unread badge
          const badge = flashEl.querySelector('.msng-ci-badge');
          if (badge) {
            badge.classList.remove('msng-badge-pop');
            void badge.offsetWidth;
            badge.classList.add('msng-badge-pop');
            setTimeout(() => badge.classList.remove('msng-badge-pop'), 400);
          }
        }
      }

      window.dispatchEvent(new CustomEvent('fbc:conversation-changed', { detail: msg }));
    });

    // Conversation metadata refresh (snippet, unread count)
    _socket.on('conversation_updated', (data) => {
      if (!data || typeof data !== 'object') return;
      if (data.pageId && String(data.pageId) !== String(M.activePageId)) return;
      const conv = data.participantId
        ? getConv(M.activePageId, data.participantId)
        : M.convs.find(c => c.id === data.id);
      if (conv) {
        if (data.snippet)     conv.lastMsg   = data.snippet;
        if (data.updatedTime) conv.lastMsgAt = data.updatedTime;
        if (data.participantId !== M.activePsid) {
          conv.unread = data.unreadCount || (conv.unread || 0) + 1;
        }
        renderConvs();
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
          loadConvs(M.activePageId);
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
        scrollToBottom(false);
      } else {
        el.classList.remove('visible');
      }
    });

    // ── thread_read — another agent marked thread read ───────────────────────
    _socket.on('thread_read', (data) => {
      if (!data || String(data.pageId) !== String(M.activePageId)) return;
      const conv = M.convs.find(c => String(c.psid) === String(data.psid));
      if (conv && conv.unread > 0) {
        conv.unread = 0;
        renderConvs();
      }
    });

    // ── agent_viewing — presence: another agent is looking at this thread ───
    _socket.on('agent_viewing', (data) => {
      if (!data || String(data.pageId) !== String(M.activePageId)) return;
      // Briefly show "Agent viewing" on that conv item — clears after 8s
      const convItem = document.querySelector(`.msng-conv-item[data-conv-id="${CSS.escape(String(data.threadId))}"]`);
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
    // Seed per-page unread counts from the pages API response
    M.pages.forEach(p => {
      if (M.pageUnread[p.id] == null) M.pageUnread[p.id] = p.unreadCount || 0;
    });
    if (!M.pages.length) {
      if (retries < 10) { setTimeout(() => window.msngInit(retries + 1), 500); return; }
      const listEl = $('msngConvList');
      if (listEl) listEl.innerHTML = `<div class="msng-empty">
        <i class="fa-brands fa-facebook-messenger"></i>
        <h4>No pages connected</h4>
        <p>Connect a Facebook page to use Messenger.</p>
      </div>`;
      return;
    }

    // Render pages column
    renderPages();
    // Sync sound button icon with saved preference
    const _sb = $('msngSoundBtn');
    if (_sb) _sb.innerHTML = `<i class="fa-solid fa-${_soundEnabled ? 'volume-high' : 'volume-xmark'}"></i>`;

    const preferredId = window.currentPageId || M.pages[0].id;
    if (!M.activePageId || !M.pages.find(p => p.id === M.activePageId)) {
      window.msngSelectPage(preferredId);
    } else {
      renderConvs();
    }
    bindConvListDelegate();
    startPolling();

    // Initialize Socket.io for real-time
    initSocketListeners();
  };

  // ── Updated msngSelectPage ──────────────────────────────────────────────────
  window.msngSelectPage = function (pageId) {
    clearSyncPoll();
    M.ui.syncing = false;
    M.activePageId = pageId;
    M.activeToken  = (M.pages.find(p => p.id === pageId) || {}).access_token || null;
    M.activePsid   = null;
    M.search.query = '';
    M.search.active = false;
    M.search.cache.clear();
    const searchInput = $('msngSearchInput');
    if (searchInput) searchInput.value = '';
    M.pageUnread[pageId] = 0;
    renderPages();
    showChatEmpty();
    const hit = _convListCache.get(pageId);
    if (hit && Date.now() - hit.ts < CONV_LIST_CACHE_MS && hit.convs.length) {
      M.convs = hit.convs;
      M.convOffset = hit.offset;
      M.convHasMore = hit.hasMore;
      rebuildConvIndex();
      renderConvs();
      loadConvs(pageId, false, { background: true });
    } else {
      loadConvs(pageId);
    }
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

  })();
