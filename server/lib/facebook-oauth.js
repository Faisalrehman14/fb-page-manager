const env = require('../config/env');

/** Original scopes — same as before Business Login config work */
const DEFAULT_SCOPES = 'public_profile,pages_show_list,pages_messaging,pages_read_engagement,pages_manage_metadata';

function getOAuthScopes() {
    return (process.env.FB_OAUTH_SCOPES || DEFAULT_SCOPES).trim();
}

/**
 * Default: classic scope-based OAuth (worked before config_id).
 * Set FB_OAUTH_USE_CONFIG_ID=1 only if you explicitly want Facebook Login for Business.
 */
function buildFacebookOAuthUrl({ appId, redirectUri, state }) {
    const configId = (process.env.FB_LOGIN_CONFIG_ID || '').trim();
    const useConfigId = (process.env.FB_OAUTH_USE_CONFIG_ID || '').trim() === '1';

    const params = new URLSearchParams();
    params.set('client_id', appId);
    params.set('redirect_uri', redirectUri);
    params.set('response_type', 'code');
    params.set('state', state);
    params.set('scope', getOAuthScopes());

    if (useConfigId && configId) {
        params.set('config_id', configId);
    }

    return `https://www.facebook.com/dialog/oauth?${params.toString()}`;
}

function getOAuthMode() {
    const useConfigId = (process.env.FB_OAUTH_USE_CONFIG_ID || '').trim() === '1';
    const configId = (process.env.FB_LOGIN_CONFIG_ID || '').trim();
    if (useConfigId && configId) return 'facebook_login_for_business';
    return 'facebook_login_scopes';
}

module.exports = {
    buildFacebookOAuthUrl,
    getOAuthScopes,
    getOAuthMode,
    DEFAULT_SCOPES
};
