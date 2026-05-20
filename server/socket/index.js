const state = require('../lib/state');
const db = require('../db');

function threadHasLiveViewers(io, threadId) {
    if (!threadId) return false;
    const room = io.sockets.adapter.rooms.get(`thread_${threadId}`);
    return !!(room && room.size > 0);
}

function setupSocket(io, sessionMiddleware) {
    io.use((socket, next) => {
        sessionMiddleware(socket.request, {}, err => {
            if (err) return next(new Error('Session error'));
            if (!socket.request.session?.accessToken) return next(new Error('Unauthorized'));
            next();
        });
    });

    io.on('connection', socket => {
        state.connectedSockets.set(socket.id, { rooms: [], connectedAt: new Date().toISOString() });
        // Auto-join personal room for admin-pushed notifications targeted at this user
        const uid = socket.request.session?.userId;
        if (uid) socket.join(`user_${uid}`);
        socket.on('join_page', pageId => {
            if (!pageId || !/^\d+$/.test(String(pageId))) return;
            // If session already has page tokens, validate ownership
            const tokens = socket.request.session?.pageTokens || {};
            if (Object.keys(tokens).length > 0 && !tokens[pageId]) return;
            socket.join(`page_${pageId}`);
        });
        socket.on('leave_page', pageId => socket.leave(`page_${pageId}`));
        socket.on('join_thread', threadId => {
            if (!threadId || !/^\d+$/.test(String(threadId))) return;
            socket.join(`thread_${threadId}`);
        });
        socket.on('leave_thread', threadId => socket.leave(`thread_${threadId}`));
        socket.on('typing_start', ({ threadId, agentName }) => {
            if (threadId) {
                socket.to(`thread_${threadId}`).emit('agent_typing', {
                    threadId, agentName: agentName || 'Agent', typing: true
                });
            }
        });
        socket.on('typing_stop', ({ threadId }) => {
            if (threadId) socket.to(`thread_${threadId}`).emit('agent_typing', { threadId, typing: false });
        });
        // Agent presence — let other agents know who is viewing which thread
        socket.on('viewing_thread', async ({ pageId, threadId, psid, agentName }) => {
            if (!pageId || !threadId) return;
            socket.to(`page_${pageId}`).emit('agent_viewing', {
                pageId, threadId, agentName: agentName || 'Agent', socketId: socket.id
            });
            if (state.dbConnected) {
                try {
                    await db.markAsRead(threadId);
                    io.to(`page_${pageId}`).emit('thread_read', { pageId, psid, threadId });
                    io.to(`page_${pageId}`).emit('conversation_updated', {
                        id: threadId,
                        pageId,
                        participantId: psid || null,
                        isRead: true,
                        unreadCount: 0,
                        isLive: true
                    });
                } catch (_) { /* non-fatal */ }
            }
        });
        socket.on('disconnect', () => {
            state.connectedSockets.delete(socket.id);
        });
    });
}

module.exports = { setupSocket, threadHasLiveViewers };
