/**
 * Facebook Page Inbox - PRO CLASS UNIFIED BACKEND
 * Backend Server (Node.js/Express/Socket.io)
 * 
 * This server handles everything in real-time:
 * - Facebook Webhooks (Messages, Echoes, Delivery, Read)
 * - MySQL Database persistence
 * - Socket.io live broadcasting
 * - Graph API proxying for replies
 * - OAuth & Session management
 */

require('dotenv').config({ path: '../.env' });
const express = require('express');
const session = require('express-session');
const crypto = require('crypto');
const path = require('path');
const helmet = require('helmet');
const mysql = require('mysql2/promise');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const PORT = process.env.PORT || 3000;

// =============================================================================
// DATABASE CONNECTION
// =============================================================================

const pool = mysql.createPool({
    host: process.env.MYSQLHOST || process.env.DB_HOST || 'localhost',
    user: process.env.MYSQLUSER || process.env.DB_USER,
    password: process.env.MYSQLPASSWORD || process.env.DB_PASS,
    database: process.env.MYSQLDATABASE || process.env.DB_NAME,
    port: process.env.MYSQLPORT || process.env.DB_PORT || 3306,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

// =============================================================================
// MIDDLEWARE & SOCKETS
// =============================================================================

app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const io = new Server(server, {
    cors: { origin: "*", methods: ["GET", "POST"] }
});

app.use(session({
    secret: process.env.SESSION_SECRET || 'fb-inbox-pro-secret',
    resave: false,
    saveUninitialized: false,
    name: 'fb_inbox_session',
    cookie: {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        maxAge: 24 * 60 * 60 * 1000
    }
}));

// Socket connection logic
io.on('connection', (socket) => {
    socket.on('join_page', (pageId) => socket.join(`page_${pageId}`));
    socket.on('join_conversation', (psid) => socket.join(`conv_${psid}`));
    
    // Typing indicators
    socket.on('typing', (data) => {
        // data = { pageId, psid, isTyping }
        socket.to(`page_${data.pageId}`).emit('user_typing', data);
    });
});

// =============================================================================
// FACEBOOK WEBHOOK (Unified)
// =============================================================================

// Webhook Verification
app.get('/api/webhook/facebook', (req, res) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    if (mode && token) {
        if (mode === 'subscribe' && token === (process.env.FB_VERIFY_TOKEN || 'my_verify_token')) {
            console.log('WEBHOOK_VERIFIED');
            res.status(200).send(challenge);
        } else {
            res.sendStatus(403);
        }
    }
});

// Webhook Event Processing
app.post('/api/webhook/facebook', async (req, res) => {
    const body = req.body;

    if (body.object === 'page') {
        for (const entry of body.entry) {
            const pageId = entry.id;
            for (const event of entry.messaging) {
                await handleMessagingEvent(pageId, event);
            }
        }
        res.status(200).send('EVENT_RECEIVED');
    } else {
        res.sendStatus(404);
    }
});

async function handleMessagingEvent(pageId, event) {
    const psid = event.sender.id;
    const timestamp = new Date(event.timestamp).toISOString().slice(0, 19).replace('T', ' ');

    // 1. Handle New Message
    if (event.message && !event.message.is_echo) {
        const msg = event.message;
        const text = msg.text || '';
        const mid = msg.mid;
        
        let attachmentUrl = null;
        let attachmentType = null;
        if (msg.attachments && msg.attachments[0]) {
            attachmentType = msg.attachments[0].type;
            attachmentUrl = msg.attachments[0].payload.url;
        }

        try {
            // Save to DB
            const [rows] = await pool.execute(
                'INSERT INTO messages (message_id, page_id, user_id, message, from_me, attachment_url, attachment_type, created_at) VALUES (?, ?, ?, ?, 0, ?, ?, ?)',
                [mid, pageId, psid, text, attachmentUrl, attachmentType, timestamp]
            );

            // Update conversation unread count and last message
            await pool.execute(
                'UPDATE conversations SET last_message = ?, last_message_at = ?, unread_count = unread_count + 1 WHERE psid = ? AND page_id = ?',
                [text || `[${attachmentType}]`, timestamp, psid, pageId]
            );

            // Broadcast to Socket
            const socketData = {
                id: mid,
                message: text,
                from_me: 0,
                attachment_url: attachmentUrl,
                attachment_type: attachmentType,
                created_at: timestamp,
                user_id: psid
            };
            io.to(`page_${pageId}`).emit('webhook_event', { type: 'new_message', page_id: pageId, psid, data: socketData });
            io.to(`conv_${psid}`).emit('new_message', socketData);

        } catch (err) {
            console.error('DB Error in Webhook:', err);
        }
    }
}

// =============================================================================
// MESSENGER API (Unified)
// =============================================================================

// Get Conversations
app.get('/api/messenger/conversations', async (req, res) => {
    const { pageId } = req.query;
    if (!pageId) return res.status(400).json({ error: 'pageId required' });

    try {
        const [rows] = await pool.execute(
            'SELECT * FROM conversations WHERE page_id = ? ORDER BY last_message_at DESC',
            [pageId]
        );
        res.json({ success: true, conversations: rows });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Get Messages
app.get('/api/messenger/messages', async (req, res) => {
    const { psid, pageId, limit = 50 } = req.query;
    if (!psid) return res.status(400).json({ error: 'psid required' });

    try {
        const [rows] = await pool.execute(
            'SELECT * FROM messages WHERE user_id = ? AND page_id = ? ORDER BY created_at DESC LIMIT ?',
            [psid, pageId, parseInt(limit)]
        );
        res.json({ success: true, messages: rows.reverse() });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Mark as Read
app.post('/api/messenger/mark-read', async (req, res) => {
    const { psid, pageId } = req.body;
    try {
        await pool.execute(
            'UPDATE conversations SET unread_count = 0 WHERE psid = ? AND page_id = ?',
            [psid, pageId]
        );
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Send Reply
app.post('/api/messenger/reply', async (req, res) => {
    const { pageId, psid, message, page_token } = req.body;
    
    try {
        // 1. Send to Facebook
        const fbRes = await fetch(`https://graph.facebook.com/v21.0/${pageId}/messages?access_token=${page_token}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                recipient: { id: psid },
                message: { text: message },
                messaging_type: 'RESPONSE'
            })
        });
        const fbData = await fbRes.json();
        
        if (fbData.error) throw new Error(fbData.error.message);

        const mid = fbData.message_id;
        const timestamp = new Date().toISOString().slice(0, 19).replace('T', ' ');

        // 2. Save to DB
        await pool.execute(
            'INSERT INTO messages (message_id, page_id, user_id, message, from_me, created_at) VALUES (?, ?, ?, ?, 1, ?)',
            [mid, pageId, psid, message, timestamp]
        );

        // 3. Update conversation
        await pool.execute(
            'UPDATE conversations SET last_message = ?, last_message_at = ? WHERE psid = ? AND page_id = ?',
            [message, timestamp, psid, pageId]
        );

        res.json({ success: true, messageId: mid });
    } catch (err) {
        console.error('Reply Error:', err);
        res.status(500).json({ error: err.message });
    }
});

// Serve Frontend
app.use(express.static(path.join(__dirname, '../')));
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, '../index.php')); // PHP will still handle some views
});

// Start Server
server.listen(PORT, () => {
    console.log(`
╔════════════════════════════════════════════════════════════════╗
║  FBCast Pro - UNIFIED REAL-TIME BACKEND                      ║
║  Server running at http://localhost:${PORT}                      ║
╠════════════════════════════════════════════════════════════════╣
║  WEBHOOK: /api/webhook/facebook                              ║
║  MESSENGER API: /api/messenger/*                             ║
║  REAL-TIME: Socket.io 4.x                                    ║
╚════════════════════════════════════════════════════════════════╝
    `);
});
