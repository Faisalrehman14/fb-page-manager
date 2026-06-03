/** auth routes */
module.exports = function mountAuth(app, ctx) {
  const {
    db, io, fetch, env, paths, state, logError,
    upload, uploadDisk, syncCooldown,
    requireAuth, verifyCsrf, requireAdminAuth, generateCsrf,
    mountMessenger,
    FB_APP_ID, FB_APP_SECRET, BASE_URL, PORT, WEBHOOK_VERIFY_TOKEN, ADMIN_PASSWORD,
    path, fs, crypto, MAX_LOGS, fbNames, entitlementsSvc, aiAssistant,
    SearchService, threadHasLiveViewers, runMetaReviewTestCalls, FB_GRAPH_BASE,
    graphUrlWithProof,
    express, FB_GV, FB_OAUTH_SCOPES,
    stripUserTokens, getClientIp, fbProfilePicture, applyMeToSession,
    FB_ME_FIELDS, recordMetaReviewTests, trackUserSession, resolveSiteUrl
  } = ctx;

// ── Auth ──────────────────────────────────────────────────────────────────────
app.get('/api/csrf-token', (req, res) => {
    const token = generateCsrf(req);
    req.session.save(() => {
        res.json({ csrfToken: token, token: token });
    });
});

// Bridge: accept FB user token from old JS-SDK auth flow → create server session
app.post('/api/auth/fb-token', async (req, res) => {
    const { user_token } = req.body;
    if (!user_token) return res.status(400).json({ error: 'user_token required' });
    try {
        await recordMetaReviewTests(user_token);

        const uRes  = await fetch(graphUrlWithProof(`/me?fields=${FB_ME_FIELDS}`, user_token));
        const uData = await uRes.json();
        if (uData.error) return res.status(401).json({ error: uData.error.message });
        req.session.accessToken = user_token;

        const pagesRes = await fetch(graphUrlWithProof('/me/accounts?fields=id,name,link,access_token,category,picture.type(large)', user_token));
        const pagesData = await pagesRes.json();
        const pages = pagesData.data || [];
        req.session.pageTokens = {};
        pages.forEach(p => { req.session.pageTokens[p.id] = p.access_token; });

        applyMeToSession(req, uData, user_token);
        req.session.firstLogin  = !req.session.firstLogin ? true : false;
        await trackUserSession(req, pages.map(p => ({ id: p.id, name: p.name, link: p.link })));

        // Set signed cookies for persistence
        const cookieOpts = { signed: true, httpOnly: true, sameSite: 'lax', maxAge: 7 * 24 * 60 * 60 * 1000 };
        res.cookie('_fb_at', user_token, cookieOpts);
        res.cookie('_fb_uid', uData.id, cookieOpts);
        res.cookie('_fb_un', uData.name, cookieOpts);

        generateCsrf(req);
        res.json({ authenticated: true, userName: uData.name, csrfToken: req.session.csrfToken });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/auth/login', (req, res) => {
    const state = crypto.randomBytes(16).toString('hex');
    req.session.oauthState = state;
    const redirectUri = `${BASE_URL}/api/auth/redirect-callback`;
    res.json({ authUrl: `https://www.facebook.com/${FB_GV}/dialog/oauth?client_id=${FB_APP_ID}&redirect_uri=${encodeURIComponent(redirectUri)}&scope=${FB_OAUTH_SCOPES}&state=${state}&response_type=code` });
});

app.get('/api/auth/redirect-callback', async (req, res) => {
    const { code, state, error } = req.query;
    if (error)  return res.redirect('/?error=' + encodeURIComponent(error));
    if (!state || state !== req.session.oauthState) return res.redirect('/?error=invalid_state');
    try {
        const redirectUri = `${BASE_URL}/api/auth/redirect-callback`;
        const tRes  = await fetch(`${FB_GRAPH_BASE}/oauth/access_token?client_id=${FB_APP_ID}&redirect_uri=${encodeURIComponent(redirectUri)}&client_secret=${FB_APP_SECRET}&code=${code}`);
        const tData = await tRes.json();
        if (tData.error) throw new Error(tData.error.message);

        const userToken = tData.access_token;
        await recordMetaReviewTests(userToken);

        const uRes  = await fetch(graphUrlWithProof(`/me?fields=${FB_ME_FIELDS}`, userToken));
        const uData = await uRes.json();
        if (uData.error) throw new Error(uData.error.message);

        const pagesRes = await fetch(graphUrlWithProof('/me/accounts?fields=id,name,link,access_token,category,picture.type(large)', userToken));
        const pagesData = await pagesRes.json();
        const pages = pagesData.data || [];

        req.session.accessToken = userToken;
        req.session.pageTokens = {};
        pages.forEach(p => { req.session.pageTokens[p.id] = p.access_token; });
        applyMeToSession(req, uData, userToken);
        req.session.oauthState  = null;
        req.session.firstLogin  = true;
        req.session.clientPagesCache = pages.map(p => ({
            id: p.id,
            name: p.name,
            access_token: p.access_token,
            category: p.category,
            picture: p.picture?.data?.url || p.picture || null
        }));
        await trackUserSession(req, pages.map(p => ({ id: p.id, name: p.name, link: p.link })));
        res.redirect('/');
    } catch (err) {
        logError('auth_callback', err);
        res.redirect('/?error=' + encodeURIComponent('Login failed: ' + err.message));
    }
});

app.get('/api/auth/status', (req, res) => {
    if (req.session.accessToken) res.json({ authenticated: true, userName: req.session.userName, userId: req.session.userId });
    else res.json({ authenticated: false });
});

/** After redirect OAuth — sync browser from server session + DB user data */
app.get('/api/auth/bootstrap', async (req, res) => {
    if (!req.session.accessToken) {
        return res.json({ authenticated: false });
    }
    const pages = Array.isArray(req.session.clientPagesCache) ? req.session.clientPagesCache : [];
    const payload = {
        authenticated: true,
        token: req.session.accessToken,
        expiresIn: 5184000,
        userId: req.session.userId || null,
        userName: req.session.userName || null,
        pages
    };
    if (state.dbConnected && req.session.userId) {
        try {
            await db.upsertUserFacebookName(
                req.session.userId,
                req.session.userName || '',
                req.session.accessToken || null
            );
            const profile = await db.getUserProfile(req.session.userId);
            const ent = await entitlementsSvc.resolveEntitlements(db, req.session.userId);
            payload.quota = entitlementsSvc.toQuotaClientPayload(ent);
            payload.billing = {
                entitlements: ent.entitlements,
                trial: ent.trial,
                subscription: ent.subscription,
                display: ent.display
            };
            payload.preferences = profile.preferences;
        } catch (err) {
            logError('auth_bootstrap_profile', err);
        }
    }
    res.json(payload);
});

/** User profile: quota + preferences from DB (session auth) */
app.get('/api/user/profile', requireAuth, async (req, res) => {
    try {
        res.setHeader('Cache-Control', 'no-store');
        const uid = req.session.userId;
        if (!uid) return res.status(401).json({ error: 'Not authenticated' });
        if (!state.dbConnected) {
            return res.json({
                quota: { subscriptionStatus: 'free', messageLimit: 2000, messagesUsed: 0 },
                preferences: { notif_broadcast: true, notif_failed: true, default_delay_ms: 1200, message_draft: '' }
            });
        }
        const profile = await db.getUserProfile(uid);
        const ent = await entitlementsSvc.resolveEntitlements(db, uid);
        res.json({
            fb_user_id: uid,
            fb_name: req.session.userName || null,
            quota: entitlementsSvc.toQuotaClientPayload(ent),
            billing: {
                entitlements: ent.entitlements,
                trial: ent.trial,
                subscription: ent.subscription,
                display: ent.display
            },
            preferences: profile.preferences
        });
    } catch (err) {
        logError('user_profile', err);
        res.status(500).json({ error: 'Failed to load profile' });
    }
});

app.get('/api/user/preferences', requireAuth, async (req, res) => {
    try {
        const uid = req.session.userId;
        if (!uid) return res.status(401).json({ error: 'Not authenticated' });
        const preferences = state.dbConnected
            ? await db.getUserPreferences(uid)
            : { notif_broadcast: true, notif_failed: true, default_delay_ms: 1200, message_draft: '' };
        res.json({ preferences });
    } catch (err) {
        logError('get_preferences', err);
        res.status(500).json({ error: 'Failed to load preferences' });
    }
});

app.put('/api/user/preferences', requireAuth, verifyCsrf, async (req, res) => {
    try {
        const uid = req.session.userId;
        if (!uid) return res.status(401).json({ error: 'Not authenticated' });
        const body = req.body || {};
        const patch = {};
        if (body.notif_broadcast !== undefined) patch.notif_broadcast = !!body.notif_broadcast;
        if (body.notif_failed !== undefined) patch.notif_failed = !!body.notif_failed;
        if (body.default_delay_ms !== undefined) patch.default_delay_ms = body.default_delay_ms;
        if (body.message_draft !== undefined) patch.message_draft = body.message_draft;
        const preferences = state.dbConnected
            ? await db.upsertUserPreferences(uid, patch)
            : { ...patch, notif_broadcast: true, notif_failed: true, default_delay_ms: 1200, message_draft: '' };
        res.json({ success: true, preferences });
    } catch (err) {
        logError('put_preferences', err);
        res.status(500).json({ error: 'Failed to save preferences' });
    }
});

app.get('/api/broadcasts/history', requireAuth, async (req, res) => {
    try {
        res.setHeader('Cache-Control', 'no-store');
        const uid = req.session.userId;
        if (!uid) return res.status(401).json({ error: 'Not authenticated' });
        const days = Math.min(365, Math.max(1, parseInt(req.query.days, 10) || 90));
        const history = state.dbConnected ? await db.getBroadcastHistory(uid, days) : [];
        res.json({ history, days });
    } catch (err) {
        logError('get_broadcast_history', err);
        res.status(500).json({ error: 'Failed to load history' });
    }
});

app.post('/api/broadcasts/history', requireAuth, verifyCsrf, async (req, res) => {
    try {
        const uid = req.session.userId;
        if (!uid) return res.status(401).json({ error: 'Not authenticated' });
        const body = req.body || {};
        const sent = Math.max(0, parseInt(body.sent, 10) || 0);
        const failed = Math.max(0, parseInt(body.failed, 10) || 0);
        const total = Math.max(0, parseInt(body.total, 10) || sent + failed);
        if (sent + failed === 0 && total === 0) {
            return res.status(400).json({ error: 'No broadcast stats to save' });
        }
        let id = null;
        if (state.dbConnected) {
            id = await db.insertBroadcastHistory(uid, {
                mode: body.mode || 'manual',
                pageId: body.pageId || body.page_id,
                pages: body.pages || body.pages_count || 1,
                total,
                sent,
                failed,
                message_preview: body.message_preview || body.label
            });
        }
        res.json({ success: true, id });
    } catch (err) {
        logError('post_broadcast_history', err);
        res.status(500).json({ error: 'Failed to save history' });
    }
});

app.post('/api/auth/logout', verifyCsrf, (req, res) => {
    const cookieOpts = { path: '/', signed: true, httpOnly: true, sameSite: 'lax' };
    res.clearCookie('_fb_at', cookieOpts);
    res.clearCookie('_fb_uid', cookieOpts);
    res.clearCookie('_fb_un', cookieOpts);
    req.session.destroy(err => {
        if (err) logError('auth_logout', err);
        res.json({ success: true, redirect: '/' });
    });
});


};
