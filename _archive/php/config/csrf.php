<?php
/**
 * config/csrf.php
 * CSRF (Cross-Site Request Forgery) protection utilities
 *
 * Provides functions to generate, store, and validate CSRF tokens
 */

/**
 * Helper to read php://input only once and cache it.
 * @return string The raw POST body.
 */
function get_raw_input() {
    static $raw_input = null;
    if ($raw_input === null) {
        $raw_input = file_get_contents('php://input');
    }
    return $raw_input;
}

/**
 * Get or generate a CSRF token for the current session
 * @return string CSRF token
 */
function getCsrfToken() {
    if (empty($_SESSION['csrf_token'])) {
        if (function_exists('random_bytes')) {
            $_SESSION['csrf_token'] = bin2hex(random_bytes(32));
        } else {
            $_SESSION['csrf_token'] = bin2hex(openssl_random_pseudo_bytes(32));
        }
    }

    return $_SESSION['csrf_token'];
}

/**
 * Verify CSRF token from request
 * Checks: POST parameter, REQUEST header, or JSON body
 *
 * @return bool True if token is valid, false otherwise
 */
function verifyCsrfToken() {
    $stored_token = $_SESSION['csrf_token'] ?? '';
    if (empty($stored_token)) {
        logger('warn', 'CSRF token missing from session');
        return false;
    }

    // Try to get token from different sources
    $provided_token = null;

    // 1. Check POST parameter
    if (isset($_POST['csrf_token'])) {
        $provided_token = $_POST['csrf_token'];
    }
    // 2. Check header (X-CSRF-Token or X-XSRF-TOKEN)
    elseif (isset($_SERVER['HTTP_X_CSRF_TOKEN'])) {
        $provided_token = $_SERVER['HTTP_X_CSRF_TOKEN'];
    }
    elseif (isset($_SERVER['HTTP_X_XSRF_TOKEN'])) {
        $provided_token = $_SERVER['HTTP_X_XSRF_TOKEN'];
    }
    // 3. Check JSON body
    else {
        $json_body = json_decode(get_raw_input(), true);
        if (isset($json_body['csrf_token'])) {
            $provided_token = $json_body['csrf_token'];
        }
    }

    if (!$provided_token) {
        logger('warn', 'CSRF token not found in request', ['ip' => $_SERVER['REMOTE_ADDR']]);
        return false;
    }

    // Use timing-safe comparison
    if (!hash_equals($stored_token, $provided_token)) {
        logger('warn', 'CSRF token validation failed', [
            'ip' => $_SERVER['REMOTE_ADDR'],
            'endpoint' => $_SERVER['REQUEST_URI']
        ]);
        return false;
    }

    return true;
}

/**
 * Require CSRF validation for POST request
 * Dies with 403 if validation fails
 *
 * @return void
 */
function requireCsrfToken() {
    if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
        return; // Only check POST requests
    }

    if (!verifyCsrfToken()) {
        http_response_code(403);
        header('Content-Type: application/json');
        logger('error', 'CSRF validation failed - request blocked', [
            'ip' => $_SERVER['REMOTE_ADDR'],
            'endpoint' => $_SERVER['REQUEST_URI']
        ]);
        die(json_encode(['error' => 'CSRF token invalid or missing']));
    }
}
