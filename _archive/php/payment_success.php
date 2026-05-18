<?php
ob_start();
/* ─────────────────────────────────────────────────────────
   payment_success.php — Stripe redirects here after payment.
   Verifies the session, updates DB, redirects to app.
   ───────────────────────────────────────────────────────── */

error_reporting(E_ALL);
ini_set('display_errors', 0);
ini_set('log_errors', 1);

require_once 'config/load-env.php';
require_once 'db_config.php';
require_once __DIR__ . '/config/rate_limit.php';

if (($_SERVER['REQUEST_METHOD'] ?? 'GET') !== 'GET') {
    http_response_code(405);
    header('Allow: GET');
    exit('Method not allowed');
}

$sessionId = trim($_GET['session_id'] ?? '');
$_ip       = $_SERVER['REMOTE_ADDR'] ?? 'unknown';
if (!rateLimitCheck('payment_success:' . $_ip, 60, 60)) {
    header('Location: index.php?payment=error&reason=too_many_requests');
    exit;
}

logger('info', 'Payment success redirect hit', ['session_id' => $sessionId]);

// Basic validation
if (!$sessionId) {
    logger('error', 'Invalid params in payment_success.php');
    header('Location: index.php?payment=error&reason=invalid_params');
    exit;
}

// ── Stripe GET helper (defined here to ensure availability) ──
if (!function_exists('stripeGet')) {
    function stripeGet(string $endpoint): ?array {
        if (!defined('STRIPE_SECRET_KEY') || empty(STRIPE_SECRET_KEY)) {
            logger('error', 'STRIPE_SECRET_KEY not defined in stripeGet');
            return null;
        }
        $ch = curl_init('https://api.stripe.com/v1' . $endpoint);
        curl_setopt_array($ch, [
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_USERPWD        => STRIPE_SECRET_KEY . ':',
            CURLOPT_TIMEOUT        => 15,
            CURLOPT_SSL_VERIFYPEER => true,
            CURLOPT_USERAGENT      => 'PHP/FBCast/1.0',
        ]);
        $res  = curl_exec($ch);
        $err  = curl_error($ch);
        $code = curl_getinfo($ch, CURLINFO_HTTP_CODE);
        curl_close($ch);
        
        if ($err) {
            logger('error', "Stripe cURL error: $err");
            return null;
        }
        if ($code >= 400) {
            logger('error', "Stripe API error (HTTP $code): $res");
            return null;
        }
        return json_decode($res, true) ?: null;
    }
}

// Verify with Stripe that the session is real and paid
$session = stripeGet('/checkout/sessions/' . urlencode($sessionId));

if (!$session) {
    logger('error', 'Could not verify Stripe session', ['session_id' => $sessionId]);
    header('Location: index.php?payment=error&reason=stripe_unreachable');
    exit;
}
if (($session['payment_status'] ?? '') !== 'paid') {
    logger('warn', 'Session not paid', ['status' => $session['payment_status']]);
    header('Location: index.php?payment=error&reason=not_paid');
    exit;
}

// Verify fb_user_id matches what was stored in session metadata (tamper protection)
$fbUserId = trim((string)($session['metadata']['fb_user_id'] ?? ''));
$plan = trim((string)($session['metadata']['plan'] ?? ''));

if ($fbUserId === '' || $plan === '' || !isset(STRIPE_PLANS[$plan])) {
    logger('error', 'Missing or invalid metadata in Stripe session', ['session_id' => $sessionId]);
    header('Location: index.php?payment=error&reason=mismatch');
    exit;
}

// Update user in DB
$planData  = STRIPE_PLANS[$plan];
$dbPlan    = $planData['db_plan'] ?? 'basic'; // mapped ENUM value (free/basic/pro)
$msgLimit  = (int)$planData['limit'];
$interval  = strtolower((string)($planData['interval'] ?? 'month'));
$expiresSql = $interval === 'year'
    ? 'DATE_ADD(NOW(), INTERVAL 1 YEAR)'
    : 'DATE_ADD(NOW(), INTERVAL 1 MONTH)';
$db = getDB();

try {
    $db->prepare(
        "UPDATE users
         SET plan = ?, messages_limit = ?, messages_used = 0,
             stripe_subscription_id = ?,
             subscription_expires = $expiresSql
         WHERE fb_user_id = ?"
    )->execute([
        $dbPlan,
        $msgLimit,
        $session['subscription'] ?? null,
        $fbUserId,
    ]);
} catch (Throwable $e) {
    logger('critical', 'Database update failed in payment_success', ['error' => $e->getMessage()]);
    header('Location: index.php?payment=error&reason=db_update_failed');
    exit;
}

// Log it
try {
    $db->prepare("INSERT INTO activity_log (fb_user_id, action, detail) VALUES (?, 'payment', ?)")
       ->execute([$fbUserId, "Checkout success: {$plan} | {$msgLimit} messages"]);
} catch (Exception $e) {}

// Redirect back to app with success flag
ob_end_clean();
header("Location: index.php?payment=success&plan=" . urlencode($plan) . "&limit={$msgLimit}");
exit;
