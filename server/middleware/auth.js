function requireAuth(req, res, next) {
    if (!req.session.accessToken) return res.status(401).json({ redirect: '/' });
    next();
}

function requireAdminAuth(req, res, next) {
    if (req.session?.isAdmin) return next();
    res.status(401).json({ error: 'Unauthorized', redirect: '/admin' });
}

function restoreSessionFromCookies(req, res, next) {
    if (req.session && !req.session.accessToken && req.signedCookies?._fb_at) {
        req.session.accessToken = req.signedCookies._fb_at;
        req.session.userId = req.signedCookies._fb_uid;
        req.session.userName = req.signedCookies._fb_un;
    }
    next();
}

module.exports = { requireAuth, requireAdminAuth, restoreSessionFromCookies };
