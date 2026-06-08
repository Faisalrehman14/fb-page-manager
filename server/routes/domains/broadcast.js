const { prepareBroadcastImagePayload } = require('../../services/broadcast-image.service');

/** broadcast routes */
module.exports = function mountBroadcast(app, ctx) {
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

// ── Quota ───────────────────────────────────────────────────────────────────
app.get('/api/user/quota', requireAuth, async (req, res) => {
    const uid = req.session.userId;
    if (!uid) return res.status(401).json({ error: 'Not authenticated' });
    try {
        const ent = await entitlementsSvc.resolveEntitlements(db, uid);
        const check = await db.assertQuota(uid, 1);
        res.json({
            ...ent,
            remaining: check.remaining ?? ent.remaining,
            canSend: !!check.ok,
            code: check.ok ? null : (check.code || ent.code)
        });
    } catch (err) {
        logError('user_quota', err);
        res.status(500).json({ error: 'Failed to load quota' });
    }
});

app.post(['/api/update_quota', '/api/update_quota.php'], requireAuth, verifyCsrf, async (req, res) => {
    const { fb_user_id, count } = req.body;
    const uid = req.session.userId;
    if (!uid) return res.status(401).json({ error: 'Not authenticated' });
    if (fb_user_id && fb_user_id !== uid) return res.status(403).json({ error: 'Forbidden' });
    
    try {
        const n = Math.max(0, parseInt(count, 10) || 0);
        if (n > 0) {
            const quota = await db.assertQuota(uid, n);
            if (!quota.ok) {
                const ent = await entitlementsSvc.resolveEntitlements(db, uid);
                return res.status(402).json({
                    success: false,
                    error: quota.message,
                    code: quota.code,
                    remaining: quota.remaining,
                    limit: quota.limit,
                    messagesUsed: quota.used ?? ent.messagesUsed,
                    messageLimit: quota.limit ?? ent.messageLimit,
                    subscriptionStatus: quota.plan || ent.plan || 'free',
                    plan: quota.plan || ent.plan || 'free',
                    trialDaysLeft: ent.trialDaysLeft,
                    trialExpired: ent.trialExpired,
                    onFreeTrial: ent.onFreeTrial,
                    display: ent.display
                });
            }
        }
        const result = await db.updateUserQuota(uid, n);
        if (result) res.json(result);
        else res.status(404).json({ error: 'User not found' });
    } catch (err) {
        logError('update_quota', err);
        res.status(500).json({ error: 'Failed to update quota' });
    }
});

// ── Cleanup blocked conversations (immediate, per-page) ──────────────────────
app.post('/api/conversations/cleanup', requireAuth, async (req, res) => {
    if (!state.dbConnected) return res.status(503).json({ error: 'Database not connected' });
    try {
        const pages = req.session.pageTokens ? Object.entries(req.session.pageTokens) : [];
        if (!pages.length) return res.status(400).json({ error: 'No page tokens in session. Re-login.' });
        let totalDeleted = 0;
        for (const [pageId, token] of pages) {
            try {
                const convs = await db.syncConversationsFromFacebook(pageId, token, fetch);
                // syncConversationsFromFacebook already does the DELETE internally (awaited)
                totalDeleted += convs.length; // not deleted count but synced
            } catch (err) {
                logError('conversations_cleanup', err, { pageId });
            }
        }
        res.json({ success: true, message: `Cleaned up ${pages.length} page(s), ${totalDeleted} active conversations kept` });
    } catch (err) {
        logError('conversations_cleanup', err);
        res.status(500).json({ error: err.message });
    }
});

// ── Sync ──────────────────────────────────────────────────────────────────────
app.post('/api/sync/all', requireAuth, verifyCsrf, async (req, res) => {
    if (!state.dbConnected) return res.status(503).json({ error: 'Database not connected' });
    try {
        await recordMetaReviewTests(req.session.accessToken);

        const fbRes = await fetch(graphUrlWithProof('/me/accounts?fields=id,name,picture,access_token', req.session.accessToken));
        const data  = await fbRes.json();
        if (data.error) throw new Error(data.error.message);
        res.json({ success: true, message: `Sync started for ${(data.data || []).length} pages` });
        for (const page of (data.data || [])) {
            db.syncPageSmart(page.id, page.access_token, fetch)
                .catch(err => logError('sync_all_bg', err, { pageId: page.id }));
        }
    } catch (err) {
        logError('sync_all', err);
        if (!res.headersSent) res.status(500).json({ error: err.message });
    }
});

// ── Broadcast image — upload to Meta once, reuse attachment_id per recipient ───
app.post('/api/broadcast/prepare-image', requireAuth, verifyCsrf, async (req, res) => {
    const { page_id: pageId, page_token: bodyToken, image_url: imageUrl } = req.body || {};
    if (!pageId || !/^\d+$/.test(String(pageId))) {
        return res.status(400).json({ error: 'page_id required' });
    }
    if (!imageUrl || !String(imageUrl).trim()) {
        return res.status(400).json({ error: 'image_url required' });
    }
    const pageToken = bodyToken
        || req.session.pageTokens?.[pageId]
        || (state.dbConnected ? await db.getPageToken(pageId) : null);
    if (!pageToken) return res.status(401).json({ error: 'Page token not found' });

    try {
        const siteUrl = resolveSiteUrl(req);
        const payload = await prepareBroadcastImagePayload({
            pageId,
            pageToken,
            imageUrl: String(imageUrl).trim(),
            fetchFn: fetch,
            fs,
            uploadsDir: paths.UPLOADS,
            siteUrl
        });
        res.json({ success: true, ...payload });
    } catch (err) {
        logError('broadcast_prepare_image', err, { pageId });
        res.status(400).json({
            error: err.message || 'Could not prepare image for broadcast'
        });
    }
});

// ── Scheduled Broadcasts ─────────────────────────────────────────────────────

app.post('/api/schedules', requireAuth, verifyCsrf, async (req, res) => {
    const { pages, message, image_url, delay_ms, scheduled_at } = req.body;
    if (!pages?.length || !message || !scheduled_at)
        return res.status(400).json({ error: 'pages, message, scheduled_at required' });
    const scheduledDate = new Date(scheduled_at);
    if (isNaN(scheduledDate) || scheduledDate <= new Date())
        return res.status(400).json({ error: 'scheduled_at must be a future date/time' });
    for (const p of pages) {
        if (!p.id || !p.token) return res.status(400).json({ error: 'Each page needs id and token' });
    }
    try {
        const id = await db.createSchedule({
            fb_user_id: req.session.userId,
            pages,
            message,
            image_url: image_url || null,
            delay_ms: Math.max(25, parseInt(delay_ms) || 400),
            scheduled_at: scheduledDate
        });
        res.json({ success: true, id });
    } catch (err) {
        logError('create_schedule', err);
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/schedules', requireAuth, async (req, res) => {
    try {
        res.setHeader('Cache-Control', 'no-store');
        const rows = await db.getSchedules(req.session.userId);
        res.json({ schedules: rows });
    } catch (err) {
        logError('get_schedules', err);
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/dashboard/summary', requireAuth, async (req, res) => {
    try {
        res.setHeader('Cache-Control', 'no-store');
        const pageIds = Object.keys(req.session.pageTokens || {});
        const schedules = state.dbConnected && req.session.userId
            ? await db.getSchedules(req.session.userId)
            : [];
        const unreadByPage = state.dbConnected && pageIds.length
            ? await db.getUnreadCountsForPages(pageIds)
            : {};
        let unreadTotal = 0;
        for (const pid of pageIds) unreadTotal += unreadByPage[pid] || 0;

        const pendingStatuses = new Set(['pending', 'running']);
        const scheduleStats = {
            total: schedules.length,
            pending: schedules.filter(s => pendingStatuses.has(s.status)).length,
            done: schedules.filter(s => s.status === 'done').length,
            failed: schedules.filter(s => s.status === 'failed').length
        };

        let quota = null;
        if (state.dbConnected && req.session.userId) {
            quota = await db.updateUserQuota(req.session.userId, 0);
        }

        res.json({
            schedules,
            scheduleStats,
            unread: { total: unreadTotal, byPage: unreadByPage },
            pagesCount: pageIds.length,
            quota: quota ? {
                messagesUsed: quota.messenger_messagesUsed ?? 0,
                messageLimit: quota.messageLimit ?? 2000,
                subscriptionStatus: quota.subscriptionStatus || 'free'
            } : null,
            updatedAt: new Date().toISOString()
        });
    } catch (err) {
        logError('dashboard_summary', err);
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/schedules/:id', requireAuth, verifyCsrf, async (req, res) => {
    try {
        const ok = await db.cancelSchedule(parseInt(req.params.id), req.session.userId);
        if (!ok) return res.status(404).json({ error: 'Schedule not found or already started' });
        res.json({ success: true });
    } catch (err) {
        logError('cancel_schedule', err);
        res.status(500).json({ error: err.message });
    }
});

// ── Broadcast Scheduler — runs every 60 s ────────────────────────────────────
// Send messages exactly like manual broadcast (enqueueAndSendUtility in fb_api.js)
const BROADCAST_TEXT_IMAGE_GAP_MS = 80;
const BROADCAST_IMAGE_ONLY_PACE_MS = 25;

async function sendToPage(pageId, pageToken, psids, nameMap, message, image_url, delay_ms, siteUrl) {
    let sent = 0, failed = 0;
    const base = `${FB_GRAPH_BASE}/${pageId}/messages`;
    const imageOnly = !!(image_url && !String(message || '').trim());
    const userPace = Math.max(25, parseInt(delay_ms, 10) || 400);
    const paceMs = imageOnly
        ? (userPace >= 1500 ? Math.min(userPace, 500) : Math.min(userPace, BROADCAST_IMAGE_ONLY_PACE_MS))
        : userPace;

    let imagePayload = null;
    if (image_url) {
        try {
            imagePayload = await prepareBroadcastImagePayload({
                pageId,
                pageToken,
                imageUrl: image_url,
                fetchFn: fetch,
                fs,
                uploadsDir: paths.UPLOADS,
                siteUrl: siteUrl || ''
            });
        } catch (err) {
            logError('sendToPage_prepare_image', err, { pageId });
            return { sent: 0, failed: psids.length };
        }
    }

    for (let idx = 0; idx < psids.length; idx++) {
        const psid = psids[idx];
        let ok = true;
        try {
            if (imagePayload) {
                const body = new URLSearchParams({
                    recipient:      JSON.stringify({ id: psid }),
                    message:        JSON.stringify({ attachment: { type: 'image', payload: imagePayload } }),
                    messaging_type: 'UTILITY',
                    access_token:   pageToken
                });
                const r = await fetch(base, { method: 'POST', body });
                const d = await r.json();
                if (d.error) { failed++; ok = false; }
                else if (message && BROADCAST_TEXT_IMAGE_GAP_MS > 0) {
                    await new Promise(res => setTimeout(res, BROADCAST_TEXT_IMAGE_GAP_MS));
                }
            }

            if (!ok) continue;

            if (message) {
                const recipientName    = nameMap[psid] || 'Friend';
                const personalizedText = message.replace(/\{\{name\}\}/gi, recipientName);
                const body = new URLSearchParams({
                    recipient:      JSON.stringify({ id: psid }),
                    message:        JSON.stringify({ text: personalizedText }),
                    messaging_type: 'UTILITY',
                    access_token:   pageToken
                });
                const r = await fetch(base, { method: 'POST', body });
                const d = await r.json();
                if (d.error) failed++; else sent++;
            } else if (imagePayload) {
                sent++;
            }
        } catch (_) { failed++; }

        if (idx < psids.length - 1 && paceMs > 0) {
            await new Promise(res => setTimeout(res, paceMs));
        }
    }
    return { sent, failed };
}

// Fetch recipients exactly like manual broadcast (fb_api.js fetchConversations)
// Priority: Facebook API with can_reply filter. DB only if FB API returns nothing.
async function fetchPageRecipients(pageId, pageToken) {
    const psidSet = new Set();
    const nameMap = {};

    try {
        let url = graphUrlWithProof(`/${pageId}/conversations?fields=id,participants{id,name},can_reply&limit=200`, pageToken);
        while (url) {
            const r    = await fetch(url);
            const data = await r.json();
            if (data.error) throw new Error(data.error.message);
            for (const conv of (data.data || [])) {
                if (conv.can_reply === false) continue; // skip blocked — same as manual broadcast
                for (const p of (conv.participants?.data || [])) {
                    if (!p.id || p.id === pageId) continue;
                    psidSet.add(p.id);
                    if (p.name) nameMap[p.id] = p.name;
                }
            }
            url = data.paging?.next || null;
        }
    } catch (err) {
        logError('fetchPageRecipients_fb', err, { pageId });
    }

    // Only use DB cache if Facebook API returned nothing (network failure etc.)
    if (psidSet.size === 0) {
        try {
            const dbPsids = await db.getPagePsids(pageId);
            dbPsids.forEach(id => psidSet.add(id));
        } catch (_) {}
    }

    return { psids: [...psidSet], nameMap };
}

async function runScheduledBroadcast(schedule) {
    const { id, pages, message, image_url, delay_ms } = schedule;
    const siteUrl = (process.env.SITE_URL || BASE_URL || '').replace(/\/$/, '');
    await db.updateScheduleStatus(id, 'running');
    try {
        // All pages run simultaneously in parallel
        const results = await Promise.allSettled(
            pages.map(async (page) => {
                const { psids, nameMap } = await fetchPageRecipients(page.id, page.token);
                const { sent, failed }   = await sendToPage(page.id, page.token, psids, nameMap, message, image_url, delay_ms, siteUrl);
                return { recipients: psids.length, sent, failed };
            })
        );

        let totalRecipients = 0, totalSent = 0, totalFailed = 0;
        for (const r of results) {
            if (r.status === 'fulfilled') {
                totalRecipients += r.value.recipients;
                totalSent       += r.value.sent;
                totalFailed     += r.value.failed;
            } else {
                logError('scheduled_broadcast_page', r.reason, { scheduleId: id });
                totalFailed++;
            }
        }
        await db.updateScheduleStatus(id, 'done', { total: totalRecipients, sent: totalSent, failed: totalFailed });
    } catch (err) {
        await db.updateScheduleStatus(id, 'failed', { error: err.message.substring(0, 200) });
        logError('scheduled_broadcast', err, { scheduleId: id });
    }
}

function startBroadcastScheduler() {
    setInterval(async () => {
        try {
            const due = await db.getDueSchedules();
            for (const s of due) {
                runScheduledBroadcast(s).catch(err => logError('scheduler_run', err, { id: s.id }));
            }
        } catch (err) {
            logError('scheduler_tick', err);
        }
    }, 60_000);
    console.log('Broadcast scheduler started (60s interval)');
}

  ctx.startBroadcastScheduler = startBroadcastScheduler;
};
