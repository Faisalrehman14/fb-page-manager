/**
 * Optimized brand logos — WebP with PNG fallback, marks loaded for CSS placeholder hide.
 */
(function () {
  'use strict';

  var WEBP_BASE = '/images/logo-';
  var PNG_BASE = '/images/logo-';
  var SIZES = { xs: 32, sm: 34, md: 38, lg: 48 };

  function pickSize(el) {
    if (el.classList.contains('fbc-logo--xs')) return 32;
    if (el.classList.contains('fbc-logo--lg')) return 64;
    var w = el.offsetWidth || 38;
    if (w <= 30) return 32;
    if (w <= 36) return 32;
    if (w <= 42) return 64;
    return 64;
  }

  function supportsWebp(cb) {
    var img = new Image();
    img.onload = function () { cb(img.width === 1); };
    img.onerror = function () { cb(false); };
    img.src =
      'data:image/webp;base64,UklGRiQAAABXRUJQVlA4IBgAAAAwAQCdASoBAAEAAwA0JaQAA3AA/vuUAAA=';
  }

  function applyLogo(img) {
    var wrap = img.closest('.fbc-logo, .nav-brand-mark, .topbar-mark');
    if (!wrap) wrap = img.parentElement;
    var px = pickSize(wrap || img);
    var webp = WEBP_BASE + px + '.webp';
    var png = PNG_BASE + px + '.png';
    var src2x = WEBP_BASE + (px <= 32 ? 64 : 128) + '.webp';

    img.width = px;
    img.height = px;
    img.decoding = 'async';
    if (img.closest('.nav, .saas-topbar, #landingPage .nav')) {
      img.fetchPriority = 'high';
    }

    supportsWebp(function (ok) {
      img.src = ok ? webp : png;
      img.srcset =
        (ok ? webp + ' ' + px + 'w, ' + src2x + ' ' + (px * 2) + 'w' : png + ' ' + px + 'w');
      img.sizes = px + 'px';
    });

    img.addEventListener('load', function onLoad() {
      img.classList.add('is-loaded');
      img.removeEventListener('load', onLoad);
    });
    if (img.complete && img.naturalWidth) img.classList.add('is-loaded');
  }

  function init() {
    document.querySelectorAll('img[data-fbc-logo]').forEach(applyLogo);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  window.FBCastLogo = { applyLogo: applyLogo };
})();
