<?php
/**
 * config/validators.php
 * Input validation and sanitization helpers
 * Used across all API endpoints to ensure data integrity
 */

/**
 * Validate a Facebook User ID
 * @param mixed $id Facebook user ID (numeric)
 * @return bool|string Returns sanitized ID or false
 */
function validateFbId($id) {
    $id = trim((string)$id);
    if (!preg_match('/^\d{1,20}$/', $id)) return false;
    return $id;
}

/**
 * Validate email address
 * @param string $email Email to validate
 * @return bool|string Returns sanitized email or false
 */
function validateEmail($email) {
    $email = trim((string)$email);
    if (!filter_var($email, FILTER_VALIDATE_EMAIL)) return false;
    if (strlen($email) > 254) return false;
    return strtolower($email);
}

/**
 * Validate plan name
 * @param string $plan Plan identifier
 * @return bool|string Returns plan or false
 */
function validatePlan($plan) {
    $plan = trim((string)$plan);
    $valid_plans = ['free', 'basic', 'pro'];
    if (!in_array($plan, $valid_plans)) return false;
    return $plan;
}

/**
 * Validate IP address
 * @param string $ip IP address
 * @return bool|string Returns IP or false
 */
function validateIp($ip) {
    $ip = trim((string)$ip);
    if (!filter_var($ip, FILTER_VALIDATE_IP)) return false;
    return $ip;
}

/**
 * Validate Stripe session ID
 * @param string $sessionId Stripe session ID
 * @return bool|string Returns session ID or false
 */
function validateStripeSessionId($sessionId) {
    $sessionId = trim((string)$sessionId);
    if (!preg_match('/^[a-z0-9_\.]+$/i', $sessionId)) return false;
    if (strlen($sessionId) > 255) return false;
    return $sessionId;
}

/**
 * Validate token (user access token from Facebook)
 * @param string $token Token string
 * @return bool|string Returns token or false
 */
function validateToken($token) {
    $token = trim((string)$token);
    if (empty($token) || strlen($token) < 10 || strlen($token) > 1000) return false;
    // Tokens should only contain alphanumeric, dash, underscore
    if (!preg_match('/^[a-zA-Z0-9\-_|]+$/', $token)) return false;
    return $token;
}

/**
 * Validate message text
 * @param string $message Message to validate
 * @return bool|string Returns sanitized message or false
 */
function validateMessage($message) {
    $message = (string)$message;
    if (empty($message)) return false;
    if (strlen($message) > 4096) return false;
    // Check for excessive special characters (potential injection)
    $msg_len = strlen($message);
    $special = substr_count($message, '<') + substr_count($message, '>') +
               substr_count($message, '{') + substr_count($message, '}');
    if ($special > $msg_len * 0.1) return false;
    return $message;
}

/**
 * Validate delay in milliseconds
 * @param mixed $delay Delay value
 * @return bool|int Returns validated delay or false
 */
function validateDelay($delay) {
    $delay = (int)$delay;
    if ($delay < 500 || $delay > 60000) return false;
    return $delay;
}

/**
 * Sanitize for HTML output
 * @param string $text Text to sanitize
 * @return string Sanitized HTML
 */
function sanitizeHtml($text) {
    return htmlspecialchars((string)$text, ENT_QUOTES, 'UTF-8');
}

/**
 * Validate JSON structure
 * @param string $json JSON string
 * @param array $required Required keys
 * @return bool|array Returns parsed JSON or false
 */
function validateJson($json, $required = []) {
    $data = json_decode($json, true);
    if (!is_array($data)) return false;

    foreach ($required as $key) {
        if (!isset($data[$key]) || empty($data[$key])) {
            return false;
        }
    }

    return $data;
}

/**
 * Get and validate raw input
 * @param array $required Required keys
 * @return bool|array Returns validated input or false
 */
function getValidatedInput($required = []) {
    $raw = file_get_contents('php://input');
    return validateJson($raw, $required);
}

/**
 * Validate API request method
 * @param string|array $allowed Allowed HTTP methods
 * @return bool True if method is allowed
 */
function validateMethod($allowed = ['POST']) {
    $allowed = (array)$allowed;
    $method = strtoupper($_SERVER['REQUEST_METHOD'] ?? '');
    if (!in_array($method, $allowed)) {
        http_response_code(405);
        die(json_encode(['error' => 'Method not allowed']));
    }
    return true;
}
