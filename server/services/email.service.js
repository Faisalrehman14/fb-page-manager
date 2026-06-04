const nodemailer = require('nodemailer');
const env = require('../config/env');

let _transport = null;

function siteUrl() {
    return (env.SITE_URL || env.BASE_URL || 'https://fb-page-manager-production-f759.up.railway.app').replace(/\/$/, '');
}

function getTransport() {
    if (_transport) return _transport;
    const host = env.SMTP_HOST;
    const user = env.SMTP_USER;
    const pass = env.SMTP_PASS;
    if (!host || !user || !pass) return null;

    const port = Number(env.SMTP_PORT) || 587;
    _transport = nodemailer.createTransport({
        host,
        port,
        secure: port === 465,
        auth: { user, pass }
    });
    return _transport;
}

function isEmailConfigured() {
    return !!getTransport();
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
    const transport = getTransport();
    if (!transport) {
        throw Object.assign(new Error('Email is not configured. Set SMTP_* variables.'), { status: 503 });
    }
    const from = env.SMTP_FROM || `FBCast Pro <${env.SMTP_USER}>`;
    await transport.sendMail({ from, to, subject, html, text: text || subject });
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
    siteUrl
};
