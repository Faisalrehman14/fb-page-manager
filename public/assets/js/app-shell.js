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

  global.AppShell = {
    navigate,
    getCurrentView: () => currentView,
    init() {
      initNav();
    }
  };

  global.switchDashboardView = navigate;

  document.addEventListener('DOMContentLoaded', () => {
    initNav();
  });
})(window);
