const {
    SYNC_COOLDOWN_MS,
    MESSAGE_RETENTION_DAYS,
    RELOGIN_SYNC_GAP_MS,
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
