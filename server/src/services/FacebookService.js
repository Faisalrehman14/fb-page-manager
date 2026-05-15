const crypto = require('crypto');
const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));

class FacebookService {
    /**
     * Verifies the HMAC signature from Facebook to ensure request authenticity
     */
    verifySignature(req) {
        const signature = req.headers['x-hub-signature-256'];
        if (!signature) return false;
        
        const elements = signature.split('=');
        const signatureHash = elements[1];
        const expectedHash = crypto
            .createHmac('sha256', process.env.FB_APP_SECRET || '')
            .update(req.rawBody)
            .digest('hex');
            
        return signatureHash === expectedHash;
    }

    /**
     * Sends a message via Facebook Graph API
     */
    async sendMessage(pageId, psid, message, token) {
        try {
            const res = await fetch(`https://graph.facebook.com/v21.0/${pageId}/messages?access_token=${token}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    recipient: { id: psid },
                    message: { text: message },
                    messaging_type: 'RESPONSE'
                })
            });
            const data = await res.json();
            if (data.error) throw new Error(data.error.message);
            return data;
        } catch (err) {
            console.error('[FacebookService] Send Error:', err);
            throw err;
        }
    }
}

module.exports = new FacebookService();
