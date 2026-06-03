const env = require('../config/env');

const DEFAULT_SCOPES = 'public_profile,pages_show_list,pages_messaging,pages_read_engagement,pages_manage_metadata';

function getOAuthScopes() {
    return (process.env.FB_OAUTH_SCOPES || DEFAULT_SCOPES).trim();
}

/** Classic Facebook OAuth — scope only (Continue with Facebook). */
function buildFacebookOAuthUrl({ appId, redirectUri, state }) {
    const params = new URLSearchParams();
    params.set('client_id', appId);
    params.set('redirect_uri', redirectUri);
    params.set('response_type', 'code');
    params.set('state', state);
    params.set('scope', getOAuthScopes());
    return `https://www.facebook.com/dialog/oauth?${params.toString()}`;
}

function getOAuthMode() {
    return 'facebook_login_scopes';
}

module.exports = {
    buildFacebookOAuthUrl,
    getOAuthScopes,
    getOAuthMode,
    DEFAULT_SCOPES
};
