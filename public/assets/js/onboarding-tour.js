/**
 * FBCast Pro — Interactive first-login onboarding walkthrough
 */
(function (global) {
  'use strict';

  const LS_KEY = 'fbcast_onboarding_v2_done';
  const NAV_MAP = {
    home: ['#navItemHome', '.app-mobile-nav__item[data-view="home"]'],
    broadcast: ['#navItemBroadcast', '.app-mobile-nav__item[data-view="broadcast"]'],
    messenger: ['#navItemMessenger', '.app-mobile-nav__item[data-view="messenger"]'],
    scheduling: ['#navItemScheduling', '.app-mobile-nav__item[data-view="scheduling"]'],
    analytics: ['#navItemAnalytics', '.app-mobile-more__action[data-view="analytics"]'],
    settings: ['#navItemSettings', '.app-mobile-more__action[data-view="settings"]'],
    help: ['.app-mobile-more__action[data-view="help"]']
  };

  let active = false;
  let idx = 0;
  let steps = [];
  let root = null;
  let ring = null;
  let card = null;
  let resizeObs = null;
  let accountKey = '';

  function $(sel, ctx) {
    return (ctx || document).querySelector(sel);
  }

  function isVisible(el) {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 1 && r.height < 1) return false;
    const st = getComputedStyle(el);
    return st.display !== 'none' && st.visibility !== 'hidden' && st.opacity !== '0';
  }

  function resolveTarget(selectors) {
    const list = Array.isArray(selectors) ? selectors : [selectors];
    for (const sel of list) {
      if (!sel) continue;
      const el = $(sel);
      if (el && isVisible(el)) return el;
    }
    return null;
  }

  function navTarget(view) {
    return resolveTarget(NAV_MAP[view] || []);
  }

  function getSteps() {
    return [
      {
        view: 'home',
        target: null,
        placement: 'center',
        icon: 'fa-solid fa-rocket',
        title: 'Welcome to FBCast Pro',
        body: 'This quick tour walks you through every part of the dashboard — from sending broadcasts to managing your inbox, scheduling, analytics, and billing.',
        tip: 'Takes about 2 minutes. You can skip anytime and finish later from Help.'
      },
      {
        view: 'home',
        target: ['#fbConnectBanner'],
        placement: 'bottom',
        skipIfMissing: true,
        icon: 'fa-brands fa-facebook',
        title: 'Connect your Facebook account',
        body: 'Link Facebook to import your Pages, sync Messenger conversations, and send broadcasts. Click Connect with Facebook when you are ready — you can explore the dashboard first.',
        tip: 'Required before sending messages to real recipients.'
      },
      {
        view: 'home',
        target: ['.nav-sidebar-items', '.app-mobile-nav'],
        placement: 'right',
        icon: 'fa-solid fa-compass',
        title: 'Your navigation hub',
        body: 'Use the sidebar (or bottom bar on mobile) to switch between Home, Broadcast, Messenger, Scheduling, Analytics, and Settings. Each section has a dedicated workspace.',
        tip: 'Press Ctrl+K anywhere to open the command palette for quick jumps.'
      },
      {
        view: 'home',
        target: ['.hv-hero', '#homeUserName'],
        placement: 'bottom',
        icon: 'fa-solid fa-house',
        title: 'Home dashboard',
        body: 'Your command center shows a personalized welcome, quick actions to start a broadcast or open the inbox, and shortcuts to your most-used tools.',
        tip: 'Use New Broadcast or Open Inbox buttons for one-click access.'
      },
      {
        view: 'home',
        target: ['.hv-kpi-row', '#kpiPages'],
        placement: 'bottom',
        icon: 'fa-solid fa-gauge-high',
        title: 'Live performance metrics',
        body: 'Track connected Pages, messages sent, delivery stats, and today\'s activity at a glance. Numbers update as you sync pages and send campaigns.',
        tip: 'Open Analytics for deeper charts and exportable reports.'
      },
      {
        view: 'broadcast',
        target: () => navTarget('broadcast'),
        placement: 'right',
        icon: 'fa-solid fa-bullhorn',
        title: 'Broadcast workspace',
        body: 'Broadcast is where you message everyone who has chatted with your Facebook Page. Compose once, personalize with {{name}}, and send to thousands of recipients safely.',
        tip: 'Supports manual single-page and multi-page broadcast modes.'
      },
      {
        view: 'broadcast',
        target: ['#btnFetchPages', '.sidebar-pages'],
        placement: 'right',
        icon: 'fa-solid fa-rotate',
        title: 'Sync your Facebook Pages',
        body: 'Click Sync Pages to pull your latest Pages from Facebook. Select one or more pages in the sidebar — each page shows recipient counts and connection status.',
        tip: 'Re-sync after adding new Pages in Meta Business Suite.'
      },
      {
        view: 'broadcast',
        target: ['#messageText'],
        placement: 'top',
        icon: 'fa-solid fa-pen-to-square',
        title: 'Compose your message',
        body: 'Write your broadcast here. Use {{name}} to insert each recipient\'s first name. Attach images, set delays between sends, and preview before launching.',
        tip: 'Drafts can be saved automatically in Settings preferences.'
      },
      {
        view: 'broadcast',
        target: ['#btnStart', '.bcast-cta--primary'],
        placement: 'top',
        icon: 'fa-solid fa-paper-plane',
        title: 'Launch your broadcast',
        body: 'When ready, hit Start Broadcast. Progress, sent/failed counts, and delivery logs appear in real time. Adjust send speed with delay presets to stay within Meta limits.',
        tip: 'Open the Recipients panel to filter, search, or exclude specific users.'
      },
      {
        view: 'messenger',
        target: () => navTarget('messenger'),
        placement: 'right',
        icon: 'fa-brands fa-facebook-messenger',
        title: 'Unified Messenger inbox',
        body: 'Reply to customers from every connected Page in one inbox. Filter by unread, search conversations, and send rich messages without leaving FBCast Pro.',
        tip: 'Unread badges on the nav item show pending conversations.'
      },
      {
        view: 'messenger',
        target: ['#msngPagesList', '.msng-pages-list', '#view-messenger'],
        placement: 'right',
        icon: 'fa-solid fa-inbox',
        title: 'Page inbox selector',
        body: 'Pick a Page to load its conversations. Messages sync from Facebook in the background — select a thread on the left and chat on the right.',
        tip: 'Use canned replies and notes for faster support workflows.'
      },
      {
        view: 'scheduling',
        target: () => navTarget('scheduling'),
        placement: 'right',
        icon: 'fa-solid fa-clock',
        title: 'Schedule broadcasts',
        body: 'Plan campaigns ahead of time. Choose pages, write your message, set date and time — the server sends automatically even if your browser is closed.',
        tip: 'Great for promotions, reminders, and timezone-friendly sends.'
      },
      {
        view: 'scheduling',
        target: ['#svMessage', '.sv2-topbar', '#view-scheduling'],
        placement: 'bottom',
        icon: 'fa-solid fa-calendar-check',
        title: 'Schedule composer',
        body: 'Select pages in the sidebar, write your message, pick a send time, and save. Active schedules appear in the list with status and edit options.',
        tip: 'Server-side scheduling means your campaigns run reliably 24/7.'
      },
      {
        view: 'analytics',
        target: () => navTarget('analytics'),
        placement: 'right',
        icon: 'fa-solid fa-chart-line',
        title: 'Analytics dashboard',
        body: 'Measure delivery rates, page performance, send trends, and campaign history. Switch between 7, 30, and 90-day windows and export data as CSV.',
        tip: 'Use insights to optimize send times and message content.'
      },
      {
        view: 'analytics',
        target: ['.analytics-kpi-grid', '#view-analytics .pro-view__head'],
        placement: 'bottom',
        icon: 'fa-solid fa-chart-pie',
        title: 'Performance KPIs',
        body: 'Sent, delivered, failed, and engagement metrics update from your broadcast history. Compare periods to spot trends and improve results.',
        tip: 'Click Export for spreadsheet-ready campaign reports.'
      },
      {
        view: 'settings',
        target: () => navTarget('settings'),
        placement: 'right',
        icon: 'fa-solid fa-gear',
        title: 'Settings & preferences',
        body: 'Manage your profile, notification preferences, theme, default send delays, and account security from Settings.',
        tip: 'Toggle light/dark mode with Ctrl+/ anytime.'
      },
      {
        view: 'settings',
        target: ['#saasBillingCard', '#view-settings'],
        placement: 'bottom',
        icon: 'fa-solid fa-credit-card',
        title: 'Plans & billing',
        body: 'View your current plan, message quota usage, and renewal date. Upgrade for higher limits or open the Stripe portal to manage payment methods.',
        tip: 'Free trial users see remaining days here before upgrade is required.'
      },
      {
        view: 'home',
        target: ['#quotaVal', '#planBadge', '.quota-widget'],
        placement: 'bottom',
        icon: 'fa-solid fa-battery-three-quarters',
        title: 'Message quota tracker',
        body: 'The top bar shows how many messages you have left this billing period. Watch usage during large broadcasts and upgrade before you hit the limit.',
        tip: 'Click your plan badge to open upgrade options.'
      },
      {
        view: 'home',
        target: ['#navAiBtn'],
        placement: 'left',
        skipIfMissing: true,
        icon: 'fa-solid fa-wand-magic-sparkles',
        title: 'AI Broadcast Assistant',
        body: 'Stuck on wording? Open the AI assistant for message ideas, tone adjustments, and broadcast copy suggestions tailored to your campaign.',
        tip: 'Available on every plan — click the sparkle icon in the sidebar footer.'
      },
      {
        view: 'home',
        target: ['#navContactBtn'],
        placement: 'left',
        skipIfMissing: true,
        icon: 'fa-solid fa-headset',
        title: 'Support & help',
        body: 'Need help? Open live support chat or visit the Help Center for FAQs on tokens, failed messages, delays, and billing.',
        tip: 'Email support@castmepro.com for account issues.'
      },
      {
        view: 'help',
        target: ['#view-help .pro-view__head', '#view-help'],
        placement: 'center',
        icon: 'fa-solid fa-circle-check',
        title: 'You\'re all set!',
        body: 'You now know every major section of FBCast Pro. Connect Facebook, sync your pages, and send your first broadcast — or explore Help anytime for detailed guides.',
        tip: 'Re-run this tour from Help → "Take the tour again" if you need a refresher.'
      }
    ];
  }

  function buildDom() {
    if (root) return;
    root = document.createElement('div');
    root.id = 'fbcTour';
    root.className = 'fbc-tour';
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-modal', 'true');
    root.setAttribute('aria-labelledby', 'fbcTourTitle');
    root.innerHTML =
      '<div class="fbc-tour__backdrop" data-tour-backdrop></div>' +
      '<div class="fbc-tour__ring fbc-tour__pulse" data-tour-ring></div>' +
      '<div class="fbc-tour__card" data-tour-card>' +
        '<div class="fbc-tour__progress">' +
          '<span class="fbc-tour__step-label" data-tour-step-label>Step 1</span>' +
          '<div class="fbc-tour__bar"><div class="fbc-tour__bar-fill" data-tour-bar style="width:0%"></div></div>' +
        '</div>' +
        '<div class="fbc-tour__icon" data-tour-icon><i class="fa-solid fa-rocket"></i></div>' +
        '<h2 class="fbc-tour__title" id="fbcTourTitle" data-tour-title>Welcome</h2>' +
        '<p class="fbc-tour__body" data-tour-body></p>' +
        '<div class="fbc-tour__tips" data-tour-tip hidden></div>' +
        '<div class="fbc-tour__actions">' +
          '<button type="button" class="ds-btn ds-btn--ghost btn-sm" data-tour-skip>Skip tour</button>' +
          '<span class="fbc-tour__actions-spacer"></span>' +
          '<button type="button" class="ds-btn ds-btn--secondary btn-sm" data-tour-back hidden>Back</button>' +
          '<button type="button" class="ds-btn ds-btn--primary btn-sm" data-tour-next>Next</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(root);
    ring = root.querySelector('[data-tour-ring]');
    card = root.querySelector('[data-tour-card]');

    root.querySelector('[data-tour-skip]').addEventListener('click', () => finish(true));
    root.querySelector('[data-tour-back]').addEventListener('click', () => go(-1));
    root.querySelector('[data-tour-next]').addEventListener('click', () => go(1));
    root.querySelector('[data-tour-backdrop]').addEventListener('click', () => {});
    document.addEventListener('keydown', onKeydown);
  }

  function onKeydown(e) {
    if (!active) return;
    if (e.key === 'Escape') finish(true);
    else if (e.key === 'ArrowRight' || e.key === 'Enter') { e.preventDefault(); go(1); }
    else if (e.key === 'ArrowLeft') go(-1);
  }

  function switchView(view) {
    if (!view) return Promise.resolve();
    if (typeof global.switchDashboardView === 'function') {
      global.switchDashboardView(view);
    } else if (global.AppShell && typeof global.AppShell.navigate === 'function') {
      global.AppShell.navigate(view);
    }
    return new Promise((r) => setTimeout(r, 320));
  }

  function resolveStepTarget(step) {
    if (!step.target) return null;
    if (typeof step.target === 'function') return step.target();
    return resolveTarget(step.target);
  }

  function positionCard(el, placement) {
    if (!card) return;
    const pad = 14;
    const cardRect = card.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    if (!el || placement === 'center') {
      ring.classList.add('is-center');
      card.style.top = '50%';
      card.style.left = '50%';
      card.style.transform = 'translate(-50%, -50%)';
      card.style.bottom = '';
      card.style.right = '';
      return;
    }

    ring.classList.remove('is-center');
    const r = el.getBoundingClientRect();
    const ringPad = 6;
    ring.style.top = (r.top - ringPad) + 'px';
    ring.style.left = (r.left - ringPad) + 'px';
    ring.style.width = (r.width + ringPad * 2) + 'px';
    ring.style.height = (r.height + ringPad * 2) + 'px';

    let top = r.bottom + pad;
    let left = r.left;

    if (placement === 'top') {
      top = r.top - cardRect.height - pad;
      left = r.left + r.width / 2 - cardRect.width / 2;
    } else if (placement === 'bottom') {
      top = r.bottom + pad;
      left = r.left + r.width / 2 - cardRect.width / 2;
    } else if (placement === 'left') {
      top = r.top + r.height / 2 - cardRect.height / 2;
      left = r.left - cardRect.width - pad;
    } else if (placement === 'right') {
      top = r.top + r.height / 2 - cardRect.height / 2;
      left = r.right + pad;
    }

    left = Math.max(12, Math.min(left, vw - cardRect.width - 12));
    top = Math.max(12, Math.min(top, vh - cardRect.height - 12));

    card.style.top = top + 'px';
    card.style.left = left + 'px';
    card.style.transform = 'none';
    card.style.bottom = '';
    card.style.right = '';

    el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  function renderStep() {
    const step = steps[idx];
    if (!step) return finish(false);

    const total = steps.length;
    const pct = Math.round(((idx + 1) / total) * 100);
    root.querySelector('[data-tour-step-label]').textContent = 'Step ' + (idx + 1) + ' of ' + total;
    root.querySelector('[data-tour-bar]').style.width = pct + '%';
    root.querySelector('[data-tour-title]').textContent = step.title;
    root.querySelector('[data-tour-body]').textContent = step.body;
    const iconEl = root.querySelector('[data-tour-icon]');
    iconEl.innerHTML = '<i class="' + step.icon + '"></i>';
    const tipEl = root.querySelector('[data-tour-tip]');
    if (step.tip) {
      tipEl.hidden = false;
      tipEl.innerHTML = '<strong>Tip:</strong> ' + step.tip;
    } else {
      tipEl.hidden = true;
    }

    const backBtn = root.querySelector('[data-tour-back]');
    backBtn.hidden = idx === 0;
    root.querySelector('[data-tour-next]').textContent = idx === total - 1 ? 'Finish tour' : 'Next';

    switchView(step.view).then(() => {
      const el = resolveStepTarget(step);
      if (step.skipIfMissing && !el) {
        setTimeout(() => go(1), 0);
        return;
      }
      requestAnimationFrame(() => {
        positionCard(el, step.placement || 'bottom');
        requestAnimationFrame(() => positionCard(el, step.placement || 'bottom'));
      });
    });
  }

  function go(delta) {
    const next = idx + delta;
    if (next < 0) return;
    if (next >= steps.length) {
      finish(false);
      return;
    }
    idx = next;
    renderStep();
  }

  async function persistComplete() {
    try {
      localStorage.setItem(LS_KEY + accountKey, '1');
      localStorage.setItem('fbcast_onboarding_done', '1');
    } catch (_) {}
    try {
      const csrf = typeof global.getCsrfToken === 'function' ? await global.getCsrfToken() : '';
      await fetch('/api/auth/onboarding/complete', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }
      });
    } catch (_) {}
  }

  function finish(skipped) {
    if (!active) return;
    active = false;
    root.classList.remove('is-active');
    document.body.style.overflow = '';
    if (resizeObs) {
      resizeObs.disconnect();
      resizeObs = null;
    }
    persistComplete();
    if (typeof global.showToast === 'function') {
      global.showToast(
        skipped ? 'Tour skipped — find Help anytime in the menu' : 'Welcome aboard! You\'re ready to broadcast.',
        skipped ? 'info' : 'success'
      );
    }
  }

  function start(force) {
    if (active) return;
    if (!force && isLocallyDone()) return;

    buildDom();
    steps = getSteps();
    idx = 0;
    active = true;
    document.body.style.overflow = 'hidden';
    root.classList.add('is-active');

    if (typeof ResizeObserver !== 'undefined') {
      resizeObs = new ResizeObserver(() => {
        if (!active) return;
        const step = steps[idx];
        if (!step) return;
        positionCard(resolveStepTarget(step), step.placement || 'bottom');
      });
      resizeObs.observe(document.body);
    }

    renderStep();
  }

  function isLocallyDone() {
    try {
      return localStorage.getItem(LS_KEY + accountKey) === '1' ||
        localStorage.getItem('fbcast_onboarding_done') === '1';
    } catch (_) {
      return false;
    }
  }

  async function fetchOnboardingState() {
    try {
      const res = await fetch('/api/auth/status', { credentials: 'same-origin' });
      if (!res.ok) return { completed: false };
      const data = await res.json();
      const id = data.appAccount?.id || data.userId || '';
      accountKey = id ? '_' + id : '';
      return { completed: !!data.onboardingCompleted, authenticated: !!data.authenticated };
    } catch (_) {
      return { completed: false };
    }
  }

  async function tryStart(force) {
    const appPage = document.getElementById('appPage');
    if (!appPage || appPage.style.display === 'none') return;

    if (force) {
      start(true);
      return;
    }

    const state = await fetchOnboardingState();
    if (state.completed || isLocallyDone()) return;
    if (!state.authenticated) return;

    start(false);
  }

  global.FBCastTour = {
    start,
    tryStart,
    restart: () => {
      try {
        localStorage.removeItem(LS_KEY + accountKey);
        localStorage.removeItem('fbcast_onboarding_done');
      } catch (_) {}
      start(true);
    }
  };

  window.addEventListener('fbc:restart-onboarding-tour', () => global.FBCastTour.restart());
})(window);
