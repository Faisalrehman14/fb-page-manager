/**
 * ═══════════════════════════════════════════════════════════
 *  FBCast Pro — SENIOR ARCHITECTURE v3.0
 *  Main Entry Point
 * ═══════════════════════════════════════════════════════════
 */

require('dotenv').config({ path: '../.env' });
const http = require('http');
const { Server } = require('socket.io');
const app = require('./src/app');

const server = http.createServer(app);
const PORT = process.env.PORT || 3000;

// Initialize Socket.io
const io = new Server(server, {
    cors: { origin: "*", methods: ["GET", "POST"] }
});

// Attach io to app instance for access in routes
app.set('io', io);

io.on('connection', (socket) => {
    socket.on('join_page', (pageId) => socket.join(`page_${pageId}`));
    socket.on('join_conv', (psid) => socket.join(`conv_${psid}`));
    socket.on('disconnect', () => {});
});

// Start Server
server.listen(PORT, () => {
    console.log(`
╔════════════════════════════════════════════════════════════════╗
║  FBCast Pro — SENIOR ENTERPRISE BACKEND ONLINE               ║
║  Environment: Production                                     ║
║  Port: ${PORT}                                                  ║
╚════════════════════════════════════════════════════════════════╝
    `);
});
