/** inbox-legacy routes */
module.exports = function mountInboxLegacy(app, ctx) {
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

// ── Conversations ─────────────────────────────────────────────────────────────
app.get('/api/pages/:pageId/conversations', requireAuth, async (req, res) => {
    const { pageId } = req.params;
    let token = req.session.pageTokens?.[pageId] || (state.dbConnected ? await db.getPageToken(pageId) : null);
    if (!token) return res.status(401).json({ error: 'Page token not found. Reload pages.', tokenMissing: true });

    const limit    = Math.min(parseInt(req.query.limit)  || 100, 200);
    const offset   = Math.max(parseInt(req.query.offset) || 0, 0);
    const archived = req.query.archived === 'true';

    try {
        if (state.dbConnected) {
            const [convs, total] = await Promise.all([
                db.getConversations(pageId, limit, offset, archived),
                offset === 0 ? db.getConversationCount(pageId, archived) : Promise.resolve(null)
            ]);
            if (convs.length > 0 || offset > 0) {
                res.json({ conversations: convs, hasMore: convs.length === limit, offset, total, fromCache: true });
                if (offset === 0 && !archived) {
                    const now = Date.now(), last = state.syncCooldown.get(pageId) || 0;
                    if (now - last > 60000) {
                        state.syncCooldown.set(pageId, now);
                        db.syncConversationsFromFacebook(pageId, token, fetch, db.messageRetentionCutoffUnix()).catch(err => logError('bg_sync', err, { pageId }));
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
    const pageId = req.params.pageId;
    if (!q || !state.dbConnected) return res.json({ conversations: [], hint: null });
    try {
        let pageToken = req.session.pageTokens?.[pageId] || null;
        if (!pageToken) pageToken = await db.getPageToken(pageId);

        const searchService = new SearchService({ db });
        const result = await searchService.search({
            pageId,
            q,
            dbConnected: state.dbConnected,
            pageToken,
            fetchFn: fetch
        });

        let conversations = await db.hydrateSearchConversationsForInbox(pageId, result.conversations || []);
        if (!conversations.length) {
            conversations = await db.searchConversations(pageId, q, 50);
        }

        res.set('Cache-Control', 'private, max-age=5');
        res.json({
            conversations,
            messages: result.messages || [],
            hint: result.hint || null,
            searched_facebook: !!result.searched_facebook
        });
    } catch (err) {
        logError('conversations_search_route', err, { pageId });
        try {
            const fallback = await db.searchConversations(pageId, q, 50);
            return res.json({ conversations: fallback, hint: null });
        } catch (_) {
            res.status(500).json({ error: err.message, conversations: [] });
        }
    }
});

app.post('/api/pages/:pageId/mark-all-read', requireAuth, verifyCsrf, async (req, res) => {
    if (!state.dbConnected) return res.status(503).json({ error: 'DB not connected' });
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
    let token = req.session.pageTokens?.[pageId] || (state.dbConnected ? await db.getPageToken(pageId) : null);
    if (!token) return res.status(401).json({ error: 'Page token not found', tokenMissing: true });

    try {
        const fmt = m => ({ id: m.id, text: m.text, attachments: m.attachments || [], isFromPage: m.isFromPage, senderId: m.senderId, createdTime: m.createdTime });
        if (state.dbConnected) {
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

    let token = req.session.pageTokens?.[pageId] || (state.dbConnected ? await db.getPageToken(pageId) : null);
    if (!token) return res.status(401).json({ error: 'Page token not found', tokenMissing: true });

    try {
        const { SendService } = require('../../messenger/send-service');
        const sendService = new SendService({ db, io, fetchFn: fetch });
        const result = await sendService.send({
            pageId,
            psid: recipientId,
            message: message.trim(),
            page_token: token
        });
        res.json({ success: true, messageId: result.message_id });
    } catch (err) {
        logError('reply_route', err, { pageId, threadId });
        res.status(500).json({ error: err.message || 'Send failed' });
    }
});

// ── Read / Unread ─────────────────────────────────────────────────────────────
app.post('/api/threads/:threadId/read', requireAuth, verifyCsrf, async (req, res) => {
    const pageId = req.body?.pageId || req.query?.pageId;
    const threadId = req.params.threadId;
    if (state.dbConnected) {
        await db.markAsRead(threadId).catch(() => {});
        if (pageId) {
            try {
                const row = await db.getConversationById(threadId);
                const psid = row?.fb_user_id;
                const token = await db.getPageToken(pageId);
                if (psid && token) {
                    const { FacebookClient } = require('../../messenger/facebook-client');
                    await new FacebookClient(fetch).markSeenWithRetry(token, psid, pageId);
                }
            } catch (err) {
                logError('thread_mark_read_meta', err, { pageId, threadId });
            }
        }
    }
    if (pageId) io.to(`page_${pageId}`).emit('conversation_updated', { id: threadId, pageId, isRead: true, unreadCount: 0, isLive: true });
    res.json({ success: true });
});

app.post('/api/threads/:threadId/unread', requireAuth, verifyCsrf, async (req, res) => {
    const pageId = req.body?.pageId;
    if (state.dbConnected) await db.markAsUnread(req.params.threadId).catch(() => {});
    if (pageId) io.to(`page_${pageId}`).emit('conversation_updated', { id: req.params.threadId, pageId, isRead: false, unreadCount: 1, isLive: true });
    res.json({ success: true });
});

// ── Archive ───────────────────────────────────────────────────────────────────
app.post('/api/threads/:threadId/archive', requireAuth, verifyCsrf, async (req, res) => {
    if (!state.dbConnected) return res.status(503).json({ error: 'DB not connected' });
    try {
        await db.archiveConversation(req.params.threadId, req.body.pageId);
        io.to(`page_${req.body.pageId}`).emit('conversation_archived', { convId: req.params.threadId, pageId: req.body.pageId });
        res.json({ ok: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/threads/:threadId/unarchive', requireAuth, verifyCsrf, async (req, res) => {
    if (!state.dbConnected) return res.status(503).json({ error: 'DB not connected' });
    try {
        await db.unarchiveConversation(req.params.threadId, req.body.pageId);
        io.to(`page_${req.body.pageId}`).emit('conversation_unarchived', { convId: req.params.threadId, pageId: req.body.pageId });
        res.json({ ok: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Notes ─────────────────────────────────────────────────────────────────────
app.get('/api/threads/:threadId/notes', requireAuth, async (req, res) => {
    if (!state.dbConnected) return res.json({ notes: [] });
    try { res.json({ notes: await db.getNotes(req.params.threadId) }); }
    catch (err) { res.status(500).json({ error: err.message, notes: [] }); }
});

app.post('/api/threads/:threadId/notes', requireAuth, verifyCsrf, async (req, res) => {
    if (!state.dbConnected) return res.status(503).json({ error: 'DB not connected' });
    const { body, pageId } = req.body;
    if (!body?.trim()) return res.status(400).json({ error: 'Note body required' });
    try {
        const note = await db.saveNote(req.params.threadId, pageId, req.session.userName || 'Agent', body.trim());
        io.to(`thread_${req.params.threadId}`).emit('note_added', { threadId: req.params.threadId, note });
        res.json({ note });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/threads/:threadId/notes/:noteId', requireAuth, verifyCsrf, async (req, res) => {
    if (!state.dbConnected) return res.status(503).json({ error: 'DB not connected' });
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
app.put('/api/canned-replies/:id', requireAuth, verifyCsrf, async (req, res) => {
    const { title, body } = req.body;
    if (!title?.trim() || !body?.trim()) return res.status(400).json({ error: 'Title and body required' });
    try {
        const reply = await db.updateCannedReply(req.session.userId, req.params.id, title.trim(), body.trim());
        if (!reply) return res.status(404).json({ error: 'Reply not found' });
        res.json({ reply });
    } catch (err) { res.status(500).json({ error: err.message }); }
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

    let token = req.session.pageTokens?.[pageId] || (state.dbConnected ? await db.getPageToken(pageId) : null);
    if (!token) return res.status(401).json({ error: 'Page token not found' });

    try {
        const { FacebookClient } = require('../../messenger/facebook-client');
        const mime = file.mimetype || 'application/octet-stream';
        const attachType = mime.startsWith('image/') ? 'image' : mime.startsWith('video/') ? 'video' : 'file';
        const fbClient = new FacebookClient(fetch);
        const data = await fbClient.sendAttachmentWithRetry(
            token, recipientId, pageId, file.buffer, mime, file.originalname || 'upload'
        );
        const createdTime = new Date().toISOString();
        if (state.dbConnected) {
            await db.saveMessage({ id: data.message_id, threadId, pageId, senderId: pageId, senderType: 'page', text: '', isFromPage: true, createdTime, attachments: [{ t: attachType, u: '' }] });
        }
        io.to(`page_${pageId}`).emit('new_message',        { id: data.message_id, threadId, text: '', isFromPage: true, createdTime, attachments: [{ t: attachType, u: '' }] });
        io.to(`page_${pageId}`).emit('conversation_updated', { id: threadId, pageId, snippet: `[${attachType}]`, updatedTime: new Date(), isRead: true, unreadCount: 0, lastMessageFromPage: true });
        res.json({ success: true, messageId: data.message_id });
    } catch (err) {
        logError('attach_route', err, { pageId, threadId });
        const { FacebookClient } = require('../../messenger/facebook-client');
        const fbErr = err.fbCode != null ? { code: err.fbCode, message: err.message } : null;
        const msg = fbErr ? FacebookClient.formatSendError(fbErr) : err.message;
        res.status(500).json({ error: msg });
    }
});

// ── Messenger Image Upload ────────────────────────────────────────────────────
app.post('/api/messenger/upload', requireAuth, upload.single('file'), async (req, res) => {
    const { FacebookClient } = require('../../messenger/facebook-client');
    const { page_id: pageId, psid, page_token: bodyToken } = req.body;
    const file = req.file;
    if (!pageId      || !/^\d+$/.test(pageId)) return res.status(400).json({ error: 'Invalid page_id' });
    if (!psid        || !/^\d+$/.test(psid))   return res.status(400).json({ error: 'Invalid psid' });
    if (!file)                                  return res.status(400).json({ error: 'No file uploaded' });

    const token = req.session.pageTokens?.[pageId] || (state.dbConnected ? await db.getPageToken(pageId) : null) || bodyToken;
    if (!token) return res.status(401).json({ error: 'Page token not found' });

    try {
        const mime = file.mimetype || 'image/png';
        const fbClient = new FacebookClient(fetch);
        const data = await fbClient.sendAttachmentWithRetry(
            token, psid, pageId, file.buffer, mime, file.originalname || 'image.png'
        );
        const attachType = mime.startsWith('image/') ? 'image' : mime.startsWith('video/') ? 'video' : 'file';

        if (state.dbConnected && data.message_id) {
            const convInfo = await db.getConversationIdByParticipant(pageId, psid);
            if (convInfo?.id) {
                await db.saveMessage({ id: data.message_id, conversationId: convInfo.id, pageId, senderId: pageId, senderType: 'page', text: '', isFromPage: true, createdTime: new Date().toISOString(), attachments: [{ t: attachType, u: '' }] });
            }
        }
        io.to(`page_${pageId}`).emit('new_message', { id: data.message_id, psid, text: '', isFromPage: true, createdTime: new Date().toISOString(), attachments: [{ t: attachType, u: '' }] });
        res.json({ success: true, message_id: data.message_id });
    } catch (err) {
        logError('messenger_upload', err, { pageId, psid });
        const fbErr = err.fbCode != null ? { code: err.fbCode, message: err.message } : null;
        const msg = fbErr ? FacebookClient.formatSendError(fbErr) : err.message;
        res.status(500).json({ error: msg });
    }
});

// ── FB Proxy ──────────────────────────────────────────────────────────────────
app.post('/api/fb-proxy', requireAuth, verifyCsrf, async (req, res) => {
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
        url = `${FB_GRAPH_BASE}/${cleanPath}?${queryParams.toString()}`;
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
app.post('/api/upload-image', verifyCsrf, uploadDisk.single('image'), (req, res) => {
    if (!req.file) return res.status(400).json({ success: false, error: 'No file uploaded' });
    
    const proto = req.headers['x-forwarded-proto'] || 'https';
    const host = req.headers['x-forwarded-host'] || req.headers.host || '';
    const siteUrl = process.env.SITE_URL || BASE_URL || (host ? `${proto}://${host}` : '');
    const url = `${siteUrl.replace(/\/$/, '')}/uploads/${req.file.filename}`;
    
    res.json({ success: true, url, filename: req.file.filename });
});


  mountMessenger({ ...ctx.deps, app });
};
