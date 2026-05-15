<?php
/**
 * config/logger.php
 * Simple logging system for FBCast Pro
 *
 * Logs all important events to /logs/app.log
 * Sends critical errors to Sentry (if configured)
 */

function logger($level, $message, $context = []) {
    // Log levels: debug, info, warn, error, critical
    $levels = ['debug' => 0, 'info' => 1, 'warn' => 2, 'warning' => 2, 'error' => 3, 'critical' => 4];
    $level = strtolower($level);
    if (!isset($levels[$level])) {
        $level = 'info';
    }
    if ($level === 'warning') {
        $level = 'warn';
    }

    // Respect the configured LOG_LEVEL from .env.
    // Don't log messages below the configured threshold.
    $config_level_name = defined('LOG_LEVEL') ? strtolower(LOG_LEVEL) : 'info';
    $config_level_val = $levels[$config_level_name] ?? $levels['info'];

    if ($levels[$level] < $config_level_val) {
        return false;
    }

    // Create logs directory if it doesn't exist
    $log_dir = __DIR__ . '/../logs';
    if (!is_dir($log_dir)) {
        @mkdir($log_dir, 0755, true);
    }

    // Format log entry
    $timestamp = date('Y-m-d H:i:s');
    $context_str = !empty($context) ? json_encode($context) : '';
    $log_line = "[$timestamp] [" . strtoupper($level) . "] $message";
    if ($context_str) $log_line .= " $context_str";
    $log_line .= "\n";

    // Write to app.log
    $log_file = "$log_dir/app.log";
    @file_put_contents($log_file, $log_line, FILE_APPEND | LOCK_EX);

    // If an external monitoring service DSN is configured (e.g., Sentry),
    // also send ERROR and CRITICAL logs to stderr for capture.
    if ($level === 'error' || $level === 'critical') {
        $sentry_dsn = defined('SENTRY_DSN') ? SENTRY_DSN : getenv('SENTRY_DSN');
        if ($sentry_dsn) {
            // A proper Sentry SDK would be used here. For now, this just logs to stderr.
            @error_log("CRITICAL: $message - $context_str", 3, 'php://stderr');
        }
    }

    return true;
}

// ═════════════════════════════════════════════════════════════
// Shorthand logging functions
// ═════════════════════════════════════════════════════════════
function log_info($msg, $ctx = []) { return logger('info', $msg, $ctx); }
function log_warn($msg, $ctx = []) { return logger('warn', $msg, $ctx); }
function log_error($msg, $ctx = []) { return logger('error', $msg, $ctx); }
function log_debug($msg, $ctx = []) { return logger('debug', $msg, $ctx); }
