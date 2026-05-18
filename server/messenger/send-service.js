const { FacebookClient } = require('./facebook-client');

const RETRY_DELAYS = [300, 1200]; // 2 retries: 300ms then 1.2s

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

class SendService {
    constructor({ db, io, fetchFn }) {
        this.db = db;
        this.io = io;
        this.fb = new FacebookClient(fetchFn);
    }

    // Retries on transient network failures only; throws on FB API errors.
    async _fbSendWithRetry(token, psid, msgObj, useUtility = false) {
        let lastErr;
        for (let i = 0; i <= RETRY_DELAYS.length; i++) {
            if (i > 0) await sleep(RETRY_DELAYS[i - 1]);
            try {
                return await this.fb.send(token, psid, msgObj, useUtility);
            } catch (err) {
                if (FacebookClient.isTransient(err)) { lastErr = err; continue; }
                throw err;
            }
        }
        throw lastErr;
    }

    async send({ pageId, psid, message, image_url, page_token }) {
        const token = page_token || await this.db.getPageToken(pageId);
        if (!token) throw new Error('Page token not found');

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
        if (message) {
            parts.push({ msgObj: { text: message }, label: message });
        }
        if (!parts.length) throw new Error('No message content');

        let lastMid;
        for (const part of parts) {
            let fbData = await this._fbSendWithRetry(token, psid, part.msgObj, false);

            // Outside 24h window: retry as UTILITY message type
            if (fbData.error && FacebookClient.isOutside24hWindow(fbData.error)) {
                fbData = await this._fbSendWithRetry(token, psid, part.msgObj, true);
            }

            if (fbData.error) throw new Error(fbData.error.message);
            lastMid = fbData.message_id;
        }

        const mid = lastMid;
        const createdTime = new Date().toISOString();
        const displayText = message || '[Image]';
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
                attachments: image_url ? [{ u: image_url, t: 'image' }] : null
            });
            await this.db.updateConversationFromMessage({
                threadId: convId,
                text: displayText,
                createdTime,
                lastFromMe: true
            }).catch(() => {});
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

        return { success: true, message_id: mid };
    }

    async sendLike({ pageId, psid, page_token }) {
        const token = page_token || await this.db.getPageToken(pageId);
        if (!token) throw new Error('Page token not found');

        const fbData = await this.fb.sendThumbsUpWithRetry(token, psid);
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
        });

        return { success: true, message_id: mid };
    }

    async markRead({ pageId, psid, page_token }) {
        const token = page_token || await this.db.getPageToken(pageId);
        let metaMarked = false;

        if (token && psid) {
            try {
                await this.fb.markSeenWithRetry(token, psid);
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
