/**
 * Canonical billing / entitlement client — uses GET /api/billing/status
 */
(function (global) {
  'use strict';

  function unwrap(body) {
    if (!body) return null;
    if (body.data != null && body.success !== false) return body.data;
    if (body.success === true && (body.entitlements || body.messageLimit != null)) return body;
    return body;
  }

  function applyBillingPayload(data) {
    if (!data) return;
    const payload = {
      subscriptionStatus: data.subscriptionStatus || data.plan || 'free',
      messageLimit: data.messageLimit ?? data.entitlements?.messagesLimit,
      messagesUsed: data.messagesUsed ?? data.entitlements?.messagesUsed,
      trialDaysLeft: data.trialDaysLeft ?? data.trial?.daysLeft ?? null,
      trialExpired: !!(data.trialExpired ?? data.trial?.expired),
      onFreeTrial: !!(data.onFreeTrial ?? data.trial?.active),
      freeTrialExpiresAt: data.freeTrialExpiresAt || data.trial?.expiresAt || null,
      plan: data.plan || data.subscription?.dbPlan || 'free'
    };
    if (typeof global.saveQuota === 'function') global.saveQuota(payload);
    if (typeof global.updateQuotaUI === 'function') global.updateQuotaUI();
    try {
      global.dispatchEvent(new CustomEvent('fbc:billing-status', { detail: data }));
    } catch (_) {}
  }

  async function fetchBillingStatus() {
    const res = await fetch('/api/billing/status', { credentials: 'same-origin', cache: 'no-store' });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || body.success === false) {
      const msg = body.error?.message || body.error || 'Failed to load billing status';
      const err = new Error(typeof msg === 'string' ? msg : 'Failed to load billing status');
      err.status = res.status;
      throw err;
    }
    return unwrap(body);
  }

  async function syncBillingFromStripe() {
    const csrf = typeof global.getCsrfToken === 'function' ? await global.getCsrfToken() : '';
    const res = await fetch('/api/billing/sync', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || body.success === false) {
      throw new Error(body.error?.message || body.error || 'Billing sync failed');
    }
    return unwrap(body);
  }

  /**
   * @param {{ syncStripe?: boolean, retries?: number }} opts
   */
  async function refreshBillingStatus(opts = {}) {
    const retries = Math.max(1, opts.retries || 1);
    let lastErr = null;
    for (let attempt = 0; attempt < retries; attempt++) {
      try {
        if (opts.syncStripe && attempt > 0) {
          try { await syncBillingFromStripe(); } catch (e) { console.warn('[billing-status] stripe sync', e); }
        }
        const data = await fetchBillingStatus();
        applyBillingPayload(data);
        return data;
      } catch (e) {
        lastErr = e;
        if (e.status === 401) throw e;
        if (attempt < retries - 1) {
          await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
        }
      }
    }
    throw lastErr || new Error('Billing status unavailable');
  }

  global.FBCastBillingStatus = {
    fetch: fetchBillingStatus,
    sync: syncBillingFromStripe,
    refresh: refreshBillingStatus,
    apply: applyBillingPayload,
    unwrap
  };
})(window);
