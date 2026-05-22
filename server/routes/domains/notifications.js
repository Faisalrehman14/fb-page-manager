/** notifications routes */
module.exports = function mountNotifications(app, ctx) {
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

// ── Admin Notifications ──────────────────────────────────────────────────────
app.get('/api/admin/notifications', requireAdminAuth, async (req, res) => {
    try {
        const limit  = Math.min(500, parseInt(req.query.limit, 10)  || 100);
        const offset = Math.max(0,   parseInt(req.query.offset, 10) || 0);
        const data = await db.listAdminNotifications({ limit, offset });
        res.json({
            notifications: data.notifications || [],
            totalUsers:    data.totalUsers || 0
        });
    } catch (err) {
        logError('admin_notifications_list', err);
        res.status(500).json({ error: 'Failed to load notifications' });
    }
});

app.get('/api/admin/notifications/:id/stats', requireAdminAuth, async (req, res) => {
    try {
        const stats = await db.getNotificationStats(req.params.id);
        if (!stats) return res.status(404).json({ error: 'Notification not found' });
        res.json(stats);
    } catch (err) {
        logError('admin_notifications_stats', err);
        res.status(500).json({ error: 'Failed to load stats' });
    }
});

app.post('/api/admin/notifications', requireAdminAuth, async (req, res) => {
    try {
        const {
            title, body, link_url, severity,
            target_type, target_user_id, expires_at
        } = req.body || {};
        let expDate = null;
        if (expires_at) {
            const d = new Date(expires_at);
            if (!isNaN(d.getTime())) expDate = d;
        }
        const id = await db.createAdminNotification({
            title,
            body,
            link_url,
            severity,
            target_type,
            target_user_id,
            expires_at: expDate,
            created_by: 'admin'
        });
        if (io) {
            const payload = {
                id, title, body, link_url, severity,
                target_type, target_user_id,
                created_at: new Date().toISOString()
            };
            if (target_type === 'user' && target_user_id) {
                io.to(`user_${target_user_id}`).emit('admin_notification', payload);
            } else {
                io.emit('admin_notification', payload);
            }
        }
        res.json({ success: true, id });
    } catch (err) {
        logError('admin_notifications_create', err);
        res.status(400).json({ error: err.message || 'Failed to create notification' });
    }
});

app.delete('/api/admin/notifications/:id', requireAdminAuth, async (req, res) => {
    try {
        const ok = await db.deleteAdminNotification(req.params.id);
        if (!ok) return res.status(404).json({ error: 'Notification not found' });
        res.json({ success: true });
    } catch (err) {
        logError('admin_notifications_delete', err);
        res.status(500).json({ error: 'Failed to delete notification' });
    }
});

// ── User Notifications ───────────────────────────────────────────────────────
app.get('/api/notifications', requireAuth, async (req, res) => {
    try {
        const uid = req.session.userId;
        if (!uid) return res.status(401).json({ error: 'Not authenticated' });
        if (!state.dbConnected) return res.json({ notifications: [], unread: 0 });
        const limit = Math.min(100, parseInt(req.query.limit, 10) || 25);
        const [notifications, unread] = await Promise.all([
            db.getNotificationsForUser(uid, { limit }),
            db.getUnreadNotificationCount(uid)
        ]);
        res.json({ notifications, unread });
    } catch (err) {
        logError('notifications_list', err);
        res.status(500).json({ error: 'Failed to load notifications' });
    }
});

app.get('/api/notifications/unread-count', requireAuth, async (req, res) => {
    try {
        const uid = req.session.userId;
        if (!uid) return res.json({ unread: 0 });
        if (!state.dbConnected) return res.json({ unread: 0 });
        const unread = await db.getUnreadNotificationCount(uid);
        res.json({ unread });
    } catch (err) {
        res.json({ unread: 0 });
    }
});

app.post('/api/notifications/:id/read', requireAuth, verifyCsrf, async (req, res) => {
    try {
        const uid = req.session.userId;
        if (!uid) return res.status(401).json({ error: 'Not authenticated' });
        await db.markNotificationRead(req.params.id, uid);
        res.json({ success: true });
    } catch (err) {
        logError('notification_read', err);
        res.status(500).json({ error: 'Failed to mark read' });
    }
});

app.post('/api/notifications/read-all', requireAuth, verifyCsrf, async (req, res) => {
    try {
        const uid = req.session.userId;
        if (!uid) return res.status(401).json({ error: 'Not authenticated' });
        const updated = await db.markAllNotificationsRead(uid);
        res.json({ success: true, updated });
    } catch (err) {
        logError('notifications_read_all', err);
        res.status(500).json({ error: 'Failed to mark all read' });
    }
});

// Disable caching for all /api/* routes
app.use('/api', (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    next();
});

// Redirect /index.html to / to ensure config injection
app.get('/index.html', (req, res) => res.redirect('/'));



};
