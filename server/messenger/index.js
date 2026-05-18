const { createMessengerRouter } = require('./router');
const { MESSAGE_RETENTION_DAYS } = require('./config');

/**
 * Mount messenger module on the Express app.
 * @returns {{ syncService }} for startup / background jobs
 */
function mountMessenger(deps) {
    const { app, requireAuth } = deps;
    const { router, syncService } = createMessengerRouter(deps);

    app.use(['/api/messenger', '/messenger_api.php'], router);

    app.post('/api/sync-history', requireAuth, async (req, res) => {
        const { page_id, page_token } = req.body;
        if (!page_id || !page_token) {
            return res.status(400).json({ error: 'page_id and page_token required' });
        }

        const lastSynced = await deps.db.getPageSyncTime(page_id).catch(() => null);

        syncService.ensurePageSynced(page_id, page_token, deps.io, { force: true });

        res.json({
            success: true,
            message: lastSynced ? 'Incremental sync started' : 'Initial sync started'
        });
    });

    return { syncService };
}

module.exports = {
    mountMessenger,
    config: require('./config'),
    MESSAGE_RETENTION_DAYS
};
