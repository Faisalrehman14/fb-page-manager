const { FB_GRAPH_BASE } = require('./config');

/**
 * Resolve page access token: session → DB → refresh from /me/accounts
 */
async function resolvePageToken({ pageId, session, db, dbConnected, fetchFn }) {
    let token = session?.pageTokens?.[pageId] || null;
    if (token) return token;

    if (dbConnected) {
        token = await db.getPageToken(pageId);
        if (token) return token;
    }

    if (!session?.accessToken || !dbConnected) return null;

    try {
        const fbRes = await fetchFn(
            `${FB_GRAPH_BASE}/me/accounts?fields=id,name,picture,access_token&access_token=${session.accessToken}`
        );
        const data = await fbRes.json();
        const pageData = (data.data || []).find(p => p.id === pageId);
        if (!pageData?.access_token) return null;

        const pagesToSave = (data.data || []).map(p => ({
            id: p.id,
            name: p.name,
            picture: p.picture?.data?.url,
            accessToken: p.access_token
        }));
        await db.savePages(pagesToSave);
        return pageData.access_token;
    } catch {
        return null;
    }
}

module.exports = { resolvePageToken };
