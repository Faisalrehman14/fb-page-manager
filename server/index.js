/**
 * Facebook Page Inbox - Customer Support Demo
 * Backend Server (Node.js/Express)
 * 
 * This server handles:
 * - Facebook OAuth with Authorization Code Flow
 * - Secure token storage in server-side sessions
 * - Proxying Graph API calls
 * - CSRF protection
 * - Rate limiting for message sending
 */

require('dotenv').config({ path: '../.env' });
const express = require('express');
const session = require('express-session');
const crypto = require('crypto');
const path = require('path');
const helmet = require('helmet');

const app = express();
const PORT = process.env.PORT || 3000;

app.set('trust proxy', 1);

app.use(helmet({
    contentSecurityPolicy: false
}));

// Rate limiting storage (in production, use Redis)
const rateLimits = new Map();

// =============================================================================
// MIDDLEWARE
// =============================================================================

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve static files from public directory
app.use(express.static(path.join(__dirname, '../public')));

// Session configuration - tokens stored server-side only
app.use(session({
    secret: process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex'),
    resave: false,
    saveUninitialized: false,
    name: 'fb_inbox_session',
    cookie: {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        maxAge: 24 * 60 * 60 * 1000 // 24 hours
    }
}));

// CSRF Token middleware
app.use((req, res, next) => {
    if (!req.session.csrfToken) {
        req.session.csrfToken = crypto.randomBytes(32).toString('hex');
    }
    next();
});

// CSRF Protection for POST/PUT/DELETE requests
const csrfProtection = (req, res, next) => {
    if (['POST', 'PUT', 'DELETE'].includes(req.method)) {
        const token = req.headers['x-csrf-token'] || req.body._csrf;
        if (!token || token !== req.session.csrfToken) {
            return res.status(403).json({ error: 'Invalid CSRF token' });
        }
    }
    next();
};

// Auth check middleware
const requireAuth = (req, res, next) => {
    if (!req.session.userAccessToken) {
        return res.status(401).json({ error: 'Not authenticated', redirect: '/' });
    }
    next();
};

// =============================================================================
// UTILITY FUNCTIONS
// =============================================================================

async function graphApiRequest(endpoint, accessToken, method = 'GET', body = null) {
    const url = `https://graph.facebook.com/v19.0${endpoint}`;
    const options = {
        method,
        headers: {
            'Authorization': `Bearer ${accessToken}`,
            'Content-Type': 'application/json'
        }
    };
    
    if (body && method !== 'GET') {
        options.body = JSON.stringify(body);
    }
    
    const response = await fetch(url, options);
    const data = await response.json();
    
    if (data.error) {
        const error = new Error(data.error.message);
        error.code = data.error.code;
        error.type = data.error.type;
        throw error;
    }
    
    return data;
}

// Rate limit check for sending messages (1 message per 3 seconds per thread)
function checkRateLimit(threadId) {
    const now = Date.now();
    const lastSent = rateLimits.get(threadId);
    
    if (lastSent && (now - lastSent) < 3000) {
        const waitTime = Math.ceil((3000 - (now - lastSent)) / 1000);
        return { allowed: false, waitTime };
    }
    
    rateLimits.set(threadId, now);
    return { allowed: true };
}

// Validate message text
function validateMessage(text) {
    if (!text || typeof text !== 'string') {
        return { valid: false, error: 'Message text is required' };
    }
    
    const trimmed = text.trim();
    if (trimmed.length === 0) {
        return { valid: false, error: 'Message cannot be empty' };
    }
    
    if (trimmed.length > 2000) {
        return { valid: false, error: 'Message exceeds maximum length of 2000 characters' };
    }
    
    return { valid: true, text: trimmed };
}

// =============================================================================
// AUTH ROUTES
// =============================================================================

// Get CSRF token for frontend
app.get('/api/csrf-token', (req, res) => {
    res.json({ csrfToken: req.session.csrfToken });
});

// Get auth status
app.get('/api/auth/status', (req, res) => {
    res.json({
        authenticated: !!req.session.userAccessToken,
        userName: req.session.userName || null
    });
});

// Start OAuth flow - returns the authorization URL
app.get('/api/auth/login', (req, res) => {
    // Generate PKCE code verifier and challenge
    const codeVerifier = crypto.randomBytes(32).toString('base64url');
    const codeChallenge = crypto
        .createHash('sha256')
        .update(codeVerifier)
        .digest('base64url');
    
    // Store code verifier in session for later use
    req.session.codeVerifier = codeVerifier;
    
    const redirectUri = `${(process.env.BASE_URL || `http://localhost:${PORT}`).trim()}/api/auth/callback`;
    
    const params = new URLSearchParams({
        client_id: process.env.FB_APP_ID,
        redirect_uri: redirectUri,
        scope: 'pages_show_list,pages_read_engagement,pages_messaging',
        response_type: 'code',
        code_challenge: codeChallenge,
        code_challenge_method: 'S256',
        state: req.session.csrfToken // Use CSRF token as state for additional security
    });
    
    const authUrl = `https://www.facebook.com/v19.0/dialog/oauth?${params}`;
    res.json({ authUrl });
});

// OAuth callback
app.get('/api/auth/callback', async (req, res) => {
    const { code, state, error, error_description } = req.query;
    
    // Handle user cancellation or errors
    if (error) {
        console.error('OAuth error:', error, error_description);
        return res.redirect('/?error=' + encodeURIComponent(error_description || error));
    }
    
    // Verify state matches CSRF token
    if (state !== req.session.csrfToken) {
        return res.redirect('/?error=' + encodeURIComponent('Invalid state parameter'));
    }
    
    if (!code) {
        return res.redirect('/?error=' + encodeURIComponent('No authorization code received'));
    }
    
    try {
        const redirectUri = `${(process.env.BASE_URL || `http://localhost:${PORT}`).trim()}/api/auth/callback`;
        
        // Exchange code for access token using PKCE
        const tokenParams = new URLSearchParams({
            client_id: process.env.FB_APP_ID,
            client_secret: process.env.FB_APP_SECRET, // Required by Facebook even with PKCE
            redirect_uri: redirectUri,
            code: code,
            code_verifier: req.session.codeVerifier
        });
        
        const tokenResponse = await fetch(
            `https://graph.facebook.com/v19.0/oauth/access_token?${tokenParams}`
        );
        const tokenData = await tokenResponse.json();
        
        if (tokenData.error) {
            throw new Error(tokenData.error.message);
        }
        
        // Store access token in session (server-side only - never sent to browser)
        req.session.userAccessToken = tokenData.access_token;
        delete req.session.codeVerifier; // Clean up
        
        // Get user info
        const userInfo = await graphApiRequest('/me?fields=name', tokenData.access_token);
        req.session.userName = userInfo.name;
        
        // Redirect to dashboard
        res.redirect('/dashboard.html');
        
    } catch (error) {
        console.error('Token exchange error:', error.message);
        res.redirect('/?error=' + encodeURIComponent('Authentication failed: ' + error.message));
    }
});

// Logout / Disconnect
app.post('/api/auth/logout', csrfProtection, async (req, res) => {
    try {
        // Revoke the token on Facebook's side
        if (req.session.userAccessToken) {
            await fetch(
                `https://graph.facebook.com/v19.0/me/permissions?access_token=${req.session.userAccessToken}`,
                { method: 'DELETE' }
            );
        }
    } catch (error) {
        console.error('Error revoking token:', error.message);
    }
    
    // Destroy session
    req.session.destroy((err) => {
        if (err) {
            return res.status(500).json({ error: 'Failed to logout' });
        }
        res.json({ success: true, redirect: '/' });
    });
});

// =============================================================================
// PAGES API ROUTES
// =============================================================================

// Get user's pages
app.get('/api/pages', requireAuth, async (req, res) => {
    try {
        const data = await graphApiRequest(
            '/me/accounts?fields=id,name,picture.type(large),access_token',
            req.session.userAccessToken
        );
        
        // Store page tokens in session (keyed by page ID)
        if (!req.session.pageTokens) {
            req.session.pageTokens = {};
        }
        
        const pages = data.data.map(page => {
            // Store page access token server-side
            req.session.pageTokens[page.id] = page.access_token;
            
            // Return page info without access token
            return {
                id: page.id,
                name: page.name,
                picture: page.picture?.data?.url
            };
        });
        
        res.json({ pages });
        
    } catch (error) {
        console.error('Error fetching pages:', error.message);
        
        if (error.code === 190) {
            return res.status(401).json({ error: 'Session expired', redirect: '/' });
        }
        
        res.status(500).json({ error: error.message });
    }
});

// =============================================================================
// CONVERSATIONS API ROUTES
// =============================================================================

// Get conversations for a page
app.get('/api/pages/:pageId/conversations', requireAuth, async (req, res) => {
    const { pageId } = req.params;
    
    try {
        const pageToken = req.session.pageTokens?.[pageId];
        if (!pageToken) {
            return res.status(403).json({ error: 'No access to this page' });
        }
        
        const data = await graphApiRequest(
            `/${pageId}/conversations?fields=id,participants,can_reply,updated_time,snippet&limit=50`,
            pageToken
        );
        
        // Filter to only conversations where we can reply
        const conversations = data.data
            .filter(conv => conv.can_reply !== false)
            .map(conv => {
                // Find the customer participant (not the page)
                const customer = conv.participants?.data?.find(p => p.id !== pageId);
                
                return {
                    id: conv.id,
                    participantName: customer?.name || 'Unknown',
                    participantId: customer?.id,
                    snippet: conv.snippet || 'No message preview',
                    updatedTime: conv.updated_time,
                    canReply: conv.can_reply !== false
                };
            });
        
        res.json({ conversations, pageId });
        
    } catch (error) {
        console.error('Error fetching conversations:', error.message);
        
        if (error.code === 190) {
            return res.status(401).json({ error: 'Session expired', redirect: '/' });
        }
        
        res.status(500).json({ error: error.message });
    }
});

// =============================================================================
// MESSAGES API ROUTES
// =============================================================================

// Get messages in a thread
app.get('/api/threads/:threadId/messages', requireAuth, async (req, res) => {
    const { threadId } = req.params;
    const { pageId } = req.query;
    
    if (!pageId) {
        return res.status(400).json({ error: 'pageId is required' });
    }
    
    try {
        const pageToken = req.session.pageTokens?.[pageId];
        if (!pageToken) {
            return res.status(403).json({ error: 'No access to this page' });
        }
        
        const data = await graphApiRequest(
            `/${threadId}/messages?fields=message,from,created_time&limit=50`,
            pageToken
        );
        
        const messages = data.data.map(msg => ({
            id: msg.id,
            text: msg.message || '',
            from: msg.from?.name || 'Unknown',
            fromId: msg.from?.id,
            createdTime: msg.created_time,
            isFromPage: msg.from?.id === pageId
        })).reverse(); // Oldest first
        
        res.json({ messages, threadId, pageId });
        
    } catch (error) {
        console.error('Error fetching messages:', error.message);
        
        if (error.code === 190) {
            return res.status(401).json({ error: 'Session expired', redirect: '/' });
        }
        
        res.status(500).json({ error: error.message });
    }
});

// Send a reply to a specific thread
app.post('/api/threads/:threadId/reply', csrfProtection, requireAuth, async (req, res) => {
    const { threadId } = req.params;
    const { pageId, recipientId, message } = req.body;
    
    // Validate inputs
    if (!pageId || !recipientId) {
        return res.status(400).json({ error: 'pageId and recipientId are required' });
    }
    
    const validation = validateMessage(message);
    if (!validation.valid) {
        return res.status(400).json({ error: validation.error });
    }
    
    // Check rate limit
    const rateCheck = checkRateLimit(threadId);
    if (!rateCheck.allowed) {
        return res.status(429).json({ 
            error: `Rate limit exceeded. Please wait ${rateCheck.waitTime} seconds before sending another message.`,
            waitTime: rateCheck.waitTime
        });
    }
    
    try {
        const pageToken = req.session.pageTokens?.[pageId];
        if (!pageToken) {
            return res.status(403).json({ error: 'No access to this page' });
        }
        
        // Send message using Facebook Send API
        const response = await graphApiRequest(
            `/${pageId}/messages`,
            pageToken,
            'POST',
            {
                recipient: { id: recipientId },
                message: { text: validation.text },
                messaging_type: 'RESPONSE' // Important: This is a response to customer inquiry
            }
        );
        
        res.json({ 
            success: true, 
            messageId: response.message_id,
            recipientId: response.recipient_id
        });
        
    } catch (error) {
        console.error('Error sending message:', error.message);
        
        if (error.code === 190) {
            return res.status(401).json({ error: 'Session expired', redirect: '/' });
        }
        
        if (error.code === 10 || error.code === 200) {
            return res.status(403).json({ 
                error: 'Cannot send message. The customer may have blocked messages or the 24-hour window has expired.' 
            });
        }
        
        res.status(500).json({ error: error.message });
    }
});

// =============================================================================
// PAGE ROUTES (Serve HTML pages)
// =============================================================================

// Serve index.html for root
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, '../public/index.html'));
});

// Serve other HTML pages
app.get('/dashboard.html', requireAuth, (req, res) => {
    res.sendFile(path.join(__dirname, '../public/dashboard.html'));
});

app.get('/inbox.html', requireAuth, (req, res) => {
    res.sendFile(path.join(__dirname, '../public/inbox.html'));
});

app.get('/thread.html', requireAuth, (req, res) => {
    res.sendFile(path.join(__dirname, '../public/thread.html'));
});

app.get('/privacy.html', (req, res) => {
    res.sendFile(path.join(__dirname, '../public/privacy.html'));
});

app.get('/terms.html', (req, res) => {
    res.sendFile(path.join(__dirname, '../public/terms.html'));
});

// Handle 404
app.use((req, res) => {
    res.status(404).send('Page not found');
});

// =============================================================================
// START SERVER
// =============================================================================

app.listen(PORT, () => {
    console.log(`
╔════════════════════════════════════════════════════════════════╗
║  Facebook Page Inbox - Customer Support Demo                  ║
║  Server running at http://localhost:${PORT}                      ║
╠════════════════════════════════════════════════════════════════╣
║  IMPORTANT: This is a demo for Meta App Review               ║
║  - Only reply to customers who messaged first                ║
║  - No bulk messaging or automation                           ║
║  - Rate limited: 1 message per 3 seconds per thread          ║
╚════════════════════════════════════════════════════════════════╝
    `);
});
