/**
 * Responsive shell — pages drawer, topbar overflow menu, resize cleanup
 */
(function (global) {
  'use strict';

  const MOBILE_BP = 900;
  let backdrop = null;

  function isMobile() {
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

  const TOPBAR_COMPACT_W = 960;

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
    const topbar = document.querySelector('.saas-topbar');
    const valEl = document.getElementById('quotaVal');
    const totEl = document.getElementById('quotaTotal');
    if (!topbar || !valEl) return;

    const compact = topbar.offsetWidth < TOPBAR_COMPACT_W;
    const rem = parseQuotaNum(valEl);
    const tot = parseQuotaNum(totEl);

    if (!valEl.dataset.fullValue) valEl.dataset.fullValue = String(rem);
    if (totEl && !totEl.dataset.fullValue) totEl.dataset.fullValue = String(tot);

    const fullRem = parseInt(valEl.dataset.fullValue, 10) || rem;
    const fullTot = parseInt(totEl && totEl.dataset.fullValue, 10) || tot;

    valEl.textContent = compact ? formatCompactNum(fullRem) : fullRem.toLocaleString();
    if (totEl) {
      totEl.textContent = compact ? formatCompactNum(fullTot) : fullTot.toLocaleString();
    }
  }

  function initTopbarQuotaObserver() {
    const topbar = document.querySelector('.saas-topbar');
    const valEl = document.getElementById('quotaVal');
    const totEl = document.getElementById('quotaTotal');
    if (!topbar || !valEl) return;

    const refresh = () => syncTopbarQuotaDisplay();

    if (typeof ResizeObserver !== 'undefined') {
      const ro = new ResizeObserver(refresh);
      ro.observe(topbar);
    }

    if (typeof MutationObserver !== 'undefined') {
      const mo = new MutationObserver(refresh);
      mo.observe(valEl, { characterData: true, childList: true, subtree: true });
      if (totEl) mo.observe(totEl, { characterData: true, childList: true, subtree: true });
    }

    refresh();
  }

  function initResizeHandler() {
    let timer;
    window.addEventListener('resize', () => {
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

  function init() {
    if (!document.getElementById('appPage')) return;
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

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})(window);
