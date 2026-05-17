<?php
/* ─────────────────────────────────────────────────────────
   track_user.php — Called after Facebook OAuth login.
   1. Verifies the user token with Facebook (/me endpoint)
   2. Creates or updates the user record in DB
   3. Returns quota info (used / limit / plan)
   Anti-abuse: same FB user ID = same quota, even from
   a different browser or device.
   ───────────────────────────────────────────────────────── */

header('Content-Type: application/json');
header('Cache-Control: no-cache, no-store, must-revalidate');
header('X-Content-Type-Options: nosniff');
header('X-Frame-Options: DENY');
header('Referrer-Policy: strict-origin-when-cross-origin');

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    http_response_code(405);
    die(json_encode(['error' => 'Method not allowed']));
}

require_once __DIR__ . '/config/load-env.php';
require_once 'db_config.php';
require_once __DIR__ . '/config/rate_limit.php';

/* ── CSRF protection (required for production) ─────────── */
requireCsrfToken();

/* ── Rate limit: max 20 requests per minute per IP ─────── */
$_ip = $_SERVER['REMOTE_ADDR'] ?? 'unknown';
if (!rateLimitCheck('track_user:' . $_ip, 20, 60)) {
    http_response_code(429);
    die(json_encode(['error' => 'Too many requests. Please wait a moment.']));
}

$raw  = get_raw_input();
$body = json_decode($raw, true) ?: [];
$userToken = trim($body['user_token'] ?? '');

if (!$userToken) {
    http_response_code(400);
    die(json_encode(['error' => 'user_token is required']));
}

/* ── Verify token with Facebook ───────────────────────── */
// Cache successful token verification briefly to reduce repeated Facebook calls
// during frequent quota syncs from the same browser session.
$tokenHash = hash('sha256', $userToken);
$cacheKey  = 'trk_fb_me_' . $tokenHash;
$cacheTtl  = 180; // seconds
$me        = null;

if (!empty($_SESSION[$cacheKey]) && isset($_SESSION[$cacheKey]['ts']) && (time() - (int)$_SESSION[$cacheKey]['ts'] <= $cacheTtl)) {
    $cached = $_SESSION[$cacheKey];
    if (!empty($cached['id'])) {
        $me = ['id' => $cached['id'], 'name' => $cached['name'] ?? ''];
    }
}

if (!$me) {
    $ctx = stream_context_create([
        'http' => [
            'timeout'        => 15,
            'ignore_errors'  => true,
        ],
        'ssl'  => ['verify_peer' => true],
    ]);

    $meUrl  = 'https://graph.facebook.com/' . FB_API_VER . '/me?fields=id,name&access_token=' . urlencode($userToken);
    $meJson = @file_get_contents($meUrl, false, $ctx);

    if ($meJson === false) {
        http_response_code(502);
        die(json_encode(['error' => 'Could not reach Facebook. Check server internet access.']));
    }

    $me = json_decode($meJson, true);
}

if (empty($me['id'])) {
    unset($_SESSION[$cacheKey]); // clear stale cache if token is now invalid
    $errMsg = $me['error']['message'] ?? 'Invalid or expired token';
    if (APP_ENV === 'production') {
        $errMsg = 'Invalid or expired token';
    }
    http_response_code(401);
    die(json_encode(['error' => 'Facebook token verification failed: ' . $errMsg]));
}

$_SESSION[$cacheKey] = [
    'ts'   => time(),
    'id'   => $me['id'],
    'name' => trim($me['name'] ?? ''),
];

$fbId   = $me['id'];
$fbName = trim($me['name'] ?? '');
$_SESSION['fb_user_id'] = $fbId;
$_SESSION['fb_user_name'] = $fbName;
$_SESSION['fb_login_at'] = time();
// Use REMOTE_ADDR as the authoritative IP. HTTP_X_FORWARDED_FOR can be spoofed
// and should only be trusted if the server is known to be behind a trusted proxy.
$ip = filter_var($_SERVER['REMOTE_ADDR'] ?? '', FILTER_VALIDATE_IP) ?: 'unknown';

/* ── DB operations ─────────────────────────────────────── */
$db = getDB();

// Get current free_limit from settings
$freeLimit = (int)$db->query(
    "SELECT setting_value FROM settings WHERE setting_key = 'free_limit'"
)->fetchColumn();
if ($freeLimit <= 0) $freeLimit = 2000; // Set default free limit back to 2000 as requested for FB users

// Look up user
$stmt = $db->prepare("SELECT * FROM users WHERE fb_user_id = ?");
$stmt->execute([$fbId]);
$user = $stmt->fetch();

if (!$user) {
    /* New user → create with free plan at current free_limit */
    $db->prepare(
        "INSERT INTO users (fb_user_id, fb_name, plan, messages_used, messages_limit, trial_used, ip_address)
         VALUES (?, ?, 'free', 0, ?, 1, ?)"
    )->execute([$fbId, $fbName, $freeLimit, $ip]);

    $user = [
        'fb_user_id'     => $fbId,
        'fb_name'        => $fbName,
        'plan'           => 'free',
        'messages_used'  => 0,
        'messages_limit' => $freeLimit,
        'trial_used'     => 1,
    ];
} else {
    /* Returning user → update last_login + name */
    $db->prepare(
        "UPDATE users SET fb_name = ?, last_login = NOW(), ip_address = ? WHERE fb_user_id = ?"
    )->execute([$fbName, $ip, $fbId]);

    /* ── Free trial expiry ─────────────────────────────────
       If user is on free plan, never sent a message,
       and it has been more than 30 days since first_login
       → expire the trial (set messages_limit = 0).
    ────────────────────────────────────────────────────── */
    $plan = $user['plan'] ?? 'free';
    if ($plan === 'free' && (int)($user['messages_used'] ?? 0) === 0) {
        $firstLogin = $user['first_login'] ?? null;
        if ($firstLogin !== null) {
            $daysSince = (int)(new DateTime())->diff(new DateTime($firstLogin))->days;
            if ($daysSince > 30 && (int)($user['messages_limit'] ?? 0) > 0) {
                $db->prepare(
                    "UPDATE users SET messages_limit = 0 WHERE fb_user_id = ?"
                )->execute([$fbId]);
                $user['messages_limit'] = 0;
                try {
                    $db->prepare("INSERT INTO activity_log (fb_user_id, action, detail) VALUES (?, 'subscription', ?)")
                       ->execute([$fbId, 'Free trial expired: 30 days passed with no messages sent']);
                } catch (Exception $e) {}
            }
        }
    }

    /* ── Monthly reset safety net ──────────────────────────
       If subscription_expires has passed and plan is paid,
       downgrade to free (payment failed / webhook missed).
       If subscription is still active, Stripe's
       invoice.payment_succeeded webhook resets messages_used.
    ────────────────────────────────────────────────────── */
    $expires = $user['subscription_expires'] ?? null;
    if ($plan !== 'free' && $expires !== null) {
        $expiredSince = (new DateTime())->diff(new DateTime($expires));
        $daysOver     = (int)$expiredSince->format('%r%a'); // negative = expired
        if ($daysOver < -2) {
            // Subscription expired more than 2 days ago — downgrade to free
            $db->prepare(
                "UPDATE users SET plan='free', messages_limit=?, messages_used=0,
                 stripe_subscription_id=NULL, subscription_expires=NULL
                 WHERE fb_user_id=?"
            )->execute([$freeLimit, $fbId]);
            $user['plan']            = 'free';
            $user['messages_limit']  = $freeLimit;
            $user['messages_used']   = 0;
            $user['subscription_expires'] = null;
            try {
                $db->prepare("INSERT INTO activity_log (fb_user_id, action, detail) VALUES (?, 'subscription', ?)")
                   ->execute([$fbId, 'Auto-downgraded to free: subscription_expires passed with no renewal webhook']);
            } catch (Exception $e) {}
        }
    }
}

/* ── Log the login ─────────────────────────────────────── */
try {
    $plan = $user['plan'] ?? $user['subscriptionStatus'] ?? 'free';
    $db->prepare(
        "INSERT INTO activity_log (fb_user_id, action, detail) VALUES (?, 'login', ?)"
    )->execute([$fbId, "IP: {$ip} | Plan: {$plan}"]);
} catch (Exception $e) { /* non-critical */ }

/* ── Respond ───────────────────────────────────────────── */
echo json_encode([
    'success'            => true,
    'fb_user_id'         => $user['fb_user_id'],
    'fb_name'            => $user['fb_name'],
    'subscriptionStatus' => $user['plan'] ?? $user['subscriptionStatus'] ?? 'free',
    'messagesUsed'       => (int)($user['messages_used'] ?? $user['messagesUsed'] ?? 0),
    'messageLimit'       => (int)($user['messages_limit'] ?? $user['messageLimit'] ?? 0),
    'remaining'          => max(0, (int)($user['messages_limit'] ?? $user['messageLimit'] ?? 0) - (int)($user['messages_used'] ?? $user['messagesUsed'] ?? 0)),
    'trial_used'         => (bool)$user['trial_used'],
]);
