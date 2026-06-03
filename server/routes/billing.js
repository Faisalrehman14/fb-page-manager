const express = require('express');
const billing = require('../services/billing.service');
const { ok, fail } = require('../lib/apiResponse');

module.exports = function mountBilling(app, deps) {
    const { db, requireAuth, verifyCsrf, logError } = deps;

    const router = express.Router();

    /** Canonical billing + entitlement state (single source for clients) */
    router.get('/status', requireAuth, async (req, res) => {
        try {
            const uid = req.session.userId;
            if (!uid) return fail(res, 'Not authenticated', 401);
            const status = await billing.getBillingStatus(db, uid);
            ok(res, status);
        } catch (err) {
            fail(res, err.message, err.status || 500);
        }
    });

    router.get('/subscription', requireAuth, async (req, res) => {
        try {
            const summary = await billing.getSubscriptionSummary(db, req.session.userId);
            ok(res, summary);
        } catch (err) {
            fail(res, err.message, err.status || 500);
        }
    });

    router.post('/sync', requireAuth, verifyCsrf, async (req, res) => {
        try {
            const uid = req.session.userId;
            if (!uid) return fail(res, 'Not authenticated', 401);
            const syncResult = await billing.syncBillingFromStripe(db, uid);
            const status = await billing.getBillingStatus(db, uid);
            ok(res, { sync: syncResult, ...status });
        } catch (err) {
            fail(res, err.message, err.status || 500);
        }
    });

    const handleCheckout = async (req, res) => {
        try {
            const plan = (req.body.plan || '').trim();
            const fbUserId = (req.body.fb_user_id || req.session.userId || '').trim();
            if (!fbUserId || fbUserId !== req.session.userId) {
                return res.status(401).json({ error: 'Please log in with Facebook before purchasing.' });
            }
            const result = await billing.createCheckoutSession(db, req, { planKey: plan, fbUserId });
            res.json(result);
        } catch (err) {
            res.status(err.status || 500).json({ error: err.message });
        }
    };

    router.get('/providers', requireAuth, (req, res) => {
        ok(res, billing.getPaymentProviders());
    });

    router.post('/checkout', requireAuth, verifyCsrf, handleCheckout);
    app.post('/api/billing/checkout', requireAuth, verifyCsrf, handleCheckout);

    const handleBinanceCheckout = async (req, res) => {
        try {
            const plan = (req.body.plan || '').trim();
            const fbUserId = (req.body.fb_user_id || req.session.userId || '').trim();
            if (!fbUserId || fbUserId !== req.session.userId) {
                return res.status(401).json({ error: 'Please log in with Facebook before purchasing.' });
            }
            const result = await billing.createBinanceCheckoutSession(db, req, { planKey: plan, fbUserId });
            res.json(result);
        } catch (err) {
            res.status(err.status || 500).json({ error: err.message });
        }
    };

    router.post('/checkout/binance', requireAuth, verifyCsrf, handleBinanceCheckout);
    app.post('/api/billing/checkout/binance', requireAuth, verifyCsrf, handleBinanceCheckout);

    router.post('/portal', requireAuth, verifyCsrf, async (req, res) => {
        try {
            const fbUserId = req.session.userId;
            if (!fbUserId) return fail(res, 'Not authenticated', 401);
            const result = await billing.createPortalSession(db, req, fbUserId);
            ok(res, result);
        } catch (err) {
            fail(res, err.message, err.status || 500);
        }
    });

    app.post('/api/billing/webhook', async (req, res) => {
        try {
            const sig = req.headers['stripe-signature'];
            const raw = req.rawBody || (typeof req.body === 'string' ? Buffer.from(req.body) : Buffer.from(JSON.stringify(req.body || {})));
            if (!sig || !raw?.length) return res.status(400).send('Missing signature or body');
            const result = await billing.handleWebhook(db, raw, sig, logError);
            res.json(result);
        } catch (err) {
            res.status(err.status || 500).json({ error: err.message });
        }
    });

    app.post('/api/billing/webhook/binance', async (req, res) => {
        try {
            const raw = req.rawBody || (typeof req.body === 'string' ? Buffer.from(req.body) : Buffer.from(JSON.stringify(req.body || {})));
            if (!raw?.length) return res.status(400).json({ returnCode: 'FAIL', returnMessage: 'Missing body' });
            const result = await billing.handleBinanceWebhook(db, raw, req.headers, logError);
            res.json(result);
        } catch (err) {
            logError?.('binance_webhook_route', err);
            res.status(err.status || 500).json({ returnCode: 'FAIL', returnMessage: err.message });
        }
    });

    app.use('/api/billing', router);
};
