<?php
/* ─────────────────────────────────────────────────────────
   db_config.php — Database connection for FBCast Pro
   Configuration is loaded from environment variables via
   config/load-env.php. Set them in .env file.
   ───────────────────────────────────────────────────────── */

function getDB() {
    static $pdo = null;
    if ($pdo !== null) return $pdo;

    // First, check if the PDO extension is even available. This is a common server configuration issue.
    if (!class_exists('PDO')) {
        // The logger may not be loaded if this file is included before load-env.php, so use error_log as a fallback.
        $msg = 'CRITICAL: PDO class not found. The pdo_mysql PHP extension is likely not enabled on the server.';
        if (function_exists('logger')) { logger('critical', $msg); } else { @error_log($msg); }

        if (php_sapi_name() !== 'cli' && !headers_sent()) {
            http_response_code(503); // Service Unavailable
            header('Content-Type: application/json');
            die(json_encode(['error' => 'Server is missing a required component (PDO). Please contact support.']));
        }
        die($msg);
    }

    try {
        $port = defined('DB_PORT') ? (int)DB_PORT : 3306;
        $pdo = new PDO(
            "mysql:host=" . DB_HOST . ";port=" . $port . ";dbname=" . DB_NAME . ";charset=utf8mb4",
            DB_USER, DB_PASS,
            [
                PDO::ATTR_ERRMODE            => PDO::ERRMODE_EXCEPTION,
                PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
                PDO::ATTR_EMULATE_PREPARES   => false,
            ]
        );
    } catch (PDOException $e) {
        // Log the detailed, actual error to the server log for debugging.
        if (function_exists('logger')) {
            logger('critical', 'Database connection failed', ['error' => $e->getMessage(), 'code' => $e->getCode()]);
        } else {
            @error_log('CRITICAL: Database connection failed: ' . $e->getMessage());
        }

        // Prepare a safe error response for the client.
        $env = defined('APP_ENV') ? APP_ENV : 'development';
        $error_message = 'The database service is currently unavailable. Please try again later.';
        $debug_info = null;

        if ($env !== 'production') {
            $error_message = 'Database Connection Failed.';
            $debug_info = "Error: " . $e->getMessage() . " (Code: " . $e->getCode() . "). Please check your .env file (DB_HOST, DB_NAME, DB_USER, DB_PASS) and ensure the database server is running and accessible.";
        }

        if (php_sapi_name() !== 'cli' && !headers_sent()) {
            http_response_code(503); // 503 Service Unavailable is more appropriate for a backend dependency failure.
            header('Content-Type: application/json');
            $response = ['error' => $error_message];
            if ($debug_info) {
                $response['debug'] = $debug_info;
            }
            die(json_encode($response));
        }
        die('CRITICAL: Database connection failed.');
    }
    return $pdo;
}
