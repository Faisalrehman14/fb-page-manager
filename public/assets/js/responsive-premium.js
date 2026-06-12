/**
 * Responsive shell — Meta-style viewport fit (scale entire UI to window, no page scroll)
 */
(function (global) {
  'use strict';

  const MOBILE_BP = 900;
  const DESIGN_W = 1280;
  const DESIGN_H = 900;
  const LANDING_FIT_H = 900;
  const MIN_SCALE = 0.18;
  const TOPBAR_COMPACT_W = 960;

  let backdrop = null;
  let topbarQuotaInited = false;
  let quotaSyncLock = false;
  let fitRaf = 0;
  let lastFitScale = 1;
  let wrappedRoot = null;
  let shellResizeObs = null;

  function isFitMode() {
    return document.documentElement.classList.contains('rs-viewport-fit');
  }

  function isMobile() {
    if (isFitMode()) return false;
    return window.matchMedia('(max-width: ' + MOBILE_BP + 'px)').matches;
  }

  function isDashboardRoot(content) {
    return !!(content && content.id === 'appPage');
  }

  function getActiveRoot() {
    if (document.body.classList.contains('app-dashboard-active')) {
      const app = document.getElementById('appPage');
      if (app && app.style.display !== 'none') return app;
    }
    const landing = document.getElementById('landingPage');
    if (landing && landing.style.display !== 'none') return landing;
    return document.getElementById('appPage') || landing;
  }

  function needsViewportFit(w, h, content) {
    if (isDashboardRoot(content)) {
      return w < DESIGN_W || h < DESIGN_H;
    }
    return w < DESIGN_W;
  }

  function getDashboardScales(w, h) {
    return {
      scaleX: Math.max(MIN_SCALE, w / DESIGN_W),
      scaleY: Math.max(MIN_SCALE, h / DESIGN_H),
    };
  }

  function computeFitScale(w, h, content) {
    if (isDashboardRoot(content)) {
      const { scaleX, scaleY } = getDashboardScales(w, h);
      return Math.min(scaleX, scaleY);
    }
    const scaleW = w / DESIGN_W;
    if (scaleW >= 1) return 1;
    return Math.max(MIN_SCALE, scaleW);
  }

  function getDesignHeight(content) {
    if (isDashboardRoot(content)) return DESIGN_H;
    const measured = Math.ceil(content.scrollHeight || content.offsetHeight || 0);
    return Math.max(LANDING_FIT_H, measured);
  }

  function applyStageLayout(shell, stage, scaler, scale, content, viewportW, viewportH) {
    if (!shell || !stage || !scaler) return;

    const w = viewportW || window.innerWidth;
    const h = viewportH || window.innerHeight;
    const designH = getDesignHeight(content);

    scaler.style.overflow = 'hidden';
    scaler.style.flexShrink = '0';
    scaler.style.position = 'relative';

    stage.style.width = DESIGN_W + 'px';
    stage.style.height = designH + 'px';
    stage.style.transformOrigin = 'top left';
    stage.style.margin = '0';

    if (isDashboardRoot(content)) {
      const { scaleX, scaleY } = getDashboardScales(w, h);
      scaler.style.width = w + 'px';
      scaler.style.height = h + 'px';
      scaler.style.maxWidth = '100%';
      stage.style.transform = 'scale(' + scaleX.toFixed(4) + ', ' + scaleY.toFixed(4) + ')';
    } else {
      const scaleW = Math.max(MIN_SCALE, Math.min(w / DESIGN_W, 1));
      scaler.style.width = '100%';
      scaler.style.maxWidth = '100%';
      scaler.style.height = (designH * scaleW) + 'px';
      stage.style.transform = 'scale(' + scaleW.toFixed(4) + ')';
    }

    shell.style.height = '100dvh';
    shell.style.maxHeight = '100dvh';
    shell.style.overflow = isDashboardRoot(content) ? 'hidden' : 'auto';
  }

  function unwrapAllShells() {
    document.querySelectorAll('.rs-viewport-shell').forEach((shell) => {
      const stage = shell.querySelector('.rs-viewport-stage');
      const inner = stage && stage.firstElementChild;
      if (inner && shell.parentNode) {
        shell.parentNode.insertBefore(inner, shell);
        shell.remove();
      }
    });
  }

  function ensureScaleShell(content) {
    if (!content) return null;
    const existing = content.closest('.rs-viewport-shell');
    if (existing) return existing;

    const shell = document.createElement('div');
    shell.className = 'rs-viewport-shell';
    const scaler = document.createElement('div');
    scaler.className = 'rs-viewport-scaler';
    const stage = document.createElement('div');
    stage.className = 'rs-viewport-stage';

    content.parentNode.insertBefore(shell, content);
    stage.appendChild(content);
    scaler.appendChild(stage);
    shell.appendChild(scaler);
    return shell;
  }

  function getCurrentScale() {
    const raw = document.documentElement.style.getPropertyValue('--rs-fit-scale')
      || getComputedStyle(document.documentElement).getPropertyValue('--rs-fit-scale');
    const parsed = parseFloat(String(raw).trim());
    return Number.isFinite(parsed) && parsed > 0 ? parsed : lastFitScale;
  }

  function updateShellLayout(shell, stage, scale, content) {
    const scaler = shell && shell.querySelector('.rs-viewport-scaler');
    applyStageLayout(shell, stage, scaler, scale || getCurrentScale(), content);
  }

  function bindShellResizeObserver(shell, stage, content) {
    if (typeof ResizeObserver === 'undefined' || !shell || !stage) return;
    if (shellResizeObs) shellResizeObs.disconnect();
    let timer;
    shellResizeObs = new ResizeObserver(() => {
      clearTimeout(timer);
      timer = setTimeout(() => updateShellLayout(shell, stage, getCurrentScale(), content), 50);
    });
    shellResizeObs.observe(stage);
    if (!isDashboardRoot(content)) shellResizeObs.observe(stage.firstElementChild || stage);
  }

  function applyBodyOverflowForFit(active) {
    const html = document.documentElement;
    if (active) {
      if (document.body.dataset.rsOverflow == null) {
        document.body.dataset.rsOverflow = document.body.style.overflow || '';
      }
      if (html.dataset.rsOverflow == null) {
        html.dataset.rsOverflow = html.style.overflow || '';
      }
      html.style.overflow = 'hidden';
      html.style.height = '100%';
      document.body.style.overflow = 'hidden';
      document.body.style.height = '100%';
    } else {
      html.style.overflow = html.dataset.rsOverflow || '';
      html.style.height = '';
      delete html.dataset.rsOverflow;
      document.body.style.overflow = document.body.dataset.rsOverflow || '';
      document.body.style.height = '';
      delete document.body.dataset.rsOverflow;
    }
  }

  function setFitModeClasses(content, on) {
    const html = document.documentElement;
    html.classList.toggle('rs-viewport-fit--app', on && isDashboardRoot(content));
    html.classList.toggle('rs-viewport-fit--landing', on && content && content.id === 'landingPage');
  }

  function clearViewportFit() {
    unwrapAllShells();
    wrappedRoot = null;
    if (shellResizeObs) {
      shellResizeObs.disconnect();
      shellResizeObs = null;
    }
    document.documentElement.classList.remove('rs-viewport-fit', 'rs-viewport-scaled');
    setFitModeClasses(null, false);
    document.documentElement.style.removeProperty('--rs-fit-scale');
    document.documentElement.style.removeProperty('--rs-design-h');
    document.documentElement.style.removeProperty('--rs-viewport-scale');
    document.body.style.removeProperty('min-height');
    applyBodyOverflowForFit(false);
    syncMessengerLayout();
    lastFitScale = 1;
  }

  function ensureFabInAppPage() {
    const fab = document.getElementById('ppFab');
    const app = document.getElementById('appPage');
    if (!fab || !app || fab.parentElement === app) return;
    app.appendChild(fab);
  }

  function applyViewportFit() {
    fitRaf = 0;
    const w = window.innerWidth;
    const h = window.innerHeight;
    const content = getActiveRoot();
    if (!content) return;

    const scale = computeFitScale(w, h, content);

    if (!needsViewportFit(w, h, content)) {
      clearViewportFit();
      return;
    }

    if (wrappedRoot && wrappedRoot !== content) {
      unwrapAllShells();
      wrappedRoot = null;
    }

    const shell = ensureScaleShell(content);
    const scaler = shell && shell.querySelector('.rs-viewport-scaler');
    const stage = shell && shell.querySelector('.rs-viewport-stage');
    if (!shell || !scaler || !stage) return;

    wrappedRoot = content;
    lastFitScale = scale;

    ensureFabInAppPage();

    document.documentElement.classList.add('rs-viewport-fit');
    setFitModeClasses(content, true);
    document.documentElement.style.setProperty('--rs-fit-scale', scale.toFixed(4));
    document.documentElement.style.setProperty('--rs-design-h', getDesignHeight(content) + 'px');

    applyBodyOverflowForFit(true);
    applyStageLayout(shell, stage, scaler, scale, content, w, h);
    syncMessengerLayout();
    bindShellResizeObserver(shell, stage, content);

    requestAnimationFrame(() => applyStageLayout(shell, stage, scaler, scale, content, w, h));
  }

  function scheduleViewportFit() {
    if (fitRaf) return;
    fitRaf = requestAnimationFrame(applyViewportFit);
  }

  function ensureBackdrop() {
    if (backdrop) return backdrop;
    backdrop = document.createElement('div');
    backdrop.className = 'sidebar-backdrop';
    backdrop.id = 'sidebarBackdrop';
    backdrop.setAttribute('aria-hidden', 'true');
    backdrop.addEventListener('click', closePagesDrawer);
    document.body.appendChild(backdrop);
    return backdrop;
  }

  function openPagesDrawer() {
    if (!isMobile()) return;
    ensureBackdrop();
    document.body.classList.add('pages-drawer-open');
    backdrop.setAttribute('aria-hidden', 'false');
    const btn = document.getElementById('mobilePagesToggle');
    if (btn) btn.setAttribute('aria-expanded', 'true');
  }

  function closePagesDrawer() {
    document.body.classList.remove('pages-drawer-open');
    if (backdrop) backdrop.setAttribute('aria-hidden', 'true');
    const btn = document.getElementById('mobilePagesToggle');
    if (btn) btn.setAttribute('aria-expanded', 'false');
  }

  function togglePagesDrawer() {
    if (document.body.classList.contains('pages-drawer-open')) closePagesDrawer();
    else openPagesDrawer();
  }

  function initPagesToggle() {
    const btn = document.getElementById('mobilePagesToggle');
    if (!btn) return;
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      togglePagesDrawer();
    });
  }

  function initPageCardClose() {
    document.addEventListener('click', (e) => {
      const card = e.target.closest('.page-card');
      if (card && isMobile()) closePagesDrawer();
    });
  }

  function closeTopbarOverflow() {
    const panel = document.getElementById('topbarOverflowPanel');
    const btn = document.getElementById('topbarOverflowBtn');
    if (panel) panel.hidden = true;
    if (btn) btn.setAttribute('aria-expanded', 'false');
  }

  function toggleTopbarOverflow() {
    const panel = document.getElementById('topbarOverflowPanel');
    const btn = document.getElementById('topbarOverflowBtn');
    if (!panel || !btn) return;
    const open = panel.hidden;
    panel.hidden = !open;
    btn.setAttribute('aria-expanded', open ? 'true' : 'false');
  }

  function initTopbarOverflow() {
    const btn = document.getElementById('topbarOverflowBtn');
    const panel = document.getElementById('topbarOverflowPanel');
    if (!btn || !panel) return;

    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleTopbarOverflow();
    });

    panel.querySelectorAll('.saas-topbar__overflow-item').forEach((item) => {
      item.addEventListener('click', () => closeTopbarOverflow());
    });

    const themeItem = document.getElementById('topbarOverflowTheme');
    if (themeItem) {
      themeItem.addEventListener('click', () => {
        const toggle = document.getElementById('themeToggle');
        if (toggle) {
          toggle.click();
        } else if (typeof global.applyTheme === 'function') {
          const isLight = document.documentElement.getAttribute('data-theme') === 'light';
          global.applyTheme(isLight ? 'dark' : 'light');
        }
        closeTopbarOverflow();
      });
    }

    document.addEventListener('click', (e) => {
      if (!panel.hidden && !panel.contains(e.target) && e.target !== btn && !btn.contains(e.target)) {
        closeTopbarOverflow();
      }
    });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') closeTopbarOverflow();
    });
  }

  function syncMessengerLayout() {
    const convs = document.getElementById('msngConvsCol');
    const panel = document.getElementById('msngContactPanel');

    if (isFitMode()) {
      convs?.classList.remove('slide-out');
      return;
    }

    if (!panel) return;
    if (window.innerWidth <= 1200) {
      panel.classList.remove('is-open');
      panel.setAttribute('aria-hidden', 'true');
      const toggle = document.getElementById('msngContactToggleBtn');
      if (toggle) toggle.setAttribute('aria-expanded', 'false');
    }
    if (convs && window.innerWidth > 640) {
      convs.classList.remove('slide-out');
    }
  }

  function parseQuotaNum(el) {
    if (!el) return 0;
    const raw = el.dataset.fullValue || el.textContent || '0';
    return parseInt(String(raw).replace(/[^\d]/g, ''), 10) || 0;
  }

  function formatCompactNum(n) {
    n = Number(n);
    if (!Number.isFinite(n) || n < 0) return '0';
    if (n >= 1000000) {
      const m = n / 1000000;
      return (m >= 10 ? Math.round(m) : m.toFixed(1).replace(/\.0$/, '')) + 'M';
    }
    if (n >= 10000) {
      const k = n / 1000;
      return (k >= 100 ? Math.round(k) : k.toFixed(1).replace(/\.0$/, '')) + 'K';
    }
    return n.toLocaleString();
  }

  function syncTopbarQuotaDisplay() {
    if (quotaSyncLock) return;
    if (!document.body.classList.contains('app-dashboard-active')) return;

    const topbar = document.querySelector('.saas-topbar');
    const valEl = document.getElementById('quotaVal');
    const totEl = document.getElementById('quotaTotal');
    if (!topbar || !valEl || topbar.offsetParent === null) return;

    const compact = !isFitMode() && topbar.offsetWidth < TOPBAR_COMPACT_W;
    const fullRem = parseInt(valEl.dataset.fullValue || String(parseQuotaNum(valEl)), 10);
    const fullTot = totEl
      ? parseInt(totEl.dataset.fullValue || String(parseQuotaNum(totEl)), 10)
      : 0;

    const nextVal = compact ? formatCompactNum(fullRem) : fullRem.toLocaleString();
    const nextTot = compact ? formatCompactNum(fullTot) : fullTot.toLocaleString();

    if (valEl.textContent === nextVal && (!totEl || totEl.textContent === nextTot)) return;

    quotaSyncLock = true;
    try {
      if (valEl.textContent !== nextVal) valEl.textContent = nextVal;
      if (totEl && totEl.textContent !== nextTot) totEl.textContent = nextTot;
    } finally {
      quotaSyncLock = false;
    }
  }

  function initTopbarQuotaObserver() {
    if (topbarQuotaInited || !document.body.classList.contains('app-dashboard-active')) return;
    const topbar = document.querySelector('.saas-topbar');
    if (!topbar) return;
    topbarQuotaInited = true;

    let timer;
    const debounced = () => {
      clearTimeout(timer);
      timer = setTimeout(syncTopbarQuotaDisplay, 100);
    };

    if (typeof ResizeObserver !== 'undefined') {
      const ro = new ResizeObserver(debounced);
      ro.observe(topbar);
    }

    syncTopbarQuotaDisplay();
  }

  function watchDashboardActivation() {
    if (typeof MutationObserver === 'undefined') return;
    const obs = new MutationObserver(() => {
      if (document.body.classList.contains('app-dashboard-active')) {
        initTopbarQuotaObserver();
      }
      scheduleViewportFit();
    });
    obs.observe(document.body, { attributes: true, attributeFilter: ['class'] });

    ['appPage', 'landingPage'].forEach((id) => {
      const el = document.getElementById(id);
      if (!el) return;
      const pageObs = new MutationObserver(() => scheduleViewportFit());
      pageObs.observe(el, { attributes: true, attributeFilter: ['style', 'class'] });
    });
  }

  function initResizeHandler() {
    let timer;
    window.addEventListener('resize', () => {
      scheduleViewportFit();
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (!isMobile()) closePagesDrawer();
        closeTopbarOverflow();
        syncMessengerLayout();
        syncTopbarQuotaDisplay();
      }, 120);
    }, { passive: true });
    window.addEventListener('orientationchange', scheduleViewportFit, { passive: true });
  }

  function initEscape() {
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') closePagesDrawer();
    });
  }

  function hookViewSwitch() {
    const orig = global.switchDashboardView;
    if (typeof orig !== 'function' || orig.__rsFitHooked) return;
    function wrapped() {
      const result = orig.apply(this, arguments);
      scheduleViewportFit();
      return result;
    }
    wrapped.__rsFitHooked = true;
    global.switchDashboardView = wrapped;
  }

  function init() {
    ensureFabInAppPage();
    scheduleViewportFit();
    window.addEventListener('load', scheduleViewportFit, { passive: true });
    watchDashboardActivation();
    hookViewSwitch();

    initPagesToggle();
    initPageCardClose();
    initTopbarOverflow();
    initTopbarQuotaObserver();
    initResizeHandler();
    initEscape();
  }

  global.openPagesDrawer = openPagesDrawer;
  global.closePagesDrawer = closePagesDrawer;
  global.togglePagesDrawer = togglePagesDrawer;
  global.syncTopbarQuotaDisplay = syncTopbarQuotaDisplay;
  global.scheduleViewportFit = scheduleViewportFit;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})(window);
