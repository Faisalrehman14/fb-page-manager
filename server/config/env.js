require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });

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
    BINANCE_PAY_API_KEY: (process.env.BINANCE_PAY_API_KEY || '').trim(),
    BINANCE_PAY_API_SECRET: (process.env.BINANCE_PAY_API_SECRET || '').trim(),
    BINANCE_PAY_CURRENCY: (process.env.BINANCE_PAY_CURRENCY || 'USDT').trim().toUpperCase(),
    BINANCE_PAY_USE_FIAT: (process.env.BINANCE_PAY_USE_FIAT || '1').trim() === '1',
    BINANCE_PAY_FIAT_CURRENCY: (process.env.BINANCE_PAY_FIAT_CURRENCY || 'USD').trim().toUpperCase(),
    BINANCE_PAY_WEBHOOK_SKIP_VERIFY: (process.env.BINANCE_PAY_WEBHOOK_SKIP_VERIFY || '').trim(),
    CONTACT_EMAIL: (process.env.CONTACT_EMAIL || '').trim(),

    // AI Broadcast Assistant (openai = Groq/OpenAI, anthropic = /v1/messages)
    AI_BASE_URL: (process.env.AI_BASE_URL || '').trim(),
    AI_API_KEY:  (process.env.AI_API_KEY  || '').trim(),
    AI_MODEL:    (process.env.AI_MODEL    || 'llama-3.1-8b-instant').trim(),
    AI_API_STYLE: (process.env.AI_API_STYLE || '').trim(),
    AI_RATE_LIMIT_PER_MIN: (process.env.AI_RATE_LIMIT_PER_MIN || '20').trim()
};
