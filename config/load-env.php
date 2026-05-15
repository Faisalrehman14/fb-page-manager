<?php
/**
 * config/load-env.php
 * Centralized environment variable loader for FBCast Pro
 *
 * Loads .env file for local development, validates critical variables,
 * and defines all configuration constants.
 */

function env_value($key, $default = '') {
    $value = getenv($key);
    if ($value === false && isset($_ENV[$key])) $value = $_ENV[$key];
    if ($value === false && isset($_SERVER[$key])) $value = $_SERVER[$key];
    return $value === false ? $default : trim($value);
}

function env_bool($key, $default = false) {
    $value = getenv($key);
    if ($value === false) {
        return (bool)$default;
    }
    $normalized = strtolower(trim((string)$value));
    if (in_array($normalized, ['1', 'true', 'yes', 'on'], true)) {
        return true;
    }
    if (in_array($normalized, ['0', 'false', 'no', 'off'], true)) {
        return false;
    }
    return (bool)$default;
}

function strip_inline_env_comment($value) {
    $length = strlen($value);
    $quote = null;

    for ($i = 0; $i < $length; $i++) {
        $char = $value[$i];

        if (($char === '"' || $char === "'") && ($i === 0 || $value[$i - 1] !== '\\')) {
            if ($quote === null) {
                $quote = $char;
            } elseif ($quote === $char) {
                $quote = null;
            }
        }

        if ($char === '#' && $quote === null) {
            return rtrim(substr($value, 0, $i));
        }
    }

    return trim($value);
}

function resolve_env_file_path() {
    $candidates = [];

    // Explicit override has highest priority.
    $customPath = getenv('FBCAST_ENV_PATH');
    if ($customPath !== false && trim($customPath) !== '') {
        $candidates[] = trim($customPath);
    }

    // 1) Default project root: /project/.env
    $candidates[] = __DIR__ . '/../.env';

    // 2) One level above project root: /parent/.env (common shared-host production pattern)
    $candidates[] = dirname(__DIR__, 2) . '/.env';

    // 3) One level above document root: /home/user/.env (another common production pattern)
    if (!empty($_SERVER['DOCUMENT_ROOT'])) {
        $candidates[] = rtrim($_SERVER['DOCUMENT_ROOT'], '/\\') . '/../.env';
    }

    foreach ($candidates as $path) {
        if (!$path) {
            continue;
        }
        $real = realpath($path);
        if ($real !== false && is_file($real) && is_readable($real)) {
            return $real;
        }
    }

    return null;
}

// ═════════════════════════════════════════════════════════════
// LOAD .ENV FILE (local development only)
// ═════════════════════════════════════════════════════════════
$envFilePath = resolve_env_file_path();
if ($envFilePath !== null) {
    if (!defined('FBCAST_ENV_FILE_PATH')) {
        define('FBCAST_ENV_FILE_PATH', $envFilePath);
    }

    $lines = file($envFilePath, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES);
    foreach ($lines as $line) {
        $trimmed = trim($line);
        if ($trimmed === '' || $trimmed[0] === '#') {
            continue;
        }

        if (strpos($line, '=') === false) {
            continue;
        }

        list($key, $value) = explode('=', $line, 2);
        $key = trim($key);
        if ($key === '' || getenv($key) !== false) {
            continue;
        }

        $value = strip_inline_env_comment(trim($value));
        if (
            (strlen($value) >= 2) &&
            (($value[0] === '"' && $value[strlen($value)-1] === '"') ||
             ($value[0] === "'" && $value[strlen($value)-1] === "'"))
        ) {
            $value = substr($value, 1, -1);
        }

        putenv($key . '=' . $value);
        $_ENV[$key] = $value;
        $_SERVER[$key] = $value;
    }
}

// ═════════════════════════════════════════════════════════════
// DATABASE CONFIGURATION
// Railway provides MYSQLHOST, MYSQLPORT, MYSQLDATABASE, MYSQLUSER, MYSQLPASSWORD
// OR standard DB_HOST, DB_NAME, DB_USER, DB_PASS
// ═════════════════════════════════════════════════════════════
define('DB_HOST', env_value('MYSQLHOST', env_value('MYSQL_HOST', env_value('DB_HOST', 'localhost'))));
define('DB_PORT', env_value('MYSQLPORT', env_value('MYSQL_PORT', env_value('DB_PORT', '3306'))));
define('DB_NAME', env_value('MYSQLDATABASE', env_value('MYSQL_DATABASE', env_value('DB_NAME', ''))));
define('DB_USER', env_value('MYSQLUSER', env_value('MYSQL_USER', env_value('DB_USER', ''))));
define('DB_PASS', env_value('MYSQLPASSWORD', env_value('MYSQL_PASSWORD', env_value('DB_PASS', ''))));

// ═════════════════════════════════════════════════════════════
// FACEBOOK APP CONFIGURATION
// ═════════════════════════════════════════════════════════════
define('FB_APP_ID',        env_value('FB_APP_ID', ''));
define('FB_APP_SECRET',    env_value('FB_APP_SECRET', ''));
define('FB_REDIRECT_URI',  env_value('FB_REDIRECT_URI', ''));
define('FB_API_VER',       'v21.0');

// ═════════════════════════════════════════════════════════════
// STRIPE PAYMENT CONFIGURATION
// ═════════════════════════════════════════════════════════════
define('STRIPE_SECRET_KEY',      env_value('STRIPE_SECRET_KEY', ''));
define('STRIPE_PUBLISHABLE_KEY', env_value('STRIPE_PUBLISHABLE_KEY', ''));
define('STRIPE_WEBHOOK_SECRET',  env_value('STRIPE_WEBHOOK_SECRET', ''));
define('STRIPE_PLANS', [
    'starter' => [
        'price_id'  => env_value('STRIPE_STARTER_PRICE_ID', ''),
        'amount'    => 500,   // $5.00
        'currency'  => 'usd',
        'interval'  => 'month',
        'limit'     => 30000,
        'name'      => 'Starter',
        'db_plan'   => 'basic'
    ],
    'basic' => [
        'price_id'  => env_value('STRIPE_BASIC_PRICE_ID', ''),
        'amount'    => 1500,  // $15.00
        'currency'  => 'usd',
        'interval'  => 'month',
        'limit'     => 300000,
        'name'      => 'Bronze',
        'db_plan'   => 'basic'
    ],
    'pro' => [
        'price_id'  => env_value('STRIPE_PRO_PRICE_ID', ''),
        'amount'    => 3000,  // $30.00
        'currency'  => 'usd',
        'interval'  => 'month',
        'limit'     => 650000,
        'name'      => 'Silver',
        'db_plan'   => 'pro'
    ],
    'gold' => [
        'price_id'  => env_value('STRIPE_GOLD_PRICE_ID', ''),
        'amount'    => 6000,  // $60.00
        'currency'  => 'usd',
        'interval'  => 'month',
        'limit'     => 1750000,
        'name'      => 'Gold',
        'db_plan'   => 'pro'
    ],
    'sapphire' => [
        'price_id'  => env_value('STRIPE_SAPPHIRE_PRICE_ID', ''),
        'amount'    => 10000, // $100.00
        'currency'  => 'usd',
        'interval'  => 'month',
        'limit'     => 4000000,
        'name'      => 'Sapphire',
        'db_plan'   => 'pro'
    ],
    'pro_unlimited' => [
        'price_id'  => env_value('STRIPE_PRO_UNLIMITED_PRICE_ID', ''),
        'amount'    => 15000, // $150.00
        'currency'  => 'usd',
        'interval'  => 'month',
        'limit'     => 7000000,
        'name'      => 'Platinum',
        'db_plan'   => 'pro'
    ]
]);

// ═════════════════════════════════════════════════════════════
// ADMIN SETTINGS
// ═════════════════════════════════════════════════════════════
define('ADMIN_PASSWORD_HASH', env_value('ADMIN_PASSWORD_HASH', ''));

// ═════════════════════════════════════════════════════════════
// SITE CONFIGURATION
// ═════════════════════════════════════════════════════════════
define('SITE_URL',      rtrim(env_value('SITE_URL', ''), '/'));
define('CONTACT_EMAIL', env_value('CONTACT_EMAIL', ''));

// ═════════════════════════════════════════════════════════════
// LOGGING & MONITORING
// ═════════════════════════════════════════════════════════════
define('APP_ENV',    env_value('APP_ENV', 'development'));
define('LOG_LEVEL',  env_value('LOG_LEVEL', 'info'));
define('SENTRY_DSN', env_value('SENTRY_DSN', ''));
define('SESSION_IP_CHECK', env_bool('SESSION_IP_CHECK', true));

// ═════════════════════════════════════════════════════════════
// SESSION & SECURITY
// ═════════════════════════════════════════════════════════════
if (session_status() === PHP_SESSION_NONE) {
    if (!headers_sent()) {
        $secure = (isset($_SERVER['HTTPS']) && $_SERVER['HTTPS'] === 'on') || (defined('SITE_URL') && strpos(SITE_URL, 'https://') === 0);
        // PHP 7.3+ supports session.cookie_samesite via ini_set or session_set_cookie_params options
        if (PHP_VERSION_ID >= 70300) {
            session_set_cookie_params([
                'lifetime' => 0,
                'path'     => '/',
                'domain'   => '',
                'secure'   => $secure,
                'httponly' => true,
                'samesite' => 'Lax'
            ]);
        } else {
            // Fallback for PHP < 7.3
            session_set_cookie_params(0, '/', '', $secure, true);
            ini_set('session.cookie_samesite', 'Lax');
        }
    }
    session_start();
}

// ═════════════════════════════════════════════════════════════
// INCLUDE CSRF & LOGGER
// ═════════════════════════════════════════════════════════════
require_once __DIR__ . '/logger.php';
require_once __DIR__ . '/csrf.php';

// ═════════════════════════════════════════════════════════════
// VALIDATION: Check for critical missing configuration
// ═════════════════════════════════════════════════════════════
$required_vars = [
    'FB_APP_ID'      => 'Facebook App ID',
    'FB_APP_SECRET'  => 'Facebook App Secret',
    'STRIPE_PUBLISHABLE_KEY' => 'Stripe Publishable Key',
    'STRIPE_SECRET_KEY' => 'Stripe Secret Key',
];

// Check for placeholders and empty values
// If FBCAST_PAGE_CONTEXT is defined, throw instead of die() so the page can catch it.
foreach ($required_vars as $const => $name) {
    $value = constant($const);

    if (empty($value) || strpos($value, 'YOUR') !== false || strpos($value, '_HERE') !== false) {
        if (php_sapi_name() === 'cli') continue;

        logger('critical', "Missing or placeholder value for environment variable: $const ($name). Check .env file.");

        if (defined('FBCAST_PAGE_CONTEXT')) {
            // Called from a page (index.php) — throw so it can be caught gracefully
            throw new RuntimeException("Config error: $const ($name) is not set. Check .env file.");
        }

        // API endpoint context — die with JSON
        if (!headers_sent()) {
            http_response_code(503);
            header('Content-Type: application/json');
        }
        $env = defined('APP_ENV') ? APP_ENV : 'development';
        if ($env === 'production') {
            die(json_encode(['error' => 'The service is temporarily unavailable due to a configuration issue. Please contact support.']));
        } else {
            die(json_encode([
                'error' => "Server configuration error: '$name' is not set correctly.",
                'debug' => "Constant '$const' is missing or has a placeholder value. Please check your .env file."
            ]));
        }
    }
}
