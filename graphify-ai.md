# Graphify AI Context

Generated at (UTC): 2026-04-26T05:03:19+00:00

Use this file before scanning the full repository.

## Quick Summary
- Total tracked files: 50
- PHP entrypoints: 18
- Types: php=29, js=5, css=2, docs=12, html=2

## Primary Entrypoints
- activate_subscription.php
- admin.php
- check_setup.php
- create_checkout.php
- db_config.php
- exchange_token.php
- fb_proxy.php
- get_csrf.php
- graphify.php
- health_check.php
- index.php
- payment_status.php
- payment_success.php
- setup_db.php
- stripe_webhook.php

## Detected Relations (from -> to)
- [calls] UI_INTEGRATION_EXAMPLES.js -> create_checkout.php
- [calls] UI_INTEGRATION_EXAMPLES.js -> fb_proxy.php
- [include] activate_subscription.php -> config/load-env.php
- [include] activate_subscription.php -> db_config.php
- [include] admin.php -> config/load-env.php
- [include] admin.php -> config/validators.php
- [include] admin.php -> db_config.php
- [calls] admin.php -> admin.php
- [calls] assets/js/index-page.js -> track_user.php
- [calls] assets/js/index-page.js -> get_csrf.php
- [calls] assets/js/index-page.js -> create_checkout.php
- [include] config/rate_limit.php -> config/rate_limit.php
- [calls] create_checkout.php -> index.php
- [calls] fb_api.js -> exchange_token.php
- [calls] fb_api.js -> track_user.php
- [include] health_check.php -> config/load-env.php
- [include] health_check.php -> db_config.php
- [calls] payment_status.php -> activate_subscription.php
- [include] payment_success.php -> config/load-env.php
- [include] payment_success.php -> db_config.php
- [include] setup_db.php -> db_config.php
- [calls] stripe_webhook_retry.php -> stripe_webhook.php
- [include] track_user.php -> db_config.php
- [include] update_quota.php -> db_config.php

## External Hosts
- api.stripe.com
- cdnjs.cloudflare.com
- fonts.googleapis.com
- cdn.jsdelivr.net
- graph.facebook.com
- checkout.stripe.com
- www.facebook.com
- yourdomain.com
- js.stripe.com
- fonts.googleapis.com;
- fonts.gstatic.com
- www.facebook.com;
- www.w3.org
- yoursite.com

## Usage For AI Agents
- Start with AGENTS.md and this file.
- Open only files related to requested feature/bug from entrypoints/relations above.
- Regenerate after structural changes: `php scripts/generate_graphify.php`.
