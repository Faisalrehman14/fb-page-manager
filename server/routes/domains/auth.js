/** auth routes */
module.exports = function mountAuth(app, ctx) {
  const {
    db, io, fetch, env, paths, state, logError,
    upload, uploadDisk, syncCooldown,
    requireAuth, verifyCsrf, requireAdminAuth, generateCsrf,
    mountMessenger,
    FB_APP_ID, FB_APP_SECRET, BASE_URL, PORT, WEBHOOK_VERIFY_TOKEN, ADMIN_PASSWORD,
    path, fs, crypto, MAX_LOGS, fbNames, entitlementsSvc, aiAssistant,
    SearchService, threadHasLiveViewers, runMetaReviewTestCalls, FB_GRAPH_BASE,
    graphUrlWithProof,
    express, FB_GV, FB_OAUTH_SCOPES, buildFacebookOAuthUrl,
    stripUserTokens, getClientIp, fbProfilePicture, applyMeToSession,
    FB_ME_FIELDS, recordMetaReviewTests, trackUserSession, resolveSiteUrl
  } = ctx;

const appAuth = require('../../services/app-auth.service');
const transactionalEmail = require('../../services/transactional-email.service');

const appCookieOpts = { signed: true, httpOnly: true, sameSite: 'lax', maxAge: 30 * 24 * 60 * 60 * 1000, path: '/' };

function sendAuthStatus(req, res) {
    const hasApp = !!req.session.appAccountId;
    const hasFb = !!req.session.accessToken;
    res.json({
        authenticated: hasApp || hasFb,
        appAccount: hasApp ? {
            id: req.session.appAccountId,
            email: req.session.appEmail || null,
            firstName: req.session.appFirstName || null
        } : null,
        facebookConnected: hasFb,
        userName: req.session.userName || null,
        userId: req.session.userId || null
    });
}

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
        await recordMetaReviewTests(user_token);

        const uRes  = await fetch(graphUrlWithProof(`/me?fields=${FB_ME_FIELDS}`, user_token));
        const uData = await uRes.json();
        if (uData.error) return res.status(401).json({ error: uData.error.message });
        req.session.accessToken = user_token;

        const pagesRes = await fetch(graphUrlWithProof('/me/accounts?fields=id,name,link,access_token,category,picture.type(large)', user_token));
        const pagesData = await pagesRes.json();
        const pages = pagesData.data || [];
        req.session.pageTokens = {};
        pages.forEach(p => { req.session.pageTokens[p.id] = p.access_token; });

        applyMeToSession(req, uData, user_token);
        req.session.firstLogin  = !req.session.firstLogin ? true : false;
        await trackUserSession(req, pages.map(p => ({ id: p.id, name: p.name, link: p.link })));

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
    res.json({ authUrl: buildFacebookOAuthUrl({ appId: FB_APP_ID, redirectUri, state }) });
});

app.get('/api/auth/redirect-callback', async (req, res) => {
    const { code, state, error } = req.query;
    if (error)  return res.redirect('/?error=' + encodeURIComponent(error));
    if (!state || state !== req.session.oauthState) return res.redirect('/?error=invalid_state');
    try {
        const redirectUri = `${BASE_URL}/api/auth/redirect-callback`;
        const tRes  = await fetch(`${FB_GRAPH_BASE}/oauth/access_token?client_id=${FB_APP_ID}&redirect_uri=${encodeURIComponent(redirectUri)}&client_secret=${FB_APP_SECRET}&code=${code}`);
        const tData = await tRes.json();
        if (tData.error) throw new Error(tData.error.message);

        const userToken = tData.access_token;
        await recordMetaReviewTests(userToken);

        const uRes  = await fetch(graphUrlWithProof(`/me?fields=${FB_ME_FIELDS}`, userToken));
        const uData = await uRes.json();
        if (uData.error) throw new Error(uData.error.message);

        const pagesRes = await fetch(graphUrlWithProof('/me/accounts?fields=id,name,link,access_token,category,picture.type(large)', userToken));
        const pagesData = await pagesRes.json();
        const pages = pagesData.data || [];

        req.session.accessToken = userToken;
        req.session.pageTokens = {};
        pages.forEach(p => { req.session.pageTokens[p.id] = p.access_token; });
        applyMeToSession(req, uData, userToken);
        req.session.oauthState  = null;
        req.session.firstLogin  = true;
        req.session.clientPagesCache = pages.map(p => ({
            id: p.id,
            name: p.name,
            access_token: p.access_token,
            category: p.category,
            picture: p.picture?.data?.url || p.picture || null
        }));
        await trackUserSession(req, pages.map(p => ({ id: p.id, name: p.name, link: p.link })));
        res.redirect('/');
    } catch (err) {
        logError('auth_callback', err);
        res.redirect('/?error=' + encodeURIComponent('Login failed: ' + err.message));
    }
});

const emailService = require('../../services/email.service');
const otpSvc = require('../../services/email-otp.service');

app.get('/api/auth/email-status', (req, res) => {
    res.json(emailService.getPublicEmailStatus());
});

app.post('/api/auth/register/send-otp', async (req, res) => {
    try {
        const email = appAuth.validateEmail(req.body.email);
        if (!email) return res.status(400).json({ error: 'Valid email is required' });
        if (!state.dbConnected) return res.status(503).json({ error: 'Database unavailable' });

        const emailStatus = emailService.getPublicEmailStatus();
        if (!emailStatus.ready) {
            return res.status(503).json({
                error: emailStatus.message,
                code: emailStatus.reason
            });
        }

        const existing = await db.getAppAccountByEmail(email);
        if (existing) return res.status(409).json({ error: 'An account with this email already exists' });

        const waitSec = await db.getEmailOtpCooldownRemaining(
            email, 'signup', otpSvc.RESEND_COOLDOWN_MS
        );
        if (waitSec > 0) {
            return res.status(429).json({
                error: `Please wait ${waitSec} seconds before requesting another code.`,
                retryAfter: waitSec
            });
        }

        const code = otpSvc.generateOtpCode();
        await db.saveEmailOtp({
            email,
            purpose: 'signup',
            otpHash: otpSvc.hashOtp(code),
            ttlMs: otpSvc.OTP_TTL_MS
        });
        await emailService.sendSignupOtpEmail(email, code);

        res.json({
            success: true,
            message: 'Verification code sent to your email.',
            expiresInMinutes: 10
        });
    } catch (err) {
        logError('auth_send_otp', err);
        const mapped = emailService.mapEmailError?.(err) || err;
        const isAdminHint = mapped.adminOnly || mapped.provider === 'resend';
        const msg = isAdminHint && mapped.message
            ? mapped.message
            : emailService.toPublicEmailError(err).message;
        res.status(mapped.status || 503).json({ error: msg });
    }
});

app.post('/api/auth/register', async (req, res) => {
    try {
        const email = appAuth.validateEmail(req.body.email);
        if (!email) return res.status(400).json({ error: 'Valid email is required' });
        const otp = String(req.body.otp || req.body.code || '').trim();
        if (!/^\d{6}$/.test(otp)) {
            return res.status(400).json({ error: 'Enter the 6-digit verification code from your email' });
        }
        const pwErr = appAuth.validatePassword(req.body.password);
        if (pwErr) return res.status(400).json({ error: pwErr });
        if (String(req.body.password) !== String(req.body.confirmPassword || req.body.confirm_password || '')) {
            return res.status(400).json({ error: 'Passwords do not match' });
        }
        if (!state.dbConnected) return res.status(503).json({ error: 'Database unavailable' });

        const existing = await db.getAppAccountByEmail(email);
        if (existing) return res.status(409).json({ error: 'An account with this email already exists' });

        const otpCheck = await db.verifyAndConsumeEmailOtp(
            email, 'signup', otpSvc.hashOtp(otp), otpSvc.MAX_ATTEMPTS
        );
        if (!otpCheck.ok) {
            const msgs = {
                expired_or_missing: 'Verification code expired. Click Send code again.',
                invalid_code: 'Incorrect verification code.',
                too_many_attempts: 'Too many attempts. Request a new code.'
            };
            return res.status(400).json({ error: msgs[otpCheck.reason] || 'Invalid verification code' });
        }

        const account = await db.createAppAccount({
            email,
            passwordHash: appAuth.hashPassword(req.body.password),
            firstName: String(req.body.firstName || req.body.first_name || '').trim().slice(0, 120),
            lastName: String(req.body.lastName || req.body.last_name || '').trim().slice(0, 120),
            referralName: String(req.body.referralName || req.body.referral || '').trim().slice(0, 255)
        });

        appAuth.setAppSession(req, account);
        res.cookie('_app_aid', String(account.id), appCookieOpts);
        generateCsrf(req);
        transactionalEmail.queueWelcomeForAppAccount(account, logError);
        await new Promise((resolve, reject) => {
            req.session.save((err) => (err ? reject(err) : resolve()));
        });
        res.json({ success: true, account: { id: account.id, email: account.email }, redirect: '/' });
    } catch (err) {
        logError('auth_register', err);
        res.status(500).json({ error: err.message || 'Registration failed' });
    }
});

app.post('/api/auth/forgot-password/send-otp', async (req, res) => {
    try {
        const email = appAuth.validateEmail(req.body.email);
        if (!email) return res.status(400).json({ error: 'Valid email is required' });
        if (!state.dbConnected) return res.status(503).json({ error: 'Database unavailable' });

        const emailStatus = emailService.getPublicEmailStatus();
        if (!emailStatus.ready) {
            return res.status(503).json({
                error: emailStatus.message,
                code: emailStatus.reason
            });
        }

        const account = await db.getAppAccountByEmail(email);
        if (account) {
            const waitSec = await db.getEmailOtpCooldownRemaining(
                email, 'password_reset', otpSvc.RESEND_COOLDOWN_MS
            );
            if (waitSec > 0) {
                return res.status(429).json({
                    error: `Please wait ${waitSec} seconds before requesting another code.`,
                    retryAfter: waitSec
                });
            }

            const code = otpSvc.generateOtpCode();
            await db.saveEmailOtp({
                email,
                purpose: 'password_reset',
                otpHash: otpSvc.hashOtp(code),
                ttlMs: otpSvc.OTP_TTL_MS
            });
            await emailService.sendPasswordResetOtpEmail(email, code);
        }

        res.json({
            success: true,
            message: 'If an account exists for this email, a reset code has been sent.',
            expiresInMinutes: 10
        });
    } catch (err) {
        logError('auth_forgot_send_otp', err);
        const mapped = emailService.mapEmailError?.(err) || err;
        const isAdminHint = mapped.adminOnly || mapped.provider === 'resend';
        const msg = isAdminHint && mapped.message
            ? mapped.message
            : emailService.toPublicEmailError(err).message;
        res.status(mapped.status || 503).json({ error: msg });
    }
});

app.post('/api/auth/reset-password', async (req, res) => {
    try {
        const email = appAuth.validateEmail(req.body.email);
        if (!email) return res.status(400).json({ error: 'Valid email is required' });
        const otp = String(req.body.otp || req.body.code || '').trim();
        if (!/^\d{6}$/.test(otp)) {
            return res.status(400).json({ error: 'Enter the 6-digit code from your email' });
        }
        const pwErr = appAuth.validatePassword(req.body.password);
        if (pwErr) return res.status(400).json({ error: pwErr });
        if (String(req.body.password) !== String(req.body.confirmPassword || req.body.confirm_password || '')) {
            return res.status(400).json({ error: 'Passwords do not match' });
        }
        if (!state.dbConnected) return res.status(503).json({ error: 'Database unavailable' });

        const account = await db.getAppAccountByEmail(email);
        if (!account) {
            return res.status(400).json({ error: 'Invalid or expired reset code' });
        }

        const otpCheck = await db.verifyAndConsumeEmailOtp(
            email, 'password_reset', otpSvc.hashOtp(otp), otpSvc.MAX_ATTEMPTS
        );
        if (!otpCheck.ok) {
            const msgs = {
                expired_or_missing: 'Reset code expired. Request a new code.',
                invalid_code: 'Incorrect reset code.',
                too_many_attempts: 'Too many attempts. Request a new code.'
            };
            return res.status(400).json({ error: msgs[otpCheck.reason] || 'Invalid reset code' });
        }

        const updated = await db.updateAppAccountPassword(email, appAuth.hashPassword(req.body.password));
        if (!updated) return res.status(500).json({ error: 'Could not update password' });

        res.json({
            success: true,
            message: 'Password updated. You can sign in with your new password.',
            redirect: '/login'
        });
    } catch (err) {
        logError('auth_reset_password', err);
        res.status(500).json({ error: err.message || 'Password reset failed' });
    }
});

app.post('/api/auth/login', async (req, res) => {
    try {
        const email = appAuth.validateEmail(req.body.email);
        const password = String(req.body.password || '');
        if (!email || !password) return res.status(400).json({ error: 'Email and password are required' });
        if (!state.dbConnected) return res.status(503).json({ error: 'Database unavailable' });

        const account = await db.getAppAccountByEmail(email);
        if (!account || !appAuth.verifyPassword(password, account.password_hash)) {
            return res.status(401).json({ error: 'Invalid email or password' });
        }

        appAuth.setAppSession(req, account);
        res.cookie('_app_aid', String(account.id), appCookieOpts);

        const { tryRestoreFacebookFromAppAccount } = require('../../middleware/session-hydrate');
        await tryRestoreFacebookFromAppAccount(req);

        if (req.session.accessToken && req.session.userId) {
            const cookieOpts = { signed: true, httpOnly: true, sameSite: 'lax', maxAge: 7 * 24 * 60 * 60 * 1000 };
            res.cookie('_fb_at', req.session.accessToken, cookieOpts);
            res.cookie('_fb_uid', req.session.userId, cookieOpts);
            if (req.session.userName) res.cookie('_fb_un', req.session.userName, cookieOpts);
        }

        generateCsrf(req);
        transactionalEmail.queueWelcomeForAppAccount(account, logError);
        const payload = {
            success: true,
            facebookConnected: !!req.session.accessToken,
            userId: req.session.userId || null,
            userName: req.session.userName || null,
            redirect: '/'
        };
        await new Promise((resolve, reject) => {
            req.session.save((err) => (err ? reject(err) : resolve()));
        });
        res.json(payload);
    } catch (err) {
        logError('auth_login', err);
        res.status(500).json({ error: err.message || 'Login failed' });
    }
});

app.get('/api/auth/status', (req, res) => {
    sendAuthStatus(req, res);
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
    appAuth.clearAppSession(req);
    const cookieOpts = { path: '/', signed: true, httpOnly: true, sameSite: 'lax' };
    res.clearCookie('_app_aid', appCookieOpts);
    res.clearCookie('_fb_at', cookieOpts);
    res.clearCookie('_fb_uid', cookieOpts);
    res.clearCookie('_fb_un', cookieOpts);
    req.session.destroy(err => {
        if (err) logError('auth_logout', err);
        res.json({ success: true, redirect: '/' });
    });
});


};
