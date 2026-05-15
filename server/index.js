require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const express      = require('express');
const session      = require('express-session');
const path         = require('path');
const fs           = require('fs');
const { createServer } = require('http');
const { Server }   = require('socket.io');
const compression  = require('compression');
const cookieParser = require('cookie-parser');
const db           = require('./db');
const { restoreSession } = require('./middleware/security');

// ── App Initialization ────────────────────────────────────────────────────────
const app        = express();
const httpServer = createServer(app);
const io         = new Server(httpServer, {
    cors: { origin: '*', methods: ['GET', 'POST'] },
    transports: ['websocket', 'polling']
});

// Expose io to routes
app.set('io', io);

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(compression());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

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
                createDatabaseTable: true
            };
            const durl = process.env.DATABASE_URL || process.env.MYSQL_URL;
            if (durl) {
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
        } catch (e) { return undefined; }
    })(),
    cookie: { secure: false, httpOnly: true, sameSite: 'lax', maxAge: 7 * 24 * 60 * 60 * 1000 }
});

app.use(cookieParser(SESSION_SECRET));
app.use(sessionMiddleware);
app.use(restoreSession); // Hardened Self-Healing Restoration

// ── Static Assets & Index Rendering ──────────────────────────────────────────
const renderIndexHtml = (req, res) => {
    let html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
    const config = {
        fbAppId: process.env.FB_APP_ID,
        fbRedirectUri: process.env.FB_REDIRECT_URI,
        csrfToken: req.session.csrfToken || ''
    };
    html = html.replace(/\/\/ __APP_CONFIG_INJECT__/, `window.APP_CONFIG=${JSON.stringify(config)};`);
    res.send(html);
};

app.get('/', renderIndexHtml);
app.get('/index.html', renderIndexHtml);
app.use(express.static(path.join(__dirname, '../')));

// ── Routes ────────────────────────────────────────────────────────────────────
app.use('/api/auth', require('./routes/auth'));
app.use('/api', require('./routes/facebook'));
app.use('/api', require('./routes/messenger'));
app.use('/api', require('./routes/api'));

// Legacy PHP rewrites handled in routers

// ── Healthcheck ───────────────────────────────────────────────────────────────
app.get('/api/health', (req, res) => res.json({ status: 'ok', time: new Date().toISOString(), db: db.getPool() ? 'connected' : 'disconnected' }));

// ── Startup ───────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
db.initDatabase().then(() => {
    httpServer.listen(PORT, () => {
        console.log(`🚀 FBCast Pro Modular Server on port ${PORT}`);
    });
});
