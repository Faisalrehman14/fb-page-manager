const session = require('express-session');
const env = require('../config/env');

// Use in-memory session store only.
// Auth persistence is handled via signed cookies (_fb_at, _fb_uid, _fb_un)
// restored by restoreSessionFromCookies middleware — MySQL sessions caused
// disk exhaustion on Railway (sessions table filling the volume).
function createSessionMiddleware() {
    return session({
        secret: env.SESSION_SECRET,
        resave: false,
        saveUninitialized: false,
        cookie: {
            secure: false,
            httpOnly: true,
            sameSite: 'lax',
            maxAge: 7 * 24 * 60 * 60 * 1000
        }
    });
}

module.exports = { createSessionMiddleware };
