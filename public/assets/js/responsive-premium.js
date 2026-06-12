/**
 * Responsive shell — proportional viewport fit, pages drawer, topbar overflow
 */
(function (global) {
  'use strict';

  const MOBILE_BP = 900;
  const DESIGN_W = 1280;
  const MIN_SCALE = 0.28;
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

  function getActiveRoot() {
    if (document.body.classList.contains('app-dashboard-active')) {
      const app = document.getElementById('appPage');
      if (app && app.style.display !== 'none') return app;
    }
    const landing = document.getElementById('landingPage');
    if (landing && landing.style.display !== 'none') return landing;
    return document.getElementById('appPage') || landing;
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
    const stage = document.createElement('div');
    stage.className = 'rs-viewport-stage';

    content.parentNode.insertBefore(shell, content);
    stage.appendChild(content);
    shell.appendChild(stage);
    return shell;
  }

  function getCurrentScale() {
    const raw = document.documentElement.style.getPropertyValue('--rs-fit-scale')
      || getComputedStyle(document.documentElement).getPropertyValue('--rs-fit-scale');
    const parsed = parseFloat(String(raw).trim());
    return Number.isFinite(parsed) && parsed > 0 ? parsed : lastFitScale;
  }

  function updateShellHeight(shell, stage, scale) {
    if (!shell || !stage) return;
    const s = scale || getCurrentScale();
    const naturalH = Math.max(stage.scrollHeight, stage.offsetHeight, stage.getBoundingClientRect().height / s);
    shell.style.height = Math.ceil(naturalH * s) + 'px';
  }

  function bindShellResizeObserver(shell, stage) {
    if (typeof ResizeObserver === 'undefined' || !shell || !stage) return;
    if (shellResizeObs) shellResizeObs.disconnect();
    let timer;
    shellResizeObs = new ResizeObserver(() => {
      clearTimeout(timer);
      timer = setTimeout(() => updateShellHeight(shell, stage), 50);
    });
    shellResizeObs.observe(stage);
  }

  function applyBodyOverflowForFit(active) {
    if (active) {
      if (document.body.dataset.rsOverflow == null) {
        document.body.dataset.rsOverflow = document.body.style.overflow || '';
      }
      document.body.style.overflowX = 'hidden';
      document.body.style.overflowY = 'auto';
    } else if (document.body.dataset.rsOverflow != null) {
      document.body.style.overflow = document.body.dataset.rsOverflow;
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
    document.documentElement.style.removeProperty('--rs-fit-scale');
    document.documentElement.style.removeProperty('--rs-viewport-scale');
    document.body.style.removeProperty('min-height');
    applyBodyOverflowForFit(false);
    lastFitScale = 1;
  }

  function applyViewportFit() {
    fitRaf = 0;
    const w = window.innerWidth;
    const scale = w >= DESIGN_W ? 1 : Math.max(MIN_SCALE, w / DESIGN_W);

    if (scale >= 1) {
      clearViewportFit();
      return;
    }

    const content = getActiveRoot();
    if (!content) return;

    if (wrappedRoot && wrappedRoot !== content) {
      unwrapAllShells();
      wrappedRoot = null;
    }

    const shell = ensureScaleShell(content);
    const stage = shell && shell.querySelector('.rs-viewport-stage');
    if (!shell || !stage) return;

    wrappedRoot = content;
    lastFitScale = scale;

    document.documentElement.classList.add('rs-viewport-fit');
    document.documentElement.style.setProperty('--rs-fit-scale', scale.toFixed(4));
    stage.style.width = DESIGN_W + 'px';
    stage.style.transformOrigin = 'top left';
    stage.style.transform = 'scale(' + scale.toFixed(4) + ')';
    applyBodyOverflowForFit(true);

    bindShellResizeObserver(shell, stage);

    requestAnimationFrame(() => {
      updateShellHeight(shell, stage, scale);
      requestAnimationFrame(() => updateShellHeight(shell, stage, scale));
      setTimeout(() => updateShellHeight(shell, stage, scale), 300);
    });
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
    if (isFitMode()) return;
    const panel = document.getElementById('msngContactPanel');
    if (!panel) return;
    if (window.innerWidth <= 1200) {
      panel.classList.remove('is-open');
      panel.setAttribute('aria-hidden', 'true');
      const toggle = document.getElementById('msngContactToggleBtn');
      if (toggle) toggle.setAttribute('aria-expanded', 'false');
    }
    const convs = document.getElementById('msngConvsCol');
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
