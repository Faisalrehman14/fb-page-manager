const { MESSAGE_PAGE_SIZE_MAX, retentionCutoff } = require('./config');
const { mapMessage } = require('./mappers');
const { resolvePageToken } = require('./token-resolver');
const { FacebookClient } = require('./facebook-client');

class MessageService {
    constructor({ db, logError, fetchFn }) {
        this.db = db;
        this.logError = logError;
        this.fb = new FacebookClient(fetchFn);
    }

    async load({ pageId, psid, limit, before, refresh, session, dbConnected }) {
        const safeLimit = Math.min(parseInt(limit, 10) || 50, MESSAGE_PAGE_SIZE_MAX);
        const cutoff = retentionCutoff();
        const forceRefresh = refresh === true || refresh === '1' || refresh === 'true';

        let dbConvId = null;
        let fbConvId = null;

        if (dbConnected) {
            const convInfo = await this.db.getConversationIdByParticipant(pageId, psid);
            if (convInfo) {
                dbConvId = convInfo.id;
                fbConvId = convInfo.fbConvId || null;
            }
        }

        if (before) {
            const beforeDate = new Date(before);
            if (!isNaN(beforeDate) && beforeDate <= cutoff) {
                return {
                    success: true,
                    data: { messages: [], nextCursor: null, backfillPending: false },
                    messages: [],
                    conv_id: dbConvId
                };
            }
        }

        const token = await resolvePageToken({
            pageId,
            session,
            db: this.db,
            dbConnected,
            fetchFn: this.fb.fetch
        });
        if (!token) {
            if (dbConvId) {
                const cached = await this.db.getMessages(dbConvId, safeLimit, before);
                if (cached.length > 0) {
                    const mapped = cached.map(mapMessage);
                    return {
                        success: true,
                        data: { messages: mapped, nextCursor: null, backfillPending: false },
                        messages: mapped,
                        conv_id: dbConvId
                    };
                }
            }
            return { messages: [], error: 'No page token found. Please reload the pages list.' };
        }

        try {
            if (!fbConvId) {
                const convLookupData = await this.fb.getJson(
                    this.fb.lookupConversationByUser(pageId, psid, token)
                );
                fbConvId = convLookupData.data?.[0]?.id;
                if (!fbConvId) {
                    return {
                        messages: [],
                        error: 'No conversation found. This user may not have messaged this page yet.'
                    };
                }
            }

            // Always pull latest from Facebook when opening chat (not "load earlier").
            // Fixes missing customer messages sent/replied via Meta Business Suite.
            if (!before && fbConvId) {
                await this.db.syncThreadMessages(fbConvId, pageId, token, this.fb.fetch, null);
                if (!dbConvId) dbConvId = await this.db.ensureConversation(pageId, psid);
                if (dbConvId && this.db.touchConversationFromLatestMessage) {
                    await this.db.touchConversationFromLatestMessage(dbConvId);
                }
            } else if (forceRefresh && fbConvId) {
                await this.db.syncThreadMessages(fbConvId, pageId, token, this.fb.fetch, null);
                if (dbConvId && this.db.touchConversationFromLatestMessage) {
                    await this.db.touchConversationFromLatestMessage(dbConvId);
                }
            }

            if (dbConvId) {
                const rows = await this.db.getMessages(dbConvId, safeLimit, before);
                if (rows.length > 0) {
                    const mapped = rows.map(mapMessage);
                    return {
                        success: true,
                        data: { messages: mapped, nextCursor: null, backfillPending: false },
                        messages: mapped,
                        conv_id: dbConvId
                    };
                }
            }

            const messages = await this.fb.fetchMessages(fbConvId, pageId, token, {
                limit: safeLimit,
                before
            });

            if (dbConnected && messages.length > 0) {
                if (!dbConvId) dbConvId = await this.db.ensureConversation(pageId, psid);
                if (dbConvId) {
                    const dbMsgs = messages.map(m => ({
                        id: m.message_id,
                        threadId: dbConvId,
                        pageId,
                        senderId: m.from_me ? pageId : psid,
                        text: m.message,
                        isFromPage: !!m.from_me,
                        createdTime: m.created_at,
                        attachments: m.attachment_url
                            ? [{ u: m.attachment_url, t: m.attachment_type }]
                            : null
                    }));
                    await this.db.saveMessages(dbMsgs).catch(() => {});
                    if (this.db.touchConversationFromLatestMessage) {
                        await this.db.touchConversationFromLatestMessage(dbConvId);
                    }
                }
            }

            return {
                success: true,
                data: {
                    messages: messages.map(mapMessage),
                    nextCursor: null,
                    backfillPending: false
                },
                messages: messages.map(mapMessage),
                conv_id: dbConvId || fbConvId
            };
        } catch (err) {
            this.logError('load_messages_fb', err, { pageId, psid });
            if (dbConvId) {
                const fallback = await this.db.getMessages(dbConvId, safeLimit, before);
                if (fallback.length > 0) {
                    const mapped = fallback.map(mapMessage);
                    return {
                        success: true,
                        data: { messages: mapped, nextCursor: null, backfillPending: false },
                        messages: mapped,
                        conv_id: dbConvId
                    };
                }
            }
            return {
                messages: [],
                error: 'Network error fetching messages: ' + err.message
            };
        }
    }
}

module.exports = { MessageService };
