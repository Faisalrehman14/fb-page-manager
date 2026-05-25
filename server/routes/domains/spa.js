/** spa routes */
module.exports = function mountSpa(app, ctx) {
  const {
    db, io, fetch, env, paths, state, logError,
    upload, uploadDisk, syncCooldown,
    requireAuth, verifyCsrf, requireAdminAuth, generateCsrf,
    mountMessenger,
    FB_APP_ID, FB_APP_SECRET, BASE_URL, PORT, WEBHOOK_VERIFY_TOKEN, ADMIN_PASSWORD,
    path, fs, crypto, MAX_LOGS, fbNames, entitlementsSvc, aiAssistant,
    SearchService, threadHasLiveViewers, runMetaReviewTestCalls, FB_GRAPH_BASE,
    express, FB_GV, FB_OAUTH_SCOPES,
    stripUserTokens, getClientIp, fbProfilePicture, applyMeToSession,
    FB_ME_FIELDS, recordMetaReviewTests, trackUserSession, resolveSiteUrl
  } = ctx;

// ── Health & Debug ────────────────────────────────────────────────────────────

app.get('/api/debug/errors', requireAdminAuth, (req, res) => {
    res.json({
        errorLogs: state.errorLogs,
        webhookLogs: state.webhookLogs,
        requestLogs: state.requestLogs.slice(0, 20),
        dbErrors: db.getDbErrorLogs(),
        dbConnected: state.dbConnected,
        sockets: state.connectedSockets.size
    });
});

// Debug: fetch raw FB conversations to diagnose participant issues
app.get('/api/debug/fb-convs', requireAdminAuth, async (req, res) => {
    const { page_id, page_token } = req.query;
    if (!page_id || !page_token) return res.status(400).json({ error: 'page_id and page_token required' });
    try {
        const url = `${FB_GRAPH_BASE}/${page_id}/conversations?fields=id,participants,snippet,updated_time,unread_count&limit=3&access_token=${page_token}`;
        const r = await fetch(url);
        const data = await r.json();
        res.json({ url_called: url.replace(page_token, '[TOKEN]'), raw: data });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ── /api/config — public config for frontend ──────────────────────────────────
app.get('/api/config', (req, res) => {
    res.json({
        fbAppId:            process.env.FB_APP_ID            || '',
        stripePublishableKey: process.env.STRIPE_PUBLISHABLE_KEY || '',
        contactEmail:       process.env.CONTACT_EMAIL        || '',
        siteUrl:            process.env.SITE_URL             || BASE_URL || '',
        appEnv:             process.env.APP_ENV              || 'production'
    });
});

// ── Main HTML — serve index.php as template ───────────────────────────────────
function renderIndexHtml(req) {
    const root  = paths.PUBLIC;
    let html    = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
    const proto = req.headers['x-forwarded-proto'] || 'https';
    const host  = req.headers['x-forwarded-host'] || req.headers.host || '';
    const siteUrl = process.env.SITE_URL || BASE_URL || (host ? `${proto}://${host}` : '');
    const ver   = Date.now();

    const config = {
        stripePublishableKey: (process.env.STRIPE_PUBLISHABLE_KEY || '').replace(/'/g, "\\'"),
        fbAppId: (process.env.FB_APP_ID || '').replace(/'/g, "\\'"),
        fbRedirectUri: (process.env.FB_REDIRECT_URI || `${siteUrl}/oauth_callback.php`).replace(/'/g, "\\'"),
        contactEmail: (process.env.CONTACT_EMAIL || '').replace(/'/g, "\\'"),
        siteUrl: siteUrl.replace(/'/g, "\\'"),
        csrfToken: req.session.csrfToken || '',
        appEnv: (process.env.APP_ENV || 'production').replace(/'/g, "\\'")
    };

    // Inject config
    html = html.replace(
        /\/\/ __APP_CONFIG_INJECT__/,
        `window.APP_CONFIG=${JSON.stringify(config)};`
    );

    // Replace placeholders
    html = html.replace(/{{SITE_URL}}/g, siteUrl);
    html = html.replace(/{{SITE_URL_NO_SLASH}}/g, siteUrl.replace(/\/$/, ''));
    html = html.replace(/{{CONTACT_EMAIL}}/g, process.env.CONTACT_EMAIL || '');
    html = html.replace(/{{YEAR}}/g, new Date().getFullYear());
    html = html.replace(/{{VER}}/g, ver);

    return html;
}

app.get('/', (req, res) => {
    try {
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.setHeader('Cache-Control', 'no-store');
        res.send(renderIndexHtml(req));
    } catch (err) {
        logError('render_index', err);
        res.status(500).send('<h1>Server Error</h1><p>Could not load application.</p>');
    }
});

// All frontend routes serve the same SPA index.html
app.get(['/app', '/dashboard.html', '/inbox.html', '/messenger.html', '/index.html'], (req, res) => {
    try {
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.setHeader('Cache-Control', 'no-store');
        res.send(renderIndexHtml(req));
    } catch (err) {
        logError('render_index', err);
        res.status(500).send('<h1>Server Error</h1><p>Could not load application.</p>');
    }
});

};
