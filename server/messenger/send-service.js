const { FacebookClient, FbApiError } = require('./facebook-client');
class SendService {
    constructor({ db, io, fetchFn }) {
        this.db = db;
        this.io = io;
        this.fb = new FacebookClient(fetchFn);
    }

    async _recipientDisplayName(pageId, psid, hintName) {
        const fromClient = String(hintName || '').trim();
        if (fromClient && fromClient !== 'User') return fromClient;
        try {
            const conv = await this.db.getConversationIdByParticipant(pageId, psid);
            const name = (conv?.user_name || '').trim();
            if (name && name !== 'User') return name;
        } catch (_) { /* optional */ }
        return 'Friend';
    }

    _personalizeBroadcastText(text, recipientName) {
        if (!text || !/\{\{name\}\}/i.test(text)) return text;
        return String(text).replace(/\{\{name\}\}/gi, recipientName || 'Friend');
    }

    async send({ pageId, psid, message, image_url, page_token, recipient_name }) {
        const token = page_token || await this.db.getPageToken(pageId);
        if (!token) throw new Error('Page token not found');

        const recipientName = await this._recipientDisplayName(pageId, psid, recipient_name);
        const textOut = this._personalizeBroadcastText(message, recipientName);

        // Support sending image and text together — two sequential sends
        const parts = [];
        if (image_url) {
            parts.push({
                msgObj: { attachment: { type: 'image', payload: { url: image_url, is_reusable: true } } },
                label: '[Image]',
                attachmentUrl: image_url,
                attachmentType: 'image'
            });
        }
        if (textOut) {
            parts.push({ msgObj: { text: textOut }, label: textOut });
        }
        if (!parts.length) throw new Error('No message content');

        let lastMid;
        for (const part of parts) {
            const fbData = await this.fb.send(token, psid, part.msgObj, false, pageId);
            if (!fbData?.message_id) {
                throw new FbApiError({ message: 'Facebook did not confirm delivery', code: 0 });
            }
            lastMid = fbData.message_id;
        }

        const mid = lastMid;
        const createdTime = new Date().toISOString();
        const displayText = textOut || '[Image]';
        let convId = null;
        try {
            const convInfo = await this.db.getConversationIdByParticipant(pageId, psid);
            convId = convInfo?.id || await this.db.ensureConversation(pageId, psid);
            if (convId) {
                await this.db.saveMessage({
                    id: mid,
                    threadId: convId,
                    pageId,
                    senderId: pageId,
                    text: displayText,
                    isFromPage: true,
                    createdTime,
                    attachments: image_url ? [{ u: image_url, t: 'image' }] : null
                });
                await this.db.updateConversationFromMessage({
                    threadId: convId,
                    text: displayText,
                    createdTime,
                    lastFromMe: true
                }).catch(() => {});
            }
        } catch (dbErr) {
            console.warn('[SendService] DB save after send failed (message was delivered):', dbErr.message || dbErr);
        }

        setImmediate(() => {
            this.io.to(`page_${pageId}`).emit('new_message', {
                id: mid,
                threadId: convId,
                pageId,
                participantId: psid,
                text: displayText,
                attachment_url: image_url || null,
                attachment_type: image_url ? 'image' : null,
                isFromPage: true,
                createdTime
            });
            this.io.to(`page_${pageId}`).emit('conversation_updated', {
                id: convId,
                pageId,
                participantId: psid,
                snippet: displayText,
                updatedTime: new Date(),
                isRead: true,
                unreadCount: 0,
                lastMessageFromPage: true
            });
        });

        const pageIdBg = pageId;
        const psidBg = psid;
        const convIdBg = convId;
        const tokenBg = token;
        setImmediate(() => {
            if (convIdBg) this.db.markAsRead(convIdBg).catch(() => {});
            if (tokenBg && psidBg) {
                this.fb.markSeen(tokenBg, psidBg, pageIdBg).catch(() => {});
            }
        });

        return {
            success: true,
            message_id: mid,
            meta_read: { ok: true }
        };
    }

    async sendLike({ pageId, psid, page_token }) {
        const token = page_token || await this.db.getPageToken(pageId);
        if (!token) throw new Error('Page token not found');

        const fbData = await this.fb.sendThumbsUpWithRetry(token, psid, pageId);
        const mid = fbData.message_id;
        const createdTime = new Date().toISOString();
        const displayText = '👍';
        const convInfo = await this.db.getConversationIdByParticipant(pageId, psid);
        const convId = convInfo?.id || await this.db.ensureConversation(pageId, psid);

        if (convId) {
            await this.db.saveMessage({
                id: mid,
                threadId: convId,
                pageId,
                senderId: pageId,
                text: displayText,
                isFromPage: true,
                createdTime,
                attachments: [{ t: 'like', u: null }]
            });
            await this.db.updateConversationFromMessage({
                threadId: convId,
                text: displayText,
                createdTime,
                lastFromMe: true,
                attachment_type: 'like'
            }).catch(() => {});
        }

        setImmediate(() => {
            this.io.to(`page_${pageId}`).emit('new_message', {
                id: mid,
                threadId: convId,
                pageId,
                participantId: psid,
                text: displayText,
                attachment_type: 'like',
                isFromPage: true,
                createdTime
            });
            this.io.to(`page_${pageId}`).emit('conversation_updated', {
                id: convId,
                pageId,
                participantId: psid,
                snippet: displayText,
                updatedTime: new Date(),
                isRead: true,
                unreadCount: 0,
                lastMessageFromPage: true
            });
            if (convId) this.db.markAsRead(convId).catch(() => {});
            if (token && psid) this.fb.markSeen(token, psid, pageId).catch(() => {});
        });

        return { success: true, message_id: mid, meta_read: { ok: true } };
    }

    async markRead({ pageId, psid, page_token }) {
        const token = page_token || await this.db.getPageToken(pageId);
        let metaMarked = false;

        if (token && psid) {
            try {
                await this.fb.markSeen(token, psid, pageId);
                metaMarked = true;
            } catch (err) {
                console.warn('[markRead] Meta mark_seen failed:', err.message || err);
            }
        }

        const convInfo = await this.db.getConversationIdByParticipant(pageId, psid);
        if (convInfo?.id) await this.db.markAsRead(convInfo.id);
        return { success: true, meta_marked: metaMarked, threadId: convInfo?.id || null };
    }
}

module.exports = { SendService };
