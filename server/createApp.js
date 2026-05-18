const express = require('express');
const compression = require('compression');
const rateLimit = require('express-rate-limit');
const cookieParser = require('cookie-parser');
const multer = require('multer');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { createServer } = require('http');
const { Server } = require('socket.io');

const env = require('./config/env');
const paths = require('./config/paths');
const state = require('./lib/state');
const { logError, trackRequest } = require('./lib/logger');
const { createSessionMiddleware } = require('./middleware/session');
const { csrfBootstrap, generateCsrf, verifyCsrf } = require('./middleware/csrf');
const { requireAuth, requireAdminAuth, restoreSessionFromCookies } = require('./middleware/auth');
const { legacyPhpRedirect } = require('./middleware/legacy-php');
const { setupSocket } = require('./socket');
const db = require('./db');
const { mountMessenger } = require('./messenger');
const registerRoutes = require('./routes/register');

function createUploadDisk() {
    const diskStorage = multer.diskStorage({
        destination: (req, file, cb) => {
            if (!fs.existsSync(paths.UPLOADS)) fs.mkdirSync(paths.UPLOADS, { recursive: true });
            cb(null, paths.UPLOADS);
        },
        filename: (req, file, cb) => {
            const ext = path.extname(file.originalname) || '.jpg';
            cb(null, crypto.randomBytes(16).toString('hex') + ext);
        }
    });
    return multer({
        storage: diskStorage,
        limits: { fileSize: 5 * 1024 * 1024 },
        fileFilter: (req, file, cb) => {
            if (file.mimetype.startsWith('image/')) cb(null, true);
            else cb(new Error('Only images allowed'));
        }
    });
}

function createApp() {
    const app = express();
    const httpServer = createServer(app);
    const io = new Server(httpServer, {
        cors: { origin: '*', methods: ['GET', 'POST'] },
        transports: ['websocket', 'polling']
    });

    const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });
    const uploadDisk = createUploadDisk();
    const sessionMiddleware = createSessionMiddleware();

    process.on('unhandledRejection', r => logError('unhandledRejection', r instanceof Error ? r : new Error(String(r))));
    process.on('uncaughtException', err => logError('uncaughtException', err));

    app.get('/api/health', (req, res) => {
        res.json({
            status: 'ok',
            db: state.dbConnected ? 'connected' : 'initializing',
            uptime: Math.floor(process.uptime())
        });
    });

    app.set('trust proxy', 1);
    app.use(compression());
    app.use(rateLimit({
        windowMs: 60000,
        max: 200,
        skip: req => req.url.includes('webhook')
    }));
    app.use((req, res, next) => { trackRequest(req); next(); });

    // Serve static files BEFORE session middleware so MySQL errors don't affect assets
    app.use(express.static(paths.PUBLIC, { maxAge: '1h', etag: true, index: false }));
    app.use('/uploads', require('express').static(paths.UPLOADS));

    app.use(express.json({ verify: (req, res, buf) => { req.rawBody = buf; } }));
    app.use(express.urlencoded({ extended: true }));
    app.use(cookieParser(env.SESSION_SECRET));
    app.use(sessionMiddleware);
    app.use(csrfBootstrap);
    app.use(restoreSessionFromCookies);
    app.use(legacyPhpRedirect);

    setupSocket(io, sessionMiddleware);

    const deps = {
        db,
        io,
        fetch: global.fetch,
        env,
        paths,
        state,
        logError,
        upload,
        uploadDisk,
        syncCooldown: state.syncCooldown,
        requireAuth,
        verifyCsrf,
        requireAdminAuth,
        generateCsrf,
        mountMessenger,
        startBroadcastScheduler: null
    };

    registerRoutes(app, deps);

    return {
        app,
        httpServer,
        io,
        deps,
        startBroadcastScheduler: deps.startBroadcastScheduler
    };
}

module.exports = { createApp };
