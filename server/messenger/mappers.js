/** API response shapes expected by messenger.js / web_ui.js */
const { normalizeMessengerMessage } = require('./message-content');

function mapConversation(c) {
    return {
        ...c,
        fb_user_id: c.participantId,
        user_name: c.participantName,
        user_picture: c.participantPicture || '',
        snippet: c.snippet,
        last_msg: c.snippet,
        last_from_me: c.lastMessageFromPage ? 1 : 0,
        last_msg_at: c.updatedTime,
        updated_at: c.updatedTime,
        is_unread: c.unreadCount || 0,
        page_id: c.pageId,
        psid: c.participantId,
        name: c.participantName,
        picture: c.participantPicture || '',
        lastMsg: c.snippet,
        lastFromMe: c.lastMessageFromPage ? 1 : 0,
        lastMsgAt: c.updatedTime,
        unread: c.unreadCount || 0,
        can_reply: c.canReply !== false ? 1 : 0
    };
}

function mapMessage(m) {
    return normalizeMessengerMessage({
        ...m,
        message_id: m.mid || m.message_id || m.id,
        message: m.text || m.message || '',
        from_me: Object.prototype.hasOwnProperty.call(m, 'from_me')
            ? m.from_me
            : (m.isFromPage ? 1 : 0),
        created_at: m.createdTime || m.created_at,
        attachment_url: (m.attachments?.[0]?.u) || m.attachment_url || null,
        attachment_type: (m.attachments?.[0]?.t) || m.attachment_type || null,
        attachments: m.attachments
    });
}

function mapPollMessage(m) {
    return normalizeMessengerMessage({
        message_id: m.mid,
        message: m.text || '',
        from_me: m.isFromPage ? 1 : 0,
        created_at: m.createdTime,
        attachment_url: m.attachment_url || null,
        attachment_type: m.attachment_type || null
    });
}

/** Minimal payload for poll — smaller JSON over the wire */
function mapPollConvUpdate(r) {
    return {
        id: r.id,
        fb_user_id: r.fb_user_id,
        user_name: r.user_name,
        user_picture: r.user_picture || null,
        snippet: r.snippet,
        updated_at: r.updated_at,
        is_unread: r.is_unread || 0,
        last_from_me: r.last_from_me
    };
}

module.exports = { mapConversation, mapMessage, mapPollMessage, mapPollConvUpdate };
