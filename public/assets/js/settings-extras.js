/**
 * FBCast Pro — Settings extras
 *
 * Wires up Appearance, Sending Safety, Notifications, Profile, Data & Privacy,
 * and the keyboard-shortcut reference card. Persists to localStorage and
 * exposes window.fbcastSettings for read access by other modules.
 */
(function (global) {
  'use strict';

  const LS_KEY = 'fbcast.settings.v1';

  const DEFAULTS = {
    appearance: { theme: 'system', density: 'comfortable' },
    safety: { autoRetry: true, safeStop: false, dailyCap: 2000 },
    quiet:    { enabled: false, start: '22:00', end: '08:00' },
    notify:   { broadcast: true, failed: true, desktop: false, sound: false }
  };

  function $(id) { return document.getElementById(id); }

  function loadSettings() {
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (!raw) return JSON.parse(JSON.stringify(DEFAULTS));
      const parsed = JSON.parse(raw);
      return {
        appearance: { ...DEFAULTS.appearance, ...(parsed.appearance || {}) },
        safety:     { ...DEFAULTS.safety,     ...(parsed.safety     || {}) },
        quiet:      { ...DEFAULTS.quiet,      ...(parsed.quiet      || {}) },
        notify:     { ...DEFAULTS.notify,     ...(parsed.notify     || {}) }
      };
    } catch (_) {
      return JSON.parse(JSON.stringify(DEFAULTS));
    }
  }

  function saveSettings(s) {
    try { localStorage.setItem(LS_KEY, JSON.stringify(s)); } catch (_) {}
  }

  let state = loadSettings();

  function applyTheme(value) {
    const wantLight =
      value === 'light' ? true :
      value === 'dark'  ? false :
      window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches;
    if (typeof window.setAppTheme === 'function') {
      window.setAppTheme(wantLight);
    }
  }

  function applyDensity(value) {
    document.documentElement.setAttribute('data-density', value);
    document.body.classList.toggle('density-compact', value === 'compact');
  }

  function setSegmented(containerId, attr, value) {
    const c = $(containerId);
    if (!c) return;
    c.querySelectorAll('.seg-opt').forEach((b) => {
      b.classList.toggle('active', b.dataset[attr] === value);
    });
  }

  function bindSegmented(containerId, attr, onChange) {
    const c = $(containerId);
    if (!c) return;
    c.addEventListener('click', (e) => {
      const btn = e.target.closest('.seg-opt');
      if (!btn || !c.contains(btn)) return;
      const v = btn.dataset[attr];
      if (!v) return;
      c.querySelectorAll('.seg-opt').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      onChange(v);
    });
  }

  function bindCheckbox(id, getValue, setValue) {
    const el = $(id);
    if (!el) return;
    el.checked = !!getValue();
    el.addEventListener('change', () => {
      setValue(el.checked);
      saveSettings(state);
    });
  }

  function bindNumber(id, getValue, setValue) {
    const el = $(id);
    if (!el) return;
    el.value = getValue();
    el.addEventListener('change', () => {
      const v = Math.max(0, parseInt(el.value, 10) || 0);
      el.value = v;
      setValue(v);
      saveSettings(state);
    });
  }

  function bindTime(id, getValue, setValue) {
    const el = $(id);
    if (!el) return;
    el.value = getValue();
    el.addEventListener('change', () => {
      setValue(el.value);
      saveSettings(state);
    });
  }

  function refreshQuietDisabledState() {
    const enabled = !!state.quiet.enabled;
    ['settingQuietStart', 'settingQuietEnd'].forEach((id) => {
      const el = $(id);
      if (el) el.disabled = !enabled;
    });
  }

  function requestDesktopPermission() {
    if (!('Notification' in window)) return;
    if (Notification.permission === 'default') {
      try { Notification.requestPermission(); } catch (_) {}
    }
  }

  function loadProfile() {
    const nameEl = $('settingsProfileName');
    const metaEl = $('settingsProfileMeta');
    const avEl   = $('settingsProfileAvatar');
    const planEl = $('settingsProfilePlan');
    if (!nameEl) return;

    let name = '';
    let email = '';
    let avatar = '';
    let plan = 'Free';

    if (global.currentUser) {
      name   = global.currentUser.name  || global.currentUser.full_name || '';
      email  = global.currentUser.email || '';
      avatar = global.currentUser.picture || global.currentUser.avatar || '';
    }

    const navName  = document.getElementById('navUserName');
    const navMail  = document.getElementById('navUserEmail');
    const navAv    = document.getElementById('navUserAvatar');
    const planBadge = document.getElementById('saasPlanBadge');

    if (!name && navName)  name   = (navName.textContent || '').trim();
    if (!email && navMail) email  = (navMail.textContent || '').trim();
    if (!avatar && navAv && navAv.querySelector && navAv.querySelector('img')) {
      avatar = navAv.querySelector('img').src;
    }
    if (planBadge) plan = (planBadge.textContent || 'Free').trim();

    nameEl.textContent = name || 'Connected User';
    metaEl.textContent = email || 'No email on record';

    if (avatar && avEl) {
      avEl.innerHTML = `<img src="${avatar}" alt="" referrerpolicy="no-referrer" />`;
    } else if (avEl) {
      const initial = (name || 'U').trim().charAt(0).toUpperCase();
      avEl.innerHTML = `<span class="settings-profile-initial">${initial}</span>`;
    }

    if (planEl) {
      planEl.textContent = plan;
      planEl.dataset.plan = plan.toLowerCase();
    }
  }

  function bindClearCache() {
    const btn = $('settingsClearCache');
    if (!btn) return;
    btn.addEventListener('click', () => {
      if (!confirm('Clear local cache?\n\nThis removes UI preferences and any cached page lists from this browser. Server data and your account are not affected.')) return;
      const keep = ['fbcast_session', 'token']; // keep auth-ish keys to be safe
      const toRemove = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (!k) continue;
        if (keep.some((p) => k.toLowerCase().includes(p))) continue;
        toRemove.push(k);
      }
      toRemove.forEach((k) => localStorage.removeItem(k));
      if ('caches' in window) {
        caches.keys().then((ks) => ks.forEach((k) => caches.delete(k)));
      }
      alert('Local cache cleared. Reloading…');
      location.reload();
    });
  }

  function init() {
    setSegmented('settingsThemeSeg',   'theme',   state.appearance.theme);
    setSegmented('settingsDensitySeg', 'density', state.appearance.density);
    applyDensity(state.appearance.density);
    applyTheme(state.appearance.theme);
    if (state.appearance.theme === 'system' && window.matchMedia) {
      const mq = window.matchMedia('(prefers-color-scheme: light)');
      const onSys = () => {
        if (state.appearance.theme === 'system') applyTheme('system');
      };
      if (typeof mq.addEventListener === 'function') mq.addEventListener('change', onSys);
      else if (typeof mq.addListener === 'function') mq.addListener(onSys);
    }

    bindSegmented('settingsThemeSeg', 'theme', (v) => {
      state.appearance.theme = v;
      saveSettings(state);
      applyTheme(v);
    });
    bindSegmented('settingsDensitySeg', 'density', (v) => {
      state.appearance.density = v;
      saveSettings(state);
      applyDensity(v);
    });

    bindCheckbox('settingAutoRetry',
      () => state.safety.autoRetry,
      (v) => { state.safety.autoRetry = v; });
    bindCheckbox('settingSafeStop',
      () => state.safety.safeStop,
      (v) => { state.safety.safeStop = v; });
    bindNumber('settingDailyCap',
      () => state.safety.dailyCap,
      (v) => { state.safety.dailyCap = v; });

    bindCheckbox('settingQuietEnabled',
      () => state.quiet.enabled,
      (v) => { state.quiet.enabled = v; refreshQuietDisabledState(); });
    bindTime('settingQuietStart',
      () => state.quiet.start,
      (v) => { state.quiet.start = v; });
    bindTime('settingQuietEnd',
      () => state.quiet.end,
      (v) => { state.quiet.end = v; });
    refreshQuietDisabledState();

    bindCheckbox('notifBroadcast',
      () => state.notify.broadcast,
      (v) => { state.notify.broadcast = v; });
    bindCheckbox('notifFailed',
      () => state.notify.failed,
      (v) => { state.notify.failed = v; });
    bindCheckbox('notifDesktop',
      () => state.notify.desktop,
      (v) => { state.notify.desktop = v; if (v) requestDesktopPermission(); });
    bindCheckbox('notifSound',
      () => state.notify.sound,
      (v) => { state.notify.sound = v; });

    bindClearCache();

    setTimeout(loadProfile, 200);
    setTimeout(loadProfile, 1500);
    setTimeout(loadProfile, 4000);
  }

  global.fbcastSettings = {
    get: () => JSON.parse(JSON.stringify(state)),
    save: () => saveSettings(state),
    reload: () => { state = loadSettings(); init(); },
    isInQuietHours: function () {
      if (!state.quiet.enabled) return false;
      const now = new Date();
      const cur = now.getHours() * 60 + now.getMinutes();
      const [sh, sm] = state.quiet.start.split(':').map(Number);
      const [eh, em] = state.quiet.end.split(':').map(Number);
      const start = sh * 60 + sm;
      const end   = eh * 60 + em;
      return start <= end ? (cur >= start && cur < end) : (cur >= start || cur < end);
    }
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})(window);
