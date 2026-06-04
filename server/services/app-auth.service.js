const crypto = require('crypto');

const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const KEY_LEN = 64;

function hashPassword(password) {
    const salt = crypto.randomBytes(16);
    const hash = crypto.scryptSync(password, salt, KEY_LEN, SCRYPT_PARAMS);
    return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

function verifyPassword(password, stored) {
    if (!stored || !stored.startsWith('scrypt$')) return false;
    const parts = stored.split('$');
    if (parts.length !== 3) return false;
    const salt = Buffer.from(parts[1], 'base64');
    const expected = Buffer.from(parts[2], 'base64');
    const actual = crypto.scryptSync(password, salt, expected.length, SCRYPT_PARAMS);
    return crypto.timingSafeEqual(actual, expected);
}

function validateEmail(email) {
    const e = String(email || '').trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) return null;
    return e;
}

function validatePassword(password) {
    const p = String(password || '');
    if (p.length < 8) return 'Password must be at least 8 characters';
    return null;
}

function setAppSession(req, account) {
    req.session.appAccountId = account.id;
    req.session.appEmail = account.email;
    req.session.appFirstName = account.first_name || '';
}

function clearAppSession(req) {
    delete req.session.appAccountId;
    delete req.session.appEmail;
    delete req.session.appFirstName;
}

module.exports = {
    hashPassword,
    verifyPassword,
    validateEmail,
    validatePassword,
    setAppSession,
    clearAppSession
};
