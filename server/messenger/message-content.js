/**
 * Messenger message content helpers — thumbs up / stickers / snippets.
 */

const THUMBS_UP_STICKER_IDS = new Set([
    '369239263222821',
    '369239263222822',
    '369239343222814',
    '369239383222810'
]);

const THUMBS_UP_TEXTS = new Set(['👍', '👍🏻', '👍🏼', '👍🏽', '👍🏾', '👍🏿', ':thumbs_up:', ':+1:']);

function isThumbsUpStickerId(id) {
    if (id == null || id === '') return false;
    return THUMBS_UP_STICKER_IDS.has(String(id));
}

/** Facebook CDN URLs for the default Messenger thumbs-up sticker. */
function isThumbsUpAttachmentUrl(url) {
    const u = String(url || '');
    if (!u) return false;
    if (/36923926[0-9]{6}/.test(u)) return true;
    if (/sticker.*thumbs|thumbs.*sticker/i.test(u)) return true;
    return false;
}

function isThumbsUpText(text) {
    const t = String(text || '').trim();
    if (!t) return false;
    if (THUMBS_UP_TEXTS.has(t)) return true;
    if (/^[\u{1F44D}\u{1F3FB}-\u{1F3FF}]$/u.test(t)) return true;
    if (/thumbs?\s*up/i.test(t)) return true;
    if (/sent\s+(a\s+)?thumbs?\s*up/i.test(t)) return true;
    return false;
}

function isPlaceholderAttachmentText(text) {
    const t = String(text || '').trim().toLowerCase();
    return t === '[sticker]' || t === '[like]' || t === '[image]' || t === 'attachment'
        || t === 'message' || t === '';
}

/** Facebook CDN / common image URL patterns (photos, stickers excluded via isThumbsUpAttachmentUrl). */
function isLikelyImageUrl(url) {
    const u = String(url || '');
    if (!u || isThumbsUpAttachmentUrl(u)) return false;
    if (/\.(jpe?g|png|gif|webp|bmp)(\?|$)/i.test(u)) return true;
    if (/fbcdn\.net|fbsbx\.com|scontent/i.test(u)) return true;
    return false;
}

function extractFbAttachmentUrl(a) {
    if (!a || typeof a !== 'object') return '';
    const p = a.payload || {};
    return (
        p.url
        || a.file_url
        || a.image_data?.url
        || a.image_data?.preview_url
        || p.image_url
        || ''
    );
}

function resolveAttachmentMimeType(a, fallbackType) {
    const mime = String(a?.mime_type || a?.payload?.mime_type || '').toLowerCase();
    if (mime.startsWith('image/')) return 'image';
    if (mime.startsWith('video/')) return 'video';
    if (mime.startsWith('audio/')) return 'audio';
    return String(fallbackType || '').toLowerCase();
}

/** Pick best URL + type from row / attachments array (DB, Graph, webhook). */
function resolveMessageAttachment(msg = {}) {
    const attachments = Array.isArray(msg.attachments) ? msg.attachments.filter(Boolean) : [];
    let url = msg.attachment_url || msg.attachmentUrl || null;
    let type = String(msg.attachment_type || msg.attachmentType || '').toLowerCase();

    const withUrl = attachments.filter(a => a && a.u);
    if (!url && withUrl.length) {
        const img = withUrl.find(a => ['image', 'photo'].includes(String(a.t || '').toLowerCase()))
            || withUrl.find(a => isLikelyImageUrl(a.u))
            || withUrl[0];
        url = img.u;
        type = String(img.t || type).toLowerCase();
    }

    if (url && (!type || type === 'fallback' || type === 'file')) {
        if (isLikelyImageUrl(url)) type = 'image';
    }
    return { attachment_url: url || null, attachment_type: type || null };
}

/** Whether a raw Facebook list snippet was sent by the page. */
function snippetIndicatesFromPage(snippet) {
    const raw = String(snippet || '').trim();
    return /^you:/i.test(raw) || /^you\s+sent\b/i.test(raw);
}

/** Normalize Facebook conversation list snippet (often includes "You:" or "You sent a thumbs up"). */
function normalizeSnippetForList(snippet) {
    let s = String(snippet || '').trim();
    if (!s) return '';
    while (/^you:\s*/i.test(s)) s = s.replace(/^you:\s*/i, '').trim();
    s = s.replace(/^you\s+sent\s+/i, '').trim();
    if (isThumbsUpText(s) || isPlaceholderAttachmentText(s)) return '👍';
    if (/^\[.+\]$/i.test(s) && /sticker|like|image|attachment/i.test(s)) return '👍';
    return s.substring(0, 200);
}

function isThumbsUpMessage(input = {}) {
    const text = input.message ?? input.text ?? '';
    const attType = String(input.attachment_type || input.attachmentType || '').toLowerCase();
    const attachments = input.attachments || [];

    const attUrl = input.attachment_url || input.attachmentUrl || '';

    if (isThumbsUpText(text)) return true;
    if (attType === 'like' || attType === 'thumbs_up') return true;
    if (isThumbsUpAttachmentUrl(attUrl)) return true;
    if (isPlaceholderAttachmentText(text) && (attType === 'sticker' || attType === 'like')) return true;
    if (isPlaceholderAttachmentText(text) && attType === 'image' && (!attUrl || isThumbsUpAttachmentUrl(attUrl))) return true;

    for (const a of attachments) {
        const t = String(a.t || a.type || '').toLowerCase();
        if (t === 'like' || t === 'thumbs_up') return true;
        if (isThumbsUpStickerId(a.sticker_id)) return true;
        if (isThumbsUpAttachmentUrl(a.u)) return true;
        if (t === 'sticker' && (isThumbsUpStickerId(a.sticker_id) || !a.u)) return true;
        if (t === 'image' && isThumbsUpAttachmentUrl(a.u)) return true;
    }

    if (!String(text).trim() && (attType === 'sticker' || attType === 'like')) return true;
    if (!String(text).trim() && attType === 'image' && isThumbsUpAttachmentUrl(attUrl)) return true;

    const fromPage = input.from_me == 1 || input.from_me === true
        || input.isFromPage === true || input.isFromPage === 1;
    if (fromPage && (isThumbsUpText(text) || /^attachment$/i.test(String(text).trim()))) return true;
    if (fromPage && !String(text).trim() && !attUrl) {
        const benign = !attType || attType === 'image' || attType === 'sticker'
            || attType === 'like' || attType === 'fallback';
        const hasReal = attachments.some(a => {
            const t = String(a.t || a.type || '').toLowerCase();
            return a.u && !isThumbsUpAttachmentUrl(a.u) && t !== 'like' && t !== 'sticker';
        });
        if (benign && !hasReal) return true;
    }
    return false;
}

function parseFbAttachmentItem(a) {
    let type = String(a.type || 'file').toLowerCase();
    type = resolveAttachmentMimeType(a, type);
    const stickerId = a.payload?.sticker_id ?? a.sticker_id ?? null;
    const url = extractFbAttachmentUrl(a);

    if (type === 'fallback' && url && isLikelyImageUrl(url)) type = 'image';

    if (stickerId && isThumbsUpStickerId(stickerId)) {
        return { t: 'like', u: url || null, sticker_id: stickerId };
    }
    if (type === 'like' || type === 'thumbs_up') {
        return { t: 'like', u: url || null, sticker_id: stickerId };
    }
    if ((type === 'image' || type === 'fallback') && isThumbsUpAttachmentUrl(url)) {
        return { t: 'like', u: url || null, sticker_id: stickerId };
    }
    if (type === 'sticker' || stickerId) {
        if (!url || isThumbsUpStickerId(stickerId)) {
            return { t: 'like', u: url || null, sticker_id: stickerId };
        }
        return { t: 'sticker', u: url || null, sticker_id: stickerId };
    }
    const entry = { t: type, u: url };
    if (a.name || a.payload?.name) entry.n = a.name || a.payload?.name;
    return entry;
}

function parseFbAttachments(fbAttachments) {
    if (!fbAttachments) return [];
    const list = fbAttachments.data || (Array.isArray(fbAttachments) ? fbAttachments : []);
    return list.map(parseFbAttachmentItem).filter(a => a.t === 'like' || a.t === 'sticker' || a.u);
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
    })).filter(a => a.t === 'like' || a.t === 'sticker' || a.u);
}

function normalizeIncomingSave({ text, attachments }) {
    const atts = attachments || [];
    if (isThumbsUpMessage({ text, attachments: atts })) {
        return { text: '👍', attachments: [{ t: 'like', u: null }] };
    }
    return { text: text || '', attachments: atts.length ? atts : null };
}

function snippetForMessage(input = {}) {
    if (isThumbsUpMessage(input)) return '👍';
    const text = String(input.message ?? input.text ?? '').trim();
    if (text && !isPlaceholderAttachmentText(text)) return text.substring(0, 200);
    const attType = String(input.attachment_type || '').toLowerCase();
    if (attType === 'image') return '[Image]';
    if (attType === 'video') return '[Video]';
    if (attType === 'audio') return '[Audio]';
    if (attType === 'file') return '[File]';
    if (attType === 'sticker' || attType === 'like') return '👍';
    return text || 'Message';
}

/**
 * Normalize to messenger.js row shape (message_id, message, from_me, created_at, attachment_*).
 */
function normalizeMessengerMessage(msg = {}) {
    let attachments = msg.attachments || (msg.attachment_type || msg.attachment_url
        ? [{ t: msg.attachment_type, u: msg.attachment_url }]
        : []);
    const resolved = resolveMessageAttachment({
        ...msg,
        attachments,
        attachment_url: msg.attachment_url,
        attachment_type: msg.attachment_type
    });
    const like = isThumbsUpMessage({
        message: msg.message ?? msg.text,
        attachment_type: resolved.attachment_type,
        attachment_url: resolved.attachment_url,
        attachments
    });

    if (like) {
        return {
            ...msg,
            message: '👍',
            message_id: msg.message_id || msg.mid || msg.id,
            from_me: msg.from_me != null ? msg.from_me : (msg.isFromPage ? 1 : 0),
            created_at: msg.created_at || msg.createdTime,
            attachment_url: null,
            attachment_type: 'like',
            is_like: true
        };
    }

    let message = msg.message ?? msg.text ?? '';
    if (isPlaceholderAttachmentText(message)) message = '';

    if (!attachments.length && resolved.attachment_url) {
        attachments = [{ t: resolved.attachment_type, u: resolved.attachment_url }];
    }

    return {
        ...msg,
        message,
        message_id: msg.message_id || msg.mid || msg.id,
        from_me: msg.from_me != null ? msg.from_me : (msg.isFromPage ? 1 : 0),
        created_at: msg.created_at || msg.createdTime,
        attachment_url: resolved.attachment_url,
        attachment_type: resolved.attachment_type,
        attachments,
        is_like: false
    };
}

/** Graph API attachment subfields (nested image_data / payload URLs). */
const FB_MESSAGE_ATTACHMENT_FIELDS =
    'attachments{type,mime_type,payload{url,sticker_id},sticker_id,image_data{url,preview_url},file_url}';

module.exports = {
    THUMBS_UP_STICKER_IDS,
    FB_MESSAGE_ATTACHMENT_FIELDS,
    isThumbsUpMessage,
    isThumbsUpAttachmentUrl,
    isThumbsUpText,
    isLikelyImageUrl,
    resolveMessageAttachment,
    snippetIndicatesFromPage,
    normalizeSnippetForList,
    parseFbAttachments,
    parseWebhookAttachments,
    normalizeIncomingSave,
    snippetForMessage,
    normalizeMessengerMessage
};
