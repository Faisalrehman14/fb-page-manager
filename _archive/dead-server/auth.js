const express = require('express');
const router = express.Router();
const { generateCsrf } = require('../middleware/security');
const fetch = global.fetch || require('node-fetch');

router.get('/csrf-token', (req, res) => {
    const token = generateCsrf(req);
    req.session.save(() => {
        res.json({ csrfToken: token });
    });
});

router.post(['/fb-token', '/exchange_token.php'], async (req, res) => {
    const { user_token } = req.body;
    if (!user_token) return res.status(400).json({ error: 'user_token required' });
    try {
        const uRes  = await fetch(`https://graph.facebook.com/v19.0/me?fields=id,name&access_token=${user_token}`);
        const uData = await uRes.json();
        if (uData.error) return res.status(401).json({ error: uData.error.message });
        
        req.session.accessToken = user_token;
        req.session.userId      = uData.id;
        req.session.userName    = uData.name;
        req.session.firstLogin  = !req.session.firstLogin ? true : false;
        
        // Set signed cookies for persistence (Stateless Fallback)
        const cookieOpts = { signed: true, httpOnly: true, sameSite: 'lax', maxAge: 7 * 24 * 60 * 60 * 1000 };
        res.cookie('_fb_at', user_token, cookieOpts);
        res.cookie('_fb_uid', uData.id, cookieOpts);
        res.cookie('_fb_un', uData.name, cookieOpts);

        generateCsrf(req);
        res.json({ authenticated: true, userName: uData.name, csrfToken: req.session.csrfToken });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
