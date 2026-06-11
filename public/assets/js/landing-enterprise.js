/**
 * Enterprise landing page — scroll effects, nav polish, ticker rotation
 */
(function () {
  'use strict';

  const TICKER_MSGS = [
    '12 businesses sent broadcasts in the last hour',
    '98% average Messenger delivery rate',
    'Enterprise teams manage 500+ pages on FBCast Pro',
    'AI assistant helped 200+ campaigns this week'
  ];
  let tickerIdx = 0;

  function initNavScroll() {
    const nav = document.querySelector('#landingPage.landing-enterprise .nav');
    if (!nav) return;
    const onScroll = () => {
      nav.classList.toggle('scrolled', window.scrollY > 24);
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
  }

  function initTicker() {
    const el = document.getElementById('activityTickerText');
    if (!el) return;
    setInterval(() => {
      tickerIdx = (tickerIdx + 1) % TICKER_MSGS.length;
      el.style.opacity = '0';
      setTimeout(() => {
        el.textContent = TICKER_MSGS[tickerIdx];
        el.style.opacity = '1';
      }, 280);
    }, 5000);
    el.style.transition = 'opacity 0.28s ease';
  }

  function initSmoothAnchors() {
    document.querySelectorAll('#landingPage.landing-enterprise a[href^="#"]').forEach((a) => {
      a.addEventListener('click', (e) => {
        const id = a.getAttribute('href').slice(1);
        const target = document.getElementById(id);
        if (!target) return;
        e.preventDefault();
        target.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
    });
  }

  function initDemoScroll() {
    const btn = document.getElementById('heroWatchDemo');
    if (!btn) return;
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      const feat = document.getElementById('features');
      if (feat) feat.scrollIntoView({ behavior: 'smooth' });
    });
  }

  function syncCompareHighlight() {
    const wrap = document.querySelector('.cmp-premium__table-wrap');
    const table = wrap?.querySelector('.cmp-premium__table');
    const highlight = wrap?.querySelector('.cmp-premium__col-highlight');
    const proCol = table?.querySelector('colgroup .cmp-premium__col--pro');
    if (!wrap || !table || !highlight) return;

    function position() {
      const proCell = table.querySelector('.cmp-premium__th--pro') || table.querySelector('.cmp-premium__td--pro');
      if (!proCell) return;
      const wrapRect = wrap.getBoundingClientRect();
      const cellRect = proCell.getBoundingClientRect();
      highlight.style.left = (cellRect.left - wrapRect.left) + 'px';
      highlight.style.width = cellRect.width + 'px';
    }

    position();
    if (typeof ResizeObserver !== 'undefined') {
      const ro = new ResizeObserver(position);
      ro.observe(table);
      if (proCol) ro.observe(proCol);
    }
    window.addEventListener('resize', position, { passive: true });
  }

  function initCompareReveal() {
    const section = document.querySelector('.cmp-premium');
    if (!section || typeof IntersectionObserver === 'undefined') {
      document.querySelectorAll('.cmp-premium__stat, .cmp-premium__card, .cmp-premium__trust').forEach((el) => {
        el.classList.add('is-visible');
      });
      return;
    }
    const stats = section.querySelectorAll('.cmp-premium__stat');
    const card = section.querySelector('.cmp-premium__card');
    const trust = section.querySelector('.cmp-premium__trust');
    const obs = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        const t = entry.target;
        if (t.classList.contains('cmp-premium__stat')) {
          const i = Array.prototype.indexOf.call(stats, t);
          t.style.transitionDelay = (i * 0.08) + 's';
        }
        t.classList.add('is-visible');
        obs.unobserve(t);
      });
    }, { threshold: 0.15, rootMargin: '0px 0px -40px 0px' });
    stats.forEach((s) => obs.observe(s));
    if (card) obs.observe(card);
    if (trust) obs.observe(trust);
  }

  function init() {
    if (!document.getElementById('landingPage')?.classList.contains('landing-enterprise')) return;
    initNavScroll();
    initTicker();
    initSmoothAnchors();
    initDemoScroll();
    initCompareReveal();
    syncCompareHighlight();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
