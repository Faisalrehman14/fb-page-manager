const express = require('express');
const router = express.Router();
const MessagingService = require('../services/MessagingService');
const FacebookService = require('../services/FacebookService');

router.get('/conversations', async (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    const pageId = req.query.pageId || req.query.page_id;
    if (!pageId) return res.status(400).json({ error: 'pageId required' });

    try {
        const convs = await MessagingService.getConversations(pageId);
        res.json({ success: true, conversations: convs });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.get('/messages', async (req, res) => {
    const { psid, pageId, limit } = req.query;
    try {
        const msgs = await MessagingService.getMessages(psid, pageId, limit);
        res.json({ success: true, messages: msgs });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.post('/reply', async (req, res) => {
    const { pageId, psid, message, page_token } = req.body;
    const io = req.app.get('io');

    try {
        const fbData = await FacebookService.sendMessage(pageId, psid, message, page_token);
        await MessagingService.saveMessage({
            mid: fbData.message_id,
            pageId,
            psid,
            message,
            fromMe: 1
        }, io);
        res.json({ success: true, messageId: fbData.message_id });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.get('/poll', (req, res) => {
    res.json({ success: true, messages: [] });
});

module.exports = router;
