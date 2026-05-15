const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const path = require('path');
const webhookRoutes = require('./routes/webhook');
const apiRoutes = require('./routes/api');

const app = express();

// 1. Core Middleware
app.use(helmet({
    contentSecurityPolicy: false,
    crossOriginResourcePolicy: { policy: "cross-origin" }
}));
app.use(cors({ origin: "*", credentials: true }));

// 2. Body Parsers (with rawBody for FB signatures)
app.use(express.json({ verify: (req, res, buf) => { req.rawBody = buf; } }));
app.use(express.urlencoded({ extended: true }));

// 3. Static Assets
app.use(express.static(path.join(__dirname, '../../')));

// 4. Routes
app.use('/api/webhook', webhookRoutes);
app.use('/api/messenger', apiRoutes);

// 5. Health Check
app.get('/health', (req, res) => res.json({ status: 'UP', timestamp: new Date() }));

// 6. SPA Fallback (Optional, keeps index.php as entry)
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, '../../index.php'));
});

module.exports = app;
