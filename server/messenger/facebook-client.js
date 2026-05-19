const {
    FB_GRAPH_BASE,
    retentionCutoffUnix,
    isWithinRetention,
    FB_PAGE_INBOX_APP_ID,
    FB_CASTME_APP_ID,
    FB_HANDOVER_ENABLED,
    FB_PASS_TO_INBOX_AFTER_SEND,
    FB_PASS_TO_INBOX_ON_MARK_READ
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
        let data = await this.send(pageToken, psid, {
            attachment: { type: 'like' }
        }, useUtility, pageId);
        if (!data.error) return data;
        data = await this.send(pageToken, psid, { text: '👍' }, useUtility, pageId);
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
        const payload = {
            messaging_product: 'facebook',
            recipient: { id: String(psid) },
            message: messageObj
        };
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

    /** Meta #10 is used for permissions, 24h window, AND handover — match message text, not code alone. */
    static isThreadControlError(fbError) {
        if (!fbError) return false;
        const code = fbError.code ?? fbError.fbCode;
        const msg = (fbError.message || '').toLowerCase();
        if (code === 2018300 || code === 2534001) return true;
        if (msg.includes('another app') && msg.includes('control')) return true;
        if (msg.includes('not the thread owner')) return true;
        if (msg.includes('pass_thread') || msg.includes('take_thread') || msg.includes('request_thread')) return true;
        if (msg.includes('thread') && (msg.includes('control') || msg.includes('owner') || msg.includes('handover'))) return true;
        if (code === 10 && (msg.includes('controlling') || msg.includes('another app'))) return true;
        return false;
    }

    static routingGuidanceShort() {
        return 'Leave Conversation Routing default unset (recommended for FBCast), or reply from FBCast before using Meta Business Suite for this chat.';
    }

    static threadControlUserMessage() {
        return 'This chat is locked by Meta Page Inbox / Business Suite. '
            + 'Open a new customer message in FBCast and reply here first, or in Page settings → Conversation routing set Social entry to your FBCast app. '
            + 'You do not need castme as Default for every page.';
    }

    static needsThreadControlBeforeSend(err) {
        if (!err) return false;
        if (FacebookClient.isThreadControlError(err)) return true;
        const msg = (err.message || '').toLowerCase();
        const code = err.fbCode ?? err.code;
        return code === 100 ||
            msg.includes('handover') || msg.includes('not authorized') ||
            msg.includes('cannot send');
    }

    async _runSendStrategies(strategies) {
        let lastErr;
        for (const attempt of strategies) {
            try {
                return await attempt();
            } catch (err) {
                lastErr = err;
            }
        }
        return { error: lastErr };
    }

    _plainSendStrategies(pageToken, psid, messageObj, useUtility, pageId, fast = false) {
        const full = [
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
        ];
        if (!fast) return full;
        return full.slice(0, 2);
    }

    _castmePassInSendExtra() {
        return {
            messaging_product: 'facebook',
            messaging_type: 'RESPONSE',
            thread_control: {
                app_id: String(FB_CASTME_APP_ID),
                control_type: 'pass'
            }
        };
    }

    async _takeThreadControlBurst(pageToken, psid, pageId) {
        await Promise.all([
            this.takeThreadControlQuery(pageToken, psid, pageId).catch(() => {}),
            this.takeThreadControl(pageToken, psid, pageId).catch(() => {})
        ]);
    }

    /** take_thread_control immediately then send (no owner poll wait). */
    async _burstTakeAndSend(pageToken, psid, messageObj, useUtility, pageId) {
        let lastErr;
        const tries = [
            async () => {
                await this._takeThreadControlBurst(pageToken, psid, pageId);
                return this._sendLegacyForm(pageToken, psid, messageObj, false, pageId);
            },
            async () => {
                await this._takeThreadControlBurst(pageToken, psid, pageId);
                return this._sendJsonBody(pageToken, psid, messageObj, pageId, {
                    messaging_product: 'facebook',
                    messaging_type: useUtility ? 'UTILITY' : 'RESPONSE'
                });
            },
            async () => this._sendJsonBody(pageToken, psid, messageObj, pageId, this._castmePassInSendExtra()),
            async () => {
                await this.requestThreadControl(pageToken, psid, pageId).catch(() => {});
                return this._sendLegacyForm(pageToken, psid, messageObj, false, pageId);
            }
        ];
        for (const fn of tries) {
            try {
                return await fn();
            } catch (err) {
                lastErr = err;
                if (!FacebookClient.isThreadControlError(err) && !FacebookClient.needsThreadControlBeforeSend(err)) {
                    throw err;
                }
            }
        }
        throw lastErr;
    }

    /**
     * Plain send first; on thread-control errors burst take+send (works when castme is handover primary).
     */
    async send(pageToken, psid, messageObj, useUtility = false, pageId = null, options = {}) {
        const { passToPageInbox = false } = options;
        const castmeId = String(FB_CASTME_APP_ID);
        const inboxId = String(FB_PAGE_INBOX_APP_ID);

        let acquired = null;

        if (pageId && FB_HANDOVER_ENABLED) {
            await this._takeThreadControlBurst(pageToken, psid, pageId);
        }

        let result = await this._runSendStrategies(
            this._plainSendStrategies(pageToken, psid, messageObj, useUtility, pageId, true)
        );
        if (!result.error) return result;

        let lastErr = result.error;

        if (pageId && FB_HANDOVER_ENABLED && FacebookClient.needsThreadControlBeforeSend(lastErr)) {
            try {
                return await this._burstTakeAndSend(pageToken, psid, messageObj, useUtility, pageId);
            } catch (burstErr) {
                lastErr = burstErr;
            }

            acquired = await this.acquireThreadForCastmeSend(pageId, pageToken, psid, { maxMs: 2500, rounds: 1 })
                .catch(() => ({ ok: false }));

            if (!acquired?.ok) {
                try {
                    return await this._burstTakeAndSend(pageToken, psid, messageObj, useUtility, pageId);
                } catch (burstErr2) {
                    lastErr = burstErr2;
                }
            }

            const retryStrategies = this._plainSendStrategies(pageToken, psid, messageObj, useUtility, pageId, false);
            result = await this._runSendStrategies(retryStrategies);
            if (!result.error) return result;
            lastErr = result.error;
        }

        if (passToPageInbox) {
            const passStrategies = [
                () => this._sendJsonBody(pageToken, psid, messageObj, pageId, this._inboxThreadControlExtra(false)),
                () => this._sendJsonBody(pageToken, psid, messageObj, pageId, this._inboxThreadControlExtra(true))
            ];
            result = await this._runSendStrategies(passStrategies);
            if (!result.error) return result;
            lastErr = result.error;
        }

        if (FacebookClient.isThreadControlError(lastErr)) {
            const owner = acquired?.threadOwnerAppId;
            if (owner === inboxId || acquired?.inboxOwns) {
                throw new FbApiError({
                    message: FacebookClient.threadControlUserMessage(),
                    code: 2018300
                });
            }
            throw new FbApiError({
                message: `Cannot send: another Meta app controls this chat${owner ? ` (app ${owner})` : ''}. ${FacebookClient.routingGuidanceShort()}`,
                code: 2018300
            });
        }

        if (lastErr instanceof FbApiError) throw lastErr;
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
        return { success: true, data, method: 'take_thread_control_json' };
    }

    async takeThreadControlQuery(pageToken, psid, pageId) {
        if (!pageId) return { skipped: true };
        const recipient = encodeURIComponent(JSON.stringify({ id: String(psid) }));
        const url = `${FB_GRAPH_BASE}/${pageId}/take_thread_control` +
            `?recipient=${recipient}` +
            `&metadata=${encodeURIComponent('FBCast Pro')}` +
            `&access_token=${encodeURIComponent(pageToken)}`;
        const r = await this._fetchWithTimeout(url, { method: 'POST' });
        const data = await r.json();
        if (data.error) throw new FbApiError(data.error);
        return { success: true, data, method: 'take_thread_control_query' };
    }

    async requestThreadControl(pageToken, psid, pageId) {
        if (!pageId) return { skipped: true };
        const recipient = encodeURIComponent(JSON.stringify({ id: String(psid) }));
        const url = `${FB_GRAPH_BASE}/${pageId}/request_thread_control` +
            `?recipient=${recipient}` +
            `&metadata=${encodeURIComponent('FBCast Pro — send')}` +
            `&access_token=${encodeURIComponent(pageToken)}`;
        const r = await this._fetchWithTimeout(url, { method: 'POST' });
        const data = await r.json();
        if (data.error) throw new FbApiError(data.error);
        return { success: true, data, method: 'request_thread_control_query' };
    }

    async requestThreadControlJson(pageToken, psid, pageId) {
        if (!pageId) return { skipped: true };
        const url = `${FB_GRAPH_BASE}/${pageId}/request_thread_control?access_token=${encodeURIComponent(pageToken)}`;
        const data = await this._postJson(url, {
            messaging_product: 'facebook',
            recipient: { id: String(psid) },
            metadata: 'FBCast Pro — send'
        });
        return { success: true, data, method: 'request_thread_control_json' };
    }

    async _waitForThreadOwner(pageId, pageToken, psid, expectedAppId, opts = {}) {
        const maxMs = opts.maxMs ?? 3200;
        const stepMs = opts.stepMs ?? 450;
        const castmeId = String(expectedAppId);
        const start = Date.now();
        let lastOwner = null;
        while (Date.now() - start < maxMs) {
            try {
                const owner = await this.getThreadOwner(pageId, pageToken, psid);
                lastOwner = owner?.appId ? String(owner.appId) : null;
                if (lastOwner === castmeId) {
                    return { ok: true, threadOwnerAppId: lastOwner };
                }
            } catch (_) { /* owner hidden when not default */ }
            await new Promise(r => setTimeout(r, stepMs));
        }
        return { ok: false, threadOwnerAppId: lastOwner };
    }

    async _runControlAttempt(pageId, pageToken, psid, castmeId, attemptFn) {
        const r = await attemptFn();
        const waited = await this._waitForThreadOwner(pageId, pageToken, psid, castmeId, { maxMs: 2400, stepMs: 400 });
        return {
            ok: waited.ok,
            threadOwnerAppId: waited.threadOwnerAppId,
            method: r.method || 'control'
        };
    }

    /**
     * Conversation Routing: request control from Page Inbox (when castme is default app), then take if idle.
     * thread_owner may be empty even when another app controls the thread.
     */
    async acquireThreadForCastmeSend(pageId, pageToken, psid, opts = {}) {
        if (!pageId || !psid || !FB_HANDOVER_ENABLED) return { ok: false, reason: 'disabled' };
        const castmeId = String(FB_CASTME_APP_ID);
        const inboxId = String(FB_PAGE_INBOX_APP_ID);
        const deadline = Date.now() + Math.max(1200, Number(opts.maxMs) || 3500);
        const maxRounds = Math.max(1, Number(opts.rounds) || 1);

        let ownerId = null;
        try {
            const owner = await this.getThreadOwner(pageId, pageToken, psid);
            ownerId = owner?.appId ? String(owner.appId) : null;
        } catch (_) { /* hidden or idle */ }

        if (ownerId === castmeId) return { ok: true, threadOwnerAppId: ownerId, method: 'already_castme' };
        if (ownerId === inboxId) {
            return { ok: false, threadOwnerAppId: ownerId, inboxOwns: true, expectedAppId: castmeId, inboxAppId: inboxId };
        }

        const takeAttempts = [
            () => this.takeThreadControlQuery(pageToken, psid, pageId),
            () => this.takeThreadControl(pageToken, psid, pageId)
        ];
        const requestAttempts = [
            () => this.requestThreadControl(pageToken, psid, pageId),
            () => this.requestThreadControlJson(pageToken, psid, pageId)
        ];
        const attempts = [...takeAttempts, ...requestAttempts];

        let lastErr = null;
        for (let round = 0; round < maxRounds && Date.now() < deadline; round++) {
            for (const attempt of attempts) {
                if (Date.now() >= deadline) break;
                try {
                    const waitMs = Math.min(900, Math.max(200, deadline - Date.now()));
                    const r = await attempt();
                    const waited = await this._waitForThreadOwner(pageId, pageToken, psid, castmeId, {
                        maxMs: waitMs,
                        stepMs: 280
                    });
                    ownerId = waited.threadOwnerAppId ?? ownerId;
                    if (waited.ok) {
                        return { ok: true, threadOwnerAppId: ownerId, method: r.method || 'control' };
                    }
                } catch (err) {
                    lastErr = err;
                }
            }
        }

        try {
            const owner = await this.getThreadOwner(pageId, pageToken, psid);
            ownerId = owner?.appId ? String(owner.appId) : ownerId;
        } catch (_) {}

        return {
            ok: ownerId === castmeId,
            threadOwnerAppId: ownerId,
            expectedAppId: castmeId,
            inboxAppId: inboxId,
            inboxOwns: ownerId === inboxId,
            error: lastErr ? (lastErr.message || String(lastErr)) : `owner is ${ownerId || 'unknown'}`
        };
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
     * Keep castme as thread owner after a successful FBCast send (multi-tenant / Page Inbox default).
     */
    async retainCastmeThreadAfterPageSend(pageId, pageToken, psid) {
        if (!pageId || !psid || !FB_HANDOVER_ENABLED || FB_PASS_TO_INBOX_AFTER_SEND) return;
        const castmeId = String(FB_CASTME_APP_ID);
        try {
            const owner = await this.getThreadOwner(pageId, pageToken, psid);
            const ownerId = owner?.appId ? String(owner.appId) : null;
            if (ownerId === castmeId) return;
            await this.takeThreadControlQuery(pageToken, psid, pageId).catch(() => {});
            await this.takeThreadControl(pageToken, psid, pageId).catch(() => {});
        } catch (_) { /* best-effort */ }
    }

    /**
     * Mark read on Meta. Pass to Page Inbox only when explicitly enabled (breaks next send if Inbox is default).
     */
    async markThreadReadOnMeta(pageId, pageToken, psid, options = {}) {
        const passToInbox = options.passToInbox === true;
        let handover = { skipped: true };
        let handoverError = null;
        let handoverMethod = null;
        let threadOwnerAppId = null;
        const inboxId = String(FB_PAGE_INBOX_APP_ID);

        if (pageId && FB_HANDOVER_ENABLED && passToInbox) {
            try {
                const owner = await this.getThreadOwner(pageId, pageToken, psid);
                threadOwnerAppId = owner?.appId || null;
            } catch (_) { /* optional */ }

            const inboxAlreadyOwns = threadOwnerAppId === inboxId;

            if (!inboxAlreadyOwns) {
                const passAttempts = [
                    () => this.passInboxWithMarkSeenViaSendApi(pageToken, psid, pageId),
                    () => this.passThreadControlQuery(pageToken, psid, pageId),
                    () => this.passThreadControlToPageInbox(pageToken, psid, pageId)
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
                            if (threadOwnerAppId === inboxId) break;
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
            } else {
                handoverMethod = 'inbox_default_owner';
                handover = { success: true };
            }
        }

        let fb = null;
        const maxAttempts = passToInbox && pageId ? 4 : 1;
        for (let attempt = 0; attempt < maxAttempts; attempt++) {
            try {
                await this.markSeen(pageToken, psid, pageId);
            } catch (err) {
                console.warn(`[FacebookClient] mark_seen attempt ${attempt + 1}:`, err.message || err);
            }
            if (maxAttempts === 1) break;
            await new Promise(r => setTimeout(r, 400 + attempt * 300));
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

    async markSeenWithRetry(pageToken, psid, pageId = null, options = {}) {
        let lastErr;
        for (let i = 0; i <= 2; i++) {
            if (i > 0) await new Promise(r => setTimeout(r, 400 * i));
            try {
                return await this.markThreadReadOnMeta(pageId, pageToken, psid, options);
            } catch (err) {
                lastErr = err;
                if (!FacebookClient.isTransient(err)) throw err;
            }
        }
        throw lastErr;
    }

    static isOutside24hWindow(fbError) {
        if (!fbError) return false;
        if (FacebookClient.isThreadControlError(fbError)) return false;
        const code = fbError.code ?? fbError.fbCode;
        const msg = (fbError.message || '').toLowerCase();
        if (code === 10 && (msg.includes('permission') || msg.includes('does not have'))) return false;
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
        if (!fbError) return 'Message could not be sent';
        const msg = fbError.message || String(fbError);
        const code = fbError.code ?? fbError.fbCode;
        const lower = msg.toLowerCase();

        if (FacebookClient.isThreadControlError(fbError)) {
            if (msg.includes('castme') || msg.includes('Conversation routing') || msg.includes('Business Suite')) {
                return msg;
            }
            if (lower.includes('page inbox') || msg.includes(String(FB_PAGE_INBOX_APP_ID))) {
                return FacebookClient.threadControlUserMessage();
            }
            return `Cannot send: another Meta app controls this chat. ${FacebookClient.routingGuidanceShort()}`;
        }
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
