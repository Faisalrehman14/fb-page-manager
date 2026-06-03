/** ai routes */
module.exports = function mountAi(app, ctx) {
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

// ── AI Broadcast Assistant ───────────────────────────────────────────────────
app.get('/api/ai/info', requireAuth, (req, res) => {
    const cfg = aiAssistant.getConfig(env);
    const model = cfg.model || '';
    res.json({
        enabled: aiAssistant.isEnabled(env),
        model,
        freeTier: /free/i.test(model)
    });
});

app.post('/api/ai/chat', requireAuth, async (req, res) => {
    res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no'
    });
    try {
        const messages = Array.isArray(req.body?.messages) ? req.body.messages : [];
        await aiAssistant.streamChat({
            env, fetch,
            userId: req.session?.userId,
            messages,
            res
        });
    } catch (err) {
        logError('ai_chat_stream', err);
        try {
            res.write(`event: error\ndata: ${JSON.stringify({ message: 'Internal error' })}\n\n`);
            res.end();
        } catch (_) {}
    }
});

app.post('/api/admin/support/threads/:id/resolve', requireAdminAuth, async (req, res) => {
    try {
        const id = parseInt(req.params.id, 10);
        const thread = await db.getSupportThreadById(id);
        if (!thread) return res.status(404).json({ error: 'Thread not found' });

        const ok = await db.markSupportThreadResolved(id);
        if (!ok) return res.status(500).json({ error: 'Failed to resolve' });

        try {
            io.to(`user_${thread.fb_user_id}`).emit('support:resolved', { thread_id: id });
        } catch (_) {}

        res.json({ success: true });
    } catch (err) {
        logError('admin_support_resolve', err);
        res.status(500).json({ error: 'Failed to resolve thread' });
    }
});


};
