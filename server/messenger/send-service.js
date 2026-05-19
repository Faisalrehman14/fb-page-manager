const { FacebookClient, FbApiError } = require('./facebook-client');

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
    async _fbSendWithRetry(token, psid, msgObj, useUtility = false, pageId = null, sendOptions = {}) {
        let lastErr;
        for (let i = 0; i <= RETRY_DELAYS.length; i++) {
            if (i > 0) await sleep(RETRY_DELAYS[i - 1]);
            try {
                return await this.fb.send(token, psid, msgObj, useUtility, pageId, sendOptions);
            } catch (err) {
                if (FacebookClient.isTransient(err)) { lastErr = err; continue; }
                throw err;
            }
        }
        throw lastErr;
    }

    /** Clear unread in our DB and on Meta Business Suite (pass to Page Inbox + mark_seen). */
    async _markThreadReadOnMetaAndDb(pageId, psid, convId, pageToken) {
        if (convId) {
            await this.db.markAsRead(convId).catch(() => {});
        }
        const token = pageToken || await this.db.getPageToken(pageId);
        if (!token || !psid) return { ok: false, reason: 'no_token_or_psid' };
        try {
            const result = await this.fb.markSeenWithRetry(token, psid, pageId);
            if (result?.fbUnread > 0) {
                console.warn(
                    `[SendService] Meta Business Suite still unread (${result.fbUnread}) psid=${psid}` +
                    (result.handoverOk ? ` handover=${result.handoverMethod}` : ` pass failed: ${result.handoverError || 'unknown'}`)
                );
            } else if (convId && result?.fbUnread === 0) {
                await this.db.markAsRead(convId).catch(() => {});
            }
            return {
                ok: result?.fbUnread === 0 || result?.fbUnread === null,
                handoverOk: result?.handoverOk,
                handoverMethod: result?.handoverMethod,
                fbUnread: result?.fbUnread,
                handoverError: result?.handoverError || null
            };
        } catch (err) {
            const detail = err.fbCode != null
                ? `code=${err.fbCode} ${err.message}`
                : (err.message || String(err));
            console.warn(`[SendService] Meta mark read failed page=${pageId} psid=${psid}: ${detail}`);
            return { ok: false, error: detail };
        }
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
        let sentWithInboxPass = false;
        for (let i = 0; i < parts.length; i++) {
            const part = parts[i];
            const isLast = i === parts.length - 1;
            const sendOpts = isLast ? { passToPageInbox: true } : {};
            let fbData;
            try {
                fbData = await this._fbSendWithRetry(token, psid, part.msgObj, false, pageId, sendOpts);
            } catch (err) {
                if (err instanceof FbApiError && FacebookClient.isOutside24hWindow(err)) {
                    fbData = await this._fbSendWithRetry(token, psid, part.msgObj, true, pageId, sendOpts);
                } else {
                    throw err;
                }
            }
            if (!fbData?.message_id) {
                throw new FbApiError({ message: 'Facebook did not confirm delivery', code: 0 });
            }
            lastMid = fbData.message_id;
            if (isLast && sendOpts.passToPageInbox) sentWithInboxPass = true;
        }

        const mid = lastMid;
        const createdTime = new Date().toISOString();
        const displayText = message || '[Image]';
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

        const metaRead = await this._markThreadReadOnMetaAndDb(pageId, psid, convId, token);

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

        return {
            success: true,
            message_id: mid,
            meta_read: metaRead,
            sent_with_inbox_pass: sentWithInboxPass
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

        const metaRead = await this._markThreadReadOnMetaAndDb(pageId, psid, convId, token);

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

        return { success: true, message_id: mid, meta_read: metaRead };
    }

    async markRead({ pageId, psid, page_token }) {
        const token = page_token || await this.db.getPageToken(pageId);
        let metaMarked = false;

        if (token && psid) {
            try {
                await this.fb.markSeenWithRetry(token, psid, pageId);
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
