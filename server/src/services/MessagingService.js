const pool = require('../config/db');

class MessagingService {
    /**
     * Persists a message and updates the conversation summary (Denormalization)
     */
    async saveMessage(data, io) {
        const { mid, pageId, psid, message, fromMe, attachmentUrl, attachmentType } = data;
        const timestamp = new Date().toISOString().slice(0, 19).replace('T', ' ');

        try {
            // 1. Insert message with optimized transaction-like speed
            await pool.execute(
                'INSERT INTO messages (message_id, page_id, user_id, message, from_me, attachment_url, attachment_type, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
                [mid, pageId, psid, message, fromMe, attachmentUrl, attachmentType, timestamp]
            );

            // 2. Update/Create Conversation summary for fast Inbox loading
            const [convs] = await pool.execute('SELECT id FROM conversations WHERE psid = ? AND page_id = ?', [psid, pageId]);
            
            if (convs.length > 0) {
                await pool.execute(
                    'UPDATE conversations SET last_message = ?, last_message_at = ?, unread_count = unread_count + ? WHERE psid = ? AND page_id = ?',
                    [message || `[${attachmentType}]`, timestamp, fromMe ? 0 : 1, psid, pageId]
                );
            } else {
                await pool.execute(
                    'INSERT INTO conversations (psid, page_id, last_message, last_message_at, unread_count) VALUES (?, ?, ?, ?, ?)',
                    [psid, pageId, message || `[${attachmentType}]`, timestamp, fromMe ? 0 : 1]
                );
            }

            // 3. Trigger Real-Time Events via Socket.io
            if (io) {
                const payload = { 
                    id: mid, 
                    message, 
                    from_me: fromMe, 
                    attachment_url: attachmentUrl, 
                    attachment_type: attachmentType, 
                    created_at: timestamp, 
                    user_id: psid 
                };
                io.to(`page_${pageId}`).emit('webhook_event', { type: 'new_message', page_id: pageId, psid, data: payload });
                io.to(`conv_${psid}`).emit('new_message', payload);
            }

            return { success: true, mid };
        } catch (err) {
            console.error('[MessagingService] Error:', err);
            throw err;
        }
    }

    async getConversations(pageId) {
        const [rows] = await pool.execute(
            'SELECT * FROM conversations WHERE page_id = ? ORDER BY last_message_at DESC',
            [pageId]
        );
        return rows;
    }

    async getMessages(psid, pageId, limit = 50) {
        const [rows] = await pool.execute(
            'SELECT * FROM messages WHERE user_id = ? AND page_id = ? ORDER BY created_at DESC LIMIT ?',
            [psid, pageId, parseInt(limit)]
        );
        return rows.reverse();
    }
}

module.exports = new MessagingService();
