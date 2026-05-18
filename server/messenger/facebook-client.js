const {
    FB_GRAPH_BASE,
    retentionCutoffUnix,
    isWithinRetention
} = require('./config');
const { graphMessageAttachments, normalizeMessengerMessage, FB_MESSAGE_ATTACHMENT_FIELDS } = require('./message-content');

const FB_TIMEOUT_MS = 12_000;

class FbApiError extends Error {
    constructor(fbError) {
        super(fbError.message);
        this.name = 'FbApiError';
        this.fbCode = fbError.code;
        this.fbType = fbError.type;
        this.fbSubcode = fbError.error_subcode;
    }
}

class FacebookClient {
    constructor(fetchFn) {
        this.fetch = fetchFn || global.fetch;
    }

    _fetchWithTimeout(url, options = {}) {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), FB_TIMEOUT_MS);
        return this.fetch(url, { ...options, signal: ctrl.signal })
            .finally(() => clearTimeout(timer));
    }

    async getJson(url) {
        const response = await this._fetchWithTimeout(url);
        const data = await response.json();
        if (data.error) throw new FbApiError(data.error);
        return data;
    }

    conversationsUrl(pageId, pageToken, sinceUnix = null) {
        const sinceParam = sinceUnix ? `&since=${sinceUnix}` : '';
        return `${FB_GRAPH_BASE}/${pageId}/conversations` +
            `?fields=id,participants,snippet,updated_time,unread_count,can_reply` +
            `&limit=200${sinceParam}&access_token=${pageToken}`;
    }

    lookupConversationByUser(pageId, psid, pageToken) {
        return `${FB_GRAPH_BASE}/${pageId}/conversations` +
            `?user_id=${encodeURIComponent(psid)}&fields=id&limit=1&access_token=${pageToken}`;
    }

    messagesUrl(fbConvId, pageToken, { limit = 50, sinceUnix = null, untilUnix = null } = {}) {
        const since = sinceUnix ?? retentionCutoffUnix();
        let url = `${FB_GRAPH_BASE}/${fbConvId}/messages` +
            `?fields=id,message,from,created_time,sticker,${FB_MESSAGE_ATTACHMENT_FIELDS}` +
            `&limit=${limit}&since=${since}&access_token=${pageToken}`;
        if (untilUnix) url += `&until=${untilUnix}`;
        return url;
    }

    async fetchMessages(fbConvId, pageId, pageToken, { limit = 50, before = null } = {}) {
        const opts = { limit };
        if (before) {
            opts.untilUnix = Math.floor(new Date(before).getTime() / 1000);
        }
        const data = await this.getJson(this.messagesUrl(fbConvId, pageToken, {
            limit,
            sinceUnix: retentionCutoffUnix(),
            untilUnix: opts.untilUnix
        }));
        return (data.data || [])
            .filter(m => isWithinRetention(m.created_time))
            .reverse()
            .map(m => normalizeMessengerMessage({
                message_id: m.id,
                message: m.message || '',
                from_me: m.from?.id === pageId ? 1 : 0,
                created_at: m.created_time,
                attachments: graphMessageAttachments(m)
            }));
    }

    async sendThumbsUp(pageToken, psid, useUtility = false) {
        let data = await this.send(pageToken, psid, {
            attachment: { type: 'like' }
        }, useUtility);
        if (!data.error) return data;
        data = await this.send(pageToken, psid, { text: '👍' }, useUtility);
        if (data.error) throw new FbApiError(data.error);
        return data;
    }

    async sendThumbsUpWithRetry(pageToken, psid) {
        let lastErr;
        for (const useUtility of [false, true]) {
            try {
                return await this.sendThumbsUp(pageToken, psid, useUtility);
            } catch (err) {
                lastErr = err;
                const fbErr = { code: err.fbCode, message: err.message };
                if (!FacebookClient.isOutside24hWindow(fbErr)) throw err;
            }
        }
        throw lastErr;
    }

    async send(pageToken, psid, messageObj, useUtility = false) {
        const url = `${FB_GRAPH_BASE}/me/messages?access_token=${pageToken}`;
        const body = { recipient: { id: psid }, message: messageObj };
        if (useUtility) body.messaging_type = 'UTILITY';
        const formBody = new URLSearchParams();
        for (const [k, v] of Object.entries(body)) {
            formBody.append(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
        }
        const r = await this._fetchWithTimeout(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: formBody.toString()
        });
        return r.json();
    }

    /** Tell Meta the page has seen the customer's messages (Business Suite read state). */
    async markSeen(pageToken, psid) {
        const url = `${FB_GRAPH_BASE}/me/messages?access_token=${pageToken}`;
        const formBody = new URLSearchParams();
        formBody.append('recipient', JSON.stringify({ id: String(psid) }));
        formBody.append('sender_action', 'mark_seen');
        const r = await this._fetchWithTimeout(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: formBody.toString()
        });
        const data = await r.json();
        if (data.error) throw new FbApiError(data.error);
        return data;
    }

    async markSeenWithRetry(pageToken, psid) {
        let lastErr;
        for (let i = 0; i <= 2; i++) {
            if (i > 0) await new Promise(r => setTimeout(r, 300 * i));
            try {
                return await this.markSeen(pageToken, psid);
            } catch (err) {
                lastErr = err;
                if (!FacebookClient.isTransient(err)) throw err;
            }
        }
        throw lastErr;
    }

    static isOutside24hWindow(fbError) {
        if (!fbError) return false;
        const code = fbError.code ?? fbError.fbCode;
        const msg = (fbError.message || '').toLowerCase();
        if (code === 10 && (msg.includes('permission') || msg.includes('does not have'))) return false;
        return code === 10 || code === 551 ||
            msg.includes('outside of allowed window') ||
            msg.includes('24 hour') ||
            msg.includes('messaging window');
    }

    static formatSendError(fbError) {
        if (!fbError) return 'Message could not be sent';
        const msg = fbError.message || String(fbError);
        const code = fbError.code ?? fbError.fbCode;
        const lower = msg.toLowerCase();
        if (FacebookClient.isOutside24hWindow(fbError)) {
            return 'Cannot send: the 24-hour reply window has ended. Ask the customer to message your page first, then try again.';
        }
        if (code === 10 && (lower.includes('permission') || lower.includes('does not have'))) {
            return 'Facebook permission error (#10). Reconnect your page in Settings and allow messaging.';
        }
        if (code === 190 || lower.includes('access token')) {
            return 'Page session expired. Refresh the page or reconnect Facebook.';
        }
        return msg.replace(/^\(#\d+\)\s*/i, '').trim() || `Facebook error (#${code || '?'})`;
    }

    async sendAttachment(pageToken, psid, fileBuffer, mime, filename, useUtility = false) {
        const attachType = mime.startsWith('image/') ? 'image'
            : mime.startsWith('video/') ? 'video' : 'file';
        const form = new FormData();
        form.append('recipient', JSON.stringify({ id: psid }));
        form.append('message', JSON.stringify({
            attachment: { type: attachType, payload: { is_reusable: false } }
        }));
        if (useUtility) form.append('messaging_type', 'UTILITY');
        form.append('filedata', new Blob([fileBuffer], { type: mime }), filename || 'upload');
        const url = `${FB_GRAPH_BASE}/me/messages?access_token=${pageToken}`;
        const r = await this._fetchWithTimeout(url, { method: 'POST', body: form });
        return r.json();
    }

    async sendAttachmentWithRetry(pageToken, psid, fileBuffer, mime, filename) {
        let data = await this.sendAttachment(pageToken, psid, fileBuffer, mime, filename, false);
        if (data.error && FacebookClient.isOutside24hWindow(data.error)) {
            data = await this.sendAttachment(pageToken, psid, fileBuffer, mime, filename, true);
        }
        if (data.error) throw new FbApiError(data.error);
        return data;
    }

    // FB platform-level rate limit codes
    static isRateLimited(fbError) {
        if (!fbError) return false;
        const code = fbError.code ?? fbError.fbCode;
        return code === 4 || code === 17 || code === 32 || code === 613;
    }

    // Network/transport errors that are safe to retry
    static isTransient(err) {
        if (!err) return false;
        const msg = (err.message || '').toLowerCase();
        return err.name === 'AbortError' ||
            msg.includes('econnreset') ||
            msg.includes('econnrefused') ||
            msg.includes('network') ||
            msg.includes('timeout') ||
            msg.includes('failed to fetch');
    }
}

module.exports = { FacebookClient, FbApiError };
