/**
 * Resolve Facebook profile names for app users (admin backfill + login).
 */

async function fetchNameWithToken(fbUserId, accessToken) {
    if (!fbUserId || !accessToken) return null;
    try {
        const url = `https://graph.facebook.com/v19.0/${encodeURIComponent(fbUserId)}?fields=name&access_token=${encodeURIComponent(accessToken)}`;
        const res = await fetch(url);
        const data = await res.json();
        if (data.error || !data.name) return null;
        return String(data.name).trim();
    } catch {
        return null;
    }
}

async function getAppAccessToken() {
    const appId = (process.env.FB_APP_ID || '').trim();
    const appSecret = (process.env.FB_APP_SECRET || '').trim();
    if (!appId || !appSecret) return null;
    return `${appId}|${appSecret}`;
}

async function getAnyPageAccessToken(pool) {
    if (!pool) return null;
    try {
        const [rows] = await pool.query(
            'SELECT access_token FROM messenger_pages WHERE access_token IS NOT NULL AND access_token != "" LIMIT 1'
        );
        return rows[0]?.access_token || null;
    } catch {
        return null;
    }
}

/**
 * Try user token, app token, then a page token.
 */
async function resolveFacebookUserName(fbUserId, { userAccessToken, pool } = {}) {
    if (!fbUserId) return null;

    if (userAccessToken) {
        const n = await fetchNameWithToken(fbUserId, userAccessToken);
        if (n) return n;
    }

    const appToken = await getAppAccessToken();
    if (appToken) {
        const n = await fetchNameWithToken(fbUserId, appToken);
        if (n) return n;
    }

    const pageToken = await getAnyPageAccessToken(pool);
    if (pageToken) {
        const n = await fetchNameWithToken(fbUserId, pageToken);
        if (n) return n;
    }

    return null;
}

async function enrichUsersWithFacebookNames(db, users, { maxLookups = 25 } = {}) {
    if (!users?.length || !db?.pool) return users;

    let lookups = 0;
    for (const u of users) {
        if (lookups >= maxLookups) break;
        if (String(u.fb_name || '').trim()) continue;

        lookups++;
        const name = await resolveFacebookUserName(u.fb_user_id, {
            userAccessToken: u.fb_access_token || null,
            pool: db.pool
        });
        if (name) {
            u.fb_name = name;
            await db.upsertUserFacebookName(u.fb_user_id, name);
        }
        await new Promise(r => setTimeout(r, 40));
    }
    return users;
}

async function backfillMissingFacebookNames(db, limit = 80) {
    if (!db?.pool) return { updated: 0, tried: 0 };
    const [rows] = await db.pool.query(
        `SELECT fb_user_id, fb_access_token FROM users
         WHERE fb_name IS NULL OR TRIM(fb_name) = ''
         ORDER BY created_at DESC
         LIMIT ?`,
        [Math.min(limit, 200)]
    );

    let updated = 0;
    for (const row of rows) {
        const name = await resolveFacebookUserName(row.fb_user_id, {
            userAccessToken: row.fb_access_token,
            pool: db.pool
        });
        if (name) {
            await db.upsertUserFacebookName(row.fb_user_id, name);
            updated++;
        }
        await new Promise(r => setTimeout(r, 40));
    }
    return { updated, tried: rows.length };
}

module.exports = {
    resolveFacebookUserName,
    enrichUsersWithFacebookNames,
    backfillMissingFacebookNames
};
