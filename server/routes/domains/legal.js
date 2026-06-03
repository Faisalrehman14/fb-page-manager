/** Public legal pages required by Meta App Settings (privacy policy, data deletion). */
module.exports = function mountLegal(app, ctx) {
    const { env } = ctx;
    const contact = env.CONTACT_EMAIL || 'support@example.com';
    const year = new Date().getFullYear();

    function wrap(title, bodyHtml) {
        return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} — FBCast Pro</title>
<style>
  body{font-family:system-ui,sans-serif;max-width:720px;margin:40px auto;padding:0 20px;line-height:1.6;color:#1e293b}
  h1{font-size:1.5rem} a{color:#1877f2}
</style>
</head><body>
<h1>${title}</h1>
${bodyHtml}
<p style="margin-top:2rem;color:#64748b;font-size:0.9rem">© ${year} FBCast Pro · <a href="/">Back to app</a></p>
</body></html>`;
    }

    app.get(['/privacy', '/privacy-policy', '/privacy.php'], (req, res) => {
        res.type('html').send(wrap('Privacy Policy', `
<p>FBCast Pro helps Facebook Page administrators manage Messenger inbox and send broadcast messages to users who have previously messaged their Page.</p>
<h2>Data we collect</h2>
<ul>
<li>Facebook User ID and name when you connect your account</li>
<li>Page access tokens to send messages on your behalf</li>
<li>Message usage counts for subscription quotas</li>
</ul>
<h2>How we use data</h2>
<p>Data is used only to provide inbox, broadcast, and billing features. We do not sell personal data.</p>
<h2>Retention & deletion</h2>
<p>You may disconnect Facebook at any time. To request account data deletion, see our <a href="/data-deletion">Data Deletion Instructions</a> or email <a href="mailto:${contact}">${contact}</a>.</p>
<h2>Contact</h2>
<p><a href="mailto:${contact}">${contact}</a></p>
`));
    });

    app.get(['/terms', '/terms-of-service'], (req, res) => {
        res.type('html').send(wrap('Terms of Service', `
<p>By using FBCast Pro you agree to comply with Meta/Facebook Platform policies and only message users who have previously contacted your Page.</p>
<p>Subscriptions are billed via Stripe. Abuse may result in account suspension.</p>
<p>Contact: <a href="mailto:${contact}">${contact}</a></p>
`));
    });

    app.get(['/data-deletion', '/data-deletion-instructions'], (req, res) => {
        res.type('html').send(wrap('User Data Deletion', `
<p>To delete your data from FBCast Pro:</p>
<ol>
<li>Disconnect your Facebook account in the app (Settings → Log out), or revoke the app in Facebook Settings → Apps and Websites.</li>
<li>Email <a href="mailto:${contact}">${contact}</a> with your Facebook User ID and request deletion.</li>
</ol>
<p>We will delete stored tokens, usage records, and linked page data within 30 days.</p>
`));
    });
};
