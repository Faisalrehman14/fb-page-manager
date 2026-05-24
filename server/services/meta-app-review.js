/**
 * Meta App Review — required Graph API test calls.
 *
 * Meta "Testing" green Completed badge (not just API call count) requires:
 * - Successful GET /me (public_profile) and GET /me/accounts (pages_show_list)
 * - User access token from YOUR app
 * - Facebook account must be App Admin, Developer, or Tester
 * - Often needs browser-originated calls; server-only may increment count without Completed
 * - Dashboard can take up to 24 hours to update
 */
const { FB_GRAPH_VERSION, FB_APP_ID, FB_APP_SECRET } = require('../config/env');

const FB_GRAPH_BASE = `https://graph.facebook.com/${FB_GRAPH_VERSION}`;

function graphUrl(path, accessToken) {
    const sep = path.includes('?') ? '&' : '?';
    return `${FB_GRAPH_BASE}${path}${sep}access_token=${encodeURIComponent(accessToken)}`;
}

function appAccessToken() {
    if (!FB_APP_ID || !FB_APP_SECRET) return null;
    return `${FB_APP_ID}|${FB_APP_SECRET}`;
}

async function graphGet(path, accessToken, fetchFn) {
    const res = await fetchFn(graphUrl(path, accessToken));
    const data = await res.json();
    if (data.error) {
        return { ok: false, error: data.error.message || 'Graph API error', code: data.error.code };
    }
    return { ok: true, data };
}

async function inspectAccessToken(userToken, fetchFn) {
    const appToken = appAccessToken();
    if (!appToken || !userToken) {
        return { ok: false, error: 'missing app or user token' };
    }
    const url = `${FB_GRAPH_BASE}/debug_token?input_token=${encodeURIComponent(userToken)}&access_token=${encodeURIComponent(appToken)}`;
    const res = await fetchFn(url);
    const body = await res.json();
    const info = body.data || {};
    if (!info.is_valid) {
        return { ok: false, error: body.error?.message || 'invalid token', raw: body };
    }
    const scopes = info.scopes || [];
    return {
        ok: true,
        userId: info.user_id || null,
        appId: info.app_id || null,
        type: info.type || null,
        scopes,
        hasPublicProfile: true,
        hasPagesShowList: scopes.includes('pages_show_list')
    };
}

async function userHasAppRole(userId, fetchFn) {
    const appToken = appAccessToken();
    if (!appToken || !userId || !FB_APP_ID) {
        return { ok: false, error: 'missing app configuration' };
    }
    const res = await fetchFn(graphUrl(`/${FB_APP_ID}/roles`, appToken));
    const body = await res.json();
    if (body.error) {
        return { ok: false, error: body.error.message || 'Could not load app roles' };
    }
    const roleIds = new Set();
    for (const row of body.data || []) {
        for (const u of row.users?.data || []) {
            if (u.id) roleIds.add(String(u.id));
        }
    }
    return {
        ok: true,
        hasRole: roleIds.has(String(userId)),
        roleUserCount: roleIds.size
    };
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

async function buildMetaReviewReport(accessToken, fetchFn) {
    const tests = await runMetaReviewTestCalls(accessToken, fetchFn);
    const tokenInfo = await inspectAccessToken(accessToken, fetchFn);
    let role = { ok: false, hasRole: null };
    if (tokenInfo.ok && tokenInfo.userId) {
        role = await userHasAppRole(tokenInfo.userId, fetchFn);
    }

    const testsOk = !!(tests.public_profile?.ok && tests.pages_show_list?.ok);
    const qualified = testsOk && role.ok && role.hasRole === true;

    let dashboardNote = 'After a successful test, Meta may take up to 24 hours to show green Completed.';
    if (role.ok && role.hasRole === false) {
        dashboardNote = 'Your Facebook account is not an App Admin/Developer/Tester. Meta counts API calls from all users but only shows Completed for role accounts. Add this account under App roles, then log in again.';
    } else if (!testsOk) {
        dashboardNote = 'Graph API test calls failed. Reconnect Facebook and run the test again from Settings.';
    } else if (qualified) {
        dashboardNote = 'Tests succeeded for a role account. If Testing still shows only call counts, wait 24h or use Open Graph API Explorer on the Meta Testing page while logged in as this user.';
    }

    return {
        tests,
        tokenInfo,
        role,
        qualified,
        success: testsOk,
        pageCount: tests.pageCount,
        graphVersion: tests.graphVersion,
        dashboardNote,
        nextSteps: [
            'developers.facebook.com → Your App → App roles → add your Facebook account as Admin, Developer, or Tester',
            'Log out of FBCast Pro, then Connect with Facebook using that same account',
            'Settings → Meta App Review → Run review test calls (browser + server)',
            'Meta Dashboard → Review → Testing → wait up to 24 hours for green Completed'
        ]
    };
}

module.exports = {
    FB_GRAPH_BASE,
    FB_GRAPH_VERSION,
    runMetaReviewTestCalls,
    buildMetaReviewReport,
    inspectAccessToken,
    userHasAppRole
};
