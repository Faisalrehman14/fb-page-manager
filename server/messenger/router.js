const express = require('express');
const rateLimit = require('express-rate-limit');
const { SyncService } = require('./sync-service');
const { ConversationService } = require('./conversation-service');
const { MessageService } = require('./message-service');
const { SendService } = require('./send-service');
const { PollService } = require('./poll-service');
const { SearchService } = require('./search-service');

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
        requireAuth
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
        max: 120,
        standardHeaders: true,
        legacyHeaders: false,
        message: { error: 'Poll rate limit — slow down' }
    });

    function pollOnly(req, res, next) {
        const action = req.query.action || req.body.action;
        if (req.method === 'GET' && action === 'poll') return pollLimiter(req, res, next);
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

    router.all('/', requireAuth, pollOnly, searchOnly, async (req, res) => {
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
                            session: req.session,
                            dbConnected
                        });
                        return res.json(result);
                    }
                    case 'poll': {
                        if (!pageId) return res.status(400).json({ error: 'page_id required' });
                        const since = req.query.since || new Date(Date.now() - 30000).toISOString();
                        const result = await pollService.poll({
                            pageId,
                            psid: req.query.psid,
                            since,
                            dbConnected
                        });
                        res.set('Cache-Control', 'no-store');
                        return res.json(result);
                    }
                    case 'search': {
                        const q = (req.query.q || '').trim();
                        if (!pageId) return res.status(400).json({ error: 'page_id required' });
                        const result = await searchService.search({ pageId, q, dbConnected });
                        res.set('Cache-Control', 'private, max-age=5');
                        return res.json(result);
                    }
                    default:
                        break;
                }
            }

            if (method === 'POST') {
                switch (action) {
                    case 'send_message': {
                        const { psid, message, page_token, image_url } = req.body;
                        if (!pageId || !psid || (!message && !image_url)) {
                            return res.status(400).json({ error: 'Missing fields' });
                        }
                        if (!_checkSendLimit(req.session?.userId)) {
                            return res.status(429).json({ error: 'Sending too fast — slow down a moment' });
                        }
                        const result = await sendService.send({
                            pageId,
                            psid,
                            message,
                            image_url,
                            page_token
                        });
                        return res.json(result);
                    }
                    case 'mark_read': {
                        const { psid } = req.body;
                        if (!pageId || !psid) return res.status(400).json({ error: 'Missing fields' });
                        if (dbConnected) {
                            await sendService.markRead({ pageId, psid });
                        }
                        // Broadcast to other agents so their unread badge updates instantly
                        io.to(`page_${pageId}`).emit('thread_read', { pageId, psid });
                        return res.json({ success: true });
                    }
                    default:
                        break;
                }
            }

            return res.status(405).json({ error: 'Method or action not allowed' });
        } catch (err) {
            logError('messenger_api', err, { action, pageId });
            return res.status(500).json({ error: err.message });
        }
    });

    return { router, syncService };
}

module.exports = { createMessengerRouter };
