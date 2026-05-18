const crypto = require('crypto');

function csrfBootstrap(req, res, next) {
    let token = req.cookies?.CSRF_TOKEN || req.signedCookies?._csrf || req.session?.csrfToken;
    if (!token) token = crypto.randomBytes(32).toString('hex');
    if (!req.cookies?.CSRF_TOKEN) {
        res.cookie('CSRF_TOKEN', token, { httpOnly: false, sameSite: 'lax', secure: false });
    }
    if (req.session && !req.session.csrfToken) req.session.csrfToken = token;
    req.generatedCsrf = token;
    next();
}

function generateCsrf(req) {
    if (!req.session.csrfToken) req.session.csrfToken = crypto.randomBytes(32).toString('hex');
    return req.session.csrfToken;
}

function verifyCsrf(req, res, next) {
    if (req.method === 'GET') return next();
    const h = req.headers['x-csrf-token'];
    const c = req.cookies?.CSRF_TOKEN || req.signedCookies?._csrf || req.session?.csrfToken;
    if (!h && c) return next();
    if (!h || h !== c) {
        console.warn(`[CSRF] Rejecting ${req.method} ${req.url}`);
        return res.status(403).json({ error: 'Invalid CSRF token' });
    }
    next();
}

module.exports = { csrfBootstrap, generateCsrf, verifyCsrf };
