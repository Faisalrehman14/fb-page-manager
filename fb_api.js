// fb_api.js — Facebook Graph API helpers
// Production version with security hardening
// Version: 2.1.0 - Production UI improvements (2026-04-15)

// FB_CONFIG must be set in index.html before this script loads:
//   <script>window.FB_CONFIG = { appId: 'YOUR_FB_APP_ID' };</script>
if (!window.FB_CONFIG?.appId) {
  if (typeof APP_ENV !== 'undefined' && APP_ENV !== 'production') {
    console.error('[fb_api] window.FB_CONFIG.appId is not set. Set it in index.html before loading fb_api.js.');
  }
}

const FB_AUTH = {
  appId:       window.FB_CONFIG?.appId || '',
  redirectUri: (function () {
    const fallback = window.location.origin + '/oauth_callback.html';
    const configured = (window.APP_CONFIG?.fbRedirectUri || '').trim();
    if (!configured) return fallback;
    try {
      // postMessage flow expects callback page to share the same origin as current app.
      if (new URL(configured).origin !== window.location.origin) return fallback;
      return configured;
    } catch (_) {
      return fallback;
    }
  })(),
  scopes:      ['pages_show_list', 'pages_messaging']
};

const STORAGE_KEYS = {
  USER_TOKEN: 'fb_user_token',
  PAGES:      'fb_pages',
  THREAD_MAP: 'fb_thread_by_psid',
  QUEUE:      'send_queue'
};

const RETRY_CFG_DEFAULT = { attempts: 2, backoffMs: 400 };

async function requestJson(url, options = {}, retryCfg = RETRY_CFG_DEFAULT) {
  if (typeof window.fetchJsonWithRetry === 'function') {
    return window.fetchJsonWithRetry(url, options, Object.assign({ timeoutMs: 20000 }, retryCfg || {}));
  }
  const timeoutMs = Math.max(3000, Number((retryCfg && retryCfg.timeoutMs) || 20000));
  const controller = (typeof AbortController !== 'undefined') ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  const finalOptions = controller 
    ? Object.assign({ credentials: 'same-origin' }, options, { signal: controller.signal }) 
    : Object.assign({ credentials: 'same-origin' }, options);
  let res;
  try {
    res = await fetch(url, finalOptions);
  } catch (err) {
    if (controller && timer) clearTimeout(timer);
    if (err && err.name === 'AbortError') {
      throw new Error(`Request timeout after ${Math.round(timeoutMs / 1000)}s`);
    }
    throw err;
  }
  if (controller && timer) clearTimeout(timer);
  const text = await res.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch (e) { data = { raw: text }; }
  if (!res.ok) {
    const errMsg = (data && (data.error || data.message))
      ? (typeof data.error === 'object' ? JSON.stringify(data.error) : data.error || data.message)
      : `Request failed (${res.status})`;
    throw new Error(errMsg);
  }
  return data;
}

// Volatile state for the active send session
let runtime = {
  isSending: false,
  paused: false,
  currentIndex: 0,
  manualPaused: false,
  networkPaused: false
};

function isLikelyNetworkError(err) {
  const msg = String((err && err.message) || err || '').toLowerCase();
  return (
    !navigator.onLine ||
    msg.includes('network') ||
    msg.includes('failed to fetch') ||
    msg.includes('timeout') ||
    msg.includes('temporar') ||
    msg.includes('fetch')
  );
}

function setNetworkPaused(value) {
  runtime.networkPaused = !!value;
  runtime.paused = runtime.manualPaused || runtime.networkPaused;
}

if (!window.__fbcastNetworkResumeListener) {
  window.__fbcastNetworkResumeListener = true;
  window.addEventListener('online', () => {
    if (!runtime.isSending) return;
    if (!runtime.networkPaused) return;
    setNetworkPaused(false);
    if (window.showToast) {
      window.showToast('Internet restored. Resuming pending messages…', 'success');
    }
    if (window.showStatus) {
      window.showStatus('Internet restored. Resuming broadcast…', 'success');
    }
  });
  window.addEventListener('offline', () => {
    if (!runtime.isSending) return;
    setNetworkPaused(true);
    if (window.showToast) {
      window.showToast('Internet disconnected. Messages will resume automatically when back online.', 'warning');
    }
    if (window.showStatus) {
      window.showStatus('Internet disconnected. Waiting to resume…', 'warning');
    }
  });
}

// ── Facebook OAuth (Authorization Code flow — server-side) ─────────────────
// Popup opens oauth_start.php → Facebook OAuth dialog → oauth_callback.php
// oauth_callback.php exchanges code server-side and posts result back here.

async function startFacebookLogin() {
  const result = await openOAuthPopup();

  // Token is already long-lived (exchanged server-side in oauth_callback.php)
  const expiresMs = (result.expiresIn || 5184000) * 1000;
  localStorage.setItem(STORAGE_KEYS.USER_TOKEN, JSON.stringify({
    token:     result.token,
    expiresAt: Date.now() + expiresMs,
  }));

  // Pages already fetched server-side with long-lived page tokens
  if (Array.isArray(result.pages) && result.pages.length) {
    localStorage.setItem(STORAGE_KEYS.PAGES, JSON.stringify(result.pages));
  }

  // Track user + sync quota
  const csrfToken = await window.getCsrfToken?.() || '';
  try {
    const trackData = await requestJson('/api/auth/track', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
      body:    JSON.stringify({ user_token: result.token }),
    }, { attempts: 2, backoffMs: 400 });
    if (trackData.success) {
      localStorage.setItem('fbcast_user', JSON.stringify({
        fb_user_id: trackData.fb_user_id,
        fb_name:    trackData.fb_name,
      }));
      window.dispatchEvent(new Event('fbcast:user-updated'));
      if (window.saveQuota) {
        window.saveQuota(trackData);
        window.updateQuotaUI?.();
      }
    }
  } catch (e) {
    // Non-critical
  }

  // Kick off 30-day history sync for each connected page (background, non-blocking)
  if (Array.isArray(result.pages) && result.pages.length) {
    window.dispatchEvent(new CustomEvent('fbcast:sync-started', { detail: { count: result.pages.length } }));
    syncAllPagesHistory(result.pages);
  }

  return result.token;
}

async function syncAllPagesHistory(pages) {
  let done = 0;
  for (const page of pages) {
    if (!page.id || !page.access_token) { done++; continue; }
    try {
      const resp = await fetch('/api/sync-history', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ page_id: page.id, page_token: page.access_token }),
      });
      const data = await resp.json();
      done++;
      window.dispatchEvent(new CustomEvent('fbcast:sync-progress', {
        detail: { done, total: pages.length, page_id: page.id, result: data }
      }));
    } catch (e) {
      done++;
      window.dispatchEvent(new CustomEvent('fbcast:sync-progress', {
        detail: { done, total: pages.length, page_id: page.id, error: e.message }
      }));
    }
  }
  window.dispatchEvent(new CustomEvent('fbcast:sync-done', { detail: { total: pages.length } }));
}

function openOAuthPopup() {
  return new Promise((resolve, reject) => {
    const origin   = window.location.origin;
    const startUrl = origin + '/oauth_start.php';
    const w = 600, h = 700;
    const left = Math.round((screen.width  - w) / 2);
    const top  = Math.round((screen.height - h) / 2);
    const popup = window.open(startUrl, 'fb_oauth', `width=${w},height=${h},left=${left},top=${top},resizable=yes,scrollbars=yes`);

    if (!popup || popup.closed) {
      return reject(new Error('Popup blocked. Please allow popups for this site and try again.'));
    }

    let done = false;

    function onMessage(event) {
      if (event.origin !== origin) return;
      if (!event.data || (event.data.type !== 'fb_auth_success' && event.data.type !== 'fb_auth_error')) return;
      done = true;
      window.removeEventListener('message', onMessage);
      clearInterval(closedTimer);
      if (event.data.type === 'fb_auth_error') {
        reject(new Error(event.data.error || 'Facebook login failed.'));
      } else {
        resolve(event.data); // full result: { token, expiresIn, pages }
      }
    }

    window.addEventListener('message', onMessage);

    const closedTimer = setInterval(() => {
      if (popup.closed && !done) {
        done = true;
        clearInterval(closedTimer);
        window.removeEventListener('message', onMessage);
        reject(new Error('Facebook login was cancelled.'));
      }
    }, 500);
  });
}

// ── Graph API helpers (routed through server proxy) ────
// All calls go via fb_proxy.php so Pakistani ISP blocks are bypassed.

async function fbGet(path, token, params = {}) {
  const csrfToken = await window.getCsrfToken?.() || '';
  return requestJson('/api/fb-proxy', {
    method:  'POST',
    headers: { 
      'Content-Type': 'application/json',
      'X-CSRF-Token': csrfToken
    },
    body:    JSON.stringify({ method: 'GET', path, token, params }),
  }, { attempts: 3, backoffMs: 420 });
}

async function fbGetUrl(fullUrl) {
  const csrfToken = await window.getCsrfToken?.() || '';
  // For pagination: full URL from Facebook (token already embedded)
  return requestJson('/api/fb-proxy', {
    method:  'POST',
    headers: { 
      'Content-Type': 'application/json',
      'X-CSRF-Token': csrfToken
    },
    body:    JSON.stringify({ method: 'GET', url: fullUrl, token: '' }),
  }, { attempts: 3, backoffMs: 420 });
}

async function fbPost(path, token, body) {
  const csrfToken = await window.getCsrfToken?.() || '';
  return requestJson('/api/fb-proxy', {
    method:  'POST',
    headers: { 
      'Content-Type': 'application/json',
      'X-CSRF-Token': csrfToken
    },
    body:    JSON.stringify({ method: 'POST', path, token, body }),
  }, { attempts: 3, backoffMs: 420 });
}

// ── Fetch user's Pages (with thumbnails) ──────────────
// Uses server-side exchange to get long-lived page tokens (~60 days).
async function fetchUserPages() {
  const userToken = getStoredToken();
  if (!userToken?.token) throw new Error('Session expired. Please login again.');

  // Try server-side exchange first (long-lived tokens)
  try {
    const csrfToken = await window.getCsrfToken?.() || '';
    const xData = await requestJson('/api/exchange_token.php', {
      method:      'POST',
      credentials: 'same-origin',
      headers:     { 
        'Content-Type': 'application/json',
        'X-CSRF-Token': csrfToken
      },
      body:        JSON.stringify({ user_token: userToken.token }),
    }, { attempts: 2, backoffMs: 450 });
    if (xData.success && xData.pages) {
      localStorage.setItem(STORAGE_KEYS.PAGES, JSON.stringify(xData.pages));
      if (xData.long_lived_token) {
        localStorage.setItem(STORAGE_KEYS.USER_TOKEN, JSON.stringify({
          token: xData.long_lived_token,
          expiresAt: Date.now() + 58 * 24 * 60 * 60 * 1000
        }));
      }
      return xData.pages;
    }
    if (xData.error) throw new Error(xData.error);
  } catch (e) {
    if (e.message && !e.message.includes('fetch')) throw e;
    // Network error — fall through to direct API call
  }

  // Fallback: direct Graph API call (short-lived tokens)
  const data  = await fbGet('me/accounts', userToken.token, {
    fields: 'id,name,access_token,category,picture.type(large)'
  });
  const pages = data.data || [];
  localStorage.setItem(STORAGE_KEYS.PAGES, JSON.stringify(pages));
  return pages;
}

// ── Fetch conversations and extract PSIDs ──────────────
async function fetchConversations(pageId, onProgress) {
  const pages = JSON.parse(localStorage.getItem(STORAGE_KEYS.PAGES) || '[]');
  const page  = pages.find(p => p.id === pageId);
  if (!page) throw new Error('Page not found. Please refresh your Pages.');

  // System/folder tags that Facebook adds automatically — we want to ignore these
  const SYSTEM_TAGS = new Set([
    'INBOX', 'DONE', 'FOLLOW_UP', 'OPEN', 'UNREAD', 'SPAM', 'IN_PROGRESS',
    'MESSENGER', 'INSTAGRAM_DIRECT', 'OTHER'
  ]);

  // ── Fetch conversations + embedded tags ────────────────
  const allConvos = [];
  const psidMap   = {};
  const psids     = [];
  const labelMap  = {};
  let   totalCount = 0;

  // First page via path-based proxy call
  let data = await fbGet(`${page.id}/conversations`, page.access_token, {
    fields: 'id,participants,tags,can_reply',
    limit:  '200',
    summary: 'true',
  });
  let nextUrl = true; // sentinel to enter loop

  while (nextUrl) {
    if (data.error) throw new Error(data.error.message || 'Facebook API error.');

    // Grab total count from first response summary (for % calculation)
    if (!totalCount && data.summary?.total_count) {
      totalCount = data.summary.total_count;
    }

    for (const convo of (data.data || [])) {
      // Skip conversations where the user has blocked the page (or page blocked user)
      if (convo.can_reply === false) continue;

      // Extract only user-created labels (skip system folder tags)
      const labels = (convo.tags?.data || [])
        .map(t => t.name)
        .filter(n => n && !SYSTEM_TAGS.has(n.toUpperCase()));

      for (const p of (convo.participants?.data || [])) {
        if (!p?.id || p.id === page.id) continue;
        psidMap[p.id] = convo.id;
        if (labels.length) {
          if (!labelMap[p.id]) labelMap[p.id] = [];
          labels.forEach(l => { if (!labelMap[p.id].includes(l)) labelMap[p.id].push(l); });
        }
        psids.push(p.id);
      }
    }
    allConvos.push(...(data.data || []));
    const paginationNext = data.paging?.next || null;

    // Report progress after each page
    if (onProgress) {
      const pct = totalCount ? Math.min(Math.round((psids.length / totalCount) * 100), 99) : null;
      onProgress({ fetched: psids.length, total: totalCount, pct });
    }

    if (!paginationNext) break;
    // Load next page via full URL proxy (token already embedded in Facebook's pagination URL)
    data    = await fbGetUrl(paginationNext);
    nextUrl = true; // keep loop going
  }

  localStorage.setItem(STORAGE_KEYS.THREAD_MAP, JSON.stringify(psidMap));

  return { page, convos: allConvos, psids: [...new Set(psids)], labelMap };
}

// ── Quota update helper ────────────────────────────────
async function _updateQuota(fbUserId, count) {
  if (!fbUserId) return;
  try {
    const csrfToken = await window.getCsrfToken?.() || '';
    const qData = await requestJson('/api/update_quota', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
      body: JSON.stringify({ fb_user_id: fbUserId, count })
    }, { attempts: 2, backoffMs: 300 });
    if (qData.success) {
      if (window.saveQuota) window.saveQuota(qData);
      if (window.updateQuotaUI) window.updateQuotaUI();
      const rem = qData.messageLimit - qData.messagesUsed;
      if (rem <= 0) return 'exhausted';
    } else if (qData.error && window.showToast) {
      window.showToast('Quota update error: ' + qData.error, 'warning');
    }
  } catch (qe) {
    if (window.showToast) window.showToast('Quota sync failed: ' + (qe.message || 'Network error'), 'error');
  }
  return 'ok';
}

// ── Bulk send queue ────────────────────────────────────
async function enqueueAndSendUtility({ pageId, messageText, imageUrl, recipientIds, delayMs = 1200, fbUserId = null, onProgress, onDone }) {
  const pages = JSON.parse(localStorage.getItem(STORAGE_KEYS.PAGES) || '[]');
  const page  = pages.find(p => p.id === pageId);
  if (!page) throw new Error('Page not found.');
  if (!messageText && !imageUrl) throw new Error('Provide a message or an image to send.');

  // ── Ensure fbUserId is available ──────────────────────
  if (!fbUserId) {
    try {
      const storedToken = localStorage.getItem(STORAGE_KEYS.USER_TOKEN);
      if (storedToken) {
        const tokenData = JSON.parse(storedToken);
        if (tokenData.token) {
          const csrfToken = await window.getCsrfToken?.() || '';
          const trackData = await requestJson('/api/auth/track', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
            body: JSON.stringify({ user_token: tokenData.token })
          }, { attempts: 2, backoffMs: 350 });
          if (trackData.success && trackData.fb_user_id) {
            fbUserId = trackData.fb_user_id;
            localStorage.setItem('fbcast_user', JSON.stringify({
              fb_user_id: trackData.fb_user_id,
              fb_name: trackData.fb_name
            }));
            window.dispatchEvent(new Event('fbcast:user-updated'));
            if (window.saveQuota) {
              window.saveQuota(trackData);
              window.updateQuotaUI?.();
            }
          }
        }
      }
    } catch (e) {}
  }

  if (!fbUserId) {
    if (window.showToast) {
      window.showToast('Warning: Quota tracking unavailable. Please re-login.', 'warning');
    }
  }

  const queue = recipientIds.map(id => ({ id, status: 'pending', error: '' }));
  localStorage.setItem(STORAGE_KEYS.QUEUE, JSON.stringify(queue));

  runtime.isSending    = true;
  runtime.paused       = false;
  runtime.currentIndex = 0;
  runtime.manualPaused = false;
  runtime.networkPaused = false;

  for (let i = 0; i < queue.length; i++) {
    if (!runtime.isSending) break;
    while (runtime.paused) await new Promise(r => setTimeout(r, 250));

    if (!navigator.onLine) {
      setNetworkPaused(true);
      const item = queue[i];
      item.status = 'pending';
      item.error = 'Waiting for internet connection…';
      localStorage.setItem(STORAGE_KEYS.QUEUE, JSON.stringify(queue));
      if (onProgress) onProgress({ index: runtime.currentIndex, total: queue.length, item });
      i--; // retry same recipient when online
      continue;
    }

    const item = queue[i];
    try {
      // ── Send text message (if any) ────────────────────
      if (messageText) {
        await fbPost(`${page.id}/messages`, page.access_token, {
          recipient:      { id: item.id },
          message:        { text: messageText },
          messaging_type: 'UTILITY'
        });
        const qResult = await _updateQuota(fbUserId, 1);
        if (qResult === 'exhausted') { runtime.isSending = false; item.error = 'Quota exhausted.'; }
      }

      // ── Send image message (if any) ───────────────────
      if (imageUrl && runtime.isSending) {
        if (messageText) await new Promise(r => setTimeout(r, 350)); // brief gap between msgs
        await fbPost(`${page.id}/messages`, page.access_token, {
          recipient:      { id: item.id },
          message:        { attachment: { type: 'image', payload: { url: imageUrl, is_reusable: true } } },
          messaging_type: 'UTILITY'
        });
        const qResult = await _updateQuota(fbUserId, 1);
        if (qResult === 'exhausted') { runtime.isSending = false; item.error = 'Quota exhausted after image.'; }
      }

      if (item.error) {
        item.status = 'failed';
      } else {
        item.status = 'sent';
        item.error  = '';
      }
    } catch (e) {
      if (isLikelyNetworkError(e)) {
        setNetworkPaused(true);
        item.status = 'pending';
        item.error = 'Internet lost. Will retry automatically…';
        localStorage.setItem(STORAGE_KEYS.QUEUE, JSON.stringify(queue));
        if (onProgress) onProgress({ index: runtime.currentIndex, total: queue.length, item });
        i--; // retry same recipient after internet is back
        continue;
      } else {
        item.status = 'failed';
        item.error  = e?.message || String(e);
      }
    }

    runtime.currentIndex = i + 1;
    localStorage.setItem(STORAGE_KEYS.QUEUE, JSON.stringify(queue));
    if (onProgress) onProgress({ index: runtime.currentIndex, total: queue.length, item });
    await new Promise(r => setTimeout(r, delayMs));
  }

  if (onDone) onDone();
}

// ── Controls ───────────────────────────────────────────
function pauseSending()  {
  runtime.manualPaused = true;
  runtime.paused = true;
}
function resumeSending() {
  runtime.manualPaused = false;
  runtime.paused = runtime.networkPaused;
  if (runtime.networkPaused && window.showToast) {
    window.showToast('Still offline. Auto-resume will start when internet is back.', 'warning');
  }
}
function stopSending()   {
  runtime.isSending = false;
  runtime.paused = false;
  runtime.manualPaused = false;
  runtime.networkPaused = false;
}

// ── Token validity helpers ─────────────────────────────
function getStoredToken() {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.USER_TOKEN);
    if (!raw) return null;
    const data = JSON.parse(raw);
    if (!data || !data.token) return null;
    // If expiresAt is set and already past, token is expired — clear it
    if (data.expiresAt && Date.now() > data.expiresAt) {
      localStorage.removeItem(STORAGE_KEYS.USER_TOKEN);
      localStorage.removeItem(STORAGE_KEYS.PAGES);
      localStorage.removeItem('fbcast_user');
      return null;
    }
    return data;
  } catch (e) {
    return null;
  }
}

// Check on startup — if token is expired, clear session silently
(function checkTokenOnLoad() {
  const t = getStoredToken();
  if (!t && localStorage.getItem(STORAGE_KEYS.USER_TOKEN)) {
    // Had a token but it was expired — clear everything
    localStorage.removeItem(STORAGE_KEYS.USER_TOKEN);
    localStorage.removeItem(STORAGE_KEYS.PAGES);
    localStorage.removeItem('fbcast_user');
  }
})();

// Expose API for browser usage
window.startFacebookLogin = startFacebookLogin;
window.getStoredToken = getStoredToken;
window.fetchUserPages = fetchUserPages;
window.fetchConversations = fetchConversations;
window.enqueueAndSendUtility = enqueueAndSendUtility;
window.pauseSending = pauseSending;
window.resumeSending = resumeSending;
window.stopSending = stopSending;
