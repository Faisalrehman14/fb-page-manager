/**
 * FBCast Pro — App-wide enhancements
 * Command palette, global keyboard shortcuts, broadcast safety guards.
 */
(function (global) {
  'use strict';

  const NAV_VIEWS = {
    h: 'home',
    b: 'broadcast',
    m: 'messenger',
    s: 'scheduling',
    a: 'analytics',
    g: 'settings'
  };

  let gPrefixAt = 0;
  let cmdkIndex = 0;
  let cmdkItems = [];

  function $(id) { return document.getElementById(id); }

  function isTypingTarget(el) {
    if (!el) return false;
    const tag = el.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
    if (el.isContentEditable) return true;
    return false;
  }

  function isDashboardActive() {
    const app = $('appPage');
    return app && app.style.display !== 'none' && !app.hasAttribute('aria-hidden');
  }

  function navigate(view) {
    if (typeof global.switchDashboardView === 'function') {
      global.switchDashboardView(view);
    } else if (global.AppShell && typeof global.AppShell.navigate === 'function') {
      global.AppShell.navigate(view);
    }
  }

  function toggleTheme() {
    if (typeof global.toggleAppTheme === 'function') {
      global.toggleAppTheme();
      return;
    }
    const isLight = document.body.classList.contains('light') ||
      document.documentElement.getAttribute('data-theme') === 'light';
    if (typeof global.setAppTheme === 'function') {
      global.setAppTheme(!isLight);
    }
  }

  function getPages() {
    try {
      return JSON.parse(localStorage.getItem('fb_pages') || '[]');
    } catch (_) {
      return [];
    }
  }

  function buildCommands(query) {
    const q = (query || '').trim().toLowerCase();
    const items = [];

    const views = [
      { id: 'nav-home', label: 'Go to Home', icon: 'fa-house', view: 'home', keys: 'G H' },
      { id: 'nav-broadcast', label: 'Go to Broadcast', icon: 'fa-bullhorn', view: 'broadcast', keys: 'G B' },
      { id: 'nav-messenger', label: 'Go to Messenger', icon: 'fa-facebook-messenger', view: 'messenger', keys: 'G M' },
      { id: 'nav-scheduling', label: 'Go to Scheduling', icon: 'fa-clock', view: 'scheduling', keys: 'G S' },
      { id: 'nav-analytics', label: 'Go to Analytics', icon: 'fa-chart-line', view: 'analytics', keys: 'G A' },
      { id: 'nav-settings', label: 'Go to Settings', icon: 'fa-gear', view: 'settings', keys: '' },
      { id: 'nav-help', label: 'Go to Help', icon: 'fa-circle-question', view: 'help', keys: '' }
    ];

    views.forEach((v) => {
      if (!q || v.label.toLowerCase().includes(q) || v.view.includes(q)) {
        items.push({ ...v, type: 'nav', run: () => navigate(v.view) });
      }
    });

    if (!q || 'theme'.includes(q) || 'dark'.includes(q) || 'light'.includes(q)) {
      items.push({
        id: 'act-theme',
        label: 'Toggle light / dark theme',
        icon: 'fa-circle-half-stroke',
        keys: 'Ctrl /',
        type: 'action',
        run: toggleTheme
      });
    }

    if (!q || 'shortcut'.includes(q) || 'keyboard'.includes(q) || 'help'.includes(q)) {
      items.push({
        id: 'act-kbd',
        label: 'Keyboard shortcuts',
        icon: 'fa-keyboard',
        keys: '?',
        type: 'action',
        run: openKbdHelp
      });
    }

    if (global.fbcastAI && (!q || 'ai'.includes(q) || 'assistant'.includes(q))) {
      items.push({
        id: 'act-ai',
        label: 'Open AI Assistant',
        icon: 'fa-wand-magic-sparkles',
        keys: '',
        type: 'action',
        run: () => global.fbcastAI.toggle && global.fbcastAI.toggle()
      });
    }

    if (global.fbcastSupport && (!q || 'support'.includes(q))) {
      items.push({
        id: 'act-support',
        label: 'Open Support chat',
        icon: 'fa-headset',
        keys: '',
        type: 'action',
        run: () => global.fbcastSupport.open && global.fbcastSupport.open()
      });
    }

    getPages().forEach((p) => {
      const name = (p.name || p.page_name || 'Page').trim();
      const id = p.id || p.page_id;
      if (!id) return;
      if (q && !name.toLowerCase().includes(q) && !String(id).includes(q)) return;
      items.push({
        id: 'page-' + id,
        label: 'Select page: ' + name,
        icon: 'fa-flag',
        meta: 'Broadcast',
        type: 'page',
        run: () => {
          navigate('broadcast');
          setTimeout(() => {
            const sel = $('pageSelect');
            if (sel) {
              sel.value = id;
              sel.dispatchEvent(new Event('change', { bubbles: true }));
            }
          }, 80);
        }
      });
    });

    return items;
  }

  function renderCmdkList(items) {
    const list = $('cmdkList');
    if (!list) return;
    cmdkItems = items;
    cmdkIndex = 0;

    if (!items.length) {
      list.innerHTML = '<div class="cmdk-empty">No results — try a view name or page title.</div>';
      return;
    }

    const groups = { nav: 'Navigate', page: 'Pages', action: 'Actions' };
    let html = '';
    ['nav', 'page', 'action'].forEach((type) => {
      const group = items.filter((i) => i.type === type);
      if (!group.length) return;
      html += '<div class="cmdk-group-label">' + groups[type] + '</div>';
      group.forEach((item, idx) => {
        const globalIdx = items.indexOf(item);
        html +=
          '<button type="button" class="cmdk-item' + (globalIdx === 0 ? ' is-active' : '') + '" data-idx="' + globalIdx + '">' +
          '<i class="fa-solid ' + item.icon + '"></i>' +
          '<span>' + item.label + '</span>' +
          (item.keys ? '<span class="cmdk-item-meta">' + item.keys + '</span>' : (item.meta ? '<span class="cmdk-item-meta">' + item.meta + '</span>' : '')) +
          '</button>';
      });
    });
    list.innerHTML = html;

    list.querySelectorAll('.cmdk-item').forEach((btn) => {
      btn.addEventListener('click', () => {
        const idx = parseInt(btn.dataset.idx, 10);
        runCmdkItem(idx);
      });
    });
  }

  function highlightCmdkItem(idx) {
    const list = $('cmdkList');
    if (!list) return;
    list.querySelectorAll('.cmdk-item').forEach((el, i) => {
      el.classList.toggle('is-active', i === idx);
      if (i === idx) el.scrollIntoView({ block: 'nearest' });
    });
  }

  function runCmdkItem(idx) {
    const item = cmdkItems[idx];
    if (!item || typeof item.run !== 'function') return;
    closeCmdk();
    item.run();
  }

  function openCmdk() {
    if (!isDashboardActive()) return;
    const overlay = $('cmdkOverlay');
    const input = $('cmdkInput');
    if (!overlay || !input) return;
    overlay.classList.add('is-open');
    overlay.setAttribute('aria-hidden', 'false');
    input.value = '';
    renderCmdkList(buildCommands(''));
    requestAnimationFrame(() => input.focus());
  }

  function closeCmdk() {
    const overlay = $('cmdkOverlay');
    if (!overlay) return;
    overlay.classList.remove('is-open');
    overlay.setAttribute('aria-hidden', 'true');
  }

  function openKbdHelp() {
    const overlay = $('kbdHelpOverlay');
    if (!overlay) return;
    overlay.classList.add('is-open');
    overlay.setAttribute('aria-hidden', 'false');
    $('kbdHelpClose')?.focus();
  }

  function closeKbdHelp() {
    const overlay = $('kbdHelpOverlay');
    if (!overlay) return;
    overlay.classList.remove('is-open');
    overlay.setAttribute('aria-hidden', 'true');
  }

  function onCmdkInput() {
    const input = $('cmdkInput');
    renderCmdkList(buildCommands(input ? input.value : ''));
  }

  function bindCmdk() {
    const overlay = $('cmdkOverlay');
    const input = $('cmdkInput');
    if (!overlay) return;

    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) closeCmdk();
    });

    input?.addEventListener('input', onCmdkInput);

    input?.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        cmdkIndex = Math.min(cmdkIndex + 1, cmdkItems.length - 1);
        highlightCmdkItem(cmdkIndex);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        cmdkIndex = Math.max(cmdkIndex - 1, 0);
        highlightCmdkItem(cmdkIndex);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        runCmdkItem(cmdkIndex);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        closeCmdk();
      }
    });

    $('kbdHelpOverlay')?.addEventListener('click', (e) => {
      if (e.target.id === 'kbdHelpOverlay') closeKbdHelp();
    });
    $('kbdHelpClose')?.addEventListener('click', closeKbdHelp);
  }

  function handleGlobalKeydown(e) {
    if (!isDashboardActive()) return;

    const mod = e.ctrlKey || e.metaKey;
    const key = e.key.toLowerCase();
    const active = document.activeElement;

    if (mod && key === 'k') {
      e.preventDefault();
      const overlay = $('cmdkOverlay');
      if (overlay && overlay.classList.contains('is-open')) closeCmdk();
      else openCmdk();
      return;
    }

    if (isTypingTarget(active) && !mod) return;

    if (mod && e.key === '/') {
      e.preventDefault();
      toggleTheme();
      return;
    }

    if (e.key === '?' && !mod && !e.altKey) {
      e.preventDefault();
      openKbdHelp();
      return;
    }

    if (key === 'escape') {
      if ($('cmdkOverlay')?.classList.contains('is-open')) { closeCmdk(); return; }
      if ($('kbdHelpOverlay')?.classList.contains('is-open')) { closeKbdHelp(); return; }
    }

    if (key === 'g' && !mod && !e.altKey) {
      gPrefixAt = Date.now();
      return;
    }

    if (Date.now() - gPrefixAt < 1200 && NAV_VIEWS[key]) {
      e.preventDefault();
      navigate(NAV_VIEWS[key]);
      gPrefixAt = 0;
    }
  }

  /** Returns { ok: true } or { ok: false, message } */
  function guardBroadcast(mode) {
    const settings = global.fbcastSettings;
    if (!settings) return { ok: true };

    if (typeof settings.isInQuietHours === 'function' && settings.isInQuietHours()) {
      if (mode === 'auto' || mode === 'scheduled') {
        return {
          ok: false,
          message: 'Auto broadcasts are blocked during quiet hours. Adjust in Settings → Sending Safety.'
        };
      }
    }

    const cfg = typeof settings.get === 'function' ? settings.get() : null;
    if (cfg && cfg.safety && cfg.safety.dailyCap > 0) {
      const sentToday = typeof global.getMessagesSentToday === 'function'
        ? global.getMessagesSentToday()
        : null;
      if (sentToday !== null && sentToday >= cfg.safety.dailyCap) {
        return {
          ok: false,
          message: 'Daily send cap reached (' + cfg.safety.dailyCap.toLocaleString() + '). Raise the limit in Settings or try again tomorrow.'
        };
      }
    }

    return { ok: true };
  }

  function syncNotifyToServer() {
    if (!global.fbcastSettings || !global.fbcastUserData) return;
    const n = global.fbcastSettings.get().notify;
    global.fbcastUserData.savePreferences({
      notif_broadcast: n.broadcast !== false,
      notif_failed: n.failed !== false
    });
  }

  function initNotifySync() {
    ['notifBroadcast', 'notifFailed'].forEach((id) => {
      const el = $(id);
      if (!el) return;
      el.addEventListener('change', syncNotifyToServer);
    });
    syncNotifyToServer();
  }

  function playNotifySound() {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.frequency.value = 880;
      gain.gain.value = 0.08;
      osc.start();
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.25);
      osc.stop(ctx.currentTime + 0.26);
    } catch (_) {}
  }

  function init() {
    bindCmdk();
    document.addEventListener('keydown', handleGlobalKeydown);

    global.fbcastGuardBroadcast = guardBroadcast;
    global.openCommandPalette = openCmdk;
    global.openKeyboardHelp = openKbdHelp;
    global.playNotifySound = playNotifySound;

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', initNotifySync);
    } else {
      initNotifySync();
    }
  }

  init();
})(window);
