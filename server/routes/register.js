/** Auto-split from monolith — route registrations */
module.exports = function registerRoutes(app, deps) {
  const {
    db, io, fetch, env, paths, state, logError,
    upload, uploadDisk, syncCooldown,
    requireAuth, verifyCsrf, requireAdminAuth, generateCsrf,
    mountMessenger
  } = deps;
  const FB_APP_ID = env.FB_APP_ID;
  const FB_APP_SECRET = env.FB_APP_SECRET;
  const BASE_URL = env.BASE_URL;
  const PORT = env.PORT;
  const WEBHOOK_VERIFY_TOKEN = env.WEBHOOK_VERIFY_TOKEN;
  const ADMIN_PASSWORD = env.ADMIN_PASSWORD;
  const path = require('path');
  const fs = require('fs');
  const crypto = require('crypto');
  const { MAX_LOGS } = require('../lib/logger');
  const fbNames = require('../services/facebook-user-names');
  const entitlementsSvc = require('../services/entitlements.service');
    const express = require('express');

  function stripUserTokens(users) {
    if (!Array.isArray(users)) return users;
    for (const u of users) delete u.fb_access_token;
    return users;
  }

    function resolveSiteUrl(req) {
        const envUrl = (process.env.SITE_URL || BASE_URL || '').trim().replace(/\/$/, '');
        if (envUrl) return envUrl;
        const proto = String(req.headers['x-forwarded-proto'] || req.protocol || 'https').split(',')[0].trim();
        const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
        return host ? `${proto}://${host}` : `http://localhost:${PORT}`;
    }

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

    state.webhookLogs.unshift({ time: new Date().toISOString(), entries: entry.length });
    if (state.webhookLogs.length > MAX_LOGS) state.webhookLogs.pop();

    for (const pageEntry of entry) {
        const pageId = pageEntry?.id;
        if (!pageId) continue;

        for (const event of (pageEntry.messaging || [])) {
            try {
                // Delivery receipts — watermark covers all msgs before that timestamp
                if (event.delivery) {
                    const watermark     = event.delivery.watermark;
                    const participantId = event.sender?.id;
                    if (watermark && participantId) {
                        io.to(`page_${pageId}`).emit('msg_status', {
                            type: 'delivered', pageId,
                            participantId: String(participantId),
                            watermark
                        });
                    }
                    continue;
                }
                // Read receipts
                if (event.read) {
                    const watermark     = event.read.watermark;
                    const participantId = event.sender?.id;
                    if (watermark && participantId) {
                        io.to(`page_${pageId}`).emit('msg_status', {
                            type: 'read', pageId,
                            participantId: String(participantId),
                            watermark
                        });
                    }
                    continue;
                }
                // Customer typing indicator (Facebook sends this when customer types)
                if (event.sender_action === 'typing_on' || event.typing_on) {
                    const participantId = event.sender?.id;
                    if (participantId) {
                        io.to(`page_${pageId}`).emit('customer_typing', {
                            pageId, participantId: String(participantId), typing: true
                        });
                    }
                    continue;
                }
                if (event.sender_action === 'typing_off' || event.typing_off) {
                    const participantId = event.sender?.id;
                    if (participantId) {
                        io.to(`page_${pageId}`).emit('customer_typing', {
                            pageId, participantId: String(participantId), typing: false
                        });
                    }
                    continue;
                }
                // Customer 👍 reaction on a message (Meta Business Suite / Messenger app)
                if (event.reaction) {
                    const { isThumbsUpReaction, normalizeIncomingSave, snippetForMessage, toClientMessage } = require('../messenger/message-content');
                    if (!isThumbsUpReaction(event.reaction)) continue;

                    const participantId = event.sender?.id;
                    if (!participantId) continue;

                    const ts = event.timestamp ? new Date(event.timestamp).toISOString() : new Date().toISOString();
                    const rxMid = `rxn_${event.reaction.mid || '0'}_${participantId}_${event.timestamp || Date.now()}`;
                    const normalized = normalizeIncomingSave({
                        text: '👍',
                        attachments: [{ t: 'like', u: null }]
                    });

                    const threadId = await db.ensureConversation(pageId, participantId);
                    if (!threadId) continue;

                    const saved = await db.saveMessage({
                        id: rxMid, threadId, pageId, senderId: participantId,
                        senderType: 'user',
                        text: normalized.text,
                        isFromPage: false,
                        createdTime: ts,
                        attachments: normalized.attachments
                    });

                    const clientMsg = toClientMessage({
                        message_id: rxMid,
                        text: normalized.text,
                        attachments: normalized.attachments,
                        isFromPage: false,
                        createdTime: ts
                    });
                    const snippet = snippetForMessage(clientMsg);

                    if (saved?.inserted === true) {
                        await db.onIncomingMessage(threadId, pageId, participantId, snippet);
                        io.to(`page_${pageId}`).emit('new_message', {
                            id: rxMid, threadId, pageId, participantId,
                            text: clientMsg.message,
                            isFromPage: false,
                            createdTime: ts,
                            attachment_url: null,
                            attachment_type: 'like',
                            is_like: true
                        });
                        io.to(`page_${pageId}`).emit('conversation_updated', {
                            id: threadId, pageId, participantId, snippet,
                            updatedTime: new Date(), isRead: false,
                            unreadCount: 1, lastMessageFromPage: false
                        });
                    }
                    continue;
                }
                // No message body (postbacks etc.) — skip
                if (!event.message) continue;

                const isEcho      = !!event.message.is_echo;
                const senderId    = event.sender?.id;
                const recipientId = event.recipient?.id;
                const participantId = isEcho ? recipientId : senderId;
                if (!participantId) {
                    logError('webhook_no_participant', new Error('Missing sender/recipient'), { pageId, eventKeys: Object.keys(event) });
                    continue;
                }

                const mid  = event.message.mid || null;
                const text = (event.message.text || '').trim();
                const ts   = event.timestamp ? new Date(event.timestamp).toISOString() : new Date().toISOString();

                const { parseWebhookAttachments, normalizeIncomingSave, snippetForMessage, toClientMessage } = require('../messenger/message-content');
                const rawAttachments = parseWebhookAttachments(event.message.attachments || []);
                const normalized = normalizeIncomingSave({ text, attachments: rawAttachments });
                const saveText = normalized.text;
                const saveAttachments = normalized.attachments;

                const threadId = await db.ensureConversation(pageId, participantId);
                if (!threadId) {
                    logError('webhook_no_thread', new Error('ensureConversation returned null'), { pageId, participantId });
                    continue;
                }

                const saved = await db.saveMessage({
                    id: mid, threadId, pageId, senderId: senderId,
                    senderType: isEcho ? 'page' : 'user',
                    text: saveText, isFromPage: isEcho, createdTime: ts,
                    attachments: saveAttachments
                });

                const clientMsg = toClientMessage({
                    message_id: mid,
                    text: saveText,
                    attachments: saveAttachments,
                    isFromPage: isEcho,
                    createdTime: ts
                });
                const snippet = snippetForMessage(clientMsg);

                const isNewMessage = saved?.inserted === true;
                if (isEcho) {
                    if (isNewMessage) {
                        await db.updateConversationFromMessage({ threadId, text: snippet, createdTime: ts, lastFromMe: true }).catch(() => {});
                    }
                } else if (isNewMessage) {
                    await db.onIncomingMessage(threadId, pageId, participantId, snippet);
                }

                if (isNewMessage) {
                    io.to(`page_${pageId}`).emit('new_message', {
                        id: mid, threadId, pageId, participantId,
                        text: clientMsg.message,
                        isFromPage: isEcho,
                        createdTime: ts,
                        attachment_url: clientMsg.attachment_url,
                        attachment_type: clientMsg.attachment_type,
                        is_like: clientMsg.is_like
                    });
                    io.to(`page_${pageId}`).emit('conversation_updated', {
                        id: threadId, pageId, participantId, snippet,
                        updatedTime: new Date(), isRead: isEcho,
                        unreadCount: isEcho ? 0 : 1, lastMessageFromPage: isEcho
                    });
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
                await db.upsertUserFacebookName(meData.id, meData.name || '', longToken);
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

        await db.upsertUserFacebookName(meData.id, meData.name || '', userToken);
        const ent = await entitlementsSvc.resolveEntitlements(db, meData.id);
        res.json({
            success: true,
            fb_user_id: meData.id,
            fb_name: meData.name,
            subscriptionStatus: ent.subscriptionStatus,
            messageLimit: ent.messageLimit,
            messagesUsed: ent.messagesUsed,
            plan: ent.plan,
            trialDaysLeft: ent.trialDaysLeft,
            trialExpired: ent.trialExpired,
            onFreeTrial: ent.onFreeTrial,
            freeTrialExpiresAt: ent.freeTrialExpiresAt,
            canSend: ent.canSend,
            remaining: ent.remaining,
            display: ent.display,
            trial: ent.trial,
            subscription: ent.subscription
        });
    } catch (err) {
        logError('track_user', err);
        res.status(500).json({ error: 'Tracking failed' });
    }
});

// ── Facebook OAuth Flow ───────────────────────────────────────────────────
    const oauthCookieOpts = { signed: true, httpOnly: true, sameSite: 'lax', maxAge: 10 * 60 * 1000, path: '/' };

    function readOAuthContext(req) {
        return {
            storedState: req.session.fb_oauth_state || req.signedCookies._fb_oauth_state || '',
            oauthTs: Number(req.session.fb_oauth_ts || req.signedCookies._fb_oauth_ts || 0),
            oauthMode: req.session.fb_oauth_mode || req.signedCookies._fb_oauth_mode || 'redirect'
        };
    }

    function clearOAuthFlowCookies(res) {
        res.clearCookie('_fb_oauth_state', oauthCookieOpts);
        res.clearCookie('_fb_oauth_ts', oauthCookieOpts);
        res.clearCookie('_fb_oauth_mode', oauthCookieOpts);
    }

    function clearOAuthSession(req) {
        delete req.session.fb_oauth_state;
        delete req.session.fb_oauth_ts;
        delete req.session.fb_oauth_mode;
    }

app.get(['/api/auth/start', '/oauth_start.php'], (req, res) => {
    const state = crypto.randomBytes(16).toString('hex');
    const ts = Date.now();
    const mode = req.query.mode === 'popup' ? 'popup' : 'redirect';

    req.session.fb_oauth_state = state;
    req.session.fb_oauth_ts = ts;
    req.session.fb_oauth_mode = mode;

    res.cookie('_fb_oauth_state', state, oauthCookieOpts);
    res.cookie('_fb_oauth_ts', String(ts), oauthCookieOpts);
    res.cookie('_fb_oauth_mode', mode, oauthCookieOpts);
    
    const siteUrl = resolveSiteUrl(req);
    const redirectUri = siteUrl + '/oauth_callback.php';
    const appId = (process.env.FB_APP_ID || '').trim();
    const oauthUrl = `https://www.facebook.com/dialog/oauth?client_id=${appId}&redirect_uri=${encodeURIComponent(redirectUri)}&scope=pages_show_list,pages_messaging,pages_read_engagement,pages_manage_metadata&response_type=code&state=${state}`;
    
    res.redirect(oauthUrl);
});

app.get(['/api/auth/callback', '/oauth_callback.php'], async (req, res) => {
    const { state: oauthState, code, error, error_description } = req.query;
    const { storedState, oauthTs, oauthMode } = readOAuthContext(req);
    
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
  function notifyParent() {
    try {
      localStorage.setItem('fb_oauth_result', JSON.stringify(Object.assign({ ts: Date.now() }, RESULT)));
    } catch (e) {}
    try {
      var ch = new BroadcastChannel('fb_oauth');
      ch.postMessage(RESULT);
      ch.close();
    } catch (e) {}
    try {
      if (window.opener && !window.opener.closed) {
        window.opener.postMessage(RESULT, '*');
        if (RESULT.type === 'fb_auth_success') {
          if (window.opener.showAppDashboard) window.opener.showAppDashboard();
          else if (window.opener.AppShell && window.opener.AppShell.showDashboard) window.opener.AppShell.showDashboard();
        }
      }
    } catch (e) {}
    setTimeout(function() { try { window.close(); } catch (_) {} }, 450);
  }
  var attempts = 0;
  function trySend() {
    if (window.opener && !window.opener.closed) {
      notifyParent();
      return;
    }
    if (++attempts < 25) {
      setTimeout(trySend, 120);
      return;
    }
    if (RESULT.type === 'fb_auth_success') {
      window.location.replace('/?fb_connected=1');
      return;
    }
    notifyParent();
    document.getElementById('loader').style.display = 'none';
    document.getElementById('title').textContent = RESULT.error ? 'Connection failed' : 'Connected!';
    document.getElementById('sub').textContent = RESULT.error ? 'Close this window and try again.' : 'Redirecting…';
    document.getElementById('closeBtn').style.display = 'inline-block';
  }
  trySend();
</script>
</body>
</html>`);
    };

    const authErrMsg = (msg) => {
        clearOAuthFlowCookies(res);
        clearOAuthSession(req);
        if (oauthMode === 'redirect') {
            return res.redirect('/?error=' + encodeURIComponent(msg));
        }
        return sendPopupResult({ type: 'fb_auth_error', error: msg });
    };

    if (error) return authErrMsg(error_description || error || 'Authorization denied');
    if (!oauthState || !storedState || oauthState !== storedState) {
        return authErrMsg('Security check failed. Please retry login.');
    }
    if (oauthTs && (Date.now() - oauthTs) > 600000) {
        return authErrMsg('Login session expired. Please try again.');
    }
    
    clearOAuthFlowCookies(res);
    clearOAuthSession(req);

    const siteUrl = resolveSiteUrl(req);
    const redirectUri = siteUrl + '/oauth_callback.php';
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
        const pages = pagesData.data || [];

        // Server session — required for /api/pages, messenger, and session cookies
        req.session.accessToken = userToken;
        req.session.pageTokens = {};
        pages.forEach(p => { req.session.pageTokens[p.id] = p.access_token; });
        try {
            const meRes = await fetch(`https://graph.facebook.com/v19.0/me?fields=id,name&access_token=${encodeURIComponent(userToken)}`);
            const meData = await meRes.json();
            if (meData.id) {
                req.session.userId = meData.id;
                req.session.userName = meData.name;
                await db.upsertUserFacebookName(meData.id, meData.name || '', userToken);
            }
        } catch (_) {}
        req.session.firstLogin = true;

        const cookieOpts = { signed: true, httpOnly: true, sameSite: 'lax', maxAge: 7 * 24 * 60 * 60 * 1000 };
        res.cookie('_fb_at', userToken, cookieOpts);
        if (req.session.userId) res.cookie('_fb_uid', req.session.userId, cookieOpts);
        if (req.session.userName) res.cookie('_fb_un', req.session.userName, cookieOpts);
        generateCsrf(req);

        if (state.dbConnected && pages.length) {
            await db.savePages(pages.map(p => ({
                id: p.id,
                name: p.name,
                picture: p.picture?.data?.url || p.picture,
                accessToken: p.access_token
            }))).catch(() => {});
        }

        const authPayload = {
            type: 'fb_auth_success',
            token: userToken,
            expiresIn: longData.expires_in || 5184000,
            pages,
            userId: req.session.userId || null,
            userName: req.session.userName || null
        };

        req.session.clientPagesCache = pages.map(p => ({
            id: p.id,
            name: p.name,
            access_token: p.access_token,
            category: p.category,
            picture: p.picture?.data?.url || p.picture || null
        }));

        if (oauthMode === 'redirect') {
            return res.redirect('/?fb_connected=1');
        }

        sendPopupResult(authPayload);
    } catch (err) {
        logError('oauth_callback', err);
        if (oauthMode === 'redirect') {
            return res.redirect('/?error=' + encodeURIComponent(err.message || 'Facebook login failed'));
        }
        sendPopupResult({ type: 'fb_auth_error', error: err.message });
    }
});

// ── Admin Panel ──────────────────────────────────────────────────────────────
// Serve admin HTML
app.get('/admin', (req, res) => {
    res.sendFile(paths.publicPath('admin2.html'));
});

// Admin login
app.post('/api/admin/login', (req, res) => {
    const { password } = req.body;
    if (!password || password !== ADMIN_PASSWORD) {
        return res.status(401).json({ error: 'Invalid password' });
    }
    req.session.isAdmin = true;
    res.json({ success: true });
});

// Admin logout
app.post('/api/admin/logout', (req, res) => {
    req.session.isAdmin = false;
    res.json({ success: true });
});

// Admin stats
app.get('/api/admin/stats', requireAdminAuth, async (req, res) => {
    const pool = db.pool;
    if (!pool) return res.json({ users: 0, totalMessages: 0, todayLogins: 0, freePlan: 0, paidPlan: 0 });
    try {
        const [[userRow]]   = await pool.query('SELECT COUNT(*) as c FROM users');
        const [[msgRow]]    = await pool.query('SELECT COALESCE(SUM(messenger_messages_used),0) as c FROM users');
        const [[freeRow]]   = await pool.query("SELECT COUNT(*) as c FROM users WHERE plan='free'");
        const [[proRow]]    = await pool.query("SELECT COUNT(*) as c FROM users WHERE plan NOT IN ('free','unknown')");
        const [[loginRow]]  = await pool.query("SELECT COUNT(*) as c FROM activity_log WHERE action='login' AND DATE(created_at)=CURDATE()").catch(()=>[[{c:0}]]);
        res.json({
            users:         userRow.c,
            totalMessages: msgRow.c,
            todayLogins:   loginRow.c,
            freePlan:      freeRow.c,
            paidPlan:      proRow.c
        });
    } catch(e) { res.json({ users:0, totalMessages:0, todayLogins:0, freePlan:0, paidPlan:0 }); }
});

// Sync Facebook names for users missing fb_name (admin)
app.post('/api/admin/users/sync-names', requireAdminAuth, async (req, res) => {
    try {
        const result = await fbNames.backfillMissingFacebookNames(db, 100);
        res.json({ success: true, ...result });
    } catch (e) {
        res.status(500).json({ error: e.message || 'Sync failed' });
    }
});

// List users
app.get('/api/admin/users', requireAdminAuth, async (req, res) => {
    const pool = db.pool;
    if (!pool) return res.json({ users: [], total: 0 });
    try {
        const page   = Math.max(1, parseInt(req.query.p) || 1);
        const limit  = 20;
        const offset = (page - 1) * limit;
        const search = req.query.q ? `%${req.query.q}%` : null;
        const where  = search ? 'WHERE fb_user_id LIKE ? OR fb_name LIKE ? OR email LIKE ?' : '';
        const params = search ? [search, search, search, limit, offset] : [limit, offset];
        const [[{total}]] = await pool.query(`SELECT COUNT(*) as total FROM users ${where}`, search ? [search, search, search] : []);
        const [users]     = await pool.query(`SELECT * FROM users ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`, params);
        await fbNames.enrichUsersWithFacebookNames(db, users, { maxLookups: 25 });
        if (page === 1 && !search) {
            await fbNames.backfillMissingFacebookNames(db, 40);
        }
        res.json({ users: stripUserTokens(users), total, page, pages: Math.ceil(total / limit) });
    } catch(e) { res.json({ users:[], total:0 }); }
});

// Plan catalog for admin UI
app.get('/api/admin/plans', requireAdminAuth, (req, res) => {
    const { getPlanCatalogForAdmin } = require('../config/plans');
    res.json({ plans: getPlanCatalogForAdmin() });
});

// Update user plan / quota (plan change = full activation with limits + expiry)
app.post('/api/admin/users/:id/update', requireAdminAuth, async (req, res) => {
    if (!db.pool) return res.status(500).json({ error: 'DB not connected' });
    try {
        const { plan, messages_limit, messages_used } = req.body;
        if (plan !== undefined) {
            const result = await db.adminActivatePlan(req.params.id, plan, { messages_limit, messages_used });
            if (!result.ok) return res.status(400).json(result);
            return res.json({ success: true, ...result });
        }
        const sets = [];
        const vals = [];
        if (messages_limit !== undefined) { sets.push('messenger_messages_limit=?'); vals.push(parseInt(messages_limit, 10)); }
        if (messages_used !== undefined)  { sets.push('messenger_messages_used=?'); vals.push(parseInt(messages_used, 10)); }
        if (!sets.length) return res.json({ success: true });
        vals.push(req.params.id);
        await db.pool.query(`UPDATE users SET ${sets.join(',')} WHERE fb_user_id=?`, vals);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Reset user quota
app.post('/api/admin/users/:id/reset-quota', requireAdminAuth, async (req, res) => {
    const pool = db.pool;
    if (!pool) return res.status(500).json({ error: 'DB not connected' });
    try {
        await pool.query('UPDATE users SET messenger_messages_used=0 WHERE fb_user_id=?', [req.params.id]);
        res.json({ success: true });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

// Delete user
app.delete('/api/admin/users/:id', requireAdminAuth, async (req, res) => {
    const pool = db.pool;
    if (!pool) return res.status(500).json({ error: 'DB not connected' });
    try {
        await pool.query('DELETE FROM users WHERE fb_user_id=?', [req.params.id]);
        res.json({ success: true });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

// Activity log
app.get('/api/admin/activity', requireAdminAuth, async (req, res) => {
    const pool = db.pool;
    if (!pool) return res.json({ logs: [] });
    const page   = Math.max(1, parseInt(req.query.p) || 1);
    const limit  = 50;
    const offset = (page - 1) * limit;
    const action = req.query.action || '';
    const where  = action ? 'WHERE action=?' : '';
    try {
        const [[{total}]] = await pool.query(`SELECT COUNT(*) as total FROM activity_log ${where}`, action ? [action] : []).catch(()=>[[{total:0}]]);
        const [logs] = await pool.query(`SELECT * FROM activity_log ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`, action ? [action, limit, offset] : [limit, offset]).catch(()=>[[]]);
        res.json({ logs, total, page, pages: Math.ceil(total / limit) });
    } catch(e) { res.json({ logs:[], total:0, page:1, pages:1 }); }
});

// Charts data
app.get('/api/admin/charts', requireAdminAuth, async (req, res) => {
    const pool = db.pool;
    if (!pool) return res.json({ userGrowth: [], planDistribution: {}, dailyActivity: [] });
    try {
        const [growthRows]  = await pool.query(`SELECT DATE(created_at) as date, COUNT(*) as count FROM users WHERE created_at >= DATE_SUB(CURDATE(), INTERVAL 29 DAY) GROUP BY DATE(created_at) ORDER BY date ASC`).catch(()=>[[]]);
        const [planRows]    = await pool.query(`SELECT plan, COUNT(*) as count FROM users GROUP BY plan`).catch(()=>[[]]);
        const [actRows]     = await pool.query(`SELECT DATE(created_at) as date, COUNT(*) as count FROM activity_log WHERE created_at >= DATE_SUB(CURDATE(), INTERVAL 13 DAY) GROUP BY DATE(created_at) ORDER BY date ASC`).catch(()=>[[]]);
        const [topUsers]    = await pool.query(`SELECT fb_user_id, fb_name, fb_access_token, email, plan, messenger_messages_used, messenger_messages_limit FROM users ORDER BY messenger_messages_used DESC LIMIT 5`).catch(()=>[[]]);
        await fbNames.enrichUsersWithFacebookNames(db, topUsers, { maxLookups: 5 });
        const planDist = {};
        for (const r of planRows) planDist[r.plan] = Number(r.count);
        res.json({
            userGrowth:    growthRows.map(r => ({ date: r.date, count: Number(r.count) })),
            planDistribution: planDist,
            dailyActivity: actRows.map(r => ({ date: r.date, count: Number(r.count) })),
            topUsers: stripUserTokens(topUsers)
        });
    } catch(e) { res.json({ userGrowth: [], planDistribution: {}, dailyActivity: [], topUsers: [] }); }
});

// Disable caching for all /api/* routes
app.use('/api', (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    next();
});

// Redirect /index.html to / to ensure config injection
app.get('/index.html', (req, res) => res.redirect('/'));


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
        await db.upsertUserFacebookName(uData.id, uData.name || '', user_token);
        
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
    const redirectUri = `${BASE_URL}/api/auth/redirect-callback`;
    const scope = 'pages_show_list,pages_messaging,pages_read_engagement,pages_manage_metadata';
    res.json({ authUrl: `https://www.facebook.com/v19.0/dialog/oauth?client_id=${FB_APP_ID}&redirect_uri=${encodeURIComponent(redirectUri)}&scope=${scope}&state=${state}&response_type=code` });
});

app.get('/api/auth/redirect-callback', async (req, res) => {
    const { code, state, error } = req.query;
    if (error)  return res.redirect('/?error=' + encodeURIComponent(error));
    if (!state || state !== req.session.oauthState) return res.redirect('/?error=invalid_state');
    try {
        const redirectUri = `${BASE_URL}/api/auth/redirect-callback`;
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
        await db.upsertUserFacebookName(uData.id, uData.name || '', tData.access_token);
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

/** After redirect OAuth — sync browser from server session + DB user data */
app.get('/api/auth/bootstrap', async (req, res) => {
    if (!req.session.accessToken) {
        return res.json({ authenticated: false });
    }
    const pages = Array.isArray(req.session.clientPagesCache) ? req.session.clientPagesCache : [];
    const payload = {
        authenticated: true,
        token: req.session.accessToken,
        expiresIn: 5184000,
        userId: req.session.userId || null,
        userName: req.session.userName || null,
        pages
    };
    if (state.dbConnected && req.session.userId) {
        try {
            await db.upsertUserFacebookName(
                req.session.userId,
                req.session.userName || '',
                req.session.accessToken || null
            );
            const profile = await db.getUserProfile(req.session.userId);
            const ent = await entitlementsSvc.resolveEntitlements(db, req.session.userId);
            payload.quota = entitlementsSvc.toQuotaClientPayload(ent);
            payload.billing = {
                entitlements: ent.entitlements,
                trial: ent.trial,
                subscription: ent.subscription,
                display: ent.display
            };
            payload.preferences = profile.preferences;
        } catch (err) {
            logError('auth_bootstrap_profile', err);
        }
    }
    res.json(payload);
});

/** User profile: quota + preferences from DB (session auth) */
app.get('/api/user/profile', requireAuth, async (req, res) => {
    try {
        res.setHeader('Cache-Control', 'no-store');
        const uid = req.session.userId;
        if (!uid) return res.status(401).json({ error: 'Not authenticated' });
        if (!state.dbConnected) {
            return res.json({
                quota: { subscriptionStatus: 'free', messageLimit: 2000, messagesUsed: 0 },
                preferences: { notif_broadcast: true, notif_failed: true, default_delay_ms: 1200, message_draft: '' }
            });
        }
        const profile = await db.getUserProfile(uid);
        const ent = await entitlementsSvc.resolveEntitlements(db, uid);
        res.json({
            fb_user_id: uid,
            fb_name: req.session.userName || null,
            quota: entitlementsSvc.toQuotaClientPayload(ent),
            billing: {
                entitlements: ent.entitlements,
                trial: ent.trial,
                subscription: ent.subscription,
                display: ent.display
            },
            preferences: profile.preferences
        });
    } catch (err) {
        logError('user_profile', err);
        res.status(500).json({ error: 'Failed to load profile' });
    }
});

app.get('/api/user/preferences', requireAuth, async (req, res) => {
    try {
        const uid = req.session.userId;
        if (!uid) return res.status(401).json({ error: 'Not authenticated' });
        const preferences = state.dbConnected
            ? await db.getUserPreferences(uid)
            : { notif_broadcast: true, notif_failed: true, default_delay_ms: 1200, message_draft: '' };
        res.json({ preferences });
    } catch (err) {
        logError('get_preferences', err);
        res.status(500).json({ error: 'Failed to load preferences' });
    }
});

app.put('/api/user/preferences', requireAuth, verifyCsrf, async (req, res) => {
    try {
        const uid = req.session.userId;
        if (!uid) return res.status(401).json({ error: 'Not authenticated' });
        const body = req.body || {};
        const patch = {};
        if (body.notif_broadcast !== undefined) patch.notif_broadcast = !!body.notif_broadcast;
        if (body.notif_failed !== undefined) patch.notif_failed = !!body.notif_failed;
        if (body.default_delay_ms !== undefined) patch.default_delay_ms = body.default_delay_ms;
        if (body.message_draft !== undefined) patch.message_draft = body.message_draft;
        const preferences = state.dbConnected
            ? await db.upsertUserPreferences(uid, patch)
            : { ...patch, notif_broadcast: true, notif_failed: true, default_delay_ms: 1200, message_draft: '' };
        res.json({ success: true, preferences });
    } catch (err) {
        logError('put_preferences', err);
        res.status(500).json({ error: 'Failed to save preferences' });
    }
});

app.get('/api/broadcasts/history', requireAuth, async (req, res) => {
    try {
        res.setHeader('Cache-Control', 'no-store');
        const uid = req.session.userId;
        if (!uid) return res.status(401).json({ error: 'Not authenticated' });
        const days = Math.min(365, Math.max(1, parseInt(req.query.days, 10) || 90));
        const history = state.dbConnected ? await db.getBroadcastHistory(uid, days) : [];
        res.json({ history, days });
    } catch (err) {
        logError('get_broadcast_history', err);
        res.status(500).json({ error: 'Failed to load history' });
    }
});

app.post('/api/broadcasts/history', requireAuth, verifyCsrf, async (req, res) => {
    try {
        const uid = req.session.userId;
        if (!uid) return res.status(401).json({ error: 'Not authenticated' });
        const body = req.body || {};
        const sent = Math.max(0, parseInt(body.sent, 10) || 0);
        const failed = Math.max(0, parseInt(body.failed, 10) || 0);
        const total = Math.max(0, parseInt(body.total, 10) || sent + failed);
        if (sent + failed === 0 && total === 0) {
            return res.status(400).json({ error: 'No broadcast stats to save' });
        }
        let id = null;
        if (state.dbConnected) {
            id = await db.insertBroadcastHistory(uid, {
                mode: body.mode || 'manual',
                pageId: body.pageId || body.page_id,
                pages: body.pages || body.pages_count || 1,
                total,
                sent,
                failed,
                message_preview: body.message_preview || body.label
            });
        }
        res.json({ success: true, id });
    } catch (err) {
        logError('post_broadcast_history', err);
        res.status(500).json({ error: 'Failed to save history' });
    }
});

app.post('/api/auth/logout', verifyCsrf, (req, res) => {
    const cookieOpts = { path: '/', signed: true, httpOnly: true, sameSite: 'lax' };
    res.clearCookie('_fb_at', cookieOpts);
    res.clearCookie('_fb_uid', cookieOpts);
    res.clearCookie('_fb_un', cookieOpts);
    req.session.destroy(err => {
        if (err) logError('auth_logout', err);
        res.json({ success: true, redirect: '/' });
    });
});

// ── Pages ─────────────────────────────────────────────────────────────────────
app.get('/api/pages', requireAuth, async (req, res) => {
    try {
        const fbRes = await fetch(`https://graph.facebook.com/v19.0/me/accounts?fields=id,name,picture,access_token&access_token=${req.session.accessToken}`);
        const data  = await fbRes.json();
        if (data.error) throw new Error(data.error.message);

        req.session.pageTokens = {};
        const pagesToSave = (data.data || []).map(p => ({ id: p.id, name: p.name, picture: p.picture?.data?.url, accessToken: p.access_token }));

        if (state.dbConnected) {
            await db.savePages(pagesToSave);
        }

        (data.data || []).forEach(p => { req.session.pageTokens[p.id] = p.access_token; });

        // Login: quick conversation list sync first (fast inbox), messages sync when messenger opens
        if (state.dbConnected && pagesToSave.length) {
            const forceSync = !!req.session.firstLogin;
            if (req.session.firstLogin) req.session.firstLogin = false;
            const STALE_MS = 15 * 60 * 1000;
            for (const p of pagesToSave) {
                setImmediate(async () => {
                    try {
                        const last = await db.getPageSyncTime(p.id);
                        const stale = forceSync || !last ||
                            (Date.now() - new Date(last).getTime() > STALE_MS);
                        if (!stale) return;
                        await db.syncConversationsFromFacebook(p.id, p.accessToken, fetch, null, {
                            maxPages: 10,
                            maxTotal: 500,
                            fbLimit: 100
                        });
                        io.to(`page_${p.id}`).emit('sync_progress', { phase: 'done', pageId: p.id });
                    } catch (err) {
                        logError('pages_bg_sync', err, { pageId: p.id });
                        io.to(`page_${p.id}`).emit('sync_progress', { phase: 'done', pageId: p.id });
                    }
                });
            }
        }

        // Auto-subscribe pages to webhook events — log failures so webhook issues are visible
        for (const p of (data.data || [])) {
            fetch(`https://graph.facebook.com/v19.0/${p.id}/subscribed_apps`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ subscribed_fields: ['messages', 'messaging_postbacks', 'message_deliveries', 'message_reads', 'message_reactions', 'conversations'], access_token: p.access_token })
            }).then(async r => {
                const d = await r.json().catch(() => ({}));
                if (!r.ok || d.error) logError('webhook_subscribe', new Error(d.error?.message || 'subscribe failed'), { pageId: p.id });
            }).catch(err => logError('webhook_subscribe_net', err, { pageId: p.id }));
        }

        const pageIds      = (data.data || []).map(p => p.id);
        const unreadCounts = state.dbConnected ? await db.getUnreadCountsForPages(pageIds) : {};

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
    let token = req.session.pageTokens?.[pageId] || (state.dbConnected ? await db.getPageToken(pageId) : null);
    if (!token) return res.status(401).json({ error: 'Page token not found. Reload pages.', tokenMissing: true });

    const limit    = Math.min(parseInt(req.query.limit)  || 100, 200);
    const offset   = Math.max(parseInt(req.query.offset) || 0, 0);
    const archived = req.query.archived === 'true';

    try {
        if (state.dbConnected) {
            const [convs, total] = await Promise.all([
                db.getConversations(pageId, limit, offset, archived),
                offset === 0 ? db.getConversationCount(pageId, archived) : Promise.resolve(null)
            ]);
            if (convs.length > 0 || offset > 0) {
                res.json({ conversations: convs, hasMore: convs.length === limit, offset, total, fromCache: true });
                if (offset === 0 && !archived) {
                    const now = Date.now(), last = state.syncCooldown.get(pageId) || 0;
                    if (now - last > 60000) {
                        state.syncCooldown.set(pageId, now);
                        db.syncConversationsFromFacebook(pageId, token, fetch, db.messageRetentionCutoffUnix()).catch(err => logError('bg_sync', err, { pageId }));
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
    if (!q || !state.dbConnected) return res.json({ conversations: [] });
    try { res.json({ conversations: await db.searchConversations(req.params.pageId, q, 30) }); }
    catch (err) { res.status(500).json({ error: err.message, conversations: [] }); }
});

app.post('/api/pages/:pageId/mark-all-read', requireAuth, verifyCsrf, async (req, res) => {
    if (!state.dbConnected) return res.status(503).json({ error: 'DB not connected' });
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
    let token = req.session.pageTokens?.[pageId] || (state.dbConnected ? await db.getPageToken(pageId) : null);
    if (!token) return res.status(401).json({ error: 'Page token not found', tokenMissing: true });

    try {
        const fmt = m => ({ id: m.id, text: m.text, attachments: m.attachments || [], isFromPage: m.isFromPage, senderId: m.senderId, createdTime: m.createdTime });
        if (state.dbConnected) {
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

    let token = req.session.pageTokens?.[pageId] || (state.dbConnected ? await db.getPageToken(pageId) : null);
    if (!token) return res.status(401).json({ error: 'Page token not found', tokenMissing: true });

    try {
        const _replyUrl  = `https://graph.facebook.com/v19.0/me/messages?access_token=${token}`;
        const _replySend = async (useUtility = false) => {
            const body = { recipient: { id: recipientId }, message: { text: message.trim() } };
            if (useUtility) body.messaging_type = 'UTILITY';
            const formBody = new URLSearchParams();
            for (const [k, v] of Object.entries(body)) {
                formBody.append(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
            }
            const r = await fetch(_replyUrl, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: formBody.toString() });
            return r.json();
        };
        let data = await _replySend();
        if (data.error) {
            const code = data.error.code;
            const em   = (data.error.message || '').toLowerCase();
            if (code === 10 || code === 551 || em.includes('outside of allowed window') || em.includes('24 hour') || em.includes('messaging window')) {
                data = await _replySend(true);
            }
        }
        if (data.error) throw new Error(data.error.message);

        const createdTime = new Date().toISOString();
        if (state.dbConnected) {
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
    const threadId = req.params.threadId;
    if (state.dbConnected) {
        await db.markAsRead(threadId).catch(() => {});
        if (pageId) {
            try {
                const row = await db.getConversationById(threadId);
                const psid = row?.fb_user_id;
                const token = await db.getPageToken(pageId);
                if (psid && token) {
                    const { FacebookClient } = require('../messenger/facebook-client');
                    await new FacebookClient(fetch).markSeenWithRetry(token, psid);
                }
            } catch (err) {
                logError('thread_mark_read_meta', err, { pageId, threadId });
            }
        }
    }
    if (pageId) io.to(`page_${pageId}`).emit('conversation_updated', { id: threadId, pageId, isRead: true, unreadCount: 0, isLive: true });
    res.json({ success: true });
});

app.post('/api/threads/:threadId/unread', requireAuth, verifyCsrf, async (req, res) => {
    const pageId = req.body?.pageId;
    if (state.dbConnected) await db.markAsUnread(req.params.threadId).catch(() => {});
    if (pageId) io.to(`page_${pageId}`).emit('conversation_updated', { id: req.params.threadId, pageId, isRead: false, unreadCount: 1, isLive: true });
    res.json({ success: true });
});

// ── Archive ───────────────────────────────────────────────────────────────────
app.post('/api/threads/:threadId/archive', requireAuth, verifyCsrf, async (req, res) => {
    if (!state.dbConnected) return res.status(503).json({ error: 'DB not connected' });
    try {
        await db.archiveConversation(req.params.threadId, req.body.pageId);
        io.to(`page_${req.body.pageId}`).emit('conversation_archived', { convId: req.params.threadId, pageId: req.body.pageId });
        res.json({ ok: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/threads/:threadId/unarchive', requireAuth, verifyCsrf, async (req, res) => {
    if (!state.dbConnected) return res.status(503).json({ error: 'DB not connected' });
    try {
        await db.unarchiveConversation(req.params.threadId, req.body.pageId);
        io.to(`page_${req.body.pageId}`).emit('conversation_unarchived', { convId: req.params.threadId, pageId: req.body.pageId });
        res.json({ ok: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Notes ─────────────────────────────────────────────────────────────────────
app.get('/api/threads/:threadId/notes', requireAuth, async (req, res) => {
    if (!state.dbConnected) return res.json({ notes: [] });
    try { res.json({ notes: await db.getNotes(req.params.threadId) }); }
    catch (err) { res.status(500).json({ error: err.message, notes: [] }); }
});

app.post('/api/threads/:threadId/notes', requireAuth, verifyCsrf, async (req, res) => {
    if (!state.dbConnected) return res.status(503).json({ error: 'DB not connected' });
    const { body, pageId } = req.body;
    if (!body?.trim()) return res.status(400).json({ error: 'Note body required' });
    try {
        const note = await db.saveNote(req.params.threadId, pageId, req.session.userName || 'Agent', body.trim());
        io.to(`thread_${req.params.threadId}`).emit('note_added', { threadId: req.params.threadId, note });
        res.json({ note });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/threads/:threadId/notes/:noteId', requireAuth, verifyCsrf, async (req, res) => {
    if (!state.dbConnected) return res.status(503).json({ error: 'DB not connected' });
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

    let token = req.session.pageTokens?.[pageId] || (state.dbConnected ? await db.getPageToken(pageId) : null);
    if (!token) return res.status(401).json({ error: 'Page token not found' });

    try {
        const { FacebookClient } = require('../messenger/facebook-client');
        const mime = file.mimetype || 'application/octet-stream';
        const attachType = mime.startsWith('image/') ? 'image' : mime.startsWith('video/') ? 'video' : 'file';
        const fbClient = new FacebookClient(fetch);
        const data = await fbClient.sendAttachmentWithRetry(
            token, recipientId, file.buffer, mime, file.originalname || 'upload'
        );
        const createdTime = new Date().toISOString();
        if (state.dbConnected) {
            await db.saveMessage({ id: data.message_id, threadId, pageId, senderId: pageId, senderType: 'page', text: '', isFromPage: true, createdTime, attachments: [{ t: attachType, u: '' }] });
        }
        io.to(`page_${pageId}`).emit('new_message',        { id: data.message_id, threadId, text: '', isFromPage: true, createdTime, attachments: [{ t: attachType, u: '' }] });
        io.to(`page_${pageId}`).emit('conversation_updated', { id: threadId, pageId, snippet: `[${attachType}]`, updatedTime: new Date(), isRead: true, unreadCount: 0, lastMessageFromPage: true });
        res.json({ success: true, messageId: data.message_id });
    } catch (err) {
        logError('attach_route', err, { pageId, threadId });
        const { FacebookClient } = require('../messenger/facebook-client');
        const fbErr = err.fbCode != null ? { code: err.fbCode, message: err.message } : null;
        const msg = fbErr ? FacebookClient.formatSendError(fbErr) : err.message;
        res.status(500).json({ error: msg });
    }
});

// ── Messenger Image Upload ────────────────────────────────────────────────────
app.post('/api/messenger/upload', requireAuth, upload.single('file'), async (req, res) => {
    const { FacebookClient } = require('../messenger/facebook-client');
    const { page_id: pageId, psid, page_token: bodyToken } = req.body;
    const file = req.file;
    if (!pageId      || !/^\d+$/.test(pageId)) return res.status(400).json({ error: 'Invalid page_id' });
    if (!psid        || !/^\d+$/.test(psid))   return res.status(400).json({ error: 'Invalid psid' });
    if (!file)                                  return res.status(400).json({ error: 'No file uploaded' });

    const token = req.session.pageTokens?.[pageId] || (state.dbConnected ? await db.getPageToken(pageId) : null) || bodyToken;
    if (!token) return res.status(401).json({ error: 'Page token not found' });

    try {
        const mime = file.mimetype || 'image/png';
        const fbClient = new FacebookClient(fetch);
        const data = await fbClient.sendAttachmentWithRetry(
            token, psid, file.buffer, mime, file.originalname || 'image.png'
        );
        const attachType = mime.startsWith('image/') ? 'image' : mime.startsWith('video/') ? 'video' : 'file';

        if (state.dbConnected && data.message_id) {
            const convInfo = await db.getConversationIdByParticipant(pageId, psid);
            if (convInfo?.id) {
                await db.saveMessage({ id: data.message_id, conversationId: convInfo.id, pageId, senderId: pageId, senderType: 'page', text: '', isFromPage: true, createdTime: new Date().toISOString(), attachments: [{ t: attachType, u: '' }] });
            }
        }
        io.to(`page_${pageId}`).emit('new_message', { id: data.message_id, psid, text: '', isFromPage: true, createdTime: new Date().toISOString(), attachments: [{ t: attachType, u: '' }] });
        res.json({ success: true, message_id: data.message_id });
    } catch (err) {
        logError('messenger_upload', err, { pageId, psid });
        const fbErr = err.fbCode != null ? { code: err.fbCode, message: err.message } : null;
        const msg = fbErr ? FacebookClient.formatSendError(fbErr) : err.message;
        res.status(500).json({ error: msg });
    }
});

// ── FB Proxy ──────────────────────────────────────────────────────────────────
app.post('/api/fb-proxy', requireAuth, verifyCsrf, async (req, res) => {
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
app.post('/api/upload-image', verifyCsrf, uploadDisk.single('image'), (req, res) => {
    if (!req.file) return res.status(400).json({ success: false, error: 'No file uploaded' });
    
    const proto = req.headers['x-forwarded-proto'] || 'https';
    const host = req.headers['x-forwarded-host'] || req.headers.host || '';
    const siteUrl = process.env.SITE_URL || BASE_URL || (host ? `${proto}://${host}` : '');
    const url = `${siteUrl.replace(/\/$/, '')}/uploads/${req.file.filename}`;
    
    res.json({ success: true, url, filename: req.file.filename });
});

// ── Messenger module (server/messenger/) ─────────────────────────────────────
mountMessenger({ app, requireAuth, db, getDbConnected: () => state.dbConnected, fetch, syncCooldown: state.syncCooldown, io, logError });

// ── Quota ───────────────────────────────────────────────────────────────────
app.get('/api/user/quota', requireAuth, async (req, res) => {
    const uid = req.session.userId;
    if (!uid) return res.status(401).json({ error: 'Not authenticated' });
    try {
        const ent = await entitlementsSvc.resolveEntitlements(db, uid);
        const check = await db.assertQuota(uid, 1);
        res.json({
            ...ent,
            remaining: check.remaining ?? ent.remaining,
            canSend: !!check.ok,
            code: check.ok ? null : (check.code || ent.code)
        });
    } catch (err) {
        logError('user_quota', err);
        res.status(500).json({ error: 'Failed to load quota' });
    }
});

app.post(['/api/update_quota', '/api/update_quota.php'], requireAuth, verifyCsrf, async (req, res) => {
    const { fb_user_id, count } = req.body;
    const uid = req.session.userId;
    if (!uid) return res.status(401).json({ error: 'Not authenticated' });
    if (fb_user_id && fb_user_id !== uid) return res.status(403).json({ error: 'Forbidden' });
    
    try {
        const n = Math.max(0, parseInt(count, 10) || 0);
        if (n > 0) {
            const quota = await db.assertQuota(uid, n);
            if (!quota.ok) {
                const ent = await entitlementsSvc.resolveEntitlements(db, uid);
                return res.status(402).json({
                    success: false,
                    error: quota.message,
                    code: quota.code,
                    remaining: quota.remaining,
                    limit: quota.limit,
                    messagesUsed: quota.used ?? ent.messagesUsed,
                    messageLimit: quota.limit ?? ent.messageLimit,
                    subscriptionStatus: quota.plan || ent.plan || 'free',
                    plan: quota.plan || ent.plan || 'free',
                    trialDaysLeft: ent.trialDaysLeft,
                    trialExpired: ent.trialExpired,
                    onFreeTrial: ent.onFreeTrial,
                    display: ent.display
                });
            }
        }
        const result = await db.updateUserQuota(uid, n);
        if (result) res.json(result);
        else res.status(404).json({ error: 'User not found' });
    } catch (err) {
        logError('update_quota', err);
        res.status(500).json({ error: 'Failed to update quota' });
    }
});

// ── Cleanup blocked conversations (immediate, per-page) ──────────────────────
app.post('/api/conversations/cleanup', requireAuth, async (req, res) => {
    if (!state.dbConnected) return res.status(503).json({ error: 'Database not connected' });
    try {
        const pages = req.session.pageTokens ? Object.entries(req.session.pageTokens) : [];
        if (!pages.length) return res.status(400).json({ error: 'No page tokens in session. Re-login.' });
        let totalDeleted = 0;
        for (const [pageId, token] of pages) {
            try {
                const convs = await db.syncConversationsFromFacebook(pageId, token, fetch);
                // syncConversationsFromFacebook already does the DELETE internally (awaited)
                totalDeleted += convs.length; // not deleted count but synced
            } catch (err) {
                logError('conversations_cleanup', err, { pageId });
            }
        }
        res.json({ success: true, message: `Cleaned up ${pages.length} page(s), ${totalDeleted} active conversations kept` });
    } catch (err) {
        logError('conversations_cleanup', err);
        res.status(500).json({ error: err.message });
    }
});

// ── Sync ──────────────────────────────────────────────────────────────────────
app.post('/api/sync/all', requireAuth, verifyCsrf, async (req, res) => {
    if (!state.dbConnected) return res.status(503).json({ error: 'Database not connected' });
    try {
        const fbRes = await fetch(`https://graph.facebook.com/v19.0/me/accounts?fields=id,name,picture,access_token&access_token=${req.session.accessToken}`);
        const data  = await fbRes.json();
        if (data.error) throw new Error(data.error.message);
        res.json({ success: true, message: `Sync started for ${(data.data || []).length} pages` });
        for (const page of (data.data || [])) {
            db.syncPageSmart(page.id, page.access_token, fetch)
                .catch(err => logError('sync_all_bg', err, { pageId: page.id }));
        }
    } catch (err) {
        logError('sync_all', err);
        if (!res.headersSent) res.status(500).json({ error: err.message });
    }
});

// ── Scheduled Broadcasts ─────────────────────────────────────────────────────

app.post('/api/schedules', requireAuth, verifyCsrf, async (req, res) => {
    const { pages, message, image_url, delay_ms, scheduled_at } = req.body;
    if (!pages?.length || !message || !scheduled_at)
        return res.status(400).json({ error: 'pages, message, scheduled_at required' });
    const scheduledDate = new Date(scheduled_at);
    if (isNaN(scheduledDate) || scheduledDate <= new Date())
        return res.status(400).json({ error: 'scheduled_at must be a future date/time' });
    for (const p of pages) {
        if (!p.id || !p.token) return res.status(400).json({ error: 'Each page needs id and token' });
    }
    try {
        const id = await db.createSchedule({
            fb_user_id: req.session.userId,
            pages,
            message,
            image_url: image_url || null,
            delay_ms: Math.max(500, parseInt(delay_ms) || 1200),
            scheduled_at: scheduledDate
        });
        res.json({ success: true, id });
    } catch (err) {
        logError('create_schedule', err);
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/schedules', requireAuth, async (req, res) => {
    try {
        res.setHeader('Cache-Control', 'no-store');
        const rows = await db.getSchedules(req.session.userId);
        res.json({ schedules: rows });
    } catch (err) {
        logError('get_schedules', err);
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/dashboard/summary', requireAuth, async (req, res) => {
    try {
        res.setHeader('Cache-Control', 'no-store');
        const pageIds = Object.keys(req.session.pageTokens || {});
        const schedules = state.dbConnected && req.session.userId
            ? await db.getSchedules(req.session.userId)
            : [];
        const unreadByPage = state.dbConnected && pageIds.length
            ? await db.getUnreadCountsForPages(pageIds)
            : {};
        let unreadTotal = 0;
        for (const pid of pageIds) unreadTotal += unreadByPage[pid] || 0;

        const pendingStatuses = new Set(['pending', 'running']);
        const scheduleStats = {
            total: schedules.length,
            pending: schedules.filter(s => pendingStatuses.has(s.status)).length,
            done: schedules.filter(s => s.status === 'done').length,
            failed: schedules.filter(s => s.status === 'failed').length
        };

        let quota = null;
        if (state.dbConnected && req.session.userId) {
            quota = await db.updateUserQuota(req.session.userId, 0);
        }

        res.json({
            schedules,
            scheduleStats,
            unread: { total: unreadTotal, byPage: unreadByPage },
            pagesCount: pageIds.length,
            quota: quota ? {
                messagesUsed: quota.messenger_messagesUsed ?? 0,
                messageLimit: quota.messageLimit ?? 2000,
                subscriptionStatus: quota.subscriptionStatus || 'free'
            } : null,
            updatedAt: new Date().toISOString()
        });
    } catch (err) {
        logError('dashboard_summary', err);
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/schedules/:id', requireAuth, verifyCsrf, async (req, res) => {
    try {
        const ok = await db.cancelSchedule(parseInt(req.params.id), req.session.userId);
        if (!ok) return res.status(404).json({ error: 'Schedule not found or already started' });
        res.json({ success: true });
    } catch (err) {
        logError('cancel_schedule', err);
        res.status(500).json({ error: err.message });
    }
});

// ── Broadcast Scheduler — runs every 60 s ────────────────────────────────────
// Send messages exactly like manual broadcast (enqueueAndSendUtility in fb_api.js)
async function sendToPage(pageId, pageToken, psids, nameMap, message, image_url, delay_ms) {
    let sent = 0, failed = 0;
    const base = `https://graph.facebook.com/v19.0/${pageId}/messages`;

    for (const psid of psids) {
        try {
            // Send image first if provided
            if (image_url) {
                const body = new URLSearchParams({
                    recipient:      JSON.stringify({ id: psid }),
                    message:        JSON.stringify({ attachment: { type: 'image', payload: { url: image_url, is_reusable: true } } }),
                    messaging_type: 'UTILITY',
                    access_token:   pageToken
                });
                await fetch(base, { method: 'POST', body });
                await new Promise(r => setTimeout(r, delay_ms));
            }

            // Send text message with {{name}} personalization
            if (message) {
                const recipientName    = nameMap[psid] || 'Friend';
                const personalizedText = message.replace(/\{\{name\}\}/gi, recipientName);
                const body = new URLSearchParams({
                    recipient:      JSON.stringify({ id: psid }),
                    message:        JSON.stringify({ text: personalizedText }),
                    messaging_type: 'UTILITY',
                    access_token:   pageToken
                });
                const r = await fetch(base, { method: 'POST', body });
                const d = await r.json();
                if (d.error) failed++; else sent++;
            } else {
                sent++;
            }
        } catch (_) { failed++; }

        if (delay_ms > 0) await new Promise(r => setTimeout(r, delay_ms));
    }
    return { sent, failed };
}

// Fetch recipients exactly like manual broadcast (fb_api.js fetchConversations)
// Priority: Facebook API with can_reply filter. DB only if FB API returns nothing.
async function fetchPageRecipients(pageId, pageToken) {
    const psidSet = new Set();
    const nameMap = {};

    try {
        let url = `https://graph.facebook.com/v19.0/${pageId}/conversations` +
                  `?fields=id,participants{id,name},can_reply&limit=200&access_token=${pageToken}`;
        while (url) {
            const r    = await fetch(url);
            const data = await r.json();
            if (data.error) throw new Error(data.error.message);
            for (const conv of (data.data || [])) {
                if (conv.can_reply === false) continue; // skip blocked — same as manual broadcast
                for (const p of (conv.participants?.data || [])) {
                    if (!p.id || p.id === pageId) continue;
                    psidSet.add(p.id);
                    if (p.name) nameMap[p.id] = p.name;
                }
            }
            url = data.paging?.next || null;
        }
    } catch (err) {
        logError('fetchPageRecipients_fb', err, { pageId });
    }

    // Only use DB cache if Facebook API returned nothing (network failure etc.)
    if (psidSet.size === 0) {
        try {
            const dbPsids = await db.getPagePsids(pageId);
            dbPsids.forEach(id => psidSet.add(id));
        } catch (_) {}
    }

    return { psids: [...psidSet], nameMap };
}

async function runScheduledBroadcast(schedule) {
    const { id, pages, message, image_url, delay_ms } = schedule;
    await db.updateScheduleStatus(id, 'running');
    try {
        // All pages run simultaneously in parallel
        const results = await Promise.allSettled(
            pages.map(async (page) => {
                const { psids, nameMap } = await fetchPageRecipients(page.id, page.token);
                const { sent, failed }   = await sendToPage(page.id, page.token, psids, nameMap, message, image_url, delay_ms);
                return { recipients: psids.length, sent, failed };
            })
        );

        let totalRecipients = 0, totalSent = 0, totalFailed = 0;
        for (const r of results) {
            if (r.status === 'fulfilled') {
                totalRecipients += r.value.recipients;
                totalSent       += r.value.sent;
                totalFailed     += r.value.failed;
            } else {
                logError('scheduled_broadcast_page', r.reason, { scheduleId: id });
                totalFailed++;
            }
        }
        await db.updateScheduleStatus(id, 'done', { total: totalRecipients, sent: totalSent, failed: totalFailed });
    } catch (err) {
        await db.updateScheduleStatus(id, 'failed', { error: err.message.substring(0, 200) });
        logError('scheduled_broadcast', err, { scheduleId: id });
    }
}

function startBroadcastScheduler() {
    setInterval(async () => {
        try {
            const due = await db.getDueSchedules();
            for (const s of due) {
                runScheduledBroadcast(s).catch(err => logError('scheduler_run', err, { id: s.id }));
            }
        } catch (err) {
            logError('scheduler_tick', err);
        }
    }, 60_000);
    console.log('Broadcast scheduler started (60s interval)');
}

// ── Health & Debug ────────────────────────────────────────────────────────────

app.get('/api/debug/errors', requireAuth, (req, res) => {
    res.json({
        errorLogs: state.errorLogs,
        webhookLogs: state.webhookLogs,
        requestLogs: state.requestLogs.slice(0, 20),
        dbErrors: db.getDbErrorLogs(),
        dbConnected: state.dbConnected,
        sockets: state.connectedSockets.size
    });
});

// Debug: fetch raw FB conversations to diagnose participant issues
app.get('/api/debug/fb-convs', requireAuth, async (req, res) => {
    const { page_id, page_token } = req.query;
    if (!page_id || !page_token) return res.status(400).json({ error: 'page_id and page_token required' });
    try {
        const url = `https://graph.facebook.com/v19.0/${page_id}/conversations?fields=id,participants,snippet,updated_time,unread_count&limit=3&access_token=${page_token}`;
        const r = await fetch(url);
        const data = await r.json();
        res.json({ url_called: url.replace(page_token, '[TOKEN]'), raw: data });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
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
    const root  = paths.PUBLIC;
    let html    = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
    const proto = req.headers['x-forwarded-proto'] || 'https';
    const host  = req.headers['x-forwarded-host'] || req.headers.host || '';
    const siteUrl = process.env.SITE_URL || BASE_URL || (host ? `${proto}://${host}` : '');
    const ver   = Date.now();

    const config = {
        stripePublishableKey: (process.env.STRIPE_PUBLISHABLE_KEY || '').replace(/'/g, "\\'"),
        fbAppId: (process.env.FB_APP_ID || '').replace(/'/g, "\\'"),
        fbRedirectUri: (process.env.FB_REDIRECT_URI || `${siteUrl}/oauth_callback.php`).replace(/'/g, "\\'"),
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
app.get(['/app', '/dashboard.html', '/inbox.html', '/messenger.html', '/index.html'], (req, res) => {
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
    // Skip DB connection errors for static assets — they're non-fatal
    const isDbConnErr = err.code === 'ECONNREFUSED' || err.code === 'ECONNRESET' || err.message?.includes('Connection lost');
    if (!isDbConnErr) {
        logError('express', err, { url: req.url, method: req.method });
    }
    if (res.headersSent) return;
    const isApi = req.url.startsWith('/api/') || req.url.startsWith('/messenger');
    if (isApi) {
        res.status(500).json({ error: 'Internal server error' });
    } else {
        res.status(500).send('<h1>500 Server Error</h1><p>Please try refreshing the page.</p>');
    }
});
  deps.startBroadcastScheduler = startBroadcastScheduler;
};
