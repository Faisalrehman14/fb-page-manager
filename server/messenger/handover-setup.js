const { FB_GRAPH_BASE, FB_PAGE_INBOX_APP_ID, FB_CASTME_APP_ID } = require('./config');

/**
 * Verify Page Inbox is a secondary receiver for handover / conversation routing.
 * Without this, pass_thread_control to 263902037430900 fails silently in production.
 */
async function verifyPageHandoverReceivers(pageId, pageToken, fetchFn) {
    if (!pageId || !pageToken) return { ok: false, reason: 'missing_page_or_token' };
    const fetch = fetchFn || global.fetch;
    try {
        const url = `${FB_GRAPH_BASE}/${pageId}/secondary_receivers?platform=messenger&access_token=${encodeURIComponent(pageToken)}`;
        const r = await fetch(url);
        const data = await r.json();
        if (data.error) {
            return { ok: false, reason: 'api_error', error: data.error.message || JSON.stringify(data.error) };
        }
        const receivers = (data.data || []).map(row => String(row.id || row.app_id || ''));
        const hasInbox = receivers.includes(String(FB_PAGE_INBOX_APP_ID));
        return {
            ok: hasInbox,
            hasInbox,
            receivers,
            pageInboxAppId: FB_PAGE_INBOX_APP_ID
        };
    } catch (err) {
        return { ok: false, reason: 'network', error: err.message || String(err) };
    }
}

/**
 * Best-effort: take thread control so FBCast can send (castme = handover primary for OAuth pages).
 */
async function primeCastmeThreadForSend(pageId, pageToken, psid, fetchFn) {
    if (!pageId || !pageToken || !psid) return { ok: false, reason: 'missing' };
    const fetch = fetchFn || global.fetch;
    const recipient = encodeURIComponent(JSON.stringify({ id: String(psid) }));
    const url = `${FB_GRAPH_BASE}/${pageId}/take_thread_control` +
        `?recipient=${recipient}` +
        `&metadata=${encodeURIComponent('FBCast Pro')}` +
        `&access_token=${encodeURIComponent(pageToken)}`;
    try {
        const r = await fetch(url, { method: 'POST' });
        const data = await r.json();
        if (data.error) {
            return { ok: false, error: data.error.message || JSON.stringify(data.error) };
        }
        return { ok: data.success !== false, castmeAppId: FB_CASTME_APP_ID };
    } catch (err) {
        return { ok: false, error: err.message || String(err) };
    }
}

/**
 * Take/request thread control so FBCast (castme) can send when Page Inbox owned the thread.
 * Call on incoming webhooks and immediately before outbound send.
 */
async function ensureCastmeThreadControl(pageId, pageToken, psid, fetchFn) {
    if (!pageId || !pageToken || !psid) return { ok: false, reason: 'missing' };
    const fetch = fetchFn || global.fetch;
    const castmeId = String(FB_CASTME_APP_ID);
    const attempts = [
        () => primeCastmeThreadForSend(pageId, pageToken, psid, fetch),
        async () => {
            const recipient = encodeURIComponent(JSON.stringify({ id: String(psid) }));
            const url = `${FB_GRAPH_BASE}/${pageId}/request_thread_control` +
                `?recipient=${recipient}` +
                `&metadata=${encodeURIComponent('FBCast Pro')}` +
                `&access_token=${encodeURIComponent(pageToken)}`;
            const r = await fetch(url, { method: 'POST' });
            const data = await r.json();
            if (data.error) return { ok: false, error: data.error.message };
            return { ok: data.success !== false };
        }
    ];
    let lastErr = null;
    for (const run of attempts) {
        try {
            const r = await run();
            if (r?.ok) return { ok: true, castmeAppId: castmeId };
            lastErr = r?.error || 'take/request failed';
        } catch (err) {
            lastErr = err.message || String(err);
        }
    }
    return { ok: false, error: lastErr, castmeAppId: castmeId };
}

module.exports = {
    verifyPageHandoverReceivers,
    primeCastmeThreadForSend,
    ensureCastmeThreadControl
};
