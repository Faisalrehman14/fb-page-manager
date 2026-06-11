/**
 * FBCast Pro — Platform Premium UX
 * Personalized dashboard, smart recommendations, activity feed, security & team.
 */
(function (global) {
  'use strict';

  const PREFS_KEY = 'fbcast.dashboard.v1';
  const RECENT_CMD_KEY = 'fbcast.recent_cmds';

  const DEFAULT_WIDGETS = {
    quickActions: true,
    recommendations: true,
    activity: true
  };

  const VIEW_HINTS = {
    home: 'Ask the AI assistant for campaign ideas or check your quota before a large send.',
    broadcast: 'Use {{name}} for personalization. Try Ctrl+Enter to send quickly.',
    messenger: 'Filter unread conversations and use canned replies to respond faster.',
    scheduling: 'Schedule during your audience\'s peak hours — see Analytics heatmap.',
    analytics: 'Export CSV reports and compare 7 vs 30 day performance.',
    settings: 'Sync preferences across devices and review your security settings.',
    help: 'Take the interactive tour again or contact support for live help.'
  };

  let widgets = { ...DEFAULT_WIDGETS };
  let fabOpen = false;

  function $(id) { return document.getElementById(id); }

  function loadWidgets() {
    try {
      const raw = JSON.parse(localStorage.getItem(PREFS_KEY) || '{}');
      widgets = { ...DEFAULT_WIDGETS, ...raw.widgets };
    } catch (_) {
      widgets = { ...DEFAULT_WIDGETS };
    }
  }

  function saveWidgets() {
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify({ widgets }));
    } catch (_) {}
  }

  function navigate(view) {
    if (typeof global.switchDashboardView === 'function') global.switchDashboardView(view);
    else if (global.AppShell) global.AppShell.navigate(view);
  }

  function timeAgo(iso) {
    if (!iso) return '';
    const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
    if (s < 60) return 'Just now';
    if (s < 3600) return Math.floor(s / 60) + 'm ago';
    if (s < 86400) return Math.floor(s / 3600) + 'h ago';
    return new Date(iso).toLocaleDateString();
  }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  /* ── Quick actions ── */
  function buildQuickBar() {
    const actions = [
      { icon: 'fa-bullhorn', label: 'New Broadcast', run: () => navigate('broadcast') },
      { icon: 'fa-facebook-messenger', label: 'Open Inbox', run: () => navigate('messenger') },
      { icon: 'fa-clock', label: 'Schedule', run: () => navigate('scheduling') },
      { icon: 'fa-chart-line', label: 'Analytics', run: () => navigate('analytics') },
      { icon: 'fa-wand-magic-sparkles', label: 'AI Assistant', run: () => global.fbcastAI?.toggle?.() },
      { icon: 'fa-magnifying-glass', label: 'Search (Ctrl+K)', run: () => global.openCommandPalette?.() }
    ];
    return (
      '<div class="pp-quick-bar pp-widget" data-widget="quickActions">' +
      '<span class="pp-quick-bar__label"><i class="fa-solid fa-bolt"></i> Quick actions</span>' +
      actions.map((a) =>
        '<button type="button" class="pp-quick-btn" data-pp-action="' + esc(a.label) + '">' +
        '<i class="fa-solid ' + a.icon + '"></i>' + esc(a.label) + '</button>'
      ).join('') +
      '</div>'
    );
  }

  function bindQuickBar(root) {
    const map = {
      'New Broadcast': () => navigate('broadcast'),
      'Open Inbox': () => navigate('messenger'),
      'Schedule': () => navigate('scheduling'),
      'Analytics': () => navigate('analytics'),
      'AI Assistant': () => global.fbcastAI?.toggle?.(),
      'Search (Ctrl+K)': () => global.openCommandPalette?.()
    };
    root.querySelectorAll('[data-pp-action]').forEach((btn) => {
      btn.addEventListener('click', () => map[btn.dataset.ppAction]?.());
    });
  }

  /* ── Smart recommendations ── */
  function buildRecommendations() {
    const state = global.homeDashboardState || {};
    const pages = state.pagesCount || 0;
    const unread = state.unread?.total || 0;
    const pending = state.scheduleStats?.pending || 0;
    const quota = state.quota || {};
    const used = quota.messagesUsed || 0;
    const limit = quota.messageLimit || 2000;
    const pct = limit > 0 ? (used / limit) * 100 : 0;

    const recos = [];

    if (pages === 0) {
      recos.push({
        icon: 'fa-brands fa-facebook', color: 'pp-reco-icon--blue',
        title: 'Connect Facebook',
        text: 'Link your account to sync pages and start broadcasting.',
        run: () => { if (typeof global.connectFacebookAccount === 'function') global.connectFacebookAccount(); }
      });
    }
    if (unread > 0) {
      recos.push({
        icon: 'fa-solid fa-inbox', color: 'pp-reco-icon--green',
        title: unread + ' unread conversation' + (unread > 1 ? 's' : ''),
        text: 'Respond to customers waiting in your Messenger inbox.',
        run: () => navigate('messenger')
      });
    }
    if (pending === 0 && pages > 0) {
      recos.push({
        icon: 'fa-solid fa-calendar-plus', color: 'pp-reco-icon--purple',
        title: 'Schedule a campaign',
        text: 'Plan your next broadcast to run automatically on the server.',
        run: () => navigate('scheduling')
      });
    }
    if (pct >= 75) {
      recos.push({
        icon: 'fa-solid fa-arrow-up', color: 'pp-reco-icon--amber',
        title: 'Quota at ' + Math.round(pct) + '%',
        text: 'Upgrade your plan before your next large broadcast.',
        run: () => { if (typeof global.openUpgradeModal === 'function') global.openUpgradeModal(); else navigate('settings'); }
      });
    }
    if (!recos.length) {
      recos.push({
        icon: 'fa-solid fa-rocket', color: 'pp-reco-icon--blue',
        title: 'Send your next broadcast',
        text: 'Your dashboard is ready — reach your audience in one click.',
        run: () => navigate('broadcast')
      });
      recos.push({
        icon: 'fa-solid fa-route', color: 'pp-reco-icon--purple',
        title: 'Replay the product tour',
        text: 'Refresh your knowledge of every dashboard section.',
        run: () => global.FBCastTour?.restart?.()
      });
    }

    return (
      '<div class="pp-reco-grid pp-widget" data-widget="recommendations">' +
      recos.slice(0, 4).map((r, i) =>
        '<div class="pp-reco-card" data-pp-reco="' + i + '">' +
        '<div class="pp-reco-icon ' + r.color + '"><i class="' + r.icon + '"></i></div>' +
        '<div><div class="pp-reco-title">' + esc(r.title) + '</div><div class="pp-reco-text">' + esc(r.text) + '</div></div></div>'
      ).join('') +
      '</div>'
    );
  }

  function bindRecommendations(root, recosData) {
    root.querySelectorAll('[data-pp-reco]').forEach((el) => {
      el.addEventListener('click', () => recosData[parseInt(el.dataset.ppReco, 10)]?.run?.());
    });
  }

  function getRecoData() {
    const state = global.homeDashboardState || {};
    const pages = state.pagesCount || 0;
    const unread = state.unread?.total || 0;
    const pending = state.scheduleStats?.pending || 0;
    const quota = state.quota || {};
    const pct = (quota.messageLimit || 2000) > 0 ? ((quota.messagesUsed || 0) / quota.messageLimit) * 100 : 0;
    const recos = [];
    if (pages === 0) recos.push({ run: () => global.connectFacebookAccount?.() });
    if (unread > 0) recos.push({ run: () => navigate('messenger') });
    if (pending === 0 && pages > 0) recos.push({ run: () => navigate('scheduling') });
    if (pct >= 75) recos.push({ run: () => global.openUpgradeModal?.() || navigate('settings') });
    if (!recos.length) {
      recos.push({ run: () => navigate('broadcast') });
      recos.push({ run: () => global.FBCastTour?.restart?.() });
    }
    return recos;
  }

  /* ── Activity feed ── */
  async function fetchActivity() {
    try {
      const res = await fetch('/api/user/activity?limit=12', { credentials: 'same-origin' });
      if (!res.ok) return [];
      const data = await res.json();
      return data.items || [];
    } catch (_) {
      return [];
    }
  }

  function renderActivityList(items) {
    if (!items.length) {
      return '<div class="pp-activity-empty"><i class="fa-solid fa-clock-rotate-left"></i> No recent activity yet — send your first broadcast!</div>';
    }
    return items.map((it) =>
      '<div class="pp-activity-item">' +
      '<span class="pp-activity-dot pp-activity-dot--' + (it.type === 'schedule' ? 'sched' : 'sent') + '"></span>' +
      '<div class="pp-activity-body">' +
      '<div class="pp-activity-title">' + esc(it.title) + '</div>' +
      '<div class="pp-activity-meta">' + esc(it.meta || '') + ' · ' + timeAgo(it.ts) + '</div>' +
      '</div></div>'
    ).join('');
  }

  async function refreshActivity() {
    const list = $('ppActivityList');
    if (!list) return;
    const items = await fetchActivity();
    list.innerHTML = renderActivityList(items);
  }

  function buildActivityPanel() {
    return (
      '<div class="pp-activity-panel pp-widget" data-widget="activity">' +
      '<div class="pp-activity-hdr">' +
      '<h3><i class="fa-solid fa-clock-rotate-left"></i> Recent activity</h3>' +
      '<button type="button" class="pp-customize-btn" id="ppActivityRefresh"><i class="fa-solid fa-rotate"></i></button>' +
      '</div>' +
      '<div class="pp-activity-list" id="ppActivityList"><div class="pp-activity-empty">Loading…</div></div>' +
      '</div>'
    );
  }

  /* ── Dashboard injection ── */
  function applyWidgetVisibility() {
    document.querySelectorAll('[data-widget]').forEach((el) => {
      const key = el.dataset.widget;
      el.classList.toggle('pp-widget-hidden', widgets[key] === false);
    });
  }

  function injectDashboard() {
    const kpiRow = document.querySelector('#view-home .hv-kpi-row');
    if (!kpiRow || $('ppPremiumRoot')) return;

    const metricsHead = document.querySelector('#view-home .hv-metrics-head');
    if (metricsHead) {
      const bar = document.createElement('div');
      bar.className = 'pp-widget-bar';
      bar.innerHTML =
        '<div></div>' +
        '<button type="button" class="pp-customize-btn" id="ppCustomizeBtn"><i class="fa-solid fa-sliders"></i> Customize dashboard</button>';
      metricsHead.appendChild(bar);
      bar.querySelector('#ppCustomizeBtn')?.addEventListener('click', openWidgetModal);
    }

    const root = document.createElement('div');
    root.id = 'ppPremiumRoot';
    root.innerHTML = buildQuickBar() + buildRecommendations() + buildActivityPanel();
    kpiRow.insertAdjacentElement('afterend', root);

    bindQuickBar(root);
    bindRecommendations(root, getRecoData());
    $('ppActivityRefresh')?.addEventListener('click', refreshActivity);
    applyWidgetVisibility();
    refreshActivity();
  }

  function openWidgetModal() {
    let overlay = $('ppWidgetModal');
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'ppWidgetModal';
      overlay.className = 'pp-modal-overlay';
      overlay.innerHTML =
        '<div class="pp-modal" role="dialog">' +
        '<h3><i class="fa-solid fa-sliders"></i> Customize dashboard</h3>' +
        '<p style="font-size:13px;color:var(--text2);margin:0 0 12px">Choose which widgets appear on your home screen.</p>' +
        '<div id="ppWidgetToggles"></div>' +
        '<div class="pp-modal-actions">' +
        '<button type="button" class="ds-btn ds-btn--ghost" id="ppWidgetCancel">Cancel</button>' +
        '<button type="button" class="ds-btn ds-btn--primary" id="ppWidgetSave">Save</button>' +
        '</div></div>';
      document.body.appendChild(overlay);
      overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.classList.remove('is-open'); });
      overlay.querySelector('#ppWidgetCancel')?.addEventListener('click', () => overlay.classList.remove('is-open'));
      overlay.querySelector('#ppWidgetSave')?.addEventListener('click', () => {
        overlay.querySelectorAll('[data-widget-key]').forEach((inp) => {
          widgets[inp.dataset.widgetKey] = inp.checked;
        });
        saveWidgets();
        applyWidgetVisibility();
        overlay.classList.remove('is-open');
        if (typeof global.showToast === 'function') global.showToast('Dashboard layout saved', 'success');
      });
    }
    const toggles = overlay.querySelector('#ppWidgetToggles');
    const labels = { quickActions: 'Quick actions', recommendations: 'Smart recommendations', activity: 'Recent activity' };
    toggles.innerHTML = Object.keys(DEFAULT_WIDGETS).map((k) =>
      '<label class="pp-widget-toggle"><span>' + labels[k] + '</span>' +
      '<input type="checkbox" data-widget-key="' + k + '"' + (widgets[k] !== false ? ' checked' : '') + '></label>'
    ).join('');
    overlay.classList.add('is-open');
  }

  /* ── Floating FAB ── */
  function injectFab() {
    if ($('ppFab')) return;
    const fab = document.createElement('div');
    fab.id = 'ppFab';
    fab.className = 'pp-fab';
    fab.innerHTML =
      '<div class="pp-fab-menu">' +
      '<button type="button" class="pp-fab-item" data-fab="broadcast"><i class="fa-solid fa-bullhorn"></i> Broadcast</button>' +
      '<button type="button" class="pp-fab-item" data-fab="messenger"><i class="fa-brands fa-facebook-messenger"></i> Inbox</button>' +
      '<button type="button" class="pp-fab-item" data-fab="ai"><i class="fa-solid fa-wand-magic-sparkles"></i> AI Help</button>' +
      '<button type="button" class="pp-fab-item" data-fab="search"><i class="fa-solid fa-magnifying-glass"></i> Search</button>' +
      '</div>' +
      '<button type="button" class="pp-fab-main" aria-label="Quick actions"><i class="fa-solid fa-plus"></i></button>';
    document.body.appendChild(fab);
    fab.querySelector('.pp-fab-main').addEventListener('click', () => {
      fabOpen = !fabOpen;
      fab.classList.toggle('is-open', fabOpen);
    });
    fab.querySelectorAll('[data-fab]').forEach((btn) => {
      btn.addEventListener('click', () => {
        fab.classList.remove('is-open');
        fabOpen = false;
        const a = btn.dataset.fab;
        if (a === 'broadcast') navigate('broadcast');
        else if (a === 'messenger') navigate('messenger');
        else if (a === 'ai') global.fbcastAI?.toggle?.();
        else if (a === 'search') global.openCommandPalette?.();
      });
    });
    document.addEventListener('click', (e) => {
      if (!fab.contains(e.target)) { fab.classList.remove('is-open'); fabOpen = false; }
    });
  }

  /* ── AI contextual hints ── */
  function injectAiHint() {
    if ($('ppAiHint')) return;
    const hint = document.createElement('div');
    hint.id = 'ppAiHint';
    hint.className = 'pp-ai-hint';
    hint.innerHTML = '<i class="fa-solid fa-lightbulb"></i><span id="ppAiHintText"></span><button type="button" id="ppAiHintBtn">Ask AI</button>';
    const topbar = document.querySelector('.saas-topbar') || document.querySelector('#appPage .topbar');
    if (topbar) topbar.insertAdjacentElement('afterend', hint);
    hint.querySelector('#ppAiHintBtn')?.addEventListener('click', () => global.fbcastAI?.toggle?.());
  }

  function updateAiHint(view) {
    const el = $('ppAiHint');
    const text = $('ppAiHintText');
    if (!el || !text) return;
    const msg = VIEW_HINTS[view];
    if (msg) {
      text.textContent = msg;
      el.classList.add('is-visible');
    } else {
      el.classList.remove('is-visible');
    }
  }

  /* ── Settings: security & team ── */
  function injectSettingsSections() {
    const panel = document.querySelector('#view-settings .settings-section');
    if (!panel || $('ppSecurityCard')) return;

    const security = document.createElement('div');
    security.className = 'settings-card';
    security.id = 'ppSecurityCard';
    security.innerHTML =
      '<h4><i class="fa-solid fa-shield-halved"></i> Account Security</h4>' +
      '<p>Protect your account with strong credentials and session monitoring.</p>' +
      '<div class="pp-security-grid">' +
      '<div class="pp-security-row"><div><strong>Password</strong><span>Change via secure account portal</span></div>' +
      '<button type="button" class="ds-btn ds-btn--secondary btn-sm" id="ppChangePw">Change password</button></div>' +
      '<div class="pp-security-row"><div><strong>Two-factor authentication</strong><span>Authenticator app support</span></div>' +
      '<span class="pp-badge pp-badge--soon">Coming soon</span></div>' +
      '<div class="pp-security-row"><div><strong>Active session</strong><span id="ppSessionInfo">This device</span></div>' +
      '<span class="pp-badge pp-badge--ok">Secure</span></div>' +
      '<div class="pp-security-row"><div><strong>Activity log</strong><span>View recent account events</span></div>' +
      '<button type="button" class="ds-btn ds-btn--ghost btn-sm" id="ppViewActivity">View activity</button></div>' +
      '</div>';
    panel.insertBefore(security, panel.querySelector('.settings-card:nth-child(3)'));

    security.querySelector('#ppChangePw')?.addEventListener('click', () => {
      window.location.href = '/forgot-password';
    });
    security.querySelector('#ppViewActivity')?.addEventListener('click', () => {
      navigate('home');
      setTimeout(refreshActivity, 400);
    });

    const team = document.createElement('div');
    team.className = 'settings-card';
    team.id = 'ppTeamCard';
    team.innerHTML =
      '<h4><i class="fa-solid fa-users"></i> Team & Collaboration <span class="pp-badge pp-badge--soon">Beta</span></h4>' +
      '<p>Invite teammates with role-based access to broadcasts, inbox, and analytics.</p>' +
      '<div class="pp-team-invite">' +
      '<input type="email" id="ppInviteEmail" placeholder="teammate@company.com" aria-label="Invite email">' +
      '<select id="ppInviteRole" aria-label="Role">' +
      '<option value="editor">Editor — send broadcasts</option>' +
      '<option value="inbox">Inbox — reply only</option>' +
      '<option value="analyst">Analyst — view analytics</option>' +
      '<option value="admin">Admin — full access</option>' +
      '</select>' +
      '<button type="button" class="ds-btn ds-btn--primary" id="ppInviteBtn"><i class="fa-solid fa-user-plus"></i> Invite</button>' +
      '</div>' +
      '<div class="pp-team-list" id="ppTeamList"><div class="pp-activity-empty">Loading team…</div></div>';
    security.insertAdjacentElement('afterend', team);

    team.querySelector('#ppInviteBtn')?.addEventListener('click', inviteTeammate);
    loadTeamMembers();

    fetchAuthForSession();
  }

  async function fetchAuthForSession() {
    try {
      const res = await fetch('/api/auth/status', { credentials: 'same-origin' });
      const data = await res.json();
      const el = $('ppSessionInfo');
      if (el && data.appAccount?.email) {
        el.textContent = 'Signed in as ' + data.appAccount.email;
      }
    } catch (_) {}
  }

  async function loadTeamMembers() {
    const list = $('ppTeamList');
    if (!list) return;
    try {
      const res = await fetch('/api/workspace/members', { credentials: 'same-origin' });
      if (!res.ok) throw new Error();
      const data = await res.json();
      const members = data.members || [];
      if (!members.length) {
        list.innerHTML = '<div class="pp-activity-empty">No teammates yet — invite someone above.</div>';
        return;
      }
      list.innerHTML = members.map((m) =>
        '<div class="pp-team-member"><i class="fa-solid fa-user"></i><span>' + esc(m.email) + '</span>' +
        '<span class="pp-team-role">' + esc(m.role) + (m.status === 'pending' ? ' (pending)' : '') + '</span></div>'
      ).join('');
    } catch (_) {
      list.innerHTML = '<div class="pp-activity-empty">Team features loading…</div>';
    }
  }

  async function inviteTeammate() {
    const email = $('ppInviteEmail')?.value?.trim();
    const role = $('ppInviteRole')?.value || 'editor';
    if (!email) return;
    try {
      const csrf = typeof global.getCsrfToken === 'function' ? await global.getCsrfToken() : '';
      const res = await fetch('/api/workspace/invite', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
        body: JSON.stringify({ email, role })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Invite failed');
      $('ppInviteEmail').value = '';
      if (typeof global.showToast === 'function') global.showToast('Invitation sent to ' + email, 'success');
      loadTeamMembers();
    } catch (e) {
      if (typeof global.showToast === 'function') global.showToast(e.message, 'error');
    }
  }

  /* ── Landing competitive section ── */
  function injectLandingAdvantages() {
    if ($('ppAdvantageSection') || !document.getElementById('compare')) return;
    const section = document.createElement('section');
    section.id = 'ppAdvantageSection';
    section.className = 'pp-advantage-section';
    section.innerHTML =
      '<div class="pp-advantage-inner">' +
      '<span class="section-label">Competitive edge</span>' +
      '<h2 class="section-h2">Why teams switch to FBCast Pro</h2>' +
      '<p class="section-sub">Modern UX, AI assistance, and faster workflows — built to outperform legacy broadcast tools.</p>' +
      '<div class="pp-advantage-grid">' +
      advCard('fa-wand-magic-sparkles', 'AI-powered assistant', 'Get broadcast copy, tone tweaks, and campaign ideas without leaving the dashboard.') +
      advCard('fa-route', 'Interactive onboarding', 'First-time users get a guided tour of every feature — zero learning curve.') +
      advCard('fa-gauge-high', 'Personalized dashboard', 'Smart recommendations, quick actions, and customizable widgets for your workflow.') +
      advCard('fa-magnifying-glass', 'Global search', 'Ctrl+K to jump anywhere — views, pages, settings, and actions in one place.') +
      advCard('fa-users', 'Team collaboration', 'Invite teammates with role-based access to inbox, broadcasts, and analytics.') +
      advCard('fa-chart-line', 'Advanced analytics', 'Delivery trends, page rankings, heatmaps, and CSV export — all in one view.') +
      advCard('fa-mobile-screen', 'Mobile-first design', 'Full responsive experience on phone, tablet, and desktop.') +
      advCard('fa-shield-halved', 'Security & trust', 'Encrypted sessions, CSRF protection, and account security controls.') +
      '</div></div>';
    document.getElementById('compare')?.insertAdjacentElement('beforebegin', section);
  }

  function advCard(icon, title, text) {
    return '<div class="pp-advantage-card"><i class="fa-solid ' + icon + '"></i><h3>' + esc(title) + '</h3><p>' + esc(text) + '</p></div>';
  }

  /* ── Cmdk extensions ── */
  global.__fbcCmdkExtras = function (query, items) {
    const q = (query || '').trim().toLowerCase();
    const settings = [
      { label: 'Settings: Theme', run: () => navigate('settings') },
      { label: 'Settings: Notifications', run: () => navigate('settings') },
      { label: 'Settings: Security', run: () => navigate('settings') },
      { label: 'Settings: Team & Collaboration', run: () => navigate('settings') },
      { label: 'Take product tour', run: () => global.FBCastTour?.restart?.() },
      { label: 'Open notification center', run: () => global.fbcastNotifications?.open?.() }
    ];
    settings.forEach((s) => {
      if (!q || s.label.toLowerCase().includes(q)) {
        items.push({ id: 'set-' + s.label, label: s.label, icon: 'fa-gear', type: 'action', run: s.run });
      }
    });
    if (!q || 'notification'.includes(q) || 'bell'.includes(q)) {
      items.push({
        id: 'act-notif',
        label: 'Open notifications',
        icon: 'fa-bell',
        type: 'action',
        run: () => global.fbcastNotifications?.open?.()
      });
    }
    return items;
  };

  /* ── View change hook ── */
  function hookViewChanges() {
    if (!global.AppShell) return;
    const orig = global.AppShell.navigate?.bind(global.AppShell);
    if (!orig) return;
    global.AppShell.navigate = function (view) {
      orig(view);
      updateAiHint(view);
      if (view === 'home') {
        setTimeout(() => {
          const reco = document.querySelector('#ppPremiumRoot .pp-reco-grid');
          if (reco) {
            reco.outerHTML = buildRecommendations();
            bindRecommendations($('ppPremiumRoot'), getRecoData());
            applyWidgetVisibility();
          }
          refreshActivity();
        }, 300);
      }
    };
  }

  function init() {
    loadWidgets();
    injectLandingAdvantages();

    const boot = () => {
      injectDashboard();
      injectFab();
      injectAiHint();
      injectSettingsSections();
      hookViewChanges();
      updateAiHint('home');
    };

    const prev = global.showAppDashboard;
    global.showAppDashboard = function () {
      try {
        if (typeof prev === 'function') prev.apply(this, arguments);
      } finally {
        setTimeout(boot, 500);
      }
    };

    if (document.getElementById('appPage')?.style.display !== 'none') {
      setTimeout(boot, 600);
    }

    window.addEventListener('fbc:home-summary-updated', () => {
      const root = $('ppPremiumRoot');
      if (!root) return;
      const grid = root.querySelector('.pp-reco-grid');
      if (grid) {
        grid.outerHTML = buildRecommendations();
        bindRecommendations(root, getRecoData());
        applyWidgetVisibility();
      }
    });
  }

  global.FBCastPremium = { refreshActivity, openWidgetModal };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})(window);
