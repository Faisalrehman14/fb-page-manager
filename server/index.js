require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const express    = require('express');
const session    = require('express-session');
const crypto     = require('crypto');
const path       = require('path');
const fs         = require('fs');
const { createServer } = require('http');
const { Server } = require('socket.io');
const multer     = require('multer');
const compression = require('compression');
const rateLimit  = require('express-rate-limit');
const db         = require('./db');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

const app        = express();
const httpServer = createServer(app);
const io         = new Server(httpServer, {
    cors: { origin: '*', methods: ['GET', 'POST'] },
    transports: ['websocket', 'polling']
});

// ── Config ────────────────────────────────────────────────────────────────────
const PORT                 = process.env.PORT || 3000;
const FB_APP_ID            = (process.env.FB_APP_ID            || '').trim();
const FB_APP_SECRET        = (process.env.FB_APP_SECRET        || '').trim();
const BASE_URL             = (process.env.BASE_URL             || '').trim();
const SESSION_SECRET       = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const WEBHOOK_VERIFY_TOKEN = (process.env.WEBHOOK_VERIFY_TOKEN || process.env.FB_WEBHOOK_VERIFY_TOKEN || 'ADMIN12345').trim();

let dbConnected = false;

// ── Logging ───────────────────────────────────────────────────────────────────
let requestLogs = [], webhookLogs = [], errorLogs = [];
const MAX_LOGS  = 100;

function logError(type, error, ctx = {}) {
    const entry = {
        id: `${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        time: new Date().toISOString(), type,
        message: error?.message || String(error),
        stack: error?.stack ? error.stack.split('\n').slice(0, 6).join('\n') : null,
        context: ctx
    };
    errorLogs.unshift(entry);
    if (errorLogs.length > MAX_LOGS) errorLogs.pop();
    console.error(`[ERROR:${type}]`, entry.message, Object.keys(ctx).length ? ctx : '');
    return entry;
}

process.on('unhandledRejection', r  => logError('unhandledRejection', r instanceof Error ? r : new Error(String(r))));
process.on('uncaughtException',  err => logError('uncaughtException',  err));

// ── Middleware ────────────────────────────────────────────────────────────────
app.set('trust proxy', 1);
app.use(compression());
app.use(rateLimit({ windowMs: 60000, max: 200, skip: req => req.url.includes('webhook') }));
app.use((req, res, next) => {
    if (req.url.includes('api') || req.method === 'POST') {
        requestLogs.unshift({ time: new Date().toISOString(), method: req.method, url: req.url });
        if (requestLogs.length > MAX_LOGS) requestLogs.pop();
    }
    next();
});
app.use(express.json({ verify: (req, res, buf) => { req.rawBody = buf; } }));
app.use(express.urlencoded({ extended: true }));

// ── Facebook Webhook (must be before express.static so fb_webhook.php isn't served as raw PHP) ──
app.get(['/webhook', '/fb_webhook.php'], (req, res) => {
    const { 'hub.mode': mode, 'hub.verify_token': token, 'hub.challenge': challenge } = req.query;
    if (mode === 'subscribe' && token === WEBHOOK_VERIFY_TOKEN) return res.send(challenge);
    res.sendStatus(403);
});

app.post(['/webhook', '/fb_webhook.php'], async (req, res) => {
    if (FB_APP_SECRET) {
        const sig      = req.headers['x-hub-signature-256'] || '';
        const expected = 'sha256=' + crypto.createHmac('sha256', FB_APP_SECRET).update(req.rawBody || Buffer.alloc(0)).digest('hex');
        if (sig && sig !== expected) { logError('webhook_sig', new Error('Invalid signature')); return res.sendStatus(403); }
    }

    res.sendStatus(200);

    const { object, entry } = req.body;
    if (object !== 'page' || !entry) return;

    webhookLogs.unshift({ time: new Date().toISOString(), entries: entry.length });
    if (webhookLogs.length > MAX_LOGS) webhookLogs.pop();

    for (const pageEntry of entry) {
        const pageId = pageEntry.id;
        for (const event of (pageEntry.messaging || [])) {
            try {
                if (!event.message) continue;
                const isEcho        = !!event.message.is_echo;
                const participantId = isEcho ? event.recipient?.id : event.sender?.id;
                if (!participantId) continue;

                const mid  = event.message.mid;
                const text = event.message.text || '';
                const ts   = event.timestamp ? new Date(event.timestamp).toISOString() : new Date().toISOString();

                let attachments = [];
                if (event.message.attachments?.length) {
                    attachments = event.message.attachments.map(a => ({ t: a.type || 'file', u: a.payload?.url || '' }));
                }

                const threadId = await db.ensureConversation(pageId, participantId);
                if (!threadId) continue;

                const saved = await db.saveMessage({
                    id: mid, threadId, pageId, senderId: participantId,
                    senderType: isEcho ? 'page' : 'user',
                    text, isFromPage: isEcho, createdTime: ts,
                    attachments: attachments.length ? attachments : null
                });

                if (saved && !isEcho) {
                    await db.onIncomingMessage(threadId, pageId, participantId, text);
                    const snippet = text || (attachments[0] ? `[${attachments[0].t}]` : '');
                    io.to(`page_${pageId}`).emit('new_message',          { id: mid, threadId, pageId, participantId, text, isFromPage: false, createdTime: ts, attachments });
                    io.to(`page_${pageId}`).emit('conversation_updated', { id: threadId, pageId, participantId, snippet, updatedTime: new Date(), isRead: false, unreadCount: 1, lastMessageFromPage: false });
                }
            } catch (err) { logError('webhook_event', err, { pageId }); }
        }
    }
});

// ── PHP-endpoint shims (Node.js replacements for legacy PHP calls) ────────────

// exchange_token.php — short-lived user token → long-lived token + page tokens
app.post(['/api/auth/exchange', '/api/exchange_token.php', '/exchange_token.php'], async (req, res) => {
    const userToken = (req.body?.user_token || '').trim();
    if (!userToken) return res.status(400).json({ error: 'user_token is required' });
    if (!FB_APP_ID || !FB_APP_SECRET) return res.status(500).json({ error: 'App credentials not configured' });

    try {
        // Step 1: Exchange short-lived → long-lived user token
        const exUrl  = `https://graph.facebook.com/v19.0/oauth/access_token?grant_type=fb_exchange_token&client_id=${FB_APP_ID}&client_secret=${FB_APP_SECRET}&fb_exchange_token=${encodeURIComponent(userToken)}`;
        const exRes  = await fetch(exUrl);
        const exData = await exRes.json();
        if (!exData.access_token) {
            const msg = exData.error?.message || 'Token exchange failed';
            return res.status(400).json({ error: msg });
        }
        const longToken = exData.access_token;

        // Step 2: Fetch pages with the long-lived token (~60-day page tokens)
        const pgUrl  = `https://graph.facebook.com/v19.0/me/accounts?fields=id,name,access_token,category,picture.type(large)&access_token=${encodeURIComponent(longToken)}`;
        const pgRes  = await fetch(pgUrl);
        const pgData = await pgRes.json();
        if (pgData.error) return res.status(400).json({ error: pgData.error.message || 'Failed to fetch pages' });

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
        const meRes  = await fetch(`https://graph.facebook.com/v19.0/me?fields=id,name&access_token=${encodeURIComponent(userToken)}`);
        const meData = await meRes.json();
        if (meData.error) return res.status(401).json({ error: meData.error.message });

        // Basic quota stub — extend with real DB quota logic when ready
        res.json({ success: true, user_id: meData.id, user_name: meData.name, quota: { used: 0, limit: 10000, plan: 'pro' } });
    } catch (err) {
        logError('track_user', err);
        res.status(500).json({ error: 'Tracking failed' });
    }
});

// Block raw PHP files — but allow them if they are the main entry or special cases
// Actually, we should redirect legacy PHP calls to their API equivalents
app.use((req, res, next) => {
    if (req.path.endsWith('.php')) {
        const legacyMap = {
            '/fb_proxy.php': '/api/fb-proxy',
            '/exchange_token.php': '/api/auth/fb-token', // or /exchange_token.php if we want to keep it
            '/track_user.php': '/api/auth/track',
            '/upload_image.php': '/api/upload-image'
        };
        if (legacyMap[req.path]) {
            req.url = legacyMap[req.path];
            return next();
        }
        // If it's not a mapped route, still block raw PHP
        return res.status(404).json({ error: 'Not found', hint: 'Use /api/* routes' });
    }
    next();
});

// Serve static assets from project root
app.use(express.static(path.join(__dirname, '..'), { maxAge: '1h', etag: true, index: false }));

const sessionMiddleware = session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
        secure: process.env.NODE_ENV === 'production',
        httpOnly: true,
        sameSite: 'lax',
        maxAge: 7 * 24 * 60 * 60 * 1000
    }
});
app.use(sessionMiddleware);

// Share session with Socket.io
io.use((socket, next) => {
    sessionMiddleware(socket.request, {}, err => {
        if (err) return next(new Error('Session error'));
        if (!socket.request.session?.accessToken) return next(new Error('Unauthorized'));
        next();
    });
});

// ── CSRF + Auth Helpers ───────────────────────────────────────────────────────
function generateCsrf(req) {
    if (!req.session.csrfToken) req.session.csrfToken = crypto.randomBytes(32).toString('hex');
    return req.session.csrfToken;
}
function verifyCsrf(req, res, next) {
    if (req.method === 'GET') return next();
    const t = req.headers['x-csrf-token'];
    if (!t || t !== req.session.csrfToken) return res.status(403).json({ error: 'Invalid CSRF token' });
    next();
}
function requireAuth(req, res, next) {
    if (!req.session.accessToken) return res.status(401).json({ redirect: '/' });
    next();
}

// ── Socket.io Rooms ───────────────────────────────────────────────────────────
const connectedSockets = new Map();
const syncCooldown     = new Map();
const syncAllCooldown  = new Map();

io.on('connection', socket => {
    connectedSockets.set(socket.id, { rooms: [], connectedAt: new Date().toISOString() });
    socket.on('join_page',    pageId   => socket.join(`page_${pageId}`));
    socket.on('leave_page',   pageId   => socket.leave(`page_${pageId}`));
    socket.on('join_thread',  threadId => socket.join(`thread_${threadId}`));
    socket.on('leave_thread', threadId => socket.leave(`thread_${threadId}`));
    socket.on('typing_start', ({ threadId, agentName }) => {
        if (threadId) socket.to(`thread_${threadId}`).emit('agent_typing', { threadId, agentName: agentName || 'Agent', typing: true });
    });
    socket.on('typing_stop', ({ threadId }) => {
        if (threadId) socket.to(`thread_${threadId}`).emit('agent_typing', { threadId, typing: false });
    });
    socket.on('disconnect', () => connectedSockets.delete(socket.id));
});


// ── Auth ──────────────────────────────────────────────────────────────────────
app.get('/api/csrf-token', (req, res) => res.json({ csrfToken: generateCsrf(req) }));

// Bridge: accept FB user token from old JS-SDK auth flow → create server session
app.post('/api/auth/fb-token', async (req, res) => {
    const { user_token } = req.body;
    if (!user_token) return res.status(400).json({ error: 'user_token required' });
    try {
        const uRes  = await fetch(`https://graph.facebook.com/v19.0/me?fields=id,name&access_token=${user_token}`);
        const uData = await uRes.json();
        if (uData.error) return res.status(401).json({ error: uData.error.message });
        req.session.accessToken = user_token;
        req.session.userId      = uData.id;
        req.session.userName    = uData.name;
        req.session.firstLogin  = !req.session.firstLogin ? true : false;
        generateCsrf(req);
        res.json({ authenticated: true, userName: uData.name, csrfToken: req.session.csrfToken });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/auth/login', (req, res) => {
    const state = crypto.randomBytes(16).toString('hex');
    req.session.oauthState = state;
    const redirectUri = `${BASE_URL}/api/auth/callback`;
    const scope = 'pages_show_list,pages_messaging,pages_read_engagement,pages_manage_metadata';
    res.json({ authUrl: `https://www.facebook.com/v19.0/dialog/oauth?client_id=${FB_APP_ID}&redirect_uri=${encodeURIComponent(redirectUri)}&scope=${scope}&state=${state}&response_type=code` });
});

app.get('/api/auth/callback', async (req, res) => {
    const { code, state, error } = req.query;
    if (error)  return res.redirect('/?error=' + encodeURIComponent(error));
    if (!state || state !== req.session.oauthState) return res.redirect('/?error=invalid_state');
    try {
        const redirectUri = `${BASE_URL}/api/auth/callback`;
        const tRes  = await fetch(`https://graph.facebook.com/v19.0/oauth/access_token?client_id=${FB_APP_ID}&redirect_uri=${encodeURIComponent(redirectUri)}&client_secret=${FB_APP_SECRET}&code=${code}`);
        const tData = await tRes.json();
        if (tData.error) throw new Error(tData.error.message);

        const uRes  = await fetch(`https://graph.facebook.com/v19.0/me?fields=id,name&access_token=${tData.access_token}`);
        const uData = await uRes.json();
        if (uData.error) throw new Error(uData.error.message);

        req.session.accessToken = tData.access_token;
        req.session.userId      = uData.id;
        req.session.userName    = uData.name;
        req.session.oauthState  = null;
        req.session.firstLogin  = true;
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

app.post('/api/auth/logout', verifyCsrf, (req, res) => { req.session.destroy(); res.json({ redirect: '/' }); });

// ── Pages ─────────────────────────────────────────────────────────────────────
app.get('/api/pages', requireAuth, async (req, res) => {
    try {
        const fbRes = await fetch(`https://graph.facebook.com/v19.0/me/accounts?fields=id,name,picture,access_token&access_token=${req.session.accessToken}`);
        const data  = await fbRes.json();
        if (data.error) throw new Error(data.error.message);

        req.session.pageTokens = {};
        const pagesToSave = (data.data || []).map(p => ({ id: p.id, name: p.name, picture: p.picture?.data?.url, accessToken: p.access_token }));

        if (dbConnected) {
            await db.savePages(pagesToSave);
            if (req.session.firstLogin) {
                req.session.firstLogin = false;
                Promise.all(pagesToSave.map(p =>
                    db.syncPageInitial(p.id, p.accessToken, fetch, prog => io.emit('sync_progress', prog))
                        .catch(err => logError('initial_sync', err, { pageId: p.id }))
                )).then(() => io.emit('sync_progress', { phase: 'done' })).catch(() => {});
            } else {
                const now = Date.now();
                for (const p of pagesToSave) {
                    const last = syncAllCooldown.get(p.id) || 0;
                    if (now - last > 300000) {
                        syncAllCooldown.set(p.id, now);
                        db.syncPageIncremental(p.id, p.accessToken, fetch, prog => io.emit('sync_progress', prog))
                            .catch(err => logError('incremental_sync', err, { pageId: p.id }));
                    }
                }
            }
        }

        (data.data || []).forEach(p => { req.session.pageTokens[p.id] = p.access_token; });

        // Auto-subscribe pages to webhook events
        for (const p of (data.data || [])) {
            fetch(`https://graph.facebook.com/v19.0/${p.id}/subscribed_apps`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ subscribed_fields: ['messages', 'messaging_postbacks', 'message_deliveries', 'message_reads', 'conversations'], access_token: p.access_token })
            }).catch(() => {});
        }

        const pageIds      = (data.data || []).map(p => p.id);
        const unreadCounts = dbConnected ? await db.getUnreadCountsForPages(pageIds) : {};

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

// ── Conversations ─────────────────────────────────────────────────────────────
app.get('/api/pages/:pageId/conversations', requireAuth, async (req, res) => {
    const { pageId } = req.params;
    let token = req.session.pageTokens?.[pageId] || (dbConnected ? await db.getPageToken(pageId) : null);
    if (!token) return res.status(401).json({ error: 'Page token not found. Reload pages.', tokenMissing: true });

    const limit    = Math.min(parseInt(req.query.limit)  || 100, 200);
    const offset   = Math.max(parseInt(req.query.offset) || 0, 0);
    const archived = req.query.archived === 'true';

    try {
        if (dbConnected) {
            const [convs, total] = await Promise.all([
                db.getConversations(pageId, limit, offset, archived),
                offset === 0 ? db.getConversationCount(pageId, archived) : Promise.resolve(null)
            ]);
            if (convs.length > 0 || offset > 0) {
                res.json({ conversations: convs, hasMore: convs.length === limit, offset, total, fromCache: true });
                if (offset === 0 && !archived) {
                    const now = Date.now(), last = syncCooldown.get(pageId) || 0;
                    if (now - last > 60000) {
                        syncCooldown.set(pageId, now);
                        db.syncConversationsFromFacebook(pageId, token, fetch).catch(err => logError('bg_sync', err, { pageId }));
                    }
                }
                return;
            }
        }
        const convs = await db.syncConversationsFromFacebook(pageId, token, fetch);
        res.json({ conversations: convs, hasMore: false, offset: 0, total: convs.length, fromCache: false });
    } catch (err) {
        logError('conversations_route', err, { pageId });
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/pages/:pageId/conversations/search', requireAuth, async (req, res) => {
    const q = (req.query.q || '').trim();
    if (!q || !dbConnected) return res.json({ conversations: [] });
    try { res.json({ conversations: await db.searchConversations(req.params.pageId, q, 30) }); }
    catch (err) { res.status(500).json({ error: err.message, conversations: [] }); }
});

app.post('/api/pages/:pageId/mark-all-read', requireAuth, verifyCsrf, async (req, res) => {
    if (!dbConnected) return res.status(503).json({ error: 'DB not connected' });
    try {
        const count = await db.markAllAsRead(req.params.pageId);
        io.to(`page_${req.params.pageId}`).emit('all_read', { pageId: req.params.pageId });
        res.json({ ok: true, updated: count });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Messages ──────────────────────────────────────────────────────────────────
app.get('/api/threads/:threadId/messages', requireAuth, async (req, res) => {
    const { threadId } = req.params;
    const pageId = req.query.pageId;
    let token = req.session.pageTokens?.[pageId] || (dbConnected ? await db.getPageToken(pageId) : null);
    if (!token) return res.status(401).json({ error: 'Page token not found', tokenMissing: true });

    try {
        const fmt = m => ({ id: m.id, text: m.text, attachments: m.attachments || [], isFromPage: m.isFromPage, senderId: m.senderId, createdTime: m.createdTime });
        if (dbConnected) {
            const cached = await db.getMessages(threadId, parseInt(req.query.limit) || 100);
            if (cached.length > 0) {
                res.json({ messages: cached.map(fmt), fromCache: true });
                db.syncMessagesFromFacebook(threadId, pageId, token, fetch).catch(() => {});
                return;
            }
        }
        const msgs = await db.syncMessagesFromFacebook(threadId, pageId, token, fetch);
        res.json({ messages: msgs.map(fmt), fromCache: false });
    } catch (err) {
        logError('messages_route', err, { threadId, pageId });
        res.status(500).json({ error: err.message });
    }
});

// ── Send Message ──────────────────────────────────────────────────────────────
app.post('/api/threads/:threadId/reply', requireAuth, verifyCsrf, async (req, res) => {
    const { threadId } = req.params;
    const { pageId, recipientId, message } = req.body;
    if (!pageId      || !/^\d+$/.test(pageId))      return res.status(400).json({ error: 'Invalid pageId' });
    if (!recipientId || !/^\d+$/.test(recipientId)) return res.status(400).json({ error: 'Invalid recipientId' });
    if (!message || !message.trim())                return res.status(400).json({ error: 'Message required' });
    if (message.length > 2000)                      return res.status(400).json({ error: 'Message too long' });

    let token = req.session.pageTokens?.[pageId] || (dbConnected ? await db.getPageToken(pageId) : null);
    if (!token) return res.status(401).json({ error: 'Page token not found', tokenMissing: true });

    try {
        const fbRes = await fetch(`https://graph.facebook.com/v19.0/me/messages?access_token=${token}`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ recipient: { id: recipientId }, message: { text: message.trim() } })
        });
        const data = await fbRes.json();
        if (data.error) throw new Error(data.error.message);

        const createdTime = new Date().toISOString();
        if (dbConnected) {
            await db.saveMessage({ id: data.message_id, threadId, pageId, senderId: pageId, senderType: 'page', text: message.trim(), isFromPage: true, createdTime });
            await db.markAsRead(threadId);
        }

        io.to(`page_${pageId}`).emit('new_message',        { id: data.message_id, threadId, text: message.trim(), isFromPage: true, senderId: pageId, createdTime });
        io.to(`page_${pageId}`).emit('conversation_updated', { id: threadId, pageId, snippet: message.trim(), updatedTime: new Date(), isRead: true, unreadCount: 0, lastMessageFromPage: true });
        res.json({ success: true, messageId: data.message_id });
    } catch (err) {
        logError('reply_route', err, { pageId, threadId });
        res.status(500).json({ error: err.message });
    }
});

// ── Read / Unread ─────────────────────────────────────────────────────────────
app.post('/api/threads/:threadId/read', requireAuth, verifyCsrf, async (req, res) => {
    const pageId = req.body?.pageId || req.query?.pageId;
    if (dbConnected) await db.markAsRead(req.params.threadId).catch(() => {});
    if (pageId) io.to(`page_${pageId}`).emit('conversation_updated', { id: req.params.threadId, pageId, isRead: true, unreadCount: 0, isLive: true });
    res.json({ success: true });
});

app.post('/api/threads/:threadId/unread', requireAuth, verifyCsrf, async (req, res) => {
    const pageId = req.body?.pageId;
    if (dbConnected) await db.markAsUnread(req.params.threadId).catch(() => {});
    if (pageId) io.to(`page_${pageId}`).emit('conversation_updated', { id: req.params.threadId, pageId, isRead: false, unreadCount: 1, isLive: true });
    res.json({ success: true });
});

// ── Archive ───────────────────────────────────────────────────────────────────
app.post('/api/threads/:threadId/archive', requireAuth, verifyCsrf, async (req, res) => {
    if (!dbConnected) return res.status(503).json({ error: 'DB not connected' });
    try {
        await db.archiveConversation(req.params.threadId, req.body.pageId);
        io.to(`page_${req.body.pageId}`).emit('conversation_archived', { convId: req.params.threadId, pageId: req.body.pageId });
        res.json({ ok: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/threads/:threadId/unarchive', requireAuth, verifyCsrf, async (req, res) => {
    if (!dbConnected) return res.status(503).json({ error: 'DB not connected' });
    try {
        await db.unarchiveConversation(req.params.threadId, req.body.pageId);
        io.to(`page_${req.body.pageId}`).emit('conversation_unarchived', { convId: req.params.threadId, pageId: req.body.pageId });
        res.json({ ok: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Notes ─────────────────────────────────────────────────────────────────────
app.get('/api/threads/:threadId/notes', requireAuth, async (req, res) => {
    if (!dbConnected) return res.json({ notes: [] });
    try { res.json({ notes: await db.getNotes(req.params.threadId) }); }
    catch (err) { res.status(500).json({ error: err.message, notes: [] }); }
});

app.post('/api/threads/:threadId/notes', requireAuth, verifyCsrf, async (req, res) => {
    if (!dbConnected) return res.status(503).json({ error: 'DB not connected' });
    const { body, pageId } = req.body;
    if (!body?.trim()) return res.status(400).json({ error: 'Note body required' });
    try {
        const note = await db.saveNote(req.params.threadId, pageId, req.session.userName || 'Agent', body.trim());
        io.to(`thread_${req.params.threadId}`).emit('note_added', { threadId: req.params.threadId, note });
        res.json({ note });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/threads/:threadId/notes/:noteId', requireAuth, verifyCsrf, async (req, res) => {
    if (!dbConnected) return res.status(503).json({ error: 'DB not connected' });
    try {
        await db.deleteNote(req.params.noteId, req.body.pageId);
        io.to(`thread_${req.params.threadId}`).emit('note_deleted', { threadId: req.params.threadId, noteId: parseInt(req.params.noteId) });
        res.json({ ok: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Canned Replies ────────────────────────────────────────────────────────────
app.get('/api/canned-replies', requireAuth, async (req, res) => {
    try { res.json({ replies: await db.getCannedReplies(req.session.userId) }); }
    catch (err) { res.status(500).json({ error: err.message, replies: [] }); }
});
app.post('/api/canned-replies', requireAuth, verifyCsrf, async (req, res) => {
    const { title, body } = req.body;
    if (!title?.trim() || !body?.trim()) return res.status(400).json({ error: 'Title and body required' });
    try { res.json({ reply: await db.saveCannedReply(req.session.userId, title.trim(), body.trim()) }); }
    catch (err) { res.status(500).json({ error: err.message }); }
});
app.delete('/api/canned-replies/:id', requireAuth, verifyCsrf, async (req, res) => {
    try { await db.deleteCannedReply(req.session.userId, req.params.id); res.json({ success: true }); }
    catch (err) { res.status(500).json({ error: err.message }); }
});

// ── File Attachment ───────────────────────────────────────────────────────────
app.post('/api/threads/:threadId/attach', requireAuth, verifyCsrf, upload.single('file'), async (req, res) => {
    const { threadId } = req.params;
    const { pageId, recipientId } = req.body;
    const file = req.file;
    if (!pageId      || !/^\d+$/.test(pageId))      return res.status(400).json({ error: 'Invalid pageId' });
    if (!recipientId || !/^\d+$/.test(recipientId)) return res.status(400).json({ error: 'Invalid recipientId' });
    if (!file)                                       return res.status(400).json({ error: 'No file' });

    let token = req.session.pageTokens?.[pageId] || (dbConnected ? await db.getPageToken(pageId) : null);
    if (!token) return res.status(401).json({ error: 'Page token not found' });

    try {
        const mime       = file.mimetype;
        const attachType = mime.startsWith('image/') ? 'image' : mime.startsWith('video/') ? 'video' : 'file';
        const form       = new FormData();
        form.append('recipient', JSON.stringify({ id: recipientId }));
        form.append('message',   JSON.stringify({ attachment: { type: attachType, payload: { is_reusable: false } } }));
        form.append('filedata',  new Blob([file.buffer], { type: mime }), file.originalname || 'upload');
        const fbRes = await fetch(`https://graph.facebook.com/v19.0/me/messages?access_token=${token}`, { method: 'POST', body: form });
        const data  = await fbRes.json();
        if (data.error) throw new Error(data.error.message);
        const createdTime = new Date().toISOString();
        if (dbConnected) {
            await db.saveMessage({ id: data.message_id, threadId, pageId, senderId: pageId, senderType: 'page', text: '', isFromPage: true, createdTime, attachments: [{ t: attachType, u: '' }] });
        }
        io.to(`page_${pageId}`).emit('new_message',        { id: data.message_id, threadId, text: '', isFromPage: true, createdTime, attachments: [{ t: attachType, u: '' }] });
        io.to(`page_${pageId}`).emit('conversation_updated', { id: threadId, pageId, snippet: `[${attachType}]`, updatedTime: new Date(), isRead: true, unreadCount: 0, lastMessageFromPage: true });
        res.json({ success: true, messageId: data.message_id });
    } catch (err) {
        logError('attach_route', err, { pageId, threadId });
        res.status(500).json({ error: err.message });
    }
});

// ── FB Proxy ──────────────────────────────────────────────────────────────────
app.post('/api/fb-proxy', verifyCsrf, async (req, res) => {
    const { method = 'GET', path: fbPath, token, params = {}, body = {}, url: fullUrl } = req.body;
    
    let url;
    if (fullUrl) {
        if (!fullUrl.startsWith('https://graph.facebook.com')) {
            return res.status(400).json({ error: 'Invalid URL host' });
        }
        url = fullUrl;
    } else if (fbPath) {
        if (!token) return res.status(400).json({ error: 'token is required' });
        const cleanPath = fbPath.replace(/^\/+/, '');
        const queryParams = new URLSearchParams(params);
        queryParams.set('access_token', token);
        url = `https://graph.facebook.com/v19.0/${cleanPath}?${queryParams.toString()}`;
    } else {
        return res.status(400).json({ error: 'path or url is required' });
    }

    try {
        const fetchOptions = {
            method: method === 'UPLOAD_IMAGE' ? 'POST' : method,
            headers: {}
        };

        if (method === 'POST') {
            fetchOptions.headers['Content-Type'] = 'application/x-www-form-urlencoded';
            const formBody = new URLSearchParams();
            for (const [k, v] of Object.entries(body)) {
                formBody.append(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
            }
            fetchOptions.body = formBody.toString();
        }

        const fbRes = await fetch(url, fetchOptions);
        const data = await fbRes.json();
        res.status(fbRes.status).json(data);
    } catch (err) {
        logError('fb_proxy', err);
        res.status(502).json({ error: 'Proxy connection error' });
    }
});

// ── Upload Image ─────────────────────────────────────────────────────────────
const diskStorage = multer.diskStorage({
    destination: (req, file, cb) => {
        const dir = path.join(__dirname, '../uploads');
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        cb(null, dir);
    },
    filename: (req, file, cb) => {
        const ext = path.extname(file.originalname) || '.jpg';
        cb(null, crypto.randomBytes(16).toString('hex') + ext);
    }
});
const uploadDisk = multer({ 
    storage: diskStorage, 
    limits: { fileSize: 5 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        if (file.mimetype.startsWith('image/')) cb(null, true);
        else cb(new Error('Only images allowed'));
    }
});

app.post('/api/upload-image', verifyCsrf, uploadDisk.single('image'), (req, res) => {
    if (!req.file) return res.status(400).json({ success: false, error: 'No file uploaded' });
    
    const proto = req.headers['x-forwarded-proto'] || 'https';
    const host = req.headers['x-forwarded-host'] || req.headers.host || '';
    const siteUrl = process.env.SITE_URL || BASE_URL || (host ? `${proto}://${host}` : '');
    const url = `${siteUrl.replace(/\/$/, '')}/uploads/${req.file.filename}`;
    
    res.json({ success: true, url, filename: req.file.filename });
});

app.use('/uploads', express.static(path.join(__dirname, '../uploads')));

// ── Sync History Stub ────────────────────────────────────────────────────────
app.post('/api/sync-history', requireAuth, async (req, res) => {
    const { page_id, page_token } = req.body;
    if (!page_id || !page_token) return res.status(400).json({ error: 'page_id and page_token required' });
    
    // Non-blocking sync start
    db.syncPageInitial(page_id, page_token, fetch, prog => io.emit('sync_progress', prog))
        .catch(err => logError('manual_sync', err, { pageId: page_id }));
        
    res.json({ success: true, message: 'Sync started' });
});

// ── Quota ───────────────────────────────────────────────────────────────────
app.post(['/api/update_quota', '/api/update_quota.php'], requireAuth, verifyCsrf, async (req, res) => {
    const { fb_user_id, count } = req.body;
    if (!fb_user_id) return res.status(400).json({ error: 'fb_user_id required' });
    
    try {
        const result = await db.updateUserQuota(fb_user_id, count);
        if (result) res.json(result);
        else res.status(404).json({ error: 'User not found' });
    } catch (err) {
        logError('update_quota', err);
        res.status(500).json({ error: 'Failed to update quota' });
    }
});

// ── Sync ──────────────────────────────────────────────────────────────────────
app.post('/api/sync/all', requireAuth, verifyCsrf, async (req, res) => {
    if (!dbConnected) return res.status(503).json({ error: 'Database not connected' });
    try {
        const fbRes = await fetch(`https://graph.facebook.com/v19.0/me/accounts?fields=id,name,picture,access_token&access_token=${req.session.accessToken}`);
        const data  = await fbRes.json();
        if (data.error) throw new Error(data.error.message);
        res.json({ success: true, message: `Sync started for ${(data.data || []).length} pages` });
        for (const page of (data.data || [])) {
            db.syncAllPageData(page.id, page.access_token, fetch).catch(err => logError('sync_all_bg', err, { pageId: page.id }));
        }
    } catch (err) {
        logError('sync_all', err);
        if (!res.headersSent) res.status(500).json({ error: err.message });
    }
});

// ── Health & Debug ────────────────────────────────────────────────────────────
app.get('/api/health', async (req, res) => {
    const stats = dbConnected ? await db.getStats().catch(() => null) : null;
    res.json({ status: 'ok', db: dbConnected ? 'connected' : 'disconnected', conversations: stats?.totalConversations ?? null, messages: stats?.totalMessages ?? null, sockets: connectedSockets.size, uptime: Math.floor(process.uptime()), memory: Math.round(process.memoryUsage().heapUsed / 1024 / 1024) + 'MB' });
});

app.get('/api/debug/errors', requireAuth, (req, res) => {
    res.json({ errorLogs, webhookLogs, requestLogs: requestLogs.slice(0, 20), dbErrors: db.getDbErrorLogs(), dbConnected, sockets: connectedSockets.size });
});

// ── /api/config — public config for frontend ──────────────────────────────────
app.get('/api/config', (req, res) => {
    res.json({
        fbAppId:            process.env.FB_APP_ID            || '',
        stripePublishableKey: process.env.STRIPE_PUBLISHABLE_KEY || '',
        contactEmail:       process.env.CONTACT_EMAIL        || '',
        siteUrl:            process.env.SITE_URL             || BASE_URL || '',
        appEnv:             process.env.APP_ENV              || 'production'
    });
});

// ── Main HTML — serve index.php as template ───────────────────────────────────
function renderIndexHtml(req) {
    const root  = path.join(__dirname, '..');
    let html    = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
    const proto = req.headers['x-forwarded-proto'] || 'https';
    const host  = req.headers['x-forwarded-host'] || req.headers.host || '';
    const siteUrl = process.env.SITE_URL || BASE_URL || (host ? `${proto}://${host}` : '');
    const ver   = Date.now();

    const config = {
        stripePublishableKey: (process.env.STRIPE_PUBLISHABLE_KEY || '').replace(/'/g, "\\'"),
        fbAppId: (process.env.FB_APP_ID || '').replace(/'/g, "\\'"),
        fbRedirectUri: (process.env.FB_REDIRECT_URI || `${siteUrl}/api/auth/callback`).replace(/'/g, "\\'"),
        contactEmail: (process.env.CONTACT_EMAIL || '').replace(/'/g, "\\'"),
        siteUrl: siteUrl.replace(/'/g, "\\'"),
        csrfToken: req.session.csrfToken || '',
        appEnv: (process.env.APP_ENV || 'production').replace(/'/g, "\\'")
    };

    // Inject config
    html = html.replace(
        /window\.APP_CONFIG=\{[\s\S]*?\};/,
        `window.APP_CONFIG=${JSON.stringify(config)};`
    );
    html = html.replace(/window\.FB_CONFIG=\{[\s\S]*?\};/, `window.FB_CONFIG={appId:window.APP_CONFIG.fbAppId,csrfToken:window.APP_CONFIG.csrfToken};`);

    // Replace placeholders
    html = html.replace(/{{SITE_URL}}/g, siteUrl);
    html = html.replace(/{{SITE_URL_NO_SLASH}}/g, siteUrl.replace(/\/$/, ''));
    html = html.replace(/{{CONTACT_EMAIL}}/g, process.env.CONTACT_EMAIL || '');
    html = html.replace(/{{YEAR}}/g, new Date().getFullYear());
    html = html.replace(/{{VER}}/g, ver);

    return html;
}

app.get('/', (req, res) => {
    try {
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.setHeader('Cache-Control', 'no-store');
        res.send(renderIndexHtml(req));
    } catch (err) {
        logError('render_index', err);
        res.status(500).send('<h1>Server Error</h1><p>Could not load application.</p>');
    }
});

// ── Global Error Handler ──────────────────────────────────────────────────────
app.use((err, req, res, next) => {
    logError('express', err, { url: req.url, method: req.method });
    if (!res.headersSent) res.status(500).json({ error: 'Internal server error' });
});

// ── Startup ───────────────────────────────────────────────────────────────────
(async () => {
    try {
        await db.initDatabase();
        dbConnected = db.isConnected();
        if (dbConnected) {
            const stats = await db.getStats();
            console.log(`✅ MySQL connected — ${stats.totalConversations} conversations, ${stats.totalMessages} messages`);
        } else {
            console.warn('⚠️  Running without DB:', db.getLastError());
        }
    } catch (err) {
        console.error('DB init failed:', err.message);
    }

    httpServer.listen(PORT, () => {
        console.log(`🚀 FBCast Pro on port ${PORT}`);
        console.log(`   Webhook: POST /webhook  (verify: ${WEBHOOK_VERIFY_TOKEN})`);
    });

    // Background incremental sync every 5 min
    setInterval(async () => {
        if (!dbConnected) return;
        try {
            const pages = await db.getPages();
            if (!pages.length) return;
            await Promise.all(pages.map(p =>
                db.syncPageIncremental(p.id, p.access_token, fetch, prog => io.emit('sync_progress', prog))
                    .catch(err => logError('bg_sync', err, { pageId: p.id }))
            ));
            io.emit('sync_progress', { phase: 'done' });
        } catch (err) { logError('bg_sync_tick', err); }
    }, 5 * 60 * 1000);
})();
