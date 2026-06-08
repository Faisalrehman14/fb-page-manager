const {
    SEARCH_MIN_CHARS,
    SEARCH_CACHE_MS
} = require('./config');

const searchCache = new Map();

function cacheKey(pageId, q) {
    return `${pageId}:${q.toLowerCase()}`;
}

function mapConversation(c) {
    return {
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
    };
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
                hint: `Type at least ${SEARCH_MIN_CHARS} character to search`
            };
        }

        const key = cacheKey(pageId, term);
        const hit = searchCache.get(key);
        if (hit && Date.now() - hit.ts < SEARCH_CACHE_MS) {
            return { ...hit.data, cached: true };
        }

        // DB-only search — fast and covers every synced conversation in the inbox.
        // Facebook Graph pagination (12×100 requests) was the main source of latency
        // and still missed threads beyond the scan window.
        const dbData = await this.db.searchInbox(pageId, term);
        const merged = dbData.conversations || [];

        const result = {
            conversations: merged.map(mapConversation),
            messages: (dbData.messages || []).map(m => ({
                message_id: m.message_id,
                message: m.message,
                from_me: m.from_me,
                created_at: m.created_at,
                psid: m.senderId,
                user_name: m.user_name,
                user_picture: m.user_picture,
                conversation_id: m.conversation_id
            })),
            query: term,
            searched_facebook: false
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
