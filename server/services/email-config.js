const env = require('../config/env');

function isGmailHost(host) {
    const h = String(host || '').toLowerCase();
    return h.includes('gmail.com') || h === 'smtp.google.com';
}

/** Gmail SMTP is blocked/rejected from most cloud hosts (Railway, Render, etc.). */
function isCloudHosted() {
    return !!(
        process.env.RAILWAY_ENVIRONMENT
        || process.env.RAILWAY_PROJECT_ID
        || process.env.FLY_APP_NAME
        || process.env.RENDER
        || process.env.VERCEL
        || env.APP_ENV === 'production'
    );
}

function isResendKeyPresent() {
    return String(env.RESEND_API_KEY || '').trim().startsWith('re_');
}

function isSmtpVarsPresent() {
    const user = String(env.SMTP_USER || '').trim();
    const pass = String(env.SMTP_PASS || '').trim().replace(/\s+/g, '');
    return !!(env.SMTP_HOST && user && pass);
}

function getSetupStatus() {
    if (isResendKeyPresent()) {
        return {
            ready: true,
            provider: 'resend',
            adminHint: null,
            publicMessage: null
        };
    }

    if (isSmtpVarsPresent() && isGmailHost(env.SMTP_HOST) && isCloudHosted()) {
        return {
            ready: false,
            provider: 'none',
            reason: 'gmail_blocked_on_cloud',
            adminHint: 'Gmail SMTP does not work on Railway. Remove SMTP_* variables and set RESEND_API_KEY + RESEND_FROM (verify domain at resend.com). Or use Hostinger/Brevo SMTP (not gmail.com).',
            publicMessage: 'Email verification is temporarily unavailable. Please try again in a few minutes.'
        };
    }

    if (isSmtpVarsPresent()) {
        return {
            ready: true,
            provider: 'smtp',
            adminHint: null,
            publicMessage: null
        };
    }

    return {
        ready: false,
        provider: 'none',
        reason: 'not_configured',
        adminHint: 'Set RESEND_API_KEY on Railway (recommended) or non-Gmail SMTP (Hostinger/Brevo).',
        publicMessage: 'Email verification is not available yet. Please contact support.'
    };
}

module.exports = {
    isGmailHost,
    isCloudHosted,
    isResendKeyPresent,
    isSmtpVarsPresent,
    getSetupStatus
};
