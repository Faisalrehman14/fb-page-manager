/** admin routes */
module.exports = function mountAdmin(app, ctx) {
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

// ── Admin Panel ──────────────────────────────────────────────────────────────
// Serve admin HTML
app.get('/admin', (req, res) => {
    res.sendFile(paths.publicPath('admin2.html'));
});

// Admin login
app.post('/api/admin/login', (req, res) => {
    const { password } = req.body;
    if (!password || password !== ADMIN_PASSWORD) {
        return res.status(401).json({ error: 'Invalid password' });
    }
    req.session.isAdmin = true;
    res.json({ success: true });
});

// Admin logout
app.post('/api/admin/logout', (req, res) => {
    req.session.isAdmin = false;
    res.json({ success: true });
});

// Admin stats
app.get('/api/admin/stats', requireAdminAuth, async (req, res) => {
    const pool = db.pool;
    if (!pool) return res.json({ users: 0, totalMessages: 0, todayLogins: 0, freePlan: 0, paidPlan: 0 });
    try {
        const [[userRow]]   = await pool.query('SELECT COUNT(*) as c FROM users');
        const [[msgRow]]    = await pool.query('SELECT COALESCE(SUM(messenger_messages_used),0) as c FROM users');
        const [[freeRow]]   = await pool.query("SELECT COUNT(*) as c FROM users WHERE plan='free'");
        const [[proRow]]    = await pool.query("SELECT COUNT(*) as c FROM users WHERE plan NOT IN ('free','unknown')");
        const [[loginRow]]  = await pool.query("SELECT COUNT(*) as c FROM activity_log WHERE action='login' AND DATE(created_at)=CURDATE()").catch(()=>[[{c:0}]]);
        const [[onlineRow]] = await pool.query("SELECT COUNT(*) as c FROM users WHERE last_login_at >= DATE_SUB(NOW(), INTERVAL 24 HOUR)").catch(()=>[[{c:0}]]);
        const [[expRow]]    = await pool.query(
            `SELECT COUNT(*) as c FROM users WHERE subscription_expires IS NOT NULL
             AND subscription_expires > NOW() AND subscription_expires <= DATE_ADD(NOW(), INTERVAL 7 DAY)`
        ).catch(()=>[[{c:0}]]);
        const revenue = await db.getAdminRevenueTotals();
        res.json({
            users:         userRow.c,
            totalMessages: msgRow.c,
            todayLogins:   loginRow.c,
            freePlan:      freeRow.c,
            paidPlan:      proRow.c,
            online24h:     onlineRow.c,
            expiringSoon:  expRow.c,
            revenue
        });
    } catch(e) { res.json({ users:0, totalMessages:0, todayLogins:0, freePlan:0, paidPlan:0 }); }
});

app.get('/api/admin/revenue', requireAdminAuth, async (req, res) => {
    try {
        const period = req.query.period || 'month';
        const series = await db.getAdminRevenueSeries(period);
        const totals = await db.getAdminRevenueTotals();
        res.json({ period, series, totals });
    } catch (e) {
        res.json({ period: 'month', series: [], totals: {} });
    }
});

app.get('/api/admin/expiring', requireAdminAuth, async (req, res) => {
    try {
        const users = await db.getAdminExpiringUsers(7, 30);
        await fbNames.enrichUsersWithFacebookNames(db, users, { maxLookups: 15 });
        res.json({ users: stripUserTokens(users) });
    } catch (e) {
        res.json({ users: [] });
    }
});

app.get('/api/admin/users/:id', requireAdminAuth, async (req, res) => {
    try {
        const detail = await db.getAdminUserDetail(req.params.id);
        if (!detail) return res.status(404).json({ error: 'User not found' });
        await fbNames.enrichUsersWithFacebookNames(db, [detail.user], { maxLookups: 1 });
        res.json(detail);
    } catch (e) {
        res.status(500).json({ error: e.message || 'Failed to load user' });
    }
});

app.post('/api/admin/users/:id/sync-pages', requireAdminAuth, async (req, res) => {
    try {
        const result = await db.syncUserPagesFromFacebook(req.params.id, fetch);
        if (!result.ok) return res.status(400).json(result);
        res.json({ success: true, ...result });
    } catch (e) {
        res.status(500).json({ error: e.message || 'Sync failed' });
    }
});

// Sync Facebook names for users missing fb_name (admin)
app.post('/api/admin/users/sync-names', requireAdminAuth, async (req, res) => {
    try {
        const result = await fbNames.backfillMissingFacebookNames(db, 100);
        res.json({ success: true, ...result });
    } catch (e) {
        res.status(500).json({ error: e.message || 'Sync failed' });
    }
});

// List users
app.get('/api/admin/users', requireAdminAuth, async (req, res) => {
    const pool = db.pool;
    if (!pool) return res.json({ users: [], total: 0 });
    try {
        const page   = Math.max(1, parseInt(req.query.p) || 1);
        const limit  = 20;
        const offset = (page - 1) * limit;
        const search = req.query.q ? `%${req.query.q}%` : null;
        const planFilter = (req.query.plan || '').trim();
        const conditions = [];
        const countParams = [];
        if (search) {
            conditions.push('(u.fb_user_id LIKE ? OR u.fb_name LIKE ? OR u.email LIKE ? OR u.last_login_ip LIKE ?)');
            countParams.push(search, search, search, search);
        }
        if (planFilter) {
            conditions.push('u.plan = ?');
            countParams.push(planFilter);
        }
        const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
        const [[{total}]] = await pool.query(`SELECT COUNT(*) as total FROM users u ${where}`, countParams);
        const listParams = [...countParams, limit, offset];
        const [users] = await pool.query(
            `SELECT u.*,
              (SELECT COUNT(*) FROM user_fb_pages p WHERE p.fb_user_id = u.fb_user_id) AS page_count,
              GREATEST(0, COALESCE(u.messenger_messages_limit,0) - COALESCE(u.messenger_messages_used,0)) AS messages_remaining,
              (SELECT COALESCE(SUM(amount_cents),0) FROM payment_history ph
               WHERE ph.fb_user_id = u.fb_user_id AND ph.status = 'succeeded') AS total_revenue_cents,
              (SELECT COUNT(*) FROM payment_history ph
               WHERE ph.fb_user_id = u.fb_user_id AND ph.status = 'succeeded'
               AND (ph.billing_reason IN ('subscription_cycle','invoice.payment_succeeded')
                    OR ph.billing_reason LIKE '%renew%')) AS renewal_count
             FROM users u ${where} ORDER BY u.created_at DESC LIMIT ? OFFSET ?`,
            listParams
        );
        await fbNames.enrichUsersWithFacebookNames(db, users, { maxLookups: 25 });
        if (page === 1 && !search) {
            await fbNames.backfillMissingFacebookNames(db, 40);
        }
        res.json({ users: stripUserTokens(users), total, page, pages: Math.ceil(total / limit) });
    } catch(e) { res.json({ users:[], total:0 }); }
});

// Plan catalog for admin UI
app.get('/api/admin/plans', requireAdminAuth, (req, res) => {
    const { getPlanCatalogForAdmin } = require('../../config/plans');
    res.json({ plans: getPlanCatalogForAdmin() });
});

// Update user plan / quota (plan change = full activation with limits + expiry)
app.post('/api/admin/users/:id/update', requireAdminAuth, async (req, res) => {
    if (!db.pool) return res.status(500).json({ error: 'DB not connected' });
    try {
        const { plan, messages_limit, messages_used } = req.body;
        if (plan !== undefined) {
            const result = await db.adminActivatePlan(req.params.id, plan, { messages_limit });
            if (!result.ok) return res.status(400).json(result);
            const planKey = String(plan || '').toLowerCase();
            if (planKey && planKey !== 'free') {
                const transactionalEmail = require('../../services/transactional-email.service');
                transactionalEmail.queueSubscriptionActivated(
                    req.params.id, planKey, 'admin_activation', logError
                );
            }
            return res.json({ success: true, ...result });
        }
        const sets = [];
        const vals = [];
        if (messages_limit !== undefined) { sets.push('messenger_messages_limit=?'); vals.push(parseInt(messages_limit, 10)); }
        if (messages_used !== undefined)  { sets.push('messenger_messages_used=?'); vals.push(parseInt(messages_used, 10)); }
        if (!sets.length) return res.json({ success: true });
        vals.push(req.params.id);
        await db.pool.query(`UPDATE users SET ${sets.join(',')} WHERE fb_user_id=?`, vals);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Reset user quota
app.post('/api/admin/users/:id/reset-quota', requireAdminAuth, async (req, res) => {
    const pool = db.pool;
    if (!pool) return res.status(500).json({ error: 'DB not connected' });
    try {
        await pool.query('UPDATE users SET messenger_messages_used=0 WHERE fb_user_id=?', [req.params.id]);
        res.json({ success: true });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

// Delete user
app.delete('/api/admin/users/:id', requireAdminAuth, async (req, res) => {
    const pool = db.pool;
    if (!pool) return res.status(500).json({ error: 'DB not connected' });
    try {
        await pool.query('DELETE FROM users WHERE fb_user_id=?', [req.params.id]);
        res.json({ success: true });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

// Activity log
app.get('/api/admin/activity', requireAdminAuth, async (req, res) => {
    const pool = db.pool;
    if (!pool) return res.json({ logs: [] });
    const page   = Math.max(1, parseInt(req.query.p) || 1);
    const limit  = 50;
    const offset = (page - 1) * limit;
    const action = req.query.action || '';
    const where  = action ? 'WHERE action=?' : '';
    try {
        const [[{total}]] = await pool.query(`SELECT COUNT(*) as total FROM activity_log ${where}`, action ? [action] : []).catch(()=>[[{total:0}]]);
        const [logs] = await pool.query(`SELECT * FROM activity_log ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`, action ? [action, limit, offset] : [limit, offset]).catch(()=>[[]]);
        res.json({ logs, total, page, pages: Math.ceil(total / limit) });
    } catch(e) { res.json({ logs:[], total:0, page:1, pages:1 }); }
});

// Charts data
app.get('/api/admin/database', requireAdminAuth, async (req, res) => {
    try {
        const health = await db.getAdminDatabaseHealth();
        let hostDisk = null;
        try {
            const fs = require('fs');
            const path = require('path');
            const checkPath = process.env.DISK_CHECK_PATH || path.resolve(process.cwd());
            const stat = fs.statfsSync(checkPath);
            const total = Number(stat.blocks) * Number(stat.bsize);
            const free = Number(stat.bavail) * Number(stat.bsize);
            hostDisk = {
                path: checkPath,
                totalBytes: total,
                freeBytes: free,
                usedBytes: Math.max(0, total - free),
                usedPercent: total > 0 ? Math.round(((total - free) / total) * 10000) / 100 : 0
            };
        } catch (_) {}
        res.json({ ...health, hostDisk });
    } catch (e) {
        res.status(500).json({ connected: false, health: 'critical', error: e.message });
    }
});

app.get('/api/admin/charts', requireAdminAuth, async (req, res) => {
    const pool = db.pool;
    if (!pool) return res.json({ userGrowth: [], planDistribution: {}, dailyActivity: [] });
    try {
        const [growthRows]  = await pool.query(`SELECT DATE(created_at) as date, COUNT(*) as count FROM users WHERE created_at >= DATE_SUB(CURDATE(), INTERVAL 29 DAY) GROUP BY DATE(created_at) ORDER BY date ASC`).catch(()=>[[]]);
        const [planRows]    = await pool.query(`SELECT plan, COUNT(*) as count FROM users GROUP BY plan`).catch(()=>[[]]);
        const [actRows]     = await pool.query(`SELECT DATE(created_at) as date, COUNT(*) as count FROM activity_log WHERE created_at >= DATE_SUB(CURDATE(), INTERVAL 13 DAY) GROUP BY DATE(created_at) ORDER BY date ASC`).catch(()=>[[]]);
        const [topUsers]    = await pool.query(`SELECT fb_user_id, fb_name, fb_access_token, email, plan, messenger_messages_used, messenger_messages_limit FROM users ORDER BY messenger_messages_used DESC LIMIT 5`).catch(()=>[[]]);
        await fbNames.enrichUsersWithFacebookNames(db, topUsers, { maxLookups: 5 });
        const planDist = {};
        for (const r of planRows) planDist[r.plan] = Number(r.count);
        res.json({
            userGrowth:    growthRows.map(r => ({ date: r.date, count: Number(r.count) })),
            planDistribution: planDist,
            dailyActivity: actRows.map(r => ({ date: r.date, count: Number(r.count) })),
            topUsers: stripUserTokens(topUsers)
        });
    } catch(e) { res.json({ userGrowth: [], planDistribution: {}, dailyActivity: [], topUsers: [] }); }
});


};
