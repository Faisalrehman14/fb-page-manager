/**
 * FBCast Pro — Pro SaaS UX (settings prefs from DB)
 */
(function (global) {
  'use strict';

  function initSettings() {
    const cbBroadcast = document.getElementById('notifBroadcast');
    const cbFailed = document.getElementById('notifFailed');

    function applyPrefs(prefs) {
      if (!prefs) return;
      if (cbBroadcast) cbBroadcast.checked = prefs.notif_broadcast !== false;
      if (cbFailed) cbFailed.checked = prefs.notif_failed !== false;
    }

    if (global.fbcastUserData) {
      applyPrefs(global.fbcastUserData.getPreferences());
    }

    global.addEventListener('fbc:preferences-loaded', (e) => {
      applyPrefs(e.detail);
    });

    function onPrefChange() {
      if (!global.fbcastUserData) return;
      global.fbcastUserData.savePreferences({
        notif_broadcast: cbBroadcast ? cbBroadcast.checked : true,
        notif_failed: cbFailed ? cbFailed.checked : true
      });
    }

    cbBroadcast?.addEventListener('change', onPrefChange);
    cbFailed?.addEventListener('change', onPrefChange);

    document.querySelectorAll('#view-settings .delay-opt').forEach((btn) => {
      btn.addEventListener('click', () => {
        const delay = parseInt(btn.getAttribute('data-delay') || '1200', 10);
        document.querySelectorAll('#view-settings .delay-opt').forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        const delayInput = document.getElementById('delayMs');
        if (delayInput) delayInput.value = String(delay);
        if (global.fbcastUserData) {
          global.fbcastUserData.savePreferences({ default_delay_ms: delay });
        }
      });
    });

    global.addEventListener('fbc:preferences-loaded', (e) => {
      const d = e.detail;
      if (!d) return;
      const active = String(d.default_delay_ms || 1200);
      document.querySelectorAll('#view-settings .delay-opt').forEach((b) => {
        b.classList.toggle('active', b.getAttribute('data-delay') === active);
      });
    });

    global.getNotifPrefs = function () {
      if (global.fbcastUserData) return global.fbcastUserData.getPreferences();
      return { notif_broadcast: true, notif_failed: true };
    };

    global.maybeNotifyBroadcast = function (type, message) {
      const p = global.getNotifPrefs();
      if (type === 'complete' && !p.notif_broadcast) return;
      if (type === 'failed' && !p.notif_failed) return;
      if (typeof global.showToast === 'function') global.showToast(message, type === 'failed' ? 'warning' : 'success');
      if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
        try {
          new Notification('FBCast Pro', { body: message, icon: '/images/castpro2.png' });
        } catch (_) {}
      }
    };

    if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
      cbBroadcast?.addEventListener('change', function requestOnce() {
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
    global.addEventListener('fbc:quota-updated', unlockPlanFeatures);
    setTimeout(unlockPlanFeatures, 1500);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})(window);
