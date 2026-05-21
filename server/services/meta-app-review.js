/**
 * Meta App Review — required Graph API test calls.
 *
 * Dashboard marks permissions "Completed" only when these exact endpoints succeed
 * with a user access token from your app (Admin/Developer/Tester during testing):
 *   public_profile  → GET /me?fields=id,name
 *   pages_show_list → GET /me/accounts?fields=id,name
 */
const { FB_GRAPH_VERSION } = require('../config/env');

const FB_GRAPH_BASE = `https://graph.facebook.com/${FB_GRAPH_VERSION}`;

function graphUrl(path, accessToken) {
    const sep = path.includes('?') ? '&' : '?';
    return `${FB_GRAPH_BASE}${path}${sep}access_token=${encodeURIComponent(accessToken)}`;
}

async function graphGet(path, accessToken, fetchFn) {
    const res = await fetchFn(graphUrl(path, accessToken));
    const data = await res.json();
    if (data.error) {
        return { ok: false, error: data.error.message || 'Graph API error', code: data.error.code };
    }
    return { ok: true, data };
}

/**
 * Run the two permission test calls Meta expects. Safe to call on every login.
 */
async function runMetaReviewTestCalls(accessToken, fetchFn) {
    if (!accessToken) {
        return {
            public_profile: { ok: false, error: 'missing access token' },
            pages_show_list: { ok: false, error: 'missing access token' }
        };
    }

    const [public_profile, pages_show_list] = await Promise.all([
        graphGet('/me?fields=id,name', accessToken, fetchFn),
        graphGet('/me/accounts?fields=id,name', accessToken, fetchFn)
    ]);

    return {
        public_profile,
        pages_show_list,
        pageCount: pages_show_list.ok ? (pages_show_list.data?.data || []).length : 0,
        graphVersion: FB_GRAPH_VERSION
    };
}

module.exports = {
    FB_GRAPH_BASE,
    FB_GRAPH_VERSION,
    runMetaReviewTestCalls
};
