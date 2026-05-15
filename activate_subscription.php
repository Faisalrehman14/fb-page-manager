<?php
/* ─────────────────────────────────────────────────────────
   activate_subscription.php — Called by payment_status.php
   to ensure the DB is updated after a successful payment.
   ───────────────────────────────────────────────────────── */

require_once 'config/load-env.php';
require_once 'db_config.php';
require_once __DIR__ . '/config/rate_limit.php';

header('Content-Type: application/json');
header('X-Content-Type-Options: nosniff');
header('Cache-Control: no-store, no-cache, must-revalidate, max-age=0');
error_reporting(E_ALL);
ini_set('display_errors', 0);
ini_set('log_errors', 1);

if (($_SERVER['REQUEST_METHOD'] ?? 'GET') !== 'POST') {
    http_response_code(405);
    header('Allow: POST');
    echo json_encode(['success' => false, 'error' => 'Method not allowed']);
    exit;
}
requireCsrfToken();

$_ip = $_SERVER['REMOTE_ADDR'] ?? 'unknown';
if (!rateLimitCheck('activate_subscription:' . $_ip, 30, 60)) {
    http_response_code(429);
    echo json_encode(['success' => false, 'error' => 'Too many requests']);
    exit;
}

$data     = json_decode(file_get_contents('php://input'), true) ?: [];
$intentId = trim($data['intent_id'] ?? '');
$isSetup  = (bool)($data['is_setup']  ?? false);

if (!$intentId) {
    http_response_code(400);
    echo json_encode(['success' => false, 'error' => 'Missing payment intent ID']);
    exit;
}

// ── Fetch the intent from Stripe server-side (verification) ──
$endpoint = ($isSetup ? '/setup_intents/' : '/payment_intents/') . urlencode($intentId);
$intent   = stripeGet($endpoint);

if (!$intent || ($intent['status'] ?? '') !== 'succeeded') {
    logger('error', 'Stripe intent verification failed', ['intent_id' => $intentId]);
    echo json_encode(['success' => false, 'error' => 'Could not verify payment status with Stripe']);
    exit;
}

// ── Extract user metadata ──────────────────────────
$fbUserId = $intent['metadata']['fb_user_id'] ?? '';
$plan     = $intent['metadata']['plan']        ?? '';
$subId    = $intent['subscription']            ?? $intent['metadata']['subscription_id'] ?? null;

// If metadata is missing from the intent, try fetching it from the subscription
if ((!$fbUserId || !$plan) && $subId) {
    $subscription = stripeGet('/subscriptions/' . urlencode($subId));
    if ($subscription) {
        $fbUserId = $fbUserId ?: ($subscription['metadata']['fb_user_id'] ?? '');
        $plan     = $plan     ?: ($subscription['metadata']['plan']        ?? '');
    }
}

if (!$fbUserId || !$plan || !isset(STRIPE_PLANS[$plan])) {
    logger('error', 'Invalid payment metadata', ['fb_user_id' => $fbUserId, 'plan' => $plan, 'sub_id' => $subId]);
    $env = defined('APP_ENV') ? APP_ENV : 'development';
    $response = ['success' => false, 'error' => 'Invalid payment metadata. Please contact support.'];
    if ($env !== 'production') {
        $response['debug'] = "FB_USER_ID: $fbUserId, PLAN: $plan, SUB_ID: $subId";
    }
    echo json_encode($response);
    exit;
}

// ── Update DB ─────────────────────────────────────
$db       = getDB();
$planData = STRIPE_PLANS[$plan];
$dbPlan   = $planData['db_plan'] ?? 'basic'; // mapped ENUM value (free/basic/pro)
$msgLimit = (int)$planData['limit'];
$interval = strtolower((string)($planData['interval'] ?? 'month'));
$expiresSql = $interval === 'year'
    ? 'DATE_ADD(NOW(), INTERVAL 1 YEAR)'
    : 'DATE_ADD(NOW(), INTERVAL 1 MONTH)';
$storedSubId = $subId;

try {
    $db->prepare(
        "UPDATE users
         SET plan = ?, messages_limit = ?, messages_used = 0,
             stripe_subscription_id = ?,
             subscription_expires = $expiresSql
         WHERE fb_user_id = ?"
    )->execute([$dbPlan, $msgLimit, $storedSubId, $fbUserId]);

    $db->prepare("INSERT INTO activity_log (fb_user_id, action, detail) VALUES (?, 'payment', ?)")
       ->execute([$fbUserId, "Activated: {$plan} ({$dbPlan}) | {$msgLimit} messages"]);

    echo json_encode(['success' => true, 'plan' => $planData['name']]);
} catch (Throwable $e) {
    logger('error', 'activate_subscription DB failed: ' . $e->getMessage());
    echo json_encode(['success' => false, 'error' => 'Database error. Please contact support.']);
}

// ── Helper: stripeGet ───────────────────────────
function stripeGet(string $endpoint): ?array {
    $ch = curl_init('https://api.stripe.com/v1' . $endpoint);
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_USERPWD        => STRIPE_SECRET_KEY . ':',
        CURLOPT_TIMEOUT        => 15,
        CURLOPT_SSL_VERIFYPEER => true,
    ]);
    $res = curl_exec($ch);
    curl_close($ch);
    return $res ? json_decode($res, true) : null;
}
