const express = require('express');
const router = express.Router();
const { requireAuth, verifyCsrf } = require('../middleware/security');
const { logError } = require('../utils');
const db = require('../db');
const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));

router.all(['/messenger', '/messenger.php'], requireAuth, verifyCsrf, async (req, res) => {
    const action = req.query.action || req.body.action;
    const pageId = req.query.page_id || req.body.page_id;
    const io = req.app.get('io');

    try {
        if (req.method === 'GET') {
            if (action === 'conversations') {
                const limit = parseInt(req.query.limit) || 20;
                const offset = parseInt(req.query.offset) || 0;
                const convs = await db.getConversations(pageId, limit, offset);
                return res.json(convs);
            }
            if (action === 'messages') {
                const threadId = req.query.thread_id;
                const limit = parseInt(req.query.limit) || 50;
                const msgs = await db.getMessages(threadId, limit);
                return res.json(msgs);
            }
        }

        if (req.method === 'POST') {
            if (action === 'send') {
                const { psid, message, image_url, page_token } = req.body;
                if (!pageId || !psid || (!message && !image_url)) return res.status(400).json({ error: 'Missing fields' });

                const token = page_token || await db.getPageToken(pageId);
                if (!token) return res.status(400).json({ error: 'Page token not found' });

                const fbUrl = `https://graph.facebook.com/v19.0/me/messages?access_token=${token}`;
                const payload = {
                    recipient: { id: psid },
                    message: image_url ? { attachment: { type: 'image', payload: { url: image_url } } } : { text: message }
                };

                const fbRes = await fetch(fbUrl, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                });
                const fbData = await fbRes.json();

                if (fbData.error) throw new Error(fbData.error.message);

                const mid = fbData.message_id;
                const convId = await db.getConversationIdByParticipant(pageId, psid) || `${pageId}_${psid}`;
                
                await db.saveMessage({
                    mid, thread_id: convId, page_id: pageId,
                    sender_id: pageId, sender_type: 'page',
                    text: message || '[Image]', is_from_page: 1,
                    created_time: new Date()
                }, io);

                return res.json({ success: true, message_id: mid });
            }

            if (action === 'mark_read') {
                const { psid } = req.body;
                if (!pageId || !psid) return res.status(400).json({ error: 'Missing fields' });
                await db.markAsRead(`${pageId}_${psid}`);
                return res.json({ success: true });
            }
        }

        res.status(405).json({ error: 'Method or action not allowed' });
    } catch (err) {
        logError('messenger_api', err);
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
