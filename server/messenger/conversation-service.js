const {
    CONVERSATION_PAGE_SIZE_MAX,
    CONVERSATION_INITIAL_LIMIT,
    CONV_LIST_CACHE_MS,
    MESSAGE_RETENTION_DAYS
} = require('./config');
const { mapConversation } = require('./mappers');
const { resolvePageToken } = require('./token-resolver');

const MAX_CACHE_ENTRIES = 500;
const listCache = new Map();
const pageKeySets = new Map();

function cacheKey(pageId, limit, offset) {
    return `${pageId}:${limit}:${offset}`;
}

function _evictKey(key) {
    const pageId = key.split(':')[0];
    listCache.delete(key);
    pageKeySets.get(pageId)?.delete(key);
    if (pageKeySets.get(pageId)?.size === 0) pageKeySets.delete(pageId);
}

function getCached(pageId, limit, offset) {
    const key = cacheKey(pageId, limit, offset);
    const hit = listCache.get(key);
    if (!hit || Date.now() - hit.ts > CONV_LIST_CACHE_MS) {
        if (hit) _evictKey(key);
        return null;
    }
    listCache.delete(key);
    listCache.set(key, hit);
    return hit.data;
}

function setCache(pageId, limit, offset, data) {
    const key = cacheKey(pageId, limit, offset);
    if (listCache.size >= MAX_CACHE_ENTRIES && !listCache.has(key)) {
        _evictKey(listCache.keys().next().value);
    }
    listCache.set(key, { data, ts: Date.now() });
    if (!pageKeySets.has(pageId)) pageKeySets.set(pageId, new Set());
    pageKeySets.get(pageId).add(key);
}

function clearPageCache(pageId) {
    const keys = pageKeySets.get(pageId);
    if (!keys) return;
    for (const key of keys) listCache.delete(key);
    pageKeySets.delete(pageId);
}

function buildListResult(convs, safeLimit, safeOffset, extra = {}) {
    return {
        conversations: convs.map(mapConversation),
        has_more: convs.length >= safeLimit,
        offset: safeOffset,
        limit: safeLimit,
        message_retention_days: MESSAGE_RETENTION_DAYS,
        filters: { can_reply: true, messages_within_days: MESSAGE_RETENTION_DAYS },
        ...extra
    };
}

class ConversationService {
    constructor({ db, syncService, logError, io }) {
        this.db = db;
        this.sync = syncService;
        this.logError = logError;
        this.io = io;
    }

    async list({ pageId, limit, offset, session, dbConnected, fetchFn, refresh }) {
        const safeLimit = Math.min(
            parseInt(limit, 10) || CONVERSATION_INITIAL_LIMIT,
            CONVERSATION_PAGE_SIZE_MAX
        );
        const safeOffset = Math.max(parseInt(offset, 10) || 0, 0);
        const forceRefresh = refresh === true || refresh === '1' || refresh === 'true';

        if (forceRefresh) clearPageCache(pageId);

        if (dbConnected && safeOffset === 0 && !forceRefresh && !this.db.isPageSyncing?.(pageId)) {
            const cached = getCached(pageId, safeLimit, safeOffset);
            if (cached?.conversations?.length) {
                resolvePageToken({ pageId, session, db: this.db, dbConnected, fetchFn })
                    .then(token => {
                        if (token) this.sync.ensurePageSynced(pageId, token, this.io);
                    })
                    .catch(() => {});
                return cached;
            }
        }

        if (!dbConnected && safeOffset === 0) {
            return buildListResult([], safeLimit, safeOffset, {
                syncing: false,
                error: 'Database not connected. Check DATABASE_URL on the server.'
            });
        }

        let convs = dbConnected
            ? await this.db.getConversations(pageId, safeLimit, safeOffset)
            : [];

        const token = await resolvePageToken({
            pageId, session, db: this.db, dbConnected, fetchFn
        });

        if (!token && safeOffset === 0) {
            return buildListResult([], safeLimit, safeOffset, {
                syncing: false,
                error: 'Page token not found. Reload pages from the sidebar.'
            });
        }

        // First connect / empty DB: pull conversation list from Facebook now (fast)
        if (safeOffset === 0 && token && dbConnected && !convs.length) {
            try {
                await this.sync.coldStartSync(pageId, token, safeLimit);
                convs = await this.db.getConversations(pageId, safeLimit, safeOffset);
                clearPageCache(pageId);
            } catch (err) {
                this.logError('messenger_cold_sync', err, { pageId });
            }
        }

        if (safeOffset === 0 && token) {
            this.sync.ensurePageSynced(pageId, token, this.io);
        }

        const syncing = safeOffset === 0 &&
            !convs.length &&
            !!this.db.isPageSyncing?.(pageId);

        const result = buildListResult(convs, safeLimit, safeOffset, {
            from_cache: convs.length > 0,
            syncing
        });

        if (dbConnected && safeOffset === 0) setCache(pageId, safeLimit, safeOffset, result);
        return result;
    }
}

module.exports = { ConversationService, clearPageCache };
