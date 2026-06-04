const nodemailer = require('nodemailer');
const env = require('../config/env');
const resend = require('./email-resend');

let _transport = null;

function siteUrl() {
    return (env.SITE_URL || env.BASE_URL || 'https://fb-page-manager-production-f759.up.railway.app').replace(/\/$/, '');
}

function getActiveProvider() {
    const forced = String(env.EMAIL_PROVIDER || '').trim().toLowerCase();
    if (forced === 'resend') return resend.isResendConfigured() ? 'resend' : null;
    if (forced === 'smtp') return isSmtpConfigured() ? 'smtp' : null;
    if (resend.isResendConfigured()) return 'resend';
    if (isSmtpConfigured()) return 'smtp';
    return null;
}

function normalizeSmtpPass(pass) {
    return String(pass || '').trim().replace(/\s+/g, '');
}

function getSmtpUser() {
    return String(env.SMTP_USER || '').trim();
}

function isSmtpConfigured() {
    const user = getSmtpUser();
    const pass = normalizeSmtpPass(env.SMTP_PASS);
    return !!(env.SMTP_HOST && user && pass);
}

function isEmailConfigured() {
    return !!getActiveProvider();
}

function isGmailHost(host) {
    const h = String(host || '').toLowerCase();
    return h.includes('gmail.com') || h === 'smtp.google.com';
}

function buildTransportOptions(portOverride) {
    const host = String(env.SMTP_HOST || '').trim();
    const user = getSmtpUser();
    const pass = normalizeSmtpPass(env.SMTP_PASS);
    if (!host || !user || !pass) return null;

    if (isGmailHost(host)) {
        const port = portOverride != null ? Number(portOverride) : (Number(env.SMTP_PORT) || 587);
        if (port === 465) {
            return { host: 'smtp.gmail.com', port: 465, secure: true, auth: { user, pass } };
        }
        return {
            host: 'smtp.gmail.com',
            port: 587,
            secure: false,
            requireTLS: true,
            auth: { user, pass },
            tls: { minVersion: 'TLSv1.2' }
        };
    }

    const port = portOverride != null ? Number(portOverride) : (Number(env.SMTP_PORT) || 587);
    return {
        host,
        port,
        secure: port === 465,
        auth: { user, pass },
        ...(port === 587 ? { requireTLS: true } : {})
    };
}

function resetTransport() {
    _transport = null;
}

function getTransport(portOverride) {
    if (_transport && portOverride == null) return _transport;
    const opts = buildTransportOptions(portOverride);
    if (!opts) return null;
    const transport = nodemailer.createTransport(opts);
    if (portOverride == null) _transport = transport;
    return transport;
}

function getEmailDebugInfo() {
    const provider = getActiveProvider();
    const user = getSmtpUser();
    const pass = normalizeSmtpPass(env.SMTP_PASS);
    return {
        provider: provider || 'none',
        configured: !!provider,
        resend: {
            configured: resend.isResendConfigured(),
            from: resend.getResendFrom()
        },
        smtp: {
            configured: isSmtpConfigured(),
            host: String(env.SMTP_HOST || '').trim() || null,
            port: Number(env.SMTP_PORT) || 587,
            user: user || null,
            passLength: pass.length,
            passLooksLikeAppPassword: pass.length === 16 && /^[a-z0-9]+$/i.test(pass),
            from: String(env.SMTP_FROM || '').trim() || null,
            isGmail: isGmailHost(env.SMTP_HOST)
        }
    };
}

function getSmtpDebugInfo() {
    const d = getEmailDebugInfo();
    return {
        configured: d.configured,
        provider: d.provider,
        ...d.smtp,
        from: d.provider === 'resend' ? d.resend.from : d.smtp.from
    };
}

function mapSmtpError(err) {
    if (err?.code === 'SMTP_AUTH_FAILED' || (err?.status === 503 && err?.message?.includes('App Password'))) {
        return err;
    }
    const msg = String(err?.message || err || '').toLowerCase();
    const code = String(err?.code || err?.responseCode || '');

    if (msg.includes('badcredentials') || msg.includes('535') || msg.includes('username and password not accepted')) {
        return Object.assign(new Error(
            'Gmail rejected the App Password. Fix: (1) Revoke old app passwords and create a new one for castmeproo@gmail.com. (2) On your phone, open https://accounts.google.com/DisplayUnlockCaptcha while logged into that Gmail, click Continue, then redeploy Railway. (3) Or set RESEND_API_KEY on Railway (recommended) — see .env.example.'
        ), { status: 503, code: 'SMTP_AUTH_FAILED' });
    }
    if (code === 'EAUTH' || msg.includes('authentication')) {
        return Object.assign(new Error(
            'SMTP authentication failed. For Gmail use a new App Password; or add RESEND_API_KEY on Railway.'
        ), { status: 503, code: 'SMTP_AUTH_FAILED' });
    }
    if (msg.includes('etimedout') || msg.includes('timeout') || code === 'ETIMEDOUT') {
        return Object.assign(new Error('Email server timed out. Try again in a moment.'), { status: 503 });
    }
    return Object.assign(new Error('Could not send email. Please try again later.'), { status: 503 });
}

function mapEmailError(err) {
    if (err?.provider === 'resend') {
        return Object.assign(new Error(err.message || 'Resend failed'), { status: 503 });
    }
    return mapSmtpError(err);
}

async function verifySmtpWithFallback() {
    const info = getEmailDebugInfo().smtp;
    if (!info.configured) {
        throw Object.assign(new Error('SMTP is not configured.'), { status: 503 });
    }
    resetTransport();
    const primaryPort = info.port;
    try {
        await getTransport(primaryPort).verify();
        return { ok: true, port: primaryPort, provider: 'smtp' };
    } catch (firstErr) {
        resetTransport();
        if (!info.isGmail || primaryPort === 465) throw mapSmtpError(firstErr);
        try {
            await getTransport(465).verify();
            return { ok: true, port: 465, provider: 'smtp', note: 'Set SMTP_PORT=465 on Railway' };
        } catch (_) {
            resetTransport();
            throw mapSmtpError(firstErr);
        }
    }
}

async function verifyEmailConnection() {
    const provider = getActiveProvider();
    if (!provider) {
        throw Object.assign(new Error('No email provider. Set RESEND_API_KEY or SMTP_* on Railway.'), { status: 503 });
    }
    if (provider === 'resend') {
        return resend.verifyResend();
    }
    return verifySmtpWithFallback();
}

function emailLayout({ title, bodyHtml, ctaLabel, ctaUrl }) {
    const site = siteUrl();
    const cta = ctaLabel && ctaUrl
        ? `<p style="margin:28px 0 0;"><a href="${ctaUrl}" style="display:inline-block;background:#2563eb;color:#fff;text-decoration:none;padding:12px 24px;border-radius:8px;font-weight:600;">${ctaLabel}</a></p>`
        : '';
    return `
<div style="font-family:system-ui,-apple-system,sans-serif;max-width:520px;margin:0 auto;padding:24px;background:#f8fafc;">
  <div style="background:#fff;border-radius:12px;padding:28px;border:1px solid #e2e8f0;">
    <p style="margin:0 0 8px;font-size:13px;font-weight:700;color:#2563eb;">FBCast Pro</p>
    <h1 style="margin:0 0 16px;font-size:22px;color:#0f172a;">${title}</h1>
    <div style="color:#334155;font-size:15px;line-height:1.6;">${bodyHtml}</div>
    ${cta}
    <hr style="border:none;border-top:1px solid #e2e8f0;margin:28px 0 16px;">
    <p style="margin:0;font-size:12px;color:#94a3b8;">Questions? Reply to this email or visit <a href="${site}" style="color:#2563eb;">${site}</a></p>
  </div>
</div>`;
}

async function sendMail({ to, subject, html, text }) {
    const provider = getActiveProvider();
    if (!provider) {
        throw Object.assign(new Error('Email is not configured. Set RESEND_API_KEY or SMTP_* variables.'), { status: 503 });
    }

    try {
        if (provider === 'resend') {
            await resend.sendViaResend({ to, subject, html, text });
            return;
        }
        const transport = getTransport();
        const user = getSmtpUser();
        const from = env.SMTP_FROM || `FBCast Pro <${user}>`;
        await transport.sendMail({ from, to, subject, html, text: text || subject });
    } catch (err) {
        throw mapEmailError(err);
    }
}

async function sendSignupOtpEmail(toEmail, code) {
    const html = emailLayout({
        title: 'Verify your email',
        bodyHtml: `
          <p>Use this code to complete your FBCast Pro signup:</p>
          <p style="font-size:32px;font-weight:700;letter-spacing:8px;color:#0f172a;margin:20px 0;">${code}</p>
          <p style="font-size:14px;color:#64748b;">Expires in 10 minutes. If you did not request this, ignore this email.</p>`
    });
    await sendMail({
        to: toEmail,
        subject: `${code} — FBCast Pro verification code`,
        html,
        text: `Your FBCast Pro verification code is ${code}. It expires in 10 minutes.`
    });
}

async function sendWelcomeEmail(toEmail, firstName) {
    const name = firstName ? ` ${firstName}` : '';
    const html = emailLayout({
        title: `Welcome${name}!`,
        bodyHtml: `
          <p>Your FBCast Pro account is ready.</p>
          <ul style="padding-left:20px;margin:16px 0;">
            <li>Connect your Facebook account from the dashboard (one time)</li>
            <li>Start your free trial and broadcast to your Page audience</li>
            <li>Upgrade anytime when you need more messages</li>
          </ul>`,
        ctaLabel: 'Open dashboard',
        ctaUrl: siteUrl()
    });
    await sendMail({
        to: toEmail,
        subject: 'Welcome to FBCast Pro',
        html,
        text: `Welcome to FBCast Pro! Open your dashboard: ${siteUrl()}`
    });
}

async function sendFreeTrialStartedEmail(toEmail, { firstName, trialDays, messageLimit, expiresAt }) {
    const name = firstName ? ` ${firstName}` : '';
    const exp = expiresAt ? new Date(expiresAt).toLocaleDateString('en-US', { dateStyle: 'medium' }) : '';
    const html = emailLayout({
        title: `Your free trial has started${name}`,
        bodyHtml: `
          <p>Great news — your <strong>${trialDays}-day free trial</strong> is now active.</p>
          <p><strong>${Number(messageLimit).toLocaleString()}</strong> messages included${exp ? ` · ends <strong>${exp}</strong>` : ''}.</p>
          <p>Connect your Facebook Page and send your first broadcast from the dashboard.</p>`,
        ctaLabel: 'Start broadcasting',
        ctaUrl: siteUrl()
    });
    await sendMail({
        to: toEmail,
        subject: `Your ${trialDays}-day FBCast Pro free trial is active`,
        html,
        text: `Your ${trialDays}-day free trial is active with ${messageLimit} messages.`
    });
}

async function sendTrialEndingReminderEmail(toEmail, { firstName, trialDaysLeft, expiresAt }) {
    const name = firstName ? ` ${firstName}` : '';
    const exp = expiresAt ? new Date(expiresAt).toLocaleDateString('en-US', { dateStyle: 'medium' }) : 'soon';
    const html = emailLayout({
        title: `Free trial ending soon${name}`,
        bodyHtml: `
          <p>Your FBCast Pro free trial ends in <strong>${trialDaysLeft} day${trialDaysLeft === 1 ? '' : 's'}</strong> (${exp}).</p>
          <p>After that, sending will pause until you choose a plan. Upgrade now to keep broadcasting without interruption.</p>`,
        ctaLabel: 'View plans',
        ctaUrl: `${siteUrl()}/?upgrade=1`
    });
    await sendMail({
        to: toEmail,
        subject: 'Reminder: your FBCast Pro free trial is ending',
        html,
        text: `Your free trial ends in ${trialDaysLeft} day(s). Upgrade at ${siteUrl()}`
    });
}

async function sendSubscriptionActivatedEmail(toEmail, { firstName, planName, messageLimit, expiresAt }) {
    const name = firstName ? ` ${firstName}` : '';
    const exp = expiresAt ? new Date(expiresAt).toLocaleDateString('en-US', { dateStyle: 'medium' }) : '';
    const html = emailLayout({
        title: `Subscription active — ${planName}${name}`,
        bodyHtml: `
          <p>Thank you! Your <strong>${planName}</strong> plan is now active.</p>
          <p><strong>${Number(messageLimit).toLocaleString()}</strong> messages per billing period${exp ? ` · renews <strong>${exp}</strong>` : ''}.</p>
          <p>You can manage billing and broadcast from your dashboard.</p>`,
        ctaLabel: 'Go to dashboard',
        ctaUrl: siteUrl()
    });
    await sendMail({
        to: toEmail,
        subject: `FBCast Pro ${planName} plan activated`,
        html,
        text: `Your ${planName} subscription is active. Dashboard: ${siteUrl()}`
    });
}

module.exports = {
    sendMail,
    sendSignupOtpEmail,
    sendWelcomeEmail,
    sendFreeTrialStartedEmail,
    sendTrialEndingReminderEmail,
    sendSubscriptionActivatedEmail,
    isEmailConfigured,
    getActiveProvider,
    verifyEmailConnection,
    verifySmtpWithFallback,
    getEmailDebugInfo,
    getSmtpDebugInfo,
    resetTransport,
    mapSmtpError,
    mapEmailError,
    siteUrl
};
