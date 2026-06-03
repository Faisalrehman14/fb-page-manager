/**
 * Application entry point — wires Express app and starts HTTP server.
 */
const { createApp } = require('./createApp');
const { startServer } = require('./bootstrap');

const { httpServer, io, startBroadcastScheduler } = createApp();
startServer(httpServer, { startBroadcastScheduler, io });
