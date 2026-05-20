/**
 * FBCast Pro — Support / Contact Us
 *
 * Loads support config from /api/support/info and wires the sidebar
 * "Contact us" button to open a Messenger chat with the configured
 * support Facebook Page (or fall back to email if no page is set).
 */
(function (global) {
  'use strict';

  const FALLBACK_EMAIL =
    (global.APP_CONFIG && global.APP_CONFIG.contactEmail) || 'support@castmepro.com';

  let cfg = null;
  let booted = false;

  function $(id) { return document.getElementById(id); }

  async function loadConfig(force) {
    if (cfg && !force) return cfg;
    try {
      const r = await fetch('/api/support/info', { credentials: 'same-origin' });
      if (!r.ok) throw new Error('http');
      cfg = await r.json();
    } catch (_) {
      cfg = { enabled: false };
    }
    return cfg;
  }

  function applyConfigToModal() {
    const nameEl = $('supportPageName');
    const subEl  = $('supportPageSub');
    const primary = $('supportPrimaryBtn');
    const pageBtn = $('supportPageBtn');
    const emailBtn = $('supportEmailBtn');
    const empty = $('supportEmptyMsg');
    const fallback = $('supportFallbackMail');
    if (!nameEl) return;

    if (!cfg || (!cfg.enabled && !cfg.email)) {
      nameEl.textContent = 'Support unavailable';
      subEl.textContent  = 'Please email us instead.';
      primary.style.display = 'none';
      pageBtn.hidden = true;
      empty.hidden = false;
      if (fallback) {
        fallback.textContent = FALLBACK_EMAIL;
        fallback.href = 'mailto:' + FALLBACK_EMAIL;
      }
      emailBtn.hidden = true;
      return;
    }

    empty.hidden = true;
    nameEl.textContent = cfg.page_name || cfg.page_handle || 'Support team';
    subEl.textContent  = cfg.page_handle
      ? '@' + cfg.page_handle + ' · Replies on Messenger'
      : 'Replies on Messenger';

    if (cfg.m_me_url) {
      primary.href = cfg.m_me_url;
      primary.style.display = '';
    } else {
      primary.style.display = 'none';
    }

    if (cfg.page_url) {
      pageBtn.href = cfg.page_url;
      pageBtn.hidden = false;
    } else {
      pageBtn.hidden = true;
    }

    const email = (cfg.email || '').trim();
    if (email) {
      emailBtn.href = 'mailto:' + email;
      emailBtn.querySelector('span, *') && (emailBtn.innerHTML = '<i class="fa-solid fa-envelope"></i> Email ' + email);
      emailBtn.hidden = false;
    } else {
      emailBtn.hidden = true;
    }
  }

  function showButton() {
    const btn = $('navContactBtn');
    if (!btn) return;
    // Always show the button — even if not configured we'll show email fallback in modal
    btn.style.display = '';
  }

  function open() {
    const overlay = $('supportOverlay');
    if (!overlay) return;
    loadConfig().then(() => {
      applyConfigToModal();
      overlay.hidden = false;
      document.body.classList.add('no-scroll');
    });
  }

  function close() {
    const overlay = $('supportOverlay');
    if (!overlay) return;
    overlay.hidden = true;
    document.body.classList.remove('no-scroll');
  }

  function bindEvents() {
    const overlay = $('supportOverlay');
    if (overlay) {
      overlay.addEventListener('click', (e) => {
        if (e.target === overlay) close();
      });
    }
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && overlay && !overlay.hidden) close();
    });
    const btn = $('navContactBtn');
    if (btn) {
      btn.addEventListener('click', (e) => { e.preventDefault(); open(); });
    }
  }

  function init() {
    if (booted) return;
    if (!$('navContactBtn')) return;
    booted = true;
    bindEvents();
    showButton();
    loadConfig();
  }

  global.fbcastSupport = {
    open: open,
    close: close,
    reload: () => loadConfig(true).then(applyConfigToModal)
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})(window);
