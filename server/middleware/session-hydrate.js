const db = require('../db');
const { computeAppSecretProof } = require('../services/meta-app-review');

const FB_GRAPH = 'https://graph.facebook.com/v21.0';

/**
 * Restore Facebook session from DB when user logged in with email/password.
 */
async function tryRestoreFacebookFromAppAccount(req) {
    if (req.session.accessToken) return true;
    const appId = req.session.appAccountId;
    if (!appId || !db.isConnected()) return false;

    const link = await db.getAppAccountFacebookLink(appId);
    if (!link?.linked_fb_user_id || !link.fb_access_token) return false;

    try {
        const token = link.fb_access_token;
        const proof = computeAppSecretProof(token);
        let url = `${FB_GRAPH}/me?fields=id,name&access_token=${encodeURIComponent(token)}`;
        if (proof) url += `&appsecret_proof=${encodeURIComponent(proof)}`;
        const res = await fetch(url);
        const data = await res.json();
        if (data.error) return false;

        req.session.accessToken = token;
        req.session.userId = data.id || link.linked_fb_user_id;
        req.session.userName = data.name || link.fb_name || '';
        return true;
    } catch (_) {
        return false;
    }
}

async function hydrateSession(req, res, next) {
    try {
        if (req.session.appAccountId && !req.session.accessToken) {
            await tryRestoreFacebookFromAppAccount(req);
        }
    } catch (_) { /* non-fatal */ }
    next();
}

module.exports = { hydrateSession, tryRestoreFacebookFromAppAccount };
