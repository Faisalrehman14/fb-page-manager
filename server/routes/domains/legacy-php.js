/** legacy-php routes */
module.exports = function mountLegacyPhp(app, ctx) {
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

// ── PHP-endpoint shims (Node.js replacements for legacy PHP calls) ────────────

// exchange_token.php — short-lived user token → long-lived token + page tokens
app.post(['/api/auth/exchange', '/api/exchange_token.php', '/exchange_token.php'], async (req, res) => {
    const userToken = (req.body?.user_token || '').trim();
    if (!userToken) return res.status(400).json({ error: 'user_token is required' });
    if (!FB_APP_ID || !FB_APP_SECRET) return res.status(500).json({ error: 'App credentials not configured' });

    try {
        // Step 1: Exchange short-lived → long-lived user token
        const exUrl  = `${FB_GRAPH_BASE}/oauth/access_token?grant_type=fb_exchange_token&client_id=${FB_APP_ID}&client_secret=${FB_APP_SECRET}&fb_exchange_token=${encodeURIComponent(userToken)}`;
        const exRes  = await fetch(exUrl);
        const exData = await exRes.json();
        if (!exData.access_token) {
            const msg = exData.error?.message || 'Token exchange failed';
            return res.status(400).json({ error: msg });
        }
        const longToken = exData.access_token;

        await recordMetaReviewTests(longToken);

        // Step 2: Fetch pages with the long-lived token (~60-day page tokens)
        const pgRes  = await fetch(graphUrlWithProof('/me/accounts?fields=id,name,access_token,category,picture.type(large)', longToken));
        const pgData = await pgRes.json();
        if (pgData.error) return res.status(400).json({ error: pgData.error.message || 'Failed to fetch pages' });

        // Step 3: Create server session so requireAuth passes
        req.session.accessToken = longToken;
        try {
            const meRes = await fetch(graphUrlWithProof(`/me?fields=${FB_ME_FIELDS}`, longToken));
            const meData = await meRes.json();
            applyMeToSession(req, meData, longToken);
        } catch(e) {}
        
        // Set signed cookies for persistence across restarts
        const cookieOpts = { signed: true, httpOnly: true, sameSite: 'lax', maxAge: 7 * 24 * 60 * 60 * 1000 };
        res.cookie('_fb_at', longToken, cookieOpts);
        if (req.session.userId) res.cookie('_fb_uid', req.session.userId, cookieOpts);
        if (req.session.userName) res.cookie('_fb_un', req.session.userName, cookieOpts);
        
        generateCsrf(req);

        res.json({ success: true, pages: pgData.data || [], long_lived_token: longToken });
    } catch (err) {
        logError('exchange_token', err);
        res.status(500).json({ error: 'Token exchange failed' });
    }
});

// track_user.php — verify token + return quota info
app.post(['/api/auth/track', '/api/track_user.php', '/track_user.php'], async (req, res) => {
    const userToken = (req.body?.user_token || '').trim();
    if (!userToken) return res.status(400).json({ error: 'user_token is required' });

    try {
        await recordMetaReviewTests(userToken);

        const meRes  = await fetch(graphUrlWithProof(`/me?fields=${FB_ME_FIELDS}`, userToken));
        const meData = await meRes.json();
        if (meData.error) return res.status(401).json({ error: meData.error.message });

        applyMeToSession(req, meData, userToken);
        const ent = await entitlementsSvc.resolveEntitlements(db, meData.id);
        res.json({
            success: true,
            fb_user_id: meData.id,
            fb_name: meData.name,
            subscriptionStatus: ent.subscriptionStatus,
            messageLimit: ent.messageLimit,
            messagesUsed: ent.messagesUsed,
            plan: ent.plan,
            trialDaysLeft: ent.trialDaysLeft,
            trialExpired: ent.trialExpired,
            onFreeTrial: ent.onFreeTrial,
            freeTrialExpiresAt: ent.freeTrialExpiresAt,
            canSend: ent.canSend,
            remaining: ent.remaining,
            display: ent.display,
            trial: ent.trial,
            subscription: ent.subscription
        });
    } catch (err) {
        logError('track_user', err);
        res.status(500).json({ error: 'Tracking failed' });
    }
});


};
