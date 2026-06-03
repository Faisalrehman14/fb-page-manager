const crypto = require('crypto');
const env = require('../config/env');

const BINANCE_PAY_HOST = 'https://bpay.binanceapi.com';
const CERT_CACHE_MS = 6 * 60 * 60 * 1000;

let _certCache = { fetchedAt: 0, bySerial: new Map() };

function isBinancePayConfigured() {
    const key = env.BINANCE_PAY_API_KEY || '';
    const secret = env.BINANCE_PAY_API_SECRET || '';
    return key.length > 8 && secret.length > 16
        && !key.includes('YOUR') && !secret.includes('YOUR');
}

function generateNonce(length = 32) {
    const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let out = '';
    for (let i = 0; i < length; i++) {
        out += chars[crypto.randomInt(0, chars.length)];
    }
    return out;
}

function signRequest(timestamp, nonce, bodyString, secret) {
    const payload = `${timestamp}\n${nonce}\n${bodyString}\n`;
    return crypto.createHmac('sha512', secret).update(payload, 'utf8').digest('hex').toUpperCase();
}

function buildAuthHeaders(bodyString) {
    const timestamp = Date.now();
    const nonce = generateNonce(32);
    const signature = signRequest(timestamp, nonce, bodyString, env.BINANCE_PAY_API_SECRET);
    return {
        'Content-Type': 'application/json',
        'BinancePay-Timestamp': String(timestamp),
        'BinancePay-Nonce': nonce,
        'BinancePay-Certificate-SN': env.BINANCE_PAY_API_KEY,
        'BinancePay-Signature': signature
    };
}

async function binancePayRequest(path, bodyObj = {}) {
    const bodyString = JSON.stringify(bodyObj);
    const headers = buildAuthHeaders(bodyString);
    const res = await fetch(`${BINANCE_PAY_HOST}${path}`, {
        method: 'POST',
        headers,
        body: bodyString
    });
    const text = await res.text();
    let json;
    try {
        json = JSON.parse(text);
    } catch (_) {
        throw new Error(`Binance Pay invalid response (${res.status})`);
    }
    if (!res.ok || json.status !== 'SUCCESS') {
        const msg = json.errorMessage || json.message || json.code || `HTTP ${res.status}`;
        throw new Error(`Binance Pay: ${msg}`);
    }
    return json;
}

async function refreshCertificates() {
    const json = await binancePayRequest('/binancepay/openapi/certificates', {});
    const list = json.data || [];
    const bySerial = new Map();
    for (const cert of list) {
        if (cert.certSerial && cert.certPublic) {
            bySerial.set(String(cert.certSerial), cert.certPublic);
        }
    }
    _certCache = { fetchedAt: Date.now(), bySerial };
    return bySerial;
}

async function getCertificatePublicKey(certSerial) {
    const serial = String(certSerial || '');
    if (!serial) return null;
    if (Date.now() - _certCache.fetchedAt > CERT_CACHE_MS || !_certCache.bySerial.size) {
        await refreshCertificates();
    }
    let pem = _certCache.bySerial.get(serial);
    if (!pem) {
        await refreshCertificates();
        pem = _certCache.bySerial.get(serial);
    }
    if (!pem) return null;
    if (pem.includes('BEGIN PUBLIC KEY')) return pem;
    return `-----BEGIN PUBLIC KEY-----\n${pem}\n-----END PUBLIC KEY-----`;
}

function verifyWebhookSignature(rawBodyString, headers) {
    const timestamp = headers['binancepay-timestamp']
        || headers['BinancePay-Timestamp']
        || headers['binancepay-timestamp'.toLowerCase()];
    const nonce = headers['binancepay-nonce']
        || headers['BinancePay-Nonce'];
    const signatureB64 = headers['binancepay-signature']
        || headers['BinancePay-Signature'];
    const certSn = headers['binancepay-certificate-sn']
        || headers['BinancePay-Certificate-SN'];

    if (!timestamp || !nonce || !signatureB64 || !certSn) {
        return { ok: false, reason: 'missing_headers' };
    }

    const payload = `${timestamp}\n${nonce}\n${rawBodyString}\n`;
    return { ok: true, payload, signatureB64, certSn };
}

async function verifyWebhook(rawBodyString, headers) {
    if (env.APP_ENV !== 'production' && env.BINANCE_PAY_WEBHOOK_SKIP_VERIFY === '1') {
        return { ok: true, skipped: true };
    }
    const parts = verifyWebhookSignature(rawBodyString, headers);
    if (!parts.ok) return parts;

    const publicKeyPem = await getCertificatePublicKey(parts.certSn);
    if (!publicKeyPem) {
        return { ok: false, reason: 'unknown_certificate' };
    }

    try {
        const signature = Buffer.from(parts.signatureB64, 'base64');
        const verifier = crypto.createVerify('RSA-SHA256');
        verifier.update(parts.payload, 'utf8');
        const valid = verifier.verify(publicKeyPem, signature);
        return valid ? { ok: true } : { ok: false, reason: 'invalid_signature' };
    } catch (err) {
        return { ok: false, reason: 'verify_error', error: err.message };
    }
}

/**
 * @param {object} order
 * @returns {Promise<{ checkoutUrl, prepayId, qrcodeLink, universalUrl, deeplink, merchantTradeNo, currency, totalFee }>}
 */
async function createOrder(order) {
    const json = await binancePayRequest('/binancepay/openapi/v3/order', order);
    const data = json.data || {};
    return {
        checkoutUrl: data.checkoutUrl,
        prepayId: data.prepayId,
        qrcodeLink: data.qrcodeLink,
        qrContent: data.qrContent,
        universalUrl: data.universalUrl,
        deeplink: data.deeplink,
        currency: data.currency,
        totalFee: data.totalFee,
        fiatCurrency: data.fiatCurrency,
        fiatAmount: data.fiatAmount,
        expireTime: data.expireTime
    };
}

function generateMerchantTradeNo() {
    const suffix = crypto.randomBytes(6).toString('hex');
    const ts = Date.now().toString(36);
    const raw = `fbc${ts}${suffix}`.replace(/[^a-zA-Z0-9]/g, '');
    return raw.slice(0, 32);
}

module.exports = {
    isBinancePayConfigured,
    createOrder,
    verifyWebhook,
    generateMerchantTradeNo,
    generateNonce,
    BINANCE_PAY_HOST
};
