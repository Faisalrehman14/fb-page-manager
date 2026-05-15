<?php
/**
 * Adds durable webhook and payment history tables for Stripe processing.
 */

if (!isset($db) || !($db instanceof PDO)) {
    throw new Exception('Database connection not available for migration 20260424_001_webhook_reliability');
}

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

$db->exec("CREATE TABLE IF NOT EXISTS payment_history (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    fb_user_id VARCHAR(50) NOT NULL,
    stripe_invoice_id VARCHAR(255) NOT NULL DEFAULT '',
    plan ENUM('free','basic','pro','unknown') NOT NULL DEFAULT 'unknown',
    amount_cents INT UNSIGNED NOT NULL DEFAULT 0,
    status ENUM('succeeded','failed','pending') NOT NULL DEFAULT 'pending',
    billing_reason VARCHAR(80) NOT NULL DEFAULT '',
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_payment_user (fb_user_id),
    INDEX idx_payment_invoice (stripe_invoice_id),
    INDEX idx_payment_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci");
