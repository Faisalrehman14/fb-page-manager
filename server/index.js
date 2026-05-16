require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const express    = require('express');
const session    = require('express-session');
const crypto     = require('crypto');
const path       = require('path');
const fs         = require('fs');
const { createServer } = require('http');
const { Server } = require('socket.io');
const multer     = require('multer');
const compression = require('compression');
const rateLimit  = require('express-rate-limit');
const db         = require('./db');
const cookieParser = require('cookie-parser');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

const app        = express();
const httpServer = createServer(app);

const SESSION_SECRET = process.env.SESSION_SECRET || 'fb-cast-pro-session-secret-998877';

const sessionMiddleware = session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: true,
    store: (function() {
        try {
            const MySQLStore = require('express-mysql-session')(session);
            const options = {
                host: process.env.MYSQLHOST,
                port: process.env.MYSQLPORT || 3306,
                user: process.env.MYSQLUSER || 'root',
                password: process.env.MYSQLPASSWORD || process.env.MYSQL_ROOT_PASSWORD,
                database: process.env.MYSQL_DATABASE || process.env.MYSQLDATABASE,
                clearExpired: true,
                checkExpirationInterval: 900000,
                expiration: 86400000,
                createDatabaseTable: true
            };
            const durl = process.env.DATABASE_URL || process.env.MYSQL_URL;
            if (durl) {
                // Simplified URL parsing for MySQLStore
                try {
                    const u = new URL(durl);
                    options.host = u.hostname;
                    options.port = u.port || 3306;
                    options.user = u.username;
                    options.password = decodeURIComponent(u.password);
                    options.database = u.pathname.substring(1);
                } catch(err) {}
            }
            if (!options.host) return undefined;
            return new MySQLStore(options);
        } catch (e) {
            console.error('Session store init failed:', e.message);
            return undefined;
        }
    })(),
    cookie: {
        secure: false, // Railway handles SSL at proxy
        httpOnly: true,
        sameSite: 'lax',
        maxAge: 7 * 24 * 60 * 60 * 1000
    }
});
app.use(cookieParser(SESSION_SECRET));
app.use(sessionMiddleware);

// Industry Standard: Double Submit Cookie CSRF
app.use((req, res, next) => {
    let token = req.cookies?.CSRF_TOKEN || req.signedCookies?._csrf || req.session?.csrfToken;
    if (!token) {
        token = crypto.randomBytes(32).toString('hex');
    }
    // Set a plain cookie that frontend can read if needed, and a session token
    if (!req.cookies?.CSRF_TOKEN) {
        res.cookie('CSRF_TOKEN', token, { httpOnly: false, sameSite: 'lax', secure: false });
    }
    if (req.session && !req.session.csrfToken) {
        req.session.csrfToken = token;
    }
    req.generatedCsrf = token;
    next();
});
const io         = new Server(httpServer, {
    cors: { origin: '*', methods: ['GET', 'POST'] },
    transports: ['websocket', 'polling']
});

// ── Config ────────────────────────────────────────────────────────────────────
const PORT                 = process.env.PORT || 3000;
const FB_APP_ID            = (process.env.FB_APP_ID            || '').trim();
const FB_APP_SECRET        = (process.env.FB_APP_SECRET        || '').trim();
const BASE_URL             = (process.env.BASE_URL             || '').trim();
const WEBHOOK_VERIFY_TOKEN = (process.env.WEBHOOK_VERIFY_TOKEN || process.env.FB_WEBHOOK_VERIFY_TOKEN || 'ADMIN12345').trim();

let dbConnected = false;

// ── Logging ───────────────────────────────────────────────────────────────────
let requestLogs = [], webhookLogs = [], errorLogs = [];
const MAX_LOGS  = 100;

function logError(type, error, ctx = {}) {
    const entry = {
        id: `${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        time: new Date().toISOString(), type,
        message: error?.message || String(error),
        stack: error?.stack ? error.stack.split('\n').slice(0, 6).join('\n') : null,
        context: ctx
    };
    errorLogs.unshift(entry);
    if (errorLogs.length > MAX_LOGS) errorLogs.pop();
    console.error(`[ERROR:${type}]`, entry.message, Object.keys(ctx).length ? ctx : '');
    return entry;
}

process.on('unhandledRejection', r  => logError('unhandledRejection', r instanceof Error ? r : new Error(String(r))));
process.on('uncaughtException',  err => logError('uncaughtException',  err));

// ── Middleware ────────────────────────────────────────────────────────────────
app.set('trust proxy', 1);
app.use(compression());
app.use(rateLimit({ windowMs: 60000, max: 200, skip: req => req.url.includes('webhook') }));
app.use((req, res, next) => {
    if (req.url.includes('api') || req.method === 'POST') {
        requestLogs.unshift({ time: new Date().toISOString(), method: req.method, url: req.url });
        if (requestLogs.length > MAX_LOGS) requestLogs.pop();
    }
    next();
});
app.use(express.json({ verify: (req, res, buf) => { req.rawBody = buf; } }));
app.use(express.urlencoded({ extended: true }));

// ── Critical Healthcheck (Must be at the top) ─────────────────────────────────
app.get('/api/health', async (req, res) => {
    // Return 200 OK immediately for healthchecks, even if DB is still connecting
    res.json({ 
        status: 'ok', 
        db: dbConnected ? 'connected' : 'initializing',
        uptime: Math.floor(process.uptime()),
        memory: Math.round(process.memoryUsage().heapUsed / 1024 / 1024) + 'MB'
    });
});

// ── Facebook Webhook (must be before express.static so fb_webhook.php isn't served as raw PHP) ──
app.get(['/webhook', '/fb_webhook.php'], (req, res) => {
    const { 'hub.mode': mode, 'hub.verify_token': token, 'hub.challenge': challenge } = req.query;
    if (mode === 'subscribe' && token === WEBHOOK_VERIFY_TOKEN) return res.send(challenge);
    res.sendStatus(403);
});

app.post(['/webhook', '/fb_webhook.php'], async (req, res) => {
    if (FB_APP_SECRET) {
        const sig      = req.headers['x-hub-signature-256'] || '';
        const expected = 'sha256=' + crypto.createHmac('sha256', FB_APP_SECRET).update(req.rawBody || Buffer.alloc(0)).digest('hex');
        if (sig && sig !== expected) { logError('webhook_sig', new Error('Invalid signature')); return res.sendStatus(403); }
    }

    res.sendStatus(200);

    const { object, entry } = req.body;
    if (object !== 'page' || !entry) return;

    webhookLogs.unshift({ time: new Date().toISOString(), entries: entry.length });
    if (webhookLogs.length > MAX_LOGS) webhookLogs.pop();

    for (const pageEntry of entry) {
        const pageId = pageEntry?.id;
        if (!pageId) continue;

        for (const event of (pageEntry.messaging || [])) {
            try {
                // Delivery/read receipts have no message body — skip silently
                if (!event.message) continue;

                const isEcho        = !!event.message.is_echo;
                const participantId = isEcho ? event.recipient?.id : event.sender?.id;
                if (!participantId) {
                    logError('webhook_no_participant', new Error('Missing sender/recipient'), { pageId, eventKeys: Object.keys(event) });
                    continue;
                }

                // Deduplicate by message ID — FB retries on 200 ACK failure
                const mid  = event.message.mid || null;
                const text = (event.message.text || '').trim();
                const ts   = event.timestamp ? new Date(event.timestamp).toISOString() : new Date().toISOString();

                const attachments = (event.message.attachments || [])
                    .map(a => ({ t: a.type || 'file', u: a.payload?.url || '' }))
                    .filter(a => a.u);

                // ensureConversation creates or fetches the DB conversation ID
                const threadId = await db.ensureConversation(pageId, participantId);
                if (!threadId) {
                    logError('webhook_no_thread', new Error('ensureConversation returned null'), { pageId, participantId });
                    continue;
                }

                const saved = await db.saveMessage({
                    id: mid, threadId, pageId, senderId: participantId,
                    senderType: isEcho ? 'page' : 'user',
                    text, isFromPage: isEcho, createdTime: ts,
                    attachments: attachments.length ? attachments : null
                });

                if (!isEcho) {
                    // Always update conversation metadata regardless of DB save result
                    await db.onIncomingMessage(threadId, pageId, participantId, text || (attachments[0] ? `[${attachments[0].t}]` : ''));
                    const snippet = text || (attachments[0] ? `[${attachments[0].t}]` : 'Message');
                    io.to(`page_${pageId}`).emit('new_message',          { id: mid, threadId, pageId, participantId, text, isFromPage: false, createdTime: ts, attachments });
                    io.to(`page_${pageId}`).emit('conversation_updated', { id: threadId, pageId, participantId, snippet, updatedTime: new Date(), isRead: false, unreadCount: 1, lastMessageFromPage: false });
                }
            } catch (err) {
                logError('webhook_event', err, { pageId, eventSender: event?.sender?.id });
            }
        }
    }
});

// ── PHP-endpoint shims (Node.js replacements for legacy PHP calls) ────────────

// exchange_token.php — short-lived user token → long-lived token + page tokens
app.post(['/api/auth/exchange', '/api/exchange_token.php', '/exchange_token.php'], async (req, res) => {
    const userToken = (req.body?.user_token || '').trim();
    if (!userToken) return res.status(400).json({ error: 'user_token is required' });
    if (!FB_APP_ID || !FB_APP_SECRET) return res.status(500).json({ error: 'App credentials not configured' });

    try {
        // Step 1: Exchange short-lived → long-lived user token
        const exUrl  = `https://graph.facebook.com/v19.0/oauth/access_token?grant_type=fb_exchange_token&client_id=${FB_APP_ID}&client_secret=${FB_APP_SECRET}&fb_exchange_token=${encodeURIComponent(userToken)}`;
        const exRes  = await fetch(exUrl);
        const exData = await exRes.json();
        if (!exData.access_token) {
            const msg = exData.error?.message || 'Token exchange failed';
            return res.status(400).json({ error: msg });
        }
        const longToken = exData.access_token;

        // Step 2: Fetch pages with the long-lived token (~60-day page tokens)
        const pgUrl  = `https://graph.facebook.com/v19.0/me/accounts?fields=id,name,access_token,category,picture.type(large)&access_token=${encodeURIComponent(longToken)}`;
        const pgRes  = await fetch(pgUrl);
        const pgData = await pgRes.json();
        if (pgData.error) return res.status(400).json({ error: pgData.error.message || 'Failed to fetch pages' });

        // Step 3: Create server session so requireAuth passes
        req.session.accessToken = longToken;
        try {
            const meRes = await fetch(`https://graph.facebook.com/v19.0/me?fields=id,name&access_token=${encodeURIComponent(longToken)}`);
            const meData = await meRes.json();
            if (meData.id) {
                req.session.userId = meData.id;
                req.session.userName = meData.name;
            }
        } catch(e) {}
        
        // Set signed cookies for persistence across restarts
        const cookieOpts = { signed: true, httpOnly: true, sameSite: 'lax', maxAge: 7 * 24 * 60 * 60 * 1000 };
        res.cookie('_fb_at', longToken, cookieOpts);
        if (req.session.userId) res.cookie('_fb_uid', req.session.userId, cookieOpts);
        if (req.session.userName) res.cookie('_fb_un', req.session.userName, cookieOpts);
        
        generateCsrf(req);

        res.json({ success: true, pages: pgData.data || [], long_lived_token: longToken });
    } catch (err) {
        logError('exchange_token', err);
        res.status(500).json({ error: 'Token exchange failed' });
    }
});

// track_user.php — verify token + return quota info
app.post(['/api/auth/track', '/api/track_user.php', '/track_user.php'], async (req, res) => {
    const userToken = (req.body?.user_token || '').trim();
    if (!userToken) return res.status(400).json({ error: 'user_token is required' });

    try {
        const meRes  = await fetch(`https://graph.facebook.com/v19.0/me?fields=id,name&access_token=${encodeURIComponent(userToken)}`);
        const meData = await meRes.json();
        if (meData.error) return res.status(401).json({ error: meData.error.message });

        // Initialize/Fetch user quota from DB
        const quota = await db.updateUserQuota(meData.id, 0); // 0 = just fetch
        
        // Return format expected by index-page.js + web_ui.js
        res.json({ 
            success: true, 
            fb_user_id: meData.id, 
            fb_name: meData.name,
            subscriptionStatus: quota?.subscriptionStatus || 'free',
            messageLimit: quota?.messageLimit || 2000,
            messagesUsed: quota?.messenger_messagesUsed || 0,
            plan: quota?.subscriptionStatus || 'free'
        });
    } catch (err) {
        logError('track_user', err);
        res.status(500).json({ error: 'Tracking failed' });
    }
});

// ── Facebook OAuth Flow ───────────────────────────────────────────────────
app.get(['/api/auth/start', '/oauth_start.php'], (req, res) => {
    const state = crypto.randomBytes(16).toString('hex');
    req.session.fb_oauth_state = state;
    req.session.fb_oauth_ts    = Date.now();
    
    const siteUrl = (process.env.SITE_URL || '').trim() || `http://localhost:${PORT}`;
    const redirectUri = siteUrl.replace(/\/$/, '') + '/oauth_callback.php';
    const appId = (process.env.FB_APP_ID || '').trim();
    const oauthUrl = `https://www.facebook.com/dialog/oauth?client_id=${appId}&redirect_uri=${encodeURIComponent(redirectUri)}&scope=pages_show_list,pages_messaging,pages_read_engagement,pages_manage_metadata&response_type=code&state=${state}`;
    
    res.redirect(oauthUrl);
});

app.get(['/api/auth/callback', '/oauth_callback.php'], async (req, res) => {
    const { state, code, error, error_description } = req.query;
    const storedState = req.session.fb_oauth_state;
    const oauthTs     = req.session.fb_oauth_ts;
    
    const sendPopupResult = (data) => {
        res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"><title>Connecting Facebook</title>
<style>
  body { font-family: system-ui; background: #0a0d14; color: #fff; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin:0; }
  .card { background: #161b26; border: 1px solid rgba(255,255,255,.1); border-radius: 16px; padding: 40px; text-align: center; max-width: 340px; width: 100%; }
  .spinner { width: 40px; height: 40px; border: 3px solid rgba(255,255,255,.1); border-top-color: #1877f2; border-radius: 50%; animation: spin 0.8s linear infinite; margin: 0 auto 20px; }
  @keyframes spin { to { transform: rotate(360deg); } }
  .error { color: #ef4444; font-size: 14px; margin-top: 12px; }
  .btn { background:#1877f2; color:white; border:none; padding:10px 20px; border-radius:8px; cursor:pointer; margin-top:20px; font-weight:600; display:none; }
</style>
</head>
<body>
<div class="card">
  <div id="loader" class="spinner"></div>
  <h2 id="title">${data.error ? 'Connection failed' : 'Connecting your Facebook...'}</h2>
  <p id="sub">${data.error ? '' : 'This window will close automatically.'}</p>
  ${data.error ? `<p class="error">${data.error}</p>` : ''}
  <button id="closeBtn" class="btn" onclick="window.close()">Close Window</button>
</div>
<script>
  const RESULT = ${JSON.stringify(data)};
  let attempts = 0;
  function trySend() {
    if (!window.opener) {
      if (++attempts < 20) {
        setTimeout(trySend, 150);
      } else {
        document.getElementById('loader').style.display = 'none';
        document.getElementById('title').textContent = "Connection complete!";
        document.getElementById('sub').textContent = "Please go back to the main window.";
        document.getElementById('closeBtn').style.display = 'inline-block';
      }
      return;
    }
    // Use '*' to avoid origin mismatch issues between https/http/domain
    window.opener.postMessage(RESULT, "*");
    setTimeout(() => window.close(), 1000);
  }
  trySend();
</script>
</body>
</html>`);
    };

    if (error) return sendPopupResult({ type: 'fb_auth_error', error: error_description || 'Authorization denied' });
    if (!state || !storedState || state !== storedState || (Date.now() - oauthTs) > 600000) {
        return sendPopupResult({ type: 'fb_auth_error', error: 'Security check failed. Please retry.' });
    }
    
    delete req.session.fb_oauth_state;
    delete req.session.fb_oauth_ts;

    const siteUrl = (process.env.SITE_URL || '').trim() || `http://localhost:${PORT}`;
    const redirectUri = siteUrl.replace(/\/$/, '') + '/oauth_callback.php';
    try {
        // 1. Code -> Short Token
        const appId = (process.env.FB_APP_ID || '').trim();
        const appSecret = (process.env.FB_APP_SECRET || '').trim();
        const tokenRes = await fetch(`https://graph.facebook.com/v19.0/oauth/access_token?client_id=${appId}&client_secret=${appSecret}&redirect_uri=${encodeURIComponent(redirectUri)}&code=${code}`);
        const tokenData = await tokenRes.json();
        if (tokenData.error) throw new Error(tokenData.error.message);

        // 2. Short -> Long Token
        const longRes = await fetch(`https://graph.facebook.com/v19.0/oauth/access_token?grant_type=fb_exchange_token&client_id=${process.env.FB_APP_ID}&client_secret=${process.env.FB_APP_SECRET}&fb_exchange_token=${tokenData.access_token}`);
        const longData = await longRes.json();
        const userToken = longData.access_token || tokenData.access_token;

        // 3. Get Pages
        const pagesRes = await fetch(`https://graph.facebook.com/v19.0/me/accounts?fields=id,name,access_token,category,picture.type(large)&access_token=${userToken}`);
        const pagesData = await pagesRes.json();
        
        sendPopupResult({
            type: 'fb_auth_success',
            token: userToken,
            expiresIn: longData.expires_in || 5184000,
            pages: pagesData.data || []
        });
    } catch (err) {
        logError('oauth_callback', err);
        sendPopupResult({ type: 'fb_auth_error', error: err.message });
    }
});

// Actually, we should redirect legacy PHP calls to their API equivalents
app.use((req, res, next) => {
    if (req.path.endsWith('.php')) {
        const filename = path.basename(req.path);
        const legacyMap = {
            'index.php': '/',
            'get_csrf.php': '/api/csrf-token',
            'fb_proxy.php': '/api/fb-proxy',
            'exchange_token.php': '/api/auth/fb-token',
            'track_user.php': '/api/auth/track',
            'upload_image.php': '/api/upload-image',
            'messenger_api.php': '/api/messenger',
            'oauth_start.php': '/api/auth/start',
            'oauth_callback.php': '/api/auth/callback',
            'create_checkout.php': '/api/billing/checkout',
            'fb_webhook.php': '/api/webhook',
            'admin.php': '/api/admin'
        };
        if (legacyMap[filename]) {
            req.url = legacyMap[filename];
            return next();
        }
        // If it's not a mapped route, still block raw PHP
        return res.status(404).json({ error: 'Not found', hint: 'Use /api/* routes', path: req.path });
    }
    next();
});

// Admin stub
app.get('/api/admin', (req, res) => {
    res.json({ error: 'Maintenance', message: 'Admin panel is currently being migrated to Node.js. Please use the main dashboard.' });
});

// Root route handler
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'index.html'));
});

// Serve static assets from project root
// Redirect /index.html to / to ensure config injection
app.get('/index.html', (req, res) => res.redirect('/'));

app.use(express.static(path.join(__dirname, '..'), { maxAge: '1h', etag: true, index: false }));


// Share session with Socket.io
io.use((socket, next) => {
    sessionMiddleware(socket.request, {}, err => {
        if (err) return next(new Error('Session error'));
        if (!socket.request.session?.accessToken) return next(new Error('Unauthorized'));
        next();
    });
});

// ── CSRF + Auth Helpers ───────────────────────────────────────────────────────
function generateCsrf(req) {
    if (!req.session.csrfToken) req.session.csrfToken = crypto.randomBytes(32).toString('hex');
    return req.session.csrfToken;
}
function verifyCsrf(req, res, next) {
    if (req.method === 'GET') return next();
    const h = req.headers['x-csrf-token'];
    const c = req.cookies?.CSRF_TOKEN || req.signedCookies?._csrf || req.session?.csrfToken;
    
    // Fallback: If header is missing but cookie is present, we trust the cookie 
    // because it's set with SameSite=Lax.
    if (!h && c) {
        return next();
    }
    
    if (!h || h !== c) {
        console.warn(`[CSRF] Rejecting ${req.method} ${req.url}: header=${h}, cookie=${req.cookies?.CSRF_TOKEN}, session=${req.session?.csrfToken}`);
        return res.status(403).json({ error: 'Invalid CSRF token' });
    }
    next();
}
function requireAuth(req, res, next) {
    if (!req.session.accessToken) return res.status(401).json({ redirect: '/' });
    next();
}

// Session Restoration Fallback: If session is lost but signed cookies exist, restore it
app.use((req, res, next) => {
    if (req.session && !req.session.accessToken && req.signedCookies?._fb_at) {
        req.session.accessToken = req.signedCookies._fb_at;
        req.session.userId      = req.signedCookies._fb_uid;
        req.session.userName    = req.signedCookies._fb_un;
    }
    next();
});

// ── Socket.io Rooms ───────────────────────────────────────────────────────────
const connectedSockets = new Map();
const syncCooldown     = new Map();
const syncAllCooldown  = new Map();

io.on('connection', socket => {
    connectedSockets.set(socket.id, { rooms: [], connectedAt: new Date().toISOString() });
    socket.on('join_page',    pageId   => socket.join(`page_${pageId}`));
    socket.on('leave_page',   pageId   => socket.leave(`page_${pageId}`));
    socket.on('join_thread',  threadId => socket.join(`thread_${threadId}`));
    socket.on('leave_thread', threadId => socket.leave(`thread_${threadId}`));
    socket.on('typing_start', ({ threadId, agentName }) => {
        if (threadId) socket.to(`thread_${threadId}`).emit('agent_typing', { threadId, agentName: agentName || 'Agent', typing: true });
    });
    socket.on('typing_stop', ({ threadId }) => {
        if (threadId) socket.to(`thread_${threadId}`).emit('agent_typing', { threadId, typing: false });
    });
    socket.on('disconnect', () => connectedSockets.delete(socket.id));
});


// ── Auth ──────────────────────────────────────────────────────────────────────
app.get('/api/csrf-token', (req, res) => {
    const token = generateCsrf(req);
    req.session.save(() => {
        res.json({ csrfToken: token, token: token });
    });
});

// Bridge: accept FB user token from old JS-SDK auth flow → create server session
app.post('/api/auth/fb-token', async (req, res) => {
    const { user_token } = req.body;
    if (!user_token) return res.status(400).json({ error: 'user_token required' });
    try {
        const uRes  = await fetch(`https://graph.facebook.com/v19.0/me?fields=id,name&access_token=${user_token}`);
        const uData = await uRes.json();
        if (uData.error) return res.status(401).json({ error: uData.error.message });
        req.session.accessToken = user_token;
        req.session.userId      = uData.id;
        req.session.userName    = uData.name;
        req.session.firstLogin  = !req.session.firstLogin ? true : false;
        
        // Set signed cookies for persistence
        const cookieOpts = { signed: true, httpOnly: true, sameSite: 'lax', maxAge: 7 * 24 * 60 * 60 * 1000 };
        res.cookie('_fb_at', user_token, cookieOpts);
        res.cookie('_fb_uid', uData.id, cookieOpts);
        res.cookie('_fb_un', uData.name, cookieOpts);

        generateCsrf(req);
        res.json({ authenticated: true, userName: uData.name, csrfToken: req.session.csrfToken });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/auth/login', (req, res) => {
    const state = crypto.randomBytes(16).toString('hex');
    req.session.oauthState = state;
    const redirectUri = `${BASE_URL}/api/auth/callback`;
    const scope = 'pages_show_list,pages_messaging,pages_read_engagement,pages_manage_metadata';
    res.json({ authUrl: `https://www.facebook.com/v19.0/dialog/oauth?client_id=${FB_APP_ID}&redirect_uri=${encodeURIComponent(redirectUri)}&scope=${scope}&state=${state}&response_type=code` });
});

app.get('/api/auth/callback', async (req, res) => {
    const { code, state, error } = req.query;
    if (error)  return res.redirect('/?error=' + encodeURIComponent(error));
    if (!state || state !== req.session.oauthState) return res.redirect('/?error=invalid_state');
    try {
        const redirectUri = `${BASE_URL}/api/auth/callback`;
        const tRes  = await fetch(`https://graph.facebook.com/v19.0/oauth/access_token?client_id=${FB_APP_ID}&redirect_uri=${encodeURIComponent(redirectUri)}&client_secret=${FB_APP_SECRET}&code=${code}`);
        const tData = await tRes.json();
        if (tData.error) throw new Error(tData.error.message);

        const uRes  = await fetch(`https://graph.facebook.com/v19.0/me?fields=id,name&access_token=${tData.access_token}`);
        const uData = await uRes.json();
        if (uData.error) throw new Error(uData.error.message);

        req.session.accessToken = tData.access_token;
        req.session.userId      = uData.id;
        req.session.userName    = uData.name;
        req.session.oauthState  = null;
        req.session.firstLogin  = true;
        res.redirect('/');
    } catch (err) {
        logError('auth_callback', err);
        res.redirect('/?error=' + encodeURIComponent('Login failed: ' + err.message));
    }
});

app.get('/api/auth/status', (req, res) => {
    if (req.session.accessToken) res.json({ authenticated: true, userName: req.session.userName, userId: req.session.userId });
    else res.json({ authenticated: false });
});

app.post('/api/auth/logout', verifyCsrf, (req, res) => { req.session.destroy(); res.json({ redirect: '/' }); });

// ── Pages ─────────────────────────────────────────────────────────────────────
app.get('/api/pages', requireAuth, async (req, res) => {
    try {
        const fbRes = await fetch(`https://graph.facebook.com/v19.0/me/accounts?fields=id,name,picture,access_token&access_token=${req.session.accessToken}`);
        const data  = await fbRes.json();
        if (data.error) throw new Error(data.error.message);

        req.session.pageTokens = {};
        const pagesToSave = (data.data || []).map(p => ({ id: p.id, name: p.name, picture: p.picture?.data?.url, accessToken: p.access_token }));

        if (dbConnected) {
            await db.savePages(pagesToSave);
            
            // Parallel Smart Sync for all pages
            Promise.allSettled(pagesToSave.map(p =>
                db.syncPageSmart(p.id, p.accessToken, fetch, prog => io.to(`page_${p.id}`).emit('sync_progress', prog))
                    .catch(err => logError('smart_sync', err, { pageId: p.id }))
            )).then(() => pagesToSave.forEach(p => io.to(`page_${p.id}`).emit('sync_progress', { phase: 'done' })));
        }

        (data.data || []).forEach(p => { req.session.pageTokens[p.id] = p.access_token; });

        // Auto-subscribe pages to webhook events — log failures so webhook issues are visible
        for (const p of (data.data || [])) {
            fetch(`https://graph.facebook.com/v19.0/${p.id}/subscribed_apps`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ subscribed_fields: ['messages', 'messaging_postbacks', 'message_deliveries', 'message_reads', 'conversations'], access_token: p.access_token })
            }).then(async r => {
                const d = await r.json().catch(() => ({}));
                if (!r.ok || d.error) logError('webhook_subscribe', new Error(d.error?.message || 'subscribe failed'), { pageId: p.id });
            }).catch(err => logError('webhook_subscribe_net', err, { pageId: p.id }));
        }

        const pageIds      = (data.data || []).map(p => p.id);
        const unreadCounts = dbConnected ? await db.getUnreadCountsForPages(pageIds) : {};

        res.json({
            pages: (data.data || []).map(p => ({
                id: p.id, name: p.name, picture: p.picture?.data?.url,
                access_token: p.access_token, unreadCount: unreadCounts[p.id] || 0
            }))
        });
    } catch (err) {
        logError('pages_route', err);
        res.status(500).json({ error: err.message });
    }
});

// ── Conversations ─────────────────────────────────────────────────────────────
app.get('/api/pages/:pageId/conversations', requireAuth, async (req, res) => {
    const { pageId } = req.params;
    let token = req.session.pageTokens?.[pageId] || (dbConnected ? await db.getPageToken(pageId) : null);
    if (!token) return res.status(401).json({ error: 'Page token not found. Reload pages.', tokenMissing: true });

    const limit    = Math.min(parseInt(req.query.limit)  || 100, 200);
    const offset   = Math.max(parseInt(req.query.offset) || 0, 0);
    const archived = req.query.archived === 'true';

    try {
        if (dbConnected) {
            const [convs, total] = await Promise.all([
                db.getConversations(pageId, limit, offset, archived),
                offset === 0 ? db.getConversationCount(pageId, archived) : Promise.resolve(null)
            ]);
            if (convs.length > 0 || offset > 0) {
                res.json({ conversations: convs, hasMore: convs.length === limit, offset, total, fromCache: true });
                if (offset === 0 && !archived) {
                    const now = Date.now(), last = syncCooldown.get(pageId) || 0;
                    if (now - last > 60000) {
                        syncCooldown.set(pageId, now);
                        db.syncConversationsFromFacebook(pageId, token, fetch).catch(err => logError('bg_sync', err, { pageId }));
                    }
                }
                return;
            }
        }
        const convs = await db.syncConversationsFromFacebook(pageId, token, fetch);
        res.json({ conversations: convs, hasMore: false, offset: 0, total: convs.length, fromCache: false });
    } catch (err) {
        logError('conversations_route', err, { pageId });
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/pages/:pageId/conversations/search', requireAuth, async (req, res) => {
    const q = (req.query.q || '').trim();
    if (!q || !dbConnected) return res.json({ conversations: [] });
    try { res.json({ conversations: await db.searchConversations(req.params.pageId, q, 30) }); }
    catch (err) { res.status(500).json({ error: err.message, conversations: [] }); }
});

app.post('/api/pages/:pageId/mark-all-read', requireAuth, verifyCsrf, async (req, res) => {
    if (!dbConnected) return res.status(503).json({ error: 'DB not connected' });
    try {
        const count = await db.markAllAsRead(req.params.pageId);
        io.to(`page_${req.params.pageId}`).emit('all_read', { pageId: req.params.pageId });
        res.json({ ok: true, updated: count });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Messages ──────────────────────────────────────────────────────────────────
app.get('/api/threads/:threadId/messages', requireAuth, async (req, res) => {
    const { threadId } = req.params;
    const pageId = req.query.pageId;
    let token = req.session.pageTokens?.[pageId] || (dbConnected ? await db.getPageToken(pageId) : null);
    if (!token) return res.status(401).json({ error: 'Page token not found', tokenMissing: true });

    try {
        const fmt = m => ({ id: m.id, text: m.text, attachments: m.attachments || [], isFromPage: m.isFromPage, senderId: m.senderId, createdTime: m.createdTime });
        if (dbConnected) {
            const cached = await db.getMessages(threadId, parseInt(req.query.limit) || 100);
            if (cached.length > 0) {
                res.json({ messages: cached.map(fmt), fromCache: true });
                db.syncMessagesFromFacebook(threadId, pageId, token, fetch).catch(() => {});
                return;
            }
        }
        const msgs = await db.syncMessagesFromFacebook(threadId, pageId, token, fetch);
        res.json({ messages: msgs.map(fmt), fromCache: false });
    } catch (err) {
        logError('messages_route', err, { threadId, pageId });
        res.status(500).json({ error: err.message });
    }
});

// ── Send Message ──────────────────────────────────────────────────────────────
app.post('/api/threads/:threadId/reply', requireAuth, verifyCsrf, async (req, res) => {
    const { threadId } = req.params;
    const { pageId, recipientId, message } = req.body;
    if (!pageId      || !/^\d+$/.test(pageId))      return res.status(400).json({ error: 'Invalid pageId' });
    if (!recipientId || !/^\d+$/.test(recipientId)) return res.status(400).json({ error: 'Invalid recipientId' });
    if (!message || !message.trim())                return res.status(400).json({ error: 'Message required' });
    if (message.length > 2000)                      return res.status(400).json({ error: 'Message too long' });

    let token = req.session.pageTokens?.[pageId] || (dbConnected ? await db.getPageToken(pageId) : null);
    if (!token) return res.status(401).json({ error: 'Page token not found', tokenMissing: true });

    try {
        const fbRes = await fetch(`https://graph.facebook.com/v19.0/me/messages?access_token=${token}`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ recipient: { id: recipientId }, message: { text: message.trim() } })
        });
        const data = await fbRes.json();
        if (data.error) throw new Error(data.error.message);

        const createdTime = new Date().toISOString();
        if (dbConnected) {
            await db.saveMessage({ id: data.message_id, threadId, pageId, senderId: pageId, senderType: 'page', text: message.trim(), isFromPage: true, createdTime });
            await db.markAsRead(threadId);
        }

        res.json({ success: true, messageId: data.message_id });
        // Emit AFTER HTTP response so the optimistic tempId element is already in DOM when socket fires
        setImmediate(() => {
            io.to(`page_${pageId}`).emit('new_message',          { id: data.message_id, threadId, text: message.trim(), isFromPage: true, senderId: pageId, createdTime });
            io.to(`page_${pageId}`).emit('conversation_updated', { id: threadId, pageId, snippet: message.trim(), updatedTime: new Date(), isRead: true, unreadCount: 0, lastMessageFromPage: true });
        });
    } catch (err) {
        logError('reply_route', err, { pageId, threadId });
        res.status(500).json({ error: err.message });
    }
});

// ── Read / Unread ─────────────────────────────────────────────────────────────
app.post('/api/threads/:threadId/read', requireAuth, verifyCsrf, async (req, res) => {
    const pageId = req.body?.pageId || req.query?.pageId;
    if (dbConnected) await db.markAsRead(req.params.threadId).catch(() => {});
    if (pageId) io.to(`page_${pageId}`).emit('conversation_updated', { id: req.params.threadId, pageId, isRead: true, unreadCount: 0, isLive: true });
    res.json({ success: true });
});

app.post('/api/threads/:threadId/unread', requireAuth, verifyCsrf, async (req, res) => {
    const pageId = req.body?.pageId;
    if (dbConnected) await db.markAsUnread(req.params.threadId).catch(() => {});
    if (pageId) io.to(`page_${pageId}`).emit('conversation_updated', { id: req.params.threadId, pageId, isRead: false, unreadCount: 1, isLive: true });
    res.json({ success: true });
});

// ── Archive ───────────────────────────────────────────────────────────────────
app.post('/api/threads/:threadId/archive', requireAuth, verifyCsrf, async (req, res) => {
    if (!dbConnected) return res.status(503).json({ error: 'DB not connected' });
    try {
        await db.archiveConversation(req.params.threadId, req.body.pageId);
        io.to(`page_${req.body.pageId}`).emit('conversation_archived', { convId: req.params.threadId, pageId: req.body.pageId });
        res.json({ ok: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/threads/:threadId/unarchive', requireAuth, verifyCsrf, async (req, res) => {
    if (!dbConnected) return res.status(503).json({ error: 'DB not connected' });
    try {
        await db.unarchiveConversation(req.params.threadId, req.body.pageId);
        io.to(`page_${req.body.pageId}`).emit('conversation_unarchived', { convId: req.params.threadId, pageId: req.body.pageId });
        res.json({ ok: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Notes ─────────────────────────────────────────────────────────────────────
app.get('/api/threads/:threadId/notes', requireAuth, async (req, res) => {
    if (!dbConnected) return res.json({ notes: [] });
    try { res.json({ notes: await db.getNotes(req.params.threadId) }); }
    catch (err) { res.status(500).json({ error: err.message, notes: [] }); }
});

app.post('/api/threads/:threadId/notes', requireAuth, verifyCsrf, async (req, res) => {
    if (!dbConnected) return res.status(503).json({ error: 'DB not connected' });
    const { body, pageId } = req.body;
    if (!body?.trim()) return res.status(400).json({ error: 'Note body required' });
    try {
        const note = await db.saveNote(req.params.threadId, pageId, req.session.userName || 'Agent', body.trim());
        io.to(`thread_${req.params.threadId}`).emit('note_added', { threadId: req.params.threadId, note });
        res.json({ note });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/threads/:threadId/notes/:noteId', requireAuth, verifyCsrf, async (req, res) => {
    if (!dbConnected) return res.status(503).json({ error: 'DB not connected' });
    try {
        await db.deleteNote(req.params.noteId, req.body.pageId);
        io.to(`thread_${req.params.threadId}`).emit('note_deleted', { threadId: req.params.threadId, noteId: parseInt(req.params.noteId) });
        res.json({ ok: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Canned Replies ────────────────────────────────────────────────────────────
app.get('/api/canned-replies', requireAuth, async (req, res) => {
    try { res.json({ replies: await db.getCannedReplies(req.session.userId) }); }
    catch (err) { res.status(500).json({ error: err.message, replies: [] }); }
});
app.post('/api/canned-replies', requireAuth, verifyCsrf, async (req, res) => {
    const { title, body } = req.body;
    if (!title?.trim() || !body?.trim()) return res.status(400).json({ error: 'Title and body required' });
    try { res.json({ reply: await db.saveCannedReply(req.session.userId, title.trim(), body.trim()) }); }
    catch (err) { res.status(500).json({ error: err.message }); }
});
app.delete('/api/canned-replies/:id', requireAuth, verifyCsrf, async (req, res) => {
    try { await db.deleteCannedReply(req.session.userId, req.params.id); res.json({ success: true }); }
    catch (err) { res.status(500).json({ error: err.message }); }
});

// ── File Attachment ───────────────────────────────────────────────────────────
app.post('/api/threads/:threadId/attach', requireAuth, verifyCsrf, upload.single('file'), async (req, res) => {
    const { threadId } = req.params;
    const { pageId, recipientId } = req.body;
    const file = req.file;
    if (!pageId      || !/^\d+$/.test(pageId))      return res.status(400).json({ error: 'Invalid pageId' });
    if (!recipientId || !/^\d+$/.test(recipientId)) return res.status(400).json({ error: 'Invalid recipientId' });
    if (!file)                                       return res.status(400).json({ error: 'No file' });

    let token = req.session.pageTokens?.[pageId] || (dbConnected ? await db.getPageToken(pageId) : null);
    if (!token) return res.status(401).json({ error: 'Page token not found' });

    try {
        const mime       = file.mimetype;
        const attachType = mime.startsWith('image/') ? 'image' : mime.startsWith('video/') ? 'video' : 'file';
        const form       = new FormData();
        form.append('recipient', JSON.stringify({ id: recipientId }));
        form.append('message',   JSON.stringify({ attachment: { type: attachType, payload: { is_reusable: false } } }));
        form.append('filedata',  new Blob([file.buffer], { type: mime }), file.originalname || 'upload');
        const fbRes = await fetch(`https://graph.facebook.com/v19.0/me/messages?access_token=${token}`, { method: 'POST', body: form });
        const data  = await fbRes.json();
        if (data.error) throw new Error(data.error.message);
        const createdTime = new Date().toISOString();
        if (dbConnected) {
            await db.saveMessage({ id: data.message_id, threadId, pageId, senderId: pageId, senderType: 'page', text: '', isFromPage: true, createdTime, attachments: [{ t: attachType, u: '' }] });
        }
        io.to(`page_${pageId}`).emit('new_message',        { id: data.message_id, threadId, text: '', isFromPage: true, createdTime, attachments: [{ t: attachType, u: '' }] });
        io.to(`page_${pageId}`).emit('conversation_updated', { id: threadId, pageId, snippet: `[${attachType}]`, updatedTime: new Date(), isRead: true, unreadCount: 0, lastMessageFromPage: true });
        res.json({ success: true, messageId: data.message_id });
    } catch (err) {
        logError('attach_route', err, { pageId, threadId });
        res.status(500).json({ error: err.message });
    }
});

// ── Messenger Image Upload ────────────────────────────────────────────────────
app.post('/api/messenger/upload', requireAuth, upload.single('file'), async (req, res) => {
    const { page_id: pageId, psid, page_token: bodyToken } = req.body;
    const file = req.file;
    if (!pageId      || !/^\d+$/.test(pageId)) return res.status(400).json({ error: 'Invalid page_id' });
    if (!psid        || !/^\d+$/.test(psid))   return res.status(400).json({ error: 'Invalid psid' });
    if (!file)                                  return res.status(400).json({ error: 'No file uploaded' });

    const token = req.session.pageTokens?.[pageId] || (dbConnected ? await db.getPageToken(pageId) : null) || bodyToken;
    if (!token) return res.status(401).json({ error: 'Page token not found' });

    try {
        const mime       = file.mimetype;
        const attachType = mime.startsWith('image/') ? 'image' : mime.startsWith('video/') ? 'video' : 'file';
        const form       = new FormData();
        form.append('recipient', JSON.stringify({ id: psid }));
        form.append('message',   JSON.stringify({ attachment: { type: attachType, payload: { is_reusable: false } } }));
        form.append('filedata',  new Blob([file.buffer], { type: mime }), file.originalname || 'upload');
        const fbRes = await fetch(`https://graph.facebook.com/v19.0/me/messages?access_token=${token}`, { method: 'POST', body: form });
        const data  = await fbRes.json();
        if (data.error) throw new Error(data.error.message);

        if (dbConnected && data.message_id) {
            const convInfo = await db.getConversationIdByParticipant(pageId, psid);
            if (convInfo?.id) {
                await db.saveMessage({ id: data.message_id, conversationId: convInfo.id, pageId, senderId: pageId, senderType: 'page', text: '', isFromPage: true, createdTime: new Date().toISOString(), attachments: [{ t: attachType, u: '' }] });
            }
        }
        io.to(`page_${pageId}`).emit('new_message', { id: data.message_id, psid, text: '', isFromPage: true, createdTime: new Date().toISOString(), attachments: [{ t: attachType, u: '' }] });
        res.json({ success: true, message_id: data.message_id });
    } catch (err) {
        logError('messenger_upload', err, { pageId, psid });
        res.status(500).json({ error: err.message });
    }
});

// ── FB Proxy ──────────────────────────────────────────────────────────────────
app.post('/api/fb-proxy', verifyCsrf, async (req, res) => {
    const { method = 'GET', path: fbPath, token, params = {}, body = {}, url: fullUrl } = req.body;
    
    let url;
    if (fullUrl) {
        if (!fullUrl.startsWith('https://graph.facebook.com')) {
            return res.status(400).json({ error: 'Invalid URL host' });
        }
        url = fullUrl;
    } else if (fbPath) {
        if (!token) return res.status(400).json({ error: 'token is required' });
        const cleanPath = fbPath.replace(/^\/+/, '');
        const queryParams = new URLSearchParams(params);
        queryParams.set('access_token', token);
        url = `https://graph.facebook.com/v19.0/${cleanPath}?${queryParams.toString()}`;
    } else {
        return res.status(400).json({ error: 'path or url is required' });
    }

    try {
        const fetchOptions = {
            method: method === 'UPLOAD_IMAGE' ? 'POST' : method,
            headers: {}
        };

        if (method === 'POST') {
            fetchOptions.headers['Content-Type'] = 'application/x-www-form-urlencoded';
            const formBody = new URLSearchParams();
            for (const [k, v] of Object.entries(body)) {
                formBody.append(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
            }
            fetchOptions.body = formBody.toString();
        }

        const fbRes = await fetch(url, fetchOptions);
        const data = await fbRes.json();
        res.status(fbRes.status).json(data);
    } catch (err) {
        logError('fb_proxy', err);
        res.status(502).json({ error: 'Proxy connection error' });
    }
});

// ── Upload Image ─────────────────────────────────────────────────────────────
const diskStorage = multer.diskStorage({
    destination: (req, file, cb) => {
        const dir = path.join(__dirname, '../uploads');
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        cb(null, dir);
    },
    filename: (req, file, cb) => {
        const ext = path.extname(file.originalname) || '.jpg';
        cb(null, crypto.randomBytes(16).toString('hex') + ext);
    }
});
const uploadDisk = multer({ 
    storage: diskStorage, 
    limits: { fileSize: 5 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        if (file.mimetype.startsWith('image/')) cb(null, true);
        else cb(new Error('Only images allowed'));
    }
});

app.post('/api/upload-image', verifyCsrf, uploadDisk.single('image'), (req, res) => {
    if (!req.file) return res.status(400).json({ success: false, error: 'No file uploaded' });
    
    const proto = req.headers['x-forwarded-proto'] || 'https';
    const host = req.headers['x-forwarded-host'] || req.headers.host || '';
    const siteUrl = process.env.SITE_URL || BASE_URL || (host ? `${proto}://${host}` : '');
    const url = `${siteUrl.replace(/\/$/, '')}/uploads/${req.file.filename}`;
    
    res.json({ success: true, url, filename: req.file.filename });
});

app.use('/uploads', express.static(path.join(__dirname, '../uploads')));

// ── Messenger API ────────────────────────────────────────────────────────────
app.all(['/api/messenger', '/messenger_api.php'], requireAuth, async (req, res) => {
    const method = req.method;
    const action = req.query.action || req.body.action;
    const pageId = req.query.page_id || req.body.page_id;

    if (!action) return res.status(400).json({ error: 'Action required' });

    try {
        if (method === 'GET') {
            if (action === 'load_conversations') {
                if (!pageId) return res.status(400).json({ error: 'page_id required' });
                const limit  = Math.min(parseInt(req.query.limit) || 50, 100);
                const offset = parseInt(req.query.offset) || 0;
                const convs = await db.getConversations(pageId, limit, offset);
                return res.json({ 
                    conversations: convs.map(c => ({
                        ...c,
                        // Field names that messenger.js expects
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
                        // Also keep the legacy format
                        psid: c.participantId,
                        name: c.participantName,
                        picture: c.participantPicture || '',
                        lastMsg: c.snippet,
                        lastFromMe: c.lastMessageFromPage ? 1 : 0,
                        lastMsgAt: c.updatedTime,
                        unread: c.unreadCount || 0
                    }))
                });
            }

            if (action === 'load_messages') {
                const psid   = req.query.psid;
                const limit  = Math.min(parseInt(req.query.limit) || 50, 100);
                const before = req.query.before || null;
                if (!pageId || !psid) return res.status(400).json({ error: 'page_id and psid required' });

                const mapMsg = m => ({
                    ...m,
                    message_id:      m.mid || m.message_id || m.id,
                    message:         m.text || m.message || '',
                    from_me:         m.hasOwnProperty('from_me') ? m.from_me : (m.isFromPage ? 1 : 0),
                    created_at:      m.createdTime || m.created_at,
                    attachment_url:  (m.attachments?.[0]?.u) || m.attachment_url || null,
                    attachment_type: (m.attachments?.[0]?.t) || m.attachment_type || null
                });

                // Try DB cache first
                let dbConvId = null, fbConvId = null;
                if (dbConnected) {
                    const convInfo = await db.getConversationIdByParticipant(pageId, psid);
                    if (convInfo) {
                        dbConvId = convInfo.id;
                        fbConvId = convInfo.fbConvId || null;
                        const cached = await db.getMessages(dbConvId, limit, before);
                        if (cached.length > 0) return res.json({ messages: cached.map(mapMsg), conv_id: dbConvId });
                    }
                }

                // Fetch live from Facebook
                const token = req.session.pageTokens?.[pageId] || (dbConnected ? await db.getPageToken(pageId) : null);
                if (!token) return res.json({ messages: [], error: 'No page token found. Please reload the pages list.' });

                try {
                    // Step 1: find FB conversation ID (skip if we have it from DB)
                    if (!fbConvId) {
                        const convLookup = await fetch(
                            `https://graph.facebook.com/v19.0/${pageId}/conversations?user_id=${encodeURIComponent(psid)}&fields=id&limit=1&access_token=${token}`
                        );
                        const convLookupData = await convLookup.json();
                        if (convLookupData.error) {
                            logError('load_messages_conv_lookup', new Error(convLookupData.error.message), { pageId, psid });
                            return res.json({ messages: [], error: convLookupData.error.message });
                        }
                        fbConvId = convLookupData.data?.[0]?.id;
                        if (!fbConvId) return res.json({ messages: [], error: 'No conversation found. This user may not have messaged this page yet.' });
                    }

                    // Step 2: fetch messages for that conversation
                    let fbMsgsUrl = `https://graph.facebook.com/v19.0/${fbConvId}/messages?fields=id,message,from,created_time,attachments{image_data,file_url,type}&limit=${limit}&access_token=${token}`;
                    if (before) {
                        const untilUnix = Math.floor(new Date(before).getTime() / 1000);
                        fbMsgsUrl += `&until=${untilUnix}`;
                    }

                    const msgsRes = await fetch(fbMsgsUrl);
                    const msgsData = await msgsRes.json();
                    if (msgsData.error) {
                        logError('load_messages_msgs', new Error(msgsData.error.message), { pageId, psid, fbConvId });
                        return res.json({ messages: [], error: msgsData.error.message });
                    }

                    const messages = (msgsData.data || []).reverse().map(m => ({
                        message_id:      m.id,
                        message:         m.message || '',
                        from_me:         m.from?.id === pageId ? 1 : 0,
                        created_at:      m.created_time,
                        attachment_url:  m.attachments?.data?.[0]?.image_data?.url || m.attachments?.data?.[0]?.file_url || null,
                        attachment_type: m.attachments?.data?.[0]?.type || null
                    }));

                    // Cache fetched messages in DB
                    if (dbConnected && messages.length > 0) {
                        if (!dbConvId) dbConvId = await db.ensureConversation(pageId, psid);
                        if (dbConvId) {
                            const dbMsgs = messages.map(m => ({
                                id: m.message_id,
                                threadId: dbConvId,
                                pageId,
                                senderId: m.from_me ? pageId : psid,
                                text: m.message,
                                isFromPage: !!m.from_me,
                                createdTime: m.created_at,
                                attachments: m.attachment_url ? [{ u: m.attachment_url, t: m.attachment_type }] : null
                            }));
                            await db.saveMessages(dbMsgs).catch(() => {});
                        }
                    }

                    return res.json({ messages, conv_id: dbConvId || fbConvId });
                } catch (fbErr) {
                    logError('load_messages_fb', fbErr, { pageId, psid });
                    return res.json({ messages: [], error: 'Network error fetching messages: ' + fbErr.message });
                }
            }

            if (action === 'poll') {
                const psid = req.query.psid;
                const since = req.query.since || new Date(Date.now() - 30000).toISOString();
                if (!pageId) return res.status(400).json({ error: 'page_id required' });

                let newMessages = [];
                if (psid && dbConnected) {
                    const convInfo = await db.getConversationIdByParticipant(pageId, psid);
                    if (convInfo?.id) {
                        newMessages = await db.getNewMessagesSince(convInfo.id, since);
                    }
                }

                const updatedConvs = dbConnected ? await db.getUpdatedConvsSince(pageId, since) : [];
                const totalUnread  = dbConnected ? await db.getTotalUnread(pageId) : 0;

                return res.json({
                    new_messages: newMessages.map(m => ({
                        message_id:      m.mid,
                        message:         m.text        || '',
                        from_me:         m.isFromPage  ? 1 : 0,
                        created_at:      m.createdTime,
                        attachment_url:  m.attachment_url  || null,
                        attachment_type: m.attachment_type || null
                    })),
                    updated_convs: updatedConvs,
                    total_unread: totalUnread,
                    server_time: new Date().toISOString()
                });
            }

            if (action === 'search') {
                const q = req.query.q;
                if (!pageId || !q) return res.json({ conversations: [], messages: [] });
                const conversations = await db.searchConversations(pageId, q);
                const messages = await db.searchMessages(pageId, q);
                return res.json({ 
                    conversations: conversations.map(c => ({
                        ...c,
                        psid: c.participantId,
                        name: c.participantName,
                        picture: c.participantPicture || ''
                    })), 
                    messages: messages.map(m => ({
                        ...m,
                        psid: m.senderId || m.sender_id
                    }))
                });
            }
        }

        if (method === 'POST') {
            if (action === 'send_message') {
                const { psid, message, page_token, image_url } = req.body;
                if (!pageId || !psid || (!message && !image_url)) return res.status(400).json({ error: 'Missing fields' });

                const token = page_token || await db.getPageToken(pageId);
                if (!token) return res.status(400).json({ error: 'Page token not found' });

                // Call Facebook API
                const fbUrl = `https://graph.facebook.com/v19.0/me/messages?access_token=${token}`;
                const payload = {
                    recipient: { id: psid },
                    message: image_url ? { attachment: { type: 'image', payload: { url: image_url } } } : { text: message }
                };

                const fbRes = await fetch(fbUrl, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                });
                const fbData = await fbRes.json();

                if (fbData.error) throw new Error(fbData.error.message);

                const mid = fbData.message_id;
                const createdTime = new Date().toISOString();
                
                // Ensure conversation exists and get its numeric ID
                const convInfo = await db.getConversationIdByParticipant(pageId, psid);
                const convId = convInfo?.id || await db.ensureConversation(pageId, psid);

                if (convId) {
                    await db.saveMessage({ 
                        id: mid, 
                        threadId: convId, 
                        pageId, 
                        senderId: pageId, 
                        text: message || '[Image]', 
                        isFromPage: true, 
                        createdTime 
                    });
                    await db.updateConversationFromMessage({ 
                        threadId: convId, 
                        text: message || '[Image]', 
                        createdTime,
                        lastFromMe: true 
                    }).catch(() => {});
                }

                // Emit real-time events
                setImmediate(() => {
                    io.to(`page_${pageId}`).emit('new_message', { 
                        id: mid, 
                        threadId: convId, 
                        pageId, 
                        participantId: psid, 
                        text: message || '[Image]', 
                        isFromPage: true, 
                        createdTime 
                    });
                    io.to(`page_${pageId}`).emit('conversation_updated', { 
                        id: convId, 
                        pageId, 
                        participantId: psid, 
                        snippet: message || '[Image]', 
                        updatedTime: new Date(), 
                        isRead: true, 
                        unreadCount: 0, 
                        lastMessageFromPage: true 
                    });
                });

                return res.json({ success: true, message_id: mid });
            }

            if (action === 'mark_read') {
                const { psid } = req.body;
                if (!pageId || !psid) return res.status(400).json({ error: 'Missing fields' });
                if (dbConnected) {
                    const convInfo = await db.getConversationIdByParticipant(pageId, psid);
                    if (convInfo?.id) await db.markAsRead(convInfo.id);
                }
                return res.json({ success: true });
            }
        }

        res.status(405).json({ error: 'Method or action not allowed' });
    } catch (err) {
        logError('messenger_api', err, { action, pageId });
        res.status(500).json({ error: err.message });
    }
});

// ── Sync History Stub ────────────────────────────────────────────────────────
app.post('/api/sync-history', requireAuth, async (req, res) => {
    const { page_id, page_token } = req.body;
    if (!page_id || !page_token) return res.status(400).json({ error: 'page_id and page_token required' });
    
    // Non-blocking sync start
    db.syncPageInitial(page_id, page_token, fetch, prog => io.to(`page_${page_id}`).emit('sync_progress', prog))
        .then(() => io.to(`page_${page_id}`).emit('sync_progress', { phase: 'done' }))
        .catch(err => logError('manual_sync', err, { pageId: page_id }));
        
    res.json({ success: true, message: 'Sync started' });
});

// ── Quota ───────────────────────────────────────────────────────────────────
app.post(['/api/update_quota', '/api/update_quota.php'], requireAuth, verifyCsrf, async (req, res) => {
    const { fb_user_id, count } = req.body;
    if (!fb_user_id) return res.status(400).json({ error: 'fb_user_id required' });
    
    try {
        const result = await db.updateUserQuota(fb_user_id, count);
        if (result) res.json(result);
        else res.status(404).json({ error: 'User not found' });
    } catch (err) {
        logError('update_quota', err);
        res.status(500).json({ error: 'Failed to update quota' });
    }
});

// ── Sync ──────────────────────────────────────────────────────────────────────
app.post('/api/sync/all', requireAuth, verifyCsrf, async (req, res) => {
    if (!dbConnected) return res.status(503).json({ error: 'Database not connected' });
    try {
        const fbRes = await fetch(`https://graph.facebook.com/v19.0/me/accounts?fields=id,name,picture,access_token&access_token=${req.session.accessToken}`);
        const data  = await fbRes.json();
        if (data.error) throw new Error(data.error.message);
        res.json({ success: true, message: `Sync started for ${(data.data || []).length} pages` });
        for (const page of (data.data || [])) {
            db.syncAllPageData(page.id, page.access_token, fetch).catch(err => logError('sync_all_bg', err, { pageId: page.id }));
        }
    } catch (err) {
        logError('sync_all', err);
        if (!res.headersSent) res.status(500).json({ error: err.message });
    }
});

// ── Health & Debug ────────────────────────────────────────────────────────────

app.get('/api/debug/errors', requireAuth, (req, res) => {
    res.json({ errorLogs, webhookLogs, requestLogs: requestLogs.slice(0, 20), dbErrors: db.getDbErrorLogs(), dbConnected, sockets: connectedSockets.size });
});

// ── /api/config — public config for frontend ──────────────────────────────────
app.get('/api/config', (req, res) => {
    res.json({
        fbAppId:            process.env.FB_APP_ID            || '',
        stripePublishableKey: process.env.STRIPE_PUBLISHABLE_KEY || '',
        contactEmail:       process.env.CONTACT_EMAIL        || '',
        siteUrl:            process.env.SITE_URL             || BASE_URL || '',
        appEnv:             process.env.APP_ENV              || 'production'
    });
});

// ── Main HTML — serve index.php as template ───────────────────────────────────
function renderIndexHtml(req) {
    const root  = path.join(__dirname, '..');
    let html    = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
    const proto = req.headers['x-forwarded-proto'] || 'https';
    const host  = req.headers['x-forwarded-host'] || req.headers.host || '';
    const siteUrl = process.env.SITE_URL || BASE_URL || (host ? `${proto}://${host}` : '');
    const ver   = Date.now();

    const config = {
        stripePublishableKey: (process.env.STRIPE_PUBLISHABLE_KEY || '').replace(/'/g, "\\'"),
        fbAppId: (process.env.FB_APP_ID || '').replace(/'/g, "\\'"),
        fbRedirectUri: (process.env.FB_REDIRECT_URI || `${siteUrl}/api/auth/callback`).replace(/'/g, "\\'"),
        contactEmail: (process.env.CONTACT_EMAIL || '').replace(/'/g, "\\'"),
        siteUrl: siteUrl.replace(/'/g, "\\'"),
        csrfToken: req.session.csrfToken || '',
        appEnv: (process.env.APP_ENV || 'production').replace(/'/g, "\\'")
    };

    // Inject config
    html = html.replace(
        /\/\/ __APP_CONFIG_INJECT__/,
        `window.APP_CONFIG=${JSON.stringify(config)};`
    );

    // Replace placeholders
    html = html.replace(/{{SITE_URL}}/g, siteUrl);
    html = html.replace(/{{SITE_URL_NO_SLASH}}/g, siteUrl.replace(/\/$/, ''));
    html = html.replace(/{{CONTACT_EMAIL}}/g, process.env.CONTACT_EMAIL || '');
    html = html.replace(/{{YEAR}}/g, new Date().getFullYear());
    html = html.replace(/{{VER}}/g, ver);

    return html;
}

app.get('/', (req, res) => {
    try {
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.setHeader('Cache-Control', 'no-store');
        res.send(renderIndexHtml(req));
    } catch (err) {
        logError('render_index', err);
        res.status(500).send('<h1>Server Error</h1><p>Could not load application.</p>');
    }
});

// All frontend routes serve the same SPA index.html
app.get(['/dashboard.html', '/inbox.html', '/messenger.html', '/index.html'], (req, res) => {
    try {
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.setHeader('Cache-Control', 'no-store');
        res.send(renderIndexHtml(req));
    } catch (err) {
        logError('render_index', err);
        res.status(500).send('<h1>Server Error</h1><p>Could not load application.</p>');
    }
});

// ── Global Error Handler ──────────────────────────────────────────────────────
app.use((err, req, res, next) => {
    logError('express', err, { url: req.url, method: req.method });
    if (!res.headersSent) res.status(500).json({ error: 'Internal server error' });
});

// ── Startup ───────────────────────────────────────────────────────────────────
(async () => {
    // Start listening immediately so healthchecks pass while DB is initializing
    httpServer.listen(PORT, () => {
        console.log(`🚀 FBCast Pro on port ${PORT}`);
        console.log(`   Healthcheck: GET /api/health`);
    });

    try {
        console.log('DB: Initializing...');
        await db.initDatabase();
        dbConnected = db.isConnected();
        if (dbConnected) {
            const stats = await db.getStats();
            console.log(`✅ MySQL connected — ${stats.totalConversations} conversations, ${stats.totalMessages} messages`);
        } else {
            console.warn('⚠️  Running without DB:', db.getLastError());
        }
    } catch (err) {
        console.error('DB init failed:', err.message);
    }

    // Background incremental sync every 5 min
    setInterval(async () => {
        if (!dbConnected) return;
        try {
            const pages = await db.getPages();
            if (!pages.length) return;
            await Promise.all(pages.map(p =>
                db.syncPageIncremental(p.id, p.access_token, fetch, prog => io.to(`page_${p.id}`).emit('sync_progress', prog))
                    .catch(err => logError('bg_sync', err, { pageId: p.id }))
            ));
            pages.forEach(p => io.to(`page_${p.id}`).emit('sync_progress', { phase: 'done' }));
        } catch (err) { logError('bg_sync_tick', err); }
    }, 5 * 60 * 1000);
})();
