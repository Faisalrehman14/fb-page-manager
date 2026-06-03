const express = require('express');
const api = require('../../lib/apiResponse');
const state = require('../../lib/state');

/**
 * API v1 — new endpoints use the standard { success, data, error } envelope.
 * Legacy /api/* routes remain unchanged for backward compatibility.
 */
function createV1Router() {
    const router = express.Router();

    router.get('/health', (req, res) => {
        api.ok(res, {
            status: 'ok',
            version: '1',
            db: state.dbConnected ? 'connected' : 'initializing',
            uptime: Math.floor(process.uptime())
        });
    });

    router.get('/meta', (req, res) => {
        api.ok(res, {
            name: 'FBCast Pro API',
            version: '1.0.0',
            domains: ['auth', 'pages', 'inbox', 'broadcast', 'schedules', 'admin'],
            docs: {
                legacy: '/api/*',
                v1: '/api/v1/*'
            }
        });
    });

    return router;
}

module.exports = { createV1Router };
