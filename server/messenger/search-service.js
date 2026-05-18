const {
    SEARCH_MIN_CHARS,
    SEARCH_CACHE_MS
} = require('./config');

const searchCache = new Map();

function cacheKey(pageId, q) {
    return `${pageId}:${q.toLowerCase()}`;
}

class SearchService {
    constructor({ db }) {
        this.db = db;
    }

    async search({ pageId, q, dbConnected }) {
        const term = String(q || '').trim();
        if (!dbConnected) {
            return { conversations: [], messages: [], hint: 'Database not ready' };
        }
        if (term.length < SEARCH_MIN_CHARS) {
            return {
                conversations: [],
                messages: [],
                hint: `Type at least ${SEARCH_MIN_CHARS} characters`
            };
        }

        const key = cacheKey(pageId, term);
        const hit = searchCache.get(key);
        if (hit && Date.now() - hit.ts < SEARCH_CACHE_MS) {
            return { ...hit.data, cached: true };
        }

        const data = await this.db.searchInbox(pageId, term);
        const result = {
            conversations: data.conversations.map(c => ({
                id: c.id,
                fb_user_id: c.participantId,
                user_name: c.participantName,
                user_picture: c.participantPicture || '',
                snippet: c.snippet,
                last_msg: c.snippet,
                last_msg_at: c.updatedTime,
                updated_at: c.updatedTime,
                is_unread: c.unreadCount || 0,
                page_id: c.pageId
            })),
            messages: data.messages.map(m => ({
                message_id: m.message_id,
                message: m.message,
                from_me: m.from_me,
                created_at: m.created_at,
                psid: m.senderId,
                user_name: m.user_name,
                user_picture: m.user_picture,
                conversation_id: m.conversation_id
            })),
            query: term
        };

        searchCache.set(key, { data: result, ts: Date.now() });
        if (searchCache.size > 80) {
            const oldest = searchCache.keys().next().value;
            searchCache.delete(oldest);
        }

        return result;
    }
}

module.exports = { SearchService };
