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

  function init() {
    if (!document.getElementById('landingPage')?.classList.contains('landing-enterprise')) return;
    initNavScroll();
    initTicker();
    initSmoothAnchors();
    initDemoScroll();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
