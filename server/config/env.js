require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });

function stripEnvQuotes(v) {
    const s = String(v || '').trim();
    if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
        return s.slice(1, -1).trim();
    }
    return s;
}

module.exports = {
    PORT: process.env.PORT || 3000,
    FB_APP_ID: (process.env.FB_APP_ID || '').trim(),
    FB_APP_SECRET: (process.env.FB_APP_SECRET || '').trim(),
    BASE_URL: (process.env.BASE_URL || '').trim(),
    SITE_URL: (process.env.SITE_URL || '').trim(),
    SESSION_SECRET: process.env.SESSION_SECRET || 'fb-cast-pro-session-secret-998877',
    WEBHOOK_VERIFY_TOKEN: (process.env.WEBHOOK_VERIFY_TOKEN || process.env.FB_WEBHOOK_VERIFY_TOKEN || 'ADMIN12345').trim(),
    ADMIN_PASSWORD: process.env.ADMIN_PASSWORD || 'admin123',
    FB_GRAPH_VERSION: process.env.FB_GRAPH_VERSION || 'v21.0',
    FB_OAUTH_SCOPES: (process.env.FB_OAUTH_SCOPES || '').trim(),
    APP_ENV: (process.env.APP_ENV || 'development').trim(),
    STRIPE_SECRET_KEY: (process.env.STRIPE_SECRET_KEY || '').trim(),
    STRIPE_PUBLISHABLE_KEY: (process.env.STRIPE_PUBLISHABLE_KEY || '').trim(),
    STRIPE_WEBHOOK_SECRET: (process.env.STRIPE_WEBHOOK_SECRET || '').trim(),
    CONTACT_EMAIL: (process.env.CONTACT_EMAIL || '').trim(),
    SMTP_HOST: stripEnvQuotes(process.env.SMTP_HOST || ''),
    SMTP_PORT: stripEnvQuotes(process.env.SMTP_PORT || '587'),
    SMTP_USER: stripEnvQuotes(process.env.SMTP_USER || ''),
    SMTP_PASS: stripEnvQuotes(process.env.SMTP_PASS || ''),
    SMTP_FROM: stripEnvQuotes(process.env.SMTP_FROM || ''),
    EMAIL_PROVIDER: stripEnvQuotes(process.env.EMAIL_PROVIDER || ''),
    RESEND_API_KEY: stripEnvQuotes(process.env.RESEND_API_KEY || ''),
    RESEND_FROM: stripEnvQuotes(process.env.RESEND_FROM || ''),

    // AI Broadcast Assistant (openai = Groq/OpenAI, anthropic = /v1/messages)
    AI_BASE_URL: (process.env.AI_BASE_URL || '').trim(),
    AI_API_KEY:  (process.env.AI_API_KEY  || '').trim(),
    AI_MODEL:    (process.env.AI_MODEL    || 'llama-3.1-8b-instant').trim(),
    AI_API_STYLE: (process.env.AI_API_STYLE || '').trim(),
    AI_RATE_LIMIT_PER_MIN: (process.env.AI_RATE_LIMIT_PER_MIN || '20').trim()
};
