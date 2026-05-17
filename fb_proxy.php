<?php
/*
 * fb_proxy.php
 * Server-side proxy for Facebook Graph API.
 * Routes all browser API calls through the server to bypass ISP blocks.
 *
 * Accepts POST with JSON body:
 *   { method: 'GET'|'POST', path: 'me/accounts', token: '...', params: {}, body: {} }
 *   { method: 'GET', url: 'https://graph.facebook.com/...', token: '' }  ← pagination
 */

header('Content-Type: application/json');
header('X-Content-Type-Options: nosniff');
header('X-Frame-Options: DENY');
header('Referrer-Policy: strict-origin-when-cross-origin');
header('Cache-Control: no-store, no-cache, must-revalidate, max-age=0');

require_once __DIR__ . '/config/load-env.php';
require_once __DIR__ . '/config/rate_limit.php';

function proxy_json_response($status, array $payload) {
    http_response_code($status);
    echo json_encode($payload);
    exit;
}

/* ── Only POST allowed ─────────────────────────────────── */
if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    header('Allow: POST');
    proxy_json_response(405, ['error' => 'Method not allowed']);
}

/* ── CSRF protection (required for production) ─────────── */
requireCsrfToken();

/* ── Rate limiting (500 req/min per IP) ────────────────── */
$_ip = $_SERVER['REMOTE_ADDR'] ?? 'unknown';
if (!rateLimitCheck('fb_proxy:' . $_ip, 500, 60)) {
    proxy_json_response(429, ['error' => 'Too many requests. Please wait.']);
}

/* ── Parse request ─────────────────────────────────────── */
$input   = json_decode(get_raw_input(), true);
$jsonErr = json_last_error();
$input   = is_array($input) ? $input : [];
$method  = strtoupper($input['method'] ?? 'GET');

if ($jsonErr !== JSON_ERROR_NONE) {
    proxy_json_response(400, ['error' => 'Invalid JSON request body']);
}

if (!in_array($method, ['GET', 'POST', 'UPLOAD_IMAGE'], true)) {
    proxy_json_response(400, ['error' => 'Unsupported proxy method']);
}

/* ── Image upload (base64 → Facebook attachment_id) ───── */
if ($method === 'UPLOAD_IMAGE') {
    $pageId   = trim($input['page_id']   ?? '');
    $token    = trim($input['token']     ?? '');
    $imgB64   = $input['image_data']     ?? '';
    $mimeType = $input['mime_type']      ?? 'image/jpeg';

    if (!$pageId || !$token || !$imgB64) {
        proxy_json_response(400, ['error' => 'page_id, token, image_data required']);
    }

    $imgBytes = base64_decode($imgB64, true);
    if (!$imgBytes) {
        proxy_json_response(400, ['error' => 'Invalid base64 image data']);
    }

    $extMap  = ['image/png' => 'png', 'image/gif' => 'gif', 'image/webp' => 'webp'];
    $ext     = $extMap[$mimeType] ?? 'jpg';
    $tmpPath = tempnam(sys_get_temp_dir(), 'fbimg') . '.' . $ext;
    if (@file_put_contents($tmpPath, $imgBytes) === false) {
        proxy_json_response(500, ['error' => 'Failed to process upload']);
    }

    $apiUrl = 'https://graph.facebook.com/' . FB_API_VER . '/' . $pageId . '/message_attachments'
            . '?access_token=' . urlencode($token);

    $ch2 = curl_init($apiUrl);
    curl_setopt_array($ch2, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_TIMEOUT        => 60,
        CURLOPT_POST           => true,
        CURLOPT_POSTFIELDS     => [
            'message'  => json_encode([
                'attachment' => [
                    'type'    => 'image',
                    'payload' => ['is_reusable' => true],
                ],
            ]),
            'filedata' => new CURLFile($tmpPath, $mimeType, 'upload.' . $ext),
        ],
        CURLOPT_SSL_VERIFYPEER => true,
        CURLOPT_USERAGENT      => 'PHP/FBProxy/1.0',
    ]);

    $upResp = curl_exec($ch2);
    $upCode = curl_getinfo($ch2, CURLINFO_HTTP_CODE);
    $upErr  = curl_error($ch2);
    curl_close($ch2);
    @unlink($tmpPath);

    if ($upErr) {
        logger('error', 'Facebook upload proxy cURL error', ['message' => $upErr]);
        $message = APP_ENV === 'production' ? 'Upload request failed' : 'Upload cURL error: ' . $upErr;
        proxy_json_response(502, ['error' => $message]);
    }

    http_response_code($upCode);
    echo $upResp;
    exit;
}
$token   = trim($input['token'] ?? '');
$path    = trim($input['path'] ?? '');
$fullUrl = trim($input['url']  ?? '');
$params  = $input['params'] ?? [];
$body    = $input['body']   ?? [];

/* ── Build target URL ──────────────────────────────────── */
if ($fullUrl) {
    /* Pagination URL from Facebook — token already embedded */
    $host = parse_url($fullUrl, PHP_URL_HOST);
    if ($host !== 'graph.facebook.com') {
        proxy_json_response(400, ['error' => 'Invalid URL host']);
    }
    $url = $fullUrl;
} elseif ($path) {
    if (!$token) {
        proxy_json_response(400, ['error' => 'token is required']);
    }
    // Sanitize path: strip path traversal sequences and disallow protocol characters
    $cleanPath = ltrim($path, '/');
    if (preg_match('/\.\.|[<>"\'\x00-\x1f]|:\/\//', $cleanPath)) {
        proxy_json_response(400, ['error' => 'Invalid path']);
    }
    $params['access_token'] = $token;
    $url = 'https://graph.facebook.com/' . FB_API_VER . '/' . $cleanPath . '?' . http_build_query($params);
} else {
    proxy_json_response(400, ['error' => 'path or url is required']);
}

/* ── cURL request ──────────────────────────────────────── */
$ch   = curl_init();
$opts = [
    CURLOPT_URL            => $url,
    CURLOPT_RETURNTRANSFER => true,
    CURLOPT_TIMEOUT        => 30,
    CURLOPT_SSL_VERIFYPEER => true,
    CURLOPT_USERAGENT      => 'PHP/FBProxy/1.0',
];

if ($method === 'POST') {
    /* For POST, add token to URL; body goes as form-urlencoded */
    if ($token && strpos($url, 'access_token=') === false) {
        $opts[CURLOPT_URL] = $url . (strpos($url, '?') !== false ? '&' : '?') . 'access_token=' . urlencode($token);
    }
    $formBody = [];
    foreach ($body as $k => $v) {
        $formBody[$k] = (is_array($v) || is_object($v)) ? json_encode($v) : (string)$v;
    }
    $opts[CURLOPT_POST]       = true;
    $opts[CURLOPT_POSTFIELDS] = http_build_query($formBody);
    $opts[CURLOPT_HTTPHEADER] = ['Content-Type: application/x-www-form-urlencoded'];
}

curl_setopt_array($ch, $opts);
$response = curl_exec($ch);
$httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
$curlErr  = curl_error($ch);
curl_close($ch);

if ($curlErr) {
    logger('error', 'Facebook proxy connection error', ['message' => $curlErr, 'url' => $opts[CURLOPT_URL] ?? $url]);
    $message = APP_ENV === 'production' ? 'Proxy connection error' : 'Proxy connection error: ' . $curlErr;
    proxy_json_response(502, ['error' => $message]);
}

http_response_code($httpCode);
echo $response;
