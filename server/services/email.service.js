const nodemailer = require('nodemailer');
const env = require('../config/env');

let _transport = null;

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

async function sendSignupOtpEmail(toEmail, code) {
    const transport = getTransport();
    if (!transport) {
        throw Object.assign(new Error('Email is not configured on the server. Set SMTP_* variables.'), { status: 503 });
    }

    const from = env.SMTP_FROM || `FBCast Pro <${env.SMTP_USER}>`;
    const site = env.SITE_URL || env.BASE_URL || 'https://fb-page-manager-production-f759.up.railway.app';

    const html = `
<div style="font-family:system-ui,sans-serif;max-width:480px;margin:0 auto;padding:24px;">
  <h2 style="color:#2563eb;margin:0 0 12px;">Verify your email</h2>
  <p style="color:#334155;line-height:1.5;">Use this code to complete your FBCast Pro account signup:</p>
  <p style="font-size:32px;font-weight:700;letter-spacing:8px;color:#0f172a;margin:24px 0;">${code}</p>
  <p style="color:#64748b;font-size:14px;">This code expires in 10 minutes. If you did not request this, ignore this email.</p>
  <hr style="border:none;border-top:1px solid #e2e8f0;margin:24px 0;">
  <p style="font-size:12px;color:#94a3b8;"><a href="${site}">${site}</a></p>
</div>`;

    await transport.sendMail({
        from,
        to: toEmail,
        subject: `${code} — FBCast Pro verification code`,
        text: `Your FBCast Pro verification code is ${code}. It expires in 10 minutes.`,
        html
    });
}

module.exports = { sendSignupOtpEmail, isEmailConfigured, getTransport };
