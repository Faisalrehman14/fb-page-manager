const Stripe = require('stripe');
const env = require('../config/env');

let _stripe = null;

function getStripe() {
    if (!env.STRIPE_SECRET_KEY) {
        throw new Error('Stripe is not configured. Set STRIPE_SECRET_KEY in environment.');
    }
    if (!_stripe) {
        _stripe = new Stripe(env.STRIPE_SECRET_KEY, { apiVersion: '2024-11-20.acacia' });
    }
    return _stripe;
}

function isStripeConfigured() {
    const key = env.STRIPE_SECRET_KEY || '';
    return key.length > 10 && !key.includes('YOUR') && !key.includes('PLACEHOLDER');
}

module.exports = { getStripe, isStripeConfigured };
