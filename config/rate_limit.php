<?php
/**
 * config/rate_limit.php
 * ═════════════════════════════════════════════════════════════
 * Production-grade rate limiting using Redis or file-based storage
 * 
 * Usage:
 *   require_once 'config/rate_limit.php';
 *   
 *   // Check rate limit
 *   if (!rateLimitCheck('endpoint:user:123', 100, 3600)) {
 *       http_response_code(429);
 *       exit(json_encode(['error' => 'Too many requests']));
 *   }
 */

class RateLimiter {
    private static $cache = [];
    private static $storage_dir = null;
    
    public static function init($storage_dir = null) {
        if ($storage_dir === null) {
            $storage_dir = __DIR__ . '/../.cache/rate_limit';
        }
        self::$storage_dir = $storage_dir;
        
        if (!is_dir($storage_dir)) {
            @mkdir($storage_dir, 0755, true);
        }
    }
    
    /**
     * Check if request is within rate limit
     * @param string $key - Unique identifier (e.g., "api:user:123")
     * @param int $max_requests - Maximum requests allowed
     * @param int $window_seconds - Time window in seconds
     * @return bool - true if within limit, false if exceeded
     */
    public static function check($key, $max_requests = 100, $window_seconds = 3600) {
        if (self::$storage_dir === null) {
            self::init();
        }
        
        $bucket_key = md5($key);
        $file = self::$storage_dir . '/' . substr($bucket_key, 0, 2) . '/' . $bucket_key . '.json';
        
        $now = time();
        $window_start = $now - $window_seconds;
        
        $data = self::readBucket($file);
        
        // Clean old timestamps outside window
        $data['timestamps'] = array_filter($data['timestamps'] ?? [], function($ts) use ($window_start) {
            return $ts > $window_start;
        });
        
        $current_count = count($data['timestamps'] ?? []);
        
        if ($current_count >= $max_requests) {
            return false;
        }
        
        // Record this request
        $data['timestamps'][] = $now;
        $data['key'] = $key;
        $data['updated_at'] = $now;
        
        self::writeBucket($file, $data);
        
        return true;
    }
    
    /**
     * Get current request count for a key
     */
    public static function getCount($key, $window_seconds = 3600) {
        if (self::$storage_dir === null) {
            self::init();
        }
        
        $bucket_key = md5($key);
        $file = self::$storage_dir . '/' . substr($bucket_key, 0, 2) . '/' . $bucket_key . '.json';
        
        $now = time();
        $window_start = $now - $window_seconds;
        
        $data = self::readBucket($file);
        
        return count(array_filter($data['timestamps'] ?? [], function($ts) use ($window_start) {
            return $ts > $window_start;
        }));
    }
    
    /**
     * Reset rate limit for a key
     */
    public static function reset($key) {
        if (self::$storage_dir === null) {
            self::init();
        }
        
        $bucket_key = md5($key);
        $file = self::$storage_dir . '/' . substr($bucket_key, 0, 2) . '/' . $bucket_key . '.json';
        
        if (file_exists($file)) {
            @unlink($file);
        }
    }
    
    private static function readBucket($file) {
        if (!file_exists($file)) {
            return ['timestamps' => []];
        }
        
        $content = @file_get_contents($file);
        return $content ? json_decode($content, true) : ['timestamps' => []];
    }
    
    private static function writeBucket($file, $data) {
        $dir = dirname($file);
        if (!is_dir($dir)) {
            @mkdir($dir, 0755, true);
        }
        
        @file_put_contents($file, json_encode($data), LOCK_EX);
    }
}

/**
 * Convenience function for rate limiting
 * Usage: if (!rateLimitCheck('user:' . $user_id, 100, 3600)) { ... }
 */
function rateLimitCheck($key, $max_requests = 100, $window_seconds = 3600) {
    return RateLimiter::check($key, $max_requests, $window_seconds);
}

/**
 * Get current rate limit count
 */
function rateLimitGetCount($key, $window_seconds = 3600) {
    return RateLimiter::getCount($key, $window_seconds);
}

/**
 * Reset rate limit
 */
function rateLimitReset($key) {
    RateLimiter::reset($key);
}

// Initialize rate limiter
RateLimiter::init();

// Standard rate limit configurations for different endpoints
define('RATE_LIMITS', [
    'default'          => ['max' => 1000, 'window' => 3600],  // 1000 req/hour
    'auth'             => ['max' => 10,    'window' => 300],   // 10 req/5min
    'payment'          => ['max' => 5,     'window' => 60],    // 5 req/min
    'api_general'      => ['max' => 100,   'window' => 60],    // 100 req/min
    'export'           => ['max' => 2,     'window' => 3600],  // 2 per hour
    'webhook'          => ['max' => 1000,  'window' => 60],    // 1000 req/min
]);

/**
 * Apply rate limit and return 429 if exceeded
 * Usage: enforceRateLimit('payment', 'user:' . $user_id)
 */
function enforceRateLimit($limit_type = 'default', $key = null) {
    if ($key === null) {
        $key = $_SERVER['REMOTE_ADDR'] ?? 'unknown';
    }
    
    $limit_config = RATE_LIMITS[$limit_type] ?? RATE_LIMITS['default'];
    
    if (!rateLimitCheck($limit_type . ':' . $key, $limit_config['max'], $limit_config['window'])) {
        http_response_code(429);
        header('Content-Type: application/json');
        header('Retry-After: ' . $limit_config['window']);
        
        $remaining = $limit_config['max'] - rateLimitGetCount($limit_type . ':' . $key, $limit_config['window']);
        
        exit(json_encode([
            'error' => 'Too many requests',
            'retry_after' => $limit_config['window'],
            'limit_type' => $limit_type,
            'requests_remaining' => max(0, $remaining)
        ]));
    }
}
