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
    FB_GRAPH_VERSION: process.env.FB_GRAPH_VERSION || 'v19.0'
};
