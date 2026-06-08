/**
 * FBCast Pro — Server-backed user data (DB). Minimizes localStorage.
 */
(function (global) {
  'use strict';

  const state = {
    quota: { subscriptionStatus: 'free', messageLimit: 2000, messagesUsed: 0 },
    preferences: {
      notif_broadcast: true,
      notif_failed: true,
      default_delay_ms: 400,
      message_draft: ''
    },
    loaded: false
  };

  let _prefsSaveTimer = null;

  async function csrfHeaders() {
    const csrf = typeof global.getCsrfToken === 'function' ? await global.getCsrfToken() : '';
    const h = { 'Content-Type': 'application/json' };
    if (csrf) h['X-CSRF-Token'] = csrf;
    return h;
  }

  function applyQuota(raw) {
    if (!raw) return;
    state.quota = {
      subscriptionStatus: raw.subscriptionStatus || raw.plan || 'free',
      messageLimit: typeof raw.messageLimit === 'number' ? raw.messageLimit : 2000,
      messagesUsed: typeof raw.messagesUsed === 'number' ? raw.messagesUsed : 0,
      trialDaysLeft: raw.trialDaysLeft != null ? raw.trialDaysLeft : null,
      trialExpired: !!raw.trialExpired,
      onFreeTrial: !!raw.onFreeTrial,
      freeTrialExpiresAt: raw.freeTrialExpiresAt || null
    };
    if (typeof global.__setQuotaMemory === 'function') {
      global.__setQuotaMemory(state.quota);
    }
    try {
      global.dispatchEvent(new CustomEvent('fbc:quota-updated', { detail: state.quota }));
    } catch (_) {}
  }

  function applyPreferences(prefs) {
    if (!prefs) return;
    state.preferences = {
      notif_broadcast: prefs.notif_broadcast !== false,
      notif_failed: prefs.notif_failed !== false,
      default_delay_ms: Math.max(25, parseInt(prefs.default_delay_ms, 10) || 400),
      message_draft: prefs.message_draft || ''
    };
    try {
      global.dispatchEvent(new CustomEvent('fbc:preferences-loaded', { detail: state.preferences }));
    } catch (_) {}
  }

  /** Apply bootstrap or profile API payload */
  function applyServerPayload(data) {
    if (!data) return;
    if (data.quota) applyQuota(data.quota);
    if (data.preferences) applyPreferences(data.preferences);
    state.loaded = true;
  }

  async function fetchProfile() {
    try {
      const res = await fetch('/api/user/profile', { credentials: 'same-origin' });
      if (!res.ok) return false;
      const data = await res.json();
      applyServerPayload(data);
      return true;
    } catch (err) {
      console.warn('[UserData] fetchProfile failed', err);
      return false;
    }
  }

  async function savePreferences(patch) {
    applyPreferences({ ...state.preferences, ...patch });
    clearTimeout(_prefsSaveTimer);
    _prefsSaveTimer = setTimeout(async () => {
      try {
        const res = await fetch('/api/user/preferences', {
          method: 'PUT',
          credentials: 'same-origin',
          headers: await csrfHeaders(),
          body: JSON.stringify(state.preferences)
        });
        if (res.ok) {
          const data = await res.json();
          if (data.preferences) applyPreferences(data.preferences);
        }
      } catch (err) {
        console.warn('[UserData] savePreferences failed', err);
      }
    }, 400);
  }

  async function recordBroadcast(entry) {
    if (!entry) return;
    const sent = Number(entry.sent) || 0;
    const failed = Number(entry.failed) || 0;
    if (sent + failed === 0 && !entry.total) return;
    try {
      await fetch('/api/broadcasts/history', {
        method: 'POST',
        credentials: 'same-origin',
        headers: await csrfHeaders(),
        body: JSON.stringify({
          mode: entry.mode || 'manual',
          pageId: entry.pageId || entry.page_id,
          pages: entry.pages || 1,
          total: entry.total,
          sent,
          failed,
          message_preview: entry.label || entry.message_preview
        })
      });
    } catch (err) {
      console.warn('[UserData] recordBroadcast failed', err);
    }
  }

  async function fetchBroadcastHistory(days) {
    try {
      const res = await fetch(`/api/broadcasts/history?days=${days || 90}`, {
        credentials: 'same-origin'
      });
      if (!res.ok) return [];
      const data = await res.json();
      return data.history || [];
    } catch (_) {
      return [];
    }
  }

  /** One-time migrate old localStorage history to DB */
  async function migrateLocalHistoryOnce() {
    const key = 'fbcast_broadcast_history';
    const flag = 'fbcast_history_migrated';
    try {
      if (localStorage.getItem(flag) === '1') return;
      const raw = localStorage.getItem(key);
      if (!raw) {
        localStorage.setItem(flag, '1');
        return;
      }
      const list = JSON.parse(raw);
      if (!Array.isArray(list) || !list.length) {
        localStorage.removeItem(key);
        localStorage.setItem(flag, '1');
        return;
      }
      for (const item of list.slice(-40)) {
        await recordBroadcast({
          mode: item.mode,
          pageId: item.pageId,
          pages: item.pages,
          total: item.total,
          sent: item.sent,
          failed: item.failed,
          label: item.label
        });
      }
      localStorage.removeItem(key);
      localStorage.removeItem('fbcast_analytics_queue');
      localStorage.removeItem('fbcast_notif_prefs');
      localStorage.removeItem('fbcast_quota');
      localStorage.removeItem('fbcast_message_draft');
      localStorage.removeItem('fbcast_delay_draft');
      localStorage.setItem(flag, '1');
    } catch (_) {}
  }

  global.fbcastUserData = {
    getQuota: () => ({ ...state.quota }),
    getPreferences: () => ({ ...state.preferences }),
    applyServerPayload,
    fetchProfile,
    savePreferences,
    recordBroadcast,
    fetchBroadcastHistory,
    migrateLocalHistoryOnce
  };

  global.applyServerUserData = applyServerPayload;
})(window);
