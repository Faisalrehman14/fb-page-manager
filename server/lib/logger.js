const state = require('./state');
const MAX_LOGS = 100;

function logError(type, error, ctx = {}) {
    const entry = {
        id: `${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        time: new Date().toISOString(),
        type,
        message: error?.message || String(error),
        stack: error?.stack ? error.stack.split('\n').slice(0, 6).join('\n') : null,
        context: ctx
    };
    state.errorLogs = state.errorLogs || [];
    state.errorLogs.unshift(entry);
    if (state.errorLogs.length > MAX_LOGS) state.errorLogs.pop();
    console.error(`[ERROR:${type}]`, entry.message, Object.keys(ctx).length ? ctx : '');
    return entry;
}

function trackRequest(req) {
    if (req.url.includes('api') || req.method === 'POST') {
        state.requestLogs.unshift({ time: new Date().toISOString(), method: req.method, url: req.url });
        if (state.requestLogs.length > MAX_LOGS) state.requestLogs.pop();
    }
}

module.exports = { logError, trackRequest, MAX_LOGS };
