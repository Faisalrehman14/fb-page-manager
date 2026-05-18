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

    if (isThumbsUpText(text)) return true;
    if (attType === 'like' || attType === 'thumbs_up') return true;
    if (isPlaceholderAttachmentText(text) && (attType === 'sticker' || attType === 'like')) return true;

    for (const a of attachments) {
        const t = String(a.t || a.type || '').toLowerCase();
        if (t === 'like' || t === 'thumbs_up') return true;
        if (t === 'sticker' && (isThumbsUpStickerId(a.sticker_id) || !a.u)) return true;
    }

    if (!String(text).trim() && attType === 'sticker') return true;
    return false;
}

function parseFbAttachmentItem(a) {
    const type = String(a.type || (a.mime_type ? a.mime_type.split('/')[0] : 'file')).toLowerCase();
    const stickerId = a.payload?.sticker_id ?? a.sticker_id ?? null;
    const url = a.payload?.url || a.file_url || a.image_data?.url || '';

    if (stickerId && isThumbsUpStickerId(stickerId)) {
        return { t: 'like', u: url || null, sticker_id: stickerId };
    }
    if (type === 'like' || type === 'thumbs_up') {
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
        payload: a.payload,
        sticker_id: a.payload?.sticker_id ?? a.sticker_id,
        file_url: a.payload?.url
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
    const attachments = msg.attachments || (msg.attachment_type || msg.attachment_url
        ? [{ t: msg.attachment_type, u: msg.attachment_url }]
        : []);
    const like = isThumbsUpMessage({
        message: msg.message ?? msg.text,
        attachment_type: msg.attachment_type,
        attachment_url: msg.attachment_url,
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

    return {
        ...msg,
        message,
        message_id: msg.message_id || msg.mid || msg.id,
        from_me: msg.from_me != null ? msg.from_me : (msg.isFromPage ? 1 : 0),
        created_at: msg.created_at || msg.createdTime,
        attachment_url: msg.attachment_url || attachments[0]?.u || null,
        attachment_type: msg.attachment_type || attachments[0]?.t || null,
        is_like: false
    };
}

module.exports = {
    THUMBS_UP_STICKER_IDS,
    isThumbsUpMessage,
    isThumbsUpText,
    snippetIndicatesFromPage,
    normalizeSnippetForList,
    parseFbAttachments,
    parseWebhookAttachments,
    normalizeIncomingSave,
    snippetForMessage,
    normalizeMessengerMessage
};
