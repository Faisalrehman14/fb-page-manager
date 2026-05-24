/** pages routes */
module.exports = function mountPages(app, ctx) {
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

// ── Pages ─────────────────────────────────────────────────────────────────────
// Manual trigger for Meta App Review test calls (use while logged in as app Admin/Developer)
app.post('/api/meta/review-tests', requireAuth, verifyCsrf, async (req, res) => {
    const report = await recordMetaReviewTests(req.session.accessToken);
    if (!report) return res.status(500).json({ error: 'Failed to run review tests' });
    const tests = report.tests || report;
    res.json({
        success: !!(tests.public_profile?.ok && tests.pages_show_list?.ok),
        qualified: !!report.qualified,
        graphVersion: report.graphVersion || tests.graphVersion,
        pageCount: report.pageCount ?? tests.pageCount,
        public_profile: tests.public_profile,
        pages_show_list: tests.pages_show_list,
        tokenInfo: report.tokenInfo || null,
        role: report.role || null,
        dashboardNote: report.dashboardNote || (
            report.pageCount === 0
                ? 'No Pages returned — use a Facebook account that manages at least one Page.'
                : 'Check App Dashboard → Testing in 24h. Login must be as App Admin/Developer/Tester.'
        ),
        nextSteps: report.nextSteps || []
    });
});

app.get('/api/pages', requireAuth, async (req, res) => {
    try {
        await recordMetaReviewTests(req.session.accessToken);

        const fbRes = await fetch(`${FB_GRAPH_BASE}/me/accounts?fields=id,name,link,picture,access_token&access_token=${req.session.accessToken}`);
        const data  = await fbRes.json();
        if (data.error) throw new Error(data.error.message);

        req.session.pageTokens = {};
        const pagesToSave = (data.data || []).map(p => ({ id: p.id, name: p.name, picture: p.picture?.data?.url, accessToken: p.access_token }));

        if (state.dbConnected) {
            await db.savePages(pagesToSave);
        }

        (data.data || []).forEach(p => { req.session.pageTokens[p.id] = p.access_token; });

        await trackUserSession(req, (data.data || []).map(p => ({ id: p.id, name: p.name, link: p.link })));

        // Login: quick conversation list sync first (fast inbox), messages sync when messenger opens
        if (state.dbConnected && pagesToSave.length) {
            const forceSync = !!req.session.firstLogin;
            if (req.session.firstLogin) req.session.firstLogin = false;
            const STALE_MS = 15 * 60 * 1000;
            for (const p of pagesToSave) {
                setImmediate(async () => {
                    try {
                        const last = await db.getPageSyncTime(p.id);
                        const stale = forceSync || !last ||
                            (Date.now() - new Date(last).getTime() > STALE_MS);
                        if (!stale) return;
                        await db.syncConversationsFromFacebook(p.id, p.accessToken, fetch, null, {
                            maxPages: 10,
                            maxTotal: 500,
                            fbLimit: 100
                        });
                        io.to(`page_${p.id}`).emit('sync_progress', { phase: 'done', pageId: p.id });
                    } catch (err) {
                        logError('pages_bg_sync', err, { pageId: p.id });
                        io.to(`page_${p.id}`).emit('sync_progress', { phase: 'done', pageId: p.id });
                    }
                });
            }
        }

        // Auto-subscribe pages to webhook events — log failures so webhook issues are visible
        for (const p of (data.data || [])) {
            fetch(`https://graph.facebook.com/v19.0/${p.id}/subscribed_apps`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ subscribed_fields: ['messages', 'messaging_postbacks', 'message_deliveries', 'message_reads', 'message_reactions', 'conversations'], access_token: p.access_token })
            }).then(async r => {
                const d = await r.json().catch(() => ({}));
                if (!r.ok || d.error) logError('webhook_subscribe', new Error(d.error?.message || 'subscribe failed'), { pageId: p.id });
            }).catch(err => logError('webhook_subscribe_net', err, { pageId: p.id }));

        }

        const pageIds      = (data.data || []).map(p => p.id);
        const unreadCounts = state.dbConnected ? await db.getUnreadCountsForPages(pageIds) : {};

        res.json({
            pages: (data.data || []).map(p => ({
                id: p.id, name: p.name, picture: p.picture?.data?.url,
                access_token: p.access_token, unreadCount: unreadCounts[p.id] || 0
            }))
        });
    } catch (err) {
        logError('pages_route', err);
        res.status(500).json({ error: err.message });
    }
});


};
