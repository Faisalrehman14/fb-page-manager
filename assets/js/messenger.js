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

    convs:        [],   // [{ psid, name, picture, lastMsg, lastFromMe, lastMsgAt, unread, page_id }]

    activePsid:      null,
    activeConvName:  '',
    activeConvPic:   '',
    msgs:            [],        // ordered oldest→newest
    renderedMsgIds:  new Set(), // dedup — O(1) via message_id or content hash
    oldestMsgTime:   null,

    poll: { timer: null, since: null, failures: 0 },

    search: { query: '', timer: null },

    ui: { sending: false, loadingMore: false },
  };

  // ══════════════════════════════════════════════════════════
  // HTTP
  // ══════════════════════════════════════════════════════════
  async function get(action, params = {}) {
    const qs  = new URLSearchParams(params).toString();
    const url = 'messenger_api.php?action=' + encodeURIComponent(action) + (qs ? '&' + qs : '');
    const r   = await fetch(url, { credentials: 'same-origin' });
    if (!r.headers.get('content-type')?.includes('application/json')) {
      const txt = await r.text();
      console.error('[Messenger] Non-JSON:', txt.slice(0, 200));
      throw new Error('Server returned non-JSON');
    }
    return r.json();
  }

  async function post(payload) {
    const r = await fetch('messenger_api.php', {
      method:      'POST',
      headers:     { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body:        JSON.stringify(payload),
    });
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
      if (txt && txt !== '[Image]') content += `<div>${esc(txt)}</div>`;
    } else if (txt) {
      content = esc(txt).replace(/\n/g, '<br>');
    } else {
      content = '<em style="opacity:.5">Attachment</em>';
    }

    const avatar = !fromMe
      ? `<div class="msng-msg-avatar-wrap">${avatarHtml(M.activeConvPic, M.activeConvName, 'msng-msg-avatar')}</div>`
      : '';

    return `<div class="msng-msg ${fromMe ? 'from-me' : ''} ${msg._pending ? 'pending' : ''}"
                 ${tempId ? `data-temp-id="${esc(tempId)}"` : ''}
                 ${msg.message_id ? `data-msg-id="${esc(msg.message_id)}"` : ''}>
      ${avatar}
      <div class="msng-msg-group">
        <div class="msng-bubble">${content}</div>
        <div class="msng-msg-meta">
          <span class="msng-msg-time">${esc(fmtMsgTime(msg.created_at))}</span>
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
      listEl.innerHTML = `<div class="msng-empty">
        <i class="fa-brands fa-facebook-messenger"></i>
        <p>${q ? 'No results for "<strong>' + esc(q) + '</strong>"' : 'No conversations yet.<br>Messages from your page will appear here.'}</p>
      </div>`;
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
    const badge = $('msngPageBadge_' + pageId);
    if (!badge) return;
    badge.style.display = count > 0 ? 'flex' : 'none';
    badge.textContent   = count > 99 ? '99+' : count;
  }

  // ══════════════════════════════════════════════════════════
  // CHAT WINDOW
  // ══════════════════════════════════════════════════════════

  function renderMessages(mode = 'replace') {
    const msgsEl = $('msngMsgs');
    if (!msgsEl) return;

    if (!M.msgs.length) {
      msgsEl.innerHTML = `<div class="msng-empty" style="margin-top:60px">
        <i class="fa-regular fa-comments"></i>
        <p>No messages yet. Start the conversation!</p>
      </div>`;
      return;
    }

    let html = `<div class="msng-load-more" id="msngLoadMoreWrap">
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

    // Auto-scroll only if user is already near bottom
    const atBottom = msgsEl.scrollHeight - msgsEl.scrollTop - msgsEl.clientHeight < 80;
    if (atBottom) scrollToBottom(true);
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

  function scrollToBottom(smooth = false) {
    const msgsEl = $('msngMsgs');
    if (!msgsEl) return;
    msgsEl.scrollTo({ top: msgsEl.scrollHeight, behavior: smooth ? 'smooth' : 'instant' });
    $('msngScrollBtn')?.classList.remove('visible');
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
      M.poll.since    = data.server_time || new Date().toISOString().replace('T', ' ').slice(0, 19);
      M.poll.failures = 0;

      // New messages in the open conversation
      (data.new_messages || []).forEach(msg => {
        if (!isDuplicate(msg)) {
          M.msgs.push(msg);
          appendBubble(msg);
        }
      });

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
          showToast('New message from ' + (newFromOthers[0].user_name || 'a customer'));
        }
      }

      if (convListDirty || data.new_messages?.length) renderConvs();

      if (typeof data.total_unread === 'number') updatePageBadge(M.activePageId, data.total_unread);

      schedulePoll(3000);

    } catch (e) {
      console.error('[Messenger] poll error:', e);
      M.poll.failures++;
      schedulePoll(Math.min(3000 * (2 ** M.poll.failures), 30_000));
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
      showToast('Select a page and conversation first');
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
          M.renderedMsgIds.add(res.message_id);
        }
      }
      const entry = M.msgs.find(m => m._tempId === tempId);
      if (entry) { entry.message_id = res.message_id; entry._pending = false; delete entry._tempId; }

      const conv = M.convs.find(c => c.psid === M.activePsid);
      if (conv) { conv.lastMsg = text; conv.lastFromMe = true; conv.lastMsgAt = now; }
      renderConvs();

    } catch (e) {
      showToast('Send failed — tap Retry to try again');

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
    if (autoHide) setTimeout(() => { b.style.display = 'none'; }, 3000);
  }

  function hideSyncBanner() {
    const b = $('msngSyncBanner');
    if (b) b.style.display = 'none';
  }

  function showToast(msg) {
    const t = $('msngToast');
    if (!t) return;
    t.textContent = msg;
    t.classList.add('show');
    setTimeout(() => t.classList.remove('show'), 3000);
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
    if (_convListListener) listEl.removeEventListener('click', _convListListener);
    _convListListener = e => {
      const item = e.target.closest('[data-psid]');
      if (item) openConv(item.dataset.psid, item.dataset.name, item.dataset.pic, item.dataset.page);
    };
    listEl.addEventListener('click', _convListListener);
  }

  // ══════════════════════════════════════════════════════════
  // DATA LOADING
  // ══════════════════════════════════════════════════════════

  async function loadConvs(pageId) {
    showConvSkeleton();
    try {
      const data = await get('load_conversations', { page_id: pageId });
      if (data.error) throw new Error(data.error);
      M.convs = (data.conversations || []).map(c => ({
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
      renderConvs();
    } catch (e) {
      const listEl = $('msngConvList');
      if (listEl) listEl.innerHTML = `<div class="msng-empty">
        <i class="fa-solid fa-triangle-exclamation"></i>
        <p>Could not load conversations. Check network.</p>
      </div>`;
    }
  }

  async function loadMessages(before = null) {
    if (!M.activePageId || !M.activePsid) return;
    try {
      const data = await get('load_messages', {
        page_id: M.activePageId, psid: M.activePsid, limit: 50, before: before || '',
      });
      if (data.error) throw new Error(data.error);
      if (before) {
        M.msgs = [...(data.messages || []), ...M.msgs];
        renderMessages('prepend');
      } else {
        M.msgs          = data.messages || [];
        M.renderedMsgIds = new Set();
        renderMessages('replace');
      }
      if (M.msgs.length > 0) M.oldestMsgTime = M.msgs[0].created_at;
    } catch (e) {
      console.error('[Messenger] loadMessages:', e);
    }
  }

  async function openConv(psid, name, picture, pageId) {
    M.activePsid     = psid;
    M.activeConvName = name;
    M.activeConvPic  = picture;
    if (pageId) {
      M.activePageId = pageId;
      M.activeToken  = (M.pages.find(p => p.id === pageId) || {}).access_token || M.activeToken;
    }

    const conv = M.convs.find(c => c.psid === psid);
    if (conv) conv.unread = 0;
    renderConvs();

    showChatWindow(name, picture);
    M.msgs = []; M.renderedMsgIds = new Set(); M.oldestMsgTime = null;
    await loadMessages();
    post({ action: 'mark_read', page_id: M.activePageId, psid }).catch(() => {});

    $('msngMsgTextarea')?.focus();
    if (window.innerWidth <= 640) $('msngConvsCol')?.classList.add('slide-out');
  }

  // ══════════════════════════════════════════════════════════
  // PUBLIC API
  // Only expose what external code (HTML, web_ui.js) needs.
  // ══════════════════════════════════════════════════════════

  window.msngInit = function (retries = 0) {
    M.pages = (window.loadedPages || []).filter(p => p?.id && p?.access_token);
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
    const preferredId = window.currentPageId || M.pages[0].id;
    if (!M.activePageId || !M.pages.find(p => p.id === M.activePageId)) {
      window.msngSelectPage(preferredId);
    } else {
      renderConvs();
    }
    bindConvListDelegate();
    startPolling();
  };

  window.loadMessengerConversations = function () { window.msngInit(0); };

  window.msngSelectPage = function (pageId) {
    M.activePageId = pageId;
    M.activeToken  = (M.pages.find(p => p.id === pageId) || {}).access_token || null;
    M.activePsid   = null;
    showChatEmpty();
    loadConvs(pageId);
  };

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
    const btn = $('msngLoadMoreWrap');
    if (btn) btn.innerHTML = '<div class="msng-sk-line" style="width:120px;margin:auto"></div>';
    await loadMessages(M.oldestMsgTime);
    M.ui.loadingMore = false;
  };

  window.msngSyncNow = function () {
    if (!M.activePageId || !M.activeToken) { showToast('No page selected'); return; }
    showSyncBanner('Syncing from Facebook…');
    fetch('sync_history.php', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ page_id: M.activePageId, page_token: M.activeToken }),
    }).then(r => r.json()).then(d => {
      if (d.success) { showSyncBanner('Synced ' + d.synced + ' conversations', true); loadConvs(M.activePageId); }
      else hideSyncBanner();
    }).catch(hideSyncBanner);
  };

  window.msngRefresh = function () {
    if (!M.activePageId) return;
    const btn = $('msngRefreshBtn');
    if (btn) btn.classList.add('spinning');
    loadConvs(M.activePageId).finally?.(() => btn?.classList.remove('spinning'));
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
  });

  // ── Stop polling when messenger view is not active ───────────────────────────
  // Also toggle body.in-messenger so CSS can hide the outer pages sidebar
  // (the messenger has its own conversation list — no need for a second pages panel)
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
