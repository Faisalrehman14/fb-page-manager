const crypto = require('crypto');
const env = require('../config/env');

const OTP_TTL_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 5;
const RESEND_COOLDOWN_MS = 60 * 1000;

function hashOtp(code) {
    const secret = env.SESSION_SECRET || 'otp-secret';
    return crypto.createHmac('sha256', secret).update(String(code).trim()).digest('hex');
}

function generateOtpCode() {
    return String(crypto.randomInt(100000, 1000000));
}

function isOtpConfigured() {
    return !!(env.SMTP_HOST && env.SMTP_USER && env.SMTP_PASS);
}

module.exports = {
    OTP_TTL_MS,
    MAX_ATTEMPTS,
    RESEND_COOLDOWN_MS,
    hashOtp,
    generateOtpCode,
    isOtpConfigured
};
