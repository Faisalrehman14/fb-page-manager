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

module.exports = { PLANS, FREE_TIER, getPlan, listPlanKeys, planForPriceId };
