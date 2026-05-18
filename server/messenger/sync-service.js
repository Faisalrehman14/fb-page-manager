const {
    SYNC_COOLDOWN_MS,
    MESSAGE_RETENTION_DAYS,
    RELOGIN_SYNC_GAP_MS,
    ACTIVE_THREAD_SYNC_MS,
    ACTIVE_PAGE_SYNC_MS,
    HOT_CONV_SYNC_LIMIT,
    CONVERSATION_LIST_SYNC_MS,
    CONVERSATION_LIST_SYNC_ACTIVE_MS,
    CONVERSATION_LIST_SINCE_SEC,
    retentionCutoffUnix
} = require('./config');
const { clearPageCache } = require('./conversation-service');

/**
 * Background sync — reads always hit DB first; Facebook sync never blocks the UI.
 */
class SyncService {
    constructor({ db, fetchFn, syncCooldown, logError }) {
        this.db = db;
        this.fetchFn = fetchFn;
        this.syncCooldown = syncCooldown;
        this.logError = logError;
        this._ensureKick = new Map(); // pageId → last kick timestamp
        this._activeThreadSync = new Map(); // pageId:psid → last Graph pull
        this._activePageSync = new Map(); // pageId → last hot-conv pull
        this._listSync = new Map(); // pageId → last conversation list pull from FB
    }

    shouldRunBackgroundSync(pageId) {
        const now = Date.now();
        const last = this.syncCooldown.get(pageId) || 0;
        if (now - last < SYNC_COOLDOWN_MS) return false;
        this.syncCooldown.set(pageId, now);
        return true;
    }

    _pageNeedsFullSync(lastSyncedAt) {
        if (!lastSyncedAt) return true;
        const t = lastSyncedAt instanceof Date ? lastSyncedAt : new Date(lastSyncedAt);
        if (isNaN(t.getTime())) return true;
        return Date.now() - t.getTime() > RELOGIN_SYNC_GAP_MS;
    }

    /**
     * Pull conversation snippets + updated_time from Facebook (Meta Business Suite activity).
     * This is what updates the left-hand list when webhooks do not fire.
     */
    async syncConversationListFromFacebook(pageId, pageToken, minIntervalMs = CONVERSATION_LIST_SYNC_MS) {
        if (!pageId || !pageToken) return false;
        const now = Date.now();
        const last = this._listSync.get(pageId) || 0;
        if (now - last < minIntervalMs) return false;
        this._listSync.set(pageId, now);

        const sinceUnix = Math.floor((now - CONVERSATION_LIST_SINCE_SEC * 1000) / 1000);
        try {
            await this.db.syncConversationsFromFacebook(pageId, pageToken, this.fetchFn, sinceUnix, {
                maxPages: 3,
                maxTotal: 60,
                fbLimit: 50
            });
            clearPageCache(pageId);
            return true;
        } catch (err) {
            this.logError('sync_conversation_list', err, { pageId });
            return false;
        }
    }

    /**
     * Fire-and-forget full/incremental page sync (conversations + messages).
     * Called on login, page load, and messenger list — never awaited by read APIs.
     */
    ensurePageSynced(pageId, token, io, opts = {}) {
        if (!pageId || !token) return;
        if (this.db.isPageSyncing?.(pageId)) return;

        const now = Date.now();
        const lastKick = this._ensureKick.get(pageId) || 0;
        if (!opts.force && now - lastKick < 90_000) return;
        this._ensureKick.set(pageId, now);

        setImmediate(() => {
            (async () => {
                const lastSynced = await this.db.getPageSyncTime(pageId).catch(() => null);
                const needsFull = opts.force || this._pageNeedsFullSync(lastSynced);

                if (!needsFull) {
                    this.scheduleConversationSync(pageId, token);
                    this.syncOnPoll(pageId, token, { psid: null }).catch(() => {});
                    return;
                }

                if (this.db.isPageSyncing?.(pageId)) return;

                const onProgress = prog => {
                    io?.to?.(`page_${pageId}`)?.emit('sync_progress', { ...prog, pageId });
                };

                await this.db.syncPageSmart(pageId, token, this.fetchFn, onProgress);
                io?.to?.(`page_${pageId}`)?.emit('sync_progress', { phase: 'done', pageId });
                clearPageCache(pageId);
            })().catch(err => this.logError('ensure_page_sync', err, { pageId }));
        });
    }

    /**
     * Fast first paint: fetch conversation list from Facebook into DB (no message bodies).
     * Does not set syncStatus — safe to run while full sync is in progress.
     */
    async coldStartSync(pageId, token, limit = 30) {
        const cap = Math.min(parseInt(limit, 10) || 30, 100);
        try {
            const synced = await this.db.syncConversationsFromFacebook(
                pageId, token, this.fetchFn, null,
                { maxPages: 5, maxTotal: cap, fbLimit: 50 }
            );
            clearPageCache(pageId);
            return synced;
        } catch (err) {
            this.logError('cold_start_sync', err, { pageId });
            return [];
        }
    }

    ensureAllPagesSynced(pages, io, opts = {}) {
        for (const p of pages || []) {
            const id = p.id || p.fb_page_id;
            const token = p.accessToken || p.access_token;
            if (id && token) this.ensurePageSynced(id, token, io, opts);
        }
    }

    scheduleConversationSync(pageId, token) {
        if (this.db.isPageSyncing?.(pageId)) return;
        if (!token || !this.shouldRunBackgroundSync(pageId)) return;
        this.db.syncConversationsFromFacebook(pageId, token, this.fetchFn, retentionCutoffUnix(), {
            maxPages: Infinity,
            maxTotal: 10000,
            fbLimit: 200
        })
            .then(() => clearPageCache(pageId))
            .catch(err => this.logError('messenger_bg_sync', err, { pageId }));
    }

    /**
     * Pull latest messages from Facebook while the inbox is open.
     * Catches replies sent from Meta Business Suite (often missing webhooks).
     */
    async syncOnPoll(pageId, pageToken, { psid = null } = {}) {
        if (!pageId || !pageToken) return;
        if (this.db.isPageSyncing?.(pageId)) return;

        const now = Date.now();

        if (psid) {
            await this.syncActiveThreadOnPoll(pageId, pageToken, psid);
            return;
        }

        // Inbox view (no open thread): refresh list metadata from Facebook
        await this.syncConversationListFromFacebook(pageId, pageToken);

        const lastPage = this._activePageSync.get(pageId) || 0;
        if (now - lastPage < ACTIVE_PAGE_SYNC_MS) return;
        this._activePageSync.set(pageId, now);

        try {
            const hot = await this.db.getHotConversationsForSync(pageId, HOT_CONV_SYNC_LIMIT);
            const withFb = hot.filter((c) => c.fb_conv_id);
            if (!withFb.length) return;

            const tasks = withFb.map((c) => async () => {
                const saved = await this.db.syncThreadMessages(c.fb_conv_id, pageId, pageToken, this.fetchFn, null);
                if (saved > 0 && c.id && this.db.touchConversationFromLatestMessage) {
                    await this.db.touchConversationFromLatestMessage(c.id);
                }
            });
            await this.db.parallelLimit(tasks, 4);
            clearPageCache(pageId);
        } catch (err) {
            this.logError('sync_on_poll_page', err, { pageId });
        }
    }

    /** Open thread only — does not pull the full conversation list (keeps sidebar stable). */
    async syncActiveThreadOnPoll(pageId, pageToken, psid) {
        if (!pageId || !pageToken || !psid) return;
        if (this.db.isPageSyncing?.(pageId)) return;

        const key = `${pageId}:${psid}`;
        const now = Date.now();
        const last = this._activeThreadSync.get(key) || 0;
        if (now - last < ACTIVE_THREAD_SYNC_MS) return;
        this._activeThreadSync.set(key, now);

        try {
            let conv = await this.db.getConversationIdByParticipant(pageId, psid);
            if (!conv?.fbConvId) {
                await this.db.syncConversationsFromFacebook(pageId, pageToken, this.fetchFn, null, {
                    maxPages: 2,
                    maxTotal: 40,
                    fbLimit: 40
                });
                conv = await this.db.getConversationIdByParticipant(pageId, psid);
            }
            if (conv?.fbConvId) {
                const saved = await this.db.syncThreadMessages(conv.fbConvId, pageId, pageToken, this.fetchFn, null);
                if (saved > 0 && conv.id && this.db.touchConversationFromLatestMessage) {
                    await this.db.touchConversationFromLatestMessage(conv.id);
                }
                if (saved > 0) clearPageCache(pageId);
            }
            await this.syncConversationListFromFacebook(
                pageId, pageToken, CONVERSATION_LIST_SYNC_ACTIVE_MS
            );
        } catch (err) {
            this.logError('sync_on_poll_thread', err, { pageId, psid });
        }
    }

    async runManualSync(pageId, pageToken, onProgress) {
        return this.db.syncPageSmart(pageId, pageToken, this.fetchFn, onProgress);
    }

    purgePage(pageId) {
        return this.db.scheduleDeferredCleanup(pageId, MESSAGE_RETENTION_DAYS);
    }

    purgeAll() {
        return this.db.scheduleDeferredCleanup(null, MESSAGE_RETENTION_DAYS);
    }
}

module.exports = { SyncService };
