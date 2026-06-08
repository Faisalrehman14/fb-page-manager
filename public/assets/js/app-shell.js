/**
 * FBCast Pro — App Shell / View Router
 * Central navigation, breadcrumbs, and view lifecycle for the dashboard.
 */
(function (global) {
  'use strict';

  let messengerScriptPromise = null;

  function assetVersion() {
    const probe = document.querySelector('script[src*="fb_api.js"]');
    if (!probe) return '';
    const m = probe.src.match(/[?&]v=([^&]+)/);
    return m ? m[1] : '';
  }

  function loadMessengerScript() {
    if (typeof global.msngInit === 'function') return Promise.resolve();
    if (messengerScriptPromise) return messengerScriptPromise;
    messengerScriptPromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      const v = assetVersion();
      s.src = 'assets/js/messenger.js' + (v ? '?v=' + encodeURIComponent(v) : '');
      s.defer = true;
      s.onload = () => resolve();
      s.onerror = () => {
        messengerScriptPromise = null;
        reject(new Error('Failed to load messenger.js'));
      };
      document.head.appendChild(s);
    });
    return messengerScriptPromise;
  }

  const VIEWS = {
    home: {
      label: 'Home',
      icon: 'fa-house',
      top: 'home',
      broadcastSub: null,
      hideSidebar: true,
      bodyClass: 'shell-home',
      onEnter() {
        if (typeof updateHomeViewStats === 'function') updateHomeViewStats();
        if (global.homeDashboard) global.homeDashboard.start();
      },
      onLeave() {
        if (global.homeDashboard) global.homeDashboard.stop();
      }
    },
    broadcast: {
      label: 'Broadcast',
      icon: 'fa-bullhorn',
      top: 'broadcast',
      broadcastSub: 'broadcast',
      hideSidebar: false,
      bodyClass: 'shell-broadcast'
    },
    messenger: {
      label: 'Messenger',
      icon: 'fa-facebook-messenger',
      top: 'messenger',
      broadcastSub: null,
      hideSidebar: true,
      bodyClass: 'shell-messenger',
      onEnter() {
        loadMessengerScript()
          .then(() => {
            if (typeof loadMessengerConversations === 'function') loadMessengerConversations();
          })
          .catch(() => {
            if (typeof showStatus === 'function') showStatus('Could not load Messenger. Refresh and try again.', 'error');
          });
      }
    },
    scheduling: {
      label: 'Scheduling',
      icon: 'fa-clock',
      top: 'broadcast',
      broadcastSub: 'scheduling',
      hideSidebar: false,
      bodyClass: 'shell-scheduling',
      onEnter() {
        const bar = document.getElementById('sidebarSchedBar');
        if (bar) bar.setAttribute('aria-hidden', 'false');
        if (typeof svInitSchedulingPageSelection === 'function') svInitSchedulingPageSelection();
        if (typeof svUpdateSidebarPageCount === 'function') svUpdateSidebarPageCount();
        if (typeof svSetMinDatetime === 'function') svSetMinDatetime();
        if (typeof svLoadSchedules === 'function') svLoadSchedules();
      },
      onLeave() {
        const bar = document.getElementById('sidebarSchedBar');
        if (bar) bar.setAttribute('aria-hidden', 'true');
        if (typeof svClearSchedulingPageSelection === 'function') svClearSchedulingPageSelection();
      }
    },
    analytics: {
      label: 'Analytics',
      icon: 'fa-chart-line',
      top: 'broadcast',
      broadcastSub: 'analytics',
      hideSidebar: false,
      onEnter() {
        if (typeof global.refreshAnalyticsDashboard === 'function') global.refreshAnalyticsDashboard();
      }
    },
    settings: {
      label: 'Settings',
      icon: 'fa-gear',
      top: 'broadcast',
      broadcastSub: 'settings',
      hideSidebar: false,
      onEnter() {
        if (typeof global.refreshBillingUI === 'function') global.refreshBillingUI();
      }
    },
    help: {
      label: 'Help',
      icon: 'fa-circle-question',
      top: 'broadcast',
      broadcastSub: 'help',
      hideSidebar: false
    }
  };

  let currentView = 'home';

  function $(id) {
    return document.getElementById(id);
  }

  const MORE_VIEWS = ['analytics', 'settings', 'help'];

  function setNavActive(view) {
    const isMoreView = MORE_VIEWS.includes(view);
    document.querySelectorAll('.nav-side-item[data-view]').forEach((el) => {
      el.classList.toggle('active', el.dataset.view === view);
      if (el.tagName === 'A') {
        el.setAttribute('aria-current', el.dataset.view === view ? 'page' : 'false');
      }
    });
    document.querySelectorAll('.app-mobile-nav__item[data-view]').forEach((el) => {
      const v = el.dataset.view;
      const on = v === view || (v === 'more' && isMoreView);
      el.classList.toggle('active', on);
      el.setAttribute('aria-current', on ? 'page' : 'false');
    });
    document.querySelectorAll('.app-mobile-more__action[data-view]').forEach((el) => {
      el.classList.toggle('active', el.dataset.view === view);
    });
    const moreBtn = $('appMobileNavMore');
    if (moreBtn) moreBtn.setAttribute('aria-expanded', isMoreView ? 'true' : 'false');
  }

  function setBreadcrumb(view) {
    const cfg = VIEWS[view];
    const labelEl = $('shellBreadcrumbLabel');
    if (labelEl && cfg) labelEl.textContent = cfg.label;
  }

  function showTopView(name, display) {
    const el = $('view-' + name);
    if (!el) return;
    if (name === 'messenger' || name === 'home') {
      el.style.display = display ? 'flex' : 'none';
    } else {
      el.style.display = display ? 'flex' : 'none';
    }
  }

  function showBroadcastChrome(showBroadcast) {
    const compose = document.querySelector('#view-broadcast .compose');
    const bcastCol = document.querySelector('#view-broadcast .broadcast-col');
    const statsPanel = document.querySelector('.stats-panel');
    if (compose) compose.style.display = showBroadcast ? '' : 'none';
    if (bcastCol) bcastCol.style.display = showBroadcast ? '' : 'none';
    if (statsPanel) statsPanel.style.display = showBroadcast ? '' : 'none';
  }

  function showBroadcastSubviews(activeSub) {
    ['scheduling', 'analytics', 'settings', 'help'].forEach((name) => {
      const el = $('view-' + name);
      if (!el) return;
      const on = activeSub === name;
      el.style.display = on ? 'flex' : 'none';
      el.classList.toggle('broadcast-subview', true);
      el.classList.toggle('is-active', on);
    });
  }

  function navigate(view) {
    if (!VIEWS[view]) view = 'home';
    closeMobileMore();
    const prev = VIEWS[currentView];
    const next = VIEWS[view];

    if (prev && prev.onLeave) prev.onLeave();
    document.body.classList.remove('shell-scheduling', 'shell-messenger', 'shell-broadcast', 'shell-home', 'in-messenger');
    if (next.bodyClass) document.body.classList.add(next.bodyClass);
    if (view === 'messenger') document.body.classList.add('in-messenger');

    currentView = view;
    setNavActive(view);
    setBreadcrumb(view);

    /* Hide/show pages column before swapping views to avoid horizontal reflow */
    const sidebar = document.querySelector('.sidebar');
    if (sidebar) sidebar.style.display = next.hideSidebar ? 'none' : '';

    const topSections = ['home', 'messenger', 'broadcast'];
    topSections.forEach((s) => {
      const show =
        s === next.top &&
        (s !== 'broadcast' || view === 'broadcast');
      showTopView(s, show);
    });

    const isManualBroadcast = view === 'broadcast';
    showBroadcastChrome(isManualBroadcast);
    showBroadcastSubviews(next.broadcastSub);

    if (next.onEnter) next.onEnter();

    if (view !== 'broadcast' && typeof showStatus === 'function') {
      showStatus('Viewing ' + next.label + '…', 'info');
    }
  }

  function closeMobileMore() {
    const sheet = $('appMobileMore');
    if (!sheet) return;
    sheet.classList.remove('open');
    sheet.setAttribute('aria-hidden', 'true');
    const moreBtn = $('appMobileNavMore');
    if (moreBtn) moreBtn.setAttribute('aria-expanded', 'false');
  }

  function openMobileMore() {
    const sheet = $('appMobileMore');
    if (!sheet) return;
    sheet.classList.add('open');
    sheet.setAttribute('aria-hidden', 'false');
    const moreBtn = $('appMobileNavMore');
    if (moreBtn) moreBtn.setAttribute('aria-expanded', 'true');
  }

  function initMobileNav() {
    document.querySelectorAll('.app-mobile-nav__item[data-view]').forEach((el) => {
      el.addEventListener('click', (e) => {
        e.preventDefault();
        const v = el.dataset.view;
        if (v === 'more') {
          openMobileMore();
          return;
        }
        closeMobileMore();
        navigate(v);
      });
    });

    const sheet = $('appMobileMore');
    const closeBtn = $('appMobileMoreClose');
    if (closeBtn) closeBtn.addEventListener('click', closeMobileMore);
    if (sheet) {
      sheet.addEventListener('click', (e) => {
        if (e.target === sheet) closeMobileMore();
      });
    }

    document.querySelectorAll('.app-mobile-more__action[data-view]').forEach((el) => {
      el.addEventListener('click', () => {
        closeMobileMore();
        navigate(el.dataset.view);
      });
    });

    const aiBtn = $('appMobileMoreAi');
    if (aiBtn) {
      aiBtn.addEventListener('click', () => {
        closeMobileMore();
        if (global.fbcastAI && typeof global.fbcastAI.toggle === 'function') global.fbcastAI.toggle();
      });
    }
    const supportBtn = $('appMobileMoreSupport');
    if (supportBtn) {
      supportBtn.addEventListener('click', () => {
        closeMobileMore();
        if (global.fbcastSupport && typeof global.fbcastSupport.open === 'function') global.fbcastSupport.open();
      });
    }

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') closeMobileMore();
    });
  }

  function initNav() {
    document.querySelectorAll('.nav-side-item[data-view]').forEach((el) => {
      el.addEventListener('click', (e) => {
        e.preventDefault();
        closeMobileMore();
        navigate(el.dataset.view);
      });
    });
    initMobileNav();
  }

  function persistBootstrapData(data) {
    if (!data || !data.authenticated) return false;
    try {
      if (data.token) {
        localStorage.setItem('fb_user_token', JSON.stringify({
          token: data.token,
          expiresAt: Date.now() + (data.expiresIn || 5184000) * 1000
        }));
      }
      if (data.userId) {
        localStorage.setItem('fbcast_user', JSON.stringify({
          fb_user_id: data.userId,
          fb_name: data.userName || ''
        }));
      }
      if (Array.isArray(data.pages) && data.pages.length) {
        localStorage.setItem('fb_pages', JSON.stringify(data.pages));
        if (typeof global.renderPages === 'function') global.renderPages(data.pages);
      }
      if (typeof global.applyServerUserData === 'function') {
        global.applyServerUserData({
          quota: data.quota,
          preferences: data.preferences
        });
      }
      if (typeof global.restoreComposerDraftFromServer === 'function') {
        global.restoreComposerDraftFromServer();
      }
      if (global.fbcastUserData && typeof global.fbcastUserData.migrateLocalHistoryOnce === 'function') {
        global.fbcastUserData.migrateLocalHistoryOnce();
      }
      global.dispatchEvent(new Event('fbcast:user-updated'));
    } catch (err) {
      console.warn('[AppShell] persistBootstrapData failed', err);
    }
    return true;
  }

  /** Show dashboard — must work before deferred index-page.js loads (OAuth popup). */
  function showDashboard() {
    const landing = $('landingPage');
    const app = $('appPage');
    document.documentElement.classList.remove('auth-booting');
    if (landing) {
      landing.style.display = 'none';
      landing.setAttribute('aria-hidden', 'true');
    }
    if (app) {
      app.style.display = 'flex';
      app.removeAttribute('aria-hidden');
    }
    document.body.style.overflow = 'hidden';
    document.body.classList.add('app-dashboard-active');

    try {
      navigate('home');
    } catch (err) {
      console.error('[AppShell] navigate failed:', err);
      const home = $('view-home');
      if (home) home.style.display = 'flex';
    }

    if (typeof global.applyTheme === 'function') global.applyTheme();

    try {
      const cached = JSON.parse(localStorage.getItem('fb_pages') || '[]');
      if (cached.length && typeof global.renderPages === 'function') {
        global.renderPages(cached);
      }
    } catch (_) {}
  }

  /** Hide dashboard and return to marketing landing page. */
  function showLandingPage() {
    const landing = $('landingPage');
    const app = $('appPage');
    document.documentElement.classList.remove('auth-booting');
    if (app) {
      app.style.display = 'none';
      app.setAttribute('aria-hidden', 'true');
    }
    if (landing) {
      landing.style.display = 'flex';
      landing.removeAttribute('aria-hidden');
    }
    document.body.style.overflow = '';
    document.body.classList.remove('app-dashboard-active', 'shell-scheduling', 'shell-messenger', 'shell-broadcast', 'in-messenger');

    if (global.homeDashboard && typeof global.homeDashboard.stop === 'function') {
      global.homeDashboard.stop();
    }

    const ls = document.getElementById('loginStatus');
    if (ls) ls.classList.remove('online');
    const lt = document.getElementById('loginStatusText');
    if (lt) lt.textContent = 'Not connected';
    const topName = document.getElementById('topbarUserName');
    if (topName) topName.textContent = 'Not connected';
  }

  async function bootstrapAuthFromServer() {
    try {
      const res = await fetch('/api/auth/bootstrap', { credentials: 'same-origin' });
      const body = await res.json();
      const ok = persistBootstrapData(body);
      if (ok && global.fbcastUserData && typeof global.fbcastUserData.fetchProfile === 'function') {
        await global.fbcastUserData.fetchProfile();
        if (typeof global.restoreComposerDraftFromServer === 'function') {
          global.restoreComposerDraftFromServer();
        }
      }
      return ok;
    } catch (err) {
      console.warn('[AppShell] bootstrapAuthFromServer failed', err);
      return false;
    }
  }

  async function completeOAuthReturn() {
    try { sessionStorage.removeItem('fbcast_oauth_pending'); } catch (_) {}
    const ok = await bootstrapAuthFromServer();
    if (!ok) {
      try {
        const st = await fetch('/api/auth/status', { credentials: 'same-origin' });
        const data = await st.json();
        if (!data.authenticated) {
          if (typeof global.showToast === 'function') {
            global.showToast('Facebook connected but session was not saved. Please try again.', 'error');
          }
          return;
        }
      } catch (_) {}
    }
    showDashboard();
    if (typeof global.refreshAuthUi === 'function') {
      await global.refreshAuthUi();
    } else if (typeof global.autoLoadPagesAfterLogin === 'function') {
      global.autoLoadPagesAfterLogin().catch(() => {});
    }
    if (typeof global.syncQuotaFromServer === 'function') {
      global.syncQuotaFromServer({ force: true, source: 'oauth_return', silent: true }).catch(() => {});
    }
    if (typeof global.runMetaReviewTests === 'function') {
      global.runMetaReviewTests().catch(() => {});
    }
    if (typeof global.showToast === 'function') {
      global.showToast('Facebook connected — welcome to your dashboard!', 'success');
    }
  }

  global.AppShell = {
    navigate,
    showDashboard,
    showLandingPage,
    bootstrapAuthFromServer,
    completeOAuthReturn,
    persistBootstrapData,
    getCurrentView: () => currentView,
    init() {
      initNav();
    }
  };

  global.switchDashboardView = navigate;
  global.showAppDashboard = showDashboard;
  global.showLandingPage = showLandingPage;
  global.bootstrapAuthFromServer = bootstrapAuthFromServer;

  function initTopbarUserMenu() {
    const cluster = document.getElementById('topbarUserCluster');
    const btn = document.getElementById('topbarUserBtn');
    const menu = document.getElementById('topbarUserMenu');
    if (!cluster || !btn || !menu) return;

    function closeMenu() {
      cluster.classList.remove('is-open');
      btn.setAttribute('aria-expanded', 'false');
      menu.hidden = true;
    }

    function openMenu() {
      cluster.classList.add('is-open');
      btn.setAttribute('aria-expanded', 'true');
      menu.hidden = false;
    }

    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (cluster.classList.contains('is-open')) closeMenu();
      else openMenu();
    });

    document.addEventListener('click', (e) => {
      if (!cluster.contains(e.target)) closeMenu();
    });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') closeMenu();
    });
  }

  document.addEventListener('DOMContentLoaded', () => {
    initNav();
    initTopbarUserMenu();
    try {
      const params = new URLSearchParams(window.location.search);
      const pendingOAuth = sessionStorage.getItem('fbcast_oauth_pending') === '1';
      if (params.get('fb_connected') === '1' || pendingOAuth) {
        window.history.replaceState({}, document.title, window.location.pathname);
        completeOAuthReturn();
        return;
      }
      const err = params.get('error');
      if (err) {
        window.history.replaceState({}, document.title, window.location.pathname);
        if (typeof global.showToast === 'function') {
          global.showToast(decodeURIComponent(err), 'error');
        }
      }
    } catch (_) {}
  });
})(window);
