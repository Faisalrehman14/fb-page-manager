const env = require('../config/env');

function siteBase() {
    return (env.SITE_URL || env.BASE_URL || '').replace(/\/$/, '');
}

function buildRequiredMetaUrls() {
    const base = siteBase();
    return {
        privacyPolicy: base ? `${base}/privacy` : null,
        terms: base ? `${base}/terms` : null,
        dataDeletion: base ? `${base}/data-deletion` : null,
        oauthRedirect: base ? `${base}/oauth_callback.php` : null
    };
}

function buildFixChecklist(appId) {
    const urls = buildRequiredMetaUrls();
    const host = urls.oauthRedirect
        ? (() => { try { return new URL(urls.oauthRedirect).hostname; } catch { return null; } })()
        : null;

    return [
        {
            id: 'basic_settings',
            title: 'App Settings → Basic (required fields)',
            url: appId ? `https://developers.facebook.com/apps/${appId}/settings/basic/` : null,
            fields: [
                { label: 'Privacy Policy URL', value: urls.privacyPolicy, required: true },
                { label: 'Terms of Service URL', value: urls.terms, required: false },
                { label: 'User data deletion', value: urls.dataDeletion, required: true },
                { label: 'App Domains', value: host, required: true },
                { label: 'Valid contact email', value: env.CONTACT_EMAIL || '(set CONTACT_EMAIL in Railway)', required: true }
            ]
        },
        {
            id: 'data_use_checkup',
            title: 'Data Use Checkup (fixes “updating additional details”)',
            url: appId ? `https://developers.facebook.com/apps/${appId}/app-review/` : null,
            fields: [
                { label: 'Action', value: 'Open app dashboard → complete red “Data Use Checkup” banner → Submit', required: true }
            ]
        },
        {
            id: 'app_roles',
            title: 'App roles (Development mode)',
            url: appId ? `https://developers.facebook.com/apps/${appId}/roles/roles/` : null,
            fields: [
                { label: 'Action', value: 'Add your Facebook account as Administrator, Developer, or Tester', required: true }
            ]
        },
        {
            id: 'business_config',
            title: 'Business Login configuration',
            url: appId ? `https://developers.facebook.com/apps/${appId}/business-login/configurations/` : null,
            fields: [
                { label: 'Configuration ID', value: env.FB_LOGIN_CONFIG_ID || '(set FB_LOGIN_CONFIG_ID)', required: true },
                { label: 'Token type', value: 'User access token (not System User)', required: true }
            ]
        }
    ];
}

async function probeUrl(url, fetchFn) {
    if (!url) return { url, ok: false, status: null };
    try {
        const res = await fetchFn(url, { method: 'GET', redirect: 'follow' });
        return { url, ok: res.ok, status: res.status };
    } catch (err) {
        return { url, ok: false, status: null, error: err.message };
    }
}

async function getMetaOAuthDiagnostics(fetchFn = global.fetch) {
    const appId = env.FB_APP_ID;
    const issues = [];
    const urls = buildRequiredMetaUrls();

    if (!appId) issues.push('FB_APP_ID is not set on the server');
    if (!env.FB_APP_SECRET) issues.push('FB_APP_SECRET is not set on the server');
    if (!siteBase()) issues.push('SITE_URL / BASE_URL is not set — OAuth redirect will be wrong');

    const [privacyProbe, deletionProbe] = await Promise.all([
        probeUrl(urls.privacyPolicy, fetchFn),
        probeUrl(urls.dataDeletion, fetchFn)
    ]);

    if (urls.privacyPolicy && !privacyProbe.ok) {
        issues.push(`Privacy page not reachable: ${urls.privacyPolicy}`);
    }
    if (urls.dataDeletion && !deletionProbe.ok) {
        issues.push(`Data deletion page not reachable: ${urls.dataDeletion}`);
    }

    let graphApp = null;
    const token = appId && env.FB_APP_SECRET ? `${appId}|${env.FB_APP_SECRET}` : null;
    if (token && appId) {
        try {
            const gv = env.FB_GRAPH_VERSION || 'v21.0';
            const res = await fetchFn(
                `https://graph.facebook.com/${gv}/${appId}?fields=id,link,app_domains&access_token=${encodeURIComponent(token)}`
            );
            graphApp = await res.json();
            if (graphApp?.error) {
                issues.push(`Meta Graph API: ${graphApp.error.message}`);
            }
        } catch (err) {
            issues.push(`Meta Graph API unreachable: ${err.message}`);
        }
    }

    return {
        rootCause: 'facebook_login_blocked_by_meta',
        summary: 'Facebook shows “updating additional details” when Meta app compliance is incomplete. FBCast OAuth URL is correct; complete the Meta checklist below.',
        serverConfigured: !!(appId && env.FB_APP_SECRET && env.FB_LOGIN_CONFIG_ID && siteBase()),
        configIdSet: !!env.FB_LOGIN_CONFIG_ID,
        requiredUrls: urls,
        urlProbes: { privacy: privacyProbe, dataDeletion: deletionProbe },
        checklist: buildFixChecklist(appId),
        serverIssues: issues,
        graphApp: graphApp?.error ? { error: graphApp.error } : graphApp,
        metaDashboard: appId ? `https://developers.facebook.com/apps/${appId}/dashboard/` : null
    };
}

module.exports = {
    getMetaOAuthDiagnostics,
    buildRequiredMetaUrls,
    buildFixChecklist
};
