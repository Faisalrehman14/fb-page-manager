const {
    FB_GRAPH_BASE,
    retentionCutoffUnix,
    isWithinRetention,
    FB_PAGE_INBOX_APP_ID,
    FB_CASTME_APP_ID,
    FB_HANDOVER_ENABLED
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
        const passOpts = { passToPageInbox: true };
        let data = await this.send(pageToken, psid, {
            attachment: { type: 'like' }
        }, useUtility, pageId, passOpts);
        if (!data.error) return data;
        data = await this.send(pageToken, psid, { text: '👍' }, useUtility, pageId, passOpts);
        if (data.error) throw new FbApiError(data.error);
        return data;
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

    _messagesUrl(pageId, pageToken) {
        const pid = pageId ? String(pageId) : null;
        const base = pid ? `${FB_GRAPH_BASE}/${pid}/messages` : `${FB_GRAPH_BASE}/me/messages`;
        return `${base}?access_token=${encodeURIComponent(pageToken)}`;
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

    async _sendLegacyForm(pageToken, psid, messageObj, useUtility = false, pageId = null) {
        const payload = { recipient: { id: String(psid) }, message: messageObj };
        if (useUtility) payload.messaging_type = 'UTILITY';

        const endpoints = [];
        if (pageId) {
            endpoints.push(`${FB_GRAPH_BASE}/${pageId}/messages?access_token=${encodeURIComponent(pageToken)}`);
        }
        endpoints.push(`${FB_GRAPH_BASE}/me/messages?access_token=${encodeURIComponent(pageToken)}`);

        let lastErr;
        for (const formUrl of endpoints) {
            const formBody = new URLSearchParams();
            for (const [k, v] of Object.entries(payload)) {
                formBody.append(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
            }
            try {
                const r = await this._fetchWithTimeout(formUrl, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                    body: formBody.toString()
                });
                const data = await r.json();
                if (data.error) throw new FbApiError(data.error);
                const mid = this._extractMessageId(data);
                if (!mid) throw new FbApiError({ message: 'No message_id in response', code: 0 });
                return { ...data, message_id: mid };
            } catch (err) {
                lastErr = err;
            }
        }
        throw lastErr;
    }

    async _sendJsonBody(pageToken, psid, messageObj, pageId, bodyExtra = {}) {
        const body = {
            recipient: { id: String(psid) },
            message: messageObj,
            ...bodyExtra
        };
        const urls = [];
        if (pageId) urls.push(this._messagesUrl(pageId, pageToken));
        urls.push(this._messagesUrl(null, pageToken));

        let lastErr;
        for (const url of urls) {
            try {
                const data = await this._postJson(url, body);
                const mid = this._extractMessageId(data);
                if (mid) return { ...data, message_id: mid };
                lastErr = new FbApiError({ message: 'No message_id in response', code: 0 });
            } catch (err) {
                lastErr = err;
                if (!FacebookClient.isTransient(err)) break;
            }
        }
        throw lastErr;
    }

    _inboxThreadControlExtra(useUtility = false) {
        if (!FB_HANDOVER_ENABLED) return {};
        return {
            messaging_product: 'facebook',
            messaging_type: useUtility ? 'UTILITY' : 'RESPONSE',
            thread_control: {
                app_id: String(FB_PAGE_INBOX_APP_ID),
                control_type: 'pass'
            }
        };
    }

    /**
     * Legacy form first (widest compatibility). When passToPageInbox, try Conversation Routing
     * thread_control pass to Page Inbox on the Send API first (clears Business Suite unread).
     */
    async send(pageToken, psid, messageObj, useUtility = false, pageId = null, options = {}) {
        const { passToPageInbox = false } = options;
        let lastErr;
        const strategies = [];

        if (passToPageInbox) {
            strategies.push(
                () => this._sendJsonBody(pageToken, psid, messageObj, pageId, this._inboxThreadControlExtra(false)),
                () => this._sendJsonBody(pageToken, psid, messageObj, pageId, this._inboxThreadControlExtra(true))
            );
        }

        strategies.push(
            () => this._sendLegacyForm(pageToken, psid, messageObj, false, pageId),
            () => this._sendLegacyForm(pageToken, psid, messageObj, true, pageId),
            () => this._sendJsonBody(pageToken, psid, messageObj, pageId, {
                messaging_product: 'facebook',
                messaging_type: useUtility ? 'UTILITY' : 'RESPONSE'
            }),
            () => this._sendJsonBody(pageToken, psid, messageObj, pageId, {
                messaging_product: 'facebook',
                messaging_type: 'UTILITY'
            })
        );

        for (const attempt of strategies) {
            try {
                return await attempt();
            } catch (err) {
                lastErr = err;
            }
        }
        throw lastErr || new FbApiError({ message: 'All send methods failed', code: 0 });
    }

    /**
     * Conversation Routing: mark_seen + pass to Page Inbox in one Send API call (no extra message).
     */
    async passInboxWithMarkSeenViaSendApi(pageToken, psid, pageId) {
        if (!FB_HANDOVER_ENABLED || !pageId) {
            return { skipped: true, reason: 'handover_disabled_or_no_page' };
        }
        const body = {
            messaging_product: 'facebook',
            recipient: { id: String(psid) },
            sender_action: 'mark_seen',
            thread_control: {
                app_id: String(FB_PAGE_INBOX_APP_ID),
                control_type: 'pass'
            }
        };
        const urls = [];
        urls.push(this._messagesUrl(pageId, pageToken));
        urls.push(this._messagesUrl(null, pageToken));

        let lastErr;
        for (const url of urls) {
            try {
                const data = await this._postJson(url, body);
                return { success: true, data, method: 'send_api_mark_seen_pass' };
            } catch (err) {
                lastErr = err;
            }
        }
        throw lastErr;
    }

    /** Meta: page has read customer's messages (clears Business Suite unread). */
    async markSeen(pageToken, psid, pageId = null) {
        const payload = {
            messaging_product: 'facebook',
            recipient: { id: String(psid) },
            sender_action: 'mark_seen'
        };

        const urls = [];
        if (pageId) urls.push(this._messagesUrl(pageId, pageToken));
        urls.push(this._messagesUrl(null, pageToken));

        let lastErr;
        for (const url of urls) {
            try {
                return await this._postJson(url, payload);
            } catch (err) {
                lastErr = err;
            }
        }

        const formUrl = `${FB_GRAPH_BASE}/me/messages?access_token=${encodeURIComponent(pageToken)}`;
        const formBody = new URLSearchParams();
        formBody.append('messaging_product', 'facebook');
        formBody.append('recipient', JSON.stringify({ id: String(psid) }));
        formBody.append('sender_action', 'mark_seen');
        const r = await this._fetchWithTimeout(formUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: formBody.toString()
        });
        const data = await r.json();
        if (data.error) throw lastErr || new FbApiError(data.error);
        return data;
    }

    async getConversationUnreadCount(pageId, psid, pageToken) {
        if (!pageId || !psid) return null;
        const data = await this.getJson(this.lookupConversationByUser(pageId, psid, pageToken));
        const row = (data.data || [])[0];
        if (!row) return null;
        return {
            unreadCount: Number(row.unread_count) || 0,
            fbConvId: row.id || null
        };
    }

    /**
     * Pass thread to Meta Page Inbox — clears unread in Business Suite when castme owns routing.
     * Never call take_thread_control before send (breaks when castme is default app).
     */
    async getThreadOwner(pageId, pageToken, psid) {
        if (!pageId || !psid) return null;
        const url = `${FB_GRAPH_BASE}/${pageId}/thread_owner?recipient=${encodeURIComponent(String(psid))}&access_token=${encodeURIComponent(pageToken)}`;
        const data = await this.getJson(url);
        const owner = data?.data?.[0]?.thread_owner;
        if (!owner) return { appId: null, expiration: null };
        return { appId: owner.app_id ? String(owner.app_id) : null, expiration: owner.expiration || null };
    }

    async takeThreadControl(pageToken, psid, pageId) {
        if (!pageId) return { skipped: true };
        const url = `${FB_GRAPH_BASE}/${pageId}/take_thread_control?access_token=${encodeURIComponent(pageToken)}`;
        const data = await this._postJson(url, {
            messaging_product: 'facebook',
            recipient: { id: String(psid) },
            metadata: 'FBCast Pro'
        });
        return { success: true, data };
    }

    /** Meta-documented query-string format for pass_thread_control. */
    async passThreadControlQuery(pageToken, psid, pageId) {
        if (!FB_HANDOVER_ENABLED || !pageId) {
            return { skipped: true, reason: 'handover_disabled_or_no_page' };
        }
        const recipient = encodeURIComponent(JSON.stringify({ id: String(psid) }));
        const url = `${FB_GRAPH_BASE}/${pageId}/pass_thread_control` +
            `?recipient=${recipient}` +
            `&target_app_id=${encodeURIComponent(FB_PAGE_INBOX_APP_ID)}` +
            `&metadata=${encodeURIComponent('FBCast Pro — handled')}` +
            `&access_token=${encodeURIComponent(pageToken)}`;
        const r = await this._fetchWithTimeout(url, { method: 'POST' });
        const data = await r.json();
        if (data.error) throw new FbApiError(data.error);
        if (data.success === false) throw new FbApiError({ message: 'pass_thread_control returned success=false', code: 0 });
        return { success: true, data, method: 'pass_thread_control_query' };
    }

    async passThreadControlToPageInbox(pageToken, psid, pageId) {
        if (!FB_HANDOVER_ENABLED || !pageId) {
            return { skipped: true, reason: 'handover_disabled_or_no_page' };
        }
        const url = `${FB_GRAPH_BASE}/${pageId}/pass_thread_control?access_token=${encodeURIComponent(pageToken)}`;
        const data = await this._postJson(url, {
            messaging_product: 'facebook',
            recipient: { id: String(psid) },
            target_app_id: String(FB_PAGE_INBOX_APP_ID),
            metadata: 'FBCast Pro — handled'
        });
        return { success: true, data, method: 'pass_thread_control_json' };
    }

    /**
     * Clear unread in Meta Business Suite (Conversation Routing).
     * mark_seen alone does NOT clear Page Inbox — must pass thread to Page Inbox (263902037430900).
     */
    async markThreadReadOnMeta(pageId, pageToken, psid) {
        let handover = { skipped: true };
        let handoverError = null;
        let handoverMethod = null;
        let threadOwnerAppId = null;

        if (pageId && FB_HANDOVER_ENABLED) {
            try {
                await this.takeThreadControl(pageToken, psid, pageId);
            } catch (err) {
                console.warn('[FacebookClient] take_thread_control (post-send):', err.message || err);
            }

            const passAttempts = [
                () => this.passThreadControlQuery(pageToken, psid, pageId),
                () => this.passThreadControlToPageInbox(pageToken, psid, pageId),
                () => this.passInboxWithMarkSeenViaSendApi(pageToken, psid, pageId)
            ];
            for (const attempt of passAttempts) {
                try {
                    handover = await attempt();
                    handoverMethod = handover.method || 'pass';
                    handoverError = null;
                    await new Promise(r => setTimeout(r, 400));
                    try {
                        const owner = await this.getThreadOwner(pageId, pageToken, psid);
                        threadOwnerAppId = owner?.appId || null;
                        if (threadOwnerAppId === String(FB_PAGE_INBOX_APP_ID)) break;
                    } catch (_) { /* optional */ }
                    if (handover.success) break;
                } catch (err) {
                    handoverError = err.fbCode != null
                        ? `(#${err.fbCode}) ${err.message}`
                        : (err.message || String(err));
                    console.warn(
                        `[FacebookClient] inbox pass failed page=${pageId} psid=${psid}:`,
                        handoverError
                    );
                }
            }
        }

        let fb = null;
        const maxAttempts = pageId ? 6 : 2;
        for (let attempt = 0; attempt < maxAttempts; attempt++) {
            try {
                await this.markSeen(pageToken, psid, pageId);
            } catch (err) {
                console.warn(`[FacebookClient] mark_seen attempt ${attempt + 1}:`, err.message || err);
            }
            await new Promise(r => setTimeout(r, 500 + attempt * 350));
            if (!pageId) break;
            try {
                fb = await this.getConversationUnreadCount(pageId, psid, pageToken);
                if (!fb || fb.unreadCount === 0) break;
            } catch (_) { /* verify optional */ }
        }

        const inboxOwns = threadOwnerAppId === String(FB_PAGE_INBOX_APP_ID);
        return {
            metaMarked: true,
            handoverOk: !!(handover.success && (inboxOwns || fb?.unreadCount === 0)),
            handoverMethod,
            handoverError,
            threadOwnerAppId,
            expectedInboxAppId: FB_PAGE_INBOX_APP_ID,
            castmeAppId: FB_CASTME_APP_ID,
            fbUnread: fb?.unreadCount ?? null,
            fbConvId: fb?.fbConvId ?? null
        };
    }

    async markSeenWithRetry(pageToken, psid, pageId = null) {
        let lastErr;
        for (let i = 0; i <= 2; i++) {
            if (i > 0) await new Promise(r => setTimeout(r, 400 * i));
            try {
                return await this.markThreadReadOnMeta(pageId, pageToken, psid);
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
