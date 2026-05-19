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
            `?user_id=${encodeURIComponent(psid)}` +
            `&fields=id,unread_count,updated_time&limit=1&access_token=${pageToken}`;
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

    async sendThumbsUp(pageToken, psid, useUtility = false, pageId = null) {
        try {
            return await this.send(pageToken, psid, { attachment: { type: 'like' } }, useUtility, pageId);
        } catch (_) {
            return await this.send(pageToken, psid, { text: '👍' }, useUtility, pageId);
        }
    }

    async sendThumbsUpWithRetry(pageToken, psid, pageId = null) {
        let lastErr;
        for (const useUtility of [false, true]) {
            try {
                return await this.sendThumbsUp(pageToken, psid, useUtility, pageId);
            } catch (err) {
                lastErr = err;
                const fbErr = { code: err.fbCode, message: err.message };
                if (!FacebookClient.isOutside24hWindow(fbErr)) throw err;
            }
        }
        throw lastErr;
    }

    _pageMessagesUrl(pageId, pageToken) {
        if (!pageId) throw new FbApiError({ message: 'page_id required', code: 100 });
        return `${FB_GRAPH_BASE}/${pageId}/messages?access_token=${encodeURIComponent(pageToken)}`;
    }

    async _postJson(url, body) {
        const r = await this._fetchWithTimeout(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });
        const data = await r.json();
        if (data.error) throw new FbApiError(data.error);
        return data;
    }

    _extractMessageId(data) {
        if (!data || data.error) return null;
        return data.message_id || data.messageId || data.id || null;
    }

    /** POST /{page-id}/messages — page Graph API only (no me/messages). */
    async send(pageToken, psid, messageObj, useUtility = false, pageId = null) {
        if (!pageId) throw new FbApiError({ message: 'page_id required', code: 100 });
        const body = {
            recipient: { id: String(psid) },
            message: messageObj
        };
        if (useUtility) body.messaging_type = 'UTILITY';

        const url = this._pageMessagesUrl(pageId, pageToken);
        try {
            const data = await this._postJson(url, body);
            const mid = this._extractMessageId(data);
            if (!mid) throw new FbApiError({ message: 'No message_id in response', code: 0 });
            return { ...data, message_id: mid };
        } catch (err) {
            if (!useUtility && FacebookClient.isOutside24hWindow(err)) {
                return this.send(pageToken, psid, messageObj, true, pageId);
            }
            throw err;
        }
    }

    async markSeen(pageToken, psid, pageId) {
        const url = this._pageMessagesUrl(pageId, pageToken);
        return this._postJson(url, {
            recipient: { id: String(psid) },
            sender_action: 'mark_seen'
        });
    }

    async markSeenWithRetry(pageToken, psid, pageId) {
        let lastErr;
        for (let i = 0; i <= 2; i++) {
            if (i > 0) await new Promise((r) => setTimeout(r, 400 * i));
            try {
                await this.markSeen(pageToken, psid, pageId);
                return { metaMarked: true };
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
        if (code === 10 && (msg.includes('controlling') || msg.includes('another app'))) return false;
        if (code === 551) return true;
        if (msg.includes('outside of allowed window') || msg.includes('24 hour') || msg.includes('messaging window')) {
            return true;
        }
        if (code === 10 && (msg.includes('window') || msg.includes('allowed window') || msg.includes('cannot message'))) {
            return true;
        }
        return false;
    }

    static formatSendError(fbError) {
        if (!fbError) return 'Send failed';
        const msg = fbError.message || String(fbError);
        const code = fbError.code ?? fbError.fbCode;
        const lower = msg.toLowerCase();

        if (FacebookClient.isOutside24hWindow(fbError)) {
            return 'Cannot send: 24-hour window ended. Customer must message your page first.';
        }
        if (code === 190 || lower.includes('access token')) {
            return 'Session expired. Reconnect Facebook in Settings.';
        }
        return msg.replace(/^\(#\d+\)\s*/i, '').trim() || 'Send failed';
    }

    async sendAttachment(pageToken, psid, pageId, fileBuffer, mime, filename, useUtility = false) {
        const attachType = mime.startsWith('image/') ? 'image'
            : mime.startsWith('video/') ? 'video' : 'file';
        const form = new FormData();
        form.append('recipient', JSON.stringify({ id: psid }));
        form.append('message', JSON.stringify({
            attachment: { type: attachType, payload: { is_reusable: false } }
        }));
        if (useUtility) form.append('messaging_type', 'UTILITY');
        form.append('filedata', new Blob([fileBuffer], { type: mime }), filename || 'upload');
        const url = this._pageMessagesUrl(pageId, pageToken);
        const r = await this._fetchWithTimeout(url, { method: 'POST', body: form });
        return r.json();
    }

    async sendAttachmentWithRetry(pageToken, psid, pageId, fileBuffer, mime, filename) {
        let data = await this.sendAttachment(pageToken, psid, pageId, fileBuffer, mime, filename, false);
        if (data.error && FacebookClient.isOutside24hWindow(data.error)) {
            data = await this.sendAttachment(pageToken, psid, pageId, fileBuffer, mime, filename, true);
        }
        if (data.error) throw new FbApiError(data.error);
        return data;
    }

    static isRateLimited(fbError) {
        if (!fbError) return false;
        const code = fbError.code ?? fbError.fbCode;
        return code === 4 || code === 17 || code === 32 || code === 613;
    }

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
