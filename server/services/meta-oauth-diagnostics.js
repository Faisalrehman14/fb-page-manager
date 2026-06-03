const env = require('../config/env');

function siteBase() {
    return (env.SITE_URL || env.BASE_URL || '').replace(/\/$/, '');
}

function currentHost() {
    const base = siteBase();
    if (!base) return null;
    try {
        return new URL(base).hostname;
    } catch {
        return null;
    }
}

function normalizeDomain(d) {
    return String(d || '').replace(/^https?:\/\//, '').replace(/\/$/, '').toLowerCase();
}

function buildRequiredMetaUrls() {
    const base = siteBase();
    return {
        privacyPolicy: base ? `${base}/privacy` : null,
        terms: base ? `${base}/terms` : null,
        dataDeletion: base ? `${base}/data-deletion` : null,
        oauthRedirect: base ? `${base}/oauth_callback.php` : null,
        siteUrl: base || null
    };
}

function buildFixChecklist(appId, metaIssues = []) {
    const urls = buildRequiredMetaUrls();
    const host = currentHost();

    const steps = [
        {
            id: 'basic_settings',
            priority: 1,
            title: 'Settings → Basic — URLs must match Railway',
            url: appId ? `https://developers.facebook.com/apps/${appId}/settings/basic/` : null,
            fields: [
                { label: 'Site URL / App URL', value: urls.siteUrl, required: true },
                { label: 'App Domains (no trailing /)', value: host, required: true },
                { label: 'Privacy Policy URL', value: urls.privacyPolicy, required: true },
                { label: 'User data deletion', value: urls.dataDeletion, required: true },
                { label: 'Contact email', value: env.CONTACT_EMAIL || 'SET CONTACT_EMAIL in Railway', required: true }
            ]
        },
        {
            id: 'data_use_checkup',
            priority: 2,
            title: 'Data Use Checkup — main fix for “updating additional details”',
            url: appId ? `https://developers.facebook.com/apps/${appId}/app-review/` : null,
            fields: [
                { label: 'Action', value: 'Dashboard red banner → Start checkup → Submit all steps', required: true }
            ]
        },
        {
            id: 'app_roles',
            priority: 3,
            title: 'App roles — required in Development mode',
            url: appId ? `https://developers.facebook.com/apps/${appId}/roles/roles/` : null,
            fields: [
                { label: 'Action', value: 'Add the Facebook account you use to log in as Administrator or Tester', required: true }
            ]
        },
        {
            id: 'advanced_restrictions',
            priority: 4,
            title: 'Advanced → App restrictions',
            url: appId ? `https://developers.facebook.com/apps/${appId}/settings/advanced/` : null,
            fields: [
                { label: 'Age restriction', value: 'None / 13+ (not 18+ unless needed)', required: false },
                { label: 'Country', value: 'No country block (or add your country)', required: false },
                { label: 'Reference alcohol', value: 'Must be OFF unless app is alcohol-related', required: false }
            ]
        },
        {
            id: 'oauth_redirects',
            priority: 5,
            title: 'Facebook Login → Valid OAuth Redirect URIs',
            url: appId ? `https://developers.facebook.com/apps/${appId}/business-login/settings/` : null,
            fields: [
                { label: 'Redirect URI', value: urls.oauthRedirect, required: true }
            ]
        }
    ];

    if (metaIssues.length) {
        steps.unshift({
            id: 'meta_mismatch',
            priority: 0,
            title: 'Fix Meta app URL mismatch (likely why login stopped)',
            url: appId ? `https://developers.facebook.com/apps/${appId}/settings/basic/` : null,
            fields: metaIssues.map((msg) => ({ label: 'Issue', value: msg, required: true }))
        });
    }

    return steps;
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

async function fetchMetaAppInfo(appId, fetchFn) {
    const token = appId && env.FB_APP_SECRET ? `${appId}|${env.FB_APP_SECRET}` : null;
    if (!token) return { error: 'missing credentials' };

    const gv = env.FB_GRAPH_VERSION || 'v21.0';
    const fields = [
        'id', 'link', 'app_domains', 'restrictions',
        'auth_dialog_headline', 'category'
    ].join(',');
    const res = await fetchFn(
        `https://graph.facebook.com/${gv}/${appId}?fields=${fields}&access_token=${encodeURIComponent(token)}`
    );
    return res.json();
}

function analyzeMetaApp(graphApp, host) {
    const metaIssues = [];
    if (!graphApp || graphApp.error) {
        return {
            metaIssues: graphApp?.error ? [`Graph API: ${graphApp.error.message}`] : ['Could not load app from Meta'],
            domainMatch: null
        };
    }

    let linkHost = null;
    if (graphApp.link) {
        try {
            linkHost = new URL(graphApp.link).hostname;
        } catch {
            linkHost = normalizeDomain(graphApp.link);
        }
    }

    const registeredDomains = (graphApp.app_domains || []).map(normalizeDomain).filter(Boolean);
    const hostNorm = normalizeDomain(host);

    if (linkHost && hostNorm && linkHost !== hostNorm) {
        metaIssues.push(
            `Meta "App link" is still ${linkHost} but your site runs on ${hostNorm}. ` +
            `Update Settings → Basic → Site URL to ${siteBase()} and save.`
        );
    }

    if (hostNorm && registeredDomains.length && !registeredDomains.some((d) => d === hostNorm || d.includes(hostNorm))) {
        metaIssues.push(
            `App Domains in Meta (${registeredDomains.join(', ')}) may not include ${hostNorm}. ` +
            'Add the domain without trailing slash.'
        );
    }

    for (const d of registeredDomains) {
        if (d.endsWith('/')) {
            metaIssues.push(`Remove trailing slash from App Domain: "${d}" → use "${d.replace(/\/$/, '')}"`);
        }
    }

    if (graphApp.restrictions && Object.keys(graphApp.restrictions).length) {
        metaIssues.push(
            `App has demographic restrictions: ${JSON.stringify(graphApp.restrictions)}. ` +
            'Check Settings → Advanced → App Restrictions (age/country/alcohol).'
        );
    }

    const domainMatch = !!(hostNorm && linkHost && linkHost === hostNorm);

    return { metaIssues, domainMatch, linkHost, registeredDomains };
}

async function getMetaOAuthDiagnostics(fetchFn = global.fetch) {
    const appId = env.FB_APP_ID;
    const host = currentHost();
    const issues = [];
    const urls = buildRequiredMetaUrls();

    if (!appId) issues.push('FB_APP_ID is not set on the server');
    if (!env.FB_APP_SECRET) issues.push('FB_APP_SECRET is not set on the server');
    if (!siteBase()) issues.push('SITE_URL / BASE_URL is not set');

    const [privacyProbe, deletionProbe, graphApp] = await Promise.all([
        probeUrl(urls.privacyPolicy, fetchFn),
        probeUrl(urls.dataDeletion, fetchFn),
        appId ? fetchMetaAppInfo(appId, fetchFn) : Promise.resolve(null)
    ]);

    if (urls.privacyPolicy && !privacyProbe.ok) {
        issues.push(`Privacy page not reachable: ${urls.privacyPolicy}`);
    }
    if (urls.dataDeletion && !deletionProbe.ok) {
        issues.push(`Data deletion page not reachable: ${urls.dataDeletion}`);
    }
    if (graphApp?.error) {
        issues.push(`Meta Graph API: ${graphApp.error.message}`);
    }

    const analysis = analyzeMetaApp(graphApp, host);
    const allMetaIssues = [...analysis.metaIssues];

    const loginBlockedReasons = [];
    if (allMetaIssues.length) {
        loginBlockedReasons.push('meta_url_or_domain_mismatch');
    }
    if (!env.CONTACT_EMAIL) {
        loginBlockedReasons.push('missing_contact_email');
    }
    loginBlockedReasons.push('data_use_checkup_or_meta_compliance');

    return {
        rootCause: 'facebook_login_blocked_by_meta',
        canFixInCode: false,
        loginBlockedReasons,
        summary: allMetaIssues.length
            ? 'Facebook login is blocked by Meta. Your server OAuth URL is correct; fix Meta app URL mismatch and complete Data Use Checkup.'
            : 'Server OAuth is correct. Complete Data Use Checkup and App roles on Meta if login still fails.',
        serverConfigured: !!(appId && env.FB_APP_SECRET && siteBase()),
        metaReadyForLogin: allMetaIssues.length === 0 && issues.length === 0 && !!env.CONTACT_EMAIL,
        siteHost: host,
        configIdSet: !!env.FB_LOGIN_CONFIG_ID,
        oauthUsesScopes: true,
        requiredUrls: urls,
        urlProbes: { privacy: privacyProbe, dataDeletion: deletionProbe },
        metaApp: graphApp?.error ? { error: graphApp.error } : {
            id: graphApp?.id,
            link: graphApp?.link,
            linkHost: analysis.linkHost,
            app_domains: graphApp?.app_domains,
            restrictions: graphApp?.restrictions || null,
            domainMatchesSite: analysis.domainMatch
        },
        metaIssues: allMetaIssues,
        checklist: buildFixChecklist(appId, allMetaIssues),
        serverIssues: issues,
        metaDashboard: appId ? `https://developers.facebook.com/apps/${appId}/dashboard/` : null
    };
}

module.exports = {
    getMetaOAuthDiagnostics,
    buildRequiredMetaUrls,
    buildFixChecklist,
    analyzeMetaApp
};
