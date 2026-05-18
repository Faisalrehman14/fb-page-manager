/** Map legacy *.php URLs to modern /api routes */
function legacyPhpRedirect(req, res, next) {
    if (!req.path.endsWith('.php')) return next();

    const legacyMap = {
        'index.php': '/',
        'get_csrf.php': '/api/csrf-token',
        'fb_proxy.php': '/api/fb-proxy',
        'exchange_token.php': '/api/auth/fb-token',
        'track_user.php': '/api/auth/track',
        'upload_image.php': '/api/upload-image',
        'messenger_api.php': '/api/messenger',
        'oauth_start.php': '/api/auth/start',
        'oauth_callback.php': '/api/auth/callback',
        'create_checkout.php': '/api/billing/checkout',
        'fb_webhook.php': '/webhook',
        'admin.php': '/api/admin'
    };

    const filename = require('path').basename(req.path);
    if (legacyMap[filename]) {
        req.url = legacyMap[filename];
        return next();
    }
    return res.status(404).json({ error: 'Not found', hint: 'Use /api/* routes', path: req.path });
}

module.exports = { legacyPhpRedirect };
