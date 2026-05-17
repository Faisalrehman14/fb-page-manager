/**
 * FBCast Pro — Pro SaaS UX (settings prefs, landing polish)
 */
(function (global) {
  'use strict';

  const NOTIF_KEY = 'fbcast_notif_prefs';

  function loadNotifPrefs() {
    try {
      return JSON.parse(localStorage.getItem(NOTIF_KEY) || '{}');
    } catch (_) {
      return {};
    }
  }

  function saveNotifPrefs(prefs) {
    try {
      localStorage.setItem(NOTIF_KEY, JSON.stringify(prefs));
    } catch (_) {}
  }

  function initSettings() {
    const prefs = Object.assign({ broadcast: true, failed: true }, loadNotifPrefs());
    const cbBroadcast = document.getElementById('notifBroadcast');
    const cbFailed = document.getElementById('notifFailed');
    if (cbBroadcast) {
      cbBroadcast.checked = prefs.broadcast !== false;
      cbBroadcast.addEventListener('change', () => {
        prefs.broadcast = cbBroadcast.checked;
        saveNotifPrefs(prefs);
      });
    }
    if (cbFailed) {
      cbFailed.checked = prefs.failed !== false;
      cbFailed.addEventListener('change', () => {
        prefs.failed = cbFailed.checked;
        saveNotifPrefs(prefs);
      });
    }

    global.getNotifPrefs = () => Object.assign({ broadcast: true, failed: true }, loadNotifPrefs());

    global.maybeNotifyBroadcast = function (type, message) {
      const p = global.getNotifPrefs();
      if (type === 'complete' && !p.broadcast) return;
      if (type === 'failed' && !p.failed) return;
      if (typeof global.showToast === 'function') global.showToast(message, type === 'failed' ? 'warning' : 'success');
      if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
        try {
          new Notification('FBCast Pro', { body: message, icon: '/images/castpro2.png' });
        } catch (_) {}
      }
    };

    if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
      document.getElementById('notifBroadcast')?.addEventListener('change', function requestOnce() {
        if (this.checked) Notification.requestPermission().catch(() => {});
        this.removeEventListener('change', requestOnce);
      });
    }
  }

  function initLandingNav() {
    const nav = document.querySelector('#landingPage .nav');
    if (!nav) return;
    const onScroll = () => {
      nav.classList.toggle('nav--scrolled', window.scrollY > 24);
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
  }

  function initSmoothAnchors() {
    document.querySelectorAll('#landingPage a[href^="#"]').forEach((a) => {
      a.addEventListener('click', (e) => {
        const id = a.getAttribute('href');
        if (!id || id === '#') return;
        const el = document.querySelector(id);
        if (!el) return;
        e.preventDefault();
        el.scrollIntoView({ behavior: 'smooth', block: 'start' });
        if (typeof global.closeMobileMenu === 'function') global.closeMobileMenu();
      });
    });
  }

  function unlockPlanFeatures() {
    const badge = document.getElementById('planBadge');
    const plan = (badge?.dataset?.plan || 'free').toLowerCase();
    const paid = plan === 'pro' || plan === 'basic' || plan === 'gold' || plan === 'sapphire' || plan === 'starter';
    if (!paid) return;
    document.querySelectorAll('.hv-plan-feat-locked').forEach((el) => {
      el.classList.remove('hv-plan-feat-locked');
      if (/advanced analytics/i.test(el.textContent)) {
        el.innerHTML = '<i class="fa-solid fa-check"></i> Advanced analytics';
      }
    });
  }

  function init() {
    initSettings();
    initLandingNav();
    initSmoothAnchors();
    document.addEventListener('fbc:quota-updated', unlockPlanFeatures);
    setTimeout(unlockPlanFeatures, 1500);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})(window);
