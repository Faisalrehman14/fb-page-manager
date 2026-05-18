Production deployment notes

This repository is now a PHP-first deployment. The active production runtime is:

1. `index.php` as the main app entry.
2. PHP endpoints such as `fb_proxy.php`, `exchange_token.php`, `create_checkout.php`, and `stripe_webhook.php`.
3. Apache or LiteSpeed with `.htaccess` support.

Minimum server requirements

1. PHP 8.0+.
2. Extensions: `curl`, `pdo`, `pdo_mysql`, `json`, `mbstring`.
3. HTTPS enabled on the final domain.
4. A writable `logs/` directory.

Environment

Create `.env` from `.env.example` and provide real values for:

1. `DB_HOST`, `DB_NAME`, `DB_USER`, `DB_PASS`
2. `FB_APP_ID`, `FB_APP_SECRET`, `FB_REDIRECT_URI`
3. `STRIPE_PUBLISHABLE_KEY`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`
4. `STRIPE_BASIC_PRICE_ID`, `STRIPE_PRO_PRICE_ID`
5. `SITE_URL`, `CONTACT_EMAIL`

Deploy checklist

1. Upload the project files without `.env` committed to git.
2. Ensure the document root points to this app directory.
3. Enable SSL before going live.
4. Confirm `.htaccess` is active.
5. Verify Stripe webhook endpoint points to `stripe_webhook.php`.
6. Confirm Facebook redirect URI matches `https://your-domain.com/oauth_callback.html`.
7. Verify `logs/` is writable by PHP.

Verification

```bash
php -l index.php
php -l fb_proxy.php
php -l exchange_token.php
php -l create_checkout.php
php -l stripe_webhook.php
```

Security notes

1. Keep `APP_ENV=production` on live servers.
2. Do not expose `.env`, logs, or diagnostic files publicly.
3. Delete or temporarily rename `check_setup.php` before public launch if you use it during deployment.
