/**
 * Meta App Review — required Graph API test calls.
 *
 * Meta "Testing" green Completed badge requires:
 * - GET /me (public_profile) and GET /me/accounts (pages_show_list) with appsecret_proof
 * - User access token from YOUR app (with correct app_id)
 * - Facebook account must be App Admin, Developer, or Tester
 * - appsecret_proof = HMAC-SHA256(access_token, app_secret) — required for proper attribution
 * - Dashboard can take up to 24 hours to update
 */
const crypto = require('crypto');
const { FB_GRAPH_VERSION, FB_APP_ID, FB_APP_SECRET } = require('../config/env');

const FB_GRAPH_BASE = `https://graph.facebook.com/${FB_GRAPH_VERSION}`;

function computeAppSecretProof(accessToken) {
    if (!accessToken || !FB_APP_SECRET) return null;
    return crypto.createHmac('sha256', FB_APP_SECRET).update(accessToken).digest('hex');
}

function graphUrl(path, accessToken, includeProof) {
    const sep = path.includes('?') ? '&' : '?';
    let url = `${FB_GRAPH_BASE}${path}${sep}access_token=${encodeURIComponent(accessToken)}`;
    if (includeProof !== false) {
        const proof = computeAppSecretProof(accessToken);
        if (proof) {
            url += `&appsecret_proof=${encodeURIComponent(proof)}`;
        }
    }
    return url;
}

function appAccessToken() {
    if (!FB_APP_ID || !FB_APP_SECRET) return null;
    return `${FB_APP_ID}|${FB_APP_SECRET}`;
}

async function graphGet(path, accessToken, fetchFn, includeProof) {
    const url = graphUrl(path, accessToken, includeProof);
    const res = await fetchFn(url);
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
        hasPagesShowList: scopes.includes('pages_show_list'),
        isAppToken: String(info.app_id) === String(FB_APP_ID)
    };
}

async function userHasAppRole(userId, fetchFn) {
    const appToken = appAccessToken();
    if (!appToken || !userId || !FB_APP_ID) {
        return { ok: false, error: 'missing app configuration' };
    }
    const res = await fetchFn(graphUrl(`/${FB_APP_ID}/roles`, appToken, false));
    const body = await res.json();
    if (body.error) {
        return { ok: false, error: body.error.message || 'Could not load app roles' };
    }
    const roleIds = new Set();
    for (const row of body.data || []) {
        if (row.user) roleIds.add(String(row.user));
        if (row.id) roleIds.add(String(row.id));
        for (const u of row.users?.data || []) {
            if (u.id) roleIds.add(String(u.id));
        }
    }
    return {
        ok: true,
        hasRole: roleIds.has(String(userId)),
        roleUserCount: roleIds.size,
        raw: (body.data || []).map(r => ({ user: r.user || r.id, role: r.role }))
    };
}

/**
 * Run the two permission test calls Meta expects — WITH appsecret_proof.
 * Safe to call on every login.
 */
async function runMetaReviewTestCalls(accessToken, fetchFn) {
    if (!accessToken) {
        return {
            public_profile: { ok: false, error: 'missing access token' },
            pages_show_list: { ok: false, error: 'missing access token' }
        };
    }

    const proof = computeAppSecretProof(accessToken);
    const [public_profile, pages_show_list] = await Promise.all([
        graphGet('/me?fields=id,name', accessToken, fetchFn, true),
        graphGet('/me/accounts?fields=id,name', accessToken, fetchFn, true)
    ]);

    return {
        public_profile,
        pages_show_list,
        pageCount: pages_show_list.ok ? (pages_show_list.data?.data || []).length : 0,
        graphVersion: FB_GRAPH_VERSION,
        appsecretProofSent: !!proof
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
    if (!tokenInfo.ok) {
        dashboardNote = 'Token validation failed. Reconnect Facebook and try again.';
    } else if (tokenInfo.ok && !tokenInfo.isAppToken) {
        dashboardNote = `Token belongs to app ${tokenInfo.appId}, not your app ${FB_APP_ID}. Reconnect Facebook from FBCast Pro.`;
    } else if (role.ok && role.hasRole === false) {
        dashboardNote = 'Your Facebook account is not an App Admin/Developer/Tester. Add this account under App roles in Meta Developer Console, then reconnect.';
    } else if (!testsOk) {
        dashboardNote = 'Graph API test calls failed. Reconnect Facebook and run the test again from Settings.';
    } else if (qualified) {
        dashboardNote = 'Tests succeeded with appsecret_proof for a role account. If Testing still shows call counts only, wait 24h — Meta batches test verification.';
    }

    return {
        tests,
        tokenInfo: {
            ok: tokenInfo.ok,
            userId: tokenInfo.userId,
            type: tokenInfo.type,
            scopes: tokenInfo.scopes,
            isAppToken: tokenInfo.isAppToken,
            hasPublicProfile: tokenInfo.hasPublicProfile,
            hasPagesShowList: tokenInfo.hasPagesShowList
        },
        role,
        qualified,
        success: testsOk,
        pageCount: tests.pageCount,
        graphVersion: tests.graphVersion,
        appsecretProofSent: tests.appsecretProofSent,
        dashboardNote,
        nextSteps: qualified
            ? ['Tests OK — wait up to 24 hours for Meta Testing dashboard to refresh']
            : [
                'developers.facebook.com → Your App → App roles → add your Facebook account as Admin, Developer, or Tester',
                'Log out of FBCast Pro, then Connect with Facebook using that same account',
                'Settings → Meta App Review → Run review test calls (browser + server with appsecret_proof)',
                'Meta Dashboard → Review → Testing → wait up to 24 hours for green Completed'
            ]
    };
}

module.exports = {
    FB_GRAPH_BASE,
    FB_GRAPH_VERSION,
    computeAppSecretProof,
    graphUrl,
    runMetaReviewTestCalls,
    buildMetaReviewReport,
    inspectAccessToken,
    userHasAppRole
};
