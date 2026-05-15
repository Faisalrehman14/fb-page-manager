const express = require('express');
const router = express.Router();
const FacebookService = require('../services/FacebookService');
const MessagingService = require('../services/MessagingService');

// Verification Endpoint
router.get('/facebook', (req, res) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    if (mode === 'subscribe' && token === process.env.FB_VERIFY_TOKEN) {
        res.status(200).send(challenge);
    } else {
        res.sendStatus(403);
    }
});

// Incoming Events
router.post('/facebook', async (req, res) => {
    res.status(200).send('EVENT_RECEIVED'); // FB requires fast 200 OK

    // Secure verification
    if (!FacebookService.verifySignature(req)) {
        return console.warn('[Webhook] Warning: Invalid signature!');
    }

    const { body, app } = req;
    const io = app.get('io'); // Get socket.io instance from app

    if (body.object === 'page') {
        for (const entry of body.entry) {
            const event = entry.messaging[0];
            const psid = event.sender.id;
            const pageId = event.recipient.id;

            if (event.message) {
                await MessagingService.saveMessage({
                    mid: event.message.mid,
                    pageId,
                    psid,
                    message: event.message.text,
                    fromMe: 0,
                    attachmentUrl: event.message.attachments?.[0]?.payload?.url,
                    attachmentType: event.message.attachments?.[0]?.type
                }, io);
            }
        }
    }
});

module.exports = router;
