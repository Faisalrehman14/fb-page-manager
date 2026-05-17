<?php
/* ─────────────────────────────────────────────────────────
   update_quota.php — Called after a send batch completes.
   Increments messages_used in the DB (capped at limit).
   Returns updated quota info.
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

requireCsrfToken();

/* ── Rate limit: max 60 requests per minute per IP ─────── */
$_ip = $_SERVER['REMOTE_ADDR'] ?? 'unknown';
if (!rateLimitCheck('update_quota:' . $_ip, 60, 60)) {
    http_response_code(429);
    die(json_encode(['error' => 'Too many requests. Please wait a moment.']));
}

$raw   = get_raw_input();
$body  = json_decode($raw, true) ?: [];
$fbId  = trim($body['fb_user_id'] ?? '');
$count = (int)($body['count'] ?? 0);

const MAX_COUNT_PER_REQUEST = 50000;
if (!$fbId || $count <= 0) {
    http_response_code(400);
    die(json_encode(['error' => 'fb_user_id and count (>0) are required']));
}
if ($count > MAX_COUNT_PER_REQUEST) {
    http_response_code(400);
    die(json_encode(['error' => 'count exceeds maximum allowed per request']));
}

$db = getDB();

/* Atomic update — LEAST() prevents exceeding the limit */
$stmt = $db->prepare(
    "UPDATE users
     SET messages_used = LEAST(messages_limit, messages_used + ?)
     WHERE fb_user_id = ?"
);
$stmt->execute([$count, $fbId]);

/* Return updated quota */
$stmt = $db->prepare(
    "SELECT messages_used, messages_limit, plan FROM users WHERE fb_user_id = ?"
);
$stmt->execute([$fbId]);
$row = $stmt->fetch();

if (!$row) {
    http_response_code(404);
    die(json_encode(['error' => 'User not found']));
}

$remaining = max(0, (int)$row['messages_limit'] - (int)$row['messages_used']);

try {
    $db->prepare(
        "INSERT INTO activity_log (fb_user_id, action, detail) VALUES (?, 'send', ?)"
    )->execute([$fbId, "Sent: {$count} | Remaining: {$remaining}"]);
} catch (Exception $e) { /* non-critical */ }

echo json_encode([
    'success'            => true,
    'messagesUsed'       => (int)$row['messages_used'],
    'messageLimit'       => (int)$row['messages_limit'],
    'subscriptionStatus' => $row['plan'],
    'remaining'          => $remaining,
]);
