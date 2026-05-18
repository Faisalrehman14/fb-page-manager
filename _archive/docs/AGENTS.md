# AGENTS.md

This repository includes prebuilt context so AI agents can avoid reading the whole codebase on every task.

## Read Order (Mandatory)
1. `AGENTS.md`
2. `graphify-ai.md`
3. `graphify.json` (only if deeper graph detail is needed)
4. Only then open feature-specific files.

## Where To Change What
- Landing/UI shell: `index.php`, `assets/css/index.css`, `assets/js/index-page.js`
- Reusable UI behavior: `assets/css/ui-components.css`, `assets/js/ui-components.js`, `web_ui.js`
- Facebook OAuth/token flow: `exchange_token.php`, `oauth_callback.html`, `track_user.php`
- Facebook API proxy/send logic: `fb_proxy.php`, `fb_api.js`, `update_quota.php`
- Billing flow: `create_checkout.php`, `activate_subscription.php`, `payment_status.php`, `payment_success.php`
- Stripe webhooks/reliability: `stripe_webhook.php`, `stripe_webhook_retry.php`, `scripts/migrations/*`
- Security/core config: `config/load-env.php`, `config/csrf.php`, `config/rate_limit.php`, `config/logger.php`, `config/validators.php`
- Admin panel: `admin.php`
- System/setup health: `setup_db.php`, `check_setup.php`, `health_check.php`, `db_config.php`

## Working Rules For AI Agents
- Do not scan unrelated files first.
- Use `graphify-ai.md` to pick target files and open minimum needed files.
- If task spans multiple flows, start from the nearest entrypoint `.php` and follow `calls/include` links from `graphify.json`.
- After structural edits (new files, moved endpoints, changed integrations), run:
  - `php scripts/generate_graphify.php`
- Keep `graphify-ai.md` and `graphify.json` current.

## Fast Local Validation
- `php -l index.php`
- `php -l fb_proxy.php`
- `php -l exchange_token.php`
- `php -l create_checkout.php`
