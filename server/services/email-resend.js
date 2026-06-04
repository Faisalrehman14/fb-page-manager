const env = require('../config/env');

function getResendApiKey() {
    return String(env.RESEND_API_KEY || '').trim();
}

function getResendFrom() {
    return String(env.RESEND_FROM || env.SMTP_FROM || 'FBCast Pro <onboarding@resend.dev>').trim();
}

function isResendConfigured() {
    return getResendApiKey().startsWith('re_');
}

async function resendRequest(path, options = {}) {
    const key = getResendApiKey();
    const res = await fetch(`https://api.resend.com${path}`, {
        ...options,
        headers: {
            Authorization: `Bearer ${key}`,
            'Content-Type': 'application/json',
            ...(options.headers || {})
        }
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
        const msg = data?.message || data?.error || `Resend API error (${res.status})`;
        throw Object.assign(new Error(msg), { status: res.status >= 500 ? 503 : 400, provider: 'resend' });
    }
    return data;
}

async function verifyResend() {
    if (!isResendConfigured()) {
        throw Object.assign(new Error('RESEND_API_KEY is not set (must start with re_).'), { status: 503 });
    }
    await resendRequest('/domains');
    return { ok: true, provider: 'resend' };
}

async function sendViaResend({ to, subject, html, text }) {
    const from = getResendFrom();
    await resendRequest('/emails', {
        method: 'POST',
        body: JSON.stringify({
            from,
            to: Array.isArray(to) ? to : [to],
            subject,
            html,
            text: text || undefined
        })
    });
}

module.exports = {
    isResendConfigured,
    verifyResend,
    sendViaResend,
    getResendFrom
};
