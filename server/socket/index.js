const state = require('../lib/state');

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
        socket.on('viewing_thread', ({ pageId, threadId, agentName }) => {
            if (!pageId || !threadId) return;
            socket.to(`page_${pageId}`).emit('agent_viewing', {
                pageId, threadId, agentName: agentName || 'Agent', socketId: socket.id
            });
        });
        socket.on('disconnect', () => {
            state.connectedSockets.delete(socket.id);
        });
    });
}

module.exports = { setupSocket };
