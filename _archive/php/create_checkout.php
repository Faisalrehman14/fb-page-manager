<?php
/* ─────────────────────────────────────────────────────────
   create_checkout.php — Creates a Stripe Checkout Session.
   Called via POST from the frontend when user clicks a plan.
   Returns: { url: "https://checkout.stripe.com/..." }
   ───────────────────────────────────────────────────────── */

// ═════════════════════════════════════════════════════════════
// Comprehensive Error Handling for Debugging 500 Errors
// This should be at the very top to catch all possible issues.
// ═════════════════════════════════════════════════════════════
error_reporting(E_ALL);
ini_set('display_errors', 0); // Never display errors in production
ini_set('log_errors', 1);
ini_set('error_log', __DIR__ . '/logs/php_errors.log'); // Ensure errors are logged

// Load all environment variables and configuration first.
// This also includes the logger, making it available to the error handlers.
require_once __DIR__ . '/config/load-env.php';

// Custom error handler to catch warnings/notices/errors that might not be caught by try/catch
set_error_handler(function ($severity, $message, $file, $line) {
    if (!(error_reporting() & $severity)) {
        return; // This error code is not included in error_reporting
    }
    logger('error', "PHP Error: $message", ['severity' => $severity, 'file' => $file, 'line' => $line]);
    // Attempt to output a JSON error if headers haven't been sent
    if (!headers_sent()) {
        http_response_code(500);
        header('Content-Type: application/json');
        $env = defined('APP_ENV') ? APP_ENV : getenv('APP_ENV');
        $debugMsg = ($env && $env !== 'production') ? "PHP Error: $message in $file on line $line" : null;
        $resp = ['error' => 'An unexpected server error occurred. Please try again or contact support.'];
        if ($debugMsg) { $resp['debug'] = $debugMsg; }
        echo json_encode($resp);
        exit(1);
    }
    return true; // Don't execute PHP's internal error handler
});

// Register a shutdown function to catch fatal errors (E_ERROR, E_PARSE, E_CORE_ERROR, E_COMPILE_ERROR)
register_shutdown_function(function() {
    $error = error_get_last();
    if ($error && in_array($error['type'], [E_ERROR, E_PARSE, E_CORE_ERROR, E_COMPILE_ERROR])) {
        logger('critical', "PHP Fatal Error: {$error['message']}", ['file' => $error['file'], 'line' => $error['line']]);
        if (!headers_sent()) {
            http_response_code(500); header('Content-Type: application/json'); echo json_encode(['error' => 'A critical server error occurred.']);
        }
    }
});

// Now that handlers are set, load the rest of the configuration.
// If any of these fail, the shutdown handler will catch and log it.
require_once __DIR__ . '/db_config.php';
require_once __DIR__ . '/config/csrf.php';

ob_start(); // Capture any stray output (warnings, notices) before JSON

header('Content-Type: application/json');
header('Cache-Control: no-cache, no-store, must-revalidate');

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    ob_end_clean();
    http_response_code(405);
    die(json_encode(['error' => 'Method not allowed']));
}

// Validate CSRF token
if (!verifyCsrfToken()) { // This will now use the get_raw_input() helper
    ob_end_clean();
    http_response_code(403);
    die(json_encode(['error' => 'CSRF token invalid or missing']));
}

$raw      = get_raw_input(); // Use helper to avoid re-reading php://input
$body     = json_decode($raw, true) ?: [];
$plan     = trim($body['plan']        ?? '');
$fbUserId = trim($body['fb_user_id']  ?? '');
$sessionFbUserId = trim((string)($_SESSION['fb_user_id'] ?? ''));

// Rate limiter: max 5 checkout attempts per minute per user
$rate_key = "checkout:$fbUserId";
if (!isset($_SESSION[$rate_key])) {
    $_SESSION[$rate_key] = ['count' => 0, 'time' => time()];
}
if (time() - $_SESSION[$rate_key]['time'] > 60) {
    $_SESSION[$rate_key] = ['count' => 0, 'time' => time()];
}
$_SESSION[$rate_key]['count']++;
if ($_SESSION[$rate_key]['count'] > 5) {
    logger('warn', 'Checkout rate limit exceeded', ['fb_user_id' => $fbUserId, 'ip' => $_SERVER['REMOTE_ADDR']]);
    ob_end_clean();
    http_response_code(429);
    die(json_encode(['error' => 'Too many checkout attempts. Please wait 1 minute and try again.']));
}

$validPlans = array_keys(STRIPE_PLANS);
if (!$plan || !in_array($plan, $validPlans, true)) {
    ob_end_clean();
    http_response_code(400);
    die(json_encode(['error' => 'Invalid plan: "' . $plan . '". Valid: ' . implode(', ', $validPlans)]));
}
if (!$fbUserId) {
    ob_end_clean();
    http_response_code(400);
    die(json_encode(['error' => 'fb_user_id is required']));
}
if ($sessionFbUserId === '' || !hash_equals($sessionFbUserId, $fbUserId)) {
    logger('warn', 'Checkout blocked: user not logged in or session mismatch', [
        'request_fb_user_id' => $fbUserId,
        'session_fb_user_id' => $sessionFbUserId,
        'ip' => $_SERVER['REMOTE_ADDR'] ?? 'unknown',
    ]);
    ob_end_clean();
    http_response_code(401);
    die(json_encode(['error' => 'Please login with Facebook before buying a subscription.']));
}

$planData = STRIPE_PLANS[$plan];
$isLifetime = (($planData['interval'] ?? '') === 'lifetime');

// Validate Price ID — must start with 'price_' not 'prod_'
$priceId = $planData['price_id'] ?? '';
if (
    empty($priceId) ||
    strpos($priceId, 'YOUR')        !== false ||
    strpos($priceId, 'PLACEHOLDER') !== false ||
    strpos($priceId, '_HERE')       !== false ||
    strpos($priceId, 'prod_')       === 0       // Product ID mistakenly used instead of Price ID
) {
    ob_end_clean();
    http_response_code(503);
    $msg = strpos($priceId, 'prod_') === 0
        ? "Configuration error: STRIPE_{$plan}_PRICE_ID is a Product ID (prod_...). Go to Stripe Dashboard → Products → select product → copy Price ID (price_...) and update .env."
        : "Payment system not fully configured. STRIPE_" . strtoupper($plan) . "_PRICE_ID is missing. Add it to .env from Stripe Dashboard → Products.";
    die(json_encode(['error' => $msg]));
}

$db = getDB();

// Look up user
$stmt = $db->prepare("SELECT fb_name, stripe_customer_id FROM users WHERE fb_user_id = ?");
$stmt->execute([$fbUserId]);
$user = $stmt->fetch(PDO::FETCH_ASSOC);

if (!$user) {
    ob_end_clean();
    http_response_code(404);
    die(json_encode(['error' => 'User not found. Please log in with Facebook first.']));
}

$customerId = $user['stripe_customer_id'] ?? '';

// Validate Stripe is configured before making any API calls
if (empty(STRIPE_SECRET_KEY) || strpos(STRIPE_SECRET_KEY, 'YOUR') !== false || strpos(STRIPE_SECRET_KEY, 'PLACEHOLDER') !== false) {
    ob_end_clean();
    http_response_code(503);
    die(json_encode(['error' => 'Payment system is not configured yet. Please contact support.']));
}

try {
    // Create Stripe customer if not yet linked, or if stored ID no longer exists
    if ($customerId) {
        try {
            $existing = stripeGet('/customers/' . $customerId);
            if (!empty($existing['deleted'])) {
                $customerId = '';
                $db->prepare("UPDATE users SET stripe_customer_id = NULL WHERE fb_user_id = ?")
                   ->execute([$fbUserId]);
            }
        } catch (Exception $ce) {
            // Customer not found in this Stripe account/mode — clear and create fresh
            $customerId = '';
            $db->prepare("UPDATE users SET stripe_customer_id = NULL WHERE fb_user_id = ?")
               ->execute([$fbUserId]);
        }
    }

    if (!$customerId) {
        $customerRes = stripePost('/customers', [
            'name'     => $user['fb_name'] ?: $fbUserId,
            'metadata' => ['fb_user_id' => $fbUserId],
        ]);
        $customerId = $customerRes['id'];
        $db->prepare("UPDATE users SET stripe_customer_id = ? WHERE fb_user_id = ?")
            ->execute([$customerId, $fbUserId]);
    }

    // Hosted Stripe Checkout keeps frontend simple and production-safe.
    $baseUrl = SITE_URL ?: ((isset($_SERVER['HTTPS']) && $_SERVER['HTTPS'] === 'on') ? 'https://' : 'http://') . ($_SERVER['HTTP_HOST'] ?? '');
    if ($baseUrl && !preg_match('#^https?://#i', $baseUrl)) {
        $baseUrl = 'https://' . $baseUrl;
    }
    $baseUrl = rtrim($baseUrl, '/');

    $successUrl = $baseUrl . '/index.php?payment=success&session_id={CHECKOUT_SESSION_ID}';
    $cancelUrl  = $baseUrl . '/index.php?payment=cancelled';

    $sessionPayload = [
        'mode'                        => $isLifetime ? 'payment' : 'subscription',
        'payment_method_types'        => ['card'],
        'customer'                    => $customerId,
        'line_items'                  => [['price' => $planData['price_id'], 'quantity' => 1]],
        'client_reference_id'         => $fbUserId,
        'success_url'                 => $successUrl,
        'cancel_url'                  => $cancelUrl,
        'allow_promotion_codes'       => 'true',
        'metadata'                    => ['fb_user_id' => $fbUserId, 'plan' => $plan],
        'customer_update'             => ['address' => 'auto', 'name' => 'auto'],
        'billing_address_collection'  => 'auto',
    ];
    if (!$isLifetime) {
        $sessionPayload['subscription_data'] = ['metadata' => ['fb_user_id' => $fbUserId, 'plan' => $plan]];
    }

    $session = stripePost('/checkout/sessions', $sessionPayload);

    if (empty($session['url'])) {
        throw new Exception('Checkout URL missing from Stripe response.');
    }

    logger('info', 'Stripe Checkout session created', [
        'session_id' => $session['id'] ?? '',
        'fb_user_id' => $fbUserId,
        'plan' => $plan,
    ]);

    ob_end_clean();
    echo json_encode([
        'url' => $session['url'],
        'sessionId' => $session['id'] ?? null,
    ]);

} catch (Throwable $e) { // Catch Throwable to handle both Error and Exception in PHP 7+
    // Log full error for server-side inspection
    logger('error', 'Checkout session creation failed', ['message' => $e->getMessage(), 'trace' => $e->getTraceAsString(), 'fb_user_id' => $fbUserId]);
    // Also write a small debug file (helps when logger file permissions prevent creation)
    @file_put_contents(__DIR__ . '/logs/last_checkout_error.log', date('c') . " - " . $e->getMessage() . "\n" . $e->getTraceAsString());

    ob_end_clean();
    http_response_code(500);

    // Temporary: return the exception message in JSON when APP_ENV is not 'production'.
    // This helps debugging; remove this block once issue is resolved.
    $env = defined('APP_ENV') ? APP_ENV : getenv('APP_ENV');
    $debugMsg = ($env && $env !== 'production') ? $e->getMessage() : null;

    $resp = ['error' => 'Payment gateway error: ' . $e->getMessage()];

    die(json_encode($resp));
}

// ── Stripe API Helpers ─────────────────────────────────────
function stripeDelete(string $endpoint): array {
    // Validate Stripe secret is configured before making any API calls
    if (empty(STRIPE_SECRET_KEY) || strpos(STRIPE_SECRET_KEY, 'YOUR') !== false) {
        logger('error', 'Stripe secret key not configured for DELETE operation', ['endpoint' => $endpoint]);
        throw new Exception('Stripe configuration error. Contact administrator.');
    }

    $ch = curl_init('https://api.stripe.com/v1' . $endpoint);
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_CUSTOMREQUEST  => 'DELETE',
        CURLOPT_USERPWD        => STRIPE_SECRET_KEY . ':',
        CURLOPT_TIMEOUT        => 15,
        CURLOPT_SSL_VERIFYPEER => true,
        CURLOPT_FAILONERROR    => false, // We handle HTTP errors manually
    ]);
    $res       = curl_exec($ch);
    $err       = curl_error($ch);
    $http_code = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    curl_close($ch);

    if ($err) {
        logger('error', 'Stripe API curl error during DELETE', ['endpoint' => $endpoint, 'error' => $err]);
        throw new Exception("Stripe API DELETE connection failed: $err");
    }

    // Stripe DELETE usually returns the deleted object or a 204 No Content.
    // We should check for HTTP errors (4xx, 5xx).
    if ($http_code >= 400) {
        logger('error', 'Stripe API HTTP error during DELETE', ['endpoint' => $endpoint, 'http_code' => $http_code, 'response' => $res]);
        throw new Exception("Stripe API DELETE error (HTTP $http_code): " . substr($res, 0, 200));
    }

    $data = json_decode($res, true);
    return $data ?: []; // Return empty array if no JSON or 204 No Content
}

function stripeGet(string $url): array {
    $ch = curl_init('https://api.stripe.com/v1' . $url);
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_USERPWD        => STRIPE_SECRET_KEY . ':',
        CURLOPT_TIMEOUT        => 30,
        CURLOPT_SSL_VERIFYPEER => true,
    ]);
    $res       = curl_exec($ch);
    $err       = curl_error($ch);
    $http_code = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    curl_close($ch);

    if ($err) throw new Exception("Stripe GET connection failed: $err");
    if ($http_code >= 400) throw new Exception("Stripe GET error (HTTP $http_code): " . substr($res, 0, 200));
    $data = json_decode($res, true);
    if (!$data) throw new Exception("Invalid JSON from Stripe GET");
    return $data;
}

function stripePost(string $endpoint, array $params): array {
    // Validate Stripe secret is configured
    if (empty(STRIPE_SECRET_KEY) || strpos(STRIPE_SECRET_KEY, 'YOUR') !== false) {
        logger('error', 'Stripe secret key not configured', ['endpoint' => $endpoint]);
        throw new Exception('Stripe configuration error. Contact administrator.');
    }

    $ch = curl_init('https://api.stripe.com/v1' . $endpoint);
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_POST           => true,
        CURLOPT_USERPWD        => STRIPE_SECRET_KEY . ':',
        CURLOPT_HTTPHEADER     => ['Content-Type: application/x-www-form-urlencoded'],
        CURLOPT_POSTFIELDS     => http_build_query($params),
        CURLOPT_TIMEOUT        => 30,
        CURLOPT_SSL_VERIFYPEER => true,
    ]);

    $res = curl_exec($ch);
    $err = curl_error($ch);
    $http_code = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    curl_close($ch);

    // Check for curl errors
    if ($err) {
        logger('error', 'Stripe API curl error', [
            'endpoint' => $endpoint,
            'error' => $err,
            'http_code' => $http_code
        ]);
        throw new Exception("Stripe API connection failed: $err");
    }

    // Check HTTP status code
    if ($http_code >= 400) {
        logger('error', 'Stripe API HTTP error', [
            'endpoint' => $endpoint,
            'http_code' => $http_code,
            'response' => $res
        ]);
        throw new Exception("Stripe API error (HTTP $http_code): " . substr($res, 0, 200));
    }

    // Parse JSON response
    $data = json_decode($res, true);
    if (!$data) {
        logger('error', 'Stripe API invalid JSON response', [
            'endpoint' => $endpoint,
            'response' => substr($res, 0, 500)
        ]);
        throw new Exception("Invalid response from Stripe API");
    }

    return $data;
}
