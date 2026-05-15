Local development

This project runs as a PHP application served directly from the repo root. The older Node/Vercel notes are not the active runtime anymore.

Requirements

1. PHP 8.0+ with `curl`, `pdo`, `pdo_mysql`, and `json`.
2. A MySQL-compatible database.
3. A `.env` file created from `.env.example`.

Run locally

1. Copy `.env.example` to `.env` and fill in the real Facebook, Stripe, database, and site values.
2. Start the app from the project root:

```bash
php -S 127.0.0.1:8080
```

3. Open `http://127.0.0.1:8080`.

Quick validation

```bash
php -l index.php
php -l fb_proxy.php
php -l exchange_token.php
php -l create_checkout.php
```

Graphify (code map)

Generate architecture map JSON and inspect it in browser:

```bash
php scripts/generate_graphify.php
php -S 127.0.0.1:8080
# open http://127.0.0.1:8080/graphify.php
```

Notes

1. `get_csrf.php` returns the session CSRF token used by frontend requests.
2. `fb_proxy.php` and `exchange_token.php` handle the Facebook server-side integration.
3. `create_checkout.php`, `stripe_webhook.php`, and `payment_status.php` handle billing flow.
