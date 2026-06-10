function requireAppAccount(req, res, next) {
    if (!req.session.appAccountId) {
        return res.status(401).json({ error: 'Please sign in', redirect: '/login' });
    }
    next();
}

function requireAdminAuth(req, res, next) {
    if (req.session?.isAdmin) return next();
    res.status(401).json({ error: 'Unauthorized', redirect: '/admin' });
}

async function requireAuth(req, res, next) {
    if (req.session.accessToken) {
        if (req.session.userId) {
            try {
                const db = require('../db');
                const status = await db.getUserAccountStatus(req.session.userId);
                if (status === 'suspended') {
                    return res.status(403).json({ error: 'Your account has been suspended. Contact support.', code: 'ACCOUNT_SUSPENDED' });
                }
            } catch (_) {}
        }
        return next();
    }
    if (req.session.appAccountId) {
        return res.status(401).json({
            error: 'Connect your Facebook account to continue',
            code: 'FACEBOOK_NOT_CONNECTED',
            redirect: '/'
        });
    }
    return res.status(401).json({ error: 'Please sign in', redirect: '/login' });
}

function restoreSessionFromCookies(req, res, next) {
    if (req.session && !req.session.accessToken && req.signedCookies?._fb_at) {
        req.session.accessToken = req.signedCookies._fb_at;
        req.session.userId = req.signedCookies._fb_uid;
        req.session.userName = req.signedCookies._fb_un;
    }
    if (req.session && !req.session.appAccountId && req.signedCookies?._app_aid) {
        const id = Number(req.signedCookies._app_aid);
        if (id > 0) req.session.appAccountId = id;
    }
    next();
}

module.exports = {
    requireAuth,
    requireAppAccount,
    requireAdminAuth,
    restoreSessionFromCookies
};
