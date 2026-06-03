/**
 * Entitlement resolver — billing, trial, and usage in one canonical payload.
 * All quota/billing read paths should use resolveEntitlements().
 */
const {
    PLANS,
    FREE_TIER,
    FREE_TRIAL_DAYS,
    getDisplayForDbPlan,
    resolvePlanKey,
    planForPriceId
} = require('../config/plans');

function detectCatalogKey(dbPlan, messageLimit) {
    const plan = String(dbPlan || 'free').toLowerCase();
    if (plan === 'free') return 'free';
    const limit = Number(messageLimit) || 0;
    for (const p of Object.values(PLANS)) {
        if (p.dbPlan === plan && p.limit === limit) return p.key;
    }
    if (plan === 'basic' && limit > 0 && limit <= 50000) return 'starter';
    const resolved = resolvePlanKey(plan);
    return resolved && resolved !== 'free' ? resolved : plan;
}

function deriveSubscriptionStatus(row, effective) {
    const dbPlan = String(row?.plan || 'free').toLowerCase();
    const isPaid = dbPlan !== 'free' && dbPlan !== 'unknown';
    const paidExpired = isPaid && row?.subscription_expires && new Date(row.subscription_expires) < new Date();

    if (effective.onTrial) return 'trialing';
    if (isPaid && !paidExpired) return 'active';
    if (row?.stripe_subscription_id && dbPlan === 'free' && effective.effectiveLimit === 0) return 'canceled';
    if (effective.trialExpired && dbPlan === 'free') return 'expired';
    return 'none';
}

function deriveBlockCode(effective, canSend) {
    if (canSend) return null;
    if (effective.trialExpired && effective.plan === 'free') return 'TRIAL_EXPIRED';
    if (effective.effectiveLimit === 0 && effective.plan === 'free') return 'TRIAL_EXPIRED';
    return 'QUOTA_EXCEEDED';
}

function defaultEntitlements() {
    return buildEntitlementPayload(null, {
        effectiveLimit: 0,
        used: 0,
        remaining: 0,
        trialDaysLeft: 0,
        trialExpired: true,
        onTrial: false,
        plan: 'free',
        freeTrialExpiresAt: null
    });
}

function buildEntitlementPayload(row, effective) {
    const dbPlan = String(effective.plan || row?.plan || 'free').toLowerCase();
    const catalogKey = detectCatalogKey(dbPlan, row?.messenger_messages_limit ?? effective.effectiveLimit);
    const display = getDisplayForDbPlan(dbPlan, effective.effectiveLimit);
    const subStatus = deriveSubscriptionStatus(row, effective);
    const canSend = effective.remaining > 0;
    const blockCode = deriveBlockCode(effective, canSend);

    const onTrial = !!effective.onTrial;
    const trialExpired = !!effective.trialExpired;

    let badgeLabel = display.label;
    if (onTrial) badgeLabel = 'Free Trial';
    else if (subStatus === 'expired' && dbPlan === 'free') badgeLabel = 'Free';

    const payload = {
        entitlements: {
            canSend,
            messagesRemaining: effective.remaining,
            messagesLimit: effective.effectiveLimit,
            messagesUsed: effective.used,
            blockCode,
            blockMessage: blockCode === 'TRIAL_EXPIRED'
                ? 'Your 7-day free trial has ended. Please upgrade to continue sending.'
                : (blockCode === 'QUOTA_EXCEEDED'
                    ? 'Message quota exceeded. Upgrade your plan to continue.'
                    : null)
        },
        trial: {
            active: onTrial,
            daysLeft: onTrial ? (effective.trialDaysLeft ?? null) : (trialExpired ? 0 : null),
            expired: trialExpired && dbPlan === 'free',
            expiresAt: effective.freeTrialExpiresAt || null,
            messageCap: FREE_TIER.limit,
            durationDays: FREE_TRIAL_DAYS
        },
        subscription: {
            status: subStatus,
            dbPlan,
            catalogKey: catalogKey === 'free' ? null : catalogKey,
            planName: badgeLabel,
            renewsAt: row?.subscription_expires
                ? new Date(row.subscription_expires).toISOString()
                : null,
            stripeSubscriptionId: row?.stripe_subscription_id || null,
            stripeCustomerId: row?.stripe_customer_id || null,
            hasStripeSubscription: !!row?.stripe_subscription_id
        },
        billing: {
            email: row?.email || null
        },
        display: {
            badge: badgeLabel,
            dataPlan: onTrial ? 'free' : display.dataPlan,
            upgradeRequired: !canSend
        },
        // Legacy flat fields (track_user, saveQuota, older clients)
        success: true,
        subscriptionStatus: dbPlan,
        plan: dbPlan,
        messageLimit: effective.effectiveLimit,
        messagesUsed: effective.used,
        messenger_messagesUsed: effective.used,
        remaining: effective.remaining,
        trialDaysLeft: effective.trialDaysLeft,
        trialExpired,
        onFreeTrial: onTrial,
        freeTrialExpiresAt: effective.freeTrialExpiresAt,
        canSend,
        code: blockCode
    };
    return payload;
}

async function resolveEntitlements(db, fbUserId) {
    if (!fbUserId) return defaultEntitlements();
    const computed = await db.computeEntitlements?.(fbUserId);
    if (!computed) return defaultEntitlements();
    return buildEntitlementPayload(computed.row, computed.effective);
}

/** Map entitlement payload → client quota memory */
function toQuotaClientPayload(ent) {
    if (!ent) return null;
    return {
        subscriptionStatus: ent.subscriptionStatus || ent.plan || 'free',
        messageLimit: ent.messageLimit,
        messagesUsed: ent.messagesUsed,
        trialDaysLeft: ent.trialDaysLeft,
        trialExpired: ent.trialExpired,
        onFreeTrial: ent.onFreeTrial,
        freeTrialExpiresAt: ent.freeTrialExpiresAt,
        plan: ent.plan
    };
}

module.exports = {
    resolveEntitlements,
    toQuotaClientPayload,
    buildEntitlementPayload,
    detectCatalogKey,
    planForPriceId
};
