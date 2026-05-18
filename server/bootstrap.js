const env = require('./config/env');
const state = require('./lib/state');
const { logError } = require('./lib/logger');
const db = require('./db');

function startServer(httpServer, { startBroadcastScheduler, io }) {
    httpServer.listen(env.PORT, () => {
        console.log(`🚀 FBCast Pro on port ${env.PORT}`);
        console.log('   Healthcheck: GET /api/health');
        console.log('   Static root: public/');
    });

    console.log('DB: Initializing in background...');
    db.initDatabase().then(() => {
        state.dbConnected = db.isConnected();
        if (state.dbConnected) {
            db.getStats().then(stats => {
                console.log(`✅ MySQL connected — ${stats.totalConversations} conversations, ${stats.totalMessages} messages`);
            });
            db.migrateSchedules().catch(() => {});
            db.scheduleDeferredCleanup(null, db.MESSAGE_RETENTION_DAYS);

            const CLEANUP_INTERVAL_MS = 6 * 60 * 60 * 1000;
            setInterval(() => {
                if (state.dbConnected) {
                    db.scheduleDeferredCleanup(null, db.MESSAGE_RETENTION_DAYS);
                }
            }, CLEANUP_INTERVAL_MS);
            if (typeof startBroadcastScheduler === 'function') {
                startBroadcastScheduler();
            }
        } else {
            console.warn('⚠️  Running without DB:', db.getLastError());
        }
    }).catch(err => {
        console.error('DB init failed:', err.message);
    });

    // Background sync — runs every 60 minutes (was 5 min, caused redo log exhaustion).
    // Only syncs conversation metadata (no message bodies) to minimize DB writes.
    const BG_SYNC_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
    const pageSyncLastRun = new Map();

    setInterval(async () => {
        if (!state.dbConnected) return;
        try {
            const pages = await db.getPages();
            if (!pages.length) return;
            const now = Date.now();
            const cutoff7Days = Math.floor((now - 7 * 24 * 60 * 60 * 1000) / 1000);

            // Run one page at a time (serial) to avoid write spikes
            for (const p of pages) {
                if (!p.access_token) continue;
                const last = pageSyncLastRun.get(p.id) || 0;
                if (now - last < BG_SYNC_INTERVAL_MS) continue;
                pageSyncLastRun.set(p.id, now);
                try {
                    await db.syncConversationsFromFacebook(p.id, p.access_token, fetch, cutoff7Days);
                    if (io) io.to(`page_${p.id}`).emit('sync_progress', { phase: 'done' });
                } catch (err) {
                    logError('bg_sync', err, { pageId: p.id });
                }
            }
        } catch (err) {
            logError('bg_sync_tick', err);
        }
    }, 30 * 60 * 1000); // check every 30 min, but each page syncs at most every 60 min
}

module.exports = { startServer };
