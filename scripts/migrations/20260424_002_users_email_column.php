<?php
/**
 * Add checkout/subscription email storage for admin reporting.
 */

$hasEmailColumn = false;
try {
    $cols = $db->query("SHOW COLUMNS FROM users")->fetchAll(PDO::FETCH_ASSOC);
    foreach ($cols as $col) {
        if (($col['Field'] ?? '') === 'email') {
            $hasEmailColumn = true;
            break;
        }
    }
} catch (Throwable $e) {
    throw new Exception('Failed to inspect users table: ' . $e->getMessage());
}

if (!$hasEmailColumn) {
    $db->exec("ALTER TABLE users ADD COLUMN email VARCHAR(255) NULL DEFAULT NULL AFTER fb_name");
    $db->exec("ALTER TABLE users ADD INDEX idx_email (email)");
}
