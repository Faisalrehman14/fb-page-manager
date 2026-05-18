<?php
/**
 * health_check.php
 * ═════════════════════════════════════════════════════════════
 * Production health monitoring endpoint
 * 
 * Returns 200 OK with JSON status if all systems operational
 * Returns 5xx with JSON error if any critical component fails
 * 
 * Usage in monitoring:
 *   curl -s https://yourdomain.com/health_check.php | jq .
 *   
 * Monitoring services (UptimeRobot, Pingdom, etc.):
 *   Monitor: https://yourdomain.com/health_check.php
 *   Success criteria: HTTP 200
 *   Interval: 5 minutes
 */

header('Content-Type: application/json');
header('X-Content-Type-Options: nosniff');
header('Cache-Control: no-cache, no-store, must-revalidate, max-age=0');

// Disable output buffering to ensure immediate response
while (ob_get_level() > 0) {
    ob_end_clean();
}

$status = 'ok';
$code = 200;
$components = [];
$timestamp = date('c');
$version = '1.0.0';

// ─────────────────────────────────────────────────────────────
// 1. CHECK DATABASE CONNECTION
// ─────────────────────────────────────────────────────────────
try {
    require_once 'config/load-env.php';
    require_once 'db_config.php';
    
    $db = getDB();
    $result = $db->query("SELECT 1");
    
    if ($result !== false) {
        $showDetails = (defined('APP_ENV') && APP_ENV !== 'production');
        $components['database'] = [
            'status' => 'ok',
            'connected' => true,
            'host' => $showDetails ? DB_HOST : 'hidden',
            'database' => $showDetails ? DB_NAME : 'hidden'
        ];
    } else {
        throw new Exception('Query execution failed');
    }
} catch (Throwable $e) {
    $status = 'degraded';
    $code = 503;
    $components['database'] = [
        'status' => 'error',
        'message' => 'Database connection failed',
        'host' => DB_HOST ?? 'unknown'
    ];
}

// ─────────────────────────────────────────────────────────────
// 2. CHECK FILE SYSTEM (Logs & Uploads)
// ─────────────────────────────────────────────────────────────
$fs_ok = true;
$fs_issues = [];

$required_dirs = [
    'logs' => 'Logging directory',
    'config' => 'Configuration directory',
    'assets' => 'Assets directory'
];

foreach ($required_dirs as $dir => $desc) {
    $path = __DIR__ . '/' . $dir;
    if (!is_dir($path)) {
        $fs_ok = false;
        $fs_issues[] = "$desc missing: $path";
    } elseif (!is_writable($path) && $dir === 'logs') {
        $fs_ok = false;
        $fs_issues[] = "Logs directory not writable: $path";
    }
}

$components['filesystem'] = [
    'status' => $fs_ok ? 'ok' : 'warning',
    'writable_logs' => is_writable(__DIR__ . '/logs'),
    'issues' => $fs_issues
];

if (!$fs_ok) {
    $status = 'degraded';
    $code = ($code === 503) ? 503 : 503;
}

// ─────────────────────────────────────────────────────────────
// 3. CHECK CRITICAL CONFIGURATION
// ─────────────────────────────────────────────────────────────
$config_ok = true;
$config_warnings = [];

$required_constants = [
    'FB_APP_ID' => 'Facebook App ID',
    'FB_APP_SECRET' => 'Facebook App Secret',
    'STRIPE_SECRET_KEY' => 'Stripe Secret Key',
    'SITE_URL' => 'Site URL'
];

foreach ($required_constants as $const => $desc) {
    if (!defined($const) || empty(constant($const))) {
        $config_ok = false;
        $config_warnings[] = "$desc not configured";
    }
}

// Check if HTTPS is enforced in production
$is_https = (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off');
$is_production = (defined('APP_ENV') && APP_ENV === 'production');

if ($is_production && !$is_https) {
    $config_ok = false;
    $config_warnings[] = "HTTPS not enabled in production";
}

$components['configuration'] = [
    'status' => $config_ok ? 'ok' : 'warning',
    'https_enabled' => $is_https,
    'environment' => defined('APP_ENV') ? APP_ENV : 'unknown',
    'warnings' => $config_warnings
];

if (!$config_ok) {
    $status = 'degraded';
}

// ─────────────────────────────────────────────────────────────
// 4. CHECK RESPONSE TIME (measure latency)
// ─────────────────────────────────────────────────────────────
$start_time = microtime(true);
// Simulate a small DB query
try {
    if (isset($db)) {
        $db->query("SELECT 1");
    }
} catch (Throwable $e) {}
$response_time_ms = round((microtime(true) - $start_time) * 1000, 2);

$components['performance'] = [
    'status' => $response_time_ms < 100 ? 'ok' : ($response_time_ms < 500 ? 'warning' : 'slow'),
    'response_time_ms' => $response_time_ms,
    'php_version' => PHP_VERSION,
    'memory_usage_mb' => round(memory_get_usage(true) / 1024 / 1024, 2),
    'peak_memory_mb' => round(memory_get_peak_usage(true) / 1024 / 1024, 2)
];

// ─────────────────────────────────────────────────────────────
// 5. BUILD RESPONSE
// ─────────────────────────────────────────────────────────────
$response = [
    'status' => $status,
    'version' => $version,
    'timestamp' => $timestamp,
    'uptime' => [
        'checked_at' => $timestamp,
        'server' => gethostname()
    ],
    'components' => $components
];

// Only include detailed info if not in production or if explicitly requested
$detailedRequested = isset($_GET['detailed']) && $_GET['detailed'] === '1';
if ((defined('APP_ENV') && APP_ENV !== 'production') || $detailedRequested) {
    $response['system'] = [
        'os' => php_uname(),
        'php_version' => PHP_VERSION,
        'server' => $_SERVER['SERVER_SOFTWARE'] ?? 'Unknown'
    ];
}

http_response_code($code);
echo json_encode($response, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES);

// ─────────────────────────────────────────────────────────────
// 6. LOG HEALTH CHECK (optional, for monitoring)
// ─────────────────────────────────────────────────────────────
if (function_exists('logger') && $code !== 200) {
    try {
        logger('warn', "Health check failed with status: $status", ['code' => $code, 'components' => $components]);
    } catch (Throwable $e) {
        // Silent fail - don't let logging errors break health check
    }
}
