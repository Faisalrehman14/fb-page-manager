<?php
/*
 * stripe_webhook_retry.php
 * Securely replays failed Stripe webhook events stored in webhook_events table.
 *
 * Auth:
 *   Header: X-Webhook-Retry-Token: <WEBHOOK_RETRY_TOKEN>
 *
 * Request JSON (POST):
 *   {
 *     "event_id": "evt_...",      // optional: replay one specific event
 *     "limit": 10                  // optional: max events to replay (1-50)
 *   }
 */

require_once __DIR__ . '/config/load-env.php';
require_once __DIR__ . '/db_config.php';
require_once __DIR__ . '/config/rate_limit.php';

header('Content-Type: application/json');
header('X-Content-Type-Options: nosniff');
header('Cache-Control: no-store, no-cache, must-revalidate, max-age=0');

if (($_SERVER['REQUEST_METHOD'] ?? 'GET') !== 'POST') {
    http_response_code(405);
    header('Allow: POST');
    echo json_encode(['error' => 'Method not allowed']);
    exit;
}

$retryToken = trim((string)getenv('WEBHOOK_RETRY_TOKEN'));
$providedToken = trim((string)($_SERVER['HTTP_X_WEBHOOK_RETRY_TOKEN'] ?? ''));

if ($retryToken === '' || !hash_equals($retryToken, $providedToken)) {
    http_response_code(403);
    echo json_encode(['error' => 'Forbidden']);
    exit;
}

$ip = $_SERVER['REMOTE_ADDR'] ?? 'unknown';
if (!rateLimitCheck('webhook_retry:' . $ip, 10, 60)) {
    http_response_code(429);
    echo json_encode(['error' => 'Too many requests']);
    exit;
}

if (STRIPE_WEBHOOK_SECRET === '' || strpos(STRIPE_WEBHOOK_SECRET, 'YOUR') !== false) {
    http_response_code(503);
    echo json_encode(['error' => 'Webhook secret is not configured']);
    exit;
}

$raw = file_get_contents('php://input') ?: '';
$body = json_decode($raw, true);
$body = is_array($body) ? $body : [];

$eventId = trim((string)($body['event_id'] ?? ''));
$limit = (int)($body['limit'] ?? 10);
$limit = max(1, min(50, $limit));

$db = getDB();
$db->exec("CREATE TABLE IF NOT EXISTS webhook_events (
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
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci");

if ($eventId !== '') {
    $stmt = $db->prepare("SELECT event_id, event_type, payload, status FROM webhook_events WHERE event_id = ? LIMIT 1");
    $stmt->execute([$eventId]);
} else {
    $stmt = $db->prepare("SELECT event_id, event_type, payload, status
                          FROM webhook_events
                          WHERE status = 'failed' AND payload IS NOT NULL AND payload != ''
                          ORDER BY received_at DESC
                          LIMIT {$limit}");
    $stmt->execute();
}

$rows = $stmt->fetchAll(PDO::FETCH_ASSOC) ?: [];
if (!$rows) {
    echo json_encode(['success' => true, 'replayed' => 0, 'results' => [], 'message' => 'No events to replay']);
    exit;
}

$base = rtrim((string)SITE_URL, '/');
if ($base === '') {
    $scheme = (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off') ? 'https' : 'http';
    $host = $_SERVER['HTTP_HOST'] ?? '';
    $base = $host ? ($scheme . '://' . $host) : '';
}

if ($base === '') {
    http_response_code(500);
    echo json_encode(['error' => 'SITE_URL is not configured']);
    exit;
}

$webhookUrl = $base . '/stripe_webhook.php';
$results = [];
$okCount = 0;

foreach ($rows as $row) {
    $payload = (string)($row['payload'] ?? '');
    if ($payload === '') {
        $results[] = [
            'event_id' => $row['event_id'] ?? '',
            'status' => 'skipped',
            'reason' => 'Missing payload',
        ];
        continue;
    }

    $timestamp = time();
    $signature = hash_hmac('sha256', $timestamp . '.' . $payload, STRIPE_WEBHOOK_SECRET);
    $sigHeader = 't=' . $timestamp . ',v1=' . $signature;

    $ch = curl_init($webhookUrl);
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_POST => true,
        CURLOPT_POSTFIELDS => $payload,
        CURLOPT_HTTPHEADER => [
            'Content-Type: application/json',
            'Stripe-Signature: ' . $sigHeader,
        ],
        CURLOPT_TIMEOUT => 20,
        CURLOPT_SSL_VERIFYPEER => true,
    ]);

    $resp = curl_exec($ch);
    $err = curl_error($ch);
    $httpCode = (int)curl_getinfo($ch, CURLINFO_HTTP_CODE);
    curl_close($ch);

    if ($err !== '') {
        $results[] = [
            'event_id' => $row['event_id'] ?? '',
            'status' => 'failed',
            'http_code' => $httpCode,
            'error' => $err,
        ];
        continue;
    }

    if ($httpCode >= 200 && $httpCode < 300) {
        $okCount++;
        $results[] = [
            'event_id' => $row['event_id'] ?? '',
            'status' => 'ok',
            'http_code' => $httpCode,
        ];
    } else {
        $results[] = [
            'event_id' => $row['event_id'] ?? '',
            'status' => 'failed',
            'http_code' => $httpCode,
            'response' => substr((string)$resp, 0, 300),
        ];
    }
}

echo json_encode([
    'success' => true,
    'replayed' => $okCount,
    'total' => count($rows),
    'results' => $results,
]);
