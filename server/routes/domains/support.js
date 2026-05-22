/** support routes */
module.exports = function mountSupport(app, ctx) {
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

// ── Support / Contact Us ─────────────────────────────────────────────────────
app.get('/api/support/info', async (req, res) => {
    try {
        if (!state.dbConnected) return res.json({ enabled: false });
        const cfg = await db.getSupportPageConfig();
        res.json(cfg);
    } catch (err) {
        res.json({ enabled: false });
    }
});

app.get('/api/admin/support', requireAdminAuth, async (req, res) => {
    try {
        const cfg = await db.getSupportPageConfig();
        res.json(cfg);
    } catch (err) {
        logError('admin_support_get', err);
        res.status(500).json({ error: 'Failed to load support config' });
    }
});

app.post('/api/admin/support', requireAdminAuth, async (req, res) => {
    try {
        const { page_input, page_name, email } = req.body || {};
        const cfg = await db.setSupportPageConfig({ page_input, page_name, email }, fetch);
        res.json({ success: true, ...cfg });
    } catch (err) {
        logError('admin_support_set', err);
        res.status(500).json({ error: 'Failed to save support config' });
    }
});

// ── Support chat (user side) ─────────────────────────────────────────────────
app.get('/api/support/chat', requireAuth, async (req, res) => {
    try {
        const uid = req.session.userId;
        const name = req.session.userName || '';
        const pic  = req.session.userPicture || '';
        const cfg = await db.getSupportPageConfig().catch(() => ({}));
        const thread = await db.ensureSupportThread({ fb_user_id: uid, fb_name: name, fb_picture: pic });
        const messages = thread
            ? await db.getSupportMessages(thread.id, { limit: 200, since_cleared: true })
            : [];
        res.json({
            thread,
            messages,
            page: {
                name: cfg.page_name || 'FBCast Pro',
                handle: cfg.page_handle || '',
                page_url: cfg.page_url || '',
                email: cfg.email || ''
            }
        });
    } catch (err) {
        logError('support_chat_get', err);
        res.status(500).json({ error: 'Failed to load chat' });
    }
});

app.get('/api/support/chat/unread', requireAuth, async (req, res) => {
    try {
        const uid = req.session.userId;
        const thread = await db.getSupportThreadByUser(uid);
        res.json({ unread: thread ? Number(thread.user_unread || 0) : 0 });
    } catch (err) {
        res.json({ unread: 0 });
    }
});

app.post('/api/support/chat/send', requireAuth, verifyCsrf, async (req, res) => {
    try {
        const uid = req.session.userId;
        const name = req.session.userName || '';
        const pic  = req.session.userPicture || '';
        const body = String(req.body?.body || '').trim();
        if (!body) return res.status(400).json({ error: 'Message body required' });
        if (body.length > 4000) return res.status(400).json({ error: 'Message too long' });

        const thread = await db.ensureSupportThread({ fb_user_id: uid, fb_name: name, fb_picture: pic });
        if (!thread) return res.status(500).json({ error: 'Thread unavailable' });

        const msg = await db.sendSupportMessage({
            thread_id: thread.id,
            sender_type: 'user',
            sender_id: uid,
            body
        });

        try {
            io.to(`user_${uid}`).emit('support:message', { thread_id: thread.id, message: msg });
            io.to('admin_support').emit('support:new_message', {
                thread_id: thread.id,
                fb_user_id: uid,
                fb_name: name,
                message: msg
            });
        } catch (_) {}

        res.json({ success: true, message: msg, thread_id: thread.id });
    } catch (err) {
        logError('support_chat_send', err);
        res.status(500).json({ error: 'Failed to send message' });
    }
});

app.post('/api/support/chat/read', requireAuth, verifyCsrf, async (req, res) => {
    try {
        const uid = req.session.userId;
        const thread = await db.getSupportThreadByUser(uid);
        if (thread) await db.markSupportThreadRead({ thread_id: thread.id, side: 'user' });
        res.json({ success: true });
    } catch (err) {
        res.json({ success: false });
    }
});

// ── Support chat (admin side) ────────────────────────────────────────────────
app.get('/api/admin/support/threads', requireAdminAuth, async (req, res) => {
    try {
        const status = String(req.query.status || 'all');
        const search = String(req.query.search || '');
        const limit  = Math.min(500, parseInt(req.query.limit, 10) || 100);
        const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
        const threads = await db.listSupportThreads({ status, search, limit, offset });
        const unread_total = await db.getSupportAdminUnreadTotal();
        res.json({ threads, unread_total });
    } catch (err) {
        logError('admin_support_threads', err);
        res.status(500).json({ error: 'Failed to load threads' });
    }
});

app.get('/api/admin/support/threads/:id', requireAdminAuth, async (req, res) => {
    try {
        const id = parseInt(req.params.id, 10);
        const thread = await db.getSupportThreadById(id);
        if (!thread) return res.status(404).json({ error: 'Thread not found' });
        const messages = await db.getSupportMessages(id, { limit: 500 });
        res.json({ thread, messages });
    } catch (err) {
        logError('admin_support_thread_get', err);
        res.status(500).json({ error: 'Failed to load thread' });
    }
});

app.post('/api/admin/support/threads/:id/reply', requireAdminAuth, async (req, res) => {
    try {
        const id = parseInt(req.params.id, 10);
        const body = String(req.body?.body || '').trim();
        if (!body) return res.status(400).json({ error: 'Reply body required' });
        if (body.length > 4000) return res.status(400).json({ error: 'Reply too long' });
        const thread = await db.getSupportThreadById(id);
        if (!thread) return res.status(404).json({ error: 'Thread not found' });

        const msg = await db.sendSupportMessage({
            thread_id: id,
            sender_type: 'admin',
            sender_id: 'admin',
            body
        });

        try {
            io.to(`user_${thread.fb_user_id}`).emit('support:message', { thread_id: id, message: msg });
            io.to('admin_support').emit('support:new_message', {
                thread_id: id,
                fb_user_id: thread.fb_user_id,
                fb_name: thread.fb_name,
                message: msg
            });
        } catch (_) {}

        res.json({ success: true, message: msg });
    } catch (err) {
        logError('admin_support_reply', err);
        res.status(500).json({ error: 'Failed to send reply' });
    }
});

app.post('/api/admin/support/threads/:id/read', requireAdminAuth, async (req, res) => {
    try {
        const id = parseInt(req.params.id, 10);
        await db.markSupportThreadRead({ thread_id: id, side: 'admin' });
        res.json({ success: true });
    } catch (err) {
        res.json({ success: false });
    }
});

app.post('/api/admin/support/threads/:id/status', requireAdminAuth, async (req, res) => {
    try {
        const id = parseInt(req.params.id, 10);
        const status = String(req.body?.status || 'open');
        await db.setSupportThreadStatus(id, status);
        res.json({ success: true });
    } catch (err) {
        logError('admin_support_status', err);
        res.status(500).json({ error: 'Failed to update status' });
    }
});


};
