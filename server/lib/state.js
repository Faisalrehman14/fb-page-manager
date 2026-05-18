/** Shared runtime state (mutable) */
module.exports = {
    dbConnected: false,
    requestLogs: [],
    webhookLogs: [],
    errorLogs: [],
    connectedSockets: new Map(),
    syncCooldown: new Map(),
    syncAllCooldown: new Map()
};
