/**
 * SaaS billing — subscription status, checkout, customer portal
 */
(function (global) {
  'use strict';

  const ONBOARDING_KEY = 'fbcast_onboarding_done';

  async function fetchSubscription() {
    if (global.FBCastBillingStatus && typeof global.FBCastBillingStatus.fetch === 'function') {
      try {
        return await global.FBCastBillingStatus.fetch();
      } catch (_) { /* fallback */ }
    }
    const res = await fetch('/api/billing/subscription', { credentials: 'same-origin' });
    const body = await res.json();
    if (body.success === false) throw new Error(body.error?.message || 'Failed to load subscription');
    return body.data || body;
  }

  function formatPlanName(data) {
    if (data?.display?.badge) return data.display.badge;
    if (data?.planName) return data.planName;
    const plan = data?.plan || data?.subscription?.dbPlan || 'free';
    const names = {
      free: 'Free',
      basic: 'Bronze',
      pro: 'Silver',
      gold: 'Gold',
      sapphire: 'Sapphire',
      platinum: 'Platinum'
    };
    return names[plan] || (plan ? String(plan).charAt(0).toUpperCase() + String(plan).slice(1) : 'Free');
  }

  function renderBillingCard(data) {
    const planEl = document.getElementById('saasPlanName');
    const badgeEl = document.getElementById('saasPlanBadge');
    const usedEl = document.getElementById('saasMsgUsed');
    const limitEl = document.getElementById('saasMsgLimit');
    const remainEl = document.getElementById('saasMsgRemaining');
    const fillEl = document.getElementById('saasUsageFill');
    const expiresEl = document.getElementById('saasExpires');

    if (!planEl) return;

    const used = data.messagesUsed ?? data.entitlements?.messagesUsed ?? 0;
    const limit = data.messageLimit ?? data.entitlements?.messagesLimit ?? 2000;
    const remaining = data.remaining ?? data.entitlements?.messagesRemaining ?? Math.max(0, limit - used);
    const pct = limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 0;
    const planLabel = formatPlanName(data);

    planEl.textContent = planLabel;
    if (badgeEl) {
      badgeEl.textContent = planLabel;
      const isPaid = data.subscription?.status === 'active' || (data.plan && data.plan !== 'free');
      badgeEl.className = 'saas-plan-badge' + (isPaid ? ' saas-plan-badge--pro' : '');
    }
    if (usedEl) usedEl.textContent = used.toLocaleString();
    if (limitEl) limitEl.textContent = limit.toLocaleString();
    if (remainEl) remainEl.textContent = remaining.toLocaleString();
    if (fillEl) fillEl.style.width = pct + '%';
    if (expiresEl) {
      const renews = data.subscriptionExpires || data.subscription?.renewsAt;
      if (renews) {
        const d = new Date(renews);
        expiresEl.textContent = 'Renews ' + d.toLocaleDateString();
        expiresEl.style.display = '';
      } else if (data.trial?.active && data.trial.daysLeft != null) {
        expiresEl.textContent = data.trial.daysLeft === 1
          ? '1 day left in free trial'
          : `${data.trial.daysLeft} days left in free trial`;
        expiresEl.style.display = '';
      } else if (data.trial?.expired) {
        expiresEl.textContent = 'Free trial ended — upgrade to send';
        expiresEl.style.display = '';
      } else {
        expiresEl.textContent = data.plan === 'free' ? 'Upgrade for more messages' : '';
      }
    }

    const portalBtn = document.getElementById('saasManageBilling');
    const hasPortal = data.hasBillingPortal ?? data.subscription?.hasStripeSubscription;
    if (portalBtn) portalBtn.style.display = hasPortal ? '' : 'none';
  }

  async function refreshBillingUI() {
    try {
      const data = await fetchSubscription();
      renderBillingCard(data);
      if (global.FBCastBillingStatus && typeof global.FBCastBillingStatus.apply === 'function') {
        global.FBCastBillingStatus.apply(data);
      } else if (typeof global.saveQuota === 'function') {
        global.saveQuota({
          subscriptionStatus: data.subscriptionStatus || data.plan || 'free',
          messageLimit: data.messageLimit ?? data.entitlements?.messagesLimit,
          messagesUsed: data.messagesUsed ?? data.entitlements?.messagesUsed,
          trialDaysLeft: data.trialDaysLeft ?? data.trial?.daysLeft,
          trialExpired: data.trialExpired ?? data.trial?.expired,
          onFreeTrial: data.onFreeTrial ?? data.trial?.active,
          freeTrialExpiresAt: data.freeTrialExpiresAt || data.trial?.expiresAt
        });
      }
      if (typeof global.updateQuotaUI === 'function') global.updateQuotaUI();
      return data;
    } catch (e) {
      console.warn('[billing] refresh failed', e);
      return null;
    }
  }

  global.openBillingPortal = async function () {
    try {
      const csrf = typeof global.getCsrfToken === 'function' ? await global.getCsrfToken() : '';
      const res = await fetch('/api/billing/portal', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }
      });
      const data = await res.json();
      const payload = data.data || data;
      if (payload.url) {
        window.location.assign(payload.url);
        return;
      }
      throw new Error(data.error?.message || data.error || 'Could not open billing portal');
    } catch (e) {
      if (typeof global.showToast === 'function') global.showToast(e.message, 'error');
    }
  };

  global.showChangePassword = function () {
    global.openBillingPortal();
  };

  function bindBillingUI() {
    document.getElementById('saasUpgradeBtn')?.addEventListener('click', () => {
      if (typeof global.openUpgradeModal === 'function') global.openUpgradeModal();
      else if (typeof global.switchDashboardView === 'function') global.switchDashboardView('home');
    });
    document.getElementById('saasManageBilling')?.addEventListener('click', () => global.openBillingPortal());
    document.getElementById('saasRefreshBilling')?.addEventListener('click', () => refreshBillingUI());
  }

  function showOnboarding() {
    if (localStorage.getItem(ONBOARDING_KEY) === '1') return;
    if (!localStorage.getItem('fb_user_token')) return;

    const overlay = document.getElementById('saasOnboarding');
    if (!overlay) return;

    const steps = [
      { icon: 'fa-brands fa-facebook', title: 'Welcome to FBCast Pro', text: 'Your Facebook pages are connected. Let\'s set up your workspace in 3 quick steps.' },
      { icon: 'fa-solid fa-bullhorn', title: 'Send broadcasts', text: 'Reach everyone who messaged your page with personalized UTILITY messages.' },
      { icon: 'fa-brands fa-facebook-messenger', title: 'Manage inbox', text: 'Reply to customers in real-time from the unified Messenger inbox.' },
      { icon: 'fa-solid fa-chart-line', title: 'Track usage', text: 'Monitor your message quota and upgrade anytime from Settings → Billing.' }
    ];

    let idx = 0;
    const titleEl = document.getElementById('saasOnboardTitle');
    const textEl = document.getElementById('saasOnboardText');
    const iconEl = document.getElementById('saasOnboardIcon');
    const dots = overlay.querySelectorAll('.saas-onboarding__dot');
    const nextBtn = document.getElementById('saasOnboardNext');
    const skipBtn = document.getElementById('saasOnboardSkip');

    function renderStep() {
      const s = steps[idx];
      if (titleEl) titleEl.textContent = s.title;
      if (textEl) textEl.textContent = s.text;
      if (iconEl) iconEl.innerHTML = '<i class="' + s.icon + '"></i>';
      dots.forEach((d, i) => d.classList.toggle('is-active', i === idx));
      if (nextBtn) nextBtn.textContent = idx === steps.length - 1 ? 'Get started' : 'Next';
    }

    function close() {
      overlay.classList.remove('is-open');
      localStorage.setItem(ONBOARDING_KEY, '1');
    }

    nextBtn?.addEventListener('click', () => {
      if (idx < steps.length - 1) { idx++; renderStep(); }
      else close();
    });
    skipBtn?.addEventListener('click', close);

    renderStep();
    overlay.classList.add('is-open');
  }

  document.addEventListener('DOMContentLoaded', bindBillingUI);
  window.addEventListener('fbcast:user-updated', refreshBillingUI);
  window.addEventListener('fbc:billing-status', (e) => {
    if (e.detail) renderBillingCard(e.detail);
  });

  global.SaaSBilling = { refresh: refreshBillingUI, showOnboarding };
  global.refreshBillingUI = refreshBillingUI;

  const _origShow = global.showAppDashboard;
  if (typeof _origShow === 'function') {
    global.showAppDashboard = function () {
      try {
        _origShow.apply(this, arguments);
      } catch (err) {
        console.error('[billing] showAppDashboard failed:', err);
        if (global.AppShell && typeof global.AppShell.showDashboard === 'function') {
          global.AppShell.showDashboard();
        }
      }
      setTimeout(() => {
        refreshBillingUI().catch(() => {});
        try { showOnboarding(); } catch (_) {}
      }, 400);
    };
  }
})(window);
