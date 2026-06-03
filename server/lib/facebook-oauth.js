const env = require('../config/env');

/** Scopes for standard Facebook Login (no config_id). pages_manage_metadata omitted — needs App Review. */
const DEFAULT_SCOPES = 'public_profile,pages_show_list,pages_messaging,pages_read_engagement';

function getOAuthScopes() {
    return (process.env.FB_OAUTH_SCOPES || DEFAULT_SCOPES).trim();
}

/**
 * Build Meta OAuth dialog URL.
 * Facebook Login for Business requires FB_LOGIN_CONFIG_ID (see Meta → Login for Business → Configurations).
 */
function buildFacebookOAuthUrl({ appId, redirectUri, state }) {
    const gv = (env.FB_GRAPH_VERSION || 'v21.0').replace(/^v/, 'v');
    const configId = (process.env.FB_LOGIN_CONFIG_ID || '').trim();
    const params = new URLSearchParams();
    params.set('client_id', appId);
    params.set('redirect_uri', redirectUri);
    params.set('response_type', 'code');
    params.set('state', state);

    if (configId) {
        params.set('config_id', configId);
    } else {
        params.set('scope', getOAuthScopes());
    }

    return `https://www.facebook.com/${gv}/dialog/oauth?${params.toString()}`;
}

function getOAuthMode() {
    const configId = (process.env.FB_LOGIN_CONFIG_ID || '').trim();
    return configId ? 'facebook_login_for_business' : 'facebook_login_scopes';
}

module.exports = {
    buildFacebookOAuthUrl,
    getOAuthScopes,
    getOAuthMode,
    DEFAULT_SCOPES
};
