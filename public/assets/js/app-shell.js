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
      hideSidebar: false,
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
      hideSidebar: true,
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
      hideSidebar: false
    },
    settings: {
      label: 'Settings',
      icon: 'fa-gear',
      top: 'broadcast',
      broadcastSub: 'settings',
      hideSidebar: false
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
    document.body.classList.remove('shell-scheduling', 'shell-messenger', 'in-messenger');
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

  /** Show dashboard — must work before deferred index-page.js loads (OAuth popup). */
  function showDashboard() {
    const landing = $('landingPage');
    const app = $('appPage');
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

  global.AppShell = {
    navigate,
    showDashboard,
    showLandingPage,
    getCurrentView: () => currentView,
    init() {
      initNav();
    }
  };

  global.switchDashboardView = navigate;
  global.showAppDashboard = showDashboard;
  global.showLandingPage = showLandingPage;

  document.addEventListener('DOMContentLoaded', () => {
    initNav();
    try {
      const params = new URLSearchParams(window.location.search);
      if (params.get('fb_connected') === '1') {
        window.history.replaceState({}, document.title, window.location.pathname);
        showDashboard();
      }
      const err = params.get('error');
      if (err && typeof global.showToast === 'function') {
        global.showToast(decodeURIComponent(err), 'error');
      }
    } catch (_) {}
  });
})(window);
