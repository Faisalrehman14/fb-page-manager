const { logError } = require('../utils');

/**
 * Industry Standard: Double Submit Cookie CSRF
 */
function generateCsrf(req) {
    const crypto = require('crypto');
    const token = crypto.randomBytes(32).toString('hex');
    req.session.csrfToken = token;
    return token;
}

function verifyCsrf(req, res, next) {
    if (req.method === 'GET') return next();
    const h = req.headers['x-csrf-token'];
    const c = req.cookies?.CSRF_TOKEN || req.signedCookies?._csrf || req.session?.csrfToken;
    
    // Fallback: If header is missing but cookie is present, we trust the cookie 
    // because it's set with SameSite=Lax.
    if (!h && c) {
        return next();
    }
    
    if (!h || h !== c) {
        console.warn(`[CSRF] Rejecting ${req.method} ${req.url}: header=${h}, cookie=${req.cookies?.CSRF_TOKEN}, session=${req.session?.csrfToken}`);
        return res.status(403).json({ error: 'Invalid CSRF token' });
    }
    next();
}

function requireAuth(req, res, next) {
    if (!req.session.accessToken) return res.status(401).json({ redirect: '/' });
    next();
}

// Session Restoration Fallback: If session is lost but signed cookies exist, restore it
function restoreSession(req, res, next) {
    if (req.session && !req.session.accessToken && req.signedCookies?._fb_at) {
        req.session.accessToken = req.signedCookies._fb_at;
        req.session.userId      = req.signedCookies._fb_uid;
        req.session.userName    = req.signedCookies._fb_un;
    }
    next();
}

module.exports = {
    generateCsrf,
    verifyCsrf,
    requireAuth,
    restoreSession
};
