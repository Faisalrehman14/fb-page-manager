<?php
/*
 * get_csrf.php — Returns a CSRF token for the current session.
 * Called by the frontend on page load; token is included in
 * POST requests to create_checkout.php.
 */

header('Content-Type: application/json');
header('Cache-Control: no-cache, no-store, must-revalidate');
header('X-Content-Type-Options: nosniff');
header('X-Frame-Options: DENY');
header('Referrer-Policy: strict-origin-when-cross-origin');

if (($_SERVER['REQUEST_METHOD'] ?? 'GET') !== 'GET') {
    http_response_code(405);
    header('Allow: GET');
    die(json_encode(['error' => 'Method not allowed']));
}

// Signal to load-env.php to throw exceptions
define('FBCAST_PAGE_CONTEXT', true);

// Enable error reporting for logging only
error_reporting(E_ALL);
ini_set('display_errors', 0);
ini_set('log_errors', 1);

try {
    require_once __DIR__ . '/config/load-env.php';
    echo json_encode(['token' => getCsrfToken()]);
} catch (Throwable $e) {
    http_response_code(500);
    logger('error', 'CSRF token generation failed: ' . $e->getMessage());
    $env = defined('APP_ENV') ? APP_ENV : 'development';
    $debugMsg = ($env !== 'production') ? $e->getMessage() : null;
    $response = ['error' => 'Failed to generate security token'];
    if ($debugMsg) $response['debug'] = $debugMsg;
    die(json_encode($response));
}
