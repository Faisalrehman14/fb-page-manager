<?php
/* ─────────────────────────────────────────────────────────
   stripe_webhook.php — Handles Stripe webhook events.

   Set up in Stripe Dashboard → Developers → Webhooks:
   URL: https://yoursite.com/stripe_webhook.php
   Events to listen for:
     • checkout.session.completed
     • customer.subscription.deleted
     • invoice.payment_succeeded
     • invoice.payment_failed
   ───────────────────────────────────────────────────────── */

require_once __DIR__ . '/config/load-env.php';
require_once __DIR__ . '/db_config.php';
require_once __DIR__ . '/config/rate_limit.php';

error_reporting(E_ALL);
ini_set('display_errors', '0');
ini_set('log_errors', '1');

header('Content-Type: application/json');
header('X-Content-Type-Options: nosniff');
header('Cache-Control: no-store, no-cache, must-revalidate, max-age=0');

if (($_SERVER['REQUEST_METHOD'] ?? 'GET') !== 'POST') {
    http_response_code(405);
    header('Allow: POST');
    echo json_encode(['error' => 'Method not allowed']);
    exit;
}

$ipAddress = $_SERVER['REMOTE_ADDR'] ?? 'unknown';
enforceRateLimit('webhook', 'stripe:' . $ipAddress);

$payload = file_get_contents('php://input') ?: '';
$sigHeader = $_SERVER['HTTP_STRIPE_SIGNATURE'] ?? '';

if ($payload === '' || $sigHeader === '') {
    http_response_code(400);
    echo json_encode(['error' => 'Missing webhook data']);
    exit;
}

if (strlen($payload) > 2_000_000) {
    http_response_code(413);
    logger('warn', 'Stripe webhook payload too large', ['ip' => $ipAddress, 'bytes' => strlen($payload)]);
    echo json_encode(['error' => 'Payload too large']);
    exit;
}

$event = verifyWebhook($payload, $sigHeader, STRIPE_WEBHOOK_SECRET);
if ($event === null) {
    http_response_code(400);
    logger('warn', 'Invalid Stripe webhook signature', ['ip' => $ipAddress]);
    echo json_encode(['error' => 'Invalid webhook signature']);
    exit;
}

$eventId = (string)($event['id'] ?? '');
$eventType = (string)($event['type'] ?? '');
if ($eventId === '' || $eventType === '') {
    http_response_code(400);
    logger('warn', 'Malformed Stripe webhook event', ['ip' => $ipAddress]);
    echo json_encode(['error' => 'Malformed event']);
    exit;
}

if (APP_ENV === 'production' && empty($event['livemode'])) {
    logger('warn', 'Ignored Stripe test-mode event in production', ['event_id' => $eventId, 'type' => $eventType]);
    http_response_code(200);
    echo json_encode(['received' => true, 'ignored' => 'test_mode']);
    exit;
}

$db = getDB();
ensureWebhookTables($db);

$eventState = reserveWebhookEvent($db, $eventId, $eventType, $payload);
if ($eventState === 'processed') {
    http_response_code(200);
    echo json_encode(['received' => true, 'duplicate' => true]);
    exit;
}

try {
    processStripeEvent($db, $event);
    markWebhookProcessed($db, $eventId);

    http_response_code(200);
    echo json_encode(['received' => true]);
} catch (Throwable $e) {
    markWebhookFailed($db, $eventId, $e->getMessage());
    logger('error', 'Stripe webhook processing failed', [
        'event_id' => $eventId,
        'type' => $eventType,
        'error' => $e->getMessage(),
    ]);

    http_response_code(500);
    echo json_encode(['error' => 'Webhook processing failed']);
}

function processStripeEvent(PDO $db, array $event): void {
    $allowedTypes = [
        'checkout.session.completed',
        'customer.subscription.deleted',
        'invoice.payment_succeeded',
        'invoice.payment_failed',
    ];

    $eventType = (string)($event['type'] ?? '');
    if (!in_array($eventType, $allowedTypes, true)) {
        logger('info', 'Ignored unsupported Stripe event type', ['type' => $eventType]);
        return;
    }

    switch ($eventType) {
        case 'checkout.session.completed':
            $session = $event['data']['object'] ?? [];
            $fbUserId = trim((string)($session['metadata']['fb_user_id'] ?? ''));
            $plan = trim((string)($session['metadata']['plan'] ?? ''));
            $subId = trim((string)($session['subscription'] ?? ''));
            $email = trim((string)(
                $session['customer_details']['email']
                ?? $session['customer_email']
                ?? ''
            ));
            $amountTotal = (int)($session['amount_total'] ?? 0);
            $invoiceId = trim((string)($session['invoice'] ?? ''));

            if ($fbUserId !== '' && $plan !== '' && isset(STRIPE_PLANS[$plan])) {
                activatePlan($db, $fbUserId, $plan, $subId, $email);
                try {
                    $dbPlan = STRIPE_PLANS[$plan]['db_plan'] ?? 'basic';
                    $db->prepare(
                        "INSERT IGNORE INTO payment_history
                         (fb_user_id, stripe_invoice_id, plan, amount_cents, status, billing_reason)
                         VALUES (?, ?, ?, ?, 'succeeded', 'subscription_create')"
                    )->execute([$fbUserId, $invoiceId ?: $subId, $dbPlan, $amountTotal]);
                } catch (Throwable $e) {
                    logger('warn', 'Failed to insert payment_history on checkout', ['error' => $e->getMessage()]);
                }
            }
            break;

        case 'customer.subscription.deleted':
            $sub = $event['data']['object'] ?? [];
            $fbUserId = trim((string)($sub['metadata']['fb_user_id'] ?? ''));
            if ($fbUserId !== '') {
                downgradeToFree($db, $fbUserId);
            }
            break;

        case 'invoice.payment_succeeded':
            $invoice = $event['data']['object'] ?? [];
            $subId = trim((string)($invoice['subscription'] ?? ''));
            $billingReason = trim((string)($invoice['billing_reason'] ?? ''));

            if ($subId !== '' && in_array($billingReason, ['subscription_create', 'subscription_cycle'], true)) {
                $sub = stripeGet('/subscriptions/' . rawurlencode($subId));
                if ($sub !== null) {
                    $fbUserId = trim((string)($sub['metadata']['fb_user_id'] ?? ''));
                    $plan = trim((string)($sub['metadata']['plan'] ?? ''));
                    if ($fbUserId !== '' && $plan !== '' && isset(STRIPE_PLANS[$plan])) {
                        $newLimit = (int)STRIPE_PLANS[$plan]['limit'];
                        $interval = strtolower((string)(STRIPE_PLANS[$plan]['interval'] ?? 'month'));
                        $renewSql = $interval === 'year'
                            ? 'DATE_ADD(NOW(), INTERVAL 1 YEAR)'
                            : 'DATE_ADD(NOW(), INTERVAL 1 MONTH)';
                        $amountPaid = (int)($invoice['amount_paid'] ?? 0);
                        $invoiceId = trim((string)($invoice['id'] ?? ''));
                        $dbPlan = STRIPE_PLANS[$plan]['db_plan'] ?? 'basic';

                        $db->prepare(
                            "UPDATE users SET messages_used = 0, messages_limit = ?,
                             subscription_expires = $renewSql
                             WHERE fb_user_id = ?"
                        )->execute([$newLimit, $fbUserId]);

                        $db->prepare(
                            "INSERT INTO payment_history
                             (fb_user_id, stripe_invoice_id, plan, amount_cents, status, billing_reason)
                             VALUES (?, ?, ?, ?, 'succeeded', ?)"
                        )->execute([$fbUserId, $invoiceId, $dbPlan, $amountPaid, $billingReason]);

                        $action = $billingReason === 'subscription_create' ? 'subscription' : 'renewal';
                        logActivity($db, $fbUserId, $action, "Plan {$action}: {$plan} | {$newLimit} messages");
                    }
                }
            }
            break;

        case 'invoice.payment_failed':
            $invoice = $event['data']['object'] ?? [];
            $custId = trim((string)($invoice['customer'] ?? ''));
            $invId = trim((string)($invoice['id'] ?? ''));

            if ($custId !== '') {
                $stmt = $db->prepare("SELECT fb_user_id FROM users WHERE stripe_customer_id = ?");
                $stmt->execute([$custId]);
                $row = $stmt->fetch(PDO::FETCH_ASSOC);

                if ($row) {
                    $fbUserId = (string)$row['fb_user_id'];
                    $amountDue = (int)($invoice['amount_due'] ?? 0);
                    logActivity($db, $fbUserId, 'payment_failed', 'Stripe payment failed — subscription may lapse');

                    $db->prepare(
                        "INSERT INTO payment_history
                         (fb_user_id, stripe_invoice_id, plan, amount_cents, status, billing_reason)
                         VALUES (?, ?, 'unknown', ?, 'failed', 'subscription_cycle')"
                    )->execute([$fbUserId, $invId, $amountDue]);
                }
            }
            break;
    }
}

function ensureWebhookTables(PDO $db): void {
    static $initialized = false;
    if ($initialized) {
        return;
    }

    $db->exec(
        "CREATE TABLE IF NOT EXISTS webhook_events (
            id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
            event_id VARCHAR(255) NOT NULL UNIQUE,
            event_type VARCHAR(120) NOT NULL,
            status ENUM('processing','processed','failed') NOT NULL DEFAULT 'processing',
            attempts INT UNSIGNED NOT NULL DEFAULT 1,
            payload MEDIUMTEXT NULL,
            last_error TEXT NULL,
            received_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            last_seen_at DATETIME NULL DEFAULT NULL,
            processed_at DATETIME NULL DEFAULT NULL,
            INDEX idx_webhook_status (status),
            INDEX idx_webhook_type (event_type),
            INDEX idx_webhook_received (received_at)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci"
    );

    $db->exec(
        "CREATE TABLE IF NOT EXISTS payment_history (
            id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
            fb_user_id VARCHAR(50) NOT NULL,
            stripe_invoice_id VARCHAR(255) NOT NULL DEFAULT '',
            plan ENUM('free','basic','pro','unknown') NOT NULL DEFAULT 'unknown',
            amount_cents INT UNSIGNED NOT NULL DEFAULT 0,
            status ENUM('succeeded','failed','pending') NOT NULL DEFAULT 'pending',
            billing_reason VARCHAR(80) NOT NULL DEFAULT '',
            created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            INDEX idx_payment_user (fb_user_id),
            INDEX idx_payment_invoice (stripe_invoice_id),
            INDEX idx_payment_created (created_at)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci"
    );

    $initialized = true;
}

function reserveWebhookEvent(PDO $db, string $eventId, string $eventType, string $payload): string {
    $stmt = $db->prepare(
        "INSERT INTO webhook_events (event_id, event_type, status, attempts, payload, received_at, last_seen_at)
         VALUES (?, ?, 'processing', 1, ?, NOW(), NOW())
         ON DUPLICATE KEY UPDATE
            attempts = attempts + 1,
            payload = VALUES(payload),
            last_seen_at = NOW()"
    );
    $stmt->execute([$eventId, $eventType, $payload]);

    $statusStmt = $db->prepare("SELECT status FROM webhook_events WHERE event_id = ? LIMIT 1");
    $statusStmt->execute([$eventId]);
    $row = $statusStmt->fetch(PDO::FETCH_ASSOC);
    $status = (string)($row['status'] ?? 'processing');

    if ($status === 'processed') {
        logger('info', 'Duplicate Stripe webhook ignored', ['event_id' => $eventId, 'type' => $eventType]);
        return 'processed';
    }

    if ($status === 'failed' || $status === 'processing') {
        $db->prepare("UPDATE webhook_events SET status = 'processing', last_error = NULL, attempts = attempts + 1 WHERE event_id = ?")
            ->execute([$eventId]);
    }

    return 'processing';
}

function getWebhookStatus(PDO $db, string $eventId): string {
    $statusStmt = $db->prepare("SELECT status FROM webhook_events WHERE event_id = ? LIMIT 1");
    $statusStmt->execute([$eventId]);
    $row = $statusStmt->fetch(PDO::FETCH_ASSOC);
    return (string)($row['status'] ?? 'processing');
}

function acquireWebhookLock(PDO $db, string $lockKey, int $timeoutSeconds = 5): bool {
    try {
        $stmt = $db->prepare('SELECT GET_LOCK(?, ?) AS lock_ok');
        $stmt->execute([$lockKey, max(1, $timeoutSeconds)]);
        $row = $stmt->fetch(PDO::FETCH_ASSOC);
        return ((int)($row['lock_ok'] ?? 0)) === 1;
    } catch (Throwable $e) {
        logger('warn', 'Could not acquire webhook lock', ['error' => $e->getMessage()]);
        return false;
    }
}

function releaseWebhookLock(PDO $db, string $lockKey): void {
    try {
        $stmt = $db->prepare('SELECT RELEASE_LOCK(?)');
        $stmt->execute([$lockKey]);
    } catch (Throwable $e) {
        logger('warn', 'Could not release webhook lock', ['error' => $e->getMessage()]);
    }
}

function markWebhookProcessed(PDO $db, string $eventId): void {
    $db->prepare("UPDATE webhook_events SET status = 'processed', processed_at = NOW(), last_error = NULL WHERE event_id = ?")
        ->execute([$eventId]);
}

function markWebhookFailed(PDO $db, string $eventId, string $error): void {
    $db->prepare("UPDATE webhook_events SET status = 'failed', last_error = ? WHERE event_id = ?")
        ->execute([substr($error, 0, 5000), $eventId]);
}

function activatePlan(PDO $db, string $fbUserId, string $plan, string $subId, string $email = ''): void {
    $planData   = STRIPE_PLANS[$plan];
    $dbPlan     = $planData['db_plan'] ?? $plan;
    $interval   = strtolower((string)($planData['interval'] ?? 'month'));
    $expiresSql = $interval === 'year'
        ? 'DATE_ADD(NOW(), INTERVAL 1 YEAR)'
        : 'DATE_ADD(NOW(), INTERVAL 1 MONTH)';
    $storedSubId = $subId;
    if ($email !== '') {
        $db->prepare(
            "UPDATE users
             SET plan = ?, messages_limit = ?, messages_used = 0,
                 stripe_subscription_id = ?,
                 subscription_expires = $expiresSql,
                 email = ?
             WHERE fb_user_id = ?"
        )->execute([$dbPlan, $planData['limit'], $storedSubId, $email, $fbUserId]);
    } else {
        $db->prepare(
            "UPDATE users
             SET plan = ?, messages_limit = ?, messages_used = 0,
                 stripe_subscription_id = ?,
                 subscription_expires = $expiresSql
             WHERE fb_user_id = ?"
        )->execute([$dbPlan, $planData['limit'], $storedSubId, $fbUserId]);
    }
    $planTypeLabel = $interval === 'year' ? 'yearly' : 'monthly';
    logActivity($db, $fbUserId, 'subscription', "Activated: {$plan} ({$planTypeLabel}) | {$planData['limit']} messages");
}

function downgradeToFree(PDO $db, string $fbUserId): void {
    $db->prepare(
        "UPDATE users
         SET plan = 'free',
             messages_limit = (SELECT setting_value FROM settings WHERE setting_key = 'free_limit' LIMIT 1),
             messages_used = 0,
             stripe_subscription_id = NULL,
             subscription_expires = NULL
         WHERE fb_user_id = ?"
    )->execute([$fbUserId]);
    logActivity($db, $fbUserId, 'subscription', 'Subscription cancelled — reverted to free');
}

function logActivity(PDO $db, string $fbUserId, string $action, string $detail): void {
    try {
        $db->prepare("INSERT INTO activity_log (fb_user_id, action, detail) VALUES (?, ?, ?)")
            ->execute([$fbUserId, $action, $detail]);
    } catch (Throwable $e) {
        logger('warn', 'Failed to write activity log', ['error' => $e->getMessage()]);
    }
}

function stripeGet(string $endpoint): ?array {
    $ch = curl_init('https://api.stripe.com/v1' . $endpoint);
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_USERPWD => STRIPE_SECRET_KEY . ':',
        CURLOPT_TIMEOUT => 15,
        CURLOPT_SSL_VERIFYPEER => true,
    ]);

    $res = curl_exec($ch);
    $err = curl_error($ch);
    $httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    curl_close($ch);

    if ($err || $httpCode >= 400 || !$res) {
        logger('warn', 'Stripe GET failed during webhook', [
            'endpoint' => $endpoint,
            'http_code' => $httpCode,
            'error' => $err,
        ]);
        return null;
    }

    $decoded = json_decode($res, true);
    return is_array($decoded) ? $decoded : null;
}

function verifyWebhook(string $payload, string $sigHeader, string $secret): ?array {
    if ($secret === '' || strpos($secret, 'YOUR') !== false || strpos($secret, 'PLACEHOLDER') !== false) {
        logger('critical', 'Stripe webhook secret missing/invalid');
        return null;
    }

    $parts = ['v1' => []];
    foreach (explode(',', $sigHeader) as $part) {
        $kv = explode('=', trim($part), 2);
        if (count($kv) === 2) {
            if ($kv[0] === 'v1') {
                $parts['v1'][] = $kv[1];
            } else {
                $parts[$kv[0]] = $kv[1];
            }
        }
    }

    $timestamp = (int)($parts['t'] ?? 0);
    $signatures = $parts['v1'] ?? [];

    if ($timestamp <= 0 || empty($signatures)) {
        return null;
    }

    if (abs(time() - $timestamp) > 300) {
        return null;
    }

    $expected = hash_hmac('sha256', $timestamp . '.' . $payload, $secret);
    $valid = false;
    foreach ($signatures as $sig) {
        if (hash_equals($expected, (string)$sig)) {
            $valid = true;
            break;
        }
    }
    if (!$valid) {
        return null;
    }

    $decoded = json_decode($payload, true);
    return is_array($decoded) ? $decoded : null;
}
