/**
 * FBCast Pro — Contact us / Live Messenger Chat
 *
 * Loads support config and embeds Facebook's Customer Chat Plugin (Messenger
 * Chat). User sees an inline chat window that uses their existing Facebook
 * identity; messages land in the admin's Facebook Page inbox natively.
 *
 * Sidebar "Contact us" button programmatically opens the chat dialog. If the
 * FB SDK or page is not whitelisted, falls back to opening the m.me link
 * inside our polished in-app modal.
 */
(function (global) {
  'use strict';

  const FALLBACK_EMAIL =
    (global.APP_CONFIG && global.APP_CONFIG.contactEmail) || 'support@castmepro.com';
  const FB_APP_ID = (global.APP_CONFIG && global.APP_CONFIG.fbAppId) || '';

  let cfg = null;
  let booted = false;
  let pluginInjected = false;
  let pluginReady = false;
  let pluginFailed = false;

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
      emailBtn.innerHTML = '<i class="fa-solid fa-envelope"></i> Email ' + email;
      emailBtn.hidden = false;
    } else {
      emailBtn.hidden = true;
    }
  }

  function openFallbackModal() {
    const overlay = $('supportOverlay');
    if (!overlay) return;
    applyConfigToModal();
    overlay.hidden = false;
    document.body.classList.add('no-scroll');
  }

  function closeFallbackModal() {
    const overlay = $('supportOverlay');
    if (!overlay) return;
    overlay.hidden = true;
    document.body.classList.remove('no-scroll');
  }

  function injectCustomerChat() {
    if (pluginInjected) return;
    if (!cfg || !cfg.page_id) return;
    if (!FB_APP_ID) return;
    pluginInjected = true;

    // <div id="fb-root">
    if (!document.getElementById('fb-root')) {
      const r = document.createElement('div');
      r.id = 'fb-root';
      document.body.appendChild(r);
    }

    // <div class="fb-customerchat" ...>
    const chat = document.createElement('div');
    chat.className = 'fb-customerchat';
    chat.setAttribute('page_id', cfg.page_id);
    chat.setAttribute('attribution', 'biz_inbox');
    chat.setAttribute('greeting_dialog_display', 'hide');
    chat.setAttribute('logged_in_greeting', 'Hi! How can we help?');
    chat.setAttribute('logged_out_greeting', 'Sign in to chat with us.');
    document.body.appendChild(chat);

    // FB SDK init
    global.fbAsyncInit = function () {
      try {
        global.FB.init({
          xfbml: true,
          version: 'v19.0',
          appId: FB_APP_ID
        });
        // The plugin renders asynchronously; mark ready after a short delay.
        setTimeout(() => {
          pluginReady = !!(global.FB && global.FB.CustomerChat);
        }, 1200);
      } catch (e) {
        pluginFailed = true;
      }
    };

    // Load SDK once
    if (!document.getElementById('facebook-jssdk')) {
      const js = document.createElement('script');
      js.id = 'facebook-jssdk';
      js.async = true;
      js.defer = true;
      js.crossOrigin = 'anonymous';
      js.src = 'https://connect.facebook.net/en_US/sdk/xfbml.customerchat.js';
      js.onerror = () => { pluginFailed = true; };
      document.body.appendChild(js);
    }
  }

  function tryShowChatDialog() {
    if (!global.FB || !global.FB.CustomerChat) return false;
    try {
      global.FB.CustomerChat.show(true);
      return true;
    } catch (_) {
      return false;
    }
  }

  function open() {
    loadConfig().then(() => {
      // No config at all → show fallback modal w/ email
      if (!cfg || (!cfg.page_id && !cfg.page_handle && !cfg.email)) {
        openFallbackModal();
        return;
      }
      // We have a page_id → use FB Customer Chat Plugin
      if (cfg.page_id && FB_APP_ID) {
        injectCustomerChat();
        // The SDK may take a moment to load. Try a few times.
        let attempts = 0;
        const tick = () => {
          if (pluginFailed) { openFallbackModal(); return; }
          if (tryShowChatDialog()) return;
          if (++attempts > 25) { openFallbackModal(); return; }
          setTimeout(tick, 250);
        };
        tick();
        return;
      }
      // Only a handle or email → open fallback modal
      openFallbackModal();
    });
  }

  function bindEvents() {
    const overlay = $('supportOverlay');
    if (overlay) {
      overlay.addEventListener('click', (e) => {
        if (e.target === overlay) closeFallbackModal();
      });
    }
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && overlay && !overlay.hidden) closeFallbackModal();
    });
    const btn = $('navContactBtn');
    if (btn) {
      btn.addEventListener('click', (e) => { e.preventDefault(); open(); });
    }
  }

  function showButton() {
    const btn = $('navContactBtn');
    if (btn) btn.style.display = '';
  }

  function init() {
    if (booted) return;
    if (!$('navContactBtn')) return;
    booted = true;
    bindEvents();
    showButton();
    loadConfig().then(() => {
      // Eagerly inject when we have everything needed so the dialog opens fast
      if (cfg && cfg.page_id && FB_APP_ID) injectCustomerChat();
    });
  }

  global.fbcastSupport = {
    open: open,
    close: closeFallbackModal,
    reload: () => loadConfig(true)
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})(window);
