/** Legacy route registration — composed from domain routers. */
const createRegisterContext = require('./lib/register-context');

const mountWebhook = require('./domains/webhook');
const mountLegacyPhp = require('./domains/legacy-php');
const mountOauth = require('./domains/oauth');
const mountAdmin = require('./domains/admin');
const mountSupport = require('./domains/support');
const mountAi = require('./domains/ai');
const mountNotifications = require('./domains/notifications');
const mountAuth = require('./domains/auth');
const mountPages = require('./domains/pages');
const mountInboxLegacy = require('./domains/inbox-legacy');
const mountBroadcast = require('./domains/broadcast');
const mountSpa = require('./domains/spa');

module.exports = function registerRoutes(app, deps) {
  const ctx = createRegisterContext(deps);
  mountWebhook(app, ctx);
  mountLegacyPhp(app, ctx);
  mountOauth(app, ctx);
  mountAdmin(app, ctx);
  mountSupport(app, ctx);
  mountAi(app, ctx);
  mountNotifications(app, ctx);
  mountAuth(app, ctx);
  mountPages(app, ctx);
  mountInboxLegacy(app, ctx);
  mountBroadcast(app, ctx);
  mountSpa(app, ctx);
  if (typeof ctx.startBroadcastScheduler === 'function') {
    deps.startBroadcastScheduler = ctx.startBroadcastScheduler;
  }
};
