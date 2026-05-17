<?php
/*
 * exchange_token.php
 * Server-side Facebook token exchange.
 * Short-lived user token → Long-lived user token → Long-lived page tokens (60 days)
 */

header('Content-Type: application/json');
header('X-Content-Type-Options: nosniff');
header('X-Frame-Options: DENY');
header('Referrer-Policy: strict-origin-when-cross-origin');
header('Cache-Control: no-store, no-cache, must-revalidate, max-age=0');

// Load environment configuration
require_once __DIR__ . '/config/load-env.php';
require_once __DIR__ . '/config/rate_limit.php';

function exchange_json_response($status, array $payload) {
    http_response_code($status);
    echo json_encode($payload);
    exit;
}

/* ── Only POST allowed ─────────────────────────────────── */
if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    header('Allow: POST');
    exchange_json_response(405, ['error' => 'Method not allowed']);
}

/* ── CSRF protection (required for production) ─────────── */
requireCsrfToken();

/* ── Rate limit: max 10 requests per minute per IP ─────── */
$_ip = $_SERVER['REMOTE_ADDR'] ?? 'unknown';
enforceRateLimit('auth', 'exchange_token:' . $_ip);

/* ── Read short-lived user token from request ──────────── */
$input      = json_decode(get_raw_input(), true);
$jsonErr    = json_last_error();
$input      = is_array($input) ? $input : [];
$shortToken = trim($input['user_token'] ?? '');

if ($jsonErr !== JSON_ERROR_NONE) {
    exchange_json_response(400, ['error' => 'Invalid JSON request body']);
}

if ($shortToken === '') {
    exchange_json_response(400, ['error' => 'user_token is required']);
}

if (strlen($shortToken) < 20) {
    exchange_json_response(400, ['error' => 'user_token format looks invalid']);
}

/* ── cURL helper ───────────────────────────────────────── */
function fb_get($url) {
    $ch = curl_init($url);
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_TIMEOUT        => 15,
        CURLOPT_SSL_VERIFYPEER => true,
        CURLOPT_USERAGENT      => 'PHP/FacebookTokenExchange',
    ]);
    $body = curl_exec($ch);
    $err  = curl_error($ch);
    $code = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    curl_close($ch);
    if ($err) {
        logger('error', 'Facebook exchange cURL error', ['message' => $err, 'url' => $url]);
        return null;
    }

    $decoded = json_decode($body, true);
    if ($code >= 400) {
        return is_array($decoded) ? $decoded : ['error' => ['message' => 'Facebook API request failed']];
    }

    return $decoded;
}

/* ── Step 1: Short-lived user token → Long-lived user token */
$exchangeUrl = 'https://graph.facebook.com/' . FB_API_VER . '/oauth/access_token?' . http_build_query([
    'grant_type'        => 'fb_exchange_token',
    'client_id'         => FB_APP_ID,
    'client_secret'     => FB_APP_SECRET,
    'fb_exchange_token' => $shortToken,
]);

$data = fb_get($exchangeUrl);

if (!$data || empty($data['access_token'])) {
    $msg = $data['error']['message'] ?? 'Token exchange failed. Check App Secret.';
    if (APP_ENV === 'production') {
        $msg = 'Token exchange failed';
    }
    exchange_json_response(400, ['error' => $msg]);
}

$longLivedUserToken = $data['access_token'];

/* ── Step 2: Fetch pages using long-lived user token ─────
   Pages fetched with a long-lived user token get
   long-lived page tokens (~60 days). */
$pagesUrl = 'https://graph.facebook.com/' . FB_API_VER . '/me/accounts?' . http_build_query([
    'fields'       => 'id,name,access_token,category,picture.type(large)',
    'access_token' => $longLivedUserToken,
]);

$pagesData = fb_get($pagesUrl);

if (!$pagesData || isset($pagesData['error'])) {
    $msg = $pagesData['error']['message'] ?? 'Failed to fetch pages';
    if (APP_ENV === 'production') {
        $msg = 'Failed to fetch pages';
    }
    exchange_json_response(400, ['error' => $msg]);
}

/* ── Return long-lived page tokens + long-lived user token */
echo json_encode([
    'success'          => true,
    'pages'            => $pagesData['data'] ?? [],
    'long_lived_token' => $longLivedUserToken,
]);
