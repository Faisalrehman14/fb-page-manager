const { POLL_MAX_CONVS } = require('./config');
const { mapPollMessage, mapPollConvUpdate } = require('./mappers');

/**
 * Lightweight inbox poll — one DB round-trip batch, capped conv updates.
 * Returns `has_changes: false` when nothing is new so the client can skip
 * expensive DOM diffing on quiet polls.
 */
class PollService {
    constructor({ db }) {
        this.db = db;
    }

    async poll({ pageId, psid, since, dbConnected }) {
        if (!dbConnected) {
            return {
                has_changes: false,
                new_messages: [],
                updated_convs: [],
                total_unread: 0,
                server_time: new Date().toISOString()
            };
        }

        const batch = await this.db.pollInboxUpdates(pageId, psid || null, since, POLL_MAX_CONVS);

        const newMessages = (batch.newMessages || []).map(mapPollMessage);
        const updatedConvs = (batch.updatedConvs || []).map(mapPollConvUpdate);
        const totalUnread = batch.totalUnread || 0;

        return {
            has_changes: newMessages.length > 0 || updatedConvs.length > 0,
            new_messages: newMessages,
            updated_convs: updatedConvs,
            total_unread: totalUnread,
            server_time: new Date().toISOString()
        };
    }
}

module.exports = { PollService };
