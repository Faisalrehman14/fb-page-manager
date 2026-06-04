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
                const fbErr = { code: err.fbCode, message: err.message, error_subcode: err.fbSubcode };
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

    static _isThreadLockError(err) {
        const code = err?.fbCode ?? err?.code;
        const msg = (err?.message || '').toLowerCase();
        return code === 10 && (msg.includes('controlling') || msg.includes('another app'));
    }

    async _postMessage(pageToken, psid, messageObj, useUtility, pageId) {
        const body = {
            recipient: { id: String(psid) },
            message: messageObj
        };
        if (useUtility) {
            body.messaging_type = 'UTILITY';
        } else {
            body.messaging_product = 'facebook';
        }

        const urls = [this._pageMessagesUrl(pageId, pageToken)];
        urls.push(`${FB_GRAPH_BASE}/me/messages?access_token=${encodeURIComponent(pageToken)}`);

        let lastErr;
        for (const url of urls) {
            try {
                const data = await this._postJson(url, body);
                const mid = this._extractMessageId(data);
                if (!mid) throw new FbApiError({ message: 'No message_id in response', code: 0 });
                return { ...data, message_id: mid };
            } catch (err) {
                lastErr = err;
            }
        }
        throw lastErr;
    }

    /** Same transport as manual broadcast (form POST + UTILITY) — works when JSON send is blocked. */
    async _postMessageBroadcastUtility(pageToken, psid, messageObj, pageId) {
        const form = new URLSearchParams();
        form.append('recipient', JSON.stringify({ id: String(psid) }));
        form.append('message', JSON.stringify(messageObj));
        form.append('messaging_type', 'UTILITY');
        const url = `${FB_GRAPH_BASE}/${pageId}/messages?access_token=${encodeURIComponent(pageToken)}`;
        const r = await this._fetchWithTimeout(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: form.toString()
        });
        const data = await r.json();
        if (data.error) throw new FbApiError(data.error);
        const mid = this._extractMessageId(data);
        if (!mid) throw new FbApiError({ message: 'No message_id in response', code: 0 });
        return { ...data, message_id: mid };
    }

    async _sendOutsideWindowFallbacks(pageToken, psid, messageObj, pageId) {
        let lastErr;
        const attempts = [
            () => this._postMessage(pageToken, psid, messageObj, true, pageId),
            () => this._postMessageBroadcastUtility(pageToken, psid, messageObj, pageId)
        ];
        for (const attempt of attempts) {
            try {
                return await attempt();
            } catch (err) {
                lastErr = err;
            }
        }
        throw lastErr;
    }

    async _takeThreadQuiet(pageId, pageToken, psid) {
        const recipient = encodeURIComponent(JSON.stringify({ id: String(psid) }));
        const url = `${FB_GRAPH_BASE}/${pageId}/take_thread_control` +
            `?recipient=${recipient}&access_token=${encodeURIComponent(pageToken)}`;
        try {
            const r = await this._fetchWithTimeout(url, { method: 'POST' });
            await r.json();
        } catch (_) { /* optional */ }
    }

    async send(pageToken, psid, messageObj, useUtility = false, pageId = null) {
        if (!pageId) throw new FbApiError({ message: 'page_id required', code: 100 });
        try {
            return await this._postMessage(pageToken, psid, messageObj, useUtility, pageId);
        } catch (err) {
            if (FacebookClient._isThreadLockError(err)) {
                await this._takeThreadQuiet(pageId, pageToken, psid);
                try {
                    return await this._postMessage(pageToken, psid, messageObj, useUtility, pageId);
                } catch (retryErr) {
                    err = retryErr;
                }
            }
            if (FacebookClient.isOutside24hWindow(err)) {
                if (!useUtility) {
                    return await this._sendOutsideWindowFallbacks(pageToken, psid, messageObj, pageId);
                }
                try {
                    return await this._postMessageBroadcastUtility(pageToken, psid, messageObj, pageId);
                } catch (broadcastErr) {
                    err = broadcastErr;
                }
            }
            if (FacebookClient._isThreadLockError(err)) {
                throw new FbApiError({ message: 'Send failed', code: 10 });
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
        const sub = fbError.error_subcode ?? fbError.fbSubcode;
        const msg = (fbError.message || '').toLowerCase();
        if (code === 10 && (msg.includes('permission') || msg.includes('does not have'))) return false;
        if (code === 10 && (msg.includes('controlling') || msg.includes('another app'))) return false;
        if (code === 551) return true;
        if (sub === 2018065 || sub === 2018278) return true;
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
        if (FacebookClient._isThreadLockError(fbError)) return 'Send failed';
        const msg = fbError.message || String(fbError);
        const code = fbError.code ?? fbError.fbCode;
        const lower = msg.toLowerCase();

        if (FacebookClient.isOutside24hWindow(fbError)) {
            return 'Could not send — Meta blocked delivery (24-hour window or policy). Ask the customer to message your page, or use Broadcast for bulk outreach.';
        }
        if (code === 190 || lower.includes('access token')) {
            return 'Session expired. Reconnect Facebook in Settings.';
        }
        if (lower.includes('controlling') || lower.includes('another app')) return 'Send failed';
        return msg.replace(/^\(#\d+\)\s*/i, '').trim() || 'Send failed';
    }

    async uploadReusableImageAttachment(pageToken, pageId, fileBuffer, mime, filename = 'image.jpg') {
        const form = new FormData();
        form.append('message', JSON.stringify({
            attachment: { type: 'image', payload: { is_reusable: true } }
        }));
        form.append('filedata', new Blob([fileBuffer], { type: mime }), filename);
        const url = `${FB_GRAPH_BASE}/${pageId}/message_attachments?access_token=${encodeURIComponent(pageToken)}`;
        const r = await this._fetchWithTimeout(url, { method: 'POST', body: form });
        const data = await r.json();
        if (data.error) throw new FbApiError(data.error);
        const attachmentId = data.attachment_id;
        if (!attachmentId) {
            throw new FbApiError({ message: 'No attachment_id in upload response', code: 0 });
        }
        return attachmentId;
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
