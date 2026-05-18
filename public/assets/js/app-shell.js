/**
 * FBCast Pro — App Shell / View Router
 * Central navigation, breadcrumbs, and view lifecycle for the dashboard.
 */
(function (global) {
  'use strict';

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
      hideSidebar: false
    },
    messenger: {
      label: 'Messenger',
      icon: 'fa-facebook-messenger',
      top: 'messenger',
      broadcastSub: null,
      hideSidebar: false,
      bodyClass: 'shell-messenger',
      onEnter() {
        if (typeof loadMessengerConversations === 'function') loadMessengerConversations();
        document.body.classList.add('in-messenger');
      },
      onLeave() {
        document.body.classList.remove('in-messenger');
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
        if (typeof svPopulatePages === 'function') svPopulatePages();
        if (typeof svSetMinDatetime === 'function') svSetMinDatetime();
        if (typeof svLoadSchedules === 'function') svLoadSchedules();
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

  function setNavActive(view) {
    document.querySelectorAll('.nav-side-item').forEach((el) => {
      el.classList.toggle('active', el.dataset.view === view);
    });
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
    const prev = VIEWS[currentView];
    const next = VIEWS[view];

    if (prev && prev.onLeave) prev.onLeave();
    document.body.classList.remove('shell-scheduling', 'shell-messenger', 'shell-home', 'in-messenger');
    if (next.bodyClass) document.body.classList.add(next.bodyClass);

    currentView = view;
    setNavActive(view);
    setBreadcrumb(view);

    const topSections = ['home', 'messenger', 'broadcast'];
    topSections.forEach((s) => {
      const show = s === next.top || (s === 'broadcast' && next.top === 'broadcast');
      showTopView(s, show);
    });

    const isBroadcast = view === 'broadcast';
    showBroadcastChrome(isBroadcast);
    showBroadcastSubviews(next.broadcastSub);

    const sidebar = document.querySelector('.sidebar');
    if (sidebar) sidebar.style.display = next.hideSidebar ? 'none' : '';

    if (next.onEnter) next.onEnter();

    if (view !== 'broadcast' && typeof showStatus === 'function') {
      showStatus('Viewing ' + next.label + '…', 'info');
    }
  }

  function initNav() {
    document.querySelectorAll('.nav-side-item[data-view]').forEach((el) => {
      el.addEventListener('click', (e) => {
        e.preventDefault();
        navigate(el.dataset.view);
      });
    });
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
    if (typeof global.setLoginOnline === 'function') global.setLoginOnline();

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
    document.body.classList.remove('app-dashboard-active', 'shell-scheduling', 'shell-messenger', 'in-messenger');

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
    if (typeof global.autoLoadPagesAfterLogin === 'function') {
      global.autoLoadPagesAfterLogin().catch(() => {});
    }
    if (typeof global.syncQuotaFromServer === 'function') {
      global.syncQuotaFromServer({ force: true, source: 'oauth_return', silent: true }).catch(() => {});
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
