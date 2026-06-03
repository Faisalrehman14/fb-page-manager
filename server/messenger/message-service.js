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

    _loadResult(mapped, convId, safeLimit) {
        const hasMore = mapped.length >= safeLimit;
        const oldest = mapped.length ? mapped[0].created_at : null;
        return {
            success: true,
            data: {
                messages: mapped,
                nextCursor: hasMore && oldest ? oldest : null,
                backfillPending: false,
                hasMore
            },
            messages: mapped,
            conv_id: convId,
            hasMore
        };
    }

    async loadMedia({ pageId, psid, limit, session, dbConnected }) {
        if (!dbConnected) {
            return { success: true, data: { media: [] } };
        }
        const convInfo = await this.db.getConversationIdByParticipant(pageId, psid);
        if (!convInfo?.id) {
            return { success: true, data: { media: [] } };
        }
        const media = await this.db.getConversationMedia(convInfo.id, limit);
        return { success: true, data: { media } };
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
                return this._loadResult([], dbConvId, safeLimit);
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
                    return this._loadResult(cached.map(mapMessage), dbConvId, safeLimit);
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
                    return this._loadResult(rows.map(mapMessage), dbConvId, safeLimit);
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

            const mapped = messages.map(mapMessage);
            return this._loadResult(mapped, dbConvId || fbConvId, safeLimit);
        } catch (err) {
            this.logError('load_messages_fb', err, { pageId, psid });
            if (dbConvId) {
                const fallback = await this.db.getMessages(dbConvId, safeLimit, before);
                if (fallback.length > 0) {
                    return this._loadResult(fallback.map(mapMessage), dbConvId, safeLimit);
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
