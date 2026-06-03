const express = require('express');
const rateLimit = require('express-rate-limit');
const { SyncService } = require('./sync-service');
const { ConversationService } = require('./conversation-service');
const { MessageService } = require('./message-service');
const { SendService } = require('./send-service');
const { PollService } = require('./poll-service');
const { SearchService } = require('./search-service');
const { resolvePageToken } = require('./token-resolver');
const { mapPollMessage } = require('./mappers');
const { FbApiError, FacebookClient } = require('./facebook-client');

function messengerErrorResponse(err) {
    if (err instanceof FbApiError || err?.name === 'FbApiError') {
        return {
            status: 400,
            body: {
                error: FacebookClient.formatSendError(err),
                code: 'SEND_FAILED'
            }
        };
    }
    const msg = err?.message || 'Request failed';
    if (/page token not found/i.test(msg)) {
        return {
            status: 400,
            body: {
                error: 'Page not connected. Open Settings and reconnect Facebook.',
                code: 'PAGE_TOKEN_MISSING'
            }
        };
    }
    if (/missing fields|action required|not allowed/i.test(msg)) {
        return { status: 400, body: { error: msg } };
    }
    return { status: 500, body: { error: msg } };
}

/**
 * Build messenger HTTP handlers (action-based API for backward compatibility).
 */
function createMessengerRouter(deps) {
    const {
        db,
        getDbConnected,
        fetch: fetchFn,
        syncCooldown,
        io,
        logError,
        requireAuth,
        verifyCsrf
    } = deps;

    const syncService = new SyncService({ db, fetchFn, syncCooldown, logError });
    const conversationService = new ConversationService({ db, syncService, logError, io });
    const messageService = new MessageService({ db, logError, fetchFn });
    const sendService = new SendService({ db, io, fetchFn });
    const pollService = new PollService({ db });
    const searchService = new SearchService({ db });

    const router = express.Router();

    // Per-user send rate limiter — max 8 messages per 5 seconds
    // Prevents agents from flooding the Facebook API accidentally
    const _sendBuckets = new Map(); // userId → [timestamp, ...]
    function _checkSendLimit(userId) {
        if (!userId) return true;
        const now = Date.now();
        const win = 5_000;
        const max = 8;
        const bucket = (_sendBuckets.get(userId) || []).filter(t => now - t < win);
        if (bucket.length >= max) return false;
        bucket.push(now);
        _sendBuckets.set(userId, bucket);
        // Evict stale users to prevent memory growth
        if (_sendBuckets.size > 2_000) {
            const oldest = _sendBuckets.keys().next().value;
            _sendBuckets.delete(oldest);
        }
        return true;
    }

    const pollLimiter = rateLimit({
        windowMs: 60_000,
        max: 360,
        standardHeaders: true,
        legacyHeaders: false,
        message: { error: 'Poll rate limit — slow down' }
    });

    function pollOnly(req, res, next) {
        const action = req.query.action || req.body.action;
        if (req.method === 'GET' && (action === 'poll' || action === 'poll_pages' || action === 'recent_changes')) {
            return pollLimiter(req, res, next);
        }
        next();
    }

    const searchLimiter = rateLimit({
        windowMs: 60_000,
        max: 60,
        standardHeaders: true,
        legacyHeaders: false,
        message: { error: 'Search rate limit — slow down' }
    });

    function searchOnly(req, res, next) {
        const action = req.query.action || req.body.action;
        if (req.method === 'GET' && action === 'search') return searchLimiter(req, res, next);
        next();
    }

    function csrfOnWrite(req, res, next) {
        if (req.method === 'POST' && verifyCsrf) return verifyCsrf(req, res, next);
        next();
    }

    router.all('/', requireAuth, csrfOnWrite, pollOnly, searchOnly, async (req, res) => {
        const method = req.method;
        const action = req.query.action || req.body.action;
        const pageId = req.query.page_id || req.body.page_id;
        const dbConnected = getDbConnected();

        if (!action) return res.status(400).json({ error: 'Action required' });

        try {
            if (method === 'GET') {
                switch (action) {
                    case 'load_conversations': {
                        if (!pageId) return res.status(400).json({ error: 'page_id required' });
                        const result = await conversationService.list({
                            pageId,
                            limit: req.query.limit,
                            offset: req.query.offset,
                            refresh: req.query.refresh,
                            session: req.session,
                            dbConnected,
                            fetchFn
                        });
                        return res.json(result);
                    }
                    case 'load_messages': {
                        const psid = req.query.psid;
                        if (!pageId || !psid) {
                            return res.status(400).json({ error: 'page_id and psid required' });
                        }
                        const result = await messageService.load({
                            pageId,
                            psid,
                            limit: req.query.limit,
                            before: req.query.before || null,
                            refresh: req.query.refresh,
                            session: req.session,
                            dbConnected
                        });
                        return res.json(result);
                    }
                    case 'conversation_media': {
                        const psid = req.query.psid;
                        if (!pageId || !psid) {
                            return res.status(400).json({ error: 'page_id and psid required' });
                        }
                        const result = await messageService.loadMedia({
                            pageId,
                            psid,
                            limit: req.query.limit,
                            session: req.session,
                            dbConnected
                        });
                        return res.json(result);
                    }
                    case 'recent_changes':
                    case 'poll': {
                        if (!pageId) return res.status(400).json({ error: 'page_id required' });
                        const psid = req.query.psid || null;
                        const since = req.query.since || new Date(Date.now() - 10000).toISOString();
                        let metaSyncStarted = false;
                        if (dbConnected) {
                            const pageToken = await resolvePageToken({
                                pageId,
                                session: req.session,
                                db,
                                dbConnected,
                                fetchFn
                            });
                            if (pageToken) {
                                metaSyncStarted = true;
                                if (psid) {
                                    // Cap wait so 1s polls stay fast; sync continues in background if slow
                                    await Promise.race([
                                        syncService.syncActiveThreadOnPoll(pageId, pageToken, psid),
                                        new Promise((resolve) => setTimeout(resolve, 900))
                                    ]);
                                } else {
                                    syncService.syncOnPoll(pageId, pageToken, { psid: null }).catch(() => {});
                                }
                            }
                        }
                        const result = await pollService.poll({
                            pageId,
                            psid,
                            since,
                            dbConnected
                        });
                        if (psid && dbConnected) {
                            const conv = await db.getConversationIdByParticipant(pageId, psid);
                            if (conv?.id) {
                                const sinceDate = new Date(since);
                                const wideSince = new Date(
                                    (isNaN(sinceDate.getTime()) ? Date.now() : sinceDate.getTime()) - 120000
                                );
                                const wide = await db.getNewMessagesSince(conv.id, wideSince);
                                const seen = new Set(
                                    (result.new_messages || []).map((m) => m.mid || m.message_id).filter(Boolean)
                                );
                                for (const row of wide) {
                                    const mid = row.mid || row.message_id;
                                    if (mid && seen.has(mid)) continue;
                                    result.new_messages.push(mapPollMessage(row));
                                    if (mid) seen.add(mid);
                                }
                                if (wide.length) result.has_changes = true;
                            }
                        }
                        result.meta_sync = metaSyncStarted;
                        res.set('Cache-Control', 'no-store');
                        return res.json(result);
                    }
                    case 'poll_pages': {
                        const pageIds = Object.keys(req.session.pageTokens || {});
                        const since = req.query.since || null;
                        const activePageId = req.query.active_page_id || null;
                        const activePsid = req.query.active_psid || null;
                        if (!dbConnected || !pageIds.length) {
                            return res.json({
                                unread_by_page: {},
                                notifications: [],
                                server_time: new Date().toISOString()
                            });
                        }
                        const batch = await db.pollAllPagesInbox(pageIds, {
                            since,
                            activePageId,
                            activePsid,
                            limit: 25
                        });
                        res.set('Cache-Control', 'no-store');
                        return res.json({
                            unread_by_page: batch.unreadByPage || {},
                            notifications: batch.notifications || [],
                            server_time: new Date().toISOString()
                        });
                    }
                    case 'search': {
                        const q = (req.query.q || '').trim();
                        if (!pageId) return res.status(400).json({ error: 'page_id required' });
                        const pageToken = await resolvePageToken({
                            pageId,
                            session: req.session,
                            db,
                            dbConnected,
                            fetchFn
                        });
                        const result = await searchService.search({
                            pageId,
                            q,
                            dbConnected,
                            pageToken,
                            fetchFn
                        });
                        res.set('Cache-Control', 'private, max-age=5');
                        return res.json(result);
                    }
                    default:
                        break;
                }
            }

            if (method === 'POST') {
                switch (action) {
                    case 'send_like': {
                        const { psid, page_token } = req.body;
                        if (!pageId || !psid) {
                            return res.status(400).json({ error: 'Missing fields' });
                        }
                        if (!_checkSendLimit(req.session?.userId)) {
                            return res.status(429).json({ error: 'Sending too fast — slow down a moment' });
                        }
                        const userId = req.session?.userId;
                        if (userId && db.assertQuota) {
                            const quota = await db.assertQuota(userId, 1);
                            if (!quota.ok) {
                                return res.status(402).json({
                                    success: false,
                                    error: quota.message || 'Quota exceeded',
                                    code: quota.code
                                });
                            }
                        }
                        const result = await sendService.sendLike({ pageId, psid, page_token });
                        if (userId && db.updateUserQuota) {
                            await db.updateUserQuota(userId, 1);
                        }
                        return res.json(result);
                    }
                    case 'send_message': {
                        const { psid, message, image_url } = req.body;
                        let page_token = req.body.page_token;
                        if (!pageId || !psid || (!message && !image_url)) {
                            return res.status(400).json({ error: 'Missing fields' });
                        }
                        if (!page_token && dbConnected) {
                            page_token = await resolvePageToken({
                                pageId,
                                session: req.session,
                                db,
                                dbConnected,
                                fetchFn
                            });
                        }
                        if (!_checkSendLimit(req.session?.userId)) {
                            return res.status(429).json({ error: 'Sending too fast — slow down a moment' });
                        }
                        const userId = req.session?.userId;
                        if (userId && db.assertQuota) {
                            const quota = await db.assertQuota(userId, 1);
                            if (!quota.ok) {
                                return res.status(402).json({
                                    success: false,
                                    error: quota.message || 'Quota exceeded',
                                    code: quota.code,
                                    remaining: quota.remaining,
                                    limit: quota.limit,
                                    messagesUsed: quota.used ?? null,
                                    messageLimit: quota.limit ?? null,
                                    subscriptionStatus: quota.plan || 'free'
                                });
                            }
                        }
                        const result = await sendService.send({
                            pageId,
                            psid,
                            message,
                            image_url,
                            page_token
                        });
                        if (userId && db.updateUserQuota) {
                            await db.updateUserQuota(userId, 1);
                        }
                        return res.json(result);
                    }
                    case 'mark_read': {
                        const { psid, page_token } = req.body;
                        if (!pageId || !psid) return res.status(400).json({ error: 'Missing fields' });
                        let threadId = null;
                        if (dbConnected) {
                            const result = await sendService.markRead({ pageId, psid, page_token });
                            threadId = result?.threadId || null;
                        }
                        io.to(`page_${pageId}`).emit('thread_read', { pageId, psid, threadId });
                        if (threadId) {
                            io.to(`page_${pageId}`).emit('conversation_updated', {
                                id: threadId,
                                pageId,
                                participantId: psid,
                                isRead: true,
                                unreadCount: 0,
                                isLive: true
                            });
                        }
                        return res.json({ success: true, threadId });
                    }
                    case 'mark_unread': {
                        const { psid } = req.body;
                        if (!pageId || !psid) return res.status(400).json({ error: 'Missing fields' });
                        if (!dbConnected) return res.json({ success: true });
                        const convInfo = await db.getConversationIdByParticipant(pageId, psid);
                        if (convInfo?.id) {
                            await db.markAsUnread(convInfo.id);
                            io.to(`page_${pageId}`).emit('conversation_updated', {
                                id: convInfo.id,
                                pageId,
                                participantId: psid,
                                isRead: false,
                                unreadCount: 1,
                                isLive: true
                            });
                        }
                        return res.json({ success: true, threadId: convInfo?.id || null });
                    }
                    default:
                        break;
                }
            }

            return res.status(405).json({ error: 'Method or action not allowed' });
        } catch (err) {
            logError('messenger_api', err, { action, pageId });
            const { status, body } = messengerErrorResponse(err);
            return res.status(status).json(body);
        }
    });

    return { router, syncService };
}

module.exports = { createMessengerRouter };
