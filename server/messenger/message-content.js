/**
 * Messenger message content — single place to normalize text, attachments, thumbs up.
 */

const THUMBS_UP_STICKER_IDS = new Set([
    '369239263222821', '369239263222822', '369239343222814', '369239383222810'
]);

const THUMBS_UP_TEXTS = new Set(['👍', '👍🏻', '👍🏼', '👍🏽', '👍🏾', '👍🏿', ':thumbs_up:', ':+1:']);

const FB_MESSAGE_ATTACHMENT_FIELDS =
    'attachments{type,mime_type,payload{url,sticker_id},sticker_id,image_data{url,preview_url},file_url}';

function isThumbsUpStickerId(id) {
    if (id == null || id === '') return false;
    const s = String(id);
    if (THUMBS_UP_STICKER_IDS.has(s)) return true;
    return /^36923926\d{6,}$/.test(s);
}

/** Meta message_reactions webhook — customer tapped 👍 on a message */
function isThumbsUpReaction(reaction = {}) {
    if (!reaction || reaction.action === 'unreact') return false;
    const r = String(reaction.reaction || '').toLowerCase();
    if (r === 'like') return true;
    const emoji = String(reaction.emoji || '').trim();
    if (!emoji) return false;
    if (THUMBS_UP_TEXTS.has(emoji)) return true;
    return /^[\u{1F44D}\u{1F3FB}-\u{1F3FF}]/u.test(emoji);
}

function isThumbsUpAttachmentUrl(url) {
    const u = String(url || '').toLowerCase();
    if (!u) return false;
    if (/36923926\d{6,}/.test(u)) return true;
    if (/sticker[_-]?id[=\/]36923926/.test(u)) return true;
    if (/sticker.*thumbs|thumbs.*sticker|like_sticker|reaction.*like/i.test(u)) return true;
    return false;
}

function isBrokenLikeSnippet(text) {
    const s = String(text || '').trim();
    if (!s || isThumbsUpText(s)) return false;
    if (/^[\uFFFD\uFFFC\u25A1\u25A0]$/.test(s) || s === '□') return true;
    if (/^\[(sticker|like|attachment)\]$/i.test(s)) return true;
    return false;
}

function isThumbsUpText(text) {
    const t = String(text || '').trim();
    if (!t) return false;
    if (THUMBS_UP_TEXTS.has(t)) return true;
    if (/^[\u{1F44D}\u{1F3FB}-\u{1F3FF}]$/u.test(t)) return true;
    if (/thumbs?\s*up/i.test(t) || /sent\s+(a\s+)?thumbs?\s*up/i.test(t)) return true;
    return false;
}

function isPlaceholderText(text) {
    const t = String(text || '').trim().toLowerCase();
    return !t || t === 'attachment' || t === 'message'
        || t === '[sticker]' || t === '[like]' || t === '[image]';
}

function extractFbAttachmentUrl(a) {
    if (!a || typeof a !== 'object') return '';
    const p = a.payload || {};
    return p.url || a.file_url || a.image_data?.url || a.image_data?.preview_url || p.image_url || '';
}

function resolveAttachmentMimeType(a, fallbackType) {
    const mime = String(a?.mime_type || a?.payload?.mime_type || '').toLowerCase();
    if (mime.startsWith('image/')) return 'image';
    if (mime.startsWith('video/')) return 'video';
    if (mime.startsWith('audio/')) return 'audio';
    return String(fallbackType || 'file').toLowerCase();
}

/** Thumbs up only when we are sure — avoids classifying photos as likes. */
function isThumbsUpMessage(input = {}) {
    if (input.is_like) return true;

    const text = String(input.message ?? input.text ?? '').trim();
    const attType = String(input.attachment_type || '').toLowerCase();
    const attUrl = input.attachment_url || '';
    const attachments = input.attachments || [];

    if (isThumbsUpText(text)) return true;
    if (attType === 'like' || attType === 'thumbs_up') return true;
    if (attUrl && isThumbsUpAttachmentUrl(attUrl)) return true;

    for (const a of attachments) {
        const t = String(a.t || a.type || '').toLowerCase();
        if (t === 'like' || t === 'thumbs_up') return true;
        if (isThumbsUpStickerId(a.sticker_id)) return true;
        if (a.u && isThumbsUpAttachmentUrl(a.u)) return true;
    }

    if (!text && attachments.length === 1) {
        const t = String(attachments[0].t || '').toLowerCase();
        if (t === 'like' || t === 'sticker') return true;
    }

    return false;
}

function parseFbAttachmentItem(a) {
    let type = resolveAttachmentMimeType(a, a.type || 'file');
    const stickerId = a.payload?.sticker_id ?? a.sticker_id ?? null;
    const url = extractFbAttachmentUrl(a);

    if (isThumbsUpStickerId(stickerId) || type === 'like' || type === 'thumbs_up') {
        return { t: 'like', u: url || null, sticker_id: stickerId };
    }
    if (url && isThumbsUpAttachmentUrl(url)) {
        return { t: 'like', u: url, sticker_id: stickerId };
    }
    if (type === 'sticker') {
        if (isThumbsUpStickerId(stickerId) || (url && isThumbsUpAttachmentUrl(url))) {
            return { t: 'like', u: url || null, sticker_id: stickerId };
        }
        return { t: 'sticker', u: url || null, sticker_id: stickerId };
    }
    return { t: type, u: url || null, sticker_id: stickerId || null };
}

/** Graph API `sticker` field + attachments — likes often only expose sticker id. */
function graphMessageAttachments(msg = {}) {
    let attachments = parseFbAttachments(msg.attachments);
    const stickerId = msg.sticker ?? msg.sticker_id ?? null;
    if (stickerId != null && stickerId !== '') {
        if (isThumbsUpStickerId(stickerId)) {
            return [{ t: 'like', u: null, sticker_id: String(stickerId) }];
        }
        if (!attachments.length) {
            return [{ t: 'sticker', u: null, sticker_id: String(stickerId) }];
        }
    }
    return attachments;
}

function parseFbAttachments(fbAttachments) {
    if (!fbAttachments) return [];
    const list = fbAttachments.data || (Array.isArray(fbAttachments) ? fbAttachments : []);
    return list
        .map(parseFbAttachmentItem)
        .filter(a => a.t === 'like' || a.u || ['image', 'video', 'audio', 'file', 'sticker'].includes(a.t));
}

function parseWebhookAttachments(rawList) {
    if (!Array.isArray(rawList)) return [];
    return rawList.map(a => parseFbAttachmentItem({
        type: a.type,
        mime_type: a.mime_type,
        payload: a.payload,
        sticker_id: a.payload?.sticker_id ?? a.sticker_id,
        file_url: a.payload?.url,
        image_data: a.image_data
    }));
}

function pickPrimaryAttachment(msg = {}) {
    const attachments = Array.isArray(msg.attachments) ? msg.attachments.filter(Boolean) : [];
    const likeAtt = attachments.find(a => {
        const t = String(a.t || '').toLowerCase();
        return t === 'like' || t === 'thumbs_up'
            || (a.sticker_id && isThumbsUpStickerId(a.sticker_id))
            || (a.u && isThumbsUpAttachmentUrl(a.u));
    });
    if (likeAtt) {
        return { attachment_url: null, attachment_type: 'like' };
    }

    let url = msg.attachment_url || null;
    let type = String(msg.attachment_type || '').toLowerCase();

    if (!url && attachments.length) {
        const best = attachments.find(a => a.u && ['image', 'photo'].includes(String(a.t || '').toLowerCase()))
            || attachments.find(a => a.u)
            || attachments[0];
        url = best.u || null;
        type = String(best.t || type).toLowerCase();
    }

    if (url && isThumbsUpAttachmentUrl(url)) {
        return { attachment_url: null, attachment_type: 'like' };
    }

    if (url && (!type || type === 'fallback' || type === 'file')) {
        if (/\.(jpe?g|png|gif|webp)/i.test(url) || /fbcdn|fbsbx|scontent/i.test(url)) type = 'image';
    }

    return { attachment_url: url, attachment_type: type || null };
}

/** OUT/IN (competitor APIs) + legacy from_me / isFromPage */
function resolveFromMe(msg = {}) {
    if (msg.from_me === 1 || msg.from_me === true) return 1;
    if (msg.from_me === 0 || msg.from_me === false) return 0;
    if (msg.isFromPage === true || msg.isFromPage === 1) return 1;
    const dir = String(msg.direction || '').toUpperCase();
    if (dir === 'OUT' || dir === 'OUTBOUND') return 1;
    if (dir === 'IN' || dir === 'INBOUND') return 0;
    return 0;
}

/** Prefer Facebook timestamp over DB insert time (import/backfill often share created_at). */
function resolveMessageTime(msg = {}) {
    return msg.fb_created_at || msg.created_at || msg.createdTime || null;
}

function normalizeAttachmentsInput(msg = {}) {
    if (Array.isArray(msg.attachments) && msg.attachments.length) {
        return msg.attachments.map((a) => {
            if (!a || typeof a !== 'object') return null;
            const u = a.url || a.u || a.media_permanent_url || a.payload?.url || null;
            const t = a.type || a.t || a.mime_type || (u ? 'image' : 'file');
            return u || t ? { t, u } : null;
        }).filter(Boolean);
    }
    const url = msg.media_permanent_url || msg.attachment_url || null;
    const type = msg.attachment_type || null;
    if (url || type) return [{ t: type, u: url }];
    return [];
}

function normalizeMessengerMessage(msg = {}) {
    const attachments = normalizeAttachmentsInput(msg);

    const { attachment_url, attachment_type } = pickPrimaryAttachment({
        ...msg,
        attachments
    });

    const like = isThumbsUpMessage({
        message: msg.message ?? msg.text,
        attachment_type,
        attachment_url,
        attachments,
        is_like: msg.is_like
    });

    let message = String(msg.message ?? msg.text ?? '').trim();
    if (isPlaceholderText(message)) message = '';

    const fromMe = resolveFromMe(msg);
    const createdAt = resolveMessageTime(msg);
    const messageId = msg.fb_message_id || msg.message_id || msg.mid || msg.id || null;

    if (like) {
        return {
            message_id: messageId,
            message: '👍',
            from_me: fromMe,
            created_at: createdAt,
            attachment_url: null,
            attachment_type: 'like',
            is_like: true,
            delivered_at: msg.delivered_at || null,
            seen_at: msg.seen_at || null
        };
    }

    return {
        message_id: messageId,
        message,
        from_me: fromMe,
        created_at: createdAt,
        attachment_url,
        attachment_type,
        is_like: false,
        delivered_at: msg.delivered_at || null,
        seen_at: msg.seen_at || null
    };
}

/** Shape sent to messenger.js — flat, no re-parsing on the client. */
function toClientMessage(msg) {
    return normalizeMessengerMessage(msg);
}

function normalizeIncomingSave({ text, attachments }) {
    const n = normalizeMessengerMessage({ text, attachments });
    if (n.is_like) {
        return { text: '👍', attachments: [{ t: 'like', u: null }] };
    }
    const atts = attachments?.length ? attachments : (
        n.attachment_url ? [{ t: n.attachment_type, u: n.attachment_url }] : null
    );
    return { text: n.message || text || '', attachments: atts };
}

function snippetForMessage(input = {}) {
    const n = normalizeMessengerMessage(input);
    if (n.is_like) return '👍';
    if (n.message) return n.message.substring(0, 200);
    if (n.attachment_type === 'image') return '[Image]';
    if (n.attachment_type === 'video') return '[Video]';
    if (n.attachment_type === 'audio') return '[Audio]';
    return 'Message';
}

function snippetIndicatesFromPage(snippet) {
    const raw = String(snippet || '').trim();
    return /^you:/i.test(raw) || /^you\s+sent\b/i.test(raw);
}

function normalizeSnippetForList(snippet) {
    let s = String(snippet || '').trim();
    if (!s) return '';
    while (/^you:\s*/i.test(s)) s = s.replace(/^you:\s*/i, '').trim();
    s = s.replace(/^you\s+sent\s+/i, '').trim();
    if (isThumbsUpText(s) || isBrokenLikeSnippet(s)) return '👍';
    if (isPlaceholderText(s)) return '';
    return s.substring(0, 200);
}

module.exports = {
    THUMBS_UP_STICKER_IDS,
    FB_MESSAGE_ATTACHMENT_FIELDS,
    isThumbsUpMessage,
    isThumbsUpReaction,
    isThumbsUpAttachmentUrl,
    isBrokenLikeSnippet,
    isThumbsUpText,
    isThumbsUpStickerId,
    parseFbAttachments,
    graphMessageAttachments,
    parseWebhookAttachments,
    normalizeIncomingSave,
    snippetForMessage,
    normalizeMessengerMessage,
    toClientMessage,
    snippetIndicatesFromPage,
    normalizeSnippetForList
};
