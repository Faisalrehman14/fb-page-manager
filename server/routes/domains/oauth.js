/** oauth routes */
module.exports = function mountOauth(app, ctx) {
  const {
    db, io, fetch, env, paths, state, logError,
    upload, uploadDisk, syncCooldown,
    requireAuth, verifyCsrf, requireAdminAuth, generateCsrf,
    mountMessenger,
    FB_APP_ID, FB_APP_SECRET, BASE_URL, PORT, WEBHOOK_VERIFY_TOKEN, ADMIN_PASSWORD,
    path, fs, crypto, MAX_LOGS, fbNames, entitlementsSvc, aiAssistant,
    SearchService, threadHasLiveViewers, runMetaReviewTestCalls, FB_GRAPH_BASE,
    graphUrlWithProof,
    express, FB_GV, FB_OAUTH_SCOPES, buildFacebookOAuthUrl, getOAuthMode,
    stripUserTokens, getClientIp, fbProfilePicture, applyMeToSession,
    FB_ME_FIELDS, recordMetaReviewTests, trackUserSession, resolveSiteUrl
  } = ctx;

// ── Facebook OAuth Flow ───────────────────────────────────────────────────
    const oauthCookieOpts = { signed: true, httpOnly: true, sameSite: 'lax', maxAge: 10 * 60 * 1000, path: '/' };

    function readOAuthContext(req) {
        return {
            storedState: req.session.fb_oauth_state || req.signedCookies._fb_oauth_state || '',
            oauthTs: Number(req.session.fb_oauth_ts || req.signedCookies._fb_oauth_ts || 0),
            oauthMode: req.session.fb_oauth_mode || req.signedCookies._fb_oauth_mode || 'redirect'
        };
    }

    function clearOAuthFlowCookies(res) {
        res.clearCookie('_fb_oauth_state', oauthCookieOpts);
        res.clearCookie('_fb_oauth_ts', oauthCookieOpts);
        res.clearCookie('_fb_oauth_mode', oauthCookieOpts);
    }

    function clearOAuthSession(req) {
        delete req.session.fb_oauth_state;
        delete req.session.fb_oauth_ts;
        delete req.session.fb_oauth_mode;
    }

app.get(['/api/auth/start', '/oauth_start.php'], (req, res) => {
    const state = crypto.randomBytes(16).toString('hex');
    const ts = Date.now();
    const mode = req.query.mode === 'popup' ? 'popup' : 'redirect';

    req.session.fb_oauth_state = state;
    req.session.fb_oauth_ts = ts;
    req.session.fb_oauth_mode = mode;

    res.cookie('_fb_oauth_state', state, oauthCookieOpts);
    res.cookie('_fb_oauth_ts', String(ts), oauthCookieOpts);
    res.cookie('_fb_oauth_mode', mode, oauthCookieOpts);
    
    const siteUrl = resolveSiteUrl(req);
    const redirectUri = siteUrl + '/oauth_callback.php';
    const appId = (process.env.FB_APP_ID || '').trim();
    if (!appId) {
        return res.status(503).send('Facebook app is not configured (FB_APP_ID missing).');
    }
    const oauthUrl = buildFacebookOAuthUrl({ appId, redirectUri, state });
    res.redirect(oauthUrl);
});

app.get('/api/meta/oauth-info', async (req, res) => {
    const siteUrl = resolveSiteUrl(req);
    const redirectUri = siteUrl + '/oauth_callback.php';
    const appId = (process.env.FB_APP_ID || '').trim();
    const sampleUrl = appId
        ? buildFacebookOAuthUrl({ appId, redirectUri, state: 'sample' })
        : null;
    res.json({
        appId: appId || null,
        redirectUri,
        oauthMode: getOAuthMode(),
        scopes: FB_OAUTH_SCOPES,
        sampleOAuthUrl: sampleUrl,
        hint: 'Classic Facebook OAuth (scope). Continue with Facebook uses /oauth_start.php → facebook.com/dialog/oauth'
    });
});

app.get('/api/meta/oauth-diagnostics', async (req, res) => {
    try {
        const { getMetaOAuthDiagnostics } = require('../../services/meta-oauth-diagnostics');
        const report = await getMetaOAuthDiagnostics(fetch);
        res.json(report);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get(['/api/auth/callback', '/oauth_callback.php'], async (req, res) => {
    const { state: oauthState, code, error, error_description } = req.query;
    const { storedState, oauthTs, oauthMode } = readOAuthContext(req);
    
    const sendPopupResult = (data) => {
        res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"><title>Connecting Facebook</title>
<style>
  body { font-family: system-ui; background: #0a0d14; color: #fff; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin:0; }
  .card { background: #161b26; border: 1px solid rgba(255,255,255,.1); border-radius: 16px; padding: 40px; text-align: center; max-width: 340px; width: 100%; }
  .spinner { width: 40px; height: 40px; border: 3px solid rgba(255,255,255,.1); border-top-color: #1877f2; border-radius: 50%; animation: spin 0.8s linear infinite; margin: 0 auto 20px; }
  @keyframes spin { to { transform: rotate(360deg); } }
  .error { color: #ef4444; font-size: 14px; margin-top: 12px; }
  .btn { background:#1877f2; color:white; border:none; padding:10px 20px; border-radius:8px; cursor:pointer; margin-top:20px; font-weight:600; display:none; }
</style>
</head>
<body>
<div class="card">
  <div id="loader" class="spinner"></div>
  <h2 id="title">${data.error ? 'Connection failed' : 'Connecting your Facebook...'}</h2>
  <p id="sub">${data.error ? '' : 'This window will close automatically.'}</p>
  ${data.error ? `<p class="error">${data.error}</p>` : ''}
  <button id="closeBtn" class="btn" onclick="window.close()">Close Window</button>
</div>
<script>
  const RESULT = ${JSON.stringify(data)};
  function notifyParent() {
    try {
      localStorage.setItem('fb_oauth_result', JSON.stringify(Object.assign({ ts: Date.now() }, RESULT)));
    } catch (e) {}
    try {
      var ch = new BroadcastChannel('fb_oauth');
      ch.postMessage(RESULT);
      ch.close();
    } catch (e) {}
    try {
      if (window.opener && !window.opener.closed) {
        window.opener.postMessage(RESULT, '*');
        if (RESULT.type === 'fb_auth_success') {
          if (window.opener.showAppDashboard) window.opener.showAppDashboard();
          else if (window.opener.AppShell && window.opener.AppShell.showDashboard) window.opener.AppShell.showDashboard();
        }
      }
    } catch (e) {}
    setTimeout(function() { try { window.close(); } catch (_) {} }, 450);
  }
  var attempts = 0;
  function trySend() {
    if (window.opener && !window.opener.closed) {
      notifyParent();
      return;
    }
    if (++attempts < 25) {
      setTimeout(trySend, 120);
      return;
    }
    if (RESULT.type === 'fb_auth_success') {
      window.location.replace('/?fb_connected=1');
      return;
    }
    notifyParent();
    document.getElementById('loader').style.display = 'none';
    document.getElementById('title').textContent = RESULT.error ? 'Connection failed' : 'Connected!';
    document.getElementById('sub').textContent = RESULT.error ? 'Close this window and try again.' : 'Redirecting…';
    document.getElementById('closeBtn').style.display = 'inline-block';
  }
  trySend();
</script>
</body>
</html>`);
    };

    const authErrMsg = (msg) => {
        clearOAuthFlowCookies(res);
        clearOAuthSession(req);
        if (oauthMode === 'redirect') {
            return res.redirect('/?error=' + encodeURIComponent(msg));
        }
        return sendPopupResult({ type: 'fb_auth_error', error: msg });
    };

    if (error) {
        const msg = error_description || error || 'Authorization denied';
        const metaHint = /unavailable|updating additional details/i.test(String(msg))
            ? ' Meta blocked login — complete Data Use Checkup and App Settings → Basic (privacy policy URL). See /api/meta/oauth-diagnostics'
            : '';
        return authErrMsg(msg + metaHint);
    }
    if (!oauthState || !storedState || oauthState !== storedState) {
        return authErrMsg('Security check failed. Please retry login.');
    }
    if (oauthTs && (Date.now() - oauthTs) > 600000) {
        return authErrMsg('Login session expired. Please try again.');
    }
    
    clearOAuthFlowCookies(res);
    clearOAuthSession(req);

    const siteUrl = resolveSiteUrl(req);
    const redirectUri = siteUrl + '/oauth_callback.php';
    try {
        // 1. Code -> Short Token
        const appId = (process.env.FB_APP_ID || '').trim();
        const appSecret = (process.env.FB_APP_SECRET || '').trim();
        const tokenRes = await fetch(`${FB_GRAPH_BASE}/oauth/access_token?client_id=${appId}&client_secret=${appSecret}&redirect_uri=${encodeURIComponent(redirectUri)}&code=${code}`);
        const tokenData = await tokenRes.json();
        if (tokenData.error) throw new Error(tokenData.error.message);

        // 2. Short -> Long Token
        const longRes = await fetch(`${FB_GRAPH_BASE}/oauth/access_token?grant_type=fb_exchange_token&client_id=${process.env.FB_APP_ID}&client_secret=${process.env.FB_APP_SECRET}&fb_exchange_token=${tokenData.access_token}`);
        const longData = await longRes.json();
        const userToken = longData.access_token || tokenData.access_token;

        await recordMetaReviewTests(userToken);

        // 3. Get Pages (with appsecret_proof for Meta review attribution)
        const pagesRes = await fetch(graphUrlWithProof('/me/accounts?fields=id,name,link,access_token,category,picture.type(large)', userToken));
        const pagesData = await pagesRes.json();
        const pages = pagesData.data || [];

        // Server session — required for /api/pages, messenger, and session cookies
        req.session.accessToken = userToken;
        req.session.pageTokens = {};
        pages.forEach(p => { req.session.pageTokens[p.id] = p.access_token; });
        try {
            const meRes = await fetch(graphUrlWithProof(`/me?fields=${FB_ME_FIELDS}`, userToken));
            const meData = await meRes.json();
            applyMeToSession(req, meData, userToken);
        } catch (_) {}
        req.session.firstLogin = true;

        const cookieOpts = { signed: true, httpOnly: true, sameSite: 'lax', maxAge: 7 * 24 * 60 * 60 * 1000 };
        res.cookie('_fb_at', userToken, cookieOpts);
        if (req.session.userId) res.cookie('_fb_uid', req.session.userId, cookieOpts);
        if (req.session.userName) res.cookie('_fb_un', req.session.userName, cookieOpts);
        generateCsrf(req);

        if (state.dbConnected && pages.length) {
            await db.savePages(pages.map(p => ({
                id: p.id,
                name: p.name,
                picture: p.picture?.data?.url || p.picture,
                accessToken: p.access_token
            }))).catch(() => {});
        }
        if (req.session.userId) {
            await trackUserSession(req, pages.map(p => ({ id: p.id, name: p.name, link: p.link })));
        }

        const authPayload = {
            type: 'fb_auth_success',
            token: userToken,
            expiresIn: longData.expires_in || 5184000,
            pages,
            userId: req.session.userId || null,
            userName: req.session.userName || null
        };

        req.session.clientPagesCache = pages.map(p => ({
            id: p.id,
            name: p.name,
            access_token: p.access_token,
            category: p.category,
            picture: p.picture?.data?.url || p.picture || null
        }));

        if (oauthMode === 'redirect') {
            return res.redirect('/?fb_connected=1');
        }

        sendPopupResult(authPayload);
    } catch (err) {
        logError('oauth_callback', err);
        if (oauthMode === 'redirect') {
            return res.redirect('/?error=' + encodeURIComponent(err.message || 'Facebook login failed'));
        }
        sendPopupResult({ type: 'fb_auth_error', error: err.message });
    }
});

// ── Public topbar announcement (no auth) ───────────────────────────────────
async function sendAnnouncementPayload(req, res) {
    try {
        const payload = await db.getAnnouncementPayload();
        res.json({ success: true, ...payload });
    } catch (_) {
        res.json({
            success: true,
            enabled: false,
            active: false,
            type: 'text',
            text: '',
            media_url: '',
            link_url: ''
        });
    }
}

app.get('/api/announcement', sendAnnouncementPayload);
app.get('/api/admin', (req, res, next) => {
    if (req.query.action === 'announcement') return sendAnnouncementPayload(req, res);
    next();
});


};
