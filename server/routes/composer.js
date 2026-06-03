/**
 * Route composer — mounts versioned API first, then legacy monolith routes.
 * Split domain routes from register.js incrementally into routes/domains/.
 */
const { createV1Router } = require('./v1');
const mountBilling = require('./billing');
const registerLegacyRoutes = require('./register');

function composeRoutes(app, deps) {
    mountBilling(app, deps);
    app.use('/api/v1', createV1Router());
    registerLegacyRoutes(app, deps);
}

module.exports = composeRoutes;
