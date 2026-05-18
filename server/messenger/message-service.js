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

    async load({ pageId, psid, limit, before, session, dbConnected }) {
        const safeLimit = Math.min(parseInt(limit, 10) || 50, MESSAGE_PAGE_SIZE_MAX);
        const cutoff = retentionCutoff();

        let dbConvId = null;
        let fbConvId = null;

        if (dbConnected) {
            const convInfo = await this.db.getConversationIdByParticipant(pageId, psid);
            if (convInfo) {
                dbConvId = convInfo.id;
                fbConvId = convInfo.fbConvId || null;
                const cached = await this.db.getMessages(dbConvId, safeLimit, before);
                if (cached.length > 0) {
                    return {
                        messages: cached.map(mapMessage),
                        conv_id: dbConvId
                    };
                }
            }
        }

        if (before) {
            const beforeDate = new Date(before);
            if (!isNaN(beforeDate) && beforeDate <= cutoff) {
                return { messages: [], conv_id: dbConvId };
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
                }
            }

            return { messages, conv_id: dbConvId || fbConvId };
        } catch (err) {
            this.logError('load_messages_fb', err, { pageId, psid });
            return {
                messages: [],
                error: 'Network error fetching messages: ' + err.message
            };
        }
    }
}

module.exports = { MessageService };
