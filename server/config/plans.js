/**
 * SaaS plan catalog — Stripe price IDs from env, limits enforced server-side.
 */
const PLANS = {
    starter: {
        key: 'starter',
        name: 'Starter',
        dbPlan: 'basic',
        priceId: () => (process.env.STRIPE_STARTER_PRICE_ID || '').trim(),
        limit: 30000,
        interval: 'month',
        amountCents: 500
    },
    basic: {
        key: 'basic',
        name: 'Bronze',
        dbPlan: 'basic',
        priceId: () => (process.env.STRIPE_BASIC_PRICE_ID || '').trim(),
        limit: 300000,
        interval: 'month',
        amountCents: 1500
    },
    pro: {
        key: 'pro',
        name: 'Silver',
        dbPlan: 'pro',
        priceId: () => (process.env.STRIPE_PRO_PRICE_ID || '').trim(),
        limit: 650000,
        interval: 'month',
        amountCents: 3000
    },
    gold: {
        key: 'gold',
        name: 'Gold',
        dbPlan: 'gold',
        priceId: () => (process.env.STRIPE_GOLD_PRICE_ID || '').trim(),
        limit: 1750000,
        interval: 'month',
        amountCents: 6000
    },
    sapphire: {
        key: 'sapphire',
        name: 'Sapphire',
        dbPlan: 'sapphire',
        priceId: () => (process.env.STRIPE_SAPPHIRE_PRICE_ID || '').trim(),
        limit: 4000000,
        interval: 'month',
        amountCents: 10000
    },
    pro_unlimited: {
        key: 'pro_unlimited',
        name: 'Platinum',
        dbPlan: 'platinum',
        priceId: () => (process.env.STRIPE_PRO_UNLIMITED_PRICE_ID || '').trim(),
        limit: 7000000,
        interval: 'month',
        amountCents: 15000
    }
};

const FREE_TIER = { limit: 2000, dbPlan: 'free' };

function getPlan(key) {
    return PLANS[key] || null;
}

function listPlanKeys() {
    return Object.keys(PLANS);
}

function planForPriceId(priceId) {
    if (!priceId) return null;
    for (const p of Object.values(PLANS)) {
        if (p.priceId() === priceId) return p;
    }
    return null;
}

/** Resolve admin/UI plan key or legacy db plan value → catalog key */
function resolvePlanKey(input) {
    const key = String(input || '').trim().toLowerCase();
    if (!key || key === 'free') return 'free';
    if (PLANS[key]) return key;
    const byDb = {
        basic: 'basic',
        pro: 'pro',
        gold: 'gold',
        sapphire: 'sapphire',
        platinum: 'pro_unlimited',
        unknown: 'free'
    };
    return byDb[key] || null;
}

function getPlanCatalogForAdmin() {
    return [
        { key: 'free', dbPlan: FREE_TIER.dbPlan, name: 'Free', limit: FREE_TIER.limit },
        ...Object.values(PLANS).map(p => ({
            key: p.key,
            dbPlan: p.dbPlan,
            name: p.name,
            limit: p.limit
        }))
    ];
}

function getDisplayForDbPlan(dbPlan, messageLimit) {
    const plan = String(dbPlan || 'free').toLowerCase();
    const limit = Number(messageLimit) || 0;
    if (plan === 'free') return { label: 'Free', dbPlan: 'free', dataPlan: 'free' };
    if (plan === 'basic' && limit > 0 && limit <= 50000) {
        return { label: 'Starter', dbPlan: 'basic', dataPlan: 'basic' };
    }
    const match = Object.values(PLANS).find(p => p.dbPlan === plan);
    if (match) return { label: match.name, dbPlan: match.dbPlan, dataPlan: match.dbPlan };
    return { label: plan.charAt(0).toUpperCase() + plan.slice(1), dbPlan: plan, dataPlan: plan };
}

module.exports = {
    PLANS,
    FREE_TIER,
    getPlan,
    listPlanKeys,
    planForPriceId,
    resolvePlanKey,
    getPlanCatalogForAdmin,
    getDisplayForDbPlan
};
