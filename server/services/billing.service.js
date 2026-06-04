const { getStripe, isStripeConfigured } = require('../integrations/stripe-client');
const { getPlan, listPlanKeys, planForPriceId } = require('../config/plans');
const entitlements = require('./entitlements.service');
const transactionalEmail = require('./transactional-email.service');
const env = require('../config/env');

async function applyPlanAndNotify(db, fbUserId, planKey, opts = {}, logError) {
    const result = await db.applyPlan(fbUserId, planKey, opts);
    if (result?.planKey) {
        transactionalEmail.queueSubscriptionActivated(
            fbUserId, result.planKey, result.billingReason, logError
        );
    }
    return result;
}

function resolveSiteUrl(req) {
    const envUrl = (env.SITE_URL || env.BASE_URL || '').trim().replace(/\/$/, '');
    if (envUrl) return envUrl;
    const proto = String(req?.headers?.['x-forwarded-proto'] || req?.protocol || 'https').split(',')[0].trim();
    const host = String(req?.headers?.['x-forwarded-host'] || req?.headers?.host || '').split(',')[0].trim();
    return host ? `${proto}://${host}` : `http://localhost:${env.PORT || 3000}`;
}

function isValidPriceId(priceId) {
    return priceId && priceId.startsWith('price_') && !priceId.includes('YOUR') && !priceId.includes('PLACEHOLDER');
}

function resolvePlanKeyFromSubscription(sub) {
    const metaKey = sub?.metadata?.plan;
    if (metaKey && getPlan(metaKey)) return metaKey;
    const priceId = sub?.items?.data?.[0]?.price?.id
        || sub?.plan?.id
        || null;
    const fromPrice = planForPriceId(priceId);
    return fromPrice?.key || null;
}

async function syncSubscriptionFromStripe(db, sub, opts = {}) {
    const fbUserId = sub?.metadata?.fb_user_id;
    if (!fbUserId) return { synced: false, reason: 'no_fb_user_id' };

    const planKey = resolvePlanKeyFromSubscription(sub);
    const status = String(sub?.status || '').toLowerCase();
    const activeStatuses = new Set(['active', 'trialing']);

    if (activeStatuses.has(status) && planKey) {
        const reason = opts.billingReason || 'subscription_sync';
        if (reason === 'customer.subscription.created') {
            await applyPlanAndNotify(db, fbUserId, planKey, {
                subscriptionId: sub.id,
                billingReason: reason
            }, opts.logError);
        } else {
            await db.applyPlan(fbUserId, planKey, {
                subscriptionId: sub.id,
                billingReason: reason
            });
        }
        return { synced: true, action: 'apply', planKey };
    }

    if (['canceled', 'unpaid', 'incomplete_expired', 'past_due'].includes(status)) {
        if (status === 'past_due') {
            return { synced: true, action: 'past_due_kept' };
        }
        await db.downgradeToFree(fbUserId);
        return { synced: true, action: 'downgrade' };
    }

    return { synced: false, reason: 'unhandled_status', status };
}

async function createCheckoutSession(db, req, { planKey, fbUserId }) {
    if (!isStripeConfigured()) {
        throw Object.assign(new Error('Payment system is not configured. Contact support.'), { status: 503 });
    }
    const plan = getPlan(planKey);
    if (!plan) {
        throw Object.assign(new Error(`Invalid plan: ${planKey}. Valid: ${listPlanKeys().join(', ')}`), { status: 400 });
    }
    const priceId = plan.priceId();
    if (!isValidPriceId(priceId)) {
        throw Object.assign(new Error(`Stripe price not configured for plan "${planKey}". Set STRIPE_${planKey.toUpperCase()}_PRICE_ID in .env`), { status: 503 });
    }

    const pool = db.getPool?.() || db.pool;
    if (!pool) throw Object.assign(new Error('Database unavailable'), { status: 503 });

    const [rows] = await pool.query(
        'SELECT fb_user_id, email, stripe_customer_id FROM users WHERE fb_user_id = ?',
        [fbUserId]
    );
    if (!rows.length) {
        throw Object.assign(new Error('User not found. Please connect Facebook first.'), { status: 404 });
    }
    const user = rows[0];

    const stripe = getStripe();
    let customerId = user.stripe_customer_id || null;

    if (customerId) {
        try {
            const c = await stripe.customers.retrieve(customerId);
            if (c.deleted) customerId = null;
        } catch (_) {
            customerId = null;
        }
    }

    if (!customerId) {
        const customer = await stripe.customers.create({
            name: user.email || fbUserId,
            metadata: { fb_user_id: fbUserId }
        });
        customerId = customer.id;
        await pool.query('UPDATE users SET stripe_customer_id = ? WHERE fb_user_id = ?', [customerId, fbUserId]);
    }

    const baseUrl = resolveSiteUrl(req);
    const session = await stripe.checkout.sessions.create({
        mode: 'subscription',
        customer: customerId,
        line_items: [{ price: priceId, quantity: 1 }],
        client_reference_id: fbUserId,
        success_url: `${baseUrl}/?payment=success&session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${baseUrl}/?payment=cancelled`,
        allow_promotion_codes: true,
        billing_address_collection: 'auto',
        metadata: { fb_user_id: fbUserId, plan: planKey },
        subscription_data: {
            metadata: { fb_user_id: fbUserId, plan: planKey }
        }
    });

    return { url: session.url, sessionId: session.id };
}

async function createPortalSession(db, req, fbUserId) {
    if (!isStripeConfigured()) {
        throw Object.assign(new Error('Billing portal is not configured.'), { status: 503 });
    }
    const pool = db.getPool?.() || db.pool;
    const [rows] = await pool.query('SELECT stripe_customer_id FROM users WHERE fb_user_id = ?', [fbUserId]);
    const customerId = rows[0]?.stripe_customer_id;
    if (!customerId) {
        throw Object.assign(new Error('No billing account found. Subscribe to a plan first.'), { status: 404 });
    }
    const stripe = getStripe();
    const portal = await stripe.billingPortal.sessions.create({
        customer: customerId,
        return_url: resolveSiteUrl(req) + '/?view=settings'
    });
    return { url: portal.url };
}

async function syncBillingFromStripe(db, fbUserId) {
    if (!isStripeConfigured()) {
        throw Object.assign(new Error('Stripe is not configured'), { status: 503 });
    }
    const pool = db.getPool?.() || db.pool;
    if (!pool) throw Object.assign(new Error('Database unavailable'), { status: 503 });

    const [rows] = await pool.query(
        'SELECT stripe_subscription_id, stripe_customer_id FROM users WHERE fb_user_id = ?',
        [fbUserId]
    );
    const subId = rows[0]?.stripe_subscription_id;
    if (!subId) {
        return { synced: false, reason: 'no_subscription' };
    }

    const stripe = getStripe();
    const sub = await stripe.subscriptions.retrieve(subId);
    return syncSubscriptionFromStripe(db, sub, { billingReason: 'manual_sync' });
}

async function handleWebhook(db, rawBody, signature, logError) {
    if (!env.STRIPE_WEBHOOK_SECRET) {
        throw Object.assign(new Error('Webhook secret not configured'), { status: 503 });
    }
    const stripe = getStripe();
    let event;
    try {
        event = stripe.webhooks.constructEvent(rawBody, signature, env.STRIPE_WEBHOOK_SECRET);
    } catch (err) {
        throw Object.assign(new Error('Invalid webhook signature'), { status: 400, cause: err });
    }

    if (env.APP_ENV === 'production' && event.livemode === false) {
        return { received: true, ignored: 'test_mode' };
    }

    const pool = db.getPool?.() || db.pool;
    if (!pool) throw new Error('Database unavailable');

    await db.ensureBillingTables?.();

    const reserved = await db.reserveWebhookEvent?.(event.id, event.type, JSON.stringify(event));
    if (reserved === 'processed') return { received: true, duplicate: true };

    try {
        switch (event.type) {
            case 'checkout.session.completed':
            case 'checkout.session.async_payment_succeeded': {
                const session = event.data.object;
                const fbUserId = session.metadata?.fb_user_id || session.client_reference_id;
                const planKey = session.metadata?.plan;
                const subId = session.subscription;
                const email = session.customer_details?.email || session.customer_email || '';
                if (fbUserId && planKey && getPlan(planKey)) {
                    await applyPlanAndNotify(db, fbUserId, planKey, {
                        subscriptionId: subId,
                        email,
                        amountCents: session.amount_total || 0,
                        invoiceId: session.invoice || subId || '',
                        billingReason: event.type
                    }, logError);
                }
                break;
            }
            case 'customer.subscription.created':
            case 'customer.subscription.updated': {
                const sub = event.data.object;
                await syncSubscriptionFromStripe(db, sub, { billingReason: event.type, logError });
                break;
            }
            case 'customer.subscription.deleted': {
                const sub = event.data.object;
                const fbUserId = sub.metadata?.fb_user_id;
                if (fbUserId) await db.downgradeToFree(fbUserId);
                break;
            }
            case 'invoice.payment_succeeded': {
                const invoice = event.data.object;
                const subId = invoice.subscription;
                if (!subId) break;
                const sub = await stripe.subscriptions.retrieve(subId);
                const fbUserId = sub.metadata?.fb_user_id;
                const planKey = resolvePlanKeyFromSubscription(sub);
                if (fbUserId && planKey && getPlan(planKey)) {
                    await db.renewPlan(fbUserId, planKey, {
                        invoiceId: invoice.id,
                        amountCents: invoice.amount_paid || 0,
                        billingReason: invoice.billing_reason || 'subscription_cycle'
                    });
                }
                break;
            }
            case 'invoice.payment_failed': {
                const invoice = event.data.object;
                const custId = invoice.customer;
                if (custId) {
                    const [userRows] = await pool.query('SELECT fb_user_id FROM users WHERE stripe_customer_id = ?', [custId]);
                    if (userRows[0]) {
                        await db.recordPayment(userRows[0].fb_user_id, {
                            invoiceId: invoice.id,
                            plan: 'unknown',
                            amountCents: invoice.amount_due || 0,
                            status: 'failed',
                            billingReason: 'subscription_cycle'
                        });
                        await pool.query(
                            'INSERT INTO activity_log (fb_user_id, action, detail) VALUES (?, ?, ?)',
                            [userRows[0].fb_user_id, 'payment_failed', 'Stripe payment failed']
                        ).catch(() => {});
                    }
                }
                break;
            }
            default:
                break;
        }
        await db.markWebhookProcessed?.(event.id);
        return { received: true };
    } catch (err) {
        await db.markWebhookFailed?.(event.id, err.message);
        logError?.('stripe_webhook', err);
        throw err;
    }
}

async function getBillingStatus(db, fbUserId) {
    const status = await entitlements.resolveEntitlements(db, fbUserId);
    status.billing.stripeConfigured = isStripeConfigured();
    return status;
}

/** @deprecated Use getBillingStatus — kept for billing.js settings card */
async function getSubscriptionSummary(db, fbUserId) {
    const ent = await getBillingStatus(db, fbUserId);
    return {
        plan: ent.plan,
        messagesUsed: ent.messagesUsed,
        messageLimit: ent.messageLimit,
        remaining: ent.remaining,
        subscriptionStatus: ent.subscriptionStatus,
        subscriptionExpires: ent.subscription.renewsAt,
        stripeSubscriptionId: ent.subscription.stripeSubscriptionId,
        hasSubscription: ent.subscription.hasStripeSubscription,
        email: ent.billing.email,
        trialDaysLeft: ent.trialDaysLeft,
        trialExpired: ent.trialExpired,
        onFreeTrial: ent.onFreeTrial,
        planName: ent.display.badge,
        subscriptionLifecycle: ent.subscription.status
    };
}

module.exports = {
    createCheckoutSession,
    createPortalSession,
    handleWebhook,
    getBillingStatus,
    getSubscriptionSummary,
    syncBillingFromStripe,
    syncSubscriptionFromStripe,
    isStripeConfigured,
    resolveSiteUrl
};
