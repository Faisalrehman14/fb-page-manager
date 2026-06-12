/**
 * Responsive shell — viewport fit engine + mobile drawer utilities
 *
 * Viewport fit (Meta-style):
 *   • Fixed design canvas 1280×900
 *   • Width-fill uniform scale (edge-to-edge, no side gutters)
 *   • Top-left anchor, shell background = app background
 *   • html.rs-viewport-fit disables mobile @media layout breaks
 */
(function (global) {
  'use strict';

  const MOBILE_BP = 900;
  const TOPBAR_COMPACT_W = 960;

  const DESIGN = Object.freeze({ w: 1280, h: 900, landingMinH: 900 });
  const MIN_SCALE = 0.25;

  let backdrop = null;
  let topbarQuotaInited = false;
  let quotaSyncLock = false;
  let fitRaf = 0;
  let lastFitScale = 1;
  let wrappedRoot = null;
  let shellResizeObs = null;

  /* ─── Viewport fit engine ─── */

  function isFitMode() {
    return document.documentElement.classList.contains('rs-viewport-fit');
  }

  function isDashboardRoot(el) {
    return !!(el && el.id === 'appPage');
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

  function measureLandingHeight(el) {
    const h = Math.ceil(el.scrollHeight || el.offsetHeight || 0);
    return Math.max(DESIGN.landingMinH, h);
  }

  function needsFit(vw, vh, el) {
    if (isDashboardRoot(el)) return vw < DESIGN.w || vh < DESIGN.h;
    return vw < DESIGN.w;
  }

  /** Width-fill uniform scale — spans full viewport width, no side letterboxing */
  function computeScale(vw, vh, el) {
    const sw = vw / DESIGN.w;
    if (isDashboardRoot(el)) {
      return Math.max(MIN_SCALE, sw);
    }
    if (sw >= 1) return 1;
    return Math.max(MIN_SCALE, sw);
  }

  function setFitTokens(scale, el, vw, vh) {
    const html = document.documentElement;
    const designH = isDashboardRoot(el) ? DESIGN.h : measureLandingHeight(el);
    const fitW = isDashboardRoot(el) ? vw : DESIGN.w * scale;
    const fitH = Math.min(vh, designH * scale);
    html.style.setProperty('--rs-fit-scale', scale.toFixed(4));
    html.style.setProperty('--rs-design-w', DESIGN.w + 'px');
    html.style.setProperty('--rs-design-h', designH + 'px');
    html.style.setProperty('--rs-fit-w', fitW.toFixed(2) + 'px');
    html.style.setProperty('--rs-fit-h', fitH.toFixed(2) + 'px');
  }

  function clearFitTokens() {
    const html = document.documentElement;
    ['--rs-fit-scale', '--rs-design-w', '--rs-design-h', '--rs-fit-w', '--rs-fit-h', '--rs-viewport-scale']
      .forEach((k) => html.style.removeProperty(k));
  }

  function unwrapAllShells() {
    document.querySelectorAll('.rs-viewport-shell').forEach((shell) => {
      const stage = shell.querySelector('.rs-viewport-stage');
      const inner = stage && stage.firstElementChild;
      if (inner && shell.parentNode) {
        shell.parentNode.insertBefore(inner, shell);
      }
      shell.remove();
    });
  }

  function ensureShell(el) {
    if (!el) return null;
    const existing = el.closest('.rs-viewport-shell');
    if (existing) return existing;

    const shell = document.createElement('div');
    shell.className = 'rs-viewport-shell';
    shell.setAttribute('data-rs-viewport', '');

    const clip = document.createElement('div');
    clip.className = 'rs-viewport-scaler';

    const stage = document.createElement('div');
    stage.className = 'rs-viewport-stage';

    el.parentNode.insertBefore(shell, el);
    stage.appendChild(el);
    clip.appendChild(stage);
    shell.appendChild(clip);
    return shell;
  }

  function layoutShell(shell, el, vw, vh) {
    const clip = shell.querySelector('.rs-viewport-scaler');
    const stage = shell.querySelector('.rs-viewport-stage');
    if (!clip || !stage) return 1;

    const scale = computeScale(vw, vh, el);
    const designH = isDashboardRoot(el) ? DESIGN.h : measureLandingHeight(el);
    const fittedH = designH * scale;
    const clipH = isDashboardRoot(el) ? Math.min(vh, fittedH) : fittedH;

    clip.style.width = isDashboardRoot(el) ? '100%' : (DESIGN.w * scale) + 'px';
    clip.style.maxWidth = '100%';
    clip.style.height = clipH + 'px';
    clip.style.overflow = 'hidden';

    stage.style.width = DESIGN.w + 'px';
    stage.style.height = designH + 'px';
    stage.style.transform = 'scale(' + scale.toFixed(4) + ')';
    stage.style.transformOrigin = 'top left';

    shell.style.overflow = isDashboardRoot(el) ? 'hidden' : 'auto';

    return scale;
  }

  function setFitModeClasses(el, on) {
    const html = document.documentElement;
    html.classList.toggle('rs-viewport-fit--app', on && isDashboardRoot(el));
    html.classList.toggle('rs-viewport-fit--landing', on && el && el.id === 'landingPage');
  }

  function applyBodyScrollLock(on) {
    const html = document.documentElement;
    if (on) {
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

  function clearViewportFit() {
    unwrapAllShells();
    wrappedRoot = null;
    if (shellResizeObs) {
      shellResizeObs.disconnect();
      shellResizeObs = null;
    }
    document.documentElement.classList.remove('rs-viewport-fit', 'rs-viewport-scaled');
    setFitModeClasses(null, false);
    clearFitTokens();
    document.body.style.removeProperty('min-height');
    applyBodyScrollLock(false);
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
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const el = getActiveRoot();
    if (!el) return;

    if (!needsFit(vw, vh, el)) {
      clearViewportFit();
      return;
    }

    if (wrappedRoot && wrappedRoot !== el) {
      unwrapAllShells();
      wrappedRoot = null;
    }

    const shell = ensureShell(el);
    if (!shell) return;

    wrappedRoot = el;
    ensureFabInAppPage();

    const scale = layoutShell(shell, el, vw, vh);
    lastFitScale = scale;

    document.documentElement.classList.add('rs-viewport-fit');
    setFitModeClasses(el, true);
    setFitTokens(scale, el, vw, vh);
    applyBodyScrollLock(true);
    syncMessengerLayout();

    if (shellResizeObs) shellResizeObs.disconnect();
    if (typeof ResizeObserver !== 'undefined') {
      const stage = shell.querySelector('.rs-viewport-stage');
      if (stage) {
        let timer;
        shellResizeObs = new ResizeObserver(() => {
          clearTimeout(timer);
          timer = setTimeout(() => {
            const vw2 = window.innerWidth;
            const vh2 = window.innerHeight;
            const s = layoutShell(shell, el, vw2, vh2);
            setFitTokens(s, el, vw2, vh2);
          }, 80);
        });
        shellResizeObs.observe(stage);
      }
    }
  }

  function scheduleViewportFit() {
    if (fitRaf) return;
    fitRaf = requestAnimationFrame(applyViewportFit);
  }

  function getCurrentScale() {
    const raw = document.documentElement.style.getPropertyValue('--rs-fit-scale');
    const parsed = parseFloat(String(raw).trim());
    return Number.isFinite(parsed) && parsed > 0 ? parsed : lastFitScale;
  }

  /* ─── Mobile drawer (native breakpoint only, not in fit mode) ─── */

  function isMobile() {
    if (isFitMode()) return false;
    return window.matchMedia('(max-width: ' + MOBILE_BP + 'px)').matches;
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
        if (toggle) toggle.click();
        else if (typeof global.applyTheme === 'function') {
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
      const node = document.getElementById(id);
      if (!node) return;
      new MutationObserver(() => scheduleViewportFit()).observe(node, {
        attributes: true,
        attributeFilter: ['style', 'class'],
      });
    });
  }

  function initResizeHandler() {
    let timer;
    const onResize = () => {
      scheduleViewportFit();
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (!isMobile()) closePagesDrawer();
        closeTopbarOverflow();
        syncMessengerLayout();
        syncTopbarQuotaDisplay();
      }, 120);
    };
    window.addEventListener('resize', onResize, { passive: true });
    window.addEventListener('orientationchange', onResize, { passive: true });
    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', onResize, { passive: true });
    }
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
