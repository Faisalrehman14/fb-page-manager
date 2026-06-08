/** API response shapes expected by messenger.js / web_ui.js */
const { toClientMessage, normalizeSnippetForList } = require('./message-content');

function mapConversation(c) {
    const snippet = normalizeSnippetForList(c.snippet || '');
    return {
        ...c,
        fb_user_id: c.participantId,
        user_name: c.participantName,
        user_picture: c.participantPicture || '',
        snippet,
        last_msg: snippet,
        last_from_me: c.lastMessageFromPage ? 1 : 0,
        last_msg_at: c.updatedTime,
        updated_at: c.updatedTime,
        is_unread: c.unreadCount || 0,
        page_id: c.pageId,
        psid: c.participantId,
        name: c.participantName,
        picture: c.participantPicture || '',
        lastMsg: snippet,
        lastFromMe: c.lastMessageFromPage ? 1 : 0,
        lastMsgAt: c.updatedTime,
        unread: c.unreadCount || 0,
        can_reply: c.canReply !== false ? 1 : 0
    };
}

function mapMessage(m) {
    const out = toClientMessage({
        ...m,
        fb_message_id: m.fb_message_id,
        message_id: m.fb_message_id || m.mid || m.message_id || m.id,
        message: m.text ?? m.message ?? '',
        text: m.text ?? m.message ?? '',
        direction: m.direction,
        from_me: m.from_me,
        isFromPage: m.isFromPage ?? m.is_from_page,
        created_at: m.created_at,
        fb_created_at: m.fb_created_at,
        createdTime: m.createdTime || m.fb_created_at || m.created_at,
        attachment_url: m.media_permanent_url || m.attachment_url || m.attachments?.[0]?.u || null,
        attachment_type: m.attachment_type || m.attachments?.[0]?.t || null,
        attachments: m.attachments,
        media_permanent_url: m.media_permanent_url,
        delivered_at: m.delivered_at,
        seen_at: m.seen_at,
        is_like: m.is_like
    });
    return out;
}

function mapPollMessage(m) {
    return toClientMessage({
        message_id: m.mid || m.message_id,
        message: m.text || m.message || '',
        from_me: m.isFromPage ? 1 : (m.from_me != null ? m.from_me : 0),
        created_at: m.createdTime || m.created_at,
        attachment_url: m.attachment_url || null,
        attachment_type: m.attachment_type || null,
        attachments: m.attachments,
        is_like: m.is_like
    });
}

/** Minimal payload for poll — smaller JSON over the wire */
function mapPollConvUpdate(r) {
    return {
        id: r.id,
        fb_user_id: r.fb_user_id,
        user_name: r.user_name,
        user_picture: r.user_picture || null,
        snippet: normalizeSnippetForList(r.snippet || ''),
        updated_at: r.updated_at,
        is_unread: r.is_unread || 0,
        last_from_me: r.last_from_me,
        can_reply: r.can_reply != null ? (r.can_reply !== 0 ? 1 : 0) : 1
    };
}

module.exports = { mapConversation, mapMessage, mapPollMessage, mapPollConvUpdate };
