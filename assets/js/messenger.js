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

    search: { query: '', timer: null },

    ui: { sending: false, loadingMore: false },

    msgStatus: { delivered: 0, read: 0 }, // unix-ms watermarks for active conversation

    pageUnread: {},    // { pageId: unreadCount } — drives red dot on page icons

    _msgAbort: null,   // AbortController for in-flight loadMessages request
    _offline:  false,  // true while socket is disconnected
  };

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
      content = `<img class="msng-att-img" src="${esc(attUrl)}" alt="Image"
                      onclick="window.open('${esc(attUrl)}','_blank')">`;
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
    const listEl = $('msngConvList');
    if (!listEl) return;

    const q    = M.search.query.toLowerCase();
    const list = q
      ? M.convs.filter(c => c.name.toLowerCase().includes(q) || (c.lastMsg || '').toLowerCase().includes(q))
      : M.convs;

    updatePageBadge(M.activePageId, M.convs.reduce((s, c) => s + (c.unread || 0), 0));

    if (!list.length) {
      const syncBannerVisible = $('msngSyncBanner')?.style.display !== 'none' && $('msngSyncBanner');
      if (q) {
        listEl.innerHTML = `<div class="msng-empty">
          <i class="fa-brands fa-facebook-messenger"></i>
          <p>No results for "<strong>${esc(q)}</strong>"</p>
        </div>`;
      } else if (syncBannerVisible) {
        listEl.innerHTML = `<div class="msng-empty">
          <i class="fa-solid fa-rotate fa-spin" style="font-size:28px;color:var(--primary-color);margin-bottom:10px"></i>
          <h4>Syncing conversations…</h4>
          <p style="font-size:12px;opacity:.7">Please wait while we load your Facebook chats</p>
        </div>`;
      } else {
        listEl.innerHTML = `<div class="msng-empty">
          <i class="fa-brands fa-facebook-messenger"></i>
          <h4>No chats found</h4>
          <p>Messages will appear here once you sync with Facebook.</p>
          <button class="msng-sync-btn" onclick="msngSyncNow()" style="margin-top:12px;background:var(--primary-color);color:white;border:none;padding:8px 16px;border-radius:6px;cursor:pointer;font-weight:500;display:flex;align-items:center;gap:8px;margin-left:auto;margin-right:auto">
            <i class="fa-solid fa-rotate"></i> Sync Now
          </button>
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

  function renderMessages(mode = 'replace') {
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

    // Show "beginning of conversation" only when ≤30 messages (likely all loaded)
    const showStart = M.msgs.length > 0 && M.msgs.length <= 30;
    let html = showStart
      ? `<div class="msng-conv-start">
           <div class="msng-conv-start-avatar">${avatarHtml(M.activeConvPic, M.activeConvName, 'msng-conv-start-img')}</div>
           <div class="msng-conv-start-name">${esc(M.activeConvName)}</div>
           <div class="msng-conv-start-sub">Beginning of your conversation on Facebook Messenger</div>
         </div>`
      : `<div class="msng-load-more" id="msngLoadMoreWrap">
           <button class="msng-load-more-btn" data-action="load-more">
             <i class="fa-solid fa-chevron-up"></i> Load earlier messages
           </button>
         </div>`;

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
      msgsEl.innerHTML = html;
      scrollToBottom(false);
    } else {
      // Preserve scroll position (load-more prepend)
      const prevHeight = msgsEl.scrollHeight;
      const prevTop    = msgsEl.scrollTop;
      msgsEl.innerHTML = html;
      msgsEl.scrollTop = msgsEl.scrollHeight - prevHeight + prevTop;
    }

    bindScrollListener(msgsEl);
  }

  // Append one bubble without rebuilding the list.
  // Used by real-time poll and optimistic send.
  function appendBubble(msg) {
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
    trackMsgId(msg);
    scrollToBottom(true);
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

  function scrollToBottom(smooth = false) {
    const msgsEl = $('msngMsgs');
    if (!msgsEl) return;
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
    $('msngChatHdrSub').innerHTML = `<i class="fa-solid fa-circle" style="font-size:7px;color:#22c55e"></i> Facebook Messenger`;
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
    M.poll.since    = new Date(Date.now() - 5000).toISOString().replace('T', ' ').slice(0, 19);
    M.poll.failures = 0;
    schedulePoll(3000);
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
      M.poll.since    = data.server_time || new Date().toISOString().replace('T', ' ').slice(0, 19);
      M.poll.failures = 0;
      if (wasOffline) { hideConnBanner(); showToast('Back online', 'success', 2500); }

      // New messages in the open conversation — always scroll to bottom
      let gotNewMsg = false;
      (data.new_messages || []).forEach(msg => {
        if (_tryConfirmPending(msg)) return; // our own echo — confirm pending bubble, skip append
        if (!isDuplicate(msg)) {
          M.msgs.push(msg);
          appendBubble(msg);
          gotNewMsg = true;
        }
      });
      if (gotNewMsg) scrollToBottom(true);

      // Updated conversations (unread counts, snippets, new convs from other senders)
      let convListDirty = false;
      if (data.updated_convs?.length) {
        data.updated_convs.forEach(uc => {
          const existing = M.convs.find(c => c.psid === uc.fb_user_id);
          if (existing) {
            if (uc.fb_user_id !== M.activePsid) existing.unread = parseInt(uc.is_unread) || 0;
            if (uc.snippet)      existing.lastMsg     = uc.snippet;
            if (uc.last_from_me != null) existing.lastFromMe = uc.last_from_me == 1;
            existing.lastMsgAt = uc.updated_at || uc.last_msg_at;
          } else {
            M.convs.unshift({
              id: uc.id, psid: uc.fb_user_id,
              name: uc.user_name || 'User', picture: uc.user_picture || null,
              lastMsg: uc.snippet || uc.last_msg || '',
              lastFromMe: uc.last_from_me == 1,
              lastMsgAt: uc.updated_at || uc.last_msg_at,
              unread: parseInt(uc.is_unread) || 0,
              page_id: uc.page_id,
            });
          }
          convListDirty = true;
        });

        // If the OPEN conversation received a new message but no psid was
        // in this poll tick, fetch just the new messages directly.
        const activeUpdated = data.updated_convs.find(uc => uc.fb_user_id === M.activePsid);
        if (activeUpdated && !data.new_messages?.length && M.activePsid) {
          get('poll', { page_id: M.activePageId, since: M.poll.since, psid: M.activePsid })
            .then(d => (d.new_messages || []).forEach(msg => {
              if (!isDuplicate(msg)) { M.msgs.push(msg); appendBubble(msg); }
            }))
            .catch(() => {});
        }

        M.convs.sort((a, b) => new Date(b.lastMsgAt || 0) - new Date(a.lastMsgAt || 0));

        const newFromOthers = data.updated_convs.filter(c =>
          c.fb_user_id !== M.activePsid && parseInt(c.is_unread) > 0
        );
        if (newFromOthers.length) {
          showToast('New message from ' + (newFromOthers[0].user_name || 'a customer'), 'info');
        }
      }

      if (convListDirty || data.new_messages?.length) renderConvs();

      if (typeof data.total_unread === 'number') updatePageBadge(M.activePageId, data.total_unread);

      schedulePoll(3000);

    } catch (e) {
      M.poll.failures++;
      const base  = Math.min(3000 * (2 ** M.poll.failures), 30_000);
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
    scrollToBottom(true); // Always scroll when sending — user just typed this message

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

  function doSearch(q) {
    if (!M.activePageId) return;
    const listEl = $('msngConvList');
    if (!listEl) return;

    listEl.innerHTML = `<div class="msng-empty">
      <i class="fa-solid fa-magnifying-glass fa-bounce"></i><p>Searching…</p>
    </div>`;

    get('search', { page_id: M.activePageId, q })
      .then(data => {
        if (M.search.query !== q) return; // stale — user typed more

        const convMatches = data.conversations || [];
        const msgMatches  = data.messages      || [];

        if (!convMatches.length && !msgMatches.length) {
          listEl.innerHTML = `<div class="msng-empty">
            <i class="fa-solid fa-magnifying-glass"></i>
            <p>No results for "<strong>${esc(q)}</strong>"</p>
          </div>`;
          return;
        }

        // Group message matches by psid
        const msgByPsid = {};
        msgMatches.forEach(m => {
          const psid = m.psid || m.user_id;
          if (!psid) return;
          if (!msgByPsid[psid]) msgByPsid[psid] = { name: m.user_name, pic: m.user_picture, msgs: [] };
          msgByPsid[psid].msgs.push(m);
        });

        const convPsids = new Set(convMatches.map(c => c.fb_user_id));
        let html = '';

        convMatches.forEach(c => {
          html += searchRow(c.fb_user_id, c.user_name, c.user_picture,
            c.snippet || c.last_msg || '', c.last_msg_at || c.updated_at,
            c.page_id || M.activePageId, null);
        });

        Object.entries(msgByPsid).forEach(([psid, info]) => {
          if (convPsids.has(psid)) return; // already shown above
          const preview = info.msgs.slice(0, 2).map(m => {
            const prefix = m.from_me == 1 ? 'You: ' : '';
            return `<span class="msng-search-match">${prefix}${highlight(m.message || '', q)}</span>`;
          }).join('<br>');
          html += searchRow(psid, info.name, info.pic, '', info.msgs[0]?.created_at, M.activePageId, preview);
        });

        listEl.innerHTML = html || `<div class="msng-empty"><p>No results</p></div>`;
      })
      .catch(() => renderConvs());
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

  // type: 'info' | 'success' | 'error' | 'warning'
  function showToast(msg, type = 'info', duration = 3500) {
    const t = $('msngToast');
    if (!t) return;
    t.textContent = msg;
    t.className = `msng-toast msng-toast--${type} show`;
    clearTimeout(t._hideTimer);
    t._hideTimer = setTimeout(() => {
      t.classList.remove('show');
      setTimeout(() => { t.className = 'msng-toast'; }, 300);
    }, duration);
  }

  function showConnBanner(msg) {
    let b = $('msngConnBanner');
    if (!b) {
      b = document.createElement('div');
      b.id = 'msngConnBanner';
      b.className = 'msng-conn-banner';
      const root = document.querySelector('.msng-root');
      if (root) root.insertBefore(b, root.firstChild);
    }
    b.innerHTML = `<i class="fa-solid fa-wifi" style="opacity:.6"></i> ${msg}`;
    b.style.display = 'flex';
  }

  function hideConnBanner() {
    const b = $('msngConnBanner');
    if (b) b.style.display = 'none';
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
      if (M.ui.loadingConvs || !M.convHasMore) return;
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

  async function loadConvs(pageId, isMore = false) {
    if (M.ui.loadingConvs) return;
    if (isMore && !M.convHasMore) return;

    if (!isMore) {
      M.convOffset = 0;
      M.convHasMore = true;
      showConvSkeleton();
    } else {
      _showConvLoadingMore();
    }
    M.ui.loadingConvs = true;

    try {
      const limit = 40;
      const data = await get('load_conversations', { page_id: pageId, limit, offset: M.convOffset });
      if (data.error) throw new Error(data.error);

      const newConvs = (data.conversations || []).map(c => ({
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

      if (isMore) {
        M.convs = [...M.convs, ...newConvs];
      } else {
        M.convs = newConvs;
      }

      M.convOffset += newConvs.length;
      if (newConvs.length < limit) M.convHasMore = false;

      renderConvs();

      // Auto-sync when first load returns empty — DB may not have been populated yet
      if (!isMore && newConvs.length === 0 && M.activeToken && !M._autoSynced?.[pageId]) {
        M._autoSynced = M._autoSynced || {};
        M._autoSynced[pageId] = true;
        showSyncBanner('No conversations found — syncing from Facebook…');
        fetch('/api/sync-history', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({ page_id: pageId, page_token: M.activeToken }),
        }).catch(() => {});
      }
    } catch (e) {
      console.error('[Messenger] loadConvs:', e);
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

  async function loadMessages(before = null) {
    if (!M.activePageId || !M.activePsid) return;
    // Snapshot the psid at call time — used to detect stale responses
    const forPsid = M.activePsid;
    const msgsEl  = $('msngMsgs');

    // Only show skeleton when there are no cached messages already displayed
    if (!before && msgsEl && !M.msgs.length) {
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

      const fresh = data.messages || [];
      if (before) {
        // "Load earlier" — prepend older messages
        M.msgs = [...fresh, ...M.msgs];
        renderMessages('prepend');
      } else {
        // Merge: keep any pending/optimistic bubbles not yet in server response
        const serverIds = new Set(fresh.map(m => m.message_id).filter(Boolean));
        const pending   = M.msgs.filter(m => m._pending || m._failed);
        const toKeep    = pending.filter(m => !m.message_id || !serverIds.has(m.message_id));
        M.msgs           = [...fresh, ...toKeep];
        M.renderedMsgIds = new Set();
        renderMessages('replace');
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
    _msgCache.set(psid, { msgs: [...M.msgs], oldestMsgTime: M.oldestMsgTime });
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

    const conv = M.convs.find(c => c.psid === psid);
    if (conv) conv.unread = 0;
    renderConvs();

    showChatWindow(name, picture);

    const cached = _cacheLoad(psid);
    if (cached && cached.msgs.length) {
      // Restore from cache instantly — no skeleton, no wait
      M.msgs           = [...cached.msgs];
      M.renderedMsgIds = new Set();
      M.oldestMsgTime  = cached.oldestMsgTime;
      renderMessages('replace');
      scrollToBottom(false);
      // Silent background refresh to pick up any new messages since cached
      loadMessages().catch(() => {});
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

  window.msngTextareaInput = function (ta) {
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, 120) + 'px';
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

  window.msngOnFileSelect = async function (input) {
    const file = input.files[0];
    if (!file) return;
    input.value = '';

    if (!M.activePsid || !M.activePageId || !M.activeToken) {
      showToast('Select a conversation first', 'warning');
      return;
    }
    if (file.size > 8 * 1024 * 1024) {
      showToast('Image too large — max 8 MB', 'error');
      return;
    }

    // Optimistic preview bubble
    const objUrl  = URL.createObjectURL(file);
    const tempId  = 'temp_img_' + Date.now();
    const previewMsg = { message: '', from_me: 1, created_at: new Date().toISOString(), _tempId: tempId, _pending: true, attachment_url: objUrl, attachment_type: 'image' };
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
  };

  window.msngSearch = function (input) {
    const q = input.value.trim();
    M.search.query = q;
    clearTimeout(M.search.timer);
    if (!q) { renderConvs(); return; }
    M.search.timer = setTimeout(() => doSearch(q), 300);
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

  window.msngSyncNow = async function () {
    if (!M.activePageId || !M.activeToken) { showToast('No page selected', 'warning'); return; }
    showSyncBanner('Syncing from Facebook… this may take a moment');
    try {
      const r = await fetch('/api/sync-history', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ page_id: M.activePageId, page_token: M.activeToken }),
      });
      const d = await r.json();
      if (!r.ok || d.error) throw new Error(d.error || ('Server error ' + r.status));
      // Banner stays up — socket sync_progress { phase:'done' } will reload convs and hide it
      // Fallback: reload after 30s if socket doesn't fire
      setTimeout(() => { hideSyncBanner(); loadConvs(M.activePageId); }, 30000);
    } catch (e) {
      hideSyncBanner();
      showToast('Sync failed: ' + e.message, 'error', 5000);
    }
  };

  window.msngRefresh = async function () {
    if (!M.activePageId || !M.activeToken) return;
    const btn = $('msngRefreshBtn');
    if (btn) btn.classList.add('spinning');

    try {
      // Sync fresh conversations from Facebook first, then reload from DB
      await fetch('/api/sync-history', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ page_id: M.activePageId, page_token: M.activeToken }),
      });
    } catch (_) {
      // Network hiccup — still reload from DB below
    }

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
          scrollToBottom(true);
        }
      }

      // Update sidebar conversation entry
      const conv = M.convs.find(c =>
        String(c.psid) === msgPsid &&
        (String(c.page_id) === msgPageId || String(M.activePageId) === msgPageId)
      );
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
        M.convs.unshift({
          id: msg.threadId, psid: msg.participantId,
          name: 'New User', picture: null,
          lastMsg: msg.text || '[Attachment]', lastFromMe: false,
          lastMsgAt: msg.createdTime || new Date().toISOString(),
          unread: 1, page_id: msg.pageId
        });
        renderConvs();
      }

      // Increment page badge when message comes for a different page
      if (!msg.isFromPage && msg.pageId && msg.pageId !== M.activePageId) {
        updatePageBadge(msg.pageId, (M.pageUnread[msg.pageId] || 0) + 1);
      }

      if (!msg.isFromPage && msg.participantId !== M.activePsid) {
        const pageName = M.pages.find(p => p.id === msg.pageId)?.name || '';
        showToast('New message' + (pageName ? ' on ' + pageName : ''), 'info');
      }
    });

    // Conversation metadata refresh (snippet, unread count)
    _socket.on('conversation_updated', (data) => {
      if (!data || typeof data !== 'object') return;
      const conv = M.convs.find(c => c.id === data.id || c.psid === data.participantId);
      if (conv) {
        if (data.snippet)     conv.lastMsg   = data.snippet;
        if (data.updatedTime) conv.lastMsgAt = data.updatedTime;
        if (data.participantId !== M.activePsid) {
          conv.unread = data.unreadCount || (conv.unread || 0) + 1;
        }
        renderConvs();
      }
    });

    // Typing indicator
    _socket.on('typing', (data) => {
      if (!data || data.pageId !== M.activePageId || data.participantId !== M.activePsid) return;
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
      if (prog.phase === 'done') {
        hideSyncBanner();
        if (M.activePageId) loadConvs(M.activePageId);
      } else {
        const pct = prog.total ? Math.round((prog.done / prog.total) * 100) : 0;
        showSyncBanner(`Syncing history… ${prog.done || 0}/${prog.total || '?'} (${pct}%)`);
      }
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
    M.activePageId = pageId;
    M.activeToken  = (M.pages.find(p => p.id === pageId) || {}).access_token || null;
    M.activePsid   = null;
    M.pageUnread[pageId] = 0;  // Clear badge for the page we're switching to
    renderPages();
    showChatEmpty();
    loadConvs(pageId);
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

  // ── Sync events from fb_api.js ───────────────────────────────────────────────
  window.addEventListener('fbcast:sync-started', () => showSyncBanner('Syncing your Facebook history…'));
  window.addEventListener('fbcast:sync-done',    () => { hideSyncBanner(); if (M.activePageId) loadConvs(M.activePageId); });

})();
