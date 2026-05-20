/**
 * FBCast Pro — AI Broadcast Assistant widget client.
 *
 * Floating right-anchored chat that streams responses from the server
 * proxy at POST /api/ai/chat. Each assistant message gets action buttons
 * to copy the text or push it straight into the broadcast composer
 * (#messageText) or scheduling composer (#svMessage).
 */
(function (global) {
  'use strict';

  const state = {
    booted: false,
    open: false,
    enabled: null,
    messages: [],     // { role: 'user'|'assistant', content: string, _streaming?: bool, _error?: string }
    streaming: false,
    abortController: null
  };

  function $(id) { return document.getElementById(id); }
  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function humanizeAiError(msg) {
    const s = String(msg || '').trim();
    if (!s) return 'Something went wrong. Please try again.';
    if (/FreeUsageLimitError|rate limit exceeded|HTTP 429/i.test(s)) {
      return 'Free AI plan limit reached. Wait a few minutes, then try again. For heavy use, switch to a paid API key or model in server settings.';
    }
    if (/AI service error \(HTTP 429\)/i.test(s)) {
      return 'AI rate limit reached. Please wait a few minutes and try again.';
    }
    if (s.startsWith('{') || s.includes('"type":"error"')) {
      try {
        const j = JSON.parse(s.replace(/^AI service error \(HTTP \d+\)\.\s*/i, ''));
        const m = j?.error?.message || j?.message;
        if (m) return humanizeAiError(m);
      } catch (_) {}
      return 'AI service is busy. Please wait a moment and try again.';
    }
    if (/AI service error \(HTTP/i.test(s)) {
      return s.replace(/^AI service error \(HTTP \d+\)\.\s*/i, '').slice(0, 280) || 'AI service error. Please try again.';
    }
    return s.slice(0, 400);
  }

  async function checkEnabled() {
    if (state.enabled !== null) return state.enabled;
    try {
      const r = await fetch('/api/ai/info', { credentials: 'same-origin' });
      if (!r.ok) { state.enabled = false; return false; }
      const d = await r.json();
      state.enabled = !!d.enabled;
      state.freeTier = !!d.freeTier;
      state.model = d.model || '';
    } catch (_) {
      state.enabled = false;
    }
    return state.enabled;
  }

  function autoGrow(el) {
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(140, el.scrollHeight) + 'px';
    const sendBtn = $('aiwSend');
    if (sendBtn) sendBtn.disabled = !el.value.trim() || state.streaming;
  }

  function renderMessages() {
    const box = $('aiwMessages');
    const welcome = $('aiwWelcome');
    if (!box) return;
    if (!state.messages.length) {
      box.innerHTML = '';
      if (welcome) welcome.style.display = '';
      return;
    }
    if (welcome) welcome.style.display = 'none';

    const parts = [];
    state.messages.forEach((m, idx) => {
      if (m.role === 'user') {
        parts.push(`
          <div class="aiw__msg aiw__msg--user">
            <div class="aiw__bubble">${escapeHtml(m.content)}</div>
          </div>`);
      } else {
        const content = m._error
          ? `<div class="aiw__error"><i class="fa-solid fa-triangle-exclamation"></i> ${escapeHtml(m._error)}</div>`
          : escapeHtml(m.content) + (m._streaming ? '<span class="aiw__cursor"></span>' : '');
        const showActions = !m._streaming && !m._error && (m.content || '').trim();
        parts.push(`
          <div class="aiw__msg aiw__msg--assistant" data-idx="${idx}">
            <div class="aiw__msg-row">
              <div class="aiw__avatar"><i class="fa-solid fa-wand-magic-sparkles"></i></div>
              <div class="aiw__bubble">${content}</div>
            </div>
            ${showActions ? `
              <div class="aiw__msg-actions">
                <button class="aiw__act-btn aiw__act-btn--primary" data-action="use" data-idx="${idx}" title="Paste into broadcast composer">
                  <i class="fa-solid fa-arrow-up-right-from-square"></i> Use in Broadcast
                </button>
                <button class="aiw__act-btn" data-action="copy" data-idx="${idx}">
                  <i class="fa-regular fa-copy"></i> Copy
                </button>
                <button class="aiw__act-btn" data-action="regen" data-idx="${idx}">
                  <i class="fa-solid fa-rotate"></i> Regenerate
                </button>
              </div>` : ''}
          </div>`);
      }
    });
    box.innerHTML = parts.join('');
    box.scrollTop = box.scrollHeight;
  }

  function updateStreamingBubble() {
    // Light-touch update: rewrite only the last assistant bubble while streaming
    const box = $('aiwMessages');
    if (!box) return;
    const last = state.messages[state.messages.length - 1];
    if (!last || last.role !== 'assistant' || !last._streaming) return;
    const node = box.querySelector(`.aiw__msg[data-idx="${state.messages.length - 1}"] .aiw__bubble`);
    if (node) {
      node.innerHTML = escapeHtml(last.content) + '<span class="aiw__cursor"></span>';
      box.scrollTop = box.scrollHeight;
    }
  }

  async function sendMessage(text) {
    text = String(text || '').trim();
    if (!text || state.streaming) return;

    state.streaming = true;
    state.messages.push({ role: 'user', content: text });
    state.messages.push({ role: 'assistant', content: '', _streaming: true });
    renderMessages();

    const sendBtn = $('aiwSend');
    if (sendBtn) sendBtn.disabled = true;
    const input = $('aiwInput');
    if (input) { input.value = ''; autoGrow(input); }

    const controller = new AbortController();
    state.abortController = controller;
    const lastIdx = state.messages.length - 1;

    try {
      // Only forward role + content for safety
      const payload = state.messages
        .filter(m => m.role && m.content !== undefined)
        .map(m => ({ role: m.role, content: m.content }));
      // Drop the empty trailing assistant placeholder
      if (payload.length && payload[payload.length - 1].role === 'assistant' && !payload[payload.length - 1].content) {
        payload.pop();
      }

      const r = await fetch('/api/ai/chat', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: payload }),
        signal: controller.signal
      });

      if (!r.ok) {
        let msg = 'HTTP ' + r.status;
        try { const t = await r.text(); if (t) msg = t.slice(0, 240); } catch (_) {}
        throw new Error(msg);
      }
      if (!r.body || !r.body.getReader) throw new Error('Browser does not support streaming');

      const reader = r.body.getReader();
      const decoder = new TextDecoder('utf-8');
      let buf = '';

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });

        let idx;
        while ((idx = buf.indexOf('\n\n')) !== -1) {
          const frame = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const parsed = parseSseFrame(frame);
          if (!parsed) continue;
          if (parsed.event === 'token' && parsed.data?.text) {
            state.messages[lastIdx].content += parsed.data.text;
            updateStreamingBubble();
          } else if (parsed.event === 'error') {
            const errMsg = humanizeAiError((parsed.data && parsed.data.message) || 'Stream error');
            state.messages[lastIdx]._error = errMsg;
            state.messages[lastIdx]._errorCode = parsed.data?.code || '';
            state.messages[lastIdx]._streaming = false;
            renderMessages();
          } else if (parsed.event === 'done') {
            state.messages[lastIdx]._streaming = false;
          }
        }
      }

      state.messages[lastIdx]._streaming = false;
      if (!state.messages[lastIdx].content && !state.messages[lastIdx]._error) {
        state.messages[lastIdx]._error = 'No response. Please try again.';
      }
      renderMessages();
    } catch (e) {
      if (e.name === 'AbortError') {
        state.messages[lastIdx]._streaming = false;
        if (!state.messages[lastIdx].content) state.messages[lastIdx]._error = 'Generation stopped.';
      } else {
        state.messages[lastIdx]._streaming = false;
        state.messages[lastIdx]._error = humanizeAiError(e.message || 'Network error');
      }
      renderMessages();
    } finally {
      state.streaming = false;
      state.abortController = null;
      if (sendBtn) sendBtn.disabled = false;
      if (input) input.focus();
    }
  }

  function parseSseFrame(frame) {
    let event = 'message';
    const dataLines = [];
    for (const line of frame.split('\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
    }
    if (!dataLines.length) return null;
    const dataStr = dataLines.join('\n');
    try { return { event, data: JSON.parse(dataStr) }; }
    catch (_) { return { event, data: dataStr }; }
  }

  function pasteIntoBroadcast(text) {
    if (!text) return false;
    // Try main broadcast composer first, then scheduling composer
    const targets = ['messageText', 'svMessage'];
    let pasted = false;
    for (const id of targets) {
      const el = document.getElementById(id);
      if (el && (el.offsetParent !== null || el.value !== undefined)) {
        el.value = text;
        try { el.dispatchEvent(new Event('input', { bubbles: true })); } catch (_) {}
        try { el.dispatchEvent(new Event('change', { bubbles: true })); } catch (_) {}
        pasted = true;
        // If this textarea is visible, focus & scroll to it
        if (el.offsetParent !== null) {
          el.focus();
          el.scrollIntoView({ behavior: 'smooth', block: 'center' });
          break;
        }
      }
    }
    return pasted;
  }

  function copyToClipboard(text) {
    if (!text) return Promise.resolve(false);
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text).then(() => true).catch(() => fallback());
    }
    return Promise.resolve(fallback());

    function fallback() {
      try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        const ok = document.execCommand('copy');
        document.body.removeChild(ta);
        return ok;
      } catch (_) { return false; }
    }
  }

  function toast(message, type) {
    try {
      const fn = global.showNotification || global.showToast;
      if (typeof fn === 'function') fn(message, type || 'success');
    } catch (_) {}
  }

  function handleActionClick(e) {
    const btn = e.target.closest('.aiw__act-btn');
    if (!btn) return;
    const action = btn.getAttribute('data-action');
    const idx = parseInt(btn.getAttribute('data-idx'), 10);
    const msg = state.messages[idx];
    if (!msg || msg.role !== 'assistant') return;

    if (action === 'use') {
      const ok = pasteIntoBroadcast(msg.content);
      toast(ok ? 'Pasted into broadcast composer' : 'Copied — paste in the composer', ok ? 'success' : 'info');
      if (ok) setTimeout(closeWidget, 220);
    } else if (action === 'copy') {
      copyToClipboard(msg.content).then(ok => {
        toast(ok ? 'Copied to clipboard' : 'Copy failed', ok ? 'success' : 'error');
      });
    } else if (action === 'regen') {
      // Find the preceding user message and regenerate from it
      let userIdx = idx - 1;
      while (userIdx >= 0 && state.messages[userIdx].role !== 'user') userIdx--;
      if (userIdx < 0) return;
      // Truncate after the user message and resend
      const userText = state.messages[userIdx].content;
      state.messages = state.messages.slice(0, userIdx);
      renderMessages();
      sendMessage(userText);
    }
  }

  function handleChipClick(e) {
    const chip = e.target.closest('.aiw__chip');
    if (!chip) return;
    const prompt = chip.getAttribute('data-prompt') || chip.textContent.trim();
    const input = $('aiwInput');
    if (input) { input.value = prompt; autoGrow(input); }
    sendMessage(prompt);
  }

  function newConversation() {
    if (state.streaming && state.abortController) {
      try { state.abortController.abort(); } catch (_) {}
    }
    state.messages = [];
    renderMessages();
    const input = $('aiwInput');
    if (input) { input.value = ''; autoGrow(input); input.focus(); }
  }

  function openWidget() {
    const w = $('aiWidget');
    if (!w) return;
    checkEnabled().then(enabled => {
      if (!enabled) {
        toast('AI Assistant is not configured on the server.', 'error');
        return;
      }
      w.hidden = false;
      w.setAttribute('aria-hidden', 'false');
      requestAnimationFrame(() => w.classList.add('aiw--open'));
      state.open = true;
      const input = $('aiwInput');
      if (input) setTimeout(() => input.focus(), 220);
    });
  }

  function closeWidget() {
    const w = $('aiWidget');
    if (!w) return;
    w.classList.remove('aiw--open');
    state.open = false;
    setTimeout(() => {
      if (!state.open) {
        w.hidden = true;
        w.setAttribute('aria-hidden', 'true');
      }
    }, 240);
  }

  function toggleWidget() { state.open ? closeWidget() : openWidget(); }

  function bindEvents() {
    const closeBtn = $('aiwClose');
    if (closeBtn) closeBtn.addEventListener('click', closeWidget);
    const clearBtn = $('aiwClear');
    if (clearBtn) clearBtn.addEventListener('click', newConversation);

    const form = $('aiwForm');
    const input = $('aiwInput');
    if (input) {
      input.addEventListener('input', () => autoGrow(input));
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          const v = input.value.trim();
          if (v) sendMessage(v);
        }
      });
    }
    if (form) {
      form.addEventListener('submit', (e) => {
        e.preventDefault();
        if (!input) return;
        const v = input.value.trim();
        if (v) sendMessage(v);
      });
    }

    const chips = $('aiwChips');
    if (chips) chips.addEventListener('click', handleChipClick);

    const messages = $('aiwMessages');
    if (messages) messages.addEventListener('click', handleActionClick);

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && state.open) closeWidget();
    });
  }

  function boot() {
    if (state.booted) return;
    if (!$('navAiBtn') || !$('aiWidget')) return;
    state.booted = true;
    bindEvents();
    checkEnabled().then(enabled => {
      const btn = $('navAiBtn');
      if (!enabled && btn) btn.style.display = 'none';
    });
  }

  function init() {
    const appPage = document.getElementById('appPage');
    if (!appPage || appPage.style.display === 'none' || appPage.hidden) {
      if (typeof global.showAppDashboard === 'function') {
        const orig = global.showAppDashboard;
        global.showAppDashboard = function () {
          const r = orig.apply(this, arguments);
          setTimeout(boot, 120);
          return r;
        };
      }
      if (appPage) {
        const obs = new MutationObserver(() => {
          if (appPage.style.display !== 'none' && !appPage.hidden) {
            boot();
            obs.disconnect();
          }
        });
        obs.observe(appPage, { attributes: true, attributeFilter: ['style', 'hidden'] });
      }
      return;
    }
    boot();
  }

  global.fbcastAI = {
    open: openWidget,
    close: closeWidget,
    toggle: toggleWidget,
    send: sendMessage,
    reset: newConversation
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})(window);
