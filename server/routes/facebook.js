const express = require('express');
const router = express.Router();
const { requireAuth, verifyCsrf } = require('../middleware/security');
const { logError } = require('../utils');
const db = require('../db');
const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));

router.post('/fb-proxy', requireAuth, verifyCsrf, async (req, res) => {
    const { path, method, body, access_token } = req.body;
    if (!path) return res.status(400).json({ error: 'path required' });
    try {
        const url = `https://graph.facebook.com/v19.0/${path}`;
        const options = {
            method: method || 'GET',
            headers: { 'Content-Type': 'application/json' }
        };
        const token = access_token || req.session.accessToken;
        const finalUrl = url + (url.includes('?') ? '&' : '?') + `access_token=${token}`;
        if (body) options.body = JSON.stringify(body);
        
        const fRes = await fetch(finalUrl, options);
        const fData = await fRes.json();
        res.status(fRes.status).json(fData);
    } catch (err) {
        logError('fb-proxy', err);
        res.status(500).json({ error: err.message });
    }
});

router.post('/sync-history', requireAuth, verifyCsrf, async (req, res) => {
    const { page_id, page_token } = req.body;
    if (!page_id || !page_token) return res.status(400).json({ error: 'page_id and page_token required' });
    try {
        const io = req.app.get('io');
        // Non-blocking sync start
        db.syncPageInitial(page_id, page_token, fetch, prog => io.emit('sync_progress', prog))
            .catch(err => logError('manual_sync', err, { pageId: page_id }));
            
        res.json({ success: true, message: 'Sync started' });
    } catch (err) {
        logError('sync-history', err);
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
