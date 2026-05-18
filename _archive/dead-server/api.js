const express = require('express');
const router = express.Router();
const { requireAuth, verifyCsrf } = require('../middleware/security');
const { logError } = require('../utils');
const db = require('../db');
const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));

router.post(['/update_quota', '/update_quota.php'], requireAuth, verifyCsrf, async (req, res) => {
    const { fb_user_id, count } = req.body;
    if (!fb_user_id) return res.status(400).json({ error: 'fb_user_id required' });
    try {
        const result = await db.updateUserQuota(fb_user_id, count);
        if (result) res.json(result);
        else res.status(404).json({ error: 'User not found' });
    } catch (err) {
        logError('update_quota', err);
        res.status(500).json({ error: 'Failed to update quota' });
    }
});

router.post('/sync/all', requireAuth, verifyCsrf, async (req, res) => {
    try {
        const fbRes = await fetch(`https://graph.facebook.com/v19.0/me/accounts?fields=id,name,picture,access_token&access_token=${req.session.accessToken}`);
        const data  = await fbRes.json();
        if (data.error) throw new Error(data.error.message);
        res.json({ success: true, message: `Sync started for ${(data.data || []).length} pages` });
        for (const page of (data.data || [])) {
            db.syncAllPageData(page.id, page.access_token, fetch).catch(err => logError('sync_all_bg', err, { pageId: page.id }));
        }
    } catch (err) {
        logError('sync_all', err);
        if (!res.headersSent) res.status(500).json({ error: err.message });
    }
});

router.get('/config', (req, res) => {
    res.json({
        fbAppId: process.env.FB_APP_ID,
        fbRedirectUri: process.env.FB_REDIRECT_URI,
        stripeKey: process.env.STRIPE_PUBLIC_KEY,
        env: process.env.NODE_ENV || 'development'
    });
});

module.exports = router;
