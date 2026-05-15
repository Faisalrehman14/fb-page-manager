const appConfig = window.APP_CONFIG || {};
if (!window.FB_CONFIG) {
  window.FB_CONFIG = { appId: appConfig.fbAppId || '', csrfToken: appConfig.csrfToken || '' };
}
const STRIPE_PUBLISHABLE_KEY = appConfig.stripePublishableKey || '';
const SITE_URL = appConfig.siteUrl || window.location.origin;
const CONTACT_EMAIL = appConfig.contactEmail || '';
const CSRF_TOKEN = appConfig.csrfToken || '';
const FB_APP_ID = appConfig.fbAppId || '';
const APP_ENV = appConfig.appEnv || 'development';
const MESSAGE_DRAFT_KEY = 'fbcast_message_draft';
const DELAY_DRAFT_KEY = 'fbcast_delay_draft';
const ANALYTICS_QUEUE_KEY = 'fbcast_analytics_queue';
const SESSION_ID_KEY = 'fbcast_session_id';
const MODAL_IDS = ['upgradeModal', 'privacyModal', 'termsModal'];
const TRACK_SYNC_MIN_INTERVAL_MS = 30000;

let _trackUserInFlight = null;
let _lastTrackUserSyncAt = 0;
let _trackUserFailureCount = 0;
let _trackUserBackoffUntil = 0;
let _networkBannerTimer = null;
let _announcementPollTimer = null;
let _announcementPollStarted = false;

// Safe stubs while modules initialize.
window.triggerConnect = window.triggerConnect || function () { showToast('Initializing Facebook login...','info'); };
window.showPaymentPopup = window.showPaymentPopup || function () { showToast('Initializing payment...','info'); };

function getSessionId() {
  let id = sessionStorage.getItem(SESSION_ID_KEY);
  if (!id) {
    id = 'sess_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
    sessionStorage.setItem(SESSION_ID_KEY, id);
  }
  return id;
}

function fbTrackEvent(name, props = {}) {
  if (!name) return;
  const payload = {
    name,
    props,
    path: window.location.pathname,
    ts: new Date().toISOString(),
    sessionId: getSessionId()
  };
  try {
    const raw = localStorage.getItem(ANALYTICS_QUEUE_KEY);
    const q = raw ? JSON.parse(raw) : [];
    q.push(payload);
    if (q.length > 200) q.splice(0, q.length - 200);
    localStorage.setItem(ANALYTICS_QUEUE_KEY, JSON.stringify(q));
  } catch (e) {}
  if (Array.isArray(window.dataLayer)) window.dataLayer.push(payload);
  window.dispatchEvent(new CustomEvent('fbcast:analytics', { detail: payload }));
}
window.trackEvent = window.trackEvent || fbTrackEvent;

const HERO_AVATAR_FALLBACKS = ['pics/p1.jpg', 'pics/p2.webp', 'pics/p3.jpeg', 'pics/p4.webp'];

function buildFacebookProfilePicUrl(fbUserId) {
  const id = String(fbUserId || '').trim();
  if (!id) return '';
  return `https://graph.facebook.com/${encodeURIComponent(id)}/picture?type=large`;
}

function applyImageWithFallback(imgEl, candidates) {
  if (!imgEl || !Array.isArray(candidates) || !candidates.length) return;
  const cleaned = candidates.filter(Boolean);
  if (!cleaned.length) return;
  let idx = 0;
  imgEl.onerror = function () {
    idx += 1;
    if (idx < cleaned.length) {
      imgEl.src = cleaned[idx];
    } else {
      imgEl.onerror = null;
    }
  };
  imgEl.src = cleaned[idx];
}

function updateHeroAvatars() {
  const avatarEls = Array.from(document.querySelectorAll('[data-hero-avatar]'));
  if (!avatarEls.length) return;

  let fbUserId = '';
  try {
    const storedUser = JSON.parse(localStorage.getItem('fbcast_user') || '{}');
    fbUserId = storedUser.fb_user_id || storedUser.id || '';
  } catch (e) {}

  const primaryProfile = buildFacebookProfilePicUrl(fbUserId);

  avatarEls.forEach(function (imgEl, index) {
    const queue = [];
    if (index === 0 && primaryProfile) queue.push(primaryProfile);
    // Pick a unique image for each avatar (rotate through fallbacks)
    const uniqueIndex = index % HERO_AVATAR_FALLBACKS.length;
    queue.push(HERO_AVATAR_FALLBACKS[uniqueIndex]);
    // Add remaining fallbacks for retry
    for (let i = 1; i < HERO_AVATAR_FALLBACKS.length; i += 1) {
      queue.push(HERO_AVATAR_FALLBACKS[(uniqueIndex + i) % HERO_AVATAR_FALLBACKS.length]);
    }
    applyImageWithFallback(imgEl, queue);
  });
}

function makeErrorId() {
  return 'ERR-' + Date.now().toString(36).toUpperCase() + '-' + Math.random().toString(36).slice(2, 6).toUpperCase();
}

const _clientErrorRecent = new Map();
const CLIENT_ERROR_DEDUPE_MS = 8000;

function reportClientError(error, context = {}) {
  const message = (error && error.message) ? error.message : String(error || 'Unknown error');
  const signature = String((context && context.source) || 'unknown') + '|' + message;
  const now = Date.now();
  const lastTs = _clientErrorRecent.get(signature) || 0;
  if ((now - lastTs) < CLIENT_ERROR_DEDUPE_MS) {
    return (error && error.__fbErrorId) ? error.__fbErrorId : 'ERR-DEDUPED';
  }
  _clientErrorRecent.set(signature, now);

  const errorId = makeErrorId();
  const detail = {
    errorId,
    message,
    stack: error && error.stack ? String(error.stack).slice(0, 1200) : '',
    context
  };
  fbTrackEvent('client_error', detail);
  if (window.Sentry && typeof window.Sentry.captureException === 'function') {
    window.Sentry.captureException(error || new Error(message), { tags: { errorId }, extra: context });
  }
  if (APP_ENV !== 'production') {
    console.error('[FBCast Error]', errorId, message, context);
  }
  if (error && typeof error === 'object') {
    error.__fbReported = true;
    error.__fbErrorId = errorId;
  }
  return errorId;
}
window.reportClientError = reportClientError;

if (!window.__fbcastErrorHooksInstalled) {
  window.__fbcastErrorHooksInstalled = true;
  window.addEventListener('error', function (event) {
    reportClientError(event.error || event.message || 'Window error', { source: 'window.error' });
  });
  window.addEventListener('unhandledrejection', function (event) {
    reportClientError(event.reason || 'Unhandled rejection', { source: 'window.unhandledrejection' });
  });
}

function delay(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

function isRetryableStatus(status) {
  return status === 408 || status === 425 || status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

function isRetryableError(err) {
  const msg = String((err && err.message) || err || '').toLowerCase();
  return msg.includes('network') || msg.includes('failed to fetch') || msg.includes('timeout') || msg.includes('temporar');
}
function isRateLimitError(err) {
  const msg = String((err && err.message) || err || '').toLowerCase();
  return (err && Number(err.status) === 429) || msg.includes('too many requests') || msg.includes('rate limit');
}

async function fetchJsonWithRetry(url, options = {}, cfg = {}) {
  const attempts = Math.max(1, Number(cfg.attempts || 3));
  const backoffMs = Math.max(150, Number(cfg.backoffMs || 500));
  const timeoutMs = Math.max(3000, Number(cfg.timeoutMs || 30000));
  let lastErr = null;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const controller = (typeof AbortController !== 'undefined') ? new AbortController() : null;
      const timer = controller ? setTimeout(function () { controller.abort(); }, timeoutMs) : null;
      const reqOptions = controller ? Object.assign({}, options, { signal: controller.signal }) : options;
      let res;
      try {
        res = await fetch(url, reqOptions);
      } finally {
        if (controller && timer) clearTimeout(timer);
      }
      const text = await res.text();
      let data = {};
      try { data = text ? JSON.parse(text) : {}; } catch (e) { data = { raw: text }; }
      if (!res.ok) {
        if (res.status === 403 && data && data.error === 'Invalid CSRF token' && !options._isRetry) {
          if (typeof window.getCsrfToken === 'function') {
            const newToken = await window.getCsrfToken(true);
            if (newToken) {
              const newOptions = Object.assign({}, options, { _isRetry: true });
              newOptions.headers = Object.assign({}, options.headers || {}, { 'X-CSRF-Token': newToken });
              return fetchJsonWithRetry(url, newOptions, cfg);
            }
          }
        }
        const errMsg = (data && (data.error || data.message))
          ? (typeof data.error === 'object' ? JSON.stringify(data.error) : data.error || data.message)
          : `Request failed (${res.status})`;
        const err = new Error(errMsg);
        err.status = res.status;
        err.data = data;
        throw err;
      }
      return data;
    } catch (err) {
      if (err && err.name === 'AbortError') {
        err = new Error(`Request timeout after ${Math.round(timeoutMs / 1000)}s`);
      }
      lastErr = err;
      const shouldRetry = attempt < attempts && (isRetryableStatus(err.status) || isRetryableError(err));
      if (!shouldRetry) break;
      const jitter = Math.floor(Math.random() * 180);
      await delay((backoffMs * attempt) + jitter);
    }
  }
  throw lastErr || new Error('Request failed');
}
window.fetchJsonWithRetry = fetchJsonWithRetry;

async function requestTrackUserWithBackoff(userToken, options = {}) {
  const background = !!options.background;
  const silent = !!options.silent;
  if (!userToken) return null;

  if (background && Date.now() < _trackUserBackoffUntil) {
    return null;
  }

  const csrfToken = await getCsrfToken();
  try {
    const data = await fetchJsonWithRetry('track_user.php', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
      body: JSON.stringify({ user_token: userToken })
    }, {
      attempts: background ? 2 : 3,
      backoffMs: background ? 600 : 500,
      timeoutMs: background ? 25000 : 30000
    });

    _trackUserFailureCount = 0;
    _trackUserBackoffUntil = 0;
    if (background || silent) {
      hideNetworkBanner();
    }
    return data;
  } catch (e) {
    _trackUserFailureCount += 1;
    const holdMs = Math.min(120000, 8000 * _trackUserFailureCount);
    const rateLimited = isRateLimitError(e);
    const holdFor = rateLimited ? Math.max(30000, holdMs) : holdMs;
    _trackUserBackoffUntil = Date.now() + holdFor;
    if (background || silent) {
      showNetworkBanner(
        'banner-recovering',
        rateLimited
          ? 'Server rate limit reached. Auto-retrying shortly…'
          : 'Server unstable. Auto-retrying in background…'
      );
    }
    if (!silent && !rateLimited) {
      reportClientError(e, { source: options.source || 'track_user' });
    }
    throw e;
  }
}

async function runWithRetryUI(task, opts = {}) {
  const maxAttempts = Math.max(1, Number(opts.maxAttempts || 2));
  const label = opts.label || 'request';
  let lastErr = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await task(attempt);
    } catch (err) {
      lastErr = err;
      const errorId = reportClientError(err, { label, attempt, maxAttempts });
      if (attempt >= maxAttempts) {
        showToast(`${label} failed (${errorId}).`, 'error');
        break;
      }
      showToast(`${label} failed, retrying… (${attempt}/${maxAttempts - 1})`, 'warning');
    }
  }
  throw lastErr || new Error(label + ' failed');
}

var modalState = { activeId: null, lastFocused: null };

function getFocusableElements(container) {
  if (!container) return [];
  return Array.from(container.querySelectorAll(
    'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'
  )).filter(function (el) { return el.offsetParent !== null; });
}

function openModal(modalId, triggerEl) {
  const overlay = document.getElementById(modalId);
  if (!overlay) return;
  MODAL_IDS.forEach(function (id) {
    const m = document.getElementById(id);
    if (m && id !== modalId) {
      m.style.display = 'none';
      m.setAttribute('aria-hidden', 'true');
    }
  });
  modalState.lastFocused = triggerEl || document.activeElement;
  modalState.activeId = modalId;
  overlay.style.display = 'flex';
  overlay.setAttribute('aria-hidden', 'false');
  const focusables = getFocusableElements(overlay);
  if (focusables.length) focusables[0].focus();
}

function closeModal(modalId, restoreFocus) {
  const overlay = document.getElementById(modalId);
  if (!overlay) return;
  overlay.style.display = 'none';
  overlay.setAttribute('aria-hidden', 'true');
  if (modalState.activeId === modalId) {
    modalState.activeId = null;
    if (restoreFocus !== false && modalState.lastFocused && typeof modalState.lastFocused.focus === 'function') {
      modalState.lastFocused.focus();
    }
  }
}

function closeAllModals() {
  MODAL_IDS.forEach(function (id) { closeModal(id, false); });
  if (modalState.lastFocused && typeof modalState.lastFocused.focus === 'function') {
    modalState.lastFocused.focus();
  }
  modalState.activeId = null;
}

window.openUpgradeModal = function (triggerEl) {
  openModal('upgradeModal', triggerEl || document.activeElement);
  fbTrackEvent('upgrade_modal_open', { source: 'manual' });
};

var triggerLogout = function(){
  ['fb_user_token','fbcast_user','fbcast_quota','promo_theme'].forEach(k=>localStorage.removeItem(k));
  sessionStorage.clear();
  hideAnnouncementBar();
  window.location.assign(window.location.origin+window.location.pathname);
};

var showToast=function(msg,type='error'){
  if(!msg||typeof msg!=='string')return;
  const appPage=document.getElementById('appPage');
  const appVisible=!!(appPage&&appPage.style.display!=='none');
  if(appVisible&&type!=='error'&&typeof window.showStatus==='function'){
    const statusType=(type==='success'||type==='warning'||type==='info')?type:'info';
    window.showStatus(msg,statusType);
    return;
  }
  const c={error:'#ef4444',success:'#10b981',warning:'#f59e0b',info:'#2563eb'};
  const ic={error:'fa-circle-xmark',success:'fa-circle-check',warning:'fa-triangle-exclamation',info:'fa-circle-info'};
  const t=document.createElement('div');
  t.className='toast';t.style.background=c[type]||c.error;
  t.innerHTML=`<i class="fas ${ic[type]||ic.error}" style="font-size:14px;"></i><span>${String(msg).replace(/</g,'&lt;').replace(/>/g,'&gt;').slice(0,250)}</span>`;
  if(document.body)document.body.appendChild(t);
  setTimeout(()=>{t.style.opacity='0';t.style.transition='opacity .3s';setTimeout(()=>{if(t.parentNode)t.parentNode.removeChild(t);},300);},4500);
};

function showNetworkBanner(type, message, autoHideMs) {
  const banner = document.getElementById('networkBanner');
  if (!banner) return;
  clearTimeout(_networkBannerTimer);
  banner.hidden = false;
  banner.textContent = message || '';
  banner.classList.remove('banner-offline', 'banner-recovering', 'banner-online');
  banner.classList.add(type || 'banner-recovering');
  if (autoHideMs && autoHideMs > 0) {
    _networkBannerTimer = setTimeout(function () {
      banner.hidden = true;
    }, autoHideMs);
  }
}

function hideNetworkBanner() {
  const banner = document.getElementById('networkBanner');
  if (!banner) return;
  clearTimeout(_networkBannerTimer);
  banner.hidden = true;
}

function isValidHttpUrl(value) {
  if (!value) return false;
  try {
    const u = new URL(value, window.location.origin);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch (e) {
    return false;
  }
}

function hideAnnouncementBar() {
  const bar = document.getElementById('announcementBar');
  if (bar) bar.hidden = true;
}

function renderAnnouncementBar(data) {
  const bar = document.getElementById('announcementBar');
  const mediaWrap = document.getElementById('announcementMediaWrap');
  const textTrack = document.getElementById('announcementTextTrack');
  const cta = document.getElementById('announcementCta');
  if (!bar || !mediaWrap || !textTrack || !cta) return;

  if (!data || !data.active || !data.enabled) {
    hideAnnouncementBar();
    return;
  }

  const type = String(data.type || 'text').toLowerCase();
  const text = String(data.text || '').trim();
  const mediaUrl = String(data.media_url || '').trim();
  const linkUrl = String(data.link_url || '').trim();

  if (!text && !mediaUrl) {
    hideAnnouncementBar();
    return;
  }

  mediaWrap.innerHTML = '';
  mediaWrap.style.display = 'none';

  if ((type === 'image' || type === 'video') && isValidHttpUrl(mediaUrl)) {
    if (type === 'image') {
      const img = document.createElement('img');
      img.src = mediaUrl;
      img.alt = text || 'Announcement';
      img.loading = 'lazy';
      mediaWrap.appendChild(img);
      mediaWrap.style.display = 'block';
    } else {
      const video = document.createElement('video');
      video.src = mediaUrl;
      video.muted = true;
      video.loop = true;
      video.autoplay = true;
      video.playsInline = true;
      video.preload = 'metadata';
      mediaWrap.appendChild(video);
      mediaWrap.style.display = 'block';
      video.play().catch(function(){});
    }
  }

  const tickerText = text || (type === 'video' ? 'New video update available' : 'New update available');
  textTrack.innerHTML = '';
  textTrack.classList.remove('is-marquee');
  textTrack.style.animationDuration = '';

  // Build a seamless marquee by duplicating the same text node.
  const runA = document.createElement('span');
  runA.className = 'announcement-run';
  runA.textContent = tickerText;

  const runB = document.createElement('span');
  runB.className = 'announcement-run';
  runB.textContent = tickerText;
  runB.setAttribute('aria-hidden', 'true');

  textTrack.appendChild(runA);
  textTrack.appendChild(runB);

  const duration = Math.max(10, Math.min(32, Math.round(tickerText.length / 3.6)));
  textTrack.classList.add('is-marquee');
  textTrack.style.animationDuration = duration + 's';

  if (isValidHttpUrl(linkUrl)) {
    cta.href = linkUrl;
    cta.hidden = false;
  } else {
    cta.hidden = true;
    cta.removeAttribute('href');
  }

  bar.hidden = false;
}

async function fetchTopbarAnnouncement(options = {}) {
  if (options.background && document.hidden) return;
  try {
    const data = await fetchJsonWithRetry('admin.php?action=announcement', {
      method: 'GET',
      headers: { 'Accept': 'application/json' }
    }, {
      attempts: options.background ? 1 : 2,
      backoffMs: 400,
      timeoutMs: 12000
    });
    renderAnnouncementBar(data || {});
  } catch (e) {
    if (!options.background) {
      reportClientError(e, { source: 'fetchTopbarAnnouncement' });
    }
  }
}

function startAnnouncementPolling() {
  if (_announcementPollStarted) return;
  _announcementPollStarted = true;
  fetchTopbarAnnouncement({ background: true });
  _announcementPollTimer = setInterval(function () {
    fetchTopbarAnnouncement({ background: true });
  }, 60000);
}

var _csrfToken=null;
var getCsrfToken=async function(){
  if(_csrfToken)return _csrfToken;
  try{
    const r=await fetch('get_csrf.php',{credentials:'same-origin',method:'GET'});
    if(!r.ok)throw new Error('CSRF fetch failed with status '+r.status);
    const d=await r.json();
    _csrfToken=d.token||'';
  }catch(e){
    _csrfToken='';
  }
  return _csrfToken;
};
getCsrfToken();

function closeMobileMenu() {
  const menu = document.getElementById('mobileMenu');
  if (menu) menu.classList.remove('open');
  const navHamburger = document.getElementById('navHamburger');
  if (navHamburger) navHamburger.setAttribute('aria-expanded', 'false');
}

(function initNavScroll() {
  const nav = document.querySelector('.nav');
  if (!nav) return;
  const onScroll = function () {
    nav.classList.toggle('scrolled', window.scrollY > 20);
  };
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();
})();

function restoreComposerDraft() {
  const messageEl = document.getElementById('messageText');
  const delayEl = document.getElementById('delayMs');
  if (messageEl) {
    const savedMessage = localStorage.getItem(MESSAGE_DRAFT_KEY);
    if (savedMessage && !messageEl.value) messageEl.value = savedMessage;
    updateCharBar(messageEl.value.length);
  }
  if (delayEl) {
    const savedDelay = parseInt(localStorage.getItem(DELAY_DRAFT_KEY) || '', 10);
    if (!Number.isNaN(savedDelay) && savedDelay >= 500) delayEl.value = String(savedDelay);
  }
}

function updateCharBar(len) {
  const countEl = document.getElementById('charCount');
  const fillEl = document.getElementById('charCountFill');
  if (countEl) countEl.textContent = len + ' / 2000';
  if (fillEl) {
    const pct = Math.min(100, (len / 2000) * 100);
    fillEl.style.width = pct + '%';
    fillEl.className = 'char-count-fill' + (pct >= 100 ? ' danger' : pct >= 80 ? ' warn' : '');
  }
}

function persistComposerDraft() {
  const messageEl = document.getElementById('messageText');
  const delayEl = document.getElementById('delayMs');
  if (messageEl) {
    localStorage.setItem(MESSAGE_DRAFT_KEY, messageEl.value.slice(0, 2000));
    updateCharBar(messageEl.value.length);
  }
  if (delayEl) {
    const delay = Math.max(500, parseInt(delayEl.value || '1200', 10) || 1200);
    localStorage.setItem(DELAY_DRAFT_KEY, String(delay));
  }
}

function applyDelayPreset(delay) {
  const normalized = String(Math.max(500, parseInt(delay || '1200', 10) || 1200));
  const delayInput = document.getElementById('delayMs');
  if (delayInput) delayInput.value = normalized;
  document.querySelectorAll('.delay-preset').forEach(function (btn) {
    btn.classList.toggle('active', btn.getAttribute('data-delay') === normalized);
  });
}

function initDelayPresetControls() {
  const delayInput = document.getElementById('delayMs');
  const presetButtons = document.querySelectorAll('.delay-preset');
  if (!delayInput || !presetButtons.length) return;

  const current = delayInput.value || localStorage.getItem(DELAY_DRAFT_KEY) || '1200';
  applyDelayPreset(current);

  presetButtons.forEach(function (btn) {
    btn.addEventListener('click', function () {
      const presetDelay = this.getAttribute('data-delay') || '1200';
      applyDelayPreset(presetDelay);
      persistComposerDraft();
    });
  });
}

async function autoLoadPagesAfterLogin() {
  // First preference: shared loader from web_ui.js
  if (typeof window.loadPagesFromFacebook === 'function') {
    return window.loadPagesFromFacebook({ silent: false });
  }

  // Fallback path if web_ui loader is not available for any reason.
  if (typeof window.fetchUserPages === 'function') {
    const pages = await window.fetchUserPages();
    if (pages && typeof window.renderPages === 'function') {
      window.renderPages(pages);
    }
    return pages || [];
  }

  return [];
}

document.addEventListener('DOMContentLoaded', function () {
  const navHamburger = document.getElementById('navHamburger');
  const mobileMenuClose = document.getElementById('mobileMenuClose');
  const mobileMenu = document.getElementById('mobileMenu');

  if (navHamburger) {
    navHamburger.setAttribute('aria-expanded', 'false');
    navHamburger.addEventListener('click', function () {
      if (mobileMenu) {
        mobileMenu.classList.add('open');
        navHamburger.setAttribute('aria-expanded', 'true');
      }
    });
  }
  if (mobileMenuClose) {
    mobileMenuClose.addEventListener('click', function () {
      closeMobileMenu();
      if (navHamburger) navHamburger.setAttribute('aria-expanded', 'false');
    });
  }
  if (mobileMenu) {
    mobileMenu.addEventListener('click', function (e) {
      if (e.target === mobileMenu) closeMobileMenu();
    });
  }
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && mobileMenu?.classList.contains('open')) closeMobileMenu();
  });

  // FAQ accordion
  document.querySelectorAll('.faq-q').forEach(function (q) {
    q.addEventListener('click', function () {
      var item = this.parentElement;
      var isOpen = item.classList.contains('open');
      document.querySelectorAll('.faq-item.open').forEach(function (i) { i.classList.remove('open'); });
      if (!isOpen) item.classList.add('open');
    });
  });

  // Lightweight scroll-reveal for a more premium feel without heavy JS.
  const revealTargets = document.querySelectorAll('.feat, .step, .testimonial');
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    revealTargets.forEach(function (el) { el.classList.add('is-visible'); });
  } else if ('IntersectionObserver' in window) {
    const io = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          entry.target.classList.add('is-visible');
          io.unobserve(entry.target);
        }
      });
    }, { threshold: 0.12, rootMargin: '0px 0px -6% 0px' });
    revealTargets.forEach(function (el) { io.observe(el); });
  } else {
    revealTargets.forEach(function (el) { el.classList.add('is-visible'); });
  }

  if (!navigator.onLine) {
    showNetworkBanner('banner-offline', 'No internet connection. Requests will retry automatically.');
  }
  window.addEventListener('offline', function () {
    showNetworkBanner('banner-offline', 'No internet connection. Requests will retry automatically.');
  });
  window.addEventListener('online', function () {
    showNetworkBanner('banner-online', 'Connection restored.', 2500);
  });
});

/* ════════════════════════════════
   QUOTA SYSTEM
════════════════════════════════ */
const QUOTA_KEY='fbcast_quota';
const FREE_LIMIT=2000;

function getQuota(){
  try{
    const raw=localStorage.getItem(QUOTA_KEY);
    if(!raw)return{subscriptionStatus:'free',messageLimit:FREE_LIMIT,messagesUsed:0};
    const q=JSON.parse(raw);
    return{
      subscriptionStatus:q.subscriptionStatus||q.plan||'free',
      messageLimit:typeof q.messageLimit==='number'?q.messageLimit:typeof q.limit==='number'?q.limit:typeof q.messages_limit==='number'?q.messages_limit:FREE_LIMIT,
      messagesUsed:typeof q.messagesUsed==='number'?q.messagesUsed:typeof q.used==='number'?q.used:typeof q.messages_used==='number'?q.messages_used:0,
    };
  }catch(_){return{subscriptionStatus:'free',messageLimit:FREE_LIMIT,messagesUsed:0}}
}

function saveQuota(raw){
  const q={
    subscriptionStatus:raw.subscriptionStatus||raw.plan||'free',
    messageLimit:typeof raw.messageLimit==='number'?raw.messageLimit:typeof raw.limit==='number'?raw.limit:typeof raw.messages_limit==='number'?raw.messages_limit:FREE_LIMIT,
    messagesUsed:typeof raw.messagesUsed==='number'?raw.messagesUsed:typeof raw.used==='number'?raw.used:typeof raw.messages_used==='number'?raw.messages_used:0,
  };
  localStorage.setItem(QUOTA_KEY,JSON.stringify(q));
}

function getRemaining(){
  const q=getQuota();
  return Math.max(0,q.messageLimit-q.messagesUsed);
}

async function syncQuotaFromServer(options = {}){
  const force = !!options.force;
  const background = !!options.background;
  const silent = !!options.silent;

  if (background && document.hidden) return false;
  if (background && !navigator.onLine) return false;
  if (!force && (Date.now() - _lastTrackUserSyncAt) < TRACK_SYNC_MIN_INTERVAL_MS) return true;
  if (_trackUserInFlight) return _trackUserInFlight;

  const storedToken=localStorage.getItem('fb_user_token');
  if(!storedToken)return false;
  _trackUserInFlight = (async function () {
    try{
    const tokenData=JSON.parse(storedToken);
    if(!tokenData.token)return false;
    const data = await requestTrackUserWithBackoff(tokenData.token, {
      background,
      silent,
      source: options.source || 'syncQuotaFromServer'
    });
    if (!data) return false;
    if(data.success){
      saveQuota(data);
      localStorage.setItem('fbcast_user',JSON.stringify({fb_user_id:data.fb_user_id,fb_name:data.fb_name}));
      updateQuotaUI();
      updateHeroAvatars();
      _lastTrackUserSyncAt = Date.now();
      return true;
    }
  }catch(e){
    const msg = String((e && e.message) || '').toLowerCase();
    if (msg.includes('facebook token verification failed') && typeof triggerLogout === 'function') {
      triggerLogout();
      return false;
    }
    if (!silent && !(e && e.__fbReported)) {
      reportClientError(e, { source: options.source || 'syncQuotaFromServer' });
    }
  }
  return false;
  })();

  try {
    return await _trackUserInFlight;
  } finally {
    _trackUserInFlight = null;
  }
}

function consumeQuota(count){
  const q=getQuota();
  q.messagesUsed=Math.min(q.messageLimit,q.messagesUsed+count);
  saveQuota(q);updateQuotaUI();
  if(q.messagesUsed>=q.messageLimit){showUpgradeModal('pro_exhausted');return false;}
  return true;
}

function updateQuotaUI(){
  const q=getQuota();
  const rem=Math.max(0,q.messageLimit-q.messagesUsed);
  const pct=q.messageLimit>0?rem/q.messageLimit:0;
  const valEl=document.getElementById('quotaVal');
  const totEl=document.getElementById('quotaTotal');
  const badgeEl=document.getElementById('planBadge');
  const emptyEl=document.getElementById('quotaEmptyOverlay');
  const widgetEl=document.querySelector('.quota-widget');
  if(!valEl) return;
  
  valEl.style.transition='none';
  valEl.style.color='#60a5fa';
  valEl.textContent=rem.toLocaleString();
  setTimeout(()=>{valEl.style.transition='color 0.3s';valEl.style.color='';},50);
  if(totEl)totEl.textContent=q.messageLimit.toLocaleString();
  if(badgeEl){
    const plan=(q.subscriptionStatus||'free').toLowerCase();
    const isPro=plan==='pro';
    const isBasic=plan==='basic';
    const label=isPro?'Pro':(isBasic?'Basic':'Free');
    const icon=isPro?'fa-crown':(isBasic?'fa-layer-group':'fa-gem');
    const planKey=isPro?'pro':(isBasic?'basic':'free');
    badgeEl.setAttribute('data-plan', planKey);
    badgeEl.innerHTML=`<i class="fa-solid ${icon}" aria-hidden="true"></i><span>${label}</span>`;
    if(isPro){badgeEl.style.cssText='background:linear-gradient(135deg,rgba(79,70,229,.3),rgba(24,119,242,.2));color:#818cf8;border-color:rgba(79,70,229,.3)'}
    else if(isBasic){badgeEl.style.cssText='background:rgba(24,119,242,.15);color:#60a5fa;border-color:rgba(24,119,242,.2)'}
    else{badgeEl.style.cssText='background:rgba(255,255,255,.06);color:var(--text2);border-color:rgba(255,255,255,.12)'}
  }
  if(emptyEl)emptyEl.style.display=rem<=0?'flex':'none';
  if(widgetEl){
    widgetEl.classList.toggle('is-empty', rem<=0);
    widgetEl.title=rem<=0?'Quota exhausted. Click to upgrade.':'Messages remaining this month';
    widgetEl.onclick=rem<=0?function(){
      if(typeof openUpgradeModal==='function')openUpgradeModal(widgetEl);
      else{
        const modal=document.getElementById('upgradeModal');
        if(modal)modal.style.display='flex';
      }
    }:null;
  }
  valEl.className='quota-num'+(pct<.1?' danger':pct<.3?' warn':'');
}

// Expose to global scope so fb_api.js can call them
window.saveQuota = saveQuota;
window.updateQuotaUI = updateQuotaUI;
window.syncQuotaFromServer = syncQuotaFromServer;

function showUpgradeModal(reason){
  const q=getQuota();
  const h2=document.getElementById('upgradeModalTitle');
  const sub=document.getElementById('upgradeModalSub');
  if(h2)h2.textContent=reason==='pro_exhausted'?`All ${q.messageLimit.toLocaleString()} messages used!`:q.subscriptionStatus==='free'?'Free Trial Ended — Upgrade to Continue':'Upgrade Your Plan';
  if(sub)sub.textContent='Pay securely with your card. SSL-encrypted checkout.';
  openModal('upgradeModal', document.activeElement);
  fbTrackEvent('upgrade_modal_open', { reason: reason || 'manual' });
}

/* Payment popup */
window.showPaymentPopup=async function(plan){
  fbTrackEvent('checkout_start', { plan: plan || 'unknown' });
  const userData=JSON.parse(localStorage.getItem('fbcast_user')||'{}');
  if(!userData.fb_user_id){
    sessionStorage.setItem('fbcast_pending_plan',plan);
    closeModal('upgradeModal');
    fbTrackEvent('checkout_needs_login', { plan: plan || 'unknown' });
    await triggerConnect(plan); return;
  }
  sessionStorage.removeItem('fbcast_pending_plan');
  closeModal('upgradeModal');
  showToast('Opening secure payment form…','info');
  try{
    const csrfToken=await getCsrfToken();
    const data=await runWithRetryUI(async function() {
      return fetchJsonWithRetry('create_checkout.php',{
        method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':csrfToken},
        body:JSON.stringify({plan,fb_user_id:userData.fb_user_id,csrf_token:csrfToken}),
      },{attempts:2,backoffMs:500});
    }, { label: 'Checkout session', maxAttempts: 2 });
    if(data.error)throw new Error(data.error);
    if(data.url){
      fbTrackEvent('checkout_redirect', { plan: plan || 'unknown' });
      window.location.assign(data.url);
      return;
    }
    throw new Error('Payment session creation failed');
  }catch(err){
    fbTrackEvent('checkout_error', { plan: plan || 'unknown', message: err.message || 'network_error' });
    showToast('Payment Error: '+(err.message||'Network error'),'error');
  }
};

/* Payment redirect handler */
(function(){
  const params=new URLSearchParams(window.location.search);
  const pmt=params.get('payment');
  if(!pmt)return;
  window.history.replaceState({},document.title,window.location.origin+window.location.pathname);
  const resetBtns=()=>{
    ['heroConnectBtn','navConnectBtn','pricingFreeBtn','pricingBasicBtn','pricingProBtn'].forEach(id=>{
      const b=document.getElementById(id);
      if(b){b.classList.remove('loading');b.disabled=false;}
    });
  };
  resetBtns();
  if(pmt==='success'){
    fbTrackEvent('checkout_result', { status: 'success' });
    const tokenData=JSON.parse(localStorage.getItem('fb_user_token')||'{}');
    if(tokenData.token){
      window.addEventListener('load',async()=>{
        try{
          const csrfToken=await getCsrfToken();
          const data=await fetchJsonWithRetry('track_user.php',{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':csrfToken},body:JSON.stringify({user_token:tokenData.token})},{attempts:2,backoffMs:450});
          if(data.success){
            localStorage.setItem('fbcast_user',JSON.stringify({fb_user_id:data.fb_user_id,fb_name:data.fb_name}));
            saveQuota(data);
            updateHeroAvatars();
            document.getElementById('landingPage').style.display='none';
            document.getElementById('appPage').style.display='flex';
            document.body.style.overflow='hidden';
            applyTheme();updateQuotaUI();
            if(typeof setLoginOnline==='function')setLoginOnline();
            setTimeout(()=>showToast(`Plan activated! ${(data.messageLimit||data.messages_limit||data.limit||0).toLocaleString()} messages ready.`,'success'),600);
            fbTrackEvent('checkout_activation_complete', { status: 'success' });
          }
        }catch(e){
          reportClientError(e, { source: 'payment_success_track_user' });
        }
      });
    }else{
      document.addEventListener('DOMContentLoaded',()=>{
        showToast('Payment successful! Connect with Facebook to continue.','success');
        const proceed = window.confirm('Payment successful. Do you want to connect with Facebook now to activate your account?');
        if (proceed && typeof triggerConnect === 'function') {
          triggerConnect();
          return;
        }
        const connectBtn = document.getElementById('heroConnectBtn') || document.getElementById('navConnectBtn');
        if (connectBtn) {
          connectBtn.scrollIntoView({ behavior: 'smooth', block: 'center' });
          connectBtn.focus({ preventScroll: true });
        }
      });
    }
  }else if(pmt==='cancelled'){
    fbTrackEvent('checkout_result', { status: 'cancelled' });
    document.addEventListener('DOMContentLoaded',()=>showToast('Payment cancelled.','warning'));
  }else if(pmt==='error'){
    const reason=params.get('reason')||'unknown';
    fbTrackEvent('checkout_result', { status: 'error', reason });
    const msgs={invalid_params:'Verification failed.',stripe_unreachable:'Could not reach payment processor.',not_paid:'Payment not completed.',mismatch:'Security mismatch.'};
    document.addEventListener('DOMContentLoaded',()=>showToast(msgs[reason]||'Payment error. Contact support.','error'));
  }
})();

/* DOM READY */
document.addEventListener('DOMContentLoaded',async()=>{
  startAnnouncementPolling();
  updateHeroAvatars();
  restoreComposerDraft();
  initDelayPresetControls();
  document.getElementById('messageText')?.addEventListener('input', persistComposerDraft);
  document.getElementById('delayMs')?.addEventListener('change', persistComposerDraft);

  // Quick Templates — click to insert into textarea
  document.querySelectorAll('.tpl-item').forEach(function(item) {
    item.addEventListener('click', function() {
      const txt = item.getAttribute('data-tpl');
      const ta = document.getElementById('messageText');
      if (ta && txt) {
        ta.value = txt;
        ta.focus();
        updateCharBar(txt.length);
        if (typeof persistComposerDraft === 'function') persistComposerDraft();
        if (typeof window.showToast === 'function') window.showToast('Template inserted', 'success');
      }
    });
  });

  // Retry Failed — reset failed recipients to pending and restart
  document.getElementById('btnRetryFailed')?.addEventListener('click', function() {
    if (typeof window.allRecipients === 'undefined') return;
    window.allRecipients.forEach(function(r) { if (r.status === 'failed') r.status = 'pending'; });
    if (typeof window.renderRecipients === 'function') window.renderRecipients();
    if (typeof window.updateStats === 'function') window.updateStats();
    if (typeof window.showToast === 'function') window.showToast('Failed messages reset to pending. Click Start Broadcast to retry.', 'info');
  });

  // Export CSV
  document.getElementById('btnExportCSV')?.addEventListener('click', function() {
    const recs = window.allRecipients || [];
    if (!recs.length) return;
    const rows = [['PSID','Status','Error']].concat(recs.map(function(r) {
      return [r.id, r.status || 'pending', (r.error || '').replace(/,/g,' ')];
    }));
    const csv = rows.map(function(r) { return r.join(','); }).join('\n');
    const blob = new Blob([csv], {type:'text/csv'});
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'fbcast-results-' + new Date().toISOString().slice(0,10) + '.csv';
    a.click();
    if (typeof window.showToast === 'function') window.showToast('CSV exported successfully', 'success');
  });

  updateQuotaUI();

  // Auto-restore session after page refresh
  await (async function(){
    const storedToken=localStorage.getItem('fb_user_token');
    if(!storedToken)return;
    try{
      const tokenData=JSON.parse(storedToken);
      if(!tokenData.token)return;
      document.getElementById('landingPage').style.display='none';
      document.getElementById('appPage').style.display='flex';
      document.body.style.overflow='hidden';
      applyTheme();
      if(typeof setLoginOnline==='function')setLoginOnline();
      // Show cached pages immediately so UI is not blank
      const cachedPages=JSON.parse(localStorage.getItem('fb_pages')||'[]');
      if(cachedPages.length&&typeof window.renderPages==='function'){
        window.renderPages(cachedPages);
      }
      // Always fetch fresh pages from server
      try {
        await autoLoadPagesAfterLogin();
      } catch (e) {
        reportClientError(e, { source: 'auto_restore_pages' });
        if (typeof window.showStatus === 'function') {
          window.showStatus('Could not load pages automatically. Please re-login once.', 'warning');
        }
        showToast('Pages load failed: ' + (e.message || 'Unknown error'), 'error');
      }
    }catch(_){}
  })();

  // Ensure quota is fresh from server on load
  await syncQuotaFromServer({ force: true, source: 'dom_ready_sync' });

  fbTrackEvent('page_view', { page: 'landing_or_app' });

  document.getElementById('upgradeUnlimitedBtn')?.addEventListener('click',()=>{
    fbTrackEvent('checkout_unlimited_click', { source: 'upgrade_modal', plan: 'unlimited' });
  });
  document.getElementById('modalDismiss')?.addEventListener('click',()=>{
    closeModal('upgradeModal');
    fbTrackEvent('upgrade_modal_dismiss', { source: 'dismiss_button' });
  });

  /* Close overlays on backdrop click */
  MODAL_IDS.forEach(id=>{
    const m=document.getElementById(id);
    m?.addEventListener('click',e=>{
      if(e.target===m){
        closeModal(id);
        fbTrackEvent('modal_close', { modal: id, reason: 'backdrop' });
      }
    });
  });
  document.getElementById('privacyClose')?.addEventListener('click',()=>{
    closeModal('privacyModal');
    fbTrackEvent('modal_close', { modal: 'privacyModal', reason: 'close_button' });
  });
  document.getElementById('termsClose')?.addEventListener('click',()=>{
    closeModal('termsModal');
    fbTrackEvent('modal_close', { modal: 'termsModal', reason: 'close_button' });
  });
  document.getElementById('footerPrivacyBtn')?.addEventListener('click',e=>{
    e.preventDefault();
    openModal('privacyModal', e.currentTarget);
    fbTrackEvent('modal_open', { modal: 'privacyModal', source: 'footer' });
  });
  document.getElementById('footerTermsBtn')?.addEventListener('click',e=>{
    e.preventDefault();
    openModal('termsModal', e.currentTarget);
    fbTrackEvent('modal_open', { modal: 'termsModal', source: 'footer' });
  });

  [
    ['heroConnectBtn', 'hero', 'free'],
    ['navConnectBtn', 'nav', 'free'],
    ['pricingFreeBtn', 'pricing', 'free'],
    ['pricingBasicBtn', 'pricing', 'basic'],
    ['pricingProBtn', 'pricing', 'pro']
  ].forEach(function (row) {
    const id = row[0], location = row[1], plan = row[2];
    document.getElementById(id)?.addEventListener('click', function () {
      fbTrackEvent('cta_click', { id, location, plan });
    });
  });

  /* Quota guard on broadcast start - sync from server first */
  const quotaGuard=async(e)=>{
    // Force sync before starting to ensure we have fresh server data
    const synced = await syncQuotaFromServer({ force: true, source: 'quota_guard' });
    const remaining = getRemaining();
    if(remaining<=0){
      e.stopImmediatePropagation();
      showToast('No messages remaining in your quota. Please upgrade.','error');
      showUpgradeModal('pro_exhausted');
      return false;
    }
    if(remaining<10){
      showToast(`⚠️ Only ${remaining} messages remaining!`,'warning');
    }
  };
  document.getElementById('btnStart')?.addEventListener('click',quotaGuard,true);
  document.getElementById('btnAutoStart')?.addEventListener('click',quotaGuard,true);

  /* Keyboard modal support: Escape + focus trap */
  document.addEventListener('keydown',e=>{
    const activeModalId = modalState.activeId;
    if(!activeModalId) return;
    const modal = document.getElementById(activeModalId);
    if(!modal) return;

    if(e.key==='Escape'){
      closeModal(activeModalId);
      fbTrackEvent('modal_close', { modal: activeModalId, reason: 'escape' });
      return;
    }
    if(e.key==='Tab'){
      const focusable = getFocusableElements(modal);
      if(!focusable.length){
        e.preventDefault();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const activeEl = document.activeElement;
      if(e.shiftKey && activeEl === first){
        e.preventDefault();
        last.focus();
      }else if(!e.shiftKey && activeEl === last){
        e.preventDefault();
        first.focus();
      }
    }
  });
});

/* triggerConnect */
window.triggerConnect = async function(plan = null) {
  try {
    if (!plan) {
      const pendingPlan = sessionStorage.getItem('fbcast_pending_plan');
      if (pendingPlan) plan = pendingPlan;
    }
    fbTrackEvent('login_attempt', { plan: plan || 'free' });
    
    const heroBtn = document.getElementById('heroConnectBtn');
    if (heroBtn && heroBtn.classList.contains('loading')) return;

    const storedToken = localStorage.getItem('fb_user_token');
    const storedUser = localStorage.getItem('fbcast_user');

    if (storedToken && storedUser) {
      // User is already logged in, show app page immediately
      document.getElementById('landingPage').style.display = 'none';
      document.getElementById('appPage').style.display = 'flex';
      document.body.style.overflow = 'hidden';
      applyTheme();
      if (typeof setLoginOnline === 'function') setLoginOnline();
      
      const _cachedPages = JSON.parse(localStorage.getItem('fb_pages') || '[]');
      if (_cachedPages.length && typeof window.renderPages === 'function') {
        window.renderPages(_cachedPages);
      }

      if (plan) {
        setTimeout(() => openModal('upgradeModal'), 300);
        sessionStorage.removeItem('fbcast_pending_plan');
      }

      // Background sync
      syncQuotaFromServer({ force: true, source: 'triggerConnect_existing', silent: true }).catch(() => {});
      autoLoadPagesAfterLogin().catch(() => {});
      return;
    }

    // Not logged in, start OAuth flow
    if (plan) sessionStorage.setItem('fbcast_pending_plan', plan);

    const btnIds = ['heroConnectBtn', 'navConnectBtn', 'pricingFreeBtn', 'pricingBasicBtn', 'pricingProBtn'];
    btnIds.forEach(id => {
      const b = document.getElementById(id);
      if (b) { b.classList.add('loading'); b.disabled = true; }
    });

    try {
      if (typeof startFacebookLogin !== 'function') throw new Error('Facebook Login module not loaded.');
      await startFacebookLogin();
      
      fbTrackEvent('login_oauth_complete', { plan: plan || 'free' });
      
      document.getElementById('landingPage').style.display = 'none';
      document.getElementById('appPage').style.display = 'flex';
      document.body.style.overflow = 'hidden';
      applyTheme();
      updateQuotaUI();
      if (typeof setLoginOnline === 'function') setLoginOnline();
      
      await syncQuotaFromServer({ force: true, source: 'triggerConnect_new', silent: true }).catch(() => {});
      await autoLoadPagesAfterLogin().catch(() => {});

      if (plan) {
        setTimeout(() => openModal('upgradeModal'), 600);
        sessionStorage.removeItem('fbcast_pending_plan');
      }
    } catch (e) {
      fbTrackEvent('login_error', { message: e.message || 'failed' });
      showToast(e.message || 'Login failed.', 'error');
    } finally {
      btnIds.forEach(id => {
        const b = document.getElementById(id);
        if (b) { b.classList.remove('loading'); b.disabled = false; }
      });
    }
  } catch (err) {
    console.error('triggerConnect error:', err);
    reportClientError(err, { source: 'triggerConnect_root' });
  }
};

/* Theme */
function applyTheme(){
  let saved=localStorage.getItem('promo_theme');
  if(!saved){
    saved='dark';
    localStorage.setItem('promo_theme',saved);
  }
  const toggle=document.getElementById('themeToggle');
  const isLight=saved!=='dark';
  document.body.classList.toggle('light',isLight);
  if(toggle)toggle.checked=!isLight;
}
(function(){
  const toggle=document.getElementById('themeToggle');
  if(!toggle)return;
  toggle.addEventListener('change',function(){
    document.body.classList.toggle('light',!this.checked);
    localStorage.setItem('promo_theme',this.checked?'dark':'light');
  });
})();

/* Periodic server sync (every 45s) */
setInterval(async()=>{
  const storedToken=localStorage.getItem('fb_user_token');
  if(!storedToken)return;
  try{
    await syncQuotaFromServer({ background: true, source: 'periodic_quota_sync', silent: true });
  }catch(e){
    // Keep background sync quiet to avoid noisy console/log spam on unstable hosting.
  }
},45000);

/* Unload guard */
window.addEventListener('beforeunload',(e)=>{
  if(typeof runtime!=='undefined'&&runtime.isSending){e.preventDefault();e.returnValue='Broadcast is in progress!';}
});

/* Login online state */
window.setLoginOnline=function(){
  const ls=document.getElementById('loginStatus');
  if(ls)ls.classList.add('online');
  const lt=document.getElementById('loginStatusText');
  if(lt)lt.textContent='Connected';
};

/* Mode switch */
document.addEventListener('DOMContentLoaded',()=>{
  const btnManual=document.getElementById('modeManualBtn');
  const btnAuto=document.getElementById('modeAutoBtn');
  const manual=document.getElementById('manualControls');
  const auto=document.getElementById('autoControls');
  if(!btnManual)return;
  btnManual.addEventListener('click',()=>{btnManual.classList.add('active');btnAuto.classList.remove('active');manual.style.display='';auto.style.display='none';});
  btnAuto.addEventListener('click',()=>{btnAuto.classList.add('active');btnManual.classList.remove('active');auto.style.display='';manual.style.display='none';});
  document.getElementById('btnAutoStart')?.addEventListener('click',startAutoSend);
  document.getElementById('btnAutoPause')?.addEventListener('click',()=>{pauseSending();fbTrackEvent('broadcast_pause',{mode:'auto'});setAutoButtons('paused');});
  document.getElementById('btnAutoResume')?.addEventListener('click',()=>{resumeSending();fbTrackEvent('broadcast_resume',{mode:'auto'});setAutoButtons('running');});
  document.getElementById('btnAutoStop')?.addEventListener('click',()=>{stopSending();fbTrackEvent('broadcast_stop',{mode:'auto'});autoRunning=false;setAutoButtons('idle');setAutoStatus('info','Stopped by user.');});
});

/* ══════════════════════
   AUTO SEND ALL PAGES
══════════════════════ */
if(!window.FB_CONFIG)window.FB_CONFIG={appId:FB_APP_ID};

function _esc(s){return String(s??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;')}

let autoRunning=false;

async function startAutoSend(){
  if(autoRunning)return;
  if(getRemaining()<=0){showUpgradeModal('pro_exhausted');return;}
  const pages=JSON.parse(localStorage.getItem('fb_pages')||'[]');
  if(!pages.length){setAutoStatus('error','No pages loaded yet. Please wait a moment after login.');return;}
  const msg=document.getElementById('messageText').value.trim();
  const imgUrl=(typeof currentImageUrl!=='undefined'?currentImageUrl:'')||window._imgAttachUrl||'';
  if(!msg&&!imgUrl){setAutoStatus('error','Please write a message or attach an image first.');return;}
  const delay=Math.max(500,parseInt(document.getElementById('delayMs').value)||1200);

  // Get FB User ID - required for quota tracking
  let fbUserId = null;
  try {
    const storedUser = JSON.parse(localStorage.getItem('fbcast_user') || '{}');
    fbUserId = storedUser.fb_user_id || storedUser.id || null;
  } catch (e) {}

  // If fbcast_user not loaded, try syncing from server before sending
  if (!fbUserId && typeof window.syncQuotaFromServer === 'function') {
    setAutoStatus('loading', 'Initializing quota from server…');
    await window.syncQuotaFromServer({ force: true, source: 'auto_send_init' });
    try {
      const storedUser = JSON.parse(localStorage.getItem('fbcast_user') || '{}');
      fbUserId = storedUser.fb_user_id || storedUser.id || null;
    } catch (e) {}
  }

  if (!fbUserId) {
    setAutoStatus('error', 'User session not initialized. Please refresh the page and login again.');
    fbTrackEvent('broadcast_error', { mode: 'auto', message: 'session_not_initialized' });
    return;
  }

  fbTrackEvent('broadcast_start', { mode: 'auto', pages: pages.length, delayMs: delay });
  autoRunning=true;runtime.isSending=true;runtime.paused=false;
  setAutoButtons('running');
  let gTotal=0,gSent=0,gFailed=0;
  const updStats=()=>{
    document.getElementById('statTotal').textContent=gTotal;
    document.getElementById('statSent').textContent=gSent;
    document.getElementById('statFailed').textContent=gFailed;
  };
  document.getElementById('progressBar').style.width='0%';
  document.getElementById('progressPct').textContent='0%';
  clearRecipients();updStats();
  for(let pi=0;pi<pages.length;pi++){
    if(!runtime.isSending)break;
    if(getRemaining()<=0){showUpgradeModal('pro_exhausted');break;}
    const page=pages[pi];
    showPageBadge(`Page ${pi+1} / ${pages.length}: ${page.name}`);
    setAutoStatus('loading',`Loading conversations for "${page.name}"…`);
    let psids;
    try{
      const result=await fetchConversations(page.id,(prog)=>{
        setAutoStatus('loading',`"${page.name}": loaded ${prog.fetched}${prog.total?' / '+prog.total:''} conversations…`);
      });
      psids=result.psids;
    }catch(e){reportClientError(e,{source:'startAutoSend.fetchConversations',pageId:page.id});setAutoStatus('warn',`Skipping "${page.name}": ${e.message}`);await sleep(2000);continue;}
    if(!psids.length){setAutoStatus('info',`"${page.name}" has no conversations. Moving on…`);await sleep(1200);continue;}
    gTotal+=psids.length;updStats();
    setAutoStatus('sending',`Sending to ${psids.length} recipients on "${page.name}"…`);
    addPageSeparator(page.name,pi+1,pages.length);

    await new Promise(resolve=>{
      enqueueAndSendUtility({
        pageId:page.id,messageText:msg,imageUrl:imgUrl,recipientIds:psids,delayMs:delay,
        fbUserId,
        onProgress:(data)=>{
          if(data.item.status==='sent')gSent++;
          if(data.item.status==='failed')gFailed++;
          updStats();
          updateQuotaUI(); // Force UI update on each message
          const pct=Math.round((data.index/data.total)*100);
          document.getElementById('progressBar').style.width=pct+'%';
          document.getElementById('progressPct').textContent=pct+'%';
          addRecipientRow(data.item);
          setAutoStatus('sending',`"${page.name}" (${pi+1}/${pages.length}) — ${data.index} / ${data.total} sent`);
        },
        onDone:resolve
      });
    });
    if(!runtime.isSending)break;
    setAutoStatus('success',`✓ "${page.name}" done. ${gSent} sent so far.`);
    await sleep(1500);
  }
  autoRunning=false;runtime.isSending=false;setAutoButtons('idle');
  document.getElementById('autoPageBadge').style.display='none';
  if(gTotal>0){
    document.getElementById('progressBar').style.width='100%';
    document.getElementById('progressPct').textContent='100%';
    setAutoStatus('success',`All ${pages.length} page(s) complete — ✅ ${gSent} sent, ❌ ${gFailed} failed.`);
  }
  fbTrackEvent('broadcast_complete', { mode: 'auto', pages: pages.length, total: gTotal, sent: gSent, failed: gFailed });
}

function sleep(ms){return new Promise(r=>setTimeout(r,ms))}

function setAutoStatus(type,msg){
  const card=document.getElementById('autoStatusCard');
  const icons={loading:'fa-spinner fa-spin',sending:'fa-paper-plane',error:'fa-circle-exclamation',warn:'fa-triangle-exclamation',success:'fa-circle-check',info:'fa-circle-info'};
  const colors={loading:'#60a5fa',sending:'#60a5fa',error:'#f87171',warn:'#fbbf24',success:'#4ade80',info:'#94a3b8'};
  card.className='auto-info'+(type==='error'?' error':type==='success'?' success':type==='warn'?' warn':'');
  card.innerHTML=`<i class="fa-solid ${icons[type]||'fa-circle-info'}" style="color:${colors[type]||'#94a3b8'};"></i><span>${_esc(msg)}</span>`;
}

function showPageBadge(text){
  const b=document.getElementById('autoPageBadge');
  document.getElementById('autoPageBadgeText').textContent=text;
  b.style.display='';
}

function setAutoButtons(state){
  document.getElementById('btnAutoStart').disabled=state!=='idle';
  document.getElementById('btnAutoPause').disabled=state!=='running';
  document.getElementById('btnAutoResume').disabled=state!=='paused';
  document.getElementById('btnAutoStop').disabled=state==='idle';
}

function clearRecipients(){
  document.getElementById('recipients').innerHTML='';
  document.getElementById('recipientCount').textContent='0';
}

function addPageSeparator(name,idx,total){
  const cont=document.getElementById('recipients');
  const sep=document.createElement('div');
  sep.style.cssText='padding:5px 18px;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;color:#60a5fa;background:rgba(24,119,242,.05);border-bottom:1px solid rgba(24,119,242,.1);display:flex;align-items:center;gap:6px;';
  sep.innerHTML=`<i class="fa-solid fa-flag" style="font-size:9px;"></i>${_esc(name)} (${_esc(idx)}/${_esc(total)})`;
  cont.appendChild(sep);
}

function addRecipientRow(item){
  const cont=document.getElementById('recipients');
  const sc={sent:'badge-sent',failed:'badge-failed',pending:'badge-pending'}[item.status]||'badge-pending';
  const row=document.createElement('div');row.className='table-row';
  row.innerHTML=`<div class="mono truncate">${_esc(item.id)}</div><div><span class="badge ${_esc(sc)}">${_esc(item.status)}</span></div><div class="err">${_esc(item.error||'')}</div>`;
  cont.appendChild(row);
  document.getElementById('recipientCount').textContent=cont.querySelectorAll('.table-row').length;
  cont.scrollTop=cont.scrollHeight;
}

/* Init quota sync if app is already visible */
(function(){
  const ap=document.getElementById('appPage');
  if(ap&&ap.style.display!=='none'){
    syncQuotaFromServer();
  }
  // Also restore fbcast_user if app page is being shown
  const storedUser = localStorage.getItem('fbcast_user');
  if(ap&&ap.style.display!=='none'&&!storedUser){
    // fbcast_user not in memory, sync from server
    syncQuotaFromServer();
  }
})();

/* ═══════════════════════════════════════════════════════════════
   PREMIUM UI v5.0 — Interactions & Animations
═══════════════════════════════════════════════════════════════ */

/* ─── ANIMATED COUNTER ─── */
(function initCounters() {
  function easeOutQuart(t) { return 1 - Math.pow(1 - t, 4); }

  function animateCounter(el) {
    const raw = el.dataset.target;
    const suffix = el.dataset.suffix || '';
    const target = parseFloat(raw);
    if (isNaN(target)) return;

    const duration = 1800;
    const start = performance.now();
    const startVal = 0;

    function tick(now) {
      const elapsed = now - start;
      const progress = Math.min(elapsed / duration, 1);
      const eased = easeOutQuart(progress);
      const current = Math.round(startVal + (target - startVal) * eased);
      const formatted = current >= 1000 ? current.toLocaleString() : String(current);
      if (el.dataset.prefix === 'lt') {
        el.textContent = '<' + formatted + suffix;
      } else {
        el.textContent = formatted + suffix;
      }
      if (progress < 1) requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
  }

  const observer = new IntersectionObserver(function (entries) {
    entries.forEach(function (entry) {
      if (entry.isIntersecting && !entry.target.dataset.counted) {
        entry.target.dataset.counted = '1';
        animateCounter(entry.target);
      }
    });
  }, { threshold: 0.3 });

  document.querySelectorAll('.counter-num[data-target]').forEach(function (el) {
    observer.observe(el);
  });
})();

/* ─── PRICING TOGGLE ─── */
(function initPricingToggle() {
  const btn = document.getElementById('billingToggleBtn');
  const labelMonthly = document.getElementById('toggleLabelMonthly');
  const labelAnnual = document.getElementById('toggleLabelAnnual');
  if (!btn) return;

  function setMode(annual) {
    if (annual) {
      document.body.classList.add('billing-annual');
      btn.classList.add('annual');
      if (labelMonthly) { labelMonthly.classList.remove('active'); }
      if (labelAnnual)  { labelAnnual.classList.add('active');    }
    } else {
      document.body.classList.remove('billing-annual');
      btn.classList.remove('annual');
      if (labelMonthly) { labelMonthly.classList.add('active');    }
      if (labelAnnual)  { labelAnnual.classList.remove('active');  }
    }
  }

  btn.addEventListener('click', function () {
    setMode(!btn.classList.contains('annual'));
  });
  if (labelMonthly) { labelMonthly.addEventListener('click', function () { setMode(false); }); }
  if (labelAnnual)  { labelAnnual.addEventListener('click',  function () { setMode(true);  }); }
})();

/* ─── ACTIVITY TICKER ─── */
(function initActivityTicker() {
  const tickerEl = document.getElementById('activityTickerText');
  if (!tickerEl) return;

  const messages = [
    '12 businesses sent broadcasts in the last hour',
    'Ahmad K. just reached 48,000 followers',
    '500+ businesses trust FBCast Pro worldwide',
    'Sara R. sent 12,000 messages in 4 minutes',
    'Umar Agency broadcasts across 12 pages daily',
    '98% average delivery rate this week',
    'New signup: just connected 3 Facebook pages'
  ];
  let idx = 0;

  function rotate() {
    idx = (idx + 1) % messages.length;
    tickerEl.style.opacity = '0';
    tickerEl.style.transform = 'translateY(6px)';
    tickerEl.style.transition = 'opacity .3s,transform .3s';
    setTimeout(function () {
      tickerEl.textContent = messages[idx];
      tickerEl.style.opacity = '1';
      tickerEl.style.transform = 'translateY(0)';
    }, 300);
  }

  setInterval(rotate, 4500);
})();

/* ─── TOPBAR USER AVATAR UPDATE ─── */
(function initTopbarUser() {
  function updateTopbarUser() {
    const avatarEl = document.getElementById('topbarAvatar');
    const nameEl = document.getElementById('topbarUserName');
    if (!avatarEl || !nameEl) return;
    try {
      const storedUser = JSON.parse(localStorage.getItem('fbcast_user') || '{}');
      const name = storedUser.name || storedUser.fb_name || '';
      if (name) {
        const initials = name.split(' ').map(function (w) { return w[0] || ''; }).slice(0, 2).join('').toUpperCase();
        avatarEl.textContent = initials || name[0].toUpperCase();
        nameEl.textContent = name.split(' ')[0] || name;
      } else {
        avatarEl.textContent = '?';
        nameEl.textContent = 'Not connected';
      }
    } catch (e) {
      avatarEl.textContent = '?';
      nameEl.textContent = 'Not connected';
    }
  }

  updateTopbarUser();
  window.addEventListener('fbcast:user-updated', updateTopbarUser);
  window.addEventListener('storage', function (e) {
    if (e.key === 'fbcast_user') updateTopbarUser();
  });
})();

/* ─── STAT BUMP ANIMATION ─── */
(function initStatBump() {
  var _lastSent = -1, _lastFailed = -1, _lastTotal = -1;

  function checkBump() {
    ['statSent', 'statFailed', 'statTotal'].forEach(function (id) {
      var el = document.getElementById(id);
      if (!el) return;
      var val = parseInt(el.textContent, 10);
      var prev = id === 'statSent' ? _lastSent : id === 'statFailed' ? _lastFailed : _lastTotal;
      if (!isNaN(val) && val !== prev && prev !== -1) {
        el.classList.remove('bump');
        void el.offsetWidth;
        el.classList.add('bump');
      }
      if (!isNaN(val)) {
        if (id === 'statSent')   _lastSent   = val;
        if (id === 'statFailed') _lastFailed = val;
        if (id === 'statTotal')  _lastTotal  = val;
      }
    });
  }

  var statObs = new MutationObserver(checkBump);
  ['statSent', 'statFailed', 'statTotal'].forEach(function (id) {
    var el = document.getElementById(id);
    if (el) statObs.observe(el, { childList: true, characterData: true, subtree: true });
  });
})();

/* ─── FOOTER DUPLICATE BUTTON WIRING ─── */
(function wireFooterBtns() {
  function wireBtn(id, targetId) {
    var el = document.getElementById(id);
    if (!el) return;
    el.addEventListener('click', function (e) {
      e.preventDefault();
      var modal = document.getElementById(targetId);
      if (modal) modal.style.display = 'flex';
    });
  }
  wireBtn('footerPrivacyBtn2', 'privacyModal');
  wireBtn('footerTermsBtn2', 'termsModal');
})();

/* ─── NAV ACTIVE LINK HIGHLIGHT ─── */
(function initNavActive() {
  var sections = ['features', 'how-it-works', 'pricing', 'testimonials', 'faq'];
  var links = document.querySelectorAll('.nav-links a');
  if (!links.length) return;

  var observer = new IntersectionObserver(function (entries) {
    entries.forEach(function (entry) {
      if (entry.isIntersecting) {
        var id = entry.target.id;
        links.forEach(function (link) {
          link.classList.toggle('active', link.getAttribute('href') === '#' + id);
        });
      }
    });
  }, { rootMargin: '-30% 0px -60% 0px' });

  sections.forEach(function (id) {
    var el = document.getElementById(id);
    if (el) observer.observe(el);
  });
})();

/* ─── FEATURE CARD GLOW CLASS ─── */
(function addGlowCards() {
  document.querySelectorAll('.feat, .step, .price-card, .testimonial').forEach(function (el) {
    el.classList.add('glow-card');
  });
})();
